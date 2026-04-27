/**
 * Step 2 — Cluster di Cambio
 *
 * Mostra i cluster di fermate toccati dalle linee selezionate nella data
 * di esercizio scelta. Ogni cluster rappresenta un punto di cambio vettura.
 * Consente di verificare la copertura prima di avviare l'ottimizzazione.
 */
import React, { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  MapPin, ArrowLeft, ChevronRight, Loader2, AlertTriangle,
  Clock, Layers, CheckCircle2, ChevronDown, ChevronUp,
} from "lucide-react";
import { getApiBase } from "@/lib/api";
import type { GtfsSelection, VehicleAssignment } from "@/pages/fucina";

/* ── Tipi ── */
interface ClusterStop {
  id: string;
  gtfsStopId: string | null;
  stopName: string | null;
  stopLat: number | null;
  stopLon: number | null;
  isTouched: boolean;
}

interface Cluster {
  id: string;
  name: string;
  color: string | null;
  transferFromDepotMin: number | null;
  touched: boolean;
  touchedStopsCount: number;
  stops: ClusterStop[];
}

interface Props {
  gtfsSelection: GtfsSelection;
  assignment: VehicleAssignment;
  onBack: () => void;
  onComplete: (selectedClusterIds: string[]) => void;
}

export default function ClustersStep({ gtfsSelection, assignment, onBack, onComplete }: Props) {
  const [clusters, setClusters] = useState<Cluster[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [touchedStopCount, setTouchedStopCount] = useState(0);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  /* ── Fetch cluster al mount ── */
  useEffect(() => {
    const routeIds = Array.from(assignment.selectedRoutes.keys());
    if (routeIds.length === 0) { setLoading(false); return; }

    const base = getApiBase();
    fetch(`${base}/api/clusters/by-routes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ routeIds, date: assignment.selectedDate }),
    })
      .then(r => r.json())
      .then(data => {
        const loaded: Cluster[] = data.data ?? [];
        setClusters(loaded);
        setTouchedStopCount(data.touchedStopCount ?? 0);
        // Pre-seleziona tutti i cluster toccati
        setSelectedIds(new Set(loaded.filter(c => c.touched).map(c => c.id)));
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const toggleExpand = (id: string) => {
    setExpandedIds(prev => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  };

  const toggleSelect = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setSelectedIds(prev => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  };

  const selectAll = () => setSelectedIds(new Set(clusters.map(c => c.id)));
  const deselectAll = () => setSelectedIds(new Set());

  const proceed = () => onComplete(Array.from(selectedIds));

  /* ── Colore hex → stile ── */
  const hexToRgb = (hex: string | null) => {
    if (!hex) return null;
    const h = hex.replace("#", "");
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    return `${r}, ${g}, ${b}`;
  };

  return (
    <div className="h-full flex flex-col">
      {/* ── Header ── */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-border/30 shrink-0">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          Abbinamento Vetture
        </button>
        <div className="flex items-center gap-2">
          <Layers className="w-4 h-4 text-orange-400" />
          <span className="text-sm font-semibold">Cluster di Cambio</span>
        </div>
        <button
          onClick={proceed}
          disabled={loading}
          className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-semibold bg-orange-500 text-black hover:bg-orange-400 disabled:opacity-40 transition-colors"
        >
          Procedi
          <ChevronRight className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* ── Body ── */}
      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">

        {/* Sommario */}
        <div className="bg-card/40 border border-border/30 rounded-xl p-4">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <p className="text-sm font-semibold text-foreground mb-0.5">
                Copertura cluster per le linee selezionate
              </p>
              <p className="text-xs text-muted-foreground">
                Data esercizio:{" "}
                <span className="text-foreground font-mono">
                  {new Date(assignment.selectedDate + "T00:00:00").toLocaleDateString("it-IT", {
                    day: "2-digit", month: "long", year: "numeric",
                  })}
                </span>
                {" · "}
                <span className="text-orange-400">{assignment.selectedRoutes.size} linee</span>
                {" · "}
                <span className="text-foreground">{touchedStopCount} fermate totali</span>
              </p>
            </div>
            {!loading && clusters.length > 0 && (
              <div className="flex items-center gap-3">
                <div className="text-center">
                  <p className="text-2xl font-black text-orange-400">{selectedIds.size}</p>
                  <p className="text-[9px] text-muted-foreground uppercase tracking-widest">selezionati</p>
                </div>
                <div className="text-center">
                  <p className="text-2xl font-black text-foreground/40">{clusters.length}</p>
                  <p className="text-[9px] text-muted-foreground uppercase tracking-widest">totali</p>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Loading */}
        {loading && (
          <div className="flex flex-col items-center justify-center gap-3 py-16 text-muted-foreground">
            <Loader2 className="w-7 h-7 animate-spin text-orange-400" />
            <p className="text-sm">Ricerca cluster in corso…</p>
          </div>
        )}

        {/* Errore */}
        {!loading && error && (
          <div className="flex items-start gap-3 p-4 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
            <div>
              <p className="text-sm font-medium">Errore nel caricamento dei cluster</p>
              <p className="text-xs mt-0.5 opacity-80">{error}</p>
            </div>
          </div>
        )}

        {/* Nessun cluster */}
        {!loading && !error && clusters.length === 0 && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex flex-col items-center gap-3 py-16 text-center"
          >
            <div className="w-12 h-12 rounded-xl bg-orange-500/10 border border-orange-500/20 flex items-center justify-center">
              <MapPin className="w-5 h-5 text-orange-400/60" />
            </div>
            <div>
              <p className="text-sm font-semibold text-foreground">Nessun cluster configurato</p>
              <p className="text-xs text-muted-foreground mt-1 max-w-xs mx-auto">
                Non ci sono cluster di cambio associati alle fermate delle linee selezionate.
                Puoi configurarli dalla sezione <span className="text-orange-400">Rete → Cluster</span>.
              </p>
            </div>
            <button
              onClick={proceed}
              className="mt-2 flex items-center gap-1.5 px-5 py-2 rounded-lg text-xs font-semibold bg-orange-500 text-black hover:bg-orange-400 transition-colors"
            >
              Procedi comunque
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </motion.div>
        )}

        {/* Lista cluster */}
        {!loading && !error && clusters.length > 0 && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="space-y-2"
          >
            {/* Toolbar selezione */}
            <div className="flex items-center justify-between px-1 pb-1">
              <p className="text-[10px] text-muted-foreground uppercase tracking-widest">
                Seleziona i cluster da includere nell'ottimizzazione
              </p>
              <div className="flex items-center gap-2">
                <button
                  onClick={selectAll}
                  className="text-[10px] text-orange-400 hover:text-orange-300 transition-colors"
                >
                  Tutti
                </button>
                <span className="text-muted-foreground/30 text-[10px]">·</span>
                <button
                  onClick={deselectAll}
                  className="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
                >
                  Nessuno
                </button>
              </div>
            </div>

            {clusters.map((cluster, idx) => {
              const rgb = hexToRgb(cluster.color);
              const isExpanded = expandedIds.has(cluster.id);
              const isSelected = selectedIds.has(cluster.id);
              const touchedStops = cluster.stops.filter(s => s.isTouched);

              return (
                <motion.div
                  key={cluster.id}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: idx * 0.04 }}
                  className={`rounded-xl border overflow-hidden transition-all ${isSelected ? "ring-1" : "opacity-60"}`}
                  style={{
                    borderColor: rgb ? `rgba(${rgb}, ${isSelected ? 0.4 : 0.15})` : "rgba(255,255,255,0.1)",
                    background: rgb ? `rgba(${rgb}, ${isSelected ? 0.07 : 0.02})` : "rgba(255,255,255,0.02)",
                  }}
                >
                  {/* Header cluster */}
                  <button
                    onClick={() => toggleExpand(cluster.id)}
                    className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-white/5 transition-colors"
                  >
                    {/* Checkbox selezione */}
                    <div
                      onClick={(e) => toggleSelect(cluster.id, e)}
                      className={`w-4 h-4 rounded border-2 shrink-0 flex items-center justify-center transition-all cursor-pointer ${
                        isSelected
                          ? "border-transparent"
                          : "border-border/50 bg-transparent"
                      }`}
                      style={isSelected ? { background: cluster.color ?? "#f97316", borderColor: cluster.color ?? "#f97316" } : {}}
                    >
                      {isSelected && (
                        <svg viewBox="0 0 10 8" className="w-2.5 h-2.5" fill="none" stroke="white" strokeWidth="2">
                          <polyline points="1,4 4,7 9,1" />
                        </svg>
                      )}
                    </div>

                    {/* Pallino colore */}
                    <div
                      className="w-3.5 h-3.5 rounded-full shrink-0"
                      style={{
                        background: cluster.color ?? "#6b7280",
                        outline: `2px solid ${cluster.color ?? "#6b7280"}`,
                        outlineOffset: "2px",
                      }}
                    />

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold truncate text-foreground">
                          {cluster.name}
                        </span>
                        <CheckCircle2 className="w-3.5 h-3.5 text-green-400 shrink-0" />
                      </div>
                      <div className="flex items-center gap-3 mt-0.5">
                        <span className="text-[10px] text-muted-foreground">
                          <span className="text-orange-400 font-medium">{cluster.touchedStopsCount}</span>
                          {" / "}
                          <span>{cluster.stops.length}</span>
                          {" fermate attive"}
                        </span>
                        {cluster.transferFromDepotMin != null && (
                          <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                            <Clock className="w-2.5 h-2.5" />
                            {cluster.transferFromDepotMin} min dal deposito
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Badge count */}
                    <span
                      className="text-[10px] font-bold px-2 py-0.5 rounded-full shrink-0"
                      style={{
                        background: rgb ? `rgba(${rgb}, 0.15)` : "rgba(255,255,255,0.08)",
                        color: cluster.color ?? "#9ca3af",
                      }}
                    >
                      {cluster.touchedStopsCount} fermata{cluster.touchedStopsCount !== 1 ? "e" : ""}
                    </span>

                    {isExpanded
                      ? <ChevronUp className="w-3.5 h-3.5 text-muted-foreground/50 shrink-0" />
                      : <ChevronDown className="w-3.5 h-3.5 text-muted-foreground/50 shrink-0" />
                    }
                  </button>

                  {/* Lista fermate espansa */}
                  <AnimatePresence>
                    {isExpanded && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.18 }}
                        className="overflow-hidden"
                      >
                        <div className="border-t px-4 py-3 space-y-1.5"
                          style={{ borderColor: rgb ? `rgba(${rgb}, 0.15)` : "rgba(255,255,255,0.06)" }}
                        >
                          <p className="text-[10px] text-muted-foreground/50 uppercase tracking-widest mb-2">
                            Fermate del cluster
                          </p>
                          {cluster.stops.map(stop => (
                            <div
                              key={stop.id}
                              className={`flex items-center gap-2.5 text-[11px] px-2.5 py-1.5 rounded-lg ${
                                stop.isTouched
                                  ? "bg-green-500/8 border border-green-500/15"
                                  : "bg-muted/10 border border-border/20 opacity-50"
                              }`}
                            >
                              <MapPin
                                className={`w-3 h-3 shrink-0 ${stop.isTouched ? "text-green-400" : "text-muted-foreground/40"}`}
                              />
                              <span className={stop.isTouched ? "text-foreground" : "text-muted-foreground"}>
                                {stop.stopName ?? stop.gtfsStopId ?? "Fermata senza nome"}
                              </span>
                              {stop.gtfsStopId && (
                                <span className="ml-auto font-mono text-[9px] text-muted-foreground/40">
                                  {stop.gtfsStopId}
                                </span>
                              )}
                              {stop.isTouched && (
                                <CheckCircle2 className="w-3 h-3 text-green-400 shrink-0" />
                              )}
                            </div>
                          ))}
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </motion.div>
              );
            })}
          </motion.div>
        )}

        {/* CTA bottom */}
        {!loading && !error && clusters.length > 0 && (
          <div className="pt-2 pb-4">
            <button
              onClick={proceed}
              className="w-full flex items-center justify-center gap-2 py-3 rounded-xl font-bold text-sm text-black bg-gradient-to-r from-orange-400 to-amber-400 hover:from-orange-300 hover:to-amber-300 transition-all shadow-[0_0_20px_rgba(251,146,60,0.3)]"
            >
              Procedi con {selectedIds.size} cluster{selectedIds.size !== 1 ? "" : ""}
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
