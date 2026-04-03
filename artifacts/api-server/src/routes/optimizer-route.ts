/**
 * OPTIMIZER 1 — Route & Stop Placement Optimizer
 *
 * Given a scenario (KML route + optional stops), suggests optimal stop positions
 * considering: population density, POI coverage, bus size constraints (large bus
 * cannot pass narrow roads), inter-stop spacing, and existing GTFS stop proximity.
 *
 * POST /api/optimizer/route-placement   (scenarioId + params)
 * GET  /api/optimizer/route-placement/:scenarioId  (cached result)
 */
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  scenarios, censusSections, pointsOfInterest,
  gtfsStops, gtfsStopTimes, gtfsTrips, gtfsRoutes,
} from "@workspace/db/schema";
import { eq, sql } from "drizzle-orm";
import { haversineKm, lineLength, pointToLineDistance, timeToMinutes } from "../lib/geo-utils";
import { getLatestFeedId } from "./gtfs-helpers";
import { cache } from "../middlewares/cache";
import { strictLimiter } from "../middlewares/rate-limit";

const router: IRouter = Router();

/* ═══════════════════════════════════════════════════════════════
 *  TYPES
 * ═══════════════════════════════════════════════════════════════ */

interface Coord { lng: number; lat: number; }
interface RouteCoord extends Coord { cumKm: number; }

type BusSize = "standard" | "midi" | "minibus";

interface BusSizeProfile {
  label: string;
  lengthM: number;
  capacity: number;
  minRoadWidthM: number;           // minimum carriageway
  minCurveRadiusM: number;         // minimum turning radius
  maxGradientPercent: number;
  idealInterStopKm: { min: number; max: number };
}

const BUS_PROFILES: Record<BusSize, BusSizeProfile> = {
  standard: {
    label: "Autobus standard (12m)",
    lengthM: 12, capacity: 80,
    minRoadWidthM: 6.5, minCurveRadiusM: 12,
    maxGradientPercent: 12,
    idealInterStopKm: { min: 0.3, max: 0.8 },
  },
  midi: {
    label: "Midibus (8m)",
    lengthM: 8, capacity: 45,
    minRoadWidthM: 5.0, minCurveRadiusM: 8,
    maxGradientPercent: 14,
    idealInterStopKm: { min: 0.25, max: 0.6 },
  },
  minibus: {
    label: "Minibus (6m)",
    lengthM: 6, capacity: 25,
    minRoadWidthM: 3.5, minCurveRadiusM: 6,
    maxGradientPercent: 18,
    idealInterStopKm: { min: 0.2, max: 0.5 },
  },
};

interface SuggestedStop {
  lng: number;
  lat: number;
  cumKm: number;                 // distance along route from start
  score: number;                 // 0–100 placement quality
  reason: string[];              // why this location is good
  warnings: string[];            // potential issues
  popCoverage: number;           // people within 400m
  poiNearby: { category: string; name: string | null; distM: number }[];
  existingStopNearby: { stopId: string; name: string; distM: number } | null;
  busAccess: {
    recommended: BusSize;
    canStandard: boolean;
    canMidi: boolean;
    sharpTurns: number;          // nearby sharp bends count
    estimatedRoadScore: number;  // 0–1 drivability
  };
}

interface RouteSegmentAnalysis {
  fromKm: number;
  toKm: number;
  popDensity: number;           // people per km² in 400m corridor
  poiCount: number;
  sharpTurns: number;           // bends > 60°
  avgCurvature: number;         // deg per 100m
  estimatedDemand: "high" | "medium" | "low";
}

/* ═══════════════════════════════════════════════════════════════
 *  GEOMETRY HELPERS
 * ═══════════════════════════════════════════════════════════════ */

/** Build cumulative-distance array from route coords */
function buildRouteCumDist(coords: number[][]): RouteCoord[] {
  const result: RouteCoord[] = [{ lng: coords[0][0], lat: coords[0][1], cumKm: 0 }];
  let cum = 0;
  for (let i = 1; i < coords.length; i++) {
    cum += haversineKm(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]);
    result.push({ lng: coords[i][0], lat: coords[i][1], cumKm: cum });
  }
  return result;
}

