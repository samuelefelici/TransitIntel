/**
 * PlannerStudio · Calendario di Validità — categorie GLOBALI (per tutti i progetti)
 *
 * Spec utente:
 *   "Mi serve una sezione 'Calendario Validità' dove posso dare un'altra
 *    macrocategoria (Scuole Aperte / Scuole Chiuse / Festività ecc.) e
 *    attraverso un calendario decido quando sono attive queste validità.
 *    Le categorie sono valide per tutti i progetti."
 *
 * Modello:
 *   - ps_validity_categories         (id, code, name, color, sort_order)
 *     → dizionario GLOBALE condiviso (scuole_chiuse_estivo significa lo
 *       stesso ovunque; ciò che cambia per progetto è QUALI giorni lo sono)
 *   - ps_validity_category_calendar  (project_id?, date, category_id)
 *     → PER-PROGETTO dal pacchetto 5B (project_id NULL = strato globale
 *       legacy, fallback per i progetti senza righe proprie). 1 categoria
 *       per giorno per strato; lettura con precedenza project > global.
 *
 * Endpoint sotto /api/planning-studio/validity-categories:
 *   GET    /                            → lista categorie
 *   POST   /                            → crea
 *   PATCH  /:catId                      → modifica
 *   DELETE /:catId                      → elimina (cascade calendar)
 *   GET    /calendar?from=&to=[&projectId=] → entries (merged se projectId)
 *   PUT    /calendar                    → upsert { dates, category_id, projectId? }
 *   DELETE /calendar?date=&projectId?=  → rimuovi assegnazione (per strato)
 */
import type { Request, Response } from "express";
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const router: IRouter = Router();

let bootstrapped = false;
let calendarSchemaReady = false;

const SEED_CATEGORIES = [
  { code: "scuole_aperte",  name: "Scuole Aperte",  color: "#3b82f6", sort_order: 10 },
  { code: "scuole_chiuse",  name: "Scuole Chiuse",  color: "#f59e0b", sort_order: 20 },
  { code: "festivita",      name: "Festività",      color: "#ef4444", sort_order: 30 },
];

/**
 * Schema del CALENDARIO categorie — migrazione PER-PROGETTO (pacchetto 5B).
 *
 * Storicamente PK sulla sola `date` (calendario unico globale): due progetti
 * si sovrascrivevano a vicenda la classificazione dei giorni a ogni sync.
 * Ora: colonna project_id NULLABLE + indici UNIQUE PARZIALI, stesso pattern
 * di ps_day_calendar (planning-studio-validity.ts). Le righe esistenti restano
 * project_id NULL = fallback legacy leggibile da tutti; le nuove scritture
 * sono per-progetto. Lettura con precedenza project > global.
 *
 * Idempotente e condivisa: chiamata dai 3 moduli che bootstrappavano la
 * tabella inline (questo, validity, validity-units).
 * Ordine importante: indici PRIMA del drop della PK (mai senza arbiter).
 */
export async function ensureValidityCategoryCalendarSchema(): Promise<void> {
  if (calendarSchemaReady) return;
  // Self-contained: la FK del calendario richiede l'anagrafica categorie.
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
  await db.execute(sql`
    ALTER TABLE ps_validity_category_calendar
      ADD COLUMN IF NOT EXISTS project_id uuid REFERENCES ps_projects(id) ON DELETE CASCADE
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_ps_vcc_global
      ON ps_validity_category_calendar (date) WHERE project_id IS NULL
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_ps_vcc_project
      ON ps_validity_category_calendar (project_id, date) WHERE project_id IS NOT NULL
  `);
  // drop PK name-agnostic (il NOT NULL su date sopravvive al drop)
  await db.execute(sql`
    DO $$ DECLARE pk text;
    BEGIN
      SELECT conname INTO pk FROM pg_constraint
       WHERE conrelid = 'ps_validity_category_calendar'::regclass AND contype = 'p';
      IF pk IS NOT NULL THEN
        EXECUTE format('ALTER TABLE ps_validity_category_calendar DROP CONSTRAINT %I', pk);
      END IF;
    END $$
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_ps_vcc_cat ON ps_validity_category_calendar(category_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_ps_vcc_lookup ON ps_validity_category_calendar (project_id, date)`);
  calendarSchemaReady = true;
}

async function ensureTables(): Promise<void> {
  if (bootstrapped) return;
  try {
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
    await ensureValidityCategoryCalendarSchema();

    for (const c of SEED_CATEGORIES) {
      await db.execute(sql`
        INSERT INTO ps_validity_categories (code, name, color, sort_order)
        SELECT ${c.code}, ${c.name}, ${c.color}, ${c.sort_order}
        WHERE NOT EXISTS (SELECT 1 FROM ps_validity_categories WHERE code = ${c.code})
      `);
    }

    bootstrapped = true;
    console.log("[planning-studio.validity-categories] tables ready");
  } catch (e: any) {
    console.error("[ps-validity-categories] bootstrap error:", e?.message || e);
  }
}

