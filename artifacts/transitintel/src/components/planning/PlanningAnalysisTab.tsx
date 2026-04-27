/**
 * PlanningAnalysisTab v4 — analisi economica + ridership + mobility insights.
 *
 * Migliorie chiave v4:
 *  - Filtri progressivi cascade: Giorno → Categoria → Linee specifiche
 *    (ogni step mostra il conteggio e abilita lo step successivo)
 *  - Colori distinti per linea (palette HSL deterministica per routeId)
 *  - Modalità mappa "Mobility insights" che sostituisce l'heatmap statica:
 *    archi O/D ISTAT (origine→destinazione pendolari) + POI dal catalog
 *    Google Places filtrabili per categoria
 *  - Demand presets: feriale lavoro, sabato shopping, domenica estiva
 *    (lungomare), domenica invernale (centri commerciali)
 *  - POI catalog: niente input manuale, spunti le categorie disponibili
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Loader2, AlertTriangle, RefreshCw, TrendingUp, TrendingDown, Map as MapIcon,
  Bus, Clock, Route as RouteIcon, Users, Wallet, Receipt, Coins, Settings2, Save,
  Filter, Calendar as CalIcon, FileDown, Layers, MapPin, Tags, Target, X,
  ChevronRight, Sparkles, HelpCircle,
  // POI category icons (enterprise lucide set)
  Hospital, GraduationCap, ShoppingBag, Factory, Activity, Building2, TrainFront,
  Briefcase, Church, HeartHandshake, ParkingSquare, Camera,
  // Preset icons
  Sun, ShoppingCart, Moon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { apiFetch, getApiBase } from "@/lib/api";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from "recharts";
import { Map as MapGL, Source, Layer, Marker } from "react-map-gl/mapbox";
import type { MapRef } from "react-map-gl/mapbox";
import "mapbox-gl/dist/mapbox-gl.css";
import { usePlanningFilters } from "./PlanningFiltersContext";

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN || "";

/* ──────────────────────────── tipi ──────────────────────────── */

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
  costFuelDay: number;
  costMaintDay: number;
  costAmortDay: number;
  costDriverDay: number;
  costTotalDay: number;
  revenueDay: number;
  marginDay: number;
  estimatedPaxDay: number;
  paxPerKm: number;
}

type DayType = "weekday" | "saturday" | "sunday" | "all";