/** Interpolate a point at a given cumKm along the route */
function interpolateAt(route: RouteCoord[], km: number): Coord {
  if (km <= 0) return { lng: route[0].lng, lat: route[0].lat };
  if (km >= route[route.length - 1].cumKm) return { lng: route[route.length - 1].lng, lat: route[route.length - 1].lat };
  for (let i = 1; i < route.length; i++) {
    if (route[i].cumKm >= km) {
      const segLen = route[i].cumKm - route[i - 1].cumKm;
      const t = segLen > 0 ? (km - route[i - 1].cumKm) / segLen : 0;
      return {
        lng: route[i - 1].lng + t * (route[i].lng - route[i - 1].lng),
        lat: route[i - 1].lat + t * (route[i].lat - route[i - 1].lat),
      };
    }
  }
  return { lng: route[route.length - 1].lng, lat: route[route.length - 1].lat };
}

/** Compute heading change (degrees) at vertex i */
function angleDeg(coords: number[][], i: number): number {
  if (i <= 0 || i >= coords.length - 1) return 0;
  const [ax, ay] = [coords[i][0] - coords[i - 1][0], coords[i][1] - coords[i - 1][1]];
  const [bx, by] = [coords[i + 1][0] - coords[i][0], coords[i + 1][1] - coords[i][1]];
  const dot = ax * bx + ay * by;
  const cross = ax * by - ay * bx;
  return Math.abs(Math.atan2(cross, dot) * (180 / Math.PI));
}

/** Count sharp turns (>60°) between two cumKm positions */
function countSharpTurns(route: RouteCoord[], coords: number[][], fromKm: number, toKm: number): number {
  let count = 0;
  for (let i = 1; i < route.length - 1; i++) {
    if (route[i].cumKm >= fromKm && route[i].cumKm <= toKm) {
      if (angleDeg(coords, i) > 60) count++;
    }
  }
  return count;
}

/** Estimate road accessibility score 0–1 based on curvature */
function roadScore(sharpTurns: number, segLenKm: number): number {
  if (segLenKm <= 0) return 0.5;
  const turnsPerKm = sharpTurns / segLenKm;
  if (turnsPerKm > 8) return 0.2;
  if (turnsPerKm > 4) return 0.4;
  if (turnsPerKm > 2) return 0.6;
  if (turnsPerKm > 1) return 0.8;
  return 1.0;
}

/* ═══════════════════════════════════════════════════════════════
 *  CORE OPTIMIZER — GREEDY + SCORING
 * ═══════════════════════════════════════════════════════════════ */

interface OptimizeParams {
  routeCoords: number[][];
  busSize: BusSize;
  targetInterStopKm: number | null;     // user override
  maxStops: number;
  radiusKm: number;                      // coverage radius (default 0.4km)
  populationRows: { centroidLng: number; centroidLat: number; population: number }[];
  poiRows: { category: string; name: string | null; lng: number; lat: number }[];
  existingStops: { stopId: string; stopName: string; lat: number; lng: number }[];
  intermodalHubs: { name: string; lat: number; lng: number }[];
}

