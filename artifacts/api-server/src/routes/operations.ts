/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SALA OPERATIVA — monitoraggio live della flotta (lettura schema `caronte`)
 * ───────────────────────────────────────────────────────────────────────────
 * Chiude il cerchio Planning → Scheduling → Esercizio: l'AVM (Caronte) scrive
 * posizioni, corse attive e transiti alle fermate nello schema `caronte`;
 * qui li incrociamo con i gtfs_* per dare al gestionale la vista operativa
 * (mappa live, ritardi, puntualità) che prima mancava.
 *
 *   GET /api/operations/live                       — snapshot flotta + KPI giornata
 *   GET /api/operations/punctuality?date=          — puntualità per linea/ora/fermata
 *   GET /api/operations/trend?days=                — andamento giornaliero OTP
 *   GET /api/operations/trips/:tripId/transits     — programmato vs reale per fermata
 *   GET /api/operations/vehicles/:vehicleId/track  — traccia GPS recente del mezzo
 *
 * Auth: JWT come il resto dell'app (montato dopo requireAuth in routes/index.ts).
 * Se lo schema caronte non è ancora migrato risponde con dataset vuoti e
 * caronteAvailable=false (la UI mostra le istruzioni), mai 500.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { getLatestFeedId } from "./gtfs-helpers";

import { schemaState, hasSourceColumn, SOURCE_SIRI } from "../lib/caronte-schema";
import { delayFromSchedule, scheduledSeconds } from "../lib/siri-vm";
import { completeTransits } from "../lib/transit-completion";
import { analizzaPercorrenze, coperturaFermate, type CorsaOsservata } from "../lib/runtime-analysis";
import { storicoCorsa } from "../lib/segment-history";
import { classifyDate, type CalendarProfile } from "../lib/day-classifier";
import {
  rilevaAnomalie, riepiloga, ETICHETTE,
  sogliaFuoriPercorso, distanzaDalPercorso,
  type CorsaDaEsaminare, type PosizioneMezzo,
} from "../lib/anomaly-detection";
import { loadCalendarProfile } from "../lib/planning-studio-calendar";

const router: IRouter = Router();

/** Fuso dell'azienda: il confronto programmato/reale si fa nell'ora locale. */
const OPERATOR_TZ = process.env.SIRI_TIMEZONE || "Europe/Rome";

/** Un id di progetto malformato non deve arrivare al database come uuid. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* ── Sala Operativa = esercizio da SIRI ───────────────────────────────────
 * Le tabelle `caronte` sono condivise con il sistema AVM, che ci scrive le
 * proprie righe. Mescolarle qui rendeva la pagina illeggibile e, peggio,
 * faceva sembrare vivo un collegamento che non lo era: i transiti mostrati
 * erano dell'AVM mentre SIRI non ne aveva scritto nemmeno uno.
 *
 * Il filtro si applica SOLO se la colonna esiste. Su un database dove la
 * migrazione non è ancora passata filtrare vorrebbe dire non mostrare nulla:
 * meglio una pagina con dati di troppo, dichiarati tali, che una pagina
 * vuota senza spiegazione. */
async function soloSiri(alias: string): Promise<{ filtro: any; attivo: boolean }> {
  if (!(await hasSourceColumn())) return { filtro: sql`TRUE`, attivo: false };
  return {
    filtro: sql`${sql.raw(alias)}.source = ${SOURCE_SIRI}`,
    attivo: true,
  };
}

// Soglie di puntualità (standard TPL: in orario = da 1' di anticipo a 5' di ritardo)
const EARLY_S = -60;
const LATE_S = 300;

// ── Disponibilità schema caronte (cache 60s per non interrogare i cataloghi a ogni poll)
let caronteCheck: { ok: boolean; at: number } | null = null;
async function caronteAvailable(): Promise<boolean> {
  if (caronteCheck && Date.now() - caronteCheck.at < 60_000) return caronteCheck.ok;
  try {
    /* Le tabelle possono esistere ma essere INDIETRO di una colonna: una
     * migrazione non applicata su una tabella creata dal sistema AVM. Con il
     * solo to_regclass il software concludeva "esercizio disponibile" e poi
     * moriva sulla prima query.
     *
     * Qui si LEGGE soltanto: nessun DDL sul percorso di lettura, che gira
     * anche su repliche di sola lettura e su ruoli non proprietari delle
     * tabelle. La riparazione sta sul percorso di scrittura del connettore.
     *
     * Se la rilevazione non riesce (stato ignoto) si ricade sul vecchio
     * controllo delle sole tabelle: mai peggio di prima. */
    const st = await schemaState();
    if (!st.unknown) {
      if (!st.ready) {
        console.warn("[operations] esercizio non disponibile — mancano: "
          + [...st.missingTables, ...st.missingColumns].join(", "));
      }
      caronteCheck = { ok: st.ready, at: Date.now() };
      return st.ready;
    }
    const r = await db.execute<any>(sql`
      SELECT to_regclass('caronte.vehicle_positions') AS vp,
             to_regclass('caronte.active_trips')      AS at,
             to_regclass('caronte.stop_transits')     AS st
    `);
    const row = r.rows[0];
    const ok = !!(row?.vp && row?.at && row?.st);
    caronteCheck = { ok, at: Date.now() };
    return ok;
  } catch {
    caronteCheck = { ok: false, at: Date.now() };
    return false;
  }
}

/** L'errore vero del database, non l'involucro del query builder.
 *  Senza questo un 500 mostra l'intera query e nasconde la causa. */
function dbError(e: any): { error: string; dbCode?: string; dbDetail?: string } {
  const cause = e?.cause ?? e;
  const code = cause?.code ?? e?.code;
  const detail = cause?.message && cause.message !== e?.message ? cause.message : undefined;
  return {
    error: detail ?? e?.message ?? "errore interno",
    dbCode: typeof code === "string" ? code : undefined,
    dbDetail: detail ? e?.message?.slice(0, 400) : undefined,
  };
}

// Feed GTFS per i join (stessa logica di caronte.ts: env override, poi feed attivo)
async function resolveFeedId(req: any): Promise<string | null> {
  if (process.env.GTFS_FEED_ID) return process.env.GTFS_FEED_ID;
  return getLatestFeedId(req);
}

const EMPTY_KPIS = {
  vehiclesActive: 0, tripsActive: 0, transitsToday: 0,
  onTimePct: null as number | null, latePct: null as number | null, earlyPct: null as number | null,
  avgDelaySeconds: null as number | null, medianDelaySeconds: null as number | null,
};

// ── GET /operations/live — snapshot flotta + KPI giornata ────────────────────
router.get("/operations/live", async (req, res): Promise<void> => {
  try {
    if (!(await caronteAvailable())) {
      res.json({ caronteAvailable: false, vehicles: [], tripsWithoutGps: [], kpis: EMPTY_KPIS });
      return;
    }
    const windowMinutes = Math.min(Math.max(Number(req.query.windowMinutes) || 15, 1), 240);
    const feedId = await resolveFeedId(req);
    const vp = await soloSiri("vp");
    const at = await soloSiri("a");
    const st = await soloSiri("st");

    // Ultima posizione per mezzo (chiave: vehicle_id, fallback trip_id) nella
    // finestra, arricchita con corsa attiva, linea, fermata e ultimo ritardo.
    const vehiclesQ = await db.execute<any>(sql`
      WITH latest AS (
        SELECT DISTINCT ON (COALESCE(vp.vehicle_id, vp.trip_id))
               vp.vehicle_id, vp.trip_id, vp.ts, vp.lat, vp.lon, vp.speed,
               vp.heading, vp.nearest_stop_id
        FROM caronte.vehicle_positions vp
        WHERE vp.ts > now() - (${windowMinutes} * interval '1 minute')
          AND (vp.vehicle_id IS NOT NULL OR vp.trip_id IS NOT NULL)
          AND ${vp.filtro}
        ORDER BY COALESCE(vp.vehicle_id, vp.trip_id), vp.ts DESC
      )
      SELECT l.vehicle_id, l.ts, l.lat, l.lon, l.speed, l.heading, l.nearest_stop_id,
             COALESCE(a.trip_id, l.trip_id)    AS trip_id,
             COALESCE(a.route_id, t.route_id)  AS route_id,
             a.started_at, a.device_id,
             t.trip_headsign, t.direction_id, t.shape_id,
             /* Il codice percorso può mancare su installazioni dove la
              * migrazione non è stata applicata: letto dalla riga come JSON,
              * una colonna assente vale NULL invece di far fallire la query
              * e spegnere l'intera Sala Operativa. */
             to_jsonb(t) ->> 'variant_code'  AS variant_code,
             r.route_short_name, r.route_long_name, r.route_color,
             s.stop_name AS nearest_stop_name,
             d.delay_seconds AS last_delay_seconds,
             d.actual_ts     AS last_transit_ts,
             d.scheduled     AS last_scheduled,
             d.stop_seq      AS last_stop_seq,
             tot.n_stops     AS total_stops
      FROM latest l
      LEFT JOIN LATERAL (
        SELECT a.trip_id, a.route_id, a.started_at, a.device_id
        FROM caronte.active_trips a
        WHERE a.ended_at IS NULL
          AND ${at.filtro}
          AND ((l.vehicle_id IS NOT NULL AND a.vehicle_id = l.vehicle_id)
            OR (l.vehicle_id IS NULL AND a.trip_id = l.trip_id))
        ORDER BY a.started_at DESC
        LIMIT 1
      ) a ON true
      LEFT JOIN gtfs_trips t
        ON ${feedId}::text IS NOT NULL AND t.feed_id = ${feedId}::uuid
       AND t.trip_id = COALESCE(a.trip_id, l.trip_id)
      LEFT JOIN gtfs_routes r
        ON ${feedId}::text IS NOT NULL AND r.feed_id = ${feedId}::uuid
       AND r.route_id = COALESCE(a.route_id, t.route_id)
      LEFT JOIN gtfs_stops s
        ON ${feedId}::text IS NOT NULL AND s.feed_id = ${feedId}::uuid
       AND s.stop_id = l.nearest_stop_id
      LEFT JOIN LATERAL (
        SELECT st.delay_seconds, st.actual_ts, st.stop_seq, st.scheduled
        FROM caronte.stop_transits st
        WHERE st.trip_id = COALESCE(a.trip_id, l.trip_id)
          AND st.actual_ts > now() - interval '6 hours'
          AND ${st.filtro}
        ORDER BY st.actual_ts DESC
        LIMIT 1
      ) d ON true
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS n_stops
        FROM gtfs_stop_times stt
        WHERE ${feedId}::text IS NOT NULL AND stt.feed_id = ${feedId}::uuid
          AND stt.trip_id = COALESCE(a.trip_id, l.trip_id)
      ) tot ON true
      ORDER BY l.ts DESC
    `);

    // Corse marcate attive ma senza GPS recente (autista ha avviato, segnale perso)
    const noGpsQ = await db.execute<any>(sql`
      SELECT a.trip_id, a.route_id, a.vehicle_id, a.device_id, a.started_at,
             r.route_short_name, r.route_color, t.trip_headsign,
             p.ts AS last_position_ts
      FROM caronte.active_trips a
      LEFT JOIN gtfs_routes r
        ON ${feedId}::text IS NOT NULL AND r.feed_id = ${feedId}::uuid AND r.route_id = a.route_id
      LEFT JOIN gtfs_trips t
        ON ${feedId}::text IS NOT NULL AND t.feed_id = ${feedId}::uuid AND t.trip_id = a.trip_id
      LEFT JOIN LATERAL (
        SELECT vp.ts FROM caronte.vehicle_positions vp
        WHERE ${vp.filtro}
          AND (vp.trip_id = a.trip_id
            OR (a.vehicle_id IS NOT NULL AND vp.vehicle_id = a.vehicle_id))
        ORDER BY vp.ts DESC
        LIMIT 1
      ) p ON true
      WHERE a.ended_at IS NULL
        AND ${at.filtro}
        AND a.started_at > now() - interval '12 hours'
        AND (p.ts IS NULL OR p.ts <= now() - (${windowMinutes} * interval '1 minute'))
      ORDER BY a.started_at DESC
    `);

    // KPI puntualità della giornata (dai transiti reali alle fermate)
    const kpiQ = await db.execute<any>(sql`
      SELECT COUNT(*)::int AS transits,
             COUNT(*) FILTER (WHERE delay_seconds >  ${LATE_S})::int  AS late,
             COUNT(*) FILTER (WHERE delay_seconds <  ${EARLY_S})::int AS early,
             COUNT(*) FILTER (WHERE delay_seconds BETWEEN ${EARLY_S} AND ${LATE_S})::int AS on_time,
             AVG(delay_seconds)::float AS avg_delay,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY delay_seconds)::float AS median_delay
      FROM caronte.stop_transits st
      WHERE actual_ts >= date_trunc('day', now())
        AND delay_seconds IS NOT NULL
        AND ${st.filtro}
    `);
    const k = kpiQ.rows[0] ?? {};
    const transits = Number(k.transits ?? 0);
    const pct = (n: number) => (transits > 0 ? Math.round((n / transits) * 1000) / 10 : null);

    const vehicles = vehiclesQ.rows.map((v: any) => ({
      vehicleId: v.vehicle_id,
      tripId: v.trip_id,
      routeId: v.route_id,
      routeShortName: v.route_short_name,
      routeLongName: v.route_long_name,
      routeColor: v.route_color,
      headsign: v.trip_headsign,
      /* Identità della corsa: senza questi in Sala Operativa non si sa su
       * quale percorso il mezzo è instradato, né quale corsa dell'orario
       * sta facendo — e quindi non si può risalire al quadro orario. */
      variantCode: v.variant_code ?? null,
      directionId: v.direction_id ?? null,
      shapeId: v.shape_id ?? null,
      deviceId: v.device_id,
      startedAt: v.started_at,
      lat: v.lat,
      lon: v.lon,
      speed: v.speed,
      heading: v.heading,
      ts: v.ts,
      nearestStopId: v.nearest_stop_id,
      nearestStopName: v.nearest_stop_name,
      delaySeconds: v.last_delay_seconds
        ?? delayFromSchedule(v.last_scheduled, v.last_transit_ts, OPERATOR_TZ),
      lastTransitTs: v.last_transit_ts,
      lastScheduled: v.last_scheduled ?? null,
      lastStopSeq: v.last_stop_seq,
      totalStops: v.total_stops,
    }));

    res.json({
      caronteAvailable: true,
      generatedAt: new Date().toISOString(),
      windowMinutes,
      /* Che cosa si sta guardando. Se il filtro non è attivo la pagina mostra
       * anche le righe dell'AVM, e va detto: un dato di provenienza mista
       * presentato come se fosse solo SIRI è ciò che ci ha fatto perdere
       * mezza giornata. */
      sorgente: {
        soloSiri: vp.attivo,
        nota: vp.attivo
          ? undefined
          : "La colonna 'source' non è ancora presente sulle tabelle di esercizio: "
            + "questa pagina sta mostrando anche le righe scritte dall'AVM. Si allinea "
            + "da sé al primo giro del connettore SIRI.",
      },
      vehicles,
      tripsWithoutGps: noGpsQ.rows.map((a: any) => ({
        tripId: a.trip_id,
        routeId: a.route_id,
        routeShortName: a.route_short_name,
        routeColor: a.route_color,
        headsign: a.trip_headsign,
        vehicleId: a.vehicle_id,
        deviceId: a.device_id,
        startedAt: a.started_at,
        lastPositionTs: a.last_position_ts,
      })),
      kpis: {
        vehiclesActive: vehicles.length,
        tripsActive: vehicles.filter((v) => v.tripId).length + noGpsQ.rows.length,
        transitsToday: transits,
        onTimePct: pct(Number(k.on_time ?? 0)),
        latePct: pct(Number(k.late ?? 0)),
        earlyPct: pct(Number(k.early ?? 0)),
        avgDelaySeconds: k.avg_delay != null ? Math.round(Number(k.avg_delay)) : null,
        medianDelaySeconds: k.median_delay != null ? Math.round(Number(k.median_delay)) : null,
      },
    });
  } catch (e: any) {
    res.status(500).json(dbError(e));
  }
});

