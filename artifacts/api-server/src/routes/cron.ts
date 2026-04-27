import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { trafficSnapshots, pointsOfInterest, censusSections, istatCommutingOd } from "@workspace/db/schema";
import { sql } from "drizzle-orm";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { spawnSync } from "node:child_process";
import * as readline from "node:readline";

const router: IRouter = Router();

function verifyCronSecret(req: any, res: any): boolean {
  const secret = req.headers["x-cron-secret"];
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

// ─── Google Places API helpers ────────────────────────────────────────────────

// Map our categories to Google Places types
const GOOGLE_PLACES_CATEGORIES: Array<{
  category: string;
  types: string[];
  keyword?: string;
}> = [
  { category: "hospital",   types: ["hospital", "doctor", "health"] },
  { category: "school",     types: ["school", "university", "secondary_school"] },
  { category: "shopping",   types: ["shopping_mall", "supermarket", "department_store"] },
  { category: "industrial", types: [], keyword: "zona industriale" },
  { category: "leisure",    types: ["stadium", "sports_complex", "amusement_park", "aquarium"] },
  { category: "office",     types: ["city_hall", "courthouse", "local_government_office", "police"] },
  { category: "transit",    types: ["transit_station", "train_station", "bus_station", "airport"] },
  { category: "workplace",  types: ["accounting", "insurance_agency", "lawyer"], keyword: "uffici azienda" },
  { category: "worship",    types: ["church", "mosque", "synagogue", "hindu_temple"] },
  { category: "elderly",    types: ["nursing_home"], keyword: "casa di riposo RSA" },
  { category: "parking",    types: ["parking"], keyword: "parcheggio scambiatore" },
  { category: "tourism",    types: ["museum", "tourist_attraction", "lodging", "art_gallery"] },
];

// Province centro + surrounding towns to search around (lat, lng, radius metres)
const SEARCH_LOCATIONS = [
  { name: "Ancona centro",    lat: 43.6166, lng: 13.5185, radius: 5000 },
  { name: "Ancona Torrette",  lat: 43.5980, lng: 13.4520, radius: 3000 },
  { name: "Ancona Baraccola", lat: 43.5590, lng: 13.4860, radius: 3000 },
  { name: "Jesi",             lat: 43.5222, lng: 13.2436, radius: 4000 },
  { name: "Senigallia",       lat: 43.7151, lng: 13.2175, radius: 4000 },
  { name: "Fabriano",         lat: 43.3368, lng: 12.9078, radius: 4000 },
  { name: "Osimo",            lat: 43.4834, lng: 13.4810, radius: 3000 },
  { name: "Falconara",        lat: 43.6280, lng: 13.3940, radius: 3000 },
  { name: "Chiaravalle",      lat: 43.5998, lng: 13.3222, radius: 2500 },
  { name: "Castelfidardo",    lat: 43.4616, lng: 13.5492, radius: 2500 },
  { name: "Loreto",           lat: 43.4413, lng: 13.6075, radius: 2500 },
  { name: "Camerano",         lat: 43.5280, lng: 13.5350, radius: 2000 },
  { name: "Montemarciano",    lat: 43.6430, lng: 13.3410, radius: 2000 },
  { name: "Filottrano",       lat: 43.4380, lng: 13.3520, radius: 2000 },
  { name: "Sassoferrato",     lat: 43.4360, lng: 12.8570, radius: 2500 },
];

async function googleNearbySearch(
  apiKey: string,
  lat: number,
  lng: number,
  radius: number,
  types: string[],
  keyword?: string
): Promise<any[]> {
  const params = new URLSearchParams({
    location: `${lat},${lng}`,
    radius: String(radius),
    key: apiKey,
  });
  if (types.length > 0) params.set("type", types[0]); // Places API v1 accepts one type
  if (keyword) params.set("keyword", keyword);

  const url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?${params}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!resp.ok) throw new Error(`Google Places HTTP ${resp.status}`);
  const json = await resp.json() as any;
  if (json.status !== "OK" && json.status !== "ZERO_RESULTS") {
    throw new Error(`Google Places API error: ${json.status} — ${json.error_message ?? ""}`);
  }
  return json.results ?? [];
}

export async function syncPoiFromGoogle(): Promise<{
  inserted: number;
  skipped: number;
  categories: Record<string, number>;
  errors: string[];
}> {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) throw new Error("GOOGLE_PLACES_API_KEY non configurata");

  // Clear all existing POI (both OSM and old manual data) for a clean import
  await db.execute(sql`DELETE FROM points_of_interest`);

  const categories: Record<string, number> = {};
  const errors: string[] = [];
  // Deduplicate by Google place_id
  const seen = new Set<string>();
  let inserted = 0;
  let skipped = 0;

  for (const catDef of GOOGLE_PLACES_CATEGORIES) {
    categories[catDef.category] = 0;
    const typeSets = catDef.types.length > 0 ? catDef.types : [""]; // at least one iteration

    for (const location of SEARCH_LOCATIONS) {
      for (const type of typeSets) {
        try {
          const results = await googleNearbySearch(
            apiKey,
            location.lat,
            location.lng,
            location.radius,
            type ? [type] : [],
            catDef.keyword
          );

          for (const place of results) {
            const placeId: string = place.place_id;
            if (!placeId || seen.has(`${catDef.category}:${placeId}`)) continue;
            seen.add(`${catDef.category}:${placeId}`);

            const name: string | null = place.name ?? null;
            if (!name) continue;

            const lat: number = place.geometry?.location?.lat;
            const lng: number = place.geometry?.location?.lng;
            if (!lat || !lng) continue;

            // Ensure within province bounding box (rough check)
            if (lng < 12.7 || lng > 13.65 || lat < 43.2 || lat > 43.95) {
              skipped++;
              continue;
            }

            const properties = {
              place_id: placeId,
              types: place.types ?? [],
              rating: place.rating ?? null,
              vicinity: place.vicinity ?? null,
              user_ratings_total: place.user_ratings_total ?? null,
              source: "google_places",
            };

            try {
              await db.execute(sql`
                INSERT INTO points_of_interest (name, category, lng, lat, properties)
                VALUES (${name}, ${catDef.category}, ${lng}, ${lat}, ${JSON.stringify(properties)})
              `);
              inserted++;
              categories[catDef.category]++;
            } catch {
              skipped++;
            }
          }

          // Rate limit: 10 req/s max for Places API
          await new Promise((r) => setTimeout(r, 120));
        } catch (err: any) {
          const msg = `${catDef.category}@${location.name}/${type}: ${err.message}`;
          errors.push(msg);
          await new Promise((r) => setTimeout(r, 500));
        }
      }
    }
  }

  return { inserted, skipped, categories, errors };
}

