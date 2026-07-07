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
import { loadCalendarProfile } from "./planning-studio-calendar";
import { classifyDate, italianHolidays as classifierHolidays } from "./day-classifier";

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
  { code: "festivo", name: "Festivo", color: "#ef4444", sort_order: 10 },
  { code: "sabato",  name: "Sabato",  color: "#06b6d4", sort_order: 20 },
  { code: "feriale", name: "Feriale", color: "#3b82f6", sort_order: 30 },
];

/** Codici di sistema "legacy" rimossi: cleanup non distruttivo se orfani. */
const LEGACY_SYSTEM_DAY_TYPE_CODES = [
  "feriale_scolastico",
  "feriale_estivo",
  "sabato_pre_festivo",
  "pre_festivo",
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

    /* ─── scheduling_projects.validity_filter (PR4) ───
     * Filtro snapshot al momento della generazione dell'Unità di Progettazione:
     * { from, to, dayTypeIds[], includeOnlyValid } */
    await db.execute(sql`
      ALTER TABLE IF EXISTS scheduling_projects
        ADD COLUMN IF NOT EXISTS validity_filter jsonb
    `);

    /* ─── Vincolo corsa ↔ categorie di validità (calendario aziendale):
       se una corsa ha ≥1 categorie, vale SOLO nei giorni con quella categoria ─── */
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS ps_trip_category_validity (
        trip_id     uuid NOT NULL,
        category_id uuid NOT NULL,
        PRIMARY KEY (trip_id, category_id)
      )
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
      // Aggiorna sort_order/colori se già esistenti (per allineare al nuovo schema)
      await db.execute(sql`
        UPDATE ps_day_types
           SET name = ${dt.name}, color = ${dt.color}, sort_order = ${dt.sort_order}, is_system = true
         WHERE project_id IS NULL AND code = ${dt.code}
      `);
    }

    /* ─── Cleanup system day-types legacy (solo se orfani) ─── */
    for (const legacyCode of LEGACY_SYSTEM_DAY_TYPE_CODES) {
      try {
        await db.execute(sql`
          DELETE FROM ps_day_types
           WHERE project_id IS NULL
             AND code = ${legacyCode}
             AND is_system = true
             AND NOT EXISTS (
               SELECT 1 FROM ps_trip_day_validity v WHERE v.day_type_id = ps_day_types.id
             )
             AND NOT EXISTS (
               SELECT 1 FROM ps_day_calendar c WHERE c.day_type_id = ps_day_types.id
             )
        `);
      } catch (e: any) {
        console.warn(`[ps-validity] cleanup legacy '${legacyCode}' skipped:`, e?.message || e);
      }
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
       AND (
         p.owner_user_id = ${userId}::uuid
         OR pm.user_id IS NOT NULL
         OR (p.materialized_feed_id IS NOT NULL
             AND EXISTS (SELECT 1 FROM gtfs_feeds gf
                          WHERE gf.id = p.materialized_feed_id AND gf.is_active = true))
       )
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

/* GET /validity/routes — lista linee con conteggio corse, per popolare il
 * dropdown del filtro UI quando la matrice è troppo grande. */
router.get("/planning-studio/projects/:id/validity/routes", async (req, res): Promise<void> => {
  await ensureValidityTables();
  const userId = getUserId(req);
  if (!userId) { res.status(401).json({ error: "auth required" }); return; }
  const proj = await loadProject(req.params.id, userId, false);
  if (!proj) { res.status(404).json({ error: "project not found" }); return; }
  const r = await db.execute(sql`
    SELECT r.id, r.short_name, r.long_name, r.color,
           COUNT(t.id)::int AS trip_count
      FROM ps_routes r
      LEFT JOIN ps_trips t ON t.route_id = r.id AND t.project_id = ${req.params.id}::uuid
     WHERE r.project_id = ${req.params.id}::uuid
     GROUP BY r.id, r.short_name, r.long_name, r.color
     ORDER BY r.short_name ASC NULLS LAST, r.long_name ASC NULLS LAST
  `);
  const routes = ((r as any).rows ?? []).map((x: any) => ({
    id: x.id,
    shortName: x.short_name,
    longName: x.long_name,
    color: x.color,
    tripCount: x.trip_count,
  }));
  res.json({ routes });
});

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
  // Filtro opzionale per linea (UI deve passarlo se c'è troppo)
  const routeIdRaw = req.query.route_id;
  const routeId = typeof routeIdRaw === "string" && /^[0-9a-f-]{36}$/i.test(routeIdRaw)
    ? routeIdRaw : null;

  const countR = await db.execute(sql`
    SELECT COUNT(*)::int AS c FROM ps_trips
     WHERE project_id = ${req.params.id}::uuid
       AND (${routeId}::uuid IS NULL OR route_id = ${routeId}::uuid)
  `);
  const tripCount: number = (countR as any).rows?.[0]?.c ?? 0;
  if (tripCount > MAX_TRIPS_PER_PAGE) {
    res.status(400).json({
      error: `too many trips: ${tripCount} > ${MAX_TRIPS_PER_PAGE}. Add ?route_id=... to paginate.`,
      tripCount,
      maxTripsPerPage: MAX_TRIPS_PER_PAGE,
      needsRouteFilter: true,
    });
    return;
  }

  // Trips ordinate per linea + prima fermata (per render UI raggruppato).
  // departure_time della prima fermata = MIN(stop_seq).
  const tripsR = await db.execute(sql`
    SELECT t.id, t.route_id, t.variant_id, t.headsign, t.short_name, t.direction,
           t.valid_from::text AS valid_from, t.valid_to::text AS valid_to, t.is_active,
           t.service_label, t.attributes,
           r.short_name AS route_short_name, r.long_name AS route_long_name, r.color AS route_color,
           v.name AS variant_name,
           (SELECT departure_time FROM ps_stop_times st
             WHERE st.trip_id = t.id ORDER BY st.stop_seq ASC LIMIT 1) AS first_departure,
           (SELECT s.name FROM ps_stop_times st JOIN ps_stops s ON s.id = st.stop_id
             WHERE st.trip_id = t.id ORDER BY st.stop_seq ASC LIMIT 1) AS first_stop_name,
           (SELECT s.name FROM ps_stop_times st JOIN ps_stops s ON s.id = st.stop_id
             WHERE st.trip_id = t.id ORDER BY st.stop_seq DESC LIMIT 1) AS last_stop_name
      FROM ps_trips t
      JOIN ps_routes r ON r.id = t.route_id
      JOIN ps_route_variants v ON v.id = t.variant_id
     WHERE t.project_id = ${req.params.id}::uuid
       AND (${routeId}::uuid IS NULL OR t.route_id = ${routeId}::uuid)
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
    weekdays: Array.isArray(t.attributes?.weekdays) && t.attributes.weekdays.length === 7
      ? t.attributes.weekdays.map((x: any) => x !== false)
      : null,
    onDemand: !!t.attributes?.onDemand,
    firstDeparture: t.first_departure,
    firstStopName: t.first_stop_name,
    lastStopName: t.last_stop_name,
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

  // Vincolo categorie (calendario aziendale) per corsa.
  const tcvR = await db.execute(sql`
    SELECT v.trip_id, v.category_id
      FROM ps_trip_category_validity v
      JOIN ps_trips t ON t.id = v.trip_id
     WHERE t.project_id = ${req.params.id}::uuid
  `);
  const tripCategoryValidity = ((tcvR as any).rows ?? []).map((r: any) => ({
    tripId: r.trip_id,
    categoryId: r.category_id,
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
    tripCategoryValidity,
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

/* ════════════════════════════════════════════════════════════
 *  Bulk operations (PR3)
 * ════════════════════════════════════════════════════════════
 *
 * Body forme accettate (discriminato per `op`):
 *
 *   { op: "trip-row-set",  tripId, dayTypeIds[], isValid }
 *     → upsert ps_trip_day_validity per (trip × ognuno dei dayTypes)
 *
 *   { op: "date-column-set", date, isValid }
 *     → forza eccezione (1=add, 2=remove) su tutti i trip del progetto per quella data
 *
 *   { op: "clear-exceptions", from, to, tripIds? }
 *     → DELETE ps_trip_exceptions per tutti i trip nel range
 *       (opzionale filtro tripIds)
 */
router.post("/planning-studio/projects/:id/validity/bulk", async (req, res): Promise<void> => {
  await ensureValidityTables();
  const userId = getUserId(req);
  if (!userId) { res.status(401).json({ error: "auth required" }); return; }
  const proj = await loadProject(req.params.id, userId, true);
  if (!proj) { res.status(404).json({ error: "project not found or read-only" }); return; }

  const body = req.body ?? {};
  const op = body.op;

  try {
    if (op === "trip-row-set") {
      const { dayTypeIds, isValid } = body;
      // Retro-compatibile: tripId singolo OPPURE tripIds[] (es. corse generate a cadenza).
      const UUID_RX = /^[0-9a-f-]{36}$/i;
      const tripIds: string[] = (Array.isArray(body.tripIds) ? body.tripIds : [body.tripId])
        .filter((x: any) => typeof x === "string" && UUID_RX.test(x));
      if (tripIds.length === 0 || !Array.isArray(dayTypeIds) || typeof isValid !== "boolean") {
        res.status(400).json({ error: "tripId|tripIds[], dayTypeIds[], isValid required" }); return;
      }
      const ownR = await db.execute(sql`
        SELECT count(*)::int AS c FROM ps_trips
         WHERE id = ANY(${`{${tripIds.join(",")}}`}::uuid[]) AND project_id = ${req.params.id}::uuid
      `);
      if (Number(((ownR as any).rows ?? [])[0]?.c) !== tripIds.length) {
        res.status(404).json({ error: "trip not in project" }); return;
      }
      let count = 0;
      for (const tripId of tripIds) {
        for (const dtId of dayTypeIds) {
          if (typeof dtId !== "string") continue;
          await db.execute(sql`
            INSERT INTO ps_trip_day_validity (trip_id, day_type_id, is_valid, updated_at)
            VALUES (${tripId}::uuid, ${dtId}::uuid, ${isValid}, now())
            ON CONFLICT (trip_id, day_type_id) DO UPDATE
              SET is_valid = EXCLUDED.is_valid, updated_at = now()
          `);
          count++;
        }
      }
      await logActivity(req.params.id, userId, "validity.bulk.trip-row", "trip", tripIds[0], { count, isValid, trips: tripIds.length });
      telemetry("bulk.trip-row", req.params.id, { tripId: tripIds[0], count, isValid });
      res.json({ ok: true, count });
      return;
    }

    if (op === "trip-categories-set") {
      // mode "replace" (default): sostituisce il set di categorie delle corse;
      // mode "add": AGGIUNGE le categorie a quelle già presenti (proroga, es.
      // corsa nata "scuole chiuse" estesa anche a un'altra categoria).
      // categoryIds vuoto con replace = nessun vincolo (vale in ogni periodo).
      const UUID_RX = /^[0-9a-f-]{36}$/i;
      const tripIds: string[] = (Array.isArray(body.tripIds) ? body.tripIds : [body.tripId])
        .filter((x: any) => typeof x === "string" && UUID_RX.test(x));
      const categoryIds: string[] = (Array.isArray(body.categoryIds) ? body.categoryIds : [])
        .filter((x: any) => typeof x === "string" && UUID_RX.test(x));
      if (tripIds.length === 0) { res.status(400).json({ error: "tripIds[] required" }); return; }
      const ownR = await db.execute(sql`
        SELECT count(*)::int AS c FROM ps_trips
         WHERE id = ANY(${`{${tripIds.join(",")}}`}::uuid[]) AND project_id = ${req.params.id}::uuid
      `);
      if (Number(((ownR as any).rows ?? [])[0]?.c) !== tripIds.length) {
        res.status(404).json({ error: "trip not in project" }); return;
      }
      const mode = body.mode === "add" ? "add" : "replace";
      if (mode === "replace") {
        await db.execute(sql`
          DELETE FROM ps_trip_category_validity WHERE trip_id = ANY(${`{${tripIds.join(",")}}`}::uuid[])
        `);
      }
      let count = 0;
      for (const tripId of tripIds) {
        for (const catId of categoryIds) {
          await db.execute(sql`
            INSERT INTO ps_trip_category_validity (trip_id, category_id)
            VALUES (${tripId}::uuid, ${catId}::uuid)
            ON CONFLICT DO NOTHING
          `);
          count++;
        }
      }
      await logActivity(req.params.id, userId, "validity.bulk.trip-categories", "trip", tripIds[0], { trips: tripIds.length, categories: categoryIds.length });
      telemetry("bulk.trip-categories", req.params.id, { trips: tripIds.length, categories: categoryIds.length });
      res.json({ ok: true, count });
      return;
    }

    if (op === "date-column-set") {
      const { date, isValid } = body;
      if (!isValidISODate(date) || typeof isValid !== "boolean") {
        res.status(400).json({ error: "date (YYYY-MM-DD), isValid required" }); return;
      }
      const exceptionType = isValid ? 1 : 2;
      const r = await db.execute(sql`
        INSERT INTO ps_trip_exceptions (trip_id, date, exception_type, reason)
        SELECT id, ${date}::date, ${exceptionType}, 'bulk:date-column'
          FROM ps_trips WHERE project_id = ${req.params.id}::uuid
        ON CONFLICT (trip_id, date) DO UPDATE
          SET exception_type = EXCLUDED.exception_type, reason = EXCLUDED.reason
      `);
      const count = (r as any).rowCount ?? 0;
      await logActivity(req.params.id, userId, "validity.bulk.date-column", null, null, { date, isValid, count });
      telemetry("bulk.date-column", req.params.id, { date, isValid, count });
      res.json({ ok: true, count });
      return;
    }

    if (op === "clear-exceptions") {
      const { from, to, tripIds } = body;
      if (!isValidISODate(from) || !isValidISODate(to)) {
        res.status(400).json({ error: "from, to (YYYY-MM-DD) required" }); return;
      }
      let r;
      if (Array.isArray(tripIds) && tripIds.length > 0) {
        // Validate all UUIDs are strings; SQL injection safe via parameterization.
        // Postgres array literal: drizzle espande gli array JS come tupla
        // ($1,$2,...) non castabile a uuid[]. Passiamo un singolo literal.
        const tripIdsLiteral = `{${tripIds.map(String).join(",")}}`;
        r = await db.execute(sql`
          DELETE FROM ps_trip_exceptions e
           USING ps_trips t
           WHERE e.trip_id = t.id
             AND t.project_id = ${req.params.id}::uuid
             AND e.date >= ${from}::date AND e.date <= ${to}::date
             AND e.trip_id = ANY(${tripIdsLiteral}::uuid[])
        `);
      } else {
        r = await db.execute(sql`
          DELETE FROM ps_trip_exceptions e
           USING ps_trips t
           WHERE e.trip_id = t.id
             AND t.project_id = ${req.params.id}::uuid
             AND e.date >= ${from}::date AND e.date <= ${to}::date
        `);
      }
      const count = (r as any).rowCount ?? 0;
      await logActivity(req.params.id, userId, "validity.bulk.clear-exceptions", null, null, { from, to, count });
      telemetry("bulk.clear-exceptions", req.params.id, { from, to, count });
      res.json({ ok: true, count });
      return;
    }

    res.status(400).json({ error: `unknown op: ${op}` });
  } catch (e: any) {
    console.error("[ps-validity] bulk error:", e);
    res.status(500).json({ error: e?.message || "internal error" });
  }
});

/* ════════════════════════════════════════════════════════════
 *  Auto-import da GTFS calendars (PR3)
 * ════════════════════════════════════════════════════════════
 *
 * Strategia:
 *   Per ogni ps_calendar del progetto:
 *     - Mappa la pattern dei giorni (mon..sun) ai system day-types:
 *         mon/tue/wed/thu/fri  → "feriale"
 *         saturday             → "sabato"
 *         sunday               → "festivo"
 *       (i custom non vengono toccati, l'utente può raffinare poi)
 *     - Per ogni trip che ha calendar_id = X, set ps_trip_day_validity
 *       per quei day-types a true (UPSERT).
 *     - Per ogni ps_calendar_dates con exception_type=2 (remove):
 *         INSERT ps_trip_exceptions (trip, date, 2)
 *       Per exception_type=1 (add):
 *         INSERT ps_trip_exceptions (trip, date, 1)
 *
 *   Il preview mode (?preview=1) restituisce solo i count senza scrivere.
 *
 * Body opzionale: { dryRun?: boolean }
 */
router.post("/planning-studio/projects/:id/validity/auto-import-from-calendars", async (req, res): Promise<void> => {
  await ensureValidityTables();
  const userId = getUserId(req);
  if (!userId) { res.status(401).json({ error: "auth required" }); return; }
  const proj = await loadProject(req.params.id, userId, true);
  if (!proj) { res.status(404).json({ error: "project not found or read-only" }); return; }

  const dryRun: boolean = !!req.body?.dryRun || req.query.preview === "1";

  try {
    const result = await runValidityAutoImportFromCalendars(req.params.id, { dryRun });
    if (!dryRun) {
      await logActivity(req.params.id, userId, "validity.auto-import", null, null, {
        calendars: result.summary.calendars,
        validityUpserts: result.summary.validityUpserts,
        exceptionInserts: result.summary.exceptionInserts,
      });
    }
    telemetry("auto-import", req.params.id, { dryRun, ...result.summary });
    res.json({ ok: true, dryRun, ...result });
  } catch (e: any) {
    if (e?.code === "SYSTEM_DAY_TYPES_MISSING") {
      res.status(500).json({ error: "system day-types missing (feriale/sabato/festivo)" });
      return;
    }
    console.error("[ps-validity] auto-import error:", e);
    res.status(500).json({ error: e?.message || "internal error" });
  }
});

/**
 * Logica core dell'auto-import GTFS → matrice di validità.
 * Esportata per essere richiamata anche dalla pipeline di import GTFS
 * subito dopo la creazione di ps_calendars/ps_trips.
 *
 * Ritorna { summary, perCalendar }.
 *
 * Throws con code='SYSTEM_DAY_TYPES_MISSING' se mancano i day-type di sistema.
 */
export async function runValidityAutoImportFromCalendars(
  projectId: string,
  opts: { dryRun?: boolean } = {},
): Promise<{
  summary: {
    calendars: number; validityUpserts: number; exceptionInserts: number;
    categoryDates: number; tripCategoryUpserts: number; tripsWithCategories: number;
  };
  perCalendar: Array<{
    calendarId: string;
    calendarCode: string;
    tripCount: number;
    dayTypeCount: number;
    validityRowsToWrite: number;
    exceptionRowsToWrite: number;
  }>;
}> {
  await ensureValidityTables();
  const dryRun = !!opts.dryRun;

  // Lookup id system day-types richiesti
  const dtR = await db.execute(sql`
    SELECT id, code FROM ps_day_types
     WHERE project_id IS NULL AND code IN ('feriale', 'sabato', 'festivo')
  `);
  const dtMap = new Map<string, string>();
  for (const r of ((dtR as any).rows ?? [])) dtMap.set(r.code, r.id);
  if (dtMap.size < 3) {
    const err: any = new Error("system day-types missing");
    err.code = "SYSTEM_DAY_TYPES_MISSING";
    throw err;
  }

  // Calendars del progetto
  const calsR = await db.execute(sql`
    SELECT c.id, c.code, c.name, c.monday, c.tuesday, c.wednesday, c.thursday, c.friday,
           c.saturday, c.sunday, c.start_date::text AS start_date, c.end_date::text AS end_date
      FROM ps_calendars c WHERE c.project_id = ${projectId}::uuid
  `);
  const cals: any[] = (calsR as any).rows ?? [];

  let validityUpserts = 0;
  let exceptionInserts = 0;
  const perCalendar: any[] = [];

  for (const c of cals) {
    const dayTypeIds: string[] = [];
    if (c.monday || c.tuesday || c.wednesday || c.thursday || c.friday) dayTypeIds.push(dtMap.get("feriale")!);
    if (c.saturday) dayTypeIds.push(dtMap.get("sabato")!);
    if (c.sunday)   dayTypeIds.push(dtMap.get("festivo")!);

    const tripsR = await db.execute(sql`
      SELECT id FROM ps_trips WHERE calendar_id = ${c.id}::uuid AND project_id = ${projectId}::uuid
    `);
    const tripIds: string[] = ((tripsR as any).rows ?? []).map((r: any) => r.id);

    const cdR = await db.execute(sql`
      SELECT date::text AS date, exception_type FROM ps_calendar_dates WHERE calendar_id = ${c.id}::uuid
    `);
    const cdates: { date: string; exception_type: number }[] = (cdR as any).rows ?? [];

    perCalendar.push({
      calendarId: c.id,
      calendarCode: c.code,
      tripCount: tripIds.length,
      dayTypeCount: dayTypeIds.length,
      validityRowsToWrite: tripIds.length * dayTypeIds.length,
      exceptionRowsToWrite: tripIds.length * cdates.length,
    });

    if (!dryRun) {
      for (const tid of tripIds) {
        for (const dtId of dayTypeIds) {
          await db.execute(sql`
            INSERT INTO ps_trip_day_validity (trip_id, day_type_id, is_valid, updated_at)
            VALUES (${tid}::uuid, ${dtId}::uuid, true, now())
            ON CONFLICT (trip_id, day_type_id) DO UPDATE
              SET is_valid = true, updated_at = now()
          `);
          validityUpserts++;
        }
        await db.execute(sql`
          UPDATE ps_trips
             SET valid_from = COALESCE(valid_from, ${c.start_date}::date),
                 valid_to   = COALESCE(valid_to,   ${c.end_date}::date)
           WHERE id = ${tid}::uuid
        `);
        for (const cd of cdates) {
          const exType = cd.exception_type === 1 ? 1 : 2;
          await db.execute(sql`
            INSERT INTO ps_trip_exceptions (trip_id, date, exception_type, reason)
            VALUES (${tid}::uuid, ${cd.date}::date, ${exType}, 'auto-import:calendar')
            ON CONFLICT (trip_id, date) DO UPDATE
              SET exception_type = EXCLUDED.exception_type, reason = EXCLUDED.reason
          `);
          exceptionInserts++;
        }
      }
    }
  }

  // ── Intreccio col Calendario Aziendale ──
  // Deriva il calendario delle categorie (Scuole Aperte/Chiuse/Festività) dal
  // profilo aziendale e assegna a ogni corsa le categorie dei periodi in cui
  // circola davvero. Così filtro Corse, colonna Categorie, Matrice e UDP
  // parlano la stessa lingua senza compilazioni manuali.
  const catSync = await syncValidityCategoriesFromProfile(projectId, { dryRun });

  return {
    summary: {
      calendars: cals.length, validityUpserts, exceptionInserts,
      categoryDates: catSync.categoryDates,
      tripCategoryUpserts: catSync.tripCategoryUpserts,
      tripsWithCategories: catSync.tripsWithCategories,
    },
    perCalendar,
  };
}

/* ════════════════════════════════════════════════════════════
 *  Sincronizzazione categorie ← Calendario Aziendale
 *  ────────────────────────────────────────────────────────────
 *  1. Classifica ogni data del range dei calendari del progetto con il
 *     day-classifier (profilo aziendale: periodi scuole chiuse + festivi):
 *     scuole_aperte | scuole_chiuse | festivo.
 *  2. Upsert in ps_validity_category_calendar (categoria per data) —
 *     è la tabella usata dalle UDP per il validity_id.
 *  3. Per ogni corsa calcola i giorni di circolazione reali (pattern del
 *     calendario ∩ validità ∩ eccezioni calendario/corsa) e SOSTITUISCE le
 *     assegnazioni in ps_trip_category_validity con le categorie dei periodi
 *     effettivamente toccati. Alimenta filtro e colonna "Categorie" in Corse.
 * ════════════════════════════════════════════════════════════ */

const CLASS_TO_CATEGORY_CODE: Record<string, string> = {
  scuole_aperte: "scuole_aperte",
  scuole_chiuse: "scuole_chiuse",
  festivo: "festivita",
};

const SEED_VALIDITY_CATEGORIES = [
  { code: "scuole_aperte", name: "Scuole Aperte", color: "#3b82f6", sort: 10 },
  { code: "scuole_chiuse", name: "Scuole Chiuse", color: "#f59e0b", sort: 20 },
  { code: "festivita",     name: "Festività",     color: "#ef4444", sort: 30 },
];

export async function syncValidityCategoriesFromProfile(
  projectId: string,
  opts: { dryRun?: boolean; onlyTripIds?: string[] } = {},
): Promise<{ categoryDates: number; tripCategoryUpserts: number; tripsWithCategories: number; from: string | null; to: string | null }> {
  const dryRun = !!opts.dryRun;
  const empty = { categoryDates: 0, tripCategoryUpserts: 0, tripsWithCategories: 0, from: null, to: null };

  /* ── Dati del progetto ── */
  const calsR = await db.execute(sql`
    SELECT id, monday, tuesday, wednesday, thursday, friday, saturday, sunday,
           to_char(start_date, 'YYYY-MM-DD') AS start_date,
           to_char(end_date,   'YYYY-MM-DD') AS end_date
      FROM ps_calendars WHERE project_id = ${projectId}::uuid
  `);
  const cals: any[] = (calsR as any).rows ?? [];

  const cdR = await db.execute(sql`
    SELECT cd.calendar_id, to_char(cd.date, 'YYYY-MM-DD') AS date, cd.exception_type
      FROM ps_calendar_dates cd
      JOIN ps_calendars c ON c.id = cd.calendar_id
     WHERE c.project_id = ${projectId}::uuid
  `);
  const cdates: any[] = (cdR as any).rows ?? [];

  const tripsR = await db.execute(sql`
    SELECT id, calendar_id,
           to_char(valid_from, 'YYYY-MM-DD') AS valid_from,
           to_char(valid_to,   'YYYY-MM-DD') AS valid_to
      FROM ps_trips WHERE project_id = ${projectId}::uuid AND is_active = true
  `);
  let trips: any[] = (tripsR as any).rows ?? [];
  // Sync MIRATO (auto-refresh): tocca solo le corse indicate — le assegnazioni
  // delle altre (incluse eventuali curatele manuali) restano intatte.
  if (opts.onlyTripIds) {
    const only = new Set(opts.onlyTripIds);
    trips = trips.filter((t) => only.has(t.id));
  }
  if (trips.length === 0 && cals.length === 0) return empty;

  const exR = await db.execute(sql`
    SELECT e.trip_id, to_char(e.date, 'YYYY-MM-DD') AS date, e.exception_type
      FROM ps_trip_exceptions e
      JOIN ps_trips t ON t.id = e.trip_id
     WHERE t.project_id = ${projectId}::uuid
  `);
  const tripExRows: any[] = (exR as any).rows ?? [];

  /* ── Range date: dai calendari + eccezioni (clamp 750 giorni) ── */
  let from: string | null = null;
  let to: string | null = null;
  const consider = (d: string | null) => {
    if (!d) return;
    if (!from || d < from) from = d;
    if (!to || d > to) to = d;
  };
  for (const c of cals) { consider(c.start_date); consider(c.end_date); }
  for (const cd of cdates) consider(cd.date);
  for (const e of tripExRows) consider(e.date);
  if (!from || !to) {
    const y = new Date().getUTCFullYear();
    from = `${y}-01-01`; to = `${y}-12-31`;
  }
  {
    const spanDays = (new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86_400_000;
    if (spanDays > 750) {
      const cap = new Date(new Date(`${from}T00:00:00Z`).getTime() + 750 * 86_400_000);
      to = cap.toISOString().slice(0, 10);
    }
  }

  /* ── Classificazione per data (una volta sola) ── */
  const profile = await loadCalendarProfile(projectId);
  const holidaysByYear = new Map<number, Set<string>>();
  const classByDate = new Map<string, string>(); // iso → level1
  for (let t = new Date(`${from}T00:00:00Z`).getTime(); ; t += 86_400_000) {
    const iso = new Date(t).toISOString().slice(0, 10);
    if (iso > to) break;
    const y = Number(iso.slice(0, 4));
    if (!holidaysByYear.has(y)) holidaysByYear.set(y, classifierHolidays(y));
    classByDate.set(iso, classifyDate(iso, profile, holidaysByYear.get(y)).level1);
  }

  /* ── Categorie (tabelle globali + seed idempotenti, lookup id per codice) ── */
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS ps_validity_categories (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      code        text NOT NULL UNIQUE,
      name        text NOT NULL,
      color       text NOT NULL,
      sort_order  integer NOT NULL DEFAULT 0,
      created_at  timestamptz NOT NULL DEFAULT now(),
      updated_at  timestamptz NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS ps_validity_category_calendar (
      date         date PRIMARY KEY,
      category_id  uuid NOT NULL REFERENCES ps_validity_categories(id) ON DELETE CASCADE,
      created_at   timestamptz NOT NULL DEFAULT now()
    )
  `);
  for (const c of SEED_VALIDITY_CATEGORIES) {
    await db.execute(sql`
      INSERT INTO ps_validity_categories (code, name, color, sort_order)
      SELECT ${c.code}, ${c.name}, ${c.color}, ${c.sort}
      WHERE NOT EXISTS (SELECT 1 FROM ps_validity_categories WHERE code = ${c.code})
    `);
  }
  const catR = await db.execute(sql`
    SELECT id, code FROM ps_validity_categories
     WHERE code IN ('scuole_aperte', 'scuole_chiuse', 'festivita')
  `);
  const catIdByCode = new Map<string, string>();
  for (const r of ((catR as any).rows ?? [])) catIdByCode.set(r.code, r.id);

  /* ── Fase A: calendario categorie per data ── */
  let categoryDates = 0;
  const dateEntries: Array<{ iso: string; catId: string }> = [];
  for (const [iso, level1] of classByDate) {
    const catId = catIdByCode.get(CLASS_TO_CATEGORY_CODE[level1] ?? "");
    if (catId) dateEntries.push({ iso, catId });
  }
  categoryDates = dateEntries.length;
  if (!dryRun) {
    const CHUNK = 400;
    for (let i = 0; i < dateEntries.length; i += CHUNK) {
      const chunk = dateEntries.slice(i, i + CHUNK);
      const values = sql.join(chunk.map((e) => sql`(${e.iso}::date, ${e.catId}::uuid)`), sql`, `);
      await db.execute(sql`
        INSERT INTO ps_validity_category_calendar (date, category_id)
        VALUES ${values}
        ON CONFLICT (date) DO UPDATE SET category_id = EXCLUDED.category_id
      `);
    }
  }

  /* ── Fase B: giorni di circolazione per corsa → categorie ── */
  // date attive per calendario: pattern settimanale ∩ [start,end] ± calendar_dates
  const DOW_KEYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;
  const cdByCal = new Map<string, Array<{ date: string; type: number }>>();
  for (const cd of cdates) {
    if (!cdByCal.has(cd.calendar_id)) cdByCal.set(cd.calendar_id, []);
    cdByCal.get(cd.calendar_id)!.push({ date: cd.date, type: Number(cd.exception_type) });
  }
  const calActive = new Map<string, Set<string>>();
  for (const c of cals) {
    const set = new Set<string>();
    const cFrom = c.start_date && c.start_date > from! ? c.start_date : from!;
    const cTo = c.end_date && c.end_date < to! ? c.end_date : to!;
    if (cFrom <= cTo) {
      for (let t = new Date(`${cFrom}T00:00:00Z`).getTime(); ; t += 86_400_000) {
        const iso = new Date(t).toISOString().slice(0, 10);
        if (iso > cTo) break;
        const dow = DOW_KEYS[new Date(t).getUTCDay()];
        if (c[dow]) set.add(iso);
      }
    }
    for (const ex of cdByCal.get(c.id) ?? []) {
      if (ex.type === 1) set.add(ex.date);
      else set.delete(ex.date);
    }
    calActive.set(c.id, set);
  }

  const exByTrip = new Map<string, Array<{ date: string; type: number }>>();
  for (const e of tripExRows) {
    if (!exByTrip.has(e.trip_id)) exByTrip.set(e.trip_id, []);
    exByTrip.get(e.trip_id)!.push({ date: e.date, type: Number(e.exception_type) });
  }

  let tripCategoryUpserts = 0;
  let tripsWithCategories = 0;
  const assignments: Array<{ tripId: string; catId: string }> = [];
  for (const t of trips) {
    const base = t.calendar_id ? (calActive.get(t.calendar_id) ?? new Set<string>()) : new Set<string>();
    const days = new Set<string>();
    for (const d of base) {
      if (t.valid_from && d < t.valid_from) continue;
      if (t.valid_to && d > t.valid_to) continue;
      days.add(d);
    }
    for (const ex of exByTrip.get(t.id) ?? []) {
      if (ex.type === 1) days.add(ex.date);
      else days.delete(ex.date);
    }
    if (days.size === 0) continue;
    const catIds = new Set<string>();
    for (const d of days) {
      const level1 = classByDate.get(d);
      if (!level1) continue;
      const catId = catIdByCode.get(CLASS_TO_CATEGORY_CODE[level1] ?? "");
      if (catId) catIds.add(catId);
    }
    if (catIds.size === 0) continue;
    tripsWithCategories++;
    for (const catId of catIds) assignments.push({ tripId: t.id, catId });
  }
  tripCategoryUpserts = assignments.length;

  if (!dryRun && trips.length > 0) {
    // SOSTITUISCE le assegnazioni delle corse attive del progetto: la fonte di
    // verità è il Calendario Aziendale (eventuali spunte manuali si rifanno
    // dopo il sync, che gira solo su import GTFS / azione esplicita).
    const allIds = trips.map((t) => t.id);
    const CHUNK_DEL = 800;
    for (let i = 0; i < allIds.length; i += CHUNK_DEL) {
      const ids = allIds.slice(i, i + CHUNK_DEL);
      await db.execute(sql`
        DELETE FROM ps_trip_category_validity
         WHERE trip_id = ANY(${`{${ids.join(",")}}`}::uuid[])
      `);
    }
    const CHUNK_INS = 500;
    for (let i = 0; i < assignments.length; i += CHUNK_INS) {
      const chunk = assignments.slice(i, i + CHUNK_INS);
      const values = sql.join(chunk.map((a) => sql`(${a.tripId}::uuid, ${a.catId}::uuid)`), sql`, `);
      await db.execute(sql`
        INSERT INTO ps_trip_category_validity (trip_id, category_id)
        VALUES ${values}
        ON CONFLICT (trip_id, category_id) DO NOTHING
      `);
    }
  }

  if (!dryRun) await touchCategoriesSyncedAt(projectId);

  return { categoryDates, tripCategoryUpserts, tripsWithCategories, from, to };
}

