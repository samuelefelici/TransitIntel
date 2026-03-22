import { Router, type IRouter } from "express";
import multer from "multer";
import AdmZip from "adm-zip";
import { parse } from "csv-parse/sync";
import { db } from "@workspace/db";
import { gtfsFeeds, gtfsStops, gtfsRoutes, gtfsShapes, gtfsTrips, gtfsStopTimes, gtfsCalendar, gtfsCalendarDates, pointsOfInterest, censusSections, trafficSnapshots } from "@workspace/db/schema";
import { eq, sql } from "drizzle-orm";

const router: IRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 150 * 1024 * 1024 } });

function parseCsv(content: string): Record<string, string>[] {
  try {
    return parse(content, { columns: true, skip_empty_lines: true, trim: true, relax_column_count: true });
  } catch {
    return [];
  }
}

// Haversine distance in km
function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Parse HH:MM:SS → minutes since midnight (handles 25:00:00 etc)
function timeToMinutes(t: string): number {
  const parts = t.split(":").map(Number);
  return (parts[0] || 0) * 60 + (parts[1] || 0);
}

function buildShapeGeojson(shapePoints: Record<string, string>[]): { shapeId: string; geojson: object }[] {
  const byShape: Record<string, { seq: number; lng: number; lat: number }[]> = {};
  for (const p of shapePoints) {
    const id = p["shape_id"] || p["shape_id "];
    if (!id) continue;
    const lng = parseFloat(p["shape_pt_lon"] || "0");
    const lat = parseFloat(p["shape_pt_lat"] || "0");
    const seq = parseInt(p["shape_pt_sequence"] || "0");
    if (!byShape[id]) byShape[id] = [];
    byShape[id].push({ seq, lng, lat });
  }
  return Object.entries(byShape).map(([shapeId, pts]) => {
    pts.sort((a, b) => a.seq - b.seq);
    return {
      shapeId,
      geojson: {
        type: "Feature",
        geometry: { type: "LineString", coordinates: pts.map(p => [p.lng, p.lat]) },
        properties: { shapeId },
      },
    };
  });
}

