/**
 * PlannerStudio · Unità di Progettazione (validity-units)
 *
 * Spec utente:
 *   "Ogni giorno avrà un suo id di validità (che dipende dalla categoria del
 *    calendario di validità, dal tipo giorno e dalle corse attive). ID di
 *    validità uguale fanno parte della stessa unità di progettazione. Le
 *    unità di progettazione vanno salvate e consultate in una sezione a parte."
 *
 * Algoritmo:
 *   per ogni giorno D nel range [from..to]:
 *     1. categoryId = lookup ps_validity_category_calendar(D) (NULL se nessuna)
 *     2. dayTypeId  = lookup ps_day_calendar(project,D) ⨁ inferDefault(D, festivi, weekend)
 *     3. activeTrips = trip nel progetto la cui matrice valuta valid=true per D
 *        (considera ps_trip_day_validity + ps_trip_exceptions + valid_from/to)
 *     4. validity_id = sha256( categoryId || '|' || dayTypeId || '|' || sorted(tripIds).join(',') )
 *
 *   Giorni con stesso validity_id formano una "Unità di Progettazione".
 *
 * Tabella:
 *   ps_validity_units (project_id, validity_id) UNIQUE
 *
 * Endpoint sotto /api/planning-studio/projects/:id/validity-units:
 *   POST /compute   { from, to } → preview gruppi (no save)
 *   POST /save      { from, to, units: [{validityId, name, description?}] } → upsert
 *   GET  /          → lista unità salvate del progetto
 *   DELETE /:unitId
 */
import type { Request, Response } from "express";
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { italianHolidays } from "./validity-matrix-shared";

const router: IRouter = Router();

let bootstrapped = false;
async function ensureTables(): Promise<void> {
  if (bootstrapped) return;
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS ps_validity_units (
        id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id           uuid NOT NULL REFERENCES ps_projects(id) ON DELETE CASCADE,
        validity_id          text NOT NULL,
        name                 text NOT NULL,
        description          text,
        category_id          uuid REFERENCES ps_validity_categories(id) ON DELETE SET NULL,
        day_type_id          uuid REFERENCES ps_day_types(id) ON DELETE SET NULL,
        trip_ids             jsonb NOT NULL DEFAULT '[]'::jsonb,
        trip_count           integer NOT NULL DEFAULT 0,
        representative_dates jsonb NOT NULL DEFAULT '[]'::jsonb,
        day_count            integer NOT NULL DEFAULT 0,
        created_at           timestamptz NOT NULL DEFAULT now(),
        updated_at           timestamptz NOT NULL DEFAULT now()
      )
    `);
    await db.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_ps_validity_units
        ON ps_validity_units (project_id, validity_id)
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS idx_ps_validity_units_project
        ON ps_validity_units (project_id)
    `);
    bootstrapped = true;
    console.log("[planning-studio.validity-units] tables ready");
  } catch (e: any) {
    console.error("[ps-validity-units] bootstrap error:", e?.message || e);
  }
}

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

function plusDays(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  t.setUTCDate(t.getUTCDate() + n);
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
}
function isoRange(from: string, to: string): string[] {
  const out: string[] = [];
  let cur = from;
  let safety = 0;
  while (cur <= to && safety++ < 5000) { out.push(cur); cur = plusDays(cur, 1); }
  return out;
}

/**
 * Deriva il day-type per una data, replicando la logica frontend
 * (priorità: ps_day_calendar(project) > ps_day_calendar(global) > inferenza).
 */
async function buildDayTypeMap(
  projectId: string,
  dates: string[],
  patronSaints: Set<string>,
): Promise<Map<string, string | null>> {
  // Mappa code → id (system day-types)
  const sysR = await db.execute(sql`
    SELECT id, code FROM ps_day_types WHERE project_id IS NULL
  `);
  const sysIdByCode = new Map<string, string>();
  for (const r of (sysR as any).rows ?? []) sysIdByCode.set(r.code, r.id);

  // Calendar override: priorità project > global
  // NB: gli array vanno passati come literal Postgres '{a,b}' in un singolo
  // parametro: ${dates} verrebbe espanso in una tupla ($1,...)::date[] invalida.
  const datesLiteral = `{${dates.join(",")}}`;
  const calR = await db.execute(sql`
    SELECT to_char(date, 'YYYY-MM-DD') AS date, day_type_id, project_id
      FROM ps_day_calendar
     WHERE (project_id = ${projectId}::uuid OR project_id IS NULL)
       AND date = ANY(${datesLiteral}::date[])
  `);
  const projectOverride = new Map<string, string>();
  const globalOverride  = new Map<string, string>();
  for (const r of (calR as any).rows ?? []) {
    if (r.project_id) projectOverride.set(r.date, r.day_type_id);
    else globalOverride.set(r.date, r.day_type_id);
  }

  const map = new Map<string, string | null>();
  for (const d of dates) {
    if (projectOverride.has(d)) { map.set(d, projectOverride.get(d)!); continue; }
    if (globalOverride.has(d))  { map.set(d, globalOverride.get(d)!);  continue; }
    // Inferenza
    const [yy, mm, dd] = d.split("-").map(Number);
    const dow = new Date(yy, mm - 1, dd).getDay(); // 0=dom
    if (patronSaints.has(d)) { map.set(d, sysIdByCode.get("festivo") ?? null); continue; }
    if (dow === 0)           { map.set(d, sysIdByCode.get("festivo") ?? null); continue; }
    if (dow === 6)           { map.set(d, sysIdByCode.get("sabato")  ?? null); continue; }
    map.set(d, sysIdByCode.get("feriale") ?? null);
  }
  return map;
}

