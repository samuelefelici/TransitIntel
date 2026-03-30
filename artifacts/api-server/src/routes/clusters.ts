/**
 * CLUSTER MANAGEMENT — Gestione Cluster di Cambio in Linea
 *
 * CRUD per i cluster di fermate + impostazioni autovetture.
 *
 * GET    /api/clusters              — lista tutti i cluster con le fermate
 * POST   /api/clusters              — crea un cluster
 * PUT    /api/clusters/:id          — aggiorna un cluster (nome, transferMin, colore, fermate)
 * DELETE /api/clusters/:id          — elimina un cluster
 * GET    /api/gtfs/stops/all        — tutte le fermate GTFS (per la mappa)
 * GET    /api/settings/company-cars — legge il numero autovetture
 * PUT    /api/settings/company-cars — aggiorna il numero autovetture
 */

import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { stopClusters, stopClusterStops, appSettings, gtfsStops } from "@workspace/db/schema";
import { eq, sql } from "drizzle-orm";
import { asyncHandler } from "../middlewares/error-handler";

const router: IRouter = Router();

/* ═══════════════════════════════════════════════════════════════
 *  CLUSTER CRUD
 * ═══════════════════════════════════════════════════════════════ */

// GET /api/clusters — tutti i cluster con le fermate associate
router.get("/clusters", asyncHandler(async (_req, res) => {
  const clusters = await db.select().from(stopClusters).orderBy(stopClusters.name);
  const allStops = await db.select().from(stopClusterStops);

  const result = clusters.map(c => ({
    ...c,
    stops: allStops
      .filter(s => s.clusterId === c.id)
      .map(s => ({
        id: s.id,
        gtfsStopId: s.gtfsStopId,
        stopName: s.stopName,
        stopLat: s.stopLat,
        stopLon: s.stopLon,
      })),
  }));

  res.json({ data: result });
}));

// POST /api/clusters — crea un cluster con fermate
router.post("/clusters", asyncHandler(async (req, res) => {
  const { name, transferFromDepotMin, color, stops } = req.body;
  if (!name) {
    res.status(400).json({ error: "name is required" });
    return;
  }

  const [cluster] = await db.insert(stopClusters).values({
    name,
    transferFromDepotMin: transferFromDepotMin ?? 10,
    color: color ?? "#3b82f6",
  }).returning();

  // Inserisci le fermate se presenti
  if (stops && Array.isArray(stops) && stops.length > 0) {
    await db.insert(stopClusterStops).values(
      stops.map((s: any) => ({
        clusterId: cluster.id,
        gtfsStopId: s.gtfsStopId || s.stopId,
        stopName: s.stopName,
        stopLat: s.stopLat,
        stopLon: s.stopLon,
      }))
    );
  }

  // Ritorna il cluster con le fermate
  const clusterStops = await db.select().from(stopClusterStops).where(eq(stopClusterStops.clusterId, cluster.id));
  res.status(201).json({
    ...cluster,
    stops: clusterStops.map(s => ({
      id: s.id,
      gtfsStopId: s.gtfsStopId,
      stopName: s.stopName,
      stopLat: s.stopLat,
      stopLon: s.stopLon,
    })),
  });
}));

// PUT /api/clusters/:id — aggiorna nome, transferMin, colore e fermate
router.put("/clusters/:id", asyncHandler(async (req, res) => {
  const id = req.params.id as string;
  const { name, transferFromDepotMin, color, stops } = req.body;

  const [cluster] = await db.update(stopClusters).set({
    ...(name !== undefined && { name }),
    ...(transferFromDepotMin !== undefined && { transferFromDepotMin }),
    ...(color !== undefined && { color }),
    updatedAt: new Date(),
  }).where(eq(stopClusters.id, id)).returning();

  if (!cluster) {
    res.status(404).json({ error: "Cluster not found" });
    return;
  }

  // Se "stops" fornito, ricalcola le fermate (elimina + re-inserisci)
  if (stops !== undefined && Array.isArray(stops)) {
    await db.delete(stopClusterStops).where(eq(stopClusterStops.clusterId, id));
    if (stops.length > 0) {
      await db.insert(stopClusterStops).values(
        stops.map((s: any) => ({
          clusterId: id,
          gtfsStopId: s.gtfsStopId || s.stopId,
          stopName: s.stopName,
          stopLat: s.stopLat,
          stopLon: s.stopLon,
        }))
      );
    }
  }

  const clusterStops = await db.select().from(stopClusterStops).where(eq(stopClusterStops.clusterId, id));
  res.json({
    ...cluster,
    stops: clusterStops.map(s => ({
      id: s.id,
      gtfsStopId: s.gtfsStopId,
      stopName: s.stopName,
      stopLat: s.stopLat,
      stopLon: s.stopLon,
    })),
  });
}));

