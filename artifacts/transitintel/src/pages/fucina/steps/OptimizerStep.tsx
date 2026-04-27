/**
 * Step 2 — Ottimizzazione
 *
 * Mostra i parametri solver, avvia l'ottimizzazione con un loading screen
 * animato, poi visualizza tutti i dati di analisi (senza Gantt).
 * Permette di salvare lo scenario e di passare all'Area di Lavoro.
 */
import React, { useState, useCallback, useMemo, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip as ReTooltip, ResponsiveContainer,
  CartesianGrid, RadarChart, PolarGrid, PolarAngleAxis, Radar,
} from "recharts";
import {
  Play, ArrowLeft, ChevronRight, Loader2, Save, Award, Euro, Lightbulb,
  Truck, Bus, Clock, MapPin, Home, Fuel, TrendingUp, Zap, BarChart3,
  Timer, Navigation, CheckCircle2, AlertTriangle, RefreshCw, X, Users,
  Flame, ArrowRightLeft, TrainFront, Building2, GraduationCap, Pencil,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { toast } from "sonner";
import { getApiBase } from "@/lib/api";
import type { GtfsSelection, VehicleAssignment } from "@/pages/fucina";
import type { ServiceProgramResult, VehicleType, ServiceCategory } from "@/pages/optimizer-route/types";
import {
  VEHICLE_LABELS, VEHICLE_COLORS, VEHICLE_SHORT,
  CATEGORY_COLORS, SEV_CONFIG, ymdToDisplay, minToTime,
} from "@/pages/optimizer-route/constants.tsx";
import { SummaryCard } from "@/pages/optimizer-route/components";

/* ── Input numerico riusabile per i parametri costi ── */
function CostInput({ label, value, onChange, step = 1 }: {
  label: string; value: number; onChange: (n: number) => void; step?: number;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] text-muted-foreground">{label}</span>
      <input
        type="number"
        step={step}
        value={value}
        onChange={(e) => {
          const v = parseFloat(e.target.value);
          if (!Number.isNaN(v)) onChange(v);
        }}
        className="w-full px-2 py-1.5 text-xs rounded-md bg-background/60 border border-border/40 focus:border-emerald-500/40 focus:outline-none"
      />
    </label>
  );
}

/* ── Loading messages ── */
const LOADING_MSGS = [
  "Analisi corrispondenze linee…",
  "Calcolo trasferimenti a vuoto…",
  "Costruzione grafo compatibilità…",
  "Ottimizzazione assegnazione vetture…",
  "Valutazione FIFO rifornimento…",
  "Calcolo metriche di costo…",
  "Generazione consigli advisor…",
  "Finalizzazione scenario…",
];

/* ── Animated loading screen ── */
function LoadingScreen({ solverMode, intensity }: { solverMode: "greedy" | "cpsat"; intensity: "fast" | "normal" | "deep" | "extreme" }) {
  const [msgIdx, setMsgIdx] = useState(0);
  const [progress, setProgress] = useState(0);

  const durationSec = solverMode === "cpsat"
    ? intensity === "fast" ? 60 : intensity === "extreme" ? 900 : intensity === "deep" ? 420 : 180
    : 3;

  useEffect(() => {
    const msgInterval = setInterval(() => {
      setMsgIdx(i => (i + 1) % LOADING_MSGS.length);
    }, Math.max(800, (durationSec * 1000) / LOADING_MSGS.length));

    const progressInterval = setInterval(() => {
      setProgress(p => Math.min(95, p + (100 / (durationSec * 10))));
    }, 100);

    return () => {
      clearInterval(msgInterval);
      clearInterval(progressInterval);
    };
  }, [durationSec]);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="flex flex-col items-center justify-center h-full gap-8 px-6 py-12"
    >
      {/* Ember particles */}
      <div className="relative">
        {[...Array(12)].map((_, i) => (
          <motion.div
            key={i}
            className="absolute rounded-full pointer-events-none"
            style={{
              width: 3 + Math.random() * 3,
              height: 3 + Math.random() * 3,
              left: `${40 + (Math.random() - 0.5) * 60}%`,
              bottom: "0%",
              background: `hsl(${20 + Math.random() * 30}, 100%, ${50 + Math.random() * 30}%)`,
            }}
            animate={{ y: [0, -(60 + Math.random() * 80)], opacity: [0, 0.9, 0], scale: [0, 1, 0] }}
            transition={{ duration: 1.5 + Math.random() * 2, repeat: Infinity, delay: Math.random() * 3, ease: "easeOut" }}
          />
        ))}
        <div className="relative w-20 h-20 rounded-2xl bg-orange-500/10 border border-orange-500/20 flex items-center justify-center">
          <div className="absolute inset-0 blur-2xl bg-orange-500/20 rounded-2xl pointer-events-none" />
          {solverMode === "cpsat" ? (
            <Zap className="w-9 h-9 text-purple-400 relative" />
          ) : (
            <Flame className="w-9 h-9 text-orange-400 relative" />
          )}
        </div>
      </div>

      <div className="text-center space-y-3 max-w-sm">
        <h2 className="text-xl font-black text-foreground">
          {solverMode === "cpsat" ? "🧠 CP-SAT in esecuzione" : "⚡ Elaborazione Greedy"}
        </h2>
        <p className="text-sm text-muted-foreground">
          {solverMode === "cpsat"
            ? `Portfolio multi-scenario (~${Math.round(durationSec)}s max · ${intensity})`
            : "Algoritmo greedy — completamento rapido"}
        </p>
      </div>

      {/* Progress bar */}
      <div className="w-full max-w-sm space-y-2">
        <div className="h-2 bg-muted/30 rounded-full overflow-hidden">
          <motion.div
            className="h-full rounded-full bg-gradient-to-r from-orange-400 to-amber-400"
            style={{ width: `${progress}%` }}
            transition={{ duration: 0.1 }}
          />
        </div>
        <div className="flex items-center justify-between text-[10px] text-muted-foreground">
          <span>{Math.round(progress)}%</span>
          <span className="font-mono">{solverMode === "cpsat" ? `CP-SAT · ${intensity}` : "greedy"}</span>
        </div>
      </div>

      {/* Animated message */}
      <AnimatePresence mode="wait">
        <motion.p
          key={msgIdx}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.3 }}
          className="text-xs text-orange-300/60 font-mono"
        >
          {LOADING_MSGS[msgIdx]}
        </motion.p>
      </AnimatePresence>
    </motion.div>
  );
}

interface Props {
  gtfsSelection: GtfsSelection;
  assignment: VehicleAssignment;
  initialResult?: ServiceProgramResult;
  onBack: () => void;
  onComplete: (result: ServiceProgramResult, savedScenarioId?: string) => void;
}