// ─── OSM Overpass helpers ─────────────────────────────────────────────────────

const BBOX_OVERPASS = "43.2,12.8,43.95,13.65"; // lat_min,lng_min,lat_max,lng_max

async function overpassQuery(overpassQL: string): Promise<any[]> {
  const body = `[out:json][timeout:30];(${overpassQL});out center;`;
  const resp = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    body,
    headers: { "Content-Type": "text/plain" },
  });
  if (!resp.ok) throw new Error(`Overpass HTTP ${resp.status}`);
  const json = await resp.json() as any;
  return json.elements ?? [];
}

function elementCoords(el: any): { lat: number; lng: number } | null {
  // Node: direct lat/lon. Way/Relation: center object
  if (el.type === "node" && el.lat && el.lon) return { lat: el.lat, lng: el.lon };
  if (el.center?.lat && el.center?.lon) return { lat: el.center.lat, lng: el.center.lon };
  return null;
}

// ─── TomTom Traffic helpers ───────────────────────────────────────────────────

// Strategic road points across the province (major arteries only)
// SS16 Adriatica, A14, SS76, SS3 Flaminia, urban Ancona, secondary roads
const STRATEGIC_ROAD_POINTS: Array<{ id: string; lat: number; lng: number }> = [
  // A14 - Autostrada Adriatica
  { id: "A14-AnconaNo-N", lat: 43.6420, lng: 13.4350 },
  { id: "A14-AnconaNo-S", lat: 43.6200, lng: 13.4410 },
  { id: "A14-AnconaSud",  lat: 43.5350, lng: 13.4480 },
  { id: "A14-Falconara",  lat: 43.6180, lng: 13.4110 },
  { id: "A14-Senigallia", lat: 43.6950, lng: 13.2650 },
  { id: "A14-Loreto",     lat: 43.4400, lng: 13.5900 },

  // SS16 Adriatica (coast road)
  { id: "SS16-Senigallia-N",  lat: 43.7250, lng: 13.2120 },
  { id: "SS16-Senigallia-S",  lat: 43.7020, lng: 13.2200 },
  { id: "SS16-Falconara",     lat: 43.6300, lng: 13.3980 },
  { id: "SS16-Palombina",     lat: 43.6560, lng: 13.4180 },
  { id: "SS16-AncCentro-N",   lat: 43.6320, lng: 13.4700 },
  { id: "SS16-AncCentro",     lat: 43.6120, lng: 13.4900 },
  { id: "SS16-AncSud",        lat: 43.5800, lng: 13.4950 },
  { id: "SS16-Osimo",         lat: 43.4850, lng: 13.4810 },
  { id: "SS16-Loreto-N",      lat: 43.4600, lng: 13.5620 },
  { id: "SS16-PortoRecanati", lat: 43.4300, lng: 13.6050 },

  // SS76 Jesi-Ancona
  { id: "SS76-Jesi-E",    lat: 43.5230, lng: 13.2520 },
  { id: "SS76-Jesi-W",    lat: 43.5180, lng: 13.2050 },
  { id: "SS76-Mid",       lat: 43.5640, lng: 13.3550 },
  { id: "SS76-AncW",      lat: 43.5760, lng: 13.4350 },
  { id: "SS76-Torrette",  lat: 43.5980, lng: 13.4520 },

  // SS3 Flaminia (Fossombrone-Fano area but also used in province)
  { id: "SS3-Fabriano-N", lat: 43.3450, lng: 12.9080 },
  { id: "SS3-Fabriano-S", lat: 43.3250, lng: 12.8970 },

  // Tangenziale Ancona / urban roads
  { id: "Tangenzia-N",    lat: 43.6180, lng: 13.4820 },
  { id: "Tangenzia-E",    lat: 43.6000, lng: 13.5100 },
  { id: "ViaFlaminiaAnc", lat: 43.6050, lng: 13.5060 },
  { id: "ViaRossi-Anc",   lat: 43.6070, lng: 13.5250 },

  // SS361 Osimo-Jesi
  { id: "SS361-Osimo-N",  lat: 43.4950, lng: 13.4750 },
  { id: "SS361-Castelf",  lat: 43.4620, lng: 13.5470 },

  // SP Ancona-Sirolo (Conero)
  { id: "SP-Sirolo",      lat: 43.5620, lng: 13.5380 },

  // Jesi urban
  { id: "Jesi-Centro",    lat: 43.5220, lng: 13.2430 },
  { id: "Jesi-Ring",      lat: 43.5150, lng: 13.2610 },

  // Chiaravalle
  { id: "Chiaravalle",    lat: 43.5980, lng: 13.3230 },

  // Senigallia urban
  { id: "Senigallia-Ctr", lat: 43.7150, lng: 13.2180 },
  { id: "Senigallia-SS",  lat: 43.7080, lng: 13.2250 },

  // Porto di Ancona area
  { id: "Porto-Anc",      lat: 43.6260, lng: 13.4950 },
  { id: "ViaXXSett",      lat: 43.6190, lng: 13.5130 },
];

