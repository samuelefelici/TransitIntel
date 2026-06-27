/**
 * Scheduling Projects — entità contenitore per la pipeline /fucina.
 *
 * Un PROGETTO DI ESERCIZIO raccoglie:
 *   - feed GTFS scelto
 *   - configurazioni di stage (depot, cluster, fuori-linea, parametri economici)
 *   - run versionate (kind = service|vehicle|crew, con parent_run_id per genealogia)
 *
 * Bootstrap idempotente sul modello di lib/auth.ts: alla prima richiesta
 * crea le tabelle con CREATE TABLE IF NOT EXISTS. Nessuna modifica a Drizzle schema.
 *
 * Tutte le rotte sono protette da requireAuth (montato in routes/index.ts) e
 * filtrate per owner_user_id = req.user.id.
 */
import type { Request, Response } from "express";
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

/* ────────────────────────────────────────────────────────────
 * Bootstrap tabelle
 * ──────────────────────────────────────────────────────────── */
let bootstrapped = false;
async function ensureSchedulingTables(): Promise<void> {
  if (bootstrapped) return;
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS scheduling_projects (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_user_id uuid NOT NULL,
        name text NOT NULL,
        description text,
        feed_id uuid,
        feed_label text,
        depot_config jsonb NOT NULL DEFAULT '{}'::jsonb,
        cluster_config jsonb NOT NULL DEFAULT '{}'::jsonb,
        deadhead_config jsonb NOT NULL DEFAULT '{}'::jsonb,
        economic_params jsonb NOT NULL DEFAULT '{}'::jsonb,
        status text NOT NULL DEFAULT 'draft',
        current_stage text NOT NULL DEFAULT 'setup',
        last_opened_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_sched_proj_owner ON scheduling_projects(owner_user_id)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_sched_proj_updated ON scheduling_projects(updated_at DESC)`);

    // Aggancio obbligatorio (lato applicativo) a un PsProject del PlannerStudio.
    // Manteniamo nullable a livello DB per retrocompatibilità con righe storiche,
    // ma il POST richiede planning_studio_project_id valido per i nuovi progetti.
    await db.execute(sql`
      ALTER TABLE IF EXISTS scheduling_projects
        ADD COLUMN IF NOT EXISTS planning_studio_project_id uuid
    `);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_sched_proj_ps ON scheduling_projects(planning_studio_project_id)`);
    // Scoping a una specifica Unità di Progettazione (UDP): se valorizzato, lo
    // scheduling lavora solo sulle linee/corse di quell'UDP, non su tutto il PS.
    await db.execute(sql`
      ALTER TABLE IF EXISTS scheduling_projects
        ADD COLUMN IF NOT EXISTS validity_unit_id uuid
    `);

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS scheduling_runs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id uuid NOT NULL REFERENCES scheduling_projects(id) ON DELETE CASCADE,
        owner_user_id uuid NOT NULL,
        kind text NOT NULL,
        parent_run_id uuid REFERENCES scheduling_runs(id) ON DELETE SET NULL,
        label text NOT NULL,
        config jsonb NOT NULL DEFAULT '{}'::jsonb,
        result jsonb,
        metrics jsonb,
        status text NOT NULL DEFAULT 'pending',
        is_pinned boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now(),
        completed_at timestamptz
      )
    `);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_sched_runs_project ON scheduling_runs(project_id)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_sched_runs_kind ON scheduling_runs(project_id, kind, created_at DESC)`);

    // Aggancio project_id (opzionale, nullable) sulle tabelle pre-esistenti
    // così possiamo collegare scenari vetture e DSS al progetto, senza riscrivere
    // gli endpoint esistenti.
    await db.execute(sql`
      ALTER TABLE IF EXISTS service_program_scenarios
        ADD COLUMN IF NOT EXISTS project_id uuid
    `);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_sps_project ON service_program_scenarios(project_id)`);
    await db.execute(sql`
      ALTER TABLE IF EXISTS driver_shift_scenarios
        ADD COLUMN IF NOT EXISTS project_id uuid
    `);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_dss_project ON driver_shift_scenarios(project_id)`);
    // "In esercizio": marca lo scenario scelto (turni macchina / turni guida).
    // Esclusività: 1 turni-macchina operativo per progetto-scheduling (= per UDP);
    // 1 turni-guida operativo per ciascun turni-macchina.
    await db.execute(sql`
      ALTER TABLE IF EXISTS service_program_scenarios
        ADD COLUMN IF NOT EXISTS is_operational boolean NOT NULL DEFAULT false
    `);
    await db.execute(sql`
      ALTER TABLE IF EXISTS driver_shift_scenarios
        ADD COLUMN IF NOT EXISTS is_operational boolean NOT NULL DEFAULT false
    `);

    /* ─── Condivisione progetti + log attività ─── */
    // Flag esplicito di condivisione (utile anche per owner solitari "in pausa").
    await db.execute(sql`
      ALTER TABLE IF EXISTS scheduling_projects
        ADD COLUMN IF NOT EXISTS is_shared boolean NOT NULL DEFAULT false
    `);

    // Membri del progetto: owner non viene duplicato qui (è in scheduling_projects.owner_user_id).
    // Ruoli: 'editor' (R/W) | 'viewer' (R only). Per ora UI usa solo 'editor'.
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS project_members (
        project_id uuid NOT NULL REFERENCES scheduling_projects(id) ON DELETE CASCADE,
        user_id uuid NOT NULL,
        role text NOT NULL DEFAULT 'editor',
        added_by uuid,
        added_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (project_id, user_id)
      )
    `);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pm_user ON project_members(user_id)`);

    // Log azioni: una riga per ogni azione significativa (create/update/delete/save/run/share/...).
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS project_activity_log (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id uuid NOT NULL REFERENCES scheduling_projects(id) ON DELETE CASCADE,
        user_id uuid NOT NULL,
        action text NOT NULL,
        target_type text,
        target_id text,
        payload jsonb NOT NULL DEFAULT '{}'::jsonb,
        at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_pal_project ON project_activity_log(project_id, at DESC)`);

    /* ─── Vehicle/Driver SCHEDULES come progetti condivisi ─── *
     * service_program_scenarios e driver_shift_scenarios diventano "progetti"
     * con owner + flag is_shared + tabella membri dedicata. Il legame al
     * SchedulingProject resta via project_id (già aggiunto sopra).
     */
    await db.execute(sql`
      ALTER TABLE IF EXISTS service_program_scenarios
        ADD COLUMN IF NOT EXISTS owner_user_id uuid,
        ADD COLUMN IF NOT EXISTS is_shared boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS description text,
        ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()
    `);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_sps_owner ON service_program_scenarios(owner_user_id)`);

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS vehicle_schedule_members (
        scenario_id uuid NOT NULL REFERENCES service_program_scenarios(id) ON DELETE CASCADE,
        user_id uuid NOT NULL,
        role text NOT NULL DEFAULT 'editor',
        added_by uuid,
        added_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (scenario_id, user_id)
      )
    `);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_vsm_user ON vehicle_schedule_members(user_id)`);

    await db.execute(sql`
      ALTER TABLE IF EXISTS driver_shift_scenarios
        ADD COLUMN IF NOT EXISTS owner_user_id uuid,
        ADD COLUMN IF NOT EXISTS is_shared boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS description text,
        ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()
    `);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_dss_owner ON driver_shift_scenarios(owner_user_id)`);

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS driver_schedule_members (
        scenario_id uuid NOT NULL REFERENCES driver_shift_scenarios(id) ON DELETE CASCADE,
        user_id uuid NOT NULL,
        role text NOT NULL DEFAULT 'editor',
        added_by uuid,
        added_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (scenario_id, user_id)
      )
    `);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_dsm_user ON driver_schedule_members(user_id)`);

    bootstrapped = true;
    console.log("[scheduling-projects] tables ready");
  } catch (e: any) {
    console.error("[scheduling-projects] bootstrap error:", e?.message || e);
  }
}
void ensureSchedulingTables();

/* ────────────────────────────────────────────────────────────
 * Helpers
 * ──────────────────────────────────────────────────────────── */
const UUID_RE = /^[0-9a-f-]{36}$/i;
const VALID_STAGES = new Set(["setup", "service", "vehicle", "crew", "workspace", "publish"]);
const VALID_STATUS = new Set(["draft", "active", "archived"]);
const VALID_RUN_KIND = new Set(["service", "vehicle", "crew"]);
const VALID_RUN_STATUS = new Set(["pending", "running", "completed", "failed", "canceled"]);

function rowToProject(r: any) {
  return {
    id: r.id,
    ownerUserId: r.owner_user_id,
    name: r.name,
    description: r.description,
    feedId: r.feed_id,
    feedLabel: r.feed_label,
    planningStudioProjectId: r.planning_studio_project_id ?? null,
    planningStudioProjectName: r.ps_name ?? undefined,
    validityUnitId: r.validity_unit_id ?? null,
    validityUnitName: r.validity_unit_name ?? null,
    // route_id (= ps_routes.id::text, combaciano con gtfs_routes.route_id) coperti
    // dall'UDP: presente solo nel GET singolo (vedi handler). Filtra le linee.
    validityUnitRouteIds: r.validity_unit_route_ids ?? undefined,
    depotConfig: r.depot_config ?? {},
    clusterConfig: r.cluster_config ?? {},
    deadheadConfig: r.deadhead_config ?? {},
    economicParams: r.economic_params ?? {},
    status: r.status,
    currentStage: r.current_stage,
    isShared: !!r.is_shared,
    lastOpenedAt: r.last_opened_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    // Campi aggiuntivi calcolati nelle JOIN (opzionali)
    ownerEmail: r.owner_email ?? undefined,
    ownerFullName: r.owner_full_name ?? undefined,
    memberCount: r.member_count != null ? Number(r.member_count) : undefined,
    myRole: r.my_role ?? (r.owner_user_id ? "owner" : undefined),
  };
}

function rowToRun(r: any) {
  return {
    id: r.id,
    projectId: r.project_id,
    ownerUserId: r.owner_user_id,
    kind: r.kind,
    parentRunId: r.parent_run_id,
    label: r.label,
    config: r.config ?? {},
    result: r.result,
    metrics: r.metrics,
    status: r.status,
    isPinned: r.is_pinned,
    createdAt: r.created_at,
    completedAt: r.completed_at,
  };
}

async function loadProjectOwned(id: string, userId: string): Promise<any | null> {
  const r = await db.execute(sql`
    SELECT * FROM scheduling_projects
     WHERE id = ${id}::uuid AND owner_user_id = ${userId}::uuid
     LIMIT 1
  `);
  const row: any = (r as any).rows?.[0] ?? (r as any)[0];
  return row ?? null;
}

/** Carica un progetto se l'utente ne è owner OPPURE membro attivo.
 *  Aggiunge a row il campo `my_role` ('owner' | 'editor' | 'viewer'). */
async function loadProjectAccessible(id: string, userId: string): Promise<any | null> {
  const r = await db.execute(sql`
    SELECT p.*,
           CASE WHEN p.owner_user_id = ${userId}::uuid THEN 'owner'
                ELSE pm.role END AS my_role
      FROM scheduling_projects p
      LEFT JOIN project_members pm
             ON pm.project_id = p.id AND pm.user_id = ${userId}::uuid
     WHERE p.id = ${id}::uuid
       AND (p.owner_user_id = ${userId}::uuid OR pm.user_id IS NOT NULL)
     LIMIT 1
  `);
  const row: any = (r as any).rows?.[0] ?? (r as any)[0];
  return row ?? null;
}

/** Solo owner può modificare condivisione/membri. */
function isOwner(projectRow: any, userId: string): boolean {
  return projectRow?.owner_user_id === userId;
}

/** Inserisce una riga nel log attività. Best-effort: errori non interrompono la richiesta. */
async function logActivity(
  projectId: string,
  userId: string,
  action: string,
  opts: { targetType?: string; targetId?: string; payload?: any } = {}
): Promise<void> {
  try {
    await db.execute(sql`
      INSERT INTO project_activity_log (project_id, user_id, action, target_type, target_id, payload)
      VALUES (
        ${projectId}::uuid,
        ${userId}::uuid,
        ${action},
        ${opts.targetType ?? null},
        ${opts.targetId ?? null},
        ${JSON.stringify(opts.payload ?? {})}::jsonb
      )
    `);
  } catch (e: any) {
    console.warn("[activity-log] insert failed:", e?.message || e);
  }
}

/* ────────────────────────────────────────────────────────────
 * Router /api/scheduling/projects/*
 * ──────────────────────────────────────────────────────────── */
const router: IRouter = Router();

// Tutte le rotte richiedono l'utente (requireAuth è già montato a livello globale)
// ma facciamo un piccolo guard per chiarezza.
router.use(async (req, res, next) => {
  await ensureSchedulingTables();
  if (!req.user) { res.status(401).json({ error: "Non autenticato" }); return; }
  next();
});

/* GET /api/scheduling/projects — lista progetti accessibili (owned OR shared)
 *  Filtri opzionali:
 *    - ?planningStudioProjectId=<uuid>  → solo progetti agganciati a quel PS
 *    - ?mineOnly=1                       → solo owned (esclude shared)
 */
router.get("/scheduling/projects", async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const psFilter = String(req.query.planningStudioProjectId || "").trim();
  const mineOnly = String(req.query.mineOnly || "") === "1";
  const psWhere = psFilter && UUID_RE.test(psFilter)
    ? sql`AND p.planning_studio_project_id = ${psFilter}::uuid`
    : sql``;
  const accessWhere = mineOnly
    ? sql`p.owner_user_id = ${userId}::uuid`
    : sql`(p.owner_user_id = ${userId}::uuid OR pm.user_id IS NOT NULL)`;
  const r = await db.execute(sql`
    SELECT p.*,
           u.email AS owner_email,
           u.full_name AS owner_full_name,
           ps.name AS ps_name,
           vu.name AS validity_unit_name,
           (SELECT count(*)::int FROM project_members pm2 WHERE pm2.project_id = p.id) AS member_count,
           CASE WHEN p.owner_user_id = ${userId}::uuid THEN 'owner'
                ELSE pm.role END AS my_role
      FROM scheduling_projects p
      LEFT JOIN users u ON u.id = p.owner_user_id
      LEFT JOIN ps_projects ps ON ps.id = p.planning_studio_project_id
      LEFT JOIN ps_validity_units vu ON vu.id = p.validity_unit_id
      LEFT JOIN project_members pm
             ON pm.project_id = p.id AND pm.user_id = ${userId}::uuid
     WHERE ${accessWhere} ${psWhere}
     ORDER BY COALESCE(p.last_opened_at, p.updated_at) DESC
  `);
  const rows: any[] = (r as any).rows ?? (r as any) ?? [];
  res.json({ projects: rows.map(rowToProject) });
});

/* POST /api/scheduling/projects — crea progetto (richiede planningStudioProjectId) */
router.post("/scheduling/projects", async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const { name, description, feedId, feedLabel, planningStudioProjectId, validityUnitId } = req.body || {};
  const validityUnitIdClean = typeof validityUnitId === "string" && UUID_RE.test(validityUnitId) ? validityUnitId : null;
  if (typeof name !== "string" || name.trim().length === 0) {
    res.status(400).json({ error: "Il nome del progetto è obbligatorio" });
    return;
  }
  if (typeof planningStudioProjectId !== "string" || !UUID_RE.test(planningStudioProjectId)) {
    res.status(400).json({ error: "planningStudioProjectId obbligatorio" });
    return;
  }
  // Verifica che l'utente abbia accesso (owner o membro) al PsProject indicato
  const psCheck = await db.execute(sql`
    SELECT p.id, p.name FROM ps_projects p
      LEFT JOIN ps_project_members pm
             ON pm.project_id = p.id AND pm.user_id = ${userId}::uuid
     WHERE p.id = ${planningStudioProjectId}::uuid
       AND (p.owner_user_id = ${userId}::uuid OR pm.user_id IS NOT NULL)
     LIMIT 1
  `);
  const psRow: any = (psCheck as any).rows?.[0] ?? (psCheck as any)[0];
  if (!psRow) {
    res.status(403).json({ error: "PsProject non accessibile o inesistente" });
    return;
  }
  const r = await db.execute(sql`
    INSERT INTO scheduling_projects (owner_user_id, name, description, feed_id, feed_label, planning_studio_project_id, validity_unit_id)
    VALUES (
      ${userId}::uuid,
      ${name.trim()},
      ${description ?? null},
      ${feedId && UUID_RE.test(String(feedId)) ? sql`${feedId}::uuid` : null},
      ${feedLabel ?? null},
      ${planningStudioProjectId}::uuid,
      ${validityUnitIdClean ? sql`${validityUnitIdClean}::uuid` : null}
    )
    RETURNING *
  `);
  const row: any = (r as any).rows?.[0] ?? (r as any)[0];

  // ── Auto-materializzazione PS → gtfs_feed FIRE-AND-FORGET ─────────────
  // Avviata in background tramite startSyncJob: la POST risponde subito
  // (no UI hang). Lo stato è interrogabile via GET /sync-status.
  // Se fallisce, l'utente la rilancia dalla schermata "Sincronizza con PS".
  void (async () => {
    try {
      const { startSyncJob } = await import("./planning-studio-materialize");
      startSyncJob(row.id, planningStudioProjectId, userId, req.log);
    } catch (matErr: any) {
      req.log?.warn?.({ err: matErr, planningStudioProjectId, projectId: row.id },
        "Auto-materializzazione PS→feed: impossibile avviare il job background");
    }
  })();

  await logActivity(row.id, userId, "project.create", {
    targetType: "project", targetId: row.id,
    payload: { name: row.name, planningStudioProjectId, planningStudioProjectName: psRow.name },
  });
  res.json({ project: rowToProject({ ...row, ps_name: psRow.name }) });
});

/* GET /api/scheduling/projects/:id */
router.get("/scheduling/projects/:id", async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params.id || "");
  if (!UUID_RE.test(id)) { res.status(400).json({ error: "ID non valido" }); return; }
  const row = await loadProjectAccessible(id, req.user!.id);
  if (!row) { res.status(404).json({ error: "Progetto non trovato" }); return; }
  // Touch last_opened_at
  await db.execute(sql`UPDATE scheduling_projects SET last_opened_at = now() WHERE id = ${id}::uuid`);
  // Arricchimento owner_email + member_count come nella lista
  const enrich = await db.execute(sql`
    SELECT u.email AS owner_email, u.full_name AS owner_full_name,
           (SELECT count(*)::int FROM project_members pm WHERE pm.project_id = ${id}::uuid) AS member_count,
           (SELECT name FROM ps_projects WHERE id = ${row.planning_studio_project_id}::uuid) AS ps_name
      FROM users u WHERE u.id = ${row.owner_user_id}::uuid
  `);
  const ext: any = (enrich as any).rows?.[0] ?? (enrich as any)[0] ?? {};
  // Se il progetto è agganciato a un'UDP, calcola le linee coperte (route_id =
  // ps_routes.id::text, combaciano con gtfs_routes.route_id) per filtrare la
  // selezione linee nella pipeline scheduling.
  let validityUnitRouteIds: string[] | undefined;
  if (row.validity_unit_id) {
    const ur = await db.execute(sql`
      SELECT DISTINCT t.route_id::text AS route_id
        FROM ps_trips t
       WHERE t.id IN (
         SELECT jsonb_array_elements_text(trip_ids)::uuid
           FROM ps_validity_units WHERE id = ${row.validity_unit_id}::uuid
       )
    `);
    validityUnitRouteIds = ((ur as any).rows ?? []).map((x: any) => x.route_id).filter(Boolean);
  }
  res.json({ project: rowToProject({ ...row, ...ext, validity_unit_route_ids: validityUnitRouteIds }) });
});

/* PATCH /api/scheduling/projects/:id — update parziale (owner o editor) */
router.patch("/scheduling/projects/:id", async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params.id || "");
  if (!UUID_RE.test(id)) { res.status(400).json({ error: "ID non valido" }); return; }
  const accessible = await loadProjectAccessible(id, req.user!.id);
  if (!accessible) { res.status(404).json({ error: "Progetto non trovato" }); return; }
  if (accessible.my_role === "viewer") {
    res.status(403).json({ error: "Permesso insufficiente (sola lettura)" }); return;
  }

  const {
    name, description, feedId, feedLabel,
    depotConfig, clusterConfig, deadheadConfig, economicParams,
    status, currentStage, isShared,
  } = req.body || {};

  const sets: any[] = [];
  if (name !== undefined && typeof name === "string" && name.trim()) sets.push(sql`name = ${name.trim()}`);
  if (description !== undefined) sets.push(sql`description = ${description}`);
  if (feedId !== undefined) {
    sets.push(feedId && UUID_RE.test(String(feedId))
      ? sql`feed_id = ${feedId}::uuid`
      : sql`feed_id = NULL`);
  }
  if (feedLabel !== undefined) sets.push(sql`feed_label = ${feedLabel}`);
  if (depotConfig !== undefined) sets.push(sql`depot_config = ${JSON.stringify(depotConfig)}::jsonb`);
  if (clusterConfig !== undefined) sets.push(sql`cluster_config = ${JSON.stringify(clusterConfig)}::jsonb`);
  if (deadheadConfig !== undefined) sets.push(sql`deadhead_config = ${JSON.stringify(deadheadConfig)}::jsonb`);
  if (economicParams !== undefined) sets.push(sql`economic_params = ${JSON.stringify(economicParams)}::jsonb`);
  if (status !== undefined && VALID_STATUS.has(status)) sets.push(sql`status = ${status}`);
  if (currentStage !== undefined && VALID_STAGES.has(currentStage)) sets.push(sql`current_stage = ${currentStage}`);
  // is_shared modificabile SOLO dall'owner
  if (isShared !== undefined) {
    if (!isOwner(accessible, req.user!.id)) {
      res.status(403).json({ error: "Solo l'owner può modificare la condivisione" }); return;
    }
    sets.push(sql`is_shared = ${!!isShared}`);
  }

  if (sets.length === 0) { res.json({ project: rowToProject(accessible), noop: true }); return; }
  sets.push(sql`updated_at = now()`);

  const assignments = sql.join(sets, sql`, `);
  const r = await db.execute(sql`
    UPDATE scheduling_projects SET ${assignments}
     WHERE id = ${id}::uuid
     RETURNING *
  `);
  const row: any = (r as any).rows?.[0] ?? (r as any)[0];
  await logActivity(id, req.user!.id, "project.update", {
    targetType: "project", targetId: id,
    payload: { fields: Object.keys(req.body || {}) },
  });
  res.json({ project: rowToProject(row) });
});

/* DELETE /api/scheduling/projects/:id — solo owner */
router.delete("/scheduling/projects/:id", async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params.id || "");
  if (!UUID_RE.test(id)) { res.status(400).json({ error: "ID non valido" }); return; }
  const owned = await loadProjectOwned(id, req.user!.id);
  if (!owned) { res.status(404).json({ error: "Progetto non trovato" }); return; }
  await db.execute(sql`DELETE FROM scheduling_projects WHERE id = ${id}::uuid`);
  res.json({ ok: true });
});

/* ────────────────────────────────────────────────────────────
 * Runs (versioning)
 * ──────────────────────────────────────────────────────────── */

/* GET /api/scheduling/projects/:id/runs?kind=vehicle */
router.get("/scheduling/projects/:id/runs", async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params.id || "");
  if (!UUID_RE.test(id)) { res.status(400).json({ error: "ID non valido" }); return; }
  const owned = await loadProjectAccessible(id, req.user!.id);
  if (!owned) { res.status(404).json({ error: "Progetto non trovato" }); return; }
  const kindFilter = String(req.query.kind || "").trim();
  const r = kindFilter && VALID_RUN_KIND.has(kindFilter)
    ? await db.execute(sql`
        SELECT id, project_id, owner_user_id, kind, parent_run_id, label,
               config, metrics, status, is_pinned, created_at, completed_at
          FROM scheduling_runs
         WHERE project_id = ${id}::uuid AND kind = ${kindFilter}
         ORDER BY created_at DESC
      `)
    : await db.execute(sql`
        SELECT id, project_id, owner_user_id, kind, parent_run_id, label,
               config, metrics, status, is_pinned, created_at, completed_at
          FROM scheduling_runs
         WHERE project_id = ${id}::uuid
         ORDER BY created_at DESC
      `);
  const rows: any[] = (r as any).rows ?? (r as any) ?? [];
  // result viene escluso dalla list per peso — disponibile via GET /:runId
  res.json({ runs: rows.map(rowToRun) });
});

/* POST /api/scheduling/projects/:id/runs — crea (snapshot config; result lo riempie il job) */
router.post("/scheduling/projects/:id/runs", async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params.id || "");
  if (!UUID_RE.test(id)) { res.status(400).json({ error: "ID non valido" }); return; }
  const owned = await loadProjectAccessible(id, req.user!.id);
  if (!owned) { res.status(404).json({ error: "Progetto non trovato" }); return; }
  if (owned.my_role === "viewer") { res.status(403).json({ error: "Permesso insufficiente" }); return; }

  const { kind, label, config, parentRunId, result, metrics, status } = req.body || {};
  if (!VALID_RUN_KIND.has(kind)) {
    res.status(400).json({ error: "kind deve essere service|vehicle|crew" }); return;
  }
  if (typeof label !== "string" || !label.trim()) {
    res.status(400).json({ error: "label obbligatorio" }); return;
  }
  const safeStatus = VALID_RUN_STATUS.has(status) ? status : (result ? "completed" : "pending");

  const r = await db.execute(sql`
    INSERT INTO scheduling_runs (
      project_id, owner_user_id, kind, parent_run_id, label,
      config, result, metrics, status, completed_at
    ) VALUES (
      ${id}::uuid,
      ${req.user!.id}::uuid,
      ${kind},
      ${parentRunId && UUID_RE.test(String(parentRunId)) ? sql`${parentRunId}::uuid` : null},
      ${label.trim()},
      ${JSON.stringify(config ?? {})}::jsonb,
      ${result !== undefined ? sql`${JSON.stringify(result)}::jsonb` : null},
      ${metrics !== undefined ? sql`${JSON.stringify(metrics)}::jsonb` : null},
      ${safeStatus},
      ${safeStatus === "completed" ? sql`now()` : null}
    )
    RETURNING *
  `);
  const row: any = (r as any).rows?.[0] ?? (r as any)[0];
  await logActivity(id, req.user!.id, "run.create", {
    targetType: "run", targetId: row.id, payload: { kind: row.kind, label: row.label },
  });
  res.json({ run: rowToRun(row) });
});

/* GET /api/scheduling/runs/:runId — payload completo (incluso result) */
router.get("/scheduling/runs/:runId", async (req: Request, res: Response): Promise<void> => {
  const runId = String(req.params.runId || "");
  if (!UUID_RE.test(runId)) { res.status(400).json({ error: "ID non valido" }); return; }
  const r = await db.execute(sql`
    SELECT * FROM scheduling_runs
     WHERE id = ${runId}::uuid AND owner_user_id = ${req.user!.id}::uuid
     LIMIT 1
  `);
  const row: any = (r as any).rows?.[0] ?? (r as any)[0];
  if (!row) { res.status(404).json({ error: "Run non trovata" }); return; }
  res.json({ run: rowToRun(row) });
});

/* PATCH /api/scheduling/runs/:runId — update label / pin / status / result */
router.patch("/scheduling/runs/:runId", async (req: Request, res: Response): Promise<void> => {
  const runId = String(req.params.runId || "");
  if (!UUID_RE.test(runId)) { res.status(400).json({ error: "ID non valido" }); return; }
  const { label, isPinned, status, result, metrics } = req.body || {};
  const sets: any[] = [];
  if (label !== undefined && typeof label === "string" && label.trim()) sets.push(sql`label = ${label.trim()}`);
  if (isPinned !== undefined) sets.push(sql`is_pinned = ${!!isPinned}`);
  if (status !== undefined && VALID_RUN_STATUS.has(status)) {
    sets.push(sql`status = ${status}`);
    if (status === "completed") sets.push(sql`completed_at = now()`);
  }
  if (result !== undefined) sets.push(sql`result = ${JSON.stringify(result)}::jsonb`);
  if (metrics !== undefined) sets.push(sql`metrics = ${JSON.stringify(metrics)}::jsonb`);
  if (sets.length === 0) { res.json({ ok: true, noop: true }); return; }
  const assignments = sql.join(sets, sql`, `);
  const r = await db.execute(sql`
    UPDATE scheduling_runs SET ${assignments}
     WHERE id = ${runId}::uuid AND owner_user_id = ${req.user!.id}::uuid
     RETURNING *
  `);
  const row: any = (r as any).rows?.[0] ?? (r as any)[0];
  if (!row) { res.status(404).json({ error: "Run non trovata" }); return; }
  res.json({ run: rowToRun(row) });
});

/* DELETE /api/scheduling/runs/:runId */
router.delete("/scheduling/runs/:runId", async (req: Request, res: Response): Promise<void> => {
  const runId = String(req.params.runId || "");
  if (!UUID_RE.test(runId)) { res.status(400).json({ error: "ID non valido" }); return; }
  await db.execute(sql`
    DELETE FROM scheduling_runs
     WHERE id = ${runId}::uuid AND owner_user_id = ${req.user!.id}::uuid
  `);
  res.json({ ok: true });
});

/* ────────────────────────────────────────────────────────────
 * Scenari vetture e turni guida agganciati al progetto
 * ────────────────────────────────────────────────────────────
 *
 * Modello:
 *   Project ──< VehicleScenario (service_program_scenarios)
 *                    └──< DriverShiftScenario (driver_shift_scenarios)
 *
 * Le tabelle esistono già; abbiamo aggiunto la colonna project_id (nullable)
 * nel bootstrap. Gli endpoint qui sotto sono solo di "indice" per il progetto.
 */

/* GET /api/scheduling/projects/:id/vehicle-scenarios — lista scenari vetture del progetto */
router.get("/scheduling/projects/:id/vehicle-scenarios", async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params.id || "");
  if (!UUID_RE.test(id)) { res.status(400).json({ error: "ID non valido" }); return; }
  const owned = await loadProjectAccessible(id, req.user!.id);
  if (!owned) { res.status(404).json({ error: "Progetto non trovato" }); return; }

  const r = await db.execute(sql`
    SELECT id, name, date, created_at, COALESCE(is_operational, false) AS is_operational,
           (result->'summary'->>'numVehicles')::int AS num_vehicles,
           (result->'summary'->>'totalDeadheadKm')::float AS total_deadhead_km
      FROM service_program_scenarios
     WHERE project_id = ${id}::uuid
     ORDER BY is_operational DESC, created_at DESC
  `);
  const rows: any[] = (r as any).rows ?? (r as any) ?? [];
  res.json({
    vehicleScenarios: rows.map(s => ({
      id: s.id,
      name: s.name,
      date: s.date,
      createdAt: s.created_at,
      isOperational: !!s.is_operational,
      numVehicles: s.num_vehicles,
      totalDeadheadKm: s.total_deadhead_km,
    })),
  });
});

/* POST /api/scheduling/projects/:id/attach-vehicle-scenario { scenarioId }
   Aggancia uno scenario vetture esistente (creato dalla vecchia UI) al progetto. */
router.post("/scheduling/projects/:id/attach-vehicle-scenario", async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params.id || "");
  const { scenarioId } = req.body || {};
  if (!UUID_RE.test(id) || typeof scenarioId !== "string" || !UUID_RE.test(scenarioId)) {
    res.status(400).json({ error: "ID non validi" }); return;
  }
  const owned = await loadProjectAccessible(id, req.user!.id);
  if (!owned) { res.status(404).json({ error: "Progetto non trovato" }); return; }
  if (owned.my_role === "viewer") { res.status(403).json({ error: "Permesso insufficiente" }); return; }
  await db.execute(sql`
    UPDATE service_program_scenarios SET project_id = ${id}::uuid
     WHERE id = ${scenarioId}::uuid
  `);
  await logActivity(id, req.user!.id, "scenario.attach", {
    targetType: "vehicle_scenario", targetId: scenarioId,
  });
  res.json({ ok: true });
});

/* GET /api/scheduling/projects/:id/driver-scenarios
   Lista TUTTI i DSS di TUTTI gli scenari vetture del progetto, raggruppati per scenario. */
router.get("/scheduling/projects/:id/driver-scenarios", async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params.id || "");
  if (!UUID_RE.test(id)) { res.status(400).json({ error: "ID non valido" }); return; }
  const owned = await loadProjectAccessible(id, req.user!.id);
  if (!owned) { res.status(404).json({ error: "Progetto non trovato" }); return; }

  // Prendiamo tutti i DSS i cui scenario vetture appartiene al progetto
  // (sia agganciati direttamente al progetto, sia tramite vehicle scenario.project_id)
  const r = await db.execute(sql`
    SELECT dss.id, dss.name, dss.created_at, dss.service_program_scenario_id,
           COALESCE(dss.is_operational, false) AS is_operational,
           COALESCE(sps.is_operational, false) AS vehicle_is_operational,
           sps.name AS vehicle_scenario_name, sps.date AS vehicle_date
      FROM driver_shift_scenarios dss
      JOIN service_program_scenarios sps ON sps.id = dss.service_program_scenario_id
     WHERE sps.project_id = ${id}::uuid OR dss.project_id = ${id}::uuid
     ORDER BY dss.is_operational DESC, dss.created_at DESC
  `);
  const rows: any[] = (r as any).rows ?? (r as any) ?? [];
  res.json({
    driverScenarios: rows.map(s => ({
      id: s.id,
      name: s.name,
      createdAt: s.created_at,
      isOperational: !!s.is_operational,
      vehicleScenarioId: s.service_program_scenario_id,
      vehicleScenarioName: s.vehicle_scenario_name,
      vehicleScenarioDate: s.vehicle_date,
      vehicleIsOperational: !!s.vehicle_is_operational,
    })),
  });
});

/* POST /api/scheduling/projects/:id/vehicle-scenarios/:scenarioId/operational { operational }
   Marca/smarca un turni-macchina come "in esercizio". Esclusivo per progetto:
   metterne uno operativo azzera gli altri del progetto. Smarcando, smarca anche
   i suoi turni-guida figli (non può esserci TG operativo sotto un TM non operativo). */
router.post("/scheduling/projects/:id/vehicle-scenarios/:scenarioId/operational", async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params.id || "");
  const scenarioId = String(req.params.scenarioId || "");
  if (!UUID_RE.test(id) || !UUID_RE.test(scenarioId)) { res.status(400).json({ error: "ID non validi" }); return; }
  const operational = req.body?.operational !== false; // default true
  const owned = await loadProjectAccessible(id, req.user!.id);
  if (!owned) { res.status(404).json({ error: "Progetto non trovato" }); return; }
  if (owned.my_role === "viewer") { res.status(403).json({ error: "Permesso insufficiente" }); return; }
  // lo scenario deve appartenere al progetto
  const chk = await db.execute(sql`
    SELECT 1 FROM service_program_scenarios WHERE id = ${scenarioId}::uuid AND project_id = ${id}::uuid LIMIT 1`);
  if (!((chk as any).rows?.length)) { res.status(404).json({ error: "Scenario non nel progetto" }); return; }

  if (operational) {
    // esclusività: azzera gli altri turni-macchina del progetto (e i loro TG)
    await db.execute(sql`
      UPDATE driver_shift_scenarios SET is_operational = false
       WHERE service_program_scenario_id IN (
         SELECT id FROM service_program_scenarios WHERE project_id = ${id}::uuid AND id <> ${scenarioId}::uuid
       )`);
    await db.execute(sql`
      UPDATE service_program_scenarios SET is_operational = (id = ${scenarioId}::uuid)
       WHERE project_id = ${id}::uuid`);
  } else {
    await db.execute(sql`UPDATE service_program_scenarios SET is_operational = false WHERE id = ${scenarioId}::uuid`);
    await db.execute(sql`UPDATE driver_shift_scenarios SET is_operational = false WHERE service_program_scenario_id = ${scenarioId}::uuid`);
  }
  await logActivity(id, req.user!.id, "scenario.operational.vehicle", {
    targetType: "vehicle_scenario", targetId: scenarioId, payload: { operational },
  });
  res.json({ ok: true, operational });
});

/* POST /api/scheduling/projects/:id/driver-scenarios/:scenarioId/operational { operational }
   Marca/smarca un turni-guida come "in esercizio". Esclusivo per turni-macchina
   genitore; mettendolo operativo promuove anche il TM genitore (esclusivo nel progetto). */
router.post("/scheduling/projects/:id/driver-scenarios/:scenarioId/operational", async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params.id || "");
  const scenarioId = String(req.params.scenarioId || "");
  if (!UUID_RE.test(id) || !UUID_RE.test(scenarioId)) { res.status(400).json({ error: "ID non validi" }); return; }
  const operational = req.body?.operational !== false; // default true
  const owned = await loadProjectAccessible(id, req.user!.id);
  if (!owned) { res.status(404).json({ error: "Progetto non trovato" }); return; }
  if (owned.my_role === "viewer") { res.status(403).json({ error: "Permesso insufficiente" }); return; }
  // il DSS deve appartenere (via TM) al progetto; recupera il TM genitore
  const chk = await db.execute(sql`
    SELECT dss.service_program_scenario_id AS sps_id
      FROM driver_shift_scenarios dss
      JOIN service_program_scenarios sps ON sps.id = dss.service_program_scenario_id
     WHERE dss.id = ${scenarioId}::uuid AND sps.project_id = ${id}::uuid LIMIT 1`);
  const spsId = (chk as any).rows?.[0]?.sps_id;
  if (!spsId) { res.status(404).json({ error: "Turni guida non nel progetto" }); return; }

  if (operational) {
    // promuovi il TM genitore (esclusivo nel progetto) + azzera i TG degli altri TM
    await db.execute(sql`
      UPDATE driver_shift_scenarios SET is_operational = false
       WHERE service_program_scenario_id IN (
         SELECT id FROM service_program_scenarios WHERE project_id = ${id}::uuid AND id <> ${spsId}::uuid
       )`);
    await db.execute(sql`
      UPDATE service_program_scenarios SET is_operational = (id = ${spsId}::uuid)
       WHERE project_id = ${id}::uuid`);
    // esclusività TG dentro lo stesso TM
    await db.execute(sql`
      UPDATE driver_shift_scenarios SET is_operational = (id = ${scenarioId}::uuid)
       WHERE service_program_scenario_id = ${spsId}::uuid`);
  } else {
    await db.execute(sql`UPDATE driver_shift_scenarios SET is_operational = false WHERE id = ${scenarioId}::uuid`);
  }
  await logActivity(id, req.user!.id, "scenario.operational.driver", {
    targetType: "driver_scenario", targetId: scenarioId, payload: { operational },
  });
  res.json({ ok: true, operational });
});

/* GET /api/scheduling/ps-projects/:psProjectId/operational
   Quadro d'esercizio: per ogni UDP (progetto-scheduling) del progetto PS, lo
   scenario turni-macchina e turni-guida in esercizio, con stato di completezza. */
router.get("/scheduling/ps-projects/:psProjectId/operational", async (req: Request, res: Response): Promise<void> => {
  const psId = String(req.params.psProjectId || "");
  if (!UUID_RE.test(psId)) { res.status(400).json({ error: "ID non valido" }); return; }
  const userId = req.user!.id;
  // accesso al progetto PS (owner o membro)
  const acc = await db.execute(sql`
    SELECT p.id, p.name FROM ps_projects p
      LEFT JOIN ps_project_members pm ON pm.project_id = p.id AND pm.user_id = ${userId}::uuid
     WHERE p.id = ${psId}::uuid AND (p.owner_user_id = ${userId}::uuid OR pm.user_id IS NOT NULL) LIMIT 1`);
  if (!((acc as any).rows?.length)) { res.status(404).json({ error: "Progetto PS non accessibile" }); return; }

  // TUTTE le UDP create per il programma (anche quelle non ancora avviate allo
  // scheduling): il Quadro deve mostrarle tutte a fine processo.
  const unitsR = await db.execute(sql`
    SELECT id, name, COALESCE(jsonb_array_length(trip_ids), 0) AS trip_count
      FROM ps_validity_units
     WHERE project_id = ${psId}::uuid
     ORDER BY name ASC NULLS LAST, created_at ASC`);
  const units: any[] = (unitsR as any).rows ?? [];

  const out: any[] = [];
  for (const u of units) {
    // progetto-scheduling agganciato a questa UDP (se è stata avviata)
    const spR = await db.execute(sql`
      SELECT sp.id, sp.name FROM scheduling_projects sp
        LEFT JOIN project_members pm ON pm.project_id = sp.id AND pm.user_id = ${userId}::uuid
       WHERE sp.validity_unit_id = ${u.id}::uuid
         AND (sp.owner_user_id = ${userId}::uuid OR pm.user_id IS NOT NULL)
       ORDER BY sp.created_at DESC LIMIT 1`);
    const sp = (spR as any).rows?.[0] ?? null;
    let v: any = null, d: any = null, uncoveredInTm = 0;
    if (sp) {
      const vR = await db.execute(sql`
        SELECT id, name, date,
               (result->'summary'->>'numVehicles')::int AS num_vehicles,
               COALESCE(jsonb_array_length(result->'unassigned'), 0) AS uncovered
          FROM service_program_scenarios
         WHERE project_id = ${sp.id}::uuid AND is_operational = true LIMIT 1`);
      v = (vR as any).rows?.[0] ?? null;
      if (v) {
        uncoveredInTm = Number(v.uncovered) || 0;
        const dR = await db.execute(sql`
          SELECT id, name,
                 jsonb_array_length(COALESCE(result->'driverShifts', '[]'::jsonb)) AS duty_count
            FROM driver_shift_scenarios
           WHERE service_program_scenario_id = ${v.id}::uuid AND is_operational = true LIMIT 1`);
        d = (dR as any).rows?.[0] ?? null;
      }
    }
    const status = !sp ? "not_started" : !v ? "missing_vehicle" : !d ? "missing_driver" : "complete";
    out.push({
      validityUnitId: u.id,
      validityUnitName: u.name,
      tripCount: Number(u.trip_count) || 0,
      schedulingProjectId: sp?.id ?? null,
      vehicleScenario: v ? { id: v.id, name: v.name, date: v.date, numVehicles: v.num_vehicles } : null,
      driverScenario: d ? { id: d.id, name: d.name, dutyCount: Number(d.duty_count) || 0 } : null,
      vehicleUncovered: uncoveredInTm,
      status,
    });
  }

  // Corse del programma NON incluse in nessuna UDP ("corse scoperte" a monte).
  const progUncR = await db.execute(sql`
    SELECT COUNT(*)::int AS c FROM ps_trips t
     WHERE t.project_id = ${psId}::uuid AND COALESCE(t.is_active, true) = true
       AND NOT (t.id::text = ANY (
         SELECT jsonb_array_elements_text(trip_ids) FROM ps_validity_units WHERE project_id = ${psId}::uuid
       ))`);
  const programUncovered = Number((progUncR as any).rows?.[0]?.c) || 0;

  res.json({
    psProjectId: psId,
    programUncoveredTrips: programUncovered,
    projects: out,
    totals: {
      udp: out.length,
      complete: out.filter(x => x.status === "complete").length,
      withIssues: out.filter(x => x.status !== "complete").length + (programUncovered > 0 ? 1 : 0),
      vehicles: out.reduce((s, x) => s + (x.vehicleScenario?.numVehicles ?? 0), 0),
      duties: out.reduce((s, x) => s + (x.driverScenario?.dutyCount ?? 0), 0),
    },
  });
});

/* ────────────────────────────────────────────────────────────
 * Membri del progetto (condivisione)
 * ──────────────────────────────────────────────────────────── */

/* GET /api/scheduling/projects/:id/members — lista membri (incluso owner come prima riga) */
router.get("/scheduling/projects/:id/members", async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params.id || "");
  if (!UUID_RE.test(id)) { res.status(400).json({ error: "ID non valido" }); return; }
  const accessible = await loadProjectAccessible(id, req.user!.id);
  if (!accessible) { res.status(404).json({ error: "Progetto non trovato" }); return; }

  const r = await db.execute(sql`
    SELECT u.id AS user_id, u.email, u.full_name,
           'owner'::text AS role,
           p.created_at AS added_at,
           NULL::uuid AS added_by
      FROM scheduling_projects p
      JOIN users u ON u.id = p.owner_user_id
     WHERE p.id = ${id}::uuid
    UNION ALL
    SELECT u.id AS user_id, u.email, u.full_name,
           pm.role, pm.added_at, pm.added_by
      FROM project_members pm
      JOIN users u ON u.id = pm.user_id
     WHERE pm.project_id = ${id}::uuid
     ORDER BY 4 DESC, 5 ASC
  `);
  const rows: any[] = (r as any).rows ?? (r as any) ?? [];
  res.json({
    members: rows.map(m => ({
      userId: m.user_id,
      email: m.email,
      fullName: m.full_name,
      role: m.role,
      addedAt: m.added_at,
      addedBy: m.added_by,
    })),
  });
});

/* POST /api/scheduling/projects/:id/members  body: { userId, role? } — solo owner */
router.post("/scheduling/projects/:id/members", async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params.id || "");
  if (!UUID_RE.test(id)) { res.status(400).json({ error: "ID non valido" }); return; }
  const accessible = await loadProjectAccessible(id, req.user!.id);
  if (!accessible) { res.status(404).json({ error: "Progetto non trovato" }); return; }
  if (!isOwner(accessible, req.user!.id)) {
    res.status(403).json({ error: "Solo l'owner può aggiungere membri" }); return;
  }
  const { userId, role } = req.body || {};
  if (typeof userId !== "string" || !UUID_RE.test(userId)) {
    res.status(400).json({ error: "userId non valido" }); return;
  }
  if (userId === accessible.owner_user_id) {
    res.status(400).json({ error: "L'owner è già membro implicito" }); return;
  }
  const safeRole = role === "viewer" ? "viewer" : "editor";

  // Check user esistente
  const u = await db.execute(sql`SELECT id, email, full_name FROM users WHERE id = ${userId}::uuid LIMIT 1`);
  const userRow: any = (u as any).rows?.[0] ?? (u as any)[0];
  if (!userRow) { res.status(404).json({ error: "Utente non trovato" }); return; }

  await db.execute(sql`
    INSERT INTO project_members (project_id, user_id, role, added_by)
    VALUES (${id}::uuid, ${userId}::uuid, ${safeRole}, ${req.user!.id}::uuid)
    ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role
  `);
  // Auto-attiva flag is_shared
  await db.execute(sql`
    UPDATE scheduling_projects SET is_shared = true, updated_at = now()
     WHERE id = ${id}::uuid
  `);
  await logActivity(id, req.user!.id, "member.add", {
    targetType: "user", targetId: userId,
    payload: { email: userRow.email, role: safeRole },
  });
  res.json({
    member: {
      userId: userRow.id, email: userRow.email, fullName: userRow.full_name,
      role: safeRole, addedAt: new Date().toISOString(), addedBy: req.user!.id,
    },
  });
});

/* DELETE /api/scheduling/projects/:id/members/:userId — solo owner */
router.delete("/scheduling/projects/:id/members/:userId", async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params.id || "");
  const userId = String(req.params.userId || "");
  if (!UUID_RE.test(id) || !UUID_RE.test(userId)) { res.status(400).json({ error: "ID non validi" }); return; }
  const accessible = await loadProjectAccessible(id, req.user!.id);
  if (!accessible) { res.status(404).json({ error: "Progetto non trovato" }); return; }
  if (!isOwner(accessible, req.user!.id)) {
    res.status(403).json({ error: "Solo l'owner può rimuovere membri" }); return;
  }
  await db.execute(sql`
    DELETE FROM project_members
     WHERE project_id = ${id}::uuid AND user_id = ${userId}::uuid
  `);
  await logActivity(id, req.user!.id, "member.remove", {
    targetType: "user", targetId: userId,
  });
  res.json({ ok: true });
});

/* ────────────────────────────────────────────────────────────
 * Activity log
 * ──────────────────────────────────────────────────────────── */

/* GET /api/scheduling/projects/:id/activity?limit=50 */
router.get("/scheduling/projects/:id/activity", async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params.id || "");
  if (!UUID_RE.test(id)) { res.status(400).json({ error: "ID non valido" }); return; }
  const accessible = await loadProjectAccessible(id, req.user!.id);
  if (!accessible) { res.status(404).json({ error: "Progetto non trovato" }); return; }
  const limitRaw = parseInt(String(req.query.limit || "100"), 10);
  const limit = Math.max(1, Math.min(500, isFinite(limitRaw) ? limitRaw : 100));
  const r = await db.execute(sql`
    SELECT a.id, a.user_id, u.email AS user_email, u.full_name AS user_full_name,
           a.action, a.target_type, a.target_id, a.payload, a.at
      FROM project_activity_log a
      LEFT JOIN users u ON u.id = a.user_id
     WHERE a.project_id = ${id}::uuid
     ORDER BY a.at DESC
     LIMIT ${limit}
  `);
  const rows: any[] = (r as any).rows ?? (r as any) ?? [];
  res.json({
    activity: rows.map(a => ({
      id: a.id,
      userId: a.user_id,
      userEmail: a.user_email,
      userFullName: a.user_full_name,
      action: a.action,
      targetType: a.target_type,
      targetId: a.target_id,
      payload: a.payload ?? {},
      at: a.at,
    })),
  });
});

export default router;
