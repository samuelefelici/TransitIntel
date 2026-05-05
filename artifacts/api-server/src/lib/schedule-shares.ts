/**
 * Schedule Shares — VehicleSchedule & DriverSchedule come "progetti" condivisibili.
 *
 * Modello (Step 7 livelli 2-3):
 *   PsProject ──< SchedulingProject ──< VehicleSchedule (= service_program_scenarios)
 *                                              └──< DriverSchedule (= driver_shift_scenarios)
 *
 * Ogni VehicleSchedule e DriverSchedule:
 *   - ha owner_user_id (chi l'ha creato)
 *   - può essere condiviso con altri utenti (vehicle_schedule_members / driver_schedule_members)
 *   - flag is_shared esplicito per indicare la condivisione
 *
 * Le tabelle e le colonne sono create idempotentemente in scheduling-projects.ts
 * (bootstrap unico). Questo file fornisce solo gli endpoint REST.
 */
import type { Request, Response } from "express";
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const UUID_RE = /^[0-9a-f-]{36}$/i;

const router: IRouter = Router();

router.use(async (req, res, next) => {
  if (!req.user) { res.status(401).json({ error: "Non autenticato" }); return; }
  next();
});

/* ────────────────────────────────────────────────────────────
 * Helpers
 * ──────────────────────────────────────────────────────────── */

