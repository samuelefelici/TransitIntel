/**
 * GTFS basic query endpoints.
 * GET /api/gtfs/stops
 * GET /api/gtfs/routes
 * GET /api/gtfs/shapes
 * GET /api/gtfs/summary
 * GET /api/gtfs/stats
 * GET /api/gtfs/analysis
 */
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  gtfsFeeds, gtfsStops, gtfsRoutes, gtfsShapes,
  gtfsTrips, gtfsStopTimes, gtfsCalendarDates,
  pointsOfInterest, censusSections, trafficSnapshots,
} from "@workspace/db/schema";
import { eq, sql } from "drizzle-orm";
import { haversineKm, timeToMinutes } from "../lib/geo-utils";
import { getLatestFeedId } from "./gtfs-helpers";
import { cache } from "../middlewares/cache";

const router: IRouter = Router();

// GET /api/gtfs/stops?feedId=&limit=
router.get("/gtfs/stops", cache({ ttlSeconds: 60 }), async (req, res) => {
  try {
    const feedId = req.query["feedId"] as string | undefined;
    const limit = Math.min(parseInt(req.query["limit"] as string || "2000"), 5000);
    const routeIdsParam = req.query["routeIds"] as string | undefined;

    // If routeIds filter is provided, return only stops served by those routes
    if (routeIdsParam) {
      const routeIds = routeIdsParam.split(",").map(s => s.trim()).filter(Boolean);
      if (routeIds.length === 0) return res.json({ data: [], total: 0 });
      const latestFeed = feedId || await getLatestFeedId();
      if (!latestFeed) return res.json({ data: [], total: 0 });

      const inList = sql.join(routeIds.map(id => sql`${id}`), sql`, `);
      const stops = await db.execute<any>(sql`
        SELECT DISTINCT ON (s.stop_id)
          s.id, s.feed_id AS "feedId", s.stop_id AS "stopId",
          s.stop_name AS "stopName", s.stop_code AS "stopCode",
          s.stop_lat::float AS "stopLat", s.stop_lon::float AS "stopLon",
          COALESCE(s.trips_count, 0) AS "tripsCount",
          COALESCE(s.morning_peak_trips, 0) AS "morningPeakTrips",
          COALESCE(s.evening_peak_trips, 0) AS "eveningPeakTrips",
          COALESCE(s.service_score, 0) AS "serviceScore",
          COALESCE(s.wheelchair_boarding, 0) AS "wheelchairBoarding",
          s.stop_desc AS "stopDesc"
        FROM gtfs_stops s
        JOIN gtfs_stop_times st ON st.stop_id = s.stop_id AND st.feed_id = s.feed_id
        JOIN gtfs_trips t ON t.trip_id = st.trip_id AND t.feed_id = s.feed_id
        WHERE s.feed_id = ${latestFeed}
          AND t.route_id IN (${inList})
        LIMIT ${limit}
      `);
      return res.json({ data: stops.rows, total: stops.rows.length });
    }

    let query = db.select().from(gtfsStops).$dynamic();
    if (feedId) query = query.where(eq(gtfsStops.feedId, feedId));
    const stops = await query.limit(limit);
    return void res.json({ data: stops, total: stops.length });
  } catch (err) {
    req.log.error(err, "Error fetching GTFS stops");
    return void res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/gtfs/routes?feedId=
router.get("/gtfs/routes", cache({ ttlSeconds: 60 }), async (req, res) => {
  try {
    const feedId = req.query["feedId"] as string | undefined;
    let query = db.select().from(gtfsRoutes).$dynamic();
    if (feedId) query = query.where(eq(gtfsRoutes.feedId, feedId));
    const routes = await query.orderBy(sql`trips_count DESC`);
    res.json({ data: routes });
  } catch (err) {
    req.log.error(err, "Error fetching GTFS routes");
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/gtfs/shapes?feedId=
router.get("/gtfs/shapes", cache({ ttlSeconds: 60 }), async (req, res) => {
  try {
    const feedId = req.query["feedId"] as string | undefined;
    let query = db.select().from(gtfsShapes).$dynamic();
    if (feedId) query = query.where(eq(gtfsShapes.feedId, feedId));
    const shapes = await query.limit(200);
    res.json({ data: shapes });
  } catch (err) {
    req.log.error(err, "Error fetching GTFS shapes");
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/gtfs/summary — real GTFS stats for the dashboard card
router.get("/gtfs/summary", cache({ ttlSeconds: 60 }), async (req, res) => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) return res.json({ available: false });

    const [routeCount, stopCount, tripCount, calDows, hoursRow] = await Promise.all([
      db.execute(sql`SELECT COUNT(DISTINCT route_id)::int AS n FROM gtfs_routes WHERE feed_id = ${feedId}`),
      db.execute(sql`SELECT COUNT(*)::int AS n FROM gtfs_stops WHERE feed_id = ${feedId}`),
      db.execute(sql`SELECT COUNT(*)::int AS n FROM gtfs_trips WHERE feed_id = ${feedId}`),
      db.execute<{ service_id: string; weekdays: string; saturdays: string; sundays: string }>(sql`
        SELECT service_id,
          SUM(CASE WHEN EXTRACT(DOW FROM TO_DATE(date,'YYYYMMDD')) IN (1,2,3,4,5) THEN 1 ELSE 0 END)::int AS weekdays,
          SUM(CASE WHEN EXTRACT(DOW FROM TO_DATE(date,'YYYYMMDD')) = 6 THEN 1 ELSE 0 END)::int AS saturdays,
          SUM(CASE WHEN EXTRACT(DOW FROM TO_DATE(date,'YYYYMMDD')) = 0 THEN 1 ELSE 0 END)::int AS sundays
        FROM gtfs_calendar_dates
        WHERE feed_id = ${feedId} AND exception_type = '1'
        GROUP BY service_id
      `),
      db.execute(sql`
        SELECT MIN(departure_time) AS first_dep, MAX(arrival_time) AS last_arr
        FROM gtfs_stop_times WHERE feed_id = ${feedId}
      `),
    ]);

    const svcMap: Record<string, { weekday: boolean; saturday: boolean; sunday: boolean }> = {};
    for (const row of calDows.rows) {
      svcMap[row.service_id] = {
        weekday:  parseInt(row.weekdays)  > 0,
        saturday: parseInt(row.saturdays) > 0,
        sunday:   parseInt(row.sundays)   > 0,
      };
    }

    const allTrips = await db.execute<{ service_id: string; shape_id: string | null; route_id: string; trip_id: string }>(
      sql`SELECT service_id, shape_id, route_id, trip_id FROM gtfs_trips WHERE feed_id = ${feedId}`
    );
    let weekdayTrips = 0, satTrips = 0, sunTrips = 0;
    const weekdayShapeIds = new Set<string>();
    const satShapeIds     = new Set<string>();
    const sunShapeIds     = new Set<string>();
    const weekdayRouteIds = new Set<string>();
    const satRouteIds     = new Set<string>();
    const sunRouteIds     = new Set<string>();
    const weekdayTripIds = new Set<string>();
    const satTripIds     = new Set<string>();
    const sunTripIds     = new Set<string>();
    const weekdayShapeTripCount: Record<string, number> = {};
    const satShapeTripCount:     Record<string, number> = {};
    const sunShapeTripCount:     Record<string, number> = {};

    for (const t of allTrips.rows) {
      const svc = svcMap[t.service_id];
      if (svc?.weekday) {
        weekdayTrips++;
        weekdayRouteIds.add(t.route_id);
        weekdayTripIds.add(t.trip_id);
        if (t.shape_id) {
          weekdayShapeIds.add(t.shape_id);
          weekdayShapeTripCount[t.shape_id] = (weekdayShapeTripCount[t.shape_id] || 0) + 1;
        }
      }
      if (svc?.saturday) {
        satTrips++;
        satRouteIds.add(t.route_id);
        satTripIds.add(t.trip_id);
        if (t.shape_id) {
          satShapeIds.add(t.shape_id);
          satShapeTripCount[t.shape_id] = (satShapeTripCount[t.shape_id] || 0) + 1;
        }
      }
      if (svc?.sunday) {
        sunTrips++;
        sunRouteIds.add(t.route_id);
        sunTripIds.add(t.trip_id);
        if (t.shape_id) {
          sunShapeIds.add(t.shape_id);
          sunShapeTripCount[t.shape_id] = (sunShapeTripCount[t.shape_id] || 0) + 1;
        }
      }
    }

    const stopTimesResult = await db.execute<{ trip_id: string; stop_id: string }>(
      sql`SELECT DISTINCT trip_id, stop_id FROM gtfs_stop_times WHERE feed_id = ${feedId}`
    );
    const weekdayStopIds = new Set<string>();
    const satStopIds     = new Set<string>();
    const sunStopIds     = new Set<string>();
    for (const st of stopTimesResult.rows) {
      if (weekdayTripIds.has(st.trip_id)) weekdayStopIds.add(st.stop_id);
      if (satTripIds.has(st.trip_id))     satStopIds.add(st.stop_id);
      if (sunTripIds.has(st.trip_id))     sunStopIds.add(st.stop_id);
    }

    const allShapeIds = new Set([...weekdayShapeIds, ...satShapeIds, ...sunShapeIds]);
    const shapeLengthKm: Record<string, number> = {};

    if (allShapeIds.size > 0) {
      const shapeIdArr = Array.from(allShapeIds);
      const shapesResult = await db.execute<{ shape_id: string; geojson: any }>(sql`
        SELECT shape_id, geojson FROM gtfs_shapes
        WHERE feed_id = ${feedId} AND shape_id IN ${sql`(${sql.join(shapeIdArr.map(s => sql`${s}`), sql`, `)})`}
      `);

      for (const row of shapesResult.rows) {
        let geojson = row.geojson;
        if (typeof geojson === "string") geojson = JSON.parse(geojson);
        const coords: number[][] =
          geojson?.type === "LineString" ? geojson.coordinates :
          geojson?.type === "Feature" ? geojson.geometry?.coordinates :
          geojson?.type === "FeatureCollection" ? geojson.features?.[0]?.geometry?.coordinates :
          [];
        if (!coords || coords.length < 2) { shapeLengthKm[row.shape_id] = 0; continue; }
        let len = 0;
        for (let i = 1; i < coords.length; i++) {
          len += haversineKm(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]);
        }
        shapeLengthKm[row.shape_id] = len;
      }
    }

    function totalKm(shapeTripCount: Record<string, number>): number {
      let km = 0;
      for (const [sid, count] of Object.entries(shapeTripCount)) {
        km += (shapeLengthKm[sid] || 0) * count;
      }
      return Math.round(km);
    }
    const weekdayKm  = totalKm(weekdayShapeTripCount);
    const saturdayKm  = totalKm(satShapeTripCount);
    const sundayKm    = totalKm(sunShapeTripCount);

    const topRoutes = await db.execute<{ name: string; color: string; trips: number }>(sql`
      SELECT r.route_short_name AS name, r.route_color AS color, COUNT(t.trip_id)::int AS trips
      FROM gtfs_routes r
      JOIN gtfs_trips t ON t.route_id = r.route_id AND t.feed_id = r.feed_id
      WHERE r.feed_id = ${feedId}
      GROUP BY r.route_short_name, r.route_color
      ORDER BY trips DESC
      LIMIT 6
    `);

    const hrs = (hoursRow.rows[0] as any) || {};
    return void res.json({
      available: true,
      totalRoutes: (routeCount.rows[0] as any).n,
      totalStops:  (stopCount.rows[0] as any).n,
      totalTrips:  (tripCount.rows[0] as any).n,
      weekdayTrips,
      saturdayTrips: satTrips,
      sundayTrips: sunTrips,
      weekdayRoutes: weekdayRouteIds.size,
      saturdayRoutes: satRouteIds.size,
      sundayRoutes: sunRouteIds.size,
      weekdayStops: weekdayStopIds.size,
      saturdayStops: satStopIds.size,
      sundayStops: sunStopIds.size,
      weekdayKm,
      saturdayKm,
      sundayKm,
      topRoutes: topRoutes.rows,
      firstDeparture: hrs.first_dep,
      lastArrival: hrs.last_arr,
    });
  } catch (err) {
    req.log.error(err, "Error fetching GTFS summary");
    return void res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/gtfs/stats
router.get("/gtfs/stats", cache({ ttlSeconds: 60 }), async (req, res) => {
  try {
    const feedsResult = await db.execute(sql`SELECT COUNT(*)::int as total_feeds FROM gtfs_feeds`);
    const stopsResult = await db.execute(sql`SELECT COUNT(*)::int as total_stops FROM gtfs_stops`);
    const routesResult = await db.execute(sql`SELECT COUNT(*)::int as total_routes FROM gtfs_routes`);
    const latestFeed = await db.select().from(gtfsFeeds).orderBy(sql`uploaded_at DESC`).limit(1);
    res.json({
      totalFeeds: (feedsResult.rows as any[])[0]?.total_feeds || 0,
      totalStops: (stopsResult.rows as any[])[0]?.total_stops || 0,
      totalRoutes: (routesResult.rows as any[])[0]?.total_routes || 0,
      latestFeed: latestFeed[0] || null,
    });
  } catch (err) {
    req.log.error(err, "Error fetching GTFS stats");
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/gtfs/analysis?feedId=
router.get("/gtfs/analysis", cache({ ttlSeconds: 60 }), async (req, res) => {
  try {
    const feedId = req.query["feedId"] as string | undefined;

    let stopsQuery = db.select().from(gtfsStops).$dynamic();
    if (feedId) stopsQuery = stopsQuery.where(eq(gtfsStops.feedId, feedId));
    const stops = await stopsQuery.limit(5000);

    let routesQuery = db.select().from(gtfsRoutes).$dynamic();
    if (feedId) routesQuery = routesQuery.where(eq(gtfsRoutes.feedId, feedId));
    const routes = await routesQuery.orderBy(sql`trips_count DESC`);

    const pois = await db.select().from(pointsOfInterest).limit(1000);
    const census = await db.select().from(censusSections);
    const trafficResult = await db.execute(sql`
      SELECT ROUND(lng::numeric, 2) as lng, ROUND(lat::numeric, 2) as lat, AVG(congestion_level) as avg_congestion
      FROM traffic_snapshots
      WHERE captured_at > NOW() - INTERVAL '7 days'
      GROUP BY ROUND(lng::numeric, 2), ROUND(lat::numeric, 2)
    `);
    const trafficPoints = (trafficResult.rows as any[]);

    if (stops.length === 0) {
      res.json({ noData: true, message: "Nessun dato GTFS disponibile. Carica un feed prima." });
      return;
    }

    // ── 1. Frequency distribution ──
    const withTimes = stops.filter(s => (s as any).daily_trips !== undefined ? (s as any).daily_trips > 0 : (s.tripsCount ?? 0) > 0);
    const dailyTrips = stops.map(s => (s as any).daily_trips ?? s.tripsCount ?? 0);
    const avgDailyTrips = dailyTrips.reduce((a: number, b: number) => a + b, 0) / Math.max(dailyTrips.length, 1);
    const morningTrips = stops.map(s => (s as any).morning_peak_trips ?? 0);
    const eveningTrips = stops.map(s => (s as any).evening_peak_trips ?? 0);
    const avgMorning = morningTrips.reduce((a: number, b: number) => a + b, 0) / Math.max(morningTrips.length, 1);
    const avgEvening = eveningTrips.reduce((a: number, b: number) => a + b, 0) / Math.max(eveningTrips.length, 1);

    const freqBuckets = [
      { label: "0 corse", min: 0, max: 0 },
      { label: "1–5", min: 1, max: 5 },
      { label: "6–15", min: 6, max: 15 },
      { label: "16–30", min: 16, max: 30 },
      { label: "31–60", min: 31, max: 60 },
      { label: "61+", min: 61, max: Infinity },
    ];
    const freqDistribution = freqBuckets.map(b => ({
      label: b.label,
      count: dailyTrips.filter((d: number) => d >= b.min && d <= b.max).length,
    }));

    // ── 2. Route quality ranking ──
    const maxRouteTrips = Math.max(...routes.map(r => r.tripsCount || 0), 1);
    const routeRanking = routes.slice(0, 20).map(r => ({
      routeId: r.routeId,
      shortName: r.routeShortName || r.routeId,
      longName: r.routeLongName || "",
      color: r.routeColor || "#3b82f6",
      tripsCount: r.tripsCount || 0,
      frequencyScore: Math.round((r.tripsCount || 0) / maxRouteTrips * 100),
    }));

    // ── 3. POI coverage analysis ──
    const POI_COVER_RADIUS_KM = 0.5;
    const coveredPois: typeof pois = [];
    const uncoveredPois: typeof pois = [];

    for (const poi of pois) {
      const hasStop = stops.some(s =>
        haversineKm(s.stopLat, s.stopLon, poi.lat, poi.lng) <= POI_COVER_RADIUS_KM
      );
      if (hasStop) coveredPois.push(poi);
      else uncoveredPois.push(poi);
    }

    const poiCategories = [...new Set(pois.map(p => p.category))];
    const poiCoverageByCategory = poiCategories.map(cat => {
      const catPois = pois.filter(p => p.category === cat);
      const catCovered = catPois.filter(p =>
        stops.some(s => haversineKm(s.stopLat, s.stopLon, p.lat, p.lng) <= POI_COVER_RADIUS_KM)
      );
      return {
        category: cat,
        total: catPois.length,
        covered: catCovered.length,
        pct: catPois.length > 0 ? Math.round(catCovered.length / catPois.length * 100) : 0,
      };
    });

    // ── 4. Population coverage ──
    const POP_COVER_RADIUS_KM = 0.8;
    let coveredPop = 0;
    const totalPop = census.reduce((a, c) => a + c.population, 0);
    for (const section of census) {
      const hasStop = stops.some(s =>
        haversineKm(s.stopLat, s.stopLon, section.centroidLat, section.centroidLng) <= POP_COVER_RADIUS_KM
      );
      if (hasStop) coveredPop += section.population;
    }
    const populationCoveragePercent = totalPop > 0 ? Math.round(coveredPop / totalPop * 100) : 0;

    // ── 5. Traffic vs service alignment ──
    const trafficAlignmentPoints = trafficPoints.slice(0, 30).map(tp => {
      const nearestStop = stops.reduce((best, s) => {
        const d = haversineKm(s.stopLat, s.stopLon, parseFloat(tp.lat), parseFloat(tp.lng));
        if (!best || d < best.dist) return { stop: s, dist: d };
        return best;
      }, null as { stop: any; dist: number } | null);

      return {
        lng: parseFloat(tp.lng),
        lat: parseFloat(tp.lat),
        congestion: parseFloat(tp.avg_congestion) || 0,
        nearestStopDist: nearestStop?.dist ?? 99,
        nearestStopTrips: nearestStop?.stop?.tripsCount ?? 0,
      };
    });

    const poorAlignmentZones = trafficAlignmentPoints.filter(
      t => t.congestion > 0.3 && t.nearestStopDist > 0.5
    );

    // ── 6. Worst served stops ──
    const stopsWithDemand = stops.map(s => {
      const nearby = census.filter(c =>
        haversineKm(s.stopLat, s.stopLon, c.centroidLat, c.centroidLng) <= 1.0
      );
      const nearbyPop = nearby.reduce((a, c) => a + c.population, 0);
      const nearbyPoiCount = pois.filter(p =>
        haversineKm(s.stopLat, s.stopLon, p.lat, p.lng) <= 0.5
      ).length;
      const demandScore = nearbyPop / 1000 + nearbyPoiCount * 2;
      const daily = (s as any).daily_trips ?? s.tripsCount ?? 0;
      const serviceScore = (s as any).service_score ?? 0;
      return {
        stopId: s.stopId, stopName: s.stopName,
        stopLat: s.stopLat, stopLon: s.stopLon,
        dailyTrips: daily,
        morningPeak: (s as any).morning_peak_trips ?? 0,
        eveningPeak: (s as any).evening_peak_trips ?? 0,
        serviceScore,
        nearbyPopulation: nearbyPop,
        nearbyPoiCount,
        demandScore: Math.round(demandScore * 10) / 10,
        gap: Math.max(0, demandScore - serviceScore / 10),
      };
    });

    stopsWithDemand.sort((a, b) => b.gap - a.gap);
    const worstServed = stopsWithDemand.slice(0, 15).filter(s => s.demandScore > 0);

    // ── 7. Overall quality score ──
    const avgServiceScore = stops.reduce((a, s) => a + ((s as any).service_score ?? 0), 0) / Math.max(stops.length, 1);
    const poiCoverageScore = pois.length > 0 ? (coveredPois.length / pois.length * 100) : 0;
    const peakScore = Math.min(avgMorning / 6, 1) * 50 + Math.min(avgEvening / 6, 1) * 50;
    const overallScore = Math.round(
      avgServiceScore * 0.35 +
      poiCoverageScore * 0.3 +
      populationCoveragePercent * 0.2 +
      peakScore * 0.15
    );

    res.json({
      overallScore,
      summary: {
        totalStops: stops.length, totalRoutes: routes.length,
        avgDailyTrips: Math.round(avgDailyTrips * 10) / 10,
        avgMorningPeak: Math.round(avgMorning * 10) / 10,
        avgEveningPeak: Math.round(avgEvening * 10) / 10,
        avgServiceScore: Math.round(avgServiceScore * 10) / 10,
        stopsWithService: withTimes.length,
        stopsNoService: stops.length - withTimes.length,
      },
      frequency: {
        distribution: freqDistribution,
        avgDailyTrips: Math.round(avgDailyTrips * 10) / 10,
        avgMorningPeak: Math.round(avgMorning * 10) / 10,
        avgEveningPeak: Math.round(avgEvening * 10) / 10,
      },
      routeRanking,
      poiCoverage: {
        totalPoi: pois.length, coveredPoi: coveredPois.length,
        uncoveredPoi: uncoveredPois.length,
        coveragePercent: Math.round(poiCoverageScore),
        byCategory: poiCoverageByCategory,
        uncoveredSample: uncoveredPois.slice(0, 10).map(p => ({
          name: p.name, category: p.category, lat: p.lat, lng: p.lng,
        })),
      },
      populationCoverage: {
        totalPopulation: totalPop, coveredPopulation: coveredPop,
        coveragePercent: populationCoveragePercent,
      },
      trafficAlignment: {
        points: trafficAlignmentPoints.slice(0, 20),
        poorAlignmentCount: poorAlignmentZones.length,
      },
      worstServed,
    });
  } catch (err) {
    req.log.error(err, "Error computing GTFS analysis");
    res.status(500).json({ error: "Errore durante l'analisi del GTFS" });
  }
});

export default router;
