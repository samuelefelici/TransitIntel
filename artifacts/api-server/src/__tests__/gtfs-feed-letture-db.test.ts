/**
 * Le analisi del GTFS leggono un feed solo (tappe 7.24 e 7.25), sul database
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
import gtfsQueriesRouter from "../routes/gtfs-queries";
import coincidenceZonesRouter, { orariDellaZona } from "../routes/coincidence-zones";
import planningRouter from "../routes/planning";
import { tenantWhere } from "../lib/tenant";
import { appDiProva, utenteDiProva } from "./helpers/app-di-prova";

const u = (n: number) => `e7c00000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [ADMIN, A, B, ZONA] = [u(1), u(2), u(3), u(4)];
const tutte = Router();
tutte.use(gtfsAnalysisRouter);
tutte.use(gtfsTravelRouter);
tutte.use(analysisRouter);
tutte.use(gtfsQueriesRouter);
tutte.use(coincidenceZonesRouter);
tutte.use(planningRouter);
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
  await db.execute(sql`INSERT INTO gtfs_calendar (feed_id, service_id, monday, tuesday, wednesday, thursday, friday, start_date, end_date)
    VALUES (${id}::uuid, 'FER', 1, 1, 1, 1, 1, '20010101', '20011231')`);
  await db.execute(sql`INSERT INTO gtfs_shapes (feed_id, shape_id, route_id, geojson) VALUES
    (${id}::uuid, 'F1', 'L1', ${JSON.stringify({ type: "LineString", coordinates: [] })}::jsonb)`);
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
  await db.execute(sql`DELETE FROM coincidence_zones WHERE id = ${ZONA}::uuid`);
  for (const t of ["gtfs_stop_times", "gtfs_trips", "gtfs_stops", "gtfs_routes", "gtfs_shapes", "gtfs_calendar"]) {
    await db.execute(sql`DELETE FROM ${sql.identifier(t)} WHERE feed_id IN (${A}::uuid, ${B}::uuid)`);
  }
  await db.execute(sql`DELETE FROM gtfs_feeds WHERE id IN (${A}::uuid, ${B}::uuid)`);
}

describe.runIf(!!process.env.TEST_DATABASE_URL)("le analisi del GTFS leggono un feed solo", () => {
  beforeAll(async () => {
    await pulisci();
    await feed(A, "A", false);
    await feed(B, "B", true);
    // una zona di coincidenza attorno alla fermata P1 (c'è nei due feed)
    await db.execute(sql`INSERT INTO coincidence_zones (id, name, hub_id, hub_name, hub_type, hub_lat, hub_lng)
      VALUES (${ZONA}::uuid, 'zona di prova', 'nodo-prova', 'nodo di prova', 'railway', 40 + 1 / 1000.0, 10 + 1 / 1000.0)`);
    await db.execute(sql`INSERT INTO coincidence_zone_stops (zone_id, gtfs_stop_id, stop_name, stop_lat, stop_lon)
      VALUES (${ZONA}::uuid, 'P1', 'uno', 40 + 1 / 1000.0, 10 + 1 / 1000.0)`);
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

  it("fermate e forme della mappa: solo quelle del feed chiesto (7.25)", async () => {
    const r = await admin.get(`/api/gtfs/stops?feedId=${A}`);
    expect(r.status).toBe(200);
    expect(r.body.data.map((s: any) => s.stopName).sort()).toEqual(["A due", "A quattro", "A tre", "A uno"]);
    // con le linee: le fermate servite, del solo feed chiesto
    const l = await admin.get(`/api/gtfs/stops?feedId=${B}&routeIds=L9`);
    expect(l.body.data.map((s: any) => s.stopName).sort()).toEqual(["B uno", "solo B"]);
    const f = await admin.get(`/api/gtfs/shapes?feedId=${A}`);
    expect(f.status).toBe(200);
    expect(f.body.data.map((x: any) => x.feedId)).toEqual([A]);
  });

  it("linee di una zona di coincidenza: del feed chiesto, una volta ciascuna (7.25)", async () => {
    const r = await admin.get(`/api/coincidence-zones/${ZONA}/bus-lines?feedId=${A}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.busLines.map((x: any) => x.routeShortName).sort()).toEqual(["A-1", "A-2"]);
    const l1 = r.body.busLines.find((x: any) => x.routeShortName === "A-1");
    expect(l1.times).toEqual(["07:00:00", "08:00:00"]);
    const b = await admin.get(`/api/coincidence-zones/${ZONA}/bus-lines?feedId=${B}`);
    expect(b.body.busLines.map((x: any) => x.routeShortName).sort()).toEqual(["B-1", "B-2", "solo-B"]);
  });

  it("orari di una zona: la rotta e il programma generato leggono gli stessi (7.25)", async () => {
    const orari = { arrivals: [{ label: "dal nord", times: ["07:42"] }], departures: [{ label: "verso sud", times: ["08:10"] }] };
    await db.execute(sql`UPDATE coincidence_zones SET schedules = ${JSON.stringify(orari)}::jsonb WHERE id = ${ZONA}::uuid`);
    const r = await admin.get(`/api/coincidence-zones/${ZONA}/schedules`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ...orari, source: "custom", hubType: "railway", platformWalkMinutes: 5 });
    // prima il programma li chiedeva alla rotta via HTTP senza credenziali, e non li riceveva mai
    const [zona] = (await db.execute(sql`SELECT id, hub_id AS "hubId", schedules FROM coincidence_zones WHERE id = ${ZONA}::uuid`)).rows as any[];
    expect(await orariDellaZona(zona)).toEqual({ ...orari, source: "custom" });
  });

  it("Planning Studio sui feed: un feed che chi chiede non vede è un 404 (7.25)", async () => {
    const utente = request(appDiProva(tutte, utenteDiProva(u(9), ["scheduling"], "user")));
    expect((await utente.get(`/api/planning/feeds/${A}/analysis`)).status).toBe(404);
    expect((await utente.get(`/api/planning/feeds/${A}/routes`)).status).toBe(404);
    expect((await utente.get(`/api/planning/feeds/non-un-id/routes`)).status).toBe(404);
    expect((await utente.get(`/api/gtfs/stops?feedId=${A}`)).status).toBe(404);
    expect((await admin.get(`/api/planning/feeds/${A}/analysis`)).status).toBe(200);
  });

  it("partenze per ora di Planning Studio: per giorno, data e linee, con i valori come parametri (7.25)", async () => {
    const feriale = await admin.get(`/api/planning/feeds/${A}/hourly-schedule?dayType=feriale`);
    expect(feriale.status, JSON.stringify(feriale.body)).toBe(200);
    const l1 = feriale.body.routes.find((r: any) => r.routeId === "L1");
    expect(l1.shortName).toBe("A-1");
    expect(l1.perHour[7] + l1.perHour[8]).toBe(2);
    // martedì 2 gennaio 2001 sì, la domenica no
    const giorno = await admin.get(`/api/planning/feeds/${A}/hourly-schedule?serviceDate=20010102&routes=L2`);
    expect(giorno.body.routes.map((r: any) => r.routeId)).toEqual(["L2"]);
    const domenica = await admin.get(`/api/planning/feeds/${A}/hourly-schedule?serviceDate=20010107`);
    expect(domenica.body.routes).toEqual([]);
    // un codice di linea con un apice resta un valore, non rompe la query
    const apice = await admin.get(`/api/planning/feeds/${A}/hourly-schedule?dayType=feriale&routes=${encodeURIComponent("L1' OR '1'='1")}`);
    expect(apice.status).toBe(200);
    expect(apice.body.routes).toEqual([]);
  });
});

describe("tenantWhere: l'utente come parametro (7.25)", () => {
  it("l'id va nei parametri, la colonna storta è un errore", () => {
    const req: any = { user: { id: u(9), role: "user" } };
    const q = (db as any).dialect.sqlToQuery(tenantWhere(req, "p.owner_user_id"));
    expect(q.sql).toBe("p.owner_user_id = $1::uuid");
    expect(q.params).toEqual([u(9)]);
    expect(() => tenantWhere(req, "owner_user_id OR TRUE")).toThrow();
  });
});
