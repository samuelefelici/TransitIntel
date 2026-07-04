/**
 * CONFRONTO PROGETTI — "Planner Legacy".
 *
 * Confronta DUE progetti Planning Studio su ogni aspetto, per aiutare i capi a
 * capire quale scenario di servizio è migliore. Tutte le metriche sono
 * PROJECT-AWARE: ogni progetto è analizzato sul proprio feed materializzato
 * (`ps_projects.materialized_feed_id`), così due progetti diversi danno numeri
 * diversi anche sulle dimensioni che altrove sono globali (traffico, territorio,
 * coincidenza, intermodale).
 *
 *   GET /api/planning/compare?a=<psId>&b=<psId>
 *     → { a: ProjectMetrics, b: ProjectMetrics, generatedAt }
 *
 * PIANIFICAZIONE (feed-scoped):
 *   • rete: linee, corse, fermate, km di rete sviluppati
 *   • territorio & domanda: popolazione coperta (≤400 m da una fermata), comuni
 *   • traffico & rete: esposizione media al traffico delle fermate
 *   • zone di coincidenza + intermodale: nodi intermodali serviti, popolazione
 *     con accesso intermodale, fermate di interscambio (≥2 linee)
 * SCHEDULING (nativo, dagli scenari OPERATIVI del progetto):
 *   • turni macchina: veicoli, ore di servizio, km a vuoto, ratio deadhead, costo
 *   • turni guida: turni, ore lavoro/nastro, cambi vettura, % spezzati
 *   • UDP complete / con problemi, corse scoperte
 */
import type { Request, Response } from "express";
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { haversineKm } from "./geo-utils";
import { INTERMODAL_HUBS } from "../routes/coincidence-zones";

const router: IRouter = Router();
const UUID_RE = /^[0-9a-f-]{36}$/i;

/* ─── soglie ─── */
const COVERAGE_RADIUS_KM = 0.4;      // fermata "copre" popolazione entro 400 m
const HUB_STOP_RADIUS_KM = 0.3;      // fermata "serve" un nodo intermodale entro 300 m
const HUB_POP_RADIUS_KM = 0.8;       // popolazione con accesso intermodale entro 800 m dal nodo servito
const TRAFFIC_NEAR_KM = 0.3;         // segmento traffico "vicino" a una fermata entro 300 m
const CONGESTION_HI = 0.3;           // congestione ≥ 0.3 = fermata in area trafficata

function getUserId(req: Request): string | null {
  return (req as any).user?.id ?? (req as any).session?.userId ?? null;
}

interface CompareProject {
  id: string;
  name: string;
  feedId: string | null;
  materializedAt: string | null;
}

async function loadComparableProject(psId: string, userId: string): Promise<CompareProject | null> {
  const r = await db.execute(sql`
    SELECT p.id, p.name,
           p.materialized_feed_id AS feed_id,
           to_char(p.materialized_at, 'YYYY-MM-DD"T"HH24:MI:SSZ') AS materialized_at
      FROM ps_projects p
      LEFT JOIN ps_project_members pm ON pm.project_id = p.id AND pm.user_id = ${userId}::uuid
     WHERE p.id = ${psId}::uuid
       AND (p.owner_user_id = ${userId}::uuid OR pm.user_id IS NOT NULL)
     LIMIT 1`);
  const row = (r as any).rows?.[0];
  if (!row) return null;
  return { id: row.id, name: row.name, feedId: row.feed_id ?? null, materializedAt: row.materialized_at ?? null };
}

