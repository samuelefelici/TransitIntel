/**
 * GTFS Fares V2 — Bigliettazione Elettronica
 *
 * Endpoints:
 * GET    /api/fares/networks                — list networks
 * POST   /api/fares/networks/seed           — seed default 4 networks
 * GET    /api/fares/route-networks           — list route↔network assignments
 * POST   /api/fares/route-networks/auto-classify — auto-classify routes
 * PUT    /api/fares/route-networks/:routeId  — manual re-assign
 * POST   /api/fares/route-networks/bulk      — bulk save all assignments
 * GET    /api/fares/media                    — list fare media
 * POST   /api/fares/media/seed              — seed default media
 * PUT    /api/fares/media/:fareMediaId       — toggle active / edit
 * GET    /api/fares/rider-categories         — list categories
 * POST   /api/fares/rider-categories/seed   — seed default
 * POST   /api/fares/rider-categories         — add new
 * PUT    /api/fares/rider-categories/:id    — update
 * DELETE /api/fares/rider-categories/:id     — delete
 * GET    /api/fares/calendar                 — list calendar entries
 * POST   /api/fares/calendar/seed           — seed Feriale/Sabato/Festivo
 * POST   /api/fares/calendar                 — add new entry
 * PUT    /api/fares/calendar/:id            — update entry
 * DELETE /api/fares/calendar/:id            — delete entry
 * GET    /api/fares/calendar-dates           — list exceptions
 * POST   /api/fares/calendar-dates           — add exception
 * DELETE /api/fares/calendar-dates/:id      — delete exception
 * GET    /api/fares/products                 — list fare products
 * POST   /api/fares/products/seed           — seed default products (urban + extraurban)
 * PUT    /api/fares/products/:id            — update price
 * GET    /api/fares/areas                    — list areas
 * GET    /api/fares/stop-areas               — list stop↔area
 * POST   /api/fares/zones/generate/:routeId — generate zones for an extraurban route
 * POST   /api/fares/zones/generate-all      — generate zones for ALL extraurban routes
 * PUT    /api/fares/stop-areas/:id          — manual override
 * GET    /api/fares/leg-rules               — list leg rules
 * POST   /api/fares/leg-rules/generate      — generate all leg rules from areas+products
 * GET    /api/fares/transfer-rules          — list transfer rules
 * POST   /api/fares/generate-gtfs           — generate all GTFS Fares V2 CSV files
 * POST   /api/fares/simulate                — simulate ticket price for OD pair
 */
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  gtfsFeeds, gtfsRoutes, gtfsStops, gtfsTrips, gtfsStopTimes, gtfsShapes,
  gtfsCalendar, gtfsCalendarDates,
  gtfsFareNetworks, gtfsRouteNetworks, gtfsFareMedia, gtfsRiderCategories,
  gtfsFareProducts, gtfsFareAreas, gtfsStopAreas, gtfsFareLegRules, gtfsFareTransferRules,
  gtfsTimeframes, gtfsFareAttributes, gtfsFareRules,
  gtfsFareZoneClusters, gtfsFareZoneClusterStops,
  gtfsFeedInfo,
  gtfsFareAuditLog,
} from "@workspace/db/schema";
import { eq, and, sql, inArray, desc } from "drizzle-orm";
import { getLatestFeedId } from "./gtfs-helpers";
import { haversineKm } from "../lib/geo-utils";
import AdmZip from "adm-zip";

const router: IRouter = Router();

// ═══════════════════════════════════════════════════════════
// HELPER: classify a route_short_name into a default network
// ═══════════════════════════════════════════════════════════
function classifyRoute(shortName: string): string {
  if (!shortName) return "extraurbano";
  const s = shortName.trim().toUpperCase();

  // Urbano Jesi — starts with "JE"
  if (s.startsWith("JE")) return "urbano_jesi";

  // Urbano Falconara — starts with "Y"
  if (s.startsWith("Y")) return "urbano_falconara";

  // Urbano Senigallia — BUS* e BUSS* (es. BUS3, BUS5, BUS6, BUS7, BUS8, BUS10, BUS87, BUSS2, BUSS3)
  if (/^BUSS?\d/.test(s)) return "urbano_senigallia";

  // Urbano Castelfidardo — CIRCA e CIRCB
  if (s === "CIRCA" || s === "CIRCB") return "urbano_castelfidardo";

  // Urbano Ancona — starts with a digit, OR is C.D., C.S., or similar single-letter+dot combos
  if (/^\d/.test(s)) return "urbano_ancona";
  if (/^[A-Z]\.[A-Z]\.?$/.test(s)) return "urbano_ancona"; // C.D., C.S., etc.

  // Everything else → extraurbano
  return "extraurbano";
}

// ═══════════════════════════════════════════════════════════
// The 23 extraurban fare bands (DGR Regione Marche)
// ═══════════════════════════════════════════════════════════
const EXTRA_BANDS: { fascia: number; kmFrom: number; kmTo: number; price: number }[] = [
  { fascia: 1, kmFrom: 0, kmTo: 6, price: 1.35 },
  { fascia: 2, kmFrom: 6, kmTo: 12, price: 1.85 },
  { fascia: 3, kmFrom: 12, kmTo: 18, price: 2.35 },
  { fascia: 4, kmFrom: 18, kmTo: 24, price: 2.85 },
  { fascia: 5, kmFrom: 24, kmTo: 30, price: 3.20 },
  { fascia: 6, kmFrom: 30, kmTo: 36, price: 3.55 },
  { fascia: 7, kmFrom: 36, kmTo: 42, price: 3.90 },
  { fascia: 8, kmFrom: 42, kmTo: 50, price: 4.25 },
  { fascia: 9, kmFrom: 50, kmTo: 60, price: 4.55 },
  { fascia: 10, kmFrom: 60, kmTo: 70, price: 4.85 },
  { fascia: 11, kmFrom: 70, kmTo: 80, price: 5.15 },
  { fascia: 12, kmFrom: 80, kmTo: 90, price: 5.45 },
  { fascia: 13, kmFrom: 90, kmTo: 100, price: 5.75 },
  { fascia: 14, kmFrom: 100, kmTo: 110, price: 6.05 },
  { fascia: 15, kmFrom: 110, kmTo: 120, price: 6.35 },
  { fascia: 16, kmFrom: 120, kmTo: 130, price: 6.65 },
  { fascia: 17, kmFrom: 130, kmTo: 140, price: 6.95 },
  { fascia: 18, kmFrom: 140, kmTo: 150, price: 7.25 },
  { fascia: 19, kmFrom: 150, kmTo: 160, price: 7.55 },
  { fascia: 20, kmFrom: 160, kmTo: 170, price: 7.85 },
  { fascia: 21, kmFrom: 170, kmTo: 180, price: 8.15 },
  { fascia: 22, kmFrom: 180, kmTo: 190, price: 8.45 },
  { fascia: 23, kmFrom: 190, kmTo: 200, price: 8.75 },
];

function getBandForDistance(distKm: number): typeof EXTRA_BANDS[0] | undefined {
  return EXTRA_BANDS.find(b => distKm > b.kmFrom && distKm <= b.kmTo)
    ?? (distKm <= 0 ? undefined : EXTRA_BANDS[EXTRA_BANDS.length - 1]);
}

// ═══════════════════════════════════════════════════════════
// HELPER: Percorsi distinti per linea (DGR 1036/2022 art. 2.d)
// Deduplicazione su (stop_ids_signature + shape_id) per gestire
// sia varianti di fermata sia percorsi stradali diversi
// ═══════════════════════════════════════════════════════════

interface Percorso {
  tripId: string;
  shapeId: string | null;
  tripCount: number; // quante corse (trip) usano questo percorso distinto nel giorno di riferimento
  stops: {
    stop_id: string;
    stop_sequence: number;
    lat: number;
    lon: number;
    stop_name: string;
  }[];
  shapeCoords: [number, number][] | null; // [lon, lat] pairs from GeoJSON
}

interface PercorsiResult {
  percorsi: Percorso[];
  refServiceId: string;  // service_id di riferimento (giorno con più corse)
  totalTripsDay: number; // totale corse nel giorno di riferimento
}

async function getRoutePercorsi(feedId: string, routeId: string): Promise<PercorsiResult> {
  // ── STEP 1: Trova il service_id più rappresentativo (= giorno feriale tipo) ──
  // È il service_id con il maggior numero di trip per questa route.
  // Questo evita di mescolare calendari diversi (feriale, festivo, estivo…)
  // e dà il conteggio corse/giorno reale.
  const svcRows = await db.execute<any>(sql`
    SELECT t.service_id, COUNT(*) AS cnt
    FROM gtfs_trips t
    WHERE t.feed_id = ${feedId} AND t.route_id = ${routeId}
    GROUP BY t.service_id
    ORDER BY cnt DESC
    LIMIT 1
  `);
  if (svcRows.rows.length === 0) return { percorsi: [], refServiceId: "", totalTripsDay: 0 };
  const refServiceId: string = svcRows.rows[0].service_id;

  // ── STEP 1b: Tutti i trip di quel service_id ──
  const tripRows = await db.execute<any>(sql`
    SELECT t.trip_id, t.shape_id
    FROM gtfs_trips t
    WHERE t.feed_id = ${feedId} AND t.route_id = ${routeId}
      AND t.service_id = ${refServiceId}
  `);
  if (tripRows.rows.length === 0) return { percorsi: [], refServiceId, totalTripsDay: 0 };

  const tripIds = tripRows.rows.map((r: any) => r.trip_id);
  const tripShapeMap = new Map<string, string | null>(
    tripRows.rows.map((r: any) => [r.trip_id, r.shape_id ?? null])
  );

  // ── STEP 2: Tutte le fermate dei trip selezionati ──
  const tripIdParams = sql.join(tripIds.map((id: string) => sql`${id}`), sql`, `);
  const allStopsData = await db.execute<any>(sql`
    SELECT st.trip_id, st.stop_id, st.stop_sequence,
           s.stop_lat::float AS lat, s.stop_lon::float AS lon, s.stop_name
    FROM gtfs_stop_times st
    JOIN gtfs_stops s ON s.stop_id = st.stop_id AND s.feed_id = st.feed_id
    WHERE st.feed_id = ${feedId}
      AND st.trip_id IN (${tripIdParams})
    ORDER BY st.trip_id, st.stop_sequence
  `);

  // Raggruppa le fermate per trip_id
  const tripStopsMap = new Map<string, any[]>();
  for (const row of allStopsData.rows) {
    if (!tripStopsMap.has(row.trip_id)) tripStopsMap.set(row.trip_id, []);
    tripStopsMap.get(row.trip_id)!.push(row);
  }

  // ── STEP 3: Deduplicazione e raccolta shape_id univoci ──
  // Conta quanti trip (corse) condividono lo stesso percorso (signature)
  const signatureCount = new Map<string, number>();
  const seenSignatures = new Set<string>();
  const uniqueTrips: { tripId: string; shapeId: string | null; stops: any[]; signature: string }[] = [];
  const neededShapeIds = new Set<string>();

  // Prima passata: calcola tutte le signature e conta le occorrenze
  for (const tripId of tripIds) {
    const stops = tripStopsMap.get(tripId);
    if (!stops || stops.length === 0) continue;
    const shapeId = tripShapeMap.get(tripId) ?? null;
    const stopSeqSig = stops.map((s: any) => s.stop_id).join("|");
    const signature = `${stopSeqSig}::${shapeId ?? "noshape"}`;
    signatureCount.set(signature, (signatureCount.get(signature) ?? 0) + 1);
  }

  // Ordina trip per numero fermate decrescente (preferisci il più lungo come rappresentante)
  const sortedTripIds = [...tripStopsMap.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([tid]) => tid);

  for (const tripId of sortedTripIds) {
    const stops = tripStopsMap.get(tripId);
    if (!stops || stops.length === 0) continue;

    const shapeId = tripShapeMap.get(tripId) ?? null;
    const stopSeqSig = stops.map((s: any) => s.stop_id).join("|");
    const signature = `${stopSeqSig}::${shapeId ?? "noshape"}`;
    if (seenSignatures.has(signature)) continue;
    seenSignatures.add(signature);

    uniqueTrips.push({ tripId, shapeId, stops, signature });
    if (shapeId) neededShapeIds.add(shapeId);
  }

  // ── STEP 4: Carica tutte le shape necessarie in una sola query ──
  const shapeCache = new Map<string, [number, number][] | null>();
  if (neededShapeIds.size > 0) {
    const shapeIdsArr = Array.from(neededShapeIds);
    // Use IN (...) with sql.join for proper parameterization
    const shapeIdParams = sql.join(shapeIdsArr.map(id => sql`${id}`), sql`, `);
    const shapeRows = await db.execute<any>(sql`
      SELECT shape_id, geojson FROM gtfs_shapes
      WHERE feed_id = ${feedId} AND shape_id IN (${shapeIdParams})
    `);
    for (const row of shapeRows.rows) {
      const geo = row.geojson;
      const coords: [number, number][] | null =
        geo?.geometry?.coordinates ??
        geo?.coordinates ??
        (geo?.type === "LineString" ? geo.coordinates : null);
      shapeCache.set(row.shape_id, coords ?? null);
    }
  }

  // ── STEP 5: Assembla i percorsi ──
  const percorsi: Percorso[] = uniqueTrips.map(({ tripId, shapeId, stops, signature }) => ({
    tripId,
    shapeId,
    tripCount: signatureCount.get(signature) ?? 1,
    stops,
    shapeCoords: shapeId ? (shapeCache.get(shapeId) ?? null) : null,
  }));

  const totalTripsDay = tripIds.length; // tutte le corse del service_id di riferimento
  return { percorsi, refServiceId, totalTripsDay };
}

/**
 * Rev.3 — Seleziona il percorso dominante (quello con più corse giornaliere)
 * all'interno di una famiglia direzionale (stessa prima/ultima fermata del
 * percorso più lungo). Restituisce anche i percorsi alternativi.
 */
function getDominantPercorso(allPercorsi: Percorso[]) {
  if (allPercorsi.length === 0) return { dominant: null, altPercorsi: [], dirPercorsi: [] };

  // Famiglia direzionale: stessa prima/ultima fermata del percorso più lungo
  const ref = allPercorsi.reduce((a, b) => a.stops.length >= b.stops.length ? a : b);
  const refFirst = ref.stops[0]?.stop_id;
  const refLast  = ref.stops[ref.stops.length - 1]?.stop_id;
  const dirPercorsi = allPercorsi.filter(p => {
    const f = p.stops[0]?.stop_id;
    const l = p.stops[p.stops.length - 1]?.stop_id;
    return f === refFirst && l === refLast;
  });
  const filtered = dirPercorsi.length > 0 ? dirPercorsi : allPercorsi;

  // Dominante = quello con più corse (tripCount massimo)
  const dominant = filtered.reduce((a, b) => a.tripCount >= b.tripCount ? a : b);
  const altPercorsi = filtered.filter(p => p.tripId !== dominant.tripId);

  return { dominant, altPercorsi, dirPercorsi: filtered };
}

/**
 * Tra tutti i percorsi di una linea, restituisce il dominante (max tripCount)
 * tra quelli che contengono ENTRAMBE le fermate fromStopId e toStopId.
 *
 * Diverso da getDominantPercorso, che usa il dominante globale della linea
 * indipendentemente dall'OD richiesto.
 *
 * Ritorna null se nessun percorso della linea contiene entrambe le fermate.
 */
function getDominantPercorsoForOD(
  allPercorsi: Percorso[],
  fromStopId: string,
  toStopId: string,
): {
  dominant: Percorso;
  capolineaFirst: string;
  capolineaLast: string;
  tripCount: number;
} | null {
  // Filtra i percorsi che contengono entrambe le fermate OD
  const qualifying = allPercorsi.filter(p => {
    const ids = new Set(p.stops.map(s => s.stop_id));
    return ids.has(fromStopId) && ids.has(toStopId);
  });

  if (qualifying.length === 0) return null;

  // Tra quelli qualificati, prendi il dominante (tripCount massimo)
  const dominant = qualifying.reduce((a, b) => a.tripCount >= b.tripCount ? a : b);

  return {
    dominant,
    capolineaFirst: dominant.stops[0].stop_id,
    capolineaLast: dominant.stops[dominant.stops.length - 1].stop_id,
    tripCount: dominant.tripCount,
  };
}

/**
 * Trova le linee a cui si applica la Regola 2 della DGR 1036/2022.
 *
 * Rev.4b — Il dominante usato per raggruppare NON è quello globale della linea
 * ma quello filtrato per OD: il percorso con più corse che contiene entrambe
 * le fermate richieste. Questo evita di escludere linee "miste" (es. Linea O
 * che fa sia Ancona→Osimo sia Osimo→Offagna) solo perché il loro dominante
 * globale non copre la relazione richiesta.
 *
 * Le linee vengono raggruppate per (capolinea_first, capolinea_last) del
 * percorso dominante OD. Si restituisce il gruppo con più linee;
 * a parità, quello con più corse OD totali.
 */
async function findApplicableRoutes(
  feedId: string,
  fromStopId: string,
  toStopId: string,
): Promise<{
  ruleApplied: "regola1" | "regola2";
  routes: {
    routeId: string;
    km: number;
    fromKm: number;
    toKm: number;
    totalPathKm: number;
    dominantTripCount: number;
    dominantShapeId: string | null;
    totalTripsDay: number;
    capolinea: { first: string; last: string };
    fromInfo: { name: string; lat: number; lon: number; km: number };
    toInfo: { name: string; lat: number; lon: number; km: number };
    intermediateStops: { stopId: string; stopName: string; lat: number; lon: number; km: number }[];
  }[];
}> {
  // 1. Trova tutte le linee extraurbane i cui trip passano per entrambe le fermate
  const candidateRows = await db.execute<any>(sql`
    SELECT DISTINCT t.route_id
    FROM gtfs_trips t
    JOIN gtfs_stop_times st1
      ON st1.trip_id = t.trip_id AND st1.feed_id = t.feed_id AND st1.stop_id = ${fromStopId}
    JOIN gtfs_stop_times st2
      ON st2.trip_id = t.trip_id AND st2.feed_id = t.feed_id AND st2.stop_id = ${toStopId}
    JOIN gtfs_route_networks rn
      ON rn.route_id = t.route_id AND rn.feed_id = t.feed_id
    WHERE t.feed_id = ${feedId} AND rn.network_id = 'extraurbano'
  `);

  if (candidateRows.rows.length === 0) {
    return { ruleApplied: "regola1", routes: [] };
  }

  // 2. Per ogni linea candidata: trova il dominante tra i percorsi che servono l'OD
  const routeData: {
    routeId: string;
    km: number;
    totalPathKm: number;
    fromKm: number;
    toKm: number;
    dominantTripCount: number;
    dominantShapeId: string | null;
    totalTripsDay: number;
    capolinea: { first: string; last: string };
    fromInfo: { name: string; lat: number; lon: number; km: number };
    toInfo: { name: string; lat: number; lon: number; km: number };
    intermediateStops: { stopId: string; stopName: string; lat: number; lon: number; km: number }[];
  }[] = [];

  for (const row of candidateRows.rows) {
    const { percorsi: allPercorsi, totalTripsDay } = await getRoutePercorsi(feedId, row.route_id);
    if (allPercorsi.length === 0) continue;

    // ← CAMBIAMENTO CHIAVE: dominante filtrato per OD, non globale
    const odResult = getDominantPercorsoForOD(allPercorsi, fromStopId, toStopId);
    if (!odResult) continue;

    const { dominant, capolineaFirst, capolineaLast } = odResult;

    const kmMap = computeKmAlongShape(dominant.stops, dominant.shapeCoords);
    const fromInfo = kmMap.get(fromStopId);
    const toInfo = kmMap.get(toStopId);
    if (!fromInfo || !toInfo) continue;

    const km = Math.round(Math.abs(toInfo.km - fromInfo.km) * 100) / 100;
    const fromIdx = dominant.stops.findIndex(s => s.stop_id === fromStopId);
    const toIdx   = dominant.stops.findIndex(s => s.stop_id === toStopId);
    const minIdx  = Math.min(fromIdx, toIdx);
    const maxIdx  = Math.max(fromIdx, toIdx);

    // km progressivi dell'ultimo stop del percorso dominante (lunghezza totale)
    const lastStopInfo = kmMap.get(dominant.stops[dominant.stops.length - 1].stop_id);
    const totalPathKm = Math.round((lastStopInfo?.km ?? km) * 100) / 100;

    routeData.push({
      routeId: row.route_id,
      km,
      totalPathKm,
      fromKm: fromInfo.km,
      toKm:   toInfo.km,
      dominantTripCount: dominant.tripCount,
      dominantShapeId:   dominant.shapeId,
      totalTripsDay,
      capolinea: { first: capolineaFirst, last: capolineaLast },
      fromInfo: { name: fromInfo.name, lat: fromInfo.lat, lon: fromInfo.lon, km: fromInfo.km },
      toInfo:   { name: toInfo.name,   lat: toInfo.lat,   lon: toInfo.lon,   km: toInfo.km   },
      intermediateStops: dominant.stops.slice(minIdx, maxIdx + 1).map(s => ({
        stopId:   s.stop_id,
        stopName: s.stop_name,
        lat: s.lat,
        lon: s.lon,
        km: kmMap.get(s.stop_id)!.km,
      })),
    });
  }

  if (routeData.length === 0) {
    return { ruleApplied: "regola1", routes: [] };
  }

  // 3. Raggruppa per (capolinea_first, capolinea_last) — normalizzato per direzione
  const groups = new Map<string, typeof routeData>();
  for (const r of routeData) {
    const key = [r.capolinea.first, r.capolinea.last].sort().join("||");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }

  // 4. Prendi il gruppo con più linee — a parità, quello con più corse OD totali
  let bestGroup: typeof routeData = [];
  let bestScore = -1;
  for (const group of groups.values()) {
    const score = group.length * 1_000_000 +
      group.reduce((s, r) => s + r.dominantTripCount, 0);
    if (score > bestScore) {
      bestScore = score;
      bestGroup = group;
    }
  }

  return {
    ruleApplied: bestGroup.length >= 2 ? "regola2" : "regola1",
    routes: bestGroup,
  };
}

/**
 * Calcola la distanza progressiva di ogni fermata lungo il percorso.
 *
 * Se shapeCoords è disponibile:
 *   Per ogni fermata, trova il punto dello shape più vicino (proiezione)
 *   e accumula la distanza percorsa lungo i segmenti dello shape fino a quel punto.
 *
 * Se shapeCoords è null:
 *   Fallback: haversine tra fermate consecutive (comportamento precedente).
 */
function computeKmAlongShape(
  stops: Percorso["stops"],
  shapeCoords: [number, number][] | null
): Map<string, { km: number; name: string; lat: number; lon: number }> {
  const result = new Map<string, { km: number; name: string; lat: number; lon: number }>();

  if (!shapeCoords || shapeCoords.length < 2) {
    // Fallback: haversine tra fermate consecutive
    let cumKm = 0;
    for (let i = 0; i < stops.length; i++) {
      if (i > 0) {
        cumKm += haversineKm(stops[i - 1].lat, stops[i - 1].lon, stops[i].lat, stops[i].lon);
      }
      result.set(stops[i].stop_id, {
        km: Math.round(cumKm * 100) / 100,
        name: stops[i].stop_name,
        lat: stops[i].lat,
        lon: stops[i].lon,
      });
    }
    return result;
  }

  // Calcola distanze cumulative lungo i segmenti dello shape
  // shapeCoords = [[lon0,lat0],[lon1,lat1],...]
  const shapeCumKm: number[] = [0];
  for (let i = 1; i < shapeCoords.length; i++) {
    const [lon0, lat0] = shapeCoords[i - 1];
    const [lon1, lat1] = shapeCoords[i];
    shapeCumKm.push(shapeCumKm[i - 1] + haversineKm(lat0, lon0, lat1, lon1));
  }

  // Per ogni fermata, trova il punto dello shape più vicino (proiezione ortogonale)
  // e leggi la distanza cumulativa dello shape fino a quel punto
  let lastProjectedIdx = 0;

  for (const stop of stops) {
    let bestDist = Infinity;
    let bestShapeIdx = lastProjectedIdx;
    let bestT = 0;

    // Cerca il segmento dello shape più vicino alla fermata
    for (let i = lastProjectedIdx; i < shapeCoords.length - 1; i++) {
      const [lonA, latA] = shapeCoords[i];
      const [lonB, latB] = shapeCoords[i + 1];

      // Proiezione del punto (stop) sul segmento (A→B)
      const dx = lonB - lonA;
      const dy = latB - latA;
      const lenSq = dx * dx + dy * dy;
      let t = 0;
      if (lenSq > 0) {
        t = ((stop.lon - lonA) * dx + (stop.lat - latA) * dy) / lenSq;
        t = Math.max(0, Math.min(1, t));
      }

      const projLon = lonA + t * dx;
      const projLat = latA + t * dy;
      const dist = haversineKm(stop.lat, stop.lon, projLat, projLon);

      if (dist < bestDist) {
        bestDist = dist;
        bestShapeIdx = i;
        bestT = t;
      }

      // Ottimizzazione: se abbiamo trovato un punto molto vicino e stiamo
      // andando troppo lontano, possiamo fermarci
      if (dist > 2 && bestDist < 0.1) break;
    }

    // Distanza cumulativa lungo lo shape fino alla proiezione della fermata
    const kmAtProjection = shapeCumKm[bestShapeIdx] +
      bestT * (shapeCumKm[bestShapeIdx + 1] - shapeCumKm[bestShapeIdx]);

    result.set(stop.stop_id, {
      km: Math.round(kmAtProjection * 100) / 100,
      name: stop.stop_name,
      lat: stop.lat,
      lon: stop.lon,
    });

    lastProjectedIdx = bestShapeIdx;
  }

  return result;
}

// ═══════════════════════════════════════════════════════════
// NETWORKS
// ═══════════════════════════════════════════════════════════

const DEFAULT_NETWORKS = [
  { networkId: "urbano_ancona",        networkName: "Urbano di Ancona" },
  { networkId: "urbano_jesi",          networkName: "Urbano di Jesi" },
  { networkId: "urbano_falconara",     networkName: "Urbano di Falconara" },
  { networkId: "urbano_senigallia",    networkName: "Urbano di Senigallia" },
  { networkId: "urbano_castelfidardo", networkName: "Urbano di Castelfidardo" },
  { networkId: "urbano_sassoferrato",  networkName: "Urbano di Sassoferrato" },
  { networkId: "extraurbano",          networkName: "Extraurbano Provincia di Ancona" },
];

