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
import { SOURCE_SIRI, idNeedsValue, hasSourceColumn } from "./caronte-schema";
import {
  mapVehicles, resolveCancelledTrip, normalizeLineCode, normalizeStopName,
  buildTripStartIndex, detectTransit, splitInService, delayFromSchedule,
  stopsAtPosition, emptyFunnel, explainFunnel, positionUsable, fixAgeSeconds,
  localHHMM,
  type TripStop, type TransitFunnel,
  type GtfsIndex, type MappingReport, type SiriVehicle, type TripStartIndex,
  type VehicleProgress, type MappedVehicle,
} from "./siri-vm";
import {
  verificaAggancio, riepilogaAgganci,
  type EsitoAggancio, type RiepilogoAgganci, type SchedaCorsa,
} from "./trip-match-audit";
import { registraCodici, type OsservazioneCodice } from "./journey-codes-store";

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
/* La cache va tenuta PER CORSA, non per giornata.
 *
 * Prima la chiave era (feed, giorno) mentre il contenuto dipendeva dalle corse
 * chieste in quel giro: il primo giro caricava gli orari delle poche corse
 * allora agganciate e per la mezz'ora successiva ogni corsa nuova trovava la
 * cache "valida" e vuota. Il transito veniva scritto lo stesso, ma senza
 * `scheduled` e quindi senza Δ — un buco silenzioso che si apriva solo per le
 * corse entrate in servizio dopo il primo giro, cioè quasi tutte.
 *
 * Ora si accumula: si interroga il database solo per le corse mai caricate. */
/* Si caricano anche le COORDINATE, non solo gli orari: sono ciò che permette
 * di riconoscere il passaggio dalla posizione del mezzo, senza dipendere da
 * quello che l'AVM dichiara. */
interface StopTimeCache {
  feedId: string;
  day: string;
  /** "corsa|fermata" → orario programmato e progressivo */
  map: Map<string, { scheduled: string; seq: number }>;
  /** corsa → fermate con coordinate, in ordine di percorso */
  tripStops: Map<string, TripStop[]>;
  /* Partenza e arrivo programmati vanno presi su TUTTE le fermate, comprese
   * quelle senza coordinate che `tripStops` scarta: se è proprio il capolinea
   * a non averle, la campata oraria risulterebbe più corta della corsa. */
  /** corsa → primo e ultimo orario programmato, "HH:MM:SS" */
  tripSpan: Map<string, { partenza: string | null; arrivo: string | null }>;
  /** corse per cui l'interrogazione è già stata fatta, anche se a vuoto */
  loadedTrips: Set<string>;
  at: number;
}
let cachedStopTimes: StopTimeCache | null = null;