/* ─── griglia spaziale per join di prossimità O(n+m) ─── */
type Pt = { lat: number; lng: number; [k: string]: any };
class Grid {
  private cell: number;
  private map = new Map<string, Pt[]>();
  constructor(cellDeg: number) { this.cell = cellDeg; }
  private key(lat: number, lng: number) { return `${Math.floor(lat / this.cell)}:${Math.floor(lng / this.cell)}`; }
  add(p: Pt) {
    const k = this.key(p.lat, p.lng);
    const arr = this.map.get(k); if (arr) arr.push(p); else this.map.set(k, [p]);
  }
  /** punti nelle 9 celle attorno a (lat,lng) */
  near(lat: number, lng: number): Pt[] {
    const ci = Math.floor(lat / this.cell), cj = Math.floor(lng / this.cell);
    const out: Pt[] = [];
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
      const arr = this.map.get(`${ci + di}:${cj + dj}`);
      if (arr) out.push(...arr);
    }
    return out;
  }
}
/** true se esiste un punto della griglia entro radiusKm da (lat,lng) */
function hasWithin(grid: Grid, lat: number, lng: number, radiusKm: number): boolean {
  for (const p of grid.near(lat, lng)) if (haversineKm(lat, lng, p.lat, p.lng) <= radiusKm) return true;
  return false;
}
/** punto più vicino entro radiusKm (o null) */
function nearestWithin(grid: Grid, lat: number, lng: number, radiusKm: number): Pt | null {
  let best: Pt | null = null, bestD = radiusKm;
  for (const p of grid.near(lat, lng)) {
    const d = haversineKm(lat, lng, p.lat, p.lng);
    if (d <= bestD) { bestD = d; best = p; }
  }
  return best;
}

/* ════════════════════════ PIANIFICAZIONE (feed-scoped) ════════════════════════ */

interface PlanningMetrics {
  routes: number; trips: number; stops: number; networkKm: number;
  population: number; coveredPopulation: number; coveragePct: number;
  comuniServed: number;
  trafficStopsMeasured: number; avgCongestion: number; stopsInCongestionPct: number;
  intermodalHubsServed: number; intermodalHubsTotal: number;
  populationIntermodalAccess: number; interchangeStops: number;
}

const EMPTY_PLANNING: PlanningMetrics = {
  routes: 0, trips: 0, stops: 0, networkKm: 0,
  population: 0, coveredPopulation: 0, coveragePct: 0, comuniServed: 0,
  trafficStopsMeasured: 0, avgCongestion: 0, stopsInCongestionPct: 0,
  intermodalHubsServed: 0, intermodalHubsTotal: INTERMODAL_HUBS.length,
  populationIntermodalAccess: 0, interchangeStops: 0,
};

