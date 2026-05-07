/**
 * PlannerStudio · Validity Matrix — schema bootstrap + endpoint CRUD (PR1).
 *
 * Spec: Cerbero · PlannerStudio Validity Matrix · v1
 *
 * Tabelle nuove (idempotenti, additive):
 *   - ps_day_types         — tipologie giorno (system globali + custom per progetto)
 *   - ps_day_calendar      — override day-type per data (globale o per progetto)
 *   - ps_trip_day_validity — default validità corsa × day-type
 *
 * Estensione esistenti:
 *   - ps_projects.agency_settings (jsonb) — patroni locali + altre config minori
 *
 * Seed eseguiti UNA volta al bootstrap (NOT EXISTS, idempotenti):
 *   - 7 system day-types globali (project_id NULL, is_system=true)
 *   - festivi nazionali italiani 2024-2030 in ps_day_calendar (project_id NULL,
 *     mappati su day-type 'festivo')
 *
 * Endpoint sotto /api/planning-studio/projects/:id/...:
 *   GET    /day-types
 *   POST   /day-types
 *   PATCH  /day-types/:dayTypeId
 *   DELETE /day-types/:dayTypeId
 *   GET    /validity/matrix?from=YYYY-MM-DD&to=YYYY-MM-DD
 *   PUT    /validity/trip-day            { trip_id, day_type_id, is_valid }
 *   PUT    /validity/day-calendar        { date, day_type_id, scope, note? }
 *   PUT    /validity/exception           { trip_id, date, exception_type, reason? }
 *
 * Auth: la chain in routes/index.ts già monta requireAuth + ensureTenantMiddleware
 * sopra di noi, quindi qui ci limitiamo al check ownership/membership su
 * ps_projects con la stessa loadProject() del resto del modulo.
 */
import type { Request, Response } from "express";
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { italianHolidays } from "./validity-matrix-shared";

const router: IRouter = Router();

/* ════════════════════════════════════════════════════════════
 *  Bootstrap idempotente
 * ════════════════════════════════════════════════════════════ */

const SYSTEM_DAY_TYPES: ReadonlyArray<{
  code: string;
  name: string;
  color: string;
  sort_order: number;
}> = [
  { code: "feriale",            name: "Feriale",             color: "#3b82f6", sort_order: 10 },
  { code: "feriale_scolastico", name: "Feriale Scolastico",  color: "#8b5cf6", sort_order: 20 },
  { code: "feriale_estivo",     name: "Feriale Estivo",      color: "#f59e0b", sort_order: 30 },
  { code: "sabato",             name: "Sabato",              color: "#06b6d4", sort_order: 40 },
  { code: "sabato_pre_festivo", name: "Sabato Pre-festivo",  color: "#0ea5e9", sort_order: 50 },
  { code: "festivo",            name: "Festivo",             color: "#ef4444", sort_order: 60 },
  { code: "pre_festivo",        name: "Pre-festivo",         color: "#fb7185", sort_order: 70 },
];

let bootstrapped = false;