// ─── Internal sync functions ──────────────────────────────────────────────────

export async function syncPoiFromOsm(): Promise<{ inserted: number; categories: Record<string, number> }> {
  // Remove manually-seeded POIs (osm_id IS NULL) before inserting real OSM data
  await db.execute(sql`DELETE FROM points_of_interest WHERE osm_id IS NULL`);

  const categories: Record<string, number> = {};
  let inserted = 0;

  // OSM IDs for ways can exceed int32 max (2147483647).
  // We use node IDs directly (usually < 10B, stored as text in osm_id via bigint cast)
  // For simplicity: skip osm_id for way/relation elements to avoid overflow
  function safeOsmId(el: any): number | null {
    if (el.type !== "node") return null; // ways/relations: skip ID
    if (el.id > 2147483647 || el.id < 0) return null; // out of int32 range
    return el.id as number;
  }

  const categoryQueries: Array<{ category: string; ql: string }> = [
    {
      category: "hospital",
      ql: `node["amenity"~"hospital|clinic"](${BBOX_OVERPASS});
           way["amenity"~"hospital|clinic"](${BBOX_OVERPASS});`,
    },
    {
      category: "school",
      ql: `node["amenity"~"school|university|college"](${BBOX_OVERPASS});
           way["amenity"~"school|university|college"](${BBOX_OVERPASS});`,
    },
    {
      category: "shopping",
      ql: `node["shop"~"supermarket|hypermarket|mall|department_store"](${BBOX_OVERPASS});
           way["shop"~"supermarket|hypermarket|mall"](${BBOX_OVERPASS});
           node["amenity"="marketplace"](${BBOX_OVERPASS});`,
    },
    {
      category: "industrial",
      ql: `way["landuse"="industrial"](${BBOX_OVERPASS});
           node["landuse"="industrial"](${BBOX_OVERPASS});`,
    },
    {
      category: "leisure",
      ql: `node["leisure"~"stadium|sports_centre|swimming_pool|park"](${BBOX_OVERPASS});
           way["leisure"~"stadium|sports_centre"](${BBOX_OVERPASS});
           node["amenity"~"cinema|theatre"](${BBOX_OVERPASS});`,
    },
    {
      category: "office",
      ql: `node["amenity"="townhall"](${BBOX_OVERPASS});
           way["amenity"="townhall"](${BBOX_OVERPASS});
           node["office"~"government|public_administration"](${BBOX_OVERPASS});
           node["amenity"~"courthouse|police|fire_station"](${BBOX_OVERPASS});`,
    },
    {
      category: "transit",
      ql: `node["railway"~"station|halt"](${BBOX_OVERPASS});
           node["aeroway"="aerodrome"](${BBOX_OVERPASS});
           way["aeroway"="aerodrome"](${BBOX_OVERPASS});
           node["amenity"="bus_station"](${BBOX_OVERPASS});
           node["public_transport"="station"](${BBOX_OVERPASS});`,
    },
    {
      category: "workplace",
      ql: `node["office"~"company|insurance|it|financial|estate_agent"](${BBOX_OVERPASS});
           way["office"~"company|insurance|it|financial"](${BBOX_OVERPASS});
           node["building"="commercial"]["name"](${BBOX_OVERPASS});
           way["building"="commercial"]["name"](${BBOX_OVERPASS});`,
    },
    {
      category: "worship",
      ql: `node["amenity"="place_of_worship"](${BBOX_OVERPASS});
           way["amenity"="place_of_worship"](${BBOX_OVERPASS});`,
    },
    {
      category: "elderly",
      ql: `node["amenity"~"nursing_home|social_facility"](${BBOX_OVERPASS});
           way["amenity"~"nursing_home|social_facility"](${BBOX_OVERPASS});
           node["social_facility"~"group_home|nursing_home|assisted_living"](${BBOX_OVERPASS});`,
    },
    {
      category: "parking",
      ql: `node["amenity"="parking"]["name"](${BBOX_OVERPASS});
           way["amenity"="parking"]["name"](${BBOX_OVERPASS});
           node["amenity"="parking"]["park_ride"="yes"](${BBOX_OVERPASS});`,
    },
    {
      category: "tourism",
      ql: `node["tourism"~"museum|attraction|gallery|viewpoint"](${BBOX_OVERPASS});
           way["tourism"~"museum|attraction"](${BBOX_OVERPASS});
           node["tourism"~"hotel|hostel"]["stars"](${BBOX_OVERPASS});`,
    },
  ];

  for (const { category, ql } of categoryQueries) {
    try {
      const elements = await overpassQuery(ql);
      let catInserted = 0;

      for (const el of elements.slice(0, 120)) {
        const coords = elementCoords(el);
        if (!coords) continue;
        const name = el.tags?.name ?? el.tags?.["name:it"] ?? null;
        if (!name) continue; // skip unnamed features

        try {
          const osmId = safeOsmId(el);
          if (osmId !== null) {
            await db.execute(sql`
              INSERT INTO points_of_interest (osm_id, name, category, lng, lat, properties)
              VALUES (
                ${osmId},
                ${name},
                ${category},
                ${coords.lng},
                ${coords.lat},
                ${JSON.stringify(el.tags ?? {})}
              )
              ON CONFLICT (osm_id) DO UPDATE SET
                name       = EXCLUDED.name,
                category   = EXCLUDED.category,
                lng        = EXCLUDED.lng,
                lat        = EXCLUDED.lat,
                properties = EXCLUDED.properties,
                updated_at = NOW()
            `);
          } else {
            // way/relation or large ID: insert without osm_id
            await db.execute(sql`
              INSERT INTO points_of_interest (name, category, lng, lat, properties)
              VALUES (
                ${name},
                ${category},
                ${coords.lng},
                ${coords.lat},
                ${JSON.stringify(el.tags ?? {})}
              )
            `);
          }
          catInserted++;
          inserted++;
        } catch {
          // skip duplicates or constraint errors
        }
      }

      categories[category] = catInserted;
      // Brief pause between Overpass requests to be polite
      await new Promise((r) => setTimeout(r, 500));
    } catch (err) {
      categories[category] = 0;
    }
  }

  return { inserted, categories };
}

