/**
 * COINCIDENCE ZONES — Zone di coincidenza
 *
 * Tre tipi:
 * 1. Intermodale (railway / port) — hub treni/navi con fermate bus nel raggio 100m
 * 2. Bus-Bus — fermate vicine (<=100m) con >=2 linee che passano entro ±5 min
 * 3. Park & Ride — parcheggi scambiatori con fermate bus nel raggio 100m
 *
 * GET    /api/coincidence-zones              — lista tutte le zone
 * POST   /api/coincidence-zones              — crea una zona
 * PUT    /api/coincidence-zones/:id          — aggiorna una zona
 * DELETE /api/coincidence-zones/:id          — elimina una zona
 * GET    /api/coincidence-zones/hubs         — hub intermodali + parcheggi con fermate vicine
 * POST   /api/coincidence-zones/auto-create  — auto-genera zone (intermodali + bus-bus + P&R)
 * GET    /api/coincidence-zones/:id/schedules — orari treni/navi per un hub
 * GET    /api/coincidence-zones/:id/bus-lines — linee bus nelle fermate della zona
 */

import { Router, type IRouter, type Request } from "express";
import { db } from "@workspace/db";
import { coincidenceZones, coincidenceZoneStops, gtfsStops, gtfsStopTimes, gtfsTrips, gtfsRoutes } from "@workspace/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { asyncHandler } from "../middlewares/error-handler";
import { haversineKm, walkMinutes as calcWalkMin } from "../lib/geo-utils";
import { hubDeiNodi } from "../lib/nodi-scambio-store";
import { hasProjectAccess } from "./argos-context";

const router: IRouter = Router();
const ZONE_UUID_RE = /^[0-9a-f-]{36}$/i;

/* SCOPING PER PROGETTO — le zone di coincidenza erano l'ultima tabella
 * condivisa ancora piatta: le zone di un progetto entravano nell'analisi
 * intermodale di tutti gli altri. Stessa regola di depositi e archi
 * (PS14/PS15): NULL = zona globale, valorizzato = solo quel progetto PS.
 * La colonna ps_project_id la creano le migrazioni. */

/** Filtro riusabile: globali + zone del progetto indicato. */
export function zoneScopeWhere(psProjectId: string | null) {
  return psProjectId
    ? sql`(ps_project_id IS NULL OR ps_project_id = ${psProjectId}::uuid)`
    : sql`TRUE`;
}

/** Le zone che l'utente vede: le globali e quelle dei progetti PS che vede —
 *  owner, membro o progetto in esercizio, la regola di hasProjectAccess
 *  (argos-context.ts). L'admin le vede tutte. */
function zoneVisibiliWhere(req: Request) {
  const u = req.user;
  if (u?.role === "admin") return sql`TRUE`;
  if (!u) return sql`ps_project_id IS NULL`;
  return sql`(ps_project_id IS NULL OR ps_project_id IN (
    SELECT p.id FROM ps_projects p
     WHERE p.owner_user_id = ${u.id}::uuid
        OR EXISTS (SELECT 1 FROM ps_project_members pm
                    WHERE pm.project_id = p.id AND pm.user_id = ${u.id}::uuid)
        OR (p.materialized_feed_id IS NOT NULL
            AND EXISTS (SELECT 1 FROM gtfs_feeds gf
                         WHERE gf.id = p.materialized_feed_id AND gf.is_active = true))
  ))`;
}

// ── Default radius: 100 metri ──
const DEFAULT_RADIUS_KM = 0.1;


// I nodi di scambio (stazioni, porto, aeroporto, parcheggi scambiatori) sono
// dati dell'azienda: tabella nodi_scambio, lib/nodi-scambio-store.ts (tappa
// 6.16). Prima ce n'erano due copie nel codice, qui e in intermodal.ts.

const ZONE_COLORS = ["#06b6d4","#8b5cf6","#f59e0b","#22c55e","#ef4444","#ec4899","#3b82f6","#14b8a6","#f97316","#6366f1"];

