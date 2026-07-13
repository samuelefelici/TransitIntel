/**
 * Planning Studio — Valutazione della VALIDITÀ EFFETTIVA (corsa × data).
 *
 * Sorgente unica per "in quali date circola davvero ogni corsa", secondo la
 * MATRICE DI VALIDITÀ (non il calendario legacy ps_calendars). Riusata da:
 *   - la materializzazione GTFS (planning-studio-materialize): traduce la
 *     validità effettiva in gtfs_calendar_dates così il feed d'esercizio
 *     coincide col programmato;
 *   - (potenzialmente) l'export GTFS esterno.
 *
 * ⚠️ ALLINEAMENTO: il loop di validità qui sotto (gli 8 passi) è la copia
 * autoritativa del compute UDP in planning-studio-validity-units.ts:444-478.
 * Se cambi le regole di validità in un file, allinea l'altro. Un unit test
 * (planning-studio-validity-eval.test.ts) verifica la parità dei due esiti.
 *
 * NON usare validity-matrix-shared.getCellValidity: è una copia server
 * incompleta (manca lo step categorie/ombrello), viva solo nei test.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

/**
 * Il progetto usa la MATRICE di validità? (≥1 bollino corsa×day-type).
 * Discrimina, nella materializzazione, tra feed "validità effettiva"
 * (calendar_dates puri) e feed legacy (ps_calendars settimanale). Stessa
 * semantica dell'omonima in routes/planning-studio-timetables.ts.
 */
export async function projectHasTripValidity(projectId: string): Promise<boolean> {
  const r = await db.execute<any>(sql`
    SELECT EXISTS(
      SELECT 1 FROM ps_trip_day_validity v
      JOIN ps_trips t ON t.id = v.trip_id
      WHERE t.project_id = ${projectId}::uuid
    ) AS has`);
  return !!r.rows?.[0]?.has;
}

export interface ValidityEvalInput {
  projectId: string;
  /** 'YYYY-MM-DD' inclusivo */
  from: string;
  /** 'YYYY-MM-DD' inclusivo */
  to: string;
  /** Scoping opzionale (UDP): se presente e non vuoto, valuta SOLO queste corse. */
  tripIds?: string[] | null;
}

/* ── helper date (identici a validity-units per coerenza) ────────── */
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
/** indice giorno-settimana 0=Lun … 6=Dom (UTC), coerente con la matrice. */
function wdIndexOf(date: string): number {
  const [yy, mm, dd] = date.split("-").map(Number);
  return (new Date(Date.UTC(yy, (mm ?? 1) - 1, dd ?? 1)).getUTCDay() + 6) % 7;
}
/** 'YYYY-MM-DD' → 'YYYYMMDD' (formato GTFS). */
function toGtfsDate(iso: string): string {
  return iso.replace(/-/g, "");
}

/* ── valutazione PURA (testabile senza DB) ───────────────────────
 * Replica 1:1 gli 8 passi di validity-units.ts:444-478. È il cuore
 * autoritativo; computeActiveDatesByTrip qui sotto la nutre con i dati
 * caricati dal DB, l'unit test la esercita con casi costruiti a mano. */

export interface TripValidityFacts {
  isActive: boolean;
  validFrom: string | null; // ISO 'YYYY-MM-DD' o null
  validTo: string | null;
  /** maschera [Lun..Dom]; null/assente = tutti i giorni attivi */
  weekdays?: boolean[] | null;
  prototype?: boolean;
  /** id categoria assegnate alla corsa (vincolo calendario aziendale) */
  categoryIds?: Set<string> | null;
  /** la corsa ha la categoria NUDA scuole_chiuse (ombrello su ogni periodo) */
  umbrellaChiuse?: boolean;
}

export interface DayFacts {
  /** day-type della data (già risolto: override o inferenza); null = nessuno */
  dayTypeId: string | null;
  /** categoria del giorno dal calendario aziendale; null = nessuna */
  category: { id: string; code: string } | null;
  /** eccezione puntuale corsa×data: 1=force ON, 2=force OFF; undefined = nessuna */
  exception?: 1 | 2;
}

/**
 * La corsa circola nella data? `date` in ISO; `dayValidity` mappa dayTypeId→bool
 * (assenza = false). Precedenza: eccezione > is_active > valid_from/to >
 * day-type presente > day_validity > maschera weekdays > vincolo categorie(+ombrello).
 */
