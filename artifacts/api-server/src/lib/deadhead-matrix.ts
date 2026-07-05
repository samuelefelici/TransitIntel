/**
 * Matrice fuorilinea (deadhead) — km stradali reali tra nodi (depositi e
 * capolinea), calcolati via OSRM /table (OSRM_URL, fallback al router pubblico)
 * con fallback Haversine × circuità quando OSRM non è raggiungibile o i nodi
 * sono troppi.
 *
 * La matrice è passata al solver turni macchina (vehicle_scheduler_cpsat.py)
 * che la usa per gli archi capolinea↔capolinea e per le tratte reali di
 * uscita/rientro deposito. Chiave coppia: "lat5,lon5|lat5,lon5" (5 decimali,
 * identica su TS e Python). Valore: km stradali.
 */
import { haversineKm } from "./geo-utils";

export interface DHNode { lat: number; lon: number }

const OSRM_BASE = (process.env.OSRM_URL || "https://router.project-osrm.org").replace(/\/$/, "");
const ROAD_CIRCUITY = 1.35;
const OSRM_CHUNK = 40;           // nodi per lato per richiesta /table (coords ≤ 80)
const OSRM_TIMEOUT_MS = 8_000;   // per richiesta
const OSRM_BUDGET_MS = 25_000;   // budget totale: oltre → fallback Haversine
const MAX_MATRIX_NODES = 260;    // sopra questa soglia niente OSRM (troppe richieste)

export const dhKey = (lat: number, lon: number): string => `${lat.toFixed(5)},${lon.toFixed(5)}`;

/** Dedup dei nodi per chiave (5 decimali ≈ 1 m). */
export function dedupNodes(nodes: DHNode[]): DHNode[] {
  const seen = new Set<string>();
  const out: DHNode[] = [];
  for (const n of nodes) {
    if (n?.lat == null || n?.lon == null || !isFinite(n.lat) || !isFinite(n.lon)) continue;
    const k = dhKey(n.lat, n.lon);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(n);
  }
  return out;
}

/** Una chiamata OSRM /table sources×destinations → distanze in km (o null). */
async function osrmTable(sources: DHNode[], destinations: DHNode[]): Promise<number[][] | null> {
  const coords = [...sources, ...destinations]
    .map((n) => `${n.lon.toFixed(6)},${n.lat.toFixed(6)}`)
    .join(";");
  const srcIdx = sources.map((_, i) => i).join(";");
  const dstIdx = destinations.map((_, i) => i + sources.length).join(";");
  const url = `${OSRM_BASE}/table/v1/driving/${coords}?sources=${srcIdx}&destinations=${dstIdx}&annotations=distance`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), OSRM_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal: ctrl.signal });
    if (!resp.ok) return null;
    const data: any = await resp.json();
    if (data?.code !== "Ok" || !Array.isArray(data.distances)) return null;
    return data.distances.map((row: any[]) =>
      row.map((m: any) => (typeof m === "number" && isFinite(m) ? m / 1000 : NaN)));
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Matrice km per TUTTE le coppie ordinate sources×destinations (esclusa la
 * diagonale identica). OSRM a blocchi con budget; le coppie mancanti ricadono
 * su Haversine × circuità. Ritorna { matrix, osrmPairs, totalPairs }.
 */
export async function buildDeadheadKmMatrix(
  sources: DHNode[], destinations: DHNode[],
): Promise<{ matrix: Record<string, number>; osrmPairs: number; totalPairs: number }> {
  const src = dedupNodes(sources);
  const dst = dedupNodes(destinations);
  const matrix: Record<string, number> = {};
  let osrmPairs = 0;
  const deadline = Date.now() + OSRM_BUDGET_MS;
  const useOsrm = src.length + dst.length <= MAX_MATRIX_NODES * 2 && src.length > 0 && dst.length > 0;

  if (useOsrm) {
    for (let i = 0; i < src.length && Date.now() < deadline; i += OSRM_CHUNK) {
      const sChunk = src.slice(i, i + OSRM_CHUNK);
      for (let j = 0; j < dst.length && Date.now() < deadline; j += OSRM_CHUNK) {
        const dChunk = dst.slice(j, j + OSRM_CHUNK);
        const dists = await osrmTable(sChunk, dChunk);
        if (!dists) continue;
        for (let a = 0; a < sChunk.length; a++) {
          for (let b = 0; b < dChunk.length; b++) {
            const km = dists[a]?.[b];
            const kA = dhKey(sChunk[a].lat, sChunk[a].lon);
            const kB = dhKey(dChunk[b].lat, dChunk[b].lon);
            if (kA === kB) continue;
            if (typeof km === "number" && isFinite(km)) {
              matrix[`${kA}|${kB}`] = Math.round(km * 100) / 100;
              osrmPairs++;
            }
          }
        }
      }
    }
  }

  // Fallback Haversine × circuità per le coppie mancanti
  let totalPairs = 0;
  for (const a of src) {
    for (const b of dst) {
      const kA = dhKey(a.lat, a.lon);
      const kB = dhKey(b.lat, b.lon);
      if (kA === kB) continue;
      totalPairs++;
      const key = `${kA}|${kB}`;
      if (matrix[key] === undefined) {
        matrix[key] = Math.round(haversineKm(a.lat, a.lon, b.lat, b.lon) * ROAD_CIRCUITY * 100) / 100;
      }
    }
  }
  return { matrix, osrmPairs, totalPairs };
}
