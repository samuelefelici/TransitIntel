/**
 * GTFS trip detail, stop directory, and traffic availability endpoints.
 * GET /api/gtfs/trips/visual
 * GET /api/traffic/availability
 * GET /api/gtfs/trips/schedule
 * GET /api/gtfs/stops/directory
 * GET /api/gtfs/stops/:stopId/detail
 */
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  gtfsRoutes,
  gtfsTrips,
  gtfsStopTimes,
} from "@workspace/db/schema";
import { eq, sql } from "drizzle-orm";
import { haversineKm, timeToMinutes } from "../lib/geo-utils";
import {
  getLatestFeedId,
  buildServiceDayMap,
} from "./gtfs-helpers";
import { cache } from "../middlewares/cache";

const router: IRouter = Router();

// ──────────────────────────────────────────────────────────────
// GET /api/traffic/availability
// ──────────────────────────────────────────────────────────────
router.get("/traffic/availability", cache({ ttlSeconds: 120 }), async (_req, res) => {
  try {
    const result = await db.execute<{
      date: string; dow: number; hour: number; count: number; avg_cong: number;
    }>(sql`
      SELECT
        captured_at::date AS date,
        EXTRACT(DOW FROM captured_at)::int AS dow,
        EXTRACT(HOUR FROM captured_at)::int AS hour,
        COUNT(*)::int AS count,
        AVG(congestion_level)::float AS avg_cong
      FROM traffic_snapshots
      GROUP BY captured_at::date, EXTRACT(DOW FROM captured_at), EXTRACT(HOUR FROM captured_at)
      ORDER BY date ASC, hour ASC
    `);

    const rows = result.rows;
    if (!rows.length) {
      return res.json({ available: false, dates: [], dayTypes: [], hours: [], totalSnapshots: 0 });
    }

    const DOW_NAMES: Record<number, string> = { 0: "sunday", 1: "weekday", 2: "weekday", 3: "weekday", 4: "weekday", 5: "weekday", 6: "saturday" };
    const dates = [...new Set(rows.map(r => r.date))];
    const hours = [...new Set(rows.map(r => r.hour))].sort((a, b) => a - b);
    const dayTypeSet = new Set(rows.map(r => DOW_NAMES[r.dow]));
    const dayTypes = [...dayTypeSet];

    const byDate = dates.map(d => {
      const dayRows = rows.filter(r => r.date === d);
      return {
        date: d,
        dow: dayRows[0]?.dow,
        dayType: DOW_NAMES[dayRows[0]?.dow ?? 1],
        hours: dayRows.map(r => ({ hour: r.hour, count: r.count, avgCongestion: Math.round((r.avg_cong ?? 0) * 100) })),
        totalSnapshots: dayRows.reduce((s, r) => s + r.count, 0),
      };
    });

    return void res.json({
      available: true,
      totalSnapshots: rows.reduce((s, r) => s + r.count, 0),
      dateRange: { from: dates[0], to: dates[dates.length - 1] },
      dates, dayTypes, hours, byDate,
    });
  } catch (err) {
    _req.log?.error(err, "Error fetching traffic availability");
    return void res.status(500).json({ error: "Internal server error" });
  }
});

