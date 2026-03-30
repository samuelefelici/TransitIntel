import React from "react";
import { Clock } from "lucide-react";
import type { DayFilter } from "./types";

interface TimeRangeBarProps {
  hourFrom: number;
  hourTo: number;
  dayFilter: DayFilter;
  timeBandRouteIds: string[] | null;
  onHourFromChange: (v: number) => void;
  onHourToChange: (v: number) => void;
  onDayFilterChange: (v: DayFilter) => void;
  onReset: () => void;
}

export function TimeRangeBar({
  hourFrom, hourTo, dayFilter, timeBandRouteIds,
  onHourFromChange, onHourToChange, onDayFilterChange, onReset,
}: TimeRangeBarProps) {
  const isDefault = hourFrom === 4 && hourTo === 26 && dayFilter === "tutti";

  return (
    <div className="absolute top-0 left-0 right-0 z-10 pointer-events-auto">
      <div className="flex items-center gap-2 px-3 py-1.5 bg-background/80 backdrop-blur-xl border-b border-border/30">
        <Clock className="w-3 h-3 text-muted-foreground/70 shrink-0" />
        <span className="text-[10px] text-muted-foreground shrink-0">Orario</span>

        {/* From hour */}
        <select
          value={hourFrom}
          onChange={e => {
            const v = +e.target.value;
            onHourFromChange(v);
            if (v >= hourTo) onHourToChange(Math.min(v + 1, 26));
          }}
          className="text-[11px] bg-background/60 border border-border/40 rounded-md px-1.5 py-0.5 text-foreground focus:outline-none focus:ring-1 focus:ring-primary cursor-pointer"
        >
          {Array.from({ length: 23 }, (_, i) => i + 4).map(h => (
            <option key={h} value={h}>{h.toString().padStart(2, "0")}:00</option>
          ))}
        </select>

        <span className="text-[10px] text-muted-foreground/60">→</span>

        {/* To hour */}
        <select
          value={hourTo}
          onChange={e => {
            const v = +e.target.value;
            onHourToChange(v);
            if (v <= hourFrom) onHourFromChange(Math.max(v - 1, 4));
          }}
          className="text-[11px] bg-background/60 border border-border/40 rounded-md px-1.5 py-0.5 text-foreground focus:outline-none focus:ring-1 focus:ring-primary cursor-pointer"
        >
          {Array.from({ length: 22 }, (_, i) => i + 5).map(h => (
            <option key={h} value={h}>{h.toString().padStart(2, "0")}:00</option>
          ))}
        </select>

        <div className="w-px h-3.5 bg-border/40 mx-0.5 shrink-0" />

        {/* Day filter */}
        {(["tutti", "feriale", "sabato", "domenica"] as const).map(d => (
          <button key={d} onClick={() => onDayFilterChange(d)}
            className={`shrink-0 text-[10px] px-2 py-0.5 rounded-full border transition-all ${
              dayFilter === d
                ? "bg-primary text-primary-foreground border-primary"
                : "border-border/40 text-muted-foreground hover:text-foreground hover:border-border"
            }`}>
            {d === "tutti" ? "Tutti" : d.charAt(0).toUpperCase() + d.slice(1)}
          </button>
        ))}

        {/* Active route count badge */}
        {timeBandRouteIds !== null && (
          <span className="ml-auto shrink-0 text-[10px] text-primary/80 bg-primary/10 px-2 py-0.5 rounded-full border border-primary/20">
            {timeBandRouteIds.length} linee attive
          </span>
        )}

        {/* Reset */}
        {!isDefault && (
          <button
            onClick={onReset}
            className="shrink-0 text-[10px] text-muted-foreground/60 hover:text-primary transition-colors ml-1"
          >
            Ripristina
          </button>
        )}
      </div>
    </div>
  );
}
