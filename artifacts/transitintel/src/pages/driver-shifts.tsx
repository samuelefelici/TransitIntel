import React, { useState, useEffect, useMemo, useCallback } from "react";
import { useParams, useSearch } from "wouter";
import { motion, AnimatePresence } from "framer-motion";
import {
  Loader2, Users, Clock, ChevronDown, ChevronUp,
  Calendar, Bus, Timer, BarChart3, AlertTriangle, TrendingUp,
  ArrowLeft, Coffee, Zap, Shield, Repeat, Car, Settings, Play,
  DollarSign, Save, FileCheck, Lock, Building2, Grip, CheckCircle2, Trash2,
  Award, Trophy, Flame, ListOrdered, Sparkles, Target, Gauge, Brain,
  Lightbulb, Activity, Wand2, Layers, Undo2, Redo2,
  Printer, FileSpreadsheet, FileText, Download,
} from "lucide-react";
import { toast } from "sonner";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip as ReTooltip, ResponsiveContainer,
  CartesianGrid, Cell,
} from "recharts";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { getApiBase } from "@/lib/api";
import { useCrewOptimization, type OperatorConfig } from "@/hooks/use-crew-optimization";
import { OptimizationProgressPanel } from "@/components/OptimizationProgress";
import { OperatorConfigPanel } from "@/components/OperatorConfigPanel";
import { ExportReportButton } from "@/components/SchedulingReportExport";

import type {
  DriverShiftType, DriverShiftData, DriverShiftsResult, ScenarioResult,
  OptimizationAnalysis,
} from "./driver-shifts/types";
import {
  TYPE_LABELS, TYPE_COLORS, TYPE_DESC,
  ymdToDisplay, minToTime, formatDuration,
} from "./driver-shifts/constants";
import {
  DriverShiftsErrorBoundary, SummaryCard,
} from "./driver-shifts/components";
import {
  driverShiftsToTripBars,
  applyDriverTripChange,
  suggestDriversForTrip,
} from "./driver-shifts/gantt-adapters";
import {
  exportDriverShiftsToPrint,
  exportDriverShiftsToCsv,
  triggerDownload,
} from "./fucina/DriverShiftsPrintExport";
import InteractiveGantt, { type GanttBar, type GanttRow, type GanttChange } from "@/components/InteractiveGantt";

/* ═══════════════════════════════════════════════════════════════
 *  PAGE COMPONENT
 * ═══════════════════════════════════════════════════════════════ */

export default function DriverShiftsPage() {
  return (
    <DriverShiftsErrorBoundary>
      <DriverShiftsPageInner />
    </DriverShiftsErrorBoundary>
  );
}

