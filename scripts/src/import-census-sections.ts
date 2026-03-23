/**
 * import-census-sections.ts
 *
 * Imports ISTAT 2021 census sections (sezioni censuarie) from the Marche region
 * shapefile into the Neon database, replacing the 44 municipal-level records
 * with ~5500 fine-grained section centroids for the Province of Ancona.
 *
 * Data source: https://www.istat.it/storage/cartografia/basi_territoriali/2021/R11_21.zip
 *
 * Usage:
 *   cd scripts && npx tsx src/import-census-sections.ts
 *
 * Requires env var DATABASE_URL (loaded from ../../.env via --env-file).
 */

// @ts-ignore — no type declarations for shapefile
import shapefile from "shapefile";
import proj4 from "proj4";
import { db } from "@workspace/db";
import { censusSections } from "@workspace/db/schema";
import { sql } from "drizzle-orm";

// ── Projection setup ─────────────────────────────────────────────────
// ISTAT shapefile is in WGS84 UTM Zone 32N (EPSG:32632)
// We need WGS84 geographic (EPSG:4326) for our DB
proj4.defs("EPSG:32632", "+proj=utm +zone=32 +datum=WGS84 +units=m +no_defs +type=crs");
const utmToWgs84 = proj4("EPSG:32632", "EPSG:4326");

/** Compute centroid of a polygon ring (array of [x,y] coords) */
function computeCentroid(rings: number[][][]): { lng: number; lat: number } {
  // Use all rings (outer + holes), weighted by area
  // For simplicity, just use the outer ring (first ring)
  const ring = rings[0];
  if (!ring || ring.length < 3) return { lng: 0, lat: 0 };

  let area = 0;
  let cx = 0;
  let cy = 0;

  for (let i = 0; i < ring.length - 1; i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xi1 = ring[i + 1][0], yi1 = ring[i + 1][1];
    const cross = xi * yi1 - xi1 * yi;
    area += cross;
    cx += (xi + xi1) * cross;
    cy += (yi + yi1) * cross;
  }

  area /= 2;
  if (Math.abs(area) < 1e-10) {
    // Degenerate polygon — use simple average
    const sumX = ring.reduce((s, p) => s + p[0], 0);
    const sumY = ring.reduce((s, p) => s + p[1], 0);
    const [lng, lat] = utmToWgs84.forward([sumX / ring.length, sumY / ring.length]);
    return { lng, lat };
  }

  cx /= (6 * area);
  cy /= (6 * area);

  // Reproject UTM → WGS84
  const [lng, lat] = utmToWgs84.forward([cx, cy]);
  return { lng, lat };
}

// ── Province filter ──────────────────────────────────────────────────
// ISTAT province codes for the area of interest
// 42 = Ancona (main province for TransitIntel)
// Uncomment others to include more provinces
const PROVINCE_CODES = new Set([42]);

async function main() {
  console.log("🔄 Opening shapefile R11_21_WGS84...");

  const source = await shapefile.open(
    "./data/SHP/R11_21_WGS84.shp",
    "./data/SHP/R11_21_WGS84.dbf"
  );

  // ── 1. Read all census sections for selected provinces ───────────
  const sections: {
    istatCode: string;
    centroidLng: number;
    centroidLat: number;
    population: number;
    areaKm2: number;
    density: number;
  }[] = [];

  let totalRead = 0;
  let skipped = 0;

  while (true) {
    const { done, value } = await source.read();
    if (done) break;
    totalRead++;

    const props = value.properties;
    const procom = props.PRO_COM;

    // Extract province code (first 2-3 digits of PRO_COM → UTS code)
    const codUts = props.COD_UTS;
    if (!PROVINCE_CODES.has(codUts)) {
      skipped++;
      continue;
    }

    const sezId = String(props.SEZ21_ID);
    const pop = props.POP21 ?? 0;
    const shapeAreaM2 = props.SHAPE_Area ?? 0;
    const areaKm2 = shapeAreaM2 / 1_000_000;
    const density = areaKm2 > 0 ? pop / areaKm2 : 0;

    // Compute centroid from geometry
    let centroid: { lng: number; lat: number };
    if (value.geometry.type === "Polygon") {
      centroid = computeCentroid(value.geometry.coordinates);
    } else if (value.geometry.type === "MultiPolygon") {
      // Use the largest polygon's centroid
      let largestArea = 0;
      let largestRings = value.geometry.coordinates[0];
      for (const polygon of value.geometry.coordinates) {
        const ring = polygon[0];
        let a = 0;
        for (let i = 0; i < ring.length - 1; i++) {
          a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
        }
        a = Math.abs(a / 2);
        if (a > largestArea) {
          largestArea = a;
          largestRings = polygon;
        }
      }
      centroid = computeCentroid(largestRings);
    } else {
      continue; // skip non-polygon
    }

    // Sanity check: centroid should be in reasonable range for Marche
    if (centroid.lat < 42.5 || centroid.lat > 44.0 || centroid.lng < 12.0 || centroid.lng > 14.0) {
      // Likely a tiny/degenerate section — skip
      continue;
    }

    sections.push({
      istatCode: sezId,
      centroidLng: Math.round(centroid.lng * 1_000_000) / 1_000_000,
      centroidLat: Math.round(centroid.lat * 1_000_000) / 1_000_000,
      population: pop,
      areaKm2: Math.round(areaKm2 * 1000) / 1000,
      density: Math.round(density * 10) / 10,
    });
  }

  console.log(`📊 Read ${totalRead} features total, ${skipped} skipped (other provinces)`);
  console.log(`📊 ${sections.length} census sections for province(s): ${[...PROVINCE_CODES].join(", ")}`);
  console.log(`📊 Total population: ${sections.reduce((s, c) => s + c.population, 0).toLocaleString()}`);

  // Show some stats
  const populated = sections.filter(s => s.population > 0);
  console.log(`📊 Populated sections: ${populated.length} (${Math.round(populated.length / sections.length * 100)}%)`);
  console.log(`📊 Average area: ${(sections.reduce((s, c) => s + c.areaKm2, 0) / sections.length).toFixed(3)} km²`);

  // ── 2. Clear existing census_sections and insert new ones ────────
  console.log("\n🗑️  Deleting existing census_sections...");
  await db.delete(censusSections);

  console.log(`📥 Inserting ${sections.length} census sections in batches...`);
  const BATCH_SIZE = 500;
  let inserted = 0;

  for (let i = 0; i < sections.length; i += BATCH_SIZE) {
    const batch = sections.slice(i, i + BATCH_SIZE);
    await db.insert(censusSections).values(batch);
    inserted += batch.length;
    process.stdout.write(`\r   ${inserted}/${sections.length} inserted`);
  }

  console.log(`\n✅ Done! Inserted ${inserted} census sections.`);

  // ── 3. Verification ──────────────────────────────────────────────
  const verify = await db.execute(sql`
    SELECT COUNT(*)::int AS total,
           COALESCE(SUM(population), 0)::int AS pop,
           AVG(area_km2)::numeric(10,4) AS avg_area
    FROM census_sections
  `);
  const v = (verify.rows as any[])[0];
  console.log(`\n📋 Verification: ${v.total} rows, ${parseInt(v.pop).toLocaleString()} population, avg area ${v.avg_area} km²`);

  process.exit(0);
}

main().catch((err) => {
  console.error("❌ Error:", err);
  process.exit(1);
});
