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
import type { DriverShiftData, RipresaTrip, DriverShiftSummary, DriverShiftType } from "./types";
import { TYPE_COLORS, TYPE_LABELS, minToTime } from "./constants";

export function driverShiftsToRows(shifts: DriverShiftData[]): GanttRow[] {
  return shifts.map(s => {
    const typeShort = TYPE_LABELS[s.type]?.slice(0, 3) ?? s.type.slice(0, 3);
    // Badge BDS: se la validazione c'è e non è valida, evidenzia il dot e
    // arricchisce il sublabel con il numero di violazioni.
    const bds = s.bdsValidation;
    const bdsBad = !!bds && !bds.valid;
    const violCount = bds?.violations?.length ?? 0;
    const dotColor = bdsBad
      ? (violCount >= 3 ? "#ef4444" : "#f59e0b") // rosso ≥3, ambra altrimenti
      : TYPE_COLORS[s.type];
    const sublabel = bdsBad
      ? `${typeShort} · ⚠ BDS×${violCount}`
      : typeShort;
    return {
      id: s.driverId,
      label: s.driverId,
      sublabel,
      dotColor,
    };
  });
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
export function driverShiftsToTripBars(shifts: DriverShiftData[]): GanttBar[] {  const out: GanttBar[] = [];
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

/* ── Vincolo deadhead (fuorilinea) tra corse consecutive ───────
 * Quando una corsa arriva a STOP_A e la successiva (stesso driver+veicolo)
 * parte da STOP_B, serve tempo materiale per spostare il bus da A a B.
 *
 * Senza accesso a una matrice tempi reale lato browser, applichiamo:
 *   - stessi stop          → 0 min richiesti
 *   - stop diversi         → MIN_DEADHEAD_DIFFERENT_STOP_MIN
 *   - cambio vehicleId     → almeno MIN_VEHICLE_HANDOVER_MIN (cambio in linea)
 *   - cambio vehicleType   → ulteriore MIN_VEHICLE_HANDOVER_EXTRA per pull-out/pull-in
 *
 * I valori sono allineati a quanto usato dal backend in transfer_matrix.py
 * (default conservativi). Sovrascrivibili in futuro caricando una matrice
 * vera dal backend.
 */
const MIN_DEADHEAD_DIFFERENT_STOP_MIN = 10;
const MIN_VEHICLE_HANDOVER_MIN = 5;          // attesa minima per cambio veicolo allo stesso capolinea
const MIN_VEHICLE_HANDOVER_EXTRA = 15;       // ulteriore se cambia anche tipo veicolo

/**
 * Calcola il tempo minimo (minuti) richiesto fra l'arrivo di prevTrip
 * e la partenza di nextTrip, per essere fisicamente fattibile.
 * Restituisce 0 se uno dei due è null/undefined.
 */
export function requiredDeadheadMin(
  prevTrip: RipresaTrip | undefined | null,
  nextTrip: RipresaTrip | undefined | null,
): number {
  if (!prevTrip || !nextTrip) return 0;
  const sameStop =
    !!prevTrip.lastStopName && !!nextTrip.firstStopName &&
    prevTrip.lastStopName.trim().toLowerCase() === nextTrip.firstStopName.trim().toLowerCase();
  let need = sameStop ? 0 : MIN_DEADHEAD_DIFFERENT_STOP_MIN;
  if (prevTrip.vehicleId && nextTrip.vehicleId && prevTrip.vehicleId !== nextTrip.vehicleId) {
    need = Math.max(need, MIN_VEHICLE_HANDOVER_MIN);
    if (prevTrip.vehicleType && nextTrip.vehicleType && prevTrip.vehicleType !== nextTrip.vehicleType) {
      need += MIN_VEHICLE_HANDOVER_EXTRA;
    }
  }
  return need;
}

/**
 * Etichetta human-readable di un conflitto deadhead, usata nei toast/warning.
 */
function describeDeadhead(prev: RipresaTrip, next: RipresaTrip, gap: number, need: number): string {
  const where = prev.lastStopName && next.firstStopName && prev.lastStopName !== next.firstStopName
    ? ` ${prev.lastStopName} → ${next.firstStopName}`
    : "";
  return `Trasferimento${where} richiede ≥${need}', disponibili solo ${gap}'`;
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

  // ── Vincolo deadhead: verifica vicini prev/next nella ripresa target ──
  const prevNeighbor = insertAt > 0 ? targetTrips[insertAt - 1] : undefined;
  const nextNeighbor = insertAt < targetTrips.length ? targetTrips[insertAt] : undefined;

  if (prevNeighbor) {
    const need = requiredDeadheadMin(prevNeighbor, newTrip);
    const gap = newTrip.departureMin - prevNeighbor.arrivalMin;
    if (gap < need) {
      return { shifts, warning: describeDeadhead(prevNeighbor, newTrip, gap, need) };
    }
  }
  if (nextNeighbor) {
    const need = requiredDeadheadMin(newTrip, nextNeighbor);
    const gap = nextNeighbor.departureMin - newTrip.arrivalMin;
    if (gap < need) {
      return { shifts, warning: describeDeadhead(newTrip, nextNeighbor, gap, need) };
    }
  }

  targetTrips.splice(insertAt, 0, newTrip);

  // ── Vincolo deadhead lato sorgente: dopo aver tolto la trip, le due
  //    corse "ricucite" (prima/dopo del buco) devono comunque rispettare il transfer
  const sourceTrips = newShifts[fromIdx].riprese[foundRipIdx].trips;
  if (foundTripIdx > 0 && foundTripIdx < sourceTrips.length + 1) {
    // sourceTrips è già senza la trip rimossa: i vicini sono indici (foundTripIdx-1) e foundTripIdx
    const sPrev = sourceTrips[foundTripIdx - 1];
    const sNext = sourceTrips[foundTripIdx];
    if (sPrev && sNext) {
      const need = requiredDeadheadMin(sPrev, sNext);
      const gap = sNext.departureMin - sPrev.arrivalMin;
      if (gap < need) {
        // Ripristino dello stato (rimettiamo la trip rimossa) prima di tornare
        sourceTrips.splice(foundTripIdx, 0, oldTrip);
        // E rimuoviamo dal target quella appena inserita
        targetTrips.splice(targetTrips.indexOf(newTrip), 1);
        return { shifts, warning: describeDeadhead(sPrev, sNext, gap, need) + " (sul turno di origine)" };
      }
    }
  }

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

/* ──────────────────────────────────────────────────────────────
 * SUGGESTION ENGINE
 * ────────────────────────────────────────────────────────────── */

export interface DriverSuggestion {
  driverId: string;
  reason: string;          // one-line motivo principale (verde / giallo / rosso)
  detail?: string;         // dettaglio secondario (gap, vehicleType match, BDS impact)
  score: number;           // 0..100, più alto = migliore
  warnings?: string[];     // eventuali avvertimenti BDS
}

/* Limiti normativa BDS hard-coded coerenti con backend
 *   intero      → maxNastro 13h00 (780)
 *   semiunico   → maxNastro 13h30 (810)
 *   spezzato    → maxNastro 14h00 (840)
 *   supplemento → maxNastro 2h30 (150)
 */
const MAX_NASTRO_BY_TYPE: Record<string, number> = {
  intero: 780,
  semiunico: 810,
  spezzato: 840,
  supplemento: 150,
  invalido: 13 * 60,
};

const MAX_WORK_BY_TYPE: Record<string, number> = {
  intero: 6 * 60 + 30,    // 6h30 lavoro effettivo
  semiunico: 6 * 60 + 30,
  spezzato: 7 * 60 + 30,
  supplemento: 2 * 60 + 30,
  invalido: 8 * 60,
};

/**
 * Calcola i migliori turni guida candidati per ospitare la `trip` indicata.
 * Considera:
 *   - finestra libera nelle riprese del candidato (trip non sovrapposta)
 *   - nastro/work non sforati dalla normativa (maxNastro per tipo turno)
 *   - bonus se stesso vehicleType (nessun cambio macchina extra)
 *   - bonus se la trip si incastra in una "finestra esistente" senza estendere il nastro
 *
 * @param shifts tutti i turni guida (incluso quello di provenienza, escluso da output)
 * @param tripId id della corsa di interesse
 * @returns lista ordinata per score discendente (i migliori prima)
 */
export function suggestDriversForTrip(
  shifts: DriverShiftData[],
  tripId: string,
): DriverSuggestion[] {
  // Trova trip + driver di partenza
  let sourceTrip: RipresaTrip | null = null;
  let sourceDriverId: string | null = null;
  for (const s of shifts) {
    for (const r of s.riprese) {
      const t = r.trips.find(x => x.tripId === tripId);
      if (t) { sourceTrip = t; sourceDriverId = s.driverId; break; }
    }
    if (sourceTrip) break;
  }
  if (!sourceTrip) return [];

  const tripDur = sourceTrip.arrivalMin - sourceTrip.departureMin;
  const out: DriverSuggestion[] = [];

  for (const s of shifts) {
    if (s.driverId === sourceDriverId) continue;
    if (s.type === "supplemento" || s.type === "invalido") continue;

    // Verifica overlap con qualunque corsa esistente
    const overlap = s.riprese.some(r => r.trips.some(t =>
      Math.max(t.departureMin, sourceTrip!.departureMin) <
      Math.min(t.arrivalMin, sourceTrip!.arrivalMin),
    ));
    if (overlap) continue;

    // Candidata ripresa: quella che contiene già la finestra (trip dentro startMin..endMin)
    // o la più vicina temporalmente
    let bestRipIdx = -1;
    let bestGapInside = false;
    for (let ri = 0; ri < s.riprese.length; ri++) {
      const r = s.riprese[ri];
      // Service window della ripresa = senza preTurno/transfer (effettivo nastro corse)
      const svcStart = r.startMin + r.preTurnoMin + r.transferMin;
      const svcEnd = r.endMin - (r.transferBackMin || 0);
      if (sourceTrip.departureMin >= svcStart && sourceTrip.arrivalMin <= svcEnd) {
        bestRipIdx = ri; bestGapInside = true; break;
      }
    }
    // Se nessuna finestra dentro: prova a "estendere" la ripresa più vicina
    if (bestRipIdx < 0) {
      let minDist = Infinity;
      for (let ri = 0; ri < s.riprese.length; ri++) {
        const r = s.riprese[ri];
        const dist = Math.min(
          Math.abs(sourceTrip.departureMin - r.endMin),
          Math.abs(r.startMin - sourceTrip.arrivalMin),
        );
        if (dist < minDist) { minDist = dist; bestRipIdx = ri; }
      }
    }
    if (bestRipIdx < 0) continue;

    // ── Vincolo deadhead: trova prev/next nella ripresa candidata ──
    const candTrips = s.riprese[bestRipIdx].trips;
    let insertAt = candTrips.findIndex(t => t.departureMin > sourceTrip!.departureMin);
    if (insertAt < 0) insertAt = candTrips.length;
    const prevNeighbor = insertAt > 0 ? candTrips[insertAt - 1] : undefined;
    const nextNeighbor = insertAt < candTrips.length ? candTrips[insertAt] : undefined;

    let deadheadFatal = false;
    if (prevNeighbor) {
      const need = requiredDeadheadMin(prevNeighbor, sourceTrip);
      const gap = sourceTrip.departureMin - prevNeighbor.arrivalMin;
      if (gap < need) deadheadFatal = true;
    }
    if (!deadheadFatal && nextNeighbor) {
      const need = requiredDeadheadMin(sourceTrip, nextNeighbor);
      const gap = nextNeighbor.departureMin - sourceTrip.arrivalMin;
      if (gap < need) deadheadFatal = true;
    }
    if (deadheadFatal) continue;  // non proponiamo soluzioni infattibili

    // Stima impatto su nastro/work
    const newWorkMin = s.workMin + tripDur;
    const newNastroStart = Math.min(s.nastroStartMin, sourceTrip.departureMin);
    const newNastroEnd = Math.max(s.nastroEndMin, sourceTrip.arrivalMin);
    const newNastroMin = newNastroEnd - newNastroStart;

    const maxNastro = MAX_NASTRO_BY_TYPE[s.type] ?? 780;
    const maxWork   = MAX_WORK_BY_TYPE[s.type]   ?? (6 * 60 + 30);

    const warnings: string[] = [];
    if (newNastroMin > maxNastro) {
      warnings.push(`nastro ${Math.floor(newNastroMin/60)}h${String(newNastroMin%60).padStart(2,"0")} > max ${Math.floor(maxNastro/60)}h${String(maxNastro%60).padStart(2,"0")} (${s.type})`);
    }
    if (newWorkMin > maxWork) {
      warnings.push(`lavoro ${Math.floor(newWorkMin/60)}h${String(newWorkMin%60).padStart(2,"0")} > max ${Math.floor(maxWork/60)}h${String(maxWork%60).padStart(2,"0")}`);
    }
    if (warnings.length >= 2) continue; // troppo invasivo

    // Vehicle type match
    const targetVtype = s.riprese[bestRipIdx]?.vehicleType;
    const sameVtype = !!sourceTrip.vehicleType
      && !!targetVtype
      && sourceTrip.vehicleType === targetVtype;

    // Score
    let score = 50;
    if (bestGapInside) score += 30;          // entra in finestra esistente
    if (sameVtype) score += 15;              // stesso veicolo → no cambio macchina
    if (newNastroMin <= s.nastroMin) score += 10;  // nastro non aumenta
    score -= warnings.length * 25;
    score = Math.max(0, Math.min(100, score));

    // Reason / detail human-readable
    let reason: string;
    if (bestGapInside && sameVtype) {
      reason = "🟢 Si incastra perfettamente (stessa vettura)";
    } else if (bestGapInside) {
      reason = "🟢 Entra nella finestra esistente";
    } else if (warnings.length === 0) {
      reason = "🟡 Estende il nastro ma rispetta normativa";
    } else {
      reason = `🟠 Possibile con eccezione (${warnings.length} alert)`;
    }
    const detail = sameVtype
      ? `stessa macchina ${sourceTrip.vehicleType} · nastro Δ ${newNastroMin - s.nastroMin >= 0 ? "+" : ""}${newNastroMin - s.nastroMin}'`
      : `nastro Δ ${newNastroMin - s.nastroMin >= 0 ? "+" : ""}${newNastroMin - s.nastroMin}' · ${s.type} ${s.nastroStart}-${s.nastroEnd}`;

    out.push({
      driverId: s.driverId,
      reason,
      detail,
      score,
      warnings: warnings.length ? warnings : undefined,
    });
  }

  out.sort((a, b) => b.score - a.score);
  return out;
}

/* ──────────────────────────────────────────────────────────────
 * COMPATIBILITY MAP — per ogni trip conta quanti turni guida
 *   alternativi potrebbero ospitarla rispettando overlap+deadhead.
 * Restituisce mappa tripId → { count, level }
 *   level: "high" (≥3) | "medium" (1-2) | "low" (0)
 * ────────────────────────────────────────────────────────────── */

export interface TripCompatibility {
  count: number;
  level: "high" | "medium" | "low";
}

export function computeTripCompatibilityMap(
  shifts: DriverShiftData[],
): Map<string, TripCompatibility> {
  const map = new Map<string, TripCompatibility>();
  // Iteriamo tutte le trip esistenti
  for (const s of shifts) {
    for (const r of s.riprese) {
      for (const t of r.trips) {
        // Conta quanti driver alternativi possono ospitare la trip
        let count = 0;
        for (const cand of shifts) {
          if (cand.driverId === s.driverId) continue;
          if (cand.type === "supplemento" || cand.type === "invalido") continue;

          // Overlap con qualunque trip del candidato?
          const overlap = cand.riprese.some(rr => rr.trips.some(ct =>
            Math.max(ct.departureMin, t.departureMin) <
            Math.min(ct.arrivalMin, t.arrivalMin),
          ));
          if (overlap) continue;

          // Trova ripresa target più ragionevole (quella che contiene la finestra,
          // o la più vicina), e verifica deadhead vincolante con vicini.
          let bestRipIdx = -1;
          for (let ri = 0; ri < cand.riprese.length; ri++) {
            const rr = cand.riprese[ri];
            const svcStart = rr.startMin + rr.preTurnoMin + rr.transferMin;
            const svcEnd = rr.endMin - (rr.transferBackMin || 0);
            if (t.departureMin >= svcStart && t.arrivalMin <= svcEnd) {
              bestRipIdx = ri; break;
            }
          }
          if (bestRipIdx < 0) {
            let minDist = Infinity;
            for (let ri = 0; ri < cand.riprese.length; ri++) {
              const rr = cand.riprese[ri];
              const dist = Math.min(
                Math.abs(t.departureMin - rr.endMin),
                Math.abs(rr.startMin - t.arrivalMin),
              );
              if (dist < minDist) { minDist = dist; bestRipIdx = ri; }
            }
          }
          if (bestRipIdx < 0) continue;

          // Deadhead check con vicini nella ripresa scelta
          const candTrips = cand.riprese[bestRipIdx].trips;
          let insertAt = candTrips.findIndex(ct => ct.departureMin > t.departureMin);
          if (insertAt < 0) insertAt = candTrips.length;
          const prev = insertAt > 0 ? candTrips[insertAt - 1] : undefined;
          const next = insertAt < candTrips.length ? candTrips[insertAt] : undefined;

          let ok = true;
          if (prev) {
            const need = requiredDeadheadMin(prev, t);
            if (t.departureMin - prev.arrivalMin < need) ok = false;
          }
          if (ok && next) {
            const need = requiredDeadheadMin(t, next);
            if (next.departureMin - t.arrivalMin < need) ok = false;
          }
          if (ok) count++;
        }
        const level: TripCompatibility["level"] =
          count >= 3 ? "high" : count >= 1 ? "medium" : "low";
        map.set(t.tripId, { count, level });
      }
    }
  }
  return map;
}

/** Colore CSS halo per livello di compatibilità. */
export function compatibilityGlow(level: TripCompatibility["level"]): string {
  switch (level) {
    case "high":   return "rgba(16, 185, 129, 0.55)";  // emerald
    case "medium": return "rgba(245, 158, 11, 0.55)";  // amber
    case "low":    return "rgba(239, 68, 68, 0.55)";   // red
  }
}

/* ──────────────────────────────────────────────────────────────
 * SUMMARY RECOMPUTE — per KPI live what-if dopo modifiche manuali
 * ────────────────────────────────────────────────────────────── */

/**
 * Ricalcola il `summary` aggregato a partire dai turni guida correnti.
 * Conserva i campi che non possono essere ricalcolati (costBreakdown,
 * efficiency, totalDailyCost) ricalcolando solo conteggi/percentuali e
 * companyCarsUsed dai vehicleId distinti.
 *
 * NB: Il calcolo del costo richiederebbe i `rates` del backend; per l'UI
 * what-if viene linearizzato proporzionalmente al delta workMin.
 */
export function recomputeSummary(
  shifts: DriverShiftData[],
  baseline: DriverShiftSummary,
): DriverShiftSummary {
  const byType: Record<DriverShiftType, number> = {
    intero: 0, semiunico: 0, spezzato: 0, supplemento: 0, invalido: 0,
  };
  let totalWorkMin = 0;
  let totalNastroMin = 0;
  let totalCambi = 0;
  let totalInter = 0;
  let totalIntra = 0;
  const vehicleIds = new Set<string>();

  for (const s of shifts) {
    byType[s.type] = (byType[s.type] ?? 0) + 1;
    totalWorkMin += s.workMin;
    totalNastroMin += s.nastroMin;
    totalCambi += s.cambiCount ?? 0;
    for (const r of s.riprese) {
      for (const c of (r.cambi ?? [])) {
        if ((c as any).cutType === "intra") totalIntra++;
        else totalInter++;
      }
      for (const seg of r.vehicleIds ?? []) {
        if (seg) vehicleIds.add(seg);
      }
    }
  }

  const n = shifts.length || 1;
  const semiPct = Math.round((byType.semiunico / n) * 1000) / 10;
  const spezPct = Math.round((byType.spezzato / n) * 1000) / 10;

  // Costo: scalatura lineare basata sul rapporto totalWorkMin baseline/current.
  // È un'approssimazione what-if: il vero costo lo ricalcolerà il solver.
  const baselineWorkH = baseline.totalWorkHours || 1;
  const baselineCost = baseline.totalDailyCost ?? 0;
  const newWorkH = totalWorkMin / 60;
  const scaledCost = baselineCost > 0
    ? Math.round((baselineCost * (newWorkH / baselineWorkH)) * 100) / 100
    : baselineCost;

  return {
    ...baseline,
    totalDriverShifts: shifts.length,
    byType,
    totalWorkHours: Math.round(newWorkH * 10) / 10,
    avgWorkMin: Math.round(totalWorkMin / n),
    totalNastroHours: Math.round((totalNastroMin / 60) * 10) / 10,
    avgNastroMin: Math.round(totalNastroMin / n),
    semiunicoPct: semiPct,
    spezzatoPct: spezPct,
    totalCambi,
    totalInterCambi: totalInter || undefined,
    totalIntraCambi: totalIntra || undefined,
    companyCarsUsed: vehicleIds.size,
    totalDailyCost: scaledCost || baseline.totalDailyCost,
  };
}

/**
 * Calcola il delta tra due summary, restituendo segno e magnitudo per i
 * campi più rilevanti per l'utente che sta facendo what-if.
 */
export interface SummaryDelta {
  driversΔ: number;          // turni in più/meno
  workHoursΔ: number;        // ore lavoro
  costΔ: number;             // €
  semiPctΔ: number;          // punti percentuali
  spezPctΔ: number;
  cambiΔ: number;
  carsΔ: number;
}

export function diffSummary(
  current: DriverShiftSummary,
  baseline: DriverShiftSummary,
): SummaryDelta {
  return {
    driversΔ: current.totalDriverShifts - baseline.totalDriverShifts,
    workHoursΔ: Math.round(((current.totalWorkHours ?? 0) - (baseline.totalWorkHours ?? 0)) * 10) / 10,
    costΔ: Math.round(((current.totalDailyCost ?? 0) - (baseline.totalDailyCost ?? 0)) * 100) / 100,
    semiPctΔ: Math.round(((current.semiunicoPct ?? 0) - (baseline.semiunicoPct ?? 0)) * 10) / 10,
    spezPctΔ: Math.round(((current.spezzatoPct ?? 0) - (baseline.spezzatoPct ?? 0)) * 10) / 10,
    cambiΔ: (current.totalCambi ?? 0) - (baseline.totalCambi ?? 0),
    carsΔ: (current.companyCarsUsed ?? 0) - (baseline.companyCarsUsed ?? 0),
  };
}
