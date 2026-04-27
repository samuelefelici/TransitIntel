/**
 * Step 4 — Fuori Linea (Deadhead Matrix)
 *
 * Genera e visualizza tutti i movimenti a vuoto possibili tra:
 *  - Deposito di partenza
 *  - Capolinea delle linee selezionate
 *  - Fermate di cambio dei cluster selezionati
 *
 * Per ogni coppia (A→B) vengono calcolati:
 *  - Distanza stradale stimata (Haversine × 1.35)
 *  - Tempo di percorrenza (@ 22 km/h media bus urbano)
 *  - Costo (€/km configurabile)
 *
 * I valori sono editabili prima di procedere all'ottimizzazione.
 */
import React, { useState, useEffect, useCallback, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  ArrowLeft, ChevronRight, Loader2, AlertTriangle, Building2,
  Route, Clock, Euro, Edit3, Save, X,
  Bus, Layers, ChevronDown, ChevronUp, RefreshCw, Info,
} from "lucide-react";
import { getApiBase } from "@/lib/api";
import type { GtfsSelection, VehicleAssignment } from "@/pages/fucina";

/* ── Tipi ── */
interface DeadheadNode {
  id: string;
  type: "depot" | "terminus" | "cluster";
  name: string;
  lat: number;
  lon: number;
  routeIds?: string[];
  clusterName?: string;
  clusterColor?: string;
}

interface Deadhead {
  id: string;
  fromId: string;
  toId: string;
  distanceKm: number;
  durationMin: number;
  costEur: number;
  overridden: boolean;
  enabled?: boolean;  // default true; se false il collegamento è escluso dall'ottimizzazione
}

export interface DeadheadMatrix {
  nodes: DeadheadNode[];
  deadheads: Deadhead[];
  costPerKm: number;
}

interface Props {
  gtfsSelection: GtfsSelection;
  assignment: VehicleAssignment;
  depotId: string;
  clusterIds: string[];
  initial?: DeadheadMatrix | null;
  onBack: () => void;
  onComplete: (matrix: DeadheadMatrix) => void;
}

/* ── Colori nodi ── */
const NODE_COLOR: Record<DeadheadNode["type"], string> = {
  depot:    "#f97316",
  terminus: "#3b82f6",
  cluster:  "#8b5cf6",
};

const NODE_LABEL: Record<DeadheadNode["type"], string> = {
  depot:    "Deposito",
  terminus: "Capolinea",
  cluster:  "Fermata Cambio",
};

/* ── Helpers ── */
function fmtMin(m: number) {
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)}h ${m % 60}′`;
}

/* ── Coppia bidirezionale A ↔ B ── */
interface DeadheadPair {
  key: string;          // `${a.id}|${b.id}` con a.id < b.id
  a: DeadheadNode;
  b: DeadheadNode;
  forward: Deadhead;    // a → b
  backward: Deadhead;   // b → a
  // Valori visualizzati (media di forward e backward, o uguali se simmetrici)
  distanceKm: number;
  durationMin: number;
  costEur: number;
  overridden: boolean;
  asymmetric: boolean;  // true se forward ≠ backward (dopo edit manuale)
  enabled: boolean;     // true se almeno una direzione è abilitata
}

function buildPairs(nodes: DeadheadNode[], deadheads: Deadhead[]): DeadheadPair[] {
  const byKey: globalThis.Map<string, Deadhead> = new globalThis.Map();
  for (const d of deadheads) byKey.set(`${d.fromId}|${d.toId}`, d);
  const seen: globalThis.Set<string> = new globalThis.Set();
  const out: DeadheadPair[] = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
      const k = `${a.id}|${b.id}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const fwd = byKey.get(`${a.id}|${b.id}`);
      const bwd = byKey.get(`${b.id}|${a.id}`);
      if (!fwd || !bwd) continue;
      const asymmetric =
        fwd.distanceKm  !== bwd.distanceKm  ||
        fwd.durationMin !== bwd.durationMin ||
        fwd.costEur     !== bwd.costEur;
      out.push({
        key: k,
        a, b, forward: fwd, backward: bwd,
        distanceKm:  asymmetric ? (fwd.distanceKm  + bwd.distanceKm)  / 2 : fwd.distanceKm,
        durationMin: asymmetric ? Math.round((fwd.durationMin + bwd.durationMin) / 2) : fwd.durationMin,
        costEur:     asymmetric ? (fwd.costEur     + bwd.costEur)     / 2 : fwd.costEur,
        overridden:  fwd.overridden || bwd.overridden,
        asymmetric,
        enabled:     (fwd.enabled ?? true) || (bwd.enabled ?? true),
      });
    }
  }
  // Più lungo = più costoso → ordine per costo DESC
  return out.sort((x, y) => y.costEur - x.costEur);
}

