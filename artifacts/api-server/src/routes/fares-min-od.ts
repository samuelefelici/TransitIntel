/**
 * GTFS Fares — Modalità "min_od" (Tariffa Minima OD via Grafo di Rete)
 *
 * INTERVENTO ADDITIVO: questo router NON modifica nessuna logica esistente
 * dei metodi shape / direct / dominant / cluster. Aggiunge soltanto un nuovo
 * metodo basato su grafo della rete tariffaria + Dijkstra all-pairs sui
 * cluster già definiti in `gtfs_fare_zone_clusters`.
 *
 * Pipeline:
 *   1. POST /api/fares/min-od/build-graph     → archi tra cluster consecutivi
 *      sui percorsi dominanti delle linee extraurbane
 *   2. POST /api/fares/min-od/compute-matrix  → Dijkstra all-pairs e tariffa
 *      DGR Marche (23 fasce) o flat urbano
 *   3. GET  /api/fares/min-od/simulate?from&to → consultazione singola coppia
 *   4. GET  /api/fares/min-od/matrix          → dump completo (paginato)
 *   5. GET  /api/fares/min-od/edges           → ispezione grafo
 *   6. GET  /api/fares/min-od/runs            → storico esecuzioni
 *   7. POST /api/fares/min-od/edges           → arco manuale (override)
 *   8. DELETE /api/fares/min-od/edges/:id     → rimuove un arco
 *   9. DELETE /api/fares/min-od/matrix         → svuota matrice (rebuild)
 */
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  gtfsFareZoneClusters,
  gtfsFareZoneClusterStops,
  gtfsFareNetworkEdges,
  gtfsFareOdMatrix,
  gtfsFareOdMatrixRuns,
  gtfsRoutes,
} from "@workspace/db/schema";
import { eq, and, sql, desc, inArray } from "drizzle-orm";
import { getLatestFeedId } from "./gtfs-helpers";
import { haversineKm } from "../lib/geo-utils";

const router: IRouter = Router();

// ════════════════════════════════════════════════════════════
// Costanti tariffarie (duplicate dal router fares.ts — non si
// importa per non introdurre dipendenze fra router).
// ════════════════════════════════════════════════════════════
const EXTRA_BANDS_MIN_OD: { fascia: number; kmFrom: number; kmTo: number; price: number }[] = [
  { fascia: 1, kmFrom: 0, kmTo: 6, price: 1.35 },
  { fascia: 2, kmFrom: 6, kmTo: 12, price: 1.85 },
  { fascia: 3, kmFrom: 12, kmTo: 18, price: 2.35 },
  { fascia: 4, kmFrom: 18, kmTo: 24, price: 2.85 },
  { fascia: 5, kmFrom: 24, kmTo: 30, price: 3.20 },
  { fascia: 6, kmFrom: 30, kmTo: 36, price: 3.55 },
  { fascia: 7, kmFrom: 36, kmTo: 42, price: 3.90 },
  { fascia: 8, kmFrom: 42, kmTo: 50, price: 4.25 },
  { fascia: 9, kmFrom: 50, kmTo: 60, price: 4.55 },
  { fascia: 10, kmFrom: 60, kmTo: 70, price: 4.85 },
  { fascia: 11, kmFrom: 70, kmTo: 80, price: 5.15 },
  { fascia: 12, kmFrom: 80, kmTo: 90, price: 5.45 },
  { fascia: 13, kmFrom: 90, kmTo: 100, price: 5.75 },
  { fascia: 14, kmFrom: 100, kmTo: 110, price: 6.05 },
  { fascia: 15, kmFrom: 110, kmTo: 120, price: 6.35 },
  { fascia: 16, kmFrom: 120, kmTo: 130, price: 6.65 },
  { fascia: 17, kmFrom: 130, kmTo: 140, price: 6.95 },
  { fascia: 18, kmFrom: 140, kmTo: 150, price: 7.25 },
  { fascia: 19, kmFrom: 150, kmTo: 160, price: 7.55 },
  { fascia: 20, kmFrom: 160, kmTo: 170, price: 7.85 },
  { fascia: 21, kmFrom: 170, kmTo: 180, price: 8.15 },
  { fascia: 22, kmFrom: 180, kmTo: 190, price: 8.45 },
  { fascia: 23, kmFrom: 190, kmTo: 200, price: 8.75 },
];

function getBandForDistanceMinOd(distKm: number) {
  if (distKm <= 0) return undefined;
  return EXTRA_BANDS_MIN_OD.find(b => distKm > b.kmFrom && distKm <= b.kmTo)
    ?? EXTRA_BANDS_MIN_OD[EXTRA_BANDS_MIN_OD.length - 1];
}

// Tariffa flat urbana (DGR Marche): tutti i bacini urbani a 1.35 €
const URBAN_FLAT_MIN_OD: Record<string, number> = {
  urbano_ancona: 1.35,
  urbano_jesi: 1.35,
  urbano_falconara: 1.35,
  urbano_senigallia: 1.35,
  urbano_castelfidardo: 1.35,
  urbano_sassoferrato: 1.35,
};