export function isTripActiveOnDate(
  date: string,
  trip: TripValidityFacts,
  day: DayFacts,
  dayValidity: Map<string, boolean>,
): boolean {
  if (trip.prototype) return false;
  if (day.exception === 2) return false;
  if (day.exception === 1) return true;
  if (!trip.isActive) return false;
  if (trip.validFrom && date < trip.validFrom) return false;
  if (trip.validTo && date > trip.validTo) return false;
  if (!day.dayTypeId) return false;
  let active = !!dayValidity.get(day.dayTypeId);
  const wd = trip.weekdays;
  if (active && Array.isArray(wd) && wd.length === 7 && wd[wdIndexOf(date)] === false) {
    active = false;
  }
  const cats = trip.categoryIds;
  if (active && cats && cats.size > 0) {
    const cat = day.category;
    let match = !!cat && cats.has(cat.id);
    if (!match && cat && trip.umbrellaChiuse
        && typeof cat.code === "string" && cat.code.startsWith("scuole_chiuse")) {
      match = true;
    }
    active = match;
  }
  return active;
}

/**
 * Deriva il day-type di ogni data: priorità override project > global >
 * inferenza (patrono/domenica→festivo, sabato→sabato, altro→feriale).
 * Copia allineata a planning-studio-validity-units.ts buildDayTypeMap:153-195.
 */
async function buildDayTypeMap(
  projectId: string,
  dates: string[],
  patronSaints: Set<string>,
): Promise<Map<string, string | null>> {
  const sysR = await db.execute(sql`
    SELECT id, code FROM ps_day_types WHERE project_id IS NULL
  `);
  const sysIdByCode = new Map<string, string>();
  for (const r of (sysR as any).rows ?? []) sysIdByCode.set(r.code, r.id);

  const datesLiteral = `{${dates.join(",")}}`;
  const calR = await db.execute(sql`
    SELECT to_char(date, 'YYYY-MM-DD') AS date, day_type_id, project_id
      FROM ps_day_calendar
     WHERE (project_id = ${projectId}::uuid OR project_id IS NULL)
       AND date = ANY(${datesLiteral}::date[])
  `);
  const projectOverride = new Map<string, string>();
  const globalOverride = new Map<string, string>();
  for (const r of (calR as any).rows ?? []) {
    if (r.project_id) projectOverride.set(r.date, r.day_type_id);
    else globalOverride.set(r.date, r.day_type_id);
  }

  const map = new Map<string, string | null>();
  for (const d of dates) {
    if (projectOverride.has(d)) { map.set(d, projectOverride.get(d)!); continue; }
    if (globalOverride.has(d)) { map.set(d, globalOverride.get(d)!); continue; }
    const [yy, mm, dd] = d.split("-").map(Number);
    const dow = new Date(yy, mm - 1, dd).getDay(); // 0=dom
    if (patronSaints.has(d)) { map.set(d, sysIdByCode.get("festivo") ?? null); continue; }
    if (dow === 0) { map.set(d, sysIdByCode.get("festivo") ?? null); continue; }
    if (dow === 6) { map.set(d, sysIdByCode.get("sabato") ?? null); continue; }
    map.set(d, sysIdByCode.get("feriale") ?? null);
  }
  return map;
}

/**
 * Per ogni corsa (attiva in ≥1 data del range), l'insieme ORDINATO di date
 * 'YYYYMMDD' in cui circola davvero secondo la matrice di validità.
 * Esclude i prototipi. Le corse mai attive non compaiono nella mappa.
 */
