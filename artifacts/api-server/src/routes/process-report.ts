/**
 * Relazione di processo — dossier + documento per gli stakeholder.
 *
 * Ogni passaggio (pianificazione → turni macchina → turni guida → costi) viene
 * raccolto in un DOSSIER (JSON) a partire da ciò che il sistema ha già
 * registrato: scenario vetture (input, risultato, configurazione), scenario
 * turni guida collegato, progetto Planning Studio (linee, tracciati, fermate,
 * registro attività con attribuzione operatore/agente), campagna di scenari
 * dello stesso progetto e, se forniti dal chiamante (Argos), decisioni e piani
 * dell'agente. Il dossier alimenta scripts/report_builder.py che produce la
 * relazione HTML completa (testo tecnico, formule, grafici SVG, disegni,
 * costi), stampabile in PDF dal browser. Le relazioni generate sono
 * persistite (tabella process_reports) e apribili da Cerbero.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { spawn } from "child_process";
import path from "path";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { SCRIPTS_DIR } from "../lib/scripts-dir";
import { getVehicleScenarioAccess, requireVehicleScenarioRead, vehicleScenariosAccessibleWhere } from "../lib/scenario-access";

const router: IRouter = Router();
const UUID_RE = /^[0-9a-f-]{36}$/i;

let tableReady = false;
async function ensureTable(): Promise<void> {
  if (tableReady) return;
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS process_reports (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      scenario_id uuid,
      dss_id uuid,
      project_id uuid,
      ps_project_id uuid,
      owner_user_id uuid,
      title text NOT NULL,
      is_test boolean NOT NULL DEFAULT false,
      summary jsonb,
      dossier jsonb NOT NULL,
      html text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_process_reports_scenario ON process_reports(scenario_id, created_at DESC)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_process_reports_project ON process_reports(project_id, created_at DESC)`);
  // Colonne additive lette dal dossier: su un DB dove nessuno scenario è stato
  // ancora salvato col nuovo codice non esistono e la SELECT fallirebbe.
  await db.execute(sql`ALTER TABLE service_program_scenarios ADD COLUMN IF NOT EXISTS config jsonb`);
  await db.execute(sql`ALTER TABLE service_program_scenarios ADD COLUMN IF NOT EXISTS depots jsonb`);
  await db.execute(sql`ALTER TABLE service_program_scenarios ADD COLUMN IF NOT EXISTS project_id uuid`);
  tableReady = true;
}

function rows(r: any): any[] { return (r as any)?.rows ?? (Array.isArray(r) ? r : []); }

function runReportBuilder(dossier: unknown, logger: { info: (...a: any[]) => void }): Promise<{ html: string; summary: any }> {
  const scriptPath = path.resolve(SCRIPTS_DIR, "report_builder.py");
  return new Promise((resolve, reject) => {
    const py = spawn("python3", [scriptPath, "--json"], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env } });
    let stdout = "";
    let stderr = "";
    py.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    py.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    py.on("error", (e) => reject(new Error(`report_builder non avviabile: ${e.message}`)));
    py.on("close", (code) => {
      if (code !== 0) {
        logger.info(`report_builder stderr: ${stderr.slice(-1500)}`);
        reject(new Error(`report_builder terminato con codice ${code}: ${stderr.slice(-400)}`));
        return;
      }
      try {
        const out = JSON.parse(stdout);
        if (!out || typeof out.html !== "string") { reject(new Error("report_builder: uscita senza html")); return; }
        resolve({ html: out.html, summary: out.summary ?? null });
      } catch (e: any) {
        reject(new Error(`report_builder: uscita non JSON (${e?.message})`));
      }
    });
    py.stdin.on("error", () => { /* il processo può chiudere prima della fine dello stdin */ });
    py.stdin.write(JSON.stringify(dossier));
    py.stdin.end();
  });
}