function rowToVehicle(r: any) {
  return {
    id: r.id,
    name: r.name,
    description: r.description ?? null,
    date: r.date,
    feedId: r.feed_id ?? null,
    schedulingProjectId: r.project_id ?? null,
    schedulingProjectName: r.scheduling_project_name ?? undefined,
    ownerUserId: r.owner_user_id ?? null,
    ownerEmail: r.owner_email ?? undefined,
    ownerFullName: r.owner_full_name ?? undefined,
    isShared: !!r.is_shared,
    memberCount: r.member_count != null ? Number(r.member_count) : undefined,
    myRole: r.my_role ?? (r.owner_user_id && r.owner_user_id === r.__userId ? "owner" : undefined),
    numVehicles: r.num_vehicles ?? null,
    totalDeadheadKm: r.total_deadhead_km ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToDriver(r: any) {
  return {
    id: r.id,
    name: r.name,
    description: r.description ?? null,
    vehicleScheduleId: r.service_program_scenario_id,
    vehicleScheduleName: r.vehicle_schedule_name ?? undefined,
    schedulingProjectId: r.project_id ?? null,
    ownerUserId: r.owner_user_id ?? null,
    ownerEmail: r.owner_email ?? undefined,
    ownerFullName: r.owner_full_name ?? undefined,
    isShared: !!r.is_shared,
    memberCount: r.member_count != null ? Number(r.member_count) : undefined,
    myRole: r.my_role ?? undefined,
    totalDriverShifts: r.total_driver_shifts ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Carica un VehicleSchedule (= service_program_scenarios) se accessibile dall'utente.
 *  Accesso = owner OPPURE membro OPPURE membro/owner del SchedulingProject genitore.
 */
async function loadVehicleAccessible(id: string, userId: string): Promise<any | null> {
  const r = await db.execute(sql`
    SELECT sps.*,
           CASE
             WHEN sps.owner_user_id = ${userId}::uuid THEN 'owner'
             WHEN vsm.role IS NOT NULL THEN vsm.role
             WHEN sp.owner_user_id = ${userId}::uuid THEN 'owner'
             WHEN pm.role IS NOT NULL THEN pm.role
             ELSE NULL
           END AS my_role
      FROM service_program_scenarios sps
      LEFT JOIN vehicle_schedule_members vsm
             ON vsm.scenario_id = sps.id AND vsm.user_id = ${userId}::uuid
      LEFT JOIN scheduling_projects sp ON sp.id = sps.project_id
      LEFT JOIN project_members pm
             ON pm.project_id = sp.id AND pm.user_id = ${userId}::uuid
     WHERE sps.id = ${id}::uuid
     LIMIT 1
  `);
  const row: any = (r as any).rows?.[0] ?? (r as any)[0];
  if (!row || !row.my_role) return null;
  return row;
}

/** Carica un DriverSchedule (= driver_shift_scenarios) se accessibile dall'utente. */
async function loadDriverAccessible(id: string, userId: string): Promise<any | null> {
  const r = await db.execute(sql`
    SELECT dss.*,
           sps.project_id AS sps_project_id,
           CASE
             WHEN dss.owner_user_id = ${userId}::uuid THEN 'owner'
             WHEN dsm.role IS NOT NULL THEN dsm.role
             WHEN sps.owner_user_id = ${userId}::uuid THEN 'owner'
             WHEN vsm.role IS NOT NULL THEN vsm.role
             WHEN sp.owner_user_id = ${userId}::uuid THEN 'owner'
             WHEN pm.role IS NOT NULL THEN pm.role
             ELSE NULL
           END AS my_role
      FROM driver_shift_scenarios dss
      LEFT JOIN driver_schedule_members dsm
             ON dsm.scenario_id = dss.id AND dsm.user_id = ${userId}::uuid
      LEFT JOIN service_program_scenarios sps ON sps.id = dss.service_program_scenario_id
      LEFT JOIN vehicle_schedule_members vsm
             ON vsm.scenario_id = sps.id AND vsm.user_id = ${userId}::uuid
      LEFT JOIN scheduling_projects sp ON sp.id = sps.project_id
      LEFT JOIN project_members pm
             ON pm.project_id = sp.id AND pm.user_id = ${userId}::uuid
     WHERE dss.id = ${id}::uuid
     LIMIT 1
  `);
  const row: any = (r as any).rows?.[0] ?? (r as any)[0];
  if (!row || !row.my_role) return null;
  return row;
}

const isWritable = (role: string | null) => role === "owner" || role === "editor";

/* ════════════════════════════════════════════════════════════
 * VEHICLE SCHEDULES (= service_program_scenarios) — share API
 * ════════════════════════════════════════════════════════════ */

/* GET /api/vehicle-schedules
 *   ?schedulingProjectId=:uuid  → solo schedule del progetto
 *   ?mineOnly=1                 → solo owned (esclude shared)
 *   default: tutti accessibili (owned + shared diretto + shared via parent)
 */
router.get("/vehicle-schedules", async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const projFilter = String(req.query.schedulingProjectId || "").trim();
  const mineOnly = String(req.query.mineOnly || "") === "1";

  const projWhere = projFilter && UUID_RE.test(projFilter)
    ? sql`AND sps.project_id = ${projFilter}::uuid`
    : sql``;
  const accessWhere = mineOnly
    ? sql`sps.owner_user_id = ${userId}::uuid`
    : sql`(
        sps.owner_user_id = ${userId}::uuid
        OR vsm.user_id IS NOT NULL
        OR sp.owner_user_id = ${userId}::uuid
        OR pm.user_id IS NOT NULL
      )`;

  const r = await db.execute(sql`
    SELECT sps.id, sps.name, sps.description, sps.date, sps.feed_id, sps.project_id,
           sps.owner_user_id, sps.is_shared, sps.created_at, sps.updated_at,
           u.email AS owner_email, u.full_name AS owner_full_name,
           sp.name AS scheduling_project_name,
           (sps.result->'summary'->>'numVehicles')::int AS num_vehicles,
           (sps.result->'summary'->>'totalDeadheadKm')::float AS total_deadhead_km,
           (SELECT count(*)::int FROM vehicle_schedule_members vsm2
              WHERE vsm2.scenario_id = sps.id) AS member_count,
           CASE
             WHEN sps.owner_user_id = ${userId}::uuid THEN 'owner'
             WHEN vsm.role IS NOT NULL THEN vsm.role
             WHEN sp.owner_user_id = ${userId}::uuid THEN 'owner'
             WHEN pm.role IS NOT NULL THEN pm.role
             ELSE NULL
           END AS my_role
      FROM service_program_scenarios sps
      LEFT JOIN users u ON u.id = sps.owner_user_id
      LEFT JOIN scheduling_projects sp ON sp.id = sps.project_id
      LEFT JOIN vehicle_schedule_members vsm
             ON vsm.scenario_id = sps.id AND vsm.user_id = ${userId}::uuid
      LEFT JOIN project_members pm
             ON pm.project_id = sps.project_id AND pm.user_id = ${userId}::uuid
     WHERE ${accessWhere} ${projWhere}
     ORDER BY sps.created_at DESC
  `);
  const rows: any[] = (r as any).rows ?? (r as any) ?? [];
  res.json({ vehicleSchedules: rows.map(rowToVehicle) });
});

/* GET /api/vehicle-schedules/:id */
router.get("/vehicle-schedules/:id", async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params.id || "");
  if (!UUID_RE.test(id)) { res.status(400).json({ error: "ID non valido" }); return; }
  const row = await loadVehicleAccessible(id, req.user!.id);
  if (!row) { res.status(404).json({ error: "Vehicle schedule non trovato" }); return; }
  // arricchimento owner_email, member_count, scheduling_project_name
  const enrich = await db.execute(sql`
    SELECT u.email AS owner_email, u.full_name AS owner_full_name,
           sp.name AS scheduling_project_name,
           (SELECT count(*)::int FROM vehicle_schedule_members vsm
              WHERE vsm.scenario_id = ${id}::uuid) AS member_count
      FROM service_program_scenarios sps
      LEFT JOIN users u ON u.id = sps.owner_user_id
      LEFT JOIN scheduling_projects sp ON sp.id = sps.project_id
     WHERE sps.id = ${id}::uuid
  `);
  const ext: any = (enrich as any).rows?.[0] ?? (enrich as any)[0] ?? {};
  res.json({ vehicleSchedule: rowToVehicle({ ...row, ...ext }) });
});

/* PATCH /api/vehicle-schedules/:id — rinomina, descrizione, share flag, claim ownership */
router.patch("/vehicle-schedules/:id", async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params.id || "");
  if (!UUID_RE.test(id)) { res.status(400).json({ error: "ID non valido" }); return; }
  const row = await loadVehicleAccessible(id, req.user!.id);
  if (!row) { res.status(404).json({ error: "Non trovato" }); return; }
  if (!isWritable(row.my_role)) {
    res.status(403).json({ error: "Permesso insufficiente" }); return;
  }
  const { name, description, isShared } = req.body || {};
  const sets: any[] = [];
  if (typeof name === "string" && name.trim()) sets.push(sql`name = ${name.trim()}`);
  if (description !== undefined) sets.push(sql`description = ${description}`);
  if (isShared !== undefined) {
    if (row.owner_user_id && row.owner_user_id !== req.user!.id) {
      res.status(403).json({ error: "Solo l'owner può modificare la condivisione" }); return;
    }
    sets.push(sql`is_shared = ${!!isShared}`);
  }
  // Claim ownership: se non c'è ancora owner (entità storica) e l'utente è writable, diventa owner
  if (!row.owner_user_id && req.body?.claimOwnership === true) {
    sets.push(sql`owner_user_id = ${req.user!.id}::uuid`);
  }
  if (sets.length === 0) { res.json({ ok: true, noop: true }); return; }
  sets.push(sql`updated_at = now()`);
  const assignments = sql.join(sets, sql`, `);
  const r = await db.execute(sql`
    UPDATE service_program_scenarios SET ${assignments}
     WHERE id = ${id}::uuid
     RETURNING *
  `);
  const updated: any = (r as any).rows?.[0] ?? (r as any)[0];
  res.json({ vehicleSchedule: rowToVehicle({ ...updated, my_role: row.my_role }) });
});