interface ComputedUnit {
  validityId: string;
  categoryId: string | null;
  categoryName: string | null;
  categoryColor: string | null;
  dayTypeId: string | null;
  dayTypeName: string | null;
  dayTypeColor: string | null;
  tripIds: string[];
  tripCount: number;
  dates: string[];
  dayCount: number;
  /** foglia del calendario aziendale (albero validità a 3 livelli), se configurato */
  leafKey: string | null;
  leafLabel: string | null;
  /** quanti gruppi esatti sono stati fusi in questa unità (tolleranza Jaccard) */
  mergedCount?: number;
}

/** distanza di Jaccard tra insiemi di corse: 0 = identici, 1 = disgiunti */
function jaccardDistance(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  const sa = new Set(a);
  let inter = 0;
  for (const x of b) if (sa.has(x)) inter++;
  const union = a.length + b.length - inter;
  return union === 0 ? 0 : 1 - inter / union;
}

/**
 * Fonde i gruppi esatti quasi-uguali DENTRO la stessa foglia del calendario
 * (mai tra foglie: feriale/sabato/festivo restano separati per contratto).
 * Greedy: parte dal gruppo con più giorni e assorbe i gruppi della stessa
 * foglia con distanza di Jaccard ≤ tolerance. Deterministico e spiegabile.
 */
function mergeUnitsByJaccard(units: ComputedUnit[], tolerance: number): ComputedUnit[] {
  if (tolerance <= 0) return units;
  const sorted = [...units].sort((a, b) => b.dayCount - a.dayCount);
  const out: ComputedUnit[] = [];
  const absorbed = new Set<string>();
  for (const u of sorted) {
    if (absorbed.has(u.validityId)) continue;
    const rep: ComputedUnit = { ...u, dates: [...u.dates], mergedCount: 1 };
    for (const v of sorted) {
      if (v === u || absorbed.has(v.validityId)) continue;
      const sameLeaf = (rep.leafKey ?? `dt:${rep.dayTypeId}`) === (v.leafKey ?? `dt:${v.dayTypeId}`);
      if (!sameLeaf) continue;
      if (jaccardDistance(rep.tripIds, v.tripIds) <= tolerance) {
        rep.dates.push(...v.dates);
        rep.dayCount += v.dayCount;
        rep.mergedCount = (rep.mergedCount ?? 1) + 1;
        absorbed.add(v.validityId);
      }
    }
    rep.dates.sort();
    out.push(rep);
  }
  return out;
}