async function ensureValidityTables(): Promise<void> {
  if (bootstrapped) return;
  try {
    /* ─── ps_day_types ─── */
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS ps_day_types (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id  uuid REFERENCES ps_projects(id) ON DELETE CASCADE,
        code        text NOT NULL,
        name        text NOT NULL,
        color       text NOT NULL,
        is_system   boolean NOT NULL DEFAULT false,
        is_custom   boolean NOT NULL DEFAULT false,
        sort_order  integer NOT NULL DEFAULT 0,
        created_at  timestamptz NOT NULL DEFAULT now()
      )
    `);
    // UNIQUE su (project_id, code) richiede partial perché Postgres tratta NULL come distinti.
    await db.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_ps_day_types_global_code
        ON ps_day_types (code) WHERE project_id IS NULL
    `);
    await db.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_ps_day_types_project_code
        ON ps_day_types (project_id, code) WHERE project_id IS NOT NULL
    `);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_ps_day_types_project ON ps_day_types(project_id)`);

    /* ─── ps_day_calendar ─── */
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS ps_day_calendar (
        id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id   uuid REFERENCES ps_projects(id) ON DELETE CASCADE,
        date         date NOT NULL,
        day_type_id  uuid NOT NULL REFERENCES ps_day_types(id) ON DELETE RESTRICT,
        source       text NOT NULL DEFAULT 'manual',
        note         text,
        created_at   timestamptz NOT NULL DEFAULT now()
      )
    `);
    await db.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_ps_day_calendar_global
        ON ps_day_calendar (date) WHERE project_id IS NULL
    `);
    await db.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_ps_day_calendar_project
        ON ps_day_calendar (project_id, date) WHERE project_id IS NOT NULL
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS idx_ps_day_calendar_lookup
        ON ps_day_calendar (project_id, date)
    `);

    /* ─── ps_trip_day_validity ─── */
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS ps_trip_day_validity (
        trip_id      uuid NOT NULL REFERENCES ps_trips(id) ON DELETE CASCADE,
        day_type_id  uuid NOT NULL REFERENCES ps_day_types(id) ON DELETE CASCADE,
        is_valid     boolean NOT NULL DEFAULT false,
        updated_at   timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (trip_id, day_type_id)
      )
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS idx_ps_trip_day_validity_trip
        ON ps_trip_day_validity(trip_id)
    `);

    /* ─── ps_projects.agency_settings (per patroni locali ecc.) ─── */
    await db.execute(sql`
      ALTER TABLE ps_projects
        ADD COLUMN IF NOT EXISTS agency_settings jsonb NOT NULL DEFAULT '{}'::jsonb
    `);

    /* ─── Seed system day-types globali ─── */
    for (const dt of SYSTEM_DAY_TYPES) {
      await db.execute(sql`
        INSERT INTO ps_day_types (project_id, code, name, color, is_system, is_custom, sort_order)
        SELECT NULL, ${dt.code}, ${dt.name}, ${dt.color}, true, false, ${dt.sort_order}
        WHERE NOT EXISTS (
          SELECT 1 FROM ps_day_types WHERE project_id IS NULL AND code = ${dt.code}
        )
      `);
    }

    /* ─── Seed festivi nazionali italiani 2024-2030 (project_id NULL) ─── */
    const festivoR = await db.execute(sql`
      SELECT id FROM ps_day_types WHERE project_id IS NULL AND code = 'festivo' LIMIT 1
    `);
    const festivoId: string | undefined = (festivoR as any).rows?.[0]?.id;
    if (festivoId) {
      for (let year = 2024; year <= 2030; year++) {
        for (const date of italianHolidays(year)) {
          await db.execute(sql`
            INSERT INTO ps_day_calendar (project_id, date, day_type_id, source)
            SELECT NULL, ${date}::date, ${festivoId}::uuid, 'holiday_seed'
            WHERE NOT EXISTS (
              SELECT 1 FROM ps_day_calendar
               WHERE project_id IS NULL AND date = ${date}::date
            )
          `);
        }
      }
    }

    bootstrapped = true;
    console.log("[planning-studio.validity] tables ready (PR1)");
  } catch (e: any) {
    console.error("[planning-studio.validity] bootstrap error:", e?.message || e);
    // non rilanciamo: vogliamo che il server continui a partire anche senza DB
  }
}

/* ════════════════════════════════════════════════════════════
 *  Helpers
 * ════════════════════════════════════════════════════════════ */

function getUserId(req: Request): string | null {
  return (req as any).session?.userId ?? (req as any).user?.id ?? null;
}

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

function isValidISODate(s: unknown): s is string {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function isValidHexColor(s: unknown): s is string {
  return typeof s === "string" && /^#[0-9a-fA-F]{6}$/.test(s);
}

function rowToDayType(r: any) {
  return {
    id: r.id,
    projectId: r.project_id,
    code: r.code,
    name: r.name,
    color: r.color,
    isSystem: !!r.is_system,
    isCustom: !!r.is_custom,
    sortOrder: r.sort_order,
    createdAt: r.created_at,
  };
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
    console.warn("[ps-validity] activity log error:", e?.message || e);
  }
}

/** Telemetria strutturata (spec §11.8). */
function telemetry(action: string, projectId: string, extra: Record<string, any> = {}): void {
  console.error(JSON.stringify({
    module: "planner-studio.validity",
    action,
    projectId,
    ...extra,
  }));
}

/* ════════════════════════════════════════════════════════════
 *  Day Types — CRUD
 * ════════════════════════════════════════════════════════════ */

