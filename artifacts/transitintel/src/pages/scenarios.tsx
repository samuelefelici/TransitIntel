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
  Ruler, BarChart3, AlertTriangle, CheckCircle2, Info,
  Cross, GraduationCap, ShoppingBag, Factory, Dumbbell, Landmark, TrainFront,
  Briefcase, Church, HeartHandshake, CircleParking, Camera,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { getApiBase } from "@/lib/api";

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN || "";

const MAP_STYLES: Record<string, string> = {
  dark: "mapbox://styles/mapbox/dark-v11",
  city3d: "mapbox://styles/mapbox/standard",
  "city3d-dark": "mapbox://styles/mapbox/standard",
  satellite: "mapbox://styles/mapbox/satellite-streets-v12",
};

type ViewMode = "dark" | "city3d" | "city3d-dark" | "satellite";

const SCENARIO_COLORS = [
  "#3b82f6", "#ef4444", "#22c55e", "#f59e0b", "#a855f7", "#ec4899",
  "#06b6d4", "#f97316", "#8b5cf6", "#14b8a6",
];

const POI_CATEGORY_IT: Record<string, string> = {
  hospital: "Sanità", school: "Istruzione", shopping: "Commercio",
  industrial: "Zona Industriale", leisure: "Sport / Svago", office: "Uffici / P.A.",
  transit: "Hub Trasporti", workplace: "Aziende", worship: "Culto",
  elderly: "RSA", parking: "Parcheggi", tourism: "Cultura",
};
const POI_COLOR: Record<string, string> = {
  hospital: "#ef4444", school: "#eab308", shopping: "#a855f7",
  industrial: "#f97316", leisure: "#22c55e", office: "#3b82f6",
  transit: "#06b6d4", workplace: "#64748b", worship: "#d946ef",
  elderly: "#f43f5e", parking: "#94a3b8", tourism: "#14b8a6",
};
const POI_ICON: Record<string, React.ReactNode> = {
  hospital: <Cross className="w-3 h-3" />, school: <GraduationCap className="w-3 h-3" />,
  shopping: <ShoppingBag className="w-3 h-3" />, industrial: <Factory className="w-3 h-3" />,
  leisure: <Dumbbell className="w-3 h-3" />, office: <Landmark className="w-3 h-3" />,
  transit: <TrainFront className="w-3 h-3" />, workplace: <Briefcase className="w-3 h-3" />,
  worship: <Church className="w-3 h-3" />, elderly: <HeartHandshake className="w-3 h-3" />,
  parking: <CircleParking className="w-3 h-3" />, tourism: <Camera className="w-3 h-3" />,
};

/* SVG path data for POI map icons (reuse from dashboard) */
const POI_SVG_PATHS: Record<string, string[]> = {
  hospital: ["M8 2v4M16 2v4M3 10h18M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01M16 18h.01", "M9 2h6M12 10v8M9 14h6"],
  school: ["M22 10v6M2 10l10-5 10 5-10 5z", "M6 12v5c0 2 6 3 6 3s6-1 6-3v-5"],
  shopping: ["M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z", "M3 6h18", "M16 10a4 4 0 01-8 0"],
  industrial: ["M2 20h20", "M5 20V8l5 6V8l5 6V4h3v16"],
  leisure: ["M6.5 6.5a3.5 3.5 0 117 0 3.5 3.5 0 01-7 0", "M2 12h20M6 12a4 4 0 010-8M6 12a4 4 0 000 8M18 12a4 4 0 000-8M18 12a4 4 0 010 8"],
  office: ["M3 22V6l9-4 9 4v16", "M3 10h18M7 22V10M11 22V10M15 22V10M19 22V10"],
  transit: ["M4 11V6a2 2 0 012-2h12a2 2 0 012 2v5", "M4 15h16M6 19l2-4M16 19l2-4M4 11h16v4H4z", "M9 7h6"],
  workplace: ["M8 21H5a2 2 0 01-2-2V5a2 2 0 012-2h14a2 2 0 012 2v14a2 2 0 01-2 2h-3", "M16 3v4M8 3v4M3 11h18", "M12 11v4M9 15h6"],
  worship: ["M18 2v4M6 2v4M12 2v10", "M8 6h8M2 22l4-10h12l4 10", "M12 12l-2 10M12 12l2 10"],
  elderly: ["M10 15v5M14 15v5M12 2a3 3 0 100 6 3 3 0 000-6z", "M19 14c-1-1-3-2-7-2s-6 1-7 2", "M17 20H7"],
  parking: ["M12 2a10 10 0 100 20 10 10 0 000-20z", "M9 17V7h4a3 3 0 010 6H9"],
  tourism: ["M14.5 4h-5L7 7H4a2 2 0 00-2 2v9a2 2 0 002 2h16a2 2 0 002-2V9a2 2 0 00-2-2h-3l-2.5-3z", "M12 13a3 3 0 100-6 3 3 0 000 6z"],
};

