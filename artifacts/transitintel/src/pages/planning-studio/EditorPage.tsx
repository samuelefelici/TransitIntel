/**
 * PlannerStudio — Editor progetto.
 *
 * Layout: sidebar sx (tab Fermate / Linee / Calendari) + mappa Mapbox.
 *
 * Modalità (tool):
 *   - 'select'        — naviga, clicca elementi per vederli/modificarli
 *   - 'addStop'       — ogni clic sulla mappa apre mini-form nuova fermata
 *   - 'editVariant'   — editor variante: sequenza fermate (drag&drop sx) +
 *                       tracciatore percorso stile Google Maps (clic su mappa
 *                       aggiunge waypoint snap-ato via OSRM, drag waypoint per
 *                       spostare, toggle modalità manuale per tratti fuori rete)
 */
import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { useLocation, useParams } from "wouter";
import Map, {
  Marker, Source, Layer, NavigationControl, Popup,
  type MapRef, type MapMouseEvent,
} from "react-map-gl/mapbox";
import "mapbox-gl/dist/mapbox-gl.css";
import { motion, AnimatePresence } from "framer-motion";
import { toast } from "sonner";
import {
  ArrowLeft, MapPin, Bus, Calendar as CalendarIcon, Layers, Plus, Trash2,
  Save, X, Crosshair, Route as RouteIcon, GripVertical, Loader2, Check,
  PenLine, MousePointer2, Settings2, Users, Activity, ChevronRight,
  Palette, Upload, AlertTriangle, FileArchive, FolderOpen, Database,
  ChevronDown, Pencil, Search, Flame, Building2, Grip, Share2,
} from "lucide-react";
import SharePsProjectDialog from "@/components/planning-studio/SharePsProjectDialog";
import {
  getPsProject, type PsProject,
  listPsStops, createPsStop, updatePsStop, deletePsStop, type PsStop,
  listPsRoutes, createPsRoute, updatePsRoute, deletePsRoute, type PsRoute,
  listPsVariants, createPsVariant, getPsVariant, deletePsVariant,
  setPsVariantStops, setPsVariantShape, type PsVariant, type PsVariantStop,
  type PsWaypoint, type PsShape,
  routeSnap,
  listPsCalendars, createPsCalendar, deletePsCalendar, type PsCalendar,
  importPsGtfs, type PsImportCounts,
  listPsClusters, createPsCluster, updatePsCluster, deletePsCluster,
  setPsClusterStops, suggestPsClusters,
  type PsCluster, type PsClusterKind, type PsClusterSuggestion,
} from "@/lib/planning-studio-api";

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN || "";
const DEFAULT_VIEW = { longitude: 12.4964, latitude: 41.9028, zoom: 11 }; // Roma

type Tool = "select" | "addStop" | "editVariant";
type DataPanel = "stops" | "routes" | "calendars" | "clusters" | "ne-clusters" | "ne-depots" | null;

/* ─── Tipi cluster/depositi globali (Network Engine) ─── */
interface GlobalClusterStop { gtfsStopId: string; stopName: string; stopLat: number; stopLon: number; }
interface GlobalCluster {
  id: string; name: string; color: string;
  isInterchange?: boolean; isLogical?: boolean;
  stops: GlobalClusterStop[];
}
interface GlobalDepot {
  id: string; name: string; color: string;
  lat: number | null; lon: number | null;
  address?: string | null;
  capacity?: number | null;
}

/* Convex hull (Andrew monotone chain) — per disegnare poligono cluster */
function convexHull(points: [number, number][]): [number, number][] {
  if (points.length < 3) return points;
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: [number, number], a: [number, number], b: [number, number]) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: [number, number][] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop(); lower.pop();
  return lower.concat(upper);
}

interface VariantEditorState {
  variantId: string;
  routeId: string;
  routeColor: string;
  stops: PsVariantStop[];          // sequenza ordinata
  waypoints: PsWaypoint[];         // ancore lungo il percorso
  shapeMode: "driving" | "manual"; // modalità di snap globale (i singoli waypoint hanno comunque il loro mode)
  geometry: { type: "LineString"; coordinates: [number, number][] } | null;
  distanceM: number | null;
  durationS: number | null;
  dirty: boolean;
}

