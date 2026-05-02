/**
 * GTFS Fares — Telemaco Compliance: auto-assegnazione fermate ai nodi tariffari.
 *
 * INTERVENTO ADDITIVO: questo router NON modifica nessuna logica esistente
 * di fares.ts o fares-min-od.ts. Aggiunge una pipeline a 2 step (modello v2)
 * per garantire che ogni fermata fisica del feed sia collegata a un nodo
 * tariffario in modo PARTIZIONATO (no cluster annidati o sovrapposti).
 *
 * Pipeline v2 (primo match vince, ogni cluster è una partizione):
 *   Step 1  Urban Hub      — fermate servite da almeno 1 route urbana
 *                            confluiscono in un unico nodo per città
 *                            (urban_ancona, urban_jesi, urban_falconara,
 *                             urban_senigallia, urban_castelfidardo)
 *   Step 2  K-Means geo    — sulle fermate NON-urbane: addensamento
 *                            geografico via k-means++ (stessa logica
 *                            del bottone "auto-generate spatial" in
 *                            fares.ts). Identifica i centri abitati
 *                            serviti solo da linee extraurbane.
 *   Step 3  Manuale        — le fermate isolate restano orfane,
 *                            l'utente le assegna a mano via UI
 *
 * Layer dormienti (riattivabili via flag):
 *   useOfficialCatalog (catalogo Telemaco), useExactName (omonimi),
 *   useToken (token+prossimità), useDbscan (DBSCAN legacy v1),
 *   useSingleton (1 fermata = 1 cluster)
 *
 * Endpoints:
 *   POST   /api/fares/node-assignment/run
 *   GET    /api/fares/node-assignment/runs
 *   GET    /api/fares/node-assignment/report
 *   GET    /api/fares/node-assignment/low-confidence
 *   GET    /api/fares/node-assignment/ambiguous
 *   GET    /api/fares/node-assignment/orphans
 *
 *   GET    /api/fares/official-nodes
 *   POST   /api/fares/official-nodes
 *   POST   /api/fares/official-nodes/import-csv
 *   POST   /api/fares/official-nodes/import-atma-2013
 *   DELETE /api/fares/official-nodes/:id
 *
 *   POST   /api/fares/stop-assignment/move
 *   POST   /api/fares/stop-assignment/bulk-move
 *   GET    /api/fares/stop-assignment/overrides
 *   POST   /api/fares/stop-assignment/revert/:overrideId
 */
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  gtfsStops,
  gtfsRoutes,
  gtfsTrips,
  gtfsStopTimes,
  gtfsFareZoneClusters,
  gtfsFareZoneClusterStops,
  gtfsFareOfficialNodes,
  gtfsFareNodeAssignmentRuns,
  gtfsFareStopAssignmentOverrides,
} from "@workspace/db/schema";
import { eq, and, sql, inArray } from "drizzle-orm";
import { getLatestFeedId } from "./gtfs-helpers";
import { haversineKm } from "../lib/geo-utils";

const router: IRouter = Router();

// ════════════════════════════════════════════════════════════
// Lazy bootstrap (pattern del progetto). Idempotente.
// CREATE TABLE IF NOT EXISTS + ALTER TABLE … ADD COLUMN IF NOT EXISTS
// ════════════════════════════════════════════════════════════
let bootstrapped = false;
async function ensureNodeAssignmentTables(): Promise<void> {
  if (bootstrapped) return;

  // Colonne addittive su gtfs_fare_zone_clusters
  await db.execute(sql`ALTER TABLE gtfs_fare_zone_clusters ADD COLUMN IF NOT EXISTS is_official BOOLEAN NOT NULL DEFAULT FALSE;`);
  await db.execute(sql`ALTER TABLE gtfs_fare_zone_clusters ADD COLUMN IF NOT EXISTS official_code TEXT;`);

  // Colonne addittive su gtfs_fare_zone_cluster_stops
  await db.execute(sql`ALTER TABLE gtfs_fare_zone_cluster_stops ADD COLUMN IF NOT EXISTS assignment_layer TEXT;`);
  await db.execute(sql`ALTER TABLE gtfs_fare_zone_cluster_stops ADD COLUMN IF NOT EXISTS assignment_confidence INTEGER DEFAULT 0;`);
  await db.execute(sql`ALTER TABLE gtfs_fare_zone_cluster_stops ADD COLUMN IF NOT EXISTS assignment_source TEXT;`);
  await db.execute(sql`ALTER TABLE gtfs_fare_zone_cluster_stops ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ DEFAULT NOW();`);

  // Catalogo nodi ufficiali
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS gtfs_fare_official_nodes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      feed_id UUID NOT NULL REFERENCES gtfs_feeds(id) ON DELETE CASCADE,
      official_code TEXT NOT NULL,
      official_name TEXT NOT NULL,
      name_normalized TEXT NOT NULL,
      centroid_lat DOUBLE PRECISION,
      centroid_lon DOUBLE PRECISION,
      aliases JSONB DEFAULT '[]'::jsonb,
      source TEXT NOT NULL DEFAULT 'manual',
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS gtfs_fare_official_nodes_feed_code_idx ON gtfs_fare_official_nodes (feed_id, official_code);`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS gtfs_fare_official_nodes_name_idx ON gtfs_fare_official_nodes (feed_id, name_normalized);`);

  // Storico run pipeline
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS gtfs_fare_node_assignment_runs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      feed_id UUID NOT NULL REFERENCES gtfs_feeds(id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      total_stops INTEGER,
      assigned_by_layer JSONB,
      clusters_before INTEGER,
      clusters_after INTEGER,
      duration_ms INTEGER,
      error_message TEXT,
      params JSONB,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished_at TIMESTAMPTZ
    );
  `);

  // Audit override manuali
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS gtfs_fare_stop_assignment_overrides (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      feed_id UUID NOT NULL REFERENCES gtfs_feeds(id) ON DELETE CASCADE,
      stop_id TEXT NOT NULL,
      from_cluster_id TEXT,
      to_cluster_id TEXT,
      reason TEXT,
      actor TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS gtfs_fare_stop_overrides_stop_idx ON gtfs_fare_stop_assignment_overrides (feed_id, stop_id);`);

  bootstrapped = true;
}

// ════════════════════════════════════════════════════════════
// Normalizzazione e tokenizzazione
// ════════════════════════════════════════════════════════════

const STOPWORDS = new Set([
  "via", "piazza", "corso", "viale", "largo", "vicolo", "strada", "lungomare",
  "fermata", "stazione", "capolinea", "bivio", "incrocio", "rotonda", "rotatoria",
  "il", "la", "lo", "i", "gli", "le", "un", "una",
  "di", "del", "della", "dei", "degli", "delle", "da", "dalla", "dal",
  "a", "al", "alla", "ai", "agli", "alle",
  "in", "su", "sul", "sulla", "con", "per",
  "e", "ed", "o", "od",
]);

const TOKEN_IRRELEVANT = new Set([
  "via", "piazza", "corso", "viale", "largo", "vicolo", "strada", "fermata",
  "stazione", "capolinea", "bivio", "il", "la", "lo", "i", "gli", "le",
  "di", "del", "della", "dei", "degli", "delle", "da", "a", "in", "su",
  "con", "per", "e", "ed", "o",
]);

const ABBREVS: Record<string, string> = {
  "p.zza": "piazza", "p.za": "piazza", "pza": "piazza",
  "v.le": "viale", "vle": "viale",
  "c.so": "corso", "cso": "corso",
  "l.go": "largo",
  "s.s.": "ss", "s.p.": "sp",
  "sant'": "santo ", "s.": "santo ",
};

/**
 * Normalizza un nome fermata per matching robusto. Idempotente.
 * Esempi:
 *   "PIAZZA CAVOUR (cap.)"      → "cavour"
 *   "P.zza Cavour - Pensilina A" → "cavour"
 *   "ANCONA STAZIONE FS"         → "ancona fs"
 */
export function normalizeStopName(raw: string): string {
  let s = (raw || "").toLowerCase().trim();
  s = s.replace(/\([^)]*\)/g, " ");
  s = s.replace(/\b(fermata|stallo|pensilina|lato|piattaforma|paline|palina|stop|sn|snc)\s*[a-z0-9]*/gi, " ");
  for (const [k, v] of Object.entries(ABBREVS)) s = s.split(k).join(v);
  s = s.replace(/[^a-zàèéìòù0-9\s]/gi, " ");
  const tokens = s.split(/\s+/).filter(t => t.length > 0 && !STOPWORDS.has(t));
  tokens.sort();
  return tokens.join(" ").trim();
}

/**
 * Estrae token significativi (NON ordinati, mantiene ordine originale).
 * Tiene token > 3 char OR numerici (es. "12" in "via roma 12").
 */
