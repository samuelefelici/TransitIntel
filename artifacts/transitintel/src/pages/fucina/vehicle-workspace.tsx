/**
 * VehicleWorkspace — Interactive vehicle shift workspace with drag & drop
 *
 * Converts VehicleShift[] data into InteractiveGantt's GanttRow/GanttBar format,
 * enabling drag-and-drop of trips between vehicle shifts (turni macchina).
 * Supports saving modified scenarios.
 */
import React, { useState, useMemo, useCallback, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Truck, Play, Loader2, Save, CheckCircle2, AlertTriangle,
  BarChart3, Route, Clock, Fuel, ArrowRight, Download,
  Flame, RotateCcw, Info, Undo2, Redo2, History, Home, Wind,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Printer, FolderOpen } from "lucide-react";
import InteractiveGantt, {
  type GanttBar, type GanttRow, type GanttChange, type GanttSuggestion,
} from "@/components/InteractiveGantt";
import type {
  VehicleShift, ShiftTripEntry, VehicleType, ServiceCategory,
  ServiceProgramResult,
} from "@/pages/optimizer-route/types";
import {
  VEHICLE_LABELS, VEHICLE_SHORT, VEHICLE_COLORS,
  CATEGORY_COLORS, ROUTE_PALETTE,
} from "@/pages/optimizer-route/constants";
import { getApiBase } from "@/lib/api";
import IntermodalAdvisor from "./IntermodalAdvisor";
import { SaveScenarioDialog, LoadScenarioDialog } from "./ScenarioDialogs";
import { exportScenarioToPrint } from "./VehicleShiftsPrintExport";
import DeadheadEditorDialog, { type DeadheadChange } from "./DeadheadEditorDialog";

/* ═══════════════════════════════════════════════════════════════
 *  Conversion helpers — VehicleShift[] → GanttRow[] + GanttBar[]
 * ═══════════════════════════════════════════════════════════════ */

function shiftsToRows(shifts: VehicleShift[], customLabels: Record<string, string> = {}): GanttRow[] {
  return shifts.map(s => ({
    id: s.vehicleId,
    label: customLabels[s.vehicleId] ?? s.vehicleId,
    sublabel: VEHICLE_SHORT[s.vehicleType] || s.vehicleType,
    dotColor: CATEGORY_COLORS[s.category] || "#6b7280",
  }));
}

function shiftsToBars(
  shifts: VehicleShift[],
  routeColorMap: Map<string, string>,
  depotOverrides: Record<string, { pullOutMin?: number; pullInMin?: number }> = {},
): GanttBar[] {
  const bars: GanttBar[] = [];

  for (const shift of shifts) {
    const ovr = depotOverrides[shift.vehicleId] ?? {};
    const pullOutMin = ovr.pullOutMin ?? 10;
    const pullInMin = ovr.pullInMin ?? 10;

    // ── Sintetica: uscita deposito (pull-out) prima della prima corsa ──
    const firstTrip = shift.trips.find(t => t.type === "trip");
    if (firstTrip && pullOutMin > 0) {
      const pullStart = Math.max(0, firstTrip.departureMin - pullOutMin);
      bars.push({
        id: `${shift.vehicleId}_pullout`,
        rowId: shift.vehicleId,
        startMin: pullStart,
        endMin: firstTrip.departureMin,
        label: "🏁",
        color: "#16a34a",
        style: "depot",
        tooltip: ["Uscita dal deposito", `${pullOutMin}′`, `Verso ${firstTrip.firstStopName || "—"}`],
        locked: true,
        meta: { type: "pullout", vehicleType: shift.vehicleType, category: shift.category },
      });
    }

    for (const entry of shift.trips) {
      const id = entry.type === "trip"
        ? entry.tripId
        : `${shift.vehicleId}_${entry.type}_${entry.departureMin}`;

      let style: GanttBar["style"] = "solid";
      let color = routeColorMap.get(entry.routeId) || "#6b7280";
      let locked = false;

      if (entry.type === "deadhead") {
        style = "striped";
        color = "rgba(255,255,255,0.12)";
        locked = true;
      } else if (entry.type === "depot") {
        style = "depot";
        color = "#f59e0b"; // ambra — rientro intermedio in deposito ben visibile
        locked = true;
      }

      const tooltip: string[] = [];
      if (entry.type === "trip") {
        tooltip.push(`${entry.routeName} → ${entry.headsign || "?"}`);
        tooltip.push(`${entry.departureTime?.slice(0, 5)} → ${entry.arrivalTime?.slice(0, 5)}`);
        if (entry.firstStopName) tooltip.push(`Da: ${entry.firstStopName}`);
        if (entry.lastStopName) tooltip.push(`A: ${entry.lastStopName}`);
        if (entry.stopCount) tooltip.push(`${entry.stopCount} fermate`);
        if (entry.downsized) tooltip.push(`⚠ Mezzo ridotto (richiesto: ${VEHICLE_LABELS[entry.originalVehicle!]})`);
      } else if (entry.type === "deadhead") {
        tooltip.push(`Vuoto ${entry.deadheadKm ?? 0} km`);
      } else {
        const dur = entry.arrivalMin - entry.departureMin;
        tooltip.push(`🏠 Rientro in deposito (fermo ${dur} min)`);
      }

      bars.push({
        id,
        rowId: shift.vehicleId,
        startMin: entry.departureMin,
        endMin: entry.arrivalMin,
        label: entry.type === "trip" ? entry.routeName : entry.type === "deadhead" ? "↝" : "🏠 dep.",
        color,
        style,
        tooltip,
        locked,
        meta: {
          tripId: entry.tripId,
          routeId: entry.routeId,
          type: entry.type,
          vehicleType: shift.vehicleType,
          category: shift.category,
        },
      });
    }

    // ── Sintetica: rientro finale al deposito (pull-in) ──
    const lastTripRev = [...shift.trips].reverse().find(t => t.type === "trip");
    if (lastTripRev && pullInMin > 0) {
      bars.push({
        id: `${shift.vehicleId}_pullin`,
        rowId: shift.vehicleId,
        startMin: lastTripRev.arrivalMin,
        endMin: lastTripRev.arrivalMin + pullInMin,
        label: "🏠",
        color: "#0891b2",
        style: "depot",
        tooltip: ["Rientro finale in deposito", `${pullInMin}′`, `Da ${lastTripRev.lastStopName || "—"}`],
        locked: true,
        meta: { type: "pullin", vehicleType: shift.vehicleType, category: shift.category },
      });
    }
  }
  return bars;
}

function buildRouteColorMap(shifts: VehicleShift[]): Map<string, string> {
  const routeIds = new Set<string>();
  for (const s of shifts) {
    for (const t of s.trips) {
      if (t.routeId) routeIds.add(t.routeId);
    }
  }
  const map = new Map<string, string>();
  let i = 0;
  for (const rid of routeIds) {
    map.set(rid, ROUTE_PALETTE[i % ROUTE_PALETTE.length]);
    i++;
  }
  return map;
}

/* ═══════════════════════════════════════════════════════════════
 *  Summary stat card
 * ═══════════════════════════════════════════════════════════════ */

