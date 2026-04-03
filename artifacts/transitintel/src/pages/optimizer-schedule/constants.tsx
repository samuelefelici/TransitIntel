import React from "react";
import {
  Trash2, TrendingUp, Zap, TrainFront, TrendingDown,
} from "lucide-react";

import type { Priority, SuggestionType } from "./types";

/* ═══════════════════════════════════════════════════════════════
 *  CONSTANTS
 * ═══════════════════════════════════════════════════════════════ */

export const PRIORITY_COLORS: Record<Priority, string> = {
  critical: "#ef4444", high: "#f97316", medium: "#f59e0b", low: "#22c55e",
};

export const PRIORITY_LABELS: Record<Priority, string> = {
  critical: "Critico", high: "Alto", medium: "Medio", low: "Basso",
};

export const TYPE_LABELS: Record<SuggestionType, string> = {
  superfluous: "Corsa duplicata",
  overcrowded: "Sovraffollamento",
  "rush-pileup": "Accumulo picco",
  "intermodal-gap": "Gap intermodale",
  "low-demand": "Bassa domanda",
};

export const TYPE_ICONS: Record<SuggestionType, React.ReactNode> = {
  superfluous: <Trash2 className="w-4 h-4" />,
  overcrowded: <TrendingUp className="w-4 h-4" />,
  "rush-pileup": <Zap className="w-4 h-4" />,
  "intermodal-gap": <TrainFront className="w-4 h-4" />,
  "low-demand": <TrendingDown className="w-4 h-4" />,
};

export const ACTION_LABELS: Record<string, string> = {
  remove: "Rimuovere", add: "Aggiungere", shift: "Spostare", merge: "Unire",
};

export const STRATEGY_COLORS: Record<string, string> = {
  balanced: "#3b82f6",
  cost_focus: "#ef4444",
  quality_focus: "#22c55e",
  regularity_focus: "#a855f7",
  peak_optimize: "#f59e0b",
  custom: "#ec4899",
};

export const STRATEGY_LABELS: Record<string, string> = {
  balanced: "Bilanciata",
  cost_focus: "Focus Costi",
  quality_focus: "Focus Qualità",
  regularity_focus: "Focus Regolarità",
  peak_optimize: "Ottimizza Picco",
  custom: "Personalizzata",
};

export const WEIGHT_LABELS: Record<string, string> = {
  cost: "Costi",
  regularity: "Regolarità",
  coverage: "Copertura",
  overcrowd: "Anti-sovraffollamento",
  connections: "Connessioni",
};

/* ═══════════════════════════════════════════════════════════════
 *  HELPERS
 * ═══════════════════════════════════════════════════════════════ */

export function ymdToIso(ymd: string): string {
  return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
}

export function ymdToDisplay(ymd: string): string {
  return `${ymd.slice(6, 8)}/${ymd.slice(4, 6)}/${ymd.slice(0, 4)}`;
}

export function pct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}