// ── Helper: find nearby stops (within radius) ──
function findNearbyStops(
  lat: number, lng: number,
  allStops: { stopId: string; stopName: string | null; lat: any; lng: any }[],
  radiusKm: number, extraWalkMin = 0,
) {
  const nearby: any[] = [];
  for (const stop of allStops) {
    const sLat = typeof stop.lat === "string" ? parseFloat(stop.lat) : stop.lat;
    const sLng = typeof stop.lng === "string" ? parseFloat(stop.lng) : stop.lng;
    if (!sLat || !sLng) continue;
    const d = haversineKm(lat, lng, sLat as number, sLng as number);
    if (d <= radiusKm) {
      nearby.push({
        stopId: stop.stopId, stopName: stop.stopName || "",
        lat: sLat, lng: sLng, distKm: +d.toFixed(3),
        walkMin: extraWalkMin + calcWalkMin(d),
      });
    }
  }
  nearby.sort((a: any, b: any) => a.distKm - b.distKm);
  return nearby;
}

// ═══════════════════════════════════════════════════════════════
// GET /api/coincidence-zones/hubs
// ═══════════════════════════════════════════════════════════════
router.get("/coincidence-zones/hubs", asyncHandler(async (req, res) => {
  const radiusKm = parseFloat(req.query.radius as string) || DEFAULT_RADIUS_KM;
  const allStops = await db.select({
    stopId: gtfsStops.stopId, stopName: gtfsStops.stopName,
    lat: gtfsStops.stopLat, lng: gtfsStops.stopLon,
  }).from(gtfsStops);

  const hubs = (await hubDeiNodi()).map(hub => {
    const nearby = findNearbyStops(hub.lat, hub.lng, allStops, radiusKm, hub.platformWalkMinutes);
    return {
      id: hub.id, name: hub.name, type: hub.type,
      lat: hub.lat, lng: hub.lng, description: hub.description,
      platformWalkMinutes: hub.platformWalkMinutes,
      totalArrivals: hub.typicalArrivals.reduce((s, a) => s + a.times.length, 0),
      totalDepartures: hub.typicalDepartures.reduce((s, d) => s + d.times.length, 0),
      arrivals: hub.typicalArrivals, departures: hub.typicalDepartures,
      nearbyStops: nearby,
    };
  });
  res.json({ hubs });
}));

// ═══════════════════════════════════════════════════════════════
// GET /api/coincidence-zones
// ═══════════════════════════════════════════════════════════════
// La leggono anche Turni e Analisi (LETTURE_CONDIVISE): con ?psProjectId= il
// progetto deve essere uno che l'utente vede, e senza restano fuori le zone dei
// progetti altrui.
router.get("/coincidence-zones", asyncHandler(async (req, res) => {
  const ps = String(req.query.psProjectId ?? "");
  const scope = ZONE_UUID_RE.test(ps) ? ps : null;
  if (scope && req.user?.role !== "admin" && !(req.user && await hasProjectAccess(scope, req.user.id))) {
    res.status(404).json({ error: "Progetto non trovato o non accessibile" });
    return;
  }
  const zones = await db.select().from(coincidenceZones)
    .where(and(zoneScopeWhere(scope), zoneVisibiliWhere(req))).orderBy(coincidenceZones.name);
  const allStops = await db.select().from(coincidenceZoneStops);
  const result = zones.map(z => ({
    ...z,
    stops: allStops.filter(s => s.zoneId === z.id).map(s => ({
      id: s.id, gtfsStopId: s.gtfsStopId, stopName: s.stopName,
      stopLat: s.stopLat, stopLon: s.stopLon,
      distanceKm: s.distanceKm, walkMinFromHub: s.walkMinFromHub,
    })),
  }));
  res.json({ data: result });
}));

