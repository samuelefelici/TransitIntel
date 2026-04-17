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
  Flame, RotateCcw, Info,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import InteractiveGantt, {
  type GanttBar, type GanttRow, type GanttChange,
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

/* ═══════════════════════════════════════════════════════════════
 *  Conversion helpers — VehicleShift[] → GanttRow[] + GanttBar[]
 * ═══════════════════════════════════════════════════════════════ */

function shiftsToRows(shifts: VehicleShift[]): GanttRow[] {
  return shifts.map(s => ({
    id: s.vehicleId,
    label: s.vehicleId,
    sublabel: VEHICLE_SHORT[s.vehicleType] || s.vehicleType,
    dotColor: CATEGORY_COLORS[s.category] || "#6b7280",
  }));
}

function shiftsToBars(
  shifts: VehicleShift[],
  routeColorMap: Map<string, string>,
): GanttBar[] {
  const bars: GanttBar[] = [];

  for (const shift of shifts) {
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
        color = "rgba(255,255,255,0.05)";
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
        tooltip.push("Deposito");
      }

      bars.push({
        id,
        rowId: shift.vehicleId,
        startMin: entry.departureMin,
        endMin: entry.arrivalMin,
        label: entry.type === "trip" ? entry.routeName : entry.type === "deadhead" ? "↝" : "🏠",
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
 *  Modification tracker
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

/* ═══════════════════════════════════════════════════════════════
 *  Main component
 * ═══════════════════════════════════════════════════════════════ */

export default function VehicleWorkspace() {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<ServiceProgramResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [modifications, setModifications] = useState<TripReassignment[]>([]);
  const [scenarioName, setScenarioName] = useState("");
  const [savedId, setSavedId] = useState<number | null>(null);

  // Build Gantt data from optimization result
  const routeColorMap = useMemo(
    () => result ? buildRouteColorMap(result.shifts) : new Map<string, string>(),
    [result],
  );
  const ganttRows = useMemo(
    () => result ? shiftsToRows(result.shifts) : [],
    [result],
  );
  const ganttBars = useMemo(
    () => result ? shiftsToBars(result.shifts, routeColorMap) : [],
    [result, routeColorMap],
  );

  // Listen for optimization results dispatched by the existing optimizer-route page
  // (or load from API results)
  useEffect(() => {
    const handler = (e: CustomEvent<ServiceProgramResult>) => {
      setResult(e.detail);
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

  /* ── Handle bar change (drag & drop) ── */
  const handleBarChange = useCallback((change: GanttChange, _allBars: GanttBar[]) => {
    // Only track trip reassignments (not deadheads/depot)
    if (change.fromRowId !== change.toRowId || change.oldStartMin !== change.newStartMin) {
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
    }
  }, []);

  /* ── Save scenario ── */
  const handleSave = useCallback(async () => {
    if (!result) return;
    const name = scenarioName.trim() || `Scenario ${new Date().toLocaleString("it-IT")}`;
    setSaving(true);
    try {
      const base = getApiBase();
      const res = await fetch(`${base}/api/service-program/scenarios`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          date: result.summary?.date || new Date().toISOString().slice(0, 10).replace(/-/g, ""),
          input: { modifications },
          result,
        }),
      });
      if (!res.ok) throw new Error("Errore salvataggio");
      const data = await res.json();
      setSavedId(data.id);
      toast.success("Scenario salvato!", { description: `ID: ${data.id} — ${name}` });
    } catch (err: any) {
      toast.error("Errore salvataggio", { description: err.message });
    } finally {
      setSaving(false);
    }
  }, [result, scenarioName, modifications]);

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
          </div>

          <div className="flex items-center gap-2 text-[10px] text-muted-foreground/60 justify-center">
            <Info className="w-3 h-3" />
            <span>Oppure esegui un'ottimizzazione CP-SAT dal tab Turni Macchina</span>
          </div>
        </motion.div>
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

            <input
              type="text"
              placeholder="Nome scenario…"
              value={scenarioName}
              onChange={(e) => setScenarioName(e.target.value)}
              className="h-8 px-2 text-xs rounded-lg border border-border/30 bg-muted/20 text-foreground placeholder:text-muted-foreground/40 w-40 focus:outline-none focus:border-orange-500/50"
            />

            <Button
              size="sm"
              onClick={handleSave}
              disabled={saving || !result}
              className={savedId
                ? "bg-green-600 hover:bg-green-700 text-white"
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
              {savedId ? "Salvato" : "Salva Scenario"}
            </Button>
          </div>
        </div>
      </div>

      {/* ── Interactive Gantt workspace ── */}
      <div className="flex-1 overflow-hidden px-4 py-3">
        <div className="h-full flex flex-col">
          <div className="flex items-center gap-2 mb-1.5">
            <h3 className="text-xs font-semibold text-muted-foreground">
              Turni Macchina — Trascina le corse tra i veicoli
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

      {/* ── Modifications log ── */}
      <AnimatePresence>
        {hasModifications && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="border-t border-border/20 px-4 py-2 bg-muted/10 overflow-hidden"
          >
            <div className="flex items-center justify-between mb-1">
              <span className="text-[10px] text-muted-foreground font-semibold">
                Modifiche apportate
              </span>
              <button
                onClick={() => setModifications([])}
                className="text-[10px] text-muted-foreground hover:text-foreground flex items-center gap-1"
              >
                <RotateCcw className="w-3 h-3" /> Reset log
              </button>
            </div>
            <div className="flex flex-wrap gap-1.5 max-h-16 overflow-y-auto">
              {modifications.slice(-10).map((m, i) => (
                <div key={i} className="flex items-center gap-1 text-[9px] bg-muted/30 rounded px-2 py-0.5 border border-border/20">
                  <span className="font-mono text-primary">{m.tripId.slice(0, 12)}</span>
                  {m.fromVehicle !== m.toVehicle && (
                    <>
                      <span className="text-muted-foreground">{m.fromVehicle}</span>
                      <ArrowRight className="w-2.5 h-2.5 text-amber-400" />
                      <span className="text-amber-400 font-medium">{m.toVehicle}</span>
                    </>
                  )}
                </div>
              ))}
              {modifications.length > 10 && (
                <span className="text-[9px] text-muted-foreground/60">
                  +{modifications.length - 10} altre
                </span>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