export async function syncTrafficFromTomTom(): Promise<{ inserted: number; failed: number }> {
  const apiKey = process.env.TOMTOM_API_KEY;
  if (!apiKey) throw new Error("TOMTOM_API_KEY not set");

  const toInsert: any[] = [];
  let failed = 0;

  for (const point of STRATEGIC_ROAD_POINTS) {
    try {
      const url =
        `https://api.tomtom.com/traffic/services/4/flowSegmentData/absolute/10/json` +
        `?point=${point.lat},${point.lng}&unit=KMPH&key=${apiKey}`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!resp.ok) { failed++; continue; }
      const data = await resp.json() as any;
      const fd = data.flowSegmentData;
      if (!fd) { failed++; continue; }

      const speed = fd.currentSpeed ?? 0;
      const freeflow = fd.freeFlowSpeed ?? speed;
      const congestion = freeflow > 0 ? Math.max(0, 1 - speed / freeflow) : 0;

      toInsert.push({
        segmentId: point.id,
        lng: point.lng,
        lat: point.lat,
        speed,
        freeflowSpeed: freeflow,
        congestionLevel: congestion,
      });
    } catch {
      failed++;
    }
  }

  if (toInsert.length > 0) {
    await db.insert(trafficSnapshots).values(toInsert);
  }

  // Keep only last 90 days
  await db.execute(sql`
    DELETE FROM traffic_snapshots WHERE captured_at < NOW() - INTERVAL '90 days'
  `);

  return { inserted: toInsert.length, failed };
}

/**
 * Sync census data from ISTAT.
 *
 * Strategy (hybrid):
 * 1. Try fetching **population by municipality** from ISTAT SDMX REST API
 *    (dati.istat.it – dataset DCIS_POPRES1, latest year, province of Ancona = "042").
 *    This gives fresh demographic numbers.
 * 2. Geographic boundaries (centroid, area) come from the static reference table
 *    below – municipality boundaries change only after decennial census or mergers,
 *    so keeping them local is perfectly fine.
 * 3. If the ISTAT API is unreachable (maintenance, timeout, etc.) we fall back
 *    entirely to the static dataset so the cron never fails.
 *
 * The output is always split by **sezioni censuarie / comuni**, one row per
 * municipality, respecting the existing `census_sections` table schema.
 */