export function extractSignificantTokens(raw: string): string[] {
  let s = (raw || "").toLowerCase().trim();
  s = s.replace(/\([^)]*\)/g, " ");
  s = s.replace(/\b(fermata|stallo|pensilina)\s*[a-z0-9]*/gi, " ");
  s = s.replace(/[^a-zàèéìòù0-9\s]/gi, " ");
  return s.split(/\s+/)
    .filter(t => t.length > 0 && !TOKEN_IRRELEVANT.has(t))
    .filter(t => t.length > 3 || /^\d+$/.test(t));
}

// ════════════════════════════════════════════════════════════
// Classificazione urbana (allineata a fares-min-od.ts)
// ════════════════════════════════════════════════════════════

/**
 * Mappa route_short_name → categoria.
 * Identica a `classifyRouteMinOd` in fares-min-od.ts (DUPLICATA volutamente
 * per non creare dipendenze cross-router; tenere allineate le due funzioni).
 */
function classifyRouteCategory(shortName: string | null | undefined): string {
  if (!shortName) return "extraurbano";
  const s = shortName.trim().toUpperCase();
  if (s.startsWith("JE")) return "urbano_jesi";
  if (s.startsWith("Y")) return "urbano_falconara";
  if (/^BUSS?\d/.test(s)) return "urbano_senigallia";
  if (s === "CIRCA" || s === "CIRCB") return "urbano_castelfidardo";
  if (/^\d/.test(s)) return "urbano_ancona";
  if (/^[A-Z]\.[A-Z]\.?$/.test(s)) return "urbano_ancona";
  return "extraurbano";
}

/** Nome leggibile per cluster urbano (es. "urbano_ancona" → "Urbano Ancona"). */
function urbanCategoryDisplayName(cat: string): string {
  if (!cat.startsWith("urbano_")) return cat;
  const city = cat.slice("urbano_".length);
  return "Urbano " + city.charAt(0).toUpperCase() + city.slice(1);
}

/**
 * Per ogni fermata del feed costruisce il conteggio dei passaggi (stop_times)
 * suddiviso per categoria urbana. Una route extraurbana NON contribuisce.
 *
 * Ritorna: Map<stopId, Map<urbanCategory, weight>>
 *   weight = numero di stop_times (proxy della "densità di servizio urbano")
 *
 * Una stop è considerata urbana se ha weight > 0 in almeno una categoria urbana.
 * In caso di più città, vince quella col weight massimo.
 */
async function loadStopUrbanWeights(feedId: string): Promise<Map<string, Map<string, number>>> {
  // Prima carico la classificazione di ogni route_id del feed
  const routes = await db.select({
    routeId: gtfsRoutes.routeId,
    shortName: gtfsRoutes.routeShortName,
  }).from(gtfsRoutes).where(eq(gtfsRoutes.feedId, feedId));

  const routeCategory = new Map<string, string>();
  for (const r of routes) {
    routeCategory.set(r.routeId, classifyRouteCategory(r.shortName));
  }

  // Aggregazione SQL: count stop_times per (stop_id, route_id)
  const rows = await db.execute<any>(sql`
    SELECT st.stop_id AS stop_id, t.route_id AS route_id, COUNT(*)::int AS cnt
    FROM gtfs_stop_times st
    JOIN gtfs_trips t ON t.feed_id = st.feed_id AND t.trip_id = st.trip_id
    WHERE st.feed_id = ${feedId}
    GROUP BY st.stop_id, t.route_id
  `);
  const data = (rows as any).rows ?? rows;

  const result = new Map<string, Map<string, number>>();
  for (const row of data) {
    const cat = routeCategory.get(row.route_id);
    if (!cat || !cat.startsWith("urbano_")) continue;  // solo categorie urbane
    const inner = result.get(row.stop_id) ?? new Map<string, number>();
    inner.set(cat, (inner.get(cat) ?? 0) + Number(row.cnt));
    result.set(row.stop_id, inner);
  }
  return result;
}

// ════════════════════════════════════════════════════════════
// Palette colori cluster (Telemaco)
// Genera colori distinti e ripetibili in modo deterministico a partire
// dal clusterId, così che lo stesso cluster mantenga sempre lo stesso colore
// fra run diversi. Usata per visualizzare la mappa zone senza confusione.
// I cluster ufficiali e i nodi urban_* hanno colori dedicati di alto contrasto.
// ════════════════════════════════════════════════════════════
const URBAN_HUB_COLORS: Record<string, string> = {
  ancona:        "#dc2626",  // rosso
  jesi:          "#7c3aed",  // viola
  falconara:     "#0891b2",  // ciano
  senigallia:    "#ea580c",  // arancio
  castelfidardo: "#16a34a",  // verde
};
const CLUSTER_PALETTE = [
  "#3b82f6", "#f59e0b", "#8b5cf6", "#ec4899", "#14b8a6",
  "#f97316", "#06b6d4", "#a855f7", "#84cc16", "#ef4444",
  "#0ea5e9", "#d946ef", "#22c55e", "#eab308", "#6366f1",
  "#f43f5e", "#10b981", "#fb923c", "#a78bfa", "#2dd4bf",
];

