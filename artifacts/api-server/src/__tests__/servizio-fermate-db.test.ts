/**
 * Il servizio delle fermate di un feed, calcolato sul database (tappa 7.26):
 * le regole del caricamento di un GTFS (una corsa una volta per fermata, col
 * primo passaggio; punte 7–9 e 17–19; punteggio 0–100), e il recupero delle
 * pulizie per i feed nati da Planning Studio senza questi numeri.
 * Sul database: TEST_DATABASE_URL (in CI come cerbero_app).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db, pool } from "@workspace/db";
import { sql } from "drizzle-orm";
import { contaServizioFermate, feedSenzaServizio } from "../lib/materializzazione/servizio-fermate";
import { recuperaServizioFermate } from "../lib/lavori/pulizie";

const F = "5e7c0000-0000-4000-8000-000000000001";
const log = { righe: [] as any[], info(...a: any[]) { this.righe.push(a); }, warn() {}, error() {} };

async function pulisci() {
  for (const t of ["gtfs_stop_times", "gtfs_stops"]) {
    await db.execute(sql`DELETE FROM ${sql.identifier(t)} WHERE feed_id = ${F}::uuid`);
  }
  await db.execute(sql`DELETE FROM gtfs_feeds WHERE id = ${F}::uuid`);
}

async function fermate() {
  const r = await db.execute(sql`
    SELECT stop_id, trips_count, morning_peak_trips, evening_peak_trips, service_score
      FROM gtfs_stops WHERE feed_id = ${F}::uuid ORDER BY stop_id`);
  return (r.rows as any[]).map(x => [x.stop_id, x.trips_count, x.morning_peak_trips, x.evening_peak_trips, Number(x.service_score)]);
}

describe.runIf(!!process.env.TEST_DATABASE_URL)("il servizio delle fermate di un feed", () => {
  beforeAll(async () => {
    await pulisci();
    await db.execute(sql`INSERT INTO gtfs_feeds (id, filename, is_active, uploaded_at) VALUES (${F}::uuid, 'svz-prova.synthetic', false, '2001-01-01T00:00:00Z')`);
    await db.execute(sql`INSERT INTO gtfs_stops (feed_id, stop_id, stop_name, stop_lat, stop_lon) VALUES
      (${F}::uuid, 'P1', 'uno', 40 + 1 / 1000.0, 10 + 1 / 1000.0),
      (${F}::uuid, 'P2', 'due', 40 + 2 / 1000.0, 10 + 2 / 1000.0),
      (${F}::uuid, 'P3', 'tre', 40 + 3 / 1000.0, 10 + 3 / 1000.0)`);
    // C1 passa da P1 due volte (07:30 e, prima del capolinea, 09:30): conta una volta, col primo passaggio.
    // C2 a P1 ha solo l'arrivo (17:30); a P2 nessun orario, quindi non conta.
    await db.execute(sql`INSERT INTO gtfs_stop_times (feed_id, trip_id, stop_id, stop_sequence, departure_time, arrival_time) VALUES
      (${F}::uuid, 'C1', 'P1', 1, '07:30:00', '07:30:00'),
      (${F}::uuid, 'C1', 'P2', 2, '08:00:00', '08:00:00'),
      (${F}::uuid, 'C1', 'P1', 3, '09:30:00', '09:30:00'),
      (${F}::uuid, 'C2', 'P1', 1, NULL, '17:30:00'),
      (${F}::uuid, 'C2', 'P2', 2, NULL, NULL)`);
  });
  afterAll(pulisci);

  it("il recupero trova il feed con gli orari e le fermate a zero", async () => {
    expect(await feedSenzaServizio(pool, 5, { feedIds: [F] })).toEqual([F]);
  });

  it("corse, punte e punteggio con le regole del caricamento di un GTFS", async () => {
    expect(await contaServizioFermate(pool, F)).toBe(3);
    // massimo 2 corse per fermata. P1: 50 + 25/6 + 25/6 = 58,3; P2: 50 + 25/6 = 54,2; P3 senza corse.
    expect(await fermate()).toEqual([
      ["P1", 2, 1, 1, 58.3],
      ["P2", 1, 1, 0, 54.2],
      ["P3", 0, 0, 0, 0],
    ]);
  });

  it("le pulizie lo calcolano una volta sola", async () => {
    await db.execute(sql`UPDATE gtfs_stops SET trips_count = 0, morning_peak_trips = 0, evening_peak_trips = 0, service_score = 0 WHERE feed_id = ${F}::uuid`);
    const c = await pool.connect();
    try {
      expect(await recuperaServizioFermate(c, log, 5, { feedIds: [F] })).toEqual([F]);
      expect((await fermate())[0]).toEqual(["P1", 2, 1, 1, 58.3]);
      // la volta dopo il feed ha i suoi numeri: niente da fare
      expect(await recuperaServizioFermate(c, log, 5, { feedIds: [F] })).toEqual([]);
    } finally {
      c.release();
    }
    expect(log.righe.some(r => r[0]?.feedId === F && r[0]?.fermate === 3)).toBe(true);
  });
});
