import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Clock, Bus, Search, CalendarDays, Route, Timer, AlertCircle,
  ArrowRight, Info, X, Filter, Activity, ChevronRight,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { getApiBase } from "@/lib/api";

// ─── Types ────────────────────────────────────────────────────
type DayType = "weekday" | "saturday" | "sunday";

interface StopStep {
  stopName: string;
  departureTime: string;
  minsFromFirst: number;
  minsFromPrev: number;
  distFromPrevKm: number;
  congestionPct: number | null;
  extraMin: number | null;
}
interface ScheduleTrip {
  tripId: string;
  headsign: string | null;
  directionId: number;
  firstDeparture: string;
  lastArrival: string;
  totalMin: number;
  stopCount: number;
  stops: StopStep[];
  totalExtraMin: number;
}
interface ScheduleData {
  trips: ScheduleTrip[];
  routeColor: string;
  routeShortName: string;
}
interface SegmentVisual {
  fromIdx: number; toIdx: number;
  fromStop: StopPoint; toStop: StopPoint;
  distanceKm: number; scheduledMin: number;
  scheduledSpeedKmh: number;
  freeflowKmh: number | null;
  currentSpeedKmh: number | null;
  delayPct: number | null;
  congestionPct: number | null;
  extraMin: number | null;
  hasTomTom: boolean;
  segHour: number;
  tomTomSamples: number;
}
interface StopPoint {
  stopId: string; stopName: string; lat: number; lon: number; departureTime: string;
}
interface TrafficContext {
  hasData: boolean;
  totalSamples: number;
  dateFrom: string | null;
  dateTo: string | null;
  dayTypes: string[];
  matchedHours: number[];
  segmentsWithTomTom: number;
  segmentsWithoutTomTom: number;
}
interface TripVisual {
  tripId: string; routeId: string; routeColor: string;
  tripHeadsign: string | null; directionId: number;
  stops: (StopPoint & { seq: number; arrivalTime: string })[];
  segments: SegmentVisual[];
  totalDistanceKm: number; totalScheduledMin: number;
  trafficContext?: TrafficContext;
}
interface TrafficAvailability {
  available: boolean;
  totalSnapshots: number;
  dateRange?: { from: string; to: string };
  dates: string[];
  dayTypes: string[];
  hours: number[];
}
interface RouteItem { routeId: string; routeShortName: string; routeColor: string }

// ─── Constants ────────────────────────────────────────────────
const DAY_OPTS: { key: DayType; label: string; icon: string; desc: string }[] = [
  { key: "weekday",  label: "Feriale",   icon: "🏫", desc: "Lun–Ven" },
  { key: "saturday", label: "Sabato",    icon: "⛔", desc: "Sabato"  },
  { key: "sunday",   label: "Domenica",  icon: "🌙", desc: "Domenica" },
];


// ─── Helpers ─────────────────────────────────────────────────
function delayColor(pct: number): string {
  if (pct < 0.15) return "#22c55e";
  if (pct < 0.35) return "#84cc16";
  if (pct < 0.55) return "#eab308";
  if (pct < 0.70) return "#f97316";
  return "#ef4444";
}
function delayLabel(pct: number): string {
  if (pct < 0.15) return "Scorrevole";
  if (pct < 0.35) return "Fluido";
  if (pct < 0.55) return "Moderato";
  if (pct < 0.70) return "Rallentato";
  return "Congestionato";
}
function minToHM(min: number): string {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h > 0 ? `${h}h ${m}min` : `${m}min`;
}
/** Segment color for mini-diagram: same 5-step palette as delayColor
 *  but based on ratio of segment time vs trip-average segment time.
 *  ratio < 0.8  → fast (green)
 *  0.8–1.0      → normal (lime)
 *  1.0–1.4      → moderate (yellow)
 *  1.4–2.0      → slow (orange)
 *  ≥ 2.0        → very slow (red)
 */
