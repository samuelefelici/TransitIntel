import type { DayType } from "./types";

// ─── Constants ────────────────────────────────────────────────
export const DAY_OPTS: { key: DayType; label: string; icon: string; desc: string }[] = [
  { key: "weekday",  label: "Feriale",   icon: "🏫", desc: "Lun–Ven" },
  { key: "saturday", label: "Sabato",    icon: "⛔", desc: "Sabato"  },
  { key: "sunday",   label: "Domenica",  icon: "🌙", desc: "Domenica" },
];

// ─── Helpers ─────────────────────────────────────────────────
export function delayColor(pct: number): string {
  if (pct < 0.15) return "#22c55e";
  if (pct < 0.35) return "#84cc16";
  if (pct < 0.55) return "#eab308";
  if (pct < 0.70) return "#f97316";
  return "#ef4444";
}

export function delayLabel(pct: number): string {
  if (pct < 0.15) return "Scorrevole";
  if (pct < 0.35) return "Fluido";
  if (pct < 0.55) return "Moderato";
  if (pct < 0.70) return "Rallentato";
  return "Congestionato";
}

export function minToHM(min: number): string {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h > 0 ? `${h}h ${m}min` : `${m}min`;
}

export function segColor(segMin: number, avgMin: number): string {
  const ratio = avgMin > 0 ? segMin / avgMin : 1;
  if (ratio < 0.8) return "#22c55e";
  if (ratio < 1.0) return "#84cc16";
  if (ratio < 1.4) return "#eab308";
  if (ratio < 2.0) return "#f97316";
  return "#ef4444";
}

export function parseHour(t: string): number {
  return parseInt((t || "0").split(":")[0] || "0", 10);
}
