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
  ChevronDown, Pencil, Search, Flame,
} from "lucide-react";
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
} from "@/lib/planning-studio-api";

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN || "";
const DEFAULT_VIEW = { longitude: 12.4964, latitude: 41.9028, zoom: 11 }; // Roma

type Tool = "select" | "addStop" | "editVariant";
type DataPanel = "stops" | "routes" | "calendars" | null;

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

  const mapRef = useRef<MapRef>(null);

  /* ─── Load ─── */
  useEffect(() => {
    if (!projectId) return;
    (async () => {
      setLoading(true);
      try {
        const [p, s, r, c] = await Promise.all([
          getPsProject(projectId),
          listPsStops(projectId),
          listPsRoutes(projectId),
          listPsCalendars(projectId),
        ]);
        setProject(p);
        setStops(s);
        setRoutes(r);
        setCalendars(c);
      } catch (e: any) {
        toast.error("Errore caricamento", { description: e?.message });
      } finally { setLoading(false); }
    })();
  }, [projectId]);

  /* ─── Map handlers ─── */
  const handleMapClick = useCallback((e: MapMouseEvent) => {
    const { lng, lat } = e.lngLat;

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
  }, [tool, editor]);

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
  const mapCursor = tool === "addStop" ? "crosshair"
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
      const [s, rr, c] = await Promise.all([
        listPsStops(projectId), listPsRoutes(projectId), listPsCalendars(projectId),
      ]);
      setStops(s); setRoutes(rr); setCalendars(c);
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

        {/* Cluster fermate */}
        <button
          onClick={() => navigate(`/planning-studio/${projectId}/clusters`)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-900 hover:bg-slate-800 border border-slate-800 text-cyan-300"
          title="Gestisci cluster di fermate (interscambi)"
        >
          <Layers className="w-3.5 h-3.5" /> Cluster
        </button>

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
      <div className="flex-1 relative overflow-hidden">
        {!MAPBOX_TOKEN && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-slate-900/80 text-amber-300 text-sm">
            ⚠️ VITE_MAPBOX_TOKEN non configurato
          </div>
        )}
        <Map
          ref={mapRef}
          mapboxAccessToken={MAPBOX_TOKEN}
          initialViewState={DEFAULT_VIEW}
          mapStyle="mapbox://styles/mapbox/light-v11"
          onClick={handleMapClick}
          cursor={mapCursor}
          style={{ width: "100%", height: "100%" }}
        >
          <NavigationControl position="bottom-right" />

          {/* Tutte le fermate del progetto */}
          {stops.map(s => {
            const inSeq = editor?.stops.find(vs => vs.stopId === s.id);
            const isSel = selectedStopId === s.id;
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
                <div className={`w-3 h-3 rounded-full border-2 cursor-pointer transition-all ${
                  inSeq ? "bg-emerald-400 border-emerald-200 scale-125 shadow-lg shadow-emerald-500/50"
                        : isSel ? "bg-cyan-400 border-white scale-125"
                        : "bg-white border-slate-700 hover:scale-125"
                }`} title={s.name} />
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
}: { icon: any; label: string; count: number; accent: "emerald" | "cyan" | "indigo"; active: boolean; onClick: () => void }) {
  const accentMap = {
    emerald: "border-emerald-500 text-emerald-300 bg-emerald-500/10",
    cyan:    "border-cyan-500 text-cyan-300 bg-cyan-500/10",
    indigo:  "border-indigo-500 text-indigo-300 bg-indigo-500/10",
  } as const;
  return (
    <button onClick={onClick} title={label}
      className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium border transition ${
        active ? accentMap[accent]
               : "border-transparent text-slate-400 hover:text-slate-200 hover:bg-slate-900"
      }`}>
      <Icon className="w-3.5 h-3.5" />
      <span>{label}</span>
      <span className="text-[10px] tabular-nums opacity-70">{count}</span>
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
