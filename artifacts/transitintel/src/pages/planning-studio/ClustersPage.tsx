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
import { useMemo, useState, useEffect } from "react";
import { useLocation, useParams, Link } from "wouter";
import Map, { Marker, Source, Layer, NavigationControl, type MapRef } from "react-map-gl/mapbox";
import "mapbox-gl/dist/mapbox-gl.css";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ArrowLeft, Plus, Trash2, Save, X, Sparkles, Search, Layers,
  Loader2, Check, MapPin, Pencil,
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
  none: "Nodo logico",
};
const KIND_COLOR: Record<PsClusterKind, string> = {
  interchange: "#0ea5e9",
  none: "#64748b",
};
const KIND_DESC: Record<PsClusterKind, string> = {
  interchange: "Usato da Scheduling Engine come change point (cambio vettura nei turni macchina)",
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
      toast.success("Cluster creato");
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
      toast.success("Cluster eliminato");
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
    <div className="h-screen w-screen flex flex-col bg-slate-950 text-slate-100">
      {/* Toolbar */}
      <div className="h-14 border-b border-slate-800 bg-slate-900 px-4 flex items-center gap-3 shrink-0">
        <Link href={`/planning-studio/${projectId}`}>
          <button className="p-2 rounded hover:bg-slate-800 text-slate-300">
            <ArrowLeft className="w-4 h-4" />
          </button>
        </Link>
        <div className="flex items-center gap-2">
          <Layers className="w-5 h-5 text-cyan-400" />
          <h1 className="font-semibold text-sm">Cluster fermate</h1>
        </div>
        {project && (
          <span className="text-xs text-slate-500 ml-2">
            {project.name} · <span className="text-slate-400">{stops.length} fermate · {clusters.length} cluster</span>
          </span>
        )}
        <div className="flex-1" />
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

      {/* Body */}
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
            {clusters.map(c => (
              <button
                key={c.id}
                onClick={() => setSelectedId(c.id)}
                className={`w-full text-left px-3 py-2 border-b border-slate-800 hover:bg-slate-800 transition flex items-center gap-2 ${
                  selectedId === c.id ? "bg-slate-800" : ""
                }`}
              >
                <div className="w-2 h-8 rounded" style={{ background: KIND_COLOR[c.kind] }} />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">{c.name}</div>
                  <div className="text-xs text-slate-500">
                    {KIND_LABEL[c.kind]} · {c.stopCount ?? 0} fermate · r={c.radiusM}m
                  </div>
                </div>
              </button>
            ))}
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
                  {(["interchange", "none"] as PsClusterKind[]).map(k => (
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
              mapboxAccessToken={MAPBOX_TOKEN}
              initialViewState={initialView}
              mapStyle="mapbox://styles/mapbox/dark-v11"
              style={{ width: "100%", height: "100%" }}
            >
              <NavigationControl position="top-right" />

              {/* Cluster: cerchi + label */}
              <Source
                id="ps-clusters"
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
