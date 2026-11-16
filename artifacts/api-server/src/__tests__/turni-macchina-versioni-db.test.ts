/**
 * I turni macchina versionati e pubblicati insieme ai turni guida (PR 3.6,
 * contratto C2), su un database vero (TEST_DATABASE_URL; in CI come
 * cerbero_app).
 *
 * Un programma con un'UDP, un turni macchina e i suoi turni guida, pubblicati
 * per due giorni. Il canale deve scrivere il turno macchina di ogni giorno; i
 * turni macchina usati dal roster non si sovrascrivono (versione nuova, i
 * turni guida restano sulla vecchia); il database tiene la coppia coerente e
 * non lascia cancellare un turno macchina pubblicato.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import turniMacchina from "../routes/service-program";
import { anteprima, pubblica, canale, candidatiDelleUdp } from "../lib/roster-pubblicazione-db";
import { appDiProva, utenteDiProva } from "./helpers/app-di-prova";

const u = (n: number) => `d3600000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [ADMIN, ALTRO] = [u(1), u(2)];
const [P, UDP, SP] = [u(10), u(11), u(12)];
const [V1, D1, V_LIBERO] = [u(20), u(21), u(22)];
const GIORNI = ["2031-03-03", "2031-03-04"];

const admin = appDiProva(turniMacchina, utenteDiProva(ADMIN, [], "admin"));

const BLOCCHI = { shifts: [{ vehicleId: "M1", trips: [{ tripId: "c1", departureTime: "07:00", arrivalTime: "07:30" }] }], summary: { totalVehicles: 1 } };
const TURNI_GUIDA = {
  driverShifts: [{
    driverId: "G1",
    riprese: [{ trips: [{ type: "trip", routeName: "1", departureTime: "07:00", arrivalTime: "07:30", firstStopName: "Stazione", lastStopName: "Ospedale", vehicleId: "M1" }] }],
  }],
};

const salva = (id: string, body: Record<string, unknown>) =>
  request(admin).put(`/api/service-program/scenarios/${id}`).send(body);
const riga = async (id: string) =>
  (await db.execute<any>(sql`SELECT id::text, name, result, COALESCE(version, 1) AS version, superseded_by::text AS superato_da
                               FROM service_program_scenarios WHERE id = ${id}::uuid`)).rows[0];
const codice = (e: any) => e?.cause?.code ?? e?.code;

describe.runIf(!!process.env.TEST_DATABASE_URL)("turni macchina versionati e pubblicati coi turni guida, sul database", () => {
  const pulisci = async () => {
    await db.execute(sql`DELETE FROM roster_turni_pubblicati WHERE ps_project_id = ${P}::uuid`);
    await db.execute(sql`DELETE FROM roster_pubblicazioni WHERE ps_project_id = ${P}::uuid`);
    await db.execute(sql`DELETE FROM driver_shift_scenarios WHERE service_program_scenario_id IN
                           (SELECT id FROM service_program_scenarios WHERE project_id = ${SP}::uuid OR id = ${V_LIBERO}::uuid)`);
    await db.execute(sql`DELETE FROM service_program_scenarios WHERE project_id = ${SP}::uuid OR id = ${V_LIBERO}::uuid`);
    await db.execute(sql`DELETE FROM scheduling_projects WHERE id = ${SP}::uuid`);
    await db.execute(sql`DELETE FROM ps_validity_units WHERE id = ${UDP}::uuid`);
    await db.execute(sql`DELETE FROM ps_projects WHERE id = ${P}::uuid`);
    await db.execute(sql`DELETE FROM users WHERE id IN (${ADMIN}::uuid, ${ALTRO}::uuid)`);
  };

  beforeAll(async () => {
    await pulisci();
    await db.execute(sql`INSERT INTO users (id, email, password_hash, role) VALUES
      (${ADMIN}::uuid, 'tm-admin@prova.local', 'x', 'admin'), (${ALTRO}::uuid, 'tm-altro@prova.local', 'x', 'user')`);
    await db.execute(sql`INSERT INTO ps_projects (id, owner_user_id, name) VALUES (${P}::uuid, ${ADMIN}::uuid, 'Programma turni macchina 3.6')`);
    await db.execute(sql`INSERT INTO ps_validity_units (id, project_id, validity_id, name, representative_dates, day_count)
                         VALUES (${UDP}::uuid, ${P}::uuid, 'fer', 'Feriale', ${JSON.stringify(GIORNI)}::jsonb, 2)`);
    await db.execute(sql`INSERT INTO scheduling_projects (id, owner_user_id, name, validity_unit_id)
                         VALUES (${SP}::uuid, ${ADMIN}::uuid, 'Turni feriale 3.6', ${UDP}::uuid)`);
    await db.execute(sql`INSERT INTO service_program_scenarios (id, name, date, input, result, owner_user_id, project_id) VALUES
      (${V1}::uuid, 'Turni macchina feriale', '20310303', '{}'::jsonb, ${JSON.stringify(BLOCCHI)}::jsonb, ${ADMIN}::uuid, ${SP}::uuid),
      (${V_LIBERO}::uuid, 'Turni macchina di prova', '20310303', '{}'::jsonb, ${JSON.stringify(BLOCCHI)}::jsonb, ${ADMIN}::uuid, NULL)`);
    await db.execute(sql`INSERT INTO vehicle_schedule_members (scenario_id, user_id, role, added_by) VALUES (${V1}::uuid, ${ALTRO}::uuid, 'editor', ${ADMIN}::uuid)`);
    await db.execute(sql`INSERT INTO driver_shift_scenarios (id, service_program_scenario_id, name, result, owner_user_id)
                         VALUES (${D1}::uuid, ${V1}::uuid, 'Turni guida feriale', ${JSON.stringify(TURNI_GUIDA)}::jsonb, ${ADMIN}::uuid)`);
  });
  afterAll(pulisci);

  it("turni macchina che il roster non usa: si salvano sopra, come prima", async () => {
    const r = await salva(V_LIBERO, { result: { ...BLOCCHI, summary: { totalVehicles: 2 } } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toEqual({ id: V_LIBERO, ok: true });
    expect((await riga(V_LIBERO)).result.summary.totalVehicles).toBe(2);
  });

  it("la pubblicazione scrive, per ogni giorno, il turno macchina dei turni guida", async () => {
    const richiesta = { psProjectId: P, dal: GIORNI[0]!, al: GIORNI[1]!, scelte: { [UDP]: D1 } };
    const a: any = await anteprima(richiesta, ADMIN, true);
    expect(a.gettone).toBeTruthy();
    await pubblica({ ...richiesta, gettone: a.gettone }, ADMIN, "prova", true);
    const righe = (await db.execute<any>(sql`
      SELECT day::text AS day, dss_id::text AS dss, vss_id::text AS vss FROM roster_turni_pubblicati
       WHERE ps_project_id = ${P}::uuid AND sostituita_da IS NULL ORDER BY day`)).rows;
    expect(righe).toEqual(GIORNI.map((day) => ({ day, dss: D1, vss: V1 })));
    const attive = await canale(db as any, GIORNI[0]!, GIORNI[1]!);
    expect(attive.filter((x) => x.udpId === UDP).map((x) => x.vssId)).toEqual([V1, V1]);
  });

  it("i ritocchi automatici non toccano turni macchina usati dal roster", async () => {
    const r = await salva(V1, { result: { ...BLOCCHI, unassigned: [] }, nonVersionare: true });
    expect(r.status).toBe(409);
    expect(r.body.usatoNelRoster).toBe(true);
    const v = await riga(V1);
    expect(v.result).toEqual(BLOCCHI);
    expect(v.superato_da).toBeNull();
  });

  it("lo stesso risultato con un nome nuovo resta sullo stesso scenario", async () => {
    const r = await salva(V1, { name: "Turni macchina feriale (rinominati)", result: BLOCCHI });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toEqual({ id: V1, ok: true });
    expect((await riga(V1)).name).toBe("Turni macchina feriale (rinominati)");
  });

  let V2 = "";
  it("un risultato nuovo, coi turni guida nel roster, crea una versione: i turni guida e il canale restano sulla vecchia", async () => {
    const nuovo = { ...BLOCCHI, shifts: [...BLOCCHI.shifts, { vehicleId: "M2", trips: [] }] };
    const r = await salva(V1, { result: nuovo });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.versionedFrom).toBe(V1);
    expect(r.body.version).toBe(2);
    V2 = r.body.id;
    expect(V2).not.toBe(V1);

    const vecchia = await riga(V1), nuova = await riga(V2);
    expect(vecchia.result).toEqual(BLOCCHI);
    expect(vecchia.superato_da).toBe(V2);
    expect(nuova.result).toEqual(nuovo);
    expect(nuova.version).toBe(2);
    expect(nuova.superato_da).toBeNull();
    // stesso progetto e stesso proprietario; chi lavorava sulla vecchia lavora sulla nuova
    const p = (await db.execute<any>(sql`SELECT project_id::text AS p, owner_user_id::text AS o FROM service_program_scenarios WHERE id = ${V2}::uuid`)).rows[0];
    expect(p).toEqual({ p: SP, o: ADMIN });
    const membri = (await db.execute<any>(sql`SELECT user_id::text AS u FROM vehicle_schedule_members WHERE scenario_id = ${V2}::uuid`)).rows;
    expect(membri).toEqual([{ u: ALTRO }]);

    expect((await db.execute<any>(sql`SELECT service_program_scenario_id::text AS v FROM driver_shift_scenarios WHERE id = ${D1}::uuid`)).rows[0].v).toBe(V1);
    expect((await db.execute<any>(sql`SELECT DISTINCT vss_id::text AS v FROM roster_turni_pubblicati WHERE ps_project_id = ${P}::uuid`)).rows).toEqual([{ v: V1 }]);
  });

  it("una versione superata non si modifica", async () => {
    const r = await salva(V1, { result: { ...BLOCCHI, summary: { totalVehicles: 9 } } });
    expect(r.status).toBe(409);
    expect(r.body.supersededBy).toBe(V2);
  });

  it("l'anteprima della pubblicazione dice che i turni guida stanno su turni macchina superati", async () => {
    const c = (await candidatiDelleUdp([UDP])).get(UDP) ?? [];
    expect(c.find((x) => x.dssId === D1)?.turniMacchinaSuperati).toBe(true);
  });

  it("nel database: la coppia è coerente e un turno macchina pubblicato non si cancella", async () => {
    // turni guida di V1 col turno macchina V2: rifiutato
    let errore: any = null;
    try {
      await db.execute(sql`
        INSERT INTO roster_turni_pubblicati (day, udp_id, dss_id, vss_id, ps_project_id, pubblicazione_id, sostituita_da)
        SELECT '2031-03-05', ${UDP}::uuid, ${D1}::uuid, ${V2}::uuid, ${P}::uuid, id, id FROM roster_pubblicazioni WHERE ps_project_id = ${P}::uuid LIMIT 1`);
    } catch (e) { errore = e; }
    expect(codice(errore)).toBe("23503");
    // senza turno macchina: rifiutato
    errore = null;
    try {
      await db.execute(sql`
        INSERT INTO roster_turni_pubblicati (day, udp_id, dss_id, ps_project_id, pubblicazione_id, sostituita_da)
        SELECT '2031-03-05', ${UDP}::uuid, ${D1}::uuid, ${P}::uuid, id, id FROM roster_pubblicazioni WHERE ps_project_id = ${P}::uuid LIMIT 1`);
    } catch (e) { errore = e; }
    expect(codice(errore)).toBe("23502");
    // il turno macchina pubblicato non si cancella, nemmeno direttamente
    errore = null;
    try { await db.execute(sql`DELETE FROM service_program_scenarios WHERE id = ${V1}::uuid`); } catch (e) { errore = e; }
    expect(codice(errore)).toBe("23503");
  });

  it("cancellata la versione nuova, la vecchia torna la più recente", async () => {
    const r = await request(admin).delete(`/api/service-program/scenarios/${V2}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await riga(V1)).superato_da).toBeNull();
  });
});