router.get("/planning-studio/projects/:id/day-types", async (req, res): Promise<void> => {
  await ensureValidityTables();
  const userId = getUserId(req);
  if (!userId) { res.status(401).json({ error: "auth required" }); return; }
  const proj = await loadProject(req.params.id, userId, false);
  if (!proj) { res.status(404).json({ error: "project not found" }); return; }

  // System (globali) + custom del progetto, ordinati per sort_order.
  const r = await db.execute(sql`
    SELECT id, project_id, code, name, color, is_system, is_custom, sort_order, created_at
      FROM ps_day_types
     WHERE project_id IS NULL OR project_id = ${req.params.id}::uuid
     ORDER BY sort_order ASC, name ASC
  `);
  const rows: any[] = (r as any).rows ?? [];
  res.json({ dayTypes: rows.map(rowToDayType) });
});

router.post("/planning-studio/projects/:id/day-types", async (req, res): Promise<void> => {
  await ensureValidityTables();
  const userId = getUserId(req);
  if (!userId) { res.status(401).json({ error: "auth required" }); return; }
  const proj = await loadProject(req.params.id, userId, true);
  if (!proj) { res.status(404).json({ error: "project not found or read-only" }); return; }

  const { code, name, color, sort_order } = req.body ?? {};
  if (typeof code !== "string" || !code.trim()) { res.status(400).json({ error: "code required" }); return; }
  if (typeof name !== "string" || !name.trim()) { res.status(400).json({ error: "name required" }); return; }
  if (!isValidHexColor(color)) { res.status(400).json({ error: "color must be #RRGGBB" }); return; }
  if (/^(feriale|feriale_scolastico|feriale_estivo|sabato|sabato_pre_festivo|festivo|pre_festivo)$/.test(code)) {
    res.status(409).json({ error: "code reserved by system day-type" }); return;
  }

  try {
    const r = await db.execute(sql`
      INSERT INTO ps_day_types (project_id, code, name, color, is_system, is_custom, sort_order)
      VALUES (${req.params.id}::uuid, ${code}, ${name}, ${color}, false, true,
              ${typeof sort_order === "number" ? sort_order : 100})
      RETURNING id, project_id, code, name, color, is_system, is_custom, sort_order, created_at
    `);
    const row = (r as any).rows?.[0];
    await logActivity(req.params.id, userId, "validity.day_type.create", "day_type", row.id, { code, name });
    telemetry("day_type.create", req.params.id, { code });
    res.status(201).json({ dayType: rowToDayType(row) });
  } catch (e: any) {
    if (e?.code === "23505") { res.status(409).json({ error: "code already exists in this project" }); return; }
    console.error("[ps-validity] day-type create:", e);
    res.status(500).json({ error: "internal error" });
  }
});

router.patch("/planning-studio/projects/:id/day-types/:dayTypeId", async (req, res): Promise<void> => {
  await ensureValidityTables();
  const userId = getUserId(req);
  if (!userId) { res.status(401).json({ error: "auth required" }); return; }
  const proj = await loadProject(req.params.id, userId, true);
  if (!proj) { res.status(404).json({ error: "project not found or read-only" }); return; }

  const { name, color, sort_order } = req.body ?? {};

  // System day-types: si possono ricolorare/rinominare (non eliminare), MA solo dal proprietario di un progetto?
  // Per semplicità in PR1: system day-types sono GLOBALI e non si toccano dalla UI di un progetto.
  const existR = await db.execute(sql`
    SELECT * FROM ps_day_types WHERE id = ${req.params.dayTypeId}::uuid LIMIT 1
  `);
  const exist: any = (existR as any).rows?.[0];
  if (!exist) { res.status(404).json({ error: "day type not found" }); return; }
  if (exist.is_system) {
    res.status(403).json({ error: "system day-types are read-only in PR1" }); return;
  }
  if (exist.project_id !== req.params.id) {
    res.status(403).json({ error: "day-type belongs to another project" }); return;
  }

  const fields: any[] = [];
  if (typeof name === "string" && name.trim()) fields.push(sql`name = ${name}`);
  if (color !== undefined) {
    if (!isValidHexColor(color)) { res.status(400).json({ error: "color must be #RRGGBB" }); return; }
    fields.push(sql`color = ${color}`);
  }
  if (typeof sort_order === "number") fields.push(sql`sort_order = ${sort_order}`);
  if (fields.length === 0) { res.status(400).json({ error: "no fields to update" }); return; }

  // Drizzle SQL builder: join con virgole.
  const setClause = sql.join(fields, sql`, `);
  const r = await db.execute(sql`
    UPDATE ps_day_types SET ${setClause}
     WHERE id = ${req.params.dayTypeId}::uuid
     RETURNING id, project_id, code, name, color, is_system, is_custom, sort_order, created_at
  `);
  const row = (r as any).rows?.[0];
  await logActivity(req.params.id, userId, "validity.day_type.update", "day_type", req.params.dayTypeId, { name, color });
  telemetry("day_type.update", req.params.id, { dayTypeId: req.params.dayTypeId });
  res.json({ dayType: rowToDayType(row) });
});

