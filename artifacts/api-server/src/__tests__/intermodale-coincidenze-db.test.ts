/**
 * Le coincidenze dei turni con le altre linee nell'analisi intermodale
 * (POST /intermodal-optimizer/analyze), sul database (TEST_DATABASE_URL; in
 * CI come cerbero_app). La tappa 7.27 ha riscritto il modo di cercarle (orari
 * per fermata, capolinea per coordinate, una query sola per orari e corse,
 * gruppi con una coincidenza ottima calcolati una volta): sulla copia di
 * produzione da 160 s a meno di 5, con le stesse coincidenze. Qui si fissano
 * le regole su un feed piccolo.
 *
 * Il turno T1 ha due corse della linea LN:
 * - N1 arriva al capolinea P1 alle 07:30;
 * - N2 riparte da P1 alle 08:20.
 * A P2, a circa 140 m da P1, passa la linea LA: A1 alle 07:40, A2 alle 07:55,
 * e A3 alle 07:45, ma solo il sabato. La richiesta è per un martedì.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import routerOttimizzatore from "../routes/intermodal-optimizer";
import { appDiProva, utenteDiProva } from "./helpers/app-di-prova";

const F = "1c7c0000-0000-4000-8000-000000000001";
const ADMIN = "1c7c0000-0000-4000-8000-0000000000ad";
const app = appDiProva(routerOttimizzatore, utenteDiProva(ADMIN, [], "admin"));

async function pulisci() {
  for (const t of ["gtfs_stop_times", "gtfs_trips", "gtfs_stops", "gtfs_routes", "gtfs_calendar"]) {
    await db.execute(sql`DELETE FROM ${sql.identifier(t)} WHERE feed_id = ${F}::uuid`);
  }
  await db.execute(sql`DELETE FROM gtfs_feeds WHERE id = ${F}::uuid`);
}

const corsa = (tripId: string, partenza: number, arrivo: number) => ({
  type: "trip", tripId, routeId: "LN", routeName: "N",
  departureMin: partenza, arrivalMin: arrivo,
  departureTime: `${String(Math.floor(partenza / 60)).padStart(2, "0")}:${String(partenza % 60).padStart(2, "0")}:00`,
  arrivalTime: `${String(Math.floor(arrivo / 60)).padStart(2, "0")}:${String(arrivo % 60).padStart(2, "0")}:00`,
});
const corpo = {
  feedId: F,
  date: "2001-01-02",
  syncSchedules: false,
  includeOtherBusRoutes: true,
  shifts: [{ vehicleId: "T1", vehicleType: "12m", trips: [corsa("N1", 420, 450), corsa("N2", 500, 530)] }],
};

describe.runIf(!!process.env.TEST_DATABASE_URL)("analisi intermodale: le coincidenze con le altre linee", () => {
  beforeAll(async () => {
    await pulisci();
    await db.execute(sql`INSERT INTO gtfs_feeds (id, filename, is_active, uploaded_at) VALUES (${F}::uuid, 'coincidenze-prova.zip', false, '2001-01-01T00:00:00Z')`);
    // P1 e P2 vicine; Q e R lontane (oltre 10 km), dove non c'è niente da prendere
    await db.execute(sql`INSERT INTO gtfs_stops (feed_id, stop_id, stop_name, stop_lat, stop_lon) VALUES
      (${F}::uuid, 'P1', 'Capolinea uno', 41 + 1 / 1000.0, 12 + 1 / 1000.0),
      (${F}::uuid, 'P2', 'Fermata vicina', 41 + 2 / 1000.0, 12 + 2 / 1000.0),
      (${F}::uuid, 'Q', 'Capolinea lontano', 41 + 100 / 1000.0, 12 + 1 / 1000.0),
      (${F}::uuid, 'R', 'Altro lontano', 41 + 1 / 1000.0, 12 + 200 / 1000.0)`);
    await db.execute(sql`INSERT INTO gtfs_routes (feed_id, route_id, route_short_name) VALUES
      (${F}::uuid, 'LN', 'N'), (${F}::uuid, 'LA', 'A')`);
    await db.execute(sql`INSERT INTO gtfs_calendar (feed_id, service_id, monday, tuesday, wednesday, thursday, friday, saturday, sunday, start_date, end_date) VALUES
      (${F}::uuid, 'FER', 1, 1, 1, 1, 1, 0, 0, '20010101', '20011231'),
      (${F}::uuid, 'SAB', 0, 0, 0, 0, 0, 1, 0, '20010101', '20011231')`);
    await db.execute(sql`INSERT INTO gtfs_trips (feed_id, trip_id, route_id, service_id, trip_headsign) VALUES
      (${F}::uuid, 'N1', 'LN', 'FER', 'Uno'), (${F}::uuid, 'N2', 'LN', 'FER', 'Lontano'),
      (${F}::uuid, 'A1', 'LA', 'FER', 'Altro'), (${F}::uuid, 'A2', 'LA', 'FER', 'Altro'),
      (${F}::uuid, 'A3', 'LA', 'SAB', 'Altro')`);
    await db.execute(sql`INSERT INTO gtfs_stop_times (feed_id, trip_id, stop_id, stop_sequence, arrival_time, departure_time) VALUES
      (${F}::uuid, 'N1', 'Q', 1, '07:00:00', '07:00:00'), (${F}::uuid, 'N1', 'P1', 2, '07:30:00', '07:30:00'),
      (${F}::uuid, 'N2', 'P1', 1, '08:20:00', '08:20:00'), (${F}::uuid, 'N2', 'Q', 2, '08:50:00', '08:50:00'),
      (${F}::uuid, 'A1', 'P2', 1, '07:40:00', '07:40:00'), (${F}::uuid, 'A1', 'R', 2, '08:10:00', '08:10:00'),
      (${F}::uuid, 'A2', 'P2', 1, '07:55:00', '07:55:00'), (${F}::uuid, 'A2', 'R', 2, '08:25:00', '08:25:00'),
      (${F}::uuid, 'A3', 'P2', 1, '07:45:00', '07:45:00'), (${F}::uuid, 'A3', 'R', 2, '08:15:00', '08:15:00')`);
  });
  afterAll(pulisci);

  it("le altre linee alla fermata vicina: in arrivo e in partenza, solo i servizi del giorno", async () => {
    const r = await request(app).post("/api/intermodal-optimizer/analyze").send(corpo);
    expect(r.status, JSON.stringify(r.body).slice(0, 500)).toBe(200);
    const altre = (r.body.coincidences as any[]).filter(c => c.hubType === "bus_other");
    const viste = altre.map(c => `${c.tripId} ${c.mode} ${c.trainTime} ${c.status}`).sort();
    // N1 arriva alle 07:30 e a piedi servono circa 2 minuti: A1 alle 07:40 è ottima, A2 alle 07:55 lunga.
    // N2 parte alle 08:20: chi scende da A1 aspetta 38 minuti, da A2 23, tutte e due lunghe.
    // A3 è solo del sabato; la linea LN, quella dei turni, non conta mai.
    expect(viste).toEqual([
      "N1 arrive_at_hub 07:40 optimal",
      "N1 arrive_at_hub 07:55 long",
      "N2 depart_from_hub 07:40 long",
      "N2 depart_from_hub 07:55 long",
    ]);
    for (const c of altre) expect(c.hubId).toBe("bus:P2");
    expect(r.body.metrics.busExtraConnections).toBe(4);
  });

  it("l'attesa lunga si segnala solo se la corsa non ha anche una coincidenza ottima allo stesso posto", async () => {
    const r = await request(app).post("/api/intermodal-optimizer/analyze").send(corpo);
    const lunghe = (r.body.advisories as any[]).filter(a => a.title.startsWith("Lunga attesa"));
    expect(lunghe.map(a => a.tripId)).toEqual(["N2"]);
    // la proposta riduce l'attesa più corta (23 minuti) a 5
    expect(lunghe[0].description).toContain("07:55");
  });
});
