/**
 * ServiceCoverageTab v2 — KPI di soddisfazione del servizio per giorno/stagione.
 *
 * Risponde alle 3 domande chiave:
 *   1) Quanto costa il servizio (collegamento con /analyze)
 *   2) Soddisfa la domanda (coverage popolazione + POI pesati per giorno)
 *   3) Quali interventi posso fare (suggestions engine server-side)
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Loader2, AlertTriangle, Target, Bus, MapPin,
  Hospital, GraduationCap, ShoppingBag, Factory, Activity, Building2,
  TrainFront, Briefcase, Church, HeartHandshake, ParkingSquare, Camera,
  CalendarDays, Footprints, RefreshCw, Sun, Snowflake, Sparkles,
  AlertCircle, AlertOctagon, Lightbulb, FileDown, Wallet, BookOpen,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { Map as MapGL, Source, Layer, Marker } from "react-map-gl/mapbox";
import type { MapRef } from "react-map-gl/mapbox";
import "mapbox-gl/dist/mapbox-gl.css";
import { usePlanningFilters, SharedDay, Season } from "./PlanningFiltersContext";
import PresetPickerBar from "./coverage/PresetPickerBar";
import MapViewPresets, { LayerToggles, PRESET_LAYERS } from "./coverage/MapViewPresets";
import DemandVsSupplyChart from "./coverage/DemandVsSupplyChart";
import CoverageRadar from "./coverage/CoverageRadar";
import LineComparisonBadge, { RouteComparison } from "./coverage/LineComparisonBadge";
import { buildODGeoJSON, ODFlow } from "./coverage/odArcs";
import { captureMapSnapshot } from "./coverage/captureMapSnapshot";
import { buildStorytellingReport } from "./coverage/buildStorytellingReport";

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN || "";

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
  data?: any;
}

interface CoverageResp {
  meta: { dayType: string; serviceDate: string | null; radiusM: number; minTrips: number;
          season: string; dayIdx: number; dayLabel: string; serviceIds: number };
  summary: {
    populationServed: number; populationTotal: number; coveragePct: number;
    poiServed: number; poiTotal: number; poiServedPct: number;
    poiCoverageWeighted: number; weightedTotal: number; weightedServed: number;
    activeStops: number; totalStops: number; totalTrips: number;
    uncoveredPopulation: number;
  };
  byCategory: CategoryRow[];
  byHour: { hour: number; trips: number }[];
  stopsActive: { stopId: string; stopName: string; lat: number; lon: number; trips: number }[];
  coverageGeo: GeoJSON.FeatureCollection | null;
  suggestions: Suggestion[];
  unservedPois?: { id: string; name: string | null; category: string; lat: number; lon: number; relevance: number; nearestStopM: number }[];
  uncoveredAreas?: { lat: number; lon: number; pop: number; nearM: number; severity: "high"|"med"|"low" }[];
  balanceGrid?: { lat: number; lon: number; supply: number; demand: number; pop: number; score: number; status: "over"|"balanced"|"under"|"void"; sizeM: number }[];
  balanceSummary?: { over: number; under: number; balanced: number; void: number; cellSizeM: number };
  narrative?: { kind: string; text: string; tone: "good"|"warn"|"bad"|"neutral" }[];
  routeComparison?: RouteComparison | null;
  warning?: string;
}

interface ExpectedDemandResp {
  preset: string;
  hours: number[];
  expectedProfile: number[];
  peakHours: number[];
  rationale: string;
  poiCategoriesUsed: string[];
}

interface ShapesGeo extends GeoJSON.FeatureCollection {
  features: (GeoJSON.Feature<GeoJSON.LineString, { shapeId: string; routeId: string; shortName: string; color: string }>)[];
}

interface PoiCatalogResp {
  categories: { category: string; count: number }[];
  pois: { id: string; name: string | null; category: string; lat: number; lng: number }[];
}

interface AnalyzeResp {
  totalCostDay?: number;
  totalRevenueDay?: number;
  marginDay?: number;
  totalKmDay?: number;
  totalHoursDay?: number;
  totalTripsDay?: number;
  activeRoutes?: number;
  perRoute?: any[];
}

const POI_META: Record<string, { label: string; Icon: LucideIcon; color: string }> = {
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
  beach:      { label: "Spiagge / Lungomare",   Icon: Sun,            color: "#fbbf24" },
  seaside:    { label: "Mare / Costa",          Icon: Sun,            color: "#fbbf24" },
};
const metaFor = (cat: string) => POI_META[cat] || { label: cat, Icon: MapPin, color: "#888" };

const DAYS: { key: SharedDay; label: string; sub: string }[] = [
  { key: "weekday",  label: "Feriale",  sub: "Lun → Ven" },
  { key: "saturday", label: "Sabato",   sub: "" },
  { key: "sunday",   label: "Domenica", sub: "/festivo" },
];

const RADII = [300, 400, 500, 800];

const SEASONS: { key: Season; label: string; Icon: LucideIcon }[] = [
  { key: "all",    label: "Annuale",   Icon: CalendarDays },
  { key: "summer", label: "Estate",    Icon: Sun },
  { key: "winter", label: "Inverno",   Icon: Snowflake },
];

const fmtNum = (n: number, d = 0) =>
  new Intl.NumberFormat("it-IT", { maximumFractionDigits: d }).format(n);
const fmtEur = (n: number) =>
  new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(n);

function colorForRoute(routeId: string, gtfsColor: string | null): string {
  if (gtfsColor) {
    const c = String(gtfsColor).replace(/^#/, "").toLowerCase();
    if (/^[0-9a-f]{6}$/.test(c) && c !== "000000" && c !== "ffffff") return `#${c}`;
  }
  let hash = 0;
  for (let i = 0; i < routeId.length; i++) hash = (hash * 31 + routeId.charCodeAt(i)) | 0;
  const h = Math.abs(hash) % 360;
  return `hsl(${h}, 75%, 58%)`;
}

type Props = {
  feedId: string | null;
  selectedRouteIds?: Set<string> | string[] | null;
};

export default function ServiceCoverageTab({ feedId, selectedRouteIds }: Props) {
  const ctx = usePlanningFilters();
  const [localDay, setLocalDay] = useState<SharedDay>("weekday");
  const [localRadius, setLocalRadius] = useState(400);
  const [localSeason, setLocalSeason] = useState<Season>("all");

  const day      = ctx?.day      ?? localDay;
  const radius   = ctx?.radiusM  ?? localRadius;
  const season   = ctx?.season   ?? localSeason;
  const setDay    = ctx?.setDay     ?? setLocalDay;
  const setRadius = ctx?.setRadiusM ?? setLocalRadius;
  const setSeason = ctx?.setSeason  ?? setLocalSeason;
  const demandPreset = ctx?.demandPreset ?? "custom";
  const setDemandPreset = ctx?.setDemandPreset ?? (() => {});
  const mapViewPreset = ctx?.mapViewPreset ?? "coverage";
  const setMapViewPreset = ctx?.setMapViewPreset ?? (() => {});

  const [data, setData] = useState<CoverageResp | null>(null);
  const [shapes, setShapes] = useState<ShapesGeo | null>(null);
  const [pois, setPois] = useState<PoiCatalogResp["pois"]>([]);
  const [costInfo, setCostInfo] = useState<AnalyzeResp | null>(null);
  const [expectedDemand, setExpectedDemand] = useState<ExpectedDemandResp | null>(null);
  const [odFlows, setOdFlows] = useState<ODFlow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // LayerToggles inizializzati dal preset attivo. L'utente può modificarli singolarmente
  // tramite il pannello avanzato — in tal caso il preset diventa "custom".
  const [layers, setLayers] = useState<LayerToggles>(() =>
    mapViewPreset !== "custom" ? PRESET_LAYERS[mapViewPreset] : PRESET_LAYERS.coverage
  );

  // Quando il preset cambia (via radio principale), riapplica le toggle del preset.
  useEffect(() => {
    if (mapViewPreset !== "custom") {
      setLayers(PRESET_LAYERS[mapViewPreset]);
    }
  }, [mapViewPreset]);

  function updateLayer(patch: Partial<LayerToggles>) {
    setLayers((prev) => ({ ...prev, ...patch }));
    if (mapViewPreset !== "custom") setMapViewPreset("custom");
  }

  const [hiddenCats, setHiddenCats] = useState<Set<string>>(new Set());
  const [exporting, setExporting] = useState(false);
  const [exportingStory, setExportingStory] = useState(false);
  const mapRef = useRef<MapRef | null>(null);

  useEffect(() => {
    if (!feedId) return;
    apiFetch<ShapesGeo>(`/api/planning/feeds/${feedId}/shapes`)
      .then((g) => {
        const fc: ShapesGeo = {
          type: "FeatureCollection",
          features: g.features.map((f) => ({
            ...f,
            properties: {
              ...f.properties,
              lineColor: colorForRoute(f.properties.routeId, f.properties.color),
            } as any,
          })),
        };
        setShapes(fc);
      })
      .catch(() => setShapes(null));
    apiFetch<PoiCatalogResp>(`/api/planning/feeds/${feedId}/poi-catalog`)
      .then((d) => setPois(d.pois || []))
      .catch(() => setPois([]));
  }, [feedId]);

  useEffect(() => {
    if (!feedId) return;
    const routeArr = selectedRouteIds
      ? (selectedRouteIds instanceof Set ? Array.from(selectedRouteIds) : selectedRouteIds)
      : [];
    apiFetch<AnalyzeResp>(`/api/planning/feeds/${feedId}/analyze`, {
      method: "POST",
      body: JSON.stringify({
        dayType: day,
        serviceDate: ctx?.serviceDate || null,
        routeIds: routeArr.length > 0 ? routeArr : null,
      }),
    })
      .then(setCostInfo)
      .catch(() => setCostInfo(null));
  }, [feedId, day, selectedRouteIds, ctx?.serviceDate]);

  useEffect(() => {
    if (!feedId) return;
    setLoading(true); setError(null);
    // Costruisci query string con routeIds se presenti
    const params = new URLSearchParams({
      dayType: day,
      radiusM: String(radius),
      season,
    });
    if (ctx?.serviceDate) params.set("serviceDate", ctx.serviceDate);
    if (selectedRouteIds) {
      const arr = selectedRouteIds instanceof Set ? Array.from(selectedRouteIds) : selectedRouteIds;
      if (arr.length > 0) params.set("routeIds", arr.join(","));
    }
    apiFetch<CoverageResp>(`/api/planning/feeds/${feedId}/service-coverage?${params.toString()}`)
      .then(setData)
      .catch((e) => setError(e?.message || "Errore"))
      .finally(() => setLoading(false));
  }, [feedId, day, radius, season, selectedRouteIds, ctx?.serviceDate]);

  // Fetch profilo domanda attesa (preset)
  useEffect(() => {
    if (!feedId) { setExpectedDemand(null); return; }
    const params = new URLSearchParams({ preset: demandPreset });
    apiFetch<ExpectedDemandResp>(`/api/planning/feeds/${feedId}/expected-hourly-demand?${params.toString()}`)
      .then(setExpectedDemand)
      .catch(() => setExpectedDemand(null));
  }, [feedId, demandPreset]);

  // Fetch OD flows (best-effort: endpoint può non esistere → graceful)
  useEffect(() => {
    if (!feedId || !layers.showFlows) { return; }
    apiFetch<{ flows: ODFlow[] }>(`/api/planning/feeds/${feedId}/od-flows?dayType=${day}&season=${season}`)
      .then((d) => setOdFlows(Array.isArray(d?.flows) ? d.flows : []))
      .catch(() => setOdFlows([]));
  }, [feedId, day, season, layers.showFlows]);

  const odGeoJSON = useMemo(() => buildODGeoJSON(odFlows, 150), [odFlows]);

  const relevantPoiCats = useMemo(() => {
    if (!data) return new Set<string>();
    const s = new Set<string>();
    for (const c of data.byCategory) if (c.relevance > 0) s.add(c.category);
    return s;
  }, [data]);

  const visiblePois = useMemo(() => {
    if (!layers.showPois) return [];
    return pois.filter((p) => relevantPoiCats.has(p.category) && !hiddenCats.has(p.category));
  }, [pois, relevantPoiCats, hiddenCats, layers.showPois]);

  const econKpi = useMemo(() => {
    if (!costInfo || !data) return null;
    const cost = costInfo.totalCostDay || 0;
    const popServed = data.summary.populationServed;
    const tripsDay = costInfo.totalTripsDay || data.summary.totalTrips || 1;
    return {
      costDay: cost,
      costYear: cost * 365,
      revenueDay: costInfo.totalRevenueDay || 0,
      marginDay: costInfo.marginDay || 0,
      costPerInhabitant: popServed > 0 ? cost / popServed : 0,
      costPerTrip: tripsDay > 0 ? cost / tripsDay : 0,
    };
  }, [costInfo, data]);

  const initialView = useMemo(() => {
    if (!data || data.stopsActive.length === 0) {
      return { longitude: 13.51, latitude: 43.60, zoom: 10 };
    }
    let mnLat = +Infinity, mxLat = -Infinity, mnLon = +Infinity, mxLon = -Infinity;
    for (const s of data.stopsActive) {
      if (s.lat < mnLat) mnLat = s.lat; if (s.lat > mxLat) mxLat = s.lat;
      if (s.lon < mnLon) mnLon = s.lon; if (s.lon > mxLon) mxLon = s.lon;
    }
    return { longitude: (mnLon + mxLon) / 2, latitude: (mnLat + mxLat) / 2, zoom: 10 };
  }, [data]);

  async function exportReport() {
    if (!feedId || !data || !costInfo) return;
    setExporting(true);
    try {
      const [wkData, satData, sunData] = await Promise.all(
        (["weekday","saturday","sunday"] as SharedDay[]).map((d) =>
          apiFetch<CoverageResp>(`/api/planning/feeds/${feedId}/service-coverage?dayType=${d}&radiusM=${radius}&season=${season}`)
        )
      );
      const html = buildReportHtml({
        feedId, day, radius, season,
        wk: wkData, sat: satData, sun: sunData,
        cost: costInfo,
      });
      const win = window.open("", "_blank");
      if (win) { win.document.open(); win.document.write(html); win.document.close(); }
    } catch (e) {
      console.error("[coverage] export error", e);
      alert("Errore export report: " + String(e));
    } finally {
      setExporting(false);
    }
  }

  async function exportStorytelling() {
    if (!feedId || !data) return;
    setExportingStory(true);
    try {
      // 1. Cattura mappa principale (preset corrente)
      const mapMain = await captureMapSnapshot(mapRef.current);

      // 2. Per la mappa "gaps": forza temporaneamente layer su zone non servite
      // (semplice: usa la stessa mappa se preset è già "gaps", altrimenti riusa)
      const mapGaps = mapViewPreset === "gaps" ? mapMain : await captureMapSnapshot(mapRef.current);

      // 3. Calcola alignment index dai dati
      let alignmentIndex: number | null = null;
      if (expectedDemand?.expectedProfile) {
        const maxTrips = Math.max(1, ...data.byHour.map((d) => d.trips));
        let mn = 0, mx = 0;
        for (const d of data.byHour) {
          const s = d.trips / maxTrips;
          const e = expectedDemand.expectedProfile[d.hour] ?? 0;
          mn += Math.min(s, e);
          mx += Math.max(s, e);
        }
        alignmentIndex = mx > 0 ? Math.round((mn / mx) * 100) : null;
      }

      // 4. Identifica ore sotto/sovra
      let underHours: number[] = [], overHours: number[] = [];
      if (expectedDemand?.expectedProfile) {
        const maxTrips = Math.max(1, ...data.byHour.map((d) => d.trips));
        for (const d of data.byHour) {
          const s = d.trips / maxTrips;
          const e = expectedDemand.expectedProfile[d.hour] ?? 0;
          const delta = s - e;
          if (e >= 0.15 && delta < -0.3) underHours.push(d.hour);
          else if (delta > 0.3) overHours.push(d.hour);
        }
      }

      const dayLabelMap: Record<string, string> = { weekday: "Giorno feriale", saturday: "Sabato", sunday: "Domenica/festivo" };
      const seasonLabelMap: Record<string, string> = { all: "tutto l'anno", summer: "estate", winter: "inverno" };

      const POI_LABELS: Record<string, string> = {
        hospital: "ospedale", school: "scuola", shopping: "centro commerciale",
        beach: "spiaggia", seaside: "lungomare", tourism: "luogo turistico",
        workplace: "luogo di lavoro", office: "ufficio pubblico", university: "università",
        leisure: "area sportiva/ricreativa", church: "luogo di culto", worship: "luogo di culto",
        elderly: "RSA", parking: "parcheggio", restaurant: "ristorante", bar: "bar",
        industrial: "zona industriale", transit: "stazione/interscambio",
      };

      const html = buildStorytellingReport({
        feedName: feedId,
        findings: {
          populationCoverage: data.summary.coveragePct,
          poiCoverage: data.summary.poiCoverageWeighted,
          uncoveredPopulation: data.summary.uncoveredPopulation,
          totalPopulation: data.summary.populationTotal,
          unservedPoisCount: data.unservedPois?.length ?? 0,
          costPerInhabitant: econKpi?.costPerInhabitant ?? 0,
          costDay: econKpi?.costDay ?? 0,
          dayLabel: dayLabelMap[day] ?? data.meta.dayLabel,
          seasonLabel: seasonLabelMap[season] ?? "tutto l'anno",
          alignmentIndex,
          routeContribution: data.routeComparison?.filteredContributionPct ?? null,
          populationLost: data.routeComparison?.populationLostIfRemoved ?? null,
          filteredRoutes: data.routeComparison?.filteredRoutes,
        },
        mapMain,
        mapGaps,
        topUnservedPois: (data.unservedPois ?? []).slice(0, 10).map((p) => ({
          name: p.name ?? "(senza nome)",
          categoryLabel: POI_LABELS[p.category] ?? p.category,
          distanceM: p.nearestStopM,
        })),
        topInterventions: data.suggestions.slice(0, 5).map((s) => ({
          title: s.title,
          rationale: s.detail,
          expectedImpact: s.action,
        })),
        hourlyHighlights: { underHours, overHours },
      });

      const win = window.open("", "_blank");
      if (win) { win.document.open(); win.document.write(html); win.document.close(); }
    } catch (e) {
      console.error("[coverage] storytelling export error", e);
      alert("Errore export report narrativo: " + String(e));
    } finally {
      setExportingStory(false);
    }
  }

  // Toolbar export — sempre visibile in alto, anche senza feedId (bottoni disabled)
  const exportToolbar = (
    <div className="flex flex-wrap items-center gap-2 p-2.5 bg-gradient-to-r from-blue-500/10 to-purple-500/10 border-2 border-blue-500/30 rounded-lg">
      <span className="text-xs font-semibold mr-auto flex items-center gap-1.5">
        <FileDown className="w-4 h-4 text-blue-400" /> Esporta analisi:
      </span>
      <button
        onClick={exportReport}
        disabled={!data || exporting}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs border border-border bg-card hover:bg-muted disabled:opacity-50"
        title="Report tecnico (3 giorni-tipo, KPI, suggestions)"
      >
        {exporting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileDown className="w-3.5 h-3.5" />}
        Report tecnico
      </button>
      <button
        onClick={exportStorytelling}
        disabled={!data || exportingStory}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs border-2 border-blue-500 bg-blue-500/30 text-blue-100 hover:bg-blue-500/40 font-semibold disabled:opacity-50"
        title="Report narrativo per stakeholder non tecnici (linguaggio semplice, screenshot mappa)"
      >
        {exportingStory ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <BookOpen className="w-3.5 h-3.5" />}
        📖 Report narrativo (storytelling)
      </button>
    </div>
  );

  if (!feedId) {
    return (
      <div className="p-4 space-y-4">
        {exportToolbar}
        <div className="p-6 text-sm text-muted-foreground border border-dashed border-border rounded-lg">
          ⚠️ Nessun feed GTFS di base selezionato per questo scenario.
          I bottoni di export sono visibili ma disabilitati finché non viene caricato un feed.
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 space-y-4 overflow-y-auto">
      {exportToolbar}

      <div className="flex flex-wrap items-end gap-4 p-3 bg-card border border-border rounded-lg">
        <div>
          <div className="text-[10px] uppercase text-muted-foreground mb-1 flex items-center gap-1">
            <CalendarDays className="w-3 h-3" /> Giorno
            {ctx && <span className="text-emerald-400 ml-1" title="Filtro condiviso col tab Costi">⇄</span>}
          </div>
          <div className="flex gap-1">
            {DAYS.map((d) => (
              <button key={d.key} onClick={() => setDay(d.key)}
                className={`px-3 py-1.5 rounded-md text-xs border transition-colors ${
                  day === d.key ? "bg-primary text-primary-foreground border-primary"
                                 : "bg-background border-border hover:bg-muted"}`}>
                <div className="font-semibold">{d.label}</div>
                {d.sub && <div className="text-[9px] opacity-70">{d.sub}</div>}
              </button>
            ))}
          </div>
        </div>

        <div>
          <div className="text-[10px] uppercase text-muted-foreground mb-1 flex items-center gap-1">
            <Footprints className="w-3 h-3" /> Raggio pedonale
          </div>
          <div className="flex gap-1">
            {RADII.map((r) => (
              <button key={r} onClick={() => setRadius(r)}
                className={`px-3 py-1.5 rounded-md text-xs border ${
                  radius === r ? "bg-primary text-primary-foreground border-primary"
                              : "bg-background border-border hover:bg-muted"}`}>
                {r} m
                <div className="text-[9px] opacity-70">≈{Math.round(r/80)}min</div>
              </button>
            ))}
          </div>
        </div>

        <div>
          <div className="text-[10px] uppercase text-muted-foreground mb-1">Stagione</div>
          <div className="flex gap-1">
            {SEASONS.map((s) => (
              <button key={s.key} onClick={() => setSeason(s.key)}
                className={`px-3 py-1.5 rounded-md text-xs border flex items-center gap-1 ${
                  season === s.key ? "bg-primary text-primary-foreground border-primary"
                                  : "bg-background border-border hover:bg-muted"}`}>
                <s.Icon className="w-3 h-3" /> {s.label}
              </button>
            ))}
          </div>
        </div>

        <div className="ml-auto flex items-center gap-3 text-xs flex-wrap">
          {loading && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />}
        </div>
      </div>

      {/* Demand preset picker (orizzontale) */}
      <PresetPickerBar />

      {/* Map view preset + advanced layers */}
      <MapViewPresets
        current={mapViewPreset}
        onPresetChange={setMapViewPreset}
        toggles={layers}
        onToggle={(key, value) => updateLayer({ [key]: value } as Partial<LayerToggles>)}
      />

      {error && (
        <div className="flex items-center gap-2 p-3 bg-destructive/10 text-destructive rounded-lg text-sm">
          <AlertTriangle className="w-4 h-4" /> {error}
        </div>
      )}
      {data?.warning && (
        <div className="flex items-center gap-2 p-3 bg-amber-500/10 text-amber-400 rounded-lg text-sm">
          <AlertTriangle className="w-4 h-4" /> {data.warning}
        </div>
      )}

      {data && (
        <>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
            <div className="bg-card border border-border rounded-lg p-3">
              <div className="text-[10px] uppercase text-muted-foreground mb-1 flex items-center gap-1">
                <Wallet className="w-3 h-3" /> 1. Quanto costa il servizio
              </div>
              {econKpi ? (
                <>
                  <div className="text-2xl font-bold">
                    {fmtEur(econKpi.costDay)}
                    <span className="text-xs font-normal text-muted-foreground">/giorno</span>
                  </div>
                  <div className="text-[11px] text-muted-foreground mt-0.5">≈ {fmtEur(econKpi.costYear)}/anno</div>
                  <div className="grid grid-cols-2 gap-2 mt-3 text-[11px]">
                    <Mini label="€ / abitante coperto" value={econKpi.costPerInhabitant > 0 ? fmtEur(econKpi.costPerInhabitant) : "—"} />
                    <Mini label="€ / corsa" value={econKpi.costPerTrip > 0 ? fmtEur(econKpi.costPerTrip) : "—"} />
                    <Mini label="Ricavi/giorno" value={fmtEur(econKpi.revenueDay)} />
                    <Mini label="Margine" value={fmtEur(econKpi.marginDay)} tone={econKpi.marginDay >= 0 ? "good" : "bad"} />
                  </div>
                </>
              ) : (
                <div className="text-xs text-muted-foreground">Caricamento KPI economici…</div>
              )}
            </div>

            <div className="bg-card border border-border rounded-lg p-3">
              <div className="text-[10px] uppercase text-muted-foreground mb-1 flex items-center gap-1">
                <Target className="w-3 h-3" /> 2. Soddisfa la domanda — {data.meta.dayLabel}
              </div>
              <div className="flex items-baseline gap-3">
                <div>
                  <div className={`text-2xl font-bold ${toneCls(data.summary.coveragePct)}`}>{data.summary.coveragePct}%</div>
                  <div className="text-[10px] text-muted-foreground">popolazione coperta</div>
                </div>
                <div>
                  <div className={`text-2xl font-bold ${toneCls(data.summary.poiCoverageWeighted)}`}>{data.summary.poiCoverageWeighted}%</div>
                  <div className="text-[10px] text-muted-foreground">POI rilevanti</div>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2 mt-3 text-[11px]">
                <Mini label="Stop attive" value={`${fmtNum(data.summary.activeStops)}/${fmtNum(data.summary.totalStops)}`} />
                <Mini label="Corse" value={fmtNum(data.summary.totalTrips)} />
                <Mini label="Pop. coperta" value={`${fmtNum(data.summary.populationServed)} ab.`} />
                <Mini label="Pop. scoperta" value={`${fmtNum(data.summary.uncoveredPopulation)} ab.`} tone={data.summary.uncoveredPopulation > 50000 ? "bad" : "neutral"} />
              </div>
            </div>

            <div className="bg-card border border-border rounded-lg p-3">
              <div className="text-[10px] uppercase text-muted-foreground mb-1 flex items-center gap-1">
                <Lightbulb className="w-3 h-3" /> 3. Interventi suggeriti
              </div>
              <div className="text-2xl font-bold text-amber-400">{data.suggestions.length}</div>
              <div className="text-[11px] text-muted-foreground">azioni identificate</div>
              <div className="mt-2 flex gap-1 text-[10px]">
                {(["high","med","low"] as const).map((sev) => {
                  const n = data.suggestions.filter((s) => s.severity === sev).length;
                  if (n === 0) return null;
                  const cls = sev === "high" ? "bg-red-500/20 text-red-400"
                            : sev === "med"  ? "bg-amber-500/20 text-amber-400"
                            : "bg-blue-500/20 text-blue-400";
                  return <span key={sev} className={`px-1.5 py-0.5 rounded ${cls}`}>{n} {sev}</span>;
                })}
              </div>
              <button onClick={() => document.getElementById("suggestions-block")?.scrollIntoView({ behavior: "smooth" })}
                className="mt-3 text-xs text-primary hover:underline">
                Vedi tutti gli interventi ↓
              </button>
            </div>
          </div>

          {MAPBOX_TOKEN ? (
            <div className="bg-card border border-border rounded-lg overflow-hidden">
              <div className="h-[480px] relative">
                <MapGL
                  ref={mapRef}
                  mapboxAccessToken={MAPBOX_TOKEN}
                  initialViewState={initialView}
                  style={{ width: "100%", height: "100%" }}
                  mapStyle="mapbox://styles/mapbox/dark-v11"
                  attributionControl={false}
                  preserveDrawingBuffer
                >
                  {layers.showBuffer && data.coverageGeo && (
                    <Source id="buffer" type="geojson" data={data.coverageGeo as any}>
                      <Layer id="buffer-fill" type="fill" paint={{ "fill-color": "#22c55e", "fill-opacity": 0.08 }} />
                      <Layer id="buffer-outline" type="line" paint={{ "line-color": "#22c55e", "line-width": 0.5, "line-opacity": 0.35 }} />
                    </Source>
                  )}
                  {shapes && (
                    <Source id="shapes" type="geojson" data={shapes as any}>
                      <Layer id="shapes-line" type="line"
                        paint={{
                          "line-color": ["coalesce", ["get","lineColor"], "#3b82f6"],
                          "line-width": ["interpolate", ["linear"], ["zoom"], 9, 1.4, 13, 3],
                          "line-opacity": 0.85,
                        }}
                        layout={{ "line-cap": "round", "line-join": "round" }}
                      />
                    </Source>
                  )}
                  {visiblePois.slice(0, 800).map((p) => {
                    const m = metaFor(p.category);
                    return (
                      <Marker key={p.id} longitude={p.lng} latitude={p.lat} anchor="center">
                        <div title={`${p.name ?? "(senza nome)"} — ${m.label}`}
                          className="rounded-full p-0.5 shadow-md ring-1 ring-black/40"
                          style={{ background: m.color }}>
                          <m.Icon className="w-2.5 h-2.5 text-white" strokeWidth={2.5} />
                        </div>
                      </Marker>
                    );
                  })}

                  {/* FLUSSI OD: archi curvi tra zone (linee di desiderio) */}
                  {layers.showFlows && odGeoJSON.features.length > 0 && (
                    <Source id="od-flows" type="geojson" data={odGeoJSON as any}>
                      <Layer id="od-flows-line" type="line"
                        paint={{
                          "line-color": "#22d3ee",
                          "line-width": ["interpolate", ["linear"], ["get", "flow"],
                            0, 0.5, 100, 2, 1000, 5, 5000, 9],
                          "line-opacity": 0.55,
                          "line-blur": 0.5,
                        }}
                        layout={{ "line-cap": "round" }}
                      />
                    </Source>
                  )}

                  {/* BILANCIAMENTO offerta/domanda: cerchi colorati per cella */}
                  {layers.showBalance && data.balanceGrid && data.balanceGrid.length > 0 && (
                    <Source id="balance" type="geojson" data={{
                      type: "FeatureCollection",
                      features: data.balanceGrid
                        .filter((b) => !hiddenCats.size || true)
                        .map((b) => ({
                          type: "Feature",
                          properties: { status: b.status, score: b.score, supply: b.supply, demand: b.demand, pop: b.pop },
                          geometry: { type: "Point", coordinates: [b.lon, b.lat] },
                        })),
                    } as any}>
                      <Layer id="balance-circle" type="circle"
                        paint={{
                          "circle-radius": ["interpolate", ["linear"], ["zoom"],
                            9, ["interpolate", ["linear"], ["+", ["get","supply"], ["/", ["get","demand"], 100]], 0, 6, 50, 14, 200, 24],
                            13, ["interpolate", ["linear"], ["+", ["get","supply"], ["/", ["get","demand"], 100]], 0, 12, 50, 28, 200, 48]],
                          "circle-color": ["match", ["get","status"],
                            "over", "#ef4444",
                            "under", "#3b82f6",
                            "void", "#7c3aed",
                            /* balanced */ "#10b981"],
                          "circle-opacity": 0.35,
                          "circle-stroke-color": ["match", ["get","status"],
                            "over", "#7f1d1d", "under", "#1e3a8a", "void", "#4c1d95", "#064e3b"],
                          "circle-stroke-width": 1,
                          "circle-stroke-opacity": 0.7,
                        }} />
                    </Source>
                  )}

                  {/* ZONE NON SERVITE (sezioni censuarie scoperte) */}
                  {layers.showUncovered && data.uncoveredAreas && data.uncoveredAreas.length > 0 && (
                    <Source id="uncovered" type="geojson" data={{
                      type: "FeatureCollection",
                      features: data.uncoveredAreas.map((a) => ({
                        type: "Feature",
                        properties: { pop: a.pop, sev: a.severity, near: a.nearM },
                        geometry: { type: "Point", coordinates: [a.lon, a.lat] },
                      })),
                    } as any}>
                      <Layer id="uncovered-circle" type="circle"
                        paint={{
                          "circle-radius": ["interpolate", ["linear"], ["get","pop"],
                            50, 3, 200, 5, 500, 8, 1500, 14, 5000, 22],
                          "circle-color": ["match", ["get","sev"],
                            "high", "#dc2626", "med", "#f97316", /* low */ "#fbbf24"],
                          "circle-opacity": 0.55,
                          "circle-stroke-color": "#7f1d1d",
                          "circle-stroke-width": 0.5,
                          "circle-stroke-opacity": 0.6,
                        }} />
                    </Source>
                  )}

                  {/* POI NON SERVITI rilevanti */}
                  {layers.showUnservedPois && data.unservedPois && data.unservedPois.slice(0, 400).map((u) => {
                    const m = metaFor(u.category);
                    return (
                      <Marker key={"un-" + u.id} longitude={u.lon} latitude={u.lat} anchor="center">
                        <div title={`${u.name ?? "(senza nome)"} — ${m.label} — peso ${u.relevance.toFixed(2)}× — ${u.nearestStopM} m dalla fermata`}
                          className="rounded-full p-0.5 ring-2 ring-red-500/90"
                          style={{ background: "rgba(0,0,0,0.55)" }}>
                          <m.Icon className="w-2.5 h-2.5" style={{ color: m.color }} strokeWidth={2.5} />
                        </div>
                      </Marker>
                    );
                  })}
                </MapGL>
                <div className="absolute bottom-3 left-3 bg-background/95 backdrop-blur rounded-lg p-2 text-[10px] border border-border/40 space-y-1 max-w-[300px]">
                  <div className="font-semibold">Legenda</div>
                  {layers.showBuffer && (
                    <div className="flex items-center gap-1.5">
                      <span className="inline-block w-3 h-3 rounded-full" style={{ background: "rgba(34,197,94,0.3)", border: "1px solid #22c55e" }} />
                      <span>raggio pedonale {radius} m (zone servite)</span>
                    </div>
                  )}
                  {layers.showPois && (
                    <div className="text-muted-foreground">
                      <span className="inline-block w-3 h-3 rounded-full bg-emerald-500 mr-1 align-middle" />
                      {visiblePois.length} POI serviti (icona piena colorata)
                    </div>
                  )}
                  {layers.showUnservedPois && data.unservedPois && data.unservedPois.length > 0 && (
                    <div className="flex items-center gap-1.5">
                      <span className="inline-block w-3 h-3 rounded-full ring-1 ring-red-500" style={{ background: "rgba(0,0,0,0.55)" }} />
                      <span>{data.unservedPois.length} POI rilevanti NON serviti</span>
                    </div>
                  )}
                  {layers.showFlows && odGeoJSON.features.length > 0 && (
                    <div className="flex items-center gap-1.5">
                      <span className="inline-block w-4 h-1 rounded" style={{ background: "#22d3ee" }} />
                      <span>{odGeoJSON.features.length} flussi OD (spessore ∝ volume)</span>
                    </div>
                  )}
                  {layers.showUncovered && data.uncoveredAreas && data.uncoveredAreas.length > 0 && (
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="inline-block w-2 h-2 rounded-full" style={{ background: "#dc2626" }} />
                      <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: "#f97316" }} />
                      <span className="inline-block w-3 h-3 rounded-full" style={{ background: "#fbbf24" }} />
                      <span>zone NON servite (alta/media/bassa, dim. = popolazione)</span>
                    </div>
                  )}
                  {layers.showBalance && data.balanceSummary && (
                    <div className="space-y-0.5 pt-1 border-t border-border/40">
                      <div className="font-medium">Bilanciamento (cella ~{data.balanceSummary.cellSizeM} m)</div>
                      <div className="flex items-center gap-1.5"><span className="inline-block w-3 h-3 rounded-full bg-red-500/60 ring-1 ring-red-900" /> sovra-offerta ({data.balanceSummary.over})</div>
                      <div className="flex items-center gap-1.5"><span className="inline-block w-3 h-3 rounded-full bg-emerald-500/60 ring-1 ring-emerald-900" /> bilanciato ({data.balanceSummary.balanced})</div>
                      <div className="flex items-center gap-1.5"><span className="inline-block w-3 h-3 rounded-full bg-blue-500/60 ring-1 ring-blue-900" /> sotto-servito ({data.balanceSummary.under})</div>
                      <div className="flex items-center gap-1.5"><span className="inline-block w-3 h-3 rounded-full bg-purple-500/60 ring-1 ring-purple-900" /> domanda senza corse ({data.balanceSummary.void})</div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div className="p-3 bg-amber-500/10 text-amber-400 rounded-lg text-xs">
              VITE_MAPBOX_TOKEN non impostato — mappa disabilitata.
            </div>
          )}

          {data.narrative && data.narrative.length > 0 && (
            <div className="bg-card border border-border rounded-lg overflow-hidden">
              <div className="px-3 py-2 border-b border-border flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-blue-400" />
                <div className="text-sm font-semibold">Analisi descrittiva — {data.meta.dayLabel}</div>
                <span className="text-[10px] text-muted-foreground ml-2">sintesi automatica</span>
              </div>
              <div className="p-3 space-y-2 text-[13px] leading-relaxed">
                {data.narrative.map((n, i) => {
                  const tone =
                    n.tone === "good" ? "border-l-emerald-500 bg-emerald-500/5" :
                    n.tone === "warn" ? "border-l-amber-500 bg-amber-500/5" :
                    n.tone === "bad"  ? "border-l-red-500 bg-red-500/5" :
                                        "border-l-blue-500 bg-blue-500/5";
                  return (
                    <div key={i} className={`border-l-4 ${tone} pl-3 py-1.5 pr-2 rounded-r`}>
                      {n.text}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div id="suggestions-block" className="bg-card border border-border rounded-lg overflow-hidden">
            <div className="px-3 py-2 border-b border-border flex items-center gap-2">
              <Lightbulb className="w-4 h-4 text-amber-400" />
              <div className="text-sm font-semibold">Interventi suggeriti</div>
              <span className="text-[10px] text-muted-foreground ml-2">basati su gap reali del servizio</span>
            </div>
            {data.suggestions.length === 0 ? (
              <div className="p-4 text-sm text-muted-foreground flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-emerald-400" /> Nessun gap critico identificato — copertura buona per i parametri attuali.
              </div>
            ) : (
              <div className="divide-y divide-border/40">
                {data.suggestions.map((s, i) => <SuggestionRow key={i} s={s} />)}
              </div>
            )}
          </div>

          <div className="bg-card border border-border rounded-lg overflow-hidden">
            <div className="px-3 py-2 border-b border-border flex items-center justify-between">
              <div className="text-sm font-semibold">
                Domanda potenziale per categoria — {data.meta.dayLabel}
                {season !== "all" && <span className="text-[10px] text-muted-foreground ml-2">({season === "summer" ? "estate" : "inverno"})</span>}
              </div>
              <div className="text-[10px] text-muted-foreground">click per nascondere su mappa</div>
            </div>
            <table className="w-full text-xs">
              <thead className="bg-muted/30 text-muted-foreground">
                <tr>
                  <th className="text-left px-3 py-1.5">Categoria</th>
                  <th className="text-right px-3 py-1.5" title="Peso domanda per il giorno selezionato">Peso</th>
                  <th className="text-right px-3 py-1.5">Totale</th>
                  <th className="text-right px-3 py-1.5">Coperti</th>
                  <th className="text-right px-3 py-1.5">% copertura</th>
                  <th className="text-right px-3 py-1.5">Domanda persa</th>
                </tr>
              </thead>
              <tbody>
                {data.byCategory.map((c) => {
                  const m = metaFor(c.category);
                  const lost = Math.round((c.weightedTotal - c.weightedServed) * 10) / 10;
                  const isHidden = hiddenCats.has(c.category);
                  const isIrrelevant = c.relevance === 0;
                  return (
                    <tr key={c.category}
                      className={`border-t border-border/40 cursor-pointer hover:bg-muted/30 ${isHidden ? "opacity-40" : ""} ${isIrrelevant ? "text-muted-foreground" : ""}`}
                      onClick={() => {
                        const next = new Set(hiddenCats);
                        if (next.has(c.category)) next.delete(c.category); else next.add(c.category);
                        setHiddenCats(next);
                      }}
                    >
                      <td className="px-3 py-1.5">
                        <div className="flex items-center gap-2">
                          <span className="rounded p-0.5" style={{ background: m.color }}>
                            <m.Icon className="w-3 h-3 text-white" />
                          </span>
                          <span>{m.label}</span>
                        </div>
                      </td>
                      <td className="text-right px-3 py-1.5 tabular-nums">
                        <span className={`px-1.5 py-0.5 rounded text-[10px] ${
                          c.relevance === 0 ? "bg-muted text-muted-foreground"
                            : c.relevance >= 1.3 ? "bg-amber-500/20 text-amber-400"
                            : c.relevance >= 1 ? "bg-emerald-500/20 text-emerald-400"
                            : "bg-blue-500/20 text-blue-400"
                        }`}>{c.relevance.toFixed(2)}×</span>
                      </td>
                      <td className="text-right px-3 py-1.5 tabular-nums">{fmtNum(c.total)}</td>
                      <td className="text-right px-3 py-1.5 tabular-nums">{fmtNum(c.served)}</td>
                      <td className="text-right px-3 py-1.5 tabular-nums">
                        {isIrrelevant ? "—" : (
                          <span className={c.servedPct >= 70 ? "text-emerald-400" : c.servedPct >= 40 ? "text-amber-400" : "text-red-400"}>
                            {c.servedPct}%
                          </span>
                        )}
                      </td>
                      <td className="text-right px-3 py-1.5 tabular-nums">
                        {isIrrelevant ? "—" : (lost > 0 ? <span className="text-red-400">−{fmtNum(lost,1)}</span> : "✓")}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="bg-card border border-border rounded-lg p-3">
            <div className="text-sm font-semibold mb-2">Confronto domanda attesa vs offerta + Radar POI</div>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
              <DemandVsSupplyChart
                byHour={data.byHour}
                expectedProfile={expectedDemand?.expectedProfile}
                rationale={expectedDemand?.rationale}
                warning={expectedDemand?.preset === "custom" ? "Profilo personalizzato basato sul mix POI" : undefined}
              />
              <CoverageRadar categories={data.byCategory} target={80} />
            </div>
          </div>

          {/* Confronto linee selezionate vs rete totale (solo se filtro linee attivo) */}
          <LineComparisonBadge comparison={data.routeComparison} />

          <div className="text-[11px] text-muted-foreground border-t border-border/40 pt-2 flex items-start gap-1.5">
            <RefreshCw className="w-3 h-3 mt-0.5 shrink-0" />
            <div>
              Una stop è considerata <strong>attiva</strong> se ha almeno 1 corsa nel giorno selezionato.
              La <strong>popolazione coperta</strong> è la somma degli abitanti delle sezioni censuarie ISTAT
              il cui centroide cade entro {radius} m da una stop attiva. La <strong>copertura POI pesata</strong>
              applica un fattore di rilevanza per giorno della settimana e stagione (es. domenica: scuole=0,
              chiese=1.6×; estate: spiagge×1.5).
              {ctx && <span className="ml-1 text-emerald-400">⇄ filtri condivisi con il tab "Pianificazione & Costi"</span>}
            </div>
          </div>
        </>
      )}

      {!data && !loading && !error && (
        <div className="p-6 text-center text-sm text-muted-foreground flex items-center justify-center gap-2">
          <Bus className="w-4 h-4" /> Caricamento copertura del servizio…
        </div>
      )}
    </div>
  );
}

function Mini({ label, value, tone }: { label: string; value: string; tone?: "good"|"bad"|"neutral" }) {
  const t = tone === "good" ? "text-emerald-400" : tone === "bad" ? "text-red-400" : "text-foreground";
  return (
    <div className="bg-muted/20 rounded p-1.5">
      <div className="text-[9px] text-muted-foreground uppercase">{label}</div>
      <div className={`font-semibold ${t}`}>{value}</div>
    </div>
  );
}

function toneCls(pct: number) {
  return pct >= 70 ? "text-emerald-400" : pct >= 40 ? "text-amber-400" : "text-red-400";
}

function SuggestionRow({ s }: { s: Suggestion }) {
  const Icon = s.severity === "high" ? AlertOctagon : s.severity === "med" ? AlertCircle : Lightbulb;
  const cls = s.severity === "high" ? "text-red-400 bg-red-500/10"
            : s.severity === "med" ? "text-amber-400 bg-amber-500/10"
            : "text-blue-400 bg-blue-500/10";
  return (
    <div className="px-3 py-2.5 hover:bg-muted/20">
      <div className="flex items-start gap-2.5">
        <div className={`shrink-0 mt-0.5 p-1 rounded ${cls}`}><Icon className="w-3.5 h-3.5" /></div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold">{s.title}</div>
          <div className="text-xs text-muted-foreground mt-0.5">{s.detail}</div>
          <div className="text-xs mt-1.5 flex items-start gap-1">
            <span className="text-amber-400">→</span>
            <span><strong>Azione:</strong> {s.action}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function buildReportHtml(opts: {
  feedId: string; day: SharedDay; radius: number; season: Season;
  wk: CoverageResp; sat: CoverageResp; sun: CoverageResp;
  cost: AnalyzeResp;
}): string {
  const { day, radius, season, wk, sat, sun, cost } = opts;
  const seasonLbl = season === "summer" ? "Estate" : season === "winter" ? "Inverno" : "Annuale";
  const costDay = cost.totalCostDay || 0;
  const today = new Date().toLocaleDateString("it-IT");

  const dayCard = (label: string, d: CoverageResp) => `
    <div class="day-card">
      <h3>${label}</h3>
      <div class="kpi-row">
        <div><div class="kpi-num ${tcCls(d.summary.coveragePct)}">${d.summary.coveragePct}%</div><div class="kpi-lbl">popolazione</div></div>
        <div><div class="kpi-num ${tcCls(d.summary.poiCoverageWeighted)}">${d.summary.poiCoverageWeighted}%</div><div class="kpi-lbl">POI pesati</div></div>
        <div><div class="kpi-num">${fmtNum(d.summary.activeStops)}</div><div class="kpi-lbl">stop attive</div></div>
        <div><div class="kpi-num">${fmtNum(d.summary.totalTrips)}</div><div class="kpi-lbl">corse</div></div>
      </div>
    </div>
  `;

  const catRows = (d: CoverageResp) => d.byCategory.filter((c) => c.relevance > 0).map((c) => `
    <tr>
      <td>${escapeHtml(c.category)}</td>
      <td class="num">${c.relevance.toFixed(2)}×</td>
      <td class="num">${c.total}</td>
      <td class="num">${c.served}</td>
      <td class="num ${tcCls(c.servedPct)}">${c.servedPct}%</td>
    </tr>
  `).join("");

  const suggestionsBlock = (d: CoverageResp) => d.suggestions.map((s) => `
    <div class="sugg sugg-${s.severity}">
      <div class="sugg-title">${escapeHtml(s.title)}</div>
      <div class="sugg-detail">${escapeHtml(s.detail)}</div>
      <div class="sugg-action"><strong>Azione:</strong> ${escapeHtml(s.action)}</div>
    </div>
  `).join("");

  const dayTypeUsed = day === "weekday" ? wk : day === "saturday" ? sat : sun;
  const costYear = costDay * 365;
  const costPerInh = dayTypeUsed.summary.populationServed > 0 ? costDay / dayTypeUsed.summary.populationServed : 0;

  return `<!doctype html><html lang="it"><head>
<meta charset="utf-8"><title>Report copertura — TransitIntel</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, system-ui, sans-serif; margin: 0 auto; padding: 24px; color: #1f2937; line-height: 1.45; max-width: 1100px; }
  h1 { font-size: 24px; margin: 0 0 4px; color: #0f172a; }
  h2 { font-size: 18px; margin: 28px 0 12px; padding-bottom: 6px; border-bottom: 2px solid #cbd5e1; color: #0f172a; }
  h3 { font-size: 14px; margin: 12px 0 6px; color: #334155; }
  .meta { font-size: 12px; color: #64748b; margin-bottom: 8px; }
  .narrative { background: #f8fafc; border-left: 4px solid #3b82f6; padding: 12px 16px; margin: 12px 0; font-size: 13px; }
  .grid3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; }
  .day-card { border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px; }
  .day-card h3 { margin-top: 0; }
  .kpi-row { display: grid; grid-template-columns: 1fr 1fr 1fr 1fr; gap: 8px; margin-top: 6px; }
  .kpi-num { font-size: 18px; font-weight: 700; }
  .kpi-lbl { font-size: 9px; color: #64748b; text-transform: uppercase; }
  .good { color: #059669; }
  .warn { color: #d97706; }
  .bad  { color: #dc2626; }
  table { width: 100%; border-collapse: collapse; font-size: 11px; }
  th { background: #f1f5f9; padding: 6px 8px; text-align: left; }
  td { padding: 4px 8px; border-top: 1px solid #e2e8f0; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  .sugg { border-left: 3px solid #94a3b8; padding: 8px 12px; margin: 8px 0; background: #f8fafc; }
  .sugg-high { border-color: #dc2626; background: #fef2f2; }
  .sugg-med  { border-color: #f59e0b; background: #fffbeb; }
  .sugg-low  { border-color: #3b82f6; background: #eff6ff; }
  .sugg-title { font-weight: 600; font-size: 13px; margin-bottom: 2px; }
  .sugg-detail { font-size: 11px; color: #475569; margin-bottom: 4px; }
  .sugg-action { font-size: 11px; color: #1e3a8a; }
  .toolbar { position: sticky; top: 0; background: #fff; padding: 8px 0; margin-bottom: 16px; border-bottom: 1px solid #e2e8f0; z-index: 10; }
  .btn { display: inline-block; padding: 6px 14px; background: #2563eb; color: #fff; border: 0; border-radius: 6px; cursor: pointer; font-size: 13px; }
  .btn:hover { background: #1d4ed8; }
  @media print {
    .toolbar { display: none; }
    body { padding: 12mm; max-width: none; }
    .day-card, .sugg { page-break-inside: avoid; }
    h2 { page-break-before: auto; }
    table { page-break-inside: auto; }
    tr { page-break-inside: avoid; }
  }
</style>
</head><body>
<div class="toolbar">
  <button class="btn" onclick="window.print()">🖨 Stampa / Salva PDF</button>
  <span style="margin-left:12px; font-size:11px; color:#64748b;">Generato ${today} — TransitIntel</span>
</div>

<h1>Report Copertura del Servizio</h1>
<div class="meta">
  Raggio pedonale: <strong>${radius} m</strong> ·
  Stagione: <strong>${seasonLbl}</strong> ·
  Giorno principale: <strong>${day === "weekday" ? "Feriale" : day === "saturday" ? "Sabato" : "Domenica"}</strong>
</div>

<h2>1. Quanto costa il servizio?</h2>
<div class="grid3">
  <div class="day-card">
    <h3>Costo operativo</h3>
    <div class="kpi-num">${fmtEur(costDay)}<span style="font-size:10px;font-weight:400;color:#64748b">/giorno</span></div>
    <div class="kpi-lbl" style="margin-top:6px">≈ ${fmtEur(costYear)}/anno</div>
  </div>
  <div class="day-card">
    <h3>Ricavi stimati</h3>
    <div class="kpi-num">${fmtEur(cost.totalRevenueDay || 0)}<span style="font-size:10px;font-weight:400;color:#64748b">/giorno</span></div>
    <div class="kpi-lbl" style="margin-top:6px">Margine: <span class="${(cost.marginDay||0) >= 0 ? "good" : "bad"}">${fmtEur(cost.marginDay || 0)}</span></div>
  </div>
  <div class="day-card">
    <h3>Efficienza</h3>
    <div class="kpi-num">${costPerInh > 0 ? fmtEur(costPerInh) : "—"}</div>
    <div class="kpi-lbl" style="margin-top:6px">€ / abitante coperto / giorno</div>
  </div>
</div>
<div class="narrative">
  Il servizio analizzato eroga <strong>${fmtNum(cost.totalKmDay || 0, 1)} km/giorno</strong> con
  <strong>${fmtNum(cost.totalTripsDay || 0)} corse</strong> su <strong>${cost.activeRoutes || 0} linee</strong>.
  Il costo per abitante effettivamente coperto a piedi è di <strong>${fmtEur(costPerInh)}/giorno</strong>
  (proiezione annua: <strong>${fmtEur(costPerInh * 365)}</strong>).
</div>

<h2>2. Soddisfa la domanda?</h2>
<div class="narrative">
  Confronto della copertura nei tre principali giorni-tipo. La copertura è espressa come % di popolazione e
  % di POI rilevanti (pesati per giorno e stagione) raggiungibili a piedi entro ${radius} m da una fermata
  con almeno una corsa quel giorno.
</div>
<div class="grid3">
  ${dayCard("Feriale (Lun-Ven)", wk)}
  ${dayCard("Sabato", sat)}
  ${dayCard("Domenica/festivo", sun)}
</div>

<h3>Dettaglio categorie POI (giorno selezionato: ${day === "weekday" ? "Feriale" : day === "saturday" ? "Sabato" : "Domenica"})</h3>
<table>
  <thead><tr><th>Categoria</th><th class="num">Peso giornaliero</th><th class="num">Tot.</th><th class="num">Coperti</th><th class="num">% copertura</th></tr></thead>
  <tbody>${catRows(dayTypeUsed)}</tbody>
</table>

<h2>3. Quali interventi posso fare?</h2>

<h3>Interventi prioritari per il <strong>feriale</strong> (${wk.suggestions.length})</h3>
${wk.suggestions.length === 0 ? '<div class="narrative">Nessun gap critico identificato per il giorno feriale.</div>' : suggestionsBlock(wk)}

<h3>Interventi prioritari per il <strong>sabato</strong> (${sat.suggestions.length})</h3>
${sat.suggestions.length === 0 ? '<div class="narrative">Nessun gap critico identificato per il sabato.</div>' : suggestionsBlock(sat)}

<h3>Interventi prioritari per la <strong>domenica</strong> (${sun.suggestions.length})</h3>
${sun.suggestions.length === 0 ? '<div class="narrative">Nessun gap critico identificato per la domenica.</div>' : suggestionsBlock(sun)}

<div class="meta" style="margin-top:32px; border-top:1px solid #e2e8f0; padding-top:8px;">
  Report generato da TransitIntel · Algoritmi: copertura buffer pedonale planare,
  POI weighting per DOW + stagione, suggestions engine basato su gap censuari/POI.
</div>

<script>setTimeout(() => window.focus(), 100);</script>
</body></html>`;
}

function tcCls(pct: number) {
  return pct >= 70 ? "good" : pct >= 40 ? "warn" : "bad";
}

function escapeHtml(s: string) {
  return String(s).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]!));
}