/* ────────── POST /compute (preview, no save) ────────── */
router.post("/planning-studio/projects/:id/validity-units/compute", async (req, res): Promise<void> => {
  await ensureTables();
  const userId = getUserId(req);
  if (!userId) { res.status(401).json({ error: "unauth" }); return; }
  const proj = await loadProject(req.params.id, userId, false);
  if (!proj) { res.status(404).json({ error: "not_found_or_no_access" }); return; }

  const { from, to } = req.body ?? {};
  if (!isValidISODate(from) || !isValidISODate(to) || from > to) {
    res.status(400).json({ error: "from_to_required" }); return;
  }
  // tolleranza Jaccard 0–10%: 0 = solo gruppi esatti (comportamento storico)
  const tolerance = Math.min(Math.max(Number(req.body?.tolerance) || 0, 0), 0.1);
  const dates = isoRange(from, to);
  if (dates.length > 731) { // max ~2 anni
    res.status(400).json({ error: "range_too_large", maxDays: 731 }); return;
  }

  try {
    // Patroni locali (per inferenza day-type)
    const patronSaints = new Set<string>();
    const settings = (proj.agency_settings as any) || {};
    if (Array.isArray(settings.patronSaintDates)) {
      for (const d of settings.patronSaintDates) if (isValidISODate(d)) patronSaints.add(d);
    }

    // Calendario categorie (globale) — array come literal Postgres (vedi nota
    // in buildDayTypeMap: l'interpolazione diretta genera una tupla invalida)
    const datesArrLiteral = `{${dates.join(",")}}`;
    const catCalR = await db.execute(sql`
      SELECT to_char(c.date, 'YYYY-MM-DD') AS date, c.category_id,
             cat.name AS category_name, cat.color AS category_color
        FROM ps_validity_category_calendar c
        LEFT JOIN ps_validity_categories cat ON cat.id = c.category_id
       WHERE c.date = ANY(${datesArrLiteral}::date[])
    `);
    const catByDate = new Map<string, { id: string; name: string; color: string }>();
    for (const r of (catCalR as any).rows ?? []) {
      catByDate.set(r.date, { id: r.category_id, name: r.category_name, color: r.category_color });
    }

    // Day-type per data
    const dtMap = await buildDayTypeMap(proj.id, dates, patronSaints);

    // Calendario aziendale (albero validità a 3 livelli): se configurato, ogni
    // data ha una foglia (Scuole Aperte / Chiuse Inv-Est / Festivo Dom-Rosso)
    // che fa da partizione hard per i gruppi e per il merge a tolleranza.
    const { loadCalendarProfile } = await import("./planning-studio-calendar");
    const { classifyDate, italianHolidays } = await import("./day-classifier");
    const calProfile = await loadCalendarProfile(proj.id);
    const calConfigured = calProfile.schoolPeriods.length > 0 || !!calProfile.summerPeriod;
    const holidaysByYear = new Map<number, Set<string>>();
    const leafOf = (d: string): { key: string; label: string } | null => {
      if (!calConfigured) return null;
      const y = Number(d.slice(0, 4));
      if (!holidaysByYear.has(y)) holidaysByYear.set(y, italianHolidays(y));
      const c = classifyDate(d, calProfile, holidaysByYear.get(y));
      return { key: c.key, label: c.label };
    };

    // Day-type metadata
    const dtIds = Array.from(new Set(Array.from(dtMap.values()).filter(Boolean) as string[]));
    const dtMeta = new Map<string, { name: string; color: string }>();
    if (dtIds.length > 0) {
      const dtR = await db.execute(sql`
        SELECT id, name, color FROM ps_day_types WHERE id = ANY(${`{${dtIds.join(",")}}`}::uuid[])
      `);
      for (const r of (dtR as any).rows ?? []) {
        dtMeta.set(r.id, { name: r.name, color: r.color });
      }
    }

    // Trips del progetto + matrice validità
    const tripsR = await db.execute(sql`
      SELECT t.id, t.is_active,
             to_char(t.valid_from, 'YYYY-MM-DD') AS valid_from,
             to_char(t.valid_to,   'YYYY-MM-DD') AS valid_to
        FROM ps_trips t
       WHERE t.project_id = ${proj.id}::uuid
    `);
    const trips = ((tripsR as any).rows ?? []) as Array<{
      id: string; is_active: boolean; valid_from: string | null; valid_to: string | null;
    }>;
    const tripIds = trips.map((t) => t.id);

    // tripDayValidity: trip × dayType → bool
    const tdvMap = new Map<string, Map<string, boolean>>();
    if (tripIds.length > 0) {
      const tdvR = await db.execute(sql`
        SELECT trip_id, day_type_id, is_valid
          FROM ps_trip_day_validity
         WHERE trip_id = ANY(${`{${tripIds.join(",")}}`}::uuid[])
      `);
      for (const r of (tdvR as any).rows ?? []) {
        if (!tdvMap.has(r.trip_id)) tdvMap.set(r.trip_id, new Map());
        tdvMap.get(r.trip_id)!.set(r.day_type_id, !!r.is_valid);
      }
    }

    // Eccezioni: trip × date → 1|2
    const excMap = new Map<string, Map<string, 1 | 2>>();
    if (tripIds.length > 0) {
      const excR = await db.execute(sql`
        SELECT trip_id, to_char(date, 'YYYY-MM-DD') AS date, exception_type
          FROM ps_trip_exceptions
         WHERE trip_id = ANY(${`{${tripIds.join(",")}}`}::uuid[])
           AND date >= ${from}::date AND date <= ${to}::date
      `);
      for (const r of (excR as any).rows ?? []) {
        if (!excMap.has(r.trip_id)) excMap.set(r.trip_id, new Map());
        excMap.get(r.trip_id)!.set(r.date, r.exception_type === 1 ? 1 : 2);
      }
    }

    // Compute active trips per date
    const groups = new Map<string, ComputedUnit>();
    for (const d of dates) {
      const cat = catByDate.get(d) ?? null;
      const dtId = dtMap.get(d) ?? null;
      const dtM = dtId ? dtMeta.get(dtId) : undefined;

      const active: string[] = [];
      for (const t of trips) {
        const ex = excMap.get(t.id)?.get(d);
        if (ex === 2) continue;          // forced invalid
        if (ex === 1) { active.push(t.id); continue; } // forced valid
        if (!t.is_active) continue;
        if (t.valid_from && d < t.valid_from) continue;
        if (t.valid_to   && d > t.valid_to)   continue;
        if (!dtId) continue;
        const v = tdvMap.get(t.id)?.get(dtId);
        if (v) active.push(t.id);
      }
      active.sort();

      const leaf = leafOf(d);
      const hashSrc = `${leaf?.key ?? "null"}|${cat?.id ?? "null"}|${dtId ?? "null"}|${active.join(",")}`;
      const validityId = createHash("sha256").update(hashSrc).digest("hex").slice(0, 32);

      const existing = groups.get(validityId);
      if (existing) {
        existing.dates.push(d);
        existing.dayCount += 1;
      } else {
        groups.set(validityId, {
          validityId,
          categoryId: cat?.id ?? null,
          categoryName: cat?.name ?? null,
          categoryColor: cat?.color ?? null,
          dayTypeId: dtId,
          dayTypeName: dtM?.name ?? null,
          dayTypeColor: dtM?.color ?? null,
          tripIds: active,
          tripCount: active.length,
          dates: [d],
          dayCount: 1,
          leafKey: leaf?.key ?? null,
          leafLabel: leaf?.label ?? null,
        });
      }
    }

    // Esistenti già salvate (per UX)
    const savedR = await db.execute(sql`
      SELECT validity_id, name FROM ps_validity_units WHERE project_id = ${proj.id}::uuid
    `);
    const savedSet = new Set<string>(((savedR as any).rows ?? []).map((r: any) => r.validity_id));

    const exactCount = groups.size;
    const merged = mergeUnitsByJaccard(Array.from(groups.values()), tolerance);
    const list = merged
      .sort((a, b) => b.dayCount - a.dayCount)
      .map((u) => ({ ...u, alreadySaved: savedSet.has(u.validityId) }));

    res.json({
      from, to, totalDays: dates.length,
      totalGroups: list.length, exactGroups: exactCount, tolerance,
      calendarConfigured: calConfigured,
      units: list,
    });
  } catch (e: any) {
    console.error("[ps-validity-units.compute] error:", e?.message || e);
    res.status(500).json({ error: e?.message || "internal_error" });
  }
});

