/**
 * import-census-sections.ts — le sezioni di censimento ISTAT 2021 della provincia dell'azienda.
 *
 * Mette in census_sections le sezioni di censimento della provincia (centroide,
 * popolazione, superficie, densità e poligono), al posto delle righe che ci
 * sono: le analisi della rete e la copertura della popolazione le usano.
 *
 * Il file sono le basi territoriali 2021 dell'ISTAT, uno per regione:
 *   https://www.istat.it/storage/cartografia/basi_territoriali/2021/R<regione>_21.zip
 * (per esempio R11_21.zip per le Marche); dentro c'è R<regione>_21_WGS84.shp
 * col suo .dbf accanto.
 *
 * Uso (serve DATABASE_URL):
 *   pnpm --filter @workspace/scripts run import-census -- /percorso/R11_21_WGS84.shp [--province 042,041]
 *
 * Senza --province vale la provincia scritta in Amministrazione → Azienda
 * (Provincia ISTAT). Se nel file non c'è nessuna sezione delle province
 * chieste, la tabella resta com'è. Dopo, il pulsante «Popolazione» della
 * pagina Sincronizzazione non aggiunge più le righe dei comuni (tappa 6.30).
 */

// @ts-ignore — no type declarations for shapefile
import shapefile from "shapefile";
import proj4 from "proj4";
import { db, pool } from "@workspace/db";
import { censusSections } from "@workspace/db/schema";
import { sql } from "drizzle-orm";

// ── Le coordinate ────────────────────────────────────────────────────
// I file dell'ISTAT sono in WGS84 UTM 32N (EPSG:32632) per tutta l'Italia;
// nel database serve WGS84 geografico (EPSG:4326).
proj4.defs("EPSG:32632", "+proj=utm +zone=32 +datum=WGS84 +units=m +no_defs +type=crs");
const utmToWgs84 = proj4("EPSG:32632", "EPSG:4326");

/** I confini dell'Italia, larghi: un centroide fuori è una sezione degenere. */
const ITALIA = { latMin: 35, latMax: 47.5, lngMin: 6, lngMax: 19 };

const USO =
  "Uso: pnpm --filter @workspace/scripts run import-census -- <file .shp> [--province 042,041]\n" +
  "Il file è quello della regione dalle basi territoriali 2021 dell'ISTAT\n" +
  "(https://www.istat.it/storage/cartografia/basi_territoriali/2021/R<regione>_21.zip).\n" +
  "Senza --province vale la Provincia ISTAT scritta in Amministrazione → Azienda.";

/** Gli argomenti: il file (.shp, col .dbf accanto) e le province, se date; altrimenti un errore che dice come si usa. */
function leggiArgomenti(argv: string[]): { shp: string; dbf: string; province: number[] | null } {
  const resto = argv.filter((a) => a !== "--");
  let province: number[] | null = null;
  const file: string[] = [];
  for (let i = 0; i < resto.length; i++) {
    const a = resto[i];
    if (a === "--province" || a.startsWith("--province=")) {
      const valore = a.includes("=") ? a.slice(a.indexOf("=") + 1) : resto[++i];
      const codici = (valore ?? "").split(",").map((c) => c.trim()).filter(Boolean);
      if (!codici.length || codici.some((c) => !/^[0-9]{3}$/.test(c))) {
        throw new Error(`--province vuole codici ISTAT di tre cifre separati da virgole, come «042,041».\n${USO}`);
      }
      province = codici.map(Number);
    } else if (a.startsWith("--")) {
      throw new Error(`Opzione sconosciuta: ${a}\n${USO}`);
    } else {
      file.push(a);
    }
  }
  if (file.length !== 1 || !/\.shp$/i.test(file[0])) throw new Error(`Serve un file .shp, uno solo.\n${USO}`);
  return { shp: file[0], dbf: file[0].replace(/\.shp$/i, (m) => (m === ".SHP" ? ".DBF" : ".dbf")), province };
}

/** La provincia dell'azienda (Amministrazione → Azienda), come numero: «042» → 42. */
async function provinciaDellAzienda(): Promise<number[]> {
  const r = await db.execute<any>(sql`SELECT provincia_istat FROM azienda WHERE unica`);
  const p = r.rows?.[0]?.provincia_istat;
  if (typeof p !== "string" || !/^[0-9]{3}$/.test(p)) {
    throw new Error(`La Provincia ISTAT dell'azienda non è scritta (Amministrazione → Azienda): scrivila lì, o passala con --province.\n${USO}`);
  }
  return [Number(p)];
}

/** Il centroide di un anello (coordinate UTM), riportato in WGS84. */
function computeCentroid(rings: number[][][]): { lng: number; lat: number } {
  // Si usa l'anello esterno (il primo)
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
    // Poligono degenere: la media dei vertici
    const sumX = ring.reduce((s, p) => s + p[0], 0);
    const sumY = ring.reduce((s, p) => s + p[1], 0);
    const [lng, lat] = utmToWgs84.forward([sumX / ring.length, sumY / ring.length]);
    return { lng, lat };
  }

  cx /= (6 * area);
  cy /= (6 * area);

  const [lng, lat] = utmToWgs84.forward([cx, cy]);
  return { lng, lat };
}