function optimizeStopPlacement(params: OptimizeParams): {
  suggestedStops: SuggestedStop[];
  segments: RouteSegmentAnalysis[];
  summary: {
    totalLengthKm: number;
    suggestedStopsCount: number;
    avgInterStopKm: number;
    totalPopCoverage: number;
    totalPoiCoverage: number;
    recommendedBusSize: BusSize;
    busRecommendationReason: string;
  };
} {
  const { routeCoords, busSize, targetInterStopKm, maxStops, radiusKm, populationRows, poiRows, existingStops, intermodalHubs } = params;
  const profile = BUS_PROFILES[busSize];
  const route = buildRouteCumDist(routeCoords);
  const totalKm = route[route.length - 1].cumKm;

  // --- Step 1: Segment analysis (divide route into 200m segments) ---
  const segLen = 0.2; // km
  const segments: RouteSegmentAnalysis[] = [];
  for (let km = 0; km < totalKm; km += segLen) {
    const endKm = Math.min(km + segLen, totalKm);
    const midPt = interpolateAt(route, (km + endKm) / 2);

    // Population in corridor
    let pop = 0;
    for (const c of populationRows) {
      if (haversineKm(midPt.lat, midPt.lng, c.centroidLat, c.centroidLng) <= radiusKm) {
        pop += c.population;
      }
    }

    // POI count
    let poiCnt = 0;
    for (const p of poiRows) {
      if (haversineKm(midPt.lat, midPt.lng, p.lat, p.lng) <= radiusKm) poiCnt++;
    }

    // Sharp turns
    const turns = countSharpTurns(route, routeCoords, km, endKm);

    const density = pop / (segLen * radiusKm * 2); // approx people/km²
    const demand: "high" | "medium" | "low" =
      density > 2000 || poiCnt >= 3 ? "high" :
      density > 500 || poiCnt >= 1 ? "medium" : "low";

    segments.push({
      fromKm: +km.toFixed(3), toKm: +endKm.toFixed(3),
      popDensity: Math.round(density),
      poiCount: poiCnt,
      sharpTurns: turns,
      avgCurvature: turns * 60 / Math.max(0.01, endKm - km), // rough deg/km
      estimatedDemand: demand,
    });
  }

  // --- Step 2: Build demand profile along route (scoring every 50m) ---
  const sampleStep = 0.05; // km
  interface Sample { km: number; demandScore: number; }
  const samples: Sample[] = [];
  for (let km = 0; km <= totalKm; km += sampleStep) {
    const pt = interpolateAt(route, km);
    let score = 0;

    // Population contribution (max 50 points)
    let pop = 0;
    for (const c of populationRows) {
      const d = haversineKm(pt.lat, pt.lng, c.centroidLat, c.centroidLng);
      if (d <= radiusKm) pop += c.population * (1 - d / radiusKm);
    }
    score += Math.min(50, pop / 20);

    // POI contribution (max 30 points)
    let poiScore = 0;
    for (const p of poiRows) {
      const d = haversineKm(pt.lat, pt.lng, p.lat, p.lng);
      if (d <= radiusKm) {
        const catWeight = (p.category === "hospital" || p.category === "school") ? 3 :
          (p.category === "office" || p.category === "industrial") ? 2 : 1;
        poiScore += catWeight * (1 - d / radiusKm);
      }
    }
    score += Math.min(30, poiScore * 3);

    // Intermodal hub bonus (max 10 points)
    for (const hub of intermodalHubs) {
      const d = haversineKm(pt.lat, pt.lng, hub.lat, hub.lng);
      if (d <= 0.5) score += 10 * (1 - d / 0.5);
    }

    // Existing stop proximity bonus (max 10 points) — prefer placing near existing stops
    for (const es of existingStops) {
      const d = haversineKm(pt.lat, pt.lng, es.lat, es.lng);
      if (d <= 0.15) score += 10 * (1 - d / 0.15);
    }

    samples.push({ km: +km.toFixed(3), demandScore: Math.min(100, Math.round(score)) });
  }

  // --- Step 3: Place stops using greedy algorithm ---
  const idealSpacing = targetInterStopKm ?? (profile.idealInterStopKm.min + profile.idealInterStopKm.max) / 2;
  const minSpacing = profile.idealInterStopKm.min;
  const maxSpacing = profile.idealInterStopKm.max * 1.2;

  // Always place first and last stop
  const stopKms: number[] = [0];

  // Greedy: walk along route, place stops at demand peaks respecting spacing
  let lastStopKm = 0;
  while (lastStopKm < totalKm - minSpacing * 0.5 && stopKms.length < maxStops) {
    const searchFrom = lastStopKm + minSpacing;
    const searchTo = Math.min(lastStopKm + maxSpacing, totalKm);

    if (searchFrom >= totalKm) break;

    // Find best demand peak in window
    let bestKm = lastStopKm + idealSpacing;
    let bestScore = -1;
    for (const s of samples) {
      if (s.km >= searchFrom && s.km <= searchTo && s.demandScore > bestScore) {
        bestScore = s.demandScore;
        bestKm = s.km;
      }
    }

    // Snap to nearest high-demand if available
    bestKm = Math.min(bestKm, totalKm);
    stopKms.push(bestKm);
    lastStopKm = bestKm;
  }

  // Ensure last stop
  if (stopKms[stopKms.length - 1] < totalKm - 0.1) {
    stopKms.push(totalKm);
  }

  // --- Step 4: Enrich each stop with detailed info ---
  const suggestedStops: SuggestedStop[] = stopKms.map((km, idx) => {
    const pt = interpolateAt(route, km);
    const reasons: string[] = [];
    const warnings: string[] = [];

    // Population coverage
    let popCov = 0;
    for (const c of populationRows) {
      if (haversineKm(pt.lat, pt.lng, c.centroidLat, c.centroidLng) <= radiusKm) {
        popCov += c.population;
      }
    }

    // Nearby POI
    const nearbyPoi: SuggestedStop["poiNearby"] = [];
    for (const p of poiRows) {
      const d = haversineKm(pt.lat, pt.lng, p.lat, p.lng);
      if (d <= radiusKm) {
        nearbyPoi.push({ category: p.category, name: p.name, distM: Math.round(d * 1000) });
      }
    }
    nearbyPoi.sort((a, b) => a.distM - b.distM);

    // Existing stops nearby
    let closestExisting: SuggestedStop["existingStopNearby"] = null;
    for (const es of existingStops) {
      const d = haversineKm(pt.lat, pt.lng, es.lat, es.lng);
      if (d <= 0.3 && (!closestExisting || d * 1000 < closestExisting.distM)) {
        closestExisting = { stopId: es.stopId, name: es.stopName, distM: Math.round(d * 1000) };
      }
    }

    // Road analysis for this segment
    const halfWindow = 0.15; // km
    const turns = countSharpTurns(route, routeCoords, km - halfWindow, km + halfWindow);
    const rScore = roadScore(turns, halfWindow * 2);

    // Bus size recommendation per stop
    const canStandard = rScore >= 0.6;
    const canMidi = rScore >= 0.35;
    const recommended: BusSize = canStandard ? "standard" : canMidi ? "midi" : "minibus";

    // Scoring
    let score = 0;
    if (popCov > 200) { score += 30; reasons.push(`${popCov} abitanti entro ${radiusKm * 1000}m`); }
    else if (popCov > 50) { score += 15; reasons.push(`${popCov} abitanti nelle vicinanze`); }
    else { warnings.push("Bassa densità abitativa"); }

    if (nearbyPoi.length >= 3) { score += 25; reasons.push(`${nearbyPoi.length} POI nelle vicinanze`); }
    else if (nearbyPoi.length >= 1) { score += 12; reasons.push(`${nearbyPoi.length} POI`); }

    const hasMajorPoi = nearbyPoi.some(p =>
      ["hospital", "school", "office", "transit"].includes(p.category) && p.distM < 300);
    if (hasMajorPoi) { score += 15; reasons.push("Servizio essenziale vicino (sanità/scuola/uffici)"); }

    if (closestExisting && closestExisting.distM < 150) {
      score += 10; reasons.push(`Fermata esistente "${closestExisting.name}" a ${closestExisting.distM}m`);
    }

    if (idx === 0) reasons.push("Capolinea partenza");
    if (idx === stopKms.length - 1) reasons.push("Capolinea arrivo");

    // Road warnings
    if (!canStandard && busSize === "standard") {
      warnings.push(`Strada stretta/curva — bus 12m sconsigliato (${turns} curve strette). Consigliato: ${BUS_PROFILES[recommended].label}`);
    }
    if (turns >= 3) {
      warnings.push(`${turns} curve strette nel raggio di 150m`);
    }

    // Inter-stop spacing check
    if (idx > 0) {
      const gap = km - stopKms[idx - 1];
      if (gap < minSpacing * 0.8) warnings.push(`Spaziatura ridotta (${(gap * 1000).toFixed(0)}m) — fermate troppo vicine`);
      if (gap > maxSpacing) warnings.push(`Gap ampio (${(gap * 1000).toFixed(0)}m) — valutare fermata intermedia`);
    }

    score = Math.min(100, Math.max(0, score + rScore * 20));

    return {
      lng: +pt.lng.toFixed(6),
      lat: +pt.lat.toFixed(6),
      cumKm: +km.toFixed(3),
      score: Math.round(score),
      reason: reasons,
      warnings,
      popCoverage: popCov,
      poiNearby: nearbyPoi.slice(0, 10),
      existingStopNearby: closestExisting,
      busAccess: {
        recommended,
        canStandard,
        canMidi,
        sharpTurns: turns,
        estimatedRoadScore: +rScore.toFixed(2),
      },
    };
  });

  // --- Step 5: Global bus size recommendation ---
  const avgRoadScore = suggestedStops.reduce((s, st) => s + st.busAccess.estimatedRoadScore, 0) / Math.max(1, suggestedStops.length);
  const totalPop = suggestedStops.reduce((s, st) => s + st.popCoverage, 0);
  const highDemandPct = segments.filter(s => s.estimatedDemand === "high").length / Math.max(1, segments.length);

  let recommendedBusSize: BusSize;
  let busReason: string;
  if (avgRoadScore < 0.35) {
    recommendedBusSize = "minibus";
    busReason = "Percorso con molte curve strette — solo minibus (6m) praticabile";
  } else if (avgRoadScore < 0.6 || totalPop < 500) {
    recommendedBusSize = "midi";
    busReason = avgRoadScore < 0.6
      ? "Tratti stretti lungo il percorso — midibus (8m) consigliato"
      : "Domanda bassa — midibus (8m) più efficiente";
  } else if (highDemandPct > 0.5 && totalPop > 3000) {
    recommendedBusSize = "standard";
    busReason = `Alta affluenza prevista (${totalPop} abitanti, ${Math.round(highDemandPct * 100)}% tratti ad alta domanda) — bus standard (12m)`;
  } else {
    recommendedBusSize = "midi";
    busReason = "Domanda media — midibus (8m) è il miglior compromesso capacità/manovrabilità";
  }

  // Avg inter-stop
  const gaps = suggestedStops.slice(1).map((s, i) => s.cumKm - suggestedStops[i].cumKm);
  const avgGap = gaps.length > 0 ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0;
  const totalPoiCov = new Set(suggestedStops.flatMap(s => s.poiNearby.map(p => `${p.category}:${p.name}:${p.distM}`))).size;

  return {
    suggestedStops,
    segments,
    summary: {
      totalLengthKm: +totalKm.toFixed(2),
      suggestedStopsCount: suggestedStops.length,
      avgInterStopKm: +avgGap.toFixed(3),
      totalPopCoverage: totalPop,
      totalPoiCoverage: totalPoiCov,
      recommendedBusSize,
      busRecommendationReason: busReason,
    },
  };
}