function minOf(t: string | null | undefined): number | null {
  if (!t) return null;
  const m = /^(\d{1,2}):(\d{2})/.exec(String(t));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function fmtDate(v: any): string {
  try { return new Date(v).toISOString().slice(0, 16).replace("T", " "); } catch { return String(v ?? ""); }
}

/** KPI compatti di uno scenario (vetture + guida) per la campagna. */
function runKpi(result: any, config: any): any {
  const s = result?.summary ?? {};
  const v = result?.vcsp;
  const kpi: any = { vehicles: s.totalVehicles ?? null };
  if (v && Array.isArray(v.rounds) && v.rounds.length > 0) {
    const sel = result?.vcspSelectedRound ?? v.bestRound ?? null;
    const r = v.rounds.find((x: any) => x.round === sel) ?? v.rounds[v.rounds.length - 1];
    Object.assign(kpi, {
      vehicles: r.vehicles ?? kpi.vehicles, duties: r.duties ?? null, violations: r.bdsViolations ?? null,
      vehicleCostEur: r.vehicleCostEur ?? null, crewCostEur: r.crewCostEur ?? null, totalCostEur: r.totalCostEur ?? null,
      selectionScoreEur: r.selectionScoreEur ?? null, round: r.round ?? null, probe: !!r.probe,
      byType: v.crew?.summary?.byType ?? null,
    });
  } else {
    Object.assign(kpi, {
      vehicleCostEur: result?.costs?.vehicleTotalCost ?? null,
      totalCostEur: result?.costs?.totalDailyCost ?? null,
    });
  }
  if (config?.crewConfig?.weights) kpi.weights = config.crewConfig.weights;
  return kpi;
}

interface DossierExtra {
  title?: string; subtitle?: string; author?: string; company?: string;
  isTest?: boolean; testNote?: string;
  decisions?: { kind?: string; content?: string }[];
  plans?: { id?: any; at?: string; goal?: string; summary?: string; status?: string }[];
}

/** Costruisce il dossier di processo per uno scenario vetture (+ DSS). */
export async function buildProcessDossier(scenarioId: string, dssIdReq: string | null, extra: DossierExtra): Promise<any> {
  await ensureTable();
  const scR = await db.execute(sql`
    SELECT id, name, date, feed_id, input, result, created_at, project_id, depots, config
      FROM service_program_scenarios WHERE id = ${scenarioId}::uuid
  `);
  const sc = rows(scR)[0];
  if (!sc) throw new Error("Scenario non trovato");
  const input = sc.input ?? {};
  const result = sc.result ?? {};
  const config = sc.config ?? {};

  // Turni guida collegati: quello richiesto o il più recente
  let dss: any = null;
  if (dssIdReq && UUID_RE.test(dssIdReq)) {
    dss = rows(await db.execute(sql`SELECT id, name, result, config, created_at FROM driver_shift_scenarios WHERE id = ${dssIdReq}::uuid AND service_program_scenario_id = ${scenarioId}::uuid`))[0] ?? null;
  }
  if (!dss) {
    dss = rows(await db.execute(sql`SELECT id, name, result, config, created_at FROM driver_shift_scenarios WHERE service_program_scenario_id = ${scenarioId}::uuid ORDER BY created_at DESC LIMIT 1`))[0] ?? null;
  }
  const crew = dss?.result ?? result?.vcsp?.crew ?? null;

  // Progetto di scheduling → progetto Planning Studio + UDP
  let sp: any = null, ps: any = null, vu: any = null, dayType: any = null;
  if (sc.project_id) {
    sp = rows(await db.execute(sql`SELECT id, name, planning_studio_project_id, validity_unit_id FROM scheduling_projects WHERE id = ${sc.project_id}::uuid`))[0] ?? null;
    if (sp?.planning_studio_project_id) {
      ps = rows(await db.execute(sql`SELECT id, name FROM ps_projects WHERE id = ${sp.planning_studio_project_id}::uuid`))[0] ?? null;
    }
    if (sp?.validity_unit_id) {
      vu = rows(await db.execute(sql`SELECT id, name, trip_count, day_count, representative_dates, day_type_id FROM ps_validity_units WHERE id = ${sp.validity_unit_id}::uuid`))[0] ?? null;
      if (vu?.day_type_id) {
        dayType = rows(await db.execute(sql`SELECT code, name FROM ps_day_types WHERE id = ${vu.day_type_id}::uuid`))[0] ?? null;
      }
    }
  }
  const psId: string | null = ps?.id ?? null;

  // Linee del giro
  const routeIds: string[] = Array.isArray(input.routes)
    ? input.routes.map((r: any) => String(r?.routeId ?? "")).filter((x: string) => UUID_RE.test(x)) : [];
  const routeStats: any[] = Array.isArray(result.routeStats) ? result.routeStats : [];
  const shifts: any[] = Array.isArray(result.shifts) ? result.shifts : [];

  // km e cadenza per linea dalle corse del risultato (stessa fonte dei turni)
  const perRoute = new Map<string, { name: string; trips: number; first: number | null; last: number | null; deps: number[]; vehicleType: string | null }>();
  for (const s of shifts) {
    for (const t of s.trips ?? []) {
      if (t.type !== "trip") continue;
      const key = String(t.routeId ?? t.routeName ?? "?");
      let e = perRoute.get(key);
      if (!e) { e = { name: String(t.routeName ?? key), trips: 0, first: null, last: null, deps: [], vehicleType: s.vehicleType ?? null }; perRoute.set(key, e); }
      e.trips += 1;
      const dep = Number(t.departureMin);
      if (Number.isFinite(dep)) {
        e.deps.push(dep);
        e.first = e.first == null ? dep : Math.min(e.first, dep);
        e.last = e.last == null ? dep : Math.max(e.last, dep);
      }
    }
  }
  const headwayOf = (deps: number[]): string | null => {
    if (deps.length < 3) return null;
    const d = [...deps].sort((a, b) => a - b);
    const gaps: number[] = [];
    for (let i = 1; i < d.length; i++) { const gp = d[i] - d[i - 1]; if (gp > 0 && gp <= 180) gaps.push(gp); }
    if (gaps.length === 0) return null;
    const cnt = new Map<number, number>();
    for (const gp of gaps) cnt.set(gp, (cnt.get(gp) ?? 0) + 1);
    const mode = [...cnt.entries()].sort((a, b) => b[1] - a[1])[0][0];
    return `${mode}′`;
  };

  let psRoutes: any[] = [];
  let polylines: any[] = [];
  let stops: any[] = [];
  let flex: any[] = [];
  let stopsCount: number | null = null;
  if (psId) {
    const rr = rows(await db.execute(sql`
      SELECT id, short_name, long_name, attributes FROM ps_routes
       WHERE project_id = ${psId}::uuid ${routeIds.length > 0 ? sql`AND id = ANY(${routeIds}::uuid[])` : sql``}
       ORDER BY sort_order, short_name
    `));
    psRoutes = rr;
    flex = rr.filter((r: any) => Number(r.attributes?.flexMin) > 0).map((r: any) => ({ line: r.short_name, flexMin: Number(r.attributes.flexMin) }));
    const routeSet = new Set(rr.map((r: any) => r.id));
    if (routeSet.size > 0) {
      const ids = [...routeSet];
      const vr = rows(await db.execute(sql`
        SELECT v.id, v.route_id, v.name, v.direction, v.is_default FROM ps_route_variants v
         WHERE v.project_id = ${psId}::uuid AND v.route_id = ANY(${ids}::uuid[])
         ORDER BY v.route_id, v.direction ASC, v.is_default DESC, v.created_at ASC
      `));
      // una variante per direzione per linea (la predefinita), per un disegno leggibile
      const chosen: any[] = [];
      const seen = new Set<string>();
      for (const v of vr) { const k = `${v.route_id}|${v.direction}`; if (!seen.has(k)) { seen.add(k); chosen.push(v); } }
      const vids = chosen.map((v: any) => v.id);
      const shapes = new Map<string, any>();
      for (const s of rows(await db.execute(sql`SELECT variant_id, geometry FROM ps_shapes WHERE variant_id = ANY(${vids}::uuid[])`))) shapes.set(s.variant_id, s.geometry);
      const vstops = rows(await db.execute(sql`
        SELECT vs.variant_id, vs.seq, s.id AS stop_id, s.name, s.lat, s.lon FROM ps_variant_stops vs
          JOIN ps_stops s ON s.id = vs.stop_id
         WHERE vs.variant_id = ANY(${vids}::uuid[]) ORDER BY vs.variant_id, vs.seq
      `));
      const byV = new Map<string, any[]>();
      for (const s of vstops) { let a = byV.get(s.variant_id); if (!a) { a = []; byV.set(s.variant_id, a); } a.push(s); }
      const routeName = new Map(rr.map((r: any) => [r.id, r.short_name]));
      const clusterNames: string[] = Array.isArray(crew?.clusters) ? crew.clusters.map((c: any) => String(c?.name ?? "").toUpperCase()).filter(Boolean) : [];
      const stopSeen = new Map<string, any>();
      for (const v of chosen) {
        const geom = shapes.get(v.id);
        let points: number[][] = [];
        if (geom && geom.type === "LineString" && Array.isArray(geom.coordinates)) {
          points = geom.coordinates.map((c: any) => [Number(c[1]), Number(c[0])]).filter((p: number[]) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
        } else if (geom && geom.type === "MultiLineString" && Array.isArray(geom.coordinates)) {
          points = geom.coordinates.flat().map((c: any) => [Number(c[1]), Number(c[0])]).filter((p: number[]) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
        }
        const vs = byV.get(v.id) ?? [];
        if (points.length < 2) points = vs.map((s: any) => [Number(s.lat), Number(s.lon)]).filter((p: number[]) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
        if (points.length >= 2 && v.direction === 0) polylines.push({ name: routeName.get(v.route_id) ?? v.name, points });
        for (const s of vs) {
          if (!stopSeen.has(s.stop_id) && Number.isFinite(Number(s.lat)) && Number.isFinite(Number(s.lon))) {
            const up = String(s.name ?? "").toUpperCase();
            const node = clusterNames.some(cn => cn && (up === cn || up.startsWith(cn) || cn.startsWith(up)));
            stopSeen.set(s.stop_id, { name: s.name, lat: Number(s.lat), lon: Number(s.lon), node });
          }
        }
      }
      stops = [...stopSeen.values()];
      stopsCount = stops.length;
      // se lo stesso nodo compare più volte (fermate omonime), tienine uno solo come nodo
      const nodeNames = new Set<string>();
      for (const s of stops) { if (s.node) { if (nodeNames.has(s.name)) s.node = false; else nodeNames.add(s.name); } }
    }
  }
  const lines = (psRoutes.length > 0 ? psRoutes : [...perRoute.keys()].map(k => ({ id: k, short_name: perRoute.get(k)!.name, attributes: {} })))
    .map((r: any) => {
      const pr = perRoute.get(r.id) ?? [...perRoute.values()].find(e => e.name === r.short_name);
      const rs = routeStats.find((x: any) => x.routeId === r.id || x.routeName === r.short_name);
      return {
        name: r.short_name, routeId: r.id, longName: r.long_name ?? null,
        trips: pr?.trips ?? rs?.tripsCount ?? 0,
        firstDep: pr?.first != null ? `${String(Math.floor(pr.first / 60)).padStart(2, "0")}:${String(pr.first % 60).padStart(2, "0")}` : rs?.firstDeparture ?? null,
        lastDep: pr?.last != null ? `${String(Math.floor(pr.last / 60)).padStart(2, "0")}:${String(pr.last % 60).padStart(2, "0")}` : null,
        headway: pr ? headwayOf(pr.deps) : null,
        vehicleType: rs?.vehicleType ?? pr?.vehicleType ?? null,
        vehiclesNeeded: rs?.vehiclesNeeded ?? null,
        flexMin: Number(r.attributes?.flexMin) > 0 ? Number(r.attributes.flexMin) : null,
        km: null as number | null,
      };
    });
  // km per linea dai tracciati (distanza shape × corse) quando disponibile
  if (psId && lines.length > 0) {
    const kmR = rows(await db.execute(sql`
      SELECT v.route_id, AVG(COALESCE(sh.distance_m, 0))::float AS avg_m
        FROM ps_route_variants v LEFT JOIN ps_shapes sh ON sh.variant_id = v.id
       WHERE v.project_id = ${psId}::uuid GROUP BY v.route_id
    `));
    const avgM = new Map(kmR.map((x: any) => [x.route_id, Number(x.avg_m) || 0]));
    for (const l of lines) { const m = avgM.get(l.routeId); if (m && l.trips) l.km = Math.round((m * l.trips) / 100) / 10; }
  }

  // Registro attività del progetto di pianificazione (con attribuzione)
  let timeline: any[] = [];
  const activityCounts: Record<string, number> = {};
  if (psId) {
    const ar = rows(await db.execute(sql`
      SELECT a.action, a.target_type, a.target_id, a.payload, a.at, u.full_name, u.email
        FROM ps_project_activity_log a LEFT JOIN users u ON u.id = a.user_id
       WHERE a.project_id = ${psId}::uuid ORDER BY a.at ASC LIMIT 2000
    `));
    for (const a of ar) {
      activityCounts[a.action] = (activityCounts[a.action] ?? 0) + 1;
    }
    // Cronologia compatta: raggruppa le raffiche (stessa azione, stesso autore, entro 10 minuti)
    const grouped: any[] = [];
    for (const a of ar) {
      const prev = grouped[grouped.length - 1];
      const at = new Date(a.at).getTime();
      const who = a.full_name || a.email || "operatore";
      const via = a.payload?.via ?? null;
      if (prev && prev.action === a.action && prev.who === who && prev.via === via && at - prev._last <= 10 * 60 * 1000) {
        prev.count += 1; prev._last = at;
      } else {
        grouped.push({ at: fmtDate(a.at), action: a.action, who, via, count: 1, _last: at,
          detail: a.payload?.count != null ? `(${a.payload.count})` : "" });
      }
    }
    timeline = grouped.map(x => ({ at: x.at, action: x.action, who: x.who, via: x.via, detail: x.count > 1 ? `×${x.count} ${x.detail}`.trim() : x.detail }));
  }

  // Campagna: tutti gli scenari dello stesso progetto di scheduling
  let runs: any[] = [];
  if (sc.project_id) {
    const rr = rows(await db.execute(sql`
      SELECT id, name, created_at, config,
             jsonb_build_object(
               'summary', result->'summary', 'costs', result->'costs',
               'vcspSelectedRound', result->'vcspSelectedRound',
               'vcsp', CASE WHEN result ? 'vcsp' THEN jsonb_build_object(
                  'rounds', result->'vcsp'->'rounds', 'bestRound', result->'vcsp'->'bestRound',
                  'crew', jsonb_build_object('summary', result->'vcsp'->'crew'->'summary'),
                  'probe', jsonb_build_object('shiftedTrips', result->'vcsp'->'probe'->'shiftedTrips', 'accepted', jsonb_array_length(COALESCE(result->'vcsp'->'probe'->'accepted', '[]'::jsonb)))
               ) ELSE NULL END
             ) AS res
        FROM service_program_scenarios WHERE project_id = ${sc.project_id}::uuid ORDER BY created_at ASC
    `));
    runs = rr.map((r: any) => ({
      scenarioId: r.id, name: r.name, at: fmtDate(r.created_at), selected: r.id === scenarioId,
      kpi: runKpi(r.res, r.config), probe: r.res?.vcsp?.probe ?? null,
      params: { vcsp: r.config?.vcsp ?? null, weights: r.config?.crewConfig?.weights ?? null },
    }));
  }

  // Parametri e provenienza
  const crewConfig = config?.crewConfig ?? dss?.config?.crewConfig ?? null;
  const metrics = crew?.metrics ?? {};
  const params = {
    vcsp: input?.vcsp ?? config?.vcsp ?? null,
    crewConfig,
    weights: crewConfig?.weights ?? null,
    weightFactors: metrics?.optimizerParams?.weightFactors ?? metrics?.weightFactors ?? null,
    shiftRules: crewConfig?.bds?.shiftRules ?? null,
    costRates: crewConfig?.costRates ?? null,
    vehicleCosts: config?.vehicleCosts ?? null,
    vspAdvanced: config?.vspAdvanced ?? null,
    companyCars: crew?.summary?.companyCarsCap ?? config?.companyCars ?? metrics?.companyCars ?? null,
    segmentation: metrics?.segmentation ?? null,
    provenance: {
      crewConfig: config?.crewConfig ? "scenario" : (dss?.config?.crewConfig ? "turni guida" : "default del motore (non registrato nello scenario)"),
      vehicleCosts: config?.vehicleCosts ? "scenario" : "default del motore (non registrato nello scenario)",
    },
  };

  const serviceDate = sc.date ? `${String(sc.date).slice(0, 4)}-${String(sc.date).slice(4, 6)}-${String(sc.date).slice(6, 8)}` : null;
  return {
    meta: {
      title: extra.title ?? null, subtitle: extra.subtitle ?? null, author: extra.author ?? null, company: extra.company ?? null,
      generatedAt: new Date().toISOString().slice(0, 16).replace("T", " "),
      projectName: ps?.name ?? sp?.name ?? null, schedulingProjectName: sp?.name ?? null,
      udpName: vu?.name ?? null, udpTrips: vu?.trip_count ?? null, udpDays: vu?.day_count ?? null,
      serviceDate, dayType: dayType ? `${dayType.name} (${dayType.code})` : null,
      scenarioName: sc.name, scenarioId: sc.id, scenarioCreatedAt: fmtDate(sc.created_at),
      dssName: dss?.name ?? null, dssId: dss?.id ?? null,
      isTest: !!extra.isTest, testNote: extra.testNote ?? null,
      source: input?.source ?? null, mode: input?.mode ?? result?.solver ?? null,
    },
    network: { lines, stopsCount, nodes: Array.isArray(crew?.clusters) ? crew.clusters.map((c: any) => c?.name).filter(Boolean) : [], polylines, stops },
    planning: {
      timeline, activityCounts,
      decisions: Array.isArray(extra.decisions) ? extra.decisions : [],
      plans: Array.isArray(extra.plans) ? extra.plans : [],
      validities: vu ? [{ name: vu.name, trips: vu.trip_count, dayTypes: dayType ? [dayType.name] : [] , days: vu.day_count }] : [],
      flex,
    },
    runs,
    final: {
      vsp: { metrics: result?.solverMetrics ?? null, summary: result?.summary ?? null, costs: result?.costs ?? null,
             costBreakdown: result?.costBreakdown ?? null, vehicleShifts: shifts, advisories: result?.advisories ?? [] },
      crew: crew ? { summary: crew.summary ?? null, metrics: crew.metrics ?? null, driverShifts: crew.driverShifts ?? [], handovers: crew.handovers ?? [], clusters: crew.clusters ?? [] } : null,
      vcsp: result?.vcsp ? { rounds: result.vcsp.rounds ?? [], bestRound: result.vcsp.bestRound ?? null, selectedRound: result?.vcspSelectedRound ?? null,
                             probe: result.vcsp.probe ?? null, feedback: result.vcsp.feedback ?? null } : null,
      params,
    },
    costs: { unit: [], notes: [] },
  };
}

function isAdmin(req: Request): boolean { return req.user?.role === "admin"; }

async function canReadReport(req: Request, row: any): Promise<boolean> {
  if (!req.user) return false;
  if (isAdmin(req) || (row.owner_user_id && row.owner_user_id === req.user.id)) return true;
  if (row.scenario_id) {
    const acc = await getVehicleScenarioAccess(row.scenario_id, req.user.id, false);
    return !!acc;
  }
  return false;
}

/** POST /api/service-program/scenarios/:id/report — genera (e salva) la relazione */
router.post("/service-program/scenarios/:id/report", async (req: Request, res: Response) => {
  try {
    const acc = await requireVehicleScenarioRead(req, res, String(req.params.id));
    if (!acc) return;
    await ensureTable();
    const b = (req.body ?? {}) as Record<string, any>;
    const extra: DossierExtra = {
      title: typeof b.title === "string" ? b.title.slice(0, 200) : undefined,
      subtitle: typeof b.subtitle === "string" ? b.subtitle.slice(0, 300) : undefined,
      author: typeof b.author === "string" ? b.author.slice(0, 120) : (req.user?.fullName ?? req.user?.email ?? undefined),
      company: typeof b.company === "string" ? b.company.slice(0, 120) : undefined,
      isTest: !!b.isTest, testNote: typeof b.testNote === "string" ? b.testNote.slice(0, 500) : undefined,
      decisions: Array.isArray(b.decisions) ? b.decisions.slice(0, 100) : undefined,
      plans: Array.isArray(b.plans) ? b.plans.slice(0, 100) : undefined,
    };
    const dossier = await buildProcessDossier(String(req.params.id), typeof b.dssId === "string" ? b.dssId : null, extra);
    const built = await runReportBuilder(dossier, req.log);
    const title = dossier.meta.title ?? `Relazione · ${dossier.meta.udpName ?? dossier.meta.projectName ?? dossier.meta.scenarioName ?? ""}`.trim();
    if (b.persist === false) {
      res.json({ title, summary: built.summary, html: built.html, dossier: b.includeDossier ? dossier : undefined });
      return;
    }
    const ins = rows(await db.execute(sql`
      INSERT INTO process_reports (scenario_id, dss_id, project_id, ps_project_id, owner_user_id, title, is_test, summary, dossier, html)
      VALUES (${String(req.params.id)}::uuid, ${dossier.meta.dssId ?? null}::uuid, ${acc.projectId ?? null}::uuid,
              ${(dossier.meta as any).psProjectId ?? null}::uuid, ${req.user!.id}::uuid, ${title}, ${!!extra.isTest},
              ${JSON.stringify(built.summary ?? {})}::jsonb, ${JSON.stringify(dossier)}::jsonb, ${built.html})
      RETURNING id, created_at
    `));
    const id = ins[0]?.id;
    res.json({ reportId: id, title, createdAt: ins[0]?.created_at, path: `/fucina/relazioni/${id}`, htmlPath: `/api/service-program/reports/${id}/html`,
               summary: built.summary, sizeChars: built.html.length });
  } catch (err: any) {
    req.log.error(err, "process report generation failed");
    res.status(500).json({ error: err?.message ?? "errore generazione relazione" });
  }
});

/** GET /api/service-program/reports — elenco relazioni accessibili */
router.get("/service-program/reports", async (req: Request, res: Response) => {
  try {
    if (!req.user) { res.status(401).json({ error: "Non autenticato" }); return; }
    await ensureTable();
    const scenarioId = typeof req.query.scenarioId === "string" && UUID_RE.test(req.query.scenarioId) ? req.query.scenarioId : null;
    const projectId = typeof req.query.projectId === "string" && UUID_RE.test(req.query.projectId) ? req.query.projectId : null;
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? "30"), 10) || 30));
    const accessible = sql`(r.owner_user_id = ${req.user.id}::uuid OR ${isAdmin(req) ? sql`TRUE` : sql`FALSE`}
      OR EXISTS (SELECT 1 FROM service_program_scenarios s WHERE s.id = r.scenario_id AND ${vehicleScenariosAccessibleWhere(req.user.id, isAdmin(req))}))`;
    const rr = rows(await db.execute(sql`
      SELECT r.id, r.scenario_id, r.dss_id, r.project_id, r.title, r.is_test, r.summary, r.created_at, length(r.html) AS size_chars
        FROM process_reports r
       WHERE ${accessible}
         ${scenarioId ? sql`AND r.scenario_id = ${scenarioId}::uuid` : sql``}
         ${projectId ? sql`AND r.project_id = ${projectId}::uuid` : sql``}
       ORDER BY r.created_at DESC LIMIT ${limit}
    `));
    res.json({ total: rr.length, reports: rr.map((r: any) => ({ id: r.id, scenarioId: r.scenario_id, dssId: r.dss_id, projectId: r.project_id, title: r.title, isTest: r.is_test,
      summary: r.summary, createdAt: r.created_at, sizeChars: Number(r.size_chars), path: `/fucina/relazioni/${r.id}` })) });
  } catch (err: any) {
    res.status(500).json({ error: err?.message });
  }
});

