/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SIRI → schema `caronte`: l'ingestione del dato di esercizio
 * ───────────────────────────────────────────────────────────────────────────
 * Scrive le VehicleActivity già normalizzate e agganciate (siri-vm.ts) nelle
 * tre tabelle che Sala Operativa, Tempi di percorrenza e GTFS-RT leggono già:
 *
 *   VehicleLocation                      → caronte.vehicle_positions
 *   FramedVehicleJourneyRef + VehicleRef → caronte.active_trips
 *   PreviousCalls (aimed vs actual)      → caronte.stop_transits
 *
 * L'ultima riga è il motivo per cui questo modulo esiste: `stop_transits` non
 * aveva alcun alimentatore nel software, ed è la tabella su cui poggiano la
 * puntualità, il confronto percorrenze programmate/osservate e i TripUpdates.
 *
 * Qui c'è SOLO l'accesso al database: la logica di corrispondenza e di
 * normalizzazione sta in siri-vm.ts, dove si collauda senza Postgres.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { getLatestFeedId } from "../routes/gtfs-helpers";
import {
  mapVehicles, resolveCancelledTrip, normalizeLineCode, normalizeStopName,
  type GtfsIndex, type MappingReport, type SiriVehicle,
} from "./siri-vm";

/* ── Indice degli identificativi del feed attivo ──────────────────────────── */

let cachedIndex: GtfsIndex | null = null;
const INDEX_TTL_MS = 10 * 60 * 1000;

export async function loadGtfsIndex(force = false): Promise<GtfsIndex | null> {
  const feedId = process.env.GTFS_FEED_ID || (await getLatestFeedId());
  if (!feedId) return null;
  if (!force && cachedIndex && cachedIndex.feedId === feedId
      && Date.now() - cachedIndex.loadedAt < INDEX_TTL_MS) {
    return cachedIndex;
  }
  const [tripsR, stopsR, routesR] = await Promise.all([
    db.execute<any>(sql`
      SELECT trip_id, route_id FROM gtfs_trips WHERE feed_id = ${feedId}::uuid`),
    db.execute<any>(sql`
      SELECT stop_id, stop_name FROM gtfs_stops WHERE feed_id = ${feedId}::uuid`),
    db.execute<any>(sql`
      SELECT route_id, route_short_name FROM gtfs_routes WHERE feed_id = ${feedId}::uuid`),
  ]);
  const trips = new Set<string>();
  const routes = new Set<string>();
  const tripRoute = new Map<string, string>();
  for (const r of ((tripsR as any).rows ?? [])) {
    const t = String(r.trip_id);
    trips.add(t);
    if (r.route_id != null) { routes.add(String(r.route_id)); tripRoute.set(t, String(r.route_id)); }
  }

  /* Il numero di linea può stare nell'id o nel nome breve, a seconda di come
   * il feed è stato costruito: si indicizzano entrambi, normalizzati. */
  const routeByCode = new Map<string, string>();
  for (const r of ((routesR as any).rows ?? [])) {
    const id = String(r.route_id);
    routes.add(id);
    routeByCode.set(normalizeLineCode(id), id);
    if (r.route_short_name) routeByCode.set(normalizeLineCode(String(r.route_short_name)), id);
  }
  for (const id of routes) if (!routeByCode.has(normalizeLineCode(id))) routeByCode.set(normalizeLineCode(id), id);

  const stops = new Set<string>();
  const stopNames = new Map<string, string>();
  const stopByName = new Map<string, string>();
  for (const r of ((stopsR as any).rows ?? [])) {
    const id = String(r.stop_id);
    stops.add(id);
    if (r.stop_name) {
      stopNames.set(id, String(r.stop_name));
      // primo vincitore: i capolinea omonimi non devono sovrascrivere la banchina
      const k = normalizeStopName(String(r.stop_name));
      if (k && !stopByName.has(k)) stopByName.set(k, id);
    }
  }

  cachedIndex = {
    feedId, trips, routes, stops, tripRoute, routeByCode, stopNames, stopByName,
    loadedAt: Date.now(),
  };
  return cachedIndex;
}

/* ── Velocità stimata ─────────────────────────────────────────────────────── */

/** Ultima posizione per mezzo: questo profilo SIRI non espone la velocità. */
const lastFix = new Map<string, { lat: number; lon: number; t: number }>();

function speedKmh(vehicleId: string, lat: number, lon: number, t: number): number | null {
  const prev = lastFix.get(vehicleId);
  lastFix.set(vehicleId, { lat, lon, t });
  if (!prev) return null;
  const dt = (t - prev.t) / 1000;
  if (dt <= 1 || dt > 600) return null; // intervalli troppo brevi o troppo lunghi: non stimabile
  const R = 6371, toRad = Math.PI / 180;
  const dLat = (lat - prev.lat) * toRad;
  const dLon = (lon - prev.lon) * toRad;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(prev.lat * toRad) * Math.cos(lat * toRad) * Math.sin(dLon / 2) ** 2;
  const km = 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  const kmh = (km / dt) * 3600;
  return kmh > 130 ? null : Math.round(kmh * 10) / 10; // scarta i salti GPS
}

/* ── Scrittura ────────────────────────────────────────────────────────────── */

export interface IngestResult {
  positionsInserted: number;
  tripsOpened: number;
  tripsClosed: number;
  transitsInserted: number;
  report: MappingReport;
}

