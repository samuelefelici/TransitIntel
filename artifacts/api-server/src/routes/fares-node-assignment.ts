/**
 * GTFS Fares — Telemaco Compliance: auto-assegnazione fermate ai nodi tariffari.
 *
 * INTERVENTO ADDITIVO: questo router NON modifica nessuna logica esistente
 * di fares.ts o fares-min-od.ts. Aggiunge una pipeline a 4 layer (+ override
 * catalogo ufficiale) per garantire che ogni fermata fisica del feed sia
 * collegata a un nodo tariffario, come richiesto dal sistema regionale
 * Telemaco (biglietti nodo→nodo, non palina→palina).
 *
 * Pipeline (primo match vince):
 *   Layer 0  Catalogo ufficiale (conf 95-100)
 *   Layer 1  Match esatto nome normalizzato (conf 95)
 *   Layer 2  Token + prossimità (conf 80)
 *   Layer 3  DBSCAN geografico (conf 60)
 *   Layer 4  Singleton (conf 100, da revisionare)
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
// Layer 3: DBSCAN geografico
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
// Orchestratore pipeline
// ════════════════════════════════════════════════════════════
async function runNodeAssignmentPipeline(feedId: string, opts: {
  useOfficialCatalog?: boolean;
  clearExistingAuto?: boolean;
  exactRadiusM?: number;
  tokenRadiusM?: number;
  tokenMinShared?: number;
  geoEpsilonM?: number;
  geoMinPts?: number;
} = {}) {
  const params = {
    useOfficialCatalog: opts.useOfficialCatalog ?? true,
    clearExistingAuto:  opts.clearExistingAuto  ?? true,
    exactRadiusM:       opts.exactRadiusM       ?? 800,
    tokenRadiusM:       opts.tokenRadiusM       ?? 500,
    tokenMinShared:     opts.tokenMinShared     ?? 2,
    geoEpsilonM:        opts.geoEpsilonM        ?? 300,
    geoMinPts:          opts.geoMinPts          ?? 2,
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
      const toDelete = await db.select({ clusterId: gtfsFareZoneClusters.clusterId })
        .from(gtfsFareZoneClusters)
        .where(and(
          eq(gtfsFareZoneClusters.feedId, feedId),
          sql`cluster_id LIKE 'auto_%'`,
          eq(gtfsFareZoneClusters.isOfficial, false),
        ));
      const ids = toDelete.map(x => x.clusterId);
      if (ids.length > 0) {
        await db.delete(gtfsFareZoneClusterStops).where(and(
          eq(gtfsFareZoneClusterStops.feedId, feedId),
          inArray(gtfsFareZoneClusterStops.clusterId, ids),
        ));
        await db.delete(gtfsFareZoneClusters).where(and(
          eq(gtfsFareZoneClusters.feedId, feedId),
          inArray(gtfsFareZoneClusters.clusterId, ids),
        ));
      }
    }

    const finalAssignments = new Map<string, {
      clusterId: string; clusterName: string; layer: string; confidence: number; isOfficial: boolean;
    }>();
    const newClusters = new Map<string, { name: string; isOfficial: boolean; officialCode: string | null }>();
    const layerStats: Record<string, number> = { official: 0, exact: 0, token: 0, geo: 0, singleton: 0 };

    // Layer 0
    if (params.useOfficialCatalog) {
      const officialMap = await applyOfficialCatalogLayer(feedId, stops);
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

    // Layer 1
    let remaining = stops.filter(s => !finalAssignments.has(s.stopId));
    const exactRes = applyExactNameLayer(remaining, params.exactRadiusM);
    for (const [stopId, clusterId] of exactRes.assignments) {
      const c = exactRes.clusters.get(clusterId)!;
      finalAssignments.set(stopId, { clusterId, clusterName: c.name, layer: "exact", confidence: 95, isOfficial: false });
      if (!newClusters.has(clusterId)) newClusters.set(clusterId, { name: c.name, isOfficial: false, officialCode: null });
      layerStats.exact++;
    }

    // Layer 2
    remaining = stops.filter(s => !finalAssignments.has(s.stopId));
    const tokenRes = applyTokenLayer(remaining, { minSharedTokens: params.tokenMinShared, radiusM: params.tokenRadiusM });
    for (const [stopId, clusterId] of tokenRes.assignments) {
      const c = tokenRes.clusters.get(clusterId)!;
      finalAssignments.set(stopId, { clusterId, clusterName: c.name, layer: "token", confidence: 80, isOfficial: false });
      if (!newClusters.has(clusterId)) newClusters.set(clusterId, { name: c.name, isOfficial: false, officialCode: null });
      layerStats.token++;
    }

    // Layer 3
    remaining = stops.filter(s => !finalAssignments.has(s.stopId));
    const geoRes = applyDbscanLayer(remaining, { epsilonM: params.geoEpsilonM, minPts: params.geoMinPts });
    for (const [stopId, clusterId] of geoRes.assignments) {
      const c = geoRes.clusters.get(clusterId)!;
      finalAssignments.set(stopId, { clusterId, clusterName: c.name, layer: "geo", confidence: 60, isOfficial: false });
      if (!newClusters.has(clusterId)) newClusters.set(clusterId, { name: c.name, isOfficial: false, officialCode: null });
      layerStats.geo++;
    }

    // Layer 4
    remaining = stops.filter(s => !finalAssignments.has(s.stopId));
    const singletonRes = applySingletonLayer(remaining);
    for (const [stopId, clusterId] of singletonRes.assignments) {
      const c = singletonRes.clusters.get(clusterId)!;
      finalAssignments.set(stopId, { clusterId, clusterName: c.name, layer: "singleton", confidence: 100, isOfficial: false });
      if (!newClusters.has(clusterId)) newClusters.set(clusterId, { name: c.name, isOfficial: false, officialCode: null });
      layerStats.singleton++;
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
        color: meta.isOfficial ? "#10b981" : "#3b82f6",
        isOfficial: meta.isOfficial,
        officialCode: meta.officialCode,
      }).onConflictDoUpdate({
        target: [gtfsFareZoneClusters.feedId, gtfsFareZoneClusters.clusterId],
        set: { clusterName: meta.name, centroidLat, centroidLon, updatedAt: sql`now()`, isOfficial: meta.isOfficial, officialCode: meta.officialCode },
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

router.post("/api/fares/node-assignment/run", async (req, res): Promise<void> => {
  try {
    await ensureNodeAssignmentTables();
    const feedId = await getLatestFeedId();
    if (!feedId) { res.status(400).json({ error: "No GTFS feed" }); return; }
    const result = await runNodeAssignmentPipeline(feedId, req.body ?? {});
    res.json(result);
  } catch (e: any) { res.status(500).json({ error: e.message ?? String(e) }); }
});

router.get("/api/fares/node-assignment/runs", async (_req, res): Promise<void> => {
  try {
    await ensureNodeAssignmentTables();
    const feedId = await getLatestFeedId();
    if (!feedId) { res.json([]); return; }
    const rows = await db.select().from(gtfsFareNodeAssignmentRuns)
      .where(eq(gtfsFareNodeAssignmentRuns.feedId, feedId))
      .orderBy(sql`started_at DESC`).limit(50);
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message ?? String(e) }); }
});

router.get("/api/fares/node-assignment/report", async (_req, res): Promise<void> => {
  try {
    await ensureNodeAssignmentTables();
    const feedId = await getLatestFeedId();
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

router.get("/api/fares/node-assignment/low-confidence", async (req, res): Promise<void> => {
  try {
    await ensureNodeAssignmentTables();
    const feedId = await getLatestFeedId();
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

router.get("/api/fares/node-assignment/ambiguous", async (req, res): Promise<void> => {
  try {
    await ensureNodeAssignmentTables();
    const feedId = await getLatestFeedId();
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

router.get("/api/fares/node-assignment/orphans", async (_req, res): Promise<void> => {
  try {
    await ensureNodeAssignmentTables();
    const feedId = await getLatestFeedId();
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

router.get("/api/fares/official-nodes", async (_req, res): Promise<void> => {
  try {
    await ensureNodeAssignmentTables();
    const feedId = await getLatestFeedId();
    if (!feedId) { res.json([]); return; }
    const rows = await db.select().from(gtfsFareOfficialNodes)
      .where(eq(gtfsFareOfficialNodes.feedId, feedId))
      .orderBy(gtfsFareOfficialNodes.officialName);
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message ?? String(e) }); }
});

router.post("/api/fares/official-nodes", async (req, res): Promise<void> => {
  try {
    await ensureNodeAssignmentTables();
    const feedId = await getLatestFeedId();
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

router.post("/api/fares/official-nodes/import-csv", async (req, res): Promise<void> => {
  try {
    await ensureNodeAssignmentTables();
    const feedId = await getLatestFeedId();
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

router.post("/api/fares/official-nodes/import-atma-2013", async (_req, res): Promise<void> => {
  try {
    await ensureNodeAssignmentTables();
    const feedId = await getLatestFeedId();
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

router.delete("/api/fares/official-nodes/:id", async (req, res): Promise<void> => {
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

router.post("/api/fares/stop-assignment/move", async (req, res): Promise<void> => {
  try {
    await ensureNodeAssignmentTables();
    const feedId = await getLatestFeedId();
    if (!feedId) { res.status(400).json({ error: "No GTFS feed" }); return; }
    const { stopId, toClusterId, reason, actor = "user" } = req.body ?? {};
    if (!stopId || !toClusterId) { res.status(400).json({ error: "stopId e toClusterId richiesti" }); return; }
    const r = await moveStop(feedId, stopId, toClusterId, reason, actor);
    res.json({ ok: true, ...r });
  } catch (e: any) { res.status(500).json({ error: e.message ?? String(e) }); }
});

router.post("/api/fares/stop-assignment/bulk-move", async (req, res): Promise<void> => {
  try {
    await ensureNodeAssignmentTables();
    const feedId = await getLatestFeedId();
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

router.get("/api/fares/stop-assignment/overrides", async (_req, res): Promise<void> => {
  try {
    await ensureNodeAssignmentTables();
    const feedId = await getLatestFeedId();
    if (!feedId) { res.json([]); return; }
    const rows = await db.select().from(gtfsFareStopAssignmentOverrides)
      .where(eq(gtfsFareStopAssignmentOverrides.feedId, feedId))
      .orderBy(sql`created_at DESC`).limit(200);
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message ?? String(e) }); }
});

router.post("/api/fares/stop-assignment/revert/:overrideId", async (req, res): Promise<void> => {
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

export default router;
