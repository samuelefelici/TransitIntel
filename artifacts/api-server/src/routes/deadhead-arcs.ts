/* ═══════════════════════════════════════════════════════════════
 *  ARCHI FUORILINEA — archivio modificabile dei percorsi a vuoto
 *
 *  Sezione dedicata: genera gli archi con percorso REALE su strada
 *  (OSRM /route con geometria), li mostra su mappa e permette di
 *  modificarne percorso (via points) e tempi, o di DISEGNARNE uno a mano.
 *  Gli override (custom_min/custom_km e i percorsi reindirizzati
 *  source='manual') sono CONSUMATI dallo scheduling: service-program li
 *  applica alla matrice fuorilinea prima di lanciare il solver VSP/VCSP.
 *
 *  REGOLA DELLE COPPIE: un fuorilinea esiste SOLO tra
 *    deposito ↔ capolinea · capolinea ↔ capolinea ·
 *    cluster  ↔ capolinea · cluster  ↔ deposito
 *  (mai deposito↔deposito, mai cluster↔cluster). La regola vale per la
 *  generazione automatica E per l'inserimento manuale.
 *
 *  Scope: ps_project_id NULL = arco globale; valorizzato = arco valido
 *  solo per quel progetto Planner Studio (vince sull'omologo globale).
 * ═══════════════════════════════════════════════════════════════ */
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { depots, gtfsTrips, gtfsStopTimes, gtfsStops, stopClusters, stopClusterStops } from "@workspace/db/schema";
import { eq, inArray, and } from "drizzle-orm";
import { asyncHandler } from "../middlewares/error-handler";
import { getLatestFeedId } from "./gtfs-helpers";

const router: IRouter = Router();

const OSRM_BASE = process.env.OSRM_URL || "https://router.project-osrm.org";
const CHUNK = 500;
const MAX_ARCS_PER_RUN = 600;          // tetto per una singola generazione
const OSRM_CONCURRENCY = 5;
const FALLBACK_SPEED_KMH = 22;         // per la stima haversine se OSRM non risponde
const FALLBACK_CIRCUITY = 1.35;