/* ═══════════════════════════════════════════════════════════════
 *  ROUTES
 * ═══════════════════════════════════════════════════════════════ */

// POST /api/optimizer/route-placement — run optimization
router.post("/optimizer/route-placement", strictLimiter, async (req, res) => {
  try {
    const {
      scenarioId,
      busSize = "standard",
      targetInterStopKm = null,
      maxStops = 40,
      radiusKm = 0.4,
    } = req.body as {
      scenarioId: string;
      busSize?: BusSize;
      targetInterStopKm?: number | null;
      maxStops?: number;
      radiusKm?: number;
    };

    if (!scenarioId) {
      res.status(400).json({ error: "scenarioId obbligatorio" }); return;
    }

    // 1. Load scenario
    const [scenario] = await db.select().from(scenarios).where(eq(scenarios.id, scenarioId)).limit(1);
    if (!scenario) { res.status(404).json({ error: "Scenario non trovato" }); return; }

    const geojson = scenario.geojson as any;
    const features = geojson?.features || [];

    // Extract first LineString as the route
    const routeFeature = features.find((f: any) =>
      f.geometry?.type === "LineString" || f.geometry?.type === "MultiLineString"
    );
    if (!routeFeature) {
      res.status(400).json({ error: "Lo scenario non contiene un percorso (LineString)" }); return;
    }

    const routeCoords: number[][] = routeFeature.geometry.type === "MultiLineString"
      ? routeFeature.geometry.coordinates.flat()
      : routeFeature.geometry.coordinates;

    if (routeCoords.length < 2) {
      res.status(400).json({ error: "Percorso troppo corto (meno di 2 punti)" }); return;
    }

    // 2. Load context data in parallel
    const [popRows, poiRows, gtfsStopsAll] = await Promise.all([
      db.select({
        centroidLng: censusSections.centroidLng,
        centroidLat: censusSections.centroidLat,
        population: censusSections.population,
      }).from(censusSections).where(sql`${censusSections.population} > 0`),

      db.select({
        category: pointsOfInterest.category,
        name: pointsOfInterest.name,
        lng: pointsOfInterest.lng,
        lat: pointsOfInterest.lat,
      }).from(pointsOfInterest),

      db.select({
        stopId: gtfsStops.stopId,
        stopName: gtfsStops.stopName,
        lat: gtfsStops.stopLat,
        lng: gtfsStops.stopLon,
      }).from(gtfsStops),
    ]);

    // Filter to stops/pop/poi within ~2km corridor of the route bounding box
    const lngs = routeCoords.map(c => c[0]);
    const lats = routeCoords.map(c => c[1]);
    const bbox = {
      minLng: Math.min(...lngs) - 0.025,
      maxLng: Math.max(...lngs) + 0.025,
      minLat: Math.min(...lats) - 0.02,
      maxLat: Math.max(...lats) + 0.02,
    };

    const nearPop = popRows.filter(r =>
      r.centroidLng >= bbox.minLng && r.centroidLng <= bbox.maxLng &&
      r.centroidLat >= bbox.minLat && r.centroidLat <= bbox.maxLat
    );
    const nearPoi = poiRows.filter(r =>
      r.lng >= bbox.minLng && r.lng <= bbox.maxLng &&
      r.lat >= bbox.minLat && r.lat <= bbox.maxLat
    );
    const nearStops = gtfsStopsAll
      .map(s => ({ stopId: s.stopId, stopName: s.stopName || "", lat: Number(s.lat), lng: Number(s.lng) }))
      .filter(s =>
        s.lng >= bbox.minLng && s.lng <= bbox.maxLng &&
        s.lat >= bbox.minLat && s.lat <= bbox.maxLat
      );

    // Intermodal hubs (hardcoded list)
    const intermodalHubs = [
      { name: "Stazione FS Ancona", lat: 43.607348, lng: 13.49776447 },
      { name: "Stazione FS Falconara", lat: 43.6301852, lng: 13.39739496 },
      { name: "Porto Ancona", lat: 43.61864036, lng: 13.50938321 },
      { name: "Aeroporto Falconara", lat: 43.61632, lng: 13.36244 },
      { name: "Stazione Torrette", lat: 43.60393, lng: 13.45299 },
      { name: "Stazione Palombina", lat: 43.61802912, lng: 13.42590525 },
    ];

    // 3. Run optimizer
    const result = optimizeStopPlacement({
      routeCoords,
      busSize: busSize as BusSize,
      targetInterStopKm,
      maxStops,
      radiusKm,
      populationRows: nearPop,
      poiRows: nearPoi,
      existingStops: nearStops,
      intermodalHubs,
    });

    res.json({
      scenario: { id: scenario.id, name: scenario.name, color: scenario.color },
      busProfiles: BUS_PROFILES,
      selectedBusSize: busSize,
      ...result,
    });
  } catch (err: any) {
    req.log.error(err, "Error in route optimizer");
    res.status(500).json({ error: "Errore nell'ottimizzatore percorso" });
  }
});

// GET /api/optimizer/bus-profiles — bus size reference info
router.get("/optimizer/bus-profiles", cache({ ttlSeconds: 3600 }), (_req, res) => {
  res.json(BUS_PROFILES);
});

export default router;