router.delete("/planning-studio/projects/:id/day-types/:dayTypeId", async (req, res): Promise<void> => {
  await ensureValidityTables();
  const userId = getUserId(req);
  if (!userId) { res.status(401).json({ error: "auth required" }); return; }
  const proj = await loadProject(req.params.id, userId, true);
  if (!proj) { res.status(404).json({ error: "project not found or read-only" }); return; }

  const existR = await db.execute(sql`
    SELECT * FROM ps_day_types WHERE id = ${req.params.dayTypeId}::uuid LIMIT 1
  `);
  const exist: any = (existR as any).rows?.[0];
  if (!exist) { res.status(404).json({ error: "day type not found" }); return; }
  if (exist.is_system) { res.status(403).json({ error: "cannot delete system day-type" }); return; }
  if (exist.project_id !== req.params.id) { res.status(403).json({ error: "day-type belongs to another project" }); return; }

  // Vincolo: non eliminabile se referenziato da ps_trip_day_validity o ps_day_calendar
  const refR = await db.execute(sql`
    SELECT
      (SELECT COUNT(*) FROM ps_trip_day_validity WHERE day_type_id = ${req.params.dayTypeId}::uuid)::int AS validity_refs,
      (SELECT COUNT(*) FROM ps_day_calendar WHERE day_type_id = ${req.params.dayTypeId}::uuid)::int AS calendar_refs
  `);
  const refs: any = (refR as any).rows?.[0];
  if ((refs.validity_refs > 0) || (refs.calendar_refs > 0)) {
    res.status(409).json({
      error: "day-type is referenced",
      details: { validity_refs: refs.validity_refs, calendar_refs: refs.calendar_refs },
    });
    return;
  }

  await db.execute(sql`DELETE FROM ps_day_types WHERE id = ${req.params.dayTypeId}::uuid`);
  await logActivity(req.params.id, userId, "validity.day_type.delete", "day_type", req.params.dayTypeId, {});
  telemetry("day_type.delete", req.params.id, { dayTypeId: req.params.dayTypeId });
  res.json({ ok: true });
});

/* ════════════════════════════════════════════════════════════
 *  Validity Matrix — bulk read
 * ════════════════════════════════════════════════════════════ */

const MAX_RANGE_DAYS = 540;
const MAX_TRIPS_PER_PAGE = 2000;