/** Il poligono da UTM 32N a WGS84, con le coordinate a 6 decimali (per la mappa a colori). */
function reprojectGeometry(geometry: any): any {
  const reproj = (coord: number[]): number[] => {
    const [lng, lat] = utmToWgs84.forward(coord);
    return [Math.round(lng * 1e6) / 1e6, Math.round(lat * 1e6) / 1e6];
  };

  if (geometry.type === "Polygon") {
    return {
      type: "Polygon",
      coordinates: geometry.coordinates.map((ring: number[][]) => ring.map(reproj)),
    };
  } else if (geometry.type === "MultiPolygon") {
    return {
      type: "MultiPolygon",
      coordinates: geometry.coordinates.map((poly: number[][][]) =>
        poly.map((ring: number[][]) => ring.map(reproj))
      ),
    };
  }
  return null;
}

async function main() {
  const { shp, dbf, province: chieste } = leggiArgomenti(process.argv.slice(2));
  const province = new Set(chieste ?? (await provinciaDellAzienda()));
  const elenco = [...province].map((p) => String(p).padStart(3, "0")).join(", ");

  console.log(`Leggo ${shp} (province ${elenco})…`);
  const source = await shapefile.open(shp, dbf);

  // ── 1. Le sezioni delle province chieste ───────────────────────────
  const sections: {
    istatCode: string;
    centroidLng: number;
    centroidLat: number;
    population: number;
    areaKm2: number;
    density: number;
    geojson: any;
  }[] = [];

  let totalRead = 0;
  let skipped = 0;
  let fuori = 0;

  while (true) {
    const { done, value } = await source.read();
    if (done) break;
    totalRead++;

    const props = value.properties;
    // COD_UTS: la provincia (o la città metropolitana) della sezione
    if (!province.has(Number(props.COD_UTS))) {
      skipped++;
      continue;
    }

    const sezId = String(props.SEZ21_ID);
    const pop = props.POP21 ?? 0;
    const shapeAreaM2 = props.SHAPE_Area ?? 0;
    const areaKm2 = shapeAreaM2 / 1_000_000;
    const density = areaKm2 > 0 ? pop / areaKm2 : 0;

    let centroid: { lng: number; lat: number };
    if (value.geometry?.type === "Polygon") {
      centroid = computeCentroid(value.geometry.coordinates);
    } else if (value.geometry?.type === "MultiPolygon") {
      // Il centroide del poligono più grande
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
      continue; // non è un poligono
    }

    // Un centroide fuori dall'Italia: una sezione minuscola o degenere
    if (centroid.lat < ITALIA.latMin || centroid.lat > ITALIA.latMax || centroid.lng < ITALIA.lngMin || centroid.lng > ITALIA.lngMax) {
      fuori++;
      continue;
    }

    sections.push({
      istatCode: sezId,
      centroidLng: Math.round(centroid.lng * 1_000_000) / 1_000_000,
      centroidLat: Math.round(centroid.lat * 1_000_000) / 1_000_000,
      population: pop,
      areaKm2: Math.round(areaKm2 * 1000) / 1000,
      density: Math.round(density * 10) / 10,
      geojson: reprojectGeometry(value.geometry),
    });
  }

  console.log(`Lette ${totalRead} sezioni: ${skipped} di altre province, ${fuori} con il centroide fuori dall'Italia.`);
  if (sections.length === 0) {
    throw new Error(`Nel file non c'è nessuna sezione delle province ${elenco}: è il file della regione giusta? La tabella resta com'è.`);
  }
  const populated = sections.filter((s) => s.population > 0);
  console.log(`${sections.length} sezioni delle province ${elenco}, ${sections.reduce((s, c) => s + c.population, 0).toLocaleString("it-IT")} abitanti`);
  console.log(`Sezioni abitate: ${populated.length} (${Math.round((populated.length / sections.length) * 100)}%); superficie media ${(sections.reduce((s, c) => s + c.areaKm2, 0) / sections.length).toFixed(3)} km²`);

  // ── 2. Al posto di quelle che ci sono, tutto o niente ──────────────
  const BATCH_SIZE = 500;
  await db.transaction(async (tx) => {
    await tx.delete(censusSections);
    for (let i = 0; i < sections.length; i += BATCH_SIZE) {
      await tx.insert(censusSections).values(sections.slice(i, i + BATCH_SIZE));
      process.stdout.write(`\r   ${Math.min(i + BATCH_SIZE, sections.length)}/${sections.length} inserite`);
    }
  });

  // ── 3. Verifica ────────────────────────────────────────────────────
  const verify = await db.execute(sql`
    SELECT COUNT(*)::int AS total,
           COALESCE(SUM(population), 0)::int AS pop,
           AVG(area_km2)::numeric(10,4) AS avg_area
    FROM census_sections
  `);
  const v = (verify.rows as any[])[0];
  console.log(`\nFatto: ${v.total} righe, ${Number(v.pop).toLocaleString("it-IT")} abitanti, superficie media ${v.avg_area} km²`);
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error(err instanceof Error ? err.message : err);
    await pool.end().catch(() => {});
    process.exit(1);
  });