export default function OptimizerStep({ gtfsSelection, assignment, initialResult, onBack, onComplete }: Props) {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ServiceProgramResult | null>(initialResult ?? null);
  const [error, setError] = useState<string | null>(null);
  const [solverMetrics, setSolverMetrics] = useState<any>(null);

  /* ── Solver config (spostato qui da VehicleAssignmentStep) ── */
  const [solverMode, setSolverMode] = useState<"greedy" | "cpsat">("greedy");
  const [solverIntensity, setSolverIntensity] = useState<"fast" | "normal" | "deep" | "extreme">("normal");

  /* ── REGOLA #1: priorità minimizzazione turni macchina ── */
  const [minVehiclesPriority, setMinVehiclesPriority] =
    useState<"off" | "soft" | "strict" | "lexicographic">("strict");

  /* ── Preferenza monolinea (stessa linea sullo stesso veicolo) ── */
  const [preferMonolinea, setPreferMonolinea] = useState<boolean>(false);

  /* ── Parametri costi (override) — utente può fissare le tariffe ── */
  const [showCostPanel, setShowCostPanel] = useState(false);
  const [costFixed12m, setCostFixed12m] = useState<number>(42);
  const [costFixedSnod, setCostFixedSnod] = useState<number>(55);
  const [costFixed10m, setCostFixed10m] = useState<number>(32);
  const [costIdlePerMin, setCostIdlePerMin] = useState<number>(0.08);
  const [costPerDepotReturn, setCostPerDepotReturn] = useState<number>(15);
  const [targetShiftDuration, setTargetShiftDuration] = useState<number>(600);
  const [maxIdleAtTerminal, setMaxIdleAtTerminal] = useState<number>(90);
  // FIX-VSP-7: finestra arc-creation separata da max idle.
  // Permette al solver di considerare archi con gap fino a 600 min anche
  // se max_idle_at_terminal=90, senza penalizzarli con costo proibitivo.
  // Critico per regola#1 strict/lexicographic: senza questa, un veicolo
  // che attende 4h al capolinea NON è raggiungibile dal solver.
  const [maxIdleForArcMin, setMaxIdleForArcMin] = useState<number>(600);

  // FIX-VSP-CLUSTER: raggio (metri) entro cui due capolinea con stop_id
  // diversi vengono trattati come stesso punto (deadhead=0). Critico per
  // minimizzazione veicoli su reti con stazioni/piazze codificate come
  // più stop_id GTFS distinti (es. "Stazione FS A/B/C", "Ugo Bassi nord/sud").
  const [terminalClusterRadiusM, setTerminalClusterRadiusM] = useState<number>(250);

  // FIX-VSP-RUIN: post-ottimizzazione che dissolve ricorsivamente le catene
  // più scariche e reinserisce i loro trip nelle altre. Più passate +
  // più tempo = più tentativi (l'utente preferisce attendere piuttosto che
  // vedere turni in eccesso). Default Python: 10 passi, ~45-60s.
  const [vehicleEliminationMaxPasses, setVehicleEliminationMaxPasses] = useState<number>(10);
  const [vehicleEliminationTimeSec, setVehicleEliminationTimeSec] = useState<number>(60);

  // FIX-VSP-ITER-RED: dopo la pipeline standard, rilancia CP-SAT con vincolo
  // HARD `nv ≤ N-1`, `N-2`, ... finché trova feasibility o dimostra
  // infeasibility. È la mossa "valuta ogni combinazione possibile" — può
  // dimostrare matematicamente che N è il minimo assoluto.
  const [enableIterativeReduction, setEnableIterativeReduction] = useState<boolean>(true);
  const [iterativeReductionTimeSec, setIterativeReductionTimeSec] = useState<number>(180);

  /* ── Profilo preset: scelta "umana" che imposta più parametri insieme ── */
  type OptProfile = "min_vehicles" | "balanced" | "min_cost" | "custom";
  const [profile, setProfile] = useState<OptProfile>("min_vehicles");

  // Applica un profilo preset → modifica i parametri sottostanti.
  // L'utente può poi rifinire singoli campi (lo stato passa a "custom").
  const applyProfile = useCallback((p: OptProfile) => {
    setProfile(p);
    if (p === "min_vehicles") {
      // Massima saturazione, anche a costo di km vuoti maggiori.
      // Finestra arc 15h + 4h capolinea: il solver può fondere catene molto
      // distanti (es. corsa serale isolata che chiude un veicolo del mattino).
      // Cluster 500m: capolinea fisicamente coincidenti ma con stop_id diversi
      // (stazione, piazza centrale) trattati come stesso punto → archi tight
      // ammessi, niente buffer di 5min sulle riassegnazioni a vista.
      setMinVehiclesPriority("lexicographic");
      setSolverIntensity("deep");
      setMaxIdleForArcMin(900);     // 15h: copre quasi tutto il giorno operativo
      setMaxIdleAtTerminal(240);    // 4h al capolinea senza rientro deposito
      setTargetShiftDuration(660);  // turni un po' più lunghi
      setPreferMonolinea(false);
      setTerminalClusterRadiusM(500);
      setVehicleEliminationMaxPasses(15);
      setVehicleEliminationTimeSec(120);
      setEnableIterativeReduction(true);
      setIterativeReductionTimeSec(360);   // 6 minuti: scava a fondo
    } else if (p === "balanced") {
      setMinVehiclesPriority("strict");
      setSolverIntensity("normal");
      setMaxIdleForArcMin(600);
      setMaxIdleAtTerminal(120);
      setTargetShiftDuration(600);
      setPreferMonolinea(false);
      setTerminalClusterRadiusM(250);
      setVehicleEliminationMaxPasses(10);
      setVehicleEliminationTimeSec(60);
      setEnableIterativeReduction(true);
      setIterativeReductionTimeSec(180);
    } else if (p === "min_cost") {
      // Privilegia costo totale: meno km vuoti, accetta più veicoli se conviene
      setMinVehiclesPriority("soft");
      setSolverIntensity("normal");
      setMaxIdleForArcMin(300);     // finestra ridotta → meno idle
      setMaxIdleAtTerminal(60);
      setTargetShiftDuration(540);  // turni più corti, autisti più freschi
      setPreferMonolinea(true);
      setTerminalClusterRadiusM(150);
      setVehicleEliminationMaxPasses(8);
      setVehicleEliminationTimeSec(45);
      setEnableIterativeReduction(false);
      setIterativeReductionTimeSec(90);
    }
    // "custom": non tocca i valori (l'utente li sta editando manualmente)
  }, []);

  // Quando l'utente modifica un campo manualmente, segnaliamo "custom"
  const markCustom = useCallback(() => {
    setProfile("custom");
  }, []);

  // ─── Intermodal context: rimosso da qui (vedi commento sotto in JSX). ───
  // L'analisi intermodale viene ora eseguita SOLO post-ottimizzazione,
  // dal Workspace Turni Macchina, tramite il pulsante "Analisi Intermodale".

  // Save dialog
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [scenarioName, setScenarioName] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedScenarioId, setSavedScenarioId] = useState<string | null>(null);

  /* ── Auto-run on mount if no initialResult ── */
  useEffect(() => {
    if (!initialResult) return; // non auto-runnare: l'utente configura prima il solver
  }, []);

  const runOptimizer = useCallback(async () => {
    setRunning(true);
    setError(null);
    setResult(null);
    setSavedScenarioId(null);
    setSolverMetrics(null);
    try {
      const base = getApiBase();
      const endpoint = solverMode === "cpsat"
        ? "/api/service-program/cpsat"
        : "/api/service-program";

      const tripOverridesObj: Record<string, string> = {};
      for (const [tripId, vt] of assignment.tripVehicleOverrides) {
        tripOverridesObj[tripId] = vt;
      }

      const bodyPayload: any = {
        date: assignment.selectedDate,
        routes: Array.from(assignment.selectedRoutes.entries()).map(([routeId, vehicleType]) => ({
          routeId,
          vehicleType,
          forced: assignment.forcedRoutes.has(routeId),
        })),
        ...(Object.keys(tripOverridesObj).length > 0 ? { tripVehicleOverrides: tripOverridesObj } : {}),
      };
      if (solverMode === "cpsat") {
        bodyPayload.timeLimit = solverIntensity === "fast" ? 60
                               : solverIntensity === "extreme" ? 900
                               : solverIntensity === "deep" ? 420
                               : 180;
        bodyPayload.solverIntensity = solverIntensity;
        // REGOLA #1 + parametri costi utente
        bodyPayload.vspAdvanced = {
          minVehiclesPriority,
          preferMonolinea,
          enableVehicleElimination: true,
          vehicleEliminationMaxPasses,
          vehicleEliminationTimeSec,
          enableIterativeReduction,
          iterativeReductionTimeSec,
          costRatesOverride: {
            fixedDaily: {
              "12m": costFixed12m,
              "autosnodato": costFixedSnod,
              "10m": costFixed10m,
            },
            idlePerMin: costIdlePerMin,
            perDepotReturn: costPerDepotReturn,
            targetShiftDuration: targetShiftDuration,
            maxIdleAtTerminal: maxIdleAtTerminal,
            maxIdleForArcMin: maxIdleForArcMin,
            terminalClusterRadiusM: terminalClusterRadiusM,
          },
        };
      }

      // NB: l'analisi intermodale (treni/navi/aerei) NON viene più passata
      // qui. Viene eseguita come step separato nel Workspace Turni Macchina,
      // dopo la creazione/modifica dei turni, su esplicita richiesta utente.

      const resp = await fetch(`${base}${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bodyPayload),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error || `Errore ${resp.status}`);
      }
      const data = await resp.json();
      setResult(data);
      if (data.solverMetrics) setSolverMetrics(data.solverMetrics);
    } catch (e: any) {
      setError(e.message || "Errore sconosciuto");
    } finally {
      setRunning(false);
    }
  }, [assignment, solverMode, solverIntensity, minVehiclesPriority, preferMonolinea,
      costFixed12m, costFixedSnod, costFixed10m, costIdlePerMin,
      costPerDepotReturn, targetShiftDuration, maxIdleAtTerminal, maxIdleForArcMin,
      terminalClusterRadiusM, vehicleEliminationMaxPasses, vehicleEliminationTimeSec,
      enableIterativeReduction, iterativeReductionTimeSec]);

  const saveScenario = useCallback(async () => {
    if (!result || !scenarioName.trim()) return;
    setSaving(true);
    try {
      const base = getApiBase();
      const input = {
        date: assignment.selectedDate,
        routes: Array.from(assignment.selectedRoutes.entries()).map(([routeId, vehicleType]) => ({
          routeId, vehicleType, forced: assignment.forcedRoutes.has(routeId),
        })),
      };
      const resp = await fetch(`${base}/api/service-program/scenarios`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: scenarioName.trim(), date: assignment.selectedDate, input, result }),
      });
      if (!resp.ok) throw new Error("Errore nel salvataggio");
      const data = await resp.json();
      setSavedScenarioId(data.id);
      setShowSaveDialog(false);
      setScenarioName("");
      toast.success("Scenario salvato", { description: scenarioName.trim() });
    } catch (e: any) {
      toast.error("Errore salvataggio", { description: e.message });
    } finally {
      setSaving(false);
    }
  }, [result, scenarioName, assignment]);

  /* ── Charts ── */
  const hourlyChartData = useMemo(() => {
    if (!result?.hourlyDist) return [];
    return result.hourlyDist.map(h => ({ ora: `${h.hour}:00`, corse: h.trips }));
  }, [result]);

  const radarData = useMemo(() => {
    if (!result?.score) return [];
    const s = result.score;
    return [
      { subject: "Efficienza", value: s.efficiency ?? 0 },
      { subject: "Saturazione", value: s.fleetUtilization ?? 0 },
      { subject: "Min. km vuoto", value: Math.max(0, 100 - (s.deadheadRatio ?? 0) * 5) },
      { subject: "Costo", value: s.costEfficiency ?? 0 },
      { subject: "FIFO", value: s.fifoCompliance ?? 0 },
    ];
  }, [result]);

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Sub-header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-orange-500/10 bg-orange-950/10 shrink-0">
        <div className="flex items-center gap-2">
          <Zap className="w-3.5 h-3.5 text-orange-400/60" />
          <span className="text-[11px] text-orange-300/60 font-medium">Ottimizzazione</span>
          <span className="text-[10px] text-orange-400/30 font-mono px-1.5 py-0.5 bg-orange-500/5 rounded border border-orange-500/10">
            {gtfsSelection.label}
          </span>
          {result && !running && (
            <Badge variant="outline" className={`text-[9px] ${result.solver === "cpsat" ? "border-purple-500/40 text-purple-400" : "border-orange-500/30 text-orange-400"}`}>
              {result.solver === "cpsat" ? "🧠 CP-SAT" : "⚡ Greedy"}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button onClick={onBack} disabled={running}
            className="flex items-center gap-1.5 text-[11px] text-orange-300/50 hover:text-orange-300 transition-colors px-2 py-1 rounded-lg hover:bg-orange-500/8 disabled:opacity-30">
            <ArrowLeft className="w-3.5 h-3.5" /> Indietro
          </button>
          {result && !running && (
            <>
              <button onClick={() => { setScenarioName(`Scenario ${new Date().toLocaleDateString("it-IT")}`); setShowSaveDialog(true); }}
                className="flex items-center gap-1.5 text-[11px] text-green-300 font-medium px-3 py-1.5 rounded-lg border border-green-500/30 bg-green-500/8 hover:bg-green-500/15 transition-all">
                <Save className="w-3.5 h-3.5" />
                Salva Scenario
              </button>
              <button onClick={() => onComplete(result, savedScenarioId ?? undefined)}
                className="flex items-center gap-1.5 text-[11px] text-black font-semibold px-3 py-1.5 rounded-lg bg-gradient-to-r from-orange-400 to-amber-400 hover:shadow-[0_0_12px_rgba(251,146,60,0.3)] transition-shadow">
                Apri Area di Lavoro <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        <AnimatePresence mode="wait">

          {/* ── Pannello configurazione solver (stato iniziale, nessun risultato) ── */}
          {!running && !result && !error && (
            <motion.div key="config" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
              className="max-w-xl mx-auto px-5 py-8 space-y-5">

              <div className="text-center space-y-1.5">
                <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-orange-500/10 border border-orange-500/20 mb-2">
                  <Zap className="w-5 h-5 text-orange-400" />
                </div>
                <h2 className="text-lg font-black text-foreground">Motore di ottimizzazione</h2>
                <p className="text-xs text-muted-foreground">
                  {assignment.selectedRoutes.size} linee · data {assignment.selectedDate}
                </p>
              </div>

              {/* Scelta algoritmo */}
              <div className="bg-card/40 border border-border/30 rounded-xl p-4 space-y-3">
                <p className="text-xs font-semibold text-foreground">Algoritmo</p>
                <div className="flex items-center gap-2">
                  <button onClick={() => setSolverMode("greedy")}
                    className={`flex-1 flex flex-col items-center gap-1.5 py-3 rounded-xl border text-xs font-medium transition-all ${solverMode === "greedy" ? "bg-orange-500/15 border-orange-500/50 text-orange-300" : "border-border/30 text-muted-foreground hover:border-border/60 hover:text-foreground"}`}>
                    <span className="text-xl">⚡</span>
                    <span className="font-bold">Greedy</span>
                    <span className="text-[10px] opacity-70">~1s · buona qualità</span>
                  </button>
                  <button onClick={() => setSolverMode("cpsat")}
                    className={`flex-1 flex flex-col items-center gap-1.5 py-3 rounded-xl border text-xs font-medium transition-all ${solverMode === "cpsat" ? "bg-purple-500/15 border-purple-500/50 text-purple-300" : "border-border/30 text-muted-foreground hover:border-border/60 hover:text-foreground"}`}>
                    <span className="text-xl">🧠</span>
                    <span className="font-bold">CP-SAT</span>
                    <span className="text-[10px] opacity-70">30–120s · ottimale</span>
                  </button>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  {solverMode === "greedy"
                    ? "Algoritmo greedy: velocissimo, buona qualità per la maggior parte dei casi."
                    : "CP-SAT: ottimizzazione combinatoria reale, minimizza veicoli e km a vuoto."}
                </p>
              </div>

              {/* ── PROFILO PRESET (solo CP-SAT) — scelta umana, mappa più parametri ── */}
              {solverMode === "cpsat" && (
                <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
                  className="bg-gradient-to-br from-emerald-500/5 to-cyan-500/5 border border-emerald-500/30 rounded-xl p-4 space-y-3">
                  <div className="flex items-center gap-2">
                    <Award className="w-4 h-4 text-emerald-400" />
                    <p className="text-xs font-semibold text-emerald-300">Profilo di ottimizzazione</p>
                  </div>
                  <p className="text-[10px] text-muted-foreground -mt-1">
                    Scegli un obiettivo: i parametri tecnici si configurano da soli. Puoi sempre rifinirli sotto.
                  </p>
                  <div className="grid grid-cols-3 gap-2">
                    {([
                      { key: "min_vehicles" as const, emoji: "🚌", title: "Min veicoli",  desc: "Massima saturazione, accetta più km vuoti" },
                      { key: "balanced" as const,     emoji: "⚖️", title: "Bilanciato",   desc: "Compromesso veicoli/costo (default)" },
                      { key: "min_cost" as const,     emoji: "💰", title: "Min costo",    desc: "Riduce km vuoti, può usare più veicoli" },
                    ]).map(opt => (
                      <button key={opt.key} onClick={() => applyProfile(opt.key)}
                        className={`flex flex-col items-center gap-1 py-3 px-2 rounded-lg border text-[11px] font-medium transition-all text-center ${profile === opt.key ? "bg-emerald-600/25 border-emerald-500/60 text-emerald-200" : "border-emerald-500/15 text-muted-foreground hover:text-foreground hover:border-emerald-500/30"}`}>
                        <span className="text-lg">{opt.emoji}</span>
                        <span className="font-semibold">{opt.title}</span>
                        <span className="text-[9px] opacity-70 leading-tight">{opt.desc}</span>
                      </button>
                    ))}
                  </div>
                  {profile === "custom" && (
                    <p className="text-[10px] text-amber-400/80 italic flex items-center gap-1">
                      <Pencil className="w-3 h-3" /> Profilo personalizzato (parametri modificati manualmente).
                    </p>
                  )}
                  <details className="text-[10px] text-muted-foreground/70 select-none">
                    <summary className="cursor-pointer hover:text-foreground/80">Cosa imposta ogni profilo?</summary>
                    <div className="mt-2 space-y-1 pl-2 border-l border-emerald-500/20">
                      <div><b className="text-emerald-300">🚌 Min veicoli</b>: priorità Lessicografica · intensità Profondo · finestra archi 15h · sosta capolinea 4h · cluster 500m · turni target 11h.</div>
                      <div><b className="text-emerald-300">⚖️ Bilanciato</b>: priorità Forte · intensità Normale · finestra archi 10h · sosta capolinea 2h · cluster 250m · turni target 10h.</div>
                      <div><b className="text-emerald-300">💰 Min costo</b>: priorità Morbida · intensità Normale · finestra archi 5h · sosta capolinea 1h · cluster 150m · monolinea ON · turni target 9h.</div>
                    </div>
                  </details>
                </motion.div>
              )}

              {/* Intensità CP-SAT */}
              {solverMode === "cpsat" && (
                <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
                  className="bg-card/40 border border-border/30 rounded-xl">
                  <button onClick={() => setShowCostPanel(v => !v)}
                    className="w-full flex items-center justify-between px-4 py-3 hover:bg-muted/20 transition-colors rounded-xl">
                    <div className="flex items-center gap-2">
                      <Pencil className="w-4 h-4 text-muted-foreground" />
                      <span className="text-xs font-semibold text-foreground">Personalizzazione avanzata</span>
                      {profile === "custom" && (
                        <span className="text-[9px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30">modificato</span>
                      )}
                    </div>
                    <ChevronRight className={`w-4 h-4 text-muted-foreground transition-transform ${showCostPanel ? "rotate-90" : ""}`} />
                  </button>
                  {showCostPanel && (
                    <div className="px-4 pb-4 space-y-4 border-t border-border/20 pt-4">
                      <p className="text-[10px] text-muted-foreground -mt-1">
                        Ogni profilo qui sopra imposta tutti questi valori. Modificali solo se sai cosa stai facendo —
                        il profilo passerà automaticamente a "modificato".
                      </p>

                      {/* — Intensità solver — */}
                      <div className="space-y-2">
                        <p className="text-[11px] font-semibold text-purple-300 flex items-center gap-1.5">
                          <Zap className="w-3 h-3" /> Intensità (tempo CPU dedicato)
                        </p>
                        <div className="grid grid-cols-4 gap-1.5">
                          {([
                            { key: "fast" as const,    label: "Veloce",   desc: "~60s" },
                            { key: "normal" as const,  label: "Normale",  desc: "~3min" },
                            { key: "deep" as const,    label: "Profondo", desc: "~7min" },
                            { key: "extreme" as const, label: "Estremo",  desc: "~15min" },
                          ] as const).map(opt => (
                            <button key={opt.key} onClick={() => { setSolverIntensity(opt.key); markCustom(); }}
                              className={`flex flex-col items-center gap-0.5 py-1.5 rounded-md border text-[10px] font-medium transition-all ${solverIntensity === opt.key ? "bg-purple-600/30 border-purple-500/60 text-purple-200" : "border-border/40 text-muted-foreground hover:text-foreground hover:border-border/60"}`}>
                              <span className="font-semibold">{opt.label}</span>
                              <span className="text-[9px] opacity-60">{opt.desc}</span>
                            </button>
                          ))}
                        </div>
                      </div>

                      {/* — Priorità min veicoli — */}
                      <div className="space-y-2">
                        <p className="text-[11px] font-semibold text-amber-300 flex items-center gap-1.5">
                          <Truck className="w-3 h-3" /> Priorità minimizzazione veicoli
                        </p>
                        <div className="grid grid-cols-4 gap-1.5">
                          {([
                            { key: "off" as const,           label: "Off",      desc: "Solo costo" },
                            { key: "soft" as const,          label: "Morbida",  desc: "+1× fisso" },
                            { key: "strict" as const,        label: "Forte",    desc: "+5× fisso" },
                            { key: "lexicographic" as const, label: "Lessico.", desc: "Sempre min" },
                          ]).map(opt => (
                            <button key={opt.key} onClick={() => { setMinVehiclesPriority(opt.key); markCustom(); }}
                              className={`flex flex-col items-center gap-0.5 py-1.5 rounded-md border text-[10px] font-medium transition-all ${minVehiclesPriority === opt.key ? "bg-amber-600/30 border-amber-500/60 text-amber-200" : "border-border/40 text-muted-foreground hover:text-foreground hover:border-border/60"}`}>
                              <span className="font-semibold">{opt.label}</span>
                              <span className="text-[9px] opacity-60">{opt.desc}</span>
                            </button>
                          ))}
                        </div>
                      </div>

                      {/* — Monolinea — */}
                      <label className="flex items-start gap-2 cursor-pointer pt-1">
                        <input
                          type="checkbox"
                          checked={preferMonolinea}
                          onChange={(e) => { setPreferMonolinea(e.target.checked); markCustom(); }}
                          className="mt-0.5 accent-sky-500"
                        />
                        <div className="flex-1">
                          <p className="text-[11px] font-semibold text-sky-300">Preferisci monolinea</p>
                          <p className="text-[10px] text-muted-foreground">
                            Premia turni che restano sulla stessa linea (riduce confusione operativa).
                          </p>
                        </div>
                      </label>

                      {/* — Tariffe & finestre — */}
                      <div className="space-y-2 pt-2 border-t border-border/20">
                        <p className="text-[11px] font-semibold text-emerald-300 flex items-center gap-1.5">
                          <Euro className="w-3 h-3" /> Tariffe & finestre temporali
                        </p>

                        <div className="grid grid-cols-3 gap-2">
                          <CostInput label="Fisso 12m (€/g)"    value={costFixed12m}  onChange={(v) => { setCostFixed12m(v); markCustom(); }}  step={1} />
                          <CostInput label="Fisso snod. (€/g)"  value={costFixedSnod} onChange={(v) => { setCostFixedSnod(v); markCustom(); }} step={1} />
                          <CostInput label="Fisso 10m (€/g)"    value={costFixed10m}  onChange={(v) => { setCostFixed10m(v); markCustom(); }}  step={1} />
                        </div>

                        <div className="grid grid-cols-2 gap-2">
                          <CostInput label="Idle (€/min)"            value={costIdlePerMin}    onChange={(v) => { setCostIdlePerMin(v); markCustom(); }}    step={0.01} />
                          <CostInput label="Rientro deposito (€)"    value={costPerDepotReturn} onChange={(v) => { setCostPerDepotReturn(v); markCustom(); }} step={1} />
                        </div>

                        <div className="grid grid-cols-2 gap-2">
                          <CostInput label="Durata target turno (min)" value={targetShiftDuration} onChange={(v) => { setTargetShiftDuration(v); markCustom(); }} step={30} />
                          <CostInput label="Sosta max capolinea (min)" value={maxIdleAtTerminal}   onChange={(v) => { setMaxIdleAtTerminal(v); markCustom(); }}   step={5}  />
                        </div>

                        <div>
                          <CostInput
                            label="Finestra archi solver (min)"
                            value={maxIdleForArcMin}
                            onChange={(v) => { setMaxIdleForArcMin(v); markCustom(); }}
                            step={30}
                          />
                          <p className="text-[10px] text-muted-foreground mt-1 leading-snug">
                            Sosta massima accettata dal solver per "fondere" due corse sullo stesso veicolo.
                            Più alta = meno veicoli ma più ore d'attesa pagate. Default 600 (10h).
                          </p>
                        </div>

                        <div>
                          <CostInput
                            label="Raggio cluster capolinea (metri)"
                            value={terminalClusterRadiusM}
                            onChange={(v) => { setTerminalClusterRadiusM(v); markCustom(); }}
                            step={50}
                          />
                          <p className="text-[10px] text-muted-foreground mt-1 leading-snug">
                            Capolinea entro questo raggio = "stesso punto" (deadhead 0, niente buffer).
                            Risolve il caso "stazione/piazza con più stop_id GTFS distinti".
                            <b className="text-emerald-300"> Critico per minimizzare i veicoli</b>:
                            valori bassi escludono riassegnazioni tight tra fermate vicine.
                            Default 250m. Profilo Min veicoli usa 500m.
                          </p>
                        </div>

                        <div className="border-t border-white/5 pt-2 mt-1">
                          <p className="text-[11px] font-semibold text-amber-300 mb-1.5">
                            🔁 Post-ottimizzazione (Ruin & Recreate)
                          </p>
                          <div className="grid grid-cols-2 gap-2">
                            <CostInput
                              label="Tentativi (passate)"
                              value={vehicleEliminationMaxPasses}
                              onChange={(v) => { setVehicleEliminationMaxPasses(v); markCustom(); }}
                              step={1}
                            />
                            <CostInput
                              label="Tempo dedicato (sec)"
                              value={vehicleEliminationTimeSec}
                              onChange={(v) => { setVehicleEliminationTimeSec(v); markCustom(); }}
                              step={15}
                            />
                          </div>
                          <p className="text-[10px] text-muted-foreground mt-1 leading-snug">
                            Dopo la prima soluzione, il solver tenta di <b>eliminare turni macchina</b> dissolvendo
                            le catene più scariche e reinserendo le loro corse nelle altre — esattamente come fai a mano.
                            Più tentativi e più tempo = più probabilità di passare da N a N-1 turni.
                            Profilo Min veicoli: 15 passi / 120s.
                          </p>
                        </div>

                        <div className="border-t border-white/5 pt-2 mt-1">
                          <p className="text-[11px] font-semibold text-rose-300 mb-1.5">
                            🎯 Riduzione Iterativa (forza il limite minimo)
                          </p>
                          <label className="flex items-center gap-2 text-[11px] cursor-pointer mb-1.5">
                            <input
                              type="checkbox"
                              checked={enableIterativeReduction}
                              onChange={(e) => { setEnableIterativeReduction(e.target.checked); markCustom(); }}
                              className="accent-rose-500"
                            />
                            <span>Attiva riduzione iterativa (CP-SAT con vincolo {`#veh ≤ N-1`})</span>
                          </label>
                          <CostInput
                            label="Tempo dedicato (sec)"
                            value={iterativeReductionTimeSec}
                            onChange={(v) => { setIterativeReductionTimeSec(v); markCustom(); }}
                            step={30}
                          />
                          <p className="text-[10px] text-muted-foreground mt-1 leading-snug">
                            <b className="text-rose-300">La mossa più potente</b>: dopo la prima soluzione (es. 11 turni),
                            CP-SAT viene rilanciato con vincolo HARD <b>nv ≤ 10</b>; se trova soluzione, riprova con <b>≤ 9</b>, ecc.
                            Si ferma quando dimostra <i>matematicamente</i> che il limite è impossibile (INFEASIBLE) o
                            scade il tempo. Costoso ma è esattamente "valuta ogni combinazione".
                            Profilo Min veicoli: ON, 360s (6 min).
                          </p>
                        </div>
                      </div>
                    </div>
                  )}
                </motion.div>
              )}

              {/* ── Intermodalità: spostata DOPO l'ottimizzazione ──
                * L'opt-in intermodale è stato rimosso da qui per scelta UX:
                * l'analisi delle coincidenze treno/nave/aereo viene proposta
                * SOLO dopo la creazione dei turni macchina, nel Workspace,
                * tramite il pulsante "Analisi Intermodale". Quel flusso
                * mostra le modifiche orari proposte come scenario alternativo
                * confrontabile (l'utente decide se applicarle).
                */}

              {/* CTA avvio */}
              <button onClick={runOptimizer}
                data-virgilio-id="fucina:run-optimizer"
                className={`w-full flex items-center justify-center gap-2 py-3.5 rounded-xl font-bold text-sm text-black transition-all shadow-lg ${
                  solverMode === "cpsat"
                    ? "bg-gradient-to-r from-purple-500 to-violet-500 hover:from-purple-400 hover:to-violet-400 shadow-purple-500/20"
                    : "bg-gradient-to-r from-orange-400 to-amber-400 hover:from-orange-300 hover:to-amber-300 shadow-orange-500/20"
                }`}>
                <Play className="w-4 h-4" />
                {solverMode === "cpsat" ? "Avvia CP-SAT" : "Avvia Greedy"}
              </button>
            </motion.div>
          )}

          {/* ── Loading screen ── */}
          {running && (
            <motion.div key="loading" className="h-full" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <LoadingScreen solverMode={solverMode} intensity={solverIntensity} />
            </motion.div>
          )}

          {/* ── Error state ── */}
          {!running && error && (
            <motion.div key="error" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
              className="flex flex-col items-center justify-center h-[40vh] gap-4 px-6">
              <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-5 max-w-md text-center">
                <AlertTriangle className="w-8 h-8 text-red-400 mx-auto mb-3" />
                <p className="text-sm font-medium text-red-400 mb-1">Ottimizzazione fallita</p>
                <p className="text-xs text-muted-foreground">{error}</p>
              </div>
              <button onClick={runOptimizer}
                className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold text-black bg-gradient-to-r from-orange-400 to-amber-400">
                <RefreshCw className="w-4 h-4" /> Riprova
              </button>
            </motion.div>
          )}

          {/* ── Results ── */}
          {!running && result && (
            <motion.div key="results" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}
              className="max-w-6xl mx-auto p-4 space-y-5">

              {/* ── Re-run bar ── */}
              <div className="flex items-center gap-3 p-3 bg-card/40 border border-border/30 rounded-xl flex-wrap">
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-foreground">
                    {result.summary.totalVehicles} veicoli · {result.summary.totalTrips} corse · {assignment.selectedRoutes.size} linee
                  </p>
                  <p className="text-[10px] text-muted-foreground">
                    Data {result.summary.date ? ymdToDisplay(result.summary.date) : assignment.selectedDate} ·
                    {" "}{solverMode === "cpsat" ? `CP-SAT ${solverIntensity}` : "Greedy"}
                    {solverMetrics?.totalSolveTimeSec && ` · ${solverMetrics.totalSolveTimeSec}s`}
                  </p>
                </div>
                <button onClick={() => { setResult(null); setError(null); setSolverMetrics(null); setSavedScenarioId(null); }}
                  className="flex items-center gap-1.5 text-[11px] text-amber-300 px-3 py-1.5 rounded-lg border border-amber-500/30 bg-amber-500/8 hover:bg-amber-500/15 transition-all">
                  <RefreshCw className="w-3.5 h-3.5" /> Ri-ottimizza
                </button>
                {savedScenarioId && (
                  <a href={`/driver-shifts/${savedScenarioId}`}
                    className="flex items-center gap-1.5 text-[11px] text-purple-300 px-3 py-1.5 rounded-lg border border-purple-500/30 bg-purple-500/8 hover:bg-purple-500/15 transition-all">
                    <Users className="w-3.5 h-3.5" /> Turni Guida
                  </a>
                )}
              </div>

              {/* Save dialog */}
              {showSaveDialog && (
                <motion.div initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }}
                  className="bg-green-500/5 border border-green-500/30 rounded-xl p-3 flex items-center gap-3">
                  <Save className="w-4 h-4 text-green-400 shrink-0" />
                  <input value={scenarioName} onChange={e => setScenarioName(e.target.value)}
                    placeholder="Nome scenario…"
                    className="flex-1 bg-background border border-border/50 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-green-500/50"
                    autoFocus
                    onKeyDown={e => { if (e.key === "Enter") saveScenario(); if (e.key === "Escape") setShowSaveDialog(false); }} />
                  <button onClick={saveScenario} disabled={saving || !scenarioName.trim()}
                    className="flex items-center gap-1.5 bg-green-500/20 text-green-400 border border-green-500/30 px-4 py-1.5 rounded-lg text-xs font-medium hover:bg-green-500/30 disabled:opacity-40">
                    {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />} Salva
                  </button>
                  <button onClick={() => setShowSaveDialog(false)} className="text-muted-foreground hover:text-foreground p-1">
                    <X className="w-4 h-4" />
                  </button>
                </motion.div>
              )}

              {/* Saved badge */}
              {savedScenarioId && !showSaveDialog && (
                <div className="flex items-center gap-2 text-xs text-green-400 bg-green-500/5 border border-green-500/20 rounded-xl px-4 py-2.5">
                  <CheckCircle2 className="w-4 h-4" />
                  <span>Scenario salvato</span>
                </div>
              )}

              {/* ──── SCORE + COST ──── */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {/* Score */}
                <Card className="bg-card/40 border-border/30 overflow-hidden">
                  <CardContent className="p-5">
                    <div className="flex items-start justify-between mb-4">
                      <div>
                        <h3 className="text-sm font-semibold flex items-center gap-1.5">
                          <Award className="w-4 h-4 text-orange-400" /> Punteggio Scenario
                        </h3>
                        <p className="text-[10px] text-muted-foreground mt-0.5">Valutazione qualità del programma</p>
                      </div>
                      <div className="text-center">
                        <div className="text-4xl font-black" style={{ color: result.score?.gradeColor ?? "#888" }}>{result.score?.grade ?? "?"}</div>
                        <div className="text-lg font-bold text-muted-foreground">{result.score?.overall ?? 0}<span className="text-xs">/100</span></div>
                      </div>
                    </div>
                    <div className="h-[180px] -mx-4">
                      <ResponsiveContainer width="100%" height="100%">
                        <RadarChart data={radarData} cx="50%" cy="50%" outerRadius="70%">
                          <PolarGrid stroke="hsl(var(--border))" opacity={0.3} />
                          <PolarAngleAxis dataKey="subject" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
                          <Radar dataKey="value" stroke="#f97316" fill="#f97316" fillOpacity={0.15} strokeWidth={2} />
                        </RadarChart>
                      </ResponsiveContainer>
                    </div>
                    <div className="grid grid-cols-5 gap-2 mt-2">
                      {[
                        { label: "Effic.", val: result.score?.efficiency ?? 0 },
                        { label: "Satur.", val: result.score?.fleetUtilization ?? 0 },
                        { label: "Km vuoto", val: Math.max(0, +(100 - (result.score?.deadheadRatio ?? 0) * 5).toFixed(0)) },
                        { label: "Costo", val: result.score?.costEfficiency ?? 0 },
                        { label: "FIFO", val: result.score?.fifoCompliance ?? 0 },
                      ].map(s => (
                        <div key={s.label} className="text-center">
                          <div className="text-xs font-bold" style={{ color: s.val >= 70 ? "#22c55e" : s.val >= 40 ? "#f59e0b" : "#ef4444" }}>{s.val}%</div>
                          <div className="text-[9px] text-muted-foreground">{s.label}</div>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>

                {/* Cost */}
                <Card className="bg-card/40 border-border/30">
                  <CardContent className="p-5">
                    <h3 className="text-sm font-semibold flex items-center gap-1.5 mb-4">
                      <Euro className="w-4 h-4 text-orange-400" /> Costi Giornalieri
                    </h3>
                    <div className="text-3xl font-black text-orange-400 mb-1">
                      €{(result.costs.totalDailyCost ?? 0).toLocaleString()}
                      <span className="text-sm font-normal text-muted-foreground">/giorno</span>
                    </div>
                    <div className="flex gap-4 text-xs text-muted-foreground mb-4">
                      <span>€{result.costs.costPerTrip ?? 0}/corsa</span>
                      <span>€{result.costs.costPerServiceHour ?? 0}/ora servizio</span>
                    </div>
                    <div className="space-y-2">
                      {[
                        { label: "Fisso veicolo (assic./manut.)", value: result.costs.vehicleFixedCost ?? 0, color: "#3b82f6" },
                        { label: "Km servizio (carb./usura)", value: result.costs.vehicleServiceKmCost ?? 0, color: "#06b6d4" },
                        { label: "Km a vuoto", value: result.costs.vehicleDeadheadKmCost ?? 0, color: "#ef4444" },
                        { label: "Autisti (ore guida)", value: result.costs.driverCost ?? 0, color: "#22c55e" },
                        { label: "Tempo inattivo", value: result.costs.idleCost ?? 0, color: "#f59e0b" },
                        { label: "Rientri deposito", value: result.costs.depotReturnCost ?? 0, color: "#8b5cf6" },
                      ].map(item => {
                        const total = result.costs.totalDailyCost ?? 1;
                        const pct = total > 0 ? (item.value / total) * 100 : 0;
                        return (
                          <div key={item.label}>
                            <div className="flex items-center justify-between text-[11px] mb-0.5">
                              <span className="text-muted-foreground">{item.label}</span>
                              <span className="font-medium">€{item.value.toLocaleString()} <span className="text-muted-foreground/60">({pct.toFixed(0)}%)</span></span>
                            </div>
                            <div className="h-1.5 bg-muted/30 rounded-full overflow-hidden">
                              <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: item.color }} />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </CardContent>
                </Card>
              </div>

              {/* ──── SUMMARY CARDS ──── */}
              <div className="flex flex-wrap gap-3">
                <SummaryCard icon={<Bus className="w-4 h-4" />} label="Corse" value={result.summary.totalTrips.toLocaleString()} sub={`${result.summary.selectedRoutes} linee`} />
                <SummaryCard icon={<Truck className="w-4 h-4" />} label="Veicoli" value={result.summary.totalVehicles.toString()} color="#3b82f6"
                  sub={`${result.summary.byCategory?.urbano || 0} urb · ${result.summary.byCategory?.extraurbano || 0} ext`} />
                <SummaryCard icon={<Clock className="w-4 h-4" />} label="Ore servizio" value={`${result.summary.totalServiceHours}h`} sub={`+ ${result.summary.totalDeadheadHours}h vuoto`} />
                <SummaryCard icon={<MapPin className="w-4 h-4" />} label="Km vuoto" value={`${result.summary.totalDeadheadKm ?? 0}`} color="#ef4444" sub={`€${result.costs.vehicleDeadheadKmCost ?? 0}/gg`} />
                <SummaryCard icon={<Home className="w-4 h-4" />} label="Rientri deposito" value={result.summary.depotReturns.toString()} sub="gap > 60 min" />
                <SummaryCard icon={<Fuel className="w-4 h-4" />} label="FIFO" value={`${result.score?.fifoCompliance ?? 0}%`}
                  color={(result.score?.fifoCompliance ?? 0) >= 70 ? "#22c55e" : "#f59e0b"} sub="First-Out First-In" />
                {(result.summary.downsizedTrips ?? 0) > 0 && (
                  <SummaryCard icon={<TrendingUp className="w-4 h-4" />} label="Mezzo ridotto" value={`${result.summary.downsizedTrips}`} color="#f59e0b" sub={`su ${result.summary.totalTrips} corse`} />
                )}
              </div>

              {/* ──── ADVISORIES ──── */}
              {result.advisories?.length > 0 && (
                <Card className="bg-card/40 border-border/30">
                  <CardContent className="p-5">
                    <h3 className="text-sm font-semibold flex items-center gap-1.5 mb-3">
                      <Lightbulb className="w-4 h-4 text-orange-400" /> Consigli di Ottimizzazione
                      <Badge variant="outline" className="ml-2 text-[10px]">{result.advisories.length}</Badge>
                    </h3>
                    <div className="space-y-2">
                      {result.advisories.map(adv => {
                        const sev = SEV_CONFIG[adv.severity];
                        const Icon = sev.icon;
                        return (
                          <div key={adv.id} className={`${sev.bg} border ${sev.border} rounded-lg p-3`}>
                            <div className="flex items-start gap-2">
                              <Icon className={`w-4 h-4 ${sev.text} shrink-0 mt-0.5`} />
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 mb-1 flex-wrap">
                                  <span className={`text-sm font-medium ${sev.text}`}>{adv.title}</span>
                                  <span className={`text-[9px] px-1.5 py-0.5 rounded ${sev.badge}`}>
                                    {adv.severity === "critical" ? "CRITICO" : adv.severity === "warning" ? "ATTENZIONE" : "INFO"}
                                  </span>
                                </div>
                                <p className="text-xs text-muted-foreground mb-1">{adv.description}</p>
                                <div className="flex items-center gap-1 text-xs mb-0.5">
                                  <TrendingUp className="w-3 h-3 text-green-400" />
                                  <span className="text-green-400 font-medium">{adv.impact}</span>
                                </div>
                                <div className="flex items-center gap-1 text-xs">
                                  <Zap className="w-3 h-3 text-amber-400" />
                                  <span className="text-muted-foreground">{adv.action}</span>
                                </div>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </CardContent>
                </Card>
              )}

              {/* ──── FLEET FIFO ──── */}
              <Card className="bg-card/40 border-border/30">
                <CardContent className="p-4">
                  <h3 className="text-sm font-semibold mb-3 flex items-center gap-1.5">
                    <Truck className="w-4 h-4 text-orange-400" /> Composizione Flotta &amp; Rotazione FIFO
                  </h3>
                  <div className="flex flex-wrap gap-3 mb-3">
                    {(Object.entries(result.summary.byType ?? {}) as [VehicleType, number][]).sort(([, a], [, b]) => b - a).map(([vt, count]) => (
                      <div key={vt} className="flex items-center gap-2 bg-background/50 rounded-lg px-3 py-2">
                        <span className="w-3 h-3 rounded-full" style={{ backgroundColor: VEHICLE_COLORS[vt] }} />
                        <span className="text-sm font-bold">{count}</span>
                        <span className="text-xs text-muted-foreground">{VEHICLE_LABELS[vt] || vt}</span>
                      </div>
                    ))}
                  </div>
                  <div className="text-[10px] text-muted-foreground mb-2">
                    🔋 Ordine rifornimento FIFO — primo a uscire = primo a rientrare
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {[...result.shifts].sort((a, b) => a.fifoOrder - b.fifoOrder).slice(0, 24).map(shift => (
                      <div key={shift.vehicleId} className="flex items-center gap-1 bg-background/50 rounded px-1.5 py-0.5 text-[9px]">
                        <span className="font-mono font-medium text-muted-foreground">{shift.fifoOrder}.</span>
                        <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ backgroundColor: CATEGORY_COLORS[shift.category] }} />
                        <span>{shift.vehicleId}</span>
                        <span className="text-muted-foreground/60">{minToTime(shift.firstOut)}→{minToTime(shift.lastIn)}</span>
                      </div>
                    ))}
                    {result.shifts.length > 24 && <span className="text-[9px] text-muted-foreground self-center">+{result.shifts.length - 24}</span>}
                  </div>
                </CardContent>
              </Card>

              {/* ──── ROUTE STATS ──── */}
              {result.routeStats?.length > 0 && (
                <Card className="bg-card/40 border-border/30">
                  <CardContent className="p-4">
                    <h3 className="text-sm font-semibold mb-3 flex items-center gap-1.5">
                      <Bus className="w-4 h-4 text-orange-400" /> Dettaglio per Linea
                    </h3>
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="border-b border-border/30 text-muted-foreground">
                            <th className="text-left py-2 px-2">Linea</th>
                            <th className="text-left py-2 px-2">Tipo</th>
                            <th className="text-left py-2 px-2">Vettura</th>
                            <th className="text-right py-2 px-2">Corse</th>
                            <th className="text-right py-2 px-2">Veicoli</th>
                            <th className="text-right py-2 px-2">Prima</th>
                            <th className="text-right py-2 px-2">Ultima</th>
                          </tr>
                        </thead>
                        <tbody>
                          {result.routeStats.map(rs => (
                            <tr key={rs.routeId} className="border-b border-border/10 hover:bg-muted/20 transition-colors">
                              <td className="py-1.5 px-2 font-medium">{rs.routeName}</td>
                              <td className="py-1.5 px-2">
                                <span className="text-[9px] px-1.5 py-0.5 rounded"
                                  style={{ backgroundColor: rs.category === "urbano" ? "rgba(59,130,246,0.15)" : "rgba(245,158,11,0.15)", color: CATEGORY_COLORS[rs.category as ServiceCategory] }}>
                                  {rs.category === "urbano" ? "URB" : "EXT"}
                                </span>
                              </td>
                              <td className="py-1.5 px-2">
                                <Badge variant="outline" className="text-[10px]"
                                  style={{ borderColor: VEHICLE_COLORS[rs.vehicleType as VehicleType] || "#6b7280", color: VEHICLE_COLORS[rs.vehicleType as VehicleType] || "#6b7280" }}>
                                  {VEHICLE_SHORT[rs.vehicleType as VehicleType] || rs.vehicleType}
                                </Badge>
                              </td>
                              <td className="py-1.5 px-2 text-right">{rs.tripsCount}</td>
                              <td className="py-1.5 px-2 text-right font-bold">{rs.vehiclesNeeded}</td>
                              <td className="py-1.5 px-2 text-right text-muted-foreground">{rs.firstDeparture?.slice(0, 5)}</td>
                              <td className="py-1.5 px-2 text-right text-muted-foreground">{rs.lastArrival?.slice(0, 5)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </CardContent>
                </Card>
              )}

              {/* ──── HOURLY CHART ──── */}
              {hourlyChartData.length > 0 && (
                <Card className="bg-card/40 border-border/30">
                  <CardContent className="p-4">
                    <h3 className="text-sm font-semibold mb-3 flex items-center gap-1.5">
                      <BarChart3 className="w-4 h-4 text-orange-400" /> Distribuzione Oraria Corse
                    </h3>
                    <ResponsiveContainer width="100%" height={200}>
                      <BarChart data={hourlyChartData}>
                        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.3} />
                        <XAxis dataKey="ora" tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
                        <YAxis tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
                        <ReTooltip contentStyle={{ backgroundColor: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 12 }} />
                        <Bar dataKey="corse" name="Corse" fill="#f97316" radius={[3, 3, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </CardContent>
                </Card>
              )}

              {/* ──── CP-SAT greedy comparison banner ──── */}
              {result.solver === "cpsat" && result.greedyComparison && result.costBreakdown && (() => {
                const greedyCost = result.greedyComparison.costBreakdown.aggregated.total;
                const cpsatCost = result.costBreakdown.aggregated.total;
                const savedCost = greedyCost - cpsatCost;
                const savedPct = greedyCost > 0 ? (savedCost / greedyCost) * 100 : 0;
                const savedVehicles = result.greedyComparison.vehicles - result.costBreakdown.numVehicles;
                return (
                  <div className="bg-gradient-to-r from-green-500/8 via-emerald-500/8 to-teal-500/8 border border-green-500/25 rounded-xl p-4">
                    <div className="flex items-center gap-3 flex-wrap">
                      <div className="w-8 h-8 rounded-full bg-green-500/20 flex items-center justify-center shrink-0">
                        <TrendingUp className="w-4 h-4 text-green-400" />
                      </div>
                      <div>
                        <div className="text-sm font-semibold text-green-400">
                          CP-SAT risparmia {savedPct.toFixed(1)}% vs Greedy
                        </div>
                        <div className="text-[11px] text-muted-foreground">
                          €{savedCost.toFixed(0)}/giorno in meno ·{" "}
                          {savedVehicles > 0 ? `${savedVehicles} veicoli in meno` : "Stesso n. veicoli"}
                        </div>
                      </div>
                      <div className="flex gap-4 ml-auto text-xs text-center">
                        <div>
                          <div className="text-muted-foreground">Greedy</div>
                          <div className="font-bold text-red-400/80">{result.greedyComparison.vehicles} vei.</div>
                          <div className="text-muted-foreground">€{greedyCost.toFixed(0)}</div>
                        </div>
                        <div className="flex items-center"><ChevronRight className="w-4 h-4 text-green-400" /></div>
                        <div>
                          <div className="text-muted-foreground">CP-SAT</div>
                          <div className="font-bold text-green-400">{result.costBreakdown.numVehicles} vei.</div>
                          <div className="text-green-400">€{cpsatCost.toFixed(0)}</div>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })()}

              {/* ──── CTA bottom ──── */}
              <div className="flex items-center justify-between py-4 border-t border-border/20">
                <p className="text-xs text-muted-foreground">
                  Soddisfatto del risultato? Apri l'<strong className="text-orange-300/80">Area di Lavoro</strong> per spostare le corse tra i turni.
                </p>
                <button onClick={() => onComplete(result, savedScenarioId ?? undefined)}
                  className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-bold text-black bg-gradient-to-r from-orange-400 to-amber-400 hover:shadow-[0_0_20px_rgba(251,146,60,0.35)] transition-shadow shrink-0">
                  <Truck className="w-4 h-4" />
                  Apri Area di Lavoro
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>

            </motion.div>
          )}

        </AnimatePresence>
      </div>
    </div>
  );
}
