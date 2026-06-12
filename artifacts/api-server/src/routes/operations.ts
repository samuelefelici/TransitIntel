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