// Duplica classifyRoute (additivo, non importa da fares.ts)
function classifyRouteMinOd(shortName: string): string {
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

// ════════════════════════════════════════════════════════════
// Lazy bootstrap: pattern del progetto (CREATE TABLE IF NOT EXISTS)
// Chiamato all'inizio di ogni endpoint. Idempotente.
// ════════════════════════════════════════════════════════════
let bootstrapped = false;
async function ensureMinOdTables(): Promise<void> {
  if (bootstrapped) return;
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS gtfs_fare_network_edges (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      feed_id UUID NOT NULL REFERENCES gtfs_feeds(id) ON DELETE CASCADE,
      from_cluster_id TEXT NOT NULL,
      to_cluster_id TEXT NOT NULL,
      km DOUBLE PRECISION NOT NULL,
      route_id TEXT,
      route_short_name TEXT,
      shape_id TEXT,
      source TEXT NOT NULL DEFAULT 'dominant',
      bidirectional BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS gtfs_fare_network_edges_from_to_idx ON gtfs_fare_network_edges (feed_id, from_cluster_id, to_cluster_id);`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS gtfs_fare_network_edges_feed_idx   ON gtfs_fare_network_edges (feed_id);`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS gtfs_fare_od_matrix (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      feed_id UUID NOT NULL REFERENCES gtfs_feeds(id) ON DELETE CASCADE,
      from_cluster_id TEXT NOT NULL,
      to_cluster_id TEXT NOT NULL,
      km_tariffario DOUBLE PRECISION NOT NULL,
      fascia INTEGER,
      prezzo DOUBLE PRECISION NOT NULL,
      fare_product_id TEXT,
      path_clusters JSONB NOT NULL,
      path_routes JSONB NOT NULL,
      hop_count INTEGER NOT NULL,
      is_urban BOOLEAN NOT NULL DEFAULT FALSE,
      computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS gtfs_fare_od_matrix_from_to_idx ON gtfs_fare_od_matrix (feed_id, from_cluster_id, to_cluster_id);`);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS gtfs_fare_od_matrix_unique_idx ON gtfs_fare_od_matrix (feed_id, from_cluster_id, to_cluster_id);`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS gtfs_fare_od_matrix_runs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      feed_id UUID NOT NULL REFERENCES gtfs_feeds(id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      edge_count INTEGER,
      pairs_computed INTEGER,
      pairs_skipped INTEGER,
      duration_ms INTEGER,
      error_message TEXT,
      params JSONB,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished_at TIMESTAMPTZ
    );
  `);
  bootstrapped = true;
}

// ════════════════════════════════════════════════════════════
// Calcolo del percorso dominante locale (logica replicata da
// fares.ts → getRoutePercorsi + getDominantPercorso). Non si
// importa per evitare dipendenze trasversali tra router.
// ════════════════════════════════════════════════════════════
interface DominantStop {
  stop_id: string;
  stop_sequence: number;
  lat: number;
  lon: number;
}
interface DominantResult {
  shapeId: string | null;
  stops: DominantStop[];
  tripCount: number;
}

async function getDominantPercorsoLocal(feedId: string, routeId: string): Promise<DominantResult | null> {
  // service_id più rappresentativo
  const svcRows = await db.execute<any>(sql`
    SELECT t.service_id, COUNT(*)::int AS cnt
    FROM gtfs_trips t
    WHERE t.feed_id = ${feedId} AND t.route_id = ${routeId}
    GROUP BY t.service_id
    ORDER BY cnt DESC
    LIMIT 1
  `);
  if (svcRows.rows.length === 0) return null;
  const refServiceId: string = svcRows.rows[0].service_id;

  // tutti i trip del service di riferimento
  const tripRows = await db.execute<any>(sql`
    SELECT t.trip_id, t.shape_id
    FROM gtfs_trips t
    WHERE t.feed_id = ${feedId} AND t.route_id = ${routeId}
      AND t.service_id = ${refServiceId}
  `);
  if (tripRows.rows.length === 0) return null;

  const tripIds: string[] = tripRows.rows.map((r: any) => r.trip_id);
  const tripShapeMap = new Map<string, string | null>(
    tripRows.rows.map((r: any) => [r.trip_id, r.shape_id ?? null])
  );

  // fermate di tutti i trip
  const tripIdParams = sql.join(tripIds.map(id => sql`${id}`), sql`, `);
  const allStopsData = await db.execute<any>(sql`
    SELECT st.trip_id, st.stop_id, st.stop_sequence,
           s.stop_lat::float AS lat, s.stop_lon::float AS lon
    FROM gtfs_stop_times st
    JOIN gtfs_stops s ON s.stop_id = st.stop_id AND s.feed_id = st.feed_id
    WHERE st.feed_id = ${feedId}
      AND st.trip_id IN (${tripIdParams})
    ORDER BY st.trip_id, st.stop_sequence
  `);

  const tripStopsMap = new Map<string, DominantStop[]>();
  for (const row of allStopsData.rows) {
    if (!tripStopsMap.has(row.trip_id)) tripStopsMap.set(row.trip_id, []);
    tripStopsMap.get(row.trip_id)!.push({
      stop_id: row.stop_id,
      stop_sequence: row.stop_sequence,
      lat: row.lat,
      lon: row.lon,
    });
  }

  // signature → conteggio + scelta del rappresentante (più lungo)
  const signatureCount = new Map<string, number>();
  for (const tid of tripIds) {
    const stops = tripStopsMap.get(tid);
    if (!stops || stops.length === 0) continue;
    const shapeId = tripShapeMap.get(tid) ?? null;
    const sig = stops.map(s => s.stop_id).join("|") + "::" + (shapeId ?? "noshape");
    signatureCount.set(sig, (signatureCount.get(sig) ?? 0) + 1);
  }

  const sortedTripIds = [...tripStopsMap.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([tid]) => tid);

  const seen = new Set<string>();
  const uniques: { tripId: string; shapeId: string | null; stops: DominantStop[]; tripCount: number }[] = [];
  for (const tid of sortedTripIds) {
    const stops = tripStopsMap.get(tid);
    if (!stops || stops.length === 0) continue;
    const shapeId = tripShapeMap.get(tid) ?? null;
    const sig = stops.map(s => s.stop_id).join("|") + "::" + (shapeId ?? "noshape");
    if (seen.has(sig)) continue;
    seen.add(sig);
    uniques.push({ tripId: tid, shapeId, stops, tripCount: signatureCount.get(sig) ?? 1 });
  }
  if (uniques.length === 0) return null;

  // famiglia direzionale del più lungo
  const ref = uniques.reduce((a, b) => a.stops.length >= b.stops.length ? a : b);
  const refFirst = ref.stops[0]?.stop_id;
  const refLast = ref.stops[ref.stops.length - 1]?.stop_id;
  const dirFamily = uniques.filter(p => {
    const f = p.stops[0]?.stop_id;
    const l = p.stops[p.stops.length - 1]?.stop_id;
    return f === refFirst && l === refLast;
  });
  const pool = dirFamily.length > 0 ? dirFamily : uniques;
  const dom = pool.reduce((a, b) => a.tripCount >= b.tripCount ? a : b);

  return { shapeId: dom.shapeId, stops: dom.stops, tripCount: dom.tripCount };
}

// ════════════════════════════════════════════════════════════
// Costruzione del grafo: per ogni linea extraurbana percorre il
// dominante e crea un arco tra cluster consecutivi diversi.
// La lunghezza è la somma di haversine tra fermate consecutive
// (il cammino del bus, robusto anche senza shape).
// ════════════════════════════════════════════════════════════
interface BuildResult {
  edgesInserted: number;
  routesProcessed: number;
  routesSkipped: number;
  warnings: string[];
}

async function buildNetworkGraph(feedId: string, opts?: { onlyExtraurban?: boolean }): Promise<BuildResult> {
  const onlyExtraurban = opts?.onlyExtraurban !== false;
  const warnings: string[] = [];

  // svuota grafo precedente per questo feed (solo source='dominant', preserva 'manual')
  await db.delete(gtfsFareNetworkEdges).where(and(
    eq(gtfsFareNetworkEdges.feedId, feedId),
    eq(gtfsFareNetworkEdges.source, "dominant"),
  ));

  // mappa stop_id → cluster_id per il feed
  const clusterStopRows = await db.select({
    stopId: gtfsFareZoneClusterStops.stopId,
    clusterId: gtfsFareZoneClusterStops.clusterId,
  }).from(gtfsFareZoneClusterStops).where(eq(gtfsFareZoneClusterStops.feedId, feedId));
  const stopToCluster = new Map<string, string>();
  for (const r of clusterStopRows) stopToCluster.set(r.stopId, r.clusterId);
  if (stopToCluster.size === 0) {
    warnings.push("Nessun cluster trovato per questo feed: eseguire prima la generazione zone/cluster.");
    return { edgesInserted: 0, routesProcessed: 0, routesSkipped: 0, warnings };
  }

  // tutte le linee del feed
  const routeRows = await db.select({
    routeId: gtfsRoutes.routeId,
    routeShortName: gtfsRoutes.routeShortName,
  }).from(gtfsRoutes).where(eq(gtfsRoutes.feedId, feedId));

  type EdgeRow = {
    feedId: string;
    fromClusterId: string;
    toClusterId: string;
    km: number;
    routeId: string;
    routeShortName: string | null;
    shapeId: string | null;
    source: "dominant";
    bidirectional: boolean;
  };
  const buffer: EdgeRow[] = [];
  let processed = 0, skipped = 0;

  for (const r of routeRows) {
    const klass = classifyRouteMinOd(r.routeShortName ?? "");
    if (onlyExtraurban && klass !== "extraurbano") { skipped++; continue; }

    const dom = await getDominantPercorsoLocal(feedId, r.routeId);
    if (!dom || dom.stops.length < 2) { skipped++; continue; }

    // Riduci stop→cluster (rimuovi cluster ripetuti consecutivi e fermate non clusterizzate)
    let prevCluster: string | null = null;
    let pendingKm = 0;
    let prevLat: number | null = null, prevLon: number | null = null;

    for (const st of dom.stops) {
      const c = stopToCluster.get(st.stop_id);
      if (!c) { prevLat = st.lat; prevLon = st.lon; continue; }

      // accumula km dal cluster precedente
      if (prevLat != null && prevLon != null) {
        pendingKm += haversineKm(prevLat, prevLon, st.lat, st.lon);
      }
      prevLat = st.lat; prevLon = st.lon;

      if (prevCluster === null) { prevCluster = c; pendingKm = 0; continue; }
      if (c === prevCluster) continue; // stesso cluster, continua ad accumulare

      // arco prevCluster → c
      if (pendingKm > 0) {
        buffer.push({
          feedId,
          fromClusterId: prevCluster,
          toClusterId: c,
          km: Math.round(pendingKm * 100) / 100,
          routeId: r.routeId,
          routeShortName: r.routeShortName ?? null,
          shapeId: dom.shapeId,
          source: "dominant",
          bidirectional: true,
        });
      }
      prevCluster = c;
      pendingKm = 0;
    }
    processed++;
  }

  if (buffer.length > 0) {
    // insert in batch
    const CHUNK = 500;
    for (let i = 0; i < buffer.length; i += CHUNK) {
      await db.insert(gtfsFareNetworkEdges).values(buffer.slice(i, i + CHUNK));
    }
  }

  return { edgesInserted: buffer.length, routesProcessed: processed, routesSkipped: skipped, warnings };
}

// ════════════════════════════════════════════════════════════
// Dijkstra all-pairs sul grafo bidirezionale dei cluster.
// Per ogni coppia di archi paralleli (stessa from→to) prende il minimo km.
// Per ogni nodo sorgente esegue Dijkstra; numero cluster atteso ~110 →
// O(N^2 log N) accettabile.
// ════════════════════════════════════════════════════════════
interface ComputeResult {
  pairsComputed: number;
  pairsSkipped: number;
  edgeCount: number;
  durationMs: number;
}

async function computeOdMatrix(feedId: string): Promise<ComputeResult> {
  const t0 = Date.now();

  // 1. svuota matrice
  await db.delete(gtfsFareOdMatrix).where(eq(gtfsFareOdMatrix.feedId, feedId));

  // 2. carica cluster
  const clusters = await db.select({
    clusterId: gtfsFareZoneClusters.clusterId,
  }).from(gtfsFareZoneClusters).where(eq(gtfsFareZoneClusters.feedId, feedId));
  const clusterIds = clusters.map(c => c.clusterId);
  if (clusterIds.length === 0) return { pairsComputed: 0, pairsSkipped: 0, edgeCount: 0, durationMs: Date.now() - t0 };

  // 3. carica archi
  const edges = await db.select({
    fromClusterId: gtfsFareNetworkEdges.fromClusterId,
    toClusterId: gtfsFareNetworkEdges.toClusterId,
    km: gtfsFareNetworkEdges.km,
    routeId: gtfsFareNetworkEdges.routeId,
    bidirectional: gtfsFareNetworkEdges.bidirectional,
  }).from(gtfsFareNetworkEdges).where(eq(gtfsFareNetworkEdges.feedId, feedId));

  // 4. costruisci adiacenze: for each (from→to) prendi minimo km
  type Adj = { to: string; km: number; routeId: string | null };
  const adj = new Map<string, Map<string, Adj>>();
  const addEdge = (a: string, b: string, km: number, routeId: string | null) => {
    if (!adj.has(a)) adj.set(a, new Map());
    const m = adj.get(a)!;
    const cur = m.get(b);
    if (!cur || km < cur.km) m.set(b, { to: b, km, routeId });
  };
  for (const e of edges) {
    addEdge(e.fromClusterId, e.toClusterId, e.km, e.routeId);
    if (e.bidirectional) addEdge(e.toClusterId, e.fromClusterId, e.km, e.routeId);
  }

  // 5. Dijkstra da ciascun cluster
  type MatrixRow = typeof gtfsFareOdMatrix.$inferInsert;
  const buffer: MatrixRow[] = [];
  let computed = 0, skipped = 0;

  for (const src of clusterIds) {
    const dist = new Map<string, number>();
    const prev = new Map<string, { node: string; routeId: string | null }>();
    dist.set(src, 0);
    // priority queue come array (semplice — per ~110 nodi va bene)
    const visited = new Set<string>();
    while (true) {
      let u: string | null = null;
      let minD = Infinity;
      for (const [k, v] of dist) {
        if (visited.has(k)) continue;
        if (v < minD) { minD = v; u = k; }
      }
      if (u === null) break;
      visited.add(u);
      const neigh = adj.get(u);
      if (!neigh) continue;
      for (const e of neigh.values()) {
        const alt = minD + e.km;
        const cur = dist.get(e.to);
        if (cur === undefined || alt < cur) {
          dist.set(e.to, alt);
          prev.set(e.to, { node: u, routeId: e.routeId });
        }
      }
    }

    for (const dst of clusterIds) {
      if (dst === src) continue;
      const d = dist.get(dst);
      if (d === undefined || !isFinite(d)) { skipped++; continue; }

      // ricostruisci percorso
      const pathClusters: string[] = [dst];
      const pathRoutes: string[] = [];
      let cur: string | undefined = dst;
      while (cur && cur !== src) {
        const p = prev.get(cur);
        if (!p) break;
        if (p.routeId) pathRoutes.push(p.routeId);
        pathClusters.push(p.node);
        cur = p.node;
      }
      pathClusters.reverse();
      pathRoutes.reverse();

      const km = Math.round(d * 100) / 100;
      const band = getBandForDistanceMinOd(km);
      const prezzo = band ? band.price : EXTRA_BANDS_MIN_OD[0].price;

      buffer.push({
        feedId,
        fromClusterId: src,
        toClusterId: dst,
        kmTariffario: km,
        fascia: band?.fascia ?? null,
        prezzo,
        fareProductId: null,
        pathClusters,
        pathRoutes,
        hopCount: pathClusters.length - 1,
        isUrban: false,
        computedAt: new Date(),
      });
      computed++;
    }
  }

  // 6. insert batch
  const CHUNK = 1000;
  for (let i = 0; i < buffer.length; i += CHUNK) {
    await db.insert(gtfsFareOdMatrix).values(buffer.slice(i, i + CHUNK));
  }

  return { pairsComputed: computed, pairsSkipped: skipped, edgeCount: edges.length, durationMs: Date.now() - t0 };
}

// ════════════════════════════════════════════════════════════
// Endpoints
// ════════════════════════════════════════════════════════════

/** POST /api/fares/min-od/build-graph */
router.post("/fares/min-od/build-graph", async (req, res) => {
  try {
    await ensureMinOdTables();
    const feedId = (req.body?.feedId as string) || (await getLatestFeedId(req));
    if (!feedId) return res.status(400).json({ error: "no feed" });
    const onlyExtraurban = req.body?.onlyExtraurban !== false;
    const result = await buildNetworkGraph(feedId, { onlyExtraurban });
    return res.json({ feedId, ...result });
  } catch (err: any) {
    console.error("[min-od/build-graph]", err);
    return res.status(500).json({ error: err?.message ?? String(err) });
  }
});

/** POST /api/fares/min-od/compute-matrix */
router.post("/fares/min-od/compute-matrix", async (req, res) => {
  try {
    await ensureMinOdTables();
    const feedId = (req.body?.feedId as string) || (await getLatestFeedId(req));
    if (!feedId) return res.status(400).json({ error: "no feed" });

    const runRows = await db.insert(gtfsFareOdMatrixRuns).values({
      feedId,
      status: "running",
      params: req.body ?? {},
    }).returning({ id: gtfsFareOdMatrixRuns.id });
    const runId = runRows[0].id;

    try {
      const result = await computeOdMatrix(feedId);
      await db.update(gtfsFareOdMatrixRuns).set({
        status: "success",
        edgeCount: result.edgeCount,
        pairsComputed: result.pairsComputed,
        pairsSkipped: result.pairsSkipped,
        durationMs: result.durationMs,
        finishedAt: new Date(),
      }).where(eq(gtfsFareOdMatrixRuns.id, runId));
      return res.json({ runId, feedId, ...result });
    } catch (innerErr: any) {
      await db.update(gtfsFareOdMatrixRuns).set({
        status: "error",
        errorMessage: innerErr?.message ?? String(innerErr),
        finishedAt: new Date(),
      }).where(eq(gtfsFareOdMatrixRuns.id, runId));
      throw innerErr;
    }
  } catch (err: any) {
    console.error("[min-od/compute-matrix]", err);
    return res.status(500).json({ error: err?.message ?? String(err) });
  }
});

/** GET /api/fares/min-od/simulate?from=&to=&feedId= */
router.get("/fares/min-od/simulate", async (req, res) => {
  try {
    await ensureMinOdTables();
    const feedId = (req.query.feedId as string) || (await getLatestFeedId(req));
    const from = req.query.from as string | undefined;
    const to = req.query.to as string | undefined;
    if (!feedId || !from || !to) return res.status(400).json({ error: "feedId, from, to richiesti" });

    const rows = await db.select().from(gtfsFareOdMatrix).where(and(
      eq(gtfsFareOdMatrix.feedId, feedId),
      eq(gtfsFareOdMatrix.fromClusterId, from),
      eq(gtfsFareOdMatrix.toClusterId, to),
    )).limit(1);
    if (rows.length === 0) return res.status(404).json({ error: "coppia non trovata: rilancia compute-matrix" });
    return res.json(rows[0]);
  } catch (err: any) {
    return res.status(500).json({ error: err?.message ?? String(err) });
  }
});

/** GET /api/fares/min-od/matrix?feedId=&limit=&offset= */
router.get("/fares/min-od/matrix", async (req, res) => {
  try {
    await ensureMinOdTables();
    const feedId = (req.query.feedId as string) || (await getLatestFeedId(req));
    if (!feedId) return res.status(400).json({ error: "no feed" });
    const limit = Math.min(Number(req.query.limit ?? 5000), 20000);
    const offset = Number(req.query.offset ?? 0);
    const rows = await db.select().from(gtfsFareOdMatrix)
      .where(eq(gtfsFareOdMatrix.feedId, feedId))
      .limit(limit).offset(offset);
    const total = await db.execute<any>(sql`SELECT COUNT(*)::int AS n FROM gtfs_fare_od_matrix WHERE feed_id = ${feedId}`);
    return res.json({ feedId, total: total.rows[0]?.n ?? 0, limit, offset, rows });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message ?? String(err) });
  }
});

/** GET /api/fares/min-od/edges?feedId= */
router.get("/fares/min-od/edges", async (req, res) => {
  try {
    await ensureMinOdTables();
    const feedId = (req.query.feedId as string) || (await getLatestFeedId(req));
    if (!feedId) return res.status(400).json({ error: "no feed" });
    const rows = await db.select().from(gtfsFareNetworkEdges)
      .where(eq(gtfsFareNetworkEdges.feedId, feedId));
    return res.json({ feedId, count: rows.length, edges: rows });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message ?? String(err) });
  }
});

/** GET /api/fares/min-od/runs?feedId= */
router.get("/fares/min-od/runs", async (req, res) => {
  try {
    await ensureMinOdTables();
    const feedId = (req.query.feedId as string) || (await getLatestFeedId(req));
    if (!feedId) return res.status(400).json({ error: "no feed" });
    const rows = await db.select().from(gtfsFareOdMatrixRuns)
      .where(eq(gtfsFareOdMatrixRuns.feedId, feedId))
      .orderBy(desc(gtfsFareOdMatrixRuns.startedAt))
      .limit(50);
    return res.json({ feedId, runs: rows });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message ?? String(err) });
  }
});

/** POST /api/fares/min-od/edges  → arco manuale */
router.post("/fares/min-od/edges", async (req, res) => {
  try {
    await ensureMinOdTables();
    const feedId = (req.body?.feedId as string) || (await getLatestFeedId(req));
    const { fromClusterId, toClusterId, km, bidirectional } = req.body ?? {};
    if (!feedId || !fromClusterId || !toClusterId || typeof km !== "number") {
      return res.status(400).json({ error: "feedId, fromClusterId, toClusterId, km richiesti" });
    }
    const inserted = await db.insert(gtfsFareNetworkEdges).values({
      feedId,
      fromClusterId,
      toClusterId,
      km,
      source: "manual",
      bidirectional: bidirectional !== false,
    }).returning();
    return res.json(inserted[0]);
  } catch (err: any) {
    return res.status(500).json({ error: err?.message ?? String(err) });
  }
});

/** DELETE /api/fares/min-od/edges/:id */
router.delete("/fares/min-od/edges/:id", async (req, res) => {
  try {
    await ensureMinOdTables();
    const id = req.params.id;
    await db.delete(gtfsFareNetworkEdges).where(eq(gtfsFareNetworkEdges.id, id));
    return res.json({ ok: true, id });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message ?? String(err) });
  }
});

/** DELETE /api/fares/min-od/matrix?feedId= */
router.delete("/fares/min-od/matrix", async (req, res) => {
  try {
    await ensureMinOdTables();
    const feedId = (req.query.feedId as string) || (await getLatestFeedId(req));
    if (!feedId) return res.status(400).json({ error: "no feed" });
    const result = await db.delete(gtfsFareOdMatrix).where(eq(gtfsFareOdMatrix.feedId, feedId));
    return res.json({ ok: true, feedId, deleted: (result as any).rowCount ?? null });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message ?? String(err) });
  }
});

/**
 * GET /api/fares/min-od/route-polimetrica/:routeId
 *
 * Restituisce la polimetrica della singola linea con prezzi presi
 * dalla matrice OD globale (cammino minimo nella rete).
 *
 * Output:
 *   {
 *     routeId, routeShortName, routeLongName,
 *     stops:  [{stopId, stopName, kmFromStart, clusterId, clusterName}],
 *     zones:  [{clusterId, clusterName, label}],   // sequenza cluster sulla linea
 *     matrix: number[][]                            // zones×zones, € minimi via grafo
 *   }
 */
router.get("/fares/min-od/route-polimetrica/:routeId", async (req, res) => {
  try {
    await ensureMinOdTables();
    const feedId = (req.query.feedId as string) || (await getLatestFeedId(req));
    const routeId = req.params.routeId;
    if (!feedId || !routeId) return res.status(400).json({ error: "feedId e routeId richiesti" });

    // Anagrafica linea
    const routeRow = await db.execute<any>(sql`
      SELECT route_id, route_short_name, route_long_name
      FROM gtfs_routes WHERE feed_id = ${feedId} AND route_id = ${routeId} LIMIT 1
    `);
    if (routeRow.rows.length === 0) return res.status(404).json({ error: "route non trovata" });
    const r0 = routeRow.rows[0];

    // Mappa stop→cluster e anagrafica cluster
    const csRows = await db.select({
      stopId: gtfsFareZoneClusterStops.stopId,
      clusterId: gtfsFareZoneClusterStops.clusterId,
    }).from(gtfsFareZoneClusterStops).where(eq(gtfsFareZoneClusterStops.feedId, feedId));
    const stopToCluster = new Map<string, string>();
    for (const r of csRows) stopToCluster.set(r.stopId, r.clusterId);

    const cRows = await db.select({
      clusterId: gtfsFareZoneClusters.clusterId,
      clusterName: gtfsFareZoneClusters.clusterName,
    }).from(gtfsFareZoneClusters).where(eq(gtfsFareZoneClusters.feedId, feedId));
    const clusterName = new Map<string, string>();
    for (const c of cRows) clusterName.set(c.clusterId, c.clusterName ?? c.clusterId);

    // ─── UNIONE TUTTE LE FERMATE DI TUTTI I TRIP ──
    // Per ogni linea, alcuni trip si fermano prima (es. linea B: alcuni a Marina,
    // altri proseguono fino a Montemarciano). Costruiamo la sequenza completa
    // che è l'UNIONE di tutte le fermate vista in qualche trip, ordinate dal
    // trip più lungo che le contiene tutte (o il "merge" topologico se nessuno
    // singolo le copre tutte).
    const allTripsRow = await db.execute<any>(sql`
      SELECT st.trip_id, st.stop_id, st.stop_sequence,
             s.stop_lat::float AS lat, s.stop_lon::float AS lon
      FROM gtfs_stop_times st
      JOIN gtfs_trips t ON t.feed_id = st.feed_id AND t.trip_id = st.trip_id
      JOIN gtfs_stops s ON s.feed_id = st.feed_id AND s.stop_id = st.stop_id
      WHERE st.feed_id = ${feedId} AND t.route_id = ${routeId}
      ORDER BY st.trip_id, st.stop_sequence
    `);
    if (allTripsRow.rows.length === 0) {
      return res.status(404).json({ error: "nessun trip per questa linea" });
    }

    // Raggruppa per trip
    type StopXY = { stop_id: string; lat: number; lon: number };
    const tripsArr = new Map<string, StopXY[]>();
    for (const row of allTripsRow.rows) {
      if (!tripsArr.has(row.trip_id)) tripsArr.set(row.trip_id, []);
      tripsArr.get(row.trip_id)!.push({ stop_id: row.stop_id, lat: row.lat, lon: row.lon });
    }

    // ── STRATEGIA: trova i VERI CAPOLINEA della linea (stop più frequenti
    // come prima o ultima fermata) e scegli come base il trip più lungo che
    // collega due capolinea diversi.
    //
    // Esempio linea B: i capolinea reali sono Ancona (centro) e
    // Montemarciano (San Pietro). Molte corse brevi terminano a Marina o
    // partono da Falconara, ma il trip "completo" è quello che va da
    // capolinea a capolinea.
    const endpointFreq = new Map<string, number>();
    for (const [, stops] of tripsArr) {
      if (stops.length === 0) continue;
      const a = stops[0].stop_id;
      const b = stops[stops.length - 1].stop_id;
      endpointFreq.set(a, (endpointFreq.get(a) ?? 0) + 1);
      if (b !== a) endpointFreq.set(b, (endpointFreq.get(b) ?? 0) + 1);
    }
    // Capolinea = top 4 stop come endpoint (escludendo singoletti)
    const topEndpoints = [...endpointFreq.entries()]
      .filter(([, n]) => n >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([id]) => id);
    const isEndpoint = new Set(topEndpoints);

    // Score(trip): bonus grande se entrambi gli endpoint sono "veri capolinea",
    // bonus medio se almeno uno lo è, poi tie-break sulla lunghezza.
    const tripScore = (stops: StopXY[]): number => {
      if (stops.length < 2) return -1;
      const a = stops[0].stop_id;
      const b = stops[stops.length - 1].stop_id;
      const aIs = isEndpoint.has(a);
      const bIs = isEndpoint.has(b);
      const endpointBonus = (aIs && bIs) ? 100000 : (aIs || bIs) ? 10000 : 0;
      // tra trip con stesso bonus, vince quello con più fermate (= percorso più completo)
      return endpointBonus + stops.length;
    };

    const allTripsSorted = [...tripsArr.entries()].sort((a, b) => tripScore(b[1]) - tripScore(a[1]));
    if (allTripsSorted.length === 0) {
      return res.status(404).json({ error: "nessun trip valido" });
    }

    const baseTrip = allTripsSorted[0][1];
    const baseSet = new Set(baseTrip.map(s => s.stop_id));
    const baseIdx = new Map<string, number>();
    baseTrip.forEach((s, i) => baseIdx.set(s.stop_id, i));

    // sameDir: un trip è "stessa direzione" se la maggior parte delle fermate
    // condivise con baseTrip rispetta lo stesso ordine (forward in baseIdx).
    const sameDir = (stops: StopXY[]): boolean => {
      let fwd = 0, bwd = 0;
      for (let k = 1; k < stops.length; k++) {
        const a = baseIdx.get(stops[k - 1].stop_id);
        const b = baseIdx.get(stops[k].stop_id);
        if (a == null || b == null) continue;
        if (b > a) fwd++; else if (b < a) bwd++;
      }
      return fwd >= bwd;
    };

    // Trip nella direzione del base, ordinati dal più lungo al più corto.
    // Inizia da base e fonde gli altri inserendo nuovi stop dopo l'ultimo
    // anchor comune.
    const dirTrips = allTripsSorted.filter(([, sts]) => sameDir(sts));

    const merged: StopXY[] = baseTrip.slice();
    const inMerged = new Set<string>(merged.map(s => s.stop_id));

    // Fondi gli altri trip (skippa il base, già messo)
    for (let t = 1; t < dirTrips.length; t++) {
      const trip = dirTrips[t][1];
      let lastAnchor = -1;
      for (let k = 0; k < trip.length; k++) {
        const s = trip[k];
        if (inMerged.has(s.stop_id)) {
          lastAnchor = merged.findIndex(m => m.stop_id === s.stop_id);
        } else {
          const insertAt = lastAnchor + 1;
          merged.splice(insertAt, 0, s);
          inMerged.add(s.stop_id);
          lastAnchor = insertAt;
        }
      }
    }
    if (merged.length < 2) {
      return res.status(404).json({ error: "percorso non ricostruibile per questa linea" });
    }
    void baseSet; // riservato per future estensioni

    // Costruisci elenco fermate con km cumulato e cluster
    type StopInfo = { stopId: string; stopName: string; kmFromStart: number; clusterId: string | null; clusterName: string | null };
    const stopIds = merged.map(s => s.stop_id);
    const stopIdParams = sql.join(stopIds.map(id => sql`${id}`), sql`, `);
    const stopNamesRow = await db.execute<any>(sql`
      SELECT stop_id, stop_name FROM gtfs_stops WHERE feed_id = ${feedId} AND stop_id IN (${stopIdParams})
    `);
    const nameMap = new Map<string, string>();
    for (const r of stopNamesRow.rows) nameMap.set(r.stop_id, r.stop_name);

    const stops: StopInfo[] = [];
    let cumKm = 0;
    let prevLat: number | null = null, prevLon: number | null = null;
    for (const s of merged) {
      if (prevLat != null && prevLon != null) cumKm += haversineKm(prevLat, prevLon, s.lat, s.lon);
      prevLat = s.lat; prevLon = s.lon;
      const cId = stopToCluster.get(s.stop_id) ?? null;
      stops.push({
        stopId: s.stop_id,
        stopName: nameMap.get(s.stop_id) ?? s.stop_id,
        kmFromStart: Math.round(cumKm * 100) / 100,
        clusterId: cId,
        clusterName: cId ? (clusterName.get(cId) ?? cId) : null,
      });
    }

    // Sequenza cluster univoci nell'ordine in cui appaiono
    const zoneList: { clusterId: string; clusterName: string; label: string }[] = [];
    const seen = new Set<string>();
    for (const s of stops) {
      if (!s.clusterId || seen.has(s.clusterId)) continue;
      seen.add(s.clusterId);
      zoneList.push({
        clusterId: s.clusterId,
        clusterName: s.clusterName ?? s.clusterId,
        label: `Z${zoneList.length + 1}`,
      });
    }

    // Carica i prezzi min-od per le coppie di interesse (solo cluster della linea)
    const N = zoneList.length;
    const matrix: (number | null)[][] = Array.from({ length: N }, () => Array(N).fill(null));
    const kmMatrix: (number | null)[][] = Array.from({ length: N }, () => Array(N).fill(null));
    const fasciaMatrix: (number | null)[][] = Array.from({ length: N }, () => Array(N).fill(null));

    if (N >= 2) {
      const zoneIds = zoneList.map(z => z.clusterId);
      const zParams = sql.join(zoneIds.map(id => sql`${id}`), sql`, `);
      const odRows = await db.execute<any>(sql`
        SELECT from_cluster_id, to_cluster_id, prezzo, km_tariffario, fascia
        FROM gtfs_fare_od_matrix
        WHERE feed_id = ${feedId}
          AND from_cluster_id IN (${zParams})
          AND to_cluster_id IN (${zParams})
      `);
      const idx = new Map<string, number>();
      zoneIds.forEach((id, i) => idx.set(id, i));
      for (const o of odRows.rows) {
        const i = idx.get(o.from_cluster_id);
        const j = idx.get(o.to_cluster_id);
        if (i === undefined || j === undefined) continue;
        matrix[i][j] = Number(o.prezzo);
        kmMatrix[i][j] = Number(o.km_tariffario);
        fasciaMatrix[i][j] = o.fascia !== null ? Number(o.fascia) : null;
      }
      // Diagonale: stesso cluster → 1ª fascia
      for (let i = 0; i < N; i++) {
        if (matrix[i][i] === null) {
          matrix[i][i] = EXTRA_BANDS_MIN_OD[0].price;
          kmMatrix[i][i] = 0;
          fasciaMatrix[i][i] = 1;
        }
      }
    }

    // Per ogni cluster (nodo tariffario), elenco delle fermate di QUESTA linea
    // appartenenti a quel cluster, nell'ordine in cui appaiono lungo il percorso.
    const stopsByZone: Record<string, { stopId: string; stopName: string }[]> = {};
    for (const z of zoneList) stopsByZone[z.clusterId] = [];
    for (const s of stops) {
      if (s.clusterId && stopsByZone[s.clusterId]) {
        stopsByZone[s.clusterId].push({ stopId: s.stopId, stopName: s.stopName });
      }
    }

    return res.json({
      routeId: r0.route_id,
      routeShortName: r0.route_short_name,
      routeLongName: r0.route_long_name,
      totalKm: stops.length > 0 ? stops[stops.length - 1].kmFromStart : 0,
      stops,
      zones: zoneList,
      stopsByZone,
      matrix,
      kmMatrix,
      fasciaMatrix,
    });
  } catch (err: any) {
    console.error("[min-od/route-polimetrica]", err);
    return res.status(500).json({ error: err?.message ?? String(err) });
  }
});

/**
 * Restituisce TUTTE le varianti di percorso di una linea, raggruppando i
 * trip con la stessa sequenza di stop_id e UNIFICANDO andata/ritorno
 * (signature canonica = min(forward, reverse)).
 *
 * Output:
 *   variants: [{
 *     variantId: string,        // hash signature
 *     direction: "AB"|"BA",     // direzione del rappresentante
 *     tripCount: number,
 *     firstStopName, lastStopName,
 *     stops: [{ stopId, stopName, kmFromStart, clusterId, clusterName }],
 *     zones: [{ clusterId, clusterName, label }],   // sequenza nodi tariffari della variante
 *     stopsByZone: Record<clusterId, [{stopId,stopName}]>
 *   }]
 */
router.get("/fares/min-od/route-variants/:routeId", async (req, res) => {
  try {
    await ensureMinOdTables();
    const feedId = (req.query.feedId as string) || (await getLatestFeedId(req));
    const routeId = req.params.routeId;
    if (!feedId || !routeId) return res.status(400).json({ error: "feedId e routeId richiesti" });

    const routeRow = await db.execute<any>(sql`
      SELECT route_id, route_short_name, route_long_name
      FROM gtfs_routes WHERE feed_id = ${feedId} AND route_id = ${routeId} LIMIT 1
    `);
    if (routeRow.rows.length === 0) return res.status(404).json({ error: "route non trovata" });
    const r0 = routeRow.rows[0];

    // mapping stop→cluster
    const csRows = await db.select({
      stopId: gtfsFareZoneClusterStops.stopId,
      clusterId: gtfsFareZoneClusterStops.clusterId,
    }).from(gtfsFareZoneClusterStops).where(eq(gtfsFareZoneClusterStops.feedId, feedId));
    const stopToCluster = new Map<string, string>();
    for (const r of csRows) stopToCluster.set(r.stopId, r.clusterId);
    const cRows = await db.select({
      clusterId: gtfsFareZoneClusters.clusterId,
      clusterName: gtfsFareZoneClusters.clusterName,
    }).from(gtfsFareZoneClusters).where(eq(gtfsFareZoneClusters.feedId, feedId));
    const clusterName = new Map<string, string>();
    for (const c of cRows) clusterName.set(c.clusterId, c.clusterName ?? c.clusterId);

    // Tutti gli stop_times della linea
    const allTripsRow = await db.execute<any>(sql`
      SELECT st.trip_id, st.stop_id, st.stop_sequence,
             s.stop_lat::float AS lat, s.stop_lon::float AS lon, s.stop_name
      FROM gtfs_stop_times st
      JOIN gtfs_trips t ON t.feed_id = st.feed_id AND t.trip_id = st.trip_id
      JOIN gtfs_stops s ON s.feed_id = st.feed_id AND s.stop_id = st.stop_id
      WHERE st.feed_id = ${feedId} AND t.route_id = ${routeId}
      ORDER BY st.trip_id, st.stop_sequence
    `);
    if (allTripsRow.rows.length === 0) {
      return res.status(404).json({ error: "nessun trip per questa linea" });
    }

    type TripStop = { stop_id: string; lat: number; lon: number; stop_name: string };
    const tripsArr = new Map<string, TripStop[]>();
    for (const row of allTripsRow.rows) {
      if (!tripsArr.has(row.trip_id)) tripsArr.set(row.trip_id, []);
      tripsArr.get(row.trip_id)!.push({
        stop_id: row.stop_id, lat: row.lat, lon: row.lon, stop_name: row.stop_name,
      });
    }

    // Raggruppa per signature canonica (forward o reverse → la più piccola lex.)
    type VariantBucket = {
      variantId: string;          // signature canonica
      forwardSig: string;         // signature forward del rappresentante scelto
      stops: TripStop[];          // stops in direzione forward del rappresentante
      tripCount: number;
      forwardCount: number;       // quanti trip vanno in direzione forward
      reverseCount: number;       // quanti trip vanno in direzione reverse
    };
    const variants = new Map<string, VariantBucket>();
    for (const [, stops] of tripsArr) {
      if (stops.length < 2) continue;
      const fwd = stops.map(s => s.stop_id).join("|");
      const rev = stops.map(s => s.stop_id).reverse().join("|");
      const canonical = fwd <= rev ? fwd : rev;
      const isForward = fwd === canonical;
      let v = variants.get(canonical);
      if (!v) {
        v = {
          variantId: canonical,
          forwardSig: canonical,
          stops: isForward ? stops.slice() : stops.slice().reverse(),
          tripCount: 0,
          forwardCount: 0,
          reverseCount: 0,
        };
        variants.set(canonical, v);
      }
      v.tripCount++;
      if (isForward) v.forwardCount++; else v.reverseCount++;
    }

    if (variants.size === 0) {
      return res.status(404).json({ error: "nessuna variante valida" });
    }

    // Ordina per #trip decrescente
    const sortedVariants = [...variants.values()].sort((a, b) => b.tripCount - a.tripCount);

    // Hashing breve per id leggibile
    const shortHash = (s: string): string => {
      let h = 0;
      for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
      return Math.abs(h).toString(36).slice(0, 6);
    };

    const out = sortedVariants.map((v, idx) => {
      // costruisci dettaglio fermate con km cumulato + cluster
      let cumKm = 0;
      let prevLat: number | null = null, prevLon: number | null = null;
      const detailedStops = v.stops.map(s => {
        if (prevLat != null && prevLon != null) cumKm += haversineKm(prevLat, prevLon, s.lat, s.lon);
        prevLat = s.lat; prevLon = s.lon;
        const cId = stopToCluster.get(s.stop_id) ?? null;
        return {
          stopId: s.stop_id,
          stopName: s.stop_name,
          kmFromStart: Math.round(cumKm * 100) / 100,
          clusterId: cId,
          clusterName: cId ? (clusterName.get(cId) ?? cId) : null,
        };
      });
      // sequenza nodi tariffari (run-length)
      const zones: { clusterId: string; clusterName: string; label: string }[] = [];
      const seenZ = new Set<string>();
      for (const s of detailedStops) {
        if (!s.clusterId || seenZ.has(s.clusterId)) continue;
        seenZ.add(s.clusterId);
        zones.push({
          clusterId: s.clusterId,
          clusterName: s.clusterName ?? s.clusterId,
          label: `Z${zones.length + 1}`,
        });
      }
      const stopsByZone: Record<string, { stopId: string; stopName: string }[]> = {};
      for (const z of zones) stopsByZone[z.clusterId] = [];
      for (const s of detailedStops) {
        if (s.clusterId && stopsByZone[s.clusterId]) {
          stopsByZone[s.clusterId].push({ stopId: s.stopId, stopName: s.stopName });
        }
      }
      return {
        variantId: shortHash(v.variantId),
        order: idx + 1,
        tripCount: v.tripCount,
        forwardCount: v.forwardCount,
        reverseCount: v.reverseCount,
        firstStopName: detailedStops[0]?.stopName ?? "",
        lastStopName: detailedStops[detailedStops.length - 1]?.stopName ?? "",
        totalKm: detailedStops.length > 0 ? detailedStops[detailedStops.length - 1].kmFromStart : 0,
        stops: detailedStops,
        zones,
        stopsByZone,
      };
    });

    return res.json({
      routeId: r0.route_id,
      routeShortName: r0.route_short_name,
      routeLongName: r0.route_long_name,
      variantCount: out.length,
      tripCountTotal: out.reduce((s, v) => s + v.tripCount, 0),
      variants: out,
    });
  } catch (err: any) {
    console.error("[min-od/route-variants]", err);
    return res.status(500).json({ error: err?.message ?? String(err) });
  }
});

export default router;