// ── GET /operations/punctuality?date=YYYY-MM-DD — per linea / ora / fermata ──
router.get("/operations/punctuality", async (req, res): Promise<void> => {
  try {
    if (!(await caronteAvailable())) {
      res.json({ caronteAvailable: false, byRoute: [], byHour: [], worstStops: [] });
      return;
    }
    const dateStr = String(req.query.date ?? "");
    const date = /^\d{4}-\d{2}-\d{2}$/.test(dateStr) ? dateStr : new Date().toISOString().slice(0, 10);
    const feedId = await resolveFeedId(req);
    const fSt = (await soloSiri("st")).filtro;

    /* Due domande diverse sugli stessi transiti, e servono entrambe:
     *  · Sala Operativa chiede "com'è andata OGGI" → un giorno solo;
     *  · Tempi di Percorrenza chiede "come va di solito" → un periodo, per
     *    linea e fascia oraria, perché è su quello che si ritara un orario.
     * Un solo giorno di osservazioni non basta a spostare un orario: il
     * periodo non è un vezzo, è la condizione perché il dato sia usabile. */
    const days = req.query.days != null
      ? Math.min(Math.max(Number(req.query.days) || 14, 1), 90)
      : null;
    const routeId = String(req.query.routeId ?? "") || null;
    const hourFrom = req.query.hourFrom != null ? Math.min(Math.max(Number(req.query.hourFrom), 0), 23) : null;
    const hourTo = req.query.hourTo != null ? Math.min(Math.max(Number(req.query.hourTo), 1), 24) : null;

    const periodo = days != null
      ? sql`st.actual_ts > now() - (${days} * interval '1 day')`
      : sql`st.actual_ts >= ${date}::date AND st.actual_ts < ${date}::date + interval '1 day'`;
    const fLinea = routeId
      ? sql`AND st.route_id = ${routeId}`
      : sql``;
    const fOra = (hourFrom != null && hourTo != null)
      ? sql`AND EXTRACT(HOUR FROM st.actual_ts) >= ${hourFrom}
            AND EXTRACT(HOUR FROM st.actual_ts) <  ${hourTo}`
      : sql``;
    /** Il filtro completo, identico per ogni aggregazione. */
    const dove = sql`${fSt} AND ${periodo} AND st.delay_seconds IS NOT NULL ${fLinea} ${fOra}`;

    const byRouteQ = await db.execute<any>(sql`
      SELECT st.route_id,
             r.route_short_name, r.route_long_name, r.route_color,
             COUNT(*)::int AS transits,
             COUNT(DISTINCT st.trip_id)::int AS trips,
             AVG(st.delay_seconds)::float AS avg_delay,
             MAX(st.delay_seconds)::int AS max_delay,
             (COUNT(*) FILTER (WHERE st.delay_seconds BETWEEN ${EARLY_S} AND ${LATE_S}))::float
               / NULLIF(COUNT(*), 0) * 100 AS on_time_pct
      FROM caronte.stop_transits st
      LEFT JOIN gtfs_routes r
        ON ${feedId}::text IS NOT NULL AND r.feed_id = ${feedId}::uuid AND r.route_id = st.route_id
      WHERE ${dove}
      GROUP BY st.route_id, r.route_short_name, r.route_long_name, r.route_color
      ORDER BY transits DESC
    `);

    const byHourQ = await db.execute<any>(sql`
      SELECT EXTRACT(HOUR FROM st.actual_ts)::int AS hour,
             COUNT(*)::int AS transits,
             AVG(st.delay_seconds)::float AS avg_delay,
             (COUNT(*) FILTER (WHERE st.delay_seconds BETWEEN ${EARLY_S} AND ${LATE_S}))::float
               / NULLIF(COUNT(*), 0) * 100 AS on_time_pct
      FROM caronte.stop_transits st
      WHERE ${dove}
      GROUP BY 1
      ORDER BY 1
    `);

    const worstStopsQ = await db.execute<any>(sql`
      SELECT st.stop_id, s.stop_name,
             COUNT(*)::int AS transits,
             AVG(st.delay_seconds)::float AS avg_delay,
             MAX(st.delay_seconds)::int AS max_delay
      FROM caronte.stop_transits st
      LEFT JOIN gtfs_stops s
        ON ${feedId}::text IS NOT NULL AND s.feed_id = ${feedId}::uuid AND s.stop_id = st.stop_id
      WHERE ${dove}
      GROUP BY st.stop_id, s.stop_name
      HAVING COUNT(*) >= 3
      ORDER BY AVG(st.delay_seconds) DESC
      LIMIT 10
    `);

    /* Puntualità PER CORSA. È il taglio che serve a ritarare un orario: dice
     * quale corsa arriva sistematicamente lunga, non quale linea in media —
     * su una linea con venti corse la media nasconde proprio quelle da
     * correggere. Le corse osservate una volta sola sono rumore, quindi
     * servono almeno due giornate. */
    const byTripQ = days != null
      ? await db.execute<any>(sql`
        SELECT st.trip_id, st.route_id,
               r.route_short_name, r.route_color, t.trip_headsign,
               COUNT(*)::int AS transits,
               COUNT(DISTINCT st.actual_ts::date)::int AS days_seen,
               AVG(st.delay_seconds)::float AS avg_delay,
               MAX(st.delay_seconds)::int AS max_delay,
               MIN(st.delay_seconds)::int AS min_delay,
               (COUNT(*) FILTER (WHERE st.delay_seconds BETWEEN ${EARLY_S} AND ${LATE_S}))::float
                 / NULLIF(COUNT(*), 0) * 100 AS on_time_pct
          FROM caronte.stop_transits st
          LEFT JOIN gtfs_routes r
            ON ${feedId}::text IS NOT NULL AND r.feed_id = ${feedId}::uuid AND r.route_id = st.route_id
          LEFT JOIN gtfs_trips t
            ON ${feedId}::text IS NOT NULL AND t.feed_id = ${feedId}::uuid AND t.trip_id = st.trip_id
         WHERE ${dove}
         GROUP BY st.trip_id, st.route_id, r.route_short_name, r.route_color, t.trip_headsign
        HAVING COUNT(DISTINCT st.actual_ts::date) >= 2
         ORDER BY AVG(st.delay_seconds) DESC
         LIMIT 200`)
      : null;

    res.json({
      caronteAvailable: true,
      date: days == null ? date : undefined,
      giorni: days ?? undefined,
      /* Da dove vengono questi numeri. Dopo aver scoperto che i transiti
       * mostrati erano dell'AVM e non del connettore, l'origine va detta. */
      sorgente: "siri",
      byTrip: (byTripQ?.rows ?? []).map((t: any) => ({
        tripId: t.trip_id,
        routeId: t.route_id,
        routeShortName: t.route_short_name,
        routeColor: t.route_color,
        headsign: t.trip_headsign,
        transits: t.transits,
        daysSeen: t.days_seen,
        avgDelaySeconds: t.avg_delay != null ? Math.round(Number(t.avg_delay)) : null,
        maxDelaySeconds: t.max_delay,
        minDelaySeconds: t.min_delay,
        onTimePct: t.on_time_pct != null ? Math.round(Number(t.on_time_pct) * 10) / 10 : null,
      })),
      byRoute: byRouteQ.rows.map((r: any) => ({
        routeId: r.route_id,
        routeShortName: r.route_short_name,
        routeLongName: r.route_long_name,
        routeColor: r.route_color,
        transits: r.transits,
        trips: r.trips,
        avgDelaySeconds: r.avg_delay != null ? Math.round(Number(r.avg_delay)) : null,
        maxDelaySeconds: r.max_delay,
        onTimePct: r.on_time_pct != null ? Math.round(Number(r.on_time_pct) * 10) / 10 : null,
      })),
      byHour: byHourQ.rows.map((h: any) => ({
        hour: h.hour,
        transits: h.transits,
        avgDelaySeconds: h.avg_delay != null ? Math.round(Number(h.avg_delay)) : null,
        onTimePct: h.on_time_pct != null ? Math.round(Number(h.on_time_pct) * 10) / 10 : null,
      })),
      worstStops: worstStopsQ.rows.map((s: any) => ({
        stopId: s.stop_id,
        stopName: s.stop_name,
        transits: s.transits,
        avgDelaySeconds: s.avg_delay != null ? Math.round(Number(s.avg_delay)) : null,
        maxDelaySeconds: s.max_delay,
      })),
    });
  } catch (e: any) {
    res.status(500).json(dbError(e));
  }
});

/* ═══════════════════════════════════════════════════════════════════════
 * GET /operations/anomalie?date=&days=&routeId=&formato=csv
 * ───────────────────────────────────────────────────────────────────────
 * Che cosa è andato storto, non di quanto. Il resto della pagina misura gli
 * scostamenti; qui si nominano i FATTI: una partenza in anticipo, un mezzo
 * uscito dal percorso, un tratto percorso troppo in fretta.
 *
 * La distinzione conta perché porta ad azioni diverse. Un ritardo si corregge
 * sull'orario, in ufficio. Un anticipo alla partenza o una deviazione si
 * correggono parlando con chi guida — e finché restano dentro una media di
 * puntualità nessuno se ne accorge.
 * ═══════════════════════════════════════════════════════════════════════ */
