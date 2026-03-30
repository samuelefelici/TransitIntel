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

/* ═══════════════════════════════════════════════════════════════
 *  TYPES
 * ═══════════════════════════════════════════════════════════════ */

type DriverShiftType = "intero" | "semiunico" | "spezzato" | "supplemento";

interface RipresaTrip {
  tripId: string;
  routeId: string;
  routeName: string;
  headsign: string | null;
  departureTime: string;
  arrivalTime: string;
  departureMin: number;
  arrivalMin: number;
  firstStopName?: string;
  lastStopName?: string;
  vehicleId?: string;
  vehicleType?: string;
}

interface CambioInLinea {
  cluster: string;
  clusterName: string;
  fromVehicle: string;
  toVehicle: string;
  atMin: number;
  atTime: string;
}

interface CarPoolInfo {
  carId?: number | null;
  departMin?: number;
  departTime?: string;
  arriveMin?: number;
  arriveTime?: string;
  description: string;
}

interface Ripresa {
  startTime: string;
  endTime: string;
  startMin: number;
  endMin: number;
  preTurnoMin: number;
  transferMin: number;
  transferType: string;
  transferToStop?: string;
  transferToCluster?: string | null;
  transferBackMin: number;
  transferBackType: string;
  lastStop?: string;
  lastCluster?: string | null;
  workMin: number;
  vehicleIds: string[];
  vehicleType?: string;
  cambi: CambioInLinea[];
  trips: RipresaTrip[];
  carPoolOut?: CarPoolInfo | null;
  carPoolReturn?: CarPoolInfo | null;
}

interface HandoverInfo {
  vehicleId: string;
  atMin: number;
  atTime: string;
  atStop: string;
  cluster: string | null;
  clusterName: string;
  role: "incoming" | "outgoing";
  otherDriver: string;
  description: string;
}

interface DriverShiftData {
  driverId: string;
  type: DriverShiftType;
  nastroStart: string;
  nastroEnd: string;
  nastroStartMin: number;
  nastroEndMin: number;
  nastroMin: number;
  nastro: string;
  workMin: number;
  work: string;
  interruptionMin: number;
  interruption: string | null;
  transferMin: number;
  transferBackMin: number;
  preTurnoMin: number;
  cambiCount: number;
  riprese: Ripresa[];
  handovers?: HandoverInfo[];
  vehicleHandoverLabels?: string[];
  /* v2 cost fields */
  costEuro?: number;
  costBreakdown?: Record<string, number>;
}

interface DriverShiftSummary {
  totalDriverShifts: number;  // Autisti = turni principali (intero + semiunico + spezzato)
  totalSupplementi?: number;   // Supplementi = straordinari
  totalShifts?: number;        // Tutti i turni
  byType: Record<DriverShiftType, number>;
  totalWorkHours: number;
  avgWorkMin: number;
  totalNastroHours: number;
  avgNastroMin: number;
  semiunicoPct: number;
  spezzatoPct: number;
  totalCambi: number;
  companyCarsUsed: number;
  /* v2 cost fields */
  totalDailyCost?: number;
  costBreakdown?: Record<string, number>;
  efficiency?: Record<string, number>;
}

interface ClusterInfo {
  id: string;
  name: string;
  transferMin: number;
}

interface DriverShiftsResult {
  scenarioId: string;
  scenarioName: string;
  date: string;
  driverShifts: DriverShiftData[];
  summary: DriverShiftSummary;
  unassignedBlocks: number;
  clusters: ClusterInfo[];
  companyCars: number;
  /* v2 cost fields */
  costAnalysis?: Record<string, any>;
  costRates?: Record<string, number>;
}

/* ═══════════════════════════════════════════════════════════════
 *  CONSTANTS
 * ═══════════════════════════════════════════════════════════════ */

const TYPE_LABELS: Record<DriverShiftType, string> = {
  intero: "Intero",
  semiunico: "Semiunico",
  spezzato: "Spezzato",
  supplemento: "Supplemento",
};

const TYPE_COLORS: Record<DriverShiftType, string> = {
  intero: "#3b82f6",
  semiunico: "#f59e0b",
  spezzato: "#ef4444",
  supplemento: "#8b5cf6",
};