interface Analysis {
  totalKmDay: number;
  totalHoursDay: number;
  totalTripsDay: number;
  activeRoutes: number;
  activeStops: number;
  populationCovered: number;
  populationTotal: number;
  totalCostDay: number;
  totalRevenueDay: number;
  marginDay: number;
  perRoute: RouteKpi[];
  anomalies: { tripsWithoutShape: number; stopsOrphan: number; routesWithoutTrips: number };
  bbox: { minLat: number; maxLat: number; minLon: number; maxLon: number } | null;
  hourlyDistribution?: number[];
  topStops?: { stopId: string; stopName: string; lat: number; lon: number; trips: number }[];
  categories?: { category: string; routeCount: number; kmDay: number; revenueDay: number }[];
  ridership?: {
    estimatedPaxDay: number;
    revenuePerPax: number;
    costPerPax: number;
    methodology: string;
    poisConsidered: number;
  };
  filters?: {
    dayType: DayType;
    routeIds: string[] | null;
    pickedDate: string | null;
    serviceIdsCount: number;
    serviceDate: string | null;
    categoryFilter: string[] | null;
  };
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

interface RouteOpt {
  routeId: string;
  shortName: string | null;
  longName: string | null;
  color: string | null;
  routeType: number | null;
}

interface CalendarDay { date: string; service_count: number; dow: number; }

interface RouteClassification {
  routeId: string;
  category: string;
  fareType: "urban" | "suburban" | "night" | null;
}

interface CatalogPoi {
  id: string;
  name: string | null;
  category: string;
  lat: number;
  lng: number;
}

interface MobilityFlow {
  origin_istat: string;
  origin_name: string | null;
  origin_lat: number;
  origin_lon: number;
  dest_istat: string;
  dest_name: string | null;
  dest_lat: number;
  dest_lon: number;
  flow: number;
}

interface DemandPreset {
  preset: string;
  label: string;
  description: string;
  poiCategories: string[];
  istatReason: string;
  istatMode: string;
}

interface HourlyRoute {
  routeId: string;
  shortName: string | null;
  longName: string | null;
  color: string | null;
  perHour: number[];
  total: number;
}

const DAY_LABELS: Record<DayType, string> = {
  weekday: "Feriale", saturday: "Sabato", sunday: "Festivo", all: "Tutti",
};

const DEFAULT_CATEGORIES = [
  { id: "urbano-ancona", label: "Urbano Ancona", fareType: "urban" as const, color: "#2563eb" },
  { id: "urbano-falconara", label: "Urbano Falconara", fareType: "urban" as const, color: "#06b6d4" },
  { id: "urbano-jesi", label: "Urbano Jesi", fareType: "urban" as const, color: "#10b981" },
  { id: "extraurbano", label: "Extraurbano", fareType: "suburban" as const, color: "#f59e0b" },
  { id: "notturno", label: "Notturno", fareType: "night" as const, color: "#8b5cf6" },
  { id: "altro", label: "Altro", fareType: null, color: "#6b7280" },
];
const CATEGORY_COLOR: Record<string, string> = Object.fromEntries(
  DEFAULT_CATEGORIES.map((c) => [c.id, c.color])
);

const POI_CATALOG_META: Record<string, { label: string; Icon: LucideIcon; color: string }> = {
  hospital:   { label: "Ospedali / Sanità",     Icon: Hospital,       color: "#ef4444" },
  school:     { label: "Scuole / Università",   Icon: GraduationCap,  color: "#3b82f6" },
  shopping:   { label: "Centri commerciali",    Icon: ShoppingBag,    color: "#f59e0b" },
  industrial: { label: "Zone industriali",      Icon: Factory,        color: "#71717a" },
  leisure:    { label: "Tempo libero / Sport",  Icon: Activity,       color: "#10b981" },
  office:     { label: "Uffici / PA",           Icon: Building2,      color: "#06b6d4" },
  transit:    { label: "Stazioni / Trasporti",  Icon: TrainFront,     color: "#8b5cf6" },
  workplace:  { label: "Posti di lavoro",       Icon: Briefcase,      color: "#0ea5e9" },
  worship:    { label: "Luoghi di culto",       Icon: Church,         color: "#a855f7" },
  elderly:    { label: "RSA / Anziani",         Icon: HeartHandshake, color: "#d946ef" },
  parking:    { label: "Parcheggi scambiatori", Icon: ParkingSquare,  color: "#64748b" },
  tourism:    { label: "Turismo / Cultura",     Icon: Camera,         color: "#ec4899" },
};

const DEMAND_PRESETS: { id: string; Icon: LucideIcon; label: string; hint: string }[] = [
  { id: "weekday-work",     Icon: Briefcase,    label: "Feriale lavoro",     hint: "Pendolari verso uffici, scuole, ospedali" },
  { id: "sat-shopping",     Icon: ShoppingBag,  label: "Sabato shopping",    hint: "Centri commerciali, centri storici" },
  { id: "sun-summer-coast", Icon: Sun,          label: "Domenica estiva",    hint: "Lungomare, spiagge, turismo" },
  { id: "sun-winter-mall",  Icon: ShoppingCart, label: "Domenica invernale", hint: "Centri commerciali, ristoranti" },
  { id: "evening-leisure",  Icon: Moon,         label: "Sera tempo libero",  hint: "Cinema, eventi, ristoranti" },
];

const fmtEur = (n: number) =>
  new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(n);
const fmtEur2 = (n: number) =>
  new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR", maximumFractionDigits: 2 }).format(n);
const fmtNum = (n: number, d = 0) =>
  new Intl.NumberFormat("it-IT", { maximumFractionDigits: d }).format(n);

/** Genera un colore HEX deterministico da una stringa (per linea). */
function colorForRoute(routeId: string, gtfsColor: string | null): string {
  if (gtfsColor) {
    const c = String(gtfsColor).replace(/^#/, "").toLowerCase();
    if (/^[0-9a-f]{6}$/.test(c) && c !== "000000" && c !== "ffffff") {
      return `#${c}`;
    }
  }
  let hash = 0;
  for (let i = 0; i < routeId.length; i++) hash = (hash * 31 + routeId.charCodeAt(i)) | 0;
  const h = Math.abs(hash) % 360;
  const s = 70 + (Math.abs(hash >> 8) % 20);  // 70-90
  const l = 52 + (Math.abs(hash >> 16) % 13); // 52-65
  return hslToHex(h, s, l);
}

function hslToHex(h: number, s: number, l: number): string {
  s /= 100; l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  const toHex = (v: number) => Math.round(v * 255).toString(16).padStart(2, "0");
  return `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`;
}

/* ──────────────────────────── component ──────────────────────────── */

export default function PlanningAnalysisTab({ feedId }: { feedId: string | null }) {
  // dati base
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [params, setParams] = useState<EconParams | null>(null);
  const [routes, setRoutes] = useState<RouteOpt[]>([]);
  const [shapes, setShapes] = useState<any | null>(null);
  const [calendarDays, setCalendarDays] = useState<CalendarDay[]>([]);
  const [classifications, setClassifications] = useState<RouteClassification[]>([]);

  // POI catalog (Google Places)
  const [catalogCategories, setCatalogCategories] = useState<{ category: string; count: number }[]>([]);
  const [catalogPois, setCatalogPois] = useState<CatalogPoi[]>([]);
  const [selectedPoiCats, setSelectedPoiCats] = useState<Set<string>>(new Set());

  // Mobility flows
  const [flows, setFlows] = useState<MobilityFlow[]>([]);
  const [flowSource, setFlowSource] = useState<string>("");
  const [flowNote, setFlowNote]     = useState<string>("");
  const [flowReason, setFlowReason] = useState<string>("all"); // work | study | all
  const [flowMode, setFlowMode]     = useState<string>("all"); // bus_urban | bus_extraurban | all
  const [flowMin, setFlowMin]       = useState<number>(20);

  // Hourly schedule per linea
  const [hourly, setHourly] = useState<{ hours: number[]; routes: HourlyRoute[] } | null>(null);

  // Mappa: hover/click linea
  const [hoveredRouteId, setHoveredRouteId] = useState<string | null>(null);

  // Filtri progressivi
  const [dayType, setDayType] = useState<DayType>("weekday");
  const [serviceDate, setServiceDate] = useState<string | null>(null);
  const [selectedCategories, setSelectedCategories] = useState<Set<string>>(new Set());
  const [selectedRouteIds, setSelectedRouteIds]     = useState<Set<string>>(new Set());
  const [routeSearch, setRouteSearch] = useState("");
  const [activePreset, setActivePreset] = useState<string | null>(null);

  // ── Sync bidirezionale con il context dei filtri condivisi ──
  // Quando cambia il giorno nel context (es. dall'altro tab), aggiornalo qui
  // e viceversa. "all" non è mappabile sul context (3 valori) → restiamo locali.
  const filtersCtx = usePlanningFilters();
  useEffect(() => {
    if (!filtersCtx) return;
    if (filtersCtx.day && filtersCtx.day !== dayType && dayType !== "all") {
      setDayType(filtersCtx.day);
      setServiceDate(null); // un dayType del context bypassa serviceDate
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtersCtx?.day]);
  useEffect(() => {
    if (!filtersCtx) return;
    if (dayType !== "all" && filtersCtx.day !== dayType) {
      filtersCtx.setDay(dayType as any);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dayType]);

  // UI
  const [loading, setLoading]   = useState(false);
  const [running, setRunning]   = useState(false);
  const [savingParams, setSavingParams] = useState(false);
  const [error, setError]       = useState<string | null>(null);
  const [showParams, setShowParams]         = useState(false);
  const [showClassifier, setShowClassifier] = useState(false);
  const [showMap, setShowMap]               = useState(true);
  const [mapMode, setMapMode] = useState<"network" | "mobility" | "both">("both");
  const mapRef = useRef<MapRef | null>(null);

  /* ── load base ── */
  useEffect(() => {
    if (!feedId) {
      setAnalysis(null); setParams(null); setRoutes([]); setShapes(null);
      setCalendarDays([]); setClassifications([]); setCatalogCategories([]);
      setCatalogPois([]); setFlows([]);
      return;
    }
    setLoading(true);
    setError(null);
    Promise.all([
      apiFetch<{ analysis: Analysis | null }>(`/api/planning/feeds/${feedId}/analysis`).catch(() => ({ analysis: null })),
      apiFetch<{ params: EconParams }>(`/api/planning/feeds/${feedId}/economic-params`),
      apiFetch<{ routes: RouteOpt[] }>(`/api/planning/feeds/${feedId}/routes`),
      apiFetch<{ days: CalendarDay[] }>(`/api/planning/feeds/${feedId}/calendar-days`).catch(() => ({ days: [] })),
      apiFetch<{ classifications: RouteClassification[] }>(`/api/planning/feeds/${feedId}/route-classifications`).catch(() => ({ classifications: [] })),
      apiFetch<{ categories: { category: string; count: number }[]; pois: CatalogPoi[] }>(`/api/planning/feeds/${feedId}/poi-catalog`).catch(() => ({ categories: [], pois: [] })),
    ])
      .then(([a, p, r, cd, cl, poi]) => {
        setAnalysis(a.analysis);
        setParams(p.params);
        setRoutes(r.routes);
        setCalendarDays(cd.days || []);
        setClassifications(cl.classifications || []);
        setCatalogCategories(poi.categories || []);
        setCatalogPois(poi.pois || []);
      })
      .catch((e) => setError(e?.message || "Errore caricamento"))
      .finally(() => setLoading(false));
  }, [feedId]);

  /* ── shapes (filtrate) ── */
  useEffect(() => {
    if (!feedId) return;
    const allowed = getAllowedRouteIds(routes, classifications, selectedRouteIds, selectedCategories);
    const qs = allowed ? `?routes=${Array.from(allowed).join(",")}` : "";
    apiFetch(`/api/planning/feeds/${feedId}/shapes${qs}`)
      .then((g: any) => {
        // arricchisci con colore-per-routeId deterministico
        if (g && Array.isArray(g.features)) {
          const routeColorById = new Map(routes.map((r) => [r.routeId, colorForRoute(r.routeId, r.color)]));
          for (const f of g.features) {
            const rid = f.properties?.routeId;
            f.properties.lineColor = rid ? (routeColorById.get(rid) || "#3b82f6") : "#3b82f6";
          }
        }
        setShapes(g);
      })
      .catch(() => setShapes(null));
  }, [feedId, selectedRouteIds, selectedCategories, classifications, routes]);

  /* ── mobility flows (su richiesta o cambio filtro) ── */
  useEffect(() => {
    if (!feedId) return;
    const params: Record<string, string> = {
      reason: flowReason, mode: flowMode, minFlow: String(flowMin),
    };
    if (selectedPoiCats.size > 0) params.poiCategories = Array.from(selectedPoiCats).join(",");
    const qs = new URLSearchParams(params);
    apiFetch<{ flows: MobilityFlow[]; totalFlow: number; source?: string; note?: string }>(
      `/api/planning/feeds/${feedId}/mobility-flows?${qs}`
    )
      .then((r) => {
        setFlows(r.flows || []);
        setFlowSource(r.source || "");
        setFlowNote(r.note || "");
      })
      .catch(() => { setFlows([]); setFlowSource(""); setFlowNote(""); });
  }, [feedId, flowReason, flowMode, flowMin, selectedPoiCats]);

  /* ── hourly schedule per linea ── */
  useEffect(() => {
    if (!feedId) return;
    const allowed = getAllowedRouteIds(routes, classifications, selectedRouteIds, selectedCategories);
    const params: Record<string, string> = serviceDate
      ? { serviceDate }
      : { dayType };
    if (allowed) params.routes = Array.from(allowed).join(",");
    const qs = new URLSearchParams(params);
    apiFetch<{ hours: number[]; routes: HourlyRoute[] }>(
      `/api/planning/feeds/${feedId}/hourly-schedule?${qs}`
    )
      .then((r) => setHourly(r))
      .catch(() => setHourly(null));
  }, [feedId, serviceDate, dayType, selectedRouteIds, selectedCategories, classifications, routes]);

  /* ── fit bbox ── */
  useEffect(() => {
    if (!analysis?.bbox || !mapRef.current) return;
    const b = analysis.bbox;
    mapRef.current.fitBounds(
      [[b.minLon, b.minLat], [b.maxLon, b.maxLat]],
      { padding: 60, duration: 800 }
    );
  }, [analysis?.bbox]);

  /* ── actions ── */
  async function runAnalyze() {
    if (!feedId) return;
    setRunning(true);
    setError(null);
    try {
      const allowed = getAllowedRouteIds(routes, classifications, selectedRouteIds, selectedCategories);
      const r = await apiFetch<{ analysis: Analysis }>(`/api/planning/feeds/${feedId}/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dayType,
          serviceDate: serviceDate || null,
          routeIds: allowed ? Array.from(allowed) : null,
          categoryFilter: selectedCategories.size > 0 ? Array.from(selectedCategories) : null,
        }),
      });
      setAnalysis(r.analysis);
    } catch (e: any) {
      setError(e?.message || "Errore analisi");
    } finally {
      setRunning(false);
    }
  }

  async function saveParams() {
    if (!feedId || !params) return;
    setSavingParams(true);
    setError(null);
    try {
      await apiFetch(`/api/planning/feeds/${feedId}/economic-params`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
      });
      await runAnalyze();
    } catch (e: any) {
      setError(e?.message || "Errore parametri");
    } finally {
      setSavingParams(false);
    }
  }

  async function bulkUpdateClassifications(items: { routeId: string; category: string; fareType: string | null }[]) {
    if (!feedId || items.length === 0) return;
    try {
      await apiFetch(`/api/planning/feeds/${feedId}/route-classifications`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items }),
      });
      const r = await apiFetch<{ classifications: RouteClassification[] }>(`/api/planning/feeds/${feedId}/route-classifications`);
      setClassifications(r.classifications);
    } catch (e: any) {
      setError(e?.message || "Errore salvataggio classificazioni");
    }
  }

  async function applyPreset(presetId: string) {
    if (!feedId) return;
    try {
      const r = await apiFetch<DemandPreset>(`/api/planning/feeds/${feedId}/demand-preset?preset=${presetId}`);
      setSelectedPoiCats(new Set(r.poiCategories));
      setFlowReason(r.istatReason);
      setFlowMode(r.istatMode);
      setActivePreset(presetId);
      setMapMode("both");
      setShowMap(true);
    } catch (e: any) {
      setError(e?.message || "Errore preset");
    }
  }

  function exportPdf() {
    if (!analysis) return;
    const html = buildReportHtml(analysis, params, dayType);
    const w = window.open("", "_blank");
    if (!w) { alert("Abilita i popup per esportare il PDF"); return; }
    w.document.write(html);
    w.document.close();
  }

  /* ── derivati ── */
  const categoryByRoute = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of classifications) m.set(c.routeId, c.category);
    return m;
  }, [classifications]);

  // Linee disponibili dopo filtro categoria
  const routesAfterCategory = useMemo(() => {
    if (selectedCategories.size === 0) return routes;
    return routes.filter((r) => {
      const cat = categoryByRoute.get(r.routeId);
      return cat && selectedCategories.has(cat);
    });
  }, [routes, categoryByRoute, selectedCategories]);

  // Linee mostrate nel filtro fine (dopo search)
  const filteredRoutes = useMemo(() => {
    const q = routeSearch.toLowerCase().trim();
    let list = routesAfterCategory;
    if (q) {
      list = list.filter((r) =>
        (r.shortName ?? "").toLowerCase().includes(q) ||
        (r.longName ?? "").toLowerCase().includes(q) ||
        r.routeId.toLowerCase().includes(q)
      );
    }
    return [...list].sort((a, b) =>
      (a.shortName || a.routeId).localeCompare(b.shortName || b.routeId, "it", { numeric: true })
    );
  }, [routesAfterCategory, routeSearch]);

  const finalRouteCount = useMemo(() => {
    if (selectedRouteIds.size > 0) {
      // intersezione con routes-after-category
      let n = 0;
      for (const r of routesAfterCategory) if (selectedRouteIds.has(r.routeId)) n++;
      return n;
    }
    return routesAfterCategory.length;
  }, [routesAfterCategory, selectedRouteIds]);

  const hourlyData = useMemo(
    () => (analysis?.hourlyDistribution ?? []).map((v, h) => ({ hour: `${h}`, corse: v })),
    [analysis?.hourlyDistribution]
  );
  const hasHourly = (analysis?.hourlyDistribution?.length ?? 0) > 0;
  const topStops = analysis?.topStops ?? [];
  const classifiedCount = classifications.length;

  // POI filtrati per categorie selezionate
  const visiblePois = useMemo(
    () => selectedPoiCats.size === 0 ? [] : catalogPois.filter((p) => selectedPoiCats.has(p.category)),
    [catalogPois, selectedPoiCats]
  );

  // GeoJSON archi O/D
  const flowsGeoJson = useMemo(() => {
    if (flows.length === 0) return null;
    const maxFlow = Math.max(...flows.map((f) => f.flow), 1);
    return {
      type: "FeatureCollection",
      features: flows
        .filter((f) => Number.isFinite(f.origin_lat) && Number.isFinite(f.dest_lat))
        .filter((f) => !(Math.abs(f.origin_lat - f.dest_lat) < 1e-6 && Math.abs(f.origin_lon - f.dest_lon) < 1e-6))
        .map((f) => ({
          type: "Feature",
          properties: {
            flow: f.flow,
            normFlow: f.flow / maxFlow,
            label: `${f.origin_name ?? f.origin_istat} → ${f.dest_name ?? f.dest_istat}: ${f.flow}`,
          },
          geometry: {
            type: "LineString",
            coordinates: [[f.origin_lon, f.origin_lat], [f.dest_lon, f.dest_lat]],
          },
        })),
    };
  }, [flows]);

  if (!feedId) {
    return (
      <div className="py-12 text-center">
        <Wallet className="w-10 h-10 text-muted-foreground/40 mx-auto mb-3" />
        <p className="text-muted-foreground">Seleziona un feed per l'analisi.</p>
      </div>
    );
  }
  if (loading) {
    return (
      <div className="py-12 flex items-center justify-center gap-3 text-muted-foreground">
        <Loader2 className="w-5 h-5 animate-spin" />
        <span>Caricamento…</span>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Wallet className="w-5 h-5 text-primary" /> Pianificazione, Costi & Mobility Insights
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            {analysis?.filters ? (
              <>
                {analysis.filters.serviceDate ? <>Data: <strong>{formatPickedDate(analysis.filters.serviceDate)}</strong></> : <>Giorno: <strong>{DAY_LABELS[analysis.filters.dayType]}</strong></>}
                {" · "}{analysis.filters.routeIds ? `${analysis.filters.routeIds.length} linee` : "tutte le linee"}
                {analysis.filters.categoryFilter && <> · {analysis.filters.categoryFilter.join(", ")}</>}
              </>
            ) : "Imposta filtri ed esegui l'analisi."}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {analysis && (
            <button onClick={exportPdf} className="inline-flex items-center gap-2 px-3 py-1.5 text-sm rounded-md border border-border hover:bg-muted">
              <FileDown className="w-4 h-4" /> PDF
            </button>
          )}
          <button onClick={() => setShowClassifier(true)} className="inline-flex items-center gap-2 px-3 py-1.5 text-sm rounded-md border border-border hover:bg-muted">
            <Tags className="w-4 h-4" /> Classifica linee
            {classifiedCount > 0 && <span className="text-xs bg-primary/20 text-primary px-1.5 rounded">{classifiedCount}/{routes.length}</span>}
          </button>
          <button onClick={() => setShowParams(!showParams)} className="inline-flex items-center gap-2 px-3 py-1.5 text-sm rounded-md border border-border hover:bg-muted">
            <Settings2 className="w-4 h-4" /> Parametri
          </button>
          <button onClick={runAnalyze} disabled={running} className="inline-flex items-center gap-2 px-4 py-1.5 text-sm rounded-md bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50">
            {running ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            Esegui analisi
          </button>
        </div>
      </div>

      {/* Demand presets */}
      <div className="bg-gradient-to-br from-indigo-500/10 to-purple-500/10 border border-indigo-500/30 rounded-xl p-4">
        <div className="flex items-center gap-2 mb-2">
          <Sparkles className="w-4 h-4 text-indigo-400" />
          <span className="text-sm font-semibold">Scenari di domanda</span>
          <HelpHint text="Preset rapidi che simulano un giorno-tipo: configurano automaticamente i POI rilevanti (es. lungomare per la domenica estiva, centri commerciali per il sabato) e i flussi pendolari ISTAT da analizzare. Servono per capire DOVE indirizzare i bus in scenari specifici, prima di rivedere il programma di servizio." />
          <span className="text-xs text-muted-foreground">— preset rapidi che configurano POI + flussi O/D</span>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
          {DEMAND_PRESETS.map((p) => {
            const on = activePreset === p.id;
            return (
              <button key={p.id} onClick={() => applyPreset(p.id)}
                className={`text-left p-2 rounded-lg border transition ${on ? "border-indigo-400 bg-indigo-500/15" : "border-border hover:bg-muted/40"}`}>
                <p.Icon className={`w-5 h-5 mb-1 ${on ? "text-indigo-300" : "text-muted-foreground"}`} />
                <div className="text-xs font-semibold">{p.label}</div>
                <div className="text-[10px] text-muted-foreground line-clamp-2 mt-0.5">{p.hint}</div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Filtri progressivi cascade */}
      <div className="bg-card/60 border border-border/40 rounded-xl p-4 space-y-4">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Filter className="w-4 h-4" /> Filtri progressivi
          <HelpHint text="Tre step in cascata che restringono progressivamente il perimetro di analisi: prima scegli il giorno (determina quali corse sono in esercizio), poi il tipo di servizio (urbano/extraurbano), infine le linee specifiche da analizzare. I KPI economici (km, ore, costi, ricavi, margine) e la stima passeggeri saranno calcolati SOLO sulla selezione finale." />
          <span className="text-xs text-muted-foreground font-normal">— ogni step affina la selezione</span>
        </div>

        {/* STEP 1: Giorno */}
        <FilterStep
          n={1}
          title="Giorno"
          help="Stabilisce quali service-id GTFS sono attivi: corse, vetture-km e ore-conducente vengono calcolate solo per quel giorno. Scegli una data specifica del calendario reale (più preciso) oppure un tipo (Feriale = lun-ven medio, Sabato, Festivo)."
          badge={analysis?.filters?.serviceIdsCount ? `${analysis.filters.serviceIdsCount} service-id` : undefined}
        >
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-2">
              <CalIcon className="w-4 h-4 text-muted-foreground" />
              <select
                value={serviceDate ?? ""}
                onChange={(e) => setServiceDate(e.target.value || null)}
                className="px-2 py-1 text-xs border border-border rounded bg-background min-w-[200px]"
              >
                <option value="">— scegli un tipo giorno —</option>
                {calendarDays.map((d) => (
                  <option key={d.date} value={d.date}>
                    {formatPickedDate(d.date)} · {["Lun","Mar","Mer","Gio","Ven","Sab","Dom"][d.dow-1]} · {d.service_count} serv.
                  </option>
                ))}
              </select>
              {serviceDate && <button onClick={() => setServiceDate(null)} className="text-xs text-muted-foreground hover:text-foreground underline">reset</button>}
            </div>
            {!serviceDate && (
              <div className="flex gap-1">
                {(["weekday","saturday","sunday","all"] as const).map((d) => (
                  <button key={d} onClick={() => setDayType(d)}
                    className={`px-2.5 py-1 rounded text-xs font-medium transition ${dayType===d ? "bg-primary text-primary-foreground" : "bg-muted/40 text-muted-foreground hover:bg-muted"}`}>
                    {DAY_LABELS[d]}
                  </button>
                ))}
              </div>
            )}
          </div>
        </FilterStep>

        {/* STEP 2: Categorie */}
        <FilterStep
          n={2}
          title="Tipo di servizio"
          help="Filtra per categoria assegnata in fase di classificazione (Urbano Ancona/Falconara/Jesi, Extraurbano, Notturno). La categoria determina anche il corrispettivo €/km applicato per il calcolo dei ricavi. Se vuoto = tutte le categorie."
          badge={`${selectedCategories.size === 0 ? "tutte" : selectedCategories.size} cat. → ${routesAfterCategory.length} linee`}
        >
          <div className="flex items-center gap-2 flex-wrap">
            {DEFAULT_CATEGORIES.map((c) => {
              const on = selectedCategories.has(c.id);
              const count = classifications.filter((cl) => cl.category === c.id).length;
              if (count === 0 && !on) return null;
              return (
                <button key={c.id} onClick={() => {
                  const n = new Set(selectedCategories);
                  if (on) n.delete(c.id); else n.add(c.id);
                  setSelectedCategories(n);
                  // reset selezione fine quando cambia il filtro categoria
                  setSelectedRouteIds(new Set());
                }} className={`px-2.5 py-1 rounded text-xs font-medium border transition ${on ? "text-white" : "text-muted-foreground"}`}
                  style={{ borderColor: c.color, background: on ? c.color : "transparent" }}>
                  <span className="w-2 h-2 inline-block rounded-full mr-1.5" style={{ background: c.color }} />
                  {c.label} ({count})
                </button>
              );
            })}
            {selectedCategories.size > 0 && (
              <button onClick={() => { setSelectedCategories(new Set()); setSelectedRouteIds(new Set()); }} className="text-xs text-muted-foreground hover:text-foreground underline ml-2">reset</button>
            )}
            {classifications.length === 0 && (
              <span className="text-xs text-muted-foreground italic">Nessuna linea classificata · clicca <strong>Classifica linee</strong> in alto</span>
            )}
          </div>
        </FilterStep>

        {/* STEP 3: Selezione linee specifiche */}
        <FilterStep
          n={3}
          title="Linee specifiche"
          help="Seleziona puntualmente le linee da analizzare (es. solo le linee del lungomare per scenario estivo). Lasciando tutto deselezionato si considerano tutte le linee del filtro categoria. Ogni linea ha un colore univoco riportato anche sulla mappa e nella tabella performance."
          badge={`${finalRouteCount} / ${routesAfterCategory.length} selezionate`}
        >
          <div className="space-y-2">
            <div className="flex items-center gap-2 flex-wrap">
              <input
                type="text" value={routeSearch} onChange={(e) => setRouteSearch(e.target.value)}
                placeholder="Cerca linea (numero o nome)…"
                className="flex-1 min-w-[200px] px-3 py-1.5 text-sm border border-border rounded bg-background"
              />
              <button onClick={() => setSelectedRouteIds(new Set(filteredRoutes.map((r) => r.routeId)))} className="px-2 py-1 text-xs border border-border rounded hover:bg-muted">Tutte</button>
              <button onClick={() => {
                const n = new Set<string>();
                for (const r of filteredRoutes) if (!selectedRouteIds.has(r.routeId)) n.add(r.routeId);
                setSelectedRouteIds(n);
              }} className="px-2 py-1 text-xs border border-border rounded hover:bg-muted">Inverti</button>
              <button onClick={() => setSelectedRouteIds(new Set())} className="px-2 py-1 text-xs border border-border rounded hover:bg-muted">Nessuna</button>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-1 max-h-56 overflow-y-auto pr-2">
              {filteredRoutes.map((r) => {
                const sel = selectedRouteIds.has(r.routeId);
                const cat = categoryByRoute.get(r.routeId);
                const lineColor = colorForRoute(r.routeId, r.color);
                return (
                  <label key={r.routeId} className={`flex items-center gap-2 px-2 py-1.5 rounded text-xs cursor-pointer transition ${sel ? "bg-primary/15 border border-primary/40" : "border border-transparent hover:bg-muted"}`}>
                    <input type="checkbox" checked={sel} onChange={(e) => {
                      const next = new Set(selectedRouteIds);
                      if (e.target.checked) next.add(r.routeId); else next.delete(r.routeId);
                      setSelectedRouteIds(next);
                    }} className="shrink-0" />
                    <span className="inline-block w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: lineColor }} />
                    <span className="font-medium shrink-0">{r.shortName || r.routeId}</span>
                    <span className="text-muted-foreground truncate">{r.longName}</span>
                    {cat && <span className="text-[9px] px-1 rounded shrink-0" style={{ background: (CATEGORY_COLOR[cat]||"#888")+"22", color: CATEGORY_COLOR[cat]||"#888" }}>{cat.split("-")[0]}</span>}
                  </label>
                );
              })}
              {filteredRoutes.length === 0 && (
                <div className="col-span-full text-xs text-muted-foreground italic py-4 text-center">Nessuna linea per i filtri attuali</div>
              )}
            </div>
          </div>
        </FilterStep>

        {/* Riepilogo */}
        <div className="flex items-center gap-2 text-xs text-muted-foreground border-t border-border/40 pt-3">
          <span>Selezione effettiva:</span>
          <strong className="text-foreground">{finalRouteCount} linee</strong>
          {selectedCategories.size > 0 && <><ChevronRight className="w-3 h-3" /><span>{Array.from(selectedCategories).join(", ")}</span></>}
          {(serviceDate || dayType !== "weekday") && <><ChevronRight className="w-3 h-3" /><span>{serviceDate ? formatPickedDate(serviceDate) : DAY_LABELS[dayType]}</span></>}
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-3 p-4 rounded-xl border bg-destructive/10 border-destructive/30 text-destructive">
          <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" />
          <div className="text-sm flex-1">{error}</div>
          <button onClick={() => setError(null)}><X className="w-4 h-4" /></button>
        </div>
      )}

      {/* Parametri */}
      {showParams && params && (
        <div className="bg-card/60 border border-border/40 rounded-xl p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold flex items-center gap-2 text-sm"><Settings2 className="w-4 h-4" /> Parametri economici</h3>
            <button onClick={saveParams} disabled={savingParams} className="inline-flex items-center gap-2 px-3 py-1.5 text-xs rounded-md bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50">
              {savingParams ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />} Salva e ricalcola
            </button>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <NumField label="Consumo (l/100km)" value={params.fuelConsumptionL100} step={1} onChange={v => setParams({ ...params, fuelConsumptionL100: v })} />
            <NumField label="Carburante (€/l)" value={params.fuelPriceEurL} step={0.01} onChange={v => setParams({ ...params, fuelPriceEurL: v })} />
            <NumField label="Conducente (€/h)" value={params.driverCostEurH} step={0.5} onChange={v => setParams({ ...params, driverCostEurH: v })} />
            <NumField label="Manutenzione (€/km)" value={params.maintenanceEurKm} step={0.05} onChange={v => setParams({ ...params, maintenanceEurKm: v })} />
            <NumField label="Ammortamento (€/km)" value={params.amortizationEurKm} step={0.05} onChange={v => setParams({ ...params, amortizationEurKm: v })} />
            <NumField label="Corrisp. urbano (€/km)" value={params.fareUrbanEurKm} step={0.05} onChange={v => setParams({ ...params, fareUrbanEurKm: v })} />
            <NumField label="Corrisp. extraurbano (€/km)" value={params.fareSuburbanEurKm} step={0.05} onChange={v => setParams({ ...params, fareSuburbanEurKm: v })} />
            <NumField label="Corrisp. notturno (€/km)" value={params.fareNightEurKm} step={0.05} onChange={v => setParams({ ...params, fareNightEurKm: v })} />
          </div>
        </div>
      )}

      {!analysis && (
        <div className="border-2 border-dashed border-border/40 rounded-xl p-12 text-center">
          <Wallet className="w-12 h-12 text-muted-foreground/40 mx-auto mb-3" />
          <h3 className="font-semibold mb-1">Nessuna analisi calcolata</h3>
          <p className="text-sm text-muted-foreground">Imposta i filtri sopra e clicca <strong>Esegui analisi</strong>.</p>
        </div>
      )}

      {analysis && (
        <>
          {/* KPI Servizio */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <KpiCard icon={Bus} label="Vetture-km / giorno" value={fmtNum(analysis.totalKmDay)} sub="km totali" color="text-blue-400"
              help="Somma dei km percorsi da tutte le corse del giorno selezionato. Calcolato moltiplicando la lunghezza di ogni shape GTFS per il numero di trip che la usano." />
            <KpiCard icon={Clock} label="Vetture-ore / giorno" value={fmtNum(analysis.totalHoursDay)} sub="ore guida" color="text-violet-400"
              help="Ore complessive di servizio: differenza tra primo arrival_time e ultimo departure_time di ogni trip, sommata su tutti i trip del giorno. Base per il costo conducente." />
            <KpiCard icon={RouteIcon} label="Corse / giorno" value={fmtNum(analysis.totalTripsDay)} sub={`${analysis.activeRoutes} linee attive`} color="text-amber-400"
              help="Numero totale di trip in esercizio per i service-id attivi nel giorno. Una corsa = un viaggio completo capolinea→capolinea." />
            <KpiCard icon={Users} label="Pop. coperta"
              value={analysis.populationTotal > 0 ? `${(analysis.populationCovered / analysis.populationTotal * 100).toFixed(1)}%` : "—"}
              sub={`${fmtNum(analysis.populationCovered)} / ${fmtNum(analysis.populationTotal)} ab.`}
              color="text-cyan-400"
              help="Popolazione delle sezioni di censimento ISTAT entro 400 m da una fermata della selezione, divisa per la popolazione totale dell'area servita." />
          </div>

          {/* Economia */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <BigCard icon={Receipt} label="Costo / giorno" value={fmtEur(analysis.totalCostDay)} color="text-rose-400"
              help="Somma di: carburante (l/100km × €/l × km), manutenzione (€/km × km), ammortamento (€/km × km), conducente (€/h × ore). Parametri modificabili dalla sezione Parametri." />
            <BigCard icon={Coins} label="Ricavo / giorno" value={fmtEur(analysis.totalRevenueDay)} color="text-emerald-400"
              help="Stima ricavi tariffari basata sul corrispettivo €/km della categoria della linea (urbano / extraurbano / notturno) moltiplicato per i vetture-km. NON include contributi pubblici." />
            <BigCard icon={analysis.marginDay >= 0 ? TrendingUp : TrendingDown} label="Margine / giorno"
              value={fmtEur(analysis.marginDay)}
              sub={analysis.totalRevenueDay > 0 ? `${(analysis.marginDay / analysis.totalRevenueDay * 100).toFixed(1)}% sui ricavi` : ""}
              color={analysis.marginDay >= 0 ? "text-emerald-400" : "text-rose-400"}
              help="Ricavo − Costo. Margine negativo indica linee in perdita strutturale che richiedono compensazione tariffaria, contributi o revisione del programma di servizio." />
          </div>

          {/* Ridership */}
          {analysis.ridership && (
            <div className="bg-gradient-to-br from-indigo-500/10 to-purple-500/10 border border-indigo-500/30 rounded-xl p-5 space-y-3">
              <div className="flex items-center gap-2">
                <Users className="w-5 h-5 text-indigo-400" />
                <h3 className="font-semibold text-sm">Domanda potenziale stimata</h3>
                <HelpHint text="Stima passeggeri/giorno basata su gravity model: ogni fermata genera attrattività in base a popolazione residente entro 400m (sezioni ISTAT) e POI vicini (peso variabile per categoria). Da considerarsi indicativa: per validare servono dati di bigliettazione reali (AVM/AVL)." />
                <span className="text-xs text-indigo-300 bg-indigo-500/20 px-2 py-0.5 rounded-full">beta</span>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div className="bg-background/40 rounded-lg p-3">
                  <div className="text-xs text-muted-foreground">Passeggeri stimati/g</div>
                  <div className="text-2xl font-bold text-indigo-300 tabular-nums">{fmtNum(analysis.ridership.estimatedPaxDay)}</div>
                </div>
                <div className="bg-background/40 rounded-lg p-3">
                  <div className="text-xs text-muted-foreground">Ricavo / pax</div>
                  <div className="text-2xl font-bold text-emerald-400 tabular-nums">{fmtEur2(analysis.ridership.revenuePerPax)}</div>
                </div>
                <div className="bg-background/40 rounded-lg p-3">
                  <div className="text-xs text-muted-foreground">Costo / pax</div>
                  <div className="text-2xl font-bold text-rose-400 tabular-nums">{fmtEur2(analysis.ridership.costPerPax)}</div>
                </div>
                <div className="bg-background/40 rounded-lg p-3">
                  <div className="text-xs text-muted-foreground">POI considerati</div>
                  <div className="text-2xl font-bold text-amber-400 tabular-nums">{analysis.ridership.poisConsidered}</div>
                </div>
              </div>
              <p className="text-xs text-muted-foreground italic">{analysis.ridership.methodology}</p>
            </div>
          )}

          {/* Categorie breakdown */}
          {analysis.categories && analysis.categories.length > 1 && (
            <div className="bg-card/60 border border-border/40 rounded-xl p-4">
              <h3 className="font-semibold text-sm flex items-center gap-2 mb-3"><Tags className="w-4 h-4" /> Ripartizione per categoria</h3>
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2">
                {analysis.categories.map((c) => {
                  const color = CATEGORY_COLOR[c.category] || "#6b7280";
                  return (
                    <div key={c.category} className="rounded-lg p-3 border" style={{ borderColor: color + "60", background: color + "12" }}>
                      <div className="text-xs font-semibold" style={{ color }}>{DEFAULT_CATEGORIES.find((x) => x.id === c.category)?.label || c.category}</div>
                      <div className="text-xs text-muted-foreground mt-1">{c.routeCount} linee · {fmtNum(c.kmDay)} km/g</div>
                      <div className="text-sm font-bold mt-1 tabular-nums">{fmtEur(c.revenueDay)}</div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Hourly */}
          {hasHourly && (
            <div className="bg-card/60 border border-border/40 rounded-xl p-4">
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-semibold text-sm flex items-center gap-2">
                  <Clock className="w-4 h-4" /> Distribuzione oraria — totale corse
                  <HelpHint text="Numero totale di partenze per ogni ora del giorno (00-23). Picco e morbida sono utili per dimensionare turni e flotta. Considera la prima partenza di ogni trip; tabella sotto per il dettaglio linea per linea." />
                </h3>
                <span className="text-xs text-muted-foreground">picco: {Math.max(...(analysis.hourlyDistribution ?? [0]))} corse</span>
              </div>
              <div className="h-44">
                <ResponsiveContainer>
                  <BarChart data={hourlyData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                    <XAxis dataKey="hour" tick={{ fontSize: 10 }} />
                    <YAxis tick={{ fontSize: 10 }} />
                    <Tooltip contentStyle={{ background: "#1f2937", border: "none", borderRadius: 8 }} />
                    <Bar dataKey="corse" fill="#3b82f6" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {/* Hourly matrix per linea */}
          {hourly && hourly.routes.length > 0 && (
            <HourlyMatrix hourly={hourly} />
          )}

          {/* MAPPA — Mobility Insights */}
          {showMap && MAPBOX_TOKEN && analysis.bbox && (
            <div className="bg-card/60 border border-border/40 rounded-xl overflow-hidden">
              <div className="px-4 py-3 border-b border-border/40 flex items-center justify-between flex-wrap gap-2">
                <h3 className="font-semibold text-sm flex items-center gap-2">
                  <MapIcon className="w-4 h-4" /> Mappa rete + flussi pendolari
                  <HelpHint text="Tre layer sovrapponibili: (1) Rete = tracciati delle linee selezionate, ognuna con colore univoco; (2) Flussi pendolari ISTAT = archi origine→destinazione tra comuni, spessore proporzionale al numero di persone; (3) POI = punti di interesse Google Places attrattori di domanda. Usa il toggle vista per isolare un layer." />
                </h3>
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-muted-foreground">Vista:</span>
                  {(["both","network","mobility"] as const).map((m) => (
                    <button key={m} onClick={() => setMapMode(m)} className={`px-2 py-1 rounded ${mapMode===m ? "bg-primary text-primary-foreground" : "bg-muted/40 hover:bg-muted"}`}>
                      {m === "both" ? "Tutto" : m === "network" ? "Rete" : "Mobility"}
                    </button>
                  ))}
                  <button onClick={() => setShowMap(false)} className="ml-2 text-muted-foreground hover:text-foreground underline">nascondi</button>
                </div>
              </div>

              {/* Mobility controls */}
              {(mapMode === "both" || mapMode === "mobility") && (
                <div className="px-4 py-2 border-b border-border/40 bg-muted/20 flex items-center gap-3 flex-wrap text-xs">
                  <span className="text-muted-foreground inline-flex items-center gap-1">
                    Flussi O/D ISTAT
                    <HelpHint text="Matrice Origine/Destinazione del Censimento ISTAT 2011: per ogni coppia di comuni mostra quante persone si spostano abitualmente per lavoro o studio. Filtra per motivo (lavoro/studio), per mezzo dichiarato (bus urbano/extraurbano) e soglia minima. Aiuta a capire se la rete bus copre i flussi reali di pendolarismo." />
                  </span>
                  <div className="flex items-center gap-1">
                    <span className="text-muted-foreground">Motivo:</span>
                    {[["all","Tutti"],["work","Lavoro"],["study","Studio"]].map(([v,l]) => (
                      <button key={v} onClick={() => setFlowReason(v)} className={`px-2 py-0.5 rounded ${flowReason===v ? "bg-primary text-primary-foreground" : "bg-muted/40 hover:bg-muted"}`}>{l}</button>
                    ))}
                  </div>
                  <div className="flex items-center gap-1">
                    <span className="text-muted-foreground">Mezzo:</span>
                    {[["all","Tutti"],["bus_urban","Bus urbano"],["bus_extraurban","Bus extra"]].map(([v,l]) => (
                      <button key={v} onClick={() => setFlowMode(v)} className={`px-2 py-0.5 rounded ${flowMode===v ? "bg-primary text-primary-foreground" : "bg-muted/40 hover:bg-muted"}`}>{l}</button>
                    ))}
                  </div>
                  <div className="flex items-center gap-1">
                    <span className="text-muted-foreground">Min flusso:</span>
                    <input type="number" value={flowMin} onChange={(e) => setFlowMin(Number(e.target.value)||0)}
                      className="w-16 px-1.5 py-0.5 border border-border rounded bg-background text-xs" />
                  </div>
                  <span className="ml-auto inline-flex items-center gap-2">
                    {flowSource === "synthetic" && (
                      <span className="px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 text-[10px] font-semibold uppercase tracking-wider" title={flowNote}>
                        sintetico
                      </span>
                    )}
                    {flowSource === "istat" && flows.length > 0 && (
                      <span className="px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 text-[10px] font-semibold uppercase tracking-wider">
                        ISTAT
                      </span>
                    )}
                    <span className="text-muted-foreground">{flows.length} archi · {fmtNum(flows.reduce((s,f)=>s+f.flow,0))} pers.</span>
                  </span>
                </div>
              )}

              {/* POI catalog selector */}
              {(mapMode === "both" || mapMode === "mobility") && catalogCategories.length > 0 && (
                <div className="px-4 py-2 border-b border-border/40 bg-muted/10 flex items-center gap-2 flex-wrap">
                  <span className="text-xs text-muted-foreground flex items-center gap-1">
                    <Target className="w-3 h-3" /> POI
                    <HelpHint text="Punti di Interesse acquisiti tramite Google Places API per il bbox della rete: scuole, ospedali, centri commerciali, stazioni, ecc. Spuntare una categoria mostra i POI in mappa e li include nel modello di stima passeggeri (gravity model: domanda ∝ vicinanza alla fermata × peso categoria)." />
                    :
                  </span>
                  {catalogCategories.map((c) => {
                    const meta = POI_CATALOG_META[c.category] || { label: c.category, Icon: MapPin, color: "#888" };
                    const on = selectedPoiCats.has(c.category);
                    return (
                      <button key={c.category} onClick={() => {
                        const n = new Set(selectedPoiCats);
                        if (on) n.delete(c.category); else n.add(c.category);
                        setSelectedPoiCats(n);
                      }} className={`px-2 py-0.5 rounded text-xs border transition inline-flex items-center gap-1 ${on ? "text-white" : "text-muted-foreground"}`}
                        style={{ borderColor: meta.color, background: on ? meta.color : "transparent" }}>
                        <meta.Icon className="w-3 h-3" />
                        {meta.label} ({c.count})
                      </button>
                    );
                  })}
                  {selectedPoiCats.size > 0 && (
                    <button onClick={() => setSelectedPoiCats(new Set())} className="text-xs text-muted-foreground hover:text-foreground underline ml-1">reset</button>
                  )}
                </div>
              )}

              <div className="h-[600px] relative">
                <MapGL
                  ref={mapRef}
                  mapboxAccessToken={MAPBOX_TOKEN}
                  initialViewState={{
                    longitude: (analysis.bbox.minLon + analysis.bbox.maxLon) / 2,
                    latitude:  (analysis.bbox.minLat + analysis.bbox.maxLat) / 2,
                    zoom: 10,
                  }}
                  style={{ width: "100%", height: "100%" }}
                  mapStyle="mapbox://styles/mapbox/dark-v11"
                  attributionControl={false}
                  interactiveLayerIds={shapes ? ["shapes-line", "shapes-line-hit"] : []}
                  cursor={hoveredRouteId ? "pointer" : "grab"}
                  onMouseMove={(e) => {
                    const f = e.features?.[0];
                    const rid = f?.properties?.routeId as string | undefined;
                    setHoveredRouteId(rid ?? null);
                  }}
                  onMouseLeave={() => setHoveredRouteId(null)}
                  onClick={(e) => {
                    const f = e.features?.[0];
                    const rid = f?.properties?.routeId as string | undefined;
                    if (!rid) return;
                    const next = new Set(selectedRouteIds);
                    if (next.has(rid)) next.delete(rid); else next.add(rid);
                    setSelectedRouteIds(next);
                  }}
                >
                  {/* Mobility flows (archi O/D) */}
                  {(mapMode === "both" || mapMode === "mobility") && flowsGeoJson && (
                    <Source id="flows" type="geojson" data={flowsGeoJson as any}>
                      <Layer
                        id="flows-line"
                        type="line"
                        paint={{
                          "line-color": [
                            "interpolate", ["linear"], ["get","normFlow"],
                            0,   "#1e3a8a",
                            0.3, "#7c3aed",
                            0.6, "#ec4899",
                            1.0, "#fbbf24",
                          ],
                          "line-width": ["interpolate", ["linear"], ["get","normFlow"], 0, 1, 1, 6],
                          "line-opacity": 0.65,
                          "line-blur": 0.5,
                        }}
                        layout={{ "line-cap": "round", "line-join": "round" }}
                      />
                    </Source>
                  )}

                  {/* Shapes linee */}
                  {(mapMode === "both" || mapMode === "network") && shapes && (
                    <Source id="shapes" type="geojson" data={shapes}>
                      {/* hit-area trasparente più larga per facilitare hover/click */}
                      <Layer
                        id="shapes-line-hit"
                        type="line"
                        paint={{ "line-color": "#000", "line-width": 14, "line-opacity": 0 }}
                        layout={{ "line-cap": "round", "line-join": "round" }}
                      />
                      <Layer
                        id="shapes-line"
                        type="line"
                        paint={{
                          "line-color": ["coalesce", ["get","lineColor"], "#3b82f6"],
                          "line-width": [
                            "case",
                            ["==", ["get","routeId"], hoveredRouteId ?? ""], 6,
                            ["interpolate", ["linear"], ["zoom"], 9, 1.8, 13, 4],
                          ],
                          "line-opacity": [
                            "case",
                            ["==", ["get","routeId"], hoveredRouteId ?? ""], 1,
                            selectedRouteIds.size > 0,
                              ["case", ["in", ["get","routeId"], ["literal", Array.from(selectedRouteIds)]], 1, 0.25],
                              0.92,
                          ],
                        }}
                        layout={{ "line-cap": "round", "line-join": "round" }}
                      />
                    </Source>
                  )}

                  {/* POI catalog markers */}
                  {(mapMode === "both" || mapMode === "mobility") && visiblePois.map((p) => {
                    const meta = POI_CATALOG_META[p.category] || { label: p.category, Icon: MapPin, color: "#888" };
                    return (
                      <Marker key={p.id} longitude={p.lng} latitude={p.lat} anchor="center">
                        <div title={`${p.name ?? "(senza nome)"} — ${meta.label}`}
                          className="rounded-full p-1 shadow-md ring-1 ring-black/40 cursor-pointer"
                          style={{ background: meta.color }}>
                          <meta.Icon className="w-3 h-3 text-white" strokeWidth={2.5} />
                        </div>
                      </Marker>
                    );
                  })}

                  {/* Top stops */}
                  {topStops.slice(0,15).map((s) => (
                    <Marker key={s.stopId} longitude={s.lon} latitude={s.lat} anchor="center">
                      <div title={`${s.stopName} — ${s.trips} passaggi`} className="w-2 h-2 rounded-full bg-amber-300 ring-2 ring-amber-200/40" />
                    </Marker>
                  ))}
                </MapGL>

                {/* Legenda */}
                <div className="absolute bottom-3 left-3 bg-background/95 backdrop-blur rounded-lg p-2 text-[10px] space-y-1 border border-border/40 max-w-[280px]">
                  <div className="font-semibold mb-1">Legenda</div>
                  {(mapMode === "both" || mapMode === "mobility") && flows.length > 0 && (
                    <div className="flex items-center gap-1.5">
                      <div className="w-16 h-1 rounded" style={{ background: "linear-gradient(90deg, #1e3a8a, #7c3aed, #ec4899, #fbbf24)" }} />
                      <span>flussi pendolari (debole → forte)</span>
                    </div>
                  )}
                  {(mapMode === "both" || mapMode === "network") && shapes && (
                    <div className="text-muted-foreground">
                      Click su una linea per <strong>filtrarla</strong>, hover per evidenziarla
                    </div>
                  )}
                  {visiblePois.length > 0 && (
                    <div className="flex items-center gap-1.5"><MapPin className="w-3 h-3" /><span>{visiblePois.length} POI visibili</span></div>
                  )}
                  {flowSource === "synthetic" && (
                    <div className="text-amber-300/80 border-t border-border/40 pt-1 mt-1">
                      <strong>Flussi stimati</strong> (gravity model census→POI)
                    </div>
                  )}
                </div>

                {/* Tooltip linea hovered */}
                {hoveredRouteId && (() => {
                  const r = routes.find((x) => x.routeId === hoveredRouteId);
                  if (!r) return null;
                  return (
                    <div className="absolute top-3 right-3 bg-background/95 backdrop-blur rounded-lg p-2 text-xs border border-border/40 max-w-[260px] pointer-events-none">
                      <div className="flex items-center gap-2">
                        <span className="inline-block w-3 h-3 rounded-sm" style={{ background: colorForRoute(r.routeId, r.color) }} />
                        <strong>{r.shortName || r.routeId}</strong>
                      </div>
                      <div className="text-muted-foreground text-[11px] mt-0.5">{r.longName}</div>
                      <div className="text-[10px] text-primary mt-1">click per {selectedRouteIds.has(r.routeId) ? "deselezionare" : "filtrare"}</div>
                    </div>
                  );
                })()}

                {/* Hint quando non c'è nulla */}
                {(mapMode === "mobility" && flows.length === 0 && visiblePois.length === 0) && (
                  <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-background/90 backdrop-blur rounded-lg p-4 text-center text-sm border border-border max-w-md">
                    <Sparkles className="w-6 h-6 text-indigo-400 mx-auto mb-2" />
                    <p className="font-semibold mb-1">Nessun flusso/POI da mostrare</p>
                    <p className="text-xs text-muted-foreground">Spunta categorie POI sopra o scegli un <strong>scenario di domanda</strong> in alto per vedere dove si muove la gente.</p>
                  </div>
                )}
              </div>
            </div>
          )}
          {!MAPBOX_TOKEN && (
            <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4 text-amber-300 text-sm">
              ⚠️ Mappa non disponibile: <code>VITE_MAPBOX_TOKEN</code> non configurato.
            </div>
          )}

          {/* Top fermate */}
          {topStops.length > 0 && (
            <div className="bg-card/60 border border-border/40 rounded-xl overflow-hidden">
              <div className="px-4 py-3 border-b border-border/40 flex items-center gap-2">
                <MapPin className="w-4 h-4" /> <h3 className="font-semibold text-sm">Top 20 fermate per passaggi</h3>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="bg-muted/30 text-muted-foreground">
                    <tr><th className="text-left px-3 py-2">#</th><th className="text-left px-3 py-2">Fermata</th><th className="text-right px-3 py-2">Passaggi/g</th></tr>
                  </thead>
                  <tbody>
                    {topStops.map((s, i) => (
                      <tr key={s.stopId} className="border-t border-border/20 hover:bg-muted/20">
                        <td className="px-3 py-1.5 text-muted-foreground tabular-nums">{i + 1}</td>
                        <td className="px-3 py-1.5">{s.stopName}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums font-semibold">{fmtNum(s.trips)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Tabella linee */}
          <div className="bg-card/60 border border-border/40 rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-border/40 flex items-center justify-between">
              <h3 className="font-semibold text-sm flex items-center gap-2"><Layers className="w-4 h-4" /> Performance per linea</h3>
              <span className="text-xs text-muted-foreground">{analysis.perRoute.length} linee</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-muted/30 text-muted-foreground">
                  <tr>
                    <th className="text-left px-3 py-2">Linea</th>
                    <th className="text-left px-3 py-2">Categoria</th>
                    <th className="text-right px-3 py-2">Km/g</th>
                    <th className="text-right px-3 py-2">Corse</th>
                    <th className="text-right px-3 py-2">Pax/g</th>
                    <th className="text-right px-3 py-2">Costo</th>
                    <th className="text-right px-3 py-2">Ricavo</th>
                    <th className="text-right px-3 py-2">Margine</th>
                  </tr>
                </thead>
                <tbody>
                  {analysis.perRoute.slice(0, 100).map((r) => {
                    const catColor = r.category ? CATEGORY_COLOR[r.category] : null;
                    const lineColor = colorForRoute(r.routeId, r.color);
                    return (
                      <tr key={r.routeId} className="border-t border-border/20 hover:bg-muted/20">
                        <td className="px-3 py-2 font-medium">
                          <div className="flex items-center gap-2">
                            <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: lineColor }} />
                            <span>{r.shortName || r.routeId}</span>
                            <span className="text-muted-foreground truncate max-w-[200px]">{r.longName}</span>
                          </div>
                        </td>
                        <td className="px-3 py-2">
                          {r.category ? (
                            <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold" style={{ background: (catColor||"#888")+"22", color: catColor||"#888" }}>
                              {DEFAULT_CATEGORIES.find((x) => x.id === r.category)?.label || r.category}
                            </span>
                          ) : <span className="text-muted-foreground italic text-[10px]">—</span>}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">{fmtNum(r.kmDay)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{r.tripsDay}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-indigo-300">{fmtNum(r.estimatedPaxDay)}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-rose-400">{fmtEur(r.costTotalDay)}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-emerald-400">{fmtEur(r.revenueDay)}</td>
                        <td className={`px-3 py-2 text-right tabular-nums font-semibold ${r.marginDay >= 0 ? "text-emerald-400" : "text-rose-400"}`}>{fmtEur(r.marginDay)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {analysis.perRoute.length > 100 && (
              <div className="px-4 py-2 text-xs text-muted-foreground text-center border-t border-border/40">Mostrate 100 di {analysis.perRoute.length} · il PDF le include tutte</div>
            )}
          </div>

          {(analysis.anomalies.tripsWithoutShape > 0 || analysis.anomalies.stopsOrphan > 0 || analysis.anomalies.routesWithoutTrips > 0) && (
            <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4 text-amber-300 text-sm">
              <div className="font-semibold mb-1 flex items-center gap-2"><AlertTriangle className="w-4 h-4" /> Anomalie</div>
              <ul className="text-xs space-y-0.5 ml-6 list-disc">
                {analysis.anomalies.tripsWithoutShape > 0 && <li>{fmtNum(analysis.anomalies.tripsWithoutShape)} trip senza shape</li>}
                {analysis.anomalies.stopsOrphan > 0 && <li>{fmtNum(analysis.anomalies.stopsOrphan)} fermate orfane</li>}
                {analysis.anomalies.routesWithoutTrips > 0 && <li>{fmtNum(analysis.anomalies.routesWithoutTrips)} linee senza corse</li>}
              </ul>
            </div>
          )}
        </>
      )}

      {/* Modale classificazioni */}
      {showClassifier && (
        <ClassifierModal
          routes={routes}
          classifications={classifications}
          onClose={() => setShowClassifier(false)}
          onSave={async (items) => { await bulkUpdateClassifications(items); }}
        />
      )}
    </div>
  );
}

/* ──────────────────────────── helpers ──────────────────────────── */

function getAllowedRouteIds(
  routes: RouteOpt[],
  classifications: RouteClassification[],
  selectedRouteIds: Set<string>,
  selectedCategories: Set<string>,
): Set<string> | null {
  if (selectedRouteIds.size === 0 && selectedCategories.size === 0) return null;
  let list = routes;
  if (selectedCategories.size > 0) {
    const catByRoute = new Map(classifications.map((c) => [c.routeId, c.category]));
    list = list.filter((r) => {
      const cat = catByRoute.get(r.routeId);
      return cat && selectedCategories.has(cat);
    });
  }
  if (selectedRouteIds.size > 0) {
    list = list.filter((r) => selectedRouteIds.has(r.routeId));
  }
  return new Set(list.map((r) => r.routeId));
}

function FilterStep({ n, title, badge, help, children }: { n: number; title: string; badge?: string; help?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-xs">
        <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-primary text-primary-foreground font-bold">{n}</span>
        <span className="font-semibold">{title}</span>
        {help && <HelpHint text={help} />}
        {badge && <span className="text-muted-foreground">· {badge}</span>}
      </div>
      <div className="ml-7">{children}</div>
    </div>
  );
}

/**
 * Tooltip "?" enterprise-style. Spiega che analisi viene fatta in ogni step.
 */
function HelpHint({ text }: { text: string }) {
  return (
    <span className="relative inline-flex items-center group">
      <button
        type="button"
        tabIndex={0}
        aria-label="Aiuto"
        className="text-muted-foreground/70 hover:text-primary focus:text-primary focus:outline-none"
      >
        <HelpCircle className="w-3.5 h-3.5" />
      </button>
      <span
        role="tooltip"
        className="invisible opacity-0 group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100 transition pointer-events-none absolute left-5 top-1/2 -translate-y-1/2 z-30 w-72 max-w-[80vw] bg-popover border border-border rounded-md shadow-xl px-3 py-2 text-[11px] text-foreground/90 leading-relaxed"
      >
        {text}
      </span>
    </span>
  );
}

function NumField({ label, value, step, onChange }: { label: string; value: number; step?: number; onChange: (v: number) => void }) {
  return (
    <label className="block">
      <span className="block text-xs text-muted-foreground mb-1">{label}</span>
      <input type="number" step={step ?? 1} value={value} onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
        className="w-full px-2 py-1.5 text-sm border border-border rounded-md bg-background tabular-nums" />
    </label>
  );
}

function KpiCard({ icon: Icon, label, value, sub, color, help }: { icon: any; label: string; value: string; sub?: string; color?: string; help?: string }) {
  return (
    <div className="bg-card/60 border border-border/40 rounded-xl p-4">
      <div className="flex items-center gap-2 mb-2">
        <Icon className={`w-4 h-4 ${color || ""}`} />
        <span className="text-xs text-muted-foreground">{label}</span>
        {help && <HelpHint text={help} />}
      </div>
      <div className={`text-xl font-bold tabular-nums ${color || ""}`}>{value}</div>
      {sub && <div className="text-xs text-muted-foreground mt-0.5">{sub}</div>}
    </div>
  );
}

function BigCard({ icon: Icon, label, value, sub, color, help }: { icon: any; label: string; value: string; sub?: string; color?: string; help?: string }) {
  return (
    <div className="bg-card/60 border border-border/40 rounded-xl p-5">
      <div className="flex items-center gap-2 mb-2">
        <Icon className={`w-5 h-5 ${color || ""}`} />
        <span className="text-sm text-muted-foreground">{label}</span>
        {help && <HelpHint text={help} />}
      </div>
      <div className={`text-3xl font-bold tabular-nums ${color || ""}`}>{value}</div>
      {sub && <div className="text-xs text-muted-foreground mt-1">{sub}</div>}
    </div>
  );
}

function formatPickedDate(d: string): string {
  if (!d || d.length !== 8) return d;
  return `${d.slice(6, 8)}/${d.slice(4, 6)}/${d.slice(0, 4)}`;
}

/* ──────────────────────────── Hourly matrix per linea ──────────────────────────── */

function HourlyMatrix({ hourly }: { hourly: { hours: number[]; routes: HourlyRoute[] } }) {
  // Trova il max globale per scala colore
  const maxCell = useMemo(() => {
    let m = 0;
    for (const r of hourly.routes) for (const v of r.perHour) if (v > m) m = v;
    return m || 1;
  }, [hourly]);
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? hourly.routes : hourly.routes.slice(0, 25);

  // Totale per ora (somma colonna)
  const colTotals = useMemo(() => {
    const t = Array(24).fill(0);
    for (const r of hourly.routes) for (let h = 0; h < 24; h++) t[h] += r.perHour[h] || 0;
    return t;
  }, [hourly]);
  const peakHour = colTotals.indexOf(Math.max(...colTotals));

  function cellColor(v: number): string {
    if (!v) return "transparent";
    const p = v / maxCell;
    // gradient verde→giallo→rosso
    const hue = 120 - p * 120;
    return `hsl(${hue} 70% 45% / ${0.25 + 0.65 * p})`;
  }

  return (
    <div className="bg-card/60 border border-border/40 rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-border/40 flex items-center justify-between flex-wrap gap-2">
        <h3 className="font-semibold text-sm flex items-center gap-2">
          <Clock className="w-4 h-4" /> Programma di servizio — partenze ora × linea
          <HelpHint text="Per ogni linea selezionata, conta quante corse partono in ciascuna ora del giorno scelto. Il colore (verde→rosso) indica intensità rispetto al picco assoluto. Utile per identificare buchi di servizio, picchi mattino/sera e linee sotto-utilizzate." />
        </h3>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span>picco: <strong className="text-foreground">{peakHour}:00</strong> ({colTotals[peakHour]} corse)</span>
          <span>{hourly.routes.length} linee</span>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="text-[10px] tabular-nums w-full">
          <thead className="sticky top-0 bg-muted/40 backdrop-blur z-10">
            <tr>
              <th className="text-left px-2 py-1 font-semibold sticky left-0 bg-muted/60 min-w-[100px]">Linea</th>
              {hourly.hours.map((h) => (
                <th key={h} className={`px-1 py-1 text-center font-medium ${h === peakHour ? "text-amber-300" : "text-muted-foreground"}`} style={{ minWidth: 22 }}>
                  {h}
                </th>
              ))}
              <th className="px-2 py-1 text-right font-semibold text-foreground sticky right-0 bg-muted/60">Tot</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => {
              const lineColor = colorForRoute(r.routeId, r.color);
              return (
                <tr key={r.routeId} className="border-t border-border/10 hover:bg-muted/10">
                  <td className="px-2 py-1 sticky left-0 bg-card/80 z-[1]">
                    <div className="flex items-center gap-1.5 max-w-[150px]">
                      <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: lineColor }} />
                      <span className="font-semibold shrink-0">{r.shortName || r.routeId}</span>
                      <span className="text-muted-foreground truncate text-[9px]">{r.longName}</span>
                    </div>
                  </td>
                  {r.perHour.map((v, h) => (
                    <td key={h} className="text-center" style={{ background: cellColor(v) }} title={`Ore ${h}:00 — ${v} partenze`}>
                      {v || ""}
                    </td>
                  ))}
                  <td className="px-2 py-1 text-right font-semibold sticky right-0 bg-card/80">{r.total}</td>
                </tr>
              );
            })}
            <tr className="border-t-2 border-border bg-muted/30 font-semibold">
              <td className="px-2 py-1 sticky left-0 bg-muted/40">TOTALE</td>
              {colTotals.map((v, h) => (
                <td key={h} className="text-center" style={{ background: cellColor(v) }}>{v || ""}</td>
              ))}
              <td className="px-2 py-1 text-right sticky right-0 bg-muted/40">{colTotals.reduce((s,v)=>s+v, 0)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      {hourly.routes.length > 25 && (
        <div className="px-4 py-2 border-t border-border/40 text-center">
          <button onClick={() => setShowAll(!showAll)} className="text-xs text-primary hover:underline">
            {showAll ? "Mostra solo top 25" : `Mostra tutte le ${hourly.routes.length} linee`}
          </button>
        </div>
      )}
    </div>
  );
}

/* ──────────────────────────── Classifier modal ──────────────────────────── */

function ClassifierModal({
  routes, classifications, onClose, onSave,
}: {
  routes: RouteOpt[];
  classifications: RouteClassification[];
  onClose: () => void;
  onSave: (items: { routeId: string; category: string; fareType: string | null }[]) => Promise<void>;
}) {
  const [local, setLocal] = useState<Map<string, string>>(() =>
    new Map(classifications.map((c) => [c.routeId, c.category]))
  );
  const [search, setSearch] = useState("");
  const [bulkCat, setBulkCat] = useState<string>("urbano-ancona");
  const [saving, setSaving] = useState(false);

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    if (!q) return routes;
    return routes.filter((r) =>
      (r.shortName ?? "").toLowerCase().includes(q) ||
      (r.longName ?? "").toLowerCase().includes(q) ||
      r.routeId.toLowerCase().includes(q)
    );
  }, [routes, search]);

  async function handleSave() {
    setSaving(true);
    try {
      const items = Array.from(local.entries()).map(([routeId, category]) => {
        const fareType = DEFAULT_CATEGORIES.find((c) => c.id === category)?.fareType ?? null;
        return { routeId, category, fareType };
      });
      await onSave(items);
      onClose();
    } finally { setSaving(false); }
  }

  function setBulkFiltered() {
    const n = new Map(local);
    for (const r of filtered) n.set(r.routeId, bulkCat);
    setLocal(n);
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-card border border-border rounded-xl shadow-2xl w-full max-w-4xl max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="p-4 border-b border-border flex items-center justify-between">
          <h3 className="font-semibold flex items-center gap-2"><Tags className="w-4 h-4" /> Classifica linee</h3>
          <button onClick={onClose}><X className="w-5 h-5" /></button>
        </div>
        <div className="p-4 border-b border-border space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            <input type="text" placeholder="Cerca linea…" value={search} onChange={(e) => setSearch(e.target.value)}
              className="flex-1 min-w-[200px] px-3 py-1.5 text-sm border border-border rounded bg-background" />
            <select value={bulkCat} onChange={(e) => setBulkCat(e.target.value)} className="px-2 py-1.5 text-xs border border-border rounded bg-background">
              {DEFAULT_CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
            <button onClick={setBulkFiltered} className="px-3 py-1.5 text-xs rounded border border-border hover:bg-muted">
              Applica a {filtered.length} linee filtrate
            </button>
          </div>
          <p className="text-xs text-muted-foreground">
            La categoria determina il corrispettivo €/km (urbano / extraurbano / notturno).
          </p>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {filtered.map((r) => {
              const cat = local.get(r.routeId) || "";
              const color = cat ? CATEGORY_COLOR[cat] : null;
              return (
                <div key={r.routeId} className="flex items-center gap-2 p-2 rounded border border-border/40 text-xs">
                  {color && <span className="w-2 h-8 rounded-sm shrink-0" style={{ background: color }} />}
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold">{r.shortName || r.routeId}</div>
                    <div className="text-muted-foreground truncate">{r.longName}</div>
                  </div>
                  <select value={cat} onChange={(e) => {
                    const n = new Map(local);
                    if (e.target.value) n.set(r.routeId, e.target.value); else n.delete(r.routeId);
                    setLocal(n);
                  }} className="px-2 py-1 text-xs border border-border rounded bg-background">
                    <option value="">—</option>
                    {DEFAULT_CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                  </select>
                </div>
              );
            })}
          </div>
        </div>
        <div className="p-4 border-t border-border flex items-center justify-between">
          <span className="text-xs text-muted-foreground">{local.size} / {routes.length} classificate</span>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-3 py-1.5 text-sm rounded border border-border hover:bg-muted">Annulla</button>
            <button onClick={handleSave} disabled={saving} className="px-4 py-1.5 text-sm rounded bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50 inline-flex items-center gap-2">
              {saving && <Loader2 className="w-4 h-4 animate-spin" />} Salva
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ──────────────────────────── PDF report ──────────────────────────── */

function buildReportHtml(a: Analysis, p: EconParams | null, dayType: DayType): string {
  const today = new Date().toLocaleDateString("it-IT", { day: "2-digit", month: "long", year: "numeric" });
  const eur = (n: number) => new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(n);
  const num = (n: number, d = 0) => new Intl.NumberFormat("it-IT", { maximumFractionDigits: d }).format(n);
  const pct = a.populationTotal > 0 ? (a.populationCovered / a.populationTotal * 100) : 0;
  const hourly = a.hourlyDistribution ?? [];
  const topStops = a.topStops ?? [];
  const filters = a.filters ?? { dayType, routeIds: null, pickedDate: null, serviceIdsCount: 0, serviceDate: null, categoryFilter: null };
  const maxHourly = Math.max(...hourly, 1);

  return `<!DOCTYPE html><html lang="it"><head>
<meta charset="utf-8"><title>Report Pianificazione — TransitIntel</title>
<style>
  @page { size: A4; margin: 16mm 14mm; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #111827; font-size: 11px; line-height: 1.5; margin: 0; padding: 24px; }
  h1 { font-size: 22px; margin: 0 0 4px; color: #0f172a; }
  h2 { font-size: 14px; margin: 24px 0 8px; padding: 6px 10px; background: #0f172a; color: #fff; border-radius: 4px; }
  .subtitle { color: #6b7280; font-size: 11px; margin-bottom: 18px; }
  .kpi-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin: 8px 0; }
  .kpi { border: 1px solid #e5e7eb; border-radius: 6px; padding: 10px; }
  .kpi .label { font-size: 9px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.04em; }
  .kpi .val { font-size: 18px; font-weight: 700; margin-top: 2px; color: #0f172a; }
  .kpi .sub { font-size: 9px; color: #9ca3af; margin-top: 2px; }
  .kpi.good .val { color: #059669; } .kpi.bad .val { color: #dc2626; }
  .kpi.pax { background: linear-gradient(135deg, #eef2ff, #f5f3ff); border-color: #c7d2fe; }
  .kpi.pax .val { color: #4338ca; }
  table { width: 100%; border-collapse: collapse; font-size: 10px; margin-top: 6px; }
  th, td { padding: 5px 7px; text-align: left; border-bottom: 1px solid #e5e7eb; }
  th { background: #f3f4f6; font-weight: 600; color: #374151; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  .pos { color: #059669; font-weight: 600; } .neg { color: #dc2626; font-weight: 600; }
  .footer { margin-top: 32px; padding-top: 12px; border-top: 1px solid #e5e7eb; text-align: center; color: #9ca3af; font-size: 9px; }
  .hourly-bar { display: flex; align-items: flex-end; height: 80px; gap: 2px; margin-top: 6px; padding: 0 4px; border-bottom: 1px solid #e5e7eb; }
  .hourly-bar .b { flex: 1; background: #3b82f6; border-radius: 2px 2px 0 0; min-height: 1px; position: relative; }
  .hourly-bar .b .lab { position: absolute; bottom: -14px; left: 50%; transform: translateX(-50%); font-size: 7px; color: #6b7280; }
  @media print { body { padding: 0; } h2, .kpi, th { -webkit-print-color-adjust: exact; print-color-adjust: exact; } tr { page-break-inside: avoid; } }
</style></head><body>
  <h1>📊 Report Pianificazione & Mobility Insights</h1>
  <div class="subtitle">
    Generato il <strong>${today}</strong>
    · ${filters.serviceDate ? `Data: <strong>${formatPickedDate(filters.serviceDate)}</strong>` : `Giorno: <strong>${({weekday:"Feriale",saturday:"Sabato",sunday:"Festivo",all:"Tutti"}[filters.dayType]||"Feriale")}</strong>`}
    · ${filters.routeIds ? `${filters.routeIds.length} linee` : "tutte le linee"}
    ${filters.categoryFilter ? ` · ${filters.categoryFilter.join(", ")}` : ""}
  </div>

  <h2>1 · KPI di servizio</h2>
  <div class="kpi-grid">
    <div class="kpi"><div class="label">Vetture-km / g</div><div class="val">${num(a.totalKmDay)}</div></div>
    <div class="kpi"><div class="label">Vetture-ore / g</div><div class="val">${num(a.totalHoursDay)}</div></div>
    <div class="kpi"><div class="label">Corse / g</div><div class="val">${num(a.totalTripsDay)}</div><div class="sub">${a.activeRoutes} linee</div></div>
    <div class="kpi"><div class="label">Pop. coperta</div><div class="val">${pct.toFixed(1)}%</div><div class="sub">${num(a.populationCovered)} ab.</div></div>
  </div>

  <h2>2 · Modello economico</h2>
  <div class="kpi-grid" style="grid-template-columns: repeat(3, 1fr);">
    <div class="kpi bad"><div class="label">Costo / g</div><div class="val">${eur(a.totalCostDay)}</div></div>
    <div class="kpi good"><div class="label">Ricavo / g</div><div class="val">${eur(a.totalRevenueDay)}</div></div>
    <div class="kpi ${a.marginDay >= 0 ? "good" : "bad"}"><div class="label">Margine / g</div><div class="val">${eur(a.marginDay)}</div></div>
  </div>

  ${a.ridership ? `
  <h2>3 · Domanda potenziale</h2>
  <div class="kpi-grid">
    <div class="kpi pax"><div class="label">Pax / g stimati</div><div class="val">${num(a.ridership.estimatedPaxDay)}</div></div>
    <div class="kpi"><div class="label">Ricavo / pax</div><div class="val good">${num(a.ridership.revenuePerPax, 2)} €</div></div>
    <div class="kpi"><div class="label">Costo / pax</div><div class="val bad">${num(a.ridership.costPerPax, 2)} €</div></div>
    <div class="kpi"><div class="label">POI considerati</div><div class="val">${a.ridership.poisConsidered}</div></div>
  </div>
  <p style="font-size:9px;color:#6b7280;font-style:italic">${escapeHtml(a.ridership.methodology)}</p>
  ` : ""}

  ${hourly.length > 0 ? `
  <h2>4 · Distribuzione oraria</h2>
  <div class="hourly-bar">
    ${hourly.map((v, h) => `<div class="b" style="height:${(v/maxHourly*100).toFixed(1)}%"><span class="lab">${h}</span></div>`).join("")}
  </div>
  <div style="font-size:9px;color:#6b7280;margin-top:18px">Picco: ${maxHourly} corse · totale ${num(a.totalTripsDay)} corse/g</div>
  ` : ""}

  ${topStops.length > 0 ? `
  <h2>5 · Top 20 fermate</h2>
  <table><thead><tr><th>#</th><th>Fermata</th><th class="num">Passaggi/g</th></tr></thead><tbody>
    ${topStops.map((s, i) => `<tr><td>${i+1}</td><td>${escapeHtml(s.stopName)}</td><td class="num">${num(s.trips)}</td></tr>`).join("")}
  </tbody></table>
  ` : ""}

  <h2>6 · Performance per linea (${a.perRoute.length})</h2>
  <table><thead><tr>
    <th>Linea</th><th>Categoria</th><th class="num">Km/g</th><th class="num">Corse</th>
    <th class="num">Pax/g</th><th class="num">Costo</th><th class="num">Ricavo</th><th class="num">Margine</th>
  </tr></thead><tbody>
    ${a.perRoute.map((r) => `<tr>
      <td><strong>${escapeHtml(r.shortName || r.routeId)}</strong> <span style="color:#6b7280">${escapeHtml(r.longName ?? "")}</span></td>
      <td>${r.category ? escapeHtml(r.category) : `<span style="color:#9ca3af">${r.serviceType}</span>`}</td>
      <td class="num">${num(r.kmDay)}</td>
      <td class="num">${r.tripsDay}</td>
      <td class="num">${num(r.estimatedPaxDay)}</td>
      <td class="num">${eur(r.costTotalDay)}</td>
      <td class="num">${eur(r.revenueDay)}</td>
      <td class="num ${r.marginDay >= 0 ? "pos" : "neg"}">${eur(r.marginDay)}</td>
    </tr>`).join("")}
  </tbody></table>

  <div class="footer">Generato da <strong>TransitIntel · PlannerStudio v4</strong> · ${today}<br>API ${getApiBase() || "/"}</div>
  <script>window.addEventListener("load", () => setTimeout(() => window.print(), 500));</script>
</body></html>`;
}

function escapeHtml(s: string | null | undefined): string {
  if (s == null) return "";
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
