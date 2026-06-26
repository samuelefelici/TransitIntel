/**
 * PlannerStudio · Validity Matrix — API client (PR2 frontend).
 *
 * Specchia gli endpoint di api-server/src/lib/planning-studio-validity.ts.
 */
import { apiFetch } from "@/lib/api";

/* ─── Tipi server ─── */

export interface PsDayType {
  id: string;
  projectId: string | null;     // NULL = system globale
  code: string;
  name: string;
  color: string;
  isSystem: boolean;
  isCustom: boolean;
  sortOrder: number;
  createdAt: string;
}

export interface PsValidityTrip {
  id: string;
  routeId: string;
  variantId: string;
  routeShortName: string | null;
  routeLongName: string | null;
  routeColor: string | null;
  variantName: string;
  headsign: string | null;
  shortName: string | null;
  direction: number | null;
  validFrom: string | null;
  validTo: string | null;
  isActive: boolean;
  serviceLabel: string | null;
  firstDeparture: string | null;
  firstStopName: string | null;   // luogo di partenza (prima fermata)
  lastStopName: string | null;    // luogo di arrivo (ultima fermata)
}

export interface PsDayCalendarEntry {
  date: string;        // YYYY-MM-DD
  dayTypeId: string;
  scope: "tenant" | "project";
  source: string;
  note: string | null;
}

export interface PsTripDayValidity {
  tripId: string;
  dayTypeId: string;
  isValid: boolean;
}

export interface PsTripExceptionMatrix {
  tripId: string;
  date: string;
  exceptionType: 1 | 2;   // 1 = add (forza valida), 2 = remove (forza invalida)
  reason: string | null;
}

export interface PsValidityMatrix {
  range: { from: string; to: string };
  trips: PsValidityTrip[];
  dayTypes: PsDayType[];
  dayCalendar: PsDayCalendarEntry[];
  tripDayValidity: PsTripDayValidity[];
  tripExceptions: PsTripExceptionMatrix[];
  patronSaints: string[];
}

/* ─── Day-types CRUD ─── */

export async function listPsDayTypes(projectId: string): Promise<PsDayType[]> {
  const r = await apiFetch<{ dayTypes: PsDayType[] }>(
    `/api/planning-studio/projects/${projectId}/day-types`,
  );
  return r.dayTypes;
}

export async function createPsDayType(
  projectId: string,
  input: { code: string; name: string; color: string; sort_order?: number },
): Promise<PsDayType> {
  const r = await apiFetch<{ dayType: PsDayType }>(
    `/api/planning-studio/projects/${projectId}/day-types`,
    { method: "POST", body: JSON.stringify(input) },
  );
  return r.dayType;
}

export async function updatePsDayType(
  projectId: string,
  dayTypeId: string,
  patch: Partial<{ name: string; color: string; sort_order: number }>,
): Promise<PsDayType> {
  const r = await apiFetch<{ dayType: PsDayType }>(
    `/api/planning-studio/projects/${projectId}/day-types/${dayTypeId}`,
    { method: "PATCH", body: JSON.stringify(patch) },
  );
  return r.dayType;
}

export async function deletePsDayType(projectId: string, dayTypeId: string): Promise<void> {
  await apiFetch<{ ok: boolean }>(
    `/api/planning-studio/projects/${projectId}/day-types/${dayTypeId}`,
    { method: "DELETE" },
  );
}

/* ─── Matrix bulk read ─── */

export async function getPsValidityMatrix(
  projectId: string,
  range: { from: string; to: string; routeId?: string | null },
): Promise<PsValidityMatrix> {
  const qs = new URLSearchParams({ from: range.from, to: range.to });
  if (range.routeId) qs.set("route_id", range.routeId);
  return apiFetch(
    `/api/planning-studio/projects/${projectId}/validity/matrix?${qs.toString()}`,
  );
}

/* ─── Mutations ─── */