router.get("/planning-studio/projects/:id/validity/matrix", async (req, res): Promise<void> => {
  await ensureValidityTables();
  const userId = getUserId(req);
  if (!userId) { res.status(401).json({ error: "auth required" }); return; }
  const proj = await loadProject(req.params.id, userId, false);
  if (!proj) { res.status(404).json({ error: "project not found" }); return; }

  const from = req.query.from;
  const to = req.query.to;
  if (!isValidISODate(from) || !isValidISODate(to)) {
    res.status(400).json({ error: "from/to must be YYYY-MM-DD" }); return;
  }
  if (from > to) {
    res.status(400).json({ error: "from must be <= to" }); return;
  }
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  const spanDays = Math.round((toMs - fromMs) / 86_400_000) + 1;
  if (spanDays > MAX_RANGE_DAYS) {
    res.status(400).json({ error: `range too large: ${spanDays} > ${MAX_RANGE_DAYS} days` }); return;
  }

  // Trip count + cap. Se troppe, paginazione per route_id.
  const countR = await db.execute(sql`
    SELECT COUNT(*)::int AS c FROM ps_trips WHERE project_id = ${req.params.id}::uuid
  `);
  const tripCount: number = (countR as any).rows?.[0]?.c ?? 0;
  if (tripCount > MAX_TRIPS_PER_PAGE) {
    res.status(400).json({
      error: `too many trips: ${tripCount} > ${MAX_TRIPS_PER_PAGE}. Add ?route_id=... to paginate.`,
    });
    return;
  }

  // Trips ordinate per linea + prima fermata (per render UI raggruppato).
  // departure_time della prima fermata = MIN(stop_seq).
  const tripsR = await db.execute(sql`
    SELECT t.id, t.route_id, t.variant_id, t.headsign, t.short_name, t.direction,
           t.valid_from::text AS valid_from, t.valid_to::text AS valid_to, t.is_active,
           t.service_label,
           r.short_name AS route_short_name, r.long_name AS route_long_name, r.color AS route_color,
           v.name AS variant_name,
           (SELECT departure_time FROM ps_stop_times st
             WHERE st.trip_id = t.id ORDER BY st.stop_seq ASC LIMIT 1) AS first_departure
      FROM ps_trips t
      JOIN ps_routes r ON r.id = t.route_id
      JOIN ps_route_variants v ON v.id = t.variant_id
     WHERE t.project_id = ${req.params.id}::uuid
     ORDER BY r.short_name ASC NULLS LAST, r.long_name ASC NULLS LAST,
              v.name ASC, first_departure ASC NULLS LAST
  `);
  const trips = ((tripsR as any).rows ?? []).map((t: any) => ({
    id: t.id,
    routeId: t.route_id,
    variantId: t.variant_id,
    routeShortName: t.route_short_name,
    routeLongName: t.route_long_name,
    routeColor: t.route_color,
    variantName: t.variant_name,
    headsign: t.headsign,
    shortName: t.short_name,
    direction: t.direction,
    validFrom: t.valid_from,
    validTo: t.valid_to,
    isActive: !!t.is_active,
    serviceLabel: t.service_label,
    firstDeparture: t.first_departure,
  }));

  // Day-types: system globali + custom del progetto.
  const dtR = await db.execute(sql`
    SELECT id, project_id, code, name, color, is_system, is_custom, sort_order, created_at
      FROM ps_day_types
     WHERE project_id IS NULL OR project_id = ${req.params.id}::uuid
     ORDER BY sort_order ASC, name ASC
  `);
  const dayTypes = ((dtR as any).rows ?? []).map(rowToDayType);

  // Day calendar: globale (project_id NULL) + override progetto, SOLO nel range.
  const dcR = await db.execute(sql`
    SELECT date::text AS date, day_type_id, project_id, source, note
      FROM ps_day_calendar
     WHERE (project_id IS NULL OR project_id = ${req.params.id}::uuid)
       AND date >= ${from}::date AND date <= ${to}::date
     ORDER BY date ASC, project_id NULLS FIRST
  `);
  // Se per la stessa data ci sono entrambi (globale + project), il project vince.
  const dayCalendarMap = new Map<string, any>();
  for (const r of ((dcR as any).rows ?? [])) {
    const cur = dayCalendarMap.get(r.date);
    if (!cur || r.project_id != null) dayCalendarMap.set(r.date, r);
  }
  const dayCalendar = Array.from(dayCalendarMap.values()).map((r: any) => ({
    date: r.date,
    dayTypeId: r.day_type_id,
    scope: r.project_id == null ? "tenant" : "project",
    source: r.source,
    note: r.note,
  }));

  // Trip × day-type validity (default).
  const tdvR = await db.execute(sql`
    SELECT v.trip_id, v.day_type_id, v.is_valid
      FROM ps_trip_day_validity v
      JOIN ps_trips t ON t.id = v.trip_id
     WHERE t.project_id = ${req.params.id}::uuid
  `);
  const tripDayValidity = ((tdvR as any).rows ?? []).map((r: any) => ({
    tripId: r.trip_id,
    dayTypeId: r.day_type_id,
    isValid: !!r.is_valid,
  }));

  // Eccezioni puntuali nel range.
  const teR = await db.execute(sql`
    SELECT e.trip_id, e.date::text AS date, e.exception_type, e.reason
      FROM ps_trip_exceptions e
      JOIN ps_trips t ON t.id = e.trip_id
     WHERE t.project_id = ${req.params.id}::uuid
       AND e.date >= ${from}::date AND e.date <= ${to}::date
  `);
  const tripExceptions = ((teR as any).rows ?? []).map((r: any) => ({
    tripId: r.trip_id,
    date: r.date,
    exceptionType: r.exception_type as 1 | 2,
    reason: r.reason,
  }));

  // Patroni locali → da agency_settings del progetto.
  const patronSaints: string[] = (() => {
    const settings = proj.agency_settings ?? {};
    const arr = Array.isArray(settings?.patron_saints) ? settings.patron_saints : [];
    const out: string[] = [];
    for (const p of arr) {
      if (p && typeof p.date === "string" && /^\d{2}-\d{2}$/.test(p.date)) out.push(p.date);
    }
    return out;
  })();

  telemetry("matrix.read", req.params.id, { from, to, tripCount, days: spanDays });

  res.json({
    range: { from, to },
    trips,
    dayTypes,
    dayCalendar,
    tripDayValidity,
    tripExceptions,
    patronSaints,
  });
});