async function computePlanning(feedId: string): Promise<PlanningMetrics> {
  const m: PlanningMetrics = { ...EMPTY_PLANNING };

  /* conteggi rete */
  const cnt = await db.execute(sql`
    SELECT
      (SELECT COUNT(*) FROM gtfs_routes WHERE feed_id = ${feedId}::uuid)::int AS routes,
      (SELECT COUNT(*) FROM gtfs_trips  WHERE feed_id = ${feedId}::uuid)::int AS trips,
      (SELECT COUNT(*) FROM gtfs_stops  WHERE feed_id = ${feedId}::uuid)::int AS stops`);
  const c = (cnt as any).rows?.[0] ?? {};
  m.routes = Number(c.routes) || 0;
  m.trips = Number(c.trips) || 0;
  m.stops = Number(c.stops) || 0;

  /* km di rete: somma lunghezze delle shape (una volta per shape) */
  const shapesR = await db.execute(sql`
    SELECT geojson FROM gtfs_shapes WHERE feed_id = ${feedId}::uuid`);
  let networkKm = 0;
  for (const row of ((shapesR as any).rows ?? [])) {
    const g = row.geojson;
    const coords: number[][] | null =
      g?.type === "LineString" && Array.isArray(g.coordinates) ? g.coordinates :
      g?.geometry?.type === "LineString" && Array.isArray(g.geometry.coordinates) ? g.geometry.coordinates :
      null;
    if (!coords || coords.length < 2) continue;
    for (let i = 1; i < coords.length; i++) {
      networkKm += haversineKm(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]);
    }
  }
  m.networkKm = Math.round(networkKm * 10) / 10;

  /* fermate del feed (per copertura, traffico, intermodale) */
  const stopsR = await db.execute(sql`
    SELECT stop_id, stop_lat AS lat, stop_lon AS lng FROM gtfs_stops WHERE feed_id = ${feedId}::uuid`);
  const stops: Pt[] = ((stopsR as any).rows ?? [])
    .filter((s: any) => Number.isFinite(Number(s.lat)) && Number.isFinite(Number(s.lng)))
    .map((s: any) => ({ stopId: s.stop_id, lat: Number(s.lat), lng: Number(s.lng) }));
  const stopGrid = new Grid(0.01); // ~1.1 km celle
  for (const s of stops) stopGrid.add(s);

  /* territorio & domanda: popolazione coperta + comuni serviti */
  const censusR = await db.execute(sql`
    SELECT istat_code, centroid_lat AS lat, centroid_lng AS lng, population
      FROM census_sections WHERE population > 0`);
  const census: Array<{ istat: string; lat: number; lng: number; pop: number }> =
    ((censusR as any).rows ?? [])
      .filter((r: any) => Number.isFinite(Number(r.lat)) && Number.isFinite(Number(r.lng)))
      .map((r: any) => ({ istat: String(r.istat_code ?? ""), lat: Number(r.lat), lng: Number(r.lng), pop: Number(r.population) || 0 }));
  let totalPop = 0, coveredPop = 0;
  const comuniServed = new Set<string>();
  for (const s of census) {
    totalPop += s.pop;
    if (hasWithin(stopGrid, s.lat, s.lng, COVERAGE_RADIUS_KM)) {
      coveredPop += s.pop;
      if (s.istat) comuniServed.add(s.istat.slice(0, 6)); // primi 6 char ≈ codice comune ISTAT
    }
  }
  m.population = totalPop;
  m.coveredPopulation = coveredPop;
  m.coveragePct = totalPop > 0 ? Math.round((coveredPop / totalPop) * 1000) / 10 : 0;
  m.comuniServed = comuniServed.size;

  /* traffico & rete: esposizione media al traffico delle fermate.
     Uso l'ultimo snapshot per segmento. */
  const trafficR = await db.execute(sql`
    SELECT DISTINCT ON (segment_id) segment_id, lat, lng, congestion_level
      FROM traffic_snapshots
     ORDER BY segment_id, captured_at DESC`);
  const segGrid = new Grid(0.01);
  for (const r of ((trafficR as any).rows ?? [])) {
    const lat = Number(r.lat), lng = Number(r.lng);
    if (Number.isFinite(lat) && Number.isFinite(lng)) segGrid.add({ lat, lng, cong: Number(r.congestion_level) || 0 });
  }
  let measured = 0, congSum = 0, congHi = 0;
  for (const s of stops) {
    const seg = nearestWithin(segGrid, s.lat, s.lng, TRAFFIC_NEAR_KM);
    if (seg) { measured++; congSum += seg.cong as number; if ((seg.cong as number) >= CONGESTION_HI) congHi++; }
  }
  m.trafficStopsMeasured = measured;
  m.avgCongestion = measured > 0 ? Math.round((congSum / measured) * 1000) / 1000 : 0;
  m.stopsInCongestionPct = measured > 0 ? Math.round((congHi / measured) * 1000) / 10 : 0;

  /* zone di coincidenza + intermodale */
  let hubsServed = 0;
  const servedHubs: Pt[] = [];
  for (const hub of INTERMODAL_HUBS) {
    if (hasWithin(stopGrid, hub.lat, hub.lng, HUB_STOP_RADIUS_KM)) {
      hubsServed++;
      servedHubs.push({ lat: hub.lat, lng: hub.lng });
    }
  }
  m.intermodalHubsServed = hubsServed;
  // popolazione con accesso intermodale: entro HUB_POP_RADIUS_KM da un nodo servito
  if (servedHubs.length > 0) {
    const hubGrid = new Grid(0.01);
    for (const h of servedHubs) hubGrid.add(h);
    let popIntermodal = 0;
    for (const s of census) if (hasWithin(hubGrid, s.lat, s.lng, HUB_POP_RADIUS_KM)) popIntermodal += s.pop;
    m.populationIntermodalAccess = popIntermodal;
  }

  /* fermate di interscambio: servite da ≥2 linee distinte */
  const interR = await db.execute(sql`
    SELECT COUNT(*)::int AS n FROM (
      SELECT st.stop_id
        FROM gtfs_stop_times st
        JOIN gtfs_trips t ON t.feed_id = st.feed_id AND t.trip_id = st.trip_id
       WHERE st.feed_id = ${feedId}::uuid
       GROUP BY st.stop_id
      HAVING COUNT(DISTINCT t.route_id) >= 2
    ) q`);
  m.interchangeStops = Number((interR as any).rows?.[0]?.n) || 0;

  return m;
}

