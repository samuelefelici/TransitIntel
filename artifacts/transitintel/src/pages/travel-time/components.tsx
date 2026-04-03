import React, { useState, useRef } from "react";
import { motion } from "framer-motion";
import {
  ArrowRight, ChevronRight, Clock, Bus, CalendarDays,
  Route, Timer, Activity,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

import type {
  DayType, ScheduleTrip, SegmentVisual, StopPoint, TripVisual, RouteItem,
} from "./types";
import { DAY_OPTS, delayColor, delayLabel, minToHM } from "./constants";

// ─── Mini Diagram SVG — modern rail style ────────────────────
export function MiniDiagram({ trip, color }: { trip: ScheduleTrip; color: string }) {
  const { stops, totalMin } = trip;
  if (stops.length < 2 || totalMin <= 0) return (
    <div className="h-7 flex items-center px-2 text-xs text-muted-foreground">—</div>
  );

  const W = 480;
  const H = 28;
  const PAD = 10;
  const lineY = H / 2;
  const trackW = W - PAD * 2;
  const trackH = 5;

  const xOf = (minsFromFirst: number) => PAD + (minsFromFirst / totalMin) * trackW;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className="w-full"
      style={{ height: H }}
    >
      <rect x={PAD} y={lineY - trackH / 2} width={trackW} height={trackH} rx={trackH / 2} fill="rgba(255,255,255,0.07)" />
      {stops.slice(0, -1).map((s, i) => {
        const x1 = xOf(s.minsFromFirst);
        const x2 = xOf(stops[i + 1].minsFromFirst);
        const cPct = stops[i + 1].congestionPct;
        const sc = cPct !== null ? delayColor(cPct) : "#475569";
        return (
          <rect key={i} x={x1} y={lineY - trackH / 2} width={Math.max(x2 - x1 - 1, 1)} height={trackH} fill={sc} />
        );
      })}
      {stops.slice(1, -1).map((s, i) => {
        const cx = xOf(s.minsFromFirst);
        return (
          <line key={i} x1={cx} y1={lineY - 8} x2={cx} y2={lineY + 8}
            stroke="rgba(255,255,255,0.25)" strokeWidth={1.5} />
        );
      })}
      <circle cx={xOf(0)} cy={lineY} r={5}
        fill={color} stroke="rgba(0,0,0,0.3)" strokeWidth={1} />
      <circle cx={xOf(totalMin)} cy={lineY} r={4}
        fill="rgba(0,0,0,0.4)" stroke={color} strokeWidth={2} />
    </svg>
  );
}