function hashString(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function colorForCluster(clusterId: string, isOfficial: boolean): string {
  if (clusterId.startsWith("urban_")) {
    const city = clusterId.slice("urban_".length);
    return URBAN_HUB_COLORS[city] ?? "#dc2626";
  }
  if (isOfficial) return "#10b981";  // verde catalogo ufficiale
  return CLUSTER_PALETTE[hashString(clusterId) % CLUSTER_PALETTE.length];
}

// ════════════════════════════════════════════════════════════
// Layer 0.5: Urban Hub
// I servizi urbani di una città formano un UNICO nodo tariffario.
// Una fermata servita da almeno una route urbana confluisce nel
// cluster urbano della città (mix urbano+extraurbano = vince urbano).
// ════════════════════════════════════════════════════════════
function applyUrbanHubLayer(
  stops: StopRecord[],
  stopUrbanWeights: Map<string, Map<string, number>>,
) {
  const assignments = new Map<string, string>();  // stopId → clusterId
  const clusters = new Map<string, { name: string; stops: StopRecord[] }>();

  for (const stop of stops) {
    const w = stopUrbanWeights.get(stop.stopId);
    if (!w || w.size === 0) continue;
    // città dominante = max weight
    let bestCat: string | null = null;
    let bestW = -1;
    for (const [cat, weight] of w) {
      if (weight > bestW) { bestW = weight; bestCat = cat; }
    }
    if (!bestCat) continue;
    const clusterId = `urban_${bestCat.slice("urbano_".length)}`;
    const clusterName = urbanCategoryDisplayName(bestCat);
    assignments.set(stop.stopId, clusterId);
    if (!clusters.has(clusterId)) clusters.set(clusterId, { name: clusterName, stops: [] });
    clusters.get(clusterId)!.stops.push(stop);
  }
  return { assignments, clusters };
}

// ════════════════════════════════════════════════════════════
// Step 1.5: ABSORB extra-in-urban
// ─────────────────────────────────────────────────────────────
// Dopo lo Step 1 ogni cluster urbano contiene SOLO le fermate
// servite da linee urbane. Però spesso, in mezzo al perimetro
// urbano (es. dentro Falconara), ci sono fermate servite SOLO
// da linee extraurbane: tariffariamente appartengono al nodo
// urbano, ma se non assorbite finiscono nel k-means dello Step 2
// formando cluster spuri.
//
// Questo step, per ogni fermata ancora non assegnata, calcola
// la fermata urbana più vicina già assegnata. Se la distanza è
// ≤ `thresholdM` (default 300 m), assorbe la fermata nel cluster
// urbano corrispondente.
//
// Algoritmo: O(N_extra × N_urban) — per i numeri tipici (qualche
// migliaio di fermate) è sufficiente; nessuna struttura spaziale
// dedicata.
// ════════════════════════════════════════════════════════════
function applyAbsorbExtraInUrban(
  unassigned: StopRecord[],
  urbanClusters: Map<string, { name: string; stops: StopRecord[] }>,
  thresholdM: number,
) {
  const assignments = new Map<string, string>();              // stopId → clusterId
  const clusters = new Map<string, { name: string; stops: StopRecord[] }>();
  // Snapshot per non far influenzare le assegnazioni precedenti su quelle successive
  const urbanIndex: { clusterId: string; clusterName: string; stops: StopRecord[] }[] = [];
  for (const [cid, c] of urbanClusters) {
    if (c.stops.length === 0) continue;
    urbanIndex.push({ clusterId: cid, clusterName: c.name, stops: c.stops });
  }
  if (urbanIndex.length === 0) return { assignments, clusters };

  const thresholdKm = thresholdM / 1000;

  for (const stop of unassigned) {
    let bestClusterId: string | null = null;
    let bestClusterName = "";
    let bestDistKm = Infinity;
    for (const uc of urbanIndex) {
      // distanza alla fermata urbana più vicina del cluster
      let minDist = Infinity;
      for (const us of uc.stops) {
        const d = haversineKm(stop.lat, stop.lon, us.lat, us.lon);
        if (d < minDist) {
          minDist = d;
          if (minDist >= bestDistKm) break;     // pruning
        }
      }
      if (minDist < bestDistKm) {
        bestDistKm = minDist;
        bestClusterId = uc.clusterId;
        bestClusterName = uc.clusterName;
      }
    }
    if (bestClusterId && bestDistKm <= thresholdKm) {
      assignments.set(stop.stopId, bestClusterId);
      if (!clusters.has(bestClusterId)) {
        clusters.set(bestClusterId, { name: bestClusterName, stops: [] });
      }
      clusters.get(bestClusterId)!.stops.push(stop);
    }
  }
  return { assignments, clusters };
}

// ════════════════════════════════════════════════════════════
// Layer 0: catalogo ufficiale
// ════════════════════════════════════════════════════════════
type StopRecord = { stopId: string; stopName: string; lat: number; lon: number; nameNorm: string; tokens: string[] };

async function applyOfficialCatalogLayer(
  feedId: string,
  stops: StopRecord[],
): Promise<Map<string, { officialCode: string; officialName: string; confidence: number }>> {
  const officialNodes = await db.select().from(gtfsFareOfficialNodes)
    .where(eq(gtfsFareOfficialNodes.feedId, feedId));
  if (officialNodes.length === 0) return new Map();

  const indexed = officialNodes.map(n => ({
    ...n,
    aliasesNorm: [n.nameNormalized, ...((n.aliases ?? []).map(normalizeStopName))],
    primaryTokens: extractSignificantTokens(n.officialName),
  }));

  const result = new Map<string, { officialCode: string; officialName: string; confidence: number }>();

  for (const stop of stops) {
    if (!stop.nameNorm) continue;
    let best: { node: typeof indexed[number]; score: number } | null = null;
    for (const node of indexed) {
      let score = 0;
      if (node.aliasesNorm.includes(stop.nameNorm)) score += 100;
      const sharedTokens = stop.tokens.filter(t => node.primaryTokens.includes(t));
      score += Math.min(60, sharedTokens.length * 20);
      if (node.centroidLat != null && node.centroidLon != null) {
        const distKm = haversineKm(stop.lat, stop.lon, Number(node.centroidLat), Number(node.centroidLon));
        if (distKm < 1) score += 30;
        else if (distKm < 3) score += 10;
        else if (distKm > 5) score -= 20;
      }
      if (best === null || score > best.score) best = { node, score };
    }
    if (best && best.score >= 110) {
      result.set(stop.stopId, {
        officialCode: best.node.officialCode,
        officialName: best.node.officialName,
        confidence: Math.min(100, 90 + Math.floor(best.score / 20)),
      });
    }
  }
  return result;
}

// ════════════════════════════════════════════════════════════
// Layer 1: match esatto nome normalizzato
// ════════════════════════════════════════════════════════════
function applyExactNameLayer(unassigned: StopRecord[], radiusM: number) {
  const byNorm = new Map<string, StopRecord[]>();
  for (const s of unassigned) {
    if (!s.nameNorm) continue;
    if (!byNorm.has(s.nameNorm)) byNorm.set(s.nameNorm, []);
    byNorm.get(s.nameNorm)!.push(s);
  }

  const assignments = new Map<string, string>();
  const clusters = new Map<string, { name: string; stops: StopRecord[] }>();

  for (const [norm, group] of byNorm) {
    if (group.length < 2) continue;
    let maxDistM = 0;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const d = haversineKm(group[i].lat, group[i].lon, group[j].lat, group[j].lon) * 1000;
        if (d > maxDistM) maxDistM = d;
      }
    }
    if (maxDistM > radiusM) continue;  // omonimi lontani → layer successivo

    const nameCount = new Map<string, number>();
    for (const s of group) nameCount.set(s.stopName, (nameCount.get(s.stopName) ?? 0) + 1);
    const canonicalName = Array.from(nameCount.entries())
      .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)[0][0];
    const clusterId = `auto_exact_${norm.replace(/\s+/g, "_").slice(0, 60)}`;
    clusters.set(clusterId, { name: canonicalName, stops: group });
    for (const s of group) assignments.set(s.stopId, clusterId);
  }
  return { assignments, clusters };
}

// ════════════════════════════════════════════════════════════
// Layer 2: token + prossimità (Union-Find)
// ════════════════════════════════════════════════════════════
function applyTokenLayer(unassigned: StopRecord[], opts: { minSharedTokens: number; radiusM: number }) {
  const radiusKm = opts.radiusM / 1000;
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let cur = x;
    while (parent.get(cur) !== cur) cur = parent.get(cur)!;
    let p = x;
    while (parent.get(p) !== cur) { const n = parent.get(p)!; parent.set(p, cur); p = n; }
    return cur;
  };
  const union = (a: string, b: string) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  for (const s of unassigned) parent.set(s.stopId, s.stopId);

  for (let i = 0; i < unassigned.length; i++) {
    for (let j = i + 1; j < unassigned.length; j++) {
      const a = unassigned[i], b = unassigned[j];
      const distKm = haversineKm(a.lat, a.lon, b.lat, b.lon);
      if (distKm > radiusKm) continue;
      const shared = a.tokens.filter(t => b.tokens.includes(t)).length;
      if (shared >= opts.minSharedTokens) union(a.stopId, b.stopId);
    }
  }

  const groups = new Map<string, StopRecord[]>();
  for (const s of unassigned) {
    const root = find(s.stopId);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(s);
  }

  const assignments = new Map<string, string>();
  const clusters = new Map<string, { name: string; stops: StopRecord[] }>();
  for (const [root, group] of groups) {
    if (group.length < 2) continue;
    const canonicalName = group.map(s => s.stopName).sort((a, b) => a.length - b.length)[0];
    const clusterId = `auto_token_${root.slice(0, 24)}`;
    clusters.set(clusterId, { name: canonicalName, stops: group });
    for (const s of group) assignments.set(s.stopId, clusterId);
  }
  return { assignments, clusters };
}

