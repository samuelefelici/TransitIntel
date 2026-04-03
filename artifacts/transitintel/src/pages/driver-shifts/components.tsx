import React, { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, Coffee, Bus } from "lucide-react";
import type { DriverShiftData, DriverShiftType } from "./types";
import { TYPE_LABELS, TYPE_COLORS, minToTime } from "./constants";

/* ═══════════════════════════════════════════════════════════════
 *  ERROR BOUNDARY — prevents white/black screen on render crash
 * ═══════════════════════════════════════════════════════════════ */

export class DriverShiftsErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean; error: Error | null }
> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[DriverShifts] Render crash:", error, info);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="max-w-3xl mx-auto p-6">
          <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-6">
            <div className="flex items-center gap-2 mb-3">
              <AlertTriangle className="w-5 h-5 text-red-400" />
              <h2 className="text-lg font-bold text-red-400">Errore di rendering</h2>
            </div>
            <p className="text-sm text-muted-foreground mb-2">
              Si è verificato un errore durante il rendering della pagina Turni Guida.
            </p>
            <pre className="text-xs bg-black/30 rounded p-3 overflow-auto max-h-40 text-red-300">
              {this.state.error?.message}
              {"\n"}
              {this.state.error?.stack?.split("\n").slice(0, 5).join("\n")}
            </pre>
            <button
              onClick={() => this.setState({ hasError: false, error: null })}
              className="mt-4 px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/90"
            >
              Riprova
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

/* ═══════════════════════════════════════════════════════════════
 *  SUMMARY CARD
 * ═══════════════════════════════════════════════════════════════ */

