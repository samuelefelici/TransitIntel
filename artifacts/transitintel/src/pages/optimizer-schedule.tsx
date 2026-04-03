import React, { useState, useMemo, useCallback, useEffect } from "react";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip as ReTooltip, ResponsiveContainer, Cell,
  CartesianGrid, RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis, Radar, Legend,
} from "recharts";
import {
  Loader2, Clock, AlertTriangle, CheckCircle2, Play, Calendar,
  Bus, ArrowRightLeft, Filter, Download,
  Cpu, BarChart3, Award, MoveHorizontal, Star, Timer, Gauge,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { getApiBase } from "@/lib/api";

import type {
  Priority, SuggestionType, ScheduleResult, StrategyWeights, OptimizationOutput,
} from "./optimizer-schedule/types";
import {
  PRIORITY_COLORS, PRIORITY_LABELS, TYPE_LABELS,
  STRATEGY_COLORS, STRATEGY_LABELS, WEIGHT_LABELS,
  ymdToIso, ymdToDisplay, pct,
} from "./optimizer-schedule/constants";
import {
  SummaryCard, MiniMetric, SuggestionCard, DecisionCard, TripTimeline,
} from "./optimizer-schedule/components";

/* ═══════════════════════════════════════════════════════════════
 *  MAIN PAGE COMPONENT
 * ═══════════════════════════════════════════════════════════════ */

export default function OptimizerSchedulePage() {
  /* ── Shared state ── */
  const [availableDates, setAvailableDates] = useState<{ date: string; services: number }[]>([]);
  const [datesMode, setDatesMode] = useState<"calendar" | "calendar_dates" | null>(null);
  const [dateRange, setDateRange] = useState<{ min: string; max: string } | null>(null);
  const [selectedDate, setSelectedDate] = useState<string>("");
  const [loadingDates, setLoadingDates] = useState(true);

  /* ── Heuristic tab state ── */
  const [hResult, setHResult] = useState<ScheduleResult | null>(null);
  const [hLoading, setHLoading] = useState(false);
  const [hError, setHError] = useState<string | null>(null);
  const [filterPriority, setFilterPriority] = useState<Priority | "all">("all");
  const [filterType, setFilterType] = useState<SuggestionType | "all">("all");
  const [expandedCards, setExpandedCards] = useState<Set<string>>(new Set());

  /* ── CP-SAT tab state ── */
  const [optResult, setOptResult] = useState<OptimizationOutput | null>(null);
  const [optLoading, setOptLoading] = useState(false);
  const [optError, setOptError] = useState<string | null>(null);
  const [timeLimit, setTimeLimit] = useState(60);
  const [selectedStrategy, setSelectedStrategy] = useState<string | null>(null);
  const [showCustom, setShowCustom] = useState(false);
  const [customWeights, setCustomWeights] = useState<StrategyWeights>({
    cost: 0.30, regularity: 0.25, coverage: 0.25, overcrowd: 0.10, connections: 0.10,
  });
  const [decisionFilter, setDecisionFilter] = useState<"all" | "remove" | "shift">("all");

  /* ── Load available dates ── */
  useEffect(() => {
    (async () => {
      try {
        const resp = await fetch(`${getApiBase()}/api/optimizer/schedule/dates`);
        if (!resp.ok) return;
        const data = await resp.json();
        if (data.mode === "calendar") {
          setDatesMode("calendar");
          setDateRange({ min: ymdToIso(data.minDate), max: ymdToIso(data.maxDate) });
          const today = new Date().toISOString().slice(0, 10);
          setSelectedDate(today >= ymdToIso(data.minDate) && today <= ymdToIso(data.maxDate) ? today : ymdToIso(data.minDate));
        } else {
          setDatesMode("calendar_dates");
          setAvailableDates(data.dates || []);
          const best = (data.dates || []).sort((a: any, b: any) => b.services - a.services)[0];
          if (best) setSelectedDate(ymdToIso(best.date));
        }
      } catch { /* ignore */ }
      finally { setLoadingDates(false); }
    })();
  }, []);

  /* ── Heuristic run ── */
  const runHeuristic = useCallback(async () => {
    if (!selectedDate) return;
    setHLoading(true); setHError(null); setHResult(null);
    try {
      const resp = await fetch(`${getApiBase()}/api/optimizer/schedule`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date: selectedDate }),
      });
      if (!resp.ok) throw new Error((await resp.json().catch(() => ({}))).error || `Errore ${resp.status}`);
      setHResult(await resp.json());
    } catch (e: any) { setHError(e.message); }
    finally { setHLoading(false); }
  }, [selectedDate]);

  /* ── CP-SAT run ── */
  const runOptimizer = useCallback(async () => {
    if (!selectedDate) return;
    setOptLoading(true); setOptError(null); setOptResult(null); setSelectedStrategy(null);
    try {
      const body: any = { date: selectedDate, timeLimitSeconds: timeLimit };
      if (showCustom) {
        body.customStrategy = {
          name: "custom",
          description: "Strategia personalizzata",
          weights: customWeights,
        };
      }
      const resp = await fetch(`${getApiBase()}/api/optimizer/schedule/optimize`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!resp.ok) throw new Error((await resp.json().catch(() => ({}))).error || `Errore ${resp.status}`);
      const data: OptimizationOutput = await resp.json();
      setOptResult(data);
      setSelectedStrategy(data.bestStrategy);
    } catch (e: any) { setOptError(e.message); }
    finally { setOptLoading(false); }
  }, [selectedDate, timeLimit, showCustom, customWeights]);

  /* ── Filtered data ── */
  const filteredSuggestions = useMemo(() => {
    if (!hResult) return [];
    return hResult.suggestions.filter(s =>
      (filterPriority === "all" || s.priority === filterPriority) &&
      (filterType === "all" || s.type === filterType)
    );
  }, [hResult, filterPriority, filterType]);

  const hourlyChartData = useMemo(() => {
    if (!hResult) return [];
    return hResult.hourlyDist.map(h => ({ ora: `${h.hour}:00`, corse: h.trips, domanda: h.demand }));
  }, [hResult]);

  const topRoutes = useMemo(() => {
    if (!hResult) return [];
    return [...hResult.routeStats].sort((a, b) => b.totalTrips - a.totalTrips).slice(0, 15);
  }, [hResult]);

  const activeStrategyResult = useMemo(() => {
    if (!optResult || !selectedStrategy) return null;
    return optResult.results.find(r => r.strategy.name === selectedStrategy) ?? null;
  }, [optResult, selectedStrategy]);

  const filteredDecisions = useMemo(() => {
    if (!activeStrategyResult) return [];
    const d = activeStrategyResult.decisions;
    if (decisionFilter === "all") return d;
    return d.filter(dd => dd.action === decisionFilter);
  }, [activeStrategyResult, decisionFilter]);

  /* ── Radar data ── */
  const radarData = useMemo(() => {
    if (!optResult) return [];
    const axes = [
      { axis: "Risparmio", key: "savings" },
      { axis: "Regolarità", key: "regularity" },
      { axis: "Copertura", key: "coverage" },
      { axis: "Anti-sovraffollamento", key: "overcrowd" },
    ];
    const maxRemoved = Math.max(...optResult.results.map(r => r.metrics.tripsRemoved), 1);
    return axes.map(a => {
      const row: any = { axis: a.axis };
      for (const r of optResult.results) {
        const m = r.metrics;
        const name = r.strategy.name;
        if (a.key === "savings") row[name] = +(m.tripsRemoved / maxRemoved * 100).toFixed(1);
        else if (a.key === "regularity") row[name] = +(m.regularityScore * 100).toFixed(1);
        else if (a.key === "coverage") row[name] = +(m.coverageScore * 100).toFixed(1);
        else if (a.key === "overcrowd") row[name] = +((1 - m.overcrowdingRisk) * 100).toFixed(1);
      }
      return row;
    });
  }, [optResult]);

  const toggleCard = (id: string) => {
    setExpandedCards(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  /* ── CSV export ── */
  const exportCsv = useCallback(() => {
    if (!activeStrategyResult) return;
    const rows = [["trip_id", "route", "action", "original_departure", "new_departure", "shift_min", "reason"]];
    for (const d of activeStrategyResult.decisions) {
      rows.push([d.tripId, d.routeName, d.action, d.originalDeparture, d.newDeparture || "", String(d.shiftMinutes), d.reason]);
    }
    const csv = rows.map(r => r.map(c => `"${c}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `cpsat_${selectedStrategy}_${selectedDate}.csv`;
    a.click(); URL.revokeObjectURL(url);
  }, [activeStrategyResult, selectedStrategy, selectedDate]);

  /* ═══════════════════════════════════════════════════════════════
   *  RENDER
   * ═══════════════════════════════════════════════════════════════ */
  return (
    <div className="h-[calc(100vh-3.5rem)] md:h-screen overflow-y-auto">
      <div className="max-w-7xl mx-auto p-4 md:p-6 space-y-6">
        {/* Header */}
        <div>
          <h1 className="text-xl font-bold flex items-center gap-2">
            <Clock className="w-5 h-5 text-primary" />
            Ottimizzatore Orari
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Analisi euristica e ottimizzazione CP-SAT multi-strategia delle corse GTFS
          </p>
        </div>

        {/* Date picker (shared) */}
        <Card className="bg-muted/30 border-border/30">
          <CardContent className="p-4 flex flex-wrap items-end gap-4">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Data di analisi</label>
              {loadingDates ? (
                <div className="flex items-center gap-2 text-xs text-muted-foreground py-1.5">
                  <Loader2 className="w-3 h-3 animate-spin" /> Caricamento date…
                </div>
              ) : datesMode === "calendar_dates" && availableDates.length > 0 ? (
                <select value={selectedDate} onChange={e => setSelectedDate(e.target.value)}
                  className="bg-background border border-border/50 rounded-md px-3 py-1.5 text-sm max-w-[280px]">
                  <option value="">— Seleziona una data —</option>
                  {availableDates.map(d => {
                    const iso = ymdToIso(d.date);
                    const dayName = new Date(iso + "T12:00:00").toLocaleDateString("it-IT", { weekday: "short" });
                    return <option key={d.date} value={iso}>{ymdToDisplay(d.date)} ({dayName}) — {d.services} servizi</option>;
                  })}
                </select>
              ) : (
                <input type="date" value={selectedDate} onChange={e => setSelectedDate(e.target.value)}
                  min={dateRange?.min} max={dateRange?.max}
                  className="bg-background border border-border/50 rounded-md px-3 py-1.5 text-sm" />
              )}
            </div>
            {datesMode === "calendar_dates" && (
              <span className="text-xs text-muted-foreground">{availableDates.length} date disponibili</span>
            )}
          </CardContent>
        </Card>

        {/* TABS */}
        <Tabs defaultValue="cpsat" className="w-full">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="cpsat" className="gap-2">
              <Cpu className="w-4 h-4" /> CP-SAT Optimizer
            </TabsTrigger>
            <TabsTrigger value="heuristic" className="gap-2">
              <BarChart3 className="w-4 h-4" /> Analisi Euristica
            </TabsTrigger>
          </TabsList>

          {/* ═══════════════════════════════════════════════════════
           *  TAB 1: CP-SAT OPTIMIZER
           * ═══════════════════════════════════════════════════════ */}
          <TabsContent value="cpsat" className="space-y-6 mt-4">
            {/* Config row */}
            <Card className="bg-muted/30 border-border/30">
              <CardContent className="p-4 space-y-4">
                <div className="flex flex-wrap items-end gap-4">
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-muted-foreground">Tempo limite solver (sec)</label>
                    <input type="number" min={10} max={300} value={timeLimit} onChange={e => setTimeLimit(+e.target.value)}
                      className="bg-background border border-border/50 rounded-md px-3 py-1.5 text-sm w-24" />
                  </div>
                  <label className="flex items-center gap-2 text-xs cursor-pointer">
                    <input type="checkbox" checked={showCustom} onChange={e => setShowCustom(e.target.checked)}
                      className="rounded border-border" />
                    Aggiungi strategia personalizzata
                  </label>
                  <button onClick={runOptimizer} disabled={optLoading || !selectedDate}
                    className="flex items-center gap-2 bg-primary text-primary-foreground py-2 px-5 rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50 ml-auto">
                    {optLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Cpu className="w-4 h-4" />}
                    {optLoading ? "Ottimizzazione in corso…" : "Avvia CP-SAT"}
                  </button>
                </div>

                {/* Custom weights */}
                {showCustom && (
                  <div className="grid grid-cols-5 gap-3 pt-2 border-t border-border/20">
                    {(Object.keys(customWeights) as (keyof StrategyWeights)[]).map(k => (
                      <div key={k} className="space-y-1">
                        <label className="text-[10px] text-muted-foreground">{WEIGHT_LABELS[k]}</label>
                        <input type="range" min={0} max={100} value={customWeights[k] * 100}
                          onChange={e => setCustomWeights(prev => ({ ...prev, [k]: +e.target.value / 100 }))}
                          className="w-full h-1.5 accent-pink-500" />
                        <div className="text-[10px] text-center font-mono">{(customWeights[k] * 100).toFixed(0)}%</div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            {optError && (
              <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3 text-sm text-red-400">
                <AlertTriangle className="w-4 h-4 inline mr-1" /> {optError}
              </div>
            )}

            {optResult && (
              <>
                {/* Summary cards */}
                <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3">
                  <SummaryCard icon={<Bus className="w-4 h-4" />} label="Corse input" value={optResult.inputSummary.totalTrips.toLocaleString()} />
                  <SummaryCard icon={<ArrowRightLeft className="w-4 h-4" />} label="Linee×Dir" value={optResult.inputSummary.routeDirections.toString()} />
                  <SummaryCard icon={<Cpu className="w-4 h-4" />} label="Strategie" value={optResult.inputSummary.strategiesTested.toString()} />
                  <SummaryCard icon={<Timer className="w-4 h-4" />} label="Tempo totale"
                    value={`${(optResult.totalSolveTimeMs / 1000).toFixed(1)}s`} />
                  <SummaryCard icon={<Award className="w-4 h-4" />} label="Migliore"
                    value={STRATEGY_LABELS[optResult.bestStrategy] || optResult.bestStrategy}
                    color={STRATEGY_COLORS[optResult.bestStrategy]} />
                  <SummaryCard icon={<Star className="w-4 h-4" />} label="Fronte Pareto"
                    value={`${optResult.paretoFront.length} strat.`} color="#a855f7" />
                  <SummaryCard icon={<MoveHorizontal className="w-4 h-4" />} label="Max shift"
                    value={`±${optResult.inputSummary.maxShiftMinutes} min`} />
                </div>

                {/* Strategy selector pills */}
                <div className="flex flex-wrap gap-2">
                  {optResult.results.map(r => {
                    const name = r.strategy.name;
                    const active = selectedStrategy === name;
                    const isPareto = optResult.paretoFront.includes(name);
                    const isBest = r.isBest;
                    return (
                      <button key={name} onClick={() => setSelectedStrategy(name)}
                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border transition-all ${
                          active ? "ring-2 ring-offset-1 ring-offset-background" : "opacity-70 hover:opacity-100"
                        }`}
                        style={{
                          borderColor: STRATEGY_COLORS[name] || "#666",
                          backgroundColor: active ? `${STRATEGY_COLORS[name] || "#666"}20` : "transparent",
                          color: STRATEGY_COLORS[name] || "#ccc",
                        }}>
                        {isBest && <Award className="w-3 h-3" />}
                        {isPareto && !isBest && <Star className="w-3 h-3" />}
                        {STRATEGY_LABELS[name] || name}
                        <span className="opacity-60">−{r.metrics.tripsRemoved}</span>
                      </button>
                    );
                  })}
                </div>

                {/* Radar chart + Comparison table row */}
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  {/* Radar */}
                  <Card className="bg-muted/20 border-border/30">
                    <CardContent className="p-4">
                      <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
                        <Gauge className="w-4 h-4" /> Confronto Strategie (Radar)
                      </h3>
                      <ResponsiveContainer width="100%" height={300}>
                        <RadarChart data={radarData}>
                          <PolarGrid stroke="#333" />
                          <PolarAngleAxis dataKey="axis" tick={{ fontSize: 10, fill: "#999" }} />
                          <PolarRadiusAxis angle={30} domain={[0, 100]} tick={{ fontSize: 8, fill: "#666" }} />
                          {optResult.results.map(r => (
                            <Radar key={r.strategy.name}
                              name={STRATEGY_LABELS[r.strategy.name] || r.strategy.name}
                              dataKey={r.strategy.name}
                              stroke={STRATEGY_COLORS[r.strategy.name] || "#666"}
                              fill={STRATEGY_COLORS[r.strategy.name] || "#666"}
                              fillOpacity={selectedStrategy === r.strategy.name ? 0.25 : 0.05}
                              strokeWidth={selectedStrategy === r.strategy.name ? 2.5 : 1}
                              strokeOpacity={selectedStrategy === r.strategy.name ? 1 : 0.4}
                            />
                          ))}
                          <Legend wrapperStyle={{ fontSize: 10 }} />
                        </RadarChart>
                      </ResponsiveContainer>
                    </CardContent>
                  </Card>

                  {/* Comparison table */}
                  <Card className="bg-muted/20 border-border/30">
                    <CardContent className="p-4">
                      <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
                        <BarChart3 className="w-4 h-4" /> Tabella Comparativa
                      </h3>
                      <div className="overflow-x-auto">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="border-b border-border/30">
                              <th className="text-left py-1.5 px-2 text-muted-foreground font-medium">Strategia</th>
                              <th className="text-right py-1.5 px-2 text-muted-foreground font-medium">Rimosse</th>
                              <th className="text-right py-1.5 px-2 text-muted-foreground font-medium">Spostate</th>
                              <th className="text-right py-1.5 px-2 text-muted-foreground font-medium">Risp. (h)</th>
                              <th className="text-right py-1.5 px-2 text-muted-foreground font-medium">Regolarità</th>
                              <th className="text-right py-1.5 px-2 text-muted-foreground font-medium">Copertura</th>
                              <th className="text-right py-1.5 px-2 text-muted-foreground font-medium">Sovraffoll.</th>
                              <th className="text-center py-1.5 px-2 text-muted-foreground font-medium">Pareto</th>
                            </tr>
                          </thead>
                          <tbody>
                            {Object.entries(optResult.comparisonMatrix).map(([name, c]) => {
                              const isSel = selectedStrategy === name;
                              const isBest = optResult.bestStrategy === name;
                              return (
                                <tr key={name}
                                  onClick={() => setSelectedStrategy(name)}
                                  className={`border-b border-border/10 cursor-pointer transition-colors ${
                                    isSel ? "bg-primary/10" : "hover:bg-muted/20"
                                  }`}>
                                  <td className="py-1.5 px-2 font-medium" style={{ color: STRATEGY_COLORS[name] }}>
                                    {isBest && <Award className="w-3 h-3 inline mr-1" />}
                                    {STRATEGY_LABELS[name] || name}
                                  </td>
                                  <td className="py-1.5 px-2 text-right font-mono">{c.tripsRemoved}</td>
                                  <td className="py-1.5 px-2 text-right font-mono">{c.tripsShifted}</td>
                                  <td className="py-1.5 px-2 text-right font-mono">{c.savingsHours}</td>
                                  <td className="py-1.5 px-2 text-right font-mono">{pct(c.regularityScore)}</td>
                                  <td className="py-1.5 px-2 text-right font-mono">{pct(c.coverageScore)}</td>
                                  <td className="py-1.5 px-2 text-right font-mono"
                                    style={{ color: c.overcrowdingRisk > 0.2 ? "#ef4444" : c.overcrowdingRisk > 0.1 ? "#f59e0b" : "#22c55e" }}>
                                    {pct(c.overcrowdingRisk)}
                                  </td>
                                  <td className="py-1.5 px-2 text-center">
                                    {c.paretoRank === 0 ? <Star className="w-3 h-3 text-yellow-400 inline" /> : "—"}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </CardContent>
                  </Card>
                </div>

                {/* Route before/after chart */}
                {optResult.routeBeforeAfter.length > 0 && (
                  <Card className="bg-muted/20 border-border/30">
                    <CardContent className="p-4">
                      <h3 className="text-sm font-semibold mb-3">Corse per linea — Prima / Dopo ({STRATEGY_LABELS[optResult.bestStrategy] || optResult.bestStrategy})</h3>
                      <ResponsiveContainer width="100%" height={Math.max(200, optResult.routeBeforeAfter.length * 28)}>
                        <BarChart data={optResult.routeBeforeAfter} layout="vertical">
                          <CartesianGrid strokeDasharray="3 3" stroke="#333" />
                          <XAxis type="number" tick={{ fontSize: 10, fill: "#999" }} />
                          <YAxis dataKey="routeName" type="category" width={55} tick={{ fontSize: 9, fill: "#999" }} />
                          <ReTooltip contentStyle={{ backgroundColor: "#1a1a2e", border: "1px solid #333", borderRadius: 8, fontSize: 11 }} />
                          <Bar dataKey="before" name="Prima" fill="#3b82f6" radius={[0, 4, 4, 0]} fillOpacity={0.4} />
                          <Bar dataKey="after" name="Dopo" fill="#22c55e" radius={[0, 4, 4, 0]} />
                          <Legend wrapperStyle={{ fontSize: 10 }} />
                        </BarChart>
                      </ResponsiveContainer>
                    </CardContent>
                  </Card>
                )}

                {/* Strategy detail */}
                {activeStrategyResult && (
                  <Card className="bg-muted/20 border-border/30">
                    <CardContent className="p-4 space-y-4">
                      <div className="flex items-center justify-between">
                        <div>
                          <h3 className="text-sm font-semibold flex items-center gap-2"
                            style={{ color: STRATEGY_COLORS[activeStrategyResult.strategy.name] }}>
                            {activeStrategyResult.isBest && <Award className="w-4 h-4" />}
                            {STRATEGY_LABELS[activeStrategyResult.strategy.name] || activeStrategyResult.strategy.name}
                            {activeStrategyResult.paretoRank === 0 && (
                              <Badge variant="outline" className="text-[10px] border-yellow-500 text-yellow-400">Pareto</Badge>
                            )}
                          </h3>
                          <p className="text-xs text-muted-foreground mt-0.5">{activeStrategyResult.strategy.description}</p>
                        </div>
                        <div className="flex items-center gap-2">
                          <Badge variant="secondary" className="text-[10px]">
                            {activeStrategyResult.metrics.solverStatus}
                          </Badge>
                          <Badge variant="secondary" className="text-[10px]">
                            {(activeStrategyResult.metrics.solveTimeMs / 1000).toFixed(1)}s
                          </Badge>
                        </div>
                      </div>

                      {/* Metrics row */}
                      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
                        <MiniMetric label="Corse rimosse" value={activeStrategyResult.metrics.tripsRemoved}
                          sub={`di ${activeStrategyResult.metrics.totalTripsOriginal}`} color="#ef4444" />
                        <MiniMetric label="Corse spostate" value={activeStrategyResult.metrics.tripsShifted} color="#f59e0b" />
                        <MiniMetric label="Risparmio" value={`${Math.round(activeStrategyResult.metrics.savingsMinutes / 60)}h`}
                          sub={`${activeStrategyResult.metrics.savingsMinutes} min`} color="#22c55e" />
                        <MiniMetric label="Regolarità" value={pct(activeStrategyResult.metrics.regularityScore)}
                          color={activeStrategyResult.metrics.regularityScore > 0.7 ? "#22c55e" : "#f59e0b"} />
                        <MiniMetric label="Copertura" value={pct(activeStrategyResult.metrics.coverageScore)}
                          color={activeStrategyResult.metrics.coverageScore > 0.8 ? "#22c55e" : "#f59e0b"} />
                        <MiniMetric label="Rischio sovraffollamento" value={pct(activeStrategyResult.metrics.overcrowdingRisk)}
                          color={activeStrategyResult.metrics.overcrowdingRisk < 0.1 ? "#22c55e" : "#ef4444"} />
                      </div>

                      {/* Weight bars */}
                      <div className="flex items-center gap-4">
                        <span className="text-[10px] text-muted-foreground font-medium shrink-0">Pesi:</span>
                        <div className="flex-1 flex gap-1 h-4 rounded overflow-hidden">
                          {(Object.entries(activeStrategyResult.strategy.weights) as [string, number][]).map(([k, v]) => (
                            <div key={k} className="relative group" style={{
                              width: `${v * 100}%`,
                              backgroundColor: k === "cost" ? "#ef4444" : k === "regularity" ? "#a855f7" :
                                k === "coverage" ? "#22c55e" : k === "overcrowd" ? "#f59e0b" : "#3b82f6",
                              minWidth: v > 0 ? 4 : 0,
                            }}>
                              <div className="absolute bottom-full mb-1 left-1/2 -translate-x-1/2 bg-background border border-border rounded px-1.5 py-0.5 text-[9px] whitespace-nowrap hidden group-hover:block z-10">
                                {WEIGHT_LABELS[k]}: {(v * 100).toFixed(0)}%
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>

                      {/* Decisions filter + export */}
                      <div className="flex items-center justify-between pt-2 border-t border-border/20">
                        <div className="flex items-center gap-2">
                          <Filter className="w-3.5 h-3.5 text-muted-foreground" />
                          {(["all", "remove", "shift"] as const).map(f => (
                            <button key={f} onClick={() => setDecisionFilter(f)}
                              className={`px-2 py-0.5 rounded text-[10px] font-medium border transition-all ${
                                decisionFilter === f ? "bg-primary/20 border-primary text-primary" : "border-border/30 text-muted-foreground"
                              }`}>
                              {f === "all" ? "Tutte" : f === "remove" ? "Rimosse" : "Spostate"} ({
                                f === "all" ? activeStrategyResult.decisions.length :
                                activeStrategyResult.decisions.filter(d => d.action === f).length
                              })
                            </button>
                          ))}
                        </div>
                        <button onClick={exportCsv}
                          className="flex items-center gap-1.5 px-3 py-1 rounded-md text-xs bg-muted/30 hover:bg-muted/50 transition-colors">
                          <Download className="w-3.5 h-3.5" /> Esporta CSV
                        </button>
                      </div>

                      {/* Trip timeline */}
                      <TripTimeline decisions={activeStrategyResult.decisions}
                        strategyColor={STRATEGY_COLORS[activeStrategyResult.strategy.name] || "#3b82f6"} />

                      {/* Decision cards */}
                      <div className="space-y-1.5 max-h-[400px] overflow-y-auto pr-1">
                        {filteredDecisions.slice(0, 100).map((d, i) => (
                          <DecisionCard key={i} decision={d} />
                        ))}
                        {filteredDecisions.length > 100 && (
                          <div className="text-center text-xs text-muted-foreground py-2">
                            …e altre {filteredDecisions.length - 100} decisioni. Esporta CSV per la lista completa.
                          </div>
                        )}
                        {filteredDecisions.length === 0 && (
                          <div className="text-center py-4 text-muted-foreground text-xs">
                            Nessuna decisione per questo filtro
                          </div>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                )}
              </>
            )}

            {/* CP-SAT empty state */}
            {!optResult && !optLoading && !optError && (
              <div className="text-center py-16 text-muted-foreground">
                <Cpu className="w-16 h-16 mx-auto mb-4 opacity-20" />
                <p className="text-sm">Seleziona una data e premi "Avvia CP-SAT"</p>
                <p className="text-xs mt-1">Il solver testerà 5 strategie e selezionerà il fronte Pareto</p>
              </div>
            )}
          </TabsContent>

          {/* ═══════════════════════════════════════════════════════
           *  TAB 2: HEURISTIC ANALYSIS
           * ═══════════════════════════════════════════════════════ */}
          <TabsContent value="heuristic" className="space-y-6 mt-4">
            <Card className="bg-muted/30 border-border/30">
              <CardContent className="p-4 flex flex-wrap items-end gap-4">
                <button onClick={runHeuristic} disabled={hLoading || !selectedDate}
                  className="flex items-center gap-2 bg-primary text-primary-foreground py-2 px-4 rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50">
                  {hLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                  {hLoading ? "Analisi in corso…" : "Avvia Analisi Euristica"}
                </button>
              </CardContent>
            </Card>

            {hError && (
              <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3 text-sm text-red-400">
                <AlertTriangle className="w-4 h-4 inline mr-1" /> {hError}
              </div>
            )}

            {hResult && (
              <>
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
                  <SummaryCard icon={<Calendar className="w-4 h-4" />} label="Data"
                    value={hResult.summary.date ? ymdToDisplay(hResult.summary.date) : "—"} />
                  <SummaryCard icon={<Bus className="w-4 h-4" />} label="Corse attive" value={hResult.summary.totalTrips.toLocaleString()} />
                  <SummaryCard icon={<ArrowRightLeft className="w-4 h-4" />} label="Linee" value={hResult.summary.totalRoutes.toString()} />
                  <SummaryCard icon={<Calendar className="w-4 h-4" />} label="Servizi attivi" value={hResult.summary.activeServices.toString()} />
                  <SummaryCard icon={<AlertTriangle className="w-4 h-4" />} label="Suggerimenti"
                    value={hResult.summary.suggestionsCount.total.toString()}
                    color={hResult.summary.suggestionsCount.critical > 0 ? "#ef4444" : "#f59e0b"} />
                  <SummaryCard icon={<Timer className="w-4 h-4" />} label="Risparmio stimato"
                    value={`${Math.round(hResult.summary.totalSavingsMinutes / 60)}h ${hResult.summary.totalSavingsMinutes % 60}m`} color="#22c55e" />
                </div>

                <div className="flex flex-wrap gap-2">
                  {(["critical", "high", "medium", "low"] as Priority[]).map(p => {
                    const cnt = hResult.summary.suggestionsCount[p];
                    if (cnt === 0) return null;
                    return (
                      <Badge key={p} variant="outline" className="text-xs cursor-pointer"
                        style={{ borderColor: PRIORITY_COLORS[p], color: PRIORITY_COLORS[p] }}
                        onClick={() => setFilterPriority(filterPriority === p ? "all" : p)}>
                        {PRIORITY_LABELS[p]}: {cnt}
                      </Badge>
                    );
                  })}
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  <Card className="bg-muted/20 border-border/30">
                    <CardContent className="p-4">
                      <h3 className="text-sm font-semibold mb-3">Distribuzione corse per ora</h3>
                      <ResponsiveContainer width="100%" height={200}>
                        <BarChart data={hourlyChartData}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#333" />
                          <XAxis dataKey="ora" tick={{ fontSize: 10, fill: "#999" }} />
                          <YAxis tick={{ fontSize: 10, fill: "#999" }} />
                          <ReTooltip contentStyle={{ backgroundColor: "#1a1a2e", border: "1px solid #333", borderRadius: 8, fontSize: 11 }} />
                          <Bar dataKey="corse" name="Corse" radius={[4, 4, 0, 0]}>
                            {hourlyChartData.map((entry, idx) => (
                              <Cell key={idx} fill={entry.corse > 20 ? "#ef4444" : entry.corse > 10 ? "#f59e0b" : "#3b82f6"} />
                            ))}
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    </CardContent>
                  </Card>

                  <Card className="bg-muted/20 border-border/30">
                    <CardContent className="p-4">
                      <h3 className="text-sm font-semibold mb-3">Corse per linea (top 15)</h3>
                      <ResponsiveContainer width="100%" height={200}>
                        <BarChart data={topRoutes} layout="vertical">
                          <CartesianGrid strokeDasharray="3 3" stroke="#333" />
                          <XAxis type="number" tick={{ fontSize: 10, fill: "#999" }} />
                          <YAxis dataKey="routeName" type="category" width={60} tick={{ fontSize: 9, fill: "#999" }} />
                          <ReTooltip contentStyle={{ backgroundColor: "#1a1a2e", border: "1px solid #333", borderRadius: 8, fontSize: 11 }}
                            formatter={(v: any, name: string) => [v, name === "totalTrips" ? "Corse" : name === "peakTrips" ? "Picco" : name]} />
                          <Bar dataKey="totalTrips" name="Corse" fill="#3b82f6" radius={[0, 4, 4, 0]} />
                          <Bar dataKey="peakTrips" name="Picco" fill="#f59e0b" radius={[0, 4, 4, 0]} />
                        </BarChart>
                      </ResponsiveContainer>
                    </CardContent>
                  </Card>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <Filter className="w-4 h-4 text-muted-foreground" />
                  <select value={filterType} onChange={e => setFilterType(e.target.value as any)}
                    className="bg-background border border-border/50 rounded-md px-2 py-1 text-xs">
                    <option value="all">Tutti i tipi</option>
                    {(Object.keys(TYPE_LABELS) as SuggestionType[]).map(t => (
                      <option key={t} value={t}>{TYPE_LABELS[t]}</option>
                    ))}
                  </select>
                  <select value={filterPriority} onChange={e => setFilterPriority(e.target.value as any)}
                    className="bg-background border border-border/50 rounded-md px-2 py-1 text-xs">
                    <option value="all">Tutte le priorità</option>
                    {(["critical", "high", "medium", "low"] as Priority[]).map(p => (
                      <option key={p} value={p}>{PRIORITY_LABELS[p]}</option>
                    ))}
                  </select>
                  <span className="text-xs text-muted-foreground ml-2">{filteredSuggestions.length} suggerimenti</span>
                </div>

                <div className="space-y-2">
                  {filteredSuggestions.map(s => (
                    <SuggestionCard key={s.id} suggestion={s} expanded={expandedCards.has(s.id)} onToggle={() => toggleCard(s.id)} />
                  ))}
                  {filteredSuggestions.length === 0 && (
                    <div className="text-center py-8 text-muted-foreground text-sm">
                      <CheckCircle2 className="w-8 h-8 mx-auto mb-2 opacity-30" />
                      Nessun suggerimento per i filtri selezionati
                    </div>
                  )}
                </div>
              </>
            )}

            {!hResult && !hLoading && !hError && (
              <div className="text-center py-16 text-muted-foreground">
                <Clock className="w-16 h-16 mx-auto mb-4 opacity-20" />
                <p className="text-sm">Premi "Avvia Analisi Euristica" per identificare criticità nel palinsesto</p>
              </div>
            )}
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
