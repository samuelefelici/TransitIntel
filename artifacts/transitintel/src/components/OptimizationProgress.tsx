/**
 * OptimizationProgress — Componente UI per il progress dell'ottimizzazione CP-SAT
 *
 * Mostra: barra di avanzamento, fase corrente, timer, timeline dei round,
 * dettagli solver, e pulsante Stop.
 */

import React from "react";
import { motion } from "framer-motion";
import {
  Loader2, StopCircle, Clock, Zap, CheckCircle2,
  AlertTriangle, XCircle, BarChart3,
} from "lucide-react";
import type { OptimizationProgress as ProgressData, OptimizationState } from "@/hooks/use-crew-optimization";

/* ─── Phase Labels ───────────────────────────────────────────── */

const PHASE_LABELS: Record<string, string> = {
  init: "Inizializzazione",
  starting: "Avvio processo",
  loading: "Caricamento dati",
  task_gen: "Generazione task",
  enum_duties: "Enumerazione turni",
  warmstart: "Warmstart greedy",
  solving: "Ottimizzazione CP-SAT",
  merge: "Merge supplementi",
  fallback: "Fallback greedy",
  serialize: "Serializzazione",
  done: "Completato",
  error: "Errore",
  stopped: "Fermato",
};

const PHASE_ICONS: Record<string, React.ReactNode> = {
  init: <Loader2 className="w-3.5 h-3.5 animate-spin" />,
  starting: <Loader2 className="w-3.5 h-3.5 animate-spin" />,
  loading: <Loader2 className="w-3.5 h-3.5 animate-spin" />,
  warmstart: <Zap className="w-3.5 h-3.5" />,
  task_gen: <Zap className="w-3.5 h-3.5" />,
  enum_duties: <BarChart3 className="w-3.5 h-3.5" />,
  solving: <Loader2 className="w-3.5 h-3.5 animate-spin" />,
  merge: <Zap className="w-3.5 h-3.5" />,
  fallback: <AlertTriangle className="w-3.5 h-3.5" />,
  serialize: <Loader2 className="w-3.5 h-3.5 animate-spin" />,
  done: <CheckCircle2 className="w-3.5 h-3.5" />,
  error: <XCircle className="w-3.5 h-3.5" />,
  stopped: <StopCircle className="w-3.5 h-3.5" />,
};

/* ─── Props ──────────────────────────────────────────────────── */

interface OptimizationProgressProps {
  state: OptimizationState;
  progress: ProgressData | null;
  progressHistory: ProgressData[];
  elapsedSec: number;
  onStop: () => void;
}

/* ─── Helpers ────────────────────────────────────────────────── */

