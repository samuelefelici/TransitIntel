/**
 * «Copri gli scoperti» (PR 7.6), su un database vero (TEST_DATABASE_URL; in
 * CI come cerbero_app).
 *
 * Un giorno con cinque turni guida pubblicati, due depositi (Nord e Sud):
 *   G1 06–12 Nord: il titolare è assente (malattia)    → da coprire, con il titolare;
 *   G2 10–16 Nord: nessuno                            → da coprire;
 *   G3 14–20 Sud:  nessuno, e al Sud nessun libero     → resta scoperto;
 *   G4 05–11 Nord: lo ha OCCUPATO                      → coperto, non si tocca;
 *   G5 18–23 Nord: nessuno                            → da coprire.
 * Conducenti del Nord:
 *   ALBA      libero, un turno nei giorni intorno, primo per nome; ma ieri ha
 *             finito alle 23:30 e G1 alle 6 non gli lascia le 9 ore di riposo → G2;
 *   SCARICO   libero, un turno nei giorni intorno      → G1 (il primo del mattino);
 *   CARICO    libero, due turni nei giorni intorno     → G5;
 *   DISP      a disposizione                           → nessun turno: i liberi bastano;
 *   OCCUPATO  ha G4                                    → non candidato;
 *   ASSENTE   assente (ASS)                            → non candidato;
 *   FINTO     fittizio                                 → non candidato.
 * Un capo deposito del Sud vede solo G3. Il quadro senza nomi per Argos
 * (GET /roster/quadro-anonimo) ripete gli stessi conti, per deposito.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import anagraficaRouter from "../routes/anagrafica";
import rosterRouter from "../routes/roster";
import { appDiProva, utenteDiProva } from "./helpers/app-di-prova";

const u = (n: number) => `e7600000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [ADMIN, P, UDP, VSS, DSS, PUB, CAPO] = [u(1), u(2), u(3), u(4), u(5), u(6), u(7)];
const [TITOLARE, SCARICO, CARICO, ALBA, DISP, OCCUPATO, ASSENTE, FINTO] = Array.from({ length: 8 }, (_, i) => u(20 + i));
const CONDUCENTI = [TITOLARE, SCARICO, CARICO, ALBA, DISP, OCCUPATO, ASSENTE, FINTO];
const GIORNO = "2032-06-15";
const NORD = "Nord 7.6", SUD = "Sud 7.6";
const TURNI_GUIDA = { driverShifts: [
  { driverId: "G1", nastroStart: "06:00", nastroEnd: "12:00", residenzaName: NORD },
  { driverId: "G2", nastroStart: "10:00", nastroEnd: "16:00", residenzaName: NORD },
  { driverId: "G3", nastroStart: "14:00", nastroEnd: "20:00", residenzaName: SUD },
  { driverId: "G4", nastroStart: "05:00", nastroEnd: "11:00", residenzaName: NORD },
  { driverId: "G5", nastroStart: "18:00", nastroEnd: "23:00", residenzaName: NORD },
] };
const snap = (inizio: number, fine: number) => JSON.stringify({ startMin: inizio, endMin: fine });

const router = Router();
router.use(anagraficaRouter);
router.use(rosterRouter);
const admin = request(appDiProva(router, utenteDiProva(ADMIN, [], "admin")));
const capoSud = request(appDiProva(router, utenteDiProva(CAPO, [], "user", { ruoli: ["capo_deposito"], depositi: ["s76"] })));

const righe = async (q: ReturnType<typeof sql>) => (await db.execute<any>(q)).rows;
const lista = sql.join(CONDUCENTI.map((id) => sql`${id}::uuid`), sql`, `);
const proposta = (chi = admin) => chi.post("/api/roster/copri-scoperti").send({ day: GIORNO });
/** tutte le stringhe che una risposta porta come valori, a ogni profondità (le chiavi no) */
const stringhe = (x: unknown): string[] =>
  typeof x === "string" ? [x]
  : Array.isArray(x) ? x.flatMap(stringhe)
  : x && typeof x === "object" ? Object.values(x).flatMap(stringhe)
  : [];
const coppie = (r: any) =>(r.body.coperture ?? r.body.assegnate).map((c: any) => [c.turno.codice, c.driverId]);

