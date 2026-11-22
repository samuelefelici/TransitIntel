/**
 * La rotazione dei turni (PR 7.8, migrazione 0061), su un database vero
 * (TEST_DATABASE_URL; in CI come cerbero_app).
 *
 * Un gruppo del deposito Est (cadenza settimanale) con tre conducenti in
 * posizione 1, 2, 3 e tre posti:
 *   posto 1: A1 feriali, S1 sabato;   posto 2: A2 feriali;   posto 3: X9 feriali (mai pubblicato), S3 sabato.
 * Turni pubblicati venerdì 9, sabato 10 e lunedì 12 luglio 2032; la data di
 * riferimento è lunedì 5, quindi il 12 ognuno passa al posto successivo.
 * TRE il sabato riposa; il 12 A2 l'ha già ALTRO, che non è del gruppo.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import anagraficaRouter from "../routes/anagrafica";
import rosterRouter from "../routes/roster";
import { appDiProva, utenteDiProva } from "./helpers/app-di-prova";

const u = (n: number) => `e7800000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [ADMIN, P, UDP, VSS, DSS, PUB, CAPO, GRUPPO] = [u(1), u(2), u(3), u(4), u(5), u(6), u(7), u(8)];
const [UNO, DUE, TRE, ALTRO] = [u(20), u(21), u(22), u(23)];
const CONDUCENTI = [UNO, DUE, TRE, ALTRO];
const GIORNI = ["2032-07-09", "2032-07-10", "2032-07-12"];
const EST = "Est 7.8", OVEST = "Ovest 7.8";
const TURNI_GUIDA = { driverShifts: ["A1", "A2", "A3", "S1", "S3"].map((code, i) => ({
  driverId: code, nastroStart: `${String(5 + i).padStart(2, "0")}:00`, nastroEnd: `${String(11 + i).padStart(2, "0")}:00`, residenzaName: EST,
})) };
const POSTI = [
  { feriale: "A1", sabato: "S1", domenica: null },
  { feriale: "A2", sabato: null, domenica: null },
  { feriale: "X9", sabato: "S3", domenica: null },
];

const router = Router();
router.use(anagraficaRouter);
router.use(rosterRouter);
const admin = request(appDiProva(router, utenteDiProva(ADMIN, [], "admin")));
const capoOvest = request(appDiProva(router, utenteDiProva(CAPO, [], "user", { ruoli: ["capo_deposito"], depositi: ["o78"], depositiVisibili: ["o78"] })));

const righe = async (q: ReturnType<typeof sql>) => (await db.execute<any>(q)).rows;
const lista = sql.join(CONDUCENTI.map((id) => sql`${id}::uuid`), sql`, `);
const url = `/api/roster/rotazioni-turni/${GRUPPO}`;
const coppie = (xs: any[]) => xs.map((a) => `${a.giorno.slice(8)}:${a.nome.split(" ")[0]}=${a.codice}`);

async function pulisci() {
  await db.execute(sql`DELETE FROM roster_anagrafica_log WHERE driver_id IN (${lista})`);
  await db.execute(sql`DELETE FROM roster_assignments WHERE driver_id IN (${lista}) OR dss_id = ${DSS}::uuid`);
  await db.execute(sql`DELETE FROM roster_entries WHERE driver_id IN (${lista})`);
  await db.execute(sql`DELETE FROM roster_drivers WHERE id IN (${lista})`);
  await db.execute(sql`DELETE FROM roster_gruppi_turni WHERE id = ${GRUPPO}::uuid`);
  await db.execute(sql`DELETE FROM roster_turni_pubblicati WHERE dss_id = ${DSS}::uuid`);
  await db.execute(sql`DELETE FROM roster_pubblicazioni WHERE id = ${PUB}::uuid`);
  await db.execute(sql`DELETE FROM driver_shift_scenarios WHERE id = ${DSS}::uuid`);
  await db.execute(sql`DELETE FROM service_program_scenarios WHERE id = ${VSS}::uuid`);
  await db.execute(sql`DELETE FROM ps_validity_units WHERE id = ${UDP}::uuid`);
  await db.execute(sql`DELETE FROM ps_projects WHERE id = ${P}::uuid`);
  await db.execute(sql`DELETE FROM users WHERE id = ${ADMIN}::uuid`);
  await db.execute(sql`DELETE FROM roster_depositi WHERE codice IN ('e78', 'o78')`);
}

describe.runIf(!!process.env.TEST_DATABASE_URL)("rotazione dei turni, sul database", () => {
  beforeAll(async () => {
    await pulisci();
    await db.execute(sql`INSERT INTO roster_depositi (codice, nome, gruppo, cadenza_turni, alias, ordine) VALUES
      ('e78', ${EST}, 'A', 'settimanale', '{}'::text[], 80), ('o78', ${OVEST}, 'A', 'semimensile', '{}'::text[], 81)`);
    await db.execute(sql`INSERT INTO users (id, email, password_hash, role) VALUES (${ADMIN}::uuid, 'rotazione@prova.local', 'x', 'admin')`);
    await db.execute(sql`INSERT INTO ps_projects (id, owner_user_id, name) VALUES (${P}::uuid, ${ADMIN}::uuid, 'Programma 7.8')`);
    await db.execute(sql`INSERT INTO ps_validity_units (id, project_id, validity_id, name, trip_ids) VALUES (${UDP}::uuid, ${P}::uuid, 'FER', 'Feriale 7.8', '[]'::jsonb)`);
    await db.execute(sql`INSERT INTO service_program_scenarios (id, name, date, input, result) VALUES (${VSS}::uuid, 'Turni macchina 7.8', '20320709', '{}'::jsonb, '{}'::jsonb)`);
    await db.execute(sql`INSERT INTO driver_shift_scenarios (id, service_program_scenario_id, name, result) VALUES (${DSS}::uuid, ${VSS}::uuid, 'Turni guida 7.8', ${JSON.stringify(TURNI_GUIDA)}::jsonb)`);
    await db.execute(sql`INSERT INTO roster_pubblicazioni (id, tipo, ps_project_id, dal, al) VALUES (${PUB}::uuid, 'pubblica', ${P}::uuid, ${GIORNI[0]}, ${GIORNI[2]})`);
    for (const g of GIORNI) {
      await db.execute(sql`INSERT INTO roster_turni_pubblicati (day, udp_id, dss_id, vss_id, ps_project_id, udp_nome, dss_nome, pubblicazione_id)
        VALUES (${g}::date, ${UDP}::uuid, ${DSS}::uuid, ${VSS}::uuid, ${P}::uuid, 'Feriale 7.8', 'Turni guida 7.8', ${PUB}::uuid)`);
    }
    await db.execute(sql`INSERT INTO roster_gruppi_turni (id, deposito_codice, nome) VALUES (${GRUPPO}::uuid, 'e78', 'EST 1')`);
    await db.execute(sql`INSERT INTO roster_drivers (id, name, cognome, nome, is_fictitious, is_active, residenza_servizio, data_assunzione, versione, updated_at,
        rotazione_turni_gruppo_id, rotazione_turni_posizione) VALUES
      (${UNO}::uuid, 'Uno 7.8', 'Uno', 'Prova', false, true, ${EST}, '2020-01-01', 0, now(), ${GRUPPO}::uuid, 1),
      (${DUE}::uuid, 'Due 7.8', 'Due', 'Prova', false, true, ${EST}, '2020-01-01', 0, now(), ${GRUPPO}::uuid, 2),
      (${TRE}::uuid, 'Tre 7.8', 'Tre', 'Prova', false, true, ${EST}, '2020-01-01', 0, now(), ${GRUPPO}::uuid, 3),
      (${ALTRO}::uuid, 'Altro 7.8', 'Altro', 'Prova', false, true, ${EST}, '2020-01-01', 0, now(), NULL, NULL)`);
    await db.execute(sql`INSERT INTO roster_entries (driver_id, day, category, code) VALUES (${TRE}::uuid, '2032-07-10'::date, 'assenza', 'R')`);
    await db.execute(sql`INSERT INTO roster_assignments (driver_id, day, dss_id, duty_code, snapshot) VALUES
      (${ALTRO}::uuid, '2032-07-12'::date, ${DSS}::uuid, 'A2', ${JSON.stringify({ startMin: 360, endMin: 720 })}::jsonb)`);
  });
  afterAll(pulisci);

  it("il gruppo senza tabella: cadenza del deposito, conducenti con la posizione, nessun posto", async () => {
    const r = await admin.get(url);
    expect(r.status).toBe(200);
    expect(r.body.gruppo).toMatchObject({ nome: "EST 1", depositoNome: EST, cadenza: "settimanale", riferimento: null, scrive: true });
    expect(r.body.posti).toEqual([]);
    expect(r.body.conducenti.map((c: any) => [c.nome, c.posizione, c.postoDiOggi])).toEqual([["Uno Prova", 1, null], ["Due Prova", 2, null], ["Tre Prova", 3, null]]);
    // un capo di un altro deposito non lo vede, e non lo scrive
    expect((await capoOvest.get(url)).status).toBe(404);
    expect((await capoOvest.put(url).send({ posti: POSTI })).status).toBe(404);
    // senza tabella non si applica
    expect((await admin.post(`${url}/applica`).send({ dal: GIORNI[0], al: GIORNI[2] })).status).toBe(409);
  });

  it("salva la tabella dei posti e la data di riferimento; controlla quello che riceve", async () => {
    expect((await admin.put(url).send({ posti: [] })).status).toBe(400);
    expect((await admin.put(url).send({ posti: [{ feriale: "X".repeat(41) }] })).status).toBe(400);
    expect((await admin.put(url).send({ posti: POSTI, dataRiferimento: "2032-02-30" })).status).toBe(400);
    const r = await admin.put(url).send({ posti: [...POSTI.map((p) => ({ ...p, feriale: ` ${p.feriale} ` }))], dataRiferimento: "2032-07-05" });
    expect(r.status).toBe(200);
    const g = await admin.get(url);
    expect(g.body.posti).toEqual(POSTI);
    expect(g.body.gruppo.riferimento).toBe("2032-07-05");
    const reg = await righe(sql`SELECT posto, feriale FROM roster_rotazioni_turni_posti WHERE gruppo_id = ${GRUPPO}::uuid ORDER BY posto`);
    expect(reg.map((x: any) => [x.posto, x.feriale])).toEqual([[1, "A1"], [2, "A2"], [3, "X9"]]);
  });

  it("la proposta: il turno del posto per il tipo di giorno, il lunedì dopo il posto successivo; non scrive", async () => {
    const r = await admin.post(`${url}/applica`).send({ dal: GIORNI[0], al: GIORNI[2] });
    expect(r.status).toBe(200);
    expect(coppie(r.body.assegnazioni)).toEqual(["09:Uno=A1", "09:Due=A2", "10:Uno=S1", "12:Tre=A1"]);
    expect(r.body.nonFatte.map((n: any) => `${n.giorno.slice(8)}:${n.nome.split(" ")[0]}=${n.codice}:${n.motivo}`)).toEqual([
      "09:Tre=X9:non_pubblicato", "12:Uno=A2:gia_assegnato", "12:Due=X9:non_pubblicato",
    ]);
    const n = await righe(sql`SELECT count(*)::int AS n FROM roster_assignments WHERE dss_id = ${DSS}::uuid`);
    expect(n[0].n).toBe(1);
    expect((await admin.post(`${url}/applica`).send({ dal: "2020-01-01", al: "2020-01-02" })).status).toBe(400);
  });

  it("«Assegna»: le assegnazioni con i controlli di quella a mano; poi niente da assegnare", async () => {
    const r = await admin.post(`${url}/applica`).send({ dal: GIORNI[0], al: GIORNI[2], applica: true });
    expect(r.status).toBe(200);
    expect(coppie(r.body.fatte)).toEqual(["09:Uno=A1", "09:Due=A2", "10:Uno=S1", "12:Tre=A1"]);
    expect(r.body.nonAndate).toEqual([]);
    const a = await righe(sql`SELECT day::text AS g, duty_code, driver_id::text AS chi FROM roster_assignments WHERE dss_id = ${DSS}::uuid ORDER BY day, duty_code`);
    expect(a.map((x: any) => `${x.g.slice(8)}:${x.duty_code}`)).toEqual(["09:A1", "09:A2", "10:S1", "12:A1", "12:A2"]);
    const dopo = await admin.post(`${url}/applica`).send({ dal: GIORNI[0], al: GIORNI[2] });
    expect(dopo.body.assegnazioni).toEqual([]);
  });
});
