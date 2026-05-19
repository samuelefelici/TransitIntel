import { useCallback } from "react";
import { toast } from "sonner";
import type { ServiceProgramResult, ShiftTripEntry, VehicleShift } from "@/pages/optimizer-route/types";
import type { DeadheadChange, DeadheadOperation } from "@/pages/fucina/DeadheadEditorDialog";

interface UseDeadheadOperationsArgs {
  result: ServiceProgramResult | null;
  customLabels: Record<string, string>;
  onApply: (newResult: ServiceProgramResult, change: DeadheadChange) => void;
}

export interface UpsertDeadheadInput {
  vehicleId: string;
  departureMin: number;
  arrivalMin: number;
  km: number;
  routeIdFrom?: string;
  routeIdTo?: string;
  fromStop?: string;
  toStop?: string;
  replaceIdx?: number | null;
}

const minToHHMM = (m: number) => {
  if (!Number.isFinite(m)) return "--:--";
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
};

const minToTimeStr = (m: number) => `${minToHHMM(m)}:00`;

function recomputeShiftTotals(shift: VehicleShift): VehicleShift {
  const trips = shift.trips;
  const tripEntries = trips.filter(t => t.type === "trip");
  const dhEntries = trips.filter(t => t.type === "deadhead");
  const depotEntries = trips.filter(t => t.type === "depot");
  const totalServiceMin = tripEntries.reduce((s, t) => s + Math.max(0, t.arrivalMin - t.departureMin), 0);
  const totalDeadheadMin = dhEntries.reduce(
    (s, t) => s + (t.deadheadMin ?? Math.max(0, t.arrivalMin - t.departureMin)),
    0,
  );
  const totalDeadheadKm = dhEntries.reduce((s, t) => s + (t.deadheadKm ?? 0), 0);
  const startMin = trips.length ? trips[0].departureMin : shift.startMin;
  const endMin = trips.length ? trips[trips.length - 1].arrivalMin : shift.endMin;
  return {
    ...shift,
    trips,
    startMin,
    endMin,
    totalServiceMin,
    totalDeadheadMin,
    totalDeadheadKm,
    depotReturns: depotEntries.length,
    tripCount: tripEntries.length,
    shiftDuration: Math.max(0, endMin - startMin),
  };
}

function recomputeTotals(shifts: VehicleShift[]): VehicleShift[] {
  return shifts.map(recomputeShiftTotals);
}

function withDeadhead(shift: VehicleShift, newEntry: ShiftTripEntry, replaceIdx: number | null): VehicleShift {
  const next = [...shift.trips];
  if (replaceIdx !== null && replaceIdx >= 0 && replaceIdx < next.length) {
    next.splice(replaceIdx, 1);
  }
  let insertAt = next.findIndex(t => t.departureMin > newEntry.departureMin);
  if (insertAt < 0) insertAt = next.length;
  next.splice(insertAt, 0, newEntry);
  return recomputeShiftTotals({ ...shift, trips: next });
}

function withoutEntry(shift: VehicleShift, idx: number): VehicleShift {
  const next = [...shift.trips];
  if (idx < 0 || idx >= next.length) return shift;
  next.splice(idx, 1);
  return recomputeShiftTotals({ ...shift, trips: next });
}

export function useDeadheadOperations({ result, customLabels, onApply }: UseDeadheadOperationsArgs) {
  const apply = useCallback((
    operation: DeadheadOperation,
    vehicleId: string,
    description: string,
    mutator: (sh: VehicleShift) => VehicleShift,
  ) => {
    if (!result) return false;
    const newShifts = result.shifts.map(s => (s.vehicleId === vehicleId ? mutator(s) : s));
    const recomputed = recomputeTotals(newShifts);
    const totalDhKm = recomputed.reduce((acc, s) => acc + s.totalDeadheadKm, 0);
    const totalDhMin = recomputed.reduce((acc, s) => acc + s.totalDeadheadMin, 0);
    const totalServiceMin = recomputed.reduce((acc, s) => acc + s.totalServiceMin, 0);
    const newResult: ServiceProgramResult = {
      ...result,
      shifts: recomputed,
      summary: result.summary
        ? {
            ...result.summary,
            totalDeadheadKm: totalDhKm,
            totalDeadheadHours: totalDhMin / 60,
            totalServiceHours: totalServiceMin / 60,
          }
        : result.summary,
    };
    onApply(newResult, { vehicleId, operation, description });
    return true;
  }, [result, onApply]);

  const findShiftIndex = useCallback((vehicleId: string) => {
    if (!result) return -1;
    return result.shifts.findIndex(s => s.vehicleId === vehicleId);
  }, [result]);

  const findEntryIndexByDeparture = useCallback((
    vehicleId: string,
    type: "deadhead" | "depot",
    departureMin: number,
  ) => {
    if (!result) return -1;
    const shift = result.shifts.find(s => s.vehicleId === vehicleId);
    if (!shift) return -1;
    return shift.trips.findIndex(t => t.type === type && t.departureMin === departureMin);
  }, [result]);

  const deleteEntry = useCallback((vehicleId: string, entryIdx: number) => {
    if (!result) return false;
    const shift = result.shifts.find(s => s.vehicleId === vehicleId);
    if (!shift) return false;
    const entry = shift.trips[entryIdx];
    if (!entry || (entry.type !== "deadhead" && entry.type !== "depot")) return false;

    const label = customLabels[vehicleId] ?? vehicleId;
    const range = `${minToHHMM(entry.departureMin)}-${minToHHMM(entry.arrivalMin)}`;
    const desc = entry.type === "deadhead"
      ? `Eliminato vuoto ${entry.deadheadKm ?? 0}km su ${label} (${range})`
      : `Eliminato rientro deposito su ${label} (${range})`;

    const ok = apply("delete", vehicleId, desc, sh => withoutEntry(sh, entryIdx));
    if (ok) toast.success(desc);
    return ok;
  }, [result, customLabels, apply]);

  const upsertDeadhead = useCallback((input: UpsertDeadheadInput) => {
    if (!result) return false;
    const {
      vehicleId, departureMin, arrivalMin, km,
      routeIdFrom, routeIdTo, fromStop, toStop,
      replaceIdx = null,
    } = input;
    const shift = result.shifts.find(s => s.vehicleId === vehicleId);
    if (!shift) return false;

    const newEntry: ShiftTripEntry = {
      type: "deadhead",
      tripId: `dh_${vehicleId}_${departureMin}`,
      routeId: routeIdTo || routeIdFrom || "",
      routeName: "Trasferimento a vuoto",
      headsign: null,
      departureTime: minToTimeStr(departureMin),
      arrivalTime: minToTimeStr(arrivalMin),
      departureMin,
      arrivalMin,
      deadheadKm: km,
      deadheadMin: arrivalMin - departureMin,
      firstStopName: fromStop || undefined,
      lastStopName: toStop || undefined,
      durationMin: arrivalMin - departureMin,
    };

    const operation: DeadheadOperation = replaceIdx === null ? "add" : "edit";
    const verb = operation === "add" ? "Aggiunto" : "Modificato";
    const label = customLabels[vehicleId] ?? vehicleId;
    const desc = `${verb} vuoto ${km}km su ${label} (${minToHHMM(departureMin)}-${minToHHMM(arrivalMin)})`;

    const ok = apply(operation, vehicleId, desc, sh => withDeadhead(sh, newEntry, replaceIdx));
    if (ok) toast.success(desc);
    return ok;
  }, [result, customLabels, apply]);

  return {
    findShiftIndex,
    findEntryIndexByDeparture,
    deleteEntry,
    upsertDeadhead,
  };
}
