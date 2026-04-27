/**
 * INTERMODAL OPTIMIZER
 * ─────────────────────────────────────────────────────────────────
 * Step di post-ottimizzazione che, dati i turni macchina prodotti
 * dallo scheduler CP-SAT, analizza l'intermodalità con treni/navi/aerei:
 *
 *  1. Scopre AUTOMATICAMENTE gli hub (railway/port/airport/bus_terminal)
 *     dentro il bounding box dei capolinea trip optimizzati.
 *  2. Sincronizza (opzionale) gli orari treni reali da ViaggiaTreno
 *     per gli hub railway scoperti.
 *  3. Per ogni capolinea trip vicino ad un hub calcola le
 *     COINCIDENZE con treni in partenza/arrivo, considerando il
 *     tempo a piedi (camminamento + binario).
 *  4. Genera ADVISORIES operativi ("anticipa la corsa X di N
 *     minuti per agganciare il treno per Roma delle 17:35").
 *
 * Endpoint:
 *   POST /api/intermodal-optimizer/analyze
 *     body: {
 *       shifts: VehicleShift[],
 *       date?: "YYYYMMDD" | "YYYY-MM-DD",     // default: oggi
 *       includeExtraurban?: boolean,           // default: true
 *       syncSchedules?: boolean,               // default: false
 *       walkSpeedKmh?: number,                 // default: 4.5
 *       maxWalkMin?: number,                   // default: 15
 *       windowAfterArrivalMin?: number,        // default: 45
 *       windowBeforeDepartureMin?: number,     // default: 30
 *     }
 */

import { Router, type IRouter } from "express";
import {
  discoverHubs,
  fetchTrainScheduleFromViaggiaTreno,
  dynamicHubSchedules,
  type DiscoveredHub,
} from "./intermodal";
import { INTERMODAL_HUBS } from "./coincidence-zones";
import { haversineKm, timeToMinutes } from "../lib/geo-utils";
import { db } from "@workspace/db";
import { coincidenceZones, coincidenceZoneStops, gtfsStops, gtfsStopTimes, gtfsTrips, gtfsRoutes, gtfsCalendar, gtfsCalendarDates, pointsOfInterest } from "@workspace/db/schema";
import { sql, inArray, eq } from "drizzle-orm";

const router: IRouter = Router();

// ──────────────────────────────────────────────────────────────
// Tipi pubblici (compatibili con VehicleShift di service-program)
// ──────────────────────────────────────────────────────────────
interface ShiftTripEntryIn {
  type: "trip" | "deadhead" | "depot";
  tripId: string;
  routeId: string;
  routeName?: string;
  departureTime?: string;
  arrivalTime?: string;
  departureMin: number;
  arrivalMin: number;
  firstStopName?: string;
  lastStopName?: string;
  // Coordinate opzionali — se non presenti, le risolveremo dal trip a livello di servizio
  firstStopLat?: number;
  firstStopLon?: number;
  lastStopLat?: number;
  lastStopLon?: number;
}
interface VehicleShiftIn {
  vehicleId: string;
  vehicleType?: string;
  category?: string;
  trips: ShiftTripEntryIn[];
}

interface CoincidenceMatch {
  shiftId: string;
  vehicleType?: string;
  tripId: string;
  routeId: string;
  routeName?: string;
  hubId: string;
  hubName: string;
  hubType: string;
  /** "rail" | "air" | "port" | "bus" — usato per ordinamento priorità */
  priorityClass?: "rail" | "air" | "port" | "bus_terminal" | "bus_other";
  mode: "arrive_at_hub" | "depart_from_hub"; // bus arriva all'hub / bus parte dall'hub
  busTime: string;                            // HH:MM
  busTimeMin: number;
  trainTime: string;
  trainTimeMin: number;
  trainLabel: string;                         // "Roma (IC/FR)" etc
  walkMin: number;
  bufferMin: number;
  status: "optimal" | "tight" | "long" | "missed";
}

interface Advisory {
  id: string;
  severity: "info" | "warning" | "critical";
  hubId: string;
  hubName: string;
  shiftId?: string;
  tripId?: string;
  title: string;
  description: string;
  suggestion: string;
  /** Modifica orario proposta: positivo = posticipa, negativo = anticipa */
  proposedShiftMin?: number;
  /** Tipo di modifica: spostamento partenza, arrivo, o nuova corsa */
  changeType?: "shift_departure" | "shift_arrival" | "add_trip" | "none";
  /** Orario originale e proposto (HH:MM) */
  originalTime?: string;
  proposedTime?: string;
}

interface ProposedChange {
  shiftId: string;
  tripId: string;
  routeName?: string;
  hubName: string;
  changeType: "shift_departure" | "shift_arrival" | "add_trip";
  shiftMin: number;        // segno: + posticipa, - anticipa
  originalTime: string;
  proposedTime: string;
  reason: string;
  severity: "info" | "warning" | "critical";
}

interface AnalyzeResponse {
  bbox: { minLat: number; maxLat: number; minLng: number; maxLng: number } | null;
  date: string;
  dayOfWeek: number; // 0=Lun .. 6=Dom
  hubs: HubWithPois[];
  hubsAnalyzed: number;
  hubsDiscarded: number;
  /** Fonte degli hub: "zones" = coincidence-zones curate dall'utente, "auto" = scoperta automatica GTFS */
  hubSource: "zones" | "auto";
  schedulesSynced: number;
  coincidences: CoincidenceMatch[];
  advisories: Advisory[];
  proposedChanges: ProposedChange[];
  metrics: {
    totalTripsAnalyzed: number;
    tripsNearHub: number;
    optimalConnections: number;
    tightConnections: number;
    longWaits: number;
    missedConnections: number;
    busExtraConnections: number;
    poisReached: number;
  };
}

interface HubPoi {
  id: string;
  name: string | null;
  category: string;
  lat: number;
  lng: number;
  distM: number;
  walkMin: number;
}
type HubWithPois = DiscoveredHub & {
  pois?: HubPoi[];
  /** Distanza dall'endpoint trip più vicino (m) */
  nearestTripM?: number;
};

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────

/** Distanza fra due punti in metri (haversineKm * 1000). */
function distanceMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  return haversineKm(lat1, lon1, lat2, lon2) * 1000;
}

/** Tempo a piedi in minuti = (km / kmh) * 60 + tempo binario hub. */
function walkMinutesTo(distM: number, walkSpeedKmh: number, platformWalkMin: number): number {
  const km = distM / 1000;
  return (km / walkSpeedKmh) * 60 + platformWalkMin;
}

/** Day of week: 0=Lunedì .. 6=Domenica (Italian style) dal Date. */
function dayOfWeekIT(d: Date): number {
  const js = d.getDay();
  return js === 0 ? 6 : js - 1;
}

/** Parsing date input flessibile. */
function parseDateInput(s?: string): Date {
  if (!s) return new Date();
  const ymd = s.replace(/-/g, "");
  if (/^\d{8}$/.test(ymd)) {
    const yyyy = +ymd.slice(0, 4);
    const mm = +ymd.slice(4, 6) - 1;
    const dd = +ymd.slice(6, 8);
    return new Date(yyyy, mm, dd);
  }
  return new Date(s);
}

/** Status della coincidenza in base al buffer di attesa */
function classifyBuffer(bufferMin: number): CoincidenceMatch["status"] {
  if (bufferMin < 0) return "missed";
  if (bufferMin < 3) return "tight";
  if (bufferMin > 20) return "long";
  return "optimal";
}

/** Mappa il tipo hub in priorityClass: rail > air > port > bus_terminal */
function priorityFromHub(t: string): CoincidenceMatch["priorityClass"] {
  if (t === "railway") return "rail";
  if (t === "airport") return "air";
  if (t === "port") return "port";
  return "bus_terminal";
}