// ──────────────────────────────────────────────────────────────
// GET /api/gtfs/trips/visual
// ──────────────────────────────────────────────────────────────
router.get("/gtfs/trips/visual", cache({ ttlSeconds: 30 }), async (req, res) => {
  const tripId = req.query.tripId as string | undefined;
  if (!tripId) return res.status(400).json({ error: "tripId required" });

  const dateFrom = req.query.dateFrom as string | undefined;
  const dateTo = req.query.dateTo as string | undefined;
  const dayTypesParam = req.query.dayTypes as string | undefined;
  const dayTypes = dayTypesParam ? dayTypesParam.split(",").map(s => s.trim()) : ["weekday", "saturday", "sunday"];

  const dowInts: number[] = [];
  if (dayTypes.includes("weekday")) dowInts.push(1, 2, 3, 4, 5);
  if (dayTypes.includes("saturday")) dowInts.push(6);
  if (dayTypes.includes("sunday")) dowInts.push(0);

  try {
    const feedId = await getLatestFeedId(req);
    if (!feedId) return res.json({ error: "Nessun feed GTFS", stops: [], segments: [] });

    const stopsWithTimes = await db.execute<{
      stop_id: string; stop_sequence: number; departure_time: string; arrival_time: string;
      stop_name: string; stop_lat: number; stop_lon: number;
    }>(sql`
      SELECT st.stop_id, st.stop_sequence, st.departure_time, st.arrival_time,
             s.stop_name, s.stop_lat, s.stop_lon
      FROM gtfs_stop_times st
      JOIN gtfs_stops s ON s.feed_id = st.feed_id AND s.stop_id = st.stop_id
      WHERE st.feed_id = ${feedId} AND st.trip_id = ${tripId}
      ORDER BY st.stop_sequence ASC
    `);

    if (stopsWithTimes.rows.length === 0) {
      return res.json({ error: "Corsa non trovata o dati non disponibili", stops: [], segments: [] });
    }

    const stSeq = stopsWithTimes.rows;

    const tripRow = await db.select().from(gtfsTrips).where(sql`feed_id = ${feedId} AND trip_id = ${tripId}`).limit(1);
    const trip = tripRow[0];
    let routeColor = "#6b7280";
    if (trip?.routeId) {
      const routeRow = await db.select({ routeColor: gtfsRoutes.routeColor }).from(gtfsRoutes)
        .where(sql`feed_id = ${feedId} AND route_id = ${trip.routeId}`).limit(1);
      routeColor = routeRow[0]?.routeColor ?? "#6b7280";
    }

    let trafficWhere = sql`1=1`;
    if (dateFrom) trafficWhere = sql`${trafficWhere} AND captured_at >= ${dateFrom}::timestamptz`;
    if (dateTo) trafficWhere = sql`${trafficWhere} AND captured_at < (${dateTo}::date + interval '1 day')`;
    if (dowInts.length < 7) {
      const dowList = sql.join(dowInts.map(d => sql`${d}`), sql`, `);
      trafficWhere = sql`${trafficWhere} AND EXTRACT(DOW FROM captured_at) = ANY(ARRAY[${dowList}])`;
    }

    const trafficRaw = await db.execute<{
      lng: number; lat: number; hour: number;
      avg_speed: number; avg_freeflow: number; avg_cong: number; count: number;
    }>(sql`
      SELECT
        ROUND(lng::numeric, 4) AS lng,
        ROUND(lat::numeric, 4) AS lat,
        EXTRACT(HOUR FROM captured_at)::int AS hour,
        AVG(speed) AS avg_speed,
        AVG(freeflow_speed) AS avg_freeflow,
        AVG(congestion_level) AS avg_cong,
        COUNT(*)::int AS count
      FROM traffic_snapshots
      WHERE ${trafficWhere}
      GROUP BY ROUND(lng::numeric, 4), ROUND(lat::numeric, 4), EXTRACT(HOUR FROM captured_at)::int
    `);

    const trafficByHour: Record<number, typeof trafficRaw.rows> = {};
    for (const row of trafficRaw.rows) {
      const h = row.hour;
      if (!trafficByHour[h]) trafficByHour[h] = [];
      trafficByHour[h].push(row);
    }
    const allTraffic = trafficRaw.rows;

    function nearestTomTomAtHour(lng: number, lat: number, hour: number) {
      const R = 0.08;
      let pool = (trafficByHour[hour] ?? []).filter(t => Math.abs(t.lng - lng) < R && Math.abs(t.lat - lat) < R);
      if (!pool.length) {
        for (const dh of [1, -1, 2, -2, 3, -3]) {
          pool = (trafficByHour[hour + dh] ?? []).filter(t => Math.abs(t.lng - lng) < R && Math.abs(t.lat - lat) < R);
          if (pool.length) break;
        }
      }
      if (!pool.length) {
        pool = allTraffic.filter(t => Math.abs(t.lng - lng) < R && Math.abs(t.lat - lat) < R);
      }
      if (!pool.length) return null;
      return pool.sort((a, b) => ((a.lng - lng) ** 2 + (a.lat - lat) ** 2) - ((b.lng - lng) ** 2 + (b.lat - lat) ** 2))[0];
    }

    const validFreeflow = allTraffic.filter(t => (t.avg_freeflow ?? 0) > 5);
    const avgFreeflow = validFreeflow.length > 0
      ? validFreeflow.reduce((s, t) => s + t.avg_freeflow, 0) / validFreeflow.length : 50;
    const hasTrafficData = allTraffic.length > 0;

    const orderedStops = stSeq.map(st => ({
      stopId: st.stop_id,
      stopName: st.stop_name ?? st.stop_id,
      lat: typeof st.stop_lat === "string" ? parseFloat(st.stop_lat) : (st.stop_lat ?? 0),
      lon: typeof st.stop_lon === "string" ? parseFloat(st.stop_lon) : (st.stop_lon ?? 0),
      seq: st.stop_sequence,
      departureTime: st.departure_time,
      arrivalTime: st.arrival_time,
    })).filter(s => s.lat !== 0 && s.lon !== 0);

    let totalDistKm = 0;
    let totalScheduledMin = 0;
    const segments: any[] = [];

    for (let i = 0; i < orderedStops.length - 1; i++) {
      const from = orderedStops[i];
      const to = orderedStops[i + 1];
      if (!from.departureTime || !to.departureTime) continue;

      const dist = haversineKm(from.lat, from.lon, to.lat, to.lon);
      if (dist < 0.001) continue;

      const fromMin = timeToMinutes(from.departureTime);
      const toMin = timeToMinutes(to.departureTime);
      const scheduledMin = Math.max(0.1, toMin - fromMin);

      totalDistKm += dist;
      totalScheduledMin += scheduledMin;

      const scheduledSpeedKmh = (dist / scheduledMin) * 60;

      const midLat = (from.lat + to.lat) / 2;
      const midLon = (from.lon + to.lon) / 2;
      const segHour = Math.floor(fromMin / 60) % 24;
      const tt = nearestTomTomAtHour(midLon, midLat, segHour);
      const hasTomTom = tt !== null;
      const freeflowKmh = hasTomTom && (tt.avg_freeflow ?? 0) > 5 ? tt.avg_freeflow : (hasTrafficData ? avgFreeflow : null);
      const currentSpeedKmh = hasTomTom && (tt.avg_speed ?? 0) > 0 ? tt.avg_speed : null;

      const congestionPct = (currentSpeedKmh && freeflowKmh && freeflowKmh > 0)
        ? Math.max(0, Math.min(1, 1 - currentSpeedKmh / freeflowKmh))
        : null;

      const delayPct = freeflowKmh ? Math.max(0, Math.min(1, 1 - scheduledSpeedKmh / freeflowKmh)) : null;

      const BUS_TRAFFIC_FACTOR = 0.4;
      const extraMin = congestionPct !== null ? scheduledMin * congestionPct * BUS_TRAFFIC_FACTOR : null;

      segments.push({
        fromIdx: i, toIdx: i + 1,
        fromStop: { stopId: from.stopId, stopName: from.stopName, lat: from.lat, lon: from.lon, departureTime: from.departureTime },
        toStop: { stopId: to.stopId, stopName: to.stopName, lat: to.lat, lon: to.lon, departureTime: to.departureTime },
        distanceKm: Math.round(dist * 100) / 100,
        scheduledMin: Math.round(scheduledMin * 10) / 10,
        scheduledSpeedKmh: Math.round(scheduledSpeedKmh * 10) / 10,
        freeflowKmh: freeflowKmh ? Math.round(freeflowKmh * 10) / 10 : null,
        currentSpeedKmh: currentSpeedKmh ? Math.round(currentSpeedKmh * 10) / 10 : null,
        delayPct: delayPct !== null ? Math.round(delayPct * 100) / 100 : null,
        congestionPct: congestionPct !== null ? Math.round(congestionPct * 100) / 100 : null,
        extraMin: extraMin !== null ? Math.round(extraMin * 10) / 10 : null,
        hasTomTom,
        segHour,
        tomTomSamples: tt?.count ?? 0,
      });
    }

    const matchedHours = [...new Set(segments.map(s => s.segHour))];
    const trafficContext = {
      hasData: hasTrafficData,
      totalSamples: allTraffic.reduce((s, t) => s + t.count, 0),
      dateFrom: dateFrom ?? null, dateTo: dateTo ?? null,
      dayTypes, matchedHours,
      segmentsWithTomTom: segments.filter(s => s.hasTomTom).length,
      segmentsWithoutTomTom: segments.filter(s => !s.hasTomTom).length,
    };

    return void res.json({
      tripId, routeId: trip?.routeId ?? "", routeColor,
      tripHeadsign: trip?.tripHeadsign ?? null,
      directionId: trip?.directionId ?? 0,
      stops: orderedStops, trafficContext, segments,
      totalDistanceKm: Math.round(totalDistKm * 10) / 10,
      totalScheduledMin: Math.round(totalScheduledMin * 10) / 10,
    });
  } catch (err) {
    req.log.error(err, "Error building trip visual");
    return void res.status(500).json({ error: "Internal server error" });
  }
});

