/**
 * Gli scenari di un'UDP, anteprima ed eliminazione in blocco su un database
 * vero (TEST_DATABASE_URL; in CI come cerbero_app).
 *
 * L'UDP «Festivo» ha un progetto di esercizio con tre turni macchina:
 *   TM1 vecchio, con due turni guida e una relazione di processo;
 *   TM2 vecchio, ma il suo turno guida è nelle giornate di esercizio;
 *   TM3 in esercizio (la soluzione ufficiale), con un turno guida.
 * Un'altra UDP ha il suo progetto e il suo TM9: non si tocca mai.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { anteprimaScenariUdp, eliminaScenariUdp, giroInCorso } from "../lib/udp-scenari-db";

const u = (n: number) => `c5e00000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const OWNER = u(1), P = u(2), UDP = u(3), UDP2 = u(4), SP = u(5), SP2 = u(6);
const TM1 = u(10), TM2 = u(20), TM3 = u(30), TM9 = u(90);
const TG11 = u(11), TG12 = u(12), TG21 = u(21), TG31 = u(31), TG91 = u(91);
const REL = u(50), GIRO = u(60);
const GIORNO = "1990-01-07";

const conta = async (tabella: "service_program_scenarios" | "driver_shift_scenarios", ids: string[]) => {
  const lista = `{${ids.join(",")}}`;
  const q = tabella === "service_program_scenarios"
    ? sql`SELECT count(*)::int AS n FROM service_program_scenarios WHERE id = ANY(${lista}::uuid[])`
    : sql`SELECT count(*)::int AS n FROM driver_shift_scenarios WHERE id = ANY(${lista}::uuid[])`;
  return Number((await db.execute<any>(q)).rows[0].n);
};
const proprietario = (p: { proprietario: string | null }[]) => p.every(x => x.proprietario === OWNER);

describe.runIf(!!process.env.TEST_DATABASE_URL)("gli scenari di un'UDP, sul database", () => {
  const pulisci = async () => {
    await db.execute(sql`DELETE FROM agent_optimize_jobs WHERE id = ${GIRO}::uuid`);
    await db.execute(sql`DELETE FROM esercizio_turni_macchina WHERE giorno = ${GIORNO}::date`);
    await db.execute(sql`DELETE FROM esercizio_giornate WHERE giorno = ${GIORNO}::date`);
    await db.execute(sql`DELETE FROM process_reports WHERE id = ${REL}::uuid`);
    await db.execute(sql`DELETE FROM service_program_scenarios WHERE project_id IN (${SP}::uuid, ${SP2}::uuid)`);
    await db.execute(sql`DELETE FROM project_activity_log WHERE project_id IN (${SP}::uuid, ${SP2}::uuid)`);
    await db.execute(sql`DELETE FROM scheduling_projects WHERE id IN (${SP}::uuid, ${SP2}::uuid)`);
    await db.execute(sql`DELETE FROM ps_validity_units WHERE project_id = ${P}::uuid`);
    await db.execute(sql`DELETE FROM ps_projects WHERE id = ${P}::uuid`);
    await db.execute(sql`DELETE FROM users WHERE id = ${OWNER}::uuid`);
  };

  beforeAll(async () => {
    await pulisci();
    await db.execute(sql`INSERT INTO users (id, email, password_hash, role) VALUES (${OWNER}::uuid, 'scenari-udp@prova.local', 'x', 'admin')`);
    await db.execute(sql`INSERT INTO ps_projects (id, owner_user_id, name) VALUES (${P}::uuid, ${OWNER}::uuid, 'Scenari di un''UDP')`);
    await db.execute(sql`INSERT INTO ps_validity_units (id, project_id, validity_id, name, trip_ids) VALUES
      (${UDP}::uuid, ${P}::uuid, 'v-festivo', 'Festivo', '[]'::jsonb),
      (${UDP2}::uuid, ${P}::uuid, 'v-feriale', 'Feriale', '[]'::jsonb)`);
    await db.execute(sql`INSERT INTO scheduling_projects (id, owner_user_id, name, planning_studio_project_id, validity_unit_id) VALUES
      (${SP}::uuid, ${OWNER}::uuid, 'Festivo', ${P}::uuid, ${UDP}::uuid),
      (${SP2}::uuid, ${OWNER}::uuid, 'Feriale', ${P}::uuid, ${UDP2}::uuid)`);
    for (const [id, sp, op] of [[TM1, SP, false], [TM2, SP, false], [TM3, SP, true], [TM9, SP2, false]] as const) {
      await db.execute(sql`INSERT INTO service_program_scenarios (id, name, date, input, result, project_id, owner_user_id, is_operational)
        VALUES (${id}::uuid, ${`giro ${id.slice(-2)}`}, '2026-09-20', '{}'::jsonb, '{"summary": {"totalVehicles": 20}}'::jsonb,
                ${sp}::uuid, ${OWNER}::uuid, ${op})`);
    }
    // TM9 (l'altra UDP) indica TM1 come sua versione nuova: eliminato TM1, non deve puntare a un id morto
    await db.execute(sql`UPDATE service_program_scenarios SET superseded_by = ${TM1}::uuid WHERE id = ${TM9}::uuid`);
    for (const [id, tm, sp] of [[TG11, TM1, SP], [TG12, TM1, SP], [TG21, TM2, SP], [TG31, TM3, SP], [TG91, TM9, SP2]] as const) {
      await db.execute(sql`INSERT INTO driver_shift_scenarios (id, service_program_scenario_id, name, result, project_id, owner_user_id)
        VALUES (${id}::uuid, ${tm}::uuid, ${`turni ${id.slice(-2)}`}, '{"driverShifts": [{}, {}]}'::jsonb, ${sp}::uuid, ${OWNER}::uuid)`);
    }
    await db.execute(sql`INSERT INTO process_reports (id, title, dossier, html, project_id, scenario_id, dss_id)
      VALUES (${REL}::uuid, 'relazione del giro', '{}'::jsonb, '<p></p>', ${SP}::uuid, ${TM1}::uuid, ${TG11}::uuid)`);
    await db.execute(sql`INSERT INTO esercizio_giornate (giorno) VALUES (${GIORNO}::date)`);
    await db.execute(sql`INSERT INTO esercizio_turni_macchina (giorno, vss_id, turno_macchina, dss_id)
      VALUES (${GIORNO}::date, ${TM2}::uuid, '1001', ${TG21}::uuid)`);
  });

  afterAll(pulisci);

  it("l'anteprima: tutti gli scenari dell'UDP, chi è bloccato, cosa si propone", async () => {
    const a = (await anteprimaScenariUdp(P, UDP))!;
    expect(a.udp).toMatchObject({ id: UDP, nome: "Festivo" });
    expect(a.turniMacchina.map(s => s.id).sort()).toEqual([TM1, TM2, TM3]);
    expect(a.turniGuida.map(s => s.id).sort()).toEqual([TG11, TG12, TG21, TG31]);
    expect(a.turniMacchina.find(s => s.id === TM1)).toMatchObject({ vetture: 20, turniGuida: 2, blocchi: [] });
    expect(a.turniMacchina.find(s => s.id === TM2)!.blocchi).toEqual(["giornate_esercizio"]);
    expect(a.turniMacchina.find(s => s.id === TM3)!.blocchi).toEqual(["in_esercizio"]);
    expect(a.turniGuida.find(s => s.id === TG11)).toMatchObject({ turni: 2, turniMacchinaId: TM1 });
    expect(a.eliminabili.turniMacchina).toEqual([TM1]);
    expect(a.eliminabili.turniGuida.sort()).toEqual([TG11, TG12, TG31]);
    expect(a.relazioni).toBe(1);
    expect(a.giroInCorso).toBeNull();
    // un'UDP di un altro progetto non si legge
    expect(await anteprimaScenariUdp(u(999), UDP)).toBeNull();
  });

  it("niente fuori dall'UDP, niente di bloccato, niente senza proprietario", async () => {
    expect(await eliminaScenariUdp(P, UDP, { turniMacchina: [TM1, TM9], turniGuida: [TG11, TG12] }, proprietario))
      .toMatchObject({ ok: false, stato: 400, ids: [TM9] });
    expect(await eliminaScenariUdp(P, UDP, { turniMacchina: [TM2], turniGuida: [TG21] }, proprietario))
      .toMatchObject({ ok: false, stato: 409, errore: expect.stringMatching(/giornate di esercizio/) });
    expect(await eliminaScenariUdp(P, UDP, { turniMacchina: [TM1], turniGuida: [TG11] }, proprietario))
      .toMatchObject({ ok: false, stato: 409, ids: [TG12] });
    expect(await eliminaScenariUdp(P, UDP, { turniMacchina: [TM1], turniGuida: [TG11, TG12] }, () => false))
      .toMatchObject({ ok: false, stato: 403 });
    expect(await conta("service_program_scenarios", [TM1, TM2, TM3, TM9])).toBe(4);
    expect(await conta("driver_shift_scenarios", [TG11, TG12, TG21, TG31, TG91])).toBe(5);
  });

  it("con un giro dello scheduler in corso sul progetto non si cancella", async () => {
    await db.execute(sql`INSERT INTO agent_optimize_jobs (id, ps_project_id, mode, status, created_at)
      VALUES (${GIRO}::uuid, ${P}::uuid, 'vcsp', 'running', now())`);
    expect(await giroInCorso(P)).toBe(GIRO);
    expect(await eliminaScenariUdp(P, UDP, { turniMacchina: [TM1], turniGuida: [TG11, TG12] }, proprietario))
      .toMatchObject({ ok: false, stato: 409, errore: expect.stringMatching(/giro dello scheduler/) });
    await db.execute(sql`UPDATE agent_optimize_jobs SET status = 'done', finished_at = now() WHERE id = ${GIRO}::uuid`);
    expect(await giroInCorso(P)).toBeNull();
  });

  it("si cancella quello che l'anteprima propone, e basta", async () => {
    const a = (await anteprimaScenariUdp(P, UDP))!;
    const r = await eliminaScenariUdp(P, UDP, a.eliminabili, proprietario);
    expect(r).toMatchObject({ ok: true, progetti: [SP] });
    if (!r.ok) return;
    expect(r.eliminati.turniMacchina).toEqual([TM1]);
    expect(r.eliminati.turniGuida.sort()).toEqual([TG11, TG12, TG31]);
    expect(r.eliminati.relazioni).toBe(1);
    expect(await conta("service_program_scenarios", [TM1])).toBe(0);
    expect(await conta("driver_shift_scenarios", [TG11, TG12, TG31])).toBe(0);
    // restano: il bloccato, quello in esercizio (senza il suo turno guida), l'altra UDP
    expect(await conta("service_program_scenarios", [TM2, TM3, TM9])).toBe(3);
    expect(await conta("driver_shift_scenarios", [TG21, TG91])).toBe(2);
    expect((await db.execute<any>(sql`SELECT superseded_by FROM service_program_scenarios WHERE id = ${TM9}::uuid`)).rows[0].superseded_by).toBeNull();
    expect((await db.execute<any>(sql`SELECT count(*)::int AS n FROM process_reports WHERE id = ${REL}::uuid`)).rows[0].n).toBe(0);
    // il progetto di esercizio resta, per il prossimo giro
    expect((await db.execute<any>(sql`SELECT count(*)::int AS n FROM scheduling_projects WHERE id = ${SP}::uuid`)).rows[0].n).toBe(1);
    // rifatta, l'anteprima non propone più niente
    const dopo = (await anteprimaScenariUdp(P, UDP))!;
    expect(dopo.eliminabili).toEqual({ turniMacchina: [], turniGuida: [] });
    expect(dopo.bloccati).toBe(3);                    // TM2 e il suo turno guida (giornate di esercizio), TM3 (in esercizio)
  });
});
