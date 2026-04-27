/**
 * GTFS Feed Analyzer (Sprint S1)
 *
 * Calcola KPI operativi/economici/di copertura per un GTFS feed.
 *
 * INPUT:
 *   - feedId del GTFS già caricato in DB
 *   - parametri economici (override o default)
 *
 * OUTPUT (in tabella gtfs_feed_analysis):
 *   - vetture-km giornaliere (aggregate + per linea)
 *   - vetture-ore giornaliere
 *   - n. corse/giorno
 *   - costi/ricavi/margine (€/giorno)
 *   - copertura popolazione (entro 300m da fermata) tramite census_sections
 *   - bbox geografico
 *   - anomalie (trip senza shape, fermate orfane, …)
 */
import { db } from "@workspace/db";
import {
  gtfsFeeds,
  gtfsRoutes,
  gtfsStops,
  gtfsTrips,
  gtfsStopTimes,
  gtfsShapes,
  gtfsCalendar,
  gtfsCalendarDates,
  gtfsFeedAnalysis,
  gtfsFeedEconomicParams,
  censusSections,
  planningRouteClassifications,
  planningPois,
} from "@workspace/db/schema";
import { eq, and, sql } from "drizzle-orm";

/** Default parametri economici (€/€/€) */
export const DEFAULT_ECON = {
  fuelConsumptionL100: 35,
  fuelPriceEurL: 1.65,
  driverCostEurH: 28,
  maintenanceEurKm: 0.35,
  amortizationEurKm: 0.25,
  fareUrbanEurKm: 2.5,
  fareSuburbanEurKm: 1.8,
  fareNightEurKm: 2.2,
};

export type EconParams = typeof DEFAULT_ECON;

/** Costo carburante derivato (€/km) */
export function fuelCostPerKm(p: EconParams): number {
  return (p.fuelConsumptionL100 / 100) * p.fuelPriceEurL;
}

/** Costo totale variabile €/km (carburante + manutenzione + ammortamento) */
export function variableCostPerKm(p: EconParams): number {
  return fuelCostPerKm(p) + p.maintenanceEurKm + p.amortizationEurKm;
}

/* ──────────────────── geo helpers ──────────────────── */

const EARTH_R_KM = 6371.0088;

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R_KM * Math.asin(Math.sqrt(a));
}

/** Lunghezza GeoJSON LineString in km */
function lineStringKm(coords: number[][]): number {
  let km = 0;
  for (let i = 1; i < coords.length; i++) {
    const [lon1, lat1] = coords[i - 1];
    const [lon2, lat2] = coords[i];
    km += haversineKm(lat1, lon1, lat2, lon2);
  }
  return km;
}

/* ──────────────────── time helpers ──────────────────── */

