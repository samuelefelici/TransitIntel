/**
 * Driver Shifts → InteractiveGantt adapters
 *
 * Estratto da driver-shifts.tsx per essere riusato anche da
 * fucina/driver-workspace.tsx (Area di Lavoro Turni Guida).
 */
import type { GanttRow, GanttBar } from "@/components/InteractiveGantt";
import type { DriverShiftData } from "./types";
import { TYPE_COLORS, TYPE_LABELS, minToTime } from "./constants";

export function driverShiftsToRows(shifts: DriverShiftData[]): GanttRow[] {
  return shifts.map(s => ({
    id: s.driverId,
    label: s.driverId,
    sublabel: TYPE_LABELS[s.type]?.slice(0, 3),
    dotColor: TYPE_COLORS[s.type],
  }));
}

export function driverShiftsBoundsHours(shifts: DriverShiftData[]): { min: number; max: number } {
  if (shifts.length === 0) return { min: 4, max: 25 };
  return {
    min: Math.max(3, Math.floor(Math.min(...shifts.map(s => s.nastroStartMin)) / 60) - 1),
    max: Math.min(27, Math.ceil(Math.max(...shifts.map(s => s.nastroEndMin)) / 60) + 1),
  };
}

export function driverShiftsToBars(shifts: DriverShiftData[]): GanttBar[] {
  const out: GanttBar[] = [];
  for (const shift of shifts) {
    const typeColor = TYPE_COLORS[shift.type];
    shift.riprese.forEach((rip, ri) => {
      const baseId = `${shift.driverId}__r${ri}`;
      // Pre-turno
      if (rip.preTurnoMin > 0) {
        out.push({
          id: `${baseId}_pt`, rowId: shift.driverId,
          startMin: rip.startMin, endMin: rip.startMin + rip.preTurnoMin,
          label: "PT", color: typeColor, style: "dashed",
          tooltip: [`Pre-turno ${rip.preTurnoMin}min`],
          locked: true,
          meta: { type: "preTurno", driverId: shift.driverId, ripreseIdx: ri },
        });
      }
      // Transfer in
      if (rip.transferMin > 0) {
        const tStart = rip.startMin + rip.preTurnoMin;
        out.push({
          id: `${baseId}_tf`, rowId: shift.driverId,
          startMin: tStart, endMin: tStart + rip.transferMin,
          label: "↝", color: typeColor, style: "dashed",
          tooltip: [`Trasf. deposito → ${rip.transferToStop || "capolinea"} ${rip.transferMin}min`],
          locked: true,
          meta: { type: "transfer", driverId: shift.driverId, ripreseIdx: ri },
        });
      }
      // Service trips block
      const serviceStart = rip.startMin + rip.preTurnoMin + rip.transferMin;
      const serviceEnd = rip.endMin - (rip.transferBackMin || 0);
      if (serviceEnd > serviceStart) {
        const tip: string[] = [
          `${rip.trips.length} corse`,
          `${minToTime(serviceStart)} → ${minToTime(serviceEnd)}`,
          `Veicolo: ${rip.vehicleIds.join(", ")}`,
        ];
        if (rip.cambi?.length) tip.push(`${rip.cambi.length} cambi in linea`);
        out.push({
          id: `${baseId}_srv`, rowId: shift.driverId,
          startMin: serviceStart, endMin: serviceEnd,
          label: `${rip.trips.length} corse`, color: typeColor, style: "solid",
          tooltip: tip,
          meta: { type: "service", driverId: shift.driverId, ripreseIdx: ri, tripCount: rip.trips.length },
        });
      }
      // Transfer back
      if ((rip.transferBackMin || 0) > 0) {
        const tbStart = rip.endMin - rip.transferBackMin;
        out.push({
          id: `${baseId}_tb`, rowId: shift.driverId,
          startMin: tbStart, endMin: rip.endMin,
          label: "↜", color: typeColor, style: "dashed",
          tooltip: [`Rientro ${rip.lastStop || "capolinea"} → deposito ${rip.transferBackMin}min`],
          locked: true,
          meta: { type: "transferBack", driverId: shift.driverId, ripreseIdx: ri },
        });
      }
    });
    // Interruption gap
    if (shift.interruptionMin > 0 && shift.riprese.length === 2) {
      out.push({
        id: `${shift.driverId}__gap`, rowId: shift.driverId,
        startMin: shift.riprese[0].endMin, endMin: shift.riprese[1].startMin,
        label: "", color: "rgba(255,255,255,0.06)", style: "striped",
        tooltip: [`Interruzione ${shift.interruption}`],
        locked: true,
        meta: { type: "interruption", driverId: shift.driverId },
      });
    }
  }
  return out;
}
