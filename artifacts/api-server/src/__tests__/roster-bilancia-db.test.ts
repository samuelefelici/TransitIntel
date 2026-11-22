/**
 * «Bilancia i carichi» (PR 7.7), su un database vero (TEST_DATABASE_URL; in
 * CI come cerbero_app).
 *
 * Tre giorni, due depositi.
 * Nord:
 *   PIENO   G1, G2, G3 (8 ore l'uno); G3 è una sostituzione di un titolare assente;
 *   VUOTO   libero tutti e tre i giorni                → riceve G1;
 *   RIPOSO  riposo tutti e tre i giorni               → non riceve niente;
 *   FINTO   fittizio, libero                          → non conta;
 *   TITOLARE in malattia tutti e tre i giorni          → non riceve niente.
 * Sud:
 *   SUD1    S1, S2 (8 ore l'uno)
 *   SUD2    libero                                    → riceve S1.
 * Un capo deposito del Sud vede solo il Sud.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import anagraficaRouter from "../routes/anagrafica";
import rosterRouter from "../routes/roster";
import { appDiProva, utenteDiProva } from "./helpers/app-di-prova";

const u = (n: number) => `e7700000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [ADMIN, VSS, DSS, CAPO, TITOLARE] = [u(1), u(2), u(3), u(4), u(5)];
const [PIENO, VUOTO, RIPOSO, FINTO, SUD1, SUD2] = Array.from({ length: 6 }, (_, i) => u(20 + i));
const CONDUCENTI = [TITOLARE, PIENO, VUOTO, RIPOSO, FINTO, SUD1, SUD2];
const [G1, G2, G3] = ["2032-07-05", "2032-07-06", "2032-07-07"];
const NORD = "Nord 7.7", SUD = "Sud 7.7";
const snap = (inizio: number, fine: number) => JSON.stringify({ startMin: inizio, endMin: fine });
const OTTO = snap(360, 840);

const router = Router();
router.use(anagraficaRouter);
router.use(rosterRouter);
const admin = request(appDiProva(router, utenteDiProva(ADMIN, [], "admin")));
const capoSud = request(appDiProva(router, utenteDiProva(CAPO, [], "user", { ruoli: ["capo_deposito"], depositi: ["s77"] })));

const righe = async (q: ReturnType<typeof sql>) => (await db.execute<any>(q)).rows;
const lista = sql.join(CONDUCENTI.map((id) => sql`${id}::uuid`), sql`, `);
const proposta = (chi = admin, corpo: Record<string, unknown> = { dal: G1, al: G3 }) => chi.post("/api/roster/bilancia-carichi").send(corpo);
const mosse = (d: any) => d.mosse.map((m: any) => [m.tipo, m.giorno, m.turno.codice, m.da.id, m.a.id]);

async function pulisci() {
  await db.execute(sql`DELETE FROM roster_anagrafica_log WHERE driver_id IN (${lista})`);
  await db.execute(sql`DELETE FROM roster_assignments WHERE driver_id IN (${lista}) OR dss_id = ${DSS}::uuid`);
  await db.execute(sql`DELETE FROM roster_entries WHERE driver_id IN (${lista})`);
  await db.execute(sql`DELETE FROM roster_drivers WHERE id IN (${lista})`);
  await db.execute(sql`DELETE FROM driver_shift_scenarios WHERE id = ${DSS}::uuid`);
  await db.execute(sql`DELETE FROM service_program_scenarios WHERE id = ${VSS}::uuid`);
  await db.execute(sql`DELETE FROM users WHERE id = ${ADMIN}::uuid`);
  await db.execute(sql`DELETE FROM roster_depositi WHERE codice IN ('n77', 's77')`);
}

describe.runIf(!!process.env.TEST_DATABASE_URL)("bilancia i carichi, sul database", () => {
  beforeAll(async () => {
    await pulisci();
    await db.execute(sql`INSERT INTO roster_depositi (codice, nome, gruppo, cadenza_turni, alias, ordine) VALUES
      ('n77', ${NORD}, 'A', 'semimensile', '{}'::text[], 78), ('s77', ${SUD}, 'A', 'semimensile', '{}'::text[], 79)`);
    await db.execute(sql`INSERT INTO users (id, email, password_hash, role) VALUES (${ADMIN}::uuid, 'bilancia@prova.local', 'x', 'admin')`);
    await db.execute(sql`INSERT INTO service_program_scenarios (id, name, date, input, result) VALUES (${VSS}::uuid, 'Turni macchina 7.7', '20320705', '{}'::jsonb, '{}'::jsonb)`);
    await db.execute(sql`INSERT INTO driver_shift_scenarios (id, service_program_scenario_id, name, result) VALUES (${DSS}::uuid, ${VSS}::uuid, 'Turni guida 7.7', '{}'::jsonb)`);
    await db.execute(sql`INSERT INTO roster_drivers (id, name, cognome, nome, is_fictitious, is_active, residenza_servizio, data_assunzione, versione, updated_at) VALUES
      (${TITOLARE}::uuid, 'Titolare 7.7', 'Titolare', 'Prova', false, true, ${NORD}, '2020-01-01', 0, now()),
      (${PIENO}::uuid, 'Pieno 7.7', 'Pieno', 'Prova', false, true, ${NORD}, '2020-01-01', 0, now()),
      (${VUOTO}::uuid, 'Vuoto 7.7', 'Vuoto', 'Prova', false, true, ${NORD}, '2020-01-01', 0, now()),
      (${RIPOSO}::uuid, 'Riposo 7.7', 'Riposo', 'Prova', false, true, ${NORD}, '2020-01-01', 0, now()),
      (${FINTO}::uuid, 'Finto 7.7', 'Finto', 'Prova', true, true, ${NORD}, NULL, 0, now()),
      (${SUD1}::uuid, 'Primo 7.7', 'Primo', 'Prova', false, true, ${SUD}, '2020-01-01', 0, now()),
      (${SUD2}::uuid, 'Secondo 7.7', 'Secondo', 'Prova', false, true, ${SUD}, '2020-01-01', 0, now())`);
    await db.execute(sql`INSERT INTO roster_assignments (driver_id, day, dss_id, duty_code, snapshot, titolare_id, sostituzione) VALUES
      (${PIENO}::uuid, ${G1}::date, ${DSS}::uuid, 'G1', ${OTTO}::jsonb, NULL, NULL),
      (${PIENO}::uuid, ${G2}::date, ${DSS}::uuid, 'G2', ${OTTO}::jsonb, NULL, NULL),
      (${PIENO}::uuid, ${G3}::date, ${DSS}::uuid, 'G3', ${OTTO}::jsonb, ${TITOLARE}::uuid, ${JSON.stringify({ da: ADMIN, motivo: "assenza" })}::jsonb),
      (${SUD1}::uuid, ${G1}::date, ${DSS}::uuid, 'S1', ${OTTO}::jsonb, NULL, NULL),
      (${SUD1}::uuid, ${G2}::date, ${DSS}::uuid, 'S2', ${OTTO}::jsonb, NULL, NULL)`);
    await db.execute(sql`INSERT INTO roster_entries (driver_id, day, category, code) VALUES
      (${RIPOSO}::uuid, ${G1}::date, 'assenza', 'R'), (${RIPOSO}::uuid, ${G2}::date, 'assenza', 'R'), (${RIPOSO}::uuid, ${G3}::date, 'assenza', 'R'),
      (${TITOLARE}::uuid, ${G1}::date, 'assenza', 'MA'), (${TITOLARE}::uuid, ${G2}::date, 'assenza', 'MA'), (${TITOLARE}::uuid, ${G3}::date, 'assenza', 'MA')`);
  });
  afterAll(pulisci);

  it("la proposta, per deposito: al libero il turno che li avvicina di più; non le sostituzioni, non chi riposa; non scrive", async () => {
    const r = await proposta();
    expect(r.status).toBe(200);
    const nord = r.body.depositi.find((d: any) => d.deposito === NORD);
    const sud = r.body.depositi.find((d: any) => d.deposito === SUD);
    // Nord: 24h, 0, 0 → G1 a chi è libero; G3 è una sostituzione e resta
    expect(mosse(nord)).toEqual([["cede", G1, "G1", PIENO, VUOTO]]);
    expect(nord.scartoPrima).toBe(24 * 60);
    expect(nord.scartoDopo).toBe(16 * 60);
    expect(nord.carichi.map((c: any) => c.id).sort()).toEqual([PIENO, RIPOSO, TITOLARE, VUOTO].sort());
    expect(mosse(sud)).toEqual([["cede", G1, "S1", SUD1, SUD2]]);
    expect(sud.scartoDopo).toBe(0);
    expect(JSON.stringify(r.body)).not.toMatch(/"MA"|"R"|Malattia|Riposo"/);
    const n = await righe(sql`SELECT count(*)::int AS n FROM roster_assignments WHERE driver_id = ${PIENO}::uuid`);
    expect(n[0].n).toBe(3);
  });

  it("un capo deposito vede e sposta solo nel suo deposito", async () => {
    const r = await proposta(capoSud);
    expect(r.status).toBe(200);
    expect(r.body.depositi.map((d: any) => d.deposito)).toEqual([SUD]);
  });

  it("periodo: da domani, al più 31 giorni, date vere", async () => {
    expect((await proposta(admin, { dal: "2020-01-01", al: "2020-01-02" })).status).toBe(400);
    expect((await proposta(admin, { dal: G1, al: "2032-09-30" })).status).toBe(400);
    expect((await proposta(admin, { dal: G3, al: G1 })).status).toBe(400);
    expect((await proposta(admin, { dal: "2032-02-30", al: G1 })).status).toBe(400);
  });

  it("«Applica»: gli spostamenti con i controlli dello scambio a mano; poi niente da spostare", async () => {
    const r = await proposta(admin, { dal: G1, al: G3, applica: true });
    expect(r.status).toBe(200);
    expect(r.body.fatte.map((m: any) => m.turno.codice).sort()).toEqual(["G1", "S1"]);
    expect(r.body.nonAndate).toEqual([]);
    const a = await righe(sql`SELECT duty_code, driver_id::text AS chi, titolare_id::text AS titolare FROM roster_assignments WHERE dss_id = ${DSS}::uuid ORDER BY duty_code`);
    expect(a).toEqual([
      { duty_code: "G1", chi: VUOTO, titolare: null },
      { duty_code: "G2", chi: PIENO, titolare: null },
      { duty_code: "G3", chi: PIENO, titolare: TITOLARE },
      { duty_code: "S1", chi: SUD2, titolare: null },
      { duty_code: "S2", chi: SUD1, titolare: null },
    ]);
    const dopo = await proposta();
    expect(dopo.body.depositi.flatMap((d: any) => d.mosse)).toEqual([]);
  });

  it("il cambio turno a mano, dopo l'estrazione in eseguiScambio: scambio nello stesso giorno sì, fra giorni diversi no", async () => {
    const id = async (codice: string) => (await righe(sql`SELECT id::text FROM roster_assignments WHERE dss_id = ${DSS}::uuid AND duty_code = ${codice}`))[0].id;
    const [g1, s1, s2] = [await id("G1"), await id("S1"), await id("S2")];
    const ok = await admin.post("/api/roster/assignments/scambia").send({ da: g1, daConducente: VUOTO, a: s1, aConducente: SUD2 });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, forzato: false, giorno: G1, ceduto: { dutyCode: "G1", driverId: SUD2 }, ricevuto: { dutyCode: "S1", driverId: VUOTO } });
    const no = await admin.post("/api/roster/assignments/scambia").send({ da: s1, daConducente: VUOTO, a: s2, aConducente: SUD1 });
    expect(no.status).toBe(400);
  });
});