export default function PlanningStudioEditorPage() {
  const params = useParams<{ id: string }>();
  const projectId = params?.id ?? "";
  const [, navigate] = useLocation();

  /* ─── State ─── */
  const [project, setProject] = useState<PsProject | null>(null);
  const [stops, setStops] = useState<PsStop[]>([]);
  const [routes, setRoutes] = useState<PsRoute[]>([]);
  const [calendars, setCalendars] = useState<PsCalendar[]>([]);
  const [clusters, setClusters] = useState<PsCluster[]>([]);
  const [routeVariants, setRouteVariants] = useState<Record<string, PsVariant[]>>({});
  const [loading, setLoading] = useState(true);

  const [activePanel, setActivePanel] = useState<DataPanel>(null);
  const [tool, setTool] = useState<Tool>("select");

  // Selezione entità (per inspector floating)
  const [selectedRouteId, setSelectedRouteId] = useState<string | null>(null);
  const [selectedCalendarId, setSelectedCalendarId] = useState<string | null>(null);

  // Import GTFS dialog
  const [importOpen, setImportOpen] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<PsImportCounts | null>(null);

  const [selectedStopId, setSelectedStopId] = useState<string | null>(null);
  const [editingStop, setEditingStop] = useState<PsStop | null>(null);
  const [pendingStop, setPendingStop] = useState<{ lat: number; lon: number } | null>(null);

  const [openRouteId, setOpenRouteId] = useState<string | null>(null);
  const [editor, setEditor] = useState<VariantEditorState | null>(null);
  const [snapBusy, setSnapBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  // ── Mappa: stile + 3D toggle ───────────────────────────────
  // Stile "standard" Mapbox: chiaro, dettagliato, supporta nativamente edifici 3D
  // e landmark via setConfigProperty('basemap', 'show3dObjects', …).
  const [is3D, setIs3D] = useState(false);
  const [mapReady, setMapReady] = useState(false);

  const mapRef = useRef<MapRef>(null);
  const mapContainerRef = useRef<HTMLDivElement>(null);

  /* ─── Layer overlay: Cluster (Network Engine) e Depositi ─── */
  const [globalClusters, setGlobalClusters] = useState<GlobalCluster[]>([]);
  const [depots, setDepots] = useState<GlobalDepot[]>([]);
  const [overlayLoading, setOverlayLoading] = useState<{ clusters?: boolean; depots?: boolean }>({});
  // I layer rimangono visibili anche quando il pannello viene chiuso o se ne apre un altro
  const [showGlobalClusters, setShowGlobalClusters] = useState(false);
  const [showDepots, setShowDepots] = useState(false);
  const [editingDepot, setEditingDepot] = useState<GlobalDepot | null>(null);
  const [creatingDepotAt, setCreatingDepotAt] = useState<{ lat: number; lon: number } | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [pickingDepotLocation, setPickingDepotLocation] = useState(false);
  const [depotModalHidden, setDepotModalHidden] = useState(false);

  // Reload helpers (riusabili dai pannelli dopo CRUD)
  const reloadGlobalClusters = useCallback(async () => {
    setOverlayLoading(s => ({ ...s, clusters: true }));
    try {
      const r = await fetch("/api/clusters");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      const arr: GlobalCluster[] = Array.isArray(j) ? j : (j.data ?? []);
      setGlobalClusters(arr);
    } catch (e: any) { toast.error("Errore caricamento cluster", { description: e?.message }); }
    finally { setOverlayLoading(s => ({ ...s, clusters: false })); }
  }, []);
  const reloadDepots = useCallback(async () => {
    setOverlayLoading(s => ({ ...s, depots: true }));
    try {
      const r = await fetch("/api/depots");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      const arr: GlobalDepot[] = Array.isArray(j) ? j : (j.data ?? []);
      setDepots(arr);
    } catch (e: any) { toast.error("Errore caricamento depositi", { description: e?.message }); }
    finally { setOverlayLoading(s => ({ ...s, depots: false })); }
  }, []);

  // Lazy fetch quando si attivano
  useEffect(() => {
    if (showGlobalClusters && globalClusters.length === 0 && !overlayLoading.clusters) reloadGlobalClusters();
  }, [showGlobalClusters]);
  useEffect(() => {
    if (showDepots && depots.length === 0 && !overlayLoading.depots) reloadDepots();
  }, [showDepots]);

  // Mappa: psStopId → colore del cluster a cui appartiene (matching per code o coord)
  const stopIdToClusterColor: { [k: string]: string } = useMemo(() => {
    if (!showGlobalClusters) return {};
    const byCode: { [k: string]: string } = {};
    const byCoord: { [k: string]: string } = {};
    for (const c of globalClusters) {
      const color = c.color || "#0ea5e9";
      for (const cs of (c.stops || [])) {
        if (cs.gtfsStopId) byCode[String(cs.gtfsStopId)] = color;
        if (Number.isFinite(cs.stopLat) && Number.isFinite(cs.stopLon)) {
          byCoord[`${cs.stopLat.toFixed(5)},${cs.stopLon.toFixed(5)}`] = color;
        }
      }
    }
    const out: { [k: string]: string } = {};
    for (const s of stops) {
      const key = `${Number(s.lat).toFixed(5)},${Number(s.lon).toFixed(5)}`;
      const col = (s.code && byCode[s.code]) || byCoord[key];
      if (col) out[s.id] = col;
    }
    return out;
  }, [showGlobalClusters, globalClusters, stops]);

  // GeoJSON poligoni cluster (convex hull) — visibile solo se toggle on
  const clustersGeoJSON = useMemo(() => {
    if (!showGlobalClusters) return null;
    const features: any[] = [];
    for (const c of globalClusters) {
      const pts = (c.stops || [])
        .filter(s => Number.isFinite(s.stopLon) && Number.isFinite(s.stopLat))
        .map(s => [Number(s.stopLon), Number(s.stopLat)] as [number, number]);
      if (pts.length === 0) continue;
      const props = { id: c.id, name: c.name, color: c.color || "#0ea5e9" };
      if (pts.length >= 3) {
        const hull = convexHull(pts);
        if (hull.length >= 3) {
          const ring = [...hull, hull[0]];
          features.push({ type: "Feature", properties: props, geometry: { type: "Polygon", coordinates: [ring] } });
        }
      }
      // Punti delle fermate del cluster (sempre)
      for (const p of pts) {
        features.push({ type: "Feature", properties: { ...props, isStop: true }, geometry: { type: "Point", coordinates: p } });
      }
      // Centroide per l'etichetta del nome
      const cx = pts.reduce((a, p) => a + p[0], 0) / pts.length;
      const cy = pts.reduce((a, p) => a + p[1], 0) / pts.length;
      features.push({ type: "Feature", properties: { ...props, isLabel: true }, geometry: { type: "Point", coordinates: [cx, cy] } });
    }
    return { type: "FeatureCollection", features } as any;
  }, [showGlobalClusters, globalClusters]);

  /* ─── Load ─── */
  useEffect(() => {
    if (!projectId) return;
    (async () => {
      setLoading(true);
      try {
        const [p, s, r, c, cl] = await Promise.all([
          getPsProject(projectId),
          listPsStops(projectId),
          listPsRoutes(projectId),
          listPsCalendars(projectId),
          listPsClusters(projectId),
        ]);
        setProject(p);
        setStops(s);
        setRoutes(r);
        setCalendars(c);
        setClusters(cl);
      } catch (e: any) {
        toast.error("Errore caricamento", { description: e?.message });
      } finally { setLoading(false); }
    })();
  }, [projectId]);

  /* ─── Map handlers ─── */
  const handleMapClick = useCallback((e: MapMouseEvent) => {
    const { lng, lat } = e.lngLat;

    // Modalità "scegli posizione deposito": cattura il click e ripristina il modale
    if (pickingDepotLocation && editingDepot) {
      setEditingDepot({ ...editingDepot, lat, lon: lng });
      setPickingDepotLocation(false);
      setDepotModalHidden(false);
      toast.success("Posizione selezionata", { description: `${lat.toFixed(5)}, ${lng.toFixed(5)}` });
      return;
    }

    // Tool 'addStop': mostra form pendente
    if (tool === "addStop") {
      setPendingStop({ lat, lon: lng });
      return;
    }

    // Tool 'editVariant': aggiunge un waypoint all'editor
    if (tool === "editVariant" && editor) {
      addWaypoint([lng, lat], null /* free point, non legato a fermata */);
      return;
    }
    // select: deseleziona
    setSelectedStopId(null);
  }, [tool, editor, pickingDepotLocation, editingDepot]);

  /* ─── Stops CRUD ─── */
  async function handleSaveStop(stopOrCreate: { name: string; code?: string; lat: number; lon: number }, existingId?: string) {
    try {
      if (existingId) {
        const updated = await updatePsStop(projectId, existingId, stopOrCreate);
        setStops(s => s.map(x => x.id === existingId ? updated : x));
        toast.success("Fermata aggiornata");
      } else {
        const created = await createPsStop(projectId, stopOrCreate);
        setStops(s => [...s, created]);
        toast.success("Fermata creata");
      }
      setPendingStop(null);
      setEditingStop(null);
    } catch (e: any) {
      toast.error("Errore salvataggio", { description: e?.message });
    }
  }

  async function handleDeleteStop(id: string) {
    if (!confirm("Eliminare la fermata?")) return;
    try {
      await deletePsStop(projectId, id);
      setStops(s => s.filter(x => x.id !== id));
      if (selectedStopId === id) setSelectedStopId(null);
      if (editingStop?.id === id) setEditingStop(null);
      toast.success("Fermata eliminata");
    } catch (e: any) {
      toast.error("Errore", { description: e?.message });
    }
  }

  /* ─── Routes & variants ─── */
  async function handleCreateRoute(input: { shortName: string; longName?: string; color?: string }): Promise<PsRoute | undefined> {
    try {
      const r = await createPsRoute(projectId, input);
      setRoutes(rs => [...rs, r]);
      toast.success("Linea creata");
      return r;
    } catch (e: any) {
      toast.error("Errore", { description: e?.message });
      return undefined;
    }
  }

  async function loadVariants(routeId: string) {
    if (routeVariants[routeId]) return;
    try {
      const vs = await listPsVariants(projectId, routeId);
      setRouteVariants(prev => ({ ...prev, [routeId]: vs }));
    } catch (e: any) {
      toast.error("Errore varianti", { description: e?.message });
    }
  }

  async function handleCreateVariant(routeId: string, name: string, direction: number): Promise<PsVariant | undefined> {
    try {
      const v = await createPsVariant(projectId, routeId, { name, direction });
      setRouteVariants(prev => ({ ...prev, [routeId]: [...(prev[routeId] || []), v] }));
      toast.success("Variante creata");
      return v;
    } catch (e: any) {
      toast.error("Errore", { description: e?.message });
      return undefined;
    }
  }

  async function startEditingVariant(routeId: string, variantId: string) {
    try {
      const data = await getPsVariant(projectId, variantId);
      const route = routes.find(r => r.id === routeId);
      setEditor({
        variantId,
        routeId,
        routeColor: route?.color || "#10b981",
        stops: data.stops || [],
        waypoints: data.shape?.waypoints || [],
        shapeMode: ((data.shape?.mode as any) || "driving"),
        geometry: data.shape?.geometry || null,
        distanceM: data.shape?.distanceM ?? null,
        durationS: data.shape?.durationS ?? null,
        dirty: false,
      });
      setTool("editVariant");
      // fit map sui waypoint o sulle fermate della variante
      const coords = data.shape?.geometry?.coordinates?.length
        ? data.shape.geometry.coordinates
        : data.stops.map(s => [s.lon, s.lat] as [number, number]);
      if (coords.length > 0) fitToCoords(coords);
    } catch (e: any) {
      toast.error("Errore caricamento variante", { description: e?.message });
    }
  }

  function exitEditor() {
    if (editor?.dirty && !confirm("Hai modifiche non salvate. Uscire comunque?")) return;
    setEditor(null);
    setTool("select");
  }

  function fitToCoords(coords: [number, number][]) {
    if (!mapRef.current || coords.length === 0) return;
    const lons = coords.map(c => c[0]); const lats = coords.map(c => c[1]);
    const bounds: [[number, number], [number, number]] = [
      [Math.min(...lons), Math.min(...lats)],
      [Math.max(...lons), Math.max(...lats)],
    ];
    mapRef.current.fitBounds(bounds, { padding: 80, duration: 500 });
  }

  // ── Resize della mappa quando il container cambia dimensione ──
  // Necessario perché Mapbox non rileva i cambi del parent (es. sidebar
  // che si apre/chiude) senza un evento window.resize.
  useEffect(() => {
    if (!mapReady || !mapRef.current || !mapContainerRef.current) return;
    const map = mapRef.current.getMap() as any;
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => { try { map.resize(); } catch {} });
    });
    ro.observe(mapContainerRef.current);
    return () => { ro.disconnect(); cancelAnimationFrame(raf); };
  }, [mapReady]);

  // ── Toggle 2D / 3D ─────────────────────────────────────────
  // Anima pitch e abilita/disabilita gli oggetti 3D dello stile Standard.
  // Manteniamo sempre il light preset "day" per non scurire la mappa.
  useEffect(() => {
    if (!mapReady || !mapRef.current) return;
    const map = mapRef.current.getMap() as any;
    try {
      map.setConfigProperty?.("basemap", "show3dObjects", is3D);
      map.setConfigProperty?.("basemap", "lightPreset", "day");
    } catch { /* style non Standard: nessun problema */ }
    map.easeTo({
      pitch: is3D ? 60 : 0,
      bearing: is3D ? -17 : 0,
      duration: 800,
    });
  }, [is3D, mapReady]);

  // Auto-fit: appena la mappa è pronta e ci sono fermate, inquadra l'estensione
  // del progetto (GTFS importato o fermate create manualmente). Si esegue una
  // sola volta per non disturbare il pan dell'utente.
  const didAutoFitRef = useRef(false);
  useEffect(() => {
    if (!mapReady || !mapRef.current) return;
    if (didAutoFitRef.current) return;
    if (stops.length === 0) return;
    const lats = stops.map(s => Number(s.lat)).filter(n => Number.isFinite(n));
    const lons = stops.map(s => Number(s.lon)).filter(n => Number.isFinite(n));
    if (lats.length === 0) return;
    const bounds: [[number, number], [number, number]] = [
      [Math.min(...lons), Math.min(...lats)],
      [Math.max(...lons), Math.max(...lats)],
    ];
    mapRef.current.fitBounds(bounds, { padding: 80, duration: 800, maxZoom: 14 });
    didAutoFitRef.current = true;
  }, [mapReady, stops]);


  /* ─── Variant editor: snap routing ─── */
  async function recomputeShape(wpts: PsWaypoint[], mode: "driving" | "manual") {
    if (wpts.length < 2) {
      setEditor(prev => prev ? { ...prev, geometry: null, distanceM: 0, durationS: 0, dirty: true } : prev);
      return;
    }
    setSnapBusy(true);
    try {
      const points: [number, number][] = wpts.map(w => [w.lng, w.lat]);
      const r = await routeSnap(points, mode);
      setEditor(prev => prev ? {
        ...prev,
        geometry: r.geometry,
        distanceM: r.distanceM,
        durationS: r.durationS,
        dirty: true,
      } : prev);
    } catch (e: any) {
      toast.error("Errore snap routing", { description: e?.message });
    } finally { setSnapBusy(false); }
  }

  function addWaypoint(lngLat: [number, number], stopId: string | null) {
    if (!editor) return;
    const newWpt: PsWaypoint = {
      lng: lngLat[0], lat: lngLat[1],
      stopId: stopId || undefined,
      mode: editor.shapeMode === "manual" ? "manual" : "snap",
    };
    const wpts = [...editor.waypoints, newWpt];
    setEditor({ ...editor, waypoints: wpts, dirty: true });
    recomputeShape(wpts, editor.shapeMode);
  }

  function moveWaypoint(idx: number, lngLat: [number, number]) {
    if (!editor) return;
    const wpts = editor.waypoints.map((w, i) => i === idx ? { ...w, lng: lngLat[0], lat: lngLat[1] } : w);
    setEditor({ ...editor, waypoints: wpts, dirty: true });
    recomputeShape(wpts, editor.shapeMode);
  }

  function removeWaypoint(idx: number) {
    if (!editor) return;
    const wpts = editor.waypoints.filter((_, i) => i !== idx);
    setEditor({ ...editor, waypoints: wpts, dirty: true });
    recomputeShape(wpts, editor.shapeMode);
  }

  function changeShapeMode(mode: "driving" | "manual") {
    if (!editor) return;
    setEditor({ ...editor, shapeMode: mode, dirty: true });
    recomputeShape(editor.waypoints, mode);
  }

  /* ─── Variant editor: stops sequence ─── */
  function addStopToSequence(stop: PsStop) {
    if (!editor) return;
    const seq = editor.stops.length + 1;
    const vs: PsVariantStop = {
      seq,
      stopId: stop.id,
      stopName: stop.name,
      stopCode: stop.code,
      lat: stop.lat, lon: stop.lon,
      pickupType: 0, dropOffType: 0, timepoint: 1,
    };
    setEditor({ ...editor, stops: [...editor.stops, vs], dirty: true });
    // Auto-aggiungi anche come waypoint per generare lo shape
    addWaypoint([stop.lon, stop.lat], stop.id);
  }

  function moveStopInSequence(from: number, to: number) {
    if (!editor) return;
    const list = [...editor.stops];
    const [m] = list.splice(from, 1);
    list.splice(to, 0, m);
    const renum = list.map((s, i) => ({ ...s, seq: i + 1 }));
    setEditor({ ...editor, stops: renum, dirty: true });
  }

  function removeStopFromSequence(idx: number) {
    if (!editor) return;
    const list = editor.stops.filter((_, i) => i !== idx).map((s, i) => ({ ...s, seq: i + 1 }));
    setEditor({ ...editor, stops: list, dirty: true });
  }

  /* ─── Salvataggio variante ─── */
  async function saveVariant() {
    if (!editor) return;
    setSaving(true);
    try {
      // 1. Salva sequenza fermate
      await setPsVariantStops(projectId, editor.variantId,
        editor.stops.map(s => ({ stopId: s.stopId })));
      // 2. Salva shape (se ho una geometry)
      if (editor.geometry && editor.geometry.coordinates.length >= 2) {
        await setPsVariantShape(projectId, editor.variantId, {
          mode: editor.shapeMode,
          geometry: editor.geometry,
          waypoints: editor.waypoints,
          distanceM: editor.distanceM ?? undefined,
          durationS: editor.durationS ?? undefined,
        });
      }
      toast.success("Variante salvata", {
        description: `${editor.stops.length} fermate · ${editor.geometry ? `${(editor.distanceM! / 1000).toFixed(2)} km di percorso` : "nessun percorso"}`,
      });
      setEditor({ ...editor, dirty: false });
      // Aggiorna flag has_shape sulla lista varianti della route
      const updated = await listPsVariants(projectId, editor.routeId);
      setRouteVariants(prev => ({ ...prev, [editor.routeId]: updated }));
    } catch (e: any) {
      toast.error("Errore salvataggio", { description: e?.message });
    } finally { setSaving(false); }
  }

  /* ─── Cursor sulla mappa secondo tool ─── */
  const mapCursor = pickingDepotLocation ? "crosshair"
                  : tool === "addStop" ? "crosshair"
                  : tool === "editVariant" ? "crosshair"
                  : "grab";

  /* ─── Import GTFS ─── */
  const isEmpty = !loading && stops.length === 0 && routes.length === 0;
  async function handleImport() {
    if (!importFile) return;
    setImporting(true);
    try {
      const r = await importPsGtfs(projectId, importFile);
      setImportResult(r.counts);
      toast.success("Import completato", {
        description: `${r.counts.stops} fermate · ${r.counts.routes} linee · ${r.counts.trips} corse`,
      });
      // Ricarica i dati del progetto
      const [s, rr, c, cl] = await Promise.all([
        listPsStops(projectId), listPsRoutes(projectId), listPsCalendars(projectId), listPsClusters(projectId),
      ]);
      setStops(s); setRoutes(rr); setCalendars(c); setClusters(cl);
      // Fit map sulle fermate
      if (s.length > 0) {
        const coords = s.map(x => [x.lon, x.lat] as [number, number]);
        setTimeout(() => fitToCoords(coords), 200);
      }
    } catch (e: any) {
      toast.error("Errore import GTFS", { description: e?.message });
    } finally {
      setImporting(false);
    }
  }
  function closeImport() {
    if (importing) return;
    setImportOpen(false);
    setImportFile(null);
    setImportResult(null);
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-950 text-slate-300">
        <Loader2 className="w-6 h-6 animate-spin mr-2" /> Caricamento progetto…
      </div>
    );
  }
  if (!project) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-950 text-slate-400">
        Progetto non trovato.
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-slate-950 text-slate-100 overflow-hidden">
      {/* ─── Toolbar top ─── */}
      <div className="h-14 border-b border-slate-800 bg-slate-950/95 backdrop-blur flex items-center px-3 gap-2 shrink-0 z-30">
        {/* Back + project info */}
        <button onClick={() => navigate("/planning-studio")}
          className="p-1.5 rounded hover:bg-slate-800 text-slate-400 hover:text-slate-200 transition shrink-0">
          <ArrowLeft className="w-4 h-4" />
        </button>
        <div className="min-w-0 max-w-[200px] mr-2">
          <h1 className="text-sm font-semibold truncate">{project.name}</h1>
          <p className="text-[10px] text-slate-500 truncate">
            {project.agencyName || project.myRole}
          </p>
        </div>

        <button
          onClick={() => setShareOpen(true)}
          title={project.myRole === "owner" ? "Condividi progetto" : "Vedi membri"}
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-cyan-500/30 bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-200 text-xs font-medium transition shrink-0"
        >
          <Share2 className="w-3.5 h-3.5" />
          {project.myRole === "owner" ? "Condividi" : "Membri"}
        </button>

        <div className="h-7 w-px bg-slate-800 mx-1" />

        {/* Data toolbar — accesso ai pannelli dati */}
        <DataTabBtn
          icon={MapPin} label="Fermate" count={stops.length} accent="emerald"
          active={activePanel === "stops"}
          onClick={() => setActivePanel(activePanel === "stops" ? null : "stops")}
        />
        <DataTabBtn
          icon={Bus} label="Linee" count={routes.length} accent="cyan"
          active={activePanel === "routes"}
          onClick={() => setActivePanel(activePanel === "routes" ? null : "routes")}
        />
        <DataTabBtn
          icon={CalendarIcon} label="Calendari" count={calendars.length} accent="indigo"
          active={activePanel === "calendars"}
          onClick={() => setActivePanel(activePanel === "calendars" ? null : "calendars")}
        />
        <DataTabBtn
          icon={Grip} label="Cluster" count={globalClusters.length || undefined} accent="cyan"
          active={activePanel === "ne-clusters" || showGlobalClusters}
          onClick={() => {
            if (activePanel === "ne-clusters") {
              // Click sul pannello aperto: chiude pannello E spegne layer
              setActivePanel(null);
              setShowGlobalClusters(false);
            } else {
              setActivePanel("ne-clusters");
              setShowGlobalClusters(true);
            }
          }}
        />
        <DataTabBtn
          icon={Building2} label="Depositi" count={depots.length || undefined} accent="orange"
          active={activePanel === "ne-depots" || showDepots}
          onClick={() => {
            if (activePanel === "ne-depots") {
              setActivePanel(null);
              setShowDepots(false);
            } else {
              setActivePanel("ne-depots");
              setShowDepots(true);
            }
          }}
        />

        <div className="flex-1" />

        {/* Tools */}
        <div className="flex items-center gap-1 bg-slate-900/80 rounded-lg p-1 border border-slate-800">
          <ToolBtn label="Seleziona" icon={MousePointer2} active={tool === "select"} onClick={() => setTool("select")} />
          <ToolBtn label="Nuova fermata" icon={Crosshair} active={tool === "addStop"} onClick={() => setTool("addStop")} disabled={!!editor} />
          {editor && (
            <ToolBtn label="Editor variante attivo" icon={PenLine} active={true} onClick={() => {}} />
          )}
        </div>

        {/* Import GTFS button (sempre disponibile per owner/editor) */}
        {(project.myRole === "owner" || project.myRole === "editor") && (
          <button
            onClick={() => setImportOpen(true)}
            className="ml-2 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-300"
            title="Importa GTFS (sovrascrive)"
          >
            <Upload className="w-3.5 h-3.5" /> GTFS
          </button>
        )}

        {/* Periodi di esercizio */}
        <button
          onClick={() => navigate(`/planning-studio/${projectId}/service-periods`)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-900 hover:bg-slate-800 border border-slate-800 text-indigo-300"
          title="Periodi di esercizio (Estivo, Invernale, ecc.)"
        >
          <CalendarIcon className="w-3.5 h-3.5" /> Periodi
        </button>

        {/* Gestione corse */}
        <button
          onClick={() => navigate(`/planning-studio/${projectId}/trips`)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-900 hover:bg-slate-800 border border-slate-800 text-amber-300"
          title="Corse: validità, eccezioni date, calendario"
        >
          <Bus className="w-3.5 h-3.5" /> Corse
        </button>

        {/* Inspector di rete */}
        <button
          onClick={() => navigate(`/planning-studio/${projectId}/network`)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-900 hover:bg-slate-800 border border-slate-800 text-violet-300"
          title="Esplora la rete: linee, percorsi, fermate e relazioni"
        >
          <Activity className="w-3.5 h-3.5" /> Rete
        </button>

        {/* Scheduling Engine: progetti agganciati a questo PS */}
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() => navigate(`/fucina?ps=${projectId}`)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-900 hover:bg-slate-800 border border-orange-500/30 text-orange-300"
            title="Vedi i progetti di Scheduling collegati a questo PS"
          >
            <Flame className="w-3.5 h-3.5" /> Scheduling
          </button>
          <button
            onClick={() => navigate(`/fucina?ps=${projectId}&new=1`)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold text-black bg-gradient-to-r from-orange-400 to-amber-400 hover:shadow-[0_0_15px_rgba(251,146,60,0.4)] transition-shadow"
            title="Crea un nuovo progetto Scheduling collegato a questo PS"
          >
            <Plus className="w-3.5 h-3.5" /> Nuovo Scheduling
          </button>
        </div>
      </div>

      {/* ─── Area di lavoro: mappa full + overlays ─── */}
      <div ref={mapContainerRef} className="flex-1 relative overflow-hidden">
        {!MAPBOX_TOKEN && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-slate-900/80 text-amber-300 text-sm">
            ⚠️ VITE_MAPBOX_TOKEN non configurato
          </div>
        )}
        <Map
          ref={mapRef}
          mapboxAccessToken={MAPBOX_TOKEN}
          initialViewState={DEFAULT_VIEW}
          mapStyle="mapbox://styles/mapbox/standard"
          onClick={handleMapClick}
          onLoad={() => setMapReady(true)}
          cursor={mapCursor}
          style={{ width: "100%", height: "100%" }}
        >
          <NavigationControl position="bottom-right" />

          {/* Toggle 2D / 3D ─ overlay in alto a destra */}
          <div className="absolute top-3 right-3 z-10 flex rounded-lg overflow-hidden border border-slate-300 shadow-lg bg-white/95 backdrop-blur">
            <button
              onClick={() => setIs3D(false)}
              className={`px-3 py-1.5 text-xs font-semibold transition-colors ${
                !is3D ? "bg-purple-500 text-white" : "text-slate-700 hover:bg-slate-100"
              }`}
              title="Vista 2D"
            >2D</button>
            <button
              onClick={() => setIs3D(true)}
              className={`px-3 py-1.5 text-xs font-semibold transition-colors ${
                is3D ? "bg-purple-500 text-white" : "text-slate-700 hover:bg-slate-100"
              }`}
              title="Vista 3D con edifici"
            >3D</button>
          </div>

          {/* Cluster: cerchi (raggio reale convertito in pixel @ zoom corrente) */}
          {activePanel === "clusters" && clusters.length > 0 && (
            <Source
              id="ps-clusters-src"
              type="geojson"
              data={{
                type: "FeatureCollection",
                features: clusters
                  .filter(c => c.centerLat != null && c.centerLon != null)
                  .map(c => ({
                    type: "Feature",
                    properties: {
                      id: c.id,
                      name: c.name,
                      color: c.kind === "interchange" ? "#0ea5e9" : "#64748b",
                      radius: c.radiusM,
                    },
                    geometry: { type: "Point", coordinates: [Number(c.centerLon), Number(c.centerLat)] },
                  })),
              }}
            >
              <Layer
                id="ps-clusters-fill"
                type="circle"
                paint={{
                  "circle-radius": [
                    "interpolate", ["exponential", 2], ["zoom"],
                    10, ["/", ["get", "radius"], 50],
                    16, ["/", ["get", "radius"], 1.2],
                  ],
                  "circle-color": ["get", "color"],
                  "circle-opacity": 0.18,
                  "circle-stroke-color": ["get", "color"],
                  "circle-stroke-width": 2,
                  "circle-stroke-opacity": 0.9,
                }}
              />
              <Layer
                id="ps-clusters-label"
                type="symbol"
                layout={{
                  "text-field": ["get", "name"],
                  "text-size": 11,
                  "text-offset": [0, 1.2],
                  "text-anchor": "top",
                }}
                paint={{
                  "text-color": "#0ea5e9",
                  "text-halo-color": "#ffffff",
                  "text-halo-width": 1.5,
                }}
              />
            </Source>
          )}

          {/* ─── Layer Cluster globali (Network Engine) ─── */}
          {showGlobalClusters && clustersGeoJSON && (
            <Source id="ne-clusters-src" type="geojson" data={clustersGeoJSON}>
              <Layer
                id="ne-clusters-fill"
                type="fill"
                filter={["==", ["geometry-type"], "Polygon"]}
                paint={{
                  "fill-color": ["get", "color"],
                  "fill-opacity": 0.15,
                }}
              />
              <Layer
                id="ne-clusters-outline"
                type="line"
                filter={["==", ["geometry-type"], "Polygon"]}
                paint={{
                  "line-color": ["get", "color"],
                  "line-width": 2,
                  "line-opacity": 0.85,
                }}
              />
              <Layer
                id="ne-clusters-stops"
                type="circle"
                filter={["all", ["==", ["geometry-type"], "Point"], ["!=", ["get", "isLabel"], true]]}
                paint={{
                  "circle-radius": 4,
                  "circle-color": ["get", "color"],
                  "circle-stroke-color": "#ffffff",
                  "circle-stroke-width": 1.5,
                  "circle-opacity": 0.9,
                }}
              />
              <Layer
                id="ne-clusters-labels"
                type="symbol"
                filter={["==", ["get", "isLabel"], true]}
                layout={{
                  "text-field": ["get", "name"],
                  "text-size": 13,
                  "text-font": ["Open Sans Bold", "Arial Unicode MS Bold"],
                  "text-anchor": "center",
                  "text-allow-overlap": false,
                  "text-ignore-placement": false,
                  "symbol-placement": "point",
                }}
                paint={{
                  "text-color": ["get", "color"],
                  "text-halo-color": "#ffffff",
                  "text-halo-width": 2,
                  "text-halo-blur": 0.5,
                }}
              />
            </Source>
          )}

          {/* ─── Layer Depositi (Network Engine) ─── */}
          {showDepots && depots.filter(d => d.lat != null && d.lon != null).map(d => (
            <Marker key={`depot-${d.id}`} longitude={Number(d.lon)} latitude={Number(d.lat)} anchor="bottom"
              onClick={(e) => { e.originalEvent.stopPropagation(); setEditingDepot(d); }}
            >
              <div
                title={`Deposito · ${d.name}${d.capacity ? ` · ${d.capacity} mezzi` : ""} — clic per modificare`}
                className="flex flex-col items-center pointer-events-auto cursor-pointer hover:scale-110 transition-transform"
              >
                <div
                  className="w-7 h-7 rounded-md border-2 border-white shadow-lg flex items-center justify-center"
                  style={{ backgroundColor: d.color || "#f97316" }}
                >
                  <Building2 className="w-4 h-4 text-white" />
                </div>
                <div
                  className="w-2 h-2 rotate-45 -mt-1 border-r-2 border-b-2 border-white"
                  style={{ backgroundColor: d.color || "#f97316" }}
                />
                <div
                  className="mt-0.5 px-1.5 py-0.5 rounded bg-white/95 text-[11px] font-semibold whitespace-nowrap shadow"
                  style={{ color: d.color || "#f97316" }}
                >
                  {d.name}
                </div>
              </div>
            </Marker>
          ))}

          {/* Tutte le fermate del progetto */}
          {stops.map(s => {
            const inSeq = editor?.stops.find(vs => vs.stopId === s.id);
            const isSel = selectedStopId === s.id;
            const clusterColor = stopIdToClusterColor[s.id];
            return (
              <Marker key={s.id} longitude={s.lon} latitude={s.lat} anchor="center"
                onClick={(e) => {
                  e.originalEvent.stopPropagation();
                  if (tool === "editVariant" && editor) {
                    addStopToSequence(s);
                  } else {
                    setSelectedStopId(s.id);
                  }
                }}
              >
                <div
                  className={`w-3 h-3 rounded-full border-2 cursor-pointer transition-all ${
                    inSeq ? "border-emerald-200 scale-125 shadow-lg shadow-emerald-500/50"
                          : isSel ? "border-white scale-125"
                          : clusterColor ? "border-white scale-110 shadow"
                          : "bg-white border-slate-700 hover:scale-125"
                  }`}
                  style={
                    inSeq ? { backgroundColor: "#34d399" }
                    : isSel ? { backgroundColor: "#22d3ee" }
                    : clusterColor ? { backgroundColor: clusterColor, boxShadow: `0 0 0 2px ${clusterColor}40` }
                    : undefined
                  }
                  title={clusterColor ? `${s.name} · in cluster` : s.name}
                />
              </Marker>
            );
          })}

          {/* Shape della variante in editing */}
          {editor?.geometry && (
            <Source id="editor-shape" type="geojson" data={{
              type: "Feature", properties: {}, geometry: editor.geometry,
            }}>
              <Layer
                id="editor-shape-line"
                type="line"
                paint={{
                  "line-color": editor.routeColor,
                  "line-width": 5,
                  "line-opacity": 0.85,
                }}
                layout={{ "line-join": "round", "line-cap": "round" }}
              />
            </Source>
          )}

          {/* Waypoint draggable */}
          {editor?.waypoints.map((w, idx) => (
            <Marker key={`w-${idx}`} longitude={w.lng} latitude={w.lat}
              draggable
              onDragEnd={(e) => moveWaypoint(idx, [e.lngLat.lng, e.lngLat.lat])}
              anchor="center"
            >
              <div
                onClick={(e) => { e.stopPropagation(); }}
                onContextMenu={(e) => { e.preventDefault(); removeWaypoint(idx); }}
                title={`Waypoint ${idx + 1} · ${w.mode === "manual" ? "manuale" : "snap"} · click destro per rimuovere`}
              >
                <div className={`w-4 h-4 rounded-full border-2 border-white shadow-lg ${
                  w.stopId ? "bg-emerald-500" : w.mode === "manual" ? "bg-amber-400" : "bg-indigo-500"
                } cursor-grab active:cursor-grabbing`} />
              </div>
            </Marker>
          ))}

          {/* Pending stop in modalità addStop */}
          {pendingStop && (
            <Popup longitude={pendingStop.lon} latitude={pendingStop.lat} closeOnClick={false} closeButton={false} anchor="bottom" offset={12}>
              <NewStopForm
                lat={pendingStop.lat} lon={pendingStop.lon}
                onCancel={() => setPendingStop(null)}
                onSave={(d) => handleSaveStop(d)}
              />
            </Popup>
          )}

          {/* Editing stop popup */}
          {editingStop && (
            <Popup longitude={editingStop.lon} latitude={editingStop.lat} closeOnClick={false}
              closeButton={false} anchor="bottom" offset={12}>
              <NewStopForm
                lat={editingStop.lat} lon={editingStop.lon}
                initialName={editingStop.name} initialCode={editingStop.code || ""}
                onCancel={() => setEditingStop(null)}
                onSave={(d) => handleSaveStop(d, editingStop.id)}
              />
            </Popup>
          )}
        </Map>

        {/* ─── Modale modifica/creazione deposito ─── */}
        {editingDepot && (
          <DepotEditModal
            depot={editingDepot}
            hidden={depotModalHidden}
            onChange={(d) => setEditingDepot(d)}
            onPickLocation={() => { setDepotModalHidden(true); setPickingDepotLocation(true); }}
            onClose={() => { setEditingDepot(null); setDepotModalHidden(false); setPickingDepotLocation(false); }}
            onSaved={async () => { setEditingDepot(null); setDepotModalHidden(false); setPickingDepotLocation(false); await reloadDepots(); }}
          />
        )}

        {/* ─── Banner overlay durante il pick della posizione del deposito ─── */}
        {pickingDepotLocation && (
          <div className="absolute top-3 left-1/2 -translate-x-1/2 z-30 flex items-center gap-3 px-4 py-2 rounded-full bg-orange-500/95 text-white shadow-xl backdrop-blur border border-orange-300/40">
            <MapPin className="w-4 h-4" />
            <span className="text-sm font-medium">Clicca sulla mappa per posizionare il deposito</span>
            <button
              onClick={() => { setPickingDepotLocation(false); setDepotModalHidden(false); }}
              className="ml-2 px-2 py-0.5 text-xs rounded-full bg-white/20 hover:bg-white/30"
            >
              Annulla
            </button>
          </div>
        )}

        {/* ─── Dialog condivisione progetto ─── */}
        {shareOpen && (
          <SharePsProjectDialog
            projectId={project.id}
            open
            canManage={project.myRole === "owner"}
            onClose={() => setShareOpen(false)}
          />
        )}

        {/* ─── Pannello dati floating (sx) ─── */}
        <AnimatePresence>
          {activePanel && !editor && (
            <motion.div
              initial={{ x: -360, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: -360, opacity: 0 }}
              transition={{ type: "spring", damping: 26, stiffness: 260 }}
              className="absolute top-3 left-3 bottom-3 w-[340px] z-20 rounded-xl bg-slate-950/95 backdrop-blur border border-slate-800 shadow-2xl flex flex-col overflow-hidden"
            >
              <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800 shrink-0">
                <h2 className="text-sm font-semibold flex items-center gap-2">
                  {activePanel === "stops" && <><MapPin className="w-4 h-4 text-emerald-400" /> Fermate</>}
                  {activePanel === "routes" && <><Bus className="w-4 h-4 text-cyan-400" /> Linee</>}
                  {activePanel === "calendars" && <><CalendarIcon className="w-4 h-4 text-indigo-400" /> Calendari</>}
                  {activePanel === "clusters" && <><Layers className="w-4 h-4 text-cyan-400" /> Cluster di cambio</>}
                  {activePanel === "ne-clusters" && <><Grip className="w-4 h-4 text-cyan-400" /> Cluster (Network)</>}
                  {activePanel === "ne-depots" && <><Building2 className="w-4 h-4 text-orange-400" /> Depositi (Network)</>}
                </h2>
                <button onClick={() => setActivePanel(null)}
                  className="p-1 rounded hover:bg-slate-800 text-slate-400">
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="flex-1 overflow-y-auto">
                {activePanel === "stops" && (
                  <StopsPanel
                    stops={stops}
                    selectedId={selectedStopId}
                    onSelect={(s) => {
                      setSelectedStopId(s.id);
                      mapRef.current?.flyTo({ center: [s.lon, s.lat], zoom: 16, duration: 600 });
                    }}
                    onEdit={(s) => setEditingStop(s)}
                    onDelete={handleDeleteStop}
                    onAddNew={() => setTool("addStop")}
                  />
                )}
                {activePanel === "routes" && (
                  <RoutesPanel
                    routes={routes}
                    variantsByRoute={routeVariants}
                    openRouteId={openRouteId}
                    onToggleRoute={async (id) => {
                      const next = openRouteId === id ? null : id;
                      setOpenRouteId(next);
                      if (next) await loadVariants(next);
                    }}
                    onCreateRoute={handleCreateRoute}
                    onDeleteRoute={async (id) => {
                      if (!confirm("Eliminare la linea e tutte le sue varianti?")) return;
                      try { await deletePsRoute(projectId, id); setRoutes(rs => rs.filter(r => r.id !== id)); toast.success("Linea eliminata"); }
                      catch (e: any) { toast.error("Errore", { description: e?.message }); }
                    }}
                    onCreateVariant={handleCreateVariant}
                    onEditVariant={(routeId, variantId) => startEditingVariant(routeId, variantId)}
                    onDeleteVariant={async (id) => {
                      if (!confirm("Eliminare la variante?")) return;
                      try {
                        await deletePsVariant(projectId, id);
                        setRouteVariants(prev => {
                          const next = { ...prev };
                          for (const k of Object.keys(next)) next[k] = next[k].filter(v => v.id !== id);
                          return next;
                        });
                        toast.success("Variante eliminata");
                      } catch (e: any) { toast.error("Errore", { description: e?.message }); }
                    }}
                  />
                )}
                {activePanel === "calendars" && (
                  <CalendarsPanel
                    calendars={calendars}
                    onCreate={async (input) => {
                      try {
                        const c = await createPsCalendar(projectId, input);
                        setCalendars(cs => [...cs, c]);
                        toast.success("Calendario creato");
                      } catch (e: any) { toast.error("Errore", { description: e?.message }); }
                    }}
                    onDelete={async (id) => {
                      if (!confirm("Eliminare il calendario?")) return;
                      try { await deletePsCalendar(projectId, id); setCalendars(cs => cs.filter(c => c.id !== id)); toast.success("Eliminato"); }
                      catch (e: any) { toast.error("Errore", { description: e?.message }); }
                    }}
                  />
                )}
                {activePanel === "clusters" && (
                  <ClustersPanel
                    projectId={projectId}
                    stops={stops}
                    clusters={clusters}
                    onChanged={async () => {
                      try { setClusters(await listPsClusters(projectId)); }
                      catch (e: any) { toast.error("Errore", { description: e?.message }); }
                    }}
                    onFlyTo={(lat, lon) => mapRef.current?.flyTo({ center: [lon, lat], zoom: 15, duration: 600 })}
                  />
                )}
                {activePanel === "ne-clusters" && (
                  <NeClustersPanel
                    clusters={globalClusters}
                    loading={overlayLoading.clusters}
                    onReload={reloadGlobalClusters}
                    onFlyTo={(lat, lon) => mapRef.current?.flyTo({ center: [lon, lat], zoom: 14, duration: 600 })}
                  />
                )}
                {activePanel === "ne-depots" && (
                  <NeDepotsPanel
                    depots={depots}
                    loading={overlayLoading.depots}
                    onReload={reloadDepots}
                    onEdit={(d) => setEditingDepot(d)}
                    onCreate={() => setEditingDepot({ id: "", name: "", color: "#f97316", lat: null, lon: null } as GlobalDepot)}
                    onFlyTo={(lat, lon) => mapRef.current?.flyTo({ center: [lon, lat], zoom: 14, duration: 600 })}
                  />
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* ─── Pannello editor variante (sx) ─── */}
        <AnimatePresence>
          {editor && (
            <motion.div
              initial={{ x: -380, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: -380, opacity: 0 }}
              transition={{ type: "spring", damping: 26, stiffness: 260 }}
              className="absolute top-3 left-3 bottom-3 w-[360px] z-20 rounded-xl bg-slate-950/95 backdrop-blur border border-emerald-500/40 shadow-2xl shadow-emerald-900/20 flex flex-col overflow-hidden"
            >
              <VariantEditorPanel
                editor={editor}
                stopsAll={stops}
                snapBusy={snapBusy}
                saving={saving}
                onAddStop={addStopToSequence}
                onMoveStop={moveStopInSequence}
                onRemoveStop={removeStopFromSequence}
                onChangeMode={changeShapeMode}
                onSave={saveVariant}
                onExit={exitEditor}
              />
            </motion.div>
          )}
        </AnimatePresence>

        {/* ─── Inspector floating (dx) per fermata selezionata ─── */}
        <AnimatePresence>
          {selectedStopId && !editingStop && !editor && (() => {
            const s = stops.find(x => x.id === selectedStopId);
            if (!s) return null;
            // Trova varianti che includono questa fermata
            const linkedVariants: { route: PsRoute; variant: PsVariant }[] = [];
            for (const r of routes) {
              const vs = routeVariants[r.id] || [];
              for (const v of vs) {
                // Se non abbiamo ancora caricato i dati dettagliati, skip (il pannello Linee li caricherà)
                // Qui controlliamo solo via name match — best effort
                if ((v as any)._stops?.some?.((x: any) => x.stopId === s.id)) {
                  linkedVariants.push({ route: r, variant: v });
                }
              }
            }
            return (
              <motion.div
                initial={{ x: 360, opacity: 0 }}
                animate={{ x: 0, opacity: 1 }}
                exit={{ x: 360, opacity: 0 }}
                transition={{ type: "spring", damping: 26, stiffness: 260 }}
                className="absolute top-3 right-3 w-[320px] z-20 rounded-xl bg-slate-950/95 backdrop-blur border border-cyan-500/40 shadow-2xl"
              >
                <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800">
                  <span className="flex items-center gap-2 text-xs uppercase tracking-wide text-cyan-300 font-semibold">
                    <MapPin className="w-3.5 h-3.5" /> Fermata
                  </span>
                  <button onClick={() => setSelectedStopId(null)}
                    className="p-1 rounded hover:bg-slate-800 text-slate-400"><X className="w-4 h-4" /></button>
                </div>
                <div className="p-4 space-y-3">
                  <div>
                    <h3 className="text-base font-semibold">{s.name}</h3>
                    {s.code && <p className="text-xs text-slate-500">Codice {s.code}</p>}
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div className="px-2 py-1.5 rounded bg-slate-900 border border-slate-800">
                      <p className="text-[10px] text-slate-500 uppercase">Lat</p>
                      <p className="font-mono text-slate-200">{s.lat.toFixed(5)}</p>
                    </div>
                    <div className="px-2 py-1.5 rounded bg-slate-900 border border-slate-800">
                      <p className="text-[10px] text-slate-500 uppercase">Lon</p>
                      <p className="font-mono text-slate-200">{s.lon.toFixed(5)}</p>
                    </div>
                  </div>
                  <div className="flex gap-2 pt-1">
                    <button onClick={() => setEditingStop(s)}
                      className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-cyan-500/15 hover:bg-cyan-500/25 text-cyan-300 text-xs font-medium">
                      <Pencil className="w-3.5 h-3.5" /> Modifica
                    </button>
                    <button onClick={() => handleDeleteStop(s.id)}
                      className="px-3 py-2 rounded-lg bg-red-500/10 hover:bg-red-500/20 text-red-400 text-xs">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </motion.div>
            );
          })()}
        </AnimatePresence>

        {/* Tool hint floating (in basso al centro per non coprire mappa) */}
        {(tool !== "select" || editor) && (
          <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 bg-slate-900/95 backdrop-blur border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-300 shadow-lg max-w-md">
            {tool === "addStop" && (
              <span className="flex items-center gap-1.5 text-cyan-300"><Crosshair className="w-3.5 h-3.5" /> Clic sulla mappa per posizionare una nuova fermata</span>
            )}
            {tool === "editVariant" && editor && (
              <div className="space-y-0.5">
                <p className="flex items-center gap-1.5 text-emerald-300 font-medium">
                  <PenLine className="w-3.5 h-3.5" /> Editor variante
                  {snapBusy && <Loader2 className="w-3 h-3 animate-spin ml-1" />}
                </p>
                <p className="text-[10px] text-slate-400">
                  Clic su mappa = waypoint · Clic su fermata = aggiungi alla sequenza
                </p>
              </div>
            )}
          </div>
        )}

        {/* ─── Empty state / onboarding GTFS ─── */}
        {isEmpty && !importOpen && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-slate-950/85 backdrop-blur-sm">
            <motion.div
              initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}
              className="max-w-md mx-4 rounded-2xl bg-slate-900 border border-slate-800 shadow-2xl p-8 text-center"
            >
              <div className="w-16 h-16 mx-auto rounded-2xl bg-emerald-500/10 flex items-center justify-center mb-4">
                <Database className="w-7 h-7 text-emerald-400" />
              </div>
              <h2 className="text-lg font-semibold mb-1">Database vuoto</h2>
              <p className="text-sm text-slate-400 mb-6">
                Per iniziare, importa un file GTFS standard. <br />
                Successivamente potrai modificare fermate, linee, varianti e orari direttamente sulla mappa.
              </p>
              <div className="space-y-2">
                {(project.myRole === "owner" || project.myRole === "editor") ? (
                  <button onClick={() => setImportOpen(true)}
                    className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-white text-sm font-medium">
                    <Upload className="w-4 h-4" /> Importa GTFS (.zip)
                  </button>
                ) : (
                  <p className="text-xs text-slate-500">Solo owner/editor possono importare dati.</p>
                )}
                <button onClick={() => setActivePanel("stops")}
                  className="w-full px-4 py-2 rounded-lg text-xs text-slate-400 hover:text-slate-200">
                  Oppure inizia da zero creando manualmente
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </div>

      {/* ─── Dialog Import GTFS ─── */}
      <AnimatePresence>
        {importOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={closeImport}>
            <motion.div
              initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 16 }}
              onClick={e => e.stopPropagation()}
              className="w-full max-w-lg mx-4 rounded-2xl bg-slate-900 border border-slate-800 shadow-2xl"
            >
              <div className="px-6 py-4 border-b border-slate-800">
                <h2 className="text-lg font-semibold flex items-center gap-2">
                  <Upload className="w-4 h-4 text-emerald-400" /> Importa GTFS
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">Progetto: <span className="text-slate-300">{project.name}</span></p>
              </div>
              <div className="px-6 py-5 space-y-4">
                {!importResult && (
                  <>
                    {!isEmpty && (
                      <div className="flex items-start gap-2 p-3 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-200 text-xs">
                        <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                        <div>
                          <strong className="block mb-0.5">Sovrascrittura totale</strong>
                          Tutti i dati attuali del progetto verranno cancellati e sostituiti con quelli del file caricato.
                        </div>
                      </div>
                    )}
                    <div>
                      <label className="block text-xs font-medium text-slate-400 mb-1.5">File GTFS (.zip)</label>
                      <label className="block cursor-pointer">
                        <input type="file" accept=".zip,application/zip"
                          onChange={(e) => setImportFile(e.target.files?.[0] || null)}
                          disabled={importing} className="hidden" />
                        <div className={`flex items-center gap-3 px-4 py-3 rounded-lg border-2 border-dashed transition ${
                          importFile ? "border-emerald-500/50 bg-emerald-500/5" : "border-slate-700 bg-slate-800/40 hover:border-slate-600"
                        }`}>
                          <FileArchive className={`w-5 h-5 ${importFile ? "text-emerald-400" : "text-slate-500"}`} />
                          <div className="flex-1 min-w-0">
                            {importFile ? (
                              <>
                                <p className="text-sm text-slate-100 truncate">{importFile.name}</p>
                                <p className="text-[11px] text-slate-500">{(importFile.size / 1024 / 1024).toFixed(2)} MB</p>
                              </>
                            ) : (
                              <>
                                <p className="text-sm text-slate-400">Seleziona un file .zip</p>
                                <p className="text-[11px] text-slate-600">GTFS standard (stops, routes, trips, stop_times, …)</p>
                              </>
                            )}
                          </div>
                        </div>
                      </label>
                    </div>
                  </>
                )}
                {importResult && (
                  <div className="space-y-3">
                    <div className="text-center py-2">
                      <div className="w-12 h-12 mx-auto rounded-full bg-emerald-500/15 flex items-center justify-center mb-2">
                        <Check className="w-5 h-5 text-emerald-400" />
                      </div>
                      <h3 className="text-base font-semibold text-emerald-300">Import completato</h3>
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      {([
                        ["Fermate", importResult.stops, MapPin],
                        ["Linee", importResult.routes, Bus],
                        ["Varianti", importResult.variants, RouteIcon],
                        ["Percorsi", importResult.shapes, RouteIcon],
                        ["Calendari", importResult.calendars, CalendarIcon],
                        ["Eccezioni", importResult.calendarDates, CalendarIcon],
                        ["Corse", importResult.trips, Activity],
                        ["Stop times", importResult.stopTimes, Activity],
                      ] as [string, number, any][]).map(([label, val, Icon]) => (
                        <div key={label} className="flex items-center justify-between px-3 py-2 rounded-lg bg-slate-800/60 border border-slate-700/50">
                          <span className="flex items-center gap-1.5 text-slate-400">
                            <Icon className="w-3 h-3" /> {label}
                          </span>
                          <span className="font-semibold tabular-nums text-slate-100">{val.toLocaleString("it-IT")}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
              <div className="px-6 py-4 border-t border-slate-800 flex justify-end gap-2">
                {!importResult ? (
                  <>
                    <button onClick={closeImport} disabled={importing}
                      className="px-4 py-2 rounded-lg text-sm text-slate-400 hover:text-slate-200 disabled:opacity-50">
                      Annulla
                    </button>
                    <button onClick={handleImport} disabled={!importFile || importing}
                      className="px-4 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-white text-sm font-medium disabled:opacity-50 flex items-center gap-2">
                      {importing && <Loader2 className="w-4 h-4 animate-spin" />}
                      {importing ? "Importazione…" : (isEmpty ? "Importa" : "Importa e sovrascrivi")}
                    </button>
                  </>
                ) : (
                  <button onClick={closeImport}
                    className="px-4 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-white text-sm font-medium">
                    Inizia a lavorare
                  </button>
                )}
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════
 *  Sidebar — Fermate
 * ════════════════════════════════════════════════════════════ */
function StopsPanel({
  stops, selectedId, onSelect, onEdit, onDelete, onAddNew,
}: {
  stops: PsStop[]; selectedId: string | null;
  onSelect: (s: PsStop) => void;
  onEdit: (s: PsStop) => void;
  onDelete: (id: string) => void;
  onAddNew: () => void;
}) {
  const [q, setQ] = useState("");
  const filtered = useMemo(() => {
    const qq = q.trim().toLowerCase();
    if (!qq) return stops;
    return stops.filter(s => s.name.toLowerCase().includes(qq) || (s.code || "").toLowerCase().includes(qq));
  }, [stops, q]);
  return (
    <div className="p-3 space-y-3">
      <button onClick={onAddNew}
        className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-emerald-500/90 hover:bg-emerald-500 text-white text-sm font-medium">
        <Plus className="w-4 h-4" /> Nuova fermata (clic mappa)
      </button>
      <input value={q} onChange={e => setQ(e.target.value)} placeholder="Cerca fermata…"
        className="w-full px-3 py-2 rounded-lg bg-slate-900 border border-slate-800 text-sm focus:outline-none focus:border-emerald-500" />
      <div className="space-y-1">
        {filtered.length === 0 && (
          <p className="text-center text-xs text-slate-500 py-8">Nessuna fermata</p>
        )}
        {filtered.map(s => (
          <div key={s.id}
            className={`group rounded-lg px-3 py-2 cursor-pointer transition border ${
              selectedId === s.id ? "bg-emerald-500/10 border-emerald-500/40" : "border-transparent hover:bg-slate-900"
            }`}
            onClick={() => onSelect(s)}
          >
            <div className="flex items-center gap-2">
              <MapPin className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{s.name}</p>
                {s.code && <p className="text-[10px] text-slate-500">{s.code}</p>}
              </div>
              <button onClick={(e) => { e.stopPropagation(); onDelete(s.id); }}
                className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-red-500/10 text-slate-500 hover:text-red-400">
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════
 *  Sidebar — Linee + varianti
 * ════════════════════════════════════════════════════════════ */
function RoutesPanel({
  routes, variantsByRoute, openRouteId,
  onToggleRoute, onCreateRoute, onDeleteRoute,
  onCreateVariant, onEditVariant, onDeleteVariant,
}: {
  routes: PsRoute[];
  variantsByRoute: Record<string, PsVariant[]>;
  openRouteId: string | null;
  onToggleRoute: (id: string) => void;
  onCreateRoute: (input: { shortName: string; longName?: string; color?: string }) => Promise<PsRoute | undefined>;
  onDeleteRoute: (id: string) => void;
  onCreateVariant: (routeId: string, name: string, dir: number) => Promise<PsVariant | undefined>;
  onEditVariant: (routeId: string, variantId: string) => void;
  onDeleteVariant: (id: string) => void;
}) {
  const [creating, setCreating] = useState(false);
  const [newShort, setNewShort] = useState("");
  const [newLong, setNewLong] = useState("");
  const [newColor, setNewColor] = useState("#10b981");

  const [varForm, setVarForm] = useState<{ routeId: string; name: string; direction: number } | null>(null);

  return (
    <div className="p-3 space-y-3">
      {!creating ? (
        <button onClick={() => setCreating(true)}
          className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-emerald-500/90 hover:bg-emerald-500 text-white text-sm font-medium">
          <Plus className="w-4 h-4" /> Nuova linea
        </button>
      ) : (
        <div className="rounded-lg bg-slate-900 border border-slate-800 p-3 space-y-2">
          <input value={newShort} onChange={e => setNewShort(e.target.value)} placeholder="Codice (es. 5)"
            className="w-full px-2 py-1.5 rounded bg-slate-800 text-sm border border-slate-700" />
          <input value={newLong} onChange={e => setNewLong(e.target.value)} placeholder="Nome lungo (opzionale)"
            className="w-full px-2 py-1.5 rounded bg-slate-800 text-sm border border-slate-700" />
          <div className="flex items-center gap-2">
            <Palette className="w-3.5 h-3.5 text-slate-400" />
            <input type="color" value={newColor} onChange={e => setNewColor(e.target.value)}
              className="w-8 h-7 rounded border border-slate-700" />
            <span className="text-[11px] text-slate-500">{newColor}</span>
          </div>
          <div className="flex gap-2 pt-1">
            <button onClick={() => { setCreating(false); setNewShort(""); setNewLong(""); }}
              className="flex-1 text-xs px-2 py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300">Annulla</button>
            <button onClick={async () => {
              if (!newShort.trim()) { toast.error("Codice obbligatorio"); return; }
              const r = await onCreateRoute({ shortName: newShort.trim(), longName: newLong.trim() || undefined, color: newColor });
              if (r) { setCreating(false); setNewShort(""); setNewLong(""); }
            }}
              className="flex-1 text-xs px-2 py-1.5 rounded bg-emerald-500 hover:bg-emerald-400 text-white font-medium">Crea</button>
          </div>
        </div>
      )}

      <div className="space-y-1">
        {routes.length === 0 && <p className="text-center text-xs text-slate-500 py-8">Nessuna linea</p>}
        {routes.map(r => {
          const open = openRouteId === r.id;
          const variants = variantsByRoute[r.id] || [];
          return (
            <div key={r.id} className="rounded-lg border border-slate-800 overflow-hidden">
              <div className="flex items-center gap-2 px-3 py-2 hover:bg-slate-900 cursor-pointer"
                onClick={() => onToggleRoute(r.id)}>
                <span className="w-3 h-3 rounded-full shrink-0" style={{ background: r.color || "#10b981" }} />
                <span className="text-sm font-bold">{r.shortName}</span>
                <span className="text-xs text-slate-400 truncate flex-1">{r.longName}</span>
                <span className="text-[10px] text-slate-500">{r.variantCount ?? 0} var.</span>
                <ChevronRight className={`w-3.5 h-3.5 text-slate-500 transition-transform ${open ? "rotate-90" : ""}`} />
              </div>
              {open && (
                <div className="px-3 pb-3 space-y-1 border-t border-slate-800/50 bg-slate-900/30">
                  {variants.map(v => (
                    <div key={v.id} className="group flex items-center gap-2 py-1.5">
                      <span className={`text-[10px] px-1.5 py-0.5 rounded ${v.direction === 0 ? "bg-blue-500/20 text-blue-300" : "bg-purple-500/20 text-purple-300"}`}>
                        {v.direction === 0 ? "→" : "←"}
                      </span>
                      <span className="text-xs flex-1 truncate">{v.name}</span>
                      <span className="text-[10px] text-slate-500">{v.stopCount ?? 0} ferm.</span>
                      {v.hasShape && <span className="text-[10px] text-emerald-400">●</span>}
                      <button onClick={() => onEditVariant(r.id, v.id)}
                        className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/80 hover:bg-emerald-500 text-white opacity-0 group-hover:opacity-100">
                        Edita
                      </button>
                      <button onClick={() => onDeleteVariant(v.id)}
                        className="opacity-0 group-hover:opacity-100 p-0.5 text-slate-500 hover:text-red-400">
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                  {varForm?.routeId === r.id ? (
                    <div className="flex gap-1 pt-1">
                      <input value={varForm.name} onChange={e => setVarForm({ ...varForm, name: e.target.value })}
                        placeholder="Nome variante" autoFocus
                        className="flex-1 px-2 py-1 rounded bg-slate-800 text-xs border border-slate-700" />
                      <select value={varForm.direction} onChange={e => setVarForm({ ...varForm, direction: Number(e.target.value) })}
                        className="px-1 py-1 rounded bg-slate-800 text-xs border border-slate-700">
                        <option value={0}>And.</option><option value={1}>Rit.</option>
                      </select>
                      <button onClick={async () => {
                        if (!varForm.name.trim()) return;
                        const v = await onCreateVariant(r.id, varForm.name.trim(), varForm.direction);
                        if (v) setVarForm(null);
                      }} className="px-2 py-1 rounded bg-emerald-500 text-white text-xs">OK</button>
                      <button onClick={() => setVarForm(null)} className="px-1 text-slate-500"><X className="w-3 h-3" /></button>
                    </div>
                  ) : (
                    <div className="flex gap-1 pt-1">
                      <button onClick={() => setVarForm({ routeId: r.id, name: "", direction: 0 })}
                        className="flex-1 text-[11px] px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 flex items-center justify-center gap-1">
                        <Plus className="w-3 h-3" /> Variante
                      </button>
                      <button onClick={() => onDeleteRoute(r.id)}
                        className="text-[11px] px-2 py-1 rounded bg-red-500/10 hover:bg-red-500/20 text-red-400">
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════
 *  Sidebar — Calendari (semplificato)
 * ════════════════════════════════════════════════════════════ */
function CalendarsPanel({
  calendars, onCreate, onDelete,
}: {
  calendars: PsCalendar[];
  onCreate: (input: any) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const today = new Date().toISOString().slice(0, 10);
  const nextYear = new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10);
  const [form, setForm] = useState({
    code: "", name: "", startDate: today, endDate: nextYear,
    monday: true, tuesday: true, wednesday: true, thursday: true, friday: true,
    saturday: false, sunday: false,
  });
  const dows = [
    ["monday", "L"], ["tuesday", "M"], ["wednesday", "M"], ["thursday", "G"],
    ["friday", "V"], ["saturday", "S"], ["sunday", "D"],
  ] as const;
  return (
    <div className="p-3 space-y-3">
      {!open ? (
        <button onClick={() => setOpen(true)}
          className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-emerald-500/90 hover:bg-emerald-500 text-white text-sm font-medium">
          <Plus className="w-4 h-4" /> Nuovo calendario
        </button>
      ) : (
        <div className="rounded-lg bg-slate-900 border border-slate-800 p-3 space-y-2">
          <input value={form.code} onChange={e => setForm({ ...form, code: e.target.value })} placeholder="Codice (es. WEEKDAY)"
            className="w-full px-2 py-1.5 rounded bg-slate-800 text-sm border border-slate-700" />
          <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="Nome (opzionale)"
            className="w-full px-2 py-1.5 rounded bg-slate-800 text-sm border border-slate-700" />
          <div className="flex gap-1">
            {dows.map(([k, lbl]) => (
              <button key={k} onClick={() => setForm({ ...form, [k]: !form[k] } as any)}
                className={`flex-1 text-xs py-1.5 rounded font-medium ${(form as any)[k] ? "bg-emerald-500 text-white" : "bg-slate-800 text-slate-500"}`}>
                {lbl}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <input type="date" value={form.startDate} onChange={e => setForm({ ...form, startDate: e.target.value })}
              className="px-2 py-1.5 rounded bg-slate-800 text-xs border border-slate-700" />
            <input type="date" value={form.endDate} onChange={e => setForm({ ...form, endDate: e.target.value })}
              className="px-2 py-1.5 rounded bg-slate-800 text-xs border border-slate-700" />
          </div>
          <div className="flex gap-2 pt-1">
            <button onClick={() => setOpen(false)} className="flex-1 text-xs px-2 py-1.5 rounded bg-slate-800 text-slate-300">Annulla</button>
            <button onClick={async () => { if (!form.code.trim()) { toast.error("Codice obbligatorio"); return; } await onCreate(form); setOpen(false); }}
              className="flex-1 text-xs px-2 py-1.5 rounded bg-emerald-500 text-white font-medium">Crea</button>
          </div>
        </div>
      )}

      <div className="space-y-1">
        {calendars.length === 0 && <p className="text-center text-xs text-slate-500 py-8">Nessun calendario</p>}
        {calendars.map(c => (
          <div key={c.id} className="group rounded-lg border border-slate-800 px-3 py-2 hover:bg-slate-900">
            <div className="flex items-center gap-2">
              <CalendarIcon className="w-3.5 h-3.5 text-emerald-400" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium">{c.code}</p>
                <p className="text-[10px] text-slate-500">{c.startDate} → {c.endDate}</p>
              </div>
              <button onClick={() => onDelete(c.id)} className="opacity-0 group-hover:opacity-100 p-1 text-slate-500 hover:text-red-400">
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
            <div className="flex gap-0.5 mt-1.5">
              {(["monday","tuesday","wednesday","thursday","friday","saturday","sunday"] as const).map((d, i) => (
                <span key={d} className={`text-[9px] w-4 h-4 flex items-center justify-center rounded ${(c as any)[d] ? "bg-emerald-500/30 text-emerald-200" : "bg-slate-800 text-slate-600"}`}>
                  {"LMMGVSD"[i]}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════
 *  Sidebar — Cluster di cambio (interscambi)
 *  Replicato qui (versione "lite") al posto di una pagina dedicata.
 * ════════════════════════════════════════════════════════════ */
function ClustersPanel({
  projectId, stops, clusters, onChanged, onFlyTo,
}: {
  projectId: string;
  stops: PsStop[];
  clusters: PsCluster[];
  onChanged: () => Promise<void>;
  onFlyTo: (lat: number, lon: number) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = clusters.find(c => c.id === selectedId) ?? null;
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newKind, setNewKind] = useState<PsClusterKind>("interchange");
  const [newRadius, setNewRadius] = useState(150);
  const [stopFilter, setStopFilter] = useState("");
  const [pendingStopIds, setPendingStopIds] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  // Suggest dialog state
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [suggestRadius, setSuggestRadius] = useState(150);
  const [suggestMinSize, setSuggestMinSize] = useState(2);
  const [suggestions, setSuggestions] = useState<PsClusterSuggestion[]>([]);
  const [suggestSelected, setSuggestSelected] = useState<Set<number>>(new Set());
  const [suggestLoading, setSuggestLoading] = useState(false);

  const KIND_LABEL: Record<PsClusterKind, string> = {
    interchange: "Punto di cambio",
    none: "Nodo logico",
  };
  const KIND_COLOR: Record<PsClusterKind, string> = {
    interchange: "#0ea5e9",
    none: "#64748b",
  };

  // Quando seleziono un cluster ricavo le fermate associate
  useEffect(() => {
    if (!selected) { setPendingStopIds(new Set()); return; }
    const ids = new Set<string>();
    for (const s of stops) if (s.clusterId === selected.id) ids.add(s.id);
    setPendingStopIds(ids);
  }, [selected?.id, stops]);

  const filteredStops = useMemo(() => {
    const q = stopFilter.trim().toLowerCase();
    if (!q) return stops;
    return stops.filter(s => s.name.toLowerCase().includes(q) || (s.code ?? "").toLowerCase().includes(q));
  }, [stops, stopFilter]);

  async function handleCreate() {
    if (!newName.trim()) { toast.error("Nome richiesto"); return; }
    setBusy(true);
    try {
      const c = await createPsCluster(projectId, { name: newName.trim(), kind: newKind, radiusM: newRadius });
      await onChanged();
      setSelectedId(c.id);
      setCreating(false); setNewName(""); setNewKind("interchange"); setNewRadius(150);
      toast.success("Cluster creato");
    } catch (e: any) { toast.error(e?.message || "Errore"); }
    finally { setBusy(false); }
  }

  async function handleSaveStops() {
    if (!selected) return;
    setBusy(true);
    try {
      await setPsClusterStops(projectId, selected.id, Array.from(pendingStopIds));
      await onChanged();
      toast.success("Fermate aggiornate");
    } catch (e: any) { toast.error(e?.message || "Errore"); }
    finally { setBusy(false); }
  }

  async function handleDelete(id: string) {
    if (!confirm("Eliminare questo cluster?")) return;
    try {
      await deletePsCluster(projectId, id);
      await onChanged();
      if (selectedId === id) setSelectedId(null);
      toast.success("Eliminato");
    } catch (e: any) { toast.error(e?.message || "Errore"); }
  }

  async function handleUpdateKind(id: string, kind: PsClusterKind) {
    try {
      await updatePsCluster(projectId, id, { kind });
      await onChanged();
    } catch (e: any) { toast.error(e?.message || "Errore"); }
  }

  async function handleRunSuggest() {
    setSuggestLoading(true);
    try {
      const r = await suggestPsClusters(projectId, { radius: suggestRadius, minSize: suggestMinSize });
      setSuggestions(r.suggestions);
      setSuggestSelected(new Set(r.suggestions.map((_, i) => i)));
    } catch (e: any) { toast.error(e?.message || "Errore"); }
    finally { setSuggestLoading(false); }
  }

  async function handleApplySuggestions() {
    const picked = suggestions.filter((_, i) => suggestSelected.has(i));
    let ok = 0, ko = 0;
    for (const s of picked) {
      try {
        const c = await createPsCluster(projectId, {
          name: s.suggestedName, kind: "interchange",
          centerLat: s.centerLat, centerLon: s.centerLon, radiusM: suggestRadius,
        });
        await setPsClusterStops(projectId, c.id, s.stops.map(x => x.id));
        ok++;
      } catch { ko++; }
    }
    await onChanged();
    toast.success(`Creati ${ok} cluster${ko ? `, ${ko} errori` : ""}`);
    setSuggestOpen(false); setSuggestions([]);
  }

  function toggleStop(id: string) {
    setPendingStopIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="p-2 border-b border-slate-800 flex gap-1.5">
        <button onClick={() => setCreating(true)} className="flex-1 px-2 py-1.5 rounded bg-cyan-600 hover:bg-cyan-500 text-white text-xs flex items-center justify-center gap-1">
          <Plus className="w-3.5 h-3.5" /> Nuovo
        </button>
        <button onClick={() => { setSuggestOpen(true); setSuggestions([]); }} className="flex-1 px-2 py-1.5 rounded bg-violet-600 hover:bg-violet-500 text-white text-xs flex items-center justify-center gap-1">
          ✨ Suggerisci
        </button>
      </div>

      {/* Form creazione */}
      {creating && (
        <div className="p-3 border-b border-slate-800 bg-slate-900 space-y-2">
          <input autoFocus value={newName} onChange={e => setNewName(e.target.value)} placeholder="Nome cluster"
            className="w-full px-2 py-1.5 rounded bg-slate-800 text-xs border border-slate-700" />
          <div className="flex gap-2">
            <select value={newKind} onChange={e => setNewKind(e.target.value as PsClusterKind)}
              className="flex-1 px-2 py-1.5 rounded bg-slate-800 text-xs border border-slate-700">
              {Object.entries(KIND_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
            <input type="number" min={20} max={1000} step={10} value={newRadius} onChange={e => setNewRadius(parseInt(e.target.value) || 150)}
              className="w-20 px-2 py-1.5 rounded bg-slate-800 text-xs border border-slate-700" />
          </div>
          <div className="flex gap-2">
            <button onClick={() => { setCreating(false); setNewName(""); }} className="flex-1 text-xs px-2 py-1.5 rounded bg-slate-800 text-slate-300">Annulla</button>
            <button onClick={handleCreate} disabled={busy} className="flex-1 text-xs px-2 py-1.5 rounded bg-cyan-500 text-white font-medium">
              {busy ? <Loader2 className="w-3 h-3 animate-spin inline" /> : "Crea"}
            </button>
          </div>
        </div>
      )}

      {/* Lista cluster */}
      <div className="flex-1 overflow-auto">
        {clusters.length === 0 && (
          <div className="p-6 text-center text-slate-500 text-xs">
            Nessun cluster.<br />Crea il primo o usa <em>Suggerisci</em>.
          </div>
        )}
        {clusters.map(c => (
          <button key={c.id} onClick={() => {
              setSelectedId(c.id);
              if (c.centerLat != null && c.centerLon != null) onFlyTo(Number(c.centerLat), Number(c.centerLon));
            }}
            className={`w-full text-left px-3 py-2 border-b border-slate-800 hover:bg-slate-800 transition flex items-center gap-2 ${selectedId === c.id ? "bg-slate-800" : ""}`}>
            <div className="w-1.5 h-7 rounded" style={{ background: KIND_COLOR[c.kind] }} />
            <div className="flex-1 min-w-0">
              <div className="text-xs font-medium truncate">{c.name}</div>
              <div className="text-[10px] text-slate-500">{KIND_LABEL[c.kind]} · {c.stopCount ?? 0} fermate · r={c.radiusM}m</div>
            </div>
          </button>
        ))}
      </div>

      {/* Pannello dettaglio cluster */}
      {selected && (
        <div className="border-t border-slate-800 max-h-[55%] flex flex-col bg-slate-900">
          <div className="p-2 border-b border-slate-800 flex items-center gap-2">
            <input value={selected.name} onChange={(e) => updatePsCluster(projectId, selected.id, { name: e.target.value }).then(onChanged)}
              className="flex-1 px-2 py-1 rounded bg-slate-800 text-xs border border-slate-700" />
            <button onClick={() => handleDelete(selected.id)} className="p-1 rounded text-rose-400 hover:bg-rose-500/10">
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="px-2 py-1.5 border-b border-slate-800 flex gap-1">
            {(["interchange", "none"] as PsClusterKind[]).map(k => (
              <button key={k} onClick={() => handleUpdateKind(selected.id, k)}
                className={`flex-1 px-2 py-1 rounded text-[10px] font-medium border ${selected.kind === k ? "bg-cyan-500/20 border-cyan-500 text-cyan-200" : "bg-slate-800 border-slate-700 text-slate-400"}`}>
                {KIND_LABEL[k]}
              </button>
            ))}
          </div>
          <div className="p-2 border-b border-slate-800 flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="w-3 h-3 absolute left-2 top-1.5 text-slate-500" />
              <input value={stopFilter} onChange={e => setStopFilter(e.target.value)} placeholder="Cerca fermata…"
                className="w-full pl-6 pr-2 py-1 rounded bg-slate-800 text-[11px] border border-slate-700" />
            </div>
            <button onClick={handleSaveStops} disabled={busy}
              className="px-2 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-[10px] flex items-center gap-1">
              {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />} {pendingStopIds.size}
            </button>
          </div>
          <div className="flex-1 overflow-auto">
            {filteredStops.map(s => (
              <label key={s.id} className={`flex items-center gap-2 px-3 py-1 text-[11px] hover:bg-slate-800 cursor-pointer ${pendingStopIds.has(s.id) ? "bg-cyan-500/10" : ""}`}>
                <input type="checkbox" checked={pendingStopIds.has(s.id)} onChange={() => toggleStop(s.id)} className="accent-cyan-500" />
                <MapPin className="w-3 h-3 text-slate-500" />
                <span className="flex-1 truncate">{s.name}</span>
              </label>
            ))}
          </div>
        </div>
      )}

      {/* Modal Suggerisci */}
      {suggestOpen && (
        <div className="absolute inset-0 z-30 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4" onClick={() => setSuggestOpen(false)}>
          <div className="bg-slate-900 border border-slate-700 rounded-xl p-4 max-w-md w-full max-h-[80vh] flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-cyan-300">Suggerisci cluster</h3>
              <button onClick={() => setSuggestOpen(false)} className="text-slate-400 hover:text-white"><X className="w-4 h-4" /></button>
            </div>
            <div className="grid grid-cols-2 gap-2 mb-3">
              <label className="text-[10px] text-slate-400">Raggio (m)
                <input type="number" min={20} max={1000} step={10} value={suggestRadius} onChange={e => setSuggestRadius(parseInt(e.target.value) || 150)}
                  className="mt-0.5 w-full px-2 py-1 rounded bg-slate-800 text-xs border border-slate-700" />
              </label>
              <label className="text-[10px] text-slate-400">Min fermate
                <input type="number" min={2} max={20} value={suggestMinSize} onChange={e => setSuggestMinSize(parseInt(e.target.value) || 2)}
                  className="mt-0.5 w-full px-2 py-1 rounded bg-slate-800 text-xs border border-slate-700" />
              </label>
            </div>
            <button onClick={handleRunSuggest} disabled={suggestLoading}
              className="w-full px-3 py-1.5 rounded bg-violet-600 hover:bg-violet-500 text-white text-xs mb-3 flex items-center justify-center gap-2">
              {suggestLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "✨"}
              {suggestLoading ? "Calcolo…" : "Calcola suggerimenti"}
            </button>
            <div className="flex-1 overflow-auto border border-slate-800 rounded">
              {suggestions.length === 0 && !suggestLoading && <p className="text-center text-xs text-slate-500 p-4">Premi "Calcola" per vedere i suggerimenti</p>}
              {suggestions.map((s, i) => (
                <label key={i} className={`flex items-start gap-2 px-2 py-1.5 border-b border-slate-800 hover:bg-slate-800 cursor-pointer ${suggestSelected.has(i) ? "bg-cyan-500/10" : ""}`}>
                  <input type="checkbox" checked={suggestSelected.has(i)}
                    onChange={() => setSuggestSelected(prev => { const n = new Set(prev); n.has(i) ? n.delete(i) : n.add(i); return n; })}
                    className="accent-cyan-500 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium truncate">{s.suggestedName}</p>
                    <p className="text-[10px] text-slate-500">{s.stops.length} fermate</p>
                  </div>
                </label>
              ))}
            </div>
            {suggestions.length > 0 && (
              <button onClick={handleApplySuggestions} className="mt-3 w-full px-3 py-1.5 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-xs">
                Crea {suggestSelected.size} cluster selezionati
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════
 *  Sidebar — Editor variante (sostituisce sidebar normale)
 * ════════════════════════════════════════════════════════════ */
function VariantEditorPanel({
  editor, stopsAll, snapBusy, saving,
  onAddStop, onMoveStop, onRemoveStop, onChangeMode, onSave, onExit,
}: {
  editor: VariantEditorState;
  stopsAll: PsStop[];
  snapBusy: boolean;
  saving: boolean;
  onAddStop: (s: PsStop) => void;
  onMoveStop: (from: number, to: number) => void;
  onRemoveStop: (idx: number) => void;
  onChangeMode: (m: "driving" | "manual") => void;
  onSave: () => void;
  onExit: () => void;
}) {
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [stopPicker, setStopPicker] = useState("");

  const filteredStops = useMemo(() => {
    const qq = stopPicker.trim().toLowerCase();
    if (!qq) return [];
    return stopsAll.filter(s => s.name.toLowerCase().includes(qq) || (s.code || "").toLowerCase().includes(qq)).slice(0, 8);
  }, [stopsAll, stopPicker]);

  return (
    <div className="flex flex-col h-full">
      {/* Header editor */}
      <div className="px-4 py-3 border-b border-emerald-500/20 bg-emerald-500/5 shrink-0">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-[10px] uppercase tracking-wider text-emerald-300/80 font-semibold">Editor variante</p>
            <p className="text-sm font-medium text-slate-100 mt-0.5">Tracciato + sequenza</p>
          </div>
          <button onClick={onExit} className="p-1 rounded hover:bg-slate-800 text-slate-400">
            <X className="w-4 h-4" />
          </button>
        </div>
        {/* Stat */}
        <div className="grid grid-cols-2 gap-2 mt-3">
          <div className="rounded bg-slate-900/60 border border-slate-800 px-2 py-1.5">
            <p className="text-[9px] uppercase text-slate-500">Distanza</p>
            <p className="text-sm font-mono text-slate-200">
              {editor.distanceM != null ? `${(editor.distanceM / 1000).toFixed(2)} km` : "—"}
            </p>
          </div>
          <div className="rounded bg-slate-900/60 border border-slate-800 px-2 py-1.5">
            <p className="text-[9px] uppercase text-slate-500">Durata stim.</p>
            <p className="text-sm font-mono text-slate-200">
              {editor.durationS != null ? `${Math.round(editor.durationS / 60)} min` : "—"}
            </p>
          </div>
        </div>
      </div>

      {/* Mode toggle */}
      <div className="px-4 py-2 border-b border-slate-800 shrink-0">
        <p className="text-[10px] uppercase tracking-wider text-slate-500 mb-1.5">Modalità tracciato</p>
        <div className="flex gap-1 bg-slate-900 rounded p-0.5 border border-slate-800">
          <button onClick={() => onChangeMode("driving")}
            className={`flex-1 text-xs py-1.5 rounded font-medium transition ${editor.shapeMode === "driving" ? "bg-indigo-500 text-white" : "text-slate-400 hover:text-slate-200"}`}>
            🚗 Auto (snap strade)
          </button>
          <button onClick={() => onChangeMode("manual")}
            className={`flex-1 text-xs py-1.5 rounded font-medium transition ${editor.shapeMode === "manual" ? "bg-amber-500 text-white" : "text-slate-400 hover:text-slate-200"}`}>
            ✏️ Manuale
          </button>
        </div>
        {snapBusy && <p className="text-[10px] text-indigo-300 mt-1.5 flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> Calcolo percorso…</p>}
      </div>

      {/* Sequenza fermate */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        <p className="text-[10px] uppercase tracking-wider text-slate-500">Sequenza fermate ({editor.stops.length})</p>
        {editor.stops.length === 0 && (
          <p className="text-xs text-slate-500 text-center py-4 italic">
            Aggiungi le fermate cliccandole sulla mappa o cercandole qui sotto.
          </p>
        )}
        <div className="space-y-1">
          {editor.stops.map((vs, idx) => (
            <div
              key={`${vs.stopId}-${idx}`}
              draggable
              onDragStart={() => setDragIdx(idx)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => { if (dragIdx !== null && dragIdx !== idx) onMoveStop(dragIdx, idx); setDragIdx(null); }}
              className={`group flex items-center gap-2 rounded px-2 py-1.5 border cursor-move transition ${
                dragIdx === idx ? "border-emerald-500 bg-emerald-500/10" : "border-slate-800 bg-slate-900/40 hover:border-slate-700"
              }`}
            >
              <GripVertical className="w-3 h-3 text-slate-600" />
              <span className="text-[10px] font-mono text-slate-500 w-5 text-right">{vs.seq}</span>
              <span className="text-xs flex-1 truncate">{vs.stopName}</span>
              <button onClick={() => onRemoveStop(idx)}
                className="opacity-0 group-hover:opacity-100 p-0.5 text-slate-500 hover:text-red-400">
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>

        {/* Stop picker */}
        <div className="pt-3 border-t border-slate-800">
          <input value={stopPicker} onChange={e => setStopPicker(e.target.value)} placeholder="Cerca e aggiungi fermata…"
            className="w-full px-2 py-1.5 rounded bg-slate-900 text-xs border border-slate-800 focus:outline-none focus:border-emerald-500" />
          {filteredStops.length > 0 && (
            <div className="mt-1 space-y-0.5 max-h-40 overflow-y-auto">
              {filteredStops.map(s => (
                <button key={s.id} onClick={() => { onAddStop(s); setStopPicker(""); }}
                  className="w-full text-left text-xs px-2 py-1 rounded hover:bg-slate-800 flex items-center gap-2">
                  <Plus className="w-3 h-3 text-emerald-400" /> <span className="truncate">{s.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Save button */}
      <div className="p-3 border-t border-slate-800 shrink-0">
        <button onClick={onSave} disabled={saving || !editor.dirty}
          className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium">
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          {editor.dirty ? "Salva variante" : "Nessuna modifica"}
        </button>
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════
 *  Helpers UI
 * ════════════════════════════════════════════════════════════ */
function ToolBtn({
  label, icon: Icon, active, onClick, disabled,
}: { label: string; icon: any; active: boolean; onClick: () => void; disabled?: boolean }) {
  return (
    <button onClick={onClick} title={label} disabled={disabled}
      className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs font-medium transition ${
        active ? "bg-emerald-500 text-white shadow"
               : disabled ? "text-slate-600 cursor-not-allowed"
                          : "text-slate-400 hover:text-slate-200 hover:bg-slate-800"
      }`}>
      <Icon className="w-3.5 h-3.5" /> <span>{label}</span>
    </button>
  );
}

function DataTabBtn({
  icon: Icon, label, count, accent, active, onClick,
}: { icon: any; label: string; count?: number; accent: "emerald" | "cyan" | "indigo" | "orange"; active: boolean; onClick: () => void }) {
  const accentMap = {
    emerald: "border-emerald-500 text-emerald-300 bg-emerald-500/10",
    cyan:    "border-cyan-500 text-cyan-300 bg-cyan-500/10",
    indigo:  "border-indigo-500 text-indigo-300 bg-indigo-500/10",
    orange:  "border-orange-500 text-orange-300 bg-orange-500/10",
  } as const;
  return (
    <button onClick={onClick} title={label}
      className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium border transition ${
        active ? accentMap[accent]
               : "border-transparent text-slate-400 hover:text-slate-200 hover:bg-slate-900"
      }`}>
      <Icon className="w-3.5 h-3.5" />
      <span>{label}</span>
      {count != null && <span className="text-[10px] tabular-nums opacity-70">{count}</span>}
    </button>
  );
}

function SidebarTabBtn({
  label, icon: Icon, count, active, onClick,
}: { label: string; icon: any; count: number; active: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick}
      className={`flex-1 flex flex-col items-center gap-0.5 py-2.5 text-[11px] border-b-2 transition ${
        active ? "border-emerald-500 text-emerald-300 bg-emerald-500/5"
               : "border-transparent text-slate-500 hover:text-slate-300 hover:bg-slate-900/50"
      }`}>
      <Icon className="w-4 h-4" />
      <span className="font-medium">{label}</span>
      <span className="text-[9px] text-slate-600">{count}</span>
    </button>
  );}

/* ════════════════════════════════════════════════════════════
 *  Mini-form: nuova fermata (popup mappa)
 * ════════════════════════════════════════════════════════════ */
function NewStopForm({
  lat, lon, initialName = "", initialCode = "", onCancel, onSave,
}: {
  lat: number; lon: number;
  initialName?: string; initialCode?: string;
  onCancel: () => void;
  onSave: (data: { name: string; code?: string; lat: number; lon: number }) => void;
}) {
  const [name, setName] = useState(initialName);
  const [code, setCode] = useState(initialCode);
  return (
    <div className="p-1 min-w-[220px]" onClick={e => e.stopPropagation()}>
      <p className="text-[11px] text-slate-500 mb-2">{lat.toFixed(5)}, {lon.toFixed(5)}</p>
      <input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="Nome fermata *"
        className="w-full px-2 py-1.5 mb-1.5 rounded bg-slate-100 text-sm text-slate-900 border border-slate-300 focus:outline-none focus:border-emerald-500" />
      <input value={code} onChange={e => setCode(e.target.value)} placeholder="Codice (opzionale)"
        className="w-full px-2 py-1.5 mb-2 rounded bg-slate-100 text-sm text-slate-900 border border-slate-300 focus:outline-none focus:border-emerald-500" />
      <div className="flex gap-1">
        <button onClick={onCancel}
          className="flex-1 text-xs px-2 py-1.5 rounded bg-slate-200 hover:bg-slate-300 text-slate-700">Annulla</button>
        <button onClick={() => { if (!name.trim()) { toast.error("Nome obbligatorio"); return; } onSave({ name: name.trim(), code: code.trim() || undefined, lat, lon }); }}
          className="flex-1 text-xs px-2 py-1.5 rounded bg-emerald-500 hover:bg-emerald-400 text-white font-medium">Salva</button>
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════
 *  Pannello Cluster (Network Engine) — sola lettura + apertura editor
 * ════════════════════════════════════════════════════════════ */
function NeClustersPanel({
  clusters, loading, onReload, onFlyTo,
}: {
  clusters: GlobalCluster[];
  loading?: boolean;
  onReload: () => Promise<void> | void;
  onFlyTo: (lat: number, lon: number) => void;
}) {
  return (
    <div className="p-3 space-y-2">
      <div className="flex items-center justify-between mb-2">
        <p className="text-[11px] text-slate-500">{clusters.length} cluster · sorgente Network Engine</p>
        <div className="flex gap-1">
          <button onClick={() => onReload()} title="Ricarica"
            className="text-[11px] px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300">↻</button>
          <a href="/cluster" target="_blank" rel="noopener noreferrer"
            className="text-[11px] px-2 py-1 rounded bg-cyan-600 hover:bg-cyan-500 text-white inline-flex items-center gap-1">
            <Pencil className="w-3 h-3" /> Gestisci
          </a>
        </div>
      </div>
      {loading && <p className="text-[11px] text-slate-500">Caricamento…</p>}
      {!loading && clusters.length === 0 && (
        <p className="text-[11px] text-slate-500">Nessun cluster definito. Aprilo con "Gestisci" per crearne uno.</p>
      )}
      {clusters.map(c => {
        const valid = (c.stops || []).filter(s => Number.isFinite(s.stopLat) && Number.isFinite(s.stopLon));
        const center = valid.length
          ? {
              lat: valid.reduce((a, s) => a + s.stopLat, 0) / valid.length,
              lon: valid.reduce((a, s) => a + s.stopLon, 0) / valid.length,
            }
          : null;
        return (
          <button key={c.id} onClick={() => center && onFlyTo(center.lat, center.lon)}
            className="w-full text-left rounded-lg border border-slate-800 hover:border-cyan-700 bg-slate-900/60 hover:bg-slate-900 p-2.5 transition">
            <div className="flex items-center gap-2 mb-1">
              <span className="w-3 h-3 rounded-sm shrink-0" style={{ backgroundColor: c.color || "#0ea5e9" }} />
              <span className="text-sm font-medium text-slate-200 truncate flex-1">{c.name}</span>
              <div className="flex gap-1">
                {c.isInterchange && <span className="text-[9px] px-1.5 py-0.5 rounded bg-cyan-500/15 text-cyan-300">CAMBIO</span>}
                {c.isLogical && <span className="text-[9px] px-1.5 py-0.5 rounded bg-slate-500/15 text-slate-300">LOGICO</span>}
              </div>
            </div>
            <p className="text-[10px] text-slate-500">{(c.stops || []).length} fermate</p>
          </button>
        );
      })}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════
 *  Pannello Depositi (Network Engine) — lista + crea + edita
 * ════════════════════════════════════════════════════════════ */
function NeDepotsPanel({
  depots, loading, onReload, onEdit, onCreate, onFlyTo,
}: {
  depots: GlobalDepot[];
  loading?: boolean;
  onReload: () => Promise<void> | void;
  onEdit: (d: GlobalDepot) => void;
  onCreate: () => void;
  onFlyTo: (lat: number, lon: number) => void;
}) {
  return (
    <div className="p-3 space-y-2">
      <div className="flex items-center justify-between mb-2">
        <p className="text-[11px] text-slate-500">{depots.length} depositi</p>
        <div className="flex gap-1">
          <button onClick={() => onReload()} title="Ricarica"
            className="text-[11px] px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300">↻</button>
          <button onClick={onCreate}
            className="text-[11px] px-2 py-1 rounded bg-orange-600 hover:bg-orange-500 text-white inline-flex items-center gap-1">
            <Plus className="w-3 h-3" /> Nuovo
          </button>
        </div>
      </div>
      {loading && <p className="text-[11px] text-slate-500">Caricamento…</p>}
      {!loading && depots.length === 0 && (
        <p className="text-[11px] text-slate-500">Nessun deposito. Crea il primo con "Nuovo".</p>
      )}
      {depots.map(d => (
        <div key={d.id} className="rounded-lg border border-slate-800 bg-slate-900/60 p-2.5">
          <div className="flex items-center gap-2 mb-1">
            <span className="w-7 h-7 rounded-md shrink-0 flex items-center justify-center border border-slate-700"
              style={{ backgroundColor: d.color || "#f97316" }}>
              <Building2 className="w-3.5 h-3.5 text-white" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-slate-200 truncate">{d.name}</p>
              <p className="text-[10px] text-slate-500 truncate">
                {d.address || (d.lat != null && d.lon != null ? `${Number(d.lat).toFixed(4)}, ${Number(d.lon).toFixed(4)}` : "—")}
                {d.capacity != null && ` · cap ${d.capacity}`}
              </p>
            </div>
          </div>
          <div className="flex gap-1 mt-1.5">
            {d.lat != null && d.lon != null && (
              <button onClick={() => onFlyTo(Number(d.lat), Number(d.lon))}
                className="flex-1 text-[10px] px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300">Centra</button>
            )}
            <button onClick={() => onEdit(d)}
              className="flex-1 text-[10px] px-2 py-1 rounded bg-orange-600/20 hover:bg-orange-600/30 text-orange-300 inline-flex items-center justify-center gap-1">
              <Pencil className="w-3 h-3" /> Modifica
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════
 *  Modale modifica/creazione deposito (overlay full-screen)
 * ════════════════════════════════════════════════════════════ */
function DepotEditModal({
  depot, hidden, onChange, onPickLocation, onClose, onSaved,
}: {
  depot: GlobalDepot;
  hidden?: boolean;
  onChange?: (d: GlobalDepot) => void;
  onPickLocation?: () => void;
  onClose: () => void;
  onSaved: () => Promise<void> | void;
}) {
  const isNew = !depot.id;
  const [name, setName] = useState(depot.name || "");
  const [address, setAddress] = useState(depot.address || "");
  const [color, setColor] = useState(depot.color || "#f97316");
  const [lat, setLat] = useState<string>(depot.lat != null ? String(depot.lat) : "");
  const [lon, setLon] = useState<string>(depot.lon != null ? String(depot.lon) : "");
  const [capacity, setCapacity] = useState<string>(depot.capacity != null ? String(depot.capacity) : "");
  const [saving, setSaving] = useState(false);

  // Sync lat/lon dal parent (es. dopo pick dalla mappa)
  useEffect(() => {
    if (depot.lat != null) setLat(String(depot.lat));
    if (depot.lon != null) setLon(String(depot.lon));
  }, [depot.lat, depot.lon]);

  // Snapshot dei campi nel parent prima di nascondere il modale per il pick
  function handlePickClick() {
    onChange?.({
      ...depot,
      name: name.trim(),
      address: address.trim() || null,
      color,
      capacity: capacity.trim() === "" ? null : Number(capacity),
      lat: lat.trim() === "" ? null : Number(lat),
      lon: lon.trim() === "" ? null : Number(lon),
    });
    onPickLocation?.();
  }

  if (hidden) return null;

  async function save() {
    if (!name.trim()) { toast.error("Nome obbligatorio"); return; }
    const latN = lat.trim() === "" ? null : Number(lat);
    const lonN = lon.trim() === "" ? null : Number(lon);
    if (lat.trim() && (latN == null || !Number.isFinite(latN))) { toast.error("Latitudine non valida"); return; }
    if (lon.trim() && (lonN == null || !Number.isFinite(lonN))) { toast.error("Longitudine non valida"); return; }
    setSaving(true);
    try {
      const body = {
        name: name.trim(),
        address: address.trim() || null,
        color,
        lat: latN, lon: lonN,
        capacity: capacity.trim() === "" ? null : Number(capacity),
      };
      const r = await fetch(isNew ? "/api/depots" : `/api/depots/${depot.id}`, {
        method: isNew ? "POST" : "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      toast.success(isNew ? "Deposito creato" : "Deposito aggiornato");
      await onSaved();
    } catch (e: any) {
      toast.error("Errore", { description: e?.message });
    } finally { setSaving(false); }
  }

  async function remove() {
    if (!confirm(`Eliminare il deposito "${name}"?`)) return;
    setSaving(true);
    try {
      const r = await fetch(`/api/depots/${depot.id}`, { method: "DELETE" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      toast.success("Deposito eliminato");
      await onSaved();
    } catch (e: any) {
      toast.error("Errore", { description: e?.message });
    } finally { setSaving(false); }
  }

  return (
    <div className="absolute inset-0 z-40 bg-black/60 flex items-center justify-center" onClick={onClose}>
      <div className="bg-slate-950 border border-slate-800 rounded-xl shadow-2xl w-[420px] max-w-[90vw] p-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-semibold text-slate-100 flex items-center gap-2">
            <Building2 className="w-4 h-4 text-orange-400" />
            {isNew ? "Nuovo deposito" : "Modifica deposito"}
          </h3>
          <button onClick={onClose} className="p-1 rounded hover:bg-slate-800 text-slate-400"><X className="w-4 h-4" /></button>
        </div>
        <div className="space-y-3">
          <div>
            <label className="block text-[11px] text-slate-400 mb-1">Nome *</label>
            <input value={name} onChange={e => setName(e.target.value)}
              className="w-full px-2.5 py-2 rounded bg-slate-900 border border-slate-700 text-sm text-slate-100 focus:outline-none focus:border-orange-500" />
          </div>
          <div>
            <label className="block text-[11px] text-slate-400 mb-1">Indirizzo</label>
            <input value={address} onChange={e => setAddress(e.target.value)}
              className="w-full px-2.5 py-2 rounded bg-slate-900 border border-slate-700 text-sm text-slate-100 focus:outline-none focus:border-orange-500" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-[11px] text-slate-400 mb-1">Latitudine</label>
              <input value={lat} onChange={e => setLat(e.target.value)} placeholder="41.9028"
                className="w-full px-2.5 py-2 rounded bg-slate-900 border border-slate-700 text-sm text-slate-100 focus:outline-none focus:border-orange-500" />
            </div>
            <div>
              <label className="block text-[11px] text-slate-400 mb-1">Longitudine</label>
              <input value={lon} onChange={e => setLon(e.target.value)} placeholder="12.4964"
                className="w-full px-2.5 py-2 rounded bg-slate-900 border border-slate-700 text-sm text-slate-100 focus:outline-none focus:border-orange-500" />
            </div>
          </div>
          {onPickLocation && (
            <button
              type="button"
              onClick={handlePickClick}
              className="w-full px-3 py-2 rounded bg-orange-500/10 hover:bg-orange-500/20 border border-orange-500/40 text-orange-300 text-xs font-medium inline-flex items-center justify-center gap-2"
            >
              <MapPin className="w-3.5 h-3.5" />
              Scegli posizione sulla mappa
            </button>
          )}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-[11px] text-slate-400 mb-1">Capacità mezzi</label>
              <input value={capacity} onChange={e => setCapacity(e.target.value)} type="number" min={0}
                className="w-full px-2.5 py-2 rounded bg-slate-900 border border-slate-700 text-sm text-slate-100 focus:outline-none focus:border-orange-500" />
            </div>
            <div>
              <label className="block text-[11px] text-slate-400 mb-1">Colore</label>
              <input value={color} onChange={e => setColor(e.target.value)} type="color"
                className="w-full h-9 rounded bg-slate-900 border border-slate-700 cursor-pointer" />
            </div>
          </div>
        </div>
        <div className="flex gap-2 mt-5">
          {!isNew && (
            <button onClick={remove} disabled={saving}
              className="px-3 py-2 rounded bg-red-600/20 hover:bg-red-600/30 text-red-400 text-xs font-medium inline-flex items-center gap-1">
              <Trash2 className="w-3.5 h-3.5" /> Elimina
            </button>
          )}
          <div className="flex-1" />
          <button onClick={onClose} disabled={saving}
            className="px-3 py-2 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs">Annulla</button>
          <button onClick={save} disabled={saving}
            className="px-4 py-2 rounded bg-orange-600 hover:bg-orange-500 text-white text-xs font-medium inline-flex items-center gap-1">
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
            Salva
          </button>
        </div>
      </div>
    </div>
  );
}
