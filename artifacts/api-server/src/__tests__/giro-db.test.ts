/**
 * Il salvataggio di fine giro di Argos (salvaGiro) su un database vero
 * (TEST_DATABASE_URL, migrato: in CI il job migrazioni-postgres): tutto in una
 * transazione, la guardia sulla riga della coda, l'idempotenza su «done», i
 * turni guida in un savepoint.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { salvaGiro, type RichiestaGiro } from "../lib/ottimizza-veicoli/giro";

const UTENTE = "e0000000-0000-0000-0000-00000000aa01";
const PS = "e0000000-0000-0000-0000-00000000aac1";
const SCHED = "e0000000-0000-0000-0000-00000000aa5c";
const LAVORO = "e0000000-0000-0000-0000-00000000aa10";
const DEPOSITO = "e0000000-0000-0000-0000-00000000aad1";
const log = { info() {}, warn() {}, error() {} };

const payload = (extra: Record<string, unknown> = {}) => ({
  solver: "vcsp", shifts: [{ vehicleId: "V1" }], summary: { totalVehicles: 1, totalTrips: 3 },
  solverMetrics: { costEur: 100 }, advisories: [],
  vcsp: {
    bestRound: 2, ciclo: { passo: 0.4, ancora: "best", seme: false, pazienza: 3, controllo: true },
    crew: { driverShifts: [{ driverId: "AG1", type: "intero" }], summary: { totalShifts: 1 } },
  },
  ...extra,
});

const richiesta = (extra: Partial<RichiestaGiro["salvataggio"]> = {}, params: Record<string, unknown> = { date: "2026-11-04", mode: "vcsp" }): RichiestaGiro => ({
  mode: "vcsp", feedId: "e0000000-0000-0000-0000-00000000aaf1",
  corpo: { crewConfig: { companyCars: 2 }, vcsp: { rounds: 2 }, vehicleCosts: { "12m": 1 } },
  params,
  salvataggio: {
    utenteId: UTENTE, psProjectId: PS, psName: "Rete", rawDate: "2026-11-04", feedId: "e0000000-0000-0000-0000-00000000aaf1",
    serviceType: "urbano", routes: [{ routeId: "R1", vehicleType: "12m" }],
    depotsSel: [{ id: DEPOSITO, maxVehicles: 3 }, { id: "non-un-uuid" }], schedProjectId: SCHED,
    defaultVehicleType: null, saveScenario: true, scenarioName: null, creatoIl: Date.parse("2026-11-03T08:00:00Z"),
    ...extra,
  },
});

const inCorso = (chi = "w1", annulla = false) => db.execute(sql`
  INSERT INTO coda.lavori (id, tipo, corsia, stato, richiesta, timeout_sec, preso_da, annulla, chiave_unicita)
  VALUES (${LAVORO}::uuid, 'giro_agente', 'lunga', 'in_corso', '{}', 7200, ${chi}, ${annulla}, ${`giro:${PS}`})`);

const conta = async () => {
  const sc = (await db.execute<any>(sql`SELECT count(*)::int AS n FROM service_program_scenarios WHERE feed_id = 'e0000000-0000-0000-0000-00000000aaf1'::uuid`)).rows[0].n;
  const dss = (await db.execute<any>(sql`SELECT count(*)::int AS n FROM driver_shift_scenarios d JOIN service_program_scenarios s ON s.id = d.service_program_scenario_id
                                          WHERE s.feed_id = 'e0000000-0000-0000-0000-00000000aaf1'::uuid`)).rows[0].n;
  const giro = (await db.execute<any>(sql`SELECT status FROM agent_optimize_jobs WHERE id = ${LAVORO}::uuid`)).rows[0]?.status ?? null;
  return { sc, dss, giro };
};

describe.runIf(!!process.env.TEST_DATABASE_URL)("il salvataggio di fine giro, sul database", () => {
  const pulisci = async () => {
    await db.execute(sql`ALTER TABLE driver_shift_scenarios DROP CONSTRAINT IF EXISTS prova_rottura`);
    await db.execute(sql`DELETE FROM service_program_scenarios WHERE feed_id = 'e0000000-0000-0000-0000-00000000aaf1'::uuid`);
    await db.execute(sql`DELETE FROM agent_optimize_jobs WHERE id = ${LAVORO}::uuid`);
    await db.execute(sql`DELETE FROM coda.lavori WHERE id = ${LAVORO}::uuid`);
    await db.execute(sql`DELETE FROM users WHERE id = ${UTENTE}::uuid`);
  };
  beforeEach(async () => {
    await pulisci();
    await db.execute(sql`INSERT INTO users (id, email, password_hash) VALUES (${UTENTE}::uuid, 'giro@prova.local', 'x')`);
  });
  afterAll(pulisci);

  it("con la coda: scenario, turni guida e giro «done» insieme; poi idempotente", async () => {
    await inCorso();
    const e = await salvaGiro({ lavoroId: LAVORO, chi: "w1", payload: payload(), r: richiesta(), log });
    expect(e).toMatchObject({ stato: "salvato", giaSalvato: false, scenarioName: "Argos · Rete · 2026-11-04 · VCSP" });
    if (e.stato !== "salvato") throw new Error("non salvato");
    // i parametri prendono il ciclo vero del motore
    expect(e.params).toMatchObject({ penaltyStep: 0.4, penaltyAnchor: "best", seedFromBest: false, earlyStopPatience: 3, controllo: true });

    const sc = (await db.execute<any>(sql`
      SELECT name, date, owner_user_id, project_id, depots, config, input, result->>'vcspSelectedRound' AS round
        FROM service_program_scenarios WHERE id = ${e.scenarioId}::uuid`)).rows[0];
    expect(sc).toMatchObject({
      name: "Argos · Rete · 2026-11-04 · VCSP", date: "20261104", owner_user_id: UTENTE, project_id: SCHED,
      depots: [{ id: DEPOSITO, maxVehicles: 3 }], round: "2",
      input: { date: "2026-11-04", serviceType: "urbano", source: "argos-agent", mode: "vcsp", vcsp: { rounds: 2 } },
    });
    expect(sc.config).toMatchObject({ source: "argos-agent", companyCars: 2, vehicleCosts: { "12m": 1 }, crewConfig: { companyCars: 2 } });
    const dss = (await db.execute<any>(sql`SELECT name, owner_user_id, service_program_scenario_id FROM driver_shift_scenarios WHERE id = ${e.dssId}::uuid`)).rows[0];
    expect(dss).toEqual({ name: "Argos · Rete · 2026-11-04 · VCSP · Turni guida (VCSP round 2)", owner_user_id: UTENTE, service_program_scenario_id: e.scenarioId });
    const giro = (await db.execute<any>(sql`
      SELECT status, scenario_id, dss_id, progress, result_compact->'summary'->>'totalVehicles' AS veicoli, created_at
        FROM agent_optimize_jobs WHERE id = ${LAVORO}::uuid`)).rows[0];
    expect(giro).toMatchObject({ status: "done", scenario_id: e.scenarioId, dss_id: e.dssId, veicoli: "1",
                                 progress: { phase: "VCSP", pct: 100, msg: "Completato" } });
    expect(new Date(giro.created_at).toISOString()).toBe("2026-11-03T08:00:00.000Z");

    // il lavoro ripreso dopo un crash fra salvataggio e chiusura: niente scenario doppio
    const ancora = await salvaGiro({ lavoroId: LAVORO, chi: "w1", payload: payload(), r: richiesta(), log });
    expect(ancora).toMatchObject({ stato: "salvato", giaSalvato: true, scenarioId: e.scenarioId, dssId: e.dssId });
    expect(await conta()).toEqual({ sc: 1, dss: 1, giro: "done" });
  });

  it("la guardia: lease perso o stop chiesto → non si scrive niente", async () => {
    await inCorso("w2");
    expect(await salvaGiro({ lavoroId: LAVORO, chi: "w1", payload: payload(), r: richiesta(), log }))
      .toEqual({ stato: "non-nostro", perche: "lease" });
    await db.execute(sql`UPDATE coda.lavori SET preso_da = 'w1', annulla = true WHERE id = ${LAVORO}::uuid`);
    expect(await salvaGiro({ lavoroId: LAVORO, chi: "w1", payload: payload(), r: richiesta(), log }))
      .toEqual({ stato: "non-nostro", perche: "annullato" });
    await db.execute(sql`UPDATE coda.lavori SET annulla = false, stato = 'completato' WHERE id = ${LAVORO}::uuid`);
    expect(await salvaGiro({ lavoroId: LAVORO, chi: "w1", payload: payload(), r: richiesta(), log }))
      .toEqual({ stato: "non-nostro", perche: "lease" });
    expect(await conta()).toEqual({ sc: 0, dss: 0, giro: null });
  });

  it("tutto o niente: se l'ultima scrittura fallisce non resta né lo scenario né i turni guida", async () => {
    await inCorso();
    // un NUL nei parametri: jsonb lo rifiuta solo all'ultima scrittura (agent_optimize_jobs)
    await expect(salvaGiro({ lavoroId: LAVORO, chi: "w1", payload: payload(), r: richiesta({}, { nota: "\u0000" }), log }))
      .rejects.toThrow();
    expect(await conta()).toEqual({ sc: 0, dss: 0, giro: null });
  });

  it("un errore dei turni guida non ferma il resto (savepoint); senza coda niente guardia", async () => {
    await db.execute(sql`ALTER TABLE driver_shift_scenarios ADD CONSTRAINT prova_rottura CHECK (name NOT LIKE '%ROTTURA%') NOT VALID`);
    const avvisi: string[] = [];
    const e = await salvaGiro({
      lavoroId: LAVORO, chi: null, payload: payload(),
      r: richiesta({ scenarioName: "Giro ROTTURA", utenteId: "e0000000-0000-0000-0000-00000000dead" }),
      log: { ...log, warn: (m: string) => avvisi.push(m) },
    });
    expect(e).toMatchObject({ stato: "salvato", dssId: null, scenarioName: "Giro ROTTURA" });
    expect(avvisi.join()).toContain("salvataggio turni guida fallito (non-fatale)");
    expect(await conta()).toEqual({ sc: 1, dss: 0, giro: "done" });
    // l'utente cancellato a giro in corso: lo scenario si salva senza proprietario
    const sc = (await db.execute<any>(sql`SELECT owner_user_id FROM service_program_scenarios WHERE id = ${(e as any).scenarioId}::uuid`)).rows[0];
    expect(sc.owner_user_id).toBeNull();
  });

  it("senza salvataggio dello scenario: il giro è «done» con l'esito compatto e basta", async () => {
    await inCorso();
    const e = await salvaGiro({ lavoroId: LAVORO, chi: "w1", payload: payload(), r: richiesta({ saveScenario: false }), log });
    expect(e).toMatchObject({ stato: "salvato", scenarioId: null, dssId: null, scenarioName: null });
    expect(await conta()).toEqual({ sc: 0, dss: 0, giro: "done" });
  });
});