// ── Static reference: geographic data (OSM/Nominatim) for Provincia di Ancona ──
const ANCONA_COMUNI: Array<{
  /** internal code matching istat_code column */
  code: string;
  /** ISTAT 6-digit municipal code (e.g. "042001" for Ancona) used in SDMX */
  istatProCode: string;
  name: string;
  lng: number;
  lat: number;
  /** fallback population (ISTAT 2023 estimates) */
  fallbackPop: number;
  areaKm2: number;
}> = [
  { code: "AN001", istatProCode: "042001", name: "Ancona",             lng: 13.5185, lat: 43.6166, fallbackPop: 99470, areaKm2: 124.2 },
  { code: "AN002", istatProCode: "042002", name: "Agugliano",           lng: 13.3750, lat: 43.5450, fallbackPop: 5070,  areaKm2: 16.1  },
  { code: "AN003", istatProCode: "042003", name: "Barbara",             lng: 13.0280, lat: 43.5800, fallbackPop: 1360,  areaKm2: 13.5  },
  { code: "AN004", istatProCode: "042004", name: "Belvedere Ostrense",  lng: 13.1630, lat: 43.5640, fallbackPop: 2370,  areaKm2: 18.2  },
  { code: "AN005", istatProCode: "042005", name: "Camerano",            lng: 13.5350, lat: 43.5280, fallbackPop: 7490,  areaKm2: 17.0  },
  { code: "AN006", istatProCode: "042006", name: "Camerata Picena",     lng: 13.3210, lat: 43.5660, fallbackPop: 2810,  areaKm2: 15.0  },
  { code: "AN007", istatProCode: "042007", name: "Castelbellino",       lng: 13.1830, lat: 43.5160, fallbackPop: 3310,  areaKm2: 8.6   },
  { code: "AN008", istatProCode: "042008", name: "Castelfidardo",       lng: 13.5492, lat: 43.4616, fallbackPop: 19100, areaKm2: 29.4  },
  { code: "AN009", istatProCode: "042009", name: "Castelleone di Suasa",lng: 12.9830, lat: 43.6020, fallbackPop: 1620,  areaKm2: 22.0  },
  { code: "AN010", istatProCode: "042010", name: "Castelplanio",        lng: 13.1350, lat: 43.5270, fallbackPop: 3230,  areaKm2: 18.5  },
  { code: "AN011", istatProCode: "042011", name: "Cerreto d'Esi",       lng: 13.0520, lat: 43.3390, fallbackPop: 3870,  areaKm2: 29.1  },
  { code: "AN012", istatProCode: "042012", name: "Chiaravalle",         lng: 13.3222, lat: 43.5998, fallbackPop: 15200, areaKm2: 24.7  },
  { code: "AN013", istatProCode: "042013", name: "Corinaldo",           lng: 13.0480, lat: 43.6490, fallbackPop: 5180,  areaKm2: 47.5  },
  { code: "AN014", istatProCode: "042014", name: "Cupramontana",        lng: 13.1190, lat: 43.4440, fallbackPop: 4590,  areaKm2: 29.9  },
  { code: "AN015", istatProCode: "042015", name: "Fabriano",            lng: 12.9078, lat: 43.3368, fallbackPop: 29900, areaKm2: 272.2 },
  { code: "AN016", istatProCode: "042016", name: "Falconara Marittima", lng: 13.3940, lat: 43.6280, fallbackPop: 27600, areaKm2: 27.0  },
  { code: "AN017", istatProCode: "042017", name: "Filottrano",          lng: 13.3520, lat: 43.4380, fallbackPop: 9220,  areaKm2: 51.1  },
  { code: "AN018", istatProCode: "042018", name: "Genga",               lng: 12.9410, lat: 43.4280, fallbackPop: 1720,  areaKm2: 79.8  },
  { code: "AN019", istatProCode: "042019", name: "Jesi",                lng: 13.2436, lat: 43.5222, fallbackPop: 39600, areaKm2: 114.0 },
  { code: "AN020", istatProCode: "042020", name: "Loreto",              lng: 13.6075, lat: 43.4413, fallbackPop: 11000, areaKm2: 18.2  },
  { code: "AN021", istatProCode: "042021", name: "Maiolati Spontini",   lng: 13.1510, lat: 43.4940, fallbackPop: 7230,  areaKm2: 27.9  },
  { code: "AN022", istatProCode: "042022", name: "Mergo",               lng: 13.0660, lat: 43.4610, fallbackPop: 1050,  areaKm2: 8.8   },
  { code: "AN023", istatProCode: "042023", name: "Monsano",             lng: 13.2080, lat: 43.5610, fallbackPop: 3670,  areaKm2: 9.5   },
  { code: "AN024", istatProCode: "042024", name: "Montecarotto",        lng: 13.0680, lat: 43.5040, fallbackPop: 1930,  areaKm2: 20.4  },
  { code: "AN025", istatProCode: "042025", name: "Montemarciano",       lng: 13.3410, lat: 43.6430, fallbackPop: 11100, areaKm2: 22.4  },
  { code: "AN026", istatProCode: "042026", name: "Monte Roberto",       lng: 13.1760, lat: 43.5040, fallbackPop: 3460,  areaKm2: 12.2  },
  { code: "AN027", istatProCode: "042027", name: "Monte San Vito",      lng: 13.3260, lat: 43.6180, fallbackPop: 7060,  areaKm2: 21.8  },
  { code: "AN028", istatProCode: "042028", name: "Morro d'Alba",        lng: 13.1960, lat: 43.5800, fallbackPop: 3320,  areaKm2: 16.9  },
  { code: "AN029", istatProCode: "042029", name: "Numana",              lng: 13.6260, lat: 43.5080, fallbackPop: 3870,  areaKm2: 9.6   },
  { code: "AN030", istatProCode: "042030", name: "Offagna",             lng: 13.4130, lat: 43.5200, fallbackPop: 1980,  areaKm2: 8.7   },
  { code: "AN031", istatProCode: "042031", name: "Osimo",               lng: 13.4810, lat: 43.4834, fallbackPop: 34200, areaKm2: 101.2 },
  { code: "AN032", istatProCode: "042032", name: "Ostra",               lng: 13.1550, lat: 43.6190, fallbackPop: 7480,  areaKm2: 38.3  },
  { code: "AN033", istatProCode: "042033", name: "Ostra Vetere",        lng: 13.1020, lat: 43.6000, fallbackPop: 3220,  areaKm2: 28.4  },
  { code: "AN034", istatProCode: "042034", name: "Polverigi",           lng: 13.3960, lat: 43.5570, fallbackPop: 4440,  areaKm2: 15.8  },
  { code: "AN035", istatProCode: "042035", name: "Ripe",                lng: 13.1980, lat: 43.5980, fallbackPop: 3170,  areaKm2: 9.4   },
  { code: "AN036", istatProCode: "042036", name: "Rosora",              lng: 13.0870, lat: 43.4770, fallbackPop: 1810,  areaKm2: 16.3  },
  { code: "AN037", istatProCode: "042037", name: "San Marcello",        lng: 13.2070, lat: 43.5390, fallbackPop: 2260,  areaKm2: 8.6   },
  { code: "AN038", istatProCode: "042038", name: "Santa Maria Nuova",   lng: 13.3220, lat: 43.4950, fallbackPop: 4330,  areaKm2: 21.3  },
  { code: "AN039", istatProCode: "042039", name: "Sassoferrato",        lng: 12.8570, lat: 43.4360, fallbackPop: 7380,  areaKm2: 180.3 },
  { code: "AN040", istatProCode: "042040", name: "Senigallia",          lng: 13.2175, lat: 43.7151, fallbackPop: 44400, areaKm2: 119.0 },
  { code: "AN041", istatProCode: "042041", name: "Serra de' Conti",     lng: 13.0460, lat: 43.5420, fallbackPop: 3340,  areaKm2: 34.5  },
  { code: "AN042", istatProCode: "042042", name: "Serra San Quirico",   lng: 13.0780, lat: 43.4500, fallbackPop: 2960,  areaKm2: 29.4  },
  { code: "AN043", istatProCode: "042043", name: "Sirolo",              lng: 13.6175, lat: 43.5360, fallbackPop: 3890,  areaKm2: 10.6  },
  { code: "AN044", istatProCode: "042044", name: "Staffolo",            lng: 13.1760, lat: 43.4180, fallbackPop: 2290,  areaKm2: 24.4  },
];