/** GET /api/service-program/reports/:id — metadati + dossier */
router.get("/service-program/reports/:id", async (req: Request, res: Response) => {
  try {
    if (!UUID_RE.test(String(req.params.id))) { res.status(400).json({ error: "id non valido" }); return; }
    await ensureTable();
    const row = rows(await db.execute(sql`SELECT id, scenario_id, dss_id, project_id, owner_user_id, title, is_test, summary, dossier, created_at FROM process_reports WHERE id = ${String(req.params.id)}::uuid`))[0];
    if (!row || !(await canReadReport(req, row))) { res.status(404).json({ error: "Relazione non trovata o non accessibile" }); return; }
    const withDossier = String(req.query.dossier ?? "") === "1";
    res.json({ id: row.id, scenarioId: row.scenario_id, dssId: row.dss_id, projectId: row.project_id, title: row.title, isTest: row.is_test,
               summary: row.summary, createdAt: row.created_at, path: `/fucina/relazioni/${row.id}`, ...(withDossier ? { dossier: row.dossier } : { meta: row.dossier?.meta ?? null }) });
  } catch (err: any) {
    res.status(500).json({ error: err?.message });
  }
});

/** GET /api/service-program/reports/:id/html — il documento */
router.get("/service-program/reports/:id/html", async (req: Request, res: Response) => {
  try {
    if (!UUID_RE.test(String(req.params.id))) { res.status(400).send("id non valido"); return; }
    await ensureTable();
    const row = rows(await db.execute(sql`SELECT id, scenario_id, owner_user_id, title, html FROM process_reports WHERE id = ${String(req.params.id)}::uuid`))[0];
    if (!row || !(await canReadReport(req, row))) { res.status(404).send("Relazione non trovata o non accessibile"); return; }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Content-Disposition", `inline; filename="relazione-${row.id.slice(0, 8)}.html"`);
    res.send(row.html);
  } catch (err: any) {
    res.status(500).send(err?.message ?? "errore");
  }
});

/** DELETE /api/service-program/reports/:id */
router.delete("/service-program/reports/:id", async (req: Request, res: Response) => {
  try {
    if (!UUID_RE.test(String(req.params.id)) || !req.user) { res.status(400).json({ error: "id non valido" }); return; }
    await ensureTable();
    const row = rows(await db.execute(sql`SELECT id, owner_user_id FROM process_reports WHERE id = ${String(req.params.id)}::uuid`))[0];
    if (!row) { res.status(404).json({ error: "Relazione non trovata" }); return; }
    if (!isAdmin(req) && row.owner_user_id !== req.user.id) { res.status(403).json({ error: "Solo chi l'ha generata (o un admin) può eliminarla" }); return; }
    await db.execute(sql`DELETE FROM process_reports WHERE id = ${String(req.params.id)}::uuid`);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err?.message });
  }
});

export default router;