/* ════════════════════════════════════════════════════════════
 *  Auto-refresh categorie (usato dalla lista corse di Corse e TTD)
 *  ────────────────────────────────────────────────────────────
 *  Il calendario aziendale deve restare aggiornato SENZA reimport GTFS:
 *  un marcatore per progetto (ps_calendar_profiles.categories_synced_at)
 *  registra l'ultimo sync; alla lettura delle corse si risincronizzano
 *  SOLO le corse create/modificate dopo (calendario/date/eccezioni) — le
 *  assegnazioni delle altre corse, incluse le curatele manuali, restano.
 * ════════════════════════════════════════════════════════════ */

let syncMarkerColumnReady = false;
async function ensureSyncMarkerColumn(): Promise<void> {
  if (syncMarkerColumnReady) return;
  await db.execute(sql`
    ALTER TABLE IF EXISTS ps_calendar_profiles
      ADD COLUMN IF NOT EXISTS categories_synced_at timestamptz
  `);
  syncMarkerColumnReady = true;
}

async function touchCategoriesSyncedAt(projectId: string): Promise<void> {
  try {
    await ensureSyncMarkerColumn();
    await db.execute(sql`
      INSERT INTO ps_calendar_profiles (project_id, categories_synced_at)
      VALUES (${projectId}::uuid, now())
      ON CONFLICT (project_id) DO UPDATE SET categories_synced_at = now()
    `);
  } catch (e: any) {
    console.warn("[validity] marcatore sync categorie non aggiornabile:", e?.message || e);
  }
}