router.get("/operations/anomalie", async (req, res): Promise<void> => {
  try {
    if (!(await caronteAvailable())) {
      res.json({ caronteAvailable: false, anomalie: [], sintesi: null });
      return;
    }
    const dateStr = String(req.query.date ?? "");
    const date = /^\d{4}-\d{2}-\d{2}$/.test(dateStr) ? dateStr : new Date().toISOString().slice(0, 10);
    const giorni = Math.min(Math.max(Number(req.query.days) || 1, 1), 14);
    const routeId = String(req.query.routeId ?? "") || null;
    const feedId = await resolveFeedId(req);
    const fSt = (await soloSiri("st")).filtro;
    const fVp = (await soloSiri("vp")).filtro;

    if (!feedId) {
      res.json({
        caronteAvailable: true, anomalie: [], sintesi: null,
        nota: "Nessun feed GTFS attivo: senza orario e senza coordinate delle "
          + "fermate non c'è niente con cui confrontare l'esercizio.",
      });
      return;
    }

    /* Le corse osservate nel periodo, con la sequenza programmata COMPLETA:
     * per dire che una fermata è stata saltata bisogna sapere che c'era. */
    const corseQ = await db.execute<any>(sql`
      WITH osservate AS (
        SELECT DISTINCT st.trip_id, st.actual_ts::date AS day
          FROM caronte.stop_transits st
         WHERE ${fSt}
           AND st.actual_ts >= ${date}::date - (${giorni - 1} * interval '1 day')
           AND st.actual_ts <  ${date}::date + interval '1 day'
           AND (${routeId}::text IS NULL OR st.route_id = ${routeId})
      )
      SELECT o.trip_id, o.day::text AS day,
             stt.stop_sequence AS seq, stt.stop_id,
             s.stop_name, s.stop_lat, s.stop_lon,
             COALESCE(stt.arrival_time, stt.departure_time) AS scheduled,
             tr.actual_ts, tr.vehicle_id,
             r.route_short_name, t.shape_id
        FROM osservate o
        JOIN gtfs_stop_times stt
          ON stt.feed_id = ${feedId}::uuid AND stt.trip_id = o.trip_id
        LEFT JOIN gtfs_stops s
          ON s.feed_id = ${feedId}::uuid AND s.stop_id = stt.stop_id
        LEFT JOIN gtfs_trips t
          ON t.feed_id = ${feedId}::uuid AND t.trip_id = o.trip_id
        LEFT JOIN gtfs_routes r
          ON r.feed_id = ${feedId}::uuid AND r.route_id = t.route_id
        LEFT JOIN LATERAL (
          SELECT st.actual_ts, st.vehicle_id
            FROM caronte.stop_transits st
           WHERE ${fSt} AND st.trip_id = o.trip_id AND st.stop_id = stt.stop_id
             AND st.actual_ts::date = o.day
           ORDER BY st.actual_ts LIMIT 1
        ) tr ON true
       ORDER BY o.trip_id, o.day, stt.stop_sequence
       LIMIT 200000`);

    /* Le tracce GPS servono solo al fuori percorso: si caricano una volta e
     * si distribuiscono, invece di interrogare il database per ogni corsa. */
    const posQ = await db.execute<any>(sql`
      SELECT vp.trip_id, vp.ts::date AS day, vp.ts, vp.lat, vp.lon
        FROM caronte.vehicle_positions vp
       WHERE ${fVp}
         AND vp.trip_id IS NOT NULL
         AND vp.ts >= ${date}::date - (${giorni - 1} * interval '1 day')
         AND vp.ts <  ${date}::date + interval '1 day'
         AND vp.lat IS NOT NULL AND vp.lon IS NOT NULL
       ORDER BY vp.trip_id, vp.ts
       LIMIT 200000`);

    const posPerCorsa = new Map<string, PosizioneMezzo[]>();
    for (const p of posQ.rows as any[]) {
      const k = `${p.trip_id}|${typeof p.day === "string" ? p.day : new Date(p.day).toISOString().slice(0, 10)}`;
      const l = posPerCorsa.get(k) ?? [];
      l.push({ ts: new Date(p.ts).toISOString(), lat: Number(p.lat), lon: Number(p.lon) });
      posPerCorsa.set(k, l);
    }

    /* Il percorso VERO delle corse coinvolte. Senza, la distanza si misura
     * dalla spezzata fra le fermate, che taglia le curve: su un'extraurbana
     * con fermate lontane un mezzo perfettamente in linea risulta fuori. */
    const tracciati = await caricaTracciati(
      feedId,
      [...new Set((corseQ.rows as any[]).map(r => r.shape_id).filter(Boolean).map(String))],
    );

    /* Raggruppa le righe in corse. */
    const corse = new Map<string, CorsaDaEsaminare>();
    for (const r of corseQ.rows as any[]) {
      const day = typeof r.day === "string" ? r.day : new Date(r.day).toISOString().slice(0, 10);
      const k = `${r.trip_id}|${day}`;
      let c = corse.get(k);
      if (!c) {
        c = {
          tripId: String(r.trip_id), vehicleId: null,
          routeShortName: r.route_short_name ?? null,
          day, fermate: [], posizioni: posPerCorsa.get(k),
          tracciato: r.shape_id ? tracciati.get(String(r.shape_id)) : undefined,
        };
        corse.set(k, c);
      }
      if (r.vehicle_id && !c.vehicleId) c.vehicleId = String(r.vehicle_id);
      c.fermate.push({
        seq: Number(r.seq ?? 0),
        stopId: String(r.stop_id ?? ""),
        stopName: r.stop_name ?? null,
        lat: r.stop_lat != null ? Number(r.stop_lat) : null,
        lon: r.stop_lon != null ? Number(r.stop_lon) : null,
        scheduledSec: scheduledSeconds(r.scheduled),
        actualTs: r.actual_ts ? new Date(r.actual_ts).toISOString() : null,
        osservato: !!r.actual_ts,
      });
    }

    const anomalie = [...corse.values()]
      .flatMap(c => rilevaAnomalie(c, OPERATOR_TZ))
      .sort((a, b) => b.gravita - a.gravita);
    const sintesi = riepiloga(anomalie);

    /* Export: un elenco di anomalie serve anche fuori dalla pagina — in una
     * riunione, in una mail a chi coordina i turni. */
    if (String(req.query.formato ?? "") === "csv") {
      const intestazione = [
        "giorno", "linea", "corsa", "mezzo", "tipo", "gravita", "confidenza",
        "quando", "dove", "titolo", "dettaglio", "misure",
      ];
      const righe = anomalie.map(a => [
        a.day, a.routeShortName ?? "", a.tripId, a.vehicleId ?? "",
        ETICHETTE[a.tipo], String(a.gravita), a.confidenza,
        a.quando ?? "", a.dove ?? "", a.titolo, a.dettaglio,
        JSON.stringify(a.misure),
      ]);
      const csv = [intestazione, ...righe]
        .map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(";"))
        .join("\r\n");
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition",
        `attachment; filename="anomalie-${date}.csv"`);
      /* BOM: senza, Excel in italiano apre gli accenti sbagliati. */
      res.send("\uFEFF" + csv);
      return;
    }

    res.json({
      caronteAvailable: true,
      date, giorni, routeId,
      corseEsaminate: corse.size,
      sintesi,
      anomalie: anomalie.slice(0, 500),
      troncato: anomalie.length > 500 ? anomalie.length : undefined,
    });
  } catch (e: any) {
    res.status(500).json(dbError(e));
  }
});

// ── GET /operations/trend?days=14 — serie giornaliera OTP / ritardo medio ────
router.get("/operations/trend", async (req, res): Promise<void> => {
  try {
    if (!(await caronteAvailable())) {
      res.json({ caronteAvailable: false, days: [] });
      return;
    }
    const days = Math.min(Math.max(Number(req.query.days) || 14, 1), 90);
    const q = await db.execute<any>(sql`
      SELECT date_trunc('day', actual_ts)::date AS day,
             COUNT(*)::int AS transits,
             COUNT(DISTINCT trip_id)::int AS trips,
             COUNT(DISTINCT COALESCE(vehicle_id, device_id))::int AS vehicles,
             AVG(delay_seconds)::float AS avg_delay,
             (COUNT(*) FILTER (WHERE delay_seconds BETWEEN ${EARLY_S} AND ${LATE_S}))::float
               / NULLIF(COUNT(*), 0) * 100 AS on_time_pct
      FROM caronte.stop_transits st
      WHERE ${(await soloSiri("st")).filtro}
        AND actual_ts >= date_trunc('day', now()) - (${days} * interval '1 day')
        AND delay_seconds IS NOT NULL
      GROUP BY 1
      ORDER BY 1
    `);
    res.json({
      caronteAvailable: true,
      days: q.rows.map((d: any) => ({
        day: d.day,
        transits: d.transits,
        trips: d.trips,
        vehicles: d.vehicles,
        avgDelaySeconds: d.avg_delay != null ? Math.round(Number(d.avg_delay)) : null,
        onTimePct: d.on_time_pct != null ? Math.round(Number(d.on_time_pct) * 10) / 10 : null,
      })),
    });
  } catch (e: any) {
    res.status(500).json(dbError(e));
  }
});

// ── GET /operations/runtimes — tempi di percorrenza automatici per tratta ────
// Dai transiti reali AVM: coppie di fermate consecutive della stessa corsa →
// tempo osservato (mediana e p85) vs programmato, aggregato per linea+tratta.
// È la base per la ritaratura degli orari (TTD).
router.get("/operations/runtimes", async (req, res): Promise<void> => {
  try {
    if (!(await caronteAvailable())) {
      res.json({ caronteAvailable: false, segments: [] });
      return;
    }
    const days = Math.min(Math.max(Number(req.query.days) || 14, 1), 90);
    const routeId = String(req.query.routeId ?? "") || null;
    const fSt = (await soloSiri("st")).filtro;
    const hourFrom = req.query.hourFrom != null ? Math.min(Math.max(Number(req.query.hourFrom), 0), 23) : null;
    const hourTo = req.query.hourTo != null ? Math.min(Math.max(Number(req.query.hourTo), 1), 24) : null;
    const feedId = await resolveFeedId(req);

    const q = await db.execute<any>(sql`
      WITH seq AS (
        SELECT trip_id, route_id, stop_id, stop_seq, actual_ts, scheduled,
               LAG(stop_id)   OVER w AS prev_stop,
               LAG(actual_ts) OVER w AS prev_ts,
               LAG(scheduled) OVER w AS prev_sched,
               LAG(stop_seq)  OVER w AS prev_seq
        FROM caronte.stop_transits st
        WHERE ${fSt}
          AND actual_ts > now() - (${days} * interval '1 day')
          AND stop_seq IS NOT NULL
          AND (${routeId}::text IS NULL OR route_id = ${routeId})
        WINDOW w AS (PARTITION BY trip_id, actual_ts::date ORDER BY stop_seq)
      ),
      pairs AS (
        SELECT route_id, prev_stop AS from_stop, stop_id AS to_stop,
               EXTRACT(EPOCH FROM actual_ts - prev_ts) AS obs_s,
               -- scheduled è testo HH:MM:SS (anche >24h): differenza in secondi
               CASE WHEN scheduled IS NOT NULL AND prev_sched IS NOT NULL THEN
                 (split_part(scheduled,  ':', 1)::int * 3600
                + split_part(scheduled,  ':', 2)::int * 60
                + COALESCE(NULLIF(split_part(scheduled,  ':', 3), ''), '0')::int)
               - (split_part(prev_sched, ':', 1)::int * 3600
                + split_part(prev_sched, ':', 2)::int * 60
                + COALESCE(NULLIF(split_part(prev_sched, ':', 3), ''), '0')::int)
               END AS sched_s
        FROM seq
        WHERE prev_stop IS NOT NULL
          AND stop_seq = prev_seq + 1
          AND EXTRACT(EPOCH FROM actual_ts - prev_ts) BETWEEN 5 AND 3600
          AND (${hourFrom}::int IS NULL OR EXTRACT(HOUR FROM prev_ts) >= ${hourFrom})
          AND (${hourTo}::int IS NULL OR EXTRACT(HOUR FROM prev_ts) < ${hourTo})
      )
      SELECT p.route_id, p.from_stop, p.to_stop,
             COUNT(*)::int AS samples,
             percentile_cont(0.5)  WITHIN GROUP (ORDER BY p.obs_s) AS obs_median_s,
             percentile_cont(0.85) WITHIN GROUP (ORDER BY p.obs_s) AS obs_p85_s,
             AVG(p.sched_s) FILTER (WHERE p.sched_s IS NOT NULL AND p.sched_s >= 0) AS sched_s,
             r.route_short_name, r.route_color,
             sf.stop_name AS from_name, st2.stop_name AS to_name
      FROM pairs p
      LEFT JOIN gtfs_routes r
        ON ${feedId}::text IS NOT NULL AND r.feed_id = ${feedId}::uuid AND r.route_id = p.route_id
      LEFT JOIN gtfs_stops sf
        ON ${feedId}::text IS NOT NULL AND sf.feed_id = ${feedId}::uuid AND sf.stop_id = p.from_stop
      LEFT JOIN gtfs_stops st2
        ON ${feedId}::text IS NOT NULL AND st2.feed_id = ${feedId}::uuid AND st2.stop_id = p.to_stop
      GROUP BY p.route_id, p.from_stop, p.to_stop,
               r.route_short_name, r.route_color, sf.stop_name, st2.stop_name
      HAVING COUNT(*) >= 3
      ORDER BY r.route_short_name NULLS LAST, samples DESC
      LIMIT 1500
    `);

    res.json({
      caronteAvailable: true,
      days, routeId, hourFrom, hourTo,
      segments: q.rows.map((s: any) => {
        const obsMed = s.obs_median_s != null ? Math.round(Number(s.obs_median_s)) : null;
        const sched = s.sched_s != null ? Math.round(Number(s.sched_s)) : null;
        return {
          routeId: s.route_id,
          routeShortName: s.route_short_name,
          routeColor: s.route_color,
          fromStopId: s.from_stop,
          fromStopName: s.from_name,
          toStopId: s.to_stop,
          toStopName: s.to_name,
          samples: s.samples,
          schedSeconds: sched,
          obsMedianSeconds: obsMed,
          obsP85Seconds: s.obs_p85_s != null ? Math.round(Number(s.obs_p85_s)) : null,
          deltaSeconds: obsMed != null && sched != null ? obsMed - sched : null,
          deltaPct: obsMed != null && sched != null && sched > 0
            ? Math.round(((obsMed - sched) / sched) * 1000) / 10 : null,
        };
      }),
    });
  } catch (e: any) {
    res.status(500).json(dbError(e));
  }
});

