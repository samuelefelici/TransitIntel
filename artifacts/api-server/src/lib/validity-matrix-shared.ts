/**
 * PlannerStudio · Validity Matrix — algoritmo cell value (PURO, no I/O).
 *
 * Gemello server-side di
 *   artifacts/transitintel/src/lib/planning-studio/validity-matrix.ts
 *
 * Duplicato volutamente: i due tsconfig (api-server vs transitintel) hanno
 * roots diversi e cross-import romperebbe il build. Mantenere allineato
 * (entrambi sono pure ~150 righe, niente I/O, banalmente in sync).
 *
 * Riferimento: spec Cerbero · PlannerStudio Validity Matrix · v1 · §5
 */

export interface DayType {
  id: string;
  code: string;
  name: string;
  color: string;
  is_system: boolean;
}

export interface Trip {
  id: string;
  is_active: boolean;
  valid_from: string | null;
  valid_to: string | null;
}

export interface MatrixContext {
  trips: Map<string, Trip>;
  dayTypes: Map<string, DayType>;
  tripDayValidity: Map<string, Map<string, boolean>>;
  dayCalendar: Map<string, string>;
  tripExceptions: Map<string, Map<string, 1 | 2>>;
  patronSaints: Set<string>;
  /** maschera giorni-settimana per corsa: 7 boolean [Lun..Dom]; assente = tutti attivi */
  tripWeekdays?: Map<string, boolean[]>;
}

/** Indice giorno-settimana 0=Lun … 6=Dom di una data 'YYYY-MM-DD' (UTC). */
export function weekdayIndex(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return (new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1)).getUTCDay() + 6) % 7;
}

export function getCellValidity(
  ctx: MatrixContext,
  tripId: string,
  date: string,
): boolean {
  const ex = ctx.tripExceptions.get(tripId)?.get(date);
  if (ex === 1) return true;
  if (ex === 2) return false;

  const trip = ctx.trips.get(tripId);
  if (!trip || !trip.is_active) return false;
  if (trip.valid_from && date < trip.valid_from) return false;
  if (trip.valid_to && date > trip.valid_to) return false;

  const dayTypeId = ctx.dayCalendar.get(date) ?? inferDefaultDayType(date, ctx);
  if (!dayTypeId) return false;

  if (!(ctx.tripDayValidity.get(tripId)?.get(dayTypeId) ?? false)) return false;

  // Maschera giorni-settimana della corsa (es. feriale MA senza giovedì).
  const wd = ctx.tripWeekdays?.get(tripId);
  if (wd && wd.length === 7 && wd[weekdayIndex(date)] === false) return false;
  return true;
}

export function inferDefaultDayType(
  date: string,
  ctx: MatrixContext,
): string | null {
  const mmdd = date.slice(5);
  if (ctx.patronSaints.has(mmdd)) return findDayTypeIdByCode(ctx.dayTypes, "festivo");
  const [yy, mm, dd] = date.split("-").map(Number);
  const dow = new Date(Date.UTC(yy, (mm ?? 1) - 1, dd ?? 1)).getUTCDay();
  if (dow === 0) return findDayTypeIdByCode(ctx.dayTypes, "festivo");
  if (dow === 6) return findDayTypeIdByCode(ctx.dayTypes, "sabato");
  return findDayTypeIdByCode(ctx.dayTypes, "feriale");
}

function findDayTypeIdByCode(dayTypes: Map<string, DayType>, code: string): string | null {
  for (const dt of dayTypes.values()) {
    if (dt.code === code) return dt.id;
  }
  return null;
}

export function easterDate(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const t = Date.UTC(y, (m ?? 1) - 1, (d ?? 1)) + days * 86_400_000;
  const nd = new Date(t);
  return `${nd.getUTCFullYear()}-${String(nd.getUTCMonth() + 1).padStart(2, "0")}-${String(nd.getUTCDate()).padStart(2, "0")}`;
}

export function italianHolidays(year: number): string[] {
  const easter = easterDate(year);
  const easterMonday = addDays(easter, 1);
  return [
    `${year}-01-01`,
    `${year}-01-06`,
    easter,
    easterMonday,
    `${year}-04-25`,
    `${year}-05-01`,
    `${year}-06-02`,
    `${year}-08-15`,
    `${year}-11-01`,
    `${year}-12-08`,
    `${year}-12-25`,
    `${year}-12-26`,
  ];
}

/* ════════════════════════════════════════════════════════════
 *  Auto-import GTFS calendar → system day-types (pure)
 * ════════════════════════════════════════════════════════════ */

export interface CalendarWeeklyPattern {
  monday: boolean;
  tuesday: boolean;
  wednesday: boolean;
  thursday: boolean;
  friday: boolean;
  saturday: boolean;
  sunday: boolean;
}

