/**
 * Le assenze che liberano il turno e i sostituti suggeriti (tappa 5.1,
 * migrazione 0032), su un database vero (TEST_DATABASE_URL; in CI come
 * cerbero_app).
 *
 * Un giorno con tre turni guida pubblicati: G1 06–12, G2 10–16, G3 22–23:30.
 * Conducenti di Jesi:
 *   TITOLARE  ha G1, ed è assente (malattia): G1 è da coprire;
 *   LIBERO    niente quel giorno                        → libero;
 *   DISP      a disposizione (D1)                       → a disposizione;
 *   SERALE    ha G3: riposo di 10 ore                   → in servizio, compatibile;
 *   SOVRAPP   ha G2, che si sovrappone a G1             → fuori (violazione);
 *   ASSENTE   in ferie                                  → fuori (assente);
 *   FINTO     fittizio, NUOVO assunto dopo quel giorno  → non candidati.
 * E uno di Ancona, che non è candidato.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import anagraficaRouter from "../routes/anagrafica";
import rosterRouter from "../routes/roster";
import { appDiProva, utenteDiProva } from "./helpers/app-di-prova";
import { liberaIlTurno, sostitutiDa } from "../lib/roster-sostituti";
import { catalogoDa, VOCI_DI_PARTENZA } from "../lib/roster-voci";

const CATALOGO = catalogoDa(VOCI_DI_PARTENZA);

const u = (n: number) => `e5100000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [ADMIN, P, UDP, VSS, DSS, PUB] = [u(1), u(2), u(3), u(4), u(5), u(6)];
const [TITOLARE, LIBERO, DISP, SERALE, SOVRAPP, ASSENTE, FINTO, NUOVO, ANCONA] = Array.from({ length: 9 }, (_, i) => u(20 + i));
const CONDUCENTI = [TITOLARE, LIBERO, DISP, SERALE, SOVRAPP, ASSENTE, FINTO, NUOVO, ANCONA];
const GIORNO = "2032-05-12";
const TURNI_GUIDA = { driverShifts: [
  { driverId: "G1", nastroStart: "06:00", nastroEnd: "12:00", residenzaName: "Deposito di Jesi" },
  { driverId: "G2", nastroStart: "10:00", nastroEnd: "16:00" },
  { driverId: "G3", nastroStart: "22:00", nastroEnd: "23:30" },
] };
const snap = (inizio: number, fine: number) => JSON.stringify({ startMin: inizio, endMin: fine });

const router = Router();
router.use(anagraficaRouter);
router.use(rosterRouter);
const admin = request(appDiProva(router, utenteDiProva(ADMIN, [], "admin")));

const righe = async (q: ReturnType<typeof sql>) => (await db.execute<any>(q)).rows;
const assegnazione = async (codice: string) => (await righe(sql`
  SELECT driver_id::text AS conducente, titolare_id::text AS titolare, sostituzione FROM roster_assignments
   WHERE dss_id = ${DSS}::uuid AND day = ${GIORNO}::date AND duty_code = ${codice}`))[0];
const assegna = (driverId: string, dutyCode: string) => admin.post("/api/roster/assignments").send({ driverId, day: GIORNO, dssId: DSS, dutyCode });

async function pulisci() {
  await db.execute(sql`DELETE FROM roster_anagrafica_log WHERE driver_id IN (SELECT x::uuid FROM jsonb_array_elements_text(${JSON.stringify(CONDUCENTI)}::jsonb) x)`);
  await db.execute(sql`DELETE FROM roster_assignments WHERE dss_id = ${DSS}::uuid`);
  await db.execute(sql`DELETE FROM roster_drivers WHERE id IN (SELECT x::uuid FROM jsonb_array_elements_text(${JSON.stringify(CONDUCENTI)}::jsonb) x)`);
  await db.execute(sql`DELETE FROM roster_turni_pubblicati WHERE dss_id = ${DSS}::uuid`);
  await db.execute(sql`DELETE FROM roster_pubblicazioni WHERE id = ${PUB}::uuid`);
  await db.execute(sql`DELETE FROM driver_shift_scenarios WHERE id = ${DSS}::uuid`);
  await db.execute(sql`DELETE FROM service_program_scenarios WHERE id = ${VSS}::uuid`);
  await db.execute(sql`DELETE FROM ps_validity_units WHERE id = ${UDP}::uuid`);
  await db.execute(sql`DELETE FROM ps_projects WHERE id = ${P}::uuid`);
  await db.execute(sql`DELETE FROM users WHERE id = ${ADMIN}::uuid`);
}

describe("le regole, senza database", () => {
  it("il riposo non libera il turno, le altre assenze sì, le presenze no", () => {
    expect(liberaIlTurno({ category: "assenza", code: "MA" }, CATALOGO)).toBe(true);
    expect(liberaIlTurno({ category: "assenza", code: "ASS" }, CATALOGO)).toBe(true);
    expect(liberaIlTurno({ category: "assenza", code: "R" }, CATALOGO)).toBe(false);
    expect(liberaIlTurno({ category: "presenza", code: "D1" }, CATALOGO)).toBe(false);
  });
  it("i gruppi in ordine, poi per nome; fuori gli assenti, chi viola e il titolare", () => {
    const c = (id: string, nome: string) => ({ id, nome, matricola: null, deposito: "Jesi" });
    const r = sostitutiDa({
      candidati: [c("a", "Verdi"), c("b", "Bianchi"), c("c", "Rossi"), c("d", "Neri"), c("e", "Gialli"), c("t", "Titolare")],
      esclusi: new Set(["t"]),
      voci: [{ driverId: "b", day: "x", category: "presenza", code: "D2" }, { driverId: "e", day: "x", category: "assenza", code: "R" }],
      turni: new Map([["c", ["G3"]], ["d", ["G2"]]]),
      violazioni: new Map([["d", 1]]),
      catalogo: CATALOGO,
    });
    expect(r.sostituti.map((s) => [s.id, s.gruppo])).toEqual([["a", "libero"], ["b", "disposizione"], ["c", "in_servizio"]]);
    expect(r.sostituti[2]!.turni).toEqual(["G3"]);
    expect(r.fuori).toEqual({ assenti: 1, violazioni: 1 });
  });
});

describe.runIf(!!process.env.TEST_DATABASE_URL)("assenze che liberano il turno e sostituti, sul database", () => {
  beforeAll(async () => {
    await pulisci();
    await db.execute(sql`INSERT INTO users (id, email, password_hash, role) VALUES (${ADMIN}::uuid, 'sostituti@prova.local', 'x', 'admin')`);
    await db.execute(sql`INSERT INTO ps_projects (id, owner_user_id, name) VALUES (${P}::uuid, ${ADMIN}::uuid, 'Programma 5.1')`);
    await db.execute(sql`INSERT INTO ps_validity_units (id, project_id, validity_id, name, trip_ids) VALUES (${UDP}::uuid, ${P}::uuid, 'FER', 'Feriale 5.1', '[]'::jsonb)`);
    await db.execute(sql`INSERT INTO service_program_scenarios (id, name, date, input, result) VALUES (${VSS}::uuid, 'Turni macchina 5.1', '20320512', '{}'::jsonb, '{}'::jsonb)`);
    await db.execute(sql`INSERT INTO driver_shift_scenarios (id, service_program_scenario_id, name, result) VALUES (${DSS}::uuid, ${VSS}::uuid, 'Turni guida 5.1', ${JSON.stringify(TURNI_GUIDA)}::jsonb)`);
    await db.execute(sql`INSERT INTO roster_pubblicazioni (id, tipo, ps_project_id, dal, al) VALUES (${PUB}::uuid, 'pubblica', ${P}::uuid, ${GIORNO}, ${GIORNO})`);
    await db.execute(sql`INSERT INTO roster_turni_pubblicati (day, udp_id, dss_id, vss_id, ps_project_id, udp_nome, dss_nome, pubblicazione_id)
      VALUES (${GIORNO}::date, ${UDP}::uuid, ${DSS}::uuid, ${VSS}::uuid, ${P}::uuid, 'Feriale 5.1', 'Turni guida 5.1', ${PUB}::uuid)`);
    await db.execute(sql`INSERT INTO roster_drivers (id, name, cognome, nome, is_fictitious, is_active, residenza_servizio, data_assunzione, versione, updated_at) VALUES
      (${TITOLARE}::uuid, 'Titolare 5.1', 'Titolare', 'Prova', false, true, 'Jesi', '2020-01-01', 0, now()),
      (${LIBERO}::uuid, 'Libero 5.1', 'Libero', 'Prova', false, true, 'Jesi', '2020-01-01', 0, now()),
      (${DISP}::uuid, 'Disposizione 5.1', 'Disposizione', 'Prova', false, true, 'Jesi', '2020-01-01', 0, now()),
      (${SERALE}::uuid, 'Serale 5.1', 'Serale', 'Prova', false, true, 'Jesi', '2020-01-01', 0, now()),
      (${SOVRAPP}::uuid, 'Sovrapposto 5.1', 'Sovrapposto', 'Prova', false, true, 'Jesi', '2020-01-01', 0, now()),
      (${ASSENTE}::uuid, 'Assente 5.1', 'Assente', 'Prova', false, true, 'Jesi', '2020-01-01', 0, now()),
      (${FINTO}::uuid, 'Finto 5.1', 'Finto', 'Prova', true, true, 'Jesi', NULL, 0, now()),
      (${NUOVO}::uuid, 'Nuovo 5.1', 'Nuovo', 'Prova', false, true, 'Jesi', '2033-01-01', 0, now()),
      (${ANCONA}::uuid, 'Ancona 5.1', 'Ancona', 'Prova', false, true, 'Ancona', '2020-01-01', 0, now())`);
    await db.execute(sql`INSERT INTO roster_assignments (driver_id, day, dss_id, duty_code, snapshot) VALUES
      (${TITOLARE}::uuid, ${GIORNO}::date, ${DSS}::uuid, 'G1', ${snap(360, 720)}::jsonb),
      (${SOVRAPP}::uuid, ${GIORNO}::date, ${DSS}::uuid, 'G2', ${snap(600, 960)}::jsonb),
      (${SERALE}::uuid, ${GIORNO}::date, ${DSS}::uuid, 'G3', ${snap(1320, 1410)}::jsonb)`);
    await db.execute(sql`INSERT INTO roster_entries (driver_id, day, category, code) VALUES
      (${TITOLARE}::uuid, ${GIORNO}::date, 'assenza', 'MA'),
      (${DISP}::uuid, ${GIORNO}::date, 'presenza', 'D1'),
      (${ASSENTE}::uuid, ${GIORNO}::date, 'assenza', 'R')`);
  });
  afterAll(pulisci);

  it("i sostituti di un turno liberato: liberi, a disposizione, in servizio compatibili; il motivo dell'assenza non esce", async () => {
    const r = await admin.get(`/api/roster/sostituti?day=${GIORNO}&dssId=${DSS}&dutyCode=G1`);
    expect(r.status).toBe(200);
    expect(r.body.titolare).toEqual({ id: TITOLARE, nome: "Titolare Prova", assente: true });
    expect(r.body.deposito).toBe("Jesi");
    expect(r.body.sostituti.map((s: any) => [s.id, s.gruppo])).toEqual([[LIBERO, "libero"], [DISP, "disposizione"], [SERALE, "in_servizio"]]);
    expect(r.body.fuori).toEqual({ assenti: 1, violazioni: 1 });
    expect(JSON.stringify(r.body)).not.toMatch(/"MA"|Malattia|"R"|Riposo/);
    expect((await admin.get(`/api/roster/sostituti?day=2032-02-30&dssId=${DSS}&dutyCode=G1`)).status).toBe(400);
  });

  it("riassegnarlo mentre il titolare è assente è una sostituzione, anche di seguito; una riassegnazione normale no", async () => {
    expect((await assegna(LIBERO, "G1")).status).toBe(201);
    const a = await assegnazione("G1");
    expect(a).toMatchObject({ conducente: LIBERO, titolare: TITOLARE, sostituzione: { da: ADMIN, motivo: "assenza" } });
    const log = await righe(sql`SELECT azione, dettaglio FROM roster_anagrafica_log WHERE driver_id = ${LIBERO}::uuid AND azione = 'turno-sostituzione'`);
    expect(log).toHaveLength(1);
    expect(log[0].dettaglio).toMatchObject({ day: GIORNO, codice: "G1", titolare: TITOLARE, motivo: "assenza" });
    // un secondo sostituto: il titolare resta quello di prima
    expect((await assegna(DISP, "G1")).status).toBe(201);
    expect(await assegnazione("G1")).toMatchObject({ conducente: DISP, titolare: TITOLARE });
    // G2: chi lo aveva non è assente, è una riassegnazione e basta
    expect((await assegna(LIBERO, "G2")).status).toBe(201);
    expect(await assegnazione("G2")).toEqual({ conducente: LIBERO, titolare: null, sostituzione: null });
    // il tabellone lo dice
    const b = await admin.get(`/api/roster/board?from=${GIORNO}&days=1`);
    expect(b.status).toBe(200);
    expect(b.body.assignments.find((x: any) => x.dutyCode === "G1")).toMatchObject({ driverId: DISP, titolareId: TITOLARE });
    // 5.2: ogni turno porta il deposito del catalogo, dalla sua residenza (come i colori)
    const catalogo = (await admin.get("/api/roster/depositi")).body.depositi as Array<{ codice: string; nome: string }>;
    const jesi = catalogo.find((d) => d.nome.toLowerCase() === "jesi")?.codice ?? null;
    const turni = b.body.dutiesByDss[DSS] as Array<{ code: string; depositoCodice: string | null }>;
    expect(turni.find((t) => t.code === "G1")!.depositoCodice).toBe(jesi);
    expect(turni.find((t) => t.code === "G2")!.depositoCodice).toBeNull();
  });

  it("il titolare torna: senza assenza, riassegnargli il turno chiude la sostituzione", async () => {
    await db.execute(sql`DELETE FROM roster_entries WHERE driver_id = ${TITOLARE}::uuid AND day = ${GIORNO}::date`);
    expect((await assegna(TITOLARE, "G1")).status).toBe(201);
    expect(await assegnazione("G1")).toEqual({ conducente: TITOLARE, titolare: null, sostituzione: null });
    const r = await admin.get(`/api/roster/sostituti?day=${GIORNO}&dssId=${DSS}&dutyCode=G1`);
    expect(r.body.titolare).toEqual({ id: TITOLARE, nome: "Titolare Prova", assente: false });
  });
});
