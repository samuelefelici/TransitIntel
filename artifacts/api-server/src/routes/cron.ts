import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { trafficSnapshots, pointsOfInterest, censusSections } from "@workspace/db/schema";
import { sql } from "drizzle-orm";

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

export async function syncCensusFromIstat(): Promise<{ inserted: number }> {
  // Comuni della provincia di Ancona with real coords from Nominatim/OSM
  // Population data from ISTAT 2023 estimates
  const comuni: Array<{
    code: string; name: string; lng: number; lat: number; pop: number; areaKm2: number;
  }> = [
    { code: "AN001", name: "Ancona",             lng: 13.5185, lat: 43.6166, pop: 99470, areaKm2: 124.2 },
    { code: "AN002", name: "Agugliano",           lng: 13.3750, lat: 43.5450, pop: 5070,  areaKm2: 16.1  },
    { code: "AN003", name: "Barbara",             lng: 13.0280, lat: 43.5800, pop: 1360,  areaKm2: 13.5  },
    { code: "AN004", name: "Belvedere Ostrense",  lng: 13.1630, lat: 43.5640, pop: 2370,  areaKm2: 18.2  },
    { code: "AN005", name: "Camerano",            lng: 13.5350, lat: 43.5280, pop: 7490,  areaKm2: 17.0  },
    { code: "AN006", name: "Camerata Picena",     lng: 13.3210, lat: 43.5660, pop: 2810,  areaKm2: 15.0  },
    { code: "AN007", name: "Castelbellino",       lng: 13.1830, lat: 43.5160, pop: 3310,  areaKm2: 8.6   },
    { code: "AN008", name: "Castelfidardo",       lng: 13.5492, lat: 43.4616, pop: 19100, areaKm2: 29.4  },
    { code: "AN009", name: "Castelleone di Suasa",lng: 12.9830, lat: 43.6020, pop: 1620,  areaKm2: 22.0  },
    { code: "AN010", name: "Castelplanio",        lng: 13.1350, lat: 43.5270, pop: 3230,  areaKm2: 18.5  },
    { code: "AN011", name: "Cerreto d'Esi",       lng: 13.0520, lat: 43.3390, pop: 3870,  areaKm2: 29.1  },
    { code: "AN012", name: "Chiaravalle",         lng: 13.3222, lat: 43.5998, pop: 15200, areaKm2: 24.7  },
    { code: "AN013", name: "Corinaldo",           lng: 13.0480, lat: 43.6490, pop: 5180,  areaKm2: 47.5  },
    { code: "AN014", name: "Cupramontana",        lng: 13.1190, lat: 43.4440, pop: 4590,  areaKm2: 29.9  },
    { code: "AN015", name: "Fabriano",            lng: 12.9078, lat: 43.3368, pop: 29900, areaKm2: 272.2 },
    { code: "AN016", name: "Falconara Marittima", lng: 13.3940, lat: 43.6280, pop: 27600, areaKm2: 27.0  },
    { code: "AN017", name: "Filottrano",          lng: 13.3520, lat: 43.4380, pop: 9220,  areaKm2: 51.1  },
    { code: "AN018", name: "Genga",               lng: 12.9410, lat: 43.4280, pop: 1720,  areaKm2: 79.8  },
    { code: "AN019", name: "Jesi",                lng: 13.2436, lat: 43.5222, pop: 39600, areaKm2: 114.0 },
    { code: "AN020", name: "Loreto",              lng: 13.6075, lat: 43.4413, pop: 11000, areaKm2: 18.2  },
    { code: "AN021", name: "Maiolati Spontini",   lng: 13.1510, lat: 43.4940, pop: 7230,  areaKm2: 27.9  },
    { code: "AN022", name: "Mergo",               lng: 13.0660, lat: 43.4610, pop: 1050,  areaKm2: 8.8   },
    { code: "AN023", name: "Monsano",             lng: 13.2080, lat: 43.5610, pop: 3670,  areaKm2: 9.5   },
    { code: "AN024", name: "Montecarotto",        lng: 13.0680, lat: 43.5040, pop: 1930,  areaKm2: 20.4  },
    { code: "AN025", name: "Montemarciano",       lng: 13.3410, lat: 43.6430, pop: 11100, areaKm2: 22.4  },
    { code: "AN026", name: "Monte Roberto",       lng: 13.1760, lat: 43.5040, pop: 3460,  areaKm2: 12.2  },
    { code: "AN027", name: "Monte San Vito",      lng: 13.3260, lat: 43.6180, pop: 7060,  areaKm2: 21.8  },
    { code: "AN028", name: "Morro d'Alba",        lng: 13.1960, lat: 43.5800, pop: 3320,  areaKm2: 16.9  },
    { code: "AN029", name: "Numana",              lng: 13.6260, lat: 43.5080, pop: 3870,  areaKm2: 9.6   },
    { code: "AN030", name: "Offagna",             lng: 13.4130, lat: 43.5200, pop: 1980,  areaKm2: 8.7   },
    { code: "AN031", name: "Osimo",               lng: 13.4810, lat: 43.4834, pop: 34200, areaKm2: 101.2 },
    { code: "AN032", name: "Ostra",               lng: 13.1550, lat: 43.6190, pop: 7480,  areaKm2: 38.3  },
    { code: "AN033", name: "Ostra Vetere",        lng: 13.1020, lat: 43.6000, pop: 3220,  areaKm2: 28.4  },
    { code: "AN034", name: "Polverigi",           lng: 13.3960, lat: 43.5570, pop: 4440,  areaKm2: 15.8  },
    { code: "AN035", name: "Ripe",                lng: 13.1980, lat: 43.5980, pop: 3170,  areaKm2: 9.4   },
    { code: "AN036", name: "Rosora",              lng: 13.0870, lat: 43.4770, pop: 1810,  areaKm2: 16.3  },
    { code: "AN037", name: "San Marcello",        lng: 13.2070, lat: 43.5390, pop: 2260,  areaKm2: 8.6   },
    { code: "AN038", name: "Santa Maria Nuova",   lng: 13.3220, lat: 43.4950, pop: 4330,  areaKm2: 21.3  },
    { code: "AN039", name: "Sassoferrato",        lng: 12.8570, lat: 43.4360, pop: 7380,  areaKm2: 180.3 },
    { code: "AN040", name: "Senigallia",          lng: 13.2175, lat: 43.7151, pop: 44400, areaKm2: 119.0 },
    { code: "AN041", name: "Serra de' Conti",     lng: 13.0460, lat: 43.5420, pop: 3340,  areaKm2: 34.5  },
    { code: "AN042", name: "Serra San Quirico",   lng: 13.0780, lat: 43.4500, pop: 2960,  areaKm2: 29.4  },
    { code: "AN043", name: "Sirolo",              lng: 13.6175, lat: 43.5360, pop: 3890,  areaKm2: 10.6  },
    { code: "AN044", name: "Staffolo",            lng: 13.1760, lat: 43.4180, pop: 2290,  areaKm2: 24.4  },
  ];

  let inserted = 0;
  for (const c of comuni) {
    const density = c.areaKm2 > 0 ? c.pop / c.areaKm2 : 0;
    await db.execute(sql`
      INSERT INTO census_sections (istat_code, centroid_lng, centroid_lat, population, area_km2, density)
      VALUES (${c.code}, ${c.lng}, ${c.lat}, ${c.pop}, ${c.areaKm2}, ${density})
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
  return { inserted };
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
    res.json({ success: true, ...result, message: `Upserted ${result.inserted} comuni` });
  } catch (err: any) {
    req.log.error(err, "Error in population cron");
    res.status(500).json({ success: false, message: err.message ?? "Internal error" });
  }
});

export default router;