export async function ensureCategoriesFresh(projectId: string): Promise<void> {
  await ensureSyncMarkerColumn();
  const mR = await db.execute<any>(sql`
    SELECT categories_synced_at FROM ps_calendar_profiles
     WHERE project_id = ${projectId}::uuid LIMIT 1
  `);
  const syncedAt: string | null = mR.rows?.[0]?.categories_synced_at ?? null;

  if (syncedAt == null) {
    // Mai sincronizzato: riempi solo i BUCHI (corse senza alcuna categoria),
    // senza toccare le assegnazioni esistenti (possibili curatele manuali).
    const gapsR = await db.execute<any>(sql`
      SELECT t.id FROM ps_trips t
       WHERE t.project_id = ${projectId}::uuid AND COALESCE(t.is_active, true) = true
         AND NOT EXISTS (SELECT 1 FROM ps_trip_category_validity cv WHERE cv.trip_id = t.id)
    `);
    const gaps = (gapsR.rows ?? []).map((r: any) => r.id);
    if (gaps.length) await syncValidityCategoriesFromProfile(projectId, { onlyTripIds: gaps });
    else await touchCategoriesSyncedAt(projectId);
    return;
  }

  // Calendari (pattern/date di servizio) cambiati dopo l'ultimo sync →
  // possono spostare i giorni di TUTTE le corse: sync completo.
  const calR = await db.execute<any>(sql`
    SELECT max(updated_at) AS m FROM ps_calendars WHERE project_id = ${projectId}::uuid
  `);
  const calMax = calR.rows?.[0]?.m ?? null;
  if (calMax && new Date(calMax) > new Date(syncedAt)) {
    await syncValidityCategoriesFromProfile(projectId);
    return;
  }

  // Corse nuove o modificate (calendario/validità/eccezioni) → sync mirato.
  const stR = await db.execute<any>(sql`
    SELECT id FROM ps_trips
     WHERE project_id = ${projectId}::uuid
       AND GREATEST(created_at, COALESCE(updated_at, created_at)) > ${syncedAt}::timestamptz
  `);
  const stale = (stR.rows ?? []).map((r: any) => r.id);
  if (stale.length) await syncValidityCategoriesFromProfile(projectId, { onlyTripIds: stale });
}

