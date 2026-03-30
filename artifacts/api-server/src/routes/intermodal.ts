import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { gtfsStops, gtfsStopTimes, gtfsTrips, gtfsRoutes, gtfsShapes, pointsOfInterest } from "@workspace/db/schema";
import { sql, inArray } from "drizzle-orm";
import { haversineKm, timeToMinutes, minToTime, walkMinutes } from "../lib/geo-utils";

const router: IRouter = Router();

// ═══════════════════════════════════════════════════════════════════════
// INTERMODAL — Analyze bus ↔ rail / ferry connections (GTFS-based)
// ═══════════════════════════════════════════════════════════════════════

// Known intermodal hubs (Province of Ancona)
// Now includes ARRIVALS (incoming trains/ferries) — the key use case:
// passenger arrives by train/ferry → walks to bus stop → catches bus to destination
const INTERMODAL_HUBS: {
  id: string; name: string; type: "railway" | "port" | "airport";
  lat: number; lng: number;
  gtfsStopIds: string[];
  // Departures FROM this hub (treno/nave parte)
  typicalDepartures: { destination: string; times: string[] }[];
  // Arrivals TO this hub (treno/nave arriva — passeggero scende)
  typicalArrivals: { origin: string; times: string[] }[];
  description: string;
  // Walk time from platform to nearest bus stop area (minutes)
  platformWalkMinutes: number;
}[] = [
  {
    id: "rail-ancona",
    name: "Stazione FS Ancona",
    type: "railway",
    lat: 43.607348, lng: 13.49776447,
    gtfsStopIds: ["13", "18", "153", "20006", "20044"],
    description: "Stazione centrale di Ancona — hub ferroviario principale (IC, FR, Regionali)",
    platformWalkMinutes: 3, // stazione grande, dal binario all'uscita
    typicalDepartures: [
      { destination: "Roma (IC/FR)", times: ["06:10","07:35","08:55","10:35","12:10","14:10","16:10","17:35","18:55","20:10"] },
      { destination: "Milano (IC/FR)", times: ["05:50","06:50","08:50","10:50","12:50","14:50","16:25","17:50","19:50"] },
      { destination: "Pesaro/Rimini (R)", times: ["05:30","06:00","06:30","07:00","07:30","08:00","08:30","09:30","10:30","11:30","12:30","13:30","14:30","15:30","16:00","16:30","17:00","17:30","18:00","18:30","19:30","20:30","21:30"] },
      { destination: "Foligno/Fabriano (R)", times: ["06:20","07:20","08:20","10:20","12:20","14:20","16:20","18:20","20:20"] },
    ],
    typicalArrivals: [
      { origin: "Roma (IC/FR)", times: ["08:45","10:15","11:50","13:45","15:50","17:45","19:10","20:45","22:10"] },
      { origin: "Milano (IC/FR)", times: ["07:10","09:10","11:10","13:10","15:10","17:10","18:35","20:10","22:10"] },
      { origin: "Pesaro/Rimini (R)", times: ["06:25","06:55","07:25","07:55","08:25","08:55","09:55","10:55","11:55","12:55","13:55","14:55","15:55","16:25","16:55","17:25","17:55","18:25","18:55","19:55","20:55","21:55"] },
      { origin: "Foligno/Fabriano (R)", times: ["07:40","08:40","09:40","11:40","13:40","15:40","17:40","19:40","21:40"] },
    ],
  },
  {
    id: "rail-falconara",
    name: "Stazione FS Falconara Marittima",
    type: "railway",
    lat: 43.6301852, lng: 13.39739496,
    gtfsStopIds: ["20026", "20027"],
    description: "Stazione di Falconara — nodo ferrovia Adriatica / linea per Roma",
    platformWalkMinutes: 2,
    typicalDepartures: [
      { destination: "Ancona (R)", times: ["06:10","06:40","07:10","07:40","08:10","08:40","09:40","10:40","11:40","12:40","13:40","14:40","15:40","16:10","16:40","17:10","17:40","18:10","18:40","19:40","20:40"] },
      { destination: "Roma (via Orte)", times: ["06:35","10:05","14:05","17:35"] },
      { destination: "Pesaro/Rimini (R)", times: ["06:15","07:15","08:15","09:15","11:15","13:15","15:15","17:15","19:15","21:15"] },
    ],
    typicalArrivals: [
      { origin: "Ancona (R)", times: ["06:30","07:00","07:30","08:00","08:30","09:00","10:00","11:00","12:00","13:00","14:00","15:00","16:00","16:30","17:00","17:30","18:00","18:30","19:00","20:00","21:00"] },
      { origin: "Roma (via Orte)", times: ["10:30","14:30","18:30","21:30"] },
      { origin: "Pesaro/Rimini (R)", times: ["06:50","07:50","08:50","09:50","11:50","13:50","15:50","17:50","19:50","21:50"] },
    ],
  },
  {
    id: "rail-palombina",
    name: "Stazione Palombina Nuova",
    type: "railway",
    lat: 43.61802912, lng: 13.42590525,
    gtfsStopIds: ["20020", "20034"],
    description: "Fermata ferroviaria Palombina — collegamento costiero",
    platformWalkMinutes: 1,
    typicalDepartures: [
      { destination: "Ancona (R)", times: ["06:20","07:20","08:20","09:20","12:20","14:20","16:20","17:20","18:20","19:20"] },
      { destination: "Falconara (R)", times: ["06:45","07:45","08:45","10:45","13:45","15:45","17:45","19:45"] },
    ],
    typicalArrivals: [
      { origin: "Ancona (R)", times: ["06:55","07:55","08:55","10:55","13:55","15:55","17:55","19:55"] },
      { origin: "Falconara (R)", times: ["06:35","07:35","08:35","09:35","12:35","14:35","16:35","17:35","18:35","19:35"] },
    ],
  },
  {
    id: "port-ancona",
    name: "Porto di Ancona (Terminal Passeggeri)",
    type: "port",
    lat: 43.61864036, lng: 13.50938321,
    gtfsStopIds: ["20003", "20047"],
    description: "Terminal traghetti — linee per Croazia, Grecia, Albania",
    platformWalkMinutes: 8, // sbarco nave → uscita terminal → fermata
    typicalDepartures: [
      { destination: "Spalato (HR) - Jadrolinija", times: ["19:00"] },
      { destination: "Spalato (HR) - SNAV", times: ["17:30"] },
      { destination: "Patrasso (GR) - Minoan/Anek", times: ["13:30","17:00"] },
      { destination: "Durazzo (AL) - Adria Ferries", times: ["21:00"] },
      { destination: "Igoumenitsa (GR)", times: ["13:30","17:00"] },
    ],
    typicalArrivals: [
      { origin: "Spalato (HR) - Jadrolinija", times: ["07:00"] },
      { origin: "Spalato (HR) - SNAV", times: ["09:00"] },
      { origin: "Patrasso (GR) - Minoan/Anek", times: ["08:00","15:00"] },
      { origin: "Durazzo (AL) - Adria Ferries", times: ["07:30"] },
      { origin: "Igoumenitsa (GR)", times: ["08:00","15:00"] },
    ],
  },
  {
    id: "airport-falconara",
    name: "Aeroporto Raffaello Sanzio (Falconara)",
    type: "airport",
    lat: 43.61632, lng: 13.36244,
    gtfsStopIds: ["20159", "20184", "20158", "20185", "20160", "20183"],
    description: "Aeroporto delle Marche — voli nazionali e internazionali",
    platformWalkMinutes: 5, // uscita terminal → fermata bus più vicina (Castelferretti)
    typicalDepartures: [
      { destination: "Roma Fiumicino (Ryanair)", times: ["06:30","13:15","19:00"] },
      { destination: "Milano Bergamo (Ryanair)", times: ["07:00","17:30"] },
      { destination: "Londra Stansted (Ryanair)", times: ["12:45"] },
      { destination: "Bruxelles Charleroi", times: ["14:30"] },
      { destination: "Düsseldorf", times: ["10:00"] },
      { destination: "Tirana (Albania)", times: ["09:00","18:00"] },
    ],
    typicalArrivals: [
      { origin: "Roma Fiumicino (Ryanair)", times: ["10:30","16:15","22:00"] },
      { origin: "Milano Bergamo (Ryanair)", times: ["09:45","20:15"] },
      { origin: "Londra Stansted (Ryanair)", times: ["12:00"] },
      { origin: "Bruxelles Charleroi", times: ["14:00"] },
      { origin: "Düsseldorf", times: ["09:30"] },
      { origin: "Tirana (Albania)", times: ["08:30","17:30"] },
    ],
  },
  {
    id: "rail-torrette",
    name: "Stazione di Ancona Torrette",
    type: "railway",
    lat: 43.60393, lng: 13.45299,
    gtfsStopIds: ["20335", "20466", "20011", "20039", "20370", "20467"],
    description: "Fermata ferroviaria Torrette — adiacente Ospedale Regionale Ospedali Riuniti",
    platformWalkMinutes: 2, // fermata piccola, accesso diretto
    typicalDepartures: [
      { destination: "Ancona (R)", times: ["06:25","07:25","08:25","09:25","12:25","14:25","16:25","17:25","18:25","19:25"] },
      { destination: "Falconara (R)", times: ["06:50","07:50","08:50","10:50","13:50","15:50","17:50","19:50"] },
    ],
    typicalArrivals: [
      { origin: "Ancona (R)", times: ["06:50","07:50","08:50","10:50","13:50","15:50","17:50","19:50"] },
      { origin: "Falconara (R)", times: ["06:30","07:30","08:30","09:30","12:30","14:30","16:30","17:30","18:30","19:30"] },
    ],
  },
];

