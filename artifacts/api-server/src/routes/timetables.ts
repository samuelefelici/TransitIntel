/**
 * ═══════════════════════════════════════════════════════════════════════════
 * STAMPA ORARI — quadri di fermata e orari generali di linea
 * ───────────────────────────────────────────────────────────────────────────
 * Output cartacei del programma di esercizio operativo (feed GTFS attivo):
 *
 *   GET /api/timetables/stops/search?q=             — picker fermate
 *   GET /api/timetables/stop/:stopId?dayType=       — quadro di fermata
 *                                                     (per linea: ore × minuti)
 *   GET /api/timetables/route/:routeId?dayType=&directionId=
 *                                                   — orario generale di linea
 *                                                     (fermate × corse)
 *
 * dayType: weekday | saturday | sunday (classificazione da gtfs_calendar /
 * calendar_dates via buildServiceDayMap). feedId opzionale: default il feed
 * attivo (= programma di esercizio operativo).
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { getLatestFeedId, buildServiceDayMap } from "./gtfs-helpers";
import { mergeStopPatterns } from "../lib/timetable-merge";
import { loadCalendarProfile } from "../lib/planning-studio-calendar";
import { resolveValidityServiceFilter, type Validity } from "../lib/timetable-validity";

const router: IRouter = Router();

type DayType = "weekday" | "saturday" | "sunday";
function parseDayType(q: unknown): DayType {
  const s = String(q ?? "weekday");
  return s === "saturday" || s === "sunday" ? s : "weekday";
}

const UUID_RE = /^[0-9a-f-]{36}$/i;

/**
 * Risolve il filtro validità (scuole aperte/chiuse) dai query param della richiesta.
 * Richiede sia `validity` sia `projectId` (calendario del progetto PS); altrimenti
 * ritorna serviceIds null → il chiamante usa il fallback per dayType.
 */
async function validityFilterFromReq(
  feedId: string, dayType: DayType, q: any,
): Promise<{ serviceIds: Set<string> | null; representativeDate: string | null; note?: string; validity: Validity | null }> {
  const validity: Validity | null =
    q?.validity === "scuole_aperte" || q?.validity === "scuole_chiuse" ? q.validity : null;
  const projectId = String(q?.projectId ?? "");
  if (!validity || !UUID_RE.test(projectId)) {
    return { serviceIds: null, representativeDate: null, validity: null };
  }
  const profile = await loadCalendarProfile(projectId);
  const r = await resolveValidityServiceFilter(feedId, { validity, projectId, dayType, profile });
  return { ...r, validity };
}