/** Estrae lista PARTENZE/ARRIVI (per giorno) dall'hub */
function getDayDepartures(hub: DiscoveredHub, dow: number): { destination: string; times: string[] }[] {
  if (hub.weeklyDepartures && hub.weeklyDepartures[dow]?.length) return hub.weeklyDepartures[dow];
  return hub.typicalDepartures || [];
}
function getDayArrivals(hub: DiscoveredHub, dow: number): { origin: string; times: string[] }[] {
  if (hub.weeklyArrivals && hub.weeklyArrivals[dow]?.length) return hub.weeklyArrivals[dow];
  return hub.typicalArrivals || [];
}

/**
 * Costruisce orari di arrivi/partenze per un hub "bus-bus" / "park-ride" leggendo
 * DIRETTAMENTE dal GTFS le corse che passano per le fermate della zona, attive nella
 * data richiesta. Raggruppa per route + headsign, deduplica orari, ordina.
 */
async function buildBusHubSchedulesFromGtfs(
  stopIds: string[],
  yyyymmdd: string,
  dowField: string,
): Promise<{
  arrivals: { label: string; times: string[] }[];
  departures: { label: string; times: string[] }[];
}> {
  if (stopIds.length === 0) return { arrivals: [], departures: [] };

  // 1) Service attivi per la data
  const calRows = await db.select().from(gtfsCalendar);
  const exRows = await db.select().from(gtfsCalendarDates);
  const exMap = new Map<string, Set<string>>();
  for (const e of exRows) {
    if (e.date !== yyyymmdd) continue;
    if (!exMap.has(e.serviceId)) exMap.set(e.serviceId, new Set());
    exMap.get(e.serviceId)!.add(String(e.exceptionType));
  }
  const activeServices = new Set<string>();
  for (const c of calRows) {
    const inRange = c.startDate <= yyyymmdd && c.endDate >= yyyymmdd;
    const dayActive = (c as any)[dowField] === 1;
    const ex = exMap.get(c.serviceId);
    if ((inRange && dayActive && !ex?.has("2")) || ex?.has("1")) activeServices.add(c.serviceId);
  }
  for (const [sid, set] of exMap) if (set.has("1")) activeServices.add(sid);

  // 2) stop_times per le fermate della zona
  type StRow = { tripId: string; stopId: string; arrivalTime: string; departureTime: string };
  const stRows: StRow[] = [];
  for (let i = 0; i < stopIds.length; i += 500) {
    const batch = stopIds.slice(i, i + 500);
    const rows = await db.select({
      tripId: gtfsStopTimes.tripId,
      stopId: gtfsStopTimes.stopId,
      arrivalTime: gtfsStopTimes.arrivalTime,
      departureTime: gtfsStopTimes.departureTime,
    }).from(gtfsStopTimes).where(inArray(gtfsStopTimes.stopId, batch));
    stRows.push(...rows.map(r => ({
      tripId: r.tripId, stopId: r.stopId,
      arrivalTime: r.arrivalTime || "", departureTime: r.departureTime || "",
    })));
  }
  if (stRows.length === 0) return { arrivals: [], departures: [] };

  // 3) Trip + route
  const tripIds = [...new Set(stRows.map(r => r.tripId))];
  const tripInfo = new Map<string, { routeId: string; serviceId: string; headsign: string | null }>();
  for (let i = 0; i < tripIds.length; i += 500) {
    const batch = tripIds.slice(i, i + 500);
    const rows = await db.select({
      tripId: gtfsTrips.tripId, routeId: gtfsTrips.routeId,
      serviceId: gtfsTrips.serviceId, headsign: gtfsTrips.tripHeadsign,
    }).from(gtfsTrips).where(inArray(gtfsTrips.tripId, batch));
    for (const r of rows) tripInfo.set(r.tripId, { routeId: r.routeId, serviceId: r.serviceId, headsign: r.headsign });
  }
  const routeIds = [...new Set([...tripInfo.values()].map(t => t.routeId))];
  const routeInfo = new Map<string, { shortName: string | null; longName: string | null }>();
  if (routeIds.length > 0) {
    const rows = await db.select({
      routeId: gtfsRoutes.routeId, shortName: gtfsRoutes.routeShortName, longName: gtfsRoutes.routeLongName,
    }).from(gtfsRoutes).where(inArray(gtfsRoutes.routeId, routeIds));
    for (const r of rows) routeInfo.set(r.routeId, { shortName: r.shortName, longName: r.longName });
  }

  // 4) Aggrega per "label" (route + headsign). arrivalTime -> arrivi, departureTime -> partenze
  const arrMap = new Map<string, Set<string>>();
  const depMap = new Map<string, Set<string>>();
  const toHHMM = (s: string) => {
    const m = /^(\d{1,2}):(\d{2})/.exec(s);
    if (!m) return null;
    const h = +m[1] % 24;
    return `${String(h).padStart(2, "0")}:${m[2]}`;
  };

  for (const st of stRows) {
    const ti = tripInfo.get(st.tripId);
    if (!ti) continue;
    if (activeServices.size > 0 && !activeServices.has(ti.serviceId)) continue;
    const ri = routeInfo.get(ti.routeId);
    const routeLabel = (ri?.shortName || ri?.longName || ti.routeId).slice(0, 40);
    const labelDep = `${routeLabel}${ti.headsign ? ` → ${ti.headsign}` : ""}`;
    const labelArr = `${routeLabel}${ti.headsign ? ` da ${ti.headsign}` : ""}`;
    const dep = toHHMM(st.departureTime);
    const arr = toHHMM(st.arrivalTime);
    if (dep) {
      if (!depMap.has(labelDep)) depMap.set(labelDep, new Set());
      depMap.get(labelDep)!.add(dep);
    }
    if (arr) {
      if (!arrMap.has(labelArr)) arrMap.set(labelArr, new Set());
      arrMap.get(labelArr)!.add(arr);
    }
  }

  const toList = (m: Map<string, Set<string>>) =>
    [...m.entries()]
      .map(([label, set]) => ({ label, times: [...set].sort() }))
      .filter(r => r.times.length > 0)
      .sort((a, b) => b.times.length - a.times.length)
      .slice(0, 40); // top 40 linee/destinazioni

  return { arrivals: toList(arrMap), departures: toList(depMap) };
}

