/**
 * DEADHEADS — Calcolo Fuori Linea
 *
 * POST /api/deadheads/compute
 *   Body: { depotId, routeIds[], clusterIds[], date?, costPerKm? }
 *
 * Algoritmo:
 *  1. Carica coordinate del deposito.
 *  2. Trova tutti i trip delle linee selezionate (senza filtro data:
 *     i capolinea fisici sono gli stessi per tutte le corse di una linea).
 *  3. Per ogni trip calcola min/max stop_sequence in JS → stop_id capolinea.
 *  4. Recupera coordinate dei capolinea univoci.
 *  5. Recupera fermate dei cluster selezionati.
 *  6. Genera matrice completa ordinata per costo decrescente.
 */

import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { depots, stopClusterStops, gtfsTrips, gtfsStopTimes, gtfsStops } from "@workspace/db/schema";
import { eq, inArray, and } from "drizzle-orm";
import { asyncHandler } from "../middlewares/error-handler";
import { getLatestFeedId } from "./gtfs-helpers";

const router: IRouter = Router();

const ROAD_FACTOR   = 1.35;
const BUS_SPEED_KMH = 22;
const DEFAULT_COST  = 2.20;
const CHUNK         = 500;

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

export interface DeadheadNode {
  id: string;
  type: "depot" | "terminus" | "cluster";
  name: string;
  lat: number;
  lon: number;
  routeIds?: string[];
}

export interface Deadhead {
  id: string;
  fromId: string;
  toId: string;
  distanceKm: number;
  durationMin: number;
  costEur: number;
  overridden: boolean;
}