// ════════════════════════════════════════════════════════════
// Layer 3.b: K-Means geografico (addensamenti)
// ─────────────────────────────────────────────────────────────
// Stessa logica del bottone "auto-generate spatial" già esistente
// in fares.ts (`kMeansSpatial`). Duplicata qui — come per
// `classifyRouteCategory` — per non creare dipendenze cross-router.
// Tenere allineate le due implementazioni.
//
// Suddivide le fermate residue in K cluster geografici tramite
// k-means++ su coordinate (haversine). Se K non è fornito, viene
// stimato dall'estensione geografica (~ 1 cluster ogni 8 km × 8 km).
// ════════════════════════════════════════════════════════════
function applyKmeansLayer(unassigned: StopRecord[], opts: { k?: number; maxIter?: number } = {}) {
  const assignments = new Map<string, string>();
  const clusters = new Map<string, { name: string; stops: StopRecord[] }>();
  if (unassigned.length < 3) return { assignments, clusters };

  // Stima K se non fornito
  let k = opts.k ?? 0;
  if (!k || k < 2) {
    const minLat = Math.min(...unassigned.map(s => s.lat));
    const maxLat = Math.max(...unassigned.map(s => s.lat));
    const minLon = Math.min(...unassigned.map(s => s.lon));
    const maxLon = Math.max(...unassigned.map(s => s.lon));
    const spanKmLat = haversineKm(minLat, minLon, maxLat, minLon);
    const spanKmLon = haversineKm(minLat, minLon, minLat, maxLon);
    const area = spanKmLat * spanKmLon;
    k = Math.max(4, Math.min(25, Math.round(area / 64))); // griglia ~8 km
  }
  k = Math.min(k, Math.max(1, Math.floor(unassigned.length / 3)));
  const maxIter = opts.maxIter ?? 40;

  // K-means++ init
  const centroids: { lat: number; lon: number }[] = [];
  centroids.push({
    lat: unassigned[Math.floor(Math.random() * unassigned.length)].lat,
    lon: unassigned[Math.floor(Math.random() * unassigned.length)].lon,
  });
  for (let c = 1; c < k; c++) {
    const dists = unassigned.map(s => {
      let minD = Infinity;
      for (const ctr of centroids) {
        const d = haversineKm(s.lat, s.lon, ctr.lat, ctr.lon);
        if (d < minD) minD = d;
      }
      return minD * minD;
    });
    const total = dists.reduce((a, b) => a + b, 0);
    let r = Math.random() * total;
    let picked = false;
    for (let i = 0; i < dists.length; i++) {
      r -= dists[i];
      if (r <= 0) { centroids.push({ lat: unassigned[i].lat, lon: unassigned[i].lon }); picked = true; break; }
    }
    if (!picked) centroids.push({
      lat: unassigned[Math.floor(Math.random() * unassigned.length)].lat,
      lon: unassigned[Math.floor(Math.random() * unassigned.length)].lon,
    });
  }

  // Iterazioni Lloyd
  const assignIdx = new Int32Array(unassigned.length);
  for (let iter = 0; iter < maxIter; iter++) {
    let changed = false;
    for (let i = 0; i < unassigned.length; i++) {
      let bestC = 0, bestD = Infinity;
      for (let c = 0; c < centroids.length; c++) {
        const d = haversineKm(unassigned[i].lat, unassigned[i].lon, centroids[c].lat, centroids[c].lon);
        if (d < bestD) { bestD = d; bestC = c; }
      }
      if (assignIdx[i] !== bestC) { assignIdx[i] = bestC; changed = true; }
    }
    if (!changed) break;
    for (let c = 0; c < centroids.length; c++) {
      let sumLat = 0, sumLon = 0, cnt = 0;
      for (let i = 0; i < unassigned.length; i++) {
        if (assignIdx[i] === c) { sumLat += unassigned[i].lat; sumLon += unassigned[i].lon; cnt++; }
      }
      if (cnt > 0) centroids[c] = { lat: sumLat / cnt, lon: sumLon / cnt };
    }
  }

  // Raggruppa e ordina nord→sud per id stabile
  const groups: { centroid: { lat: number; lon: number }; stops: StopRecord[] }[] =
    centroids.map(c => ({ centroid: c, stops: [] }));
  for (let i = 0; i < unassigned.length; i++) groups[assignIdx[i]].stops.push(unassigned[i]);
  const nonEmpty = groups.filter(g => g.stops.length > 0)
    .sort((a, b) => b.centroid.lat - a.centroid.lat);

  for (let idx = 0; idx < nonEmpty.length; idx++) {
    const g = nonEmpty[idx];
    // Nome = fermata più centrale, ripulita
    const central = g.stops.reduce((best, s) => {
      const d = haversineKm(s.lat, s.lon, g.centroid.lat, g.centroid.lon);
      return d < best.d ? { s, d } : best;
    }, { s: g.stops[0], d: Infinity }).s;
    const baseName = central.stopName.replace(/\s*[-–(].*/g, "").trim() || central.stopName;
    const clusterId = `auto_geo_${idx + 1}`;
    clusters.set(clusterId, { name: baseName, stops: g.stops });
    for (const s of g.stops) assignments.set(s.stopId, clusterId);
  }
  return { assignments, clusters };
}

// ════════════════════════════════════════════════════════════
// Layer 3 (legacy): DBSCAN geografico — NON più usato di default
// nel modello v2 (sostituito da k-means). Mantenuto come fallback
// attivabile via `useDbscan=true`.
// ════════════════════════════════════════════════════════════
function applyDbscanLayer(unassigned: StopRecord[], opts: { epsilonM: number; minPts: number }) {
  const epsilonKm = opts.epsilonM / 1000;
  const minPts = opts.minPts;
  const visited = new Set<string>();
  const assignments = new Map<string, string>();
  const clusters = new Map<string, { name: string; stops: StopRecord[] }>();

  const neighborsOf = (s: StopRecord) =>
    unassigned.filter(o => o.stopId !== s.stopId && haversineKm(s.lat, s.lon, o.lat, o.lon) <= epsilonKm);

  let clusterIdx = 0;
  for (const s of unassigned) {
    if (visited.has(s.stopId)) continue;
    visited.add(s.stopId);
    const N = neighborsOf(s);
    if (N.length < minPts - 1) continue;

    clusterIdx++;
    const clusterId = `auto_geo_${clusterIdx}`;
    const groupStops: StopRecord[] = [s];
    assignments.set(s.stopId, clusterId);

    const queue = [...N];
    while (queue.length > 0) {
      const p = queue.shift()!;
      if (!visited.has(p.stopId)) {
        visited.add(p.stopId);
        const PN = neighborsOf(p);
        if (PN.length >= minPts - 1) for (const x of PN) if (!queue.find(q => q.stopId === x.stopId)) queue.push(x);
      }
      if (!assignments.has(p.stopId)) {
        assignments.set(p.stopId, clusterId);
        groupStops.push(p);
      }
    }

    const cLat = groupStops.reduce((a, x) => a + x.lat, 0) / groupStops.length;
    const cLon = groupStops.reduce((a, x) => a + x.lon, 0) / groupStops.length;
    const central = groupStops.reduce((best, x) => {
      const d = haversineKm(x.lat, x.lon, cLat, cLon);
      return d < best.d ? { s: x, d } : best;
    }, { s: groupStops[0], d: Infinity }).s;
    clusters.set(clusterId, { name: central.stopName, stops: groupStops });
  }
  return { assignments, clusters };
}

// ════════════════════════════════════════════════════════════
// Layer 4: singleton
// ════════════════════════════════════════════════════════════
function applySingletonLayer(unassigned: StopRecord[]) {
  const assignments = new Map<string, string>();
  const clusters = new Map<string, { name: string; stops: StopRecord[] }>();
  for (const s of unassigned) {
    const safeId = s.stopId.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 64);
    const clusterId = `auto_singleton_${safeId}`;
    clusters.set(clusterId, { name: s.stopName, stops: [s] });
    assignments.set(s.stopId, clusterId);
  }
  return { assignments, clusters };
}

