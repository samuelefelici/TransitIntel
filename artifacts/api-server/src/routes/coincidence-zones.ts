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

import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { coincidenceZones, coincidenceZoneStops, gtfsStops, gtfsStopTimes, gtfsTrips, gtfsRoutes } from "@workspace/db/schema";
import { eq, sql } from "drizzle-orm";
import { asyncHandler } from "../middlewares/error-handler";
import { haversineKm, walkMinutes as calcWalkMin } from "../lib/geo-utils";

const router: IRouter = Router();

// ── Default radius: 100 metri ──
const DEFAULT_RADIUS_KM = 0.1;


// ─── Hub intermodali — NO AIRPORT ──────────────────────────
export interface IntermodalHub {
  id: string; name: string; type: "railway" | "port" | "park-ride";
  lat: number; lng: number; gtfsStopIds: string[];
  description: string; platformWalkMinutes: number;
  typicalArrivals: { origin: string; times: string[] }[];
  typicalDepartures: { destination: string; times: string[] }[];
}

export const INTERMODAL_HUBS: IntermodalHub[] = [
  {
    id: "rail-ancona", name: "Stazione FS Ancona", type: "railway",
    lat: 43.607348, lng: 13.49776447, gtfsStopIds: ["13","18","153","20006","20044"],
    description: "Stazione centrale — hub ferroviario principale", platformWalkMinutes: 3,
    typicalArrivals: [
      { origin: "Roma (IC/FR)", times: ["08:45","10:15","11:50","13:45","15:50","17:45","19:10","20:45","22:10"] },
      { origin: "Milano (IC/FR)", times: ["07:10","09:10","11:10","13:10","15:10","17:10","18:35","20:10","22:10"] },
      { origin: "Pesaro/Rimini (R)", times: ["06:25","06:55","07:25","07:55","08:25","08:55","09:55","10:55","11:55","12:55","13:55","14:55","15:55","16:25","16:55","17:25","17:55","18:25","18:55","19:55","20:55","21:55"] },
      { origin: "Foligno/Fabriano (R)", times: ["07:40","08:40","09:40","11:40","13:40","15:40","17:40","19:40","21:40"] },
    ],
    typicalDepartures: [
      { destination: "Roma (IC/FR)", times: ["06:10","07:35","08:55","10:35","12:10","14:10","16:10","17:35","18:55","20:10"] },
      { destination: "Milano (IC/FR)", times: ["05:50","06:50","08:50","10:50","12:50","14:50","16:25","17:50","19:50"] },
      { destination: "Pesaro/Rimini (R)", times: ["05:30","06:00","06:30","07:00","07:30","08:00","08:30","09:30","10:30","11:30","12:30","13:30","14:30","15:30","16:00","16:30","17:00","17:30","18:00","18:30","19:30","20:30","21:30"] },
      { destination: "Foligno/Fabriano (R)", times: ["06:20","07:20","08:20","10:20","12:20","14:20","16:20","18:20","20:20"] },
    ],
  },
  {
    id: "rail-falconara", name: "Stazione FS Falconara Marittima", type: "railway",
    lat: 43.6301852, lng: 13.39739496, gtfsStopIds: ["20026","20027"],
    description: "Nodo Adriatica / linea per Roma", platformWalkMinutes: 2,
    typicalArrivals: [
      { origin: "Ancona (R)", times: ["06:30","07:00","07:30","08:00","08:30","09:00","10:00","11:00","12:00","13:00","14:00","15:00","16:00","16:30","17:00","17:30","18:00","18:30","19:00","20:00","21:00"] },
      { origin: "Roma (via Orte)", times: ["10:30","14:30","18:30","21:30"] },
      { origin: "Pesaro/Rimini (R)", times: ["06:50","07:50","08:50","09:50","11:50","13:50","15:50","17:50","19:50","21:50"] },
    ],
    typicalDepartures: [
      { destination: "Ancona (R)", times: ["06:10","06:40","07:10","07:40","08:10","08:40","09:40","10:40","11:40","12:40","13:40","14:40","15:40","16:10","16:40","17:10","17:40","18:10","18:40","19:40","20:40"] },
      { destination: "Roma (via Orte)", times: ["06:35","10:05","14:05","17:35"] },
      { destination: "Pesaro/Rimini (R)", times: ["06:15","07:15","08:15","09:15","11:15","13:15","15:15","17:15","19:15","21:15"] },
    ],
  },
  {
    id: "rail-palombina", name: "Stazione Palombina Nuova", type: "railway",
    lat: 43.61802912, lng: 13.42590525, gtfsStopIds: ["20020","20034"],
    description: "Fermata Palombina — collegamento costiero", platformWalkMinutes: 1,
    typicalArrivals: [
      { origin: "Ancona (R)", times: ["06:55","07:55","08:55","10:55","13:55","15:55","17:55","19:55"] },
      { origin: "Falconara (R)", times: ["06:35","07:35","08:35","09:35","12:35","14:35","16:35","17:35","18:35","19:35"] },
    ],
    typicalDepartures: [
      { destination: "Ancona (R)", times: ["06:20","07:20","08:20","09:20","12:20","14:20","16:20","17:20","18:20","19:20"] },
      { destination: "Falconara (R)", times: ["06:45","07:45","08:45","10:45","13:45","15:45","17:45","19:45"] },
    ],
  },
  {
    id: "port-ancona", name: "Porto di Ancona (Terminal Passeggeri)", type: "port",
    lat: 43.61864036, lng: 13.50938321, gtfsStopIds: ["20003","20047"],
    description: "Terminal traghetti — Croazia, Grecia, Albania", platformWalkMinutes: 8,
    typicalArrivals: [
      { origin: "Spalato (HR) - Jadrolinija", times: ["07:00"] },
      { origin: "Spalato (HR) - SNAV", times: ["09:00"] },
      { origin: "Patrasso (GR)", times: ["08:00","15:00"] },
      { origin: "Durazzo (AL)", times: ["07:30"] },
      { origin: "Igoumenitsa (GR)", times: ["08:00","15:00"] },
    ],
    typicalDepartures: [
      { destination: "Spalato (HR) - Jadrolinija", times: ["19:00"] },
      { destination: "Spalato (HR) - SNAV", times: ["17:30"] },
      { destination: "Patrasso (GR)", times: ["13:30","17:00"] },
      { destination: "Durazzo (AL)", times: ["21:00"] },
      { destination: "Igoumenitsa (GR)", times: ["13:30","17:00"] },
    ],
  },
  {
    id: "rail-torrette", name: "Stazione di Ancona Torrette", type: "railway",
    lat: 43.609894, lng: 13.455588, gtfsStopIds: [],
    description: "Stazione ferroviaria Ancona Torrette", platformWalkMinutes: 2,
    typicalArrivals: [
      { origin: "Ancona (R)", times: ["06:50","07:50","08:50","10:50","13:50","15:50","17:50","19:50"] },
      { origin: "Falconara (R)", times: ["06:30","07:30","08:30","09:30","12:30","14:30","16:30","17:30","18:30","19:30"] },
    ],
    typicalDepartures: [
      { destination: "Ancona (R)", times: ["06:25","07:25","08:25","09:25","12:25","14:25","16:25","17:25","18:25","19:25"] },
      { destination: "Falconara (R)", times: ["06:50","07:50","08:50","10:50","13:50","15:50","17:50","19:50"] },
    ],
  },
  // ─── PARCHEGGI SCAMBIATORI ──
  {
    id: "pr-tavernelle", name: "P+R Tavernelle (Stadio del Conero)", type: "park-ride",
    lat: 43.58046, lng: 13.51847, gtfsStopIds: [],
    description: "Parcheggio scambiatore Tavernelle — navetta per centro", platformWalkMinutes: 2,
    typicalArrivals: [], typicalDepartures: [],
  },
  {
    id: "pr-baraccola", name: "P+R Baraccola (Centro Comm.le)", type: "park-ride",
    lat: 43.58597, lng: 13.48261, gtfsStopIds: [],
    description: "Parcheggio scambiatore Baraccola — zona commerciale", platformWalkMinutes: 2,
    typicalArrivals: [], typicalDepartures: [],
  },
  {
    id: "pr-posatora", name: "P+R Posatora", type: "park-ride",
    lat: 43.60128, lng: 13.48701, gtfsStopIds: [],
    description: "Parcheggio scambiatore Posatora — ingresso ovest", platformWalkMinutes: 1,
    typicalArrivals: [], typicalDepartures: [],
  },
];

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

  const hubs = INTERMODAL_HUBS.map(hub => {
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
router.get("/coincidence-zones", asyncHandler(async (_req, res) => {
  const zones = await db.select().from(coincidenceZones).orderBy(coincidenceZones.name);
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
  const [zone] = await db.insert(coincidenceZones).values({
    name, hubId, hubName: hubName || name, hubType: hubType || "bus-bus",
    hubLat: hubLat || 0, hubLng: hubLng || 0, walkMinutes: wm ?? 2,
    radiusKm: radiusKm ?? DEFAULT_RADIUS_KM, color: color ?? "#06b6d4", notes: notes || null,
  }).returning();
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
  for (const hub of INTERMODAL_HUBS) {
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

  console.log(`[CoincidenceZones] Created ${created.length} hub zones (railway/port/park-ride)`);
  res.json({ created: created.length, zones: created });
}));

// ═══════════════════════════════════════════════════════════════
// GET /api/coincidence-zones/:id/schedules
// Restituisce gli orari della zona: prima i custom (zone.schedules), poi fallback al preset INTERMODAL_HUBS
// ═══════════════════════════════════════════════════════════════
router.get("/coincidence-zones/:id/schedules", asyncHandler(async (req, res) => {
  const [zone] = await db.select().from(coincidenceZones).where(eq(coincidenceZones.id, req.params.id as string));
  if (!zone) { res.status(404).json({ error: "Not found" }); return; }
  const custom = (zone as any).schedules as
    | { arrivals?: { label: string; times: string[] }[]; departures?: { label: string; times: string[] }[] }
    | null
    | undefined;
  const hub = INTERMODAL_HUBS.find(h => h.id === zone.hubId);
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
