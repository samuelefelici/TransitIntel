import React, { useState, useMemo, useCallback, useRef, useEffect } from "react";
import Map, { Source, Layer, Marker, Popup, MapRef } from "react-map-gl/mapbox";
import { motion, AnimatePresence } from "framer-motion";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip as ReTooltip, ResponsiveContainer, CartesianGrid, Cell,
  PieChart, Pie,
} from "recharts";
import {
  TrainFront, Ship, Loader2, ChevronDown, ChevronUp, AlertTriangle,
  CheckCircle2, Clock, ArrowRight, Lightbulb, Timer, PlusCircle,
  ArrowRightLeft, MapPin, Building2, Sun, Moon, Satellite, Route,
  Info, BarChart3, Footprints, XCircle, AlertCircle, MapPinned,
  Navigation, CircleDot, Target, Users, TrendingDown,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { getApiBase } from "@/lib/api";

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN || "";

// ─── Types (matching new backend) ────────────────────────────
interface NearbyStop {
  stopId: string; stopName: string; lat: number; lng: number;
  distKm: number; walkMin: number;
}

interface BusLine {
  routeId: string; routeShortName: string; routeLongName: string;
  routeColor: string | null; tripsCount: number; times: string[];
  destinations: string[];
}

interface ArrivalConnection {
  origin: string;
  arrivalTime: string;
  walkMin: number;
  atBusStopTime: string;
  firstBus: {
    departureTime: string; routeShortName: string; routeLongName: string;
    stopName: string; waitMin: number; destination: string;
  } | null;
  allBusOptions: { departureTime: string; routeShortName: string; waitMin: number; destination: string }[];
  justMissed: { departureTime: string; routeShortName: string; missedByMin: number; destination: string }[];
  status: "ok" | "long-wait" | "no-bus" | "just-missed";
  totalTransferMin: number | null;
}

interface DepartureConnection {
  destination: string; departureTime: string;
  bestBusArrival: string | null; bestBusRoute: string | null;
  waitMinutes: number | null; missedBy: number | null;
}

interface DestinationCoverage {
  destination: string; routeShortName: string; routeLongName: string;
  tripsPerDay: number; firstDeparture: string; lastDeparture: string;
  avgFrequencyMin: number | null;
}

interface HubGap { hour: number; busDepartures: number; hubArrivals: number; hubDepartures: number; gap: boolean; }

interface WaitBucket { range: string; count: number; }

interface ArrivalStats {
  totalArrivals: number; withBus: number; noBus: number;
  justMissed: number; longWait: number; ok: number;
  avgWaitMin: number | null; avgTotalTransferMin: number | null;
}

interface HubAnalysis {
  hub: { id: string; name: string; type: "railway" | "port"; lat: number; lng: number; description: string; platformWalkMinutes: number };
  isServed: boolean;
  nearbyStops: NearbyStop[];
  busLines: BusLine[];
  arrivalConnections: ArrivalConnection[];
  departureConnections: DepartureConnection[];
  destinationCoverage: DestinationCoverage[];
  gapAnalysis: HubGap[];
  waitDistribution: WaitBucket[];
  arrivalStats: ArrivalStats;
  stats: { totalBusTrips: number; totalHubDepartures: number; covered: number; missed: number; avgWaitMin: number | null };
}

interface Suggestion {
  priority: "critical" | "high" | "medium" | "low";
  type: string; hub: string; description: string;
  details?: string; suggestedTimes?: string[];
}

interface ScheduleProposal {
  action: "add" | "shift" | "extend";
  hubId: string; hubName: string;
  currentTime?: string; proposedTime: string;
  reason: string; impact: string;
}

interface AnalysisResult {
  hubs: HubAnalysis[];
  summary: {
    totalHubs: number; servedHubs: number;
    totalArrivals: number; arrivalOk: number; arrivalLongWait: number;
    arrivalNoBus: number; arrivalJustMissed: number; arrivalCoveragePercent: number;
    totalDepartures: number; departureCovered: number;
    avgWaitAtStop: number | null; avgTotalTransfer: number | null;
    totalBusLines: number;
  };
  suggestions: Suggestion[];
  proposedSchedule: ScheduleProposal[];
  config: { maxWalkKm: number; walkSpeedKmh: number };
}

// ─── Map styles ──────────────────────────────────────────────
type ViewMode = "dark" | "city3d" | "city3d-dark" | "satellite";
const MAP_STYLES: Record<ViewMode, string> = {
  dark: "mapbox://styles/mapbox/dark-v11",
  "city3d": "mapbox://styles/mapbox/standard",
  "city3d-dark": "mapbox://styles/mapbox/standard",
  satellite: "mapbox://styles/mapbox/satellite-streets-v12",
};

const HUB_COLORS: Record<string, string> = { railway: "#06b6d4", port: "#3b82f6" };

const STATUS_CONFIG: Record<string, { color: string; bg: string; border: string; label: string; icon: React.ReactNode }> = {
  ok: { color: "text-emerald-400", bg: "bg-emerald-500/10", border: "border-emerald-500/20", label: "OK", icon: <CheckCircle2 className="w-3 h-3" /> },
  "long-wait": { color: "text-amber-400", bg: "bg-amber-500/10", border: "border-amber-500/20", label: "Attesa lunga", icon: <Clock className="w-3 h-3" /> },
  "no-bus": { color: "text-red-400", bg: "bg-red-500/10", border: "border-red-500/20", label: "Nessun bus", icon: <XCircle className="w-3 h-3" /> },
  "just-missed": { color: "text-orange-400", bg: "bg-orange-500/10", border: "border-orange-500/20", label: "Appena perso", icon: <AlertCircle className="w-3 h-3" /> },
};

const PRIORITY_COLORS: Record<string, { bg: string; border: string; text: string; label: string }> = {
  critical: { bg: "bg-red-500/15", border: "border-red-500/30", text: "text-red-300", label: "CRITICO" },
  high: { bg: "bg-amber-500/15", border: "border-amber-500/30", text: "text-amber-200", label: "ALTO" },
  medium: { bg: "bg-blue-500/10", border: "border-blue-500/20", text: "text-blue-200", label: "MEDIO" },
  low: { bg: "bg-muted/30", border: "border-border/30", text: "text-muted-foreground", label: "BASSO" },
};

// ─── Helper: walk circle GeoJSON ─────────────────────────────
function walkCircle(lat: number, lng: number, radiusKm: number, steps = 64): GeoJSON.Feature {
  const coords: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const angle = (i / steps) * 2 * Math.PI;
    const dLat = (radiusKm / 111.32) * Math.cos(angle);
    const dLng = (radiusKm / (111.32 * Math.cos(lat * Math.PI / 180))) * Math.sin(angle);
    coords.push([lng + dLng, lat + dLat]);
  }
  return { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [coords] } };
}