export async function upsertPsTripDayValidity(
  projectId: string,
  input: { trip_id: string; day_type_id: string; is_valid: boolean },
): Promise<void> {
  await apiFetch<{ ok: boolean }>(
    `/api/planning-studio/projects/${projectId}/validity/trip-day`,
    { method: "PUT", body: JSON.stringify(input) },
  );
}

export async function upsertPsDayCalendar(
  projectId: string,
  input: { date: string; day_type_id: string; scope: "tenant" | "project"; note?: string },
): Promise<void> {
  await apiFetch<{ ok: boolean }>(
    `/api/planning-studio/projects/${projectId}/validity/day-calendar`,
    { method: "PUT", body: JSON.stringify(input) },
  );
}

export async function upsertPsTripException(
  projectId: string,
  input: { trip_id: string; date: string; exception_type: 1 | 2; reason?: string },
): Promise<void> {
  await apiFetch<{ ok: boolean }>(
    `/api/planning-studio/projects/${projectId}/validity/exception`,
    { method: "PUT", body: JSON.stringify(input) },
  );
}

export async function deletePsTripExceptionMatrix(
  projectId: string,
  input: { trip_id: string; date: string },
): Promise<void> {
  await apiFetch<{ ok: boolean }>(
    `/api/planning-studio/projects/${projectId}/validity/exception`,
    { method: "DELETE", body: JSON.stringify(input) },
  );
}

/* ─── Bulk operations (PR3) ─── */

export type BulkOp =
  | { op: "trip-row-set"; tripId: string; dayTypeIds: string[]; isValid: boolean }
  | { op: "date-column-set"; date: string; isValid: boolean }
  | { op: "clear-exceptions"; from: string; to: string; tripIds?: string[] };

export async function postPsValidityBulk(
  projectId: string, body: BulkOp,
): Promise<{ ok: true; count: number; tripCount?: number }> {
  return apiFetch(
    `/api/planning-studio/projects/${projectId}/validity/bulk`,
    { method: "POST", body: JSON.stringify(body) },
  );
}

/* ─── Auto-import da GTFS calendars (PR3) ─── */

export interface AutoImportSummary {
  ok: true;
  dryRun: boolean;
  summary: { calendars: number; validityUpserts: number; exceptionInserts: number };
  perCalendar: Array<{
    calendarId: string;
    calendarCode: string | null;
    tripCount: number;
    dayTypeCount: number;
    validityRowsToWrite: number;
    exceptionRowsToWrite: number;
  }>;
}

export async function autoImportPsValidityFromCalendars(
  projectId: string, opts: { dryRun?: boolean } = {},
): Promise<AutoImportSummary> {
  return apiFetch(
    `/api/planning-studio/projects/${projectId}/validity/auto-import-from-calendars`,
    { method: "POST", body: JSON.stringify({ dryRun: !!opts.dryRun }) },
  );
}

/* ─── Generate Unità di Progettazione (PR4) ─── */

export interface GenerateUnitInput {
  name: string;
  description?: string;
  from: string;          // YYYY-MM-DD
  to: string;            // YYYY-MM-DD
  dayTypeIds: string[];
  includeOnlyValid?: boolean;  // default true
}

export interface GenerateUnitResult {
  ok: true;
  schedulingProjectId: string;
  name: string;
}

export async function postPsValidityGenerateUnit(
  projectId: string, input: GenerateUnitInput,
): Promise<GenerateUnitResult> {
  return apiFetch(
    `/api/planning-studio/projects/${projectId}/validity/generate-unit`,
    { method: "POST", body: JSON.stringify(input) },
  );
}

/* ─── Routes (per filtro UI quando i trip sono troppi) ─── */

export interface PsValidityRoute {
  id: string;
  shortName: string | null;
  longName: string | null;
  color: string | null;
  tripCount: number;
}

export async function listPsValidityRoutes(projectId: string): Promise<PsValidityRoute[]> {
  const r = await apiFetch<{ routes: PsValidityRoute[] }>(
    `/api/planning-studio/projects/${projectId}/validity/routes`,
  );
  return r.routes;
}
