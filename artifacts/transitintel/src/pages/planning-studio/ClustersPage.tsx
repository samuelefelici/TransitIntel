/**
 * PlannerStudio — Cluster di fermate (interscambi, hub, terminal).
 *
 * Vista a 2 colonne:
 *   - sx: lista cluster + pannello dettaglio cluster selezionato (lista fermate
 *     associate + multi-select fermate disponibili)
 *   - dx: mappa Mapbox con cerchi cluster (raggio in metri) e marker fermate
 *
 * Permette anche il "Suggerisci cluster" (greedy raggio configurabile).
 */
import { useMemo, useState, useEffect, useRef } from "react";
import { useLocation, useParams, Link } from "wouter";
import Map, { Marker, Source, Layer, NavigationControl, type MapRef } from "react-map-gl/mapbox";
import "mapbox-gl/dist/mapbox-gl.css";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import PsProjectNav from "@/components/planning-studio/PsProjectNav";
import {
  ArrowLeft, Plus, Trash2, Save, X, Sparkles, Search, Layers,
  Loader2, Check, MapPin, Pencil, Eye, EyeOff, ChevronRight, ChevronDown,
  PencilRuler,
} from "lucide-react";
import {
  getPsProject,
  listPsStops, type PsStop,
  listPsClusters, createPsCluster, updatePsCluster, deletePsCluster,
  setPsClusterStops, suggestPsClusters,
  type PsCluster, type PsClusterKind, type PsClusterSuggestion,
} from "@/lib/planning-studio-api";

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN || "";
const DEFAULT_VIEW = { longitude: 12.4964, latitude: 41.9028, zoom: 11 };

const KIND_LABEL: Record<PsClusterKind, string> = {
  interchange: "Punto di cambio",
  rest: "Nodo di sosta",
  none: "Nodo logico",
};
const KIND_COLOR: Record<PsClusterKind, string> = {
  interchange: "#0ea5e9",
  rest: "#f59e0b",
  none: "#64748b",
};
const KIND_DESC: Record<PsClusterKind, string> = {
  interchange: "Usato da Scheduling Engine come change point (cambio vettura nei turni macchina)",
  rest: "Luogo idoneo alla sosta inoperosa extraurbana (deposito o capolinea). Usato dallo scheduler turni guida.",
  none: "Solo raggruppamento logico (intermodalità, interscambio passeggeri, ecc.)",
};