function shortHubName(name: string) {
  return name.replace("Stazione FS ", "").replace("Stazione ", "").replace("Porto di Ancona (Terminal Passeggeri)", "Porto Ancona");
}

// ─── Component ──────────────────────────────────────────────
export default function IntermodalPage() {
  const mapRef = useRef<MapRef>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("dark");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [radius, setRadius] = useState(0.5);
  const [selectedHub, setSelectedHub] = useState<string | null>(null);
  const [expandedHub, setExpandedHub] = useState<string | null>(null);
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  const [showSchedule, setShowSchedule] = useState(false);
  const [activeTab, setActiveTab] = useState<"arrivi" | "partenze" | "destinazioni">("arrivi");

  // Fetch analysis
  const runAnalysis = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${getApiBase()}/api/intermodal/analyze?radius=${radius}`);
      const data = await r.json();
      setResult(data);
    } catch {
      alert("Errore nell'analisi intermodale");
    } finally {
      setLoading(false);
    }
  }, [radius]);

  useEffect(() => { runAnalysis(); }, [runAnalysis]);

  const selectedHubData = useMemo(() => {
    if (!result || !selectedHub) return null;
    return result.hubs.find(h => h.hub.id === selectedHub) || null;
  }, [result, selectedHub]);

  // GeoJSON layers
  const hubCirclesGeoJSON = useMemo(() => {
    if (!result) return null;
    return {
      type: "FeatureCollection" as const,
      features: result.hubs.map(h => ({
        ...walkCircle(h.hub.lat, h.hub.lng, result.config.maxWalkKm),
        properties: { hubId: h.hub.id, type: h.hub.type, isServed: h.isServed },
      })),
    };
  }, [result]);

  const nearbyStopsGeoJSON = useMemo(() => {
    if (!result) return null;
    const features = result.hubs.flatMap(h =>
      h.nearbyStops.map(s => ({
        type: "Feature" as const,
        properties: { hubId: h.hub.id, stopName: s.stopName, distKm: s.distKm, walkMin: s.walkMin },
        geometry: { type: "Point" as const, coordinates: [s.lng, s.lat] },
      }))
    );
    return { type: "FeatureCollection" as const, features };
  }, [result]);

  const connectionLinesGeoJSON = useMemo(() => {
    if (!result) return null;
    const features = result.hubs.flatMap(h =>
      h.nearbyStops.map(s => ({
        type: "Feature" as const,
        properties: { hubId: h.hub.id, type: h.hub.type, walkMin: s.walkMin },
        geometry: { type: "LineString" as const, coordinates: [[h.hub.lng, h.hub.lat], [s.lng, s.lat]] },
      }))
    );
    return { type: "FeatureCollection" as const, features };
  }, [result]);

  // Chart: arrival status donut
  const arrivalStatusData = useMemo(() => {
    if (!result) return [];
    return [
      { name: "OK (≤25 min)", value: result.summary.arrivalOk, color: "#22c55e" },
      { name: "Attesa lunga", value: result.summary.arrivalLongWait, color: "#eab308" },
      { name: "Appena perso", value: result.summary.arrivalJustMissed, color: "#f97316" },
      { name: "Nessun bus", value: result.summary.arrivalNoBus, color: "#ef4444" },
    ].filter(d => d.value > 0);
  }, [result]);

  // Chart: per-hub arrival breakdown
  const hubArrivalChartData = useMemo(() => {
    if (!result) return [];
    return result.hubs.map(h => ({
      name: shortHubName(h.hub.name),
      ok: h.arrivalStats.ok,
      lungaAttesa: h.arrivalStats.longWait,
      perso: h.arrivalStats.justMissed,
      nessunBus: h.arrivalStats.noBus,
    }));
  }, [result]);

  if (!MAPBOX_TOKEN) {
    return (
      <div className="flex h-full items-center justify-center bg-card">
        <div className="text-center space-y-4 max-w-md p-8 border border-destructive/20 bg-destructive/5 rounded-2xl">
          <AlertTriangle className="w-12 h-12 text-destructive mx-auto" />
          <h2 className="text-xl font-bold">Mapbox Token Mancante</h2>
        </div>
      </div>
    );
  }

  return (
    <div className="relative w-full h-full overflow-hidden">
      {/* ── Map ────────────────────────────────────────────── */}
      <Map
        ref={mapRef}
        initialViewState={{ longitude: 13.46, latitude: 43.615, zoom: 12 }}
        mapStyle={MAP_STYLES[viewMode]}
        mapboxAccessToken={MAPBOX_TOKEN}
        style={{ width: "100%", height: "100%" }}
      >
        <Source id="mapbox-dem" type="raster-dem" url="mapbox://mapbox.mapbox-terrain-dem-v1" tileSize={512} maxzoom={14} />

        {/* Hub walk radius circles */}
        {hubCirclesGeoJSON && (
          <Source id="hub-circles" type="geojson" data={hubCirclesGeoJSON as any}>
            <Layer id="hub-circles-fill" type="fill" paint={{
              "fill-color": ["match", ["get", "type"], "railway", "#06b6d4", "port", "#3b82f6", "#888"],
              "fill-opacity": ["case", ["get", "isServed"], 0.08, 0.04],
            }} />
            <Layer id="hub-circles-line" type="line" paint={{
              "line-color": ["match", ["get", "type"], "railway", "#06b6d4", "port", "#3b82f6", "#888"],
              "line-width": 1.5,
              "line-opacity": 0.5,
              "line-dasharray": [3, 2],
            }} />
          </Source>
        )}

        {/* Connection lines hub → stops */}
        {connectionLinesGeoJSON && (
          <Source id="connection-lines" type="geojson" data={connectionLinesGeoJSON as any}>
            <Layer id="connection-lines-layer" type="line" paint={{
              "line-color": ["match", ["get", "type"], "railway", "#06b6d4", "port", "#3b82f6", "#888"],
              "line-width": 1,
              "line-opacity": 0.35,
              "line-dasharray": [2, 2],
            }} />
          </Source>
        )}

        {/* Nearby bus stops */}
        {nearbyStopsGeoJSON && (
          <Source id="nearby-stops" type="geojson" data={nearbyStopsGeoJSON as any}>
            <Layer id="nearby-stops-glow" type="circle" paint={{
              "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 8, 15, 16],
              "circle-color": "#f59e0b",
              "circle-opacity": 0.15,
              "circle-blur": 1,
            }} />
            <Layer id="nearby-stops-dots" type="circle" paint={{
              "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 3, 15, 6],
              "circle-color": "#f59e0b",
              "circle-stroke-color": "#000",
              "circle-stroke-width": 1,
            }} />
          </Source>
        )}

        {/* Hub Markers */}
        {result?.hubs.map(h => {
          const statusColor = h.arrivalStats.noBus > 0 || h.arrivalStats.justMissed > 0
            ? "border-red-500" : h.arrivalStats.longWait > 0
            ? "border-amber-400" : "border-emerald-400";
          return (
            <Marker key={h.hub.id} longitude={h.hub.lng} latitude={h.hub.lat} anchor="center"
              onClick={e => { e.originalEvent.stopPropagation(); setSelectedHub(h.hub.id); setExpandedHub(h.hub.id); }}>
              <div className={`relative cursor-pointer transition-transform hover:scale-110 ${selectedHub === h.hub.id ? "scale-125" : ""}`}>
                {h.isServed && (
                  <div className="absolute inset-0 -m-2 rounded-full animate-ping opacity-20"
                    style={{ backgroundColor: HUB_COLORS[h.hub.type] }} />
                )}
                <div className={`relative z-10 w-10 h-10 rounded-full flex items-center justify-center shadow-lg border-2 ${statusColor}`}
                  style={{ backgroundColor: HUB_COLORS[h.hub.type] + "dd" }}>
                  {h.hub.type === "railway"
                    ? <TrainFront className="w-5 h-5 text-white" />
                    : <Ship className="w-5 h-5 text-white" />}
                </div>
                {/* Badge: arrival coverage % */}
                <div className={`absolute -bottom-1.5 -right-1.5 text-[7px] font-bold w-5 h-5 rounded-full flex items-center justify-center z-20 border border-card ${
                  h.arrivalStats.totalArrivals > 0
                    ? h.arrivalStats.ok / h.arrivalStats.totalArrivals >= 0.7 ? "bg-emerald-500 text-white"
                    : h.arrivalStats.ok / h.arrivalStats.totalArrivals >= 0.4 ? "bg-amber-500 text-black"
                    : "bg-red-500 text-white"
                    : "bg-gray-500 text-white"
                }`}>
                  {h.arrivalStats.totalArrivals > 0
                    ? Math.round((h.arrivalStats.ok / h.arrivalStats.totalArrivals) * 100) + "%"
                    : "—"}
                </div>
                {!h.isServed && (
                  <div className="absolute -top-1 -left-1 bg-red-500 text-white w-4 h-4 rounded-full flex items-center justify-center z-20">
                    <span className="text-[9px] font-bold">!</span>
                  </div>
                )}
              </div>
            </Marker>
          );
        })}

        {/* Popup on hub click */}
        {selectedHubData && (
          <Popup longitude={selectedHubData.hub.lng} latitude={selectedHubData.hub.lat}
            anchor="bottom" offset={20} closeOnClick={false}
            onClose={() => { setSelectedHub(null); }}
            className="[&_.mapboxgl-popup-content]:!bg-card/95 [&_.mapboxgl-popup-content]:!backdrop-blur-xl [&_.mapboxgl-popup-content]:!rounded-xl [&_.mapboxgl-popup-content]:!border [&_.mapboxgl-popup-content]:!border-border/50 [&_.mapboxgl-popup-content]:!shadow-2xl [&_.mapboxgl-popup-content]:!p-3 [&_.mapboxgl-popup-tip]:!border-t-card/95">
            <div className="max-w-[280px] space-y-2">
              <div className="flex items-center gap-2">
                {selectedHubData.hub.type === "railway"
                  ? <TrainFront className="w-4 h-4 text-cyan-400" />
                  : <Ship className="w-4 h-4 text-blue-400" />}
                <span className="text-xs font-bold text-foreground">{selectedHubData.hub.name}</span>
              </div>
              <p className="text-[10px] text-muted-foreground">{selectedHubData.hub.description}</p>

              {/* Arrival stats in popup */}
              <div className="grid grid-cols-4 gap-1 text-center">
                {(["ok", "long-wait", "just-missed", "no-bus"] as const).map(status => {
                  const cfg = STATUS_CONFIG[status];
                  const count = status === "ok" ? selectedHubData.arrivalStats.ok
                    : status === "long-wait" ? selectedHubData.arrivalStats.longWait
                    : status === "just-missed" ? selectedHubData.arrivalStats.justMissed
                    : selectedHubData.arrivalStats.noBus;
                  return (
                    <div key={status} className={`${cfg.bg} rounded p-1`}>
                      <p className={`text-xs font-bold ${cfg.color}`}>{count}</p>
                      <p className="text-[7px] text-muted-foreground">{cfg.label}</p>
                    </div>
                  );
                })}
              </div>

              <div className="flex items-center gap-3 text-[9px] text-muted-foreground">
                <span className="flex items-center gap-1">
                  <Footprints className="w-3 h-3" /> Cammino min: {selectedHubData.nearbyStops[0]?.walkMin ?? "—"} min
                </span>
                {selectedHubData.arrivalStats.avgTotalTransferMin !== null && (
                  <span className="flex items-center gap-1">
                    <Timer className="w-3 h-3" /> Trasf. medio: {selectedHubData.arrivalStats.avgTotalTransferMin} min
                  </span>
                )}
              </div>
            </div>
          </Popup>
        )}
      </Map>

      {/* ── Loading overlay ─────────────────────────────────── */}
      <AnimatePresence>
        {loading && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="absolute inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50">
            <div className="bg-card/90 px-6 py-4 rounded-2xl flex items-center gap-3 shadow-2xl border border-border/50">
              <Loader2 className="w-5 h-5 animate-spin text-cyan-400" />
              <span className="text-sm text-foreground">Analisi coincidenze passeggero in corso…</span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Left Panel ────────────────────────────────────── */}
      <div className="absolute top-4 left-4 bottom-4 z-20 pointer-events-none" style={{ width: panelCollapsed ? 48 : 400 }}>
        <motion.div initial={{ x: -20, opacity: 0 }} animate={{ x: 0, opacity: 1 }}
          className="h-full pointer-events-auto">
          <Card className="h-full bg-card/85 backdrop-blur-2xl border-border/50 shadow-2xl overflow-hidden flex flex-col">
            {/* Header */}
            <div className="px-4 py-3 border-b border-border/30 flex items-center gap-2 shrink-0">
              {!panelCollapsed && (
                <>
                  <ArrowRightLeft className="w-4 h-4 text-cyan-400" />
                  <span className="text-sm font-bold flex-1">Esperienza Passeggero Intermodale</span>
                </>
              )}
              <button onClick={() => setPanelCollapsed(v => !v)}
                className="text-muted-foreground hover:text-foreground transition-colors">
                {panelCollapsed ? <ChevronDown className="w-4 h-4 rotate-[-90deg]" /> : <ChevronUp className="w-4 h-4 rotate-[-90deg]" />}
              </button>
            </div>

            {!panelCollapsed && (
              <CardContent className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
                {/* Radius control */}
                <div className="flex items-center gap-2">
                  <Footprints className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                  <label className="text-[10px] text-muted-foreground whitespace-nowrap">Raggio:</label>
                  <input type="range" min={0.2} max={1.5} step={0.1} value={radius}
                    onChange={e => setRadius(+e.target.value)}
                    className="flex-1 h-1 accent-cyan-500" />
                  <span className="text-[10px] font-mono font-semibold w-10 text-right">{radius} km</span>
                  <button onClick={runAnalysis}
                    className="text-[9px] bg-cyan-500/20 text-cyan-400 px-2 py-1 rounded hover:bg-cyan-500/30 transition-colors font-semibold">
                    Aggiorna
                  </button>
                </div>

                {result && (
                  <>
                    {/* ── HEADLINE: Passenger Arrival Experience ── */}
                    <div className="bg-gradient-to-br from-cyan-500/10 to-blue-500/10 rounded-xl p-3 border border-cyan-500/20">
                      <p className="text-[10px] font-semibold text-cyan-400 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                        <Users className="w-3 h-3" /> Scendo dal treno/nave: trovo il bus?
                      </p>
                      <div className="grid grid-cols-5 gap-1.5 text-center">
                        <div className="bg-card/50 rounded-lg p-1.5">
                          <p className="text-lg font-bold text-foreground">{result.summary.totalArrivals}</p>
                          <p className="text-[7px] text-muted-foreground">Arrivi</p>
                        </div>
                        <div className="bg-emerald-500/10 rounded-lg p-1.5">
                          <p className="text-lg font-bold text-emerald-400">{result.summary.arrivalOk}</p>
                          <p className="text-[7px] text-muted-foreground">OK ≤25'</p>
                        </div>
                        <div className="bg-amber-500/10 rounded-lg p-1.5">
                          <p className="text-lg font-bold text-amber-400">{result.summary.arrivalLongWait}</p>
                          <p className="text-[7px] text-muted-foreground">Lunga att.</p>
                        </div>
                        <div className="bg-orange-500/10 rounded-lg p-1.5">
                          <p className="text-lg font-bold text-orange-400">{result.summary.arrivalJustMissed}</p>
                          <p className="text-[7px] text-muted-foreground">Perso</p>
                        </div>
                        <div className="bg-red-500/10 rounded-lg p-1.5">
                          <p className="text-lg font-bold text-red-400">{result.summary.arrivalNoBus}</p>
                          <p className="text-[7px] text-muted-foreground">No bus</p>
                        </div>
                      </div>

                      {/* Avg transfer info */}
                      <div className="flex items-center gap-4 mt-2">
                        {result.summary.avgWaitAtStop !== null && (
                          <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                            <Clock className="w-3 h-3 text-amber-400" />
                            Attesa media alla fermata: <span className="font-bold text-foreground">{result.summary.avgWaitAtStop} min</span>
                          </div>
                        )}
                        {result.summary.avgTotalTransfer !== null && (
                          <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                            <Timer className="w-3 h-3 text-cyan-400" />
                            Trasferimento totale: <span className="font-bold text-foreground">{result.summary.avgTotalTransfer} min</span>
                          </div>
                        )}
                      </div>

                      {/* Coverage bar */}
                      <div className="mt-2">
                        <div className="flex items-center justify-between text-[9px] text-muted-foreground mb-1">
                          <span>Copertura arrivi</span>
                          <span className={`font-bold ${
                            result.summary.arrivalCoveragePercent >= 80 ? "text-emerald-400"
                            : result.summary.arrivalCoveragePercent >= 50 ? "text-amber-400"
                            : "text-red-400"
                          }`}>{result.summary.arrivalCoveragePercent}%</span>
                        </div>
                        <div className="h-2 bg-muted/30 rounded-full overflow-hidden">
                          <div className="h-full rounded-full transition-all duration-500"
                            style={{
                              width: `${result.summary.arrivalCoveragePercent}%`,
                              background: result.summary.arrivalCoveragePercent >= 80 ? "#22c55e"
                                : result.summary.arrivalCoveragePercent >= 50 ? "#eab308" : "#ef4444",
                            }} />
                        </div>
                      </div>
                    </div>

                    {/* Donut + bar side by side */}
                    <div className="grid grid-cols-2 gap-2">
                      {/* Donut chart */}
                      {arrivalStatusData.length > 0 && (
                        <div>
                          <p className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wide mb-1 text-center">
                            Stato coincidenze
                          </p>
                          <div className="h-28">
                            <ResponsiveContainer width="100%" height="100%">
                              <PieChart>
                                <Pie data={arrivalStatusData} dataKey="value" cx="50%" cy="50%"
                                  innerRadius={25} outerRadius={45} paddingAngle={2} strokeWidth={0}>
                                  {arrivalStatusData.map((d, i) => (
                                    <Cell key={i} fill={d.color} />
                                  ))}
                                </Pie>
                                <ReTooltip contentStyle={{ background: "#1e293b", border: "1px solid #334155", borderRadius: 8, fontSize: 10 }} />
                              </PieChart>
                            </ResponsiveContainer>
                          </div>
                          <div className="flex flex-wrap gap-x-2 gap-y-0.5 justify-center">
                            {arrivalStatusData.map(d => (
                              <span key={d.name} className="text-[7px] text-muted-foreground flex items-center gap-0.5">
                                <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: d.color }} />
                                {d.name}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Per-hub bar chart */}
                      {hubArrivalChartData.length > 0 && (
                        <div>
                          <p className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wide mb-1 text-center">
                            Per hub
                          </p>
                          <div className="h-28">
                            <ResponsiveContainer width="100%" height="100%">
                              <BarChart data={hubArrivalChartData} layout="vertical" margin={{ left: 2, right: 2 }}>
                                <XAxis type="number" tick={{ fill: "#94a3b8", fontSize: 8 }} />
                                <YAxis type="category" dataKey="name" tick={{ fill: "#94a3b8", fontSize: 8 }} width={55} />
                                <ReTooltip contentStyle={{ background: "#1e293b", border: "1px solid #334155", borderRadius: 8, fontSize: 9 }} />
                                <Bar dataKey="ok" stackId="a" fill="#22c55e" barSize={10} name="OK" />
                                <Bar dataKey="lungaAttesa" stackId="a" fill="#eab308" barSize={10} name="Att. lunga" />
                                <Bar dataKey="perso" stackId="a" fill="#f97316" barSize={10} name="Perso" />
                                <Bar dataKey="nessunBus" stackId="a" fill="#ef4444" barSize={10} radius={[0, 3, 3, 0]} name="No bus" />
                              </BarChart>
                            </ResponsiveContainer>
                          </div>
                        </div>
                      )}
                    </div>

                    {/* ── Per-hub detail cards ── */}
                    <div className="space-y-2">
                      <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
                        Dettaglio per Hub
                      </p>

                      {result.hubs.map(hc => {
                        const isExpanded = expandedHub === hc.hub.id;
                        const arrPct = hc.arrivalStats.totalArrivals > 0
                          ? Math.round((hc.arrivalStats.ok / hc.arrivalStats.totalArrivals) * 100) : 0;
                        return (
                          <div key={hc.hub.id}
                            className={`rounded-lg border transition-colors cursor-pointer ${
                              selectedHub === hc.hub.id ? "ring-1 ring-cyan-500/50" : ""
                            } ${hc.isServed ? "bg-muted/20 border-border/30" : "bg-red-500/5 border-red-500/30"}`}
                            onClick={() => {
                              setSelectedHub(hc.hub.id);
                              setExpandedHub(isExpanded ? null : hc.hub.id);
                              mapRef.current?.flyTo({ center: [hc.hub.lng, hc.hub.lat], zoom: 14, duration: 1000 });
                            }}>

                            {/* Hub header */}
                            <div className="p-2.5 flex items-center gap-2">
                              {hc.hub.type === "railway"
                                ? <TrainFront className="w-4 h-4 text-cyan-400 shrink-0" />
                                : <Ship className="w-4 h-4 text-blue-400 shrink-0" />}
                              <span className="text-[11px] font-bold flex-1 truncate">{hc.hub.name}</span>

                              {/* Mini status badges */}
                              <div className="flex items-center gap-1 shrink-0">
                                {hc.arrivalStats.ok > 0 && (
                                  <span className="text-[8px] bg-emerald-500/20 text-emerald-400 px-1 py-0.5 rounded font-semibold">
                                    ✓{hc.arrivalStats.ok}
                                  </span>
                                )}
                                {(hc.arrivalStats.noBus + hc.arrivalStats.justMissed) > 0 && (
                                  <span className="text-[8px] bg-red-500/20 text-red-400 px-1 py-0.5 rounded font-semibold">
                                    ✗{hc.arrivalStats.noBus + hc.arrivalStats.justMissed}
                                  </span>
                                )}
                                <span className="text-[9px] font-mono font-bold text-muted-foreground">{arrPct}%</span>
                              </div>
                              {isExpanded ? <ChevronUp className="w-3 h-3 text-muted-foreground" /> : <ChevronDown className="w-3 h-3 text-muted-foreground" />}
                            </div>

                            <AnimatePresence>
                              {isExpanded && (
                                <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}
                                  className="overflow-hidden">
                                  <div className="px-2.5 pb-3 space-y-2.5 border-t border-border/20 pt-2">

                                    {/* Walk info */}
                                    <div className="flex items-center gap-3 text-[9px] text-muted-foreground">
                                      <span className="flex items-center gap-1">
                                        <Footprints className="w-3 h-3 text-cyan-400" />
                                        Piattaforma → uscita: {hc.hub.platformWalkMinutes} min
                                      </span>
                                      {hc.nearbyStops.length > 0 && (
                                        <span className="flex items-center gap-1">
                                          <MapPin className="w-3 h-3 text-amber-400" />
                                          Fermata più vicina: {hc.nearbyStops[0].walkMin} min tot.
                                        </span>
                                      )}
                                    </div>

                                    {/* Tabs: Arrivi / Partenze / Destinazioni */}
                                    <div className="flex gap-1 border-b border-border/20 pb-1">
                                      {(["arrivi", "partenze", "destinazioni"] as const).map(tab => (
                                        <button key={tab}
                                          onClick={e => { e.stopPropagation(); setActiveTab(tab); }}
                                          className={`text-[9px] px-2 py-1 rounded-t font-semibold transition-colors ${
                                            activeTab === tab
                                              ? "bg-cyan-500/20 text-cyan-400 border-b-2 border-cyan-500"
                                              : "text-muted-foreground hover:text-foreground"
                                          }`}>
                                          {tab === "arrivi" ? `🚉 Arrivi (${hc.arrivalConnections.length})`
                                            : tab === "partenze" ? `🚌 Partenze (${hc.departureConnections.length})`
                                            : `📍 Destinazioni (${hc.destinationCoverage.length})`}
                                        </button>
                                      ))}
                                    </div>

                                    {/* TAB: Arrivi — il cuore dell'analisi */}
                                    {activeTab === "arrivi" && (
                                      <div className="space-y-1.5">
                                        {hc.arrivalConnections.length === 0 ? (
                                          <p className="text-[10px] text-muted-foreground italic">Nessun arrivo configurato</p>
                                        ) : (
                                          <>
                                            {/* Wait distribution mini-chart */}
                                            {hc.waitDistribution && (
                                              <div>
                                                <p className="text-[8px] text-muted-foreground font-semibold mb-1">Distribuzione attesa alla fermata:</p>
                                                <div className="h-16">
                                                  <ResponsiveContainer width="100%" height="100%">
                                                    <BarChart data={hc.waitDistribution} margin={{ left: 0, right: 0 }}>
                                                      <XAxis dataKey="range" tick={{ fill: "#94a3b8", fontSize: 7 }} interval={0} angle={-30} textAnchor="end" height={25} />
                                                      <YAxis tick={{ fill: "#94a3b8", fontSize: 7 }} width={15} />
                                                      <Bar dataKey="count" barSize={14} radius={[2, 2, 0, 0]}>
                                                        {hc.waitDistribution.map((d, i) => (
                                                          <Cell key={i} fill={
                                                            i <= 2 ? "#22c55e" : i <= 3 ? "#eab308" : i <= 4 ? "#f97316" : "#ef4444"
                                                          } />
                                                        ))}
                                                      </Bar>
                                                    </BarChart>
                                                  </ResponsiveContainer>
                                                </div>
                                              </div>
                                            )}

                                            {/* Per-arrival details */}
                                            <div className="space-y-1 max-h-48 overflow-y-auto">
                                              {hc.arrivalConnections.map((ac, i) => {
                                                const cfg = STATUS_CONFIG[ac.status];
                                                return (
                                                  <div key={i} className={`text-[9px] px-2 py-1.5 rounded border ${cfg.bg} ${cfg.border}`}>
                                                    <div className="flex items-center gap-1.5">
                                                      <span className={cfg.color}>{cfg.icon}</span>
                                                      <span className="font-semibold text-foreground">{ac.arrivalTime}</span>
                                                      <span className="text-muted-foreground">da {ac.origin}</span>
                                                      <span className="ml-auto text-[8px] text-muted-foreground flex items-center gap-0.5">
                                                        <Footprints className="w-2.5 h-2.5" />{ac.walkMin}min
                                                      </span>
                                                    </div>

                                                    {ac.firstBus ? (
                                                      <div className="mt-0.5 flex items-center gap-1 text-muted-foreground">
                                                        <ArrowRight className="w-2.5 h-2.5" />
                                                        Alla fermata {ac.atBusStopTime} → Bus
                                                        <span className="text-amber-300 font-semibold">[{ac.firstBus.routeShortName}]</span>
                                                        {ac.firstBus.departureTime}
                                                        <span className={`ml-1 ${ac.firstBus.waitMin > 25 ? "text-amber-400" : "text-emerald-400"}`}>
                                                          (attesa {ac.firstBus.waitMin}min)
                                                        </span>
                                                        {ac.firstBus.destination && (
                                                          <span className="text-[8px] ml-1">→ {ac.firstBus.destination}</span>
                                                        )}
                                                      </div>
                                                    ) : ac.justMissed.length > 0 ? (
                                                      <div className="mt-0.5 text-orange-400">
                                                        ⚠ Alla fermata {ac.atBusStopTime} — bus [{ac.justMissed[0].routeShortName}] partito {ac.justMissed[0].missedByMin}min prima!
                                                      </div>
                                                    ) : (
                                                      <div className="mt-0.5 text-red-400">
                                                        ✗ Alla fermata {ac.atBusStopTime} — nessun bus entro 60min
                                                      </div>
                                                    )}

                                                    {/* Show all options if available */}
                                                    {ac.allBusOptions.length > 1 && (
                                                      <div className="mt-0.5 text-[8px] text-muted-foreground">
                                                        Altre opzioni: {ac.allBusOptions.slice(1, 4).map(o =>
                                                          `[${o.routeShortName}] ${o.departureTime} (${o.waitMin}')`
                                                        ).join(" · ")}
                                                      </div>
                                                    )}
                                                  </div>
                                                );
                                              })}
                                            </div>
                                          </>
                                        )}
                                      </div>
                                    )}

                                    {/* TAB: Partenze (legacy: bus → treno) */}
                                    {activeTab === "partenze" && (
                                      <div className="space-y-1 max-h-48 overflow-y-auto">
                                        {hc.departureConnections.length === 0 ? (
                                          <p className="text-[10px] text-muted-foreground italic">Nessuna partenza configurata</p>
                                        ) : hc.departureConnections.map((dc, i) => (
                                          <div key={i} className={`text-[9px] px-2 py-1 rounded ${
                                            dc.bestBusArrival ? "bg-emerald-500/5 border border-emerald-500/15" : "bg-red-500/5 border border-red-500/15"
                                          }`}>
                                            <span className="font-semibold">{dc.departureTime}</span>
                                            <span className="text-muted-foreground"> → {dc.destination}</span>
                                            {dc.bestBusArrival ? (
                                              <span className="text-emerald-400 ml-1">
                                                Bus [{dc.bestBusRoute}] {dc.bestBusArrival} ({dc.waitMinutes}min)
                                              </span>
                                            ) : (
                                              <span className="text-red-400 ml-1">
                                                Nessun bus {dc.missedBy !== null && `(mancato ${dc.missedBy}min)`}
                                              </span>
                                            )}
                                          </div>
                                        ))}
                                      </div>
                                    )}

                                    {/* TAB: Destinazioni */}
                                    {activeTab === "destinazioni" && (
                                      <div className="space-y-1 max-h-48 overflow-y-auto">
                                        {hc.destinationCoverage.length === 0 ? (
                                          <p className="text-[10px] text-muted-foreground italic">Nessuna destinazione identificata</p>
                                        ) : hc.destinationCoverage.map((dc, i) => (
                                          <div key={i} className="text-[9px] px-2 py-1 rounded bg-muted/20 border border-border/20 flex items-center gap-2">
                                            <MapPinned className="w-3 h-3 text-cyan-400 shrink-0" />
                                            <div className="flex-1 min-w-0">
                                              <span className="font-semibold text-foreground truncate block">{dc.destination}</span>
                                              <span className="text-muted-foreground">
                                                [{dc.routeShortName}] {dc.tripsPerDay} corse · {dc.firstDeparture}–{dc.lastDeparture}
                                                {dc.avgFrequencyMin && ` · ogni ~${dc.avgFrequencyMin}'`}
                                              </span>
                                            </div>
                                          </div>
                                        ))}
                                      </div>
                                    )}

                                    {/* Bus lines */}
                                    {hc.busLines.length > 0 && (
                                      <div>
                                        <p className="text-[9px] text-muted-foreground font-semibold mb-1">{hc.busLines.length} linee bus:</p>
                                        <div className="flex flex-wrap gap-1">
                                          {hc.busLines.slice(0, 12).map(bl => (
                                            <span key={bl.routeId}
                                              className="text-[8px] px-1.5 py-0.5 rounded font-semibold"
                                              style={{
                                                backgroundColor: bl.routeColor ? `#${bl.routeColor}33` : "#64748b33",
                                                color: bl.routeColor ? `#${bl.routeColor}` : "#94a3b8",
                                              }}>
                                              {bl.routeShortName} <span className="opacity-60">({bl.tripsCount})</span>
                                            </span>
                                          ))}
                                          {hc.busLines.length > 12 && <span className="text-[8px] text-muted-foreground">+{hc.busLines.length - 12}</span>}
                                        </div>
                                      </div>
                                    )}

                                    {/* Hourly heatmap */}
                                    <div>
                                      <p className="text-[9px] text-muted-foreground font-semibold mb-1">
                                        Copertura oraria (bus vs arrivi {hc.hub.type === "railway" ? "treno" : "nave"})
                                      </p>
                                      <div className="flex gap-px">
                                        {hc.gapAnalysis.map(g => {
                                          const busColor = g.busDepartures > 3 ? "#22c55e" : g.busDepartures > 0 ? "#eab308" : "#334155";
                                          const hasArrival = g.hubArrivals > 0;
                                          const hasDeparture = g.hubDepartures > 0;
                                          return (
                                            <div key={g.hour} className="flex-1 relative"
                                              title={`${g.hour}:00 — Bus: ${g.busDepartures}, Arrivi: ${g.hubArrivals}, Partenze: ${g.hubDepartures}`}>
                                              <div className="h-3 rounded-sm" style={{ backgroundColor: busColor }}>
                                                {hasArrival && <div className="absolute -top-1 left-1/2 -translate-x-1/2 w-1.5 h-1.5 rounded-full bg-orange-400 border border-card" />}
                                                {hasDeparture && <div className="absolute -bottom-1 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-cyan-400 border border-card" />}
                                              </div>
                                              {g.hour % 3 === 0 && <p className="text-[7px] text-muted-foreground text-center mt-1">{g.hour}</p>}
                                            </div>
                                          );
                                        })}
                                      </div>
                                      <div className="flex items-center gap-2 mt-1 text-[7px] text-muted-foreground">
                                        <span className="flex items-center gap-0.5"><span className="w-2 h-2 rounded-sm bg-emerald-500" /> &gt;3 bus</span>
                                        <span className="flex items-center gap-0.5"><span className="w-2 h-2 rounded-sm bg-amber-500" /> 1-3</span>
                                        <span className="flex items-center gap-0.5"><span className="w-2 h-2 rounded-sm bg-slate-700" /> 0</span>
                                        <span className="flex items-center gap-0.5"><span className="w-1.5 h-1.5 rounded-full bg-orange-400" /> Arrivo</span>
                                        <span className="flex items-center gap-0.5"><span className="w-1 h-1 rounded-full bg-cyan-400" /> Partenza</span>
                                      </div>
                                    </div>

                                    {/* Nearby stops with walk times */}
                                    {hc.nearbyStops.length > 0 && (
                                      <div className="text-[9px] text-muted-foreground">
                                        <span className="font-semibold">{hc.nearbyStops.length} fermate</span> entro {result.config.maxWalkKm} km:
                                        {hc.nearbyStops.slice(0, 5).map(s => (
                                          <span key={s.stopId} className="ml-1">
                                            <MapPin className="w-2.5 h-2.5 inline text-amber-400" /> {s.stopName}
                                            <span className="text-[8px]"> ({s.distKm}km · 🚶{s.walkMin}min)</span>
                                          </span>
                                        ))}
                                      </div>
                                    )}
                                  </div>
                                </motion.div>
                              )}
                            </AnimatePresence>
                          </div>
                        );
                      })}
                    </div>

                    {/* ── Suggestions ── */}
                    {result.suggestions.length > 0 && (
                      <div className="space-y-1.5">
                        <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1">
                          <Lightbulb className="w-3 h-3 text-amber-400" /> Criticità e Suggerimenti ({result.suggestions.length})
                        </p>
                        {result.suggestions.map((sug, i) => {
                          const pc = PRIORITY_COLORS[sug.priority] || PRIORITY_COLORS.low;
                          return (
                            <div key={i} className={`text-[10px] px-3 py-2 rounded-lg border ${pc.bg} ${pc.border} ${pc.text}`}>
                              <div className="flex items-start gap-1.5">
                                <span className="text-[8px] font-bold uppercase opacity-70 shrink-0 mt-0.5">[{pc.label}]</span>
                                <div>
                                  <p>{sug.description}</p>
                                  {sug.details && (
                                    <p className="text-[9px] opacity-70 mt-0.5">{sug.details}</p>
                                  )}
                                  {sug.suggestedTimes && sug.suggestedTimes.length > 0 && (
                                    <p className="mt-1 text-[9px] opacity-80">
                                      <Clock className="w-3 h-3 inline mr-0.5" />
                                      Bus suggeriti: {sug.suggestedTimes.join(", ")}
                                    </p>
                                  )}
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {/* ── Proposed Schedule ── */}
                    {result.proposedSchedule.length > 0 && (
                      <div className="space-y-1.5">
                        <button onClick={() => setShowSchedule(v => !v)}
                          className="w-full text-left text-[10px] font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1 hover:text-foreground transition-colors">
                          <Timer className="w-3 h-3 text-violet-400" />
                          Programma proposto ({result.proposedSchedule.length} interventi)
                          {showSchedule ? <ChevronUp className="w-3 h-3 ml-auto" /> : <ChevronDown className="w-3 h-3 ml-auto" />}
                        </button>
                        <AnimatePresence>
                          {showSchedule && (
                            <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}
                              className="overflow-hidden">
                              <div className="text-[9px] space-y-0.5 max-h-56 overflow-y-auto">
                                <div className="grid grid-cols-[45px_55px_55px_1fr_1fr] gap-1 text-[8px] text-muted-foreground font-semibold pb-0.5 border-b border-border/30 sticky top-0 bg-card/90">
                                  <span>Azione</span><span>Orario</span><span>Hub</span><span>Motivo</span><span>Impatto</span>
                                </div>
                                {result.proposedSchedule.slice(0, 30).map((p, i) => {
                                  const actionIcon = p.action === "add" ? <PlusCircle className="w-3 h-3 text-emerald-400 inline" />
                                    : p.action === "shift" ? <ArrowRightLeft className="w-3 h-3 text-amber-400 inline" />
                                    : <Route className="w-3 h-3 text-blue-400 inline" />;
                                  const actionLabel = p.action === "add" ? "Nuova" : p.action === "shift" ? "Sposta" : "Estendi";
                                  return (
                                    <div key={i} className="grid grid-cols-[45px_55px_55px_1fr_1fr] gap-1 py-0.5 items-start">
                                      <span className="flex items-center gap-0.5">{actionIcon} {actionLabel}</span>
                                      <span className="font-mono font-semibold">
                                        {p.currentTime && <><span className="line-through text-muted-foreground">{p.currentTime}</span>→</>}
                                        {p.proposedTime}
                                      </span>
                                      <span className="truncate text-muted-foreground">{shortHubName(p.hubName)}</span>
                                      <span className="text-muted-foreground">{p.reason}</span>
                                      <span className="text-cyan-400/70">{p.impact}</span>
                                    </div>
                                  );
                                })}
                              </div>
                              {result.proposedSchedule.length > 30 && (
                                <p className="text-[9px] text-muted-foreground mt-1">+{result.proposedSchedule.length - 30} altri</p>
                              )}
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </div>
                    )}
                  </>
                )}
              </CardContent>
            )}
          </Card>
        </motion.div>
      </div>

      {/* ── Map style controls — bottom right ───────────────── */}
      <div className="absolute bottom-6 right-4 flex flex-col gap-2 pointer-events-auto z-10">
        <div className="bg-card/90 backdrop-blur-xl border border-border/50 shadow-xl rounded-xl p-1 flex gap-1">
          {([
            { key: "dark" as ViewMode, icon: <Sun className="w-3.5 h-3.5" />, label: "Scuro" },
            { key: "city3d" as ViewMode, icon: <Building2 className="w-3.5 h-3.5" />, label: "3D" },
            { key: "city3d-dark" as ViewMode, icon: <Moon className="w-3.5 h-3.5" />, label: "Notte" },
            { key: "satellite" as ViewMode, icon: <Satellite className="w-3.5 h-3.5" />, label: "Sat" },
          ]).map(({ key, icon, label }) => (
            <button key={key} title={label} onClick={() => setViewMode(key)}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all ${
                viewMode === key ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:text-foreground hover:bg-muted/60"
              }`}>
              {icon}<span className="hidden sm:inline">{label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* ── Legend — top right ───────────────────────────────── */}
      <div className="absolute top-4 right-4 z-10 pointer-events-auto">
        <Card className="bg-card/85 backdrop-blur-xl border-border/50 shadow-xl">
          <CardContent className="p-3 space-y-2">
            <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Legenda</p>
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <div className="w-6 h-6 rounded-full bg-cyan-500/80 flex items-center justify-center">
                  <TrainFront className="w-3 h-3 text-white" />
                </div>
                <span className="text-[10px] text-muted-foreground">Stazione ferroviaria</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-6 h-6 rounded-full bg-blue-500/80 flex items-center justify-center">
                  <Ship className="w-3 h-3 text-white" />
                </div>
                <span className="text-[10px] text-muted-foreground">Terminal portuale</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full bg-amber-400 border border-black/30" />
                <span className="text-[10px] text-muted-foreground">Fermata bus vicina</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-4 h-4 rounded-full border-2 border-emerald-400 bg-transparent" />
                <span className="text-[10px] text-muted-foreground">Copertura ≥70%</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-4 h-4 rounded-full border-2 border-amber-400 bg-transparent" />
                <span className="text-[10px] text-muted-foreground">Copertura 40-70%</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-4 h-4 rounded-full border-2 border-red-500 bg-transparent" />
                <span className="text-[10px] text-muted-foreground">Copertura &lt;40%</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-5 h-5 rounded-full bg-emerald-500 flex items-center justify-center text-[6px] text-white font-bold">75%</div>
                <span className="text-[10px] text-muted-foreground">% coincidenze OK</span>
              </div>
            </div>
            <div className="pt-1 border-t border-border/20">
              <p className="text-[8px] text-muted-foreground">
                Velocità cammino: {result?.config.walkSpeedKmh || 4.5} km/h · Attesa max: 60 min
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