const TYPE_ICONS: Record<DriverShiftType, React.ReactNode> = {
  intero: <Clock className="w-3.5 h-3.5" />,
  semiunico: <Coffee className="w-3.5 h-3.5" />,
  spezzato: <Timer className="w-3.5 h-3.5" />,
  supplemento: <Zap className="w-3.5 h-3.5" />,
};

const TYPE_DESC: Record<DriverShiftType, string> = {
  intero: "Nastro ≤ 7h15, unica ripresa",
  semiunico: "2 riprese, pausa 1h15–2h59, nastro ≤ 9h15",
  spezzato: "2 riprese, pausa ≥ 3h, nastro ≤ 10h30",
  supplemento: "Turno breve, max 2h30",
};

function ymdToDisplay(ymd: string): string {
  if (!ymd) return "";
  const y = ymd.slice(0, 4), m = ymd.slice(4, 6), d = ymd.slice(6, 8);
  return `${d}/${m}/${y}`;
}

function minToTime(min: number): string {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function formatDuration(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h}h${String(m).padStart(2, "0")}`;
}

/* ═══════════════════════════════════════════════════════════════
 *  SUMMARY CARD
 * ═══════════════════════════════════════════════════════════════ */

function SummaryCard({ icon, label, value, sub, color }: { icon: React.ReactNode; label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="flex items-center gap-3 bg-muted/30 rounded-xl px-4 py-3 border border-border/30">
      <div className="text-primary">{icon}</div>
      <div>
        <div className="text-[10px] text-muted-foreground">{label}</div>
        <div className="text-lg font-bold" style={{ color }}>{value}</div>
        {sub && <div className="text-[10px] text-muted-foreground">{sub}</div>}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
 *  GANTT CHART — Driver Shifts
 * ═══════════════════════════════════════════════════════════════ */

function DriverGantt({ shifts }: { shifts: DriverShiftData[] }) {
  if (shifts.length === 0) return <p className="text-sm text-muted-foreground text-center py-4">Nessun turno guida</p>;

  const minHour = Math.max(3, Math.floor(Math.min(...shifts.map(s => s.nastroStartMin)) / 60) - 1);
  const maxHour = Math.min(27, Math.ceil(Math.max(...shifts.map(s => s.nastroEndMin)) / 60) + 1);
  const totalMin = (maxHour - minHour) * 60;

  return (
    <div className="overflow-x-auto">
      <div className="min-w-[800px]">
        {/* Time header */}
        <div className="flex border-b border-border/30 mb-1">
          <div className="w-36 shrink-0" />
          <div className="flex-1 relative h-6">
            {Array.from({ length: maxHour - minHour + 1 }, (_, i) => {
              const h = minHour + i;
              const pct = (i * 60 / totalMin) * 100;
              return <span key={h} className="absolute text-[9px] text-muted-foreground" style={{ left: `${pct}%` }}>{h}:00</span>;
            })}
          </div>
        </div>

        {shifts.map(shift => {
          const typeColor = TYPE_COLORS[shift.type];
          return (
            <div key={shift.driverId} className="flex items-center h-8 group hover:bg-muted/20">
              <div className="w-36 shrink-0 text-[10px] font-mono flex items-center gap-1 px-1">
                <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ backgroundColor: typeColor }} />
                {shift.driverId}
                <span className="text-muted-foreground">({TYPE_LABELS[shift.type].slice(0, 3)})</span>
              </div>
              <div className="flex-1 relative h-6">
                {/* Grid lines */}
                {Array.from({ length: maxHour - minHour + 1 }, (_, i) => (
                  <div key={i} className="absolute top-0 bottom-0 border-l border-border/10"
                    style={{ left: `${(i * 60 / totalMin) * 100}%` }} />
                ))}

                {/* Riprese */}
                {shift.riprese.map((rip, ri) => {
                  const left = ((rip.startMin - minHour * 60) / totalMin) * 100;
                  const width = Math.max(0.3, ((rip.endMin - rip.startMin) / totalMin) * 100);

                  // Pre-turno block
                  const preTurnoWidth = (rip.preTurnoMin / totalMin) * 100;

                  // Transfer block  
                  const transferWidth = (rip.transferMin / totalMin) * 100;
                  const transferLeft = left + preTurnoWidth;

                  // Transfer back block
                  const transferBackWidth = ((rip.transferBackMin || 0) / totalMin) * 100;

                  // Trips block
                  const tripsLeft = transferLeft + transferWidth;
                  const tripsWidth = width - preTurnoWidth - transferWidth - transferBackWidth;

                  // Transfer back position
                  const transferBackLeft = tripsLeft + tripsWidth;

                  return (
                    <React.Fragment key={ri}>
                      {/* Pre-turno */}
                      <div className="absolute top-0.5 h-5 rounded-l-sm text-[7px] text-white/60 flex items-center justify-center"
                        style={{ left: `${left}%`, width: `${preTurnoWidth}%`, backgroundColor: typeColor, opacity: 0.35 }}
                        title={`Pre-turno ${rip.preTurnoMin}min`}
                      >{preTurnoWidth > 1.5 ? "PT" : ""}</div>

                      {/* Transfer */}
                      {rip.transferMin > 0 && (
                        <div className="absolute top-0.5 h-5 text-[7px] text-white/60 flex items-center justify-center"
                          style={{ left: `${transferLeft}%`, width: `${transferWidth}%`, backgroundColor: typeColor, opacity: 0.5 }}
                          title={`Trasf. deposito → ${rip.transferToStop || "capolinea"} ${rip.transferMin}min`}
                        >{transferWidth > 1.5 ? "↝" : ""}</div>
                      )}

                      {/* Service trips */}
                      <div className="absolute top-0.5 h-5 text-[8px] text-white flex items-center justify-center overflow-hidden whitespace-nowrap"
                        style={{ left: `${tripsLeft}%`, width: `${Math.max(0.2, tripsWidth)}%`, backgroundColor: typeColor, opacity: 0.85 }}
                        title={`${rip.trips.length} corse · ${minToTime(rip.startMin)}→${minToTime(rip.endMin)} · Veicolo: ${rip.vehicleIds.join(", ")}${rip.cambi?.length ? ` · ${rip.cambi.length} cambi in linea` : ""}`}
                      >{tripsWidth > 3 ? `${rip.trips.length} corse` : ""}</div>

                      {/* Transfer back (rientro al deposito) */}
                      {(rip.transferBackMin || 0) > 0 && (
                        <div className="absolute top-0.5 h-5 rounded-r-sm text-[7px] text-white/60 flex items-center justify-center"
                          style={{ left: `${transferBackLeft}%`, width: `${transferBackWidth}%`, backgroundColor: typeColor, opacity: 0.5 }}
                          title={`Rientro ${rip.lastStop || "capolinea"} → deposito ${rip.transferBackMin}min`}
                        >{transferBackWidth > 1.5 ? "↜" : ""}</div>
                      )}

                      {/* Cambio in linea markers */}
                      {rip.cambi?.map((c, ci) => {
                        const cLeft = ((c.atMin - minHour * 60) / totalMin) * 100;
                        return (
                          <div key={`c${ci}`} className="absolute"
                            style={{ left: `${cLeft}%`, top: "-2px" }}
                            title={`Cambio in linea @ ${c.clusterName}: ${c.fromVehicle}→${c.toVehicle}`}
                          >
                            <div className="w-0 h-0 border-l-[3px] border-r-[3px] border-t-[5px] border-l-transparent border-r-transparent border-t-cyan-400" />
                          </div>
                        );
                      })}
                    </React.Fragment>
                  );
                })}

                {/* Interruption gap indicator */}
                {shift.interruptionMin > 0 && shift.riprese.length === 2 && (
                  <div className="absolute top-2 h-2 rounded-full"
                    style={{
                      left: `${((shift.riprese[0].endMin - minHour * 60) / totalMin) * 100}%`,
                      width: `${((shift.riprese[1].startMin - shift.riprese[0].endMin) / totalMin) * 100}%`,
                      backgroundColor: "rgba(255,255,255,0.06)",
                      backgroundImage: "repeating-linear-gradient(90deg, transparent, transparent 4px, rgba(255,255,255,0.15) 4px, rgba(255,255,255,0.15) 8px)",
                    }}
                    title={`Interruzione ${shift.interruption}`}
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
 *  PAGE COMPONENT
 * ═══════════════════════════════════════════════════════════════ */

export default function DriverShiftsPage() {
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
            return (
              <SummaryCard icon={<Repeat className="w-4 h-4" />} label="Cambi in Linea" value={result.summary.totalCambi.toString()} sub={totalHandovers > 0 ? `${totalHandovers} cambi bus con auto aziendale` : `${result.driverShifts.filter(s => s.cambiCount > 0).length} turni con cambio`} color="#06b6d4" />
            );
          })()}
          <SummaryCard icon={<Car className="w-4 h-4" />} label="Auto Aziendali" value={`${result.summary.companyCarsUsed}/${result.companyCars}`} sub="per trasf. deposito ↔ cluster" />
          {result.summary.totalDailyCost != null && result.summary.totalDailyCost > 0 && (
            <SummaryCard icon={<DollarSign className="w-4 h-4" />} label="Costo Giornaliero" value={`€${result.summary.totalDailyCost.toLocaleString("it-IT", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`} sub={result.summary.efficiency?.costPerDriver ? `€${result.summary.efficiency.costPerDriver.toFixed(0)}/autista` : "ottimizzato"} color="#10b981" />
          )}
          {result.unassignedBlocks > 0 && (
            <SummaryCard icon={<AlertTriangle className="w-4 h-4" />} label="Non assegnati" value={result.unassignedBlocks.toString()} color="#ef4444" sub="blocchi rimasti" />
          )}
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
            <DriverGantt shifts={filteredShifts} />
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
                        {shift.nastroStart.slice(0, 5)} → {shift.nastroEnd.slice(0, 5)}
                      </span>
                      <span className="text-xs text-muted-foreground ml-auto">
                        Lavoro: {shift.work} · Nastro: {shift.nastro}
                        {shift.interruption && <> · Pausa: {shift.interruption}</>}
                        {shift.cambiCount > 0 && <> · <span className="text-cyan-400">{shift.cambiCount} cambi{(shift.handovers?.length ?? 0) > 0 ? " 🔄" : ""}</span></>}
                        {shift.riprese.length > 0 && <> · {shift.riprese.reduce((s, r) => s + r.trips.length, 0)} corse</>}
                        {shift.costEuro != null && shift.costEuro > 0 && <> · <span className="text-emerald-400 font-medium">€{shift.costEuro.toFixed(0)}</span></>}
                      </span>
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
                              activities.push({
                                type: "handover", startMin: incomingH.atMin, endMin: incomingH.atMin,
                                label: "🔄 Cambio bus (arrivo)",
                                detail: incomingH.description,
                                icon: <Repeat className="w-3.5 h-3.5" />,
                                colorClass: "text-cyan-400", bgClass: "bg-cyan-500/10 border-cyan-500/20",
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
                              activities.push({
                                type: "handover", startMin: outgoingH.atMin, endMin: outgoingH.atMin,
                                label: "🔄 Cambio bus (uscita)",
                                detail: outgoingH.description,
                                icon: <Repeat className="w-3.5 h-3.5" />,
                                colorClass: "text-cyan-400", bgClass: "bg-cyan-500/10 border-cyan-500/20",
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
                                    {rip.startTime.slice(0, 5)} → {rip.endTime.slice(0, 5)}
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
                                {shift.riprese[0].endTime.slice(0, 5)} → {shift.riprese[1].startTime.slice(0, 5)}
                              </span>
                              <span className="font-semibold text-amber-400">Interruzione</span>
                              <span className="text-muted-foreground">
                                {shift.interruption} — {shift.type === "semiunico" ? "non retribuita, in residenza" : "spezzato, riposo"}
                              </span>
                              <span className="ml-auto text-[10px] text-muted-foreground/60">{shift.interruptionMin} min</span>
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