export function SummaryCard({ icon, label, value, sub, color }: {
  icon: React.ReactNode; label: string; value: string; sub?: string; color?: string;
}) {
  return (
    <div className="flex items-center gap-3 bg-muted/30 rounded-xl px-4 py-3 border border-border/30">
      <div className="text-primary">{icon}</div>
      <div>
        <div className="text-[10px] text-muted-foreground">{label}</div>
        <div className="text-lg font-bold" style={{ color }}>{value}</div>
        {sub && <div className="text-[10px] text-muted-foreground">{sub}</div>}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
 *  GANTT CHART — Driver Shifts
 * ═══════════════════════════════════════════════════════════════ */

export function DriverGantt({ shifts }: { shifts: DriverShiftData[] }) {
  if (shifts.length === 0) return <p className="text-sm text-muted-foreground text-center py-4">Nessun turno guida</p>;

  const minHour = Math.max(3, Math.floor(Math.min(...shifts.map(s => s.nastroStartMin)) / 60) - 1);
  const maxHour = Math.min(27, Math.ceil(Math.max(...shifts.map(s => s.nastroEndMin)) / 60) + 1);
  const totalMin = (maxHour - minHour) * 60;

  return (
    <div className="overflow-x-auto">
      <div className="min-w-[800px]">
        {/* Time header */}
        <div className="flex border-b border-border/30 mb-1">
          <div className="w-36 shrink-0" />
          <div className="flex-1 relative h-6">
            {Array.from({ length: maxHour - minHour + 1 }, (_, i) => {
              const h = minHour + i;
              const pct = (i * 60 / totalMin) * 100;
              return <span key={h} className="absolute text-[9px] text-muted-foreground" style={{ left: `${pct}%` }}>{h}:00</span>;
            })}
          </div>
        </div>

        {shifts.map(shift => {
          const typeColor = TYPE_COLORS[shift.type];
          return (
            <div key={shift.driverId} className="flex items-center h-8 group hover:bg-muted/20">
              <div className="w-36 shrink-0 text-[10px] font-mono flex items-center gap-1 px-1">
                <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ backgroundColor: typeColor }} />
                {shift.driverId}
                <span className="text-muted-foreground">({(TYPE_LABELS[shift.type] ?? "???").slice(0, 3)})</span>
              </div>
              <div className="flex-1 relative h-6">
                {/* Grid lines */}
                {Array.from({ length: maxHour - minHour + 1 }, (_, i) => (
                  <div key={i} className="absolute top-0 bottom-0 border-l border-border/10"
                    style={{ left: `${(i * 60 / totalMin) * 100}%` }} />
                ))}

                {/* Riprese */}
                {shift.riprese.map((rip, ri) => {
                  const left = ((rip.startMin - minHour * 60) / totalMin) * 100;
                  const width = Math.max(0.3, ((rip.endMin - rip.startMin) / totalMin) * 100);

                  const preTurnoWidth = (rip.preTurnoMin / totalMin) * 100;
                  const transferWidth = (rip.transferMin / totalMin) * 100;
                  const transferLeft = left + preTurnoWidth;
                  const transferBackWidth = ((rip.transferBackMin || 0) / totalMin) * 100;
                  const tripsLeft = transferLeft + transferWidth;
                  const tripsWidth = width - preTurnoWidth - transferWidth - transferBackWidth;
                  const transferBackLeft = tripsLeft + tripsWidth;

                  return (
                    <React.Fragment key={ri}>
                      {/* Pre-turno */}
                      <div className="absolute top-0.5 h-5 rounded-l-sm text-[7px] text-white/60 flex items-center justify-center"
                        style={{ left: `${left}%`, width: `${preTurnoWidth}%`, backgroundColor: typeColor, opacity: 0.35 }}
                        title={`Pre-turno ${rip.preTurnoMin}min`}
                      >{preTurnoWidth > 1.5 ? "PT" : ""}</div>

                      {/* Transfer */}
                      {rip.transferMin > 0 && (
                        <div className="absolute top-0.5 h-5 text-[7px] text-white/60 flex items-center justify-center"
                          style={{ left: `${transferLeft}%`, width: `${transferWidth}%`, backgroundColor: typeColor, opacity: 0.5 }}
                          title={`Trasf. deposito → ${rip.transferToStop || "capolinea"} ${rip.transferMin}min`}
                        >{transferWidth > 1.5 ? "↝" : ""}</div>
                      )}

                      {/* Service trips */}
                      <div className="absolute top-0.5 h-5 text-[8px] text-white flex items-center justify-center overflow-hidden whitespace-nowrap"
                        style={{ left: `${tripsLeft}%`, width: `${Math.max(0.2, tripsWidth)}%`, backgroundColor: typeColor, opacity: 0.85 }}
                        title={`${rip.trips.length} corse · ${minToTime(rip.startMin)}→${minToTime(rip.endMin)} · Veicolo: ${rip.vehicleIds.join(", ")}${rip.cambi?.length ? ` · ${rip.cambi.length} cambi in linea` : ""}`}
                      >{tripsWidth > 3 ? `${rip.trips.length} corse` : ""}</div>

                      {/* Transfer back */}
                      {(rip.transferBackMin || 0) > 0 && (
                        <div className="absolute top-0.5 h-5 rounded-r-sm text-[7px] text-white/60 flex items-center justify-center"
                          style={{ left: `${transferBackLeft}%`, width: `${transferBackWidth}%`, backgroundColor: typeColor, opacity: 0.5 }}
                          title={`Rientro ${rip.lastStop || "capolinea"} → deposito ${rip.transferBackMin}min`}
                        >{transferBackWidth > 1.5 ? "↜" : ""}</div>
                      )}

                      {/* Cambio in linea markers */}
                      {rip.cambi?.map((c, ci) => {
                        const cLeft = ((c.atMin - minHour * 60) / totalMin) * 100;
                        return (
                          <div key={`c${ci}`} className="absolute"
                            style={{ left: `${cLeft}%`, top: "-2px" }}
                            title={`Cambio in linea @ ${c.clusterName}: ${c.fromVehicle}→${c.toVehicle}`}
                          >
                            <div className="w-0 h-0 border-l-[3px] border-r-[3px] border-t-[5px] border-l-transparent border-r-transparent border-t-cyan-400" />
                          </div>
                        );
                      })}
                    </React.Fragment>
                  );
                })}

                {/* Interruption gap indicator */}
                {shift.interruptionMin > 0 && shift.riprese.length === 2 && (
                  <div className="absolute top-2 h-2 rounded-full"
                    style={{
                      left: `${((shift.riprese[0].endMin - minHour * 60) / totalMin) * 100}%`,
                      width: `${((shift.riprese[1].startMin - shift.riprese[0].endMin) / totalMin) * 100}%`,
                      backgroundColor: "rgba(255,255,255,0.06)",
                      backgroundImage: "repeating-linear-gradient(90deg, transparent, transparent 4px, rgba(255,255,255,0.15) 4px, rgba(255,255,255,0.15) 8px)",
                    }}
                    title={`Interruzione ${shift.interruption}`}
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
