/**
 * GTFS Upload & Feed CRUD endpoints.
 * POST /api/gtfs/upload
 * GET  /api/gtfs/feeds
 * DELETE /api/gtfs/feeds/:id
 */
import { Router, type IRouter } from "express";
import multer from "multer";
import AdmZip from "adm-zip";
import { db } from "@workspace/db";
import {
  gtfsFeeds, gtfsStops, gtfsRoutes, gtfsShapes,
  gtfsTrips, gtfsStopTimes, gtfsCalendar, gtfsCalendarDates,
} from "@workspace/db/schema";
import { eq, sql } from "drizzle-orm";
import { timeToMinutes } from "../lib/geo-utils";
import { parseCsv, buildShapeGeojson } from "./gtfs-helpers";
import { clearCache } from "../middlewares/cache";

const router: IRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 150 * 1024 * 1024 } });

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

    req.log.info({ entries: entries.length }, "GTFS zip extracted");

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

    req.log.info({
      feedId: feed.id,
      stops: stopsRaw.length, routes: routesRaw.length,
      trips: tripsRaw.length, shapes: shapePairs.length,
      stopTimes: stopTimesRaw.length,
    }, "GTFS feed created, starting inserts");

    // Insert stops with service stats
    const stopsToInsert = stopsRaw
      .filter(s => s["stop_lat"] && s["stop_lon"])
      .map(s => {
        const sid = s["stop_id"] || "";
        const daily = stopDailyTrips[sid] || 0;
        const morning = stopMorningPeak[sid] || 0;
        const evening = stopEveningPeak[sid] || 0;
        const freqScore = Math.min(daily / Math.max(maxDaily * 0.3, 1), 1) * 50;
        const mornScore = Math.min(morning / 6, 1) * 25;
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
    req.log.info({ count: stopsToInsert.length }, "GTFS stops inserted");

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
    req.log.info({ count: routesToInsert.length }, "GTFS routes inserted");

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
    req.log.info({ count: shapePairs.length }, "GTFS shapes inserted");

    // Insert calendar
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

    // Insert calendar_dates
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
    req.log.info({ count: tripsRaw.length }, "GTFS trips inserted");

    // Insert stop_times
    if (stopTimesRaw.length > 0) {
      const stRows = stopTimesRaw.map(st => ({
        feedId: feed.id,
        tripId: st["trip_id"] || "",
        stopId: st["stop_id"] || "",
        stopSequence: parseInt(st["stop_sequence"] || "0") || 0,
        departureTime: st["departure_time"] || st["arrival_time"] || null,
        arrivalTime: st["arrival_time"] || null,
      })).filter(st => st.tripId && st.stopId);
      for (let i = 0; i < stRows.length; i += 3000) {
        await db.insert(gtfsStopTimes).values(stRows.slice(i, i + 3000));
      }
    }
    req.log.info({ count: stopTimesRaw.length }, "GTFS stop_times inserted");

    // Invalidate all cached GTFS data
    clearCache("/api/gtfs/");
    clearCache("/api/analysis/");
    clearCache("/api/traffic/");

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
    clearCache("/api/gtfs/");
    clearCache("/api/analysis/");
    res.json({ success: true });
  } catch (err) {
    req.log.error(err, "Error deleting GTFS feed");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
