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

const router: IRouter = Router();

// Soglie di puntualità (standard TPL: in orario = da 1' di anticipo a 5' di ritardo)
const EARLY_S = -60;
const LATE_S = 300;

// ── Disponibilità schema caronte (cache 60s per non interrogare i cataloghi a ogni poll)
let caronteCheck: { ok: boolean; at: number } | null = null;
async function caronteAvailable(): Promise<boolean> {
  if (caronteCheck && Date.now() - caronteCheck.at < 60_000) return caronteCheck.ok;
  try {
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
        ORDER BY COALESCE(vp.vehicle_id, vp.trip_id), vp.ts DESC
      )
      SELECT l.vehicle_id, l.ts, l.lat, l.lon, l.speed, l.heading, l.nearest_stop_id,
             COALESCE(a.trip_id, l.trip_id)    AS trip_id,
             COALESCE(a.route_id, t.route_id)  AS route_id,
             a.started_at, a.device_id,
             t.trip_headsign,
             r.route_short_name, r.route_long_name, r.route_color,
             s.stop_name AS nearest_stop_name,
             d.delay_seconds AS last_delay_seconds,
             d.actual_ts     AS last_transit_ts,
             d.stop_seq      AS last_stop_seq,
             tot.n_stops     AS total_stops
      FROM latest l
      LEFT JOIN LATERAL (
        SELECT a.trip_id, a.route_id, a.started_at, a.device_id
        FROM caronte.active_trips a
        WHERE a.ended_at IS NULL
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
        SELECT st.delay_seconds, st.actual_ts, st.stop_seq
        FROM caronte.stop_transits st
        WHERE st.trip_id = COALESCE(a.trip_id, l.trip_id)
          AND st.actual_ts > now() - interval '6 hours'
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
        WHERE vp.trip_id = a.trip_id
           OR (a.vehicle_id IS NOT NULL AND vp.vehicle_id = a.vehicle_id)
        ORDER BY vp.ts DESC
        LIMIT 1
      ) p ON true
      WHERE a.ended_at IS NULL
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
      FROM caronte.stop_transits
      WHERE actual_ts >= date_trunc('day', now())
        AND delay_seconds IS NOT NULL
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
      deviceId: v.device_id,
      startedAt: v.started_at,
      lat: v.lat,
      lon: v.lon,
      speed: v.speed,
      heading: v.heading,
      ts: v.ts,
      nearestStopId: v.nearest_stop_id,
      nearestStopName: v.nearest_stop_name,
      delaySeconds: v.last_delay_seconds,
      lastTransitTs: v.last_transit_ts,
      lastStopSeq: v.last_stop_seq,
      totalStops: v.total_stops,
    }));

    res.json({
      caronteAvailable: true,
      generatedAt: new Date().toISOString(),
      windowMinutes,
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
    res.status(500).json({ error: e.message });
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
      WHERE st.actual_ts >= ${date}::date
        AND st.actual_ts < ${date}::date + interval '1 day'
        AND st.delay_seconds IS NOT NULL
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
      WHERE st.actual_ts >= ${date}::date
        AND st.actual_ts < ${date}::date + interval '1 day'
        AND st.delay_seconds IS NOT NULL
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
      WHERE st.actual_ts >= ${date}::date
        AND st.actual_ts < ${date}::date + interval '1 day'
        AND st.delay_seconds IS NOT NULL
      GROUP BY st.stop_id, s.stop_name
      HAVING COUNT(*) >= 3
      ORDER BY AVG(st.delay_seconds) DESC
      LIMIT 10
    `);

    res.json({
      caronteAvailable: true,
      date,
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
    res.status(500).json({ error: e.message });
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
      FROM caronte.stop_transits
      WHERE actual_ts >= date_trunc('day', now()) - (${days} * interval '1 day')
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
    res.status(500).json({ error: e.message });
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
        FROM caronte.stop_transits
        WHERE actual_ts > now() - (${days} * interval '1 day')
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
    res.status(500).json({ error: e.message });
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
    const hourFrom = req.query.hourFrom != null ? Math.min(Math.max(Number(req.query.hourFrom), 0), 23) : null;
    const hourTo = req.query.hourTo != null ? Math.min(Math.max(Number(req.query.hourTo), 1), 24) : null;
    const feedId = await resolveFeedId(req);

    const q = await db.execute<any>(sql`
      WITH t AS (
        SELECT trip_id, route_id, actual_ts::date AS day, stop_seq, actual_ts, scheduled,
               ROW_NUMBER() OVER (PARTITION BY trip_id, actual_ts::date ORDER BY stop_seq ASC)  AS rn_a,
               ROW_NUMBER() OVER (PARTITION BY trip_id, actual_ts::date ORDER BY stop_seq DESC) AS rn_d,
               COUNT(*)    OVER (PARTITION BY trip_id, actual_ts::date) AS n_obs
        FROM caronte.stop_transits
        WHERE actual_ts > now() - (${days} * interval '1 day')
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
      SELECT r.trip_id, r.route_id,
             COUNT(*)::int AS runs,
             MIN(r.start_sched) AS start_sched,
             AVG(r.n_obs)::float AS avg_obs_stops,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY r.obs_s) AS obs_median_s,
             AVG(r.sched_s) FILTER (WHERE r.sched_s IS NOT NULL AND r.sched_s > 0) AS sched_s,
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
      GROUP BY r.trip_id, r.route_id, gt.direction_id, gt.trip_headsign, gt.shape_id,
               gr.route_short_name, gr.route_color, gr.route_long_name, stt.n_stops
      ORDER BY gr.route_short_name NULLS LAST, MIN(r.start_sched)
      LIMIT 3000
    `);

    res.json({
      caronteAvailable: true,
      days, routeId, hourFrom, hourTo,
      trips: q.rows.map((r: any) => {
        const obs = r.obs_median_s != null ? Math.round(Number(r.obs_median_s)) : null;
        const sched = r.sched_s != null ? Math.round(Number(r.sched_s)) : null;
        return {
          tripId: r.trip_id,
          routeId: r.route_id,
          routeShortName: r.route_short_name,
          routeLongName: r.route_long_name,
          routeColor: r.route_color,
          directionId: r.direction_id,
          headsign: r.trip_headsign,
          shapeId: r.shape_id,
          startTime: r.start_sched,            // partenza programmata (primo transito)
          runs: r.runs,                        // giornate osservate
          avgObsStops: r.avg_obs_stops != null ? Math.round(Number(r.avg_obs_stops)) : null,
          totalStops: r.total_stops,
          schedSeconds: sched,
          obsMedianSeconds: obs,
          deltaSeconds: obs != null && sched != null ? obs - sched : null,
          deltaPct: obs != null && sched != null && sched > 0
            ? Math.round(((obs - sched) / sched) * 1000) / 10 : null,
        };
      }),
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
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
        SELECT t.trip_id, t.route_id, t.trip_headsign,
               r.route_short_name, r.route_long_name, r.route_color
        FROM gtfs_trips t
        LEFT JOIN gtfs_routes r ON r.feed_id = t.feed_id AND r.route_id = t.route_id
        WHERE t.feed_id = ${feedId}::uuid AND t.trip_id = ${tripId}
        LIMIT 1
      `);
      tripInfo = tQ.rows[0] ?? null;

      // Tutte le fermate programmate della corsa + (eventuale) transito reale di oggi
      const sQ = await db.execute<any>(sql`
        SELECT stt.stop_sequence AS seq, stt.arrival_time AS scheduled,
               s.stop_id, s.stop_name, s.stop_lat, s.stop_lon,
               tr.actual_ts, tr.delay_seconds
        FROM gtfs_stop_times stt
        LEFT JOIN gtfs_stops s
          ON s.feed_id = stt.feed_id AND s.stop_id = stt.stop_id
        LEFT JOIN LATERAL (
          SELECT actual_ts, delay_seconds
          FROM caronte.stop_transits tr
          WHERE tr.trip_id = ${tripId} AND tr.stop_id = stt.stop_id
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
        FROM caronte.stop_transits
        WHERE trip_id = ${tripId} AND actual_ts >= date_trunc('day', now())
        ORDER BY stop_seq NULLS LAST, actual_ts
      `);
      stops = rawQ.rows;
    }

    res.json({
      caronteAvailable: true,
      trip: tripInfo && {
        tripId: tripInfo.trip_id,
        routeId: tripInfo.route_id,
        headsign: tripInfo.trip_headsign,
        routeShortName: tripInfo.route_short_name,
        routeLongName: tripInfo.route_long_name,
        routeColor: tripInfo.route_color,
      },
      stops: stops.map((s: any) => ({
        seq: s.seq,
        stopId: s.stop_id,
        stopName: s.stop_name,
        lat: s.stop_lat,
        lon: s.stop_lon,
        scheduled: s.scheduled,
        actualTs: s.actual_ts,
        delaySeconds: s.delay_seconds,
      })),
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
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
    const dwellRadius = Math.min(Math.max(Number(req.query.dwellRadius) || 60, 10), 250); // metri
    const dwellSeconds = Math.min(Math.max(Number(req.query.dwellSeconds) || 8, 3), 600); // secondi
    const feedId = await resolveFeedId(req);

    // Giornate con transiti registrati per la corsa (per lo switch nella UI)
    const daysQ = await db.execute<any>(sql`
      SELECT actual_ts::date AS day, COUNT(*)::int AS transits
      FROM caronte.stop_transits
      WHERE trip_id = ${tripId}
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
          FROM caronte.stop_transits
          WHERE trip_id = ${tripId} AND actual_ts::date = ${day}::date
          ORDER BY stop_seq NULLS LAST, actual_ts
        `)).rows
      : [];

    // Posizioni GPS della giornata (per la sosta = fermata effettivamente fatta)
    const posRows = day
      ? (await db.execute<any>(sql`
          SELECT ts, lat, lon, speed
          FROM caronte.vehicle_positions
          WHERE trip_id = ${tripId} AND ts::date = ${day}::date
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
    res.status(500).json({ error: e.message });
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
    const dwellRadius = Math.min(Math.max(Number(req.query.dwellRadius) || 60, 10), 250); // metri
    const dwellSeconds = Math.min(Math.max(Number(req.query.dwellSeconds) || 8, 3), 600); // secondi
    const feedId = await resolveFeedId(req);

    // Aggregati osservati per (corsa, fermata): offset traslato dalla partenza
    // effettiva (actual_ts − primo transito del giorno) e ritardo, mediani.
    const obsQ = await db.execute<any>(sql`
      WITH tr AS (
        SELECT trip_id, route_id, stop_id, stop_seq, delay_seconds, actual_ts,
               actual_ts::date AS day,
               MIN(actual_ts) OVER (PARTITION BY trip_id, actual_ts::date) AS run_start
        FROM caronte.stop_transits
        WHERE actual_ts > now() - (${days} * interval '1 day')
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
          ON vp.trip_id = st.trip_id
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
             COUNT(*)::int AS seen_runs
      FROM per_day
      GROUP BY trip_id, seq
    `);
    const stoppedMap = new Map<string, Map<number, { stoppedRuns: number; seenRuns: number }>>();
    for (const r of dwellQ.rows) {
      if (!stoppedMap.has(r.trip_id)) stoppedMap.set(r.trip_id, new Map());
      stoppedMap.get(r.trip_id)!.set(Number(r.seq), {
        stoppedRuns: Number(r.stopped_runs ?? 0),
        seenRuns: Number(r.seen_runs ?? 0),
      });
    }

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
      const seqs = t.rows.map((r) => ({ ...r, schedSec: hmsToSec(r.scheduled) }));
      const firstSchedSec = seqs.find((r) => r.schedSec != null)?.schedSec ?? null;
      const stops = seqs.map((r) => {
        const o = obs.get(Number(r.seq));
        const dw = stopped.get(Number(r.seq));
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
          stopped: (dw?.stoppedRuns ?? 0) > 0,
          stoppedRuns: dw?.stoppedRuns ?? 0,
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
      return {
        tripId: t.tripId,
        headsign: t.headsign,
        directionId: t.directionId,
        shapeId: t.shapeId,
        runs: tripRuns.get(t.tripId) ?? 0,
        startSchedSec: firstSchedSec,
        coveredStops: withObs.length,
        totalStops: stops.length,
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
    res.status(500).json({ error: e.message });
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
      FROM caronte.vehicle_positions
      WHERE (vehicle_id = ${vehicleId} OR (vehicle_id IS NULL AND trip_id = ${vehicleId}))
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
    res.status(500).json({ error: e.message });
  }
});

export default router;