// ── GET /operations/runtimes/by-trip — classificazione Linea→Percorso→Corsa ──
// Per ogni corsa osservata: tempo capolinea→capolinea (tra primo e ultimo
// transito di ogni giornata) osservato vs programmato, con direzione/headsign
// /shape dal feed attivo per raggruppare in percorsi.
router.get("/operations/runtimes/by-trip", async (req, res): Promise<void> => {
  try {
    if (!(await caronteAvailable())) {
      res.json({ caronteAvailable: false, trips: [] });
      return;
    }
    const days = Math.min(Math.max(Number(req.query.days) || 14, 1), 90);
    const routeId = String(req.query.routeId ?? "") || null;
    const fSt = (await soloSiri("st")).filtro;
    const hourFrom = req.query.hourFrom != null ? Math.min(Math.max(Number(req.query.hourFrom), 0), 23) : null;
    const hourTo = req.query.hourTo != null ? Math.min(Math.max(Number(req.query.hourTo), 1), 24) : null;
    const feedId = await resolveFeedId(req);

    const q = await db.execute<any>(sql`
      WITH t AS (
        SELECT trip_id, route_id, actual_ts::date AS day, stop_seq, actual_ts, scheduled,
               ROW_NUMBER() OVER (PARTITION BY trip_id, actual_ts::date ORDER BY stop_seq ASC)  AS rn_a,
               ROW_NUMBER() OVER (PARTITION BY trip_id, actual_ts::date ORDER BY stop_seq DESC) AS rn_d,
               COUNT(*)    OVER (PARTITION BY trip_id, actual_ts::date) AS n_obs
        FROM caronte.stop_transits st
        WHERE ${fSt}
          AND actual_ts > now() - (${days} * interval '1 day')
          AND stop_seq IS NOT NULL
          AND (${routeId}::text IS NULL OR route_id = ${routeId})
      ),
      runs AS (
        -- una riga per (corsa, giornata): primo e ultimo transito osservati
        SELECT f.trip_id, f.route_id, f.day, f.n_obs,
               f.scheduled AS start_sched,
               EXTRACT(EPOCH FROM l.actual_ts - f.actual_ts) AS obs_s,
               CASE WHEN f.scheduled IS NOT NULL AND l.scheduled IS NOT NULL THEN
                 (split_part(l.scheduled, ':', 1)::int * 3600
                + split_part(l.scheduled, ':', 2)::int * 60
                + COALESCE(NULLIF(split_part(l.scheduled, ':', 3), ''), '0')::int)
               - (split_part(f.scheduled, ':', 1)::int * 3600
                + split_part(f.scheduled, ':', 2)::int * 60
                + COALESCE(NULLIF(split_part(f.scheduled, ':', 3), ''), '0')::int)
               END AS sched_s,
               EXTRACT(HOUR FROM f.actual_ts)::int AS start_hour
        FROM t f
        JOIN t l ON l.trip_id = f.trip_id AND l.day = f.day
        WHERE f.rn_a = 1 AND l.rn_d = 1 AND f.stop_seq < l.stop_seq
      )
      SELECT r.trip_id, r.route_id, r.day, r.n_obs, r.start_sched,
             r.obs_s, r.sched_s,
             gt.direction_id, gt.trip_headsign, gt.shape_id,
             gr.route_short_name, gr.route_color, gr.route_long_name,
             stt.n_stops AS total_stops
      FROM runs r
      LEFT JOIN gtfs_trips gt
        ON ${feedId}::text IS NOT NULL AND gt.feed_id = ${feedId}::uuid AND gt.trip_id = r.trip_id
      LEFT JOIN gtfs_routes gr
        ON ${feedId}::text IS NOT NULL AND gr.feed_id = ${feedId}::uuid
       AND gr.route_id = COALESCE(gt.route_id, r.route_id)
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS n_stops FROM gtfs_stop_times s
        WHERE ${feedId}::text IS NOT NULL AND s.feed_id = ${feedId}::uuid AND s.trip_id = r.trip_id
      ) stt ON true
      WHERE r.obs_s BETWEEN 60 AND 4 * 3600
        AND (${hourFrom}::int IS NULL OR r.start_hour >= ${hourFrom})
        AND (${hourTo}::int IS NULL OR r.start_hour < ${hourTo})
      ORDER BY gr.route_short_name NULLS LAST, r.start_sched, r.day
      LIMIT 60000
    `);

    /* ── Classe di giornata ──────────────────────────────────────────────
     * Mediare un lunedì scolastico con una domenica d'agosto produce un
     * numero che non descrive nessuno dei due giorni. Le corse si aggregano
     * per classe — scuole aperte/chiuse, feriale/sabato, domeniche e rossi —
     * e ogni classe porta il proprio verdetto.
     *
     * Il calendario aziendale sta in un progetto di Planner Studio: se non è
     * indicato si classifica comunque per giorno della settimana e festività
     * nazionali, e si dichiara che scuole aperte/chiuse non è distinguibile.
     * Meglio tre classi corrette che una sola sbagliata. */
    const psProjectId = String(req.query.psProjectId ?? "") || null;
    let profilo: CalendarProfile = { closedPeriods: [], summerPeriod: null, extraHolidays: [] };
    let profiloCaricato = false;
    if (psProjectId && UUID_RE.test(psProjectId)) {
      try { profilo = await loadCalendarProfile(psProjectId); profiloCaricato = true; }
      catch { /* profilo non leggibile: si resta sul calendario civile */ }
    }
    /* La classificazione è pura e costosa quanto basta: una data ricorre su
     * centinaia di corse, quindi si calcola una volta sola. */
    const cacheClassi = new Map<string, { key: string; label: string }>();
    const classifica = (day: string) => {
      let c = cacheClassi.get(day);
      if (!c) {
        const d = classifyDate(day, profilo);
        c = { key: d.key, label: d.label };
        cacheClassi.set(day, c);
      }
      return c;
    };

    /** Anagrafica della corsa: uguale su tutte le sue giornate. */
    const anagrafica = new Map<string, any>();
    const osservate: CorsaOsservata[] = [];
    for (const r of q.rows as any[]) {
      const tripId = String(r.trip_id);
      if (!anagrafica.has(tripId)) anagrafica.set(tripId, r);
      osservate.push({
        tripId,
        day: typeof r.day === "string" ? r.day : new Date(r.day).toISOString().slice(0, 10),
        durataOsservataSec: Math.round(Number(r.obs_s)),
        durataProgrammataSec: r.sched_s != null ? Math.round(Number(r.sched_s)) : null,
        fermateOsservate: Number(r.n_obs ?? 0),
      });
    }

    const gruppi = analizzaPercorrenze(osservate, classifica);
    const pollSec = Number(process.env.SIRI_POLL_SECONDS) || 30;

    res.json({
      caronteAvailable: true,
      days, routeId, hourFrom, hourTo,
      validita: {
        psProjectId: psProjectId ?? undefined,
        profiloCaricato,
        nota: profiloCaricato
          ? "Classi dal calendario aziendale del progetto indicato."
          : "Nessun calendario aziendale indicato: le giornate sono classificate "
            + "per giorno della settimana e festività nazionali, ma scuole aperte "
            + "e scuole chiuse non sono distinguibili. Passa ?psProjectId=… per "
            + "ottenere le classi complete.",
        classiOsservate: [...new Set(gruppi.map(g => g.classeLabel))].sort(),
      },
      /* Una riga per (corsa, classe di giornata): è il taglio su cui si
       * decide se allargare o stringere un orario. */
      corse: gruppi.map(g => {
        const a = anagrafica.get(g.tripId) ?? {};
        const totali = a.total_stops != null ? Number(a.total_stops) : 0;
        return {
          tripId: g.tripId,
          routeId: a.route_id ?? null,
          routeShortName: a.route_short_name ?? null,
          routeLongName: a.route_long_name ?? null,
          routeColor: a.route_color ?? null,
          directionId: a.direction_id ?? null,
          headsign: a.trip_headsign ?? null,
          shapeId: a.shape_id ?? null,
          startTime: a.start_sched ?? null,
          classe: g.classe,
          classeLabel: g.classeLabel,
          giornate: g.giornate,
          schedSeconds: g.durataProgrammataSec,
          obsMedianSeconds: g.medianaSec,
          obsP85Seconds: g.p85Sec,
          obsMinSeconds: g.minSec,
          obsMaxSeconds: g.maxSec,
          deltaSeconds: g.scartoMedianaSec,
          deltaP85Seconds: g.scartoP85Sec,
          deltaPct: g.scartoMedianaSec != null && g.durataProgrammataSec
            ? Math.round((g.scartoMedianaSec / g.durataProgrammataSec) * 1000) / 10
            : null,
          verdetto: g.verdetto,
          correzioneSuggeritaMin: g.correzioneSuggeritaMin,
          motivo: g.motivo,
          /* Quante fermate la corsa tocca davvero, per capire quanto serve.
           * Attenzione a non confondere "non rilevata" con "non servita". */
          fermate: coperturaFermate(totali, g.fermateOsservateMedia, pollSec),
        };
      }),
    });
  } catch (e: any) {
    res.status(500).json(dbError(e));
  }
});