// DELETE /api/clusters/:id
router.delete("/clusters/:id", asyncHandler(async (req, res) => {
  const id = req.params.id as string;
  await db.delete(stopClusters).where(eq(stopClusters.id, id));
  res.status(204).send();
}));

/* ═══════════════════════════════════════════════════════════════
 *  FERMATE GTFS — Tutte (per la mappa cluster)
 * ═══════════════════════════════════════════════════════════════ */

// GET /api/gtfs/stops/all — tutte le fermate GTFS (deduplicate) con le linee associate
router.get("/gtfs/stops/all", asyncHandler(async (_req, res) => {
  const stops = await db.execute<any>(sql`
    SELECT
      s.stop_id   AS "stopId",
      s.stop_name AS "stopName",
      s.stop_lat::float AS "stopLat",
      s.stop_lon::float AS "stopLon",
      COALESCE(
        array_agg(DISTINCT r.route_short_name) FILTER (WHERE r.route_short_name IS NOT NULL),
        '{}'
      ) AS "routes"
    FROM (
      SELECT DISTINCT ON (stop_id) stop_id, stop_name, stop_lat, stop_lon, feed_id
      FROM gtfs_stops
      ORDER BY stop_id, trips_count DESC NULLS LAST
    ) s
    LEFT JOIN gtfs_stop_times st ON st.stop_id = s.stop_id AND st.feed_id = s.feed_id
    LEFT JOIN gtfs_trips t ON t.trip_id = st.trip_id AND t.feed_id = s.feed_id
    LEFT JOIN gtfs_routes r ON r.route_id = t.route_id AND r.feed_id = s.feed_id
    GROUP BY s.stop_id, s.stop_name, s.stop_lat, s.stop_lon
    ORDER BY s.stop_name
  `);
  res.json({ data: stops.rows, total: stops.rows.length });
}));

// GET /api/gtfs/routes/list — lista sintetica delle linee (per il filtro)
router.get("/gtfs/routes/list", asyncHandler(async (_req, res) => {
  const routes = await db.execute<any>(sql`
    SELECT DISTINCT route_short_name AS "routeShortName",
           route_long_name AS "routeLongName",
           route_color AS "routeColor"
    FROM gtfs_routes
    WHERE route_short_name IS NOT NULL
    ORDER BY route_short_name
  `);
  res.json({ data: routes.rows });
}));

/* ═══════════════════════════════════════════════════════════════
 *  SETTINGS — Autovetture aziendali
 * ═══════════════════════════════════════════════════════════════ */

// GET /api/settings/company-cars
router.get("/settings/company-cars", asyncHandler(async (_req, res) => {
  const [row] = await db.select().from(appSettings).where(eq(appSettings.key, "company_cars"));
  const count = row ? (typeof row.value === "number" ? row.value : parseInt(String(row.value), 10)) : 5;
  res.json({ companyCars: count || 5 });
}));

// PUT /api/settings/company-cars
router.put("/settings/company-cars", asyncHandler(async (req, res) => {
  const { companyCars } = req.body;
  const value = parseInt(String(companyCars), 10);
  if (isNaN(value) || value < 0 || value > 50) {
    res.status(400).json({ error: "companyCars must be a number between 0 and 50" });
    return;
  }

  await db.insert(appSettings).values({
    key: "company_cars",
    value: value as any,
    updatedAt: new Date(),
  }).onConflictDoUpdate({
    target: appSettings.key,
    set: { value: value as any, updatedAt: new Date() },
  });

  res.json({ companyCars: value });
}));

export default router;