// GET /api/fares/networks
router.get("/fares/networks", async (_req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.json([]); return; }
    const rows = await db.select().from(gtfsFareNetworks).where(eq(gtfsFareNetworks.feedId, feedId));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// POST /api/fares/networks/seed
router.post("/fares/networks/seed", async (_req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.status(400).json({ error: "No GTFS feed found" }); return; }

    for (const n of DEFAULT_NETWORKS) {
      await db.insert(gtfsFareNetworks)
        .values({ feedId, networkId: n.networkId, networkName: n.networkName })
        .onConflictDoUpdate({
          target: [gtfsFareNetworks.feedId, gtfsFareNetworks.networkId],
          set: { networkName: n.networkName, updatedAt: sql`now()` },
        });
    }
    const rows = await db.select().from(gtfsFareNetworks).where(eq(gtfsFareNetworks.feedId, feedId));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// ROUTE–NETWORK CLASSIFICATION
// ═══════════════════════════════════════════════════════════

// GET /api/fares/route-networks
router.get("/fares/route-networks", async (_req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.json([]); return; }

    // Get all routes with their current assignment (if any)
    const routes = await db.select({
      routeId: gtfsRoutes.routeId,
      shortName: gtfsRoutes.routeShortName,
      longName: gtfsRoutes.routeLongName,
      routeColor: gtfsRoutes.routeColor,
    }).from(gtfsRoutes).where(eq(gtfsRoutes.feedId, feedId));

    const assignments = await db.select().from(gtfsRouteNetworks).where(eq(gtfsRouteNetworks.feedId, feedId));
    const assignMap = new Map(assignments.map(a => [a.routeId, a.networkId]));

    const result = routes.map(r => ({
      routeId: r.routeId,
      shortName: r.shortName,
      longName: r.longName,
      routeColor: r.routeColor,
      networkId: assignMap.get(r.routeId) ?? null,
      defaultNetworkId: classifyRoute(r.shortName || ""),
    }));

    res.json(result);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// POST /api/fares/route-networks/auto-classify — apply default classification to all unassigned
router.post("/fares/route-networks/auto-classify", async (_req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.status(400).json({ error: "No GTFS feed" }); return; }

    const routes = await db.select({
      routeId: gtfsRoutes.routeId,
      shortName: gtfsRoutes.routeShortName,
    }).from(gtfsRoutes).where(eq(gtfsRoutes.feedId, feedId));

    let count = 0;
    for (const r of routes) {
      const networkId = classifyRoute(r.shortName || "");
      await db.insert(gtfsRouteNetworks)
        .values({ feedId, routeId: r.routeId, networkId })
        .onConflictDoUpdate({
          target: [gtfsRouteNetworks.feedId, gtfsRouteNetworks.routeId],
          set: { networkId },
        });
      count++;
    }
    res.json({ classified: count });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// PUT /api/fares/route-networks/:routeId — manual reassign
router.put("/fares/route-networks/:routeId", async (req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.status(400).json({ error: "No GTFS feed" }); return; }
    const { networkId } = req.body;
    if (!networkId) { res.status(400).json({ error: "networkId required" }); return; }

    await db.insert(gtfsRouteNetworks)
      .values({ feedId, routeId: req.params.routeId, networkId })
      .onConflictDoUpdate({
        target: [gtfsRouteNetworks.feedId, gtfsRouteNetworks.routeId],
        set: { networkId },
      });
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// POST /api/fares/route-networks/bulk — save all assignments at once
router.post("/fares/route-networks/bulk", async (req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.status(400).json({ error: "No GTFS feed" }); return; }
    const { assignments } = req.body as { assignments: { routeId: string; networkId: string }[] };
    if (!Array.isArray(assignments)) { res.status(400).json({ error: "assignments array required" }); return; }

    let count = 0;
    for (const a of assignments) {
      await db.insert(gtfsRouteNetworks)
        .values({ feedId, routeId: a.routeId, networkId: a.networkId })
        .onConflictDoUpdate({
          target: [gtfsRouteNetworks.feedId, gtfsRouteNetworks.routeId],
          set: { networkId: a.networkId },
        });
      count++;
    }
    res.json({ saved: count });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// FARE MEDIA
// ═══════════════════════════════════════════════════════════

const DEFAULT_MEDIA = [
  // Tipo 0 = nessun supporto fisico (pagamento a bordo / contanti)
  { fareMediaId: "contanti",             fareMediaName: "Pagamento a bordo (contanti/bancomat)", fareMediaType: 0 },
  // Tipo 1 = biglietto fisico / tessera cartacea
  { fareMediaId: "biglietto_cartaceo",   fareMediaName: "Biglietto Cartaceo",                    fareMediaType: 1 },
  { fareMediaId: "tessera_regionale",    fareMediaName: "Tessera Regionale (€5,00 primo abb.)",  fareMediaType: 1 },
  { fareMediaId: "tessera_agevolati",    fareMediaName: "Tessera Agevolati (€2,10 / anno)",      fareMediaType: 1 },
  // Tipo 2 = smart card / carta trasporto
  { fareMediaId: "carta_contactless",    fareMediaName: "Carta Trasporto Contactless",            fareMediaType: 2 },
  // Tipo 3 = carta bancaria cEMV
  { fareMediaId: "cemv",                 fareMediaName: "Carta Bancaria Contactless (cEMV)",      fareMediaType: 3 },
  // Tipo 4 = app mobile
  { fareMediaId: "app_mobile",           fareMediaName: "App Mobile",                             fareMediaType: 4 },
];

router.get("/fares/media", async (_req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.json([]); return; }
    const rows = await db.select().from(gtfsFareMedia).where(eq(gtfsFareMedia.feedId, feedId));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/fares/media/seed", async (_req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.status(400).json({ error: "No GTFS feed" }); return; }
    for (const m of DEFAULT_MEDIA) {
      await db.insert(gtfsFareMedia)
        .values({ feedId, ...m })
        .onConflictDoUpdate({
          target: [gtfsFareMedia.feedId, gtfsFareMedia.fareMediaId],
          set: { fareMediaName: m.fareMediaName, fareMediaType: m.fareMediaType, updatedAt: sql`now()` },
        });
    }
    const rows = await db.select().from(gtfsFareMedia).where(eq(gtfsFareMedia.feedId, feedId));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.put("/fares/media/:fareMediaId", async (req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.status(400).json({ error: "No GTFS feed" }); return; }
    const { isActive, fareMediaName } = req.body;
    const update: Record<string, any> = { updatedAt: sql`now()` };
    if (typeof isActive === "boolean") update.isActive = isActive;
    if (fareMediaName) update.fareMediaName = fareMediaName;

    await db.update(gtfsFareMedia)
      .set(update)
      .where(and(eq(gtfsFareMedia.feedId, feedId), eq(gtfsFareMedia.fareMediaId, req.params.fareMediaId)));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// RIDER CATEGORIES
// ═══════════════════════════════════════════════════════════

router.get("/fares/rider-categories", async (_req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.json([]); return; }
    const rows = await db.select().from(gtfsRiderCategories).where(eq(gtfsRiderCategories.feedId, feedId));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/fares/rider-categories/seed", async (_req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.status(400).json({ error: "No GTFS feed" }); return; }

    // Tutte le categorie passeggero ATMA (DGR Marche + convenzioni locali)
    const categories = [
      { id: "ordinario",           name: "Tariffa Ordinaria",                         isDefault: true,  url: null },
      { id: "studente",            name: "Studente (14+ anni)",                       isDefault: false, url: "https://www.atmaancona.it/abbonamenti-studenti" },
      { id: "studente_under14",    name: "Studente under 14",                         isDefault: false, url: "https://www.atmaancona.it/abbonamenti-studenti" },
      { id: "studente_agevolato",  name: "Studente ISEE < €18.000",                   isDefault: false, url: null },
      { id: "studente_univpm",     name: "Studente UNIVPM (quota studente)",           isDefault: false, url: "https://www.atmaancona.it/abbonamenti-universitari" },
      { id: "anziano",             name: "Over 65 / Argento (fascia morbida)",         isDefault: false, url: null },
      { id: "agevolato",           name: "ISEE < €18.000 (tariffa agevolata)",        isDefault: false, url: null },
    ];

    for (const c of categories) {
      await db.insert(gtfsRiderCategories)
        .values({ feedId, riderCategoryId: c.id, riderCategoryName: c.name, isDefault: c.isDefault, eligibilityUrl: c.url })
        .onConflictDoUpdate({
          target: [gtfsRiderCategories.feedId, gtfsRiderCategories.riderCategoryId],
          set: { riderCategoryName: c.name, isDefault: c.isDefault, eligibilityUrl: c.url, updatedAt: sql`now()` },
        });
    }
    const rows = await db.select().from(gtfsRiderCategories).where(eq(gtfsRiderCategories.feedId, feedId));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/fares/rider-categories", async (req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.status(400).json({ error: "No GTFS feed" }); return; }
    const { riderCategoryId, riderCategoryName, eligibilityUrl } = req.body;
    if (!riderCategoryId || !riderCategoryName) { res.status(400).json({ error: "Missing fields" }); return; }
    await db.insert(gtfsRiderCategories)
      .values({ feedId, riderCategoryId, riderCategoryName, isDefault: false, eligibilityUrl })
      .onConflictDoUpdate({
        target: [gtfsRiderCategories.feedId, gtfsRiderCategories.riderCategoryId],
        set: { riderCategoryName, eligibilityUrl, updatedAt: sql`now()` },
      });
    const rows = await db.select().from(gtfsRiderCategories).where(eq(gtfsRiderCategories.feedId, feedId));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/fares/rider-categories/:id", async (req, res) => {
  try {
    await db.delete(gtfsRiderCategories).where(eq(gtfsRiderCategories.id, req.params.id));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.put("/fares/rider-categories/:id", async (req, res): Promise<void> => {
  try {
    const { riderCategoryName, isDefault, eligibilityUrl } = req.body;
    const update: Record<string, unknown> = { updatedAt: sql`now()` };
    if (riderCategoryName !== undefined) update.riderCategoryName = riderCategoryName;
    if (isDefault !== undefined) update.isDefault = isDefault;
    if (eligibilityUrl !== undefined) update.eligibilityUrl = eligibilityUrl;
    await db.update(gtfsRiderCategories).set(update).where(eq(gtfsRiderCategories.id, req.params.id));
    const feedId = await getLatestFeedId();
    const rows = feedId
      ? await db.select().from(gtfsRiderCategories).where(eq(gtfsRiderCategories.feedId, feedId))
      : [];
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// CALENDAR (service patterns)
// ═══════════════════════════════════════════════════════════

router.get("/fares/calendar", async (_req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.json([]); return; }
    const rows = await db.select().from(gtfsCalendar).where(eq(gtfsCalendar.feedId, feedId));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Seed default service patterns: Feriale, Sabato, Festivo
router.post("/fares/calendar/seed", async (_req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.status(400).json({ error: "No GTFS feed" }); return; }
    const now = new Date();
    const startDate = `${now.getFullYear()}0101`;
    const endDate = `${now.getFullYear()}1231`;
    const templates = [
      { serviceId: "feriale", monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1, saturday: 0, sunday: 0 },
      { serviceId: "sabato", monday: 0, tuesday: 0, wednesday: 0, thursday: 0, friday: 0, saturday: 1, sunday: 0 },
      { serviceId: "festivo", monday: 0, tuesday: 0, wednesday: 0, thursday: 0, friday: 0, saturday: 0, sunday: 1 },
    ];
    for (const t of templates) {
      await db.insert(gtfsCalendar)
        .values({ feedId, ...t, startDate, endDate })
        .onConflictDoUpdate({
          target: [gtfsCalendar.feedId, gtfsCalendar.serviceId],
          set: { monday: t.monday, tuesday: t.tuesday, wednesday: t.wednesday, thursday: t.thursday, friday: t.friday, saturday: t.saturday, sunday: t.sunday, startDate, endDate },
        });
    }
    const rows = await db.select().from(gtfsCalendar).where(eq(gtfsCalendar.feedId, feedId));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/fares/calendar", async (req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.status(400).json({ error: "No GTFS feed" }); return; }
    const { serviceId, monday, tuesday, wednesday, thursday, friday, saturday, sunday, startDate, endDate } = req.body;
    if (!serviceId || !startDate || !endDate) { res.status(400).json({ error: "Missing required fields" }); return; }
    await db.insert(gtfsCalendar)
      .values({ feedId, serviceId, monday: monday ?? 0, tuesday: tuesday ?? 0, wednesday: wednesday ?? 0, thursday: thursday ?? 0, friday: friday ?? 0, saturday: saturday ?? 0, sunday: sunday ?? 0, startDate, endDate })
      .onConflictDoUpdate({
        target: [gtfsCalendar.feedId, gtfsCalendar.serviceId],
        set: { monday: monday ?? 0, tuesday: tuesday ?? 0, wednesday: wednesday ?? 0, thursday: thursday ?? 0, friday: friday ?? 0, saturday: saturday ?? 0, sunday: sunday ?? 0, startDate, endDate },
      });
    const rows = await db.select().from(gtfsCalendar).where(eq(gtfsCalendar.feedId, feedId));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.put("/fares/calendar/:id", async (req, res): Promise<void> => {
  try {
    const { monday, tuesday, wednesday, thursday, friday, saturday, sunday, startDate, endDate } = req.body;
    const update: Record<string, unknown> = {};
    if (monday !== undefined) update.monday = monday;
    if (tuesday !== undefined) update.tuesday = tuesday;
    if (wednesday !== undefined) update.wednesday = wednesday;
    if (thursday !== undefined) update.thursday = thursday;
    if (friday !== undefined) update.friday = friday;
    if (saturday !== undefined) update.saturday = saturday;
    if (sunday !== undefined) update.sunday = sunday;
    if (startDate !== undefined) update.startDate = startDate;
    if (endDate !== undefined) update.endDate = endDate;
    await db.update(gtfsCalendar).set(update).where(eq(gtfsCalendar.id, req.params.id));
    const feedId = await getLatestFeedId();
    const rows = feedId
      ? await db.select().from(gtfsCalendar).where(eq(gtfsCalendar.feedId, feedId))
      : [];
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/fares/calendar/:id", async (req, res) => {
  try {
    await db.delete(gtfsCalendar).where(eq(gtfsCalendar.id, req.params.id));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// CALENDAR DATES (exceptions)
// ═══════════════════════════════════════════════════════════

router.get("/fares/calendar-dates", async (_req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.json([]); return; }
    const rows = await db.select().from(gtfsCalendarDates).where(eq(gtfsCalendarDates.feedId, feedId));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/fares/calendar-dates", async (req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.status(400).json({ error: "No GTFS feed" }); return; }
    const { serviceId, date, exceptionType } = req.body;
    if (!serviceId || !date || !exceptionType) { res.status(400).json({ error: "Missing required fields" }); return; }
    await db.insert(gtfsCalendarDates).values({ feedId, serviceId, date, exceptionType });
    const rows = await db.select().from(gtfsCalendarDates).where(eq(gtfsCalendarDates.feedId, feedId));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/fares/calendar-dates/:id", async (req, res) => {
  try {
    await db.delete(gtfsCalendarDates).where(eq(gtfsCalendarDates.id, req.params.id));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// FARE PRODUCTS
// ═══════════════════════════════════════════════════════════

router.get("/fares/products", async (_req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.json([]); return; }
    const rows = await db.select().from(gtfsFareProducts).where(eq(gtfsFareProducts.feedId, feedId));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/fares/products/seed", async (_req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.status(400).json({ error: "No GTFS feed" }); return; }

    const urbanProducts = [
      { fareProductId: "ancona_60min", fareProductName: "Biglietto Urbano Ancona 60 min", networkId: "urbano_ancona", amount: 1.35, durationMinutes: 60, fareType: "single" as const },
      { fareProductId: "ancona_100min", fareProductName: "Biglietto Urbano Ancona 100 min", networkId: "urbano_ancona", amount: 1.50, durationMinutes: 100, fareType: "single" as const },
      { fareProductId: "jesi_60min", fareProductName: "Biglietto Urbano Jesi 60 min", networkId: "urbano_jesi", amount: 1.35, durationMinutes: 60, fareType: "single" as const },
      { fareProductId: "jesi_ar", fareProductName: "Biglietto Urbano Jesi A/R", networkId: "urbano_jesi", amount: 2.20, durationMinutes: 60, fareType: "return" as const },
      { fareProductId: "falconara_60min", fareProductName: "Biglietto Urbano Falconara 60 min", networkId: "urbano_falconara", amount: 1.35, durationMinutes: 60, fareType: "single" as const },
      { fareProductId: "falconara_ar", fareProductName: "Biglietto Urbano Falconara A/R", networkId: "urbano_falconara", amount: 2.00, durationMinutes: 60, fareType: "return" as const },
    ];

    const extraProducts = EXTRA_BANDS.map(b => ({
      fareProductId: `extra_fascia_${b.fascia}`,
      fareProductName: `Extraurbano ${b.kmFrom}-${b.kmTo} km`,
      networkId: "extraurbano",
      amount: b.price,
      durationMinutes: null as number | null,
      fareType: "zone" as const,
    }));

    const all = [...urbanProducts, ...extraProducts];
    for (const p of all) {
      await db.insert(gtfsFareProducts).values({
        feedId,
        fareProductId: p.fareProductId,
        fareProductName: p.fareProductName,
        networkId: p.networkId,
        amount: p.amount,
        durationMinutes: p.durationMinutes,
        fareType: p.fareType,
        riderCategoryId: "ordinario",
        fareMediaId: null, // null = any media (spec: empty fare_media_id means "all media accepted")
      }).onConflictDoNothing();
    }

    const rows = await db.select().from(gtfsFareProducts).where(eq(gtfsFareProducts.feedId, feedId));
    await logAudit(feedId, "seed_products", `Seed prodotti: ${rows.length} prodotti inseriti/aggiornati`);
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── Tariffe ATMA ufficiali (DGR Marche n. 1036 del 08/08/2022, in vigore dal 01/09/2022) ────
// Fonte: sito ATMA, rilevazione aprile 2026
const EXTRA_SETT_ORD  = [11.30,16.20,19.80,23.40,26.10,28.40,30.60,34.70,36.90,37.80,42.30,46.35];
const EXTRA_MENS_ORD  = [30.00,43.20,52.80,62.40,69.60,75.60,81.60,92.40,98.40,100.80,112.80,123.60];
const EXTRA_ANN_ORD   = [300.00,432.00,528.00,624.00,696.00,756.00,816.00,924.00,984.00,1008.00,1128.00,1236.00];
// Mensile ordinario integrato extraurbano + urbano Ancona
const EXTRA_MENS_INT_ORD = [52.50,64.20,71.20,78.00,84.00,89.70,95.40,105.70,111.40,113.70,125.10,135.30];
// Annuale studenti (7,5 mensilità, 01/09–31/08)
const EXTRA_ANN_ST    = [225.00,324.00,396.00,468.00,522.00,567.00,612.00,693.00,738.00,756.00,846.00,927.00];
// Mensile integrato studenti (extraurbano + urbano Ancona)
const EXTRA_MENS_INT_ST  = [37.50,50.70,60.30,69.60,77.10,83.10,89.10,99.90,105.90,108.30,120.30,131.10];
// Annuale integrato studenti (extraurbano + urbano Ancona)
const EXTRA_ANN_INT_ST   = [281.25,380.25,452.25,524.25,578.25,623.25,688.25,749.25,794.25,812.25,902.25,983.25];

// Biglietti singoli urbani e A/R (da seed separato, ma disponibili come costante)
const URBAN_TICKETS = [
  // Ancona
  { id: "ancona_60min",        name: "Biglietto Urbano Ancona 60 min",                  net: "urbano_ancona",    price: 1.35, type: "single" },
  { id: "ancona_100min",       name: "Biglietto Urbano Ancona 100 min",                 net: "urbano_ancona",    price: 1.50, type: "single" },
  { id: "ancona_ar",           name: "Biglietto Urbano Ancona A/R (240 min)",           net: "urbano_ancona",    price: 2.50, type: "return" },
  { id: "ancona_24h",          name: "Biglietto Urbano Ancona 24 ore",                  net: "urbano_ancona",    price: 4.00, type: "single" },
  { id: "ancona_7gg",          name: "Biglietto Urbano Ancona 7 giorni",                net: "urbano_ancona",    price: 12.00, type: "single" },
  { id: "ancona_bordo",        name: "Biglietto Urbano Ancona emesso a bordo",          net: "urbano_ancona",    price: 3.00, type: "single" },
  { id: "ancona_bordo_100min", name: "Biglietto Urbano Ancona 100 min (emettitrice)",   net: "urbano_ancona",    price: 2.00, type: "single" },
  { id: "ancona_bordo_ar",     name: "Biglietto Urbano Ancona A/R (emettitrice)",       net: "urbano_ancona",    price: 4.00, type: "return" },
  { id: "ancona_bordo_24h",    name: "Biglietto Urbano Ancona 24h (emettitrice)",       net: "urbano_ancona",    price: 5.00, type: "single" },
  { id: "ancona_ascensore",    name: "Biglietto Ascensore Passetto Ancona",             net: "urbano_ancona",    price: 1.00, type: "single" },
  // Jesi
  { id: "jesi_60min",          name: "Biglietto Urbano Jesi 60 min",                    net: "urbano_jesi",      price: 1.35, type: "single" },
  { id: "jesi_ar",             name: "Biglietto Urbano Jesi A/R",                       net: "urbano_jesi",      price: 2.20, type: "return" },
  { id: "jesi_giorn",          name: "Biglietto Urbano Jesi Giornaliero",               net: "urbano_jesi",      price: 3.50, type: "single" },
  { id: "jesi_bordo",          name: "Biglietto Urbano Jesi emesso a bordo",            net: "urbano_jesi",      price: 2.00, type: "single" },
  // Falconara
  { id: "falc_60min",          name: "Biglietto Urbano Falconara 60 min",               net: "urbano_falconara", price: 1.35, type: "single" },
  { id: "falc_ar",             name: "Biglietto Urbano Falconara A/R",                  net: "urbano_falconara", price: 2.00, type: "return" },
  { id: "falc_giorn",          name: "Biglietto Urbano Falconara Giornaliero",          net: "urbano_falconara", price: 3.30, type: "single" },
  // Castelfidardo
  { id: "cfd_60min",           name: "Biglietto Urbano Castelfidardo 60 min",           net: "urbano_castelfidardo", price: 1.35, type: "single" },
  // Sassoferrato
  { id: "sasso_60min",         name: "Biglietto Urbano Sassoferrato 60 min",            net: "urbano_sassoferrato",  price: 1.35, type: "single" },
  // Senigallia (pagina in manutenzione — tariffe analoghe alle altre città, €1.35 confermato DGR)
  { id: "senigallia_60min",    name: "Biglietto Urbano Senigallia 60 min",              net: "urbano_senigallia",    price: 1.35, type: "single" },
] as const;

// POST /api/fares/products/seed-abbonamenti — seed abbonamenti per tutte le reti
router.post("/fares/products/seed-abbonamenti", async (_req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.status(400).json({ error: "No GTFS feed" }); return; }

    const abbonamenti: Array<{
      fareProductId: string;
      fareProductName: string;
      networkId: string;
      amount: number;
      durationMinutes: number | null;
      fareType: string;
      riderCategoryId: string;
    }> = [
      // ── URBANO ANCONA ──────────────────────────────────────────────────────
      { fareProductId: "ancona_mens_ord",     fareProductName: "Abbonamento Urbano Ancona Mensile Ordinario",        networkId: "urbano_ancona", amount: 35.00,  durationMinutes: 60*24*30,  fareType: "abbonamento_mensile",     riderCategoryId: "ordinario" },
      { fareProductId: "ancona_mens_argento", fareProductName: "Abbonamento Urbano Ancona Mensile Argento (over 65)", networkId: "urbano_ancona", amount: 20.00,  durationMinutes: 60*24*30,  fareType: "abbonamento_mensile",     riderCategoryId: "anziano" },
      { fareProductId: "ancona_mens_rosa",    fareProductName: "Abbonamento Urbano Ancona Mensile Rosa",             networkId: "urbano_ancona", amount: 27.00,  durationMinutes: 60*24*30,  fareType: "abbonamento_mensile",     riderCategoryId: "ordinario" },
      { fareProductId: "ancona_mens_isee",    fareProductName: "Abbonamento Urbano Ancona Mensile ISEE < 18.000",    networkId: "urbano_ancona", amount: 25.00,  durationMinutes: 60*24*30,  fareType: "abbonamento_mensile",     riderCategoryId: "agevolato" },
      { fareProductId: "ancona_ann_ord",      fareProductName: "Abbonamento Urbano Ancona Annuale Ordinario",        networkId: "urbano_ancona", amount: 300.00, durationMinutes: 60*24*365, fareType: "abbonamento_annuale",     riderCategoryId: "ordinario" },
      { fareProductId: "ancona_ann_web",      fareProductName: "Abbonamento Urbano Ancona Annuale Web",              networkId: "urbano_ancona", amount: 291.00, durationMinutes: 60*24*365, fareType: "abbonamento_annuale",     riderCategoryId: "ordinario" },
      { fareProductId: "ancona_ann_arg_isee_low",  fareProductName: "Abbonamento Urbano Ancona Annuale Argento ISEE < 18.000", networkId: "urbano_ancona", amount: 210.00, durationMinutes: 60*24*365, fareType: "abbonamento_annuale", riderCategoryId: "agevolato" },
      { fareProductId: "ancona_ann_arg_isee_high", fareProductName: "Abbonamento Urbano Ancona Annuale Argento ISEE > 18.000", networkId: "urbano_ancona", amount: 240.00, durationMinutes: 60*24*365, fareType: "abbonamento_annuale", riderCategoryId: "anziano" },
      { fareProductId: "ancona_family_mens",  fareProductName: "Abbonamento Family Urbano Ancona Mensile",           networkId: "urbano_ancona", amount: 40.00,  durationMinutes: 60*24*30,  fareType: "abbonamento_mensile",     riderCategoryId: "ordinario" },
      { fareProductId: "ancona_mens_st_14p",  fareProductName: "Abbonamento Urbano Ancona Mensile Studente over 14", networkId: "urbano_ancona", amount: 30.00,  durationMinutes: 60*24*30,  fareType: "abbonamento_mensile",     riderCategoryId: "studente" },
      { fareProductId: "ancona_mens_st_14m",  fareProductName: "Abbonamento Urbano Ancona Mensile Studente under 14",networkId: "urbano_ancona", amount: 20.00,  durationMinutes: 60*24*30,  fareType: "abbonamento_mensile",     riderCategoryId: "studente_under14" },
      { fareProductId: "ancona_mens_st_isee", fareProductName: "Abbonamento Urbano Ancona Mensile Studente ISEE < 18.000", networkId: "urbano_ancona", amount: 20.00, durationMinutes: 60*24*30, fareType: "abbonamento_mensile", riderCategoryId: "studente_agevolato" },
      { fareProductId: "ancona_ann_st_14p",   fareProductName: "Abbonamento Urbano Ancona Annuale Studente over 14 (1 set–31 ago)",  networkId: "urbano_ancona", amount: 225.00, durationMinutes: 60*24*365, fareType: "abbonamento_annuale", riderCategoryId: "studente" },
      { fareProductId: "ancona_ann_st_14p_web",fareProductName: "Abbonamento Urbano Ancona Annuale Studente Web",    networkId: "urbano_ancona", amount: 219.00, durationMinutes: 60*24*365, fareType: "abbonamento_annuale",     riderCategoryId: "studente" },
      { fareProductId: "ancona_ann_st_14m",   fareProductName: "Abbonamento Urbano Ancona Annuale Studente under 14",networkId: "urbano_ancona", amount: 150.00, durationMinutes: 60*24*365, fareType: "abbonamento_annuale",     riderCategoryId: "studente_under14" },
      // ── URBANO JESI ────────────────────────────────────────────────────────
      { fareProductId: "jesi_mens_ord",       fareProductName: "Abbonamento Urbano Jesi Mensile Ordinario",          networkId: "urbano_jesi",   amount: 35.00,  durationMinutes: 60*24*30,  fareType: "abbonamento_mensile",     riderCategoryId: "ordinario" },
      { fareProductId: "jesi_ann_ord",        fareProductName: "Abbonamento Urbano Jesi Annuale Ordinario",          networkId: "urbano_jesi",   amount: 320.00, durationMinutes: 60*24*365, fareType: "abbonamento_annuale",     riderCategoryId: "ordinario" },
      { fareProductId: "jesi_mens_anziani",   fareProductName: "Abbonamento Urbano Jesi Mensile Anziani (over 65)",  networkId: "urbano_jesi",   amount: 35.00,  durationMinutes: 60*24*30,  fareType: "abbonamento_mensile",     riderCategoryId: "anziano" },
      { fareProductId: "jesi_mens_st",        fareProductName: "Abbonamento Urbano Jesi Mensile Studente",           networkId: "urbano_jesi",   amount: 32.00,  durationMinutes: 60*24*30,  fareType: "abbonamento_mensile",     riderCategoryId: "studente" },
      { fareProductId: "jesi_ann_st",         fareProductName: "Abbonamento Urbano Jesi Annuale Studente (1 set–31 ago)", networkId: "urbano_jesi", amount: 225.00, durationMinutes: 60*24*365, fareType: "abbonamento_annuale",  riderCategoryId: "studente" },
      // ── URBANO FALCONARA ───────────────────────────────────────────────────
      { fareProductId: "falc_sett_ord",       fareProductName: "Abbonamento Urbano Falconara Settimanale Ordinario", networkId: "urbano_falconara", amount: 11.30, durationMinutes: 60*24*7,  fareType: "abbonamento_settimanale", riderCategoryId: "ordinario" },
      { fareProductId: "falc_mens_ord",       fareProductName: "Abbonamento Urbano Falconara Mensile Ordinario",     networkId: "urbano_falconara", amount: 30.00, durationMinutes: 60*24*30, fareType: "abbonamento_mensile",     riderCategoryId: "ordinario" },
      { fareProductId: "falc_mens_argento",   fareProductName: "Abbonamento Urbano Falconara Mensile Argento (over 65)", networkId: "urbano_falconara", amount: 20.00, durationMinutes: 60*24*30, fareType: "abbonamento_mensile", riderCategoryId: "anziano" },
      { fareProductId: "falc_ann_ord",        fareProductName: "Abbonamento Urbano Falconara Annuale Ordinario",     networkId: "urbano_falconara", amount: 300.00, durationMinutes: 60*24*365, fareType: "abbonamento_annuale",  riderCategoryId: "ordinario" },
      { fareProductId: "falc_mens_st",        fareProductName: "Abbonamento Urbano Falconara Mensile Studente",      networkId: "urbano_falconara", amount: 30.00, durationMinutes: 60*24*30, fareType: "abbonamento_mensile",     riderCategoryId: "studente" },
      { fareProductId: "falc_mens_st_14m",    fareProductName: "Abbonamento Urbano Falconara Mensile Studente under 14", networkId: "urbano_falconara", amount: 20.00, durationMinutes: 60*24*30, fareType: "abbonamento_mensile", riderCategoryId: "studente_under14" },
      { fareProductId: "falc_ann_st",         fareProductName: "Abbonamento Urbano Falconara Annuale Studente (1 set–31 ago)", networkId: "urbano_falconara", amount: 225.00, durationMinutes: 60*24*365, fareType: "abbonamento_annuale", riderCategoryId: "studente" },
      // ── URBANO CASTELFIDARDO ───────────────────────────────────────────────
      { fareProductId: "cfd_mens_ord",        fareProductName: "Abbonamento Urbano Castelfidardo Mensile Ordinario", networkId: "urbano_castelfidardo", amount: 30.00, durationMinutes: 60*24*30, fareType: "abbonamento_mensile", riderCategoryId: "ordinario" },
      { fareProductId: "cfd_mens_st",         fareProductName: "Abbonamento Urbano Castelfidardo Mensile Studente",  networkId: "urbano_castelfidardo", amount: 30.00, durationMinutes: 60*24*30, fareType: "abbonamento_mensile", riderCategoryId: "studente" },
      { fareProductId: "cfd_ann_st",          fareProductName: "Abbonamento Urbano Castelfidardo Annuale Studente (1 set–31 ago)", networkId: "urbano_castelfidardo", amount: 225.00, durationMinutes: 60*24*365, fareType: "abbonamento_annuale", riderCategoryId: "studente" },
      // ── URBANO SASSOFERRATO ────────────────────────────────────────────────
      { fareProductId: "sasso_mens_ord",      fareProductName: "Abbonamento Urbano Sassoferrato Mensile Ordinario",  networkId: "urbano_sassoferrato", amount: 30.00, durationMinutes: 60*24*30, fareType: "abbonamento_mensile", riderCategoryId: "ordinario" },
      { fareProductId: "sasso_sett_ord",      fareProductName: "Abbonamento Urbano Sassoferrato Settimanale Ordinario", networkId: "urbano_sassoferrato", amount: 11.30, durationMinutes: 60*24*7, fareType: "abbonamento_settimanale", riderCategoryId: "ordinario" },
      { fareProductId: "sasso_sett_st",       fareProductName: "Abbonamento Urbano Sassoferrato Settimanale Studente", networkId: "urbano_sassoferrato", amount: 11.30, durationMinutes: 60*24*7, fareType: "abbonamento_settimanale", riderCategoryId: "studente" },
      { fareProductId: "sasso_mens_st",       fareProductName: "Abbonamento Urbano Sassoferrato Mensile Studente",   networkId: "urbano_sassoferrato", amount: 30.00, durationMinutes: 60*24*30, fareType: "abbonamento_mensile", riderCategoryId: "studente" },
      { fareProductId: "sasso_ann_st",        fareProductName: "Abbonamento Urbano Sassoferrato Annuale Studente (1 set–31 ago)", networkId: "urbano_sassoferrato", amount: 225.00, durationMinutes: 60*24*365, fareType: "abbonamento_annuale", riderCategoryId: "studente" },
      // ── URBANO SENIGALLIA (tariffe in manutenzione sul sito — DGR di riferimento) ──
      { fareProductId: "senigallia_sett_ord", fareProductName: "Abbonamento Urbano Senigallia Settimanale Ordinario", networkId: "urbano_senigallia", amount: 11.30, durationMinutes: 60*24*7, fareType: "abbonamento_settimanale", riderCategoryId: "ordinario" },
      { fareProductId: "senigallia_mens_ord", fareProductName: "Abbonamento Urbano Senigallia Mensile Ordinario",    networkId: "urbano_senigallia", amount: 30.00, durationMinutes: 60*24*30, fareType: "abbonamento_mensile", riderCategoryId: "ordinario" },
      { fareProductId: "senigallia_mens_st",  fareProductName: "Abbonamento Urbano Senigallia Mensile Studente",     networkId: "urbano_senigallia", amount: 30.00, durationMinutes: 60*24*30, fareType: "abbonamento_mensile", riderCategoryId: "studente" },
      { fareProductId: "senigallia_ann_st",   fareProductName: "Abbonamento Urbano Senigallia Annuale Studente (1 set–31 ago)", networkId: "urbano_senigallia", amount: 225.00, durationMinutes: 60*24*365, fareType: "abbonamento_annuale", riderCategoryId: "studente" },
      // ── UNIVPM 2025/2026 ───────────────────────────────────────────────────
      { fareProductId: "univpm_alpha",   fareProductName: "UNIVPM Alpha — Urbano Ancona 9 mesi (ott–giu), quota studente",  networkId: "urbano_ancona", amount: 130.00, durationMinutes: 60*24*270, fareType: "abbonamento_annuale", riderCategoryId: "studente_univpm" },
      { fareProductId: "univpm_beta",    fareProductName: "UNIVPM Beta — Urbano Ancona 12 mesi, quota studente",             networkId: "urbano_ancona", amount: 150.00, durationMinutes: 60*24*365, fareType: "abbonamento_annuale", riderCategoryId: "studente_univpm" },
      { fareProductId: "univpm_gamma",   fareProductName: "UNIVPM Gamma — Integrato extraurbano ≤18 km + urbano, quota studente", networkId: "extraurbano", amount: 250.00, durationMinutes: 60*24*270, fareType: "abbonamento_annuale", riderCategoryId: "studente_univpm" },
      { fareProductId: "univpm_delta",   fareProductName: "UNIVPM Delta — Integrato extraurbano ≤36 km + urbano, quota studente", networkId: "extraurbano", amount: 300.00, durationMinutes: 60*24*270, fareType: "abbonamento_annuale", riderCategoryId: "studente_univpm" },
      // ── EXTRAURBANO — Settimanale ordinario (fasce 1–12) ──────────────────
      ...EXTRA_BANDS.slice(0, 12).map((b, i) => ({
        fareProductId: `extra_sett_ord_fascia_${b.fascia}`,
        fareProductName: `Extraurbano Settimanale Ordinario — Fascia ${b.fascia} (${b.kmFrom}–${b.kmTo} km)`,
        networkId: "extraurbano",
        amount: EXTRA_SETT_ORD[i],
        durationMinutes: 60 * 24 * 7 as number | null,
        fareType: "abbonamento_settimanale",
        riderCategoryId: "ordinario",
      })),
      // ── EXTRAURBANO — Mensile ordinario (fasce 1–12) ──────────────────────
      ...EXTRA_BANDS.slice(0, 12).map((b, i) => ({
        fareProductId: `extra_mens_ord_fascia_${b.fascia}`,
        fareProductName: `Extraurbano Mensile Ordinario — Fascia ${b.fascia} (${b.kmFrom}–${b.kmTo} km)`,
        networkId: "extraurbano",
        amount: EXTRA_MENS_ORD[i],
        durationMinutes: 60 * 24 * 30 as number | null,
        fareType: "abbonamento_mensile",
        riderCategoryId: "ordinario",
      })),
      // ── EXTRAURBANO — Mensile studenti = stessa tariffa ordinaria (fasce 1–12)
      ...EXTRA_BANDS.slice(0, 12).map((b, i) => ({
        fareProductId: `extra_mens_st_fascia_${b.fascia}`,
        fareProductName: `Extraurbano Mensile Studente — Fascia ${b.fascia} (${b.kmFrom}–${b.kmTo} km)`,
        networkId: "extraurbano",
        amount: EXTRA_MENS_ORD[i],
        durationMinutes: 60 * 24 * 30 as number | null,
        fareType: "abbonamento_mensile",
        riderCategoryId: "studente",
      })),
      // ── EXTRAURBANO — Annuale ordinario (fasce 1–12) ──────────────────────
      ...EXTRA_BANDS.slice(0, 12).map((b, i) => ({
        fareProductId: `extra_ann_ord_fascia_${b.fascia}`,
        fareProductName: `Extraurbano Annuale Ordinario — Fascia ${b.fascia} (${b.kmFrom}–${b.kmTo} km)`,
        networkId: "extraurbano",
        amount: EXTRA_ANN_ORD[i],
        durationMinutes: 60 * 24 * 365 as number | null,
        fareType: "abbonamento_annuale",
        riderCategoryId: "ordinario",
      })),
      // ── EXTRAURBANO — Annuale studenti 7,5 mensilità (fasce 1–12) ─────────
      ...EXTRA_BANDS.slice(0, 12).map((b, i) => ({
        fareProductId: `extra_ann_st_fascia_${b.fascia}`,
        fareProductName: `Extraurbano Annuale Studente — Fascia ${b.fascia} (${b.kmFrom}–${b.kmTo} km)`,
        networkId: "extraurbano",
        amount: EXTRA_ANN_ST[i],
        durationMinutes: 60 * 24 * 365 as number | null,
        fareType: "abbonamento_annuale",
        riderCategoryId: "studente",
      })),
      // ── EXTRAURBANO — Mensile integrato (extra + urbano Ancona), ordinario ─
      ...EXTRA_BANDS.slice(0, 12).map((b, i) => ({
        fareProductId: `extra_mens_int_ord_fascia_${b.fascia}`,
        fareProductName: `Extraurbano Mensile Integrato Ancona — Fascia ${b.fascia} (${b.kmFrom}–${b.kmTo} km)`,
        networkId: "extraurbano",
        amount: EXTRA_MENS_INT_ORD[i],
        durationMinutes: 60 * 24 * 30 as number | null,
        fareType: "abbonamento_mensile",
        riderCategoryId: "ordinario",
      })),
      // ── EXTRAURBANO — Mensile integrato studenti (extra + urbano Ancona) ──
      ...EXTRA_BANDS.slice(0, 12).map((b, i) => ({
        fareProductId: `extra_mens_int_st_fascia_${b.fascia}`,
        fareProductName: `Extraurbano Mensile Integrato Ancona Studente — Fascia ${b.fascia} (${b.kmFrom}–${b.kmTo} km)`,
        networkId: "extraurbano",
        amount: EXTRA_MENS_INT_ST[i],
        durationMinutes: 60 * 24 * 30 as number | null,
        fareType: "abbonamento_mensile",
        riderCategoryId: "studente",
      })),
      // ── EXTRAURBANO — Annuale integrato studenti (extra + urbano Ancona) ──
      ...EXTRA_BANDS.slice(0, 12).map((b, i) => ({
        fareProductId: `extra_ann_int_st_fascia_${b.fascia}`,
        fareProductName: `Extraurbano Annuale Integrato Ancona Studente — Fascia ${b.fascia} (${b.kmFrom}–${b.kmTo} km)`,
        networkId: "extraurbano",
        amount: EXTRA_ANN_INT_ST[i],
        durationMinutes: 60 * 24 * 365 as number | null,
        fareType: "abbonamento_annuale",
        riderCategoryId: "studente",
      })),
      // ── BIGLIETTI SINGOLI URBANI ──────────────────────────────────────────
      ...URBAN_TICKETS.map(t => ({
        fareProductId: t.id,
        fareProductName: t.name,
        networkId: t.net,
        amount: t.price,
        durationMinutes: null as number | null,
        fareType: t.type,
        riderCategoryId: "ordinario",
      })),
    ];

    let inserted = 0;
    for (const p of abbonamenti) {
      const result = await db.insert(gtfsFareProducts).values({
        feedId,
        fareProductId: p.fareProductId,
        fareProductName: p.fareProductName,
        networkId: p.networkId,
        amount: p.amount,
        durationMinutes: p.durationMinutes,
        fareType: p.fareType,
        riderCategoryId: p.riderCategoryId,
        fareMediaId: null,
      }).onConflictDoNothing().returning();
      if (result.length > 0) inserted++;
    }

    const rows = await db.select().from(gtfsFareProducts)
      .where(and(eq(gtfsFareProducts.feedId, feedId), sql`fare_type LIKE 'abbonamento%'`));
    await logAudit(feedId, "seed_products", `Seed abbonamenti: ${inserted} nuovi prodotti inseriti (${rows.length} totali)`);
    res.json({ inserted, total: rows.length, rows });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// POST /api/fares/products — crea un nuovo prodotto tariffario
router.post("/fares/products", async (req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.status(400).json({ error: "No GTFS feed" }); return; }
    const { fareProductId, fareProductName, networkId, amount, durationMinutes, fareType, riderCategoryId, fareMediaId } = req.body;
    if (!fareProductId || !fareProductName || typeof amount !== "number") {
      res.status(400).json({ error: "fareProductId, fareProductName e amount sono obbligatori" }); return;
    }
    const [row] = await db.insert(gtfsFareProducts).values({
      feedId,
      fareProductId,
      fareProductName,
      networkId: networkId || null,
      amount,
      durationMinutes: durationMinutes || null,
      fareType: fareType || "single",
      riderCategoryId: riderCategoryId || "ordinario",
      fareMediaId: fareMediaId || null,
    }).returning();
    await logAudit(feedId, "update_product", `Nuovo prodotto creato: ${fareProductId} — €${amount} (${fareType})`);
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/fares/products/:id — elimina prodotto
router.delete("/fares/products/:id", async (req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    const [deleted] = await db.delete(gtfsFareProducts).where(eq(gtfsFareProducts.id, req.params.id)).returning();
    if (deleted && feedId) {
      await logAudit(feedId, "update_product", `Prodotto eliminato: ${deleted.fareProductId} — €${deleted.amount}`);
    }
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.put("/fares/products/:id", async (req, res) => {
  try {
    const feedId = await getLatestFeedId();
    const { amount, fareProductName, durationMinutes } = req.body;
    const update: Record<string, any> = { updatedAt: sql`now()` };
    if (typeof amount === "number") update.amount = amount;
    if (fareProductName) update.fareProductName = fareProductName;
    if (typeof durationMinutes === "number") update.durationMinutes = durationMinutes;
    const [updated] = await db.update(gtfsFareProducts).set(update).where(eq(gtfsFareProducts.id, req.params.id)).returning();
    if (updated && feedId) {
      await logAudit(feedId, "update_price", `Prodotto aggiornato: ${updated.fareProductId} → €${updated.amount}${fareProductName ? ` — nome: "${fareProductName}"` : ""}`);
    }
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// AREAS & STOP-AREAS (Zone extraurbane)
// ═══════════════════════════════════════════════════════════

router.get("/fares/areas", async (_req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.json([]); return; }
    const rows = await db.select().from(gtfsFareAreas).where(eq(gtfsFareAreas.feedId, feedId));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get("/fares/stop-areas", async (_req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.json([]); return; }
    const rows = await db.select().from(gtfsStopAreas).where(eq(gtfsStopAreas.feedId, feedId));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// POST /api/fares/zones/generate/:routeId — build zones for one extraurban route
router.post("/fares/zones/generate/:routeId", async (req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.status(400).json({ error: "No GTFS feed" }); return; }
    const { routeId } = req.params;

    const result = await generateZonesForRoute(feedId, routeId);
    res.json(result);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// POST /api/fares/zones/generate-all — build zones for ALL extraurban routes + urban areas
router.post("/fares/zones/generate-all", async (_req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.status(400).json({ error: "No GTFS feed" }); return; }

    // 1) Create urban flat areas
    const urbanNets = ["urbano_ancona","urbano_jesi","urbano_falconara","urbano_senigallia","urbano_castelfidardo","urbano_sassoferrato"];
    const urbanAreas = [
      { areaId: "ancona_urban",        areaName: "Zona Urbana Ancona",        networkId: "urbano_ancona" },
      { areaId: "jesi_urban",          areaName: "Zona Urbana Jesi",          networkId: "urbano_jesi" },
      { areaId: "falconara_urban",     areaName: "Zona Urbana Falconara",     networkId: "urbano_falconara" },
      { areaId: "senigallia_urban",    areaName: "Zona Urbana Senigallia",    networkId: "urbano_senigallia" },
      { areaId: "castelfidardo_urban", areaName: "Zona Urbana Castelfidardo", networkId: "urbano_castelfidardo" },
      { areaId: "sassoferrato_urban",  areaName: "Zona Urbana Sassoferrato",  networkId: "urbano_sassoferrato" },
    ];

    for (const ua of urbanAreas) {
      await db.insert(gtfsFareAreas)
        .values({ feedId, areaId: ua.areaId, areaName: ua.areaName, networkId: ua.networkId })
        .onConflictDoUpdate({
          target: [gtfsFareAreas.feedId, gtfsFareAreas.areaId],
          set: { areaName: ua.areaName, updatedAt: sql`now()` },
        });
    }

    // 2) Assign all urban stops to their areas
    for (const net of urbanNets) {
      const urbanAreaId = net === "urbano_ancona" ? "ancona_urban"
        : net === "urbano_jesi" ? "jesi_urban" : "falconara_urban";

      // Find all stops served by routes in this network
      const stopRows = await db.execute<any>(sql`
        SELECT DISTINCT s.stop_id
        FROM gtfs_stops s
        JOIN gtfs_stop_times st ON st.stop_id = s.stop_id AND st.feed_id = s.feed_id
        JOIN gtfs_trips t ON t.trip_id = st.trip_id AND t.feed_id = s.feed_id
        JOIN gtfs_route_networks rn ON rn.route_id = t.route_id AND rn.feed_id = t.feed_id
        WHERE s.feed_id = ${feedId} AND rn.network_id = ${net}
      `);

      for (const row of stopRows.rows) {
        await db.insert(gtfsStopAreas)
          .values({ feedId, areaId: urbanAreaId, stopId: row.stop_id })
          .onConflictDoNothing();
      }
    }

    // 3) Generate zones for all extraurban routes
    const extraRoutes = await db.execute<any>(sql`
      SELECT rn.route_id
      FROM gtfs_route_networks rn
      WHERE rn.feed_id = ${feedId} AND rn.network_id = 'extraurbano'
    `);

    let totalZones = 0;
    const results: { routeId: string; zones: number; stops: number }[] = [];
    for (const row of extraRoutes.rows) {
      const r = await generateZonesForRoute(feedId, row.route_id);
      totalZones += r.zones;
      results.push(r);
    }

    res.json({ urbanAreas: urbanAreas.length, extraurbanRoutes: extraRoutes.rows.length, totalZones, details: results });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// POST /api/fares/zones/generate-all-direct — build zones for ALL extraurban routes using haversine (Km per Linea)
// Same urban logic, but extraurban zone distances are computed as cumulative haversine between consecutive stops.
router.post("/fares/zones/generate-all-direct", async (_req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.status(400).json({ error: "No GTFS feed" }); return; }

    // 1) Create urban flat areas (same as generate-all)
    const urbanNets = ["urbano_ancona","urbano_jesi","urbano_falconara","urbano_senigallia","urbano_castelfidardo","urbano_sassoferrato"];
    const urbanAreas = [
      { areaId: "ancona_urban",        areaName: "Zona Urbana Ancona",        networkId: "urbano_ancona" },
      { areaId: "jesi_urban",          areaName: "Zona Urbana Jesi",          networkId: "urbano_jesi" },
      { areaId: "falconara_urban",     areaName: "Zona Urbana Falconara",     networkId: "urbano_falconara" },
      { areaId: "senigallia_urban",    areaName: "Zona Urbana Senigallia",    networkId: "urbano_senigallia" },
      { areaId: "castelfidardo_urban", areaName: "Zona Urbana Castelfidardo", networkId: "urbano_castelfidardo" },
      { areaId: "sassoferrato_urban",  areaName: "Zona Urbana Sassoferrato",  networkId: "urbano_sassoferrato" },
    ];
    for (const ua of urbanAreas) {
      await db.insert(gtfsFareAreas)
        .values({ feedId, areaId: ua.areaId, areaName: ua.areaName, networkId: ua.networkId })
        .onConflictDoUpdate({
          target: [gtfsFareAreas.feedId, gtfsFareAreas.areaId],
          set: { areaName: ua.areaName, updatedAt: sql`now()` },
        });
    }
    for (const net of urbanNets) {
      const urbanAreaId = net === "urbano_ancona" ? "ancona_urban"
        : net === "urbano_jesi" ? "jesi_urban" : "falconara_urban";
      const stopRows = await db.execute<any>(sql`
        SELECT DISTINCT s.stop_id
        FROM gtfs_stops s
        JOIN gtfs_stop_times st ON st.stop_id = s.stop_id AND st.feed_id = s.feed_id
        JOIN gtfs_trips t ON t.trip_id = st.trip_id AND t.feed_id = s.feed_id
        JOIN gtfs_route_networks rn ON rn.route_id = t.route_id AND rn.feed_id = t.feed_id
        WHERE s.feed_id = ${feedId} AND rn.network_id = ${net}
      `);
      for (const row of stopRows.rows) {
        await db.insert(gtfsStopAreas)
          .values({ feedId, areaId: urbanAreaId, stopId: row.stop_id })
          .onConflictDoNothing();
      }
    }

    // 2) Generate zones for all extraurban routes using DIRECT haversine
    const extraRoutes = await db.execute<any>(sql`
      SELECT rn.route_id
      FROM gtfs_route_networks rn
      WHERE rn.feed_id = ${feedId} AND rn.network_id = 'extraurbano'
    `);

    let totalZones = 0;
    const results: { routeId: string; zones: number; stops: number }[] = [];
    for (const row of extraRoutes.rows) {
      const r = await generateZonesForRouteDirect(feedId, row.route_id);
      totalZones += r.zones;
      results.push(r);
    }

    res.json({ method: "direct", urbanAreas: urbanAreas.length, extraurbanRoutes: extraRoutes.rows.length, totalZones, details: results });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// POST /api/fares/zones/generate-all-dominant — build zones using Percorso Dominante method
router.post("/fares/zones/generate-all-dominant", async (_req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.status(400).json({ error: "No GTFS feed" }); return; }

    // 1) Create urban flat areas (same as other generate-all methods)
    const urbanNets = ["urbano_ancona","urbano_jesi","urbano_falconara","urbano_senigallia","urbano_castelfidardo","urbano_sassoferrato"];
    const urbanAreas = [
      { areaId: "ancona_urban",        areaName: "Zona Urbana Ancona",        networkId: "urbano_ancona" },
      { areaId: "jesi_urban",          areaName: "Zona Urbana Jesi",          networkId: "urbano_jesi" },
      { areaId: "falconara_urban",     areaName: "Zona Urbana Falconara",     networkId: "urbano_falconara" },
      { areaId: "senigallia_urban",    areaName: "Zona Urbana Senigallia",    networkId: "urbano_senigallia" },
      { areaId: "castelfidardo_urban", areaName: "Zona Urbana Castelfidardo", networkId: "urbano_castelfidardo" },
      { areaId: "sassoferrato_urban",  areaName: "Zona Urbana Sassoferrato",  networkId: "urbano_sassoferrato" },
    ];
    for (const ua of urbanAreas) {
      await db.insert(gtfsFareAreas)
        .values({ feedId, areaId: ua.areaId, areaName: ua.areaName, networkId: ua.networkId })
        .onConflictDoUpdate({
          target: [gtfsFareAreas.feedId, gtfsFareAreas.areaId],
          set: { areaName: ua.areaName, updatedAt: sql`now()` },
        });
    }
    for (const net of urbanNets) {
      const urbanAreaId = net === "urbano_ancona" ? "ancona_urban"
        : net === "urbano_jesi" ? "jesi_urban" : "falconara_urban";
      const stopRows = await db.execute<any>(sql`
        SELECT DISTINCT s.stop_id
        FROM gtfs_stops s
        JOIN gtfs_stop_times st ON st.stop_id = s.stop_id AND st.feed_id = s.feed_id
        JOIN gtfs_trips t ON t.trip_id = st.trip_id AND t.feed_id = s.feed_id
        JOIN gtfs_route_networks rn ON rn.route_id = t.route_id AND rn.feed_id = t.feed_id
        WHERE s.feed_id = ${feedId} AND rn.network_id = ${net}
      `);
      for (const row of stopRows.rows) {
        await db.insert(gtfsStopAreas)
          .values({ feedId, areaId: urbanAreaId, stopId: row.stop_id })
          .onConflictDoNothing();
      }
    }

    // 2) Generate zones for all extraurban routes using DOMINANT percorso
    const extraRoutes = await db.execute<any>(sql`
      SELECT rn.route_id
      FROM gtfs_route_networks rn
      WHERE rn.feed_id = ${feedId} AND rn.network_id = 'extraurbano'
    `);

    let totalZones = 0;
    const results: any[] = [];
    for (const row of extraRoutes.rows) {
      const r = await generateZonesForRouteDominant(feedId, row.route_id);
      totalZones += r.zones;
      results.push(r);
    }

    res.json({ method: "dominant", urbanAreas: urbanAreas.length, extraurbanRoutes: extraRoutes.rows.length, totalZones, details: results });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

/**
 * Generate km-based zones for a single extraurban route using DIRECT haversine.
 * Simple method: cumulative haversine between consecutive stops (no shape projection).
 * Uses the longest trip from the reference service_id as representative.
 */
async function generateZonesForRouteDirect(feedId: string, routeId: string) {
  const { percorsi: allPercorsi } = await getRoutePercorsi(feedId, routeId);
  if (allPercorsi.length === 0) return { routeId, zones: 0, stops: 0 };

  // Pick the percorso with the most stops (longest variant, one direction)
  const ref = allPercorsi.reduce((a, b) => a.stops.length >= b.stops.length ? a : b);

  // Cumulative haversine between consecutive stops
  const usedBands = new Set<number>();
  const stopFinalKm = new Map<string, { name: string; lat: number; lon: number; km: number }>();
  let cumKm = 0;

  for (let i = 0; i < ref.stops.length; i++) {
    const s = ref.stops[i];
    if (i > 0) {
      const prev = ref.stops[i - 1];
      cumKm += haversineKm(prev.lat, prev.lon, s.lat, s.lon);
    }
    const km = Math.round(cumKm * 100) / 100;
    stopFinalKm.set(s.stop_id, { name: s.stop_name, lat: s.lat, lon: s.lon, km });
    const band = getBandForDistance(km);
    if (band) usedBands.add(band.fascia);
    else if (km === 0) usedBands.add(1);
  }

  // Create areas and assign stops
  const createdZones: string[] = [];
  for (const fascia of Array.from(usedBands).sort((a, b) => a - b)) {
    const band = EXTRA_BANDS[fascia - 1];
    const areaId = `${routeId}_zona_${fascia}`;
    await db.insert(gtfsFareAreas).values({
      feedId, areaId,
      areaName: `Linea ${routeId} - Zona km ${band.kmFrom}-${band.kmTo}`,
      networkId: "extraurbano", routeId,
      kmFrom: band.kmFrom, kmTo: band.kmTo,
    }).onConflictDoUpdate({
      target: [gtfsFareAreas.feedId, gtfsFareAreas.areaId],
      set: { areaName: `Linea ${routeId} - Zona km ${band.kmFrom}-${band.kmTo}`, kmFrom: band.kmFrom, kmTo: band.kmTo, updatedAt: sql`now()` },
    });
    createdZones.push(areaId);
  }

  let stopsAssigned = 0;
  for (const [stopId, info] of stopFinalKm) {
    let band = getBandForDistance(info.km);
    if (!band && info.km === 0) band = EXTRA_BANDS[0];
    if (!band) continue;
    await db.insert(gtfsStopAreas)
      .values({ feedId, areaId: `${routeId}_zona_${band.fascia}`, stopId })
      .onConflictDoNothing();
    stopsAssigned++;
  }

  return { routeId, zones: createdZones.length, stops: stopsAssigned };
}

/**
 * Generate km-based zones for a single extraurban route.
 * Metodo "Proiezione su Shape": media ponderata per tripCount su tutti i percorsi
 * della famiglia direzionale. (DGR Marche 1036/2022 art. 2.d)
 */
async function generateZonesForRoute(feedId: string, routeId: string) {
  const { percorsi: allPercorsi } = await getRoutePercorsi(feedId, routeId);
  if (allPercorsi.length === 0) return { routeId, zones: 0, stops: 0, percorsiAnalizzati: 0, percorsiConShape: 0 };

  // Filtra per famiglia direzionale (stessa prima/ultima fermata del percorso più lungo)
  const ref = allPercorsi.reduce((a, b) => a.stops.length >= b.stops.length ? a : b);
  const refFirst = ref.stops[0]?.stop_id;
  const refLast = ref.stops[ref.stops.length - 1]?.stop_id;
  const percorsi = allPercorsi.filter(p => {
    const first = p.stops[0]?.stop_id;
    const last = p.stops[p.stops.length - 1]?.stop_id;
    return first === refFirst && last === refLast;
  });
  const filtered = percorsi.length > 0 ? percorsi : allPercorsi;

  // Per ogni fermata, accumula i km ponderati per tripCount da tutti i percorsi
  const stopKmAccumulator = new Map<string, {
    name: string; lat: number; lon: number;
    weightedKmValues: { km: number; weight: number }[];
  }>();

  for (const percorso of filtered) {
    const kmMap = computeKmAlongShape(percorso.stops, percorso.shapeCoords);
    for (const [stopId, info] of kmMap) {
      if (!stopKmAccumulator.has(stopId)) {
        stopKmAccumulator.set(stopId, { name: info.name, lat: info.lat, lon: info.lon, weightedKmValues: [] });
      }
      stopKmAccumulator.get(stopId)!.weightedKmValues.push({ km: info.km, weight: percorso.tripCount });
    }
  }

  // Distanza tariffaria = media ponderata per tripCount
  const usedBands = new Set<number>();
  const stopFinalKm = new Map<string, { name: string; lat: number; lon: number; km: number }>();

  for (const [stopId, data] of stopKmAccumulator) {
    const totalWeight = data.weightedKmValues.reduce((a, b) => a + b.weight, 0);
    const avgKm = data.weightedKmValues.reduce((a, b) => a + b.km * b.weight, 0) / totalWeight;
    const km = Math.round(avgKm * 100) / 100;
    stopFinalKm.set(stopId, { name: data.name, lat: data.lat, lon: data.lon, km });
    const band = getBandForDistance(km);
    if (band) usedBands.add(band.fascia);
    else if (km === 0) usedBands.add(1);
  }

  // Crea aree e assegna fermate
  const createdZones: string[] = [];
  for (const fascia of Array.from(usedBands).sort((a, b) => a - b)) {
    const band = EXTRA_BANDS[fascia - 1];
    const areaId = `${routeId}_zona_${fascia}`;
    await db.insert(gtfsFareAreas).values({
      feedId, areaId,
      areaName: `Linea ${routeId} - Zona km ${band.kmFrom}-${band.kmTo}`,
      networkId: "extraurbano", routeId,
      kmFrom: band.kmFrom, kmTo: band.kmTo,
    }).onConflictDoUpdate({
      target: [gtfsFareAreas.feedId, gtfsFareAreas.areaId],
      set: { areaName: `Linea ${routeId} - Zona km ${band.kmFrom}-${band.kmTo}`, kmFrom: band.kmFrom, kmTo: band.kmTo, updatedAt: sql`now()` },
    });
    createdZones.push(areaId);
  }

  let stopsAssigned = 0;
  for (const [stopId, info] of stopFinalKm) {
    let band = getBandForDistance(info.km);
    if (!band && info.km === 0) band = EXTRA_BANDS[0];
    if (!band) continue;
    await db.insert(gtfsStopAreas)
      .values({ feedId, areaId: `${routeId}_zona_${band.fascia}`, stopId })
      .onConflictDoNothing();
    stopsAssigned++;
  }

  return {
    routeId,
    zones: createdZones.length,
    stops: stopsAssigned,
    percorsiAnalizzati: filtered.length,
    percorsiConShape: filtered.filter(p => p.shapeCoords !== null).length,
  };
}

/**
 * Generate km-based zones for a single extraurban route.
 * Metodo "Percorso Dominante": usa SOLO il percorso con più corse (tripCount max).
 */
async function generateZonesForRouteDominant(feedId: string, routeId: string) {
  const { percorsi: allPercorsi, totalTripsDay } = await getRoutePercorsi(feedId, routeId);
  if (allPercorsi.length === 0) return { routeId, zones: 0, stops: 0, percorsiAnalizzati: 0, percorsiConShape: 0 };

  const { dominant } = getDominantPercorso(allPercorsi);
  if (!dominant) return { routeId, zones: 0, stops: 0, percorsiAnalizzati: 0, percorsiConShape: 0 };

  const kmMap = computeKmAlongShape(dominant.stops, dominant.shapeCoords);

  const usedBands = new Set<number>();
  const stopFinalKm = new Map<string, { name: string; lat: number; lon: number; km: number }>();

  for (const [stopId, info] of kmMap) {
    const km = Math.round(info.km * 100) / 100;
    stopFinalKm.set(stopId, { name: info.name, lat: info.lat, lon: info.lon, km });
    const band = getBandForDistance(km);
    if (band) usedBands.add(band.fascia);
    else if (km === 0) usedBands.add(1);
  }

  const createdZones: string[] = [];
  for (const fascia of Array.from(usedBands).sort((a, b) => a - b)) {
    const band = EXTRA_BANDS[fascia - 1];
    const areaId = `${routeId}_zona_${fascia}`;
    await db.insert(gtfsFareAreas).values({
      feedId, areaId,
      areaName: `Linea ${routeId} - Zona km ${band.kmFrom}-${band.kmTo}`,
      networkId: "extraurbano", routeId,
      kmFrom: band.kmFrom, kmTo: band.kmTo,
    }).onConflictDoUpdate({
      target: [gtfsFareAreas.feedId, gtfsFareAreas.areaId],
      set: { areaName: `Linea ${routeId} - Zona km ${band.kmFrom}-${band.kmTo}`, kmFrom: band.kmFrom, kmTo: band.kmTo, updatedAt: sql`now()` },
    });
    createdZones.push(areaId);
  }

  let stopsAssigned = 0;
  for (const [stopId, info] of stopFinalKm) {
    let band = getBandForDistance(info.km);
    if (!band && info.km === 0) band = EXTRA_BANDS[0];
    if (!band) continue;
    await db.insert(gtfsStopAreas)
      .values({ feedId, areaId: `${routeId}_zona_${band.fascia}`, stopId })
      .onConflictDoNothing();
    stopsAssigned++;
  }

  return {
    routeId,
    zones: createdZones.length,
    stops: stopsAssigned,
    percorsiAnalizzati: 1,
    percorsiConShape: dominant.shapeCoords ? 1 : 0,
    dominantTripCount: dominant.tripCount,
    dominantShapeId: dominant.shapeId,
    totalTripsDay,
  };
}

// ═══════════════════════════════════════════════════════════
// FARE LEG RULES
// ═══════════════════════════════════════════════════════════

router.get("/fares/leg-rules", async (_req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.json([]); return; }
    const rows = await db.select().from(gtfsFareLegRules).where(eq(gtfsFareLegRules.feedId, feedId));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// POST /api/fares/leg-rules/generate — generate from current areas & products
router.post("/fares/leg-rules/generate", async (_req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.status(400).json({ error: "No GTFS feed" }); return; }

    // Delete existing leg rules
    await db.delete(gtfsFareLegRules).where(eq(gtfsFareLegRules.feedId, feedId));

    // 1) Urban flat rules (no area constraints)
    const urbanRules = [
      { legGroupId: "lg_ancona_60", networkId: "urbano_ancona", fareProductId: "ancona_60min" },
      { legGroupId: "lg_ancona_100", networkId: "urbano_ancona", fareProductId: "ancona_100min" },
      { legGroupId: "lg_jesi_60", networkId: "urbano_jesi", fareProductId: "jesi_60min" },
      { legGroupId: "lg_jesi_ar", networkId: "urbano_jesi", fareProductId: "jesi_ar" },
      { legGroupId: "lg_falconara_60", networkId: "urbano_falconara", fareProductId: "falconara_60min" },
      { legGroupId: "lg_falconara_ar", networkId: "urbano_falconara", fareProductId: "falconara_ar" },
    ];

    for (const r of urbanRules) {
      await db.insert(gtfsFareLegRules).values({ feedId, ...r, rulePriority: 10 });
    }

    // 2) Extraurban OD matrix
    // Group areas by route
    const areas = await db.select().from(gtfsFareAreas)
      .where(and(eq(gtfsFareAreas.feedId, feedId), eq(gtfsFareAreas.networkId, "extraurbano")));

    const byRoute = new Map<string, typeof areas>();
    for (const a of areas) {
      if (!a.routeId) continue;
      const arr = byRoute.get(a.routeId) || [];
      arr.push(a);
      byRoute.set(a.routeId, arr);
    }

    let odCount = 0;
    for (const [rId, routeAreas] of byRoute) {
      // Sort by kmFrom
      routeAreas.sort((a, b) => (a.kmFrom || 0) - (b.kmFrom || 0));

      // For every pair (i,j) where i≠j, compute distance and assign fare band
      for (let i = 0; i < routeAreas.length; i++) {
        for (let j = 0; j < routeAreas.length; j++) {
          if (i === j) continue;
          const from = routeAreas[i];
          const to = routeAreas[j];
          // Distance = midpoint of "to" zone − midpoint of "from" zone
          const fromMid = ((from.kmFrom || 0) + (from.kmTo || 0)) / 2;
          const toMid = ((to.kmFrom || 0) + (to.kmTo || 0)) / 2;
          const dist = Math.abs(toMid - fromMid);
          const band = getBandForDistance(dist);
          if (!band) continue;

          await db.insert(gtfsFareLegRules).values({
            feedId,
            legGroupId: "lg_extra",
            networkId: "extraurbano",
            fromAreaId: from.areaId,
            toAreaId: to.areaId,
            fareProductId: `extra_fascia_${band.fascia}`,
            rulePriority: 0,
          });
          odCount++;
        }
      }
    }

    res.json({ urbanRules: urbanRules.length, odRules: odCount, total: urbanRules.length + odCount });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// FARE TRANSFER RULES
// ═══════════════════════════════════════════════════════════

router.get("/fares/transfer-rules", async (_req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.json([]); return; }
    const rows = await db.select().from(gtfsFareTransferRules).where(eq(gtfsFareTransferRules.feedId, feedId));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// TIMEFRAMES (GTFS timeframes.txt)
// ═══════════════════════════════════════════════════════════

router.get("/fares/timeframes", async (_req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.json([]); return; }
    const rows = await db.select().from(gtfsTimeframes).where(eq(gtfsTimeframes.feedId, feedId));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/fares/timeframes", async (req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.status(400).json({ error: "No GTFS feed" }); return; }
    const { timeframeGroupId, startTime, endTime, serviceId } = req.body;
    if (!timeframeGroupId) { res.status(400).json({ error: "timeframeGroupId required" }); return; }
    const [row] = await db.insert(gtfsTimeframes).values({
      feedId, timeframeGroupId, startTime, endTime, serviceId,
    }).returning();
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/fares/timeframes/:id", async (req, res): Promise<void> => {
  try {
    await db.delete(gtfsTimeframes).where(eq(gtfsTimeframes.id, req.params.id));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// SIMULATE — ticket price lookup — Metodo "Proiezione su Shape" (media ponderata)
// ═══════════════════════════════════════════════════════════

router.post("/fares/simulate", async (req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.status(400).json({ error: "No GTFS feed" }); return; }
    const { networkId, routeId, fromStopId, toStopId } = req.body;

    if (!networkId) { res.status(400).json({ error: "networkId required" }); return; }

    // Urban → flat fare
    if (networkId !== "extraurbano") {
      const products = await db.select().from(gtfsFareProducts)
        .where(and(eq(gtfsFareProducts.feedId, feedId), eq(gtfsFareProducts.networkId, networkId)));
      if (products.length === 0) {
        res.json({ type: "urban", networkId, products: [{ fareProductId: "default_60", name: "Biglietto 60 min", amount: 1.35, currency: "EUR", durationMinutes: 60 }] });
        return;
      }
      res.json({
        type: "urban", networkId,
        products: products.map(p => ({ fareProductId: p.fareProductId, name: p.fareProductName, amount: p.amount, currency: p.currency, durationMinutes: p.durationMinutes })),
      });
      return;
    }

    if (!routeId || !fromStopId || !toStopId) {
      res.status(400).json({ error: "For extraurban, routeId + fromStopId + toStopId required" }); return;
    }

    const { percorsi, refServiceId, totalTripsDay } = await getRoutePercorsi(feedId, routeId);
    if (percorsi.length === 0) { res.status(404).json({ error: "No trips found for this route" }); return; }

    // Raccoglie distanza OD da ogni percorso che serve entrambe le fermate
    const odDistances: { km: number; shapeId: string | null; tripCount: number }[] = [];
    let fromInfoFinal: { name: string; lat: number; lon: number; km: number } | null = null;
    let toInfoFinal: { name: string; lat: number; lon: number; km: number } | null = null;
    let bestIntermediateStops: any[] = [];

    for (const percorso of percorsi) {
      const kmMap = computeKmAlongShape(percorso.stops, percorso.shapeCoords);
      const fromInfo = kmMap.get(fromStopId);
      const toInfo = kmMap.get(toStopId);
      if (!fromInfo || !toInfo) continue;

      odDistances.push({
        km: Math.round(Math.abs(toInfo.km - fromInfo.km) * 100) / 100,
        shapeId: percorso.shapeId,
        tripCount: percorso.tripCount,
      });

      if (!fromInfoFinal) {
        fromInfoFinal = fromInfo;
        toInfoFinal = toInfo;
        const fromIdx = percorso.stops.findIndex(s => s.stop_id === fromStopId);
        const toIdx = percorso.stops.findIndex(s => s.stop_id === toStopId);
        const minIdx = Math.min(fromIdx, toIdx);
        const maxIdx = Math.max(fromIdx, toIdx);
        bestIntermediateStops = percorso.stops.slice(minIdx, maxIdx + 1).map(s => ({
          stopId: s.stop_id, stopName: s.stop_name, lat: s.lat, lon: s.lon, km: kmMap.get(s.stop_id)!.km,
        }));
      }
    }

    if (odDistances.length === 0 || !fromInfoFinal || !toInfoFinal) {
      res.status(404).json({ error: "Stop not found in any trip for this route" }); return;
    }

    // Media ponderata per tripCount (DGR 1036/2022 punto 2.d)
    const totalWeight = odDistances.reduce((a, b) => a + b.tripCount, 0);
    const distKm = Math.round(
      (odDistances.reduce((a, b) => a + b.km * b.tripCount, 0) / totalWeight) * 100
    ) / 100;

    const band = getBandForDistance(distKm) ?? (distKm <= 6 ? EXTRA_BANDS[0] : undefined);
    if (!band) { res.status(404).json({ error: `No fare band for distance ${distKm.toFixed(1)} km` }); return; }

    res.json({
      type: "extraurban", networkId, routeId, fromStopId, toStopId,
      fromStop: { stopId: fromStopId, name: fromInfoFinal.name, lat: fromInfoFinal.lat, lon: fromInfoFinal.lon, km: fromInfoFinal.km },
      toStop: { stopId: toStopId, name: toInfoFinal.name, lat: toInfoFinal.lat, lon: toInfoFinal.lon, km: toInfoFinal.km },
      distanceKm: distKm,
      distanceVariants: odDistances,
      percorsiCount: odDistances.length,
      totalTrips: totalWeight,
      totalTripsDay,
      refServiceId,
      fascia: band.fascia, fareProductId: `extra_fascia_${band.fascia}`,
      amount: band.price, currency: "EUR", bandRange: `${band.kmFrom}-${band.kmTo} km`,
      intermediateStops: bestIntermediateStops,
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// SIMULATE DOMINANT — Rev.4b (DGR 1036/2022 Regola 1 / Regola 2)
//
// Se routeId è fornito → Regola 1 forzata su quella linea.
// Altrimenti → findApplicableRoutes raggruppa le linee candidate per
// capolinea dominante; se ≥2 linee condividono stesso capolinea → Regola 2.
// Tutti i casi restituiscono fascia + amount + bandRange.
// ═══════════════════════════════════════════════════════════

router.post("/fares/simulate-dominant", async (req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.status(400).json({ error: "No GTFS feed" }); return; }
    const { routeId, fromStopId, toStopId } = req.body;
    if (!fromStopId || !toStopId) { res.status(400).json({ error: "fromStopId + toStopId required" }); return; }

    // ── Regola 1 forzata: utente ha selezionato una linea specifica ──
    if (routeId) {
      const { percorsi: allPercorsi, refServiceId, totalTripsDay } = await getRoutePercorsi(feedId, routeId);
      if (allPercorsi.length === 0) { res.status(404).json({ error: "No trips found for route" }); return; }

      const { dominant, altPercorsi } = getDominantPercorso(allPercorsi);
      if (!dominant) { res.status(404).json({ error: "No dominant percorso found" }); return; }

      const kmMap = computeKmAlongShape(dominant.stops, dominant.shapeCoords);
      const fromInfo = kmMap.get(fromStopId);
      const toInfo = kmMap.get(toStopId);
      if (!fromInfo || !toInfo) { res.status(404).json({ error: "Stops not found in dominant percorso" }); return; }

      const distKm = Math.round(Math.abs(toInfo.km - fromInfo.km) * 100) / 100;

      const fromIdx = dominant.stops.findIndex(s => s.stop_id === fromStopId);
      const toIdx   = dominant.stops.findIndex(s => s.stop_id === toStopId);
      const minIdx  = Math.min(fromIdx, toIdx);
      const maxIdx  = Math.max(fromIdx, toIdx);
      const intermediateStops = dominant.stops.slice(minIdx, maxIdx + 1).map(s => ({
        stopId: s.stop_id, stopName: s.stop_name, lat: s.lat, lon: s.lon, km: kmMap.get(s.stop_id)!.km,
      }));

      const lastStopKm = kmMap.get(dominant.stops[dominant.stops.length - 1].stop_id);
      const totalPathKm = Math.round((lastStopKm?.km ?? distKm) * 100) / 100;

      const altDistances = altPercorsi.map(p => {
        const aKm = computeKmAlongShape(p.stops, p.shapeCoords);
        const af = aKm.get(fromStopId); const at = aKm.get(toStopId);
        if (!af || !at) return null;
        return { shapeId: p.shapeId, tripCount: p.tripCount, km: Math.round(Math.abs(at.km - af.km) * 100) / 100 };
      }).filter(Boolean);

      const band = getBandForDistance(distKm) ?? EXTRA_BANDS[0];
      res.json({
        ruleApplied: "regola1",
        routeId, fromStopId, toStopId,
        fromStop: { stopId: fromStopId, name: fromInfo.name, lat: fromInfo.lat, lon: fromInfo.lon, km: fromInfo.km },
        toStop:   { stopId: toStopId,   name: toInfo.name,   lat: toInfo.lat,   lon: toInfo.lon,   km: toInfo.km   },
        distanceKm: distKm,
        dominantTripCount: dominant.tripCount,
        dominantShapeId:   dominant.shapeId,
        altDistances,
        totalTripsDay, refServiceId,
        fascia: band.fascia, fareProductId: `extra_fascia_${band.fascia}`,
        amount: band.price, currency: "EUR", bandRange: `${band.kmFrom}–${band.kmTo} km`,
        intermediateStops,
        lineResults: [{
          routeId, km: distKm,
          fromKm: fromInfo.km,
          toKm:   toInfo.km,
          totalPathKm,
          dominantTripCount: dominant.tripCount,
          dominantShapeId:   dominant.shapeId,
          totalTripsDay,
          capolineaFirst: dominant.stops[0].stop_id,
          capolineaLast:  dominant.stops[dominant.stops.length - 1].stop_id,
          fromStopName: fromInfo.name,
          toStopName:   toInfo.name,
          intermediateStops,
        }],
      });
      return;
    }

    // ── Ricerca automatica tra le linee candidate (Regola 1 o Regola 2) ──
    const applicable = await findApplicableRoutes(feedId, fromStopId, toStopId);
    if (applicable.routes.length === 0) {
      res.status(404).json({ error: "Nessuna linea extraurbana trovata per questa coppia di fermate" });
      return;
    }

    const lineResults = applicable.routes.map(r => ({
      routeId:            r.routeId,
      km:                 r.km,
      fromKm:             r.fromKm,
      toKm:               r.toKm,
      totalPathKm:        r.totalPathKm,
      dominantTripCount:  r.dominantTripCount,
      dominantShapeId:    r.dominantShapeId,
      totalTripsDay:      r.totalTripsDay,
      capolineaFirst:     r.capolinea.first,
      capolineaLast:      r.capolinea.last,
      fromStopName:       r.fromInfo.name,
      toStopName:         r.toInfo.name,
      intermediateStops:  r.intermediateStops,
    }));

    if (applicable.ruleApplied === "regola2") {
      // Regola 2: distanza = media ponderata per tripCount tra le linee del gruppo
      const totalTrips = lineResults.reduce((s, r) => s + r.dominantTripCount, 0);
      const distKm = totalTrips > 0
        ? Math.round((lineResults.reduce((s, r) => s + r.km * r.dominantTripCount, 0) / totalTrips) * 100) / 100
        : lineResults[0].km;
      const band = getBandForDistance(distKm) ?? EXTRA_BANDS[0];

      res.json({
        ruleApplied: "regola2",
        fromStopId, toStopId,
        distanceKm: distKm,
        capolineaFirst: applicable.routes[0].capolinea.first,
        capolineaLast:  applicable.routes[0].capolinea.last,
        fascia: band.fascia, fareProductId: `extra_fascia_${band.fascia}`,
        amount: band.price, currency: "EUR", bandRange: `${band.kmFrom}–${band.kmTo} km`,
        lineResults,
      });
      return;
    }

    // Regola 1 fallback: singola linea migliore
    const only = applicable.routes[0];
    const distKm = only.km;
    const band = getBandForDistance(distKm) ?? EXTRA_BANDS[0];
    res.json({
      ruleApplied: "regola1",
      routeId: only.routeId,
      fromStopId, toStopId,
      fromStop: { stopId: fromStopId, name: only.fromInfo.name, lat: only.fromInfo.lat, lon: only.fromInfo.lon, km: only.fromInfo.km },
      toStop:   { stopId: toStopId,   name: only.toInfo.name,   lat: only.toInfo.lat,   lon: only.toInfo.lon,   km: only.toInfo.km   },
      distanceKm: distKm,
      dominantTripCount: only.dominantTripCount,
      dominantShapeId:   only.dominantShapeId,
      totalTripsDay:     only.totalTripsDay,
      fascia: band.fascia, fareProductId: `extra_fascia_${band.fascia}`,
      amount: band.price, currency: "EUR", bandRange: `${band.kmFrom}–${band.kmTo} km`,
      intermediateStops: only.intermediateStops,
      lineResults,
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// SIMULATE CLUSTER — ticket price based on cluster centroid distance
// ═══════════════════════════════════════════════════════════
router.post("/fares/simulate-cluster", async (req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.status(400).json({ error: "No GTFS feed" }); return; }
    const { fromStopId, toStopId } = req.body;
    if (!fromStopId || !toStopId) { res.status(400).json({ error: "fromStopId and toStopId required" }); return; }

    // Find the clusters these stops belong to
    const allClusterStops = await db.select().from(gtfsFareZoneClusterStops)
      .where(eq(gtfsFareZoneClusterStops.feedId, feedId));

    const fromCS = allClusterStops.find(s => s.stopId === fromStopId);
    const toCS = allClusterStops.find(s => s.stopId === toStopId);

    if (!fromCS) { res.status(404).json({ error: `Fermata partenza ${fromStopId} non assegnata a nessun cluster` }); return; }
    if (!toCS) { res.status(404).json({ error: `Fermata arrivo ${toStopId} non assegnata a nessun cluster` }); return; }

    // Load full cluster info
    const clusters = await db.select().from(gtfsFareZoneClusters).where(eq(gtfsFareZoneClusters.feedId, feedId));
    const fromCluster = clusters.find(c => c.clusterId === fromCS.clusterId);
    const toCluster = clusters.find(c => c.clusterId === toCS.clusterId);

    if (!fromCluster || !toCluster) { res.status(404).json({ error: "Cluster non trovato" }); return; }

    // Centroid-to-centroid distance
    const distKm = fromCluster.clusterId === toCluster.clusterId
      ? 0
      : haversineKm(fromCluster.centroidLat!, fromCluster.centroidLon!, toCluster.centroidLat!, toCluster.centroidLon!);
    const band = getBandForDistance(distKm) ?? (distKm <= 6 ? EXTRA_BANDS[0] : undefined);

    // Get all stops for both clusters (for hull rendering)
    const fromClusterStops = allClusterStops.filter(s => s.clusterId === fromCS.clusterId)
      .map(s => ({ stopId: s.stopId, stopName: s.stopName, lat: s.stopLat!, lon: s.stopLon! }));
    const toClusterStops = allClusterStops.filter(s => s.clusterId === toCS.clusterId)
      .map(s => ({ stopId: s.stopId, stopName: s.stopName, lat: s.stopLat!, lon: s.stopLon! }));

    // Stop info for from/to
    const fromStopInfo = fromClusterStops.find(s => s.stopId === fromStopId);
    const toStopInfo = toClusterStops.find(s => s.stopId === toStopId);

    res.json({
      type: "cluster",
      fromStop: fromStopInfo ? { stopId: fromStopInfo.stopId, name: fromStopInfo.stopName, lat: fromStopInfo.lat, lon: fromStopInfo.lon } : null,
      toStop: toStopInfo ? { stopId: toStopInfo.stopId, name: toStopInfo.stopName, lat: toStopInfo.lat, lon: toStopInfo.lon } : null,
      fromCluster: {
        clusterId: fromCluster.clusterId,
        clusterName: fromCluster.clusterName,
        color: fromCluster.color,
        centroidLat: fromCluster.centroidLat,
        centroidLon: fromCluster.centroidLon,
        stops: fromClusterStops,
      },
      toCluster: {
        clusterId: toCluster.clusterId,
        clusterName: toCluster.clusterName,
        color: toCluster.color,
        centroidLat: toCluster.centroidLat,
        centroidLon: toCluster.centroidLon,
        stops: toClusterStops,
      },
      sameCluster: fromCluster.clusterId === toCluster.clusterId,
      distanceKm: Math.round(distKm * 100) / 100,
      fascia: band ? band.fascia : null,
      amount: band ? band.price : null,
      currency: "EUR",
      bandRange: band ? `${band.kmFrom}-${band.kmTo} km` : null,
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// SIMULATE DIRECT — haversine pura fermata-a-fermata (nessun shape)
// ═══════════════════════════════════════════════════════════
router.post("/fares/simulate-direct", async (req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.status(400).json({ error: "No GTFS feed" }); return; }
    const { fromStopId, toStopId } = req.body;
    if (!fromStopId || !toStopId) { res.status(400).json({ error: "fromStopId and toStopId required" }); return; }

    // Carica coordinate delle due fermate
    const stopsData = await db.execute<any>(sql`
      SELECT stop_id, stop_name, stop_lat::float AS lat, stop_lon::float AS lon
      FROM gtfs_stops
      WHERE feed_id = ${feedId} AND stop_id IN (${sql`${fromStopId}`}, ${sql`${toStopId}`})
    `);

    const fromStop = stopsData.rows.find((r: any) => r.stop_id === fromStopId);
    const toStop = stopsData.rows.find((r: any) => r.stop_id === toStopId);
    if (!fromStop) { res.status(404).json({ error: `Fermata ${fromStopId} non trovata` }); return; }
    if (!toStop) { res.status(404).json({ error: `Fermata ${toStopId} non trovata` }); return; }

    // Distanza haversine pura (linea d'aria)
    const distKm = Math.round(
      haversineKm(fromStop.lat, fromStop.lon, toStop.lat, toStop.lon) * 100
    ) / 100;

    const band = getBandForDistance(distKm) ?? (distKm <= 6 ? EXTRA_BANDS[0] : undefined);

    res.json({
      type: "direct",
      fromStop: { stopId: fromStopId, name: fromStop.stop_name, lat: fromStop.lat, lon: fromStop.lon },
      toStop: { stopId: toStopId, name: toStop.stop_name, lat: toStop.lat, lon: toStop.lon },
      distanceKm: distKm,
      fascia: band ? band.fascia : null,
      amount: band ? band.price : null,
      currency: "EUR",
      bandRange: band ? `${band.kmFrom}-${band.kmTo} km` : null,
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// GENERATE GTFS FILES — returns JSON with all CSV content
// ═══════════════════════════════════════════════════════════

router.post("/fares/generate-gtfs", async (_req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.status(400).json({ error: "No GTFS feed" }); return; }

    // --- networks.txt ---
    const networks = await db.select().from(gtfsFareNetworks).where(eq(gtfsFareNetworks.feedId, feedId));
    let networksCsv = "network_id,network_name\n";
    for (const n of networks) networksCsv += `${n.networkId},${n.networkName}\n`;

    // --- route_networks.txt ---
    const routeNets = await db.select().from(gtfsRouteNetworks).where(eq(gtfsRouteNetworks.feedId, feedId));
    let routeNetCsv = "network_id,route_id\n";
    for (const rn of routeNets) routeNetCsv += `${rn.networkId},${rn.routeId}\n`;

    // --- fare_media.txt ---
    const media = await db.select().from(gtfsFareMedia)
      .where(and(eq(gtfsFareMedia.feedId, feedId), eq(gtfsFareMedia.isActive, true)));
    let mediaCsv = "fare_media_id,fare_media_name,fare_media_type\n";
    for (const m of media) mediaCsv += `${m.fareMediaId},${m.fareMediaName},${m.fareMediaType}\n`;

    // --- rider_categories.txt ---
    const cats = await db.select().from(gtfsRiderCategories).where(eq(gtfsRiderCategories.feedId, feedId));
    let catCsv = "rider_category_id,rider_category_name,is_default_fare_category,eligibility_url\n";
    for (const c of cats) {
      catCsv += `${c.riderCategoryId},${c.riderCategoryName},${c.isDefault ? 1 : 0},${c.eligibilityUrl || ""}\n`;
    }

    // --- fare_products.txt ---
    const products = await db.select().from(gtfsFareProducts).where(eq(gtfsFareProducts.feedId, feedId));
    let prodCsv = "fare_product_id,fare_product_name,rider_category_id,fare_media_id,amount,currency\n";
    for (const p of products) {
      prodCsv += `${p.fareProductId},${p.fareProductName},${p.riderCategoryId || ""},${p.fareMediaId || ""},${p.amount.toFixed(2)},${p.currency}\n`;
    }

    // --- areas.txt ---
    const areas = await db.select().from(gtfsFareAreas).where(eq(gtfsFareAreas.feedId, feedId));
    let areasCsv = "area_id,area_name\n";
    for (const a of areas) areasCsv += `${a.areaId},${a.areaName}\n`;

    // --- stop_areas.txt ---
    const stopAreas = await db.select().from(gtfsStopAreas).where(eq(gtfsStopAreas.feedId, feedId));
    let stopAreasCsv = "area_id,stop_id\n";
    for (const sa of stopAreas) stopAreasCsv += `${sa.areaId},${sa.stopId}\n`;

    // --- fare_leg_rules.txt ---
    const legRules = await db.select().from(gtfsFareLegRules).where(eq(gtfsFareLegRules.feedId, feedId));
    let legCsv = "leg_group_id,network_id,from_area_id,to_area_id,from_timeframe_group_id,to_timeframe_group_id,fare_product_id,rule_priority\n";
    for (const lr of legRules) {
      legCsv += `${lr.legGroupId},${lr.networkId || ""},${lr.fromAreaId || ""},${lr.toAreaId || ""},${lr.fromTimeframeGroupId || ""},${lr.toTimeframeGroupId || ""},${lr.fareProductId},${lr.rulePriority}\n`;
    }

    // --- fare_transfer_rules.txt ---
    const xferRules = await db.select().from(gtfsFareTransferRules).where(eq(gtfsFareTransferRules.feedId, feedId));
    let xferCsv = "from_leg_group_id,to_leg_group_id,transfer_count,duration_limit,duration_limit_type,fare_transfer_type,fare_product_id\n";
    for (const xr of xferRules) {
      xferCsv += `${xr.fromLegGroupId || ""},${xr.toLegGroupId || ""},${xr.transferCount ?? ""},${xr.durationLimit ?? ""},${xr.durationLimitType ?? ""},${xr.fareTransferType ?? ""},${xr.fareProductId || ""}\n`;
    }

    // --- timeframes.txt ---
    const timeframes = await db.select().from(gtfsTimeframes).where(eq(gtfsTimeframes.feedId, feedId));
    let tfCsv = "timeframe_group_id,start_time,end_time,service_id\n";
    for (const tf of timeframes) {
      tfCsv += `${tf.timeframeGroupId},${tf.startTime || ""},${tf.endTime || ""},${tf.serviceId || ""}\n`;
    }

    // --- fare_attributes.txt (Fares V1) --- REMOVED: using only Fares V2 to avoid consumer confusion
    // --- fare_rules.txt (Fares V1) --- REMOVED: using only Fares V2 to avoid consumer confusion

    // Validation summary
    const routeCount = routeNets.length;
    const allRoutes = await db.select().from(gtfsRoutes).where(eq(gtfsRoutes.feedId, feedId));
    const missingRoutes = allRoutes.filter(r => !routeNets.find(rn => rn.routeId === r.routeId));

    // Build files map — only include non-empty files (beyond header)
    const allFiles: Record<string, string> = {};
    const maybeAdd = (name: string, csv: string) => {
      const lines = csv.split("\n").filter(Boolean);
      if (lines.length > 1) allFiles[name] = csv; // >1 means has data rows beyond header
    };
    // Fares V2 only (no V1 — spec says consumers must use only one)
    maybeAdd("networks.txt", networksCsv);
    maybeAdd("route_networks.txt", routeNetCsv);
    maybeAdd("fare_media.txt", mediaCsv);
    maybeAdd("rider_categories.txt", catCsv);
    maybeAdd("fare_products.txt", prodCsv);
    maybeAdd("areas.txt", areasCsv);
    maybeAdd("stop_areas.txt", stopAreasCsv);
    maybeAdd("fare_leg_rules.txt", legCsv);
    maybeAdd("fare_transfer_rules.txt", xferCsv);
    maybeAdd("timeframes.txt", tfCsv);

    // --- feed_info.txt ---
    const feedInfoRows = await db.select().from(gtfsFeedInfo).where(eq(gtfsFeedInfo.feedId, feedId));
    if (feedInfoRows.length > 0) {
      const fi = feedInfoRows[0];
      let fiCsv = "feed_publisher_name,feed_publisher_url,feed_lang,default_lang,feed_start_date,feed_end_date,feed_version,feed_contact_email,feed_contact_url\n";
      fiCsv += `${fi.feedPublisherName},${fi.feedPublisherUrl},${fi.feedLang},${fi.defaultLang || ""},${fi.feedStartDate || ""},${fi.feedEndDate || ""},${fi.feedVersion || ""},${fi.feedContactEmail || ""},${fi.feedContactUrl || ""}\n`;
      allFiles["feed_info.txt"] = fiCsv;
    }

    res.json({
      files: allFiles,
      validation: {
        routesClassified: routeCount,
        totalRoutes: allRoutes.length,
        missingRoutes: missingRoutes.map(r => r.routeId),
        products: products.length,
        areas: areas.length,
        stopAreaAssignments: stopAreas.length,
        legRules: legRules.length,
        transferRules: xferRules.length,
        timeframes: timeframes.length,
        isComplete: missingRoutes.length === 0 && products.length > 0 && legRules.length > 0,
      },
    });
    await logAudit(feedId, "generate_gtfs", `Generazione GTFS Fares V2: ${products.length} prodotti, ${legRules.length} leg rules, ${stopAreas.length} stop-areas${missingRoutes.length > 0 ? ` — ${missingRoutes.length} linee non classificate` : ""}`);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// GET /api/fares/route-stops/:routeId — get ordered stops with progressive km (for zone editor)
// Metodo "Proiezione su Shape": media ponderata per tripCount su tutti i percorsi
router.get("/fares/route-stops/:routeId", async (req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.json([]); return; }
    const { routeId } = req.params;

    const { percorsi: allPercorsi, refServiceId, totalTripsDay } = await getRoutePercorsi(feedId, routeId);
    if (allPercorsi.length === 0) { res.json([]); return; }

    // Filtra per famiglia direzionale (stessa prima/ultima fermata del percorso più lungo)
    const ref = allPercorsi.reduce((a, b) => a.stops.length >= b.stops.length ? a : b);
    const refFirst = ref.stops[0]?.stop_id;
    const refLast = ref.stops[ref.stops.length - 1]?.stop_id;
    const percorsi = allPercorsi.filter(p => {
      const first = p.stops[0]?.stop_id;
      const last = p.stops[p.stops.length - 1]?.stop_id;
      return first === refFirst && last === refLast;
    });
    const filtered = percorsi.length > 0 ? percorsi : allPercorsi;

    // Per ogni fermata, accumula i km ponderati per tripCount da tutti i percorsi
    const stopKmAccumulator = new Map<string, {
      name: string; lat: number; lon: number;
      weightedKmValues: { km: number; weight: number; shapeId: string | null }[];
    }>();

    for (const percorso of filtered) {
      const kmMap = computeKmAlongShape(percorso.stops, percorso.shapeCoords);
      for (const [stopId, info] of kmMap) {
        if (!stopKmAccumulator.has(stopId)) {
          stopKmAccumulator.set(stopId, { name: info.name, lat: info.lat, lon: info.lon, weightedKmValues: [] });
        }
        stopKmAccumulator.get(stopId)!.weightedKmValues.push({ km: info.km, weight: percorso.tripCount, shapeId: percorso.shapeId });
      }
    }

    // Km finali = media ponderata per tripCount
    const existingAreas = await db.execute<any>(sql`
      SELECT sa.stop_id, sa.area_id, a.area_name, a.km_from, a.km_to
      FROM gtfs_stop_areas sa
      JOIN gtfs_fare_areas a ON a.area_id = sa.area_id AND a.feed_id = sa.feed_id
      WHERE sa.feed_id = ${feedId} AND a.route_id = ${routeId}
    `);
    const areaMap = new Map(existingAreas.rows.map((r: any) => [r.stop_id, r]));

    const result: any[] = [];
    for (const [stopId, data] of stopKmAccumulator) {
      const totalWeight = data.weightedKmValues.reduce((a, b) => a + b.weight, 0);
      const avgKm = data.weightedKmValues.reduce((a, b) => a + b.km * b.weight, 0) / totalWeight;
      const km = Math.round(avgKm * 100) / 100;
      const kmMin = Math.round(Math.min(...data.weightedKmValues.map(v => v.km)) * 100) / 100;
      const kmMax = Math.round(Math.max(...data.weightedKmValues.map(v => v.km)) * 100) / 100;
      const band = getBandForDistance(km) || (km === 0 ? EXTRA_BANDS[0] : null);
      const existing = areaMap.get(stopId);

      result.push({
        stopId,
        stopName: data.name,
        sequence: 0,
        lat: data.lat,
        lon: data.lon,
        progressiveKm: km,
        kmMin,
        kmMax,
        percorsiCount: filtered.length,
        totalTrips: totalWeight,
        percorsiDetail: data.weightedKmValues.map(v => ({ shapeId: v.shapeId, km: Math.round(v.km * 100) / 100, trips: v.weight })),
        totalTripsDay,
        refServiceId,
        suggestedFascia: band?.fascia || null,
        suggestedAreaId: band ? `${routeId}_zona_${band.fascia}` : null,
        currentAreaId: existing?.area_id || null,
        currentAreaName: existing?.area_name || null,
      });
    }
    // Ordina per km progressivo
    result.sort((a, b) => a.progressiveKm - b.progressiveKm);

    res.json(result);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// GET /api/fares/route-stops-dominant/:routeId — same but uses dominant percorso
router.get("/fares/route-stops-dominant/:routeId", async (req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.json([]); return; }
    const { routeId } = req.params;

    const { percorsi: allPercorsi, refServiceId, totalTripsDay } = await getRoutePercorsi(feedId, routeId);
    if (allPercorsi.length === 0) { res.json([]); return; }

    const { dominant, altPercorsi } = getDominantPercorso(allPercorsi);
    if (!dominant) { res.json([]); return; }

    const kmMap = computeKmAlongShape(dominant.stops, dominant.shapeCoords);

    const altKmMaps = altPercorsi.map(p => ({
      shapeId: p.shapeId,
      tripCount: p.tripCount,
      kmMap: computeKmAlongShape(p.stops, p.shapeCoords),
    }));

    const existingAreas = await db.execute<any>(sql`
      SELECT sa.stop_id, sa.area_id, a.area_name, a.km_from, a.km_to
      FROM gtfs_stop_areas sa
      JOIN gtfs_fare_areas a ON a.area_id = sa.area_id AND a.feed_id = sa.feed_id
      WHERE sa.feed_id = ${feedId} AND a.route_id = ${routeId}
    `);
    const areaMap = new Map(existingAreas.rows.map((r: any) => [r.stop_id, r]));

    const result = dominant.stops.map((s) => {
      const info = kmMap.get(s.stop_id)!;
      const km = Math.round(info.km * 100) / 100;
      const band = getBandForDistance(km) || (km === 0 ? EXTRA_BANDS[0] : null);
      const existing = areaMap.get(s.stop_id);

      const altInfo = altKmMaps
        .map(a => {
          const altStop = a.kmMap.get(s.stop_id);
          if (!altStop) return null;
          return { shapeId: a.shapeId, km: Math.round(altStop.km * 100) / 100, tripCount: a.tripCount };
        })
        .filter(Boolean);

      return {
        stopId: s.stop_id,
        stopName: s.stop_name,
        sequence: s.stop_sequence,
        lat: s.lat,
        lon: s.lon,
        progressiveKm: km,
        dominantTripCount: dominant.tripCount,
        dominantShapeId: dominant.shapeId,
        altPercorsi: altInfo,
        totalTripsDay,
        refServiceId,
        suggestedFascia: band?.fascia || null,
        suggestedAreaId: band ? `${routeId}_zona_${band.fascia}` : null,
        currentAreaId: existing?.area_id || null,
        currentAreaName: existing?.area_name || null,
      };
    });

    // Includi le coordinate della shape GTFS come campo separato (solo il primo elemento)
    // In questo modo il frontend può disegnare il tracciato reale sulla mappa
    const shapePoints: [number, number][] = dominant.shapeCoords ?? [];

    res.json({ stops: result, shapePoints, dominantShapeId: dominant.shapeId });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// ROUTE DOMINANT — inspect dominant percorso for a route
// ═══════════════════════════════════════════════════════════
router.get("/fares/route-dominant/:routeId", async (req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.status(400).json({ error: "No GTFS feed" }); return; }
    const { routeId } = req.params;

    const { percorsi: allPercorsi, refServiceId, totalTripsDay } = await getRoutePercorsi(feedId, routeId);
    if (allPercorsi.length === 0) { res.status(404).json({ error: "No trips" }); return; }

    const { dominant, altPercorsi, dirPercorsi } = getDominantPercorso(allPercorsi);
    if (!dominant) { res.status(404).json({ error: "No dominant" }); return; }

    res.json({
      routeId,
      refServiceId,
      totalTripsDay,
      totalPercorsi: allPercorsi.length,
      dirPercorsi: dirPercorsi.length,
      dominant: {
        tripId: dominant.tripId,
        shapeId: dominant.shapeId,
        tripCount: dominant.tripCount,
        stopsCount: dominant.stops.length,
        firstStop: dominant.stops[0]?.stop_name,
        lastStop: dominant.stops[dominant.stops.length - 1]?.stop_name,
      },
      altPercorsi: altPercorsi.map(p => ({
        tripId: p.tripId,
        shapeId: p.shapeId,
        tripCount: p.tripCount,
        stopsCount: p.stops.length,
        firstStop: p.stops[0]?.stop_name,
        lastStop: p.stops[p.stops.length - 1]?.stop_name,
      })),
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// FARES V1 — fare_attributes.txt & fare_rules.txt
// ═══════════════════════════════════════════════════════════

router.get("/fares/fare-attributes", async (_req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.json([]); return; }
    const rows = await db.select().from(gtfsFareAttributes).where(eq(gtfsFareAttributes.feedId, feedId));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/fares/fare-attributes", async (req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.status(400).json({ error: "No GTFS feed" }); return; }
    const { fareId, price, currencyType, paymentMethod, transfers, agencyId, transferDuration } = req.body;
    if (!fareId || price == null) { res.status(400).json({ error: "fareId and price required" }); return; }
    const [row] = await db.insert(gtfsFareAttributes).values({
      feedId, fareId, price: Number(price), currencyType: currencyType || "EUR",
      paymentMethod: paymentMethod ?? 0, transfers: transfers ?? null,
      agencyId: agencyId || "ATMA", transferDuration: transferDuration ?? null,
    }).returning();
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.put("/fares/fare-attributes/:id", async (req, res): Promise<void> => {
  try {
    const updates: any = {};
    if (req.body.price != null) updates.price = Number(req.body.price);
    if (req.body.paymentMethod != null) updates.paymentMethod = req.body.paymentMethod;
    if (req.body.transfers !== undefined) updates.transfers = req.body.transfers;
    if (req.body.transferDuration !== undefined) updates.transferDuration = req.body.transferDuration;
    const [row] = await db.update(gtfsFareAttributes).set(updates).where(eq(gtfsFareAttributes.id, req.params.id)).returning();
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/fares/fare-attributes/:id", async (req, res): Promise<void> => {
  try {
    await db.delete(gtfsFareAttributes).where(eq(gtfsFareAttributes.id, req.params.id));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Auto-seed Fares V1 from existing Fares V2 products
router.post("/fares/fare-attributes/seed", async (_req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.status(400).json({ error: "No GTFS feed" }); return; }
    // Delete existing
    await db.delete(gtfsFareAttributes).where(eq(gtfsFareAttributes.feedId, feedId));
    await db.delete(gtfsFareRules).where(eq(gtfsFareRules.feedId, feedId));
    // Generate from products
    const products = await db.select().from(gtfsFareProducts).where(eq(gtfsFareProducts.feedId, feedId));
    const routeNets = await db.select().from(gtfsRouteNetworks).where(eq(gtfsRouteNetworks.feedId, feedId));
    const attrs: any[] = [];
    const rules: any[] = [];
    for (const p of products) {
      attrs.push({
        feedId, fareId: p.fareProductId, price: p.amount, currencyType: p.currency,
        paymentMethod: 0, transfers: 0, agencyId: "ATMA", transferDuration: null,
      });
      // Create fare rules linking to routes of that product's network
      const matchingRoutes = routeNets.filter(rn => rn.networkId === p.networkId);
      for (const rn of matchingRoutes) {
        rules.push({ feedId, fareId: p.fareProductId, routeId: rn.routeId });
      }
    }
    if (attrs.length > 0) await db.insert(gtfsFareAttributes).values(attrs);
    if (rules.length > 0) await db.insert(gtfsFareRules).values(rules);
    res.json({ fareAttributes: attrs.length, fareRules: rules.length });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get("/fares/fare-rules", async (_req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.json([]); return; }
    const rows = await db.select().from(gtfsFareRules).where(eq(gtfsFareRules.feedId, feedId));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/fares/fare-rules", async (req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.status(400).json({ error: "No GTFS feed" }); return; }
    const { fareId, routeId, originId, destinationId, containsId } = req.body;
    if (!fareId) { res.status(400).json({ error: "fareId required" }); return; }
    const [row] = await db.insert(gtfsFareRules).values({
      feedId, fareId, routeId, originId, destinationId, containsId,
    }).returning();
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/fares/fare-rules/:id", async (req, res): Promise<void> => {
  try {
    await db.delete(gtfsFareRules).where(eq(gtfsFareRules.id, req.params.id));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// STOP TIMES EDITOR — pickup_type / drop_off_type per route
// ═══════════════════════════════════════════════════════════

// GET stop_times for a route (aggregated: one row per stop with pickup/dropoff)
router.get("/fares/stop-times/:routeId", async (req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.json([]); return; }
    const { routeId } = req.params;

    // Get the longest trip for the route (representative)
    const tripRows = await db.execute<any>(sql`
      SELECT t.trip_id, COUNT(*) AS cnt
      FROM gtfs_trips t
      JOIN gtfs_stop_times st ON st.trip_id = t.trip_id AND st.feed_id = t.feed_id
      WHERE t.feed_id = ${feedId} AND t.route_id = ${routeId}
      GROUP BY t.trip_id ORDER BY cnt DESC LIMIT 1
    `);
    if (tripRows.rows.length === 0) { res.json([]); return; }
    const repTripId = tripRows.rows[0].trip_id;

    const stData = await db.execute<any>(sql`
      SELECT st.stop_id, st.stop_sequence, st.pickup_type, st.drop_off_type,
             st.arrival_time, st.departure_time,
             s.stop_name, s.stop_lat::float AS lat, s.stop_lon::float AS lon
      FROM gtfs_stop_times st
      JOIN gtfs_stops s ON s.stop_id = st.stop_id AND s.feed_id = st.feed_id
      WHERE st.feed_id = ${feedId} AND st.trip_id = ${repTripId}
      ORDER BY st.stop_sequence
    `);

    res.json(stData.rows.map((r: any) => ({
      stopId: r.stop_id,
      stopName: r.stop_name,
      sequence: r.stop_sequence,
      lat: r.lat,
      lon: r.lon,
      arrivalTime: r.arrival_time,
      departureTime: r.departure_time,
      pickupType: r.pickup_type ?? 0,
      dropOffType: r.drop_off_type ?? 0,
    })));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// PUT bulk update pickup_type / drop_off_type for ALL trips of a route at a given stop
router.put("/fares/stop-times/:routeId", async (req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.status(400).json({ error: "No GTFS feed" }); return; }
    const { routeId } = req.params;
    const { updates } = req.body as { updates: { stopId: string; pickupType: number; dropOffType: number }[] };
    if (!updates || !Array.isArray(updates)) { res.status(400).json({ error: "updates array required" }); return; }

    // Get all trips for this route
    const trips = await db.select({ tripId: gtfsTrips.tripId }).from(gtfsTrips)
      .where(and(eq(gtfsTrips.feedId, feedId), eq(gtfsTrips.routeId, routeId)));
    const tripIds = trips.map(t => t.tripId);

    let updated = 0;
    for (const u of updates) {
      const result = await db.execute(sql`
        UPDATE gtfs_stop_times
        SET pickup_type = ${u.pickupType}, drop_off_type = ${u.dropOffType}
        WHERE feed_id = ${feedId} AND stop_id = ${u.stopId}
          AND trip_id = ANY(${tripIds})
      `);
      updated += (result as any).rowCount || 0;
    }

    res.json({ ok: true, updated });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// EXPORT ZIP — complete GTFS feed with all base tables + Fares V1 + Fares V2
// ═══════════════════════════════════════════════════════════

router.get("/fares/export-zip", async (_req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.status(400).json({ error: "No GTFS feed" }); return; }

    // Dynamically import archiver
    const archiver = (await import("archiver")).default;
    const archive = archiver("zip", { zlib: { level: 9 } });

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", "attachment; filename=gtfs_export.zip");
    archive.pipe(res);

    // --- agency.txt (hardcoded from original GTFS) ---
    archive.append(
      'agency_id,agency_name,agency_url,agency_timezone,agency_lang,agency_phone,agency_fare_url,agency_email\n' +
      '"ATMA","Atma Scpa","https://www.atmaancona.it","Europe/Rome","it","0712837468","https://www.atmaancona.it/tariffe/tariffe-generale/","info@atmaancona.it"\n',
      { name: "agency.txt" }
    );

    // --- stops.txt ---
    const stops = await db.select().from(gtfsStops).where(eq(gtfsStops.feedId, feedId));
    let stopsCsv = "stop_id,stop_code,stop_name,stop_desc,stop_lat,stop_lon,wheelchair_boarding\n";
    for (const s of stops) {
      stopsCsv += `${s.stopId},${s.stopCode || ""},${csvEscape(s.stopName)},${csvEscape(s.stopDesc || "")},${s.stopLat},${s.stopLon},${s.wheelchairBoarding || 0}\n`;
    }
    archive.append(stopsCsv, { name: "stops.txt" });

    // --- routes.txt ---
    const routes = await db.select().from(gtfsRoutes).where(eq(gtfsRoutes.feedId, feedId));
    let routesCsv = "route_id,agency_id,route_short_name,route_long_name,route_type,route_url,route_color,route_text_color\n";
    for (const r of routes) {
      routesCsv += `${r.routeId},${r.agencyId || "ATMA"},${csvEscape(r.routeShortName || "")},${csvEscape(r.routeLongName || "")},${r.routeType || 3},${r.routeUrl || "https://www.atmaancona.it"},${r.routeColor || ""},${r.routeTextColor || ""}\n`;
    }
    archive.append(routesCsv, { name: "routes.txt" });

    // --- trips.txt ---
    const tripsAll = await db.select().from(gtfsTrips).where(eq(gtfsTrips.feedId, feedId));
    let tripsCsv = "route_id,service_id,trip_id,trip_headsign,direction_id,shape_id\n";
    for (const t of tripsAll) {
      tripsCsv += `${t.routeId},${t.serviceId},${t.tripId},${csvEscape(t.tripHeadsign || "")},${t.directionId || 0},${t.shapeId || ""}\n`;
    }
    archive.append(tripsCsv, { name: "trips.txt" });

    // --- stop_times.txt (with pickup_type and drop_off_type) ---
    // Process in batches to handle ~321k rows
    const batchSize = 50000;
    let offset = 0;
    let stCsv = "trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type\n";
    let hasMore = true;
    while (hasMore) {
      const batch = await db.execute<any>(sql`
        SELECT trip_id, arrival_time, departure_time, stop_id, stop_sequence, pickup_type, drop_off_type
        FROM gtfs_stop_times WHERE feed_id = ${feedId}
        ORDER BY trip_id, stop_sequence
        LIMIT ${batchSize} OFFSET ${offset}
      `);
      for (const st of batch.rows) {
        stCsv += `${st.trip_id},${st.arrival_time || ""},${st.departure_time || ""},${st.stop_id},${st.stop_sequence},${st.pickup_type ?? 0},${st.drop_off_type ?? 0}\n`;
      }
      offset += batchSize;
      hasMore = batch.rows.length === batchSize;
    }
    archive.append(stCsv, { name: "stop_times.txt" });

    // --- calendar.txt ---
    const calendars = await db.select().from(gtfsCalendar).where(eq(gtfsCalendar.feedId, feedId));
    let calCsv = "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n";
    for (const c of calendars) {
      calCsv += `${c.serviceId},${c.monday},${c.tuesday},${c.wednesday},${c.thursday},${c.friday},${c.saturday},${c.sunday},${c.startDate},${c.endDate}\n`;
    }
    archive.append(calCsv, { name: "calendar.txt" });

    // --- calendar_dates.txt ---
    const calDates = await db.select().from(gtfsCalendarDates).where(eq(gtfsCalendarDates.feedId, feedId));
    let cdCsv = "service_id,date,exception_type\n";
    for (const cd of calDates) {
      cdCsv += `${cd.serviceId},${cd.date},${cd.exceptionType}\n`;
    }
    archive.append(cdCsv, { name: "calendar_dates.txt" });

    // --- shapes.txt ---
    const shapes = await db.select().from(gtfsShapes).where(eq(gtfsShapes.feedId, feedId));
    let shapesCsv = "shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\n";
    for (const sh of shapes) {
      const geo = sh.geojson as any;
      // Handle both Feature and bare LineString formats
      const coords = geo?.geometry?.coordinates ?? geo?.coordinates ?? (geo?.type === "LineString" ? geo.coordinates : null);
      if (coords && Array.isArray(coords)) {
        for (let i = 0; i < coords.length; i++) {
          const [lon, lat] = coords[i];
          shapesCsv += `${sh.shapeId},${lat},${lon},${i}\n`;
        }
      }
    }
    archive.append(shapesCsv, { name: "shapes.txt" });

    // --- Fares V1 REMOVED — using only Fares V2 to avoid consumer confusion ---

    // --- Fares V2 files ---
    const networks = await db.select().from(gtfsFareNetworks).where(eq(gtfsFareNetworks.feedId, feedId));
    if (networks.length > 0) {
      let csv = "network_id,network_name\n";
      for (const n of networks) csv += `${n.networkId},${n.networkName}\n`;
      archive.append(csv, { name: "networks.txt" });
    }

    const routeNets = await db.select().from(gtfsRouteNetworks).where(eq(gtfsRouteNetworks.feedId, feedId));
    if (routeNets.length > 0) {
      let csv = "network_id,route_id\n";
      for (const rn of routeNets) csv += `${rn.networkId},${rn.routeId}\n`;
      archive.append(csv, { name: "route_networks.txt" });
    }

    const media = await db.select().from(gtfsFareMedia)
      .where(and(eq(gtfsFareMedia.feedId, feedId), eq(gtfsFareMedia.isActive, true)));
    if (media.length > 0) {
      let csv = "fare_media_id,fare_media_name,fare_media_type\n";
      for (const m of media) csv += `${m.fareMediaId},${m.fareMediaName},${m.fareMediaType}\n`;
      archive.append(csv, { name: "fare_media.txt" });
    }

    const cats = await db.select().from(gtfsRiderCategories).where(eq(gtfsRiderCategories.feedId, feedId));
    if (cats.length > 0) {
      let csv = "rider_category_id,rider_category_name,is_default_fare_category,eligibility_url\n";
      for (const c of cats) csv += `${c.riderCategoryId},${c.riderCategoryName},${c.isDefault ? 1 : 0},${c.eligibilityUrl || ""}\n`;
      archive.append(csv, { name: "rider_categories.txt" });
    }

    const prods = await db.select().from(gtfsFareProducts).where(eq(gtfsFareProducts.feedId, feedId));
    if (prods.length > 0) {
      let csv = "fare_product_id,fare_product_name,rider_category_id,fare_media_id,amount,currency\n";
      for (const p of prods) csv += `${p.fareProductId},${p.fareProductName},${p.riderCategoryId || ""},${p.fareMediaId || ""},${p.amount.toFixed(2)},${p.currency}\n`;
      archive.append(csv, { name: "fare_products.txt" });
    }

    const areas = await db.select().from(gtfsFareAreas).where(eq(gtfsFareAreas.feedId, feedId));
    if (areas.length > 0) {
      let csv = "area_id,area_name\n";
      for (const a of areas) csv += `${a.areaId},${a.areaName}\n`;
      archive.append(csv, { name: "areas.txt" });
    }

    const sa = await db.select().from(gtfsStopAreas).where(eq(gtfsStopAreas.feedId, feedId));
    if (sa.length > 0) {
      let csv = "area_id,stop_id\n";
      for (const s of sa) csv += `${s.areaId},${s.stopId}\n`;
      archive.append(csv, { name: "stop_areas.txt" });
    }

    const lr = await db.select().from(gtfsFareLegRules).where(eq(gtfsFareLegRules.feedId, feedId));
    if (lr.length > 0) {
      let csv = "leg_group_id,network_id,from_area_id,to_area_id,from_timeframe_group_id,to_timeframe_group_id,fare_product_id,rule_priority\n";
      for (const l of lr) csv += `${l.legGroupId},${l.networkId || ""},${l.fromAreaId || ""},${l.toAreaId || ""},${l.fromTimeframeGroupId || ""},${l.toTimeframeGroupId || ""},${l.fareProductId},${l.rulePriority}\n`;
      archive.append(csv, { name: "fare_leg_rules.txt" });
    }

    const xr = await db.select().from(gtfsFareTransferRules).where(eq(gtfsFareTransferRules.feedId, feedId));
    if (xr.length > 0) {
      let csv = "from_leg_group_id,to_leg_group_id,transfer_count,duration_limit,duration_limit_type,fare_transfer_type,fare_product_id\n";
      for (const x of xr) csv += `${x.fromLegGroupId || ""},${x.toLegGroupId || ""},${x.transferCount ?? ""},${x.durationLimit ?? ""},${x.durationLimitType ?? ""},${x.fareTransferType ?? ""},${x.fareProductId || ""}\n`;
      archive.append(csv, { name: "fare_transfer_rules.txt" });
    }

    const tf = await db.select().from(gtfsTimeframes).where(eq(gtfsTimeframes.feedId, feedId));
    if (tf.length > 0) {
      let csv = "timeframe_group_id,start_time,end_time,service_id\n";
      for (const t of tf) csv += `${t.timeframeGroupId},${t.startTime || ""},${t.endTime || ""},${t.serviceId || ""}\n`;
      archive.append(csv, { name: "timeframes.txt" });
    }

    // --- feed_info.txt ---
    const feedInfoRows = await db.select().from(gtfsFeedInfo).where(eq(gtfsFeedInfo.feedId, feedId));
    if (feedInfoRows.length > 0) {
      const fi = feedInfoRows[0];
      let fiCsv = "feed_publisher_name,feed_publisher_url,feed_lang,default_lang,feed_start_date,feed_end_date,feed_version,feed_contact_email,feed_contact_url\n";
      fiCsv += `${fi.feedPublisherName},${fi.feedPublisherUrl},${fi.feedLang},${fi.defaultLang || ""},${fi.feedStartDate || ""},${fi.feedEndDate || ""},${fi.feedVersion || ""},${fi.feedContactEmail || ""},${fi.feedContactUrl || ""}\n`;
      archive.append(fiCsv, { name: "feed_info.txt" });
    }

    await archive.finalize();
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

/** Escape a string for CSV (wraps in quotes if it contains commas, quotes, or newlines) */
function csvEscape(s: string): string {
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

// ═══════════════════════════════════════════════════════════
// STOPS CLASSIFICATION v2 — codici dettagliati per rete
// ═══════════════════════════════════════════════════════════
//
// Codifica:
//   0  = Non servita / non classificata
//   1  = Extraurbano puro
//   2  = Urbano Ancona            (solo)
//   3  = Urbano Jesi              (solo)
//   4  = Urbano Falconara         (solo)
//   5  = Urbano Senigallia        (solo)
//   6  = Urbano Castelfidardo     (solo)
//   7  = Urbano Sassoferrato      (solo)
//   12 = Mista Extraurbano + Urbano Ancona
//   13 = Mista Extraurbano + Urbano Jesi
//   14 = Mista Extraurbano + Urbano Falconara
//   15 = Mista Extraurbano + Urbano Senigallia
//   16 = Mista Extraurbano + Urbano Castelfidardo
//   17 = Mista Extraurbano + Urbano Sassoferrato
//   99 = Multi-rete non prevista (multi-urbano o ≥3 reti)
//
// Deriva dagli endpoint:
//   GET /api/fares/stops-classification          → JSON dettagliato per fermata
//   GET /api/fares/stops-classification/summary  → conteggio per ogni codice
//   GET /api/fares/stops-classification/export   → stops.txt con colonne classificazione
// ═══════════════════════════════════════════════════════════

const URBAN_CODES: Record<string, { pure: number; mixed: number; label: string; short: string }> = {
  urbano_ancona:        { pure: 2, mixed: 12, label: "Ancona",        short: "AN" },
  urbano_jesi:          { pure: 3, mixed: 13, label: "Jesi",          short: "JE" },
  urbano_falconara:     { pure: 4, mixed: 14, label: "Falconara",     short: "FA" },
  urbano_senigallia:    { pure: 5, mixed: 15, label: "Senigallia",    short: "SE" },
  urbano_castelfidardo: { pure: 6, mixed: 16, label: "Castelfidardo", short: "CF" },
  urbano_sassoferrato:  { pure: 7, mixed: 17, label: "Sassoferrato",  short: "SS" },
};

interface StopClassification {
  classification: number;
  classLabel: string;
  classShortCode: string;
}

function deriveClassification(networks: Set<string>): StopClassification {
  const hasExtra = networks.has("extraurbano");
  const urbanNets = Array.from(networks).filter(n => n.startsWith("urbano_"));

  // 0 — non servita
  if (networks.size === 0) {
    return { classification: 0, classLabel: "Non servita", classShortCode: "NONE" };
  }

  // 1 — solo extraurbano
  if (hasExtra && urbanNets.length === 0) {
    return { classification: 1, classLabel: "Extraurbano", classShortCode: "EXTRA" };
  }

  // 2–7 — un solo urbano, nessun extraurbano
  if (!hasExtra && urbanNets.length === 1) {
    const u = URBAN_CODES[urbanNets[0]];
    if (u) return {
      classification: u.pure,
      classLabel: `Urbano ${u.label}`,
      classShortCode: `URB_${u.short}`,
    };
  }

  // 12–17 — un solo urbano + extraurbano
  if (hasExtra && urbanNets.length === 1) {
    const u = URBAN_CODES[urbanNets[0]];
    if (u) return {
      classification: u.mixed,
      classLabel: `Mista Extraurbano + Urbano ${u.label}`,
      classShortCode: `MIX_EX_${u.short}`,
    };
  }

  // 99 — tutto il resto (multi-urbano, ≥3 reti, network sconosciuti)
  return { classification: 99, classLabel: "Multi-rete non prevista", classShortCode: "OTHER" };
}

/**
 * Per ogni fermata:
 *   1. Raccoglie l'insieme dei network_id serviti (via stop_times → trips → route_networks)
 *   2. Applica deriveClassification() per ottenere (classification, classLabel, classShortCode)
 *   3. Restituisce anche networks[], routeCount, urbanRoutes, extraRoutes
 */
async function computeStopsClassification(feedId: string) {
  // 1. Tutte le fermate
  const stops = await db.select({
    stopId: gtfsStops.stopId,
    stopCode: gtfsStops.stopCode,
    stopName: gtfsStops.stopName,
    stopLat: gtfsStops.stopLat,
    stopLon: gtfsStops.stopLon,
    wheelchairBoarding: gtfsStops.wheelchairBoarding,
  }).from(gtfsStops).where(eq(gtfsStops.feedId, feedId));

  // 2. Mappa routeId → networkId
  const assignments = await db.select().from(gtfsRouteNetworks).where(eq(gtfsRouteNetworks.feedId, feedId));
  const routeNetworkMap = new Map<string, string>();
  for (const a of assignments) routeNetworkMap.set(a.routeId, a.networkId);

  // 3. Mappa stopId → Set<routeId> (via stop_times → trips)
  const stopRoutesQuery = await db.execute(sql`
    SELECT DISTINCT st.stop_id, t.route_id
    FROM gtfs_stop_times st
    JOIN gtfs_trips t ON t.feed_id = st.feed_id AND t.trip_id = st.trip_id
    WHERE st.feed_id = ${feedId}
  `);
  const stopRoutesMap = new Map<string, Set<string>>();
  for (const row of stopRoutesQuery.rows) {
    const sid = row.stop_id as string;
    const rid = row.route_id as string;
    if (!stopRoutesMap.has(sid)) stopRoutesMap.set(sid, new Set());
    stopRoutesMap.get(sid)!.add(rid);
  }

  // 4. Classifica ogni fermata
  return stops.map(s => {
    const routeIds = stopRoutesMap.get(s.stopId) ?? new Set<string>();

    // Reti distinte + conteggi urbano/extraurbano
    const networks = new Set<string>();
    let urban = 0, extra = 0;
    for (const rid of routeIds) {
      const net = routeNetworkMap.get(rid);
      if (!net) continue;
      networks.add(net);
      if (net === "extraurbano") extra++;
      else if (net.startsWith("urbano_")) urban++;
    }

    const { classification, classLabel, classShortCode } = deriveClassification(networks);

    return {
      ...s,
      classification,
      classLabel,
      classShortCode,
      networks: Array.from(networks).sort(),
      routeCount: routeIds.size,
      urbanRoutes: urban,
      extraRoutes: extra,
    };
  });
}

// GET /api/fares/stops-classification — JSON dettagliato per fermata
router.get("/fares/stops-classification", async (_req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.json([]); return; }
    const result = await computeStopsClassification(feedId);
    res.json(result);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// GET /api/fares/stops-classification/summary — conteggio per ogni codice
router.get("/fares/stops-classification/summary", async (_req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.json([]); return; }
    const classified = await computeStopsClassification(feedId);

    // Aggrega per classification
    const agg = new Map<number, { classification: number; classLabel: string; classShortCode: string; count: number }>();
    for (const s of classified) {
      const existing = agg.get(s.classification);
      if (existing) existing.count++;
      else agg.set(s.classification, {
        classification: s.classification,
        classLabel: s.classLabel,
        classShortCode: s.classShortCode,
        count: 1,
      });
    }

    const total = classified.length;
    const summary = Array.from(agg.values())
      .sort((a, b) => a.classification - b.classification)
      .map(r => ({
        ...r,
        percent: total > 0 ? Math.round((r.count / total) * 10000) / 100 : 0,
      }));

    res.json({ total, summary });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// GET /api/fares/stops-classification/export — stops.txt con colonne classificazione
router.get("/fares/stops-classification/export", async (_req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.status(400).json({ error: "No GTFS feed" }); return; }
    const classified = await computeStopsClassification(feedId);

    // stops.txt esteso con classificazione numerica e label testuale
    let csv = "stop_id,stop_code,stop_name,stop_lat,stop_lon,wheelchair_boarding,stop_classification,stop_classification_label\n";
    for (const s of classified) {
      csv += `${s.stopId},${s.stopCode || ""},${csvEscape(s.stopName)},${s.stopLat},${s.stopLon},${s.wheelchairBoarding ?? 0},${s.classification},${csvEscape(s.classLabel)}\n`;
    }

    // Audit log
    await logAudit(feedId, "export_stops_classification",
      `Export stops.txt con classificazione dettagliata: ${classified.length} fermate`);

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="stops.txt"');
    res.send(csv);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// GET /api/fares/stops-classification/export — stops.txt with extra stop_classification field
router.get("/fares/stops-classification/export", async (_req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.status(400).json({ error: "No GTFS feed" }); return; }
    const classified = await computeStopsClassification(feedId);

    // Build stops.txt with extended field
    let csv = "stop_id,stop_code,stop_name,stop_lat,stop_lon,wheelchair_boarding,stop_classification\n";
    for (const s of classified) {
      csv += `${s.stopId},${s.stopCode || ""},${csvEscape(s.stopName)},${s.stopLat},${s.stopLon},${s.wheelchairBoarding ?? 0},${s.classification}\n`;
    }

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="stops.txt"');
    res.send(csv);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// FARE ZONE CLUSTERS — cluster-based zoning (alternative to km-based)
// ═══════════════════════════════════════════════════════════

// GET /api/fares/zone-clusters — list all clusters
router.get("/fares/zone-clusters", async (_req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.json([]); return; }
    const clusters = await db.select().from(gtfsFareZoneClusters).where(eq(gtfsFareZoneClusters.feedId, feedId));
    // Also fetch stop counts
    const stopCounts = await db.execute<any>(sql`
      SELECT cluster_id, COUNT(*)::int AS cnt
      FROM gtfs_fare_zone_cluster_stops
      WHERE feed_id = ${feedId}
      GROUP BY cluster_id
    `);
    const countMap = new Map<string, number>();
    for (const r of stopCounts.rows) countMap.set(r.cluster_id, r.cnt);
    res.json(clusters.map(c => ({ ...c, stopCount: countMap.get(c.clusterId) || 0 })));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// GET /api/fares/zone-clusters/full — clusters with full stops array
router.get("/fares/zone-clusters/full", async (_req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.json([]); return; }
    const clusters = await db.select().from(gtfsFareZoneClusters).where(eq(gtfsFareZoneClusters.feedId, feedId));
    const allStops = await db.select().from(gtfsFareZoneClusterStops).where(eq(gtfsFareZoneClusterStops.feedId, feedId));
    const stopsMap = new Map<string, typeof allStops>();
    for (const s of allStops) {
      if (!stopsMap.has(s.clusterId)) stopsMap.set(s.clusterId, []);
      stopsMap.get(s.clusterId)!.push(s);
    }
    res.json(clusters.map(c => ({
      ...c,
      stopCount: stopsMap.get(c.clusterId)?.length || 0,
      stops: (stopsMap.get(c.clusterId) || []).map(s => ({
        stopId: s.stopId,
        stopName: s.stopName,
        stopLat: s.stopLat,
        stopLon: s.stopLon,
      })),
    })));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// POST /api/fares/zone-clusters — create or update a cluster
router.post("/fares/zone-clusters", async (req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.status(400).json({ error: "No GTFS feed" }); return; }
    const { clusterId, clusterName, polygon, color } = req.body;
    if (!clusterId || !clusterName) { res.status(400).json({ error: "clusterId and clusterName required" }); return; }

    // Calculate centroid from polygon or from stops
    let centroidLat: number | null = null;
    let centroidLon: number | null = null;
    if (polygon?.coordinates?.[0]) {
      const ring = polygon.coordinates[0] as number[][];
      centroidLon = ring.reduce((s, c) => s + c[0], 0) / ring.length;
      centroidLat = ring.reduce((s, c) => s + c[1], 0) / ring.length;
    }

    const [row] = await db.insert(gtfsFareZoneClusters).values({
      feedId, clusterId, clusterName,
      polygon: polygon || null,
      centroidLat, centroidLon,
      color: color || "#3b82f6",
    }).onConflictDoUpdate({
      target: [gtfsFareZoneClusters.feedId, gtfsFareZoneClusters.clusterId],
      set: { clusterName, polygon: polygon || null, centroidLat, centroidLon, color: color || "#3b82f6", updatedAt: sql`now()` },
    }).returning();
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// PUT /api/fares/zone-clusters/:id — update cluster
router.put("/fares/zone-clusters/:id", async (req, res): Promise<void> => {
  try {
    const { clusterName, polygon, color } = req.body;
    let centroidLat: number | null = null;
    let centroidLon: number | null = null;
    if (polygon?.coordinates?.[0]) {
      const ring = polygon.coordinates[0] as number[][];
      centroidLon = ring.reduce((s, c) => s + c[0], 0) / ring.length;
      centroidLat = ring.reduce((s, c) => s + c[1], 0) / ring.length;
    }
    const [row] = await db.update(gtfsFareZoneClusters)
      .set({ clusterName, polygon: polygon || null, centroidLat, centroidLon, color, updatedAt: sql`now()` })
      .where(eq(gtfsFareZoneClusters.id, req.params.id))
      .returning();
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/fares/zone-clusters/:id — delete cluster + its stops
router.delete("/fares/zone-clusters/:id", async (req, res): Promise<void> => {
  try {
    // Get the cluster to find its clusterId for stop cleanup
    const [cluster] = await db.select().from(gtfsFareZoneClusters).where(eq(gtfsFareZoneClusters.id, req.params.id));
    if (cluster) {
      await db.delete(gtfsFareZoneClusterStops).where(
        and(eq(gtfsFareZoneClusterStops.feedId, cluster.feedId!), eq(gtfsFareZoneClusterStops.clusterId, cluster.clusterId))
      );
    }
    await db.delete(gtfsFareZoneClusters).where(eq(gtfsFareZoneClusters.id, req.params.id));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// GET /api/fares/zone-clusters/:clusterId/stops — get stops for a cluster
router.get("/fares/zone-clusters/:clusterId/stops", async (req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.json([]); return; }
    const rows = await db.select().from(gtfsFareZoneClusterStops)
      .where(and(eq(gtfsFareZoneClusterStops.feedId, feedId), eq(gtfsFareZoneClusterStops.clusterId, req.params.clusterId)));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// POST /api/fares/zone-clusters/:clusterId/stops — set stops for a cluster (replace all)
// ENFORCES PARTITION: each stop can belong to only one cluster
router.post("/fares/zone-clusters/:clusterId/stops", async (req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.status(400).json({ error: "No GTFS feed" }); return; }
    const { clusterId } = req.params;
    const { stops } = req.body as { stops: { stopId: string; stopName: string; stopLat: number; stopLon: number }[] };
    if (!Array.isArray(stops)) { res.status(400).json({ error: "stops array required" }); return; }

    // Remove these stops from any other cluster first (enforce partition)
    const stopIds = stops.map(s => s.stopId);
    if (stopIds.length > 0) {
      await db.delete(gtfsFareZoneClusterStops).where(
        and(
          eq(gtfsFareZoneClusterStops.feedId, feedId),
          sql`cluster_id != ${clusterId}`,
          inArray(gtfsFareZoneClusterStops.stopId, stopIds),
        )
      );
    }
    // Replace all stops for this cluster
    await db.delete(gtfsFareZoneClusterStops).where(
      and(eq(gtfsFareZoneClusterStops.feedId, feedId), eq(gtfsFareZoneClusterStops.clusterId, clusterId))
    );
    if (stops.length > 0) {
      const batchSize = 500;
      for (let b = 0; b < stops.length; b += batchSize) {
        const batch = stops.slice(b, b + batchSize);
        await db.insert(gtfsFareZoneClusterStops).values(
          batch.map(s => ({ feedId, clusterId, stopId: s.stopId, stopName: s.stopName, stopLat: s.stopLat, stopLon: s.stopLon }))
        );
      }
    }
    // Recalculate centroid
    if (stops.length > 0) {
      const cLat = stops.reduce((sum, s) => sum + s.stopLat, 0) / stops.length;
      const cLon = stops.reduce((sum, s) => sum + s.stopLon, 0) / stops.length;
      await db.update(gtfsFareZoneClusters)
        .set({ centroidLat: cLat, centroidLon: cLon, updatedAt: sql`now()` })
        .where(and(eq(gtfsFareZoneClusters.feedId, feedId), eq(gtfsFareZoneClusters.clusterId, clusterId)));
    }
    res.json({ ok: true, stopsSet: stops.length });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// GET /api/fares/zone-clusters/distance-matrix — centroid distance matrix between clusters
router.get("/fares/zone-clusters/distance-matrix", async (_req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.json({ clusters: [], matrix: [] }); return; }
    const clusters = await db.select().from(gtfsFareZoneClusters).where(eq(gtfsFareZoneClusters.feedId, feedId));
    const valid = clusters.filter(c => c.centroidLat != null && c.centroidLon != null);
    const matrix: { from: string; to: string; distanceKm: number; fascia: number | null }[] = [];
    for (let i = 0; i < valid.length; i++) {
      for (let j = 0; j < valid.length; j++) {
        if (i === j) continue;
        const dist = haversineKm(valid[i].centroidLat!, valid[i].centroidLon!, valid[j].centroidLat!, valid[j].centroidLon!);
        const band = getBandForDistance(dist);
        matrix.push({ from: valid[i].clusterId, to: valid[j].clusterId, distanceKm: Math.round(dist * 10) / 10, fascia: band?.fascia ?? null });
      }
    }
    res.json({ clusters: valid.map(c => ({ id: c.clusterId, name: c.clusterName, color: c.color })), matrix });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// POST /api/fares/zone-clusters/generate-zones — generate areas + stop_areas + leg_rules from clusters
router.post("/fares/zone-clusters/generate-zones", async (_req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.status(400).json({ error: "No GTFS feed" }); return; }

    const clusters = await db.select().from(gtfsFareZoneClusters).where(eq(gtfsFareZoneClusters.feedId, feedId));
    if (clusters.length === 0) { res.status(400).json({ error: "No clusters defined" }); return; }

    // 1) Delete existing extraurban areas, stop_areas, and leg_rules (only extraurban — keep urban)
    const existingExtraAreas = await db.select().from(gtfsFareAreas)
      .where(and(eq(gtfsFareAreas.feedId, feedId), eq(gtfsFareAreas.networkId, "extraurbano")));
    if (existingExtraAreas.length > 0) {
      const areaIds = existingExtraAreas.map(a => a.areaId);
      await db.delete(gtfsStopAreas).where(and(eq(gtfsStopAreas.feedId, feedId), inArray(gtfsStopAreas.areaId, areaIds)));
      await db.delete(gtfsFareAreas).where(and(eq(gtfsFareAreas.feedId, feedId), eq(gtfsFareAreas.networkId, "extraurbano")));
    }
    // Delete existing extraurban leg rules
    await db.delete(gtfsFareLegRules).where(
      and(eq(gtfsFareLegRules.feedId, feedId), eq(gtfsFareLegRules.networkId, "extraurbano"))
    );

    // 2) Create one area per cluster
    let areasCreated = 0;
    for (const c of clusters) {
      await db.insert(gtfsFareAreas).values({
        feedId,
        areaId: `cluster_${c.clusterId}`,
        areaName: c.clusterName,
        networkId: "extraurbano",
      }).onConflictDoUpdate({
        target: [gtfsFareAreas.feedId, gtfsFareAreas.areaId],
        set: { areaName: c.clusterName, updatedAt: sql`now()` },
      });
      areasCreated++;
    }

    // 3) Assign cluster stops to areas
    let stopsAssigned = 0;
    for (const c of clusters) {
      const cStops = await db.select().from(gtfsFareZoneClusterStops)
        .where(and(eq(gtfsFareZoneClusterStops.feedId, feedId), eq(gtfsFareZoneClusterStops.clusterId, c.clusterId)));
      for (const s of cStops) {
        await db.insert(gtfsStopAreas).values({
          feedId, areaId: `cluster_${c.clusterId}`, stopId: s.stopId,
        }).onConflictDoNothing();
        stopsAssigned++;
      }
    }

    // 4) Generate OD leg rules based on centroid distances
    const validClusters = clusters.filter(c => c.centroidLat != null && c.centroidLon != null);
    let odRules = 0;
    for (let i = 0; i < validClusters.length; i++) {
      for (let j = 0; j < validClusters.length; j++) {
        if (i === j) continue;
        const dist = haversineKm(validClusters[i].centroidLat!, validClusters[i].centroidLon!, validClusters[j].centroidLat!, validClusters[j].centroidLon!);
        const band = getBandForDistance(dist);
        if (!band) continue;
        await db.insert(gtfsFareLegRules).values({
          feedId,
          legGroupId: "lg_extra_cluster",
          networkId: "extraurbano",
          fromAreaId: `cluster_${validClusters[i].clusterId}`,
          toAreaId: `cluster_${validClusters[j].clusterId}`,
          fareProductId: `extra_fascia_${band.fascia}`,
          rulePriority: 0,
        });
        odRules++;
      }
    }

    res.json({ areasCreated, stopsAssigned, odRules, totalClusters: clusters.length });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// AUTO-GENERATE CLUSTERS from extraurban route data
// ═══════════════════════════════════════════════════════════

// Shared color palette for auto-generated clusters
const AUTO_CLUSTER_COLORS = [
  "#ef4444", "#f97316", "#eab308", "#22c55e", "#06b6d4", "#3b82f6", "#8b5cf6",
  "#ec4899", "#14b8a6", "#f59e0b", "#6366f1", "#d946ef", "#84cc16", "#0ea5e9",
];

type AutoStop = { stop_id: string; stop_name: string; lat: number; lon: number };

/** Fetch all extraurban stops for the given feed */
async function fetchExtraStops(feedId: string): Promise<AutoStop[]> {
  const r = await db.execute<any>(sql`
    SELECT DISTINCT s.stop_id, s.stop_name, s.stop_lat::float AS lat, s.stop_lon::float AS lon
    FROM gtfs_stops s
    JOIN gtfs_stop_times st ON st.stop_id = s.stop_id AND st.feed_id = s.feed_id
    JOIN gtfs_trips t ON t.trip_id = st.trip_id AND t.feed_id = s.feed_id
    JOIN gtfs_route_networks rn ON rn.route_id = t.route_id AND rn.feed_id = t.feed_id
    WHERE s.feed_id = ${feedId} AND rn.network_id = 'extraurbano'
    ORDER BY s.stop_name
  `);
  return r.rows as AutoStop[];
}

/** Delete all clusters + stops for a feed, then persist the given cluster→stops mapping */
async function persistClusters(
  feedId: string,
  clusterDefs: { clusterId: string; clusterName: string; color: string; stops: AutoStop[] }[],
) {
  await db.delete(gtfsFareZoneClusterStops).where(eq(gtfsFareZoneClusterStops.feedId, feedId));
  await db.delete(gtfsFareZoneClusters).where(eq(gtfsFareZoneClusters.feedId, feedId));

  let clustersCreated = 0;
  let totalStopsAssigned = 0;

  for (const def of clusterDefs) {
    if (def.stops.length === 0) continue;
    const cLat = def.stops.reduce((s, st) => s + st.lat, 0) / def.stops.length;
    const cLon = def.stops.reduce((s, st) => s + st.lon, 0) / def.stops.length;

    await db.insert(gtfsFareZoneClusters).values({
      feedId, clusterId: def.clusterId, clusterName: def.clusterName,
      polygon: null, centroidLat: cLat, centroidLon: cLon, color: def.color,
    }).onConflictDoUpdate({
      target: [gtfsFareZoneClusters.feedId, gtfsFareZoneClusters.clusterId],
      set: { clusterName: def.clusterName, centroidLat: cLat, centroidLon: cLon, color: def.color, updatedAt: sql`now()` },
    });

    const batchSize = 500;
    for (let b = 0; b < def.stops.length; b += batchSize) {
      const batch = def.stops.slice(b, b + batchSize);
      await db.insert(gtfsFareZoneClusterStops).values(
        batch.map(s => ({ feedId, clusterId: def.clusterId, stopId: s.stop_id, stopName: s.stop_name, stopLat: s.lat, stopLon: s.lon }))
      );
    }

    clustersCreated++;
    totalStopsAssigned += def.stops.length;
  }
  return { clustersCreated, totalStopsAssigned };
}

// ─── K-Means implementation (geographic, haversine-based) ───
function kMeansSpatial(stops: AutoStop[], k: number, maxIter = 40): { centroid: { lat: number; lon: number }; stops: AutoStop[] }[] {
  // Initialize centroids using k-means++ for better spread
  const centroids: { lat: number; lon: number }[] = [];
  // Pick first centroid randomly
  centroids.push({ lat: stops[Math.floor(Math.random() * stops.length)].lat, lon: stops[Math.floor(Math.random() * stops.length)].lon });

  for (let c = 1; c < k; c++) {
    // For each stop, compute distance to nearest existing centroid
    const dists = stops.map(s => {
      let minD = Infinity;
      for (const ctr of centroids) {
        const d = haversineKm(s.lat, s.lon, ctr.lat, ctr.lon);
        if (d < minD) minD = d;
      }
      return minD * minD; // square for probability weighting
    });
    const totalDist = dists.reduce((a, b) => a + b, 0);
    // Weighted random pick
    let r = Math.random() * totalDist;
    for (let i = 0; i < dists.length; i++) {
      r -= dists[i];
      if (r <= 0) { centroids.push({ lat: stops[i].lat, lon: stops[i].lon }); break; }
    }
    if (centroids.length === c) centroids.push({ lat: stops[Math.floor(Math.random() * stops.length)].lat, lon: stops[Math.floor(Math.random() * stops.length)].lon });
  }

  let assignments = new Int32Array(stops.length);

  for (let iter = 0; iter < maxIter; iter++) {
    // Assign each stop to nearest centroid
    let changed = false;
    for (let i = 0; i < stops.length; i++) {
      let bestC = 0, bestD = Infinity;
      for (let c = 0; c < centroids.length; c++) {
        const d = haversineKm(stops[i].lat, stops[i].lon, centroids[c].lat, centroids[c].lon);
        if (d < bestD) { bestD = d; bestC = c; }
      }
      if (assignments[i] !== bestC) { assignments[i] = bestC; changed = true; }
    }
    if (!changed) break;

    // Recalculate centroids
    for (let c = 0; c < centroids.length; c++) {
      let sumLat = 0, sumLon = 0, cnt = 0;
      for (let i = 0; i < stops.length; i++) {
        if (assignments[i] === c) { sumLat += stops[i].lat; sumLon += stops[i].lon; cnt++; }
      }
      if (cnt > 0) { centroids[c] = { lat: sumLat / cnt, lon: sumLon / cnt }; }
    }
  }

  // Group
  const groups: { centroid: { lat: number; lon: number }; stops: AutoStop[] }[] = centroids.map(c => ({ centroid: c, stops: [] }));
  for (let i = 0; i < stops.length; i++) groups[assignments[i]].stops.push(stops[i]);
  return groups.filter(g => g.stops.length > 0);
}

/**
 * POST /api/fares/zone-clusters/auto-generate
 *
 * Body: { mode?: "concentric" | "spatial", k?: number }
 *
 * mode="concentric" (default): concentric rings from geographic centroid using EXTRA_BANDS
 * mode="spatial": k-means clustering that finds natural stop density groupings
 *   k = number of clusters (default: auto-calculated from geographic spread)
 */
router.post("/fares/zone-clusters/auto-generate", async (req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.status(400).json({ error: "No GTFS feed" }); return; }

    const mode: string = req.body?.mode || "concentric";
    const stops = await fetchExtraStops(feedId);
    if (stops.length === 0) { res.status(400).json({ error: "Nessuna fermata extraurbana trovata" }); return; }

    if (mode === "spatial") {
      // ─── SPATIAL MODE: k-means on geographic coordinates ───
      // Determine k: if user provided, use it; otherwise auto-calculate
      // Heuristic: find geographic bounding box, divide area into ~6km cells
      let k: number = req.body?.k ? Number(req.body.k) : 0;
      if (!k || k < 2) {
        const minLat = Math.min(...stops.map(s => s.lat));
        const maxLat = Math.max(...stops.map(s => s.lat));
        const minLon = Math.min(...stops.map(s => s.lon));
        const maxLon = Math.max(...stops.map(s => s.lon));
        const spanKmLat = haversineKm(minLat, minLon, maxLat, minLon);
        const spanKmLon = haversineKm(minLat, minLon, minLat, maxLon);
        // ~8km grid → k = area / (8*8)
        const area = spanKmLat * spanKmLon;
        k = Math.max(4, Math.min(25, Math.round(area / 64)));
      }
      k = Math.min(k, Math.floor(stops.length / 3)); // at least 3 stops per cluster

      const groups = kMeansSpatial(stops, k);

      // Sort groups by centroid latitude (north to south) for consistent naming
      groups.sort((a, b) => b.centroid.lat - a.centroid.lat);

      // Name clusters by the most central stop (closest to centroid)
      const clusterDefs = groups.map((g, idx) => {
        const centralStop = g.stops.reduce((best, s) => {
          const d = haversineKm(s.lat, s.lon, g.centroid.lat, g.centroid.lon);
          return d < best.d ? { s, d } : best;
        }, { s: g.stops[0], d: Infinity }).s;

        // Clean up name: use the central stop's locality
        const baseName = centralStop.stop_name.replace(/\s*[-–(].*/g, "").trim();
        return {
          clusterId: `area_${idx + 1}`,
          clusterName: `${baseName} (${g.stops.length})`,
          color: AUTO_CLUSTER_COLORS[idx % AUTO_CLUSTER_COLORS.length],
          stops: g.stops,
        };
      });

      const { clustersCreated, totalStopsAssigned } = await persistClusters(feedId, clusterDefs);

      res.json({
        ok: true, mode: "spatial",
        clustersCreated, totalStopsAssigned, totalExtraStops: stops.length, k,
        clusters: clusterDefs.map(d => ({ id: d.clusterId, name: d.clusterName, stops: d.stops.length })),
      });

    } else {
      // ─── CONCENTRIC MODE: rings from geographic centroid ───
      const centerLat = stops.reduce((sum, s) => sum + s.lat, 0) / stops.length;
      const centerLon = stops.reduce((sum, s) => sum + s.lon, 0) / stops.length;

      const stopsWithDist = stops.map(s => ({
        ...s,
        distKm: haversineKm(centerLat, centerLon, s.lat, s.lon),
      }));

      const rings = new Map<number, typeof stopsWithDist>();
      for (const s of stopsWithDist) {
        const band = getBandForDistance(s.distKm);
        const fascia = band ? band.fascia : (s.distKm === 0 ? 1 : EXTRA_BANDS[EXTRA_BANDS.length - 1].fascia);
        if (!rings.has(fascia)) rings.set(fascia, []);
        rings.get(fascia)!.push(s);
      }

      const sortedFasce = Array.from(rings.keys()).sort((a, b) => a - b);

      const clusterDefs = sortedFasce.filter(f => (rings.get(f)?.length || 0) > 0).map((fascia, idx) => {
        const band = EXTRA_BANDS[fascia - 1];
        return {
          clusterId: `zona_${fascia}`,
          clusterName: `Zona ${fascia} (${band.kmFrom}-${band.kmTo} km)`,
          color: AUTO_CLUSTER_COLORS[idx % AUTO_CLUSTER_COLORS.length],
          stops: rings.get(fascia)!,
        };
      });

      const { clustersCreated, totalStopsAssigned } = await persistClusters(feedId, clusterDefs);

      res.json({
        ok: true, mode: "concentric",
        clustersCreated, totalStopsAssigned, totalExtraStops: stops.length,
        center: { lat: centerLat, lon: centerLon },
        rings: sortedFasce.map(f => ({
          fascia: f, kmFrom: EXTRA_BANDS[f - 1].kmFrom, kmTo: EXTRA_BANDS[f - 1].kmTo, stops: rings.get(f)!.length,
        })),
      });
    }
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// GET /api/fares/extraurban-stops — all stops served by extraurban routes (for cluster assignment)
router.get("/fares/extraurban-stops", async (_req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.json([]); return; }
    const rows = await db.execute<any>(sql`
      SELECT DISTINCT s.stop_id, s.stop_name, s.stop_lat::float AS lat, s.stop_lon::float AS lon
      FROM gtfs_stops s
      JOIN gtfs_stop_times st ON st.stop_id = s.stop_id AND st.feed_id = s.feed_id
      JOIN gtfs_trips t ON t.trip_id = st.trip_id AND t.feed_id = s.feed_id
      JOIN gtfs_route_networks rn ON rn.route_id = t.route_id AND rn.feed_id = t.feed_id
      WHERE s.feed_id = ${feedId} AND rn.network_id = 'extraurbano'
      ORDER BY s.stop_name
    `);
    res.json(rows.rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// BUG FIX: Deduplicate stop_areas
// ═══════════════════════════════════════════════════════════
router.post("/fares/stop-areas/deduplicate", async (_req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.status(400).json({ error: "No GTFS feed" }); return; }
    const result = await db.execute<any>(sql`
      DELETE FROM gtfs_stop_areas
      WHERE id NOT IN (
        SELECT DISTINCT ON (feed_id, area_id, stop_id) id
        FROM gtfs_stop_areas
        WHERE feed_id = ${feedId}
        ORDER BY feed_id, area_id, stop_id, created_at ASC
      ) AND feed_id = ${feedId}
    `);
    const deleted = result.rowCount ?? 0;
    const remaining = await db.select({ count: sql<number>`count(*)` }).from(gtfsStopAreas).where(eq(gtfsStopAreas.feedId, feedId));
    res.json({ deleted, remaining: Number(remaining[0]?.count ?? 0) });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// BUG FIX: Set fare_media_id = NULL on existing products
// ═══════════════════════════════════════════════════════════
router.post("/fares/products/fix-media", async (_req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.status(400).json({ error: "No GTFS feed" }); return; }
    const result = await db.execute<any>(sql`
      UPDATE gtfs_fare_products
      SET fare_media_id = NULL
      WHERE feed_id = ${feedId} AND fare_media_id IS NOT NULL
    `);
    res.json({ updated: result.rowCount ?? 0 });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// FEED INFO — CRUD
// ═══════════════════════════════════════════════════════════
router.get("/fares/feed-info", async (_req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.json(null); return; }
    const rows = await db.select().from(gtfsFeedInfo).where(eq(gtfsFeedInfo.feedId, feedId));
    res.json(rows[0] ?? null);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/fares/feed-info", async (req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.status(400).json({ error: "No GTFS feed" }); return; }
    const { feedPublisherName, feedPublisherUrl, feedLang, defaultLang, feedStartDate, feedEndDate, feedVersion, feedContactEmail, feedContactUrl } = req.body;
    // Upsert: delete existing + insert
    await db.delete(gtfsFeedInfo).where(eq(gtfsFeedInfo.feedId, feedId));
    const [row] = await db.insert(gtfsFeedInfo).values({
      feedId,
      feedPublisherName: feedPublisherName || "ATMA Scpa",
      feedPublisherUrl: feedPublisherUrl || "https://www.atmaancona.it",
      feedLang: feedLang || "it",
      defaultLang: defaultLang || null,
      feedStartDate: feedStartDate || null,
      feedEndDate: feedEndDate || null,
      feedVersion: feedVersion || null,
      feedContactEmail: feedContactEmail || null,
      feedContactUrl: feedContactUrl || null,
    }).returning();
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// VALIDATE — pre-export checklist
// ═══════════════════════════════════════════════════════════
router.get("/fares/validate", async (_req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.status(400).json({ error: "No GTFS feed" }); return; }

    const checks: { id: string; label: string; ok: boolean; detail?: string }[] = [];

    // 1. Networks exist
    const networks = await db.select({ count: sql<number>`count(*)` }).from(gtfsFareNetworks).where(eq(gtfsFareNetworks.feedId, feedId));
    const netCount = Number(networks[0]?.count ?? 0);
    checks.push({ id: "networks", label: "Reti tariffarie definite", ok: netCount >= 1, detail: `${netCount} reti` });

    // 2. All routes classified
    const allRoutes = await db.select({ count: sql<number>`count(*)` }).from(gtfsRoutes).where(eq(gtfsRoutes.feedId, feedId));
    const classifiedRoutes = await db.select({ count: sql<number>`count(*)` }).from(gtfsRouteNetworks).where(eq(gtfsRouteNetworks.feedId, feedId));
    const totalR = Number(allRoutes[0]?.count ?? 0);
    const classR = Number(classifiedRoutes[0]?.count ?? 0);
    checks.push({ id: "routes_classified", label: "Linee classificate", ok: classR >= totalR, detail: `${classR}/${totalR}` });

    // 3. Products exist
    const prods = await db.select({ count: sql<number>`count(*)` }).from(gtfsFareProducts).where(eq(gtfsFareProducts.feedId, feedId));
    const prodCount = Number(prods[0]?.count ?? 0);
    checks.push({ id: "products", label: "Prodotti tariffari", ok: prodCount > 0, detail: `${prodCount} prodotti` });

    // 4. No products with fare_media_id set
    const prodsWithMedia = await db.select({ count: sql<number>`count(*)` }).from(gtfsFareProducts)
      .where(and(eq(gtfsFareProducts.feedId, feedId), sql`fare_media_id IS NOT NULL`));
    const mediaCount = Number(prodsWithMedia[0]?.count ?? 0);
    checks.push({ id: "products_media_null", label: "Prodotti senza fare_media_id forzato", ok: mediaCount === 0, detail: mediaCount > 0 ? `${mediaCount} prodotti hanno fare_media_id ≠ NULL` : "OK" });

    // 5. Areas exist
    const areasCount = await db.select({ count: sql<number>`count(*)` }).from(gtfsFareAreas).where(eq(gtfsFareAreas.feedId, feedId));
    const ac = Number(areasCount[0]?.count ?? 0);
    checks.push({ id: "areas", label: "Aree tariffarie", ok: ac > 0, detail: `${ac} aree` });

    // 6. Stop areas — no duplicates
    const saTotal = await db.select({ count: sql<number>`count(*)` }).from(gtfsStopAreas).where(eq(gtfsStopAreas.feedId, feedId));
    const saUnique = await db.execute<any>(sql`
      SELECT count(*) AS cnt FROM (SELECT DISTINCT feed_id, area_id, stop_id FROM gtfs_stop_areas WHERE feed_id = ${feedId}) t
    `);
    const tot = Number(saTotal[0]?.count ?? 0);
    const uniq = Number(saUnique.rows[0]?.cnt ?? 0);
    checks.push({ id: "stop_areas_no_dups", label: "Stop-areas senza duplicati", ok: tot === uniq, detail: tot !== uniq ? `${tot - uniq} duplicati` : `${tot} assegnazioni` });

    // 7. Leg rules exist
    const lrCount = await db.select({ count: sql<number>`count(*)` }).from(gtfsFareLegRules).where(eq(gtfsFareLegRules.feedId, feedId));
    const lrc = Number(lrCount[0]?.count ?? 0);
    checks.push({ id: "leg_rules", label: "Regole di tratta (leg rules)", ok: lrc > 0, detail: `${lrc} regole` });

    // 8. Urban rules have priority > 0
    const urbanP0 = await db.execute<any>(sql`
      SELECT count(*) AS cnt FROM gtfs_fare_leg_rules
      WHERE feed_id = ${feedId} AND network_id IN ('urbano_ancona','urbano_jesi','urbano_falconara') AND rule_priority = 0
    `);
    const up0 = Number(urbanP0.rows[0]?.cnt ?? 0);
    checks.push({ id: "urban_priority", label: "Priorità regole urbane > 0", ok: up0 === 0, detail: up0 > 0 ? `${up0} regole urbane con priority=0` : "OK" });

    // 9. Calendar entries
    const calCount = await db.select({ count: sql<number>`count(*)` }).from(gtfsCalendar).where(eq(gtfsCalendar.feedId, feedId));
    const cc = Number(calCount[0]?.count ?? 0);
    checks.push({ id: "calendar", label: "Calendario servizio", ok: cc > 0, detail: `${cc} entry` });

    // 10. Feed info exists
    const fiCount = await db.select({ count: sql<number>`count(*)` }).from(gtfsFeedInfo).where(eq(gtfsFeedInfo.feedId, feedId));
    const fic = Number(fiCount[0]?.count ?? 0);
    checks.push({ id: "feed_info", label: "Feed info compilato", ok: fic > 0, detail: fic > 0 ? "Presente" : "Mancante" });

    const allOk = checks.every(c => c.ok);
    res.json({ ok: allOk, checks });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// AUDIT LOG HELPER (internal)
// ═══════════════════════════════════════════════════════════
async function logAudit(
  feedId: string | null,
  action: string,
  description: string,
  metadata: Record<string, unknown> = {},
  actor = "system",
): Promise<void> {
  try {
    await db.insert(gtfsFareAuditLog).values({ feedId, action, description, actor, metadata });
  } catch {
    // Non-critical — never throw from audit log
  }
}

// ═══════════════════════════════════════════════════════════
// AUDIT LOG ENDPOINTS
// GET  /api/fares/audit          — lista ultime 200 voci
// POST /api/fares/audit          — aggiungi nota manuale
// ═══════════════════════════════════════════════════════════
router.get("/fares/audit", async (_req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    const rows = feedId
      ? await db.select().from(gtfsFareAuditLog)
          .where(eq(gtfsFareAuditLog.feedId, feedId))
          .orderBy(desc(gtfsFareAuditLog.createdAt))
          .limit(200)
      : [];
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/fares/audit", async (req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.status(400).json({ error: "No GTFS feed" }); return; }
    const { description, actor, metadata } = req.body as { description?: string; actor?: string; metadata?: Record<string, unknown> };
    if (!description?.trim()) { res.status(400).json({ error: "description obbligatoria" }); return; }
    const [row] = await db.insert(gtfsFareAuditLog).values({
      feedId,
      action: "manual_note",
      description: description.trim(),
      actor: actor?.trim() || "utente",
      metadata: metadata ?? {},
    }).returning();
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// KPI TARIFFARIO
// GET /api/fares/kpi
// ═══════════════════════════════════════════════════════════
router.get("/fares/kpi", async (_req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.status(400).json({ error: "No GTFS feed" }); return; }

    // --- Copertura fermate ---
    const [totalStopsRow] = await db.select({ count: sql<number>`count(*)` }).from(gtfsStops).where(eq(gtfsStops.feedId, feedId));
    const totalStops = Number(totalStopsRow?.count ?? 0);

    const coveredResult = await db.execute<{ cnt: string }>(sql`
      SELECT count(DISTINCT stop_id) AS cnt FROM gtfs_stop_areas WHERE feed_id = ${feedId}
    `);
    const coveredStops = Number(coveredResult.rows[0]?.cnt ?? 0);

    // Fermate senza area (anomalie)
    const uncoveredRows = await db.execute<any>(sql`
      SELECT s.stop_id, s.stop_name, s.stop_lat, s.stop_lon
      FROM gtfs_stops s
      WHERE s.feed_id = ${feedId}
        AND s.stop_id NOT IN (SELECT stop_id FROM gtfs_stop_areas WHERE feed_id = ${feedId})
      ORDER BY s.stop_name
      LIMIT 50
    `);
    const uncoveredStops = (uncoveredRows as any).rows ?? [];

    // --- Prodotti per tipo ---
    const productsByType = await db.execute<any>(sql`
      SELECT fare_type, count(*) AS cnt, sum(amount) AS total_amount, min(amount) AS min_price, max(amount) AS max_price
      FROM gtfs_fare_products
      WHERE feed_id = ${feedId}
      GROUP BY fare_type
      ORDER BY fare_type
    `);

    // --- Prodotti per rete ---
    const productsByNetwork = await db.execute<any>(sql`
      SELECT network_id, fare_type, count(*) AS cnt
      FROM gtfs_fare_products
      WHERE feed_id = ${feedId}
      GROUP BY network_id, fare_type
      ORDER BY network_id, fare_type
    `);

    // --- Leg rules per rete ---
    const legRulesByNetwork = await db.execute<any>(sql`
      SELECT network_id, count(*) AS cnt
      FROM gtfs_fare_leg_rules
      WHERE feed_id = ${feedId}
      GROUP BY network_id
      ORDER BY count(*) DESC
    `);

    // --- Aree per rete ---
    const areasByNetwork = await db.execute<any>(sql`
      SELECT network_id, count(*) AS cnt
      FROM gtfs_fare_areas
      WHERE feed_id = ${feedId}
      GROUP BY network_id
      ORDER BY network_id
    `);

    // --- Rotte classificate ---
    const [totalRoutesRow] = await db.select({ count: sql<number>`count(*)` }).from(gtfsRoutes).where(eq(gtfsRoutes.feedId, feedId));
    const totalRoutes = Number(totalRoutesRow?.count ?? 0);
    const [classifiedRow] = await db.select({ count: sql<number>`count(*)` }).from(gtfsRouteNetworks).where(eq(gtfsRouteNetworks.feedId, feedId));
    const classifiedRoutes = Number(classifiedRow?.count ?? 0);

    // --- Distribuzione fasce extraurbane (leg rules) ---
    const fasciaDistribution = await db.execute<any>(sql`
      SELECT flr.fare_product_id, fp.amount, fp.fare_product_name, count(*) AS od_pairs
      FROM gtfs_fare_leg_rules flr
      JOIN gtfs_fare_products fp ON fp.fare_product_id = flr.fare_product_id AND fp.feed_id = ${feedId}
      WHERE flr.feed_id = ${feedId} AND flr.network_id = 'extraurbano'
      GROUP BY flr.fare_product_id, fp.amount, fp.fare_product_name
      ORDER BY fp.amount
    `);

    // --- Media prezzo per rete ---
    const avgPriceByNetwork = await db.execute<any>(sql`
      SELECT network_id, round(avg(amount)::numeric, 4) AS avg_price, count(*) AS products
      FROM gtfs_fare_products
      WHERE feed_id = ${feedId}
      GROUP BY network_id
      ORDER BY network_id
    `);

    // --- Ultimi eventi audit ---
    const recentAudit = await db.select().from(gtfsFareAuditLog)
      .where(eq(gtfsFareAuditLog.feedId, feedId))
      .orderBy(desc(gtfsFareAuditLog.createdAt))
      .limit(5);

    res.json({
      coverage: {
        totalStops,
        coveredStops,
        coveragePercent: totalStops > 0 ? Math.round((coveredStops / totalStops) * 10000) / 100 : 0,
        uncoveredCount: totalStops - coveredStops,
        uncoveredStops,
      },
      routes: {
        total: totalRoutes,
        classified: classifiedRoutes,
        classifiedPercent: totalRoutes > 0 ? Math.round((classifiedRoutes / totalRoutes) * 10000) / 100 : 0,
      },
      productsByType: (productsByType as any).rows ?? [],
      productsByNetwork: (productsByNetwork as any).rows ?? [],
      legRulesByNetwork: (legRulesByNetwork as any).rows ?? [],
      areasByNetwork: (areasByNetwork as any).rows ?? [],
      avgPriceByNetwork: (avgPriceByNetwork as any).rows ?? [],
      fasciaDistribution: (fasciaDistribution as any).rows ?? [],
      recentAudit,
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// EXPORT ZIP
// GET /api/fares/export-fares-zip — scarica tutte le CSV GTFS Fares V2 in un unico .zip
// (endpoint separato da /export-zip che genera il feed GTFS completo)
router.get("/fares/export-fares-zip", async (_req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.status(400).json({ error: "No GTFS feed" }); return; }

    // Recupera i dati (stessa logica di /fares/generate-gtfs)
    const networks = await db.select().from(gtfsFareNetworks).where(eq(gtfsFareNetworks.feedId, feedId));
    const routeNets = await db.select().from(gtfsRouteNetworks).where(eq(gtfsRouteNetworks.feedId, feedId));
    const media = await db.select().from(gtfsFareMedia).where(and(eq(gtfsFareMedia.feedId, feedId), eq(gtfsFareMedia.isActive, true)));
    const cats = await db.select().from(gtfsRiderCategories).where(eq(gtfsRiderCategories.feedId, feedId));
    const products = await db.select().from(gtfsFareProducts).where(eq(gtfsFareProducts.feedId, feedId));
    const areas = await db.select().from(gtfsFareAreas).where(eq(gtfsFareAreas.feedId, feedId));
    const stopAreas = await db.select().from(gtfsStopAreas).where(eq(gtfsStopAreas.feedId, feedId));
    const legRules = await db.select().from(gtfsFareLegRules).where(eq(gtfsFareLegRules.feedId, feedId));
    const xferRules = await db.select().from(gtfsFareTransferRules).where(eq(gtfsFareTransferRules.feedId, feedId));
    const timeframes = await db.select().from(gtfsTimeframes).where(eq(gtfsTimeframes.feedId, feedId));
    const feedInfoRows = await db.select().from(gtfsFeedInfo).where(eq(gtfsFeedInfo.feedId, feedId));

    // Costruisci CSV
    let networksCsv = "network_id,network_name\n";
    for (const n of networks) networksCsv += `${n.networkId},"${n.networkName}"\n`;

    let routeNetCsv = "network_id,route_id\n";
    for (const rn of routeNets) routeNetCsv += `${rn.networkId},${rn.routeId}\n`;

    let mediaCsv = "fare_media_id,fare_media_name,fare_media_type\n";
    for (const m of media) mediaCsv += `${m.fareMediaId},"${m.fareMediaName}",${m.fareMediaType}\n`;

    let catCsv = "rider_category_id,rider_category_name,is_default_fare_category,eligibility_url\n";
    for (const c of cats) catCsv += `${c.riderCategoryId},"${c.riderCategoryName}",${c.isDefault ? 1 : 0},${c.eligibilityUrl || ""}\n`;

    let prodCsv = "fare_product_id,fare_product_name,rider_category_id,fare_media_id,amount,currency\n";
    for (const p of products) prodCsv += `${p.fareProductId},"${p.fareProductName}",${p.riderCategoryId || ""},${p.fareMediaId || ""},${p.amount.toFixed(2)},${p.currency}\n`;

    let areasCsv = "area_id,area_name\n";
    for (const a of areas) areasCsv += `${a.areaId},"${a.areaName}"\n`;

    let stopAreasCsv = "area_id,stop_id\n";
    for (const sa of stopAreas) stopAreasCsv += `${sa.areaId},${sa.stopId}\n`;

    let legCsv = "leg_group_id,network_id,from_area_id,to_area_id,from_timeframe_group_id,to_timeframe_group_id,fare_product_id,rule_priority\n";
    for (const lr of legRules) legCsv += `${lr.legGroupId},${lr.networkId || ""},${lr.fromAreaId || ""},${lr.toAreaId || ""},${lr.fromTimeframeGroupId || ""},${lr.toTimeframeGroupId || ""},${lr.fareProductId},${lr.rulePriority}\n`;

    let xferCsv = "from_leg_group_id,to_leg_group_id,transfer_count,duration_limit,duration_limit_type,fare_transfer_type,fare_product_id\n";
    for (const xr of xferRules) xferCsv += `${xr.fromLegGroupId || ""},${xr.toLegGroupId || ""},${xr.transferCount ?? ""},${xr.durationLimit ?? ""},${xr.durationLimitType ?? ""},${xr.fareTransferType ?? ""},${xr.fareProductId || ""}\n`;

    let tfCsv = "timeframe_group_id,start_time,end_time,service_id\n";
    for (const tf of timeframes) tfCsv += `${tf.timeframeGroupId},${tf.startTime || ""},${tf.endTime || ""},${tf.serviceId || ""}\n`;

    // Pacchettizza in ZIP
    const zip = new AdmZip();
    const maybeAdd = (name: string, csv: string) => {
      const lines = csv.split("\n").filter(Boolean);
      if (lines.length > 1) zip.addFile(name, Buffer.from(csv, "utf-8"));
    };
    maybeAdd("networks.txt", networksCsv);
    maybeAdd("route_networks.txt", routeNetCsv);
    maybeAdd("fare_media.txt", mediaCsv);
    maybeAdd("rider_categories.txt", catCsv);
    maybeAdd("fare_products.txt", prodCsv);
    maybeAdd("areas.txt", areasCsv);
    maybeAdd("stop_areas.txt", stopAreasCsv);
    maybeAdd("fare_leg_rules.txt", legCsv);
    if (xferRules.length > 0) maybeAdd("fare_transfer_rules.txt", xferCsv);
    if (timeframes.length > 0) maybeAdd("timeframes.txt", tfCsv);

    if (feedInfoRows.length > 0) {
      const fi = feedInfoRows[0];
      let fiCsv = "feed_publisher_name,feed_publisher_url,feed_lang,default_lang,feed_start_date,feed_end_date,feed_version,feed_contact_email,feed_contact_url\n";
      fiCsv += `"${fi.feedPublisherName}",${fi.feedPublisherUrl},${fi.feedLang},${fi.defaultLang || ""},${fi.feedStartDate || ""},${fi.feedEndDate || ""},${fi.feedVersion || ""},${fi.feedContactEmail || ""},${fi.feedContactUrl || ""}\n`;
      zip.addFile("feed_info.txt", Buffer.from(fiCsv, "utf-8"));
    }

    // README con istruzioni
    const readmeTxt = `GTFS Fares V2 — Esportazione del ${new Date().toISOString()}
Generato da TransitIntel

File inclusi:
- networks.txt           Reti tariffarie
- route_networks.txt     Associazione linea → rete
- fare_media.txt         Supporti di pagamento
- rider_categories.txt   Categorie passeggeri
- fare_products.txt      Prodotti tariffari (biglietti, abbonamenti)
- areas.txt              Aree tariffarie
- stop_areas.txt         Assegnazione fermate → aree
- fare_leg_rules.txt     Regole di tratta (matrice tariffaria)
- fare_transfer_rules.txt Regole trasbordo (se presenti)
- timeframes.txt         Fasce orarie (se presenti)
- feed_info.txt          Metadati feed (se presenti)

Compatibile con GTFS Fares V2 spec (MobilityData).
`;
    zip.addFile("README.txt", Buffer.from(readmeTxt, "utf-8"));

    const zipBuffer = zip.toBuffer();
    const filename = `gtfs_fares_v2_${new Date().toISOString().slice(0, 10)}.zip`;

    // Log audit
    await logAudit(feedId, "export_zip", `Export ZIP GTFS Fares V2 (${zip.getEntries().length} file, ${products.length} prodotti, ${legRules.length} leg rules)`);

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Length", zipBuffer.length);
    res.send(zipBuffer);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// SIMULATOR SUPPORT ENDPOINTS
// ═══════════════════════════════════════════════════════════

// GET /api/fares/simulator/routes — lista linee con rete
router.get("/fares/simulator/routes", async (_req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.status(400).json({ error: "No GTFS feed" }); return; }
    const rows = await db.execute<any>(sql`
      SELECT r.route_id, r.route_short_name, r.route_long_name, r.route_color,
             rn.network_id
      FROM gtfs_routes r
      LEFT JOIN gtfs_route_networks rn ON rn.route_id = r.route_id AND rn.feed_id = r.feed_id
      WHERE r.feed_id = ${feedId}
      ORDER BY r.route_short_name
    `);
    res.json(rows.rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// GET /api/fares/simulator/dates — date servite (con conteggio trip totale)
router.get("/fares/simulator/dates", async (_req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.status(400).json({ error: "No GTFS feed" }); return; }
    // Estrae per ogni service_id l'intervallo + esclusioni/aggiunte di calendar_dates,
    // poi enumera le date e conta i trip totali per data.
    const rows = await db.execute<any>(sql`
      WITH service_days AS (
        -- Espansione calendar (start→end + bitmap giorni)
        SELECT c.service_id, d::date AS service_date
        FROM gtfs_calendar c
        CROSS JOIN LATERAL generate_series(
          to_date(c.start_date, 'YYYYMMDD'),
          to_date(c.end_date, 'YYYYMMDD'),
          '1 day'::interval
        ) d
        WHERE c.feed_id = ${feedId}
          AND (
            (extract(dow from d) = 1 AND c.monday = 1) OR
            (extract(dow from d) = 2 AND c.tuesday = 1) OR
            (extract(dow from d) = 3 AND c.wednesday = 1) OR
            (extract(dow from d) = 4 AND c.thursday = 1) OR
            (extract(dow from d) = 5 AND c.friday = 1) OR
            (extract(dow from d) = 6 AND c.saturday = 1) OR
            (extract(dow from d) = 0 AND c.sunday = 1)
          )
      ),
      with_dates AS (
        SELECT service_id, service_date FROM service_days
        UNION
        SELECT service_id, to_date(date, 'YYYYMMDD') AS service_date
        FROM gtfs_calendar_dates
        WHERE feed_id = ${feedId} AND exception_type = 1
      ),
      filtered AS (
        SELECT service_id, service_date FROM with_dates
        WHERE NOT EXISTS (
          SELECT 1 FROM gtfs_calendar_dates cd
          WHERE cd.feed_id = ${feedId}
            AND cd.service_id = with_dates.service_id
            AND cd.exception_type = 2
            AND to_date(cd.date, 'YYYYMMDD') = with_dates.service_date
        )
      )
      SELECT to_char(f.service_date, 'YYYYMMDD') AS date,
             COUNT(DISTINCT t.trip_id) AS trip_count
      FROM filtered f
      JOIN gtfs_trips t ON t.feed_id = ${feedId} AND t.service_id = f.service_id
      GROUP BY f.service_date
      ORDER BY f.service_date
    `);
    res.json(rows.rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// GET /api/fares/simulator/trips?routeId=X[&date=YYYYMMDD] — trips con orari per una linea
//   Se date è fornito, filtra i trip ai soli service_id attivi in quella data.
router.get("/fares/simulator/trips", async (req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.status(400).json({ error: "No GTFS feed" }); return; }
    const { routeId, date } = req.query as { routeId: string; date?: string };
    if (!routeId) { res.status(400).json({ error: "routeId required" }); return; }

    // Calcolo i service_id attivi in `date` (se fornito)
    const dateFilter = date && /^\d{8}$/.test(date)
      ? sql`
          AND t.service_id IN (
            -- Servizi base attivi quel giorno della settimana nell'intervallo
            SELECT c.service_id FROM gtfs_calendar c
            WHERE c.feed_id = ${feedId}
              AND to_date(${date}, 'YYYYMMDD') BETWEEN to_date(c.start_date, 'YYYYMMDD') AND to_date(c.end_date, 'YYYYMMDD')
              AND (
                (extract(dow from to_date(${date}, 'YYYYMMDD')) = 1 AND c.monday = 1) OR
                (extract(dow from to_date(${date}, 'YYYYMMDD')) = 2 AND c.tuesday = 1) OR
                (extract(dow from to_date(${date}, 'YYYYMMDD')) = 3 AND c.wednesday = 1) OR
                (extract(dow from to_date(${date}, 'YYYYMMDD')) = 4 AND c.thursday = 1) OR
                (extract(dow from to_date(${date}, 'YYYYMMDD')) = 5 AND c.friday = 1) OR
                (extract(dow from to_date(${date}, 'YYYYMMDD')) = 6 AND c.saturday = 1) OR
                (extract(dow from to_date(${date}, 'YYYYMMDD')) = 0 AND c.sunday = 1)
              )
              -- Esclude servizi con calendar_dates exception_type=2 (rimosso quel giorno)
              AND NOT EXISTS (
                SELECT 1 FROM gtfs_calendar_dates cd
                WHERE cd.feed_id = ${feedId} AND cd.service_id = c.service_id
                  AND cd.date = ${date} AND cd.exception_type = 2
              )
            UNION
            -- Aggiunte: calendar_dates exception_type=1
            SELECT cd.service_id FROM gtfs_calendar_dates cd
            WHERE cd.feed_id = ${feedId} AND cd.date = ${date} AND cd.exception_type = 1
          )
        `
      : sql``;

    const rows = await db.execute<any>(sql`
      SELECT t.trip_id, t.trip_headsign, t.direction_id, t.shape_id, t.service_id,
             MIN(st.departure_time) AS departure_time,
             COUNT(st.stop_id) AS stop_count
      FROM gtfs_trips t
      JOIN gtfs_stop_times st ON st.trip_id = t.trip_id AND st.feed_id = t.feed_id
      WHERE t.feed_id = ${feedId} AND t.route_id = ${routeId}
      ${dateFilter}
      GROUP BY t.trip_id, t.trip_headsign, t.direction_id, t.shape_id, t.service_id
      ORDER BY departure_time
      LIMIT 200
    `);
    res.json(rows.rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// GET /api/fares/simulator/trip-stops?tripId=X — fermate ordinate di un trip
router.get("/fares/simulator/trip-stops", async (req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.status(400).json({ error: "No GTFS feed" }); return; }
    const { tripId } = req.query as { tripId: string };
    if (!tripId) { res.status(400).json({ error: "tripId required" }); return; }

    const rows = await db.execute<any>(sql`
      SELECT st.stop_sequence, st.arrival_time, st.departure_time,
             s.stop_id, s.stop_name, s.stop_lat::float AS lat, s.stop_lon::float AS lon
      FROM gtfs_stop_times st
      JOIN gtfs_stops s ON s.stop_id = st.stop_id AND s.feed_id = st.feed_id
      WHERE st.feed_id = ${feedId} AND st.trip_id = ${tripId}
      ORDER BY st.stop_sequence
    `);
    res.json(rows.rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ──────────────────────────────────────────────────────────────────────
// POST /api/fares/journey-plan
//   Body: { from:{lat,lon}, to:{lat,lon}, date:'YYYYMMDD', time:'HH:MM',
//           maxWalkM?:number=900, maxAlternatives?:number=6 }
//   v1: trip diretti (no transfers). Distingue rete urbana (flat fare)
//   da extraurbana (fasce DGR). Restituisce shape (geojson) per ogni alt.
// ──────────────────────────────────────────────────────────────────────

// Mappa network → biglietto urbano singola corsa di riferimento
const URBAN_FLAT_FARE: Record<string, { id: string; name: string; price: number; durationMin: number }> = {
  urbano_ancona:        { id: "ancona_60min",     name: "Biglietto Urbano Ancona 60 min",     price: 1.35, durationMin: 60 },
  urbano_jesi:          { id: "jesi_60min",       name: "Biglietto Urbano Jesi 60 min",       price: 1.35, durationMin: 60 },
  urbano_falconara:     { id: "falconara_60min",  name: "Biglietto Urbano Falconara 60 min",  price: 1.35, durationMin: 60 },
  urbano_senigallia:    { id: "senigallia_60min", name: "Biglietto Urbano Senigallia 60 min", price: 1.35, durationMin: 60 },
  urbano_castelfidardo: { id: "castelfidardo_60min", name: "Biglietto Urbano Castelfidardo 60 min", price: 1.35, durationMin: 60 },
};

router.post("/fares/journey-plan", async (req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.status(400).json({ error: "No GTFS feed" }); return; }

    const { from, to, date, time = "00:00", maxWalkM = 900, maxAlternatives = 6, allowTransfers = true } = req.body ?? {};
    if (!from?.lat || !from?.lon || !to?.lat || !to?.lon) {
      res.status(400).json({ error: "from{lat,lon} + to{lat,lon} required" }); return;
    }
    if (!date || !/^\d{8}$/.test(date)) { res.status(400).json({ error: "date YYYYMMDD required" }); return; }

    const timeHHMMSS = /^\d{2}:\d{2}$/.test(time) ? `${time}:00` : time;
    const walkSpeedKmh = 4.8;
    const radiusKm = maxWalkM / 1000;
    const NEAR_K = 12;
    const MIN_TRANSFER_MIN = 2;   // attese hub molto strette ammesse (era 4)
    const MAX_TRANSFER_MIN = 90;  // extraurbano: corse rare, attese lunghe ammesse (era 30)

    const toMinHMS = (t: string) => {
      if (!t) return 0;
      const [hh, mm, ss] = t.split(":").map(Number);
      return hh * 60 + mm + (ss ?? 0) / 60;
    };
    const normColor = (c: any, fb: string) =>
      c ? (String(c).startsWith("#") ? String(c) : `#${c}`) : fb;

    // ── 1) fermate vicine a origine/destinazione ──
    const queryNear = (lat: number, lon: number) => sql`
      SELECT stop_id, stop_name, stop_lat::float AS lat, stop_lon::float AS lon,
             (6371 * acos(GREATEST(-1, LEAST(1,
               cos(radians(${lat})) * cos(radians(stop_lat::float))
               * cos(radians(stop_lon::float) - radians(${lon}))
               + sin(radians(${lat})) * sin(radians(stop_lat::float))
             )))) AS dist_km
      FROM gtfs_stops
      WHERE feed_id = ${feedId}
      ORDER BY dist_km ASC
      LIMIT ${NEAR_K}
    `;
    const [nearO, nearD] = await Promise.all([
      db.execute<any>(queryNear(from.lat, from.lon)),
      db.execute<any>(queryNear(to.lat,   to.lon)),
    ]);
    // Se ci sono fermate entro raggio, usale; altrimenti prendi le più vicine (max 5km).
    // In questo modo il planner risponde sempre, anche se l'utente clicca lontano da una fermata
    // (es. zone rurali). La camminata estesa sarà visibile nei legs.
    const FALLBACK_MAX_KM = 5;
    const FALLBACK_K = 5;
    const pickStops = (rows: any[]): any[] => {
      const within = rows.filter(s => s.dist_km <= radiusKm);
      if (within.length > 0) return within;
      return rows.filter(s => s.dist_km <= FALLBACK_MAX_KM).slice(0, FALLBACK_K);
    };
    const oStops = pickStops(nearO.rows as any[]);
    const dStops = pickStops(nearD.rows as any[]);
    const extendedWalk =
      (oStops.length > 0 && oStops[0].dist_km > radiusKm) ||
      (dStops.length > 0 && dStops[0].dist_km > radiusKm);
    if (oStops.length === 0 || dStops.length === 0) {
      res.json({
        alternatives: [],
        reason: `Nessuna fermata bus entro ${FALLBACK_MAX_KM} km da origine o destinazione. Spostati verso una zona servita dal TPL.`,
      });
      return;
    }
    const oIds = oStops.map(s => s.stop_id);
    const dIds = dStops.map(s => s.stop_id);
    const oMap = new Map(oStops.map(s => [s.stop_id, s]));
    const dMap = new Map(dStops.map(s => [s.stop_id, s]));

    // ── 2) CTE servizi attivi (riusato) ──
    const activeServicesCTE = sql`
      WITH active_services AS (
        SELECT c.service_id FROM gtfs_calendar c
        WHERE c.feed_id = ${feedId}
          AND to_date(${date}, 'YYYYMMDD') BETWEEN to_date(c.start_date, 'YYYYMMDD') AND to_date(c.end_date, 'YYYYMMDD')
          AND (
            (extract(dow from to_date(${date}, 'YYYYMMDD')) = 1 AND c.monday = 1) OR
            (extract(dow from to_date(${date}, 'YYYYMMDD')) = 2 AND c.tuesday = 1) OR
            (extract(dow from to_date(${date}, 'YYYYMMDD')) = 3 AND c.wednesday = 1) OR
            (extract(dow from to_date(${date}, 'YYYYMMDD')) = 4 AND c.thursday = 1) OR
            (extract(dow from to_date(${date}, 'YYYYMMDD')) = 5 AND c.friday = 1) OR
            (extract(dow from to_date(${date}, 'YYYYMMDD')) = 6 AND c.saturday = 1) OR
            (extract(dow from to_date(${date}, 'YYYYMMDD')) = 0 AND c.sunday = 1)
          )
          AND NOT EXISTS (
            SELECT 1 FROM gtfs_calendar_dates cd
            WHERE cd.feed_id = ${feedId} AND cd.service_id = c.service_id
              AND cd.date = ${date} AND cd.exception_type = 2
          )
        UNION
        SELECT cd.service_id FROM gtfs_calendar_dates cd
        WHERE cd.feed_id = ${feedId} AND cd.date = ${date} AND cd.exception_type = 1
      )
    `;

    // ── 3) Trip diretti O→D ──
    const directTrips = await db.execute<any>(sql`
      ${activeServicesCTE},
      o_visits AS (
        SELECT st.trip_id, st.stop_id AS o_stop_id, st.stop_sequence AS o_seq, st.departure_time AS o_dep
        FROM gtfs_stop_times st
        WHERE st.feed_id = ${feedId}
          AND st.stop_id IN (${sql.join(oIds.map(id => sql`${id}`), sql`, `)})
          AND st.departure_time >= ${timeHHMMSS}
      ),
      d_visits AS (
        SELECT st.trip_id, st.stop_id AS d_stop_id, st.stop_sequence AS d_seq, st.arrival_time AS d_arr
        FROM gtfs_stop_times st
        WHERE st.feed_id = ${feedId}
          AND st.stop_id IN (${sql.join(dIds.map(id => sql`${id}`), sql`, `)})
      )
      SELECT t.trip_id, t.route_id, t.trip_headsign, t.direction_id, t.shape_id,
             r.route_short_name, r.route_long_name, r.route_color, r.route_text_color,
             o.o_stop_id, o.o_seq, o.o_dep,
             d.d_stop_id, d.d_seq, d.d_arr
      FROM gtfs_trips t
      JOIN active_services s ON s.service_id = t.service_id
      JOIN o_visits o ON o.trip_id = t.trip_id
      JOIN d_visits d ON d.trip_id = t.trip_id AND d.d_seq > o.o_seq
      JOIN gtfs_routes r ON r.route_id = t.route_id AND r.feed_id = t.feed_id
      WHERE t.feed_id = ${feedId}
      ORDER BY o.o_dep ASC
      LIMIT 60
    `);

    // ── helper: build leg info (distance, segStops, segmentShape) ──
    const shapeCache = new Map<string, [number, number][]>();
    async function loadShapes(shapeIds: string[]) {
      const missing = shapeIds.filter(id => id && !shapeCache.has(id));
      if (missing.length === 0) return;
      const rows = await db.execute<any>(sql`
        SELECT shape_id, geojson FROM gtfs_shapes
        WHERE feed_id = ${feedId} AND shape_id IN (${sql.join(missing.map(id => sql`${id}`), sql`, `)})
      `);
      for (const sr of rows.rows as any[]) {
        const geo = sr.geojson;
        const coords: [number, number][] | null =
          geo?.geometry?.coordinates ?? geo?.coordinates ??
          (geo?.type === "LineString" ? geo.coordinates : null);
        if (coords && Array.isArray(coords)) shapeCache.set(sr.shape_id, coords);
      }
    }
    async function buildBusLeg(tripId: string, oSeq: number, dSeq: number, shapeId: string | null) {
      const stopsBetween = await db.execute<any>(sql`
        SELECT st.stop_sequence, s.stop_lat::float AS lat, s.stop_lon::float AS lon
        FROM gtfs_stop_times st
        JOIN gtfs_stops s ON s.stop_id = st.stop_id AND s.feed_id = st.feed_id
        WHERE st.feed_id = ${feedId} AND st.trip_id = ${tripId}
          AND st.stop_sequence BETWEEN ${oSeq} AND ${dSeq}
        ORDER BY st.stop_sequence
      `);
      const segStops = stopsBetween.rows as any[];
      let distKm = 0;
      for (let i = 1; i < segStops.length; i++) {
        distKm += haversineKm(segStops[i - 1].lat, segStops[i - 1].lon, segStops[i].lat, segStops[i].lon);
      }
      distKm = Math.round(distKm * 100) / 100;

      let segmentShape: [number, number][] = segStops.map(s => [s.lon, s.lat]);
      const fullShape = shapeId ? shapeCache.get(shapeId) : null;
      if (fullShape && fullShape.length >= 2 && segStops.length >= 2) {
        const first = segStops[0];
        const last  = segStops[segStops.length - 1];
        let iStart = 0, iEnd = fullShape.length - 1;
        let dStart = Infinity, dEnd = Infinity;
        for (let i = 0; i < fullShape.length; i++) {
          const [lon, lat] = fullShape[i];
          const ds = haversineKm(first.lat, first.lon, lat, lon);
          const de = haversineKm(last.lat,  last.lon,  lat, lon);
          if (ds < dStart) { dStart = ds; iStart = i; }
          if (de < dEnd)   { dEnd = de;   iEnd = i; }
        }
        const [a, b] = iStart <= iEnd ? [iStart, iEnd] : [iEnd, iStart];
        segmentShape = fullShape.slice(a, b + 1);
      }
      return { segStops, distKm, segmentShape };
    }

    function makeBusLegObject(r: any, oStop: any, dStop: any, segStops: any[], distKm: number, segmentShape: [number, number][]) {
      const network = classifyRoute(r.route_short_name);
      const isUrban = network !== "extraurbano";
      let amount: number, fareName: string, fareId: string, fascia: number | null = null, bandRange: string | null = null;
      if (isUrban) {
        const flat = URBAN_FLAT_FARE[network] ?? URBAN_FLAT_FARE.urbano_ancona;
        amount = flat.price; fareName = flat.name; fareId = flat.id;
      } else {
        const band = getBandForDistance(distKm) ?? EXTRA_BANDS[0];
        amount = band.price;
        fareName = `Biglietto Extraurbano · fascia ${band.fascia}`;
        fareId = `extra_fascia_${band.fascia}`;
        fascia = band.fascia;
        bandRange = `${band.kmFrom}–${band.kmTo} km`;
      }
      const busMin = Math.max(1, Math.round(toMinHMS(r.d_arr) - toMinHMS(r.o_dep)));
      return {
        kind: "bus" as const,
        tripId: r.trip_id,
        routeId: r.route_id,
        routeShortName: r.route_short_name ?? r.route_id,
        routeLongName: r.route_long_name ?? "",
        routeColor: normColor(r.route_color, isUrban ? "#2563eb" : "#10b981"),
        routeTextColor: normColor(r.route_text_color, "#ffffff"),
        headsign: r.trip_headsign ?? "",
        directionId: r.direction_id,
        shapeId: r.shape_id,
        network, networkLabel: isUrban ? "Urbano" : "Extraurbano",
        fromStop: { stopId: oStop.stop_id, name: oStop.stop_name, lat: oStop.lat, lon: oStop.lon },
        toStop:   { stopId: dStop.stop_id, name: dStop.stop_name, lat: dStop.lat, lon: dStop.lon },
        oSeq: r.o_seq, dSeq: r.d_seq,
        depTime: r.o_dep, arrTime: r.d_arr,
        busMin, numStops: segStops.length - 1,
        distanceKm: distKm,
        amount, currency: "EUR", fareId, fareName, fascia, bandRange,
        segmentShape,
      };
    }

    // ── 4) Costruisci alternative DIRETTE ──
    type Alternative = {
      kind: "direct" | "transfer";
      legs: any[];
      totalMin: number; totalWalkM: number; totalAmount: number;
      depTime: string; arrTime: string;
      badges?: string[];
    };
    const directRows = directTrips.rows as any[];
    const seenDirect = new Set<string>();
    const directCandidates: any[] = [];
    for (const r of directRows) {
      const key = `${r.route_id}|${r.o_stop_id}|${r.d_stop_id}|${r.direction_id}`;
      if (seenDirect.has(key)) continue;
      seenDirect.add(key);
      directCandidates.push(r);
      if (directCandidates.length >= maxAlternatives) break;
    }
    await loadShapes(directCandidates.map(r => r.shape_id).filter(Boolean));

    const alternatives: Alternative[] = [];
    for (const r of directCandidates) {
      const oS = oMap.get(r.o_stop_id); const dS = dMap.get(r.d_stop_id);
      if (!oS || !dS) continue;
      const { segStops, distKm, segmentShape } = await buildBusLeg(r.trip_id, r.o_seq, r.d_seq, r.shape_id);
      const busLeg = makeBusLegObject(r, oS, dS, segStops, distKm, segmentShape);

      const walkFromKm = haversineKm(from.lat, from.lon, oS.lat, oS.lon);
      const walkToKm   = haversineKm(dS.lat, dS.lon, to.lat, to.lon);
      const walkFromMin = Math.max(1, Math.round(walkFromKm / walkSpeedKmh * 60));
      const walkToMin   = Math.max(1, Math.round(walkToKm   / walkSpeedKmh * 60));
      const walkFromM = Math.round(walkFromKm * 1000);
      const walkToM   = Math.round(walkToKm * 1000);

      const legs = [
        { kind: "walk" as const, fromName: "Origine", toName: oS.stop_name, distanceM: walkFromM, durationMin: walkFromMin, fromLat: from.lat, fromLon: from.lon, toLat: oS.lat, toLon: oS.lon },
        busLeg,
        { kind: "walk" as const, fromName: dS.stop_name, toName: "Destinazione", distanceM: walkToM, durationMin: walkToMin, fromLat: dS.lat, fromLon: dS.lon, toLat: to.lat, toLon: to.lon },
      ];
      const totalMin = walkFromMin + busLeg.busMin + walkToMin;
      alternatives.push({
        kind: "direct", legs,
        totalMin,
        totalWalkM: walkFromM + walkToM,
        totalAmount: busLeg.amount,
        depTime: busLeg.depTime, arrTime: busLeg.arrTime,
      });
    }

    // ── 5) Trip con TRANSFER (1 cambio) — solo se richiesto ──
    if (allowTransfers) {
      // Limita: cerco hub stops raggiunti dai trip che partono vicino origine
      // (entro 90 min di viaggio), con seguente trip che termina vicino destinazione.
      const transfers = await db.execute<any>(sql`
        ${activeServicesCTE},
        o_visits AS (
          SELECT st.trip_id, st.stop_id AS o_stop_id, st.stop_sequence AS o_seq, st.departure_time AS o_dep
          FROM gtfs_stop_times st
          WHERE st.feed_id = ${feedId}
            AND st.stop_id IN (${sql.join(oIds.map(id => sql`${id}`), sql`, `)})
            AND st.departure_time >= ${timeHHMMSS}
        ),
        d_visits AS (
          SELECT st.trip_id, st.stop_id AS d_stop_id, st.stop_sequence AS d_seq, st.arrival_time AS d_arr
          FROM gtfs_stop_times st
          WHERE st.feed_id = ${feedId}
            AND st.stop_id IN (${sql.join(dIds.map(id => sql`${id}`), sql`, `)})
        ),
        leg1 AS (
          -- bus 1: parte da O, arriva a hub stop X (dopo o_seq)
          SELECT t1.trip_id AS t1_id, t1.route_id AS r1_id, t1.shape_id AS s1, t1.trip_headsign AS h1, t1.direction_id AS d1,
                 r1.route_short_name AS r1_sn, r1.route_long_name AS r1_ln, r1.route_color AS r1_c, r1.route_text_color AS r1_tc,
                 ov.o_stop_id, ov.o_seq, ov.o_dep,
                 st1.stop_id AS hub_stop_id, st1.stop_sequence AS hub_seq_arr, st1.arrival_time AS hub_arr
          FROM gtfs_trips t1
          JOIN active_services s ON s.service_id = t1.service_id
          JOIN o_visits ov ON ov.trip_id = t1.trip_id
          JOIN gtfs_stop_times st1 ON st1.feed_id = t1.feed_id AND st1.trip_id = t1.trip_id AND st1.stop_sequence > ov.o_seq
          JOIN gtfs_routes r1 ON r1.route_id = t1.route_id AND r1.feed_id = t1.feed_id
          WHERE t1.feed_id = ${feedId}
            AND st1.stop_id NOT IN (${sql.join(dIds.map(id => sql`${id}`), sql`, `)})
        ),
        leg2 AS (
          -- bus 2: parte da hub Y, arriva a D
          SELECT t2.trip_id AS t2_id, t2.route_id AS r2_id, t2.shape_id AS s2, t2.trip_headsign AS h2, t2.direction_id AS d2_dir,
                 r2.route_short_name AS r2_sn, r2.route_long_name AS r2_ln, r2.route_color AS r2_c, r2.route_text_color AS r2_tc,
                 st2.stop_id AS hub_stop_id, st2.stop_sequence AS hub_seq_dep, st2.departure_time AS hub_dep,
                 dv.d_stop_id, dv.d_seq, dv.d_arr
          FROM gtfs_trips t2
          JOIN active_services s ON s.service_id = t2.service_id
          JOIN d_visits dv ON dv.trip_id = t2.trip_id
          JOIN gtfs_stop_times st2 ON st2.feed_id = t2.feed_id AND st2.trip_id = t2.trip_id AND st2.stop_sequence < dv.d_seq
          JOIN gtfs_routes r2 ON r2.route_id = t2.route_id AND r2.feed_id = t2.feed_id
          WHERE t2.feed_id = ${feedId}
        )
        SELECT *
        FROM leg1
        JOIN leg2 USING (hub_stop_id)
        WHERE leg1.t1_id <> leg2.t2_id
          AND leg1.r1_id <> leg2.r2_id   -- escludi stessa linea (no senso cambiare)
          AND (
            EXTRACT(EPOCH FROM (leg2.hub_dep::interval - leg1.hub_arr::interval)) / 60.0 BETWEEN ${MIN_TRANSFER_MIN} AND ${MAX_TRANSFER_MIN}
          )
        ORDER BY leg1.o_dep ASC,
                 (EXTRACT(EPOCH FROM (leg2.hub_dep::interval - leg1.hub_arr::interval)) / 60.0) ASC
        LIMIT 40
      `);

      // Dedup su (r1, hub, r2, o_stop, d_stop)
      const seenT = new Set<string>();
      const transferCandidates: any[] = [];
      for (const r of transfers.rows as any[]) {
        const k = `${r.r1_id}|${r.hub_stop_id}|${r.r2_id}|${r.o_stop_id}|${r.d_stop_id}`;
        if (seenT.has(k)) continue;
        seenT.add(k);
        transferCandidates.push(r);
        if (transferCandidates.length >= 3) break;
      }
      await loadShapes(transferCandidates.flatMap(r => [r.s1, r.s2]).filter(Boolean));

      // Carica info hub stop
      const hubIds = Array.from(new Set(transferCandidates.map(r => r.hub_stop_id)));
      const hubInfoMap = new Map<string, any>();
      if (hubIds.length > 0) {
        const hubRows = await db.execute<any>(sql`
          SELECT stop_id, stop_name, stop_lat::float AS lat, stop_lon::float AS lon
          FROM gtfs_stops
          WHERE feed_id = ${feedId} AND stop_id IN (${sql.join(hubIds.map(id => sql`${id}`), sql`, `)})
        `);
        for (const h of hubRows.rows as any[]) hubInfoMap.set(h.stop_id, h);
      }

      for (const tr of transferCandidates) {
        const oS = oMap.get(tr.o_stop_id); const dS = dMap.get(tr.d_stop_id);
        const hub = hubInfoMap.get(tr.hub_stop_id);
        if (!oS || !dS || !hub) continue;

        const leg1Info = await buildBusLeg(tr.t1_id, tr.o_seq, tr.hub_seq_arr, tr.s1);
        const leg2Info = await buildBusLeg(tr.t2_id, tr.hub_seq_dep, tr.d_seq, tr.s2);

        const bus1 = makeBusLegObject(
          { ...tr, trip_id: tr.t1_id, route_id: tr.r1_id, route_short_name: tr.r1_sn, route_long_name: tr.r1_ln,
            route_color: tr.r1_c, route_text_color: tr.r1_tc, trip_headsign: tr.h1, direction_id: tr.d1, shape_id: tr.s1,
            o_seq: tr.o_seq, d_seq: tr.hub_seq_arr, o_dep: tr.o_dep, d_arr: tr.hub_arr },
          oS, hub, leg1Info.segStops, leg1Info.distKm, leg1Info.segmentShape
        );
        const bus2 = makeBusLegObject(
          { ...tr, trip_id: tr.t2_id, route_id: tr.r2_id, route_short_name: tr.r2_sn, route_long_name: tr.r2_ln,
            route_color: tr.r2_c, route_text_color: tr.r2_tc, trip_headsign: tr.h2, direction_id: tr.d2_dir, shape_id: tr.s2,
            o_seq: tr.hub_seq_dep, d_seq: tr.d_seq, o_dep: tr.hub_dep, d_arr: tr.d_arr },
          hub, dS, leg2Info.segStops, leg2Info.distKm, leg2Info.segmentShape
        );

        const walkFromKm = haversineKm(from.lat, from.lon, oS.lat, oS.lon);
        const walkToKm   = haversineKm(dS.lat, dS.lon, to.lat, to.lon);
        const walkFromM = Math.round(walkFromKm * 1000);
        const walkToM   = Math.round(walkToKm * 1000);
        const walkFromMin = Math.max(1, Math.round(walkFromKm / walkSpeedKmh * 60));
        const walkToMin   = Math.max(1, Math.round(walkToKm   / walkSpeedKmh * 60));
        const transferMin = Math.max(1, Math.round(toMinHMS(tr.hub_dep) - toMinHMS(tr.hub_arr)));

        const legs = [
          { kind: "walk" as const, fromName: "Origine", toName: oS.stop_name, distanceM: walkFromM, durationMin: walkFromMin, fromLat: from.lat, fromLon: from.lon, toLat: oS.lat, toLon: oS.lon },
          bus1,
          { kind: "transfer" as const, hubStopName: hub.stop_name, durationMin: transferMin, lat: hub.lat, lon: hub.lon },
          bus2,
          { kind: "walk" as const, fromName: dS.stop_name, toName: "Destinazione", distanceM: walkToM, durationMin: walkToMin, fromLat: dS.lat, fromLon: dS.lon, toLat: to.lat, toLon: to.lon },
        ];
        const totalMin = walkFromMin + bus1.busMin + transferMin + bus2.busMin + walkToMin;
        alternatives.push({
          kind: "transfer", legs,
          totalMin,
          totalWalkM: walkFromM + walkToM,
          totalAmount: bus1.amount + bus2.amount,
          depTime: bus1.depTime, arrTime: bus2.arrTime,
        });
      }
    }

    // ── 5b) Trip con 2 CAMBI (3 leg) — fallback per tratte interurbane ──
    // Si attiva sempre quando allowTransfers=true e finora abbiamo poche alternative.
    // Strategia: hub raggiungibili da O (con orario arrivo) ∪ hub da cui si raggiunge D (con orario partenza),
    // poi trovo un trip-bridge che collega un hub_A a un hub_B con orari coerenti.
    if (allowTransfers && alternatives.length < 4) {
      const HUB_CAP = 500;         // max stop_id distinti per lato (limita esplosione cartesiana)
      const MAX_BRIDGE_MIN = 240;  // massima durata viaggio bus intermedio (4h)

      // 5b.1: hub raggiungibili da O entro tempi sensati
      const hubA = await db.execute<any>(sql`
        ${activeServicesCTE},
        o_visits AS (
          SELECT st.trip_id, st.stop_id AS o_stop_id, st.stop_sequence AS o_seq, st.departure_time AS o_dep
          FROM gtfs_stop_times st
          WHERE st.feed_id = ${feedId}
            AND st.stop_id IN (${sql.join(oIds.map(id => sql`${id}`), sql`, `)})
            AND st.departure_time >= ${timeHHMMSS}
        )
        SELECT
          t1.trip_id AS t1_id, t1.route_id AS r1_id, t1.shape_id AS s1, t1.trip_headsign AS h1, t1.direction_id AS d1,
          r1.route_short_name AS r1_sn, r1.route_long_name AS r1_ln, r1.route_color AS r1_c, r1.route_text_color AS r1_tc,
          ov.o_stop_id, ov.o_seq, ov.o_dep,
          st1.stop_id AS hub_a_id, st1.stop_sequence AS hub_a_seq, st1.arrival_time AS hub_a_arr
        FROM gtfs_trips t1
        JOIN active_services s ON s.service_id = t1.service_id
        JOIN o_visits ov ON ov.trip_id = t1.trip_id
        JOIN gtfs_stop_times st1 ON st1.feed_id = t1.feed_id AND st1.trip_id = t1.trip_id AND st1.stop_sequence > ov.o_seq
        JOIN gtfs_routes r1 ON r1.route_id = t1.route_id AND r1.feed_id = t1.feed_id
        WHERE t1.feed_id = ${feedId}
          AND st1.stop_id NOT IN (${sql.join(dIds.map(id => sql`${id}`), sql`, `)})
          AND st1.stop_id NOT IN (${sql.join(oIds.map(id => sql`${id}`), sql`, `)})
        ORDER BY st1.stop_id, ov.o_dep ASC
        LIMIT 15000
      `);
      // 5b.2: hub da cui si raggiunge D
      const hubB = await db.execute<any>(sql`
        ${activeServicesCTE},
        d_visits AS (
          SELECT st.trip_id, st.stop_id AS d_stop_id, st.stop_sequence AS d_seq, st.arrival_time AS d_arr
          FROM gtfs_stop_times st
          WHERE st.feed_id = ${feedId}
            AND st.stop_id IN (${sql.join(dIds.map(id => sql`${id}`), sql`, `)})
        )
        SELECT
          t3.trip_id AS t3_id, t3.route_id AS r3_id, t3.shape_id AS s3, t3.trip_headsign AS h3, t3.direction_id AS d3_dir,
          r3.route_short_name AS r3_sn, r3.route_long_name AS r3_ln, r3.route_color AS r3_c, r3.route_text_color AS r3_tc,
          st3.stop_id AS hub_b_id, st3.stop_sequence AS hub_b_seq, st3.departure_time AS hub_b_dep,
          dv.d_stop_id, dv.d_seq, dv.d_arr
        FROM gtfs_trips t3
        JOIN active_services s ON s.service_id = t3.service_id
        JOIN d_visits dv ON dv.trip_id = t3.trip_id
        JOIN gtfs_stop_times st3 ON st3.feed_id = t3.feed_id AND st3.trip_id = t3.trip_id AND st3.stop_sequence < dv.d_seq
        JOIN gtfs_routes r3 ON r3.route_id = t3.route_id AND r3.feed_id = t3.feed_id
        WHERE t3.feed_id = ${feedId}
          AND st3.stop_id NOT IN (${sql.join(oIds.map(id => sql`${id}`), sql`, `)})
          AND st3.stop_id NOT IN (${sql.join(dIds.map(id => sql`${id}`), sql`, `)})
        ORDER BY st3.stop_id, dv.d_arr DESC
        LIMIT 15000
      `);

      // Distinct stop_id (NON top-by-count: vogliamo includere tutti gli hub possibili).
      // Cap a HUB_CAP per evitare esplosione bridge.
      const aRows = hubA.rows as any[];
      const bRows = hubB.rows as any[];
      const topA: string[] = [];
      const seenA = new Set<string>();
      for (const r of aRows) { if (!seenA.has(r.hub_a_id)) { seenA.add(r.hub_a_id); topA.push(r.hub_a_id); if (topA.length >= HUB_CAP) break; } }
      const topB: string[] = [];
      const seenB = new Set<string>();
      for (const r of bRows) { if (!seenB.has(r.hub_b_id)) { seenB.add(r.hub_b_id); topB.push(r.hub_b_id); if (topB.length >= HUB_CAP) break; } }
      const topASet = new Set(topA);
      const topBSet = new Set(topB);
      const filteredA = aRows.filter(r => topASet.has(r.hub_a_id));
      const filteredB = bRows.filter(r => topBSet.has(r.hub_b_id));

      console.log(`[journey-plan/2tx] hubA_rows=${aRows.length} hubB_rows=${bRows.length} topA=${topA.length} topB=${topB.length}`);

      if (topA.length > 0 && topB.length > 0) {
        // ── Walking transfer setup ──
        // Permetto cambi tra fermate vicine (es. scendi a Torrette, 3 min a piedi, prendi la C)
        const WALK_TRANSFER_M = 500;          // raggio massimo trasferimento a piedi (m)
        const WALK_TRANSFER_KM = WALK_TRANSFER_M / 1000;

        // Carico coordinate di TUTTI gli hub candidati (topA + topB)
        const allHubIds0 = Array.from(new Set([...topA, ...topB]));
        const stopCoordsRows = await db.execute<any>(sql`
          SELECT stop_id, stop_name, stop_lat::float AS lat, stop_lon::float AS lon
          FROM gtfs_stops
          WHERE feed_id = ${feedId} AND stop_id IN (${sql.join(allHubIds0.map(id => sql`${id}`), sql`, `)})
        `);
        const stopCoords = new Map<string, { lat: number; lon: number; name: string }>();
        for (const s of stopCoordsRows.rows as any[]) {
          stopCoords.set(s.stop_id, { lat: s.lat, lon: s.lon, name: s.stop_name });
        }

        // Per ogni hub_a in topA, trovo tutti gli hub vicini (entro WALK_TRANSFER_M) — usato lato bridge.start
        // Per ogni hub_b in topB, trovo tutti gli hub vicini — usato lato bridge.end
        // O(N*M) ma N,M ~ 500 → 250k confronti, accettabile.
        const nearAOf = new Map<string, Array<{ id: string; walkM: number; walkMin: number }>>();
        for (const aId of topA) {
          const aC = stopCoords.get(aId); if (!aC) continue;
          const list: Array<{ id: string; walkM: number; walkMin: number }> = [{ id: aId, walkM: 0, walkMin: 0 }];
          for (const xId of topA) {
            if (xId === aId) continue;
            const xC = stopCoords.get(xId); if (!xC) continue;
            const km = haversineKm(aC.lat, aC.lon, xC.lat, xC.lon);
            if (km <= WALK_TRANSFER_KM) {
              list.push({ id: xId, walkM: Math.round(km * 1000), walkMin: Math.max(1, Math.round(km / walkSpeedKmh * 60)) });
            }
          }
          nearAOf.set(aId, list);
        }
        const nearBOf = new Map<string, Array<{ id: string; walkM: number; walkMin: number }>>();
        for (const bId of topB) {
          const bC = stopCoords.get(bId); if (!bC) continue;
          const list: Array<{ id: string; walkM: number; walkMin: number }> = [{ id: bId, walkM: 0, walkMin: 0 }];
          for (const xId of topB) {
            if (xId === bId) continue;
            const xC = stopCoords.get(xId); if (!xC) continue;
            const km = haversineKm(bC.lat, bC.lon, xC.lat, xC.lon);
            if (km <= WALK_TRANSFER_KM) {
              list.push({ id: xId, walkM: Math.round(km * 1000), walkMin: Math.max(1, Math.round(km / walkSpeedKmh * 60)) });
            }
          }
          nearBOf.set(bId, list);
        }

        // 5b.3: BRIDGE — trip che parte da uno dei topA e arriva a uno dei topB
        const bridges = await db.execute<any>(sql`
          ${activeServicesCTE}
          SELECT
            t2.trip_id AS t2_id, t2.route_id AS r2_id, t2.shape_id AS s2, t2.trip_headsign AS h2, t2.direction_id AS d2_dir,
            r2.route_short_name AS r2_sn, r2.route_long_name AS r2_ln, r2.route_color AS r2_c, r2.route_text_color AS r2_tc,
            sta.stop_id AS hub_a_id, sta.stop_sequence AS sa_seq, sta.departure_time AS hub_a_dep,
            stb.stop_id AS hub_b_id, stb.stop_sequence AS sb_seq, stb.arrival_time AS hub_b_arr
          FROM gtfs_trips t2
          JOIN active_services s ON s.service_id = t2.service_id
          JOIN gtfs_stop_times sta ON sta.feed_id = t2.feed_id AND sta.trip_id = t2.trip_id
            AND sta.stop_id IN (${sql.join(topA.map(id => sql`${id}`), sql`, `)})
          JOIN gtfs_stop_times stb ON stb.feed_id = t2.feed_id AND stb.trip_id = t2.trip_id
            AND stb.stop_id IN (${sql.join(topB.map(id => sql`${id}`), sql`, `)})
            AND stb.stop_sequence > sta.stop_sequence
          JOIN gtfs_routes r2 ON r2.route_id = t2.route_id AND r2.feed_id = t2.feed_id
          WHERE t2.feed_id = ${feedId}
            AND sta.stop_id <> stb.stop_id
            AND sta.departure_time >= ${timeHHMMSS}
            AND EXTRACT(EPOCH FROM (stb.arrival_time::interval - sta.departure_time::interval))/60.0 BETWEEN 1 AND ${MAX_BRIDGE_MIN}
          ORDER BY sta.departure_time ASC
          LIMIT 12000
        `);

        console.log(`[journey-plan/2tx] bridges=${bridges.rows.length}`);

        // 5b.4: combina A → BRIDGE → B con vincoli temporali (con walking transfer permesso)
        type Triple = {
          a: any; mid: any; b: any;
          // info walk transfer
          tx1WalkM: number; tx1WalkMin: number;   // a → bridge.start
          tx2WalkM: number; tx2WalkMin: number;   // bridge.end → b
          totalMin: number; depTime: string; arrTime: string;
        };
        const triples: Triple[] = [];

        // Index bridges per hub_a_id (usato da nearAOf per trovare bridge "vicini")
        const bridgesByA = new Map<string, any[]>();
        for (const br of bridges.rows as any[]) {
          if (!bridgesByA.has(br.hub_a_id)) bridgesByA.set(br.hub_a_id, []);
          bridgesByA.get(br.hub_a_id)!.push(br);
        }
        // Index legB per hub_b_id
        const legBByHub = new Map<string, any[]>();
        for (const b of filteredB) {
          if (!legBByHub.has(b.hub_b_id)) legBByHub.set(b.hub_b_id, []);
          legBByHub.get(b.hub_b_id)!.push(b);
        }

        for (const a of filteredA) {
          const aArrMin = toMinHMS(a.hub_a_arr);
          // Considera tutti i bridge che partono da a.hub_a_id O da uno stop vicino
          const nearAList = nearAOf.get(a.hub_a_id) ?? [{ id: a.hub_a_id, walkM: 0, walkMin: 0 }];
          for (const nA of nearAList) {
            const brs = bridgesByA.get(nA.id);
            if (!brs) continue;
            for (const br of brs) {
              if (br.r2_id === a.r1_id) continue; // stessa linea = no cambio
              const brDepMin = toMinHMS(br.hub_a_dep);
              // wait1 effettivo: tempo che intercorre tra arrivo di leg1 e partenza del bridge,
              // sottratto del walk necessario per spostarsi tra le due fermate.
              const wait1 = brDepMin - aArrMin - nA.walkMin;
              if (wait1 < MIN_TRANSFER_MIN || wait1 > MAX_TRANSFER_MIN) continue;
              const brArrMin = toMinHMS(br.hub_b_arr);
              // Lato B: per ogni stop vicino a br.hub_b_id che esiste come hub_b di legB
              const nearBList = nearBOf.get(br.hub_b_id) ?? [{ id: br.hub_b_id, walkM: 0, walkMin: 0 }];
              for (const nB of nearBList) {
                const bs = legBByHub.get(nB.id);
                if (!bs) continue;
                for (const b of bs) {
                  if (b.r3_id === br.r2_id) continue;
                  const wait2 = toMinHMS(b.hub_b_dep) - brArrMin - nB.walkMin;
                  if (wait2 < MIN_TRANSFER_MIN || wait2 > MAX_TRANSFER_MIN) continue;
                  const totalMin = toMinHMS(b.d_arr) - toMinHMS(a.o_dep);
                  triples.push({
                    a, mid: br, b,
                    tx1WalkM: nA.walkM, tx1WalkMin: nA.walkMin,
                    tx2WalkM: nB.walkM, tx2WalkMin: nB.walkMin,
                    totalMin, depTime: a.o_dep, arrTime: b.d_arr,
                  });
                  if (triples.length > 400) break;
                }
                if (triples.length > 400) break;
              }
              if (triples.length > 400) break;
            }
            if (triples.length > 400) break;
          }
          if (triples.length > 400) break;
        }

        // Dedup per (route1|hubA-leg1|route2|hubB-bridge|route3) — ignora hub esatto del bridge
        triples.sort((x, y) => x.totalMin - y.totalMin);
        const seenTri = new Set<string>();
        const triCandidates: Triple[] = [];
        for (const t of triples) {
          const k = `${t.a.r1_id}|${t.a.hub_a_id}|${t.mid.r2_id}|${t.b.hub_b_id}|${t.b.r3_id}`;
          if (seenTri.has(k)) continue;
          seenTri.add(k);
          triCandidates.push(t);
          if (triCandidates.length >= 3) break;
        }

        console.log(`[journey-plan/2tx] triples=${triples.length} candidates=${triCandidates.length}`);

        if (triCandidates.length > 0) {
          await loadShapes(triCandidates.flatMap(t => [t.a.s1, t.mid.s2, t.b.s3]).filter(Boolean));
          // Carica info hub: include sia gli stop di leg1/leg3 sia quelli del bridge (potrebbero differire)
          const allHubIds = Array.from(new Set(triCandidates.flatMap(t => [
            t.a.hub_a_id, t.mid.hub_a_id, t.mid.hub_b_id, t.b.hub_b_id,
          ])));
          const hubInfoMap2 = new Map<string, any>();
          if (allHubIds.length > 0) {
            const hubRows = await db.execute<any>(sql`
              SELECT stop_id, stop_name, stop_lat::float AS lat, stop_lon::float AS lon
              FROM gtfs_stops
              WHERE feed_id = ${feedId} AND stop_id IN (${sql.join(allHubIds.map(id => sql`${id}`), sql`, `)})
            `);
            for (const h of hubRows.rows as any[]) hubInfoMap2.set(h.stop_id, h);
          }

          for (const t of triCandidates) {
            const oS = oMap.get(t.a.o_stop_id); const dS = dMap.get(t.b.d_stop_id);
            const hubA_legEnd = hubInfoMap2.get(t.a.hub_a_id);     // dove scende leg1
            const hubA_brStart = hubInfoMap2.get(t.mid.hub_a_id);  // dove sale bridge (può essere diverso!)
            const hubB_brEnd  = hubInfoMap2.get(t.mid.hub_b_id);   // dove scende bridge
            const hubB_legStart = hubInfoMap2.get(t.b.hub_b_id);   // dove sale leg3 (può essere diverso!)
            if (!oS || !dS || !hubA_legEnd || !hubA_brStart || !hubB_brEnd || !hubB_legStart) continue;

            const leg1Info = await buildBusLeg(t.a.t1_id, t.a.o_seq, t.a.hub_a_seq, t.a.s1);
            const leg2Info = await buildBusLeg(t.mid.t2_id, t.mid.sa_seq, t.mid.sb_seq, t.mid.s2);
            const leg3Info = await buildBusLeg(t.b.t3_id, t.b.hub_b_seq, t.b.d_seq, t.b.s3);

            const bus1 = makeBusLegObject(
              { ...t.a, trip_id: t.a.t1_id, route_id: t.a.r1_id, route_short_name: t.a.r1_sn, route_long_name: t.a.r1_ln,
                route_color: t.a.r1_c, route_text_color: t.a.r1_tc, trip_headsign: t.a.h1, direction_id: t.a.d1, shape_id: t.a.s1,
                o_seq: t.a.o_seq, d_seq: t.a.hub_a_seq, o_dep: t.a.o_dep, d_arr: t.a.hub_a_arr },
              oS, hubA_legEnd, leg1Info.segStops, leg1Info.distKm, leg1Info.segmentShape
            );
            const bus2 = makeBusLegObject(
              { trip_id: t.mid.t2_id, route_id: t.mid.r2_id, route_short_name: t.mid.r2_sn, route_long_name: t.mid.r2_ln,
                route_color: t.mid.r2_c, route_text_color: t.mid.r2_tc, trip_headsign: t.mid.h2, direction_id: t.mid.d2_dir, shape_id: t.mid.s2,
                o_seq: t.mid.sa_seq, d_seq: t.mid.sb_seq, o_dep: t.mid.hub_a_dep, d_arr: t.mid.hub_b_arr },
              hubA_brStart, hubB_brEnd, leg2Info.segStops, leg2Info.distKm, leg2Info.segmentShape
            );
            const bus3 = makeBusLegObject(
              { ...t.b, trip_id: t.b.t3_id, route_id: t.b.r3_id, route_short_name: t.b.r3_sn, route_long_name: t.b.r3_ln,
                route_color: t.b.r3_c, route_text_color: t.b.r3_tc, trip_headsign: t.b.h3, direction_id: t.b.d3_dir, shape_id: t.b.s3,
                o_seq: t.b.hub_b_seq, d_seq: t.b.d_seq, o_dep: t.b.hub_b_dep, d_arr: t.b.d_arr },
              hubB_legStart, dS, leg3Info.segStops, leg3Info.distKm, leg3Info.segmentShape
            );

            const walkFromKm = haversineKm(from.lat, from.lon, oS.lat, oS.lon);
            const walkToKm   = haversineKm(dS.lat, dS.lon, to.lat, to.lon);
            const walkFromM = Math.round(walkFromKm * 1000);
            const walkToM   = Math.round(walkToKm * 1000);
            const walkFromMin = Math.max(1, Math.round(walkFromKm / walkSpeedKmh * 60));
            const walkToMin   = Math.max(1, Math.round(walkToKm   / walkSpeedKmh * 60));

            // Transfer 1: leg1 → bridge. Se hub_a_legEnd != hub_a_brStart c'è anche walk.
            const tx1WaitMin = Math.max(1, Math.round(toMinHMS(t.mid.hub_a_dep) - toMinHMS(t.a.hub_a_arr) - t.tx1WalkMin));
            const tx1Total = tx1WaitMin + t.tx1WalkMin;
            const tx1Leg = t.tx1WalkM > 0 ? {
              kind: "transfer" as const,
              hubStopName: `${hubA_legEnd.stop_name} → ${hubA_brStart.stop_name}`,
              durationMin: tx1Total,
              walkM: t.tx1WalkM, walkMin: t.tx1WalkMin,
              waitMin: tx1WaitMin,
              fromLat: hubA_legEnd.lat, fromLon: hubA_legEnd.lon,
              toLat: hubA_brStart.lat, toLon: hubA_brStart.lon,
              lat: hubA_legEnd.lat, lon: hubA_legEnd.lon,
            } : {
              kind: "transfer" as const,
              hubStopName: hubA_legEnd.stop_name,
              durationMin: tx1Total,
              lat: hubA_legEnd.lat, lon: hubA_legEnd.lon,
            };

            // Transfer 2: bridge → leg3
            const tx2WaitMin = Math.max(1, Math.round(toMinHMS(t.b.hub_b_dep) - toMinHMS(t.mid.hub_b_arr) - t.tx2WalkMin));
            const tx2Total = tx2WaitMin + t.tx2WalkMin;
            const tx2Leg = t.tx2WalkM > 0 ? {
              kind: "transfer" as const,
              hubStopName: `${hubB_brEnd.stop_name} → ${hubB_legStart.stop_name}`,
              durationMin: tx2Total,
              walkM: t.tx2WalkM, walkMin: t.tx2WalkMin,
              waitMin: tx2WaitMin,
              fromLat: hubB_brEnd.lat, fromLon: hubB_brEnd.lon,
              toLat: hubB_legStart.lat, toLon: hubB_legStart.lon,
              lat: hubB_brEnd.lat, lon: hubB_brEnd.lon,
            } : {
              kind: "transfer" as const,
              hubStopName: hubB_brEnd.stop_name,
              durationMin: tx2Total,
              lat: hubB_brEnd.lat, lon: hubB_brEnd.lon,
            };

            const legs = [
              { kind: "walk" as const, fromName: "Origine", toName: oS.stop_name, distanceM: walkFromM, durationMin: walkFromMin, fromLat: from.lat, fromLon: from.lon, toLat: oS.lat, toLon: oS.lon },
              bus1,
              tx1Leg,
              bus2,
              tx2Leg,
              bus3,
              { kind: "walk" as const, fromName: dS.stop_name, toName: "Destinazione", distanceM: walkToM, durationMin: walkToMin, fromLat: dS.lat, fromLon: dS.lon, toLat: to.lat, toLon: to.lon },
            ];
            const totalMin = walkFromMin + bus1.busMin + tx1Total + bus2.busMin + tx2Total + bus3.busMin + walkToMin;
            alternatives.push({
              kind: "transfer", legs,
              totalMin,
              totalWalkM: walkFromM + walkToM + t.tx1WalkM + t.tx2WalkM,
              totalAmount: bus1.amount + bus2.amount + bus3.amount,
              depTime: bus1.depTime, arrTime: bus3.arrTime,
            });
          }
        }
      }
    }

    // ── 6) Ordina per partenza, taglia, badge ──
    alternatives.sort((a, b) => toMinHMS(a.depTime) - toMinHMS(b.depTime));
    const top = alternatives.slice(0, maxAlternatives + 2);
    if (top.length > 0) {
      const fastest = top.reduce((a, b) => a.totalMin <= b.totalMin ? a : b);
      const cheapest = top.reduce((a, b) => a.totalAmount <= b.totalAmount ? a : b);
      const leastWalk = top.reduce((a, b) => a.totalWalkM <= b.totalWalkM ? a : b);
      fastest.badges = [...(fastest.badges ?? []), "fastest"];
      cheapest.badges = [...(cheapest.badges ?? []), "cheapest"];
      leastWalk.badges = [...(leastWalk.badges ?? []), "leastWalk"];
    }

    // Se ci sono fermate vicine ma 0 alternative → spiego il limite del feed GTFS
    let reason: string | undefined;
    if (top.length === 0) {
      reason = `Fermate trovate (${oStops.length} vicino origine, ${dStops.length} vicino destinazione) ma nessuna corsa diretta o con un cambio collega le due aree il ${date} dopo le ${time.slice(0,5)}. Il feed GTFS attuale copre principalmente il TPL urbano/extra-urbano locale: per tratte interurbane lunghe potrebbero non esserci collegamenti bus disponibili. Prova: cambiare orario, scegliere fermate più vicine ad un capolinea/hub, oppure considerare il treno per la lunga percorrenza.`;
    }

    res.json({
      query: { from, to, date, time, maxWalkM, allowTransfers },
      nearOriginCount: oStops.length,
      nearDestCount: dStops.length,
      extendedWalk,
      alternatives: top,
      ...(reason ? { reason } : {}),
    });
  } catch (e: any) {
    console.error("[journey-plan]", e);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// POLIMETRICHE — Snapshot condivisibili (link pubblici al PDF/HTML stampabile)
// ═══════════════════════════════════════════════════════════════════════════
//
// Endpoints:
//   POST /api/fares/polimetriche/snapshots   → salva HTML, ritorna { id, url }
//   GET  /api/fares/polimetriche/snapshots/:id → serve HTML (text/html, pubblico)
//
// La tabella `fares_polimetriche_snapshots` viene creata lazy alla prima
// chiamata (CREATE TABLE IF NOT EXISTS) per non richiedere una migration.

let polimetricheSnapshotsBootstrapped = false;
async function ensurePolimetricheSnapshotsTable(): Promise<void> {
  if (polimetricheSnapshotsBootstrapped) return;
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS fares_polimetriche_snapshots (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        title text,
        agency_name text,
        zoning_method text,
        route_count int,
        product_count int,
        area_count int,
        html text NOT NULL,
        meta jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_fares_polimetriche_snapshots_created_at ON fares_polimetriche_snapshots(created_at DESC)`);
    polimetricheSnapshotsBootstrapped = true;
  } catch (e: any) {
    console.error("[fares] bootstrap polimetriche snapshots table error", e?.message);
  }
}
void ensurePolimetricheSnapshotsTable();

/**
 * POST /api/fares/polimetriche/snapshots
 * Body: { html: string, title?, agencyName?, zoningMethod?, routeCount?, productCount?, areaCount?, meta? }
 * Ritorna: { id, url }
 *
 * Limite payload: 50MB (vedi `app.ts` express.json limit).
 */
router.post("/fares/polimetriche/snapshots", async (req, res): Promise<void> => {
  try {
    await ensurePolimetricheSnapshotsTable();
    const {
      html, title, agencyName, zoningMethod,
      routeCount, productCount, areaCount, meta,
    } = req.body || {};
    if (typeof html !== "string" || html.length < 100) {
      res.status(400).json({ error: "Campo 'html' mancante o troppo corto" });
      return;
    }
    if (html.length > 40 * 1024 * 1024) {
      res.status(413).json({ error: "HTML troppo grande (max 40MB)" });
      return;
    }
    const inserted = await db.execute(sql`
      INSERT INTO fares_polimetriche_snapshots (
        title, agency_name, zoning_method, route_count, product_count, area_count, html, meta
      ) VALUES (
        ${title ?? null}, ${agencyName ?? null}, ${zoningMethod ?? null},
        ${routeCount ?? null}, ${productCount ?? null}, ${areaCount ?? null},
        ${html}, ${meta ? JSON.stringify(meta) : null}::jsonb
      )
      RETURNING id, created_at
    `);
    const row: any = (inserted as any).rows?.[0] ?? (inserted as any)[0];
    if (!row?.id) {
      res.status(500).json({ error: "Impossibile creare lo snapshot" });
      return;
    }
    // Costruisce URL assoluto verso QUESTA stessa origin del backend.
    // Il client può comunque fabbricarsi un URL alternativo a partire da `id`.
    const proto = (req.headers["x-forwarded-proto"] as string) || req.protocol || "https";
    const host = (req.headers["x-forwarded-host"] as string) || req.get("host") || "";
    const url = `${proto}://${host}/api/fares/polimetriche/snapshots/${row.id}`;
    res.json({ id: row.id, url, createdAt: row.created_at });
  } catch (e: any) {
    console.error("[fares] create snapshot", e);
    res.status(500).json({ error: e?.message || "Errore creazione snapshot" });
  }
});

/**
 * GET /api/fares/polimetriche/snapshots/:id
 * Serve l'HTML pubblicamente (per essere aperto come link).
 * Accept JSON via `?format=json` per ottenere metadata invece dell'HTML.
 */
router.get("/fares/polimetriche/snapshots/:id", async (req, res): Promise<void> => {
  try {
    await ensurePolimetricheSnapshotsTable();
    const id = req.params.id;
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      res.status(400).send("ID snapshot non valido");
      return;
    }
    const result = await db.execute(sql`
      SELECT id, title, agency_name, zoning_method, route_count, product_count,
             area_count, html, meta, created_at
        FROM fares_polimetriche_snapshots
       WHERE id = ${id}::uuid
       LIMIT 1
    `);
    const row: any = (result as any).rows?.[0] ?? (result as any)[0];
    if (!row) {
      res.status(404).send("Snapshot non trovato o scaduto");
      return;
    }
    if (req.query.format === "json") {
      res.json({
        id: row.id, title: row.title, agencyName: row.agency_name,
        zoningMethod: row.zoning_method, routeCount: row.route_count,
        productCount: row.product_count, areaCount: row.area_count,
        meta: row.meta, createdAt: row.created_at,
        htmlLength: (row.html || "").length,
      });
      return;
    }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    // Cache aggressivo: lo snapshot è immutabile per design
    res.setHeader("Cache-Control", "public, max-age=86400, immutable");
    res.send(row.html);
  } catch (e: any) {
    console.error("[fares] get snapshot", e);
    res.status(500).send(`Errore: ${e?.message || "interno"}`);
  }
});

export default router;
