/**
 * La diagnosi di una giornata di esercizio (tappa 4), su un database vero
 * (TEST_DATABASE_URL; in CI come cerbero_app). Sola lettura.
 *
 * Un feed di Planning Studio in esercizio il 3/3/2031 (dallo storico delle
 * attivazioni), tre corse quel giorno (due feriali e una aggiunta solo quel
 * giorno, più una del sabato che non conta), una corsa senza geometria, due
 * corse con lo stesso numero, prove dell'AVM che si collegano una per id,
 * una per codice e una per numero, un viaggio dell'AVM che non si riconduce
 * a niente, e un giorno pubblicato che copre una corsa sola.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import adminRouter from "../routes/admin";
import { diagnosiDelGiorno } from "../lib/esercizio-diagnosi";
import { lunghezzaDellaGeometria } from "../lib/km-programmati";
import { appDiProva, utenteDiProva } from "./helpers/app-di-prova";

const u = (n: number) => `d4100000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ADMIN = u(1);
const [F, P, LINEA, PERCORSO] = [u(10), u(11), u(12), u(13)];
const [T1, T2, T3, T4] = [u(20), u(21), u(22), u(23)];
const [UDP, SP, VSS, DSS, PUB] = [u(30), u(31), u(32), u(33), u(34)];
const GIORNO = "2031-03-03"; // un lunedì
const CODICI = { [T1]: "689_CodUdp:D1639_362304", [T2]: "689_CodUdp:D1639_362305", [T3]: "690_CodUdp:D7_362304", [T4]: "689_CodUdp:S1_400001" };
const TRACCIATO = { type: "LineString", coordinates: [[13.5, 43.6], [13.5, 43.61]] };

const admin = appDiProva(adminRouter, utenteDiProva(ADMIN, [], "admin"));

describe.runIf(!!process.env.TEST_DATABASE_URL)("la diagnosi di una giornata di esercizio, sul database", () => {
  const pulisci = async () => {
    await db.execute(sql`DELETE FROM caronte.journey_codes WHERE day = ${GIORNO}::date AND journey_ref LIKE 'diagnosi-%'`);
    await db.execute(sql`DELETE FROM caronte.stop_transits WHERE stop_id = 'diagnosi-fermata'`);
    await db.execute(sql`DELETE FROM roster_turni_pubblicati WHERE pubblicazione_id = ${PUB}::uuid`);
    await db.execute(sql`DELETE FROM roster_pubblicazioni WHERE id = ${PUB}::uuid`);
    await db.execute(sql`DELETE FROM driver_shift_scenarios WHERE id = ${DSS}::uuid`);
    await db.execute(sql`DELETE FROM service_program_scenarios WHERE id = ${VSS}::uuid`);
    await db.execute(sql`DELETE FROM scheduling_projects WHERE id = ${SP}::uuid`);
    await db.execute(sql`DELETE FROM ps_activation_log WHERE feed_id = ${F}::uuid`);
    for (const t of ["gtfs_stop_times", "gtfs_trips", "gtfs_calendar_dates", "gtfs_calendar", "gtfs_routes", "gtfs_shapes"]) {
      await db.execute(sql`DELETE FROM ${sql.identifier(t)} WHERE feed_id = ${F}::uuid`);
    }
    await db.execute(sql`DELETE FROM gtfs_feeds WHERE id = ${F}::uuid`);
    await db.execute(sql`DELETE FROM ps_validity_units WHERE id = ${UDP}::uuid`);
    await db.execute(sql`DELETE FROM ps_trips WHERE project_id = ${P}::uuid`);
    await db.execute(sql`DELETE FROM ps_route_variants WHERE project_id = ${P}::uuid`);
    await db.execute(sql`DELETE FROM ps_routes WHERE project_id = ${P}::uuid`);
    await db.execute(sql`DELETE FROM ps_projects WHERE id = ${P}::uuid`);
    await db.execute(sql`DELETE FROM users WHERE id = ${ADMIN}::uuid`);
  };

  beforeAll(async () => {
    await pulisci();
    await db.execute(sql`INSERT INTO users (id, email, password_hash, role) VALUES (${ADMIN}::uuid, 'diagnosi@prova.local', 'x', 'admin')`);
    // il programma di Planning Studio: le corse hanno il codice stabile del file d'origine
    await db.execute(sql`INSERT INTO ps_projects (id, owner_user_id, name) VALUES (${P}::uuid, ${ADMIN}::uuid, 'Programma diagnosi 4.1')`);
    await db.execute(sql`INSERT INTO ps_routes (id, project_id, short_name) VALUES (${LINEA}::uuid, ${P}::uuid, '1')`);
    await db.execute(sql`INSERT INTO ps_route_variants (id, project_id, route_id, name) VALUES (${PERCORSO}::uuid, ${P}::uuid, ${LINEA}::uuid, 'Andata')`);
    for (const [id, codice] of Object.entries(CODICI)) {
      await db.execute(sql`INSERT INTO ps_trips (id, project_id, route_id, variant_id, codice) VALUES (${id}::uuid, ${P}::uuid, ${LINEA}::uuid, ${PERCORSO}::uuid, ${codice})`);
    }
    // il suo feed: trip_id = id della corsa, in esercizio dal 1° al 10 marzo
    await db.execute(sql`INSERT INTO gtfs_feeds (id, filename, is_active) VALUES (${F}::uuid, 'diagnosi-4.1.synthetic', false)`);
    await db.execute(sql`INSERT INTO ps_activation_log (project_id, feed_id, activated_at, deactivated_at, via)
                         VALUES (${P}::uuid, ${F}::uuid, '2031-03-01 10:00+01', '2031-03-10 10:00+01', 'prova')`);
    await db.execute(sql`INSERT INTO gtfs_routes (feed_id, route_id, route_short_name) VALUES (${F}::uuid, ${LINEA}, '1')`);
    await db.execute(sql`INSERT INTO gtfs_calendar (feed_id, service_id, monday, tuesday, wednesday, thursday, friday, saturday, sunday, start_date, end_date) VALUES
      (${F}::uuid, 'FER', 1, 1, 1, 1, 1, 0, 0, '20310301', '20310331'),
      (${F}::uuid, 'SAB', 0, 0, 0, 0, 0, 1, 0, '20310301', '20310331')`);
    await db.execute(sql`INSERT INTO gtfs_calendar_dates (feed_id, service_id, date, exception_type) VALUES
      (${F}::uuid, 'EXTRA', '20310303', 1), (${F}::uuid, 'FER', '20310304', 2)`);
    await db.execute(sql`INSERT INTO gtfs_trips (feed_id, trip_id, route_id, service_id, shape_id) VALUES
      (${F}::uuid, ${T1}, ${LINEA}, 'FER', 'S1'), (${F}::uuid, ${T2}, ${LINEA}, 'FER', 'S9'),
      (${F}::uuid, ${T3}, ${LINEA}, 'EXTRA', 'S1'), (${F}::uuid, ${T4}, ${LINEA}, 'SAB', 'S1')`);
    await db.execute(sql`INSERT INTO gtfs_stop_times (feed_id, trip_id, stop_id, stop_sequence, departure_time) VALUES
      (${F}::uuid, ${T1}, 'A', 1, '07:00:00'), (${F}::uuid, ${T2}, 'A', 1, '08:00:00'), (${F}::uuid, ${T3}, 'A', 1, '09:00:00')`);
    await db.execute(sql`INSERT INTO gtfs_shapes (feed_id, shape_id, geojson) VALUES (${F}::uuid, 'S1', ${JSON.stringify(TRACCIATO)}::jsonb)`);
    // le prove dell'AVM: T1 coi passaggi (id), T2 dalla coppia di codici (codice), un numero ambiguo, un viaggio estraneo
    await db.execute(sql`INSERT INTO caronte.stop_transits (trip_id, stop_id, actual_ts, source) VALUES
      (${T1}, 'diagnosi-fermata', '2031-03-03 07:02+01', 'siri')`);
    await db.execute(sql`INSERT INTO caronte.journey_codes (day, journey_ref, trip_id, matched_by, course_ref, line_ref, avm_departure) VALUES
      (${GIORNO}::date, 'diagnosi-1', ${CODICI[T2]}, 'id', '362305', '1', '08:00'),
      (${GIORNO}::date, 'diagnosi-2', '', NULL, '362304', '1', '07:00'),
      (${GIORNO}::date, 'diagnosi-3', '', NULL, '999999', '9', '10:15')`);
    // un giorno pubblicato: l'UDP contiene solo T1
    await db.execute(sql`INSERT INTO ps_validity_units (id, project_id, validity_id, name, trip_ids, representative_dates, day_count)
                         VALUES (${UDP}::uuid, ${P}::uuid, 'fer', 'Feriale', ${JSON.stringify([T1])}::jsonb, ${JSON.stringify([GIORNO])}::jsonb, 1)`);
    await db.execute(sql`INSERT INTO service_program_scenarios (id, name, date, input, result) VALUES (${VSS}::uuid, 'TM diagnosi', '20310303', '{}', '{}')`);
    await db.execute(sql`INSERT INTO driver_shift_scenarios (id, service_program_scenario_id, name, result) VALUES (${DSS}::uuid, ${VSS}::uuid, 'TG diagnosi', '{}')`);
    await db.execute(sql`INSERT INTO roster_pubblicazioni (id, tipo, ps_project_id, dal, al) VALUES (${PUB}::uuid, 'pubblica', ${P}::uuid, ${GIORNO}::date, ${GIORNO}::date)`);
    await db.execute(sql`INSERT INTO roster_turni_pubblicati (day, udp_id, dss_id, vss_id, ps_project_id, pubblicazione_id)
                         VALUES (${GIORNO}::date, ${UDP}::uuid, ${DSS}::uuid, ${VSS}::uuid, ${P}::uuid, ${PUB}::uuid)`);
  });
  afterAll(pulisci);

  it("programma e feed della giornata vengono dallo storico, non dal feed di oggi", async () => {
    const d = await diagnosiDelGiorno(GIORNO, null);
    expect(d.programma).toMatchObject({ feedId: F, progettoId: P, progetto: "Programma diagnosi 4.1", via: "prova" });
    // l'inizio della giornata è alle 03:00 ora italiana
    expect(d.inizio).toBe("2031-03-03T02:00:00.000Z");
    expect(d.fine).toBe("2031-03-04T02:00:00.000Z");
  });

  it("le corse del giorno: settimana nel periodo, più le aggiunte, senza il sabato", async () => {
    const d = await diagnosiDelGiorno(GIORNO, null);
    expect(d.corseProgrammate).toBe(3);
    expect(d.numeriRipetuti).toEqual({ quanti: 1, esempi: [{ numero: "362304", corse: 2, linee: ["1"] }] });
    // il 4 marzo il servizio feriale è tolto dal calendario e l'aggiunta non c'è: nessuna corsa, e lo dice
    const il4 = await diagnosiDelGiorno("2031-03-04", null);
    expect(il4.corseProgrammate).toBe(0);
    expect(il4.avvisi.join(" ")).toMatch(/non ha corse in questa giornata/);
  });

  it("il collegamento con le prove dell'AVM: per id, per codice, per numero (solo se unico nel giorno)", async () => {
    const d = await diagnosiDelGiorno(GIORNO, null);
    expect(d.collegamento).toMatchObject({ corse: 3, perId: 1, perCodice: 1, perNumero: 1, almenoUno: 2 });
    expect(d.collegamento.quota.almenoUno).toBe(66.7);
    expect(d.viaggiAvm).toMatchObject({ viaggi: 3, agganciati: 1, corseConPassaggi: 1, nonRiconducibili: 1 });
    expect(d.viaggiAvm.esempi).toEqual([{ linea: "9", partenza: "10:15", numero: "999999" }]);
  });

  it("geometria e km del giorno", async () => {
    const d = await diagnosiDelGiorno(GIORNO, null);
    expect(d.geometria.senzaGeometria).toBe(1);
    expect(d.geometria.esempi[0]).toMatchObject({ trip: CODICI[T2], partenza: "08:00:00" });
    expect(d.geometria.kmGiorno).toBe(Math.round((2 * lunghezzaDellaGeometria(TRACCIATO)) / 100) / 10);
  });

  it("i turni pubblicati del giorno: del programma giusto, e le corse rimaste fuori dalle UDP", async () => {
    const d = await diagnosiDelGiorno(GIORNO, null);
    expect(d.turni).toMatchObject({ pubblicato: true, udp: 1, altroProgramma: 0, turniGuidaSuperati: 0, turniMacchinaSuperati: 0, corseFuoriDalleUdp: 2 });
    expect((await diagnosiDelGiorno("2031-03-04", null)).turni).toEqual({ pubblicato: false });
  });

  it("un giorno senza programma nello storico si conta sul feed dell'AVM, e lo dice", async () => {
    const d = await diagnosiDelGiorno("2031-03-20", F);
    expect(d.programma).toBeNull();
    expect(d.feedAvm).toMatchObject({ feedId: F, file: "diagnosi-4.1.synthetic", ugualeAlProgramma: null });
    expect(d.avvisi.join(" ")).toMatch(/nessun programma era in esercizio/);
    expect(d.corseProgrammate).toBe(2); // giovedì 20: le due feriali
  });

  it("dall'API: solo l'amministratore, con una data vera", async () => {
    const r = await request(admin).get(`/api/admin/esercizio/diagnosi?giorno=${GIORNO}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.corseProgrammate).toBe(3);
    expect((await request(admin).get("/api/admin/esercizio/diagnosi?giorno=2031-02-30")).status).toBe(400);
    const pian = appDiProva(adminRouter, utenteDiProva(ADMIN, [], "user", { ruoli: ["pianificatore"] }));
    expect((await request(pian).get(`/api/admin/esercizio/diagnosi?giorno=${GIORNO}`)).status).toBe(403);
  });
});
