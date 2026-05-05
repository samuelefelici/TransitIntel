/**
 * Client API per Vehicle/Driver Schedules come "progetti" condivisi (Step 7 livelli 2-3).
 *
 * Modello:
 *   PsProject ──< SchedulingProject ──< VehicleSchedule (turni macchina)
 *                                              └──< DriverSchedule (turni guida)
 *
 * Ogni VS/DS ha owner, flag is_shared, lista membri.
 * Endpoint backend: artifacts/api-server/src/lib/schedule-shares.ts
 */
import { apiFetch } from "@/lib/api";

export type ScheduleRole = "owner" | "editor" | "viewer";

export interface VehicleScheduleProject {
  id: string;
  name: string;
  description: string | null;
  date: string;                         // YYYYMMDD
  feedId: string | null;
  schedulingProjectId: string | null;
  schedulingProjectName?: string;
  ownerUserId: string | null;
  ownerEmail?: string;
  ownerFullName?: string | null;
  isShared: boolean;
  memberCount?: number;
  myRole?: ScheduleRole;
  numVehicles: number | null;
  totalDeadheadKm: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface DriverScheduleProject {
  id: string;
  name: string;
  description: string | null;
  vehicleScheduleId: string;
  vehicleScheduleName?: string;
  schedulingProjectId: string | null;
  ownerUserId: string | null;
  ownerEmail?: string;
  ownerFullName?: string | null;
  isShared: boolean;
  memberCount?: number;
  myRole?: ScheduleRole;
  totalDriverShifts: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduleMember {
  userId: string;
  email: string | null;
  fullName: string | null;
  role: ScheduleRole;
  addedAt: string;
  addedBy: string | null;
}

/* ───────────────────── Vehicle Schedules ───────────────────── */

export async function listVehicleSchedules(
  opts: { schedulingProjectId?: string; mineOnly?: boolean } = {},
): Promise<VehicleScheduleProject[]> {
  const qs = new URLSearchParams();
  if (opts.schedulingProjectId) qs.set("schedulingProjectId", opts.schedulingProjectId);
  if (opts.mineOnly) qs.set("mineOnly", "1");
  const q = qs.toString();
  const r = await apiFetch<{ vehicleSchedules: VehicleScheduleProject[] }>(
    `/api/vehicle-schedules${q ? `?${q}` : ""}`,
  );
  return r.vehicleSchedules;
}

export async function getVehicleSchedule(id: string): Promise<VehicleScheduleProject> {
  const r = await apiFetch<{ vehicleSchedule: VehicleScheduleProject }>(`/api/vehicle-schedules/${id}`);
  return r.vehicleSchedule;
}

export async function updateVehicleSchedule(
  id: string,
  patch: { name?: string; description?: string | null; isShared?: boolean; claimOwnership?: boolean },
): Promise<VehicleScheduleProject> {
  const r = await apiFetch<{ vehicleSchedule: VehicleScheduleProject }>(
    `/api/vehicle-schedules/${id}`,
    { method: "PATCH", body: JSON.stringify(patch) },
  );
  return r.vehicleSchedule;
}

export async function deleteVehicleSchedule(id: string): Promise<void> {
  await apiFetch<{ ok: boolean }>(`/api/vehicle-schedules/${id}`, { method: "DELETE" });
}

export async function listVehicleScheduleMembers(id: string): Promise<ScheduleMember[]> {
  const r = await apiFetch<{ members: ScheduleMember[] }>(`/api/vehicle-schedules/${id}/members`);
  return r.members;
}
export async function addVehicleScheduleMember(
  id: string, userId: string, role: "editor" | "viewer" = "editor",
): Promise<void> {
  await apiFetch<{ ok: boolean }>(
    `/api/vehicle-schedules/${id}/members`,
    { method: "POST", body: JSON.stringify({ userId, role }) },
  );
}
export async function removeVehicleScheduleMember(id: string, userId: string): Promise<void> {
  await apiFetch<{ ok: boolean }>(
    `/api/vehicle-schedules/${id}/members/${userId}`, { method: "DELETE" },
  );
}

/* ───────────────────── Driver Schedules ───────────────────── */

export async function listDriverSchedules(
  opts: { vehicleScheduleId?: string; schedulingProjectId?: string; mineOnly?: boolean } = {},
): Promise<DriverScheduleProject[]> {
  const qs = new URLSearchParams();
  if (opts.vehicleScheduleId) qs.set("vehicleScheduleId", opts.vehicleScheduleId);
  if (opts.schedulingProjectId) qs.set("schedulingProjectId", opts.schedulingProjectId);
  if (opts.mineOnly) qs.set("mineOnly", "1");
  const q = qs.toString();
  const r = await apiFetch<{ driverSchedules: DriverScheduleProject[] }>(
    `/api/driver-schedules${q ? `?${q}` : ""}`,
  );
  return r.driverSchedules;
}

export async function getDriverSchedule(id: string): Promise<DriverScheduleProject> {
  const r = await apiFetch<{ driverSchedule: DriverScheduleProject }>(`/api/driver-schedules/${id}`);
  return r.driverSchedule;
}

export async function updateDriverSchedule(
  id: string,
  patch: { name?: string; description?: string | null; isShared?: boolean; claimOwnership?: boolean },
): Promise<DriverScheduleProject> {
  const r = await apiFetch<{ driverSchedule: DriverScheduleProject }>(
    `/api/driver-schedules/${id}`,
    { method: "PATCH", body: JSON.stringify(patch) },
  );
  return r.driverSchedule;
}

export async function deleteDriverSchedule(id: string): Promise<void> {
  await apiFetch<{ ok: boolean }>(`/api/driver-schedules/${id}`, { method: "DELETE" });
}

export async function listDriverScheduleMembers(id: string): Promise<ScheduleMember[]> {
  const r = await apiFetch<{ members: ScheduleMember[] }>(`/api/driver-schedules/${id}/members`);
  return r.members;
}
export async function addDriverScheduleMember(
  id: string, userId: string, role: "editor" | "viewer" = "editor",
): Promise<void> {
  await apiFetch<{ ok: boolean }>(
    `/api/driver-schedules/${id}/members`,
    { method: "POST", body: JSON.stringify({ userId, role }) },
  );
}
export async function removeDriverScheduleMember(id: string, userId: string): Promise<void> {
  await apiFetch<{ ok: boolean }>(
    `/api/driver-schedules/${id}/members/${userId}`, { method: "DELETE" },
  );
}
