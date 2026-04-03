import React, { useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  ChevronDown, ChevronUp, Lightbulb, Target, Timer,
  CheckCircle2, Minus, Shuffle,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

import type { ScheduleSuggestion, TripDecision } from "./types";
import {
  PRIORITY_COLORS, PRIORITY_LABELS, TYPE_LABELS, TYPE_ICONS, ACTION_LABELS,
} from "./constants";

/* ── SummaryCard ── */

export function SummaryCard({ icon, label, value, color }: {
  icon: React.ReactNode; label: string; value: string; color?: string;
}) {
  return (
    <Card className="bg-muted/20 border-border/30">
      <CardContent className="p-3 flex flex-col items-center text-center">
        <div className="mb-1" style={{ color: color || "var(--muted-foreground)" }}>{icon}</div>
        <div className="text-lg font-bold" style={{ color }}>{value}</div>
        <div className="text-[10px] text-muted-foreground">{label}</div>
      </CardContent>
    </Card>
  );
}

/* ── MiniMetric ── */

export function MiniMetric({ label, value, sub, color }: {
  label: string; value: string | number; sub?: string; color?: string;
}) {
  return (
    <div className="bg-background/30 rounded-lg p-2.5 text-center">
      <div className="text-base font-bold font-mono" style={{ color }}>{value}</div>
      <div className="text-[10px] text-muted-foreground">{label}</div>
      {sub && <div className="text-[9px] text-muted-foreground/60">{sub}</div>}
    </div>
  );
}

/* ── SuggestionCard ── */

export function SuggestionCard({ suggestion: s, expanded, onToggle }: {
  suggestion: ScheduleSuggestion; expanded: boolean; onToggle: () => void;
}) {
  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
      <Card className={`cursor-pointer transition-all border-l-4 ${
        expanded ? "bg-muted/20" : "bg-muted/10 hover:bg-muted/15"
      }`} style={{ borderLeftColor: PRIORITY_COLORS[s.priority] }} onClick={onToggle}>
        <CardContent className="p-3">
          <div className="flex items-start gap-3">
            <div className="mt-0.5" style={{ color: PRIORITY_COLORS[s.priority] }}>{TYPE_ICONS[s.type]}</div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <Badge variant="outline" className="text-[10px]"
                  style={{ borderColor: PRIORITY_COLORS[s.priority], color: PRIORITY_COLORS[s.priority] }}>
                  {PRIORITY_LABELS[s.priority]}
                </Badge>
                <Badge variant="secondary" className="text-[10px]">{TYPE_LABELS[s.type]}</Badge>
                <span className="text-xs font-medium">{s.routeName}</span>
              </div>
              <p className="text-sm mt-1">{s.description}</p>
            </div>
            <div className="shrink-0">
              {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </div>
          </div>
          <AnimatePresence>
            {expanded && (
              <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }} className="mt-3 space-y-2 text-xs overflow-hidden">
                <div className="bg-background/50 rounded-md p-2 space-y-1">
                  <div className="text-muted-foreground">{s.details}</div>
                </div>
                {s.affectedTrips.length > 0 && (
                  <div>
                    <span className="text-muted-foreground font-medium">Corse coinvolte:</span>
                    <div className="flex flex-col gap-1 mt-1">
                      {s.affectedTrips.map((t, i) => (
                        <div key={i} className="bg-background/50 rounded px-2 py-1 text-[11px] flex items-center gap-2">
                          <code className="text-primary font-mono text-[10px]">{t.tripId}</code>
                          <span className="font-medium">{t.departureTime.slice(0, 5)}</span>
                          {t.headsign && <span className="text-muted-foreground">→ {t.headsign}</span>}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {s.proposedChange && (
                  <div className="flex items-start gap-2 bg-primary/10 rounded-md p-2">
                    <Lightbulb className="w-3.5 h-3.5 mt-0.5 text-yellow-400 shrink-0" />
                    <div>
                      <div className="font-medium">Azione: {ACTION_LABELS[s.action]}</div>
                      <div className="text-muted-foreground">{s.proposedChange}</div>
                    </div>
                  </div>
                )}
                <div className="flex items-center gap-4">
                  <div className="flex items-center gap-1 text-muted-foreground">
                    <Target className="w-3 h-3" /> {s.impact}
                  </div>
                  {s.savingsMinutes != null && s.savingsMinutes > 0 && (
                    <div className="flex items-center gap-1 text-green-400">
                      <Timer className="w-3 h-3" /> Risparmio: {s.savingsMinutes} min
                    </div>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </CardContent>
      </Card>
    </motion.div>
  );
}

/* ── DecisionCard ── */

export function DecisionCard({ decision: d }: { decision: TripDecision }) {
  const isRemove = d.action === "remove";
  const isShift = d.action === "shift";
  return (
    <div className={`flex items-center gap-3 px-3 py-2 rounded-md text-xs ${
      isRemove ? "bg-red-500/5 border-l-2 border-l-red-500" : isShift ? "bg-yellow-500/5 border-l-2 border-l-yellow-500" : "bg-muted/10 border-l-2 border-l-border"
    }`}>
      <div className="shrink-0">
        {isRemove ? <Minus className="w-3.5 h-3.5 text-red-400" /> :
         isShift ? <Shuffle className="w-3.5 h-3.5 text-yellow-400" /> :
         <CheckCircle2 className="w-3.5 h-3.5 text-green-400" />}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium">{d.routeName}</span>
          <code className="text-[10px] font-mono text-muted-foreground">{d.tripId}</code>
        </div>
        <div className="flex items-center gap-2 mt-0.5 text-muted-foreground">
          <span className="font-mono">{d.originalDeparture}</span>
          {isShift && d.newDeparture && (
            <>
              <span>→</span>
              <span className="font-mono text-yellow-400">{d.newDeparture}</span>
              <span className="text-[10px]">({d.shiftMinutes > 0 ? "+" : ""}{d.shiftMinutes} min)</span>
            </>
          )}
          {isRemove && <span className="text-red-400">× rimossa</span>}
        </div>
      </div>
      <div className="text-[10px] text-muted-foreground max-w-[200px] text-right hidden md:block">{d.reason}</div>
    </div>
  );
}

/* ── TripTimeline (SVG) ── */

export function TripTimeline({ decisions, strategyColor }: {
  decisions: TripDecision[]; strategyColor: string;
}) {
  const MAX_DOTS = 600;
  const W = 900, H = 80, PAD = 40;
  const innerW = W - PAD * 2;
  const minH = 0, maxH = 26;

  const toX = (time: string) => {
    const parts = time.split(":").map(Number);
    const t = parts[0] + parts[1] / 60;
    return PAD + ((t - minH) / (maxH - minH)) * innerW;
  };

  const hours = Array.from({ length: 27 }, (_, i) => i);

  const sampled = useMemo(() => {
    if (decisions.length <= MAX_DOTS) return decisions;
    const removes = decisions.filter(d => d.action === "remove");
    const shifts = decisions.filter(d => d.action === "shift");
    const shiftBudget = MAX_DOTS - removes.length;
    if (shiftBudget <= 0) return removes.slice(0, MAX_DOTS);
    const step = Math.max(1, Math.floor(shifts.length / shiftBudget));
    const sampledShifts = shifts.filter((_, i) => i % step === 0);
    return [...removes, ...sampledShifts];
  }, [decisions]);

  return (
    <div className="overflow-x-auto">
      <svg width={W} height={H + 20} className="min-w-[700px]">
        {hours.filter(h => h % 2 === 0).map(h => {
          const xx = PAD + ((h - minH) / (maxH - minH)) * innerW;
          return (
            <g key={h}>
              <line x1={xx} y1={8} x2={xx} y2={H} stroke="#333" strokeWidth={0.5} />
              <text x={xx} y={H + 14} textAnchor="middle" fill="#666" fontSize={8}>{h}:00</text>
            </g>
          );
        })}
        {sampled.map((d, i) => {
          const xx = toX(d.originalDeparture);
          const isRemove = d.action === "remove";
          const isShift = d.action === "shift";
          const color = isRemove ? "#ef4444" : isShift ? "#f59e0b" : strategyColor;
          const yy = 15 + (i % 5) * 12;
          return (
            <g key={i}>
              <circle cx={xx} cy={yy} r={2} fill={color} opacity={0.6} />
              {isShift && d.newDeparture && (
                <>
                  <line x1={xx} y1={yy} x2={toX(d.newDeparture)} y2={yy}
                    stroke="#f59e0b" strokeWidth={0.8} opacity={0.4} />
                  <circle cx={toX(d.newDeparture)} cy={yy} r={1.5} fill="#f59e0b" opacity={0.8} />
                </>
              )}
            </g>
          );
        })}
        <circle cx={PAD} cy={H + 14} r={3} fill="#ef4444" />
        <text x={PAD + 6} y={H + 17} fill="#999" fontSize={8}>Rimosse</text>
        <circle cx={PAD + 60} cy={H + 14} r={3} fill="#f59e0b" />
        <text x={PAD + 66} y={H + 17} fill="#999" fontSize={8}>Spostate</text>
        {decisions.length > MAX_DOTS && (
          <text x={PAD + 130} y={H + 17} fill="#666" fontSize={8}>
            (campione di {sampled.length}/{decisions.length} decisioni)
          </text>
        )}
      </svg>
    </div>
  );
}