// ─── Mini Trip Card ──────────────────────────────────────────
export function MiniTripCard({
  trip, color, shortName, onClick, index,
}: {
  trip: ScheduleTrip; color: string; shortName: string;
  onClick: () => void; index: number;
}) {
  const origin = trip.stops[0]?.stopName ?? "—";
  const destination = trip.stops[trip.stops.length - 1]?.stopName ?? "—";
  const truncate = (s: string, n: number) => s.length > n ? s.substring(0, n - 1) + "…" : s;

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(index * 0.015, 0.3) }}
      onClick={onClick}
      className="group cursor-pointer border border-border/40 hover:border-primary/40 bg-card hover:bg-primary/5 rounded-xl px-3 py-2.5 transition-all hover:shadow-md"
    >
      <div className="flex items-center gap-3">
        <div className="shrink-0 text-center">
          <div className="font-mono font-bold text-base leading-none">{trip.firstDeparture?.substring(0, 5)}</div>
          <div className="text-[10px] text-muted-foreground mt-0.5">→ {trip.lastArrival?.substring(0, 5)}</div>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between mb-0.5 gap-1">
            <div className="flex items-center gap-1 min-w-0">
              <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: color }} />
              <span className="text-[9px] font-semibold text-foreground/80 truncate" title={origin}>
                {truncate(origin, 22)}
              </span>
            </div>
            <ArrowRight className="w-2.5 h-2.5 text-muted-foreground/40 shrink-0" />
            <div className="flex items-center gap-1 min-w-0 justify-end">
              <span className="text-[9px] font-semibold text-foreground/80 truncate text-right" title={destination}>
                {truncate(destination, 22)}
              </span>
              <span className="w-2 h-2 rounded-full border-2 shrink-0" style={{ borderColor: color, backgroundColor: "transparent" }} />
            </div>
          </div>
          <MiniDiagram trip={trip} color={color} />
        </div>
        <div className="shrink-0 text-right min-w-[68px]">
          <div className="font-semibold text-sm">{minToHM(trip.totalMin)}</div>
          {trip.totalExtraMin > 0.3 ? (
            <div className="text-[10px] font-medium text-red-400">
              +{trip.totalExtraMin.toFixed(1)}min traffico
            </div>
          ) : trip.totalExtraMin !== undefined && trip.totalExtraMin >= 0 ? (
            <div className="text-[10px] text-green-400">puntuale</div>
          ) : (
            <div className="text-[10px] text-muted-foreground">{trip.stopCount} fermate</div>
          )}
        </div>
        <ChevronRight className="w-4 h-4 text-muted-foreground/40 group-hover:text-primary shrink-0 transition-colors" />
      </div>
    </motion.div>
  );
}