export default function DeadheadStep({
  gtfsSelection, assignment, depotId, clusterIds, initial, onBack, onComplete,
}: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError]   = useState<string | null>(null);
  const [costPerKm, setCostPerKm] = useState(initial?.costPerKm ?? 2.20);
  const [nodes, setNodes]         = useState<DeadheadNode[]>(initial?.nodes ?? []);
  const [deadheads, setDeadheads] = useState<Deadhead[]>(initial?.deadheads ?? []);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editBuf, setEditBuf]     = useState<Partial<Deadhead>>({});
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set(["depot_terminus", "depot_cluster"]));

  /* ── Calcolo ── */
  const compute = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const routeIds = Array.from(assignment.selectedRoutes.keys());
      const date = gtfsSelection.date.replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3");
      const res = await fetch(`${getApiBase()}/api/deadheads/compute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ depotId, routeIds, clusterIds, date, costPerKm }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Errore nel calcolo");
      setNodes(data.nodes);
      setDeadheads(data.deadheads);
    } catch (e: any) {
      setError(e.message ?? "Errore sconosciuto");
    } finally {
      setLoading(false);
    }
  }, [depotId, assignment, clusterIds, gtfsSelection, costPerKm]);

  useEffect(() => {
    if (!initial) compute();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── Edit ── */
  /** Salva modifiche applicandole simmetricamente a entrambe le direzioni della coppia. */
  const savePairEdit = (pair: DeadheadPair) => {
    const fwdId = pair.forward.id;
    const bwdId = pair.backward.id;
    setDeadheads(prev => prev.map(dh => {
      if (dh.id === fwdId || dh.id === bwdId) {
        return {
          ...dh,
          distanceKm:  editBuf.distanceKm  ?? dh.distanceKm,
          durationMin: editBuf.durationMin ?? dh.durationMin,
          costEur:     editBuf.costEur     ?? dh.costEur,
          overridden:  true,
        };
      }
      return dh;
    }));
    setEditingId(null);
  };

  /** Abilita/disabilita entrambe le direzioni di una coppia. */
  const togglePairEnabled = (pair: DeadheadPair) => {
    const newEnabled = !pair.enabled;
    const fwdId = pair.forward.id;
    const bwdId = pair.backward.id;
    setDeadheads(prev => prev.map(dh =>
      (dh.id === fwdId || dh.id === bwdId) ? { ...dh, enabled: newEnabled } : dh
    ));
  };

  const setAllEnabled = (enabled: boolean) => {
    setDeadheads(prev => prev.map(dh => ({ ...dh, enabled })));
  };

  /* ── Coppie bidirezionali ── */
  const pairs = useMemo(() => buildPairs(nodes, deadheads), [nodes, deadheads]);

  /* ── Raggruppamento per display (basato su pairs A↔B) ── */
  const isDepot    = (id: string) => id.startsWith("depot:");
  const isTerminus = (id: string) => id.startsWith("terminus:");
  const isCluster  = (id: string) => id.startsWith("cluster:");

  const groups = [
    {
      id: "depot_terminus",
      label: "Deposito ↔ Capolinee",
      icon: Route,
      color: "text-orange-400",
      items: pairs.filter(p =>
        (isDepot(p.a.id) && isTerminus(p.b.id)) ||
        (isDepot(p.b.id) && isTerminus(p.a.id))
      ),
    },
    {
      id: "depot_cluster",
      label: "Deposito ↔ Cluster",
      icon: Route,
      color: "text-orange-400",
      items: pairs.filter(p =>
        (isDepot(p.a.id) && isCluster(p.b.id)) ||
        (isDepot(p.b.id) && isCluster(p.a.id))
      ),
    },
    {
      id: "terminus_terminus",
      label: "Tra Capolinee",
      icon: Bus,
      color: "text-blue-400",
      items: pairs.filter(p => isTerminus(p.a.id) && isTerminus(p.b.id)),
    },
    {
      id: "cluster_terminus",
      label: "Capolinee ↔ Cluster",
      icon: Layers,
      color: "text-violet-400",
      items: pairs.filter(p =>
        (isTerminus(p.a.id) && isCluster(p.b.id)) ||
        (isTerminus(p.b.id) && isCluster(p.a.id))
      ),
    },
    {
      id: "cluster_cluster",
      label: "Tra Cluster",
      icon: Layers,
      color: "text-violet-400",
      items: pairs.filter(p => isCluster(p.a.id) && isCluster(p.b.id)),
    },
  ].filter(g => g.items.length > 0);

  const totalCost = deadheads.reduce((s, dh) => s + dh.costEur, 0);
  const totalKm   = deadheads.reduce((s, dh) => s + dh.distanceKm, 0);

  /* ── Render ── */
  return (
    <div className="h-full flex flex-col overflow-hidden">

      {/* ── Header ── */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-orange-500/15 shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-xl bg-orange-500/10 border border-orange-500/20 flex items-center justify-center shrink-0">
            <Route className="w-4 h-4 text-orange-400" />
          </div>
          <div>
            <h2 className="text-sm font-bold text-foreground">Fuori Linea</h2>
            <p className="text-[10px] text-muted-foreground">
              Movimenti a vuoto · {nodes.length} nodi · {pairs.length} collegamenti
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {/* Costo/km configurabile */}
          <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-muted/20 border border-border/30">
            <Euro className="w-3 h-3 text-muted-foreground" />
            <input
              type="number"
              min={0} max={10} step={0.05}
              value={costPerKm}
              onChange={e => setCostPerKm(parseFloat(e.target.value) || 0)}
              className="w-14 text-xs bg-transparent text-foreground outline-none"
              title="Costo per km (€)"
            />
            <span className="text-[10px] text-muted-foreground">/km</span>
          </div>
          <button
            onClick={compute}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-muted-foreground hover:text-foreground hover:bg-white/5 border border-border/30 transition-all disabled:opacity-40"
          >
            <RefreshCw className={`w-3 h-3 ${loading ? "animate-spin" : ""}`} />
            Ricalcola
          </button>
          <button
            onClick={onBack}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-muted-foreground hover:text-foreground hover:bg-white/5 transition-all border border-border/30"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            Indietro
          </button>
          <button
            disabled={deadheads.length === 0}
            onClick={() => onComplete({ nodes, deadheads, costPerKm })}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold disabled:opacity-40 disabled:cursor-not-allowed transition-all bg-orange-500 text-black hover:bg-orange-400 shadow-[0_0_12px_rgba(249,115,22,0.3)]"
          >
            Avanti — Ottimizzazione
            <ChevronRight className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* ── Loading / Error ── */}
      {loading && (
        <div className="flex-1 flex items-center justify-center gap-3 text-muted-foreground">
          <Loader2 className="w-6 h-6 animate-spin text-orange-400" />
          <div>
            <p className="text-sm font-semibold">Calcolo fuori linea…</p>
            <p className="text-xs text-muted-foreground/60">
              Recupero capolinea, fermate cluster e calcolo matrice distanze
            </p>
          </div>
        </div>
      )}

      {!loading && error && (
        <div className="flex-1 flex items-center justify-center">
          <div className="max-w-sm flex flex-col items-center gap-3 text-center p-6 rounded-2xl bg-red-500/8 border border-red-500/20">
            <AlertTriangle className="w-8 h-8 text-red-400" />
            <p className="text-sm font-semibold text-red-400">Errore nel calcolo</p>
            <p className="text-xs text-muted-foreground">{error}</p>
            <button onClick={compute} className="px-4 py-2 rounded-lg text-xs bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-all">
              Riprova
            </button>
          </div>
        </div>
      )}

      {!loading && !error && nodes.length > 0 && (
        <div className="flex-1 flex overflow-hidden">

          {/* ── Pannello dati (full width, senza mappa) ── */}
          <div className="flex-1 flex flex-col overflow-hidden bg-background/50">

            {/* Stats summary */}
            <div className="grid grid-cols-4 gap-2 p-3 border-b border-border/20 shrink-0">
              {[
                { label: "Collegamenti", value: `${pairs.filter(p => p.enabled).length} / ${pairs.length}`, color: "text-foreground" },
                { label: "Km totali",    value: `${(totalKm / 2).toFixed(0)} km`,                            color: "text-blue-400"   },
                { label: "Costo totale", value: `€ ${(totalCost / 2).toFixed(0)}`,                           color: "text-green-400"  },
                { label: "Nodi",         value: nodes.length,                                                color: "text-violet-400" },
              ].map(s => (
                <div key={s.label} className="bg-muted/20 rounded-lg p-2 text-center">
                  <p className={`text-sm font-black ${s.color}`}>{s.value}</p>
                  <p className="text-[8px] text-muted-foreground uppercase tracking-widest">{s.label}</p>
                </div>
              ))}
            </div>

            {/* Azioni globali abilita/disabilita */}
            <div className="flex items-center gap-2 px-3 py-2 border-b border-border/20 shrink-0">
              <span className="text-[10px] text-muted-foreground uppercase tracking-wider">Azioni rapide:</span>
              <button
                onClick={() => setAllEnabled(true)}
                className="px-2.5 py-1 rounded-md text-[10px] bg-emerald-500/15 text-emerald-400 border border-emerald-500/25 hover:bg-emerald-500/25 transition-all"
              >
                Abilita tutti
              </button>
              <button
                onClick={() => setAllEnabled(false)}
                className="px-2.5 py-1 rounded-md text-[10px] bg-red-500/15 text-red-400 border border-red-500/25 hover:bg-red-500/25 transition-all"
              >
                Disabilita tutti
              </button>
            </div>

            {/* Note metodologiche */}
            <div className="mx-3 mt-2 mb-1 flex items-start gap-2 p-2.5 rounded-lg bg-blue-500/8 border border-blue-500/15">
              <Info className="w-3 h-3 text-blue-400 mt-0.5 shrink-0" />
              <p className="text-[9px] text-muted-foreground/70 leading-relaxed">
                Distanza stradale stimata = Haversine × 1.35 · Velocità bus: 22 km/h · Costo: {costPerKm.toFixed(2)} €/km.
                I valori sono modificabili singolarmente — click sull'icona <Edit3 className="w-2.5 h-2.5 inline" />.
              </p>
            </div>

            {/* Legenda nodi */}
            <div className="px-3 py-1.5 flex gap-1.5 flex-wrap border-b border-border/20 shrink-0">
              {(["depot","terminus","cluster"] as const).map(t => (
                <div
                  key={t}
                  className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] border"
                  style={{
                    background: `${NODE_COLOR[t]}15`,
                    borderColor: `${NODE_COLOR[t]}40`,
                    color: NODE_COLOR[t],
                  }}
                >
                  {t === "depot"    && <Building2 className="w-2.5 h-2.5" />}
                  {t === "terminus" && <Bus       className="w-2.5 h-2.5" />}
                  {t === "cluster"  && <Layers    className="w-2.5 h-2.5" />}
                  <span>{NODE_LABEL[t]}</span>
                  <span className="opacity-60">× {nodes.filter(n => n.type === t).length}</span>
                </div>
              ))}
            </div>

            {/* Gruppi di connessioni */}
            <div className="flex-1 overflow-y-auto p-2 space-y-1">
              {groups.map(g => {
                const isOpen = expandedGroups.has(g.id);
                const enabledInGroup = g.items.filter(p => p.enabled).length;
                const allEnabled = enabledInGroup === g.items.length;
                return (
                  <div key={g.id} className="rounded-xl border border-border/25 overflow-hidden">
                    {/* header gruppo */}
                    <div className="w-full flex items-center gap-2 px-3 py-2 hover:bg-white/4 transition-all">
                      {/* Toggle gruppo */}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          const target = allEnabled ? false : true;
                          const ids = new Set(g.items.flatMap(p => [p.forward.id, p.backward.id]));
                          setDeadheads(prev => prev.map(dh => ids.has(dh.id) ? { ...dh, enabled: target } : dh));
                        }}
                        role="switch"
                        aria-checked={allEnabled}
                        title={allEnabled ? "Disabilita tutto il gruppo" : "Abilita tutto il gruppo"}
                        className={`shrink-0 relative inline-flex h-4 w-7 items-center rounded-full transition-colors ${
                          allEnabled ? "bg-emerald-500/70" : enabledInGroup > 0 ? "bg-amber-500/60" : "bg-muted/40"
                        }`}
                      >
                        <span
                          className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${
                            allEnabled ? "translate-x-3.5" : enabledInGroup > 0 ? "translate-x-2" : "translate-x-0.5"
                          }`}
                        />
                      </button>
                      <button
                        onClick={() => setExpandedGroups(prev => {
                          const next = new Set(prev);
                          isOpen ? next.delete(g.id) : next.add(g.id);
                          return next;
                        })}
                        className="flex-1 flex items-center gap-2 text-left"
                      >
                        <g.icon className={`w-3.5 h-3.5 ${g.color}`} />
                        <span className="text-xs font-semibold text-foreground flex-1">{g.label}</span>
                        <span className="text-[9px] text-muted-foreground/60 mr-1 tabular-nums">
                          {enabledInGroup} / {g.items.length}
                        </span>
                        {isOpen ? <ChevronUp className="w-3 h-3 text-muted-foreground" /> : <ChevronDown className="w-3 h-3 text-muted-foreground" />}
                      </button>
                    </div>

                    <AnimatePresence>
                      {isOpen && (
                        <motion.div
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: "auto", opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          transition={{ duration: 0.2 }}
                          className="overflow-hidden"
                        >
                          <div className="border-t border-border/20 divide-y divide-border/10">
                            {g.items.map(p => {
                              const isEditing = editingId === p.key;
                              return (
                                <div
                                  key={p.key}
                                  className={`px-3 py-2 hover:bg-white/3 transition-all group ${p.enabled ? "" : "opacity-40"}`}
                                >
                                  {/* Tratta bidirezionale A ↔ B */}
                                  <div className="flex items-center gap-1.5 mb-1.5">
                                    {/* Toggle abilitazione */}
                                    <button
                                      onClick={() => togglePairEnabled(p)}
                                      role="switch"
                                      aria-checked={p.enabled}
                                      title={p.enabled ? "Disabilita collegamento" : "Abilita collegamento"}
                                      className={`shrink-0 relative inline-flex h-4 w-7 items-center rounded-full transition-colors ${
                                        p.enabled ? "bg-emerald-500/70" : "bg-muted/40"
                                      }`}
                                    >
                                      <span
                                        className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${
                                          p.enabled ? "translate-x-3.5" : "translate-x-0.5"
                                        }`}
                                      />
                                    </button>
                                    <div className="flex items-center gap-1 text-[10px] text-foreground/80 min-w-0 flex-1">
                                      <div className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: NODE_COLOR[p.a.type] }} />
                                      <span className="truncate font-medium">{p.a.name}</span>
                                      <span className="px-1 text-muted-foreground/60 text-[10px] shrink-0">↔</span>
                                      <div className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: NODE_COLOR[p.b.type] }} />
                                      <span className="truncate font-medium">{p.b.name}</span>
                                    </div>
                                    {p.overridden && (
                                      <span className="text-[8px] px-1 py-0.5 rounded-full bg-amber-500/20 text-amber-400 border border-amber-500/30 shrink-0">mod.</span>
                                    )}
                                    {p.asymmetric && (
                                      <span className="text-[8px] px-1 py-0.5 rounded-full bg-purple-500/20 text-purple-300 border border-purple-500/30 shrink-0" title="Andata e ritorno differenti">≠</span>
                                    )}
                                    <button
                                      onClick={() => {
                                        if (isEditing) { setEditingId(null); }
                                        else {
                                          setEditingId(p.key);
                                          setEditBuf({
                                            distanceKm:  Math.round(p.distanceKm  * 10) / 10,
                                            durationMin: p.durationMin,
                                            costEur:     Math.round(p.costEur     * 100) / 100,
                                          });
                                        }
                                      }}
                                      className="p-1 rounded text-muted-foreground hover:text-blue-400 opacity-0 group-hover:opacity-100 transition-all"
                                    >
                                      {isEditing ? <X className="w-3 h-3" /> : <Edit3 className="w-3 h-3" />}
                                    </button>
                                  </div>

                                  {/* Valori */}
                                  {isEditing ? (
                                    <div className="flex items-center gap-2 mt-1">
                                      <label className="flex items-center gap-1 text-[9px] text-muted-foreground flex-1">
                                        <Route className="w-2.5 h-2.5" />
                                        <input
                                          type="number" min={0} step={0.1}
                                          value={editBuf.distanceKm ?? ""}
                                          onChange={e => setEditBuf(pb => ({ ...pb, distanceKm: parseFloat(e.target.value) || 0 }))}
                                          className="w-16 bg-muted/40 rounded px-1.5 py-0.5 text-foreground text-[9px] outline-none"
                                        />
                                        km
                                      </label>
                                      <label className="flex items-center gap-1 text-[9px] text-muted-foreground flex-1">
                                        <Clock className="w-2.5 h-2.5" />
                                        <input
                                          type="number" min={0}
                                          value={editBuf.durationMin ?? ""}
                                          onChange={e => setEditBuf(pb => ({ ...pb, durationMin: parseInt(e.target.value) || 0 }))}
                                          className="w-12 bg-muted/40 rounded px-1.5 py-0.5 text-foreground text-[9px] outline-none"
                                        />
                                        min
                                      </label>
                                      <label className="flex items-center gap-1 text-[9px] text-muted-foreground flex-1">
                                        <Euro className="w-2.5 h-2.5" />
                                        <input
                                          type="number" min={0} step={0.01}
                                          value={editBuf.costEur ?? ""}
                                          onChange={e => setEditBuf(pb => ({ ...pb, costEur: parseFloat(e.target.value) || 0 }))}
                                          className="w-14 bg-muted/40 rounded px-1.5 py-0.5 text-foreground text-[9px] outline-none"
                                        />
                                        €
                                      </label>
                                      <button
                                        onClick={() => savePairEdit(p)}
                                        className="p-1 rounded bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 transition-all"
                                        title="Salva (applicato a entrambi i sensi)"
                                      >
                                        <Save className="w-3 h-3" />
                                      </button>
                                    </div>
                                  ) : (
                                    <div className="flex items-center gap-3">
                                      <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                                        <Route className="w-2.5 h-2.5" />
                                        {p.distanceKm.toFixed(1)} km
                                      </span>
                                      <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                                        <Clock className="w-2.5 h-2.5" />
                                        {fmtMin(p.durationMin)}
                                      </span>
                                      <span className="flex items-center gap-1 text-[10px] text-green-400/80">
                                        <Euro className="w-2.5 h-2.5" />
                                        {p.costEur.toFixed(2)}
                                      </span>
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                );
              })}
            </div>

            {/* CTA bottom */}
            <div className="p-3 border-t border-border/20 shrink-0">
              <button
                disabled={deadheads.length === 0}
                onClick={() => onComplete({ nodes, deadheads, costPerKm })}
                className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-xs font-bold disabled:opacity-40 disabled:cursor-not-allowed transition-all bg-orange-500 text-black hover:bg-orange-400 shadow-[0_0_15px_rgba(249,115,22,0.25)]"
              >
                Procedi all'ottimizzazione
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
