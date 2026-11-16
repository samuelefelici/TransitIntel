/**
 * Territory router — confini amministrativi (comuni) ricavati aggregando
 * le sezioni di censimento ISTAT per i primi 5 caratteri del `istat_code`
 * (= codice comune nel formato usato in DB, es. "42021" = Jesi).
 *
 * I confini reali del comune sono ottenuti facendo l'union dei poligoni
 * di tutte le sezioni che lo compongono (libreria `polygon-clipping`).
 *
 * I nomi dei comuni provengono da una mappa statica (Provincia di Ancona,
 * cod. 42) — duplicata da `scenarios.ts` per evitare dipendenze cross-router.
 *
 * Il risultato è memoizzato in-memory: i confini sono statici, quindi il
 * costo di union è pagato una sola volta dopo l'avvio del processo.
 */
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { censusSections } from "@workspace/db/schema";
import { isNotNull } from "drizzle-orm";
import polygonClipping from "polygon-clipping";
import { asyncHandler } from "../middlewares/error-handler";
import { nomeOppure, nomiComuni } from "../lib/territorio";

const router: IRouter = Router();

// I nomi dei comuni vengono dal territorio dell'azienda (lib/territorio.ts, tappa 6.1)

type Ring = number[][];        // [[lng,lat], ...]
type Polygon = Ring[];         // outer + holes
type MultiPolygon = Polygon[];

interface ComuneFeature {
  type: "Feature";
  properties: {
    code: string;             // 5-char ISTAT comune
    name: string;
    sectionCount: number;
    population: number;
  };
  geometry: { type: "MultiPolygon"; coordinates: number[][][][] };
}

interface ComuniBoundariesResponse {
  type: "FeatureCollection";
  features: ComuneFeature[];
  generatedAt: string;
  totalComuni: number;
  totalSections: number;
}

let cached: ComuniBoundariesResponse | null = null;
let buildingPromise: Promise<ComuniBoundariesResponse> | null = null;

/** Estrae i poligoni in formato `polygon-clipping` da una geometry GeoJSON. */
function extractPolygons(geom: any): MultiPolygon {
  if (!geom || typeof geom !== "object") return [];
  if (geom.type === "Polygon" && Array.isArray(geom.coordinates)) {
    return [geom.coordinates as Polygon];
  }
  if (geom.type === "MultiPolygon" && Array.isArray(geom.coordinates)) {
    return geom.coordinates as MultiPolygon;
  }
  return [];
}

async function buildComuniBoundaries(): Promise<ComuniBoundariesResponse> {
  const nomi = await nomiComuni();
  // 1) Carica tutte le sezioni con geometria
  const rows = await db
    .select({
      istatCode: censusSections.istatCode,
      population: censusSections.population,
      geojson: censusSections.geojson,
    })
    .from(censusSections)
    .where(isNotNull(censusSections.geojson));

  // 2) Raggruppa per codice comune (primi 5 char del codice ISTAT sezione)
  type Group = { polys: MultiPolygon; sections: number; pop: number };
  const groups = new Map<string, Group>();
  for (const r of rows) {
    if (!r.istatCode || r.istatCode.length < 5) continue;
    const code = r.istatCode.substring(0, 5);
    const polys = extractPolygons(r.geojson);
    if (polys.length === 0) continue;
    let g = groups.get(code);
    if (!g) {
      g = { polys: [], sections: 0, pop: 0 };
      groups.set(code, g);
    }
    g.polys.push(...polys);
    g.sections += 1;
    g.pop += r.population || 0;
  }

  // 3) Union dei poligoni per ogni comune
  const features: ComuneFeature[] = [];
  for (const [code, g] of groups) {
    let merged: MultiPolygon;
    try {
      const args = g.polys as any[];
      merged = (polygonClipping.union as any)(...args) as MultiPolygon;
    } catch {
      // fallback: lascia i poligoni separati come MultiPolygon
      merged = g.polys;
    }
    features.push({
      type: "Feature",
      properties: {
        code,
        name: nomeOppure(code, nomi),
        sectionCount: g.sections,
        population: g.pop,
      },
      geometry: { type: "MultiPolygon", coordinates: merged },
    });
  }

  // Ordina per nome
  features.sort((a, b) => a.properties.name.localeCompare(b.properties.name, "it"));

  return {
    type: "FeatureCollection",
    features,
    generatedAt: new Date().toISOString(),
    totalComuni: features.length,
    totalSections: rows.length,
  };
}

/** I nomi al momento della risposta: i confini restano in memoria, i nomi li cambia l'amministratore (6.1). */
async function conINomi(r: ComuniBoundariesResponse): Promise<ComuniBoundariesResponse> {
  const nomi = await nomiComuni();
  const features = r.features
    .map((f) => ({ ...f, properties: { ...f.properties, name: nomeOppure(f.properties.code, nomi) } }))
    .sort((a, b) => a.properties.name.localeCompare(b.properties.name, "it"));
  return { ...r, features };
}

/**
 * GET /api/territory/comuni-boundaries
 * Ritorna FeatureCollection con un MultiPolygon per comune (ricavato via
 * union delle sezioni di censimento). Risposta memoizzata in-memory.
 *
 * Query params (opzionali):
 *   - refresh=1  forza ricalcolo (cancella cache)
 */
router.get(
  "/territory/comuni-boundaries",
  asyncHandler(async (req, res) => {
    if (req.query.refresh === "1") {
      cached = null;
    }
    if (cached) {
      res.json(await conINomi(cached));
      return;
    }
    if (!buildingPromise) {
      buildingPromise = buildComuniBoundaries()
        .then((r) => {
          cached = r;
          return r;
        })
        .finally(() => {
          buildingPromise = null;
        });
    }
    const result = await buildingPromise;
    res.json(await conINomi(result));
  })
);

export default router;
