/* ═══════════════════════════════════════════════════════════════
 *  ARCHI FUORILINEA — archivio modificabile dei percorsi a vuoto
 *
 *  Genera gli archi deposito↔capolinea (e capolinea↔capolinea) con il
 *  percorso reale su strada, li mostra su mappa, e permette di:
 *  - modificare il PERCORSO (clicca sulla mappa per aggiungere punti di
 *    passaggio → ricalcolo OSRM)
 *  - dare TEMPI/KM personalizzati (override sul calcolato)
 *
 *  NB: per ora lo scheduling usa ancora il calcolo attuale in fase di
 *  ottimizzazione — questa sezione è l'archivio, non l'override attivo.
 * ═══════════════════════════════════════════════════════════════ */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Map, { Marker, Source, Layer, NavigationControl, type MapRef, type MapMouseEvent } from "react-map-gl/mapbox";
import "mapbox-gl/dist/mapbox-gl.css";
import { motion } from "framer-motion";
import {
  Route as RouteIcon, Loader2, Wand2, Trash2, Building2, MapPin, X,
  Pencil, RotateCcw, Save, AlertTriangle, Search,
} from "lucide-react";
import { toast } from "sonner";
import { getApiBase } from "@/lib/api";

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN || "";

interface ArcNode { key: string; type: string; name: string; lat: number; lon: number }
interface Arc {
  id: string;
  from: ArcNode;
  to: ArcNode;
  geometry: any;             // GeoJSON LineString
  roadKm: number | null;
  travelMin: number | null;
  customMin: number | null;
  customKm: number | null;
  viaPoints: [number, number][] | null;
  source: string;            // osrm | manual | stima
  note: string | null;
}