/**
 * Mappa il pattern settimanale di un GTFS calendar nei codici dei system day-types.
 * Spec: pattern lun-ven (anche parziale) → "feriale"; sabato → "sabato"; domenica → "festivo".
 * Restituisce un array deduplicato. Pattern vuoto → [].
 */
export function mapCalendarPatternToSystemDayTypes(p: CalendarWeeklyPattern): string[] {
  const codes: string[] = [];
  if (p.monday || p.tuesday || p.wednesday || p.thursday || p.friday) codes.push("feriale");
  if (p.saturday) codes.push("sabato");
  if (p.sunday) codes.push("festivo");
  return codes;
}

/* ════════════════════════════════════════════════════════════
 *  Validatori puri usati dagli endpoint REST
 * ════════════════════════════════════════════════════════════ */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isUUID(s: unknown): s is string {
  return typeof s === "string" && UUID_RE.test(s);
}
export function isISODate(s: unknown): s is string {
  return typeof s === "string" && ISO_DATE_RE.test(s);
}

export type GenerateUnitInput = {
  name: string;
  description?: string;
  from: string;
  to: string;
  dayTypeIds: string[];
  includeOnlyValid?: boolean;
};

export type ValidationError = { ok: false; error: string };
export type ValidationOk<T> = { ok: true; value: T };
export type ValidationResult<T> = ValidationOk<T> | ValidationError;

/**
 * Valida payload POST /validity/generate-unit (PR4).
 * Pure function: nessun I/O. Restituisce un risultato discriminato.
 */
export function validateGenerateUnitInput(body: unknown): ValidationResult<GenerateUnitInput> {
  if (!body || typeof body !== "object") return { ok: false, error: "body mancante" };
  const b = body as Record<string, unknown>;
  if (typeof b.name !== "string" || b.name.trim().length === 0) {
    return { ok: false, error: "name è obbligatorio" };
  }
  if (!isISODate(b.from) || !isISODate(b.to) || (b.from as string) > (b.to as string)) {
    return { ok: false, error: "from/to non validi (atteso YYYY-MM-DD, from<=to)" };
  }
  if (!Array.isArray(b.dayTypeIds) || b.dayTypeIds.length === 0
      || !b.dayTypeIds.every(isUUID)) {
    return { ok: false, error: "dayTypeIds deve essere un array di UUID non vuoto" };
  }
  return {
    ok: true,
    value: {
      name: (b.name as string).trim(),
      description: typeof b.description === "string" ? b.description : undefined,
      from: b.from as string,
      to: b.to as string,
      dayTypeIds: b.dayTypeIds as string[],
      includeOnlyValid: b.includeOnlyValid !== false,
    },
  };
}

/**
 * Valida payload POST /validity/bulk (PR3).
 * 3 op: trip-row-set, date-column-set, clear-exceptions.
 * Pure function.
 */
export type BulkOp =
  | { op: "trip-row-set"; tripId: string; dayTypeIds: string[]; isValid: boolean }
  | { op: "date-column-set"; date: string; isValid: boolean }
  | { op: "clear-exceptions"; from: string; to: string };

export function validateBulkOpInput(body: unknown): ValidationResult<BulkOp> {
  if (!body || typeof body !== "object") return { ok: false, error: "body mancante" };
  const b = body as Record<string, unknown>;
  switch (b.op) {
    case "trip-row-set":
      if (!isUUID(b.tripId)) return { ok: false, error: "tripId UUID required" };
      if (!Array.isArray(b.dayTypeIds) || b.dayTypeIds.length === 0 || !b.dayTypeIds.every(isUUID)) {
        return { ok: false, error: "dayTypeIds UUID[] non vuoto required" };
      }
      if (typeof b.isValid !== "boolean") return { ok: false, error: "isValid bool required" };
      return { ok: true, value: { op: "trip-row-set", tripId: b.tripId as string, dayTypeIds: b.dayTypeIds as string[], isValid: b.isValid } };
    case "date-column-set":
      if (!isISODate(b.date)) return { ok: false, error: "date YYYY-MM-DD required" };
      if (typeof b.isValid !== "boolean") return { ok: false, error: "isValid bool required" };
      return { ok: true, value: { op: "date-column-set", date: b.date as string, isValid: b.isValid } };
    case "clear-exceptions":
      if (!isISODate(b.from) || !isISODate(b.to) || (b.from as string) > (b.to as string)) {
        return { ok: false, error: "from/to required (YYYY-MM-DD, from<=to)" };
      }
      return { ok: true, value: { op: "clear-exceptions", from: b.from as string, to: b.to as string } };
    default:
      return { ok: false, error: `op sconosciuto: ${String(b.op)}` };
  }
}
