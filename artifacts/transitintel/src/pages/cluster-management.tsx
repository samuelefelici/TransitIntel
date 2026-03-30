/**
 * CLUSTER MANAGEMENT — Gestione Cluster di Cambio in Linea
 *
 * Mappa interattiva per creare/modificare cluster di fermate.
 * - Disegno poligono libero (click per aggiungere vertici, doppio-click per chiudere)
 * - Tutte le fermate dentro il poligono vengono auto-selezionate
 * - Filtro fermate per linea GTFS
 * - Click singola fermata per aggiungerla/rimuoverla
 * - CRUD cluster + impostazione autovetture aziendali
 */
import React, { useState, useMemo, useCallback, useRef, useEffect } from "react";
import MapGL, { Source, Layer, Marker, MapRef } from "react-map-gl/mapbox";
import { motion, AnimatePresence } from "framer-motion";
import {
  MapPin, Plus, Trash2, Edit3, Save, X, Car,
  AlertTriangle, Loader2, ChevronRight, ChevronDown,
  Pencil, Settings2, Grip, Filter, Bus,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { getApiBase } from "@/lib/api";

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN || "";
const BASE = () => getApiBase();

const CLUSTER_COLORS = [
  "#ef4444", "#f97316", "#eab308", "#22c55e", "#06b6d4",
  "#3b82f6", "#8b5cf6", "#ec4899", "#14b8a6", "#f43f5e",
];

// ─── Types ──────────────────────────────────────────────────
interface GtfsStop {
  stopId: string;
  stopName: string;
  stopLat: number;
  stopLon: number;
  routes: string[];
}

interface RouteInfo {
  routeShortName: string;
  routeLongName: string;
  routeColor: string | null;
}

interface ClusterStop {
  id?: string;
  gtfsStopId: string;
  stopName: string;
  stopLat: number;
  stopLon: number;
}

interface ClusterData {
  id: string;
  name: string;
  transferFromDepotMin: number;
  color: string;
  stops: ClusterStop[];
}

// ─── Point-in-polygon (ray casting) ────────────────────────
function pointInPolygon(lat: number, lon: number, polygon: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if ((yi > lon) !== (yj > lon) && lat < ((xj - xi) * (lon - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

// ─── API helpers ────────────────────────────────────────────
async function apiFetch<T = any>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${BASE()}${path}`, {
    headers: { "Content-Type": "application/json", ...init?.headers },
    ...init,
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  if (r.status === 204) return {} as T;
  return r.json();
}

export default function ClusterManagement() {
  const mapRef = useRef<MapRef>(null);

  // ── Data state ──
  const [allStops, setAllStops] = useState<GtfsStop[]>([]);
  const [allRoutes, setAllRoutes] = useState<RouteInfo[]>([]);
  const [clusters, setClusters] = useState<ClusterData[]>([]);
  const [companyCars, setCompanyCars] = useState(5);
  const [loading, setLoading] = useState(true);

  // ── Route filter ──
  const [selectedRoutes, setSelectedRoutes] = useState<Set<string>>(new Set());
  const [routeFilterOpen, setRouteFilterOpen] = useState(false);
  const [routeSearch, setRouteSearch] = useState("");

  // ── Drawing polygon state ──
  const [drawMode, setDrawMode] = useState(false);
  const [polygonPoints, setPolygonPoints] = useState<[number, number][]>([]);
  const [hoveredPoint, setHoveredPoint] = useState<[number, number] | null>(null);

  // ── Editing state ──
  const [selectedStops, setSelectedStops] = useState<Set<string>>(new Set());
  const [editingCluster, setEditingCluster] = useState<ClusterData | null>(null);
  const [clusterName, setClusterName] = useState("");
  const [clusterTransferMin, setClusterTransferMin] = useState(10);
  const [clusterColor, setClusterColor] = useState(CLUSTER_COLORS[0]);
  const [expandedCluster, setExpandedCluster] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [carsInput, setCarsInput] = useState("5");

  // ── Load data ──
  useEffect(() => {
    (async () => {
      try {
        const [stopsRes, routesRes, clustersRes, carsRes] = await Promise.all([
          apiFetch<{ data: GtfsStop[] }>("/api/gtfs/stops/all"),
          apiFetch<{ data: RouteInfo[] }>("/api/gtfs/routes/list"),
          apiFetch<{ data: ClusterData[] }>("/api/clusters"),
          apiFetch<{ companyCars: number }>("/api/settings/company-cars"),
        ]);
        setAllStops(stopsRes.data || []);
        setAllRoutes(routesRes.data || []);
        setClusters(clustersRes.data || []);
        setCompanyCars(carsRes.companyCars ?? 5);
        setCarsInput(String(carsRes.companyCars ?? 5));
      } catch (err) {
        console.error("Failed to load cluster data:", err);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // ── Filtered stops (by selected routes) ──
  const filteredStops = useMemo(() => {
    if (selectedRoutes.size === 0) return allStops;
    return allStops.filter(s =>
      s.routes && s.routes.some(r => selectedRoutes.has(r))
    );
  }, [allStops, selectedRoutes]);

  // ── Stops inside the drawn polygon ──
  const stopsInPolygon = useMemo(() => {
    if (polygonPoints.length < 3) return [];
    const poly = polygonPoints.map(p => [p[0], p[1]] as [number, number]);
    return filteredStops.filter(s => pointInPolygon(s.stopLon, s.stopLat, poly));
  }, [filteredStops, polygonPoints]);

  // ── When polygon closes (>=3 points), auto-select stops inside ──
  const applyPolygonSelection = useCallback(() => {
    if (stopsInPolygon.length === 0) return;
    setSelectedStops(prev => {
      const next = new Set(prev);
      stopsInPolygon.forEach(s => next.add(s.stopId));
      return next;
    });
  }, [stopsInPolygon]);

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
          {
            type: "Feature" as const,
            geometry: { type: "Polygon" as const, coordinates: [closed] },
            properties: { kind: "fill" },
          },
          {
            type: "Feature" as const,
            geometry: { type: "LineString" as const, coordinates: coords },
            properties: { kind: "line" },
          },
        ],
      };
    }
    return {
      type: "FeatureCollection" as const,
      features: [{
        type: "Feature" as const,
        geometry: { type: "LineString" as const, coordinates: coords },
        properties: { kind: "line" },
      }],
    };
  }, [polygonPoints, hoveredPoint]);

  // ── GeoJSON for stops ──
  const stopsGeoJSON = useMemo(() => {
    const clusterMap = new Map<string, string>();
    clusters.forEach(c => c.stops.forEach(s => clusterMap.set(s.gtfsStopId, c.color)));

    const features = filteredStops.map(s => {
      const cc = clusterMap.get(s.stopId);
      const props: Record<string, any> = {
        stopId: s.stopId,
        stopName: s.stopName,
        selected: selectedStops.has(s.stopId) ? 1 : 0,
      };
      // Only add clusterColor if it actually exists — avoids Mapbox null issues
      if (cc) props.clusterColor = cc;
      return {
        type: "Feature" as const,
        geometry: { type: "Point" as const, coordinates: [s.stopLon, s.stopLat] },
        properties: props,
      };
    });

    return { type: "FeatureCollection" as const, features };
  }, [filteredStops, selectedStops, clusters]);

  // ── Map click: add polygon point OR toggle stop ──
  const handleMapClick = useCallback((e: any) => {
    if (!drawMode) {
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
  }, [drawMode]);

  // ── Double-click: close polygon ──
  const handleMapDblClick = useCallback((e: any) => {
    if (!drawMode || polygonPoints.length < 3) return;
    e.preventDefault();
    applyPolygonSelection();
    setDrawMode(false);
  }, [drawMode, polygonPoints.length, applyPolygonSelection]);

  // ── Mouse move: preview next vertex ──
  const handleMapMouseMove = useCallback((e: any) => {
    if (!drawMode || polygonPoints.length === 0) return;
    setHoveredPoint([e.lngLat.lng, e.lngLat.lat]);
  }, [drawMode, polygonPoints.length]);

  // ── Start new cluster ──
  const startNewCluster = useCallback(() => {
    setEditingCluster(null);
    setClusterName("");
    setClusterTransferMin(10);
    setClusterColor(CLUSTER_COLORS[clusters.length % CLUSTER_COLORS.length]);
    setSelectedStops(new Set());
    setPolygonPoints([]);
    setHoveredPoint(null);
    setDrawMode(false);
  }, [clusters.length]);

  const startDrawing = useCallback(() => {
    setPolygonPoints([]);
    setHoveredPoint(null);
    setDrawMode(true);
  }, []);

  const clearPolygon = useCallback(() => {
    setPolygonPoints([]);
    setHoveredPoint(null);
    setDrawMode(false);
  }, []);

  const startEditCluster = useCallback((cluster: ClusterData) => {
    setEditingCluster(cluster);
    setClusterName(cluster.name);
    setClusterTransferMin(cluster.transferFromDepotMin);
    setClusterColor(cluster.color);
    setSelectedStops(new Set(cluster.stops.map(s => s.gtfsStopId)));
    setPolygonPoints([]);
    setDrawMode(false);
    if (cluster.stops.length > 0 && mapRef.current) {
      const lats = cluster.stops.map(s => s.stopLat);
      const lons = cluster.stops.map(s => s.stopLon);
      mapRef.current.fitBounds(
        [[Math.min(...lons) - 0.005, Math.min(...lats) - 0.005],
         [Math.max(...lons) + 0.005, Math.max(...lats) + 0.005]],
        { padding: 80, duration: 800 }
      );
    }
  }, []);

  const cancelEdit = useCallback(() => {
    setEditingCluster(null);
    setClusterName("");
    setSelectedStops(new Set());
    setPolygonPoints([]);
    setHoveredPoint(null);
    setDrawMode(false);
  }, []);

  const saveCluster = useCallback(async () => {
    if (!clusterName.trim() || selectedStops.size === 0) return;
    setSaving(true);
    try {
      const stops = [...selectedStops].map(stopId => {
        const s = allStops.find(st => st.stopId === stopId);
        return s ? { gtfsStopId: s.stopId, stopName: s.stopName, stopLat: s.stopLat, stopLon: s.stopLon } : null;
      }).filter(Boolean);
      const body = {
        name: clusterName.trim(),
        transferFromDepotMin: clusterTransferMin,
        color: clusterColor,
        stops,
      };
      if (editingCluster) {
        const updated = await apiFetch<ClusterData>(`/api/clusters/${editingCluster.id}`, {
          method: "PUT", body: JSON.stringify(body),
        });
        setClusters(prev => prev.map(c => c.id === editingCluster.id ? updated : c));
      } else {
        const created = await apiFetch<ClusterData>("/api/clusters", {
          method: "POST", body: JSON.stringify(body),
        });
        setClusters(prev => [...prev, created]);
      }
      cancelEdit();
    } catch (err) {
      console.error("Failed to save cluster:", err);
    } finally {
      setSaving(false);
    }
  }, [clusterName, clusterTransferMin, clusterColor, selectedStops, allStops, editingCluster, cancelEdit]);

  const deleteCluster = useCallback(async (id: string) => {
    try {
      await apiFetch(`/api/clusters/${id}`, { method: "DELETE" });
      setClusters(prev => prev.filter(c => c.id !== id));
    } catch (err) {
      console.error("Failed to delete cluster:", err);
    }
  }, []);

  const saveCompanyCars = useCallback(async () => {
    const val = parseInt(carsInput, 10);
    if (isNaN(val) || val < 0 || val > 50) return;
    try {
      await apiFetch("/api/settings/company-cars", {
        method: "PUT", body: JSON.stringify({ companyCars: val }),
      });
      setCompanyCars(val);
    } catch (err) {
      console.error("Failed to save company cars:", err);
    }
  }, [carsInput]);

  const toggleRoute = useCallback((routeName: string) => {
    setSelectedRoutes(prev => {
      const next = new Set(prev);
      if (next.has(routeName)) next.delete(routeName);
      else next.add(routeName);
      return next;
    });
  }, []);

  // ── Quick filters: select all / deselect all / urbano / extraurbano ──
  const selectAllRoutes = useCallback(() => {
    setSelectedRoutes(new Set(allRoutes.map(r => r.routeShortName)));
  }, [allRoutes]);

  const deselectAllRoutes = useCallback(() => {
    setSelectedRoutes(new Set());
  }, []);

  const selectUrbano = useCallback(() => {
    // Urbano = routes with numeric-starting short names (1, 2, 1/3, 30, 46, etc.)
    setSelectedRoutes(new Set(
      allRoutes.filter(r => /^\d/.test(r.routeShortName)).map(r => r.routeShortName)
    ));
  }, [allRoutes]);

  const selectExtraurbano = useCallback(() => {
    // Extraurbano = routes with letter-starting short names (A, B, CR1, JE1, VI2, etc.)
    setSelectedRoutes(new Set(
      allRoutes.filter(r => /^[a-zA-Z]/.test(r.routeShortName)).map(r => r.routeShortName)
    ));
  }, [allRoutes]);

  // Counts for quick filter badges
  const urbanoCount = useMemo(() => allRoutes.filter(r => /^\d/.test(r.routeShortName)).length, [allRoutes]);
  const extraurbanoCount = useMemo(() => allRoutes.filter(r => /^[a-zA-Z]/.test(r.routeShortName)).length, [allRoutes]);

  const filteredRoutesList = useMemo(() => {
    if (!routeSearch.trim()) return allRoutes;
    const q = routeSearch.toLowerCase();
    return allRoutes.filter(r =>
      r.routeShortName.toLowerCase().includes(q) ||
      (r.routeLongName && r.routeLongName.toLowerCase().includes(q))
    );
  }, [allRoutes, routeSearch]);

  const isEditing = editingCluster !== null || clusterName !== "" || selectedStops.size > 0;

  if (!MAPBOX_TOKEN) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center space-y-4 max-w-md p-8 border border-destructive/20 bg-destructive/5 rounded-2xl">
          <AlertTriangle className="w-12 h-12 text-destructive mx-auto" />
          <h2 className="text-xl font-bold">Mapbox Token Mancante</h2>
          <p className="text-muted-foreground text-sm">Configura VITE_MAPBOX_TOKEN nel file .env</p>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
        <span className="ml-3 text-muted-foreground">Caricamento fermate...</span>
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
            <Grip className="w-5 h-5 text-primary" />
            Gestione Cluster
          </h1>
          <p className="text-xs text-muted-foreground">
            Definisci le zone di cambio in linea disegnando aree sulla mappa
          </p>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* ── Company cars ── */}
          <Card className="border-border/30 bg-background/50">
            <CardContent className="p-4 space-y-3">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <Car className="w-4 h-4 text-primary" />
                Autovetture Aziendali
              </div>
              <div className="flex items-center gap-2">
                <Input
                  type="number" min={0} max={50}
                  value={carsInput}
                  onChange={e => setCarsInput(e.target.value)}
                  className="w-20 h-8 text-center text-sm"
                />
                <span className="text-xs text-muted-foreground flex-1">vetture per trasferimenti</span>
                <Button
                  size="sm" variant="outline" className="h-8"
                  onClick={saveCompanyCars}
                  disabled={parseInt(carsInput) === companyCars}
                >
                  <Save className="w-3 h-3 mr-1" /> Salva
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* ── Route filter ── */}
          <Card className="border-border/30 bg-background/50">
            <CardContent className="p-3 space-y-2">
              <button
                className="flex items-center gap-2 text-sm font-semibold w-full"
                onClick={() => setRouteFilterOpen(!routeFilterOpen)}
              >
                <Filter className="w-4 h-4 text-primary" />
                <span>Filtra per Linea</span>
                {selectedRoutes.size > 0 && (
                  <Badge variant="secondary" className="text-[10px] h-4 px-1.5 ml-auto mr-1">
                    {selectedRoutes.size} selezionate
                  </Badge>
                )}
                {routeFilterOpen ? <ChevronDown className="w-4 h-4 ml-auto" /> : <ChevronRight className="w-4 h-4 ml-auto" />}
              </button>

              <AnimatePresence>
                {routeFilterOpen && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    className="overflow-hidden"
                  >
                    <div className="space-y-2 pt-2">
                      {/* Quick filters: Urbano / Extraurbano / Tutti */}
                      <div className="flex flex-wrap gap-1">
                        <Button
                          size="sm" variant={
                            selectedRoutes.size > 0 &&
                            [...selectedRoutes].every(r => /^\d/.test(r)) &&
                            selectedRoutes.size === urbanoCount
                              ? "default" : "outline"
                          }
                          className="h-6 text-[10px] px-2"
                          onClick={selectUrbano}
                        >
                          <Bus className="w-3 h-3 mr-1" /> Urbano
                          <Badge variant="secondary" className="text-[8px] h-3 px-1 ml-1">{urbanoCount}</Badge>
                        </Button>
                        <Button
                          size="sm" variant={
                            selectedRoutes.size > 0 &&
                            [...selectedRoutes].every(r => /^[a-zA-Z]/.test(r)) &&
                            selectedRoutes.size === extraurbanoCount
                              ? "default" : "outline"
                          }
                          className="h-6 text-[10px] px-2"
                          onClick={selectExtraurbano}
                        >
                          <Bus className="w-3 h-3 mr-1" /> Extraurbano
                          <Badge variant="secondary" className="text-[8px] h-3 px-1 ml-1">{extraurbanoCount}</Badge>
                        </Button>
                        <Button
                          size="sm" variant="outline" className="h-6 text-[10px] px-2"
                          onClick={selectAllRoutes}
                        >
                          Seleziona Tutto
                        </Button>
                        {selectedRoutes.size > 0 && (
                          <Button
                            size="sm" variant="ghost" className="h-6 text-[10px] px-2"
                            onClick={deselectAllRoutes}
                          >
                            <X className="w-3 h-3 mr-1" /> Rimuovi filtri
                          </Button>
                        )}
                      </div>

                      <Input
                        placeholder="Cerca linea..."
                        value={routeSearch}
                        onChange={e => setRouteSearch(e.target.value)}
                        className="h-7 text-xs"
                      />
                      <ScrollArea className="h-48">
                        <div className="space-y-0.5">
                          {filteredRoutesList.map(r => (
                            <label
                              key={r.routeShortName}
                              className="flex items-center gap-2 px-2 py-1 rounded hover:bg-muted/30 cursor-pointer text-xs"
                            >
                              <Checkbox
                                checked={selectedRoutes.has(r.routeShortName)}
                                onCheckedChange={() => toggleRoute(r.routeShortName)}
                                className="h-3.5 w-3.5"
                              />
                              <span
                                className="w-2.5 h-2.5 rounded-full shrink-0"
                                style={{ backgroundColor: r.routeColor ? `#${r.routeColor}` : "#64748b" }}
                              />
                              <span className="font-medium">{r.routeShortName}</span>
                              <span className="text-muted-foreground truncate">{r.routeLongName}</span>
                            </label>
                          ))}
                        </div>
                      </ScrollArea>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </CardContent>
          </Card>

          {/* ── Cluster list ── */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
                Cluster ({clusters.length})
              </h3>
              {!isEditing && (
                <Button size="sm" onClick={startNewCluster} className="h-7 text-xs">
                  <Plus className="w-3 h-3 mr-1" /> Nuovo
                </Button>
              )}
            </div>

            {clusters.length === 0 && !isEditing && (
              <div className="text-center py-8 text-muted-foreground">
                <MapPin className="w-10 h-10 mx-auto mb-2 opacity-30" />
                <p className="text-sm">Nessun cluster definito</p>
                <p className="text-xs mt-1">Clicca &quot;Nuovo&quot; per creare il primo cluster</p>
              </div>
            )}

            <AnimatePresence>
              {clusters.map(cluster => (
                <motion.div
                  key={cluster.id}
                  initial={{ opacity: 0, y: -8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                >
                  <Card className="border-border/30 bg-background/50 hover:bg-background/80 transition-colors">
                    <CardContent className="p-3">
                      <div className="flex items-center gap-2">
                        <div className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: cluster.color }} />
                        <button
                          className="flex-1 text-left"
                          onClick={() => setExpandedCluster(expandedCluster === cluster.id ? null : cluster.id)}
                        >
                          <span className="text-sm font-medium">{cluster.name}</span>
                          <div className="flex items-center gap-2 mt-0.5">
                            <Badge variant="secondary" className="text-[10px] h-4 px-1.5">
                              {cluster.stops.length} fermate
                            </Badge>
                            <span className="text-[10px] text-muted-foreground">
                              {cluster.transferFromDepotMin} min dal deposito
                            </span>
                          </div>
                        </button>
                        {expandedCluster === cluster.id
                          ? <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />
                          : <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
                        }
                      </div>

                      <AnimatePresence>
                        {expandedCluster === cluster.id && (
                          <motion.div
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: "auto", opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            className="overflow-hidden"
                          >
                            <div className="mt-3 pt-3 border-t border-border/20 space-y-2">
                              <ScrollArea className="h-40">
                                {cluster.stops.map(s => (
                                  <div key={s.gtfsStopId} className="text-[11px] text-muted-foreground flex items-center gap-1.5 py-0.5">
                                    <MapPin className="w-2.5 h-2.5 shrink-0" style={{ color: cluster.color }} />
                                    <span className="truncate">{s.stopName}</span>
                                    <span className="text-[9px] opacity-50 ml-auto shrink-0">{s.gtfsStopId}</span>
                                  </div>
                                ))}
                              </ScrollArea>
                              <div className="flex gap-2 pt-2">
                                <Button
                                  size="sm" variant="outline" className="h-7 text-xs flex-1"
                                  onClick={() => startEditCluster(cluster)}
                                  disabled={isEditing}
                                >
                                  <Edit3 className="w-3 h-3 mr-1" /> Modifica
                                </Button>
                                <Button
                                  size="sm" variant="destructive" className="h-7 text-xs"
                                  onClick={() => deleteCluster(cluster.id)}
                                  disabled={isEditing}
                                >
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
              ))}
            </AnimatePresence>
          </div>
        </div>

        {/* ── Bottom editing panel ── */}
        <AnimatePresence>
          {isEditing && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="border-t border-primary/30 bg-primary/5"
            >
              <div className="p-4 space-y-3">
                <div className="flex items-center gap-2 text-sm font-semibold text-primary">
                  <Settings2 className="w-4 h-4" />
                  {editingCluster ? "Modifica Cluster" : "Nuovo Cluster"}
                </div>

                <div className="space-y-1">
                  <Label className="text-xs">Nome cluster</Label>
                  <Input
                    value={clusterName}
                    onChange={e => setClusterName(e.target.value)}
                    placeholder="es. Piazza Cavour"
                    className="h-8 text-sm"
                  />
                </div>

                <div className="flex gap-3">
                  <div className="space-y-1 flex-1">
                    <Label className="text-xs">Min. dal deposito</Label>
                    <Input
                      type="number" min={1} max={60}
                      value={clusterTransferMin}
                      onChange={e => setClusterTransferMin(parseInt(e.target.value) || 10)}
                      className="h-8 text-sm"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Colore</Label>
                    <div className="flex gap-1 flex-wrap">
                      {CLUSTER_COLORS.map(c => (
                        <button
                          key={c}
                          className={`w-5 h-5 rounded-full border-2 transition-all ${
                            clusterColor === c ? "border-white scale-110" : "border-transparent opacity-60 hover:opacity-100"
                          }`}
                          style={{ backgroundColor: c }}
                          onClick={() => setClusterColor(c)}
                        />
                      ))}
                    </div>
                  </div>
                </div>

                <div className="flex gap-2">
                  <Button
                    size="sm" variant={drawMode ? "default" : "outline"} className="h-7 text-xs"
                    onClick={drawMode ? clearPolygon : startDrawing}
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

                <div className="bg-background/50 rounded-lg p-2 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">{selectedStops.size}</span> fermate selezionate
                  {selectedRoutes.size > 0 && (
                    <span className="ml-2 opacity-60">(filtrate per {selectedRoutes.size} linee)</span>
                  )}
                </div>

                <p className="text-[10px] text-muted-foreground leading-relaxed">
                  <strong>Disegna:</strong> Clicca sulla mappa per aggiungere vertici, <strong>doppio-click</strong> per chiudere l&apos;area.
                  <br />
                  <strong>Singola fermata:</strong> Clicca su un punto per aggiungerla/rimuoverla.
                </p>

                <div className="flex gap-2">
                  <Button
                    className="flex-1 h-8 text-xs"
                    onClick={saveCluster}
                    disabled={saving || !clusterName.trim() || selectedStops.size === 0}
                  >
                    {saving ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Save className="w-3 h-3 mr-1" />}
                    {editingCluster ? "Aggiorna" : "Crea Cluster"}
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
          initialViewState={{ longitude: 13.51, latitude: 43.615, zoom: 13, pitch: 0, bearing: 0 }}
          mapStyle="mapbox://styles/mapbox/dark-v11"
          mapboxAccessToken={MAPBOX_TOKEN}
          style={{ width: "100%", height: "100%" }}
          interactiveLayerIds={["stops-layer"]}
          doubleClickZoom={!drawMode}
          onClick={handleMapClick}
          onDblClick={handleMapDblClick}
          onMouseMove={handleMapMouseMove}
          cursor={drawMode ? "crosshair" : "grab"}
        >
          {/* ── All GTFS stops ── */}
          <Source id="all-stops" type="geojson" data={stopsGeoJSON as any}>
            <Layer
              id="stops-layer"
              type="circle"
              paint={{
                "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 2, 13, 4, 16, 7],
                "circle-color": [
                  "case",
                  ["==", ["get", "selected"], 1], clusterColor,
                  ["has", "clusterColor"], ["get", "clusterColor"],
                  "#94a3b8",
                ],
                "circle-opacity": [
                  "case",
                  ["==", ["get", "selected"], 1], 1,
                  ["has", "clusterColor"], 0.7,
                  0.4,
                ],
                "circle-stroke-width": ["case", ["==", ["get", "selected"], 1], 2, 0.5],
                "circle-stroke-color": ["case", ["==", ["get", "selected"], 1], "#ffffff", "#ffffff20"],
              }}
            />
            <Layer
              id="stops-labels"
              type="symbol"
              minzoom={15}
              layout={{
                "text-field": ["get", "stopName"],
                "text-size": 10,
                "text-offset": [0, 1.2],
                "text-anchor": "top",
                "text-max-width": 8,
              }}
              paint={{
                "text-color": "#e2e8f0",
                "text-halo-color": "#0f172a",
                "text-halo-width": 1,
                "text-opacity": ["case", ["==", ["get", "selected"], 1], 1, 0.5],
              }}
            />
          </Source>

          {/* ── Drawing polygon overlay ── */}
          {polygonGeoJSON && (
            <Source id="draw-polygon" type="geojson" data={polygonGeoJSON as any}>
              <Layer
                id="draw-polygon-fill"
                type="fill"
                filter={["==", ["get", "kind"], "fill"]}
                paint={{
                  "fill-color": clusterColor,
                  "fill-opacity": 0.15,
                }}
              />
              <Layer
                id="draw-polygon-stroke"
                type="line"
                paint={{
                  "line-color": clusterColor,
                  "line-width": 2,
                  "line-dasharray": [3, 2],
                  "line-opacity": 0.8,
                }}
              />
            </Source>
          )}

          {/* ── Polygon vertex markers ── */}
          {polygonPoints.map((pt, i) => (
            <Marker key={`vertex-${i}`} longitude={pt[0]} latitude={pt[1]} anchor="center">
              <div
                className="w-3 h-3 rounded-full border-2 border-white shadow-md"
                style={{ backgroundColor: clusterColor }}
              />
            </Marker>
          ))}

          {/* ── Existing cluster center markers ── */}
          {clusters.map(cluster => {
            if (cluster.stops.length === 0) return null;
            const avgLat = cluster.stops.reduce((s, st) => s + st.stopLat, 0) / cluster.stops.length;
            const avgLon = cluster.stops.reduce((s, st) => s + st.stopLon, 0) / cluster.stops.length;
            return (
              <Marker key={cluster.id} longitude={avgLon} latitude={avgLat} anchor="center">
                <div
                  className="flex items-center gap-1 px-2 py-1 rounded-full text-white text-[10px] font-bold shadow-lg cursor-pointer whitespace-nowrap"
                  style={{ backgroundColor: cluster.color + "cc" }}
                  onClick={() => {
                    setExpandedCluster(expandedCluster === cluster.id ? null : cluster.id);
                    mapRef.current?.flyTo({ center: [avgLon, avgLat], zoom: 15, duration: 600 });
                  }}
                >
                  <MapPin className="w-3 h-3" />
                  {cluster.name}
                  <Badge variant="secondary" className="text-[8px] h-3 px-1 bg-white/20 text-white border-0">
                    {cluster.stops.length}
                  </Badge>
                </div>
              </Marker>
            );
          })}
        </MapGL>

        {/* ── Draw mode indicator ── */}
        {drawMode && (
          <div className="absolute top-4 left-1/2 -translate-x-1/2 z-10">
            <motion.div
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              className="bg-primary/90 text-primary-foreground px-4 py-2 rounded-full text-sm font-medium flex items-center gap-2 shadow-lg"
            >
              <Pencil className="w-4 h-4" />
              {polygonPoints.length === 0
                ? "Clicca sulla mappa per iniziare a disegnare"
                : polygonPoints.length < 3
                ? `${polygonPoints.length} vertici — aggiungi almeno ${3 - polygonPoints.length}`
                : `${polygonPoints.length} vertici — doppio-click per chiudere`
              }
            </motion.div>
          </div>
        )}

        {/* ── Stats badge ── */}
        <div className="absolute bottom-4 right-4 z-10 flex gap-2">
          <Badge variant="secondary" className="text-xs bg-background/80 backdrop-blur">
            {filteredStops.length}{selectedRoutes.size > 0 ? ` / ${allStops.length}` : ""} fermate
          </Badge>
          <Badge variant="secondary" className="text-xs bg-background/80 backdrop-blur">
            {clusters.length} cluster
          </Badge>
        </div>
      </div>
    </div>
  );
}