function renderPoiIcon(category: string): ImageData {
  const size = 48;
  const canvas = document.createElement("canvas");
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.beginPath(); ctx.arc(size / 2, size / 2, size / 2 - 2, 0, Math.PI * 2);
  ctx.fillStyle = POI_COLOR[category] || "#888"; ctx.fill();
  ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 2; ctx.stroke();
  const iconScale = 26 / 24; const offset = (size - 26) / 2;
  ctx.save(); ctx.translate(offset, offset); ctx.scale(iconScale, iconScale);
  ctx.strokeStyle = "#ffffff"; ctx.fillStyle = "none"; ctx.lineWidth = 1.8; ctx.lineCap = "round"; ctx.lineJoin = "round";
  const paths = POI_SVG_PATHS[category] || [];
  for (const d of paths) { ctx.stroke(new Path2D(d)); }
  ctx.restore();
  return ctx.getImageData(0, 0, size, size);
}

// ─── Types ──────────────────────────────────────────────────────────────
interface ScenarioItem {
  id: string;
  name: string;
  description?: string;
  color: string;
  stopsCount: number;
  lengthKm: number;
  createdAt: string;
}

interface ScenarioFull extends ScenarioItem {
  geojson: any;
  metadata: any;
}

interface ComuneStats {
  code: string;
  name: string;
  totalPop: number;
  coveredPop: number;
  percent: number;
  totalSections: number;
  coveredSections: number;
  poiTotal: number;
  poiCovered: number;
}

interface StopDistribution {
  minInterStopKm: number;
  maxInterStopKm: number;
  avgInterStopKm: number;
  medianInterStopKm: number;
  stopsWithin300m: number;
  gapsOver1km: number;
}

interface AnalysisResult {
  scenario: { id: string; name: string; color: string };
  routes: { name: string; lengthKm: number }[];
  stops: { name: string; lng: number; lat: number }[];
  totalLengthKm: number;
  poiCoverage: { radius: number; total: number; covered: number; percent: number; byCategory: Record<string, { total: number; covered: number }> };
  populationCoverage: { radius: number; totalPop: number; coveredPop: number; percent: number; comuniToccati: number };
  comuniDetails: ComuneStats[];
  stopDistribution: StopDistribution | null;
  accessibilityScore: number;
  efficiencyMetrics: { popPerKm: number; poiPerKm: number; costIndex: number; stopsPerKm: number };
  gapAnalysis: {
    uncoveredPoi: { category: string; name: string; lng: number; lat: number; distKm: number }[];
    underservedComuni: { code: string; name: string; pop: number; coveragePercent: number }[];
  };
}

interface CompareScenario {
  id: string; name: string; color: string; totalLengthKm: number; stopsCount: number;
  poiCoverage: AnalysisResult["poiCoverage"]; populationCoverage: AnalysisResult["populationCoverage"];
  efficiency: AnalysisResult["efficiencyMetrics"];
  accessibilityScore: number;
  comuniDetails: ComuneStats[];
  stopDistribution: StopDistribution | null;
  gapAnalysis: AnalysisResult["gapAnalysis"];
}