// ════════════════════════════════════════════════════════════
// Orchestratore pipeline (modello a 2 step + manuale)
// ────────────────────────────────────────────────────────────
// Filosofia: ogni cluster è UNA PARTIZIONE. Non possono esistere
// cluster annidati o sovrapposti. La pipeline procede per step
// disgiunti, dove ogni fermata viene assegnata UNA SOLA volta.
//
// Step 1 — URBAN HUB
//   Una fermata servita da almeno una route urbana confluisce
//   nel cluster urbano della sua città (urban_ancona, urban_jesi,
//   urban_falconara, urban_senigallia, urban_castelfidardo).
//   In caso di mix urbano+extraurbano, vince la città con più
//   passaggi urbani.
//
// Step 2 — DBSCAN GEOGRAFICO sulle NON-urbane
//   Le fermate rimaste (puramente extraurbane) vengono raggruppate
//   per addensamento geografico → identifica i centri abitati
//   serviti solo da linee extraurbane.
//
// Step 3 — MANUALE
//   Le fermate isolate restano "orfane" e l'utente le assegna a
//   mano (o le promuove a nuovo cluster) tramite la UI cluster.
//
// I layer "official catalog / exact name / token / singleton" del
// modello v1 sono stati DISATTIVATI ma NON rimossi: restano nel
// codice come funzioni utilizzabili in futuro (`useOfficialCatalog`,
// `useExactName`, `useToken`, `useSingleton` nei params).
// ════════════════════════════════════════════════════════════
async function runNodeAssignmentPipeline(feedId: string, opts: {
  useUrbanHub?: boolean;
  useAbsorbExtraInUrban?: boolean;
  useOfficialCatalog?: boolean;
  useExactName?: boolean;
  useToken?: boolean;
  useKmeans?: boolean;
  useDbscan?: boolean;
  useSingleton?: boolean;
  clearExistingAuto?: boolean;
  exactRadiusM?: number;
  tokenRadiusM?: number;
  tokenMinShared?: number;
  kmeansK?: number;
  geoEpsilonM?: number;
  geoMinPts?: number;
  absorbThresholdM?: number;
} = {}) {
  const params = {
    // Default v2: Urban + Absorb-extra-in-urban + K-means addensamenti, resto manuale.
    useUrbanHub:           opts.useUrbanHub           ?? true,
    useAbsorbExtraInUrban: opts.useAbsorbExtraInUrban ?? true,
    useOfficialCatalog:    opts.useOfficialCatalog    ?? false,
    useExactName:          opts.useExactName          ?? false,
    useToken:              opts.useToken              ?? false,
    useKmeans:             opts.useKmeans             ?? true,
    useDbscan:             opts.useDbscan             ?? false,
    useSingleton:          opts.useSingleton          ?? false,
    clearExistingAuto:     opts.clearExistingAuto     ?? true,
    exactRadiusM:          opts.exactRadiusM          ?? 800,
    tokenRadiusM:          opts.tokenRadiusM          ?? 500,
    tokenMinShared:        opts.tokenMinShared        ?? 2,
    kmeansK:               opts.kmeansK               ?? 0,    // 0 = auto-stima da estensione geografica
    geoEpsilonM:           opts.geoEpsilonM           ?? 400,
    geoMinPts:             opts.geoMinPts             ?? 3,
    absorbThresholdM:      opts.absorbThresholdM      ?? 300,  // soglia distanza alla fermata urbana più vicina
  };

  const t0 = Date.now();
  const [run] = await db.insert(gtfsFareNodeAssignmentRuns).values({
    feedId, status: "running", params,
  }).returning();

  try {
    const stopsRaw = await db.select({
      stopId: gtfsStops.stopId,
      stopName: gtfsStops.stopName,
      lat: gtfsStops.stopLat,
      lon: gtfsStops.stopLon,
    }).from(gtfsStops).where(eq(gtfsStops.feedId, feedId));

    const stops: StopRecord[] = stopsRaw.map(s => ({
      stopId: s.stopId,
      stopName: s.stopName,
      lat: Number(s.lat),
      lon: Number(s.lon),
      nameNorm: normalizeStopName(s.stopName),
      tokens: extractSignificantTokens(s.stopName),
    }));

    const cBeforeRows = await db.select({ c: sql<number>`count(*)::int` })
      .from(gtfsFareZoneClusters).where(eq(gtfsFareZoneClusters.feedId, feedId));
    const clustersBefore = Number(cBeforeRows[0]?.c ?? 0);

    if (params.clearExistingAuto) {
      // Cancella TUTTI i cluster non manuali del feed (auto_*, urban_*, official_*).
      // I cluster `is_official=true` provenienti dal catalogo restano protetti.
      // Le righe in cluster_stops con assignment_source='manual' restano (override utente).
      const toDelete = await db.select({ clusterId: gtfsFareZoneClusters.clusterId })
        .from(gtfsFareZoneClusters)
        .where(and(
          eq(gtfsFareZoneClusters.feedId, feedId),
          eq(gtfsFareZoneClusters.isOfficial, false),
        ));
      const ids = toDelete.map(x => x.clusterId);
      if (ids.length > 0) {
        // Cancella solo le righe auto-assegnate dei cluster da rimuovere
        await db.delete(gtfsFareZoneClusterStops).where(and(
          eq(gtfsFareZoneClusterStops.feedId, feedId),
          inArray(gtfsFareZoneClusterStops.clusterId, ids),
          sql`(assignment_source IS NULL OR assignment_source = 'auto')`,
        ));
        // Cancella i cluster solo se ora sono completamente vuoti
        // (alcuni potrebbero contenere ancora stops manuali)
        await db.execute(sql`
          DELETE FROM gtfs_fare_zone_clusters c
          WHERE c.feed_id = ${feedId}
            AND c.is_official = false
            AND NOT EXISTS (
              SELECT 1 FROM gtfs_fare_zone_cluster_stops cs
              WHERE cs.feed_id = c.feed_id AND cs.cluster_id = c.cluster_id
            )
        `);
      }
    }

    const finalAssignments = new Map<string, {
      clusterId: string; clusterName: string; layer: string; confidence: number; isOfficial: boolean;
    }>();
    const newClusters = new Map<string, { name: string; isOfficial: boolean; officialCode: string | null }>();
    const layerStats: Record<string, number> = { urban: 0, absorbed: 0, official: 0, exact: 0, token: 0, geo: 0, singleton: 0 };

    // Layer 0.5: Urban Hub (prima del catalogo: i servizi urbani di una città
    // formano un UNICO nodo tariffario, indipendentemente dal nome della fermata).
    // Memorizziamo i cluster urbani separatamente perché lo Step 1.5 li usa
    // come "calamita" per assorbire fermate extraurbane geograficamente interne.
    const urbanClustersSnapshot = new Map<string, { name: string; stops: StopRecord[] }>();
    if (params.useUrbanHub) {
      const urbanWeights = await loadStopUrbanWeights(feedId);
      const urbanRes = applyUrbanHubLayer(stops, urbanWeights);
      for (const [stopId, clusterId] of urbanRes.assignments) {
        const c = urbanRes.clusters.get(clusterId)!;
        finalAssignments.set(stopId, {
          clusterId, clusterName: c.name,
          layer: "urban", confidence: 90, isOfficial: false,
        });
        if (!newClusters.has(clusterId)) newClusters.set(clusterId, { name: c.name, isOfficial: false, officialCode: null });
        layerStats.urban++;
      }
      for (const [cid, c] of urbanRes.clusters) urbanClustersSnapshot.set(cid, c);
    }

    // Step 1.5 — ABSORB extra-in-urban
    // Assorbe nel cluster urbano le fermate (servite solo da extraurbani)
    // che cadono geograficamente dentro/vicino al perimetro urbano.
    // Soglia: distanza alla fermata urbana più vicina del cluster ≤ absorbThresholdM.
    if (params.useUrbanHub && params.useAbsorbExtraInUrban && urbanClustersSnapshot.size > 0) {
      const candidatesForAbsorb = stops.filter(s => !finalAssignments.has(s.stopId));
      const absorbRes = applyAbsorbExtraInUrban(
        candidatesForAbsorb,
        urbanClustersSnapshot,
        params.absorbThresholdM,
      );
      for (const [stopId, clusterId] of absorbRes.assignments) {
        const cMeta = urbanClustersSnapshot.get(clusterId);
        const cName = cMeta?.name ?? clusterId;
        finalAssignments.set(stopId, {
          clusterId, clusterName: cName,
          layer: "urban", confidence: 85, isOfficial: false,
        });
        // Il cluster esiste già da Step 1 in newClusters, ma per sicurezza
        if (!newClusters.has(clusterId)) newClusters.set(clusterId, { name: cName, isOfficial: false, officialCode: null });
        layerStats.absorbed++;
      }
    }

    // Layer 0
    if (params.useOfficialCatalog) {
      const remainingForOfficial = stops.filter(s => !finalAssignments.has(s.stopId));
      const officialMap = await applyOfficialCatalogLayer(feedId, remainingForOfficial);
      for (const [stopId, m] of officialMap) {
        const clusterId = `official_${m.officialCode.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
        finalAssignments.set(stopId, {
          clusterId, clusterName: m.officialName,
          layer: "official", confidence: m.confidence, isOfficial: true,
        });
        if (!newClusters.has(clusterId)) newClusters.set(clusterId, { name: m.officialName, isOfficial: true, officialCode: m.officialCode });
        layerStats.official++;
      }
    }

    // Layer 1 — DISATTIVATO di default (model v2: solo Urban + DBSCAN).
    // Riattivabile passando useExactName=true. Aggrega fermate omonime
    // entro `exactRadiusM` metri sotto un cluster "auto_exact_*".
    let remaining = stops.filter(s => !finalAssignments.has(s.stopId));
    if (params.useExactName) {
      const exactRes = applyExactNameLayer(remaining, params.exactRadiusM);
      for (const [stopId, clusterId] of exactRes.assignments) {
        const c = exactRes.clusters.get(clusterId)!;
        finalAssignments.set(stopId, { clusterId, clusterName: c.name, layer: "exact", confidence: 95, isOfficial: false });
        if (!newClusters.has(clusterId)) newClusters.set(clusterId, { name: c.name, isOfficial: false, officialCode: null });
        layerStats.exact++;
      }
    }

    // Layer 2 — DISATTIVATO di default. Token + prossimità (Union-Find).
    remaining = stops.filter(s => !finalAssignments.has(s.stopId));
    if (params.useToken) {
      const tokenRes = applyTokenLayer(remaining, { minSharedTokens: params.tokenMinShared, radiusM: params.tokenRadiusM });
      for (const [stopId, clusterId] of tokenRes.assignments) {
        const c = tokenRes.clusters.get(clusterId)!;
        finalAssignments.set(stopId, { clusterId, clusterName: c.name, layer: "token", confidence: 80, isOfficial: false });
        if (!newClusters.has(clusterId)) newClusters.set(clusterId, { name: c.name, isOfficial: false, officialCode: null });
        layerStats.token++;
      }
    }

    // Step 2 — K-MEANS GEOGRAFICO sulle fermate NON-urbane.
    // Stessa logica del bottone "auto-generate spatial" già usata
    // dal team — riusato qui come Step 2 della pipeline Telemaco
    // così l'UX è coerente fra i due punti d'ingresso.
    remaining = stops.filter(s => !finalAssignments.has(s.stopId));
    if (params.useKmeans) {
      const kRes = applyKmeansLayer(remaining, { k: params.kmeansK || undefined });
      for (const [stopId, clusterId] of kRes.assignments) {
        const c = kRes.clusters.get(clusterId)!;
        finalAssignments.set(stopId, { clusterId, clusterName: c.name, layer: "geo", confidence: 70, isOfficial: false });
        if (!newClusters.has(clusterId)) newClusters.set(clusterId, { name: c.name, isOfficial: false, officialCode: null });
        layerStats.geo++;
      }
    }

    // Step 2 (legacy) — DBSCAN GEOGRAFICO sulle fermate NON-urbane.
    // DISATTIVATO di default in v2 (sostituito da k-means). Resta
    // attivabile via `useDbscan=true` come fallback.
    remaining = stops.filter(s => !finalAssignments.has(s.stopId));
    if (params.useDbscan) {
      const geoRes = applyDbscanLayer(remaining, { epsilonM: params.geoEpsilonM, minPts: params.geoMinPts });
      for (const [stopId, clusterId] of geoRes.assignments) {
        const c = geoRes.clusters.get(clusterId)!;
        finalAssignments.set(stopId, { clusterId, clusterName: c.name, layer: "geo", confidence: 60, isOfficial: false });
        if (!newClusters.has(clusterId)) newClusters.set(clusterId, { name: c.name, isOfficial: false, officialCode: null });
        layerStats.geo++;
      }
    }

    // Layer 4 — DISATTIVATO di default. Singleton: ogni fermata residua
    // diventa un proprio cluster. Step 3 v2: lasciare ORFANE le residue
    // così l'utente le assegna manualmente via UI.
    remaining = stops.filter(s => !finalAssignments.has(s.stopId));
    if (params.useSingleton) {
      const singletonRes = applySingletonLayer(remaining);
      for (const [stopId, clusterId] of singletonRes.assignments) {
        const c = singletonRes.clusters.get(clusterId)!;
        finalAssignments.set(stopId, { clusterId, clusterName: c.name, layer: "singleton", confidence: 100, isOfficial: false });
        if (!newClusters.has(clusterId)) newClusters.set(clusterId, { name: c.name, isOfficial: false, officialCode: null });
        layerStats.singleton++;
      }
    }

    // Persisti cluster con centroide
    for (const [clusterId, meta] of newClusters) {
      const stopsInCluster = stops.filter(s => finalAssignments.get(s.stopId)?.clusterId === clusterId);
      if (stopsInCluster.length === 0) continue;
      const centroidLat = stopsInCluster.reduce((a, s) => a + s.lat, 0) / stopsInCluster.length;
      const centroidLon = stopsInCluster.reduce((a, s) => a + s.lon, 0) / stopsInCluster.length;
      await db.insert(gtfsFareZoneClusters).values({
        feedId, clusterId, clusterName: meta.name,
        polygon: null, centroidLat, centroidLon,
        color: colorForCluster(clusterId, meta.isOfficial),
        isOfficial: meta.isOfficial,
        officialCode: meta.officialCode,
      }).onConflictDoUpdate({
        target: [gtfsFareZoneClusters.feedId, gtfsFareZoneClusters.clusterId],
        set: { clusterName: meta.name, centroidLat, centroidLon, color: colorForCluster(clusterId, meta.isOfficial), updatedAt: sql`now()`, isOfficial: meta.isOfficial, officialCode: meta.officialCode },
      });
    }

    // Persisti assegnazioni — prima cancella tutte le righe auto del feed (non manuali), poi insert in batch
    await db.delete(gtfsFareZoneClusterStops).where(and(
      eq(gtfsFareZoneClusterStops.feedId, feedId),
      sql`(assignment_source IS NULL OR assignment_source = 'auto')`,
    ));

    const rows = stops.filter(s => finalAssignments.has(s.stopId)).map(s => {
      const a = finalAssignments.get(s.stopId)!;
      return {
        feedId, clusterId: a.clusterId, stopId: s.stopId,
        stopName: s.stopName, stopLat: s.lat, stopLon: s.lon,
        assignmentLayer: a.layer, assignmentConfidence: a.confidence, assignmentSource: "auto",
      };
    });
    const BATCH = 500;
    for (let i = 0; i < rows.length; i += BATCH) {
      await db.insert(gtfsFareZoneClusterStops).values(rows.slice(i, i + BATCH));
    }

    const cAfterRows = await db.select({ c: sql<number>`count(*)::int` })
      .from(gtfsFareZoneClusters).where(eq(gtfsFareZoneClusters.feedId, feedId));
    const clustersAfter = Number(cAfterRows[0]?.c ?? 0);

    await db.update(gtfsFareNodeAssignmentRuns).set({
      status: "success",
      totalStops: stops.length,
      assignedByLayer: layerStats,
      clustersBefore, clustersAfter,
      durationMs: Date.now() - t0,
      finishedAt: sql`now()`,
    }).where(eq(gtfsFareNodeAssignmentRuns.id, run.id));

    return {
      runId: run.id,
      totalStops: stops.length,
      assignedByLayer: layerStats,
      clustersBefore, clustersAfter,
      durationMs: Date.now() - t0,
    };
  } catch (err: any) {
    await db.update(gtfsFareNodeAssignmentRuns).set({
      status: "error", errorMessage: err.message ?? String(err), finishedAt: sql`now()`,
    }).where(eq(gtfsFareNodeAssignmentRuns.id, run.id));
    throw err;
  }
}

async function recalcCentroid(feedId: string, clusterId: string) {
  const stops = await db.select({
    lat: gtfsFareZoneClusterStops.stopLat,
    lon: gtfsFareZoneClusterStops.stopLon,
  }).from(gtfsFareZoneClusterStops).where(
    and(eq(gtfsFareZoneClusterStops.feedId, feedId), eq(gtfsFareZoneClusterStops.clusterId, clusterId))
  );
  if (stops.length === 0) return;
  const cLat = stops.reduce((a, s) => a + Number(s.lat), 0) / stops.length;
  const cLon = stops.reduce((a, s) => a + Number(s.lon), 0) / stops.length;
  await db.update(gtfsFareZoneClusters).set({
    centroidLat: cLat, centroidLon: cLon, updatedAt: sql`now()`,
  }).where(and(eq(gtfsFareZoneClusters.feedId, feedId), eq(gtfsFareZoneClusters.clusterId, clusterId)));
}

// ════════════════════════════════════════════════════════════
// Lista preconfigurata ATMA 2013 (parziale — completare dall'indice PDF)
// ════════════════════════════════════════════════════════════
const ATMA_2013_NODES: ReadonlyArray<{ code: string; name: string; lat?: number; lon?: number; aliases?: readonly string[] }> = [
  { code: "ANCONA",        name: "Ancona",            lat: 43.6158, lon: 13.5189, aliases: ["ANCONA STAZIONE", "ANCONA CENTRO"] },
  { code: "FALCONARA_M",   name: "Falconara M.",      lat: 43.6261, lon: 13.4041, aliases: ["FALCONARA MARITTIMA", "FALCONARA"] },
  { code: "JESI",          name: "Jesi",              lat: 43.5217, lon: 13.2434, aliases: ["JESI AUTOSTAZIONE", "JESI CENTRO"] },
  { code: "SENIGALLIA",    name: "Senigallia",        lat: 43.7156, lon: 13.2147 },
  { code: "OSIMO",         name: "Osimo",             lat: 43.4869, lon: 13.4839 },
  { code: "LORETO",        name: "Loreto Capolinea",  lat: 43.4406, lon: 13.6111, aliases: ["LORETO"] },
  { code: "RECANATI",      name: "Recanati",          lat: 43.4022, lon: 13.5511 },
  { code: "CASTELFIDARDO", name: "Castelfidardo",     lat: 43.4639, lon: 13.5469 },
  { code: "AGUGLIANO",     name: "Agugliano",         lat: 43.5611, lon: 13.3897 },
  { code: "AEROPORTO",     name: "Aeroporto",         lat: 43.6164, lon: 13.3625, aliases: ["AEROPORTO ANCONA", "RAFFAELLO SANZIO"] },
  { code: "ASPIO_TERME",   name: "Aspio Terme",       lat: 43.5450, lon: 13.5483 },
  { code: "ASPIO_VECCHIO", name: "Aspio Vecchio",     lat: 43.5489, lon: 13.5414 },
  { code: "ABADIA",        name: "Abadia",            lat: 43.4969, lon: 13.0631, aliases: ["ABBADIA"] },
  { code: "ARCHI_LORETO",  name: "Archi di Loreto",   lat: 43.4489, lon: 13.6042 },
];

// ════════════════════════════════════════════════════════════
// Endpoints
// ════════════════════════════════════════════════════════════

router.post("/fares/node-assignment/run", async (req, res): Promise<void> => {
  try {
    await ensureNodeAssignmentTables();
    const feedId = await getLatestFeedId(req);
    if (!feedId) { res.status(400).json({ error: "No GTFS feed" }); return; }
    const result = await runNodeAssignmentPipeline(feedId, req.body ?? {});
    res.json(result);
  } catch (e: any) { res.status(500).json({ error: e.message ?? String(e) }); }
});

router.get("/fares/node-assignment/runs", async (req, res): Promise<void> => {
  try {
    await ensureNodeAssignmentTables();
    const feedId = await getLatestFeedId(req);
    if (!feedId) { res.json([]); return; }
    const rows = await db.select().from(gtfsFareNodeAssignmentRuns)
      .where(eq(gtfsFareNodeAssignmentRuns.feedId, feedId))
      .orderBy(sql`started_at DESC`).limit(50);
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message ?? String(e) }); }
});

router.get("/fares/node-assignment/report", async (req, res): Promise<void> => {
  try {
    await ensureNodeAssignmentTables();
    const feedId = await getLatestFeedId(req);
    if (!feedId) { res.status(400).json({ error: "No GTFS feed" }); return; }

    const totalStopsRow = await db.select({ c: sql<number>`count(*)::int` })
      .from(gtfsStops).where(eq(gtfsStops.feedId, feedId));
    const totalStops = Number(totalStopsRow[0]?.c ?? 0);

    const assignedRow = await db.select({ c: sql<number>`count(*)::int` })
      .from(gtfsFareZoneClusterStops).where(eq(gtfsFareZoneClusterStops.feedId, feedId));
    const assignedStops = Number(assignedRow[0]?.c ?? 0);

    const byLayer = await db.execute<any>(sql`
      SELECT assignment_layer, count(*)::int AS cnt
      FROM gtfs_fare_zone_cluster_stops
      WHERE feed_id = ${feedId}
      GROUP BY assignment_layer
      ORDER BY cnt DESC
    `);

    const bySource = await db.execute<any>(sql`
      SELECT assignment_source, count(*)::int AS cnt
      FROM gtfs_fare_zone_cluster_stops
      WHERE feed_id = ${feedId}
      GROUP BY assignment_source
    `);

    const lowConfRow = await db.select({ c: sql<number>`count(*)::int` })
      .from(gtfsFareZoneClusterStops)
      .where(and(eq(gtfsFareZoneClusterStops.feedId, feedId), sql`assignment_confidence < 70`));
    const lowConfidence = Number(lowConfRow[0]?.c ?? 0);

    const orphans = totalStops - assignedStops;

    res.json({
      totalStops, assignedStops, orphans,
      coveragePercent: totalStops > 0 ? Math.round((assignedStops / totalStops) * 10000) / 100 : 0,
      lowConfidence,
      byLayer: (byLayer as any).rows ?? byLayer,
      bySource: (bySource as any).rows ?? bySource,
      readyForTelemaco: orphans === 0 && lowConfidence < totalStops * 0.05,
    });
  } catch (e: any) { res.status(500).json({ error: e.message ?? String(e) }); }
});

router.get("/fares/node-assignment/low-confidence", async (req, res): Promise<void> => {
  try {
    await ensureNodeAssignmentTables();
    const feedId = await getLatestFeedId(req);
    if (!feedId) { res.json([]); return; }
    const threshold = Number(req.query.threshold ?? 70);
    const rows = await db.execute<any>(sql`
      SELECT cs.stop_id, cs.stop_name, cs.stop_lat, cs.stop_lon,
             cs.cluster_id, cs.assignment_layer, cs.assignment_confidence,
             c.cluster_name
      FROM gtfs_fare_zone_cluster_stops cs
      JOIN gtfs_fare_zone_clusters c ON c.cluster_id = cs.cluster_id AND c.feed_id = cs.feed_id
      WHERE cs.feed_id = ${feedId} AND cs.assignment_confidence < ${threshold}
      ORDER BY cs.assignment_confidence ASC, cs.stop_name
      LIMIT 500
    `);
    res.json((rows as any).rows ?? rows);
  } catch (e: any) { res.status(500).json({ error: e.message ?? String(e) }); }
});

router.get("/fares/node-assignment/ambiguous", async (req, res): Promise<void> => {
  try {
    await ensureNodeAssignmentTables();
    const feedId = await getLatestFeedId(req);
    if (!feedId) { res.json([]); return; }
    const radiusM = Number(req.query.radiusM ?? 200);
    const rows = await db.execute<any>(sql`
      WITH stop_clusters AS (
        SELECT cs.stop_id, cs.stop_name, cs.stop_lat, cs.stop_lon, cs.cluster_id, cs.assignment_layer
        FROM gtfs_fare_zone_cluster_stops cs
        WHERE cs.feed_id = ${feedId}
      ),
      cluster_centroids AS (
        SELECT cluster_id, cluster_name, centroid_lat, centroid_lon
        FROM gtfs_fare_zone_clusters
        WHERE feed_id = ${feedId} AND centroid_lat IS NOT NULL
      )
      SELECT
        sc.stop_id, sc.stop_name, sc.stop_lat, sc.stop_lon,
        sc.cluster_id AS current_cluster, sc.assignment_layer,
        cc.cluster_id AS nearby_cluster, cc.cluster_name AS nearby_cluster_name,
        (6371000 * acos(
          LEAST(1, GREATEST(-1,
            cos(radians(sc.stop_lat::float)) * cos(radians(cc.centroid_lat))
            * cos(radians(cc.centroid_lon) - radians(sc.stop_lon::float))
            + sin(radians(sc.stop_lat::float)) * sin(radians(cc.centroid_lat))
          ))
        )) AS dist_m
      FROM stop_clusters sc
      JOIN cluster_centroids cc ON cc.cluster_id != sc.cluster_id
      WHERE (6371000 * acos(
        LEAST(1, GREATEST(-1,
          cos(radians(sc.stop_lat::float)) * cos(radians(cc.centroid_lat))
          * cos(radians(cc.centroid_lon) - radians(sc.stop_lon::float))
          + sin(radians(sc.stop_lat::float)) * sin(radians(cc.centroid_lat))
        ))
      )) < ${radiusM}
      ORDER BY dist_m ASC
      LIMIT 500
    `);
    res.json((rows as any).rows ?? rows);
  } catch (e: any) { res.status(500).json({ error: e.message ?? String(e) }); }
});

router.get("/fares/node-assignment/orphans", async (req, res): Promise<void> => {
  try {
    await ensureNodeAssignmentTables();
    const feedId = await getLatestFeedId(req);
    if (!feedId) { res.json([]); return; }
    const rows = await db.execute<any>(sql`
      SELECT s.stop_id, s.stop_name, s.stop_lat::float AS lat, s.stop_lon::float AS lon
      FROM gtfs_stops s
      WHERE s.feed_id = ${feedId}
        AND s.stop_id NOT IN (
          SELECT stop_id FROM gtfs_fare_zone_cluster_stops WHERE feed_id = ${feedId}
        )
      ORDER BY s.stop_name
    `);
    res.json((rows as any).rows ?? rows);
  } catch (e: any) { res.status(500).json({ error: e.message ?? String(e) }); }
});

// ── Catalogo nodi ufficiali ──

router.get("/fares/official-nodes", async (req, res): Promise<void> => {
  try {
    await ensureNodeAssignmentTables();
    const feedId = await getLatestFeedId(req);
    if (!feedId) { res.json([]); return; }
    const rows = await db.select().from(gtfsFareOfficialNodes)
      .where(eq(gtfsFareOfficialNodes.feedId, feedId))
      .orderBy(gtfsFareOfficialNodes.officialName);
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message ?? String(e) }); }
});

router.post("/fares/official-nodes", async (req, res): Promise<void> => {
  try {
    await ensureNodeAssignmentTables();
    const feedId = await getLatestFeedId(req);
    if (!feedId) { res.status(400).json({ error: "No GTFS feed" }); return; }
    const { officialCode, officialName, centroidLat, centroidLon, aliases, notes, source = "manual" } = req.body ?? {};
    if (!officialCode || !officialName) { res.status(400).json({ error: "officialCode e officialName richiesti" }); return; }
    const [row] = await db.insert(gtfsFareOfficialNodes).values({
      feedId, officialCode, officialName,
      nameNormalized: normalizeStopName(officialName),
      centroidLat: centroidLat ?? null,
      centroidLon: centroidLon ?? null,
      aliases: aliases ?? [],
      notes: notes ?? null,
      source,
    }).onConflictDoUpdate({
      target: [gtfsFareOfficialNodes.feedId, gtfsFareOfficialNodes.officialCode],
      set: { officialName, nameNormalized: normalizeStopName(officialName), aliases: aliases ?? [], notes, centroidLat: centroidLat ?? null, centroidLon: centroidLon ?? null },
    }).returning();
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e.message ?? String(e) }); }
});

router.post("/fares/official-nodes/import-csv", async (req, res): Promise<void> => {
  try {
    await ensureNodeAssignmentTables();
    const feedId = await getLatestFeedId(req);
    if (!feedId) { res.status(400).json({ error: "No GTFS feed" }); return; }
    const { csv, source = "manual" } = req.body ?? {};
    if (!csv || typeof csv !== "string") { res.status(400).json({ error: "csv string required" }); return; }

    const lines = csv.split(/\r?\n/).filter((l: string) => l.trim().length > 0);
    if (lines.length < 2) { res.status(400).json({ error: "CSV vuoto" }); return; }
    const headers = lines[0].split(",").map((h: string) => h.trim().toLowerCase());
    const idx = (col: string) => headers.indexOf(col);
    const iCode = idx("code"), iName = idx("name"), iLat = idx("lat"), iLon = idx("lon"), iAliases = idx("aliases"), iNotes = idx("notes");
    if (iCode < 0 || iName < 0) { res.status(400).json({ error: "CSV deve avere colonne 'code' e 'name'" }); return; }

    let inserted = 0;
    for (let i = 1; i < lines.length; i++) {
      const cells = lines[i].split(",").map((c: string) => c.trim());
      const code = cells[iCode], name = cells[iName];
      if (!code || !name) continue;
      try {
        await db.insert(gtfsFareOfficialNodes).values({
          feedId, officialCode: code, officialName: name,
          nameNormalized: normalizeStopName(name),
          centroidLat: iLat >= 0 && cells[iLat] ? parseFloat(cells[iLat]) : null,
          centroidLon: iLon >= 0 && cells[iLon] ? parseFloat(cells[iLon]) : null,
          aliases: iAliases >= 0 && cells[iAliases] ? cells[iAliases].split(";").filter(Boolean) : [],
          notes: iNotes >= 0 ? cells[iNotes] : null,
          source,
        }).onConflictDoNothing();
        inserted++;
      } catch { /* skip */ }
    }
    res.json({ totalLines: lines.length - 1, inserted });
  } catch (e: any) { res.status(500).json({ error: e.message ?? String(e) }); }
});

router.post("/fares/official-nodes/import-atma-2013", async (req, res): Promise<void> => {
  try {
    await ensureNodeAssignmentTables();
    const feedId = await getLatestFeedId(req);
    if (!feedId) { res.status(400).json({ error: "No GTFS feed" }); return; }
    let inserted = 0;
    for (const node of ATMA_2013_NODES) {
      await db.insert(gtfsFareOfficialNodes).values({
        feedId, officialCode: node.code, officialName: node.name,
        nameNormalized: normalizeStopName(node.name),
        centroidLat: node.lat ?? null, centroidLon: node.lon ?? null,
        aliases: node.aliases ? [...node.aliases] : [],
        source: "atma_2013",
      }).onConflictDoNothing();
      inserted++;
    }
    res.json({ totalNodes: ATMA_2013_NODES.length, inserted });
  } catch (e: any) { res.status(500).json({ error: e.message ?? String(e) }); }
});

router.delete("/fares/official-nodes/:id", async (req, res): Promise<void> => {
  try {
    await ensureNodeAssignmentTables();
    await db.delete(gtfsFareOfficialNodes).where(eq(gtfsFareOfficialNodes.id, req.params.id));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message ?? String(e) }); }
});

// ── Move / override ──

async function moveStop(feedId: string, stopId: string, toClusterId: string, reason: string | undefined, actor: string) {
  const [current] = await db.select().from(gtfsFareZoneClusterStops).where(
    and(eq(gtfsFareZoneClusterStops.feedId, feedId), eq(gtfsFareZoneClusterStops.stopId, stopId))
  );

  const [targetCluster] = await db.select().from(gtfsFareZoneClusters).where(
    and(eq(gtfsFareZoneClusters.feedId, feedId), eq(gtfsFareZoneClusters.clusterId, toClusterId))
  );
  if (!targetCluster) throw new Error(`Cluster target non esiste: ${toClusterId}`);

  const [stopInfo] = await db.select().from(gtfsStops).where(
    and(eq(gtfsStops.feedId, feedId), eq(gtfsStops.stopId, stopId))
  );
  if (!stopInfo) throw new Error(`Stop non trovato: ${stopId}`);

  if (current) {
    await db.update(gtfsFareZoneClusterStops).set({
      clusterId: toClusterId,
      assignmentLayer: "manual", assignmentConfidence: 100, assignmentSource: "manual",
      assignedAt: sql`now()`,
    }).where(eq(gtfsFareZoneClusterStops.id, current.id));
  } else {
    await db.insert(gtfsFareZoneClusterStops).values({
      feedId, clusterId: toClusterId, stopId,
      stopName: stopInfo.stopName,
      stopLat: Number(stopInfo.stopLat), stopLon: Number(stopInfo.stopLon),
      assignmentLayer: "manual", assignmentConfidence: 100, assignmentSource: "manual",
    });
  }

  await db.insert(gtfsFareStopAssignmentOverrides).values({
    feedId, stopId,
    fromClusterId: current?.clusterId ?? null,
    toClusterId, reason, actor,
  });

  await recalcCentroid(feedId, toClusterId);
  if (current?.clusterId && current.clusterId !== toClusterId) {
    await recalcCentroid(feedId, current.clusterId);
  }
  return { fromCluster: current?.clusterId ?? null, toCluster: toClusterId };
}

router.post("/fares/stop-assignment/move", async (req, res): Promise<void> => {
  try {
    await ensureNodeAssignmentTables();
    const feedId = await getLatestFeedId(req);
    if (!feedId) { res.status(400).json({ error: "No GTFS feed" }); return; }
    const { stopId, toClusterId, reason, actor = "user" } = req.body ?? {};
    if (!stopId || !toClusterId) { res.status(400).json({ error: "stopId e toClusterId richiesti" }); return; }
    const r = await moveStop(feedId, stopId, toClusterId, reason, actor);
    res.json({ ok: true, ...r });
  } catch (e: any) { res.status(500).json({ error: e.message ?? String(e) }); }
});

router.post("/fares/stop-assignment/bulk-move", async (req, res): Promise<void> => {
  try {
    await ensureNodeAssignmentTables();
    const feedId = await getLatestFeedId(req);
    if (!feedId) { res.status(400).json({ error: "No GTFS feed" }); return; }
    const { stopIds, toClusterId, reason, actor = "user" } = req.body ?? {};
    if (!Array.isArray(stopIds) || stopIds.length === 0 || !toClusterId) {
      res.status(400).json({ error: "stopIds[] e toClusterId richiesti" }); return;
    }
    const results: any[] = [];
    for (const sid of stopIds) {
      try {
        const r = await moveStop(feedId, sid, toClusterId, reason, actor);
        results.push({ stopId: sid, ok: true, ...r });
      } catch (e: any) {
        results.push({ stopId: sid, ok: false, error: e.message });
      }
    }
    res.json({ moved: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length, results });
  } catch (e: any) { res.status(500).json({ error: e.message ?? String(e) }); }
});

router.get("/fares/stop-assignment/overrides", async (req, res): Promise<void> => {
  try {
    await ensureNodeAssignmentTables();
    const feedId = await getLatestFeedId(req);
    if (!feedId) { res.json([]); return; }
    const rows = await db.select().from(gtfsFareStopAssignmentOverrides)
      .where(eq(gtfsFareStopAssignmentOverrides.feedId, feedId))
      .orderBy(sql`created_at DESC`).limit(200);
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message ?? String(e) }); }
});

router.post("/fares/stop-assignment/revert/:overrideId", async (req, res): Promise<void> => {
  try {
    await ensureNodeAssignmentTables();
    const [ov] = await db.select().from(gtfsFareStopAssignmentOverrides)
      .where(eq(gtfsFareStopAssignmentOverrides.id, req.params.overrideId));
    if (!ov) { res.status(404).json({ error: "Override non trovato" }); return; }
    if (!ov.fromClusterId) { res.status(400).json({ error: "Override non reversibile (fermata era orfana)" }); return; }

    await db.update(gtfsFareZoneClusterStops).set({
      clusterId: ov.fromClusterId,
      assignmentLayer: "manual_revert",
      assignmentSource: "manual",
      assignedAt: sql`now()`,
    }).where(and(
      eq(gtfsFareZoneClusterStops.feedId, ov.feedId),
      eq(gtfsFareZoneClusterStops.stopId, ov.stopId),
    ));

    await db.insert(gtfsFareStopAssignmentOverrides).values({
      feedId: ov.feedId, stopId: ov.stopId,
      fromClusterId: ov.toClusterId,
      toClusterId: ov.fromClusterId,
      reason: `revert of ${ov.id}`,
      actor: "system",
    });

    if (ov.toClusterId) await recalcCentroid(ov.feedId, ov.toClusterId);
    await recalcCentroid(ov.feedId, ov.fromClusterId);

    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message ?? String(e) }); }
});

// Bootstrap eager all'import: garantisce che le colonne addittive
// (is_official, official_code, assignment_*) esistano prima che fares.ts
// faccia SELECT su gtfs_fare_zone_clusters / gtfs_fare_zone_cluster_stops.
ensureNodeAssignmentTables().catch((e) => {
  console.error("[telemaco] eager bootstrap failed:", e);
});

export default router;