// ═══════════════════════════════════════════════════════════════
// POST /api/coincidence-zones
// ═══════════════════════════════════════════════════════════════
router.post("/coincidence-zones", asyncHandler(async (req, res) => {
  const { name, hubId, hubName, hubType, hubLat, hubLng, walkMinutes: wm, radiusKm, color, notes, stops } = req.body;
  if (!name || !hubId) { res.status(400).json({ error: "name and hubId required" }); return; }
  const psScope = ZONE_UUID_RE.test(String(req.body?.psProjectId ?? "")) ? String(req.body.psProjectId) : null;
  const [zone] = await db.insert(coincidenceZones).values({
    name, hubId, hubName: hubName || name, hubType: hubType || "bus-bus",
    hubLat: hubLat || 0, hubLng: hubLng || 0, walkMinutes: wm ?? 2,
    radiusKm: radiusKm ?? DEFAULT_RADIUS_KM, color: color ?? "#06b6d4", notes: notes || null,
  }).returning();
  if (psScope) {
    await db.execute(sql`UPDATE coincidence_zones SET ps_project_id = ${psScope}::uuid WHERE id = ${zone.id}::uuid`);
  }
  if (stops && Array.isArray(stops) && stops.length > 0) {
    await db.insert(coincidenceZoneStops).values(stops.map((s: any) => ({
      zoneId: zone.id, gtfsStopId: s.gtfsStopId || s.stopId, stopName: s.stopName,
      stopLat: s.stopLat, stopLon: s.stopLon,
      distanceKm: s.distanceKm ?? null, walkMinFromHub: s.walkMinFromHub ?? null,
    })));
  }
  const zoneStops = await db.select().from(coincidenceZoneStops).where(eq(coincidenceZoneStops.zoneId, zone.id));
  res.status(201).json({ ...zone, stops: zoneStops.map(s => ({
    id: s.id, gtfsStopId: s.gtfsStopId, stopName: s.stopName,
    stopLat: s.stopLat, stopLon: s.stopLon, distanceKm: s.distanceKm, walkMinFromHub: s.walkMinFromHub,
  }))});
}));

// ═══════════════════════════════════════════════════════════════
// PUT /api/coincidence-zones/:id
// ═══════════════════════════════════════════════════════════════
router.put("/coincidence-zones/:id", asyncHandler(async (req, res) => {
  const id = req.params.id as string;
  const { name, hubType, hubLat, hubLng, walkMinutes: wm, radiusKm, color, notes, stops } = req.body;
  const [zone] = await db.update(coincidenceZones).set({
    ...(name !== undefined && { name }), ...(hubType !== undefined && { hubType }),
    ...(hubLat !== undefined && { hubLat }), ...(hubLng !== undefined && { hubLng }),
    ...(wm !== undefined && { walkMinutes: wm }),
    ...(radiusKm !== undefined && { radiusKm }), ...(color !== undefined && { color }),
    ...(notes !== undefined && { notes }), updatedAt: new Date(),
  }).where(eq(coincidenceZones.id, id)).returning();
  if (!zone) { res.status(404).json({ error: "Not found" }); return; }
  if (stops !== undefined && Array.isArray(stops)) {
    await db.delete(coincidenceZoneStops).where(eq(coincidenceZoneStops.zoneId, id));
    if (stops.length > 0) {
      await db.insert(coincidenceZoneStops).values(stops.map((s: any) => ({
        zoneId: id, gtfsStopId: s.gtfsStopId || s.stopId, stopName: s.stopName,
        stopLat: s.stopLat, stopLon: s.stopLon,
        distanceKm: s.distanceKm ?? null, walkMinFromHub: s.walkMinFromHub ?? null,
      })));
    }
  }
  const zoneStops = await db.select().from(coincidenceZoneStops).where(eq(coincidenceZoneStops.zoneId, id));
  res.json({ ...zone, stops: zoneStops.map(s => ({
    id: s.id, gtfsStopId: s.gtfsStopId, stopName: s.stopName,
    stopLat: s.stopLat, stopLon: s.stopLon, distanceKm: s.distanceKm, walkMinFromHub: s.walkMinFromHub,
  }))});
}));

// ═══════════════════════════════════════════════════════════════
// DELETE /api/coincidence-zones/:id
// ═══════════════════════════════════════════════════════════════
router.delete("/coincidence-zones/:id", asyncHandler(async (req, res) => {
  await db.delete(coincidenceZones).where(eq(coincidenceZones.id, req.params.id as string));
  res.status(204).send();
}));

