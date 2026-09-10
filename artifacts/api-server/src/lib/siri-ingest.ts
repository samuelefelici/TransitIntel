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
  buildTripStartIndex, detectTransit, splitInService,
  type GtfsIndex, type MappingReport, type SiriVehicle, type TripStartIndex,
  type VehicleProgress,
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
      SELECT route_id, route_short_name, route_long_name FROM gtfs_routes WHERE feed_id = ${feedId}::uuid`),
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
  const routeLongNames: Array<{ norm: string; routeId: string }> = [];
  for (const r of ((routesR as any).rows ?? [])) {
    const id = String(r.route_id);
    routes.add(id);
    routeByCode.set(normalizeLineCode(id), id);
    if (r.route_short_name) routeByCode.set(normalizeLineCode(String(r.route_short_name)), id);
    if (r.route_long_name) {
      routeLongNames.push({ norm: normalizeStopName(String(r.route_long_name)), routeId: id });
    }
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
    feedId, trips, routes, stops, tripRoute, routeByCode, routeLongNames, stopNames, stopByName,
    tripStarts: (await loadTripStartIndex(feedId)) ?? undefined,
    timeZone: process.env.SIRI_TIMEZONE || "Europe/Rome",
    loadedAt: Date.now(),
  };
  return cachedIndex;
}

/* ── Corse per linea e ora di partenza ────────────────────────────────────
 * Aggregazione pesante (una riga per corsa su ~400k passaggi), quindi tenuta
 * SEPARATA dall'indice leggero e con una scadenza più lunga: serve solo
 * all'aggancio delle corse, e l'orario di un feed non cambia durante il
 * giorno. Un errore qui non deve fermare l'ingestione: si degrada a "corse
 * non agganciate", che è lo stato precedente. */
let cachedTripStarts: { feedId: string; day: string; idx: TripStartIndex; at: number } | null = null;
const TRIP_TTL_MS = 30 * 60 * 1000;

/** Data di servizio e giorno della settimana NELL'ORA DELL'AZIENDA. */
function serviceDay(timeZone: string): { ymd: string; isoDow: number } {
  const now = new Date();
  const ymd = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now).replace(/-/g, "");
  const wd = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(now);
  const isoDow = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[wd] ?? 1;
  return { ymd, isoDow };
}

export async function loadTripStartIndex(feedId: string): Promise<TripStartIndex | null> {
  const timeZone = process.env.SIRI_TIMEZONE || "Europe/Rome";
  const { ymd, isoDow } = serviceDay(timeZone);
  if (cachedTripStarts && cachedTripStarts.feedId === feedId && cachedTripStarts.day === ymd
      && Date.now() - cachedTripStarts.at < TRIP_TTL_MS) {
    return cachedTripStarts.idx;
  }
  try {
    /* SOLO le corse che circolano OGGI. Senza questo filtro l'indice contiene
     * la stessa corsa ripetuta in ogni validità (feriale, sabato, estivo,
     * scolastico…): linea e ora di partenza coincidono, e ogni aggancio
     * risulta ambiguo. È la regola GTFS standard: pattern settimanale nel
     * range di validità, meno le rimozioni, più le aggiunte esplicite. */
    const withCalendar = await db.execute<any>(sql`
      WITH removed AS (
        SELECT service_id FROM gtfs_calendar_dates
         WHERE feed_id = ${feedId}::uuid AND date = ${ymd} AND exception_type = 2
      ), added AS (
        SELECT service_id FROM gtfs_calendar_dates
         WHERE feed_id = ${feedId}::uuid AND date = ${ymd} AND exception_type = 1
      ), weekly AS (
        SELECT c.service_id FROM gtfs_calendar c
         WHERE c.feed_id = ${feedId}::uuid
           AND c.start_date <= ${ymd} AND c.end_date >= ${ymd}
           AND CASE ${isoDow}::int
                 WHEN 1 THEN c.monday   WHEN 2 THEN c.tuesday WHEN 3 THEN c.wednesday
                 WHEN 4 THEN c.thursday WHEN 5 THEN c.friday  WHEN 6 THEN c.saturday
                 ELSE c.sunday END = 1
      ), active AS (
        SELECT service_id FROM weekly
         WHERE service_id NOT IN (SELECT service_id FROM removed)
        UNION
        SELECT service_id FROM added
      )
      SELECT t.trip_id, t.route_id, t.trip_headsign,
             MIN(st.departure_time) AS first_dep
        FROM gtfs_trips t
        JOIN active a ON a.service_id = t.service_id
        JOIN gtfs_stop_times st
          ON st.feed_id = t.feed_id AND st.trip_id = t.trip_id
       WHERE t.feed_id = ${feedId}::uuid
       GROUP BY t.trip_id, t.route_id, t.trip_headsign`);

    let rows = (withCalendar as any).rows ?? [];
    let filtered = true;
    /* Un feed senza calendario utilizzabile darebbe zero corse, cioè zero
     * agganci: meglio l'indice completo (ambiguo) che nessun indice. */
    if (rows.length === 0) {
      const all = await db.execute<any>(sql`
        SELECT t.trip_id, t.route_id, t.trip_headsign,
               MIN(st.departure_time) AS first_dep
          FROM gtfs_trips t
          JOIN gtfs_stop_times st
            ON st.feed_id = t.feed_id AND st.trip_id = t.trip_id
         WHERE t.feed_id = ${feedId}::uuid
         GROUP BY t.trip_id, t.route_id, t.trip_headsign`);
      rows = (all as any).rows ?? [];
      filtered = false;
      console.warn("[siri] nessuna corsa circolante oggi secondo il calendario: "
        + "indice costruito su TUTTE le validità, gli agganci saranno ambigui");
    }

    const idx = buildTripStartIndex(rows.map((x: any) => ({
      tripId: String(x.trip_id),
      routeId: String(x.route_id ?? ""),
      firstDeparture: String(x.first_dep ?? ""),
      headsign: x.trip_headsign ?? null,
    })));
    idx.serviceDay = ymd;
    idx.calendarFiltered = filtered;
    cachedTripStarts = { feedId, day: ymd, idx, at: Date.now() };
    return idx;
  } catch (e: any) {
    console.warn("[siri] indice orari corse non disponibile:", e?.message ?? e);
    return null;
  }
}

/* ── Orario programmato per (corsa, fermata) ──────────────────────────────
 * Serve a dare al transito osservato il suo termine di confronto. Si carica
 * solo per le corse che circolano oggi (poche migliaia), non per l'intero
 * feed. */
let cachedStopTimes: { feedId: string; day: string; map: Map<string, { scheduled: string; seq: number }>; at: number } | null = null;

async function loadStopTimeIndex(
  feedId: string, tripIds: string[], day: string,
): Promise<Map<string, { scheduled: string; seq: number }>> {
  if (cachedStopTimes && cachedStopTimes.feedId === feedId && cachedStopTimes.day === day
      && Date.now() - cachedStopTimes.at < TRIP_TTL_MS) {
    return cachedStopTimes.map;
  }
  const map = new Map<string, { scheduled: string; seq: number }>();
  if (tripIds.length === 0) return map;
  try {
    const r = await db.execute<any>(sql`
      SELECT trip_id, stop_id, stop_sequence,
             COALESCE(departure_time, arrival_time) AS t
        FROM gtfs_stop_times
       WHERE feed_id = ${feedId}::uuid
         AND trip_id = ANY(${`{${tripIds.map(x => '"' + x.replace(/"/g, '\\"') + '"').join(",")}}`}::text[])`);
    for (const x of ((r as any).rows ?? [])) {
      if (!x.t) continue;
      map.set(`${x.trip_id}|${x.stop_id}`, {
        scheduled: String(x.t), seq: Number(x.stop_sequence ?? 0),
      });
    }
    cachedStopTimes = { feedId, day, map, at: Date.now() };
  } catch (e: any) {
    console.warn("[siri] orari per fermata non disponibili:", e?.message ?? e);
  }
  return map;
}

/* ── Velocità stimata ─────────────────────────────────────────────────────── */

/** Ultima posizione per mezzo: questo profilo SIRI non espone la velocità. */
const lastFix = new Map<string, { lat: number; lon: number; t: number }>();

/** Ultima fermata nota per mezzo: è da qui che si riconoscono i transiti. */
const lastProgress = new Map<string, VehicleProgress>();

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
  /** mezzi il cui salvataggio è fallito: il giro prosegue lo stesso */
  vehiclesFailed: number;
  /** vetture del parco fermo, scartate prima di scrivere */
  vehiclesParked: number;
  /** il primo errore incontrato, per capire perché senza leggere i log */
  firstError: string | null;
  report: MappingReport;
}

export async function ingestVehicles(all: SiriVehicle[]): Promise<IngestResult> {
  /* Il deposito non è esercizio: si scarta PRIMA di scrivere, altrimenti la
   * mappa si riempie di mezzi anonimi e la tabella di righe inutili. */
  const split = splitInService(all);
  const vehicles = split.inServizio;

  const index = await loadGtfsIndex();
  if (!index) {
    return {
      positionsInserted: 0, tripsOpened: 0, tripsClosed: 0, transitsInserted: 0,
      vehiclesFailed: 0, vehiclesParked: split.ferme.length, firstError: null,
      report: {
        vehicles: vehicles.length, withPosition: 0, tripMatched: 0,
        tripMatchedById: 0, tripMatchedBySchedule: 0, tripAmbiguous: 0,
        tripAmbiguousExamples: [], routeMatched: 0,
        stopMatched: 0, transitsFound: 0, transitsMatched: 0,
        routeMatchedByPublishedName: 0, routeMatchedByRouteRef: 0,
        routeMatchedByLongName: 0, routeMatchedByRef: 0,
        stopMatchedById: 0, stopMatchedByName: 0, stopIdNameConflicts: [],
        unmatchedTripRefs: [], unmatchedLineRefs: [], unmatchedLines: [],
        unmatchedStopRefs: [],
      },
    };
  }
  const { mapped, report } = mapVehicles(vehicles, index);

  /* Gli orari programmati servono solo per le corse effettivamente agganciate
   * in questo giro: si carica quel poco, non l'intero feed. */
  const matchedTrips = [...new Set(mapped.map(x => x.tripId).filter((x): x is string => !!x))];
  const stopTimes = await loadStopTimeIndex(
    index.feedId, matchedTrips, index.tripStarts?.serviceDay ?? "",
  );

  let positionsInserted = 0, tripsOpened = 0, tripsClosed = 0, transitsInserted = 0;
  let vehiclesFailed = 0;
  let firstError: string | null = null;

  for (const m of mapped) {
   /* Un mezzo che non si riesce a salvare non deve costare gli altri 367.
    * Senza questo isolamento un solo record difettoso interrompeva il ciclo
    * e sulla mappa comparivano soltanto i mezzi elaborati prima dell'errore
    * — un guasto che si presenta come "pochi autobus", non come un errore. */
   try {
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

    /* 3a. TRANSITO OSSERVATO. Le PreviousCalls di questo produttore arrivano
     *     senza orari, quindi il passaggio si riconosce dal cambio di fermata
     *     corrente: se il mezzo puntava ad A e ora punta a B, ha superato A
     *     nel frattempo. È l'unica misura disponibile, e non dipende da come
     *     l'AVM calcola il ritardo. */
    if (vehicleId && m.tripId && m.nearestStopId) {
      const cur: VehicleProgress = {
        tripId: m.tripId, stopId: m.nearestStopId,
        delaySeconds: v.delaySeconds, at: ts,
      };
      const ev = detectTransit(lastProgress.get(vehicleId), cur);
      lastProgress.set(vehicleId, cur);
      if (ev) {
        const st = stopTimes.get(`${ev.tripId}|${ev.stopId}`);
        const r = await db.execute<any>(sql`
          INSERT INTO caronte.stop_transits
                 (trip_id, route_id, vehicle_id, device_id, stop_id, stop_seq,
                  scheduled, actual_ts, delay_seconds, lat, lon)
          SELECT ${ev.tripId}, ${m.routeId}, ${vehicleId}, ${"siri"},
                 ${ev.stopId}, ${st?.seq ?? null}, ${st?.scheduled ?? null},
                 ${ev.observedAt.toISOString()}::timestamptz, ${ev.delaySeconds},
                 ${v.lat}, ${v.lon}
           WHERE NOT EXISTS (
             SELECT 1 FROM caronte.stop_transits s
              WHERE s.trip_id = ${ev.tripId} AND s.stop_id = ${ev.stopId}
                AND s.actual_ts > now() - interval '18 hours')`);
        transitsInserted += (r as any).rowCount ?? 0;
      }
    }

    /* 3b. Transiti DICHIARATI dal produttore, quando li manda con gli orari:
     *     hanno la precedenza su quelli osservati perché sono precisi. */
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
   } catch (e: any) {
     vehiclesFailed++;
     if (!firstError) firstError = `mezzo ${m.siri.vehicleRef ?? "?"}: ${e?.message ?? e}`;
   }
  }

  if (vehiclesFailed > 0) {
    console.warn(`[siri] ${vehiclesFailed} mezzi non salvati su ${mapped.length}. Primo errore: ${firstError}`);
  }

  return {
    positionsInserted, tripsOpened, tripsClosed, transitsInserted,
    vehiclesFailed, vehiclesParked: split.ferme.length, firstError, report,
  };
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
