import React, { useState, useMemo, useCallback, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip as ReTooltip, ResponsiveContainer,
  CartesianGrid, RadarChart, PolarGrid, PolarAngleAxis, Radar,
} from "recharts";
import {
  Loader2, Play, Calendar, Bus, ChevronDown, ChevronUp,
  CheckSquare, Square, Search, AlertTriangle, Clock, ClipboardList,
  Truck, ArrowRight, Timer, BarChart3, Filter, Home, MapPin,
  Euro, TrendingUp, Shield, Lightbulb, Fuel, Award, Info,
  AlertCircle, Zap, RefreshCw, Navigation, Lock, Unlock,
  Save, FolderOpen, Trash2, Users, X,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { getApiBase } from "@/lib/api";

/* ═══════════════════════════════════════════════════════════════
 *  TYPES
 * ═══════════════════════════════════════════════════════════════ */

type VehicleType = "autosnodato" | "12m" | "10m" | "pollicino";
type ServiceCategory = "urbano" | "extraurbano";

interface RouteItem {
  routeId: string;
  name: string;
  longName: string | null;
  tripsCount: number;
  color: string | null;
  category: ServiceCategory;
}

interface VehicleTypeInfo {
  id: string;
  label: string;
  capacity: number;
  sizeIndex: number;
}

interface ShiftTripEntry {
  type: "trip" | "deadhead" | "depot";
  tripId: string;
  routeId: string;
  routeName: string;
  headsign: string | null;
  departureTime: string;
  arrivalTime: string;
  departureMin: number;
  arrivalMin: number;
  deadheadKm?: number;
  deadheadMin?: number;
  // Extra trip data for tooltip
  firstStopName?: string;
  lastStopName?: string;
  stopCount?: number;
  durationMin?: number;
  directionId?: number;
  /** True when trip runs on a smaller vehicle than originally assigned */
  downsized?: boolean;
  /** Original required vehicle type (set when downsized) */
  originalVehicle?: VehicleType;
}

interface VehicleShift {
  vehicleId: string;
  vehicleType: VehicleType;
  category: ServiceCategory;
  trips: ShiftTripEntry[];
  startMin: number;
  endMin: number;
  totalServiceMin: number;
  totalDeadheadMin: number;
  totalDeadheadKm: number;
  depotReturns: number;
  tripCount: number;
  fifoOrder: number;
  firstOut: number;
  lastIn: number;
  shiftDuration: number;
  downsizedTrips: number;
}

interface RouteStatItem {
  routeId: string;
  routeName: string;
  vehicleType: string;
  category: string;
  tripsCount: number;
  vehiclesNeeded: number;
  firstDeparture: string;
  lastArrival: string;
}

interface ScenarioCost {
  vehicleFixedCost: number;
  vehicleServiceKmCost: number;
  vehicleDeadheadKmCost: number;
  vehicleTotalCost: number;
  driverCost: number;
  depotReturnCost: number;
  idleCost: number;
  totalDailyCost: number;
  costPerTrip: number;
  costPerServiceHour: number;
  byVehicleType: Record<string, { count: number; fixedCost: number; serviceKmCost: number; deadheadKmCost: number; totalVehicleCost: number; serviceKm: number; deadheadKm: number }>;
  byCategory: Record<string, { vehicles: number; vehicleCost: number; driverCost: number; totalCost: number }>;
}

interface ScenarioScore {
  overall: number;
  efficiency: number;
  fleetUtilization: number;
  deadheadRatio: number;
  costEfficiency: number;
  fifoCompliance: number;
  grade: string;
  gradeColor: string;
}

interface Advisory {
  id: string;
  severity: "info" | "warning" | "critical";
  category: string;
  title: string;
  description: string;
  impact: string;
  action: string;
  metric?: number;
}

interface ServiceProgramResult {
  shifts: VehicleShift[];
  unassigned: any[];
  routeStats: RouteStatItem[];
  hourlyDist: { hour: number; trips: number }[];
  summary: {
    date: string;
    activeServices: number;
    totalTrips: number;
    selectedRoutes: number;
    totalVehicles: number;
    byType: Record<string, number>;
    byCategory: Record<string, number>;
    totalServiceHours: number;
    totalDeadheadHours: number;
    totalDeadheadKm: number;
    depotReturns: number;
    efficiency: number;
    downsizedTrips?: number;
    message?: string;
  };
  costs: ScenarioCost;
  score: ScenarioScore;
  advisories: Advisory[];
  solver?: "greedy" | "cpsat";
  solverMetrics?: any;
}

/* ═══════════════════════════════════════════════════════════════
 *  CONSTANTS
 * ═══════════════════════════════════════════════════════════════ */

const VEHICLE_LABELS: Record<VehicleType, string> = {
  autosnodato: "Autosnodato (18m)",
  "12m": "12 metri",
  "10m": "10 metri",
  pollicino: "Pollicino (6m)",
};

const VEHICLE_COLORS: Record<VehicleType, string> = {
  autosnodato: "#ef4444",
  "12m": "#3b82f6",
  "10m": "#f59e0b",
  pollicino: "#22c55e",
};

const VEHICLE_SHORT: Record<VehicleType, string> = {
  autosnodato: "18m",
  "12m": "12m",
  "10m": "10m",
  pollicino: "6m",
};

const ROUTE_PALETTE = [
  "#3b82f6", "#ef4444", "#22c55e", "#f59e0b", "#8b5cf6",
  "#ec4899", "#06b6d4", "#f97316", "#14b8a6", "#a855f7",
  "#64748b", "#e11d48", "#0ea5e9", "#84cc16", "#d946ef",
  "#fb923c", "#2dd4bf", "#6366f1", "#facc15", "#f43f5e",
  "#10b981", "#7c3aed", "#0284c7", "#65a30d", "#c026d3",
  "#ea580c", "#059669", "#4f46e5", "#ca8a04", "#be185d",
];

const CATEGORY_LABELS: Record<ServiceCategory, string> = {
  urbano: "Urbano",
  extraurbano: "Extraurbano",
};

const CATEGORY_COLORS: Record<ServiceCategory, string> = {
  urbano: "#3b82f6",
  extraurbano: "#f59e0b",
};

const SEV_CONFIG = {
  critical: { icon: AlertCircle, bg: "bg-red-500/10", border: "border-red-500/30", text: "text-red-400", badge: "bg-red-500/20 text-red-400" },
  warning: { icon: AlertTriangle, bg: "bg-amber-500/10", border: "border-amber-500/30", text: "text-amber-400", badge: "bg-amber-500/20 text-amber-400" },
  info: { icon: Info, bg: "bg-blue-500/10", border: "border-blue-500/30", text: "text-blue-400", badge: "bg-blue-500/20 text-blue-400" },
} as const;

function ymdToIso(ymd: string): string {
  return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
}
function ymdToDisplay(ymd: string): string {
  return `${ymd.slice(6, 8)}/${ymd.slice(4, 6)}/${ymd.slice(0, 4)}`;
}

function SummaryCard({ icon, label, value, color, sub }: {
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
 *  TRIP TOOLTIP — popup on hover
 * ═══════════════════════════════════════════════════════════════ */

function TripTooltip({ entry, style }: { entry: ShiftTripEntry; style: React.CSSProperties }) {
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
 *  GANTT COMPONENT
 * ═══════════════════════════════════════════════════════════════ */

function GanttChart({ shifts, routeColorMap }: { shifts: VehicleShift[]; routeColorMap: Map<string, string> }) {
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

/* ═══════════════════════════════════════════════════════════════
 *  PAGE
 * ═══════════════════════════════════════════════════════════════ */

export default function ServiceProgramPage() {
  const [availableDates, setAvailableDates] = useState<{ date: string; services: number }[]>([]);
  const [datesMode, setDatesMode] = useState<"calendar" | "calendar_dates" | null>(null);
  const [dateRange, setDateRange] = useState<{ min: string; max: string } | null>(null);
  const [selectedDate, setSelectedDate] = useState<string>("");
  const [loadingDates, setLoadingDates] = useState(true);

  const [allRoutes, setAllRoutes] = useState<RouteItem[]>([]);
  const [vehicleTypes, setVehicleTypes] = useState<VehicleTypeInfo[]>([]);
  const [loadingRoutes, setLoadingRoutes] = useState(true);
  const [selectedRoutes, setSelectedRoutes] = useState<Map<string, VehicleType>>(new Map());
  const [forcedRoutes, setForcedRoutes] = useState<Set<string>>(new Set());
  const [routeSearch, setRouteSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<ServiceCategory | "all">("all");

  const [result, setResult] = useState<ServiceProgramResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [ganttFilter, setGanttFilter] = useState<ServiceCategory | VehicleType | "all">("all");
  const [expandedShifts, setExpandedShifts] = useState<Set<string>>(new Set());

  // ── Scenario save/load state ──
  const [savedScenarios, setSavedScenarios] = useState<{ id: string; name: string; date: string; createdAt: string }[]>([]);
  const [savingScenario, setSavingScenario] = useState(false);
  const [scenarioName, setScenarioName] = useState("");
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [savedScenarioId, setSavedScenarioId] = useState<string | null>(null);

  const [deletingScenarioId, setDeletingScenarioId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  // ── Solver mode: greedy or CP-SAT ──
  const [solverMode, setSolverMode] = useState<"greedy" | "cpsat">("greedy");
  const [solverMetrics, setSolverMetrics] = useState<any>(null);

  useEffect(() => {
    const base = getApiBase();
    Promise.all([
      fetch(`${base}/api/service-program/dates`).then(r => r.json()).catch(() => null),
      fetch(`${base}/api/service-program/routes`).then(r => r.json()).catch(() => null),
      fetch(`${base}/api/service-program/scenarios`).then(r => r.json()).catch(() => []),
    ]).then(([datesData, routesData, scenariosData]) => {
      if (datesData) {
        if (datesData.mode === "calendar") {
          setDatesMode("calendar");
          setDateRange({ min: ymdToIso(datesData.minDate), max: ymdToIso(datesData.maxDate) });
          const today = new Date().toISOString().slice(0, 10);
          setSelectedDate(today >= ymdToIso(datesData.minDate) && today <= ymdToIso(datesData.maxDate) ? today : ymdToIso(datesData.minDate));
        } else {
          setDatesMode("calendar_dates");
          setAvailableDates(datesData.dates || []);
          const best = (datesData.dates || []).sort((a: any, b: any) => b.services - a.services)[0];
          if (best) setSelectedDate(ymdToIso(best.date));
        }
      }
      if (routesData) {
        setAllRoutes(routesData.routes || []);
        setVehicleTypes(routesData.vehicleTypes || []);
      }
      if (Array.isArray(scenariosData)) setSavedScenarios(scenariosData);
      setLoadingDates(false);
      setLoadingRoutes(false);
    });
  }, []);

  const filteredRoutes = useMemo(() => {
    let list = allRoutes;
    if (categoryFilter !== "all") list = list.filter(r => r.category === categoryFilter);
    if (routeSearch.trim()) {
      const q = routeSearch.toLowerCase();
      list = list.filter(r => r.name.toLowerCase().includes(q) || r.routeId.toLowerCase().includes(q) || (r.longName && r.longName.toLowerCase().includes(q)));
    }
    return list;
  }, [allRoutes, routeSearch, categoryFilter]);

  const urbanCount = useMemo(() => allRoutes.filter(r => r.category === "urbano").length, [allRoutes]);
  const suburbanCount = useMemo(() => allRoutes.filter(r => r.category === "extraurbano").length, [allRoutes]);

  const toggleRoute = (routeId: string) => {
    setSelectedRoutes(prev => { const n = new Map(prev); if (n.has(routeId)) n.delete(routeId); else n.set(routeId, "12m"); return n; });
    setForcedRoutes(prev => { const n = new Set(prev); n.delete(routeId); return n; });
  };
  const setRouteVehicle = (routeId: string, vt: VehicleType) => {
    setSelectedRoutes(prev => { const n = new Map(prev); n.set(routeId, vt); return n; });
  };
  const toggleForced = (routeId: string) => {
    setForcedRoutes(prev => { const n = new Set(prev); if (n.has(routeId)) n.delete(routeId); else n.add(routeId); return n; });
  };
  const selectAllVisible = () => { const n = new Map(selectedRoutes); for (const r of filteredRoutes) if (!n.has(r.routeId)) n.set(r.routeId, "12m"); setSelectedRoutes(n); };
  const deselectAllVisible = () => { const ids = new Set(filteredRoutes.map(r => r.routeId)); setSelectedRoutes(prev => { const n = new Map(prev); for (const id of ids) n.delete(id); return n; }); };
  const selectNone = () => { setSelectedRoutes(new Map()); setForcedRoutes(new Set()); };

  const run = useCallback(async () => {
    if (!selectedDate) { setError("Seleziona una data"); return; }
    if (selectedRoutes.size === 0) { setError("Seleziona almeno una linea"); return; }
    setLoading(true); setError(null); setResult(null); setSavedScenarioId(null); setSolverMetrics(null);
    setGanttFilter("all"); setExpandedShifts(new Set());
    try {
      const endpoint = solverMode === "cpsat" ? "/api/service-program/cpsat" : "/api/service-program";
      const bodyPayload: any = {
        date: selectedDate,
        routes: Array.from(selectedRoutes.entries()).map(([routeId, vehicleType]) => ({
          routeId,
          vehicleType,
          forced: forcedRoutes.has(routeId),
        })),
      };
      if (solverMode === "cpsat") bodyPayload.timeLimit = 60;

      const resp = await fetch(`${getApiBase()}${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bodyPayload),
      });
      if (!resp.ok) { const err = await resp.json().catch(() => ({})); throw new Error(err.error || `Errore ${resp.status}`); }
      const data = await resp.json();
      setResult(data);
      if (data.solverMetrics) setSolverMetrics(data.solverMetrics);
    } catch (e: any) { setError(e.message || "Errore sconosciuto"); } finally { setLoading(false); }
  }, [selectedDate, selectedRoutes, forcedRoutes, solverMode]);

  const saveScenario = useCallback(async () => {
    if (!result || !scenarioName.trim()) return;
    setSavingScenario(true);
    try {
      const input = {
        date: selectedDate,
        routes: Array.from(selectedRoutes.entries()).map(([routeId, vehicleType]) => ({
          routeId, vehicleType, forced: forcedRoutes.has(routeId),
        })),
      };
      const resp = await fetch(`${getApiBase()}/api/service-program/scenarios`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: scenarioName.trim(), date: selectedDate, input, result }),
      });
      if (!resp.ok) throw new Error("Errore nel salvataggio");
      const data = await resp.json();
      setSavedScenarioId(data.id);
      setShowSaveDialog(false);
      setScenarioName("");
      // Refresh list
      const list = await fetch(`${getApiBase()}/api/service-program/scenarios`).then(r => r.json()).catch(() => []);
      if (Array.isArray(list)) setSavedScenarios(list);
    } catch (e: any) { setError(e.message); } finally { setSavingScenario(false); }
  }, [result, scenarioName, selectedDate, selectedRoutes, forcedRoutes]);

  const loadScenario = useCallback(async (id: string) => {
    setLoading(true); setError(null); setSolverMetrics(null);
    setGanttFilter("all"); setExpandedShifts(new Set());
    try {
      const resp = await fetch(`${getApiBase()}/api/service-program/scenarios/${id}`);
      if (!resp.ok) throw new Error("Errore nel caricamento");
      const data = await resp.json();
      const loaded = data.result as ServiceProgramResult | undefined;
      // Defend against legacy scenarios that might have incomplete data
      if (loaded) {
        if (!loaded.hourlyDist) loaded.hourlyDist = [];
        if (!loaded.routeStats) loaded.routeStats = [];
        if (!loaded.advisories) loaded.advisories = [];
        if (!loaded.shifts) loaded.shifts = [];
        if (!loaded.summary) loaded.summary = { date: data.date, activeServices: 0, totalTrips: 0, selectedRoutes: 0, totalVehicles: 0, byType: {}, byCategory: {}, totalServiceHours: 0, totalDeadheadHours: 0, totalDeadheadKm: 0, depotReturns: 0, efficiency: 0 } as any;
        if (!loaded.costs) loaded.costs = {} as any;
        if (!loaded.score) loaded.score = { overall: 0, efficiency: 0, fleetUtilization: 0, deadheadRatio: 0, costEfficiency: 0, fifoCompliance: 0, grade: "?", gradeColor: "#888" };
      }
      setResult(loaded ?? null);
      if (loaded?.solverMetrics) setSolverMetrics(loaded.solverMetrics);
      setSavedScenarioId(data.id);
      setSelectedDate(ymdToIso(data.date));
      // Restore route selections from saved input
      if (data.input?.routes) {
        const m = new Map<string, VehicleType>();
        const f = new Set<string>();
        for (const r of data.input.routes) { m.set(r.routeId, r.vehicleType); if (r.forced) f.add(r.routeId); }
        setSelectedRoutes(m);
        setForcedRoutes(f);
      }
    } catch (e: any) { setError(e.message); } finally { setLoading(false); }
  }, []);

  const deleteScenario = useCallback(async (id: string) => {
    setDeletingScenarioId(id);
    try {
      const resp = await fetch(`${getApiBase()}/api/service-program/scenarios/${id}`, { method: "DELETE" });
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        throw new Error(body.error || `Errore HTTP ${resp.status}`);
      }
      setSavedScenarios(prev => prev.filter(s => s.id !== id));
      setSavedScenarioId(prev => {
        if (prev === id) {
          // Clear result when deleting the active scenario
          setResult(null);
          setSolverMetrics(null);
          return null;
        }
        return prev;
      });
    } catch (e: any) {
      setError(`Impossibile eliminare lo scenario: ${e.message}`);
    } finally {
      setDeletingScenarioId(null);
    }
  }, []);

  const ganttShifts = useMemo(() => {
    if (!result) return [];
    if (ganttFilter === "all") return result.shifts;
    if (ganttFilter === "urbano" || ganttFilter === "extraurbano") return result.shifts.filter(s => s.category === ganttFilter);
    return result.shifts.filter(s => s.vehicleType === ganttFilter);
  }, [result, ganttFilter]);

  const routeColorMap = useMemo(() => {
    const map = new Map<string, string>();
    if (!result) return map;
    const ids = new Set<string>();
    for (const shift of result.shifts) for (const t of shift.trips) if (t.type === "trip") ids.add(t.routeId);
    let i = 0;
    for (const id of ids) { map.set(id, ROUTE_PALETTE[i % ROUTE_PALETTE.length]); i++; }
    return map;
  }, [result]);

  const hourlyChartData = useMemo(() => {
    if (!result?.hourlyDist) return [];
    return result.hourlyDist.map(h => ({ ora: `${h.hour}:00`, corse: h.trips }));
  }, [result]);

  const radarData = useMemo(() => {
    if (!result?.score) return [];
    const s = result.score;
    return [
      { subject: "Efficienza", value: s.efficiency ?? 0 },
      { subject: "Saturazione", value: s.fleetUtilization ?? 0 },
      { subject: "Min. km vuoto", value: Math.max(0, 100 - (s.deadheadRatio ?? 0) * 5) },
      { subject: "Costo", value: s.costEfficiency ?? 0 },
      { subject: "FIFO", value: s.fifoCompliance ?? 0 },
    ];
  }, [result]);

  const toggleShift = (id: string) => {
    setExpandedShifts(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  };

  return (
    <div className="h-[calc(100vh-3.5rem)] md:h-screen overflow-y-auto">
      <div className="max-w-7xl mx-auto p-4 md:p-6 space-y-6">
        {/* Header */}
        <div>
          <h1 className="text-xl font-bold flex items-center gap-2">
            <ClipboardList className="w-5 h-5 text-primary" />
            Programma di Esercizio
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Seleziona le linee, assegna veicoli e genera lo scenario. Il sistema calcola costi, punteggio e consigli di ottimizzazione.
          </p>
        </div>

        {/* ─── STEP 1 + 2 ─── */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <Card className="bg-muted/30 border-border/30">
            <CardContent className="p-4 space-y-2">
              <h3 className="text-sm font-semibold flex items-center gap-1.5"><Calendar className="w-4 h-4 text-primary" /> 1. Seleziona Data</h3>
              {loadingDates ? (
                <div className="flex items-center gap-2 text-xs text-muted-foreground py-2"><Loader2 className="w-3 h-3 animate-spin" /> Caricamento…</div>
              ) : datesMode === "calendar_dates" && availableDates.length > 0 ? (
                <select value={selectedDate} onChange={e => setSelectedDate(e.target.value)} className="w-full bg-background border border-border/50 rounded-md px-3 py-1.5 text-sm">
                  <option value="">— Seleziona —</option>
                  {availableDates.map(d => {
                    const iso = ymdToIso(d.date);
                    const dayName = new Date(iso + "T12:00:00").toLocaleDateString("it-IT", { weekday: "short" });
                    return <option key={d.date} value={iso}>{ymdToDisplay(d.date)} ({dayName}) — {d.services} servizi</option>;
                  })}
                </select>
              ) : (
                <input type="date" value={selectedDate} onChange={e => setSelectedDate(e.target.value)} min={dateRange?.min} max={dateRange?.max} className="w-full bg-background border border-border/50 rounded-md px-3 py-1.5 text-sm" />
              )}
              {selectedDate && <p className="text-xs text-muted-foreground">Data: <strong>{new Date(selectedDate + "T12:00:00").toLocaleDateString("it-IT", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}</strong></p>}
            </CardContent>
          </Card>

          <Card className="bg-muted/30 border-border/30 lg:col-span-2">
            <CardContent className="p-4 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold flex items-center gap-1.5"><Bus className="w-4 h-4 text-primary" /> 2. Seleziona Linee e Tipo Veicolo</h3>
                <div className="flex gap-2">
                  <button onClick={selectAllVisible} className="text-[10px] text-primary hover:underline">Seleziona visibili</button>
                  <button onClick={deselectAllVisible} className="text-[10px] text-muted-foreground hover:underline">Deseleziona visibili</button>
                  <button onClick={selectNone} className="text-[10px] text-red-400 hover:underline">Togli tutte</button>
                </div>
              </div>
              <div className="flex flex-col sm:flex-row gap-2">
                <div className="flex gap-1 shrink-0">
                  {(["all", "urbano", "extraurbano"] as const).map(cat => (
                    <button key={cat} onClick={() => setCategoryFilter(cat)}
                      className={`px-2.5 py-1 text-[11px] rounded-md transition-colors ${categoryFilter === cat ? "bg-primary/20 text-primary font-medium" : "bg-background/50 text-muted-foreground hover:bg-muted/40"}`}>
                      {cat === "all" ? `Tutte (${allRoutes.length})` : cat === "urbano" ? `🏙 Urbane (${urbanCount})` : `🛣 Extra (${suburbanCount})`}
                    </button>
                  ))}
                </div>
                <div className="relative flex-1">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                  <input value={routeSearch} onChange={e => setRouteSearch(e.target.value)} placeholder="Cerca linea…" className="w-full pl-8 pr-3 py-1.5 text-sm bg-background border border-border/50 rounded-md" />
                </div>
                {selectedRoutes.size > 0 && (
                  <div className="flex items-center gap-1.5 shrink-0">
                    <label className="text-[10px] text-muted-foreground whitespace-nowrap">Assegna a tutte:</label>
                    <select defaultValue="" onChange={e => { const vt = e.target.value as VehicleType; if (!vt) return; setSelectedRoutes(prev => { const n = new Map(prev); for (const [id] of n) n.set(id, vt); return n; }); e.target.value = ""; }}
                      className="text-xs bg-background border border-border/50 rounded px-1.5 py-1 cursor-pointer">
                      <option value="">— Tipo veicolo —</option>
                      <option value="autosnodato">Autosnodato</option>
                      <option value="12m">12 metri</option>
                      <option value="10m">10 metri</option>
                      <option value="pollicino">Pollicino</option>
                    </select>
                  </div>
                )}
              </div>
              {loadingRoutes ? (
                <div className="flex items-center gap-2 text-xs text-muted-foreground py-4"><Loader2 className="w-3 h-3 animate-spin" /> Caricamento linee…</div>
              ) : (
                <>
                  <div className="text-[10px] text-muted-foreground">
                    {selectedRoutes.size} di {allRoutes.length} linee selezionate
                    {forcedRoutes.size > 0 && <> · <span className="text-amber-400"><Lock className="w-2.5 h-2.5 inline" /> {forcedRoutes.size} forzate</span></>}
                    <span className="ml-2 text-muted-foreground/50">🔒 = solo quel mezzo · 🔓 = flessibile (±1 taglia)</span>
                  </div>
                  <div className="max-h-[300px] overflow-y-auto space-y-1 pr-1">
                    {filteredRoutes.map(route => {
                      const isSelected = selectedRoutes.has(route.routeId);
                      const vt = selectedRoutes.get(route.routeId) || "12m";
                      const isForced = forcedRoutes.has(route.routeId);
                      return (
                        <div key={route.routeId} className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors cursor-pointer ${isSelected ? "bg-primary/10 border border-primary/20" : "bg-background/50 border border-transparent hover:bg-muted/40"}`}>
                          <button onClick={() => toggleRoute(route.routeId)} className="shrink-0">{isSelected ? <CheckSquare className="w-4 h-4 text-primary" /> : <Square className="w-4 h-4 text-muted-foreground" />}</button>
                          <div className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: route.color || "#6b7280" }} />
                          <span className="font-medium min-w-[40px]">{route.name}</span>
                          <span className="text-[9px] px-1.5 py-0.5 rounded shrink-0" style={{ backgroundColor: route.category === "urbano" ? "rgba(59,130,246,0.15)" : "rgba(245,158,11,0.15)", color: CATEGORY_COLORS[route.category] }}>{route.category === "urbano" ? "URB" : "EXT"}</span>
                          <span className="text-xs text-muted-foreground truncate flex-1">{route.longName || ""}</span>
                          <span className="text-[10px] text-muted-foreground shrink-0">{route.tripsCount} corse</span>
                          {isSelected && (
                            <>
                              <select value={vt} onChange={e => { e.stopPropagation(); setRouteVehicle(route.routeId, e.target.value as VehicleType); }} onClick={e => e.stopPropagation()} className="ml-1 text-xs bg-background border border-border/50 rounded px-1.5 py-0.5 shrink-0">
                                <option value="autosnodato">Autosnodato</option>
                                <option value="12m">12 metri</option>
                                <option value="10m">10 metri</option>
                                <option value="pollicino">Pollicino</option>
                              </select>
                              <button
                                onClick={e => { e.stopPropagation(); toggleForced(route.routeId); }}
                                title={isForced ? "Forzato: solo questo tipo di mezzo" : "Flessibile: può usare mezzi più piccoli"}
                                className={`shrink-0 p-1 rounded transition-colors ${isForced ? "bg-amber-500/20 text-amber-400 hover:bg-amber-500/30" : "text-muted-foreground/40 hover:text-muted-foreground hover:bg-muted/30"}`}
                              >
                                {isForced ? <Lock className="w-3.5 h-3.5" /> : <Unlock className="w-3.5 h-3.5" />}
                              </button>
                            </>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Run button + Save + Saved scenarios */}
        <div className="flex flex-wrap items-center gap-3">
          {/* Solver mode toggle */}
          <div className="flex items-center gap-2 bg-card/60 border border-border/40 rounded-lg px-3 py-1.5">
            <button onClick={() => setSolverMode("greedy")}
              className={`px-3 py-1 rounded text-xs font-medium transition-colors ${solverMode === "greedy" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>
              Greedy
            </button>
            <button onClick={() => setSolverMode("cpsat")}
              className={`px-3 py-1 rounded text-xs font-medium transition-colors ${solverMode === "cpsat" ? "bg-purple-600 text-white" : "text-muted-foreground hover:text-foreground"}`}>
              🧠 CP-SAT
            </button>
          </div>

          <button onClick={run} disabled={loading || !selectedDate || selectedRoutes.size === 0}
            className="flex items-center gap-2 bg-primary text-primary-foreground py-2.5 px-6 rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50">
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
            {loading ? (solverMode === "cpsat" ? "CP-SAT Solving…" : "Elaborazione…") : "Genera Scenario"}
          </button>
          {result && !loading && (
            <>
              <button onClick={run} disabled={loading || !selectedDate || selectedRoutes.size === 0}
                className="flex items-center gap-2 bg-amber-500/20 text-amber-400 border border-amber-500/30 py-2.5 px-5 rounded-lg text-sm font-medium hover:bg-amber-500/30 transition-colors disabled:opacity-50">
                <RefreshCw className="w-4 h-4" />
                Ri-ottimizza
              </button>
              <button onClick={() => { setScenarioName(`Scenario ${new Date().toLocaleDateString("it-IT")}`); setShowSaveDialog(true); }}
                className="flex items-center gap-2 bg-green-500/20 text-green-400 border border-green-500/30 py-2.5 px-5 rounded-lg text-sm font-medium hover:bg-green-500/30 transition-colors">
                <Save className="w-4 h-4" />
                Salva Scenario
              </button>
              {savedScenarioId && (
                <a href={`/driver-shifts/${savedScenarioId}`}
                  className="flex items-center gap-2 bg-purple-500/20 text-purple-400 border border-purple-500/30 py-2.5 px-5 rounded-lg text-sm font-medium hover:bg-purple-500/30 transition-colors">
                  <Users className="w-4 h-4" />
                  Genera Turni Guida
                </a>
              )}
            </>
          )}
          {selectedRoutes.size > 0 && <span className="text-xs text-muted-foreground">{selectedRoutes.size} linee selezionate</span>}
        </div>

        {/* Save dialog */}
        {showSaveDialog && (
          <Card className="bg-muted/30 border-green-500/30">
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <Save className="w-4 h-4 text-green-400 shrink-0" />
                <input value={scenarioName} onChange={e => setScenarioName(e.target.value)} placeholder="Nome scenario…"
                  className="flex-1 bg-background border border-border/50 rounded-md px-3 py-1.5 text-sm" autoFocus
                  onKeyDown={e => { if (e.key === "Enter") saveScenario(); if (e.key === "Escape") setShowSaveDialog(false); }} />
                <button onClick={saveScenario} disabled={savingScenario || !scenarioName.trim()}
                  className="flex items-center gap-1.5 bg-green-500/20 text-green-400 border border-green-500/30 px-4 py-1.5 rounded-md text-sm font-medium hover:bg-green-500/30 disabled:opacity-50">
                  {savingScenario ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />} Salva
                </button>
                <button onClick={() => setShowSaveDialog(false)} className="text-muted-foreground hover:text-foreground p-1">
                  <X className="w-4 h-4" />
                </button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Saved scenarios list */}
        {savedScenarios.length > 0 && (
          <Card className="bg-muted/30 border-border/30">
            <CardContent className="p-4">
              <h3 className="text-sm font-semibold flex items-center gap-1.5 mb-3"><FolderOpen className="w-4 h-4 text-primary" /> Scenari Salvati ({savedScenarios.length})</h3>
              <div className="space-y-1.5">
                {savedScenarios.map(sc => (
                  <div key={sc.id}
                    className={`relative flex items-center gap-3 rounded-lg px-3 py-2.5 text-xs border transition-colors cursor-pointer ${savedScenarioId === sc.id ? "bg-primary/10 border-primary/30" : "bg-background/50 border-border/30 hover:bg-muted/30"}`}
                    onClick={() => loadScenario(sc.id)}
                  >
                    <FolderOpen className="w-3.5 h-3.5 shrink-0" />
                    <span className="font-medium truncate">{sc.name}</span>
                    <span className="text-muted-foreground shrink-0">{ymdToDisplay(sc.date)}</span>
                    <div className="flex items-center gap-1.5 shrink-0 ml-auto relative z-10">
                      <button type="button" onClick={(e) => { e.stopPropagation(); window.location.href = `/driver-shifts/${sc.id}`; }}
                        title="Genera turni guida" className="text-purple-400 hover:text-purple-300 hover:bg-purple-500/10 transition-colors p-2 rounded">
                        <Users className="w-4 h-4" />
                      </button>
                      <button type="button"
                        disabled={deletingScenarioId === sc.id}
                        onClick={(e) => {
                          e.stopPropagation();
                          setConfirmDeleteId(sc.id);
                        }}
                        className="text-red-400/60 hover:text-red-400 hover:bg-red-500/10 transition-colors p-2 rounded disabled:opacity-40"
                        title="Elimina scenario"
                      >
                        {deletingScenarioId === sc.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* ── Delete confirmation dialog ── */}
        {confirmDeleteId && (() => {
          const sc = savedScenarios.find(s => s.id === confirmDeleteId);
          return (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
              onClick={() => setConfirmDeleteId(null)}>
              <div className="bg-card border border-border rounded-xl shadow-2xl p-6 max-w-sm mx-4 space-y-4"
                onClick={(e) => e.stopPropagation()}>
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-red-500/15 flex items-center justify-center">
                    <Trash2 className="w-5 h-5 text-red-400" />
                  </div>
                  <div>
                    <h3 className="font-semibold text-sm">Eliminare scenario?</h3>
                    <p className="text-xs text-muted-foreground mt-0.5">"{sc?.name}"</p>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">Questa azione è irreversibile. Lo scenario e tutti i turni guida associati verranno eliminati.</p>
                <div className="flex justify-end gap-2">
                  <button onClick={() => setConfirmDeleteId(null)}
                    className="px-4 py-2 text-xs rounded-lg border border-border hover:bg-muted transition-colors">
                    Annulla
                  </button>
                  <button
                    disabled={!!deletingScenarioId}
                    onClick={() => { deleteScenario(confirmDeleteId); setConfirmDeleteId(null); }}
                    className="px-4 py-2 text-xs rounded-lg bg-red-500/20 text-red-400 border border-red-500/30 hover:bg-red-500/30 transition-colors disabled:opacity-50 flex items-center gap-1.5">
                    {deletingScenarioId ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
                    Elimina
                  </button>
                </div>
              </div>
            </div>
          );
        })()}

        {error && (
          <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3 text-sm text-red-400">
            <AlertTriangle className="w-4 h-4 inline mr-1" /> {error}
          </div>
        )}

        {/* ═══════════════════════ RESULTS ═══════════════════════ */}
        {result && (
          <AnimatePresence>
            <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">

              {/* ──── SCORE + COST HERO ──── */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {/* Score card with grade */}
                <Card className="bg-muted/30 border-border/30 overflow-hidden">
                  <CardContent className="p-5">
                    <div className="flex items-start justify-between mb-4">
                      <div>
                        <h3 className="text-sm font-semibold flex items-center gap-1.5"><Award className="w-4 h-4 text-primary" /> Punteggio Scenario</h3>
                        <p className="text-[10px] text-muted-foreground mt-0.5">Valutazione complessiva qualità del programma</p>
                      </div>
                      <div className="text-center">
                        <div className="text-4xl font-black" style={{ color: result.score?.gradeColor ?? "#888" }}>{result.score?.grade ?? "?"}</div>
                        <div className="text-lg font-bold text-muted-foreground">{result.score?.overall ?? 0}<span className="text-xs">/100</span></div>
                      </div>
                    </div>
                    {/* Radar chart */}
                    <div className="h-[200px] -mx-4">
                      <ResponsiveContainer width="100%" height="100%">
                        <RadarChart data={radarData} cx="50%" cy="50%" outerRadius="70%">
                          <PolarGrid stroke="hsl(var(--border))" opacity={0.3} />
                          <PolarAngleAxis dataKey="subject" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
                          <Radar dataKey="value" stroke="#3b82f6" fill="#3b82f6" fillOpacity={0.15} strokeWidth={2} />
                        </RadarChart>
                      </ResponsiveContainer>
                    </div>
                    {/* Score breakdown */}
                    <div className="grid grid-cols-5 gap-2 mt-2">
                      {[
                        { label: "Efficienza", val: result.score?.efficiency ?? 0 },
                        { label: "Saturaz.", val: result.score?.fleetUtilization ?? 0 },
                        { label: "Km vuoto", val: Math.max(0, +(100 - (result.score?.deadheadRatio ?? 0) * 5).toFixed(0)) },
                        { label: "Costo", val: result.score?.costEfficiency ?? 0 },
                        { label: "FIFO", val: result.score?.fifoCompliance ?? 0 },
                      ].map(s => (
                        <div key={s.label} className="text-center">
                          <div className="text-xs font-medium" style={{ color: s.val >= 70 ? "#22c55e" : s.val >= 40 ? "#f59e0b" : "#ef4444" }}>{s.val}%</div>
                          <div className="text-[9px] text-muted-foreground">{s.label}</div>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>

                {/* Cost card */}
                <Card className="bg-muted/30 border-border/30">
                  <CardContent className="p-5">
                    <h3 className="text-sm font-semibold flex items-center gap-1.5 mb-4"><Euro className="w-4 h-4 text-primary" /> Analisi Costi Giornalieri</h3>
                    <div className="text-3xl font-black text-primary mb-1">€{(result.costs.totalDailyCost ?? 0).toLocaleString()}<span className="text-sm font-normal text-muted-foreground">/giorno</span></div>
                    <div className="flex gap-4 text-xs text-muted-foreground mb-4">
                      <span>€{result.costs.costPerTrip ?? 0}/corsa</span>
                      <span>€{result.costs.costPerServiceHour ?? 0}/ora servizio</span>
                    </div>
                    {/* Cost bars */}
                    <div className="space-y-2">
                      {/* Vehicle subtotal group */}
                      <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Veicolo — €{(result.costs.vehicleTotalCost ?? 0).toLocaleString()}</div>
                      {[
                        { label: "Fisso giornaliero (assic./manut.)", value: result.costs.vehicleFixedCost ?? 0, color: "#3b82f6", icon: <Truck className="w-3 h-3" /> },
                        { label: "Km servizio (carb./gomme/usura)", value: result.costs.vehicleServiceKmCost ?? 0, color: "#06b6d4", icon: <Navigation className="w-3 h-3" /> },
                        { label: "Km a vuoto (carb./gomme/usura)", value: result.costs.vehicleDeadheadKmCost ?? 0, color: "#ef4444", icon: <MapPin className="w-3 h-3" /> },
                      ].map(item => {
                        const pct = (result.costs.totalDailyCost ?? 0) > 0 ? (item.value / (result.costs.totalDailyCost ?? 1)) * 100 : 0;
                        return (
                          <div key={item.label}>
                            <div className="flex items-center justify-between text-[11px] mb-0.5">
                              <span className="flex items-center gap-1 text-muted-foreground">{item.icon} {item.label}</span>
                              <span className="font-medium">€{item.value.toLocaleString()} <span className="text-muted-foreground">({pct.toFixed(0)}%)</span></span>
                            </div>
                            <div className="h-1.5 bg-muted/30 rounded-full overflow-hidden">
                              <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, backgroundColor: item.color }} />
                            </div>
                          </div>
                        );
                      })}
                      {/* Other costs */}
                      <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mt-3">Altro</div>
                      {[
                        { label: "Autisti (ore guida)", value: result.costs.driverCost ?? 0, color: "#22c55e", icon: <Clock className="w-3 h-3" /> },
                        { label: "Tempo inattivo", value: result.costs.idleCost ?? 0, color: "#f59e0b", icon: <Timer className="w-3 h-3" /> },
                        { label: "Rientri deposito", value: result.costs.depotReturnCost ?? 0, color: "#8b5cf6", icon: <Home className="w-3 h-3" /> },
                      ].map(item => {
                        const pct = (result.costs.totalDailyCost ?? 0) > 0 ? (item.value / (result.costs.totalDailyCost ?? 1)) * 100 : 0;
                        return (
                          <div key={item.label}>
                            <div className="flex items-center justify-between text-[11px] mb-0.5">
                              <span className="flex items-center gap-1 text-muted-foreground">{item.icon} {item.label}</span>
                              <span className="font-medium">€{item.value.toLocaleString()} <span className="text-muted-foreground">({pct.toFixed(0)}%)</span></span>
                            </div>
                            <div className="h-1.5 bg-muted/30 rounded-full overflow-hidden">
                              <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, backgroundColor: item.color }} />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    {/* By vehicle type */}
                    <div className="mt-4 pt-3 border-t border-border/20">
                      <div className="text-[10px] text-muted-foreground mb-2">Per tipo veicolo:</div>
                      <div className="flex flex-wrap gap-2">
                        {Object.entries(result.costs.byVehicleType ?? {}).map(([vt, data]) => (
                          <div key={vt} className="bg-background/50 rounded px-2 py-1 text-[10px]">
                            <span className="inline-block w-2 h-2 rounded-full mr-1" style={{ backgroundColor: VEHICLE_COLORS[vt as VehicleType] }} />
                            <span className="font-medium">{data.count}×</span> {VEHICLE_LABELS[vt as VehicleType] || vt}:
                            <span className="text-muted-foreground ml-1">€{data.totalVehicleCost.toLocaleString()}</span>
                            <span className="text-muted-foreground/60 ml-1">({data.serviceKm.toFixed(0)}km srv + {data.deadheadKm.toFixed(0)}km vuoto)</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </div>

              {/* ──── ADVISORIES / CONSIGLI ──── */}
              {result.advisories.length > 0 && (
                <Card className="bg-muted/30 border-border/30">
                  <CardContent className="p-5">
                    <h3 className="text-sm font-semibold flex items-center gap-1.5 mb-3">
                      <Lightbulb className="w-4 h-4 text-primary" /> Consigli di Ottimizzazione
                      <Badge variant="outline" className="ml-2 text-[10px]">{result.advisories.length}</Badge>
                    </h3>
                    <div className="space-y-2">
                      {result.advisories.map(adv => {
                        const sev = SEV_CONFIG[adv.severity];
                        const Icon = sev.icon;
                        return (
                          <div key={adv.id} className={`${sev.bg} border ${sev.border} rounded-lg p-3`}>
                            <div className="flex items-start gap-2">
                              <Icon className={`w-4 h-4 ${sev.text} shrink-0 mt-0.5`} />
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 mb-1">
                                  <span className={`text-sm font-medium ${sev.text}`}>{adv.title}</span>
                                  <span className={`text-[9px] px-1.5 py-0.5 rounded ${sev.badge}`}>
                                    {adv.severity === "critical" ? "CRITICO" : adv.severity === "warning" ? "ATTENZIONE" : "INFO"}
                                  </span>
                                  <span className="text-[9px] px-1.5 py-0.5 rounded bg-muted/30 text-muted-foreground">
                                    {adv.category === "fleet" ? "🚌 Flotta" : adv.category === "deadhead" ? "📍 Km vuoto" : adv.category === "schedule" ? "📅 Orario" : adv.category === "cost" ? "💰 Costi" : "⛽ Rifornimento"}
                                  </span>
                                </div>
                                <p className="text-xs text-muted-foreground mb-1.5">{adv.description}</p>
                                <div className="flex items-center gap-1 text-xs mb-1">
                                  <TrendingUp className="w-3 h-3 text-green-400" />
                                  <span className="text-green-400 font-medium">{adv.impact}</span>
                                </div>
                                <div className="flex items-center gap-1 text-xs">
                                  <Zap className="w-3 h-3 text-amber-400" />
                                  <span className="text-muted-foreground">{adv.action}</span>
                                </div>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </CardContent>
                </Card>
              )}

              {/* ──── SOLVER BADGE ──── */}
              {result.solver && (
                <div className="flex items-center gap-2 mb-2">
                  <Badge variant={result.solver === "cpsat" ? "default" : "secondary"}
                    className={result.solver === "cpsat" ? "bg-purple-600 text-white" : ""}>
                    {result.solver === "cpsat" ? "🧠 CP-SAT" : "⚡ Greedy"}
                  </Badge>
                  {solverMetrics && (
                    <>
                      <span className="text-xs text-muted-foreground">
                        Tempo: {solverMetrics.totalSolveTimeSec ?? solverMetrics.solveTimeSec ?? "?"}s
                      </span>
                      {solverMetrics.byCategory && Object.entries(solverMetrics.byCategory).map(([cat, m]: [string, any]) => (
                        <Badge key={cat} variant="outline" className="text-xs">
                          {cat}: {m.status}
                        </Badge>
                      ))}
                    </>
                  )}
                </div>
              )}

              {/* ──── SUMMARY CARDS ──── */}
              <div className="flex flex-wrap gap-3">
                <SummaryCard icon={<Calendar className="w-4 h-4" />} label="Data" value={result.summary.date ? ymdToDisplay(result.summary.date) : "—"} />
                <SummaryCard icon={<Bus className="w-4 h-4" />} label="Corse" value={result.summary.totalTrips.toLocaleString()} sub={`${result.summary.selectedRoutes} linee`} />
                <SummaryCard icon={<Truck className="w-4 h-4" />} label="Veicoli" value={result.summary.totalVehicles.toString()} color="#3b82f6" sub={`${result.summary.byCategory?.urbano || 0} urb · ${result.summary.byCategory?.extraurbano || 0} ext`} />
                <SummaryCard icon={<Clock className="w-4 h-4" />} label="Ore servizio" value={`${result.summary.totalServiceHours}h`} sub={`+ ${result.summary.totalDeadheadHours}h vuoto`} />
                <SummaryCard icon={<MapPin className="w-4 h-4" />} label="Km vuoto" value={`${result.summary.totalDeadheadKm ?? 0}`} color="#ef4444" sub={`€${result.costs.vehicleDeadheadKmCost ?? 0}/giorno`} />
                <SummaryCard icon={<Home className="w-4 h-4" />} label="Rientri deposito" value={result.summary.depotReturns.toString()} sub="gap > 60 min" />
                <SummaryCard icon={<Fuel className="w-4 h-4" />} label="FIFO Rifornimento" value={`${result.score?.fifoCompliance ?? 0}%`} color={(result.score?.fifoCompliance ?? 0) >= 70 ? "#22c55e" : "#f59e0b"} sub="First-Out First-In" />
                {(result.summary.downsizedTrips ?? 0) > 0 && (
                  <SummaryCard icon={<TrendingUp className="w-4 h-4" />} label="Mezzo ridotto" value={`${result.summary.downsizedTrips}`} color="#f59e0b" sub={`su ${result.summary.totalTrips} corse`} />
                )}
              </div>

              {/* ──── FLEET + FIFO ──── */}
              <Card className="bg-muted/30 border-border/30">
                <CardContent className="p-4">
                  <h3 className="text-sm font-semibold mb-3 flex items-center gap-1.5"><Truck className="w-4 h-4 text-primary" /> Composizione Flotta &amp; Rotazione FIFO</h3>
                  <div className="flex flex-wrap gap-4 mb-3">
                    {(Object.entries(result.summary.byType ?? {}) as [VehicleType, number][]).sort(([, a], [, b]) => b - a).map(([vt, count]) => (
                      <div key={vt} className="flex items-center gap-2 bg-background/50 rounded-lg px-3 py-2">
                        <span className="w-3 h-3 rounded-full" style={{ backgroundColor: VEHICLE_COLORS[vt] }} />
                        <span className="text-sm font-medium">{count}</span>
                        <span className="text-xs text-muted-foreground">{VEHICLE_LABELS[vt] || vt}</span>
                      </div>
                    ))}
                    <div className="border-l border-border/30 pl-4 flex gap-3">
                      {(Object.entries(result.summary.byCategory || {}) as [string, number][]).map(([cat, count]) => (
                        <div key={cat} className="flex items-center gap-2">
                          <span className="w-2 h-2 rounded-full" style={{ backgroundColor: CATEGORY_COLORS[cat as ServiceCategory] }} />
                          <span className="text-xs text-muted-foreground">{count} {CATEGORY_LABELS[cat as ServiceCategory]}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="text-[10px] text-muted-foreground mb-2 flex items-center gap-1">
                    <Fuel className="w-3 h-3" /> Ordine rifornimento FIFO — i veicoli che escono prima rientrano prima per il rifornimento
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {[...result.shifts].sort((a, b) => a.fifoOrder - b.fifoOrder).slice(0, 20).map(shift => (
                      <div key={shift.vehicleId} className="flex items-center gap-1 bg-background/50 rounded px-1.5 py-0.5 text-[9px]">
                        <span className="font-mono font-medium">{shift.fifoOrder}.</span>
                        <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ backgroundColor: CATEGORY_COLORS[shift.category] }} />
                        <span>{shift.vehicleId}</span>
                        <span className="text-muted-foreground">{minToTime(shift.firstOut)}→{minToTime(shift.lastIn)}</span>
                      </div>
                    ))}
                    {result.shifts.length > 20 && <span className="text-[9px] text-muted-foreground self-center">… +{result.shifts.length - 20}</span>}
                  </div>
                </CardContent>
              </Card>

              {/* ──── GANTT ──── */}
              <Card className="bg-muted/30 border-border/30">
                <CardContent className="p-4">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-sm font-semibold flex items-center gap-1.5"><Timer className="w-4 h-4 text-primary" /> Diagramma Turni Veicoli</h3>
                    <div className="flex items-center gap-2">
                      <Filter className="w-3 h-3 text-muted-foreground" />
                      <select value={ganttFilter} onChange={e => setGanttFilter(e.target.value as any)} className="text-xs bg-background border border-border/50 rounded px-2 py-1">
                        <option value="all">Tutti ({result.shifts.length})</option>
                        <option value="urbano">🏙 Urbani ({result.summary.byCategory?.urbano || 0})</option>
                        <option value="extraurbano">🛣 Extraurbani ({result.summary.byCategory?.extraurbano || 0})</option>
                        {(Object.entries(result.summary.byType) as [VehicleType, number][]).map(([vt, count]) => (
                          <option key={vt} value={vt}>{VEHICLE_LABELS[vt] || vt} ({count})</option>
                        ))}
                      </select>
                    </div>
                  </div>
                  {ganttShifts.length > 0 ? (
                    <>
                      <GanttChart shifts={ganttShifts} routeColorMap={routeColorMap} />
                      <div className="flex flex-wrap gap-x-4 gap-y-1 mt-3 pt-3 border-t border-border/20">
                        {Array.from(routeColorMap.entries()).map(([routeId, color]) => {
                          const routeName = result!.routeStats.find(rs => rs.routeId === routeId)?.routeName || routeId;
                          return <div key={routeId} className="flex items-center gap-1.5"><span className="w-3 h-2 rounded-sm" style={{ backgroundColor: color }} /><span className="text-[10px] text-muted-foreground">{routeName}</span></div>;
                        })}
                        <div className="flex items-center gap-1.5 ml-2">
                          <span className="w-3 h-2 rounded-sm" style={{ backgroundColor: "rgba(255,255,255,0.12)", backgroundImage: "repeating-linear-gradient(90deg, transparent, transparent 2px, rgba(255,255,255,0.3) 2px, rgba(255,255,255,0.3) 4px)" }} />
                          <span className="text-[10px] text-muted-foreground">Vuoto</span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <span className="w-3 h-2 rounded-sm border border-dashed border-white/20 bg-white/5" />
                          <span className="text-[10px] text-muted-foreground">Deposito</span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <span className="w-3 h-2 rounded-sm border-[1.5px] border-dashed" style={{ borderColor: "#f59e0b", backgroundColor: "rgba(245,158,11,0.15)" }} />
                          <span className="text-[10px] text-muted-foreground">Mezzo ridotto</span>
                        </div>
                      </div>
                    </>
                  ) : (
                    <p className="text-sm text-muted-foreground py-4 text-center">Nessun turno per il filtro selezionato</p>
                  )}
                </CardContent>
              </Card>

              {/* ──── ROUTE STATS ──── */}
              <Card className="bg-muted/30 border-border/30">
                <CardContent className="p-4">
                  <h3 className="text-sm font-semibold mb-3 flex items-center gap-1.5"><Bus className="w-4 h-4 text-primary" /> Dettaglio per Linea</h3>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-border/30 text-muted-foreground">
                          <th className="text-left py-2 px-2">Linea</th>
                          <th className="text-left py-2 px-2">Tipo</th>
                          <th className="text-left py-2 px-2">Veicolo</th>
                          <th className="text-right py-2 px-2">Corse</th>
                          <th className="text-right py-2 px-2">Veicoli</th>
                          <th className="text-right py-2 px-2">Prima</th>
                          <th className="text-right py-2 px-2">Ultima</th>
                        </tr>
                      </thead>
                      <tbody>
                        {result.routeStats.map(rs => (
                          <tr key={rs.routeId} className="border-b border-border/10 hover:bg-muted/20">
                            <td className="py-1.5 px-2 font-medium">{rs.routeName}</td>
                            <td className="py-1.5 px-2"><span className="text-[9px] px-1.5 py-0.5 rounded" style={{ backgroundColor: rs.category === "urbano" ? "rgba(59,130,246,0.15)" : "rgba(245,158,11,0.15)", color: CATEGORY_COLORS[rs.category as ServiceCategory] }}>{rs.category === "urbano" ? "URB" : "EXT"}</span></td>
                            <td className="py-1.5 px-2"><Badge variant="outline" className="text-[10px]" style={{ borderColor: VEHICLE_COLORS[rs.vehicleType as VehicleType] || "#6b7280", color: VEHICLE_COLORS[rs.vehicleType as VehicleType] || "#6b7280" }}>{VEHICLE_LABELS[rs.vehicleType as VehicleType] || rs.vehicleType}</Badge></td>
                            <td className="py-1.5 px-2 text-right">{rs.tripsCount}</td>
                            <td className="py-1.5 px-2 text-right font-medium">{rs.vehiclesNeeded}</td>
                            <td className="py-1.5 px-2 text-right text-muted-foreground">{rs.firstDeparture?.slice(0, 5)}</td>
                            <td className="py-1.5 px-2 text-right text-muted-foreground">{rs.lastArrival?.slice(0, 5)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </CardContent>
              </Card>

              {/* ──── VEHICLE SHIFTS ──── */}
              <Card className="bg-muted/30 border-border/30">
                <CardContent className="p-4">
                  <h3 className="text-sm font-semibold mb-3 flex items-center gap-1.5"><ClipboardList className="w-4 h-4 text-primary" /> Turni Veicoli ({result.shifts.length})</h3>
                  <div className="space-y-1">
                    {result.shifts.map(shift => {
                      const isExpanded = expandedShifts.has(shift.vehicleId);
                      return (
                        <div key={shift.vehicleId} className="bg-background/50 rounded-lg overflow-hidden">
                          <button onClick={() => toggleShift(shift.vehicleId)} className="w-full flex items-center gap-3 px-3 py-2 text-sm hover:bg-muted/30 transition-colors">
                            <span className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: CATEGORY_COLORS[shift.category] }} />
                            <span className="font-mono font-medium text-xs">{shift.vehicleId}</span>
                            <Badge variant="outline" className="text-[10px]" style={{ borderColor: VEHICLE_COLORS[shift.vehicleType], color: VEHICLE_COLORS[shift.vehicleType] }}>{VEHICLE_SHORT[shift.vehicleType]}</Badge>
                            <span className="text-[9px] px-1 py-0.5 rounded" style={{ backgroundColor: shift.category === "urbano" ? "rgba(59,130,246,0.15)" : "rgba(245,158,11,0.15)", color: CATEGORY_COLORS[shift.category] }}>{shift.category === "urbano" ? "URB" : "EXT"}</span>
                            <span className="text-[9px] text-muted-foreground/60">FIFO #{shift.fifoOrder}</span>
                            <span className="text-xs text-muted-foreground">
                              {shift.trips.find(t => t.type === "trip")?.departureTime.slice(0, 5)} → {[...shift.trips].reverse().find(t => t.type === "trip")?.arrivalTime.slice(0, 5)}
                            </span>
                            <span className="text-xs text-muted-foreground ml-auto">
                              {shift.tripCount} corse
                              {shift.depotReturns > 0 && <> · {shift.depotReturns}🏠</>}
                              {shift.totalDeadheadKm > 0 && <> · {shift.totalDeadheadKm.toFixed(0)}km vuoto</>}
                              {shift.downsizedTrips > 0 && <> · <span className="text-amber-400">{shift.downsizedTrips}↓</span></>}
                            </span>
                            {isExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                          </button>
                          <AnimatePresence>
                            {isExpanded && (
                              <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="px-3 pb-2">
                                <div className="space-y-1">
                                  {shift.trips.map((entry, i) => {
                                    if (entry.type === "depot") return (
                                      <div key={i} className="flex items-center gap-2 text-xs bg-amber-500/5 border border-amber-500/10 rounded px-2 py-1">
                                        <Home className="w-3 h-3 text-amber-500 shrink-0" />
                                        <span className="text-amber-400 font-medium">{entry.departureTime.slice(0, 5)} → {entry.arrivalTime.slice(0, 5)}</span>
                                        <span className="text-amber-400/70">Rientro deposito</span>
                                      </div>
                                    );
                                    if (entry.type === "deadhead") return (
                                      <div key={i} className="flex items-center gap-2 text-xs bg-muted/10 border border-border/10 rounded px-2 py-1">
                                        <MapPin className="w-3 h-3 text-muted-foreground shrink-0" />
                                        <span className="text-muted-foreground">{entry.departureTime.slice(0, 5)} → {entry.arrivalTime.slice(0, 5)}</span>
                                        <span className="text-muted-foreground/70">↝ Vuoto {entry.deadheadKm} km ({entry.deadheadMin} min)</span>
                                      </div>
                                    );
                                    return (
                                      <div key={i} className={`flex items-center gap-2 text-xs rounded px-2 py-1 ${entry.downsized ? "bg-amber-500/5 border border-amber-500/10" : "bg-muted/20"}`}>
                                        <span className="font-medium text-primary min-w-[50px]">{entry.departureTime.slice(0, 5)}</span>
                                        <ArrowRight className="w-3 h-3 text-muted-foreground shrink-0" />
                                        <span className="text-muted-foreground min-w-[50px]">{entry.arrivalTime.slice(0, 5)}</span>
                                        <Badge variant="secondary" className="text-[10px]">{entry.routeName}</Badge>
                                        {entry.downsized && <span className="text-[9px] px-1 py-0.5 rounded bg-amber-500/15 text-amber-400">↓ ridotto</span>}
                                        {entry.headsign && <span className="text-muted-foreground truncate">→ {entry.headsign}</span>}
                                        <code className="ml-auto text-[9px] text-muted-foreground font-mono">{entry.tripId}</code>
                                      </div>
                                    );
                                  })}
                                </div>
                              </motion.div>
                            )}
                          </AnimatePresence>
                        </div>
                      );
                    })}
                  </div>
                </CardContent>
              </Card>

              {/* ──── HOURLY CHART ──── */}
              {hourlyChartData.length > 0 && (
                <Card className="bg-muted/30 border-border/30">
                  <CardContent className="p-4">
                    <h3 className="text-sm font-semibold mb-3 flex items-center gap-1.5"><BarChart3 className="w-4 h-4 text-primary" /> Distribuzione Oraria Corse</h3>
                    <ResponsiveContainer width="100%" height={200}>
                      <BarChart data={hourlyChartData}>
                        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.3} />
                        <XAxis dataKey="ora" tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
                        <YAxis tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
                        <ReTooltip contentStyle={{ backgroundColor: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 12 }} />
                        <Bar dataKey="corse" name="Corse" fill="#3b82f6" radius={[3, 3, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </CardContent>
                </Card>
              )}
            </motion.div>
          </AnimatePresence>
        )}
      </div>
    </div>
  );
}

function minToTime(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