export async function computeActiveDatesByTrip(
  input: ValidityEvalInput,
): Promise<Map<string, string[]>> {
  const { projectId, from, to } = input;
  const scoped = Array.isArray(input.tripIds) && input.tripIds.length > 0;
  const scopeLit = scoped ? `{${input.tripIds!.join(",")}}` : "";

  const dates = isoRange(from, to);
  const result = new Map<string, string[]>();
  if (dates.length === 0) return result;

  // Patroni locali (formato ISO da agency_settings.patronSaintDates)
  const projR = await db.execute(sql`
    SELECT agency_settings FROM ps_projects WHERE id = ${projectId}::uuid LIMIT 1
  `);
  const settings = ((projR as any).rows?.[0]?.agency_settings as any) || {};
  const patronSaints = new Set<string>();
  if (Array.isArray(settings.patronSaintDates)) {
    for (const d of settings.patronSaintDates) {
      if (typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d)) patronSaints.add(d);
    }
  }

  // Calendario categorie: merged PROJECT > GLOBAL (5B) — la riga del progetto
  // vince, quella globale legacy è il fallback per le date scoperte.
  const datesArrLiteral = `{${dates.join(",")}}`;
  const catCalR = await db.execute(sql`
    SELECT DISTINCT ON (c.date)
           to_char(c.date, 'YYYY-MM-DD') AS date, c.category_id, cat.code AS category_code
      FROM ps_validity_category_calendar c
      LEFT JOIN ps_validity_categories cat ON cat.id = c.category_id
     WHERE (c.project_id = ${projectId}::uuid OR c.project_id IS NULL)
       AND c.date = ANY(${datesArrLiteral}::date[])
     ORDER BY c.date, c.project_id ASC NULLS LAST
  `);
  const catByDate = new Map<string, { id: string; code: string }>();
  for (const r of (catCalR as any).rows ?? []) {
    catByDate.set(r.date, { id: r.category_id, code: r.category_code });
  }

  // Day-type per data
  const dtMap = await buildDayTypeMap(projectId, dates, patronSaints);

  // Trips + range/is_active/attributes (con scoping opzionale)
  const fTrip = scoped ? sql`AND t.id = ANY(${scopeLit}::uuid[])` : sql``;
  const tripsR = await db.execute(sql`
    SELECT t.id, t.is_active, t.attributes,
           to_char(t.valid_from, 'YYYY-MM-DD') AS valid_from,
           to_char(t.valid_to,   'YYYY-MM-DD') AS valid_to
      FROM ps_trips t
     WHERE t.project_id = ${projectId}::uuid ${fTrip}
  `);
  const trips = ((tripsR as any).rows ?? []) as Array<{
    id: string; is_active: boolean; attributes: Record<string, any> | null;
    valid_from: string | null; valid_to: string | null;
  }>;
  if (trips.length === 0) return result;
  const tripIds = trips.map((t) => t.id);
  const tripIdsLit = `{${tripIds.join(",")}}`;

  // tripDayValidity: trip × dayType → bool
  const tdvMap = new Map<string, Map<string, boolean>>();
  const tdvR = await db.execute(sql`
    SELECT trip_id, day_type_id, is_valid FROM ps_trip_day_validity
     WHERE trip_id = ANY(${tripIdsLit}::uuid[])
  `);
  for (const r of (tdvR as any).rows ?? []) {
    if (!tdvMap.has(r.trip_id)) tdvMap.set(r.trip_id, new Map());
    tdvMap.get(r.trip_id)!.set(r.day_type_id, !!r.is_valid);
  }

  // Eccezioni: trip × date → 1|2
  const excMap = new Map<string, Map<string, 1 | 2>>();
  const excR = await db.execute(sql`
    SELECT trip_id, to_char(date, 'YYYY-MM-DD') AS date, exception_type
      FROM ps_trip_exceptions
     WHERE trip_id = ANY(${tripIdsLit}::uuid[])
       AND date >= ${from}::date AND date <= ${to}::date
  `);
  for (const r of (excR as any).rows ?? []) {
    if (!excMap.has(r.trip_id)) excMap.set(r.trip_id, new Map());
    excMap.get(r.trip_id)!.set(r.date, r.exception_type === 1 ? 1 : 2);
  }

  // Vincolo categorie per corsa + ombrello scuole_chiuse
  const tripCatMap = new Map<string, Set<string>>();
  const tripUmbrellaChiuse = new Set<string>();
  const tcR = await db.execute(sql`
    SELECT tc.trip_id, tc.category_id, cat.code AS category_code
      FROM ps_trip_category_validity tc
      LEFT JOIN ps_validity_categories cat ON cat.id = tc.category_id
     WHERE tc.trip_id = ANY(${tripIdsLit}::uuid[])
  `);
  for (const r of (tcR as any).rows ?? []) {
    if (!tripCatMap.has(r.trip_id)) tripCatMap.set(r.trip_id, new Set());
    tripCatMap.get(r.trip_id)!.add(r.category_id);
    if (r.category_code === "scuole_chiuse") tripUmbrellaChiuse.add(r.trip_id);
  }

  /* ── loop: valuta ogni (data, corsa) con la funzione pura ── */
  const emptyValidity = new Map<string, boolean>();
  for (const d of dates) {
    const day: DayFacts = {
      dayTypeId: dtMap.get(d) ?? null,
      category: catByDate.get(d) ?? null,
    };
    for (const t of trips) {
      const facts: TripValidityFacts = {
        isActive: t.is_active,
        validFrom: t.valid_from,
        validTo: t.valid_to,
        weekdays: (t.attributes as any)?.weekdays ?? null,
        prototype: !!(t.attributes as any)?.prototype,
        categoryIds: tripCatMap.get(t.id) ?? null,
        umbrellaChiuse: tripUmbrellaChiuse.has(t.id),
      };
      day.exception = excMap.get(t.id)?.get(d);
      if (!isTripActiveOnDate(d, facts, day, tdvMap.get(t.id) ?? emptyValidity)) continue;
      let arr = result.get(t.id);
      if (!arr) { arr = []; result.set(t.id, arr); }
      arr.push(toGtfsDate(d));
    }
  }
  // date già in ordine crescente (il range è ordinato); garanzia esplicita
  for (const arr of result.values()) arr.sort();
  return result;
}