async function pulisci() {
  await db.execute(sql`DELETE FROM roster_anagrafica_log WHERE driver_id IN (${lista})`);
  await db.execute(sql`DELETE FROM roster_assignments WHERE driver_id IN (${lista}) OR dss_id = ${DSS}::uuid`);
  await db.execute(sql`DELETE FROM roster_entries WHERE driver_id IN (${lista})`);
  await db.execute(sql`DELETE FROM roster_drivers WHERE id IN (${lista})`);
  await db.execute(sql`DELETE FROM roster_turni_pubblicati WHERE dss_id = ${DSS}::uuid`);
  await db.execute(sql`DELETE FROM roster_pubblicazioni WHERE id = ${PUB}::uuid`);
  await db.execute(sql`DELETE FROM driver_shift_scenarios WHERE id = ${DSS}::uuid`);
  await db.execute(sql`DELETE FROM service_program_scenarios WHERE id = ${VSS}::uuid`);
  await db.execute(sql`DELETE FROM ps_validity_units WHERE id = ${UDP}::uuid`);
  await db.execute(sql`DELETE FROM ps_projects WHERE id = ${P}::uuid`);
  await db.execute(sql`DELETE FROM users WHERE id = ${ADMIN}::uuid`);
  await db.execute(sql`DELETE FROM roster_depositi WHERE codice IN ('n76', 's76')`);
}

