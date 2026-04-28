/**
 * DriverWorkspace — Area di Lavoro Turni Guida (interno fucina, step 7)
 *
 * Sorella del VehicleWorkspace ma per i Turni Guida (CSP autisti).
 * Pattern:
 *   ┌──────────────────────────────────────────────────────────┐
 *   │  Toolbar: solver mode + Riottimizza + Config CSP + Save  │
 *   ├──────────────────────────────────────────────────────────┤
 *   │  Summary cards (autisti, ore, %, costo, conformità BDS)  │
 *   ├──────────────────────────────────────────────────────────┤
 *   │  Progress panel (durante CP-SAT)                         │
 *   │  Gantt interattivo turni guida                           │
 *   └──────────────────────────────────────────────────────────┘
 *
 * Espone tutti i 6 nuovi parametri `bds.optimizer.*` introdotti in:
 *   FIX-CSP-1: weightDutyCount (default 20000)
 *   FIX-CSP-2: scorePerDuty (default 100)
 *   HARD: maxCompanyCars (cumulative cap), minWorkPerDuty (saturazione)
 *   SOFT: weightIdlePenalty + idlePenaltyMaxMin (penalizza idle)
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Users, Clock, Timer, Coffee, Repeat, Car, DollarSign, Shield,
  AlertTriangle, Zap, Settings, Play, Save, RotateCcw, Brain, Loader2,
  Download, FileText, FileSpreadsheet, Printer, ChevronDown, Undo2, Redo2, Layers,
} from "lucide-react";
import { toast } from "sonner";
import { getApiBase } from "@/lib/api";
import { useCrewOptimization, type OperatorConfig } from "@/hooks/use-crew-optimization";
import { OperatorConfigPanel } from "@/components/OperatorConfigPanel";
import { OptimizationProgressPanel } from "@/components/OptimizationProgress";
import InteractiveGantt, { type GanttChange, type GanttBar } from "@/components/InteractiveGantt";
import { SummaryCard } from "@/pages/driver-shifts/components";
import { formatDuration } from "@/pages/driver-shifts/constants";
import {
  driverShiftsToRows,
  driverShiftsToBars,
  driverShiftsToTripBars,
  driverShiftsBoundsHours,
  applyDriverTripChange,
  suggestDriversForTrip,
  recomputeSummary,
  diffSummary,
} from "@/pages/driver-shifts/gantt-adapters";
import {
  exportDriverShiftsToPrint,
  exportDriverShiftsToCsv,
  triggerDownload,
} from "@/pages/fucina/DriverShiftsPrintExport";
import type { DriverShiftsResult, DriverShiftSummary } from "@/pages/driver-shifts/types";

interface DriverWorkspaceProps {
  /** ID dello scenario turni macchina (input al solver autisti) */
  vehicleScenarioId: string;
  /** Risultato precaricato (es. da DSS salvato), opzionale */
  initialResult?: DriverShiftsResult | null;
  /** Etichetta GTFS/scenario per display */
  scenarioLabel?: string;
}

/* Default config con i nuovi parametri optimizer attivi */
const DEFAULT_CONFIG: OperatorConfig = {
  solverIntensity: 2,
  maxRounds: 5,
  weights: {
    minDrivers: 8, workBalance: 6, minCambi: 5,
    preferIntero: 7, minSupplementi: 4, qualityTarget: 5,
  },
  bds: {
    optimizer: {
      minWorkPerDuty: 360,
      maxCompanyCars: 5,
      weightDutyCount: 20000,
      weightIdlePenalty: 30,
      idlePenaltyMaxMin: 60,
      scorePerDuty: 100,
    },
  },
};