function formatElapsed(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}m${String(s).padStart(2, "0")}s` : `${s}s`;
}

/* ─── Component ──────────────────────────────────────────────── */

export function OptimizationProgressPanel({
  state,
  progress,
  progressHistory,
  elapsedSec,
  onStop,
}: OptimizationProgressProps) {
  const isRunning = state === "starting" || state === "running";
  const isDone = state === "completed";
  const isFailed = state === "failed";
  const isStopped = state === "stopped";

  const pct = progress?.percentage ?? 0;
  const phase = progress?.phase ?? "init";
  const detail = progress?.detail ?? "In attesa...";
  const extra = progress?.extra as Record<string, unknown> | undefined;

  // Extract round info from progress history
  const roundEvents = progressHistory.filter(
    (p) => p.phase === "solving" && p.extra && (p.extra as any).round
  );

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="rounded-xl border border-border/40 bg-card/60 backdrop-blur-sm p-4 space-y-4"
    >
      {/* Header row */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {PHASE_ICONS[phase] || <Loader2 className="w-3.5 h-3.5 animate-spin" />}
          <span className="text-sm font-medium">
            {isDone ? "✅ Ottimizzazione Completata" :
             isFailed ? "❌ Ottimizzazione Fallita" :
             isStopped ? "⏹ Ottimizzazione Fermata" :
             "🧠 Ottimizzazione in corso..."}
          </span>
        </div>
        <div className="flex items-center gap-3">
          {/* Timer */}
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <Clock className="w-3 h-3" />
            {formatElapsed(elapsedSec)}
          </div>
          {/* Stop button */}
          {isRunning && (
            <button
              onClick={onStop}
              className="flex items-center gap-1 px-3 py-1 rounded-lg text-xs font-medium
                bg-red-500/10 text-red-400 border border-red-500/20
                hover:bg-red-500/20 transition-colors"
            >
              <StopCircle className="w-3 h-3" />
              Stop
            </button>
          )}
        </div>
      </div>

      {/* Progress bar */}
      <div className="space-y-1">
        <div className="h-2 w-full rounded-full bg-muted/30 overflow-hidden">
          <motion.div
            className={`h-full rounded-full ${
              isDone ? "bg-green-500" :
              isFailed ? "bg-red-500" :
              isStopped ? "bg-amber-500" :
              "bg-primary"
            }`}
            initial={{ width: 0 }}
            animate={{ width: `${pct}%` }}
            transition={{ duration: 0.3 }}
          />
        </div>
        <div className="flex items-center justify-between text-[10px] text-muted-foreground">
          <span>{PHASE_LABELS[phase] || phase}</span>
          <span>{Math.round(pct)}%</span>
        </div>
      </div>

      {/* Detail */}
      <div className="text-xs text-muted-foreground">{detail}</div>

      {/* Solver detail: round, drivers, etc. */}
      {extra && (
        <div className="flex flex-wrap gap-2">
          {(extra as any).round && (
            <span className="text-[10px] px-2 py-0.5 rounded bg-purple-500/10 text-purple-400 border border-purple-500/20">
              Round {String((extra as any).round)}{(extra as any).roundName ? ` — ${String((extra as any).roundName)}` : ""}
            </span>
          )}
          {(extra as any).drivers !== undefined && (
            <span className="text-[10px] px-2 py-0.5 rounded bg-blue-500/10 text-blue-400 border border-blue-500/20">
              {String((extra as any).drivers)} conducenti
            </span>
          )}
          {(extra as any).tasks !== undefined && (
            <span className="text-[10px] px-2 py-0.5 rounded bg-cyan-500/10 text-cyan-400 border border-cyan-500/20">
              {String((extra as any).tasks)} task
            </span>
          )}
          {(extra as any).duties !== undefined && (
            <span className="text-[10px] px-2 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20">
              {String((extra as any).duties)} turni candidati
            </span>
          )}
          {(extra as any).status && (
            <span className="text-[10px] px-2 py-0.5 rounded bg-green-500/10 text-green-400 border border-green-500/20">
              {String((extra as any).status)}
            </span>
          )}
        </div>
      )}

      {/* Round timeline */}
      {roundEvents.length > 0 && (
        <div className="space-y-1">
          <div className="text-[10px] font-medium text-muted-foreground">Round di ottimizzazione:</div>
          <div className="flex gap-1">
            {roundEvents.map((evt, i) => {
              const e = evt.extra as Record<string, unknown>;
              const roundNum = e?.round as number;
              const roundName = e?.roundName as string || "";
              const drivers = e?.drivers as number;
              const isLast = i === roundEvents.length - 1;
              return (
                <div
                  key={i}
                  className={`flex-1 rounded-md p-1.5 border text-center ${
                    isLast && isRunning
                      ? "border-primary/40 bg-primary/5"
                      : "border-border/20 bg-muted/10"
                  }`}
                >
                  <div className="text-[9px] text-muted-foreground">R{roundNum}</div>
                  <div className="text-[9px] font-medium truncate">{roundName}</div>
                  {drivers !== undefined && (
                    <div className="text-[10px] font-bold text-primary">{drivers}</div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </motion.div>
  );
}