function segColor(segMin: number, avgMin: number): string {
  const ratio = avgMin > 0 ? segMin / avgMin : 1;
  if (ratio < 0.8)  return "#22c55e";
  if (ratio < 1.0)  return "#84cc16";
  if (ratio < 1.4)  return "#eab308";
  if (ratio < 2.0)  return "#f97316";
  return "#ef4444";
}
function parseHour(t: string): number {
  return parseInt((t || "0").split(":")[0] || "0", 10);
}

// ─── Mini Diagram SVG — modern rail style ────────────────────
function MiniDiagram({ trip, color }: { trip: ScheduleTrip; color: string }) {
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
      {/* Track background */}
      <rect x={PAD} y={lineY - trackH / 2} width={trackW} height={trackH} rx={trackH / 2} fill="rgba(255,255,255,0.07)" />

      {/* Colored segments — use congestionPct (TomTom) matching the detail view */}
      {stops.slice(0, -1).map((s, i) => {
        const x1 = xOf(s.minsFromFirst);
        const x2 = xOf(stops[i + 1].minsFromFirst);
        const cPct = stops[i + 1].congestionPct;
        const sc = cPct !== null ? delayColor(cPct) : "#475569";
        return (
          <rect key={i} x={x1} y={lineY - trackH / 2} width={Math.max(x2 - x1 - 1, 1)} height={trackH} fill={sc} />
        );
      })}

      {/* Intermediate stop ticks */}
      {stops.slice(1, -1).map((s, i) => {
        const cx = xOf(s.minsFromFirst);
        return (
          <line key={i} x1={cx} y1={lineY - 8} x2={cx} y2={lineY + 8}
            stroke="rgba(255,255,255,0.25)" strokeWidth={1.5} />
        );
      })}

      {/* Terminus: origin dot (filled) */}
      <circle cx={xOf(0)} cy={lineY} r={5}
        fill={color} stroke="rgba(0,0,0,0.3)" strokeWidth={1} />

      {/* Terminus: destination ring */}
      <circle cx={xOf(totalMin)} cy={lineY} r={4}
        fill="rgba(0,0,0,0.4)" stroke={color} strokeWidth={2} />
    </svg>
  );
}

// ─── Mini Trip Card ──────────────────────────────────────────
function MiniTripCard({
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
        {/* Departure time */}
        <div className="shrink-0 text-center">
          <div className="font-mono font-bold text-base leading-none">{trip.firstDeparture?.substring(0, 5)}</div>
          <div className="text-[10px] text-muted-foreground mt-0.5">→ {trip.lastArrival?.substring(0, 5)}</div>
        </div>

        {/* Mini diagram — takes remaining space */}
        <div className="flex-1 min-w-0">
          {/* Capolinea labels */}
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

        {/* Total duration + delay estimate */}
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

        {/* Click arrow */}
        <ChevronRight className="w-4 h-4 text-muted-foreground/40 group-hover:text-primary shrink-0 transition-colors" />
      </div>
    </motion.div>
  );
}