// ── GET /timetables/routes — linee del feed risolto (programma attivo) ──────
// Il picker della pagina DEVE elencare solo le linee del feed su cui poi si
// calcola l'orario: /api/gtfs/routes senza feedId mescola tutti i feed e
// porta a 404 "Linea non trovata" selezionando linee di feed vecchi.
router.get("/timetables/routes", async (req, res): Promise<void> => {
  try {
    const feedId = String(req.query.feedId ?? "") || (await getLatestFeedId(req));
    if (!feedId) { res.json({ feedId: null, routes: [] }); return; }
    const r = await db.execute<any>(sql`
      SELECT route_id, route_short_name, route_long_name, route_color
      FROM gtfs_routes WHERE feed_id = ${feedId}
      ORDER BY route_short_name
    `);
    res.json({
      feedId,
      routes: r.rows.map((x: any) => ({
        routeId: x.route_id,
        routeShortName: x.route_short_name,
        routeLongName: x.route_long_name,
        routeColor: x.route_color,
      })),
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /timetables/stops/search?q= — picker fermate con linee servite ───────
router.get("/timetables/stops/search", async (req, res): Promise<void> => {
  try {
    const feedId = String(req.query.feedId ?? "") || (await getLatestFeedId(req));
    if (!feedId) { res.json({ stops: [] }); return; }
    const q = String(req.query.q ?? "").trim();
    if (q.length < 2) { res.json({ stops: [] }); return; }

    const r = await db.execute<any>(sql`
      SELECT s.stop_id, s.stop_name, s.stop_code, s.stop_lat, s.stop_lon,
             ARRAY(
               SELECT DISTINCT r.route_short_name
               FROM gtfs_stop_times st
               JOIN gtfs_trips t  ON t.feed_id = st.feed_id AND t.trip_id = st.trip_id
               JOIN gtfs_routes r ON r.feed_id = t.feed_id AND r.route_id = t.route_id
               WHERE st.feed_id = s.feed_id AND st.stop_id = s.stop_id
               LIMIT 15
             ) AS routes
      FROM gtfs_stops s
      WHERE s.feed_id = ${feedId} AND s.stop_name ILIKE ${`%${q}%`}
      ORDER BY s.stop_name
      LIMIT 30
    `);
    res.json({
      feedId,
      stops: r.rows.map((s: any) => ({
        stopId: s.stop_id, stopName: s.stop_name, stopCode: s.stop_code,
        lat: s.stop_lat, lon: s.stop_lon, routes: s.routes ?? [],
      })),
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /timetables/stop/:stopId — quadro orario di fermata ──────────────────
router.get("/timetables/stop/:stopId", async (req, res): Promise<void> => {
  try {
    const feedId = String(req.query.feedId ?? "") || (await getLatestFeedId(req));
    if (!feedId) { res.status(400).json({ error: "Nessun feed GTFS attivo" }); return; }
    const stopId = String(req.params.stopId);
    const dayType = parseDayType(req.query.dayType);

    const stopQ = await db.execute<any>(sql`
      SELECT stop_id, stop_name, stop_code FROM gtfs_stops
      WHERE feed_id = ${feedId} AND stop_id = ${stopId} LIMIT 1
    `);
    const stop = stopQ.rows[0];
    if (!stop) { res.status(404).json({ error: "Fermata non trovata" }); return; }

    // Partenze dalla fermata (escluso il capolinea d'arrivo: lì non si sale)
    const depQ = await db.execute<any>(sql`
      SELECT st.departure_time, st.stop_sequence, st.last_seq,
             t.trip_headsign, t.service_id,
             r.route_id, r.route_short_name, r.route_long_name, r.route_color
      FROM (
        SELECT st.*, MAX(st.stop_sequence) OVER (PARTITION BY st.trip_id) AS last_seq
        FROM gtfs_stop_times st
        WHERE st.feed_id = ${feedId}
          AND st.trip_id IN (SELECT trip_id FROM gtfs_stop_times WHERE feed_id = ${feedId} AND stop_id = ${stopId})
      ) st
      JOIN gtfs_trips t  ON t.feed_id = ${feedId} AND t.trip_id = st.trip_id
      JOIN gtfs_routes r ON r.feed_id = ${feedId} AND r.route_id = t.route_id
      WHERE st.stop_id = ${stopId}
        AND st.departure_time IS NOT NULL
        AND st.stop_sequence < st.last_seq
      ORDER BY r.route_short_name, st.departure_time
    `);

    const dayMap = await buildServiceDayMap(feedId);
    const vf = await validityFilterFromReq(feedId, dayType, req.query);

    // Raggruppa: linea → destinazioni → ora → minuti
    interface Line {
      routeId: string; shortName: string | null; longName: string | null; color: string | null;
      headsigns: string[];
      byHour: Map<number, Array<{ m: number; h: number; headsignIdx: number }>>;
      total: number;
    }
    const lines = new Map<string, Line>();
    for (const row of depQ.rows) {
      if (vf.serviceIds) {
        if (!vf.serviceIds.has(row.service_id)) continue;
      } else {
        const svc = dayMap[row.service_id];
        if (svc && !svc[dayType]) continue;
      }
      // dep "HH:MM:SS" (può superare 24 per le corse dopo mezzanotte)
      const mDep = /^(\d{1,2}):(\d{2})/.exec(String(row.departure_time));
      if (!mDep) continue;
      const hour = Number(mDep[1]) % 24;
      const minute = Number(mDep[2]);

      let line = lines.get(row.route_id);
      if (!line) {
        line = {
          routeId: row.route_id, shortName: row.route_short_name,
          longName: row.route_long_name, color: row.route_color,
          headsigns: [], byHour: new Map(), total: 0,
        };
        lines.set(row.route_id, line);
      }
      const hs = String(row.trip_headsign ?? "").trim();
      let hsIdx = line.headsigns.indexOf(hs);
      if (hsIdx < 0) { line.headsigns.push(hs); hsIdx = line.headsigns.length - 1; }
      if (!line.byHour.has(hour)) line.byHour.set(hour, []);
      line.byHour.get(hour)!.push({ m: minute, h: hour, headsignIdx: hsIdx });
      line.total += 1;
    }

    res.json({
      feedId,
      dayType,
      validity: vf.validity,
      representativeDate: vf.representativeDate,
      validityNote: vf.note ?? null,
      stop: { stopId: stop.stop_id, stopName: stop.stop_name, stopCode: stop.stop_code },
      lines: [...lines.values()]
        .sort((a, b) => String(a.shortName ?? "").localeCompare(String(b.shortName ?? ""), "it", { numeric: true }))
        .map((l) => ({
          routeId: l.routeId, shortName: l.shortName, longName: l.longName, color: l.color,
          headsigns: l.headsigns, total: l.total,
          byHour: [...l.byHour.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([hour, deps]) => ({
              hour,
              departures: deps.sort((a, b) => a.m - b.m).map((d) => ({ minute: d.m, headsignIdx: d.headsignIdx })),
            })),
        })),
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /timetables/route/:routeId — orario generale di linea ────────────────
router.get("/timetables/route/:routeId", async (req, res): Promise<void> => {
  try {
    const feedId = String(req.query.feedId ?? "") || (await getLatestFeedId(req));
    if (!feedId) { res.status(400).json({ error: "Nessun feed GTFS attivo" }); return; }
    const routeId = String(req.params.routeId);
    const dayType = parseDayType(req.query.dayType);
    const dirRaw = req.query.directionId;
    const directionId = dirRaw === "0" || dirRaw === "1" ? Number(dirRaw) : null;

    const routeQ = await db.execute<any>(sql`
      SELECT route_id, route_short_name, route_long_name, route_color
      FROM gtfs_routes WHERE feed_id = ${feedId} AND route_id = ${routeId} LIMIT 1
    `);
    const route = routeQ.rows[0];
    if (!route) { res.status(404).json({ error: "Linea non trovata" }); return; }

    const rowsQ = await db.execute<any>(sql`
      SELECT t.trip_id, t.trip_headsign, t.direction_id, t.service_id,
             st.stop_id, st.stop_sequence, st.departure_time, st.arrival_time,
             s.stop_name
      FROM gtfs_trips t
      JOIN gtfs_stop_times st ON st.feed_id = t.feed_id AND st.trip_id = t.trip_id
      LEFT JOIN gtfs_stops s  ON s.feed_id = t.feed_id AND s.stop_id = st.stop_id
      WHERE t.feed_id = ${feedId} AND t.route_id = ${routeId}
        AND (${directionId}::int IS NULL OR t.direction_id = ${directionId}::int)
      ORDER BY t.trip_id, st.stop_sequence
    `);

    const dayMap = await buildServiceDayMap(feedId);
    const vf = await validityFilterFromReq(feedId, dayType, req.query);

    // Raggruppa per corsa, filtra per validità (data rappresentativa) o, in
    // assenza, per tipo giorno (buildServiceDayMap).
    interface TripRow { tripId: string; headsign: string | null; directionId: number | null; stops: Array<{ stopId: string; stopName: string | null; time: string | null }> }
    const trips = new Map<string, TripRow>();
    for (const r of rowsQ.rows) {
      if (vf.serviceIds) {
        if (!vf.serviceIds.has(r.service_id)) continue;
      } else {
        const svc = dayMap[r.service_id];
        if (svc && !svc[dayType]) continue;
      }
      let t = trips.get(r.trip_id);
      if (!t) {
        t = { tripId: r.trip_id, headsign: r.trip_headsign, directionId: r.direction_id, stops: [] };
        trips.set(r.trip_id, t);
      }
      t.stops.push({
        stopId: r.stop_id,
        stopName: r.stop_name,
        time: (r.departure_time ?? r.arrival_time ?? null) as string | null,
      });
    }

    // Ordine fermate master: merge topologico dei pattern — gestisce corse
    // con fermate saltate o extra mantenendo l'ordine relativo osservato.
    const master = mergeStopPatterns([...trips.values()].map((t) => t.stops));
    const masterIds = master.map((m) => m.stopId);

    // Corse ordinate per prima partenza, tempi allineati alle fermate master
    const tripList = [...trips.values()]
      .map((t) => {
        const timeBy = new Map(t.stops.map((s2) => [s2.stopId, s2.time]));
        return {
          tripId: t.tripId,
          headsign: t.headsign,
          directionId: t.directionId,
          firstTime: t.stops.find((s2) => s2.time)?.time ?? "99:99:99",
          times: masterIds.map((sId) => timeBy.get(sId)?.slice(0, 5) ?? null),
        };
      })
      .sort((a, b) => a.firstTime.localeCompare(b.firstTime));

    res.json({
      feedId,
      dayType,
      directionId,
      validity: vf.validity,
      representativeDate: vf.representativeDate,
      validityNote: vf.note ?? null,
      route: {
        routeId: route.route_id, shortName: route.route_short_name,
        longName: route.route_long_name, color: route.route_color,
      },
      stops: master,
      trips: tripList.map(({ firstTime: _f, ...t }) => t),
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