/* DELETE /api/vehicle-schedules/:id — solo owner */
router.delete("/vehicle-schedules/:id", async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params.id || "");
  if (!UUID_RE.test(id)) { res.status(400).json({ error: "ID non valido" }); return; }
  const row = await loadVehicleAccessible(id, req.user!.id);
  if (!row) { res.status(404).json({ error: "Non trovato" }); return; }
  if (row.owner_user_id && row.owner_user_id !== req.user!.id) {
    res.status(403).json({ error: "Solo l'owner può eliminare" }); return;
  }
  await db.execute(sql`DELETE FROM service_program_scenarios WHERE id = ${id}::uuid`);
  res.json({ ok: true });
});

/* GET /api/vehicle-schedules/:id/members */
router.get("/vehicle-schedules/:id/members", async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params.id || "");
  if (!UUID_RE.test(id)) { res.status(400).json({ error: "ID non valido" }); return; }
  const row = await loadVehicleAccessible(id, req.user!.id);
  if (!row) { res.status(404).json({ error: "Non trovato" }); return; }
  const r = await db.execute(sql`
    SELECT u.id AS user_id, u.email, u.full_name,
           'owner'::text AS role, sps.created_at AS added_at, NULL::uuid AS added_by
      FROM service_program_scenarios sps
      JOIN users u ON u.id = sps.owner_user_id
     WHERE sps.id = ${id}::uuid AND sps.owner_user_id IS NOT NULL
    UNION ALL
    SELECT u.id, u.email, u.full_name, vsm.role, vsm.added_at, vsm.added_by
      FROM vehicle_schedule_members vsm
      JOIN users u ON u.id = vsm.user_id
     WHERE vsm.scenario_id = ${id}::uuid
     ORDER BY 4 DESC, 5 ASC
  `);
  const rows: any[] = (r as any).rows ?? (r as any) ?? [];
  res.json({ members: rows.map(m => ({
    userId: m.user_id, email: m.email, fullName: m.full_name,
    role: m.role, addedAt: m.added_at, addedBy: m.added_by,
  })) });
});

