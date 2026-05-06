/**
 * Scenario access helpers.
 *
 * I "scenari" (vetture: service_program_scenarios, turni guida: driver_shift_scenarios)
 * sono entità legacy con campi additivi:
 *   - owner_user_id  (nullable: chi l'ha creato; null = legacy pre-multi-tenant)
 *   - project_id     (nullable: scheduling_project a cui sono agganciati)
 *
 * Regole di accesso:
 *   - admin (req.user.role === 'admin')          → tutto
 *   - owner_user_id === userId                   → R/W
 *   - membro diretto (vehicle_schedule_members /
 *     driver_schedule_members) con role editor   → R/W
 *   - membro diretto con role viewer             → R only
 *   - owner del scheduling_project collegato     → R/W (eredita)
 *   - membro del scheduling_project (editor)     → R/W (eredita)
 *   - membro del scheduling_project (viewer)     → R only (eredita)
 *   - LEGACY (owner_user_id IS NULL E
 *     project_id IS NULL)                        → ammesso (back-compat)
 *
 * Tutti gli helper qui sono pensati per essere chiamati DOPO requireAuth
 * (montato globalmente in routes/index.ts).
 */
import type { Request, Response } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

export type AccessLevel = "owner" | "editor" | "viewer" | "legacy";
export interface ScenarioAccess {
  level: AccessLevel;
  canWrite: boolean;
  ownerUserId: string | null;
  projectId: string | null;
}

const UUID_RE = /^[0-9a-f-]{36}$/i;

/* ──────────────────────────────────────────────────────────────
 *  Vehicle scenario (service_program_scenarios)
 * ────────────────────────────────────────────────────────────── */
export async function getVehicleScenarioAccess(
  scenarioId: string,
  userId: string,
  isAdmin = false,
): Promise<ScenarioAccess | null> {
  if (!UUID_RE.test(scenarioId) || !UUID_RE.test(userId)) return null;

  const r = await db.execute(sql`
    SELECT
      s.owner_user_id,
      s.project_id,
      vsm.role     AS direct_role,
      pm.role      AS project_role,
      sp.owner_user_id AS project_owner_id
    FROM service_program_scenarios s
    LEFT JOIN vehicle_schedule_members vsm
           ON vsm.scenario_id = s.id AND vsm.user_id = ${userId}::uuid
    LEFT JOIN scheduling_projects sp
           ON sp.id = s.project_id
    LEFT JOIN project_members pm
           ON pm.project_id = s.project_id AND pm.user_id = ${userId}::uuid
    WHERE s.id = ${scenarioId}::uuid
    LIMIT 1
  `);
  const row: any = (r as any).rows?.[0] ?? (r as any)[0];
  if (!row) return null;

  return resolveAccess(row, userId, isAdmin);
}

/* ──────────────────────────────────────────────────────────────
 *  Driver scenario (driver_shift_scenarios)
 *
 *  Accesso ereditato dal vehicle scenario padre OLTRE che
 *  dai propri membri/owner.
 * ────────────────────────────────────────────────────────────── */
