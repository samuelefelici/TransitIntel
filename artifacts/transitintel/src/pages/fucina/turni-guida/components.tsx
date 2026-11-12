import React from "react";

/* ═══════════════════════════════════════════════════════════════
 *  SUMMARY CARD
 * ═══════════════════════════════════════════════════════════════ */

export function SummaryCard({ icon, label, value, sub, color, delta }: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub?: string;
  color?: string;
  /** Delta vs baseline per modalità what-if. `lowerIsBetter` default true. */
  delta?: { value: number; unit?: string; lowerIsBetter?: boolean; format?: (v: number) => string } | null;
}) {
  const showDelta =
    delta != null && Math.abs(delta.value) > (delta.unit === "€" ? 0.5 : 0.05);
  const lowerBetter = delta?.lowerIsBetter ?? true;
  const isGood = showDelta && (lowerBetter ? delta!.value < 0 : delta!.value > 0);
  const sign = showDelta && delta!.value > 0 ? "+" : "";
  const formatted = showDelta
    ? (delta!.format ? delta!.format(delta!.value) : `${sign}${delta!.value}${delta!.unit ?? ""}`)
    : "";
  return (
    <div className="flex items-center gap-3 bg-muted/30 rounded-xl px-4 py-3 border border-border/30">
      <div className="text-primary">{icon}</div>
      <div className="min-w-0">
        <div className="text-[10px] text-muted-foreground">{label}</div>
        <div className="flex items-baseline gap-1.5">
          <div className="text-lg font-bold" style={{ color }}>{value}</div>
          {showDelta && (
            <span
              className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${
                isGood
                  ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                  : "bg-rose-500/15 text-rose-600 dark:text-rose-400"
              }`}
              title="Variazione rispetto alla baseline (ottimizzazione iniziale)"
            >
              {formatted}
            </span>
          )}
        </div>
        {sub && <div className="text-[10px] text-muted-foreground">{sub}</div>}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
 *  GANTT CHART — Driver Shifts
 * ═══════════════════════════════════════════════════════════════ */

