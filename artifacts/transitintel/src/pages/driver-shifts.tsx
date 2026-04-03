import React, { useState, useEffect, useMemo, useCallback } from "react";
import { useParams } from "wouter";
import { motion, AnimatePresence } from "framer-motion";
import {
  Loader2, Users, Clock, ChevronDown, ChevronUp,
  Calendar, Bus, Timer, BarChart3, AlertTriangle, TrendingUp,
  ArrowLeft, Coffee, Zap, Shield, Repeat, Car, Settings, Play,
  DollarSign,
} from "lucide-react";
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

import type {
  DriverShiftType, DriverShiftData, DriverShiftsResult,
} from "./driver-shifts/types";
import {
  TYPE_LABELS, TYPE_COLORS, TYPE_DESC,
  ymdToDisplay, minToTime, formatDuration,
} from "./driver-shifts/constants";
import {
  DriverShiftsErrorBoundary, SummaryCard,
} from "./driver-shifts/components";
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

  const [result, setResult] = useState<DriverShiftsResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedShifts, setExpandedShifts] = useState<Set<string>>(new Set());
  const [typeFilter, setTypeFilter] = useState<DriverShiftType | "all">("all");

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
      .then(data => { setResult(data); })
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

    const timeLimit = operatorConfig.solverIntensity === 1 ? 60 :
                      operatorConfig.solverIntensity === 3 ? 300 : 120;
    cpsat.start(scenarioId, timeLimit, operatorConfig);
  }, [scenarioId, cpsat, operatorConfig]);

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
  }, [filteredShifts]);

  const handleDriverGanttChange = useCallback((change: GanttChange, _allBars: GanttBar[]) => {
    console.log("[InteractiveGantt] Driver Gantt change:", change);
  }, []);

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
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
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
        <a href="/optimizer-route" className="flex items-center gap-2 text-sm text-primary mt-4 hover:underline">
          <ArrowLeft className="w-4 h-4" /> Torna al Programma di Esercizio
        </a>
      </div>
    );
  }

  return (
    <div className="h-[calc(100vh-3.5rem)] md:h-screen overflow-y-auto">
      <div className="max-w-7xl mx-auto p-4 md:p-6 space-y-6">

        {/* Header — always visible */}
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <a href="/optimizer-route" className="flex items-center gap-1 text-xs text-muted-foreground hover:text-primary mb-1">
              <ArrowLeft className="w-3 h-3" /> Programma di Esercizio
            </a>
            <h1 className="text-xl font-bold flex items-center gap-2">
              <Users className="w-5 h-5 text-primary" />
              Turni Guida — Urbano
            </h1>
            {result && (
              <p className="text-sm text-muted-foreground mt-1">
                Scenario: <strong>{result.scenarioName}</strong> · Data: <strong>{ymdToDisplay(result.date)}</strong>
              </p>
            )}
          </div>
          <div className="flex items-center gap-3">
            {/* Solver toggle */}
            <div className="flex items-center gap-2 bg-card/60 border border-border/40 rounded-lg px-3 py-1.5">
              <button onClick={() => switchMode("greedy")}
                className={`px-3 py-1 rounded text-xs font-medium transition-colors ${solverMode === "greedy" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>
                ⚡ Greedy
              </button>
              <button onClick={() => switchMode("cpsat")}
                className={`px-3 py-1 rounded text-xs font-medium transition-colors ${solverMode === "cpsat" ? "bg-purple-600 text-white" : "text-muted-foreground hover:text-foreground"}`}>
                🧠 CP-SAT
              </button>
            </div>
            {/* Config (CP-SAT only) */}
            {solverMode === "cpsat" && (
              <button onClick={() => setConfigOpen(true)}
                className="flex items-center gap-1 px-2 py-1.5 rounded-lg text-xs font-medium bg-muted/20 hover:bg-muted/40 border border-border/30 transition-colors">
                <Settings className="w-3.5 h-3.5" /> Config
              </button>
            )}
            {/* Genera button — always visible */}
            <button
              onClick={solverMode === "cpsat" ? launchCPSAT : launchGreedy}
              disabled={loading || cpsat.state === "running" || cpsat.state === "starting"}
              className={`flex items-center gap-1 px-4 py-1.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-50 ${
                solverMode === "cpsat"
                  ? "bg-purple-600 text-white hover:bg-purple-700"
                  : "bg-primary text-primary-foreground hover:bg-primary/90"
              }`}>
              <Play className="w-3.5 h-3.5" /> Genera Turni Guida
            </button>
            {solverMetrics && (
              <Badge variant="outline" className="text-xs">
                {solverMetrics.status} · {solverMetrics.totalSolveTimeSec ?? solverMetrics.solveTimeSec ?? "?"}s
              </Badge>
            )}
          </div>
        </div>

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
            <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mb-4">
              <Users className="w-8 h-8 text-primary/60" />
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
        <div className="flex flex-wrap gap-3">
          <SummaryCard icon={<Users className="w-4 h-4" />} label="Autisti" value={result.summary.totalDriverShifts.toString()} sub={`${result.summary.byType.intero} interi · ${result.summary.byType.semiunico} semiunici · ${result.summary.byType.spezzato} spezzati`} />
          <SummaryCard icon={<Clock className="w-4 h-4" />} label="Ore Lavoro Totali" value={`${result.summary.totalWorkHours}h`} sub={`media: ${formatDuration(result.summary.avgWorkMin)}/turno`} />
          <SummaryCard icon={<Timer className="w-4 h-4" />} label="Ore Nastro Totali" value={`${result.summary.totalNastroHours}h`} sub={`media: ${formatDuration(result.summary.avgNastroMin)}/turno`} />
          <SummaryCard icon={<Coffee className="w-4 h-4" />} label="Semiunici" value={`${result.summary.semiunicoPct}%`} color={result.summary.semiunicoPct <= 12 ? "#22c55e" : "#ef4444"} sub="limite ≤ 12%" />
          <SummaryCard icon={<Timer className="w-4 h-4" />} label="Spezzati" value={`${result.summary.spezzatoPct}%`} color={result.summary.spezzatoPct <= 13 ? "#22c55e" : "#ef4444"} sub="limite ≤ 13%" />
          {result.summary.byType.supplemento > 0 && (
            <SummaryCard icon={<Zap className="w-4 h-4" />} label="Supplementi" value={result.summary.byType.supplemento.toString()} sub="straordinari (≤ 2h30)" color="#8b5cf6" />
          )}
          {result.summary.totalCambi > 0 && (() => {
            const totalHandovers = result.driverShifts.reduce((sum, s) => sum + (s.handovers?.filter(h => h.role === "outgoing").length ?? 0), 0);
            const interCount = result.summary.totalInterCambi ?? result.summary.totalCambi;
            const intraCount = result.summary.totalIntraCambi ?? 0;
            const subLabel = intraCount > 0
              ? `${interCount} inter + ${intraCount} intra-corsa`
              : (totalHandovers > 0 ? `${totalHandovers} cambi bus con auto aziendale` : `${result.driverShifts.filter(s => s.cambiCount > 0).length} turni con cambio`);
            return (
              <SummaryCard icon={<Repeat className="w-4 h-4" />} label="Cambi in Linea" value={result.summary.totalCambi.toString()} sub={subLabel} color="#06b6d4" />
            );
          })()}
          <SummaryCard icon={<Car className="w-4 h-4" />} label="Auto Aziendali" value={`${result.summary.companyCarsUsed}/${result.companyCars}`} sub="per trasf. deposito ↔ cluster" />
          {result.summary.totalDailyCost != null && result.summary.totalDailyCost > 0 && (
            <SummaryCard icon={<DollarSign className="w-4 h-4" />} label="Costo Giornaliero" value={`€${result.summary.totalDailyCost.toLocaleString("it-IT", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`} sub={result.summary.efficiency?.costPerDriver ? `€${result.summary.efficiency.costPerDriver.toFixed(0)}/autista` : "ottimizzato"} color="#10b981" />
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
              <SummaryCard icon={<Shield className="w-4 h-4" />} label="Conformità BDS" value={`${pct}%`} color={pct >= 90 ? "#22c55e" : pct >= 70 ? "#f59e0b" : "#ef4444"} sub={`${conformi}/${withBds.length} turni conformi`} />
            );
          })()}
        </div>

        {/* Distribution charts */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Type distribution */}
          <Card className="bg-muted/30 border-border/30">
            <CardContent className="p-4">
              <h3 className="text-sm font-semibold flex items-center gap-1.5 mb-3"><BarChart3 className="w-4 h-4 text-primary" /> Distribuzione per Tipo</h3>
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
              <h3 className="text-sm font-semibold flex items-center gap-1.5 mb-3"><TrendingUp className="w-4 h-4 text-primary" /> Distribuzione Ore Lavoro</h3>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={workDistData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.3} />
                  <XAxis dataKey="label" tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
                  <YAxis tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
                  <ReTooltip contentStyle={{ backgroundColor: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 12 }} />
                  <Bar dataKey="count" name="Turni" fill="#3b82f6" radius={[4, 4, 0, 0]} />
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
              <h3 className="text-sm font-semibold flex items-center gap-1.5 mb-3"><Repeat className="w-4 h-4 text-cyan-400" /> Cluster di Cambio in Linea</h3>
              <p className="text-xs text-muted-foreground mb-3">
                Zone dove i conducenti possono scambiarsi il veicolo durante il servizio. Il conducente subentrante arriva dal deposito (Via Bocconi 35) guidando un'auto aziendale che lascia al capolinea. Il conducente uscente prende l'auto e rientra al deposito.
              </p>
              <div className="flex flex-wrap gap-2">
                {result.clusters.map(c => (
                  <div key={c.id} className="flex items-center gap-2 bg-cyan-500/5 border border-cyan-500/10 rounded-lg px-3 py-2">
                    <div className="w-2 h-2 rounded-full bg-cyan-400" />
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
            <h3 className="text-sm font-semibold flex items-center gap-1.5 mb-3"><Shield className="w-4 h-4 text-primary" /> Conformità Normativa</h3>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className={`rounded-lg p-3 border ${result.summary.semiunicoPct <= 12 ? "bg-green-500/5 border-green-500/20" : "bg-red-500/5 border-red-500/20"}`}>
                <div className="text-[10px] text-muted-foreground mb-1">Semiunici ≤ 12%</div>
                <div className={`text-2xl font-bold ${result.summary.semiunicoPct <= 12 ? "text-green-400" : "text-red-400"}`}>
                  {result.summary.semiunicoPct}%
                </div>
                <div className="text-[10px] text-muted-foreground">{result.summary.byType.semiunico} su {result.summary.totalDriverShifts} autisti</div>
              </div>
              <div className={`rounded-lg p-3 border ${result.summary.spezzatoPct <= 13 ? "bg-green-500/5 border-green-500/20" : "bg-red-500/5 border-red-500/20"}`}>
                <div className="text-[10px] text-muted-foreground mb-1">Spezzati ≤ 13%</div>
                <div className={`text-2xl font-bold ${result.summary.spezzatoPct <= 13 ? "text-green-400" : "text-red-400"}`}>
                  {result.summary.spezzatoPct}%
                </div>
                <div className="text-[10px] text-muted-foreground">{result.summary.byType.spezzato} su {result.summary.totalDriverShifts} autisti</div>
              </div>
              <div className={`rounded-lg p-3 border ${result.summary.avgWorkMin >= 380 && result.summary.avgWorkMin <= 420 ? "bg-green-500/5 border-green-500/20" : "bg-amber-500/5 border-amber-500/20"}`}>
                <div className="text-[10px] text-muted-foreground mb-1">Lavoro medio target 6h30–6h42</div>
                <div className={`text-2xl font-bold ${result.summary.avgWorkMin >= 380 && result.summary.avgWorkMin <= 420 ? "text-green-400" : "text-amber-400"}`}>
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
                      <div key={key} className={`rounded-lg p-2 border text-center ${pct === 100 ? "bg-green-500/5 border-green-500/20" : "bg-amber-500/5 border-amber-500/20"}`}>
                        <div className="text-[10px] text-muted-foreground mb-0.5">{label}</div>
                        <div className={`text-lg font-bold ${pct === 100 ? "text-green-400" : "text-amber-400"}`}>{pct}%</div>
                        <div className="text-[9px] text-muted-foreground">{ok}/{withBds.length}</div>
                      </div>
                    );
                  })}
                </div>
              );
            })()}
          </CardContent>
        </Card>

        {/* Gantt */}
        <Card className="bg-muted/30 border-border/30">
          <CardContent className="p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold flex items-center gap-1.5"><Timer className="w-4 h-4 text-primary" /> Diagramma Turni Guida</h3>
              <select value={typeFilter} onChange={e => setTypeFilter(e.target.value as any)} className="text-xs bg-background border border-border/50 rounded px-2 py-1">
                <option value="all">Tutti ({result.driverShifts.length})</option>
                {(Object.entries(result.summary.byType) as [DriverShiftType, number][])
                  .filter(([, c]) => c > 0)
                  .map(([type, count]) => (
                    <option key={type} value={type}>{TYPE_LABELS[type]} ({count})</option>
                  ))}
              </select>
            </div>
            {filteredShifts.length > 0 ? (
              <InteractiveGantt
                rows={driverGanttRows}
                bars={driverGanttBars}
                onBarChange={handleDriverGanttChange}
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
                <div className="w-0 h-0 border-l-[4px] border-r-[4px] border-t-[6px] border-l-transparent border-r-transparent border-t-cyan-400" />
                <span className="text-[10px] text-muted-foreground">Cambio in Linea</span>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Shift list */}
        <Card className="bg-muted/30 border-border/30">
          <CardContent className="p-4">
            <h3 className="text-sm font-semibold mb-3 flex items-center gap-1.5"><Users className="w-4 h-4 text-primary" /> Dettaglio Turni ({filteredShifts.length})</h3>
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
                          return <> · <span className={intraH > 0 ? "text-amber-400" : "text-cyan-400"}>{shift.cambiCount} cambi{icon}</span></>;
                        })()}
                        {shift.riprese.length > 0 && <> · {shift.riprese.reduce((s, r) => s + r.trips.length, 0)} corse</>}
                        {shift.costEuro != null && shift.costEuro > 0 && <> · <span className="text-emerald-400 font-medium">€{shift.costEuro.toFixed(0)}</span></>}
                      </span>
                      {/* BDS validation badge */}
                      {shift.bdsValidation && (
                        <span title={shift.bdsValidation.valid ? "Conforme BDS" : shift.bdsValidation.violations.join(", ")} className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${shift.bdsValidation.valid ? "bg-green-500/15 text-green-400" : "bg-red-500/15 text-red-400"}`}>
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
                                  lbl.startsWith("LASCIA") ? "bg-red-500/10 border-red-500/25 text-red-400" : "bg-green-500/10 border-green-500/25 text-green-400"
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
                                colorClass: "text-blue-400", bgClass: "bg-blue-500/8 border-blue-500/15",
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
                                colorClass: isIntra ? "text-amber-400" : "text-cyan-400",
                                bgClass: isIntra ? "bg-amber-500/10 border-amber-500/20" : "bg-cyan-500/10 border-cyan-500/20",
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
                                  colorClass: "text-cyan-400", bgClass: "bg-cyan-500/10 border-cyan-500/20",
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
                                colorClass: "text-emerald-400", bgClass: "bg-emerald-500/8 border-emerald-500/15",
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
                                colorClass: isIntraOut ? "text-amber-400" : "text-cyan-400",
                                bgClass: isIntraOut ? "bg-amber-500/10 border-amber-500/20" : "bg-cyan-500/10 border-cyan-500/20",
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
                                      <div className={`absolute left-[-5px] top-[7px] w-2 h-2 rounded-full ${act.type === "trip" ? "bg-emerald-400" : act.type === "sosta" ? "bg-amber-400" : act.type === "preturno" ? "bg-blue-400" : act.type === "handover" ? "bg-cyan-400" : "bg-orange-400"}`} />
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
                                <div className={`rounded-lg border p-3 ${shift.bdsValidation.valid ? "bg-green-500/5 border-green-500/20" : "bg-red-500/5 border-red-500/20"}`}>
                                  <div className="flex items-center gap-2 mb-2">
                                    <Shield className="w-3.5 h-3.5 text-primary" />
                                    <span className="text-xs font-semibold">Validazione BDS</span>
                                    <Badge variant="outline" className={`text-[9px] ${shift.bdsValidation.valid ? "border-green-500/40 text-green-400" : "border-red-500/40 text-red-400"}`}>
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
                                          <span className={val ? "text-green-400" : "text-red-400"}>{label}</span>
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
                                    <Clock className="w-3.5 h-3.5 text-primary" />
                                    <span className="text-xs font-semibold">Calcolo Lavoro BDS</span>
                                    <span className="text-[10px] text-muted-foreground ml-auto">
                                      Netto: <span className="font-semibold text-foreground">{formatDuration(shift.workCalculation.lavoroNetto)}</span>
                                      {" · "}Conv.: <span className="font-semibold text-foreground">{formatDuration(shift.workCalculation.lavoroConvenzionale)}</span>
                                    </span>
                                  </div>
                                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                                    {([
                                      ["driving", "Guida", "text-emerald-400"],
                                      ["idleAtTerminal", "Soste capolinea", "text-amber-400"],
                                      ["prePost", "Pre/Post turno", "text-blue-400"],
                                      ["transfer", "Trasferimenti", "text-orange-400"],
                                      ["sosteFraRipreseIR", "Soste IR (inter-rip.)", "text-purple-400"],
                                      ["sosteFraRipreseFR", "Soste FR (fra rip.)", "text-cyan-400"],
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