export default function DriverWorkspace({
  vehicleScenarioId,
  initialResult,
  scenarioLabel,
}: DriverWorkspaceProps) {
  const [result, setResult] = useState<DriverShiftsResult | null>(initialResult ?? null);
  const [solverMode, setSolverMode] = useState<"greedy" | "cpsat">("cpsat");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [configOpen, setConfigOpen] = useState(false);
  const [operatorConfig, setOperatorConfig] = useState<OperatorConfig>(DEFAULT_CONFIG);
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [dssName, setDssName] = useState("");
  const [savingDss, setSavingDss] = useState(false);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  /* ── Modalità visualizzazione Gantt ──
   *  exploded = 1 bar per corsa (drag-and-drop); aggregated = 1 bar per ripresa (read-only) */
  const [ganttMode, setGanttMode] = useState<"exploded" | "aggregated">("exploded");
  /* ── History undo/redo per modifiche al risultato ── */
  const [history, setHistory] = useState<DriverShiftsResult[]>([]);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const [modifiedCount, setModifiedCount] = useState(0);

  /* ── Baseline KPI per modalità what-if ── */
  const baselineSummaryRef = useRef<DriverShiftSummary | null>(
    initialResult?.summary ? { ...initialResult.summary } : null,
  );

  const liveSummary = useMemo(() => {
    if (!result || !baselineSummaryRef.current) return result?.summary;
    return recomputeSummary(result.driverShifts, baselineSummaryRef.current);
  }, [result]);

  const summaryDelta = useMemo(() => {
    if (!liveSummary || !baselineSummaryRef.current) return null;
    return diffSummary(liveSummary, baselineSummaryRef.current);
  }, [liveSummary]);

  // ── Highlight target durante drag (#2) ──
  const [rowHighlights, setRowHighlights] = useState<Record<string, string> | undefined>(undefined);

  const handleBarDragStart = useCallback((bar: GanttBar) => {
    if (!result) return;
    const meta: any = bar.meta || {};
    if (meta.type !== "trip" || !meta.tripId) return;
    const suggs = suggestDriversForTrip(result.driverShifts, meta.tripId);
    const map: Record<string, string> = {};
    suggs.slice(0, 3).forEach(s => { map[s.driverId] = "rgba(16, 185, 129, 0.18)"; });
    suggs.slice(3, 8).forEach(s => { map[s.driverId] = "rgba(245, 158, 11, 0.14)"; });
    if (meta.driverId && !map[meta.driverId]) {
      map[meta.driverId] = "rgba(99, 102, 241, 0.12)";
    }
    setRowHighlights(map);
  }, [result]);

  const handleBarDragEnd = useCallback(() => {
    setRowHighlights(undefined);
  }, []);

  const cpsat = useCrewOptimization();

  // Ricezione risultati CP-SAT
  useEffect(() => {
    if (cpsat.state === "completed" && cpsat.result) {
      setResult(cpsat.result as any);
      baselineSummaryRef.current = (cpsat.result as any)?.summary
        ? { ...(cpsat.result as any).summary }
        : null;
      setLoading(false);
      setError(null);
      setHistory([]); setHistoryIdx(-1); setModifiedCount(0);
      toast.success("Ottimizzazione completata", {
        description: `${(cpsat.result as any).summary?.totalDriverShifts ?? "?"} turni guida generati`,
      });
    } else if (cpsat.state === "failed") {
      setError(cpsat.error || "Errore ottimizzazione CP-SAT");
      setLoading(false);
      toast.error("Ottimizzazione fallita", { description: cpsat.error ?? undefined });
    }
  }, [cpsat.state, cpsat.result, cpsat.error]);

  // Lancia ottimizzazione greedy
  const launchGreedy = useCallback(() => {
    if (!vehicleScenarioId) return;
    setLoading(true); setError(null); setResult(null);
    fetch(`${getApiBase()}/api/driver-shifts/${vehicleScenarioId}`)
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(data => {
        setResult(data);
        baselineSummaryRef.current = data?.summary ? { ...data.summary } : null;
        toast.success("Turni guida (greedy) generati");
      })
      .catch(e => { setError(e.message); toast.error("Errore greedy", { description: e.message }); })
      .finally(() => setLoading(false));
  }, [vehicleScenarioId]);

  // Lancia ottimizzazione CP-SAT (con i nuovi optimizer overrides)
  const launchCPSAT = useCallback(() => {
    if (!vehicleScenarioId) return;
    cpsat.reset();
    setResult(null);
    setError(null);
    const intensity = operatorConfig.solverIntensity ?? 2;
    const timeLimit =
      intensity === 1 ? 90 :
      intensity === 3 ? 480 :
      intensity === 4 ? 900 : 240;
    cpsat.start(vehicleScenarioId, timeLimit, operatorConfig);
    toast.info(`CP-SAT avviato (timeLimit ${timeLimit}s)`, {
      description: "I parametri optimizer (saturazione · cap vetture · idle) sono attivi",
    });
  }, [vehicleScenarioId, cpsat, operatorConfig]);

  const runOptimization = useCallback(() => {
    if (solverMode === "cpsat") launchCPSAT();
    else launchGreedy();
  }, [solverMode, launchCPSAT, launchGreedy]);

  // Salva DSS
  const saveDss = useCallback(async () => {
    if (!vehicleScenarioId || !result || !dssName.trim()) return;
    setSavingDss(true);
    try {
      const resp = await fetch(`${getApiBase()}/api/driver-shifts/${vehicleScenarioId}/scenarios`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: dssName.trim(),
          result,
          config: { ...operatorConfig, solverMode },
        }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      setShowSaveDialog(false); setDssName("");
      toast.success("Scenario turni guida salvato");
    } catch (e: any) {
      toast.error("Errore salvataggio", { description: e.message });
    } finally {
      setSavingDss(false);
    }
  }, [vehicleScenarioId, result, dssName, operatorConfig, solverMode]);

  /* ── Export handlers ─────────────────────────────────── */
  const handleExportPrint = useCallback(() => {
    if (!result) return;
    setExportMenuOpen(false);
    exportDriverShiftsToPrint(result, {
      scenarioName: scenarioLabel,
      columnsPerPage: 2,
      orientation: "landscape",
    });
    toast.success("Stampa A4 generata", { description: "Si è aperta la finestra di stampa" });
  }, [result, scenarioLabel]);

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

  // Gantt rows/bars
  const ganttRows = useMemo(() => result ? driverShiftsToRows(result.driverShifts) : [], [result]);
  const ganttBars = useMemo(() => {
    if (!result) return [];
    return ganttMode === "exploded"
      ? driverShiftsToTripBars(result.driverShifts)
      : driverShiftsToBars(result.driverShifts);
  }, [result, ganttMode]);
  const ganttBounds = useMemo(() => result ? driverShiftsBoundsHours(result.driverShifts) : { min: 4, max: 25 }, [result]);

  /* ── History + drag handler ─────────────────────────── */
  const pushHistory = useCallback((newRes: DriverShiftsResult) => {
    setHistory(prev => {
      // Tronca eventuali "future" se siamo in mezzo
      const truncated = historyIdx >= 0 ? prev.slice(0, historyIdx + 1) : prev;
      // Capacità: max 30
      const next = [...truncated, newRes].slice(-30);
      setHistoryIdx(next.length - 1);
      return next;
    });
    setModifiedCount(c => c + 1);
  }, [historyIdx]);

  const handleBarChange = useCallback((change: GanttChange) => {
    if (!result) return;
    // Ignora bar non-trip (locked)
    const bar = ganttBars.find(b => b.id === change.barId);
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
    const desc = reassigned && shifted
      ? `${movedTrip?.routeName} ${change.fromRowId}→${change.toRowId} (${change.newStartMin - change.oldStartMin > 0 ? "+" : ""}${change.newStartMin - change.oldStartMin}′)`
      : reassigned
        ? `${movedTrip?.routeName} ${change.fromRowId}→${change.toRowId}`
        : `${movedTrip?.routeName} ${change.newStartMin - change.oldStartMin > 0 ? "+" : ""}${change.newStartMin - change.oldStartMin}′`;

    const newResult: DriverShiftsResult = { ...result, driverShifts: newShifts };
    setResult(newResult);
    pushHistory(newResult);
    toast.success("Corsa spostata", { description: desc });
  }, [result, ganttBars, pushHistory]);

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

  // Keyboard shortcuts: Cmd/Ctrl+Z = undo, Cmd/Ctrl+Shift+Z = redo
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

  const optimizerCfg = operatorConfig.bds?.optimizer;

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* ── Toolbar ───────────────────────────────────── */}
      <div className="shrink-0 px-4 py-2 border-b border-purple-500/15 bg-purple-950/15 flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <Users className="w-4 h-4 text-purple-300/70" />
          <span className="text-xs font-medium text-purple-200">Solver:</span>
          <div className="flex rounded-md overflow-hidden border border-purple-500/30">
            <button
              onClick={() => setSolverMode("greedy")}
              className={`px-2.5 py-1 text-[11px] font-medium transition ${
                solverMode === "greedy"
                  ? "bg-purple-500/30 text-white"
                  : "text-purple-300/60 hover:bg-purple-500/10"
              }`}
            >
              ⚡ Greedy
            </button>
            <button
              onClick={() => setSolverMode("cpsat")}
              className={`px-2.5 py-1 text-[11px] font-medium transition flex items-center gap-1 ${
                solverMode === "cpsat"
                  ? "bg-purple-500/30 text-white"
                  : "text-purple-300/60 hover:bg-purple-500/10"
              }`}
            >
              <Brain className="w-3 h-3" /> CP-SAT
            </button>
          </div>
          {scenarioLabel && (
            <span className="text-[10px] text-purple-300/40 font-mono px-1.5 py-0.5 bg-purple-500/5 rounded border border-purple-500/10 ml-1 truncate max-w-[200px]">
              {scenarioLabel}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {/* Quick view dei parametri optimizer attivi */}
          {solverMode === "cpsat" && optimizerCfg && (
            <div className="hidden lg:flex items-center gap-1.5 text-[10px] text-purple-300/60 px-2 py-1 rounded border border-purple-500/15 bg-purple-500/5">
              <span title="Min lavoro/turno">⏱ {optimizerCfg.minWorkPerDuty ?? 360}min</span>
              <span className="text-purple-500/30">·</span>
              <span title="Max vetture aziendali">🚗 ≤{optimizerCfg.maxCompanyCars ?? 5}</span>
              <span className="text-purple-500/30">·</span>
              <span title="Peso N turni">N·{optimizerCfg.weightDutyCount ?? 20000}</span>
              <span className="text-purple-500/30">·</span>
              <span title="Score per duty">+{optimizerCfg.scorePerDuty ?? 100}/duty</span>
            </div>
          )}
          <button
            onClick={() => setConfigOpen(true)}
            className="flex items-center gap-1.5 text-[11px] text-purple-300 px-2.5 py-1 rounded border border-purple-500/30 bg-purple-500/8 hover:bg-purple-500/15 transition"
          >
            <Settings className="w-3 h-3" /> Config CSP
          </button>
          <button
            onClick={runOptimization}
            disabled={loading || cpsat.state === "starting" || cpsat.state === "running"}
            className="flex items-center gap-1.5 text-[11px] font-medium text-white px-3 py-1.5 rounded-lg bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-500 hover:to-pink-500 disabled:opacity-50 disabled:cursor-not-allowed transition"
          >
            {(loading || cpsat.state === "starting" || cpsat.state === "running") ? (
              <><Loader2 className="w-3.5 h-3.5 animate-spin" /> In corso…</>
            ) : result ? (
              <><RotateCcw className="w-3.5 h-3.5" /> Riottimizza</>
            ) : (
              <><Play className="w-3.5 h-3.5" /> Genera Turni Guida</>
            )}
          </button>
          {result && (
            <button
              onClick={() => setShowSaveDialog(true)}
              className="flex items-center gap-1.5 text-[11px] text-emerald-300 px-2.5 py-1 rounded border border-emerald-500/30 bg-emerald-500/8 hover:bg-emerald-500/15 transition"
            >
              <Save className="w-3 h-3" /> Salva DSS
            </button>
          )}
          {result && (
            <div className="relative">
              <button
                onClick={() => setExportMenuOpen(v => !v)}
                onBlur={() => setTimeout(() => setExportMenuOpen(false), 150)}
                className="flex items-center gap-1.5 text-[11px] text-blue-300 px-2.5 py-1 rounded border border-blue-500/30 bg-blue-500/8 hover:bg-blue-500/15 transition"
              >
                <Download className="w-3 h-3" /> Esporta
                <ChevronDown className={`w-3 h-3 transition-transform ${exportMenuOpen ? "rotate-180" : ""}`} />
              </button>
              {exportMenuOpen && (
                <div className="absolute right-0 top-full mt-1 z-30 bg-zinc-900 border border-blue-500/30 rounded-lg shadow-xl py-1 min-w-[200px]">
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
        </div>
      </div>

      {/* ── Body scrollable ───────────────────────────── */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {/* Progress panel CP-SAT */}
        {solverMode === "cpsat" && (cpsat.state === "starting" || cpsat.state === "running" || cpsat.state === "stopped" || (cpsat.state === "failed" && !result)) && (
          <OptimizationProgressPanel
            state={cpsat.state}
            progress={cpsat.progress}
            progressHistory={cpsat.progressHistory}
            elapsedSec={cpsat.elapsedSec}
            onStop={cpsat.stop}
          />
        )}

        {/* Error banner */}
        {error && cpsat.state !== "running" && cpsat.state !== "starting" && (
          <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3 text-sm text-red-400 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <div>{error}</div>
          </div>
        )}

        {/* Idle placeholder */}
        {!result && !loading && cpsat.state !== "running" && cpsat.state !== "starting" && (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <div className="w-16 h-16 rounded-full bg-purple-500/10 flex items-center justify-center mb-4">
              <Users className="w-8 h-8 text-purple-300/60" />
            </div>
            <h3 className="text-lg font-semibold mb-2 text-purple-200">Genera Turni Guida</h3>
            <p className="text-sm text-muted-foreground max-w-md">
              Clicca <strong>Genera Turni Guida</strong> per calcolare i turni autisti a partire dai turni macchina dello scenario.
              I parametri di <em>saturazione</em>, <em>cap vetture aziendali</em> e <em>minimizzazione N turni</em> sono modificabili
              in <strong>Config CSP</strong>.
            </p>
          </div>
        )}

        {/* Summary cards */}
        {result && result.summary && (
          <div>
            <div className="flex items-center gap-2 mb-2">
              <div className="h-6 w-1 rounded-full bg-gradient-to-b from-purple-500 to-pink-500" />
              <h3 className="text-xs font-semibold uppercase tracking-wider text-purple-300">
                Risultato Turni Guida
              </h3>
              <span className="text-[10px] text-muted-foreground">— indicatori chiave (delta vs baseline)</span>
            </div>
            <div className="flex flex-wrap gap-3">
              <SummaryCard
                icon={<Users className="w-4 h-4" />}
                label="Autisti"
                value={String(liveSummary?.totalDriverShifts ?? "—")}
                sub={liveSummary?.byType
                  ? `${liveSummary.byType.intero ?? 0} interi · ${liveSummary.byType.semiunico ?? 0} semiunici · ${liveSummary.byType.spezzato ?? 0} spezzati`
                  : undefined}
                delta={summaryDelta && { value: summaryDelta.driversΔ, unit: "", lowerIsBetter: true }}
              />
              {liveSummary?.totalWorkHours != null && (
                <SummaryCard
                  icon={<Clock className="w-4 h-4" />}
                  label="Ore Lavoro Totali"
                  value={`${liveSummary.totalWorkHours}h`}
                  sub={liveSummary.avgWorkMin != null ? `media: ${formatDuration(liveSummary.avgWorkMin)}/turno` : undefined}
                  delta={summaryDelta && { value: summaryDelta.workHoursΔ, unit: "h", lowerIsBetter: true, format: v => `${v > 0 ? "+" : ""}${v}h` }}
                />
              )}
              {liveSummary?.totalNastroHours != null && (
                <SummaryCard
                  icon={<Timer className="w-4 h-4" />}
                  label="Ore Nastro Totali"
                  value={`${liveSummary.totalNastroHours}h`}
                  sub={liveSummary.avgNastroMin != null ? `media: ${formatDuration(liveSummary.avgNastroMin)}/turno` : undefined}
                />
              )}
              {liveSummary?.semiunicoPct != null && (
                <SummaryCard
                  icon={<Coffee className="w-4 h-4" />}
                  label="Semiunici"
                  value={`${liveSummary.semiunicoPct}%`}
                  color={liveSummary.semiunicoPct <= 12 ? "#fbbf24" : "#ef4444"}
                  sub="limite ≤ 12%"
                  delta={summaryDelta && { value: summaryDelta.semiPctΔ, unit: "%", lowerIsBetter: true, format: v => `${v > 0 ? "+" : ""}${v}%` }}
                />
              )}
              {liveSummary?.spezzatoPct != null && (
                <SummaryCard
                  icon={<Timer className="w-4 h-4" />}
                  label="Spezzati"
                  value={`${liveSummary.spezzatoPct}%`}
                  color={liveSummary.spezzatoPct <= 13 ? "#fbbf24" : "#ef4444"}
                  sub="limite ≤ 13%"
                  delta={summaryDelta && { value: summaryDelta.spezPctΔ, unit: "%", lowerIsBetter: true, format: v => `${v > 0 ? "+" : ""}${v}%` }}
                />
              )}
              {liveSummary?.byType?.supplemento ? (
                <SummaryCard
                  icon={<Zap className="w-4 h-4" />}
                  label="Supplementi"
                  value={String(liveSummary.byType.supplemento)}
                  sub="straordinari (≤ 2h30)"
                  color="#dc2626"
                />
              ) : null}
              {liveSummary?.totalCambi ? (
                <SummaryCard
                  icon={<Repeat className="w-4 h-4" />}
                  label="Cambi in Linea"
                  value={String(liveSummary.totalCambi)}
                  color="#fb923c"
                  delta={summaryDelta && { value: summaryDelta.cambiΔ, unit: "", lowerIsBetter: true }}
                />
              ) : null}
              {liveSummary?.companyCarsUsed != null && (
                <SummaryCard
                  icon={<Car className="w-4 h-4" />}
                  label="Auto Aziendali"
                  value={`${liveSummary.companyCarsUsed}/${result.companyCars ?? optimizerCfg?.maxCompanyCars ?? "?"}`}
                  sub="cap HARD attivo"
                  color={result.companyCars && liveSummary.companyCarsUsed >= result.companyCars ? "#f59e0b" : undefined}
                  delta={summaryDelta && { value: summaryDelta.carsΔ, unit: "", lowerIsBetter: true }}
                />
              )}
              {liveSummary?.totalDailyCost != null && liveSummary.totalDailyCost > 0 && (
                <SummaryCard
                  icon={<DollarSign className="w-4 h-4" />}
                  label="Costo Giornaliero"
                  value={`€${liveSummary.totalDailyCost.toLocaleString("it-IT", { maximumFractionDigits: 0 })}`}
                  sub={liveSummary.efficiency?.costPerDriver
                    ? `€${liveSummary.efficiency.costPerDriver.toFixed(0)}/autista`
                    : "ottimizzato"}
                  color="#f59e0b"
                  delta={summaryDelta && { value: summaryDelta.costΔ, unit: "€", lowerIsBetter: true, format: v => `${v > 0 ? "+" : ""}${v.toLocaleString("it-IT", { maximumFractionDigits: 0 })}€` }}
                />
              )}
              {result.unassignedBlocks > 0 && (
                <SummaryCard
                  icon={<AlertTriangle className="w-4 h-4" />}
                  label="Non assegnati"
                  value={String(result.unassignedBlocks)}
                  color="#ef4444"
                  sub="blocchi rimasti"
                />
              )}
              {/* Conformità BDS */}
              {result.driverShifts.some((s: any) => s.bdsValidation) && (() => {
                const withBds = result.driverShifts.filter((s: any) => s.bdsValidation);
                const conformi = withBds.filter((s: any) => s.bdsValidation!.valid).length;
                const pct = Math.round((conformi / withBds.length) * 100);
                return (
                  <SummaryCard
                    icon={<Shield className="w-4 h-4" />}
                    label="Conformità BDS"
                    value={`${pct}%`}
                    color={pct >= 90 ? "#fbbf24" : pct >= 70 ? "#f59e0b" : "#ef4444"}
                    sub={`${conformi}/${withBds.length} turni`}
                  />
                );
              })()}
            </div>
          </div>
        )}

        {/* Gantt */}
        {result && result.driverShifts.length > 0 && (
          <div className="rounded-lg border border-purple-500/15 bg-purple-950/10 overflow-hidden">
            <div className="px-3 py-2 border-b border-purple-500/15 flex items-center justify-between gap-2 flex-wrap">
              <div className="flex items-center gap-2">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-purple-300">Gantt Turni Guida</span>
                <span className="text-[10px] text-muted-foreground">
                  {result.driverShifts.length} turni · {ganttBars.length} elementi
                </span>
                {modifiedCount > 0 && (
                  <span className="text-[10px] font-medium text-amber-300 bg-amber-500/10 border border-amber-500/30 px-1.5 py-0.5 rounded">
                    ● {modifiedCount} modific{modifiedCount === 1 ? "a" : "he"}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {/* Toggle vista esplosa/aggregata */}
                <div className="flex rounded-md overflow-hidden border border-purple-500/30 text-[10px]">
                  <button
                    onClick={() => setGanttMode("exploded")}
                    className={`px-2 py-1 font-medium transition flex items-center gap-1 ${
                      ganttMode === "exploded"
                        ? "bg-purple-500/30 text-white"
                        : "text-purple-300/60 hover:bg-purple-500/10"
                    }`}
                    title="1 bar per corsa (drag-and-drop tra autisti)"
                  >
                    <Layers className="w-3 h-3" /> Corse
                  </button>
                  <button
                    onClick={() => setGanttMode("aggregated")}
                    className={`px-2 py-1 font-medium transition ${
                      ganttMode === "aggregated"
                        ? "bg-purple-500/30 text-white"
                        : "text-purple-300/60 hover:bg-purple-500/10"
                    }`}
                    title="1 bar per ripresa (vista compatta)"
                  >
                    Riprese
                  </button>
                </div>
                {/* Undo / Redo */}
                <button
                  onClick={handleUndo}
                  disabled={!canUndo}
                  className="flex items-center gap-1 text-[10px] text-purple-300 px-2 py-1 rounded border border-purple-500/30 bg-purple-500/8 hover:bg-purple-500/15 transition disabled:opacity-30 disabled:cursor-not-allowed"
                  title="Annulla (Ctrl+Z)"
                >
                  <Undo2 className="w-3 h-3" />
                </button>
                <button
                  onClick={handleRedo}
                  disabled={!canRedo}
                  className="flex items-center gap-1 text-[10px] text-purple-300 px-2 py-1 rounded border border-purple-500/30 bg-purple-500/8 hover:bg-purple-500/15 transition disabled:opacity-30 disabled:cursor-not-allowed"
                  title="Ripristina (Ctrl+Shift+Z)"
                >
                  <Redo2 className="w-3 h-3" />
                </button>
                <span className="text-[10px] text-purple-300/40 italic hidden xl:inline">
                  {ganttMode === "exploded" ? "Trascina le corse tra gli autisti" : "Vista compatta — passa a 'Corse' per modificare"}
                </span>
              </div>
            </div>
            <div className="p-2">
              <InteractiveGantt
                rows={ganttRows}
                bars={ganttBars}
                minHour={ganttBounds.min}
                maxHour={ganttBounds.max}
                editable={ganttMode === "exploded"}
                onBarChange={ganttMode === "exploded" ? handleBarChange : undefined}
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
                rowHighlights={ganttMode === "exploded" ? rowHighlights : undefined}
                onBarDragStart={ganttMode === "exploded" ? handleBarDragStart : undefined}
                onBarDragEnd={ganttMode === "exploded" ? handleBarDragEnd : undefined}
              />
            </div>
          </div>
        )}
      </div>

      {/* ── Operator Config Drawer (con i 6 nuovi campi optimizer) ── */}
      <OperatorConfigPanel
        isOpen={configOpen}
        onClose={() => setConfigOpen(false)}
        config={operatorConfig}
        onChange={setOperatorConfig}
      />

      {/* ── Save DSS Dialog ─────────────────────────────────── */}
      {showSaveDialog && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={() => setShowSaveDialog(false)}>
          <div className="bg-zinc-900 border border-purple-500/30 rounded-lg p-4 max-w-md w-full" onClick={e => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-purple-200 mb-3">Salva scenario turni guida</h3>
            <input
              autoFocus
              type="text"
              value={dssName}
              onChange={e => setDssName(e.target.value)}
              placeholder="Nome scenario (es. CSP saturato 360min)"
              className="w-full text-sm px-3 py-2 rounded-md bg-zinc-800 border border-zinc-700 text-white placeholder-zinc-500 focus:outline-none focus:border-purple-500"
              onKeyDown={e => { if (e.key === "Enter" && dssName.trim()) saveDss(); }}
            />
            <div className="flex justify-end gap-2 mt-3">
              <button
                onClick={() => setShowSaveDialog(false)}
                className="text-xs text-zinc-400 hover:text-white px-3 py-1.5"
              >
                Annulla
              </button>
              <button
                onClick={saveDss}
                disabled={!dssName.trim() || savingDss}
                className="text-xs font-medium text-white px-3 py-1.5 rounded-md bg-purple-600 hover:bg-purple-500 disabled:opacity-50"
              >
                {savingDss ? "Salvataggio…" : "Salva"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