// ─── Trip Visual Panel ────────────────────────────────────────
export function TripVisualPanel({ visual, day, selectedRoute }: {
  visual: TripVisual; day: DayType; selectedRoute?: RouteItem;
}) {
  const dayLabel = DAY_OPTS.find(d => d.key === day)?.label ?? day;
  const firstStop = visual.stops[0];
  const lastStop = visual.stops[visual.stops.length - 1];

  const segsWithCongestion = visual.segments.filter(s => s.congestionPct !== null);
  const avgCongestion = segsWithCongestion.length > 0
    ? segsWithCongestion.reduce((s, sg) => s + (sg.congestionPct ?? 0), 0) / segsWithCongestion.length : null;
  const worstSeg = segsWithCongestion.length > 0
    ? segsWithCongestion.reduce((a, b) => (b.congestionPct ?? 0) > (a.congestionPct ?? 0) ? b : a) : null;

  const segsWithDelay = visual.segments.filter(s => s.delayPct !== null);
  const avgDelay = segsWithDelay.length > 0
    ? segsWithDelay.reduce((s, sg) => s + (sg.delayPct ?? 0), 0) / segsWithDelay.length : null;

  const segsWithExtra = visual.segments.filter(s => s.extraMin !== null);
  const totalExtraMin = segsWithExtra.length > 0
    ? segsWithExtra.reduce((s, sg) => s + (sg.extraMin ?? 0), 0) : null;

  const displayColor = visual.routeColor && visual.routeColor !== "#6b7280" ? visual.routeColor : "#64748b";
  const tc = visual.trafficContext;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <span className="inline-flex items-center justify-center px-3 py-1.5 rounded-lg font-bold text-lg text-white"
          style={{ backgroundColor: displayColor }}>
          {selectedRoute?.routeShortName ?? visual.routeId}
        </span>
        <div className="flex flex-wrap gap-2">
          <Badge variant="outline" className="text-xs"><CalendarDays className="w-3 h-3 mr-1" />{dayLabel}</Badge>
          <Badge variant="outline" className="text-xs"><Clock className="w-3 h-3 mr-1" />{firstStop?.departureTime?.substring(0,5)} → {lastStop?.departureTime?.substring(0,5)}</Badge>
          <Badge variant="outline" className="text-xs"><Route className="w-3 h-3 mr-1" />{visual.totalDistanceKm} km</Badge>
          <Badge variant="outline" className="text-xs"><Timer className="w-3 h-3 mr-1" />{minToHM(visual.totalScheduledMin)}</Badge>
          <Badge variant="outline" className="text-xs"><Bus className="w-3 h-3 mr-1" />{visual.stops.length} fermate</Badge>
          {visual.tripHeadsign && <Badge variant="outline" className="text-xs"><ArrowRight className="w-3 h-3 mr-1" />{visual.tripHeadsign}</Badge>}
        </div>
      </div>

      {/* SVG Diagram */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Profilo percorrenza — velocità per tratta</CardTitle>
          <p className="text-[11px] text-muted-foreground">Ogni segmento è proporzionale alla distanza. Il colore indica il rallentamento rispetto al flusso libero TomTom.</p>
        </CardHeader>
        <CardContent className="pb-4">
          <RouteLineDiagram visual={visual} />
          <div className="flex items-center gap-3 mt-3 flex-wrap justify-center">
            {[
              { color:"#22c55e", label:"Scorrevole (<15%)" },
              { color:"#84cc16", label:"Fluido (15-35%)" },
              { color:"#eab308", label:"Moderato (35-55%)" },
              { color:"#f97316", label:"Rallentato (55-70%)" },
              { color:"#ef4444", label:"Congestionato (>70%)" },
            ].map(l => (
              <div key={l.label} className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                <div className="w-4 h-2 rounded-full" style={{ backgroundColor: l.color }} />
                {l.label}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Traffic context banner */}
      {tc && (
        <div className={`flex items-start gap-2 rounded-xl px-3 py-2.5 text-xs border ${
          tc.hasData && tc.segmentsWithTomTom > 0
            ? "bg-green-500/5 border-green-500/20 text-green-400"
            : tc.hasData
            ? "bg-amber-500/5 border-amber-500/20 text-amber-400"
            : "bg-muted/30 border-border/30 text-muted-foreground"
        }`}>
          <Activity className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <div>
            {!tc.hasData && <span>Nessun dato TomTom disponibile nel periodo selezionato — il diagramma mostra solo i tempi da orario.</span>}
            {tc.hasData && tc.segmentsWithTomTom === 0 && (
              <span>
                Dati TomTom disponibili (ore {tc.matchedHours.join(", ")} non trovate) — questa corsa opera fuori dall&apos;orario dei campioni.
                {tc.dateFrom && <span className="ml-1 opacity-70">{tc.dateFrom} → {tc.dateTo}</span>}
              </span>
            )}
            {tc.hasData && tc.segmentsWithTomTom > 0 && (
              <span>
                {tc.segmentsWithTomTom}/{tc.segmentsWithTomTom + tc.segmentsWithoutTomTom} tratte con dati TomTom reali
                (ora corrispondente) · {tc.totalSamples} snapshot
                {tc.dateFrom && <span className="ml-1 opacity-70">{tc.dateFrom} → {tc.dateTo}</span>}
              </span>
            )}
          </div>
        </div>
      )}

      {/* KPIs */}
      {(() => {
        const scheduledMin = visual.totalScheduledMin;
        const deltaMin = totalExtraMin;
        const estimatedMin = deltaMin !== null ? scheduledMin + deltaMin : null;
        const deltaPct = scheduledMin > 0 && deltaMin !== null ? (deltaMin / scheduledMin) * 100 : null;
        const isDelay = deltaMin !== null && deltaMin > 0.5;
        const isPunctual = deltaMin !== null && !isDelay;

        return (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Card className={`border-2 ${
              isDelay ? "border-red-500/40 bg-red-500/5" :
              isPunctual ? "border-green-500/40 bg-green-500/5" :
              "border-border"
            }`}><CardContent className="p-4">
              <p className="text-xs text-muted-foreground">Stima ritardo traffico</p>
              {deltaMin !== null ? (
                <>
                  <p className={`text-2xl font-bold ${isDelay ? "text-red-400" : "text-green-400"}`}>
                    +{deltaMin.toFixed(1)}<span className="text-sm font-normal"> min</span>
                  </p>
                  <p className="text-[10px] text-muted-foreground mt-0.5">
                    {isDelay
                      ? `🔴 Ritardo cumulativo su tutta la corsa (+${deltaPct!.toFixed(0)}%)`
                      : "✅ Puntuale — traffico trascurabile"}
                  </p>
                  <p className="text-[10px] text-muted-foreground/70 mt-0.5">
                    Stimato: ~{minToHM(estimatedMin!)} reali vs {minToHM(scheduledMin)} orario GTFS
                  </p>
                  <p className="text-[9px] text-muted-foreground/50 mt-0.5">
                    Somma ritardi per tratta · TomTom × fattore bus
                  </p>
                </>
              ) : <p className="text-lg text-muted-foreground">—</p>}
            </CardContent></Card>

            <Card><CardContent className="p-4">
              <p className="text-xs text-muted-foreground">Velocità media</p>
              <p className="text-2xl font-bold">
                {visual.totalDistanceKm > 0 && visual.totalScheduledMin > 0
                  ? Math.round((visual.totalDistanceKm / visual.totalScheduledMin) * 60) : 0}
                <span className="text-sm font-normal text-muted-foreground"> km/h</span>
              </p>
            </CardContent></Card>
            <Card><CardContent className="p-4">
              <p className="text-xs text-muted-foreground">Congestione stradale</p>
              {avgCongestion !== null ? (
                <>
                  <p className="text-2xl font-bold" style={{ color: delayColor(avgCongestion) }}>{Math.round(avgCongestion * 100)}%</p>
                  <p className="text-[10px] text-muted-foreground mt-0.5">{delayLabel(avgCongestion)}</p>
                </>
              ) : <p className="text-lg text-muted-foreground">—</p>}
            </CardContent></Card>
            <Card><CardContent className="p-4">
              <p className="text-xs text-muted-foreground">Tratta più lenta</p>
              {worstSeg ? (
                <>
                  <p className="text-lg font-bold" style={{ color: delayColor(worstSeg.congestionPct ?? 0) }}>{Math.round((worstSeg.congestionPct ?? 0) * 100)}%</p>
                  <p className="text-[10px] text-muted-foreground truncate mt-0.5">
                    {worstSeg.fromStop.stopName.split(" ").slice(0,2).join(" ")} → {worstSeg.toStop.stopName.split(" ").slice(0,2).join(" ")}
                  </p>
                  {worstSeg.extraMin !== null && (
                    <p className="text-[10px] text-red-400/70 mt-0.5">+{worstSeg.extraMin.toFixed(1)} min</p>
                  )}
                </>
              ) : <p className="text-muted-foreground text-sm">—</p>}
            </CardContent></Card>
          </div>
        );
      })()}

      {/* Stop table */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm">Dettaglio fermate</CardTitle></CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border text-[10px] text-muted-foreground">
                  <th className="px-3 py-2 text-left font-medium w-8">#</th>
                  <th className="px-3 py-2 text-left font-medium">Fermata</th>
                  <th className="px-3 py-2 text-left font-medium">Partenza</th>
                  <th className="px-3 py-2 text-left font-medium">Dist.</th>
                  <th className="px-3 py-2 text-left font-medium">Tempo</th>
                  <th className="px-3 py-2 text-left font-medium">Vel. sched.</th>
                  <th className="px-3 py-2 text-left font-medium">Flusso libero</th>
                  <th className="px-3 py-2 text-left font-medium">Congest.</th>
                  <th className="px-3 py-2 text-left font-medium">Ritardo</th>
                </tr>
              </thead>
              <tbody>
                {visual.stops.map((stop, i) => {
                  const seg = visual.segments.find(s => s.fromIdx === i);
                  return (
                    <tr key={stop.stopId + i} className="border-b border-border/40 hover:bg-muted/20 transition-colors">
                      <td className="px-3 py-2 text-muted-foreground font-mono">{i+1}</td>
                      <td className="px-3 py-2 font-medium max-w-[200px] truncate" title={stop.stopName}>{stop.stopName}</td>
                      <td className="px-3 py-2 font-mono text-primary">{stop.departureTime?.substring(0,5) ?? "—"}</td>
                      <td className="px-3 py-2 font-mono text-muted-foreground">{seg ? `${seg.distanceKm} km` : "—"}</td>
                      <td className="px-3 py-2 font-mono">{seg ? `${seg.scheduledMin.toFixed(1)} min` : "—"}</td>
                      <td className="px-3 py-2 font-mono">{seg ? `${seg.scheduledSpeedKmh} km/h` : "—"}</td>
                      <td className="px-3 py-2 font-mono text-muted-foreground">
                        {seg?.freeflowKmh != null ? `${seg.freeflowKmh} km/h` : "—"}
                      </td>
                      <td className="px-3 py-2">
                        {seg && seg.congestionPct !== null ? (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium"
                            style={{ color: delayColor(seg.congestionPct), backgroundColor: delayColor(seg.congestionPct) + "20" }}>
                            {Math.round(seg.congestionPct * 100)}%
                            {seg.hasTomTom && <span title="Dato TomTom reale">📡</span>}
                          </span>
                        ) : <span className="text-muted-foreground/40 text-[10px]">—</span>}
                      </td>
                      <td className="px-3 py-2">
                        {seg && seg.extraMin !== null && seg.extraMin > 0.05 ? (
                          <span className="text-[10px] font-medium text-red-400">
                            +{seg.extraMin.toFixed(1)} min
                          </span>
                        ) : seg && seg.congestionPct !== null ? (
                          <span className="text-[10px] text-green-400">≈0</span>
                        ) : <span className="text-muted-foreground/40 text-[10px]">—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ─── SVG Route Diagram ────────────────────────────────────────
export function RouteLineDiagram({ visual }: { visual: TripVisual }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [tooltip, setTooltip] = useState<{
    x: number; y: number; type: "stop" | "segment";
    stop?: StopPoint & { seq: number }; seg?: SegmentVisual;
  } | null>(null);

  const totalDist = visual.totalDistanceKm;
  const PAD = 24;
  const LINE_Y = 60;
  const DOT_R = 6;
  const SVG_H = 120;
  const SVG_W = 900;
  const TRACK_W = SVG_W - PAD * 2;

  const xOf = (dist: number) => PAD + (totalDist > 0 ? dist / totalDist : 0) * TRACK_W;

  let cumDist = 0;
  const stopPositions = visual.stops.map((stop, i) => {
    if (i > 0) {
      const seg = visual.segments.find(s => s.toIdx === i);
      cumDist += seg?.distanceKm ?? 0;
    }
    return { stop, x: xOf(cumDist), cumDist };
  });

  return (
    <div className="relative overflow-x-auto">
      <svg ref={svgRef} viewBox={`0 0 ${SVG_W} ${SVG_H}`} className="w-full"
        style={{ height: SVG_H, minWidth: 500 }}
        onMouseLeave={() => setTooltip(null)}>

        {visual.segments.map((seg, i) => {
          const from = stopPositions[seg.fromIdx];
          const to = stopPositions[seg.toIdx];
          if (!from || !to) return null;
          const color = seg.congestionPct !== null ? delayColor(seg.congestionPct) : "#475569";
          const midX = (from.x + to.x) / 2;
          return (
            <g key={i}>
              <line x1={from.x} y1={LINE_Y} x2={to.x} y2={LINE_Y}
                stroke={color} strokeWidth={6} strokeLinecap="round"
                strokeDasharray={seg.hasTomTom ? undefined : "8 4"}
                style={{ cursor: "pointer" }}
                onMouseEnter={() => setTooltip({ x: midX, y: LINE_Y - 14, type: "segment", seg })}
              />
              {to.x - from.x > 30 && (
                <text x={midX} y={LINE_Y + 20} textAnchor="middle"
                  fontSize={10} fill="#94a3b8">
                  {seg.scheduledMin.toFixed(0)}′
                </text>
              )}
            </g>
          );
        })}

        {stopPositions.map(({ stop, x }, i) => {
          const isTerminus = i === 0 || i === visual.stops.length - 1;
          const dotColor = isTerminus ? visual.routeColor || "#6b7280" : "#fff";
          const stroke = visual.routeColor || "#6b7280";
          const r = isTerminus ? DOT_R + 2 : DOT_R;
          return (
            <g key={i} style={{ cursor: "pointer" }}
              onMouseEnter={() => setTooltip({ x, y: LINE_Y - 14, type: "stop", stop: stop as any })}>
              <circle cx={x} cy={LINE_Y} r={r + 4} fill="transparent" />
              <circle cx={x} cy={LINE_Y} r={r} fill={dotColor} stroke={stroke} strokeWidth={2} />
              {isTerminus && (
                <text x={x} y={LINE_Y - 14} textAnchor={i === 0 ? "start" : "end"} fontSize={10}
                  fill="#94a3b8" fontWeight={600}>
                  {stop.stopName.length > 18 ? stop.stopName.substring(0, 16) + "…" : stop.stopName}
                </text>
              )}
            </g>
          );
        })}

        {tooltip && (
          <g>
            <rect x={Math.min(Math.max(tooltip.x - 90, 2), SVG_W - 182)} y={0} width={180} height={tooltip.type === "stop" ? 44 : 64}
              rx={6} fill="#1e293b" opacity={0.96} />
            {tooltip.type === "stop" && tooltip.stop && (
              <>
                <text x={Math.min(Math.max(tooltip.x - 90, 2), SVG_W - 182) + 8} y={16} fontSize={10} fill="#f1f5f9" fontWeight={600}>
                  {tooltip.stop.stopName.substring(0, 24)}
                </text>
                <text x={Math.min(Math.max(tooltip.x - 90, 2), SVG_W - 182) + 8} y={32} fontSize={10} fill="#94a3b8">
                  {tooltip.stop.departureTime?.substring(0, 5)}
                </text>
              </>
            )}
            {tooltip.type === "segment" && tooltip.seg && (
              <>
                <text x={Math.min(Math.max(tooltip.x - 90, 2), SVG_W - 182) + 8} y={16} fontSize={10} fill="#f1f5f9" fontWeight={600}>
                  {tooltip.seg.scheduledMin.toFixed(1)} min • {tooltip.seg.distanceKm} km
                </text>
                <text x={Math.min(Math.max(tooltip.x - 90, 2), SVG_W - 182) + 8} y={30} fontSize={10} fill="#94a3b8">
                  Orar. {tooltip.seg.scheduledSpeedKmh} km/h | FL {tooltip.seg.freeflowKmh != null ? `${tooltip.seg.freeflowKmh} km/h` : "n/d"}
                </text>
                <text x={Math.min(Math.max(tooltip.x - 90, 2), SVG_W - 182) + 8} y={48} fontSize={10}
                  fill={tooltip.seg.congestionPct !== null ? delayColor(tooltip.seg.congestionPct) : "#94a3b8"} fontWeight={600}>
                  {tooltip.seg.congestionPct !== null
                    ? `Congestione: ${Math.round(tooltip.seg.congestionPct * 100)}% — ${delayLabel(tooltip.seg.congestionPct)}${tooltip.seg.extraMin != null && tooltip.seg.extraMin > 0.05 ? ` (+${tooltip.seg.extraMin.toFixed(1)} min)` : ""}`
                    : tooltip.seg.hasTomTom ? "TomTom: fuori orario campioni" : "Nessun dato TomTom"}
                </text>
              </>
            )}
          </g>
        )}
      </svg>
    </div>
  );
}