// ═══════════════════════════════════════════════════════════════
// POST /api/coincidence-zones/auto-create
// Genera automaticamente zone per hub noti:
//   - Stazioni ferroviarie
//   - Porti
//   - Parcheggi scambiatori (P+R)
// Le zone bus-bus si creano manualmente dal frontend
// ═══════════════════════════════════════════════════════════════
router.post("/coincidence-zones/auto-create", asyncHandler(async (req, res) => {
  const radiusKm = parseFloat(req.body.radiusKm) || DEFAULT_RADIUS_KM;
  const existing = await db.select({ hubId: coincidenceZones.hubId }).from(coincidenceZones);
  const existingHubIds = new Set(existing.map(e => e.hubId));

  const allStops = await db.select({
    stopId: gtfsStops.stopId, stopName: gtfsStops.stopName,
    lat: gtfsStops.stopLat, lng: gtfsStops.stopLon,
  }).from(gtfsStops);

  const created: any[] = [];
  let colorIdx = existing.length;

  // ──────── Phase 1: hub intermodali + parcheggi scambiatori ────────
  for (const hub of await hubDeiNodi()) {
    if (existingHubIds.has(hub.id)) continue;
    const nearby = findNearbyStops(hub.lat, hub.lng, allStops, radiusKm, hub.platformWalkMinutes);
    const [zone] = await db.insert(coincidenceZones).values({
      name: hub.type === "park-ride" ? `P+R ${hub.name.replace("P+R ","")}` : `Coincidenza ${hub.name}`,
      hubId: hub.id, hubName: hub.name, hubType: hub.type,
      hubLat: hub.lat, hubLng: hub.lng,
      walkMinutes: hub.platformWalkMinutes, radiusKm,
      color: ZONE_COLORS[colorIdx % ZONE_COLORS.length],
      notes: hub.description,
    }).returning();
    colorIdx++;
    if (nearby.length > 0) {
      await db.insert(coincidenceZoneStops).values(nearby.map((s: any) => ({
        zoneId: zone.id, gtfsStopId: s.stopId, stopName: s.stopName,
        stopLat: s.lat, stopLon: s.lng, distanceKm: s.distKm, walkMinFromHub: s.walkMin,
      })));
    }
    const zoneStops = await db.select().from(coincidenceZoneStops).where(eq(coincidenceZoneStops.zoneId, zone.id));
    created.push({ ...zone, stops: zoneStops.map(s => ({
      id: s.id, gtfsStopId: s.gtfsStopId, stopName: s.stopName,
      stopLat: s.stopLat, stopLon: s.stopLon, distanceKm: s.distanceKm, walkMinFromHub: s.walkMinFromHub,
    }))});
  }

  console.log(`[CoincidenceZones] Created ${created.length} hub zones`);
  res.json({ created: created.length, zones: created });
}));

// ═══════════════════════════════════════════════════════════════
// GET /api/coincidence-zones/:id/schedules
// Restituisce gli orari della zona: prima i custom (zone.schedules), poi quelli stimati del suo nodo di scambio
// ═══════════════════════════════════════════════════════════════
router.get("/coincidence-zones/:id/schedules", asyncHandler(async (req, res) => {
  const [zone] = await db.select().from(coincidenceZones).where(eq(coincidenceZones.id, req.params.id as string));
  if (!zone) { res.status(404).json({ error: "Not found" }); return; }
  const custom = (zone as any).schedules as
    | { arrivals?: { label: string; times: string[] }[]; departures?: { label: string; times: string[] }[] }
    | null
    | undefined;
  const hub = (await hubDeiNodi()).find(h => h.id === zone.hubId);
  // Mappa preset (origin/destination) → label
  const presetArrivals = (hub?.typicalArrivals ?? []).map(a => ({ label: a.origin, times: a.times }));
  const presetDepartures = (hub?.typicalDepartures ?? []).map(a => ({ label: a.destination, times: a.times }));
  const arrivals = (custom?.arrivals && custom.arrivals.length > 0) ? custom.arrivals : presetArrivals;
  const departures = (custom?.departures && custom.departures.length > 0) ? custom.departures : presetDepartures;
  res.json({
    arrivals,
    departures,
    source: (custom?.arrivals?.length || custom?.departures?.length) ? "custom" : (hub ? "preset" : "empty"),
    hubType: zone.hubType,
    platformWalkMinutes: zone.walkMinutes,
  });
}));