// POST /api/gtfs/upload
router.post("/gtfs/upload", upload.single("file"), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: "Nessun file ricevuto. Invia uno zip GTFS come campo 'file'." });
    return;
  }

  try {
    const zip = new AdmZip(req.file.buffer);
    const entries = zip.getEntries();
    const getFile = (name: string): string | null => {
      const entry = entries.find(e => e.entryName.toLowerCase().endsWith(name));
      return entry ? entry.getData().toString("utf-8") : null;
    };

    const stopsContent = getFile("stops.txt");
    const routesContent = getFile("routes.txt");
    const tripsContent = getFile("trips.txt");
    const shapesContent = getFile("shapes.txt");
    const stopTimesContent = getFile("stop_times.txt");
    const agencyContent = getFile("agency.txt");
    const feedInfoContent = getFile("feed_info.txt");
    const calendarContent = getFile("calendar.txt");
    const calendarDatesContent = getFile("calendar_dates.txt");

    if (!stopsContent || !routesContent) {
      res.status(400).json({ error: "GTFS non valido: mancano stops.txt o routes.txt" });
      return;
    }

    const stopsRaw = parseCsv(stopsContent);
    const routesRaw = parseCsv(routesContent);
    const tripsRaw = tripsContent ? parseCsv(tripsContent) : [];
    const shapesRaw = shapesContent ? parseCsv(shapesContent) : [];
    const stopTimesRaw = stopTimesContent ? parseCsv(stopTimesContent) : [];
    const agencyRaw = agencyContent ? parseCsv(agencyContent) : [];
    const feedInfoRaw = feedInfoContent ? parseCsv(feedInfoContent) : [];
    const calendarRaw = calendarContent ? parseCsv(calendarContent) : [];
    const calendarDatesRaw = calendarDatesContent ? parseCsv(calendarDatesContent) : [];

    // Build trip index per route
    const tripsPerRoute: Record<string, number> = {};
    for (const t of tripsRaw) {
      const rid = t["route_id"] || "";
      if (rid) tripsPerRoute[rid] = (tripsPerRoute[rid] || 0) + 1;
    }

    // Process stop_times: compute daily, morning peak (420–540 min = 7–9h), evening peak (1020–1140 = 17–19h) trips per stop
    const stopDailyTrips: Record<string, number> = {};
    const stopMorningPeak: Record<string, number> = {};
    const stopEveningPeak: Record<string, number> = {};
    const seenTripStop = new Set<string>();

    for (const st of stopTimesRaw) {
      const stopId = st["stop_id"] || "";
      const tripId = st["trip_id"] || "";
      const dep = st["departure_time"] || st["arrival_time"] || "";
      if (!stopId || !tripId || !dep) continue;

      const key = `${tripId}|${stopId}`;
      if (seenTripStop.has(key)) continue;
      seenTripStop.add(key);

      stopDailyTrips[stopId] = (stopDailyTrips[stopId] || 0) + 1;
      const mins = timeToMinutes(dep);
      if (mins >= 420 && mins <= 540) stopMorningPeak[stopId] = (stopMorningPeak[stopId] || 0) + 1;
      if (mins >= 1020 && mins <= 1140) stopEveningPeak[stopId] = (stopEveningPeak[stopId] || 0) + 1;
    }

    // Max for normalization
    const maxDaily = Math.max(...Object.values(stopDailyTrips), 1);
    const maxMorning = Math.max(...Object.values(stopMorningPeak), 1);
    const maxEvening = Math.max(...Object.values(stopEveningPeak), 1);

    // Shapes — import all (no truncation)
    const shapePairs = buildShapeGeojson(shapesRaw);

    const agencyName = agencyRaw[0]?.["agency_name"] || null;
    const feedStart = feedInfoRaw[0]?.["feed_start_date"] || null;
    const feedEnd = feedInfoRaw[0]?.["feed_end_date"] || null;

    const [feed] = await db.insert(gtfsFeeds).values({
      filename: req.file.originalname,
      agencyName,
      feedStartDate: feedStart,
      feedEndDate: feedEnd,
      stopsCount: stopsRaw.length,
      routesCount: routesRaw.length,
      tripsCount: tripsRaw.length,
      shapesCount: shapePairs.length,
    }).returning();

    // Insert stops with service stats
    const stopsToInsert = stopsRaw
      .filter(s => s["stop_lat"] && s["stop_lon"])
      .map(s => {
        const sid = s["stop_id"] || "";
        const daily = stopDailyTrips[sid] || 0;
        const morning = stopMorningPeak[sid] || 0;
        const evening = stopEveningPeak[sid] || 0;
        // Service score: frequency 50% + morning peak 25% + evening peak 25%
        const freqScore = Math.min(daily / Math.max(maxDaily * 0.3, 1), 1) * 50;
        const mornScore = Math.min(morning / 6, 1) * 25; // 6 corse = ogni 20 min
        const eveScore = Math.min(evening / 6, 1) * 25;
        const serviceScore = Math.round((freqScore + mornScore + eveScore) * 10) / 10;
        return {
          feedId: feed.id,
          stopId: sid,
          stopCode: s["stop_code"] || null,
          stopName: s["stop_name"] || "Senza nome",
          stopDesc: s["stop_desc"] || null,
          stopLat: parseFloat(s["stop_lat"]),
          stopLon: parseFloat(s["stop_lon"]),
          wheelchairBoarding: parseInt(s["wheelchair_boarding"] || "0") || 0,
          tripsCount: daily,
          morningPeakTrips: morning,
          eveningPeakTrips: evening,
          serviceScore,
        };
      })
      .filter(s => !isNaN(s.stopLat) && !isNaN(s.stopLon));

    // Insert stops in batches
    for (let i = 0; i < stopsToInsert.length; i += 500) {
      const batch = stopsToInsert.slice(i, i + 500);
      await db.execute(sql`
        INSERT INTO gtfs_stops (feed_id, stop_id, stop_code, stop_name, stop_desc, stop_lat, stop_lon, wheelchair_boarding, trips_count, morning_peak_trips, evening_peak_trips, service_score)
        VALUES ${sql.join(
          batch.map(s => sql`(${feed.id}, ${s.stopId}, ${s.stopCode}, ${s.stopName}, ${s.stopDesc}, ${s.stopLat}, ${s.stopLon}, ${s.wheelchairBoarding}, ${s.tripsCount}, ${s.morningPeakTrips}, ${s.eveningPeakTrips}, ${s.serviceScore})`),
          sql`, `
        )}
      `);
    }

    // Insert routes
    const routesToInsert = routesRaw.map(r => ({
      feedId: feed.id,
      routeId: r["route_id"] || "",
      agencyId: r["agency_id"] || null,
      routeShortName: r["route_short_name"] || null,
      routeLongName: r["route_long_name"] || null,
      routeType: parseInt(r["route_type"] || "3") || 3,
      routeColor: r["route_color"] ? `#${r["route_color"]}` : null,
      routeTextColor: r["route_text_color"] ? `#${r["route_text_color"]}` : null,
      tripsCount: tripsPerRoute[r["route_id"]] || 0,
    }));
    for (let i = 0; i < routesToInsert.length; i += 200) {
      await db.insert(gtfsRoutes).values(routesToInsert.slice(i, i + 200));
    }

    // Build shape_id → route mapping via trips.txt
    const shapeToRoute: Record<string, { routeId: string; routeShortName: string; routeColor: string }> = {};
    for (const trip of tripsRaw) {
      const shapeId = trip["shape_id"] || "";
      const routeId = trip["route_id"] || "";
      if (!shapeId || !routeId || shapeToRoute[shapeId]) continue;
      const route = routesRaw.find(r => r["route_id"] === routeId);
      shapeToRoute[shapeId] = {
        routeId,
        routeShortName: route?.["route_short_name"] || routeId,
        routeColor: route?.["route_color"] ? `#${route["route_color"]}` : "#6b7280",
      };
    }

    // Insert shapes with route info
    if (shapePairs.length > 0) {
      for (let i = 0; i < shapePairs.length; i += 100) {
        await db.insert(gtfsShapes).values(
          shapePairs.slice(i, i + 100).map(s => ({
            feedId: feed.id,
            shapeId: s.shapeId,
            routeId: shapeToRoute[s.shapeId]?.routeId ?? null,
            routeShortName: shapeToRoute[s.shapeId]?.routeShortName ?? null,
            routeColor: shapeToRoute[s.shapeId]?.routeColor ?? null,
            geojson: s.geojson,
          }))
        );
      }
    }

    // Insert calendar (regular weekly service patterns)
    if (calendarRaw.length > 0) {
      const calendarRows = calendarRaw.map(c => ({
        feedId: feed.id,
        serviceId: c["service_id"] || "",
        monday: parseInt(c["monday"] || "0") || 0,
        tuesday: parseInt(c["tuesday"] || "0") || 0,
        wednesday: parseInt(c["wednesday"] || "0") || 0,
        thursday: parseInt(c["thursday"] || "0") || 0,
        friday: parseInt(c["friday"] || "0") || 0,
        saturday: parseInt(c["saturday"] || "0") || 0,
        sunday: parseInt(c["sunday"] || "0") || 0,
        startDate: c["start_date"] || "",
        endDate: c["end_date"] || "",
      })).filter(c => c.serviceId);
      for (let i = 0; i < calendarRows.length; i += 200) {
        await db.insert(gtfsCalendar).values(calendarRows.slice(i, i + 200));
      }
    }

    // Insert calendar_dates (exceptions)
    if (calendarDatesRaw.length > 0) {
      const cdRows = calendarDatesRaw.map(c => ({
        feedId: feed.id,
        serviceId: c["service_id"] || "",
        date: c["date"] || "",
        exceptionType: parseInt(c["exception_type"] || "1") || 1,
      })).filter(c => c.serviceId && c.date);
      for (let i = 0; i < cdRows.length; i += 500) {
        await db.insert(gtfsCalendarDates).values(cdRows.slice(i, i + 500));
      }
    }

    // Insert trips
    if (tripsRaw.length > 0) {
      const tripRows = tripsRaw.map(t => ({
        feedId: feed.id,
        tripId: t["trip_id"] || "",
        routeId: t["route_id"] || "",
        serviceId: t["service_id"] || "",
        tripHeadsign: t["trip_headsign"] || null,
        directionId: parseInt(t["direction_id"] || "0") || 0,
        shapeId: t["shape_id"] || null,
      })).filter(t => t.tripId && t.routeId && t.serviceId);
      for (let i = 0; i < tripRows.length; i += 500) {
        await db.insert(gtfsTrips).values(tripRows.slice(i, i + 500));
      }
    }

    // Insert stop_times (only first occurrence of each trip+stop to keep size manageable)
    // Store: trip_id, stop_id, stop_sequence, departure_time — critical for schedule analysis
    if (stopTimesRaw.length > 0) {
      const stRows = stopTimesRaw.map(st => ({
        feedId: feed.id,
        tripId: st["trip_id"] || "",
        stopId: st["stop_id"] || "",
        stopSequence: parseInt(st["stop_sequence"] || "0") || 0,
        departureTime: st["departure_time"] || st["arrival_time"] || null,
        arrivalTime: st["arrival_time"] || null,
      })).filter(st => st.tripId && st.stopId);
      for (let i = 0; i < stRows.length; i += 1000) {
        await db.insert(gtfsStopTimes).values(stRows.slice(i, i + 1000));
      }
    }

    res.json({
      success: true,
      feedId: feed.id,
      stopsImported: stopsToInsert.length,
      routesImported: routesToInsert.length,
      tripsImported: tripsRaw.length,
      stopTimesImported: stopTimesRaw.length,
      calendarRows: calendarRaw.length,
      calendarDatesRows: calendarDatesRaw.length,
      shapesImported: shapePairs.length,
      agencyName,
    });
  } catch (err) {
    req.log.error(err, "Error parsing GTFS zip");
    res.status(500).json({ error: "Errore durante il parsing del GTFS" });
  }
});