async function loadStopTimeIndex(
  feedId: string, tripIds: string[], day: string,
): Promise<StopTimeCache> {
  const fresh = cachedStopTimes
    && cachedStopTimes.feedId === feedId
    && cachedStopTimes.day === day
    && Date.now() - cachedStopTimes.at < TRIP_TTL_MS;
  if (!fresh) {
    cachedStopTimes = {
      feedId, day, map: new Map(), tripStops: new Map(), tripSpan: new Map(),
      loadedTrips: new Set(), at: Date.now(),
    };
  }
  const cache = cachedStopTimes!;

  /* Solo le corse non ancora caricate: le altre sono già nella mappa. */
  const missing = tripIds.filter(t => !cache.loadedTrips.has(t));
  if (missing.length === 0) return cache;

  try {
    const r = await db.execute<any>(sql`
      SELECT st.trip_id, st.stop_id, st.stop_sequence,
             COALESCE(st.departure_time, st.arrival_time) AS t,
             s.stop_lat, s.stop_lon
        FROM gtfs_stop_times st
        LEFT JOIN gtfs_stops s
               ON s.feed_id = st.feed_id AND s.stop_id = st.stop_id
       WHERE st.feed_id = ${feedId}::uuid
         AND st.trip_id = ANY(${`{${missing.map(x => '"' + x.replace(/"/g, '\\"') + '"').join(",")}}`}::text[])
       ORDER BY st.trip_id, st.stop_sequence`);
    for (const x of ((r as any).rows ?? [])) {
      const tripId = String(x.trip_id);
      const stopId = String(x.stop_id);
      const seq = Number(x.stop_sequence ?? 0);
      const scheduled = x.t ? String(x.t) : null;
      if (scheduled) {
        cache.map.set(`${tripId}|${stopId}`, { scheduled, seq });
        /* Le righe arrivano ordinate per progressivo: la prima che si vede è
         * la partenza, l'ultima resta l'arrivo. */
        const span = cache.tripSpan.get(tripId);
        if (!span) cache.tripSpan.set(tripId, { partenza: scheduled, arrivo: scheduled });
        else span.arrivo = scheduled;
      }
      /* Senza coordinate la fermata non è riconoscibile dalla posizione, ma
       * può ancora servire come termine di confronto: si scarta solo qui. */
      if (x.stop_lat == null || x.stop_lon == null) continue;
      const list = cache.tripStops.get(tripId) ?? [];
      list.push({ stopId, seq, lat: Number(x.stop_lat), lon: Number(x.stop_lon), scheduled });
      cache.tripStops.set(tripId, list);
    }
    /* Segnate come caricate anche quelle senza orari: senza questo si
     * riproverebbe a ogni giro su corse che nel feed non ne hanno. */
    for (const t of missing) cache.loadedTrips.add(t);
  } catch (e: any) {
    console.warn("[siri] orari per fermata non disponibili:", e?.message ?? e);
  }
  return cache;
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

/**
 * L'errore VERO del database, non l'involucro del query builder.
 *
 * Drizzle avvolge l'errore di Postgres in un "Failed query: <SQL> params: …"
 * e mette la causa in `cause`. Il risultato è che la diagnosi mostrava la
 * query — che sapevamo già — e nascondeva la sola cosa che serve: perché il
 * database l'ha rifiutata. Qui si tira fuori SQLSTATE, messaggio, colonna e
 * vincolo, che insieme dicono la causa senza doverla indovinare.
 */
function erroreVero(e: any): string {
  const c = e?.cause ?? e;
  const parti = [
    c?.code ? `[${c.code}]` : null,
    c?.message ?? e?.message ?? String(e),
    c?.detail ? `— ${c.detail}` : null,
    c?.column ? `(colonna ${c.column})` : null,
    c?.constraint ? `(vincolo ${c.constraint})` : null,
    c?.hint ? `Suggerimento: ${c.hint}` : null,
  ].filter(Boolean);
  return parti.join(" ");
}

/* ── Le coppie di codici ──────────────────────────────────────────────────
 * Il codice corsa dell'AVM e il trip_id del feed non combaciano: l'aggancio
 * ripiega su linea + ora di partenza. Funziona, ma è un riconoscimento, non
 * un'identificazione — e la coppia che produce, che sarebbe la chiave per
 * risolvere il disallineamento una volta per tutte, finora si perdeva.
 *
 * Si raccoglie tutto quello che i due mondi dicono della stessa corsa, così
 * che lo studio possa poi confrontarli senza tornare a interrogare l'AVM.
 * Anche le letture SENZA aggancio: un codice che non porta a nessuna corsa
 * dice quanto una che ci porta, e sono quelle che spiegano perché. */
async function raccogliCodici(
  mapped: MappedVehicle[], index: GtfsIndex, stopTimes: StopTimeCache,
): Promise<number> {
  const tz = index.timeZone ?? "Europe/Rome";
  const ymd = index.tripStarts?.serviceDay ?? serviceDay(tz).ymd;
  const giorno = `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;

  const osservazioni: OsservazioneCodice[] = [];
  let conCodice = 0, agganciati = 0, perId = 0;

  for (const m of mapped) {
    const v = m.siri;
    if (m.tripId) agganciati++;
    if (m.agganciatoCome === "id") perId++;
    if (!v.journeyRef) continue;
    conCodice++;
    osservazioni.push({
      journeyRef: v.journeyRef,
      tripId: m.tripId,
      agganciatoCome: m.agganciatoCome,
      vehicleRef: v.vehicleRef,
      lineRef: v.lineRef,
      publishedLineName: v.publishedLineName,
      routeRef: v.routeRef,
      courseRef: v.courseOfJourneyRef,
      framedRef: v.datedVehicleJourneyRef,
      dataFrameRef: v.dataFrameRef,
      patternRef: v.journeyPatternRef,
      blockRef: v.blockRef,
      partenzaAvm: v.originAimedDeparture ? localHHMM(v.originAimedDeparture, tz) : null,
      destinazioneAvm: v.destinationName,
      routeId: m.routeId,
      partenzaGtfs: m.tripId ? stopTimes.tripSpan.get(m.tripId)?.partenza ?? null : null,
      capolineaGtfs: m.tripId ? index.tripStarts?.headsign.get(m.tripId) ?? null : null,
    });
  }

  return registraCodici(giorno, osservazioni, {
    mezzi: mapped.length, conCodice, agganciati, agganciatiPerId: perId,
  });
}

export interface IngestResult {
  positionsInserted: number;
  tripsOpened: number;
  tripsClosed: number;
  transitsInserted: number;
  /** mezzi il cui salvataggio è fallito: il giro prosegue lo stesso */
  vehiclesFailed: number;
  /** vetture del parco fermo, scartate prima di scrivere */
  vehiclesParked: number;
  /** aperture di corsa rifiutate dal database: non impediscono i transiti */
  corseFallite: number;
  /** corse rimaste aperte da mezzi che hanno smesso di trasmettere, ora chiuse */
  corseAbbandonate: number;
  /** coppie distinte «codice AVM ↔ corsa GTFS» registrate in questo giro */
  coppieCodici: number;
  erroreCorse: string | null;
  /** il primo errore incontrato, per capire perché senza leggere i log */
  firstError: string | null;
  report: MappingReport;
  /** esito del confronto fra quello che l'AVM dichiara e la corsa agganciata */
  agganci: EsitoAggancio[];
  riepilogoAgganci: RiepilogoAgganci;
  /** dove si interrompe la catena che porta a un transito */
  funnel: TransitFunnel;
  /** la stessa cosa, in una frase */
  funnelNota: string;
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
      corseFallite: 0, erroreCorse: null, corseAbbandonate: 0, coppieCodici: 0,
      agganci: [], riepilogoAgganci: riepilogaAgganci([]),
      funnel: { ...emptyFunnel(), inEsercizio: vehicles.length },
      funnelNota: "Nessun feed GTFS attivo: senza orario non c'è nulla a cui "
        + "attribuire i passaggi.",
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

  /* ── Verifica dell'aggancio ────────────────────────────────────────────
   * La corsa è già scelta; qui si controlla la scelta contro quello che l'AVM
   * dichiara per conto suo — linea, capolinea, partenza e arrivo PROGRAMMATI.
   * Va fatto adesso, dopo aver caricato gli orari e prima di scrivere: una
   * corsa smentita non deve arrivare a `stop_transits`, perché una lacuna si
   * riempie domani e uno storico falso no. */
  const agganci = verificaAgganciDelGiro(mapped, index, stopTimes);
  const riepilogo = riepilogaAgganci(agganci);

  /* ── Le coppie di codici ───────────────────────────────────────────────
   * L'aggancio per linea + ora di partenza produce, senza volerlo, la sola
   * cosa che permetta di risolvere il disallineamento fra il codice corsa
   * dell'AVM e il trip_id del feed: la coppia dei due. Finora viveva il tempo
   * di un giro. Qui si conserva, e nient'altro cambia — se la raccolta non
   * riesce l'ingestione prosegue identica. */
  const coppieCodici = await raccogliCodici(mapped, index, stopTimes);

  const daNonScrivere = new Set<string>();
  for (const e of agganci) {
    if (e.verdetto !== "incoerente" || !e.vehicleRef) continue;
    daNonScrivere.add(`${e.vehicleRef}|${e.tripId}`);
    console.warn(`[siri] aggancio scartato — vettura ${e.vehicleRef}, `
      + `corsa ${e.tripId}: ${e.motivo}`);
  }

  /** true = i passaggi di questa vettura su questa corsa non vanno scritti. */
  const aggancioSmentito = (m: MappedVehicle) =>
    !!m.siri.vehicleRef && !!m.tripId
    && daNonScrivere.has(`${m.siri.vehicleRef}|${m.tripId}`);

  let positionsInserted = 0, tripsOpened = 0, tripsClosed = 0, transitsInserted = 0;
  let vehiclesFailed = 0;
  let firstError: string | null = null;
  /* Contati a parte: un rifiuto sulle corse attive non è un mezzo perso, ed
   * era proprio confonderli che nascondeva la causa. */
  let corseFallite = 0;
  let erroreCorse: string | null = null;
  const funnel = emptyFunnel();
  funnel.inEsercizio = mapped.length;
  /* Letto una volta per giro, non per mezzo: la struttura non cambia fra
   * una vettura e l'altra. */
  const idEsplicito = await idNeedsValue("active_trips");

  for (const m of mapped) {
   /* Un mezzo che non si riesce a salvare non deve costare gli altri 367.
    * Senza questo isolamento un solo record difettoso interrompeva il ciclo
    * e sulla mappa comparivano soltanto i mezzi elaborati prima dell'errore
    * — un guasto che si presenta come "pochi autobus", non come un errore. */
   try {
    const v = m.siri;
    const vehicleId = v.vehicleRef ?? null;
    const ts = v.recordedAt ?? new Date();

    /* La posizione c'è quasi sempre, ma non è quasi mai UTILIZZABILE: su 368
     * vetture 298 hanno un errore di monitoraggio (GPRS = niente rete, GPS =
     * niente fix) e la localizzazione risulta scaduta. Le coordinate restano
     * nella risposta, vecchie di ore, e usarle sposta il mezzo dove non è più
     * — con il riconoscimento geometrico, gli fa "attraversare" fermate che
     * non ha mai toccato. */
    const posizioneBuona = positionUsable(v);
    const etaFix = fixAgeSeconds(v);

    /* L'AVM smentisce sé stesso su questa corsa: la POSIZIONE resta un fatto
     * — il mezzo è dove dice di essere — ma l'ATTRIBUZIONE no. Si scrive dove
     * si trova senza dirgli quale corsa sta facendo, e non si apre né la
     * corsa né alcun passaggio. */
    const smentito = aggancioSmentito(m);
    const corsaAttribuibile = smentito ? null : m.tripId;
    if (smentito) funnel.agganciIncoerenti++;

    if (vehicleId) funnel.conMatricola++;
    if (m.tripId) funnel.conCorsaAgganciata++;
    if (posizioneBuona) funnel.conPosizione++;
    else if (v.lat != null) funnel.posizioneScaduta++;
    if (m.nearestStopId) funnel.conFermataAvm++;

    /* 1. Posizione. Dedup su (mezzo, istante): il poller gira più spesso di
     *    quanto l'AVM aggiorni, e senza questo la tabella si riempirebbe di
     *    copie dello stesso rilevamento. */
    if (posizioneBuona && v.lat != null && v.lon != null) {
      const sp = vehicleId ? speedKmh(vehicleId, v.lat, v.lon, ts.getTime()) : null;
      const r = await db.execute<any>(sql`
        INSERT INTO caronte.vehicle_positions
               (vehicle_id, trip_id, ts, lat, lon, nearest_stop_id, speed, heading, source)
        SELECT ${vehicleId}, ${corsaAttribuibile}, ${ts.toISOString()}::timestamptz,
               ${v.lat}, ${v.lon}, ${m.nearestStopId}, ${sp}, ${v.bearing}, ${SOURCE_SIRI}
         WHERE NOT EXISTS (
           SELECT 1 FROM caronte.vehicle_positions p
            WHERE p.vehicle_id IS NOT DISTINCT FROM ${vehicleId}
              AND p.ts = ${ts.toISOString()}::timestamptz)`);
      positionsInserted += (r as any).rowCount ?? 0;
    }

    /* 2. Corsa in servizio. Una sola aperta per mezzo: se l'AVM dichiara una
     *    corsa diversa da quella aperta, la precedente si chiude.
     *
     *    ISOLATA dal resto. Il transito NON dipende dalla corsa aperta: sono
     *    due scritture indipendenti su due tabelle diverse. Finché stavano
     *    nello stesso try, un rifiuto qui faceva saltare tutto il blocco a
     *    valle — e infatti l'imbuto mostrava zero geometria, zero letture
     *    precedenti e zero transiti, che sembravano tre guasti distinti
     *    mentre erano un solo INSERT rifiutato. Un errore su una tabella non
     *    deve spegnere le altre due. */
    if (vehicleId && corsaAttribuibile) {
      try {
        const closed = await db.execute<any>(sql`
          UPDATE caronte.active_trips
             SET ended_at = ${ts.toISOString()}::timestamptz
           WHERE vehicle_id = ${vehicleId} AND ended_at IS NULL
             AND trip_id IS DISTINCT FROM ${m.tripId}`);
        tripsClosed += (closed as any).rowCount ?? 0;

        /* `active_trips.id` è uuid NOT NULL SENZA predefinito — al contrario
         * delle altre due tabelle, che hanno gen_random_uuid(). L'AVM se lo
         * calcola da sé; il nostro INSERT no, e per giorni ogni apertura di
         * corsa è stata rifiutata con 23502. Lo si genera solo dove serve
         * davvero, letto dalla struttura invece che presunto. */
        const opened = idEsplicito
          ? await db.execute<any>(sql`
            INSERT INTO caronte.active_trips
                   (id, trip_id, route_id, vehicle_id, device_id, started_at, source)
            SELECT gen_random_uuid(), ${m.tripId}, ${m.routeId}, ${vehicleId}, ${SOURCE_SIRI},
                   ${(v.originAimedDeparture ?? ts).toISOString()}::timestamptz, ${SOURCE_SIRI}
             WHERE NOT EXISTS (
               SELECT 1 FROM caronte.active_trips a
                WHERE a.vehicle_id = ${vehicleId} AND a.trip_id = ${m.tripId}
                  AND a.ended_at IS NULL)`)
          : await db.execute<any>(sql`
            INSERT INTO caronte.active_trips
                   (trip_id, route_id, vehicle_id, device_id, started_at, source)
            SELECT ${m.tripId}, ${m.routeId}, ${vehicleId}, ${SOURCE_SIRI},
                   ${(v.originAimedDeparture ?? ts).toISOString()}::timestamptz, ${SOURCE_SIRI}
             WHERE NOT EXISTS (
               SELECT 1 FROM caronte.active_trips a
                WHERE a.vehicle_id = ${vehicleId} AND a.trip_id = ${m.tripId}
                  AND a.ended_at IS NULL)`);
        tripsOpened += (opened as any).rowCount ?? 0;
      } catch (e: any) {
        corseFallite++;
        if (!erroreCorse) erroreCorse = `mezzo ${vehicleId}: ${erroreVero(e)}`;
      }
    }

    /* Scrive un passaggio. Il ritardo dichiarato dall'AVM ha la precedenza —
     * è la sua misura ufficiale — ma quando manca lo si calcola dal
     * programmato, altrimenti la colonna Δ resta vuota avendo in mano
     * entrambi i termini del confronto. */
    const scriviTransito = async (
      stopId: string, seq: number | null, scheduled: string | null,
      at: Date, delayDichiarato: number | null, capolineaDiPartenza = false,
    ): Promise<void> => {
      /* Il cancello sta QUI e non ai tre punti di chiamata: i canali di
       * riconoscimento sono tre e cambiano nel tempo, e un controllo
       * ripetuto tre volte è un controllo che prima o poi ne dimentica uno. */
      if (smentito) return;
      const tz = index.timeZone ?? "Europe/Rome";
      const delay = delayDichiarato ?? delayFromSchedule(scheduled, at, tz);
      const r = await db.execute<any>(sql`
        INSERT INTO caronte.stop_transits
               (trip_id, route_id, vehicle_id, device_id, stop_id, stop_seq,
                scheduled, actual_ts, delay_seconds, lat, lon, source)
        SELECT ${m.tripId}, ${m.routeId}, ${vehicleId}, ${SOURCE_SIRI},
               ${stopId}, ${seq}, ${scheduled},
               ${at.toISOString()}::timestamptz, ${delay}, ${v.lat}, ${v.lon}, ${SOURCE_SIRI}
         WHERE NOT EXISTS (
           SELECT 1 FROM caronte.stop_transits s
            WHERE s.trip_id = ${m.tripId} AND s.stop_id = ${stopId}
              AND s.actual_ts > now() - interval '18 hours')`);
      const n = (r as any).rowCount ?? 0;
      if (n > 0) { transitsInserted += n; funnel.inseriti += n; return; }
      funnel.giaPresenti++;

      /* Alla PRIMA fermata l'evento che conta è la partenza, non l'arrivo.
       * Il riconoscimento dalla posizione scatta appena il mezzo entra nel
       * raggio: un autobus che si mette in sosta al capolinea venti minuti
       * prima registrerebbe venti minuti di anticipo, falsando la puntualità
       * di ogni corsa. Finché è ancora lì si aggiorna l'orario, così alla
       * fine resta memorizzato l'istante in cui se n'è andato. */
      if (!capolineaDiPartenza) return;
      await db.execute<any>(sql`
        UPDATE caronte.stop_transits
           SET actual_ts = ${at.toISOString()}::timestamptz,
               delay_seconds = ${delay}
         WHERE trip_id = ${m.tripId} AND stop_id = ${stopId}
           AND actual_ts > now() - interval '18 hours'
           AND actual_ts < ${at.toISOString()}::timestamptz`);
    };

    /* 3a. TRANSITO RICONOSCIUTO DALLA POSIZIONE — il canale principale.
     *
     *     Non dipende da niente che l'AVM debba dichiarare: bastano le
     *     coordinate del mezzo e quelle delle fermate della sua corsa. Se il
     *     mezzo si trova entro il raggio di una fermata del proprio percorso,
     *     da lì sta passando. Riconosce OGNI fermata toccata, non una per
     *     coppia di letture, e continua a funzionare quando MonitoredCall
     *     manca o non si aggancia — che è il caso in cui prima non veniva
     *     acquisito nulla, in silenzio. */
    const fermateCorsa: TripStop[] = m.tripId
      ? (stopTimes.tripStops.get(m.tripId) ?? [])
      : [];
    if (fermateCorsa.length > 0) funnel.conGeometriaFermate++;

    if (vehicleId && m.tripId && posizioneBuona && v.lat != null && v.lon != null
        && fermateCorsa.length > 0) {
      const vicine = stopsAtPosition(v.lat, v.lon, fermateCorsa);
      if (vicine.length > 0) funnel.vicinoAFermata++;
      /* Solo la più vicina: a un incrocio due fermate della stessa corsa
       * possono cadere entrambe nel raggio, e scriverle tutt'e due
       * inventerebbe un passaggio mai avvenuto. */
      const f = vicine[0];
      if (f) {
        funnel.transitiDaPosizione++;
        const primaSeq = Math.min(...fermateCorsa.map(s => s.seq));
        await scriviTransito(
          f.stopId, f.seq, f.scheduled, ts, v.delaySeconds, f.seq === primaSeq,
        );
      }
    }

    /* 3b. TRANSITO DAL CAMBIO DI FERMATA DICHIARATA — secondo canale.
     *
     *     Resta utile dove il feed non ha le coordinate della fermata: il
     *     mezzo puntava ad A e ora punta a B, quindi ha superato A. Il
     *     deduplicatore impedisce che i due canali contino due volte lo
     *     stesso passaggio. */
    if (vehicleId && m.tripId && m.nearestStopId) {
      const cur: VehicleProgress = {
        tripId: m.tripId, stopId: m.nearestStopId,
        delaySeconds: v.delaySeconds, at: ts,
      };
      const precedente = lastProgress.get(vehicleId);
      if (precedente) funnel.conLetturaPrecedente++;
      if (precedente && precedente.tripId === cur.tripId
          && precedente.stopId !== cur.stopId) funnel.fermataCambiata++;
      const ev = detectTransit(precedente, cur);
      lastProgress.set(vehicleId, cur);
      if (ev) {
        funnel.transitiDaCambioFermata++;
        const st = stopTimes.map.get(`${ev.tripId}|${ev.stopId}`);
        await scriviTransito(
          ev.stopId, st?.seq ?? null, st?.scheduled ?? null,
          ev.observedAt, ev.delaySeconds,
        );
      }
    }

    /* 3c. Transiti DICHIARATI dal produttore con l'orario effettivo: quando
     *     ci sono sono i più precisi, perché li ha misurati lui. */
    if (m.tripId) {
      for (const t of m.transits) {
        funnel.transitiDichiarati++;
        await scriviTransito(t.stopId, t.stopSeq, t.scheduled, t.actualTs, t.delaySeconds);
      }
    }
   } catch (e: any) {
     vehiclesFailed++;
     if (!firstError) firstError = `mezzo ${m.siri.vehicleRef ?? "?"}: ${erroreVero(e)}`;
   }
  }

  if (vehiclesFailed > 0) {
    console.warn(`[siri] ${vehiclesFailed} mezzi non salvati su ${mapped.length}. Primo errore: ${firstError}`);
  }

  if (corseFallite > 0) {
    console.warn(`[siri] ${corseFallite} aperture corsa rifiutate. Primo errore: ${erroreCorse}`);
  }

  /* Dopo aver scritto, non prima: una corsa appena aperta in questo giro non
   * deve essere chiusa dalla stessa passata. */
  const corseAbbandonate = await chiudiCorseAbbandonate();
  if (corseAbbandonate > 0) {
    console.warn(`[siri] ${corseAbbandonate} corse chiuse perché il mezzo `
      + `non trasmette da oltre ${ABBANDONO_MIN} minuti.`);
  }

  return {
    positionsInserted, tripsOpened, tripsClosed, transitsInserted,
    vehiclesFailed, vehiclesParked: split.ferme.length, firstError, report,
    corseFallite, erroreCorse, corseAbbandonate, coppieCodici,
    agganci, riepilogoAgganci: riepilogo,
    funnel, funnelNota: explainFunnel(funnel),
  };
}

/* ── Verifica dell'aggancio ───────────────────────────────────────────────
 * Separata dalla scrittura perché serve a due mestieri diversi: all'ingestione
 * per non sporcare lo storico, e a chi guarda la diagnostica per capire di
 * quali dati ci si può fidare. Non tocca il database. */

/** Confronta ogni corsa agganciata con quello che l'AVM dichiara per conto suo. */
export function verificaAgganciDelGiro(
  mapped: MappedVehicle[], index: GtfsIndex, stopTimes: StopTimeCache,
): EsitoAggancio[] {
  const esiti: EsitoAggancio[] = [];
  for (const m of mapped) {
    if (!m.tripId || !m.agganciatoCome) continue;
    const span = stopTimes.tripSpan.get(m.tripId);
    const scheda: SchedaCorsa = {
      tripId: m.tripId,
      routeId: index.tripRoute.get(m.tripId) ?? null,
      partenza: span?.partenza ?? null,
      arrivo: span?.arrivo ?? null,
      capolinea: index.tripStarts?.headsign.get(m.tripId) ?? null,
      fermate: stopTimes.tripStops.get(m.tripId) ?? [],
    };
    esiti.push(verificaAggancio(
      {
        vehicleRef: m.siri.vehicleRef,
        journeyRef: m.siri.journeyRef,
        /* Se la linea l'abbiamo dedotta dalla corsa, non è una dichiarazione
         * dell'AVM e non può confermare nulla. */
        routeIdDichiarato: m.lineaDichiarata ? m.routeId : null,
        destinationName: m.siri.destinationName,
        originAimedDeparture: m.siri.originAimedDeparture,
        destinationAimedArrival: m.siri.destinationAimedArrival,
        lat: m.siri.lat, lon: m.siri.lon,
      },
      scheda, m.agganciatoCome, index.timeZone ?? "Europe/Rome",
    ));
  }
  return esiti;
}

/** Lo stesso controllo, su richiesta e senza scrivere niente. */
export async function auditAgganci(all: SiriVehicle[]): Promise<{
  esiti: EsitoAggancio[]; riepilogo: RiepilogoAgganci; feedMancante: boolean;
}> {
  const vehicles = splitInService(all).inServizio;
  const index = await loadGtfsIndex();
  if (!index) {
    return { esiti: [], riepilogo: riepilogaAgganci([]), feedMancante: true };
  }
  const { mapped } = mapVehicles(vehicles, index);
  const trips = [...new Set(mapped.map(x => x.tripId).filter((x): x is string => !!x))];
  const stopTimes = await loadStopTimeIndex(
    index.feedId, trips, index.tripStarts?.serviceDay ?? "",
  );
  const esiti = verificaAgganciDelGiro(mapped, index, stopTimes);
  return { esiti, riepilogo: riepilogaAgganci(esiti), feedMancante: false };
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

/* ── Corse rimaste aperte ─────────────────────────────────────────────────
 * Una corsa si chiudeva solo in due casi: lo stesso mezzo ne dichiarava
 * un'altra, oppure l'AVM la annullava. Manca il caso più comune di tutti —
 * il mezzo finisce l'ultima corsa della giornata e rientra. Non dichiara
 * niente, smette semplicemente di essere in servizio, e la sua corsa resta
 * aperta per sempre.
 *
 * Si vedeva nei numeri: 28 corse aperte con 9 mezzi in servizio.
 *
 * La mappa live non ne soffriva, perché parte dalle posizioni recenti e quelle
 * righe non ne hanno. Ma restavano a gonfiare la diagnostica, e soprattutto a
 * falsare la durata: quando quel mezzo fosse tornato con un'altra corsa, la
 * vecchia sarebbe stata chiusa con l'ora di ALLORA, producendo una corsa di
 * quindici ore.
 */

/** Oltre questo silenzio la corsa non è più in svolgimento: è finita e basta.
 *  Mezz'ora copre una sosta al capolinea e un buco di copertura, senza
 *  chiudere una corsa che sta ancora andando. */
const ABBANDONO_MIN = 30;

export async function chiudiCorseAbbandonate(): Promise<number> {
  try {
    const filtro = (await hasSourceColumn())
      ? sql`AND a.source = ${SOURCE_SIRI}`
      : sql``;
    /* `ended_at` prende l'ULTIMA posizione nota, non adesso: la corsa è finita
     * quando il mezzo ha smesso di farsi sentire, non quando ce ne siamo
     * accorti. Scrivere `now()` regalerebbe alla corsa tutte le ore di
     * disattenzione. */
    const r = await db.execute<any>(sql`
      UPDATE caronte.active_trips a
         SET ended_at = COALESCE(
               (SELECT max(vp.ts) FROM caronte.vehicle_positions vp
                 WHERE vp.vehicle_id = a.vehicle_id
                   AND vp.trip_id = a.trip_id),
               a.started_at, now())
       WHERE a.ended_at IS NULL
         ${filtro}
         AND NOT EXISTS (
           SELECT 1 FROM caronte.vehicle_positions vp
            WHERE vp.vehicle_id IS NOT DISTINCT FROM a.vehicle_id
              AND vp.ts > now() - (${ABBANDONO_MIN} * interval '1 minute'))`);
    return (r as any).rowCount ?? 0;
  } catch (e: any) {
    /* Non deve costare l'ingestione: una corsa di troppo aperta è un fastidio,
     * un giro perso è un buco nei dati. */
    console.warn("[siri] chiusura corse abbandonate non riuscita:", e?.message ?? e);
    return 0;
  }
}