export async function ingestVehicles(vehicles: SiriVehicle[]): Promise<IngestResult> {
  const index = await loadGtfsIndex();
  if (!index) {
    return {
      positionsInserted: 0, tripsOpened: 0, tripsClosed: 0, transitsInserted: 0,
      report: {
        vehicles: vehicles.length, withPosition: 0, tripMatched: 0, routeMatched: 0,
        stopMatched: 0, transitsFound: 0, transitsMatched: 0,
        routeMatchedByPublishedName: 0, routeMatchedByRouteRef: 0, routeMatchedByRef: 0,
        stopMatchedById: 0, stopMatchedByName: 0, stopIdNameConflicts: [],
        unmatchedTripRefs: [], unmatchedLineRefs: [], unmatchedLines: [],
        unmatchedStopRefs: [],
      },
    };
  }
  const { mapped, report } = mapVehicles(vehicles, index);

  let positionsInserted = 0, tripsOpened = 0, tripsClosed = 0, transitsInserted = 0;

  for (const m of mapped) {
    const v = m.siri;
    const vehicleId = v.vehicleRef ?? null;
    const ts = v.recordedAt ?? new Date();

    /* 1. Posizione. Dedup su (mezzo, istante): il poller gira più spesso di
     *    quanto l'AVM aggiorni, e senza questo la tabella si riempirebbe di
     *    copie dello stesso rilevamento. */
    if (v.lat != null && v.lon != null) {
      const sp = vehicleId ? speedKmh(vehicleId, v.lat, v.lon, ts.getTime()) : null;
      const r = await db.execute<any>(sql`
        INSERT INTO caronte.vehicle_positions
               (vehicle_id, trip_id, ts, lat, lon, nearest_stop_id, speed, heading)
        SELECT ${vehicleId}, ${m.tripId}, ${ts.toISOString()}::timestamptz,
               ${v.lat}, ${v.lon}, ${m.nearestStopId}, ${sp}, ${v.bearing}
         WHERE NOT EXISTS (
           SELECT 1 FROM caronte.vehicle_positions p
            WHERE p.vehicle_id IS NOT DISTINCT FROM ${vehicleId}
              AND p.ts = ${ts.toISOString()}::timestamptz)`);
      positionsInserted += (r as any).rowCount ?? 0;
    }

    /* 2. Corsa in servizio. Una sola aperta per mezzo: se l'AVM dichiara una
     *    corsa diversa da quella aperta, la precedente si chiude. */
    if (vehicleId && m.tripId) {
      const closed = await db.execute<any>(sql`
        UPDATE caronte.active_trips
           SET ended_at = ${ts.toISOString()}::timestamptz
         WHERE vehicle_id = ${vehicleId} AND ended_at IS NULL
           AND trip_id IS DISTINCT FROM ${m.tripId}`);
      tripsClosed += (closed as any).rowCount ?? 0;

      const opened = await db.execute<any>(sql`
        INSERT INTO caronte.active_trips (trip_id, route_id, vehicle_id, device_id, started_at)
        SELECT ${m.tripId}, ${m.routeId}, ${vehicleId}, ${"siri"},
               ${(v.originAimedDeparture ?? ts).toISOString()}::timestamptz
         WHERE NOT EXISTS (
           SELECT 1 FROM caronte.active_trips a
            WHERE a.vehicle_id = ${vehicleId} AND a.trip_id = ${m.tripId}
              AND a.ended_at IS NULL)`);
      tripsOpened += (opened as any).rowCount ?? 0;
    }

    /* 3. Transiti reali. Dedup su (corsa, fermata, sequenza) nella giornata:
     *    lo stesso PreviousCall torna a ogni interrogazione finché la corsa
     *    è in servizio. */
    if (m.tripId) {
      for (const t of m.transits) {
        const r = await db.execute<any>(sql`
          INSERT INTO caronte.stop_transits
                 (trip_id, route_id, vehicle_id, device_id, stop_id, stop_seq,
                  scheduled, actual_ts, delay_seconds, lat, lon)
          SELECT ${m.tripId}, ${m.routeId}, ${vehicleId}, ${"siri"},
                 ${t.stopId}, ${t.stopSeq}, ${t.scheduled},
                 ${t.actualTs.toISOString()}::timestamptz, ${t.delaySeconds},
                 ${v.lat}, ${v.lon}
           WHERE NOT EXISTS (
             SELECT 1 FROM caronte.stop_transits s
              WHERE s.trip_id = ${m.tripId} AND s.stop_id = ${t.stopId}
                AND s.stop_seq IS NOT DISTINCT FROM ${t.stopSeq}
                AND s.actual_ts > now() - interval '18 hours')`);
        transitsInserted += (r as any).rowCount ?? 0;
      }
    }
  }

  return { positionsInserted, tripsOpened, tripsClosed, transitsInserted, report };
}

/** Chiude le corse annullate dall'AVM (VehicleActivityCancellation). */
export async function closeCancelled(
  cancellations: Array<{ vehicleRef: string | null; journeyRef: string | null }>,
): Promise<number> {
  if (cancellations.length === 0) return 0;
  const index = await loadGtfsIndex();
  if (!index) return 0;
  let n = 0;
  for (const c of cancellations) {
    const tripId = resolveCancelledTrip(c.journeyRef, index);
    if (!tripId) continue;
    const r = await db.execute<any>(sql`
      UPDATE caronte.active_trips SET ended_at = now()
       WHERE trip_id = ${tripId} AND ended_at IS NULL`);
    n += (r as any).rowCount ?? 0;
  }
  return n;
}
