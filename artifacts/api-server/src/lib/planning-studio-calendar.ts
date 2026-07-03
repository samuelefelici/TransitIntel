/**
 * CALENDARIO AZIENDALE (per progetto PS) + classificazione giorni.
 *
 * L'operatore definisce UNA VOLTA: periodi scolastici, periodo estivo,
 * festività extra (patrono…). Il sistema classifica ogni data dell'anno
 * nell'albero a 3 livelli (vedi lib/day-classifier.ts) — base per dare le
 * validità per rami e per contenere il numero di unità di progettazione.
 *
 *   GET /api/planning-studio/projects/:id/calendar-profile
 *   PUT /api/planning-studio/projects/:id/calendar-profile
 *   GET /api/planning-studio/projects/:id/day-classification?from=&to=
 */
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { classifyRange, type CalendarProfile } from "./day-classifier";

const router: IRouter = Router();

let bootstrapped = false;
async function ensureTable(): Promise<void> {
  if (bootstrapped) return;
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS ps_calendar_profiles (
      project_id uuid PRIMARY KEY REFERENCES ps_projects(id) ON DELETE CASCADE,
      school_periods jsonb NOT NULL DEFAULT '[]'::jsonb,
      summer_period jsonb,
      extra_holidays jsonb NOT NULL DEFAULT '[]'::jsonb,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  // Modello standardizzato: si memorizzano i periodi di SCUOLE CHIUSE (il
  // default — colonna vuota — significa "tutto l'anno scuole aperte"). La
  // vecchia colonna school_periods resta per compatibilità ma non è più usata.
  await db.execute(sql`ALTER TABLE ps_calendar_profiles ADD COLUMN IF NOT EXISTS closed_periods jsonb NOT NULL DEFAULT '[]'::jsonb`);
  bootstrapped = true;
}
router.use(async (_req, _res, next) => { await ensureTable(); next(); });

const UUID_RE = /^[0-9a-f-]{36}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function loadCalendarProfile(projectId: string): Promise<CalendarProfile> {
  await ensureTable();
  return loadProfile(projectId);
}

async function loadProfile(projectId: string): Promise<CalendarProfile> {
  const r = await db.execute<any>(sql`
    SELECT closed_periods, summer_period, extra_holidays
    FROM ps_calendar_profiles WHERE project_id = ${projectId}::uuid LIMIT 1
  `);
  const row = r.rows[0];
  return {
    closedPeriods: row?.closed_periods ?? [],
    summerPeriod: row?.summer_period ?? null,
    extraHolidays: row?.extra_holidays ?? [],
  };
}

router.get("/planning-studio/projects/:id/calendar-profile", async (req, res): Promise<void> => {
  try {
    const id = String(req.params.id);
    if (!UUID_RE.test(id)) { res.status(400).json({ error: "ID non valido" }); return; }
    res.json({ profile: await loadProfile(id) });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.put("/planning-studio/projects/:id/calendar-profile", async (req, res): Promise<void> => {
  try {
    const id = String(req.params.id);
    if (!UUID_RE.test(id)) { res.status(400).json({ error: "ID non valido" }); return; }
    const b = req.body ?? {};
    const closedPeriods = Array.isArray(b.closedPeriods)
      ? b.closedPeriods
          .filter((p: any) => DATE_RE.test(p?.from) && DATE_RE.test(p?.to) && p.from <= p.to)
          .map((p: any) => ({
            from: p.from, to: p.to,
            // nome del periodo (es. "Estivo", "Natale"): identificazione umana
            ...(typeof p.label === "string" && p.label.trim() ? { label: p.label.trim().slice(0, 60) } : {}),
          }))
      : [];
    const summerPeriod = b.summerPeriod && DATE_RE.test(b.summerPeriod.from) && DATE_RE.test(b.summerPeriod.to)
      ? { from: b.summerPeriod.from, to: b.summerPeriod.to } : null;
    const extraHolidays = Array.isArray(b.extraHolidays)
      ? b.extraHolidays.filter((h: any) => /^(\d{4}-)?\d{2}-\d{2}$/.test(String(h)))
      : [];
    await db.execute(sql`
      INSERT INTO ps_calendar_profiles (project_id, closed_periods, summer_period, extra_holidays, updated_at)
      VALUES (${id}::uuid, ${JSON.stringify(closedPeriods)}::jsonb,
              ${summerPeriod ? JSON.stringify(summerPeriod) : null}::jsonb,
              ${JSON.stringify(extraHolidays)}::jsonb, now())
      ON CONFLICT (project_id) DO UPDATE SET
        closed_periods = EXCLUDED.closed_periods,
        summer_period = EXCLUDED.summer_period,
        extra_holidays = EXCLUDED.extra_holidays,
        updated_at = now()
    `);
    res.json({ ok: true, profile: { closedPeriods, summerPeriod, extraHolidays } });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get("/planning-studio/projects/:id/day-classification", async (req, res): Promise<void> => {
  try {
    const id = String(req.params.id);
    if (!UUID_RE.test(id)) { res.status(400).json({ error: "ID non valido" }); return; }
    const from = String(req.query.from ?? "");
    const to = String(req.query.to ?? "");
    if (!DATE_RE.test(from) || !DATE_RE.test(to) || from > to) {
      res.status(400).json({ error: "from/to YYYY-MM-DD richiesti (max 2 anni)" }); return;
    }
    const span = (new Date(to).getTime() - new Date(from).getTime()) / 86_400_000;
    if (span > 750) { res.status(400).json({ error: "Intervallo massimo 2 anni" }); return; }
    const profile = await loadProfile(id);
    res.json({ profile, ...classifyRange(from, to, profile) });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
