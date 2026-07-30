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
import { toast } from "sonner";
import { useParams } from "wouter";
import PsProjectNav from "@/components/planning-studio/PsProjectNav";
import DemandCoverage, { type DemandCoverageResult } from "./intermodal/DemandCoverage";
import LinePicker, { lineColor, type NetworkLine } from "./intermodal/LinePicker";

import type {
  AnalysisResult, HubPoisGroup,
} from "./intermodal/types";
import {
  type ViewMode, MAP_STYLES, HUB_COLORS, STATUS_CONFIG,
  PRIORITY_COLORS, POI_ICONS,
  walkCircle, shortHubName, hubIcon, hubGlowColor, hubTransportLabel,
} from "./intermodal/constants";

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN || "";

// ─── Props (optional for standalone page usage) ──────────────
export interface IntermodalPageProps {
  /** When provided, analysis is scoped to these GTFS route IDs */
  routeIds?: string[];
  /** When true, hides the top "quick actions" badges and standalone chrome */
  embedded?: boolean;
  /** Called when the user clicks "Applica proposte" (embedded flow) */
  onApplyProposals?: (proposals: AnalysisResult["proposedSchedule"]) => void;
  /** Custom POI radius (km) — default 3 */
  poiRadiusKm?: number;
}

/** Etichetta LEGGIBILE di una validità dal pattern dei giorni, così non si
 *  mostra il codice GTFS grezzo quando manca il nome del calendario. */
function giorniLabel(days?: boolean[]): string {
  if (!days || days.length < 7) return "";
  const [lu, ma, me, gi, ve, sa, dom] = days;
  const feriali = lu && ma && me && gi && ve;
  if (days.every(Boolean)) return "Tutti i giorni";
  if (feriali && sa && !dom) return "Lun–Sab";
  if (feriali && !sa && !dom) return "Lun–Ven";
  if (!lu && !ma && !me && !gi && !ve && sa && dom) return "Sab–Dom (festivo)";
  if (!lu && !ma && !me && !gi && !ve && sa && !dom) return "Sabato";
  if (!lu && !ma && !me && !gi && !ve && !sa && dom) return "Domenica / festivo";
  const GG = ["Lun", "Mar", "Mer", "Gio", "Ven", "Sab", "Dom"];
  return days.map((d, i) => (d ? GG[i] : null)).filter(Boolean).join(" ") || "";
}

// ─── Component ──────────────────────────────────────────────
/** Badge di fiducia sul dato-orario: reale (con data) / stima / assente.
 *  È l'UNICO badge, così l'utente non deve interpretare token grezzi. */
function TrustChip({ trust, fetchedAt }: { trust?: "reale" | "stima" | "assente"; fetchedAt?: string | null }) {
  const t = trust ?? "assente";
  const meta = t === "reale"
    ? { label: fetchedAt ? `Orari reali · ${new Date(fetchedAt).toLocaleDateString("it-IT", { day: "2-digit", month: "2-digit" })}` : "Orari reali (ViaggiaTreno)", cls: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40" }
    : t === "stima"
      ? { label: "Stima non verificata", cls: "bg-amber-500/15 text-amber-300 border-amber-500/40" }
      : { label: "Nessun orario", cls: "bg-slate-600/20 text-slate-400 border-slate-600/40" };
  return (
    <span className={`inline-flex items-center gap-1 text-[8px] font-semibold px-1.5 py-0.5 rounded border ${meta.cls}`}>
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: "currentColor" }} />
      {meta.label}
    </span>
  );
}