/* POST /api/vehicle-schedules/:id/members  body: { userId, role? } — solo owner */
router.post("/vehicle-schedules/:id/members", async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params.id || "");
  if (!UUID_RE.test(id)) { res.status(400).json({ error: "ID non valido" }); return; }
  const row = await loadVehicleAccessible(id, req.user!.id);
  if (!row) { res.status(404).json({ error: "Non trovato" }); return; }
  if (row.owner_user_id && row.owner_user_id !== req.user!.id) {
    res.status(403).json({ error: "Solo l'owner può aggiungere membri" }); return;
  }
  const { userId, role } = req.body || {};
  if (typeof userId !== "string" || !UUID_RE.test(userId)) {
    res.status(400).json({ error: "userId non valido" }); return;
  }
  const safeRole = role === "viewer" ? "viewer" : "editor";
  await db.execute(sql`
    INSERT INTO vehicle_schedule_members (scenario_id, user_id, role, added_by)
    VALUES (${id}::uuid, ${userId}::uuid, ${safeRole}, ${req.user!.id}::uuid)
    ON CONFLICT (scenario_id, user_id) DO UPDATE SET role = EXCLUDED.role
  `);
  await db.execute(sql`
    UPDATE service_program_scenarios SET is_shared = true, updated_at = now()
     WHERE id = ${id}::uuid
  `);
  res.json({ ok: true });
});

/* DELETE /api/vehicle-schedules/:id/members/:userId */
router.delete("/vehicle-schedules/:id/members/:userId", async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params.id || "");
  const userId = String(req.params.userId || "");
  if (!UUID_RE.test(id) || !UUID_RE.test(userId)) { res.status(400).json({ error: "ID non validi" }); return; }
  const row = await loadVehicleAccessible(id, req.user!.id);
  if (!row) { res.status(404).json({ error: "Non trovato" }); return; }
  if (row.owner_user_id && row.owner_user_id !== req.user!.id) {
    res.status(403).json({ error: "Solo l'owner può rimuovere membri" }); return;
  }
  await db.execute(sql`
    DELETE FROM vehicle_schedule_members
     WHERE scenario_id = ${id}::uuid AND user_id = ${userId}::uuid
  `);
  res.json({ ok: true });
});

/* ════════════════════════════════════════════════════════════
 * DRIVER SCHEDULES (= driver_shift_scenarios) — share API
 * ════════════════════════════════════════════════════════════ */

/* GET /api/driver-schedules
 *   ?vehicleScheduleId=:uuid    → solo DSS di quel vehicle schedule
 *   ?schedulingProjectId=:uuid  → solo DSS di tutti i VS del progetto
 *   ?mineOnly=1
 */
