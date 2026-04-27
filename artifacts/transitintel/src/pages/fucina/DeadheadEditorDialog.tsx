/**
 * DeadheadEditorDialog
 * ----------------------------------------------------------------
 * Dialog per la gestione (CRUD) dei trasferimenti a vuoto (deadhead)
 * all'interno dei turni macchina.
 *
 * Funzionalità:
 *  - Browser di tutti i turni con elenco dei deadhead di ognuno
 *  - Inserimento di un nuovo trasferimento a vuoto tra due corsie
 *    (riempie un gap libero o sostituisce un deadhead/idle esistente)
 *  - Modifica (km, minuti, orari) di un deadhead
 *  - Eliminazione di un deadhead (il gap diventa idle/depot)
 *
 * Per ogni operazione il dialog calcola un nuovo `ServiceProgramResult`
 * coerente (ricalcola totalDeadheadKm/Min, depotReturns) e lo invia al
 * parent tramite `onApply`, che si occupa del push nella history.
 */
import React, { useMemo, useState, useCallback } from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Plus, Pencil, Trash2, ArrowRight, Truck, AlertTriangle, Save, X,
} from "lucide-react";
import { toast } from "sonner";
import type {
  VehicleShift, ShiftTripEntry, ServiceProgramResult,
} from "@/pages/optimizer-route/types";

/* ──────────────────────────────────────────────────────────── */
/*  Helpers                                                     */
/* ──────────────────────────────────────────────────────────── */

const minToHHMM = (m: number) => {
  if (!Number.isFinite(m)) return "—";
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
};
const minToTimeStr = (m: number) => `${minToHHMM(m)}:00`;
const hhmmToMin = (s: string): number | null => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  if (h < 0 || h > 47 || mm < 0 || mm > 59) return null;
  return h * 60 + mm;
};