// ── GET /operations/trips/:tripId/transits — programmato vs reale per fermata ─
router.get("/operations/trips/:tripId/transits", async (req, res): Promise<void> => {
  try {
    if (!(await caronteAvailable())) {
      res.json({ caronteAvailable: false, trip: null, stops: [] });
      return;
    }
    const tripId = String(req.params.tripId);
    const feedId = await resolveFeedId(req);

    let tripInfo: any = null;
    let stops: any[] = [];
    if (feedId) {
      const tQ = await db.execute<any>(sql`
        SELECT t.trip_id, t.route_id, t.trip_headsign, t.direction_id, t.shape_id,
               to_jsonb(t) ->> 'variant_code' AS variant_code,
               r.route_short_name, r.route_long_name, r.route_color
        FROM gtfs_trips t
        LEFT JOIN gtfs_routes r ON r.feed_id = t.feed_id AND r.route_id = t.route_id
        WHERE t.feed_id = ${feedId}::uuid AND t.trip_id = ${tripId}
        LIMIT 1
      `);
      tripInfo = tQ.rows[0] ?? null;

      /* Tutte le fermate programmate della corsa + (eventuale) transito di oggi.
       *
       * L'orario si legge da arrival_time CON RIPIEGO su departure_time: nelle
       * fermate intermedie di un orario costruito in Planner Studio è compilato
       * solo il secondo, e leggendo il solo arrivo la colonna "Progr." restava
       * vuota — quindi niente termine di confronto e nessun Δ, su una corsa che
       * in realtà l'orario ce l'ha. È la stessa COALESCE già usata dagli altri
       * due endpoint di questo file e dall'ingestione: qui era l'eccezione. */
      const sQ = await db.execute<any>(sql`
        SELECT stt.stop_sequence AS seq,
               COALESCE(stt.arrival_time, stt.departure_time) AS scheduled,
               s.stop_id, s.stop_name, s.stop_lat, s.stop_lon,
               tr.actual_ts, tr.delay_seconds
        FROM gtfs_stop_times stt
        LEFT JOIN gtfs_stops s
          ON s.feed_id = stt.feed_id AND s.stop_id = stt.stop_id
        LEFT JOIN LATERAL (
          SELECT actual_ts, delay_seconds
          FROM caronte.stop_transits tr
          WHERE ${(await soloSiri("tr")).filtro}
            AND tr.trip_id = ${tripId} AND tr.stop_id = stt.stop_id
            AND tr.actual_ts >= date_trunc('day', now())
          ORDER BY tr.actual_ts DESC
          LIMIT 1
        ) tr ON true
        WHERE stt.feed_id = ${feedId}::uuid AND stt.trip_id = ${tripId}
        ORDER BY stt.stop_sequence
      `);
      stops = sQ.rows;
    }

    // Fallback senza GTFS: mostra i soli transiti registrati
    if (stops.length === 0) {
      const rawQ = await db.execute<any>(sql`
        SELECT stop_seq AS seq, scheduled, stop_id, NULL AS stop_name,
               lat AS stop_lat, lon AS stop_lon, actual_ts, delay_seconds
        FROM caronte.stop_transits st
        WHERE ${(await soloSiri("st")).filtro}
          AND trip_id = ${tripId} AND actual_ts >= date_trunc('day', now())
        ORDER BY stop_seq NULLS LAST, actual_ts
      `);
      stops = rawQ.rows;
    }

    /* Perché una colonna è vuota. Senza questo il confronto programmato/reale
     * che non compare è indistinguibile da un guasto: la corsa non è nel feed,
     * l'orario non c'è, oppure il passaggio non è ancora stato osservato —
     * tre cause diverse che chiedono tre azioni diverse. */
    const conOrario = stops.filter((s: any) => s.scheduled).length;
    const conTransito = stops.filter((s: any) => s.actual_ts).length;
    const diagnosi = {
      fermate: stops.length,
      conOrarioProgrammato: conOrario,
      conTransitoRilevato: conTransito,
      nota:
        stops.length === 0
          ? (tripInfo
            ? "La corsa esiste nel feed ma non ha fermate con orario: non c'è nulla da confrontare."
            : "Corsa non trovata nel feed GTFS attivo: il mezzo è agganciato a un identificativo che il feed non contiene.")
          : conOrario === 0
            ? "Nessuna fermata di questa corsa ha un orario programmato nel feed: "
              + "il confronto non è possibile finché l'orario non viene materializzato."
            : conTransito === 0
              ? "Orario programmato presente, nessun passaggio ancora rilevato: il transito "
                + "nasce quando il mezzo cambia fermata fra due letture consecutive."
              : undefined,
    };

    /* ── Completamento ──────────────────────────────────────────────────
     * Il passaggio si rileva solo dove il mezzo si trova entro il raggio di
     * una fermata NELL'ISTANTE della lettura: a 60 secondi ne salta due o
     * tre per volta, e la corsa esce coi buchi. Per il confronto con il
     * programmato serve invece il tempo a OGNI fermata.
     *
     * Si completa IN LETTURA: nel database restano solo i passaggi davvero
     * osservati, così l'algoritmo può migliorare senza riscrivere il passato
     * e non si perde mai la distinzione fra visto e dedotto. */
    const completato = completeTransits(
      stops.map((s: any) => ({
        seq: Number(s.seq ?? 0),
        stopId: String(s.stop_id ?? ""),
        stopName: s.stop_name ?? null,
        scheduled: s.scheduled ?? null,
      })),
      stops
        .filter((s: any) => s.actual_ts)
        .map((s: any) => ({
          stopId: String(s.stop_id ?? ""),
          actualTs: new Date(s.actual_ts),
          delaySeconds: s.delay_seconds ?? null,
        })),
      OPERATOR_TZ,
    );
    /* Le coordinate non passano dall'algoritmo (non gli servono) ma alla UI
     * sì: si riagganciano per fermata. */
    const coord = new Map(stops.map((s: any) => [String(s.stop_id ?? ""), s]));

    res.json({
      caronteAvailable: true,
      diagnosi,
      /* Quanto di questo profilo è misurato e quanto dedotto. Chi ritara un
       * orario deve saperlo prima di guardare i numeri, non dopo. */
      completamento: {
        osservate: completato.osservate,
        interpolate: completato.interpolate,
        estrapolate: completato.estrapolate,
        scoperte: completato.scoperte,
        coperturaOsservata: completato.coperturaOsservata,
        nota: completato.nota ?? undefined,
      },
      trip: tripInfo && {
        tripId: tripInfo.trip_id,
        routeId: tripInfo.route_id,
        headsign: tripInfo.trip_headsign,
        variantCode: tripInfo.variant_code ?? null,
        directionId: tripInfo.direction_id ?? null,
        shapeId: tripInfo.shape_id ?? null,
        routeShortName: tripInfo.route_short_name,
        routeLongName: tripInfo.route_long_name,
        routeColor: tripInfo.route_color,
      },
      stops: completato.fermate.map(f => {
        const c: any = coord.get(f.stopId) ?? {};
        return {
          seq: f.seq,
          stopId: f.stopId,
          stopName: f.stopName,
          lat: c.stop_lat ?? null,
          lon: c.stop_lon ?? null,
          scheduled: f.scheduled,
          actualTs: f.actualTs ? f.actualTs.toISOString() : null,
          delaySeconds: f.delaySeconds,
          /* "osservato" = il mezzo è stato visto passare; "interpolato" e
           * "estrapolato" = ricostruito da noi. Un orario dedotto presentato
           * come misurato renderebbe inattendibile proprio l'analisi per cui
           * il dato viene raccolto. */
          origine: f.origine,
          /* Da dove viene il ritardo, quando la fermata è osservata. */
          delayOrigin: f.origine !== "osservato"
            ? "ricostruito"
            : (c.delay_seconds != null ? "avm" : "calcolato"),
        };
      }),
    });
  } catch (e: any) {
    res.status(500).json(dbError(e));
  }
});

// ── GET /operations/trips/:tripId/runtime-detail — dettaglio corsa fermata×fermata
// Per una singola corsa (e una giornata specifica, default l'ultima osservata):
//   • per ogni fermata: orario programmato, transito reale, delta (anticipo/ritardo)
//   • per ogni arco fra fermate consecutive: tempo osservato vs programmato + scarto
//   • totali: tempo programmato/osservato, fermate segnalate vs mancanti
//   • "fermate effettivamente fatte": rilevate dalla sosta del mezzo vicino alla
//     fermata (posizione ferma entro un raggio per più di N secondi) anche quando
//     il transito non è stato registrato.
function hmsToSec(t: string | null | undefined): number | null {
  if (!t) return null;
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(String(t));
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3] ?? 0);
}
// distanza approssimata (equirettangolare) in metri — sufficiente a scala fermata
function distM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const rad = Math.PI / 180;
  const x = (lon2 - lon1) * rad * Math.cos(((lat1 + lat2) / 2) * rad);
  const y = (lat2 - lat1) * rad;
  return Math.sqrt(x * x + y * y) * R;
}