function DriverShiftsPageInner() {
  const params = useParams<{ scenarioId: string }>();
  const scenarioId = params.scenarioId;
  const search = useSearch();
  const dssIdFromUrl = useMemo(() => new URLSearchParams(search).get("dss"), [search]);

  const [result, setResult] = useState<DriverShiftsResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedShifts, setExpandedShifts] = useState<Set<string>>(new Set());
  const [typeFilter, setTypeFilter] = useState<DriverShiftType | "all">("all");

  // ── Area di Lavoro: vista Gantt + history undo/redo ──
  const [ganttMode, setGanttMode] = useState<"exploded" | "aggregated">("exploded");
  const [history, setHistory] = useState<DriverShiftsResult[]>([]);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const [modifiedCount, setModifiedCount] = useState(0);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);

  // ── Solver mode ──
  const [solverMode, setSolverMode] = useState<"greedy" | "cpsat">("cpsat");
  const [solverMetrics, setSolverMetrics] = useState<any>(null);

  // ── Operator config panel ──
  const [configOpen, setConfigOpen] = useState(false);
  const [operatorConfig, setOperatorConfig] = useState<OperatorConfig>({
    solverIntensity: 2,
    maxRounds: 5,
    weights: {
      minDrivers: 8, workBalance: 6, minCambi: 5,
      preferIntero: 7, minSupplementi: 4, qualityTarget: 5,
    },
  });

  // ── Setup wizard state ──
  const [normativa, setNormativa] = useState<"urbano" | "extraurbano">("urbano");
  const [clustersInfo, setClustersInfo] = useState<{ id: string; name: string; color?: string; transferFromDepotMin?: number }[]>([]);
  const [depotsInfo, setDepotsInfo] = useState<{ id: string; name: string }[]>([]);
  const [setupOpen, setSetupOpen] = useState(true);
  const [selectedClusterIds, setSelectedClusterIds] = useState<Set<string>>(new Set());
  const [clustersTouched, setClustersTouched] = useState(false); // true dopo prima interazione utente
  const [companyCars, setCompanyCars] = useState<number>(5);

  // ── Saved driver-shift scenarios ──
  interface SavedDss { id: string; name: string; createdAt: string; summary: any; }
  const [savedDss, setSavedDss] = useState<SavedDss[]>([]);
  const [loadedDssId, setLoadedDssId] = useState<string | null>(null);
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [dssName, setDssName] = useState("");
  const [savingDss, setSavingDss] = useState(false);
  const [confirmDelDss, setConfirmDelDss] = useState<string | null>(null);

  // ── Vehicle scheduling scenario (per il report intermodale) ──
  const [vehicleScenario, setVehicleScenario] = useState<any | null>(null);
  useEffect(() => {
    if (!scenarioId) return;
    fetch(`${getApiBase()}/api/service-program/scenarios/${scenarioId}`)
      .then(r => r.ok ? r.json() : null)
      .then(row => { if (row) setVehicleScenario(row); })
      .catch(() => {});
  }, [scenarioId]);

  // Load clusters + depots + saved DSS list once
  useEffect(() => {
    const base = getApiBase();
    fetch(`${base}/api/clusters`).then(r => r.ok ? r.json() : null).then(d => {
      const arr = Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : [];
      setClustersInfo(arr);
      // Di default: tutti i cluster selezionati finché l'utente non interagisce
      setSelectedClusterIds(prev => {
        if (clustersTouched) return prev;
        return new Set(arr.map((c: any) => c.id));
      });
    }).catch(() => {});
    fetch(`${base}/api/depots`).then(r => r.ok ? r.json() : null).then(d => {
      const arr = Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : [];
      setDepotsInfo(arr);
    }).catch(() => {});
    fetch(`${base}/api/settings/company-cars`).then(r => r.ok ? r.json() : null).then(d => {
      if (d && typeof d.companyCars === "number") setCompanyCars(d.companyCars);
    }).catch(() => {});
  }, [clustersTouched]);

  const toggleCluster = useCallback((id: string) => {
    setClustersTouched(true);
    setSelectedClusterIds(prev => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }, []);

  const selectAllClusters = useCallback(() => {
    setClustersTouched(true);
    setSelectedClusterIds(new Set(clustersInfo.map(c => c.id)));
  }, [clustersInfo]);

  const deselectAllClusters = useCallback(() => {
    setClustersTouched(true);
    setSelectedClusterIds(new Set());
  }, []);

  const refetchSavedDss = useCallback(() => {
    if (!scenarioId) return;
    fetch(`${getApiBase()}/api/driver-shifts/${scenarioId}/scenarios`)
      .then(r => r.ok ? r.json() : [])
      .then(d => setSavedDss(Array.isArray(d) ? d : []))
      .catch(() => {});
  }, [scenarioId]);
  useEffect(() => { refetchSavedDss(); }, [refetchSavedDss]);

  // Auto-load a saved DSS if ?dss= is in the URL
  useEffect(() => {
    if (!scenarioId || !dssIdFromUrl) return;
    if (loadedDssId === dssIdFromUrl) return;
    setLoading(true); setError(null);
    fetch(`${getApiBase()}/api/driver-shifts/${scenarioId}/scenarios/${dssIdFromUrl}`)
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((row) => {
        const stored = row?.result;
        if (stored) {
          setResult(stored);
          setSolverMetrics(stored.solverMetrics ?? null);
          setLoadedDssId(dssIdFromUrl);
          if (row?.config) setOperatorConfig(prev => ({ ...prev, ...row.config }));
          setSetupOpen(false);
        }
      })
      .catch(e => setError(`Impossibile caricare lo scenario salvato: ${e.message}`))
      .finally(() => setLoading(false));
  }, [scenarioId, dssIdFromUrl, loadedDssId]);

  // Save current result as a new driver-shift scenario
  const saveDss = useCallback(async () => {
    if (!scenarioId || !result || !dssName.trim()) return;
    setSavingDss(true);
    try {
      const resp = await fetch(`${getApiBase()}/api/driver-shifts/${scenarioId}/scenarios`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: dssName.trim(),
          result,
          config: { ...operatorConfig, normativa, solverMode },
        }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const row = await resp.json();
      setLoadedDssId(row.id);
      setShowSaveDialog(false);
      setDssName("");
      refetchSavedDss();
    } catch (e: any) {
      setError(`Errore salvataggio turni guida: ${e.message}`);
    } finally {
      setSavingDss(false);
    }
  }, [scenarioId, result, dssName, operatorConfig, normativa, solverMode, refetchSavedDss]);

  const deleteDss = useCallback(async (id: string) => {
    if (!scenarioId) return;
    if (confirmDelDss !== id) {
      setConfirmDelDss(id);
      setTimeout(() => setConfirmDelDss(prev => (prev === id ? null : prev)), 3000);
      return;
    }
    try {
      await fetch(`${getApiBase()}/api/driver-shifts/${scenarioId}/scenarios/${id}`, { method: "DELETE" });
      setSavedDss(prev => prev.filter(s => s.id !== id));
      if (loadedDssId === id) setLoadedDssId(null);
    } catch { /* ignore */ }
    setConfirmDelDss(null);
  }, [scenarioId, confirmDelDss, loadedDssId]);

  // ── Async CP-SAT optimization hook ──
  const cpsat = useCrewOptimization();

  // NOTE: Non si auto-lanciano i turni guida. L'utente deve cliccare esplicitamente.

  // When CP-SAT completes, merge result into page state
  useEffect(() => {
    if (cpsat.state === "completed" && cpsat.result) {
      setResult(cpsat.result as any);
      setSolverMetrics(cpsat.result.solverMetrics || null);
      setLoading(false);
      setError(null);
      setHistory([]); setHistoryIdx(-1); setModifiedCount(0);
    } else if (cpsat.state === "failed") {
      setError(cpsat.error || "Errore ottimizzazione CP-SAT");
      setLoading(false);
    }
  }, [cpsat.state, cpsat.result, cpsat.error]);

  // Launch Greedy optimization (explicit user action)
  const launchGreedy = useCallback(() => {
    if (!scenarioId) return;
    setLoading(true); setError(null); setSolverMetrics(null); setResult(null);
    const endpoint = `${getApiBase()}/api/driver-shifts/${scenarioId}`;
    fetch(endpoint)
      .then(r => { if (!r.ok) throw new Error(`Errore ${r.status}`); return r.json(); })
      .then(data => { setResult(data); setHistory([]); setHistoryIdx(-1); setModifiedCount(0); })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [scenarioId]);

  // Launch CP-SAT optimization
  const launchCPSAT = useCallback(() => {
    if (!scenarioId) return;
    cpsat.reset();
    setResult(null);
    setLoading(false);
    setError(null);
    setSolverMetrics(null);

    // Tempi più estesi: il solver Maior-style esplora portfolio multi-strategia
    const timeLimit = operatorConfig.solverIntensity === 1 ? 90 :
                      operatorConfig.solverIntensity === 3 ? 480 :
                      operatorConfig.solverIntensity === 4 ? 900 : 240;
    const configWithScope: OperatorConfig = {
      ...operatorConfig,
      selectedClusterIds: Array.from(selectedClusterIds),
      companyCars,
      // HARD: l'utente ha indicato N autovetture per i cambi → propaga come
      // cap inviolabile a bds.optimizer.maxCompanyCars (override esplicito).
      bds: {
        ...(operatorConfig.bds ?? {}),
        optimizer: {
          ...(operatorConfig.bds?.optimizer ?? {}),
          maxCompanyCars: companyCars,
        },
      },
    };
    cpsat.start(scenarioId, timeLimit, configWithScope);
  }, [scenarioId, cpsat, operatorConfig, selectedClusterIds, companyCars]);

  // When switching mode, don't auto-launch; user must click explicitly
  const switchMode = useCallback((mode: "greedy" | "cpsat") => {
    setSolverMode(mode);
    if (mode === "greedy") {
      cpsat.reset();
    }
  }, [cpsat]);

  const filteredShifts = useMemo(() => {
    if (!result) return [];
    if (typeFilter === "all") return result.driverShifts;
    return result.driverShifts.filter(s => s.type === typeFilter);
  }, [result, typeFilter]);

  // ── InteractiveGantt adapters for driver shifts ──
  const driverGanttRows = useMemo<GanttRow[]>(() =>
    filteredShifts.map(s => ({
      id: s.driverId,
      label: s.driverId,
      sublabel: TYPE_LABELS[s.type]?.slice(0, 3),
      dotColor: TYPE_COLORS[s.type],
    })),
    [filteredShifts],
  );

  const driverGanttMinHour = useMemo(() => {
    if (filteredShifts.length === 0) return 4;
    return Math.max(3, Math.floor(Math.min(...filteredShifts.map(s => s.nastroStartMin)) / 60) - 1);
  }, [filteredShifts]);

  const driverGanttMaxHour = useMemo(() => {
    if (filteredShifts.length === 0) return 25;
    return Math.min(27, Math.ceil(Math.max(...filteredShifts.map(s => s.nastroEndMin)) / 60) + 1);
  }, [filteredShifts]);

  const driverGanttBars = useMemo<GanttBar[]>(() => {
    // Vista ESPLOSA → 1 bar per corsa (drag-and-drop friendly), riusa adapter centralizzato
    if (ganttMode === "exploded") {
      return driverShiftsToTripBars(filteredShifts);
    }
    // Vista AGGREGATA → 1 bar "N corse" per ripresa (read-only)
    const out: GanttBar[] = [];
    for (const shift of filteredShifts) {
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
  }, [filteredShifts, ganttMode]);

  /* ── History push/undo/redo ───────────────────────── */
  const pushHistory = useCallback((newRes: DriverShiftsResult) => {
    setHistory(prev => {
      const truncated = historyIdx >= 0 ? prev.slice(0, historyIdx + 1) : prev;
      const next = [...truncated, newRes].slice(-30);
      setHistoryIdx(next.length - 1);
      return next;
    });
    setModifiedCount(c => c + 1);
  }, [historyIdx]);

  const handleDriverGanttChange = useCallback((change: GanttChange, _allBars: GanttBar[]) => {
    if (!result) return;
    // Applica solo a bar di tipo "trip" (vista esplosa)
    const bar = driverGanttBars.find(b => b.id === change.barId);
    if (!bar || bar.meta?.type !== "trip") return;
    if (change.fromRowId === change.toRowId && change.oldStartMin === change.newStartMin) return;
    const tripId: string | undefined = bar.meta?.tripId;
    if (!tripId) return;

    const { shifts: newShifts, movedTrip, warning } = applyDriverTripChange(
      result.driverShifts,
      {
        tripId,
        fromDriverId: change.fromRowId,
        toDriverId: change.toRowId,
        newStartMin: change.newStartMin,
        newEndMin: change.newEndMin,
      },
    );
    if (warning) { toast.warning(warning); return; }

    const reassigned = change.fromRowId !== change.toRowId;
    const shifted = change.newStartMin !== change.oldStartMin;
    const delta = change.newStartMin - change.oldStartMin;
    const desc = reassigned && shifted
      ? `${movedTrip?.routeName} ${change.fromRowId}→${change.toRowId} (${delta > 0 ? "+" : ""}${delta}′)`
      : reassigned
        ? `${movedTrip?.routeName} ${change.fromRowId}→${change.toRowId}`
        : `${movedTrip?.routeName} ${delta > 0 ? "+" : ""}${delta}′`;

    const newResult: DriverShiftsResult = { ...result, driverShifts: newShifts };
    setResult(newResult);
    pushHistory(newResult);
    toast.success("Corsa spostata", { description: desc });
  }, [result, driverGanttBars, pushHistory]);

  const canUndo = historyIdx > 0;
  const canRedo = historyIdx >= 0 && historyIdx < history.length - 1;

  const handleUndo = useCallback(() => {
    if (!canUndo) return;
    const newIdx = historyIdx - 1;
    setHistoryIdx(newIdx);
    setResult(history[newIdx]);
    toast.info("Annullato");
  }, [canUndo, historyIdx, history]);

  const handleRedo = useCallback(() => {
    if (!canRedo) return;
    const newIdx = historyIdx + 1;
    setHistoryIdx(newIdx);
    setResult(history[newIdx]);
    toast.info("Ripristinato");
  }, [canRedo, historyIdx, history]);

  // Cmd/Ctrl+Z = undo, +Shift = redo
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || target?.isContentEditable) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) handleRedo();
        else handleUndo();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleUndo, handleRedo]);

  /* ── Export handlers (stampa A4 / CSV / JSON) ──────── */
  const handleExportPrint = useCallback(() => {
    if (!result) return;
    setExportMenuOpen(false);
    exportDriverShiftsToPrint(result, {
      scenarioName: result.scenarioName,
      columnsPerPage: 2,
      orientation: "landscape",
    });
    toast.success("Stampa A4 generata", { description: "Si è aperta la finestra di stampa" });
  }, [result]);

  const handleExportCsv = useCallback(() => {
    if (!result) return;
    setExportMenuOpen(false);
    const csv = exportDriverShiftsToCsv(result);
    const fname = `turni-guida-${result.date || "export"}-${Date.now()}.csv`;
    triggerDownload(csv, fname, "text/csv;charset=utf-8");
    toast.success("CSV scaricato", { description: fname });
  }, [result]);

  const handleExportJson = useCallback(() => {
    if (!result) return;
    setExportMenuOpen(false);
    const json = JSON.stringify(result, null, 2);
    const fname = `turni-guida-${result.date || "export"}-${Date.now()}.json`;
    triggerDownload(json, fname, "application/json");
    toast.success("JSON scaricato", { description: fname });
  }, [result]);

  const typeDistData = useMemo(() => {
    if (!result) return [];
    return (Object.entries(result.summary.byType) as [DriverShiftType, number][])
      .filter(([, count]) => count > 0)
      .map(([type, count]) => ({
        name: TYPE_LABELS[type],
        count,
        color: TYPE_COLORS[type],
      }));
  }, [result]);

  const workDistData = useMemo(() => {
    if (!result) return [];
    const buckets: Record<string, number> = {};
    for (const ds of result.driverShifts) {
      const h = Math.floor(ds.workMin / 60);
      const label = `${h}h`;
      buckets[label] = (buckets[label] || 0) + 1;
    }
    return Object.entries(buckets)
      .sort(([a], [b]) => parseInt(a) - parseInt(b))
      .map(([label, count]) => ({ label, count }));
  }, [result]);

  const toggleShift = (id: string) => {
    setExpandedShifts(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  };

  // Full-page loading spinner (generic for any solver)
  if (loading) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <Loader2 className="w-8 h-8 animate-spin text-orange-400" />
      </div>
    );
  }

  // Full-page error (only when no result to show and not running)
  if (error && cpsat.state !== "running" && cpsat.state !== "starting" && !result) {
    return (
      <div className="max-w-3xl mx-auto p-6">
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-4 text-sm text-red-400">
          <AlertTriangle className="w-4 h-4 inline mr-2" />{error}
        </div>
        <a href="/fucina" className="flex items-center gap-2 text-sm text-orange-400 mt-4 hover:underline">
          <ArrowLeft className="w-4 h-4" /> Torna ai Turni Macchina
        </a>
      </div>
    );
  }

  return (
    <div className="h-[calc(100vh-3.5rem)] md:h-screen overflow-y-auto">
      <div className="max-w-7xl mx-auto p-4 md:p-6 space-y-6">

        {/* Header — sticky, coerente palette fuoco */}
        <div className="flex items-center justify-between flex-wrap gap-3 pb-3 border-b border-orange-500/15">
          <div className="min-w-0">
            <a href="/fucina" className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-orange-400 transition-colors mb-1">
              <ArrowLeft className="w-3 h-3" /> Turni Macchina
            </a>
            <h1 className="text-xl font-bold flex items-center gap-2">
              <div className="relative">
                <Users className="w-5 h-5 text-orange-400" />
                <div className="absolute inset-0 blur-sm bg-orange-400/20 rounded pointer-events-none" />
              </div>
              <span className="bg-gradient-to-r from-orange-400 to-amber-400 bg-clip-text text-transparent">
                Turni Guida — Urbano
              </span>
            </h1>
            {result && (
              <p className="text-[11px] text-muted-foreground mt-1 truncate">
                <strong className="text-foreground">{result.scenarioName}</strong>
                <span className="mx-1.5 text-muted-foreground/40">·</span>
                {ymdToDisplay(result.date)}
                {loadedDssId && (
                  <Badge variant="outline" className="ml-2 text-[9px] border-amber-500/40 text-amber-400 py-0">
                    <CheckCircle2 className="w-2.5 h-2.5 mr-1" /> variante caricata
                  </Badge>
                )}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            {/* Esporta Report — solo se c'è risultato */}
            {result && (
              <ExportReportButton
                result={result}
                config={operatorConfig}
                solverMode={solverMode}
                scenarioName={result.scenarioName}
                date={result.date}
                vehicleScenario={vehicleScenario}
              />
            )}
            {/* Esporta Turni Guida (Stampa A4 / CSV / JSON) */}
            {result && (
              <div className="relative">
                <button
                  onClick={() => setExportMenuOpen(v => !v)}
                  onBlur={() => setTimeout(() => setExportMenuOpen(false), 150)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-blue-500/40 text-blue-300 bg-blue-500/10 hover:bg-blue-500/20 transition-colors"
                  title="Stampa o esporta i turni guida"
                >
                  <Download className="w-3.5 h-3.5" /> Esporta turni
                  <ChevronDown className={`w-3 h-3 transition-transform ${exportMenuOpen ? "rotate-180" : ""}`} />
                </button>
                {exportMenuOpen && (
                  <div className="absolute right-0 top-full mt-1 z-30 bg-zinc-900 border border-blue-500/30 rounded-lg shadow-xl py-1 min-w-[220px]">
                    <button
                      onMouseDown={handleExportPrint}
                      className="w-full text-left px-3 py-2 text-[11px] text-blue-200 hover:bg-blue-500/15 flex items-center gap-2 transition"
                    >
                      <Printer className="w-3.5 h-3.5" />
                      <div>
                        <div className="font-medium">Stampa A4 dettagliata</div>
                        <div className="text-[10px] text-blue-300/50">turni · corse · BDS · KPI</div>
                      </div>
                    </button>
                    <button
                      onMouseDown={handleExportCsv}
                      className="w-full text-left px-3 py-2 text-[11px] text-blue-200 hover:bg-blue-500/15 flex items-center gap-2 transition"
                    >
                      <FileSpreadsheet className="w-3.5 h-3.5" />
                      <div>
                        <div className="font-medium">CSV (1 riga = 1 corsa)</div>
                        <div className="text-[10px] text-blue-300/50">apri in Excel/Numbers</div>
                      </div>
                    </button>
                    <button
                      onMouseDown={handleExportJson}
                      className="w-full text-left px-3 py-2 text-[11px] text-blue-200 hover:bg-blue-500/15 flex items-center gap-2 transition"
                    >
                      <FileText className="w-3.5 h-3.5" />
                      <div>
                        <div className="font-medium">JSON completo</div>
                        <div className="text-[10px] text-blue-300/50">struttura dati grezza</div>
                      </div>
                    </button>
                  </div>
                )}
              </div>
            )}
            {/* Salva — solo se c'è risultato */}
            {result && (
              <button
                onClick={() => { setDssName(`Turni guida ${new Date().toLocaleString("it-IT", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}`); setShowSaveDialog(true); }}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-amber-600/90 text-white hover:bg-amber-600 transition-colors"
                title={loadedDssId ? "Salva come nuovo scenario" : "Salva turni guida"}
              >
                <Save className="w-3.5 h-3.5" /> {loadedDssId ? "Salva come nuovo" : "Salva"}
              </button>
            )}
            {solverMetrics && (
              <Badge variant="outline" className="text-[10px] border-orange-500/30 text-orange-300 hidden md:inline-flex">
                {solverMetrics.status} · {solverMetrics.totalSolveTimeSec ?? solverMetrics.solveTimeSec ?? "?"}s
              </Badge>
            )}
          </div>
        </div>

        {/* ──────────── Setup Wizard (Normativa → Cluster/Auto → Lancia) ──────────── */}
        <Card className="bg-gradient-to-br from-orange-500/10 via-card/40 to-card/20 border-orange-500/30">
          <CardContent className="p-4">
            <button
              onClick={() => setSetupOpen(o => !o)}
              className="w-full flex items-center gap-2 text-left mb-2"
            >
              <FileCheck className="w-4 h-4 text-orange-400" />
              <h3 className="text-sm font-semibold flex-1">Configurazione Ottimizzatore Turni Guida</h3>
              {loadedDssId && (
                <Badge variant="outline" className="text-[10px] border-amber-500/40 text-amber-400">
                  <CheckCircle2 className="w-2.5 h-2.5 mr-1" /> Scenario caricato
                </Badge>
              )}
              {setupOpen ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
            </button>
            <AnimatePresence initial={false}>
              {setupOpen && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.2 }}
                  className="overflow-hidden"
                >
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3 pt-2">

                    {/* ── Step 1: Normativa ── */}
                    <div className="rounded-lg border border-border/40 bg-background/40 p-3">
                      <div className="flex items-center gap-2 mb-2">
                        <span className="w-5 h-5 rounded-full bg-orange-500/20 text-orange-400 text-[10px] font-bold flex items-center justify-center">1</span>
                        <span className="text-xs font-semibold">Normativa</span>
                      </div>
                      <p className="text-[10px] text-muted-foreground mb-2">Tipo di servizio per il quale ottimizzare</p>
                      <div className="space-y-1.5">
                        <button
                          onClick={() => setNormativa("urbano")}
                          className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-xs border transition-colors ${
                            normativa === "urbano"
                              ? "border-orange-500/50 bg-orange-500/10 text-orange-400"
                              : "border-border/40 bg-background/30 hover:border-orange-500/30 text-foreground"
                          }`}
                        >
                          <Building2 className="w-3.5 h-3.5" />
                          <span className="font-medium flex-1 text-left">Urbano</span>
                          {normativa === "urbano" && <CheckCircle2 className="w-3.5 h-3.5" />}
                        </button>
                        <button
                          disabled
                          className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-xs border border-border/30 bg-background/20 text-muted-foreground/50 cursor-not-allowed"
                          title="Disponibile prossimamente"
                        >
                          <Lock className="w-3.5 h-3.5" />
                          <span className="font-medium flex-1 text-left">Extraurbano</span>
                          <Badge variant="outline" className="text-[8px] py-0 px-1 border-border/30">prossimamente</Badge>
                        </button>
                      </div>
                    </div>

                    {/* ── Step 2: Cluster + Autovetture ── */}
                    <div className="rounded-lg border border-border/40 bg-background/40 p-3">
                      <div className="flex items-center gap-2 mb-2">
                        <span className="w-5 h-5 rounded-full bg-orange-500/20 text-orange-400 text-[10px] font-bold flex items-center justify-center">2</span>
                        <span className="text-xs font-semibold">Cluster & Autovetture</span>
                      </div>
                      <p className="text-[10px] text-muted-foreground mb-2">Seleziona cluster di scambio e autovetture aziendali per questo scenario</p>

                      {/* Selezione cluster */}
                      <div className="mb-2">
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-[10px] font-medium text-muted-foreground flex items-center gap-1">
                            <Grip className="w-3 h-3 text-orange-400" />
                            Cluster di scambio
                            <span className="text-orange-400 font-mono font-bold ml-0.5">{selectedClusterIds.size}/{clustersInfo.length}</span>
                          </span>
                          <div className="flex gap-1">
                            <button onClick={selectAllClusters}
                              className="text-[9px] px-1.5 py-0.5 rounded hover:bg-orange-500/10 text-orange-400/70 hover:text-orange-300 transition-colors">
                              Tutti
                            </button>
                            <button onClick={deselectAllClusters}
                              className="text-[9px] px-1.5 py-0.5 rounded hover:bg-muted/40 text-muted-foreground hover:text-foreground transition-colors">
                              Nessuno
                            </button>
                          </div>
                        </div>
                        <div className="space-y-0.5 max-h-36 overflow-y-auto pr-1 rounded border border-border/20 bg-background/30 p-1">
                          {clustersInfo.length === 0 ? (
                            <div className="px-2 py-1 text-[10px] text-muted-foreground italic">Nessun cluster definito</div>
                          ) : clustersInfo.map(c => {
                            const checked = selectedClusterIds.has(c.id);
                            return (
                              <label key={c.id}
                                className={`flex items-center gap-1.5 px-1.5 py-1 rounded cursor-pointer text-[10px] transition-colors ${
                                  checked ? "bg-orange-500/10 hover:bg-orange-500/15" : "hover:bg-muted/30"
                                }`}>
                                <input type="checkbox" checked={checked}
                                  onChange={() => toggleCluster(c.id)}
                                  className="w-3 h-3 accent-orange-500" />
                                <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: c.color || "#f97316" }} />
                                <span className="flex-1 truncate">{c.name}</span>
                                {c.transferFromDepotMin != null && (
                                  <span className="text-muted-foreground/60 font-mono">{c.transferFromDepotMin}'</span>
                                )}
                              </label>
                            );
                          })}
                        </div>
                        <a href="/cluster" className="block text-[9px] text-center mt-1 text-muted-foreground hover:text-orange-400 transition-colors">
                          Gestisci cluster →
                        </a>
                      </div>

                      {/* Autovetture aziendali */}
                      <div className="mb-1">
                        <label className="text-[10px] font-medium text-muted-foreground flex items-center gap-1 mb-1">
                          <Car className="w-3 h-3 text-amber-400" />
                          Autovetture aziendali disponibili
                        </label>
                        <div className="flex items-center gap-1.5">
                          <button onClick={() => setCompanyCars(n => Math.max(0, n - 1))}
                            className="w-6 h-6 rounded border border-border/40 hover:border-amber-500/40 hover:text-amber-400 text-xs font-bold">−</button>
                          <input
                            type="number" min={0} max={50} value={companyCars}
                            onChange={e => setCompanyCars(Math.max(0, Math.min(50, parseInt(e.target.value || "0", 10))))}
                            className="flex-1 px-2 py-1 text-xs text-center font-mono rounded border border-border/40 bg-background/50 focus:border-amber-500/40 outline-none" />
                          <button onClick={() => setCompanyCars(n => Math.min(50, n + 1))}
                            className="w-6 h-6 rounded border border-border/40 hover:border-amber-500/40 hover:text-amber-400 text-xs font-bold">+</button>
                        </div>
                        <p className="text-[9px] text-muted-foreground mt-0.5 leading-tight">
                          Per trasferimenti deposito ↔ cluster · {depotsInfo.length} deposit{depotsInfo.length === 1 ? "o" : "i"}
                        </p>
                      </div>

                      {solverMode === "cpsat" && (
                        <button
                          onClick={() => setConfigOpen(true)}
                          className="w-full flex items-center justify-center gap-1.5 mt-2 px-2.5 py-1.5 rounded-md text-[10px] bg-muted/30 hover:bg-muted/50 border border-border/30 transition-colors"
                        >
                          <Settings className="w-3 h-3" /> Config avanzata (pesi, BDS, costi)
                        </button>
                      )}
                    </div>

                    {/* ── Step 3: Lancia ── */}
                    <div className="rounded-lg border border-border/40 bg-background/40 p-3">
                      <div className="flex items-center gap-2 mb-2">
                        <span className="w-5 h-5 rounded-full bg-orange-500/20 text-orange-400 text-[10px] font-bold flex items-center justify-center">3</span>
                        <span className="text-xs font-semibold">Lancia ottimizzatore</span>
                      </div>
                      <p className="text-[10px] text-muted-foreground mb-2">Seleziona il solver e avvia il calcolo</p>
                      <div className="space-y-1.5">
                        <div className="flex gap-1">
                          <button onClick={() => switchMode("greedy")}
                            className={`flex-1 px-2 py-1.5 rounded text-[11px] font-medium transition-colors ${solverMode === "greedy" ? "bg-orange-600 text-white" : "bg-muted/30 text-muted-foreground hover:text-foreground"}`}>
                            ⚡ Greedy
                          </button>
                          <button onClick={() => switchMode("cpsat")}
                            className={`flex-1 px-2 py-1.5 rounded text-[11px] font-medium transition-colors ${solverMode === "cpsat" ? "bg-gradient-to-r from-orange-600 to-red-600 text-white" : "bg-muted/30 text-muted-foreground hover:text-foreground"}`}>
                            🧠 CP-SAT
                          </button>
                        </div>
                        <button
                          onClick={solverMode === "cpsat" ? launchCPSAT : launchGreedy}
                          disabled={loading || cpsat.state === "running" || cpsat.state === "starting"}
                          className={`w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-md text-xs font-semibold transition-colors disabled:opacity-50 ${
                            solverMode === "cpsat"
                              ? "bg-gradient-to-r from-orange-600 to-red-600 text-white hover:from-orange-700 hover:to-red-700"
                              : "bg-orange-600 text-white hover:bg-orange-700"
                          }`}
                        >
                          <Play className="w-3.5 h-3.5" /> Genera Turni Guida
                        </button>
                        {savedDss.length > 0 && (
                          <p className="text-[9px] text-muted-foreground text-center pt-1">
                            {savedDss.length} scenario{savedDss.length === 1 ? "" : "i"} già salvat{savedDss.length === 1 ? "o" : "i"}
                          </p>
                        )}
                      </div>
                    </div>

                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </CardContent>
        </Card>

        {/* ──────────── Save dialog ──────────── */}
        <AnimatePresence>
          {showSaveDialog && (
            <motion.div
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4"
              onClick={() => !savingDss && setShowSaveDialog(false)}
            >
              <motion.div
                initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.95, opacity: 0 }}
                onClick={e => e.stopPropagation()}
                className="bg-card border border-border/60 rounded-xl p-5 w-full max-w-md shadow-2xl"
              >
                <div className="flex items-center gap-2 mb-3">
                  <Save className="w-4 h-4 text-amber-400" />
                  <h3 className="text-sm font-semibold">Salva Turni Guida</h3>
                </div>
                <p className="text-xs text-muted-foreground mb-3">
                  Lo scenario verrà salvato come variante dello scenario di turni macchina corrente.
                  Puoi creare più varianti di turni guida per lo stesso scenario.
                </p>
                <label className="text-[11px] font-medium text-muted-foreground">Nome scenario</label>
                <input
                  type="text" autoFocus value={dssName}
                  onChange={e => setDssName(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter") saveDss(); if (e.key === "Escape") setShowSaveDialog(false); }}
                  className="w-full mt-1 mb-4 px-3 py-1.5 text-sm rounded-md bg-background/50 border border-border/40 focus:border-orange-500 outline-none"
                  placeholder="Es. Variante con CP-SAT, intensità alta"
                />
                <div className="flex justify-end gap-2">
                  <button
                    onClick={() => setShowSaveDialog(false)} disabled={savingDss}
                    className="px-3 py-1.5 text-xs rounded-md hover:bg-muted/40 transition-colors disabled:opacity-50"
                  >Annulla</button>
                  <button
                    onClick={saveDss} disabled={savingDss || !dssName.trim()}
                    className="flex items-center gap-1.5 px-4 py-1.5 text-xs font-medium rounded-md bg-amber-600 text-white hover:bg-amber-700 transition-colors disabled:opacity-50"
                  >
                    {savingDss ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
                    Salva
                  </button>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* ──────────── Saved DSS list ──────────── */}
        {savedDss.length > 0 && (
          <Card className="bg-muted/20 border-border/30">
            <CardContent className="p-4">
              <h3 className="text-xs font-semibold mb-2 flex items-center gap-1.5 text-muted-foreground uppercase tracking-wider">
                <FileCheck className="w-3.5 h-3.5" /> Turni Guida Salvati ({savedDss.length})
              </h3>
              <div className="space-y-1">
                {savedDss.map(s => {
                  const isLoaded = loadedDssId === s.id;
                  return (
                    <div key={s.id}
                      className={`group flex items-center gap-2 px-3 py-1.5 rounded-md border transition-colors ${
                        isLoaded ? "bg-amber-500/10 border-amber-500/30" : "bg-background/40 border-border/30 hover:border-orange-500/40"
                      }`}
                    >
                      {isLoaded
                        ? <CheckCircle2 className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                        : <FileCheck className="w-3.5 h-3.5 text-muted-foreground shrink-0" />}
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-medium truncate">{s.name}</p>
                        <p className="text-[10px] text-muted-foreground">
                          {s.summary?.totalDriverShifts ?? "—"} autisti
                          {s.summary?.totalWorkHours ? ` · ${s.summary.totalWorkHours}h lavoro` : ""}
                          {s.createdAt ? ` · ${new Date(s.createdAt).toLocaleString("it-IT", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}` : ""}
                        </p>
                      </div>
                      {!isLoaded && (
                        <a
                          href={`/driver-shifts/${scenarioId}?dss=${s.id}`}
                          className="text-[10px] px-2 py-1 rounded bg-orange-500/10 text-orange-400 hover:bg-orange-700/20 transition-colors"
                        >Carica</a>
                      )}
                      <button
                        onClick={() => deleteDss(s.id)}
                        title={confirmDelDss === s.id ? "Conferma" : "Elimina"}
                        className={`p-1 rounded transition-all ${
                          confirmDelDss === s.id
                            ? "text-red-400 bg-red-500/20"
                            : "text-muted-foreground/40 hover:text-red-400 hover:bg-red-500/10 opacity-0 group-hover:opacity-100"
                        }`}
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        )}

        {/* CP-SAT Progress Panel — visible during optimization even without result */}
        {solverMode === "cpsat" && (cpsat.state === "starting" || cpsat.state === "running" || cpsat.state === "stopped" || (cpsat.state === "failed" && !result)) && (
          <OptimizationProgressPanel
            state={cpsat.state}
            progress={cpsat.progress}
            progressHistory={cpsat.progressHistory}
            elapsedSec={cpsat.elapsedSec}
            onStop={cpsat.stop}
          />
        )}

        {/* Error banner (inline, not full-page) */}
        {error && cpsat.state !== "running" && cpsat.state !== "starting" && result && (
          <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-4 text-sm text-red-400">
            <AlertTriangle className="w-4 h-4 inline mr-2" />{error}
          </div>
        )}

        {/* Idle placeholder — when no result and not running */}
        {!result && !loading && cpsat.state !== "running" && cpsat.state !== "starting" && (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="w-16 h-16 rounded-full bg-orange-500/10 flex items-center justify-center mb-4">
              <Users className="w-8 h-8 text-orange-400/60" />
            </div>
            <h3 className="text-lg font-semibold mb-2">Genera Turni Guida</h3>
            <p className="text-sm text-muted-foreground max-w-md">
              Seleziona il solver ({solverMode === "cpsat" ? "🧠 CP-SAT" : "⚡ Greedy"}) e clicca
              <strong> Genera Turni Guida</strong> per calcolare i turni a partire dai turni macchina dello scenario.
            </p>
          </div>
        )}

        {/* Operator Config Drawer */}
        <OperatorConfigPanel
          isOpen={configOpen}
          onClose={() => setConfigOpen(false)}
          config={operatorConfig}
          onChange={setOperatorConfig}
        />

        {/* Summary cards */}
        {result && (<>
        <div>
          <div className="flex items-center gap-2 mb-2">
            <div className="h-6 w-1 rounded-full bg-gradient-to-b from-orange-500 to-red-500" />
            <h3 className="text-xs font-semibold uppercase tracking-wider text-orange-300">Risultato Ottimizzazione</h3>
            <span className="text-[10px] text-muted-foreground">— indicatori chiave della soluzione generata</span>
          </div>
          <div className="flex flex-wrap gap-3">
            <SummaryCard icon={<Users className="w-4 h-4" />} label="Autisti" value={result.summary.totalDriverShifts.toString()} sub={`${result.summary.byType.intero} interi · ${result.summary.byType.semiunico} semiunici · ${result.summary.byType.spezzato} spezzati`} />
          <SummaryCard icon={<Clock className="w-4 h-4" />} label="Ore Lavoro Totali" value={`${result.summary.totalWorkHours}h`} sub={`media: ${formatDuration(result.summary.avgWorkMin)}/turno`} />
          <SummaryCard icon={<Timer className="w-4 h-4" />} label="Ore Nastro Totali" value={`${result.summary.totalNastroHours}h`} sub={`media: ${formatDuration(result.summary.avgNastroMin)}/turno`} />
          <SummaryCard icon={<Coffee className="w-4 h-4" />} label="Semiunici" value={`${result.summary.semiunicoPct}%`} color={result.summary.semiunicoPct <= 12 ? "#fbbf24" : "#ef4444"} sub="limite ≤ 12%" />
          <SummaryCard icon={<Timer className="w-4 h-4" />} label="Spezzati" value={`${result.summary.spezzatoPct}%`} color={result.summary.spezzatoPct <= 13 ? "#fbbf24" : "#ef4444"} sub="limite ≤ 13%" />
          {result.summary.byType.supplemento > 0 && (
            <SummaryCard icon={<Zap className="w-4 h-4" />} label="Supplementi" value={result.summary.byType.supplemento.toString()} sub="straordinari (≤ 2h30)" color="#dc2626" />
          )}
          {result.summary.totalCambi > 0 && (() => {
            const totalHandovers = result.driverShifts.reduce((sum, s) => sum + (s.handovers?.filter(h => h.role === "outgoing").length ?? 0), 0);
            const interCount = result.summary.totalInterCambi ?? result.summary.totalCambi;
            const intraCount = result.summary.totalIntraCambi ?? 0;
            const subLabel = intraCount > 0
              ? `${interCount} inter + ${intraCount} intra-corsa`
              : (totalHandovers > 0 ? `${totalHandovers} cambi bus con auto aziendale` : `${result.driverShifts.filter(s => s.cambiCount > 0).length} turni con cambio`);
            return (
              <SummaryCard icon={<Repeat className="w-4 h-4" />} label="Cambi in Linea" value={result.summary.totalCambi.toString()} sub={subLabel} color="#fb923c" />
            );
          })()}
          <SummaryCard icon={<Car className="w-4 h-4" />} label="Auto Aziendali" value={`${result.summary.companyCarsUsed}/${result.companyCars}`} sub="per trasf. deposito ↔ cluster" />
          {result.summary.totalDailyCost != null && result.summary.totalDailyCost > 0 && (
            <SummaryCard icon={<DollarSign className="w-4 h-4" />} label="Costo Giornaliero" value={`€${result.summary.totalDailyCost.toLocaleString("it-IT", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`} sub={result.summary.efficiency?.costPerDriver ? `€${result.summary.efficiency.costPerDriver.toFixed(0)}/autista` : "ottimizzato"} color="#f59e0b" />
          )}
          {result.unassignedBlocks > 0 && (
            <SummaryCard icon={<AlertTriangle className="w-4 h-4" />} label="Non assegnati" value={result.unassignedBlocks.toString()} color="#ef4444" sub="blocchi rimasti" />
          )}
          {/* BDS conformity summary */}
          {result.driverShifts.some(s => s.bdsValidation) && (() => {
            const withBds = result.driverShifts.filter(s => s.bdsValidation);
            const conformi = withBds.filter(s => s.bdsValidation!.valid).length;
            const pct = Math.round((conformi / withBds.length) * 100);
            return (
              <SummaryCard icon={<Shield className="w-4 h-4" />} label="Conformità BDS" value={`${pct}%`} color={pct >= 90 ? "#fbbf24" : pct >= 70 ? "#f59e0b" : "#ef4444"} sub={`${conformi}/${withBds.length} turni conformi`} />
            );
          })()}
          </div>
        </div>

        {/* ══════════ ANALISI OTTIMIZZAZIONE (sintesi del processo) ══════════ */}
        {result.optimizationAnalysis && (
          <div>
            <div className="flex items-center gap-2 mb-2">
              <div className="h-6 w-1 rounded-full bg-gradient-to-b from-amber-500 to-orange-500" />
              <h3 className="text-xs font-semibold uppercase tracking-wider text-amber-300">Come ha ragionato l'algoritmo</h3>
              <span className="text-[10px] text-muted-foreground">— cosa ha provato, quale strategia ha vinto, quanto si è rifinito</span>
            </div>
            <OptimizationAnalysisCard analysis={result.optimizationAnalysis} />
          </div>
        )}

        {/* ══════════ CLASSIFICA SCENARI CP-SAT ══════════ */}
        {result.scenarios && result.scenarios.length > 0 && (
          <div>
            <div className="flex items-center gap-2 mb-2">
              <div className="h-6 w-1 rounded-full bg-gradient-to-b from-orange-500 to-red-500" />
              <h3 className="text-xs font-semibold uppercase tracking-wider text-orange-300">Tutti gli scenari a confronto</h3>
              <span className="text-[10px] text-muted-foreground">— clicca su una colonna per riordinare, clicca su una riga per il dettaglio</span>
            </div>
            <ScenarioRankingCard scenarios={result.scenarios} />
          </div>
        )}

        {/* Distribution charts */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Type distribution */}
          <Card className="bg-muted/30 border-border/30">
            <CardContent className="p-4">
              <h3 className="text-sm font-semibold flex items-center gap-1.5 mb-3"><BarChart3 className="w-4 h-4 text-orange-400" /> Distribuzione per Tipo</h3>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={typeDistData} layout="vertical">
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.3} />
                  <XAxis type="number" tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
                  <YAxis type="category" dataKey="name" tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" width={90} />
                  <ReTooltip contentStyle={{ backgroundColor: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 12 }} />
                  <Bar dataKey="count" name="Turni" radius={[0, 4, 4, 0]}>
                    {typeDistData.map((entry, i) => (
                      <Cell key={i} fill={entry.color} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
              {/* Type legend with limits */}
              <div className="mt-3 space-y-1">
                {(Object.entries(TYPE_LABELS) as [DriverShiftType, string][]).map(([type, label]) => {
                  const count = result.summary.byType[type] || 0;
                  if (count === 0) return null;
                  return (
                    <div key={type} className="flex items-center gap-2 text-[10px]">
                      <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: TYPE_COLORS[type] }} />
                      <span className="font-medium">{label}</span>
                      <span className="text-muted-foreground">{count} turni</span>
                      <span className="text-muted-foreground/60">— {TYPE_DESC[type]}</span>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>

          {/* Work duration distribution */}
          <Card className="bg-muted/30 border-border/30">
            <CardContent className="p-4">
              <h3 className="text-sm font-semibold flex items-center gap-1.5 mb-3"><TrendingUp className="w-4 h-4 text-orange-400" /> Distribuzione Ore Lavoro</h3>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={workDistData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.3} />
                  <XAxis dataKey="label" tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
                  <YAxis tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
                  <ReTooltip contentStyle={{ backgroundColor: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 12 }} />
                  <Bar dataKey="count" name="Turni" fill="#f97316" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
              <div className="mt-2 text-[10px] text-muted-foreground text-center">
                Target: 6h30–6h42 di lavoro effettivo per turno
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Cluster di Cambio in Linea */}
        {result.clusters && result.clusters.length > 0 && (
          <Card className="bg-muted/30 border-border/30">
            <CardContent className="p-4">
              <h3 className="text-sm font-semibold flex items-center gap-1.5 mb-3"><Repeat className="w-4 h-4 text-orange-400" /> Cluster di Cambio in Linea</h3>
              <p className="text-xs text-muted-foreground mb-3">
                Zone dove i conducenti possono scambiarsi il veicolo durante il servizio. Il conducente subentrante arriva dal deposito (Via Bocconi 35) guidando un'auto aziendale che lascia al capolinea. Il conducente uscente prende l'auto e rientra al deposito.
              </p>
              <div className="flex flex-wrap gap-2">
                {result.clusters.map(c => (
                  <div key={c.id} className="flex items-center gap-2 bg-orange-500/10 border border-orange-500/20 rounded-lg px-3 py-2">
                    <div className="w-2 h-2 rounded-full bg-orange-400" />
                    <div>
                      <div className="text-xs font-medium">{c.name}</div>
                      <div className="text-[10px] text-muted-foreground">Trasf. deposito: {c.transferMin} min</div>
                    </div>
                  </div>
                ))}
              </div>
              <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
                <Car className="w-3.5 h-3.5" />
                <span>{result.companyCars} auto aziendali disponibili per trasferimenti deposito ↔ cluster</span>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Normativa compliance */}
        <Card className="bg-muted/30 border-border/30">
          <CardContent className="p-4">
            <h3 className="text-sm font-semibold flex items-center gap-1.5 mb-3"><Shield className="w-4 h-4 text-orange-400" /> Conformità Normativa</h3>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className={`rounded-lg p-3 border ${result.summary.semiunicoPct <= 12 ? "bg-amber-500/10 border-amber-500/30" : "bg-red-500/5 border-red-500/20"}`}>
                <div className="text-[10px] text-muted-foreground mb-1">Semiunici ≤ 12%</div>
                <div className={`text-2xl font-bold ${result.summary.semiunicoPct <= 12 ? "text-amber-300" : "text-red-400"}`}>
                  {result.summary.semiunicoPct}%
                </div>
                <div className="text-[10px] text-muted-foreground">{result.summary.byType.semiunico} su {result.summary.totalDriverShifts} autisti</div>
              </div>
              <div className={`rounded-lg p-3 border ${result.summary.spezzatoPct <= 13 ? "bg-amber-500/10 border-amber-500/30" : "bg-red-500/5 border-red-500/20"}`}>
                <div className="text-[10px] text-muted-foreground mb-1">Spezzati ≤ 13%</div>
                <div className={`text-2xl font-bold ${result.summary.spezzatoPct <= 13 ? "text-amber-300" : "text-red-400"}`}>
                  {result.summary.spezzatoPct}%
                </div>
                <div className="text-[10px] text-muted-foreground">{result.summary.byType.spezzato} su {result.summary.totalDriverShifts} autisti</div>
              </div>
              <div className={`rounded-lg p-3 border ${result.summary.avgWorkMin >= 380 && result.summary.avgWorkMin <= 420 ? "bg-amber-500/10 border-amber-500/30" : "bg-amber-500/5 border-amber-500/20"}`}>
                <div className="text-[10px] text-muted-foreground mb-1">Lavoro medio target 6h30–6h42</div>
                <div className={`text-2xl font-bold ${result.summary.avgWorkMin >= 380 && result.summary.avgWorkMin <= 420 ? "text-amber-300" : "text-amber-400"}`}>
                  {formatDuration(result.summary.avgWorkMin)}
                </div>
                <div className="text-[10px] text-muted-foreground">media per turno</div>
              </div>
            </div>
            {/* BDS per-check breakdown */}
            {result.driverShifts.some(s => s.bdsValidation) && (() => {
              const withBds = result.driverShifts.filter(s => s.bdsValidation);
              const checks: [string, keyof NonNullable<DriverShiftData["bdsValidation"]>][] = [
                ["CE 561/2006", "cee561"], ["Pasto", "intervalloPasto"],
                ["Stacco min.", "staccoMinimo"], ["Nastro", "nastro"], ["Riprese", "riprese"],
              ];
              return (
                <div className="mt-3 grid grid-cols-2 sm:grid-cols-5 gap-2">
                  {checks.map(([label, key]) => {
                    const ok = withBds.filter(s => s.bdsValidation![key] === true).length;
                    const pct = Math.round((ok / withBds.length) * 100);
                    return (
                      <div key={key} className={`rounded-lg p-2 border text-center ${pct === 100 ? "bg-amber-500/10 border-amber-500/30" : "bg-amber-500/5 border-amber-500/20"}`}>
                        <div className="text-[10px] text-muted-foreground mb-0.5">{label}</div>
                        <div className={`text-lg font-bold ${pct === 100 ? "text-amber-300" : "text-amber-400"}`}>{pct}%</div>
                        <div className="text-[9px] text-muted-foreground">{ok}/{withBds.length}</div>
                      </div>
                    );
                  })}
                </div>
              );
            })()}
          </CardContent>
        </Card>

        {/* Area di Lavoro Turni Guida — Gantt interattivo drag-and-drop */}
        <Card className="bg-muted/30 border-border/30">
          <CardContent className="p-4">
            <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="text-sm font-semibold flex items-center gap-1.5">
                  <Wand2 className="w-4 h-4 text-orange-400" /> Area di Lavoro · Turni Guida
                </h3>
                <span className="text-[10px] text-muted-foreground">
                  {result.driverShifts.length} turni · {driverGanttBars.length} elementi
                </span>
                {modifiedCount > 0 && (
                  <span className="text-[10px] font-medium text-amber-300 bg-amber-500/10 border border-amber-500/30 px-1.5 py-0.5 rounded">
                    ● {modifiedCount} modific{modifiedCount === 1 ? "a" : "he"}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                {/* Toggle vista esplosa / aggregata */}
                <div className="flex rounded-md overflow-hidden border border-orange-500/30 text-[10px]">
                  <button
                    onClick={() => setGanttMode("exploded")}
                    className={`px-2 py-1 font-medium transition flex items-center gap-1 ${
                      ganttMode === "exploded"
                        ? "bg-orange-500/30 text-white"
                        : "text-orange-300/60 hover:bg-orange-500/10"
                    }`}
                    title="1 bar per corsa (drag-and-drop tra autisti)"
                  >
                    <Layers className="w-3 h-3" /> Corse
                  </button>
                  <button
                    onClick={() => setGanttMode("aggregated")}
                    className={`px-2 py-1 font-medium transition ${
                      ganttMode === "aggregated"
                        ? "bg-orange-500/30 text-white"
                        : "text-orange-300/60 hover:bg-orange-500/10"
                    }`}
                    title="1 bar per ripresa (vista compatta read-only)"
                  >
                    Riprese
                  </button>
                </div>
                {/* Undo / Redo */}
                <button
                  onClick={handleUndo}
                  disabled={!canUndo}
                  className="flex items-center gap-1 text-[10px] text-orange-300 px-2 py-1 rounded border border-orange-500/30 bg-orange-500/8 hover:bg-orange-500/15 transition disabled:opacity-30 disabled:cursor-not-allowed"
                  title="Annulla (Ctrl/⌘+Z)"
                >
                  <Undo2 className="w-3 h-3" />
                </button>
                <button
                  onClick={handleRedo}
                  disabled={!canRedo}
                  className="flex items-center gap-1 text-[10px] text-orange-300 px-2 py-1 rounded border border-orange-500/30 bg-orange-500/8 hover:bg-orange-500/15 transition disabled:opacity-30 disabled:cursor-not-allowed"
                  title="Ripristina (Ctrl/⌘+Shift+Z)"
                >
                  <Redo2 className="w-3 h-3" />
                </button>
                {/* Filtro tipo */}
                <select
                  value={typeFilter}
                  onChange={e => setTypeFilter(e.target.value as any)}
                  className="text-xs bg-background border border-border/50 rounded px-2 py-1"
                >
                  <option value="all">Tutti ({result.driverShifts.length})</option>
                  {(Object.entries(result.summary.byType) as [DriverShiftType, number][])
                    .filter(([, c]) => c > 0)
                    .map(([type, count]) => (
                      <option key={type} value={type}>{TYPE_LABELS[type]} ({count})</option>
                    ))}
                </select>
              </div>
            </div>
            <div className="text-[10px] text-muted-foreground/80 italic mb-2">
              {ganttMode === "exploded"
                ? "Trascina le corse fra autisti o orizzontalmente per riassegnare/spostare. Le riprese vengono ricalcolate automaticamente."
                : "Vista compatta — passa a 'Corse' per modificare con drag-and-drop."}
            </div>
            {filteredShifts.length > 0 ? (
              <InteractiveGantt
                rows={driverGanttRows}
                bars={driverGanttBars}
                editable={ganttMode === "exploded"}
                onBarChange={ganttMode === "exploded" ? handleDriverGanttChange : undefined}
                onBarClick={(bar) => {
                  const meta: any = bar.meta || {};
                  toast.info(`${meta.type ?? "elemento"} · ${meta.driverId ?? bar.rowId}`, {
                    description: bar.tooltip?.join(" · "),
                  });
                }}
                getSuggestions={ganttMode === "exploded" && result ? (bar) => {
                  const meta: any = bar.meta || {};
                  if (meta.type !== "trip" || !meta.tripId) return [];
                  const suggs = suggestDriversForTrip(result.driverShifts, meta.tripId);
                  return suggs.slice(0, 6).map(s => ({
                    rowId: s.driverId,
                    label: s.driverId,
                    reason: s.reason,
                    detail: s.detail,
                  }));
                } : undefined}
                minHour={driverGanttMinHour}
                maxHour={driverGanttMaxHour}
                rowHeight={32}
                labelWidth={160}
              />
            ) : (
              <p className="text-sm text-muted-foreground text-center py-4">Nessun turno guida</p>
            )}
            {/* Legend */}
            <div className="flex flex-wrap gap-x-4 gap-y-1 mt-3 pt-3 border-t border-border/20">
              {(Object.entries(TYPE_LABELS) as [DriverShiftType, string][]).map(([type, label]) => (
                <div key={type} className="flex items-center gap-1.5">
                  <span className="w-3 h-2 rounded-sm" style={{ backgroundColor: TYPE_COLORS[type] }} />
                  <span className="text-[10px] text-muted-foreground">{label}</span>
                </div>
              ))}
              <div className="flex items-center gap-1.5">
                <span className="w-3 h-2 rounded-sm" style={{ backgroundColor: "rgba(255,255,255,0.06)", backgroundImage: "repeating-linear-gradient(90deg, transparent, transparent 2px, rgba(255,255,255,0.2) 2px, rgba(255,255,255,0.2) 4px)" }} />
                <span className="text-[10px] text-muted-foreground">Interruzione</span>
              </div>
              <div className="flex items-center gap-1.5">
                <div className="w-0 h-0 border-l-[4px] border-r-[4px] border-t-[6px] border-l-transparent border-r-transparent border-t-orange-400" />
                <span className="text-[10px] text-muted-foreground">Cambio in Linea</span>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Shift list */}
        <Card className="bg-muted/30 border-border/30">
          <CardContent className="p-4">
            <h3 className="text-sm font-semibold mb-3 flex items-center gap-1.5"><Users className="w-4 h-4 text-orange-400" /> Dettaglio Turni ({filteredShifts.length})</h3>
            <div className="space-y-1">
              {filteredShifts.map(shift => {
                const isExpanded = expandedShifts.has(shift.driverId);
                const typeColor = TYPE_COLORS[shift.type];
                return (
                  <div key={shift.driverId} className="bg-background/50 rounded-lg overflow-hidden">
                    <button onClick={() => toggleShift(shift.driverId)} className="w-full flex items-center gap-3 px-3 py-2 text-sm hover:bg-muted/30 transition-colors">
                      <span className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: typeColor }} />
                      <span className="font-mono font-medium text-xs">{shift.driverId}</span>
                      <Badge variant="outline" className="text-[10px]" style={{ borderColor: typeColor, color: typeColor }}>
                        {TYPE_LABELS[shift.type]}
                      </Badge>
                      <span className="text-xs text-muted-foreground">
                        {(shift.nastroStart ?? "").slice(0, 5)} → {(shift.nastroEnd ?? "").slice(0, 5)}
                      </span>
                      <span className="text-xs text-muted-foreground ml-auto">
                        Lavoro: {shift.work} · Nastro: {shift.nastro}
                        {shift.interruption && <> · Pausa: {shift.interruption}</>}
                        {shift.cambiCount > 0 && (() => {
                          const intraH = shift.handovers?.filter(h => h.cutType === "intra").length ?? 0;
                          const icon = intraH > 0 ? " ✂️" : ((shift.handovers?.length ?? 0) > 0 ? " 🔄" : "");
                          return <> · <span className={intraH > 0 ? "text-amber-400" : "text-orange-400"}>{shift.cambiCount} cambi{icon}</span></>;
                        })()}
                        {shift.riprese.length > 0 && <> · {shift.riprese.reduce((s, r) => s + r.trips.length, 0)} corse</>}
                        {shift.costEuro != null && shift.costEuro > 0 && <> · <span className="text-amber-400 font-medium">€{shift.costEuro.toFixed(0)}</span></>}
                      </span>
                      {/* BDS validation badge */}
                      {shift.bdsValidation && (
                        <span title={shift.bdsValidation.valid ? "Conforme BDS" : shift.bdsValidation.violations.join(", ")} className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${shift.bdsValidation.valid ? "bg-amber-500/15 text-amber-300" : "bg-red-500/15 text-red-400"}`}>
                          {shift.bdsValidation.valid ? "✅ BDS" : `❌ BDS (${shift.bdsValidation.violations.length})`}
                        </span>
                      )}
                      {isExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                    </button>
                    <AnimatePresence>
                      {isExpanded && (
                        <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="px-3 pb-3">
                          {/* LASCIA / PRENDE vettura labels */}
                          {shift.vehicleHandoverLabels && shift.vehicleHandoverLabels.length > 0 && (
                            <div className="flex flex-wrap gap-2 mb-2">
                              {shift.vehicleHandoverLabels.map((lbl, li) => (
                                <div key={li} className={`flex items-center gap-1.5 text-[11px] font-semibold rounded-md px-2.5 py-1.5 border ${
                                  lbl.startsWith("LASCIA") ? "bg-red-500/10 border-red-500/25 text-red-400" : "bg-amber-500/10 border-amber-500/25 text-amber-300"
                                }`}>
                                  <Repeat className="w-3 h-3" />
                                  {lbl}
                                </div>
                              ))}
                            </div>
                          )}
                          {shift.riprese.map((rip, ri) => {
                            // ── Build chronological activity list for this ripresa ──
                            const activities: { type: string; startMin: number; endMin: number; label: string; detail?: string; icon: React.ReactNode; colorClass: string; bgClass: string; vehicleId?: string }[] = [];

                            // Handovers for this ripresa (match by time proximity to ripresa range)
                            const myHandovers = (shift.handovers ?? []).filter(h => {
                              return h.atMin >= rip.startMin - 5 && h.atMin <= rip.endMin + 5;
                            });
                            const incomingH = myHandovers.find(h => h.role === "incoming");
                            const outgoingH = myHandovers.find(h => h.role === "outgoing");

                            let cursor = rip.startMin;

                            // 1. Pre-turno
                            if (rip.preTurnoMin > 0) {
                              const end = cursor + rip.preTurnoMin;
                              activities.push({
                                type: "preturno", startMin: cursor, endMin: end,
                                label: "Pre-turno",
                                detail: "Controllo veicolo, foglio di servizio",
                                icon: <Shield className="w-3.5 h-3.5" />,
                                colorClass: "text-orange-400", bgClass: "bg-orange-500/8 border-orange-500/15",
                              });
                              cursor = end;
                            }

                            // 2. Trasferimento a vuoto deposito → capolinea (con auto aziendale)
                            if (rip.transferMin > 0) {
                              const end = cursor + rip.transferMin;
                              const dest = rip.transferToStop || "capolinea";
                              let transferDetail = `Guidi dal Deposito a ${dest} con auto aziendale (${rip.transferMin} min)`;
                              if (incomingH) {
                                transferDetail = `Arrivi a ${dest} con auto aziendale per prendere bus ${incomingH.vehicleId}`;
                              }
                              // Car pool info: quale auto e orari
                              if (rip.carPoolOut) {
                                transferDetail += `\n🚗 ${rip.carPoolOut.description}`;
                              }
                              activities.push({
                                type: "transfer", startMin: cursor, endMin: end,
                                label: `Auto aziendale → ${dest}`,
                                detail: transferDetail,
                                icon: <Car className="w-3.5 h-3.5" />,
                                colorClass: "text-orange-400", bgClass: "bg-orange-500/8 border-orange-500/15",
                                vehicleId: rip.vehicleIds[0],
                              });
                              cursor = end;
                            }

                            // 2b. Incoming handover: autista arriva e prende il bus da un collega
                            if (incomingH) {
                              const isIntra = incomingH.cutType === "intra";
                              activities.push({
                                type: "handover", startMin: incomingH.atMin, endMin: incomingH.atMin,
                                label: isIntra ? "✂️ Cambio intra-corsa (arrivo)" : "🔄 Cambio bus (arrivo)",
                                detail: incomingH.description + (isIntra && incomingH.routeName ? ` · Linea ${incomingH.routeName}` : ""),
                                icon: <Repeat className="w-3.5 h-3.5" />,
                                colorClass: isIntra ? "text-amber-400" : "text-orange-400",
                                bgClass: isIntra ? "bg-amber-500/10 border-amber-500/20" : "bg-orange-500/10 border-orange-500/20",
                              });
                            }

                            // 3. Corse di linea + soste tra corse + cambi in linea
                            for (let ti = 0; ti < rip.trips.length; ti++) {
                              const t = rip.trips[ti];

                              // Cambio in linea — se il veicolo cambia rispetto alla corsa precedente
                              if (ti > 0 && t.vehicleId && rip.trips[ti - 1].vehicleId && t.vehicleId !== rip.trips[ti - 1].vehicleId) {
                                const cambio = rip.cambi?.find(c => Math.abs(c.atMin - t.departureMin) < 10);
                                activities.push({
                                  type: "handover", startMin: cursor, endMin: t.departureMin,
                                  label: "🔄 Cambio in Linea",
                                  detail: cambio
                                    ? `${cambio.clusterName}: ${cambio.fromVehicle} → ${cambio.toVehicle}`
                                    : `${rip.trips[ti - 1].vehicleId} → ${t.vehicleId}`,
                                  icon: <Repeat className="w-3.5 h-3.5" />,
                                  colorClass: "text-orange-400", bgClass: "bg-orange-500/10 border-orange-500/20",
                                  vehicleId: t.vehicleId,
                                });
                              }

                              // Sosta prima della corsa (gap tra cursor e partenza)
                              if (t.departureMin > cursor + 1) {
                                activities.push({
                                  type: "sosta", startMin: cursor, endMin: t.departureMin,
                                  label: "Sosta al capolinea",
                                  detail: `Attesa ${t.departureMin - cursor} min`,
                                  icon: <Coffee className="w-3.5 h-3.5" />,
                                  colorClass: "text-amber-400", bgClass: "bg-amber-500/8 border-amber-500/15",
                                  vehicleId: t.vehicleId,
                                });
                              }

                              // Corsa di linea
                              const dur = t.arrivalMin - t.departureMin;
                              const fromStop = t.firstStopName || "—";
                              const toStop = t.lastStopName || t.headsign || "—";
                              activities.push({
                                type: "trip", startMin: t.departureMin, endMin: t.arrivalMin,
                                label: `Linea ${t.routeName}`,
                                detail: `${fromStop} → ${toStop} (${dur} min)`,
                                icon: <Bus className="w-3.5 h-3.5" />,
                                colorClass: "text-amber-400", bgClass: "bg-amber-500/8 border-amber-500/15",
                                vehicleId: t.vehicleId,
                              });
                              cursor = t.arrivalMin;
                            }

                            // 3b. Outgoing handover: autista lascia il bus a un collega
                            if (outgoingH) {
                              const isIntraOut = outgoingH.cutType === "intra";
                              activities.push({
                                type: "handover", startMin: outgoingH.atMin, endMin: outgoingH.atMin,
                                label: isIntraOut ? "✂️ Cambio intra-corsa (uscita)" : "🔄 Cambio bus (uscita)",
                                detail: outgoingH.description + (isIntraOut && outgoingH.routeName ? ` · Linea ${outgoingH.routeName}` : ""),
                                icon: <Repeat className="w-3.5 h-3.5" />,
                                colorClass: isIntraOut ? "text-amber-400" : "text-orange-400",
                                bgClass: isIntraOut ? "bg-amber-500/10 border-amber-500/20" : "bg-orange-500/10 border-orange-500/20",
                              });
                            }

                            // 4. Rientro a vuoto — guidi auto aziendale al deposito
                            const transferBack = rip.transferBackMin || 0;
                            if (transferBack > 0 || rip.endMin > cursor + 2) {
                              const lastTrip = rip.trips[rip.trips.length - 1];
                              const returnFrom = rip.lastStop || lastTrip?.lastStopName || "capolinea";
                              const returnDur = transferBack > 0 ? transferBack : rip.endMin - cursor;
                              const returnEnd = cursor + returnDur;
                              let returnDetail = `Guidi auto aziendale da ${returnFrom} al Deposito (${returnDur} min)`;
                              if (outgoingH) {
                                returnDetail = `Bus ${outgoingH.vehicleId} lasciato a ${outgoingH.otherDriver} — rientri al deposito con auto aziendale`;
                              }
                              // Car pool info: quale auto e orari
                              if (rip.carPoolReturn) {
                                returnDetail += `\n🚗 ${rip.carPoolReturn.description}`;
                              }
                              activities.push({
                                type: "rientro", startMin: cursor, endMin: returnEnd,
                                label: `Rientro da ${returnFrom}`,
                                detail: returnDetail,
                                icon: <Car className="w-3.5 h-3.5" />,
                                colorClass: "text-orange-400", bgClass: "bg-orange-500/8 border-orange-500/15",
                                vehicleId: rip.vehicleIds[rip.vehicleIds.length - 1],
                              });
                            }

                            return (
                              <div key={ri} className="mb-3">
                                {/* Ripresa header */}
                                <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                                  <div className="text-[11px] font-semibold text-foreground/80">
                                    Ripresa {ri + 1}
                                  </div>
                                  <div className="text-[10px] text-muted-foreground">
                                    {(rip.startTime ?? "").slice(0, 5)} → {(rip.endTime ?? "").slice(0, 5)}
                                  </div>
                                  <div className="text-[10px] text-muted-foreground flex items-center gap-1">
                                    <Bus className="w-3 h-3" />
                                    <span className="font-mono">{rip.vehicleIds.join(", ")}</span>
                                    {rip.vehicleType && <Badge variant="outline" className="text-[9px] py-0 px-1">{rip.vehicleType}</Badge>}
                                  </div>
                                  <div className="text-[10px] text-muted-foreground">
                                    {rip.trips.length} corse · {rip.workMin} min lavoro
                                  </div>
                                </div>

                                {/* Chronological timeline */}
                                <div className="relative ml-4 border-l-2 border-border/30 space-y-0">
                                  {activities.map((act, ai) => (
                                    <div key={ai} className="relative pl-5 pb-1">
                                      {/* Timeline dot */}
                                      <div className={`absolute left-[-5px] top-[7px] w-2 h-2 rounded-full ${act.type === "trip" ? "bg-amber-400" : act.type === "sosta" ? "bg-amber-400" : act.type === "preturno" ? "bg-orange-400" : act.type === "handover" ? "bg-orange-400" : "bg-orange-400"}`} />
                                      {/* Activity row */}
                                      <div className={`flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs border ${act.bgClass}`}>
                                        <span className={`${act.colorClass} shrink-0`}>{act.icon}</span>
                                        <span className="font-mono font-medium text-foreground/90 min-w-[90px] shrink-0">
                                          {minToTime(act.startMin)} → {minToTime(act.endMin)}
                                        </span>
                                        <span className={`font-semibold ${act.colorClass} min-w-[130px] shrink-0`}>{act.label}</span>
                                        {act.detail && (
                                          <span className="text-muted-foreground flex flex-col">
                                            {act.detail.split('\n').map((line, li) => (
                                              <span key={li} className={li > 0 ? "text-[10px] text-amber-400/80" : "truncate"}>{line}</span>
                                            ))}
                                          </span>
                                        )}
                                        {act.vehicleId && (
                                          <span className="text-[9px] font-mono text-muted-foreground/70 bg-muted/30 border border-border/20 rounded px-1.5 py-0.5 shrink-0">{act.vehicleId}</span>
                                        )}
                                        <span className="ml-auto text-[10px] text-muted-foreground/60 shrink-0">{act.endMin - act.startMin} min</span>
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            );
                          })}

                          {/* Interruption between riprese */}
                          {shift.interruptionMin > 0 && shift.riprese.length >= 2 && (
                            <div className="flex items-center gap-2 text-xs bg-amber-500/8 border border-amber-500/15 rounded-md px-3 py-2 my-2">
                              <Coffee className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                              <span className="font-mono font-medium text-foreground/90 min-w-[90px]">
                                {(shift.riprese[0]?.endTime ?? "").slice(0, 5)} → {(shift.riprese[1]?.startTime ?? "").slice(0, 5)}
                              </span>
                              <span className="font-semibold text-amber-400">Interruzione</span>
                              <span className="text-muted-foreground">
                                {shift.interruption} — {shift.type === "semiunico" ? "non retribuita, in residenza" : "spezzato, riposo"}
                              </span>
                              <span className="ml-auto text-[10px] text-muted-foreground/60">{shift.interruptionMin} min</span>
                            </div>
                          )}

                          {/* BDS Validation & Work Calculation detail */}
                          {(shift.bdsValidation || shift.workCalculation) && (
                            <div className="mt-3 space-y-2">
                              {/* BDS Validation checks */}
                              {shift.bdsValidation && (
                                <div className={`rounded-lg border p-3 ${shift.bdsValidation.valid ? "bg-amber-500/10 border-amber-500/30" : "bg-red-500/5 border-red-500/20"}`}>
                                  <div className="flex items-center gap-2 mb-2">
                                    <Shield className="w-3.5 h-3.5 text-orange-400" />
                                    <span className="text-xs font-semibold">Validazione BDS</span>
                                    <Badge variant="outline" className={`text-[9px] ${shift.bdsValidation.valid ? "border-amber-500/40 text-amber-300" : "border-red-500/40 text-red-400"}`}>
                                      {shift.bdsValidation.valid ? "CONFORME" : "NON CONFORME"}
                                    </Badge>
                                  </div>
                                  <div className="flex flex-wrap gap-x-4 gap-y-1">
                                    {([
                                      ["classificazioneValida", "Classificazione"],
                                      ["cee561", "CE 561/2006"],
                                      ["intervalloPasto", "Pasto"],
                                      ["staccoMinimo", "Stacco min."],
                                      ["nastro", "Nastro"],
                                      ["riprese", "Riprese"],
                                    ] as [keyof typeof shift.bdsValidation, string][]).map(([key, label]) => {
                                      const val = shift.bdsValidation![key];
                                      if (typeof val !== "boolean") return null;
                                      return (
                                        <div key={key} className="flex items-center gap-1 text-[10px]">
                                          <span>{val ? "✅" : "❌"}</span>
                                          <span className={val ? "text-amber-300" : "text-red-400"}>{label}</span>
                                        </div>
                                      );
                                    })}
                                  </div>
                                  {shift.bdsValidation.violations.length > 0 && (
                                    <div className="mt-2 space-y-0.5">
                                      {shift.bdsValidation.violations.map((v, vi) => (
                                        <div key={vi} className="flex items-start gap-1.5 text-[10px] text-red-400">
                                          <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" />
                                          <span>{v}</span>
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              )}

                              {/* Work Calculation breakdown */}
                              {shift.workCalculation && (
                                <div className="rounded-lg border bg-muted/20 border-border/30 p-3">
                                  <div className="flex items-center gap-2 mb-2">
                                    <Clock className="w-3.5 h-3.5 text-orange-400" />
                                    <span className="text-xs font-semibold">Calcolo Lavoro BDS</span>
                                    <span className="text-[10px] text-muted-foreground ml-auto">
                                      Netto: <span className="font-semibold text-foreground">{formatDuration(shift.workCalculation.lavoroNetto)}</span>
                                      {" · "}Conv.: <span className="font-semibold text-foreground">{formatDuration(shift.workCalculation.lavoroConvenzionale)}</span>
                                    </span>
                                  </div>
                                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                                    {([
                                      ["driving", "Guida", "text-amber-400"],
                                      ["idleAtTerminal", "Soste capolinea", "text-amber-400"],
                                      ["prePost", "Pre/Post turno", "text-orange-400"],
                                      ["transfer", "Trasferimenti", "text-orange-400"],
                                      ["sosteFraRipreseIR", "Soste IR (inter-rip.)", "text-red-400"],
                                      ["sosteFraRipreseFR", "Soste FR (fra rip.)", "text-orange-400"],
                                    ] as [keyof typeof shift.workCalculation, string, string][]).map(([key, label, color]) => {
                                      const val = shift.workCalculation![key];
                                      if (typeof val !== "number" || val === 0) return null;
                                      return (
                                        <div key={key} className="text-[10px]">
                                          <div className="text-muted-foreground">{label}</div>
                                          <div className={`font-semibold ${color}`}>{val} min</div>
                                        </div>
                                      );
                                    })}
                                  </div>
                                </div>
                              )}
                            </div>
                          )}
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
        {/* end result conditional */}
        </>
        )}
      </div>
    </div>
  );
}


/* ═══════════════════════════════════════════════════════════════
 *  SCENARIO RANKING CARD — classifica di tutti gli scenari CP-SAT
 * ═══════════════════════════════════════════════════════════════ */

type SortKey =
  | "rank" | "duties" | "interi" | "semiunici" | "spezzati" | "supplementi"
  | "totalWorkH" | "totalNastroH" | "totalIdleH" | "vuotiSignificativi"
  | "totalCost" | "bdsViolations" | "score" | "elapsed";

function ScenarioRankingCard({ scenarios }: { scenarios: ScenarioResult[] }) {
  const [sortKey, setSortKey] = useState<SortKey>("rank");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [expanded, setExpanded] = useState(true);
  const [highlight, setHighlight] = useState<number | null>(null);

  const feasible = useMemo(() => scenarios.filter(s => s.feasible), [scenarios]);
  const infeasible = useMemo(() => scenarios.filter(s => !s.feasible), [scenarios]);

  const sorted = useMemo(() => {
    const arr = [...feasible];
    arr.sort((a, b) => {
      const av = (a as any)[sortKey] ?? 0;
      const bv = (b as any)[sortKey] ?? 0;
      const cmp = typeof av === "number" && typeof bv === "number"
        ? av - bv
        : String(av).localeCompare(String(bv));
      return sortDir === "asc" ? cmp : -cmp;
    });
    return arr;
  }, [feasible, sortKey, sortDir]);

  const toggleSort = (k: SortKey) => {
    if (sortKey === k) {
      setSortDir(d => d === "asc" ? "desc" : "asc");
    } else {
      setSortKey(k);
      setSortDir(k === "rank" || k === "score" || k === "totalCost" || k === "bdsViolations" || k === "totalIdleH" || k === "vuotiSignificativi" ? "asc" : "desc");
    }
  };

  // Best per varie dimensioni (per mettere medagliette)
  const best = useMemo(() => {
    if (feasible.length === 0) return {};
    const min = (k: SortKey) => feasible.reduce((m, s) => ((s as any)[k] < (m as any)[k] ? s : m), feasible[0]);
    const max = (k: SortKey) => feasible.reduce((m, s) => ((s as any)[k] > (m as any)[k] ? s : m), feasible[0]);
    return {
      cheapest: min("totalCost"),
      fewestDuties: min("duties"),
      leastIdle: min("totalIdleH"),
      leastViolations: min("bdsViolations"),
      shortestWork: min("totalWorkH"),
      bestScore: min("score"),
      fewestSupplementi: min("supplementi"),
    };
  }, [feasible]);

  if (scenarios.length === 0) return null;

  const bestScenario = feasible.find(s => s.isBest);

  return (
    <Card className="bg-gradient-to-br from-orange-950/30 via-red-950/10 to-card/30 border-orange-500/30">
      <CardContent className="p-4">
        <button onClick={() => setExpanded(e => !e)} className="w-full flex items-center gap-2 mb-3 text-left">
          <Flame className="w-5 h-5 text-orange-400" />
          <div className="flex-1">
            <h3 className="text-sm font-semibold flex items-center gap-2">
              Classifica Scenari CP-SAT
              <Badge variant="outline" className="text-[10px] border-orange-500/40 text-orange-300">
                {feasible.length} fattibili / {scenarios.length} totali
              </Badge>
            </h3>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              L'ottimizzatore ha esplorato {scenarios.length} configurazioni. Clicca su una colonna per ordinare, seleziona uno scenario per confrontare.
            </p>
          </div>
          {bestScenario && (
            <div className="text-right mr-2">
              <div className="text-[10px] text-muted-foreground">Migliore (score)</div>
              <div className="text-xs font-bold text-orange-400 flex items-center gap-1 justify-end">
                <Trophy className="w-3 h-3" /> #{bestScenario.scenarioNum} · €{bestScenario.totalCost?.toLocaleString("it-IT", { maximumFractionDigits: 0 })}
              </div>
            </div>
          )}
          {expanded ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
        </button>

        <AnimatePresence initial={false}>
          {expanded && (
            <motion.div
              initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="overflow-hidden"
            >
              <div className="overflow-x-auto rounded-lg border border-orange-500/20 bg-background/40">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-[10px] uppercase tracking-wider text-orange-300/70 border-b border-orange-500/20 bg-orange-500/5">
                      {([
                        ["rank", "#", "Ranking (score asc)"],
                        ["duties", "Turni", "Numero totale turni guida"],
                        ["interi", "Interi", "Turni interi"],
                        ["semiunici", "SemiU", "Turni semiunici"],
                        ["spezzati", "Spezz", "Turni spezzati"],
                        ["supplementi", "Suppl", "Supplementi (straordinari)"],
                        ["totalWorkH", "Lavoro h", "Ore lavoro totali"],
                        ["totalNastroH", "Nastro h", "Ore nastro totali"],
                        ["totalIdleH", "Vuoti h", "Ore 'vuote' (nastro - lavoro)"],
                        ["vuotiSignificativi", "N vuoti", "Turni con > 60' di vuoto"],
                        ["totalCost", "€ Costo", "Costo giornaliero"],
                        ["bdsViolations", "BDS", "Violazioni normative"],
                        ["score", "Score", "Punteggio globale (min = meglio)"],
                        ["elapsed", "Sec", "Tempo risoluzione scenario"],
                      ] as [SortKey, string, string][]).map(([k, label, title]) => (
                        <th key={k}
                          title={title}
                          onClick={() => toggleSort(k)}
                          className="px-2 py-2 text-center font-semibold cursor-pointer select-none hover:bg-orange-500/10 transition-colors whitespace-nowrap">
                          <span className="inline-flex items-center gap-0.5">
                            {label}
                            {sortKey === k && (
                              <span className="text-orange-400">
                                {sortDir === "asc" ? "▲" : "▼"}
                              </span>
                            )}
                          </span>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sorted.map((s, i) => {
                      const isBest = s.isBest;
                      const isHi = highlight === s.scenarioNum;
                      const medals: string[] = [];
                      if (s === (best as any).cheapest) medals.push("💰");
                      if (s === (best as any).fewestDuties) medals.push("📉");
                      if (s === (best as any).leastIdle) medals.push("⚡");
                      if (s === (best as any).leastViolations && s.bdsViolations === 0) medals.push("✅");
                      if (s === (best as any).fewestSupplementi && (s.supplementi ?? 0) === 0) medals.push("🧱");
                      return (
                        <tr key={s.idx}
                          onClick={() => setHighlight(h => h === s.scenarioNum ? null : s.scenarioNum)}
                          className={`border-b border-orange-500/10 cursor-pointer transition-colors ${
                            isBest
                              ? "bg-orange-500/10 hover:bg-orange-500/15"
                              : isHi
                              ? "bg-amber-500/10"
                              : i % 2 === 0 ? "hover:bg-orange-500/5" : "bg-orange-500/[0.02] hover:bg-orange-500/5"
                          }`}>
                          <td className="px-2 py-1.5 text-center font-mono">
                            <span className="inline-flex items-center gap-1">
                              {isBest && <Trophy className="w-3 h-3 text-orange-400" />}
                              {s.isPolish && <Wand2 className="w-3 h-3 text-amber-400" />}
                              <span className={isBest ? "text-orange-300 font-bold" : "text-muted-foreground"}>
                                #{s.rank ?? "?"}
                              </span>
                              {medals.length > 0 && (
                                <span className="text-[9px]" title={medals.map(m => ({ "💰": "Più economico", "📉": "Meno turni", "⚡": "Meno vuoti", "✅": "0 violazioni BDS", "🧱": "Senza supplementi" }[m as string] || "")).filter(Boolean).join(" · ")}>
                                  {medals.join("")}
                                </span>
                              )}
                            </span>
                            <div className="text-[9px] text-muted-foreground/60 font-normal truncate max-w-[80px]" title={s.params?.strategyLabel || ""}>
                              {s.isPolish ? "🪄 Rifinitura" : (s.params?.strategyLabel || `sc. ${s.scenarioNum}`)}
                            </div>
                          </td>
                          <td className="px-2 py-1.5 text-center font-mono font-semibold text-foreground">{s.duties ?? "–"}</td>
                          <td className="px-2 py-1.5 text-center font-mono text-muted-foreground">{s.interi ?? "–"}</td>
                          <td className="px-2 py-1.5 text-center font-mono">
                            <span className={s.semiCompliant ? "text-amber-300" : "text-red-400 font-semibold"}>{s.semiunici ?? "–"}</span>
                            <span className="text-[9px] text-muted-foreground/60 ml-0.5">({s.semiPct ?? 0}%)</span>
                          </td>
                          <td className="px-2 py-1.5 text-center font-mono">
                            <span className={s.spezCompliant ? "text-amber-300" : "text-red-400 font-semibold"}>{s.spezzati ?? "–"}</span>
                            <span className="text-[9px] text-muted-foreground/60 ml-0.5">({s.spezPct ?? 0}%)</span>
                          </td>
                          <td className="px-2 py-1.5 text-center font-mono">
                            <span className={(s.supplementi ?? 0) === 0 ? "text-amber-300" : "text-orange-400"}>{s.supplementi ?? "–"}</span>
                          </td>
                          <td className="px-2 py-1.5 text-center font-mono text-foreground/80">{s.totalWorkH?.toFixed(1) ?? "–"}</td>
                          <td className="px-2 py-1.5 text-center font-mono text-foreground/80">{s.totalNastroH?.toFixed(1) ?? "–"}</td>
                          <td className="px-2 py-1.5 text-center font-mono text-orange-400/80">{s.totalIdleH?.toFixed(1) ?? "–"}</td>
                          <td className="px-2 py-1.5 text-center font-mono text-orange-400/80">{s.vuotiSignificativi ?? "–"}</td>
                          <td className="px-2 py-1.5 text-center font-mono font-semibold text-amber-300">
                            {s.totalCost != null ? `€${s.totalCost.toLocaleString("it-IT", { maximumFractionDigits: 0 })}` : "–"}
                          </td>
                          <td className="px-2 py-1.5 text-center font-mono">
                            <span className={(s.bdsViolations ?? 0) === 0 ? "text-amber-300" : "text-red-400 font-semibold"}>
                              {s.bdsViolations ?? 0}
                            </span>
                          </td>
                          <td className="px-2 py-1.5 text-center font-mono font-semibold text-foreground">
                            {s.score != null ? s.score.toLocaleString("it-IT", { maximumFractionDigits: 0 }) : "–"}
                          </td>
                          <td className="px-2 py-1.5 text-center font-mono text-[10px] text-muted-foreground">{s.elapsed.toFixed(1)}s</td>
                        </tr>
                      );
                    })}
                    {infeasible.length > 0 && (
                      <tr className="bg-muted/10">
                        <td colSpan={14} className="px-2 py-1.5 text-center text-[10px] text-muted-foreground italic border-t border-orange-500/20">
                          {infeasible.length} scenar{infeasible.length === 1 ? "io" : "i"} non fattibil{infeasible.length === 1 ? "e" : "i"} ({infeasible.map(s => `#${s.scenarioNum}`).join(", ")})
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              {/* Legenda medaglie */}
              <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-muted-foreground px-1">
                <span className="inline-flex items-center gap-1"><Trophy className="w-3 h-3 text-orange-400" /> Best score (default)</span>
                <span>💰 Più economico</span>
                <span>📉 Meno turni</span>
                <span>⚡ Meno vuoti</span>
                <span>✅ 0 violazioni BDS</span>
                <span>🧱 0 supplementi</span>
              </div>

              {/* Scheda dettaglio highlighted */}
              {highlight != null && (() => {
                const s = scenarios.find(x => x.scenarioNum === highlight);
                if (!s) return null;
                return (
                  <div className="mt-3 p-3 rounded-lg border border-amber-500/30 bg-amber-500/5">
                    <div className="flex items-center gap-2 mb-2">
                      <ListOrdered className="w-4 h-4 text-amber-300" />
                      <span className="text-xs font-semibold">Scenario #{s.scenarioNum} — dettagli</span>
                      <span className="text-[10px] text-muted-foreground">seed {s.params?.seed} · noise {s.params?.noise} · lin {s.params?.linLevel} · {s.params?.nWorkers}w</span>
                    </div>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-[11px]">
                      <MiniStat label="Costo/turno" value={s.costPerDuty != null ? `€${s.costPerDuty.toFixed(0)}` : "–"} />
                      <MiniStat label="Guida tot" value={s.totalDrivingH != null ? `${s.totalDrivingH}h` : "–"} />
                      <MiniStat label="Lavoro/turno" value={s.avgWorkMin != null ? formatDuration(s.avgWorkMin) : "–"} />
                      <MiniStat label="Nastro/turno" value={s.avgNastroMin != null ? formatDuration(s.avgNastroMin) : "–"} />
                      <MiniStat label="Interruzione tot" value={s.totalInterruptionH != null ? `${s.totalInterruptionH}h` : "–"} />
                      <MiniStat label="Trasferimenti tot" value={s.totalTransferH != null ? `${s.totalTransferH}h` : "–"} />
                      <MiniStat label="Vuoto medio" value={s.avgIdleMin != null ? `${s.avgIdleMin}'` : "–"} />
                      <MiniStat label="Obj CP-SAT" value={s.obj?.toLocaleString("it-IT") ?? "–"} />
                    </div>
                  </div>
                );
              })()}
            </motion.div>
          )}
        </AnimatePresence>
      </CardContent>
    </Card>
  );
}

function MiniStat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="px-2 py-1 rounded bg-background/40 border border-border/30">
      <div className="text-[9px] text-muted-foreground uppercase tracking-wide">{label}</div>
      <div className="text-xs font-mono font-semibold text-foreground">{value}</div>
    </div>
  );
}


/* ═══════════════════════════════════════════════════════════════
 *  OPTIMIZATION ANALYSIS CARD
 *  Interpretazione in italiano del processo di ottimizzazione
 * ═══════════════════════════════════════════════════════════════ */

function OptimizationAnalysisCard({ analysis }: { analysis: OptimizationAnalysis }) {
  const [expanded, setExpanded] = useState(true);

  // Interpretazione qualitativa del score spread
  const spread = analysis.scoreSpreadPct;
  const spreadInterpretation =
    spread < 3 ? { label: "convergente", color: "text-amber-300", desc: "Le strategie convergono: la soluzione e' robusta." }
    : spread < 10 ? { label: "moderata", color: "text-amber-400", desc: "Variabilita' normale tra strategie." }
    : { label: "ampia", color: "text-orange-400", desc: "Strategie molto diverse tra loro: il portfolio ha scoperto alternative significative." };

  const coveragePct = Math.round(analysis.strategiesExplored / analysis.totalStrategiesAvailable * 100);

  // Narrativa dinamica
  const narrative = useMemo(() => {
    const parts: string[] = [];
    parts.push(
      `Ho esplorato ${analysis.nScenariosRun} configurazioni diverse dell'ottimizzatore CP-SAT in ${analysis.totalElapsedSec}s, testando ${analysis.strategiesExplored} strategie su ${analysis.totalStrategiesAvailable} disponibili.`
    );
    parts.push(
      `La strategia vincente e' "${analysis.bestStrategyLabel}" (${analysis.bestStrategyDesc.toLowerCase()}).`
    );
    if (analysis.polishImproved) {
      parts.push(
        `La fase di rifinitura finale ha migliorato la soluzione di ${analysis.polishDeltaPct.toFixed(1)}% (-${analysis.polishDeltaScore.toFixed(0)} punti score).`
      );
    } else if (analysis.polishElapsedSec > 0) {
      parts.push(
        `La rifinitura finale non ha trovato miglioramenti: la soluzione era gia' all'ottimo della strategia vincente.`
      );
    }
    if (analysis.nInfeasible > 0) {
      parts.push(`${analysis.nInfeasible} scenari non fattibili sono stati scartati.`);
    }
    return parts.join(" ");
  }, [analysis]);

  return (
    <Card className="bg-gradient-to-br from-amber-950/30 via-orange-950/20 to-card/30 border-amber-500/30">
      <CardContent className="p-4">
        <button onClick={() => setExpanded(e => !e)} className="w-full flex items-start gap-3 text-left">
          <div className="w-9 h-9 shrink-0 rounded-lg bg-gradient-to-br from-amber-500/30 to-orange-500/30 border border-amber-500/40 flex items-center justify-center">
            <Brain className="w-5 h-5 text-amber-300" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-semibold flex items-center gap-2 flex-wrap">
              Analisi Ottimizzazione
              <Badge variant="outline" className="text-[10px] border-amber-500/40 text-amber-300">
                <Sparkles className="w-2.5 h-2.5 mr-1" /> {analysis.bestStrategyLabel}
              </Badge>
              {analysis.polishImproved && (
                <Badge variant="outline" className="text-[10px] border-orange-500/40 text-orange-300">
                  <Wand2 className="w-2.5 h-2.5 mr-1" /> Rifinitura -{analysis.polishDeltaPct.toFixed(1)}%
                </Badge>
              )}
            </h3>
            <p className="text-[11px] text-muted-foreground mt-1 leading-relaxed">{narrative}</p>
          </div>
          {expanded ? <ChevronUp className="w-4 h-4 text-muted-foreground shrink-0" /> : <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />}
        </button>

        <AnimatePresence initial={false}>
          {expanded && (
            <motion.div
              initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="overflow-hidden"
            >
              <div className="mt-4 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
                <AnalysisMetric
                  icon={<ListOrdered className="w-4 h-4" />}
                  label="Scenari esplorati"
                  value={`${analysis.nScenariosRun}/${analysis.nScenariosRequested}`}
                  sub={`${analysis.nFeasible} fattibili · ${analysis.nInfeasible} scartati`}
                  tone="orange"
                />
                <AnalysisMetric
                  icon={<Target className="w-4 h-4" />}
                  label="Strategie testate"
                  value={`${analysis.strategiesExplored}/${analysis.totalStrategiesAvailable}`}
                  sub={`copertura ${coveragePct}% del portfolio`}
                  tone="amber"
                />
                <AnalysisMetric
                  icon={<Gauge className="w-4 h-4" />}
                  label="Variabilita' esplorata"
                  value={`${spread.toFixed(1)}%`}
                  sub={spreadInterpretation.desc}
                  toneClass={spreadInterpretation.color}
                />
                <AnalysisMetric
                  icon={<Activity className="w-4 h-4" />}
                  label="Tempo totale"
                  value={`${analysis.totalElapsedSec}s`}
                  sub={`${analysis.scenarioElapsedSec}s scenari + ${analysis.polishElapsedSec}s rifinitura`}
                  tone="orange"
                />
              </div>

              {/* Strategie a confronto */}
              <div className="mt-4">
                <h4 className="text-[11px] font-semibold uppercase tracking-wider text-amber-300/80 mb-2 flex items-center gap-1.5">
                  <Flame className="w-3.5 h-3.5" /> Portfolio Strategie (ordinate per score)
                </h4>
                <div className="space-y-1.5">
                  {analysis.strategySummary.map((strat) => {
                    const barWidth = analysis.strategySummary.length > 1
                      ? Math.max(8, 100 - ((strat.bestScore - analysis.strategySummary[0].bestScore) / Math.max(analysis.strategySummary[analysis.strategySummary.length - 1].bestScore - analysis.strategySummary[0].bestScore, 1)) * 92)
                      : 100;
                    return (
                      <div key={strat.key}
                        className={`rounded-md border p-2 transition-colors ${
                          strat.isWinner
                            ? "border-orange-500/40 bg-gradient-to-r from-orange-500/10 to-amber-500/5"
                            : "border-border/30 bg-background/30"
                        }`}>
                        <div className="flex items-center gap-2 mb-1">
                          {strat.isWinner
                            ? <Trophy className="w-3.5 h-3.5 text-orange-400 shrink-0" />
                            : <span className="w-3.5 h-3.5 shrink-0" />}
                          <span className={`text-xs font-semibold ${strat.isWinner ? "text-orange-300" : "text-foreground/90"}`}>
                            {strat.label}
                          </span>
                          <span className="text-[10px] text-muted-foreground flex-1 truncate">— {strat.desc}</span>
                          <div className="flex items-center gap-2 text-[10px] font-mono shrink-0">
                            <span className="text-muted-foreground">{strat.nRuns} run</span>
                            {strat.bestDuties != null && <span className="text-foreground/80">{strat.bestDuties} turni</span>}
                            {strat.bestCost != null && <span className="text-amber-300">€{strat.bestCost.toLocaleString("it-IT", { maximumFractionDigits: 0 })}</span>}
                            <span className={strat.isWinner ? "text-orange-400 font-semibold" : "text-muted-foreground"}>
                              score {strat.bestScore.toLocaleString("it-IT", { maximumFractionDigits: 0 })}
                            </span>
                          </div>
                        </div>
                        <div className="h-1 rounded-full bg-background/60 overflow-hidden">
                          <div
                            className={`h-full rounded-full transition-all ${strat.isWinner ? "bg-gradient-to-r from-orange-500 to-red-500" : "bg-amber-500/40"}`}
                            style={{ width: `${barWidth}%` }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Spiegazione tecnica */}
              <div className="mt-4 p-3 rounded-lg border border-amber-500/20 bg-amber-500/5">
                <div className="flex items-start gap-2">
                  <Lightbulb className="w-4 h-4 text-amber-300 shrink-0 mt-0.5" />
                  <div className="text-[11px] text-muted-foreground leading-relaxed">
                    <span className="font-semibold text-amber-300">Come funziona: </span>
                    L'ottimizzatore costruisce un <span className="font-mono text-foreground/80">modello CP-SAT</span> con {analysis.nSegments} segmenti e {analysis.nFeasiblePairs.toLocaleString("it-IT")} coppie candidate.
                    Poi esegue {analysis.nScenariosRequested} scenari in parallelo, ciascuno con pesi differenti
                    {" "}(seed random, perturbazione costi, strategia obiettivo) per esplorare diverse zone dello spazio soluzioni.
                    Dopo aver individuato la strategia migliore, una fase di <span className="font-mono text-foreground/80">rifinitura</span>{" "}
                    riesegue la soluzione vincente con budget triplo e noise zero per convergere verso l'ottimo locale.
                    Intensita corrente: <span className="font-mono text-amber-300">{analysis.intensity}</span>
                    ({analysis.intensity === 1 ? "rapida" : analysis.intensity === 3 ? "approfondita" : "standard"}) · budget totale: <span className="font-mono text-amber-300">{analysis.timeBudgetSec}s</span>.
                  </div>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </CardContent>
    </Card>
  );
}

function AnalysisMetric({
  icon, label, value, sub, tone, toneClass,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub?: string;
  tone?: "orange" | "amber" | "red";
  toneClass?: string;
}) {
  const toneMap = {
    orange: "text-orange-300",
    amber: "text-amber-300",
    red: "text-red-400",
  };
  const valueClass = toneClass ?? (tone ? toneMap[tone] : "text-foreground");
  return (
    <div className="rounded-lg border border-border/40 bg-background/40 p-2.5">
      <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground uppercase tracking-wider">
        <span className={tone ? toneMap[tone] : "text-muted-foreground"}>{icon}</span>
        {label}
      </div>
      <div className={`text-lg font-bold font-mono mt-0.5 ${valueClass}`}>{value}</div>
      {sub && <div className="text-[10px] text-muted-foreground mt-0.5 leading-tight">{sub}</div>}
    </div>
  );
}