router.post("/deadheads/compute", asyncHandler(async (req, res) => {
  const {
    depotId,
    routeIds,
    clusterIds,
    costPerKm = DEFAULT_COST,
  } = req.body as {
    depotId: string;
    routeIds: string[];
    clusterIds: string[];
    date?: string;
    costPerKm?: number;
  };

  if (!depotId || !Array.isArray(routeIds) || routeIds.length === 0) {
    res.status(400).json({ error: "depotId e routeIds sono obbligatori" });
    return;
  }

  // 1. Deposito
  const [depot] = await db.select().from(depots).where(eq(depots.id, depotId));
  if (!depot || depot.lat == null || depot.lon == null) {
    res.status(404).json({ error: "Deposito non trovato o privo di coordinate" });
    return;
  }

  // 2. Feed
  const feedId = await getLatestFeedId();
  if (!feedId) {
    res.status(400).json({ error: "Nessun feed GTFS disponibile" });
    return;
  }

  // 3. Tutti i trip delle linee selezionate
  const trips = await db
    .select({ tripId: gtfsTrips.tripId, routeId: gtfsTrips.routeId })
    .from(gtfsTrips)
    .where(and(eq(gtfsTrips.feedId, feedId), inArray(gtfsTrips.routeId, routeIds)));

  if (trips.length === 0) {
    res.json({ nodes: [{ id: "depot:" + depot.id, type: "depot", name: depot.name, lat: depot.lat, lon: depot.lon }], deadheads: [] });
    return;
  }

  const tripToRoute = new Map<string, string>(trips.map(t => [t.tripId, t.routeId]));
  const tripIds     = trips.map(t => t.tripId);

  // 4. Stop times a blocchi (evita IN clause gigante)
  const allST: { tripId: string; stopId: string; stopSequence: number }[] = [];
  for (let i = 0; i < tripIds.length; i += CHUNK) {
    const rows = await db
      .select({ tripId: gtfsStopTimes.tripId, stopId: gtfsStopTimes.stopId, stopSequence: gtfsStopTimes.stopSequence })
      .from(gtfsStopTimes)
      .where(and(eq(gtfsStopTimes.feedId, feedId), inArray(gtfsStopTimes.tripId, tripIds.slice(i, i + CHUNK))));
    allST.push(...rows);
  }

  // 5. Min/max stop_sequence per trip in JS
  const bounds = new Map<string, { minSeq: number; maxSeq: number; minStop: string; maxStop: string }>();
  for (const st of allST) {
    const cur = bounds.get(st.tripId);
    if (!cur) {
      bounds.set(st.tripId, { minSeq: st.stopSequence, maxSeq: st.stopSequence, minStop: st.stopId, maxStop: st.stopId });
    } else {
      if (st.stopSequence < cur.minSeq) { cur.minSeq = st.stopSequence; cur.minStop = st.stopId; }
      if (st.stopSequence > cur.maxSeq) { cur.maxSeq = st.stopSequence; cur.maxStop = st.stopId; }
    }
  }

  // stopId → set di routeId che lo usano come capolinea
  const terminusMap = new Map<string, Set<string>>();
  for (const [tripId, b] of bounds) {
    const rId = tripToRoute.get(tripId) ?? "";
    for (const sid of [b.minStop, b.maxStop]) {
      if (!terminusMap.has(sid)) terminusMap.set(sid, new Set());
      terminusMap.get(sid)!.add(rId);
    }
  }

  // 6. Coordinate capolinea
  const terminusIds = [...terminusMap.keys()];
  const terminusCoords: { stopId: string; stopName: string; stopLat: number; stopLon: number }[] = [];
  for (let i = 0; i < terminusIds.length; i += CHUNK) {
    const rows = await db
      .select({ stopId: gtfsStops.stopId, stopName: gtfsStops.stopName, stopLat: gtfsStops.stopLat, stopLon: gtfsStops.stopLon })
      .from(gtfsStops)
      .where(and(eq(gtfsStops.feedId, feedId), inArray(gtfsStops.stopId, terminusIds.slice(i, i + CHUNK))));
    terminusCoords.push(...rows);
  }

  // 7. Fermate cluster
  let clusterStops: typeof stopClusterStops.$inferSelect[] = [];
  if (Array.isArray(clusterIds) && clusterIds.length > 0) {
    clusterStops = await db.select().from(stopClusterStops).where(inArray(stopClusterStops.clusterId, clusterIds));
    clusterStops = clusterStops.filter(s => s.stopLat != null && s.stopLon != null);
  }

  // 8. Nodi
  const nodes: DeadheadNode[] = [];
  nodes.push({ id: "depot:" + depot.id, type: "depot", name: depot.name, lat: depot.lat!, lon: depot.lon! });

  const usedStopIds = new Set<string>();
  for (const s of terminusCoords) {
    if (usedStopIds.has(s.stopId)) continue;
    usedStopIds.add(s.stopId);
    nodes.push({ id: "terminus:" + s.stopId, type: "terminus", name: s.stopName, lat: s.stopLat, lon: s.stopLon, routeIds: [...(terminusMap.get(s.stopId) ?? [])] });
  }
  for (const s of clusterStops) {
    if (s.gtfsStopId && usedStopIds.has(s.gtfsStopId)) continue;
    if (s.gtfsStopId) usedStopIds.add(s.gtfsStopId);
    nodes.push({ id: "cluster:" + s.clusterId + ":" + (s.gtfsStopId ?? s.id), type: "cluster", name: s.stopName ?? s.gtfsStopId ?? "Fermata", lat: Number(s.stopLat), lon: Number(s.stopLon) });
  }

  // 9. Matrice
  const deadheads: Deadhead[] = [];
  for (const from of nodes) {
    for (const to of nodes) {
      if (from.id === to.id) continue;
      const crow      = haversineKm(from.lat, from.lon, to.lat, to.lon);
      const roadKm    = Math.round(crow * ROAD_FACTOR * 100) / 100;
      const durMin    = Math.round((roadKm / BUS_SPEED_KMH) * 60);
      const costEur   = Math.round(roadKm * Number(costPerKm) * 100) / 100;
      deadheads.push({ id: from.id + ">" + to.id, fromId: from.id, toId: to.id, distanceKm: roadKm, durationMin: durMin, costEur, overridden: false });
    }
  }
  deadheads.sort((a, b) => b.costEur - a.costEur);

  res.json({ nodes, deadheads });
}));

export default router;
