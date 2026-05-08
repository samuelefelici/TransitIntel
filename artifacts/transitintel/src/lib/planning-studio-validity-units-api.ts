/**
 * PlannerStudio · Categorie Calendario di Validità + Unità di Progettazione
 *
 * Client per i 2 nuovi router backend:
 *   - planning-studio-validity-categories.ts (GLOBALE)
 *   - planning-studio-validity-units.ts (per progetto)
 */
import { apiFetch } from "@/lib/api";

/* ════════════════════════════════════════════════════════════
 *  CATEGORIE (globali)
 * ════════════════════════════════════════════════════════════ */

export interface PsValidityCategory {
  id: string;
  code: string;
  name: string;
  color: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface PsValidityCategoryCalendarEntry {
  date: string;          // YYYY-MM-DD
  categoryId: string;
}

export function listPsValidityCategories(): Promise<PsValidityCategory[]> {
  return apiFetch<PsValidityCategory[]>("/api/planning-studio/validity-categories");
}

export function createPsValidityCategory(input: {
  code: string; name: string; color: string; sortOrder?: number;
}): Promise<PsValidityCategory> {
  return apiFetch<PsValidityCategory>("/api/planning-studio/validity-categories", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updatePsValidityCategory(
  catId: string,
  patch: { name?: string; color?: string; sortOrder?: number },
): Promise<PsValidityCategory> {
  return apiFetch<PsValidityCategory>(`/api/planning-studio/validity-categories/${catId}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export function deletePsValidityCategory(catId: string): Promise<{ ok: true }> {
  return apiFetch<{ ok: true }>(`/api/planning-studio/validity-categories/${catId}`, {
    method: "DELETE",
  });
}

export function listPsValidityCategoryCalendar(params: {
  from: string; to: string;
}): Promise<PsValidityCategoryCalendarEntry[]> {
  const qs = new URLSearchParams({ from: params.from, to: params.to }).toString();
  return apiFetch<PsValidityCategoryCalendarEntry[]>(
    `/api/planning-studio/validity-categories/calendar?${qs}`,
  );
}

/** Upsert/Delete bulk: passa categoryId=null per rimuovere. */
export function setPsValidityCategoryCalendar(input: {
  dates: string[]; categoryId: string | null;
}): Promise<{ ok: true; count: number; op: "upsert" | "delete" }> {
  return apiFetch(`/api/planning-studio/validity-categories/calendar`, {
    method: "PUT",
    body: JSON.stringify({ dates: input.dates, category_id: input.categoryId }),
  });
}

/* ════════════════════════════════════════════════════════════
 *  UNITÀ DI PROGETTAZIONE
 * ════════════════════════════════════════════════════════════ */

export interface PsValidityUnitComputed {
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
  alreadySaved: boolean;
}

export interface PsValidityUnit {
  id: string;
  validityId: string;
  name: string;
  description: string | null;
  categoryId: string | null;
  categoryName: string | null;
  categoryColor: string | null;
  dayTypeId: string | null;
  dayTypeName: string | null;
  dayTypeColor: string | null;
  tripIds: string[];
  tripCount: number;
  representativeDates: string[];
  dayCount: number;
  createdAt: string;
  updatedAt: string;
}

export function computePsValidityUnits(projectId: string, input: {
  from: string; to: string;
}): Promise<{ from: string; to: string; totalDays: number; totalGroups: number; units: PsValidityUnitComputed[] }> {
  return apiFetch(`/api/planning-studio/projects/${projectId}/validity-units/compute`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function savePsValidityUnits(projectId: string, units: Array<{
  validityId: string;
  name: string;
  description?: string;
  categoryId?: string | null;
  dayTypeId?: string | null;
  tripIds: string[];
  tripCount?: number;
  dates: string[];
  dayCount?: number;
}>): Promise<{ ok: true; count: number }> {
  return apiFetch(`/api/planning-studio/projects/${projectId}/validity-units/save`, {
    method: "POST",
    body: JSON.stringify({ units }),
  });
}

export function listPsValidityUnits(projectId: string): Promise<PsValidityUnit[]> {
  return apiFetch<PsValidityUnit[]>(`/api/planning-studio/projects/${projectId}/validity-units`);
}

export function deletePsValidityUnit(projectId: string, unitId: string): Promise<{ ok: true }> {
  return apiFetch<{ ok: true }>(
    `/api/planning-studio/projects/${projectId}/validity-units/${unitId}`,
    { method: "DELETE" },
  );
}

export function renamePsValidityUnit(projectId: string, unitId: string, patch: {
  name?: string; description?: string;
}): Promise<{ id: string; name: string; description: string | null; updated_at: string }> {
  return apiFetch(`/api/planning-studio/projects/${projectId}/validity-units/${unitId}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}
