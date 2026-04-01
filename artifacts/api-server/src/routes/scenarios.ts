import { Router, type IRouter } from "express";
import multer from "multer";
import AdmZip from "adm-zip";
import { db } from "@workspace/db";
import { scenarios, pointsOfInterest, censusSections, trafficSnapshots, scenarioServicePrograms } from "@workspace/db/schema";
import { eq, sql, desc } from "drizzle-orm";
import { haversineKm, lineLength, pointToLineDistance } from "../lib/geo-utils";

const router: IRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

interface GeoJSONFeature { type: "Feature"; geometry: any; properties: Record<string, any>; }
interface GeoJSONFeatureCollection { type: "FeatureCollection"; features: GeoJSONFeature[]; }

// ─── KML → GeoJSON converter (with Folder name inheritance) ───────────
function parseKMLToGeoJSON(kmlString: string): GeoJSONFeatureCollection {
  const features: GeoJSONFeature[] = [];

  // ── Step 1: Build a map of Folder names so Placemarks can inherit them ──
  // Scan all <Folder> open/close tags, match them with depth counting, extract names.
  interface FolderCtx { name: string; startIdx: number; endIdx: number; }
  const folders: FolderCtx[] = [];
  {
    // Collect all Folder open/close positions
    const tagRegex = /<(\/?)Folder[^>]*>/gi;
    const openStack: { idx: number; tagEnd: number }[] = [];
    let tm: RegExpExecArray | null;
    while ((tm = tagRegex.exec(kmlString)) !== null) {
      if (tm[1] === "/") {
        // Closing tag — pop the stack and create a folder entry
        const open = openStack.pop();
        if (open) {
          const folderContent = kmlString.substring(open.tagEnd, tm.index);
          // Extract the folder's direct <name> (first <name> before any nested <Folder>)
          const nextFolderIdx = folderContent.indexOf("<Folder");
          const searchIn = nextFolderIdx > 0 ? folderContent.substring(0, nextFolderIdx) : folderContent.substring(0, 500);
          const fnMatch = searchIn.match(/<name>([\s\S]*?)<\/name>/i);
          const folderName = fnMatch ? fnMatch[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/, "$1").trim() : "";
          if (folderName) {
            folders.push({ name: folderName, startIdx: open.idx, endIdx: tm.index + tm[0].length });
          }
        }
      } else {
        // Opening tag — push to stack
        openStack.push({ idx: tm.index, tagEnd: tm.index + tm[0].length });
      }
    }
  }

  /** Get the innermost Folder name for a given character position in the KML string */
  function getFolderName(charIdx: number): string {
    let best = "";
    let bestSize = Infinity;
    for (const f of folders) {
      if (charIdx >= f.startIdx && charIdx < f.endIdx) {
        const size = f.endIdx - f.startIdx;
        if (size < bestSize) { bestSize = size; best = f.name; }
      }
    }
    return best;
  }

  // ── Step 2: Extract all Placemark elements ──
  const placemarkRegex = /<Placemark[^>]*>([\s\S]*?)<\/Placemark>/gi;
  let match: RegExpExecArray | null;

  while ((match = placemarkRegex.exec(kmlString)) !== null) {
    const block = match[1];
    const placemarkPosition = match.index;

    // Extract name (Placemark's own name)
    const nameMatch = block.match(/<name>([\s\S]*?)<\/name>/i);
    const ownName = nameMatch ? nameMatch[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/, "$1").trim() : "";

    // If Placemark has no name, inherit from parent Folder
    const folderName = getFolderName(placemarkPosition);
    const name = ownName || folderName;

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


/* ═══════════════════════════════════════════════════════════════════════════
 *  PROGRAMMA DI ESERCIZIO — Auto-generated from KML scenario
 *
 *  Given a KML-based scenario (routes + stops), generate a complete
 *  service program with:
 *   - Adaptive cadence based on traffic, POI density, population density
 *   - Peak / off-peak / evening differentiation
 *   - Estimated travel times per segment using real traffic data
 *   - Trips duplicated until target km is approximately reached
 * ═══════════════════════════════════════════════════════════════════════════ */

// ── Time windows for service ──────────────────────────────────────────
interface TimeWindow { label: string; startH: number; endH: number; demandFactor: number; }

const DEFAULT_WINDOWS: TimeWindow[] = [
  { label: "mattina_punta",   startH: 6,   endH: 9,   demandFactor: 1.0 },
  { label: "mattina_morbida", startH: 9,   endH: 12,  demandFactor: 0.55 },
  { label: "pranzo",          startH: 12,  endH: 14,  demandFactor: 0.65 },
  { label: "pomeriggio_punta",startH: 14,  endH: 18,  demandFactor: 0.85 },
  { label: "sera_morbida",    startH: 18,  endH: 21,  demandFactor: 0.45 },
  { label: "sera_tarda",      startH: 21,  endH: 24,  demandFactor: 0.25 },
];

const POI_WEIGHTS: Record<string, number> = {
  hospital: 3.0, school: 2.5, university: 2.5, transit: 2.0,
  elderly: 2.0, government: 1.5, commercial: 1.5, worship: 1.0,
  sport: 1.0, culture: 1.2, park: 0.8, tourism: 1.0,
};

interface GenerateProgramConfig {
  targetKm: number;
  serviceStartH?: number;
  serviceEndH?: number;
  minCadenceMin?: number;
  maxCadenceMin?: number;
  avgSpeedKmh?: number;
  dwellTimeSec?: number;
  terminalTimeSec?: number;
  bidirectional?: boolean;
}

interface GeneratedTrip {
  tripId: string;
  lineIndex: number;
  lineName: string;
  direction: "andata" | "ritorno";
  departureTime: string;
  arrivalTime: string;
  travelTimeMin: number;
  stopTimes: { stopName: string; lng: number; lat: number; arrival: string; departure: string }[];
  timeWindow: string;
  cadenceMin: number;
}

interface LineSummary {
  lineIndex: number;
  lineName: string;
  lengthKm: number;
  stopsCount: number;
  totalTrips: number;
  totalKm: number;
  cadenceProfile: { window: string; cadenceMin: number; tripsInWindow: number }[];
  avgDemandScore: number;
  stops: { name: string; lng: number; lat: number; demandScore: number }[];
}

interface GeneratedProgram {
  routeName: string;
  routeLengthKm: number;
  totalTrips: number;
  totalKm: number;
  totalLines: number;
  serviceWindow: string;
  trips: GeneratedTrip[];
  lines: LineSummary[];
  cadenceProfile: { window: string; cadenceMin: number; tripsInWindow: number }[];
  metrics: {
    avgCadenceMin: number;
    peakCadenceMin: number;
    offPeakCadenceMin: number;
    avgTravelTimeMin: number;
    vehiclesNeeded: number;
    totalServiceHours: number;
    kmPerVehicle: number;
  };
  stops: { name: string; lng: number; lat: number; demandScore: number }[];
  coincidences: { stopName: string; lng: number; lat: number; lines: string[] }[];
}

/* ── Demand scores per stop ── */
function computeStopDemandScores(
  stops: { name: string; lng: number; lat: number }[],
  poiRows: { category: string; lng: number; lat: number; name: string | null }[],
  censusRows: { population: number; centroidLng: number; centroidLat: number }[],
  radiusKm = 0.5,
): number[] {
  return stops.map(stop => {
    let poiScore = 0;
    for (const poi of poiRows) {
      const d = haversineKm(stop.lat, stop.lng, poi.lat, poi.lng);
      if (d <= radiusKm) {
        const weight = POI_WEIGHTS[poi.category] || 1.0;
        poiScore += weight * (1 - d / radiusKm);
      }
    }
    let popScore = 0;
    for (const cs of censusRows) {
      const d = haversineKm(stop.lat, stop.lng, cs.centroidLat, cs.centroidLng);
      if (d <= radiusKm) {
        popScore += (cs.population / 1000) * (1 - d / radiusKm);
      }
    }
    return Math.round((poiScore * 0.6 + popScore * 0.4) * 100) / 100;
  });
}

/* ── Traffic profile (congestion by hour) ── */
async function getTrafficProfileForRoute(
  routeCoords: number[][],
  radiusKm = 1.0,
): Promise<Map<number, number>> {
  let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const [lng, lat] of routeCoords) {
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  const pad = radiusKm / 111;
  const bbox = { minLng: minLng - pad, maxLng: maxLng + pad, minLat: minLat - pad, maxLat: maxLat + pad };

  const rows = await db.execute<{ hour: string; avg_congestion: string }>(sql`
    SELECT
      EXTRACT(HOUR FROM captured_at)::text AS hour,
      AVG(congestion_level)::text AS avg_congestion
    FROM traffic_snapshots
    WHERE lng BETWEEN ${bbox.minLng} AND ${bbox.maxLng}
      AND lat BETWEEN ${bbox.minLat} AND ${bbox.maxLat}
    GROUP BY EXTRACT(HOUR FROM captured_at)
    ORDER BY hour
  `);

  const profile = new Map<number, number>();
  for (const r of rows.rows) {
    profile.set(parseInt(r.hour), parseFloat(r.avg_congestion) || 0);
  }
  return profile;
}

/* ── Estimate travel time with congestion ── */
function estimateTravelTime(distKm: number, baseSpeedKmh: number, congestionLevel: number): number {
  const speedFactor = Math.max(0.35, 1 - congestionLevel * 0.65);
  return (distKm / (baseSpeedKmh * speedFactor)) * 60;
}

/* ── Assign stops to nearest line ── */
function assignStopsToLines(
  allStops: { name: string; lng: number; lat: number }[],
  lines: { coords: number[][] }[],
): Map<number, { name: string; lng: number; lat: number }[]> {
  const map = new Map<number, { name: string; lng: number; lat: number }[]>();
  for (let i = 0; i < lines.length; i++) map.set(i, []);

  for (const stop of allStops) {
    let bestLine = 0;
    let bestDist = Infinity;
    for (let i = 0; i < lines.length; i++) {
      const d = pointToLineDistance(stop.lng, stop.lat, lines[i].coords);
      if (d < bestDist) { bestDist = d; bestLine = i; }
    }
    // Only assign if within 1 km of the line
    if (bestDist <= 1.0) {
      map.get(bestLine)!.push(stop);
    }
  }
  return map;
}

/* ── Order stops along a line ── */
function orderStopsAlongLine(
  stops: { name: string; lng: number; lat: number }[],
  lineCoords: number[][],
): { name: string; lng: number; lat: number }[] {
  if (stops.length <= 1) return stops;

  // For each stop, find its projection position along the line (0..1)
  const stopWithPosition = stops.map(s => {
    let bestT = 0;
    let accLen = 0;
    let bestDist = Infinity;
    let totalLen = 0;
    const segLens: number[] = [];

    for (let i = 0; i < lineCoords.length - 1; i++) {
      const segLen = haversineKm(lineCoords[i][1], lineCoords[i][0], lineCoords[i + 1][1], lineCoords[i + 1][0]);
      segLens.push(segLen);
      totalLen += segLen;
    }

    accLen = 0;
    for (let i = 0; i < lineCoords.length - 1; i++) {
      const [ax, ay] = lineCoords[i], [bx, by] = lineCoords[i + 1];
      const dx = bx - ax, dy = by - ay;
      const lenSq = dx * dx + dy * dy;
      let t = lenSq > 0 ? ((s.lng - ax) * dx + (s.lat - ay) * dy) / lenSq : 0;
      t = Math.max(0, Math.min(1, t));
      const cx = ax + t * dx, cy = ay + t * dy;
      const dist = haversineKm(s.lat, s.lng, cy, cx);
      const pos = totalLen > 0 ? (accLen + segLens[i] * t) / totalLen : 0;
      if (dist < bestDist) { bestDist = dist; bestT = pos; }
      accLen += segLens[i];
    }
    return { ...s, position: bestT };
  });

  stopWithPosition.sort((a, b) => a.position - b.position);
  return stopWithPosition.map(({ position, ...rest }) => rest);
}

/* ── Auto-generate stops along a line every ~stopIntervalKm ── */
function autoGenerateStops(lineCoords: number[][], intervalKm = 0.4): { name: string; lng: number; lat: number }[] {
  const stops: { name: string; lng: number; lat: number }[] = [];
  if (lineCoords.length < 2) return stops;

  stops.push({ name: "Capolinea A", lng: lineCoords[0][0], lat: lineCoords[0][1] });
  let accum = 0;
  for (let i = 1; i < lineCoords.length; i++) {
    accum += haversineKm(lineCoords[i - 1][1], lineCoords[i - 1][0], lineCoords[i][1], lineCoords[i][0]);
    if (accum >= intervalKm) {
      stops.push({ name: `Fermata ${stops.length + 1}`, lng: lineCoords[i][0], lat: lineCoords[i][1] });
      accum = 0;
    }
  }
  const last = lineCoords[lineCoords.length - 1];
  if (stops.length === 0 || haversineKm(stops[stops.length - 1].lat, stops[stops.length - 1].lng, last[1], last[0]) > 0.05) {
    stops.push({ name: "Capolinea B", lng: last[0], lat: last[1] });
  }
  return stops;
}

function minToHHMM(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  const m = Math.round(minutes % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}


/* ── Detect shared terminals (coincidences) between lines ── */
interface TerminalCoincidence {
  stopName: string;
  lng: number;
  lat: number;
  lineIndices: number[];
}

function detectTerminalCoincidences(
  rawLines: { name: string; coords: number[][] }[],
  stopAssignment: Map<number, { name: string; lng: number; lat: number }[]>,
  thresholdKm = 0.3,
): TerminalCoincidence[] {
  // Collect all terminals (first and last stop of each line)
  const terminals: { name: string; lng: number; lat: number; lineIndex: number }[] = [];
  for (let i = 0; i < rawLines.length; i++) {
    const stops = stopAssignment.get(i) || [];
    if (stops.length >= 2) {
      terminals.push({ ...stops[0], lineIndex: i });
      terminals.push({ ...stops[stops.length - 1], lineIndex: i });
    }
  }

  // Group terminals that are within thresholdKm of each other
  const used = new Set<number>();
  const coincidences: TerminalCoincidence[] = [];

  for (let i = 0; i < terminals.length; i++) {
    if (used.has(i)) continue;
    const group = [i];
    for (let j = i + 1; j < terminals.length; j++) {
      if (used.has(j)) continue;
      if (terminals[i].lineIndex === terminals[j].lineIndex) continue;
      const d = haversineKm(terminals[i].lat, terminals[i].lng, terminals[j].lat, terminals[j].lng);
      if (d <= thresholdKm) group.push(j);
    }
    if (group.length > 1) {
      const lineIndices = [...new Set(group.map(g => terminals[g].lineIndex))];
      if (lineIndices.length > 1) {
        for (const g of group) used.add(g);
        coincidences.push({
          stopName: terminals[i].name,
          lng: terminals[i].lng,
          lat: terminals[i].lat,
          lineIndices,
        });
      }
    }
  }
  return coincidences;
}

/* ── Synchronize trips at shared terminals ── */
function synchronizeCoincidences(
  trips: GeneratedTrip[],
  coincidences: TerminalCoincidence[],
  toleranceMin = 5,
): GeneratedTrip[] {
  if (coincidences.length === 0) return trips;

  // For each coincidence, find trips from different lines arriving/departing at that terminal
  // and adjust their times to align within toleranceMin
  const adjusted = trips.map(t => ({ ...t, stopTimes: t.stopTimes.map(st => ({ ...st })) }));

  for (const coinc of coincidences) {
    // Find trips that start or end at this terminal
    const terminalTrips: { tripIdx: number; stopIdx: number; timeMin: number; isArrival: boolean }[] = [];

    for (let ti = 0; ti < adjusted.length; ti++) {
      const trip = adjusted[ti];
      if (!coinc.lineIndices.includes(trip.lineIndex)) continue;

      for (let si = 0; si < trip.stopTimes.length; si++) {
        const st = trip.stopTimes[si];
        const d = haversineKm(coinc.lat, coinc.lng, st.lat, st.lng);
        if (d <= 0.3) {
          const parts = st.departure.split(":");
          const timeMin = parseInt(parts[0]) * 60 + parseInt(parts[1]);
          terminalTrips.push({
            tripIdx: ti,
            stopIdx: si,
            timeMin,
            isArrival: si === trip.stopTimes.length - 1,
          });
        }
      }
    }

    // Group by time proximity
    terminalTrips.sort((a, b) => a.timeMin - b.timeMin);
    for (let i = 0; i < terminalTrips.length; i++) {
      const cluster: typeof terminalTrips = [terminalTrips[i]];
      for (let j = i + 1; j < terminalTrips.length; j++) {
        if (terminalTrips[j].timeMin - terminalTrips[i].timeMin <= toleranceMin * 2) {
          // Only sync trips from different lines
          const existingLines = new Set(cluster.map(c => adjusted[c.tripIdx].lineIndex));
          if (!existingLines.has(adjusted[terminalTrips[j].tripIdx].lineIndex)) {
            cluster.push(terminalTrips[j]);
          }
        }
      }

      if (cluster.length >= 2) {
        // Align departures to the earliest arrival + small buffer (2 min)
        const arrivals = cluster.filter(c => c.isArrival);
        const departures = cluster.filter(c => !c.isArrival);
        if (arrivals.length > 0 && departures.length > 0) {
          const latestArrival = Math.max(...arrivals.map(a => a.timeMin));
          const syncTime = latestArrival + 2; // 2 min transfer buffer
          for (const dep of departures) {
            if (Math.abs(dep.timeMin - syncTime) <= toleranceMin) {
              const delta = syncTime - dep.timeMin;
              // Shift entire trip by delta
              const trip = adjusted[dep.tripIdx];
              for (const st of trip.stopTimes) {
                const aParts = st.arrival.split(":");
                const dParts = st.departure.split(":");
                const aMin = parseInt(aParts[0]) * 60 + parseInt(aParts[1]) + delta;
                const dMin = parseInt(dParts[0]) * 60 + parseInt(dParts[1]) + delta;
                st.arrival = minToHHMM(aMin);
                st.departure = minToHHMM(dMin);
              }
              trip.departureTime = trip.stopTimes[0].departure;
              trip.arrivalTime = trip.stopTimes[trip.stopTimes.length - 1].arrival;
            }
          }
        }
      }
    }
  }

  return adjusted;
}

/* ══════════════════════════════════════════════════════════════════════
   MAIN ENGINE — Multi-line Service Program Generator
   ══════════════════════════════════════════════════════════════════════ */
async function generateServiceProgram(
  geojson: GeoJSONFeatureCollection,
  config: GenerateProgramConfig,
  poiRows: { category: string; lng: number; lat: number; name: string | null }[],
  censusRows: { population: number; centroidLng: number; centroidLat: number }[],
): Promise<GeneratedProgram> {
  const {
    targetKm,
    serviceStartH = 6,
    serviceEndH = 22,
    minCadenceMin = 10,
    maxCadenceMin = 60,
    avgSpeedKmh = 20,
    dwellTimeSec = 25,
    terminalTimeSec = 300,
    bidirectional = true,
  } = config;

  // ── 1. Extract lines and stops from GeoJSON ──
  const rawLines: { name: string; coords: number[][] }[] = [];
  const allStops: { name: string; lng: number; lat: number }[] = [];

  for (const f of geojson.features) {
    const geomType = f.geometry.type;
    if (geomType === "LineString") {
      rawLines.push({
        name: f.properties?.name || `Linea ${rawLines.length + 1}`,
        coords: f.geometry.coordinates,
      });
    } else if (geomType === "MultiLineString") {
      for (const seg of f.geometry.coordinates) {
        rawLines.push({
          name: f.properties?.name || `Linea ${rawLines.length + 1}`,
          coords: seg,
        });
      }
    } else if (geomType === "Point") {
      allStops.push({
        name: f.properties?.name || `Fermata ${allStops.length + 1}`,
        lng: f.geometry.coordinates[0],
        lat: f.geometry.coordinates[1],
      });
    }
  }

  // ── 2. Compute line lengths ──
  const lineLengths = rawLines.map(l => lineLength(l.coords));
  const totalNetworkKm = lineLengths.reduce((s, v) => s + v, 0);

  // ── 3. Assign stops to nearest line + order along line ──
  const stopAssignment = assignStopsToLines(allStops, rawLines);

  // For lines with no stops assigned, auto-generate them
  for (let i = 0; i < rawLines.length; i++) {
    let lineStops = stopAssignment.get(i) || [];
    if (lineStops.length < 2) {
      lineStops = autoGenerateStops(rawLines[i].coords);
      stopAssignment.set(i, lineStops);
    } else {
      // Order existing stops along the line
      lineStops = orderStopsAlongLine(lineStops, rawLines[i].coords);
      stopAssignment.set(i, lineStops);
    }
  }

  // ── 4. Global traffic profile (one query for the whole bounding box) ──
  const allCoords = rawLines.flatMap(l => l.coords);
  const trafficProfile = await getTrafficProfileForRoute(allCoords);

  // ── 5. Active time windows ──
  const activeWindows = DEFAULT_WINDOWS.filter(w =>
    w.endH > serviceStartH && w.startH < serviceEndH
  ).map(w => ({
    ...w,
    startH: Math.max(w.startH, serviceStartH),
    endH: Math.min(w.endH, serviceEndH),
  }));

  // ── 6. Generate trips per line ──
  const allTrips: GeneratedTrip[] = [];
  const lineSummaries: LineSummary[] = [];
  let globalTripCounter = 0;
  let globalTotalKm = 0;

  for (let li = 0; li < rawLines.length; li++) {
    const line = rawLines[li];
    const lengthKm = lineLengths[li];
    const lineStops = stopAssignment.get(li) || [];

    // Target km proportional to line length
    const lineTargetKm = targetKm * (lengthKm / totalNetworkKm);

    // Demand scores
    const demandScores = computeStopDemandScores(lineStops, poiRows, censusRows);
    const avgDemand = demandScores.length > 0 ? demandScores.reduce((a, b) => a + b, 0) / demandScores.length : 1;

    // Inter-stop distances
    const interStopKm: number[] = [];
    for (let i = 1; i < lineStops.length; i++) {
      interStopKm.push(haversineKm(lineStops[i - 1].lat, lineStops[i - 1].lng, lineStops[i].lat, lineStops[i].lng));
    }

    // Cadence per window for this line
    const cadencePerWindow = activeWindows.map(w => {
      const baseCadence = minCadenceMin + (maxCadenceMin - minCadenceMin) * (1 - w.demandFactor);
      const demandAdj = Math.max(0.6, Math.min(1.4, 1.5 - avgDemand * 0.1));
      const midHour = Math.floor((w.startH + w.endH) / 2);
      const congestion = trafficProfile.get(midHour) ?? 0.3;
      const trafficAdj = 1 + congestion * 0.15;
      const finalCadence = Math.round(Math.max(minCadenceMin, Math.min(maxCadenceMin, baseCadence * demandAdj * trafficAdj)));
      return { window: w, cadenceMin: finalCadence };
    });

    // Generate trips for this line
    const lineTrips: GeneratedTrip[] = [];
    let lineTotalKm = 0;
    let lineTripCounter = 0;

    for (const { window: w, cadenceMin } of cadencePerWindow) {
      let currentTimeMin = w.startH * 60;
      const windowEndMin = w.endH * 60;

      while (currentTimeMin + 1 < windowEndMin && lineTotalKm < lineTargetKm * 1.05) {
        const directions: ("andata" | "ritorno")[] = bidirectional
          ? (lineTripCounter % 2 === 0 ? ["andata", "ritorno"] : ["ritorno", "andata"])
          : ["andata"];

        for (const dir of directions) {
          if (lineTotalKm >= lineTargetKm * 1.05) break;
          if (currentTimeMin >= windowEndMin) break;

          const orderedStops = dir === "andata" ? [...lineStops] : [...lineStops].reverse();
          const hourOfDay = Math.floor(currentTimeMin / 60);
          const congestion = trafficProfile.get(hourOfDay) ?? 0.3;
          const dwellMin = dwellTimeSec / 60;

          const stopTimes: GeneratedTrip["stopTimes"] = [];
          let runningMin = currentTimeMin;

          for (let i = 0; i < orderedStops.length; i++) {
            const arrivalMin = runningMin;
            const departureMin = i < orderedStops.length - 1 ? arrivalMin + dwellMin : arrivalMin;
            stopTimes.push({
              stopName: orderedStops[i].name,
              lng: orderedStops[i].lng,
              lat: orderedStops[i].lat,
              arrival: minToHHMM(arrivalMin),
              departure: minToHHMM(departureMin),
            });
            if (i < orderedStops.length - 1) {
              const segKm = interStopKm[dir === "andata" ? i : orderedStops.length - 2 - i] || 0.4;
              const segTimeMin = estimateTravelTime(segKm, avgSpeedKmh, congestion);
              runningMin = departureMin + segTimeMin;
            }
          }

          const travelTimeMin = Math.round(runningMin - currentTimeMin);

          globalTripCounter++;
          lineTripCounter++;

          lineTrips.push({
            tripId: `L${String(li + 1).padStart(2, "0")}_T${String(lineTripCounter).padStart(3, "0")}_${dir === "andata" ? "A" : "R"}`,
            lineIndex: li,
            lineName: line.name,
            direction: dir,
            departureTime: minToHHMM(currentTimeMin),
            arrivalTime: minToHHMM(runningMin),
            travelTimeMin,
            stopTimes,
            timeWindow: w.label,
            cadenceMin,
          });

          lineTotalKm += lengthKm;
          globalTotalKm += lengthKm;

          if (bidirectional && dir === "andata") {
            currentTimeMin = runningMin + terminalTimeSec / 60;
          }
        }
        currentTimeMin += cadenceMin;
      }
    }

    allTrips.push(...lineTrips);

    lineSummaries.push({
      lineIndex: li,
      lineName: line.name,
      lengthKm: Math.round(lengthKm * 100) / 100,
      stopsCount: lineStops.length,
      totalTrips: lineTrips.length,
      totalKm: Math.round(lineTotalKm * 100) / 100,
      cadenceProfile: cadencePerWindow.map(c => ({
        window: c.window.label,
        cadenceMin: c.cadenceMin,
        tripsInWindow: lineTrips.filter(t => t.timeWindow === c.window.label).length,
      })),
      avgDemandScore: Math.round(avgDemand * 100) / 100,
      stops: lineStops.map((s, i) => ({ ...s, demandScore: demandScores[i] || 0 })),
    });
  }

  // ── 6b. Detect and synchronize coincidences ──
  const coincidences = detectTerminalCoincidences(rawLines, stopAssignment);
  const syncedTrips = synchronizeCoincidences(allTrips, coincidences);
  // Replace allTrips with synced version
  allTrips.splice(0, allTrips.length, ...syncedTrips);

  // ── 7. Aggregate metrics ──
  const peakTrips = allTrips.filter(t => t.timeWindow.includes("punta"));
  const avgTravelTime = allTrips.length > 0 ? Math.round(allTrips.reduce((s, t) => s + t.travelTimeMin, 0) / allTrips.length) : 0;
  const totalServiceMin = allTrips.reduce((s, t) => s + t.travelTimeMin, 0);
  const totalServiceHours = Math.round(totalServiceMin / 60 * 10) / 10;

  // Vehicles per line (round trip time / peak cadence), summed
  let totalVehicles = 0;
  for (const ls of lineSummaries) {
    const peakCad = ls.cadenceProfile.find(c => c.window.includes("punta"))?.cadenceMin || minCadenceMin;
    const lineTrips = allTrips.filter(t => t.lineIndex === ls.lineIndex);
    const avgRtMin = lineTrips.length > 0
      ? lineTrips.reduce((s, t) => s + t.travelTimeMin, 0) / lineTrips.length * 2 + (terminalTimeSec / 60) * 2
      : 60;
    totalVehicles += Math.max(1, Math.ceil(avgRtMin / peakCad));
  }

  // Global cadence profile (aggregate across lines)
  const globalCadenceProfile = activeWindows.map(w => {
    const windowTrips = allTrips.filter(t => t.timeWindow === w.label);
    const windowCadences = lineSummaries.map(ls =>
      ls.cadenceProfile.find(c => c.window === w.label)?.cadenceMin || maxCadenceMin
    );
    const avgCadence = windowCadences.length > 0
      ? Math.round(windowCadences.reduce((a, b) => a + b, 0) / windowCadences.length)
      : maxCadenceMin;
    return { window: w.label, cadenceMin: avgCadence, tripsInWindow: windowTrips.length };
  });

  const peakCadence = globalCadenceProfile.find(c => c.window.includes("punta"))?.cadenceMin || minCadenceMin;
  const offPeakCadence = globalCadenceProfile.find(c => c.window.includes("morbida"))?.cadenceMin || maxCadenceMin;

  // All stops aggregated
  const allStopsWithDemand = lineSummaries.flatMap(ls => ls.stops);

  return {
    routeName: rawLines.length === 1 ? rawLines[0].name : `Rete ${rawLines.length} linee`,
    routeLengthKm: Math.round(totalNetworkKm * 100) / 100,
    totalTrips: allTrips.length,
    totalKm: Math.round(globalTotalKm * 100) / 100,
    totalLines: rawLines.length,
    serviceWindow: `${String(serviceStartH).padStart(2, "0")}:00\u2013${String(serviceEndH).padStart(2, "0")}:00`,
    trips: allTrips,
    lines: lineSummaries,
    cadenceProfile: globalCadenceProfile,
    metrics: {
      avgCadenceMin: Math.round(globalCadenceProfile.reduce((s, c) => s + c.cadenceMin, 0) / globalCadenceProfile.length),
      peakCadenceMin: peakCadence,
      offPeakCadenceMin: offPeakCadence,
      avgTravelTimeMin: avgTravelTime,
      vehiclesNeeded: totalVehicles,
      totalServiceHours,
      kmPerVehicle: totalVehicles > 0 ? Math.round(globalTotalKm / totalVehicles * 10) / 10 : 0,
    },
    stops: allStopsWithDemand,
    coincidences: coincidences.map(c => ({
      stopName: c.stopName,
      lng: c.lng,
      lat: c.lat,
      lines: c.lineIndices.map(li => rawLines[li]?.name || "Linea " + (li + 1)),
    })),
  };
}

// ─── GET /api/scenarios/:id/suggest-km ────────────────────────────────
router.get("/scenarios/:id/suggest-km", async (req, res) => {
  try {
    const [row] = await db.select().from(scenarios).where(eq(scenarios.id, req.params.id)).limit(1);
    if (!row) { res.status(404).json({ error: "Scenario non trovato" }); return; }

    const geojson = row.geojson as any;
    if (!geojson?.features) { res.json({ suggestedKm: 500, breakdown: {} }); return; }

    // Extract lines
    const lines: { name: string; lengthKm: number }[] = [];
    for (const f of geojson.features) {
      if (f.geometry.type === "LineString") {
        lines.push({ name: f.properties?.name || `Linea ${lines.length + 1}`, lengthKm: lineLength(f.geometry.coordinates) });
      } else if (f.geometry.type === "MultiLineString") {
        for (const seg of f.geometry.coordinates) {
          lines.push({ name: f.properties?.name || `Linea ${lines.length + 1}`, lengthKm: lineLength(seg) });
        }
      }
    }

    const totalNetworkKm = lines.reduce((s, l) => s + l.lengthKm, 0);
    if (totalNetworkKm === 0) { res.json({ suggestedKm: 500, breakdown: {} }); return; }

    // Count POI and population near routes
    const allCoords = geojson.features
      .filter((f: any) => f.geometry.type === "LineString" || f.geometry.type === "MultiLineString")
      .flatMap((f: any) => f.geometry.type === "LineString" ? f.geometry.coordinates : f.geometry.coordinates.flat());

    let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
    for (const [lng, lat] of allCoords) {
      if (lng < minLng) minLng = lng; if (lng > maxLng) maxLng = lng;
      if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat;
    }
    const pad = 1 / 111;

    const [poiCountResult, popResult] = await Promise.all([
      db.execute<{ cnt: string }>(sql`
        SELECT COUNT(*)::text AS cnt FROM points_of_interest
        WHERE lng BETWEEN ${minLng - pad} AND ${maxLng + pad}
          AND lat BETWEEN ${minLat - pad} AND ${maxLat + pad}
      `),
      db.execute<{ total_pop: string }>(sql`
        SELECT COALESCE(SUM(population), 0)::text AS total_pop FROM census_sections
        WHERE centroid_lng BETWEEN ${minLng - pad} AND ${maxLng + pad}
          AND centroid_lat BETWEEN ${minLat - pad} AND ${maxLat + pad}
      `),
    ]);

    const poiCount = parseInt(poiCountResult.rows[0]?.cnt || "0");
    const population = parseInt(popResult.rows[0]?.total_pop || "0");

    // Suggestion logic:
    // Base: each line needs ~2x its length per hour * 16 hours service * bidirectional factor
    const serviceHours = 16; // 6-22
    const avgCadenceMin = 30; // balanced default
    const tripsPerLinePerHour = 60 / avgCadenceMin; // 2 trips/hour
    const bidiMultiplier = 2; // andata + ritorno

    // Base km = networkKm * trips/hour * hours * bidi
    let baseKm = totalNetworkKm * tripsPerLinePerHour * serviceHours * bidiMultiplier / lines.length;
    // If many lines, scale down per-line trips
    if (lines.length > 1) {
      baseKm = totalNetworkKm * bidiMultiplier * serviceHours * tripsPerLinePerHour;
    }

    // Demand multiplier based on POI density and population
    const poiDensity = poiCount / Math.max(totalNetworkKm, 1);
    const popDensity = population / Math.max(totalNetworkKm, 1);
    const demandMultiplier = Math.max(0.5, Math.min(2.0,
      0.7 + poiDensity * 0.02 + popDensity * 0.00005
    ));

    const suggestedKm = Math.round(baseKm * demandMultiplier / 50) * 50; // round to nearest 50
    const minKm = Math.round(totalNetworkKm * bidiMultiplier * 4); // minimum: 4 round trips
    const maxKm = Math.round(totalNetworkKm * bidiMultiplier * serviceHours * 6); // max: 6 trips/h

    res.json({
      suggestedKm: Math.max(minKm, Math.min(maxKm, suggestedKm)),
      minKm,
      maxKm,
      breakdown: {
        totalNetworkKm: Math.round(totalNetworkKm * 100) / 100,
        totalLines: lines.length,
        poiCount,
        populationServed: population,
        demandMultiplier: Math.round(demandMultiplier * 100) / 100,
        lines: lines.map(l => ({ name: l.name, lengthKm: Math.round(l.lengthKm * 100) / 100 })),
      },
    });
  } catch (err) {
    req.log.error(err, "Error suggesting km");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── POST /api/scenarios/:id/generate-program ────────────────────────
router.post("/scenarios/:id/generate-program", async (req, res) => {
  try {
    const [row] = await db.select().from(scenarios).where(eq(scenarios.id, req.params.id)).limit(1);
    if (!row) { res.status(404).json({ error: "Scenario non trovato" }); return; }

    const config = req.body as GenerateProgramConfig;
    if (!config.targetKm || config.targetKm <= 0) {
      res.status(400).json({ error: "Parametro 'targetKm' obbligatorio e > 0" });
      return;
    }

    const [poiRows, censusRows] = await Promise.all([
      db.select({ category: pointsOfInterest.category, lng: pointsOfInterest.lng, lat: pointsOfInterest.lat, name: pointsOfInterest.name }).from(pointsOfInterest),
      db.select({ population: censusSections.population, centroidLng: censusSections.centroidLng, centroidLat: censusSections.centroidLat })
        .from(censusSections).where(sql`${censusSections.population} > 0`),
    ]);

    const program = await generateServiceProgram(row.geojson as any, config, poiRows, censusRows);

    const [saved] = await db.insert(scenarioServicePrograms).values({
      scenarioId: req.params.id,
      name: `PdE ${program.routeName} \u2013 ${program.totalKm}km`,
      config: config as any,
      result: program as any,
    }).returning();

    res.json({ id: saved.id, ...program });
  } catch (err) {
    req.log.error(err, "Error generating service program");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── GET /api/scenarios/:id/programs ─────────────────────────────────
router.get("/scenarios/:id/programs", async (req, res) => {
  try {
    const rows = await db.select({
      id: scenarioServicePrograms.id,
      name: scenarioServicePrograms.name,
      config: scenarioServicePrograms.config,
      createdAt: scenarioServicePrograms.createdAt,
    }).from(scenarioServicePrograms)
      .where(eq(scenarioServicePrograms.scenarioId, req.params.id))
      .orderBy(desc(scenarioServicePrograms.createdAt));
    res.json({ programs: rows });
  } catch (err) {
    req.log.error(err, "Error listing programs");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── GET /api/scenarios/:id/programs/:programId ──────────────────────
router.get("/scenarios/:id/programs/:programId", async (req, res) => {
  try {
    const [row] = await db.select().from(scenarioServicePrograms)
      .where(eq(scenarioServicePrograms.id, req.params.programId))
      .limit(1);
    if (!row) { res.status(404).json({ error: "Programma non trovato" }); return; }
    res.json({ id: row.id, name: row.name, config: row.config, ...row.result as any });
  } catch (err) {
    req.log.error(err, "Error getting program");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── DELETE /api/scenarios/:id/programs/:programId ────────────────────
router.delete("/scenarios/:id/programs/:programId", async (req, res) => {
  try {
    const [deleted] = await db.delete(scenarioServicePrograms)
      .where(eq(scenarioServicePrograms.id, req.params.programId))
      .returning({ id: scenarioServicePrograms.id });
    if (!deleted) { res.status(404).json({ error: "Programma non trovato" }); return; }
    res.json({ deleted: true });
  } catch (err) {
    req.log.error(err, "Error deleting program");
    res.status(500).json({ error: "Internal server error" });
  }
});


export default router;