function recomputeShiftTotals(shift: VehicleShift): VehicleShift {
  const trips = shift.trips;
  const tripEntries = trips.filter(t => t.type === "trip");
  const dhEntries = trips.filter(t => t.type === "deadhead");
  const depotEntries = trips.filter(t => t.type === "depot");
  const totalServiceMin = tripEntries.reduce(
    (s, t) => s + Math.max(0, t.arrivalMin - t.departureMin), 0,
  );
  const totalDeadheadMin = dhEntries.reduce(
    (s, t) => s + (t.deadheadMin ?? Math.max(0, t.arrivalMin - t.departureMin)), 0,
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

/** Inserisce/sostituisce un'entry deadhead riordinando per departureMin. */
function withDeadhead(
  shift: VehicleShift,
  newEntry: ShiftTripEntry,
  replaceIdx: number | null,
): VehicleShift {
  const next = [...shift.trips];
  if (replaceIdx !== null && replaceIdx >= 0 && replaceIdx < next.length) {
    next.splice(replaceIdx, 1);
  }
  let insertAt = next.findIndex(t => t.departureMin > newEntry.departureMin);
  if (insertAt < 0) insertAt = next.length;
  next.splice(insertAt, 0, newEntry);
  return recomputeShiftTotals({ ...shift, trips: next });
}

/** Elimina l'entry alla posizione indicata. */
function withoutEntry(shift: VehicleShift, idx: number): VehicleShift {
  const next = [...shift.trips];
  next.splice(idx, 1);
  return recomputeShiftTotals({ ...shift, trips: next });
}

interface FreeSlot {
  /** Min in cui il veicolo è libero (arrivo della corsia precedente) */
  startMin: number;
  endMin: number;
  prevTripIdx: number | null;       // -1 = inizio turno
  nextTripIdx: number | null;       // -1 = fine turno
  prevLabel: string;
  nextLabel: string;
}

/** Calcola gli slot liberi di un turno (gap >0min tra entry consecutive). */
function computeFreeSlots(shift: VehicleShift): FreeSlot[] {
  const slots: FreeSlot[] = [];
  const trips = shift.trips;
  for (let i = 0; i < trips.length - 1; i++) {
    const a = trips[i];
    const b = trips[i + 1];
    if (b.departureMin > a.arrivalMin) {
      slots.push({
        startMin: a.arrivalMin,
        endMin: b.departureMin,
        prevTripIdx: i,
        nextTripIdx: i + 1,
        prevLabel: a.type === "trip" ? a.routeName : a.type === "deadhead" ? "↝ vuoto" : "🏠 deposito",
        nextLabel: b.type === "trip" ? b.routeName : b.type === "deadhead" ? "↝ vuoto" : "🏠 deposito",
      });
    }
  }
  return slots;
}

/* ──────────────────────────────────────────────────────────── */
/*  Component                                                   */
/* ──────────────────────────────────────────────────────────── */

export type DeadheadOperation = "add" | "edit" | "delete";

export interface DeadheadChange {
  vehicleId: string;
  operation: DeadheadOperation;
  description: string;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  result: ServiceProgramResult | null;
  customLabels: Record<string, string>;
  onApply: (newResult: ServiceProgramResult, change: DeadheadChange) => void;
  /** Override durate movimenti deposito sintetici (default 10, 0 = nascosto). */
  depotMovementOverrides?: Record<string, { pullOutMin?: number; pullInMin?: number }>;
  /** Cambia la durata di pull-out/pull-in (0 = elimina la barra dal Gantt). */
  onDepotMovementChange?: (vehicleId: string, kind: "pullOut" | "pullIn", durationMin: number) => void;
  /** Apre il dialog focalizzato su un turno specifico (e opzionalmente su una entry). */
  initialFocus?: {
    vehicleId: string;
    /** Se valorizzato, apre la card di edit per quella entry. */
    entryDepartureMin?: number;
    /** Tipo della entry cliccata, per debug/scroll. */
    entryType?: "deadhead" | "depot" | "pullout" | "pullin" | "trip";
  } | null;
}

interface EditFormState {
  shiftIdx: number;
  entryIdx: number | null;     // null = nuovo deadhead in slot libero
  slotStart: number;
  slotEnd: number;
  departureMin: number;
  arrivalMin: number;
  km: number;
  routeIdFrom: string;
  routeIdTo: string;
  fromStop: string;
  toStop: string;
}

export default function DeadheadEditorDialog({
  open, onOpenChange, result, customLabels, onApply,
  depotMovementOverrides = {}, onDepotMovementChange, initialFocus,
}: Props) {
  const shifts = result?.shifts ?? [];
  const [selectedShiftIdx, setSelectedShiftIdx] = useState<number>(0);
  const [editForm, setEditForm] = useState<EditFormState | null>(null);

  // Reset selezione quando il dialog si apre / cambia result
  React.useEffect(() => {
    if (open) {
      // Se è stato richiesto un focus su un turno specifico (click su bar nel Gantt),
      // selezionalo e — se possibile — apri la card di edit.
      if (initialFocus) {
        const idx = shifts.findIndex(s => s.vehicleId === initialFocus.vehicleId);
        if (idx >= 0) {
          setSelectedShiftIdx(idx);
          const sh = shifts[idx];
          // Cerca la entry cliccata
          if (initialFocus.entryDepartureMin != null && initialFocus.entryType) {
            if (initialFocus.entryType === "deadhead" || initialFocus.entryType === "depot") {
              const entryIdx = sh.trips.findIndex(
                t => t.type === initialFocus.entryType && t.departureMin === initialFocus.entryDepartureMin,
              );
              if (entryIdx >= 0 && initialFocus.entryType === "deadhead") {
                // Pre-apre il form di edit
                const prev = sh.trips[entryIdx - 1];
                const next = sh.trips[entryIdx + 1];
                const entry = sh.trips[entryIdx];
                setEditForm({
                  shiftIdx: idx,
                  entryIdx,
                  slotStart: prev?.arrivalMin ?? entry.departureMin,
                  slotEnd: next?.departureMin ?? entry.arrivalMin,
                  departureMin: entry.departureMin,
                  arrivalMin: entry.arrivalMin,
                  km: entry.deadheadKm ?? 0,
                  routeIdFrom: prev && prev.type === "trip" ? prev.routeId : "",
                  routeIdTo: next && next.type === "trip" ? next.routeId : "",
                  fromStop: prev?.lastStopName ?? entry.firstStopName ?? "",
                  toStop: next?.firstStopName ?? entry.lastStopName ?? "",
                });
                return;
              }
            }
          }
          setEditForm(null);
          return;
        }
      }
      setSelectedShiftIdx(0);
      setEditForm(null);
    }
  }, [open, result, initialFocus]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectedShift = shifts[selectedShiftIdx];
  const freeSlots = useMemo(
    () => selectedShift ? computeFreeSlots(selectedShift) : [],
    [selectedShift],
  );
  const deadheadEntries = useMemo(() => {
    if (!selectedShift) return [];
    return selectedShift.trips
      .map((t, idx) => ({ entry: t, idx }))
      .filter(({ entry }) => entry.type === "deadhead" || entry.type === "depot");
  }, [selectedShift]);

  /* ────────── Operazioni ────────── */

  const apply = useCallback(
    (op: DeadheadOperation, vehicleId: string, description: string, mutator: (sh: VehicleShift) => VehicleShift) => {
      if (!result) return;
      const newShifts = result.shifts.map(s =>
        s.vehicleId === vehicleId ? mutator(s) : s,
      );
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
      onApply(newResult, { vehicleId, operation: op, description });
      toast.success(description);
    },
    [result, onApply],
  );

  const handleDelete = useCallback((shiftIdx: number, entryIdx: number) => {
    const shift = shifts[shiftIdx];
    if (!shift) return;
    const entry = shift.trips[entryIdx];
    if (!entry || (entry.type !== "deadhead" && entry.type !== "depot")) return;
    const label = customLabels[shift.vehicleId] ?? shift.vehicleId;
    const range = `${minToHHMM(entry.departureMin)}-${minToHHMM(entry.arrivalMin)}`;
    const desc = entry.type === "deadhead"
      ? `Eliminato vuoto ${entry.deadheadKm ?? 0}km su ${label} (${range})`
      : `Eliminato rientro deposito su ${label} (${range})`;
    apply("delete", shift.vehicleId, desc, sh => withoutEntry(sh, entryIdx));
  }, [shifts, customLabels, apply]);

  const openEditForm = useCallback((shiftIdx: number, entryIdx: number) => {
    const shift = shifts[shiftIdx];
    const entry = shift?.trips[entryIdx];
    // I rientri in deposito non sono modificabili (solo eliminabili): per
    // riposizionarli, l'utente li elimina e crea un nuovo deadhead nello slot.
    if (!entry || entry.type !== "deadhead") return;
    // slot allowable = gap intorno (entry precedente.arrivo → entry successiva.partenza)
    const prev = shift.trips[entryIdx - 1];
    const next = shift.trips[entryIdx + 1];
    setEditForm({
      shiftIdx,
      entryIdx,
      slotStart: prev?.arrivalMin ?? entry.departureMin,
      slotEnd: next?.departureMin ?? entry.arrivalMin,
      departureMin: entry.departureMin,
      arrivalMin: entry.arrivalMin,
      km: entry.deadheadKm ?? 0,
      routeIdFrom: prev && prev.type === "trip" ? prev.routeId : "",
      routeIdTo: next && next.type === "trip" ? next.routeId : "",
      fromStop: prev?.lastStopName ?? entry.firstStopName ?? "",
      toStop: next?.firstStopName ?? entry.lastStopName ?? "",
    });
  }, [shifts]);

  const openAddForm = useCallback((shiftIdx: number, slot: FreeSlot) => {
    const shift = shifts[shiftIdx];
    if (!shift) return;
    const prev = slot.prevTripIdx !== null ? shift.trips[slot.prevTripIdx] : null;
    const next = slot.nextTripIdx !== null ? shift.trips[slot.nextTripIdx] : null;
    setEditForm({
      shiftIdx,
      entryIdx: null,
      slotStart: slot.startMin,
      slotEnd: slot.endMin,
      departureMin: slot.startMin,
      arrivalMin: slot.endMin,
      km: 0,
      routeIdFrom: prev && prev.type === "trip" ? prev.routeId : "",
      routeIdTo: next && next.type === "trip" ? next.routeId : "",
      fromStop: prev?.lastStopName ?? "",
      toStop: next?.firstStopName ?? "",
    });
  }, [shifts]);

  const submitForm = useCallback(() => {
    if (!editForm || !result) return;
    const shift = shifts[editForm.shiftIdx];
    if (!shift) return;
    const { departureMin, arrivalMin, km, slotStart, slotEnd, entryIdx } = editForm;
    if (arrivalMin <= departureMin) {
      toast.error("Orario di arrivo deve essere successivo alla partenza");
      return;
    }
    if (departureMin < slotStart || arrivalMin > slotEnd) {
      toast.error(`Il vuoto deve stare nel gap ${minToHHMM(slotStart)}-${minToHHMM(slotEnd)}`);
      return;
    }
    if (km < 0) {
      toast.error("I km non possono essere negativi");
      return;
    }
    const newEntry: ShiftTripEntry = {
      type: "deadhead",
      tripId: `dh_${shift.vehicleId}_${departureMin}`,
      routeId: editForm.routeIdTo || editForm.routeIdFrom || "",
      routeName: "Trasferimento a vuoto",
      headsign: null,
      departureTime: minToTimeStr(departureMin),
      arrivalTime: minToTimeStr(arrivalMin),
      departureMin,
      arrivalMin,
      deadheadKm: km,
      deadheadMin: arrivalMin - departureMin,
      firstStopName: editForm.fromStop || undefined,
      lastStopName: editForm.toStop || undefined,
      durationMin: arrivalMin - departureMin,
    };
    const op: DeadheadOperation = entryIdx === null ? "add" : "edit";
    const verb = entryIdx === null ? "Aggiunto" : "Modificato";
    const desc = `${verb} vuoto ${km}km su ${customLabels[shift.vehicleId] ?? shift.vehicleId} (${minToHHMM(departureMin)}-${minToHHMM(arrivalMin)})`;
    apply(op, shift.vehicleId, desc, sh => withDeadhead(sh, newEntry, entryIdx));
    setEditForm(null);
  }, [editForm, result, shifts, customLabels, apply]);

  /* ────────── Render ────────── */

  if (!result) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Truck className="w-5 h-5 text-amber-500" />
            Gestione trasferimenti a vuoto
          </DialogTitle>
          <DialogDescription>
            Inserisci, modifica o elimina i trasferimenti a vuoto (deadhead) all'interno
            dei turni macchina. Ogni operazione viene tracciata nella cronologia.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-[260px_1fr] gap-3 flex-1 min-h-0">
          {/* ── Lista turni ── */}
          <div className="border border-border/40 rounded-lg flex flex-col min-h-0">
            <div className="px-3 py-2 border-b border-border/40 text-[11px] font-semibold text-muted-foreground bg-muted/20">
              Turni ({shifts.length})
            </div>
            <ScrollArea className="flex-1">
              <div className="p-1">
                {shifts.map((s, idx) => {
                  const dhCount = s.trips.filter(t => t.type === "deadhead").length;
                  const depotCount = s.trips.filter(t => t.type === "depot").length;
                  const sel = idx === selectedShiftIdx;
                  return (
                    <button
                      key={s.vehicleId}
                      onClick={() => { setSelectedShiftIdx(idx); setEditForm(null); }}
                      className={`w-full text-left px-2 py-1.5 rounded text-[11px] flex items-center justify-between gap-2 ${sel ? "bg-amber-500/15 text-amber-200 border border-amber-500/30" : "hover:bg-muted/30 text-muted-foreground"}`}
                    >
                      <div className="flex flex-col min-w-0">
                        <div className="font-mono font-semibold truncate">
                          {customLabels[s.vehicleId] ?? s.vehicleId}
                        </div>
                        <div className="text-[9px] opacity-70 truncate">
                          {s.tripCount} corsie · {s.totalDeadheadKm.toFixed(0)} km vuoto
                        </div>
                      </div>
                      <Badge variant="outline" className="text-[9px] px-1 py-0 h-4 whitespace-nowrap">
                        {dhCount}↝ {depotCount}🏠
                      </Badge>
                    </button>
                  );
                })}
              </div>
            </ScrollArea>
          </div>

          {/* ── Dettaglio turno ── */}
          <div className="border border-border/40 rounded-lg flex flex-col min-h-0">
            {selectedShift ? (
              <>
                <div className="px-3 py-2 border-b border-border/40 bg-muted/20 flex items-center justify-between">
                  <div className="text-[11px]">
                    <span className="font-semibold text-foreground">
                      {customLabels[selectedShift.vehicleId] ?? selectedShift.vehicleId}
                    </span>
                    <span className="text-muted-foreground ml-2">
                      {minToHHMM(selectedShift.startMin)}–{minToHHMM(selectedShift.endMin)} · {selectedShift.tripCount} corsie · {selectedShift.totalDeadheadKm.toFixed(0)} km vuoto
                    </span>
                  </div>
                </div>

                <ScrollArea className="flex-1">
                  <div className="p-3 space-y-4">
                    {/* Form di edit/add inline */}
                    {editForm && editForm.shiftIdx === selectedShiftIdx && (
                      <DeadheadFormCard
                        form={editForm}
                        onChange={setEditForm}
                        onCancel={() => setEditForm(null)}
                        onSubmit={submitForm}
                      />
                    )}

                    {/* ── Movimenti deposito sintetici (uscita / rientro finale) ── */}
                    {onDepotMovementChange && (
                      <DepotMovementsSection
                        shift={selectedShift}
                        override={depotMovementOverrides[selectedShift.vehicleId] ?? {}}
                        onChange={onDepotMovementChange}
                      />
                    )}

                    {/* Deadhead + rientri deposito esistenti */}
                    <section>
                      <h4 className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide mb-1.5 flex items-center gap-1.5">
                        <ArrowRight className="w-3 h-3" />
                        Trasferimenti a vuoto e rientri deposito ({deadheadEntries.length})
                      </h4>
                      {deadheadEntries.length === 0 ? (
                        <div className="text-[11px] text-muted-foreground italic px-2 py-3 bg-muted/10 rounded border border-dashed border-border/30">
                          Nessun trasferimento a vuoto né rientro deposito in questo turno.
                        </div>
                      ) : (
                        <div className="space-y-1">
                          {deadheadEntries.map(({ entry, idx }) => {
                            const isDepot = entry.type === "depot";
                            const dur = entry.arrivalMin - entry.departureMin;
                            return (
                              <div
                                key={idx}
                                className={`flex items-center gap-2 px-2 py-1.5 rounded border text-[11px] ${
                                  isDepot
                                    ? "border-orange-500/30 bg-orange-500/5"
                                    : "border-border/30 bg-muted/10"
                                }`}
                              >
                                <Badge
                                  className={`font-mono text-[10px] ${
                                    isDepot
                                      ? "bg-orange-500/20 text-orange-200 border-orange-500/40"
                                      : "bg-amber-500/20 text-amber-200 border-amber-500/40"
                                  }`}
                                >
                                  {minToHHMM(entry.departureMin)} → {minToHHMM(entry.arrivalMin)}
                                </Badge>
                                {isDepot ? (
                                  <span className="font-mono text-orange-300 flex items-center gap-1">
                                    🏠 Rientro deposito · {dur}′
                                  </span>
                                ) : (
                                  <span className="font-mono text-amber-300">
                                    ↝ {entry.deadheadKm ?? 0} km
                                  </span>
                                )}
                                <span className="text-muted-foreground truncate flex-1">
                                  {isDepot ? "(veicolo fermo)" : `${entry.firstStopName ?? "—"} → ${entry.lastStopName ?? "—"}`}
                                </span>
                                {!isDepot && (
                                  <button
                                    onClick={() => openEditForm(selectedShiftIdx, idx)}
                                    className="p-1 rounded hover:bg-blue-500/20 text-blue-400 hover:text-blue-300"
                                    title="Modifica"
                                  >
                                    <Pencil className="w-3 h-3" />
                                  </button>
                                )}
                                <button
                                  onClick={() => handleDelete(selectedShiftIdx, idx)}
                                  className="p-1 rounded hover:bg-red-500/20 text-red-400 hover:text-red-300"
                                  title={isDepot ? "Elimina rientro deposito" : "Elimina trasferimento a vuoto"}
                                >
                                  <Trash2 className="w-3 h-3" />
                                </button>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </section>

                    {/* Slot liberi → opzione di aggiungere */}
                    <section>
                      <h4 className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide mb-1.5 flex items-center gap-1.5">
                        <Plus className="w-3 h-3" />
                        Slot liberi ({freeSlots.length})
                      </h4>
                      {freeSlots.length === 0 ? (
                        <div className="text-[11px] text-muted-foreground italic px-2 py-3 bg-muted/10 rounded border border-dashed border-border/30">
                          Nessuno slot libero in cui inserire un nuovo trasferimento.
                        </div>
                      ) : (
                        <div className="space-y-1">
                          {freeSlots.map((slot, i) => {
                            const dur = slot.endMin - slot.startMin;
                            return (
                              <div key={i} className="flex items-center gap-2 px-2 py-1.5 rounded border border-border/30 bg-muted/5 text-[11px]">
                                <Badge variant="outline" className="font-mono text-[10px]">
                                  {minToHHMM(slot.startMin)}–{minToHHMM(slot.endMin)} ({dur}′)
                                </Badge>
                                <span className="text-muted-foreground truncate flex-1">
                                  Tra <span className="text-foreground/80">{slot.prevLabel}</span>
                                  {" "}e <span className="text-foreground/80">{slot.nextLabel}</span>
                                </span>
                                <button
                                  onClick={() => openAddForm(selectedShiftIdx, slot)}
                                  className="p-1 rounded hover:bg-emerald-500/20 text-emerald-400 hover:text-emerald-300 flex items-center gap-1 text-[10px]"
                                  title="Aggiungi trasferimento a vuoto in questo slot"
                                >
                                  <Plus className="w-3 h-3" /> Aggiungi
                                </button>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </section>

                    {/* Help */}
                    <div className="text-[10px] text-muted-foreground bg-muted/10 border border-border/30 rounded p-2 flex gap-1.5">
                      <AlertTriangle className="w-3 h-3 mt-0.5 text-amber-400 flex-shrink-0" />
                      <span>
                        I trasferimenti a vuoto contribuiscono ai km a vuoto totali e ai costi di esercizio.
                        Le modifiche sono tracciate nella cronologia: puoi sempre annullarle con ⌘Z.
                      </span>
                    </div>
                  </div>
                </ScrollArea>
              </>
            ) : (
              <div className="flex-1 flex items-center justify-center text-[12px] text-muted-foreground">
                Seleziona un turno per visualizzare i trasferimenti a vuoto.
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Chiudi</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ──────────────────────────────────────────────────────────── */
/*  Sotto-componente: form di edit/add                          */
/* ──────────────────────────────────────────────────────────── */

interface FormCardProps {
  form: EditFormState;
  onChange: (next: EditFormState) => void;
  onCancel: () => void;
  onSubmit: () => void;
}

function DeadheadFormCard({ form, onChange, onCancel, onSubmit }: FormCardProps) {
  const isAdd = form.entryIdx === null;
  const [depStr, setDepStr] = useState(minToHHMM(form.departureMin));
  const [arrStr, setArrStr] = useState(minToHHMM(form.arrivalMin));

  React.useEffect(() => {
    setDepStr(minToHHMM(form.departureMin));
    setArrStr(minToHHMM(form.arrivalMin));
  }, [form.departureMin, form.arrivalMin]);

  const handleDepBlur = () => {
    const v = hhmmToMin(depStr);
    if (v !== null) onChange({ ...form, departureMin: v });
    else setDepStr(minToHHMM(form.departureMin));
  };
  const handleArrBlur = () => {
    const v = hhmmToMin(arrStr);
    if (v !== null) onChange({ ...form, arrivalMin: v });
    else setArrStr(minToHHMM(form.arrivalMin));
  };

  return (
    <div className="border border-amber-500/40 bg-amber-500/5 rounded-lg p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-[11px] font-semibold text-amber-300 flex items-center gap-1.5">
          {isAdd ? <Plus className="w-3.5 h-3.5" /> : <Pencil className="w-3.5 h-3.5" />}
          {isAdd ? "Nuovo trasferimento a vuoto" : "Modifica trasferimento a vuoto"}
        </div>
        <button onClick={onCancel} className="p-1 rounded hover:bg-muted/40 text-muted-foreground">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
      <div className="text-[10px] text-muted-foreground">
        Slot disponibile: {minToHHMM(form.slotStart)} – {minToHHMM(form.slotEnd)} ({form.slotEnd - form.slotStart}′)
      </div>
      <div className="grid grid-cols-4 gap-2">
        <div>
          <Label className="text-[10px]">Partenza</Label>
          <Input
            value={depStr}
            onChange={e => setDepStr(e.target.value)}
            onBlur={handleDepBlur}
            placeholder="HH:MM"
            className="h-7 text-[11px] font-mono"
          />
        </div>
        <div>
          <Label className="text-[10px]">Arrivo</Label>
          <Input
            value={arrStr}
            onChange={e => setArrStr(e.target.value)}
            onBlur={handleArrBlur}
            placeholder="HH:MM"
            className="h-7 text-[11px] font-mono"
          />
        </div>
        <div>
          <Label className="text-[10px]">Km</Label>
          <Input
            type="number"
            min={0}
            step={0.1}
            value={form.km}
            onChange={e => onChange({ ...form, km: parseFloat(e.target.value) || 0 })}
            className="h-7 text-[11px] font-mono"
          />
        </div>
        <div>
          <Label className="text-[10px]">Durata calcolata</Label>
          <div className="h-7 px-2 flex items-center text-[11px] font-mono bg-muted/20 rounded border border-border/30">
            {Math.max(0, form.arrivalMin - form.departureMin)}′
          </div>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <Label className="text-[10px]">Da fermata</Label>
          <Input
            value={form.fromStop}
            onChange={e => onChange({ ...form, fromStop: e.target.value })}
            className="h-7 text-[11px]"
            placeholder="es. Capolinea Nord"
          />
        </div>
        <div>
          <Label className="text-[10px]">A fermata</Label>
          <Input
            value={form.toStop}
            onChange={e => onChange({ ...form, toStop: e.target.value })}
            className="h-7 text-[11px]"
            placeholder="es. Capolinea Sud"
          />
        </div>
      </div>
      <div className="flex gap-2 justify-end pt-1">
        <Button size="sm" variant="ghost" onClick={onCancel} className="h-7 text-[11px]">
          Annulla
        </Button>
        <Button
          size="sm"
          onClick={onSubmit}
          className="h-7 text-[11px] bg-amber-500 hover:bg-amber-600 text-black"
        >
          <Save className="w-3 h-3 mr-1" />
          {isAdd ? "Aggiungi" : "Salva modifica"}
        </Button>
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────── */
/*  Sotto-componente: movimenti deposito sintetici              */
/* ──────────────────────────────────────────────────────────── */

interface DepotMovementsProps {
  shift: VehicleShift;
  override: { pullOutMin?: number; pullInMin?: number };
  onChange: (vehicleId: string, kind: "pullOut" | "pullIn", durationMin: number) => void;
}

function DepotMovementsSection({ shift, override, onChange }: DepotMovementsProps) {
  const pullOut = override.pullOutMin ?? 10;
  const pullIn = override.pullInMin ?? 10;
  const firstTrip = shift.trips.find(t => t.type === "trip");
  const lastTrip = [...shift.trips].reverse().find(t => t.type === "trip");

  return (
    <section>
      <h4 className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide mb-1.5 flex items-center gap-1.5">
        <Truck className="w-3 h-3" />
        Movimenti deposito (uscita / rientro finale)
      </h4>
      <div className="space-y-1">
        <DepotMovementRow
          icon="🏁"
          label="Uscita dal deposito"
          targetStop={firstTrip?.firstStopName ?? "—"}
          dirText="verso"
          baseTimeStr={firstTrip ? minToHHMM(firstTrip.departureMin) : "—"}
          colorClass="border-green-500/40 bg-green-500/5 text-green-300"
          durationMin={pullOut}
          onSet={d => onChange(shift.vehicleId, "pullOut", d)}
          deleted={pullOut === 0}
        />
        <DepotMovementRow
          icon="🏠"
          label="Rientro finale al deposito"
          targetStop={lastTrip?.lastStopName ?? "—"}
          dirText="da"
          baseTimeStr={lastTrip ? minToHHMM(lastTrip.arrivalMin) : "—"}
          colorClass="border-cyan-500/40 bg-cyan-500/5 text-cyan-300"
          durationMin={pullIn}
          onSet={d => onChange(shift.vehicleId, "pullIn", d)}
          deleted={pullIn === 0}
        />
      </div>
    </section>
  );
}

interface DepotRowProps {
  icon: string;
  label: string;
  targetStop: string;
  dirText: string;
  baseTimeStr: string;
  colorClass: string;
  durationMin: number;
  deleted: boolean;
  onSet: (durationMin: number) => void;
}

function DepotMovementRow({
  icon, label, targetStop, dirText, baseTimeStr, colorClass, durationMin, deleted, onSet,
}: DepotRowProps) {
  const [val, setVal] = useState(String(durationMin));
  React.useEffect(() => { setVal(String(durationMin)); }, [durationMin]);

  const commit = () => {
    const n = parseInt(val, 10);
    if (Number.isFinite(n) && n >= 0 && n <= 240) onSet(n);
    else setVal(String(durationMin));
  };

  return (
    <div className={`flex items-center gap-2 px-2 py-1.5 rounded border text-[11px] ${deleted ? "border-dashed border-red-500/30 bg-red-500/5 opacity-70" : colorClass}`}>
      <span className="text-base leading-none">{icon}</span>
      <div className="flex flex-col min-w-0 flex-1">
        <div className="font-semibold truncate">
          {label}
          {deleted && <span className="ml-2 text-[9px] uppercase text-red-400">eliminato</span>}
        </div>
        <div className="text-[9px] text-muted-foreground truncate">
          {dirText} <span className="text-foreground/80">{targetStop}</span> · base {baseTimeStr}
        </div>
      </div>
      <div className="flex items-center gap-1">
        <Input
          type="number"
          min={0}
          max={240}
          step={1}
          value={val}
          onChange={e => setVal(e.target.value)}
          onBlur={commit}
          onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
          className="h-6 w-14 text-[11px] font-mono px-1 text-right"
          title="Durata in minuti (0 = eliminato)"
        />
        <span className="text-[9px] text-muted-foreground">min</span>
      </div>
      <button
        onClick={() => onSet(deleted ? 10 : 0)}
        className={`p-1 rounded ${deleted ? "hover:bg-emerald-500/20 text-emerald-400" : "hover:bg-red-500/20 text-red-400"}`}
        title={deleted ? "Ripristina (10 min)" : "Elimina (durata 0)"}
      >
        {deleted ? <Plus className="w-3 h-3" /> : <Trash2 className="w-3 h-3" />}
      </button>
    </div>
  );
}
