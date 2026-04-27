/**
 * UnifiedAnalysisTab — Dashboard di analisi unica e fusa.
 *
 * Flusso:
 *  1) Filtro: data calendario (auto giorno+stagione), raggio, linee
 *  2) KPI hero: Costo / Domanda / Interventi (sui filtri attivi)
 *  3) Mappa unica: shapes linee filtrate + buffer + POI rilevanti
 *  4) Tabella linee: KPI economici + copertura per linea
 *  5) Categorie POI: peso domanda + copertura
 *  6) Distribuzione oraria
 *  7) Interventi suggeriti (server-side)
 *  8) Parametri economici (collapsible)
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  CalendarDays, Sun, Snowflake, Footprints, Bus, Search, X, CheckCircle2,
  Sparkles, Loader2, Filter, Wallet, Target, Lightbulb, MapPin, Clock,
  AlertTriangle, AlertCircle, AlertOctagon, Settings2, Save, FileDown,
  TrendingUp, TrendingDown, Hospital, GraduationCap, ShoppingBag, Factory,
  Activity, Building2, TrainFront, Briefcase, Church, HeartHandshake,
  ParkingSquare, Camera, ChevronDown, ChevronRight,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { apiFetch } from "@/lib/api";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip as RTooltip, ResponsiveContainer,
  CartesianGrid, Cell,
} from "recharts";
import { Map as MapGL, Source, Layer, Marker } from "react-map-gl/mapbox";
import type { MapRef } from "react-map-gl/mapbox";
import "mapbox-gl/dist/mapbox-gl.css";
import { usePlanningFilters, SharedDay, Season } from "./PlanningFiltersContext";

const MAPBOX_TOKEN = (import.meta as any).env?.VITE_MAPBOX_TOKEN || "";

/* ───────────────────────── tipi ───────────────────────── */

interface RouteRow {
  routeId: string;
  shortName: string | null;
  longName: string | null;
  color: string | null;
  routeType?: number | null;
}

interface RouteKpi {
  routeId: string;
  shortName: string | null;
  longName: string | null;
  color: string | null;
  serviceType: "urban" | "suburban" | "night";
  category: string | null;
  shapeKm: number;
  tripsDay: number;
  kmDay: number;
  hoursDay: number;
  costTotalDay: number;
  revenueDay: number;
  marginDay: number;
  estimatedPaxDay: number;
  paxPerKm: number;
}

interface Analysis {
  totalKmDay: number;
  totalHoursDay: number;
  totalTripsDay: number;
  activeRoutes: number;
  activeStops: number;
  totalCostDay: number;
  totalRevenueDay: number;
  marginDay: number;
  perRoute: RouteKpi[];
  bbox: { minLat: number; maxLat: number; minLon: number; maxLon: number } | null;
}

interface CategoryRow {
  category: string;
  relevance: number;
  total: number;
  served: number;
  servedPct: number;
  weightedTotal: number;
  weightedServed: number;
}

interface Suggestion {
  severity: "high" | "med" | "low";
  kind: string;
  title: string;
  detail: string;
  action: string;
}

interface CoverageResp {
  meta: { dayType: string; serviceDate: string | null; radiusM: number;
          season: string; dayLabel: string; serviceIds: number };
  summary: {
    populationServed: number; populationTotal: number; coveragePct: number;
    poiServed: number; poiTotal: number; poiCoverageWeighted: number;
    activeStops: number; totalStops: number; totalTrips: number;
    uncoveredPopulation: number;
  };
  byCategory: CategoryRow[];
  byHour: { hour: number; trips: number }[];
  stopsActive: { stopId: string; stopName: string; lat: number; lon: number; trips: number }[];
  coverageGeo: any | null;
  suggestions: Suggestion[];
  unservedPois?: { id: string; name: string | null; category: string;
                   lat: number; lon: number; relevance: number; nearestStopM: number }[];
  uncoveredAreas?: { lat: number; lon: number; pop: number; nearM: number;
                     severity: "high" | "med" | "low" }[];
  warning?: string;
}

interface ShapesGeo {
  type: "FeatureCollection";
  features: any[];
}

interface PoiCatalog {
  pois: { id: string; name: string | null; category: string; lat: number; lng: number }[];
}

interface EconParams {
  fuelConsumptionL100: number;
  fuelPriceEurL: number;
  driverCostEurH: number;
  maintenanceEurKm: number;
  amortizationEurKm: number;
  fareUrbanEurKm: number;
  fareSuburbanEurKm: number;
  fareNightEurKm: number;
}

/* ───────────────────────── costanti UI ───────────────────────── */

const DAYS: { key: SharedDay; label: string; sub: string }[] = [
  { key: "weekday",  label: "Feriale",  sub: "Lun-Ven" },
  { key: "saturday", label: "Sabato",   sub: "" },
  { key: "sunday",   label: "Domenica", sub: "festivo" },
];

const RADII = [300, 400, 500, 800];

const SEASONS: { key: Season; label: string; Icon: LucideIcon }[] = [
  { key: "all",    label: "Annuale", Icon: CalendarDays },
  { key: "summer", label: "Estate",  Icon: Sun },
  { key: "winter", label: "Inverno", Icon: Snowflake },
];

const POI_META: Record<string, { label: string; Icon: LucideIcon; color: string }> = {
  hospital:   { label: "Ospedali / Sanita'",   Icon: Hospital,       color: "#ef4444" },
  school:     { label: "Scuole",                Icon: GraduationCap,  color: "#3b82f6" },
  shopping:   { label: "Centri commerciali",    Icon: ShoppingBag,    color: "#f59e0b" },
  industrial: { label: "Zone industriali",      Icon: Factory,        color: "#71717a" },
  leisure:    { label: "Tempo libero",          Icon: Activity,       color: "#10b981" },
  office:     { label: "Uffici / PA",           Icon: Building2,      color: "#06b6d4" },
  transit:    { label: "Stazioni",              Icon: TrainFront,     color: "#8b5cf6" },
  workplace:  { label: "Posti di lavoro",       Icon: Briefcase,      color: "#0ea5e9" },
  worship:    { label: "Luoghi di culto",       Icon: Church,         color: "#a855f7" },
  elderly:    { label: "RSA / Anziani",         Icon: HeartHandshake, color: "#d946ef" },
  parking:    { label: "Parcheggi",             Icon: ParkingSquare,  color: "#64748b" },
  tourism:    { label: "Turismo / Cultura",     Icon: Camera,         color: "#ec4899" },
  beach:      { label: "Spiagge",               Icon: Sun,            color: "#fbbf24" },
  seaside:    { label: "Mare / Costa",          Icon: Sun,            color: "#fbbf24" },
};
const metaFor = (cat: string) => POI_META[cat] || { label: cat, Icon: MapPin, color: "#888" };

/* ───────────────────────── helpers ───────────────────────── */

const fmtNum = (n: number, d = 0) =>
  new Intl.NumberFormat("it-IT", { maximumFractionDigits: d }).format(n);
const fmtEur = (n: number) =>
  new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(n);

function isoFromGtfs(s: string | null): string {
  if (!s || !/^\d{8}$/.test(s)) return "";
  return s.slice(0, 4) + "-" + s.slice(4, 6) + "-" + s.slice(6, 8);
}
function gtfsFromIso(s: string): string | null {
  if (!s) return null;
  return s.replace(/-/g, "");
}

