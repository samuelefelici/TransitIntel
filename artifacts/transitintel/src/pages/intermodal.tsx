import React, { useState, useMemo, useCallback, useRef, useEffect } from "react";
import Map, { Source, Layer, Marker, Popup, MapRef } from "react-map-gl/mapbox";
import { motion, AnimatePresence } from "framer-motion";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip as ReTooltip, ResponsiveContainer, Cell,
  PieChart, Pie,
} from "recharts";
import {
  TrainFront, Ship, Loader2, ChevronDown, ChevronUp, AlertTriangle,
  Clock, ArrowRight, Lightbulb, Timer, PlusCircle,
  ArrowRightLeft, MapPin, Building2, Moon, Satellite, Route,
  Footprints, XCircle, MapPinned,
  Users, RefreshCw, Briefcase, Palmtree,
  Zap, Eye, EyeOff, Plane, HelpCircle,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { getApiBase } from "@/lib/api";

import type {
  AnalysisResult, HubPoisGroup,
} from "./intermodal/types";
import {
  type ViewMode, MAP_STYLES, HUB_COLORS, STATUS_CONFIG,
  PRIORITY_COLORS, POI_ICONS,
  walkCircle, shortHubName, hubIcon, hubGlowColor, hubTransportLabel,
} from "./intermodal/constants";

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN || "";

// ─── Component ──────────────────────────────────────────────
export default function IntermodalPage() {
  const mapRef = useRef<MapRef>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("neon");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [radius, setRadius] = useState(0.5);
  const [selectedHub, setSelectedHub] = useState<string | null>(null);
  const [expandedHub, setExpandedHub] = useState<string | null>(null);
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  const [showSchedule, setShowSchedule] = useState(false);
  const [activeTab, setActiveTab] = useState<"arrivi" | "partenze" | "destinazioni">("arrivi");

  // New states
  const [shapesGeoJSON, setShapesGeoJSON] = useState<any>(null);
  const [showRoutes, setShowRoutes] = useState(true);
  const [hubPoisData, setHubPoisData] = useState<HubPoisGroup[]>([]);
  const [showPois, setShowPois] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState<string | null>(null);
  const [showInfoTooltip, setShowInfoTooltip] = useState(false);

  // ─── Fetch analysis ──────────────────────────────────────
  const runAnalysis = useCallback(async () => {
    setLoading(true);
    try {
      const [analysisRes, shapesRes, poisRes, syncRes] = await Promise.all([
        fetch(`${getApiBase()}/api/intermodal/analyze?radius=${radius}`),
        fetch(`${getApiBase()}/api/intermodal/shapes?radius=${radius}`),
        fetch(`${getApiBase()}/api/intermodal/pois?radius=3`),
        fetch(`${getApiBase()}/api/intermodal/sync-status`),
      ]);
      const [data, shapes, pois, syncStatus] = await Promise.all([
        analysisRes.json(), shapesRes.json(), poisRes.json(), syncRes.json(),
      ]);
      setResult(data);
      setShapesGeoJSON(shapes);
      setHubPoisData(pois.hubPois || []);
      setLastSync(syncStatus.lastSyncedAt);
    } catch {
      alert("Errore nell'analisi intermodale");
    } finally {
      setLoading(false);
    }
  }, [radius]);

  useEffect(() => { runAnalysis(); }, [runAnalysis]);

  const syncSchedules = useCallback(async () => {
    setSyncing(true);
    try {
      const r = await fetch(`${getApiBase()}/api/intermodal/sync-schedules`, { method: "POST" });
      const data = await r.json();
      if (data.success) {
        setLastSync(data.syncedAt);
        await runAnalysis();
      }
    } catch {
      alert("Errore sincronizzazione orari");
    } finally {
      setSyncing(false);
    }
  }, [runAnalysis]);

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

  // POI connection lines
  const poiConnectionsGeoJSON = useMemo(() => {
    if (hubPoisData.length === 0) return null;
    const features = hubPoisData.flatMap(hp =>
      hp.pois.slice(0, 15).map(p => ({
        type: "Feature" as const,
        properties: { hubId: hp.hubId, category: p.category, hubType: hp.hubType },
        geometry: { type: "LineString" as const, coordinates: [[hp.hubLng, hp.hubLat], [p.lng, p.lat]] },
      }))
    );
    return { type: "FeatureCollection" as const, features };
  }, [hubPoisData]);

  // POI markers GeoJSON
  const poiMarkersGeoJSON = useMemo(() => {
    if (hubPoisData.length === 0) return null;
    const seen = new Set<string>();
    const features = hubPoisData.flatMap(hp =>
      hp.pois.filter(p => { if (seen.has(p.id)) return false; seen.add(p.id); return true; }).map(p => ({
        type: "Feature" as const,
        properties: { name: p.name || p.category, category: p.category, travelContext: p.travelContext },
        geometry: { type: "Point" as const, coordinates: [p.lng, p.lat] },
      }))
    );
    return { type: "FeatureCollection" as const, features };
  }, [hubPoisData]);

  // Chart data
  const arrivalStatusData = useMemo(() => {
    if (!result) return [];
    return [
      { name: "OK (≤25 min)", value: result.summary.arrivalOk, color: "#22c55e" },
      { name: "Attesa lunga", value: result.summary.arrivalLongWait, color: "#eab308" },
      { name: "Appena perso", value: result.summary.arrivalJustMissed, color: "#f97316" },
      { name: "Nessun bus", value: result.summary.arrivalNoBus, color: "#ef4444" },
    ].filter(d => d.value > 0);
  }, [result]);

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
      {/* ── Map ───────────────────────────────────────────── */}
      <Map
        ref={mapRef}
        initialViewState={{ longitude: 13.46, latitude: 43.615, zoom: 12, pitch: 45, bearing: -15 }}
        mapStyle={MAP_STYLES[viewMode]}
        mapboxAccessToken={MAPBOX_TOKEN}
        style={{ width: "100%", height: "100%" }}
        fog={{ color: "rgb(10, 10, 30)", "high-color": "rgb(20, 10, 50)", "horizon-blend": 0.08, "star-intensity": 0.2 } as any}
      >
        <Source id="mapbox-dem" type="raster-dem" url="mapbox://mapbox.mapbox-terrain-dem-v1" tileSize={512} maxzoom={14} />

        {/* ── BUS ROUTE SHAPES — Neon Glow Effect ── */}
        {showRoutes && shapesGeoJSON && shapesGeoJSON.features?.length > 0 && (
          <Source id="bus-routes" type="geojson" data={shapesGeoJSON}>
            <Layer id="bus-routes-glow-outer" type="line" paint={{
              "line-color": ["coalesce", ["get", "routeColor"], "#06b6d4"],
              "line-width": ["interpolate", ["linear"], ["zoom"], 10, 12, 15, 22],
              "line-opacity": 0.08,
              "line-blur": 12,
            }} />
            <Layer id="bus-routes-glow-mid" type="line" paint={{
              "line-color": ["coalesce", ["get", "routeColor"], "#06b6d4"],
              "line-width": ["interpolate", ["linear"], ["zoom"], 10, 6, 15, 12],
              "line-opacity": 0.2,
              "line-blur": 5,
            }} />
            <Layer id="bus-routes-core" type="line" paint={{
              "line-color": ["coalesce", ["get", "routeColor"], "#06b6d4"],
              "line-width": ["interpolate", ["linear"], ["zoom"], 10, 1.5, 15, 3],
              "line-opacity": 0.85,
            }} />
            <Layer id="bus-routes-bright" type="line" paint={{
              "line-color": "#ffffff",
              "line-width": ["interpolate", ["linear"], ["zoom"], 10, 0.3, 15, 0.8],
              "line-opacity": 0.35,
            }} />
          </Source>
        )}

        {/* ── POI Connection Lines (Hub → POI) ── */}
        {showPois && poiConnectionsGeoJSON && (
          <Source id="poi-connections" type="geojson" data={poiConnectionsGeoJSON as any}>
            <Layer id="poi-connections-glow" type="line" paint={{
              "line-color": ["match", ["get", "hubType"], "port", "#a855f7", "airport", "#f59e0b", "#3b82f6"],
              "line-width": 4, "line-opacity": 0.06, "line-blur": 4,
            }} />
            <Layer id="poi-connections-line" type="line" paint={{
              "line-color": ["match", ["get", "hubType"], "port", "#a855f7", "airport", "#f59e0b", "#3b82f6"],
              "line-width": 1, "line-opacity": 0.25, "line-dasharray": [4, 4],
            }} />
          </Source>
        )}

        {/* ── POI Markers ── */}
        {showPois && poiMarkersGeoJSON && (
          <Source id="poi-markers" type="geojson" data={poiMarkersGeoJSON as any}>
            <Layer id="poi-markers-glow" type="circle" paint={{
              "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 6, 15, 14],
              "circle-color": ["match", ["get", "category"],
                "office", "#3b82f6", "hospital", "#ef4444", "school", "#f59e0b",
                "industrial", "#6b7280", "leisure", "#22c55e", "shopping", "#a855f7", "#888"],
              "circle-opacity": 0.12, "circle-blur": 1,
            }} />
            <Layer id="poi-markers-dot" type="circle" paint={{
              "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 2.5, 15, 5],
              "circle-color": ["match", ["get", "category"],
                "office", "#3b82f6", "hospital", "#ef4444", "school", "#f59e0b",
                "industrial", "#6b7280", "leisure", "#22c55e", "shopping", "#a855f7", "#888"],
              "circle-stroke-color": "#000", "circle-stroke-width": 0.5, "circle-opacity": 0.8,
            }} />
          </Source>
        )}

        {/* Hub walk radius circles */}
        {hubCirclesGeoJSON && (
          <Source id="hub-circles" type="geojson" data={hubCirclesGeoJSON as any}>
            <Layer id="hub-circles-fill" type="fill" paint={{
              "fill-color": ["match", ["get", "type"], "railway", "#06b6d4", "port", "#8b5cf6", "airport", "#f59e0b", "#888"],
              "fill-opacity": ["case", ["get", "isServed"], 0.06, 0.03],
            }} />
            <Layer id="hub-circles-line" type="line" paint={{
              "line-color": ["match", ["get", "type"], "railway", "#06b6d4", "port", "#8b5cf6", "airport", "#f59e0b", "#888"],
              "line-width": 1.5, "line-opacity": 0.4, "line-dasharray": [3, 2],
            }} />
          </Source>
        )}

        {/* Connection lines hub → stops */}
        {connectionLinesGeoJSON && (
          <Source id="connection-lines" type="geojson" data={connectionLinesGeoJSON as any}>
            <Layer id="connection-lines-layer" type="line" paint={{
              "line-color": ["match", ["get", "type"], "railway", "#06b6d4", "port", "#8b5cf6", "airport", "#f59e0b", "#888"],
              "line-width": 1, "line-opacity": 0.3, "line-dasharray": [2, 2],
            }} />
          </Source>
        )}

        {/* Nearby bus stops */}
        {nearbyStopsGeoJSON && (
          <Source id="nearby-stops" type="geojson" data={nearbyStopsGeoJSON as any}>
            <Layer id="nearby-stops-glow" type="circle" paint={{
              "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 8, 15, 16],
              "circle-color": "#f59e0b", "circle-opacity": 0.12, "circle-blur": 1,
            }} />
            <Layer id="nearby-stops-dots" type="circle" paint={{
              "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 3, 15, 6],
              "circle-color": "#f59e0b", "circle-stroke-color": "#000", "circle-stroke-width": 1,
            }} />
          </Source>
        )}

        {/* Hub Markers */}
        {result?.hubs.map(h => {
          const pct = h.arrivalStats.totalArrivals > 0 ? h.arrivalStats.ok / h.arrivalStats.totalArrivals : 0;
          const statusColor = pct >= 0.7 ? "border-emerald-400" : pct >= 0.4 ? "border-amber-400" : "border-red-500";
          const glowColor = hubGlowColor(h.hub.type);
          return (
            <Marker key={h.hub.id} longitude={h.hub.lng} latitude={h.hub.lat} anchor="center"
              onClick={e => { e.originalEvent.stopPropagation(); setSelectedHub(h.hub.id); setExpandedHub(h.hub.id); }}>
              <div className={`relative cursor-pointer transition-transform hover:scale-110 ${selectedHub === h.hub.id ? "scale-125" : ""}`}>
                <div className="absolute inset-0 -m-3 rounded-full animate-ping opacity-15" style={{ backgroundColor: glowColor }} />
                <div className="absolute inset-0 -m-2 rounded-full animate-pulse opacity-25" style={{ backgroundColor: glowColor }} />
                <div className={`relative z-10 w-11 h-11 rounded-full flex items-center justify-center shadow-xl border-2 ${statusColor}`}
                  style={{ backgroundColor: HUB_COLORS[h.hub.type] + "ee", boxShadow: `0 0 20px ${glowColor}, 0 0 40px ${glowColor}` }}>
                  {hubIcon(h.hub.type, "w-5 h-5 text-white drop-shadow-lg")}
                </div>
                <div className={`absolute -bottom-1.5 -right-1.5 text-[7px] font-bold w-5 h-5 rounded-full flex items-center justify-center z-20 border border-black ${
                  pct >= 0.7 ? "bg-emerald-500 text-white" : pct >= 0.4 ? "bg-amber-500 text-black" : "bg-red-500 text-white"
                }`} style={{ boxShadow: "0 0 6px rgba(0,0,0,0.5)" }}>
                  {h.arrivalStats.totalArrivals > 0 ? Math.round(pct * 100) + "%" : "—"}
                </div>
              </div>
            </Marker>
          );
        })}

        {/* ── POPUP: Hub detail card — HIGHLY visible ── */}
        {selectedHubData && (
          <Popup longitude={selectedHubData.hub.lng} latitude={selectedHubData.hub.lat}
            anchor="bottom" offset={30} closeOnClick={false}
            onClose={() => setSelectedHub(null)} maxWidth="380px" className="intermodal-popup">
            <div className="min-w-[340px] rounded-2xl overflow-hidden"
              style={{
                background: "linear-gradient(145deg, rgba(15,23,42,0.98), rgba(30,20,60,0.98))",
                border: `2px solid ${HUB_COLORS[selectedHubData.hub.type]}88`,
                boxShadow: `0 0 30px ${HUB_COLORS[selectedHubData.hub.type]}44, 0 8px 32px rgba(0,0,0,0.6)`,
              }}>
              {/* Header with neon accent */}
              <div className="px-4 py-3 flex items-center gap-3"
                style={{
                  background: `linear-gradient(90deg, ${HUB_COLORS[selectedHubData.hub.type]}33, transparent)`,
                  borderBottom: `1px solid ${HUB_COLORS[selectedHubData.hub.type]}44`,
                }}>
                <div className="w-10 h-10 rounded-xl flex items-center justify-center"
                  style={{ backgroundColor: HUB_COLORS[selectedHubData.hub.type] + "33", boxShadow: `0 0 12px ${HUB_COLORS[selectedHubData.hub.type]}44`, color: HUB_COLORS[selectedHubData.hub.type] }}>
                  {hubIcon(selectedHubData.hub.type)}
                </div>
                <div className="flex-1">
                  <p className="text-sm font-bold text-white">{selectedHubData.hub.name}</p>
                  <p className="text-[10px] text-slate-400">{selectedHubData.hub.description}</p>
                </div>
              </div>

              {/* Stats grid */}
              <div className="grid grid-cols-4 gap-2 px-4 py-3">
                {([
                  { count: selectedHubData.arrivalStats.ok, label: "OK", color: "#22c55e", bg: "rgba(34,197,94,0.15)" },
                  { count: selectedHubData.arrivalStats.longWait, label: "Attesa", color: "#eab308", bg: "rgba(234,179,8,0.15)" },
                  { count: selectedHubData.arrivalStats.justMissed, label: "Perso", color: "#f97316", bg: "rgba(249,115,22,0.15)" },
                  { count: selectedHubData.arrivalStats.noBus, label: "No bus", color: "#ef4444", bg: "rgba(239,68,68,0.15)" },
                ]).map((s, idx) => (
                  <div key={idx} className="rounded-lg p-2 text-center" style={{ backgroundColor: s.bg, border: `1px solid ${s.color}33` }}>
                    <p className="text-lg font-bold" style={{ color: s.color }}>{s.count}</p>
                    <p className="text-[8px] text-slate-400 font-medium">{s.label}</p>
                  </div>
                ))}
              </div>

              {/* Transfer info */}
              <div className="px-4 pb-3 flex items-center gap-4">
                <div className="flex items-center gap-1.5 text-[10px] text-slate-300">
                  <Footprints className="w-3.5 h-3.5 text-cyan-400" />
                  <span>Cammino: <strong className="text-white">{selectedHubData.hub.platformWalkMinutes}+ min</strong></span>
                </div>
                {selectedHubData.arrivalStats.avgTotalTransferMin !== null && (
                  <div className="flex items-center gap-1.5 text-[10px] text-slate-300">
                    <Timer className="w-3.5 h-3.5 text-violet-400" />
                    <span>Trasf. medio: <strong className="text-white">{selectedHubData.arrivalStats.avgTotalTransferMin} min</strong></span>
                  </div>
                )}
              </div>

              {/* POI summary for this hub */}
              {(() => {
                const hpData = hubPoisData.find(hp => hp.hubId === selectedHubData.hub.id);
                if (!hpData || hpData.pois.length === 0) return null;
                const context = selectedHubData.hub.type === "port" ? "Turismo" : selectedHubData.hub.type === "airport" ? "Lavoro + Turismo" : "Lavoro";
                const catCounts: Record<string, number> = {};
                for (const p of hpData.pois) catCounts[p.category] = (catCounts[p.category] || 0) + 1;
                return (
                  <div className="px-4 pb-3 border-t border-white/10 pt-2">
                    <p className="text-[9px] font-semibold text-slate-400 uppercase tracking-wider mb-1.5 flex items-center gap-1">
                      {selectedHubData.hub.type === "port" ? <Palmtree className="w-3 h-3 text-violet-400" /> : selectedHubData.hub.type === "airport" ? <Plane className="w-3 h-3 text-amber-400" /> : <Briefcase className="w-3 h-3 text-cyan-400" />}
                      POI vicini ({context}) — {hpData.pois.length}
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {Object.entries(catCounts).map(([cat, count]) => {
                        const pi = POI_ICONS[cat];
                        return (
                          <span key={cat} className="text-[9px] px-2 py-0.5 rounded-full flex items-center gap-1 font-medium"
                            style={{ backgroundColor: (pi?.color || "#888") + "22", color: pi?.color || "#888", border: `1px solid ${(pi?.color || "#888")}33` }}>
                            {pi?.icon} {pi?.label || cat} ({count})
                          </span>
                        );
                      })}
                    </div>
                  </div>
                );
              })()}

              {/* Bus lines preview */}
              {selectedHubData.busLines.length > 0 && (
                <div className="px-4 pb-3 border-t border-white/10 pt-2">
                  <p className="text-[9px] font-semibold text-slate-400 uppercase tracking-wider mb-1.5">
                    {selectedHubData.busLines.length} linee bus collegate
                  </p>
                  <div className="flex flex-wrap gap-1">
                    {selectedHubData.busLines.slice(0, 10).map(bl => (
                      <span key={bl.routeId} className="text-[8px] px-1.5 py-0.5 rounded font-bold"
                        style={{
                          backgroundColor: bl.routeColor ? `#${bl.routeColor.replace("#", "")}33` : "#64748b33",
                          color: bl.routeColor ? `#${bl.routeColor.replace("#", "")}` : "#94a3b8",
                          boxShadow: bl.routeColor ? `0 0 6px #${bl.routeColor.replace("#", "")}22` : "none",
                        }}>
                        {bl.routeShortName}
                      </span>
                    ))}
                    {selectedHubData.busLines.length > 10 && <span className="text-[8px] text-slate-500">+{selectedHubData.busLines.length - 10}</span>}
                  </div>
                </div>
              )}
            </div>
          </Popup>
        )}
      </Map>

      {/* ── Custom popup styles ── */}
      <style>{`
        .intermodal-popup .mapboxgl-popup-content {
          background: transparent !important;
          padding: 0 !important;
          border: none !important;
          box-shadow: none !important;
          border-radius: 16px !important;
        }
        .intermodal-popup .mapboxgl-popup-tip {
          border-top-color: rgba(15,23,42,0.98) !important;
        }
        .intermodal-popup .mapboxgl-popup-close-button {
          color: #94a3b8 !important;
          font-size: 18px !important;
          right: 8px !important;
          top: 8px !important;
          z-index: 10;
        }
        .intermodal-popup .mapboxgl-popup-close-button:hover {
          color: #fff !important;
        }
      `}</style>

      {/* ── Loading overlay ── */}
      <AnimatePresence>
        {loading && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="absolute inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50">
            <div className="bg-slate-900/95 px-6 py-4 rounded-2xl flex items-center gap-3 shadow-2xl border border-cyan-500/30"
              style={{ boxShadow: "0 0 30px rgba(6,182,212,0.2)" }}>
              <Loader2 className="w-5 h-5 animate-spin text-cyan-400" />
              <span className="text-sm text-white">Analisi coincidenze passeggero in corso…</span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Left Panel ── */}
      <div className="absolute top-4 left-4 bottom-4 z-20 pointer-events-none" style={{ width: panelCollapsed ? 48 : 420 }}>
        <motion.div initial={{ x: -20, opacity: 0 }} animate={{ x: 0, opacity: 1 }} className="h-full pointer-events-auto">
          <Card className="h-full bg-slate-900/90 backdrop-blur-2xl border-slate-700/50 shadow-2xl overflow-hidden flex flex-col"
            style={{ boxShadow: "0 0 40px rgba(0,0,0,0.4)" }}>
            {/* Header */}
            <div className="px-4 py-3 border-b border-slate-700/40 flex items-center gap-2 shrink-0">
              {!panelCollapsed && (
                <>
                  <div className="w-7 h-7 rounded-lg bg-cyan-500/20 flex items-center justify-center">
                    <Zap className="w-4 h-4 text-cyan-400" />
                  </div>
                  <span className="text-sm font-bold flex-1 text-white">Intermodale — Esperienza Passeggero</span>
                  <div className="relative">
                    <button onClick={() => setShowInfoTooltip(v => !v)}
                      className="w-5 h-5 rounded-full bg-slate-700/60 hover:bg-cyan-500/30 flex items-center justify-center transition-colors border border-slate-600/40">
                      <HelpCircle className="w-3 h-3 text-slate-400" />
                    </button>
                    <AnimatePresence>
                      {showInfoTooltip && (
                        <motion.div initial={{ opacity: 0, y: -5, scale: 0.95 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -5, scale: 0.95 }}
                          className="absolute right-0 top-7 w-72 z-50 rounded-xl p-3 text-[10px] leading-relaxed text-slate-300 border border-cyan-500/30"
                          style={{ background: "linear-gradient(145deg, rgba(15,23,42,0.98), rgba(30,20,60,0.98))", boxShadow: "0 8px 32px rgba(0,0,0,0.5), 0 0 15px rgba(6,182,212,0.15)" }}>
                          <p className="font-semibold text-cyan-400 mb-1.5 text-[11px]">Come funziona l'analisi?</p>
                          <p className="mb-1.5">Per ogni <strong className="text-white">arrivo</strong> di treno, nave o volo, simuliamo il percorso del passeggero:</p>
                          <ol className="list-decimal list-inside space-y-1 text-slate-400">
                            <li>Il passeggero <strong className="text-white">scende</strong> dal mezzo (treno/nave/aereo)</li>
                            <li><strong className="text-white">Cammina</strong> dalla banchina/terminal alla fermata bus più vicina (a {result?.config.walkSpeedKmh || 4.5} km/h)</li>
                            <li>Verifichiamo se trova un <strong className="text-white">bus entro 60 min</strong></li>
                            <li>Classifichiamo: <span className="text-emerald-400">OK ≤25'</span>, <span className="text-amber-400">attesa lunga</span>, <span className="text-orange-400">appena perso</span>, <span className="text-red-400">nessun bus</span></li>
                          </ol>
                          <p className="mt-1.5 text-slate-500">Raggio fermate: {result?.config.maxWalkKm || 0.5} km · {result?.hubs.length || 0} hub analizzati · Dati GTFS reali</p>
                          <button onClick={() => setShowInfoTooltip(false)} className="absolute top-2 right-2 text-slate-500 hover:text-white transition-colors">
                            <XCircle className="w-3.5 h-3.5" />
                          </button>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                </>
              )}
              <button onClick={() => setPanelCollapsed(v => !v)} className="text-slate-400 hover:text-white transition-colors">
                {panelCollapsed ? <ChevronDown className="w-4 h-4 rotate-[-90deg]" /> : <ChevronUp className="w-4 h-4 rotate-[-90deg]" />}
              </button>
            </div>

            {!panelCollapsed && (
              <CardContent className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
                {/* Sync + Radius + Toggles */}
                <div className="space-y-2">
                  {/* Sync button */}
                  <div className="flex items-center gap-2 bg-slate-800/60 rounded-lg px-3 py-2 border border-slate-700/40">
                    <RefreshCw className={`w-3.5 h-3.5 text-cyan-400 shrink-0 ${syncing ? "animate-spin" : ""}`} />
                    <div className="flex-1 min-w-0">
                      <p className="text-[10px] text-slate-300 font-medium">Orari treni/navi</p>
                      {lastSync && (
                        <p className="text-[8px] text-slate-500 truncate">
                          Ultimo sync: {new Date(lastSync).toLocaleString("it-IT", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
                        </p>
                      )}
                    </div>
                    <button onClick={syncSchedules} disabled={syncing}
                      className="text-[9px] bg-cyan-500/20 text-cyan-400 px-3 py-1.5 rounded-lg hover:bg-cyan-500/30 transition-all font-semibold border border-cyan-500/30 disabled:opacity-50"
                      style={{ boxShadow: "0 0 8px rgba(6,182,212,0.15)" }}>
                      {syncing ? "Sync…" : "Sincronizza"}
                    </button>
                  </div>

                  {/* Radius */}
                  <div className="flex items-center gap-2">
                    <Footprints className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                    <label className="text-[10px] text-slate-400 whitespace-nowrap">Raggio:</label>
                    <input type="range" min={0.2} max={1.5} step={0.1} value={radius}
                      onChange={e => setRadius(+e.target.value)} className="flex-1 h-1 accent-cyan-500" />
                    <span className="text-[10px] font-mono font-semibold w-10 text-right text-white">{radius} km</span>
                    <button onClick={runAnalysis}
                      className="text-[9px] bg-cyan-500/20 text-cyan-400 px-2 py-1 rounded hover:bg-cyan-500/30 transition-colors font-semibold">
                      Aggiorna
                    </button>
                  </div>

                  {/* Layer toggles */}
                  <div className="flex gap-2">
                    <button onClick={() => setShowRoutes(v => !v)}
                      className={`text-[9px] px-2 py-1 rounded-lg flex items-center gap-1 font-medium transition-all border ${
                        showRoutes ? "bg-cyan-500/20 text-cyan-400 border-cyan-500/30" : "bg-slate-800/40 text-slate-500 border-slate-700/30"
                      }`}>
                      {showRoutes ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
                      Percorsi ({shapesGeoJSON?.total || 0})
                    </button>
                    <button onClick={() => setShowPois(v => !v)}
                      className={`text-[9px] px-2 py-1 rounded-lg flex items-center gap-1 font-medium transition-all border ${
                        showPois ? "bg-violet-500/20 text-violet-400 border-violet-500/30" : "bg-slate-800/40 text-slate-500 border-slate-700/30"
                      }`}>
                      {showPois ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
                      POI ({hubPoisData.reduce((s, h) => s + h.pois.length, 0)})
                    </button>
                  </div>
                </div>

                {result && (
                  <>
                    {/* ── HEADLINE ── */}
                    <div className="rounded-xl p-3 border border-cyan-500/20"
                      style={{ background: "linear-gradient(135deg, rgba(6,182,212,0.1), rgba(139,92,246,0.08))" }}>
                      <p className="text-[10px] font-semibold text-cyan-400 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                        <Users className="w-3 h-3" /> Scendo dal treno/nave: trovo il bus?
                      </p>
                      <div className="grid grid-cols-5 gap-1.5 text-center">
                        {[
                          { value: result.summary.totalArrivals, label: "Arrivi", bg: "bg-slate-800/60", border: "border-slate-700/30", color: "text-white" },
                          { value: result.summary.arrivalOk, label: "OK ≤25'", bg: "", border: "", color: "text-emerald-400", bgStyle: "rgba(34,197,94,0.1)", borderStyle: "rgba(34,197,94,0.2)" },
                          { value: result.summary.arrivalLongWait, label: "Lunga att.", bg: "", border: "", color: "text-amber-400", bgStyle: "rgba(234,179,8,0.1)", borderStyle: "rgba(234,179,8,0.2)" },
                          { value: result.summary.arrivalJustMissed, label: "Perso", bg: "", border: "", color: "text-orange-400", bgStyle: "rgba(249,115,22,0.1)", borderStyle: "rgba(249,115,22,0.2)" },
                          { value: result.summary.arrivalNoBus, label: "No bus", bg: "", border: "", color: "text-red-400", bgStyle: "rgba(239,68,68,0.1)", borderStyle: "rgba(239,68,68,0.2)" },
                        ].map((item, idx) => (
                          <div key={idx} className={`rounded-lg p-1.5 border ${item.bg} ${item.border}`}
                            style={item.bgStyle ? { backgroundColor: item.bgStyle, borderColor: item.borderStyle } : undefined}>
                            <p className={`text-lg font-bold ${item.color}`}>{item.value}</p>
                            <p className="text-[7px] text-slate-400">{item.label}</p>
                          </div>
                        ))}
                      </div>

                      <div className="flex items-center gap-4 mt-2">
                        {result.summary.avgWaitAtStop !== null && (
                          <div className="flex items-center gap-1 text-[10px] text-slate-400">
                            <Clock className="w-3 h-3 text-amber-400" />
                            Attesa media: <span className="font-bold text-white">{result.summary.avgWaitAtStop} min</span>
                          </div>
                        )}
                        {result.summary.avgTotalTransfer !== null && (
                          <div className="flex items-center gap-1 text-[10px] text-slate-400">
                            <Timer className="w-3 h-3 text-cyan-400" />
                            Trasf. totale: <span className="font-bold text-white">{result.summary.avgTotalTransfer} min</span>
                          </div>
                        )}
                      </div>

                      {/* Coverage bar */}
                      <div className="mt-2">
                        <div className="flex items-center justify-between text-[9px] text-slate-400 mb-1">
                          <span>Copertura arrivi</span>
                          <span className={`font-bold ${
                            result.summary.arrivalCoveragePercent >= 80 ? "text-emerald-400" : result.summary.arrivalCoveragePercent >= 50 ? "text-amber-400" : "text-red-400"
                          }`}>{result.summary.arrivalCoveragePercent}%</span>
                        </div>
                        <div className="h-2 bg-slate-800/60 rounded-full overflow-hidden">
                          <div className="h-full rounded-full transition-all duration-700"
                            style={{
                              width: `${result.summary.arrivalCoveragePercent}%`,
                              background: result.summary.arrivalCoveragePercent >= 80 ? "linear-gradient(90deg, #22c55e, #10b981)"
                                : result.summary.arrivalCoveragePercent >= 50 ? "linear-gradient(90deg, #eab308, #f59e0b)" : "linear-gradient(90deg, #ef4444, #f87171)",
                              boxShadow: `0 0 8px ${result.summary.arrivalCoveragePercent >= 80 ? "#22c55e44" : result.summary.arrivalCoveragePercent >= 50 ? "#eab30844" : "#ef444444"}`,
                            }} />
                        </div>
                      </div>
                    </div>

                    {/* Donut + bar */}
                    <div className="grid grid-cols-2 gap-2">
                      {arrivalStatusData.length > 0 && (
                        <div>
                          <p className="text-[9px] font-semibold text-slate-400 uppercase tracking-wide mb-1 text-center">Stato coincidenze</p>
                          <div className="h-28">
                            <ResponsiveContainer width="100%" height="100%">
                              <PieChart>
                                <Pie data={arrivalStatusData} dataKey="value" cx="50%" cy="50%" innerRadius={25} outerRadius={45} paddingAngle={2} strokeWidth={0}>
                                  {arrivalStatusData.map((d, i) => <Cell key={i} fill={d.color} />)}
                                </Pie>
                                <ReTooltip contentStyle={{ background: "#0f172a", border: "1px solid #334155", borderRadius: 8, fontSize: 10, color: "#e2e8f0" }} />
                              </PieChart>
                            </ResponsiveContainer>
                          </div>
                          <div className="flex flex-wrap gap-x-2 gap-y-0.5 justify-center">
                            {arrivalStatusData.map(d => (
                              <span key={d.name} className="text-[7px] text-slate-500 flex items-center gap-0.5">
                                <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: d.color }} />{d.name}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                      {hubArrivalChartData.length > 0 && (
                        <div>
                          <p className="text-[9px] font-semibold text-slate-400 uppercase tracking-wide mb-1 text-center">Per hub</p>
                          <div className="h-28">
                            <ResponsiveContainer width="100%" height="100%">
                              <BarChart data={hubArrivalChartData} layout="vertical" margin={{ left: 2, right: 2 }}>
                                <XAxis type="number" tick={{ fill: "#64748b", fontSize: 8 }} />
                                <YAxis type="category" dataKey="name" tick={{ fill: "#94a3b8", fontSize: 8 }} width={55} />
                                <ReTooltip contentStyle={{ background: "#0f172a", border: "1px solid #334155", borderRadius: 8, fontSize: 9, color: "#e2e8f0" }} />
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
                      <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">Dettaglio per Hub</p>
                      {result.hubs.map(hc => {
                        const isExpanded = expandedHub === hc.hub.id;
                        const arrPct = hc.arrivalStats.totalArrivals > 0 ? Math.round((hc.arrivalStats.ok / hc.arrivalStats.totalArrivals) * 100) : 0;
                        return (
                          <div key={hc.hub.id}
                            className={`rounded-xl border transition-all cursor-pointer ${selectedHub === hc.hub.id ? "ring-1 ring-cyan-500/50" : ""} ${hc.isServed ? "bg-slate-800/40 border-slate-700/30" : "bg-red-500/5 border-red-500/30"}`}
                            onClick={() => { setSelectedHub(hc.hub.id); setExpandedHub(isExpanded ? null : hc.hub.id); mapRef.current?.flyTo({ center: [hc.hub.lng, hc.hub.lat], zoom: 14, duration: 1000 }); }}>
                            <div className="p-2.5 flex items-center gap-2">
                              <div className="w-7 h-7 rounded-lg flex items-center justify-center" style={{ backgroundColor: HUB_COLORS[hc.hub.type] + "22", color: HUB_COLORS[hc.hub.type] }}>
                                {hubIcon(hc.hub.type, "w-4 h-4")}
                              </div>
                              <span className="text-[11px] font-bold flex-1 truncate text-white">{hc.hub.name}</span>
                              <div className="flex items-center gap-1 shrink-0">
                                {hc.arrivalStats.ok > 0 && <span className="text-[8px] bg-emerald-500/20 text-emerald-400 px-1 py-0.5 rounded font-semibold">✓{hc.arrivalStats.ok}</span>}
                                {(hc.arrivalStats.noBus + hc.arrivalStats.justMissed) > 0 && <span className="text-[8px] bg-red-500/20 text-red-400 px-1 py-0.5 rounded font-semibold">✗{hc.arrivalStats.noBus + hc.arrivalStats.justMissed}</span>}
                                <span className="text-[9px] font-mono font-bold text-slate-400">{arrPct}%</span>
                              </div>
                              {isExpanded ? <ChevronUp className="w-3 h-3 text-slate-500" /> : <ChevronDown className="w-3 h-3 text-slate-500" />}
                            </div>

                            <AnimatePresence>
                              {isExpanded && (
                                <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
                                  <div className="px-2.5 pb-3 space-y-2.5 border-t border-slate-700/20 pt-2">
                                    <div className="flex items-center gap-3 text-[9px] text-slate-400">
                                      <span className="flex items-center gap-1"><Footprints className="w-3 h-3 text-cyan-400" /> Piattaforma → uscita: {hc.hub.platformWalkMinutes} min</span>
                                      {hc.nearbyStops.length > 0 && <span className="flex items-center gap-1"><MapPin className="w-3 h-3 text-amber-400" /> Fermata più vicina: {hc.nearbyStops[0].walkMin} min tot.</span>}
                                    </div>

                                    {/* Tabs */}
                                    <div className="flex gap-1 border-b border-slate-700/30 pb-1">
                                      {(["arrivi", "partenze", "destinazioni"] as const).map(tab => (
                                        <button key={tab} onClick={e => { e.stopPropagation(); setActiveTab(tab); }}
                                          className={`text-[9px] px-2 py-1 rounded-t font-semibold transition-colors ${activeTab === tab ? "bg-cyan-500/20 text-cyan-400 border-b-2 border-cyan-500" : "text-slate-500 hover:text-slate-300"}`}>
                                          {tab === "arrivi" ? `🚉 Arrivi (${hc.arrivalConnections.length})` : tab === "partenze" ? `🚌 Partenze (${hc.departureConnections.length})` : `📍 Dest. (${hc.destinationCoverage.length})`}
                                        </button>
                                      ))}
                                    </div>

                                    {/* TAB: Arrivi */}
                                    {activeTab === "arrivi" && (
                                      <div className="space-y-1.5">
                                        {hc.arrivalConnections.length === 0 ? <p className="text-[10px] text-slate-500 italic">Nessun arrivo configurato</p> : (
                                          <>
                                            {hc.waitDistribution && (
                                              <div>
                                                <p className="text-[8px] text-slate-500 font-semibold mb-1">Distribuzione attesa alla fermata:</p>
                                                <div className="h-16">
                                                  <ResponsiveContainer width="100%" height="100%">
                                                    <BarChart data={hc.waitDistribution} margin={{ left: 0, right: 0 }}>
                                                      <XAxis dataKey="range" tick={{ fill: "#64748b", fontSize: 7 }} interval={0} angle={-30} textAnchor="end" height={25} />
                                                      <YAxis tick={{ fill: "#64748b", fontSize: 7 }} width={15} />
                                                      <Bar dataKey="count" barSize={14} radius={[2, 2, 0, 0]}>
                                                        {hc.waitDistribution.map((_d, i) => <Cell key={i} fill={i <= 2 ? "#22c55e" : i <= 3 ? "#eab308" : i <= 4 ? "#f97316" : "#ef4444"} />)}
                                                      </Bar>
                                                    </BarChart>
                                                  </ResponsiveContainer>
                                                </div>
                                              </div>
                                            )}
                                            <div className="space-y-1 max-h-48 overflow-y-auto">
                                              {hc.arrivalConnections.map((ac, i) => {
                                                const cfg = STATUS_CONFIG[ac.status];
                                                return (
                                                  <div key={i} className={`text-[9px] px-2 py-1.5 rounded-lg border ${cfg.bg} ${cfg.border}`}>
                                                    <div className="flex items-center gap-1.5">
                                                      <span className={cfg.color}>{cfg.icon}</span>
                                                      <span className="font-semibold text-white">{ac.arrivalTime}</span>
                                                      <span className="text-slate-400">da {ac.origin}</span>
                                                      <span className="ml-auto text-[8px] text-slate-500 flex items-center gap-0.5"><Footprints className="w-2.5 h-2.5" />{ac.walkMin}min</span>
                                                    </div>
                                                    {ac.firstBus ? (
                                                      <div className="mt-0.5 flex items-center gap-1 text-slate-400">
                                                        <ArrowRight className="w-2.5 h-2.5" /> Fermata {ac.atBusStopTime} → Bus <span className="text-amber-300 font-semibold">[{ac.firstBus.routeShortName}]</span> {ac.firstBus.departureTime}
                                                        <span className={`ml-1 ${ac.firstBus.waitMin > 25 ? "text-amber-400" : "text-emerald-400"}`}>({ac.firstBus.waitMin}min)</span>
                                                        {ac.firstBus.destination && <span className="text-[8px] ml-1 text-slate-500">→ {ac.firstBus.destination}</span>}
                                                      </div>
                                                    ) : ac.justMissed.length > 0 ? (
                                                      <div className="mt-0.5 text-orange-400">⚠ Fermata {ac.atBusStopTime} — bus [{ac.justMissed[0].routeShortName}] partito {ac.justMissed[0].missedByMin}min prima!</div>
                                                    ) : (
                                                      <div className="mt-0.5 text-red-400">✗ Fermata {ac.atBusStopTime} — nessun bus entro 60min</div>
                                                    )}
                                                    {ac.allBusOptions.length > 1 && (
                                                      <div className="mt-0.5 text-[8px] text-slate-500">Altre: {ac.allBusOptions.slice(1, 4).map(o => `[${o.routeShortName}] ${o.departureTime} (${o.waitMin}')`).join(" · ")}</div>
                                                    )}
                                                  </div>
                                                );
                                              })}
                                            </div>
                                          </>
                                        )}
                                      </div>
                                    )}

                                    {/* TAB: Partenze */}
                                    {activeTab === "partenze" && (
                                      <div className="space-y-1 max-h-48 overflow-y-auto">
                                        {hc.departureConnections.length === 0 ? <p className="text-[10px] text-slate-500 italic">Nessuna partenza configurata</p> : hc.departureConnections.map((dc, i) => (
                                          <div key={i} className={`text-[9px] px-2 py-1 rounded ${dc.bestBusArrival ? "bg-emerald-500/5 border border-emerald-500/15" : "bg-red-500/5 border border-red-500/15"}`}>
                                            <span className="font-semibold text-white">{dc.departureTime}</span>
                                            <span className="text-slate-400"> → {dc.destination}</span>
                                            {dc.bestBusArrival ? <span className="text-emerald-400 ml-1">Bus [{dc.bestBusRoute}] {dc.bestBusArrival} ({dc.waitMinutes}min)</span>
                                              : <span className="text-red-400 ml-1">Nessun bus {dc.missedBy !== null && `(mancato ${dc.missedBy}min)`}</span>}
                                          </div>
                                        ))}
                                      </div>
                                    )}

                                    {/* TAB: Destinazioni */}
                                    {activeTab === "destinazioni" && (
                                      <div className="space-y-1 max-h-48 overflow-y-auto">
                                        {hc.destinationCoverage.length === 0 ? <p className="text-[10px] text-slate-500 italic">Nessuna destinazione</p> : hc.destinationCoverage.map((dc, i) => (
                                          <div key={i} className="text-[9px] px-2 py-1 rounded bg-slate-800/40 border border-slate-700/20 flex items-center gap-2">
                                            <MapPinned className="w-3 h-3 text-cyan-400 shrink-0" />
                                            <div className="flex-1 min-w-0">
                                              <span className="font-semibold text-white truncate block">{dc.destination}</span>
                                              <span className="text-slate-400">[{dc.routeShortName}] {dc.tripsPerDay} corse · {dc.firstDeparture}–{dc.lastDeparture}{dc.avgFrequencyMin && ` · ogni ~${dc.avgFrequencyMin}'`}</span>
                                            </div>
                                          </div>
                                        ))}
                                      </div>
                                    )}

                                    {/* Bus lines */}
                                    {hc.busLines.length > 0 && (
                                      <div>
                                        <p className="text-[9px] text-slate-500 font-semibold mb-1">{hc.busLines.length} linee bus:</p>
                                        <div className="flex flex-wrap gap-1">
                                          {hc.busLines.slice(0, 12).map(bl => (
                                            <span key={bl.routeId} className="text-[8px] px-1.5 py-0.5 rounded font-semibold"
                                              style={{
                                                backgroundColor: bl.routeColor ? `#${bl.routeColor.replace("#", "")}22` : "#64748b22",
                                                color: bl.routeColor ? `#${bl.routeColor.replace("#", "")}` : "#94a3b8",
                                              }}>{bl.routeShortName} <span className="opacity-60">({bl.tripsCount})</span></span>
                                          ))}
                                          {hc.busLines.length > 12 && <span className="text-[8px] text-slate-500">+{hc.busLines.length - 12}</span>}
                                        </div>
                                      </div>
                                    )}

                                    {/* Hourly heatmap */}
                                    <div>
                                      <p className="text-[9px] text-slate-500 font-semibold mb-1">Copertura oraria (bus vs arrivi {hubTransportLabel(hc.hub.type)})</p>
                                      <div className="flex gap-px">
                                        {hc.gapAnalysis.map(g => {
                                          const busColor = g.busDepartures > 3 ? "#22c55e" : g.busDepartures > 0 ? "#eab308" : "#1e293b";
                                          return (
                                            <div key={g.hour} className="flex-1 relative" title={`${g.hour}:00 — Bus: ${g.busDepartures}, Arrivi: ${g.hubArrivals}`}>
                                              <div className="h-3 rounded-sm" style={{ backgroundColor: busColor }}>
                                                {g.hubArrivals > 0 && <div className="absolute -top-1 left-1/2 -translate-x-1/2 w-1.5 h-1.5 rounded-full bg-orange-400 border border-slate-900" />}
                                                {g.hubDepartures > 0 && <div className="absolute -bottom-1 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-cyan-400 border border-slate-900" />}
                                              </div>
                                              {g.hour % 3 === 0 && <p className="text-[7px] text-slate-500 text-center mt-1">{g.hour}</p>}
                                            </div>
                                          );
                                        })}
                                      </div>
                                      <div className="flex items-center gap-2 mt-1 text-[7px] text-slate-500">
                                        <span className="flex items-center gap-0.5"><span className="w-2 h-2 rounded-sm bg-emerald-500" /> &gt;3</span>
                                        <span className="flex items-center gap-0.5"><span className="w-2 h-2 rounded-sm bg-amber-500" /> 1-3</span>
                                        <span className="flex items-center gap-0.5"><span className="w-2 h-2 rounded-sm bg-slate-800" /> 0</span>
                                        <span className="flex items-center gap-0.5"><span className="w-1.5 h-1.5 rounded-full bg-orange-400" /> Arr</span>
                                        <span className="flex items-center gap-0.5"><span className="w-1 h-1 rounded-full bg-cyan-400" /> Part</span>
                                      </div>
                                    </div>

                                    {/* Nearby stops */}
                                    {hc.nearbyStops.length > 0 && (
                                      <div className="text-[9px] text-slate-400">
                                        <span className="font-semibold text-slate-300">{hc.nearbyStops.length} fermate</span> entro {result.config.maxWalkKm} km
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
                        <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide flex items-center gap-1">
                          <Lightbulb className="w-3 h-3 text-amber-400" /> Criticità ({result.suggestions.length})
                        </p>
                        {result.suggestions.map((sug, i) => {
                          const pc = PRIORITY_COLORS[sug.priority] || PRIORITY_COLORS.low;
                          return (
                            <div key={i} className={`text-[10px] px-3 py-2 rounded-lg border ${pc.bg} ${pc.border} ${pc.text}`}>
                              <div className="flex items-start gap-1.5">
                                <span className="text-[8px] font-bold uppercase opacity-70 shrink-0 mt-0.5">[{pc.label}]</span>
                                <div>
                                  <p>{sug.description}</p>
                                  {sug.details && <p className="text-[9px] opacity-70 mt-0.5">{sug.details}</p>}
                                  {sug.suggestedTimes && sug.suggestedTimes.length > 0 && (
                                    <p className="mt-1 text-[9px] opacity-80"><Clock className="w-3 h-3 inline mr-0.5" /> Bus suggeriti: {sug.suggestedTimes.join(", ")}</p>
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
                          className="w-full text-left text-[10px] font-semibold text-slate-400 uppercase tracking-wide flex items-center gap-1 hover:text-white transition-colors">
                          <Timer className="w-3 h-3 text-violet-400" /> Programma proposto ({result.proposedSchedule.length})
                          {showSchedule ? <ChevronUp className="w-3 h-3 ml-auto" /> : <ChevronDown className="w-3 h-3 ml-auto" />}
                        </button>
                        <AnimatePresence>
                          {showSchedule && (
                            <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
                              <div className="text-[9px] space-y-0.5 max-h-56 overflow-y-auto">
                                <div className="grid grid-cols-[45px_55px_55px_1fr_1fr] gap-1 text-[8px] text-slate-500 font-semibold pb-0.5 border-b border-slate-700/30 sticky top-0 bg-slate-900/95">
                                  <span>Azione</span><span>Orario</span><span>Hub</span><span>Motivo</span><span>Impatto</span>
                                </div>
                                {result.proposedSchedule.slice(0, 30).map((p, i) => {
                                  const actionIcon = p.action === "add" ? <PlusCircle className="w-3 h-3 text-emerald-400 inline" />
                                    : p.action === "shift" ? <ArrowRightLeft className="w-3 h-3 text-amber-400 inline" />
                                    : <Route className="w-3 h-3 text-blue-400 inline" />;
                                  return (
                                    <div key={i} className="grid grid-cols-[45px_55px_55px_1fr_1fr] gap-1 py-0.5 items-start text-slate-300">
                                      <span className="flex items-center gap-0.5">{actionIcon} {p.action === "add" ? "Nuova" : p.action === "shift" ? "Sposta" : "Estendi"}</span>
                                      <span className="font-mono font-semibold">{p.currentTime && <><span className="line-through text-slate-500">{p.currentTime}</span>→</>}{p.proposedTime}</span>
                                      <span className="truncate text-slate-500">{shortHubName(p.hubName)}</span>
                                      <span className="text-slate-400">{p.reason}</span>
                                      <span className="text-cyan-400/70">{p.impact}</span>
                                    </div>
                                  );
                                })}
                              </div>
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

      {/* ── Map style controls — bottom right ── */}
      <div className="absolute bottom-6 right-4 flex flex-col gap-2 pointer-events-auto z-10">
        <div className="bg-slate-900/90 backdrop-blur-xl border border-slate-700/50 shadow-xl rounded-xl p-1 flex gap-1"
          style={{ boxShadow: "0 0 20px rgba(0,0,0,0.3)" }}>
          {([
            { key: "neon" as ViewMode, icon: <Zap className="w-3.5 h-3.5" />, label: "Neon" },
            { key: "midnight" as ViewMode, icon: <Moon className="w-3.5 h-3.5" />, label: "Midnight" },
            { key: "blueprint" as ViewMode, icon: <Building2 className="w-3.5 h-3.5" />, label: "Blueprint" },
            { key: "satellite" as ViewMode, icon: <Satellite className="w-3.5 h-3.5" />, label: "Sat" },
          ]).map(({ key, icon, label }) => (
            <button key={key} title={label} onClick={() => setViewMode(key)}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all ${
                viewMode === key ? "bg-cyan-500/20 text-cyan-400 shadow-sm border border-cyan-500/30" : "text-slate-500 hover:text-slate-300 hover:bg-slate-800/60 border border-transparent"
              }`}>
              {icon}<span className="hidden sm:inline">{label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* ── Legend — top right ── */}
      <div className="absolute top-4 right-4 z-10 pointer-events-auto">
        <Card className="bg-slate-900/90 backdrop-blur-xl border-slate-700/50 shadow-xl" style={{ boxShadow: "0 0 20px rgba(0,0,0,0.3)" }}>
          <CardContent className="p-3 space-y-2">
            <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">Legenda</p>
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <div className="w-6 h-6 rounded-full flex items-center justify-center" style={{ backgroundColor: "#06b6d4cc", boxShadow: "0 0 8px #06b6d444" }}>
                  <TrainFront className="w-3 h-3 text-white" />
                </div>
                <span className="text-[10px] text-slate-400">Stazione ferroviaria</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-6 h-6 rounded-full flex items-center justify-center" style={{ backgroundColor: "#8b5cf6cc", boxShadow: "0 0 8px #8b5cf644" }}>
                  <Ship className="w-3 h-3 text-white" />
                </div>
                <span className="text-[10px] text-slate-400">Terminal portuale</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-6 h-6 rounded-full flex items-center justify-center" style={{ backgroundColor: "#f59e0bcc", boxShadow: "0 0 8px #f59e0b44" }}>
                  <Plane className="w-3 h-3 text-white" />
                </div>
                <span className="text-[10px] text-slate-400">Aeroporto</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full bg-amber-400 border border-black/30" />
                <span className="text-[10px] text-slate-400">Fermata bus</span>
              </div>
              {showRoutes && (
                <div className="flex items-center gap-2">
                  <div className="w-5 h-0.5 rounded bg-cyan-400" style={{ boxShadow: "0 0 6px #06b6d4" }} />
                  <span className="text-[10px] text-slate-400">Percorso bus</span>
                </div>
              )}
              {showPois && (
                <>
                  <div className="flex items-center gap-2">
                    <Briefcase className="w-3.5 h-3.5 text-blue-400" />
                    <span className="text-[10px] text-slate-400">POI lavoro (treno)</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Palmtree className="w-3.5 h-3.5 text-violet-400" />
                    <span className="text-[10px] text-slate-400">POI turismo (porto)</span>
                  </div>
                </>
              )}
              <div className="pt-1 border-t border-slate-700/30 flex flex-wrap gap-1.5">
                <div className="flex items-center gap-1"><div className="w-4 h-4 rounded-full border-2 border-emerald-400 bg-transparent" /><span className="text-[9px] text-slate-500">≥70%</span></div>
                <div className="flex items-center gap-1"><div className="w-4 h-4 rounded-full border-2 border-amber-400 bg-transparent" /><span className="text-[9px] text-slate-500">40-70%</span></div>
                <div className="flex items-center gap-1"><div className="w-4 h-4 rounded-full border-2 border-red-500 bg-transparent" /><span className="text-[9px] text-slate-500">&lt;40%</span></div>
              </div>
            </div>
            <div className="pt-1 border-t border-slate-700/20">
              <p className="text-[8px] text-slate-500">Velocità cammino: {result?.config.walkSpeedKmh || 4.5} km/h · Attesa max: 60 min</p>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
