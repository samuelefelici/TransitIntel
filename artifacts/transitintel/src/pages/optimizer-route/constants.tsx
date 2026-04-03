import React from "react";
import { AlertCircle, AlertTriangle, Info } from "lucide-react";
import type { VehicleType, ServiceCategory } from "./types";

/* ═══════════════════════════════════════════════════════════════
 *  Optimizer Route – Constants & utilities
 * ═══════════════════════════════════════════════════════════════ */

export const VEHICLE_LABELS: Record<VehicleType, string> = {
  autosnodato: "Autosnodato (18m)",
  "12m": "12 metri",
  "10m": "10 metri",
  pollicino: "Pollicino (6m)",
};

export const VEHICLE_COLORS: Record<VehicleType, string> = {
  autosnodato: "#ef4444",
  "12m": "#3b82f6",
  "10m": "#f59e0b",
  pollicino: "#22c55e",
};

export const VEHICLE_SHORT: Record<VehicleType, string> = {
  autosnodato: "18m",
  "12m": "12m",
  "10m": "10m",
  pollicino: "6m",
};

export const ROUTE_PALETTE = [
  "#3b82f6", "#ef4444", "#22c55e", "#f59e0b", "#8b5cf6",
  "#ec4899", "#06b6d4", "#f97316", "#14b8a6", "#a855f7",
  "#64748b", "#e11d48", "#0ea5e9", "#84cc16", "#d946ef",
  "#fb923c", "#2dd4bf", "#6366f1", "#facc15", "#f43f5e",
  "#10b981", "#7c3aed", "#0284c7", "#65a30d", "#c026d3",
  "#ea580c", "#059669", "#4f46e5", "#ca8a04", "#be185d",
];

export const CATEGORY_LABELS: Record<ServiceCategory, string> = {
  urbano: "Urbano",
  extraurbano: "Extraurbano",
};

export const CATEGORY_COLORS: Record<ServiceCategory, string> = {
  urbano: "#3b82f6",
  extraurbano: "#f59e0b",
};

export const SEV_CONFIG = {
  critical: { icon: AlertCircle, bg: "bg-red-500/10", border: "border-red-500/30", text: "text-red-400", badge: "bg-red-500/20 text-red-400" },
  warning: { icon: AlertTriangle, bg: "bg-amber-500/10", border: "border-amber-500/30", text: "text-amber-400", badge: "bg-amber-500/20 text-amber-400" },
  info: { icon: Info, bg: "bg-blue-500/10", border: "border-blue-500/30", text: "text-blue-400", badge: "bg-blue-500/20 text-blue-400" },
} as const;

/* ── Date helpers ── */

export function ymdToIso(ymd: string): string {
  return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
}

export function ymdToDisplay(ymd: string): string {
  return `${ymd.slice(6, 8)}/${ymd.slice(4, 6)}/${ymd.slice(0, 4)}`;
}

export function minToTime(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