/**
 * Attempt to fetch live population data from ISTAT SDMX REST API.
 * Dataset: DCIS_POPRES1 (Popolazione residente – bilancio demografico).
 * Returns a Map<istatProCode, population> or null on failure.
 */
async function fetchIstatPopulation(): Promise<Map<string, number> | null> {
  try {
    // SDMX REST v2 – JSON format
    // Filter: Province 042 (Ancona), latest period, total sex (9), total age (TOTAL)
    const url =
      "https://esploradati.istat.it/SDMXWS/rest/data/22_315/A.042+042001+042002+042003+042004+042005+042006+042007+042008+042009+042010+042011+042012+042013+042014+042015+042016+042017+042018+042019+042020+042021+042022+042023+042024+042025+042026+042027+042028+042029+042030+042031+042032+042033+042034+042035+042036+042037+042038+042039+042040+042041+042042+042043+042044.9.99.TOTAL/?format=jsondata&lastNObservations=1";

    const resp = await fetch(url, {
      headers: { Accept: "application/vnd.sdmx.data+json;version=1.0.0-wd" },
      signal: AbortSignal.timeout(30_000),
    });

    if (!resp.ok) {
      console.warn(`[ISTAT] SDMX API returned ${resp.status}`);
      return null;
    }

    const json = await resp.json() as any;
    const popMap = new Map<string, number>();

    // Parse SDMX-JSON structure
    const dataset = json?.dataSets?.[0];
    const series = dataset?.series;
    if (!series) return null;

    // Dimensions: 0=FREQ, 1=ITTER107 (territory), 2=SEXISTAT1 (sex), 3=ETA1 (age class), 4=STATCIV2
    const territories = json?.structure?.dimensions?.series?.find(
      (d: any) => d.id === "ITTER107"
    )?.values;
    if (!territories) return null;

    for (const [seriesKey, seriesValue] of Object.entries(series)) {
      const dims = seriesKey.split(":");
      const terrIdx = parseInt(dims[1], 10);
      const territory = territories[terrIdx];
      if (!territory?.id) continue;
      // territory.id is like "042001" (province + municipality)
      const terrCode = territory.id;
      // Only keep municipality-level codes (6 digits, not the province "042")
      if (terrCode.length !== 6) continue;
      const obs = (seriesValue as any)?.observations;
      if (!obs) continue;
      // Last observation value
      const obsKeys = Object.keys(obs);
      if (obsKeys.length === 0) continue;
      const lastObs = obs[obsKeys[obsKeys.length - 1]];
      const pop = Array.isArray(lastObs) ? lastObs[0] : null;
      if (typeof pop === "number" && pop > 0) {
        popMap.set(terrCode, pop);
      }
    }

    if (popMap.size === 0) return null;
    console.log(`[ISTAT] Fetched live population for ${popMap.size} municipalities`);
    return popMap;
  } catch (err) {
    console.warn("[ISTAT] Failed to fetch from SDMX API, using fallback data:", (err as Error).message);
    return null;
  }
}

export async function syncCensusFromIstat(): Promise<{ inserted: number; source: string }> {
  // Try live ISTAT data first
  const livePopulation = await fetchIstatPopulation();
  const source = livePopulation ? "istat-api" : "static-fallback";

  let inserted = 0;
  for (const c of ANCONA_COMUNI) {
    const pop = livePopulation?.get(c.istatProCode) ?? c.fallbackPop;
    const density = c.areaKm2 > 0 ? pop / c.areaKm2 : 0;
    await db.execute(sql`
      INSERT INTO census_sections (istat_code, centroid_lng, centroid_lat, population, area_km2, density)
      VALUES (${c.code}, ${c.lng}, ${c.lat}, ${pop}, ${c.areaKm2}, ${density})
      ON CONFLICT (istat_code) DO UPDATE SET
        centroid_lng = EXCLUDED.centroid_lng,
        centroid_lat = EXCLUDED.centroid_lat,
        population   = EXCLUDED.population,
        area_km2     = EXCLUDED.area_km2,
        density      = EXCLUDED.density,
        updated_at   = NOW()
    `);
    inserted++;
  }
  return { inserted, source };
}

// ─── Cron routes (protected by CRON_SECRET) ───────────────────────────────────

router.post("/cron/traffic", async (req, res) => {
  if (!verifyCronSecret(req, res)) return;
  try {
    const result = await syncTrafficFromTomTom();
    res.json({ success: true, ...result });
  } catch (err: any) {
    req.log.error(err, "Error in traffic cron");
    res.status(500).json({ success: false, message: err.message ?? "Internal error" });
  }
});

router.post("/cron/poi", async (req, res) => {
  if (!verifyCronSecret(req, res)) return;
  try {
    const result = await syncPoiFromOsm();
    res.json({ success: true, ...result, message: `Upserted ${result.inserted} POIs from OSM` });
  } catch (err: any) {
    req.log.error(err, "Error in POI cron");
    res.status(500).json({ success: false, message: err.message ?? "Internal error" });
  }
});

