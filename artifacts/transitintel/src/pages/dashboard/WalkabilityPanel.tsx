import React from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, Tooltip as ReTooltip,
  ResponsiveContainer,
} from "recharts";
import { Footprints, Loader2, Play, ChevronDown, ChevronUp } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import type { WalkData } from "./types";

interface WalkabilityPanelProps {
  open: boolean;
  onToggle: () => void;
  walkData: WalkData | null;
  walkLoading: boolean;
  walkMinutes: number;
  onWalkMinutesChange: (m: number) => void;
  onRun: () => void;
  selectedRouteCount: number;
  walkDonut: { name: string; value: number; fill: string }[];
  walkBars: { name: string; full: string; pop: number }[];
}

export function WalkabilityPanel({
  open, onToggle, walkData, walkLoading, walkMinutes,
  onWalkMinutesChange, onRun, selectedRouteCount, walkDonut, walkBars,
}: WalkabilityPanelProps) {
  return (
    <div className="absolute bottom-6 left-4 w-80 pointer-events-auto z-10">
      <Card className="bg-card/90 backdrop-blur-xl border-border/50 shadow-2xl overflow-hidden">
        <button
          onClick={onToggle}
          className="w-full px-3 py-2.5 flex items-center justify-between hover:bg-muted/20 transition-colors"
        >
          <span className="flex items-center gap-2 text-xs font-semibold">
            <Footprints className="w-3.5 h-3.5 text-blue-400" />
            Copertura Pedonale
            {walkData && (
              <span className="text-[10px] font-bold text-blue-400 bg-blue-500/10 px-1.5 py-0.5 rounded">
                {walkData.coveragePercent}%
              </span>
            )}
          </span>
          {open ? <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" /> : <ChevronUp className="w-3.5 h-3.5 text-muted-foreground" />}
        </button>
        <AnimatePresence initial={false}>
          {open && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="overflow-hidden"
            >
              <CardContent className="px-3 pb-3 pt-0 space-y-3 border-t border-border/30">
                {/* Controls */}
                <div className="flex items-center gap-2 pt-2">
                  <span className="text-[10px] text-muted-foreground shrink-0">Raggio:</span>
                  {[5, 10, 15].map(m => (
                    <button key={m} onClick={() => onWalkMinutesChange(m)}
                      className={`px-2 py-1 rounded text-[10px] font-medium border transition-all ${
                        walkMinutes === m ? "bg-blue-500/20 text-blue-400 border-blue-500/40" : "border-border/30 text-muted-foreground hover:bg-muted/30"
                      }`}>{m} min</button>
                  ))}
                  <button onClick={onRun} disabled={walkLoading}
                    className="ml-auto flex items-center gap-1 px-2.5 py-1 rounded-lg text-[10px] font-semibold bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50 transition-colors">
                    {walkLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
                    {walkLoading ? "Calcolo…" : "Calcola"}
                  </button>
                </div>
                {selectedRouteCount > 0 && (
                  <p className="text-[10px] text-blue-400 bg-blue-500/10 rounded px-2 py-1">
                    ▸ Solo fermate delle {selectedRouteCount} {selectedRouteCount === 1 ? "linea" : "linee"} selezionate
                  </p>
                )}

                {/* Results */}
                {walkData && !walkLoading && (
                  <div className="space-y-3">
                    {/* KPI row */}
                    <div className="grid grid-cols-3 gap-1.5 text-center">
                      <div className="bg-blue-500/10 rounded-lg p-1.5">
                        <p className="text-lg font-bold text-blue-400">{walkData.coveragePercent}%</p>
                        <p className="text-[9px] text-muted-foreground">Copertura</p>
                      </div>
                      <div className="bg-muted/30 rounded-lg p-1.5">
                        <p className="text-sm font-bold text-foreground">{walkData.coveredPopulation.toLocaleString("it-IT")}</p>
                        <p className="text-[9px] text-muted-foreground">Pop. coperta</p>
                      </div>
                      <div className="bg-muted/30 rounded-lg p-1.5">
                        <p className="text-sm font-bold text-foreground">{walkData.sampledStops}/{walkData.totalStops}</p>
                        <p className="text-[9px] text-muted-foreground">Fermate</p>
                      </div>
                    </div>

                    {/* Donut */}
                    <div className="flex items-center gap-2">
                      <div className="w-[100px] h-[100px]">
                        <ResponsiveContainer width="100%" height="100%">
                          <PieChart>
                            <Pie data={walkDonut} cx="50%" cy="50%" innerRadius={28} outerRadius={42} paddingAngle={3} dataKey="value" strokeWidth={0}>
                              {walkDonut.map((e, i) => <Cell key={i} fill={e.fill} />)}
                            </Pie>
                            <ReTooltip formatter={(v: number) => `${v.toLocaleString("it-IT")} ab.`}
                              contentStyle={{ background: "#1e293b", border: "1px solid #334155", borderRadius: 8, fontSize: 10 }} />
                          </PieChart>
                        </ResponsiveContainer>
                      </div>
                      <div className="flex-1 space-y-1">
                        <div className="flex items-center gap-1.5 text-[10px]">
                          <div className="w-2.5 h-2.5 rounded-sm bg-blue-500" />
                          <span className="text-muted-foreground">Coperta</span>
                          <span className="ml-auto font-semibold">{walkData.coveredPopulation.toLocaleString("it-IT")}</span>
                        </div>
                        <div className="flex items-center gap-1.5 text-[10px]">
                          <div className="w-2.5 h-2.5 rounded-sm" style={{ background: "#334155" }} />
                          <span className="text-muted-foreground">Non coperta</span>
                          <span className="ml-auto font-semibold">{(walkData.totalPopulation - walkData.coveredPopulation).toLocaleString("it-IT")}</span>
                        </div>
                      </div>
                    </div>

                    {/* Bar chart — top stops */}
                    {walkBars.length > 0 && (
                      <div>
                        <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1">Top fermate per pop. coperta</p>
                        <ResponsiveContainer width="100%" height={walkBars.length * 22 + 10}>
                          <BarChart data={walkBars} layout="vertical" margin={{ left: 0, right: 5, top: 0, bottom: 0 }}>
                            <XAxis type="number" hide />
                            <YAxis type="category" dataKey="name" width={95} tick={{ fill: "#94a3b8", fontSize: 9 }} />
                            <ReTooltip formatter={(v: number, _: string, p: any) => [`${v.toLocaleString("it-IT")} ab.`, p.payload.full]}
                              contentStyle={{ background: "#1e293b", border: "1px solid #334155", borderRadius: 8, fontSize: 10 }} />
                            <Bar dataKey="pop" fill="#3b82f6" radius={[0, 4, 4, 0]} />
                          </BarChart>
                        </ResponsiveContainer>
                      </div>
                    )}

                    {/* Low coverage warning */}
                    {walkData.coveragePercent < 50 && (
                      <p className="text-[10px] text-amber-400 bg-amber-500/10 rounded px-2 py-1">
                        ⚠ Copertura &lt;50% — valutare nuove fermate o servizi a chiamata (DRT) per aree scoperte
                      </p>
                    )}

                    {/* Per-municipality breakdown */}
                    {walkData.municipalities && walkData.municipalities.length > 0 && (
                      <div>
                        <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">Copertura per comune</p>
                        <div className="space-y-1.5">
                          {walkData.municipalities.map(m => {
                            const pctColor = m.percent >= 60 ? "text-green-400" : m.percent >= 30 ? "text-amber-400" : "text-red-400";
                            const barColor = m.percent >= 60 ? "#22c55e" : m.percent >= 30 ? "#eab308" : "#ef4444";
                            return (
                              <div key={m.code} className="bg-muted/20 rounded-lg p-2">
                                <div className="flex items-center justify-between mb-1">
                                  <span className="text-[10px] font-medium text-foreground">{m.name}</span>
                                  <span className={`text-[10px] font-bold ${pctColor}`}>{m.percent}%</span>
                                </div>
                                <div className="h-1.5 bg-muted/40 rounded-full overflow-hidden mb-1">
                                  <div className="h-full rounded-full transition-all" style={{ width: `${m.percent}%`, backgroundColor: barColor }} />
                                </div>
                                <div className="flex justify-between text-[9px] text-muted-foreground">
                                  <span>{m.coveredPop.toLocaleString("it-IT")} / {m.totalPop.toLocaleString("it-IT")} ab.</span>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {walkData.note && (
                      <p className="text-[9px] text-muted-foreground/60 italic">{walkData.note}</p>
                    )}
                  </div>
                )}

                {/* Loading */}
                {walkLoading && (
                  <div className="flex items-center justify-center gap-2 py-6 text-xs text-muted-foreground">
                    <Loader2 className="w-4 h-4 animate-spin text-emerald-400" />
                    Calcolo isocrone in corso…
                  </div>
                )}
              </CardContent>
            </motion.div>
          )}
        </AnimatePresence>
      </Card>
    </div>
  );
}