export default function IntermodalPage(props: IntermodalPageProps = {}) {
  const { routeIds, embedded = false, onApplyProposals, poiRadiusKm = 3 } = props;
  const routeIdsKey = routeIds && routeIds.length > 0 ? routeIds.join(",") : "";
  // Sezione del progetto Planner Studio: l'analisi gira sulla RETE di questo
  // progetto (feed materializzato) invece che su tutti i feed mescolati.
  const params = useParams<{ id?: string }>();
  const projectId = !embedded ? (params?.id ?? "") : "";
  const psQs = projectId ? `&psProjectId=${projectId}` : "";
  // Tipo di giorno analizzato: senza, si sommavano feriali+sabati+festivi.
  const [dayKind, setDayKind] = useState<"feriale" | "sabato" | "festivo">("feriale");
  /* Validità: più precisa del giorno-tipo, perché su uno stesso giorno
   * insistono più validità (scolastico, estivo, festivo) e sommarle darebbe
   * un orario che non esiste in nessun periodo. "" = giorno-tipo. */
  const [validities, setValidities] = useState<Array<{
    id: string; code: string; name: string | null; giorni?: string[];
    days: boolean[]; startDate: string | null; endDate: string | null; trips: number;
  }>>([]);
  const [calendarId, setCalendarId] = useState<string>("");
  /* Giorni-tipo del CALENDARIO AZIENDALE (Lu-Ve scuole chiuse, sabato
   * estivo, festivo…): è così che l'azienda ragiona sull'orario, non con
   * un feriale/sabato/festivo astratto. */
  const [dayTypes, setDayTypes] = useState<Array<{
    id: string; code: string; name: string; color: string | null; trips: number; giorni: number;
  }>>([]);
  const [categoryId, setCategoryId] = useState<string>("");
  const calQs = (calendarId ? `&calendarId=${calendarId}` : "")
    + (categoryId ? `&categoryId=${categoryId}` : "");
  /* Due letture della stessa rete: le coincidenze con treni/navi/voli, e la
   * copertura dei poli che generano la domanda (stazioni, aeroporti, scuole,
   * lavoro). La seconda è quella che dice se le corse costruite servono. */
  const [view, setView] = useState<"coincidenze" | "copertura" | "orari">("copertura");
  const [demand, setDemand] = useState<DemandCoverageResult | null>(null);
  const [demandLoading, setDemandLoading] = useState(false);
  const [selectedGenerator, setSelectedGenerator] = useState<string | null>(null);
  /* POI cliccabile: prima erano puntini muti. Al click apriamo un popup che
   * dice CHE COSA è (nome, categoria, distanza dall'hub). */
  const [selectedPoi, setSelectedPoi] = useState<{ lng: number; lat: number; name: string; hasName: boolean; category: string; travelContext?: string; distKm: number | null } | null>(null);
  const [hoveringPoi, setHoveringPoi] = useState(false);

  /* ─── Selezione delle linee: pilota analisi E mappa ───────────────────
   * Vuoto = tutta la rete. La stessa selezione filtra copertura,
   * coincidenze e geometrie disegnate, così pannello e mappa raccontano
   * sempre la stessa cosa. */
  const [lines, setLines] = useState<NetworkLine[]>([]);
  const [linesLoading, setLinesLoading] = useState(false);
  const [selectedRoutes, setSelectedRoutes] = useState<Set<string>>(new Set());
  const [showLinesOnMap, setShowLinesOnMap] = useState(true);
  const selectedKey = useMemo(() => [...selectedRoutes].sort().join(","), [selectedRoutes]);
  const mapRef = useRef<MapRef>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("neon");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [radius, setRadius] = useState(0.5);
  const [selectedHub, setSelectedHub] = useState<string | null>(null);
  const [expandedHub, setExpandedHub] = useState<string | null>(null);
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  const [showSchedule, setShowSchedule] = useState(false);
  const [activeTab, setActiveTab] = useState<"arrivi" | "partenze" | "destinazioni" | "orari">("arrivi");

  // New states
  const [shapesGeoJSON, setShapesGeoJSON] = useState<any>(null);

  /* Colore del percorso sulla mappa = colore della linea nel selettore.
   * Il GTFS spesso non porta il colore: senza questa iniezione le linee
   * sarebbero tutte azzurre e non si potrebbe leggere la mappa insieme
   * all'elenco. (globalThis.Map: qui `Map` è il componente della mappa.) */
  const lineColorById = useMemo(() => {
    const m = new globalThis.Map<string, string>();
    lines.forEach((l, i) => m.set(l.routeId, lineColor(l, i)));
    return m;
  }, [lines]);

  const coloredShapes = useMemo(() => {
    if (!shapesGeoJSON?.features) return shapesGeoJSON;
    return {
      ...shapesGeoJSON,
      features: shapesGeoJSON.features.map((f: any) => {
        const rid = f?.properties?.routeId;
        const col = rid ? lineColorById.get(rid) : null;
        return col ? { ...f, properties: { ...f.properties, routeColor: col } } : f;
      }),
    };
  }, [shapesGeoJSON, lineColorById]);
  /* La visibilità dei percorsi ha UN solo comando, quello nel selettore
   * linee: averne due (qui e nei layer) portava a stati incoerenti. */
  const [hubPoisData, setHubPoisData] = useState<HubPoisGroup[]>([]);
  const [showPois, setShowPois] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState<string | null>(null);
  const [showInfoTooltip, setShowInfoTooltip] = useState(false);
  // Schedule settimanale (popup hub): cache per hubId + giorno selezionato
  type WeeklyHubSchedule = {
    hubId: string;
    source: string;
    dataTrust?: "reale" | "stima" | "assente";
    fetchedAt?: string | null;
    weekStart: string | null;
    weeklyDepartures: { destination: string; times: string[] }[][] | null;
    weeklyArrivals: { origin: string; times: string[] }[][] | null;
    typicalDepartures: { destination: string; times: string[] }[];
    typicalArrivals: { origin: string; times: string[] }[];
  };
  const [hubScheduleCache, setHubScheduleCache] = useState<Record<string, WeeklyHubSchedule | "loading" | "error">>({});
  const [weeklyDayIdx, setWeeklyDayIdx] = useState<number>(() => {
    // Default = giorno corrente (0=Lun..6=Dom)
    const js = new Date().getDay();
    return js === 0 ? 6 : js - 1;
  });

  // ─── Ambito geografico (Provincia / Comune / Linee selezionate) ──
  type ScopeMode = "province" | "municipality" | "routes";
  const initialScope: ScopeMode = routeIdsKey ? "routes" : "province";
  const [scopeMode, setScopeMode] = useState<ScopeMode>(initialScope);
  /* Un solo filtro linee per TUTTE le chiamate: la scelta esplicita del
   * selettore vince, altrimenti valgono le linee passate dal flusso
   * embedded, altrimenti tutta la rete. */
  const rawRouteIds = selectedKey
    || (routeIdsKey && scopeMode === "routes" ? routeIdsKey : "");
  /* Spuntare otto linee di fila non deve lanciare otto analisi: si aspetta
   * che la selezione si assesti. */
  const [effectiveRouteIds, setEffectiveRouteIds] = useState(rawRouteIds);
  useEffect(() => {
    const t = setTimeout(() => setEffectiveRouteIds(rawRouteIds), 400);
    return () => clearTimeout(t);
  }, [rawRouteIds]);
  const [municipality, setMunicipality] = useState<string>(""); // codice ISTAT 6-digit
  const [municipalities, setMunicipalities] = useState<{ code: string; name: string }[]>([]);
  const [discoveredHubs, setDiscoveredHubs] = useState<Array<{
    id: string; name: string; type: string; lat: number; lng: number;
    source: "curated" | "gtfs-auto"; description: string;
  }>>([]);

  useEffect(() => {
    let cancelled = false;
    setLinesLoading(true);
    const muniQs = scopeMode === "municipality" && municipality ? `&municipality=${encodeURIComponent(municipality)}` : "";
    fetch(`${getApiBase()}/api/intermodal/lines?day=${dayKind}${calQs}${psQs}${muniQs}`)
      .then(r => (r.ok ? r.json() : { lines: [] }))
      .then(d => { if (!cancelled) setLines(Array.isArray(d.lines) ? d.lines : []); })
      .catch(() => { if (!cancelled) setLines([]); })
      .finally(() => { if (!cancelled) setLinesLoading(false); });
    return () => { cancelled = true; };
  }, [dayKind, psQs, scopeMode, municipality]);

  useEffect(() => {
    if (!psQs) { setValidities([]); return; }
    let cancelled = false;
    fetch(`${getApiBase()}/api/intermodal/validities?${psQs.replace(/^&/, "")}`)
      .then(r => (r.ok ? r.json() : { validities: [] }))
      .then(d => { if (!cancelled) setValidities(Array.isArray(d.validities) ? d.validities : []); })
      .catch(() => { if (!cancelled) setValidities([]); });
    return () => { cancelled = true; };
  }, [psQs]);

  useEffect(() => {
    if (!psQs) { setDayTypes([]); return; }
    let cancelled = false;
    fetch(`${getApiBase()}/api/intermodal/day-types?${psQs.replace(/^&/, "")}`)
      .then(r => (r.ok ? r.json() : { dayTypes: [] }))
      .then(d => { if (!cancelled) setDayTypes(Array.isArray(d.dayTypes) ? d.dayTypes : []); })
      .catch(() => { if (!cancelled) setDayTypes([]); });
    return () => { cancelled = true; };
  }, [psQs]);

  // Carica lista comuni una sola volta
  useEffect(() => {
    fetch(`${getApiBase()}/api/intermodal/municipalities`)
      .then(r => r.json())
      .then(data => Array.isArray(data) && setMunicipalities(data))
      .catch(() => { /* silent */ });
  }, []);

  // ─── Fetch analysis ──────────────────────────────────────
  const runAnalysis = useCallback(async () => {
    setLoading(true);
    try {
      const routeIdsQs = effectiveRouteIds ? `&routeIds=${encodeURIComponent(effectiveRouteIds)}` : "";
      const muniQs = scopeMode === "municipality" && municipality ? `&municipality=${encodeURIComponent(municipality)}` : "";
      const [analysisRes, shapesRes, poisRes, hubsRes, syncRes] = await Promise.all([
        fetch(`${getApiBase()}/api/intermodal/analyze?radius=${radius}&day=${dayKind}${calQs}${psQs}${muniQs}${routeIdsQs}`),
        fetch(`${getApiBase()}/api/intermodal/shapes?radius=${radius}${psQs}${muniQs}${routeIdsQs}`),
        fetch(`${getApiBase()}/api/intermodal/pois?radius=${poiRadiusKm}${psQs}${muniQs}${routeIdsQs}`),
        fetch(`${getApiBase()}/api/intermodal/hubs?${(psQs + muniQs + routeIdsQs).replace(/^&/, "")}`),
        fetch(`${getApiBase()}/api/intermodal/sync-status`),
      ]);
      const [data, shapes, pois, hubsData, syncStatus] = await Promise.all([
        analysisRes.json().catch(() => null), shapesRes.json().catch(() => null),
        poisRes.json().catch(() => null), hubsRes.json().catch(() => null),
        syncRes.json().catch(() => null),
      ]);

      /* Una risposta di ERRORE non è un risultato: prima veniva messa in
       * stato comunque, e al primo render `result.hubs.map` andava su
       * undefined facendo cadere l'intera pagina. Un 500 del backend deve
       * restare un messaggio, non una schermata bianca. */
      if (!analysisRes.ok || !data || !Array.isArray(data.hubs)) {
        setResult(null);
        toast.error("Analisi coincidenze non disponibile", {
          description: data?.error ?? data?.detail ?? `Il server ha risposto ${analysisRes.status}.`,
        });
      } else {
        setResult(data);
      }

      setShapesGeoJSON(shapesRes.ok && shapes?.features ? shapes : null);
      setHubPoisData(poisRes.ok && Array.isArray(pois?.hubPois) ? pois.hubPois : []);
      setDiscoveredHubs(hubsRes.ok && Array.isArray(hubsData) ? hubsData : []);
      setLastSync(syncRes.ok ? syncStatus?.lastSyncedAt ?? null : null);
    } catch {
      setResult(null);
      toast.error("Errore nell'analisi intermodale");
    } finally {
      setLoading(false);
    }
  }, [radius, effectiveRouteIds, poiRadiusKm, scopeMode, municipality, dayKind, calQs, psQs]);

  useEffect(() => { runAnalysis(); }, [runAnalysis]);

  /* ─── Copertura dei poli attrattori ─── */
  const runDemand = useCallback(async () => {
    setDemandLoading(true);
    try {
      const routeIdsQs = effectiveRouteIds ? `&routeIds=${encodeURIComponent(effectiveRouteIds)}` : "";
      const muniQs = scopeMode === "municipality" && municipality ? `&municipality=${encodeURIComponent(municipality)}` : "";
      const r = await fetch(`${getApiBase()}/api/intermodal/demand-coverage?radius=${radius}&day=${dayKind}${calQs}${psQs}${muniQs}${routeIdsQs}`);
      const j = await r.json().catch(() => null);
      if (!r.ok || !j || !Array.isArray(j.generators)) {
        throw new Error(j?.error ?? j?.detail ?? `Il server ha risposto ${r.status}.`);
      }
      setDemand(j);
    } catch (e: any) {
      toast.error("Errore nel calcolo della copertura", { description: e?.message });
      setDemand(null);
    } finally { setDemandLoading(false); }
  }, [radius, dayKind, calQs, psQs, scopeMode, municipality, effectiveRouteIds]);

  useEffect(() => { if (view === "copertura") void runDemand(); }, [view, runDemand]);

  // ─── Ricentra mappa quando cambia ambito/hub ─────────────
  // Se ci sono hub nei risultati, calcola bounding box e fitBounds.
  // Così selezionando "Jesi" la mappa vola sopra la Stazione FS Jesi.
  useEffect(() => {
    if (!result || !result.hubs || result.hubs.length === 0) return;
    const lats = result.hubs.map(h => h.hub.lat);
    const lngs = result.hubs.map(h => h.hub.lng);
    if (lats.length === 0) return;
    const minLat = Math.min(...lats), maxLat = Math.max(...lats);
    const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
    // Se un solo hub, flyTo
    if (result.hubs.length === 1) {
      mapRef.current?.flyTo({
        center: [result.hubs[0].hub.lng, result.hubs[0].hub.lat],
        zoom: 14, duration: 1200,
      });
    } else {
      const padLat = (maxLat - minLat) * 0.2 + 0.005;
      const padLng = (maxLng - minLng) * 0.2 + 0.005;
      mapRef.current?.fitBounds(
        [[minLng - padLng, minLat - padLat], [maxLng + padLng, maxLat + padLat]],
        { padding: { top: 80, bottom: 80, left: 460, right: 80 }, duration: 1200, maxZoom: 14 },
      );
    }
  }, [result]);

  // Auto-sync hub schedules on mount (acquisisce orari treni/navi/aerei)
  // quando la pagina standalone viene aperta. In modalità embedded saltiamo
  // (l'owner del flusso decide quando sincronizzare).
  useEffect(() => {
    if (embedded) return;
    let cancelled = false;
    (async () => {
      try {
        const statusRes = await fetch(`${getApiBase()}/api/intermodal/sync-status`);
        const status = await statusRes.json();
        const hoursSince = status.lastSyncedAt
          ? (Date.now() - new Date(status.lastSyncedAt).getTime()) / 36e5
          : Infinity;
        // Ri-sincronizza se mai fatto o se passate più di 6 ore
        if (hoursSince >= 6 && !cancelled) {
          await fetch(`${getApiBase()}/api/intermodal/sync-schedules`, { method: "POST" });
          if (!cancelled) {
            const s2 = await fetch(`${getApiBase()}/api/intermodal/sync-status`);
            const d2 = await s2.json();
            setLastSync(d2.lastSyncedAt);
          }
        }
      } catch { /* silent */ }
    })();
    return () => { cancelled = true; };
  }, [embedded]);

  /** Le proposte sono modifiche d'orario: si portano in Corse. In attesa di
   *  un'applicazione automatica, si esportano in un formato incollabile. */
  const copyProposals = useCallback(async (props: AnalysisResult["proposedSchedule"]) => {
    const csv = [
      "azione;orario_attuale;orario_proposto;hub;motivo;impatto",
      ...props.map(p => [
        p.action === "add" ? "nuova corsa" : p.action === "shift" ? "sposta" : "estendi",
        p.currentTime ?? "", p.proposedTime, p.hubName,
        p.reason.replace(/;/g, ","), p.impact.replace(/;/g, ","),
      ].join(";")),
    ].join("\n");
    try {
      await navigator.clipboard.writeText(csv);
      toast.success(`${props.length} proposte copiate`, { description: "Incollale in un foglio o portale nella sezione Corse." });
    } catch {
      toast.error("Impossibile copiare negli appunti");
    }
  }, []);

  const syncSchedules = useCallback(async () => {
    setSyncing(true);
    try {
      const muniQs = scopeMode === "municipality" && municipality ? `?municipality=${encodeURIComponent(municipality)}` : "";
      const r = await fetch(`${getApiBase()}/api/intermodal/sync-schedules${muniQs}`, { method: "POST" });
      const data = await r.json();
      if (data.success) {
        setLastSync(data.syncedAt);
        // Mostra riepilogo sync (quanti hub fetched live + giorni della settimana coperti)
        if (data.summary && data.summary.liveFetched > 0) {
          const liveHubs = (data.hubs || []).filter((h: any) => h.source === "live");
          const totalDays = liveHubs.reduce((s: number, h: any) => s + (h.daysCovered || 0), 0);
          const avgDays = liveHubs.length > 0 ? (totalDays / liveHubs.length).toFixed(1) : "0";
          const weekStart = liveHubs[0]?.weekStart;
          const totalDeps = liveHubs.reduce((s: number, h: any) => s + (h.departures || 0), 0);
          const totalArrs = liveHubs.reduce((s: number, h: any) => s + (h.arrivals || 0), 0);
          console.info(`[Intermodal] Sync OK: ${data.summary.liveFetched} hub aggiornati da API live (${data.summary.total} totali) — copertura media ${avgDays}/7 giorni${weekStart ? ` (settimana del ${weekStart})` : ""}`);
          toast.success(`Sincronizzati ${data.summary.liveFetched} hub ferroviari`, {
            description: `${totalDeps} partenze · ${totalArrs} arrivi · ${avgDays}/7 giorni della settimana${weekStart ? ` (dal ${weekStart})` : ""}${data.summary.skipped > 0 ? ` · ${data.summary.skipped} hub senza API live (porti/aeroporti)` : ""}`,
            duration: 6000,
          });
        } else if (data.summary) {
          toast.info(data.message || "Sync completato", {
            description: `${data.summary.total} hub processati, nessun fetch live disponibile`,
          });
        }
        await runAnalysis();
      }
    } catch {
      toast.error("Errore sincronizzazione orari");
    } finally {
      setSyncing(false);
    }
  }, [runAnalysis, scopeMode, municipality]);

  // Fetch on-demand dello schedule settimanale di un singolo hub.
  // NIENTE auto-fetch: l'utente deve cliccare il pulsante "Carica orari treni"
  // nel pannello hub. Questo evita richieste invasive ad ogni selezione.
  const loadHubSchedule = useCallback(async (hubId: string, force = false, silent = false) => {
    if (!force && hubScheduleCache[hubId] && hubScheduleCache[hubId] !== "error") return;
    setHubScheduleCache(prev => ({ ...prev, [hubId]: "loading" }));
    try {
      const r = await fetch(`${getApiBase()}/api/intermodal/hub-schedule/${encodeURIComponent(hubId)}`);
      if (!r.ok) {
        setHubScheduleCache(prev => ({ ...prev, [hubId]: "error" }));
        // Il caricamento in blocco (vista "Orari") non deve inondare di toast:
        // per i nodi senza orario mostra solo lo stato inline.
        if (!silent) toast.error("Orari non disponibili", { description: "Premi 'Sincronizza orari' nella toolbar in alto." });
        return;
      }
      const data = await r.json();
      setHubScheduleCache(prev => ({ ...prev, [hubId]: data }));
      // Auto-seleziona il primo giorno con dati
      if (data.weeklyDepartures && data.weeklyArrivals) {
        const firstWithData = (data.weeklyDepartures as any[]).findIndex((dd, i) =>
          dd.length > 0 || (data.weeklyArrivals as any[])[i].length > 0
        );
        if (firstWithData >= 0) setWeeklyDayIdx(firstWithData);
      }
    } catch {
      setHubScheduleCache(prev => ({ ...prev, [hubId]: "error" }));
    }
  }, [hubScheduleCache]);

  /* Quando si apre il quadro "Orari", tira giù gli orari dei nodi con un
   * orario noto (stazioni ferroviarie live/curate, porto e aeroporto curati)
   * che non li hanno ancora in cache: così la scheda si popola da sola senza
   * dover aprire ogni hub a mano. In "silent" per non inondare di toast. */
  useEffect(() => {
    if (view !== "orari" || !result) return;
    for (const h of result.hubs) {
      const hasSchedule = h.hub.type === "railway" || h.hub.source === "curated";
      if (hasSchedule && !hubScheduleCache[h.hub.id]) {
        void loadHubSchedule(h.hub.id, false, true);
      }
    }
  }, [view, result, hubScheduleCache, loadHubSchedule]);

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
        properties: {
          name: p.name || "", hasName: p.name ? 1 : 0, category: p.category,
          travelContext: p.travelContext, distKm: p.distKm ?? null,
        },
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
    <div className="w-full h-full flex flex-col overflow-hidden">
      {projectId && <PsProjectNav projectId={projectId} active="intermodal" />}
      <div className="relative flex-1 overflow-hidden">
      {/* ── Map ───────────────────────────────────────────── */}
      <Map
        ref={mapRef}
        initialViewState={{ longitude: 13.46, latitude: 43.615, zoom: 12, pitch: 45, bearing: -15 }}
        mapStyle={MAP_STYLES[viewMode]}
        mapboxAccessToken={MAPBOX_TOKEN}
        style={{ width: "100%", height: "100%" }}
        interactiveLayerIds={showPois ? ["poi-markers-dot"] : []}
        cursor={hoveringPoi ? "pointer" : undefined}
        onMouseMove={(e) => setHoveringPoi(!!e.features?.length)}
        onClick={(e) => {
          const f = e.features?.[0];
          if (f && f.layer?.id === "poi-markers-dot") {
            const pr = f.properties as any;
            const c = (f.geometry as any)?.coordinates;
            setSelectedPoi({
              lng: c?.[0], lat: c?.[1],
              name: pr?.name ?? "", hasName: !!Number(pr?.hasName),
              category: pr?.category ?? "", travelContext: pr?.travelContext,
              distKm: pr?.distKm != null && pr?.distKm !== "" ? Number(pr.distKm) : null,
            });
          }
        }}
        fog={{ color: "rgb(10, 10, 30)", "high-color": "rgb(20, 10, 50)", "horizon-blend": 0.08, "star-intensity": 0.2 } as any}
      >
        <Source id="mapbox-dem" type="raster-dem" url="mapbox://mapbox.mapbox-terrain-dem-v1" tileSize={512} maxzoom={14} />

        {/* ── BUS ROUTE SHAPES — Neon Glow Effect ── */}
        {showLinesOnMap && coloredShapes && coloredShapes.features?.length > 0 && (
          <Source id="bus-routes" type="geojson" data={coloredShapes}>
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

        {/* ── POPUP POI: dice CHE COSA è il puntino ── */}
        {selectedPoi && selectedPoi.lng != null && (
          <Popup longitude={selectedPoi.lng} latitude={selectedPoi.lat} anchor="bottom"
            offset={12} closeButton onClose={() => setSelectedPoi(null)} className="poi-popup">
            <div className="px-2 py-1.5 min-w-[150px]">
              <div className="flex items-center gap-1.5 mb-0.5">
                <span style={{ color: POI_ICONS[selectedPoi.category]?.color ?? "#888" }}>
                  {POI_ICONS[selectedPoi.category]?.icon}
                </span>
                <span className="text-xs font-bold text-slate-100">
                  {selectedPoi.hasName ? selectedPoi.name : <span className="italic text-slate-400">Senza nome</span>}
                </span>
              </div>
              <p className="text-[10px] text-slate-400">
                {POI_ICONS[selectedPoi.category]?.label ?? selectedPoi.category}
                {selectedPoi.distKm != null ? ` · ${Math.round(selectedPoi.distKm * 1000)} m dall'hub` : ""}
              </p>
              {selectedPoi.travelContext && (
                <p className="text-[9px] text-slate-500 mt-0.5">{selectedPoi.travelContext}</p>
              )}
            </div>
          </Popup>
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

        {/* ── Poli attrattori: colore = verdetto di copertura ──
             In vista "copertura" i marker degli hub lasciano il posto ai poli
             (stazioni, aeroporti, scuole, lavoro): sulla mappa si legge subito
             DOVE la domanda resta scoperta. */}
        {view === "copertura" && demand?.generators.map(g => {
          const col = g.status === "servito" ? "#10b981" : g.status === "parziale" ? "#f59e0b" : "#ef4444";
          const sel = selectedGenerator === g.generator.id;
          return (
            <Marker key={g.generator.id} longitude={g.generator.lng} latitude={g.generator.lat} anchor="center">
              <div
                onClick={() => { setSelectedGenerator(g.generator.id); }}
                title={`${g.generator.name} — ${g.status}`}
                className="cursor-pointer rounded-full border-2 flex items-center justify-center transition-all"
                style={{
                  width: sel ? 22 : 14, height: sel ? 22 : 14,
                  background: `${col}33`, borderColor: col,
                  boxShadow: sel ? `0 0 0 5px ${col}33, 0 0 14px ${col}` : `0 0 8px ${col}88`,
                }}
              >
                {sel && <div className="rounded-full" style={{ width: 6, height: 6, background: col }} />}
              </div>
            </Marker>
          );
        })}

        {/* Hub Markers — visibili sia in "coincidenze" sia nel quadro "Orari",
             così la mappa resta un riferimento mentre si leggono i tabelloni. */}
        {(view === "coincidenze" || view === "orari") && result?.hubs.map(h => {
          const isAuto = (h.hub as any).source === "gtfs-auto";
          const pct = h.arrivalStats.totalArrivals > 0 ? h.arrivalStats.ok / h.arrivalStats.totalArrivals : 0;
          // Per hub auto-detected usiamo il serviceScore (0-100) → normalizziamo 0-1 per status
          const score = (h as any).serviceScore?.score as number | undefined;
          const metric = isAuto && score != null ? score / 100 : pct;
          const hasMetric = isAuto ? score != null : h.arrivalStats.totalArrivals > 0;
          const statusColor = metric >= 0.7 ? "border-emerald-400" : metric >= 0.4 ? "border-amber-400" : "border-red-500";
          const glowColor = hubGlowColor(h.hub.type);
          return (
            <Marker key={h.hub.id} longitude={h.hub.lng} latitude={h.hub.lat} anchor="center"
              onClick={e => { e.originalEvent.stopPropagation(); setSelectedHub(h.hub.id); setExpandedHub(h.hub.id); }}>
              <div className={`relative cursor-pointer transition-transform hover:scale-110 ${selectedHub === h.hub.id ? "scale-125" : ""}`}>
                <div className="absolute inset-0 -m-3 rounded-full animate-ping opacity-15" style={{ backgroundColor: glowColor }} />
                <div className="absolute inset-0 -m-2 rounded-full animate-pulse opacity-25" style={{ backgroundColor: glowColor }} />
                <div className={`relative z-10 w-11 h-11 rounded-full flex items-center justify-center shadow-xl ${isAuto ? "border-2 border-dashed" : "border-2"} ${statusColor}`}
                  style={{ backgroundColor: HUB_COLORS[h.hub.type] + (isAuto ? "aa" : "ee"), boxShadow: `0 0 20px ${glowColor}, 0 0 40px ${glowColor}` }}>
                  {hubIcon(h.hub.type, "w-5 h-5 text-white drop-shadow-lg")}
                </div>
                <div className={`absolute -bottom-1.5 -right-1.5 text-[7px] font-bold w-5 h-5 rounded-full flex items-center justify-center z-20 border border-black ${
                  metric >= 0.7 ? "bg-emerald-500 text-white" : metric >= 0.4 ? "bg-amber-500 text-black" : "bg-red-500 text-white"
                }`} style={{ boxShadow: "0 0 6px rgba(0,0,0,0.5)" }}>
                  {hasMetric ? Math.round(metric * 100) + (isAuto ? "" : "%") : "—"}
                </div>
              </div>
            </Marker>
          );
        })}

        {/* ── I vecchi marker "discoveredHubs" separati non servono più: ─── */}
        {/*    /analyze ora restituisce anche gli hub auto-detected.       */}

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

              {/* ── Orari settimanali (live da ViaggiaTreno per hub ferroviari) ── */}
              {(() => {
                const sched = hubScheduleCache[selectedHubData.hub.id];
                if (!sched) return null;
                if (sched === "loading") {
                  return (
                    <div className="px-4 pb-3 text-[10px] text-slate-400 flex items-center gap-2">
                      <Loader2 className="w-3 h-3 animate-spin" /> Caricamento orari…
                    </div>
                  );
                }
                if (sched === "error") {
                  return (
                    <div className="px-4 pb-3 text-[10px] text-amber-400">
                      Orari non disponibili. Premi "Sincronizza" per scaricarli.
                    </div>
                  );
                }
                const weekly = sched.weeklyDepartures && sched.weeklyArrivals;
                const dayLabels = ["Lun", "Mar", "Mer", "Gio", "Ven", "Sab", "Dom"];
                if (!weekly) {
                  // Hub curato (typical only) — mostra prime 8 partenze
                  const dep = sched.typicalDepartures || [];
                  if (dep.length === 0) return null;
                  return (
                    <div className="px-4 pb-3">
                      <p className="text-[10px] font-bold text-slate-300 uppercase tracking-wider mb-1.5">Orari indicativi</p>
                      <div className="space-y-1 max-h-32 overflow-y-auto pr-1">
                        {dep.slice(0, 4).map((d, i) => (
                          <div key={i} className="flex items-start gap-2 text-[10px]">
                            <span className="text-cyan-400 font-medium min-w-[60px] truncate">{d.destination}</span>
                            <span className="text-slate-300 font-mono">{d.times.slice(0, 6).join(" · ")}{d.times.length > 6 ? "…" : ""}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                }
                const dayDepartures = sched.weeklyDepartures![weeklyDayIdx] || [];
                const dayArrivals = sched.weeklyArrivals![weeklyDayIdx] || [];
                const totalDep = dayDepartures.reduce((s, d) => s + d.times.length, 0);
                const totalArr = dayArrivals.reduce((s, a) => s + a.times.length, 0);
                return (
                  <div className="px-4 pb-3">
                    <div className="flex items-center justify-between mb-1.5">
                      <p className="text-[10px] font-bold text-slate-300 uppercase tracking-wider flex items-center gap-1">
                        <Clock className="w-3 h-3" /> Orari settimanali
                      </p>
                      {sched.weekStart && (
                        <span className="text-[9px] text-slate-500">sett. {sched.weekStart}</span>
                      )}
                    </div>
                    {/* Tab giorni */}
                    <div className="flex gap-1 mb-2">
                      {dayLabels.map((lbl, i) => {
                        const has = (sched.weeklyDepartures![i] || []).length > 0 || (sched.weeklyArrivals![i] || []).length > 0;
                        const active = i === weeklyDayIdx;
                        return (
                          <button key={i} onClick={() => setWeeklyDayIdx(i)}
                            className={`flex-1 text-[9px] py-1 rounded transition ${active ? "bg-cyan-500/30 text-cyan-200 font-bold" : has ? "bg-slate-800/60 text-slate-400 hover:bg-slate-700/60" : "bg-slate-900/40 text-slate-600"}`}>
                            {lbl}
                          </button>
                        );
                      })}
                    </div>
                    <div className="text-[9px] text-slate-500 mb-1.5">
                      {totalDep} partenze · {totalArr} arrivi
                    </div>
                    {totalDep === 0 && totalArr === 0 ? (
                      <p className="text-[10px] text-slate-500 italic">
                        Nessun dato per {dayLabels[weeklyDayIdx]}.
                        {sched.weekStart && (() => {
                          const weekStartDate = new Date(sched.weekStart);
                          const dayDate = new Date(weekStartDate);
                          dayDate.setDate(weekStartDate.getDate() + weeklyDayIdx);
                          const today = new Date(); today.setHours(0,0,0,0);
                          if (dayDate < today) return " (giorno passato — l'API live non fornisce dati storici)";
                          return null;
                        })()}
                      </p>
                    ) : (
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <p className="text-[9px] text-emerald-400 font-bold mb-0.5">PARTENZE</p>
                          <div className="space-y-0.5 max-h-32 overflow-y-auto pr-1">
                            {dayDepartures.slice(0, 6).map((d, i) => (
                              <div key={i} className="text-[9px]">
                                <span className="text-emerald-300 font-medium block truncate">{d.destination}</span>
                                <span className="text-slate-400 font-mono">{d.times.slice(0, 4).join(" ")}{d.times.length > 4 ? "…" : ""}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                        <div>
                          <p className="text-[9px] text-sky-400 font-bold mb-0.5">ARRIVI</p>
                          <div className="space-y-0.5 max-h-32 overflow-y-auto pr-1">
                            {dayArrivals.slice(0, 6).map((a, i) => (
                              <div key={i} className="text-[9px]">
                                <span className="text-sky-300 font-medium block truncate">{a.origin}</span>
                                <span className="text-slate-400 font-mono">{a.times.slice(0, 4).join(" ")}{a.times.length > 4 ? "…" : ""}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                    )}
                    <div className="mt-1.5"><TrustChip trust={sched.dataTrust ?? (sched.source === "curated" ? "stima" : sched.source === "live" ? "reale" : "assente")} fetchedAt={sched.fetchedAt} /></div>
                  </div>
                );
              })()}

              {/* ── Service Score (per hub auto-detected senza orari curati) ── */}
              {(() => {
                const ss = (selectedHubData as any).serviceScore as {
                  score: number; hoursCovered: number; linesServing: number;
                  destinationsReached: number; avgFrequencyMin: number | null;
                  level: "eccellente" | "buono" | "sufficiente" | "carente" | "assente";
                } | null;
                if (!ss) return null;
                const levelColor =
                  ss.level === "eccellente" ? "#22c55e" :
                  ss.level === "buono" ? "#84cc16" :
                  ss.level === "sufficiente" ? "#eab308" :
                  ss.level === "carente" ? "#f97316" : "#ef4444";
                return (
                  <div className="mx-4 mb-3 p-3 rounded-lg border"
                    style={{ backgroundColor: levelColor + "11", borderColor: levelColor + "44" }}>
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-[10px] font-semibold text-slate-300 flex items-center gap-1.5">
                        <Zap className="w-3 h-3" style={{ color: levelColor }} />
                        Copertura servizio urbano
                      </p>
                      <span className="text-[9px] font-bold uppercase tracking-wider px-2 py-0.5 rounded"
                        style={{ backgroundColor: levelColor + "33", color: levelColor }}>
                        {ss.level}
                      </span>
                    </div>
                    <div className="flex items-end gap-3">
                      <div>
                        <p className="text-2xl font-bold" style={{ color: levelColor }}>{ss.score}<span className="text-xs text-slate-500">/100</span></p>
                      </div>
                      <div className="flex-1 grid grid-cols-2 gap-1 text-[9px] text-slate-400">
                        <div><span className="text-slate-200 font-semibold">{ss.linesServing}</span> linee</div>
                        <div><span className="text-slate-200 font-semibold">{ss.destinationsReached}</span> destinazioni</div>
                        <div><span className="text-slate-200 font-semibold">{ss.hoursCovered}/17</span> ore coperte</div>
                        {ss.avgFrequencyMin != null && (
                          <div>Freq. <span className="text-slate-200 font-semibold">~{ss.avgFrequencyMin} min</span></div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })()}

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
                {/* ─── Che cosa si sta valutando ─── */}
                <div className="flex gap-1 p-0.5 rounded-lg bg-slate-900/60 border border-slate-700/40">
                  {([
                    { k: "copertura" as const, label: "Copertura domanda", tip: "Le linee e le corse costruite servono stazioni, aeroporti, scuole e aree di lavoro?" },
                    { k: "coincidenze" as const, label: "Coincidenze", tip: "Chi arriva in treno, nave o aereo trova un bus?" },
                    { k: "orari" as const, label: "Orari", tip: "Il quadro orario: treni e tue corse bus affiancati, nodo per nodo." },
                  ]).map(o => (
                    <button key={o.k} title={o.tip} onClick={() => setView(o.k)}
                      className={`flex-1 text-[10px] px-2 py-1.5 rounded-md transition-all ${
                        view === o.k
                          ? "bg-cyan-500/20 text-cyan-300 font-semibold border border-cyan-500/40"
                          : "text-slate-400 hover:text-slate-200 border border-transparent"
                      }`}>{o.label}</button>
                  ))}
                </div>

                {/* ─── Su quali linee ─── */}
                <LinePicker
                  lines={lines} loading={linesLoading}
                  selected={selectedRoutes} onChange={setSelectedRoutes}
                  showOnMap={showLinesOnMap} onToggleMap={setShowLinesOnMap}
                  day={dayKind}
                />

                {/* Sync + Radius + Toggles */}
                <div className="space-y-2">
                  {/* ─── Ambito geografico ───────────────────────── */}
                  <div className="bg-slate-800/60 rounded-lg px-3 py-2 border border-slate-700/40 space-y-1.5">
                    <div className="flex items-center gap-2">
                      <MapPinned className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                      <p className="text-[10px] text-slate-300 font-medium">Ambito analisi</p>
                      {discoveredHubs.length > 0 && (
                        <span className="ml-auto text-[9px] text-slate-500">
                          {discoveredHubs.length} hub
                          {discoveredHubs.filter(h => h.source === "gtfs-auto").length > 0 &&
                            ` (${discoveredHubs.filter(h => h.source === "gtfs-auto").length} auto)`}
                        </span>
                      )}
                    </div>
                    <div className="flex gap-1">
                      <button
                        onClick={() => setScopeMode("province")}
                        className={`flex-1 text-[9px] px-2 py-1 rounded font-medium transition-all border ${
                          scopeMode === "province"
                            ? "bg-cyan-500/20 text-cyan-400 border-cyan-500/30"
                            : "bg-slate-900/40 text-slate-500 border-slate-700/30 hover:text-slate-300"
                        }`}
                      >Provincia</button>
                      <button
                        onClick={() => setScopeMode("municipality")}
                        className={`flex-1 text-[9px] px-2 py-1 rounded font-medium transition-all border ${
                          scopeMode === "municipality"
                            ? "bg-cyan-500/20 text-cyan-400 border-cyan-500/30"
                            : "bg-slate-900/40 text-slate-500 border-slate-700/30 hover:text-slate-300"
                        }`}
                      >Comune</button>
                      {routeIdsKey && (
                        <button
                          onClick={() => setScopeMode("routes")}
                          className={`flex-1 text-[9px] px-2 py-1 rounded font-medium transition-all border ${
                            scopeMode === "routes"
                              ? "bg-cyan-500/20 text-cyan-400 border-cyan-500/30"
                              : "bg-slate-900/40 text-slate-500 border-slate-700/30 hover:text-slate-300"
                          }`}
                        >Linee sel.</button>
                      )}
                    </div>
                    {scopeMode === "municipality" && (
                      <select
                        value={municipality}
                        onChange={e => setMunicipality(e.target.value)}
                        className="w-full text-[10px] bg-slate-900/60 text-slate-200 border border-slate-700/50 rounded px-2 py-1 focus:outline-none focus:border-cyan-500/50"
                      >
                        <option value="">— Seleziona comune —</option>
                        {municipalities.map(m => (
                          <option key={m.code} value={m.code}>{m.name}</option>
                        ))}
                      </select>
                    )}
                  </div>

                  {/* ── UN SOLO controllo "Periodo analizzato" ──────────────
                      Prima c'erano tre selettori sovrapposti (giorno-tipo
                      aziendale / validità / giorno generico) che si
                      oscuravano a vicenda. Ora uno solo, con gruppi ordinati
                      dal più fedele al più grezzo. La scelta è mutuamente
                      esclusiva: sceglierne una azzera le altre. */}
                  <div className="bg-slate-800/60 rounded-lg px-3 py-2 border border-slate-700/40 space-y-1.5">
                    <p className="text-[10px] text-slate-300 font-medium">Periodo analizzato</p>
                    <select
                      value={categoryId ? `cat:${categoryId}` : calendarId ? `cal:${calendarId}` : `day:${dayKind}`}
                      onChange={e => {
                        const v = e.target.value;
                        if (v.startsWith("cat:")) { setCategoryId(v.slice(4)); setCalendarId(""); }
                        else if (v.startsWith("cal:")) { setCalendarId(v.slice(4)); setCategoryId(""); }
                        else { setDayKind(v.slice(4) as "feriale" | "sabato" | "festivo"); setCategoryId(""); setCalendarId(""); }
                      }}
                      className="w-full text-[10px] bg-slate-900/60 text-slate-200 border border-slate-700/50 rounded px-2 py-1 focus:outline-none focus:border-cyan-500/50">
                      {dayTypes.length > 0 && (
                        <optgroup label="Giorno-tipo aziendale (consigliato)">
                          {dayTypes.map(d => (
                            <option key={d.id} value={`cat:${d.id}`}>
                              {d.name} · {d.trips} corse{d.giorni ? ` · ${d.giorni} gg/anno` : ""}
                            </option>
                          ))}
                        </optgroup>
                      )}
                      {validities.length > 0 && (
                        <optgroup label="Validità di servizio">
                          {validities.map(v => (
                            <option key={v.id} value={`cal:${v.id}`}>
                              {v.name || giorniLabel(v.days) || v.code} · {v.trips} corse
                            </option>
                          ))}
                        </optgroup>
                      )}
                      <optgroup label="Giorno generico (ripiego)">
                        <option value="day:feriale">Feriale</option>
                        <option value="day:sabato">Sabato</option>
                        <option value="day:festivo">Festivo</option>
                      </optgroup>
                    </select>
                    {/* Riga di tracciabilità: che cosa si sta davvero analizzando */}
                    {(() => {
                      if (categoryId) {
                        const d = dayTypes.find(x => x.id === categoryId);
                        return d ? <p className="text-[9px] text-emerald-400/80">Giorno-tipo aziendale: {d.name} — le corse di questa categoria.</p> : null;
                      }
                      if (calendarId) {
                        const v = validities.find(x => x.id === calendarId);
                        if (!v) return null;
                        return <p className="text-[9px] text-slate-500">Validità: {v.name || v.code}{v.startDate ? ` · ${v.startDate}→${v.endDate}` : ""}.</p>;
                      }
                      return <p className="text-[9px] text-amber-300/70">Giorno generico: somma le validità attive quel giorno — un orario che non esiste in nessun periodo. Scegli un giorno-tipo aziendale per un dato fedele.</p>;
                    })()}
                    {result?.scope && (
                      <p className="text-[8px] text-slate-500">
                        {result.scope.calendarApplied
                          ? `${result.scope.tripsConsidered} corse circolanti su ${result.scope.tripsBeforeCalendar} totali`
                          : "Calendario assente: conteggio su tutte le corse"}
                      </p>
                    )}
                  </div>

                  {/* Qualità del dato orari: distingue reale da stima */}
                  {result?.summary && (result.summary.hubsWithEstimatedSchedule ?? 0) > 0 && (
                    <div className="flex items-start gap-2 bg-amber-500/10 border border-amber-500/25 rounded-lg px-3 py-2">
                      <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />
                      <p className="text-[9px] text-amber-200/90 leading-relaxed">
                        {result.summary.hubsWithEstimatedSchedule} hub usano orari <strong>stimati</strong>, non ufficiali
                        {(result.summary.hubsWithLiveSchedule ?? 0) > 0 ? ` (${result.summary.hubsWithLiveSchedule} con orari reali)` : ""}.
                        Premi «Sincronizza» per scaricare gli orari veri delle stazioni da ViaggiaTreno.
                      </p>
                    </div>
                  )}

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
                    <button onClick={() => setShowPois(v => !v)}
                      className={`text-[9px] px-2 py-1 rounded-lg flex items-center gap-1 font-medium transition-all border ${
                        showPois ? "bg-violet-500/20 text-violet-400 border-violet-500/30" : "bg-slate-800/40 text-slate-500 border-slate-700/30"
                      }`}>
                      {showPois ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
                      POI ({hubPoisData.reduce((s, h) => s + h.pois.length, 0)})
                    </button>
                  </div>
                </div>

                {/* ─── QUADRO ORARI: treni/navi/voli + le corse bus del progetto ─── */}
                {view === "orari" && result && (
                  <div className="space-y-3">
                    <div className="rounded-xl p-3 border border-cyan-500/20"
                      style={{ background: "linear-gradient(135deg, rgba(6,182,212,0.1), rgba(139,92,246,0.08))" }}>
                      <p className="text-[10px] font-semibold text-cyan-400 uppercase tracking-wider mb-1 flex items-center gap-1.5">
                        <Clock className="w-3 h-3" /> Quadro orari — treni e tue corse
                      </p>
                      <p className="text-[10px] text-slate-400 leading-relaxed">
                        Nodo per nodo: gli orari di treni, navi e voli affiancati alle corse bus del tuo progetto.
                        Gli orari treni si aggiornano da ViaggiaTreno — se un nodo è vuoto, premi
                        {" "}<strong className="text-slate-200">Sincronizza orari</strong> nella toolbar in alto.
                      </p>
                    </div>

                    {(() => {
                      const TYPE_ORDER: Record<string, number> = { railway: 0, port: 1, airport: 2, bus_terminal: 3 };
                      const boardHubs = result.hubs
                        .filter(h => h.hub.type === "railway" || h.hub.type === "port" || h.hub.type === "airport")
                        .slice()
                        .sort((a, b) => (TYPE_ORDER[a.hub.type] ?? 9) - (TYPE_ORDER[b.hub.type] ?? 9));

                      if (boardHubs.length === 0) {
                        return (
                          <p className="text-[11px] text-slate-500 italic px-1">
                            Nessun nodo con orari (stazioni, porto, aeroporto) nell'ambito selezionato.
                            Allarga l'ambito o seleziona altre linee.
                          </p>
                        );
                      }

                      return boardHubs.map(hc => {
                        const sched = hubScheduleCache[hc.hub.id];
                        const ready = sched && sched !== "loading" && sched !== "error";
                        const arr = ready ? (sched.typicalArrivals || []) : [];
                        const dep = ready ? (sched.typicalDepartures || []) : [];
                        const nArr = arr.reduce((s, a) => s + a.times.length, 0);
                        const nDep = dep.reduce((s, d) => s + d.times.length, 0);
                        const nBus = hc.busLines.reduce((s, b) => s + b.times.length, 0);
                        const tLabel = hubTransportLabel(hc.hub.type); // treno / nave / volo
                        const emoji = hc.hub.type === "airport" ? "✈️" : hc.hub.type === "port" ? "⛴️" : "🚆";
                        const iconColor = hc.hub.type === "airport" ? "text-amber-400" : hc.hub.type === "port" ? "text-violet-400" : "text-cyan-400";
                        return (
                          <div key={hc.hub.id} className="rounded-xl border border-slate-700/40 bg-slate-900/40 overflow-hidden">
                            {/* Intestazione nodo */}
                            <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-700/40 bg-slate-800/40">
                              <span className={iconColor}>{hubIcon(hc.hub.type, "w-4 h-4")}</span>
                              <div className="flex-1 min-w-0">
                                <p className="text-[11px] font-bold text-white truncate">{shortHubName(hc.hub.name)}</p>
                                <p className="text-[8px] text-slate-500">{nArr} arrivi · {nDep} partenze {tLabel} · {nBus} corse bus</p>
                              </div>
                              {hc.hub.scheduleSource === "live" && (
                                <span className="text-[8px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 font-semibold shrink-0">live</span>
                              )}
                              {hc.hub.scheduleSource === "stima" && (
                                <span className="text-[8px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30 font-semibold shrink-0">stima</span>
                              )}
                              <button onClick={() => loadHubSchedule(hc.hub.id, true)} title="Aggiorna orari"
                                className="text-slate-400 hover:text-cyan-300 transition shrink-0">
                                <RefreshCw className="w-3 h-3" />
                              </button>
                            </div>

                            <div className="p-3 space-y-3">
                              {/* ── Orari treno/nave/volo ── */}
                              <div>
                                <p className="text-[9px] font-bold text-slate-400 uppercase tracking-wider mb-1.5">{emoji} Orari {tLabel}</p>
                                {(!sched || sched === "loading") ? (
                                  <p className="text-[10px] text-slate-500 italic flex items-center gap-1.5">
                                    <RefreshCw className="w-3 h-3 animate-spin" /> Carico gli orari…
                                    {hc.hub.type === "railway" && <span className="text-slate-600">(ViaggiaTreno, ~15-30s)</span>}
                                  </p>
                                ) : sched === "error" ? (
                                  <button onClick={() => loadHubSchedule(hc.hub.id, true)}
                                    className="w-full text-[10px] px-2 py-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20 transition flex items-center justify-center gap-1.5 font-semibold">
                                    <RefreshCw className="w-3 h-3" /> Orari non in cache — riprova o sincronizza
                                  </button>
                                ) : (arr.length === 0 && dep.length === 0) ? (
                                  <p className="text-[10px] text-slate-500 italic">Nessun orario disponibile per questo nodo.</p>
                                ) : (
                                  <div className="grid grid-cols-2 gap-2">
                                    <div>
                                      <p className="text-[8px] text-sky-400 font-bold mb-0.5">← ARRIVI</p>
                                      <div className="space-y-1 max-h-52 overflow-y-auto pr-1">
                                        {arr.length === 0 ? <p className="text-[9px] text-slate-500 italic">nessuno</p> : arr.map((a, i) => (
                                          <div key={i} className="text-[9px] leading-tight">
                                            <span className="text-sky-300 font-medium block truncate">← {a.origin}</span>
                                            <span className="text-slate-400 font-mono text-[8px] break-words">{a.times.join(" · ")}</span>
                                          </div>
                                        ))}
                                      </div>
                                    </div>
                                    <div>
                                      <p className="text-[8px] text-emerald-400 font-bold mb-0.5">PARTENZE →</p>
                                      <div className="space-y-1 max-h-52 overflow-y-auto pr-1">
                                        {dep.length === 0 ? <p className="text-[9px] text-slate-500 italic">nessuna</p> : dep.map((d, i) => (
                                          <div key={i} className="text-[9px] leading-tight">
                                            <span className="text-emerald-300 font-medium block truncate">→ {d.destination}</span>
                                            <span className="text-slate-400 font-mono text-[8px] break-words">{d.times.join(" · ")}</span>
                                          </div>
                                        ))}
                                      </div>
                                    </div>
                                  </div>
                                )}
                              </div>

                              {/* ── Le corse bus del progetto a questo nodo ── */}
                              <div>
                                <p className="text-[9px] font-bold text-slate-400 uppercase tracking-wider mb-1.5">🚌 Le tue corse</p>
                                {hc.busLines.length === 0 ? (
                                  <p className="text-[10px] text-slate-500 italic">Nessuna corsa bus nel raggio a piedi da questo nodo.</p>
                                ) : (
                                  <div className="space-y-1.5 max-h-64 overflow-y-auto pr-1">
                                    {hc.busLines.map(bl => {
                                      const dest = bl.destinations.filter(Boolean).join(" · ");
                                      const badgeColor = bl.routeColor ? `#${bl.routeColor.replace("#", "")}` : "#94a3b8";
                                      return (
                                        <div key={bl.routeId} className="rounded-lg bg-slate-800/40 border border-slate-700/30 px-2 py-1.5">
                                          <div className="flex items-center gap-1.5 mb-0.5">
                                            <span className="text-[9px] px-1.5 py-0.5 rounded font-bold shrink-0"
                                              style={{ backgroundColor: `${badgeColor}22`, color: badgeColor }}>{bl.routeShortName}</span>
                                            <span className="text-[9px] text-slate-300 truncate flex-1">{bl.routeLongName || dest || "—"}</span>
                                            <span className="text-[8px] text-slate-500 shrink-0">{bl.times.length} corse</span>
                                          </div>
                                          <p className="text-slate-400 font-mono text-[8px] leading-relaxed break-words">{bl.times.join(" · ")}</p>
                                        </div>
                                      );
                                    })}
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>
                        );
                      });
                    })()}
                  </div>
                )}

                {view === "copertura" && (
                  <DemandCoverage
                    data={demand} loading={demandLoading}
                    onFocus={(lat, lng, id) => {
                      setSelectedGenerator(id);
                      mapRef.current?.flyTo({ center: [lng, lat], zoom: 15, duration: 900 });
                    }}
                  />
                )}

                {view === "coincidenze" && result && (
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

                    {/* ── Riepilogo PER LINEA: quali linee agganciano i treni ── */}
                    {(() => {
                      // NB: in questo file `Map` è l'icona lucide-react (shadow del Map globale),
                      // quindi si usa un oggetto semplice per il pivot.
                      const byLine: Record<string, { ok: number; missed: number; hubs: string[] }> = {};
                      const bump = (line: string | undefined | null, kind: "ok" | "missed", hub: string) => {
                        if (!line) return;
                        const e = byLine[line] ?? (byLine[line] = { ok: 0, missed: 0, hubs: [] });
                        e[kind]++; if (!e.hubs.includes(hub)) e.hubs.push(hub);
                      };
                      for (const hc of result.hubs) {
                        for (const ac of hc.arrivalConnections || []) {
                          if (ac.firstBus) bump(ac.firstBus.routeShortName, "ok", hc.hub.name);
                          else if (ac.justMissed?.[0]) bump(ac.justMissed[0].routeShortName, "missed", hc.hub.name);
                        }
                        for (const dc of hc.departureConnections || []) {
                          if (dc.bestBusArrival) bump(dc.bestBusRoute, "ok", hc.hub.name);
                        }
                      }
                      const rows = Object.entries(byLine).sort((a, b) => b[1].ok - a[1].ok);
                      if (rows.length === 0) return null;
                      return (
                        <div className="space-y-1.5">
                          <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">
                            Per linea {effectiveRouteIds ? "(selezionate)" : ""} · coincidenze coi treni
                          </p>
                          <div className="space-y-1">
                            {rows.map(([line, e]) => (
                              <div key={line} className="flex items-center gap-2 text-[9px] px-2 py-1 rounded-lg bg-slate-800/40 border border-slate-700/30">
                                <span className="font-bold text-amber-300 shrink-0">[{line}]</span>
                                {e.ok > 0 && <span className="text-emerald-400 font-semibold shrink-0">✓ {e.ok}</span>}
                                {e.missed > 0 && <span className="text-orange-400 font-semibold shrink-0">✗ {e.missed}</span>}
                                <span className="text-slate-500 truncate">· {[...e.hubs].join(", ")}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    })()}

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

                                    {/* Provenienza degli orari usati per le coincidenze di QUESTO hub:
                                        senza questa riga una tabella stimata sembra un orario ufficiale. */}
                                    {hc.hub.scheduleSource === "stima" && (
                                      <div className="flex items-start gap-1.5 rounded-lg bg-amber-500/10 border border-amber-500/25 px-2 py-1.5">
                                        <AlertTriangle className="w-3 h-3 text-amber-400 shrink-0 mt-0.5" />
                                        <p className="text-[9px] text-amber-200/90">
                                          Orari <strong>stimati</strong> (tabella interna, non ufficiale): le coincidenze qui sotto
                                          sono indicative. {hc.hub.type === "railway" ? "Sincronizza per scaricare l'orario reale." : "Per porti e aeroporti non esiste una fonte pubblica: inserisci gli orari nella zona di coincidenza."}
                                        </p>
                                      </div>
                                    )}
                                    {hc.hub.scheduleSource === "live" && (
                                      <p className="text-[9px] text-emerald-300/80 flex items-center gap-1">
                                        <Zap className="w-3 h-3" /> Orari reali da ViaggiaTreno
                                        {hc.hub.scheduleFetchedAt ? ` · ${new Date(hc.hub.scheduleFetchedAt).toLocaleDateString("it-IT")}` : ""}
                                      </p>
                                    )}
                                    {hc.hub.scheduleSource === "assente" && (
                                      <p className="text-[9px] text-slate-500">
                                        Nessun orario disponibile per questo nodo: si valuta solo la copertura del servizio bus.
                                      </p>
                                    )}

                                    {/* ── Orari live ViaggiaTreno per giorno della settimana ── */}
                                    {hc.hub.type === "railway" && (() => {
                                      const sched = hubScheduleCache[hc.hub.id];
                                      // Stato: niente in cache → bottone esplicito
                                      if (!sched) {
                                        return (
                                          <button onClick={e => { e.stopPropagation(); loadHubSchedule(hc.hub.id); }}
                                            className="w-full text-[10px] px-2 py-1.5 rounded-lg border border-cyan-500/40 bg-cyan-500/10 text-cyan-300 hover:bg-cyan-500/20 transition flex items-center justify-center gap-1.5 font-semibold">
                                            <TrainFront className="w-3 h-3" /> Carica orari treni (settimanale, live)
                                          </button>
                                        );
                                      }
                                      if (sched === "loading") {
                                        return <div className="text-[10px] text-slate-400 flex items-center gap-1.5 px-2 py-1.5"><Loader2 className="w-3 h-3 animate-spin" /> Scarico orari da ViaggiaTreno (~15-30s)…</div>;
                                      }
                                      if (sched === "error") {
                                        return (
                                          <button onClick={e => { e.stopPropagation(); loadHubSchedule(hc.hub.id, true); }}
                                            className="w-full text-[10px] px-2 py-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20 transition flex items-center justify-center gap-1.5 font-semibold">
                                            <RefreshCw className="w-3 h-3" /> Riprova caricamento orari
                                          </button>
                                        );
                                      }
                                      const wd = sched.weeklyDepartures, wa = sched.weeklyArrivals;
                                      if (!wd || !wa) return null;
                                      const dayLabels = ["Lun", "Mar", "Mer", "Gio", "Ven", "Sab", "Dom"];
                                      const dayDep = wd[weeklyDayIdx] || [];
                                      const dayArr = wa[weeklyDayIdx] || [];
                                      const totalDep = dayDep.reduce((s, d) => s + d.times.length, 0);
                                      const totalArr = dayArr.reduce((s, a) => s + a.times.length, 0);
                                      return (
                                        <div className="rounded-lg border border-cyan-500/20 bg-cyan-500/5 p-2 space-y-1.5">
                                          <div className="flex items-center justify-between gap-2">
                                            <p className="text-[9px] font-bold text-cyan-300 uppercase tracking-wider flex items-center gap-1">
                                              <Clock className="w-2.5 h-2.5" /> Orari treni — settimana {sched.weekStart || ""}
                                            </p>
                                            <button onClick={e => { e.stopPropagation(); loadHubSchedule(hc.hub.id, true); }}
                                              title="Aggiorna orari"
                                              className="text-[9px] text-slate-400 hover:text-cyan-300 transition flex items-center gap-1">
                                              <RefreshCw className="w-2.5 h-2.5" /> Aggiorna
                                            </button>
                                          </div>
                                          <div className="flex gap-0.5">
                                            {dayLabels.map((lbl, i) => {
                                              const has = (wd[i] || []).length > 0 || (wa[i] || []).length > 0;
                                              const active = i === weeklyDayIdx;
                                              return (
                                                <button key={i} onClick={e => { e.stopPropagation(); setWeeklyDayIdx(i); }}
                                                  className={`flex-1 text-[9px] py-0.5 rounded transition ${active ? "bg-cyan-500/40 text-white font-bold" : has ? "bg-slate-800/60 text-slate-300 hover:bg-slate-700/60" : "bg-slate-900/40 text-slate-600"}`}>
                                                  {lbl}
                                                </button>
                                              );
                                            })}
                                          </div>
                                          <div className="text-[9px] text-slate-400">
                                            {dayLabels[weeklyDayIdx]}: <span className="text-emerald-400 font-semibold">{totalDep}</span> partenze · <span className="text-sky-400 font-semibold">{totalArr}</span> arrivi
                                          </div>
                                          {totalDep === 0 && totalArr === 0 ? (
                                            <p className="text-[9px] text-slate-500 italic">Nessun dato per {dayLabels[weeklyDayIdx]}.</p>
                                          ) : (
                                            <div className="grid grid-cols-2 gap-1.5">
                                              <div>
                                                <p className="text-[8px] text-emerald-400 font-bold mb-0.5">PARTENZE</p>
                                                <div className="space-y-0.5 max-h-40 overflow-y-auto pr-1">
                                                  {dayDep.map((d, i) => (
                                                    <div key={i} className="text-[9px] leading-tight">
                                                      <span className="text-emerald-300 font-medium block truncate">→ {d.destination}</span>
                                                      <span className="text-slate-400 font-mono text-[8px]">{d.times.join(" · ")}</span>
                                                    </div>
                                                  ))}
                                                </div>
                                              </div>
                                              <div>
                                                <p className="text-[8px] text-sky-400 font-bold mb-0.5">ARRIVI</p>
                                                <div className="space-y-0.5 max-h-40 overflow-y-auto pr-1">
                                                  {dayArr.map((a, i) => (
                                                    <div key={i} className="text-[9px] leading-tight">
                                                      <span className="text-sky-300 font-medium block truncate">← {a.origin}</span>
                                                      <span className="text-slate-400 font-mono text-[8px]">{a.times.join(" · ")}</span>
                                                    </div>
                                                  ))}
                                                </div>
                                              </div>
                                            </div>
                                          )}
                                        </div>
                                      );
                                    })()}

                                    {/* Tabs */}
                                    <div className="flex gap-1 border-b border-slate-700/30 pb-1">
                                      {(["arrivi", "partenze", "destinazioni", "orari"] as const).map(tab => (
                                        <button key={tab} onClick={e => { e.stopPropagation(); setActiveTab(tab); if (tab === "orari" && !hubScheduleCache[hc.hub.id] && hc.hub.type === "railway") loadHubSchedule(hc.hub.id); }}
                                          className={`text-[9px] px-2 py-1 rounded-t font-semibold transition-colors ${activeTab === tab ? "bg-cyan-500/20 text-cyan-400 border-b-2 border-cyan-500" : "text-slate-500 hover:text-slate-300"}`}>
                                          {tab === "arrivi" ? `🚉 Arrivi (${hc.arrivalConnections.length})` : tab === "partenze" ? `🚌 Partenze (${hc.departureConnections.length})` : tab === "destinazioni" ? `📍 Dest. (${hc.destinationCoverage.length})` : `🚆 Orari`}
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

                                    {/* TAB: Orari treni COMPLETI della stazione (tutte le destinazioni/origini) */}
                                    {activeTab === "orari" && (() => {
                                      const sched = hubScheduleCache[hc.hub.id];
                                      if (hc.hub.type !== "railway") return <p className="text-[10px] text-slate-500 italic">Orari treni disponibili solo per le stazioni ferroviarie.</p>;
                                      if (sched === "loading" || !sched) return <p className="text-[10px] text-slate-500 italic flex items-center gap-1.5"><RefreshCw className="w-3 h-3 animate-spin" /> Carico gli orari…</p>;
                                      if (sched === "error") return <p className="text-[10px] text-red-400 italic">Errore nel caricamento degli orari.</p>;
                                      const dep = sched.typicalDepartures || [];
                                      const arr = sched.typicalArrivals || [];
                                      const nDep = dep.reduce((s, d) => s + d.times.length, 0);
                                      const nArr = arr.reduce((s, a) => s + a.times.length, 0);
                                      return (
                                        <div className="space-y-2">
                                          <p className="text-[8px] text-slate-500 flex items-center gap-1">{nArr} arrivi · {nDep} partenze <TrustChip trust={sched.dataTrust ?? (sched.source === "curated" ? "stima" : sched.source === "live" ? "reale" : "assente")} fetchedAt={sched.fetchedAt} /></p>
                                          <div className="grid grid-cols-2 gap-2">
                                            <div>
                                              <p className="text-[8px] text-sky-400 font-bold mb-0.5">🚆 ARRIVI</p>
                                              <div className="space-y-1 max-h-56 overflow-y-auto pr-1">
                                                {arr.length === 0 ? <p className="text-[9px] text-slate-500 italic">nessuno</p> : arr.map((a, i) => (
                                                  <div key={i} className="text-[9px] leading-tight">
                                                    <span className="text-sky-300 font-medium block truncate">← {a.origin}</span>
                                                    <span className="text-slate-400 font-mono text-[8px]">{a.times.join(" · ")}</span>
                                                  </div>
                                                ))}
                                              </div>
                                            </div>
                                            <div>
                                              <p className="text-[8px] text-emerald-400 font-bold mb-0.5">🚆 PARTENZE</p>
                                              <div className="space-y-1 max-h-56 overflow-y-auto pr-1">
                                                {dep.length === 0 ? <p className="text-[9px] text-slate-500 italic">nessuna</p> : dep.map((d, i) => (
                                                  <div key={i} className="text-[9px] leading-tight">
                                                    <span className="text-emerald-300 font-medium block truncate">→ {d.destination}</span>
                                                    <span className="text-slate-400 font-mono text-[8px]">{d.times.join(" · ")}</span>
                                                  </div>
                                                ))}
                                              </div>
                                            </div>
                                          </div>
                                        </div>
                                      );
                                    })()}

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

                              {/* Le proposte finivano in un vicolo cieco: la prop
                                  onApplyProposals esisteva ma non era mai invocata e
                                  fuori dal flusso embedded non c'era modo di usarle. */}
                              <div className="mt-2 flex items-center gap-2">
                                {onApplyProposals ? (
                                  <button
                                    onClick={() => onApplyProposals(result.proposedSchedule)}
                                    className="flex-1 text-[10px] font-semibold px-3 py-1.5 rounded-lg bg-violet-500/20 text-violet-300 border border-violet-500/40 hover:bg-violet-500/30 transition-all">
                                    Applica {result.proposedSchedule.length} proposte
                                  </button>
                                ) : (
                                  <button
                                    onClick={() => copyProposals(result.proposedSchedule)}
                                    className="flex-1 text-[10px] font-semibold px-3 py-1.5 rounded-lg bg-slate-800/80 text-slate-300 border border-slate-700/50 hover:bg-slate-700 transition-all">
                                    Copia l'elenco (CSV)
                                  </button>
                                )}
                                {projectId && (
                                  <a href={`/planning-studio/${projectId}/trips`}
                                    className="text-[10px] font-semibold px-3 py-1.5 rounded-lg bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 hover:bg-cyan-500/25 transition-all whitespace-nowrap">
                                    Vai a Corse →
                                  </a>
                                )}
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
              {view === "copertura" && (
                <div className="pt-1 border-t border-slate-700/30 space-y-1">
                  {([["#10b981", "Polo servito"], ["#f59e0b", "Parziale"], ["#ef4444", "Scoperto"]] as const).map(([c, lab]) => (
                    <div key={lab} className="flex items-center gap-2">
                      <div className="w-3 h-3 rounded-full border-2" style={{ borderColor: c, background: `${c}33` }} />
                      <span className="text-[10px] text-slate-400">{lab}</span>
                    </div>
                  ))}
                </div>
              )}
              {showLinesOnMap && (
                selectedRoutes.size > 0 ? (
                  /* Con una selezione esplicita la legenda nomina le linee:
                     così si sa quale traccia è quale, non solo che sono bus. */
                  <div className="space-y-1">
                    {lines.filter(l => selectedRoutes.has(l.routeId)).slice(0, 8).map(l => (
                      <div key={l.routeId} className="flex items-center gap-2">
                        <div className="w-5 h-0.5 rounded shrink-0"
                          style={{ background: lineColorById.get(l.routeId), boxShadow: `0 0 6px ${lineColorById.get(l.routeId)}` }} />
                        <span className="text-[10px] text-slate-400 truncate max-w-[110px]">{l.label}</span>
                      </div>
                    ))}
                    {selectedRoutes.size > 8 && (
                      <p className="text-[9px] text-slate-500">+{selectedRoutes.size - 8} altre linee</p>
                    )}
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <div className="w-5 h-0.5 rounded bg-cyan-400" style={{ boxShadow: "0 0 6px #06b6d4" }} />
                    <span className="text-[10px] text-slate-400">Percorsi bus (tutta la rete)</span>
                  </div>
                )
              )}
              {showPois && (
                <div className="pt-1 border-t border-slate-700/30 grid grid-cols-2 gap-x-2 gap-y-1">
                  {Object.entries(POI_ICONS).map(([cat, meta]) => (
                    <div key={cat} className="flex items-center gap-1.5">
                      <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: meta.color }} />
                      <span className="text-[9px] text-slate-400 truncate">{meta.label}</span>
                    </div>
                  ))}
                  <p className="col-span-2 text-[8px] text-slate-600">Clicca un punto per identificarlo.</p>
                </div>
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
    </div>
  );
}