// ═══════════════════════════════════════════════════════════════
// PATCH /api/coincidence-zones/:id/schedules
// Aggiorna gli orari custom della zona. Body: { arrivals: [{label,times}], departures: [{label,times}] }
// ═══════════════════════════════════════════════════════════════
router.patch("/coincidence-zones/:id/schedules", asyncHandler(async (req, res) => {
  const id = req.params.id as string;
  const body = req.body as { arrivals?: { label: string; times: string[] }[]; departures?: { label: string; times: string[] }[] };
  const arrivals = Array.isArray(body?.arrivals)
    ? body.arrivals
        .map(a => ({ label: String(a?.label ?? "").trim() || "—", times: Array.isArray(a?.times) ? a.times.filter(t => /^\d{1,2}:\d{2}$/.test(String(t).trim())).map(t => String(t).trim().padStart(5, "0")) : [] }))
        .filter(a => a.times.length > 0)
    : [];
  const departures = Array.isArray(body?.departures)
    ? body.departures
        .map(a => ({ label: String(a?.label ?? "").trim() || "—", times: Array.isArray(a?.times) ? a.times.filter(t => /^\d{1,2}:\d{2}$/.test(String(t).trim())).map(t => String(t).trim().padStart(5, "0")) : [] }))
        .filter(a => a.times.length > 0)
    : [];
  const [updated] = await db.update(coincidenceZones)
    .set({ schedules: { arrivals, departures } as any, updatedAt: new Date() })
    .where(eq(coincidenceZones.id, id))
    .returning();
  if (!updated) { res.status(404).json({ error: "Not found" }); return; }
  res.json({ ok: true, arrivals, departures });
}));

// ═══════════════════════════════════════════════════════════════
// GET /api/coincidence-zones/:id/bus-lines
// ═══════════════════════════════════════════════════════════════
router.get("/coincidence-zones/:id/bus-lines", asyncHandler(async (req, res) => {
  const zoneStops = await db.select().from(coincidenceZoneStops).where(eq(coincidenceZoneStops.zoneId, req.params.id as string));
  if (zoneStops.length === 0) { res.json({ busLines: [] }); return; }
  const stopIds = zoneStops.map(s => s.gtfsStopId);
  const batchSize = 200;
  let stopTimes: { stopId: string; tripId: string; departureTime: string | null }[] = [];
  for (let i = 0; i < stopIds.length; i += batchSize) {
    const batch = stopIds.slice(i, i + batchSize);
    const rows = await db.select({ stopId: gtfsStopTimes.stopId, tripId: gtfsStopTimes.tripId, departureTime: gtfsStopTimes.departureTime })
      .from(gtfsStopTimes).where(sql`${gtfsStopTimes.stopId} IN (${sql.join(batch.map(sid => sql`${sid}`), sql`, `)})`);
    stopTimes.push(...rows);
  }
  const tripIds = [...new Set(stopTimes.map(st => st.tripId))];
  const tripRouteMap: Record<string, string> = {};
  for (let i = 0; i < tripIds.length; i += batchSize) {
    const batch = tripIds.slice(i, i + batchSize);
    const rows = await db.select({ tripId: gtfsTrips.tripId, routeId: gtfsTrips.routeId })
      .from(gtfsTrips).where(sql`${gtfsTrips.tripId} IN (${sql.join(batch.map(tid => sql`${tid}`), sql`, `)})`);
    for (const r of rows) tripRouteMap[r.tripId] = r.routeId;
  }
  const routeIds = [...new Set(Object.values(tripRouteMap))];
  const routeMap: Record<string, { shortName: string|null; longName: string|null; color: string|null }> = {};
  if (routeIds.length > 0) {
    const routes = await db.select({ routeId: gtfsRoutes.routeId, shortName: gtfsRoutes.routeShortName,
      longName: gtfsRoutes.routeLongName, color: gtfsRoutes.routeColor }).from(gtfsRoutes)
      .where(sql`${gtfsRoutes.routeId} IN (${sql.join(routeIds.map(rid => sql`${rid}`), sql`, `)})`);
    for (const r of routes) routeMap[r.routeId] = { shortName: r.shortName, longName: r.longName, color: r.color };
  }
  const byRoute: Record<string, { times: Set<string>; trips: number }> = {};
  for (const st of stopTimes) {
    const rId = tripRouteMap[st.tripId]; if (!rId) continue;
    if (!byRoute[rId]) byRoute[rId] = { times: new Set(), trips: 0 };
    if (st.departureTime) byRoute[rId].times.add(st.departureTime);
    byRoute[rId].trips++;
  }
  const busLines = Object.entries(byRoute).map(([rId, info]) => ({
    routeId: rId, routeShortName: routeMap[rId]?.shortName || rId,
    routeLongName: routeMap[rId]?.longName || "", routeColor: routeMap[rId]?.color || null,
    tripsCount: info.times.size, times: [...info.times].sort(),
  })).sort((a, b) => b.tripsCount - a.tripsCount);
  res.json({ busLines });
}));

export default router;