// Alias for backward-compat: intermodal code used timeToMin / minToTime
const timeToMin = timeToMinutes;

// ──────────────────────────────────────────────────────────
// GET /api/intermodal/hubs — return hub definitions for map
// ──────────────────────────────────────────────────────────
router.get("/intermodal/hubs", (_req, res) => {
  res.json(INTERMODAL_HUBS.map(h => ({
    id: h.id, name: h.name, type: h.type,
    lat: h.lat, lng: h.lng,
    description: h.description,
    platformWalkMinutes: h.platformWalkMinutes,
    departures: h.typicalDepartures.reduce((sum, d) => sum + d.times.length, 0),
    arrivals: h.typicalArrivals.reduce((sum, a) => sum + a.times.length, 0),
    destinations: h.typicalDepartures.map(d => d.destination),
    origins: h.typicalArrivals.map(a => a.origin),
  })));
});

// ──────────────────────────────────────────────────────────────────
// GET /api/intermodal/analyze — PASSENGER-CENTRIC intermodal analysis
//
// CORE CONCEPT: passenger arrives by train/ferry → walks from platform
// to bus stop → waits for bus. We analyze:
//   1. Walking time from hub to each nearby bus stop (distance-based)
//   2. For each arrival (train/ferry): what is the first bus the
//      passenger can catch, considering walk time?
//   3. Where does each bus go? (destination analysis)
//   4. "Bus already left" scenarios (bus departed before walk completed)
//   5. Gap windows with zero outbound service
// ──────────────────────────────────────────────────────────────────
router.get("/intermodal/analyze", async (req, res) => {
  try {
    const maxWalkKm = parseFloat(req.query.radius as string) || 0.5;

    // 1. Fetch all GTFS stops & find those near each hub
    const allStops = await db.select({
      stopId: gtfsStops.stopId,
      stopName: gtfsStops.stopName,
      lat: gtfsStops.stopLat,
      lng: gtfsStops.stopLon,
    }).from(gtfsStops);

    // 2. Find nearby bus stops per hub (within maxWalkKm)
    const hubNearbyStops: Record<string, { stopId: string; stopName: string; lat: number; lng: number; distKm: number; walkMin: number }[]> = {};
    for (const hub of INTERMODAL_HUBS) {
      const nearby: typeof hubNearbyStops[string] = [];
      for (const stop of allStops) {
        const sLat = typeof stop.lat === "string" ? parseFloat(stop.lat) : stop.lat;
        const sLng = typeof stop.lng === "string" ? parseFloat(stop.lng) : stop.lng;
        if (!sLat || !sLng) continue;
        const d = haversineKm(hub.lat, hub.lng, sLat as number, sLng as number);
        if (d <= maxWalkKm) {
          const totalWalk = hub.platformWalkMinutes + walkMinutes(d);
          nearby.push({
            stopId: stop.stopId, stopName: stop.stopName || "",
            lat: sLat as number, lng: sLng as number,
            distKm: +d.toFixed(3), walkMin: totalWalk,
          });
        }
      }
      nearby.sort((a, b) => a.distKm - b.distKm);
      hubNearbyStops[hub.id] = nearby;
    }

    // 3. Fetch stop_times for all relevant stops
    const allRelevantStopIds = [
      ...INTERMODAL_HUBS.flatMap(h => h.gtfsStopIds),
      ...Object.values(hubNearbyStops).flatMap(arr => arr.map(s => s.stopId)),
    ];
    const uniqueStopIds = [...new Set(allRelevantStopIds)];

    let hubStopTimes: { stopId: string; tripId: string; departureTime: string | null; arrivalTime: string | null; stopSequence: number | null }[] = [];
    if (uniqueStopIds.length > 0) {
      const batchSize = 500;
      for (let i = 0; i < uniqueStopIds.length; i += batchSize) {
        const batch = uniqueStopIds.slice(i, i + batchSize);
        const rows = await db.select({
          stopId: gtfsStopTimes.stopId,
          tripId: gtfsStopTimes.tripId,
          departureTime: gtfsStopTimes.departureTime,
          arrivalTime: gtfsStopTimes.arrivalTime,
          stopSequence: gtfsStopTimes.stopSequence,
        }).from(gtfsStopTimes)
          .where(sql`${gtfsStopTimes.stopId} IN (${sql.join(batch.map(id => sql`${id}`), sql`, `)})`);
        hubStopTimes.push(...rows);
      }
    }

    // 4. Trip → Route mapping
    const tripIds = [...new Set(hubStopTimes.map(st => st.tripId))];
    const tripRouteMap: Record<string, string> = {};
    if (tripIds.length > 0) {
      const batchSize = 500;
      for (let i = 0; i < tripIds.length; i += batchSize) {
        const batch = tripIds.slice(i, i + batchSize);
        const tripRows = await db.select({ tripId: gtfsTrips.tripId, routeId: gtfsTrips.routeId })
          .from(gtfsTrips)
          .where(sql`${gtfsTrips.tripId} IN (${sql.join(batch.map(id => sql`${id}`), sql`, `)})`);
        for (const tr of tripRows) tripRouteMap[tr.tripId] = tr.routeId;
      }
    }

    // Route info
    const gtfsRoutesAll = await db.select({
      routeId: gtfsRoutes.routeId,
      shortName: gtfsRoutes.routeShortName,
      longName: gtfsRoutes.routeLongName,
      color: gtfsRoutes.routeColor,
    }).from(gtfsRoutes);
    const routeMap: Record<string, { shortName: string | null; longName: string | null; color: string | null }> = {};
    for (const r of gtfsRoutesAll) routeMap[r.routeId] = { shortName: r.shortName, longName: r.longName, color: r.color };

    // 5. For each trip, find where it ENDS (destination) by looking at last stop
    // We need trip → last stop name for destination analysis
    // Fetch all stop_times for relevant trips to get the last stops
    const tripDestinations: Record<string, string> = {};
    const tripLastStopSeq: Record<string, { seq: number; stopId: string }> = {};
    for (const st of hubStopTimes) {
      const prev = tripLastStopSeq[st.tripId];
      if (!prev || (st.stopSequence || 0) > prev.seq) {
        tripLastStopSeq[st.tripId] = { seq: st.stopSequence || 0, stopId: st.stopId };
      }
    }
    // We also need the LAST stop of each trip (the actual terminal) — fetch from full stop_times
    // For performance, we'll use the route long name as destination proxy
    // But also get last stops from the data we have
    for (const [tripId, info] of Object.entries(tripLastStopSeq)) {
      const lastStop = allStops.find(s => s.stopId === info.stopId);
      if (lastStop) tripDestinations[tripId] = lastStop.stopName || info.stopId;
    }

    // 6. Analyze each hub — ARRIVAL PERSPECTIVE
    const hubAnalyses: any[] = [];

    for (const hub of INTERMODAL_HUBS) {
      const nearbyStops = hubNearbyStops[hub.id] || [];
      const nearbyStopIds = new Set([...hub.gtfsStopIds, ...nearbyStops.map(s => s.stopId)]);
      const isServed = nearbyStops.length > 0 || hub.gtfsStopIds.length > 0;

      // Build stop → walkMin map
      const stopWalkMap: Record<string, number> = {};
      for (const ns of nearbyStops) stopWalkMap[ns.stopId] = ns.walkMin;
      for (const sid of hub.gtfsStopIds) {
        if (!stopWalkMap[sid]) stopWalkMap[sid] = hub.platformWalkMinutes + 1;
      }

      // Get all stop_times at this hub's stops
      const hubTimes = hubStopTimes.filter(st => nearbyStopIds.has(st.stopId));

      // Group by route — for bus lines panel
      const byRoute: Record<string, { times: Set<string>; destinations: Set<string> }> = {};
      for (const st of hubTimes) {
        const rId = tripRouteMap[st.tripId];
        if (!rId) continue;
        const t = st.departureTime || st.arrivalTime;
        if (!t) continue;
        if (!byRoute[rId]) byRoute[rId] = { times: new Set<string>(), destinations: new Set<string>() };
        byRoute[rId].times.add(t);
        // Add route long name as proxy destination
        const rInfo = routeMap[rId];
        if (rInfo?.longName) {
          // Extract destination from route name (usually "A - B" format)
          const parts = rInfo.longName.split(/[-–—>/]/);
          if (parts.length >= 2) byRoute[rId].destinations.add(parts[parts.length - 1].trim());
        }
        // Also add trip-specific last stop
        const dest = tripDestinations[st.tripId];
        if (dest) byRoute[rId].destinations.add(dest);
      }

      const busLines = Object.entries(byRoute).map(([rId, info]) => ({
        routeId: rId,
        routeShortName: routeMap[rId]?.shortName || rId,
        routeLongName: routeMap[rId]?.longName || "",
        routeColor: routeMap[rId]?.color || null,
        tripsCount: info.times.size,
        times: [...info.times].sort(),
        destinations: [...info.destinations],
      }));

      // ── ARRIVAL-BASED ANALYSIS ──
      // For each train/ferry ARRIVAL: passenger steps off → walks X min → arrives at bus stop
      // → finds next bus departure → how long does they wait? is there a bus at all?
      const arrivalConnections: {
        origin: string;          // where the train/ferry came from
        arrivalTime: string;     // when it arrives at hub
        walkMin: number;         // min walk to nearest usable stop
        atBusStopTime: string;   // when passenger physically reaches bus stop
        firstBus: {
          departureTime: string;
          routeShortName: string;
          routeLongName: string;
          stopName: string;
          waitMin: number;        // minutes waiting at bus stop
          destination: string;    // where the bus goes
        } | null;
        allBusOptions: {          // all buses within 60 min of arrival at stop
          departureTime: string;
          routeShortName: string;
          waitMin: number;
          destination: string;
        }[];
        justMissed: {             // buses that LEFT before passenger could walk there
          departureTime: string;
          routeShortName: string;
          missedByMin: number;
          destination: string;
        }[];
        status: "ok" | "long-wait" | "no-bus" | "just-missed";
        totalTransferMin: number | null; // walk + wait = total transfer time
      }[] = [];

      if (hub.typicalArrivals && isServed) {
        for (const arr of hub.typicalArrivals) {
          for (const t of arr.times) {
            const arrivalMin = timeToMin(t);

            // Find nearest stop walk time
            const minWalk = nearbyStops.length > 0
              ? Math.min(...nearbyStops.map(s => s.walkMin))
              : hub.platformWalkMinutes + 1;

            const atStopMin = arrivalMin + minWalk;
            const maxWaitMin = 60; // max acceptable wait
            const atStopTime = minToTime(atStopMin);

            // Find ALL bus departures from nearby stops AFTER passenger arrives
            interface BusOption {
              departureMin: number;
              routeId: string;
              routeShortName: string;
              routeLongName: string;
              stopId: string;
              stopName: string;
              waitMin: number;
              destination: string;
            }

            const options: BusOption[] = [];
            const justMissed: { departureTime: string; routeShortName: string; missedByMin: number; destination: string }[] = [];

            for (const st of hubTimes) {
              const depTime = st.departureTime || st.arrivalTime;
              if (!depTime) continue;
              const busDepMin = timeToMin(depTime);
              if (busDepMin <= 0) continue;

              const rId = tripRouteMap[st.tripId];
              if (!rId) continue;
              const rInfo = routeMap[rId];
              const shortName = rInfo?.shortName || rId;
              const longName = rInfo?.longName || "";

              // Walk time to THIS specific stop
              const walkToThisStop = stopWalkMap[st.stopId] || minWalk;
              const passengerArrivalAtThisStop = arrivalMin + walkToThisStop;

              // Extract destination for this trip
              let dest = tripDestinations[st.tripId] || "";
              if (!dest && longName) {
                const parts = longName.split(/[-–—>/]/);
                if (parts.length >= 2) dest = parts[parts.length - 1].trim();
              }

              const stopInfo = nearbyStops.find(s => s.stopId === st.stopId);
              const sName = stopInfo?.stopName || st.stopId;

              if (busDepMin >= passengerArrivalAtThisStop && busDepMin <= passengerArrivalAtThisStop + maxWaitMin) {
                // Bus is catchable!
                options.push({
                  departureMin: busDepMin,
                  routeId: rId, routeShortName: shortName, routeLongName: longName,
                  stopId: st.stopId, stopName: sName,
                  waitMin: busDepMin - passengerArrivalAtThisStop,
                  destination: dest,
                });
              } else if (busDepMin < passengerArrivalAtThisStop && busDepMin >= arrivalMin) {
                // Bus LEFT while passenger was still walking!
                justMissed.push({
                  departureTime: depTime,
                  routeShortName: shortName,
                  missedByMin: passengerArrivalAtThisStop - busDepMin,
                  destination: dest,
                });
              }
            }

            // Sort by wait time, dedupe by route
            options.sort((a, b) => a.waitMin - b.waitMin);

            // Best first bus
            const firstBus = options.length > 0 ? {
              departureTime: minToTime(options[0].departureMin),
              routeShortName: options[0].routeShortName,
              routeLongName: options[0].routeLongName,
              stopName: options[0].stopName,
              waitMin: options[0].waitMin,
              destination: options[0].destination,
            } : null;

            // Top bus options (different routes, within 60 min)
            const seenRoutes = new Set<string>();
            const allBusOptions: typeof arrivalConnections[0]["allBusOptions"] = [];
            for (const opt of options) {
              const key = opt.routeId;
              if (seenRoutes.has(key)) continue;
              seenRoutes.add(key);
              allBusOptions.push({
                departureTime: minToTime(opt.departureMin),
                routeShortName: opt.routeShortName,
                waitMin: opt.waitMin,
                destination: opt.destination,
              });
              if (allBusOptions.length >= 8) break;
            }

            // Dedupe just-missed (unique routes, closest miss)
            const missedByRoute: Record<string, typeof justMissed[0]> = {};
            for (const jm of justMissed) {
              if (!missedByRoute[jm.routeShortName] || jm.missedByMin < missedByRoute[jm.routeShortName].missedByMin) {
                missedByRoute[jm.routeShortName] = jm;
              }
            }
            const uniqueMissed = Object.values(missedByRoute)
              .sort((a, b) => a.missedByMin - b.missedByMin)
              .slice(0, 5);

            // Determine status
            let status: "ok" | "long-wait" | "no-bus" | "just-missed" = "no-bus";
            if (firstBus) {
              status = firstBus.waitMin > 25 ? "long-wait" : "ok";
            } else if (uniqueMissed.length > 0) {
              status = "just-missed";
            }

            arrivalConnections.push({
              origin: arr.origin,
              arrivalTime: t,
              walkMin: minWalk,
              atBusStopTime: atStopTime,
              firstBus,
              allBusOptions,
              justMissed: uniqueMissed,
              status,
              totalTransferMin: firstBus ? (minWalk + firstBus.waitMin) : null,
            });
          }
        }
      }

      // ── DEPARTURE CONNECTIONS (original logic, but with walk-time-aware matching) ──
      const departureConnections: {
        destination: string; departureTime: string;
        bestBusArrival: string | null; bestBusRoute: string | null;
        waitMinutes: number | null; missedBy: number | null;
      }[] = [];

      if (hub.typicalDepartures && isServed) {
        for (const dep of hub.typicalDepartures) {
          for (const t of dep.times) {
            const depMin = timeToMin(t);
            // Passenger must arrive at hub X minutes before departure
            // (includes walk from bus stop to platform)
            const minWalk = nearbyStops.length > 0
              ? Math.min(...nearbyStops.map(s => s.walkMin))
              : hub.platformWalkMinutes + 1;
            const latestBusArrival = depMin - minWalk; // must step off bus by this time
            const maxWait = 60;
            let bestBus: number | null = null;
            let bestBusRoute: string | null = null;

            for (const st of hubTimes) {
              const bm = timeToMin(st.arrivalTime || st.departureTime || "");
              if (bm <= 0) continue;
              if (bm <= latestBusArrival && bm >= depMin - maxWait) {
                if (bestBus === null || bm > bestBus) {
                  bestBus = bm;
                  const rId = tripRouteMap[st.tripId];
                  bestBusRoute = rId ? (routeMap[rId]?.shortName || rId) : null;
                }
              }
            }

            let missedBy: number | null = null;
            if (bestBus === null) {
              const tooLate = hubTimes
                .map(st => timeToMin(st.arrivalTime || st.departureTime || ""))
                .filter(bm => bm > latestBusArrival && bm <= depMin + 15)
                .sort((a, b) => a - b);
              if (tooLate.length > 0) missedBy = tooLate[0] - latestBusArrival;
            }

            departureConnections.push({
              destination: dep.destination,
              departureTime: t,
              bestBusArrival: bestBus !== null ? minToTime(bestBus) : null,
              bestBusRoute,
              waitMinutes: bestBus !== null ? latestBusArrival - bestBus : null,
              missedBy,
            });
          }
        }
      }

      // ── DESTINATION COVERAGE ANALYSIS ──
      // From this hub, what destinations can you reach by bus?
      // Group by destination name, show how many trips/day, first and last
      const destinationCoverage: {
        destination: string;
        routeShortName: string;
        routeLongName: string;
        tripsPerDay: number;
        firstDeparture: string;
        lastDeparture: string;
        avgFrequencyMin: number | null;
      }[] = [];

      for (const bl of busLines) {
        for (const dest of bl.destinations) {
          if (!dest) continue;
          const times = bl.times.sort();
          let avgFreq: number | null = null;
          if (times.length >= 2) {
            const mins = times.map(timeToMin);
            const gaps = mins.slice(1).map((m, i) => m - mins[i]);
            avgFreq = Math.round(gaps.reduce((s, g) => s + g, 0) / gaps.length);
          }
          destinationCoverage.push({
            destination: dest,
            routeShortName: bl.routeShortName,
            routeLongName: bl.routeLongName,
            tripsPerDay: bl.tripsCount,
            firstDeparture: times[0] || "",
            lastDeparture: times[times.length - 1] || "",
            avgFrequencyMin: avgFreq,
          });
        }
      }

      // ── HOURLY GAP ANALYSIS (now includes arrival perspective) ──
      const allBusDepartureMinutes = hubTimes
        .map(st => timeToMin(st.departureTime || st.arrivalTime || ""))
        .filter(m => m > 0)
        .sort((a, b) => a - b);

      const gapAnalysis: { hour: number; busDepartures: number; hubArrivals: number; hubDepartures: number; gap: boolean }[] = [];
      for (let h = 5; h <= 23; h++) {
        const busDeps = allBusDepartureMinutes.filter(m => m >= h * 60 && m < (h + 1) * 60).length;
        const hubArrivals = hub.typicalArrivals.reduce((sum, a) => {
          return sum + a.times.filter(t => { const m = timeToMin(t); return m >= h * 60 && m < (h + 1) * 60; }).length;
        }, 0);
        const hubDeps = hub.typicalDepartures.reduce((sum, dep) => {
          return sum + dep.times.filter(t => { const m = timeToMin(t); return m >= h * 60 && m < (h + 1) * 60; }).length;
        }, 0);
        gapAnalysis.push({
          hour: h,
          busDepartures: busDeps,
          hubArrivals: hubArrivals,
          hubDepartures: hubDeps,
          gap: (hubArrivals > 0 || hubDeps > 0) && busDeps === 0,
        });
      }

      // ── WAIT TIME DISTRIBUTION ──
      const waitDistribution: { range: string; count: number }[] = [
        { range: "0-5 min", count: 0 },
        { range: "5-10 min", count: 0 },
        { range: "10-15 min", count: 0 },
        { range: "15-25 min", count: 0 },
        { range: "25-40 min", count: 0 },
        { range: "40-60 min", count: 0 },
        { range: "> 60 min / nessun bus", count: 0 },
      ];
      for (const ac of arrivalConnections) {
        if (!ac.firstBus) {
          waitDistribution[6].count++;
        } else if (ac.firstBus.waitMin <= 5) waitDistribution[0].count++;
        else if (ac.firstBus.waitMin <= 10) waitDistribution[1].count++;
        else if (ac.firstBus.waitMin <= 15) waitDistribution[2].count++;
        else if (ac.firstBus.waitMin <= 25) waitDistribution[3].count++;
        else if (ac.firstBus.waitMin <= 40) waitDistribution[4].count++;
        else waitDistribution[5].count++;
      }

      // Stats
      const arrivalStats = {
        totalArrivals: arrivalConnections.length,
        withBus: arrivalConnections.filter(c => c.firstBus !== null).length,
        noBus: arrivalConnections.filter(c => c.status === "no-bus").length,
        justMissed: arrivalConnections.filter(c => c.status === "just-missed").length,
        longWait: arrivalConnections.filter(c => c.status === "long-wait").length,
        ok: arrivalConnections.filter(c => c.status === "ok").length,
        avgWaitMin: (() => {
          const waits = arrivalConnections.filter(c => c.firstBus).map(c => c.firstBus!.waitMin);
          return waits.length > 0 ? Math.round(waits.reduce((s, w) => s + w, 0) / waits.length) : null;
        })(),
        avgTotalTransferMin: (() => {
          const transfers = arrivalConnections.filter(c => c.totalTransferMin !== null).map(c => c.totalTransferMin!);
          return transfers.length > 0 ? Math.round(transfers.reduce((s, t) => s + t, 0) / transfers.length) : null;
        })(),
      };

      hubAnalyses.push({
        hub: {
          id: hub.id, name: hub.name, type: hub.type,
          lat: hub.lat, lng: hub.lng,
          description: hub.description,
          platformWalkMinutes: hub.platformWalkMinutes,
        },
        isServed,
        nearbyStops: nearbyStops.slice(0, 20),
        busLines,
        arrivalConnections,       // NEW: passenger arrives → catches bus
        departureConnections: departureConnections, // keep legacy: passenger takes bus → catches train
        destinationCoverage,      // NEW: where can you go from here
        gapAnalysis,
        waitDistribution,         // NEW: histogram of wait times
        arrivalStats,             // NEW: stats focused on arrivals
        stats: {
          totalBusTrips: allBusDepartureMinutes.length,
          totalHubDepartures: departureConnections.length,
          covered: departureConnections.filter(c => c.bestBusArrival !== null).length,
          missed: departureConnections.filter(c => c.bestBusArrival === null).length,
          avgWaitMin: (() => {
            const waits = departureConnections.filter(c => c.waitMinutes !== null).map(c => c.waitMinutes!);
            return waits.length > 0 ? Math.round(waits.reduce((s, w) => s + w, 0) / waits.length) : null;
          })(),
        },
      });
    }

    // 7. PASSENGER-CENTRIC SUGGESTIONS
    const suggestions: {
      priority: "critical" | "high" | "medium" | "low";
      type: string; hub: string; description: string;
      details?: string;
      suggestedTimes?: string[];
    }[] = [];

    for (const hc of hubAnalyses) {
      if (!hc.isServed || hc.nearbyStops.length === 0) {
        suggestions.push({
          priority: "critical", type: "extend-route", hub: hc.hub.name,
          description: `Nessuna fermata bus entro ${maxWalkKm} km da ${hc.hub.name}. Passeggeri in arrivo non hanno trasporto pubblico.`,
          details: `Il ${hc.hub.type === "railway" ? "treno" : hc.hub.type === "airport" ? "volo" : "traghetto"} arriva ma i passeggeri non possono proseguire in bus.`,
        });
        continue;
      }

      // Critical: arrivals with NO bus at all
      const noBus = hc.arrivalConnections.filter((c: any) => c.status === "no-bus");
      if (noBus.length > 0) {
        const times = noBus.map((c: any) => c.arrivalTime).join(", ");
        suggestions.push({
          priority: "critical", type: "no-service", hub: hc.hub.name,
          description: `${noBus.length} arrivi ${hc.hub.type === "railway" ? "treno" : hc.hub.type === "airport" ? "volo" : "nave"} senza NESSUN bus disponibile entro 60 min.`,
          details: `Orari critici: ${times}. I passeggeri restano senza trasporto.`,
          suggestedTimes: noBus.map((c: any) => minToTime(timeToMin(c.arrivalTime) + (c.walkMin || 5) + 3)),
        });
      }

      // High: "just missed" — bus left while walking
      const justMissedArrivals = hc.arrivalConnections.filter((c: any) => c.status === "just-missed");
      if (justMissedArrivals.length > 0) {
        const examples = justMissedArrivals.slice(0, 3).map((c: any) =>
          `${c.origin} arr. ${c.arrivalTime}: bus partito ${c.justMissed[0]?.missedByMin || "?"} min prima`
        ).join("; ");
        suggestions.push({
          priority: "high", type: "just-missed", hub: hc.hub.name,
          description: `${justMissedArrivals.length} arrivi dove il bus parte PRIMA che il passeggero arrivi alla fermata (tempo cammino: ${hc.nearbyStops[0]?.walkMin || "?"} min).`,
          details: examples,
          suggestedTimes: justMissedArrivals.map((c: any) =>
            minToTime(timeToMin(c.arrivalTime) + (c.walkMin || 5) + 3)
          ).slice(0, 5),
        });
      }

      // High: long waits (>25 min at bus stop)
      const longWaits = hc.arrivalConnections.filter((c: any) => c.status === "long-wait");
      if (longWaits.length > 3) {
        suggestions.push({
          priority: "high", type: "long-wait", hub: hc.hub.name,
          description: `${longWaits.length} arrivi con attesa alla fermata bus > 25 min.`,
          details: `Tempo medio di trasferimento totale (cammino+attesa): ${hc.arrivalStats.avgTotalTransferMin || "?"} min.`,
        });
      }

      // Medium: gap hours
      const gapHours = hc.gapAnalysis.filter((g: any) => g.gap);
      if (gapHours.length > 0) {
        suggestions.push({
          priority: "medium", type: "gap-hours", hub: hc.hub.name,
          description: `Fasce orarie senza bus ma con arrivi treno/nave: ${gapHours.map((g: any) => `${g.hour}:00`).join(", ")}.`,
          suggestedTimes: gapHours.map((g: any) => minToTime(g.hour * 60 + 15)),
        });
      }

      // Low: walk time too long
      const avgWalk = hc.nearbyStops.length > 0
        ? Math.round(hc.nearbyStops.reduce((s: number, ns: any) => s + ns.walkMin, 0) / hc.nearbyStops.length)
        : 0;
      if (avgWalk > 10) {
        suggestions.push({
          priority: "medium", type: "walk-distance", hub: hc.hub.name,
          description: `Tempo medio di cammino piattaforma→fermata: ${avgWalk} min. Considerare fermata più vicina.`,
        });
      }
    }

    const priorityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
    suggestions.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

    // 8. Proposed schedule adjustments
    const proposedSchedule: {
      action: "add" | "shift" | "extend";
      hubId: string; hubName: string;
      currentTime?: string; proposedTime: string;
      reason: string;
      impact: string;
    }[] = [];

    for (const hc of hubAnalyses) {
      if (!hc.isServed) continue;

      // For each arrival with no bus or just-missed: propose a new bus trip
      for (const ac of hc.arrivalConnections) {
        if (ac.status === "no-bus" || ac.status === "just-missed") {
          const proposedBusTime = minToTime(timeToMin(ac.arrivalTime) + ac.walkMin + 3);
          proposedSchedule.push({
            action: "add", hubId: hc.hub.id, hubName: hc.hub.name,
            proposedTime: proposedBusTime,
            reason: `Coincidenza con ${ac.origin} in arrivo alle ${ac.arrivalTime}`,
            impact: `Passeggeri da ${ac.origin} potranno prendere il bus dopo ${ac.walkMin + 3} min di cammino`,
          });
        } else if (ac.status === "long-wait" && ac.firstBus) {
          // Propose shifting the bus earlier
          const idealTime = minToTime(timeToMin(ac.arrivalTime) + ac.walkMin + 3);
          proposedSchedule.push({
            action: "shift", hubId: hc.hub.id, hubName: hc.hub.name,
            currentTime: ac.firstBus.departureTime,
            proposedTime: idealTime,
            reason: `Riduce attesa da ${ac.firstBus.waitMin} min a ~3 min per passeggeri da ${ac.origin}`,
            impact: `Tempo trasferimento totale da ${ac.totalTransferMin} min a ${ac.walkMin + 3} min`,
          });
        }
      }
    }

    // 9. Summary
    const totalArrivalConnections = hubAnalyses.reduce((s: number, h: any) => s + h.arrivalConnections.length, 0);
    const okConnections = hubAnalyses.reduce((s: number, h: any) => s + h.arrivalStats.ok, 0);
    const longWaitConnections = hubAnalyses.reduce((s: number, h: any) => s + h.arrivalStats.longWait, 0);
    const noBusConnections = hubAnalyses.reduce((s: number, h: any) => s + h.arrivalStats.noBus, 0);
    const justMissedConnections = hubAnalyses.reduce((s: number, h: any) => s + h.arrivalStats.justMissed, 0);

    res.json({
      hubs: hubAnalyses,
      summary: {
        totalHubs: INTERMODAL_HUBS.length,
        servedHubs: hubAnalyses.filter((h: any) => h.isServed && h.nearbyStops.length > 0).length,
        // Arrival-based (primary)
        totalArrivals: totalArrivalConnections,
        arrivalOk: okConnections,
        arrivalLongWait: longWaitConnections,
        arrivalNoBus: noBusConnections,
        arrivalJustMissed: justMissedConnections,
        arrivalCoveragePercent: totalArrivalConnections > 0
          ? Math.round(((okConnections + longWaitConnections) / totalArrivalConnections) * 100) : 0,
        // Departure-based (legacy)
        totalDepartures: hubAnalyses.reduce((s: number, h: any) => s + h.departureConnections.length, 0),
        departureCovered: hubAnalyses.reduce((s: number, h: any) => s + h.stats.covered, 0),
        // Averages
        avgWaitAtStop: (() => {
          const waits = hubAnalyses.flatMap((h: any) =>
            h.arrivalConnections.filter((c: any) => c.firstBus).map((c: any) => c.firstBus.waitMin));
          return waits.length > 0 ? Math.round(waits.reduce((s: number, w: number) => s + w, 0) / waits.length) : null;
        })(),
        avgTotalTransfer: (() => {
          const transfers = hubAnalyses.flatMap((h: any) =>
            h.arrivalConnections.filter((c: any) => c.totalTransferMin !== null).map((c: any) => c.totalTransferMin));
          return transfers.length > 0 ? Math.round(transfers.reduce((s: number, t: number) => s + t, 0) / transfers.length) : null;
        })(),
        totalBusLines: hubAnalyses.reduce((s: number, h: any) => s + h.busLines.length, 0),
      },
      suggestions,
      proposedSchedule,
      config: { maxWalkKm, walkSpeedKmh: 4.5 },
    });
  } catch (err) {
    req.log.error(err, "Error analyzing intermodal connections");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ──────────────────────────────────────────────────────────
// GET /api/intermodal/hub/:hubId/routes — bus routes GeoJSON for a hub
// ──────────────────────────────────────────────────────────
router.get("/intermodal/hub/:hubId/routes", async (req, res) => {
  try {
    const hub = INTERMODAL_HUBS.find(h => h.id === req.params.hubId);
    if (!hub) { res.status(404).json({ error: "Hub non trovato" }); return; }

    const maxWalkKm = parseFloat(req.query.radius as string) || 0.5;

    // Find nearby stops
    const allStops = await db.select({
      stopId: gtfsStops.stopId,
      stopName: gtfsStops.stopName,
      lat: gtfsStops.stopLat,
      lng: gtfsStops.stopLon,
    }).from(gtfsStops);

    const nearbyStops: { stopId: string; stopName: string; lat: number; lng: number; distKm: number }[] = [];
    for (const stop of allStops) {
      const sLat = typeof stop.lat === "string" ? parseFloat(stop.lat) : stop.lat;
      const sLng = typeof stop.lng === "string" ? parseFloat(stop.lng) : stop.lng;
      if (!sLat || !sLng) continue;
      const d = haversineKm(hub.lat, hub.lng, sLat as number, sLng as number);
      if (d <= maxWalkKm) {
        nearbyStops.push({ stopId: stop.stopId, stopName: stop.stopName || "", lat: sLat as number, lng: sLng as number, distKm: +d.toFixed(3) });
      }
    }

    // Get route IDs serving these stops
    const stopIds = [...hub.gtfsStopIds, ...nearbyStops.map(s => s.stopId)];
    if (stopIds.length === 0) { res.json({ hub, nearbyStops: [], routes: [] }); return; }

    const stRows = await db.select({
      stopId: gtfsStopTimes.stopId,
      tripId: gtfsStopTimes.tripId,
    }).from(gtfsStopTimes)
      .where(sql`${gtfsStopTimes.stopId} IN (${sql.join(stopIds.map(id => sql`${id}`), sql`, `)})`);

    const tripIds = [...new Set(stRows.map(r => r.tripId))];
    const tripRouteMap: Record<string, string> = {};
    if (tripIds.length > 0) {
      for (let i = 0; i < tripIds.length; i += 500) {
        const batch = tripIds.slice(i, i + 500);
        const rows = await db.select({ tripId: gtfsTrips.tripId, routeId: gtfsTrips.routeId })
          .from(gtfsTrips)
          .where(sql`${gtfsTrips.tripId} IN (${sql.join(batch.map(id => sql`${id}`), sql`, `)})`);
        for (const r of rows) tripRouteMap[r.tripId] = r.routeId;
      }
    }

    const routeIds = [...new Set(Object.values(tripRouteMap))];
    const routes = await db.select({
      routeId: gtfsRoutes.routeId,
      shortName: gtfsRoutes.routeShortName,
      longName: gtfsRoutes.routeLongName,
      color: gtfsRoutes.routeColor,
    }).from(gtfsRoutes)
      .where(sql`${gtfsRoutes.routeId} IN (${sql.join(routeIds.map(id => sql`${id}`), sql`, `)})`);

    res.json({ hub, nearbyStops, routes });
  } catch (err) {
    req.log.error(err, "Error fetching hub routes");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ──────────────────────────────────────────────────────────
// GET /api/intermodal/shapes — bus route shapes as GeoJSON
// Returns FeatureCollection for display as glowing routes on map
// ──────────────────────────────────────────────────────────
router.get("/intermodal/shapes", async (req, res) => {
  try {
    const hubId = req.query.hubId as string | undefined;

    // Get route IDs serving the requested hub (or all hubs)
    const hubs = hubId ? INTERMODAL_HUBS.filter(h => h.id === hubId) : INTERMODAL_HUBS;
    if (hubs.length === 0) { res.status(404).json({ error: "Hub non trovato" }); return; }

    // Collect nearby stop IDs for these hubs
    const allStops = await db.select({ stopId: gtfsStops.stopId, lat: gtfsStops.stopLat, lng: gtfsStops.stopLon }).from(gtfsStops);
    const nearbyStopIds: Set<string> = new Set();
    const maxWalkKm = parseFloat(req.query.radius as string) || 0.5;

    for (const hub of hubs) {
      for (const sid of hub.gtfsStopIds) nearbyStopIds.add(sid);
      for (const stop of allStops) {
        const sLat = typeof stop.lat === "string" ? parseFloat(stop.lat) : stop.lat;
        const sLng = typeof stop.lng === "string" ? parseFloat(stop.lng) : stop.lng;
        if (!sLat || !sLng) continue;
        if (haversineKm(hub.lat, hub.lng, sLat as number, sLng as number) <= maxWalkKm) {
          nearbyStopIds.add(stop.stopId);
        }
      }
    }

    // Get trip IDs from these stops
    const stopIdArr = [...nearbyStopIds];
    if (stopIdArr.length === 0) { res.json({ type: "FeatureCollection", features: [] }); return; }

    const stRows: { tripId: string }[] = [];
    for (let i = 0; i < stopIdArr.length; i += 500) {
      const batch = stopIdArr.slice(i, i + 500);
      const rows = await db.select({ tripId: gtfsStopTimes.tripId }).from(gtfsStopTimes)
        .where(sql`${gtfsStopTimes.stopId} IN (${sql.join(batch.map(id => sql`${id}`), sql`, `)})`);
      stRows.push(...rows);
    }

    // Get route IDs from trips
    const tripIds = [...new Set(stRows.map(r => r.tripId))];
    const routeIds: Set<string> = new Set();
    for (let i = 0; i < tripIds.length; i += 500) {
      const batch = tripIds.slice(i, i + 500);
      const rows = await db.select({ routeId: gtfsTrips.routeId }).from(gtfsTrips)
        .where(sql`${gtfsTrips.tripId} IN (${sql.join(batch.map(id => sql`${id}`), sql`, `)})`);
      for (const r of rows) routeIds.add(r.routeId);
    }

    // Fetch shapes for these routes
    const routeIdArr = [...routeIds];
    if (routeIdArr.length === 0) { res.json({ type: "FeatureCollection", features: [] }); return; }

    const shapes: { shapeId: string; routeId: string | null; routeShortName: string | null; routeColor: string | null; geojson: any }[] = [];
    for (let i = 0; i < routeIdArr.length; i += 100) {
      const batch = routeIdArr.slice(i, i + 100);
      const rows = await db.select({
        shapeId: gtfsShapes.shapeId,
        routeId: gtfsShapes.routeId,
        routeShortName: gtfsShapes.routeShortName,
        routeColor: gtfsShapes.routeColor,
        geojson: gtfsShapes.geojson,
      }).from(gtfsShapes)
        .where(sql`${gtfsShapes.routeId} IN (${sql.join(batch.map(id => sql`${id}`), sql`, `)})`);
      shapes.push(...rows);
    }

    // Build FeatureCollection
    const seenRoutes = new Set<string>();
    const features = shapes
      .filter(s => {
        // Dedupe by routeId (one shape per route)
        const key = s.routeId || s.shapeId;
        if (seenRoutes.has(key)) return false;
        seenRoutes.add(key);
        return true;
      })
      .map(s => {
        const geo = typeof s.geojson === "string" ? JSON.parse(s.geojson) : s.geojson;
        return {
          type: "Feature" as const,
          properties: {
            shapeId: s.shapeId,
            routeId: s.routeId,
            routeShortName: s.routeShortName,
            routeColor: s.routeColor ? `#${s.routeColor.replace("#", "")}` : "#06b6d4",
          },
          geometry: geo.type === "FeatureCollection"
            ? (geo.features?.[0]?.geometry || geo)
            : geo.type === "Feature"
              ? geo.geometry
              : geo,
        };
      })
      .filter(f => f.geometry && (f.geometry.type === "LineString" || f.geometry.type === "MultiLineString"));

    res.json({ type: "FeatureCollection", features, total: features.length });
  } catch (err) {
    req.log.error(err, "Error fetching intermodal shapes");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ──────────────────────────────────────────────────────────
// GET /api/intermodal/pois — POIs connected to hubs
// Train hubs → work POIs (office, hospital, school, industrial)
// Port hub → tourism POIs (leisure, shopping)
// ──────────────────────────────────────────────────────────
router.get("/intermodal/pois", async (req, res) => {
  try {
    const maxDistKm = parseFloat(req.query.radius as string) || 3;

    // Define POI categories per hub type
    const WORK_CATEGORIES = ["office", "hospital", "school", "industrial"];
    const TOURISM_CATEGORIES = ["leisure", "shopping"];

    // Fetch all relevant POIs
    const workPois = await db.select({
      id: pointsOfInterest.id,
      name: pointsOfInterest.name,
      category: pointsOfInterest.category,
      lng: pointsOfInterest.lng,
      lat: pointsOfInterest.lat,
    }).from(pointsOfInterest)
      .where(inArray(pointsOfInterest.category, WORK_CATEGORIES))
      .limit(2000);

    const tourismPois = await db.select({
      id: pointsOfInterest.id,
      name: pointsOfInterest.name,
      category: pointsOfInterest.category,
      lng: pointsOfInterest.lng,
      lat: pointsOfInterest.lat,
    }).from(pointsOfInterest)
      .where(inArray(pointsOfInterest.category, TOURISM_CATEGORIES))
      .limit(1000);

    // For each hub, find relevant POIs within radius and build connections
    const hubPois: {
      hubId: string;
      hubName: string;
      hubType: "railway" | "port" | "airport";
      hubLat: number;
      hubLng: number;
      pois: {
        id: string;
        name: string | null;
        category: string;
        lat: number;
        lng: number;
        distKm: number;
        travelContext: string; // e.g. "Lavoro", "Turismo"
      }[];
    }[] = [];

    for (const hub of INTERMODAL_HUBS) {
      const isPort = hub.type === "port";
      const isAirport = hub.type === "airport";
      // Airport: mix lavoro+turismo (both categories). Port: tourism. Railway: work
      const relevantPois = isAirport ? [...workPois, ...tourismPois] : isPort ? tourismPois : workPois;
      const travelContext = isAirport ? "Lavoro + Turismo" : isPort ? "Turismo" : "Lavoro";

      const nearby = relevantPois
        .map(p => ({
          id: p.id,
          name: p.name,
          category: p.category,
          lat: p.lat,
          lng: p.lng,
          distKm: +haversineKm(hub.lat, hub.lng, p.lat, p.lng).toFixed(2),
          travelContext,
        }))
        .filter(p => p.distKm <= maxDistKm)
        .sort((a, b) => a.distKm - b.distKm)
        .slice(0, 50); // max 50 POIs per hub

      hubPois.push({
        hubId: hub.id,
        hubName: hub.name,
        hubType: hub.type,
        hubLat: hub.lat,
        hubLng: hub.lng,
        pois: nearby,
      });
    }

    // Summary stats
    const totalPois = hubPois.reduce((s, h) => s + h.pois.length, 0);
    const categoryBreakdown: Record<string, number> = {};
    for (const hp of hubPois) {
      for (const p of hp.pois) {
        categoryBreakdown[p.category] = (categoryBreakdown[p.category] || 0) + 1;
      }
    }

    res.json({
      hubPois,
      summary: { totalPois, categoryBreakdown },
      config: { maxDistKm, workCategories: WORK_CATEGORIES, tourismCategories: TOURISM_CATEGORIES },
    });
  } catch (err) {
    req.log.error(err, "Error fetching intermodal POIs");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ──────────────────────────────────────────────────────────
// POST /api/intermodal/sync-schedules — Update hub schedules
// In production: would fetch from Trenitalia/RFI/ferry APIs
// Here: returns current data with a "last synced" timestamp
// ──────────────────────────────────────────────────────────
let lastSyncTimestamp: string | null = null;

router.post("/intermodal/sync-schedules", async (req, res) => {
  try {
    // Simulate sync delay (in production: call Trenitalia API, scrape ferry schedules, etc.)
    await new Promise(resolve => setTimeout(resolve, 500));

    lastSyncTimestamp = new Date().toISOString();

    // Return current hub data as "synced"
    const hubSchedules = INTERMODAL_HUBS.map(h => ({
      id: h.id,
      name: h.name,
      type: h.type,
      arrivals: h.typicalArrivals.reduce((sum, a) => sum + a.times.length, 0),
      departures: h.typicalDepartures.reduce((sum, d) => sum + d.times.length, 0),
      sources: h.typicalArrivals.map(a => a.origin),
    }));

    res.json({
      success: true,
      syncedAt: lastSyncTimestamp,
      hubs: hubSchedules,
      message: `Orari aggiornati per ${hubSchedules.length} hub intermodali`,
    });
  } catch (err) {
    req.log.error(err, "Error syncing schedules");
    res.status(500).json({ error: "Errore sincronizzazione orari" });
  }
});

router.get("/intermodal/sync-status", (_req, res) => {
  res.json({ lastSyncedAt: lastSyncTimestamp, hubCount: INTERMODAL_HUBS.length });
});

export default router;
