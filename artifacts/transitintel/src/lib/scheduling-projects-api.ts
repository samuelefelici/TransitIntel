/**
 * Client API per Scheduling Projects (S1).
 * Endpoint backend: /api/scheduling/projects e /api/scheduling/runs
 */
import { apiFetch } from "@/lib/api";

export type ProjectStage = "setup" | "service" | "vehicle" | "crew" | "workspace" | "publish";
export type ProjectStatus = "draft" | "active" | "archived";
export type RunKind = "service" | "vehicle" | "crew";
export type RunStatus = "pending" | "running" | "completed" | "failed" | "canceled";

export interface SchedulingProject {
  id: string;
  ownerUserId: string;
  name: string;
  description: string | null;
  feedId: string | null;
  feedLabel: string | null;
  depotConfig: Record<string, any>;
  clusterConfig: Record<string, any>;
  deadheadConfig: Record<string, any>;
  economicParams: Record<string, any>;
  status: ProjectStatus;
  currentStage: ProjectStage;
  lastOpenedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** PsProject di origine (obbligatorio dal Step 7) */
  planningStudioProjectId: string | null;
  planningStudioProjectName?: string;
  /** UDP di origine: se valorizzata, lo scheduling è ristretto alle sue linee */
  validityUnitId?: string | null;
  validityUnitName?: string | null;
  /** route_id coperti dall'UDP (solo nel GET singolo): filtra le linee in pipeline */
  validityUnitRouteIds?: string[];
  /** nomi/short-name delle linee dell'UDP: fallback di match quando il feed usa
   *  route_id diversi (es. GTFS importato) anziché ps_routes.id */
  validityUnitRouteNames?: string[];
  /** flag esplicito di condivisione (true quando ci sono membri o owner ha attivato lo sharing) */
  isShared?: boolean;
  /** info arricchite dalla list/get */
  ownerEmail?: string;
  ownerFullName?: string | null;
  memberCount?: number;
  /** ruolo dell'utente corrente sul progetto */
  myRole?: "owner" | "editor" | "viewer";
}

export interface SchedulingRun {
  id: string;
  projectId: string;
  ownerUserId: string;
  kind: RunKind;
  parentRunId: string | null;
  label: string;
  config: Record<string, any>;
  result?: any;
  metrics?: any;
  status: RunStatus;
  isPinned: boolean;
  createdAt: string;
  completedAt: string | null;
}

/* ───── Projects ───── */

export async function listProjects(opts: { planningStudioProjectId?: string; mineOnly?: boolean } = {}): Promise<SchedulingProject[]> {
  const qs = new URLSearchParams();
  if (opts.planningStudioProjectId) qs.set("planningStudioProjectId", opts.planningStudioProjectId);
  if (opts.mineOnly) qs.set("mineOnly", "1");
  const q = qs.toString();
  const r = await apiFetch<{ projects: SchedulingProject[] }>(
    `/api/scheduling/projects${q ? `?${q}` : ""}`,
  );
  return r.projects;
}

export async function getProject(id: string): Promise<SchedulingProject> {
  const r = await apiFetch<{ project: SchedulingProject }>(`/api/scheduling/projects/${id}`);
  return r.project;
}