/* ════════════════════════════════════════════════════════════
 *  Validity — singole mutation (PUT idempotenti)
 * ════════════════════════════════════════════════════════════ */

router.put("/planning-studio/projects/:id/validity/trip-day", async (req, res): Promise<void> => {
  await ensureValidityTables();
  const userId = getUserId(req);
  if (!userId) { res.status(401).json({ error: "auth required" }); return; }
  const proj = await loadProject(req.params.id, userId, true);
  if (!proj) { res.status(404).json({ error: "project not found or read-only" }); return; }

  const { trip_id, day_type_id, is_valid } = req.body ?? {};
  if (typeof trip_id !== "string" || typeof day_type_id !== "string" || typeof is_valid !== "boolean") {
    res.status(400).json({ error: "trip_id, day_type_id, is_valid required" }); return;
  }

  // Verifica trip appartiene al progetto.
  const ownR = await db.execute(sql`
    SELECT 1 FROM ps_trips WHERE id = ${trip_id}::uuid AND project_id = ${req.params.id}::uuid
  `);
  if (((ownR as any).rows ?? []).length === 0) {
    res.status(404).json({ error: "trip not in project" }); return;
  }

  // Verifica day_type accessibile (system globale o custom del progetto).
  const dtOwnR = await db.execute(sql`
    SELECT 1 FROM ps_day_types
     WHERE id = ${day_type_id}::uuid AND (project_id IS NULL OR project_id = ${req.params.id}::uuid)
  `);
  if (((dtOwnR as any).rows ?? []).length === 0) {
    res.status(404).json({ error: "day-type not accessible" }); return;
  }

  await db.execute(sql`
    INSERT INTO ps_trip_day_validity (trip_id, day_type_id, is_valid, updated_at)
    VALUES (${trip_id}::uuid, ${day_type_id}::uuid, ${is_valid}, now())
    ON CONFLICT (trip_id, day_type_id) DO UPDATE
      SET is_valid = EXCLUDED.is_valid, updated_at = now()
  `);

  telemetry("trip_day.upsert", req.params.id, { tripId: trip_id, dayTypeId: day_type_id, isValid: is_valid });
  res.json({ ok: true });
});