/* ────────── POST /save (upsert idempotente) ────────── */
router.post("/planning-studio/projects/:id/validity-units/save", async (req, res): Promise<void> => {
  await ensureTables();
  const userId = getUserId(req);
  if (!userId) { res.status(401).json({ error: "unauth" }); return; }
  const proj = await loadProject(req.params.id, userId, true);
  if (!proj) { res.status(404).json({ error: "not_found_or_no_write" }); return; }

  const units: any[] = Array.isArray(req.body?.units) ? req.body.units : [];
  if (units.length === 0) { res.status(400).json({ error: "units_required" }); return; }

  try {
    let upsertCount = 0;
    for (const u of units) {
      const validityId = String(u.validityId ?? u.validity_id ?? "").trim();
      const name       = String(u.name ?? "").trim();
      if (!validityId || !name) continue;
      const description    = u.description ? String(u.description) : null;
      const categoryId     = u.categoryId ?? u.category_id ?? null;
      const dayTypeId      = u.dayTypeId  ?? u.day_type_id  ?? null;
      const tripIds        = Array.isArray(u.tripIds) ? u.tripIds : [];
      const repDates       = Array.isArray(u.dates) ? u.dates : (Array.isArray(u.representativeDates) ? u.representativeDates : []);
      const tripCount      = Number.isFinite(u.tripCount) ? u.tripCount : tripIds.length;
      const dayCount       = Number.isFinite(u.dayCount)  ? u.dayCount  : repDates.length;

      await db.execute(sql`
        INSERT INTO ps_validity_units (
          project_id, validity_id, name, description, category_id, day_type_id,
          trip_ids, trip_count, representative_dates, day_count
        ) VALUES (
          ${proj.id}::uuid, ${validityId}, ${name}, ${description},
          ${categoryId}::uuid, ${dayTypeId}::uuid,
          ${JSON.stringify(tripIds)}::jsonb, ${tripCount},
          ${JSON.stringify(repDates)}::jsonb, ${dayCount}
        )
        ON CONFLICT (project_id, validity_id) DO UPDATE SET
          name = EXCLUDED.name,
          description = EXCLUDED.description,
          category_id = EXCLUDED.category_id,
          day_type_id = EXCLUDED.day_type_id,
          trip_ids = EXCLUDED.trip_ids,
          trip_count = EXCLUDED.trip_count,
          representative_dates = EXCLUDED.representative_dates,
          day_count = EXCLUDED.day_count,
          updated_at = now()
      `);
      upsertCount++;
    }
    res.json({ ok: true, count: upsertCount });
  } catch (e: any) {
    console.error("[ps-validity-units.save] error:", e?.message || e);
    res.status(500).json({ error: e?.message || "internal_error" });
  }
});