// ─── Main Page ────────────────────────────────────────────────
export default function TravelTime() {
  const [routeList, setRouteList] = useState<RouteItem[]>([]);
  const [routeSearch, setRouteSearch] = useState("");
  const [selectedRouteId, setSelectedRouteId] = useState<string | null>(null);
  const [day, setDay] = useState<DayType>("weekday");
  const [selectedDirection, setSelectedDirection] = useState<0 | 1 | null>(null);
  const [hourFrom, setHourFrom] = useState<number>(4);
  const [hourTo, setHourTo] = useState<number>(26);

  const [schedule, setSchedule] = useState<ScheduleData | null>(null);
  const [scheduleLoading, setScheduleLoading] = useState(false);
  const [scheduleError, setScheduleError] = useState<string | null>(null);

  const [detailTripId, setDetailTripId] = useState<string | null>(null);
  const [tripVisual, setTripVisual] = useState<TripVisual | null>(null);
  const [visualLoading, setVisualLoading] = useState(false);

  // Traffic context filters
  const [trafficAvail, setTrafficAvail] = useState<TrafficAvailability | null>(null);
  const [trafficDateFrom, setTrafficDateFrom] = useState<string>("");
  const [trafficDateTo, setTrafficDateTo] = useState<string>("");
  const [trafficDayTypes, setTrafficDayTypes] = useState<string[]>(["weekday", "saturday", "sunday"]);

  // Load route list
  useEffect(() => {
    fetch(`${getApiBase()}/api/gtfs/routes`, { cache: "no-store" })
      .then(r => r.json())
      .then(d => {
        const all = Array.isArray(d.data) ? d.data : [];
        const seen: Record<string, RouteItem> = {};
        for (const r of all) {
          if (!seen[r.routeId] || (r.tripsCount ?? 0) > (seen[r.routeId] as any).tripsCount) {
            seen[r.routeId] = { routeId: r.routeId, routeShortName: r.routeShortName ?? r.routeId, routeColor: r.routeColor ?? "#6b7280" };
          }
        }
        setRouteList(Object.values(seen).sort((a, b) => a.routeShortName.localeCompare(b.routeShortName, undefined, { numeric: true })));
      })
      .catch(err => console.error("Errore caricamento routes GTFS:", err));
  }, []);

  // Load traffic availability
  useEffect(() => {
    fetch(`${getApiBase()}/api/traffic/availability`, { cache: "no-store" })
      .then(r => r.json())
      .then(d => {
        setTrafficAvail(d);
        if (d.available && d.dateRange) {
          setTrafficDateFrom(d.dateRange.from);
          setTrafficDateTo(d.dateRange.to);
          if (d.dayTypes?.length) setTrafficDayTypes(d.dayTypes);
        }
      })
      .catch(err => console.error("Errore caricamento traffic availability:", err));
  }, []);

  // Auto-sync traffic day types with selected day
  useEffect(() => {
    setTrafficDayTypes([day]);
  }, [day]);

  // Load schedule when route + day changes
  useEffect(() => {
    if (!selectedRouteId) { setSchedule(null); setScheduleError(null); return; }
    setScheduleLoading(true); setSchedule(null); setScheduleError(null);
    const qs = new URLSearchParams({ routeId: selectedRouteId, day });
    if (selectedDirection !== null) qs.set("directionId", String(selectedDirection));
    fetch(`${getApiBase()}/api/gtfs/trips/schedule?${qs}`, { cache: "no-store" })
      .then(r => r.json())
      .then(d => {
        setScheduleLoading(false);
        if (d.error && !d.trips?.length) { setScheduleError(d.error); return; }
        setSchedule({ trips: d.trips ?? [], routeColor: d.routeColor ?? "#6b7280", routeShortName: d.routeShortName ?? selectedRouteId });
        if (!d.trips?.length) setScheduleError(`Nessuna corsa trovata per ${selectedRouteId} (${day})`);
      })
      .catch(() => { setScheduleLoading(false); setScheduleError("Errore nel caricamento corse"); });
  }, [selectedRouteId, day, selectedDirection]);

  // Load visual detail when a trip is selected (with traffic context)
  useEffect(() => {
    if (!detailTripId) { setTripVisual(null); return; }
    setVisualLoading(true); setTripVisual(null);
    const qs = new URLSearchParams({ tripId: detailTripId });
    if (trafficDateFrom) qs.set("dateFrom", trafficDateFrom);
    if (trafficDateTo) qs.set("dateTo", trafficDateTo);
    if (trafficDayTypes.length < 3) qs.set("dayTypes", trafficDayTypes.join(","));
    fetch(`${getApiBase()}/api/gtfs/trips/visual?${qs}`, { cache: "no-store" })
      .then(r => r.json())
      .then(d => { setVisualLoading(false); if (d.stops?.length > 0) setTripVisual(d); })
      .catch(() => setVisualLoading(false));
  }, [detailTripId, trafficDateFrom, trafficDateTo, trafficDayTypes]);

  const filteredRoutes = useMemo(() => {
    const q = routeSearch.toLowerCase();
    return routeList.filter(r => !q || r.routeShortName.toLowerCase().includes(q) || r.routeId.toLowerCase().includes(q));
  }, [routeList, routeSearch]);

  const filteredTrips = useMemo(() => {
    if (!schedule?.trips.length) return [];
    const isFullDay = hourFrom === 4 && hourTo === 26;
    return schedule.trips.filter(t => {
      if (!isFullDay) {
        const h = parseHour(t.firstDeparture);
        if (h < hourFrom || h >= hourTo) return false;
      }
      return true;
    });
  }, [schedule, hourFrom, hourTo]);

  const selectedRoute = useMemo(() => routeList.find(r => r.routeId === selectedRouteId), [routeList, selectedRouteId]);
  const routeColor = schedule?.routeColor ?? selectedRoute?.routeColor ?? "#6b7280";
  const displayColor = routeColor !== "#6b7280" ? routeColor : "#64748b";

  const openDetail = useCallback((tripId: string) => {
    setDetailTripId(tripId);
  }, []);

  const closeDetail = useCallback(() => {
    setDetailTripId(null);
    setTripVisual(null);
  }, []);

  const hasHourFilter = hourFrom !== 4 || hourTo !== 26;

  return (
    <div className="h-full flex flex-col overflow-hidden">

      {/* ── Time Range Top Bar ─────────────────────────────────── */}
      <div className="flex items-center gap-2 px-3 py-1.5 bg-background/80 backdrop-blur-xl border-b border-border/30 shrink-0">
        <Clock className="w-3 h-3 text-muted-foreground/70 shrink-0" />
        <span className="text-[10px] text-muted-foreground shrink-0">Orario</span>

        <select
          value={hourFrom}
          onChange={e => {
            const v = +e.target.value;
            setHourFrom(v);
            if (v >= hourTo) setHourTo(Math.min(v + 1, 26));
          }}
          className="text-[11px] bg-background/60 border border-border/40 rounded-md px-1.5 py-0.5 text-foreground focus:outline-none focus:ring-1 focus:ring-primary cursor-pointer"
        >
          {Array.from({ length: 23 }, (_, i) => i + 4).map(h => (
            <option key={h} value={h}>{h.toString().padStart(2, "0")}:00</option>
          ))}
        </select>

        <span className="text-[10px] text-muted-foreground/60">→</span>

        <select
          value={hourTo}
          onChange={e => {
            const v = +e.target.value;
            setHourTo(v);
            if (v <= hourFrom) setHourFrom(Math.max(v - 1, 4));
          }}
          className="text-[11px] bg-background/60 border border-border/40 rounded-md px-1.5 py-0.5 text-foreground focus:outline-none focus:ring-1 focus:ring-primary cursor-pointer"
        >
          {Array.from({ length: 22 }, (_, i) => i + 5).map(h => (
            <option key={h} value={h}>{h.toString().padStart(2, "0")}:00</option>
          ))}
        </select>

        <div className="w-px h-3.5 bg-border/40 mx-0.5 shrink-0" />

        {/* Day type buttons */}
        {DAY_OPTS.map(opt => (
          <button key={opt.key} onClick={() => setDay(opt.key)}
            className={`shrink-0 flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full border transition-all ${
              day === opt.key
                ? "bg-primary text-primary-foreground border-primary"
                : "border-border/40 text-muted-foreground hover:text-foreground hover:border-border"
            }`}>
            <span>{opt.icon}</span>
            <span>{opt.label}</span>
          </button>
        ))}

        {/* Reset button */}
        {hasHourFilter && (
          <button
            onClick={() => { setHourFrom(4); setHourTo(26); }}
            className="shrink-0 text-[10px] text-muted-foreground/60 hover:text-primary transition-colors ml-1"
          >
            Ripristina orario
          </button>
        )}

        {/* Trip count badge */}
        {selectedRouteId && filteredTrips.length > 0 && (
          <span className="ml-auto shrink-0 text-[10px] text-primary/80 bg-primary/10 px-2 py-0.5 rounded-full border border-primary/20">
            {filteredTrips.length} corse
          </span>
        )}
      </div>

      {/* ── Content row ────────────────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden">

      {/* ── Left sidebar ──────────────────────────────────── */}
      <div className="w-64 shrink-0 flex flex-col gap-0 border-r border-border/30 overflow-y-auto bg-card/30">
        <div className="p-3 space-y-3">
          {/* Header */}
          <div className="flex items-center gap-2 pt-1">
            <Timer className="w-4 h-4 text-primary" />
            <h2 className="text-sm font-semibold">Tempi di percorrenza</h2>
          </div>

          {/* Route selector */}
          <div className="space-y-1.5">
            <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
              <Bus className="w-3 h-3" /> Linea
            </p>
            <div className="relative">
              <Search className="absolute left-2 top-2 w-3 h-3 text-muted-foreground" />
              <input placeholder="Cerca..." value={routeSearch} onChange={e => setRouteSearch(e.target.value)}
                className="w-full pl-6 pr-2 py-1.5 text-xs bg-muted rounded-lg border border-border/40 focus:outline-none focus:ring-1 focus:ring-primary" />
            </div>
            <div className="max-h-36 overflow-y-auto space-y-0.5">
              {filteredRoutes.length === 0 && <p className="text-xs text-muted-foreground text-center py-2">Nessuna linea</p>}
              {filteredRoutes.map(r => (
                <button key={r.routeId} onClick={() => { setSelectedRouteId(r.routeId); setRouteSearch(""); setSelectedDirection(null); setHourFrom(4); setHourTo(26); }}
                  className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left text-xs transition-colors ${selectedRouteId === r.routeId ? "bg-primary/15 border border-primary/30" : "hover:bg-muted/70 border border-transparent"}`}>
                  <span className="w-7 h-5 inline-flex items-center justify-center rounded text-[10px] font-bold text-white shrink-0"
                    style={{ backgroundColor: r.routeColor && r.routeColor !== "#6b7280" ? r.routeColor : "#64748b" }}>
                    {r.routeShortName}
                  </span>
                  <span className="text-muted-foreground truncate">{r.routeId}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Direction filter */}
          {selectedRouteId && (
            <div className="space-y-1.5">
              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Verso</p>
              <div className="grid grid-cols-3 gap-1">
                {[
                  { val: null, label: "Tutti" },
                  { val: 0,    label: "Andata" },
                  { val: 1,    label: "Ritorno" },
                ].map(opt => (
                  <button key={String(opt.val)} onClick={() => setSelectedDirection(opt.val as any)}
                    className={`px-1.5 py-1 rounded-lg border text-[10px] font-medium transition-all ${
                      selectedDirection === opt.val
                        ? "bg-primary/15 border-primary/40 text-primary"
                        : "border-border/40 text-muted-foreground hover:bg-muted/50"
                    }`}>
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Traffic context */}
          <div className="space-y-1.5 border-t border-border/20 pt-3">
            <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1">
              <Activity className="w-3 h-3" /> Contesto Traffico
            </p>
            {trafficAvail && !trafficAvail.available && (
              <p className="text-[10px] text-amber-400/80 bg-amber-500/10 rounded-lg px-2 py-1.5">
                Nessun dato traffico disponibile.
              </p>
            )}
            {trafficAvail?.available && (
              <div className="text-[10px] text-muted-foreground bg-muted/30 rounded-lg px-2 py-1.5 space-y-0.5">
                <div>{trafficAvail.totalSnapshots} snapshot disponibili</div>
                <div>Ore rilevate: {trafficAvail.hours?.[0]}–{(trafficAvail.hours?.[trafficAvail.hours.length - 1] ?? 0) + 1}</div>
                <div className="text-primary/70">Tipo giorno: <span className="font-medium">auto ({day})</span></div>
              </div>
            )}
            {/* Date range */}
            <div className="space-y-1">
              <p className="text-[9px] text-muted-foreground uppercase tracking-wide">Periodo analisi</p>
              <div className="grid grid-cols-2 gap-1">
                <div>
                  <p className="text-[8px] text-muted-foreground mb-0.5">Da</p>
                  <input type="date" value={trafficDateFrom}
                    onChange={e => setTrafficDateFrom(e.target.value)}
                    className="w-full text-[9px] bg-muted border border-border/40 rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-primary" />
                </div>
                <div>
                  <p className="text-[8px] text-muted-foreground mb-0.5">A</p>
                  <input type="date" value={trafficDateTo}
                    onChange={e => setTrafficDateTo(e.target.value)}
                    className="w-full text-[9px] bg-muted border border-border/40 rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-primary" />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── Main area ─────────────────────────────────────── */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Topbar */}
        <div className="px-4 py-2.5 border-b border-border/30 flex items-center gap-3 shrink-0 bg-card/20">
          {selectedRoute ? (
            <>
              <span className="inline-flex items-center justify-center px-2.5 py-1 rounded font-bold text-sm text-white"
                style={{ backgroundColor: displayColor }}>
                {schedule?.routeShortName ?? selectedRoute.routeShortName}
              </span>
              <span className="text-sm text-muted-foreground">
                {scheduleLoading ? "Caricamento…" : filteredTrips.length > 0 ? `${filteredTrips.length} corse` : ""}
              </span>
              {hasHourFilter && (
                <Badge variant="secondary" className="text-xs">
                  🕐 {hourFrom.toString().padStart(2, "0")}:00–{hourTo.toString().padStart(2, "0")}:00
                </Badge>
              )}
              {selectedDirection !== null && (
                <Badge variant="secondary" className="text-xs">
                  {selectedDirection === 0 ? "→ Andata" : "← Ritorno"}
                </Badge>
              )}
            </>
          ) : (
            <span className="text-sm text-muted-foreground">Seleziona una linea per visualizzare le corse</span>
          )}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          {/* Empty state */}
          {!selectedRouteId && (
            <div className="h-full flex flex-col items-center justify-center gap-4 text-muted-foreground">
              <Route className="w-16 h-16 opacity-10" />
              <div className="text-center">
                <p className="text-lg font-semibold">Seleziona una linea</p>
                <p className="text-sm mt-1 max-w-sm">Scegli la linea a sinistra per vedere tutte le corse del giorno con i tempi per fermata.</p>
              </div>
              <div className="flex items-start gap-2 bg-blue-500/10 border border-blue-500/20 rounded-xl p-3 text-xs text-left max-w-sm">
                <Info className="w-4 h-4 text-blue-400 shrink-0 mt-0.5" />
                <span className="text-muted-foreground">
                  Ogni riga mostra il diagramma temporale della corsa. Clicca su una corsa per vedere i dettagli fermata per fermata.
                </span>
              </div>
            </div>
          )}

          {/* Loading */}
          {scheduleLoading && (
            <div className="h-48 flex flex-col items-center justify-center gap-3">
              <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
              <p className="text-sm text-muted-foreground animate-pulse">Caricamento corse…</p>
            </div>
          )}

          {/* Error */}
          {scheduleError && !scheduleLoading && (
            <div className="flex flex-col items-center gap-3 py-12 text-center">
              <AlertCircle className="w-8 h-8 text-amber-400" />
              <p className="text-sm text-muted-foreground">{scheduleError}</p>
              {scheduleError.includes("reimporta") && (
                <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg p-3 text-xs text-amber-400 max-w-xs">
                  Vai su "Import GTFS" e ricarica il feed
                </div>
              )}
            </div>
          )}

          {/* Trip mini-diagrams */}
          {!scheduleLoading && !scheduleError && filteredTrips.length > 0 && (
            <div className="space-y-1.5">
              {filteredTrips.map((trip, i) => (
                <MiniTripCard
                  key={trip.tripId}
                  trip={trip}
                  color={displayColor}
                  shortName={schedule?.routeShortName ?? ""}
                  onClick={() => openDetail(trip.tripId)}
                  index={i}
                />
              ))}
              {/* Footer total */}
              <div className="pt-2 pb-4 text-center text-xs text-muted-foreground">
                {filteredTrips.length} corse totali
                {hasHourFilter ? ` (${hourFrom.toString().padStart(2,"0")}:00–${hourTo.toString().padStart(2,"0")}:00)` : ""}
              </div>
            </div>
          )}

          {/* No results after filter */}
          {!scheduleLoading && !scheduleError && schedule && filteredTrips.length === 0 && schedule.trips.length > 0 && (
            <div className="flex flex-col items-center gap-3 py-12 text-center">
              <Filter className="w-8 h-8 opacity-20" />
              <p className="text-sm text-muted-foreground">
                Nessuna corsa nella fascia selezionata
              </p>
              <button onClick={() => { setHourFrom(4); setHourTo(26); }} className="text-xs text-primary underline">
                Rimuovi filtro orario
              </button>
            </div>
          )}
        </div>
      </div>
      </div>

      {/* ── Detail overlay ────────────────────────────────── */}
      <AnimatePresence>
        {detailTripId && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 z-50 bg-background/60 backdrop-blur-sm flex items-center justify-center p-4"
            onClick={closeDetail}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.96, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: 20 }}
              transition={{ type: "spring", stiffness: 320, damping: 32 }}
              className="bg-card rounded-2xl shadow-2xl border border-border/60 w-full max-w-4xl max-h-[90vh] flex flex-col overflow-hidden"
              onClick={e => e.stopPropagation()}
            >
              {/* Detail header */}
              <div className="flex items-center justify-between p-4 border-b border-border/30 shrink-0">
                <div className="flex items-center gap-3">
                  <span className="inline-flex items-center justify-center px-3 py-1.5 rounded-lg font-bold text-lg text-white"
                    style={{ backgroundColor: displayColor }}>
                    {schedule?.routeShortName}
                  </span>
                  {(() => {
                    const t = filteredTrips.find(x => x.tripId === detailTripId);
                    return t ? (
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-mono font-bold">{t.firstDeparture?.substring(0,5)}</span>
                          <ArrowRight className="w-3.5 h-3.5 text-muted-foreground" />
                          <span className="font-mono text-muted-foreground">{t.lastArrival?.substring(0,5)}</span>
                        </div>
                        {t.headsign && <p className="text-xs text-muted-foreground">{t.headsign}</p>}
                      </div>
                    ) : null;
                  })()}
                </div>
                <button onClick={closeDetail} className="text-muted-foreground hover:text-foreground transition-colors">
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* Detail body */}
              <div className="flex-1 overflow-y-auto p-4">
                {visualLoading && (
                  <div className="flex flex-col items-center justify-center h-48 gap-3">
                    <div className="w-7 h-7 border-4 border-primary border-t-transparent rounded-full animate-spin" />
                    <p className="text-sm text-muted-foreground">Caricamento dettaglio…</p>
                  </div>
                )}
                {!visualLoading && tripVisual && (
                  <TripVisualPanel
                    visual={tripVisual}
                    day={day}
                    selectedRoute={selectedRoute}
                  />
                )}
                {!visualLoading && !tripVisual && (
                  <div className="flex flex-col items-center gap-3 py-8 text-center">
                    {/* Fallback: show schedule data from mini card */}
                    {(() => {
                      const t = filteredTrips.find(x => x.tripId === detailTripId);
                      if (!t) return <p className="text-muted-foreground text-sm">Dati non disponibili</p>;
                      return (
                        <div className="w-full max-w-2xl space-y-4">
                          <div className="flex flex-wrap gap-2 justify-center">
                            <Badge variant="outline"><Timer className="w-3 h-3 mr-1" />{minToHM(t.totalMin)}</Badge>
                            <Badge variant="outline"><Bus className="w-3 h-3 mr-1" />{t.stopCount} fermate</Badge>
                          </div>
                          {/* Stop list */}
                          <div className="border border-border/40 rounded-xl overflow-hidden">
                            <table className="w-full text-xs">
                              <thead>
                                <tr className="bg-muted/30 border-b border-border/40">
                                  <th className="px-3 py-1.5 text-left font-medium text-muted-foreground">#</th>
                                  <th className="px-3 py-1.5 text-left font-medium text-muted-foreground">Fermata</th>
                                  <th className="px-3 py-1.5 text-left font-medium text-muted-foreground">Partenza</th>
                                  <th className="px-3 py-1.5 text-right font-medium text-muted-foreground">Min. tratto</th>
                                </tr>
                              </thead>
                              <tbody>
                                {t.stops.map((s, i) => (
                                  <tr key={i} className="border-b border-border/30 hover:bg-muted/20">
                                    <td className="px-3 py-1.5 text-muted-foreground font-mono">{i+1}</td>
                                    <td className="px-3 py-1.5 font-medium max-w-[220px] truncate">{s.stopName}</td>
                                    <td className="px-3 py-1.5 font-mono text-primary">{s.departureTime?.substring(0,5)}</td>
                                    <td className="px-3 py-1.5 text-right font-mono text-muted-foreground">
                                      {i > 0 ? `${Math.round(s.minsFromPrev)}'` : "—"}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ─── Trip Visual Panel ────────────────────────────────────────
function TripVisualPanel({ visual, day, selectedRoute }: {
  visual: TripVisual; day: DayType; selectedRoute?: RouteItem;
}) {
  const dayLabel = DAY_OPTS.find(d => d.key === day)?.label ?? day;
  const firstStop = visual.stops[0];
  const lastStop = visual.stops[visual.stops.length - 1];

  // Segments with real road congestion data
  const segsWithCongestion = visual.segments.filter(s => s.congestionPct !== null);
  const avgCongestion = segsWithCongestion.length > 0
    ? segsWithCongestion.reduce((s, sg) => s + (sg.congestionPct ?? 0), 0) / segsWithCongestion.length : null;
  const worstSeg = segsWithCongestion.length > 0
    ? segsWithCongestion.reduce((a, b) => (b.congestionPct ?? 0) > (a.congestionPct ?? 0) ? b : a) : null;

  // Legacy delayPct for backward compat display
  const segsWithDelay = visual.segments.filter(s => s.delayPct !== null);
  const avgDelay = segsWithDelay.length > 0
    ? segsWithDelay.reduce((s, sg) => s + (sg.delayPct ?? 0), 0) / segsWithDelay.length : null;

  // Real bus impact: sum of extraMin across all segments
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
        /* Estimated bus delay based on real road congestion (extraMin from backend).
         * totalExtraMin = sum of each segment's scheduledMin × congestionPct × 0.4
         * This gives realistic values: a 24min trip with moderate congestion → +1-3 min, not +13.
         */
        const scheduledMin = visual.totalScheduledMin;
        const deltaMin = totalExtraMin;
        const estimatedMin = deltaMin !== null ? scheduledMin + deltaMin : null;
        const deltaPct = scheduledMin > 0 && deltaMin !== null ? (deltaMin / scheduledMin) * 100 : null;
        const isDelay = deltaMin !== null && deltaMin > 0.5;
        const isPunctual = deltaMin !== null && !isDelay;

        return (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {/* Estimated real time vs GTFS – prominent card */}
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
function RouteLineDiagram({ visual }: { visual: TripVisual }) {
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

        {/* Segment lines */}
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

        {/* Stop dots */}
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

        {/* Tooltip */}
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