export default function PlanningStudioClustersPage() {
  const params = useParams<{ id: string }>();
  const projectId = params?.id ?? "";
  const [, navigate] = useLocation();
  const qc = useQueryClient();

  const projectQ = useQuery({
    queryKey: ["ps", "project", projectId],
    queryFn: () => getPsProject(projectId),
    enabled: !!projectId,
  });
  const stopsQ = useQuery({
    queryKey: ["ps", projectId, "stops"],
    queryFn: () => listPsStops(projectId),
    enabled: !!projectId,
  });
  const clustersQ = useQuery({
    queryKey: ["ps", projectId, "clusters"],
    queryFn: () => listPsClusters(projectId),
    enabled: !!projectId,
  });

  const stops = stopsQ.data ?? [];
  const clusters = clustersQ.data ?? [];

  /* ─── Selezione cluster ─── */
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = useMemo(
    () => clusters.find(c => c.id === selectedId) ?? null,
    [clusters, selectedId],
  );

  // mappa fermate-per-cluster (basata sull'attributo cluster_id delle fermate)
  // → ricavata direttamente dal campo PsStop.clusterId restituito dal server.

  /* ─── Centro mappa ─── */
  const initialView = useMemo(() => {
    if (stops.length === 0) return DEFAULT_VIEW;
    const lats = stops.map(s => Number(s.lat));
    const lons = stops.map(s => Number(s.lon));
    return {
      longitude: (Math.min(...lons) + Math.max(...lons)) / 2,
      latitude: (Math.min(...lats) + Math.max(...lats)) / 2,
      zoom: 12,
    };
  }, [stops.length]);

  /* ─── Mutations ─── */
  const createMut = useMutation({
    mutationFn: (input: Partial<PsCluster> & { name: string }) => createPsCluster(projectId, input),
    onSuccess: (c) => {
      qc.invalidateQueries({ queryKey: ["ps", projectId, "clusters"] });
      setSelectedId(c.id);
      toast.success("Nodo creato");
    },
    onError: (e: any) => toast.error(e?.message || "Errore creazione cluster"),
  });
  const updateMut = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<PsCluster> }) =>
      updatePsCluster(projectId, id, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["ps", projectId, "clusters"] }),
    onError: (e: any) => toast.error(e?.message || "Errore aggiornamento"),
  });
  const deleteMut = useMutation({
    mutationFn: (id: string) => deletePsCluster(projectId, id),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ["ps", projectId, "clusters"] });
      qc.invalidateQueries({ queryKey: ["ps", projectId, "stops"] });
      if (selectedId === id) setSelectedId(null);
      toast.success("Nodo eliminato");
    },
    onError: (e: any) => toast.error(e?.message || "Errore eliminazione"),
  });
  const setStopsMut = useMutation({
    mutationFn: ({ id, stopIds }: { id: string; stopIds: string[] }) =>
      setPsClusterStops(projectId, id, stopIds),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ps", projectId, "clusters"] });
      qc.invalidateQueries({ queryKey: ["ps", projectId, "stops"] });
      toast.success("Fermate aggiornate");
    },
    onError: (e: any) => toast.error(e?.message || "Errore set fermate"),
  });

  // Bulk delete: utile quando un import è andato male e il progetto è
  // pieno di cluster spazzatura. Esegue le delete in parallelo.
  const [bulkDeleting, setBulkDeleting] = useState(false);
  async function deleteAllClusters() {
    if (clusters.length === 0) return;
    if (!confirm(
      `Eliminare TUTTI i ${clusters.length} cluster del progetto?\n\n` +
      `Le fermate associate verranno scollegate (ma non cancellate).\n` +
      `Operazione NON reversibile.`
    )) return;
    setBulkDeleting(true);
    let ok = 0, ko = 0;
    // Limita il parallelismo a 8 chiamate alla volta
    const POOL = 8;
    const queue = [...clusters];
    async function worker() {
      while (queue.length) {
        const c = queue.shift();
        if (!c) return;
        try { await deletePsCluster(projectId, c.id); ok++; }
        catch { ko++; }
      }
    }
    await Promise.all(Array.from({ length: POOL }, worker));
    setBulkDeleting(false);
    qc.invalidateQueries({ queryKey: ["ps", projectId, "clusters"] });
    qc.invalidateQueries({ queryKey: ["ps", projectId, "stops"] });
    setSelectedId(null);
    if (ko === 0) toast.success(`Eliminati ${ok} cluster`);
    else toast.warning(`Eliminati ${ok} su ${ok + ko} (${ko} errori)`);
  }

  /* ─── Form nuovo cluster ─── */
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newKind, setNewKind] = useState<PsClusterKind>("interchange");
  const [newRadius, setNewRadius] = useState(150);

  /* ─── Stop selection per cluster corrente ─── */
  const [stopFilter, setStopFilter] = useState("");
  const [pendingStopIds, setPendingStopIds] = useState<Set<string>>(new Set());
  // quando cambia cluster selezionato, ricarica pendingStopIds dalle PsStop già caricate
  useEffect(() => {
    if (!selected) { setPendingStopIds(new Set()); return; }
    const ids = new Set<string>();
    for (const s of stops) {
      if (s.clusterId === selected.id) ids.add(s.id);
    }
    setPendingStopIds(ids);
  }, [selected?.id, stops]);

  const filteredStops = useMemo(() => {
    const q = stopFilter.trim().toLowerCase();
    if (!q) return stops;
    return stops.filter(s =>
      s.name.toLowerCase().includes(q) ||
      (s.code ?? "").toLowerCase().includes(q),
    );
  }, [stops, stopFilter]);

  function toggleStop(id: string) {
    setPendingStopIds(prev => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }

  /* ─── Suggest dialog ─── */
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [suggestRadius, setSuggestRadius] = useState(150);
  const [suggestMinSize, setSuggestMinSize] = useState(2);
  const [suggestions, setSuggestions] = useState<PsClusterSuggestion[]>([]);
  const [suggestLoading, setSuggestLoading] = useState(false);
  const [suggestSelected, setSuggestSelected] = useState<Set<number>>(new Set());

  /* ─── Mappa: 3D toggle ─── */
  const mapRef = useRef<MapRef>(null);
  const [is3D, setIs3D] = useState(false);
  const [mapReady, setMapReady] = useState(false);

  /* ─── Visibilità cluster (mostra/nascondi cerchi su mappa) ─── */
  const [hiddenClusterIds, setHiddenClusterIds] = useState<Set<string>>(new Set());
  const allHidden = clusters.length > 0 && hiddenClusterIds.size >= clusters.length;
  function toggleClusterVisibility(id: string) {
    setHiddenClusterIds(prev => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }
  function setAllVisible(visible: boolean) {
    setHiddenClusterIds(visible ? new Set() : new Set(clusters.map(c => c.id)));
  }

  /* ─── Accordion: cluster espansi (lista fermate inline) ─── */
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  function toggleExpanded(id: string) {
    setExpandedIds(prev => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }

  /* ─── Disegno poligono per selezione bulk fermate ─── */
  // L'utente attiva la modalità, clicca sulla mappa per aggiungere vertici,
  // doppio-click per chiudere il poligono. Le fermate dentro l'area
  // vengono aggiunte al pendingStopIds del cluster selezionato.
  const [drawing, setDrawing] = useState(false);
  const [polyVertices, setPolyVertices] = useState<[number, number][]>([]);
  function cancelDrawing() { setDrawing(false); setPolyVertices([]); }
  function pointInPolygon(lon: number, lat: number, poly: [number, number][]): boolean {
    // Ray-casting standard (lon = x, lat = y).
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i][0], yi = poly[i][1];
      const xj = poly[j][0], yj = poly[j][1];
      const intersect = ((yi > lat) !== (yj > lat))
        && (lon < ((xj - xi) * (lat - yi)) / ((yj - yi) || 1e-12) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }
  function applyPolygonSelection(additive: boolean) {
    if (!selected || polyVertices.length < 3) { cancelDrawing(); return; }
    const inside = stops
      .filter(s => pointInPolygon(Number(s.lon), Number(s.lat), polyVertices))
      .map(s => s.id);
    if (inside.length === 0) {
      toast.warning("Nessuna fermata dentro il poligono");
      cancelDrawing();
      return;
    }
    setPendingStopIds(prev => {
      if (additive) {
        const n = new Set(prev);
        for (const id of inside) n.add(id);
        return n;
      }
      // sostituzione completa
      return new Set(inside);
    });
    toast.success(`${inside.length} fermate ${additive ? "aggiunte alla selezione" : "selezionate"}`);
    cancelDrawing();
  }
  useEffect(() => {
    if (!mapReady || !mapRef.current) return;
    const map = mapRef.current.getMap() as any;
    try {
      map.setConfigProperty?.("basemap", "show3dObjects", is3D);
      map.setConfigProperty?.("basemap", "lightPreset", "day");
    } catch { /* style non standard */ }
    map.easeTo({ pitch: is3D ? 60 : 0, bearing: is3D ? -17 : 0, duration: 800 });
  }, [is3D, mapReady]);

  // Auto-fit: quando arrivano le fermate (anche dopo il mount) inquadra tutto.
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
    mapRef.current.fitBounds(bounds, { padding: 60, duration: 800, maxZoom: 14 });
    didAutoFitRef.current = true;
  }, [mapReady, stops]);

  async function runSuggest() {
    setSuggestLoading(true);
    try {
      const r = await suggestPsClusters(projectId, { radius: suggestRadius, minSize: suggestMinSize });
      setSuggestions(r.suggestions);
      setSuggestSelected(new Set(r.suggestions.map((_, i) => i)));
    } catch (e: any) {
      toast.error(e?.message || "Errore suggerimento");
    } finally {
      setSuggestLoading(false);
    }
  }

  async function applySuggestions() {
    const picked = suggestions.filter((_, i) => suggestSelected.has(i));
    let ok = 0, ko = 0;
    for (const s of picked) {
      try {
        const c = await createPsCluster(projectId, {
          name: s.suggestedName,
          kind: "interchange",
          centerLat: s.centerLat,
          centerLon: s.centerLon,
          radiusM: suggestRadius,
        });
        await setPsClusterStops(projectId, c.id, s.stops.map(x => x.id));
        ok++;
      } catch { ko++; }
    }
    qc.invalidateQueries({ queryKey: ["ps", projectId, "clusters"] });
    qc.invalidateQueries({ queryKey: ["ps", projectId, "stops"] });
    toast.success(`Creati ${ok} cluster${ko ? `, ${ko} errori` : ""}`);
    setSuggestOpen(false);
    setSuggestions([]);
  }

  /* ─── Render ─── */
  if (!projectId) {
    return <div className="p-8 text-slate-300">Progetto non specificato.</div>;
  }
  const project = projectQ.data;

  return (
    <div className="h-full w-full min-w-0 flex flex-col bg-slate-950 text-slate-100">
      {/* Toolbar */}
      <div className="h-14 border-b border-slate-800 bg-slate-900 px-4 flex items-center gap-3 shrink-0">
        <Link href={`/planning-studio/${projectId}`}>
          <button className="p-2 rounded hover:bg-slate-800 text-slate-300">
            <ArrowLeft className="w-4 h-4" />
          </button>
        </Link>
        <div className="flex items-center gap-2">
          <Layers className="w-5 h-5 text-cyan-400" />
          <h1 className="font-semibold text-sm">Nodi</h1>
        </div>
        {project && (
          <span className="text-xs text-slate-500 ml-2">
            {project.name} · <span className="text-slate-400">{stops.length} fermate · {clusters.length} cluster</span>
          </span>
        )}
        <div className="flex-1" />
        {clusters.length > 0 && (
          <button
            onClick={deleteAllClusters}
            disabled={bulkDeleting}
            title="Elimina tutti i cluster del progetto (utile dopo un import sbagliato)"
            className="px-3 py-1.5 rounded bg-rose-700/80 hover:bg-rose-600 text-white text-sm flex items-center gap-1.5 disabled:opacity-50"
          >
            {bulkDeleting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
            Elimina tutti ({clusters.length})
          </button>
        )}
        <button
          onClick={() => { setSuggestOpen(true); setSuggestions([]); }}
          className="px-3 py-1.5 rounded bg-violet-600 hover:bg-violet-500 text-white text-sm flex items-center gap-1.5"
        >
          <Sparkles className="w-4 h-4" /> Suggerisci cluster
        </button>
        <button
          onClick={() => setCreating(true)}
          className="px-3 py-1.5 rounded bg-cyan-600 hover:bg-cyan-500 text-white text-sm flex items-center gap-1.5"
        >
          <Plus className="w-4 h-4" /> Nuovo cluster
        </button>
      </div>
      <PsProjectNav projectId={projectId} active="clusters" />
      <div className="flex-1 flex overflow-hidden">
        {/* Sidebar sx */}
        <div className="w-[380px] border-r border-slate-800 bg-slate-900/60 flex flex-col">
          {/* Form creazione */}
          {creating && (
            <div className="p-3 border-b border-slate-800 bg-slate-900 space-y-2">
              <input
                autoFocus value={newName} onChange={e => setNewName(e.target.value)}
                placeholder="Nome cluster"
                className="w-full px-2 py-1.5 rounded bg-slate-800 text-sm text-slate-100 placeholder:text-slate-500 border border-slate-700"
              />
              <div className="flex gap-2">
                <select
                  value={newKind} onChange={e => setNewKind(e.target.value as PsClusterKind)}
                  className="flex-1 px-2 py-1.5 rounded bg-slate-800 text-sm border border-slate-700"
                >
                  {Object.entries(KIND_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
                <input
                  type="number" min={20} max={1000} step={10}
                  value={newRadius} onChange={e => setNewRadius(parseInt(e.target.value) || 150)}
                  className="w-20 px-2 py-1.5 rounded bg-slate-800 text-sm border border-slate-700"
                />
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    if (!newName.trim()) { toast.error("Nome richiesto"); return; }
                    createMut.mutate(
                      { name: newName.trim(), kind: newKind, radiusM: newRadius },
                      { onSuccess: () => { setCreating(false); setNewName(""); setNewKind("interchange"); setNewRadius(150); } }
                    );
                  }}
                  disabled={createMut.isPending}
                  className="flex-1 px-2 py-1.5 rounded bg-cyan-600 hover:bg-cyan-500 text-white text-sm flex items-center justify-center gap-1"
                >
                  {createMut.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                  Crea
                </button>
                <button
                  onClick={() => { setCreating(false); setNewName(""); }}
                  className="px-3 py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-sm"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}

          {/* Lista cluster */}
          <div className="flex-1 overflow-auto">
            {clustersQ.isLoading && (
              <div className="p-4 text-slate-500 text-sm flex items-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin" /> Caricamento…
              </div>
            )}
            {!clustersQ.isLoading && clusters.length === 0 && (
              <div className="p-6 text-center text-slate-500 text-sm">
                Nessun cluster.<br />
                Crea il primo o usa <em>Suggerisci cluster</em>.
              </div>
            )}
            {clusters.length > 0 && (
              <div className="px-2 py-1.5 border-b border-slate-800 bg-slate-900/40 flex items-center justify-between text-[10px] text-slate-500">
                <span>{clusters.length} cluster · {clusters.length - hiddenClusterIds.size} visibili</span>
                <button
                  onClick={() => setAllVisible(allHidden)}
                  className="px-2 py-0.5 rounded text-slate-400 hover:bg-slate-800 hover:text-cyan-300 flex items-center gap-1"
                >
                  {allHidden
                    ? <><Eye className="w-3 h-3" /> Mostra tutti</>
                    : <><EyeOff className="w-3 h-3" /> Nascondi tutti</>
                  }
                </button>
              </div>
            )}
            {clusters.map(c => {
              const isExpanded = expandedIds.has(c.id);
              const isVisible = !hiddenClusterIds.has(c.id);
              const clusterStops = stops.filter(s => s.clusterId === c.id);
              return (
                <div
                  key={c.id}
                  className={`group w-full border-b border-slate-800 transition ${
                    selectedId === c.id ? "bg-slate-800" : ""
                  }`}
                >
                  <div className="flex items-center gap-1 px-2 py-2 hover:bg-slate-800">
                    <button
                      onClick={(e) => { e.stopPropagation(); toggleExpanded(c.id); }}
                      title={isExpanded ? "Comprimi" : "Espandi fermate"}
                      className="p-1 rounded text-slate-500 hover:text-cyan-300 hover:bg-slate-700 shrink-0"
                    >
                      {isExpanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                    </button>
                    <button
                      onClick={() => setSelectedId(c.id)}
                      className="flex-1 min-w-0 flex items-center gap-2 text-left"
                    >
                      <div className="w-2 h-8 rounded shrink-0" style={{ background: KIND_COLOR[c.kind] }} />
                      <div className="flex-1 min-w-0">
                        <div className={`text-sm font-medium truncate ${!isVisible ? "text-slate-500 line-through" : ""}`}>
                          {c.name}
                        </div>
                        <div className="text-xs text-slate-500">
                          {KIND_LABEL[c.kind]} · {c.stopCount ?? 0} fermate · r={c.radiusM}m
                        </div>
                      </div>
                    </button>
                    <div className="flex items-center gap-0.5 shrink-0">
                      <button
                        onClick={(e) => { e.stopPropagation(); toggleClusterVisibility(c.id); }}
                        title={isVisible ? "Nascondi sulla mappa" : "Mostra sulla mappa"}
                        className={`p-1.5 rounded hover:bg-slate-700 ${isVisible ? "text-slate-400 hover:text-cyan-300" : "text-slate-600 hover:text-slate-300"}`}
                      >
                        {isVisible ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); setSelectedId(c.id); }}
                        title="Modifica"
                        className={`p-1.5 rounded text-slate-400 hover:bg-slate-700 hover:text-cyan-300 transition ${
                          selectedId === c.id ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                        }`}
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          if (confirm(`Eliminare "${c.name}"?`)) deleteMut.mutate(c.id);
                        }}
                        title="Elimina"
                        className="p-1.5 rounded text-slate-400 hover:bg-rose-500/20 hover:text-rose-300"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                  {/* Accordion: lista fermate del cluster (read-only).
                      Per modificarle l'utente clicca 'Modifica' / il nome → pannello dettaglio sotto. */}
                  {isExpanded && (
                    <div className="bg-slate-950/60 border-t border-slate-800/50 max-h-48 overflow-auto">
                      {clusterStops.length === 0 && (
                        <div className="px-3 py-2 text-[11px] text-slate-600 italic">
                          Nessuna fermata assegnata
                        </div>
                      )}
                      {clusterStops.map(s => (
                        <div key={s.id} className="flex items-center gap-2 px-4 py-1 text-[11px] text-slate-400 hover:bg-slate-900">
                          <MapPin className="w-3 h-3 text-slate-600 shrink-0" />
                          <span className="flex-1 truncate">{s.name}</span>
                          {s.code && <span className="text-slate-600 font-mono">{s.code}</span>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Pannello dettaglio cluster selezionato */}
          {selected && (
            <div className="border-t border-slate-800 max-h-[55%] flex flex-col bg-slate-900">
              <div className="p-3 border-b border-slate-800 flex items-center gap-2">
                <input
                  value={selected.name}
                  onChange={(e) => updateMut.mutate({ id: selected.id, patch: { name: e.target.value } })}
                  className="flex-1 px-2 py-1 rounded bg-slate-800 text-sm border border-slate-700"
                />
                <button
                  onClick={() => {
                    if (confirm(`Eliminare "${selected.name}"?`)) deleteMut.mutate(selected.id);
                  }}
                  className="p-1.5 rounded text-rose-400 hover:bg-rose-500/10"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>

              {/* Toggle kind */}
              <div className="px-3 py-2 border-b border-slate-800 bg-slate-900/40">
                <div className="text-[11px] text-slate-500 mb-1.5">Tipo cluster</div>
                <div className="flex gap-1.5">
                  {(["interchange", "rest", "none"] as PsClusterKind[]).map(k => (
                    <button
                      key={k}
                      onClick={() => updateMut.mutate({ id: selected.id, patch: { kind: k } })}
                      className={`flex-1 px-2 py-1.5 rounded text-xs font-medium border transition ${
                        selected.kind === k
                          ? "bg-cyan-500/20 border-cyan-500 text-cyan-200"
                          : "bg-slate-800 border-slate-700 text-slate-400 hover:bg-slate-700"
                      }`}
                      title={KIND_DESC[k]}
                    >
                      {KIND_LABEL[k]}
                    </button>
                  ))}
                </div>
                <div className="text-[10px] text-slate-600 mt-1.5 leading-tight">
                  {KIND_DESC[selected.kind]}
                </div>
              </div>

              {/* Sosta inoperosa (extraurbano): mostrato solo per i nodi di sosta */}
              {selected.kind === "rest" && (
                <div className="px-3 py-2 border-b border-slate-800 bg-amber-500/5 space-y-1.5">
                  <div className="text-[11px] text-amber-500/80">Sosta inoperosa (extraurbano)</div>
                  <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                    <input
                      type="checkbox"
                      className="accent-amber-500"
                      checked={!!(selected.attributes as any)?.hasFacilities}
                      onChange={(e) => updateMut.mutate({ id: selected.id, patch: { attributes: { ...(selected.attributes ?? {}), hasFacilities: e.target.checked } } })}
                    />
                    Con servizi igienici / strutture
                  </label>
                  <div className="text-[10px] text-slate-600 leading-tight">
                    La sosta conta al {(selected.attributes as any)?.hasFacilities ? "12%" : "25%"} dell'orario (strutture adeguate = 12%). I depositi sono già luoghi idonei.
                  </div>
                </div>
              )}

              {/* Search + counter */}
              <div className="p-2 border-b border-slate-800 space-y-2">
                <div className="relative">
                  <Search className="w-3.5 h-3.5 absolute left-2 top-2 text-slate-500" />
                  <input
                    value={stopFilter} onChange={e => setStopFilter(e.target.value)}
                    placeholder="Cerca fermata…"
                    className="w-full pl-7 pr-2 py-1.5 rounded bg-slate-800 text-xs border border-slate-700"
                  />
                </div>
                <div className="text-xs text-slate-500 flex items-center justify-between">
                  <span>{pendingStopIds.size} fermate selezionate</span>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => { setDrawing(true); setPolyVertices([]); }}
                      title="Disegna un poligono sulla mappa per selezionare le fermate al suo interno"
                      className={`px-2 py-0.5 rounded text-xs flex items-center gap-1 transition ${
                        drawing
                          ? "bg-violet-500/20 text-violet-200 border border-violet-500/40"
                          : "text-slate-400 hover:bg-slate-800 hover:text-violet-300"
                      }`}
                    >
                      <PencilRuler className="w-3 h-3" />
                      {drawing ? "Disegnando…" : "Disegna"}
                    </button>
                    <button
                      onClick={() => setStopsMut.mutate({ id: selected.id, stopIds: Array.from(pendingStopIds) })}
                      disabled={setStopsMut.isPending}
                      className="px-2 py-0.5 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-xs flex items-center gap-1"
                    >
                      {setStopsMut.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
                      Salva
                    </button>
                  </div>
                </div>
              </div>

              {/* Lista fermate selezionabili */}
              <div className="flex-1 overflow-auto">
                {filteredStops.map(s => (
                  <label
                    key={s.id}
                    className={`flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-slate-800 cursor-pointer ${
                      pendingStopIds.has(s.id) ? "bg-cyan-500/10" : ""
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={pendingStopIds.has(s.id)}
                      onChange={() => toggleStop(s.id)}
                      className="accent-cyan-500"
                    />
                    <MapPin className="w-3 h-3 text-slate-500" />
                    <span className="flex-1 truncate">{s.name}</span>
                    {s.code && <span className="text-slate-600">{s.code}</span>}
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Mappa */}
        <div className="flex-1 relative">
          {!MAPBOX_TOKEN ? (
            <div className="h-full flex items-center justify-center text-slate-500">
              VITE_MAPBOX_TOKEN non configurato.
            </div>
          ) : (
            <Map
              ref={mapRef}
              mapboxAccessToken={MAPBOX_TOKEN}
              initialViewState={initialView}
              mapStyle="mapbox://styles/mapbox/standard"
              onLoad={() => setMapReady(true)}
              cursor={drawing ? "crosshair" : undefined}
              onClick={(e) => {
                if (!drawing) return;
                const lng = e.lngLat.lng, lat = e.lngLat.lat;
                setPolyVertices(prev => [...prev, [lng, lat]]);
              }}
              onDblClick={(e) => {
                if (!drawing) return;
                e.preventDefault();
                // additive di default; con shift premuto sostituisce
                const additive = !(e.originalEvent as MouseEvent).shiftKey;
                applyPolygonSelection(additive);
              }}
              style={{ width: "100%", height: "100%" }}
            >
              <NavigationControl position="top-right" />

              {/* Toggle 2D / 3D */}
              <div className="absolute top-3 left-3 z-10 flex rounded-lg overflow-hidden border border-slate-300 shadow-lg bg-white/95 backdrop-blur">
                <button
                  onClick={() => setIs3D(false)}
                  className={`px-3 py-1.5 text-xs font-semibold transition-colors ${
                    !is3D ? "bg-purple-500 text-white" : "text-slate-700 hover:bg-slate-100"
                  }`}
                >2D</button>
                <button
                  onClick={() => setIs3D(true)}
                  className={`px-3 py-1.5 text-xs font-semibold transition-colors ${
                    is3D ? "bg-purple-500 text-white" : "text-slate-700 hover:bg-slate-100"
                  }`}
                >3D</button>
              </div>

              {/* Cluster: cerchi + label */}
              <Source
                id="ps-clusters"
                type="geojson"
                data={{
                  type: "FeatureCollection",
                  features: clusters
                    .filter(c => c.centerLat != null && c.centerLon != null)
                    .filter(c => !hiddenClusterIds.has(c.id))
                    .map(c => ({
                      type: "Feature",
                      properties: {
                        id: c.id,
                        name: c.name,
                        color: KIND_COLOR[c.kind],
                        radius: c.radiusM,
                        selected: c.id === selectedId,
                      },
                      geometry: { type: "Point", coordinates: [Number(c.centerLon), Number(c.centerLat)] },
                    })),
                }}
              >
                {/* alone esterno (raggio reale convertito in pixel) */}
                <Layer
                  id="ps-clusters-circle"
                  type="circle"
                  paint={{
                    "circle-radius": ["interpolate", ["exponential", 2], ["zoom"],
                      10, ["/", ["get", "radius"], 20],
                      16, ["/", ["get", "radius"], 1],
                    ],
                    "circle-color": ["get", "color"],
                    "circle-opacity": ["case", ["get", "selected"], 0.35, 0.18],
                    "circle-stroke-width": ["case", ["get", "selected"], 2, 1],
                    "circle-stroke-color": ["get", "color"],
                  }}
                />
                <Layer
                  id="ps-clusters-label"
                  type="symbol"
                  layout={{
                    "text-field": ["get", "name"],
                    "text-size": 11,
                    "text-offset": [0, -1.2],
                    "text-anchor": "bottom",
                  }}
                  paint={{
                    "text-color": "#fff",
                    "text-halo-color": "#0f172a",
                    "text-halo-width": 1.5,
                  }}
                />
              </Source>

              {/* Marker fermate (piccoli pin) */}
              {stops.map(s => (
                <Marker
                  key={s.id}
                  longitude={Number(s.lon)}
                  latitude={Number(s.lat)}
                  anchor="center"
                >
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      if (selected) toggleStop(s.id);
                    }}
                    className={`w-2.5 h-2.5 rounded-full border ${
                      pendingStopIds.has(s.id)
                        ? "bg-cyan-400 border-cyan-200 scale-150"
                        : "bg-slate-300 border-slate-600 hover:scale-125"
                    } transition`}
                    title={s.name}
                  />
                </Marker>
              ))}

              {/* Drawing layer: poligono in costruzione */}
              {drawing && polyVertices.length > 0 && (
                <Source
                  id="ps-draw-poly"
                  type="geojson"
                  data={{
                    type: "FeatureCollection",
                    features: [
                      // poligono chiuso (anche se non ancora committato), così l'utente vede l'area
                      ...(polyVertices.length >= 3 ? [{
                        type: "Feature" as const,
                        properties: {},
                        geometry: {
                          type: "Polygon" as const,
                          coordinates: [[...polyVertices, polyVertices[0]]],
                        },
                      }] : []),
                      // linea tra i vertici
                      {
                        type: "Feature" as const,
                        properties: {},
                        geometry: {
                          type: "LineString" as const,
                          coordinates: polyVertices,
                        },
                      },
                      // vertici
                      ...polyVertices.map((v, i) => ({
                        type: "Feature" as const,
                        properties: { idx: i },
                        geometry: { type: "Point" as const, coordinates: v },
                      })),
                    ],
                  }}
                >
                  <Layer
                    id="ps-draw-poly-fill"
                    type="fill"
                    filter={["==", ["geometry-type"], "Polygon"]}
                    paint={{ "fill-color": "#a855f7", "fill-opacity": 0.18 }}
                  />
                  <Layer
                    id="ps-draw-poly-line"
                    type="line"
                    filter={["==", ["geometry-type"], "LineString"]}
                    paint={{ "line-color": "#a855f7", "line-width": 2, "line-dasharray": [2, 1] }}
                  />
                  <Layer
                    id="ps-draw-poly-vertices"
                    type="circle"
                    filter={["==", ["geometry-type"], "Point"]}
                    paint={{
                      "circle-radius": 5,
                      "circle-color": "#fff",
                      "circle-stroke-color": "#a855f7",
                      "circle-stroke-width": 2,
                    }}
                  />
                </Source>
              )}

              {/* Banner istruzioni drawing */}
              {drawing && (
                <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10 px-4 py-2.5 rounded-lg bg-violet-900/90 border border-violet-500/60 backdrop-blur shadow-xl text-xs text-violet-100 flex items-center gap-3">
                  <PencilRuler className="w-4 h-4 text-violet-300 shrink-0" />
                  <div>
                    <div className="font-semibold">
                      {polyVertices.length === 0 && "Clicca sulla mappa per iniziare il poligono"}
                      {polyVertices.length === 1 && "Aggiungi almeno altri 2 vertici"}
                      {polyVertices.length === 2 && "Aggiungi un terzo vertice o un altro per chiudere"}
                      {polyVertices.length >= 3 && `${polyVertices.length} vertici · doppio-click per applicare`}
                    </div>
                    <div className="text-[10px] text-violet-300/80">
                      Doppio-click = aggiungi alla selezione · Shift+doppio-click = sostituisci
                    </div>
                  </div>
                  <button
                    onClick={() => cancelDrawing()}
                    className="ml-2 px-2 py-1 rounded bg-violet-800 hover:bg-violet-700 text-[11px]"
                  >
                    Annulla
                  </button>
                </div>
              )}
            </Map>
          )}
        </div>
      </div>

      {/* Suggest dialog */}
      {suggestOpen && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-6">
          <div className="bg-slate-900 border border-slate-700 rounded-lg w-full max-w-3xl max-h-[85vh] flex flex-col">
            <div className="p-4 border-b border-slate-700 flex items-center gap-2">
              <Sparkles className="w-5 h-5 text-violet-400" />
              <h3 className="font-semibold">Suggerisci cluster automaticamente</h3>
              <div className="flex-1" />
              <button onClick={() => setSuggestOpen(false)} className="p-1 rounded hover:bg-slate-800">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-4 border-b border-slate-700 flex items-end gap-3">
              <div>
                <label className="block text-xs text-slate-400 mb-1">Raggio (m)</label>
                <input
                  type="number" min={20} max={1000} step={10}
                  value={suggestRadius} onChange={e => setSuggestRadius(parseInt(e.target.value) || 150)}
                  className="w-24 px-2 py-1.5 rounded bg-slate-800 text-sm border border-slate-700"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1">Min fermate</label>
                <input
                  type="number" min={2} max={20}
                  value={suggestMinSize} onChange={e => setSuggestMinSize(parseInt(e.target.value) || 2)}
                  className="w-24 px-2 py-1.5 rounded bg-slate-800 text-sm border border-slate-700"
                />
              </div>
              <button
                onClick={runSuggest}
                disabled={suggestLoading}
                className="px-3 py-1.5 rounded bg-violet-600 hover:bg-violet-500 text-white text-sm flex items-center gap-1.5"
              >
                {suggestLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                Calcola
              </button>
              <div className="flex-1 text-xs text-slate-500 text-right">
                {suggestions.length > 0 && `${suggestions.length} gruppi trovati`}
              </div>
            </div>
            <div className="flex-1 overflow-auto p-2">
              {suggestions.length === 0 && !suggestLoading && (
                <div className="p-6 text-center text-slate-500 text-sm">
                  Nessun risultato. Premi "Calcola" per generare suggerimenti.
                </div>
              )}
              {suggestions.map((s, i) => (
                <label
                  key={i}
                  className={`flex items-start gap-3 p-3 rounded mb-1 cursor-pointer hover:bg-slate-800 ${
                    suggestSelected.has(i) ? "bg-violet-500/10 border border-violet-500/40" : "border border-transparent"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={suggestSelected.has(i)}
                    onChange={() => {
                      setSuggestSelected(prev => {
                        const n = new Set(prev);
                        if (n.has(i)) n.delete(i); else n.add(i);
                        return n;
                      });
                    }}
                    className="mt-1 accent-violet-500"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium">{s.suggestedName}</div>
                    <div className="text-xs text-slate-500 mb-1">{s.stops.length} fermate</div>
                    <div className="text-xs text-slate-400 truncate">
                      {s.stops.map(x => x.name).join(" · ")}
                    </div>
                  </div>
                </label>
              ))}
            </div>
            <div className="p-4 border-t border-slate-700 flex items-center justify-end gap-2">
              <button
                onClick={() => setSuggestOpen(false)}
                className="px-3 py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-sm"
              >Annulla</button>
              <button
                onClick={applySuggestions}
                disabled={suggestSelected.size === 0}
                className="px-3 py-1.5 rounded bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white text-sm flex items-center gap-1.5"
              >
                <Check className="w-4 h-4" /> Crea {suggestSelected.size} cluster
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