// ──────────────────────────────────────────────────────────────
// GET /api/gtfs/trips/schedule
// ──────────────────────────────────────────────────────────────
router.get("/gtfs/trips/schedule", cache({ ttlSeconds: 60 }), async (req, res) => {
  const routeId = req.query.routeId as string | undefined;
  const day = ((req.query.day as string) || "weekday").toLowerCase();
  const directionIdParam = req.query.directionId !== undefined && req.query.directionId !== ""
    ? parseInt(req.query.directionId as string) : null;

  if (!routeId) return res.status(400).json({ error: "routeId required" });

  try {
    const feedId = await getLatestFeedId(req);
    if (!feedId) return res.json({ trips: [], error: "Nessun feed GTFS" });

    const tripCount = await db.select({ count: sql<number>`count(*)::int` }).from(gtfsTrips).where(eq(gtfsTrips.feedId, feedId));
    if ((tripCount[0]?.count ?? 0) === 0) {
      return res.json({ trips: [], error: "Dati corse non disponibili — reimporta il feed GTFS" });
    }

    const serviceMap = await buildServiceDayMap(feedId);

    const routeRow = await db.select({ routeColor: gtfsRoutes.routeColor, routeShortName: gtfsRoutes.routeShortName })
      .from(gtfsRoutes).where(sql`feed_id = ${feedId} AND route_id = ${routeId}`).limit(1);
    const routeColor = routeRow[0]?.routeColor ?? "#6b7280";
    const routeShortName = routeRow[0]?.routeShortName ?? routeId;

    const rows = await db.execute<{
      trip_id: string; service_id: string; trip_headsign: string | null; direction_id: number;
      stop_sequence: number; departure_time: string; stop_name: string | null;
      stop_lat: number | null; stop_lon: number | null;
    }>(sql`
      SELECT t.trip_id, t.service_id, t.trip_headsign, t.direction_id,
             st.stop_sequence, st.departure_time,
             s.stop_name, s.stop_lat, s.stop_lon
      FROM gtfs_trips t
      JOIN gtfs_stop_times st ON st.feed_id = t.feed_id AND st.trip_id = t.trip_id
      LEFT JOIN gtfs_stops s ON s.feed_id = t.feed_id AND s.stop_id = st.stop_id
      WHERE t.feed_id = ${feedId} AND t.route_id = ${routeId}
      ORDER BY t.trip_id, st.stop_sequence ASC
    `);

    const tripMap: Record<string, { serviceId: string; headsign: string | null; direction: number; stops: typeof rows.rows }> = {};
    for (const r of rows.rows) {
      if (!tripMap[r.trip_id]) {
        tripMap[r.trip_id] = { serviceId: r.service_id, headsign: r.trip_headsign, direction: r.direction_id, stops: [] };
      }
      tripMap[r.trip_id].stops.push(r);
    }

    // Load TomTom traffic data
    const trafficRawSch = await db.execute<{
      lng: number; lat: number; hour: number;
      avg_speed: number; avg_freeflow: number; count: number;
    }>(sql`
      SELECT ROUND(lng::numeric, 4) AS lng, ROUND(lat::numeric, 4) AS lat,
             EXTRACT(HOUR FROM captured_at)::int AS hour,
             AVG(speed) AS avg_speed, AVG(freeflow_speed) AS avg_freeflow,
             COUNT(*)::int AS count
      FROM traffic_snapshots
      GROUP BY ROUND(lng::numeric, 4), ROUND(lat::numeric, 4), EXTRACT(HOUR FROM captured_at)::int
    `);
    const schTrafficByHour: Record<number, typeof trafficRawSch.rows> = {};
    for (const row of trafficRawSch.rows) {
      if (!schTrafficByHour[row.hour]) schTrafficByHour[row.hour] = [];
      schTrafficByHour[row.hour].push(row);
    }
    const schAllTraffic = trafficRawSch.rows;
    const BUS_TRAFFIC_FACTOR = 0.4;

    function schNearestTT(lng: number, lat: number, hour: number) {
      const R = 0.08;
      let pool = (schTrafficByHour[hour] ?? []).filter(t => Math.abs(t.lng - lng) < R && Math.abs(t.lat - lat) < R);
      if (!pool.length) {
        for (const dh of [1, -1, 2, -2]) {
          pool = (schTrafficByHour[hour + dh] ?? []).filter(t => Math.abs(t.lng - lng) < R && Math.abs(t.lat - lat) < R);
          if (pool.length) break;
        }
      }
      if (!pool.length) pool = schAllTraffic.filter(t => Math.abs(t.lng - lng) < R && Math.abs(t.lat - lat) < R);
      if (!pool.length) return null;
      return pool.sort((a, b) => ((a.lng - lng) ** 2 + (a.lat - lat) ** 2) - ((b.lng - lng) ** 2 + (b.lat - lat) ** 2))[0];
    }

    const trips = Object.entries(tripMap).map(([tripId, info]) => {
      const stops = info.stops;
      if (stops.length === 0) return null;

      const first = stops[0];
      const last = stops[stops.length - 1];
      const firstMin = timeToMinutes(first.departure_time || "0:0");
      const lastMin = timeToMinutes(last.departure_time || "0:0");
      const totalMin = Math.max(0, lastMin - firstMin);

      let tripExtraMin = 0;
      const stopsOut = stops.map((s, i) => {
        const depMin = timeToMinutes(s.departure_time || "0:0");
        const lat = typeof s.stop_lat === "string" ? parseFloat(s.stop_lat) : (s.stop_lat ?? 0);
        const lon = typeof s.stop_lon === "string" ? parseFloat(s.stop_lon) : (s.stop_lon ?? 0);
        const prevLat = i > 0 ? (typeof stops[i-1].stop_lat === "string" ? parseFloat(stops[i-1].stop_lat as unknown as string) : (stops[i-1].stop_lat ?? 0)) : lat;
        const prevLon = i > 0 ? (typeof stops[i-1].stop_lon === "string" ? parseFloat(stops[i-1].stop_lon as unknown as string) : (stops[i-1].stop_lon ?? 0)) : lon;
        const distKm = i > 0 ? Math.round(haversineKm(prevLat, prevLon, lat, lon) * 100) / 100 : 0;
        const minsFromPrev = i > 0 ? depMin - timeToMinutes(stops[i-1].departure_time || "0:0") : 0;

        let congestionPct: number | null = null;
        let extraMin: number | null = null;
        if (i > 0 && lat !== 0 && lon !== 0 && prevLat !== 0 && prevLon !== 0) {
          const midLat = (lat + prevLat) / 2;
          const midLon = (lon + prevLon) / 2;
          const segHour = Math.floor(depMin / 60) % 24;
          const tt = schNearestTT(midLon, midLat, segHour);
          if (tt && tt.avg_freeflow > 5 && tt.avg_speed > 0) {
            congestionPct = Math.round(Math.max(0, Math.min(1, 1 - tt.avg_speed / tt.avg_freeflow)) * 100) / 100;
            extraMin = Math.round(minsFromPrev * congestionPct * BUS_TRAFFIC_FACTOR * 10) / 10;
            tripExtraMin += extraMin;
          }
        }

        return {
          stopName: s.stop_name ?? `Fermata ${i + 1}`,
          departureTime: s.departure_time,
          minsFromFirst: depMin - firstMin,
          minsFromPrev, distFromPrevKm: distKm,
          congestionPct, extraMin,
        };
      });

      return {
        tripId, headsign: info.headsign, directionId: info.direction,
        serviceId: info.serviceId,
        firstDeparture: first.departure_time,
        lastArrival: last.departure_time,
        totalMin: Math.round(totalMin * 10) / 10,
        stopCount: stops.length,
        stops: stopsOut,
        totalExtraMin: Math.round(tripExtraMin * 10) / 10,
      };
    }).filter((t): t is NonNullable<typeof t> => {
      if (!t) return false;
      const svc = serviceMap[t.serviceId];
      const dayOk = svc ? (
        day === "weekday" ? svc.weekday :
        day === "saturday" ? svc.saturday :
        day === "sunday" ? svc.sunday : true
      ) : day === "weekday";
      if (!dayOk) return false;
      if (directionIdParam !== null && !isNaN(directionIdParam) && t.directionId !== directionIdParam) return false;
      return !!t.firstDeparture;
    }).sort((a, b) => {
      const toMin = (s: string) => { const [h, m] = (s || "0:0").split(":").map(Number); return h * 60 + m; };
      return toMin(a.firstDeparture) - toMin(b.firstDeparture);
    });

    return void res.json({ trips, routeColor, routeShortName, total: trips.length, feedId });
  } catch (err) {
    req.log.error(err, "Error fetching trip schedule");
    return void res.status(500).json({ error: "Internal server error" });
  }
});

