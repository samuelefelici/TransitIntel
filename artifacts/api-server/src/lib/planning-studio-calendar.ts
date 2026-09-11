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

/** Gate di accesso al profilo calendario. mode="read": owner/membro/admin o
 *  programma operativo (come la lista progetti). mode="write": owner o membro
 *  editor/owner — la PUT riscrive il calendario E risincronizza le categorie
 *  del progetto, quindi niente scritture cross-progetto. */
async function requireCalendarAccess(
  projectId: string, req: any, res: any, mode: "read" | "write",
): Promise<boolean> {
  const u = (req as any).user;
  if (!u) { res.status(401).json({ error: "Non autenticato" }); return false; }
  if (u.role === "admin") return true;
  const r = await db.execute<any>(sql`
    SELECT 1 FROM ps_projects p
      LEFT JOIN ps_project_members pm ON pm.project_id = p.id AND pm.user_id = ${u.id}::uuid
      LEFT JOIN gtfs_feeds f ON f.id = p.materialized_feed_id
     WHERE p.id = ${projectId}::uuid
       AND (
         p.owner_user_id = ${u.id}::uuid
         OR (${mode === "write"} AND pm.role IN ('owner','editor'))
         OR (${mode === "read"} AND (pm.user_id IS NOT NULL
             OR (p.materialized_feed_id IS NOT NULL AND COALESCE(f.is_active, false))))
       )
     LIMIT 1`);
  if (!r.rows?.length) {
    res.status(403).json({ error: "Accesso negato al progetto" });
    return false;
  }
  return true;
}

export async function loadCalendarProfile(projectId: string): Promise<CalendarProfile> {
  await ensureTable();
  return loadProfile(projectId);
}

/* ── Quale calendario usa l'esercizio ─────────────────────────────────────
 * Sala Operativa e Tempi di Percorrenza classificano le giornate in scuole
 * aperte/chiuse, e per farlo serve un calendario aziendale. Finora andava
 * passato a mano nell'indirizzo: in pratica non lo passava nessuno, e ogni
 * verdetto usciva classificato sul solo calendario civile — cioè con agosto
 * trattato come un feriale scolastico qualunque.
 *
 * Non si indovina e non si cabla un id nel codice: si guarda quali progetti
 * hanno un calendario COMPILATO. Se è uno solo, è quello. Se sono più d'uno
 * non si sceglie: classificare l'esercizio col calendario sbagliato è peggio
 * che dichiarare di non saperlo, perché il risultato è plausibile.
 */
export interface CalendarioPredefinito {
  projectId: string | null;
  /** quanti progetti hanno un calendario compilato */
  candidati: number;
  nota: string;
}

/**
 * La scelta, separata dalla query perché è la parte che può sbagliare in modo
 * silenzioso: un progetto scelto a caso non dà errore, dà verdetti plausibili.
 */
export function decidiCalendario(
  righe: Array<{ id: string; name?: string | null }>,
): CalendarioPredefinito {
  if (righe.length === 1) {
    return {
      projectId: String(righe[0].id), candidati: 1,
      nota: `Calendario aziendale dal progetto «${righe[0].name ?? righe[0].id}»: `
        + "è l'unico con i periodi scolastici compilati.",
    };
  }
  if (righe.length === 0) {
    return {
      projectId: null, candidati: 0,
      nota: "Nessun progetto ha i periodi scolastici compilati: le classi si "
        + "basano su giorno della settimana e festività nazionali, e scuole "
        + "aperte o chiuse non sono distinguibili.",
    };
  }
  /* Con più candidati NON si sceglie. Classificare l'esercizio col calendario
   * sbagliato è peggio che dichiarare di non saperlo: il risultato è
   * plausibile, e nessuno va a ricontrollarlo. */
  return {
    projectId: null, candidati: righe.length,
    nota: `${righe.length} progetti hanno un calendario compilato `
      + `(${righe.slice(0, 3).map(x => `«${x.name ?? x.id}»`).join(", ")}`
      + `${righe.length > 3 ? ", …" : ""}): indica quale usare con psProjectId. `
      + "Sceglierne uno a caso darebbe verdetti plausibili e sbagliati.",
  };
}