function StatCard({ icon, label, value, sub, color }: {
  icon: React.ReactNode; label: string; value: string; sub?: string; color?: string;
}) {
  return (
    <div className="bg-muted/30 rounded-xl px-4 py-3 border border-border/30 min-w-[130px]">
      <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground mb-1">{icon} {label}</div>
      <div className="text-lg font-bold font-mono" style={color ? { color } : undefined}>{value}</div>
      {sub && <div className="text-[9px] text-muted-foreground mt-0.5">{sub}</div>}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
 *  Modification tracker + History (undo/redo)
 * ═══════════════════════════════════════════════════════════════ */

interface TripReassignment {
  tripId: string;
  fromVehicle: string;
  toVehicle: string;
  oldStartMin: number;
  newStartMin: number;
  oldEndMin: number;
  newEndMin: number;
}

type ActionKind =
  | "drag"
  | "rename"
  | "load"
  | "reoptimize"
  | "revert_baseline"
  | "reset"
  | "undo"
  | "redo"
  | "deadhead";

interface ActionEntry {
  id: number;                 // monotonic id
  kind: ActionKind;
  timestamp: number;          // Date.now()
  description: string;        // human-readable
  detail?: string;            // optional extra
}

interface HistoryFrame {
  result: ServiceProgramResult;       // snapshot completo
  customLabels: Record<string, string>;
  action: ActionEntry;                // azione che ha generato questo frame
}

const cloneResult = (r: ServiceProgramResult): ServiceProgramResult =>
  // structuredClone è disponibile in tutti i browser moderni e Node 17+
  typeof structuredClone === "function"
    ? structuredClone(r)
    : (JSON.parse(JSON.stringify(r)) as ServiceProgramResult);

/** Stima km/min di un deadhead da coordinate (haversine + circuity 1.3 + 5min buffer). */
function estimateDeadhead(
  lat1?: number, lon1?: number, lat2?: number, lon2?: number,
  category: ServiceCategory = "urbano",
): { km: number; min: number } {
  if (lat1 == null || lon1 == null || lat2 == null || lon2 == null) {
    return { km: 0, min: 0 };
  }
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const straight = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const km = straight * 1.3;
  const speed = category === "extraurbano" ? 40 : 20;
  const min = Math.ceil((km / speed) * 60) + 5;
  return { km: Math.round(km * 10) / 10, min };
}

/** Ricalcola i totali di un singolo turno macchina dopo modifiche. */
function recomputeShift(s: VehicleShift): VehicleShift {
  const trips = s.trips;
  const tripEntries = trips.filter(t => t.type === "trip");
  const dhEntries = trips.filter(t => t.type === "deadhead");
  const depotEntries = trips.filter(t => t.type === "depot");
  const totalServiceMin = tripEntries.reduce(
    (a, t) => a + Math.max(0, t.arrivalMin - t.departureMin), 0,
  );
  const totalDeadheadMin = dhEntries.reduce(
    (a, t) => a + (t.deadheadMin ?? Math.max(0, t.arrivalMin - t.departureMin)), 0,
  );
  const totalDeadheadKm = dhEntries.reduce((a, t) => a + (t.deadheadKm ?? 0), 0);
  const startMin = trips.length ? trips[0].departureMin : s.startMin;
  const endMin = trips.length ? trips[trips.length - 1].arrivalMin : s.endMin;
  return {
    ...s,
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

/** Ricalcola summary aggregato a partire dai shifts. */
function recomputeSummary(result: ServiceProgramResult): ServiceProgramResult {
  const shifts = result.shifts;
  const totalServiceMin = shifts.reduce((a, s) => a + s.totalServiceMin, 0);
  const totalDeadheadMin = shifts.reduce((a, s) => a + s.totalDeadheadMin, 0);
  const totalDeadheadKm = shifts.reduce((a, s) => a + s.totalDeadheadKm, 0);
  const totalTrips = shifts.reduce((a, s) => a + s.tripCount, 0);
  const byType: Record<string, number> = {};
  for (const s of shifts) byType[s.vehicleType] = (byType[s.vehicleType] ?? 0) + 1;
  return {
    ...result,
    summary: result.summary ? {
      ...result.summary,
      totalVehicles: shifts.length,
      totalTrips,
      totalServiceHours: totalServiceMin / 60,
      totalDeadheadHours: totalDeadheadMin / 60,
      totalDeadheadKm,
      byType,
      efficiency: totalServiceMin + totalDeadheadMin > 0
        ? totalServiceMin / (totalServiceMin + totalDeadheadMin) : 0,
    } : result.summary,
  };
}

/** Rimuove i turni macchina senza alcuna corsa di servizio. Restituisce
 * il risultato pulito + il numero di turni eliminati. */
function pruneEmptyShifts(result: ServiceProgramResult): { result: ServiceProgramResult; removed: number } {
  const before = result.shifts.length;
  const kept = result.shifts.filter(s => s.trips.some(t => t.type === "trip"));
  if (kept.length === before) return { result, removed: 0 };
  const next = recomputeSummary({ ...result, shifts: kept });
  return { result: next, removed: before - kept.length };
}

/** Per ogni turno, inserisce un trasferimento a vuoto tra due corse consecutive
 * se sono in capolinea diversi e il gap non è già coperto da deadhead/depot.
 * Inserisce anche un rientro deposito alla fine se manca. */
function regenerateMissingDeadheads(result: ServiceProgramResult): { result: ServiceProgramResult; added: number } {
  let added = 0;
  const newShifts = result.shifts.map(shift => {
    if (shift.trips.length === 0) return shift;
    const trips = [...shift.trips];
    const inserted: ShiftTripEntry[] = [];

    for (let i = 0; i < trips.length; i++) {
      inserted.push(trips[i]);
      const a = trips[i];
      const b = trips[i + 1];
      if (!b) continue;
      // Solo tra due corse di servizio
      if (a.type !== "trip" || b.type !== "trip") continue;
      const gap = b.departureMin - a.arrivalMin;
      if (gap <= 0) continue;
      // Se i due capolinea coincidono → nessun deadhead necessario
      const sameStop = a.lastStopName && b.firstStopName
        && a.lastStopName.trim().toUpperCase() === b.firstStopName.trim().toUpperCase();
      if (sameStop) continue;
      // Stima conservativa: deadhead pari a min(gap, 15 min) se non abbiamo coordinate.
      // L'utente può raffinare km e durata dal dialog.
      const dhMin = Math.min(15, gap);
      const estKm = Math.round((dhMin / 60) * 20 * 1.3 * 10) / 10; // ~20 km/h × tempo
      const dhStart = a.arrivalMin;
      const dhEnd = a.arrivalMin + dhMin;
      const minToTime = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}:00`;
      const newEntry: ShiftTripEntry = {
        type: "deadhead",
        tripId: `dh_auto_${shift.vehicleId}_${dhStart}`,
        routeId: b.routeId,
        routeName: "Trasferimento a vuoto",
        headsign: null,
        departureTime: minToTime(dhStart),
        arrivalTime: minToTime(dhEnd),
        departureMin: dhStart,
        arrivalMin: dhEnd,
        deadheadKm: estKm,
        deadheadMin: dhMin,
        firstStopName: a.lastStopName,
        lastStopName: b.firstStopName,
        durationMin: dhMin,
      } as ShiftTripEntry;
      inserted.push(newEntry);
      added++;
    }
    return recomputeShift({ ...shift, trips: inserted });
  });
  if (added === 0) return { result, added: 0 };
  return { result: recomputeSummary({ ...result, shifts: newShifts }), added };
}

/* ═══════════════════════════════════════════════════════════════
 *  Diff helpers — confronto turni v1 (baseline) vs v2 (post-intermodale)
 * ═══════════════════════════════════════════════════════════════ */

interface ScheduleDiff {
  vehiclesBefore: number;
  vehiclesAfter: number;
  serviceHoursBefore: number;
  serviceHoursAfter: number;
  deadheadKmBefore: number;
  deadheadKmAfter: number;
  efficiencyBefore: number;
  efficiencyAfter: number;
  costBefore: number;
  costAfter: number;
  tripsTimeShifted: number;
  tripsReassigned: number;
  examples: Array<{ tripId: string; routeName: string; oldVehicle: string; newVehicle: string; oldDep: string; newDep: string; deltaMin: number }>;
}

function buildScheduleDiff(before: ServiceProgramResult, after: ServiceProgramResult): ScheduleDiff {
  const beforeMap = new Map<string, { vehicleId: string; departureMin: number; departureTime: string; routeName: string }>();
  for (const sh of before.shifts) {
    for (const t of sh.trips) {
      if (t.type !== "trip") continue;
      beforeMap.set(t.tripId, { vehicleId: sh.vehicleId, departureMin: t.departureMin, departureTime: t.departureTime || "", routeName: t.routeName });
    }
  }
  let timeShifted = 0;
  let reassigned = 0;
  const examples: ScheduleDiff["examples"] = [];
  for (const sh of after.shifts) {
    for (const t of sh.trips) {
      if (t.type !== "trip") continue;
      const prev = beforeMap.get(t.tripId);
      if (!prev) continue;
      const delta = t.departureMin - prev.departureMin;
      const moved = sh.vehicleId !== prev.vehicleId;
      if (delta !== 0) timeShifted++;
      if (moved) reassigned++;
      if ((delta !== 0 || moved) && examples.length < 12) {
        examples.push({
          tripId: t.tripId,
          routeName: t.routeName,
          oldVehicle: prev.vehicleId,
          newVehicle: sh.vehicleId,
          oldDep: prev.departureTime.slice(0, 5),
          newDep: (t.departureTime || "").slice(0, 5),
          deltaMin: delta,
        });
      }
    }
  }
  return {
    vehiclesBefore: before.shifts.length,
    vehiclesAfter: after.shifts.length,
    serviceHoursBefore: before.summary?.totalServiceHours ?? 0,
    serviceHoursAfter: after.summary?.totalServiceHours ?? 0,
    deadheadKmBefore: before.summary?.totalDeadheadKm ?? 0,
    deadheadKmAfter: after.summary?.totalDeadheadKm ?? 0,
    efficiencyBefore: before.summary?.efficiency ?? 0,
    efficiencyAfter: after.summary?.efficiency ?? 0,
    costBefore: before.costs?.totalDailyCost ?? 0,
    costAfter: after.costs?.totalDailyCost ?? 0,
    tripsTimeShifted: timeShifted,
    tripsReassigned: reassigned,
    examples,
  };
}

/** Calcola il delta orario (min) tra `before` e `after` per ciascun tripId. */
function computeTripTimeOverrides(
  before: VehicleShift[],
  after: VehicleShift[],
): Record<string, { departureMin: number; arrivalMin: number; departureTime: string; arrivalTime: string }> {
  const out: Record<string, { departureMin: number; arrivalMin: number; departureTime: string; arrivalTime: string }> = {};
  const beforeIdx = new Map<string, ShiftTripEntry>();
  for (const sh of before) for (const t of sh.trips) if (t.type === "trip") beforeIdx.set(t.tripId, t);
  for (const sh of after) for (const t of sh.trips) {
    if (t.type !== "trip") continue;
    const prev = beforeIdx.get(t.tripId);
    if (!prev) continue;
    if (prev.departureMin !== t.departureMin || prev.arrivalMin !== t.arrivalMin) {
      out[t.tripId] = {
        departureMin: t.departureMin,
        arrivalMin: t.arrivalMin,
        departureTime: t.departureTime || "",
        arrivalTime: t.arrivalTime || "",
      };
    }
  }
  return out;
}

/** Ricostruisce i parametri minimi della richiesta CP-SAT a partire dal risultato attuale. */
function rebuildOptimizeRequest(result: ServiceProgramResult): {
  date: string;
  routes: { routeId: string; vehicleType: VehicleType; forced?: boolean }[];
} {
  const routesMap = new Map<string, VehicleType>();
  for (const sh of result.shifts) {
    for (const t of sh.trips) {
      if (t.type !== "trip") continue;
      if (!routesMap.has(t.routeId)) routesMap.set(t.routeId, sh.vehicleType);
    }
  }
  return {
    date: result.summary?.date || new Date().toISOString().slice(0, 10).replace(/-/g, ""),
    routes: Array.from(routesMap.entries()).map(([routeId, vehicleType]) => ({ routeId, vehicleType })),
  };
}

/* ═══════════════════════════════════════════════════════════════
 *  Main component
 * ═══════════════════════════════════════════════════════════════ */

export default function VehicleWorkspace({ initialResult }: { initialResult?: ServiceProgramResult }) {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<ServiceProgramResult | null>(initialResult ?? null);
  const [error, setError] = useState<string | null>(null);
  const [modifications, setModifications] = useState<TripReassignment[]>([]);
  const [scenarioName, setScenarioName] = useState("");
  const [savedId, setSavedId] = useState<number | null>(null);
  const [customLabels, setCustomLabels] = useState<Record<string, string>>({});
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [loadDialogOpen, setLoadDialogOpen] = useState(false);
  const [deadheadDialogOpen, setDeadheadDialogOpen] = useState(false);
  // Focus iniziale del dialog (impostato da un click sul Gantt su una bar locked)
  const [deadheadDialogFocus, setDeadheadDialogFocus] = useState<{
    vehicleId: string;
    entryDepartureMin?: number;
    entryType?: "deadhead" | "depot" | "pullout" | "pullin" | "trip";
  } | null>(null);
  const [overwriteSaving, setOverwriteSaving] = useState(false);

  // ── Override durate movimenti deposito sintetici (pull-out / pull-in) ──
  // Le barre 🏁 (uscita) e 🏠 (rientro) sono sintetiche e di default 10 min.
  // L'utente può modificarne la durata o eliminarle (durata=0 → barra nascosta).
  // Mappa: vehicleId → { pullOutMin, pullInMin }
  const [depotMovementOverrides, setDepotMovementOverrides] = useState<
    Record<string, { pullOutMin?: number; pullInMin?: number }>
  >({});

  // ── History / Undo system ──
  const [originalResult, setOriginalResult] = useState<ServiceProgramResult | null>(
    initialResult ? cloneResult(initialResult) : null
  );
  const [history, setHistory] = useState<HistoryFrame[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number>(-1);
  const [actionLog, setActionLog] = useState<ActionEntry[]>([]);
  const [historyPanelOpen, setHistoryPanelOpen] = useState(false);
  const actionIdRef = React.useRef(0);
  // FIX-REFRESH: tengo l'indice corrente in un ref per evitare race condition
  // tra setResult/setHistory/setHistoryIndex (più drag in rapida sequenza).
  const historyIndexRef = React.useRef<number>(-1);
  React.useEffect(() => { historyIndexRef.current = historyIndex; }, [historyIndex]);
  const customLabelsRef = React.useRef<Record<string, string>>({});
  React.useEffect(() => { customLabelsRef.current = customLabels; }, [customLabels]);

  // Inizializza la baseline quando arriva un result e non c'è una storia
  useEffect(() => {
    if (initialResult && !originalResult) {
      setOriginalResult(cloneResult(initialResult));
    }
  }, [initialResult, originalResult]);

  /** Spinge un nuovo frame nella history (tronca i redo). USA REF per essere
   * sempre coerente anche se chiamato in rapida sequenza. */
  const pushHistory = useCallback((
    newResult: ServiceProgramResult,
    kind: ActionKind,
    description: string,
    detail?: string,
  ) => {
    const action: ActionEntry = {
      id: ++actionIdRef.current,
      kind,
      timestamp: Date.now(),
      description,
      detail,
    };
    setActionLog(prev => [...prev, action]);
    const idx = historyIndexRef.current;
    setHistory(prev => {
      const truncated = prev.slice(0, idx + 1);
      return [...truncated, {
        result: cloneResult(newResult),
        customLabels: { ...customLabelsRef.current },
        action,
      }];
    });
    historyIndexRef.current = idx + 1;
    setHistoryIndex(idx + 1);
    setSavedId(null);
  }, []);

  const canUndo = historyIndex > 0 || (historyIndex === 0 && originalResult !== null);
  const canRedo = historyIndex < history.length - 1;

  const undo = useCallback(() => {
    const idx = historyIndexRef.current;
    if (idx <= 0) {
      // Torna all'originale
      if (originalResult && idx === 0) {
        setResult(cloneResult(originalResult));
        setCustomLabels({});
        historyIndexRef.current = -1;
        setHistoryIndex(-1);
        toast.info("Annullato — tornato allo stato iniziale");
      }
      return;
    }
    const target = history[idx - 1];
    setResult(cloneResult(target.result));
    setCustomLabels({ ...target.customLabels });
    historyIndexRef.current = idx - 1;
    setHistoryIndex(idx - 1);
    toast.info("Annullato", { description: target.action.description });
  }, [originalResult, history]);

  const redo = useCallback(() => {
    const idx = historyIndexRef.current;
    if (idx >= history.length - 1) return;
    const target = history[idx + 1];
    setResult(cloneResult(target.result));
    setCustomLabels({ ...target.customLabels });
    historyIndexRef.current = idx + 1;
    setHistoryIndex(idx + 1);
    toast.info("Ripristinato", { description: target.action.description });
  }, [history]);

  const resetToOriginal = useCallback(() => {
    if (!originalResult) return;
    if (!window.confirm("Annullare TUTTE le modifiche e tornare allo scenario originale?")) return;
    setResult(cloneResult(originalResult));
    setCustomLabels({});
    setModifications([]);
    setHistory([]);
    historyIndexRef.current = -1;
    setHistoryIndex(-1);
    setActionLog(prev => [...prev, {
      id: ++actionIdRef.current,
      kind: "reset",
      timestamp: Date.now(),
      description: "Reset completo allo stato iniziale",
    }]);
    setSavedId(null);
    toast.success("Workspace resettata allo scenario originale");
  }, [originalResult]);

  // Shortcut da tastiera: cmd/ctrl+Z = undo, cmd/ctrl+shift+Z = redo
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (e.key.toLowerCase() === "y") {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);

  // ── Stato re-ottimizzazione post-Intermodale ──
  const [reoptimizing, setReoptimizing] = useState(false);
  const [reoptimizeError, setReoptimizeError] = useState<string | null>(null);
  const [scheduleDiff, setScheduleDiff] = useState<ScheduleDiff | null>(null);
  const [diffOpen, setDiffOpen] = useState(false);
  const [baselineResult, setBaselineResult] = useState<ServiceProgramResult | null>(null);

  // Build Gantt data from optimization result
  const routeColorMap = useMemo(
    () => result ? buildRouteColorMap(result.shifts) : new Map<string, string>(),
    [result],
  );
  const ganttRows = useMemo(
    () => result ? shiftsToRows(result.shifts, customLabels) : [],
    [result, customLabels],
  );
  const ganttBars = useMemo(
    () => result ? shiftsToBars(result.shifts, routeColorMap, depotMovementOverrides) : [],
    [result, routeColorMap, depotMovementOverrides],
  );

  // Map vehicleId → VehicleShift for quick lookup
  // (kept for future extensions; currently unused)

  /* ── Rename row (turno macchina) ── */
  const handleRowRename = useCallback((rowId: string, newLabel: string) => {
    const oldLabel = customLabels[rowId] ?? rowId;
    setCustomLabels(prev => ({ ...prev, [rowId]: newLabel }));
    if (result) {
      pushHistory(
        result,
        "rename",
        `Rinominato turno ${rowId}`,
        `${oldLabel} → ${newLabel}`,
      );
    }
    toast.success("Turno rinominato", { description: `${rowId} → ${newLabel}` });
  }, [customLabels, result, pushHistory]);

  /* ── Apply CRUD su deadhead dal DeadheadEditorDialog ── */
  const handleDeadheadApply = useCallback((newResult: ServiceProgramResult, change: DeadheadChange) => {
    // Auto-elimina turni macchina rimasti senza corse
    const { result: pruned, removed } = pruneEmptyShifts(newResult);
    setResult(pruned);
    setSavedId(null);
    if (removed > 0) {
      pushHistory(pruned, "deadhead",
        `${change.description} · ${removed} turn${removed === 1 ? "o vuoto eliminato" : "i vuoti eliminati"}`,
        `Operazione: ${change.operation}`);
      toast.info(`${removed} turn${removed === 1 ? "o macchina vuoto eliminato" : "i macchina vuoti eliminati"}`);
    } else {
      pushHistory(pruned, "deadhead", change.description, `Operazione: ${change.operation}`);
    }
  }, [pushHistory]);

  /* ── Click su una bar nel Gantt: se è un deadhead/depot/pullout/pullin
   * apre il DeadheadEditorDialog focalizzato su quella entry. ── */
  const handleBarClick = useCallback((bar: GanttBar) => {
    const t = bar.meta?.type as string | undefined;
    if (t === "trip" || !t) return;          // i trip seguono il flusso suggerimenti
    if (t === "deadhead" || t === "depot") {
      setDeadheadDialogFocus({
        vehicleId: bar.rowId,
        entryDepartureMin: bar.startMin,
        entryType: t as "deadhead" | "depot",
      });
      setDeadheadDialogOpen(true);
      return;
    }
    if (t === "pullout" || t === "pullin") {
      setDeadheadDialogFocus({
        vehicleId: bar.rowId,
        entryType: t as "pullout" | "pullin",
      });
      setDeadheadDialogOpen(true);
      return;
    }
  }, []);

  /* ── Modifica/eliminazione movimenti deposito sintetici (pull-out / pull-in) ──
   * durationMin = 0 → la barra sintetica viene nascosta (eliminata).
   * durationMin > 0 → durata custom della barra in minuti.
   */
  const handleDepotMovementChange = useCallback((
    vehicleId: string,
    kind: "pullOut" | "pullIn",
    durationMin: number,
  ) => {
    setDepotMovementOverrides(prev => {
      const next = { ...prev };
      const cur = { ...(next[vehicleId] ?? {}) };
      if (kind === "pullOut") cur.pullOutMin = Math.max(0, Math.round(durationMin));
      else cur.pullInMin = Math.max(0, Math.round(durationMin));
      next[vehicleId] = cur;
      return next;
    });
    if (result) {
      const label = customLabels[vehicleId] ?? vehicleId;
      const action = durationMin === 0 ? "Eliminato" : `Aggiornato a ${durationMin}′`;
      const what = kind === "pullOut" ? "uscita deposito" : "rientro deposito";
      pushHistory(result, "deadhead", `${action} ${what} su ${label}`);
      toast.success(`${action} ${what} su ${label}`);
    }
  }, [result, customLabels, pushHistory]);

  /* ── Smart suggestions: find compatible shifts for a trip bar ──
   * Scoring (lower = better):
   *   gap  (minuti dal turno adiacente)                     → preferito gap basso ma ≥ MIN_LAYOVER_DIFFERENT_TERMINAL
   *   bonus same-route (-50) se la corsa adiacente ha stessa routeId
   *   bonus stesso capolinea (-30) se l'entry adiacente arriva/parte dallo stesso stop
   *   penale se shift quasi vuoto (+100) per non spalmare 1 corsa per veicolo
   */
  const getSuggestions = useCallback((bar: GanttBar): GanttSuggestion[] => {
    if (!result) return [];
    if (bar.meta?.type !== "trip") return [];
    const fromVehicleType = bar.meta?.vehicleType as VehicleType | undefined;
    const barRouteId = bar.meta?.routeId as string | undefined;
    // Buffer minimo (minuti) intorno alla slot. 0 = stesso capolinea consentito.
    const MIN_GAP = 0;

    // Trova lo stop di partenza/arrivo della barra dalla shift sorgente (per match capolinea)
    let barFirstStop: string | undefined;
    let barLastStop: string | undefined;
    const srcShift = result.shifts.find(s => s.vehicleId === bar.rowId);
    if (srcShift) {
      const srcEntry = srcShift.trips.find(t => t.type === "trip" && t.tripId === bar.id);
      if (srcEntry && srcEntry.type === "trip") {
        barFirstStop = srcEntry.firstStopName;
        barLastStop = srcEntry.lastStopName;
      }
    }

    type Cand = {
      rowId: string; label: string; reason: string; detail: string;
      gap: number; sameRoute: boolean; sameTerminal: boolean; score: number;
    };
    const candidates: Cand[] = [];

    for (const shift of result.shifts) {
      if (shift.vehicleId === bar.rowId) continue;
      if (fromVehicleType && shift.vehicleType !== fromVehicleType) continue;

      // Verifica conflitti e cerca le corse adiacenti (prima e dopo)
      let conflict = false;
      let tightestGap = Number.POSITIVE_INFINITY;
      let neighborBefore: ShiftTripEntry | null = null;
      let neighborAfter: ShiftTripEntry | null = null;

      for (const entry of shift.trips) {
        if (entry.type === "depot") continue;
        if (bar.startMin < entry.arrivalMin && bar.endMin > entry.departureMin) {
          conflict = true;
          break;
        }
        if (entry.arrivalMin <= bar.startMin) {
          const gap = bar.startMin - entry.arrivalMin;
          if (gap < tightestGap) {
            tightestGap = gap;
            neighborBefore = entry;
            neighborAfter = null;
          }
        } else if (entry.departureMin >= bar.endMin) {
          const gap = entry.departureMin - bar.endMin;
          if (gap < tightestGap) {
            tightestGap = gap;
            neighborAfter = entry;
            neighborBefore = null;
          }
        }
      }
      if (conflict) continue;
      if (tightestGap < MIN_GAP) continue;

      const neighbor = neighborBefore ?? neighborAfter;
      const sameRoute = !!(neighbor && neighbor.type === "trip" && neighbor.routeId === barRouteId);
      let sameTerminal = false;
      if (neighbor && neighbor.type === "trip") {
        if (neighborBefore) {
          // arrivo del vicino == partenza della corsa
          sameTerminal = !!(neighbor.lastStopName && barFirstStop && neighbor.lastStopName === barFirstStop);
        } else {
          // partenza del vicino == arrivo della corsa
          sameTerminal = !!(neighbor.firstStopName && barLastStop && neighbor.firstStopName === barLastStop);
        }
      }

      // Score: gap basso = meglio, bonus same-route + same-terminal, penalità per shift quasi vuoto
      let score = tightestGap === Number.POSITIVE_INFINITY ? 9999 : tightestGap;
      if (sameRoute) score -= 50;
      if (sameTerminal) score -= 30;
      if (shift.tripCount <= 1) score += 100;

      const label = customLabels[shift.vehicleId] ?? shift.vehicleId;
      const vShort = VEHICLE_SHORT[shift.vehicleType] || shift.vehicleType;
      const tags: string[] = [];
      if (sameRoute) tags.push("stessa linea");
      if (sameTerminal) tags.push("stesso capolinea");
      const tagStr = tags.length ? ` · ${tags.join(" · ")}` : "";
      const reason = `${vShort} · ${shift.tripCount} corse${tagStr}`;

      let qual = "";
      if (tightestGap <= 5) qual = "🎯 ideale";
      else if (tightestGap <= 15) qual = "buono";
      else if (tightestGap <= 30) qual = "ok";
      else qual = "largo";
      const detail = tightestGap === Number.POSITIVE_INFINITY
        ? "libero"
        : `${qual} · ${Math.round(tightestGap)}′`;

      candidates.push({
        rowId: shift.vehicleId, label, reason, detail,
        gap: tightestGap, sameRoute, sameTerminal, score,
      });
    }

    candidates.sort((a, b) => a.score - b.score);
    return candidates.map(c => ({ rowId: c.rowId, label: c.label, reason: c.reason, detail: c.detail }));
  }, [result, customLabels]);

  // Listen for optimization results dispatched by the existing optimizer-route page
  // (or load from API results)
  useEffect(() => {
    const handler = (e: CustomEvent<ServiceProgramResult>) => {
      setResult(e.detail);
      setOriginalResult(cloneResult(e.detail));
      setHistory([]);
      historyIndexRef.current = -1;
      setHistoryIndex(-1);
      setActionLog([{
        id: ++actionIdRef.current,
        kind: "load",
        timestamp: Date.now(),
        description: "Scenario caricato dall'ottimizzatore",
      }]);
      setModifications([]);
      setSavedId(null);
    };
    window.addEventListener("fucina:vehicle-result" as any, handler);
    return () => window.removeEventListener("fucina:vehicle-result" as any, handler);
  }, []);

  /* ── Load last scenario from API ── */
  const loadLatestScenario = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const base = getApiBase();
      const res = await fetch(`${base}/api/service-program/scenarios`);
      if (!res.ok) throw new Error("Errore caricamento scenari");
      const data = await res.json();
      if (data.length === 0) {
        setError("Nessuno scenario salvato. Esegui prima un'ottimizzazione dal tab Turni Macchina.");
        return;
      }
      // Load the latest scenario
      const latest = data[0];
      const detailRes = await fetch(`${base}/api/service-program/scenarios/${latest.id}`);
      if (!detailRes.ok) throw new Error("Errore caricamento dettaglio scenario");
      const detail = await detailRes.json();
      if (detail.result) {
        setResult(detail.result);
        setOriginalResult(cloneResult(detail.result));
        setHistory([]);
        historyIndexRef.current = -1;
        setHistoryIndex(-1);
        setActionLog([{
          id: ++actionIdRef.current,
          kind: "load",
          timestamp: Date.now(),
          description: `Scenario caricato: ${detail.name || "(senza nome)"}`,
        }]);
        setScenarioName(detail.name || "");
        setModifications([]);
        setSavedId(null);
        toast.success("Scenario caricato", { description: detail.name });
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  /* ── Handle bar change (drag & drop) ──
   * Aggiorna sia il log delle modifiche, sia il `result.shifts` cos\u00ec il
   * gantt e il getSuggestions ricalcolano sui dati freschi (riassegnazione + shift orario).
   */
  const handleBarChange = useCallback((change: GanttChange, _allBars: GanttBar[]) => {
    if (change.fromRowId === change.toRowId && change.oldStartMin === change.newStartMin) return;

    setModifications(prev => [
      ...prev,
      {
        tripId: change.barId,
        fromVehicle: change.fromRowId,
        toVehicle: change.toRowId,
        oldStartMin: change.oldStartMin,
        newStartMin: change.newStartMin,
        oldEndMin: change.oldEndMin,
        newEndMin: change.newEndMin,
      },
    ]);
    setSavedId(null);

    setResult(prev => {
      if (!prev) return prev;
      const minToTime = (m: number) => {
        const h = Math.floor(m / 60);
        const mm = m % 60;
        return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00`;
      };
      const deltaStart = change.newStartMin - change.oldStartMin;
      const deltaEnd = change.newEndMin - change.oldEndMin;

      // Trova entry sorgente per id (stesso ID che usiamo nelle bars: tripId per i trip)
      const fromIdx = prev.shifts.findIndex(s => s.vehicleId === change.fromRowId);
      const toIdx = prev.shifts.findIndex(s => s.vehicleId === change.toRowId);
      if (fromIdx < 0 || toIdx < 0) return prev;

      const fromShift = prev.shifts[fromIdx];
      const entryIdx = fromShift.trips.findIndex(
        t => t.type === "trip" && t.tripId === change.barId,
      );
      if (entryIdx < 0) return prev;
      const oldEntry = fromShift.trips[entryIdx] as ShiftTripEntry;
      if (oldEntry.type !== "trip") return prev;

      const newEntry: ShiftTripEntry = {
        ...oldEntry,
        departureMin: change.newStartMin,
        arrivalMin: change.newEndMin,
        departureTime: deltaStart !== 0 ? minToTime(change.newStartMin) : oldEntry.departureTime,
        arrivalTime: deltaEnd !== 0 ? minToTime(change.newEndMin) : oldEntry.arrivalTime,
      };

      const newShifts = prev.shifts.map(s => ({ ...s, trips: [...s.trips] }));
      // Rimuovi dalla sorgente
      newShifts[fromIdx].trips.splice(entryIdx, 1);
      // Inserisci nella destinazione (stessa shift se non riassegnata) ordinato per departureMin
      const targetTrips = newShifts[toIdx].trips;
      let insertAt = targetTrips.findIndex(t => t.departureMin > newEntry.departureMin);
      if (insertAt < 0) insertAt = targetTrips.length;
      targetTrips.splice(insertAt, 0, newEntry);

      // Aggiorna tripCount
      newShifts[fromIdx].tripCount = newShifts[fromIdx].trips.filter(t => t.type === "trip").length;
      newShifts[toIdx].tripCount = newShifts[toIdx].trips.filter(t => t.type === "trip").length;

      const newResult = { ...prev, shifts: newShifts };

      // History entry — descrizione human-friendly
      const reassigned = change.fromRowId !== change.toRowId;
      const shifted = deltaStart !== 0;
      let desc = "";
      if (reassigned && shifted) {
        desc = `Spostata corsa ${oldEntry.routeName} (${change.barId.slice(0, 12)}) da ${change.fromRowId} a ${change.toRowId}, ${deltaStart > 0 ? "+" : ""}${deltaStart}′`;
      } else if (reassigned) {
        desc = `Riassegnata corsa ${oldEntry.routeName} (${change.barId.slice(0, 12)}) da ${change.fromRowId} a ${change.toRowId}`;
      } else {
        desc = `Spostata corsa ${oldEntry.routeName} (${change.barId.slice(0, 12)}) di ${deltaStart > 0 ? "+" : ""}${deltaStart}′`;
      }
      // Auto-elimina turni macchina rimasti senza corse
      const { result: prunedResult, removed } = pruneEmptyShifts(newResult);
      const finalDesc = removed > 0
        ? `${desc} · ${removed} turn${removed === 1 ? "o vuoto eliminato" : "i vuoti eliminati"}`
        : desc;
      // Non chiamare pushHistory dentro setResult (cattura il risultato fresco)
      setTimeout(() => {
        pushHistory(prunedResult, "drag", finalDesc);
        if (removed > 0) {
          toast.info(`${removed} turn${removed === 1 ? "o macchina vuoto eliminato" : "i macchina vuoti eliminati"}`);
        }
      }, 0);

      return prunedResult;
    });
  }, [pushHistory]);

  /* ── Apply Intermodal scenario: ricalcola i turni con i nuovi orari ──
   * Flusso:
   *  1. salva il `result` corrente come baseline
   *  2. estrae i tripTimeOverrides dai shifts modificati dall'analisi intermodale
   *  3. rilancia il CP-SAT con gli stessi parametri ma con orari override
   *  4. sostituisce il `result` con il nuovo + apre il diff dialog
   */
  const handleApplyIntermodalScenario = useCallback(async (modifiedShifts: VehicleShift[]) => {
    if (!result) return;
    const overrides = computeTripTimeOverrides(result.shifts, modifiedShifts);
    if (Object.keys(overrides).length === 0) {
      toast.info("Nessuna modifica oraria da applicare");
      return;
    }
    setReoptimizing(true);
    setReoptimizeError(null);
    const previousResult = result;
    try {
      const { date, routes } = rebuildOptimizeRequest(result);
      const base = getApiBase();
      const res = await fetch(`${base}/api/service-program/cpsat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          date,
          routes,
          tripTimeOverrides: overrides,
          timeLimit: 60,
          solverIntensity: "normal",
        }),
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status} ${txt.slice(0, 200)}`);
      }
      const newResult = (await res.json()) as ServiceProgramResult;
      if (!newResult || !Array.isArray(newResult.shifts)) {
        throw new Error("Risposta solver non valida");
      }
      // Salva baseline + nuovo + calcola diff
      setBaselineResult(previousResult);
      setResult(newResult);
      setModifications([]);
      const diff = buildScheduleDiff(previousResult, newResult);
      setScheduleDiff(diff);
      setDiffOpen(true);
      pushHistory(
        newResult,
        "reoptimize",
        `Ri-ottimizzazione intermodale (${Object.keys(overrides).length} corse spostate)`,
        `Δveicoli ${diff.vehiclesAfter - diff.vehiclesBefore >= 0 ? "+" : ""}${diff.vehiclesAfter - diff.vehiclesBefore}`,
      );
      toast.success("Turni ri-ottimizzati con orari intermodali", {
        description: `${Object.keys(overrides).length} corse spostate · Δveicoli ${diff.vehiclesAfter - diff.vehiclesBefore >= 0 ? "+" : ""}${diff.vehiclesAfter - diff.vehiclesBefore}`,
      });
    } catch (err: any) {
      setReoptimizeError(err.message);
      toast.error("Errore ri-ottimizzazione", { description: err.message });
    } finally {
      setReoptimizing(false);
    }
  }, [result, pushHistory]);

  /* ── Save scenario (chiamata dal SaveScenarioDialog con il nome scelto) ── */
  const handleSave = useCallback(async (name: string): Promise<boolean> => {
    if (!result) return false;
    const finalName = name.trim() || `Scenario ${new Date().toLocaleString("it-IT")}`;
    setSaving(true);
    try {
      const base = getApiBase();
      const res = await fetch(`${base}/api/service-program/scenarios`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: finalName,
          date: result.summary?.date || new Date().toISOString().slice(0, 10).replace(/-/g, ""),
          input: { modifications, customLabels },
          result,
        }),
      });
      if (!res.ok) throw new Error("Errore salvataggio");
      const data = await res.json();
      setSavedId(data.id);
      setScenarioName(finalName);
      toast.success("Scenario salvato!", { description: `${finalName} (id ${data.id})` });
      return true;
    } catch (err: any) {
      toast.error("Errore salvataggio", { description: err.message });
      return false;
    } finally {
      setSaving(false);
    }
  }, [result, modifications, customLabels]);

  /* ── Sovrascrivi scenario corrente (PUT). Prima fa prune turni vuoti e
   * rigenera i trasferimenti a vuoto mancanti tra corse in capolinea diversi. ── */
  const handleOverwriteSave = useCallback(async () => {
    if (!result || savedId == null) return;
    setOverwriteSaving(true);
    try {
      // 1. prune
      const { result: pruned, removed } = pruneEmptyShifts(result);
      // 2. regenerate missing deadheads
      const { result: regenerated, added } = regenerateMissingDeadheads(pruned);
      const finalResult = regenerated;
      // 3. PUT
      const base = getApiBase();
      const res = await fetch(`${base}/api/service-program/scenarios/${savedId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: scenarioName || undefined,
          input: { modifications, customLabels, depotMovementOverrides },
          result: finalResult,
        }),
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status} ${txt.slice(0, 200)}`);
      }
      // 4. update local state
      setResult(finalResult);
      if (removed > 0 || added > 0) {
        const parts: string[] = [];
        if (removed > 0) parts.push(`${removed} turn${removed === 1 ? "o vuoto eliminato" : "i vuoti eliminati"}`);
        if (added > 0) parts.push(`${added} vuot${added === 1 ? "o" : "i"} generat${added === 1 ? "o" : "i"}`);
        pushHistory(finalResult, "deadhead", `Salvataggio · ${parts.join(", ")}`);
      }
      toast.success("Scenario sovrascritto", {
        description: added > 0
          ? `${added} trasferiment${added === 1 ? "o a vuoto generato" : "i a vuoto generati"} automaticamente`
          : "Modifiche salvate sul file",
      });
    } catch (err: any) {
      toast.error("Errore sovrascrittura", { description: err.message });
    } finally {
      setOverwriteSaving(false);
    }
  }, [result, savedId, scenarioName, modifications, customLabels, depotMovementOverrides, pushHistory]);

  /* ── Re-lancia il solver CP-SAT sullo scenario modificato. Usa le linee
   * dei turni correnti come input (mantenendo i tipi veicolo richiesti). ── */
  const handleReoptimize = useCallback(async () => {
    if (!result) return;
    if (!window.confirm(
      "Rilanciare l'ottimizzatore sullo scenario corrente?\n\n" +
      "I turni saranno ricalcolati da zero in base alle corse e ai vincoli attuali. " +
      "Le modifiche manuali fatte ai turni macchina saranno sostituite dal nuovo risultato."
    )) return;
    const previousResult = result;
    setReoptimizing(true);
    setReoptimizeError(null);
    try {
      const { date, routes } = rebuildOptimizeRequest(result);
      const base = getApiBase();
      const res = await fetch(`${base}/api/service-program/cpsat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          date, routes,
          timeLimit: 60,
          solverIntensity: "normal",
        }),
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status} ${txt.slice(0, 200)}`);
      }
      const newResult = (await res.json()) as ServiceProgramResult;
      if (!newResult || !Array.isArray(newResult.shifts)) {
        throw new Error("Risposta solver non valida");
      }
      setBaselineResult(previousResult);
      setResult(newResult);
      setModifications([]);
      const diff = buildScheduleDiff(previousResult, newResult);
      setScheduleDiff(diff);
      setDiffOpen(true);
      pushHistory(
        newResult, "reoptimize",
        `Ri-ottimizzazione manuale (${routes.length} linee, ${newResult.shifts.length} veicoli)`,
        `Δveicoli ${diff.vehiclesAfter - diff.vehiclesBefore >= 0 ? "+" : ""}${diff.vehiclesAfter - diff.vehiclesBefore}`,
      );
      toast.success("Ottimizzatore rilanciato", {
        description: `${newResult.shifts.length} veicoli · Δ ${diff.vehiclesAfter - diff.vehiclesBefore >= 0 ? "+" : ""}${diff.vehiclesAfter - diff.vehiclesBefore}`,
      });
    } catch (err: any) {
      setReoptimizeError(err.message);
      toast.error("Errore ri-ottimizzazione", { description: err.message });
    } finally {
      setReoptimizing(false);
    }
  }, [result, pushHistory]);

  /* ── Load scenario specifico dalla lista ── */
  const handleLoadScenario = useCallback((id: number, name: string, loaded: ServiceProgramResult) => {
    setResult(loaded);
    setOriginalResult(cloneResult(loaded));
    setHistory([]);
    historyIndexRef.current = -1;
    setHistoryIndex(-1);
    setActionLog([{
      id: ++actionIdRef.current,
      kind: "load",
      timestamp: Date.now(),
      description: `Scenario caricato: ${name}`,
    }]);
    setScenarioName(name);
    setSavedId(id);
    setModifications([]);
    setBaselineResult(null);
    setScheduleDiff(null);
  }, []);

  /* ── Stampa scenario ── */
  const handlePrint = useCallback(() => {
    if (!result) return;
    exportScenarioToPrint(result, {
      scenarioName: scenarioName || undefined,
      customLabels,
      columnsPerPage: 3,
      orientation: "landscape",
    });
  }, [result, scenarioName, customLabels]);

  /* ── Empty state ── */
  if (!result && !loading) {
    return (
      <div className="flex flex-col items-center justify-center h-[60vh] gap-6 px-4">
        <motion.div
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.5 }}
          className="text-center space-y-4"
        >
          <div className="relative inline-flex">
            <Flame className="w-16 h-16 text-orange-400/60" />
            <div className="absolute inset-0 blur-2xl bg-orange-400/20 rounded-full pointer-events-none" />
          </div>
          <div>
            <h2 className="text-xl font-display font-bold text-foreground mb-1">
              Workspace Turni Macchina
            </h2>
            <p className="text-sm text-muted-foreground max-w-md mx-auto">
              Carica uno scenario ottimizzato per iniziare a lavorare.
              Potrai spostare le corse tra i turni macchina con il drag & drop
              e salvare il risultato.
            </p>
          </div>

          {error && (
            <div className="bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-2 text-sm text-red-400 max-w-md">
              {error}
            </div>
          )}

          <div className="flex items-center gap-3 justify-center">
            <Button
              onClick={loadLatestScenario}
              disabled={loading}
              className="bg-orange-500 hover:bg-orange-600 text-white"
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Download className="w-4 h-4 mr-2" />}
              Carica ultimo scenario
            </Button>
            <Button
              variant="outline"
              onClick={() => setLoadDialogOpen(true)}
              disabled={loading}
              className="border-orange-500/40 text-orange-300 hover:bg-orange-500/10"
            >
              <FolderOpen className="w-4 h-4 mr-2" />
              Sfoglia scenari salvati…
            </Button>
          </div>

          <div className="flex items-center gap-2 text-[10px] text-muted-foreground/60 justify-center">
            <Info className="w-3 h-3" />
            <span>Oppure esegui un'ottimizzazione CP-SAT dal tab Turni Macchina</span>
          </div>
        </motion.div>
        <LoadScenarioDialog
          open={loadDialogOpen}
          onClose={() => setLoadDialogOpen(false)}
          onLoad={handleLoadScenario}
        />
      </div>
    );
  }

  /* ── Loading ── */
  if (loading) {
    return (
      <div className="flex items-center justify-center h-[60vh] gap-3 text-muted-foreground">
        <div className="w-5 h-5 border-2 border-orange-400 border-t-transparent rounded-full animate-spin" />
        <p className="text-sm">Caricamento scenario…</p>
      </div>
    );
  }

  if (!result) return null;

  const summary = result.summary;
  const hasModifications = modifications.length > 0;

  return (
    <div className="h-full flex flex-col">
      {/* ── Summary stats ── */}
      <div className="px-4 pt-3 pb-2 border-b border-border/20 shrink-0">
        <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
          <div className="flex items-center gap-3 flex-wrap">
            <StatCard
              icon={<Truck className="w-3 h-3" />}
              label="Veicoli"
              value={String(summary?.totalVehicles ?? result.shifts.length)}
              sub={summary?.byType ? Object.entries(summary.byType).map(([k, v]) => `${v} ${k}`).join(" · ") : undefined}
              color="#3b82f6"
            />
            <StatCard
              icon={<Route className="w-3 h-3" />}
              label="Corse"
              value={String(summary?.totalTrips ?? result.shifts.reduce((s, v) => s + v.tripCount, 0))}
              color="#22c55e"
            />
            <StatCard
              icon={<Clock className="w-3 h-3" />}
              label="Ore servizio"
              value={summary?.totalServiceHours?.toFixed(1) ?? "—"}
              color="#f59e0b"
            />
            <StatCard
              icon={<Fuel className="w-3 h-3" />}
              label="Km vuoto"
              value={summary?.totalDeadheadKm?.toFixed(0) ?? "—"}
              sub={summary?.efficiency ? `Eff. ${(summary.efficiency * 100).toFixed(0)}%` : undefined}
              color="#ef4444"
            />
          </div>

          {/* ── Save controls ── */}
          <div className="flex items-center gap-2">
            {hasModifications && (
              <motion.div
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                className="flex items-center gap-1.5 bg-amber-500/10 border border-amber-500/20 rounded-lg px-2.5 py-1.5"
              >
                <div className="w-2 h-2 bg-amber-400 rounded-full animate-pulse" />
                <span className="text-[10px] text-amber-400 font-medium">
                  {modifications.length} modific{modifications.length === 1 ? "a" : "he"}
                </span>
              </motion.div>
            )}

            {result && result.shifts.length > 0 && (
              <IntermodalAdvisor
                shifts={result.shifts}
                date={summary?.date}
                onApplyScenario={handleApplyIntermodalScenario}
              />
            )}

            {/* Pulsante riapri diff (visibile solo se è stata fatta una re-ottimizzazione) */}
            {scheduleDiff && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setDiffOpen(true)}
                className="border-cyan-500/40 text-cyan-300 hover:bg-cyan-500/10 h-8 text-[11px]"
                title="Riapri il confronto turni baseline vs post-Intermodale"
              >
                <BarChart3 className="w-3.5 h-3.5 mr-1" />
                Diff turni
              </Button>
            )}

            {/* ── Undo / Redo / History / Reset ── */}
            <div className="flex items-center gap-0.5 bg-muted/20 rounded-lg border border-border/30 px-1 h-8">
              <button
                onClick={undo}
                disabled={!canUndo}
                title="Annulla (⌘Z)"
                className="p-1.5 rounded hover:bg-muted/40 disabled:opacity-30 disabled:cursor-not-allowed text-muted-foreground hover:text-foreground"
              >
                <Undo2 className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={redo}
                disabled={!canRedo}
                title="Ripristina (⌘⇧Z)"
                className="p-1.5 rounded hover:bg-muted/40 disabled:opacity-30 disabled:cursor-not-allowed text-muted-foreground hover:text-foreground"
              >
                <Redo2 className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => setHistoryPanelOpen(p => !p)}
                title="Mostra/nascondi cronologia azioni"
                className={`p-1.5 rounded hover:bg-muted/40 ${historyPanelOpen ? "text-orange-400 bg-orange-500/10" : "text-muted-foreground hover:text-foreground"}`}
              >
                <History className="w-3.5 h-3.5" />
                {actionLog.length > 0 && (
                  <span className="text-[8px] font-mono ml-0.5">{actionLog.length}</span>
                )}
              </button>
              <button
                onClick={resetToOriginal}
                disabled={!originalResult || history.length === 0}
                title="Reset completo allo stato iniziale"
                className="p-1.5 rounded hover:bg-red-500/20 hover:text-red-300 disabled:opacity-30 disabled:cursor-not-allowed text-muted-foreground"
              >
                <Home className="w-3.5 h-3.5" />
              </button>
            </div>

            {/* Gestione trasferimenti a vuoto */}
            <Button
              size="sm"
              variant="outline"
              onClick={() => setDeadheadDialogOpen(true)}
              disabled={!result}
              className="border-amber-500/40 text-amber-300 hover:bg-amber-500/10 h-8 text-[11px]"
              title="Inserisci, modifica o elimina trasferimenti a vuoto"
            >
              <Wind className="w-3.5 h-3.5 mr-1" />
              Vuoti
            </Button>

            {/* Carica scenario salvato */}
            <Button
              size="sm"
              variant="outline"
              onClick={() => setLoadDialogOpen(true)}
              className="border-orange-500/40 text-orange-300 hover:bg-orange-500/10 h-8 text-[11px]"
              title="Carica uno scenario salvato in precedenza"
            >
              <FolderOpen className="w-3.5 h-3.5 mr-1" />
              Carica
            </Button>

            {/* Stampa scenario */}
            <Button
              size="sm"
              variant="outline"
              onClick={handlePrint}
              disabled={!result}
              className="border-blue-500/40 text-blue-300 hover:bg-blue-500/10 h-8 text-[11px]"
              title="Esporta lo scenario come stampa (un turno per colonna)"
            >
              <Printer className="w-3.5 h-3.5 mr-1" />
              Stampa
            </Button>

            {scenarioName && (
              <span className="text-[10px] text-muted-foreground/70 max-w-[160px] truncate" title={scenarioName}>
                {scenarioName}
              </span>
            )}

            {/* Ri-ottimizza CP-SAT sullo scenario corrente */}
            <Button
              size="sm"
              variant="outline"
              onClick={handleReoptimize}
              disabled={!result || reoptimizing}
              className="border-purple-500/40 text-purple-300 hover:bg-purple-500/10 h-8 text-[11px]"
              title="Rilancia il solver CP-SAT sulle linee dello scenario corrente"
            >
              {reoptimizing
                ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" />
                : <Play className="w-3.5 h-3.5 mr-1" />}
              Ri-ottimizza
            </Button>

            {/* Salva (overwrite): visibile solo se lo scenario è già stato salvato.
             * Auto-elimina turni vuoti e genera trasferimenti a vuoto mancanti. */}
            {savedId != null && (
              <Button
                size="sm"
                onClick={handleOverwriteSave}
                disabled={overwriteSaving || !result}
                className="bg-emerald-600 hover:bg-emerald-700 text-white h-8 text-[11px]"
                title="Sovrascrivi il file dello scenario corrente, eliminando i turni vuoti e generando i trasferimenti a vuoto mancanti"
              >
                {overwriteSaving
                  ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" />
                  : <Save className="w-3.5 h-3.5 mr-1" />}
                Salva
              </Button>
            )}

            <Button
              size="sm"
              onClick={() => setSaveDialogOpen(true)}
              disabled={saving || !result}
              className={savedId
                ? "bg-green-600/70 hover:bg-green-700 text-white"
                : "bg-orange-500 hover:bg-orange-600 text-white"
              }
            >
              {saving ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" />
              ) : savedId ? (
                <CheckCircle2 className="w-3.5 h-3.5 mr-1" />
              ) : (
                <Save className="w-3.5 h-3.5 mr-1" />
              )}
              {savedId ? "Salva come…" : "Salva con nome…"}
            </Button>
          </div>
        </div>
      </div>

      {/* ── Interactive Gantt workspace ── */}
      <div className="flex-1 overflow-hidden px-4 py-3">
        <div className="h-full flex flex-col">
          <div className="flex items-center gap-2 mb-1.5">
            <h3 className="text-xs font-semibold text-muted-foreground">
              Turni Macchina — Trascina o clicca una corsa per i suggerimenti · Doppio click sul nome per rinominare
            </h3>
            {result.solver && (
              <Badge variant="outline" className="text-[9px] border-orange-500/30 text-orange-400">
                {result.solver.toUpperCase()}
              </Badge>
            )}
          </div>

          <div className="flex-1 min-h-0">
            <InteractiveGantt
              rows={ganttRows}
              bars={ganttBars}
              onBarChange={handleBarChange}
              onRowRename={handleRowRename}
              getSuggestions={getSuggestions}
              onBarClick={handleBarClick}
              minHour={4}
              maxHour={26}
              snapMin={5}
              rowHeight={32}
              labelWidth={160}
              editable={true}
            />
          </div>
        </div>
      </div>

      {/* ── History panel (toggleable) ── */}
      <AnimatePresence>
        {historyPanelOpen && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="border-t border-border/20 px-4 py-2 bg-muted/10 overflow-hidden"
          >
            <div className="flex items-center justify-between mb-1.5">
              <div className="flex items-center gap-2">
                <History className="w-3.5 h-3.5 text-orange-400" />
                <span className="text-[11px] text-foreground font-semibold">
                  Cronologia azioni · {actionLog.length} eventi · posizione {historyIndex + 1}/{history.length}
                </span>
              </div>
              <button
                onClick={() => setHistoryPanelOpen(false)}
                className="text-[10px] text-muted-foreground hover:text-foreground"
              >
                Chiudi
              </button>
            </div>
            <div className="max-h-32 overflow-y-auto space-y-0.5 pr-2">
              {actionLog.length === 0 ? (
                <div className="text-[10px] text-muted-foreground/70 italic py-2 text-center">
                  Nessuna azione registrata. Trascina una corsa o rinomina un turno per iniziare.
                </div>
              ) : (
                [...actionLog].reverse().map((a, i) => {
                  const time = new Date(a.timestamp).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
                  // Trova frame corrispondente per "jump to"
                  const frameIdx = history.findIndex(h => h.action.id === a.id);
                  const isCurrent = frameIdx === historyIndex;
                  const kindColor: Record<ActionKind, string> = {
                    drag: "text-amber-400",
                    rename: "text-cyan-400",
                    load: "text-green-400",
                    reoptimize: "text-purple-400",
                    revert_baseline: "text-red-400",
                    reset: "text-red-500",
                    undo: "text-muted-foreground",
                    redo: "text-muted-foreground",
                    deadhead: "text-amber-300",
                  };
                  return (
                    <div
                      key={a.id}
                      className={`flex items-center gap-2 text-[10px] px-1.5 py-0.5 rounded ${isCurrent ? "bg-orange-500/10 border-l-2 border-orange-400" : "hover:bg-muted/30"}`}
                    >
                      <span className="font-mono text-muted-foreground/60 w-16 shrink-0">{time}</span>
                      <span className={`uppercase font-semibold w-16 shrink-0 ${kindColor[a.kind]}`}>{a.kind}</span>
                      <span className="text-foreground/90 flex-1 truncate" title={a.description}>{a.description}</span>
                      {a.detail && <span className="text-muted-foreground/70 text-[9px] truncate max-w-[140px]" title={a.detail}>{a.detail}</span>}
                      {frameIdx >= 0 && !isCurrent && (
                        <button
                          onClick={() => {
                            const target = history[frameIdx];
                            setResult(cloneResult(target.result));
                            setCustomLabels({ ...target.customLabels });
                            historyIndexRef.current = frameIdx;
                            setHistoryIndex(frameIdx);
                            toast.info("Tornato a questo punto", { description: a.description });
                          }}
                          className="text-[9px] text-orange-400 hover:underline shrink-0"
                          title="Torna a questo stato"
                        >
                          ↶ vai
                        </button>
                      )}
                      {isCurrent && (
                        <span className="text-[9px] text-orange-400 shrink-0">● ora</span>
                      )}
                      {i === 0 && actionLog.length > 1 && (
                        <span className="text-[9px] text-muted-foreground/40 shrink-0">↑ recente</span>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Quick modifications log (compact, sempre visibile quando ci sono modifiche) ── */}
      <AnimatePresence>
        {hasModifications && !historyPanelOpen && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="border-t border-border/20 px-4 py-1.5 bg-muted/10 overflow-hidden"
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[10px] text-amber-400 font-semibold">
                  ⬤ {modifications.length} modific{modifications.length === 1 ? "a" : "he"} · {actionLog.length} azion{actionLog.length === 1 ? "e" : "i"} totali
                </span>
                <button
                  onClick={() => setHistoryPanelOpen(true)}
                  className="text-[10px] text-orange-400 hover:underline"
                >
                  Vedi cronologia →
                </button>
              </div>
              <button
                onClick={() => setModifications([])}
                className="text-[10px] text-muted-foreground hover:text-foreground flex items-center gap-1"
              >
                <RotateCcw className="w-3 h-3" /> Pulisci log compatto
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Overlay ri-ottimizzazione in corso ── */}
      {reoptimizing && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center">
          <div className="bg-background border border-cyan-500/30 rounded-xl p-6 max-w-sm flex flex-col items-center gap-3 shadow-2xl">
            <Loader2 className="w-8 h-8 animate-spin text-cyan-400" />
            <div className="text-sm font-semibold text-foreground">Ri-ottimizzazione turni…</div>
            <p className="text-xs text-muted-foreground text-center">
              Sto spacchettando le corse dai turni macchina e rilanciando il solver CP-SAT
              con i nuovi orari intermodali.
            </p>
          </div>
        </div>
      )}

      {/* ── Dialog Diff turni v1 (baseline) vs v2 (post-Intermodale) ── */}
      <DiffDialog
        open={diffOpen}
        onClose={() => setDiffOpen(false)}
        diff={scheduleDiff}
        onRevert={baselineResult ? () => {
          setResult(baselineResult);
          pushHistory(baselineResult, "revert_baseline", "Ripristinato baseline pre-intermodale");
          setBaselineResult(null);
          setScheduleDiff(null);
          setDiffOpen(false);
          toast.success("Ripristinato scenario baseline");
        } : undefined}
      />

      {reoptimizeError && (
        <div className="fixed bottom-4 right-4 z-40 bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-2 text-xs text-red-400 max-w-sm">
          ⚠ {reoptimizeError}
        </div>
      )}

      {/* ── Dialog salvataggio scenario con nome ── */}
      <SaveScenarioDialog
        open={saveDialogOpen}
        onClose={() => setSaveDialogOpen(false)}
        defaultName={scenarioName}
        saving={saving}
        onConfirm={handleSave}
      />

      {/* ── Dialog caricamento scenario salvato ── */}
      <LoadScenarioDialog
        open={loadDialogOpen}
        onClose={() => setLoadDialogOpen(false)}
        onLoad={handleLoadScenario}
      />

      {/* ── Dialog gestione trasferimenti a vuoto ── */}
      <DeadheadEditorDialog
        open={deadheadDialogOpen}
        onOpenChange={(o) => { setDeadheadDialogOpen(o); if (!o) setDeadheadDialogFocus(null); }}
        result={result}
        customLabels={customLabels}
        onApply={handleDeadheadApply}
        depotMovementOverrides={depotMovementOverrides}
        onDepotMovementChange={handleDepotMovementChange}
        initialFocus={deadheadDialogFocus}
      />
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
 *  DiffDialog — confronto turni baseline ↔ post-Intermodale
 * ═══════════════════════════════════════════════════════════════ */

function DiffDialog({
  open, onClose, diff, onRevert,
}: {
  open: boolean;
  onClose: () => void;
  diff: ScheduleDiff | null;
  onRevert?: () => void;
}) {
  if (!open || !diff) return null;

  const dV = diff.vehiclesAfter - diff.vehiclesBefore;
  const dH = diff.serviceHoursAfter - diff.serviceHoursBefore;
  const dK = diff.deadheadKmAfter - diff.deadheadKmBefore;
  const dE = diff.efficiencyAfter - diff.efficiencyBefore;
  const dC = diff.costAfter - diff.costBefore;

  const fmtSign = (n: number, digits = 1) => `${n >= 0 ? "+" : ""}${n.toFixed(digits)}`;
  const colorOf = (n: number, betterIsLower = true) => {
    if (n === 0) return "text-muted-foreground";
    const isGood = betterIsLower ? n < 0 : n > 0;
    return isGood ? "text-green-400" : "text-red-400";
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-background border border-cyan-500/30 rounded-xl max-w-3xl w-full max-h-[88vh] overflow-hidden flex flex-col shadow-2xl">
        <div className="px-5 py-3 border-b border-border/30 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <BarChart3 className="w-5 h-5 text-cyan-400" />
            <div>
              <h3 className="text-sm font-display font-bold text-foreground">Confronto turni — Baseline vs Post-Intermodale</h3>
              <p className="text-[10px] text-muted-foreground">Risultato della ri-ottimizzazione CP-SAT con orari spostati per garantire le coincidenze</p>
            </div>
          </div>
          <Button size="sm" variant="ghost" onClick={onClose} className="text-xs h-7">Chiudi</Button>
        </div>

        <div className="flex-1 overflow-auto px-5 py-4 space-y-4">
          {/* ── KPI grid ── */}
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
            <DiffStat label="Veicoli" before={diff.vehiclesBefore} after={diff.vehiclesAfter} delta={dV} format={(n) => String(n)} color={colorOf(dV)} />
            <DiffStat label="Ore servizio" before={diff.serviceHoursBefore} after={diff.serviceHoursAfter} delta={dH} format={(n) => n.toFixed(1) + "h"} color={colorOf(dH)} />
            <DiffStat label="Km vuoto" before={diff.deadheadKmBefore} after={diff.deadheadKmAfter} delta={dK} format={(n) => n.toFixed(0) + " km"} color={colorOf(dK)} />
            <DiffStat label="Efficienza %" before={diff.efficiencyBefore} after={diff.efficiencyAfter} delta={dE} format={(n) => n.toFixed(1) + "%"} color={colorOf(dE, false)} />
            <DiffStat label="Costo totale" before={diff.costBefore} after={diff.costAfter} delta={dC} format={(n) => "€ " + n.toFixed(0)} color={colorOf(dC)} />
            <div className="bg-muted/20 rounded-lg p-3 border border-border/30">
              <div className="text-[10px] text-muted-foreground mb-0.5">Modifiche corse</div>
              <div className="text-sm font-mono">
                <span className="text-amber-400 font-bold">{diff.tripsTimeShifted}</span>
                <span className="text-muted-foreground text-[10px]"> orari</span>
                <span className="mx-1.5 text-muted-foreground/40">·</span>
                <span className="text-cyan-400 font-bold">{diff.tripsReassigned}</span>
                <span className="text-muted-foreground text-[10px]"> riassegnate</span>
              </div>
            </div>
          </div>

          {/* ── Banner sintesi ── */}
          <div className={`rounded-lg p-3 border text-xs ${dV > 0 || dC > 0
            ? "bg-amber-500/5 border-amber-500/30 text-amber-300"
            : "bg-green-500/5 border-green-500/30 text-green-300"}`}>
            {dV > 0 && (
              <div className="font-semibold mb-1">⚠ Servono {dV} veicol{dV === 1 ? "o" : "i"} in più per garantire le coincidenze.</div>
            )}
            {dV < 0 && (
              <div className="font-semibold mb-1">✓ Ottimizzazione virtuosa: {Math.abs(dV)} veicol{Math.abs(dV) === 1 ? "o" : "i"} risparmiat{Math.abs(dV) === 1 ? "o" : "i"}.</div>
            )}
            {dV === 0 && (
              <div className="font-semibold mb-1">✓ Stesso numero di veicoli — modifiche orarie assorbite dai turni esistenti.</div>
            )}
            <div className="text-[11px] opacity-80">
              Costo {fmtSign(dC, 0)} € · Ore servizio {fmtSign(dH)}h · Deadhead {fmtSign(dK, 0)} km · Efficienza {fmtSign(dE)}%
            </div>
          </div>

          {/* ── Esempi ── */}
          {diff.examples.length > 0 && (
            <div>
              <div className="text-[11px] font-semibold text-muted-foreground mb-1.5">Esempi di corse modificate</div>
              <div className="border border-border/30 rounded-lg overflow-hidden">
                <table className="w-full text-[11px]">
                  <thead className="bg-muted/30">
                    <tr className="text-left text-[10px] text-muted-foreground">
                      <th className="px-2 py-1.5">Corsa</th>
                      <th className="px-2 py-1.5">Linea</th>
                      <th className="px-2 py-1.5">Veicolo</th>
                      <th className="px-2 py-1.5 text-right">Orario</th>
                      <th className="px-2 py-1.5 text-right">Δ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {diff.examples.map((ex, i) => (
                      <tr key={i} className="border-t border-border/20 hover:bg-muted/10">
                        <td className="px-2 py-1 font-mono text-[10px] text-muted-foreground">{ex.tripId.slice(0, 18)}</td>
                        <td className="px-2 py-1 font-medium">{ex.routeName}</td>
                        <td className="px-2 py-1">
                          {ex.oldVehicle === ex.newVehicle ? (
                            <span className="text-muted-foreground/60">{ex.oldVehicle}</span>
                          ) : (
                            <span className="flex items-center gap-1">
                              <span className="text-muted-foreground line-through">{ex.oldVehicle}</span>
                              <ArrowRight className="w-3 h-3 text-cyan-400" />
                              <span className="text-cyan-300 font-medium">{ex.newVehicle}</span>
                            </span>
                          )}
                        </td>
                        <td className="px-2 py-1 font-mono text-right">
                          {ex.oldDep === ex.newDep ? (
                            <span className="text-muted-foreground/60">{ex.oldDep}</span>
                          ) : (
                            <span>
                              <span className="text-muted-foreground line-through">{ex.oldDep}</span>
                              {" → "}
                              <span className="text-amber-300 font-medium">{ex.newDep}</span>
                            </span>
                          )}
                        </td>
                        <td className={`px-2 py-1 text-right font-mono ${ex.deltaMin === 0 ? "text-muted-foreground/60" : ex.deltaMin > 0 ? "text-orange-400" : "text-cyan-400"}`}>
                          {ex.deltaMin === 0 ? "—" : `${ex.deltaMin > 0 ? "+" : ""}${ex.deltaMin}'`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-border/30 flex items-center justify-between gap-2">
          {onRevert && (
            <Button size="sm" variant="outline" onClick={onRevert} className="text-xs h-8">
              <RotateCcw className="w-3.5 h-3.5 mr-1" />
              Ripristina baseline
            </Button>
          )}
          <Button size="sm" onClick={onClose} className="text-xs h-8 ml-auto bg-cyan-600 hover:bg-cyan-700 text-white">
            Mantieni nuovi turni
          </Button>
        </div>
      </div>
    </div>
  );
}

function DiffStat({
  label, before, after, delta, format, color,
}: {
  label: string; before: number; after: number; delta: number;
  format: (n: number) => string; color: string;
}) {
  return (
    <div className="bg-muted/20 rounded-lg p-3 border border-border/30">
      <div className="text-[10px] text-muted-foreground mb-0.5">{label}</div>
      <div className="text-sm font-mono flex items-baseline gap-1.5">
        <span className="text-muted-foreground/60 text-[11px]">{format(before)}</span>
        <ArrowRight className="w-2.5 h-2.5 text-muted-foreground/40" />
        <span className="font-bold text-foreground">{format(after)}</span>
      </div>
      <div className={`text-[10px] font-mono mt-0.5 ${color}`}>
        {delta === 0 ? "— invariato" : `${delta > 0 ? "+" : ""}${typeof delta === "number" && Number.isInteger(delta) ? delta : delta.toFixed(1)}`}
      </div>
    </div>
  );
}