// ──────────────────────────────────────────────────────────────
// POST /api/intermodal-optimizer/analyze
// ──────────────────────────────────────────────────────────────
router.post("/intermodal-optimizer/analyze", async (req, res) => {
  try {
    const body = req.body as {
      shifts?: VehicleShiftIn[];
      date?: string;
      includeExtraurban?: boolean;
      syncSchedules?: boolean;
      walkSpeedKmh?: number;
      maxWalkMin?: number;
      windowAfterArrivalMin?: number;
      windowBeforeDepartureMin?: number;
      maxHubDistM?: number;
    };

    const shifts = Array.isArray(body.shifts) ? body.shifts : [];
    if (shifts.length === 0) {
      res.status(400).json({ error: "Parametro 'shifts' obbligatorio (array di VehicleShift)" });
      return;
    }

    const walkSpeedKmh = body.walkSpeedKmh ?? 4.5;
    const maxWalkMin = body.maxWalkMin ?? 15;
    const winAfterArr = body.windowAfterArrivalMin ?? 45;
    const winBeforeDep = body.windowBeforeDepartureMin ?? 30;
    const maxHubDistM = body.maxHubDistM ?? 1200;
    const includeExtraurban = body.includeExtraurban !== false;
    // Sync automatico di default: se chi chiama non specifica, sincronizziamo gli orari
    // (ViaggiaTreno per railway, GTFS interno per bus-bus/park-ride) e persistiamo su zone.schedules.
    const syncSchedules = body.syncSchedules !== false;
    /** Distanza max (m) tra hub e capolinea trip più vicino: scarta hub fuori area servita */
    const maxHubFromTripM = (body as any).maxHubFromTripM ?? 3500;
    /** Includi coincidenze con altre linee bus GTFS (non nei turni) */
    const includeOtherBusRoutes = (body as any).includeOtherBusRoutes !== false;
    /** Includi POI vicino agli hub (mostra dove vanno le persone) */
    const includePois = (body as any).includePois !== false;
    /** Distanza max (m) per POI da hub */
    const maxPoiDistM = (body as any).maxPoiDistM ?? 1500;

    const dateObj = parseDateInput(body.date);
    const dow = dayOfWeekIT(dateObj);

    // 0) RISOLUZIONE COORDINATE — molti caller non passano firstStopLat/Lon perché
    //    nel modello frontend ShiftTripEntry ci sono solo i nomi delle fermate.
    //    Le risolviamo qui dal GTFS via tripId → primo/ultimo stop_times → stops.
    {
      const missingTripIds = new Set<string>();
      for (const sh of shifts) for (const e of sh.trips || []) {
        if (e.type !== "trip") continue;
        const ok = typeof e.firstStopLat === "number" && typeof e.firstStopLon === "number"
                && typeof e.lastStopLat === "number" && typeof e.lastStopLon === "number";
        if (!ok && e.tripId) missingTripIds.add(e.tripId);
      }
      if (missingTripIds.size > 0) {
        const tripIdArr = [...missingTripIds];
        // Recupera per ogni trip first/last stop_id (basandoci su stop_sequence min/max)
        type TripEnds = { tripId: string; firstStopId: string | null; lastStopId: string | null };
        const tripEnds = new Map<string, TripEnds>();
        for (let i = 0; i < tripIdArr.length; i += 500) {
          const batch = tripIdArr.slice(i, i + 500);
          const rows = await db.execute(sql`
            SELECT trip_id,
                   (array_agg(stop_id ORDER BY stop_sequence ASC))[1]  AS first_stop_id,
                   (array_agg(stop_id ORDER BY stop_sequence DESC))[1] AS last_stop_id
            FROM gtfs_stop_times
            WHERE trip_id IN (${sql.join(batch.map(id => sql`${id}`), sql`, `)})
            GROUP BY trip_id
          `);
          for (const r of (rows as any).rows ?? []) {
            tripEnds.set(r.trip_id, {
              tripId: r.trip_id,
              firstStopId: r.first_stop_id ?? null,
              lastStopId: r.last_stop_id ?? null,
            });
          }
        }
        // Risolvi le coords degli stop usati
        const stopIdSet = new Set<string>();
        for (const t of tripEnds.values()) {
          if (t.firstStopId) stopIdSet.add(t.firstStopId);
          if (t.lastStopId) stopIdSet.add(t.lastStopId);
        }
        const stopCoord = new Map<string, { lat: number; lng: number }>();
        if (stopIdSet.size > 0) {
          const stopArr = [...stopIdSet];
          for (let i = 0; i < stopArr.length; i += 1000) {
            const batch = stopArr.slice(i, i + 1000);
            const rows = await db.select({
              stopId: gtfsStops.stopId,
              lat: gtfsStops.stopLat,
              lng: gtfsStops.stopLon,
            }).from(gtfsStops).where(inArray(gtfsStops.stopId, batch));
            for (const r of rows) {
              const la = typeof r.lat === "string" ? parseFloat(r.lat) : (r.lat as number);
              const lo = typeof r.lng === "string" ? parseFloat(r.lng) : (r.lng as number);
              if (Number.isFinite(la) && Number.isFinite(lo)) stopCoord.set(r.stopId, { lat: la, lng: lo });
            }
          }
        }
        // Inietta nelle entries
        let injected = 0;
        for (const sh of shifts) for (const e of sh.trips || []) {
          if (e.type !== "trip" || !e.tripId) continue;
          const ends = tripEnds.get(e.tripId);
          if (!ends) continue;
          if (typeof e.firstStopLat !== "number" && ends.firstStopId) {
            const c = stopCoord.get(ends.firstStopId);
            if (c) { e.firstStopLat = c.lat; e.firstStopLon = c.lng; injected++; }
          }
          if (typeof e.lastStopLat !== "number" && ends.lastStopId) {
            const c = stopCoord.get(ends.lastStopId);
            if (c) { e.lastStopLat = c.lat; e.lastStopLon = c.lng; injected++; }
          }
        }
        req.log.info(`[intermodal-opt] auto-resolved coords for ${injected} stop endpoints from GTFS`);
      }
    }

    // 1) Calcola bounding box dei capolinea (only trip entries)
    let minLat = +Infinity, maxLat = -Infinity, minLng = +Infinity, maxLng = -Infinity;
    let hasCoords = false;
    let totalTrips = 0;
    /** Punti di tutti i capolinea (lat,lng) per il filtro di prossimità degli hub */
    const tripEndpoints: Array<[number, number]> = [];
    for (const sh of shifts) {
      for (const e of sh.trips || []) {
        if (e.type !== "trip") continue;
        totalTrips++;
        const pts = [
          [e.firstStopLat, e.firstStopLon],
          [e.lastStopLat, e.lastStopLon],
        ];
        for (const [la, lo] of pts) {
          if (typeof la === "number" && typeof lo === "number" && Number.isFinite(la) && Number.isFinite(lo)) {
            hasCoords = true;
            tripEndpoints.push([la, lo]);
            if (la < minLat) minLat = la;
            if (la > maxLat) maxLat = la;
            if (lo < minLng) minLng = lo;
            if (lo > maxLng) maxLng = lo;
          }
        }
      }
    }

    let bbox: { minLat: number; maxLat: number; minLng: number; maxLng: number } | null = null;
    if (hasCoords) {
      // Buffer ~1.5km attorno al bbox (era 3km, troppo ampio: prendeva città vicine).
      // Il filtro fine viene fatto dopo per prossimità ai SINGOLI capolinea.
      const BUF_LAT = 0.014;  // ~1.5 km
      const BUF_LNG = 0.018;  // ~1.5 km a 43° N
      const extra = includeExtraurban ? 1 : 0.5;
      bbox = {
        minLat: minLat - BUF_LAT * extra,
        maxLat: maxLat + BUF_LAT * extra,
        minLng: minLng - BUF_LNG * extra,
        maxLng: maxLng + BUF_LNG * extra,
      };
    }

    req.log.info(
      `[intermodal-opt] shifts=${shifts.length} trips=${totalTrips} bbox=${
        bbox ? `${bbox.minLat.toFixed(3)},${bbox.minLng.toFixed(3)}-${bbox.maxLat.toFixed(3)},${bbox.maxLng.toFixed(3)}` : "none"
      } dow=${dow} sync=${syncSchedules}`,
    );

    // 2) HUB SOURCE — usa le COINCIDENCE ZONES create dall'utente come fonte primaria.
    //    Ogni zona ha già: hub (lat/lng/type), fermate bus pre-mappate, raggio.
    //    Fallback a discoverHubs() solo se non esistono zone create.
    /** Fermate bus della zona (riusate per le coincidenze bus-bus) */
    const stopsByHub = new Map<string, Array<{ stopId: string; stopName: string; lat: number; lng: number; walkMinFromHub: number }>>();
    /** Meta per persistere gli orari: hub.id → { zoneId, originalHubType, hasCustomSchedules } */
    const hubMeta = new Map<string, { zoneId: string; originalHubType: string; hasCustomSchedules: boolean }>();
    let usedZones = false;

    let hubsRaw: DiscoveredHub[] = [];
    try {
      const zones = await db.select().from(coincidenceZones);
      if (zones.length > 0) {
        usedZones = true;
        const zoneIds = zones.map(z => z.id);
        const zoneStops = zoneIds.length > 0
          ? await db.select().from(coincidenceZoneStops).where(inArray(coincidenceZoneStops.zoneId, zoneIds))
          : [];

        for (const z of zones) {
          // Mappiamo park-ride → bus_terminal (compatibilità tipi)
          const hubType: DiscoveredHub["type"] =
            (z.hubType === "railway" || z.hubType === "port" || z.hubType === "airport" || z.hubType === "bus_terminal")
              ? z.hubType
              : "bus_terminal";

          // ORARI: priorità a quelli salvati sulla zona (z.schedules), fallback al preset INTERMODAL_HUBS
          const preset = INTERMODAL_HUBS.find(h => h.id === z.hubId);
          const customSched = (z as any).schedules as
            | { arrivals?: { label: string; times: string[] }[]; departures?: { label: string; times: string[] }[] }
            | null
            | undefined;
          const customArr = (customSched?.arrivals ?? [])
            .filter(a => a && Array.isArray(a.times) && a.times.length > 0)
            .map(a => ({ origin: a.label || "—", times: a.times }));
          const customDep = (customSched?.departures ?? [])
            .filter(a => a && Array.isArray(a.times) && a.times.length > 0)
            .map(a => ({ destination: a.label || "—", times: a.times }));
          const typicalArrivals = customArr.length > 0 ? customArr : (preset?.typicalArrivals ?? []);
          const typicalDepartures = customDep.length > 0 ? customDep : (preset?.typicalDepartures ?? []);

          const hub: DiscoveredHub = {
            id: z.hubId,
            name: z.hubName,
            type: hubType,
            lat: z.hubLat,
            lng: z.hubLng,
            gtfsStopIds: [],
            description: z.notes ?? `Zona di coincidenza "${z.name}"`,
            platformWalkMinutes: z.walkMinutes ?? 2,
            typicalArrivals,
            typicalDepartures,
            source: "curated" as const,
          };
          hubsRaw.push(hub);

          // Traccia meta per persist: quale zoneId, tipo originale, se ha già custom
          hubMeta.set(z.hubId, {
            zoneId: z.id,
            originalHubType: z.hubType,
            hasCustomSchedules: customArr.length > 0 || customDep.length > 0,
          });

          // Memorizziamo le fermate bus della zona
          const sList = zoneStops
            .filter(s => s.zoneId === z.id)
            .map(s => ({
              stopId: s.gtfsStopId,
              stopName: s.stopName,
              lat: s.stopLat,
              lng: s.stopLon,
              walkMinFromHub: s.walkMinFromHub ?? z.walkMinutes ?? 2,
            }));
          stopsByHub.set(z.hubId, sList);
        }
        req.log.info(`[intermodal-opt] using ${zones.length} coincidence zones (curated by user)`);
      }
    } catch (e) {
      req.log.warn(`[intermodal-opt] failed to read coincidence_zones: ${(e as Error).message}, falling back to auto-discovery`);
    }

    if (!usedZones) {
      hubsRaw = await discoverHubs({ bbox, includeCurated: true });
      req.log.info(`[intermodal-opt] no coincidence zones found, auto-discovered ${hubsRaw.length} hubs`);
    }

    // 2bis) Filtro hub per prossimità ai capolinea (no hub fuori area servita)
    //      Se le zone sono curate dall'utente le teniamo TUTTE (l'utente sa cosa serve).
    //      Solo per discovery automatica filtriamo per distanza.
    let hubsDiscarded = 0;
    const hubs: HubWithPois[] = [];
    if (tripEndpoints.length === 0 || usedZones) {
      for (const h of hubsRaw) {
        let nearest = Infinity;
        for (const [la, lo] of tripEndpoints) {
          const d = haversineKm(h.lat, h.lng, la, lo) * 1000;
          if (d < nearest) nearest = d;
        }
        hubs.push({ ...(h as HubWithPois), nearestTripM: tripEndpoints.length > 0 ? Math.round(nearest) : undefined });
      }
    } else {
      for (const h of hubsRaw) {
        let nearest = Infinity;
        for (const [la, lo] of tripEndpoints) {
          const d = haversineKm(h.lat, h.lng, la, lo) * 1000;
          if (d < nearest) nearest = d;
          if (nearest < 50) break;
        }
        if (nearest > maxHubFromTripM) {
          hubsDiscarded++;
          continue;
        }
        hubs.push({ ...(h as HubWithPois), nearestTripM: Math.round(nearest) });
      }
    }
    // Ordina: railway prima, poi airport, poi port, poi bus_terminal; a parità più vicino prima.
    const TYPE_RANK: Record<string, number> = { railway: 0, airport: 1, port: 2, bus_terminal: 3 };
    hubs.sort((a, b) => {
      const ra = TYPE_RANK[a.type] ?? 9;
      const rb = TYPE_RANK[b.type] ?? 9;
      if (ra !== rb) return ra - rb;
      return (a.nearestTripM ?? 0) - (b.nearestTripM ?? 0);
    });
    req.log.info(`[intermodal-opt] kept ${hubs.length} hubs (discarded ${hubsDiscarded} fuori area, source=${usedZones ? "zones" : "auto"})`);

    // 3) Sync orari AUTOMATICO — per ciascun hub che NON ha schedules custom:
    //    • railway  → ViaggiaTreno (RFI)
    //    • bus-bus  → costruiti da GTFS (corse passanti per le fermate della zona)
    //    • park-ride → costruiti da GTFS
    //    • port/airport → lasciamo al preset (niente provider generico affidabile)
    //    Gli orari ottenuti vengono PERSISTITI su zone.schedules per riuso futuro.
    let synced = 0;
    if (syncSchedules) {
      const yyyymmdd = `${dateObj.getFullYear()}${String(dateObj.getMonth() + 1).padStart(2, "0")}${String(dateObj.getDate()).padStart(2, "0")}`;
      const dowFieldByJs = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
      const dowField = dowFieldByJs[dateObj.getDay()];

      for (const h of hubs) {
        const meta = hubMeta.get(h.id);
        // Salta se la zona ha già orari custom
        if (meta?.hasCustomSchedules) continue;

        // Salta se la cache in-memory ha già gli orari validi
        if (dynamicHubSchedules.has(h.id)) continue;

        let arrivalsSaved: { label: string; times: string[] }[] = [];
        let departuresSaved: { label: string; times: string[] }[] = [];
        let srcTag = "";

        try {
          if (h.type === "railway") {
            const sched = await fetchTrainScheduleFromViaggiaTreno(h.name, null);
            if (sched) {
              dynamicHubSchedules.set(h.id, sched);
              h.typicalArrivals = sched.typicalArrivals;
              h.typicalDepartures = sched.typicalDepartures;
              if (sched.weeklyDepartures) h.weeklyDepartures = sched.weeklyDepartures;
              if (sched.weeklyArrivals) h.weeklyArrivals = sched.weeklyArrivals;
              if (sched.weekStart) h.weekStart = sched.weekStart;
              // Persist: usiamo le liste tipiche (pre-indicizzate per la data richiesta)
              arrivalsSaved = (sched.typicalArrivals || []).map(a => ({ label: a.origin, times: a.times }));
              departuresSaved = (sched.typicalDepartures || []).map(a => ({ label: a.destination, times: a.times }));
              srcTag = "viaggiatreno";
              synced++;
            }
          } else if (meta && (meta.originalHubType === "bus-bus" || meta.originalHubType === "park-ride" || h.type === "bus_terminal")) {
            // Costruisci da GTFS usando le fermate già curate sulla zona
            const zoneStopIds = (stopsByHub.get(h.id) ?? []).map(s => s.stopId);
            if (zoneStopIds.length > 0) {
              const built = await buildBusHubSchedulesFromGtfs(zoneStopIds, yyyymmdd, dowField);
              if (built.arrivals.length > 0 || built.departures.length > 0) {
                h.typicalArrivals = built.arrivals.map(a => ({ origin: a.label, times: a.times }));
                h.typicalDepartures = built.departures.map(a => ({ destination: a.label, times: a.times }));
                arrivalsSaved = built.arrivals;
                departuresSaved = built.departures;
                srcTag = "gtfs";
                synced++;
              }
            }
          }
        } catch (e) {
          req.log.warn(`[intermodal-opt] sync failed for ${h.name}: ${(e as Error).message}`);
        }

        // Persist su DB se abbiamo qualcosa
        if (meta && (arrivalsSaved.length > 0 || departuresSaved.length > 0)) {
          try {
            await db.update(coincidenceZones)
              .set({ schedules: { arrivals: arrivalsSaved, departures: departuresSaved, source: srcTag, syncedAt: new Date().toISOString() } as any, updatedAt: new Date() })
              .where(eq(coincidenceZones.id, meta.zoneId));
          } catch (e) {
            req.log.warn(`[intermodal-opt] persist schedules failed for ${h.name}: ${(e as Error).message}`);
          }
        }
      }
      req.log.info(`[intermodal-opt] auto-synced ${synced} hub schedules (persisted to zone.schedules)`);
    } else {
      // Applichiamo comunque la cache già presente
      for (const h of hubs) {
        const cached = dynamicHubSchedules.get(h.id);
        if (cached) {
          if (!h.typicalDepartures?.length) h.typicalDepartures = cached.typicalDepartures;
          if (!h.typicalArrivals?.length) h.typicalArrivals = cached.typicalArrivals;
          if (cached.weeklyDepartures && (!h.weeklyDepartures || h.weeklyDepartures.every(d => !d.length))) {
            h.weeklyDepartures = cached.weeklyDepartures;
          }
          if (cached.weeklyArrivals && (!h.weeklyArrivals || h.weeklyArrivals.every(d => !d.length))) {
            h.weeklyArrivals = cached.weeklyArrivals;
          }
          if (cached.weekStart && !h.weekStart) h.weekStart = cached.weekStart;
        }
      }
    }

    // 4) Coincidence analysis
    const coincidences: CoincidenceMatch[] = [];
    let tripsNearHub = 0;

    // Helper: distanza minima fra un punto e un hub.
    // Considera sia il centro dell'hub sia le fermate curate della zona di coincidenza
    // (es. la "Stazione FS" può avere il centro a 500m dalle fermate bus collegate).
    function distToHub(lat: number, lng: number, hub: typeof hubs[number]): number {
      let best = distanceMeters(lat, lng, hub.lat, hub.lng);
      const zStops = stopsByHub.get(hub.id);
      if (zStops && zStops.length > 0) {
        for (const s of zStops) {
          const d = distanceMeters(lat, lng, s.lat, s.lng);
          if (d < best) best = d;
        }
      }
      return best;
    }

    for (const sh of shifts) {
      for (const e of sh.trips || []) {
        if (e.type !== "trip") continue;

        // ── A) BUS ARRIVA AL CAPOLINEA → controlla PARTENZE treno (passeggero scende e prende treno)
        if (typeof e.lastStopLat === "number" && typeof e.lastStopLon === "number") {
          for (const hub of hubs) {
            const distM = distToHub(e.lastStopLat, e.lastStopLon, hub);
            if (distM > maxHubDistM) continue;
            const walkMin = walkMinutesTo(distM, walkSpeedKmh, hub.platformWalkMinutes);
            if (walkMin > maxWalkMin) continue;
            tripsNearHub++;

            const earliestBoardMin = e.arrivalMin + walkMin;
            const departures = getDayDepartures(hub, dow);
            for (const d of departures) {
              for (const t of d.times) {
                const tMin = timeToMinutes(t + ":00");
                const buffer = tMin - earliestBoardMin;
                // Considera solo treni nella finestra [-2; winBeforeDep]
                if (buffer < -2 || buffer > winBeforeDep) continue;
                coincidences.push({
                  shiftId: sh.vehicleId,
                  vehicleType: sh.vehicleType,
                  tripId: e.tripId,
                  routeId: e.routeId,
                  routeName: e.routeName,
                  hubId: hub.id,
                  hubName: hub.name,
                  hubType: hub.type,
                  priorityClass: priorityFromHub(hub.type),
                  mode: "arrive_at_hub",
                  busTime: e.arrivalTime || "",
                  busTimeMin: e.arrivalMin,
                  trainTime: t,
                  trainTimeMin: tMin,
                  trainLabel: d.destination,
                  walkMin: +walkMin.toFixed(1),
                  bufferMin: +buffer.toFixed(1),
                  status: classifyBuffer(buffer),
                });
              }
            }
          }
        }

        // ── B) BUS PARTE DAL CAPOLINEA → controlla ARRIVI treno (passeggero scende dal treno e prende bus)
        if (typeof e.firstStopLat === "number" && typeof e.firstStopLon === "number") {
          for (const hub of hubs) {
            const distM = distToHub(e.firstStopLat, e.firstStopLon, hub);
            if (distM > maxHubDistM) continue;
            const walkMin = walkMinutesTo(distM, walkSpeedKmh, hub.platformWalkMinutes);
            if (walkMin > maxWalkMin) continue;
            tripsNearHub++;

            // Latest train arrival to catch this bus
            const latestArrivalMin = e.departureMin - walkMin;
            const arrivals = getDayArrivals(hub, dow);
            for (const a of arrivals) {
              for (const t of a.times) {
                const tMin = timeToMinutes(t + ":00");
                const buffer = e.departureMin - (tMin + walkMin);
                if (buffer < -2 || buffer > winAfterArr) continue;
                coincidences.push({
                  shiftId: sh.vehicleId,
                  vehicleType: sh.vehicleType,
                  tripId: e.tripId,
                  routeId: e.routeId,
                  routeName: e.routeName,
                  hubId: hub.id,
                  hubName: hub.name,
                  hubType: hub.type,
                  priorityClass: priorityFromHub(hub.type),
                  mode: "depart_from_hub",
                  busTime: e.departureTime || "",
                  busTimeMin: e.departureMin,
                  trainTime: t,
                  trainTimeMin: tMin,
                  trainLabel: a.origin,
                  walkMin: +walkMin.toFixed(1),
                  bufferMin: +buffer.toFixed(1),
                  status: classifyBuffer(buffer),
                });
              }
            }
          }
        }
      }
    }

    // 4bis) BUS-TO-BUS — coincidenze con ALTRE linee GTFS (non incluse nei turni in analisi)
    //       L'utenza che scende dai nostri bus può prendere altre linee per andare altrove.
    let busExtraConnections = 0;
    if (includeOtherBusRoutes && bbox && tripEndpoints.length > 0) {
      try {
        // Set di route in analisi (esclusi)
        const analyzedRoutes = new Set<string>();
        for (const sh of shifts) for (const t of sh.trips) if (t.type === "trip" && t.routeId) analyzedRoutes.add(t.routeId);

        // 1. Recupera service_id attivi per il giorno
        const yyyymmdd = `${dateObj.getFullYear()}${String(dateObj.getMonth() + 1).padStart(2, "0")}${String(dateObj.getDate()).padStart(2, "0")}`;
        // JS getDay(): 0=Dom..6=Sab → mappiamo ai field name calendar
        const dowFieldByJs = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
        const dowField = dowFieldByJs[dateObj.getDay()];
        const calRows = await db.select().from(gtfsCalendar);
        const exRows = await db.select().from(gtfsCalendarDates);
        const exMap = new Map<string, Set<string>>(); // serviceId -> Set("1"|"2") (1=add, 2=remove)
        for (const e of exRows) {
          if (e.date !== yyyymmdd) continue;
          if (!exMap.has(e.serviceId)) exMap.set(e.serviceId, new Set());
          exMap.get(e.serviceId)!.add(String(e.exceptionType));
        }
        const activeServices = new Set<string>();
        for (const c of calRows) {
          const inRange = c.startDate <= yyyymmdd && c.endDate >= yyyymmdd;
          const dayActive = (c as any)[dowField] === 1;
          const ex = exMap.get(c.serviceId);
          const removed = ex?.has("2");
          const added = ex?.has("1");
          if ((inRange && dayActive && !removed) || added) activeServices.add(c.serviceId);
        }
        // anche servizi presenti SOLO in calendar_dates con eccezione "1"
        for (const [sid, set] of exMap) if (set.has("1")) activeServices.add(sid);

        // 2. Stops candidati per ciascun capolinea = unione di:
        //    (a) fermate GTFS entro 400m a piedi dal capolinea trip
        //    (b) fermate CURATE delle coincidence-zones il cui hub è entro 3.5 km dal capolinea trip
        //        (queste sono le fermate "vicino stazione/aeroporto/porto" già validate dall'utente)
        const NEAR_STOP_RADIUS_M = 400;
        const allStopsRaw = await db.select({
          stopId: gtfsStops.stopId,
          stopName: gtfsStops.stopName,
          lat: gtfsStops.stopLat,
          lng: gtfsStops.stopLon,
        }).from(gtfsStops);
        const stopById = new Map<string, { name: string | null; lat: number; lng: number }>();
        const nearStopsByEndpoint: Array<{ endpoint: [number, number]; stops: Array<{ stopId: string; distM: number; walkMin: number; name: string | null; lat: number; lng: number }> }> = [];
        for (const ep of tripEndpoints) {
          const closeMap = new Map<string, { stopId: string; distM: number; walkMin: number; name: string | null; lat: number; lng: number }>();
          // (a) fermate vicine (raggio diretto)
          for (const s of allStopsRaw) {
            const sLat = typeof s.lat === "string" ? parseFloat(s.lat) : (s.lat as number);
            const sLng = typeof s.lng === "string" ? parseFloat(s.lng) : (s.lng as number);
            if (!Number.isFinite(sLat) || !Number.isFinite(sLng)) continue;
            const distM = haversineKm(ep[0], ep[1], sLat, sLng) * 1000;
            if (distM > NEAR_STOP_RADIUS_M) continue;
            stopById.set(s.stopId, { name: s.stopName ?? null, lat: sLat, lng: sLng });
            closeMap.set(s.stopId, { stopId: s.stopId, distM, walkMin: walkMinutesTo(distM, walkSpeedKmh, 0), name: s.stopName ?? null, lat: sLat, lng: sLng });
          }
          // (b) fermate curate degli hub-zona vicini (raggio 3.5 km hub→capolinea)
          for (const h of hubs) {
            const dHub = haversineKm(h.lat, h.lng, ep[0], ep[1]) * 1000;
            if (dHub > maxHubFromTripM) continue;
            const zoneStops = stopsByHub.get(h.id) ?? [];
            for (const zs of zoneStops) {
              if (closeMap.has(zs.stopId)) continue;
              stopById.set(zs.stopId, { name: zs.stopName, lat: zs.lat, lng: zs.lng });
              // walk dal capolinea verso la fermata (linea retta), useremo questa per il buffer
              const distM = haversineKm(ep[0], ep[1], zs.lat, zs.lng) * 1000;
              closeMap.set(zs.stopId, {
                stopId: zs.stopId,
                distM,
                walkMin: walkMinutesTo(distM, walkSpeedKmh, 0),
                name: zs.stopName,
                lat: zs.lat,
                lng: zs.lng,
              });
            }
          }
          const close = [...closeMap.values()];
          if (close.length > 0) nearStopsByEndpoint.push({ endpoint: ep, stops: close });
        }
        const allCandidateStopIds = new Set<string>();
        for (const ep of nearStopsByEndpoint) for (const s of ep.stops) allCandidateStopIds.add(s.stopId);
        req.log.info(`[intermodal-opt] bus-extra candidate stops: ${allCandidateStopIds.size} (across ${nearStopsByEndpoint.length} trip endpoints)`);

        if (allCandidateStopIds.size > 0) {
          // 3. stop_times di queste fermate, raggruppate per (tripId, stopId)
          const candidateArr = [...allCandidateStopIds];
          type StRow = { tripId: string; stopId: string; departureTime: string; arrivalTime: string };
          const stRows: StRow[] = [];
          for (let i = 0; i < candidateArr.length; i += 500) {
            const batch = candidateArr.slice(i, i + 500);
            const rows = await db.select({
              tripId: gtfsStopTimes.tripId,
              stopId: gtfsStopTimes.stopId,
              departureTime: gtfsStopTimes.departureTime,
              arrivalTime: gtfsStopTimes.arrivalTime,
            }).from(gtfsStopTimes)
              .where(sql`${gtfsStopTimes.stopId} IN (${sql.join(batch.map(id => sql`${id}`), sql`, `)})`);
            stRows.push(...rows.map(r => ({ tripId: r.tripId, stopId: r.stopId, departureTime: r.departureTime || "", arrivalTime: r.arrivalTime || "" })));
          }

          // 4. Trip metadata + route info
          const tripIds = [...new Set(stRows.map(r => r.tripId))];
          const tripInfo = new Map<string, { routeId: string; serviceId: string; headsign: string | null }>();
          for (let i = 0; i < tripIds.length; i += 500) {
            const batch = tripIds.slice(i, i + 500);
            const rows = await db.select({
              tripId: gtfsTrips.tripId, routeId: gtfsTrips.routeId, serviceId: gtfsTrips.serviceId, headsign: gtfsTrips.tripHeadsign,
            }).from(gtfsTrips).where(sql`${gtfsTrips.tripId} IN (${sql.join(batch.map(id => sql`${id}`), sql`, `)})`);
            for (const r of rows) tripInfo.set(r.tripId, { routeId: r.routeId, serviceId: r.serviceId, headsign: r.headsign });
          }

          const routeIds = [...new Set([...tripInfo.values()].map(t => t.routeId))];
          const routeInfo = new Map<string, { shortName: string | null; longName: string | null }>();
          if (routeIds.length > 0) {
            const rows = await db.select({
              routeId: gtfsRoutes.routeId, shortName: gtfsRoutes.routeShortName, longName: gtfsRoutes.routeLongName,
            }).from(gtfsRoutes).where(inArray(gtfsRoutes.routeId, routeIds));
            for (const r of rows) routeInfo.set(r.routeId, { shortName: r.shortName, longName: r.longName });
          }

          // 5. Per ogni capolinea + relativa fermata vicina, abbina i nostri trip ai bus altri
          for (const sh of shifts) {
            for (const e of sh.trips) {
              if (e.type !== "trip") continue;

              // ── A) BUS NOSTRO ARRIVA → l'utente prende altro bus che parte
              if (typeof e.lastStopLat === "number" && typeof e.lastStopLon === "number") {
                const ep = nearStopsByEndpoint.find(x => Math.abs(x.endpoint[0] - e.lastStopLat!) < 1e-6 && Math.abs(x.endpoint[1] - e.lastStopLon!) < 1e-6);
                if (ep) {
                  const earliestBoardMin = e.arrivalMin;
                  for (const stp of ep.stops) {
                    const boardAt = earliestBoardMin + stp.walkMin;
                    for (const st of stRows) {
                      if (st.stopId !== stp.stopId) continue;
                      const ti = tripInfo.get(st.tripId);
                      if (!ti) continue;
                      if (analyzedRoutes.has(ti.routeId)) continue;
                      if (activeServices.size > 0 && !activeServices.has(ti.serviceId)) continue;
                      const depMin = timeToMinutes(st.departureTime);
                      if (!Number.isFinite(depMin)) continue;
                      const buffer = depMin - boardAt;
                      if (buffer < -2 || buffer > winBeforeDep) continue;
                      const ri = routeInfo.get(ti.routeId);
                      const routeLabel = (ri?.shortName || ri?.longName || ti.routeId).slice(0, 40);
                      coincidences.push({
                        shiftId: sh.vehicleId,
                        vehicleType: sh.vehicleType,
                        tripId: e.tripId,
                        routeId: e.routeId,
                        routeName: e.routeName,
                        hubId: `bus:${stp.stopId}`,
                        hubName: stp.name || `Fermata ${stp.stopId}`,
                        hubType: "bus_other",
                        priorityClass: "bus_other",
                        mode: "arrive_at_hub",
                        busTime: e.arrivalTime || "",
                        busTimeMin: e.arrivalMin,
                        trainTime: st.departureTime.slice(0, 5),
                        trainTimeMin: depMin,
                        trainLabel: `Bus ${routeLabel}${ti.headsign ? ` → ${ti.headsign}` : ""}`,
                        walkMin: +stp.walkMin.toFixed(1),
                        bufferMin: +buffer.toFixed(1),
                        status: classifyBuffer(buffer),
                      });
                      busExtraConnections++;
                    }
                  }
                }
              }

              // ── B) BUS NOSTRO PARTE → l'utente è arrivato con altro bus
              if (typeof e.firstStopLat === "number" && typeof e.firstStopLon === "number") {
                const ep = nearStopsByEndpoint.find(x => Math.abs(x.endpoint[0] - e.firstStopLat!) < 1e-6 && Math.abs(x.endpoint[1] - e.firstStopLon!) < 1e-6);
                if (ep) {
                  for (const stp of ep.stops) {
                    for (const st of stRows) {
                      if (st.stopId !== stp.stopId) continue;
                      const ti = tripInfo.get(st.tripId);
                      if (!ti) continue;
                      if (analyzedRoutes.has(ti.routeId)) continue;
                      if (activeServices.size > 0 && !activeServices.has(ti.serviceId)) continue;
                      const arrMin = timeToMinutes(st.arrivalTime);
                      if (!Number.isFinite(arrMin)) continue;
                      const buffer = e.departureMin - (arrMin + stp.walkMin);
                      if (buffer < -2 || buffer > winAfterArr) continue;
                      const ri = routeInfo.get(ti.routeId);
                      const routeLabel = (ri?.shortName || ri?.longName || ti.routeId).slice(0, 40);
                      coincidences.push({
                        shiftId: sh.vehicleId,
                        vehicleType: sh.vehicleType,
                        tripId: e.tripId,
                        routeId: e.routeId,
                        routeName: e.routeName,
                        hubId: `bus:${stp.stopId}`,
                        hubName: stp.name || `Fermata ${stp.stopId}`,
                        hubType: "bus_other",
                        priorityClass: "bus_other",
                        mode: "depart_from_hub",
                        busTime: e.departureTime || "",
                        busTimeMin: e.departureMin,
                        trainTime: st.arrivalTime.slice(0, 5),
                        trainTimeMin: arrMin,
                        trainLabel: `Bus ${routeLabel}${ti.headsign ? ` da ${ti.headsign}` : ""}`,
                        walkMin: +stp.walkMin.toFixed(1),
                        bufferMin: +buffer.toFixed(1),
                        status: classifyBuffer(buffer),
                      });
                      busExtraConnections++;
                    }
                  }
                }
              }
            }
          }
        }
      } catch (e) {
        req.log.warn(`[intermodal-opt] bus-extra failed: ${(e as Error).message}`);
      }
    }
    req.log.info(`[intermodal-opt] busExtraConnections=${busExtraConnections}`);

    // 4ter) POIs per hub — dove vanno le persone dopo lo scambio modale
    let poisReached = 0;
    if (includePois && hubs.length > 0) {
      try {
        const WORK_CATEGORIES = ["office", "hospital", "school", "industrial"];
        const TOURISM_CATEGORIES = ["leisure", "shopping"];
        const allCats = [...WORK_CATEGORIES, ...TOURISM_CATEGORIES];
        const poisRaw = await db.select({
          id: pointsOfInterest.id,
          name: pointsOfInterest.name,
          category: pointsOfInterest.category,
          lat: pointsOfInterest.lat,
          lng: pointsOfInterest.lng,
        }).from(pointsOfInterest).where(inArray(pointsOfInterest.category, allCats)).limit(20000);

        for (const h of hubs) {
          const wantWork = h.type === "railway" || h.type === "bus_terminal" || h.type === "airport";
          const wantTourism = h.type === "port" || h.type === "airport";
          const allowed = new Set<string>([...(wantWork ? WORK_CATEGORIES : []), ...(wantTourism ? TOURISM_CATEGORIES : [])]);
          const list: HubPoi[] = [];
          for (const p of poisRaw) {
            if (!allowed.has(p.category)) continue;
            const distM = haversineKm(h.lat, h.lng, p.lat, p.lng) * 1000;
            if (distM > maxPoiDistM) continue;
            list.push({
              id: p.id, name: p.name, category: p.category,
              lat: p.lat, lng: p.lng,
              distM: Math.round(distM),
              walkMin: +walkMinutesTo(distM, walkSpeedKmh, 0).toFixed(1),
            });
          }
          list.sort((a, b) => a.distM - b.distM);
          h.pois = list.slice(0, 25);
          poisReached += h.pois.length;
        }
      } catch (e) {
        req.log.warn(`[intermodal-opt] pois failed: ${(e as Error).message}`);
      }
    }
    req.log.info(`[intermodal-opt] poisReached=${poisReached}`);

    // 5) ADVISORIES
    const advisories: Advisory[] = [];
    const proposedChanges: ProposedChange[] = [];
    let advId = 0;
    const next = () => `adv-${++advId}`;

    // (a) Tight & missed → suggerisci anticipo/posticipo
    for (const c of coincidences) {
      if (c.status === "missed") {
        const shift = Math.ceil(-c.bufferMin + 3); // serve almeno 3 min di buffer
        if (c.mode === "arrive_at_hub") {
          // Bus arriva troppo tardi → anticipa l'ARRIVO al capolinea
          const proposedTime = minutesToTime(c.busTimeMin - shift);
          advisories.push({
            id: next(),
            severity: "critical",
            hubId: c.hubId,
            hubName: c.hubName,
            shiftId: c.shiftId,
            tripId: c.tripId,
            title: `Treno per ${c.trainLabel} perso da ${c.routeName ?? c.routeId}`,
            description: `Il bus arriva alle ${c.busTime} a ${c.hubName} ma il treno per ${c.trainLabel} parte alle ${c.trainTime} (servono ${c.walkMin.toFixed(0)} min a piedi).`,
            suggestion: `Anticipa il capolinea della corsa ${c.tripId} di circa ${shift} min (nuovo arrivo ${proposedTime}), oppure aggiungi una corsa rinforzo verso le ${minutesToTime(c.trainTimeMin - c.walkMin - 5)}.`,
            proposedShiftMin: -shift,
            changeType: "shift_arrival",
            originalTime: c.busTime,
            proposedTime,
          });
          proposedChanges.push({
            shiftId: c.shiftId,
            tripId: c.tripId,
            routeName: c.routeName,
            hubName: c.hubName,
            changeType: "shift_arrival",
            shiftMin: -shift,
            originalTime: c.busTime,
            proposedTime,
            reason: `Aggancia treno ${c.trainTime} per ${c.trainLabel}`,
            severity: "critical",
          });
        } else {
          // Bus parte troppo presto → posticipa la PARTENZA
          const proposedTime = minutesToTime(c.busTimeMin + shift);
          advisories.push({
            id: next(),
            severity: "critical",
            hubId: c.hubId,
            hubName: c.hubName,
            shiftId: c.shiftId,
            tripId: c.tripId,
            title: `Bus ${c.routeName ?? c.routeId} perso da treno ${c.trainLabel}`,
            description: `Il treno da ${c.trainLabel} arriva alle ${c.trainTime}, ma il bus parte alle ${c.busTime} (impossibile coprire ${c.walkMin.toFixed(0)} min a piedi).`,
            suggestion: `Posticipa la partenza della corsa ${c.tripId} di circa ${shift} min (nuova partenza ${proposedTime}), oppure inserisci corsa attesa-treno alle ${minutesToTime(c.trainTimeMin + c.walkMin + 3)}.`,
            proposedShiftMin: shift,
            changeType: "shift_departure",
            originalTime: c.busTime,
            proposedTime,
          });
          proposedChanges.push({
            shiftId: c.shiftId,
            tripId: c.tripId,
            routeName: c.routeName,
            hubName: c.hubName,
            changeType: "shift_departure",
            shiftMin: shift,
            originalTime: c.busTime,
            proposedTime,
            reason: `Aggancia treno in arrivo ${c.trainTime} da ${c.trainLabel}`,
            severity: "critical",
          });
        }
      } else if (c.status === "tight") {
        // Stretta → suggerisci 3 min di buffer
        const shift = 3;
        const isArrive = c.mode === "arrive_at_hub";
        const proposedTime = isArrive
          ? minutesToTime(c.busTimeMin - shift)
          : minutesToTime(c.busTimeMin + shift);
        advisories.push({
          id: next(),
          severity: "warning",
          hubId: c.hubId,
          hubName: c.hubName,
          shiftId: c.shiftId,
          tripId: c.tripId,
          title: `Coincidenza stretta a ${c.hubName}`,
          description: isArrive
            ? `Solo ${c.bufferMin.toFixed(0)} min fra arrivo bus (${c.busTime}) e treno per ${c.trainLabel} (${c.trainTime}).`
            : `Solo ${c.bufferMin.toFixed(0)} min fra arrivo treno (${c.trainTime}) da ${c.trainLabel} e partenza bus (${c.busTime}).`,
          suggestion: isArrive
            ? `Anticipa la corsa ${c.tripId} di ${shift} min (nuovo arrivo ${proposedTime}) per garantire margine sicuro.`
            : `Posticipa la corsa ${c.tripId} di ${shift} min (nuova partenza ${proposedTime}) per garantire margine sicuro.`,
          proposedShiftMin: isArrive ? -shift : shift,
          changeType: isArrive ? "shift_arrival" : "shift_departure",
          originalTime: c.busTime,
          proposedTime,
        });
        proposedChanges.push({
          shiftId: c.shiftId,
          tripId: c.tripId,
          routeName: c.routeName,
          hubName: c.hubName,
          changeType: isArrive ? "shift_arrival" : "shift_departure",
          shiftMin: isArrive ? -shift : shift,
          originalTime: c.busTime,
          proposedTime,
          reason: `Margine sicurezza coincidenza ${c.trainTime} ${c.trainLabel}`,
          severity: "warning",
        });
      }
    }

    // (b) Hub molto attivo senza alcuna coincidenza utile → suggerisci nuova corsa
    const tripsByHub = new Map<string, number>();
    for (const c of coincidences) {
      if (c.status === "optimal") tripsByHub.set(c.hubId, (tripsByHub.get(c.hubId) || 0) + 1);
    }
    for (const hub of hubs) {
      if (hub.type !== "railway") continue;
      const dep = getDayDepartures(hub, dow);
      const totalTrains = dep.reduce((s, d) => s + d.times.length, 0);
      const matched = tripsByHub.get(hub.id) || 0;
      if (totalTrains >= 5 && matched === 0) {
        advisories.push({
          id: next(),
          severity: "info",
          hubId: hub.id,
          hubName: hub.name,
          title: `Nessuna coincidenza a ${hub.name}`,
          description: `${hub.name} ha ${totalTrains} treni in partenza il giorno selezionato ma nessuna corsa bus offre coincidenza utile (entro ${maxWalkMin} min a piedi e ${winBeforeDep} min di attesa).`,
          suggestion: `Valuta una linea/corsa che colleghi l'area servita con ${hub.name}.`,
          changeType: "add_trip",
        });
      }
    }

    // (c) Long waits → suggerisci spostamento
    const longByGroup = new Map<string, CoincidenceMatch[]>();
    for (const c of coincidences) {
      if (c.status !== "long") continue;
      const k = `${c.hubId}|${c.shiftId}|${c.tripId}|${c.mode}`;
      if (!longByGroup.has(k)) longByGroup.set(k, []);
      longByGroup.get(k)!.push(c);
    }
    for (const [, list] of longByGroup) {
      const sample = list[0];
      const sameKey = `${sample.hubId}|${sample.shiftId}|${sample.tripId}|${sample.mode}`;
      const hasOptimal = coincidences.some(c => c.status === "optimal" &&
        `${c.hubId}|${c.shiftId}|${c.tripId}|${c.mode}` === sameKey);
      if (hasOptimal) continue;
      const best = list.sort((a, b) => Math.abs(a.bufferMin) - Math.abs(b.bufferMin))[0];
      const reduction = Math.max(0, Math.round(best.bufferMin - 5));
      const isArrive = best.mode === "arrive_at_hub";
      const proposedTime = isArrive
        ? minutesToTime(best.busTimeMin + reduction)  // posticipa l'arrivo bus per ridurre attesa
        : minutesToTime(best.busTimeMin - reduction); // anticipa la partenza bus
      advisories.push({
        id: next(),
        severity: "info",
        hubId: best.hubId,
        hubName: best.hubName,
        shiftId: best.shiftId,
        tripId: best.tripId,
        title: `Lunga attesa a ${best.hubName}`,
        description: isArrive
          ? `Il bus arriva alle ${best.busTime}, primo treno utile per ${best.trainLabel} alle ${best.trainTime} (attesa ${best.bufferMin.toFixed(0)} min).`
          : `Treno arriva alle ${best.trainTime} da ${best.trainLabel}, prossimo bus alle ${best.busTime} (attesa ${best.bufferMin.toFixed(0)} min).`,
        suggestion: reduction > 0
          ? `${isArrive ? "Posticipa" : "Anticipa"} la corsa ${best.tripId} di ~${reduction} min (nuovo orario ${proposedTime}) per ridurre il tempo di attesa.`
          : `Attesa accettabile, valuta solo se conviene ottimizzare ulteriormente.`,
        proposedShiftMin: reduction > 0 ? (isArrive ? reduction : -reduction) : 0,
        changeType: reduction > 0 ? (isArrive ? "shift_arrival" : "shift_departure") : "none",
        originalTime: best.busTime,
        proposedTime: reduction > 0 ? proposedTime : best.busTime,
      });
      if (reduction > 0) {
        proposedChanges.push({
          shiftId: best.shiftId,
          tripId: best.tripId,
          routeName: best.routeName,
          hubName: best.hubName,
          changeType: isArrive ? "shift_arrival" : "shift_departure",
          shiftMin: isArrive ? reduction : -reduction,
          originalTime: best.busTime,
          proposedTime,
          reason: `Riduce attesa a ${best.hubName} (treno ${best.trainTime} ${best.trainLabel})`,
          severity: "info",
        });
      }
    }

    // 6) Metrics
    const opt = coincidences.filter(c => c.status === "optimal").length;
    const tight = coincidences.filter(c => c.status === "tight").length;
    const long = coincidences.filter(c => c.status === "long").length;
    const missed = coincidences.filter(c => c.status === "missed").length;

    const out: AnalyzeResponse = {
      bbox,
      date: dateObj.toISOString().slice(0, 10),
      dayOfWeek: dow,
      hubs,
      hubsAnalyzed: hubs.length,
      hubsDiscarded,
      hubSource: usedZones ? "zones" : "auto",
      schedulesSynced: synced,
      coincidences,
      advisories,
      proposedChanges,
      metrics: {
        totalTripsAnalyzed: totalTrips,
        tripsNearHub,
        optimalConnections: opt,
        tightConnections: tight,
        longWaits: long,
        missedConnections: missed,
        busExtraConnections,
        poisReached,
      },
    };

    res.json(out);
  } catch (err: any) {
    req.log.error(`[intermodal-opt] error: ${err.message}`);
    res.status(500).json({ error: err.message || "Errore interno" });
  }
});

function minutesToTime(min: number): string {
  const m = Math.max(0, Math.round(min));
  const h = Math.floor(m / 60) % 24;
  const mm = m % 60;
  return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

export default router;
