import React from "react";
import { Clock, Coffee, Timer, Zap, AlertTriangle } from "lucide-react";
import type { DriverShiftType } from "./types";

/* ═══════════════════════════════════════════════════════════════
 *  Driver Shifts – Constants & utilities
 * ═══════════════════════════════════════════════════════════════ */

export const TYPE_LABELS: Record<DriverShiftType, string> = {
  intero: "Intero",
  semiunico: "Semiunico",
  spezzato: "Spezzato",
  supplemento: "Supplemento",
  invalido: "Invalido",
};

export const TYPE_COLORS: Record<DriverShiftType, string> = {
  intero: "#3b82f6",
  semiunico: "#f59e0b",
  spezzato: "#ef4444",
  supplemento: "#8b5cf6",
  invalido: "#6b7280",
};

export const TYPE_ICONS: Record<DriverShiftType, React.ReactNode> = {
  intero: <Clock className="w-3.5 h-3.5" />,
  semiunico: <Coffee className="w-3.5 h-3.5" />,
  spezzato: <Timer className="w-3.5 h-3.5" />,
  supplemento: <Zap className="w-3.5 h-3.5" />,
  invalido: <AlertTriangle className="w-3.5 h-3.5" />,
};

export const TYPE_DESC: Record<DriverShiftType, string> = {
  intero: "Nastro ≤ 7h15, unica ripresa",
  semiunico: "2 riprese, pausa 1h15–2h59, nastro ≤ 9h15",
  spezzato: "2 riprese, pausa ≥ 3h, nastro ≤ 10h30",
  supplemento: "Turno breve, max 2h30",
  invalido: "Turno non classificabile (violazione normativa)",
};

/* ── Utility functions ── */

export function ymdToDisplay(ymd: string): string {
  if (!ymd) return "";
  const y = ymd.slice(0, 4), m = ymd.slice(4, 6), d = ymd.slice(6, 8);
  return `${d}/${m}/${y}`;
}

export function minToTime(min: number): string {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function formatDuration(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h}h${String(m).padStart(2, "0")}`;
}