export async function createProject(input: {
  name: string;
  /** OBBLIGATORIO: id del PsProject del PlannerStudio da cui nasce il progetto */
  planningStudioProjectId: string;
  description?: string;
  feedId?: string;
  feedLabel?: string;
}): Promise<SchedulingProject> {
  const r = await apiFetch<{ project: SchedulingProject }>("/api/scheduling/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return r.project;
}

export async function updateProject(
  id: string,
  patch: Partial<Pick<SchedulingProject,
    "name" | "description" | "feedId" | "feedLabel" |
    "depotConfig" | "clusterConfig" | "deadheadConfig" | "economicParams" |
    "status" | "currentStage" | "isShared"
  >>,
): Promise<SchedulingProject> {
  const r = await apiFetch<{ project: SchedulingProject }>(`/api/scheduling/projects/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  return r.project;
}

export async function deleteProject(id: string): Promise<void> {
  await apiFetch<{ ok: boolean }>(`/api/scheduling/projects/${id}`, { method: "DELETE" });
}

/* ───── Runs ───── */

export async function listRuns(projectId: string, kind?: RunKind): Promise<SchedulingRun[]> {
  const qs = kind ? `?kind=${kind}` : "";
  const r = await apiFetch<{ runs: SchedulingRun[] }>(`/api/scheduling/projects/${projectId}/runs${qs}`);
  return r.runs;
}

export async function getRun(runId: string): Promise<SchedulingRun> {
  const r = await apiFetch<{ run: SchedulingRun }>(`/api/scheduling/runs/${runId}`);
  return r.run;
}

export async function createRun(
  projectId: string,
  input: {
    kind: RunKind;
    label: string;
    config?: Record<string, any>;
    parentRunId?: string;
    result?: any;
    metrics?: any;
    status?: RunStatus;
  },
): Promise<SchedulingRun> {
  const r = await apiFetch<{ run: SchedulingRun }>(`/api/scheduling/projects/${projectId}/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return r.run;
}

export async function updateRun(
  runId: string,
  patch: Partial<{
    label: string;
    isPinned: boolean;
    status: RunStatus;
    result: any;
    metrics: any;
  }>,
): Promise<SchedulingRun> {
  const r = await apiFetch<{ run: SchedulingRun }>(`/api/scheduling/runs/${runId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  return r.run;
}

export async function deleteRun(runId: string): Promise<void> {
  await apiFetch<{ ok: boolean }>(`/api/scheduling/runs/${runId}`, { method: "DELETE" });
}

/* ───── Helpers UI ───── */

export const STAGE_META: Record<ProjectStage, { label: string; index: number }> = {
  setup:     { label: "Setup",              index: 0 },
  service:   { label: "Servizio",           index: 1 },
  vehicle:   { label: "Vehicle Scheduling", index: 2 },
  crew:      { label: "Crew Scheduling",    index: 3 },
  workspace: { label: "Area di Lavoro",     index: 4 },
  publish:   { label: "Pubblica",           index: 5 },
};

export function stageProgress(stage: ProjectStage): number {
  return Math.round((STAGE_META[stage].index / 5) * 100);
}

/* ───── Scenari vetture / turni guida agganciati al progetto ───── */

export interface ProjectVehicleScenario {
  id: string;
  name: string;
  date: string;
  createdAt: string;
  isOperational?: boolean;
  numVehicles?: number | null;
  totalDeadheadKm?: number | null;
}

export interface ProjectDriverScenario {
  id: string;
  name: string;
  createdAt: string;
  isOperational?: boolean;
  vehicleScenarioId: string;
  vehicleScenarioName: string;
  vehicleScenarioDate: string;
  vehicleIsOperational?: boolean;
}

export async function listProjectVehicleScenarios(projectId: string): Promise<ProjectVehicleScenario[]> {
  const r = await apiFetch<{ vehicleScenarios: ProjectVehicleScenario[] }>(
    `/api/scheduling/projects/${projectId}/vehicle-scenarios`,
  );
  return r.vehicleScenarios;
}

export async function listProjectDriverScenarios(projectId: string): Promise<ProjectDriverScenario[]> {
  const r = await apiFetch<{ driverScenarios: ProjectDriverScenario[] }>(
    `/api/scheduling/projects/${projectId}/driver-scenarios`,
  );
  return r.driverScenarios;
}

export async function attachVehicleScenarioToProject(
  projectId: string, scenarioId: string,
): Promise<void> {
  await apiFetch<{ ok: boolean }>(
    `/api/scheduling/projects/${projectId}/attach-vehicle-scenario`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scenarioId }),
    },
  );
}

/* ───── "In esercizio": marca lo scenario scelto (turni macchina / turni guida) ───── */

export async function setVehicleScenarioOperational(
  projectId: string, scenarioId: string, operational: boolean,
): Promise<void> {
  await apiFetch(
    `/api/scheduling/projects/${projectId}/vehicle-scenarios/${scenarioId}/operational`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ operational }) },
  );
}

export async function setDriverScenarioOperational(
  projectId: string, scenarioId: string, operational: boolean,
): Promise<void> {
  await apiFetch(
    `/api/scheduling/projects/${projectId}/driver-scenarios/${scenarioId}/operational`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ operational }) },
  );
}

/* ───── Quadro d'esercizio: consolidamento per progetto PS ───── */

export interface OperationalUnit {
  validityUnitId: string;
  validityUnitName: string | null;
  tripCount: number;
  schedulingProjectId: string | null;
  vehicleScenario: { id: string; name: string; date: string; numVehicles: number | null } | null;
  driverScenario: { id: string; name: string; dutyCount: number } | null;
  /** corse della UDP non coperte dai turni macchina (result.unassigned) */
  vehicleUncovered: number;
  status: "not_started" | "complete" | "missing_vehicle" | "missing_driver";
}

export interface OperationalBoard {
  psProjectId: string;
  /** corse del programma non incluse in NESSUNA UDP */
  programUncoveredTrips: number;
  projects: OperationalUnit[];
  totals: { udp: number; complete: number; withIssues: number; vehicles: number; duties: number };
}

export async function getPsOperationalBoard(psProjectId: string): Promise<OperationalBoard> {
  return apiFetch<OperationalBoard>(`/api/scheduling/ps-projects/${psProjectId}/operational`);
}

/* ───── Sincronizzazione PS → gtfs_feed ───── */

export interface SyncFromPsResult {
  ok: true;
  feedId: string;
  label: string;
  feedStartDate: string;  // YYYYMMDD
  feedEndDate: string;
  counts: {
    stops: number; routes: number; trips: number; stopTimes: number;
    calendars: number; calendarDates: number; shapes: number;
  };
}

/** Re-materializza il PsProject linkato in un gtfs_feed dedicato e aggiorna project.feedId.
 *
 *  ASYNC: l'endpoint avvia il job in background e ritorna 202 subito (per
 *  evitare il timeout 502 del proxy Render su materializzazioni > 100 s).
 *  Questa funzione polla `/sync-status` finché il job completa o fallisce.
 *
 *  @param onProgress  callback opzionale chiamato a ogni poll con elapsedMs.
 *  @param timeoutMs   timeout totale del polling (default 10 minuti).
 */
export async function syncProjectFromPs(
  projectId: string,
  onProgress?: (info: { elapsedMs: number; status: string }) => void,
  timeoutMs = 10 * 60 * 1000,
): Promise<SyncFromPsResult> {
  // 1. Avvia il job (202 in modalità async, 200 in dev se completa subito)
  const startResp = await apiFetch<any>(
    `/api/scheduling/projects/${projectId}/sync-from-ps`,
    { method: "POST" },
  );
  // Se per qualche motivo il backend ha completato sincronicamente (small PS), usa subito
  if (startResp && startResp.feedId && startResp.counts) {
    return startResp as SyncFromPsResult;
  }

  // 2. Polling stato
  const start = Date.now();
  let delay = 1500;
  while (Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, delay));
    delay = Math.min(delay + 500, 5000); // back-off morbido fino a 5 s
    let st: any;
    try {
      st = await apiFetch<any>(`/api/scheduling/projects/${projectId}/sync-status`);
    } catch (e: any) {
      // Network blip → ripeti
      continue;
    }
    onProgress?.({ elapsedMs: Date.now() - start, status: st?.status || "running" });
    if (st?.status === "done" && st?.feedId) {
      return {
        ok: true,
        feedId: st.feedId,
        label: st.label,
        feedStartDate: st.feedStartDate,
        feedEndDate: st.feedEndDate,
        counts: st.counts,
      } as SyncFromPsResult;
    }
    if (st?.status === "error") {
      throw new Error(st.error || "Errore sincronizzazione PS→feed");
    }
  }
  throw new Error("Timeout sincronizzazione PS→feed (>10 minuti)");
}

/* ───── Membri & condivisione ───── */

export interface ProjectMember {
  userId: string;
  email: string;
  fullName: string | null;
  role: "owner" | "editor" | "viewer";
  addedAt: string;
  addedBy: string | null;
}

export interface UserLookup {
  id: string;
  email: string;
  fullName: string | null;
}

export async function listProjectMembers(projectId: string): Promise<ProjectMember[]> {
  const r = await apiFetch<{ members: ProjectMember[] }>(
    `/api/scheduling/projects/${projectId}/members`,
  );
  return r.members;
}

export async function addProjectMember(
  projectId: string, userId: string, role: "editor" | "viewer" = "editor",
): Promise<ProjectMember> {
  const r = await apiFetch<{ member: ProjectMember }>(
    `/api/scheduling/projects/${projectId}/members`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, role }),
    },
  );
  return r.member;
}

export async function removeProjectMember(projectId: string, userId: string): Promise<void> {
  await apiFetch<{ ok: boolean }>(
    `/api/scheduling/projects/${projectId}/members/${userId}`,
    { method: "DELETE" },
  );
}

export async function lookupUsers(q: string = ""): Promise<UserLookup[]> {
  const qs = q ? `?q=${encodeURIComponent(q)}` : "";
  const r = await apiFetch<{ users: UserLookup[] }>(`/api/users/lookup${qs}`);
  return r.users;
}

/* ───── Activity log ───── */

export interface ProjectActivity {
  id: string;
  userId: string;
  userEmail: string | null;
  userFullName: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  payload: Record<string, any>;
  at: string;
}

export async function listProjectActivity(
  projectId: string, limit: number = 100,
): Promise<ProjectActivity[]> {
  const r = await apiFetch<{ activity: ProjectActivity[] }>(
    `/api/scheduling/projects/${projectId}/activity?limit=${limit}`,
  );
  return r.activity;
}