// GET /api/gtfs/feeds
router.get("/gtfs/feeds", async (req, res) => {
  try {
    const feeds = await db.select().from(gtfsFeeds).orderBy(sql`uploaded_at DESC`);
    res.json({ data: feeds });
  } catch (err) {
    req.log.error(err, "Error fetching GTFS feeds");
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /api/gtfs/feeds/:id
router.delete("/gtfs/feeds/:id", async (req, res) => {
  try {
    await db.delete(gtfsFeeds).where(eq(gtfsFeeds.id, req.params.id));
    res.json({ success: true });
  } catch (err) {
    req.log.error(err, "Error deleting GTFS feed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/gtfs/stops?feedId=&limit=
router.get("/gtfs/stops", async (req, res) => {
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
    res.json({ data: stops, total: stops.length });
  } catch (err) {
    req.log.error(err, "Error fetching GTFS stops");
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/gtfs/routes?feedId=
router.get("/gtfs/routes", async (req, res) => {
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
router.get("/gtfs/shapes", async (req, res) => {
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
router.get("/gtfs/summary", async (req, res) => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) return res.json({ available: false });

    // ── 1. Basic counts + calendar DOW + hours ──────────────────
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

    // ── 2. Build service_id → day-type map ──────────────────────
    const svcMap: Record<string, { weekday: boolean; saturday: boolean; sunday: boolean }> = {};
    for (const row of calDows.rows) {
      svcMap[row.service_id] = {
        weekday:  parseInt(row.weekdays)  > 0,
        saturday: parseInt(row.saturdays) > 0,
        sunday:   parseInt(row.sundays)   > 0,
      };
    }

    // ── 3. Trips per day type ───────────────────────────────────
    const allTrips = await db.execute<{ service_id: string; shape_id: string | null }>(
      sql`SELECT service_id, shape_id FROM gtfs_trips WHERE feed_id = ${feedId}`
    );
    let weekdayTrips = 0, satTrips = 0, sunTrips = 0;
    const weekdayShapeIds = new Set<string>();
    const satShapeIds     = new Set<string>();
    const sunShapeIds     = new Set<string>();
    // Count trips per shape per day type (for km = trips * shape_length)
    const weekdayShapeTripCount: Record<string, number> = {};
    const satShapeTripCount:     Record<string, number> = {};
    const sunShapeTripCount:     Record<string, number> = {};

    for (const t of allTrips.rows) {
      const svc = svcMap[t.service_id];
      if (svc?.weekday) {
        weekdayTrips++;
        if (t.shape_id) {
          weekdayShapeIds.add(t.shape_id);
          weekdayShapeTripCount[t.shape_id] = (weekdayShapeTripCount[t.shape_id] || 0) + 1;
        }
      }
      if (svc?.saturday) {
        satTrips++;
        if (t.shape_id) {
          satShapeIds.add(t.shape_id);
          satShapeTripCount[t.shape_id] = (satShapeTripCount[t.shape_id] || 0) + 1;
        }
      }
      if (svc?.sunday) {
        sunTrips++;
        if (t.shape_id) {
          sunShapeIds.add(t.shape_id);
          sunShapeTripCount[t.shape_id] = (sunShapeTripCount[t.shape_id] || 0) + 1;
        }
      }
    }

    // ── 4. Compute shape lengths (km) ──────────────────────────
    // Collect all unique shape_ids that we need
    const allShapeIds = new Set([...weekdayShapeIds, ...satShapeIds, ...sunShapeIds]);
    const shapeLengthKm: Record<string, number> = {};

    if (allShapeIds.size > 0) {
      const shapeIdArr = Array.from(allShapeIds);
      const shapesResult = await db.execute<{ shape_id: string; geojson: any }>(sql`
        SELECT shape_id, geojson FROM gtfs_shapes
        WHERE feed_id = ${feedId} AND shape_id IN ${sql`(${sql.join(shapeIdArr.map(s => sql`${s}`), sql`, `)})`}
      `);

      // Haversine helper
      const toRad = (d: number) => (d * Math.PI) / 180;
      function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
        const R = 6371;
        const dLat = toRad(lat2 - lat1);
        const dLon = toRad(lon2 - lon1);
        const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      }

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

    // ── 5. Total km per day type (sum of trips × shape length) ─
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

    // ── 6. Top routes ──────────────────────────────────────────
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
    res.json({
      available: true,
      totalRoutes: (routeCount.rows[0] as any).n,
      totalStops:  (stopCount.rows[0] as any).n,
      totalTrips:  (tripCount.rows[0] as any).n,
      weekdayTrips,
      saturdayTrips: satTrips,
      sundayTrips: sunTrips,
      weekdayKm,
      saturdayKm,
      sundayKm,
      topRoutes: topRoutes.rows,
      firstDeparture: hrs.first_dep,
      lastArrival: hrs.last_arr,
    });
  } catch (err) {
    req.log.error(err, "Error fetching GTFS summary");
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/gtfs/stats
router.get("/gtfs/stats", async (req, res) => {
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
// Comprehensive service quality analysis
router.get("/gtfs/analysis", async (req, res) => {
  try {
    const feedId = req.query["feedId"] as string | undefined;

    // Get all stops for this feed
    let stopsQuery = db.select().from(gtfsStops).$dynamic();
    if (feedId) stopsQuery = stopsQuery.where(eq(gtfsStops.feedId, feedId));
    const stops = await stopsQuery.limit(5000);

    // Get all routes for this feed
    let routesQuery = db.select().from(gtfsRoutes).$dynamic();
    if (feedId) routesQuery = routesQuery.where(eq(gtfsRoutes.feedId, feedId));
    const routes = await routesQuery.orderBy(sql`trips_count DESC`);

    // Get POIs
    const pois = await db.select().from(pointsOfInterest).limit(1000);
    // Get census sections
    const census = await db.select().from(censusSections);
    // Get traffic
    const trafficResult = await db.execute(sql`
      SELECT ROUND(lng::numeric, 2) as lng, ROUND(lat::numeric, 2) as lat, AVG(congestion_level) as avg_congestion
      FROM traffic_snapshots
      WHERE captured_at > NOW() - INTERVAL '7 days'
      GROUP BY ROUND(lng::numeric, 2), ROUND(lat::numeric, 2)
    `);
    const trafficPoints = (trafficResult.rows as any[]);

    if (stops.length === 0) {
      res.json({
        noData: true,
        message: "Nessun dato GTFS disponibile. Carica un feed prima.",
      });
      return;
    }

    // ── 1. Frequency distribution ──
    const withTimes = stops.filter(s => (s as any).daily_trips !== undefined ? (s as any).daily_trips > 0 : s.tripsCount > 0);
    const dailyTrips = stops.map(s => (s as any).daily_trips ?? s.tripsCount ?? 0);
    const avgDailyTrips = dailyTrips.reduce((a, b) => a + b, 0) / Math.max(dailyTrips.length, 1);
    const morningTrips = stops.map(s => (s as any).morning_peak_trips ?? 0);
    const eveningTrips = stops.map(s => (s as any).evening_peak_trips ?? 0);
    const avgMorning = morningTrips.reduce((a, b) => a + b, 0) / Math.max(morningTrips.length, 1);
    const avgEvening = eveningTrips.reduce((a, b) => a + b, 0) / Math.max(eveningTrips.length, 1);

    // Frequency buckets for histogram
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
      count: dailyTrips.filter(d => d >= b.min && d <= b.max).length,
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
    const POI_COVER_RADIUS_KM = 0.5; // 500m
    const coveredPois: typeof pois = [];
    const uncoveredPois: typeof pois = [];

    for (const poi of pois) {
      const hasStop = stops.some(s =>
        haversineKm(s.stopLat, s.stopLon, poi.lat, poi.lng) <= POI_COVER_RADIUS_KM
      );
      if (hasStop) coveredPois.push(poi);
      else uncoveredPois.push(poi);
    }

    // POI coverage by category
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
    const POP_COVER_RADIUS_KM = 0.8; // 800m walk to stop
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
    // For each traffic point, find nearest stop and its service score
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

    // High congestion + poor service = bad alignment
    const poorAlignmentZones = trafficAlignmentPoints.filter(
      t => t.congestion > 0.3 && t.nearestStopDist > 0.5
    );

    // ── 6. Worst served stops (high demand, low service) ──
    // Match stops with nearby census sections
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
        stopId: s.stopId,
        stopName: s.stopName,
        stopLat: s.stopLat,
        stopLon: s.stopLon,
        dailyTrips: daily,
        morningPeak: (s as any).morning_peak_trips ?? 0,
        eveningPeak: (s as any).evening_peak_trips ?? 0,
        serviceScore,
        nearbyPopulation: nearbyPop,
        nearbyPoiCount,
        demandScore: Math.round(demandScore * 10) / 10,
        gap: Math.max(0, demandScore - serviceScore / 10), // demand vs service gap
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
        totalStops: stops.length,
        totalRoutes: routes.length,
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
        totalPoi: pois.length,
        coveredPoi: coveredPois.length,
        uncoveredPoi: uncoveredPois.length,
        coveragePercent: Math.round(poiCoverageScore),
        byCategory: poiCoverageByCategory,
        uncoveredSample: uncoveredPois.slice(0, 10).map(p => ({
          name: p.name, category: p.category, lat: p.lat, lng: p.lng,
        })),
      },
      populationCoverage: {
        totalPopulation: totalPop,
        coveredPopulation: coveredPop,
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

// GET /api/gtfs/routes/active-by-band?hourStart=8&hourEnd=10&day=weekday&directionId=0
// Returns route_ids that have at least one trip departing in the given hour range
router.get("/gtfs/routes/active-by-band", async (req, res) => {
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

    // Map day param to DOW integers (0=Sunday, 1=Mon,...,6=Sat)
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

    res.json({ routeIds: result.rows.map(r => r.route_id), count: result.rows.length });
  } catch (err) {
    req.log.error(err, "Error fetching active routes by band");
    res.status(500).json({ error: "Internal server error" });
  }
});

// Italian urban traffic model: expected congestion by hour (0–26)
// Based on TomTom Traffic Index Italy / Marche urban patterns
const HOURLY_MODEL: Record<number, number> = {
   0: 0.05,  1: 0.04,  2: 0.03,  3: 0.03,  4: 0.05,  5: 0.09,
   6: 0.20,  7: 0.52,  8: 0.68,  9: 0.52, 10: 0.42, 11: 0.36,
  12: 0.40, 13: 0.44, 14: 0.34, 15: 0.32, 16: 0.42, 17: 0.60,
  18: 0.68, 19: 0.50, 20: 0.30, 21: 0.18, 22: 0.12, 23: 0.08,
  24: 0.06, 25: 0.05, 26: 0.04,
};

// Ancona city center
const ANCONA_CENTER = { lng: 13.516, lat: 43.616 };

/**
 * Estimate congestion for a geographic point at a given hour.
 * Combines the hourly model with a spatial factor (inner city = more congested)
 * and per-segment deterministic noise for visual realism.
 */
function modelCongestion(hour: number, lng: number, lat: number): number {
  const h = Math.max(0, Math.min(26, Math.round(hour)));
  const base = HOURLY_MODEL[h] ?? 0.05;

  // Distance from Ancona center in degrees (~1° ≈ 90km)
  const dist = Math.sqrt((lng - ANCONA_CENTER.lng) ** 2 + (lat - ANCONA_CENTER.lat) ** 2);

  // Zone factor: inner city 1.3x, peri-urban 1.0x, rural 0.55x
  const zoneFactor = dist < 0.04 ? 1.30
    : dist < 0.08 ? 1.10
    : dist < 0.16 ? 1.00
    : dist < 0.30 ? 0.75
    : 0.55;

  // Deterministic per-segment jitter (±12% of base) so adjacent segments differ visually
  const jitter = (Math.sin((lng * 23.7 + lat * 47.3) * 100) * 0.5 + 0.5) * 0.24 - 0.12;

  return Math.min(0.98, Math.max(0.02, base * zoneFactor + jitter * base));
}

// GET /api/gtfs/shapes/geojson — GeoJSON FeatureCollection with per-segment traffic congestion
// Query params: feedId, routeIds (comma-separated), segmented=true, directionId=0|1, hour=<0-26>
router.get("/gtfs/shapes/geojson", async (req, res) => {
  const feedId = req.query.feedId as string | undefined;
  const routeIds = req.query.routeIds
    ? (req.query.routeIds as string).split(",").map(s => s.trim()).filter(Boolean)
    : [];
  const segmented = req.query.segmented === "true";
  const directionIdParam = req.query.directionId !== undefined ? parseInt(req.query.directionId as string) : null;
  // hour param: midpoint of selected time range (used to choose model + filter real TomTom data)
  const hourParam = req.query.hour !== undefined ? parseFloat(req.query.hour as string) : null;

  try {
    const resolvedFeedId = feedId || await getLatestFeedId();

    // When routeIds are specified, filter in SQL to avoid losing data with LIMIT
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

    // Filter by direction_id if provided — lookup valid shape_ids via trips
    if (directionIdParam !== null && !isNaN(directionIdParam) && resolvedFeedId) {
      const validShapeRows = await db.execute<{ shape_id: string }>(sql`
        SELECT DISTINCT shape_id FROM gtfs_trips
        WHERE feed_id = ${resolvedFeedId} AND direction_id = ${directionIdParam} AND shape_id IS NOT NULL
      `);
      const validShapeIds = new Set(validShapeRows.rows.map(r => r.shape_id));
      rows = rows.filter(r => r.shapeId && validShapeIds.has(r.shapeId));
    }

    // Load TomTom snapshots with hour extracted from captured_at
    const rawTraffic = await db.execute<{
      lng: number; lat: number;
      congestion: number; speed: number; freeflow: number; hour: number;
    }>(sql`
      SELECT lng, lat, congestion_level AS congestion, speed, freeflow_speed AS freeflow,
             EXTRACT(HOUR FROM captured_at)::integer AS hour
      FROM traffic_snapshots
    `);

    const allTraffic = rawTraffic.rows;

    // Find which hours have real TomTom data
    const availableHours = [...new Set(allTraffic.map(t => t.hour).filter(h => h != null))] as number[];

    // Select the subset of TomTom data closest to requested hour (within ±2h)
    let relevantTraffic = allTraffic;
    if (hourParam !== null && availableHours.length > 0) {
      const closestHour = availableHours.reduce((best, h) =>
        Math.abs(h - hourParam) < Math.abs(best - hourParam) ? h : best, availableHours[0]);
      // Only use real TomTom data if it's within 2 hours of request; otherwise rely on model
      if (Math.abs(closestHour - hourParam) <= 2) {
        relevantTraffic = allTraffic.filter(t => t.hour === closestHour);
      } else {
        relevantTraffic = []; // too far from any real data → pure model
      }
    }

    function nearestRealCongestion(lng: number, lat: number): { congestion: number; speed: number; freeflow: number } | null {
      const RADIUS = 0.06; // ~6km
      const nearby = relevantTraffic.filter(t => Math.abs(t.lng - lng) < RADIUS && Math.abs(t.lat - lat) < RADIUS);
      if (!nearby.length) return null;
      const best = nearby.sort((a, b) => {
        const da = (a.lng - lng) ** 2 + (a.lat - lat) ** 2;
        const db2 = (b.lng - lng) ** 2 + (b.lat - lat) ** 2;
        return da - db2;
      })[0];
      return { congestion: best.congestion ?? 0, speed: best.speed ?? 0, freeflow: best.freeflowSpeed ?? 0 };
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
        // Split into segments of ~6 points with 1-point overlap for continuity
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
            // Real TomTom data available for this location and hour
            dataSource = "tomtom";
            congestion = Math.round(realData.congestion * 100) / 100;
            speed = realData.speed;
            freeflow = realData.freeflow;
            speedReduction = freeflow > 0 ? Math.round((1 - (speed ?? 0) / freeflow) * 100) : null;
          } else {
            // No real data — use hourly model with spatial variation
            const h = hourParam !== null ? hourParam : 12; // default midday if no hour given
            congestion = Math.round(modelCongestion(h, mid[0], mid[1]) * 100) / 100;
          }

          features.push({
            type: "Feature",
            geometry: { type: "LineString", coordinates: segCoords },
            properties: {
              ...routeProps,
              congestion,
              speedReduction,
              speed,
              freeflow,
              dataSource,
            },
          });
        }
      } else {
        // Default: one feature per shape, averaged congestion
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

// GET /api/gtfs/routes/impact — Routes with demand vs supply analysis
router.get("/gtfs/routes/impact", async (req, res) => {
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

    // Italian route name → province keywords → demand estimation
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

      // Find cities mentioned in route name
      const matchedCities = Object.entries(CITY_KEYWORDS).filter(([k]) => longName.includes(k));

      // Estimate demand: population near matched city centers
      let demandPop = 0, demandPoi = 0, trafficCongestion = 0, trafficSamples = 0;

      for (const [, center] of matchedCities) {
        const R = 0.06; // ~6km radius
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

      // Gap: positive = under-served (demand > supply), negative = over-served
      const gap = Math.round((demandScore - supplyScore) * 100);

      return {
        id: route.id,
        routeId: route.routeId,
        shortName,
        longName: route.routeLongName || "",
        color: route.routeColor || "#6b7280",
        textColor: route.routeTextColor || "#ffffff",
        tripsCount: trips,
        supplyScore: Math.round(supplyScore * 100),
        demandScore: Math.round(demandScore * 100),
        gap, // >0 = need more service, <0 = may have excess
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

// ──────────────────────────────────────────────────────────────
// GET /api/gtfs/routes/network-analysis
// Computes: route-pair overlap (shared stops), per-route headway stats,
// and a ranked route table. All computed in-process from GTFS tables.
// ──────────────────────────────────────────────────────────────
router.get("/gtfs/routes/network-analysis", async (req, res) => {
  const dayParam  = (req.query.day      as string) || "";
  const dateFrom  = (req.query.dateFrom as string) || ""; // YYYYMMDD
  const dateTo    = (req.query.dateTo   as string) || ""; // YYYYMMDD

  try {
    // ── 1. Route metadata ──────────────────────────────────────
    const routes = await db.select({
      routeId: gtfsRoutes.routeId,
      shortName: gtfsRoutes.routeShortName,
      longName: gtfsRoutes.routeLongName,
      color: gtfsRoutes.routeColor,
      textColor: gtfsRoutes.routeTextColor,
      tripsCount: gtfsRoutes.tripsCount,
    }).from(gtfsRoutes).orderBy(sql`trips_count DESC`).limit(200);

    // ── 2. Route → distinct stops ──────────────────────────────
    const routeStopRows = await db.execute(sql`
      SELECT DISTINCT t.route_id, st.stop_id, s.stop_name
      FROM gtfs_trips t
      JOIN gtfs_stop_times st ON st.trip_id = t.trip_id
      JOIN gtfs_stops s ON s.stop_id = st.stop_id
      ORDER BY t.route_id
    `);

    // Build Map<routeId, {stopIds: Set, stopNames: Map<stopId, name>}>
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

    // ── 3. Pairwise overlap (stop membership — day-agnostic) ────
    interface InternalPair {
      routeA: string; routeB: string;
      sharedStops: number; stopsA: number; stopsB: number;
      jaccardPct: number; minCoveragePct: number;
      sharedSample: string[];
      _sharedStopIds: string[]; // full list for collision analysis
      _stopNames: Map<string, string>; // stopId -> name
      collisionCount: number;
      collisionDetails: { stopName: string; times: string[] }[];
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
          _sharedStopIds: shared,
          _stopNames: mergedNames,
          collisionCount: 0, collisionDetails: [],
        });
      }
    }
    pairs.sort((a, b) => b.minCoveragePct - a.minCoveragePct);
    const topPairs = pairs.slice(0, 60);

    // ── 4. Service IDs for day + date-range filter ────────────
    let serviceIdSet: Set<string> | null = null;
    if (dayParam || dateFrom || dateTo) {
      let conditions = "1=1";
      if (dayParam) {
        if (dayParam === "weekday")       conditions += " AND EXTRACT(DOW FROM to_date(date::text,'YYYYMMDD')) IN (1,2,3,4,5)";
        else if (dayParam === "saturday") conditions += " AND EXTRACT(DOW FROM to_date(date::text,'YYYYMMDD')) = 6";
        else                              conditions += " AND EXTRACT(DOW FROM to_date(date::text,'YYYYMMDD')) = 0";
      }
      if (dateFrom) conditions += ` AND date >= '${dateFrom}'`;
      if (dateTo)   conditions += ` AND date <= '${dateTo}'`;
      const cdRows = await db.execute(sql`
        SELECT DISTINCT service_id FROM gtfs_calendar_dates
        WHERE ${sql.raw(conditions)}
      `);
      serviceIdSet = new Set((cdRows.rows as any[]).map(r => String(r.service_id)));
    }

    // ── 5. Schedule collisions at shared stops ─────────────────
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

      // Build Map<stopId, Map<routeId, number[]>> (minutes since midnight)
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

      // Compute collisions per pair (±2 minutes at same stop)
      const DELTA = 2;
      for (const pair of topPairs) {
        let count = 0;
        for (let k = 0; k < pair._sharedStopIds.length; k++) {
          const stopId = pair._sharedStopIds[k];
          const smap = stopRouteTimes.get(stopId);
          if (!smap) continue;
          const timesA = smap.get(pair.routeA) ?? [];
          const timesB = smap.get(pair.routeB) ?? [];
          if (!timesA.length || !timesB.length) continue;
          const stopHits: string[] = [];
          for (const ta of timesA) {
            for (const tb of timesB) {
              if (Math.abs(ta - tb) <= DELTA) {
                count++;
                const t = Math.min(ta, tb);
                const ts = `${Math.floor(t / 60).toString().padStart(2, "0")}:${(t % 60).toString().padStart(2, "0")}`;
                stopHits.push(ts);
              }
            }
          }
          if (stopHits.length > 0 && pair.collisionDetails.length < 6) {
            pair.collisionDetails.push({
              stopName: pair._stopNames.get(stopId) ?? stopId,
              times: [...new Set(stopHits)].slice(0, 4),
            });
          }
        }
        pair.collisionCount = count;
      }
      // Re-sort by collision count descending
      topPairs.sort((a, b) => b.collisionCount - a.collisionCount);
    }

    // ── 6. Per-route headway (filtered by day + hour) ──────────
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

    // Named time bands for headway analysis
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
        avgHeadwayMin: Math.round(avg),
        maxHeadwayMin: Math.round(max),
        minHeadwayMin: Math.round(min),
        worstGapHour, bands,
      });
    }
    headwayStats.sort((a, b) => b.maxHeadwayMin - a.maxHeadwayMin);

    // ── 7. Route ranking ───────────────────────────────────────
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

    // ── 8. Summary KPIs ───────────────────────────────────────
    const pairsWithCollisions = topPairs.filter(p => p.collisionCount > 0);
    const totalCollisions = pairsWithCollisions.reduce((s, p) => s + p.collisionCount, 0);
    const worstHeadway = headwayStats[0]?.maxHeadwayMin ?? 0;
    const irregularRoutes = headwayStats.filter(h =>
      h.bands.some(b => b.avgMin > 60) && h.bands.some(b => b.avgMin > 0 && b.avgMin < 20)
    ).length;

    // Strip internal fields from response
    const cleanPairs = topPairs.map(({ _sharedStopIds, _stopNames, ...rest }) => rest);

    res.json({
      kpis: {
        scheduleCollisions: totalCollisions,
        routePairsWithCollisions: pairsWithCollisions.length,
        worstHeadway,
        irregularRoutes,
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

// ──────────────────────────────────────────────────────────────
// GET /api/gtfs/travel-time
// Computes per-route travel time vs traffic congestion by time band.
// Returns scheduled (free-flow) time + estimated actual time per slot.
// ──────────────────────────────────────────────────────────────

// Empirical Italian urban speed factors per time band
// These are applied to the ACTUAL TomTom snapshot speed (not the congestion %).
// Factors are calibrated on ANAV/ISFORT Italian bus punctuality studies.
// 1.0 = same as current snapshot; >1 = less traffic; <1 = more traffic.
const TIME_BANDS = [
  { id: "00-06", label: "Notte (0–6h)",          speedFactor: 1.45 },
  { id: "07-09", label: "Picco mattino (7–9h)",   speedFactor: 0.68 },
  { id: "09-12", label: "Mattina (9–12h)",        speedFactor: 1.10 },
  { id: "12-15", label: "Pranzo (12–15h)",        speedFactor: 1.02 },
  { id: "15-19", label: "Picco sera (15–19h)",    speedFactor: 0.76 },
  { id: "19-22", label: "Sera (19–22h)",          speedFactor: 1.18 },
  { id: "22-24", label: "Tarda sera (22–24h)",    speedFactor: 1.42 },
] as const;

const DEFAULT_SPEED_KMH = 40; // fallback urban speed when no TomTom nearby

router.get("/gtfs/travel-time", async (req, res) => {
  const filterRouteId = req.query.routeId as string | undefined;
  try {
    // Load shapes with route info
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

    // Load TomTom traffic snapshots once
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

    // Group shapes by routeId — pick the longest shape per route
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

      // Compute per-segment distance and congestion
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

        // Peak morning delay on this segment (for slowest-segments identification)
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

      // Time slots — apply speedFactor to the ACTUAL TomTom speed
      // Cap: speed cannot exceed freeflow, minimum 5 km/h
      const timeslots = TIME_BANDS.map(band => {
        const effectiveSpeed = Math.max(5, Math.min(avgFreeflow, avgActualSpeed * band.speedFactor));
        const estimatedMinutes = (totalDistanceKm / effectiveSpeed) * 60;
        const delayMinutes = estimatedMinutes - freeFlowMinutes;
        const congestionPct = Math.round((1 - effectiveSpeed / avgFreeflow) * 100);
        return {
          id: band.id,
          label: band.label,
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
// Helper: get latest feed id
// ──────────────────────────────────────────────────────────────
async function getLatestFeedId(): Promise<string | null> {
  const rows = await db.select({ id: gtfsFeeds.id }).from(gtfsFeeds).orderBy(sql`uploaded_at DESC`).limit(1);
  return rows[0]?.id ?? null;
}

// Classify a service_id by its Italian name semantics
function classifyServiceByName(serviceId: string): { weekday: boolean; saturday: boolean; sunday: boolean } {
  const id = serviceId.toLowerCase().trim();
  // "tutti" / "all" → every day
  if (id === "tutti" || id === "all" || id === "everyday" || id === "feriale+festivo") {
    return { weekday: true, saturday: true, sunday: true };
  }
  // Saturday patterns
  if (id === "sabato" || id.startsWith("sab") || id.includes("saturday")) {
    return { weekday: false, saturday: true, sunday: false };
  }
  // Sunday/holiday patterns
  if (id === "festivo" || id === "domenica" || id.startsWith("fest") || id.includes("sunday") || id.includes("domenica")) {
    return { weekday: false, saturday: false, sunday: true };
  }
  // Weekday patterns: feriale, lun-ven, lun_ven, feriali, weekday
  if (id.includes("feriale") || id.includes("feriali") || id.includes("lun") || id.includes("weekday") || id.includes("ven")) {
    return { weekday: true, saturday: false, sunday: false };
  }
  // Unknown names: default to all days
  return { weekday: true, saturday: true, sunday: true };
}

// Helper: classify service_id by day type from gtfs_calendar
// Returns: map from serviceId → {weekday, saturday, sunday} booleans
async function buildServiceDayMap(feedId: string): Promise<Record<string, { weekday: boolean; saturday: boolean; sunday: boolean }>> {
  const cal = await db.select().from(gtfsCalendar).where(eq(gtfsCalendar.feedId, feedId));
  const map: Record<string, { weekday: boolean; saturday: boolean; sunday: boolean }> = {};
  for (const c of cal) {
    map[c.serviceId] = {
      weekday: (c.monday + c.tuesday + c.wednesday + c.thursday + c.friday) >= 1,
      saturday: c.saturday === 1,
      sunday: c.sunday === 1,
    };
  }
  // If no calendar.txt, use actual dates from calendar_dates to infer DOW
  if (cal.length === 0) {
    // Count weekday/saturday/sunday occurrences per service_id from real dates
    const dowRows = await db.execute<{
      service_id: string;
      weekdays: string;
      saturdays: string;
      sundays: string;
    }>(sql`
      SELECT
        service_id,
        SUM(CASE WHEN EXTRACT(DOW FROM TO_DATE(date, 'YYYYMMDD')) IN (1,2,3,4,5) THEN 1 ELSE 0 END)::int AS weekdays,
        SUM(CASE WHEN EXTRACT(DOW FROM TO_DATE(date, 'YYYYMMDD')) = 6 THEN 1 ELSE 0 END)::int AS saturdays,
        SUM(CASE WHEN EXTRACT(DOW FROM TO_DATE(date, 'YYYYMMDD')) = 0 THEN 1 ELSE 0 END)::int AS sundays
      FROM gtfs_calendar_dates
      WHERE feed_id = ${feedId} AND exception_type = '1'
      GROUP BY service_id
    `);
    for (const row of dowRows.rows) {
      map[row.service_id] = {
        weekday:  parseInt(row.weekdays)  > 0,
        saturday: parseInt(row.saturdays) > 0,
        sunday:   parseInt(row.sundays)   > 0,
      };
    }
    // Fallback: service_ids only in trips not in calendar_dates → classify by name
    const tripSvcs = await db.execute<{ service_id: string }>(sql`
      SELECT DISTINCT service_id FROM gtfs_trips WHERE feed_id = ${feedId}
    `);
    for (const { service_id } of tripSvcs.rows) {
      if (!map[service_id]) map[service_id] = classifyServiceByName(service_id);
    }
  }
  return map;
}

// ──────────────────────────────────────────────────────────────
// GET /api/gtfs/trips/list?routeId=Q&day=weekday|saturday|sunday
// Returns list of trips for a route on the given day type.
// ──────────────────────────────────────────────────────────────
router.get("/gtfs/trips/list", async (req, res) => {
  const routeId = req.query.routeId as string | undefined;
  const day = ((req.query.day as string) || "weekday").toLowerCase();

  if (!routeId) return res.status(400).json({ error: "routeId required" });

  try {
    const feedId = await getLatestFeedId();
    if (!feedId) return res.json({ data: [], feedId: null, error: "Nessun feed GTFS caricato" });

    // Check if trip data is available
    const tripCount = await db.select({ count: sql<number>`count(*)::int` }).from(gtfsTrips).where(eq(gtfsTrips.feedId, feedId));
    if ((tripCount[0]?.count ?? 0) === 0) {
      return res.json({ data: [], feedId, error: "Dati corse non disponibili — reimporta il feed GTFS" });
    }

    const serviceMap = await buildServiceDayMap(feedId);

    // Get trips for route
    const trips = await db.select().from(gtfsTrips)
      .where(sql`feed_id = ${feedId} AND route_id = ${routeId}`)
      .orderBy(gtfsTrips.tripId)
      .limit(2000);

    // Filter by day type
    const dayFilteredTrips = trips.filter(t => {
      const svc = serviceMap[t.serviceId];
      if (!svc) return day === "weekday"; // unknown service → assume weekday
      if (day === "weekday") return svc.weekday;
      if (day === "saturday") return svc.saturday;
      if (day === "sunday") return svc.sunday;
      return true;
    });

    // Single JOIN query: trips + first stop_time + stop name — no array passing needed
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

    // Filter by day type using already-loaded serviceMap
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

    res.json({ data: result, feedId, total: result.length });
  } catch (err) {
    req.log.error(err, "Error listing trips");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ──────────────────────────────────────────────────────────────
// GET /api/traffic/availability
// Returns available traffic data: date range, day types, hours
// ──────────────────────────────────────────────────────────────
router.get("/traffic/availability", async (_req, res) => {
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

    res.json({
      available: true,
      totalSnapshots: rows.reduce((s, r) => s + r.count, 0),
      dateRange: { from: dates[0], to: dates[dates.length - 1] },
      dates,
      dayTypes,
      hours,
      byDate,
    });
  } catch (err) {
    req.log?.error(err, "Error fetching traffic availability");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ──────────────────────────────────────────────────────────────
// GET /api/gtfs/trips/visual?tripId=XYZ&dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD&dayTypes=weekday,saturday,sunday
// Returns the route diagram data for a single trip:
// ordered stops with times, inter-stop distances, TomTom speed comparison.
// Traffic is matched by the segment's departure HOUR and filtered by date/day-type context.
// ──────────────────────────────────────────────────────────────
router.get("/gtfs/trips/visual", async (req, res) => {
  const tripId = req.query.tripId as string | undefined;
  if (!tripId) return res.status(400).json({ error: "tripId required" });

  // Traffic context filters
  const dateFrom = req.query.dateFrom as string | undefined;
  const dateTo = req.query.dateTo as string | undefined;
  const dayTypesParam = req.query.dayTypes as string | undefined;
  const dayTypes = dayTypesParam ? dayTypesParam.split(",").map(s => s.trim()) : ["weekday", "saturday", "sunday"];

  // Map dayType names to Postgres DOW integers (0=Sun, 1-5=Mon-Fri, 6=Sat)
  const dowInts: number[] = [];
  if (dayTypes.includes("weekday")) dowInts.push(1, 2, 3, 4, 5);
  if (dayTypes.includes("saturday")) dowInts.push(6);
  if (dayTypes.includes("sunday")) dowInts.push(0);

  try {
    const feedId = await getLatestFeedId();
    if (!feedId) return res.json({ error: "Nessun feed GTFS", stops: [], segments: [] });

    // Single JOIN: stop_times + stop details — no array passing needed
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

    // Get trip/route info
    const tripRow = await db.select().from(gtfsTrips).where(sql`feed_id = ${feedId} AND trip_id = ${tripId}`).limit(1);
    const trip = tripRow[0];
    let routeColor = "#6b7280";
    if (trip?.routeId) {
      const routeRow = await db.select({ routeColor: gtfsRoutes.routeColor }).from(gtfsRoutes)
        .where(sql`feed_id = ${feedId} AND route_id = ${trip.routeId}`).limit(1);
      routeColor = routeRow[0]?.routeColor ?? "#6b7280";
    }

    // Build traffic filter conditions
    let trafficWhere = sql`1=1`;
    if (dateFrom) trafficWhere = sql`${trafficWhere} AND captured_at >= ${dateFrom}::timestamptz`;
    if (dateTo) trafficWhere = sql`${trafficWhere} AND captured_at < (${dateTo}::date + interval '1 day')`;
    if (dowInts.length < 7) {
      trafficWhere = sql`${trafficWhere} AND EXTRACT(DOW FROM captured_at) = ANY(ARRAY[${sql.raw(dowInts.join(","))}])`;
    }

    // Load TomTom snapshots grouped by hour — for hour-accurate matching
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

    // Index by hour for fast lookup
    const trafficByHour: Record<number, typeof trafficRaw.rows> = {};
    for (const row of trafficRaw.rows) {
      const h = row.hour;
      if (!trafficByHour[h]) trafficByHour[h] = [];
      trafficByHour[h].push(row);
    }
    // Also build an "all hours" fallback pool
    const allTraffic = trafficRaw.rows;

    // Find the nearest TomTom point at a given hour (falls back to closest hour, then any)
    function nearestTomTomAtHour(lng: number, lat: number, hour: number) {
      const R = 0.08;
      // 1. Try exact hour
      let pool = (trafficByHour[hour] ?? []).filter(t => Math.abs(t.lng - lng) < R && Math.abs(t.lat - lat) < R);
      // 2. Try adjacent hours (±1, ±2)
      if (!pool.length) {
        for (const dh of [1, -1, 2, -2, 3, -3]) {
          pool = (trafficByHour[hour + dh] ?? []).filter(t => Math.abs(t.lng - lng) < R && Math.abs(t.lat - lat) < R);
          if (pool.length) break;
        }
      }
      // 3. Fall back to any hour in the filtered dataset
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

    // Build ordered stops (data now directly from JOIN)
    const orderedStops = stSeq.map(st => ({
      stopId: st.stop_id,
      stopName: st.stop_name ?? st.stop_id,
      lat: typeof st.stop_lat === "string" ? parseFloat(st.stop_lat) : (st.stop_lat ?? 0),
      lon: typeof st.stop_lon === "string" ? parseFloat(st.stop_lon) : (st.stop_lon ?? 0),
      seq: st.stop_sequence,
      departureTime: st.departure_time,
      arrivalTime: st.arrival_time,
    })).filter(s => s.lat !== 0 && s.lon !== 0);

    // Build segments between consecutive stops
    let totalDistKm = 0;
    let totalScheduledMin = 0;
    const segments: any[] = [];

    for (let i = 0; i < orderedStops.length - 1; i++) {
      const from = orderedStops[i];
      const to = orderedStops[i + 1];
      if (!from.departureTime || !to.departureTime) continue;

      const dist = haversineKm(from.lat, from.lon, to.lat, to.lon);
      if (dist < 0.001) continue;

      // Scheduled time in minutes
      const fromMin = timeToMinutes(from.departureTime);
      const toMin = timeToMinutes(to.departureTime);
      const scheduledMin = Math.max(0.1, toMin - fromMin);

      totalDistKm += dist;
      totalScheduledMin += scheduledMin;

      // Scheduled speed
      const scheduledSpeedKmh = (dist / scheduledMin) * 60;

      // TomTom at midpoint — matched by segment departure hour for accuracy
      const midLat = (from.lat + to.lat) / 2;
      const midLon = (from.lon + to.lon) / 2;
      const segHour = Math.floor(fromMin / 60) % 24; // normalise 25h → 1h etc.
      const tt = nearestTomTomAtHour(midLon, midLat, segHour);
      const hasTomTom = tt !== null;
      const freeflowKmh = hasTomTom && (tt.avg_freeflow ?? 0) > 5 ? tt.avg_freeflow : (hasTrafficData ? avgFreeflow : null);
      const currentSpeedKmh = hasTomTom && (tt.avg_speed ?? 0) > 0 ? tt.avg_speed : null;

      // Delay: how much slower than freeflow is the schedule?
      const delayPct = freeflowKmh ? Math.max(0, Math.min(1, 1 - scheduledSpeedKmh / freeflowKmh)) : null;

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
        hasTomTom,
        segHour,
        tomTomSamples: tt?.count ?? 0,
      });
    }

    // Build traffic context summary for the UI
    const matchedHours = [...new Set(segments.map(s => s.segHour))];
    const trafficContext = {
      hasData: hasTrafficData,
      totalSamples: allTraffic.reduce((s, t) => s + t.count, 0),
      dateFrom: dateFrom ?? null,
      dateTo: dateTo ?? null,
      dayTypes,
      matchedHours,
      segmentsWithTomTom: segments.filter(s => s.hasTomTom).length,
      segmentsWithoutTomTom: segments.filter(s => !s.hasTomTom).length,
    };

    res.json({
      tripId,
      routeId: trip?.routeId ?? "",
      routeColor,
      tripHeadsign: trip?.tripHeadsign ?? null,
      directionId: trip?.directionId ?? 0,
      stops: orderedStops,
      trafficContext,
      segments,
      totalDistanceKm: Math.round(totalDistKm * 10) / 10,
      totalScheduledMin: Math.round(totalScheduledMin * 10) / 10,
    });
  } catch (err) {
    req.log.error(err, "Error building trip visual");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ──────────────────────────────────────────────────────────────
// GET /api/gtfs/trips/schedule?routeId=X&day=Y&directionId=Z
// Returns ALL trips for a route with their complete stop sequences and timing.
// Used by the travel-time mini-diagram view.
// ──────────────────────────────────────────────────────────────
router.get("/gtfs/trips/schedule", async (req, res) => {
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

    // Get route color
    const routeRow = await db.select({ routeColor: gtfsRoutes.routeColor, routeShortName: gtfsRoutes.routeShortName })
      .from(gtfsRoutes).where(sql`feed_id = ${feedId} AND route_id = ${routeId}`).limit(1);
    const routeColor = routeRow[0]?.routeColor ?? "#6b7280";
    const routeShortName = routeRow[0]?.routeShortName ?? routeId;

    // Single query: all trips for route with all their stops
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

    // Group rows by trip_id
    const tripMap: Record<string, { serviceId: string; headsign: string | null; direction: number; stops: typeof rows.rows }> = {};
    for (const r of rows.rows) {
      if (!tripMap[r.trip_id]) {
        tripMap[r.trip_id] = { serviceId: r.service_id, headsign: r.trip_headsign, direction: r.direction_id, stops: [] };
      }
      tripMap[r.trip_id].stops.push(r);
    }

    // Build trip objects, filter by day + direction
    const trips = Object.entries(tripMap).map(([tripId, info]) => {
      const stops = info.stops;
      if (stops.length === 0) return null;

      const first = stops[0];
      const last = stops[stops.length - 1];
      const firstMin = timeToMinutes(first.departure_time || "0:0");
      const lastMin = timeToMinutes(last.departure_time || "0:0");
      const totalMin = Math.max(0, lastMin - firstMin);

      // Build stops with cumulative time from first stop
      const stopsOut = stops.map((s, i) => {
        const depMin = timeToMinutes(s.departure_time || "0:0");
        const lat = typeof s.stop_lat === "string" ? parseFloat(s.stop_lat) : (s.stop_lat ?? 0);
        const lon = typeof s.stop_lon === "string" ? parseFloat(s.stop_lon) : (s.stop_lon ?? 0);
        const prevLat = i > 0 ? (typeof stops[i-1].stop_lat === "string" ? parseFloat(stops[i-1].stop_lat as string) : (stops[i-1].stop_lat ?? 0)) : lat;
        const prevLon = i > 0 ? (typeof stops[i-1].stop_lon === "string" ? parseFloat(stops[i-1].stop_lon as string) : (stops[i-1].stop_lon ?? 0)) : lon;
        const distKm = i > 0 ? Math.round(haversineKm(prevLat, prevLon, lat, lon) * 100) / 100 : 0;
        return {
          stopName: s.stop_name ?? `Fermata ${i + 1}`,
          departureTime: s.departure_time,
          minsFromFirst: depMin - firstMin,
          minsFromPrev: i > 0 ? depMin - timeToMinutes(stops[i-1].departure_time || "0:0") : 0,
          distFromPrevKm: distKm,
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
      };
    }).filter((t): t is NonNullable<typeof t> => {
      if (!t) return false;
      // Filter by day
      const svc = serviceMap[t.serviceId];
      const dayOk = svc ? (
        day === "weekday" ? svc.weekday :
        day === "saturday" ? svc.saturday :
        day === "sunday" ? svc.sunday : true
      ) : day === "weekday";
      if (!dayOk) return false;
      // Filter by direction
      if (directionIdParam !== null && !isNaN(directionIdParam) && t.directionId !== directionIdParam) return false;
      return !!t.firstDeparture;
    }).sort((a, b) => {
      const toMin = (s: string) => { const [h, m] = (s || "0:0").split(":").map(Number); return h * 60 + m; };
      return toMin(a.firstDeparture) - toMin(b.firstDeparture);
    });

    res.json({ trips, routeColor, routeShortName, total: trips.length, feedId });
  } catch (err) {
    req.log.error(err, "Error fetching trip schedule");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ──────────────────────────────────────────────────────────────
// GET /api/gtfs/travel-time/route-segments?routeId=11&day=weekday|saturday|sunday
// Per-route stop-to-stop travel time analysis with day-of-week factor.
// Projects GTFS stops onto route shape, computes delay per segment per time band.
// ──────────────────────────────────────────────────────────────

// Day-of-week congestion multipliers (applied to the snapshot congestion ratio)
const DAY_CONGESTION_MULT: Record<string, number> = {
  weekday: 1.00,  // baseline — snapshot is from a weekday
  saturday: 0.58, // schools closed, less commuters
  sunday: 0.28,   // minimal traffic
};

function nearestShapeIdx(stopLat: number, stopLon: number, coords: [number, number][]): { idx: number; distKm: number } {
  let minSq = Infinity;
  let bestIdx = 0;
  for (let i = 0; i < coords.length; i++) {
    const [lng, lat] = coords[i];
    const dSq = (lat - stopLat) ** 2 + (lng - stopLon) ** 2;
    if (dSq < minSq) { minSq = dSq; bestIdx = i; }
  }
  return { idx: bestIdx, distKm: Math.sqrt(minSq) * 111 };
}

function shapeSegmentDist(coords: [number, number][], fromIdx: number, toIdx: number): number {
  let d = 0;
  const start = Math.min(fromIdx, toIdx);
  const end = Math.max(fromIdx, toIdx);
  for (let i = start; i < end; i++) {
    const [lng1, lat1] = coords[i];
    const [lng2, lat2] = coords[i + 1];
    d += haversineKm(lat1, lng1, lat2, lng2);
  }
  return d;
}

router.get("/gtfs/travel-time/route-segments", async (req, res) => {
  const routeId = req.query.routeId as string | undefined;
  const day = ((req.query.day as string) || "weekday").toLowerCase();

  if (!routeId) return res.status(400).json({ error: "routeId required" });

  const dayMult = DAY_CONGESTION_MULT[day] ?? 1.0;

  try {
    // Get all shapes for the route — pick the one with most coordinates
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

    // Load TomTom data
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

    // Load all GTFS stops
    const allStops = await db.select({
      stopId: gtfsStops.stopId, stopName: gtfsStops.stopName,
      stopLat: gtfsStops.stopLat, stopLon: gtfsStops.stopLon,
      tripsCount: gtfsStops.tripsCount,
    }).from(gtfsStops).limit(3000);

    // Compute shape bounding box + buffer for pre-filtering
    const lngs = coords.map(c => c[0]);
    const lats = coords.map(c => c[1]);
    const BBOX_BUFFER = 0.03;
    const minLng = Math.min(...lngs) - BBOX_BUFFER;
    const maxLng = Math.max(...lngs) + BBOX_BUFFER;
    const minLat = Math.min(...lats) - BBOX_BUFFER;
    const maxLat = Math.max(...lats) + BBOX_BUFFER;

    const MAX_STOP_DIST_KM = 0.15; // 150m max from shape

    // Project stops onto shape, keep those close enough
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

    // Sort by position along shape, deduplicate stops at same position
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

    // Build segments between consecutive stops
    const segments: any[] = [];
    let totalDistKm = 0;

    for (let i = 0; i < deduped.length - 1; i++) {
      const from = deduped[i];
      const to = deduped[i + 1];
      if (to.shapeIdx <= from.shapeIdx) continue;

      const dist = shapeSegmentDist(coords, from.shapeIdx, to.shapeIdx);
      if (dist < 0.01) continue; // skip negligible segments

      totalDistKm += dist;

      // Sample midpoint for traffic
      const midIdx = Math.round((from.shapeIdx + to.shapeIdx) / 2);
      const [midLng, midLat] = coords[Math.min(midIdx, coords.length - 1)];
      const t = nearestTraffic(midLng, midLat);

      const freeflow = (t?.freeflow ?? 0) > 5 ? t!.freeflow! : gAvgFreeflow;
      const rawActual = (t?.speed ?? 0) > 5 ? t!.speed! : freeflow * (1 - gAvgCongestion);

      // Apply day multiplier to congestion
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

    res.json({
      routeId, routeShortName, routeColor, day,
      totalDistanceKm: Math.round(totalDistKm * 10) / 10,
      stops: deduped.map(s => ({ stopId: s.stopId, stopName: s.stopName, lat: s.stopLat, lon: s.stopLon })),
      segments,
    });
  } catch (err) {
    req.log.error(err, "Error computing route segments");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ──────────────────────────────────────────────────────────────
// GET /api/gtfs/stops/directory
// Returns GTFS stops with their serving routes, searchable + paginated.
// ──────────────────────────────────────────────────────────────
router.get("/gtfs/stops/directory", async (req, res) => {
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

    // Total count (approximate)
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
// Returns departures by route for a specific stop.
// ──────────────────────────────────────────────────────────────
router.get("/gtfs/stops/:stopId/detail", async (req, res) => {
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

    // Group departures by route
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

