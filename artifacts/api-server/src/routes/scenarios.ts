import { Router, type IRouter } from "express";
import multer from "multer";
import AdmZip from "adm-zip";
import { db } from "@workspace/db";
import { scenarios, pointsOfInterest, censusSections } from "@workspace/db/schema";
import { eq, sql } from "drizzle-orm";
import { haversineKm, lineLength, pointToLineDistance } from "../lib/geo-utils";

const router: IRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

interface GeoJSONFeature { type: "Feature"; geometry: any; properties: Record<string, any>; }
interface GeoJSONFeatureCollection { type: "FeatureCollection"; features: GeoJSONFeature[]; }

// ─── KML → GeoJSON converter (minimal, no external deps) ──────────────
function parseKMLToGeoJSON(kmlString: string): GeoJSONFeatureCollection {
  const features: GeoJSONFeature[] = [];

  // Extract all Placemark elements
  const placemarkRegex = /<Placemark[^>]*>([\s\S]*?)<\/Placemark>/gi;
  let match: RegExpExecArray | null;

  while ((match = placemarkRegex.exec(kmlString)) !== null) {
    const block = match[1];

    // Extract name
    const nameMatch = block.match(/<name>([\s\S]*?)<\/name>/i);
    const name = nameMatch ? nameMatch[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/, "$1").trim() : "";

    // Extract description
    const descMatch = block.match(/<description>([\s\S]*?)<\/description>/i);
    const description = descMatch ? descMatch[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/, "$1").trim() : "";

    // Extract style color
    const colorMatch = block.match(/<color>([a-fA-F0-9]{8})<\/color>/i);
    let color: string | undefined;
    if (colorMatch) {
      // KML color is aabbggrr → convert to #rrggbb
      const c = colorMatch[1];
      color = `#${c.slice(6, 8)}${c.slice(4, 6)}${c.slice(2, 4)}`;
    }

    // Parse coordinates helper
    const parseCoords = (coordStr: string): number[][] => {
      return coordStr
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map(c => {
          const [lng, lat, alt] = c.split(",").map(Number);
          return alt ? [lng, lat, alt] : [lng, lat];
        })
        .filter(c => !isNaN(c[0]) && !isNaN(c[1]));
    };

    // Try LineString
    const lineMatch = block.match(/<LineString[^>]*>[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>[\s\S]*?<\/LineString>/i);
    if (lineMatch) {
      const coords = parseCoords(lineMatch[1]);
      if (coords.length >= 2) {
        features.push({
          type: "Feature",
          geometry: { type: "LineString", coordinates: coords },
          properties: { name, description, color, featureType: "route" },
        });
      }
      continue;
    }

    // Try MultiGeometry with LineStrings
    const multiGeoMatch = block.match(/<MultiGeometry>([\s\S]*?)<\/MultiGeometry>/i);
    if (multiGeoMatch) {
      const lineStrings: number[][][] = [];
      const innerLineRegex = /<LineString[^>]*>[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>[\s\S]*?<\/LineString>/gi;
      let lm: RegExpExecArray | null;
      while ((lm = innerLineRegex.exec(multiGeoMatch[1])) !== null) {
        const coords = parseCoords(lm[1]);
        if (coords.length >= 2) lineStrings.push(coords);
      }
      if (lineStrings.length > 0) {
        features.push({
          type: "Feature",
          geometry: lineStrings.length === 1
            ? { type: "LineString", coordinates: lineStrings[0] }
            : { type: "MultiLineString", coordinates: lineStrings },
          properties: { name, description, color, featureType: "route" },
        });
      }
      // Also check for Points in MultiGeometry
      const innerPointRegex = /<Point[^>]*>[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>[\s\S]*?<\/Point>/gi;
      let pm: RegExpExecArray | null;
      while ((pm = innerPointRegex.exec(multiGeoMatch[1])) !== null) {
        const coords = parseCoords(pm[1]);
        if (coords.length === 1) {
          features.push({
            type: "Feature",
            geometry: { type: "Point", coordinates: coords[0] },
            properties: { name, description, color, featureType: "stop" },
          });
        }
      }
      continue;
    }

    // Try Polygon
    const polyMatch = block.match(/<Polygon[^>]*>[\s\S]*?<outerBoundaryIs>[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>[\s\S]*?<\/outerBoundaryIs>[\s\S]*?<\/Polygon>/i);
    if (polyMatch) {
      const coords = parseCoords(polyMatch[1]);
      if (coords.length >= 4) {
        features.push({
          type: "Feature",
          geometry: { type: "Polygon", coordinates: [coords] },
          properties: { name, description, color, featureType: "area" },
        });
      }
      continue;
    }

    // Try Point
    const pointMatch = block.match(/<Point[^>]*>[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>[\s\S]*?<\/Point>/i);
    if (pointMatch) {
      const coords = parseCoords(pointMatch[1]);
      if (coords.length >= 1) {
        features.push({
          type: "Feature",
          geometry: { type: "Point", coordinates: coords[0] },
          properties: { name, description, color, featureType: "stop" },
        });
      }
    }
  }

  return { type: "FeatureCollection", features };
}

// Extract KML string from buffer — handles both plain KML and KMZ (zip)
function extractKML(buffer: Buffer, filename: string): string {
  const ext = filename.toLowerCase();
  if (ext.endsWith(".kmz")) {
    const zip = new AdmZip(buffer);
    const kmlEntry = zip.getEntries().find(e => e.entryName.toLowerCase().endsWith(".kml"));
    if (!kmlEntry) throw new Error("Nessun file KML trovato nell'archivio KMZ");
    return kmlEntry.getData().toString("utf-8");
  }
  return buffer.toString("utf-8");
}

// ─── Geometry helpers (haversineKm, lineLength, pointToLineDistance imported from geo-utils) ──

// Ray-casting point-in-polygon
function pointInPolygon(px: number, py: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

// ─── ISTAT commune code → name mapping (Province of Ancona, cod. 42) ──
const COMUNE_NAMES: Record<string, string> = {
  "42001": "Agugliano", "42002": "Ancona", "42003": "Arcevia", "42004": "Barbara",
  "42005": "Belvedere Ostrense", "42006": "Camerano", "42007": "Camerata Picena",
  "42008": "Castelbellino", "42010": "Castelfidardo", "42011": "Castelleone di Suasa",
  "42012": "Castelplanio", "42013": "Cerreto d'Esi", "42014": "Chiaravalle",
  "42015": "Corinaldo", "42016": "Cupramontana", "42017": "Fabriano",
  "42018": "Falconara Marittima", "42019": "Filottrano", "42020": "Genga",
  "42021": "Jesi", "42022": "Loreto", "42023": "Maiolati Spontini",
  "42024": "Mergo", "42025": "Monsano", "42026": "Montecarotto",
  "42027": "Montemarciano", "42029": "Monte Roberto", "42030": "Monte San Vito",
  "42031": "Morro d'Alba", "42032": "Numana", "42033": "Offagna",
  "42034": "Osimo", "42035": "Ostra", "42036": "Ostra Vetere",
  "42037": "Poggio San Marcello", "42038": "Polverigi", "42040": "Rosora",
  "42041": "San Marcello", "42042": "San Paolo di Jesi", "42043": "Santa Maria Nuova",
  "42044": "Sassoferrato", "42045": "Senigallia", "42046": "Serra de' Conti",
  "42047": "Serra San Quirico", "42048": "Sirolo", "42049": "Staffolo",
  "42050": "Trecastelli",
};

function getComuneCode(istatCode: string): string {
  return istatCode.substring(0, 5);
}
function getComuneName(istatCode: string): string {
  const code = getComuneCode(istatCode);
  return COMUNE_NAMES[code] || `Comune ${code}`;
}

// ─── Scenario analysis helpers ─────────────────────────────────────────
interface ComuneStats {
  code: string;
  name: string;
  totalPop: number;
  coveredPop: number;
  percent: number;
  totalSections: number;
  coveredSections: number;
  poiTotal: number;
  poiCovered: number;
}

interface StopDistribution {
  minInterStopKm: number;
  maxInterStopKm: number;
  avgInterStopKm: number;
  medianInterStopKm: number;
  stopsWithin300m: number;   // fermate troppo vicine
  gapsOver1km: number;       // tratti senza fermate >1km
}

interface ScenarioAnalysis {
  routes: { name: string; lengthKm: number; coordinates: number[][] }[];
  stops: { name: string; lng: number; lat: number }[];
  totalLengthKm: number;
  poiCoverage: {
    radius: number;
    total: number;         // totale POI nei comuni toccati
    covered: number;
    percent: number;
    byCategory: Record<string, { total: number; covered: number }>;
  };
  populationCoverage: {
    radius: number;
    totalPop: number;      // popolazione dei soli comuni toccati
    coveredPop: number;
    percent: number;
    comuniToccati: number; // quanti comuni attraversa lo scenario
  };
  comuniDetails: ComuneStats[];
  stopDistribution: StopDistribution | null;
  accessibilityScore: number;       // 0-100 indice complessivo
  efficiencyMetrics: {
    popPerKm: number;               // abitanti serviti per km
    poiPerKm: number;               // POI serviti per km
    costIndex: number;              // lunghezza relativa rispetto alla distanza in linea d'aria
    stopsPerKm: number;             // densità fermate per km
  };
  gapAnalysis: {
    uncoveredPoi: { category: string; name: string; lng: number; lat: number; distKm: number }[];
    underservedComuni: { code: string; name: string; pop: number; coveragePercent: number }[];
  };
}

async function analyzeScenario(
  geojson: GeoJSONFeatureCollection,
  poiRows: { category: string; lng: number; lat: number; name: string | null }[],
  censusRows: { istatCode: string | null; population: number; centroidLng: number; centroidLat: number; geojson: any }[],
  radiusKm: number = 0.5,
): Promise<ScenarioAnalysis> {
  // Filter out rows without istatCode
  const validCensus = censusRows.filter(cs => cs.istatCode != null) as { istatCode: string; population: number; centroidLng: number; centroidLat: number; geojson: any }[];
  // ── Extract lines and stops from the scenario ──
  const routes: ScenarioAnalysis["routes"] = [];
  const stops: ScenarioAnalysis["stops"] = [];

  for (const f of geojson.features) {
    const props = f.properties || {};
    if (f.geometry.type === "LineString") {
      routes.push({
        name: props.name || `Percorso ${routes.length + 1}`,
        lengthKm: lineLength(f.geometry.coordinates),
        coordinates: f.geometry.coordinates,
      });
    } else if (f.geometry.type === "MultiLineString") {
      for (const line of f.geometry.coordinates) {
        routes.push({
          name: props.name || `Percorso ${routes.length + 1}`,
          lengthKm: lineLength(line),
          coordinates: line,
        });
      }
    } else if (f.geometry.type === "Point") {
      stops.push({ name: props.name || `Fermata ${stops.length + 1}`, lng: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] });
    }
  }

  const totalLengthKm = routes.reduce((s, r) => s + r.lengthKm, 0);
  const allLines = routes.map(r => r.coordinates);

  // Auto-generate stops every ~400m if none provided
  if (stops.length === 0 && allLines.length > 0) {
    for (const line of allLines) {
      let accum = 0;
      stops.push({ name: "Auto-fermata", lng: line[0][0], lat: line[0][1] });
      for (let i = 1; i < line.length; i++) {
        accum += haversineKm(line[i - 1][1], line[i - 1][0], line[i][1], line[i][0]);
        if (accum >= 0.4) {
          stops.push({ name: "Auto-fermata", lng: line[i][0], lat: line[i][1] });
          accum = 0;
        }
      }
      const last = line[line.length - 1];
      if (stops.length === 0 || haversineKm(stops[stops.length - 1].lat, stops[stops.length - 1].lng, last[1], last[0]) > 0.05) {
        stops.push({ name: "Auto-fermata", lng: last[0], lat: last[1] });
      }
    }
  }

  // ── Determine which comuni are touched ──
  // A comune is "touched" if any stop or route passes through/near its census sections
  const touchedComuniCodes = new Set<string>();

  // Build a set of sampled route vertices + stops for proximity checks (coarse: ~500m)
  const allScenarioPoints: { lng: number; lat: number }[] = [...stops];
  for (const line of allLines) {
    let accum = 0;
    allScenarioPoints.push({ lng: line[0][0], lat: line[0][1] });
    for (let i = 1; i < line.length; i++) {
      accum += haversineKm(line[i - 1][1], line[i - 1][0], line[i][1], line[i][0]);
      if (accum >= 0.5) {
        allScenarioPoints.push({ lng: line[i][0], lat: line[i][1] });
        accum = 0;
      }
    }
    const last = line[line.length - 1];
    allScenarioPoints.push({ lng: last[0], lat: last[1] });
  }

  // Compute scenario bounding box for initial filtering
  let sMinLng = Infinity, sMaxLng = -Infinity, sMinLat = Infinity, sMaxLat = -Infinity;
  for (const p of allScenarioPoints) {
    if (p.lng < sMinLng) sMinLng = p.lng;
    if (p.lng > sMaxLng) sMaxLng = p.lng;
    if (p.lat < sMinLat) sMinLat = p.lat;
    if (p.lat > sMaxLat) sMaxLat = p.lat;
  }
  // Generous bounding box (+0.03° ≈ 3km) for "touched" detection
  const scenarioBbox = {
    minLng: sMinLng - 0.03, maxLng: sMaxLng + 0.03,
    minLat: sMinLat - 0.03, maxLat: sMaxLat + 0.03,
  };

  // First pass: filter census sections by bounding box (very fast)
  const sectionComuneMap = new Map<string, string>();
  const nearbyCensus = validCensus.filter(cs => {
    const comuneCode = getComuneCode(cs.istatCode);
    sectionComuneMap.set(cs.istatCode, comuneCode);
    return cs.centroidLat >= scenarioBbox.minLat && cs.centroidLat <= scenarioBbox.maxLat &&
           cs.centroidLng >= scenarioBbox.minLng && cs.centroidLng <= scenarioBbox.maxLng;
  });

  // Second pass: for nearby sections, check centroid proximity (1.5km for "touched")
  for (const cs of nearbyCensus) {
    const comuneCode = getComuneCode(cs.istatCode);
    for (const sp of allScenarioPoints) {
      if (haversineKm(cs.centroidLat, cs.centroidLng, sp.lat, sp.lng) < 1.5) {
        touchedComuniCodes.add(comuneCode);
        break;
      }
    }
  }

  // If somehow no comuni are touched (very short route), use all comuni within 5km of centroid
  if (touchedComuniCodes.size === 0 && allScenarioPoints.length > 0) {
    const center = allScenarioPoints[Math.floor(allScenarioPoints.length / 2)];
    for (const cs of validCensus) {
      if (haversineKm(cs.centroidLat, cs.centroidLng, center.lat, center.lng) < 5.0) {
        touchedComuniCodes.add(getComuneCode(cs.istatCode));
      }
    }
  }

  // Filter census and POI to only touched comuni
  const relevantCensus = validCensus.filter(cs => touchedComuniCodes.has(getComuneCode(cs.istatCode)));

  // Build bounding box of scenario for POI filtering (generous: +0.03° ≈ 3km)
  let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const p of allScenarioPoints) {
    if (p.lng < minLng) minLng = p.lng;
    if (p.lng > maxLng) maxLng = p.lng;
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
  }
  const bbox = { minLng: minLng - 0.03, maxLng: maxLng + 0.03, minLat: minLat - 0.03, maxLat: maxLat + 0.03 };

  // Filter POI to bounding box of touched area
  const relevantPoi = poiRows.filter(p =>
    p.lng >= bbox.minLng && p.lng <= bbox.maxLng && p.lat >= bbox.minLat && p.lat <= bbox.maxLat
  );

  // ── POI coverage ──
  // Primary: distance from STOPS (people walk to stops to take the bus)
  // Secondary: distance from route lines (slightly larger than radius for visibility but not coverage)
  const byCategory: Record<string, { total: number; covered: number }> = {};
  let totalPoi = 0, coveredPoi = 0;
  const uncoveredPoiList: ScenarioAnalysis["gapAnalysis"]["uncoveredPoi"] = [];

  for (const poi of relevantPoi) {
    if (!byCategory[poi.category]) byCategory[poi.category] = { total: 0, covered: 0 };
    byCategory[poi.category].total++;
    totalPoi++;

    // Primary: distance from nearest stop (this is what matters — people walk to stops)
    let minStopDist = Infinity;
    for (const stop of stops) {
      const d = haversineKm(poi.lat, poi.lng, stop.lat, stop.lng);
      if (d < minStopDist) minStopDist = d;
      if (d <= radiusKm) break; // early exit
    }

    // Secondary: distance from route line (with a slightly smaller effective radius)
    let minLineDist = Infinity;
    for (const line of allLines) {
      const d = pointToLineDistance(poi.lng, poi.lat, line);
      if (d < minLineDist) minLineDist = d;
    }

    // A POI is covered if within radius of a stop OR within 80% of radius from route
    const isCovered = minStopDist <= radiusKm || minLineDist <= radiusKm * 0.8;
    const effectiveDist = Math.min(minStopDist, minLineDist);

    if (isCovered) {
      coveredPoi++;
      byCategory[poi.category].covered++;
    } else {
      // Track uncovered important POIs (within reasonable distance, not all)
      const criticalCategories = ["hospital", "school", "elderly", "transit"];
      if (criticalCategories.includes(poi.category) && effectiveDist <= radiusKm * 4) {
        uncoveredPoiList.push({
          category: poi.category,
          name: poi.name || poi.category,
          lng: poi.lng,
          lat: poi.lat,
          distKm: Math.round(effectiveDist * 100) / 100,
        });
      }
    }
  }
  // Sort uncovered by distance, limit to top 15
  uncoveredPoiList.sort((a, b) => a.distKm - b.distKm);
  const topUncoveredPoi = uncoveredPoiList.slice(0, 15);

  // ── Population coverage per comune (ISTAT sezioni censuarie) ──
  // A census section is "covered" if:
  //   1) Any stop is within radius of its centroid, OR
  //   2) The route passes through the census polygon (point-in-polygon), OR
  //   3) The centroid is within radius of the route line
  // We use a proportional model: for large sections only partially covered,
  // we weight the population by the proximity factor.
  const comuneAggregates = new Map<string, { totalPop: number; coveredPop: number; totalSections: number; coveredSections: number; poiTotal: number; poiCovered: number }>();

  for (const code of touchedComuniCodes) {
    comuneAggregates.set(code, { totalPop: 0, coveredPop: 0, totalSections: 0, coveredSections: 0, poiTotal: 0, poiCovered: 0 });
  }

  // POI counts per comune (approximate by nearest census section centroid)
  for (const poi of relevantPoi) {
    let nearestCode = "";
    let nearestDist = Infinity;
    for (const cs of relevantCensus) {
      const d = haversineKm(poi.lat, poi.lng, cs.centroidLat, cs.centroidLng);
      if (d < nearestDist) { nearestDist = d; nearestCode = getComuneCode(cs.istatCode); }
    }
    if (nearestCode && comuneAggregates.has(nearestCode)) {
      comuneAggregates.get(nearestCode)!.poiTotal++;
    }
  }
  for (const poi of relevantPoi) {
    let minStopDist = Infinity;
    for (const stop of stops) { const d = haversineKm(poi.lat, poi.lng, stop.lat, stop.lng); if (d < minStopDist) minStopDist = d; }
    let minLineDist = Infinity;
    for (const line of allLines) { const d = pointToLineDistance(poi.lng, poi.lat, line); if (d < minLineDist) minLineDist = d; }
    if (minStopDist <= radiusKm || minLineDist <= radiusKm * 0.8) {
      let nearestCode = "";
      let nearestCodeDist = Infinity;
      for (const cs of relevantCensus) {
        const d = haversineKm(poi.lat, poi.lng, cs.centroidLat, cs.centroidLng);
        if (d < nearestCodeDist) { nearestCodeDist = d; nearestCode = getComuneCode(cs.istatCode); }
      }
      if (nearestCode && comuneAggregates.has(nearestCode)) {
        comuneAggregates.get(nearestCode)!.poiCovered++;
      }
    }
  }

  let totalPop = 0, coveredPop = 0;
  for (const cs of relevantCensus) {
    const code = getComuneCode(cs.istatCode);
    const agg = comuneAggregates.get(code);
    if (!agg) continue;

    agg.totalPop += cs.population;
    agg.totalSections++;
    totalPop += cs.population;

    // Check 1: Distance from nearest stop (primary — people walk to stops)
    let minStopDist = Infinity;
    for (const stop of stops) {
      const d = haversineKm(cs.centroidLat, cs.centroidLng, stop.lat, stop.lng);
      if (d < minStopDist) minStopDist = d;
      if (d <= radiusKm) break; // early exit
    }

    // Check 2: Distance from route line
    let minLineDist = Infinity;
    for (const line of allLines) {
      const d = pointToLineDistance(cs.centroidLng, cs.centroidLat, line);
      if (d < minLineDist) minLineDist = d;
    }

    // Determine coverage with proportional model
    // Fully covered: centroid within radius of a stop or route line
    // Partially covered: centroid within 1.5x radius (fading)
    const effectiveDist = Math.min(minStopDist, minLineDist);
    const isFullyCovered = effectiveDist <= radiusKm;
    const isPartiallyCovered = !isFullyCovered && effectiveDist <= radiusKm * 1.5;

    if (isFullyCovered) {
      coveredPop += cs.population;
      agg.coveredPop += cs.population;
      agg.coveredSections++;
    } else if (isPartiallyCovered) {
      // Proportional: fade from 60% to 0% between radius and 1.5x radius
      const factor = Math.max(0, 1 - ((effectiveDist - radiusKm) / (radiusKm * 0.5)));
      const partialPop = Math.round(cs.population * factor * 0.6);
      coveredPop += partialPop;
      agg.coveredPop += partialPop;
      if (factor > 0.3) agg.coveredSections++;
    }
  }

  const comuniDetails: ComuneStats[] = Array.from(comuneAggregates.entries())
    .map(([code, agg]) => ({
      code,
      name: COMUNE_NAMES[code] || `Comune ${code}`,
      totalPop: agg.totalPop,
      coveredPop: agg.coveredPop,
      percent: agg.totalPop > 0 ? Math.round((agg.coveredPop / agg.totalPop) * 100) : 0,
      totalSections: agg.totalSections,
      coveredSections: agg.coveredSections,
      poiTotal: agg.poiTotal,
      poiCovered: agg.poiCovered,
    }))
    .filter(c => c.totalPop > 0)
    .sort((a, b) => b.totalPop - a.totalPop);

  // Underserved comuni (touched but low coverage)
  const underservedComuni = comuniDetails
    .filter(c => c.percent < 30 && c.totalPop > 500)
    .map(c => ({ code: c.code, name: c.name, pop: c.totalPop, coveragePercent: c.percent }));

  // ── Stop distribution analysis ──
  let stopDistribution: StopDistribution | null = null;
  if (stops.length >= 2) {
    // Compute inter-stop distances along routes
    const interStopDists: number[] = [];
    for (const route of routes) {
      const routeStops = stops
        .map(s => {
          const d = pointToLineDistance(s.lng, s.lat, route.coordinates);
          return { ...s, dist: d };
        })
        .filter(s => s.dist < 0.5) // within 500m of route
        .sort((a, b) => {
          const projA = projectOnRoute(a.lng, a.lat, route.coordinates);
          const projB = projectOnRoute(b.lng, b.lat, route.coordinates);
          return projA - projB;
        });

      for (let i = 1; i < routeStops.length; i++) {
        const d = haversineKm(routeStops[i - 1].lat, routeStops[i - 1].lng, routeStops[i].lat, routeStops[i].lng);
        if (d > 0.05) interStopDists.push(d); // ignore <50m duplicates (auto-generated stops)
      }
    }

    if (interStopDists.length > 0) {
      interStopDists.sort((a, b) => a - b);
      stopDistribution = {
        minInterStopKm: Math.round(interStopDists[0] * 1000) / 1000,
        maxInterStopKm: Math.round(interStopDists[interStopDists.length - 1] * 1000) / 1000,
        avgInterStopKm: Math.round((interStopDists.reduce((s, d) => s + d, 0) / interStopDists.length) * 1000) / 1000,
        medianInterStopKm: Math.round(interStopDists[Math.floor(interStopDists.length / 2)] * 1000) / 1000,
        stopsWithin300m: interStopDists.filter(d => d < 0.15).length, // very close stops (<150m)
        gapsOver1km: interStopDists.filter(d => d > 1.0).length,
      };
    }
  }

  // ── Efficiency metrics ──
  // For bus routes, costIndex = route length / straight line is not useful (always high)
  // Instead, compute service area per km (more meaningful)
  const efficiencyMetrics = {
    popPerKm: totalLengthKm > 0 ? Math.round(coveredPop / totalLengthKm) : 0,
    poiPerKm: totalLengthKm > 0 ? Math.round((coveredPoi / totalLengthKm) * 10) / 10 : 0,
    costIndex: totalLengthKm > 0 && totalPop > 0 ? Math.round((coveredPop / totalPop * 100) / (totalLengthKm / 10) * 10) / 10 : 0, // % pop coperta per 10km
    stopsPerKm: totalLengthKm > 0 ? Math.round((stops.length / totalLengthKm) * 10) / 10 : 0,
  };

  // ── Accessibility score (0-100) ──
  // Weighted composite optimized for realistic bus route evaluation:
  // - 35% population coverage (most important)
  // - 30% POI coverage (service to key destinations)
  // - 20% stop distribution quality (penalize gaps, not closely-spaced stops for urban)
  // - 15% efficiency (pop served per km — higher is better)
  const popPct = totalPop > 0 ? (coveredPop / totalPop) * 100 : 0;
  const poiPct = totalPoi > 0 ? (coveredPoi / totalPoi) * 100 : 0;

  // Population score: 0-100, with bonus for >50% coverage
  const popScore = Math.min(100, popPct * 1.3);
  // POI score: 0-100, similar scaling
  const poiScore = Math.min(100, poiPct * 1.3);
  // Distribution score: penalize gaps >1km (bad), mild penalty for close stops as % of total
  // In urban networks with many overlapping routes, having stops <150m apart is common and acceptable
  // Cap penalties so distribution doesn't collapse the overall score
  const distScore = stopDistribution
    ? Math.max(0, Math.min(100, 100
        - Math.min(40, stopDistribution.gapsOver1km * 5)        // max -40 for gaps >1km
        - Math.min(20, (stopDistribution.stopsWithin300m / Math.max(1, stopDistribution.stopsWithin300m + stopDistribution.gapsOver1km + 10)) * 15)  // max -20 for close stops ratio
      ))
    : 60;
  // Efficiency: popPerKm scaled so that 500 pop/km = 100 (reasonable for urban transit)
  const effScore = Math.min(100, (efficiencyMetrics.popPerKm / 500) * 100);

  const accessibilityScore = Math.round(
    popScore * 0.35 + poiScore * 0.30 + distScore * 0.20 + effScore * 0.15
  );

  return {
    routes,
    stops,
    totalLengthKm,
    poiCoverage: {
      radius: radiusKm,
      total: totalPoi,
      covered: coveredPoi,
      percent: totalPoi > 0 ? Math.round((coveredPoi / totalPoi) * 100) : 0,
      byCategory,
    },
    populationCoverage: {
      radius: radiusKm,
      totalPop,
      coveredPop,
      percent: totalPop > 0 ? Math.round((coveredPop / totalPop) * 100) : 0,
      comuniToccati: touchedComuniCodes.size,
    },
    comuniDetails,
    stopDistribution,
    accessibilityScore,
    efficiencyMetrics,
    gapAnalysis: {
      uncoveredPoi: topUncoveredPoi,
      underservedComuni,
    },
  };
}

// Helper: project a point onto a route and return cumulative distance along route
function projectOnRoute(lng: number, lat: number, route: number[][]): number {
  let cumDist = 0;
  let bestCumDist = 0;
  let bestSegDist = Infinity;
  for (let i = 0; i < route.length - 1; i++) {
    const segLen = haversineKm(route[i][1], route[i][0], route[i + 1][1], route[i + 1][0]);
    const [ax, ay] = route[i], [bx, by] = route[i + 1];
    const dx = bx - ax, dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    let t = lenSq > 0 ? ((lng - ax) * dx + (lat - ay) * dy) / lenSq : 0;
    t = Math.max(0, Math.min(1, t));
    const cx = ax + t * dx, cy = ay + t * dy;
    const dist = haversineKm(lat, lng, cy, cx);
    if (dist < bestSegDist) {
      bestSegDist = dist;
      bestCumDist = cumDist + segLen * t;
    }
    cumDist += segLen;
  }
  return bestCumDist;
}

// ─── ROUTES ────────────────────────────────────────────────────────────

// GET /api/scenarios — list all scenarios
router.get("/scenarios", async (req, res) => {
  try {
    const rows = await db
      .select({
        id: scenarios.id,
        name: scenarios.name,
        description: scenarios.description,
        color: scenarios.color,
        stopsCount: scenarios.stopsCount,
        lengthKm: scenarios.lengthKm,
        createdAt: scenarios.createdAt,
      })
      .from(scenarios)
      .orderBy(scenarios.createdAt);

    res.json({ data: rows });
  } catch (err) {
    req.log.error(err, "Error listing scenarios");
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/scenarios/compare?ids=id1,id2&radius=0.5 — compare two scenarios
// NOTE: Must be defined BEFORE /scenarios/:id to avoid param matching
router.get("/scenarios/compare", async (req, res) => {
  try {
    const ids = ((req.query.ids as string) || "").split(",").filter(Boolean);
    if (ids.length < 2) { res.status(400).json({ error: "Servono almeno 2 scenari (ids=id1,id2)" }); return; }
    const radius = Number(req.query.radius) || 0.5;

    const scenarioRows = await db.select().from(scenarios).where(sql`${scenarios.id} IN (${sql.join(ids.map(id => sql`${id}`), sql`, `)})`);
    if (scenarioRows.length < 2) { res.status(404).json({ error: "Uno o più scenari non trovati" }); return; }

    const [poiRows, censusRows] = await Promise.all([
      db.select({ category: pointsOfInterest.category, lng: pointsOfInterest.lng, lat: pointsOfInterest.lat, name: pointsOfInterest.name }).from(pointsOfInterest),
      db.select({ istatCode: censusSections.istatCode, population: censusSections.population, centroidLng: censusSections.centroidLng, centroidLat: censusSections.centroidLat, geojson: censusSections.geojson })
        .from(censusSections).where(sql`${censusSections.population} > 0`),
    ]);

    const analyses: { scenario: { id: string; name: string; color: string }; analysis: ScenarioAnalysis }[] = [];
    for (const row of scenarioRows) {
      const analysis = await analyzeScenario(row.geojson as any, poiRows, censusRows, radius);
      analyses.push({ scenario: { id: row.id, name: row.name, color: row.color }, analysis });
    }

    // ── Compute UNIFIED population base for fair comparison ──
    // Use the UNION of all comuni touched by ANY scenario
    const allTouchedComuni = new Set<string>();
    for (const an of analyses) {
      for (const c of an.analysis.comuniDetails) {
        allTouchedComuni.add(c.code);
      }
    }

    // Calculate unified total population across all touched comuni
    let unifiedTotalPop = 0;
    const unifiedComuniPop = new Map<string, number>(); // code → totalPop
    for (const an of analyses) {
      for (const c of an.analysis.comuniDetails) {
        if (!unifiedComuniPop.has(c.code) || c.totalPop > (unifiedComuniPop.get(c.code) || 0)) {
          unifiedComuniPop.set(c.code, c.totalPop);
        }
      }
    }
    for (const pop of unifiedComuniPop.values()) {
      unifiedTotalPop += pop;
    }

    // Add unified total POI from all scenarios (union of relevant POI)
    let unifiedTotalPoi = 0;
    const allPoiCategories = new Set<string>();
    for (const an of analyses) {
      if (an.analysis.poiCoverage.total > unifiedTotalPoi) {
        unifiedTotalPoi = an.analysis.poiCoverage.total;
      }
      for (const cat of Object.keys(an.analysis.poiCoverage.byCategory)) {
        allPoiCategories.add(cat);
      }
    }

    // Recalculate percentages with unified base for fair comparison
    for (const an of analyses) {
      if (unifiedTotalPop > 0) {
        an.analysis.populationCoverage.totalPop = unifiedTotalPop;
        an.analysis.populationCoverage.percent = Math.round((an.analysis.populationCoverage.coveredPop / unifiedTotalPop) * 100);
      }
      an.analysis.populationCoverage.comuniToccati = an.analysis.comuniDetails.length;
    }

    const suggestions: string[] = [];
    const a = analyses[0], b = analyses[1];
    const aName = a.scenario.name, bName = b.scenario.name;

    // 1. Overall assessment
    const aScore = a.analysis.accessibilityScore, bScore = b.analysis.accessibilityScore;
    if (Math.abs(aScore - bScore) >= 5) {
      const better = aScore > bScore ? a : b;
      const worse = aScore <= bScore ? a : b;
      suggestions.push(`📊 "${better.scenario.name}" ha un punteggio di accessibilità complessivo migliore: ${better.analysis.accessibilityScore}/100 vs ${worse.analysis.accessibilityScore}/100.`);
    } else {
      suggestions.push(`📊 I due scenari hanno punteggi di accessibilità simili: ${aName} ${aScore}/100 vs ${bName} ${bScore}/100.`);
    }

    // 2. Length comparison
    const lenDiff = Math.abs(a.analysis.totalLengthKm - b.analysis.totalLengthKm);
    if (lenDiff > 1) {
      const shorter = a.analysis.totalLengthKm < b.analysis.totalLengthKm ? aName : bName;
      const longer = a.analysis.totalLengthKm >= b.analysis.totalLengthKm ? aName : bName;
      suggestions.push(`📏 "${shorter}" è più corto di ${lenDiff.toFixed(1)} km rispetto a "${longer}". Un percorso più breve riduce i costi operativi.`);
    }

    // 3. Population coverage (using UNIFIED base)
    const aCovPop = a.analysis.populationCoverage.coveredPop;
    const bCovPop = b.analysis.populationCoverage.coveredPop;
    const aPct = a.analysis.populationCoverage.percent;
    const bPct = b.analysis.populationCoverage.percent;
    if (aCovPop !== bCovPop) {
      const betterPop = aCovPop > bCovPop ? a : b;
      const worsePop = aCovPop <= bCovPop ? a : b;
      const popDiffAbs = Math.abs(aCovPop - bCovPop);
      const betterPct = betterPop === a ? aPct : bPct;
      const worsePct = worsePop === a ? aPct : bPct;
      suggestions.push(`👥 "${betterPop.scenario.name}" copre ${popDiffAbs.toLocaleString("it-IT")} abitanti in più (${betterPct}% vs ${worsePct}% sulla stessa base di ${unifiedTotalPop.toLocaleString("it-IT")} ab.).`);
    }

    // 4. POI coverage
    if (a.analysis.poiCoverage.percent !== b.analysis.poiCoverage.percent) {
      const betterPoi = a.analysis.poiCoverage.percent > b.analysis.poiCoverage.percent ? a : b;
      const worsePoi = a.analysis.poiCoverage.percent <= b.analysis.poiCoverage.percent ? a : b;
      suggestions.push(`📍 "${betterPoi.scenario.name}" copre il ${betterPoi.analysis.poiCoverage.percent}% dei POI vs ${worsePoi.analysis.poiCoverage.percent}% di "${worsePoi.scenario.name}" (raggio ${radius} km).`);

      const allCats = new Set([...Object.keys(a.analysis.poiCoverage.byCategory), ...Object.keys(b.analysis.poiCoverage.byCategory)]);
      const catLabels: Record<string, string> = {
        hospital: "ospedali/sanità", school: "scuole", shopping: "commercio",
        industrial: "zone industriali", office: "uffici/PA", elderly: "RSA",
        transit: "hub trasporti", worship: "luoghi di culto", leisure: "sport/svago",
        workplace: "aziende", parking: "parcheggi", tourism: "cultura/turismo",
      };
      for (const cat of allCats) {
        const ca = a.analysis.poiCoverage.byCategory[cat] || { total: 0, covered: 0 };
        const cb = b.analysis.poiCoverage.byCategory[cat] || { total: 0, covered: 0 };
        if (ca.total > 0 || cb.total > 0) {
          const pa = ca.total > 0 ? Math.round((ca.covered / ca.total) * 100) : 0;
          const pb = cb.total > 0 ? Math.round((cb.covered / cb.total) * 100) : 0;
          if (Math.abs(pa - pb) >= 20) {
            const betterName = pa > pb ? aName : bName;
            suggestions.push(`  → ${catLabels[cat] || cat}: "${betterName}" ha copertura migliore (+${Math.abs(pa - pb)}%).`);
          }
        }
      }
    }

    // 5. Comuni touched comparison
    const comuniA = new Set(a.analysis.comuniDetails.map(c => c.code));
    const comuniB = new Set(b.analysis.comuniDetails.map(c => c.code));
    const onlyA = a.analysis.comuniDetails.filter(c => !comuniB.has(c.code));
    const onlyB = b.analysis.comuniDetails.filter(c => !comuniA.has(c.code));
    if (onlyA.length > 0) suggestions.push(`🗺️ "${aName}" copre in esclusiva: ${onlyA.map(c => `${c.name} (${c.totalPop.toLocaleString("it-IT")} ab.)`).join(", ")}.`);
    if (onlyB.length > 0) suggestions.push(`🗺️ "${bName}" copre in esclusiva: ${onlyB.map(c => `${c.name} (${c.totalPop.toLocaleString("it-IT")} ab.)`).join(", ")}.`);

    // 6. Overlap analysis
    if (a.analysis.stops.length > 0 && b.analysis.stops.length > 0) {
      let sharedStops = 0;
      for (const sa of a.analysis.stops) {
        for (const sb of b.analysis.stops) {
          if (haversineKm(sa.lat, sa.lng, sb.lat, sb.lng) < 0.15) { sharedStops++; break; }
        }
      }
      const overlapPct = Math.round((sharedStops / Math.min(a.analysis.stops.length, b.analysis.stops.length)) * 100);
      if (overlapPct > 70) suggestions.push(`🔄 Alta sovrapposizione fermate (${overlapPct}%). I due scenari coprono zone simili — valutare se sono realmente alternativi.`);
      else if (overlapPct > 30) suggestions.push(`🔄 Sovrapposizione fermate media (${overlapPct}%). I due scenari hanno zone in comune ma servono anche aree diverse.`);
      else suggestions.push(`🔄 Bassa sovrapposizione fermate (${overlapPct}%). I due scenari servono zone complementari — considerare una combinazione.`);
    }

    // 7. Efficiency comparison
    const effA = a.analysis.efficiencyMetrics, effB = b.analysis.efficiencyMetrics;
    if (Math.abs(effA.popPerKm - effB.popPerKm) > 50) {
      const betterEff = effA.popPerKm > effB.popPerKm ? aName : bName;
      suggestions.push(`⚡ "${betterEff}" è più efficiente: ${Math.max(effA.popPerKm, effB.popPerKm).toLocaleString("it-IT")} abitanti serviti per km vs ${Math.min(effA.popPerKm, effB.popPerKm).toLocaleString("it-IT")}.`);
    }

    // 8. Stop distribution comparison
    if (a.analysis.stopDistribution && b.analysis.stopDistribution) {
      const dA = a.analysis.stopDistribution, dB = b.analysis.stopDistribution;
      if (dA.gapsOver1km > 0 || dB.gapsOver1km > 0) {
        const worseGaps = dA.gapsOver1km > dB.gapsOver1km ? aName : bName;
        const maxGaps = Math.max(dA.gapsOver1km, dB.gapsOver1km);
        suggestions.push(`⚠️ "${worseGaps}" ha ${maxGaps} tratti senza fermate >1 km. Valutare l'inserimento di fermate intermedie.`);
      }
    }

    // 9. Uncovered critical POI
    const criticalCats = ["hospital", "school", "elderly", "transit"];
    const catLabels2: Record<string, string> = { hospital: "ospedali/sanità", school: "scuole", elderly: "RSA", transit: "hub trasporti" };
    for (const cat of criticalCats) {
      const allUncovered = analyses.every(an => { const c = an.analysis.poiCoverage.byCategory[cat]; return !c || c.covered === 0; });
      if (allUncovered) {
        const relevantPoi = poiRows.filter(p => p.category === cat);
        if (relevantPoi.length > 0) suggestions.push(`🚨 Nessuno scenario copre i ${catLabels2[cat] || cat} (${relevantPoi.length} nell'area). Valutare deviazioni di percorso.`);
      }
    }

    // 10. Underserved comuni warnings
    for (const an of analyses) {
      if (an.analysis.gapAnalysis.underservedComuni.length > 0) {
        const names = an.analysis.gapAnalysis.underservedComuni.slice(0, 3).map(c => `${c.name} (${c.coveragePercent}%)`).join(", ");
        suggestions.push(`⚠️ "${an.scenario.name}" sotto-serve: ${names}.`);
      }
    }

    res.json({
      scenarios: analyses.map(an => ({
        ...an.scenario,
        totalLengthKm: an.analysis.totalLengthKm,
        stopsCount: an.analysis.stops.length,
        poiCoverage: an.analysis.poiCoverage,
        populationCoverage: an.analysis.populationCoverage,
        efficiency: an.analysis.efficiencyMetrics,
        accessibilityScore: an.analysis.accessibilityScore,
        comuniDetails: an.analysis.comuniDetails,
        stopDistribution: an.analysis.stopDistribution,
        gapAnalysis: an.analysis.gapAnalysis,
      })),
      suggestions, radius,
      unifiedBase: {
        totalPop: unifiedTotalPop,
        comuniCount: allTouchedComuni.size,
        comuni: Array.from(unifiedComuniPop.entries()).map(([code, pop]) => ({
          code, name: COMUNE_NAMES[code] || `Comune ${code}`, totalPop: pop,
        })).sort((a, b) => b.totalPop - a.totalPop),
      },
    });
  } catch (err) {
    req.log.error(err, "Error comparing scenarios");
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/scenarios/:id — get single scenario with geojson
router.get("/scenarios/:id", async (req, res) => {
  try {
    const [row] = await db.select().from(scenarios).where(eq(scenarios.id, req.params.id)).limit(1);
    if (!row) { res.status(404).json({ error: "Scenario non trovato" }); return; }
    res.json(row);
  } catch (err) {
    req.log.error(err, "Error fetching scenario");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/scenarios/upload — upload KML/KMZ files (stopsFile + routeFile, or single "file")
const uploadFields = upload.fields([
  { name: "stopsFile", maxCount: 1 },
  { name: "routeFile", maxCount: 1 },
  { name: "file", maxCount: 1 },       // Legacy: single file upload
]);
router.post("/scenarios/upload", uploadFields, async (req, res) => {
  try {
    const files = (req as any).files as Record<string, Express.Multer.File[]> | undefined;
    const stopsFile = files?.stopsFile?.[0];
    const routeFile = files?.routeFile?.[0];
    const singleFile = files?.file?.[0];

    // Support both modes: 2 files (stops+route) or legacy single file
    if (!stopsFile && !routeFile && !singleFile) {
      res.status(400).json({ error: "Nessun file caricato. Invia stopsFile e/o routeFile." }); return;
    }

    const defaultName = routeFile?.originalname || stopsFile?.originalname || singleFile?.originalname || "Scenario";
    const name = (req.body?.name as string) || defaultName.replace(/\.(kml|kmz)$/i, "");
    const description = (req.body?.description as string) || "";
    const color = (req.body?.color as string) || "#3b82f6";

    // Merged GeoJSON
    const mergedFeatures: GeoJSONFeature[] = [];
    const filenames: string[] = [];

    // Parse stops file — force all geometries as stops
    if (stopsFile) {
      const kml = extractKML(stopsFile.buffer, stopsFile.originalname);
      const geo = parseKMLToGeoJSON(kml);
      for (const f of geo.features) {
        // Points are stops naturally
        if (f.geometry.type === "Point") {
          f.properties.featureType = "stop";
          mergedFeatures.push(f);
        }
        // If someone puts lines in the stops file, extract vertices as stops
        else if (f.geometry.type === "LineString") {
          for (const coord of f.geometry.coordinates) {
            mergedFeatures.push({
              type: "Feature",
              geometry: { type: "Point", coordinates: coord },
              properties: { name: f.properties?.name || "Fermata", featureType: "stop" },
            });
          }
        }
      }
      filenames.push(stopsFile.originalname);
    }

    // Parse route file — force all geometries as routes
    if (routeFile) {
      const kml = extractKML(routeFile.buffer, routeFile.originalname);
      const geo = parseKMLToGeoJSON(kml);
      for (const f of geo.features) {
        if (f.geometry.type === "LineString" || f.geometry.type === "MultiLineString") {
          f.properties.featureType = "route";
          mergedFeatures.push(f);
        }
        // If someone puts points in the route file, treat as stops anyway
        else if (f.geometry.type === "Point") {
          f.properties.featureType = "stop";
          mergedFeatures.push(f);
        } else if (f.geometry.type === "Polygon") {
          f.properties.featureType = "area";
          mergedFeatures.push(f);
        }
      }
      filenames.push(routeFile.originalname);
    }

    // Legacy single file mode
    if (singleFile && !stopsFile && !routeFile) {
      const kml = extractKML(singleFile.buffer, singleFile.originalname);
      const geo = parseKMLToGeoJSON(kml);
      mergedFeatures.push(...geo.features);
      filenames.push(singleFile.originalname);
    }

    const geojson: GeoJSONFeatureCollection = { type: "FeatureCollection", features: mergedFeatures };

    if (geojson.features.length === 0) {
      res.status(400).json({ error: "Nessuna geometria trovata nei file KML/KMZ caricati" }); return;
    }

    // Compute stats
    let stopsCount = 0;
    let totalLength = 0;
    for (const f of geojson.features) {
      if (f.geometry.type === "Point") stopsCount++;
      if (f.geometry.type === "LineString") totalLength += lineLength(f.geometry.coordinates);
      if (f.geometry.type === "MultiLineString") {
        for (const line of f.geometry.coordinates) totalLength += lineLength(line);
      }
    }

    const [inserted] = await db.insert(scenarios).values({
      name,
      description,
      color,
      geojson: geojson as any,
      stopsCount,
      lengthKm: Math.round(totalLength * 100) / 100,
      metadata: {
        originalFilenames: filenames,
        featuresCount: geojson.features.length,
        stopsFromFile: !!stopsFile,
        routeFromFile: !!routeFile,
        uploadedAt: new Date().toISOString(),
      },
    }).returning();

    res.json(inserted);
  } catch (err: any) {
    req.log.error(err, "Error uploading scenario");
    res.status(400).json({ error: err.message || "Errore nel parsing del file" });
  }
});

// DELETE /api/scenarios/:id
router.delete("/scenarios/:id", async (req, res) => {
  try {
    await db.delete(scenarios).where(eq(scenarios.id, req.params.id));
    res.json({ ok: true });
  } catch (err) {
    req.log.error(err, "Error deleting scenario");
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /api/scenarios/:id — update name/description/color
router.patch("/scenarios/:id", async (req, res) => {
  try {
    const { name, description, color } = req.body;
    const updates: Record<string, any> = {};
    if (name !== undefined) updates.name = name;
    if (description !== undefined) updates.description = description;
    if (color !== undefined) updates.color = color;
    if (Object.keys(updates).length === 0) { res.status(400).json({ error: "Nessun campo da aggiornare" }); return; }

    const [updated] = await db.update(scenarios).set(updates).where(eq(scenarios.id, req.params.id)).returning();
    if (!updated) { res.status(404).json({ error: "Scenario non trovato" }); return; }
    res.json(updated);
  } catch (err) {
    req.log.error(err, "Error updating scenario");
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/scenarios/:id/analyze — analyze a single scenario (POI + pop coverage)
router.get("/scenarios/:id/analyze", async (req, res) => {
  try {
    const radius = Number(req.query.radius) || 0.5;
    const [row] = await db.select().from(scenarios).where(eq(scenarios.id, req.params.id)).limit(1);
    if (!row) { res.status(404).json({ error: "Scenario non trovato" }); return; }

    const [poiRows, censusRows] = await Promise.all([
      db.select({ category: pointsOfInterest.category, lng: pointsOfInterest.lng, lat: pointsOfInterest.lat, name: pointsOfInterest.name }).from(pointsOfInterest),
      db.select({ istatCode: censusSections.istatCode, population: censusSections.population, centroidLng: censusSections.centroidLng, centroidLat: censusSections.centroidLat, geojson: censusSections.geojson })
        .from(censusSections).where(sql`${censusSections.population} > 0`),
    ]);

    const analysis = await analyzeScenario(row.geojson as any, poiRows, censusRows, radius);
    res.json({ scenario: { id: row.id, name: row.name, color: row.color }, ...analysis });
  } catch (err) {
    req.log.error(err, "Error analyzing scenario");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