/* ────────── GET / (list units) ────────── */
router.get("/planning-studio/projects/:id/validity-units", async (req, res): Promise<void> => {
  await ensureTables();
  const userId = getUserId(req);
  if (!userId) { res.status(401).json({ error: "unauth" }); return; }
  const proj = await loadProject(req.params.id, userId, false);
  if (!proj) { res.status(404).json({ error: "not_found_or_no_access" }); return; }
  try {
    const r = await db.execute(sql`
      SELECT u.*,
             cat.name  AS category_name,  cat.color  AS category_color,
             dt.name   AS day_type_name,  dt.color   AS day_type_color
        FROM ps_validity_units u
        LEFT JOIN ps_validity_categories cat ON cat.id = u.category_id
        LEFT JOIN ps_day_types           dt  ON dt.id  = u.day_type_id
       WHERE u.project_id = ${proj.id}::uuid
       ORDER BY u.day_count DESC, u.created_at DESC
    `);
    const out = ((r as any).rows ?? []).map((row: any) => ({
      id: row.id,
      validityId: row.validity_id,
      name: row.name,
      description: row.description,
      categoryId: row.category_id,
      categoryName: row.category_name,
      categoryColor: row.category_color,
      dayTypeId: row.day_type_id,
      dayTypeName: row.day_type_name,
      dayTypeColor: row.day_type_color,
      tripIds: row.trip_ids ?? [],
      tripCount: row.trip_count,
      representativeDates: row.representative_dates ?? [],
      dayCount: row.day_count,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
    res.json(out);
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "internal_error" });
  }
});

/* ────────── DELETE /:unitId ────────── */
router.delete("/planning-studio/projects/:id/validity-units/:unitId", async (req, res): Promise<void> => {
  await ensureTables();
  const userId = getUserId(req);
  if (!userId) { res.status(401).json({ error: "unauth" }); return; }
  const proj = await loadProject(req.params.id, userId, true);
  if (!proj) { res.status(404).json({ error: "not_found_or_no_write" }); return; }
  try {
    await db.execute(sql`
      DELETE FROM ps_validity_units
       WHERE id = ${req.params.unitId}::uuid AND project_id = ${proj.id}::uuid
    `);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "internal_error" });
  }
});

/* ────────── PATCH /:unitId (rename) ────────── */
router.patch("/planning-studio/projects/:id/validity-units/:unitId", async (req, res): Promise<void> => {
  await ensureTables();
  const userId = getUserId(req);
  if (!userId) { res.status(401).json({ error: "unauth" }); return; }
  const proj = await loadProject(req.params.id, userId, true);
  if (!proj) { res.status(404).json({ error: "not_found_or_no_write" }); return; }
  const { name, description } = req.body ?? {};
  const sets: any[] = [];
  if (typeof name === "string" && name.trim()) sets.push(sql`name = ${name.trim()}`);
  if (typeof description === "string") sets.push(sql`description = ${description}`);
  if (sets.length === 0) { res.status(400).json({ error: "no_changes" }); return; }
  sets.push(sql`updated_at = now()`);
  try {
    const setClause = sql.join(sets, sql`, `);
    const r = await db.execute(sql`
      UPDATE ps_validity_units SET ${setClause}
       WHERE id = ${req.params.unitId}::uuid AND project_id = ${proj.id}::uuid
       RETURNING id, name, description, updated_at
    `);
    const row = (r as any).rows?.[0];
    if (!row) { res.status(404).json({ error: "not_found" }); return; }
    res.json(row);
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "internal_error" });
  }
});

export default router;
