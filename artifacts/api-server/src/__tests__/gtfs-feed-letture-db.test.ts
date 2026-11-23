/**
 * Le analisi del GTFS leggono un feed solo (tappa 7.24), sul database
 * (TEST_DATABASE_URL; in CI come cerbero_app). Due feed con gli stessi codici
 * di linee, fermate e corse, come le versioni di un programma: prima le query
 * li univano solo per codice, così ogni riga si moltiplicava per il numero di
 * feed e le linee di un programma finivano nell'analisi dell'altro. Ora ogni
 * rotta legge solo il feed chiesto (o quello corrente di chi chiede).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import gtfsAnalysisRouter from "../routes/gtfs-analysis";
import gtfsTravelRouter from "../routes/gtfs-travel";
import analysisRouter from "../routes/analysis";
import { appDiProva, utenteDiProva } from "./helpers/app-di-prova";

const u = (n: number) => `e7c00000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [ADMIN, A, B] = [u(1), u(2), u(3)];
const tutte = Router();
tutte.use(gtfsAnalysisRouter);
tutte.use(gtfsTravelRouter);
tutte.use(analysisRouter);
const admin = request(appDiProva(tutte, utenteDiProva(ADMIN, [], "admin")));

/** Un feed: due linee che condividono quattro fermate, due corse per linea. In B in più una linea e una fermata. */
async function feed(id: string, nome: string, extra: boolean) {
  await db.execute(sql`INSERT INTO gtfs_feeds (id, filename, is_active, uploaded_at) VALUES (${id}::uuid, ${nome}, false, '2001-01-01T00:00:00Z')`);
  await db.execute(sql`INSERT INTO gtfs_routes (feed_id, route_id, route_short_name) VALUES
    (${id}::uuid, 'L1', ${`${nome}-1`}), (${id}::uuid, 'L2', ${`${nome}-2`})`);
  await db.execute(sql`INSERT INTO gtfs_stops (feed_id, stop_id, stop_name, stop_lat, stop_lon) VALUES
    (${id}::uuid, 'P1', ${`${nome} uno`}, 40 + 1 / 1000.0, 10 + 1 / 1000.0),
    (${id}::uuid, 'P2', ${`${nome} due`}, 40 + 2 / 1000.0, 10 + 2 / 1000.0),
    (${id}::uuid, 'P3', ${`${nome} tre`}, 40 + 3 / 1000.0, 10 + 3 / 1000.0),
    (${id}::uuid, 'P4', ${`${nome} quattro`}, 40 + 4 / 1000.0, 10 + 4 / 1000.0)`);
  await db.execute(sql`INSERT INTO gtfs_trips (feed_id, trip_id, route_id, service_id) VALUES
    (${id}::uuid, 'C11', 'L1', 'FER'), (${id}::uuid, 'C12', 'L1', 'FER'),
    (${id}::uuid, 'C21', 'L2', 'FER'), (${id}::uuid, 'C22', 'L2', 'FER')`);
  for (const [corsa, ora] of [["C11", 7], ["C12", 8], ["C21", 7], ["C22", 9]] as const) {
    await db.execute(sql`INSERT INTO gtfs_stop_times (feed_id, trip_id, stop_id, stop_sequence, departure_time) VALUES
      (${id}::uuid, ${corsa}, 'P1', 1, ${`0${ora}:00:00`}), (${id}::uuid, ${corsa}, 'P2', 2, ${`0${ora}:05:00`}),
      (${id}::uuid, ${corsa}, 'P3', 3, ${`0${ora}:10:00`}), (${id}::uuid, ${corsa}, 'P4', 4, ${`0${ora}:15:00`})`);
  }
  if (extra) {
    await db.execute(sql`INSERT INTO gtfs_routes (feed_id, route_id, route_short_name) VALUES (${id}::uuid, 'L9', 'solo-B')`);
    await db.execute(sql`INSERT INTO gtfs_stops (feed_id, stop_id, stop_name, stop_lat, stop_lon) VALUES
      (${id}::uuid, 'P9', 'solo B', 40 + 9 / 1000.0, 10 + 9 / 1000.0)`);
    await db.execute(sql`INSERT INTO gtfs_trips (feed_id, trip_id, route_id, service_id) VALUES (${id}::uuid, 'C91', 'L9', 'FER')`);
    await db.execute(sql`INSERT INTO gtfs_stop_times (feed_id, trip_id, stop_id, stop_sequence, departure_time) VALUES
      (${id}::uuid, 'C91', 'P1', 1, '10:00:00'), (${id}::uuid, 'C91', 'P9', 2, '10:10:00')`);
  }
}

