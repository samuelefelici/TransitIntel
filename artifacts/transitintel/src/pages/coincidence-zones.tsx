/**
 * COINCIDENCE ZONES — Zone di coincidenza
 *
 * 5 tipi:
 * 1. railway  — Stazione ferroviaria
 * 2. port     — Terminal portuale
 * 3. bus-bus  — Bus↔Bus
 * 4. park-ride — Park & Ride
 * 5. airport  — Aeroporto
 *
 * Creazione manuale: seleziona tipo (icona), posiziona centro sulla mappa,
 * seleziona fermate (con colore del tipo), salva.
 */
import React, { useState, useMemo, useCallback, useRef, useEffect } from "react";
import MapGL, { Source, Layer, Marker, MapRef } from "react-map-gl/mapbox";
import { motion, AnimatePresence } from "framer-motion";
import {
  MapPin, Plus, Trash2, Edit3, Save, X, TrainFront, Ship,
  AlertTriangle, Loader2, ChevronRight, ChevronDown,
  Settings2, Zap, Clock, ArrowRight, RefreshCw, Eye, EyeOff,
  Footprints, Bus, Pencil, Car, Plane,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { getApiBase } from "@/lib/api";

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN || "";
const BASE = () => getApiBase();

const ZONE_COLORS = [
  "#06b6d4", "#8b5cf6", "#f59e0b", "#22c55e", "#ef4444",
  "#ec4899", "#3b82f6", "#14b8a6", "#f97316", "#6366f1",
];

const HUB_COLORS: Record<string, string> = {
  railway: "#06b6d4",
  port: "#8b5cf6",
  "bus-bus": "#f59e0b",
  "park-ride": "#22c55e",
  airport: "#f97316",
};

const HUB_LABELS: Record<string, string> = {
  railway: "Stazione",
  port: "Porto",
  "bus-bus": "Bus↔Bus",
  "park-ride": "P+R",
  airport: "Aeroporto",
};

// All hub types for the selector
const ALL_HUB_TYPES = ["railway", "port", "bus-bus", "park-ride", "airport"] as const;
type HubType = (typeof ALL_HUB_TYPES)[number];

// ─── Point-in-polygon (ray casting) ────────────────────────
function pointInPolygon(x: number, y: number, polygon: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

// ─── Types ──────────────────────────────────────────────────
interface GtfsStop {
  stopId: string;
  stopName: string;
  stopLat: number;
  stopLon: number;
  routes?: string[];
}

interface ZoneStop {
  id: string;
  gtfsStopId: string;
  stopName: string;
  stopLat: number;
  stopLon: number;
  distanceKm: number | null;
  walkMinFromHub: number | null;
}

interface ZoneData {
  id: string;
  name: string;
  hubId: string;
  hubName: string;
  hubType: string;
  hubLat: number;
  hubLng: number;
  walkMinutes: number;
  radiusKm: number;
  color: string;
  notes: string | null;
  stops: ZoneStop[];
}

interface HubData {
  id: string;
  name: string;
  type: string;
  lat: number;
  lng: number;
  description: string;
  platformWalkMinutes: number;
  totalArrivals: number;
  totalDepartures: number;
  arrivals: { origin: string; times: string[] }[];
  departures: { destination: string; times: string[] }[];
  nearbyStops: { stopId: string; stopName: string; lat: number; lng: number; distKm: number; walkMin: number }[];
}

interface BusLine {
  routeId: string;
  routeShortName: string;
  routeLongName: string;
  routeColor: string | null;
  tripsCount: number;
}

async function apiFetch<T = any>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE()}${path}`, {
    ...opts,
    headers: { "Content-Type": "application/json", ...opts?.headers },
  });
  if (!res.ok) throw new Error(`API error ${res.status}`);
  if (res.status === 204 || res.headers.get("content-length") === "0") return {} as T;
  return res.json();
}

function hubIcon(type: string, className = "w-5 h-5") {
  switch (type) {
    case "port": return <Ship className={className} />;
    case "bus-bus": return <Bus className={className} />;
    case "park-ride": return <Car className={className} />;
    case "airport": return <Plane className={className} />;
    default: return <TrainFront className={className} />;
  }
}

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

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─── Component ──────────────────────────────────────────────
export default function CoincidenceZonesPage() {
  const mapRef = useRef<MapRef>(null);

  // Data
  const [zones, setZones] = useState<ZoneData[]>([]);
  const [hubs, setHubs] = useState<HubData[]>([]);
  const [allStops, setAllStops] = useState<GtfsStop[]>([]);
  const [loading, setLoading] = useState(true);
  const [autoCreating, setAutoCreating] = useState(false);

  // UI
  const [expandedZone, setExpandedZone] = useState<string | null>(null);
  const [selectedZone, setSelectedZone] = useState<string | null>(null);
  const [showHubCircles, setShowHubCircles] = useState(true);
  const [scheduleTab, setScheduleTab] = useState<"arrivals" | "departures">("arrivals");

  // Drawing polygon state
  const [drawMode, setDrawMode] = useState(false);
  const [polygonPoints, setPolygonPoints] = useState<[number, number][]>([]);
  const [hoveredPoint, setHoveredPoint] = useState<[number, number] | null>(null);

  // Editing / creating
  const [editingZone, setEditingZone] = useState<ZoneData | null>(null);
  const [creatingNew, setCreatingNew] = useState(false);
  const [selectedHub, setSelectedHub] = useState<HubData | null>(null);
  const [zoneName, setZoneName] = useState("");
  const [zoneColor, setZoneColor] = useState(ZONE_COLORS[0]);
  const [zoneNotes, setZoneNotes] = useState("");
  const [selectedStops, setSelectedStops] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  // Schedules editor (orari arrivi/partenze custom per zona)
  const [schedulesEditorZone, setSchedulesEditorZone] = useState<ZoneData | null>(null);

  // NEW: selected hub type for new zone creation
  const [selectedHubType, setSelectedHubType] = useState<HubType>("railway");
  // NEW: center point placed on map for new zone
  const [newZoneCenter, setNewZoneCenter] = useState<{ lat: number; lng: number } | null>(null);
  // NEW: mode to place center on map
  const [placingCenter, setPlacingCenter] = useState(false);

  // Bus lines for selected zone
  const [busLines, setBusLines] = useState<BusLine[]>([]);
  const [loadingBusLines, setLoadingBusLines] = useState(false);

  // Confirm delete dialog
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const confirmDeleteZone = zones.find(z => z.id === confirmDeleteId);

  // Filter by type
  const [typeFilter, setTypeFilter] = useState<string | null>(null);

  const isEditing = editingZone !== null || creatingNew;

  // The effective "editing color" — use the hub type color when creating new
  const editColor = useMemo(() => {
    if (creatingNew) return HUB_COLORS[selectedHubType] || "#94a3b8";
    if (editingZone) return HUB_COLORS[editingZone.hubType] || zoneColor;
    return zoneColor;
  }, [creatingNew, selectedHubType, editingZone, zoneColor]);

  // ── Load data ──
  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [zonesRes, hubsRes, stopsRes] = await Promise.all([
        apiFetch<{ data: ZoneData[] }>("/api/coincidence-zones"),
        apiFetch<{ hubs: HubData[] }>("/api/coincidence-zones/hubs?radius=0.1"),
        apiFetch<{ data: GtfsStop[] }>("/api/gtfs/stops/all"),
      ]);
      setZones(zonesRes.data || []);
      setHubs(hubsRes.hubs || []);
      setAllStops(stopsRes.data || []);
    } catch (err) {
      console.error("Failed to load data:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  // ── Load bus lines when zone selected ──
  useEffect(() => {
    if (!selectedZone) { setBusLines([]); return; }
    let cancelled = false;
    setLoadingBusLines(true);
    apiFetch<{ busLines: BusLine[] }>(`/api/coincidence-zones/${selectedZone}/bus-lines`)
      .then(res => { if (!cancelled) setBusLines(res.busLines || []); })
      .catch(() => { if (!cancelled) setBusLines([]); })
      .finally(() => { if (!cancelled) setLoadingBusLines(false); });
    return () => { cancelled = true; };
  }, [selectedZone]);

  // ── Auto-create zones ──
  const autoCreate = useCallback(async () => {
    setAutoCreating(true);
    try {
      const result = await apiFetch<{ created: number; zones: ZoneData[] }>("/api/coincidence-zones/auto-create", {
        method: "POST",
        body: JSON.stringify({ radiusKm: 0.1 }),
      });
      console.log(`Auto-created ${result.created} zones`);
      await loadData();
    } catch (err) {
      console.error("Auto-create failed:", err);
    } finally {
      setAutoCreating(false);
    }
  }, [loadData]);

  // ── Delete zone ──
  const deleteZone = useCallback(async (id: string) => {
    try {
      await apiFetch(`/api/coincidence-zones/${id}`, { method: "DELETE" });
      setZones(prev => prev.filter(z => z.id !== id));
      if (selectedZone === id) setSelectedZone(null);
    } catch (err) {
      console.error("Delete failed:", err);
    }
  }, [selectedZone]);

  // ── Start new zone ──
  const startNewZone = useCallback(() => {
    setCreatingNew(true);
    setEditingZone(null);
    setSelectedHub(null);
    setZoneName("");
    setZoneColor(ZONE_COLORS[zones.length % ZONE_COLORS.length]);
    setZoneNotes("");
    setSelectedStops(new Set());
    setPolygonPoints([]);
    setHoveredPoint(null);
    setDrawMode(false);
    setSelectedHubType("railway");
    setNewZoneCenter(null);
    setPlacingCenter(true); // start in "place center" mode
  }, [zones.length]);

  // ── Edit existing zone ──
  const startEdit = useCallback((zone: ZoneData) => {
    setEditingZone(zone);
    setCreatingNew(false);
    setZoneName(zone.name);
    setZoneColor(zone.color);
    setZoneNotes(zone.notes || "");
    setSelectedStops(new Set(zone.stops.map(s => s.gtfsStopId)));
    const hub = hubs.find(h => h.id === zone.hubId) || null;
    setSelectedHub(hub);
    setPolygonPoints([]);
    setHoveredPoint(null);
    setDrawMode(false);
    setSelectedHubType((zone.hubType || "railway") as HubType);
    setNewZoneCenter({ lat: zone.hubLat, lng: zone.hubLng });
    setPlacingCenter(false);
  }, [hubs]);

  const cancelEdit = useCallback(() => {
    setEditingZone(null);
    setCreatingNew(false);
    setSelectedHub(null);
    setZoneName("");
    setZoneColor(ZONE_COLORS[0]);
    setZoneNotes("");
    setSelectedStops(new Set());
    setPolygonPoints([]);
    setHoveredPoint(null);
    setDrawMode(false);
    setNewZoneCenter(null);
    setPlacingCenter(false);
  }, []);

  // ── Drawing ──
  const startDrawing = useCallback(() => {
    setPolygonPoints([]);
    setHoveredPoint(null);
    setDrawMode(true);
    setPlacingCenter(false);
  }, []);

  const clearPolygon = useCallback(() => {
    setPolygonPoints([]);
    setHoveredPoint(null);
    setDrawMode(false);
  }, []);

  // ── Stops inside polygon ──
  const stopsInPolygon = useMemo(() => {
    if (polygonPoints.length < 3) return [];
    const poly = polygonPoints.map(p => [p[0], p[1]] as [number, number]);
    return allStops.filter(s => pointInPolygon(s.stopLon, s.stopLat, poly));
  }, [allStops, polygonPoints]);

  const applyPolygonSelection = useCallback(() => {
    if (stopsInPolygon.length === 0) return;
    setSelectedStops(prev => {
      const next = new Set(prev);
      stopsInPolygon.forEach(s => next.add(s.stopId));
      return next;
    });
  }, [stopsInPolygon]);

  // ── Map click ──
  const handleMapClick = useCallback((e: any) => {
    // Place center mode — first click places the zone center
    if (placingCenter && isEditing) {
      const { lng, lat } = e.lngLat;
      setNewZoneCenter({ lat, lng });
      setPlacingCenter(false);
      return;
    }

    if (!drawMode) {
      if (!isEditing) return;
      const features = e.features;
      if (features && features.length > 0) {
        const stopId = features[0].properties?.stopId;
        if (stopId) {
          setSelectedStops(prev => {
            const next = new Set(prev);
            if (next.has(stopId)) next.delete(stopId);
            else next.add(stopId);
            return next;
          });
        }
      }
      return;
    }
    const { lng, lat } = e.lngLat;
    setPolygonPoints(prev => [...prev, [lng, lat]]);
  }, [drawMode, isEditing, placingCenter]);

  const handleMapDblClick = useCallback((e: any) => {
    if (!drawMode || polygonPoints.length < 3) return;
    e.preventDefault();
    applyPolygonSelection();
    setDrawMode(false);
  }, [drawMode, polygonPoints.length, applyPolygonSelection]);

  const handleMapMouseMove = useCallback((e: any) => {
    if (!drawMode || polygonPoints.length === 0) return;
    setHoveredPoint([e.lngLat.lng, e.lngLat.lat]);
  }, [drawMode, polygonPoints.length]);

  // ── Save zone ──
  const saveZone = useCallback(async () => {
    if (!zoneName.trim() || selectedStops.size === 0) return;
    setSaving(true);
    try {
      const center = newZoneCenter;
      const stopsArr = allStops
        .filter(s => selectedStops.has(s.stopId))
        .map(s => {
          const dist = center ? haversineKm(center.lat, center.lng, s.stopLat, s.stopLon) : null;
          const walkMin = dist ? Math.round(dist / 0.08) : null;
          return {
            gtfsStopId: s.stopId,
            stopName: s.stopName,
            stopLat: s.stopLat,
            stopLon: s.stopLon,
            distanceKm: dist ? +dist.toFixed(3) : null,
            walkMinFromHub: walkMin,
          };
        });

      if (editingZone) {
        const updated = await apiFetch<ZoneData>(`/api/coincidence-zones/${editingZone.id}`, {
          method: "PUT",
          body: JSON.stringify({
            name: zoneName.trim(),
            hubType: selectedHubType,
            color: zoneColor,
            notes: zoneNotes || null,
            hubLat: center?.lat ?? editingZone.hubLat,
            hubLng: center?.lng ?? editingZone.hubLng,
            stops: stopsArr,
          }),
        });
        setZones(prev => prev.map(z => z.id === editingZone.id ? updated : z));
      } else {
        const newZone = await apiFetch<ZoneData>("/api/coincidence-zones", {
          method: "POST",
          body: JSON.stringify({
            name: zoneName.trim(),
            hubId: `manual-${Date.now()}`,
            hubName: zoneName.trim(),
            hubType: selectedHubType,
            hubLat: center?.lat || 0,
            hubLng: center?.lng || 0,
            walkMinutes: 2,
            radiusKm: 0.1,
            color: zoneColor,
            notes: zoneNotes || null,
            stops: stopsArr,
          }),
        });
        setZones(prev => [...prev, newZone]);
      }
      cancelEdit();
    } catch (err) {
      console.error("Save failed:", err);
    } finally {
      setSaving(false);
    }
  }, [editingZone, zoneName, zoneColor, zoneNotes, selectedStops, allStops, selectedHubType, newZoneCenter, cancelEdit]);

  // ── Polygon GeoJSON ──
  const polygonGeoJSON = useMemo(() => {
    if (polygonPoints.length < 2) return null;
    const coords = [...polygonPoints];
    if (hoveredPoint) coords.push(hoveredPoint);
    if (coords.length >= 3) {
      const closed = [...coords, coords[0]];
      return {
        type: "FeatureCollection" as const,
        features: [
          { type: "Feature" as const, geometry: { type: "Polygon" as const, coordinates: [closed] }, properties: { kind: "fill" } },
          { type: "Feature" as const, geometry: { type: "LineString" as const, coordinates: coords }, properties: { kind: "line" } },
        ],
      };
    }
    return {
      type: "FeatureCollection" as const,
      features: [{ type: "Feature" as const, geometry: { type: "LineString" as const, coordinates: coords }, properties: { kind: "line" } }],
    };
  }, [polygonPoints, hoveredPoint]);

  // ── GeoJSON: all GTFS stops ──
  const allStopsGeoJSON = useMemo(() => {
    if (!allStops.length) return null;
    const clusterMap = new Map<string, string>();
    zones.forEach(z => z.stops.forEach(s => clusterMap.set(s.gtfsStopId, z.color)));
    return {
      type: "FeatureCollection" as const,
      features: allStops.map(s => ({
        type: "Feature" as const,
        geometry: { type: "Point" as const, coordinates: [s.stopLon, s.stopLat] },
        properties: {
          stopId: s.stopId,
          stopName: s.stopName,
          selected: selectedStops.has(s.stopId) ? 1 : 0,
          zoneColor: clusterMap.get(s.stopId) || "",
        },
      })),
    };
  }, [allStops, selectedStops, zones]);

  // ── GeoJSON: hub radius circles ──
  const hubCirclesGeoJSON = useMemo(() => {
    const features = zones.map(z => ({
      ...walkCircle(z.hubLat, z.hubLng, z.radiusKm || 0.1),
      properties: { zoneId: z.id, color: z.color, hubType: z.hubType },
    }));
    return { type: "FeatureCollection" as const, features };
  }, [zones]);

  // ── Hub data for selected zone ──
  const selectedZoneData = useMemo(() => zones.find(z => z.id === selectedZone), [zones, selectedZone]);
  const viewHub = useMemo(() => {
    if (!selectedZoneData) return null;
    return hubs.find(h => h.id === selectedZoneData.hubId) || null;
  }, [selectedZoneData, hubs]);

  const interactiveLayerIds = useMemo(() => {
    const ids: string[] = [];
    if (allStopsGeoJSON && isEditing && !placingCenter) ids.push("all-stops-layer");
    return ids;
  }, [allStopsGeoJSON, isEditing, placingCenter]);

  // ── Filtered zones ──
  const filteredZones = useMemo(() => {
    if (!typeFilter) return zones;
    return zones.filter(z => z.hubType === typeFilter);
  }, [zones, typeFilter]);

  // ── Zone type stats ──
  const typeStats = useMemo(() => {
    const stats: Record<string, number> = {};
    for (const z of zones) {
      stats[z.hubType] = (stats[z.hubType] || 0) + 1;
    }
    return stats;
  }, [zones]);

  // Determine cursor
  const mapCursor = useMemo(() => {
    if (placingCenter) return "crosshair";
    if (drawMode) return "crosshair";
    if (isEditing) return "pointer";
    return "grab";
  }, [placingCenter, drawMode, isEditing]);

  if (!MAPBOX_TOKEN) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center space-y-4 max-w-md p-8 border border-destructive/20 bg-destructive/5 rounded-2xl">
          <AlertTriangle className="w-12 h-12 text-destructive mx-auto" />
          <h2 className="text-xl font-bold">Mapbox Token Mancante</h2>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
        <span className="ml-3 text-muted-foreground">Caricamento zone di coincidenza...</span>
      </div>
    );
  }

  return (
    <div className="relative w-full h-[calc(100vh-4rem)] flex">
      {/* ════════════════ LEFT PANEL ════════════════ */}
      <div className="w-96 shrink-0 border-r border-border/50 bg-card/80 backdrop-blur-lg flex flex-col overflow-hidden">
        {/* Header */}
        <div className="p-4 border-b border-border/30 space-y-1">
          <h1 className="text-lg font-bold flex items-center gap-2">
            <Zap className="w-5 h-5 text-primary" />
            Zone di Coincidenza
          </h1>
          <p className="text-xs text-muted-foreground">
            Stazione · Porto · Bus↔Bus · P+R · Aeroporto
          </p>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* ── Auto-create & actions ── */}
          <div className="flex items-center gap-2 flex-wrap">
            {zones.length === 0 ? (
              <Button onClick={autoCreate} disabled={autoCreating} size="sm" className="text-xs h-7">
                {autoCreating ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Zap className="w-3 h-3 mr-1" />}
                {autoCreating ? "Analisi in corso..." : "Auto-Rileva Tutte"}
              </Button>
            ) : (
              <Button size="sm" variant="outline" onClick={autoCreate} disabled={autoCreating} className="text-xs h-7">
                <RefreshCw className={`w-3 h-3 mr-1 ${autoCreating ? "animate-spin" : ""}`} />
                {autoCreating ? "Rilevamento..." : "Rileva mancanti"}
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={startNewZone} disabled={isEditing} className="text-xs h-7">
              <Plus className="w-3 h-3 mr-1" /> Nuova Zona
            </Button>
            <button
              onClick={() => setShowHubCircles(v => !v)}
              className={`text-[10px] px-2 py-1 rounded-lg flex items-center gap-1 font-medium transition-all border ${
                showHubCircles ? "bg-cyan-500/20 text-cyan-400 border-cyan-500/30" : "bg-muted/30 text-muted-foreground border-border/30"
              }`}
            >
              {showHubCircles ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
              Raggi
            </button>
          </div>

          {/* ── Type filter pills ── */}
          {zones.length > 0 && (
            <div className="flex flex-wrap gap-1">
              <button
                onClick={() => setTypeFilter(null)}
                className={`text-[9px] px-2 py-1 rounded-full font-semibold transition-all border ${
                  !typeFilter ? "bg-primary/20 text-primary border-primary/40" : "bg-muted/20 text-muted-foreground border-border/30 hover:bg-muted/40"
                }`}
              >
                Tutte ({zones.length})
              </button>
              {Object.entries(typeStats).map(([type, count]) => (
                <button
                  key={type}
                  onClick={() => setTypeFilter(typeFilter === type ? null : type)}
                  className={`text-[9px] px-2 py-1 rounded-full font-semibold transition-all border flex items-center gap-1 ${
                    typeFilter === type
                      ? "border-primary/40"
                      : "border-border/30 hover:bg-muted/40"
                  }`}
                  style={{
                    backgroundColor: typeFilter === type ? (HUB_COLORS[type] || "#94a3b8") + "22" : undefined,
                    color: HUB_COLORS[type] || "#94a3b8",
                  }}
                >
                  {hubIcon(type, "w-3 h-3")}
                  {HUB_LABELS[type] || type} ({count})
                </button>
              ))}
            </div>
          )}

          {/* ── Zone list ── */}
          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
              Zone ({filteredZones.length})
            </h3>

            {zones.length === 0 && !isEditing && (
              <div className="text-center py-8 text-muted-foreground">
                <MapPin className="w-10 h-10 mx-auto mb-2 opacity-30" />
                <p className="text-sm">Nessuna zona definita</p>
                <p className="text-xs mt-1">Usa &quot;Auto-Rileva Tutte&quot; per trovare automaticamente<br/>hub conosciuti, oppure &quot;Nuova Zona&quot; per crearne una manualmente</p>
              </div>
            )}

            <AnimatePresence>
              {filteredZones.map(zone => {
                const isExp = expandedZone === zone.id;
                const isSel = selectedZone === zone.id;
                const hColor = HUB_COLORS[zone.hubType] || "#94a3b8";
                return (
                  <motion.div key={zone.id} initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}>
                    <Card className={`border-border/30 bg-background/50 hover:bg-background/80 transition-colors ${isSel ? "ring-1 ring-primary/50" : ""}`}>
                      <CardContent className="p-3">
                        <div className="flex items-center gap-2">
                          <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
                            style={{ backgroundColor: hColor + "22", color: hColor }}>
                            {hubIcon(zone.hubType, "w-4 h-4")}
                          </div>
                          <button
                            className="flex-1 text-left min-w-0"
                            onClick={() => {
                              setSelectedZone(isSel ? null : zone.id);
                              setExpandedZone(isExp ? null : zone.id);
                              if (!isSel && mapRef.current) {
                                mapRef.current.flyTo({ center: [zone.hubLng, zone.hubLat], zoom: 16, duration: 800 });
                              }
                            }}
                          >
                            <span className="text-sm font-medium truncate block">{zone.name}</span>
                            <div className="flex items-center gap-2 mt-0.5">
                              <Badge variant="secondary" className="text-[10px] h-4 px-1.5">
                                {zone.stops.length} fermate
                              </Badge>
                              <span className="text-[10px] text-muted-foreground flex items-center gap-0.5">
                                <Footprints className="w-2.5 h-2.5" /> {zone.walkMinutes} min
                              </span>
                              <Badge variant="outline" className="text-[9px] h-3.5 px-1"
                                style={{ borderColor: hColor, color: hColor }}>
                                {HUB_LABELS[zone.hubType] || zone.hubType}
                              </Badge>
                            </div>
                          </button>
                          <div className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: zone.color }} />
                          {isExp ? <ChevronDown className="w-4 h-4 text-muted-foreground" /> : <ChevronRight className="w-4 h-4 text-muted-foreground" />}
                        </div>

                        <AnimatePresence>
                          {isExp && (
                            <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
                              <div className="mt-3 pt-3 border-t border-border/20 space-y-3">
                                {zone.notes && <p className="text-[10px] text-muted-foreground italic">{zone.notes}</p>}

                                {/* Schedule tabs — solo per hub intermodali con orari */}
                                {viewHub && (viewHub.totalArrivals > 0 || viewHub.totalDepartures > 0) && (
                                  <div className="space-y-2">
                                    <div className="flex gap-1">
                                      <button onClick={() => setScheduleTab("arrivals")}
                                        className={`text-[9px] px-2 py-1 rounded font-semibold transition-colors ${
                                          scheduleTab === "arrivals" ? "bg-primary/20 text-primary" : "text-muted-foreground hover:text-foreground"
                                        }`}>
                                        🚉 Arrivi ({viewHub.totalArrivals})
                                      </button>
                                      <button onClick={() => setScheduleTab("departures")}
                                        className={`text-[9px] px-2 py-1 rounded font-semibold transition-colors ${
                                          scheduleTab === "departures" ? "bg-primary/20 text-primary" : "text-muted-foreground hover:text-foreground"
                                        }`}>
                                        🚌 Partenze ({viewHub.totalDepartures})
                                      </button>
                                    </div>
                                    <ScrollArea className="h-32">
                                      <div className="space-y-1">
                                        {(scheduleTab === "arrivals" ? viewHub.arrivals : viewHub.departures).map((item, idx) => (
                                          <div key={idx} className="text-[9px] px-2 py-1 rounded bg-muted/30 border border-border/20">
                                            <span className="font-semibold text-foreground">
                                              {scheduleTab === "arrivals" ? (item as any).origin : (item as any).destination}
                                            </span>
                                            <div className="flex flex-wrap gap-1 mt-0.5">
                                              {item.times.map((t, ti) => (
                                                <span key={ti} className="text-[8px] px-1 py-0.5 rounded bg-background/80 font-mono">{t}</span>
                                              ))}
                                            </div>
                                          </div>
                                        ))}
                                      </div>
                                    </ScrollArea>
                                  </div>
                                )}

                                {/* Bus lines */}
                                {isSel && (
                                  <div className="space-y-1">
                                    <p className="text-[9px] font-semibold text-muted-foreground uppercase">
                                      Linee bus nella zona
                                      {loadingBusLines && <Loader2 className="w-3 h-3 animate-spin inline ml-1" />}
                                    </p>
                                    {busLines.length > 0 ? (
                                      <div className="flex flex-wrap gap-1">
                                        {busLines.slice(0, 15).map(bl => (
                                          <span key={bl.routeId} className="text-[8px] px-1.5 py-0.5 rounded font-semibold"
                                            style={{
                                              backgroundColor: bl.routeColor ? `#${bl.routeColor.replace("#","")}22` : "#64748b22",
                                              color: bl.routeColor ? `#${bl.routeColor.replace("#","")}` : "#94a3b8",
                                            }}>
                                            {bl.routeShortName} <span className="opacity-60">({bl.tripsCount})</span>
                                          </span>
                                        ))}
                                        {busLines.length > 15 && <span className="text-[8px] text-muted-foreground">+{busLines.length - 15}</span>}
                                      </div>
                                    ) : !loadingBusLines ? (
                                      <p className="text-[9px] text-muted-foreground italic">Nessuna linea bus trovata</p>
                                    ) : null}
                                  </div>
                                )}

                                {/* Stops list */}
                                <ScrollArea className="h-28">
                                  {zone.stops.map(s => (
                                    <div key={s.gtfsStopId} className="text-[11px] text-muted-foreground flex items-center gap-1.5 py-0.5">
                                      <MapPin className="w-2.5 h-2.5 shrink-0" style={{ color: HUB_COLORS[zone.hubType] || zone.color }} />
                                      <span className="truncate flex-1">{s.stopName}</span>
                                      {s.walkMinFromHub != null && (
                                        <span className="text-[9px] opacity-50 shrink-0">{s.walkMinFromHub}min</span>
                                      )}
                                    </div>
                                  ))}
                                </ScrollArea>

                                {/* Actions */}
                                <div className="flex gap-2 pt-2">
                                  <Button size="sm" variant="outline" className="h-7 text-xs flex-1"
                                    onClick={() => startEdit(zone)} disabled={isEditing}>
                                    <Edit3 className="w-3 h-3 mr-1" /> Modifica
                                  </Button>
                                  <Button size="sm" variant="outline" className="h-7 text-xs"
                                    onClick={() => setSchedulesEditorZone(zone)} disabled={isEditing}
                                    title="Modifica orari arrivi/partenze">
                                    <Clock className="w-3 h-3 mr-1" /> Orari
                                  </Button>
                                  <Button size="sm" variant="destructive" className="h-7 text-xs"
                                    onClick={() => setConfirmDeleteId(zone.id)} disabled={isEditing}>
                                    <Trash2 className="w-3 h-3" />
                                  </Button>
                                </div>
                              </div>
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </CardContent>
                    </Card>
                  </motion.div>
                );
              })}
            </AnimatePresence>
          </div>
        </div>

        {/* ════════════════ BOTTOM EDITING PANEL ════════════════ */}
        <AnimatePresence>
          {isEditing && (
            <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}
              className="border-t border-primary/30 bg-primary/5">
              <div className="p-4 space-y-3 max-h-[55vh] overflow-y-auto">
                <div className="flex items-center gap-2 text-sm font-semibold text-primary">
                  <Settings2 className="w-4 h-4" />
                  {editingZone ? "Modifica Zona" : "Nuova Zona di Coincidenza"}
                </div>

                {/* ── Hub Type selector ── */}
                <div className="space-y-1.5">
                  <Label className="text-xs">Tipo</Label>
                  <div className="flex gap-1.5 flex-wrap">
                    {ALL_HUB_TYPES.map(ht => {
                      const hc = HUB_COLORS[ht];
                      const active = selectedHubType === ht;
                      return (
                        <button
                          key={ht}
                          onClick={() => {
                            setSelectedHubType(ht);
                            setZoneColor(hc);
                          }}
                          className={`flex items-center gap-1.5 px-2.5 py-2 rounded-lg border-2 transition-all text-xs font-medium ${
                            active
                              ? "border-white/60 shadow-lg scale-105"
                              : "border-transparent opacity-50 hover:opacity-80 hover:border-white/20"
                          }`}
                          style={{
                            backgroundColor: active ? hc + "33" : hc + "11",
                            color: hc,
                          }}
                        >
                          <div className={`w-7 h-7 rounded-full flex items-center justify-center ${active ? "shadow-md" : ""}`}
                            style={{ backgroundColor: active ? hc : hc + "44" }}>
                            {hubIcon(ht, "w-4 h-4 text-white")}
                          </div>
                          <span className="text-[10px]">{HUB_LABELS[ht]}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* ── Center position ── */}
                <div className="space-y-1">
                  <Label className="text-xs">Posizione centro</Label>
                  {newZoneCenter ? (
                    <div className="flex items-center gap-2">
                      <div className="text-[10px] bg-background/50 rounded px-2 py-1 font-mono text-muted-foreground flex-1">
                        {newZoneCenter.lat.toFixed(6)}, {newZoneCenter.lng.toFixed(6)}
                      </div>
                      <Button size="sm" variant="ghost" className="h-6 text-[10px] px-2" onClick={() => { setPlacingCenter(true); }}>
                        <MapPin className="w-3 h-3 mr-1" /> Sposta
                      </Button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] text-amber-400 flex items-center gap-1">
                        <MapPin className="w-3 h-3" /> Clicca sulla mappa per posizionare il centro
                      </span>
                    </div>
                  )}
                </div>

                <div className="space-y-1">
                  <Label className="text-xs">Nome</Label>
                  <Input value={zoneName} onChange={e => setZoneName(e.target.value)} className="h-8 text-sm" placeholder="Es: Coincidenza Staz. FS Ancona" />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Note</Label>
                  <Input value={zoneNotes} onChange={e => setZoneNotes(e.target.value)} className="h-8 text-sm" placeholder="Descrizione..." />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Colore zona</Label>
                  <div className="flex gap-1 flex-wrap">
                    {ZONE_COLORS.map(c => (
                      <button key={c}
                        className={`w-5 h-5 rounded-full border-2 transition-all ${zoneColor === c ? "border-white scale-110" : "border-transparent opacity-60 hover:opacity-100"}`}
                        style={{ backgroundColor: c }} onClick={() => setZoneColor(c)} />
                    ))}
                  </div>
                </div>

                {/* Drawing controls */}
                <div className="flex gap-2">
                  <Button
                    size="sm" variant={drawMode ? "default" : "outline"} className="h-7 text-xs"
                    onClick={drawMode ? clearPolygon : startDrawing}
                    disabled={placingCenter}
                  >
                    <Pencil className="w-3 h-3 mr-1" />
                    {drawMode ? "Annulla Disegno" : "Disegna Area"}
                  </Button>
                  {polygonPoints.length > 0 && !drawMode && (
                    <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={clearPolygon}>
                      <X className="w-3 h-3 mr-1" /> Cancella Area
                    </Button>
                  )}
                </div>

                <div className="rounded-lg p-2 text-xs flex items-center gap-2"
                  style={{ backgroundColor: editColor + "15", color: editColor }}>
                  <div className="w-3 h-3 rounded-full" style={{ backgroundColor: editColor }} />
                  <span className="font-medium">{selectedStops.size}</span>
                  <span className="text-muted-foreground"> fermate selezionate</span>
                </div>

                <p className="text-[10px] text-muted-foreground leading-relaxed">
                  {placingCenter ? (
                    <><strong>📍 Posiziona centro:</strong> Clicca sulla mappa per piazzare il centro della zona.</>
                  ) : (
                    <>
                      <strong>Disegna:</strong> Clicca sulla mappa per aggiungere vertici, <strong>doppio-click</strong> per chiudere e selezionare fermate.
                      <br />
                      <strong>Singola fermata:</strong> Clicca su un punto per aggiungerla/rimuoverla.
                    </>
                  )}
                </p>

                <div className="flex gap-2">
                  <Button
                    className="flex-1 h-8 text-xs"
                    onClick={saveZone}
                    disabled={saving || !zoneName.trim() || selectedStops.size === 0 || !newZoneCenter || placingCenter}
                  >
                    {saving ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Save className="w-3 h-3 mr-1" />}
                    {editingZone ? "Aggiorna Zona" : "Crea Zona"}
                  </Button>
                  <Button variant="outline" className="h-8 text-xs" onClick={cancelEdit}>
                    <X className="w-3 h-3 mr-1" /> Annulla
                  </Button>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* ════════════════ MAP AREA ════════════════ */}
      <div className="flex-1 relative">
        <MapGL
          ref={mapRef}
          initialViewState={{ longitude: 13.46, latitude: 43.615, zoom: 12.5, pitch: 0, bearing: 0 }}
          mapStyle="mapbox://styles/mapbox/dark-v11"
          mapboxAccessToken={MAPBOX_TOKEN}
          style={{ width: "100%", height: "100%" }}
          interactiveLayerIds={interactiveLayerIds}
          doubleClickZoom={!drawMode && !placingCenter}
          onClick={handleMapClick}
          onDblClick={handleMapDblClick}
          onMouseMove={handleMapMouseMove}
          cursor={mapCursor}
        >
          {/* Hub radius circles */}
          {showHubCircles && hubCirclesGeoJSON.features.length > 0 && (
            <Source id="hub-circles" type="geojson" data={hubCirclesGeoJSON as any}>
              <Layer id="hub-circles-fill" type="fill" paint={{
                "fill-color": ["get", "color"],
                "fill-opacity": 0.08,
              }} />
              <Layer id="hub-circles-line" type="line" paint={{
                "line-color": ["get", "color"],
                "line-width": 1.5,
                "line-opacity": 0.4,
                "line-dasharray": [3, 2],
              }} />
            </Source>
          )}

          {/* All GTFS stops — selected stops use editColor (type color) */}
          {allStopsGeoJSON && (
            <Source id="all-gtfs-stops" type="geojson" data={allStopsGeoJSON as any}>
              <Layer id="all-stops-layer" type="circle" paint={{
                "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 3, 13, 5, 16, 8],
                "circle-color": [
                  "case",
                  ["==", ["get", "selected"], 1], editColor,
                  ["!=", ["get", "zoneColor"], ""], ["get", "zoneColor"],
                  "#94a3b8",
                ],
                "circle-opacity": [
                  "case",
                  ["==", ["get", "selected"], 1], 1,
                  ["!=", ["get", "zoneColor"], ""], 0.8,
                  isEditing ? 0.5 : 0.3,
                ],
                "circle-stroke-width": ["case", ["==", ["get", "selected"], 1], 2, 1],
                "circle-stroke-color": ["case", ["==", ["get", "selected"], 1], "#ffffff", "rgba(255,255,255,0.2)"],
              }} />
              <Layer id="all-stops-labels" type="symbol" minzoom={15} layout={{
                "text-field": ["get", "stopName"],
                "text-size": 10,
                "text-offset": [0, 1.2],
                "text-anchor": "top",
                "text-max-width": 8,
              }} paint={{
                "text-color": "#e2e8f0",
                "text-halo-color": "#0f172a",
                "text-halo-width": 1,
                "text-opacity": ["case", ["==", ["get", "selected"], 1], 1, 0.4],
              }} />
            </Source>
          )}

          {/* ── Drawing polygon overlay ── */}
          {polygonGeoJSON && (
            <Source id="draw-polygon" type="geojson" data={polygonGeoJSON as any}>
              <Layer
                id="draw-polygon-fill" type="fill"
                filter={["==", ["get", "kind"], "fill"]}
                paint={{ "fill-color": editColor, "fill-opacity": 0.15 }}
              />
              <Layer
                id="draw-polygon-stroke" type="line"
                paint={{ "line-color": editColor, "line-width": 2, "line-dasharray": [3, 2], "line-opacity": 0.8 }}
              />
            </Source>
          )}

          {/* ── Polygon vertex markers ── */}
          {polygonPoints.map((pt, i) => (
            <Marker key={`vertex-${i}`} longitude={pt[0]} latitude={pt[1]} anchor="center">
              <div className="w-3 h-3 rounded-full border-2 border-white shadow-md" style={{ backgroundColor: editColor }} />
            </Marker>
          ))}

          {/* ── New zone center marker (while creating/editing) ── */}
          {isEditing && newZoneCenter && (
            <Marker longitude={newZoneCenter.lng} latitude={newZoneCenter.lat} anchor="center">
              <div className="relative">
                <div className="absolute inset-0 -m-3 rounded-full animate-ping opacity-30"
                  style={{ backgroundColor: editColor }} />
                <div className="relative z-10 w-10 h-10 rounded-full flex items-center justify-center shadow-xl border-2 border-white"
                  style={{ backgroundColor: editColor + "ee", boxShadow: `0 0 20px ${editColor}66` }}>
                  {hubIcon(selectedHubType, "w-5 h-5 text-white")}
                </div>
              </div>
            </Marker>
          )}

          {/* Hub / zone markers (existing zones) */}
          {zones.map(zone => {
            // Don't show the marker for the zone being edited (we show the editable center above)
            if (editingZone && editingZone.id === zone.id) return null;
            const hColor = HUB_COLORS[zone.hubType] || "#94a3b8";
            return (
              <Marker key={zone.id} longitude={zone.hubLng} latitude={zone.hubLat} anchor="center">
                <div
                  className={`relative cursor-pointer transition-transform hover:scale-110 ${selectedZone === zone.id ? "scale-125" : ""}`}
                  onClick={() => {
                    setSelectedZone(selectedZone === zone.id ? null : zone.id);
                    setExpandedZone(expandedZone === zone.id ? null : zone.id);
                  }}
                >
                  <div className="absolute inset-0 -m-2 rounded-full animate-pulse opacity-20"
                    style={{ backgroundColor: hColor }} />
                  <div className="relative z-10 w-10 h-10 rounded-full flex items-center justify-center shadow-xl border-2"
                    style={{
                      backgroundColor: hColor + "ee",
                      borderColor: selectedZone === zone.id ? "#fff" : hColor,
                      boxShadow: `0 0 20px ${hColor}44`,
                    }}>
                    {hubIcon(zone.hubType, "w-5 h-5 text-white")}
                  </div>
                  <div className="absolute -bottom-1 -right-1 text-[7px] font-bold w-5 h-5 rounded-full flex items-center justify-center z-20 bg-background border border-border shadow"
                    style={{ color: hColor }}>
                    {zone.stops.length}
                  </div>
                </div>
              </Marker>
            );
          })}
        </MapGL>

        {/* ── Placing center indicator ── */}
        {placingCenter && (
          <div className="absolute top-4 left-1/2 -translate-x-1/2 z-10">
            <motion.div
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              className="px-4 py-2 rounded-full text-sm font-medium flex items-center gap-2 shadow-lg text-white"
              style={{ backgroundColor: editColor + "dd" }}
            >
              <MapPin className="w-4 h-4" />
              📍 Clicca sulla mappa per posizionare il centro della zona
            </motion.div>
          </div>
        )}

        {/* ── Draw mode indicator ── */}
        {drawMode && (
          <div className="absolute top-4 left-1/2 -translate-x-1/2 z-10">
            <motion.div
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              className="px-4 py-2 rounded-full text-sm font-medium flex items-center gap-2 shadow-lg text-white"
              style={{ backgroundColor: editColor + "dd" }}
            >
              <Pencil className="w-4 h-4" />
              {polygonPoints.length === 0
                ? "Clicca sulla mappa per iniziare a disegnare"
                : polygonPoints.length < 3
                ? `${polygonPoints.length} vertici — aggiungi almeno ${3 - polygonPoints.length}`
                : `${polygonPoints.length} vertici — doppio-click per chiudere (${stopsInPolygon.length} fermate dentro)`
              }
            </motion.div>
          </div>
        )}

        {/* ── Confirm delete dialog ── */}
        <AnimatePresence>
          {confirmDeleteId && confirmDeleteZone && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
              onClick={() => setConfirmDeleteId(null)}
            >
              <motion.div
                initial={{ scale: 0.9, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.9, opacity: 0 }}
                className="bg-card border border-border/50 rounded-xl p-5 shadow-2xl max-w-sm mx-4 space-y-4"
                onClick={e => e.stopPropagation()}
              >
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-destructive/15 flex items-center justify-center">
                    <Trash2 className="w-5 h-5 text-destructive" />
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold">Elimina zona</h3>
                    <p className="text-xs text-muted-foreground">Questa azione non può essere annullata</p>
                  </div>
                </div>
                <div className="bg-muted/30 rounded-lg p-3 flex items-center gap-2">
                  <div className="w-7 h-7 rounded-full flex items-center justify-center shrink-0"
                    style={{ backgroundColor: (HUB_COLORS[confirmDeleteZone.hubType] || "#94a3b8") + "22",
                             color: HUB_COLORS[confirmDeleteZone.hubType] || "#94a3b8" }}>
                    {hubIcon(confirmDeleteZone.hubType, "w-3.5 h-3.5")}
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{confirmDeleteZone.name}</p>
                    <p className="text-[10px] text-muted-foreground">{confirmDeleteZone.stops.length} fermate · {HUB_LABELS[confirmDeleteZone.hubType] || confirmDeleteZone.hubType}</p>
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" className="flex-1 h-8 text-xs"
                    onClick={() => setConfirmDeleteId(null)}>
                    Annulla
                  </Button>
                  <Button variant="destructive" size="sm" className="flex-1 h-8 text-xs"
                    onClick={async () => {
                      await deleteZone(confirmDeleteId);
                      setConfirmDeleteId(null);
                    }}>
                    <Trash2 className="w-3 h-3 mr-1" /> Elimina
                  </Button>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* ── Schedules editor dialog ── */}
        <AnimatePresence>
          {schedulesEditorZone && (
            <SchedulesEditorDialog
              zone={schedulesEditorZone}
              onClose={() => setSchedulesEditorZone(null)}
              onSaved={() => setSchedulesEditorZone(null)}
            />
          )}
        </AnimatePresence>

        {/* Stats badges */}
        <div className="absolute bottom-4 right-4 z-10 flex gap-2 flex-wrap">
          <Badge variant="secondary" className="text-xs bg-background/80 backdrop-blur">
            {zones.length} zone
          </Badge>
          <Badge variant="secondary" className="text-xs bg-background/80 backdrop-blur">
            {zones.reduce((s, z) => s + z.stops.length, 0)} fermate assegnate
          </Badge>
          {typeStats.railway && (
            <Badge variant="secondary" className="text-xs bg-background/80 backdrop-blur flex items-center gap-1">
              <TrainFront className="w-3 h-3" style={{ color: HUB_COLORS.railway }} /> {typeStats.railway}
            </Badge>
          )}
          {typeStats.port && (
            <Badge variant="secondary" className="text-xs bg-background/80 backdrop-blur flex items-center gap-1">
              <Ship className="w-3 h-3" style={{ color: HUB_COLORS.port }} /> {typeStats.port}
            </Badge>
          )}
          {typeStats["bus-bus"] && (
            <Badge variant="secondary" className="text-xs bg-background/80 backdrop-blur flex items-center gap-1">
              <Bus className="w-3 h-3" style={{ color: HUB_COLORS["bus-bus"] }} /> {typeStats["bus-bus"]}
            </Badge>
          )}
          {typeStats["park-ride"] && (
            <Badge variant="secondary" className="text-xs bg-background/80 backdrop-blur flex items-center gap-1">
              <Car className="w-3 h-3" style={{ color: HUB_COLORS["park-ride"] }} /> {typeStats["park-ride"]}
            </Badge>
          )}
          {typeStats.airport && (
            <Badge variant="secondary" className="text-xs bg-background/80 backdrop-blur flex items-center gap-1">
              <Plane className="w-3 h-3" style={{ color: HUB_COLORS.airport }} /> {typeStats.airport}
            </Badge>
          )}
        </div>

        {/* Legend */}
        <div className="absolute top-4 right-4 z-10">
          <Card className="bg-background/80 backdrop-blur border-border/50 shadow-lg">
            <CardContent className="p-3 space-y-1.5">
              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Legenda</p>
              {ALL_HUB_TYPES.map(ht => (
                <div key={ht} className="flex items-center gap-2">
                  <div className="w-5 h-5 rounded-full flex items-center justify-center" style={{ backgroundColor: HUB_COLORS[ht] + "cc" }}>
                    {hubIcon(ht, "w-3 h-3 text-white")}
                  </div>
                  <span className="text-[10px] text-muted-foreground">{HUB_LABELS[ht]}</span>
                </div>
              ))}
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full bg-cyan-400 border border-white/30" />
                <span className="text-[10px] text-muted-foreground">Fermata bus in zona</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full bg-gray-400/60 border border-white/20" />
                <span className="text-[10px] text-muted-foreground">Fermata bus disponibile</span>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// Schedules Editor Dialog — editor "snello" per orari arrivi/partenze zona
// ═══════════════════════════════════════════════════════════════════════
interface ScheduleEntry { label: string; times: string[] }

function SchedulesEditorDialog({
  zone,
  onClose,
  onSaved,
}: {
  zone: ZoneData;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [arrivals, setArrivals] = useState<ScheduleEntry[]>([]);
  const [departures, setDepartures] = useState<ScheduleEntry[]>([]);
  const [source, setSource] = useState<"custom" | "preset" | "empty">("empty");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        setLoading(true);
        const r = await apiFetch<{
          arrivals: { label?: string; origin?: string; times: string[] }[];
          departures: { label?: string; destination?: string; times: string[] }[];
          source?: "custom" | "preset" | "empty";
        }>(`/api/coincidence-zones/${zone.id}/schedules`);
        const arr = (r.arrivals || []).map(a => ({ label: a.label ?? a.origin ?? "", times: a.times || [] }));
        const dep = (r.departures || []).map(a => ({ label: a.label ?? a.destination ?? "", times: a.times || [] }));
        setArrivals(arr.length > 0 ? arr : [{ label: "", times: [] }]);
        setDepartures(dep.length > 0 ? dep : [{ label: "", times: [] }]);
        setSource(r.source || "empty");
      } catch (e: any) {
        setErr(e?.message || "Errore caricamento orari");
      } finally { setLoading(false); }
    })();
  }, [zone.id]);

  const addRow = (kind: "arr" | "dep") => {
    const setFn = kind === "arr" ? setArrivals : setDepartures;
    setFn(prev => [...prev, { label: "", times: [] }]);
  };
  const removeRow = (kind: "arr" | "dep", idx: number) => {
    const setFn = kind === "arr" ? setArrivals : setDepartures;
    setFn(prev => prev.filter((_, i) => i !== idx));
  };
  const updateLabel = (kind: "arr" | "dep", idx: number, label: string) => {
    const setFn = kind === "arr" ? setArrivals : setDepartures;
    setFn(prev => prev.map((r, i) => i === idx ? { ...r, label } : r));
  };
  const updateTimes = (kind: "arr" | "dep", idx: number, raw: string) => {
    // parse: accetta spazi, virgole, a-capo
    const times = raw.split(/[\s,;]+/).map(s => s.trim()).filter(Boolean);
    const setFn = kind === "arr" ? setArrivals : setDepartures;
    setFn(prev => prev.map((r, i) => i === idx ? { ...r, times } : r));
  };

  const save = async () => {
    try {
      setSaving(true);
      setErr(null);
      await apiFetch(`/api/coincidence-zones/${zone.id}/schedules`, {
        method: "PATCH",
        body: JSON.stringify({
          arrivals: arrivals.filter(r => r.times.length > 0).map(r => ({ label: r.label || "—", times: r.times })),
          departures: departures.filter(r => r.times.length > 0).map(r => ({ label: r.label || "—", times: r.times })),
        }),
      });
      onSaved();
    } catch (e: any) {
      setErr(e?.message || "Errore salvataggio");
    } finally { setSaving(false); }
  };

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="absolute inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.95, opacity: 0 }}
        className="bg-card border border-border/50 rounded-xl shadow-2xl w-full max-w-3xl mx-4 max-h-[85vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 py-3 border-b border-border/50 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-9 h-9 rounded-full flex items-center justify-center shrink-0"
              style={{ backgroundColor: (HUB_COLORS[zone.hubType] || "#94a3b8") + "22", color: HUB_COLORS[zone.hubType] || "#94a3b8" }}>
              <Clock className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <h3 className="text-sm font-semibold truncate">Orari di {zone.name}</h3>
              <p className="text-[11px] text-muted-foreground">
                Arrivi e partenze (hh:mm) · sorgente: <span className="font-medium">{source === "custom" ? "custom" : source === "preset" ? "preset" : "vuoto"}</span>
              </p>
            </div>
          </div>
          <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={onClose}>
            <X className="w-4 h-4" />
          </Button>
        </div>

        {loading ? (
          <div className="p-10 flex items-center justify-center">
            <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto p-5 space-y-5">
            {err && (
              <div className="text-[11px] text-destructive bg-destructive/10 border border-destructive/30 rounded px-2 py-1">
                {err}
              </div>
            )}
            <p className="text-[11px] text-muted-foreground">
              Inserisci una riga per ogni linea/destinazione. Gli orari possono essere separati da spazi, virgole o a-capo. Formato: <code className="bg-muted px-1 rounded">hh:mm</code>
            </p>

            {/* Arrivi */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <h4 className="text-xs font-semibold flex items-center gap-2">
                  <ArrowRight className="w-3.5 h-3.5 rotate-180 text-emerald-500" /> Arrivi
                  <Badge variant="secondary" className="text-[9px]">{arrivals.filter(a => a.times.length > 0).length}</Badge>
                </h4>
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => addRow("arr")}>
                  <Plus className="w-3 h-3 mr-1" /> Riga
                </Button>
              </div>
              <div className="space-y-2">
                {arrivals.map((row, i) => (
                  <div key={i} className="grid grid-cols-[1fr_2fr_auto] gap-2 items-start">
                    <Input
                      placeholder="Origine (es. Roma, Bologna…)"
                      value={row.label}
                      onChange={e => updateLabel("arr", i, e.target.value)}
                      className="h-8 text-xs"
                    />
                    <textarea
                      placeholder="07:42  09:12  11:45…"
                      value={row.times.join(" ")}
                      onChange={e => updateTimes("arr", i, e.target.value)}
                      className="min-h-[32px] px-2 py-1 text-xs font-mono rounded border border-input bg-background resize-y"
                      rows={1}
                    />
                    <Button size="sm" variant="ghost" className="h-8 w-8 p-0" onClick={() => removeRow("arr", i)}>
                      <X className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            </div>

            {/* Partenze */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <h4 className="text-xs font-semibold flex items-center gap-2">
                  <ArrowRight className="w-3.5 h-3.5 text-cyan-500" /> Partenze
                  <Badge variant="secondary" className="text-[9px]">{departures.filter(a => a.times.length > 0).length}</Badge>
                </h4>
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => addRow("dep")}>
                  <Plus className="w-3 h-3 mr-1" /> Riga
                </Button>
              </div>
              <div className="space-y-2">
                {departures.map((row, i) => (
                  <div key={i} className="grid grid-cols-[1fr_2fr_auto] gap-2 items-start">
                    <Input
                      placeholder="Destinazione (es. Roma, Bologna…)"
                      value={row.label}
                      onChange={e => updateLabel("dep", i, e.target.value)}
                      className="h-8 text-xs"
                    />
                    <textarea
                      placeholder="07:42  09:12  11:45…"
                      value={row.times.join(" ")}
                      onChange={e => updateTimes("dep", i, e.target.value)}
                      className="min-h-[32px] px-2 py-1 text-xs font-mono rounded border border-input bg-background resize-y"
                      rows={1}
                    />
                    <Button size="sm" variant="ghost" className="h-8 w-8 p-0" onClick={() => removeRow("dep", i)}>
                      <X className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="px-5 py-3 border-t border-border/50 flex items-center justify-between shrink-0">
          <p className="text-[10px] text-muted-foreground">
            Solo righe con almeno un orario valido verranno salvate.
          </p>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" className="h-8 text-xs" onClick={onClose}>Annulla</Button>
            <Button size="sm" className="h-8 text-xs" onClick={save} disabled={saving || loading}>
              {saving ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Save className="w-3 h-3 mr-1" />}
              Salva orari
            </Button>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}
