import React, { useState, useMemo, useCallback, useRef, useEffect } from "react";
import Map, { Source, Layer, Popup, MapMouseEvent, MapRef } from "react-map-gl/mapbox";
import { motion, AnimatePresence } from "framer-motion";
import {
  PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, Tooltip as ReTooltip,
  ResponsiveContainer, RadarChart, PolarGrid, PolarAngleAxis, Radar, Legend as ReLegend,
  CartesianGrid,
} from "recharts";
import {
  Upload, Trash2, Eye, EyeOff, GitCompareArrows, Loader2, Plus, X, ChevronDown, ChevronUp,
  Layers, MapPin, Route, Users, Building2, Satellite, Sun, Moon, Lightbulb, FileUp,
  Ruler, BarChart3, AlertTriangle, CheckCircle2, Info, Play, Clock, Truck, Settings2, Save,
  Ship, Bus, Car, Plane, Zap, MapPinned, Timer, TrainFront,
  Download, Package, CalendarDays, ShieldCheck, CalendarX2, GripVertical, RefreshCw,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { getApiBase, apiFetch } from "@/lib/api";

import type {
  ViewMode, ScenarioItem, ScenarioFull, AnalysisResult, CompareResult, MapPopup,
} from "./scenarios/types";
import {
  MAPBOX_TOKEN, MAP_STYLES, SCENARIO_COLORS, LINE_COLORS,
  POI_CATEGORY_IT, POI_COLOR, POI_ICON, POI_SVG_PATHS,
  renderPoiIcon, DEFAULT_PDE_CONFIG,
} from "./scenarios/constants";

// ─── Component ──────────────────────────────────────────────────────────
export default function ScenariosPage() {
  const mapRef = useRef<MapRef>(null);
  const [mapLoaded, setMapLoaded] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("dark");
  const stopsFileRef = useRef<HTMLInputElement>(null);
  const routeFileRef = useRef<HTMLInputElement>(null);

  // Scenario state
  const [scenarioList, setScenarioList] = useState<ScenarioItem[]>([]);
  const [loadedScenarios, setLoadedScenarios] = useState<Record<string, ScenarioFull>>({});
  const [visibleIds, setVisibleIds] = useState<Set<string>>(new Set());
  const [selectedForCompare, setSelectedForCompare] = useState<string[]>([]);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadName, setUploadName] = useState("");
  const [stopsFile, setStopsFile] = useState<File | null>(null);
  const [routeFile, setRouteFile] = useState<File | null>(null);

  // Analysis state
  const [analysisResult, setAnalysisResult] = useState<AnalysisResult | null>(null);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [compareResult, setCompareResult] = useState<CompareResult | null>(null);
  const [compareLoading, setCompareLoading] = useState(false);
  const [analysisRadius, setAnalysisRadius] = useState(0.5);

  // POI state
  const [showPoi, setShowPoi] = useState(true);
  const [poiData, setPoiData] = useState<any>(null);
  const [selectedPoiCats, setSelectedPoiCats] = useState<string[]>(Object.keys(POI_COLOR));

  // Panels
  const [scenarioPanelCollapsed, setScenarioPanelCollapsed] = useState(false);
  const [analysisPanelOpen, setAnalysisPanelOpen] = useState(false);
  const [legendCollapsed, setLegendCollapsed] = useState(true);

  // ── PdE (Programma di Esercizio) state ──
  const [pdePanelOpen, setPdePanelOpen] = useState(false);
  const [pdeLoading, setPdeLoading] = useState(false);
  const [pdeResult, setPdeResult] = useState<any | null>(null);
  const [pdeScenarioId, setPdeScenarioId] = useState<string | null>(null);
  const [pdeConfig, setPdeConfig] = useState({
    targetKm: 500,
    serviceStartH: 6,
    serviceEndH: 22,
    minCadenceMin: 10,
    maxCadenceMin: 60,
    avgSpeedKmh: 20,
    dwellTimeSec: 25,
    terminalTimeSec: 300,
    bidirectional: true,
  });
  const [pdeSavedList, setPdeSavedList] = useState<any[]>([]);
  const [pdeTab, setPdeTab] = useState<"config" | "result" | "gantt" | "ttd" | "gtfs">("config");
  const [pdeSelectedLine, setPdeSelectedLine] = useState<number>(-1); // -1 = all lines
  const [pdeKmSuggestion, setPdeKmSuggestion] = useState<any>(null);
  const [pdeTtdLines, setPdeTtdLines] = useState<number[]>([]); // multi-line selection for TTD

  // Phase 17: Enhanced PdE config state
  const [coincidenceZonesList, setCoincidenceZonesList] = useState<any[]>([]); // all available zones
  const [selectedZoneIds, setSelectedZoneIds] = useState<string[]>([]); // selected zone IDs for PdE
  const [selectedPoiCategories, setSelectedPoiCategories] = useState<string[]>([]); // POI categories
  const [lineTravelTimes, setLineTravelTimes] = useState<Record<string, number>>({}); // lineIndex -> minutes (legacy)
  const [stopTransitTimes, setStopTransitTimes] = useState<Record<string, number[]>>({}); // lineIndex -> per-stop transit mins
  const [lineStopsData, setLineStopsData] = useState<any[]>([]); // full line-stops data from backend
  const [lineStopsLoading, setLineStopsLoading] = useState(false);
  const [expandedLineIdx, setExpandedLineIdx] = useState<number | null>(null); // which line is expanded for editing
  const [useTrafficSlowdown, setUseTrafficSlowdown] = useState(true);
  const [scenarioLines, setScenarioLines] = useState<{ name: string; lengthKm: number }[]>([]);
  const [dragIdx, setDragIdx] = useState<number | null>(null); // drag & drop: index being dragged

  // ── GTFS Export state ──
  const [gtfsCalendars, setGtfsCalendars] = useState<any[]>([]);
  const [gtfsCalLoading, setGtfsCalLoading] = useState(false);
  const [gtfsValidation, setGtfsValidation] = useState<any | null>(null);
  const [gtfsValidating, setGtfsValidating] = useState(false);
  const [gtfsExporting, setGtfsExporting] = useState(false);
  const [gtfsEditingCal, setGtfsEditingCal] = useState<string | null>(null); // calId being edited
  const [gtfsNewExcDate, setGtfsNewExcDate] = useState("");
  const [gtfsNewExcDesc, setGtfsNewExcDesc] = useState("");
  const [gtfsNewExcType, setGtfsNewExcType] = useState(2); // 2=removed, 1=added

  // Popup
  const [popup, setPopup] = useState<{ lng: number; lat: number; type: string; props: Record<string, any> } | null>(null);
  const [cursor, setCursor] = useState("grab");

  const is3D = viewMode === "city3d" || viewMode === "city3d-dark";
  const isStandardStyle = viewMode === "city3d" || viewMode === "city3d-dark";

  // ─── Data fetching ──────────────────────────────────────────────
  const fetchScenarios = useCallback(async () => {
    try {
      const d = await apiFetch<{ data: ScenarioItem[] }>("/api/scenarios");
      setScenarioList(d.data || []);
    } catch (err) {
      console.error("Errore caricamento scenari:", err);
    }
  }, []);

  useEffect(() => { fetchScenarios(); }, [fetchScenarios]);

  // Fetch POI
  useEffect(() => {
    if (!showPoi || poiData) return;
    fetch(`${getApiBase()}/api/poi`).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); }).then(d => setPoiData(d)).catch(err => console.error("Errore caricamento POI:", err));
  }, [showPoi, poiData]);

  // Load scenario geojson when toggled visible
  const loadedScenariosRef = useRef(loadedScenarios);
  loadedScenariosRef.current = loadedScenarios;

  const loadScenario = useCallback(async (id: string) => {
    if (loadedScenariosRef.current[id]) return;
    try {
      const data = await apiFetch<ScenarioFull>(`/api/scenarios/${id}`);
      setLoadedScenarios(prev => ({ ...prev, [id]: data }));
    } catch (err) {
      console.error(`Errore caricamento scenario ${id}:`, err);
    }
  }, []);

  const toggleVisibility = useCallback(async (id: string) => {
    const newSet = new Set(visibleIds);
    if (newSet.has(id)) {
      newSet.delete(id);
    } else {
      newSet.add(id);
      await loadScenario(id);
    }
    setVisibleIds(newSet);
  }, [visibleIds, loadScenario]);

  const toggleCompareSelection = useCallback((id: string) => {
    setSelectedForCompare(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : prev.length < 2 ? [...prev, id] : [prev[1], id]
    );
  }, []);

  // Upload (2 file: fermate + percorso)
  const handleUpload = useCallback(async () => {
    if (!stopsFile && !routeFile) {
      alert("Seleziona almeno un file (fermate e/o percorso).");
      return;
    }
    setUploading(true);
    try {
      const formData = new FormData();
      if (stopsFile) formData.append("stopsFile", stopsFile);
      if (routeFile) formData.append("routeFile", routeFile);
      const defaultName = routeFile?.name || stopsFile?.name || "Scenario";
      formData.append("name", uploadName || defaultName.replace(/\.(kml|kmz)$/i, ""));
      formData.append("color", SCENARIO_COLORS[scenarioList.length % SCENARIO_COLORS.length]);

      const r = await fetch(`${getApiBase()}/api/scenarios/upload`, { method: "POST", body: formData });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${r.status}`);
      }
      const data = await r.json();
      await fetchScenarios();
      // Auto-load and show the new scenario
      setLoadedScenarios(prev => ({ ...prev, [data.id]: data }));
      setVisibleIds(prev => new Set([...prev, data.id]));
      setUploadName("");
      setStopsFile(null);
      setRouteFile(null);
    } catch (err: any) {
      alert(`Errore upload: ${err.message}`);
    } finally {
      setUploading(false);
    }
  }, [uploadName, stopsFile, routeFile, scenarioList.length, fetchScenarios]);

  // Delete — primo click: segna per conferma; secondo click: esegue
  const pendingDeleteRef = useRef<string | null>(null);
  const handleDelete = useCallback(async (id: string) => {
    if (pendingDeleteId !== id) {
      // Primo click → chiedi conferma (icona diventa rossa pulsante)
      setPendingDeleteId(id);
      pendingDeleteRef.current = id;
      setTimeout(() => {
        if (pendingDeleteRef.current === id) {
          setPendingDeleteId(null);
          pendingDeleteRef.current = null;
        }
      }, 4000);
      return;
    }
    // Secondo click → esegui DELETE
    setPendingDeleteId(null);
    pendingDeleteRef.current = null;
    try {
      const resp = await fetch(`${getApiBase()}/api/scenarios/${id}`, { method: "DELETE" });
      if (!resp.ok) {
        console.error("Delete failed:", resp.status, await resp.text());
        return;
      }
    } catch (err) {
      console.error("Delete fetch error:", err);
      return;
    }
    setVisibleIds(prev => { const s = new Set(prev); s.delete(id); return s; });
    setLoadedScenarios(prev => { const c = { ...prev }; delete c[id]; return c; });
    setSelectedForCompare(prev => prev.filter(x => x !== id));
    // Aggiorna la lista immediatamente rimuovendo lo scenario dalla UI
    setScenarioList(prev => prev.filter(s => s.id !== id));
    await fetchScenarios();
  }, [fetchScenarios, pendingDeleteId]);

  // Reimport stops from KML file for an existing scenario
  const reimportInputRef = useRef<HTMLInputElement>(null);
  const [reimportTargetId, setReimportTargetId] = useState<string | null>(null);
  const [reimportLoading, setReimportLoading] = useState(false);
  const handleReimportStops = useCallback((scenarioId: string) => {
    setReimportTargetId(scenarioId);
    reimportInputRef.current?.click();
  }, []);
  const onReimportFileSelected = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !reimportTargetId) return;
    setReimportLoading(true);
    try {
      const formData = new FormData();
      formData.append("stopsFile", file);
      const resp = await fetch(`${getApiBase()}/api/scenarios/${reimportTargetId}/reimport-stops`, {
        method: "POST", body: formData,
      });
      if (!resp.ok) {
        const errData = await resp.json().catch(() => ({ error: "Errore sconosciuto" }));
        throw new Error(errData.error || `HTTP ${resp.status}`);
      }
      const result = await resp.json();
      alert(`✅ Reimportate ${result.stopsCount} fermate con successo!`);
      // Refresh scenario data
      await fetchScenarios();
      // Clear loaded scenario to force reload of GeoJSON
      setLoadedScenarios(prev => { const c = { ...prev }; delete c[reimportTargetId]; return c; });
    } catch (err: any) {
      alert(`Errore reimport fermate: ${err.message}`);
    } finally {
      setReimportLoading(false);
      setReimportTargetId(null);
      if (reimportInputRef.current) reimportInputRef.current.value = "";
    }
  }, [reimportTargetId, fetchScenarios]);

  // Analyze single scenario
  const runAnalysis = useCallback(async (id: string) => {
    setAnalysisLoading(true);
    setAnalysisResult(null);
    setCompareResult(null);
    setAnalysisPanelOpen(true);
    try {
      const data = await apiFetch<AnalysisResult>(`/api/scenarios/${id}/analyze?radius=${analysisRadius}`);
      setAnalysisResult(data);
    } catch (err: any) {
      console.error("Errore analisi scenario:", err);
      alert(`Errore nell'analisi: ${err.message}`);
    } finally {
      setAnalysisLoading(false);
    }
  }, [analysisRadius]);

  // Compare scenarios
  const runCompare = useCallback(async () => {
    if (selectedForCompare.length < 2) return;
    setCompareLoading(true);
    setCompareResult(null);
    setAnalysisResult(null);
    setAnalysisPanelOpen(true);
    try {
      const data = await apiFetch<CompareResult>(`/api/scenarios/compare?ids=${selectedForCompare.join(",")}&radius=${analysisRadius}`);
      setCompareResult(data);
    } catch (err: any) {
      console.error("Errore confronto scenari:", err);
      alert(`Errore nel confronto: ${err.message}`);
    } finally {
      setCompareLoading(false);
    }
  }, [selectedForCompare, analysisRadius]);

  // ── PdE functions ──
  const openPdePanel = useCallback(async (scenarioId: string) => {
    setPdeScenarioId(scenarioId);
    setPdeResult(null);
    setPdeTab("config");
    setPdePanelOpen(true);
    setPdeKmSuggestion(null);
    setPdeTtdLines([]);
    setSelectedZoneIds([]);
    setLineTravelTimes({});
    setStopTransitTimes({});
    setLineStopsData([]);
    setExpandedLineIdx(null);
    // Load saved programs + km suggestion + coincidence zones + scenario lines in parallel
    try {
      const [listData, kmData, zonesData] = await Promise.all([
        apiFetch<{ programs: any[] }>(`/api/scenarios/${scenarioId}/programs`),
        apiFetch<any>(`/api/scenarios/${scenarioId}/suggest-km`).catch(() => null),
        apiFetch<any>(`/api/coincidence-zones`).catch(() => ({ data: [] })),
      ]);
      setPdeSavedList(listData.programs || []);
      setCoincidenceZonesList(Array.isArray(zonesData?.data) ? zonesData.data : Array.isArray(zonesData) ? zonesData : []);
      if (kmData) {
        setPdeKmSuggestion(kmData);
        setPdeConfig(prev => ({ ...prev, targetKm: kmData.suggestedKm }));
        // Extract line names from breakdown
        if (kmData.breakdown?.lines) {
          setScenarioLines(kmData.breakdown.lines);
          // Initialize travel times to 0 (= use default avgSpeedKmh)
          const initTimes: Record<string, number> = {};
          kmData.breakdown.lines.forEach((_: any, i: number) => { initTimes[String(i)] = 0; });
          setLineTravelTimes(initTimes);
        }
      }
    } catch { setPdeSavedList([]); }
  }, []);

  const generatePde = useCallback(async () => {
    if (!pdeScenarioId) return;
    setPdeLoading(true);
    setPdeResult(null);
    try {
      // Phase 17: Build enhanced config with zone IDs, POI categories, travel times
      const enhancedConfig = {
        ...pdeConfig,
        coincidenceZoneIds: selectedZoneIds.length > 0 ? selectedZoneIds : undefined,
        selectedPoiCategories: selectedPoiCategories.length > 0 ? selectedPoiCategories : undefined,
        lineTravelTimes: Object.entries(lineTravelTimes).some(([_, v]) => v > 0)
          ? Object.fromEntries(Object.entries(lineTravelTimes).filter(([_, v]) => v > 0))
          : undefined,
        stopTransitTimes: Object.entries(stopTransitTimes).some(([_, arr]) => arr.some(v => v > 0))
          ? Object.fromEntries(Object.entries(stopTransitTimes).filter(([_, arr]) => arr.some(v => v > 0)))
          : undefined,
        useTrafficSlowdown,
        // Send user-reordered stops per line (from drag & drop)
        stopOrder: lineStopsData.length > 0
          ? Object.fromEntries(lineStopsData.map(ld => [
              String(ld.lineIndex),
              ld.stops.map((s: any) => ({ name: s.name, stopId: s.stopId || "", lng: s.lng, lat: s.lat })),
            ]))
          : undefined,
      };
      const resp = await fetch(`${getApiBase()}/api/scenarios/${pdeScenarioId}/generate-program`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(enhancedConfig),
      });
      if (!resp.ok) { const e = await resp.json().catch(() => ({})); throw new Error(e.error || `HTTP ${resp.status}`); }
      const data = await resp.json();
      setPdeResult(data);
      setPdeTab("result");
      // Refresh saved list
      const list = await apiFetch<{ programs: any[] }>(`/api/scenarios/${pdeScenarioId}/programs`);
      setPdeSavedList(list.programs || []);
    } catch (err: any) {
      alert(`Errore generazione PdE: ${err.message}`);
    } finally { setPdeLoading(false); }
  }, [pdeScenarioId, pdeConfig, selectedZoneIds, selectedPoiCategories, lineTravelTimes, stopTransitTimes, useTrafficSlowdown, lineStopsData]);

  const loadPdeProgram = useCallback(async (programId: string) => {
    if (!pdeScenarioId) return;
    setPdeLoading(true);
    try {
      const data = await apiFetch<any>(`/api/scenarios/${pdeScenarioId}/programs/${programId}`);
      setPdeResult(data);
      setPdeTab("result");
    } catch (err: any) { alert(`Errore: ${err.message}`); }
    finally { setPdeLoading(false); }
  }, [pdeScenarioId]);

  const [pdeConfirmDelete, setPdeConfirmDelete] = useState<string | null>(null);
  const [pdeDeleting, setPdeDeleting] = useState<string | null>(null);

  // First click: show confirm. Second click: actually delete.
  const deletePdeProgram = useCallback(async (programId: string, confirmed: boolean) => {
    if (!pdeScenarioId || pdeDeleting) return;
    if (!confirmed) {
      // First click — ask confirmation
      setPdeConfirmDelete(programId);
      // Auto-cancel after 3 seconds
      setTimeout(() => setPdeConfirmDelete(prev => prev === programId ? null : prev), 3000);
      return;
    }
    // Second click — confirmed, do the delete
    setPdeConfirmDelete(null);
    setPdeDeleting(programId);
    // Optimistic: remove from list immediately
    const backup = [...pdeSavedList];
    setPdeSavedList(prev => prev.filter(p => p.id !== programId));
    if (pdeResult?.id === programId) setPdeResult(null);
    try {
      const resp = await fetch(`${getApiBase()}/api/scenarios/${pdeScenarioId}/programs/${programId}`, { method: "DELETE" });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    } catch (err: any) {
      console.error("Delete failed:", err);
      // Rollback on failure
      setPdeSavedList(backup);
      alert(`Errore eliminazione: ${err.message}`);
    } finally { setPdeDeleting(null); }
  }, [pdeScenarioId, pdeResult, pdeDeleting, pdeSavedList]);

  // ─── Map data ────────────────────────────────────────────────────
  const poiGeojson = useMemo(() => {
    if (!poiData?.data) return null;
    return {
      type: "FeatureCollection",
      features: poiData.data
        .filter((p: any) => selectedPoiCats.includes(p.category ?? ""))
        .map((p: any) => ({
          type: "Feature",
          geometry: { type: "Point", coordinates: [p.lng, p.lat] },
          properties: { category: p.category, name: p.name },
        })),
    };
  }, [poiData, selectedPoiCats]);

  const interactiveLayers = useMemo(() => {
    const ids: string[] = [];
    if (showPoi && poiGeojson) ids.push("poi-points");
    for (const id of visibleIds) {
      ids.push(`scenario-stops-${id}`);
      ids.push(`scenario-line-${id}`);
    }
    return ids;
  }, [showPoi, poiGeojson, visibleIds]);

  // ─── Map callbacks ──────────────────────────────────────────────
  const registerPoiImages = useCallback((m: any) => {
    for (const cat of Object.keys(POI_COLOR)) {
      const id = `poi-${cat}`;
      if (!m.hasImage(id)) m.addImage(id, renderPoiIcon(cat), { pixelRatio: 2 });
    }
  }, []);

  const handleMapLoad = useCallback(() => {
    setMapLoaded(true);
    const m = mapRef.current?.getMap();
    if (m) registerPoiImages(m);
  }, [registerPoiImages]);

  const handleStyleData = useCallback(() => {
    const m = mapRef.current?.getMap();
    if (m) {
      registerPoiImages(m);
      if (isStandardStyle) {
        try { (m as any).setConfigProperty?.("basemap", "lightPreset", viewMode === "city3d-dark" ? "dusk" : "day"); } catch {}
      }
    }
    if (!is3D) return;
    setTimeout(() => { try { m?.setTerrain({ source: "mapbox-dem", exaggeration: 1.5 }); } catch {} }, 300);
  }, [is3D, isStandardStyle, viewMode, registerPoiImages]);

  // 3D terrain
  useEffect(() => {
    if (!mapLoaded) return;
    const m = mapRef.current?.getMap();
    if (!m) return;
    const apply = () => {
      try {
        if (is3D) { m.setTerrain({ source: "mapbox-dem", exaggeration: 1.5 }); m.easeTo({ pitch: 50, bearing: -14, duration: 900 }); }
        else { m.setTerrain(null); m.easeTo({ pitch: 0, bearing: 0, duration: 900 }); }
      } catch {}
    };
    const t = setTimeout(apply, 150);
    return () => clearTimeout(t);
  }, [is3D, mapLoaded]);

  // Style preset
  useEffect(() => {
    if (!mapLoaded || !isStandardStyle) return;
    const m = mapRef.current?.getMap() as any;
    if (!m) return;
    try {
      if (viewMode === "city3d-dark") {
        m.setConfigProperty?.("basemap", "lightPreset", "dusk");
        m.setConfigProperty?.("basemap", "showPointOfInterestLabels", false);
        m.setConfigProperty?.("basemap", "showTransitLabels", false);
        m.setFog?.({ range: [2, 14], color: "rgba(20,15,30,0.6)", "high-color": "rgba(40,25,60,0.5)", "horizon-blend": 0.06, "star-intensity": 0.35, "space-color": "rgba(8,5,18,1)" });
      } else {
        m.setConfigProperty?.("basemap", "lightPreset", "day");
        m.setConfigProperty?.("basemap", "showPointOfInterestLabels", true);
        m.setConfigProperty?.("basemap", "showTransitLabels", true);
        m.setFog?.(null);
      }
    } catch {}
  }, [viewMode, mapLoaded, isStandardStyle]);

  const handleMapClick = useCallback((e: MapMouseEvent) => {
    const feature = (e as any).features?.[0];
    if (!feature) { setPopup(null); return; }
    const layerId: string = feature.layer?.id || "";
    const props = feature.properties || {};
    if (layerId === "poi-points") {
      setPopup({ lng: e.lngLat.lng, lat: e.lngLat.lat, type: "poi", props });
    } else if (layerId.startsWith("scenario-stops-")) {
      const [lng, lat] = (feature.geometry as any).coordinates;
      setPopup({ lng, lat, type: "stop", props });
    } else if (layerId.startsWith("scenario-line-")) {
      setPopup({ lng: e.lngLat.lng, lat: e.lngLat.lat, type: "route", props });
    }
  }, []);

  const handleMouseMove = useCallback((e: MapMouseEvent) => {
    setCursor((e as any).features?.[0] ? "pointer" : "grab");
  }, []);

  // Radar chart data for compare
  const radarData = useMemo(() => {
    if (!compareResult) return null;
    const s = compareResult.scenarios;
    return [
      { metric: "Copertura POI", [s[0].name]: s[0].poiCoverage.percent, [s[1].name]: s[1].poiCoverage.percent },
      { metric: "Copertura Pop.", [s[0].name]: s[0].populationCoverage.percent, [s[1].name]: s[1].populationCoverage.percent },
      { metric: "Accessibilità", [s[0].name]: s[0].accessibilityScore, [s[1].name]: s[1].accessibilityScore },
      { metric: "Efficienza", [s[0].name]: Math.min(100, s[0].efficiency.popPerKm / 50), [s[1].name]: Math.min(100, s[1].efficiency.popPerKm / 50) },
      { metric: "Fermate", [s[0].name]: Math.min(100, (s[0].stopsCount / Math.max(s[0].stopsCount, s[1].stopsCount)) * 100), [s[1].name]: Math.min(100, (s[1].stopsCount / Math.max(s[0].stopsCount, s[1].stopsCount)) * 100) },
      { metric: "Comuni", [s[0].name]: Math.min(100, (s[0].comuniDetails.length / Math.max(s[0].comuniDetails.length, s[1].comuniDetails.length)) * 100), [s[1].name]: Math.min(100, (s[1].comuniDetails.length / Math.max(s[0].comuniDetails.length, s[1].comuniDetails.length)) * 100) },
    ];
  }, [compareResult]);

  // POI per-category grouped bar data for compare
  const comparePOICatData = useMemo(() => {
    if (!compareResult) return null;
    const [a, b] = compareResult.scenarios;
    const allCats = new Set([...Object.keys(a.poiCoverage.byCategory), ...Object.keys(b.poiCoverage.byCategory)]);
    return Array.from(allCats)
      .map(cat => {
        const ca = a.poiCoverage.byCategory[cat] || { total: 0, covered: 0 };
        const cb = b.poiCoverage.byCategory[cat] || { total: 0, covered: 0 };
        return {
          category: POI_CATEGORY_IT[cat] || cat,
          [a.name]: ca.total > 0 ? Math.round((ca.covered / ca.total) * 100) : 0,
          [b.name]: cb.total > 0 ? Math.round((cb.covered / cb.total) * 100) : 0,
          totA: ca.total, totB: cb.total,
        };
      })
      .sort((x, y) => Math.max(y.totA, y.totB) - Math.max(x.totA, x.totB));
  }, [compareResult]);

  // Comuni population bar data for compare
  const compareComuniData = useMemo(() => {
    if (!compareResult) return null;
    const [a, b] = compareResult.scenarios;
    const comuniMap: Record<string, Record<string, any>> = {};
    for (const c of a.comuniDetails) {
      comuniMap[c.code] = { name: c.name, [`${a.name} coperta`]: c.coveredPop, [`${a.name} non coperta`]: c.totalPop - c.coveredPop, totalPop: c.totalPop };
    }
    for (const c of b.comuniDetails) {
      const existing = comuniMap[c.code] || { name: c.name, totalPop: c.totalPop };
      existing[`${b.name} coperta`] = c.coveredPop;
      existing[`${b.name} non coperta`] = c.totalPop - c.coveredPop;
      if (!existing.totalPop || c.totalPop > existing.totalPop) existing.totalPop = c.totalPop;
      comuniMap[c.code] = existing;
    }
    return Object.values(comuniMap).sort((x, y) => y.totalPop - x.totalPop);
  }, [compareResult]);

  // Score breakdown data for analysis and compare
  // Must match backend formula: 35% pop, 30% poi, 20% distribution, 15% efficiency
  const scoreBreakdown = useCallback((result: AnalysisResult) => {
    const popScore = Math.min(100, result.populationCoverage.percent * 1.3);
    const poiScore = Math.min(100, result.poiCoverage.percent * 1.3);
    const sd = result.stopDistribution;
    const distScore = sd
      ? Math.max(0, Math.min(100, 100
          - Math.min(40, sd.gapsOver1km * 5)
          - Math.min(20, (sd.stopsWithin300m / Math.max(1, sd.stopsWithin300m + sd.gapsOver1km + 10)) * 15)
        ))
      : 60;
    const effScore = Math.min(100, (result.efficiencyMetrics.popPerKm / 500) * 100);
    return [
      { factor: "Popolazione (35%)", value: Math.round(popScore), weight: 35, color: "#3b82f6" },
      { factor: "POI (30%)", value: Math.round(poiScore), weight: 30, color: "#22c55e" },
      { factor: "Distribuzione (20%)", value: Math.round(distScore), weight: 20, color: "#f59e0b" },
      { factor: "Efficienza (15%)", value: Math.round(effScore), weight: 15, color: "#a855f7" },
    ];
  }, []);

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
      {/* ── Map ──────────────────────────────────────────────── */}
      <Map
        ref={mapRef}
        initialViewState={{ longitude: 13.45, latitude: 43.58, zoom: 10 }}
        mapStyle={MAP_STYLES[viewMode]}
        mapboxAccessToken={MAPBOX_TOKEN}
        style={{ width: "100%", height: "100%" }}
        interactiveLayerIds={interactiveLayers}
        cursor={cursor}
        onClick={handleMapClick}
        onMouseMove={handleMouseMove}
        onLoad={handleMapLoad}
        onStyleData={handleStyleData}
      >
        <Source id="mapbox-dem" type="raster-dem" url="mapbox://mapbox.mapbox-terrain-dem-v1" tileSize={512} maxzoom={14} />
        <Layer id="sky" type="sky" paint={{
          "sky-type": "atmosphere",
          "sky-atmosphere-sun": viewMode === "city3d" ? [0, 75] : viewMode === "city3d-dark" ? [0, 0] : [0, 90],
          "sky-atmosphere-sun-intensity": viewMode === "city3d" ? 8 : viewMode === "city3d-dark" ? 3 : 12,
          "sky-atmosphere-color": viewMode === "city3d-dark" ? "rgba(30,18,48,1)" : viewMode === "dark" ? "rgba(8,12,28,1)" : "rgba(85,140,200,1)",
        }} />

        {/* POI */}
        {showPoi && poiGeojson && (
          <Source type="geojson" data={poiGeojson as any}>
            <Layer id="poi-glow" type="circle" paint={{
              "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 14, 14, 22],
              "circle-color": ["match", ["get", "category"],
                "school", "#eab308", "hospital", "#ef4444", "shopping", "#a855f7",
                "industrial", "#f97316", "leisure", "#22c55e", "office", "#3b82f6", "transit", "#06b6d4",
                "workplace", "#64748b", "worship", "#d946ef", "elderly", "#f43f5e", "parking", "#94a3b8", "tourism", "#14b8a6",
                "#888888"],
              "circle-opacity": 0.15, "circle-blur": 1,
            }} />
            <Layer id="poi-points" type="symbol" layout={{
              "icon-image": ["concat", "poi-", ["get", "category"]],
              "icon-size": ["interpolate", ["linear"], ["zoom"], 8, 0.35, 12, 0.55, 16, 0.75],
              "icon-allow-overlap": true, "icon-ignore-placement": true,
            }} paint={{ "icon-opacity": 0.95 }} />
          </Source>
        )}

        {/* Scenario layers */}
        {Array.from(visibleIds).map(id => {
          const scenario = loadedScenarios[id];
          if (!scenario?.geojson) return null;
          const color = scenario.color || "#3b82f6";

          // Split geojson into lines and points
          const lines = {
            type: "FeatureCollection" as const,
            features: scenario.geojson.features.filter((f: any) =>
              f.geometry.type === "LineString" || f.geometry.type === "MultiLineString"
            ),
          };
          const points = {
            type: "FeatureCollection" as const,
            features: scenario.geojson.features.filter((f: any) => f.geometry.type === "Point"),
          };

          return (
            <React.Fragment key={id}>
              {lines.features.length > 0 && (
                <Source id={`scenario-lines-src-${id}`} type="geojson" data={lines as any}>
                  <Layer id={`scenario-outline-${id}`} type="line" paint={{
                    "line-width": ["interpolate", ["linear"], ["zoom"], 9, 4, 14, 10],
                    "line-color": "#000", "line-opacity": 0.25,
                  }} layout={{ "line-cap": "round", "line-join": "round" }} />
                  <Layer id={`scenario-line-${id}`} type="line" paint={{
                    "line-width": ["interpolate", ["linear"], ["zoom"], 9, 2.5, 12, 5, 14, 8],
                    "line-color": color, "line-opacity": 0.9,
                  }} layout={{ "line-cap": "round", "line-join": "round" }} />
                </Source>
              )}
              {points.features.length > 0 && (
                <Source id={`scenario-stops-src-${id}`} type="geojson" data={points as any}>
                  <Layer id={`scenario-stops-${id}`} type="circle" paint={{
                    "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 4, 14, 10],
                    "circle-color": color, "circle-stroke-width": 2, "circle-stroke-color": "#fff", "circle-opacity": 1,
                  }} />
                </Source>
              )}
            </React.Fragment>
          );
        })}

        {/* Popup */}
        {popup && (
          <Popup longitude={popup.lng} latitude={popup.lat} onClose={() => setPopup(null)} closeOnClick={false} maxWidth="280px" style={{ zIndex: 100 }}>
            {popup.type === "poi" && (
              <div className="space-y-1 min-w-[180px]">
                <div className="font-bold text-sm text-gray-900">{popup.props.name}</div>
                <div className="text-xs text-gray-500">{POI_CATEGORY_IT[popup.props.category] || popup.props.category}</div>
              </div>
            )}
            {popup.type === "stop" && (
              <div className="space-y-1 min-w-[180px]">
                <div className="font-bold text-sm text-gray-900">📍 {popup.props.name || "Fermata"}</div>
                {popup.props.stopId && <div className="text-[10px] text-gray-400 font-mono">ID: {popup.props.stopId}</div>}
                {popup.props.description && <div className="text-xs text-gray-500">{popup.props.description}</div>}
              </div>
            )}
            {popup.type === "route" && (
              <div className="space-y-1 min-w-[180px]">
                <div className="font-bold text-sm text-gray-900">🚌 {popup.props.name || "Percorso"}</div>
                {popup.props.description && <div className="text-xs text-gray-500">{popup.props.description}</div>}
              </div>
            )}
          </Popup>
        )}
      </Map>

      {/* ── Scenario Panel — top left ───────────────────────── */}
      <div className="absolute top-4 left-4 md:w-80 pointer-events-none z-10">
        <motion.div initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }} className="pointer-events-auto">
          <Card className="bg-card/90 backdrop-blur-xl border-border/50 shadow-2xl overflow-hidden">
            <button onClick={() => setScenarioPanelCollapsed(v => !v)}
              className="w-full p-3 flex items-center justify-between hover:bg-muted/20 transition-colors">
              <span className="flex items-center gap-2 text-sm font-bold">
                <Route className="w-4 h-4 text-primary" />
                Scenari Pianificazione
                {scenarioList.length > 0 && (
                  <Badge className="text-[10px] h-4 px-1.5">{scenarioList.length}</Badge>
                )}
              </span>
              {scenarioPanelCollapsed ? <ChevronDown className="w-4 h-4 text-muted-foreground" /> : <ChevronUp className="w-4 h-4 text-muted-foreground" />}
            </button>

            <AnimatePresence initial={false}>
              {!scenarioPanelCollapsed && (
                <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2 }} className="overflow-hidden">
                  <CardContent className="px-3 pb-3 pt-0 space-y-3 border-t border-border/30">
                    {/* Upload area — 2 file separati */}
                    <div className="space-y-2 pt-2">
                      <input type="text" value={uploadName} onChange={e => setUploadName(e.target.value)}
                        placeholder="Nome scenario (opzionale)"
                        className="w-full px-3 py-1.5 text-xs bg-muted rounded-lg border border-border/40 focus:outline-none focus:ring-1 focus:ring-primary" />

                      {/* Stops file */}
                      <input ref={stopsFileRef} type="file" accept=".kml,.kmz" className="hidden"
                        onChange={e => { if (e.target.files?.[0]) setStopsFile(e.target.files[0]); e.target.value = ""; }} />
                      <button onClick={() => stopsFileRef.current?.click()}
                        className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg border-2 border-dashed text-xs font-medium transition-all ${
                          stopsFile
                            ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-400"
                            : "border-primary/20 hover:border-primary/50 bg-muted/30 text-muted-foreground hover:text-foreground"
                        }`}>
                        <MapPin className="w-4 h-4 shrink-0" />
                        <span className="flex-1 text-left truncate">
                          {stopsFile ? stopsFile.name : "📍 File Fermate (.kml / .kmz)"}
                        </span>
                        {stopsFile && (
                          <X className="w-3.5 h-3.5 text-muted-foreground hover:text-red-400 shrink-0"
                            onClick={e => { e.stopPropagation(); setStopsFile(null); }} />
                        )}
                      </button>

                      {/* Route file */}
                      <input ref={routeFileRef} type="file" accept=".kml,.kmz" className="hidden"
                        onChange={e => { if (e.target.files?.[0]) setRouteFile(e.target.files[0]); e.target.value = ""; }} />
                      <button onClick={() => routeFileRef.current?.click()}
                        className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg border-2 border-dashed text-xs font-medium transition-all ${
                          routeFile
                            ? "border-blue-500/50 bg-blue-500/10 text-blue-400"
                            : "border-primary/20 hover:border-primary/50 bg-muted/30 text-muted-foreground hover:text-foreground"
                        }`}>
                        <Route className="w-4 h-4 shrink-0" />
                        <span className="flex-1 text-left truncate">
                          {routeFile ? routeFile.name : "🚌 File Percorso (.kml / .kmz)"}
                        </span>
                        {routeFile && (
                          <X className="w-3.5 h-3.5 text-muted-foreground hover:text-red-400 shrink-0"
                            onClick={e => { e.stopPropagation(); setRouteFile(null); }} />
                        )}
                      </button>

                      {/* Upload button */}
                      <button onClick={handleUpload} disabled={uploading || (!stopsFile && !routeFile)}
                        className="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg bg-primary/10 hover:bg-primary/20 text-primary text-xs font-semibold transition-all disabled:opacity-40 disabled:cursor-not-allowed border border-primary/20">
                        {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileUp className="w-4 h-4" />}
                        {uploading ? "Caricamento…" : "Carica Scenario"}
                      </button>

                      {/* Hidden input for reimport stops */}
                      <input ref={reimportInputRef} type="file" accept=".kml,.kmz" className="hidden"
                        onChange={onReimportFileSelected} />

                      {(stopsFile || routeFile) && !uploading && (
                        <p className="text-[9px] text-muted-foreground text-center">
                          {stopsFile && routeFile ? "Fermate + Percorso pronti" : stopsFile ? "Solo fermate — il percorso è opzionale" : "Solo percorso — le fermate verranno generate automaticamente"}
                        </p>
                      )}
                    </div>

                    {/* Scenario list */}
                    <div className="max-h-60 overflow-y-auto space-y-1.5">
                      {scenarioList.length === 0 && (
                        <p className="text-xs text-muted-foreground text-center py-4">
                          Nessuno scenario caricato.<br />Carica un file KML/KMZ per iniziare.
                        </p>
                      )}
                      {scenarioList.map(s => {
                        const isVisible = visibleIds.has(s.id);
                        const isCompare = selectedForCompare.includes(s.id);
                        return (
                          <div key={s.id} className="bg-muted/30 rounded-lg p-2 space-y-1.5">
                            <div className="flex items-center gap-2">
                              <div className="w-3 h-3 rounded-full shrink-0 border border-black/20" style={{ backgroundColor: s.color }} />
                              <span className="text-xs font-semibold flex-1 truncate">{s.name}</span>
                              <button onClick={() => toggleVisibility(s.id)} title={isVisible ? "Nascondi" : "Mostra"}
                                className={`p-1 rounded transition-colors ${isVisible ? "text-primary" : "text-muted-foreground hover:text-foreground"}`}>
                                {isVisible ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
                              </button>
                              <button onClick={() => toggleCompareSelection(s.id)} title="Seleziona per confronto"
                                className={`p-1 rounded transition-colors ${isCompare ? "text-amber-400 bg-amber-500/10" : "text-muted-foreground hover:text-foreground"}`}>
                                <GitCompareArrows className="w-3.5 h-3.5" />
                              </button>
                              <button onClick={(e) => { e.stopPropagation(); handleReimportStops(s.id); }}
                                title="Ricarica fermate da KML"
                                disabled={reimportLoading && reimportTargetId === s.id}
                                className={`p-1 rounded transition-colors ${reimportLoading && reimportTargetId === s.id ? "text-blue-400 animate-spin" : "text-muted-foreground hover:text-blue-400"}`}>
                                <RefreshCw className="w-3.5 h-3.5" />
                              </button>
                              <button onClick={(e) => { e.stopPropagation(); handleDelete(s.id); }}
                                title={pendingDeleteId === s.id ? "Clicca di nuovo per confermare" : "Elimina"}
                                className={`p-1 rounded transition-colors ${pendingDeleteId === s.id ? "text-red-400 bg-red-500/20 animate-pulse" : "text-muted-foreground hover:text-red-400"}`}>
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                            {/* Conferma eliminazione inline */}
                            {pendingDeleteId === s.id && (
                              <div className="flex items-center gap-2 bg-red-500/10 border border-red-500/30 rounded-lg px-2 py-1.5">
                                <Trash2 className="w-3 h-3 text-red-400 shrink-0" />
                                <span className="text-[10px] text-red-300 flex-1">Eliminare "{s.name}"?</span>
                                <button onClick={(e) => { e.stopPropagation(); handleDelete(s.id); }}
                                  className="px-2 py-0.5 rounded text-[10px] font-semibold bg-red-600 hover:bg-red-700 text-white transition-colors">
                                  Conferma
                                </button>
                                <button onClick={(e) => { e.stopPropagation(); setPendingDeleteId(null); pendingDeleteRef.current = null; }}
                                  className="px-2 py-0.5 rounded text-[10px] font-medium bg-muted/50 hover:bg-muted text-muted-foreground transition-colors">
                                  Annulla
                                </button>
                              </div>
                            )}
                            <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
                              <span className="flex items-center gap-0.5"><Ruler className="w-3 h-3" /> {s.lengthKm.toFixed(1)} km</span>
                              <span className="flex items-center gap-0.5"><MapPin className="w-3 h-3" /> {s.stopsCount} fermate</span>
                            </div>
                            {/* Quick analyze button */}
                            <div className="flex gap-1">
                              <button onClick={() => runAnalysis(s.id)}
                                className="flex-1 flex items-center justify-center gap-1 px-2 py-1 rounded text-[10px] font-medium bg-primary/10 text-primary hover:bg-primary/20 transition-colors">
                                <BarChart3 className="w-3 h-3" /> Analizza
                              </button>
                              <button onClick={() => openPdePanel(s.id)}
                                className="flex-1 flex items-center justify-center gap-1 px-2 py-1 rounded text-[10px] font-medium bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 transition-colors">
                                <Play className="w-3 h-3" /> Genera PdE
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    {/* Compare button */}
                    {selectedForCompare.length === 2 && (
                      <div className="space-y-1.5">
                        <div className="flex items-center gap-1 text-[10px] text-amber-400 bg-amber-500/10 rounded px-2 py-1">
                          <GitCompareArrows className="w-3 h-3" />
                          {selectedForCompare.map(id => scenarioList.find(s => s.id === id)?.name).join(" vs ")}
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] text-muted-foreground shrink-0">Raggio:</span>
                          {[0.3, 0.5, 1.0].map(r => (
                            <button key={r} onClick={() => setAnalysisRadius(r)}
                              className={`px-2 py-0.5 rounded text-[10px] font-medium border transition-all ${
                                analysisRadius === r ? "bg-primary/20 text-primary border-primary/40" : "border-border/30 text-muted-foreground hover:bg-muted/30"
                              }`}>{r} km</button>
                          ))}
                        </div>
                        <button onClick={runCompare} disabled={compareLoading}
                          className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold bg-amber-600 hover:bg-amber-700 text-white disabled:opacity-50 transition-colors">
                          {compareLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <GitCompareArrows className="w-3.5 h-3.5" />}
                          {compareLoading ? "Confronto…" : "Confronta scenari"}
                        </button>
                      </div>
                    )}

                    {/* POI toggle */}
                    <div className="flex items-center justify-between pt-1 mt-1 border-t border-border/20">
                      <Label htmlFor="poi-toggle" className="text-xs cursor-pointer">Punti di interesse</Label>
                      <Switch id="poi-toggle" checked={showPoi} onCheckedChange={setShowPoi} />
                    </div>
                    {showPoi && (
                      <div className="flex flex-wrap gap-1">
                        {Object.entries(POI_COLOR).map(([cat, color]) => {
                          const on = selectedPoiCats.includes(cat);
                          return (
                            <button key={cat}
                              onClick={() => setSelectedPoiCats(prev => on ? prev.filter(c => c !== cat) : [...prev, cat])}
                              className={`text-[9px] px-1.5 py-0.5 rounded-full border transition-all flex items-center gap-1 ${on ? "opacity-100" : "opacity-30"}`}
                              style={{ borderColor: color, color }}>
                              {POI_ICON[cat]} {POI_CATEGORY_IT[cat]}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </CardContent>
                </motion.div>
              )}
            </AnimatePresence>
          </Card>
        </motion.div>
      </div>

      {/* ── Analysis / Compare Panel — bottom ─────────────────── */}
      <AnimatePresence>
        {analysisPanelOpen && (analysisResult || compareResult || analysisLoading || compareLoading) && (
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 30 }}
            className="absolute bottom-6 left-4 right-4 max-w-3xl mx-auto pointer-events-auto z-10"
          >
            <Card className="bg-card/95 backdrop-blur-xl border-border/50 shadow-2xl overflow-hidden">
              <div className="px-4 py-2.5 flex items-center justify-between border-b border-border/30">
                <span className="flex items-center gap-2 text-sm font-bold">
                  {compareResult ? <GitCompareArrows className="w-4 h-4 text-amber-400" /> : <BarChart3 className="w-4 h-4 text-primary" />}
                  {compareResult ? "Confronto Scenari" : "Analisi Scenario"}
                </span>
                <button onClick={() => setAnalysisPanelOpen(false)} className="text-muted-foreground hover:text-foreground">
                  <X className="w-4 h-4" />
                </button>
              </div>

              <CardContent className="p-4 max-h-[50vh] overflow-y-auto">
                {/* Loading */}
                {(analysisLoading || compareLoading) && (
                  <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
                    <Loader2 className="w-5 h-5 animate-spin text-primary" />
                    Analisi in corso…
                  </div>
                )}

                {/* Single analysis result */}
                {analysisResult && !analysisLoading && (
                  <div className="space-y-4">
                    <div className="flex items-center gap-2 mb-3">
                      <div className="w-3 h-3 rounded-full" style={{ backgroundColor: analysisResult.scenario.color }} />
                      <span className="font-semibold text-sm">{analysisResult.scenario.name}</span>
                      {/* Accessibility score badge */}
                      <div className={`ml-auto px-2.5 py-0.5 rounded-full text-xs font-bold ${
                        analysisResult.accessibilityScore >= 70 ? "bg-emerald-500/20 text-emerald-400"
                        : analysisResult.accessibilityScore >= 40 ? "bg-amber-500/20 text-amber-400"
                        : "bg-red-500/20 text-red-400"
                      }`}>
                        {analysisResult.accessibilityScore}/100
                      </div>
                    </div>

                    {/* Score breakdown */}
                    <div>
                      <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">
                        Composizione punteggio accessibilità
                      </p>
                      <div className="space-y-1">
                        {scoreBreakdown(analysisResult).map(f => (
                          <div key={f.factor} className="flex items-center gap-2 text-[10px]">
                            <span className="w-28 text-muted-foreground">{f.factor}</span>
                            <div className="flex-1 h-2 bg-muted/40 rounded-full overflow-hidden">
                              <div className="h-full rounded-full transition-all" style={{ width: `${f.value}%`, backgroundColor: f.color }} />
                            </div>
                            <span className="w-8 text-right font-bold" style={{ color: f.color }}>{f.value}</span>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* KPI row */}
                    <div className="grid grid-cols-5 gap-2 text-center">
                      <div className="bg-primary/10 rounded-lg p-2">
                        <p className="text-lg font-bold text-primary">{analysisResult.totalLengthKm.toFixed(1)}</p>
                        <p className="text-[9px] text-muted-foreground">km totali</p>
                      </div>
                      <div className="bg-muted/30 rounded-lg p-2">
                        <p className="text-lg font-bold">{analysisResult.stops.length}</p>
                        <p className="text-[9px] text-muted-foreground">Fermate</p>
                      </div>
                      <div className="bg-emerald-500/10 rounded-lg p-2">
                        <p className="text-lg font-bold text-emerald-400">{analysisResult.poiCoverage.percent}%</p>
                        <p className="text-[9px] text-muted-foreground">POI coperti</p>
                      </div>
                      <div className="bg-blue-500/10 rounded-lg p-2">
                        <p className="text-lg font-bold text-blue-400">{analysisResult.populationCoverage.percent}%</p>
                        <p className="text-[9px] text-muted-foreground">Pop. coperta</p>
                      </div>
                      <div className="bg-violet-500/10 rounded-lg p-2">
                        <p className="text-lg font-bold text-violet-400">{analysisResult.populationCoverage.comuniToccati}</p>
                        <p className="text-[9px] text-muted-foreground">Comuni</p>
                      </div>
                    </div>

                    {/* Efficiency row */}
                    <div className="grid grid-cols-4 gap-1.5 text-center">
                      <div className="bg-muted/20 rounded px-2 py-1.5">
                        <p className="text-sm font-bold">{analysisResult.efficiencyMetrics.popPerKm.toLocaleString("it-IT")}</p>
                        <p className="text-[8px] text-muted-foreground">ab/km</p>
                      </div>
                      <div className="bg-muted/20 rounded px-2 py-1.5">
                        <p className="text-sm font-bold">{analysisResult.efficiencyMetrics.poiPerKm}</p>
                        <p className="text-[8px] text-muted-foreground">POI/km</p>
                      </div>
                      <div className="bg-muted/20 rounded px-2 py-1.5">
                        <p className="text-sm font-bold">{analysisResult.efficiencyMetrics.stopsPerKm}</p>
                        <p className="text-[8px] text-muted-foreground">fermate/km</p>
                      </div>
                      <div className="bg-muted/20 rounded px-2 py-1.5">
                        <p className="text-sm font-bold">{analysisResult.efficiencyMetrics.costIndex}</p>
                        <p className="text-[8px] text-muted-foreground">%pop/10km</p>
                      </div>
                    </div>

                    {/* Per-route length breakdown */}
                    {analysisResult.routes.length > 1 && (
                      <div>
                        <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">
                          Lunghezza per percorso ({analysisResult.routes.length} linee)
                        </p>
                        <div className="h-32">
                          <ResponsiveContainer width="100%" height="100%">
                            <BarChart data={analysisResult.routes.map(r => ({ name: r.name.length > 12 ? r.name.slice(0, 12) + "…" : r.name, km: +r.lengthKm.toFixed(1) }))} layout="vertical" margin={{ left: 0, right: 8 }}>
                              <CartesianGrid strokeDasharray="3 3" stroke="#334155" horizontal={false} />
                              <XAxis type="number" tick={{ fill: "#94a3b8", fontSize: 9 }} />
                              <YAxis type="category" dataKey="name" tick={{ fill: "#94a3b8", fontSize: 9 }} width={80} />
                              <ReTooltip formatter={(v: number) => `${v} km`} contentStyle={{ background: "#1e293b", border: "1px solid #334155", borderRadius: 8, fontSize: 10 }} />
                              <Bar dataKey="km" fill={analysisResult.scenario.color} radius={[0, 4, 4, 0]} />
                            </BarChart>
                          </ResponsiveContainer>
                        </div>
                      </div>
                    )}

                    {/* Stop distribution */}
                    {analysisResult.stopDistribution && (
                      <div>
                        <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">Distribuzione fermate</p>
                        <div className="grid grid-cols-3 gap-1.5 text-center text-[10px]">
                          <div className="bg-muted/20 rounded px-2 py-1">
                            <span className="font-semibold">{(analysisResult.stopDistribution.avgInterStopKm * 1000).toFixed(0)}m</span>
                            <span className="text-muted-foreground ml-1">media</span>
                          </div>
                          <div className={`rounded px-2 py-1 ${analysisResult.stopDistribution.gapsOver1km > 0 ? "bg-red-500/10 text-red-300" : "bg-muted/20"}`}>
                            <span className="font-semibold">{analysisResult.stopDistribution.gapsOver1km}</span>
                            <span className="text-muted-foreground ml-1">gap &gt;1km</span>
                          </div>
                          <div className={`rounded px-2 py-1 ${analysisResult.stopDistribution.stopsWithin300m > 0 ? "bg-amber-500/10 text-amber-300" : "bg-muted/20"}`}>
                            <span className="font-semibold">{analysisResult.stopDistribution.stopsWithin300m}</span>
                            <span className="text-muted-foreground ml-1">troppo vicine</span>
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Copertura per comune */}
                    {analysisResult.comuniDetails.length > 0 && (
                      <div>
                        <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">
                          Copertura per comune ({analysisResult.populationCoverage.totalPop.toLocaleString("it-IT")} ab. totali nei {analysisResult.comuniDetails.length} comuni toccati)
                        </p>
                        <div className="space-y-1">
                          {analysisResult.comuniDetails.map(c => {
                            const barColor = c.percent >= 60 ? "#22c55e" : c.percent >= 30 ? "#eab308" : "#ef4444";
                            return (
                              <div key={c.code} className="flex items-center gap-1.5 text-[10px]">
                                <span className="w-28 truncate text-muted-foreground">{c.name}</span>
                                <div className="flex-1 h-1.5 bg-muted/40 rounded-full overflow-hidden">
                                  <div className="h-full rounded-full transition-all" style={{ width: `${c.percent}%`, backgroundColor: barColor }} />
                                </div>
                                <span className="w-20 text-right font-mono text-muted-foreground">
                                  {c.coveredPop.toLocaleString("it-IT")}/{c.totalPop.toLocaleString("it-IT")}
                                </span>
                                <span className="w-8 text-right font-semibold" style={{ color: barColor }}>{c.percent}%</span>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {/* POI by category */}
                    <div>
                      <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-2">Copertura POI per categoria (raggio {analysisResult.poiCoverage.radius} km dalle fermate)</p>
                      <div className="grid grid-cols-2 gap-1.5">
                        {Object.entries(analysisResult.poiCoverage.byCategory)
                          .sort(([, a], [, b]) => b.total - a.total)
                          .map(([cat, { total, covered }]) => {
                            const pct = total > 0 ? Math.round((covered / total) * 100) : 0;
                            const barColor = pct >= 60 ? "#22c55e" : pct >= 30 ? "#eab308" : "#ef4444";
                            return (
                              <div key={cat} className="flex items-center gap-1.5 text-[10px]">
                                <span className="w-16 truncate text-muted-foreground">{POI_CATEGORY_IT[cat] || cat}</span>
                                <div className="flex-1 h-1.5 bg-muted/40 rounded-full overflow-hidden">
                                  <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: barColor }} />
                                </div>
                                <span className="w-10 text-right font-mono">{covered}/{total}</span>
                              </div>
                            );
                          })}
                      </div>
                    </div>

                    {/* Population donut */}
                    <div>
                      <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1">Copertura popolazione (sezioni censuarie ISTAT)</p>
                      <div className="flex items-center gap-3">
                        <div className="w-[100px] h-[100px]">
                          <ResponsiveContainer width="100%" height="100%">
                            <PieChart>
                              <Pie
                                data={[
                                  { name: "Coperta", value: analysisResult.populationCoverage.coveredPop, fill: "#3b82f6" },
                                  { name: "Non coperta", value: analysisResult.populationCoverage.totalPop - analysisResult.populationCoverage.coveredPop, fill: "#334155" },
                                ]}
                                cx="50%" cy="50%" innerRadius={28} outerRadius={42} paddingAngle={3} dataKey="value" strokeWidth={0}
                              >
                                <Cell fill="#3b82f6" />
                                <Cell fill="#334155" />
                              </Pie>
                              <ReTooltip formatter={(v: number) => `${v.toLocaleString("it-IT")} ab.`}
                                contentStyle={{ background: "#1e293b", border: "1px solid #334155", borderRadius: 8, fontSize: 10 }} />
                            </PieChart>
                          </ResponsiveContainer>
                        </div>
                        <div className="flex-1 space-y-1">
                          <div className="flex items-center gap-1.5 text-[10px]">
                            <div className="w-2.5 h-2.5 rounded-sm bg-blue-500" />
                            <span className="text-muted-foreground">Coperta</span>
                            <span className="ml-auto font-semibold">{analysisResult.populationCoverage.coveredPop.toLocaleString("it-IT")}</span>
                          </div>
                          <div className="flex items-center gap-1.5 text-[10px]">
                            <div className="w-2.5 h-2.5 rounded-sm" style={{ background: "#334155" }} />
                            <span className="text-muted-foreground">Totale area servizio</span>
                            <span className="ml-auto font-semibold">{analysisResult.populationCoverage.totalPop.toLocaleString("it-IT")}</span>
                          </div>
                          <p className="text-[9px] text-muted-foreground italic mt-1">
                            Dati ISTAT — {analysisResult.populationCoverage.comuniToccati} comuni, raggio {analysisResult.poiCoverage.radius} km dalle fermate
                          </p>
                        </div>
                      </div>
                    </div>

                    {/* Gap analysis */}
                    {(analysisResult.gapAnalysis.uncoveredPoi.length > 0 || analysisResult.gapAnalysis.underservedComuni.length > 0) && (
                      <div className="space-y-2">
                        <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1">
                          <AlertTriangle className="w-3 h-3 text-amber-400" /> Analisi lacune
                        </p>
                        {analysisResult.gapAnalysis.underservedComuni.length > 0 && (
                          <div className="text-[11px] px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-200 space-y-0.5">
                            <p className="font-semibold text-[10px]">Comuni sotto-serviti:</p>
                            {analysisResult.gapAnalysis.underservedComuni.map((c, i) => (
                              <p key={i}> • {c.name}: {c.coveragePercent}% copertura ({c.pop.toLocaleString("it-IT")} ab.)</p>
                            ))}
                          </div>
                        )}
                        {analysisResult.gapAnalysis.uncoveredPoi.length > 0 && (
                          <div className="text-[11px] px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20 text-red-300 space-y-0.5">
                            <p className="font-semibold text-[10px]">POI critici non coperti (raggiungibili):</p>
                            {analysisResult.gapAnalysis.uncoveredPoi.slice(0, 8).map((p, i) => (
                              <p key={i}> • {p.name} ({POI_CATEGORY_IT[p.category] || p.category}) — {p.distKm} km</p>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {/* Compare result */}
                {compareResult && !compareLoading && (
                  <div className="space-y-4">
                    {/* Unified base indicator */}
                    {compareResult.unifiedBase && (
                      <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-blue-500/10 border border-blue-500/20 text-blue-300 text-[10px]">
                        <Info className="w-3.5 h-3.5 shrink-0" />
                        <span>
                          Base unificata: <strong>{compareResult.unifiedBase.totalPop.toLocaleString("it-IT")}</strong> abitanti
                          in <strong>{compareResult.unifiedBase.comuniCount}</strong> comuni
                          ({compareResult.unifiedBase.comuni.map(c => c.name).join(", ")}).
                          Le % sono calcolate sulla stessa base per un confronto equo.
                        </span>
                      </div>
                    )}

                    {/* Side-by-side KPI */}
                    <div className="grid grid-cols-2 gap-3">
                      {compareResult.scenarios.map(s => (
                        <div key={s.id} className="space-y-2">
                          <div className="flex items-center gap-2 mb-1">
                            <div className="w-3 h-3 rounded-full" style={{ backgroundColor: s.color }} />
                            <span className="text-xs font-bold truncate">{s.name}</span>
                            <div className={`ml-auto px-1.5 py-0.5 rounded text-[9px] font-bold ${
                              s.accessibilityScore >= 70 ? "bg-emerald-500/20 text-emerald-400"
                              : s.accessibilityScore >= 40 ? "bg-amber-500/20 text-amber-400"
                              : "bg-red-500/20 text-red-400"
                            }`}>
                              {s.accessibilityScore}/100
                            </div>
                          </div>
                          <div className="grid grid-cols-3 gap-1">
                            <div className="bg-muted/30 rounded p-1.5 text-center">
                              <p className="text-sm font-bold">{s.totalLengthKm.toFixed(1)}</p>
                              <p className="text-[8px] text-muted-foreground">km</p>
                            </div>
                            <div className="bg-muted/30 rounded p-1.5 text-center">
                              <p className="text-sm font-bold">{s.stopsCount}</p>
                              <p className="text-[8px] text-muted-foreground">fermate</p>
                            </div>
                            <div className="bg-muted/30 rounded p-1.5 text-center">
                              <p className="text-sm font-bold">{s.comuniDetails.length}</p>
                              <p className="text-[8px] text-muted-foreground">comuni</p>
                            </div>
                            <div className="bg-emerald-500/10 rounded p-1.5 text-center">
                              <p className="text-sm font-bold text-emerald-400">{s.poiCoverage.percent}%</p>
                              <p className="text-[8px] text-muted-foreground">POI</p>
                            </div>
                            <div className="bg-blue-500/10 rounded p-1.5 text-center">
                              <p className="text-sm font-bold text-blue-400">{s.populationCoverage.percent}%</p>
                              <p className="text-[8px] text-muted-foreground">Pop.</p>
                            </div>
                            <div className="bg-violet-500/10 rounded p-1.5 text-center">
                              <p className="text-sm font-bold text-violet-400">{s.efficiency.popPerKm.toLocaleString("it-IT")}</p>
                              <p className="text-[8px] text-muted-foreground">ab/km</p>
                            </div>
                          </div>
                          {/* Comuni list */}
                          <div className="text-[9px] text-muted-foreground">
                            {s.comuniDetails.slice(0, 4).map(c => (
                              <span key={c.code} className="inline-flex items-center gap-0.5 mr-1.5">
                                <span className="w-1.5 h-1.5 rounded-full inline-block" style={{ backgroundColor: c.percent >= 60 ? "#22c55e" : c.percent >= 30 ? "#eab308" : "#ef4444" }} />
                                {c.name} {c.percent}%
                              </span>
                            ))}
                            {s.comuniDetails.length > 4 && <span>+{s.comuniDetails.length - 4} altri</span>}
                          </div>
                        </div>
                      ))}
                    </div>

                    {/* Radar chart */}
                    {radarData && (
                      <div className="h-52">
                        <ResponsiveContainer width="100%" height="100%">
                          <RadarChart data={radarData}>
                            <PolarGrid stroke="#334155" />
                            <PolarAngleAxis dataKey="metric" tick={{ fill: "#94a3b8", fontSize: 10 }} />
                            {compareResult.scenarios.map(s => (
                              <Radar key={s.id} name={s.name} dataKey={s.name}
                                stroke={s.color} fill={s.color} fillOpacity={0.15} strokeWidth={2} />
                            ))}
                            <ReLegend wrapperStyle={{ fontSize: 10 }} />
                            <ReTooltip contentStyle={{ background: "#1e293b", border: "1px solid #334155", borderRadius: 8, fontSize: 10 }} />
                          </RadarChart>
                        </ResponsiveContainer>
                      </div>
                    )}

                    {/* Efficiency comparison table */}
                    {(() => {
                      const [a, b] = compareResult.scenarios;
                      const metrics = [
                        { label: "Abitanti/km", aVal: a.efficiency.popPerKm, bVal: b.efficiency.popPerKm, fmt: (v: number) => v.toLocaleString("it-IT"), higher: true },
                        { label: "POI/km", aVal: a.efficiency.poiPerKm, bVal: b.efficiency.poiPerKm, fmt: (v: number) => String(v), higher: true },
                        { label: "Fermate/km", aVal: a.efficiency.stopsPerKm, bVal: b.efficiency.stopsPerKm, fmt: (v: number) => String(v), higher: true },
                        { label: "%Pop/10km", aVal: a.efficiency.costIndex, bVal: b.efficiency.costIndex, fmt: (v: number) => String(v), higher: true },
                        { label: "Gap >1km", aVal: a.stopDistribution?.gapsOver1km ?? 0, bVal: b.stopDistribution?.gapsOver1km ?? 0, fmt: (v: number) => String(v), higher: false },
                        { label: "Ferm. vicine", aVal: a.stopDistribution?.stopsWithin300m ?? 0, bVal: b.stopDistribution?.stopsWithin300m ?? 0, fmt: (v: number) => String(v), higher: false },
                      ];
                      return (
                        <div>
                          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1.5 flex items-center gap-1">
                            <BarChart3 className="w-3 h-3" /> Confronto efficienza
                          </p>
                          <div className="text-[10px] space-y-0.5">
                            <div className="grid grid-cols-3 gap-1 text-[9px] text-muted-foreground font-semibold pb-0.5 border-b border-border/30">
                              <span></span>
                              <span className="text-center flex items-center justify-center gap-1">
                                <span className="w-2 h-2 rounded-full" style={{ backgroundColor: a.color }} /> {a.name}
                              </span>
                              <span className="text-center flex items-center justify-center gap-1">
                                <span className="w-2 h-2 rounded-full" style={{ backgroundColor: b.color }} /> {b.name}
                              </span>
                            </div>
                            {metrics.map(m => {
                              const aBetter = m.higher ? m.aVal > m.bVal : m.aVal < m.bVal;
                              const bBetter = m.higher ? m.bVal > m.aVal : m.bVal < m.aVal;
                              const tie = m.aVal === m.bVal;
                              return (
                                <div key={m.label} className="grid grid-cols-3 gap-1 py-0.5">
                                  <span className="text-muted-foreground">{m.label}</span>
                                  <span className={`text-center font-mono font-semibold ${!tie && aBetter ? "text-emerald-400" : !tie && bBetter ? "text-red-400" : ""}`}>
                                    {m.fmt(m.aVal)} {!tie && aBetter ? "✓" : ""}
                                  </span>
                                  <span className={`text-center font-mono font-semibold ${!tie && bBetter ? "text-emerald-400" : !tie && aBetter ? "text-red-400" : ""}`}>
                                    {m.fmt(m.bVal)} {!tie && bBetter ? "✓" : ""}
                                  </span>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })()}

                    {/* POI per-category grouped bar chart */}
                    {comparePOICatData && comparePOICatData.length > 0 && (
                      <div>
                        <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">
                          Copertura POI per categoria (%)
                        </p>
                        <div className="h-48">
                          <ResponsiveContainer width="100%" height="100%">
                            <BarChart data={comparePOICatData} layout="vertical" margin={{ left: 4, right: 4 }}>
                              <CartesianGrid strokeDasharray="3 3" stroke="#334155" horizontal={false} />
                              <XAxis type="number" domain={[0, 100]} tick={{ fill: "#94a3b8", fontSize: 9 }} tickFormatter={v => `${v}%`} />
                              <YAxis type="category" dataKey="category" tick={{ fill: "#94a3b8", fontSize: 9 }} width={65} />
                              <ReTooltip formatter={(v: number) => `${v}%`} contentStyle={{ background: "#1e293b", border: "1px solid #334155", borderRadius: 8, fontSize: 10 }} />
                              <Bar dataKey={compareResult.scenarios[0].name} fill={compareResult.scenarios[0].color} radius={[0, 3, 3, 0]} barSize={8} />
                              <Bar dataKey={compareResult.scenarios[1].name} fill={compareResult.scenarios[1].color} radius={[0, 3, 3, 0]} barSize={8} />
                              <ReLegend wrapperStyle={{ fontSize: 9 }} />
                            </BarChart>
                          </ResponsiveContainer>
                        </div>
                      </div>
                    )}

                    {/* Popolazione per comune — side by side */}
                    {compareComuniData && compareComuniData.length > 0 && (
                      <div>
                        <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">
                          Popolazione coperta per comune
                        </p>
                        <div style={{ height: Math.max(100, compareComuniData.length * 28 + 30) }}>
                          <ResponsiveContainer width="100%" height="100%">
                            <BarChart data={compareComuniData} layout="vertical" margin={{ left: 4, right: 4 }}>
                              <CartesianGrid strokeDasharray="3 3" stroke="#334155" horizontal={false} />
                              <XAxis type="number" tick={{ fill: "#94a3b8", fontSize: 9 }} tickFormatter={v => v >= 1000 ? `${(v / 1000).toFixed(0)}k` : v} />
                              <YAxis type="category" dataKey="name" tick={{ fill: "#94a3b8", fontSize: 9 }} width={65} />
                              <ReTooltip formatter={(v: number) => v.toLocaleString("it-IT") + " ab."} contentStyle={{ background: "#1e293b", border: "1px solid #334155", borderRadius: 8, fontSize: 10 }} />
                              <Bar dataKey={`${compareResult.scenarios[0].name} coperta`} stackId="a" fill={compareResult.scenarios[0].color} barSize={10} />
                              <Bar dataKey={`${compareResult.scenarios[0].name} non coperta`} stackId="a" fill={compareResult.scenarios[0].color + "33"} barSize={10} />
                              <Bar dataKey={`${compareResult.scenarios[1].name} coperta`} stackId="b" fill={compareResult.scenarios[1].color} barSize={10} />
                              <Bar dataKey={`${compareResult.scenarios[1].name} non coperta`} stackId="b" fill={compareResult.scenarios[1].color + "33"} barSize={10} />
                              <ReLegend wrapperStyle={{ fontSize: 8 }} />
                            </BarChart>
                          </ResponsiveContainer>
                        </div>
                      </div>
                    )}

                    {/* Score breakdown comparison */}
                    <div>
                      <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">
                        Composizione punteggio accessibilità
                      </p>
                      <div className="grid grid-cols-2 gap-3">
                        {compareResult.scenarios.map(s => {
                          // Build a pseudo AnalysisResult to feed scoreBreakdown
                          const pseudo = {
                            populationCoverage: s.populationCoverage,
                            poiCoverage: s.poiCoverage,
                            stopDistribution: s.stopDistribution,
                            efficiencyMetrics: s.efficiency,
                            accessibilityScore: s.accessibilityScore,
                          } as AnalysisResult;
                          return (
                            <div key={s.id}>
                              <p className="text-[9px] font-semibold mb-1 flex items-center gap-1">
                                <span className="w-2 h-2 rounded-full" style={{ backgroundColor: s.color }} /> {s.name}
                              </p>
                              {scoreBreakdown(pseudo).map(f => (
                                <div key={f.factor} className="flex items-center gap-1 text-[9px] mb-0.5">
                                  <span className="w-20 truncate text-muted-foreground">{f.factor}</span>
                                  <div className="flex-1 h-1.5 bg-muted/40 rounded-full overflow-hidden">
                                    <div className="h-full rounded-full" style={{ width: `${f.value}%`, backgroundColor: f.color }} />
                                  </div>
                                  <span className="w-5 text-right font-bold text-[8px]" style={{ color: f.color }}>{f.value}</span>
                                </div>
                              ))}
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    {/* Gap analysis comparison */}
                    {compareResult.scenarios.some(s => s.gapAnalysis.underservedComuni.length > 0 || s.gapAnalysis.uncoveredPoi.length > 0) && (
                      <div>
                        <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1.5 flex items-center gap-1">
                          <AlertTriangle className="w-3 h-3 text-amber-400" /> Analisi lacune comparata
                        </p>
                        <div className="grid grid-cols-2 gap-2">
                          {compareResult.scenarios.map(s => (
                            <div key={s.id} className="space-y-1">
                              <p className="text-[9px] font-semibold flex items-center gap-1">
                                <span className="w-2 h-2 rounded-full" style={{ backgroundColor: s.color }} /> {s.name}
                              </p>
                              {s.gapAnalysis.underservedComuni.length > 0 ? (
                                <div className="text-[9px] px-2 py-1.5 rounded bg-amber-500/10 border border-amber-500/20 text-amber-200 space-y-0.5">
                                  {s.gapAnalysis.underservedComuni.slice(0, 3).map((c, i) => (
                                    <p key={i}>• {c.name}: {c.coveragePercent}%</p>
                                  ))}
                                </div>
                              ) : (
                                <div className="text-[9px] px-2 py-1.5 rounded bg-emerald-500/10 border border-emerald-500/20 text-emerald-300">
                                  <CheckCircle2 className="w-3 h-3 inline mr-1" />Tutti i comuni coperti
                                </div>
                              )}
                              {s.gapAnalysis.uncoveredPoi.length > 0 && (
                                <div className="text-[9px] px-2 py-1.5 rounded bg-red-500/10 border border-red-500/20 text-red-300 space-y-0.5">
                                  <p className="font-semibold">{s.gapAnalysis.uncoveredPoi.length} POI non coperti</p>
                                  {s.gapAnalysis.uncoveredPoi.slice(0, 3).map((p, i) => (
                                    <p key={i}>• {p.name} ({p.distKm}km)</p>
                                  ))}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Suggestions */}
                    {compareResult.suggestions.length > 0 && (
                      <div className="space-y-1.5">
                        <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1">
                          <Lightbulb className="w-3 h-3 text-amber-400" /> Analisi comparativa
                        </p>
                        {compareResult.suggestions.map((sug, i) => {
                          const isWarning = sug.startsWith("⚠️") || sug.startsWith("🚨");
                          const isIndented = sug.startsWith("  →");
                          return (
                            <div key={i} className={`text-[11px] px-3 py-1.5 rounded-lg border ${
                              isWarning ? "bg-red-500/10 border-red-500/30 text-red-300"
                              : isIndented ? "bg-muted/20 border-border/20 text-muted-foreground ml-4"
                              : "bg-card/50 border-border/30 text-foreground/80"
                            }`}>
                              {sug}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── PdE Panel — bottom ────────────────────────────────── */}
      <AnimatePresence>
        {pdePanelOpen && (
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 30 }}
            className="absolute bottom-4 left-4 right-4 max-w-6xl mx-auto pointer-events-auto z-20"
          >
            <Card className="bg-card/95 backdrop-blur-xl border-emerald-500/30 shadow-2xl overflow-hidden">
              <div className="px-4 py-2.5 flex items-center justify-between border-b border-border/30">
                <span className="flex items-center gap-2 text-sm font-bold">
                  <Truck className="w-4 h-4 text-emerald-400" />
                  Programma di Esercizio
                  {pdeScenarioId && <span className="text-xs text-muted-foreground font-normal ml-1">
                    — {scenarioList.find(s => s.id === pdeScenarioId)?.name}
                  </span>}
                </span>
                <div className="flex items-center gap-2">
                  {(["config", "result", "gantt", "ttd", "gtfs"] as const).map(tab => (
                    <button key={tab} onClick={() => setPdeTab(tab)}
                      className={`px-2.5 py-1 rounded text-[10px] font-medium transition-colors ${pdeTab === tab ? "bg-emerald-500/20 text-emerald-400" : "text-muted-foreground hover:text-foreground"}`}
                      disabled={tab !== "config" && tab !== "gtfs" && !pdeResult}>
                      {tab === "config" ? "⚙️ Configura" : tab === "result" ? "📊 Risultati" : tab === "gantt" ? "📅 Gantt" : tab === "ttd" ? "📈 TTD" : "📦 GTFS"}
                    </button>
                  ))}
                  <button onClick={() => setPdePanelOpen(false)} className="text-muted-foreground hover:text-foreground ml-2">
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>

              <CardContent className="p-4 max-h-[70vh] overflow-y-auto">
                {/* Loading */}
                {pdeLoading && (
                  <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
                    <Loader2 className="w-5 h-5 animate-spin text-emerald-400" />
                    Generazione programma in corso… (traffico + POI + densità)
                  </div>
                )}

                {/* ── Config tab ── */}
                {pdeTab === "config" && !pdeLoading && (
                  <div className="space-y-4">
                    {/* Km suggestion banner */}
                    {pdeKmSuggestion && (
                      <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-lg p-3 space-y-2">
                        <div className="flex items-center gap-2">
                          <Lightbulb className="w-4 h-4 text-emerald-400" />
                          <span className="text-xs font-semibold text-emerald-400">Suggerimento Km</span>
                        </div>
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-[10px]">
                          <div><span className="text-muted-foreground">Rete:</span> <span className="font-medium">{pdeKmSuggestion.breakdown?.totalNetworkKm} km</span></div>
                          <div><span className="text-muted-foreground">Linee:</span> <span className="font-medium">{pdeKmSuggestion.breakdown?.totalLines}</span></div>
                          <div><span className="text-muted-foreground">POI serviti:</span> <span className="font-medium">{pdeKmSuggestion.breakdown?.poiCount}</span></div>
                          <div><span className="text-muted-foreground">Popolazione:</span> <span className="font-medium">{(pdeKmSuggestion.breakdown?.populationServed || 0).toLocaleString("it-IT")}</span></div>
                        </div>
                        <div className="flex items-center gap-3 text-xs">
                          <span className="text-muted-foreground">Km consigliati:</span>
                          <span className="font-bold text-emerald-400 text-sm">{pdeKmSuggestion.suggestedKm} km</span>
                          <span className="text-[9px] text-muted-foreground">(range: {pdeKmSuggestion.minKm}–{pdeKmSuggestion.maxKm} km)</span>
                          <button onClick={() => setPdeConfig(p => ({ ...p, targetKm: pdeKmSuggestion.suggestedKm }))}
                            className="ml-auto px-2 py-0.5 bg-emerald-600/20 text-emerald-400 rounded text-[10px] hover:bg-emerald-600/30 transition-colors">
                            Usa suggerimento
                          </button>
                        </div>
                      </div>
                    )}
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                      <div className="space-y-1">
                        <label className="text-[10px] text-muted-foreground font-medium">🎯 Km Target (indicativo)</label>
                        <input type="number" min={50} max={50000} step={50} value={pdeConfig.targetKm}
                          onChange={e => setPdeConfig(p => ({ ...p, targetKm: Number(e.target.value) }))}
                          className="w-full bg-background border border-border/50 rounded px-2.5 py-1.5 text-sm" />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[10px] text-muted-foreground font-medium">🕐 Inizio servizio</label>
                        <input type="number" min={4} max={12} value={pdeConfig.serviceStartH}
                          onChange={e => setPdeConfig(p => ({ ...p, serviceStartH: Number(e.target.value) }))}
                          className="w-full bg-background border border-border/50 rounded px-2.5 py-1.5 text-sm" />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[10px] text-muted-foreground font-medium">🕙 Fine servizio</label>
                        <input type="number" min={18} max={24} value={pdeConfig.serviceEndH}
                          onChange={e => setPdeConfig(p => ({ ...p, serviceEndH: Number(e.target.value) }))}
                          className="w-full bg-background border border-border/50 rounded px-2.5 py-1.5 text-sm" />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[10px] text-muted-foreground font-medium">🚌 Velocità media (km/h)</label>
                        <input type="number" min={10} max={60} value={pdeConfig.avgSpeedKmh}
                          onChange={e => setPdeConfig(p => ({ ...p, avgSpeedKmh: Number(e.target.value) }))}
                          className="w-full bg-background border border-border/50 rounded px-2.5 py-1.5 text-sm" />
                      </div>
                    </div>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                      <div className="space-y-1">
                        <label className="text-[10px] text-muted-foreground font-medium">⏱ Cadenza min (punta)</label>
                        <input type="number" min={5} max={30} value={pdeConfig.minCadenceMin}
                          onChange={e => setPdeConfig(p => ({ ...p, minCadenceMin: Number(e.target.value) }))}
                          className="w-full bg-background border border-border/50 rounded px-2.5 py-1.5 text-sm" />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[10px] text-muted-foreground font-medium">⏱ Cadenza max (morbida)</label>
                        <input type="number" min={15} max={120} value={pdeConfig.maxCadenceMin}
                          onChange={e => setPdeConfig(p => ({ ...p, maxCadenceMin: Number(e.target.value) }))}
                          className="w-full bg-background border border-border/50 rounded px-2.5 py-1.5 text-sm" />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[10px] text-muted-foreground font-medium">🚏 Sosta fermata (sec)</label>
                        <input type="number" min={10} max={60} value={pdeConfig.dwellTimeSec}
                          onChange={e => setPdeConfig(p => ({ ...p, dwellTimeSec: Number(e.target.value) }))}
                          className="w-full bg-background border border-border/50 rounded px-2.5 py-1.5 text-sm" />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[10px] text-muted-foreground font-medium">🔄 Sosta capolinea (sec)</label>
                        <input type="number" min={60} max={600} step={30} value={pdeConfig.terminalTimeSec}
                          onChange={e => setPdeConfig(p => ({ ...p, terminalTimeSec: Number(e.target.value) }))}
                          className="w-full bg-background border border-border/50 rounded px-2.5 py-1.5 text-sm" />
                      </div>
                    </div>
                    <div className="flex items-center gap-4">
                      <label className="flex items-center gap-2 text-xs">
                        <input type="checkbox" checked={pdeConfig.bidirectional}
                          onChange={e => setPdeConfig(p => ({ ...p, bidirectional: e.target.checked }))}
                          className="rounded" />
                        Bidirezionale (andata + ritorno)
                      </label>
                      <label className="flex items-center gap-2 text-xs">
                        <input type="checkbox" checked={useTrafficSlowdown}
                          onChange={e => setUseTrafficSlowdown(e.target.checked)}
                          className="rounded" />
                        <Zap className="w-3 h-3 text-amber-400" />
                        Rallentamento traffico per arco
                      </label>
                    </div>

                    {/* Phase 17: Coincidence Zones selector */}
                    {coincidenceZonesList.length > 0 && (
                      <div className="border-t border-border/30 pt-3 space-y-2">
                        <div className="flex items-center justify-between">
                          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1">
                            <MapPinned className="w-3 h-3 text-cyan-400" /> Zone di coincidenza
                          </p>
                          <button
                            onClick={() => {
                              if (selectedZoneIds.length === coincidenceZonesList.length) {
                                setSelectedZoneIds([]);
                              } else {
                                setSelectedZoneIds(coincidenceZonesList.map((z: any) => z.id));
                              }
                            }}
                            className="text-[9px] text-cyan-400 hover:text-cyan-300 transition-colors"
                          >
                            {selectedZoneIds.length === coincidenceZonesList.length ? "Deseleziona tutto" : "Seleziona tutto"}
                          </button>
                        </div>
                        <div className="grid grid-cols-2 md:grid-cols-3 gap-1.5">
                          {coincidenceZonesList.map((z: any) => {
                            const isSelected = selectedZoneIds.includes(z.id);
                            const HubIcon = ({ railway: TrainFront, port: Ship, "bus-bus": Bus, "park-ride": Car, airport: Plane } as any)[z.hubType] || MapPin;
                            const hubColor = ({ railway: "#06b6d4", port: "#8b5cf6", "bus-bus": "#f59e0b", "park-ride": "#22c55e", airport: "#f97316" } as any)[z.hubType] || "#888";
                            return (
                              <button key={z.id} onClick={() => {
                                setSelectedZoneIds(prev => isSelected ? prev.filter(id => id !== z.id) : [...prev, z.id]);
                              }}
                                className={`flex items-center gap-1.5 px-2 py-1.5 rounded text-[10px] font-medium transition-all border ${
                                  isSelected
                                    ? "bg-opacity-20 border-current ring-1 ring-current"
                                    : "bg-muted/20 border-border/30 text-muted-foreground hover:text-foreground"
                                }`}
                                style={isSelected ? { color: hubColor, backgroundColor: hubColor + "20", borderColor: hubColor } : {}}>
                                <HubIcon className="w-3 h-3 shrink-0" />
                                <span className="truncate">{z.name}</span>
                                {z.stopsCount && <Badge variant="secondary" className="text-[8px] px-1 py-0">{z.stopsCount}</Badge>}
                              </button>
                            );
                          })}
                        </div>
                        {selectedZoneIds.length > 0 && (
                          <p className="text-[9px] text-emerald-400">
                            {selectedZoneIds.length} zone selezionate — sincronizzazione arrivi/partenze attiva
                          </p>
                        )}
                      </div>
                    )}

                    {/* Phase 17: POI Categories selector */}
                    <div className="border-t border-border/30 pt-3 space-y-2">
                      <div className="flex items-center justify-between">
                        <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1">
                          <MapPin className="w-3 h-3 text-violet-400" /> Categorie POI (priorità domanda)
                        </p>
                        <button
                          onClick={() => {
                            const allKeys = ["hospital","school","university","transit","elderly","government","commercial","sport","culture","worship","park","tourism"];
                            if (selectedPoiCategories.length === allKeys.length) {
                              setSelectedPoiCategories([]);
                            } else {
                              setSelectedPoiCategories(allKeys);
                            }
                          }}
                          className="text-[9px] text-violet-400 hover:text-violet-300 transition-colors"
                        >
                          {selectedPoiCategories.length === 12 ? "Deseleziona tutto" : "Seleziona tutto"}
                        </button>
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {[
                            { key: "hospital", label: "Ospedali", icon: "🏥" },
                            { key: "school", label: "Scuole", icon: "🏫" },
                            { key: "university", label: "Università", icon: "🎓" },
                            { key: "transit", label: "Hub trasporti", icon: "🚉" },
                            { key: "elderly", label: "RSA/Anziani", icon: "🏠" },
                            { key: "government", label: "Uffici pubblici", icon: "🏛️" },
                            { key: "commercial", label: "Centri commerciali", icon: "🛍️" },
                            { key: "sport", label: "Sport", icon: "⚽" },
                            { key: "culture", label: "Cultura", icon: "🎭" },
                            { key: "worship", label: "Culto", icon: "⛪" },
                            { key: "park", label: "Parchi", icon: "🌳" },
                            { key: "tourism", label: "Turismo", icon: "📸" },
                          ].map((cat: any) => {
                          const isActive = selectedPoiCategories.length === 0 || selectedPoiCategories.includes(cat.key);
                          return (
                            <button key={cat.key} onClick={() => {
                              setSelectedPoiCategories(prev => {
                                if (prev.length === 0) return [cat.key];
                                if (prev.includes(cat.key)) {
                                  const next = prev.filter(c => c !== cat.key);
                                  return next.length === 0 ? [] : next;
                                }
                                return [...prev, cat.key];
                              });
                            }}
                              className={`px-1.5 py-0.5 rounded text-[9px] font-medium transition-colors border ${
                                isActive
                                  ? "bg-violet-500/20 text-violet-400 border-violet-500/30"
                                  : "bg-muted/10 text-muted-foreground/50 border-border/20"
                              }`}>
                              {cat.icon} {cat.label}
                            </button>
                          );
                        })}
                      </div>
                      <p className="text-[9px] text-muted-foreground">
                        {selectedPoiCategories.length === 0 ? "Tutti i POI attivi" : `${selectedPoiCategories.length} categorie selezionate`}
                      </p>
                    </div>

                    {/* Phase 17: Travel times — stop-by-stop */}
                    {scenarioLines.length > 0 && (
                      <div className="border-t border-border/30 pt-3 space-y-2">
                        <div className="flex items-center justify-between">
                          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1">
                            <Timer className="w-3 h-3 text-blue-400" /> Tempi di percorrenza fermata per fermata
                          </p>
                          <button
                            onClick={async () => {
                              if (!pdeScenarioId) return;
                              setLineStopsLoading(true);
                              try {
                                const data = await apiFetch<any>(`/api/scenarios/${pdeScenarioId}/line-stops?avgSpeedKmh=${pdeConfig.avgSpeedKmh}`);
                                const lines = data.lines || [];
                                setLineStopsData(lines);
                                // Initialize stopTransitTimes from calculated values
                                const newTransits: Record<string, number[]> = {};
                                for (const line of lines) {
                                  newTransits[String(line.lineIndex)] = line.stops
                                    .slice(1)
                                    .map((s: any) => Math.round(s.transitTimeMin * 10) / 10);
                                }
                                setStopTransitTimes(newTransits);
                                // Also set lineTravelTimes totals
                                const newTotals: Record<string, number> = {};
                                for (const line of lines) {
                                  newTotals[String(line.lineIndex)] = Math.round(line.totalTimeMin);
                                }
                                setLineTravelTimes(newTotals);
                                if (lines.length > 0) setExpandedLineIdx(0);
                              } catch (err: any) {
                                alert(`Errore calcolo tempi: ${err.message}`);
                              } finally { setLineStopsLoading(false); }
                            }}
                            disabled={lineStopsLoading}
                            className="flex items-center gap-1.5 px-2.5 py-1 bg-blue-600/20 text-blue-400 rounded text-[10px] font-medium hover:bg-blue-600/30 transition-colors disabled:opacity-50">
                            {lineStopsLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Zap className="w-3 h-3" />}
                            {lineStopsLoading ? "Calcolo…" : "Calcola automaticamente"}
                          </button>
                        </div>

                        {lineStopsData.length === 0 && (
                          <p className="text-[9px] text-muted-foreground italic">
                            Premi "Calcola automaticamente" per ottenere i tempi stimati fermata-per-fermata basati su distanza e traffico.
                          </p>
                        )}

                        {/* Line tabs */}
                        {lineStopsData.length > 0 && (
                          <div className="space-y-2">
                            <div className="flex items-center gap-1 flex-wrap">
                              {lineStopsData.map((line: any) => {
                                const isExpanded = expandedLineIdx === line.lineIndex;
                                const totalMin = (stopTransitTimes[String(line.lineIndex)] || []).reduce((a: number, b: number) => a + b, 0);
                                return (
                                  <button key={line.lineIndex}
                                    onClick={() => setExpandedLineIdx(isExpanded ? null : line.lineIndex)}
                                    className={`flex items-center gap-1 px-2 py-1 rounded text-[9px] font-medium transition-all border ${
                                      isExpanded
                                        ? "bg-blue-500/20 text-blue-400 border-blue-500/30 ring-1 ring-blue-500/20"
                                        : "bg-muted/20 text-muted-foreground border-border/30 hover:text-foreground"
                                    }`}>
                                    <Route className="w-3 h-3" />
                                    <span className="truncate max-w-[100px]">{line.lineName}</span>
                                    <span className="text-[8px] opacity-70">({line.stopsCount} ferm.)</span>
                                    <Badge variant="secondary" className="text-[7px] px-1 py-0">{Math.round(totalMin)} min</Badge>
                                  </button>
                                );
                              })}
                            </div>

                            {/* Expanded line — stop-by-stop table */}
                            {expandedLineIdx !== null && (() => {
                              const lineData = lineStopsData.find((l: any) => l.lineIndex === expandedLineIdx);
                              if (!lineData) return null;
                              const transits = stopTransitTimes[String(expandedLineIdx)] || [];
                              const totalMin = transits.reduce((a, b) => a + b, 0);
                              return (
                                <div className="bg-background/50 rounded-lg border border-border/30 overflow-hidden">
                                  <div className="px-3 py-1.5 bg-blue-500/5 border-b border-border/20 flex items-center justify-between">
                                    <span className="text-[10px] font-semibold text-blue-400 flex items-center gap-1">
                                      <Route className="w-3 h-3" /> {lineData.lineName}
                                      <span className="text-muted-foreground font-normal ml-1">— {lineData.lengthKm} km, {lineData.stopsCount} fermate</span>
                                    </span>
                                    <span className="text-[10px] font-bold text-blue-400">{Math.round(totalMin * 10) / 10} min totali</span>
                                  </div>
                                  <div className="max-h-[350px] overflow-y-auto">
                                    <table className="w-full text-[9px]">
                                      <thead className="sticky top-0 bg-background/90 backdrop-blur-sm">
                                        <tr className="border-b border-border/20">
                                          <th className="text-left px-1 py-1 text-muted-foreground font-medium w-6"></th>
                                          <th className="text-left px-2 py-1 text-muted-foreground font-medium w-8">#</th>
                                          <th className="text-left px-2 py-1 text-muted-foreground font-medium">Fermata</th>
                                          <th className="text-right px-2 py-1 text-muted-foreground font-medium w-16">Dist. (m)</th>
                                          <th className="text-right px-2 py-1 text-muted-foreground font-medium w-16">Traffico</th>
                                          <th className="text-center px-2 py-1 text-muted-foreground font-medium w-20">Transito (min)</th>
                                          <th className="text-right px-2 py-1 text-muted-foreground font-medium w-16">Cumul.</th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {lineData.stops.map((stop: any, si: number) => {
                                          const transitIdx = si - 1;
                                          const transitMin = si > 0 ? (transits[transitIdx] ?? stop.transitTimeMin) : 0;
                                          const cumulMin = lineData.stops.slice(1, si + 1).reduce(
                                            (acc: number, _: any, idx: number) => acc + (transits[idx] ?? lineData.stops[idx + 1]?.transitTimeMin ?? 0), 0
                                          );
                                          const congPct = stop.congestion ? Math.round(stop.congestion * 100) : 0;
                                          return (
                                            <tr
                                              key={si}
                                              draggable
                                              onDragStart={() => setDragIdx(si)}
                                              onDragOver={e => { e.preventDefault(); e.currentTarget.classList.add("bg-blue-500/10"); }}
                                              onDragLeave={e => { e.currentTarget.classList.remove("bg-blue-500/10"); }}
                                              onDrop={e => {
                                                e.preventDefault();
                                                e.currentTarget.classList.remove("bg-blue-500/10");
                                                if (dragIdx === null || dragIdx === si) return;
                                                // Reorder stops in lineStopsData
                                                setLineStopsData(prev => prev.map(ld => {
                                                  if (ld.lineIndex !== expandedLineIdx) return ld;
                                                  const newStops = [...ld.stops];
                                                  const [moved] = newStops.splice(dragIdx, 1);
                                                  newStops.splice(si, 0, moved);
                                                  // Reindex
                                                  return { ...ld, stops: newStops.map((s: any, idx: number) => ({ ...s, index: idx })) };
                                                }));
                                                // Also reorder transit times
                                                setStopTransitTimes(prev => {
                                                  const key = String(expandedLineIdx);
                                                  const arr = [...(prev[key] || [])];
                                                  if (arr.length > 0) {
                                                    const [movedT] = arr.splice(Math.max(0, dragIdx - 1), 1);
                                                    arr.splice(Math.max(0, si - 1), 0, movedT);
                                                  }
                                                  return { ...prev, [key]: arr };
                                                });
                                                setDragIdx(null);
                                              }}
                                              onDragEnd={() => setDragIdx(null)}
                                              className={`border-b border-border/10 cursor-grab active:cursor-grabbing transition-colors ${
                                                si === 0 || si === lineData.stops.length - 1 ? "bg-blue-500/5" : "hover:bg-muted/10"
                                              } ${dragIdx === si ? "opacity-40" : ""}`}
                                            >
                                              <td className="px-1 py-1 text-muted-foreground/40 cursor-grab">
                                                <GripVertical className="w-3 h-3" />
                                              </td>
                                              <td className="px-2 py-1 text-muted-foreground">{si + 1}</td>
                                              <td className="px-2 py-1 font-medium max-w-[220px]" title={stop.name}>
                                                <div className="flex flex-col">
                                                  <span className="truncate">
                                                    {si === 0 && <span className="text-blue-400 mr-1">▶</span>}
                                                    {si === lineData.stops.length - 1 && <span className="text-red-400 mr-1">◼</span>}
                                                    {stop.name}
                                                  </span>
                                                  {stop.stopId && <span className="text-[7px] text-muted-foreground/60 font-mono">{stop.stopId}</span>}
                                                </div>
                                              </td>
                                              <td className="px-2 py-1 text-right text-muted-foreground">
                                                {si > 0 ? Math.round(stop.distFromPrevKm * 1000) : "—"}
                                              </td>
                                              <td className="px-2 py-1 text-right">
                                                {si > 0 ? (
                                                  <span className={`px-1 py-0.5 rounded text-[8px] ${
                                                    congPct > 60 ? "bg-red-500/20 text-red-400" :
                                                    congPct > 30 ? "bg-amber-500/20 text-amber-400" :
                                                    "bg-emerald-500/20 text-emerald-400"
                                                  }`}>{congPct}%</span>
                                                ) : "—"}
                                              </td>
                                              <td className="px-2 py-1 text-center">
                                                {si > 0 ? (
                                                  <input
                                                    type="number" min={0.1} max={60} step={0.1}
                                                    value={transits[transitIdx] ?? Math.round(stop.transitTimeMin * 10) / 10}
                                                    onChange={e => {
                                                      const val = Number(e.target.value);
                                                      setStopTransitTimes(prev => {
                                                        const arr = [...(prev[String(expandedLineIdx)] || [])];
                                                        arr[transitIdx] = val;
                                                        return { ...prev, [String(expandedLineIdx)]: arr };
                                                      });
                                                    }}
                                                    className="w-14 bg-background border border-border/50 rounded px-1 py-0.5 text-[9px] text-center focus:ring-1 focus:ring-blue-500/30 focus:border-blue-500/50"
                                                  />
                                                ) : "—"}
                                              </td>
                                              <td className="px-2 py-1 text-right font-medium text-muted-foreground">
                                                {si > 0 ? `${Math.round(cumulMin * 10) / 10}′` : "0′"}
                                              </td>
                                            </tr>
                                          );
                                        })}
                                      </tbody>
                                    </table>
                                  </div>
                                </div>
                              );
                            })()}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Generate button */}
                    <div className="flex items-center justify-end pt-2">
                      <button onClick={generatePde} disabled={pdeLoading}
                        className="flex items-center gap-2 bg-emerald-600 text-white px-5 py-2 rounded-lg text-sm font-medium hover:bg-emerald-500 transition-colors disabled:opacity-50">
                        {pdeLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                        {pdeLoading ? "Generazione…" : "Genera Programma"}
                      </button>
                    </div>

                    {/* Saved programs list */}
                    {pdeSavedList.length > 0 && (
                      <div className="border-t border-border/30 pt-3 space-y-1.5">
                        <span className="text-[10px] text-muted-foreground font-medium">Programmi salvati:</span>
                        {pdeSavedList.map(p => (
                          <div key={p.id} className="flex items-center gap-2 bg-background/50 rounded px-2.5 py-1.5 text-xs">
                            <button onClick={() => loadPdeProgram(p.id)} className="flex-1 text-left hover:text-primary transition-colors truncate">
                              {p.name}
                            </button>
                            <span className="text-[9px] text-muted-foreground shrink-0">{new Date(p.createdAt).toLocaleDateString("it-IT")}</span>
                            {pdeConfirmDelete === p.id ? (
                              <button
                                onClick={(e) => { e.stopPropagation(); deletePdeProgram(p.id, true); }}
                                className="px-2 py-0.5 bg-red-600 text-white text-[9px] font-semibold rounded hover:bg-red-500 transition-colors animate-pulse shrink-0">
                                Conferma
                              </button>
                            ) : (
                              <button
                                onClick={(e) => { e.stopPropagation(); deletePdeProgram(p.id, false); }}
                                disabled={pdeDeleting === p.id}
                                className="p-1 -m-1 text-muted-foreground hover:text-red-400 shrink-0 rounded transition-colors disabled:opacity-50"
                                title="Elimina programma">
                                {pdeDeleting === p.id
                                  ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                  : <Trash2 className="w-3.5 h-3.5" />}
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* ── Result tab ── */}
                {pdeTab === "result" && pdeResult && !pdeLoading && (
                  <div className="space-y-4">
                    {/* Line selector */}
                    {pdeResult.totalLines > 1 && (
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-[10px] text-muted-foreground font-medium">Linea:</span>
                        <button onClick={() => setPdeSelectedLine(-1)}
                          className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${pdeSelectedLine === -1 ? "bg-emerald-500/20 text-emerald-400 ring-1 ring-emerald-500/30" : "text-muted-foreground hover:text-foreground bg-muted/20"}`}>
                          Tutte ({pdeResult.totalLines})
                        </button>
                        {(pdeResult.lines || []).map((ls: any) => (
                          <button key={ls.lineIndex} onClick={() => setPdeSelectedLine(ls.lineIndex)}
                            className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${pdeSelectedLine === ls.lineIndex ? "bg-emerald-500/20 text-emerald-400 ring-1 ring-emerald-500/30" : "text-muted-foreground hover:text-foreground bg-muted/20"}`}>
                            {ls.lineName.length > 12 ? ls.lineName.slice(0, 10) + "…" : ls.lineName}
                          </button>
                        ))}
                      </div>
                    )}

                    {/* Summary cards */}
                    {(() => {
                      const sel = pdeSelectedLine >= 0 ? pdeResult.lines?.find((l: any) => l.lineIndex === pdeSelectedLine) : null;
                      const totalTrips = sel ? sel.totalTrips : pdeResult.totalTrips;
                      const totalKm = sel ? sel.totalKm : pdeResult.totalKm;
                      const lengthKm = sel ? sel.lengthKm : pdeResult.routeLengthKm;
                      const stopsCount = sel ? sel.stopsCount : pdeResult.stops?.length || 0;
                      return (
                        <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
                          {[
                            { label: "Corse", value: totalTrips, icon: "🚌" },
                            { label: "Km totali", value: `${totalKm} km`, icon: "📏" },
                            { label: "Percorso", value: `${lengthKm} km`, icon: "🛤" },
                            { label: "Fermate", value: stopsCount, icon: "🚏" },
                            { label: pdeSelectedLine >= 0 ? "Linea" : "Linee", value: pdeSelectedLine >= 0 ? sel?.lineName : pdeResult.totalLines, icon: "🗺️" },
                          ].map((m, i) => (
                            <div key={i} className="bg-muted/20 rounded-lg px-3 py-2 text-center">
                              <div className="text-lg">{m.icon}</div>
                              <div className="text-sm font-bold">{m.value}</div>
                              <div className="text-[9px] text-muted-foreground">{m.label}</div>
                            </div>
                          ))}
                        </div>
                      );
                    })()}

                    {/* Metrics */}
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                      {[
                        { label: "Cadenza media", value: `${pdeResult.metrics?.avgCadenceMin} min` },
                        { label: "Cadenza punta", value: `${pdeResult.metrics?.peakCadenceMin} min` },
                        { label: "Tempo medio corsa", value: `${pdeResult.metrics?.avgTravelTimeMin} min` },
                        { label: "Veicoli necessari", value: pdeResult.metrics?.vehiclesNeeded },
                        { label: "Ore servizio totali", value: `${pdeResult.metrics?.totalServiceHours} h` },
                        { label: "Km per veicolo", value: `${pdeResult.metrics?.kmPerVehicle} km` },
                        { label: "Cadenza morbida", value: `${pdeResult.metrics?.offPeakCadenceMin} min` },
                        { label: "Fascia oraria", value: pdeResult.serviceWindow },
                      ].map((m, i) => (
                        <div key={i} className="bg-background/40 border border-border/20 rounded px-2.5 py-1.5">
                          <div className="text-[9px] text-muted-foreground">{m.label}</div>
                          <div className="text-xs font-semibold">{m.value}</div>
                        </div>
                      ))}
                    </div>

                    {/* Coincidences info */}
                    {pdeResult.coincidences && pdeResult.coincidences.length > 0 && (
                      <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg p-3 space-y-2">
                        <div className="flex items-center gap-2">
                          <GitCompareArrows className="w-4 h-4 text-blue-400" />
                          <span className="text-xs font-semibold text-blue-400">Coincidenze ai capolinea ({pdeResult.coincidences.length})</span>
                        </div>
                        <div className="space-y-1">
                          {pdeResult.coincidences.map((c: any, i: number) => (
                            <div key={i} className="flex items-center gap-2 text-[10px]">
                              <MapPin className="w-3 h-3 text-blue-400/60" />
                              <span className="font-medium">{c.stopName}</span>
                              <span className="text-muted-foreground">→</span>
                              <div className="flex gap-1 flex-wrap">
                                {c.lines.map((ln: string, j: number) => (
                                  <span key={j} className="px-1.5 py-0.5 bg-blue-500/15 text-blue-300 rounded text-[9px]">{ln}</span>
                                ))}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Phase 17: Coincidence Zone Sync results */}
                    {pdeResult.coincidenceZoneSync && pdeResult.coincidenceZoneSync.length > 0 && (
                      <div className="bg-cyan-500/10 border border-cyan-500/20 rounded-lg p-3 space-y-2">
                        <div className="flex items-center gap-2">
                          <TrainFront className="w-4 h-4 text-cyan-400" />
                          <span className="text-xs font-semibold text-cyan-400">
                            Sincronizzazione zone intermodali ({pdeResult.coincidenceZoneSync.length})
                          </span>
                        </div>
                        {pdeResult.coincidenceZoneSync.map((czs: any, i: number) => (
                          <div key={i} className="space-y-1">
                            <div className="flex items-center gap-2 text-[10px] font-medium">
                              <span style={{ color: czs.hubType === "railway" ? "#06b6d4" : czs.hubType === "port" ? "#8b5cf6" : "#888" }}>
                                {czs.hubType === "railway" ? "��" : czs.hubType === "port" ? "⛴️" : "🔗"} {czs.zoneName}
                              </span>
                              <Badge variant="secondary" className="text-[8px]">{czs.syncedTrips.length} corse sincronizzate</Badge>
                            </div>
                            <div className="space-y-0.5 pl-4">
                              {czs.syncedTrips.slice(0, 5).map((st: any, j: number) => (
                                <div key={j} className="flex items-center gap-2 text-[9px] text-muted-foreground">
                                  <span className="text-cyan-400">{st.departureTime}</span>
                                  <span>→</span>
                                  <span className="font-medium text-foreground/80">{st.lineName}</span>
                                  <span className="text-muted-foreground/60">sinc. arrivo {st.origin} {st.syncedWithArrival}</span>
                                </div>
                              ))}
                              {czs.syncedTrips.length > 5 && (
                                <p className="text-[9px] text-muted-foreground">+{czs.syncedTrips.length - 5} altre corse sincronizzate</p>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Phase 17: Traffic slowdown info */}
                    {pdeResult.trafficSlowdownApplied && pdeResult.perArcSlowdowns && pdeResult.perArcSlowdowns.length > 0 && (
                      <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg p-3 space-y-2">
                        <div className="flex items-center gap-2">
                          <Zap className="w-4 h-4 text-amber-400" />
                          <span className="text-xs font-semibold text-amber-400">Rallentamento traffico per arco</span>
                        </div>
                        {pdeResult.perArcSlowdowns.map((line: any, i: number) => (
                          <div key={i} className="space-y-1">
                            <p className="text-[10px] font-medium">{line.lineName}</p>
                            <div className="flex flex-wrap gap-1">
                              {line.segments.slice(0, 6).map((seg: any, j: number) => {
                                const slowdown = seg.adjustedMin > seg.baseMin ? Math.round((seg.adjustedMin / seg.baseMin - 1) * 100) : 0;
                                return (
                                  <div key={j} className={`px-1.5 py-0.5 rounded text-[8px] font-mono border ${
                                    slowdown > 30 ? "bg-red-500/15 border-red-500/30 text-red-300"
                                    : slowdown > 10 ? "bg-amber-500/15 border-amber-500/30 text-amber-300"
                                    : "bg-emerald-500/15 border-emerald-500/30 text-emerald-300"
                                  }`}>
                                    {seg.from.slice(0, 8)}→{seg.to.slice(0, 8)}: {seg.baseMin}→{seg.adjustedMin}min {slowdown > 0 && `(+${slowdown}%)`}
                                  </div>
                                );
                              })}
                              {line.segments.length > 6 && (
                                <span className="text-[8px] text-muted-foreground self-center">+{line.segments.length - 6} archi</span>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Lines summary table */}
                    {pdeSelectedLine === -1 && pdeResult.lines && pdeResult.lines.length > 1 && (
                      <div>
                        <h4 className="text-[10px] font-semibold text-muted-foreground mb-2">Riepilogo per linea</h4>
                        <div className="overflow-x-auto rounded border border-border/20">
                          <table className="w-full text-[10px]">
                            <thead>
                              <tr className="bg-muted/20 text-muted-foreground">
                                <th className="px-2 py-1.5 text-left font-medium">Linea</th>
                                <th className="px-2 py-1.5 text-right font-medium">Km</th>
                                <th className="px-2 py-1.5 text-right font-medium">Fermate</th>
                                <th className="px-2 py-1.5 text-right font-medium">Corse</th>
                                <th className="px-2 py-1.5 text-right font-medium">Km tot</th>
                                <th className="px-2 py-1.5 text-right font-medium">Domanda</th>
                              </tr>
                            </thead>
                            <tbody>
                              {pdeResult.lines.map((ls: any) => (
                                <tr key={ls.lineIndex} className="border-t border-border/10 hover:bg-muted/10 cursor-pointer" onClick={() => setPdeSelectedLine(ls.lineIndex)}>
                                  <td className="px-2 py-1 font-medium text-emerald-400">{ls.lineName}</td>
                                  <td className="px-2 py-1 text-right">{ls.lengthKm}</td>
                                  <td className="px-2 py-1 text-right">{ls.stopsCount}</td>
                                  <td className="px-2 py-1 text-right">{ls.totalTrips}</td>
                                  <td className="px-2 py-1 text-right">{ls.totalKm}</td>
                                  <td className="px-2 py-1 text-right">{ls.avgDemandScore}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}

                    {/* Cadence profile chart */}
                    {(() => {
                      const sel = pdeSelectedLine >= 0 ? pdeResult.lines?.find((l: any) => l.lineIndex === pdeSelectedLine) : null;
                      const profile = sel ? sel.cadenceProfile : pdeResult.cadenceProfile;
                      if (!profile) return null;
                      return (
                        <div>
                          <h4 className="text-[10px] font-semibold text-muted-foreground mb-2">
                            Profilo cadenza {sel ? `— ${sel.lineName}` : "globale"}
                          </h4>
                          <div className="h-[140px]">
                            <ResponsiveContainer width="100%" height="100%">
                              <BarChart data={profile.map((c: any) => ({
                                name: c.window.replace(/_/g, " ").replace("mattina ", "matt. ").replace("pomeriggio ", "pom. ").replace("sera ", ""),
                                cadenza: c.cadenceMin,
                                corse: c.tripsInWindow,
                              }))}>
                                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                                <XAxis dataKey="name" tick={{ fill: "#888", fontSize: 9 }} />
                                <YAxis tick={{ fill: "#888", fontSize: 9 }} />
                                <ReTooltip contentStyle={{ backgroundColor: "#1a1a2e", border: "1px solid #333", borderRadius: 8, fontSize: 11 }} />
                                <Bar dataKey="cadenza" name="Cadenza (min)" fill="#10b981" radius={[4, 4, 0, 0]} />
                                <Bar dataKey="corse" name="N° corse" fill="#3b82f6" radius={[4, 4, 0, 0]} />
                              </BarChart>
                            </ResponsiveContainer>
                          </div>
                        </div>
                      );
                    })()}

                    {/* Demand heatmap for stops */}
                    {(() => {
                      const sel = pdeSelectedLine >= 0 ? pdeResult.lines?.find((l: any) => l.lineIndex === pdeSelectedLine) : null;
                      const stops = sel ? sel.stops : pdeResult.stops;
                      if (!stops || stops.length === 0) return null;
                      const maxD = Math.max(...stops.map((x: any) => x.demandScore || 1));
                      return (
                        <div>
                          <h4 className="text-[10px] font-semibold text-muted-foreground mb-2">
                            Indice domanda fermate {sel ? `— ${sel.lineName}` : ""}
                          </h4>
                          <div className="flex flex-wrap gap-1">
                            {stops.map((s: any, i: number) => {
                              const pct = maxD > 0 ? (s.demandScore / maxD) : 0;
                              const bg = pct > 0.7 ? "bg-red-500/30 text-red-300" : pct > 0.4 ? "bg-amber-500/30 text-amber-300" : "bg-emerald-500/30 text-emerald-300";
                              return (
                                <span key={i} className={`px-1.5 py-0.5 rounded text-[9px] ${bg}`} title={`Demand: ${s.demandScore}`}>
                                  {s.name.length > 20 ? s.name.slice(0, 18) + "…" : s.name}
                                </span>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                )}

                {/* ── Gantt tab ── */}
                {pdeTab === "gantt" && pdeResult && !pdeLoading && (
                  <div className="space-y-3">
                    {/* Line selector for Gantt */}
                    {pdeResult.totalLines > 1 && (
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-[10px] text-muted-foreground font-medium">Linea:</span>
                        <button onClick={() => setPdeSelectedLine(-1)}
                          className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${pdeSelectedLine === -1 ? "bg-emerald-500/20 text-emerald-400 ring-1 ring-emerald-500/30" : "text-muted-foreground hover:text-foreground bg-muted/20"}`}>
                          Tutte
                        </button>
                        {(pdeResult.lines || []).map((ls: any) => (
                          <button key={ls.lineIndex} onClick={() => setPdeSelectedLine(ls.lineIndex)}
                            className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${pdeSelectedLine === ls.lineIndex ? "bg-emerald-500/20 text-emerald-400 ring-1 ring-emerald-500/30" : "text-muted-foreground hover:text-foreground bg-muted/20"}`}>
                            {ls.lineName.length > 12 ? ls.lineName.slice(0, 10) + "…" : ls.lineName}
                          </button>
                        ))}
                      </div>
                    )}

                    {(() => {
                      const filteredTrips = pdeSelectedLine >= 0
                        ? (pdeResult.trips || []).filter((t: any) => t.lineIndex === pdeSelectedLine)
                        : (pdeResult.trips || []);
                      return (
                        <>
                          <h4 className="text-[10px] font-semibold text-muted-foreground">
                            Diagramma corse — {filteredTrips.length} corse
                            {pdeSelectedLine >= 0 && ` (${pdeResult.lines?.find((l: any) => l.lineIndex === pdeSelectedLine)?.lineName})`}
                          </h4>
                          <div className="relative overflow-x-auto">
                            <div className="min-w-[700px]">
                              {/* Time axis */}
                              <div className="flex items-center border-b border-border/30 pb-1 mb-2">
                                <div className="w-[100px] shrink-0 text-[9px] text-muted-foreground">Corsa</div>
                                <div className="flex-1 relative h-4">
                                  {Array.from({ length: 19 }, (_, i) => i + 5).map(h => {
                                    const pct = ((h - 5) / 19) * 100;
                                    return <span key={h} className="absolute text-[8px] text-muted-foreground/60" style={{ left: `${pct}%` }}>{h}:00</span>;
                                  })}
                                </div>
                              </div>
                              {/* Trip bars */}
                              <div className="space-y-0.5 max-h-[300px] overflow-y-auto">
                                {filteredTrips.map((trip: any, idx: number) => {
                                  const depParts = trip.departureTime.split(":");
                                  const arrParts = trip.arrivalTime.split(":");
                                  const depMin = parseInt(depParts[0]) * 60 + parseInt(depParts[1]);
                                  const arrMin = parseInt(arrParts[0]) * 60 + parseInt(arrParts[1]);
                                  const startPct = ((depMin - 300) / (24 * 60 - 300)) * 100;
                                  const widthPct = ((arrMin - depMin) / (24 * 60 - 300)) * 100;
                                  const isAndata = trip.direction === "andata";
                                  // Color by line (cycle through 10 hues)
                                  const lineColors = ["#10b981", "#3b82f6", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899", "#06b6d4", "#84cc16", "#f97316", "#6366f1"];
                                  const lineColor = pdeSelectedLine === -1 ? lineColors[trip.lineIndex % lineColors.length] : (isAndata ? "#10b981" : "#3b82f6");
                                  return (
                                    <div key={idx} className="flex items-center h-[16px]">
                                      <div className="w-[100px] shrink-0 text-[8px] text-muted-foreground truncate" title={trip.tripId}>
                                        {trip.tripId}
                                      </div>
                                      <div className="flex-1 relative h-full">
                                        <div
                                          className="absolute top-0.5 h-[12px] rounded-sm"
                                          style={{
                                            left: `${Math.max(0, startPct)}%`,
                                            width: `${Math.max(0.5, widthPct)}%`,
                                            backgroundColor: lineColor,
                                            opacity: isAndata ? 0.8 : 0.5,
                                          }}
                                          title={`${trip.tripId}: ${trip.departureTime}→${trip.arrivalTime} (${trip.travelTimeMin}min) [${trip.direction}] ${trip.lineName || ""}`}
                                        />
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                              {/* Legend */}
                              <div className="flex items-center gap-4 mt-2 text-[9px] text-muted-foreground flex-wrap">
                                {pdeSelectedLine >= 0 ? (
                                  <>
                                    <span className="flex items-center gap-1"><div className="w-3 h-2 rounded-sm bg-emerald-500/70" /> Andata</span>
                                    <span className="flex items-center gap-1"><div className="w-3 h-2 rounded-sm bg-blue-500/70" /> Ritorno</span>
                                  </>
                                ) : (
                                  (pdeResult.lines || []).slice(0, 10).map((ls: any) => {
                                    const lineColors = ["#10b981", "#3b82f6", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899", "#06b6d4", "#84cc16", "#f97316", "#6366f1"];
                                    return (
                                      <span key={ls.lineIndex} className="flex items-center gap-1">
                                        <div className="w-3 h-2 rounded-sm" style={{ backgroundColor: lineColors[ls.lineIndex % lineColors.length] }} />
                                        {ls.lineName.length > 10 ? ls.lineName.slice(0, 8) + "…" : ls.lineName}
                                      </span>
                                    );
                                  })
                                )}
                              </div>
                            </div>
                          </div>
                        </>
                      );
                    })()}
                  </div>
                )}

                {/* ── TTD (Time-Table Diagram) tab ── */}
                {pdeTab === "ttd" && pdeResult && !pdeLoading && (
                  <div className="space-y-3">
                    {/* Multi-line toggle for TTD */}
                    {pdeResult.totalLines > 1 && (
                      <div className="space-y-2">
                        <span className="text-[10px] text-muted-foreground font-medium">Seleziona linee da visualizzare:</span>
                        <div className="flex items-center gap-2 flex-wrap">
                          <button onClick={() => setPdeTtdLines(pdeTtdLines.length === (pdeResult.lines || []).length ? [] : (pdeResult.lines || []).map((l: any) => l.lineIndex))}
                            className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${pdeTtdLines.length === (pdeResult.lines || []).length ? "bg-emerald-500/20 text-emerald-400 ring-1 ring-emerald-500/30" : "text-muted-foreground hover:text-foreground bg-muted/20"}`}>
                            {pdeTtdLines.length === (pdeResult.lines || []).length ? "Deseleziona tutte" : "Seleziona tutte"}
                          </button>
                          {(pdeResult.lines || []).map((ls: any) => {
                            const active = pdeTtdLines.includes(ls.lineIndex);
                            const lineColors = ["#10b981", "#3b82f6", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899", "#06b6d4", "#84cc16", "#f97316", "#6366f1"];
                            return (
                              <button key={ls.lineIndex}
                                onClick={() => setPdeTtdLines(prev => active ? prev.filter(x => x !== ls.lineIndex) : [...prev, ls.lineIndex])}
                                className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors border ${active ? "border-current" : "border-transparent text-muted-foreground hover:text-foreground bg-muted/20"}`}
                                style={active ? { color: lineColors[ls.lineIndex % lineColors.length], backgroundColor: lineColors[ls.lineIndex % lineColors.length] + "20" } : {}}>
                                {ls.lineName.length > 15 ? ls.lineName.slice(0, 13) + "…" : ls.lineName}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {/* TTD Chart */}
                    {(() => {
                      const lineColors = ["#10b981", "#3b82f6", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899", "#06b6d4", "#84cc16", "#f97316", "#6366f1"];
                      const selectedLineIndices = pdeTtdLines.length > 0 ? pdeTtdLines : (pdeResult.totalLines === 1 ? [0] : []);
                      if (selectedLineIndices.length === 0) {
                        return <div className="text-center text-xs text-muted-foreground py-8">Seleziona almeno una linea per visualizzare il TTD</div>;
                      }

                      // Collect stops for selected lines (ordered)
                      const allLineStops: { lineName: string; lineIndex: number; stops: { name: string; position: number }[] }[] = [];
                      for (const li of selectedLineIndices) {
                        const lineSummary = (pdeResult.lines || []).find((l: any) => l.lineIndex === li);
                        if (!lineSummary) continue;
                        allLineStops.push({
                          lineName: lineSummary.lineName,
                          lineIndex: li,
                          stops: (lineSummary.stops || []).map((s: any, i: number) => ({
                            name: s.name,
                            position: i,
                          })),
                        });
                      }

                      // For single-line: Y-axis = stops in order, X-axis = time
                      // For multi-line: merged stop list
                      const primaryLine = allLineStops[0];
                      if (!primaryLine) return null;

                      const yStops = primaryLine.stops;
                      const timeStartMin = (pdeResult.metrics?.peakCadenceMin ? 5 : 6) * 60; // 5:00 or 6:00
                      const timeEndMin = 23 * 60; // 23:00
                      const timeRange = timeEndMin - timeStartMin;

                      // Get trips for selected lines
                      const trips = (pdeResult.trips || []).filter((t: any) => selectedLineIndices.includes(t.lineIndex));

                      // SVG dimensions
                      const svgW = 900, svgH = Math.max(350, yStops.length * 28 + 80);
                      const padL = 110, padR = 30, padT = 30, padB = 40;
                      const plotW = svgW - padL - padR;
                      const plotH = svgH - padT - padB;

                      const timeToX = (min: number) => padL + ((min - timeStartMin) / timeRange) * plotW;
                      const stopToY = (idx: number) => padT + (idx / Math.max(yStops.length - 1, 1)) * plotH;

                      // Parse time "HH:MM" to minutes
                      const parseTime = (t: string) => { const p = t.split(":"); return parseInt(p[0]) * 60 + parseInt(p[1]); };

                      return (
                        <div className="overflow-x-auto overflow-y-auto max-h-[500px] border border-border/20 rounded-lg bg-background/30">
                          <svg width={svgW} height={svgH} className="select-none">
                            {/* Grid lines - horizontal (stops) */}
                            {yStops.map((_: any, i: number) => (
                              <line key={`h${i}`} x1={padL} x2={svgW - padR} y1={stopToY(i)} y2={stopToY(i)} stroke="rgba(255,255,255,0.06)" strokeWidth={1} />
                            ))}
                            {/* Grid lines - vertical (hours) */}
                            {Array.from({ length: Math.ceil(timeRange / 60) + 1 }, (_, i) => timeStartMin + i * 60).map(min => (
                              <line key={`v${min}`} x1={timeToX(min)} x2={timeToX(min)} y1={padT} y2={svgH - padB} stroke="rgba(255,255,255,0.06)" strokeWidth={1} />
                            ))}

                            {/* Y-axis labels (stop names) */}
                            {yStops.map((s: any, i: number) => (
                              <text key={`yl${i}`} x={padL - 6} y={stopToY(i) + 3} textAnchor="end" fill="#888" fontSize={9}
                                className="select-none pointer-events-none">
                                {s.name.length > 14 ? s.name.slice(0, 12) + "…" : s.name}
                              </text>
                            ))}

                            {/* X-axis labels (hours) */}
                            {Array.from({ length: Math.ceil(timeRange / 60) + 1 }, (_, i) => timeStartMin + i * 60).map(min => (
                              <text key={`xl${min}`} x={timeToX(min)} y={svgH - padB + 16} textAnchor="middle" fill="#888" fontSize={9}
                                className="select-none pointer-events-none">
                                {String(Math.floor(min / 60)).padStart(2, "0")}:00
                              </text>
                            ))}

                            {/* Trip lines */}
                            {trips.map((trip: any, ti: number) => {
                              const color = lineColors[trip.lineIndex % lineColors.length];
                              const isAndata = trip.direction === "andata";
                              // Map stopTimes to coordinates
                              const points: { x: number; y: number; stopName: string; time: string }[] = [];

                              for (let si = 0; si < trip.stopTimes.length; si++) {
                                const st = trip.stopTimes[si];
                                const timeMin = parseTime(st.departure);
                                if (timeMin < timeStartMin || timeMin > timeEndMin) continue;
                                const x = timeToX(timeMin);
                                // Find matching stop in yStops
                                let yIdx = yStops.findIndex((ys: any) => ys.name === st.stopName);
                                if (yIdx < 0) {
                                  // Interpolate based on position
                                  yIdx = isAndata
                                    ? Math.round((si / Math.max(trip.stopTimes.length - 1, 1)) * (yStops.length - 1))
                                    : Math.round(((trip.stopTimes.length - 1 - si) / Math.max(trip.stopTimes.length - 1, 1)) * (yStops.length - 1));
                                }
                                const y = stopToY(yIdx);
                                points.push({ x, y, stopName: st.stopName, time: st.departure });
                              }

                              if (points.length < 2) return null;

                              const pathD = points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");

                              return (
                                <g key={ti}>
                                  <path d={pathD} fill="none" stroke={color} strokeWidth={1.2}
                                    opacity={isAndata ? 0.7 : 0.45}
                                    strokeDasharray={isAndata ? "none" : "3,2"}>
                                    <title>{trip.tripId}: {trip.departureTime}→{trip.arrivalTime} ({trip.direction}) — {trip.lineName}</title>
                                  </path>
                                  {/* Small dot at departure */}
                                  <circle cx={points[0].x} cy={points[0].y} r={2} fill={color} opacity={0.8}>
                                    <title>{trip.tripId} dep {trip.departureTime}</title>
                                  </circle>
                                </g>
                              );
                            })}

                            {/* Coincidence markers */}
                            {(pdeResult.coincidences || []).map((c: any, ci: number) => {
                              // Find if this coincidence involves any selected line
                              const involvedLines = (c.lines || []);
                              const hasSelectedLine = selectedLineIndices.some(li => {
                                const ln = (pdeResult.lines || []).find((l: any) => l.lineIndex === li);
                                return ln && involvedLines.includes(ln.lineName);
                              });
                              if (!hasSelectedLine) return null;
                              // Find stop position
                              const yIdx = yStops.findIndex((ys: any) => ys.name === c.stopName);
                              if (yIdx < 0) return null;
                              return (
                                <g key={`coinc${ci}`}>
                                  <circle cx={padL - 20} cy={stopToY(yIdx)} r={5} fill="rgba(59,130,246,0.3)" stroke="#3b82f6" strokeWidth={1}>
                                    <title>Coincidenza: {c.stopName} — Linee: {involvedLines.join(", ")}</title>
                                  </circle>
                                  <text x={padL - 20} y={stopToY(yIdx) + 3} textAnchor="middle" fill="#3b82f6" fontSize={7} className="select-none pointer-events-none">⇄</text>
                                </g>
                              );
                            })}
                          </svg>
                        </div>
                      );
                    })()}

                    {/* TTD Legend */}
                    <div className="flex items-center gap-4 text-[9px] text-muted-foreground flex-wrap">
                      {(() => {
                        const lineColors = ["#10b981", "#3b82f6", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899", "#06b6d4", "#84cc16", "#f97316", "#6366f1"];
                        const selectedLineIndices = pdeTtdLines.length > 0 ? pdeTtdLines : (pdeResult.totalLines === 1 ? [0] : []);
                        return selectedLineIndices.map((li: number) => {
                          const ls = (pdeResult.lines || []).find((l: any) => l.lineIndex === li);
                          if (!ls) return null;
                          return (
                            <span key={li} className="flex items-center gap-1">
                              <div className="w-4 h-0.5 rounded" style={{ backgroundColor: lineColors[li % lineColors.length] }} />
                              {ls.lineName}
                            </span>
                          );
                        });
                      })()}
                      <span className="flex items-center gap-1"><div className="w-4 h-0.5 rounded bg-white/40" /> Andata (continua)</span>
                      <span className="flex items-center gap-1"><div className="w-4 h-0.5 rounded bg-white/40 border-dashed" style={{ borderTop: "1px dashed white" }} /> Ritorno (tratteggio)</span>
                      {pdeResult.coincidences?.length > 0 && (
                        <span className="flex items-center gap-1"><div className="w-3 h-3 rounded-full bg-blue-500/30 border border-blue-500" /> Coincidenza</span>
                      )}
                    </div>
                  </div>
                )}

                {/* ── GTFS Export tab ── */}
                {pdeTab === "gtfs" && (
                  <div className="space-y-4">
                    {/* Header */}
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Package className="w-4 h-4 text-amber-400" />
                        <span className="text-sm font-bold">Esportazione GTFS</span>
                      </div>
                      {pdeResult?.id && (
                        <span className="text-[9px] text-muted-foreground">
                          Programma: {pdeResult.id?.substring(0, 8)}…
                        </span>
                      )}
                    </div>

                    {!pdeResult?.id ? (
                      <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg p-4 text-center">
                        <AlertTriangle className="w-5 h-5 text-amber-400 mx-auto mb-2" />
                        <p className="text-xs text-muted-foreground">
                          Genera e salva un Programma di Esercizio prima di esportare il GTFS.
                        </p>
                      </div>
                    ) : (
                      <>
                        {/* 1. Calendars section */}
                        <div className="bg-background/50 rounded-lg border border-border/30 overflow-hidden">
                          <div className="px-3 py-2 bg-blue-500/5 border-b border-border/20 flex items-center justify-between">
                            <span className="text-[10px] font-semibold text-blue-400 flex items-center gap-1">
                              <CalendarDays className="w-3 h-3" /> Calendari di validità
                            </span>
                            <div className="flex items-center gap-1.5">
                              <button
                                onClick={async () => {
                                  setGtfsCalLoading(true);
                                  try {
                                    const data = await apiFetch<any>(
                                      `/api/scenarios/${pdeScenarioId}/programs/${pdeResult.id}/calendars`
                                    );
                                    setGtfsCalendars(data.calendars || []);
                                  } catch { }
                                  finally { setGtfsCalLoading(false); }
                                }}
                                className="text-[9px] px-2 py-0.5 bg-muted/30 rounded text-muted-foreground hover:text-foreground transition-colors"
                              >
                                {gtfsCalLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : "Aggiorna"}
                              </button>
                              <button
                                onClick={async () => {
                                  if (!pdeResult?.id || !pdeScenarioId) return;
                                  setGtfsCalLoading(true);
                                  try {
                                    await apiFetch<any>(
                                      `/api/scenarios/${pdeScenarioId}/programs/${pdeResult.id}/calendars/from-all-presets`,
                                      { method: "POST" }
                                    );
                                    const data = await apiFetch<any>(
                                      `/api/scenarios/${pdeScenarioId}/programs/${pdeResult.id}/calendars`
                                    );
                                    setGtfsCalendars(data.calendars || []);
                                    setGtfsValidation(null);
                                  } catch (err: any) {
                                    alert("Errore: " + err.message);
                                  } finally { setGtfsCalLoading(false); }
                                }}
                                disabled={gtfsCalLoading}
                                className="flex items-center gap-1 text-[9px] px-2 py-0.5 bg-blue-600/20 text-blue-400 rounded hover:bg-blue-600/30 transition-colors disabled:opacity-50"
                              >
                                <Zap className="w-3 h-3" />
                                Crea preset italiani
                              </button>
                            </div>
                          </div>

                          {gtfsCalendars.length === 0 ? (
                            <div className="px-3 py-4 text-center">
                              <CalendarX2 className="w-5 h-5 text-muted-foreground mx-auto mb-1.5" />
                              <p className="text-[10px] text-muted-foreground">
                                Nessun calendario. Clicca "Crea preset italiani" per generare automaticamente i 5 calendari standard.
                              </p>
                            </div>
                          ) : (
                            <div className="divide-y divide-border/20">
                              {gtfsCalendars.map((cal: any) => {
                                const days = ["L","M","M","G","V","S","D"];
                                const dayVals = [cal.monday, cal.tuesday, cal.wednesday, cal.thursday, cal.friday, cal.saturday, cal.sunday];
                                const isEditing = gtfsEditingCal === cal.id;
                                return (
                                  <div key={cal.id} className="px-3 py-2">
                                    <div className="flex items-center justify-between">
                                      <div className="flex items-center gap-2">
                                        <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: cal.color }} />
                                        <span className="text-[10px] font-medium">{cal.serviceName}</span>
                                        <div className="flex items-center gap-0.5 ml-1">
                                          {days.map((d, i) => (
                                            <span key={i} className={`text-[8px] w-3.5 h-3.5 rounded flex items-center justify-center font-bold ${
                                              dayVals[i] ? "bg-blue-500/30 text-blue-400" : "bg-muted/20 text-muted-foreground/40"
                                            }`}>{d}</span>
                                          ))}
                                        </div>
                                      </div>
                                      <div className="flex items-center gap-2">
                                        <span className="text-[8px] text-muted-foreground">
                                          {cal.startDate} → {cal.endDate}
                                        </span>
                                        {cal.cadenceMultiplier !== 1 && (
                                          <Badge variant="secondary" className="text-[7px] px-1 py-0">
                                            ×{cal.cadenceMultiplier}
                                          </Badge>
                                        )}
                                        {cal.isVariant && (
                                          <Badge variant="outline" className="text-[7px] px-1 py-0 border-amber-500/30 text-amber-400">
                                            variante
                                          </Badge>
                                        )}
                                        <button
                                          onClick={() => setGtfsEditingCal(isEditing ? null : cal.id)}
                                          className="text-[9px] text-muted-foreground hover:text-foreground"
                                        >
                                          {isEditing ? "Chiudi" : "Dettagli"}
                                        </button>
                                        <button
                                          onClick={async () => {
                                            if (!confirm(`Eliminare il calendario "${cal.serviceName}"?`)) return;
                                            try {
                                              await apiFetch<any>(
                                                `/api/scenarios/${pdeScenarioId}/programs/${pdeResult.id}/calendars/${cal.id}`,
                                                { method: "DELETE" }
                                              );
                                              setGtfsCalendars(prev => prev.filter((c: any) => c.id !== cal.id));
                                              setGtfsValidation(null);
                                            } catch { }
                                          }}
                                          className="text-muted-foreground hover:text-red-400 transition-colors"
                                        >
                                          <Trash2 className="w-3 h-3" />
                                        </button>
                                      </div>
                                    </div>

                                    {/* Expanded: exceptions */}
                                    {isEditing && (
                                      <div className="mt-2 pl-4 space-y-1.5">
                                        <p className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wide">
                                          Eccezioni ({(cal.exceptions || []).length})
                                        </p>
                                        <div className="max-h-[120px] overflow-y-auto space-y-0.5">
                                          {(cal.exceptions || []).map((exc: any) => (
                                            <div key={exc.id} className="flex items-center justify-between text-[9px] bg-muted/10 rounded px-2 py-0.5">
                                              <span className="flex items-center gap-1.5">
                                                <span className={exc.exceptionType === 1 ? "text-emerald-400" : "text-red-400"}>
                                                  {exc.exceptionType === 1 ? "+" : "−"}
                                                </span>
                                                <span className="text-muted-foreground">{exc.exceptionDate}</span>
                                                <span>{exc.description || ""}</span>
                                              </span>
                                              <button
                                                onClick={async () => {
                                                  try {
                                                    await apiFetch<any>(
                                                      `/api/scenarios/${pdeScenarioId}/programs/${pdeResult.id}/calendars/${cal.id}/exceptions/${exc.id}`,
                                                      { method: "DELETE" }
                                                    );
                                                    setGtfsCalendars(prev => prev.map((c: any) =>
                                                      c.id === cal.id
                                                        ? { ...c, exceptions: (c.exceptions || []).filter((e: any) => e.id !== exc.id) }
                                                        : c
                                                    ));
                                                  } catch { }
                                                }}
                                                className="text-muted-foreground hover:text-red-400"
                                              >
                                                <X className="w-2.5 h-2.5" />
                                              </button>
                                            </div>
                                          ))}
                                        </div>
                                        {/* Add exception */}
                                        <div className="flex items-center gap-1.5 pt-1">
                                          <input type="date" value={gtfsNewExcDate}
                                            onChange={e => setGtfsNewExcDate(e.target.value)}
                                            className="bg-background border border-border/50 rounded px-1.5 py-0.5 text-[9px] w-28" />
                                          <input type="text" placeholder="Descrizione" value={gtfsNewExcDesc}
                                            onChange={e => setGtfsNewExcDesc(e.target.value)}
                                            className="bg-background border border-border/50 rounded px-1.5 py-0.5 text-[9px] flex-1" />
                                          <select value={gtfsNewExcType} onChange={e => setGtfsNewExcType(Number(e.target.value))}
                                            className="bg-background border border-border/50 rounded px-1 py-0.5 text-[9px] w-20">
                                            <option value={2}>Rimosso</option>
                                            <option value={1}>Aggiunto</option>
                                          </select>
                                          <button
                                            onClick={async () => {
                                              if (!gtfsNewExcDate) return;
                                              try {
                                                const created = await apiFetch<any>(
                                                  `/api/scenarios/${pdeScenarioId}/programs/${pdeResult.id}/calendars/${cal.id}/exceptions`,
                                                  {
                                                    method: "POST",
                                                    body: JSON.stringify({ exceptionDate: gtfsNewExcDate, exceptionType: gtfsNewExcType, description: gtfsNewExcDesc }),
                                                  }
                                                );
                                                setGtfsCalendars(prev => prev.map((c: any) =>
                                                  c.id === cal.id
                                                    ? { ...c, exceptions: [...(c.exceptions || []), created] }
                                                    : c
                                                ));
                                                setGtfsNewExcDate("");
                                                setGtfsNewExcDesc("");
                                              } catch { }
                                            }}
                                            className="px-2 py-0.5 bg-emerald-600/20 text-emerald-400 rounded text-[9px] hover:bg-emerald-600/30"
                                          >
                                            + Aggiungi
                                          </button>
                                        </div>
                                      </div>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>

                        {/* 2. Validation + Preview */}
                        {gtfsCalendars.length > 0 && (
                          <div className="space-y-3">
                            <button
                              onClick={async () => {
                                if (!pdeResult?.id || !pdeScenarioId) return;
                                setGtfsValidating(true);
                                try {
                                  const result = await apiFetch<any>(
                                    `/api/scenarios/${pdeScenarioId}/programs/${pdeResult.id}/validate-gtfs`
                                  );
                                  setGtfsValidation(result);
                                } catch (err: any) {
                                  alert("Errore validazione: " + err.message);
                                } finally { setGtfsValidating(false); }
                              }}
                              disabled={gtfsValidating}
                              className="flex items-center gap-2 w-full justify-center bg-amber-500/10 border border-amber-500/20 text-amber-400 px-4 py-2 rounded-lg text-xs font-medium hover:bg-amber-500/20 transition-colors disabled:opacity-50"
                            >
                              {gtfsValidating ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}
                              {gtfsValidating ? "Validazione in corso…" : "Valida Feed GTFS"}
                            </button>

                            {/* Validation results */}
                            {gtfsValidation && (
                              <div className={`rounded-lg border p-3 space-y-2 ${
                                gtfsValidation.valid
                                  ? "bg-emerald-500/10 border-emerald-500/20"
                                  : "bg-red-500/10 border-red-500/20"
                              }`}>
                                <div className="flex items-center gap-2">
                                  {gtfsValidation.valid
                                    ? <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                                    : <AlertTriangle className="w-4 h-4 text-red-400" />}
                                  <span className={`text-xs font-bold ${gtfsValidation.valid ? "text-emerald-400" : "text-red-400"}`}>
                                    {gtfsValidation.valid ? "Validazione OK" : `${gtfsValidation.errors.length} errori trovati`}
                                  </span>
                                </div>

                                {/* Stats */}
                                <div className="grid grid-cols-4 gap-2 text-[9px]">
                                  <div><span className="text-muted-foreground">Agenzia:</span> <span className="font-medium">1</span></div>
                                  <div><span className="text-muted-foreground">Linee:</span> <span className="font-medium">{gtfsValidation.stats.routes}</span></div>
                                  <div><span className="text-muted-foreground">Corse:</span> <span className="font-medium">{gtfsValidation.stats.trips.toLocaleString("it-IT")}</span></div>
                                  <div><span className="text-muted-foreground">Fermate:</span> <span className="font-medium">{gtfsValidation.stats.stops}</span></div>
                                  <div><span className="text-muted-foreground">Stop times:</span> <span className="font-medium">{gtfsValidation.stats.stopTimes.toLocaleString("it-IT")}</span></div>
                                  <div><span className="text-muted-foreground">Shapes:</span> <span className="font-medium">{gtfsValidation.stats.shapes}</span></div>
                                  <div><span className="text-muted-foreground">Calendari:</span> <span className="font-medium">{gtfsValidation.stats.calendars}</span></div>
                                  <div><span className="text-muted-foreground">Eccezioni:</span> <span className="font-medium">{gtfsValidation.stats.calendarDates}</span></div>
                                </div>

                                {/* Errors */}
                                {gtfsValidation.errors.length > 0 && (
                                  <div className="space-y-0.5 pt-1">
                                    {gtfsValidation.errors.map((e: any, i: number) => (
                                      <div key={i} className="flex items-start gap-1.5 text-[9px] text-red-400">
                                        <span className="shrink-0">❌</span>
                                        <span>{e.message}</span>
                                      </div>
                                    ))}
                                  </div>
                                )}

                                {/* Warnings */}
                                {gtfsValidation.warnings.length > 0 && (
                                  <div className="space-y-0.5 pt-1">
                                    {gtfsValidation.warnings.map((w: any, i: number) => (
                                      <div key={i} className="flex items-start gap-1.5 text-[9px] text-amber-400">
                                        <span className="shrink-0">⚠️</span>
                                        <span>{w.message}</span>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                            )}

                            {/* 3. Export button */}
                            {gtfsValidation?.valid && (
                              <button
                                onClick={async () => {
                                  if (!pdeResult?.id || !pdeScenarioId) return;
                                  setGtfsExporting(true);
                                  try {
                                    const apiBase = getApiBase();
                                    const url = `${apiBase}/api/scenarios/${pdeScenarioId}/programs/${pdeResult.id}/export-gtfs`;
                                    const resp = await fetch(url);
                                    if (!resp.ok) {
                                      const err = await resp.json().catch(() => ({ error: "Download fallito" }));
                                      throw new Error(err.error || "Errore");
                                    }
                                    const blob = await resp.blob();
                                    const a = document.createElement("a");
                                    a.href = URL.createObjectURL(blob);
                                    const cd = resp.headers.get("content-disposition") || "";
                                    const fnMatch = cd.match(/filename="?([^"]+)"?/);
                                    a.download = fnMatch ? fnMatch[1] : "gtfs_export.zip";
                                    document.body.appendChild(a);
                                    a.click();
                                    document.body.removeChild(a);
                                    URL.revokeObjectURL(a.href);
                                  } catch (err: any) {
                                    alert("Errore export: " + err.message);
                                  } finally { setGtfsExporting(false); }
                                }}
                                disabled={gtfsExporting}
                                className="flex items-center gap-2 w-full justify-center bg-emerald-600 text-white px-5 py-2.5 rounded-lg text-sm font-medium hover:bg-emerald-500 transition-colors disabled:opacity-50"
                              >
                                {gtfsExporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                                {gtfsExporting ? "Esportazione in corso…" : "Scarica GTFS ZIP"}
                              </button>
                            )}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )}

              </CardContent>
            </Card>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Map style controls — bottom right ───────────────── */}
      <div className="absolute bottom-6 right-4 flex flex-col gap-2 pointer-events-auto">
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
      <div className="absolute top-4 right-4 md:w-56 pointer-events-none z-10">
        <motion.div initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.1 }}
          className="pointer-events-auto">
          {(visibleIds.size > 0 || showPoi) && (
            <Card className="bg-card/85 backdrop-blur-xl border-border/50 shadow-xl overflow-hidden">
              <button onClick={() => setLegendCollapsed(v => !v)}
                className="w-full px-3 py-2.5 flex items-center justify-between hover:bg-muted/20 transition-colors">
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Legenda</span>
                {legendCollapsed ? <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" /> : <ChevronUp className="w-3.5 h-3.5 text-muted-foreground" />}
              </button>
              <AnimatePresence initial={false}>
                {!legendCollapsed && (
                  <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2 }} className="overflow-hidden">
                    <CardContent className="px-3 pb-3 pt-0 space-y-2 border-t border-border/30">
                      {/* Visible scenarios */}
                      {Array.from(visibleIds).map(id => {
                        const s = scenarioList.find(x => x.id === id);
                        if (!s) return null;
                        return (
                          <div key={id} className="flex items-center gap-2 pt-1">
                            <div className="w-6 h-1 rounded-full" style={{ backgroundColor: s.color }} />
                            <span className="text-[10px] text-muted-foreground truncate">{s.name}</span>
                          </div>
                        );
                      })}
                      {/* POI legend */}
                      {showPoi && (
                        <div className="space-y-1 pt-1 border-t border-border/20">
                          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">POI</p>
                          {Object.entries(POI_COLOR).filter(([cat]) => selectedPoiCats.includes(cat)).map(([cat, color]) => (
                            <div key={cat} className="flex items-center gap-2">
                              <div className="w-2.5 h-2.5 rounded-full border border-black/30" style={{ backgroundColor: color }} />
                              <span className="text-[10px] text-muted-foreground flex items-center gap-1">{POI_ICON[cat]} {POI_CATEGORY_IT[cat]}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </CardContent>
                  </motion.div>
                )}
              </AnimatePresence>
            </Card>
          )}
        </motion.div>
      </div>
    </div>
  );
}
