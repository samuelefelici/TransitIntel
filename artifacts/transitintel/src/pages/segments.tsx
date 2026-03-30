import React, { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Users, AlertTriangle, TrendingDown, Clock, MapPin,
  ChevronDown, ChevronUp, Info, BarChart2, Zap,
} from "lucide-react";
import { getApiBase } from "@/lib/api";

// ─── Types ────────────────────────────────────────────────────
interface HourSlot {
  hour: string;
  buses: number;
  routes: number;
  demand: number;
  gap: number;
}

interface PeakWindow {
  label: string;
  from: string;
  to: string;
  totalBuses: number;
  avgBusesPerPoi: number;
  poiWithZero: number;
}

interface CriticalPoi {
  name: string;
  lat: number;
  lng: number;
  distM: number;
  buses: number;
}

interface SegmentData {
  id: string;
  label: string;
  icon: string;
  poiCount: number;
  coveredPoi: number;
  uncoveredPoi: number;
  avgBusesPeak: number;
  avgDistM: number;
  farPoi: number;
  peakWindows: PeakWindow[];
  hourlyProfile: HourSlot[];
  gapScore: number;
  gapLabel: string;
  estimatedDailyDemand: number;
  estimatedDailySupply: number;
  topCriticalPoi: CriticalPoi[];
}

interface SegmentsResponse {
  segments: SegmentData[];
  worstSegment: string | null;
  summary: {
    totalPoi: number;
    totalStops: number;
    totalDailyDepartures: number;
  };
}

// ─── Colors ──────────────────────────────────────────────────
const GAP_CFG: Record<string, { color: string; bg: string; border: string; textColor: string }> = {
  buono:         { color: "#34d399", bg: "bg-emerald-500/10", border: "border-emerald-500/30", textColor: "text-emerald-400" },
  accettabile:   { color: "#60a5fa", bg: "bg-blue-500/10",    border: "border-blue-500/30",    textColor: "text-blue-400" },
  insufficiente: { color: "#fbbf24", bg: "bg-yellow-500/10",  border: "border-yellow-500/30",  textColor: "text-yellow-400" },
  critico:       { color: "#f87171", bg: "bg-red-500/10",     border: "border-red-500/30",     textColor: "text-red-400" },
};

const SEG_COLORS: Record<string, { ring: string; text: string; bg: string }> = {
  studenti:      { ring: "ring-violet-500/40",  text: "text-violet-400",  bg: "bg-violet-500/10" },
  universitari:  { ring: "ring-indigo-500/40",  text: "text-indigo-400",  bg: "bg-indigo-500/10" },
  anziani:       { ring: "ring-amber-500/40",   text: "text-amber-400",   bg: "bg-amber-500/10" },
  lavoratori:    { ring: "ring-sky-500/40",     text: "text-sky-400",     bg: "bg-sky-500/10" },
};

// ─── Page ─────────────────────────────────────────────────────
export default function SegmentsPage() {
  const [data, setData] = useState<SegmentsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedSeg, setExpandedSeg] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    fetch(`${getApiBase()}/api/analysis/segments`, { cache: "no-store" })
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(d => {
        setData(d);
        // Auto-expand worst segment
        if (d.worstSegment) setExpandedSeg(d.worstSegment);
        setLoading(false);
      })
      .catch(e => { setError(`Errore: ${e.message}`); setLoading(false); });
  }, []);

  if (loading) return (
    <div className="h-full flex items-center justify-center gap-3 text-muted-foreground">
      <div className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      <p className="text-sm">Analisi segmenti utenza in corso…</p>
    </div>
  );
  if (error || !data) return (
    <div className="h-full flex items-center justify-center text-destructive text-sm">{error ?? "Errore"}</div>
  );

  const worst = data.segments[0]; // sorted by gapScore desc

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="px-4 pt-3 pb-2 border-b border-border/30 shrink-0">
        <div className="flex items-center gap-2 mb-2">
          <Users className="w-4 h-4 text-primary" />
          <h1 className="text-base font-display font-bold">Segmenti Utenza</h1>
          <span className="text-[10px] text-muted-foreground ml-1">· gap domanda/offerta · profilo orario</span>
        </div>

        {/* Priority alert — worst segment */}
        {worst && worst.gapScore >= 30 && (
          <motion.div
            initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }}
            className="flex items-center gap-2.5 rounded-xl bg-red-500/10 border border-red-500/25 px-3 py-2 mb-2"
          >
            <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" />
            <div className="flex-1">
              <p className="text-xs font-bold text-red-400">
                Priorità: {worst.icon} {worst.label}
              </p>
              <p className="text-[10px] text-red-300/70 mt-0.5">
                Gap score {worst.gapScore}/100 — {worst.uncoveredPoi + worst.farPoi} POI senza servizio adeguato,{" "}
                {formatNum(worst.estimatedDailyDemand - worst.estimatedDailySupply)} utenti/giorno potenzialmente non serviti
              </p>
            </div>
            <span className="text-lg font-bold text-red-400 font-mono">{worst.gapScore}</span>
          </motion.div>
        )}

        {/* Summary KPIs */}
        <div className="flex gap-2 flex-wrap">
          <MiniKpi label="POI analizzati" value={formatNum(data.summary.totalPoi)} />
          <MiniKpi label="Fermate GTFS" value={formatNum(data.summary.totalStops)} />
          <MiniKpi label="Corse/giorno" value={formatNum(data.summary.totalDailyDepartures)} />
          <MiniKpi
            label="Segmento peggiore"
            value={worst ? `${worst.icon} ${worst.id}` : "—"}
            highlight
          />
        </div>
      </div>

      {/* Segment cards */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {data.segments.map((seg, i) => (
          <SegmentCard
            key={seg.id}
            seg={seg}
            rank={i + 1}
            expanded={expandedSeg === seg.id}
            onToggle={() => setExpandedSeg(expandedSeg === seg.id ? null : seg.id)}
          />
        ))}
      </div>
    </div>
  );
}