interface CompareResult {
  scenarios: CompareScenario[];
  suggestions: string[];
  radius: number;
}

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

  // Popup
  const [popup, setPopup] = useState<{ lng: number; lat: number; type: string; props: Record<string, any> } | null>(null);
  const [cursor, setCursor] = useState("grab");

  const is3D = viewMode === "city3d" || viewMode === "city3d-dark";
  const isStandardStyle = viewMode === "city3d" || viewMode === "city3d-dark";

  // ─── Data fetching ──────────────────────────────────────────────
  const fetchScenarios = useCallback(async () => {
    try {
      const r = await fetch(`${getApiBase()}/api/scenarios`);
      const d = await r.json();
      setScenarioList(d.data || []);
    } catch {}
  }, []);

  useEffect(() => { fetchScenarios(); }, [fetchScenarios]);

  // Fetch POI
  useEffect(() => {
    if (!showPoi || poiData) return;
    fetch(`${getApiBase()}/api/poi`).then(r => r.json()).then(d => setPoiData(d)).catch(() => {});
  }, [showPoi, poiData]);

  // Load scenario geojson when toggled visible
  const loadScenario = useCallback(async (id: string) => {
    if (loadedScenarios[id]) return;
    try {
      const r = await fetch(`${getApiBase()}/api/scenarios/${id}`);
      const data = await r.json();
      setLoadedScenarios(prev => ({ ...prev, [id]: data }));
    } catch {}
  }, [loadedScenarios]);

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

  // Delete
  const handleDelete = useCallback(async (id: string) => {
    if (pendingDeleteId !== id) {
      setPendingDeleteId(id);
      setTimeout(() => setPendingDeleteId(prev => prev === id ? null : prev), 3000);
      return;
    }
    setPendingDeleteId(null);
    await fetch(`${getApiBase()}/api/scenarios/${id}`, { method: "DELETE" });
    setVisibleIds(prev => { const s = new Set(prev); s.delete(id); return s; });
    setLoadedScenarios(prev => { const c = { ...prev }; delete c[id]; return c; });
    setSelectedForCompare(prev => prev.filter(x => x !== id));
    fetchScenarios();
  }, [fetchScenarios, pendingDeleteId]);

  // Analyze single scenario
  const runAnalysis = useCallback(async (id: string) => {
    setAnalysisLoading(true);
    setAnalysisResult(null);
    setCompareResult(null);
    setAnalysisPanelOpen(true);
    try {
      const analysisRes = await fetch(`${getApiBase()}/api/scenarios/${id}/analyze?radius=${analysisRadius}`);
      const data = await analysisRes.json();
      setAnalysisResult(data);
    } catch {
      alert("Errore nell'analisi dello scenario");
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
      const r = await fetch(`${getApiBase()}/api/scenarios/compare?ids=${selectedForCompare.join(",")}&radius=${analysisRadius}`);
      const data = await r.json();
      setCompareResult(data);
    } catch {
      alert("Errore nel confronto scenari");
    } finally {
      setCompareLoading(false);
    }
  }, [selectedForCompare, analysisRadius]);

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
  const scoreBreakdown = useCallback((result: AnalysisResult) => {
    const popScore = Math.min(100, result.populationCoverage.percent * 1.2);
    const poiScore = Math.min(100, result.poiCoverage.percent * 1.3);
    const distScore = result.stopDistribution
      ? Math.min(100, Math.max(0, 100 - result.stopDistribution.gapsOver1km * 8 - result.stopDistribution.stopsWithin300m * 0.5))
      : 50;
    const effScore = Math.min(100, result.efficiencyMetrics.popPerKm / 30);
    return [
      { factor: "Popolazione (40%)", value: Math.round(popScore), weight: 40, color: "#3b82f6" },
      { factor: "POI (30%)", value: Math.round(poiScore), weight: 30, color: "#22c55e" },
      { factor: "Distribuzione (15%)", value: Math.round(distScore), weight: 15, color: "#f59e0b" },
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
                              <button onClick={() => handleDelete(s.id)} title={pendingDeleteId === s.id ? "Clicca di nuovo per confermare" : "Elimina"}
                                className={`p-1 rounded transition-colors ${pendingDeleteId === s.id ? "text-red-400 bg-red-500/20 animate-pulse" : "text-muted-foreground hover:text-red-400"}`}>
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                            <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
                              <span className="flex items-center gap-0.5"><Ruler className="w-3 h-3" /> {s.lengthKm.toFixed(1)} km</span>
                              <span className="flex items-center gap-0.5"><MapPin className="w-3 h-3" /> {s.stopsCount} fermate</span>
                            </div>
                            {/* Quick analyze button */}
                            <button onClick={() => runAnalysis(s.id)}
                              className="w-full flex items-center justify-center gap-1 px-2 py-1 rounded text-[10px] font-medium bg-primary/10 text-primary hover:bg-primary/20 transition-colors">
                              <BarChart3 className="w-3 h-3" /> Analizza
                            </button>
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
                        <p className="text-sm font-bold">×{analysisResult.efficiencyMetrics.costIndex}</p>
                        <p className="text-[8px] text-muted-foreground">indice costo</p>
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
                      <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-2">Copertura POI per categoria (raggio {analysisResult.poiCoverage.radius} km)</p>
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
                      <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1">Copertura popolazione</p>
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
                            <span className="text-muted-foreground">Totale (comuni toccati)</span>
                            <span className="ml-auto font-semibold">{analysisResult.populationCoverage.totalPop.toLocaleString("it-IT")}</span>
                          </div>
                          <p className="text-[9px] text-muted-foreground italic mt-1">
                            Calcolata su {analysisResult.populationCoverage.comuniToccati} comuni attraversati
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
                        { label: "Indice costo", aVal: a.efficiency.costIndex, bVal: b.efficiency.costIndex, fmt: (v: number) => `×${v}`, higher: false },
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
                      <div className="space-y-2">
                        <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1">
                          <Lightbulb className="w-3 h-3 text-amber-400" /> Suggerimenti di ottimizzazione
                        </p>
                        {compareResult.suggestions.map((sug, i) => (
                          <div key={i} className={`text-[11px] px-3 py-2 rounded-lg border ${
                            sug.startsWith("⚠") ? "bg-red-500/10 border-red-500/30 text-red-300" : "bg-amber-500/10 border-amber-500/20 text-amber-200"
                          }`}>
                            {sug}
                          </div>
                        ))}
                      </div>
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
