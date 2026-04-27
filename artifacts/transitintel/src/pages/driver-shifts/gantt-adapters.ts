/**
 * Driver Shifts → InteractiveGantt adapters
 *
 * Estratto da driver-shifts.tsx per essere riusato anche da
 * fucina/driver-workspace.tsx (Area di Lavoro Turni Guida).
 *
 * Due modalità:
 *   - driverShiftsToBars        → AGGREGATA (1 bar "N corse" per ripresa, read-only)
 *   - driverShiftsToTripBars    → ESPLOSA (1 bar per trip, drag-and-drop friendly)
 */
import type { GanttRow, GanttBar } from "@/components/InteractiveGantt";
import type { DriverShiftData, RipresaTrip } from "./types";
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

/* ── Vista AGGREGATA (read-only, una "fascia corse" per ripresa) ── */
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

/* ── Vista ESPLOSA: 1 bar per ogni corsa (drag-and-drop) ──
 * Le sintetiche (preTurno, transfer, transferBack, interruption) restano locked.
 * Ogni bar trip ha id = `${driverId}__r${ri}__t${tripId}` per identificare riassegnazione.
 */
export function driverShiftsToTripBars(shifts: DriverShiftData[]): GanttBar[] {
  const out: GanttBar[] = [];
  for (const shift of shifts) {
    const typeColor = TYPE_COLORS[shift.type];
    shift.riprese.forEach((rip, ri) => {
      const baseId = `${shift.driverId}__r${ri}`;
      // Pre-turno (locked)
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
      // Transfer in (locked)
      if (rip.transferMin > 0) {
        const tStart = rip.startMin + rip.preTurnoMin;
        out.push({
          id: `${baseId}_tf`, rowId: shift.driverId,
          startMin: tStart, endMin: tStart + rip.transferMin,
          label: "↝", color: typeColor, style: "dashed",
          tooltip: [`Trasf. → ${rip.transferToStop || "capolinea"} ${rip.transferMin}min`],
          locked: true,
          meta: { type: "transfer", driverId: shift.driverId, ripreseIdx: ri },
        });
      }
      // Trip per trip (DRAGGABLE)
      for (const t of rip.trips) {
        const tip: string[] = [
          `${t.routeName || t.routeId}${t.headsign ? ` → ${t.headsign}` : ""}`,
          `${t.departureTime || minToTime(t.departureMin)} → ${t.arrivalTime || minToTime(t.arrivalMin)}`,
        ];
        if (t.firstStopName) tip.push(`Da: ${t.firstStopName}`);
        if (t.lastStopName) tip.push(`A: ${t.lastStopName}`);
        if (t.vehicleId) tip.push(`Veicolo: ${t.vehicleId}`);
        out.push({
          id: `${baseId}__t${t.tripId}`,
          rowId: shift.driverId,
          startMin: t.departureMin,
          endMin: t.arrivalMin,
          label: t.routeName || t.routeId,
          color: typeColor,
          style: "solid",
          tooltip: tip,
          locked: false,
          meta: {
            type: "trip",
            driverId: shift.driverId,
            ripreseIdx: ri,
            tripId: t.tripId,
            routeId: t.routeId,
            routeName: t.routeName,
            headsign: t.headsign,
            vehicleId: t.vehicleId,
            vehicleType: t.vehicleType,
            firstStopName: t.firstStopName,
            lastStopName: t.lastStopName,
          },
        });
      }
      // Transfer back (locked)
      if ((rip.transferBackMin || 0) > 0) {
        const tbStart = rip.endMin - rip.transferBackMin;
        out.push({
          id: `${baseId}_tb`, rowId: shift.driverId,
          startMin: tbStart, endMin: rip.endMin,
          label: "↜", color: typeColor, style: "dashed",
          tooltip: [`Rientro ${rip.lastStop || "capolinea"} ${rip.transferBackMin}min`],
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

/* ── Helper: applica una riassegnazione trip al modello dati ──
 * Sposta `tripId` dalla ripresa originaria del driver `fromDriverId` alla
 * ripresa più adatta del driver `toDriverId` (quella più vicina a newStartMin).
 * Aggiorna anche departureMin/arrivalMin/orari.
 * Ritorna il nuovo array di shifts (immutabile).
 */
export interface DriverTripChange {
  tripId: string;
  fromDriverId: string;
  toDriverId: string;
  newStartMin: number;
  newEndMin: number;
}

const minToTimeStr = (m: number) => {
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00`;
};

export function applyDriverTripChange(
  shifts: DriverShiftData[],
  change: DriverTripChange,
): { shifts: DriverShiftData[]; movedTrip?: RipresaTrip; warning?: string } {
  const fromIdx = shifts.findIndex(s => s.driverId === change.fromDriverId);
  const toIdx = shifts.findIndex(s => s.driverId === change.toDriverId);
  if (fromIdx < 0 || toIdx < 0) return { shifts, warning: "Driver non trovato" };

  // Trova trip nella sorgente
  let foundRipIdx = -1;
  let foundTripIdx = -1;
  const fromShift = shifts[fromIdx];
  for (let ri = 0; ri < fromShift.riprese.length; ri++) {
    const ti = fromShift.riprese[ri].trips.findIndex(t => t.tripId === change.tripId);
    if (ti >= 0) { foundRipIdx = ri; foundTripIdx = ti; break; }
  }
  if (foundRipIdx < 0) return { shifts, warning: "Corsa non trovata nella sorgente" };

  const oldTrip = fromShift.riprese[foundRipIdx].trips[foundTripIdx];
  const deltaStart = change.newStartMin - oldTrip.departureMin;
  const deltaEnd = change.newEndMin - oldTrip.arrivalMin;
  const newTrip: RipresaTrip = {
    ...oldTrip,
    departureMin: change.newStartMin,
    arrivalMin: change.newEndMin,
    departureTime: deltaStart !== 0 ? minToTimeStr(change.newStartMin) : oldTrip.departureTime,
    arrivalTime: deltaEnd !== 0 ? minToTimeStr(change.newEndMin) : oldTrip.arrivalTime,
  };

  // Clone shifts (deep)
  const newShifts = shifts.map(s => ({
    ...s,
    riprese: s.riprese.map(r => ({ ...r, trips: [...r.trips], cambi: [...r.cambi], vehicleIds: [...r.vehicleIds] })),
    handovers: s.handovers ? [...s.handovers] : undefined,
  }));

  // Rimuovi dalla sorgente
  newShifts[fromIdx].riprese[foundRipIdx].trips.splice(foundTripIdx, 1);

  // Trova ripresa target nel destinatario (quella che contiene newStartMin, o la più vicina)
  const toShift = newShifts[toIdx];
  let targetRipIdx = 0;
  if (toShift.riprese.length > 1) {
    targetRipIdx = toShift.riprese.findIndex(r =>
      change.newStartMin >= r.startMin && change.newStartMin <= r.endMin
    );
    if (targetRipIdx < 0) {
      // fallback: ripresa più vicina temporalmente
      let bestDist = Infinity;
      toShift.riprese.forEach((r, i) => {
        const d = Math.min(Math.abs(change.newStartMin - r.startMin), Math.abs(change.newStartMin - r.endMin));
        if (d < bestDist) { bestDist = d; targetRipIdx = i; }
      });
    }
  }
  // Inserisci ordinato per departureMin
  const targetTrips = toShift.riprese[targetRipIdx].trips;
  let insertAt = targetTrips.findIndex(t => t.departureMin > newTrip.departureMin);
  if (insertAt < 0) insertAt = targetTrips.length;
  targetTrips.splice(insertAt, 0, newTrip);

  // Ricalcola startMin/endMin/workMin di entrambe le riprese coinvolte
  recomputeRipresa(newShifts[fromIdx], foundRipIdx);
  recomputeRipresa(newShifts[toIdx], targetRipIdx);

  // Aggiorna nastro/work del driver
  recomputeShiftAggregates(newShifts[fromIdx]);
  recomputeShiftAggregates(newShifts[toIdx]);

  return { shifts: newShifts, movedTrip: newTrip };
}

function recomputeRipresa(shift: DriverShiftData, ri: number) {
  const rip = shift.riprese[ri];
  if (rip.trips.length === 0) {
    // Ripresa vuota: tieni solo pre-turno + transfer come "fantasma"
    rip.workMin = 0;
    return;
  }
  const minDep = Math.min(...rip.trips.map(t => t.departureMin));
  const maxArr = Math.max(...rip.trips.map(t => t.arrivalMin));
  const newStart = minDep - rip.preTurnoMin - rip.transferMin;
  const newEnd = maxArr + (rip.transferBackMin || 0);
  rip.startMin = newStart;
  rip.endMin = newEnd;
  rip.startTime = minToTimeStr(newStart).slice(0, 5);
  rip.endTime = minToTimeStr(newEnd).slice(0, 5);
  rip.workMin = newEnd - newStart;
  // Aggiorna vehicleIds dalla lista trips (deduplica)
  rip.vehicleIds = Array.from(new Set(rip.trips.map(t => t.vehicleId).filter(Boolean) as string[]));
}

function recomputeShiftAggregates(shift: DriverShiftData) {
  // Filtra riprese che potrebbero essere rimaste vuote
  const valid = shift.riprese.filter(r => r.trips.length > 0);
  if (valid.length === 0) {
    // Tutto il driver è vuoto — non rimuoviamo qui (lasciamo al chiamante decidere)
    return;
  }
  shift.riprese = valid;
  shift.nastroStartMin = Math.min(...valid.map(r => r.startMin));
  shift.nastroEndMin = Math.max(...valid.map(r => r.endMin));
  shift.nastroMin = shift.nastroEndMin - shift.nastroStartMin;
  shift.nastroStart = minToTimeStr(shift.nastroStartMin).slice(0, 5);
  shift.nastroEnd = minToTimeStr(shift.nastroEndMin).slice(0, 5);
  shift.nastro = `${Math.floor(shift.nastroMin / 60)}h${String(shift.nastroMin % 60).padStart(2, "0")}`;
  // workMin = somma riprese
  shift.workMin = valid.reduce((sum, r) => sum + r.workMin, 0);
  shift.work = `${Math.floor(shift.workMin / 60)}h${String(shift.workMin % 60).padStart(2, "0")}`;
  // interruzione = gap tra riprese se 2
  if (valid.length === 2) {
    shift.interruptionMin = valid[1].startMin - valid[0].endMin;
    shift.interruption = `${Math.floor(shift.interruptionMin / 60)}h${String(shift.interruptionMin % 60).padStart(2, "0")}`;
  } else {
    shift.interruptionMin = 0;
    shift.interruption = null;
  }
}