function getUserId(req: Request): string | null {
  return (req as any).session?.userId ?? (req as any).user?.id ?? null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Accesso al progetto (owner/membro; needWrite = owner|editor). Duplicata
 *  localmente come negli altri moduli ps_* per evitare cicli di import. */
async function loadProject(projectId: string, userId: string, needWrite: boolean): Promise<any | null> {
  const r = await db.execute(sql`
    SELECT p.id,
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

/** projectId opzionale da query/body: null = strato globale legacy.
 *  Ritorna undefined se presente ma invalido/inaccessibile (→ 4xx). */
async function resolveProjectScope(
  req: Request, res: Response, raw: unknown, needWrite: boolean,
): Promise<string | null | undefined> {
  if (raw === undefined || raw === null || raw === "") return null;
  const pid = String(raw);
  if (!UUID_RE.test(pid)) { res.status(400).json({ error: "projectId non valido" }); return undefined; }
  const userId = getUserId(req);
  const proj = userId ? await loadProject(pid, userId, needWrite) : null;
  if (!proj) { res.status(404).json({ error: "Progetto non trovato o permessi insufficienti" }); return undefined; }
  return pid;
}

function isValidISODate(s: unknown): s is string {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}
function isValidHexColor(s: unknown): s is string {
  return typeof s === "string" && /^#[0-9a-fA-F]{6}$/.test(s);
}

function rowToCategory(r: any) {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    color: r.color,
    sortOrder: r.sort_order,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/* ────────── Categories CRUD ────────── */

router.get("/planning-studio/validity-categories", async (_req, res): Promise<void> => {
  await ensureTables();
  try {
    const r = await db.execute(sql`
      SELECT * FROM ps_validity_categories ORDER BY sort_order ASC, name ASC
    `);
    res.json(((r as any).rows ?? []).map(rowToCategory));
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "internal_error" });
  }
});

router.post("/planning-studio/validity-categories", async (req, res): Promise<void> => {
  await ensureTables();
  const userId = getUserId(req);
  if (!userId) { res.status(401).json({ error: "unauth" }); return; }
  const { code, name, color, sortOrder } = req.body ?? {};
  if (typeof code !== "string" || !code.trim()) { res.status(400).json({ error: "code_required" }); return; }
  if (typeof name !== "string" || !name.trim()) { res.status(400).json({ error: "name_required" }); return; }
  if (!isValidHexColor(color)) { res.status(400).json({ error: "color_invalid_hex6" }); return; }
  try {
    const r = await db.execute(sql`
      INSERT INTO ps_validity_categories (code, name, color, sort_order)
      VALUES (${code.trim()}, ${name.trim()}, ${color}, ${Number(sortOrder ?? 0) | 0})
      RETURNING *
    `);
    res.status(201).json(rowToCategory((r as any).rows[0]));
  } catch (e: any) {
    if (String(e?.message || "").includes("duplicate")) {
      res.status(409).json({ error: "code_conflict" });
      return;
    }
    res.status(500).json({ error: e?.message || "internal_error" });
  }
});

router.patch("/planning-studio/validity-categories/:catId", async (req, res): Promise<void> => {
  await ensureTables();
  const userId = getUserId(req);
  if (!userId) { res.status(401).json({ error: "unauth" }); return; }
  const { catId } = req.params;
  const { name, color, sortOrder } = req.body ?? {};
  const sets: any[] = [];
  if (typeof name === "string" && name.trim()) sets.push(sql`name = ${name.trim()}`);
  if (typeof color === "string") {
    if (!isValidHexColor(color)) { res.status(400).json({ error: "color_invalid_hex6" }); return; }
    sets.push(sql`color = ${color}`);
  }
  if (typeof sortOrder === "number") sets.push(sql`sort_order = ${sortOrder | 0}`);
  if (sets.length === 0) { res.status(400).json({ error: "no_changes" }); return; }
  sets.push(sql`updated_at = now()`);
  try {
    const setClause = sql.join(sets, sql`, `);
    const r = await db.execute(sql`
      UPDATE ps_validity_categories SET ${setClause}
       WHERE id = ${catId}::uuid
       RETURNING *
    `);
    const row = (r as any).rows?.[0];
    if (!row) { res.status(404).json({ error: "not_found" }); return; }
    res.json(rowToCategory(row));
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "internal_error" });
  }
});

router.delete("/planning-studio/validity-categories/:catId", async (req, res): Promise<void> => {
  await ensureTables();
  const userId = getUserId(req);
  if (!userId) { res.status(401).json({ error: "unauth" }); return; }
  const { catId } = req.params;
  try {
    await db.execute(sql`DELETE FROM ps_validity_categories WHERE id = ${catId}::uuid`);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "internal_error" });
  }
});

/* ────────── Calendar ────────── */

router.get("/planning-studio/validity-categories/calendar", async (req, res): Promise<void> => {
  await ensureTables();
  const from = req.query.from;
  const to = req.query.to;
  if (!isValidISODate(from) || !isValidISODate(to) || from > to) {
    res.status(400).json({ error: "from_to_required" }); return;
  }
  const projectId = await resolveProjectScope(req, res, req.query.projectId, false);
  if (projectId === undefined) return;
  try {
    // Con projectId: merged project > global (la riga di progetto vince, la
    // globale legacy resta fallback per le date scoperte). Senza: solo lo
    // strato globale — esattamente ciò che i client vecchi vedevano prima.
    const r = projectId
      ? await db.execute(sql`
          SELECT DISTINCT ON (date) to_char(date, 'YYYY-MM-DD') AS date, category_id
            FROM ps_validity_category_calendar
           WHERE (project_id = ${projectId}::uuid OR project_id IS NULL)
             AND date >= ${from}::date AND date <= ${to}::date
           ORDER BY date ASC, project_id ASC NULLS LAST
        `)
      : await db.execute(sql`
          SELECT to_char(date, 'YYYY-MM-DD') AS date, category_id
            FROM ps_validity_category_calendar
           WHERE project_id IS NULL
             AND date >= ${from}::date AND date <= ${to}::date
           ORDER BY date ASC
        `);
    res.json(((r as any).rows ?? []).map((x: any) => ({ date: x.date, categoryId: x.category_id })));
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "internal_error" });
  }
});

router.put("/planning-studio/validity-categories/calendar", async (req, res): Promise<void> => {
  await ensureTables();
  const userId = getUserId(req);
  if (!userId) { res.status(401).json({ error: "unauth" }); return; }
  const dates: string[] = Array.isArray(req.body?.dates) ? req.body.dates :
                          (typeof req.body?.date === "string" ? [req.body.date] : []);
  const categoryId: string | null = req.body?.category_id ?? req.body?.categoryId ?? null;

  if (dates.length === 0) { res.status(400).json({ error: "dates_required" }); return; }
  for (const d of dates) {
    if (!isValidISODate(d)) { res.status(400).json({ error: `invalid_date:${d}` }); return; }
  }
  const projectId = await resolveProjectScope(req, res, req.body?.projectId, true);
  if (projectId === undefined) return;
  try {
    if (categoryId === null) {
      // bulk delete (scoped: solo lo strato indicato — l'erase per-progetto
      // può far riemergere il fallback globale su quella data, come day-calendar)
      for (const d of dates) {
        if (projectId) {
          await db.execute(sql`
            DELETE FROM ps_validity_category_calendar
             WHERE project_id = ${projectId}::uuid AND date = ${d}::date`);
        } else {
          await db.execute(sql`
            DELETE FROM ps_validity_category_calendar
             WHERE project_id IS NULL AND date = ${d}::date`);
        }
      }
      res.json({ ok: true, count: dates.length, op: "delete" });
      return;
    }
    // upsert su indice parziale: stessa sintassi collaudata di ps_day_calendar
    for (const d of dates) {
      if (projectId) {
        await db.execute(sql`
          INSERT INTO ps_validity_category_calendar (project_id, date, category_id)
          VALUES (${projectId}::uuid, ${d}::date, ${categoryId}::uuid)
          ON CONFLICT (project_id, date) WHERE project_id IS NOT NULL
          DO UPDATE SET category_id = EXCLUDED.category_id
        `);
      } else {
        await db.execute(sql`
          INSERT INTO ps_validity_category_calendar (project_id, date, category_id)
          VALUES (NULL, ${d}::date, ${categoryId}::uuid)
          ON CONFLICT (date) WHERE project_id IS NULL
          DO UPDATE SET category_id = EXCLUDED.category_id
        `);
      }
    }
    res.json({ ok: true, count: dates.length, op: "upsert" });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "internal_error" });
  }
});

router.delete("/planning-studio/validity-categories/calendar", async (req, res): Promise<void> => {
  await ensureTables();
  const userId = getUserId(req);
  if (!userId) { res.status(401).json({ error: "unauth" }); return; }
  const date = req.query.date;
  if (!isValidISODate(date)) { res.status(400).json({ error: "date_required" }); return; }
  const projectId = await resolveProjectScope(req, res, req.query.projectId, true);
  if (projectId === undefined) return;
  try {
    if (projectId) {
      await db.execute(sql`
        DELETE FROM ps_validity_category_calendar
         WHERE project_id = ${projectId}::uuid AND date = ${date}::date`);
    } else {
      await db.execute(sql`
        DELETE FROM ps_validity_category_calendar
         WHERE project_id IS NULL AND date = ${date}::date`);
    }
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "internal_error" });
  }
});

export default router;
