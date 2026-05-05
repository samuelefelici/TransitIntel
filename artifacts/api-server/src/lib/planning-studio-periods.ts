/**
 * Planning Studio — Service Periods (periodi di esercizio)
 *
 * Esempi: "Estivo 2026", "Invernale 2025-26", "Scolastico", "Festivo".
 * Ogni Service Period definisce un intervallo date dentro cui un calendario
 * GTFS si applica. Più service periods possono coesistere e sovrapporsi.
 *
 * Endpoints:
 *   GET    /projects/:id/service-periods
 *   POST   /projects/:id/service-periods
 *   PATCH  /projects/:id/service-periods/:periodId
 *   DELETE /projects/:id/service-periods/:periodId
 */
import type { Request, Response } from "express";
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const router: IRouter = Router();

async function loadProject(projectId: string, userId: string, needWrite: boolean): Promise<any | null> {
  const r = await db.execute(sql`
    SELECT p.*,
           CASE WHEN p.owner_user_id = ${userId}::uuid THEN 'owner'
                ELSE pm.role END AS my_role
      FROM ps_projects p
      LEFT JOIN ps_project_members pm
             ON pm.project_id = p.id AND pm.user_id = ${userId}::uuid
     WHERE p.id = ${projectId}::uuid
       AND (p.owner_user_id = ${userId}::uuid OR pm.user_id IS NOT NULL)
     LIMIT 1
  `);
  const row: any = (r as any).rows?.[0] ?? null;
  if (!row) return null;
  if (needWrite && row.my_role !== "owner" && row.my_role !== "editor") return null;
  return row;
}

function getUserId(req: Request): string | null {
  return (req as any).session?.userId ?? (req as any).user?.id ?? null;
}

async function logActivity(
  projectId: string, userId: string, action: string,
  targetType: string | null, targetId: string | null, payload: Record<string, any> = {},
): Promise<void> {
  try {
    await db.execute(sql`
      INSERT INTO ps_project_activity_log (project_id, user_id, action, target_type, target_id, payload)
      VALUES (${projectId}::uuid, ${userId}::uuid, ${action}, ${targetType}, ${targetId}, ${JSON.stringify(payload)}::jsonb)
    `);
  } catch (e: any) {
    console.warn("[ps-periods] activity log error:", e?.message || e);
  }
}

function rowToPeriod(r: any) {
  return {
    id: r.id,
    projectId: r.project_id,
    code: r.code,
    name: r.name,
    startDate: r.start_date,
    endDate: r.end_date,
    isDefault: !!r.is_default,
    color: r.color,
    notes: r.notes,
    createdAt: r.created_at,
  };
}

/* ─── GET ─── */

router.get("/planning-studio/projects/:id/service-periods", async (req, res): Promise<void> => {
  const userId = getUserId(req);
  if (!userId) { res.status(401).json({ error: "auth required" }); return; }
  const proj = await loadProject(req.params.id, userId, false);
  if (!proj) { res.status(404).json({ error: "project not found" }); return; }

  const r = await db.execute(sql`
    SELECT * FROM ps_service_periods
     WHERE project_id = ${req.params.id}::uuid
     ORDER BY start_date ASC, name ASC
  `);
  const rows: any[] = (r as any).rows ?? [];
  res.json({ servicePeriods: rows.map(rowToPeriod) });
});

/* ─── POST ─── */

router.post("/planning-studio/projects/:id/service-periods", async (req, res): Promise<void> => {
  const userId = getUserId(req);
  if (!userId) { res.status(401).json({ error: "auth required" }); return; }
  const proj = await loadProject(req.params.id, userId, true);
  if (!proj) { res.status(403).json({ error: "no write access" }); return; }

  const { code = null, name, startDate, endDate, isDefault = false, color = null, notes = null } = req.body ?? {};
  if (!name || typeof name !== "string") { res.status(400).json({ error: "name required" }); return; }
  if (!startDate || !endDate) { res.status(400).json({ error: "startDate and endDate required" }); return; }
  if (new Date(startDate) > new Date(endDate)) { res.status(400).json({ error: "startDate must be ≤ endDate" }); return; }

  // se isDefault=true, sgancia l'eventuale altro default
  if (isDefault) {
    await db.execute(sql`
      UPDATE ps_service_periods SET is_default = false
       WHERE project_id = ${req.params.id}::uuid AND is_default = true
    `);
  }

  const r = await db.execute(sql`
    INSERT INTO ps_service_periods (project_id, code, name, start_date, end_date, is_default, color, notes)
    VALUES (${req.params.id}::uuid, ${code}, ${name}, ${startDate}, ${endDate}, ${isDefault}, ${color}, ${notes})
    RETURNING *
  `);
  const row: any = (r as any).rows?.[0];
  await logActivity(req.params.id, userId, "service_period.create", "service_period", row.id, { name });
  res.status(201).json({ servicePeriod: rowToPeriod(row) });
});

/* ─── PATCH ─── */

router.patch("/planning-studio/projects/:id/service-periods/:periodId", async (req, res): Promise<void> => {
  const userId = getUserId(req);
  if (!userId) { res.status(401).json({ error: "auth required" }); return; }
  const proj = await loadProject(req.params.id, userId, true);
  if (!proj) { res.status(403).json({ error: "no write access" }); return; }

  const fields: string[] = [];
  const vals: any[] = [];
  const map: Record<string, string> = {
    code: "code", name: "name",
    startDate: "start_date", endDate: "end_date",
    isDefault: "is_default", color: "color", notes: "notes",
  };
  for (const [k, col] of Object.entries(map)) {
    if (k in req.body) { fields.push(col); vals.push(req.body[k]); }
  }
  if (fields.length === 0) { res.status(400).json({ error: "no fields to update" }); return; }

  // se imposto isDefault=true, sgancia altri
  if (req.body.isDefault === true) {
    await db.execute(sql`
      UPDATE ps_service_periods SET is_default = false
       WHERE project_id = ${req.params.id}::uuid
         AND is_default = true
         AND id <> ${req.params.periodId}::uuid
    `);
  }

  const setSql = sql.join(
    fields.map((f, i) => sql`${sql.raw(f)} = ${vals[i]}`),
    sql`, `,
  );
  const r = await db.execute(sql`
    UPDATE ps_service_periods
       SET ${setSql}
     WHERE id = ${req.params.periodId}::uuid
       AND project_id = ${req.params.id}::uuid
     RETURNING *
  `);
  const row: any = (r as any).rows?.[0];
  if (!row) { res.status(404).json({ error: "service period not found" }); return; }
  await logActivity(req.params.id, userId, "service_period.update", "service_period", row.id, { fields });
  res.json({ servicePeriod: rowToPeriod(row) });
});

/* ─── DELETE ─── */

router.delete("/planning-studio/projects/:id/service-periods/:periodId", async (req, res): Promise<void> => {
  const userId = getUserId(req);
  if (!userId) { res.status(401).json({ error: "auth required" }); return; }
  const proj = await loadProject(req.params.id, userId, true);
  if (!proj) { res.status(403).json({ error: "no write access" }); return; }

  const r = await db.execute(sql`
    DELETE FROM ps_service_periods
     WHERE id = ${req.params.periodId}::uuid
       AND project_id = ${req.params.id}::uuid
     RETURNING id
  `);
  if (((r as any).rows ?? []).length === 0) { res.status(404).json({ error: "service period not found" }); return; }
  await logActivity(req.params.id, userId, "service_period.delete", "service_period", req.params.periodId, {});
  res.json({ ok: true });
});

export default router;