router.get("/operations/trips/:tripId/runtime-detail", async (req, res): Promise<void> => {
  try {
    if (!(await caronteAvailable())) {
      res.json({ caronteAvailable: false, trip: null, day: null, availableDays: [], stops: [], totals: null, missing: [] });
      return;
    }
    const tripId = String(req.params.tripId);
    const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 120);
    // GPS = telefono dell'autista: jitter ampio e campioni radi → soglie morbide
    const dwellRadius = Math.min(Math.max(Number(req.query.dwellRadius) || 20, 8), 250); // metri
    const dwellSeconds = Math.min(Math.max(Number(req.query.dwellSeconds) || 8, 3), 600); // secondi
    const feedId = await resolveFeedId(req);
    const fSt = (await soloSiri("st")).filtro;
    const fVp = (await soloSiri("vp")).filtro;

    // Giornate con transiti registrati per la corsa (per lo switch nella UI)
    const daysQ = await db.execute<any>(sql`
      SELECT actual_ts::date AS day, COUNT(*)::int AS transits
      FROM caronte.stop_transits st
      WHERE ${fSt}
        AND trip_id = ${tripId}
        AND actual_ts > now() - (${days} * interval '1 day')
      GROUP BY 1 ORDER BY 1 DESC
    `);
    const availableDays = daysQ.rows.map((r: any) => ({
      day: typeof r.day === "string" ? r.day : new Date(r.day).toISOString().slice(0, 10),
      transits: r.transits,
    }));

    const reqDate = String(req.query.date ?? "");
    const day = /^\d{4}-\d{2}-\d{2}$/.test(reqDate) ? reqDate : (availableDays[0]?.day ?? null);

    // Info corsa
    let tripInfo: any = null;
    if (feedId) {
      const tQ = await db.execute<any>(sql`
        SELECT t.trip_id, t.route_id, t.trip_headsign, t.direction_id, t.shape_id,
               r.route_short_name, r.route_long_name, r.route_color
        FROM gtfs_trips t
        LEFT JOIN gtfs_routes r ON r.feed_id = t.feed_id AND r.route_id = t.route_id
        WHERE t.feed_id = ${feedId}::uuid AND t.trip_id = ${tripId}
        LIMIT 1
      `);
      tripInfo = tQ.rows[0] ?? null;
    }

    // Sequenza programmata (tutte le fermate della corsa)
    const schedRows = feedId
      ? (await db.execute<any>(sql`
          SELECT stt.stop_sequence AS seq, stt.stop_id,
                 COALESCE(stt.arrival_time, stt.departure_time) AS scheduled,
                 s.stop_name, s.stop_lat, s.stop_lon
          FROM gtfs_stop_times stt
          LEFT JOIN gtfs_stops s ON s.feed_id = stt.feed_id AND s.stop_id = stt.stop_id
          WHERE stt.feed_id = ${feedId}::uuid AND stt.trip_id = ${tripId}
          ORDER BY stt.stop_sequence
        `)).rows
      : [];

    // Transiti reali della giornata scelta
    const obsRows = day
      ? (await db.execute<any>(sql`
          SELECT stop_id, stop_seq, actual_ts, delay_seconds, scheduled, lat, lon
          FROM caronte.stop_transits st
          WHERE ${fSt}
            AND trip_id = ${tripId} AND actual_ts::date = ${day}::date
          ORDER BY stop_seq NULLS LAST, actual_ts
        `)).rows
      : [];

    // Posizioni GPS della giornata (per la sosta = fermata effettivamente fatta)
    const posRows = day
      ? (await db.execute<any>(sql`
          SELECT ts, lat, lon, speed
          FROM caronte.vehicle_positions vp
          WHERE ${fVp}
            AND trip_id = ${tripId} AND ts::date = ${day}::date
            AND lat IS NOT NULL AND lon IS NOT NULL
          ORDER BY ts
          LIMIT 30000
        `)).rows
      : [];

    // Indicizza i transiti per stop_seq (preferito) e per stop_id (fallback)
    const obsBySeq = new Map<number, any>();
    const obsById = new Map<string, any>();
    for (const o of obsRows) {
      if (o.stop_seq != null) obsBySeq.set(Number(o.stop_seq), o);
      if (o.stop_id != null && !obsById.has(o.stop_id)) obsById.set(o.stop_id, o);
    }

    // Base = sequenza programmata se disponibile, altrimenti i soli transiti
    type Base = { seq: number; stopId: string; stopName: string | null; lat: number | null; lon: number | null; schedSec: number | null };
    let base: Base[];
    if (schedRows.length > 0) {
      base = schedRows.map((s: any) => ({
        seq: Number(s.seq),
        stopId: s.stop_id,
        stopName: s.stop_name,
        lat: s.stop_lat != null ? Number(s.stop_lat) : null,
        lon: s.stop_lon != null ? Number(s.stop_lon) : null,
        schedSec: hmsToSec(s.scheduled),
      }));
    } else {
      base = obsRows.map((o: any) => ({
        seq: Number(o.stop_seq ?? 0),
        stopId: o.stop_id,
        stopName: null,
        lat: o.lat != null ? Number(o.lat) : null,
        lon: o.lon != null ? Number(o.lon) : null,
        schedSec: hmsToSec(o.scheduled),
      }));
    }

    // Sosta per fermata: tempo massimo in cui il mezzo è rimasto entro dwellRadius.
    // Tolleriamo brevi uscite dal raggio (gapTol) dovute al jitter del GPS del
    // telefono, così una singola lettura sballata non spezza la sosta.
    const gapTol = 20; // secondi di uscita tollerati senza chiudere la sosta
    function dwellAt(lat: number | null, lon: number | null): number | null {
      if (lat == null || lon == null || posRows.length === 0) return null;
      let best = 0;
      let runStart: number | null = null;
      let runEnd: number | null = null;
      let gapStart: number | null = null;
      for (const p of posRows) {
        const pl = p.lat != null ? Number(p.lat) : null;
        const pn = p.lon != null ? Number(p.lon) : null;
        const t = new Date(p.ts).getTime();
        const inside = pl != null && pn != null && distM(lat, lon, pl, pn) <= dwellRadius;
        if (inside) {
          if (runStart == null) runStart = t;
          runEnd = t;
          gapStart = null;
        } else if (runStart != null) {
          if (gapStart == null) gapStart = t;
          if ((t - gapStart) / 1000 > gapTol) {
            best = Math.max(best, (runEnd! - runStart) / 1000);
            runStart = null; runEnd = null; gapStart = null;
          }
        }
      }
      if (runStart != null) best = Math.max(best, (runEnd! - runStart) / 1000);
      return Math.round(best);
    }

    // Errore GPS sistematico: il transito all'ultima fermata (capolinea d'arrivo)
    // non viene quasi mai registrato. Lo stimiamo automaticamente come
    // transito reale alla penultima + minuti programmati penultima→ultima.
    if (base.length >= 2) {
      const lastB = base[base.length - 1];
      const penB = base[base.length - 2];
      const lastObs = (lastB.seq != null && obsBySeq.get(lastB.seq)) || obsById.get(lastB.stopId) || null;
      const penObs = (penB.seq != null && obsBySeq.get(penB.seq)) || obsById.get(penB.stopId) || null;
      if (!lastObs && penObs?.actual_ts && lastB.schedSec != null && penB.schedSec != null && lastB.schedSec >= penB.schedSec) {
        const impMs = new Date(penObs.actual_ts).getTime() + (lastB.schedSec - penB.schedSec) * 1000;
        const synthetic = {
          stop_id: lastB.stopId,
          stop_seq: lastB.seq,
          actual_ts: new Date(impMs).toISOString(),
          delay_seconds: penObs.delay_seconds != null ? Number(penObs.delay_seconds) : null,
          imputed: true,
        };
        if (lastB.seq != null) obsBySeq.set(lastB.seq, synthetic);
        obsById.set(lastB.stopId, synthetic);
      }
    }

    // Costruisci righe per fermata con delta, arco e sosta
    let prevActualMs: number | null = null;
    let prevSchedSec: number | null = null;
    const stops = base.map((b) => {
      const o = (b.seq != null && obsBySeq.get(b.seq)) || obsById.get(b.stopId) || null;
      const actualTs = o?.actual_ts ?? null;
      const actualMs = actualTs ? new Date(actualTs).getTime() : null;
      const delaySeconds = o?.delay_seconds != null ? Number(o.delay_seconds) : null;
      const imputed = !!o?.imputed;
      const recorded = !!o && !imputed;

      // arco osservato (dal transito precedente) e programmato
      const arcObs = actualMs != null && prevActualMs != null ? Math.round((actualMs - prevActualMs) / 1000) : null;
      const arcSched = b.schedSec != null && prevSchedSec != null ? b.schedSec - prevSchedSec : null;
      const arcDelta = arcObs != null && arcSched != null ? arcObs - arcSched : null;

      const dwell = dwellAt(b.lat, b.lon);
      const served = recorded || imputed || (dwell != null && dwell >= dwellSeconds);

      if (actualMs != null) prevActualMs = actualMs;
      if (b.schedSec != null) prevSchedSec = b.schedSec;

      return {
        seq: b.seq,
        stopId: b.stopId,
        stopName: b.stopName,
        lat: b.lat,
        lon: b.lon,
        scheduledSec: b.schedSec,
        actualTs,
        delaySeconds,
        recorded,
        imputed,
        arcSchedSeconds: arcSched,
        arcObsSeconds: arcObs,
        arcDeltaSeconds: arcDelta,
        dwellSeconds: dwell,
        served,
      };
    });

    const recordedCount = stops.filter((s) => s.recorded).length;
    const servedCount = stops.filter((s) => s.served).length;
    const missing = stops.filter((s) => !s.served).map((s) => ({ seq: s.seq, stopId: s.stopId, stopName: s.stopName }));

    // Totali: dal primo all'ultimo transito reale, e dal primo all'ultimo programmato
    const recStops = stops.filter((s) => s.actualTs);
    const obsTotal = recStops.length >= 2
      ? Math.round((new Date(recStops[recStops.length - 1].actualTs!).getTime() - new Date(recStops[0].actualTs!).getTime()) / 1000)
      : null;
    const schedStops = stops.filter((s) => s.scheduledSec != null);
    const schedTotal = schedStops.length >= 2
      ? schedStops[schedStops.length - 1].scheduledSec! - schedStops[0].scheduledSec!
      : null;

    res.json({
      caronteAvailable: true,
      day,
      availableDays,
      dwellRadius,
      dwellSeconds,
      trip: tripInfo && {
        tripId: tripInfo.trip_id,
        routeId: tripInfo.route_id,
        headsign: tripInfo.trip_headsign,
        directionId: tripInfo.direction_id,
        shapeId: tripInfo.shape_id,
        routeShortName: tripInfo.route_short_name,
        routeLongName: tripInfo.route_long_name,
        routeColor: tripInfo.route_color,
      },
      totals: {
        scheduledStops: stops.length,
        recordedStops: recordedCount,
        servedStops: servedCount,
        missingStops: stops.length - servedCount,
        schedTotalSeconds: schedTotal,
        obsTotalSeconds: obsTotal,
        deltaSeconds: obsTotal != null && schedTotal != null ? obsTotal - schedTotal : null,
        gpsPoints: posRows.length,
      },
      stops,
      missing,
    });
  } catch (e: any) {
    res.status(500).json(dbError(e));
  }
});

/* ── Percorso reale della corsa ───────────────────────────────────────────
 * `gtfs_shapes.geojson` è la strada che la corsa dovrebbe fare. Serve in due
 * punti che devono dire la stessa cosa: il rilevamento del fuori percorso e
 * la mappa su cui lo si verifica. Se fossero due letture diverse, la mappa
 * potrebbe assolvere ciò che il registro accusa. */

/** Le coordinate di una geometria GeoJSON, comunque il feed l'abbia scritta. */
export function coordinateDaGeojson(g: any): Array<{ lat: number; lon: number }> | null {
  const geom = g?.type === "Feature" ? g.geometry : g;
  if (!geom) return null;
  const pezzi: number[][][] =
    geom.type === "LineString" && Array.isArray(geom.coordinates) ? [geom.coordinates]
    : geom.type === "MultiLineString" && Array.isArray(geom.coordinates) ? geom.coordinates
    : [];
  /* GeoJSON scrive [lon, lat]: invertirli manda il percorso in Somalia, e il
   * confronto con le posizioni non se ne accorgerebbe — direbbe solo che ogni
   * mezzo è fuori percorso. */
  const punti = pezzi.flat()
    .filter(c => Array.isArray(c) && c.length >= 2
      && Number.isFinite(Number(c[0])) && Number.isFinite(Number(c[1])))
    .map(c => ({ lat: Number(c[1]), lon: Number(c[0]) }));
  return punti.length >= 2 ? punti : null;
}

