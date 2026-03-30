/**
 * GTFS travel-time, trip detail, stop directory, and traffic availability endpoints.
 * GET /api/gtfs/travel-time
 * GET /api/gtfs/trips/list
 * GET /api/gtfs/trips/visual
 * GET /api/traffic/availability
 * GET /api/gtfs/trips/schedule
 * GET /api/gtfs/travel-time/route-segments
 * GET /api/gtfs/stops/directory
 * GET /api/gtfs/stops/:stopId/detail
 */
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  gtfsStops, gtfsRoutes, gtfsShapes, gtfsTrips, gtfsStopTimes,
  trafficSnapshots,
} from "@workspace/db/schema";
import { eq, sql } from "drizzle-orm";
import { haversineKm, timeToMinutes } from "../lib/geo-utils";
import {
  getLatestFeedId, buildServiceDayMap,
  TIME_BANDS, DEFAULT_SPEED_KMH, DAY_CONGESTION_MULT,
  nearestShapeIdx, shapeSegmentDist,
} from "./gtfs-helpers";
import { cache } from "../middlewares/cache";

const router: IRouter = Router();

// ──────────────────────────────────────────────────────────────
// GET /api/gtfs/travel-time
// ──────────────────────────────────────────────────────────────
router.get("/gtfs/travel-time", cache({ ttlSeconds: 30 }), async (req, res) => {
  const filterRouteId = req.query.routeId as string | undefined;
  try {
    const allShapes = await db
      .select({
        shapeId: gtfsShapes.shapeId,
        routeId: gtfsShapes.routeId,
        routeShortName: gtfsShapes.routeShortName,
        routeColor: gtfsShapes.routeColor,
        geojson: gtfsShapes.geojson,
      })
      .from(gtfsShapes)
      .where(filterRouteId ? eq(gtfsShapes.routeId, filterRouteId) : sql`route_id IS NOT NULL AND route_id != ''`)
      .limit(600);

    const traffic = await db.select({
      lng: trafficSnapshots.lng,
      lat: trafficSnapshots.lat,
      congestion: trafficSnapshots.congestionLevel,
      speed: trafficSnapshots.speed,
      freeflow: trafficSnapshots.freeflowSpeed,
    }).from(trafficSnapshots);

    const globalAvgCongestion = traffic.length > 0
      ? traffic.reduce((s, t) => s + (t.congestion ?? 0), 0) / traffic.length
      : 0.25;
    const globalAvgFreeflow = traffic.filter(t => (t.freeflow ?? 0) > 5).length > 0
      ? traffic.filter(t => (t.freeflow ?? 0) > 5).reduce((s, t) => s + (t.freeflow ?? 0), 0) /
        traffic.filter(t => (t.freeflow ?? 0) > 5).length
      : DEFAULT_SPEED_KMH;

    function findNearest(lng: number, lat: number) {
      const RADIUS = 0.06;
      const nearby = traffic.filter(
        t => Math.abs(t.lng - lng) < RADIUS && Math.abs(t.lat - lat) < RADIUS
      );
      if (!nearby.length) return null;
      return nearby.sort((a, b) => {
        return ((a.lng - lng) ** 2 + (a.lat - lat) ** 2) - ((b.lng - lng) ** 2 + (b.lat - lat) ** 2);
      })[0];
    }

    const routeMap = new Map<string, typeof allShapes[0]>();
    for (const shape of allShapes) {
      const rid = shape.routeId ?? "";
      const coords: [number, number][] = (shape.geojson as any)?.geometry?.coordinates ?? [];
      const existing = routeMap.get(rid);
      const existingCoords: [number, number][] = existing
        ? ((existing.geojson as any)?.geometry?.coordinates ?? [])
        : [];
      if (!existing || coords.length > existingCoords.length) {
        routeMap.set(rid, shape);
      }
    }

    const results: any[] = [];

    for (const [routeId, shape] of routeMap) {
      const coords: [number, number][] = (shape.geojson as any)?.geometry?.coordinates ?? [];
      if (coords.length < 2) continue;

      let totalDistanceKm = 0;
      let weightedCongestion = 0;
      let weightedFreeflow = 0;
      let weightedActualSpeed = 0;
      const slowestSegments: { from: [number, number]; to: [number, number]; delayMin: number }[] = [];

      const step = Math.max(1, Math.floor(coords.length / 40));
      const sampledCoords: [number, number][] = [];
      for (let i = 0; i < coords.length; i += step) sampledCoords.push(coords[i]);
      if (sampledCoords[sampledCoords.length - 1] !== coords[coords.length - 1]) {
        sampledCoords.push(coords[coords.length - 1]);
      }

      for (let i = 0; i < sampledCoords.length - 1; i++) {
        const [lng1, lat1] = sampledCoords[i];
        const [lng2, lat2] = sampledCoords[i + 1];
        const midLng = (lng1 + lng2) / 2;
        const midLat = (lat1 + lat2) / 2;
        const segDist = haversineKm(lat1, lng1, lat2, lng2);
        totalDistanceKm += segDist;

        const t = findNearest(midLng, midLat);
        const congestion = t?.congestion ?? globalAvgCongestion;
        const freeflow = (t?.freeflow ?? 0) > 5 ? t!.freeflow! : globalAvgFreeflow;
        const actualSpeed = (t?.speed ?? 0) > 5 ? t!.speed! : freeflow * (1 - congestion);

        weightedCongestion += congestion * segDist;
        weightedFreeflow += freeflow * segDist;
        weightedActualSpeed += actualSpeed * segDist;

        const peakSpeed = Math.max(5, Math.min(freeflow, actualSpeed * 0.68));
        const segFreeFlowMin = freeflow > 0 ? (segDist / freeflow) * 60 : 0;
        const segPeakMin = (segDist / peakSpeed) * 60;
        const delay = segPeakMin - segFreeFlowMin;
        if (delay > 0.2 && slowestSegments.length < 5) {
          slowestSegments.push({ from: [lng1, lat1], to: [lng2, lat2], delayMin: Math.round(delay * 10) / 10 });
        }
      }

      if (totalDistanceKm < 0.1) continue;

      const avgCongestion = totalDistanceKm > 0 ? weightedCongestion / totalDistanceKm : globalAvgCongestion;
      const avgFreeflow = totalDistanceKm > 0 ? weightedFreeflow / totalDistanceKm : globalAvgFreeflow;
      const avgActualSpeed = totalDistanceKm > 0 ? weightedActualSpeed / totalDistanceKm : avgFreeflow * (1 - avgCongestion);
      const freeFlowMinutes = avgFreeflow > 0 ? (totalDistanceKm / avgFreeflow) * 60 : 0;

      const timeslots = TIME_BANDS.map(band => {
        const effectiveSpeed = Math.max(5, Math.min(avgFreeflow, avgActualSpeed * band.speedFactor));
        const estimatedMinutes = (totalDistanceKm / effectiveSpeed) * 60;
        const delayMinutes = estimatedMinutes - freeFlowMinutes;
        const congestionPct = Math.round((1 - effectiveSpeed / avgFreeflow) * 100);
        return {
          id: band.id, label: band.label,
          estimatedMinutes: Math.round(estimatedMinutes * 10) / 10,
          delayMinutes: Math.round(Math.max(0, delayMinutes) * 10) / 10,
          effectiveSpeed: Math.round(effectiveSpeed),
          congestionPct: Math.max(0, congestionPct),
        };
      });

      const peakSlot = timeslots.find(s => s.id === "07-09")!;
      const eveningSlot = timeslots.find(s => s.id === "15-19")!;
      const maxDelay = Math.max(...timeslots.map(s => s.delayMinutes));

      results.push({
        routeId,
        routeShortName: shape.routeShortName ?? routeId,
        routeColor: shape.routeColor ?? "#6b7280",
        totalDistanceKm: Math.round(totalDistanceKm * 10) / 10,
        freeFlowMinutes: Math.round(freeFlowMinutes * 10) / 10,
        avgCongestion: Math.round(avgCongestion * 100),
        avgSpeedKmh: Math.round(totalDistanceKm > 0 ? weightedActualSpeed / totalDistanceKm : avgFreeflow),
        freeFlowSpeedKmh: Math.round(avgFreeflow),
        timeslots,
        maxDelayMinutes: Math.round(maxDelay * 10) / 10,
        peakMorningDelay: peakSlot.delayMinutes,
        peakEveningDelay: eveningSlot.delayMinutes,
        slowestSegments: slowestSegments.sort((a, b) => b.delayMin - a.delayMin).slice(0, 3),
      });
    }

    results.sort((a, b) => b.maxDelayMinutes - a.maxDelayMinutes);
    res.json({ data: results, trafficSnapshotsUsed: traffic.length });
  } catch (err) {
    req.log.error(err, "Error computing travel time analysis");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ──────────────────────────────────────────────────────────────
// GET /api/gtfs/trips/list
// ──────────────────────────────────────────────────────────────
router.get("/gtfs/trips/list", cache({ ttlSeconds: 60 }), async (req, res) => {
  const routeId = req.query.routeId as string | undefined;
  const day = ((req.query.day as string) || "weekday").toLowerCase();

  if (!routeId) return res.status(400).json({ error: "routeId required" });

  try {
    const feedId = await getLatestFeedId();
    if (!feedId) return res.json({ data: [], feedId: null, error: "Nessun feed GTFS caricato" });

    const tripCount = await db.select({ count: sql<number>`count(*)::int` }).from(gtfsTrips).where(eq(gtfsTrips.feedId, feedId));
    if ((tripCount[0]?.count ?? 0) === 0) {
      return res.json({ data: [], feedId, error: "Dati corse non disponibili — reimporta il feed GTFS" });
    }

    const serviceMap = await buildServiceDayMap(feedId);

    const trips = await db.select().from(gtfsTrips)
      .where(sql`feed_id = ${feedId} AND route_id = ${routeId}`)
      .orderBy(gtfsTrips.tripId)
      .limit(2000);

    const dayFilteredTrips = trips.filter(t => {
      const svc = serviceMap[t.serviceId];
      if (!svc) return day === "weekday";
      if (day === "weekday") return svc.weekday;
      if (day === "saturday") return svc.saturday;
      if (day === "sunday") return svc.sunday;
      return true;
    });

    const rawRows = await db.execute<{
      trip_id: string; service_id: string; trip_headsign: string | null;
      direction_id: number; departure_time: string; stop_id: string; stop_name: string | null;
    }>(sql`
      SELECT DISTINCT ON (t.trip_id)
        t.trip_id, t.service_id, t.trip_headsign, t.direction_id,
        st.departure_time, st.stop_id, s.stop_name
      FROM gtfs_trips t
      JOIN gtfs_stop_times st ON st.feed_id = t.feed_id AND st.trip_id = t.trip_id
      LEFT JOIN gtfs_stops s ON s.feed_id = t.feed_id AND s.stop_id = st.stop_id
      WHERE t.feed_id = ${feedId} AND t.route_id = ${routeId}
      ORDER BY t.trip_id, st.stop_sequence ASC
    `);

    const filtered = rawRows.rows.filter(r => {
      const svc = serviceMap[r.service_id];
      if (!svc) return day === "weekday";
      if (day === "weekday") return svc.weekday;
      if (day === "saturday") return svc.saturday;
      if (day === "sunday") return svc.sunday;
      return true;
    });

    if (filtered.length === 0) {
      return res.json({ data: [], feedId, message: `Nessuna corsa trovata per ${routeId} il ${day}` });
    }

    const result = filtered
      .map(r => ({
        tripId: r.trip_id, routeId, serviceId: r.service_id,
        tripHeadsign: r.trip_headsign, directionId: r.direction_id,
        firstDeparture: r.departure_time, firstStopId: r.stop_id, firstStopName: r.stop_name,
      }))
      .filter(t => t.firstDeparture)
      .sort((a, b) => {
        const toMin = (s: string) => { const [h, m] = (s || "0:0").split(":").map(Number); return h * 60 + m; };
        return toMin(a.firstDeparture) - toMin(b.firstDeparture);
      });

    return void res.json({ data: result, feedId, total: result.length });
  } catch (err) {
    req.log.error(err, "Error listing trips");
    return void res.status(500).json({ error: "Internal server error" });
  }
});

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
    const feedId = await getLatestFeedId();
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
    const feedId = await getLatestFeedId();
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
// GET /api/gtfs/travel-time/route-segments
// ──────────────────────────────────────────────────────────────
router.get("/gtfs/travel-time/route-segments", cache({ ttlSeconds: 60 }), async (req, res) => {
  const routeId = req.query.routeId as string | undefined;
  const day = ((req.query.day as string) || "weekday").toLowerCase();

  if (!routeId) return res.status(400).json({ error: "routeId required" });

  const dayMult = DAY_CONGESTION_MULT[day] ?? 1.0;

  try {
    const shapeRows = await db
      .select({ geojson: gtfsShapes.geojson, routeShortName: gtfsShapes.routeShortName, routeColor: gtfsShapes.routeColor })
      .from(gtfsShapes)
      .where(eq(gtfsShapes.routeId, routeId))
      .limit(10);

    let coords: [number, number][] = [];
    let routeShortName = routeId;
    let routeColor = "#6b7280";
    for (const s of shapeRows) {
      const c: [number, number][] = (s.geojson as any)?.geometry?.coordinates ?? [];
      if (c.length > coords.length) {
        coords = c;
        routeShortName = s.routeShortName ?? routeId;
        routeColor = s.routeColor ?? "#6b7280";
      }
    }

    if (coords.length < 2) {
      return res.json({ routeId, day, stops: [], segments: [], error: "No shape found for route" });
    }

    const traffic = await db.select({
      lng: trafficSnapshots.lng, lat: trafficSnapshots.lat,
      congestion: trafficSnapshots.congestionLevel,
      speed: trafficSnapshots.speed, freeflow: trafficSnapshots.freeflowSpeed,
    }).from(trafficSnapshots);

    const gAvgCongestion = traffic.length > 0
      ? traffic.reduce((s, t) => s + (t.congestion ?? 0), 0) / traffic.length : 0.25;
    const gAvgFreeflow = traffic.filter(t => (t.freeflow ?? 0) > 5).length > 0
      ? traffic.filter(t => (t.freeflow ?? 0) > 5).reduce((s, t) => s + (t.freeflow ?? 0), 0) /
        traffic.filter(t => (t.freeflow ?? 0) > 5).length
      : DEFAULT_SPEED_KMH;

    function nearestTraffic(lng: number, lat: number) {
      const R = 0.08;
      const nearby = traffic.filter(t => Math.abs(t.lng - lng) < R && Math.abs(t.lat - lat) < R);
      if (!nearby.length) return null;
      return nearby.sort((a, b) => ((a.lng - lng) ** 2 + (a.lat - lat) ** 2) - ((b.lng - lng) ** 2 + (b.lat - lat) ** 2))[0];
    }

    const allStops = await db.select({
      stopId: gtfsStops.stopId, stopName: gtfsStops.stopName,
      stopLat: gtfsStops.stopLat, stopLon: gtfsStops.stopLon,
      tripsCount: gtfsStops.tripsCount,
    }).from(gtfsStops).limit(3000);

    const lngs = coords.map(c => c[0]);
    const lats = coords.map(c => c[1]);
    const BBOX_BUFFER = 0.03;
    const minLng = Math.min(...lngs) - BBOX_BUFFER;
    const maxLng = Math.max(...lngs) + BBOX_BUFFER;
    const minLat = Math.min(...lats) - BBOX_BUFFER;
    const maxLat = Math.max(...lats) + BBOX_BUFFER;

    const MAX_STOP_DIST_KM = 0.15;

    interface StopOnRoute {
      stopId: string; stopName: string;
      stopLat: number; stopLon: number;
      tripsCount: number;
      shapeIdx: number; distKm: number;
    }
    const stopsOnRoute: StopOnRoute[] = [];

    for (const stop of allStops) {
      if (stop.stopLat < minLat || stop.stopLat > maxLat ||
          stop.stopLon < minLng || stop.stopLon > maxLng) continue;
      const { idx, distKm } = nearestShapeIdx(stop.stopLat, stop.stopLon, coords);
      if (distKm <= MAX_STOP_DIST_KM) {
        stopsOnRoute.push({
          stopId: stop.stopId, stopName: stop.stopName,
          stopLat: stop.stopLat, stopLon: stop.stopLon,
          tripsCount: stop.tripsCount ?? 0,
          shapeIdx: idx, distKm,
        });
      }
    }

    stopsOnRoute.sort((a, b) => a.shapeIdx - b.shapeIdx);
    const deduped: StopOnRoute[] = [];
    for (const s of stopsOnRoute) {
      const last = deduped[deduped.length - 1];
      if (!last || s.shapeIdx > last.shapeIdx + 1) {
        deduped.push(s);
      } else if (s.distKm < last.distKm) {
        deduped[deduped.length - 1] = s;
      }
    }

    if (deduped.length < 2) {
      return res.json({ routeId, routeShortName, routeColor, day, stops: deduped, segments: [], totalDistanceKm: 0 });
    }

    const segments: any[] = [];
    let totalDistKm = 0;

    for (let i = 0; i < deduped.length - 1; i++) {
      const from = deduped[i];
      const to = deduped[i + 1];
      if (to.shapeIdx <= from.shapeIdx) continue;

      const dist = shapeSegmentDist(coords, from.shapeIdx, to.shapeIdx);
      if (dist < 0.01) continue;

      totalDistKm += dist;

      const midIdx = Math.round((from.shapeIdx + to.shapeIdx) / 2);
      const [midLng, midLat] = coords[Math.min(midIdx, coords.length - 1)];
      const t = nearestTraffic(midLng, midLat);

      const freeflow = (t?.freeflow ?? 0) > 5 ? t!.freeflow! : gAvgFreeflow;
      const rawActual = (t?.speed ?? 0) > 5 ? t!.speed! : freeflow * (1 - gAvgCongestion);

      const congestionRatio = Math.max(0, 1 - rawActual / freeflow);
      const dayCongestion = congestionRatio * dayMult;
      const dayActualSpeed = Math.max(5, freeflow * (1 - dayCongestion));

      const freeFlowMin = (dist / freeflow) * 60;

      const timeslots = TIME_BANDS.map(band => {
        const effSpeed = Math.max(5, Math.min(freeflow, dayActualSpeed * band.speedFactor));
        const estMin = (dist / effSpeed) * 60;
        const delayMin = Math.max(0, estMin - freeFlowMin);
        return {
          id: band.id, label: band.label,
          estimatedMin: Math.round(estMin * 10) / 10,
          delayMin: Math.round(delayMin * 10) / 10,
          speedKmh: Math.round(effSpeed),
        };
      });

      const maxDelay = Math.max(...timeslots.map(s => s.delayMin));
      const peakSlot = timeslots.find(s => s.id === "07-09")!;

      segments.push({
        seq: i + 1,
        fromStop: { stopId: from.stopId, stopName: from.stopName, lat: from.stopLat, lon: from.stopLon },
        toStop: { stopId: to.stopId, stopName: to.stopName, lat: to.stopLat, lon: to.stopLon },
        distanceKm: Math.round(dist * 100) / 100,
        freeFlowMin: Math.round(freeFlowMin * 10) / 10,
        maxDelayMin: Math.round(maxDelay * 10) / 10,
        peakDelayMin: Math.round(peakSlot.delayMin * 10) / 10,
        congestionPct: Math.round(dayCongestion * 100),
        timeslots,
      });
    }

    segments.sort((a, b) => a.seq - b.seq);

    return void res.json({
      routeId, routeShortName, routeColor, day,
      totalDistanceKm: Math.round(totalDistKm * 10) / 10,
      stops: deduped.map(s => ({ stopId: s.stopId, stopName: s.stopName, lat: s.stopLat, lon: s.stopLon })),
      segments,
    });
  } catch (err) {
    req.log.error(err, "Error computing route segments");
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