async function pulisci() {
  for (const t of ["gtfs_stop_times", "gtfs_trips", "gtfs_stops", "gtfs_routes"]) {
    await db.execute(sql`DELETE FROM ${sql.identifier(t)} WHERE feed_id IN (${A}::uuid, ${B}::uuid)`);
  }
  await db.execute(sql`DELETE FROM gtfs_feeds WHERE id IN (${A}::uuid, ${B}::uuid)`);
}

describe.runIf(!!process.env.TEST_DATABASE_URL)("le analisi del GTFS leggono un feed solo", () => {
  beforeAll(async () => {
    await pulisci();
    await feed(A, "A", false);
    await feed(B, "B", true);
  });
  afterAll(pulisci);

  it("analisi di rete: le linee del feed chiesto, una volta ciascuna, con le loro fermate", async () => {
    const r = await admin.get(`/api/gtfs/routes/network-analysis?feedId=${A}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.routes.map((x: any) => x.shortName).sort()).toEqual(["A-1", "A-2"]);
    for (const x of r.body.routes) expect(x.uniqueStops).toBe(4);
    // le due linee condividono le quattro fermate: una coppia sola, non una per feed
    expect(r.body.kpis.totalPairs).toBe(1);
    expect(r.body.overlaps[0].sharedSample.every((n: string) => n.startsWith("A "))).toBe(true);
    // col feed B c'è anche la sua linea in più
    const b = await admin.get(`/api/gtfs/routes/network-analysis?feedId=${B}`);
    expect(b.body.routes.map((x: any) => x.shortName).sort()).toEqual(["B-1", "B-2", "solo-B"]);
  });

  it("analisi di rete: un giorno senza servizi non ha collisioni né frequenze", async () => {
    const r = await admin.get(`/api/gtfs/routes/network-analysis?feedId=${A}&day=saturday`);
    expect(r.status).toBe(200);
    expect(r.body.kpis.scheduleCollisions).toBe(0);
    expect(r.body.headways).toEqual([]);
  });

  it("elenco e dettaglio delle fermate: solo quelle del feed chiesto", async () => {
    const r = await admin.get(`/api/gtfs/stops/directory?feedId=${A}`);
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(4);
    expect(r.body.stops.map((s: any) => s.name).sort()).toEqual(["A due", "A quattro", "A tre", "A uno"]);
    expect(r.body.stops.find((s: any) => s.stopId === "P1").routeIds).toEqual(["L1", "L2"]);
    const d = await admin.get(`/api/gtfs/stops/P1/detail?feedId=${A}`);
    expect(d.status).toBe(200);
    expect(JSON.stringify(d.body)).not.toContain("solo-B");
    expect(JSON.stringify(d.body)).toContain("A-1");
    // la fermata che c'è solo in B, chiesta su A: non trovata
    expect((await admin.get(`/api/gtfs/stops/P9/detail?feedId=${A}`)).status).toBe(404);
  });

  it("segmenti: fermate e partenze del feed chiesto, non la somma dei feed", async () => {
    const r = await admin.get(`/api/analysis/segments?feedId=${A}`);
    expect(r.status).toBe(200);
    expect(r.body.summary.totalStops).toBe(4);
    expect(r.body.summary.totalDailyDepartures).toBe(16);
  });

  it("un feed che chi chiede non vede: 404, come le altre letture", async () => {
    const utente = request(appDiProva(tutte, utenteDiProva(u(9), ["analytics"], "user")));
    expect((await utente.get(`/api/gtfs/routes/network-analysis?feedId=${A}`)).status).toBe(404);
    expect((await utente.get(`/api/gtfs/stops/directory?feedId=${A}`)).status).toBe(404);
  });
});