router.get("/driver-schedules", async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const vsFilter = String(req.query.vehicleScheduleId || "").trim();
  const projFilter = String(req.query.schedulingProjectId || "").trim();
  const mineOnly = String(req.query.mineOnly || "") === "1";

  const vsWhere = vsFilter && UUID_RE.test(vsFilter)
    ? sql`AND dss.service_program_scenario_id = ${vsFilter}::uuid`
    : sql``;
  const projWhere = projFilter && UUID_RE.test(projFilter)
    ? sql`AND sps.project_id = ${projFilter}::uuid`
    : sql``;
  const accessWhere = mineOnly
    ? sql`dss.owner_user_id = ${userId}::uuid`
    : sql`(
        dss.owner_user_id = ${userId}::uuid
        OR dsm.user_id IS NOT NULL
        OR sps.owner_user_id = ${userId}::uuid
        OR vsm.user_id IS NOT NULL
        OR sp.owner_user_id = ${userId}::uuid
        OR pm.user_id IS NOT NULL
      )`;

  const r = await db.execute(sql`
    SELECT dss.id, dss.name, dss.description, dss.service_program_scenario_id,
           dss.owner_user_id, dss.is_shared, dss.created_at, dss.updated_at,
           u.email AS owner_email, u.full_name AS owner_full_name,
           sps.name AS vehicle_schedule_name, sps.project_id,
           (dss.result->'summary'->>'totalDriverShifts')::int AS total_driver_shifts,
           (SELECT count(*)::int FROM driver_schedule_members dsm2
              WHERE dsm2.scenario_id = dss.id) AS member_count,
           CASE
             WHEN dss.owner_user_id = ${userId}::uuid THEN 'owner'
             WHEN dsm.role IS NOT NULL THEN dsm.role
             WHEN sps.owner_user_id = ${userId}::uuid THEN 'owner'
             WHEN vsm.role IS NOT NULL THEN vsm.role
             WHEN sp.owner_user_id = ${userId}::uuid THEN 'owner'
             WHEN pm.role IS NOT NULL THEN pm.role
             ELSE NULL
           END AS my_role
      FROM driver_shift_scenarios dss
      LEFT JOIN users u ON u.id = dss.owner_user_id
      LEFT JOIN service_program_scenarios sps ON sps.id = dss.service_program_scenario_id
      LEFT JOIN scheduling_projects sp ON sp.id = sps.project_id
      LEFT JOIN driver_schedule_members dsm
             ON dsm.scenario_id = dss.id AND dsm.user_id = ${userId}::uuid
      LEFT JOIN vehicle_schedule_members vsm
             ON vsm.scenario_id = sps.id AND vsm.user_id = ${userId}::uuid
      LEFT JOIN project_members pm
             ON pm.project_id = sps.project_id AND pm.user_id = ${userId}::uuid
     WHERE ${accessWhere} ${vsWhere} ${projWhere}
     ORDER BY dss.created_at DESC
  `);
  const rows: any[] = (r as any).rows ?? (r as any) ?? [];
  res.json({ driverSchedules: rows.map(rowToDriver) });
});

/* GET /api/driver-schedules/:id */
router.get("/driver-schedules/:id", async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params.id || "");
  if (!UUID_RE.test(id)) { res.status(400).json({ error: "ID non valido" }); return; }
  const row = await loadDriverAccessible(id, req.user!.id);
  if (!row) { res.status(404).json({ error: "Non trovato" }); return; }
  const enrich = await db.execute(sql`
    SELECT u.email AS owner_email, u.full_name AS owner_full_name,
           sps.name AS vehicle_schedule_name, sps.project_id,
           (SELECT count(*)::int FROM driver_schedule_members dsm
              WHERE dsm.scenario_id = ${id}::uuid) AS member_count
      FROM driver_shift_scenarios dss
      LEFT JOIN users u ON u.id = dss.owner_user_id
      LEFT JOIN service_program_scenarios sps ON sps.id = dss.service_program_scenario_id
     WHERE dss.id = ${id}::uuid
  `);
  const ext: any = (enrich as any).rows?.[0] ?? (enrich as any)[0] ?? {};
  res.json({ driverSchedule: rowToDriver({ ...row, ...ext }) });
});

/* PATCH /api/driver-schedules/:id */
router.patch("/driver-schedules/:id", async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params.id || "");
  if (!UUID_RE.test(id)) { res.status(400).json({ error: "ID non valido" }); return; }
  const row = await loadDriverAccessible(id, req.user!.id);
  if (!row) { res.status(404).json({ error: "Non trovato" }); return; }
  if (!isWritable(row.my_role)) {
    res.status(403).json({ error: "Permesso insufficiente" }); return;
  }
  const { name, description, isShared } = req.body || {};
  const sets: any[] = [];
  if (typeof name === "string" && name.trim()) sets.push(sql`name = ${name.trim()}`);
  if (description !== undefined) sets.push(sql`description = ${description}`);
  if (isShared !== undefined) {
    if (row.owner_user_id && row.owner_user_id !== req.user!.id) {
      res.status(403).json({ error: "Solo l'owner può modificare la condivisione" }); return;
    }
    sets.push(sql`is_shared = ${!!isShared}`);
  }
  if (!row.owner_user_id && req.body?.claimOwnership === true) {
    sets.push(sql`owner_user_id = ${req.user!.id}::uuid`);
  }
  if (sets.length === 0) { res.json({ ok: true, noop: true }); return; }
  sets.push(sql`updated_at = now()`);
  const assignments = sql.join(sets, sql`, `);
  const r = await db.execute(sql`
    UPDATE driver_shift_scenarios SET ${assignments}
     WHERE id = ${id}::uuid
     RETURNING *
  `);
  const updated: any = (r as any).rows?.[0] ?? (r as any)[0];
  res.json({ driverSchedule: rowToDriver({ ...updated, my_role: row.my_role }) });
});