// ──────────────────────────────────────────────────────────────
// GET /api/gtfs/stops/directory
// ──────────────────────────────────────────────────────────────
router.get("/gtfs/stops/directory", cache({ ttlSeconds: 120 }), async (req, res) => {
  const q         = ((req.query.q as string) ?? "").toLowerCase().trim();
  const routeId   = (req.query.route as string) ?? "";
  const page      = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit     = Math.min(100, parseInt(req.query.limit as string) || 50);
  try {
    const rows = await db.execute(sql`
      SELECT
        s.stop_id, s.stop_name,
        s.stop_lat::float AS lat, s.stop_lon::float AS lon,
        ARRAY_AGG(DISTINCT t.route_id ORDER BY t.route_id) AS route_ids,
        COUNT(DISTINCT t.route_id)::int                    AS route_count
      FROM gtfs_stops s
      JOIN gtfs_stop_times st ON st.stop_id = s.stop_id
      JOIN gtfs_trips       t  ON t.trip_id = st.trip_id
      ${q       ? sql`WHERE s.stop_name ILIKE ${"%" + q + "%"}` : sql``}
      GROUP BY s.stop_id, s.stop_name, s.stop_lat, s.stop_lon
      ${routeId ? sql`HAVING ARRAY_AGG(DISTINCT t.route_id) @> ARRAY[${routeId}]` : sql``}
      ORDER BY route_count DESC, s.stop_name
      LIMIT ${limit} OFFSET ${(page - 1) * limit}
    `);

    const countRow = await db.execute(sql`
      SELECT COUNT(DISTINCT s.stop_id)::int AS total
      FROM gtfs_stops s
      JOIN gtfs_stop_times st ON st.stop_id = s.stop_id
      JOIN gtfs_trips       t  ON t.trip_id = st.trip_id
      ${q ? sql`WHERE s.stop_name ILIKE ${"%" + q + "%"}` : sql``}
    `);
    const total = (countRow.rows as any[])[0]?.total ?? 0;

    res.json({
      stops: (rows.rows as any[]).map(r => ({
        stopId:     r.stop_id,
        name:       r.stop_name,
        lat:        r.lat,
        lon:        r.lon,
        routeIds:   r.route_ids as string[],
        routeCount: r.route_count,
      })),
      total, page, limit,
    });
  } catch (err) {
    req.log.error(err, "Error in stops/directory");
    res.status(500).json({ error: "Errore directory fermate" });
  }
});