let cachedPredefinito: { v: CalendarioPredefinito; at: number } | null = null;
const PREDEFINITO_TTL_MS = 10 * 60 * 1000;

export async function calendarioPredefinito(): Promise<CalendarioPredefinito> {
  if (cachedPredefinito && Date.now() - cachedPredefinito.at < PREDEFINITO_TTL_MS) {
    return cachedPredefinito.v;
  }
  let v: CalendarioPredefinito;
  try {
    await ensureTable();
    /* "Compilato" vuol dire che qualcuno ha davvero detto quando le scuole
     * sono chiuse o quando è estate: una riga vuota equivale a non averla. */
    const r = await db.execute<any>(sql`
      SELECT cp.project_id::text AS id, p.name
        FROM ps_calendar_profiles cp
        LEFT JOIN ps_projects p ON p.id = cp.project_id
       WHERE jsonb_array_length(COALESCE(cp.closed_periods, '[]'::jsonb)) > 0
          OR cp.summer_period IS NOT NULL
       ORDER BY cp.updated_at DESC`);
    v = decidiCalendario((r as any).rows ?? []);
  } catch (e: any) {
    /* Planning Studio non installato o tabella assente: non è un guasto
     * dell'esercizio, si resta sul calendario civile. */
    v = {
      projectId: null, candidati: 0,
      nota: "Calendario aziendale non leggibile: classi basate su giorno della "
        + "settimana e festività nazionali.",
    };
  }
  cachedPredefinito = { v, at: Date.now() };
  return v;
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
    if (!(await requireCalendarAccess(id, req, res, "read"))) return;
    res.json({ profile: await loadProfile(id) });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.put("/planning-studio/projects/:id/calendar-profile", async (req, res): Promise<void> => {
  try {
    const id = String(req.params.id);
    if (!UUID_RE.test(id)) { res.status(400).json({ error: "ID non valido" }); return; }
    if (!(await requireCalendarAccess(id, req, res, "write"))) return;
    const b = req.body ?? {};
    const closedPeriods = Array.isArray(b.closedPeriods)
      ? b.closedPeriods
          .filter((p: any) => DATE_RE.test(p?.from) && DATE_RE.test(p?.to) && p.from <= p.to)
          .map((p: any) => ({
            from: p.from, to: p.to,
            // nome del periodo (es. "Estivo", "Natale"): identificazione umana
            ...(typeof p.label === "string" && p.label.trim() ? { label: p.label.trim().slice(0, 60) } : {}),
            // sotto-ramo scuole chiuse: estivo | invernale (default invernale)
            ...(p.kind === "estivo" || p.kind === "invernale" ? { kind: p.kind } : {}),
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
    // RISINCRONIZZA subito le categorie dal profilo appena salvato: senza
    // questo passo il calendario categorie-per-data (ps_validity_category_
    // calendar) e le assegnazioni corsa→categoria (ps_trip_category_validity)
    // restavano sulla classificazione VECCHIA finché non si rilanciava a mano
    // l'auto-import — e il filtro corse per categoria usava periodi superati.
    // Import dinamico per evitare il ciclo (validity importa da questo modulo).
    let sync: { categoryDates: number; tripCategoryUpserts: number; tripsWithCategories: number } | null = null;
    let syncError: string | null = null;
    try {
      const { syncValidityCategoriesFromProfile } = await import("./planning-studio-validity");
      sync = await syncValidityCategoriesFromProfile(id);
    } catch (e: any) {
      syncError = e?.message ?? String(e);
      console.error("[calendar-profile] sync categorie fallito:", syncError);
    }
    res.json({ ok: true, profile: { closedPeriods, summerPeriod, extraHolidays }, sync, syncError });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get("/planning-studio/projects/:id/day-classification", async (req, res): Promise<void> => {
  try {
    const id = String(req.params.id);
    if (!UUID_RE.test(id)) { res.status(400).json({ error: "ID non valido" }); return; }
    if (!(await requireCalendarAccess(id, req, res, "read"))) return;
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