router.put("/planning-studio/projects/:id/validity/day-calendar", async (req, res): Promise<void> => {
  await ensureValidityTables();
  const userId = getUserId(req);
  if (!userId) { res.status(401).json({ error: "auth required" }); return; }
  const proj = await loadProject(req.params.id, userId, true);
  if (!proj) { res.status(404).json({ error: "project not found or read-only" }); return; }

  const { date, day_type_id, scope, note } = req.body ?? {};
  if (!isValidISODate(date)) { res.status(400).json({ error: "date must be YYYY-MM-DD" }); return; }
  if (typeof day_type_id !== "string") { res.status(400).json({ error: "day_type_id required" }); return; }
  const useGlobal = scope === "tenant";

  // Verifica day_type accessibile.
  const dtOwnR = await db.execute(sql`
    SELECT 1 FROM ps_day_types
     WHERE id = ${day_type_id}::uuid AND (project_id IS NULL OR project_id = ${req.params.id}::uuid)
  `);
  if (((dtOwnR as any).rows ?? []).length === 0) {
    res.status(404).json({ error: "day-type not accessible" }); return;
  }

  if (useGlobal) {
    await db.execute(sql`
      INSERT INTO ps_day_calendar (project_id, date, day_type_id, source, note)
      VALUES (NULL, ${date}::date, ${day_type_id}::uuid, 'manual', ${note ?? null})
      ON CONFLICT (date) WHERE project_id IS NULL DO UPDATE
        SET day_type_id = EXCLUDED.day_type_id, source = 'manual', note = EXCLUDED.note
    `);
  } else {
    await db.execute(sql`
      INSERT INTO ps_day_calendar (project_id, date, day_type_id, source, note)
      VALUES (${req.params.id}::uuid, ${date}::date, ${day_type_id}::uuid, 'manual', ${note ?? null})
      ON CONFLICT (project_id, date) WHERE project_id IS NOT NULL DO UPDATE
        SET day_type_id = EXCLUDED.day_type_id, source = 'manual', note = EXCLUDED.note
    `);
  }

  telemetry("day_calendar.upsert", req.params.id, { date, dayTypeId: day_type_id, scope: useGlobal ? "tenant" : "project" });
  res.json({ ok: true });
});

router.put("/planning-studio/projects/:id/validity/exception", async (req, res): Promise<void> => {
  await ensureValidityTables();
  const userId = getUserId(req);
  if (!userId) { res.status(401).json({ error: "auth required" }); return; }
  const proj = await loadProject(req.params.id, userId, true);
  if (!proj) { res.status(404).json({ error: "project not found or read-only" }); return; }

  const { trip_id, date, exception_type, reason } = req.body ?? {};
  if (typeof trip_id !== "string") { res.status(400).json({ error: "trip_id required" }); return; }
  if (!isValidISODate(date)) { res.status(400).json({ error: "date must be YYYY-MM-DD" }); return; }
  if (exception_type !== 1 && exception_type !== 2) {
    res.status(400).json({ error: "exception_type must be 1 (add) or 2 (remove)" }); return;
  }

  const ownR = await db.execute(sql`
    SELECT 1 FROM ps_trips WHERE id = ${trip_id}::uuid AND project_id = ${req.params.id}::uuid
  `);
  if (((ownR as any).rows ?? []).length === 0) {
    res.status(404).json({ error: "trip not in project" }); return;
  }

  await db.execute(sql`
    INSERT INTO ps_trip_exceptions (trip_id, date, exception_type, reason)
    VALUES (${trip_id}::uuid, ${date}::date, ${exception_type}, ${reason ?? null})
    ON CONFLICT (trip_id, date) DO UPDATE
      SET exception_type = EXCLUDED.exception_type, reason = EXCLUDED.reason
  `);

  telemetry("exception.upsert", req.params.id, { tripId: trip_id, date, exceptionType: exception_type });
  res.json({ ok: true });
});

/** DELETE eccezione — utile per "ripristinare default" su una cella. */
router.delete("/planning-studio/projects/:id/validity/exception", async (req, res): Promise<void> => {
  await ensureValidityTables();
  const userId = getUserId(req);
  if (!userId) { res.status(401).json({ error: "auth required" }); return; }
  const proj = await loadProject(req.params.id, userId, true);
  if (!proj) { res.status(404).json({ error: "project not found or read-only" }); return; }

  const { trip_id, date } = req.body ?? {};
  if (typeof trip_id !== "string" || !isValidISODate(date)) {
    res.status(400).json({ error: "trip_id and date required" }); return;
  }

  const ownR = await db.execute(sql`
    SELECT 1 FROM ps_trips WHERE id = ${trip_id}::uuid AND project_id = ${req.params.id}::uuid
  `);
  if (((ownR as any).rows ?? []).length === 0) {
    res.status(404).json({ error: "trip not in project" }); return;
  }

  await db.execute(sql`
    DELETE FROM ps_trip_exceptions
     WHERE trip_id = ${trip_id}::uuid AND date = ${date}::date
  `);

  telemetry("exception.delete", req.params.id, { tripId: trip_id, date });
  res.json({ ok: true });
});

export default router;
