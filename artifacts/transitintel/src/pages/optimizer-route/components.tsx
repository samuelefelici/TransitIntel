import React, { useState, useCallback } from "react";
import {
  AlertTriangle, Clock, ArrowRight, Navigation, MapPin,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { ShiftTripEntry, VehicleShift } from "./types";
import { VEHICLE_LABELS, CATEGORY_COLORS, VEHICLE_SHORT } from "./constants";

/* ═══════════════════════════════════════════════════════════════
 *  SummaryCard
 * ═══════════════════════════════════════════════════════════════ */

export function SummaryCard({ icon, label, value, color, sub }: {
  icon: React.ReactNode; label: string; value: string; color?: string; sub?: string;
}) {
  return (
    <div className="bg-muted/40 rounded-lg p-3 min-w-[130px]">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">{icon} {label}</div>
      <div className="text-lg font-bold" style={color ? { color } : undefined}>{value}</div>
      {sub && <div className="text-[10px] text-muted-foreground mt-0.5">{sub}</div>}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
 *  TripTooltip — popup on hover
 * ═══════════════════════════════════════════════════════════════ */

export function TripTooltip({ entry, style }: { entry: ShiftTripEntry; style: React.CSSProperties }) {
  return (
    <div className="absolute z-50 pointer-events-none" style={style}>
      <div className="bg-card border border-border rounded-lg shadow-xl p-3 min-w-[260px] text-xs space-y-1.5">
        <div className="flex items-center gap-2">
          <Badge variant="secondary" className="text-[11px] font-medium">{entry.routeName}</Badge>
          {entry.headsign && <span className="text-muted-foreground truncate">→ {entry.headsign}</span>}
          <span className="text-[9px] text-muted-foreground ml-auto">dir {entry.directionId ?? "?"}</span>
        </div>
        {entry.downsized && entry.originalVehicle && (
          <div className="flex items-center gap-1.5 bg-amber-500/10 border border-amber-500/20 rounded px-2 py-1">
            <AlertTriangle className="w-3 h-3 text-amber-400 shrink-0" />
            <span className="text-amber-400 text-[10px]">
              Mezzo ridotto — richiesto <strong>{VEHICLE_LABELS[entry.originalVehicle]}</strong>
            </span>
          </div>
        )}
        <div className="flex items-center gap-2">
          <Clock className="w-3 h-3 text-primary shrink-0" />
          <span className="font-medium">{entry.departureTime.slice(0, 5)}</span>
          <ArrowRight className="w-3 h-3 text-muted-foreground" />
          <span className="font-medium">{entry.arrivalTime.slice(0, 5)}</span>
          <span className="text-muted-foreground">({entry.durationMin ?? "?"}′)</span>
        </div>
        {entry.firstStopName && (
          <div className="flex items-center gap-2">
            <Navigation className="w-3 h-3 text-green-400 shrink-0" />
            <span className="text-green-400">{entry.firstStopName}</span>
          </div>
        )}
        {entry.lastStopName && (
          <div className="flex items-center gap-2">
            <MapPin className="w-3 h-3 text-red-400 shrink-0" />
            <span className="text-red-400">{entry.lastStopName}</span>
          </div>
        )}
        {entry.stopCount != null && (
          <div className="text-muted-foreground">{entry.stopCount} fermate</div>
        )}
        <div className="text-[9px] text-muted-foreground/60 font-mono pt-1 border-t border-border/20">{entry.tripId}</div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
 *  GanttChart
 * ═══════════════════════════════════════════════════════════════ */

export function GanttChart({ shifts, routeColorMap }: { shifts: VehicleShift[]; routeColorMap: Map<string, string> }) {
  const minHour = 4;
  const maxHour = 25;
  const totalMin = (maxHour - minHour) * 60;

  const [hoveredTrip, setHoveredTrip] = useState<{ entry: ShiftTripEntry; x: number; y: number } | null>(null);

  const handleMouseEnter = useCallback((e: React.MouseEvent, entry: ShiftTripEntry) => {
    if (entry.type !== "trip") return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const parentRect = (e.currentTarget as HTMLElement).closest(".gantt-container")?.getBoundingClientRect();
    if (!parentRect) return;
    setHoveredTrip({
      entry,
      x: rect.left - parentRect.left,
      y: rect.bottom - parentRect.top + 4,
    });
  }, []);

  const handleMouseLeave = useCallback(() => setHoveredTrip(null), []);

  return (
    <div className="overflow-x-auto gantt-container relative">
      <div className="min-w-[800px]">
        <div className="flex border-b border-border/30 mb-1">
          <div className="w-32 shrink-0" />
          <div className="flex-1 relative h-6">
            {Array.from({ length: maxHour - minHour + 1 }, (_, i) => {
              const h = minHour + i;
              const pct = (i * 60 / totalMin) * 100;
              return (
                <span key={h} className="absolute text-[9px] text-muted-foreground" style={{ left: `${pct}%` }}>
                  {h}:00
                </span>
              );
            })}
          </div>
        </div>
        {shifts.map(shift => (
          <div key={shift.vehicleId} className="flex items-center h-7 group hover:bg-muted/20">
            <div className="w-32 shrink-0 text-[10px] font-mono flex items-center gap-1 px-1">
              <span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: CATEGORY_COLORS[shift.category] }} />
              {shift.vehicleId}
              <span className="text-muted-foreground">({VEHICLE_SHORT[shift.vehicleType]})</span>
              <span className="text-[8px] text-muted-foreground/60">#{shift.fifoOrder}</span>
            </div>
            <div className="flex-1 relative h-5">
              {Array.from({ length: maxHour - minHour + 1 }, (_, i) => (
                <div key={i} className="absolute top-0 bottom-0 border-l border-border/10"
                  style={{ left: `${(i * 60 / totalMin) * 100}%` }} />
              ))}
              {shift.trips.map((entry, i) => {
                const left = ((entry.departureMin - minHour * 60) / totalMin) * 100;
                const width = Math.max(0.2, ((entry.arrivalMin - entry.departureMin) / totalMin) * 100);
                if (entry.type === "depot") {
                  return (
                    <div key={i}
                      className="absolute top-1 h-3 rounded-sm flex items-center justify-center text-[7px] text-muted-foreground cursor-default"
                      style={{ left: `${left}%`, width: `${width}%`, backgroundColor: "rgba(255,255,255,0.05)", border: "1px dashed rgba(255,255,255,0.15)" }}
                      title={`🏠 Deposito ${entry.departureTime.slice(0, 5)}→${entry.arrivalTime.slice(0, 5)}`}
                    >{width > 2 ? "🏠" : ""}</div>
                  );
                }
                if (entry.type === "deadhead") {
                  return (
                    <div key={i}
                      className="absolute top-1.5 h-2 rounded-full cursor-default"
                      style={{ left: `${left}%`, width: `${width}%`, backgroundColor: "rgba(255,255,255,0.12)",
                        backgroundImage: "repeating-linear-gradient(90deg, transparent, transparent 3px, rgba(255,255,255,0.2) 3px, rgba(255,255,255,0.2) 6px)" }}
                      title={`↝ Vuoto ${entry.deadheadKm}km | ${entry.departureTime.slice(0, 5)}→${entry.arrivalTime.slice(0, 5)}`}
                    />
                  );
                }
                const tripColor = routeColorMap.get(entry.routeId) || "#6b7280";
                const isDownsized = entry.downsized === true;
                return (
                  <div key={i}
                    className="absolute top-0.5 h-4 rounded-sm text-[8px] text-white flex items-center justify-center overflow-hidden whitespace-nowrap cursor-pointer hover:brightness-125 hover:z-10 transition-all"
                    style={{
                      left: `${left}%`, width: `${width}%`, backgroundColor: tripColor, opacity: 0.85,
                      ...(isDownsized ? { border: "1.5px dashed #f59e0b", boxShadow: "0 0 3px rgba(245,158,11,0.3)" } : {}),
                    }}
                    onMouseEnter={e => handleMouseEnter(e, entry)}
                    onMouseLeave={handleMouseLeave}
                  >{width > 2 ? entry.routeName : ""}</div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      {/* Floating tooltip */}
      {hoveredTrip && (
        <TripTooltip entry={hoveredTrip.entry} style={{ left: hoveredTrip.x, top: hoveredTrip.y }} />
      )}
    </div>
  );
}