/* DELETE /api/driver-schedules/:id */
router.delete("/driver-schedules/:id", async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params.id || "");
  if (!UUID_RE.test(id)) { res.status(400).json({ error: "ID non valido" }); return; }
  const row = await loadDriverAccessible(id, req.user!.id);
  if (!row) { res.status(404).json({ error: "Non trovato" }); return; }
  if (row.owner_user_id && row.owner_user_id !== req.user!.id) {
    res.status(403).json({ error: "Solo l'owner può eliminare" }); return;
  }
  await db.execute(sql`DELETE FROM driver_shift_scenarios WHERE id = ${id}::uuid`);
  res.json({ ok: true });
});

/* GET /api/driver-schedules/:id/members */
router.get("/driver-schedules/:id/members", async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params.id || "");
  if (!UUID_RE.test(id)) { res.status(400).json({ error: "ID non valido" }); return; }
  const row = await loadDriverAccessible(id, req.user!.id);
  if (!row) { res.status(404).json({ error: "Non trovato" }); return; }
  const r = await db.execute(sql`
    SELECT u.id AS user_id, u.email, u.full_name,
           'owner'::text AS role, dss.created_at AS added_at, NULL::uuid AS added_by
      FROM driver_shift_scenarios dss
      JOIN users u ON u.id = dss.owner_user_id
     WHERE dss.id = ${id}::uuid AND dss.owner_user_id IS NOT NULL
    UNION ALL
    SELECT u.id, u.email, u.full_name, dsm.role, dsm.added_at, dsm.added_by
      FROM driver_schedule_members dsm
      JOIN users u ON u.id = dsm.user_id
     WHERE dsm.scenario_id = ${id}::uuid
     ORDER BY 4 DESC, 5 ASC
  `);
  const rows: any[] = (r as any).rows ?? (r as any) ?? [];
  res.json({ members: rows.map(m => ({
    userId: m.user_id, email: m.email, fullName: m.full_name,
    role: m.role, addedAt: m.added_at, addedBy: m.added_by,
  })) });
});

/* POST /api/driver-schedules/:id/members */
router.post("/driver-schedules/:id/members", async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params.id || "");
  if (!UUID_RE.test(id)) { res.status(400).json({ error: "ID non valido" }); return; }
  const row = await loadDriverAccessible(id, req.user!.id);
  if (!row) { res.status(404).json({ error: "Non trovato" }); return; }
  if (row.owner_user_id && row.owner_user_id !== req.user!.id) {
    res.status(403).json({ error: "Solo l'owner può aggiungere membri" }); return;
  }
  const { userId, role } = req.body || {};
  if (typeof userId !== "string" || !UUID_RE.test(userId)) {
    res.status(400).json({ error: "userId non valido" }); return;
  }
  const safeRole = role === "viewer" ? "viewer" : "editor";
  await db.execute(sql`
    INSERT INTO driver_schedule_members (scenario_id, user_id, role, added_by)
    VALUES (${id}::uuid, ${userId}::uuid, ${safeRole}, ${req.user!.id}::uuid)
    ON CONFLICT (scenario_id, user_id) DO UPDATE SET role = EXCLUDED.role
  `);
  await db.execute(sql`
    UPDATE driver_shift_scenarios SET is_shared = true, updated_at = now()
     WHERE id = ${id}::uuid
  `);
  res.json({ ok: true });
});

/* DELETE /api/driver-schedules/:id/members/:userId */
router.delete("/driver-schedules/:id/members/:userId", async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params.id || "");
  const userId = String(req.params.userId || "");
  if (!UUID_RE.test(id) || !UUID_RE.test(userId)) { res.status(400).json({ error: "ID non validi" }); return; }
  const row = await loadDriverAccessible(id, req.user!.id);
  if (!row) { res.status(404).json({ error: "Non trovato" }); return; }
  if (row.owner_user_id && row.owner_user_id !== req.user!.id) {
    res.status(403).json({ error: "Solo l'owner può rimuovere membri" }); return;
  }
  await db.execute(sql`
    DELETE FROM driver_schedule_members
     WHERE scenario_id = ${id}::uuid AND user_id = ${userId}::uuid
  `);
  res.json({ ok: true });
});

export default router;