/* ════════════════════════ SCHEDULING (nativo per progetto) ════════════════════════ */

interface SchedulingMetrics {
  hasOperational: boolean;
  vehicles: number; serviceHours: number; deadheadKm: number; deadheadRatioPct: number; dailyCost: number;
  driverDuties: number; workHours: number; nastroHours: number; cambi: number; spezzatoPct: number;
  udpTotal: number; udpComplete: number; udpWithIssues: number; uncoveredTrips: number;
}

const EMPTY_SCHEDULING: SchedulingMetrics = {
  hasOperational: false,
  vehicles: 0, serviceHours: 0, deadheadKm: 0, deadheadRatioPct: 0, dailyCost: 0,
  driverDuties: 0, workHours: 0, nastroHours: 0, cambi: 0, spezzatoPct: 0,
  udpTotal: 0, udpComplete: 0, udpWithIssues: 0, uncoveredTrips: 0,
};

const num = (v: any): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

async function computeScheduling(psId: string): Promise<SchedulingMetrics> {
  const m: SchedulingMetrics = { ...EMPTY_SCHEDULING };
  try {
    /* scenari VEICOLO operativi del progetto (via UDP → scheduling_projects) */
    const vR = await db.execute(sql`
      SELECT sps.result AS result
        FROM service_program_scenarios sps
        JOIN scheduling_projects sp ON sp.id = sps.project_id
        JOIN ps_validity_units u ON u.id = sp.validity_unit_id
       WHERE u.project_id = ${psId}::uuid AND sps.is_operational = true`);
    let svcKm = 0, deadKm = 0;
    for (const row of ((vR as any).rows ?? [])) {
      const s = row.result?.summary ?? {};
      const cost = row.result?.costs ?? {};
      m.vehicles += num(s.totalVehicles ?? s.numVehicles);
      m.serviceHours += num(s.totalServiceHours);
      m.deadheadKm += num(s.totalDeadheadKm);
      m.dailyCost += num(cost.totalDailyCost);
      // km servizio per il ratio deadhead (somma per tipo veicolo se disponibile)
      const byT = cost.byVehicleType ?? {};
      for (const k of Object.keys(byT)) { svcKm += num(byT[k]?.serviceKm); deadKm += num(byT[k]?.deadheadKm); }
    }
    m.serviceHours = Math.round(m.serviceHours * 10) / 10;
    m.deadheadKm = Math.round(m.deadheadKm * 10) / 10;
    m.dailyCost = Math.round(m.dailyCost);
    const totKm = svcKm + deadKm;
    m.deadheadRatioPct = totKm > 0 ? Math.round((deadKm / totKm) * 1000) / 10 : 0;

    /* scenari GUIDA operativi del progetto */
    const dR = await db.execute(sql`
      SELECT dss.result AS result
        FROM driver_shift_scenarios dss
        JOIN service_program_scenarios sps ON sps.id = dss.service_program_scenario_id
        JOIN scheduling_projects sp ON sp.id = sps.project_id
        JOIN ps_validity_units u ON u.id = sp.validity_unit_id
       WHERE u.project_id = ${psId}::uuid AND dss.is_operational = true`);
    let spezzatoWeighted = 0, dutyForPct = 0;
    for (const row of ((dR as any).rows ?? [])) {
      const s = row.result?.summary ?? {};
      const duties = num(s.totalDriverShifts ?? s.totalShifts);
      m.driverDuties += duties;
      m.workHours += num(s.totalWorkHours);
      m.nastroHours += num(s.totalNastroHours);
      m.cambi += num(s.totalCambi);
      if (duties > 0 && s.spezzatoPct != null) { spezzatoWeighted += num(s.spezzatoPct) * duties; dutyForPct += duties; }
    }
    m.workHours = Math.round(m.workHours * 10) / 10;
    m.nastroHours = Math.round(m.nastroHours * 10) / 10;
    m.spezzatoPct = dutyForPct > 0 ? Math.round((spezzatoWeighted / dutyForPct) * 10) / 10 : 0;
    m.hasOperational = m.vehicles > 0 || m.driverDuties > 0;
  } catch {
    /* tabelle scenari non presenti (nessuna ottimizzazione lanciata): metriche a zero */
  }

  /* UDP: complete / con problemi / corse scoperte */
  try {
    const unitsR = await db.execute(sql`
      SELECT id, COALESCE(jsonb_array_length(trip_ids), 0) AS tc
        FROM ps_validity_units WHERE project_id = ${psId}::uuid`);
    const units: any[] = (unitsR as any).rows ?? [];
    m.udpTotal = units.length;
    for (const u of units) {
      const spR = await db.execute(sql`
        SELECT sp.id FROM scheduling_projects sp WHERE sp.validity_unit_id = ${u.id}::uuid
         ORDER BY sp.created_at DESC LIMIT 1`);
      const spId = (spR as any).rows?.[0]?.id;
      let complete = false;
      if (spId) {
        const vR2 = await db.execute(sql`
          SELECT id, COALESCE(jsonb_array_length(result->'unassigned'), 0) AS unc
            FROM service_program_scenarios WHERE project_id = ${spId}::uuid AND is_operational = true LIMIT 1`);
        const v2 = (vR2 as any).rows?.[0];
        if (v2) {
          m.uncoveredTrips += num(v2.unc);
          const dR2 = await db.execute(sql`
            SELECT 1 FROM driver_shift_scenarios
             WHERE service_program_scenario_id = ${v2.id}::uuid AND is_operational = true LIMIT 1`);
          complete = ((dR2 as any).rows?.length ?? 0) > 0;
        }
      }
      if (complete) m.udpComplete++;
    }
    m.udpWithIssues = m.udpTotal - m.udpComplete;

    /* corse del programma non incluse in nessuna UDP */
    const progUncR = await db.execute(sql`
      SELECT COUNT(*)::int AS c FROM ps_trips t
       WHERE t.project_id = ${psId}::uuid AND COALESCE(t.is_active, true) = true
         AND NOT (t.id::text = ANY (
           SELECT jsonb_array_elements_text(trip_ids) FROM ps_validity_units WHERE project_id = ${psId}::uuid
         ))`);
    m.uncoveredTrips += num((progUncR as any).rows?.[0]?.c);
  } catch { /* ps_validity_units assente */ }

  return m;
}