/** "HH:MM:SS" (anche >24h per overnight) → secondi dalla mezzanotte */
function timeToSeconds(s: string | null): number | null {
  if (!s) return null;
  const m = s.match(/^(\d{1,3}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  return +m[1] * 3600 + +m[2] * 60 + +m[3];
}

/* ──────────────────── service type detection ──────────────────── */

/**
 * Determina il tipo di servizio per il calcolo del corrispettivo:
 *   "urban" | "suburban" | "night"
 * Heuristics:
 *   - se trip_headsign o route_long_name contiene "notturno"/"night"/"N" → night
 *   - se route_type === 3 e nome breve → urban
 *   - se la linea collega comuni diversi (TODO) → suburban
 *   - default: urban
 */
function detectServiceType(routeName: string | null, headsignSample: string | null): "urban" | "suburban" | "night" {
  const txt = `${routeName ?? ""} ${headsignSample ?? ""}`.toLowerCase();
  if (/notturn|night/.test(txt)) return "night";
  if (/extra|interurban|suburban/.test(txt)) return "suburban";
  return "urban";
}

function fareForServiceType(p: EconParams, t: "urban" | "suburban" | "night"): number {
  switch (t) {
    case "night": return p.fareNightEurKm;
    case "suburban": return p.fareSuburbanEurKm;
    default: return p.fareUrbanEurKm;
  }
}

/* ──────────────────── analyzer ──────────────────── */

export interface RouteKpi {
  routeId: string;
  shortName: string | null;
  longName: string | null;
  color: string | null;
  serviceType: "urban" | "suburban" | "night";
  category: string | null;          // categoria assegnata dall'utente
  shapeKm: number;
  tripsDay: number;
  kmDay: number;
  hoursDay: number;
  costFuelDay: number;
  costMaintDay: number;
  costAmortDay: number;
  costDriverDay: number;
  costTotalDay: number;
  revenueDay: number;
  marginDay: number;
  estimatedPaxDay: number;          // passeggeri stimati/giorno
  paxPerKm: number;                 // intensità domanda
}

export interface AnalysisResult {
  totalKmDay: number;
  totalHoursDay: number;
  totalTripsDay: number;
  activeRoutes: number;
  activeStops: number;
  bbox: { minLat: number; maxLat: number; minLon: number; maxLon: number } | null;
  populationCovered: number;
  populationTotal: number;
  totalCostDay: number;
  totalRevenueDay: number;
  marginDay: number;
  perRoute: RouteKpi[];
  anomalies: {
    tripsWithoutShape: number;
    stopsOrphan: number;
    routesWithoutTrips: number;
  };
  /** Distribuzione oraria delle partenze (0..23) */
  hourlyDistribution: number[];
  /** Top 20 fermate per numero di passaggi nel giorno */
  topStops: { stopId: string; stopName: string; lat: number; lon: number; trips: number }[];
  /** Categorie linee con conteggio */
  categories: { category: string; routeCount: number; kmDay: number; revenueDay: number }[];
  /** Stima passeggeri totali/giorno (modello gravità + POI) */
  ridership: {
    estimatedPaxDay: number;
    revenuePerPax: number;
    costPerPax: number;
    methodology: string;
    poisConsidered: number;
  };
  /** Metadati filtro applicato */
  filters: {
    dayType: DayType;
    routeIds: string[] | null;
    pickedDate: string | null;
    serviceIdsCount: number;
    serviceDate: string | null;     // YYYYMMDD scelto dall'utente (override dayType)
    categoryFilter: string[] | null;
  };
}

export type DayType = "weekday" | "saturday" | "sunday" | "all";

/**
 * Trova i service_id attivi in un "giorno feriale tipo".
 *
 * Strategia robusta che supporta sia GTFS basati solo su `calendar.txt`
 * (servizi tipo "feriale"/"sabato"), sia quelli che usano solo `calendar_dates.txt`
 * con date esplicite (servizi tipo "660_1000000008620").
 *
 * Logica:
 *   1. Prova prima da `calendar`: service con almeno 3 giorni feriali attivi.
 *   2. Se quei service NON hanno trip, fallback su `calendar_dates`:
 *      pesca il mercoledì più "rappresentativo" (data con più service distinti
 *      attivi, exception_type=1) e usa tutti i service attivi quel giorno.
 *   3. Se nemmeno questo dà risultati, ritorna TUTTI i service trovati nei trip
 *      (sovrastima onesta).
 */
/**
 * Trova i service_id attivi per il tipo di giorno richiesto.
 * Supporta calendar.txt (servizi tipo "feriale"/"sabato") + calendar_dates.txt (date esplicite).
 *
 *   - weekday  → Lun-Ven (almeno 3 giorni feriali su 5 per calendar; ISODOW 1-5 per calendar_dates)
 *   - saturday → Sab
 *   - sunday   → Dom (festivi)
 *   - all      → tutti i service trovati nei trip
 */
async function pickServiceIds(
  feedId: string,
  dayType: DayType = "weekday",
  serviceDate: string | null = null,
): Promise<{ ids: Set<string>; pickedDate: string | null }> {
  // Se l'utente ha scelto una data specifica, calcola gli active service per quella data
  // unendo calendar (range start/end + dow) e calendar_dates (eccezioni add/remove).
  if (serviceDate && /^\d{8}$/.test(serviceDate)) {
    const dateRow = await db.execute(sql`
      SELECT EXTRACT(ISODOW FROM TO_DATE(${serviceDate}, 'YYYYMMDD'))::int AS dow
    `);
    const dow = (dateRow.rows[0] as any)?.dow as number; // 1=Mon..7=Sun
    // seleziona la colonna DOW in calendar
    const ids = new Set<string>();
    const fromCal = await db.execute(sql`
      SELECT service_id FROM gtfs_calendar
      WHERE feed_id = ${feedId}
        AND ${serviceDate} BETWEEN start_date AND end_date
        AND (
          (${dow} = 1 AND monday    = 1) OR
          (${dow} = 2 AND tuesday   = 1) OR
          (${dow} = 3 AND wednesday = 1) OR
          (${dow} = 4 AND thursday  = 1) OR
          (${dow} = 5 AND friday    = 1) OR
          (${dow} = 6 AND saturday  = 1) OR
          (${dow} = 7 AND sunday    = 1)
        )
    `);
    for (const r of (fromCal.rows as any[])) ids.add(r.service_id);
    // calendar_dates additions (type 1) e removals (type 2) per quella data
    const exc = await db.execute(sql`
      SELECT service_id, exception_type FROM gtfs_calendar_dates
      WHERE feed_id = ${feedId} AND date = ${serviceDate}
    `);
    for (const r of (exc.rows as any[])) {
      if (r.exception_type === 1) ids.add(r.service_id);
      else if (r.exception_type === 2) ids.delete(r.service_id);
    }
    return { ids, pickedDate: serviceDate };
  }

  if (dayType === "all") {
    const all = await db.execute(sql`
      SELECT DISTINCT service_id FROM gtfs_trips WHERE feed_id = ${feedId}
    `);
    return { ids: new Set((all.rows as any[]).map((x) => x.service_id)), pickedDate: null };
  }

  // 1. Prova calendar.txt
  const cals = await db.select().from(gtfsCalendar).where(eq(gtfsCalendar.feedId, feedId));
  let fromCal: string[] = [];
  if (dayType === "weekday") {
    fromCal = cals
      .filter((c) => (c.monday ?? 0) + (c.tuesday ?? 0) + (c.wednesday ?? 0) + (c.thursday ?? 0) + (c.friday ?? 0) >= 3)
      .map((c) => c.serviceId);
  } else if (dayType === "saturday") {
    fromCal = cals.filter((c) => (c.saturday ?? 0) === 1).map((c) => c.serviceId);
  } else if (dayType === "sunday") {
    fromCal = cals.filter((c) => (c.sunday ?? 0) === 1).map((c) => c.serviceId);
  }

  if (fromCal.length > 0) {
    // verifica che questi service abbiano effettivamente trip
    const trips = await db
      .select({ sid: gtfsTrips.serviceId })
      .from(gtfsTrips)
      .where(eq(gtfsTrips.feedId, feedId));
    const set = new Set(fromCal);
    const hasAny = trips.some((t) => set.has(t.sid));
    if (hasAny) return { ids: new Set(fromCal), pickedDate: null };
  }

  // 2. Fallback calendar_dates: pick best date matching dayType
  const dowFilter =
    dayType === "weekday" ? "BETWEEN 1 AND 5" :
    dayType === "saturday" ? "= 6" :
    "= 7"; // sunday
  const bestDate = await db.execute(sql.raw(`
    SELECT date, COUNT(DISTINCT service_id)::int AS n
    FROM gtfs_calendar_dates
    WHERE feed_id = '${feedId}'
      AND exception_type = 1
      AND EXTRACT(ISODOW FROM TO_DATE(date, 'YYYYMMDD')) ${dowFilter}
    GROUP BY date
    ORDER BY n DESC, date DESC
    LIMIT 1
  `));
  const pickedDate = (bestDate.rows[0] as any)?.date as string | undefined;
  if (pickedDate) {
    const r = await db
      .select({ sid: gtfsCalendarDates.serviceId })
      .from(gtfsCalendarDates)
      .where(and(
        eq(gtfsCalendarDates.feedId, feedId),
        eq(gtfsCalendarDates.date, pickedDate),
        eq(gtfsCalendarDates.exceptionType, 1),
      ));
    if (r.length > 0) return { ids: new Set(r.map((x) => x.sid)), pickedDate };
  }

  // 3. Fallback estremo
  const all = await db.execute(sql`
    SELECT DISTINCT service_id FROM gtfs_trips WHERE feed_id = ${feedId}
  `);
  return { ids: new Set((all.rows as any[]).map((x) => x.service_id)), pickedDate: null };
}

/**
 * Calcola km medi di una linea = lunghezza shape più frequente associata ai suoi trip.
 */
function buildRouteShapeKm(
  trips: { routeId: string; shapeId: string | null }[],
  shapeKmById: Map<string, number>,
): Map<string, number> {
  // per ogni route → conta uso di ogni shape, prendi quello più usato
  const map = new Map<string, Map<string, number>>();
  for (const t of trips) {
    if (!t.shapeId) continue;
    if (!map.has(t.routeId)) map.set(t.routeId, new Map());
    const inner = map.get(t.routeId)!;
    inner.set(t.shapeId, (inner.get(t.shapeId) ?? 0) + 1);
  }
  const out = new Map<string, number>();
  for (const [routeId, shapeUsage] of map.entries()) {
    let best: { id: string; uses: number } = { id: "", uses: 0 };
    for (const [sid, uses] of shapeUsage.entries()) {
      if (uses > best.uses) best = { id: sid, uses };
    }
    if (best.id && shapeKmById.has(best.id)) {
      out.set(routeId, shapeKmById.get(best.id)!);
    }
  }
  return out;
}

/**
 * Estrae le coords da un GeoJSON LineString o Feature{LineString}.
 */
function extractCoords(geojson: any): number[][] | null {
  if (!geojson) return null;
  if (geojson.type === "LineString" && Array.isArray(geojson.coordinates)) {
    return geojson.coordinates;
  }
  if (geojson.type === "Feature" && geojson.geometry?.type === "LineString") {
    return geojson.geometry.coordinates;
  }
  if (geojson.type === "FeatureCollection" && geojson.features?.[0]?.geometry?.coordinates) {
    return geojson.features[0].geometry.coordinates;
  }
  return null;
}

/* ──────────────────── main analyze ──────────────────── */

export interface AnalyzeOptions {
  paramsOverride?: Partial<EconParams>;
  dayType?: DayType;
  routeIds?: string[] | null;       // null/undefined = tutte
  serviceDate?: string | null;      // YYYYMMDD: bypassa dayType
  categoryFilter?: string[] | null; // filtra per categoria classification (es. ["urbano-ancona"])
}

/** Mapping categoria → tipo tariffa */
function fareTypeForCategory(category: string | null): "urban" | "suburban" | "night" | null {
  if (!category) return null;
  const c = category.toLowerCase();
  if (c.startsWith("urban")) return "urban";
  if (c.startsWith("extra") || c.startsWith("suburban") || c.startsWith("interurban")) return "suburban";
  if (c.startsWith("nott") || c.startsWith("night")) return "night";
  return null;
}

export async function analyzeFeed(
  feedId: string,
  opts: AnalyzeOptions = {},
): Promise<AnalysisResult> {
  const dayType = opts.dayType ?? "weekday";
  const serviceDate = opts.serviceDate || null;
  const routeFilter = opts.routeIds && opts.routeIds.length > 0 ? new Set(opts.routeIds) : null;
  const categoryFilter = opts.categoryFilter && opts.categoryFilter.length > 0
    ? new Set(opts.categoryFilter) : null;
  // Parametri economici
  const [storedParams] = await db
    .select()
    .from(gtfsFeedEconomicParams)
    .where(eq(gtfsFeedEconomicParams.feedId, feedId))
    .limit(1);

  const econ: EconParams = {
    ...DEFAULT_ECON,
    ...(storedParams
      ? {
          fuelConsumptionL100: storedParams.fuelConsumptionL100,
          fuelPriceEurL: storedParams.fuelPriceEurL,
          driverCostEurH: storedParams.driverCostEurH,
          maintenanceEurKm: storedParams.maintenanceEurKm,
          amortizationEurKm: storedParams.amortizationEurKm,
          fareUrbanEurKm: storedParams.fareUrbanEurKm,
          fareSuburbanEurKm: storedParams.fareSuburbanEurKm,
          fareNightEurKm: storedParams.fareNightEurKm,
        }
      : {}),
    ...(opts.paramsOverride ?? {}),
  };

  // 1. Service IDs per dayType o serviceDate
  const { ids: serviceIds, pickedDate } = await pickServiceIds(feedId, dayType, serviceDate);

  // 1b. Classificazioni linee (categoria utente → fareType)
  const classifications = await db
    .select()
    .from(planningRouteClassifications)
    .where(eq(planningRouteClassifications.feedId, feedId));
  const categoryByRoute = new Map<string, string>();
  const fareTypeByRoute = new Map<string, "urban" | "suburban" | "night">();
  for (const c of classifications) {
    categoryByRoute.set(c.routeId, c.category);
    const ft = (c.fareType as any) || fareTypeForCategory(c.category);
    if (ft) fareTypeByRoute.set(c.routeId, ft);
  }

  // 1c. POI del feed (per modello ridership)
  const pois = await db
    .select()
    .from(planningPois)
    .where(eq(planningPois.feedId, feedId));

  // 2. Routes (filtro routeIds + categoria)
  let routes = await db.select().from(gtfsRoutes).where(eq(gtfsRoutes.feedId, feedId));
  if (routeFilter) routes = routes.filter((r) => routeFilter.has(r.routeId));
  if (categoryFilter) {
    routes = routes.filter((r) => {
      const cat = categoryByRoute.get(r.routeId);
      return cat && categoryFilter.has(cat);
    });
  }
  const allowedRouteIds = new Set(routes.map((r) => r.routeId));

  // 3. Trips (filtro service + eventuale filtro routes/categoria)
  const allTrips = await db.select().from(gtfsTrips).where(eq(gtfsTrips.feedId, feedId));
  let activeTrips = allTrips.filter((t) => serviceIds.has(t.serviceId));
  if (routeFilter || categoryFilter) {
    activeTrips = activeTrips.filter((t) => allowedRouteIds.has(t.routeId));
  }

  // 4. Shapes → km lunghezza
  const shapes = await db.select().from(gtfsShapes).where(eq(gtfsShapes.feedId, feedId));
  const shapeKmById = new Map<string, number>();
  for (const s of shapes) {
    const coords = extractCoords(s.geojson);
    if (coords && coords.length >= 2) {
      shapeKmById.set(s.shapeId, lineStringKm(coords));
    }
  }

  // 5. Stops (tutti)
  const stops = await db.select().from(gtfsStops).where(eq(gtfsStops.feedId, feedId));
  const stopById = new Map(stops.map((s) => [s.stopId, s]));

  // 5b. Pre-compute per ogni stop: popolazione locale (300m) + attrazione POI (500m)
  //    Usato dal modello ridership.
  const STOP_POP_RADIUS_KM = 0.3;
  const STOP_POI_RADIUS_KM = 0.5;
  const localPopByStop = new Map<string, number>();
  const localPoiAttrByStop = new Map<string, number>();
  if (stops.length > 0) {
    let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
    for (const s of stops) {
      if (s.stopLat < minLat) minLat = s.stopLat;
      if (s.stopLat > maxLat) maxLat = s.stopLat;
      if (s.stopLon < minLon) minLon = s.stopLon;
      if (s.stopLon > maxLon) maxLon = s.stopLon;
    }
    const sectionsR = await db.execute(sql`
      SELECT centroid_lat, centroid_lng, population
      FROM census_sections
      WHERE centroid_lat BETWEEN ${minLat - 0.05} AND ${maxLat + 0.05}
        AND centroid_lng BETWEEN ${minLon - 0.05} AND ${maxLon + 0.05}
        AND population > 0
    `);
    const sections = (sectionsR.rows as any[]);
    for (const s of stops) {
      let pop = 0;
      for (const sec of sections) {
        if (haversineKm(s.stopLat, s.stopLon, sec.centroid_lat, sec.centroid_lng) <= STOP_POP_RADIUS_KM) {
          pop += sec.population;
        }
      }
      localPopByStop.set(s.stopId, pop);

      let attr = 0;
      for (const p of pois) {
        if (haversineKm(s.stopLat, s.stopLon, p.lat, p.lng) <= STOP_POI_RADIUS_KM) {
          attr += p.weight ?? 1;
        }
      }
      localPoiAttrByStop.set(s.stopId, attr);
    }
  }

  // 5c. Map trip → stops list (per il modello ridership)
  const stopIdsByTrip = new Map<string, string[]>();
  if (activeTrips.length > 0) {
    const tripIdsArr = Array.from(new Set(activeTrips.map((t) => t.tripId)));
    if (tripIdsArr.length > 0) {
      // Query su TUTTO il feed e filtra in memoria → evita query giganti con IN (...)
      // e più veloce per GTFS grandi (una sola scansione indicizzata per feed_id).
      const stRows = await db.execute(sql`
        SELECT trip_id, stop_id FROM gtfs_stop_times
        WHERE feed_id = ${feedId}
      `);
      const tripSet = new Set(tripIdsArr);
      for (const r of (stRows.rows as any[])) {
        if (!tripSet.has(r.trip_id)) continue;
        if (!stopIdsByTrip.has(r.trip_id)) stopIdsByTrip.set(r.trip_id, []);
        stopIdsByTrip.get(r.trip_id)!.push(r.stop_id);
      }
    }
  }

  // 6. Stop times → durate trip (per ore guida) — query aggregata
  const tripDurations = await db.execute(sql`
    SELECT
      trip_id,
      MIN(arrival_time) AS first_t,
      MAX(arrival_time) AS last_t
    FROM gtfs_stop_times
    WHERE feed_id = ${feedId}
    GROUP BY trip_id
  `);
  const durationByTrip = new Map<string, number>(); // trip_id → secondi
  for (const r of (tripDurations.rows as any[])) {
    const a = timeToSeconds(r.first_t);
    const b = timeToSeconds(r.last_t);
    if (a !== null && b !== null && b > a) durationByTrip.set(r.trip_id, b - a);
  }

  // 7. Per-route aggregation
  const routeShapeKm = buildRouteShapeKm(activeTrips, shapeKmById);
  const tripsByRoute = new Map<string, typeof activeTrips>();
  for (const t of activeTrips) {
    if (!tripsByRoute.has(t.routeId)) tripsByRoute.set(t.routeId, []);
    tripsByRoute.get(t.routeId)!.push(t);
  }

  const perRoute: RouteKpi[] = [];
  let totalKm = 0;
  let totalHours = 0;
  let totalTrips = 0;
  let totalCost = 0;
  let totalRevenue = 0;
  let tripsWithoutShape = 0;

  for (const r of routes) {
    const trips = tripsByRoute.get(r.routeId) ?? [];
    if (trips.length === 0) continue;
    const shapeKm = routeShapeKm.get(r.routeId) ?? 0;
    if (shapeKm === 0) tripsWithoutShape += trips.length;

    // ore: somma durate dei trip della linea
    let routeSeconds = 0;
    for (const t of trips) {
      routeSeconds += durationByTrip.get(t.tripId) ?? 0;
    }
    const hoursDay = routeSeconds / 3600;
    const tripsDay = trips.length;
    const kmDay = shapeKm * tripsDay;

    // Service type: prima da classification utente, poi heuristic
    const userCategory = categoryByRoute.get(r.routeId) ?? null;
    const stype = fareTypeByRoute.get(r.routeId)
      ?? detectServiceType(r.routeLongName, trips[0]?.tripHeadsign ?? null);
    const fare = fareForServiceType(econ, stype);

    const costFuelDay = fuelCostPerKm(econ) * kmDay;
    const costMaintDay = econ.maintenanceEurKm * kmDay;
    const costAmortDay = econ.amortizationEurKm * kmDay;
    const costDriverDay = econ.driverCostEurH * hoursDay;
    const costTotalDay = costFuelDay + costMaintDay + costAmortDay + costDriverDay;
    const revenueDay = fare * kmDay;

    // ── Modello ridership (gravity + POI) ──
    // Per ogni stop unico della linea, calcola "potenziale" basato su
    // popolazione locale + attrazione POI; poi modula per frequenza corse.
    const uniqueStopsForRoute = new Set<string>();
    for (const t of trips) {
      const sids = stopIdsByTrip.get(t.tripId) ?? [];
      for (const sid of sids) uniqueStopsForRoute.add(sid);
    }
    let routePopPotential = 0;
    let routePoiPotential = 0;
    for (const sid of uniqueStopsForRoute) {
      routePopPotential += localPopByStop.get(sid) ?? 0;
      routePoiPotential += localPoiAttrByStop.get(sid) ?? 0;
    }
    // Propensione TPL: 0.06 base, sale con la frequenza fino a max 0.14
    const propensione = Math.min(0.14, 0.06 + tripsDay / 1500);
    // Pax stimati = popolazione potenziale × propensione + attrattori POI × moltiplicatore
    // Diviso 2 perché ogni passeggero è contato come "salita" e "discesa" sui suoi 2 stops
    const estimatedPaxDay = Math.round(
      (routePopPotential * propensione + routePoiPotential * 25) / 2 * 1.4
    );
    const paxPerKm = kmDay > 0 ? estimatedPaxDay / kmDay : 0;

    perRoute.push({
      routeId: r.routeId,
      shortName: r.routeShortName,
      longName: r.routeLongName,
      color: r.routeColor,
      serviceType: stype,
      category: userCategory,
      shapeKm,
      tripsDay,
      kmDay,
      hoursDay,
      costFuelDay,
      costMaintDay,
      costAmortDay,
      costDriverDay,
      costTotalDay,
      revenueDay,
      marginDay: revenueDay - costTotalDay,
      estimatedPaxDay,
      paxPerKm,
    });

    totalKm += kmDay;
    totalHours += hoursDay;
    totalTrips += tripsDay;
    totalCost += costTotalDay;
    totalRevenue += revenueDay;
  }

  // 8. Bbox + popolazione coperta
  let bbox: AnalysisResult["bbox"] = null;
  if (stops.length > 0) {
    let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
    for (const s of stops) {
      if (s.stopLat < minLat) minLat = s.stopLat;
      if (s.stopLat > maxLat) maxLat = s.stopLat;
      if (s.stopLon < minLon) minLon = s.stopLon;
      if (s.stopLon > maxLon) maxLon = s.stopLon;
    }
    bbox = { minLat, maxLat, minLon, maxLon };
  }

  let populationCovered = 0;
  let populationTotal = 0;
  if (bbox) {
    // Census sections nel bbox (con piccolo margine)
    const sections = await db.execute(sql`
      SELECT id, centroid_lat, centroid_lng, population
      FROM census_sections
      WHERE centroid_lat BETWEEN ${bbox.minLat - 0.05} AND ${bbox.maxLat + 0.05}
        AND centroid_lng BETWEEN ${bbox.minLon - 0.05} AND ${bbox.maxLon + 0.05}
        AND population > 0
    `);
    const COVER_RADIUS_KM = 0.3;  // 300 m
    for (const s of (sections.rows as any[])) {
      populationTotal += s.population;
      // sezione coperta se ALMENO una fermata entro 300m dal centroide
      let covered = false;
      for (const stop of stops) {
        if (haversineKm(stop.stopLat, stop.stopLon, s.centroid_lat, s.centroid_lng) <= COVER_RADIUS_KM) {
          covered = true;
          break;
        }
      }
      if (covered) populationCovered += s.population;
    }
  }

  // 9. Anomalie
  const stopsWithTrips = new Set<string>();
  const stRows = await db.execute(sql`
    SELECT DISTINCT stop_id FROM gtfs_stop_times WHERE feed_id = ${feedId}
  `);
  for (const r of (stRows.rows as any[])) stopsWithTrips.add(r.stop_id);
  const stopsOrphan = stops.filter((s) => !stopsWithTrips.has(s.stopId)).length;

  const routesWithTrips = new Set(activeTrips.map((t) => t.routeId));
  const routesWithoutTrips = routes.filter((r) => !routesWithTrips.has(r.routeId)).length;

  // 9b. Distribuzione oraria + top stops (limitato ai trip attivi)
  const activeTripIds = new Set(activeTrips.map((t) => t.tripId));
  const hourlyDistribution = new Array(24).fill(0);
  const stopUsage = new Map<string, number>();
  if (activeTripIds.size > 0) {
    // Prima fermata di ogni trip → ora di partenza
    const firstStops = await db.execute(sql`
      SELECT trip_id, MIN(departure_time) AS dep
      FROM gtfs_stop_times
      WHERE feed_id = ${feedId}
      GROUP BY trip_id
    `);
    for (const r of (firstStops.rows as any[])) {
      if (!activeTripIds.has(r.trip_id)) continue;
      const sec = timeToSeconds(r.dep);
      if (sec === null) continue;
      const h = Math.floor((sec / 3600) % 24);
      hourlyDistribution[h]++;
    }
    // Conteggio passaggi per stop
    const stopPasses = await db.execute(sql`
      SELECT stop_id, COUNT(*)::int AS n
      FROM gtfs_stop_times
      WHERE feed_id = ${feedId}
      GROUP BY stop_id
    `);
    for (const r of (stopPasses.rows as any[])) {
      stopUsage.set(r.stop_id, r.n);
    }
  }
  void stopById;
  const topStops = Array.from(stopUsage.entries())
    .map(([stopId, trips]) => {
      const s = stops.find((x) => x.stopId === stopId);
      if (!s) return null;
      return { stopId, stopName: s.stopName, lat: s.stopLat, lon: s.stopLon, trips };
    })
    .filter((x): x is { stopId: string; stopName: string; lat: number; lon: number; trips: number } => x !== null)
    .sort((a, b) => b.trips - a.trips)
    .slice(0, 20);

  // Aggregazione categorie per il riepilogo
  const catAgg = new Map<string, { routeCount: number; kmDay: number; revenueDay: number }>();
  for (const r of perRoute) {
    const key = r.category || "(non classificata)";
    const cur = catAgg.get(key) ?? { routeCount: 0, kmDay: 0, revenueDay: 0 };
    cur.routeCount++;
    cur.kmDay += r.kmDay;
    cur.revenueDay += r.revenueDay;
    catAgg.set(key, cur);
  }
  const categories = Array.from(catAgg.entries())
    .map(([category, v]) => ({ category, ...v }))
    .sort((a, b) => b.kmDay - a.kmDay);

  // Ridership totale + KPI derivati
  const totalPaxDay = perRoute.reduce((s, r) => s + r.estimatedPaxDay, 0);
  const ridership = {
    estimatedPaxDay: totalPaxDay,
    revenuePerPax: totalPaxDay > 0 ? totalRevenue / totalPaxDay : 0,
    costPerPax: totalPaxDay > 0 ? totalCost / totalPaxDay : 0,
    methodology: `Modello gravity: per ogni fermata sommiamo popolazione entro 300m e attrattività POI entro 500m, modulato per propensione TPL (6-14% in base alla frequenza). ${pois.length} POI configurati.`,
    poisConsidered: pois.length,
  };

  const result: AnalysisResult = {
    totalKmDay: totalKm,
    totalHoursDay: totalHours,
    totalTripsDay: totalTrips,
    activeRoutes: perRoute.length,
    activeStops: stops.length - stopsOrphan,
    bbox,
    populationCovered,
    populationTotal,
    totalCostDay: totalCost,
    totalRevenueDay: totalRevenue,
    marginDay: totalRevenue - totalCost,
    perRoute: perRoute.sort((a, b) => b.kmDay - a.kmDay),
    anomalies: {
      tripsWithoutShape,
      stopsOrphan,
      routesWithoutTrips,
    },
    hourlyDistribution,
    topStops,
    categories,
    ridership,
    filters: {
      dayType,
      routeIds: routeFilter ? Array.from(routeFilter) : null,
      pickedDate,
      serviceIdsCount: serviceIds.size,
      serviceDate,
      categoryFilter: categoryFilter ? Array.from(categoryFilter) : null,
    },
  };

  // 10. Persist (solo se analisi "full" senza filtri attivi)
  if (!routeFilter && !categoryFilter && !serviceDate) {
    await db.delete(gtfsFeedAnalysis).where(eq(gtfsFeedAnalysis.feedId, feedId));
    await db.insert(gtfsFeedAnalysis).values({
      feedId,
      totalKmDay: result.totalKmDay,
      totalHoursDay: result.totalHoursDay,
      totalTripsDay: result.totalTripsDay,
      activeRoutes: result.activeRoutes,
      activeStops: result.activeStops,
      bboxMinLat: bbox?.minLat ?? null,
      bboxMaxLat: bbox?.maxLat ?? null,
      bboxMinLon: bbox?.minLon ?? null,
      bboxMaxLon: bbox?.maxLon ?? null,
      populationCovered: result.populationCovered,
      populationTotal: result.populationTotal,
      totalCostDay: result.totalCostDay,
      totalRevenueDay: result.totalRevenueDay,
      marginDay: result.marginDay,
      perRoute: result.perRoute as any,
      anomalies: result.anomalies as any,
    });
  }

  return result;
}

/** Carica/crea i parametri economici per un feed. */
export async function getOrCreateEconomicParams(feedId: string) {
  const [existing] = await db
    .select()
    .from(gtfsFeedEconomicParams)
    .where(eq(gtfsFeedEconomicParams.feedId, feedId))
    .limit(1);
  if (existing) return existing;
  const [created] = await db
    .insert(gtfsFeedEconomicParams)
    .values({ feedId })
    .returning();
  return created;
}