export async function getDriverScenarioAccess(
  dssId: string,
  userId: string,
  isAdmin = false,
): Promise<ScenarioAccess | null> {
  if (!UUID_RE.test(dssId) || !UUID_RE.test(userId)) return null;

  const r = await db.execute(sql`
    SELECT
      d.owner_user_id,
      d.project_id,
      dsm.role        AS direct_role,
      sps.id          AS parent_scenario_id,
      sps.owner_user_id AS parent_owner_id,
      sps.project_id  AS parent_project_id,
      vsm.role        AS parent_direct_role,
      pm.role         AS project_role,
      sp.owner_user_id AS project_owner_id
    FROM driver_shift_scenarios d
    LEFT JOIN driver_schedule_members dsm
           ON dsm.scenario_id = d.id AND dsm.user_id = ${userId}::uuid
    LEFT JOIN service_program_scenarios sps
           ON sps.id = d.service_program_scenario_id
    LEFT JOIN vehicle_schedule_members vsm
           ON vsm.scenario_id = sps.id AND vsm.user_id = ${userId}::uuid
    LEFT JOIN scheduling_projects sp
           ON sp.id = COALESCE(d.project_id, sps.project_id)
    LEFT JOIN project_members pm
           ON pm.project_id = sp.id AND pm.user_id = ${userId}::uuid
    WHERE d.id = ${dssId}::uuid
    LIMIT 1
  `);
  const row: any = (r as any).rows?.[0] ?? (r as any)[0];
  if (!row) return null;

  // Estende resolveAccess con il "parent vehicle scenario"
  if (isAdmin) {
    return { level: "owner", canWrite: true, ownerUserId: row.owner_user_id, projectId: row.project_id };
  }
  // Owner diretto
  if (row.owner_user_id === userId) {
    return { level: "owner", canWrite: true, ownerUserId: row.owner_user_id, projectId: row.project_id };
  }
  // Owner del vehicle parent
  if (row.parent_owner_id === userId) {
    return { level: "owner", canWrite: true, ownerUserId: row.owner_user_id, projectId: row.project_id };
  }
  // Membro diretto del DSS
  if (row.direct_role === "editor") {
    return { level: "editor", canWrite: true, ownerUserId: row.owner_user_id, projectId: row.project_id };
  }
  if (row.direct_role === "viewer") {
    return { level: "viewer", canWrite: false, ownerUserId: row.owner_user_id, projectId: row.project_id };
  }
  // Membro del vehicle parent
  if (row.parent_direct_role === "editor") {
    return { level: "editor", canWrite: true, ownerUserId: row.owner_user_id, projectId: row.project_id };
  }
  if (row.parent_direct_role === "viewer") {
    return { level: "viewer", canWrite: false, ownerUserId: row.owner_user_id, projectId: row.project_id };
  }
  // Owner / membro del scheduling project
  if (row.project_owner_id === userId) {
    return { level: "owner", canWrite: true, ownerUserId: row.owner_user_id, projectId: row.project_id };
  }
  if (row.project_role === "editor") {
    return { level: "editor", canWrite: true, ownerUserId: row.owner_user_id, projectId: row.project_id };
  }
  if (row.project_role === "viewer") {
    return { level: "viewer", canWrite: false, ownerUserId: row.owner_user_id, projectId: row.project_id };
  }
  // Legacy (owner null E project null E parent null)
  if (!row.owner_user_id && !row.project_id && !row.parent_owner_id && !row.parent_project_id) {
    return { level: "legacy", canWrite: true, ownerUserId: null, projectId: null };
  }
  return null;
}

/* ──────────────────────────────────────────────────────────────
 *  Helper interno
 * ────────────────────────────────────────────────────────────── */
function resolveAccess(row: any, userId: string, isAdmin: boolean): ScenarioAccess | null {
  if (isAdmin) {
    return { level: "owner", canWrite: true, ownerUserId: row.owner_user_id, projectId: row.project_id };
  }
  if (row.owner_user_id === userId) {
    return { level: "owner", canWrite: true, ownerUserId: row.owner_user_id, projectId: row.project_id };
  }
  if (row.direct_role === "editor") {
    return { level: "editor", canWrite: true, ownerUserId: row.owner_user_id, projectId: row.project_id };
  }
  if (row.direct_role === "viewer") {
    return { level: "viewer", canWrite: false, ownerUserId: row.owner_user_id, projectId: row.project_id };
  }
  if (row.project_owner_id === userId) {
    return { level: "owner", canWrite: true, ownerUserId: row.owner_user_id, projectId: row.project_id };
  }
  if (row.project_role === "editor") {
    return { level: "editor", canWrite: true, ownerUserId: row.owner_user_id, projectId: row.project_id };
  }
  if (row.project_role === "viewer") {
    return { level: "viewer", canWrite: false, ownerUserId: row.owner_user_id, projectId: row.project_id };
  }
  // Legacy: nessun owner né progetto — back-compat aperta.
  if (!row.owner_user_id && !row.project_id) {
    return { level: "legacy", canWrite: true, ownerUserId: null, projectId: null };
  }
  return null;
}

/* ──────────────────────────────────────────────────────────────
 *  Wrappers Express: rispondono 401/403/404 e ritornano l'accesso
 * ────────────────────────────────────────────────────────────── */

/** Vehicle scenario: read-only access. */
export async function requireVehicleScenarioRead(
  req: Request,
  res: Response,
  scenarioId: string,
): Promise<ScenarioAccess | null> {
  if (!req.user) { res.status(401).json({ error: "Non autenticato" }); return null; }
  const acc = await getVehicleScenarioAccess(scenarioId, req.user.id, req.user.role === "admin");
  if (!acc) { res.status(404).json({ error: "Scenario non trovato o non accessibile" }); return null; }
  return acc;
}