router.post("/cron/population", async (req, res) => {
  if (!verifyCronSecret(req, res)) return;
  try {
    const result = await syncCensusFromIstat();
    res.json({
      success: true,
      ...result,
      message: `Upserted ${result.inserted} comuni (source: ${result.source})`,
    });
  } catch (err: any) {
    req.log.error(err, "Error in population cron");
    res.status(500).json({ success: false, message: err.message ?? "Internal error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ISTAT Matrice del pendolarismo 2011 (O/D inter-comunale)
//   Sorgente: Censimento popolazione 2011, file fixed-width pubblico.
//   I record `S` rappresentano i flussi inter-comunali aggregati per
//   (origine, destinazione, motivo). Il dettaglio mezzo/orario/durata è
//   disponibile solo nei record `L` (intra-comunali) — qui ignorati.
// ─────────────────────────────────────────────────────────────────────────────

const ISTAT_PENDOLO_URL =
  "http://www.istat.it/storage/cartografia/matrici_pendolarismo/matrici_pendolarismo_2011.zip";
const ISTAT_PENDOLO_TXT_NAME = "MATRICE PENDOLARISMO 2011/matrix_pendo2011_10112014.txt";

/**
 * Lista ufficiale comuni provincia di Ancona (042) al 1 gennaio 2011 —
 * estratta dal file `Codici Comuni italiani` allegato alla matrice.
 * Chiave = codice 6-cifre PRO_COM_T, valore = denominazione ufficiale.
 */
const ANCONA_COMUNI_2011_NAMES: Record<string, string> = {
  "042001": "Agugliano",
  "042002": "Ancona",
  "042003": "Arcevia",
  "042004": "Barbara",
  "042005": "Belvedere Ostrense",
  "042006": "Camerano",
  "042007": "Camerata Picena",
  "042008": "Castelbellino",
  "042009": "Castel Colonna",
  "042010": "Castelfidardo",
  "042011": "Castelleone di Suasa",
  "042012": "Castelplanio",
  "042013": "Cerreto d'Esi",
  "042014": "Chiaravalle",
  "042015": "Corinaldo",
  "042016": "Cupramontana",
  "042017": "Fabriano",
  "042018": "Falconara Marittima",
  "042019": "Filottrano",
  "042020": "Genga",
  "042021": "Jesi",
  "042022": "Loreto",
  "042023": "Maiolati Spontini",
  "042024": "Mergo",
  "042025": "Monsano",
  "042026": "Montecarotto",
  "042027": "Montemarciano",
  "042028": "Monterado",
  "042029": "Monte Roberto",
  "042030": "Monte San Vito",
  "042031": "Morro d'Alba",
  "042032": "Numana",
  "042033": "Offagna",
  "042034": "Osimo",
  "042035": "Ostra",
  "042036": "Ostra Vetere",
  "042037": "Poggio San Marcello",
  "042038": "Polverigi",
  "042039": "Ripe",
  "042040": "Rosora",
  "042041": "San Marcello",
  "042042": "San Paolo di Jesi",
  "042043": "Santa Maria Nuova",
  "042044": "Sassoferrato",
  "042045": "Senigallia",
  "042046": "Serra de' Conti",
  "042047": "Serra San Quirico",
  "042048": "Sirolo",
  "042049": "Staffolo",
};

/**
 * Calcola il centroide geografico di ogni comune aggregando le sezioni
 * censuarie (table `census_sections`). Restituisce mappa codice6 → coords.
 * Il `census_sections.istat_code` è 12 caratteri: PRO_COM (5 senza zero
 * leading) + LOC (4) + SEZ (3) — i primi 5 caratteri identificano il comune.
 */
async function buildMunicipalityCentroidsFromCensus(provinceCode: string): Promise<
  Map<string, { lat: number; lng: number; population: number }>
> {
  // Per provincia "042" → prefisso census = "42" (senza leading 0)
  const provNum = String(parseInt(provinceCode, 10)); // "042" → "42"
  const rows = await db.execute(sql`
    SELECT SUBSTRING(istat_code, 1, 5) AS muni5,
           AVG(centroid_lat)::float8 AS lat,
           AVG(centroid_lng)::float8 AS lng,
           SUM(COALESCE(population, 0))::int AS pop
    FROM census_sections
    WHERE istat_code IS NOT NULL
      AND SUBSTRING(istat_code, 1, ${provNum.length}) = ${provNum}
    GROUP BY 1
  `);
  const m = new Map<string, { lat: number; lng: number; population: number }>();
  for (const r of rows.rows as any[]) {
    // muni5 = "42001"  → standard ISTAT 6-cifre = "0" + "42" + last3 = "042001"
    const muni5 = String(r.muni5);
    const last3 = muni5.slice(-3);
    const code6 = `${provinceCode}${last3}`;
    if (typeof r.lat === "number" && typeof r.lng === "number") {
      m.set(code6, { lat: r.lat, lng: r.lng, population: Number(r.pop) || 0 });
    }
  }
  return m;
}

/**
 * Sync ISTAT commuting matrix (origine→destinazione) for the area of interest.
 * Filters to inter-comunal flows where origin AND destination are within the
 * configured province (default 042 = Ancona). Coordinates come from real
 * census-sections centroids; names from the official ISTAT 2011 list.
 */
export async function syncCommutingOdFromIstat(opts?: {
  provinceCode?: string;
  url?: string;
}): Promise<{ inserted: number; source: string; parsed: number; kept: number }> {
  const province = opts?.provinceCode ?? "042";
  const url = opts?.url ?? ISTAT_PENDOLO_URL;

  // Risolvi coordinate dai centroidi census + nomi dalla lista ufficiale
  const coords = await buildMunicipalityCentroidsFromCensus(province);
  const nameMap: Record<string, string> = ANCONA_COMUNI_2011_NAMES; // estendibile per altre province
  const muniInfo = new Map<string, { name: string; lat: number; lng: number }>();
  for (const [code, c] of coords.entries()) {
    muniInfo.set(code, {
      name: nameMap[code] ?? `Comune ${code}`,
      lat: c.lat,
      lng: c.lng,
    });
  }
  console.log(`[ISTAT-OD] Mapping comuni: ${muniInfo.size} (provincia ${province})`);

  // 1. Download ZIP (cache in /tmp)
  const tmpDir = os.tmpdir();
  const zipPath = path.join(tmpDir, "istat_pendo_2011.zip");
  const stat = fs.existsSync(zipPath) ? fs.statSync(zipPath) : null;
  if (!stat || stat.size < 5_000_000) {
    console.log(`[ISTAT-OD] Scarico ${url}…`);
    const resp = await fetch(url, { signal: AbortSignal.timeout(240_000) });
    if (!resp.ok) throw new Error(`ISTAT download HTTP ${resp.status}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    await fsp.writeFile(zipPath, buf);
    console.log(`[ISTAT-OD] Scaricato ${(buf.length / 1024 / 1024).toFixed(1)} MB`);
  } else {
    console.log(`[ISTAT-OD] Uso cache ${zipPath} (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);
  }

  // 2. Estrai il txt
  const extractDir = path.join(tmpDir, "istat_pendo_extract");
  await fsp.mkdir(extractDir, { recursive: true });
  const txtPath = path.join(extractDir, "matrix_pendo2011_10112014.txt");
  const tStat = fs.existsSync(txtPath) ? fs.statSync(txtPath) : null;
  if (!tStat || tStat.size < 100_000_000) {
    const r = spawnSync("unzip", ["-o", "-j", zipPath, ISTAT_PENDOLO_TXT_NAME, "-d", extractDir], {
      stdio: "pipe",
    });
    if (r.status !== 0) throw new Error(`unzip failed: ${r.stderr?.toString() || r.stdout?.toString()}`);
  }

  // 3. Parsa per linea, aggrega per (origin, dest, reason)
  type Agg = { origin: string; dest: string; reason: string; flow: number };
  const aggregated = new Map<string, Agg>();
  let parsed = 0;
  let kept = 0;

  const stream = fs.createReadStream(txtPath, { encoding: "latin1" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line || line.length < 48) continue;
    if (line[0] !== "S") continue;
    parsed++;

    // Layout fixed-width (1-based positions, derivato da ispezione file):
    //   1   tipo (S/L)
    //   5- 7  PROV_RES (3)
    //   9-11  COM_RES  (3)
    //  14    MOTIVO (1=lavoro, 2=studio)
    //  20-22 PROV_DEST (3)
    //  24-26 COM_DEST  (3)
    //  39-48 NUMERO_STIMATO (10, formato "0000254.00")
    const provRes = line.substring(4, 7);
    const comRes = line.substring(8, 11);
    const motivo = line.substring(13, 14);
    const provDest = line.substring(19, 22);
    const comDest = line.substring(23, 26);
    const numStr = line.substring(38, 48).trim();

    if (provRes !== province || provDest !== province) continue;

    const origin = `${provRes}${comRes}`;
    const dest = `${provDest}${comDest}`;
    if (origin === dest) continue;
    if (!muniInfo.has(origin) || !muniInfo.has(dest)) continue;

    const num = parseFloat(numStr);
    if (!Number.isFinite(num) || num <= 0) continue;

    const reason = motivo === "1" ? "work" : motivo === "2" ? "study" : "other";
    const key = `${origin}|${dest}|${reason}`;
    const ex = aggregated.get(key);
    if (ex) ex.flow += num;
    else aggregated.set(key, { origin, dest, reason, flow: num });
    kept++;
  }

  console.log(
    `[ISTAT-OD] parsed=${parsed} kept=${kept} aggregated=${aggregated.size} (provincia ${province})`,
  );

  // 4. Truncate + bulk insert
  await db.execute(sql`TRUNCATE istat_commuting_od`);

  const rows = Array.from(aggregated.values());
  const BATCH = 500;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const values = batch.map((r) => {
      const o = muniInfo.get(r.origin)!;
      const d = muniInfo.get(r.dest)!;
      return {
        originIstat: r.origin,
        originName: o.name,
        originLat: o.lat,
        originLon: o.lng,
        destIstat: r.dest,
        destName: d.name,
        destLat: d.lat,
        destLon: d.lng,
        reason: r.reason,
        mode: null,
        timeSlot: null,
        durationMin: null,
        flow: Math.round(r.flow),
      };
    });
    await db.insert(istatCommutingOd).values(values);
    inserted += batch.length;
  }

  return { inserted, source: "istat-pendolarismo-2011", parsed, kept };
}

router.post("/cron/commuting", async (req, res) => {
  if (!verifyCronSecret(req, res)) return;
  try {
    const province = (req.query.province as string | undefined) ?? "042";
    const result = await syncCommutingOdFromIstat({ provinceCode: province });
    res.json({
      success: true,
      ...result,
      message: `Importati ${result.inserted} archi O/D ISTAT (provincia ${province})`,
    });
  } catch (err: any) {
    req.log.error(err, "Error in commuting cron");
    res.status(500).json({ success: false, message: err.message ?? "Internal error" });
  }
});

export default router;