/* ── Tabella additiva (pattern roster.ts: lazy bootstrap idempotente) ── */
let bootstrapped = false;
async function ensureTable(): Promise<void> {
  if (bootstrapped) return;
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS deadhead_arcs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      from_key text NOT NULL,
      from_type text NOT NULL,
      from_name text,
      from_lat double precision NOT NULL,
      from_lon double precision NOT NULL,
      to_key text NOT NULL,
      to_type text NOT NULL,
      to_name text,
      to_lat double precision NOT NULL,
      to_lon double precision NOT NULL,
      geometry jsonb,
      road_km double precision,
      travel_min double precision,
      custom_min double precision,
      custom_km double precision,
      via_points jsonb,
      source text NOT NULL DEFAULT 'osrm',
      note text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (from_key, to_key)
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_deadhead_arcs_from ON deadhead_arcs(from_key)`);
  // Scope per progetto PS: NULL = globale. L'unicità coppia diventa per-scope
  // (due progetti possono avere versioni diverse dello stesso arco).
  await db.execute(sql`ALTER TABLE deadhead_arcs ADD COLUMN IF NOT EXISTS ps_project_id uuid`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_deadhead_arcs_ps ON deadhead_arcs(ps_project_id)`);
  await db.execute(sql`ALTER TABLE deadhead_arcs DROP CONSTRAINT IF EXISTS deadhead_arcs_from_key_to_key_key`);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_deadhead_arcs_pair_scope
      ON deadhead_arcs (from_key, to_key, COALESCE(ps_project_id, '00000000-0000-0000-0000-000000000000'::uuid))
  `);
  bootstrapped = true;
}

const UUID_RE = /^[0-9a-f-]{36}$/i;

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371, toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** OSRM /route con geometria GeoJSON su una sequenza di punti [lat,lon][]. */
async function osrmRoute(points: [number, number][]): Promise<{ geometry: any; km: number; min: number } | null> {
  const coordStr = points.map(([lat, lon]) => `${lon},${lat}`).join(";");
  const url = `${OSRM_BASE}/route/v1/driving/${coordStr}?overview=full&geometries=geojson&continue_straight=false`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const j: any = await r.json();
    const route = j?.routes?.[0];
    if (!route?.geometry) return null;
    return {
      geometry: route.geometry,
      km: Math.round((Number(route.distance) || 0) / 100) / 10,
      min: Math.round((Number(route.duration) || 0) / 60 * 10) / 10,
    };
  } catch {
    return null;
  }
}

/** Route con fallback haversine (linea retta, stima source='stima'). */
async function routeOrEstimate(points: [number, number][]): Promise<{ geometry: any; km: number; min: number; source: string }> {
  const real = await osrmRoute(points);
  if (real) return { ...real, source: "osrm" };
  let km = 0;
  for (let i = 0; i < points.length - 1; i++) {
    km += haversineKm(points[i][0], points[i][1], points[i + 1][0], points[i + 1][1]);
  }
  km = Math.round(km * FALLBACK_CIRCUITY * 10) / 10;
  return {
    geometry: { type: "LineString", coordinates: points.map(([lat, lon]) => [lon, lat]) },
    km,
    min: Math.round((km / FALLBACK_SPEED_KMH) * 60 * 10) / 10,
    source: "stima",
  };
}

interface ArcNode { key: string; type: string; name: string; lat: number; lon: number }

/* ── Regola delle coppie ammesse (vale per generazione E inserimento manuale) ──
 * deposito↔capolinea · capolinea↔capolinea · cluster↔capolinea · cluster↔deposito */
const ALLOWED_PAIRS = new Set([
  "depot|terminus", "terminus|depot",
  "terminus|terminus",
  "cluster|terminus", "terminus|cluster",
  "cluster|depot", "depot|cluster",
]);
export const PAIR_RULE_MSG =
  "Coppia non ammessa: i fuorilinea si creano solo tra deposito↔capolinea, " +
  "capolinea↔capolinea, cluster↔capolinea e cluster↔deposito";
function isAllowedPair(a: ArcNode, b: ArcNode): boolean {
  return a.key !== b.key && ALLOWED_PAIRS.has(`${a.type}|${b.type}`);
}

/** Cluster di cambio in linea come nodi: posizione = baricentro delle fermate
 * del cluster. I cluster sono GLOBALI nel DB ma appartengono a una rete:
 * con feedId si tengono SOLO i cluster con almeno una fermata presente nel
 * feed (e il baricentro si calcola sulle sole fermate di quel feed) — così
 * i cluster di altre reti non compaiono nel progetto. */
async function loadClusters(clusterIds: string[] | null, feedId: string | null): Promise<ArcNode[]> {
  let rows = await db.select().from(stopClusters);
  if (clusterIds && clusterIds.length > 0) {
    rows = rows.filter(c => clusterIds.includes(c.id));
  }
  if (!rows.length) return [];
  const stops = await db.select().from(stopClusterStops)
    .where(inArray(stopClusterStops.clusterId, rows.map(c => c.id)));

  let inFeed: (stopId: string) => boolean = () => true;
  if (feedId) {
    const ids = [...new Set(stops.map(s => s.gtfsStopId).filter(Boolean))] as string[];
    const present = new Set<string>();
    for (let i = 0; i < ids.length; i += CHUNK) {
      const found = await db.select({ stopId: gtfsStops.stopId }).from(gtfsStops)
        .where(and(eq(gtfsStops.feedId, feedId), inArray(gtfsStops.stopId, ids.slice(i, i + CHUNK))));
      for (const f of found) present.add(f.stopId);
    }
    inFeed = (stopId) => present.has(stopId);
  }

  const out: ArcNode[] = [];
  for (const c of rows) {
    const mine = stops.filter(s => s.clusterId === c.id && s.stopLat != null && s.stopLon != null
      && (feedId ? (s.gtfsStopId != null && inFeed(s.gtfsStopId)) : true));
    if (!mine.length) continue;
    const lat = mine.reduce((s, x) => s + Number(x.stopLat), 0) / mine.length;
    const lon = mine.reduce((s, x) => s + Number(x.stopLon), 0) / mine.length;
    out.push({ key: `cluster:${c.id}`, type: "cluster", name: c.name, lat, lon });
  }
  return out;
}

/** Capolinea (primo/ultimo stop dei trip) delle linee scelte — stessa logica di /deadheads/compute. */
async function loadTerminals(feedId: string, routeIds: string[] | null): Promise<ArcNode[]> {
  let trips: { tripId: string; routeId: string }[];
  if (routeIds && routeIds.length > 0) {
    trips = await db.select({ tripId: gtfsTrips.tripId, routeId: gtfsTrips.routeId })
      .from(gtfsTrips)
      .where(and(eq(gtfsTrips.feedId, feedId), inArray(gtfsTrips.routeId, routeIds)));
  } else {
    trips = await db.select({ tripId: gtfsTrips.tripId, routeId: gtfsTrips.routeId })
      .from(gtfsTrips).where(eq(gtfsTrips.feedId, feedId));
  }
  if (!trips.length) return [];
  const tripIds = trips.map(t => t.tripId);

  const bounds = new Map<string, { minSeq: number; maxSeq: number; minStop: string; maxStop: string }>();
  for (let i = 0; i < tripIds.length; i += CHUNK) {
    const rows = await db
      .select({ tripId: gtfsStopTimes.tripId, stopId: gtfsStopTimes.stopId, stopSequence: gtfsStopTimes.stopSequence })
      .from(gtfsStopTimes)
      .where(and(eq(gtfsStopTimes.feedId, feedId), inArray(gtfsStopTimes.tripId, tripIds.slice(i, i + CHUNK))));
    for (const st of rows) {
      const cur = bounds.get(st.tripId);
      if (!cur) bounds.set(st.tripId, { minSeq: st.stopSequence, maxSeq: st.stopSequence, minStop: st.stopId, maxStop: st.stopId });
      else {
        if (st.stopSequence < cur.minSeq) { cur.minSeq = st.stopSequence; cur.minStop = st.stopId; }
        if (st.stopSequence > cur.maxSeq) { cur.maxSeq = st.stopSequence; cur.maxStop = st.stopId; }
      }
    }
  }
  const terminusIds = [...new Set([...bounds.values()].flatMap(b => [b.minStop, b.maxStop]))];
  const out: ArcNode[] = [];
  for (let i = 0; i < terminusIds.length; i += CHUNK) {
    const rows = await db
      .select({ stopId: gtfsStops.stopId, stopName: gtfsStops.stopName, stopLat: gtfsStops.stopLat, stopLon: gtfsStops.stopLon })
      .from(gtfsStops)
      .where(and(eq(gtfsStops.feedId, feedId), inArray(gtfsStops.stopId, terminusIds.slice(i, i + CHUNK))));
    for (const s of rows) {
      if (s.stopLat == null || s.stopLon == null) continue;
      out.push({ key: `stop:${s.stopId}`, type: "terminus", name: s.stopName ?? s.stopId, lat: s.stopLat, lon: s.stopLon });
    }
  }
  return out;
}

function rowToArc(r: any) {
  return {
    id: r.id,
    from: { key: r.from_key, type: r.from_type, name: r.from_name, lat: Number(r.from_lat), lon: Number(r.from_lon) },
    to: { key: r.to_key, type: r.to_type, name: r.to_name, lat: Number(r.to_lat), lon: Number(r.to_lon) },
    geometry: r.geometry,
    roadKm: r.road_km != null ? Number(r.road_km) : null,
    travelMin: r.travel_min != null ? Number(r.travel_min) : null,
    customMin: r.custom_min != null ? Number(r.custom_min) : null,
    customKm: r.custom_km != null ? Number(r.custom_km) : null,
    viaPoints: r.via_points ?? null,
    source: r.source,
    note: r.note,
    psProjectId: r.ps_project_id ?? null,
    updatedAt: r.updated_at,
  };
}

/* ── GET lista archi ── */
router.get("/deadhead-arcs", asyncHandler(async (req, res) => {
  await ensureTable();
  const psProjectId = String(req.query.psProjectId ?? "");
  const rows = UUID_RE.test(psProjectId)
    // globali + archi di QUEL progetto
    ? await db.execute<any>(sql`SELECT * FROM deadhead_arcs WHERE ps_project_id IS NULL OR ps_project_id = ${psProjectId}::uuid ORDER BY from_type DESC, from_name, to_name`)
    : await db.execute<any>(sql`SELECT * FROM deadhead_arcs ORDER BY from_type DESC, from_name, to_name`);
  res.json({ arcs: (rows.rows ?? []).map(rowToArc) });
}));

/* ── POST genera archi — SOLO coppie ammesse (vedi regola in testa al file) ──
 * Body: { depotIds?: string[] (vuoto = tutti), routeIds?: string[] (vuoto =
 * tutte le linee del feed), terminalPairsMaxKm?: number (0/assente = niente
 * coppie capolinea↔capolinea), includeClusters?: boolean (default false),
 * clusterIds?: string[] (vuoto = tutti, se includeClusters), replace?: boolean } */
router.post("/deadhead-arcs/generate", asyncHandler(async (req, res) => {
  await ensureTable();
  const { depotIds, routeIds, terminalPairsMaxKm, includeClusters, clusterIds, replace } = (req.body ?? {}) as any;
  const psProjectId: string | null = UUID_RE.test(String((req.body as any)?.psProjectId ?? ""))
    ? String((req.body as any).psProjectId) : null;

  const feedId = await getLatestFeedId(req);
  if (!feedId) { res.status(400).json({ error: "Nessun feed GTFS disponibile" }); return; }

  let depotRows = await db.select().from(depots);
  if (Array.isArray(depotIds) && depotIds.length > 0) {
    depotRows = depotRows.filter(d => depotIds.includes(d.id));
  }
  const depotNodes: ArcNode[] = depotRows
    .filter(d => d.lat != null && d.lon != null)
    .map(d => ({ key: `depot:${d.id}`, type: "depot", name: d.name, lat: d.lat!, lon: d.lon! }));
  if (!depotNodes.length) { res.status(400).json({ error: "Nessun deposito con coordinate" }); return; }

  const terminals = await loadTerminals(feedId, Array.isArray(routeIds) && routeIds.length ? routeIds : null);
  if (!terminals.length) { res.status(400).json({ error: "Nessun capolinea trovato per le linee scelte" }); return; }

  const clusterNodes: ArcNode[] = includeClusters === true
    ? await loadClusters(Array.isArray(clusterIds) && clusterIds.length ? clusterIds : null, feedId)
    : [];

  // Coppie: deposito↔capolinea; capolinea↔capolinea entro maxKm;
  // cluster↔capolinea e cluster↔deposito (entrambi i versi).
  const pairs: { a: ArcNode; b: ArcNode }[] = [];
  for (const d of depotNodes) for (const t of terminals) { pairs.push({ a: d, b: t }); pairs.push({ a: t, b: d }); }
  const maxTT = Number(terminalPairsMaxKm) || 0;
  if (maxTT > 0) {
    for (let i = 0; i < terminals.length; i++) {
      for (let j = 0; j < terminals.length; j++) {
        if (i === j) continue;
        if (haversineKm(terminals[i].lat, terminals[i].lon, terminals[j].lat, terminals[j].lon) <= maxTT) {
          pairs.push({ a: terminals[i], b: terminals[j] });
        }
      }
    }
  }
  for (const c of clusterNodes) {
    for (const t of terminals) { pairs.push({ a: c, b: t }); pairs.push({ a: t, b: c }); }
    for (const d of depotNodes) { pairs.push({ a: c, b: d }); pairs.push({ a: d, b: c }); }
  }
  // Rete di sicurezza: la regola delle coppie vale qualunque sia la sorgente
  const allowed = pairs.filter(p => isAllowedPair(p.a, p.b));

  // Salta gli archi già presenti NELLO STESSO SCOPE (a meno di replace)
  const existing = await db.execute<any>(sql`SELECT from_key, to_key FROM deadhead_arcs WHERE ps_project_id IS NOT DISTINCT FROM ${psProjectId}::uuid`);
  const have = new Set((existing.rows ?? []).map((r: any) => `${r.from_key}|${r.to_key}`));
  let todo = allowed.filter(p => replace || !have.has(`${p.a.key}|${p.b.key}`));
  const truncated = todo.length > MAX_ARCS_PER_RUN;
  todo = todo.slice(0, MAX_ARCS_PER_RUN);

  // OSRM con concorrenza limitata
  let created = 0, estimated = 0;
  for (let i = 0; i < todo.length; i += OSRM_CONCURRENCY) {
    const batch = todo.slice(i, i + OSRM_CONCURRENCY);
    const results = await Promise.all(batch.map(async ({ a, b }) => {
      const r = await routeOrEstimate([[a.lat, a.lon], [b.lat, b.lon]]);
      return { a, b, r };
    }));
    for (const { a, b, r } of results) {
      await db.execute(sql`
        INSERT INTO deadhead_arcs (from_key, from_type, from_name, from_lat, from_lon,
                                   to_key, to_type, to_name, to_lat, to_lon,
                                   geometry, road_km, travel_min, via_points, source, ps_project_id, updated_at)
        VALUES (${a.key}, ${a.type}, ${a.name}, ${a.lat}, ${a.lon},
                ${b.key}, ${b.type}, ${b.name}, ${b.lat}, ${b.lon},
                ${JSON.stringify(r.geometry)}::jsonb, ${r.km}, ${r.min}, NULL, ${r.source}, ${psProjectId}::uuid, now())
        ON CONFLICT (from_key, to_key, COALESCE(ps_project_id, '00000000-0000-0000-0000-000000000000'::uuid)) DO UPDATE SET
          geometry = EXCLUDED.geometry, road_km = EXCLUDED.road_km,
          travel_min = EXCLUDED.travel_min, via_points = NULL,
          source = EXCLUDED.source, updated_at = now()
      `);
      created++;
      if (r.source === "stima") estimated++;
    }
  }

  res.json({
    created,
    skippedExisting: allowed.length - todo.length - (truncated ? 0 : 0),
    estimated,
    truncated,
    depots: depotNodes.length,
    terminals: terminals.length,
    clusters: clusterNodes.length,
  });
}));

/* ── GET nodi candidati per il disegno manuale ──
 * Restituisce depositi, capolinea (del feed/linee scelte) e cluster come
 * ArcNode: sono gli UNICI estremi ammessi per un fuorilinea. */
router.get("/deadhead-arcs/nodes", asyncHandler(async (req, res) => {
  const feedId = await getLatestFeedId(req);
  const routeIdsRaw = String(req.query.routeIds ?? "").trim();
  const routeIds = routeIdsRaw ? routeIdsRaw.split(",").map(s => s.trim()).filter(Boolean) : null;

  const depotRows = await db.select().from(depots);
  const depotNodes: ArcNode[] = depotRows
    .filter(d => d.lat != null && d.lon != null)
    .map(d => ({ key: `depot:${d.id}`, type: "depot", name: d.name, lat: d.lat!, lon: d.lon! }));
  const terminals = feedId ? await loadTerminals(feedId, routeIds) : [];
  const clusters = await loadClusters(null, feedId);
  res.json({ depots: depotNodes, terminals, clusters });
}));

/* ── POST crea un fuorilinea DISEGNATO A MANO ──
 * Body: { from: ArcNode, to: ArcNode, viaPoints?: [[lat,lon],...] (max 8),
 *         psProjectId?: uuid, note?: string }
 * Gli estremi devono rispettare la regola delle coppie; il percorso passa
 * dai via points via OSRM e nasce source='manual' (vince nello scheduling). */
router.post("/deadhead-arcs", asyncHandler(async (req, res) => {
  await ensureTable();
  const raw = (req.body ?? {}) as any;
  const parseNode = (n: any): ArcNode | null => {
    if (!n || typeof n.key !== "string" || !n.key || typeof n.type !== "string") return null;
    const lat = Number(n.lat), lon = Number(n.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    if (!["depot", "terminus", "cluster"].includes(n.type)) return null;
    return { key: n.key.slice(0, 120), type: n.type, name: String(n.name ?? "").slice(0, 200), lat, lon };
  };
  const from = parseNode(raw.from);
  const to = parseNode(raw.to);
  if (!from || !to) { res.status(400).json({ error: "from/to non validi: servono key, type (depot|terminus|cluster), lat, lon" }); return; }
  if (!isAllowedPair(from, to)) { res.status(400).json({ error: PAIR_RULE_MSG }); return; }
  const psProjectId: string | null = UUID_RE.test(String(raw.psProjectId ?? "")) ? String(raw.psProjectId) : null;
  const via: [number, number][] = Array.isArray(raw.viaPoints)
    ? raw.viaPoints
        .filter((p: any) => Array.isArray(p) && Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1])))
        .slice(0, 8)
        .map((p: any) => [Number(p[0]), Number(p[1])] as [number, number])
    : [];

  const dup = await db.execute<any>(sql`
    SELECT id FROM deadhead_arcs
     WHERE from_key = ${from.key} AND to_key = ${to.key}
       AND ps_project_id IS NOT DISTINCT FROM ${psProjectId}::uuid`);
  if (dup.rows?.[0]) {
    res.status(409).json({ error: "Arco già presente in questo scope: modificalo dall'elenco invece di ricrearlo", id: dup.rows[0].id });
    return;
  }

  const r = await routeOrEstimate([[from.lat, from.lon], ...via, [to.lat, to.lon]]);
  const ins = await db.execute<any>(sql`
    INSERT INTO deadhead_arcs (from_key, from_type, from_name, from_lat, from_lon,
                               to_key, to_type, to_name, to_lat, to_lon,
                               geometry, road_km, travel_min, via_points, source, note, ps_project_id, updated_at)
    VALUES (${from.key}, ${from.type}, ${from.name}, ${from.lat}, ${from.lon},
            ${to.key}, ${to.type}, ${to.name}, ${to.lat}, ${to.lon},
            ${JSON.stringify(r.geometry)}::jsonb, ${r.km}, ${r.min},
            ${via.length ? JSON.stringify(via) : null}::jsonb, 'manual',
            ${typeof raw.note === "string" ? raw.note.slice(0, 300) : null},
            ${psProjectId}::uuid, now())
    RETURNING *
  `);
  res.status(201).json(rowToArc((ins.rows ?? [])[0]));
}));

/* ── PATCH tempi/km personalizzati e note ── */
router.patch("/deadhead-arcs/:id", asyncHandler(async (req, res) => {
  await ensureTable();
  const { customMin, customKm, note } = (req.body ?? {}) as any;
  const num = (v: any) => (v === null || v === "" || v === undefined ? null
    : Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : undefined);
  const cm = num(customMin), ck = num(customKm);
  if (cm === undefined || ck === undefined) { res.status(400).json({ error: "customMin/customKm non validi" }); return; }
  const rows = await db.execute<any>(sql`
    UPDATE deadhead_arcs
       SET custom_min = ${cm}, custom_km = ${ck},
           note = ${typeof note === "string" ? note.slice(0, 300) : null},
           updated_at = now()
     WHERE id = ${req.params.id as string}::uuid
     RETURNING *
  `);
  const row = (rows.rows ?? [])[0];
  if (!row) { res.status(404).json({ error: "Arco non trovato" }); return; }
  res.json(rowToArc(row));
}));

/* ── POST reroute: ricalcola il percorso passando dai via points ──
 * Body: { viaPoints: [[lat,lon], ...] } — vuoto = reset al percorso diretto. */
router.post("/deadhead-arcs/:id/reroute", asyncHandler(async (req, res) => {
  await ensureTable();
  const raw = (req.body ?? {}) as any;
  const via: [number, number][] = Array.isArray(raw.viaPoints)
    ? raw.viaPoints
        .filter((p: any) => Array.isArray(p) && Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1])))
        .slice(0, 8)
        .map((p: any) => [Number(p[0]), Number(p[1])] as [number, number])
    : [];
  const rows = await db.execute<any>(sql`SELECT * FROM deadhead_arcs WHERE id = ${req.params.id as string}::uuid`);
  const arc = (rows.rows ?? [])[0];
  if (!arc) { res.status(404).json({ error: "Arco non trovato" }); return; }

  const points: [number, number][] = [
    [Number(arc.from_lat), Number(arc.from_lon)],
    ...via,
    [Number(arc.to_lat), Number(arc.to_lon)],
  ];
  const r = await routeOrEstimate(points);
  const source = via.length ? "manual" : r.source;
  const upd = await db.execute<any>(sql`
    UPDATE deadhead_arcs
       SET geometry = ${JSON.stringify(r.geometry)}::jsonb,
           road_km = ${r.km}, travel_min = ${r.min},
           via_points = ${via.length ? JSON.stringify(via) : null}::jsonb,
           source = ${source}, updated_at = now()
     WHERE id = ${req.params.id as string}::uuid
     RETURNING *
  `);
  res.json(rowToArc((upd.rows ?? [])[0]));
}));

/* ── DELETE arco singolo / tutti ── */
router.delete("/deadhead-arcs/:id", asyncHandler(async (req, res) => {
  await ensureTable();
  await db.execute(sql`DELETE FROM deadhead_arcs WHERE id = ${req.params.id as string}::uuid`);
  res.json({ ok: true });
}));

router.delete("/deadhead-arcs", asyncHandler(async (req, res) => {
  await ensureTable();
  const psProjectId = String(req.query.psProjectId ?? "");
  const r = UUID_RE.test(psProjectId)
    // cancella SOLO gli archi di quel progetto (i globali restano)
    ? await db.execute<any>(sql`DELETE FROM deadhead_arcs WHERE ps_project_id = ${psProjectId}::uuid RETURNING id`)
    : await db.execute<any>(sql`DELETE FROM deadhead_arcs RETURNING id`);
  res.json({ ok: true, deleted: (r.rows ?? []).length });
}));

export default router;