/* ════════════════════════ Endpoint ════════════════════════ */

router.get("/planning/compare", async (req: Request, res: Response): Promise<void> => {
  const userId = getUserId(req);
  if (!userId) { res.status(401).json({ error: "auth required" }); return; }
  const aId = String(req.query.a ?? "");
  const bId = String(req.query.b ?? "");
  if (!UUID_RE.test(aId) || !UUID_RE.test(bId)) { res.status(400).json({ error: "parametri a/b (uuid) richiesti" }); return; }
  if (aId === bId) { res.status(400).json({ error: "seleziona due progetti diversi" }); return; }

  try {
    const [pa, pb] = await Promise.all([
      loadComparableProject(aId, userId),
      loadComparableProject(bId, userId),
    ]);
    if (!pa || !pb) { res.status(404).json({ error: "progetto non trovato o non accessibile" }); return; }

    const build = async (p: CompareProject) => ({
      id: p.id,
      name: p.name,
      materialized: !!p.feedId,
      materializedAt: p.materializedAt,
      planning: p.feedId ? await computePlanning(p.feedId) : { ...EMPTY_PLANNING },
      scheduling: await computeScheduling(p.id),
    });

    const [a, b] = await Promise.all([build(pa), build(pb)]);
    res.json({ a, b });
  } catch (e: any) {
    console.error("[planning.compare] error:", e?.message || e);
    res.status(500).json({ error: "Errore nel calcolo del confronto" });
  }
});

export default router;
