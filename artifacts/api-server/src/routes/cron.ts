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
import { syncAllRailwaySchedules } from "./intermodal";
import { cronDeiDati } from "../lib/segreto-cron";
import { leggiAzienda } from "../lib/azienda";
import { leggiComuni, leggiLuoghi, nomeOppure, nomiComuni } from "../lib/territorio";

const router: IRouter = Router();

/* le cron dei dati: CRON_SECRET, confrontato a tempo costante (lib/segreto-cron.ts) */
const verifyCronSecret = cronDeiDati;

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

/* Dove cercare i punti d'interesse: i luoghi del territorio con uso
   «punti_interesse» e il loro raggio (lib/territorio.ts, tappa 6.1). */
async function luoghiDiRicerca(): Promise<Array<{ name: string; lat: number; lng: number; radius: number }>> {
  return (await leggiLuoghi("punti_interesse")).map(l => ({ name: l.nome, lat: l.lat, lng: l.lng, radius: l.raggioM ?? 3000 }));
}

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
  /* prima di cancellare i punti d'interesse che ci sono: senza luoghi non si cerca niente */
  const SEARCH_LOCATIONS = await luoghiDiRicerca();
  if (!SEARCH_LOCATIONS.length) {
    throw new Error("Nessun luogo dove cercare i punti d'interesse: aggiungili in Amministrazione › Azienda › Territorio");
  }

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

// I punti stradali di cui si legge il traffico sono luoghi del territorio
// dell'azienda (uso «traffico», lib/territorio.ts): il nome è l'identificativo
// delle rilevazioni di un punto.

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

  for (const point of await leggiLuoghi("traffico")) {
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
        segmentId: point.nome,
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
 *    (dati.istat.it – dataset DCIS_POPRES1, latest year, la provincia e i comuni del territorio).
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

/* I comuni, il loro centroide, la superficie, la popolazione di riferimento e
   la riga che tengono in census_sections vengono dal territorio dell'azienda
   (territorio_comuni, tappa 6.1). Prima stavano qui, con i codici ISTAT
   sfasati sui nomi («042001» chiamato Ancona, che è Agugliano): la
   popolazione letta dall'ISTAT finiva sul comune sbagliato. */

/**
 * Attempt to fetch live population data from ISTAT SDMX REST API.
 * Dataset: DCIS_POPRES1 (Popolazione residente – bilancio demografico).
 * Returns a Map<istatProCode, population> or null on failure.
 */
async function fetchIstatPopulation(provincia: string | null, codici: string[]): Promise<Map<string, number> | null> {
  /* solo codici di cifre (lo dice anche il vincolo della tabella): finiscono in un URL */
  const territori = [...(provincia ? [provincia] : []), ...codici].filter(c => /^[0-9]{3}$|^[0-9]{6}$/.test(c));
  if (!codici.length) return null;
  try {
    // SDMX REST v2 – JSON format
    // Filter: la provincia e i comuni del territorio, latest period, total sex (9), total age (TOTAL)
    const url =
      `https://esploradati.istat.it/SDMXWS/rest/data/22_315/A.${territori.join("+")}.9.99.TOTAL/?format=jsondata&lastNObservations=1`;

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
  /* i comuni attuali con centroide e superficie; la riga del censimento è quella che il
     comune tiene (per Conerobus «AN0xx», come prima), o «C» e il codice */
  const comuni = (await leggiComuni()).filter(c => !c.soppresso && c.lat != null && c.lng != null && c.areaKm2 != null);
  const { provinciaIstat } = await leggiAzienda();
  // Try live ISTAT data first
  const livePopulation = await fetchIstatPopulation(provinciaIstat, comuni.map(c => c.codiceIstat));
  const source = livePopulation ? "istat-api" : "static-fallback";

  let inserted = 0;
  for (const c of comuni) {
    const pop = livePopulation?.get(c.codiceIstat) ?? c.popolazione;
    if (pop == null) continue;
    const area = c.areaKm2!;
    const density = area > 0 ? pop / area : 0;
    const sezione = c.sezioneCensimento ?? `C${c.codiceIstat}`;
    await db.execute(sql`
      INSERT INTO census_sections (istat_code, centroid_lng, centroid_lat, population, area_km2, density)
      VALUES (${sezione}, ${c.lng}, ${c.lat}, ${pop}, ${area}, ${density})
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

// Controllo settimanale AVM: archivia le settimane chiuse che non hanno ancora
// un controllo (lo fa già da sé il processo dell'API ogni ora; questo serve a
// chi lo vuole lanciare da fuori, per esempio il lunedì alle 4:00). Idempotente.
router.post("/cron/avm-controllo-settimanale", async (req, res) => {
  if (!verifyCronSecret(req, res)) return;
  try {
    const { assicuraArchivio, statoArchivioAutomatico } = await import("../lib/avm-controllo-servizio");
    const archiviate = await assicuraArchivio();
    res.json({ success: true, archiviate, stato: statoArchivioAutomatico() });
  } catch (err: any) {
    req.log.error(err, "Error in avm-controllo-settimanale cron");
    res.status(500).json({ success: false, message: err.message ?? "Internal error" });
  }
});

// Orari treni (coincidenze bus↔treno): acquisizione AUTOMATICA da ViaggiaTreno
// per gli hub ferroviari del feed in esercizio. Schedulalo ~1/giorno (ViaggiaTreno
// espone solo una finestra mobile di 7 giorni). Poi /intermodal/analyze valuta le
// coincidenze con gli orari aggiornati.
router.post("/cron/intermodal-schedules", async (req, res) => {
  if (!verifyCronSecret(req, res)) return;
  try {
    const result = await syncAllRailwaySchedules();
    res.json({ success: true, ...result });
  } catch (err: any) {
    req.log.error(err, "Error in intermodal-schedules cron");
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
  /* la provincia: quella chiesta, o quella dell'azienda (tappa 6.1) */
  const province = opts?.provinceCode ?? (await leggiAzienda()).provinciaIstat;
  if (!province || !/^[0-9]{3}$/.test(province)) {
    throw new Error("Provincia ISTAT non impostata: indicala in Amministrazione › Azienda (tre cifre, come «042»)");
  }
  const url = opts?.url ?? ISTAT_PENDOLO_URL;

  // Risolvi coordinate dai centroidi census + nomi dal territorio dell'azienda (anche i comuni soppressi del 2011)
  const coords = await buildMunicipalityCentroidsFromCensus(province);
  const nomi = await nomiComuni();
  const muniInfo = new Map<string, { name: string; lat: number; lng: number }>();
  for (const [code, c] of coords.entries()) {
    muniInfo.set(code, {
      name: nomeOppure(code, nomi),
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
    const chiesta = req.query.province === undefined ? undefined : String(req.query.province);
    if (chiesta !== undefined && !/^[0-9]{3}$/.test(chiesta)) { res.status(400).json({ success: false, message: "province: tre cifre, come 042" }); return; }
    const result = await syncCommutingOdFromIstat({ provinceCode: chiesta });
    const province = chiesta ?? (await leggiAzienda()).provinciaIstat;
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