// ─── Segment Card ─────────────────────────────────────────────
function SegmentCard({
  seg, rank, expanded, onToggle,
}: {
  seg: SegmentData;
  rank: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  const gapCfg = GAP_CFG[seg.gapLabel] ?? GAP_CFG.buono;
  const segColor = SEG_COLORS[seg.id] ?? SEG_COLORS.studenti;

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: rank * 0.06 }}
      className={`rounded-xl border ${gapCfg.border} overflow-hidden transition-all`}
    >
      {/* Header */}
      <button
        onClick={onToggle}
        className={`w-full flex items-center gap-3 px-4 py-3 text-left ${gapCfg.bg}`}
      >
        {/* Rank */}
        <span className={`text-[10px] font-bold w-5 h-5 rounded-full flex items-center justify-center ring-2 ${segColor.ring} ${segColor.bg} ${segColor.text}`}>
          {rank}
        </span>

        {/* Icon + name */}
        <span className="text-lg">{seg.icon}</span>
        <div className="flex-1 min-w-0">
          <p className="text-xs font-bold">{seg.label}</p>
          <p className="text-[10px] text-muted-foreground mt-0.5">
            {seg.poiCount} POI · {seg.coveredPoi} serviti · {seg.uncoveredPoi + seg.farPoi} critici
          </p>
        </div>

        {/* Gap score gauge */}
        <div className="flex items-center gap-2 shrink-0">
          <div className="w-16 h-2 rounded-full bg-muted/30 overflow-hidden">
            <motion.div
              initial={{ width: 0 }}
              animate={{ width: `${seg.gapScore}%` }}
              transition={{ duration: 0.8, ease: "easeOut" }}
              className="h-full rounded-full"
              style={{ backgroundColor: gapCfg.color }}
            />
          </div>
          <span className={`text-sm font-bold font-mono ${gapCfg.textColor}`}>
            {seg.gapScore}
          </span>
          <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-bold ${gapCfg.bg} ${gapCfg.textColor}`}>
            {seg.gapLabel.toUpperCase()}
          </span>
        </div>

        {expanded ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
      </button>

      {/* Expanded detail */}
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <div className="px-4 py-3 border-t border-border/20 space-y-4">
              {/* KPI row */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <StatBox label="POI analizzati" value={seg.poiCount} icon="📍" />
                <StatBox label="Coperti (≥1 bus)" value={seg.coveredPoi} icon="✅" />
                <StatBox label="Senza servizio" value={seg.uncoveredPoi + seg.farPoi} icon="❌" />
                <StatBox label="Dist. media fermata" value={`${seg.avgDistM}m`} icon="🚶" />
              </div>

              {/* Demand vs supply */}
              <div className="rounded-lg border border-border/20 p-3">
                <div className="flex items-center gap-2 mb-2">
                  <TrendingDown className="w-3.5 h-3.5 text-muted-foreground" />
                  <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">Domanda vs Offerta stimata</span>
                </div>
                <DemandSupplyBar
                  demand={seg.estimatedDailyDemand}
                  supply={seg.estimatedDailySupply}
                />
              </div>

              {/* Peak windows */}
              <div className="rounded-lg border border-border/20 p-3">
                <div className="flex items-center gap-2 mb-2">
                  <Clock className="w-3.5 h-3.5 text-muted-foreground" />
                  <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">Finestre di punta</span>
                </div>
                <div className="space-y-2">
                  {seg.peakWindows.map((pw, i) => (
                    <div key={i} className="flex items-center gap-3 bg-card/30 rounded-lg px-3 py-2">
                      <div className="flex-1 min-w-0">
                        <p className="text-[11px] font-semibold">{pw.label}</p>
                        <p className="text-[10px] text-muted-foreground">{pw.from} — {pw.to}</p>
                      </div>
                      <div className="text-center">
                        <p className="text-xs font-bold">{pw.totalBuses}</p>
                        <p className="text-[8px] text-muted-foreground">corse tot.</p>
                      </div>
                      <div className="text-center">
                        <p className="text-xs font-bold">{pw.avgBusesPerPoi}</p>
                        <p className="text-[8px] text-muted-foreground">media/POI</p>
                      </div>
                      <div className="text-center">
                        <p className={`text-xs font-bold ${pw.poiWithZero > 0 ? "text-red-400" : "text-emerald-400"}`}>
                          {pw.poiWithZero}
                        </p>
                        <p className="text-[8px] text-muted-foreground">POI a zero</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Hourly profile */}
              <div className="rounded-lg border border-border/20 p-3">
                <div className="flex items-center gap-2 mb-2">
                  <BarChart2 className="w-3.5 h-3.5 text-muted-foreground" />
                  <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">Profilo orario (corse ogni 30min)</span>
                </div>
                <HourlyChart profile={seg.hourlyProfile} gapColor={gapCfg.color} />
              </div>

              {/* Critical POI */}
              {seg.topCriticalPoi.length > 0 && (
                <div className="rounded-lg border border-border/20 p-3">
                  <div className="flex items-center gap-2 mb-2">
                    <AlertTriangle className="w-3.5 h-3.5 text-red-400" />
                    <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">
                      POI più critici (meno serviti)
                    </span>
                  </div>
                  <div className="space-y-1">
                    {seg.topCriticalPoi.map((p, i) => (
                      <div key={i} className="flex items-center gap-2 text-[11px] bg-card/30 rounded-lg px-2.5 py-1.5">
                        <span className="text-red-400 font-bold w-4">{i + 1}.</span>
                        <MapPin className="w-2.5 h-2.5 text-muted-foreground/50" />
                        <span className="flex-1 truncate">{p.name}</span>
                        <span className="text-[10px] text-muted-foreground">{p.distM}m</span>
                        <span className={`text-[10px] font-bold ${p.buses === 0 ? "text-red-400" : "text-yellow-400"}`}>
                          {p.buses === 0 ? "0 bus" : `${p.buses} bus`}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

// ─── Hourly Chart ─────────────────────────────────────────────
function HourlyChart({ profile, gapColor }: { profile: HourSlot[]; gapColor: string }) {
  const maxBuses = Math.max(...profile.map(h => h.buses), 1);
  const maxDemand = Math.max(...profile.map(h => h.demand), 1);
  const maxVal = Math.max(maxBuses, maxDemand);

  return (
    <div className="space-y-1">
      {/* Header */}
      <div className="flex items-center gap-3 mb-1.5 text-[9px] text-muted-foreground">
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-primary/60" /> Corse</span>
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm" style={{ backgroundColor: gapColor, opacity: 0.4 }} /> Domanda stimata</span>
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-red-500/50" /> Gap</span>
      </div>
      {/* Bars */}
      <div className="flex items-end gap-px" style={{ height: 120 }}>
        {profile.map((slot, i) => {
          const busH = (slot.buses / maxVal) * 100;
          const demH = (slot.demand / maxVal) * 100;
          const gapH = (slot.gap / maxVal) * 100;
          const isHalf = slot.hour.endsWith(":30");
          return (
            <div key={i} className="flex-1 flex flex-col items-center gap-0 relative group" style={{ height: "100%" }}>
              {/* Tooltip */}
              <div className="absolute -top-14 left-1/2 -translate-x-1/2 opacity-0 group-hover:opacity-100 transition-opacity z-20 pointer-events-none">
                <div className="bg-card border border-border/50 rounded-lg px-2 py-1.5 shadow-xl whitespace-nowrap">
                  <p className="text-[9px] font-bold">{slot.hour}</p>
                  <p className="text-[8px] text-muted-foreground">{slot.buses} corse · {slot.routes} linee</p>
                  {slot.gap > 0 && <p className="text-[8px] text-red-400">Gap: {slot.gap}</p>}
                </div>
              </div>
              {/* Stacked bars */}
              <div className="w-full flex flex-col justify-end flex-1">
                {slot.gap > 0 && (
                  <motion.div
                    initial={{ height: 0 }}
                    animate={{ height: `${gapH}%` }}
                    transition={{ duration: 0.4, delay: i * 0.01 }}
                    className="w-full rounded-t-[2px] bg-red-500/40"
                  />
                )}
                <motion.div
                  initial={{ height: 0 }}
                  animate={{ height: `${busH}%` }}
                  transition={{ duration: 0.4, delay: i * 0.01 }}
                  className="w-full bg-primary/60 rounded-t-[2px]"
                  style={{ minHeight: slot.buses > 0 ? 2 : 0 }}
                />
              </div>
              {/* Label */}
              {!isHalf && (
                <span className="text-[7px] text-muted-foreground/60 mt-1 leading-none">
                  {slot.hour.split(":")[0]}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Demand/Supply Bar ────────────────────────────────────────
function DemandSupplyBar({ demand, supply }: { demand: number; supply: number }) {
  const max = Math.max(demand, supply, 1);
  const demPct = (demand / max) * 100;
  const supPct = (supply / max) * 100;
  const deficit = Math.max(0, demand - supply);
  const deficitPct = demand > 0 ? Math.round((deficit / demand) * 100) : 0;

  return (
    <div className="space-y-2">
      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-muted-foreground w-16">Domanda</span>
          <div className="flex-1 h-4 rounded-full bg-muted/20 overflow-hidden">
            <motion.div
              initial={{ width: 0 }}
              animate={{ width: `${demPct}%` }}
              transition={{ duration: 0.7 }}
              className="h-full rounded-full bg-amber-500/50"
            />
          </div>
          <span className="text-[10px] font-bold w-16 text-right">{formatNum(demand)}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-muted-foreground w-16">Offerta</span>
          <div className="flex-1 h-4 rounded-full bg-muted/20 overflow-hidden">
            <motion.div
              initial={{ width: 0 }}
              animate={{ width: `${supPct}%` }}
              transition={{ duration: 0.7 }}
              className="h-full rounded-full bg-emerald-500/50"
            />
          </div>
          <span className="text-[10px] font-bold w-16 text-right">{formatNum(supply)}</span>
        </div>
      </div>
      {deficit > 0 && (
        <div className="flex items-center gap-2 bg-red-500/10 border border-red-500/20 rounded-lg px-2.5 py-1.5">
          <Zap className="w-3 h-3 text-red-400" />
          <span className="text-[10px] text-red-300">
            Deficit stimato: <span className="font-bold">{formatNum(deficit)}</span> utenti/giorno ({deficitPct}% domanda scoperta)
          </span>
        </div>
      )}
      {deficit <= 0 && (
        <div className="flex items-center gap-2 bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-2.5 py-1.5">
          <Zap className="w-3 h-3 text-emerald-400" />
          <span className="text-[10px] text-emerald-300">
            Offerta sufficiente — capacità residua stimata: <span className="font-bold">{formatNum(supply - demand)}</span>
          </span>
        </div>
      )}
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────
function StatBox({ label, value, icon }: { label: string; value: number | string; icon: string }) {
  return (
    <div className="bg-card/40 border border-border/30 rounded-lg px-2.5 py-2 text-center">
      <span className="text-sm">{icon}</span>
      <p className="text-sm font-bold mt-0.5">{value}</p>
      <p className="text-[8px] text-muted-foreground leading-tight">{label}</p>
    </div>
  );
}

function MiniKpi({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className={`flex items-center gap-2 rounded-xl px-3 py-1.5 border ${
      highlight ? "bg-red-500/10 border-red-500/20" : "bg-card/40 border-border/30"
    }`}>
      <div>
        <p className={`text-xs font-bold leading-none ${highlight ? "text-red-400" : ""}`}>{value}</p>
        <p className="text-[8px] text-muted-foreground leading-tight mt-0.5">{label}</p>
      </div>
    </div>
  );
}

function formatNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
