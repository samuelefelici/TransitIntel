/**
 * GTFS analysis endpoints (band filtering, shapes/geojson, impact, network-analysis).
 * GET /api/gtfs/routes/active-by-band
 * GET /api/gtfs/shapes/geojson
 * GET /api/gtfs/routes/impact
 * GET /api/gtfs/routes/network-analysis
 */
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  gtfsRoutes, gtfsShapes, gtfsTrips, gtfsStopTimes,
  pointsOfInterest, censusSections, trafficSnapshots,
} from "@workspace/db/schema";
import { eq, sql } from "drizzle-orm";
import { haversineKm, timeToMinutes } from "../lib/geo-utils";
import { getLatestFeedId, modelCongestion } from "./gtfs-helpers";
import { cache } from "../middlewares/cache";

const router: IRouter = Router();

// GET /api/gtfs/routes/active-by-band
router.get("/gtfs/routes/active-by-band", cache({ ttlSeconds: 30 }), async (req, res) => {
  const hourStart = parseInt((req.query.hourStart as string) ?? "0", 10);
  const hourEnd   = parseInt((req.query.hourEnd   as string) ?? "27", 10);
  const dayParam  = (req.query.day as string | undefined)?.toLowerCase() ?? null;
  const directionIdParam = req.query.directionId !== undefined && req.query.directionId !== ""
    ? parseInt(req.query.directionId as string, 10) : null;

  try {
    const feedId = await getLatestFeedId();
    if (!feedId) return res.json({ routeIds: [] });

    const dirFilter = directionIdParam !== null && !isNaN(directionIdParam)
      ? sql` AND t.direction_id = ${directionIdParam}` : sql``;

    let dayFilter = sql``;
    if (dayParam === "feriale" || dayParam === "weekday") {
      dayFilter = sql`
        AND t.service_id IN (
          SELECT DISTINCT service_id FROM gtfs_calendar_dates
          WHERE feed_id = ${feedId} AND exception_type = '1'
            AND EXTRACT(DOW FROM TO_DATE(date,'YYYYMMDD')) IN (1,2,3,4,5)
        )`;
    } else if (dayParam === "sabato" || dayParam === "saturday") {
      dayFilter = sql`
        AND t.service_id IN (
          SELECT DISTINCT service_id FROM gtfs_calendar_dates
          WHERE feed_id = ${feedId} AND exception_type = '1'
            AND EXTRACT(DOW FROM TO_DATE(date,'YYYYMMDD')) = 6
        )`;
    } else if (dayParam === "domenica" || dayParam === "sunday") {
      dayFilter = sql`
        AND t.service_id IN (
          SELECT DISTINCT service_id FROM gtfs_calendar_dates
          WHERE feed_id = ${feedId} AND exception_type = '1'
            AND EXTRACT(DOW FROM TO_DATE(date,'YYYYMMDD')) = 0
        )`;
    }

    const result = await db.execute<{ route_id: string }>(sql`
      WITH first_stops AS (
        SELECT trip_id, feed_id, MIN(stop_sequence) AS min_seq
        FROM gtfs_stop_times
        WHERE feed_id = ${feedId}
        GROUP BY trip_id, feed_id
      )
      SELECT DISTINCT t.route_id
      FROM gtfs_trips t
      JOIN first_stops fs ON fs.trip_id = t.trip_id AND fs.feed_id = t.feed_id
      JOIN gtfs_stop_times st
        ON st.trip_id = t.trip_id AND st.feed_id = t.feed_id AND st.stop_sequence = fs.min_seq
      WHERE t.feed_id = ${feedId}
        AND CAST(SPLIT_PART(st.departure_time, ':', 1) AS INTEGER) >= ${hourStart}
        AND CAST(SPLIT_PART(st.departure_time, ':', 1) AS INTEGER) < ${hourEnd}
        ${dirFilter}
        ${dayFilter}
    `);

    return void res.json({ routeIds: result.rows.map(r => r.route_id), count: result.rows.length });
  } catch (err) {
    req.log.error(err, "Error fetching active routes by band");
    return void res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/gtfs/shapes/geojson
router.get("/gtfs/shapes/geojson", cache({ ttlSeconds: 30 }), async (req, res) => {
  const feedId = req.query.feedId as string | undefined;
  const routeIds = req.query.routeIds
    ? (req.query.routeIds as string).split(",").map(s => s.trim()).filter(Boolean)
    : [];
  const segmented = req.query.segmented === "true";
  const directionIdParam = req.query.directionId !== undefined ? parseInt(req.query.directionId as string) : null;
  const hourParam = req.query.hour !== undefined ? parseFloat(req.query.hour as string) : null;

  try {
    const resolvedFeedId = feedId || await getLatestFeedId();

    const whereCondition = resolvedFeedId && routeIds.length > 0
      ? sql`${gtfsShapes.feedId} = ${resolvedFeedId} AND ${gtfsShapes.routeId} IN (${sql.join(routeIds.map(r => sql`${r}`), sql`, `)})`
      : resolvedFeedId
        ? eq(gtfsShapes.feedId, resolvedFeedId)
        : undefined;

    let rows = await db
      .select({
        geojson: gtfsShapes.geojson,
        shapeId: gtfsShapes.shapeId,
        routeId: gtfsShapes.routeId,
        routeShortName: gtfsShapes.routeShortName,
        routeColor: gtfsShapes.routeColor,
      })
      .from(gtfsShapes)
      .where(whereCondition)
      .limit(routeIds.length > 0 ? 2000 : 1200);

    if (directionIdParam !== null && !isNaN(directionIdParam) && resolvedFeedId) {
      const validShapeRows = await db.execute<{ shape_id: string }>(sql`
        SELECT DISTINCT shape_id FROM gtfs_trips
        WHERE feed_id = ${resolvedFeedId} AND direction_id = ${directionIdParam} AND shape_id IS NOT NULL
      `);
      const validShapeIds = new Set(validShapeRows.rows.map(r => r.shape_id));
      rows = rows.filter(r => r.shapeId && validShapeIds.has(r.shapeId));
    }

    // Load TomTom snapshots
    const rawTraffic = await db.execute<{
      lng: number; lat: number;
      congestion: number; speed: number; freeflow: number; hour: number;
    }>(sql`
      SELECT lng, lat, congestion_level AS congestion, speed, freeflow_speed AS freeflow,
             EXTRACT(HOUR FROM captured_at)::integer AS hour
      FROM traffic_snapshots
    `);

    const allTraffic = rawTraffic.rows;
    const availableHours = [...new Set(allTraffic.map(t => t.hour).filter(h => h != null))] as number[];

    let relevantTraffic = allTraffic;
    if (hourParam !== null && availableHours.length > 0) {
      const closestHour = availableHours.reduce((best, h) =>
        Math.abs(h - hourParam) < Math.abs(best - hourParam) ? h : best, availableHours[0]);
      if (Math.abs(closestHour - hourParam) <= 2) {
        relevantTraffic = allTraffic.filter(t => t.hour === closestHour);
      } else {
        relevantTraffic = [];
      }
    }

    function nearestRealCongestion(lng: number, lat: number): { congestion: number; speed: number; freeflow: number } | null {
      const RADIUS = 0.06;
      const nearby = relevantTraffic.filter(t => Math.abs(t.lng - lng) < RADIUS && Math.abs(t.lat - lat) < RADIUS);
      if (!nearby.length) return null;
      const best = nearby.sort((a, b) => {
        const da = (a.lng - lng) ** 2 + (a.lat - lat) ** 2;
        const db2 = (b.lng - lng) ** 2 + (b.lat - lat) ** 2;
        return da - db2;
      })[0];
      return { congestion: best.congestion ?? 0, speed: best.speed ?? 0, freeflow: best.freeflow ?? 0 };
    }

    const features: any[] = [];

    for (const row of rows) {
      const geoj = row.geojson as any;
      const coords: [number, number][] = geoj?.geometry?.coordinates || [];
      if (coords.length < 2) continue;

      const routeProps = {
        shapeId: row.shapeId,
        routeId: row.routeId ?? null,
        routeShortName: row.routeShortName ?? null,
        routeColor: row.routeColor ?? "#6b7280",
      };

      if (segmented && coords.length >= 6) {
        const segSize = Math.max(4, Math.ceil(coords.length / Math.min(coords.length / 4, 30)));
        for (let i = 0; i < coords.length - 1; i += segSize - 1) {
          const segCoords = coords.slice(i, Math.min(i + segSize, coords.length));
          if (segCoords.length < 2) continue;
          const mid = segCoords[Math.floor(segCoords.length / 2)];
          const realData = nearestRealCongestion(mid[0], mid[1]);

          let congestion: number;
          let speed: number | null = null;
          let freeflow: number | null = null;
          let speedReduction: number | null = null;
          let dataSource: "tomtom" | "model" = "model";

          if (realData) {
            dataSource = "tomtom";
            congestion = Math.round(realData.congestion * 100) / 100;
            speed = realData.speed;
            freeflow = realData.freeflow;
            speedReduction = freeflow > 0 ? Math.round((1 - (speed ?? 0) / freeflow) * 100) : null;
          } else {
            const h = hourParam !== null ? hourParam : 12;
            congestion = Math.round(modelCongestion(h, mid[0], mid[1]) * 100) / 100;
          }

          features.push({
            type: "Feature",
            geometry: { type: "LineString", coordinates: segCoords },
            properties: { ...routeProps, congestion, speedReduction, speed, freeflow, dataSource },
          });
        }
      } else {
        const step = Math.max(1, Math.floor(coords.length / 10));
        let total = 0, samples = 0;
        let hasReal = false;
        for (let i = 0; i < coords.length; i += step) {
          const r = nearestRealCongestion(coords[i][0], coords[i][1]);
          if (r) { total += r.congestion; samples++; hasReal = true; }
          else if (!hasReal && hourParam !== null) {
            total += modelCongestion(hourParam, coords[i][0], coords[i][1]);
            samples++;
          }
        }
        const avgCongestion = samples > 0 ? Math.round(total / samples * 100) / 100 : null;
        features.push({
          type: "Feature",
          geometry: geoj?.geometry,
          properties: { ...routeProps, congestion: avgCongestion, speedReduction: null, dataSource: hasReal ? "tomtom" : "model" },
        });
      }
    }

    res.json({ type: "FeatureCollection", features });
  } catch (err) {
    req.log.error(err, "Error fetching GTFS shapes");
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/gtfs/routes/impact
router.get("/gtfs/routes/impact", cache({ ttlSeconds: 60 }), async (req, res) => {
  const feedId = req.query.feedId as string | undefined;
  try {
    const routes = feedId
      ? await db.select().from(gtfsRoutes).where(eq(gtfsRoutes.feedId, feedId))
      : await db.select().from(gtfsRoutes).orderBy(sql`trips_count DESC`).limit(200);

    const census = await db.select({
      lng: censusSections.centroidLng,
      lat: censusSections.centroidLat,
      pop: censusSections.population,
      density: censusSections.density,
    }).from(censusSections);

    const pois = await db.select({
      lng: pointsOfInterest.lng,
      lat: pointsOfInterest.lat,
      category: pointsOfInterest.category,
    }).from(pointsOfInterest);

    const traffic = await db.select({
      lng: trafficSnapshots.lng,
      lat: trafficSnapshots.lat,
      congestion: trafficSnapshots.congestionLevel,
    }).from(trafficSnapshots);

    const maxTrips = Math.max(...routes.map(r => r.tripsCount ?? 0), 1);

    const CITY_KEYWORDS: Record<string, { lng: number; lat: number }> = {
      "ancona": { lng: 13.517, lat: 43.617 },
      "jesi": { lng: 13.241, lat: 43.524 },
      "senigallia": { lng: 13.219, lat: 43.715 },
      "fabriano": { lng: 12.907, lat: 43.337 },
      "osimo": { lng: 13.479, lat: 43.483 },
      "falconara": { lng: 13.394, lat: 43.629 },
      "chiaravalle": { lng: 13.322, lat: 43.599 },
      "castelfidardo": { lng: 13.549, lat: 43.462 },
      "loreto": { lng: 13.606, lat: 43.441 },
      "torrette": { lng: 13.454, lat: 43.584 },
      "baraccola": { lng: 13.499, lat: 43.558 },
      "stazione": { lng: 13.502, lat: 43.606 },
      "porto": { lng: 13.503, lat: 43.625 },
    };

    const result = routes.map(route => {
      const longName = (route.routeLongName || "").toLowerCase();
      const shortName = route.routeShortName || route.routeId;
      const trips = route.tripsCount ?? 0;

      const matchedCities = Object.entries(CITY_KEYWORDS).filter(([k]) => longName.includes(k));

      let demandPop = 0, demandPoi = 0, trafficCongestion = 0, trafficSamples = 0;

      for (const [, center] of matchedCities) {
        const R = 0.06;
        census.filter(c =>
          Math.abs((c.lng ?? 0) - center.lng) < R && Math.abs((c.lat ?? 0) - center.lat) < R
        ).forEach(c => { demandPop += c.pop ?? 0; });

        pois.filter(p =>
          Math.abs(p.lng - center.lng) < R && Math.abs(p.lat - center.lat) < R
        ).forEach(() => { demandPoi++; });

        traffic.filter(t =>
          Math.abs(t.lng - center.lng) < R && Math.abs(t.lat - center.lat) < R
        ).forEach(t => { trafficCongestion += t.congestion ?? 0; trafficSamples++; });
      }

      const avgCongestion = trafficSamples > 0 ? trafficCongestion / trafficSamples : 0;
      const demandScore = Math.min(demandPop / 30000, 1) * 0.7 + Math.min(demandPoi / 20, 1) * 0.3;
      const supplyScore = Math.min(trips / (maxTrips * 0.5), 1);
      const gap = Math.round((demandScore - supplyScore) * 100);

      return {
        id: route.id, routeId: route.routeId, shortName,
        longName: route.routeLongName || "",
        color: route.routeColor || "#6b7280",
        textColor: route.routeTextColor || "#ffffff",
        tripsCount: trips,
        supplyScore: Math.round(supplyScore * 100),
        demandScore: Math.round(demandScore * 100),
        gap,
        avgCongestion: Math.round(avgCongestion * 100) / 100,
        citiesServed: matchedCities.map(([k]) => k),
      };
    });

    result.sort((a, b) => b.gap - a.gap);
    res.json({ data: result });
  } catch (err) {
    req.log.error(err, "Error computing route impact");
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/gtfs/routes/network-analysis
router.get("/gtfs/routes/network-analysis", cache({ ttlSeconds: 60 }), async (req, res) => {
  const dayParam  = (req.query.day      as string) || "";
  const dateFrom  = (req.query.dateFrom as string) || "";
  const dateTo    = (req.query.dateTo   as string) || "";

  try {
    // ── 1. Route metadata ──
    const routes = await db.select({
      routeId: gtfsRoutes.routeId,
      shortName: gtfsRoutes.routeShortName,
      longName: gtfsRoutes.routeLongName,
      color: gtfsRoutes.routeColor,
      textColor: gtfsRoutes.routeTextColor,
      tripsCount: gtfsRoutes.tripsCount,
    }).from(gtfsRoutes).orderBy(sql`trips_count DESC`).limit(200);

    // ── 2. Route → distinct stops ──
    const routeStopRows = await db.execute(sql`
      SELECT DISTINCT t.route_id, st.stop_id, s.stop_name
      FROM gtfs_trips t
      JOIN gtfs_stop_times st ON st.trip_id = t.trip_id
      JOIN gtfs_stops s ON s.stop_id = st.stop_id
      ORDER BY t.route_id
    `);

    const routeStopMap = new Map<string, { ids: Set<string>; names: Map<string, string> }>();
    for (const row of routeStopRows.rows as any[]) {
      if (!routeStopMap.has(row.route_id)) {
        routeStopMap.set(row.route_id, { ids: new Set(), names: new Map() });
      }
      const entry = routeStopMap.get(row.route_id)!;
      entry.ids.add(row.stop_id);
      entry.names.set(row.stop_id, row.stop_name);
    }

    const routeIds = Array.from(routeStopMap.keys());

    // ── 3. Pairwise overlap ──
    interface InternalPair {
      routeA: string; routeB: string;
      sharedStops: number; stopsA: number; stopsB: number;
      jaccardPct: number; minCoveragePct: number;
      sharedSample: string[];
      _sharedStopIds: string[];
      _stopNames: Map<string, string>;
      collisionCount: number;
      collisionDetails: { stopName: string; times: string[]; timesA: string[]; timesB: string[]; deltaMin: number }[];
    }
    const pairs: InternalPair[] = [];

    for (let i = 0; i < routeIds.length; i++) {
      for (let j = i + 1; j < routeIds.length; j++) {
        const a = routeStopMap.get(routeIds[i])!;
        const b = routeStopMap.get(routeIds[j])!;
        const [smaller, larger] = a.ids.size <= b.ids.size ? [a, b] : [b, a];
        const shared: string[] = [];
        for (const sid of smaller.ids) {
          if (larger.ids.has(sid)) shared.push(sid);
        }
        if (shared.length < 3) continue;
        const union = a.ids.size + b.ids.size - shared.length;
        const jaccardPct = Math.round(shared.length / union * 100);
        const minCov = Math.round(shared.length / Math.min(a.ids.size, b.ids.size) * 100);
        if (minCov < 15) continue;
        const mergedNames = new Map([...a.names, ...b.names]);
        pairs.push({
          routeA: routeIds[i], routeB: routeIds[j],
          sharedStops: shared.length, stopsA: a.ids.size, stopsB: b.ids.size,
          jaccardPct, minCoveragePct: minCov,
          sharedSample: shared.slice(0, 8).map(sid => mergedNames.get(sid) ?? sid),
          _sharedStopIds: shared, _stopNames: mergedNames,
          collisionCount: 0, collisionDetails: [],
        });
      }
    }
    pairs.sort((a, b) => b.minCoveragePct - a.minCoveragePct);
    const topPairs = pairs.slice(0, 60);

    // ── 4. Service IDs for day + date-range filter ──
    let serviceIdSet: Set<string> | null = null;
    if (dayParam || dateFrom || dateTo) {
      let filter = sql`1=1`;
      if (dayParam) {
        if (dayParam === "weekday")       filter = sql`${filter} AND EXTRACT(DOW FROM to_date(date::text,'YYYYMMDD')) IN (1,2,3,4,5)`;
        else if (dayParam === "saturday") filter = sql`${filter} AND EXTRACT(DOW FROM to_date(date::text,'YYYYMMDD')) = 6`;
        else                              filter = sql`${filter} AND EXTRACT(DOW FROM to_date(date::text,'YYYYMMDD')) = 0`;
      }
      if (dateFrom) filter = sql`${filter} AND date >= ${dateFrom}`;
      if (dateTo)   filter = sql`${filter} AND date <= ${dateTo}`;
      const cdRows = await db.execute(sql`
        SELECT DISTINCT service_id FROM gtfs_calendar_dates
        WHERE ${filter}
      `);
      serviceIdSet = new Set((cdRows.rows as any[]).map(r => String(r.service_id)));
    }

    // ── 5. Schedule collisions at shared stops ──
    const allSharedStopIds = [...new Set(topPairs.flatMap(p => p._sharedStopIds))];

    if (allSharedStopIds.length > 0) {
      let collisionRows: any[];
      if (serviceIdSet && serviceIdSet.size > 0) {
        const sids = [...serviceIdSet];
        const result = await db.execute(sql`
          SELECT DISTINCT t.route_id, st.stop_id, st.departure_time
          FROM gtfs_trips t
          JOIN gtfs_stop_times st ON st.trip_id = t.trip_id
          WHERE t.service_id = ANY(ARRAY[${sql.join(sids.map(s => sql`${s}`), sql`, `)}])
          AND st.stop_id = ANY(ARRAY[${sql.join(allSharedStopIds.map(s => sql`${s}`), sql`, `)}])
        `);
        collisionRows = result.rows as any[];
      } else {
        const result = await db.execute(sql`
          SELECT DISTINCT t.route_id, st.stop_id, st.departure_time
          FROM gtfs_trips t
          JOIN gtfs_stop_times st ON st.trip_id = t.trip_id
          WHERE st.stop_id = ANY(ARRAY[${sql.join(allSharedStopIds.map(s => sql`${s}`), sql`, `)}])
        `);
        collisionRows = result.rows as any[];
      }

      const stopRouteTimes = new Map<string, Map<string, number[]>>();
      for (const row of collisionRows) {
        const parts = (row.departure_time as string)?.split(":").map(Number);
        if (!parts || parts.length < 2) continue;
        const mins = parts[0] * 60 + parts[1];
        if (!stopRouteTimes.has(row.stop_id)) stopRouteTimes.set(row.stop_id, new Map());
        const smap = stopRouteTimes.get(row.stop_id)!;
        if (!smap.has(row.route_id)) smap.set(row.route_id, []);
        smap.get(row.route_id)!.push(mins);
      }

      const DELTA = 2;
      const fmtMin = (m: number) => `${Math.floor(m / 60).toString().padStart(2, "0")}:${(m % 60).toString().padStart(2, "0")}`;
      for (const pair of topPairs) {
        let count = 0;
        for (let k = 0; k < pair._sharedStopIds.length; k++) {
          const stopId = pair._sharedStopIds[k];
          const smap = stopRouteTimes.get(stopId);
          if (!smap) continue;
          const timesA = smap.get(pair.routeA) ?? [];
          const timesB = smap.get(pair.routeB) ?? [];
          if (!timesA.length || !timesB.length) continue;
          const hitTimesAll: string[] = [];
          const hitTimesA: string[] = [];
          const hitTimesB: string[] = [];
          let minDelta = Infinity;
          for (const ta of timesA) {
            for (const tb of timesB) {
              const d = Math.abs(ta - tb);
              if (d <= DELTA) {
                count++;
                hitTimesAll.push(fmtMin(Math.min(ta, tb)));
                hitTimesA.push(fmtMin(ta));
                hitTimesB.push(fmtMin(tb));
                if (d < minDelta) minDelta = d;
              }
            }
          }
          if (hitTimesAll.length > 0 && pair.collisionDetails.length < 10) {
            pair.collisionDetails.push({
              stopName: pair._stopNames.get(stopId) ?? stopId,
              times: [...new Set(hitTimesAll)].slice(0, 6),
              timesA: [...new Set(hitTimesA)].slice(0, 6),
              timesB: [...new Set(hitTimesB)].slice(0, 6),
              deltaMin: minDelta === Infinity ? 0 : minDelta,
            });
          }
        }
        pair.collisionCount = count;
      }
      topPairs.sort((a, b) => b.collisionCount - a.collisionCount);
    }

    // ── 6. Per-route headway ──
    let headwayDeptRows: any[];
    if (serviceIdSet && serviceIdSet.size > 0) {
      const sids = [...serviceIdSet];
      const result = await db.execute(sql`
        SELECT t.route_id, st.departure_time
        FROM gtfs_trips t
        JOIN gtfs_stop_times st ON st.trip_id = t.trip_id
        WHERE st.stop_sequence = 1
        AND t.service_id = ANY(ARRAY[${sql.join(sids.map(s => sql`${s}`), sql`, `)}])
        ORDER BY t.route_id, st.departure_time
      `);
      headwayDeptRows = result.rows as any[];
    } else {
      const result = await db.execute(sql`
        SELECT t.route_id, st.departure_time
        FROM gtfs_trips t
        JOIN gtfs_stop_times st ON st.trip_id = t.trip_id
        WHERE st.stop_sequence = 1
        ORDER BY t.route_id, st.departure_time
      `);
      headwayDeptRows = result.rows as any[];
    }

    const routeDepMap = new Map<string, number[]>();
    for (const row of headwayDeptRows) {
      const parts = (row.departure_time as string)?.split(":").map(Number);
      if (!parts || parts.length < 2) continue;
      const mins = parts[0] * 60 + parts[1];
      if (!routeDepMap.has(row.route_id)) routeDepMap.set(row.route_id, []);
      routeDepMap.get(row.route_id)!.push(mins);
    }

    const HEADWAY_BANDS = [
      { id: "early",   label: "Prima mattina",  from: 5,  to: 8  },
      { id: "peak_am", label: "Punta mattina",  from: 8,  to: 10 },
      { id: "midday",  label: "Metà giornata",  from: 10, to: 14 },
      { id: "peak_pm", label: "Punta sera",     from: 14, to: 18 },
      { id: "evening", label: "Sera",           from: 18, to: 22 },
    ];

    interface HeadwayStats {
      routeId: string; departures: number;
      avgHeadwayMin: number; maxHeadwayMin: number; minHeadwayMin: number;
      worstGapHour: number;
      bands: { id: string; label: string; avgMin: number; departures: number }[];
    }
    const headwayStats: HeadwayStats[] = [];

    for (const [routeId, deps] of routeDepMap) {
      if (deps.length < 2) continue;
      const sorted = [...deps].sort((a, b) => a - b);
      const gaps: number[] = [];
      for (let k = 1; k < sorted.length; k++) {
        const g = sorted[k] - sorted[k - 1];
        if (g > 0 && g < 300) gaps.push(g);
      }
      if (gaps.length === 0) continue;
      const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
      const max = Math.max(...gaps);
      const min = Math.min(...gaps);
      const worstGapHour = Math.floor(sorted[gaps.indexOf(max)] / 60);

      const bands = HEADWAY_BANDS.map(band => {
        const bandDeps = sorted.filter(t => t >= band.from * 60 && t < band.to * 60);
        const bandGaps = bandDeps.slice(1).map((t, i) => t - bandDeps[i]).filter(g => g > 0 && g < 300);
        return {
          id: band.id, label: band.label,
          avgMin: bandGaps.length > 0 ? Math.round(bandGaps.reduce((a, b) => a + b, 0) / bandGaps.length) : 0,
          departures: bandDeps.length,
        };
      });

      headwayStats.push({
        routeId, departures: sorted.length,
        avgHeadwayMin: Math.round(avg), maxHeadwayMin: Math.round(max),
        minHeadwayMin: Math.round(min), worstGapHour, bands,
      });
    }
    headwayStats.sort((a, b) => b.maxHeadwayMin - a.maxHeadwayMin);

    // ── 7. Route ranking ──
    const headwayMap = new Map(headwayStats.map(h => [h.routeId, h]));
    const routeRanking = routes.map(r => ({
      routeId: r.routeId,
      shortName: r.shortName ?? r.routeId,
      longName: r.longName ?? "",
      color: r.color ?? "#6b7280",
      textColor: r.textColor ?? "#fff",
      tripsCount: r.tripsCount ?? 0,
      uniqueStops: routeStopMap.get(r.routeId)?.ids.size ?? 0,
      avgHeadway: headwayMap.get(r.routeId)?.avgHeadwayMin ?? null,
      maxHeadway: headwayMap.get(r.routeId)?.maxHeadwayMin ?? null,
      overlapCount: topPairs.filter(p => p.routeA === r.routeId || p.routeB === r.routeId).length,
      collisionCount: topPairs.filter(p => p.routeA === r.routeId || p.routeB === r.routeId)
        .reduce((sum, p) => sum + p.collisionCount, 0),
    }));

    // ── 8. Summary KPIs ──
    const pairsWithCollisions = topPairs.filter(p => p.collisionCount > 0);
    const totalCollisions = pairsWithCollisions.reduce((s, p) => s + p.collisionCount, 0);
    const worstHeadway = headwayStats[0]?.maxHeadwayMin ?? 0;
    const irregularRoutes = headwayStats.filter(h =>
      h.bands.some(b => b.avgMin > 60) && h.bands.some(b => b.avgMin > 0 && b.avgMin < 20)
    ).length;

    const cleanPairs = topPairs.map(({ _sharedStopIds, _stopNames, ...rest }) => rest);

    res.json({
      kpis: {
        scheduleCollisions: totalCollisions,
        routePairsWithCollisions: pairsWithCollisions.length,
        worstHeadway, irregularRoutes,
        totalPairs: pairs.length,
      },
      overlaps: cleanPairs,
      headways: headwayStats.slice(0, 60),
      routes: routeRanking,
      filters: { day: dayParam, dateFrom, dateTo },
    });
  } catch (err) {
    req.log.error(err, "Error in network-analysis");
    res.status(500).json({ error: "Errore analisi rete" });
  }
});

export default router;