function colorForRoute(routeId: string, gtfsColor: string | null): string {
  if (gtfsColor) {
    const c = String(gtfsColor).replace(/^#/, "").toLowerCase();
    if (/^[0-9a-f]{6}$/.test(c) && c !== "000000" && c !== "ffffff") return "#" + c;
  }
  let hash = 0;
  for (let i = 0; i < routeId.length; i++) hash = (hash * 31 + routeId.charCodeAt(i)) | 0;
  const h = Math.abs(hash) % 360;
  return "hsl(" + h + ", 75%, 58%)";
}

function toneCls(pct: number): string {
  if (pct >= 70) return "text-emerald-400";
  if (pct >= 40) return "text-amber-400";
  return "text-red-400";
}

/* --- Bacino: categorizzazione automatica delle linee Conerobus --- */
type Bacino = "ancona" | "jesi" | "falconara" | "extraurbano";

const BACINI: { key: Bacino; label: string; short: string; color: string }[] = [
  { key: "ancona",      label: "Urbano Ancona",    short: "Ancona",     color: "#3b82f6" },
  { key: "jesi",        label: "Urbano Jesi",      short: "Jesi",       color: "#10b981" },
  { key: "falconara",   label: "Urbano Falconara", short: "Falconara",  color: "#f59e0b" },
  { key: "extraurbano", label: "Extraurbano",      short: "Extraurbano",color: "#a855f7" },
];

/**
 * Classifica una linea nel suo bacino di appartenenza in base al codice GTFS.
 * Regole Conerobus:
 *  - JE*  -> Urbano Jesi
 *  - Y*   -> Urbano Falconara
 *  - codice numerico (incluse varianti C.D./C.S.) -> Urbano Ancona
 *  - tutto il resto -> Extraurbano
 */
function routeBacino(r: { shortName: string | null; routeId: string }): Bacino {
  const s = (r.shortName || r.routeId || "").trim().toUpperCase();
  if (/^JE/.test(s)) return "jesi";
  if (/^Y/.test(s)) return "falconara";
  if (/^\d/.test(s)) return "ancona";
  return "extraurbano";
}

/* ═══════════════════════════════════════════════════════════════
   COMPONENT
   ═══════════════════════════════════════════════════════════════ */

export default function UnifiedAnalysisTab({ feedId }: { feedId: string | null }) {
  const ctx = usePlanningFilters();

  const [routes, setRoutes] = useState<RouteRow[]>([]);
  const [routesLoading, setRoutesLoading] = useState(false);
  const [routeSearch, setRouteSearch] = useState("");
  const [routePanelOpen, setRoutePanelOpen] = useState(false);

  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [coverage, setCoverage] = useState<CoverageResp | null>(null);
  const [shapes, setShapes] = useState<ShapesGeo | null>(null);
  const [pois, setPois] = useState<PoiCatalog["pois"]>([]);
  const [params, setParams] = useState<EconParams | null>(null);
  const [showParams, setShowParams] = useState(false);
  const [showPois, setShowPois] = useState(true);
  const [showBuffer, setShowBuffer] = useState(true);
  const [showNegative, setShowNegative] = useState(true);     // overlay zone NON servite (negativo)
  const [showUnservedPois, setShowUnservedPois] = useState(true);
  const [hiddenCats, setHiddenCats] = useState<Set<string>>(new Set());
  const [routeSort, setRouteSort] = useState<"cost" | "trips" | "margin" | "name">("cost");
  const [hoveredRouteId, setHoveredRouteId] = useState<string | null>(null);

  const [loadingAnalyze, setLoadingAnalyze] = useState(false);
  const [loadingCoverage, setLoadingCoverage] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savingParams, setSavingParams] = useState(false);

  const mapRef = useRef<MapRef | null>(null);

  // ── carica linee + POI catalog + parametri economici (una volta per feed) ──
  useEffect(() => {
    if (!feedId) {
      setRoutes([]); setPois([]); setParams(null);
      setAnalysis(null); setCoverage(null); setShapes(null);
      return;
    }
    setRoutesLoading(true);
    Promise.all([
      apiFetch<{ routes: RouteRow[] }>("/api/planning/feeds/" + feedId + "/routes"),
      apiFetch<PoiCatalog>("/api/planning/feeds/" + feedId + "/poi-catalog").catch(() => ({ pois: [] })),
      apiFetch<{ params: EconParams }>("/api/planning/feeds/" + feedId + "/economic-params").catch(() => null),
    ])
      .then(([rs, poi, pr]) => {
        setRoutes(rs.routes || []);
        setPois(poi.pois || []);
        if (pr) setParams(pr.params);
      })
      .catch((e) => setError(e?.message || "Errore caricamento"))
      .finally(() => setRoutesLoading(false));
  }, [feedId]);

  if (!ctx) {
    return <div className="p-6 text-sm text-destructive">PlanningFiltersProvider mancante.</div>;
  }

  const {
    serviceDate, setServiceDate,
    day, setDay,
    radiusM, setRadiusM,
    season, setSeason,
    selectedRouteIds, toggleRouteId, clearRoutes, setSelectedRouteIds,
    derivedFromDate,
  } = ctx;

  const selectedArr = useMemo(() => Array.from(selectedRouteIds), [selectedRouteIds]);
  const allSelected = selectedArr.length === 0;

  const filtersKey = useMemo(
    () => JSON.stringify({ feedId, serviceDate, day, season, radiusM, sel: selectedArr }),
    [feedId, serviceDate, day, season, radiusM, selectedArr]
  );

  // ── carica /analyze (KPI economici per linea) sui filtri attivi ──
  useEffect(() => {
    if (!feedId) return;
    setLoadingAnalyze(true);
    apiFetch<{ analysis: Analysis }>("/api/planning/feeds/" + feedId + "/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        dayType: day,
        serviceDate: serviceDate || null,
        routeIds: selectedArr.length > 0 ? selectedArr : null,
        categoryFilter: null,
      }),
    })
      .then((r) => setAnalysis(r.analysis))
      .catch((e) => setError(e?.message || "Errore /analyze"))
      .finally(() => setLoadingAnalyze(false));
  }, [filtersKey]);

  // ── carica /service-coverage (copertura, POI, suggerimenti) ──
  useEffect(() => {
    if (!feedId) return;
    setLoadingCoverage(true);
    const qp = new URLSearchParams({ dayType: day, radiusM: String(radiusM), season });
    if (serviceDate) qp.set("serviceDate", serviceDate);
    if (selectedArr.length > 0) qp.set("routeIds", selectedArr.join(","));
    apiFetch<CoverageResp>("/api/planning/feeds/" + feedId + "/service-coverage?" + qp.toString())
      .then(setCoverage)
      .catch((e) => setError(e?.message || "Errore /service-coverage"))
      .finally(() => setLoadingCoverage(false));
  }, [filtersKey]);

  // ── carica shapes filtrate ──
  useEffect(() => {
    if (!feedId) return;
    const qs = selectedArr.length > 0 ? "?routes=" + selectedArr.join(",") : "";
    apiFetch<ShapesGeo>("/api/planning/feeds/" + feedId + "/shapes" + qs)
      .then((g) => {
        if (g && Array.isArray(g.features)) {
          for (const f of g.features) {
            const rid = f.properties?.routeId;
            f.properties.lineColor = rid ? colorForRoute(rid, f.properties?.color) : "#3b82f6";
          }
        }
        setShapes(g);
      })
      .catch(() => setShapes(null));
  }, [feedId, selectedArr.join(",")]);

  // ── fit map a bbox ──
  useEffect(() => {
    if (!analysis?.bbox || !mapRef.current) return;
    const b = analysis.bbox;
    mapRef.current.fitBounds(
      [[b.minLon, b.minLat], [b.maxLon, b.maxLat]],
      { padding: 60, duration: 600 }
    );
  }, [analysis?.bbox]);

  /* ───── derivati ───── */

  const filteredRoutesUI = useMemo(() => {
    const q = routeSearch.toLowerCase().trim();
    if (!q) return routes;
    return routes.filter((r) =>
      (r.shortName || "").toLowerCase().includes(q) ||
      (r.longName || "").toLowerCase().includes(q) ||
      r.routeId.toLowerCase().includes(q)
    );
  }, [routes, routeSearch]);

  const relevantPoiCats = useMemo(() => {
    if (!coverage) return new Set<string>();
    const s = new Set<string>();
    for (const c of coverage.byCategory) if (c.relevance > 0) s.add(c.category);
    return s;
  }, [coverage]);

  const visiblePois = useMemo(() => {
    if (!showPois) return [];
    return pois.filter((p) => relevantPoiCats.has(p.category) && !hiddenCats.has(p.category));
  }, [pois, relevantPoiCats, hiddenCats, showPois]);

  // KPI hero unificati
  const kpi = useMemo(() => {
    if (!analysis || !coverage) return null;
    const cost = analysis.totalCostDay || 0;
    const pop = coverage.summary.populationServed;
    const trips = coverage.summary.totalTrips || analysis.totalTripsDay || 1;
    return {
      costDay: cost,
      costYear: cost * 365,
      revenueDay: analysis.totalRevenueDay || 0,
      marginDay: analysis.marginDay || 0,
      kmDay: analysis.totalKmDay || 0,
      tripsDay: analysis.totalTripsDay || 0,
      activeRoutes: analysis.activeRoutes || 0,
      costPerInhabitant: pop > 0 ? cost / pop : 0,
      costPerTrip: trips > 0 ? cost / trips : 0,
      coveragePct: coverage.summary.coveragePct,
      poiPct: coverage.summary.poiCoverageWeighted,
      populationServed: pop,
      uncoveredPop: coverage.summary.uncoveredPopulation,
      activeStops: coverage.summary.activeStops,
      totalStops: coverage.summary.totalStops,
      suggestionsCount: coverage.suggestions.length,
      sugHigh: coverage.suggestions.filter((s) => s.severity === "high").length,
      sugMed:  coverage.suggestions.filter((s) => s.severity === "med").length,
      sugLow:  coverage.suggestions.filter((s) => s.severity === "low").length,
    };
  }, [analysis, coverage]);

  // Linee per la tabella: filtro CLIENT-SIDE come safeguard, anche se il backend filtra gia'.
  // Cosi' garantiamo che cio' che vedi in tabella corrisponda esattamente alla selezione attiva.
  const sortedRouteRows = useMemo(() => {
    if (!analysis) return [];
    let rows = [...analysis.perRoute];
    if (!allSelected) {
      rows = rows.filter((r) => selectedRouteIds.has(r.routeId));
    }
    rows.sort((a, b) => {
      switch (routeSort) {
        case "trips":  return b.tripsDay - a.tripsDay;
        case "margin": return b.marginDay - a.marginDay;
        case "name":   return (a.shortName || a.routeId).localeCompare(b.shortName || b.routeId);
        case "cost":
        default:       return b.costTotalDay - a.costTotalDay;
      }
    });
    return rows;
  }, [analysis, routeSort, allSelected, selectedRouteIds]);

  // Shapes filtrate CLIENT-SIDE: l'endpoint /shapes puo' restituire shapes "condivise"
  // tra piu' route; rifiltriamo per garantire che in mappa appaiano SOLO le linee selezionate.
  const visibleShapes = useMemo<ShapesGeo | null>(() => {
    if (!shapes) return null;
    if (allSelected) return shapes;
    const feats = shapes.features.filter(
      (f: any) => f.properties && selectedRouteIds.has(f.properties.routeId)
    );
    return { type: "FeatureCollection", features: feats };
  }, [shapes, allSelected, selectedRouteIds]);

  const initialView = useMemo(() => {
    if (analysis?.bbox) {
      return {
        longitude: (analysis.bbox.minLon + analysis.bbox.maxLon) / 2,
        latitude:  (analysis.bbox.minLat + analysis.bbox.maxLat) / 2,
        zoom: 10,
      };
    }
    return { longitude: 13.51, latitude: 43.60, zoom: 10 };
  }, [analysis?.bbox]);

  function selectAllVisible() {
    setSelectedRouteIds(new Set(filteredRoutesUI.map((r) => r.routeId)));
  }

  async function saveParams() {
    if (!feedId || !params) return;
    setSavingParams(true);
    try {
      await apiFetch("/api/planning/feeds/" + feedId + "/economic-params", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
      });
      // re-trigger analyze
      const r = await apiFetch<{ analysis: Analysis }>("/api/planning/feeds/" + feedId + "/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dayType: day, serviceDate: serviceDate || null,
          routeIds: selectedArr.length > 0 ? selectedArr : null, categoryFilter: null,
        }),
      });
      setAnalysis(r.analysis);
    } catch (e: any) {
      setError(e?.message || "Errore salvataggio parametri");
    } finally {
      setSavingParams(false);
    }
  }

  if (!feedId) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        Seleziona un feed GTFS di base per analizzare il servizio.
      </div>
    );
  }

  /* ═══════════════════════════════════════════════════════════════
     RENDER
     ═══════════════════════════════════════════════════════════════ */

  return (
    <div className="space-y-4">
      {/* ─────────────────────── TOOLBAR EXPORT ─────────────────────── */}
      <div className="flex flex-wrap items-center gap-2 p-2.5 bg-gradient-to-r from-blue-500/10 to-purple-500/10 border-2 border-blue-500/30 rounded-lg">
        <span className="text-xs font-semibold mr-auto flex items-center gap-1.5">
          <FileDown className="w-4 h-4 text-blue-400" /> Esporta analisi:
        </span>
        <button
          onClick={() => __exportTechReport({ feedId, day, season, radiusM, serviceDate, selectedArr, analysis, coverage, params })}
          disabled={!analysis && !coverage}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs border border-border bg-card hover:bg-muted disabled:opacity-50"
          title="Apre il report tecnico in una nuova scheda (stampabile / salvabile in PDF)"
        >
          <FileDown className="w-3.5 h-3.5" />
          Report tecnico
        </button>
        <button
          onClick={() => __exportNarrativeReport({ feedId, day, season, radiusM, serviceDate, selectedArr, analysis, coverage, routes })}
          disabled={!analysis && !coverage}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs border-2 border-blue-500 bg-blue-500/30 text-blue-100 hover:bg-blue-500/40 font-semibold disabled:opacity-50"
          title="Apre il report narrativo in una nuova scheda (per stakeholder non tecnici, stampabile)"
        >
          <FileDown className="w-3.5 h-3.5" />
          📖 Report narrativo (storytelling)
        </button>
      </div>

      {/* ─────────────────────── BARRA FILTRI UNICA ─────────────────────── */}
      <div className="bg-card border border-border rounded-lg p-4 space-y-4 sticky top-0 z-10 shadow-sm">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Filter className="w-4 h-4 text-primary" />
          Parametri di analisi
          {(loadingAnalyze || loadingCoverage) && (
            <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground ml-1" />
          )}
          <span className="ml-auto text-[11px] text-muted-foreground font-normal">
            ogni KPI sotto e' calcolato esclusivamente sui filtri attivi
          </span>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-3">
          {/* Data */}
          <div className="lg:col-span-4">
            <div className="text-[10px] uppercase text-muted-foreground mb-1 flex items-center gap-1">
              <CalendarDays className="w-3 h-3" /> 1. Data del servizio
              <span className="ml-1 text-muted-foreground/60">(auto-rileva giorno + stagione)</span>
            </div>
            <div className="flex gap-2 items-center">
              <input
                type="date"
                value={isoFromGtfs(serviceDate)}
                onChange={(e) => setServiceDate(gtfsFromIso(e.target.value))}
                className="px-2 py-1.5 rounded-md text-xs border border-border bg-background"
              />
              {serviceDate && (
                <button onClick={() => setServiceDate(null)} title="Rimuovi data"
                  className="p-1 rounded-md hover:bg-muted text-muted-foreground">
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
              {derivedFromDate && (
                <span className="inline-flex items-center gap-1 text-[10px] text-emerald-400">
                  <CheckCircle2 className="w-3 h-3" /> auto
                </span>
              )}
            </div>
          </div>

          {/* Tipo giorno */}
          <div className="lg:col-span-3">
            <div className="text-[10px] uppercase text-muted-foreground mb-1">
              Tipo giorno{derivedFromDate && <span className="ml-1 text-emerald-400">.</span>}
            </div>
            <div className="flex gap-1">
              {DAYS.map((d) => (
                <button key={d.key} onClick={() => setDay(d.key)}
                  className={"px-2.5 py-1.5 rounded-md text-xs border transition-colors " +
                    (day === d.key ? "bg-primary text-primary-foreground border-primary"
                                   : "bg-background border-border hover:bg-muted")}>
                  <div className="font-semibold">{d.label}</div>
                  {d.sub && <div className="text-[9px] opacity-70">{d.sub}</div>}
                </button>
              ))}
            </div>
          </div>

          {/* Stagione */}
          <div className="lg:col-span-3">
            <div className="text-[10px] uppercase text-muted-foreground mb-1">
              Stagione{derivedFromDate && <span className="ml-1 text-emerald-400">.</span>}
            </div>
            <div className="flex gap-1">
              {SEASONS.map((s) => (
                <button key={s.key} onClick={() => setSeason(s.key)}
                  className={"px-2.5 py-1.5 rounded-md text-xs border flex items-center gap-1 " +
                    (season === s.key ? "bg-primary text-primary-foreground border-primary"
                                      : "bg-background border-border hover:bg-muted")}>
                  <s.Icon className="w-3 h-3" /> {s.label}
                </button>
              ))}
            </div>
          </div>

          {/* Raggio */}
          <div className="lg:col-span-2">
            <div className="text-[10px] uppercase text-muted-foreground mb-1 flex items-center gap-1">
              <Footprints className="w-3 h-3" /> Raggio
            </div>
            <div className="flex gap-1">
              {RADII.map((r) => (
                <button key={r} onClick={() => setRadiusM(r)}
                  className={"px-2 py-1.5 rounded-md text-[11px] border " +
                    (radiusM === r ? "bg-primary text-primary-foreground border-primary"
                                   : "bg-background border-border hover:bg-muted")}>
                  {r}m
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Linee */}
        <div className="border-t border-border/50 pt-3">
          <div className="flex items-center gap-2 flex-wrap">
            <Bus className="w-3.5 h-3.5 text-muted-foreground" />
            <div className="text-[10px] uppercase text-muted-foreground">2. Linee da analizzare</div>
            <div className="ml-2 text-xs">
              {allSelected
                ? <span className="text-muted-foreground">Tutte ({routes.length})</span>
                : <span className="text-primary font-semibold">{selectedArr.length} di {routes.length} selezionate</span>}
            </div>
            {!allSelected && (
              <button onClick={clearRoutes}
                className="text-[10px] text-muted-foreground hover:text-foreground inline-flex items-center gap-1">
                <X className="w-3 h-3" /> reset
              </button>
            )}
            <button onClick={() => setRoutePanelOpen((v) => !v)}
              className="ml-auto text-xs px-2 py-1 rounded-md border border-border hover:bg-muted">
              {routePanelOpen ? "Chiudi elenco" : "Scegli linee..."}
            </button>
          </div>

          {routePanelOpen && (
            <div className="mt-2 border border-border/40 rounded-md bg-background/50">
              <div className="p-2 flex items-center gap-2 border-b border-border/40 flex-wrap">
                <Search className="w-3.5 h-3.5 text-muted-foreground" />
                <input value={routeSearch} onChange={(e) => setRouteSearch(e.target.value)}
                  placeholder="Cerca per codice, nome o ID..."
                  className="flex-1 min-w-[160px] bg-transparent text-xs outline-none" />
                <button onClick={selectAllVisible}
                  className="text-[10px] px-2 py-0.5 rounded border border-border hover:bg-muted">
                  Seleziona visibili ({filteredRoutesUI.length})
                </button>
                <button onClick={clearRoutes}
                  className="text-[10px] px-2 py-0.5 rounded border border-border hover:bg-muted">
                  Reset (tutte)
                </button>
              </div>

              {/* Quick-select per bacino */}
              <div className="p-2 flex items-center gap-1 border-b border-border/40 flex-wrap text-[10px]">
                <span className="text-muted-foreground mr-1">Solo bacino:</span>
                {BACINI.map((b) => {
                  const inB = routes.filter((r) => routeBacino(r) === b.key);
                  if (inB.length === 0) return null;
                  return (
                    <button key={b.key}
                      onClick={() => setSelectedRouteIds(new Set(inB.map((r) => r.routeId)))}
                      title={"Seleziona solo le " + inB.length + " linee di " + b.label}
                      className="px-2 py-0.5 rounded border border-border hover:bg-muted inline-flex items-center gap-1">
                      <span className="inline-block w-2 h-2 rounded-full" style={{ background: b.color }} />
                      <span className="font-semibold">{b.short}</span>
                      <span className="text-muted-foreground">({inB.length})</span>
                    </button>
                  );
                })}
              </div>

              <div className="max-h-[380px] overflow-y-auto p-2 space-y-3">
                {routesLoading && (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground p-2">
                    <Loader2 className="w-3 h-3 animate-spin" /> caricamento linee...
                  </div>
                )}
                {!routesLoading && filteredRoutesUI.length === 0 && (
                  <div className="text-xs text-muted-foreground p-2">Nessuna linea trovata.</div>
                )}
                {!routesLoading && BACINI.map((b) => {
                  const list = filteredRoutesUI.filter((r) => routeBacino(r) === b.key);
                  if (list.length === 0) return null;
                  const allSel  = list.every((r) => selectedRouteIds.has(r.routeId));
                  const noneSel = list.every((r) => !selectedRouteIds.has(r.routeId));
                  return (
                    <div key={b.key}>
                      <div className="flex items-center gap-2 mb-1 sticky top-0 bg-background/90 backdrop-blur py-1">
                        <span className="inline-block w-2 h-2 rounded-full" style={{ background: b.color }} />
                        <span className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: b.color }}>
                          {b.label}
                        </span>
                        <span className="text-[10px] text-muted-foreground">({list.length})</span>
                        <button
                          onClick={() => {
                            const next = new Set(selectedRouteIds);
                            if (allSel) list.forEach((r) => next.delete(r.routeId));
                            else        list.forEach((r) => next.add(r.routeId));
                            setSelectedRouteIds(next);
                          }}
                          className="ml-auto text-[10px] underline text-muted-foreground hover:text-foreground"
                        >
                          {allSel ? "deseleziona tutte" : noneSel ? "seleziona tutte" : "seleziona resto"}
                        </button>
                      </div>
                      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-1">
                        {list.map((r) => {
                          const checked = selectedRouteIds.has(r.routeId);
                          const color = colorForRoute(r.routeId, r.color);
                          return (
                            <label key={r.routeId}
                              className={"flex items-center gap-2 px-2 py-1 rounded text-xs cursor-pointer border " +
                                (checked ? "border-primary bg-primary/10" : "border-transparent hover:bg-muted/50")}>
                              <input type="checkbox" checked={checked}
                                onChange={() => toggleRouteId(r.routeId)} className="cursor-pointer" />
                              <span className="inline-block w-2 h-2 rounded-full shrink-0" style={{ background: color }} />
                              <span className="font-semibold shrink-0 min-w-[36px]">{r.shortName || "-"}</span>
                              <span className="text-[9px] font-mono text-muted-foreground shrink-0" title={"GTFS route_id: " + r.routeId}>
                                {r.routeId}
                              </span>
                              <span className="text-muted-foreground truncate text-[10px] flex-1" title={r.longName || ""}>
                                {r.longName || ""}
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Riepilogo filtri */}
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground border-t border-border/40 pt-2 flex-wrap">
          <Sparkles className="w-3 h-3 text-emerald-400" />
          <span>Analizzo:</span>
          <span className="px-1.5 py-0.5 rounded bg-muted">
            {serviceDate ? isoFromGtfs(serviceDate) + " - " : ""}
            {DAYS.find((d) => d.key === day)?.label}
            {" - "}
            {SEASONS.find((s) => s.key === season)?.label}
          </span>
          <span className="px-1.5 py-0.5 rounded bg-muted">raggio {radiusM}m</span>
          <span className="px-1.5 py-0.5 rounded bg-muted">
            {allSelected ? routes.length + " linee (tutte)" : selectedArr.length + " linee"}
          </span>
          {/* breakdown per bacino delle linee effettivamente selezionate */}
          {(() => {
            const considered = allSelected ? routes : routes.filter((r) => selectedRouteIds.has(r.routeId));
            return BACINI.map((b) => {
              const n = considered.filter((r) => routeBacino(r) === b.key).length;
              if (n === 0) return null;
              return (
                <span key={b.key} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded"
                      style={{ background: b.color + "22", color: b.color }}>
                  <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ background: b.color }} />
                  {b.short}: {n}
                </span>
              );
            });
          })()}
          {coverage?.meta?.serviceIds !== undefined && (
            <span className="px-1.5 py-0.5 rounded bg-muted">{coverage.meta.serviceIds} service_id attivi</span>
          )}
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 p-3 bg-destructive/10 text-destructive rounded-lg text-sm">
          <AlertTriangle className="w-4 h-4" /> {error}
          <button onClick={() => setError(null)} className="ml-auto text-xs underline">chiudi</button>
        </div>
      )}
      {coverage?.warning && (
        <div className="flex items-center gap-2 p-3 bg-amber-500/10 text-amber-400 rounded-lg text-sm">
          <AlertTriangle className="w-4 h-4" /> {coverage.warning}
        </div>
      )}

      {/* ─────────────────── KPI HERO unificati ─────────────────── */}
      {kpi && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
          {/* 1. Costo */}
          <div className="bg-card border border-border rounded-lg p-3">
            <div className="text-[10px] uppercase text-muted-foreground mb-1 flex items-center gap-1">
              <Wallet className="w-3 h-3" /> 1. Quanto costa il servizio
            </div>
            <div className="text-2xl font-bold">
              {fmtEur(kpi.costDay)}
              <span className="text-xs font-normal text-muted-foreground">/giorno</span>
            </div>
            <div className="text-[11px] text-muted-foreground mt-0.5">~{fmtEur(kpi.costYear)}/anno</div>
            <div className="grid grid-cols-2 gap-2 mt-3 text-[11px]">
              <Mini label="EUR / abitante coperto" value={kpi.costPerInhabitant > 0 ? fmtEur(kpi.costPerInhabitant) : "-"} />
              <Mini label="EUR / corsa" value={kpi.costPerTrip > 0 ? fmtEur(kpi.costPerTrip) : "-"} />
              <Mini label="Ricavi/giorno" value={fmtEur(kpi.revenueDay)} />
              <Mini label="Margine" value={fmtEur(kpi.marginDay)} tone={kpi.marginDay >= 0 ? "good" : "bad"} />
            </div>
          </div>

          {/* 2. Domanda */}
          <div className="bg-card border border-border rounded-lg p-3">
            <div className="text-[10px] uppercase text-muted-foreground mb-1 flex items-center gap-1">
              <Target className="w-3 h-3" /> 2. Soddisfa la domanda - {coverage?.meta.dayLabel}
            </div>
            <div className="flex items-baseline gap-3">
              <div>
                <div className={"text-2xl font-bold " + toneCls(kpi.coveragePct)}>{kpi.coveragePct}%</div>
                <div className="text-[10px] text-muted-foreground">popolazione coperta</div>
              </div>
              <div>
                <div className={"text-2xl font-bold " + toneCls(kpi.poiPct)}>{kpi.poiPct}%</div>
                <div className="text-[10px] text-muted-foreground">POI rilevanti</div>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2 mt-3 text-[11px]">
              <Mini label="Stop attive" value={fmtNum(kpi.activeStops) + "/" + fmtNum(kpi.totalStops)} />
              <Mini label="Corse" value={fmtNum(kpi.tripsDay) + " (" + fmtNum(kpi.kmDay) + " km)"} />
              <Mini label="Pop. coperta" value={fmtNum(kpi.populationServed) + " ab."} />
              <Mini label="Pop. scoperta" value={fmtNum(kpi.uncoveredPop) + " ab."}
                tone={kpi.uncoveredPop > 50000 ? "bad" : "neutral"} />
            </div>
          </div>

          {/* 3. Interventi */}
          <div className="bg-card border border-border rounded-lg p-3">
            <div className="text-[10px] uppercase text-muted-foreground mb-1 flex items-center gap-1">
              <Lightbulb className="w-3 h-3" /> 3. Interventi suggeriti
            </div>
            <div className="text-2xl font-bold text-amber-400">{kpi.suggestionsCount}</div>
            <div className="text-[11px] text-muted-foreground">azioni identificate sui filtri attivi</div>
            <div className="mt-2 flex gap-1 text-[10px]">
              {kpi.sugHigh > 0 && <span className="px-1.5 py-0.5 rounded bg-red-500/20 text-red-400">{kpi.sugHigh} high</span>}
              {kpi.sugMed  > 0 && <span className="px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400">{kpi.sugMed} med</span>}
              {kpi.sugLow  > 0 && <span className="px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-400">{kpi.sugLow} low</span>}
            </div>
            <a href="#interventi" className="mt-3 inline-block text-xs text-primary hover:underline">
              Vedi tutti gli interventi -&gt;
            </a>
          </div>
        </div>
      )}

      {/* ─────────────────── MAPPA UNICA ─────────────────── */}
      {MAPBOX_TOKEN ? (
        <div className="bg-card border border-border rounded-lg overflow-hidden">
          <div className="px-3 py-2 border-b border-border flex items-center gap-3 flex-wrap">
            <MapPin className="w-3.5 h-3.5 text-muted-foreground" />
            <div className="text-sm font-semibold">Rete e copertura sul territorio</div>
            <div className="ml-auto flex items-center gap-3 text-[11px]">
              <label className="flex items-center gap-1 cursor-pointer">
                <input type="checkbox" checked={showBuffer} onChange={(e) => setShowBuffer(e.target.checked)} />
                buffer pedonale
              </label>
              <label className="flex items-center gap-1 cursor-pointer">
                <input type="checkbox" checked={showPois} onChange={(e) => setShowPois(e.target.checked)} />
                POI serviti
              </label>
              <label className="flex items-center gap-1 cursor-pointer text-red-400">
                <input type="checkbox" checked={showNegative} onChange={(e) => setShowNegative(e.target.checked)} />
                zone NON servite
              </label>
              <label className="flex items-center gap-1 cursor-pointer text-red-400">
                <input type="checkbox" checked={showUnservedPois} onChange={(e) => setShowUnservedPois(e.target.checked)} />
                POI NON serviti
              </label>
            </div>
          </div>
          <div className="h-[480px] relative">
            <MapGL ref={mapRef} mapboxAccessToken={MAPBOX_TOKEN} initialViewState={initialView}
              style={{ width: "100%", height: "100%" }} mapStyle="mapbox://styles/mapbox/dark-v11"
              attributionControl={false}>
              {showBuffer && coverage?.coverageGeo && (
                <Source id="buffer" type="geojson" data={coverage.coverageGeo}>
                  <Layer id="buffer-fill" type="fill"
                    paint={{ "fill-color": "#22c55e", "fill-opacity": 0.08 }} />
                  <Layer id="buffer-outline" type="line"
                    paint={{ "line-color": "#22c55e", "line-width": 0.5, "line-opacity": 0.35 }} />
                </Source>
              )}
              {visibleShapes && (
                <Source id="shapes" type="geojson" data={visibleShapes as any}>
                  <Layer id="shapes-line" type="line"
                    paint={{
                      "line-color": ["coalesce", ["get", "lineColor"], "#3b82f6"],
                      "line-width": ["case",
                        ["==", ["get", "routeId"], hoveredRouteId ?? ""], 5,
                        ["interpolate", ["linear"], ["zoom"], 9, 1.4, 13, 3]],
                      "line-opacity": 0.9,
                    }}
                    layout={{ "line-cap": "round", "line-join": "round" }}
                  />
                </Source>
              )}
              {/* ZONE NON SERVITE: pallini rossi proporzionali alla popolazione scoperta */}
              {showNegative && coverage?.uncoveredAreas && coverage.uncoveredAreas.length > 0 && (
                <Source id="uncovered" type="geojson" data={{
                  type: "FeatureCollection",
                  features: coverage.uncoveredAreas.map((a) => ({
                    type: "Feature",
                    properties: { pop: a.pop, sev: a.severity, near: a.nearM },
                    geometry: { type: "Point", coordinates: [a.lon, a.lat] },
                  })),
                } as any}>
                  <Layer id="uncovered-circle" type="circle"
                    paint={{
                      "circle-radius": ["interpolate", ["linear"], ["get", "pop"],
                        50, 3, 200, 5, 500, 8, 1500, 14, 5000, 22],
                      "circle-color": ["match", ["get", "sev"],
                        "high", "#dc2626", "med", "#f97316", /* low */ "#fbbf24"],
                      "circle-opacity": 0.55,
                      "circle-stroke-color": "#7f1d1d",
                      "circle-stroke-width": 0.6,
                      "circle-stroke-opacity": 0.7,
                    }}
                  />
                </Source>
              )}

              {/* POI NON SERVITI rilevanti */}
              {showUnservedPois && coverage?.unservedPois?.slice(0, 300).map((u) => {
                const m = metaFor(u.category);
                return (
                  <Marker key={"un-" + u.id} longitude={u.lon} latitude={u.lat} anchor="center">
                    <div title={(u.name ?? "(senza nome)") + " - " + m.label + " - peso " + u.relevance.toFixed(2) + "x - " + u.nearestStopM + "m dalla stop"}
                      className="rounded-full p-0.5 ring-2 ring-red-500/80"
                      style={{ background: "rgba(0,0,0,0.55)" }}>
                      <m.Icon className="w-2.5 h-2.5" style={{ color: m.color }} strokeWidth={2.5} />
                    </div>
                  </Marker>
                );
              })}

              {visiblePois.slice(0, 800).map((p) => {
                const m = metaFor(p.category);
                return (
                  <Marker key={p.id} longitude={p.lng} latitude={p.lat} anchor="center">
                    <div title={(p.name ?? "(senza nome)") + " - " + m.label}
                      className="rounded-full p-0.5 shadow-md ring-1 ring-black/40"
                      style={{ background: m.color }}>
                      <m.Icon className="w-2.5 h-2.5 text-white" strokeWidth={2.5} />
                    </div>
                  </Marker>
                );
              })}
            </MapGL>
            <div className="absolute bottom-3 left-3 bg-background/95 backdrop-blur rounded-lg p-2 text-[10px] border border-border/40 space-y-1 max-w-[280px]">
              <div className="font-semibold">Legenda</div>
              {showBuffer && (
                <div className="flex items-center gap-1.5">
                  <span className="inline-block w-3 h-3 rounded-full"
                    style={{ background: "rgba(34,197,94,0.3)", border: "1px solid #22c55e" }} />
                  <span>raggio pedonale {radiusM} m (zone servite)</span>
                </div>
              )}
              {showNegative && coverage?.uncoveredAreas && coverage.uncoveredAreas.length > 0 && (
                <>
                  <div className="flex items-center gap-1.5">
                    <span className="inline-block w-2 h-2 rounded-full" style={{ background: "#dc2626" }} />
                    <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: "#f97316" }} />
                    <span className="inline-block w-3 h-3 rounded-full" style={{ background: "#fbbf24" }} />
                    <span>zone NON servite (alta/media/bassa criticità)</span>
                  </div>
                  <div className="text-muted-foreground pl-1">
                    {coverage.uncoveredAreas.length} sezioni - dimensione = popolazione
                  </div>
                </>
              )}
              {showUnservedPois && coverage?.unservedPois && coverage.unservedPois.length > 0 && (
                <div className="flex items-center gap-1.5">
                  <span className="inline-block w-3 h-3 rounded-full ring-1 ring-red-500" style={{ background: "rgba(0,0,0,0.55)" }} />
                  <span>POI rilevanti NON serviti ({coverage.unservedPois.length})</span>
                </div>
              )}
              <div className="text-muted-foreground pt-1 border-t border-border/40">
                {visiblePois.length} POI serviti - {visibleShapes?.features?.length || 0} linee
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="p-3 bg-amber-500/10 text-amber-400 rounded-lg text-xs">
          VITE_MAPBOX_TOKEN non impostato - mappa disabilitata.
        </div>
      )}

      {/* ─────────────────── TABELLA LINEE (KPI per linea) ─────────────────── */}
      {analysis && sortedRouteRows.length > 0 && (
        <div className="bg-card border border-border rounded-lg overflow-hidden">
          <div className="px-3 py-2 border-b border-border flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-2">
              <Bus className="w-4 h-4 text-muted-foreground" />
              <div className="text-sm font-semibold">
                Linee analizzate ({sortedRouteRows.length}{!allSelected && analysis.perRoute.length !== sortedRouteRows.length ? " di " + analysis.perRoute.length : ""})
              </div>
              <span className="text-[10px] text-muted-foreground">
                click per evidenziare in mappa
              </span>
            </div>
            <div className="flex items-center gap-1 text-[10px]">
              <span className="text-muted-foreground mr-1">ordina per:</span>
              {(["cost","margin","trips","name"] as const).map((s) => (
                <button key={s} onClick={() => setRouteSort(s)}
                  className={"px-1.5 py-0.5 rounded border " +
                    (routeSort === s ? "border-primary bg-primary/10 text-primary"
                                     : "border-border hover:bg-muted")}>
                  {s === "cost" ? "costo" : s === "margin" ? "margine" : s === "trips" ? "corse" : "nome"}
                </button>
              ))}
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-muted/30 text-muted-foreground">
                <tr>
                  <th className="text-left px-3 py-1.5">Linea</th>
                  <th className="text-left px-3 py-1.5">Bacino</th>
                  <th className="text-left px-3 py-1.5">Tipo</th>
                  <th className="text-right px-3 py-1.5">Corse/g</th>
                  <th className="text-right px-3 py-1.5">Km/g</th>
                  <th className="text-right px-3 py-1.5">Costo/g</th>
                  <th className="text-right px-3 py-1.5">Ricavi/g</th>
                  <th className="text-right px-3 py-1.5">Margine</th>
                  <th className="text-right px-3 py-1.5">Pax stim.</th>
                </tr>
              </thead>
              <tbody>
                {sortedRouteRows.map((r) => {
                  const color = colorForRoute(r.routeId, r.color);
                  const isHover = hoveredRouteId === r.routeId;
                  return (
                    <tr key={r.routeId}
                      onMouseEnter={() => setHoveredRouteId(r.routeId)}
                      onMouseLeave={() => setHoveredRouteId(null)}
                      onClick={() => toggleRouteId(r.routeId)}
                      className={"border-t border-border/40 cursor-pointer " +
                        (isHover ? "bg-muted/40" : "hover:bg-muted/20")}>
                      <td className="px-3 py-1.5">
                        <div className="flex items-center gap-2">
                          <span className="inline-block w-2.5 h-2.5 rounded-full shrink-0"
                            style={{ background: color }} />
                          <span className="font-semibold min-w-[36px]">{r.shortName || "-"}</span>
                          <span className="text-[9px] font-mono text-muted-foreground" title={"GTFS route_id: " + r.routeId}>
                            {r.routeId}
                          </span>
                          <span className="text-muted-foreground truncate max-w-[260px] text-[10px]">
                            {r.longName || ""}
                          </span>
                        </div>
                      </td>
                      <td className="px-3 py-1.5">
                        {(() => {
                          const b = BACINI.find((x) => x.key === routeBacino(r))!;
                          return (
                            <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded"
                                  style={{ background: b.color + "22", color: b.color }}>
                              <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ background: b.color }} />
                              {b.short}
                            </span>
                          );
                        })()}
                      </td>
                      <td className="px-3 py-1.5">
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted">
                          {r.serviceType}
                        </span>
                      </td>
                      <td className="text-right px-3 py-1.5 tabular-nums">{fmtNum(r.tripsDay)}</td>
                      <td className="text-right px-3 py-1.5 tabular-nums">{fmtNum(r.kmDay, 0)}</td>
                      <td className="text-right px-3 py-1.5 tabular-nums">{fmtEur(r.costTotalDay)}</td>
                      <td className="text-right px-3 py-1.5 tabular-nums">{fmtEur(r.revenueDay)}</td>
                      <td className={"text-right px-3 py-1.5 tabular-nums " +
                        (r.marginDay >= 0 ? "text-emerald-400" : "text-red-400")}>
                        {r.marginDay >= 0 ? <TrendingUp className="w-3 h-3 inline mr-1" />
                                          : <TrendingDown className="w-3 h-3 inline mr-1" />}
                        {fmtEur(r.marginDay)}
                      </td>
                      <td className="text-right px-3 py-1.5 tabular-nums text-muted-foreground">
                        {fmtNum(r.estimatedPaxDay)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ─────────────────── DOMANDA per CATEGORIA POI ─────────────────── */}
      {coverage && coverage.byCategory.length > 0 && (
        <div className="bg-card border border-border rounded-lg overflow-hidden">
          <div className="px-3 py-2 border-b border-border flex items-center justify-between">
            <div className="text-sm font-semibold">
              Domanda potenziale per categoria - {coverage.meta.dayLabel}
              {season !== "all" && (
                <span className="text-[10px] text-muted-foreground ml-2">
                  ({season === "summer" ? "estate" : "inverno"})
                </span>
              )}
            </div>
            <div className="text-[10px] text-muted-foreground">click per nascondere su mappa</div>
          </div>
          <table className="w-full text-xs">
            <thead className="bg-muted/30 text-muted-foreground">
              <tr>
                <th className="text-left px-3 py-1.5">Categoria</th>
                <th className="text-right px-3 py-1.5">Peso</th>
                <th className="text-right px-3 py-1.5">Totale</th>
                <th className="text-right px-3 py-1.5">Coperti</th>
                <th className="text-right px-3 py-1.5">% copertura</th>
                <th className="text-right px-3 py-1.5">Domanda persa</th>
              </tr>
            </thead>
            <tbody>
              {coverage.byCategory.map((c) => {
                const m = metaFor(c.category);
                const lost = Math.round((c.weightedTotal - c.weightedServed) * 10) / 10;
                const isHidden = hiddenCats.has(c.category);
                const isIrrelevant = c.relevance === 0;
                return (
                  <tr key={c.category}
                    className={"border-t border-border/40 cursor-pointer hover:bg-muted/30 " +
                      (isHidden ? "opacity-40 " : "") +
                      (isIrrelevant ? "text-muted-foreground" : "")}
                    onClick={() => {
                      const next = new Set(hiddenCats);
                      if (next.has(c.category)) next.delete(c.category); else next.add(c.category);
                      setHiddenCats(next);
                    }}>
                    <td className="px-3 py-1.5">
                      <div className="flex items-center gap-2">
                        <span className="rounded p-0.5" style={{ background: m.color }}>
                          <m.Icon className="w-3 h-3 text-white" />
                        </span>
                        <span>{m.label}</span>
                      </div>
                    </td>
                    <td className="text-right px-3 py-1.5 tabular-nums">
                      <span className={"px-1.5 py-0.5 rounded text-[10px] " +
                        (c.relevance === 0 ? "bg-muted text-muted-foreground"
                          : c.relevance >= 1.3 ? "bg-amber-500/20 text-amber-400"
                          : c.relevance >= 1   ? "bg-emerald-500/20 text-emerald-400"
                          : "bg-blue-500/20 text-blue-400")}>
                        {c.relevance.toFixed(2)}x
                      </span>
                    </td>
                    <td className="text-right px-3 py-1.5 tabular-nums">{fmtNum(c.total)}</td>
                    <td className="text-right px-3 py-1.5 tabular-nums">{fmtNum(c.served)}</td>
                    <td className="text-right px-3 py-1.5 tabular-nums">
                      {isIrrelevant ? "-" : (
                        <span className={toneCls(c.servedPct)}>{c.servedPct}%</span>
                      )}
                    </td>
                    <td className="text-right px-3 py-1.5 tabular-nums">
                      {isIrrelevant ? "-" : (lost > 0 ? <span className="text-red-400">-{fmtNum(lost, 1)}</span> : "ok")}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ─────────────────── DISTRIBUZIONE ORARIA ─────────────────── */}
      {coverage && coverage.byHour.length > 0 && (
        <div className="bg-card border border-border rounded-lg p-3">
          <div className="text-sm font-semibold mb-2 flex items-center gap-1.5">
            <Clock className="w-4 h-4 text-muted-foreground" />
            Distribuzione corse per ora - {coverage.meta.dayLabel}
          </div>
          <div className="h-[180px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={coverage.byHour}>
                <CartesianGrid strokeDasharray="3 3" stroke="#374151" opacity={0.3} />
                <XAxis dataKey="hour" tick={{ fontSize: 10 }} tickFormatter={(h) => h + "h"} />
                <YAxis tick={{ fontSize: 10 }} />
                <RTooltip
                  contentStyle={{ background: "#1f2937", border: "1px solid #374151", borderRadius: 6, fontSize: 12 }}
                  formatter={(v: any) => [v + " corse", "partenze"]}
                  labelFormatter={(h) => "Ora " + h + ":00"} />
                <Bar dataKey="trips" radius={[3, 3, 0, 0]}>
                  {coverage.byHour.map((d, i) => (
                    <Cell key={i} fill={
                      d.hour < 6 || d.hour > 22 ? "#475569"
                      : (d.hour >= 7 && d.hour <= 9) || (d.hour >= 17 && d.hour <= 19) ? "#f59e0b"
                      : "#3b82f6"
                    } />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="text-[10px] text-muted-foreground mt-1">
            <span className="inline-block w-2 h-2 bg-amber-500 rounded mr-1" />ore di punta (7-9, 17-19)
            <span className="inline-block w-2 h-2 bg-blue-500 rounded ml-3 mr-1" />ore diurne
            <span className="inline-block w-2 h-2 bg-slate-500 rounded ml-3 mr-1" />notte/serale
          </div>
        </div>
      )}

      {/* ─────────────────── INTERVENTI ─────────────────── */}
      {coverage && (
        <div id="interventi" className="bg-card border border-border rounded-lg overflow-hidden">
          <div className="px-3 py-2 border-b border-border flex items-center gap-2">
            <Lightbulb className="w-4 h-4 text-amber-400" />
            <div className="text-sm font-semibold">Interventi suggeriti</div>
            <span className="text-[10px] text-muted-foreground ml-2">
              basati su gap reali del servizio sui filtri attivi
            </span>
          </div>
          {coverage.suggestions.length === 0 ? (
            <div className="p-4 text-sm text-muted-foreground flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-emerald-400" />
              Nessun gap critico - copertura buona per i parametri attuali.
            </div>
          ) : (
            <div className="divide-y divide-border/40">
              {coverage.suggestions.map((s, i) => <SuggestionRow key={i} s={s} />)}
            </div>
          )}
        </div>
      )}

      {/* ─────────────────── PARAMETRI ECONOMICI (collapsible) ─────────────────── */}
      {params && (
        <div className="bg-card border border-border rounded-lg overflow-hidden">
          <button onClick={() => setShowParams((v) => !v)}
            className="w-full px-3 py-2 border-b border-border flex items-center gap-2 text-left hover:bg-muted/30">
            {showParams ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
            <Settings2 className="w-4 h-4 text-muted-foreground" />
            <div className="text-sm font-semibold">Parametri economici</div>
            <span className="text-[10px] text-muted-foreground ml-2">
              fuel, costo conducente, manutenzione, ammortamento, tariffa
            </span>
          </button>
          {showParams && (
            <div className="p-3 grid grid-cols-2 md:grid-cols-4 gap-3">
              <ParamInput label="Consumo (L/100km)" value={params.fuelConsumptionL100}
                onChange={(v) => setParams({ ...params, fuelConsumptionL100: v })} step={0.5} />
              <ParamInput label="Prezzo gasolio (EUR/L)" value={params.fuelPriceEurL}
                onChange={(v) => setParams({ ...params, fuelPriceEurL: v })} step={0.01} />
              <ParamInput label="Costo conducente (EUR/h)" value={params.driverCostEurH}
                onChange={(v) => setParams({ ...params, driverCostEurH: v })} step={0.5} />
              <ParamInput label="Manutenzione (EUR/km)" value={params.maintenanceEurKm}
                onChange={(v) => setParams({ ...params, maintenanceEurKm: v })} step={0.01} />
              <ParamInput label="Ammortamento (EUR/km)" value={params.amortizationEurKm}
                onChange={(v) => setParams({ ...params, amortizationEurKm: v })} step={0.01} />
              <ParamInput label="Tariffa urbano (EUR/km)" value={params.fareUrbanEurKm}
                onChange={(v) => setParams({ ...params, fareUrbanEurKm: v })} step={0.01} />
              <ParamInput label="Tariffa suburbano (EUR/km)" value={params.fareSuburbanEurKm}
                onChange={(v) => setParams({ ...params, fareSuburbanEurKm: v })} step={0.01} />
              <ParamInput label="Tariffa notturno (EUR/km)" value={params.fareNightEurKm}
                onChange={(v) => setParams({ ...params, fareNightEurKm: v })} step={0.01} />
              <div className="col-span-2 md:col-span-4 flex justify-end">
                <button onClick={saveParams} disabled={savingParams}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50">
                  {savingParams ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                  Salva e ricalcola
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="text-[11px] text-muted-foreground border-t border-border/40 pt-2">
        Una stop e' considerata <strong>attiva</strong> se ha almeno 1 corsa nel giorno selezionato.
        La <strong>popolazione coperta</strong> e' la somma degli abitanti delle sezioni censuarie ISTAT
        il cui centroide cade entro {radiusM} m da una stop attiva di una linea filtrata.
        La <strong>copertura POI pesata</strong> applica un fattore di rilevanza per giorno della
        settimana e stagione.
      </div>
    </div>
  );
}

/* ───────────────────────── sub-componenti ───────────────────────── */

function Mini({ label, value, tone }: { label: string; value: string; tone?: "good" | "bad" | "neutral" }) {
  const cls = tone === "good" ? "text-emerald-400" : tone === "bad" ? "text-red-400" : "";
  return (
    <div>
      <div className="text-[9px] uppercase text-muted-foreground">{label}</div>
      <div className={"font-semibold " + cls}>{value}</div>
    </div>
  );
}

function SuggestionRow({ s }: { s: Suggestion }) {
  const Icon = s.severity === "high" ? AlertOctagon : s.severity === "med" ? AlertCircle : Lightbulb;
  const cls  = s.severity === "high" ? "text-red-400 bg-red-500/10"
              : s.severity === "med"  ? "text-amber-400 bg-amber-500/10"
              : "text-blue-400 bg-blue-500/10";
  return (
    <div className="p-3 flex gap-3">
      <div className={"shrink-0 rounded-full p-1.5 " + cls}>
        <Icon className="w-4 h-4" />
      </div>
      <div className="flex-1">
        <div className="text-sm font-semibold">{s.title}</div>
        <div className="text-xs text-muted-foreground mt-0.5">{s.detail}</div>
        <div className="text-[11px] text-primary mt-1">-&gt; {s.action}</div>
      </div>
    </div>
  );
}

function ParamInput({
  label, value, onChange, step = 1,
}: { label: string; value: number; onChange: (v: number) => void; step?: number }) {
  return (
    <div>
      <div className="text-[10px] uppercase text-muted-foreground mb-1">{label}</div>
      <input type="number" step={step} value={value}
        onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
        className="w-full px-2 py-1.5 rounded-md text-xs border border-border bg-background tabular-nums" />
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   EXPORT REPORTS
   ═══════════════════════════════════════════════════════════════ */

interface ExportPayload {
  feedId: string | null;
  day: SharedDay;
  season: Season;
  radiusM: number;
  serviceDate: string | null;
  selectedArr: string[];
  analysis: any;
  coverage: any;
  params?: any;
  routes?: any[];
}

function __download(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function __isoFromGtfs(s: string | null): string {
  if (!s || !/^\d{8}$/.test(s)) return "";
  return s.slice(0, 4) + "-" + s.slice(4, 6) + "-" + s.slice(6, 8);
}

function __ts(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function __openInNewTab(title: string, htmlBody: string) {
  const w = window.open("", "_blank");
  if (!w) {
    alert("Il browser ha bloccato l'apertura della nuova scheda. Consenti i popup per questo sito.");
    return;
  }
  const html = `<!doctype html>
<html lang="it">
<head>
<meta charset="utf-8" />
<title>${title}</title>
<style>
  :root { color-scheme: light; --primary:#3b82f6; --primary-dark:#1e40af; --good:#10b981; --warn:#f59e0b; --bad:#ef4444; --muted:#64748b; --bg:#f8fafc; --card:#ffffff; --border:#e2e8f0; --text:#0f172a; --text-soft:#475569; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; background: var(--bg); color: var(--text); margin: 0; padding: 0; -webkit-font-smoothing: antialiased; }
  .topbar { position: sticky; top: 0; z-index: 10; background: linear-gradient(135deg, #1e293b 0%, #334155 100%); color: #f8fafc; padding: 14px 24px; display: flex; align-items: center; gap: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.15); }
  .topbar h1 { margin: 0; font-size: 15px; font-weight: 600; flex: 1; }
  .btn { background: var(--primary); color: white; border: none; padding: 9px 18px; border-radius: 6px; font-size: 13px; font-weight: 600; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; transition: background 0.15s; }
  .btn:hover { background: var(--primary-dark); }
  .btn.secondary { background: #475569; }
  .btn.secondary:hover { background: #334155; }
  .container { max-width: 980px; margin: 24px auto; padding: 40px 56px; background: var(--card); border-radius: 10px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
  h1.title { font-size: 30px; margin: 0 0 4px 0; color: var(--text); font-weight: 700; letter-spacing: -0.02em; }
  .subtitle { color: var(--muted); font-size: 15px; margin-bottom: 24px; }
  h2 { font-size: 22px; margin-top: 40px; margin-bottom: 16px; color: var(--text); font-weight: 700; padding-bottom: 8px; border-bottom: 3px solid var(--primary); display: inline-block; }
  h3 { font-size: 17px; margin-top: 24px; margin-bottom: 8px; color: var(--text); font-weight: 600; }
  p { line-height: 1.7; margin: 10px 0; color: var(--text-soft); }
  ul { line-height: 1.85; padding-left: 24px; color: var(--text-soft); }
  li { margin: 4px 0; }
  strong { color: var(--text); font-weight: 600; }
  blockquote { border-left: 4px solid var(--warn); background: #fef3c7; color: #78350f; padding: 14px 20px; margin: 18px 0; border-radius: 0 6px 6px 0; line-height: 1.6; }
  .meta { background: linear-gradient(135deg, #eff6ff 0%, #dbeafe 100%); padding: 18px 22px; border-radius: 8px; border-left: 4px solid var(--primary); font-size: 14px; line-height: 1.8; }
  .meta strong { color: var(--primary-dark); }
  hr { border: none; border-top: 1px solid var(--border); margin: 36px 0; }
  table { border-collapse: collapse; width: 100%; margin: 16px 0; font-size: 13px; }
  th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--border); }
  th { background: #f1f5f9; font-weight: 600; color: var(--text); font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  tr:hover td { background: #f8fafc; }
  pre { background: #0f172a; color: #e2e8f0; padding: 18px; border-radius: 8px; overflow-x: auto; font-size: 12px; line-height: 1.55; }
  code { font-family: "SF Mono", Monaco, Menlo, monospace; }
  .footer { text-align: center; color: var(--muted); font-size: 12px; margin-top: 48px; padding-top: 16px; border-top: 1px solid var(--border); }

  /* KPI grid */
  .kpi-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; margin: 20px 0; }
  .kpi { background: white; border: 1px solid var(--border); border-radius: 10px; padding: 16px 18px; position: relative; overflow: hidden; }
  .kpi::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 4px; background: var(--primary); }
  .kpi.good::before { background: var(--good); }
  .kpi.bad::before { background: var(--bad); }
  .kpi.warn::before { background: var(--warn); }
  .kpi .lbl { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); font-weight: 600; margin-bottom: 6px; }
  .kpi .val { font-size: 22px; font-weight: 700; color: var(--text); font-variant-numeric: tabular-nums; line-height: 1.1; }
  .kpi .sub { font-size: 11px; color: var(--muted); margin-top: 4px; }

  /* progress bars */
  .pbar { height: 10px; background: #e2e8f0; border-radius: 5px; overflow: hidden; }
  .pbar > div { height: 100%; background: var(--primary); border-radius: 5px; transition: width 0.3s; }
  .pbar > div.good { background: var(--good); }
  .pbar > div.bad  { background: var(--bad); }
  .pbar > div.warn { background: var(--warn); }

  /* insight callout */
  .insight { background: linear-gradient(135deg, #ecfeff 0%, #cffafe 100%); border-left: 4px solid #0891b2; padding: 14px 20px; border-radius: 0 8px 8px 0; margin: 16px 0; line-height: 1.65; color: #155e75; }
  .insight strong { color: #155e75; }

  /* suggestion cards */
  .sugg { padding: 16px 18px; border-radius: 8px; margin: 12px 0; border: 1px solid; }
  .sugg.high { background: #fef2f2; border-color: #fecaca; }
  .sugg.med  { background: #fffbeb; border-color: #fde68a; }
  .sugg.low  { background: #eff6ff; border-color: #bfdbfe; }
  .sugg .badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 6px; }
  .sugg.high .badge { background: #ef4444; color: white; }
  .sugg.med  .badge { background: #f59e0b; color: white; }
  .sugg.low  .badge { background: #3b82f6; color: white; }
  .sugg h4 { margin: 4px 0 6px 0; font-size: 15px; color: var(--text); }
  .sugg .action { margin-top: 8px; padding: 8px 12px; background: rgba(255,255,255,0.7); border-radius: 6px; font-size: 13px; color: var(--text); border-left: 3px solid var(--primary); }

  /* Donut SVG center text */
  .donut-wrap { display: flex; align-items: center; gap: 24px; margin: 16px 0; }
  .donut-stats { flex: 1; }
  .donut-stats .big { font-size: 36px; font-weight: 700; color: var(--primary-dark); line-height: 1; }
  .donut-stats .small { font-size: 13px; color: var(--muted); margin-top: 4px; }


  /* === Estensioni report v2 === */
  .meta-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; background: linear-gradient(135deg, #eff6ff 0%, #dbeafe 100%); padding: 16px 20px; border-radius: 8px; border-left: 4px solid var(--primary); margin: 16px 0 24px 0; }
  .meta-item { display: flex; flex-direction: column; gap: 2px; font-size: 13px; }
  .meta-item .meta-key { font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--primary-dark); font-weight: 700; }
  .meta-item .meta-val { color: var(--text); font-weight: 600; font-size: 13px; }
  .meta-item.meta-wide { grid-column: span 2; }

  .kpi-card { background: white; border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; display: flex; gap: 12px; align-items: flex-start; box-shadow: 0 1px 2px rgba(0,0,0,0.04); }
  .kpi-card .kpi-icon { width: 40px; height: 40px; border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 22px; flex-shrink: 0; }
  .kpi-card .kpi-body { flex: 1; min-width: 0; }
  .kpi-card .kpi-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); font-weight: 600; }
  .kpi-card .kpi-value { font-size: 22px; font-weight: 700; line-height: 1.15; margin: 2px 0; font-variant-numeric: tabular-nums; }
  .kpi-card .kpi-sub { font-size: 11px; color: var(--muted); }

  .gauge-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin: 20px 0; }
  .gauge-item { background: white; border: 1px solid var(--border); border-radius: 10px; padding: 18px; display: flex; flex-direction: column; align-items: center; gap: 12px; text-align: center; }
  .gauge-item .gauge-detail { font-size: 13px; line-height: 1.6; color: var(--text-soft); }
  .gauge-item .gauge-detail strong { color: var(--text); font-size: 15px; }

  blockquote.positive { border-left-color: var(--good); background: #d1fae5; color: #065f46; }
  blockquote.warning { border-left-color: var(--warn); background: #fef3c7; color: #78350f; }

  .suggestion { background: white; border: 1px solid var(--border); padding: 16px 20px; border-radius: 8px; margin: 12px 0; box-shadow: 0 1px 2px rgba(0,0,0,0.04); }
  .suggestion-head { display: flex; gap: 12px; align-items: flex-start; }
  .suggestion-num { width: 32px; height: 32px; border-radius: 50%; color: white; font-weight: 700; display: flex; align-items: center; justify-content: center; font-size: 14px; flex-shrink: 0; }
  .suggestion-sev { font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; font-weight: 700; }
  .suggestion-action { background: #f8fafc; padding: 10px 14px; border-radius: 6px; font-size: 13px; color: var(--text); margin-top: 8px; }

  .glossary { display: grid; grid-template-columns: repeat(2, 1fr); gap: 14px; margin: 16px 0; font-size: 13px; line-height: 1.55; }
  .glossary > div { background: #f8fafc; padding: 12px 14px; border-radius: 6px; border-left: 3px solid var(--primary); }

  details > summary::-webkit-details-marker { display: none; }
  details[open] summary { margin-bottom: 12px; }

  @media print {
    .topbar { display: none; }
    body { background: white; }
    .container { box-shadow: none; margin: 0; max-width: 100%; padding: 0; border-radius: 0; }
    h2 { page-break-after: avoid; }
    h3 { page-break-after: avoid; }
    .kpi-grid { page-break-inside: avoid; }
    .sugg { page-break-inside: avoid; }
    .chart-wrap { page-break-inside: avoid; }
  }
  @media (max-width: 700px) {
    .container { padding: 24px 20px; }
    .kpi-grid { grid-template-columns: repeat(2, 1fr); }
    .meta-grid { grid-template-columns: repeat(2, 1fr); }
    .gauge-grid { grid-template-columns: 1fr; }
    .glossary { grid-template-columns: 1fr; }
  }
</style>
</head>
<body>
  <div class="topbar">
    <h1>${title}</h1>
    <button class="btn secondary" onclick="window.close()">Chiudi</button>
    <button class="btn" onclick="window.print()">🖨️ Stampa / Salva PDF</button>
  </div>
  <div class="container">
    ${htmlBody}
    <div class="footer">Report generato automaticamente dalla piattaforma TransitIntel · ${new Date().toLocaleString("it-IT")}</div>
  </div>
</body>
</html>`;
  w.document.open();
  w.document.write(html);
  w.document.close();
}

function __escHtml(s: any): string {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function __num(n: any, suffix = ""): string {
  if (n == null || isNaN(Number(n))) return "n/d";
  return Number(n).toLocaleString("it-IT", { maximumFractionDigits: 0 }) + suffix;
}
function __num2(n: any, suffix = ""): string {
  if (n == null || isNaN(Number(n))) return "n/d";
  return Number(n).toLocaleString("it-IT", { maximumFractionDigits: 2 }) + suffix;
}
function __pct(num: any, den: any): string {
  if (typeof num !== "number" || typeof den !== "number" || den <= 0) return "n/d";
  return (num / den * 100).toFixed(1) + "%";
}

/** Bar chart SVG orario (24h) */
function __renderHourlyChart(byHour: { hour: number; trips: number }[]): string {
  const data = Array.from({ length: 24 }, (_, h) => {
    const r = byHour?.find((x) => x.hour === h);
    return { hour: h, trips: r?.trips || 0 };
  });
  const max = Math.max(1, ...data.map((d) => d.trips));
  const W = 880, H = 220, padL = 40, padR = 12, padT = 10, padB = 32;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const bw = innerW / 24 - 4;
  const bars = data.map((d, i) => {
    const x = padL + i * (innerW / 24) + 2;
    const h = (d.trips / max) * innerH;
    const y = padT + innerH - h;
    const isPeak = (d.hour >= 7 && d.hour <= 9) || (d.hour >= 17 && d.hour <= 19);
    const isNight = d.hour < 6 || d.hour >= 22;
    const color = isPeak ? "#3b82f6" : isNight ? "#94a3b8" : "#60a5fa";
    return `<rect x="${x}" y="${y}" width="${bw}" height="${h}" fill="${color}" rx="2"><title>${d.hour}:00 → ${d.trips} corse</title></rect>`;
  }).join("");
  const labels = data.filter((_, i) => i % 2 === 0).map((d) => {
    const x = padL + d.hour * (innerW / 24) + (innerW / 24) / 2;
    return `<text x="${x}" y="${H - 12}" font-size="10" fill="#64748b" text-anchor="middle">${d.hour}h</text>`;
  }).join("");
  // y axis ticks
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => {
    const v = Math.round(max * t);
    const y = padT + innerH - t * innerH;
    return `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="#e2e8f0" stroke-width="1"/>
            <text x="${padL - 6}" y="${y + 3}" font-size="10" fill="#64748b" text-anchor="end">${v}</text>`;
  }).join("");
  return `<div class="chart-wrap" style="margin:16px 0; background:white; border:1px solid var(--border); border-radius:8px; padding:14px;">
    <svg viewBox="0 0 ${W} ${H}" style="width:100%; height:auto; display:block;">
      ${ticks}
      ${bars}
      ${labels}
    </svg>
    <div style="display:flex; gap:18px; margin-top:8px; font-size:11px; color:var(--muted);">
      <span style="display:inline-flex; align-items:center; gap:4px;"><span style="display:inline-block; width:10px; height:10px; background:#3b82f6; border-radius:2px;"></span> ore di punta (7-9, 17-19)</span>
      <span style="display:inline-flex; align-items:center; gap:4px;"><span style="display:inline-block; width:10px; height:10px; background:#60a5fa; border-radius:2px;"></span> ore diurne</span>
      <span style="display:inline-flex; align-items:center; gap:4px;"><span style="display:inline-block; width:10px; height:10px; background:#94a3b8; border-radius:2px;"></span> notte/serale</span>
    </div>
  </div>`;
}

/** Donut SVG: copertura popolazione */
function __renderDonut(coveredPct: number, label: string): string {
  const r = 60, c = 2 * Math.PI * r;
  const dash = (Math.max(0, Math.min(100, coveredPct)) / 100) * c;
  const color = coveredPct >= 85 ? "#10b981" : coveredPct >= 70 ? "#f59e0b" : "#ef4444";
  return `<svg viewBox="0 0 160 160" style="width:160px; height:160px;">
    <circle cx="80" cy="80" r="${r}" fill="none" stroke="#e2e8f0" stroke-width="16"/>
    <circle cx="80" cy="80" r="${r}" fill="none" stroke="${color}" stroke-width="16"
            stroke-dasharray="${dash} ${c - dash}" stroke-dashoffset="${c / 4}"
            transform="rotate(-90 80 80)" stroke-linecap="round"/>
    <text x="80" y="80" font-size="26" font-weight="700" fill="${color}" text-anchor="middle" dominant-baseline="central">${coveredPct.toFixed(1)}%</text>
    <text x="80" y="105" font-size="10" fill="#64748b" text-anchor="middle">${__escHtml(label)}</text>
  </svg>`;
}

/** Tabella categorie POI con barre di copertura */
function __renderCategoryTable(byCategory: any[]): string {
  if (!byCategory || byCategory.length === 0) return "<p><em>Nessuna categoria POI disponibile per il filtro selezionato.</em></p>";
  const rows = byCategory.slice().sort((a, b) => b.weightedTotal - a.weightedTotal).map((c) => {
    const pct = c.servedPct || (c.total > 0 ? c.served / c.total * 100 : 0);
    const cls = pct >= 90 ? "good" : pct >= 70 ? "warn" : "bad";
    return `<tr>
      <td><strong>${__escHtml(c.category)}</strong></td>
      <td class="num">${c.relevance?.toFixed(2) || "1.00"}×</td>
      <td class="num">${__num(c.served)} / ${__num(c.total)}</td>
      <td style="width:35%;">
        <div style="display:flex; align-items:center; gap:8px;">
          <div class="pbar" style="flex:1;"><div class="${cls}" style="width:${pct.toFixed(1)}%;"></div></div>
          <span style="font-size:12px; font-weight:600; min-width:48px; text-align:right;">${pct.toFixed(1)}%</span>
        </div>
      </td>
    </tr>`;
  }).join("");
  return `<table>
    <thead><tr><th>Categoria</th><th class="num">Peso</th><th class="num">Coperti / Totali</th><th>Copertura</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

/** Top linee per costo con barra margine */
function __renderTopRoutes(perRoute: any[], topN: number): string {
  if (!perRoute || perRoute.length === 0) return "<p><em>Nessuna linea disponibile.</em></p>";
  const sorted = perRoute.slice().sort((a, b) => b.costTotalDay - a.costTotalDay).slice(0, topN);
  const maxAbs = Math.max(...sorted.map((r) => Math.abs(r.marginDay || 0)), 1);
  const rows = sorted.map((r) => {
    const margin = r.marginDay || 0;
    const isPos = margin >= 0;
    const w = (Math.abs(margin) / maxAbs) * 50;
    const bar = `<div style="position:relative; height:18px; background:#f1f5f9; border-radius:3px;">
      <div style="position:absolute; left:50%; top:0; bottom:0; width:1px; background:#cbd5e1;"></div>
      <div style="position:absolute; ${isPos ? `left:50%` : `right:50%`}; top:0; bottom:0; width:${w}%; background:${isPos ? "#10b981" : "#ef4444"}; border-radius:3px;"></div>
      <div style="position:absolute; inset:0; display:flex; align-items:center; justify-content:center; font-size:11px; font-weight:600; color:${isPos ? "#065f46" : "#991b1b"};">${margin >= 0 ? "+" : ""}${__num(margin, " €")}</div>
    </div>`;
    return `<tr>
      <td><strong>${__escHtml(r.shortName || r.routeId)}</strong><div style="font-size:11px; color:var(--muted); max-width:340px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${__escHtml(r.longName || "")}</div></td>
      <td class="num">${__num(r.tripsDay)}</td>
      <td class="num">${__num(r.kmDay, " km")}</td>
      <td class="num">${__num(r.costTotalDay, " €")}</td>
      <td class="num">${__num(r.revenueDay, " €")}</td>
      <td style="width:25%;">${bar}</td>
    </tr>`;
  }).join("");
  return `<table>
    <thead><tr><th>Linea</th><th class="num">Corse/g</th><th class="num">Km/g</th><th class="num">Costo/g</th><th class="num">Ricavi/g</th><th>Margine</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

/** Suggerimenti come cards con badge severity */
function __renderSuggestions(suggestions: any[]): string {
  if (!suggestions || suggestions.length === 0) {
    return `<div class="insight">✅ Nessun intervento critico identificato sul perimetro analizzato. Il servizio appare bilanciato rispetto ai filtri attivi.</div>`;
  }
  return suggestions.map((s) => {
    const sev = s.severity === "high" ? "high" : s.severity === "med" ? "med" : "low";
    const sevLbl = sev === "high" ? "⚠ Alta priorità" : sev === "med" ? "Media priorità" : "Suggerimento";
    return `<div class="sugg ${sev}">
      <span class="badge">${sevLbl}</span>
      <h4>${__escHtml(s.title)}</h4>
      <p style="margin:4px 0; color:var(--text-soft);">${__escHtml(s.detail)}</p>
      <div class="action">→ <strong>Azione:</strong> ${__escHtml(s.action)}</div>
    </div>`;
  }).join("");
}


/* ═══════════════════════════════════════════════════════════════
   REPORT BUILDERS — versione v2 con grafici SVG ricchi
   ═══════════════════════════════════════════════════════════════ */

const __PALETTE = {
  primary: "#3b82f6",
  primaryDark: "#1d4ed8",
  success: "#10b981",
  warning: "#f59e0b",
  danger: "#ef4444",
  purple: "#8b5cf6",
  cyan: "#06b6d4",
  pink: "#ec4899",
  slate: "#64748b",
};

function __fmt(n: number | undefined | null, d = 0, suffix = ""): string {
  if (n == null || isNaN(Number(n))) return "n/d";
  return Number(n).toLocaleString("it-IT", { maximumFractionDigits: d }) + suffix;
}
function __fmtEur(n: number | undefined | null): string {
  if (n == null || isNaN(Number(n))) return "n/d";
  return new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(Number(n));
}

function __svgKpiCard(label: string, value: string, subtitle: string, color: string, icon: string): string {
  return `<div class="kpi-card" style="border-left:5px solid ${color};">
    <div class="kpi-icon" style="background:${color}20;color:${color};">${icon}</div>
    <div class="kpi-body">
      <div class="kpi-label">${label}</div>
      <div class="kpi-value" style="color:${color};">${value}</div>
      <div class="kpi-sub">${subtitle}</div>
    </div>
  </div>`;
}

function __svgBarChartH(rows: { label: string; value: number; color?: string; max?: number; suffix?: string }[], width = 720, rowH = 32): string {
  if (!rows.length) return "<p style='color:#64748b;font-style:italic;'>Nessun dato disponibile.</p>";
  const labelW = 220, padR = 110;
  const barMaxW = width - labelW - padR;
  const globalMax = Math.max(...rows.map(r => r.max ?? r.value), 1);
  const h = rows.length * rowH + 16;
  const bars = rows.map((r, i) => {
    const w = (r.value / globalMax) * barMaxW;
    const y = i * rowH + 8;
    const color = r.color || __PALETTE.primary;
    return `<text x="${labelW - 8}" y="${y + rowH/2 + 4}" text-anchor="end" font-size="12" fill="#334155">${__escHtml(r.label)}</text>
      <rect x="${labelW}" y="${y + 6}" width="${w}" height="${rowH - 12}" rx="3" fill="${color}" opacity="0.85"/>
      <text x="${labelW + w + 6}" y="${y + rowH/2 + 4}" font-size="12" fill="#0f172a" font-weight="600">${__fmt(r.value, 0, r.suffix || "")}</text>`;
  }).join("");
  return `<svg viewBox="0 0 ${width} ${h}" style="width:100%;height:auto;max-width:${width}px;">${bars}</svg>`;
}

function __svgHourlyChart(byHour: { hour: number; trips: number }[], width = 800, height = 230): string {
  if (!byHour || !byHour.length) return "<p style='color:#64748b;font-style:italic;'>Nessun dato orario disponibile.</p>";
  const padL = 44, padR = 12, padT = 28, padB = 36;
  const W = width - padL - padR;
  const H = height - padT - padB;
  const max = Math.max(...byHour.map(h => h.trips), 1);
  const barW = W / 24 - 4;
  const peak = new Set([7, 8, 17, 18]);
  const day = new Set([6, 9, 10, 11, 12, 13, 14, 15, 16, 19, 20]);
  const colorFor = (h: number) => peak.has(h) ? __PALETTE.danger : day.has(h) ? __PALETTE.primary : __PALETTE.slate;

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map(t => {
    const v = Math.round(max * t);
    const y = padT + H - (t * H);
    return `<line x1="${padL}" y1="${y}" x2="${width - padR}" y2="${y}" stroke="#e2e8f0" stroke-width="1"/>
            <text x="${padL - 6}" y="${y + 4}" text-anchor="end" font-size="10" fill="#64748b">${v}</text>`;
  }).join("");

  const bars = Array.from({ length: 24 }, (_, h) => {
    const row = byHour.find(b => b.hour === h);
    const trips = row?.trips || 0;
    const bh = (trips / max) * H;
    const x = padL + h * (W / 24) + 2;
    const y = padT + H - bh;
    return `<rect x="${x}" y="${y}" width="${barW}" height="${bh}" fill="${colorFor(h)}" rx="2" opacity="0.9">
              <title>${h}:00 — ${trips} corse</title>
            </rect>
            <text x="${x + barW/2}" y="${padT + H + 14}" text-anchor="middle" font-size="9" fill="#64748b">${h}</text>`;
  }).join("");

  return `<svg viewBox="0 0 ${width} ${height}" style="width:100%;height:auto;">
    ${yTicks}
    ${bars}
    <text x="${padL + W/2}" y="${height - 4}" text-anchor="middle" font-size="11" fill="#475569">Ora del giorno</text>
    <g transform="translate(${padL + 4}, 16)">
      <rect x="0" y="-10" width="10" height="10" fill="${__PALETTE.danger}" rx="2"/><text x="14" y="-2" font-size="10" fill="#475569">punta (7-9, 17-19)</text>
      <rect x="140" y="-10" width="10" height="10" fill="${__PALETTE.primary}" rx="2"/><text x="154" y="-2" font-size="10" fill="#475569">diurno</text>
      <rect x="220" y="-10" width="10" height="10" fill="${__PALETTE.slate}" rx="2"/><text x="234" y="-2" font-size="10" fill="#475569">notte/serale</text>
    </g>
  </svg>`;
}

function __svgGaugePct(pct: number, label: string, color: string, size = 200): string {
  const clamped = Math.max(0, Math.min(100, pct));
  const r = size / 2 - 16;
  const cx = size / 2, cy = size / 2;
  const circ = 2 * Math.PI * r;
  const dash = (clamped / 100) * circ;
  return `<svg viewBox="0 0 ${size} ${size}" style="width:${size}px;height:${size}px;">
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#e2e8f0" stroke-width="14"/>
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="14" stroke-dasharray="${dash} ${circ}" stroke-linecap="round" transform="rotate(-90 ${cx} ${cy})"/>
    <text x="${cx}" y="${cy - 4}" text-anchor="middle" font-size="32" font-weight="700" fill="${color}">${clamped.toFixed(1)}%</text>
    <text x="${cx}" y="${cy + 22}" text-anchor="middle" font-size="11" fill="#64748b">${__escHtml(label)}</text>
  </svg>`;
}

function __svgCostRevenueScatter(perRoute: any[], width = 760, height = 320, topN = 30): string {
  if (!perRoute || !perRoute.length) return "";
  const data = [...perRoute].sort((a, b) => (b.costTotalDay || 0) - (a.costTotalDay || 0)).slice(0, topN);
  const padL = 70, padR = 20, padT = 40, padB = 50;
  const W = width - padL - padR;
  const H = height - padT - padB;
  const maxAxis = Math.max(...data.map(d => Math.max(d.costTotalDay || 0, d.revenueDay || 0)), 1);
  const xS = (v: number) => padL + (v / maxAxis) * W;
  const yS = (v: number) => padT + H - (v / maxAxis) * H;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map(t => {
    const v = maxAxis * t;
    return `<line x1="${xS(v)}" y1="${padT}" x2="${xS(v)}" y2="${padT + H}" stroke="#f1f5f9"/>
            <line x1="${padL}" y1="${yS(v)}" x2="${padL + W}" y2="${yS(v)}" stroke="#f1f5f9"/>
            <text x="${xS(v)}" y="${padT + H + 14}" text-anchor="middle" font-size="9" fill="#64748b">${__fmtEur(v)}</text>
            <text x="${padL - 6}" y="${yS(v) + 3}" text-anchor="end" font-size="9" fill="#64748b">${__fmtEur(v)}</text>`;
  }).join("");
  const dia = `<line x1="${xS(0)}" y1="${yS(0)}" x2="${xS(maxAxis)}" y2="${yS(maxAxis)}" stroke="${__PALETTE.warning}" stroke-dasharray="4 4" opacity="0.7"/>`;
  const points = data.map((d: any) => {
    const c = d.costTotalDay || 0, rv = d.revenueDay || 0, m = d.marginDay || 0;
    const r = 4 + Math.sqrt(Math.max(0, d.tripsDay || 0)) * 0.4;
    const fill = m >= 0 ? __PALETTE.success : __PALETTE.danger;
    return `<circle cx="${xS(c)}" cy="${yS(rv)}" r="${r}" fill="${fill}" opacity="0.7" stroke="white" stroke-width="1">
              <title>${__escHtml(d.shortName || d.routeId)} — Costo ${__fmtEur(c)} / Ricavi ${__fmtEur(rv)} / Margine ${__fmtEur(m)}</title>
            </circle>`;
  }).join("");
  return `<svg viewBox="0 0 ${width} ${height}" style="width:100%;height:auto;">
    ${ticks}
    ${dia}
    <text x="${padL + W/2}" y="${height - 28}" text-anchor="middle" font-size="11" fill="#475569" font-weight="600">Costo giornaliero (€)</text>
    <text x="14" y="${padT + H/2}" text-anchor="middle" font-size="11" fill="#475569" font-weight="600" transform="rotate(-90 14 ${padT + H/2})">Ricavi (€)</text>
    <text x="${xS(maxAxis) - 4}" y="${yS(maxAxis) + 14}" text-anchor="end" font-size="9" fill="${__PALETTE.warning}">linea pareggio</text>
    ${points}
    <g transform="translate(${padL + 10}, 18)">
      <circle cx="6" cy="6" r="5" fill="${__PALETTE.success}" opacity="0.7"/><text x="16" y="9" font-size="10" fill="#334155">linea in attivo</text>
      <circle cx="120" cy="6" r="5" fill="${__PALETTE.danger}" opacity="0.7"/><text x="130" y="9" font-size="10" fill="#334155">linea in perdita</text>
      <text x="280" y="9" font-size="10" fill="#94a3b8">grandezza ∝ corse/giorno</text>
    </g>
  </svg>`;
}

function __htmlCategoryTable(rows: any[]): string {
  if (!rows || !rows.length) return "<p style='color:#64748b;font-style:italic;'>Nessuna categoria POI rilevata.</p>";
  const sorted = [...rows].sort((a, b) => (b.weightedTotal || 0) - (a.weightedTotal || 0));
  const tr = sorted.map(r => {
    const pct = (r.servedPct || 0) * 100;
    const color = pct >= 95 ? __PALETTE.success : pct >= 80 ? __PALETTE.warning : __PALETTE.danger;
    const lost = (r.weightedTotal || 0) - (r.weightedServed || 0);
    return `<tr>
      <td><strong>${__escHtml(r.category)}</strong></td>
      <td style="text-align:center;color:#64748b;">${(r.relevance ?? 1).toFixed(2)}×</td>
      <td class="num">${__fmt(r.total)}</td>
      <td class="num" style="color:${color};font-weight:600;">${__fmt(r.served)}</td>
      <td>
        <div style="display:flex;align-items:center;gap:8px;">
          <div style="flex:1;height:10px;background:#f1f5f9;border-radius:4px;overflow:hidden;">
            <div style="width:${pct.toFixed(1)}%;height:100%;background:${color};"></div>
          </div>
          <span style="font-size:12px;color:${color};font-weight:600;min-width:48px;text-align:right;">${pct.toFixed(1)}%</span>
        </div>
      </td>
      <td class="num" style="color:#94a3b8;font-size:12px;">${lost > 0.5 ? "−" + __fmt(lost, 1) : "ok"}</td>
    </tr>`;
  }).join("");
  return `<table>
    <thead><tr>
      <th>Categoria</th><th style="text-align:center;">Peso</th>
      <th style="text-align:right;">Totale</th><th style="text-align:right;">Coperti</th>
      <th>% copertura</th><th style="text-align:right;">Persi</th>
    </tr></thead>
    <tbody>${tr}</tbody>
  </table>`;
}

function __htmlTopRoutesTable(perRoute: any[], topN = 15): string {
  if (!perRoute || !perRoute.length) return "";
  const sorted = [...perRoute].sort((a, b) => (b.costTotalDay || 0) - (a.costTotalDay || 0)).slice(0, topN);
  const tr = sorted.map(r => {
    const m = r.marginDay || 0;
    const mColor = m >= 0 ? __PALETTE.success : __PALETTE.danger;
    return `<tr>
      <td><span style="display:inline-block;width:10px;height:10px;background:${r.color ? "#" + r.color : "#94a3b8"};border-radius:2px;margin-right:6px;vertical-align:middle;"></span><strong>${__escHtml(r.shortName || r.routeId)}</strong></td>
      <td style="font-size:11px;color:#64748b;">${__escHtml((r.longName || "").slice(0, 50))}</td>
      <td class="num">${__fmt(r.tripsDay)}</td>
      <td class="num">${__fmt(r.kmDay, 0)}</td>
      <td class="num">${__fmtEur(r.costTotalDay)}</td>
      <td class="num">${__fmtEur(r.revenueDay)}</td>
      <td class="num" style="color:${mColor};font-weight:600;">${__fmtEur(m)}</td>
      <td class="num">${__fmt(r.estimatedPaxDay)}</td>
    </tr>`;
  }).join("");
  return `<table>
    <thead><tr>
      <th>Linea</th><th>Descrizione</th>
      <th style="text-align:right;">Corse</th><th style="text-align:right;">Km</th>
      <th style="text-align:right;">Costo</th><th style="text-align:right;">Ricavi</th>
      <th style="text-align:right;">Margine</th><th style="text-align:right;">Pax</th>
    </tr></thead>
    <tbody>${tr}</tbody>
  </table>`;
}

function __htmlSuggestion(s: any, idx: number): string {
  const color = s.severity === "high" ? __PALETTE.danger : s.severity === "med" ? __PALETTE.warning : __PALETTE.primary;
  const sevLabel = s.severity === "high" ? "PRIORITÀ ALTA" : s.severity === "med" ? "PRIORITÀ MEDIA" : "OPPORTUNITÀ";
  return `<div class="suggestion" style="border-left:5px solid ${color};">
    <div class="suggestion-head">
      <span class="suggestion-num" style="background:${color};">${idx + 1}</span>
      <div style="flex:1;">
        <div class="suggestion-sev" style="color:${color};">${sevLabel}</div>
        <h3 style="margin:2px 0 0 0;">${__escHtml(s.title)}</h3>
      </div>
    </div>
    <p style="margin:10px 0 6px 0;">${__escHtml(s.detail)}</p>
    <div class="suggestion-action"><strong style="color:${color};">→ Azione consigliata:</strong> ${__escHtml(s.action)}</div>
  </div>`;
}

function __filtersBox(p: ExportPayload): string {
  const dayLabel = p.day === "weekday" ? "Feriale (Lun-Ven)" : p.day === "saturday" ? "Sabato" : "Domenica / Festivo";
  const seasonLabel = p.season === "all" ? "Annuale" : p.season === "summer" ? "Estate" : "Inverno";
  const dateStr = __isoFromGtfs(p.serviceDate) || `tutti i giorni di tipo ${dayLabel.toLowerCase()}`;
  const lineeStr = p.selectedArr.length === 0
    ? `tutte le ${p.routes?.length || "—"} linee del feed`
    : `${p.selectedArr.length} linee selezionate`;
  return `<div class="meta-grid">
    <div class="meta-item"><span class="meta-key">📅 Data</span><span class="meta-val">${__escHtml(dateStr)}</span></div>
    <div class="meta-item"><span class="meta-key">📊 Tipo giorno</span><span class="meta-val">${__escHtml(dayLabel)}</span></div>
    <div class="meta-item"><span class="meta-key">🌤️ Stagione</span><span class="meta-val">${__escHtml(seasonLabel)}</span></div>
    <div class="meta-item"><span class="meta-key">🚶 Raggio pedonale</span><span class="meta-val">${p.radiusM} m</span></div>
    <div class="meta-item meta-wide"><span class="meta-key">🚌 Linee</span><span class="meta-val">${__escHtml(lineeStr)}</span></div>
  </div>`;
}

/* ──────────────────────────────────────────────────────────
   REPORT TECNICO
   ────────────────────────────────────────────────────────── */
function __exportTechReport(p: ExportPayload) {
  const a: any = p.analysis || {};
  const c: any = p.coverage || {};
  const summary = c.summary || {};
  const perRoute: any[] = a.perRoute || [];
  const byHour: any[] = c.byHour || [];
  const byCategory: any[] = c.byCategory || [];
  const suggestions: any[] = c.suggestions || [];

  const margine = (a.totalRevenueDay ?? 0) - (a.totalCostDay ?? 0);
  const marginColor = margine >= 0 ? __PALETTE.success : __PALETTE.danger;
  const popPct = summary.coveragePct != null ? summary.coveragePct * 100 : 0;
  const poiPct = summary.poiCoverageWeighted != null ? summary.poiCoverageWeighted * 100 : 0;
  const stopPct = summary.totalStops > 0 ? (summary.activeStops / summary.totalStops) * 100 : 0;
  const annualCost = (a.totalCostDay || 0) * 365;
  const losingRoutes = perRoute.filter(r => (r.marginDay || 0) < 0).length;
  const profitRoutes = perRoute.filter(r => (r.marginDay || 0) >= 0).length;

  const body = `
    <h1 class="title">📊 Report tecnico — Analisi del servizio</h1>
    <p class="subtitle">Dashboard dettagliato su KPI economici, copertura territoriale, distribuzione oraria e singole linee.</p>
    ${__filtersBox(p)}

    <h2>🎯 KPI principali</h2>
    <div class="kpi-grid">
      ${__svgKpiCard("Costo giornaliero", __fmtEur(a.totalCostDay), `~${__fmtEur(annualCost)}/anno`, __PALETTE.warning, "💶")}
      ${__svgKpiCard("Ricavi giornalieri", __fmtEur(a.totalRevenueDay), "tariffe stimate", __PALETTE.cyan, "🎫")}
      ${__svgKpiCard("Margine giornaliero", __fmtEur(margine), margine >= 0 ? "in attivo" : "in perdita", marginColor, margine >= 0 ? "📈" : "📉")}
      ${__svgKpiCard("Linee attive", String(a.activeRoutes ?? 0), `${profitRoutes} attive · ${losingRoutes} in perdita`, __PALETTE.purple, "🚌")}
      ${__svgKpiCard("Corse / giorno", __fmt(a.totalTripsDay), `${__fmt(a.totalKmDay, 0)} km totali`, __PALETTE.primary, "🔁")}
      ${__svgKpiCard("Fermate attive", `${a.activeStops || 0}/${summary.totalStops || "—"}`, `${stopPct.toFixed(1)}% del totale`, __PALETTE.slate, "📍")}
    </div>

    <h2>👥 Copertura della domanda</h2>
    <div class="gauge-grid">
      <div class="gauge-item">${__svgGaugePct(popPct, "Popolazione coperta", __PALETTE.primary)}
        <div class="gauge-detail"><strong>${__fmt(summary.populationServed)}</strong> abitanti coperti<br/>
        <span style="color:#64748b;">su ${__fmt(summary.populationTotal)} totali</span><br/>
        <span style="color:${__PALETTE.danger};">${__fmt(summary.uncoveredPopulation)} scoperti</span></div>
      </div>
      <div class="gauge-item">${__svgGaugePct(poiPct, "POI rilevanti coperti", __PALETTE.success)}
        <div class="gauge-detail"><strong>${__fmt(summary.poiServed)}</strong> POI serviti<br/>
        <span style="color:#64748b;">su ${__fmt(summary.poiTotal)} totali</span><br/>
        <span style="color:#94a3b8;">peso applicato per giorno/stagione</span></div>
      </div>
      <div class="gauge-item">${__svgGaugePct(stopPct, "Fermate attive nel giorno", __PALETTE.cyan)}
        <div class="gauge-detail"><strong>${__fmt(a.activeStops)}</strong> fermate con almeno 1 corsa<br/>
        <span style="color:#64748b;">su ${__fmt(summary.totalStops)} totali</span></div>
      </div>
    </div>

    <h2>🕐 Distribuzione oraria delle corse</h2>
    <p>Numero di corse erogate in ogni fascia oraria. Le ore di punta (7-9 e 17-19) sono evidenziate in rosso.</p>
    ${__svgHourlyChart(byHour)}

    <h2>🥇 Copertura per categoria di POI</h2>
    <p>Categorie di punti di interesse pesate per rilevanza nel giorno e nella stagione selezionati.</p>
    ${__htmlCategoryTable(byCategory)}

    <h2>💰 Costo vs Ricavi per linea (top 30)</h2>
    <p>Ogni cerchio è una linea. La diagonale tratteggiata è la <strong>linea di pareggio</strong>: punti sopra = in attivo, sotto = in perdita.</p>
    ${__svgCostRevenueScatter(perRoute)}

    <h2>📈 Top 15 linee per costo giornaliero</h2>
    ${__htmlTopRoutesTable(perRoute, 15)}

    <h2>💡 Interventi suggeriti</h2>
    ${suggestions.length > 0 ? suggestions.map((s: any, i: number) => __htmlSuggestion(s, i)).join("")
      : "<p style='color:#64748b;'>Nessun intervento critico identificato sul perimetro analizzato.</p>"}

    <h2>🔬 Payload tecnico (JSON grezzo)</h2>
    <details><summary style="cursor:pointer;color:#3b82f6;font-weight:600;padding:8px 0;">▶ Espandi per vedere il payload completo</summary>
    <pre><code>${__escHtml(JSON.stringify({ filtri: { feedId: p.feedId, day: p.day, season: p.season, radiusM: p.radiusM, serviceDate: p.serviceDate, routeIds: p.selectedArr }, analysis: a, coverage: c, params: p.params }, null, 2))}</code></pre>
    </details>
  `;
  __openInNewTab("Report tecnico — TransitIntel", body);
}

/* ──────────────────────────────────────────────────────────
   REPORT NARRATIVO
   ────────────────────────────────────────────────────────── */
function __exportNarrativeReport(p: ExportPayload) {
  const a: any = p.analysis || {};
  const c: any = p.coverage || {};
  const summary = c.summary || {};
  const perRoute: any[] = a.perRoute || [];
  const byHour: any[] = c.byHour || [];
  const byCategory: any[] = c.byCategory || [];
  const suggestions: any[] = c.suggestions || [];

  const margine = (a.totalRevenueDay ?? 0) - (a.totalCostDay ?? 0);
  const popPct = summary.coveragePct != null ? summary.coveragePct * 100 : 0;
  const poiPct = summary.poiCoverageWeighted != null ? summary.poiCoverageWeighted * 100 : 0;
  const annualCost = (a.totalCostDay || 0) * 365;
  const annualRev = (a.totalRevenueDay || 0) * 365;
  const losingRoutes = perRoute.filter(r => (r.marginDay || 0) < 0);
  const peakHour = byHour.length > 0 ? byHour.reduce((mx, h) => h.trips > mx.trips ? h : mx, byHour[0]) : null;

  let narrazione = "";
  if (popPct >= 85) narrazione = `<p>Il servizio raggiunge una copertura della popolazione molto buona: <strong>oltre l'${popPct.toFixed(0)}%</strong> dei residenti ha una fermata attiva entro ${p.radiusM} metri. Il territorio è ben presidiato.</p>`;
  else if (popPct >= 70) narrazione = `<p>Il servizio copre <strong>circa ${popPct.toFixed(0)}%</strong> della popolazione: una buona base, ma c'è ancora margine per estendere la copertura nelle zone periferiche.</p>`;
  else narrazione = `<p>La copertura della popolazione è limitata: <strong>solo ${popPct.toFixed(0)}%</strong> dei residenti raggiunge una fermata a piedi. È necessario un piano di estensione delle linee o aggiunta di nuove fermate.</p>`;

  let economiaMsg = "";
  if (margine >= 0) economiaMsg = `<blockquote class="positive">✅ Il servizio è in <strong>equilibrio economico</strong>: i ricavi stimati superano i costi di ${__fmtEur(margine)} al giorno (~${__fmtEur(margine * 365)}/anno).</blockquote>`;
  else economiaMsg = `<blockquote class="warning">⚠️ Il servizio è in <strong>perdita</strong>: i costi superano i ricavi di ${__fmtEur(-margine)} al giorno (~${__fmtEur(-margine * 365)}/anno). Servono azioni di razionalizzazione o di stimolo all'utenza.</blockquote>`;

  const worstRoutes = [...losingRoutes].sort((x, y) => (x.marginDay || 0) - (y.marginDay || 0)).slice(0, 5);
  const worstCats = [...byCategory].filter(x => (x.relevance ?? 0) >= 0.5).sort((x, y) => (x.servedPct || 0) - (y.servedPct || 0)).slice(0, 3);

  const body = `
    <h1 class="title">📖 Come sta andando il servizio di trasporto pubblico</h1>
    <p class="subtitle">Una guida visiva per capire copertura, costi e dove intervenire — pensata per chi non lavora con i dati ogni giorno.</p>
    ${__filtersBox(p)}

    <h2>🎬 In sintesi</h2>
    <p>Questa relazione mostra <strong>come il servizio di trasporto pubblico</strong> serve la popolazione e i principali punti di interesse del territorio nelle giornate di tipo <strong>${p.day === "weekday" ? "feriale" : p.day === "saturday" ? "sabato" : "domenica/festivo"}</strong>, con un raggio pedonale di <strong>${p.radiusM} metri</strong> da ogni fermata.</p>
    ${narrazione}
    ${economiaMsg}

    <h2>1️⃣ Quanto costa, quanto rende</h2>
    <div class="kpi-grid">
      ${__svgKpiCard("Costo giornaliero", __fmtEur(a.totalCostDay), `~${__fmtEur(annualCost)} all'anno`, __PALETTE.warning, "💶")}
      ${__svgKpiCard("Ricavi giornalieri", __fmtEur(a.totalRevenueDay), `~${__fmtEur(annualRev)} all'anno`, __PALETTE.cyan, "🎫")}
      ${__svgKpiCard("Margine", __fmtEur(margine), margine >= 0 ? "in attivo ✓" : "in perdita ✗", margine >= 0 ? __PALETTE.success : __PALETTE.danger, margine >= 0 ? "📈" : "📉")}
    </div>
    <p>I costi sono calcolati sommando carburante, retribuzione del personale di guida, manutenzione e ammortamento dei mezzi. I ricavi sono una stima basata sulle tariffe medie applicate al chilometraggio.</p>
    ${losingRoutes.length > 0 ? `
      <h3>🔴 Linee che pesano di più sul bilancio</h3>
      <p>Sono <strong>${losingRoutes.length} linee</strong> che generano ricavi inferiori ai costi. Le 5 con la perdita maggiore:</p>
      ${__svgBarChartH(worstRoutes.map(r => ({ label: String(r.shortName || r.routeId), value: -(r.marginDay || 0), color: __PALETTE.danger, suffix: " €" })))}
    ` : ""}

    <h2>2️⃣ Quanto serve la popolazione</h2>
    <div class="gauge-grid">
      <div class="gauge-item">${__svgGaugePct(popPct, "Popolazione coperta", __PALETTE.primary)}
        <div class="gauge-detail"><strong>${__fmt(summary.populationServed)}</strong> persone con fermata vicina<br/>
        <span style="color:#64748b;">su ${__fmt(summary.populationTotal)} residenti totali</span></div>
      </div>
      <div class="gauge-item">${__svgGaugePct(poiPct, "Servizi essenziali raggiunti", __PALETTE.success)}
        <div class="gauge-detail"><strong>${__fmt(summary.poiServed)} luoghi importanti</strong> raggiungibili<br/>
        <span style="color:#64748b;">ospedali, scuole, stazioni, uffici…</span></div>
      </div>
    </div>
    <p>Una fermata è considerata "raggiungibile" se si trova <strong>entro ${p.radiusM} metri a piedi</strong> (circa ${Math.round(p.radiusM / 80)} minuti di camminata).</p>
    ${summary.uncoveredPopulation > 0 ? `<blockquote class="warning">⚠️ Restano <strong>${__fmt(summary.uncoveredPopulation)} persone</strong> senza una fermata raggiungibile. Per molte basterebbe un piccolo prolungamento del percorso o l'aggiunta di una fermata.</blockquote>` : ""}

    ${worstCats.length > 0 ? `
      <h3>📍 Servizi più critici da raggiungere</h3>
      <p>Queste categorie di luoghi importanti hanno la copertura più bassa:</p>
      ${__svgBarChartH(worstCats.map(cat => ({
        label: String(cat.category), value: (cat.servedPct || 0) * 100,
        color: ((cat.servedPct || 0) * 100) >= 80 ? __PALETTE.warning : __PALETTE.danger,
        max: 100, suffix: "%"
      })))}
    ` : ""}

    <h2>3️⃣ Quando viaggiano i bus</h2>
    <p>Distribuzione delle corse nelle 24 ore. Le <strong>ore di punta</strong> (7-9 mattino, 17-19 sera) sono evidenziate in rosso.</p>
    ${__svgHourlyChart(byHour)}
    ${peakHour ? `<p>L'ora più trafficata sono le <strong>${peakHour.hour}:00</strong> con <strong>${peakHour.trips} corse</strong> in circolazione.</p>` : ""}

    <h2>4️⃣ Cosa migliorare — interventi suggeriti</h2>
    ${suggestions.length > 0 ? suggestions.map((s: any, i: number) => __htmlSuggestion(s, i)).join("")
      : "<p>Il servizio appare bilanciato sul perimetro analizzato: non sono stati identificati interventi critici da segnalare.</p>"}

    <h2>📚 Glossario</h2>
    <div class="glossary">
      <div><strong>Popolazione coperta</strong><br/><span style="color:#64748b;">Persone residenti la cui zona ha una fermata attiva entro ${p.radiusM} metri.</span></div>
      <div><strong>POI (Punti di Interesse)</strong><br/><span style="color:#64748b;">Luoghi importanti come ospedali, scuole, stazioni, uffici. Ogni categoria ha un peso diverso per giorno e stagione.</span></div>
      <div><strong>Costo del servizio</strong><br/><span style="color:#64748b;">Carburante + stipendio conducente + manutenzione + ammortamento del mezzo.</span></div>
      <div><strong>Margine</strong><br/><span style="color:#64748b;">Differenza tra ricavi (tariffe pagate) e costi. Se negativo, il servizio è in perdita.</span></div>
      <div><strong>Corsa</strong><br/><span style="color:#64748b;">Un singolo viaggio del bus dal capolinea iniziale a quello finale.</span></div>
      <div><strong>Linea</strong><br/><span style="color:#64748b;">Un percorso fisso identificato da un codice (es. "1/4", "R"). Una linea fa molte corse al giorno.</span></div>
    </div>
  `;
  __openInNewTab("Report narrativo — TransitIntel", body);
}
