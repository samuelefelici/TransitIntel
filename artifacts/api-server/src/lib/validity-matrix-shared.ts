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

  return ctx.tripDayValidity.get(tripId)?.get(dayTypeId) ?? false;
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