export default function DeadheadArcsPage() {
  const base = getApiBase();
  const mapRef = useRef<MapRef>(null);

  const [arcs, setArcs] = useState<Arc[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  /* generazione */
  const [genOpen, setGenOpen] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [depotsList, setDepotsList] = useState<{ id: string; name: string }[]>([]);
  const [genDepotIds, setGenDepotIds] = useState<Set<string>>(new Set());
  const [routesList, setRoutesList] = useState<{ routeId: string; shortName: string }[]>([]);
  const [genRouteIds, setGenRouteIds] = useState<Set<string>>(new Set());
  const [genTTKm, setGenTTKm] = useState<number>(0);
  /* Rete su cui generare: SELETTORE ESPLICITO del feed (in Planner Studio il
   * "feed più recente" del tenant può essere un'altra rete → generazione vuota). */
  const [feedsList, setFeedsList] = useState<{ id: string; label: string }[]>([]);
  const [genFeedId, setGenFeedId] = useState<string>("");
  /* Filtro per comune (zonizzazione): tiene gli archi con ALMENO un nodo dentro */
  const [zonesList, setZonesList] = useState<{ id: string; name: string; geometry: any }[]>([]);
  const [comuneId, setComuneId] = useState<string>("");
  /* Scope per progetto Planner Studio: "" = vista globale (tutti gli archi);
   * un id = globali + archi di QUEL progetto; generazione/cancellazione
   * lavorano nello scope scelto. */
  const [psList, setPsList] = useState<{ id: string; name: string }[]>([]);
  const [psScope, setPsScope] = useState<string>("");

  /* editor arco selezionato */
  const [editMin, setEditMin] = useState<string>("");
  const [editKm, setEditKm] = useState<string>("");
  const [editNote, setEditNote] = useState<string>("");
  const [editingPath, setEditingPath] = useState(false);
  const [viaDraft, setViaDraft] = useState<[number, number][]>([]);
  const [rerouting, setRerouting] = useState(false);

  const selected = useMemo(() => arcs.find(a => a.id === selectedId) ?? null, [arcs, selectedId]);

  const refresh = useCallback(() => {
    setLoading(true);
    fetch(`${base}/api/deadhead-arcs${psScope ? `?psProjectId=${psScope}` : ""}`)
      .then(r => (r.ok ? r.json() : Promise.reject()))
      .then(d => setArcs(d.arcs ?? []))
      .catch(() => toast.error("Impossibile caricare gli archi"))
      .finally(() => setLoading(false));
  }, [base, psScope]);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    fetch(`${base}/api/depots`).then(r => r.json()).then((d: any) => {
      const list = Array.isArray(d) ? d : d?.data ?? [];
      setDepotsList(list.map((x: any) => ({ id: x.id, name: x.name })));
    }).catch(() => { /* opzionale */ });
    fetch(`${base}/api/gtfs/feeds`).then(r => r.json()).then((d: any) => {
      const list = (Array.isArray(d) ? d : d?.data ?? []).map((f: any) => ({
        id: f.id, label: f.agencyName || f.filename || f.id,
      }));
      setFeedsList(list);
      if (list.length > 0) setGenFeedId((cur: string) => cur || list[0].id);
    }).catch(() => { /* opzionale */ });
    fetch(`${base}/api/zones`).then(r => (r.ok ? r.json() : null)).then((d: any) => {
      if (d?.zones) setZonesList(d.zones.filter((z: any) => z.geometry));
    }).catch(() => { /* zonizzazione non importata: filtro nascosto */ });
    fetch(`${base}/api/planning-studio/projects`).then(r => (r.ok ? r.json() : null)).then((d: any) => {
      const list = (Array.isArray(d) ? d : d?.data ?? d?.projects ?? []).map((x: any) => ({ id: x.id, name: x.name ?? x.id }));
      setPsList(list);
    }).catch(() => { /* Planner Studio assente: selettore nascosto */ });
  }, [base]);

  /* linee del feed scelto (per il filtro linee della generazione) */
  useEffect(() => {
    if (!genFeedId) return;
    fetch(`${base}/api/service-program/routes?feedId=${encodeURIComponent(genFeedId)}`)
      .then(r => r.json())
      .then((d: any) => {
        const list = d?.routes ?? [];
        setRoutesList(list.map((x: any) => ({ routeId: x.routeId, shortName: x.name ?? x.routeId })));
        setGenRouteIds(new Set());
      })
      .catch(() => setRoutesList([]));
  }, [base, genFeedId]);

  /* sync editor con l'arco selezionato */
  useEffect(() => {
    setEditMin(selected?.customMin != null ? String(selected.customMin) : "");
    setEditKm(selected?.customKm != null ? String(selected.customKm) : "");
    setEditNote(selected?.note ?? "");
    setEditingPath(false);
    setViaDraft((selected?.viaPoints as [number, number][]) ?? []);
  }, [selectedId]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectArc = useCallback((a: Arc) => {
    setSelectedId(a.id);
    const coords: [number, number][] = (a.geometry?.coordinates ?? []) as [number, number][];
    if (coords.length && mapRef.current) {
      let minLon = coords[0][0], maxLon = coords[0][0], minLat = coords[0][1], maxLat = coords[0][1];
      for (const [lon, lat] of coords) {
        minLon = Math.min(minLon, lon); maxLon = Math.max(maxLon, lon);
        minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat);
      }
      mapRef.current.fitBounds([[minLon, minLat], [maxLon, maxLat]], { padding: 80, duration: 600 });
    }
  }, []);

  const generate = useCallback(() => {
    setGenerating(true);
    fetch(`${base}/api/deadhead-arcs/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        feedId: genFeedId || undefined,
        depotIds: [...genDepotIds],
        routeIds: [...genRouteIds],
        terminalPairsMaxKm: genTTKm || 0,
        psProjectId: psScope || undefined,
      }),
    })
      .then(r => r.json())
      .then(d => {
        if (d.error) { toast.error(d.error); return; }
        toast.success(`${d.created} archi generati`, {
          description: `${d.depots} depositi × ${d.terminals} capolinea` +
            (d.estimated ? ` · ${d.estimated} stimati (OSRM non raggiungibile)` : "") +
            (d.truncated ? " · troncato al limite per run: rilancia per continuare" : ""),
        });
        setGenOpen(false);
        refresh();
      })
      .catch(() => toast.error("Errore nella generazione"))
      .finally(() => setGenerating(false));
  }, [base, genDepotIds, genRouteIds, genTTKm, psScope, refresh]);

  const saveCustom = useCallback(() => {
    if (!selected) return;
    fetch(`${base}/api/deadhead-arcs/${selected.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        customMin: editMin === "" ? null : Number(editMin),
        customKm: editKm === "" ? null : Number(editKm),
        note: editNote || null,
      }),
    })
      .then(r => (r.ok ? r.json() : Promise.reject()))
      .then((upd: Arc) => {
        setArcs(cur => cur.map(a => (a.id === upd.id ? upd : a)));
        toast.success("Arco aggiornato", { description: upd.customMin != null ? `tempo personalizzato ${upd.customMin} min` : "override rimosso" });
      })
      .catch(() => toast.error("Errore nel salvataggio"));
  }, [base, selected, editMin, editKm, editNote]);

  const reroute = useCallback((via: [number, number][]) => {
    if (!selected) return;
    setRerouting(true);
    fetch(`${base}/api/deadhead-arcs/${selected.id}/reroute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ viaPoints: via }),
    })
      .then(r => (r.ok ? r.json() : Promise.reject()))
      .then((upd: Arc) => {
        setArcs(cur => cur.map(a => (a.id === upd.id ? upd : a)));
        setViaDraft((upd.viaPoints as [number, number][]) ?? []);
        setEditingPath(false);
        toast.success(via.length ? "Percorso ricalcolato con i punti di passaggio" : "Percorso riportato al diretto",
          { description: `${upd.roadKm} km · ${upd.travelMin} min` });
      })
      .catch(() => toast.error("Errore nel ricalcolo del percorso"))
      .finally(() => setRerouting(false));
  }, [base, selected]);

  const deleteArc = useCallback((id: string) => {
    fetch(`${base}/api/deadhead-arcs/${id}`, { method: "DELETE" })
      .then(() => { setArcs(cur => cur.filter(a => a.id !== id)); if (selectedId === id) setSelectedId(null); })
      .catch(() => toast.error("Errore nell'eliminazione"));
  }, [base, selectedId]);

  /* click mappa in modalità modifica percorso → aggiungi via point */
  const onMapClick = useCallback((e: MapMouseEvent) => {
    if (!editingPath) return;
    setViaDraft(cur => (cur.length >= 8 ? cur : [...cur, [e.lngLat.lat, e.lngLat.lng]]));
  }, [editingPath]);

  /* geojson: tutti gli archi (grigi) + selezionato (evidenziato) */
  /* Point-in-polygon (ray casting) su Polygon/MultiPolygon GeoJSON */
  const pip = useCallback((lat: number, lon: number, geom: any): boolean => {
    if (!geom) return false;
    const inRing = (ring: [number, number][]) => {
      let inside = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i], [xj, yj] = ring[j];
        if (((yi > lat) !== (yj > lat)) && (lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi)) inside = !inside;
      }
      return inside;
    };
    const inPoly = (poly: [number, number][][]) => {
      if (!poly.length || !inRing(poly[0])) return false;
      for (let h = 1; h < poly.length; h++) if (inRing(poly[h])) return false; // buchi
      return true;
    };
    if (geom.type === "Polygon") return inPoly(geom.coordinates);
    if (geom.type === "MultiPolygon") return geom.coordinates.some((p: [number, number][][]) => inPoly(p));
    return false;
  }, []);

  /* Archi visibili: filtro testo + filtro COMUNE (almeno un nodo dentro) */
  const comuneGeom = useMemo(
    () => zonesList.find(z => z.id === comuneId)?.geometry ?? null,
    [zonesList, comuneId],
  );
  const filtered = useMemo(() => {
    let list = arcs;
    if (comuneGeom) {
      list = list.filter(a => pip(a.from.lat, a.from.lon, comuneGeom) || pip(a.to.lat, a.to.lon, comuneGeom));
    }
    const q = filter.trim().toLowerCase();
    if (!q) return list;
    return list.filter(a => `${a.from.name} ${a.to.name}`.toLowerCase().includes(q));
  }, [arcs, filter, comuneGeom, pip]);

  const allGeojson = useMemo(() => ({
    type: "FeatureCollection" as const,
    features: (comuneGeom
      ? arcs.filter(a => pip(a.from.lat, a.from.lon, comuneGeom) || pip(a.to.lat, a.to.lon, comuneGeom))
      : arcs
    ).filter(a => a.geometry && a.id !== selectedId).map(a => ({
      type: "Feature" as const, properties: { id: a.id }, geometry: a.geometry,
    })),
  }), [arcs, selectedId, comuneGeom, pip]);
  const selGeojson = useMemo(() => (selected?.geometry ? {
    type: "FeatureCollection" as const,
    features: [{ type: "Feature" as const, properties: {}, geometry: selected.geometry }],
  } : null), [selected]);

  /* nodi unici per i marker */
  const nodes = useMemo(() => {
    const src = comuneGeom
      ? arcs.filter(a => pip(a.from.lat, a.from.lon, comuneGeom) || pip(a.to.lat, a.to.lon, comuneGeom))
      : arcs;
    const m = new globalThis.Map<string, ArcNode>();
    for (const a of src) { m.set(a.from.key, a.from); m.set(a.to.key, a.to); }
    return [...m.values()];
  }, [arcs, comuneGeom, pip]);



  const fmt = (v: number | null) => (v == null ? "—" : v.toLocaleString("it-IT"));

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* ── Header ── */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-amber-500/15 shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center">
            <RouteIcon className="w-4 h-4 text-amber-400" />
          </div>
          <div>
            <h2 className="text-sm font-bold text-foreground">Archi Fuorilinea</h2>
            <p className="text-[10px] text-muted-foreground">
              Percorsi a vuoto deposito↔capolinea su strada reale — modificabili in percorso e tempi
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setGenOpen(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-amber-500 text-black hover:bg-amber-400 transition-all">
            <Wand2 className="w-3.5 h-3.5" /> Genera archi
          </button>
        </div>
      </div>

      {/* Nota scope: lo scheduling usa ancora il calcolo attuale */}
      <div className="px-5 py-1.5 bg-blue-500/5 border-b border-blue-500/15 shrink-0">
        <p className="text-[10px] text-blue-300/80 flex items-center gap-1.5">
          <AlertTriangle className="w-3 h-3 shrink-0" />
          Per ora l'ottimizzazione (VSP/VCSP) continua a usare il calcolo fuorilinea attuale: questa sezione è
          l'archivio consultabile e modificabile degli archi — l'aggancio allo scheduling arriverà come passo successivo.
        </p>
      </div>

      {/* ── Body: mappa + pannello ── */}
      <div className="flex-1 flex overflow-hidden">
        <div className="flex-1 relative">
          {MAPBOX_TOKEN ? (
            <Map
              ref={mapRef}
              mapboxAccessToken={MAPBOX_TOKEN}
              initialViewState={{ longitude: 13.51, latitude: 43.6, zoom: 10 }}
              style={{ width: "100%", height: "100%" }}
              mapStyle="mapbox://styles/mapbox/dark-v11"
              onClick={onMapClick}
              cursor={editingPath ? "crosshair" : "grab"}
            >
              <NavigationControl position="top-right" />
              {/* tutti gli archi */}
              <Source id="arcs-all" type="geojson" data={allGeojson as any}>
                <Layer id="arcs-all-line" type="line"
                  paint={{ "line-color": "#94a3b8", "line-width": 1.5, "line-opacity": 0.35, "line-dasharray": [2, 2] }} />
              </Source>
              {/* arco selezionato */}
              {selGeojson && (
                <Source id="arc-sel" type="geojson" data={selGeojson as any}>
                  <Layer id="arc-sel-casing" type="line"
                    paint={{ "line-color": "#f59e0b", "line-width": 6, "line-opacity": 0.25 }} />
                  <Layer id="arc-sel-line" type="line"
                    paint={{ "line-color": "#f59e0b", "line-width": 2.5, "line-opacity": 0.95 }} />
                </Source>
              )}
              {/* nodi */}
              {nodes.map(n => (
                <Marker key={n.key} longitude={n.lon} latitude={n.lat} anchor="center">
                  <div title={`${n.type === "depot" ? "Deposito" : "Capolinea"}: ${n.name}`}
                    className={`rounded-full border flex items-center justify-center ${
                      n.type === "depot" ? "w-6 h-6 bg-orange-500/90 border-white" : "w-3.5 h-3.5 bg-sky-400/80 border-sky-100/60"}`}>
                    {n.type === "depot" && <Building2 className="w-3 h-3 text-white" />}
                  </div>
                </Marker>
              ))}
              {/* via points dell'arco in modifica */}
              {selected && viaDraft.map(([lat, lon], i) => (
                <Marker key={`via_${i}`} longitude={lon} latitude={lat} anchor="center">
                  <button title="Rimuovi punto di passaggio"
                    onClick={e => { e.stopPropagation(); setViaDraft(cur => cur.filter((_, xi) => xi !== i)); }}
                    className="w-5 h-5 rounded-full bg-fuchsia-500 border-2 border-white text-white text-[9px] font-bold flex items-center justify-center">
                    {i + 1}
                  </button>
                </Marker>
              ))}
            </Map>
          ) : (
            <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground bg-muted/10">
              <MapPin className="w-8 h-8 opacity-30" />
              <p className="text-xs">Token Mapbox non configurato</p>
            </div>
          )}
          {editingPath && (
            <div className="absolute top-3 left-1/2 -translate-x-1/2 bg-fuchsia-500/90 text-white text-[11px] font-semibold px-3 py-1.5 rounded-full shadow-lg">
              ✏️ Modifica percorso: clicca sulla mappa per aggiungere punti di passaggio ({viaDraft.length}/8)
            </div>
          )}
        </div>

        {/* ── Pannello laterale ── */}
        <div className="w-96 shrink-0 border-l border-border/30 flex flex-col overflow-hidden bg-background/50">
          {/* editor arco selezionato */}
          {selected && (
            <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }}
              className="p-3 border-b border-amber-500/20 bg-amber-500/5 space-y-2 shrink-0">
              <div className="flex items-center gap-2">
                <p className="text-xs font-bold text-amber-300 flex-1 truncate">
                  {selected.from.name} → {selected.to.name}
                </p>
                <button onClick={() => setSelectedId(null)} className="text-muted-foreground hover:text-foreground"><X className="w-3.5 h-3.5" /></button>
              </div>
              <p className="text-[10px] text-muted-foreground">
                Percorso {selected.source === "manual" ? "personalizzato" : selected.source === "stima" ? "stimato (linea d'aria)" : "su strada (OSRM)"} ·
                {" "}{fmt(selected.roadKm)} km · {fmt(selected.travelMin)} min calcolati
                {selected.viaPoints?.length ? ` · ${selected.viaPoints.length} punti di passaggio` : ""}
              </p>

              {/* tempi personalizzati */}
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-[10px] text-muted-foreground">Override:</span>
                <input type="number" min={0} step={0.5} placeholder="min" value={editMin}
                  onChange={e => setEditMin(e.target.value)}
                  className="w-16 bg-background/60 border border-border/40 rounded px-1.5 py-1 text-[11px]" />
                <span className="text-[10px] text-muted-foreground">min ·</span>
                <input type="number" min={0} step={0.1} placeholder="km" value={editKm}
                  onChange={e => setEditKm(e.target.value)}
                  className="w-16 bg-background/60 border border-border/40 rounded px-1.5 py-1 text-[11px]" />
                <span className="text-[10px] text-muted-foreground">km</span>
                <button onClick={saveCustom}
                  className="ml-auto flex items-center gap-1 text-[10px] font-semibold px-2 py-1 rounded bg-amber-500 text-black hover:bg-amber-400">
                  <Save className="w-3 h-3" /> Salva
                </button>
              </div>
              <input value={editNote} placeholder="Nota (es. divieto di transito su via X)"
                onChange={e => setEditNote(e.target.value)}
                className="w-full bg-background/60 border border-border/40 rounded px-1.5 py-1 text-[10px]" />

              {/* modifica percorso */}
              <div className="flex items-center gap-1.5 flex-wrap pt-1 border-t border-amber-500/15">
                {!editingPath ? (
                  <button onClick={() => setEditingPath(true)}
                    className="flex items-center gap-1 text-[10px] font-semibold px-2 py-1 rounded bg-fuchsia-500/15 text-fuchsia-300 border border-fuchsia-500/30 hover:bg-fuchsia-500/25">
                    <Pencil className="w-3 h-3" /> Modifica percorso
                  </button>
                ) : (
                  <>
                    <button onClick={() => reroute(viaDraft)} disabled={rerouting}
                      className="flex items-center gap-1 text-[10px] font-semibold px-2 py-1 rounded bg-fuchsia-500 text-white hover:bg-fuchsia-400 disabled:opacity-50">
                      {rerouting ? <Loader2 className="w-3 h-3 animate-spin" /> : <RouteIcon className="w-3 h-3" />} Ricalcola con {viaDraft.length} punti
                    </button>
                    <button onClick={() => { setEditingPath(false); setViaDraft((selected.viaPoints as [number, number][]) ?? []); }}
                      className="text-[10px] px-2 py-1 rounded border border-border/40 text-muted-foreground hover:text-foreground">Annulla</button>
                  </>
                )}
                {(selected.viaPoints?.length ?? 0) > 0 && !editingPath && (
                  <button onClick={() => reroute([])} disabled={rerouting}
                    className="flex items-center gap-1 text-[10px] px-2 py-1 rounded border border-border/40 text-muted-foreground hover:text-foreground">
                    <RotateCcw className="w-3 h-3" /> Reset percorso diretto
                  </button>
                )}
                <button onClick={() => deleteArc(selected.id)}
                  className="ml-auto text-muted-foreground hover:text-red-400" title="Elimina arco">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </motion.div>
          )}

          {/* ricerca + lista */}
          <div className="p-2 border-b border-border/20 shrink-0">
            <div className="relative">
              <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
              {zonesList.length > 0 && (
                <select value={comuneId} onChange={e => setComuneId(e.target.value)}
                  title="Filtra gli archi con ALMENO un nodo nel comune (dati dalla zonizzazione)"
                  className="bg-background/60 border border-border/40 rounded px-1.5 py-1 text-[11px] max-w-[140px]">
                  <option value="">Tutti i comuni</option>
                  {zonesList.map(z => <option key={z.id} value={z.id}>{z.name}</option>)}
                </select>
              )}
              {psList.length > 0 && (
                <select value={psScope} onChange={e => { setPsScope(e.target.value); setSelectedId(null); }}
                  title="Scope: vista globale, oppure archi globali + di un progetto Planner Studio. Genera/cancella lavorano nello scope scelto."
                  className="bg-background/60 border border-border/40 rounded px-1.5 py-1 text-[11px] max-w-[150px]">
                  <option value="">Globale (tutti)</option>
                  {psList.map(pp => <option key={pp.id} value={pp.id}>{pp.name}</option>)}
                </select>
              )}
              <input value={filter} onChange={e => setFilter(e.target.value)} placeholder={`Cerca tra ${arcs.length} archi…`}
                className="w-full bg-background/60 border border-border/40 rounded-lg pl-7 pr-2 py-1.5 text-xs focus:outline-none focus:border-amber-500/50" />
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-2 space-y-1">
            {loading && (
              <div className="flex items-center justify-center gap-2 py-10 text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin text-amber-400" /><span className="text-xs">Caricamento…</span>
              </div>
            )}
            {!loading && arcs.length === 0 && (
              <div className="text-center py-10 px-4">
                <RouteIcon className="w-8 h-8 text-amber-400/30 mx-auto mb-2" />
                <p className="text-xs font-semibold">Nessun arco generato</p>
                <p className="text-[10px] text-muted-foreground mt-1">
                  Clicca "Genera archi" per creare i percorsi a vuoto tra i tuoi depositi e i capolinea delle linee.
                </p>
              </div>
            )}
            {filtered.map(a => (
              <button key={a.id} onClick={() => selectArc(a)}
                className={`w-full text-left rounded-lg border px-2.5 py-1.5 transition-colors ${
                  a.id === selectedId ? "border-amber-500/60 bg-amber-500/10" : "border-border/25 bg-background/40 hover:border-amber-500/30"}`}>
                <p className="text-[11px] font-medium truncate">
                  {a.from.type === "depot" ? "🏠 " : ""}{a.from.name} <span className="text-muted-foreground">→</span> {a.to.type === "depot" ? "🏠 " : ""}{a.to.name}
                </p>
                <p className="text-[10px] text-muted-foreground">
                  {fmt(a.customKm ?? a.roadKm)} km · {fmt(a.customMin ?? a.travelMin)} min
                  {a.customMin != null && <span className="text-amber-300 font-semibold"> · override</span>}
                  {a.source === "manual" && <span className="text-fuchsia-300"> · percorso modificato</span>}
                  {a.source === "stima" && <span className="text-red-300"> · stima</span>}
                </p>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ── Dialog generazione ── */}
      {genOpen && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={() => !generating && setGenOpen(false)}>
          <div className="bg-card border border-border/50 rounded-2xl max-w-md w-full p-4 space-y-3" onClick={e => e.stopPropagation()}>
            <h3 className="text-sm font-bold flex items-center gap-2"><Wand2 className="w-4 h-4 text-amber-400" /> Genera archi fuorilinea</h3>
            <p className="text-[11px] text-muted-foreground">
              Crea gli archi <b>deposito → capolinea</b> (e ritorno) con il percorso reale su strada.
              Gli archi già esistenti non vengono toccati.
            </p>
            <div>
              <p className="text-[10px] font-semibold text-muted-foreground mb-1">Depositi (vuoto = tutti)</p>
              <div className="flex flex-wrap gap-1">
                {depotsList.map(d => (
                  <button key={d.id}
                    onClick={() => setGenDepotIds(cur => { const n = new Set(cur); n.has(d.id) ? n.delete(d.id) : n.add(d.id); return n; })}
                    className={`text-[10px] px-2 py-0.5 rounded-full border ${genDepotIds.has(d.id) ? "border-amber-500/60 text-amber-300 bg-amber-500/10" : "border-border/30 text-muted-foreground"}`}>
                    {d.name}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <p className="text-[10px] font-semibold text-muted-foreground mb-1">Linee (vuoto = tutte, capolinea del feed attivo)</p>
              <div className="flex flex-wrap gap-1 max-h-28 overflow-y-auto">
                {routesList.map(r => (
                  <button key={r.routeId}
                    onClick={() => setGenRouteIds(cur => { const n = new Set(cur); n.has(r.routeId) ? n.delete(r.routeId) : n.add(r.routeId); return n; })}
                    className={`text-[10px] px-2 py-0.5 rounded-full border ${genRouteIds.has(r.routeId) ? "border-amber-500/60 text-amber-300 bg-amber-500/10" : "border-border/30 text-muted-foreground"}`}>
                    {r.shortName}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex items-center gap-2">
              {psScope && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 border border-amber-500/30 text-amber-300 shrink-0"
                  title="Gli archi generati saranno visibili e usati solo per questo progetto">
                  solo progetto: {psList.find(pp => pp.id === psScope)?.name ?? "…"}
                </span>
              )}
              <label className="text-[10px] text-muted-foreground w-full">Rete (feed GTFS)
                <select value={genFeedId} onChange={e => setGenFeedId(e.target.value)}
                  className="w-full mt-0.5 bg-background/60 border border-border/40 rounded px-1.5 py-1 text-[11px]">
                  {feedsList.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}
                </select>
              </label>
              <label className="text-[10px] text-muted-foreground">Anche capolinea↔capolinea entro</label>
              <input type="number" min={0} max={30} step={1} value={genTTKm || ""}
                placeholder="0"
                onChange={e => setGenTTKm(Number(e.target.value) || 0)}
                className="w-14 bg-background/60 border border-border/40 rounded px-1.5 py-1 text-[11px]" />
              <span className="text-[10px] text-muted-foreground">km (0 = no)</span>
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <button onClick={() => setGenOpen(false)} disabled={generating}
                className="text-xs px-3 py-1.5 rounded-lg border border-border/40 text-muted-foreground hover:text-foreground">Annulla</button>
              <button onClick={generate} disabled={generating}
                className="flex items-center gap-1.5 text-xs font-bold px-4 py-1.5 rounded-lg bg-amber-500 text-black hover:bg-amber-400 disabled:opacity-50">
                {generating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Wand2 className="w-3.5 h-3.5" />} Genera
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
