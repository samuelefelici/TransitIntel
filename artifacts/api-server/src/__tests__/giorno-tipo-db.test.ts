/**
 * Le corse di un giorno tipo e le linee per fermata (tappa 7.31), sul database
 * (TEST_DATABASE_URL; in CI come cerbero_app). La pagina Fermate & Linee
 * mostrava come «corse al giorno» tutte le corse del feed e come «linee per
 * fermata» la media dei 50 nodi più grandi.
 *
 * Il feed di prova, gennaio 2001 (il 1° è un lunedì):
 * - FER, dal lunedì al venerdì, 4 corse della linea L1; il 3 gennaio no (eccezione);
 * - SAB, i sabati, aggiunti solo da calendar_dates: 2 corse della linea L2;
 * - EXTRA, solo il 10 gennaio (un mercoledì): 6 corse della linea L2;
 * - ESTATE, da luglio ad agosto, ogni giorno: 9 corse, che non sono di gennaio
 *   e quindi non contano nelle corse di gennaio, ma stanno nel totale del feed.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import gtfsQueriesRouter from "../routes/gtfs-queries";
import { corseNelGiornoTipo, lineePerFermata } from "../lib/gtfs-giorno-tipo";
import { appDiProva, utenteDiProva } from "./helpers/app-di-prova";

const F = "7c310000-0000-4000-8000-000000000001";
const ADMIN = "7c310000-0000-4000-8000-0000000000ad";

async function pulisci() {
  for (const t of ["gtfs_stop_times", "gtfs_trips", "gtfs_stops", "gtfs_routes", "gtfs_calendar", "gtfs_calendar_dates"]) {
    await db.execute(sql`DELETE FROM ${sql.identifier(t)} WHERE feed_id = ${F}::uuid`);
  }
  await db.execute(sql`DELETE FROM gtfs_feeds WHERE id = ${F}::uuid`);
}

describe("lineePerFermata", () => {
  it("la media delle linee diverse per fermata servita, a un decimale", () => {
    const linee = new Map([["a", "L1"], ["b", "L1"], ["c", "L2"]]);
    expect(lineePerFermata([
      { trip_id: "a", stop_id: "P1" }, { trip_id: "b", stop_id: "P1" }, { trip_id: "c", stop_id: "P1" },
      { trip_id: "a", stop_id: "P2" }, { trip_id: "b", stop_id: "P2" },
      { trip_id: "c", stop_id: "P3" },
      { trip_id: "sconosciuta", stop_id: "P4" },
    ], linee)).toBe(1.3);
    expect(lineePerFermata([], linee)).toBeNull();
  });
});

describe.runIf(!!process.env.TEST_DATABASE_URL)("le corse di un giorno tipo, sul database", () => {
  beforeAll(async () => {
    await pulisci();
    await db.execute(sql`INSERT INTO gtfs_feeds (id, filename, is_active, uploaded_at) VALUES (${F}::uuid, 'giorno-tipo.zip', false, '2001-01-01T00:00:00Z')`);
    await db.execute(sql`INSERT INTO gtfs_routes (feed_id, route_id, route_short_name) VALUES (${F}::uuid, 'L1', '1'), (${F}::uuid, 'L2', '2')`);
    await db.execute(sql`INSERT INTO gtfs_stops (feed_id, stop_id, stop_name, stop_lat, stop_lon) VALUES
      (${F}::uuid, 'P1', 'Uno', 41 + 1 / 1000.0, 12 + 1 / 1000.0), (${F}::uuid, 'P2', 'Due', 41 + 2 / 1000.0, 12 + 2 / 1000.0)`);
    await db.execute(sql`INSERT INTO gtfs_calendar (feed_id, service_id, monday, tuesday, wednesday, thursday, friday, saturday, sunday, start_date, end_date) VALUES
      (${F}::uuid, 'FER', 1, 1, 1, 1, 1, 0, 0, '20010101', '20010131'),
      (${F}::uuid, 'ESTATE', 1, 1, 1, 1, 1, 1, 1, '20010701', '20010831')`);
    await db.execute(sql`INSERT INTO gtfs_calendar_dates (feed_id, service_id, date, exception_type) VALUES
      (${F}::uuid, 'FER', '20010103', 2),
      (${F}::uuid, 'SAB', '20010106', 1), (${F}::uuid, 'SAB', '20010113', 1), (${F}::uuid, 'SAB', '20010120', 1), (${F}::uuid, 'SAB', '20010127', 1),
      (${F}::uuid, 'EXTRA', '20010110', 1)`);
    const corse: Array<[string, string, string]> = [];
    for (let i = 0; i < 4; i++) corse.push([`F${i}`, "L1", "FER"]);
    for (let i = 0; i < 2; i++) corse.push([`S${i}`, "L2", "SAB"]);
    for (let i = 0; i < 6; i++) corse.push([`X${i}`, "L2", "EXTRA"]);
    for (let i = 0; i < 9; i++) corse.push([`E${i}`, "L1", "ESTATE"]);
    for (const [trip, route, servizio] of corse) {
      await db.execute(sql`INSERT INTO gtfs_trips (feed_id, trip_id, route_id, service_id) VALUES (${F}::uuid, ${trip}, ${route}, ${servizio})`);
      await db.execute(sql`INSERT INTO gtfs_stop_times (feed_id, trip_id, stop_id, stop_sequence, arrival_time, departure_time) VALUES
        (${F}::uuid, ${trip}, 'P1', 1, '07:00:00', '07:00:00'),
        (${F}::uuid, ${trip}, ${route === "L1" ? "P2" : "P1"}, 2, '07:30:00', '07:30:00')`);
    }
  });
  afterAll(pulisci);

  it("mediana dei feriali, dei sabati e delle domeniche del periodo del feed", async () => {
    // feriali: a gennaio 4 corse (il 3 nessuna, il 10 4 + 6), a luglio e agosto 9: la mediana è 9
    // sabati: a gennaio 2, d'estate 9: la mediana dei 4 di gennaio e dei 9 estivi è 9
    // domeniche: solo d'estate, 9
    expect(await corseNelGiornoTipo(F)).toEqual({ feriale: 9, sabato: 9, festivo: 9 });
  });

  it("senza l'estate: 4 corse in un feriale, un giorno con più corse o senza corse non sposta la mediana", async () => {
    await db.execute(sql`DELETE FROM gtfs_calendar WHERE feed_id = ${F}::uuid AND service_id = 'ESTATE'`);
    try {
      expect(await corseNelGiornoTipo(F)).toEqual({ feriale: 4, sabato: 2, festivo: null });
    } finally {
      await db.execute(sql`INSERT INTO gtfs_calendar (feed_id, service_id, monday, tuesday, wednesday, thursday, friday, saturday, sunday, start_date, end_date)
        VALUES (${F}::uuid, 'ESTATE', 1, 1, 1, 1, 1, 1, 1, '20010701', '20010831')`);
    }
  });

  it("il riepilogo del feed le dice, accanto al totale delle corse", async () => {
    const admin = request(appDiProva(gtfsQueriesRouter, utenteDiProva(ADMIN, [], "admin")));
    const r = await admin.get(`/api/gtfs/summary?feedId=${F}`);
    expect(r.status).toBe(200);
    expect(r.body.totalTrips).toBe(21);
    expect(r.body.corseGiornoTipo).toEqual({ feriale: 9, sabato: 9, festivo: 9 });
    // P1: linee L1 e L2; P2: solo L1
    expect(r.body.lineePerFermata).toBe(1.5);
    // un feed che non c'è: 404, come le altre letture del GTFS
    expect((await admin.get("/api/gtfs/summary?feedId=7c310000-0000-4000-8000-00000000ffff")).status).toBe(404);
  });
});
