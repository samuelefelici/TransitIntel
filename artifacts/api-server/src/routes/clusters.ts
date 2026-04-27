/**
 * CLUSTER MANAGEMENT — Gestione Cluster di Cambio in Linea
 *
 * CRUD per i cluster di fermate + impostazioni autovetture.
 *
 * GET    /api/clusters              — lista tutti i cluster con le fermate
 * POST   /api/clusters              — crea un cluster
 * PUT    /api/clusters/:id          — aggiorna un cluster (nome, transferMin, colore, fermate)
 * DELETE /api/clusters/:id          — elimina un cluster
 * POST   /api/clusters/by-routes    — cluster toccati dalle linee selezionate in una data
 * GET    /api/gtfs/stops/all        — tutte le fermate GTFS (per la mappa)
 * GET    /api/settings/company-cars — legge il numero autovetture
 * PUT    /api/settings/company-cars — aggiorna il numero autovetture
 */

import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  stopClusters, stopClusterStops, appSettings, gtfsStops,
  gtfsCalendar, gtfsCalendarDates,
} from "@workspace/db/schema";
import { eq, sql } from "drizzle-orm";
import { asyncHandler } from "../middlewares/error-handler";
import { getLatestFeedId } from "./gtfs-helpers";

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
 *  CLUSTER PER LINEE — Restituisce i cluster toccati dalle linee
 *  selezionate in una data di esercizio
 * ═══════════════════════════════════════════════════════════════ */

// POST /api/clusters/by-routes — cluster toccati da un insieme di linee in una data
// Body: { routeIds: string[], date: string (YYYY-MM-DD) }
router.post("/clusters/by-routes", asyncHandler(async (req, res) => {
  const { routeIds, date } = req.body as { routeIds?: string[]; date?: string };

  if (!routeIds || !Array.isArray(routeIds) || routeIds.length === 0) {
    res.status(400).json({ error: "routeIds array is required" });
    return;
  }
  if (!date) {
    res.status(400).json({ error: "date (YYYY-MM-DD) is required" });
    return;
  }

  // Converti la data in formato YYYYMMDD per il confronto con il GTFS
  const ymd = date.replace(/-/g, "");
  const dayOfWeek = new Date(date).getDay(); // 0=Sun,1=Mon,...,6=Sat
  const dayCol = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"][dayOfWeek];

  // Trova il feed più recente
  const feedId = await getLatestFeedId();
  if (!feedId) { res.json({ data: [], total: 0, touchedStopCount: 0 }); return; }

  // Tutte le fermate servite dalle linee selezionate nella data richiesta
  const routeIdParams = sql.join(routeIds.map(id => sql`${id}`), sql`, `);
  const touchedStops = await db.execute<any>(sql`
    SELECT DISTINCT st.stop_id
    FROM gtfs_stop_times st
    JOIN gtfs_trips t ON t.trip_id = st.trip_id AND t.feed_id = st.feed_id
    LEFT JOIN gtfs_calendar cal ON cal.service_id = t.service_id AND cal.feed_id = t.feed_id
    LEFT JOIN gtfs_calendar_dates cd ON cd.service_id = t.service_id
                                     AND cd.feed_id = t.feed_id
                                     AND cd.date = ${ymd}
    WHERE t.feed_id = ${feedId}
      AND t.route_id IN (${routeIdParams})
      AND (
        -- Eccezione aggiunta (tipo 1)
        (cd.exception_type = 1)
        OR
        -- Servizio da calendario attivo, non escluso da eccezione
        (
          cal.${sql.raw(dayCol)} = 1
          AND cal.start_date <= ${ymd}
          AND cal.end_date >= ${ymd}
          AND (cd.exception_type IS NULL OR cd.exception_type != 2)
        )
      )
  `);

  if (touchedStops.rows.length === 0) {
    res.json({ data: [], total: 0, touchedStopCount: 0 });
    return;
  }

  const touchedStopIds = new Set<string>(touchedStops.rows.map((r: any) => r.stop_id as string));

  // Trova i cluster che contengono almeno una di quelle fermate
  const allClusters = await db.select().from(stopClusters).orderBy(stopClusters.name);
  const allClusterStops = await db.select().from(stopClusterStops);

  // Per ogni cluster, raccogli le fermate e verifica se tocca le linee selezionate
  const result = allClusters
    .map(c => {
      const stops = allClusterStops.filter(s => s.clusterId === c.id);
      const matchingStops = stops.filter(s => s.gtfsStopId && touchedStopIds.has(s.gtfsStopId));
      return {
        id: c.id,
        name: c.name,
        color: c.color,
        transferFromDepotMin: c.transferFromDepotMin,
        touched: matchingStops.length > 0,
        touchedStopsCount: matchingStops.length,
        stops: stops.map(s => ({
          id: s.id,
          gtfsStopId: s.gtfsStopId,
          stopName: s.stopName,
          stopLat: s.stopLat,
          stopLon: s.stopLon,
          isTouched: s.gtfsStopId ? touchedStopIds.has(s.gtfsStopId) : false,
        })),
      };
    })
    .filter(c => c.touched); // restituisce solo i cluster effettivamente toccati

  res.json({ data: result, total: result.length, touchedStopCount: touchedStopIds.size });
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
