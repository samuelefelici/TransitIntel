/**
 * La mappa delle linee (GET /api/gtfs/shapes/geojson) su un database vero
 * (TEST_DATABASE_URL, migrato: in CI il job migrazioni-postgres).
 *
 * Un feed nato da Planning Studio salva in gtfs_shapes.geojson la LineString
 * nuda di ps_shapes.geometry (lib/materializzazione/feed.ts); l'import di un
 * file GTFS salva un Feature. La rotta leggeva solo il Feature, e la mappa dei
 * feed di Planning Studio restava vuota. Qui ci sono le due forme nello stesso
 * feed, e tutte e due devono arrivare sulla mappa, intere e segmentate.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db, pool } from "@workspace/db";
import { sql } from "drizzle-orm";
import router from "../routes/gtfs-analysis";
import { appDiProva, utenteDiProva } from "./helpers/app-di-prova";

const UTENTE = "c6190000-0000-0000-0000-000000000001";
const FEED = "c6190000-0000-0000-0000-0000000000f1";
const PUNTI = Array.from({ length: 8 }, (_, i) => [13.5 + i * 0.002, 43.6 + i * 0.001]);
const NUDA = { type: "LineString", coordinates: PUNTI };
const FEATURE = { type: "Feature", geometry: { type: "LineString", coordinates: PUNTI }, properties: { shapeId: "DAL-GTFS" } };

/* admin: sceglie il feed con ?feedId= */
const app = appDiProva(router, utenteDiProva(UTENTE, [], "admin"));

describe.runIf(!!process.env.TEST_DATABASE_URL)("la mappa delle linee, sul database", () => {
  const pulisci = async () => {
    await db.execute(sql`DELETE FROM gtfs_shapes WHERE feed_id = ${FEED}::uuid`);
    await db.execute(sql`DELETE FROM gtfs_feeds WHERE id = ${FEED}::uuid`);
  };

  beforeAll(async () => {
    await pulisci();
    await db.execute(sql`INSERT INTO gtfs_feeds (id, filename, is_active) VALUES (${FEED}::uuid, 'forme-6.19.synthetic', false)`);
    await db.execute(sql`
      INSERT INTO gtfs_shapes (feed_id, shape_id, route_id, route_short_name, route_color, geojson) VALUES
        (${FEED}::uuid, 'DA-PLANNING', 'L1', '1', 'ff0000', ${JSON.stringify(NUDA)}::jsonb),
        (${FEED}::uuid, 'DAL-GTFS',    'L2', '2', '00ff00', ${JSON.stringify(FEATURE)}::jsonb),
        (${FEED}::uuid, 'VUOTA',       'L3', '3', '0000ff', '{"type":"LineString","coordinates":[]}'::jsonb)`);
  });

  afterAll(async () => {
    await pulisci();
    await pool.end();
  });

  it("le due forme arrivano tutte e due, con i loro punti; quella senza punti no", async () => {
    const r = await request(app).get(`/api/gtfs/shapes/geojson?feedId=${FEED}`);
    expect(r.status).toBe(200);
    const perForma = new Map(r.body.features.map((f: any) => [f.properties.shapeId, f]));
    expect([...perForma.keys()].sort()).toEqual(["DA-PLANNING", "DAL-GTFS"]);
    for (const id of ["DA-PLANNING", "DAL-GTFS"]) {
      const f: any = perForma.get(id);
      expect(f.geometry).toEqual({ type: "LineString", coordinates: PUNTI });
    }
    expect((perForma.get("DA-PLANNING") as any).properties.routeShortName).toBe("1");
  });

  it("segmentata: le due forme danno gli stessi pezzi", async () => {
    const r = await request(app).get(`/api/gtfs/shapes/geojson?feedId=${FEED}&segmented=true&hour=8`);
    expect(r.status).toBe(200);
    const pezzi = (id: string) => r.body.features
      .filter((f: any) => f.properties.shapeId === id)
      .map((f: any) => f.geometry.coordinates);
    expect(pezzi("DA-PLANNING").length).toBeGreaterThan(0);
    expect(pezzi("DA-PLANNING")).toEqual(pezzi("DAL-GTFS"));
  });

  it("filtrata per linea: arriva solo quella chiesta", async () => {
    const r = await request(app).get(`/api/gtfs/shapes/geojson?feedId=${FEED}&routeIds=L1`);
    expect(r.status).toBe(200);
    expect(r.body.features.map((f: any) => f.properties.shapeId)).toEqual(["DA-PLANNING"]);
  });
});