// ──────────────────────────────────────────────────────────────
// GET /api/gtfs/stops/:stopId/detail
// ──────────────────────────────────────────────────────────────
router.get("/gtfs/stops/:stopId/detail", cache({ ttlSeconds: 60 }), async (req, res) => {
  const { stopId } = req.params;
  try {
    const stopRow = await db.execute(sql`
      SELECT stop_id, stop_name, stop_lat::float AS lat, stop_lon::float AS lon
      FROM gtfs_stops WHERE stop_id = ${stopId}
    `);
    const stop = (stopRow.rows as any[])[0];
    if (!stop) { res.status(404).json({ error: "Stop non trovata" }); return; }

    const deptRows = await db.execute(sql`
      SELECT DISTINCT
        t.route_id,
        r.route_short_name, r.route_long_name,
        r.route_color, r.route_text_color,
        st.departure_time
      FROM gtfs_stop_times st
      JOIN gtfs_trips  t ON t.trip_id  = st.trip_id
      JOIN gtfs_routes r ON r.route_id = t.route_id
      WHERE st.stop_id = ${stopId}
      ORDER BY t.route_id, st.departure_time
    `);

    const routeMap = new Map<string, {
      routeId: string; shortName: string; longName: string;
      color: string; textColor: string; departures: string[];
    }>();
    for (const r of deptRows.rows as any[]) {
      if (!routeMap.has(r.route_id)) {
        routeMap.set(r.route_id, {
          routeId:   r.route_id,
          shortName: r.route_short_name ?? r.route_id,
          longName:  r.route_long_name  ?? "",
          color:     r.route_color     ?? "#64748b",
          textColor: r.route_text_color ?? "#fff",
          departures: [],
        });
      }
      routeMap.get(r.route_id)!.departures.push(r.departure_time);
    }

    const routes = [...routeMap.values()].sort((a, b) => a.routeId.localeCompare(b.routeId));

    res.json({
      stop: { stopId: stop.stop_id, name: stop.stop_name, lat: stop.lat, lon: stop.lon },
      routes,
    });
  } catch (err) {
    req.log.error(err, "Error in stops/:stopId/detail");
    res.status(500).json({ error: "Errore dettaglio fermata" });
  }
});

export default router;