describe.runIf(!!process.env.TEST_DATABASE_URL)("copri gli scoperti, sul database", () => {
  beforeAll(async () => {
    await pulisci();
    await db.execute(sql`INSERT INTO roster_depositi (codice, nome, gruppo, cadenza_turni, alias, ordine) VALUES
      ('n76', ${NORD}, 'A', 'semimensile', '{}'::text[], 76), ('s76', ${SUD}, 'A', 'semimensile', '{}'::text[], 77)`);
    await db.execute(sql`INSERT INTO users (id, email, password_hash, role) VALUES (${ADMIN}::uuid, 'copri@prova.local', 'x', 'admin')`);
    await db.execute(sql`INSERT INTO ps_projects (id, owner_user_id, name) VALUES (${P}::uuid, ${ADMIN}::uuid, 'Programma 7.6')`);
    await db.execute(sql`INSERT INTO ps_validity_units (id, project_id, validity_id, name, trip_ids) VALUES (${UDP}::uuid, ${P}::uuid, 'FER', 'Feriale 7.6', '[]'::jsonb)`);
    await db.execute(sql`INSERT INTO service_program_scenarios (id, name, date, input, result) VALUES (${VSS}::uuid, 'Turni macchina 7.6', '20320615', '{}'::jsonb, '{}'::jsonb)`);
    await db.execute(sql`INSERT INTO driver_shift_scenarios (id, service_program_scenario_id, name, result) VALUES (${DSS}::uuid, ${VSS}::uuid, 'Turni guida 7.6', ${JSON.stringify(TURNI_GUIDA)}::jsonb)`);
    await db.execute(sql`INSERT INTO roster_pubblicazioni (id, tipo, ps_project_id, dal, al) VALUES (${PUB}::uuid, 'pubblica', ${P}::uuid, ${GIORNO}, ${GIORNO})`);
    await db.execute(sql`INSERT INTO roster_turni_pubblicati (day, udp_id, dss_id, vss_id, ps_project_id, udp_nome, dss_nome, pubblicazione_id)
      VALUES (${GIORNO}::date, ${UDP}::uuid, ${DSS}::uuid, ${VSS}::uuid, ${P}::uuid, 'Feriale 7.6', 'Turni guida 7.6', ${PUB}::uuid)`);
    await db.execute(sql`INSERT INTO roster_drivers (id, name, cognome, nome, is_fictitious, is_active, residenza_servizio, data_assunzione, versione, updated_at) VALUES
      (${TITOLARE}::uuid, 'Titolare 7.6', 'Titolare', 'Prova', false, true, ${NORD}, '2020-01-01', 0, now()),
      (${SCARICO}::uuid, 'Scarico 7.6', 'Scarico', 'Prova', false, true, ${NORD}, '2020-01-01', 0, now()),
      (${CARICO}::uuid, 'Carico 7.6', 'Carico', 'Prova', false, true, ${NORD}, '2020-01-01', 0, now()),
      (${ALBA}::uuid, 'Alba 7.6', 'Alba', 'Prova', false, true, ${NORD}, '2020-01-01', 0, now()),
      (${DISP}::uuid, 'Disposizione 7.6', 'Disposizione', 'Prova', false, true, ${NORD}, '2020-01-01', 0, now()),
      (${OCCUPATO}::uuid, 'Occupato 7.6', 'Occupato', 'Prova', false, true, ${NORD}, '2020-01-01', 0, now()),
      (${ASSENTE}::uuid, 'Assente 7.6', 'Assente', 'Prova', false, true, ${NORD}, '2020-01-01', 0, now()),
      (${FINTO}::uuid, 'Finto 7.6', 'Finto', 'Prova', true, true, ${NORD}, NULL, 0, now())`);
    /* i turni del giorno e dei giorni intorno (carico, riposo); un altro DSS per i giorni intorno non serve */
    await db.execute(sql`INSERT INTO roster_assignments (driver_id, day, dss_id, duty_code, snapshot) VALUES
      (${TITOLARE}::uuid, ${GIORNO}::date, ${DSS}::uuid, 'G1', ${snap(360, 720)}::jsonb),
      (${OCCUPATO}::uuid, ${GIORNO}::date, ${DSS}::uuid, 'G4', ${snap(300, 660)}::jsonb),
      (${CARICO}::uuid, ${GIORNO}::date - 2, ${DSS}::uuid, 'G1', ${snap(360, 600)}::jsonb),
      (${CARICO}::uuid, ${GIORNO}::date + 2, ${DSS}::uuid, 'G1', ${snap(360, 600)}::jsonb),
      (${SCARICO}::uuid, ${GIORNO}::date + 3, ${DSS}::uuid, 'G1', ${snap(360, 600)}::jsonb),
      (${ALBA}::uuid, ${GIORNO}::date - 1, ${DSS}::uuid, 'G5', ${snap(1320, 1410)}::jsonb)`);
    await db.execute(sql`INSERT INTO roster_entries (driver_id, day, category, code) VALUES
      (${TITOLARE}::uuid, ${GIORNO}::date, 'assenza', 'MA'),
      (${DISP}::uuid, ${GIORNO}::date, 'presenza', 'D1'),
      (${ASSENTE}::uuid, ${GIORNO}::date, 'assenza', 'ASS')`);
  });
  afterAll(pulisci);

  it("la proposta: liberi per primi, a parità chi ha meno turni intorno, senza violazioni di riposo; non scrive niente", async () => {
    const r = await proposta();
    expect(r.status).toBe(200);
    expect(r.body.pubblicato).toBe(true);
    expect(coppie(r)).toEqual([["G1", SCARICO], ["G2", ALBA], ["G5", CARICO]]);
    const g1 = r.body.coperture[0];
    expect(g1.turno).toMatchObject({ inizio: "06:00", fine: "12:00", deposito: NORD, titolare: { id: TITOLARE, nome: "Titolare Prova" } });
    expect(g1.gruppo).toBe("libero");
    expect(r.body.scoperti).toEqual([{ turno: expect.objectContaining({ codice: "G3", deposito: SUD, titolare: null }), motivo: "nessun_candidato" }]);
    // il motivo dell'assenza non esce
    expect(JSON.stringify(r.body)).not.toMatch(/"MA"|Malattia|"ASS"/);
    const n = await righe(sql`SELECT count(*)::int AS n FROM roster_assignments WHERE day = ${GIORNO}::date AND dss_id = ${DSS}::uuid`);
    expect(n[0].n).toBe(2);
  });

  it("un capo deposito vede solo i turni dei suoi depositi", async () => {
    const r = await proposta(capoSud);
    expect(r.status).toBe(200);
    expect(r.body.coperture).toEqual([]);
    expect(r.body.scoperti.map((s: any) => s.turno.codice)).toEqual(["G3"]);
  });

  it("date sbagliate e giorni senza turni pubblicati", async () => {
    expect((await admin.post("/api/roster/copri-scoperti").send({ day: "2032-02-30" })).status).toBe(400);
    const vuoto = await admin.post("/api/roster/copri-scoperti").send({ day: "2032-06-16" });
    expect(vuoto.body).toEqual({ day: "2032-06-16", pubblicato: false, coperture: [], scoperti: [] });
  });

  it("il quadro senza nomi per Argos: gli stessi conti per deposito, nessuna persona", async () => {
    const r = await admin.get(`/api/roster/quadro-anonimo?dal=${GIORNO}&al=${GIORNO}`);
    expect(r.status).toBe(200);
    expect(r.body.giorni).toHaveLength(1);
    const g = r.body.giorni[0];
    expect(g).toMatchObject({ giorno: GIORNO, pubblicato: true });
    const per = Object.fromEntries(g.depositi.map((d: any) => [d.deposito, d]));
    expect(per[NORD]).toMatchObject({ turni: 4, coperti: 1, daCoprire: 3, titolareAssente: 1, senzaConducente: 2, proponibili: 3,
      senzaCandidati: 0, liberi: 4, aDisposizione: 1, assenti: 2, scoperti: [] });
    expect(per[SUD]).toMatchObject({ turni: 1, coperti: 0, daCoprire: 1, senzaConducente: 1, proponibili: 0, senzaCandidati: 1, liberi: 0, assenti: 0 });
    expect(per[SUD].scoperti).toEqual([{ turno: "G3", inizio: "14:00", fine: "20:00", motivo: "nessun_candidato" }]);
    // nessun nome, nessun id di persona, nessun codice di assenza fra i VALORI
    // (i nomi dei campi, come «aDisposizione» o «titolareAssente», sono fissi
    // e li controlla roster-quadro-anonimo.test.ts)
    const valori = stringhe(r.body);
    for (const x of ["Titolare", "Scarico", "Carico", "Alba", "Disposizione", "Occupato", "Assente", "Finto", "Prova", ...CONDUCENTI]) {
      expect(valori.filter(v => v.includes(x))).toEqual([]);
    }
    for (const codice of ["MA", "ASS", "D1"]) expect(valori).not.toContain(codice);
    // il capo deposito del Sud vede solo il suo; il periodo si controlla; non si scrive niente
    const sud = await capoSud.get(`/api/roster/quadro-anonimo?dal=${GIORNO}&al=${GIORNO}`);
    expect(sud.body.giorni[0].depositi.map((d: any) => d.deposito)).toEqual([SUD]);
    expect((await admin.get("/api/roster/quadro-anonimo?dal=2032-06-15&al=2032-06-30")).status).toBe(400);
    expect((await admin.get("/api/roster/quadro-anonimo?dal=2032-02-30")).status).toBe(400);
    const n = await righe(sql`SELECT count(*)::int AS n FROM roster_assignments WHERE day = ${GIORNO}::date AND dss_id = ${DSS}::uuid`);
    expect(n[0].n).toBe(2);
  });

  it("«Assegna»: le assegnazioni con i controlli di quella a mano; G1 è una sostituzione; poi resta solo G3", async () => {
    const r = await admin.post("/api/roster/copri-scoperti").send({ day: GIORNO, applica: true });
    expect(r.status).toBe(200);
    expect(coppie(r)).toEqual([["G1", SCARICO], ["G2", ALBA], ["G5", CARICO]]);
    expect(r.body.nonAndate).toEqual([]);
    const a = await righe(sql`SELECT duty_code, driver_id::text AS conducente, titolare_id::text AS titolare, sostituzione->>'motivo' AS motivo
      FROM roster_assignments WHERE day = ${GIORNO}::date AND dss_id = ${DSS}::uuid ORDER BY duty_code`);
    expect(a).toEqual([
      { duty_code: "G1", conducente: SCARICO, titolare: TITOLARE, motivo: "assenza" },
      { duty_code: "G2", conducente: ALBA, titolare: null, motivo: null },
      { duty_code: "G4", conducente: OCCUPATO, titolare: null, motivo: null },
      { duty_code: "G5", conducente: CARICO, titolare: null, motivo: null },
    ]);
    const dopo = await proposta();
    expect(dopo.body.coperture).toEqual([]);
    expect(dopo.body.scoperti.map((s: any) => [s.turno.codice, s.motivo])).toEqual([["G3", "nessun_candidato"]]);
  });
});