async function caricaTracciati(
  feedId: string | null, shapeIds: string[],
): Promise<Map<string, Array<{ lat: number; lon: number }>>> {
  const out = new Map<string, Array<{ lat: number; lon: number }>>();
  if (!feedId || shapeIds.length === 0) return out;
  try {
    const r = await db.execute<any>(sql`
      SELECT shape_id, geojson FROM gtfs_shapes
       WHERE feed_id = ${feedId}::uuid
         AND shape_id = ANY(${`{${shapeIds.map(x => '"' + x.replace(/"/g, '\\"') + '"').join(",")}}`}::text[])`);
    for (const x of ((r as any).rows ?? [])) {
      const punti = coordinateDaGeojson(x.geojson);
      if (punti) out.set(String(x.shape_id), punti);
    }
  } catch (e: any) {
    /* Un feed senza gtfs_shapes non deve spegnere il registro anomalie: si
     * ricade sulla spezzata fra le fermate, che è ciò che si faceva prima. */
    console.warn("[operations] percorsi non disponibili:", e?.message ?? e);
  }
  return out;
}

// ── GET /operations/trips/:tripId/percorso?date= — la prova del fuori percorso
/* Il registro dice "fuori percorso, fino a 840 m dal tracciato". È un'accusa
 * al lavoro di qualcuno, e finora chi la leggeva non aveva modo di
 * controllarla: cantiere, deviazione decisa, o salto del GPS si somigliano
 * tutti in un numero. Qui ci sono le due linee da sovrapporre — dove il mezzo
 * è passato davvero e dove sarebbe dovuto passare — e si decide guardando.
 *
 * Dichiara sempre SU COSA la distanza è stata misurata: una spezzata fra
 * fermate lontane taglia le curve, e chi guarda la mappa deve sapere che la
 * linea grigia non è la strada ma la sua corda. */
router.get("/operations/trips/:tripId/percorso", async (req, res): Promise<void> => {
  try {
    if (!(await caronteAvailable())) {
      res.json({ caronteAvailable: false, percorso: null });
      return;
    }
    const tripId = String(req.params.tripId);
    const reqDate = String(req.query.date ?? "");
    const feedId = await resolveFeedId(req);
    const fSt = (await soloSiri("st")).filtro;
    const fVp = (await soloSiri("vp")).filtro;

    const giorniQ = await db.execute<any>(sql`
      SELECT ts::date AS day, COUNT(*)::int AS punti
        FROM caronte.vehicle_positions vp
       WHERE ${fVp} AND trip_id = ${tripId}
         AND ts > now() - interval '60 days'
         AND lat IS NOT NULL AND lon IS NOT NULL
       GROUP BY 1 ORDER BY 1 DESC LIMIT 60`);
    const giorniDisponibili = (giorniQ.rows as any[]).map(r => ({
      day: typeof r.day === "string" ? r.day : new Date(r.day).toISOString().slice(0, 10),
      punti: Number(r.punti),
    }));
    const day = /^\d{4}-\d{2}-\d{2}$/.test(reqDate)
      ? reqDate : (giorniDisponibili[0]?.day ?? null);

    const infoQ = feedId
      ? await db.execute<any>(sql`
          SELECT t.shape_id, t.trip_headsign, r.route_short_name, r.route_color
            FROM gtfs_trips t
            LEFT JOIN gtfs_routes r ON r.feed_id = t.feed_id AND r.route_id = t.route_id
           WHERE t.feed_id = ${feedId}::uuid AND t.trip_id = ${tripId} LIMIT 1`)
      : null;
    const info = (infoQ as any)?.rows?.[0] ?? null;

    const fermateQ = feedId
      ? await db.execute<any>(sql`
          SELECT stt.stop_sequence AS seq, stt.stop_id, s.stop_name, s.stop_lat, s.stop_lon,
                 COALESCE(stt.arrival_time, stt.departure_time) AS scheduled
            FROM gtfs_stop_times stt
            LEFT JOIN gtfs_stops s ON s.feed_id = stt.feed_id AND s.stop_id = stt.stop_id
           WHERE stt.feed_id = ${feedId}::uuid AND stt.trip_id = ${tripId}
           ORDER BY stt.stop_sequence`)
      : null;
    const fermate = ((fermateQ as any)?.rows ?? []).map((r: any) => ({
      seq: Number(r.seq), stopId: String(r.stop_id), stopName: r.stop_name ?? null,
      lat: r.stop_lat != null ? Number(r.stop_lat) : null,
      lon: r.stop_lon != null ? Number(r.stop_lon) : null,
      scheduled: r.scheduled ?? null,
    }));

    const tracciati = await caricaTracciati(feedId, info?.shape_id ? [String(info.shape_id)] : []);
    const tracciato = info?.shape_id ? tracciati.get(String(info.shape_id)) ?? null : null;

    const posQ = day
      ? await db.execute<any>(sql`
          SELECT ts, lat, lon, speed FROM caronte.vehicle_positions vp
           WHERE ${fVp} AND trip_id = ${tripId} AND ts::date = ${day}::date
             AND lat IS NOT NULL AND lon IS NOT NULL
           ORDER BY ts LIMIT 5000`)
      : null;
    const traccia = ((posQ as any)?.rows ?? []).map((r: any) => ({
      ts: new Date(r.ts).toISOString(), lat: Number(r.lat), lon: Number(r.lon),
      speed: r.speed != null ? Number(r.speed) : null,
    }));

    const transitiQ = day
      ? await db.execute<any>(sql`
          SELECT stop_id, actual_ts FROM caronte.stop_transits st
           WHERE ${fSt} AND trip_id = ${tripId} AND actual_ts::date = ${day}::date`)
      : null;
    const osservate = new Set(((transitiQ as any)?.rows ?? []).map((r: any) => String(r.stop_id)));

    /* La stessa regola del registro, non una seconda: se la mappa misurasse
     * diversamente potrebbe assolvere ciò che il registro accusa. */
    const rif = sogliaFuoriPercorso({ fermate, tracciato: tracciato ?? undefined });
    const scostamenti = traccia.map((p: any) => ({
      ...p,
      distanzaM: (() => {
        const d = distanzaDalPercorso(p.lat, p.lon, rif.punti);
        return d == null ? null : Math.round(d);
      })(),
    }));
    const fuori = scostamenti.filter((p: any) => p.distanzaM != null && p.distanzaM > rif.sogliaM);

    res.json({
      caronteAvailable: true, tripId, day, giorniDisponibili,
      linea: info?.route_short_name ?? null,
      colore: info?.route_color ?? null,
      capolinea: info?.trip_headsign ?? null,
      riferimento: {
        tipo: rif.riferimento,
        sogliaM: rif.sogliaM,
        allargata: rif.allargata,
        nota: rif.riferimento === "tracciato"
          ? "La linea grigia è il percorso del feed: la strada vera. La distanza "
            + `è misurata da lì, oltre ${rif.sogliaM} m il mezzo è fuori.`
          : "Il feed non ha il percorso di questa corsa: la linea grigia unisce le "
            + "fermate in linea retta e TAGLIA LE CURVE, quindi non è la strada. "
            + (rif.allargata
              ? `Qui le fermate sono lontane e la soglia è stata portata a ${rif.sogliaM} m, `
                + "ma resta una stima: guarda prima di trarne conclusioni."
              : `Le fermate sono abbastanza vicine perché l'approssimazione regga: soglia ${rif.sogliaM} m.`),
      },
      percorso: tracciato,
      fermate: fermate.map((f: any) => ({ ...f, osservata: osservate.has(f.stopId) })),
      traccia: scostamenti,
      fuoriPercorso: {
        punti: fuori.length,
        distanzaMassimaM: fuori.length ? Math.max(...fuori.map((p: any) => p.distanzaM)) : 0,
      },
    });
  } catch (e: any) {
    res.status(500).json(dbError(e));
  }
});

// ── GET /operations/trips/:tripId/runtime-history — lo storico dietro il verdetto
/* `runtime-detail` mostra UNA giornata: serve a capire cosa è successo ieri.
 * Questo mostra lo STORICO su una classe di giornata — che è ciò su cui il
 * verdetto "troppo stretto / troppo largo" è stato dato, e finora non si
 * poteva guardare. Senza, il verdetto è una cosa da credere sulla fiducia;
 * con, è una tratta con un nome e un numero di minuti.
 *
 * Entrano SOLO i transiti osservati: le fermate ricostruite per interpolazione
 * hanno, per costruzione, il tempo che l'orario concede loro, e mediarle
 * direbbe sempre che l'orario è perfetto. */
router.get("/operations/trips/:tripId/runtime-history", async (req, res): Promise<void> => {
  try {
    if (!(await caronteAvailable())) {
      res.json({ caronteAvailable: false, storico: null });
      return;
    }
    const tripId = String(req.params.tripId);
    const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 180);
    const classe = String(req.query.classe ?? "") || null;
    const feedId = await resolveFeedId(req);
    const fSt = (await soloSiri("st")).filtro;

    const fermateRows = feedId
      ? (await db.execute<any>(sql`
          SELECT stt.stop_sequence AS seq, stt.stop_id,
                 COALESCE(stt.departure_time, stt.arrival_time) AS scheduled,
                 s.stop_name
            FROM gtfs_stop_times stt
            LEFT JOIN gtfs_stops s
                   ON s.feed_id = stt.feed_id AND s.stop_id = stt.stop_id
           WHERE stt.feed_id = ${feedId}::uuid AND stt.trip_id = ${tripId}
           ORDER BY stt.stop_sequence`)).rows
      : [];

    if (fermateRows.length === 0) {
      res.json({
        caronteAvailable: true, tripId, storico: null,
        nota: "Questa corsa non ha fermate nel feed attivo: non c'è un percorso "
          + "su cui riportare lo storico.",
      });
      return;
    }

    const transitiRows = (await db.execute<any>(sql`
      SELECT actual_ts::date AS day, stop_id, stop_seq, actual_ts
        FROM caronte.stop_transits st
       WHERE ${fSt}
         AND trip_id = ${tripId}
         AND actual_ts > now() - (${days} * interval '1 day')
       ORDER BY actual_ts
       LIMIT 20000`)).rows;

    /* Stesso calendario del verdetto di corsa: due risposte diverse sulla
     * stessa domanda sarebbero peggio di nessuna risposta. */
    const psProjectId = String(req.query.psProjectId ?? "") || null;
    let profilo: CalendarProfile = { closedPeriods: [], summerPeriod: null, extraHolidays: [] };
    let profiloCaricato = false;
    if (psProjectId && UUID_RE.test(psProjectId)) {
      try { profilo = await loadCalendarProfile(psProjectId); profiloCaricato = true; }
      catch { /* profilo non leggibile: si resta sul calendario civile */ }
    }
    const cacheClassi = new Map<string, { key: string; label: string }>();
    const classifica = (day: string) => {
      let c = cacheClassi.get(day);
      if (!c) {
        const d = classifyDate(day, profilo);
        c = { key: d.key, label: d.label };
        cacheClassi.set(day, c);
      }
      return c;
    };

    const giorno = (v: any) =>
      typeof v === "string" ? v.slice(0, 10) : new Date(v).toISOString().slice(0, 10);

    const storico = storicoCorsa(
      fermateRows.map((r: any) => ({
        seq: Number(r.seq),
        stopId: String(r.stop_id),
        stopName: r.stop_name ?? null,
        scheduled: r.scheduled ?? null,
      })),
      transitiRows.map((r: any) => ({
        day: giorno(r.day),
        stopId: String(r.stop_id),
        seq: r.stop_seq != null ? Number(r.stop_seq) : null,
        actualTs: new Date(r.actual_ts),
      })),
      classifica, classe, OPERATOR_TZ,
    );

    /* Le altre classi si elencano comunque: sapere che esistono è il modo di
     * accorgersi che il verdetto che si sta guardando non è l'unico. */
    const altreClassi = new Map<string, { classe: string; label: string; giornate: Set<string> }>();
    for (const r of transitiRows as any[]) {
      const d = giorno(r.day);
      const c = classifica(d);
      let a = altreClassi.get(c.key);
      if (!a) { a = { classe: c.key, label: c.label, giornate: new Set() }; altreClassi.set(c.key, a); }
      a.giornate.add(d);
    }

    if (String(req.query.formato ?? "") === "csv") {
      const testata = ["da_seq", "da_fermata", "a_seq", "a_fermata", "fermate_scavalcate",
        "programmato_sec", "giorni", "mediana_sec", "p85_sec", "min_sec", "max_sec",
        "scarto_mediana_sec", "scarto_p85_sec", "verdetto"];
      const righe = storico.tratte.map(t => [
        t.daSeq, t.daNome ?? t.daStopId, t.aSeq, t.aNome ?? t.aStopId, t.fermateScavalcate,
        t.programmatoSec ?? "", t.giorni, t.medianaSec, t.p85Sec, t.minSec, t.maxSec,
        t.scartoMedianaSec ?? "", t.scartoP85Sec ?? "", t.verdetto,
      ]);
      const csv = [testata, ...righe]
        .map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(";"))
        .join("\r\n");
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition",
        `attachment; filename="tratte-${tripId.replace(/[^\w.-]+/g, "_")}.csv"`);
      res.send("﻿" + csv);
      return;
    }

    res.json({
      caronteAvailable: true, tripId, days,
      validita: {
        psProjectId: psProjectId ?? undefined,
        profiloCaricato,
        nota: profiloCaricato
          ? "Classi di giornata dal calendario aziendale del progetto indicato."
          : "Senza progetto Planner Studio le classi si basano su giorno della "
            + "settimana e festività nazionali: scuole aperte e chiuse non sono "
            + "distinguibili.",
      },
      classiDisponibili: [...altreClassi.values()]
        .map(a => ({ classe: a.classe, label: a.label, giornate: a.giornate.size }))
        .sort((a, b) => b.giornate - a.giornate),
      storico,
    });
  } catch (e: any) {
    res.status(500).json(dbError(e));
  }
});

// ── GET /operations/runtimes/export — dataset completo per report ────────────
// Per ogni linea e ogni corsa: profilo dei tempi di percorrenza fermata×fermata.
// Oltre ai tempi effettivi (mediana sui giorni) calcola i tempi "traslati"
// rispetto alla partenza effettiva dal capolinea (offset dalla prima fermata),
// che rappresentano l'orario corretto da riportare nel programma di esercizio.
router.get("/operations/runtimes/export", async (req, res): Promise<void> => {
  try {
    if (!(await caronteAvailable())) {
      res.json({ caronteAvailable: false, routes: [] });
      return;
    }
    const days = Math.min(Math.max(Number(req.query.days) || 14, 1), 120);
    const routeId = String(req.query.routeId ?? "") || null;
    const hourFrom = req.query.hourFrom != null ? Math.min(Math.max(Number(req.query.hourFrom), 0), 23) : null;
    const hourTo = req.query.hourTo != null ? Math.min(Math.max(Number(req.query.hourTo), 1), 24) : null;
    const dwellRadius = Math.min(Math.max(Number(req.query.dwellRadius) || 20, 8), 250); // metri
    const dwellSeconds = Math.min(Math.max(Number(req.query.dwellSeconds) || 8, 3), 600); // secondi
    const feedId = await resolveFeedId(req);
    const fSt = (await soloSiri("st")).filtro;
    const fVp = (await soloSiri("vp")).filtro;

    // Aggregati osservati per (corsa, fermata): offset traslato dalla partenza
    // effettiva (actual_ts − primo transito del giorno) e ritardo, mediani.
    const obsQ = await db.execute<any>(sql`
      WITH tr AS (
        SELECT trip_id, route_id, stop_id, stop_seq, delay_seconds, actual_ts,
               actual_ts::date AS day,
               MIN(actual_ts) OVER (PARTITION BY trip_id, actual_ts::date) AS run_start
        FROM caronte.stop_transits st
        WHERE ${fSt}
          AND actual_ts > now() - (${days} * interval '1 day')
          AND stop_seq IS NOT NULL
          AND (${routeId}::text IS NULL OR route_id = ${routeId})
          AND (${hourFrom}::int IS NULL OR EXTRACT(HOUR FROM actual_ts) >= ${hourFrom})
          AND (${hourTo}::int IS NULL OR EXTRACT(HOUR FROM actual_ts) < ${hourTo})
      )
      SELECT trip_id, route_id, stop_seq,
             MAX(stop_id) AS stop_id,
             COUNT(*)::int AS samples,
             COUNT(DISTINCT day)::int AS runs,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM actual_ts - run_start)) AS obs_offset_s,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY delay_seconds) AS median_delay
      FROM tr
      GROUP BY trip_id, route_id, stop_seq
    `);

    // Mappa osservati per corsa → seq
    const obsByTrip = new Map<string, Map<number, any>>();
    const tripRuns = new Map<string, number>();
    for (const r of obsQ.rows) {
      const tid = r.trip_id;
      if (!obsByTrip.has(tid)) obsByTrip.set(tid, new Map());
      obsByTrip.get(tid)!.set(Number(r.stop_seq), r);
      tripRuns.set(tid, Math.max(tripRuns.get(tid) ?? 0, Number(r.runs ?? 0)));
    }
    const tripIds = [...obsByTrip.keys()].slice(0, 2000);
    if (tripIds.length === 0 || !feedId) {
      res.json({ caronteAvailable: true, days, routeId, generatedAt: new Date().toISOString(), routes: [] });
      return;
    }

    // Sequenza programmata + metadati dal feed attivo per le corse osservate
    const idsCsv = tripIds.join("");
    const schedQ = await db.execute<any>(sql`
      SELECT stt.trip_id, stt.stop_sequence AS seq, stt.stop_id,
             COALESCE(stt.arrival_time, stt.departure_time) AS scheduled,
             s.stop_name,
             t.trip_headsign, t.direction_id, t.shape_id, t.route_id,
             r.route_short_name, r.route_long_name, r.route_color
      FROM gtfs_stop_times stt
      JOIN gtfs_trips t  ON t.feed_id = stt.feed_id AND t.trip_id = stt.trip_id
      LEFT JOIN gtfs_routes r ON r.feed_id = t.feed_id AND r.route_id = t.route_id
      LEFT JOIN gtfs_stops s  ON s.feed_id = stt.feed_id AND s.stop_id = stt.stop_id
      WHERE stt.feed_id = ${feedId}::uuid
        AND stt.trip_id = ANY(string_to_array(${idsCsv}, chr(31)))
      ORDER BY stt.trip_id, stt.stop_sequence
    `);

    // Fermate effettivamente FATTE = il mezzo si è fermato vicino alla fermata.
    // Dalla posizione GPS: per ogni (corsa, fermata, giorno) il mezzo è "fermo"
    // se è rimasto entro dwellRadius per ≥ dwellSeconds, oppure con velocità ~0.
    const dwellQ = await db.execute<any>(sql`
      WITH stops AS (
        SELECT st.trip_id, st.stop_sequence AS seq,
               s.stop_lat::float AS lat, s.stop_lon::float AS lon
        FROM gtfs_stop_times st
        JOIN gtfs_stops s ON s.feed_id = st.feed_id AND s.stop_id = st.stop_id
        WHERE st.feed_id = ${feedId}::uuid
          AND st.trip_id = ANY(string_to_array(${idsCsv}, chr(31)))
          AND s.stop_lat IS NOT NULL AND s.stop_lon IS NOT NULL
      ),
      hits AS (
        SELECT st.trip_id, st.seq, vp.ts::date AS day, vp.ts, vp.speed
        FROM stops st
        JOIN caronte.vehicle_positions vp
          ON ${fVp}
         AND vp.trip_id = st.trip_id
         AND vp.ts > now() - (${days} * interval '1 day')
         AND vp.lat IS NOT NULL AND vp.lon IS NOT NULL
         AND vp.lat BETWEEN st.lat - (${dwellRadius}::float / 111320.0)
                        AND st.lat + (${dwellRadius}::float / 111320.0)
         AND vp.lon BETWEEN st.lon - (${dwellRadius}::float / (111320.0 * cos(radians(st.lat))))
                        AND st.lon + (${dwellRadius}::float / (111320.0 * cos(radians(st.lat))))
         AND 6371000.0 * sqrt(
               power(radians(vp.lat - st.lat), 2) +
               power(radians(vp.lon - st.lon) * cos(radians((vp.lat + st.lat) / 2.0)), 2)
             ) <= ${dwellRadius}::float
      ),
      per_day AS (
        SELECT trip_id, seq, day,
               EXTRACT(EPOCH FROM (MAX(ts) - MIN(ts))) AS span_s,
               MIN(speed) AS min_speed
        FROM hits
        GROUP BY trip_id, seq, day
      )
      SELECT trip_id, seq,
             COUNT(*) FILTER (WHERE span_s >= ${dwellSeconds} OR min_speed <= 3)::int AS stopped_runs,
             COUNT(*)::int AS seen_runs,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY span_s)
               FILTER (WHERE span_s >= ${dwellSeconds} OR min_speed <= 3) AS dwell_median_s
      FROM per_day
      GROUP BY trip_id, seq
    `);
    const stoppedMap = new Map<string, Map<number, { stoppedRuns: number; seenRuns: number; dwellSec: number | null }>>();
    for (const r of dwellQ.rows) {
      if (!stoppedMap.has(r.trip_id)) stoppedMap.set(r.trip_id, new Map());
      stoppedMap.get(r.trip_id)!.set(Number(r.seq), {
        stoppedRuns: Number(r.stopped_runs ?? 0),
        seenRuns: Number(r.seen_runs ?? 0),
        dwellSec: r.dwell_median_s != null ? Math.round(Number(r.dwell_median_s)) : null,
      });
    }

    // Numero di corse (giorni) con dati GPS per ogni trip → denominatore della
    // percentuale di fermate fatte (analisi su più rilevazioni).
    const gpsDaysQ = await db.execute<any>(sql`
      SELECT trip_id, COUNT(DISTINCT ts::date)::int AS gps_days
      FROM caronte.vehicle_positions vp
      WHERE ${fVp}
        AND ts > now() - (${days} * interval '1 day')
        AND trip_id = ANY(string_to_array(${idsCsv}, chr(31)))
      GROUP BY trip_id
    `);
    const gpsDaysMap = new Map<string, number>();
    for (const r of gpsDaysQ.rows) gpsDaysMap.set(r.trip_id, Number(r.gps_days ?? 0));

    // Raggruppa per corsa
    interface TripAgg {
      tripId: string; routeId: string | null; headsign: string | null;
      directionId: number | null; shapeId: string | null;
      routeShortName: string | null; routeLongName: string | null; routeColor: string | null;
      rows: any[];
    }
    const tripsMap = new Map<string, TripAgg>();
    for (const row of schedQ.rows) {
      let t = tripsMap.get(row.trip_id);
      if (!t) {
        t = {
          tripId: row.trip_id, routeId: row.route_id, headsign: row.trip_headsign,
          directionId: row.direction_id, shapeId: row.shape_id,
          routeShortName: row.route_short_name, routeLongName: row.route_long_name, routeColor: row.route_color,
          rows: [],
        };
        tripsMap.set(row.trip_id, t);
      }
      t.rows.push(row);
    }

    // Costruisci profilo per corsa con tempi effettivi e traslati
    type TripOut = ReturnType<typeof buildTrip>;
    function buildTrip(t: TripAgg) {
      const obs = obsByTrip.get(t.tripId) ?? new Map();
      const stopped = stoppedMap.get(t.tripId) ?? new Map();
      const gpsRuns = gpsDaysMap.get(t.tripId) ?? 0;
      const seqs = t.rows.map((r) => ({ ...r, schedSec: hmsToSec(r.scheduled) }));
      const firstSchedSec = seqs.find((r) => r.schedSec != null)?.schedSec ?? null;
      const stops = seqs.map((r) => {
        const o = obs.get(Number(r.seq));
        const dw = stopped.get(Number(r.seq));
        const stoppedRuns = dw?.stoppedRuns ?? 0;
        const obsOffset = o?.obs_offset_s != null ? Math.round(Number(o.obs_offset_s)) : null; // traslato dalla partenza
        const schedOffset = r.schedSec != null && firstSchedSec != null ? r.schedSec - firstSchedSec : null;
        return {
          seq: Number(r.seq),
          stopId: r.stop_id,
          stopName: r.stop_name,
          scheduledSec: r.schedSec,
          schedOffsetSec: schedOffset,           // cumulato programmato dalla partenza
          obsOffsetSec: obsOffset,               // cumulato reale traslato dalla partenza
          medianDelaySec: o?.median_delay != null ? Math.round(Number(o.median_delay)) : null,
          samples: o?.samples ?? 0,
          // fermata FATTA = il mezzo si è fermato (sosta GPS) in almeno una corsa
          stopped: stoppedRuns > 0,
          stoppedRuns,
          totalRuns: gpsRuns,                    // corse osservate (denominatore %)
          stoppedPct: gpsRuns > 0 ? Math.round((stoppedRuns / gpsRuns) * 100) : null,
          dwellSec: dw?.dwellSec ?? null,        // tempo di fermata (mediana sulle corse)
          // orario corretto proposto = partenza programmata + tempo reale traslato
          proposedSec: obsOffset != null && firstSchedSec != null ? firstSchedSec + obsOffset : null,
        };
      });
      // archi
      for (let i = 0; i < stops.length; i++) {
        const cur = stops[i] as any;
        const prev = i > 0 ? (stops[i - 1] as any) : null;
        cur.arcSchedSec = prev && cur.schedOffsetSec != null && prev.schedOffsetSec != null ? cur.schedOffsetSec - prev.schedOffsetSec : null;
        cur.arcObsSec = prev && cur.obsOffsetSec != null && prev.obsOffsetSec != null ? cur.obsOffsetSec - prev.obsOffsetSec : null;
        cur.arcDeltaSec = cur.arcSchedSec != null && cur.arcObsSec != null ? cur.arcObsSec - cur.arcSchedSec : null;
      }
      const withObs = stops.filter((s) => s.obsOffsetSec != null);
      const totalObsSec = withObs.length ? withObs[withObs.length - 1].obsOffsetSec : null;
      const totalSchedSec = stops.length ? stops[stops.length - 1].schedOffsetSec : null;
      // Analisi fermate fatte su più rilevazioni
      const servedStops = stops.filter((s) => s.stopped).length;
      const sumStoppedRuns = stops.reduce((a, s) => a + s.stoppedRuns, 0);
      const servedPct = stops.length > 0 && gpsRuns > 0
        ? Math.round((sumStoppedRuns / (stops.length * gpsRuns)) * 100) : null;
      const dwells = stops.map((s) => s.dwellSec).filter((x): x is number => x != null);
      const avgDwellSec = dwells.length ? Math.round(dwells.reduce((a, b) => a + b, 0) / dwells.length) : null;
      return {
        tripId: t.tripId,
        headsign: t.headsign,
        directionId: t.directionId,
        shapeId: t.shapeId,
        runs: tripRuns.get(t.tripId) ?? 0,
        gpsRuns,                                 // corse con dati GPS (base dell'analisi)
        startSchedSec: firstSchedSec,
        coveredStops: withObs.length,
        totalStops: stops.length,
        servedStops,                             // fermate fatte almeno una volta
        servedPct,                               // % media fermate fatte (su tutte le rilevazioni)
        avgDwellSec,                             // tempo medio di fermata
        totalSchedSec,
        totalObsSec,
        totalDeltaSec: totalObsSec != null && totalSchedSec != null ? totalObsSec - totalSchedSec : null,
        stops,
      };
    }

    // Raggruppa per linea
    const routesMap = new Map<string, {
      routeId: string | null; routeShortName: string | null; routeLongName: string | null; routeColor: string | null;
      trips: TripOut[];
    }>();
    for (const t of tripsMap.values()) {
      const rk = t.routeId ?? "?";
      let r = routesMap.get(rk);
      if (!r) {
        r = { routeId: t.routeId, routeShortName: t.routeShortName, routeLongName: t.routeLongName, routeColor: t.routeColor, trips: [] };
        routesMap.set(rk, r);
      }
      r.trips.push(buildTrip(t));
    }

    const routes = [...routesMap.values()]
      .map((r) => ({
        ...r,
        trips: r.trips.sort((a, b) => (a.startSchedSec ?? 1e9) - (b.startSchedSec ?? 1e9)),
      }))
      .sort((a, b) => String(a.routeShortName ?? "").localeCompare(String(b.routeShortName ?? ""), "it", { numeric: true }));

    res.json({
      caronteAvailable: true,
      days, routeId, hourFrom, hourTo,
      generatedAt: new Date().toISOString(),
      routes,
    });
  } catch (e: any) {
    res.status(500).json(dbError(e));
  }
});

// ── GET /operations/vehicles/:vehicleId/track?minutes=60 — traccia GPS ───────
router.get("/operations/vehicles/:vehicleId/track", async (req, res): Promise<void> => {
  try {
    if (!(await caronteAvailable())) {
      res.json({ caronteAvailable: false, points: [] });
      return;
    }
    const vehicleId = String(req.params.vehicleId);
    const minutes = Math.min(Math.max(Number(req.query.minutes) || 60, 1), 24 * 60);
    // La chiave flotta è vehicle_id, ma i mezzi senza matricola configurata
    // vengono tracciati per trip_id (stessa convenzione di /operations/live).
    const q = await db.execute<any>(sql`
      SELECT ts, lat, lon, speed, heading, trip_id
      FROM caronte.vehicle_positions vp
      WHERE ${(await soloSiri("vp")).filtro}
        AND (vehicle_id = ${vehicleId} OR (vehicle_id IS NULL AND trip_id = ${vehicleId}))
        AND ts > now() - (${minutes} * interval '1 minute')
      ORDER BY ts ASC
      LIMIT 5000
    `);
    res.json({
      caronteAvailable: true,
      vehicleId,
      points: q.rows.map((p: any) => ({
        ts: p.ts, lat: p.lat, lon: p.lon, speed: p.speed, heading: p.heading, tripId: p.trip_id,
      })),
    });
  } catch (e: any) {
    res.status(500).json(dbError(e));
  }
});

export default router;