/* ════════════════════════════════════════════════════════════
 *  POST /validity/generate-unit (PR4)
 *  ────────────────────────────────────────────────────────────
 *  Genera una "Unità di Progettazione" (= scheduling_project)
 *  partendo dalla Validity Matrix corrente:
 *  - body: { name, description?, from, to, dayTypeIds[], includeOnlyValid? }
 *  - crea row in scheduling_projects con planning_studio_project_id = :id
 *  - salva il filtro snapshot in scheduling_projects.validity_filter
 *  - la materializzazione PS→feed è triggerata dalla pipeline scheduling
 *    (lascia feed_id NULL: il primo step della pipeline lo riempie)
 *  - response: { schedulingProjectId, name }
 * ════════════════════════════════════════════════════════════ */
router.post("/planning-studio/projects/:id/validity/generate-unit", async (req, res): Promise<void> => {
  await ensureValidityTables();
  const userId = getUserId(req);
  if (!userId) { res.status(401).json({ error: "auth required" }); return; }
  const proj = await loadProject(req.params.id, userId, true);
  if (!proj) { res.status(403).json({ error: "forbidden" }); return; }

  const { name, description, from, to, dayTypeIds, includeOnlyValid } = req.body ?? {};
  if (typeof name !== "string" || name.trim().length === 0) {
    res.status(400).json({ error: "name è obbligatorio" }); return;
  }
  if (!isValidISODate(from) || !isValidISODate(to) || from > to) {
    res.status(400).json({ error: "from/to non validi (atteso YYYY-MM-DD, from<=to)" }); return;
  }
  if (!Array.isArray(dayTypeIds) || dayTypeIds.length === 0
      || !dayTypeIds.every((d: unknown) => typeof d === "string" && /^[0-9a-f-]{36}$/i.test(d))) {
    res.status(400).json({ error: "dayTypeIds deve essere un array di UUID non vuoto" }); return;
  }

  const filter = {
    from, to,
    dayTypeIds: dayTypeIds as string[],
    includeOnlyValid: includeOnlyValid !== false, // default true
    snapshotAt: new Date().toISOString(),
  };

  let row: any;
  try {
    const r = await db.execute(sql`
      INSERT INTO scheduling_projects
        (owner_user_id, name, description, planning_studio_project_id, validity_filter)
      VALUES (
        ${userId}::uuid,
        ${name.trim()},
        ${description ?? null},
        ${req.params.id}::uuid,
        ${JSON.stringify(filter)}::jsonb
      )
      RETURNING id, name
    `);
    row = (r as any).rows?.[0] ?? (r as any)[0];
  } catch (e: any) {
    console.error("[ps-validity] generate-unit insert error:", e?.message || e);
    res.status(500).json({ error: "Impossibile creare l'unità di progettazione" });
    return;
  }
  if (!row) { res.status(500).json({ error: "Insert fallito" }); return; }

  // Log activity (sul progetto PS sorgente)
  await logActivity(req.params.id, userId, "validity.generate-unit",
    "scheduling_project", row.id, {
      schedulingProjectId: row.id,
      schedulingProjectName: row.name,
      filter,
    });

  // Log activity (sull'unità appena creata) — pattern uguale a scheduling-projects.ts
  try {
    await db.execute(sql`
      INSERT INTO project_activity_log (project_id, user_id, action, target_type, target_id, payload)
      VALUES (${row.id}::uuid, ${userId}::uuid, 'project.create',
              'project', ${row.id}::uuid,
              ${JSON.stringify({
                source: "planning-studio.validity",
                planningStudioProjectId: req.params.id,
                planningStudioProjectName: proj.name,
                validityFilter: filter,
              })}::jsonb)
    `);
  } catch (e: any) {
    console.warn("[ps-validity] generate-unit activity log error:", e?.message || e);
  }

  telemetry("generate-unit", req.params.id, {
    schedulingProjectId: row.id,
    dayTypeCount: filter.dayTypeIds.length,
    days: Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1,
  });

  res.json({
    ok: true,
    schedulingProjectId: row.id,
    name: row.name,
  });
});

export default router;