/** Vehicle scenario: write access. */
export async function requireVehicleScenarioWrite(
  req: Request,
  res: Response,
  scenarioId: string,
): Promise<ScenarioAccess | null> {
  const acc = await requireVehicleScenarioRead(req, res, scenarioId);
  if (!acc) return null;
  if (!acc.canWrite) {
    res.status(403).json({ error: "Permesso insufficiente: sei in sola lettura su questo scenario" });
    return null;
  }
  return acc;
}

/** Driver scenario: read-only access. */
export async function requireDriverScenarioRead(
  req: Request,
  res: Response,
  dssId: string,
): Promise<ScenarioAccess | null> {
  if (!req.user) { res.status(401).json({ error: "Non autenticato" }); return null; }
  const acc = await getDriverScenarioAccess(dssId, req.user.id, req.user.role === "admin");
  if (!acc) { res.status(404).json({ error: "Scenario turni non trovato o non accessibile" }); return null; }
  return acc;
}

/** Driver scenario: write access. */
export async function requireDriverScenarioWrite(
  req: Request,
  res: Response,
  dssId: string,
): Promise<ScenarioAccess | null> {
  const acc = await requireDriverScenarioRead(req, res, dssId);
  if (!acc) return null;
  if (!acc.canWrite) {
    res.status(403).json({ error: "Permesso insufficiente: sei in sola lettura su questo scenario turni" });
    return null;
  }
  return acc;
}

/* ──────────────────────────────────────────────────────────────
 *  Filtro lista: ritorna SQL fragment WHERE per scenari accessibili
 *  Da usare in: SELECT ... FROM service_program_scenarios s WHERE <frag>
 * ────────────────────────────────────────────────────────────── */
export function vehicleScenariosAccessibleWhere(userId: string, isAdmin: boolean) {
  if (isAdmin) return sql`TRUE`;
  return sql`(
    s.owner_user_id = ${userId}::uuid
    OR EXISTS (SELECT 1 FROM vehicle_schedule_members vsm
                WHERE vsm.scenario_id = s.id AND vsm.user_id = ${userId}::uuid)
    OR EXISTS (SELECT 1 FROM scheduling_projects sp
                WHERE sp.id = s.project_id AND sp.owner_user_id = ${userId}::uuid)
    OR EXISTS (SELECT 1 FROM project_members pm
                WHERE pm.project_id = s.project_id AND pm.user_id = ${userId}::uuid)
    OR (s.owner_user_id IS NULL AND s.project_id IS NULL)
  )`;
}

export function driverScenariosAccessibleWhere(userId: string, isAdmin: boolean) {
  if (isAdmin) return sql`TRUE`;
  return sql`(
    d.owner_user_id = ${userId}::uuid
    OR EXISTS (SELECT 1 FROM driver_schedule_members dsm
                WHERE dsm.scenario_id = d.id AND dsm.user_id = ${userId}::uuid)
    OR EXISTS (
      SELECT 1 FROM service_program_scenarios sps
       WHERE sps.id = d.service_program_scenario_id
         AND (
           sps.owner_user_id = ${userId}::uuid
           OR EXISTS (SELECT 1 FROM vehicle_schedule_members vsm
                       WHERE vsm.scenario_id = sps.id AND vsm.user_id = ${userId}::uuid)
           OR EXISTS (SELECT 1 FROM scheduling_projects sp
                       WHERE sp.id = sps.project_id AND sp.owner_user_id = ${userId}::uuid)
           OR EXISTS (SELECT 1 FROM project_members pm
                       WHERE pm.project_id = sps.project_id AND pm.user_id = ${userId}::uuid)
         )
    )
    OR EXISTS (SELECT 1 FROM scheduling_projects sp
                WHERE sp.id = d.project_id AND sp.owner_user_id = ${userId}::uuid)
    OR EXISTS (SELECT 1 FROM project_members pm
                WHERE pm.project_id = d.project_id AND pm.user_id = ${userId}::uuid)
    OR (d.owner_user_id IS NULL AND d.project_id IS NULL)
  )`;
}
