import React, { useState, useEffect, useMemo, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  MapPin, Search, Bus, Route, Clock, ArrowRight,
  ChevronLeft, ChevronRight, Info, Layers,
} from "lucide-react";
import { getApiBase } from "@/lib/api";

// ─── Types ────────────────────────────────────────────────────
interface StopItem {
  stopId: string; name: string; lat: number; lon: number;
  routeIds: string[]; routeCount: number;
}
interface RouteDetail {
  routeId: string; shortName: string; longName: string;
  color: string; textColor: string; departures: string[];
}
interface StopDetail {
  stop: { stopId: string; name: string; lat: number; lon: number };
  routes: RouteDetail[];
}
interface DirectoryResponse {
  stops: StopItem[]; total: number; page: number; limit: number;
}

// ─── Helpers ─────────────────────────────────────────────────
function routeColor(color: string) {
  if (!color || color === "6b7280") return "#64748b";
  return color.startsWith("#") ? color : `#${color}`;
}

function groupDepartures(deps: string[]) {
  const groups: Record<string, string[]> = {
    "Prima mattina (5-8h)": [], "Mattina (8-12h)": [],
    "Pomeriggio (12-17h)": [], "Sera (17-22h)": [], "Notte": [],
  };
  for (const dep of deps) {
    const h = parseInt(dep.split(":")[0]);
    if (h >= 5 && h < 8)   groups["Prima mattina (5-8h)"].push(dep);
    else if (h >= 8 && h < 12)  groups["Mattina (8-12h)"].push(dep);
    else if (h >= 12 && h < 17) groups["Pomeriggio (12-17h)"].push(dep);
    else if (h >= 17 && h < 22) groups["Sera (17-22h)"].push(dep);
    else groups["Notte"].push(dep);
  }
  return groups;
}

const PAGE_SIZE = 50;

// ─── Main Page ────────────────────────────────────────────────
export default function Stops() {
  const [stops, setStops] = useState<StopItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [selectedStop, setSelectedStop] = useState<StopDetail | null>(null);

  const fetchStops = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
    if (search) params.set("q", search);
    fetch(`${getApiBase()}/api/gtfs/stops/directory?${params}`, { cache: "no-store" })
      .then(r => r.json())
      .then((d: DirectoryResponse) => {
        setStops(d.stops);
        setTotal(d.total);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [page, search]);

  useEffect(() => { fetchStops(); }, [fetchStops]);

  // Debounce search
  useEffect(() => {
    const t = setTimeout(() => {
      setPage(1);
      setSearch(searchInput);
    }, 350);
    return () => clearTimeout(t);
  }, [searchInput]);

  const fetchDetail = useCallback((stopId: string) => {
    setLoadingDetail(true);
    fetch(`${getApiBase()}/api/gtfs/stops/${encodeURIComponent(stopId)}/detail`, { cache: "no-store" })
      .then(r => r.json())
      .then((d: StopDetail) => { setSelectedStop(d); setLoadingDetail(false); })
      .catch(() => setLoadingDetail(false));
  }, []);

  const totalPages = Math.ceil(total / PAGE_SIZE);

  const kpiAvgRoutes = stops.length > 0
    ? (stops.reduce((s, x) => s + x.routeCount, 0) / stops.length).toFixed(1)
    : "—";

  return (
    <div className="h-full flex flex-col overflow-hidden">

      {/* ── Header + Search ──────────────────────────────────── */}
      <div className="px-4 pt-3 pb-2 border-b border-border/30 shrink-0">
        <div className="flex items-center gap-2 mb-2">
          <MapPin className="w-4 h-4 text-primary" />
          <h1 className="text-base font-display font-bold">Fermate &amp; Linee</h1>
          <span className="text-[10px] text-muted-foreground">· 3.943 fermate · 120 linee · rete Ancona/Marche</span>
        </div>

        {/* KPI strip */}
        <div className="flex gap-3 flex-wrap mb-2">
          <KpiChip icon={<MapPin className="w-3.5 h-3.5 text-blue-400" />}
            label="Fermate totali" value="3.943" color="text-blue-400" />
          <KpiChip icon={<Bus className="w-3.5 h-3.5 text-green-400" />}
            label="Linee attive" value="120" color="text-green-400" />
          <KpiChip icon={<Layers className="w-3.5 h-3.5 text-orange-400" />}
            label="Corse/giorno" value="12.541" color="text-orange-400" />
          <KpiChip icon={<Route className="w-3.5 h-3.5 text-purple-400" />}
            label="Linee per fermata (top)" value={kpiAvgRoutes} color="text-purple-400" />
        </div>

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <input
            value={searchInput}
            onChange={e => setSearchInput(e.target.value)}
            placeholder="Cerca fermata per nome… (es. Piazza Cavour, Ospedale, Stazione)"
            className="w-full pl-8 pr-3 py-1.5 text-xs bg-muted/40 border border-border/40 rounded-xl focus:outline-none focus:ring-1 focus:ring-primary"
          />
          {searchInput && (
            <button onClick={() => { setSearchInput(""); setSearch(""); setPage(1); }}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground text-xs">×</button>
          )}
        </div>
      </div>

      {/* ── Body: list + detail ─────────────────────────────── */}
      <div className="flex-1 overflow-hidden flex">

        {/* Left: stop list */}
        <div className="w-[380px] shrink-0 border-r border-border/30 flex flex-col overflow-hidden">
          {/* Pagination controls */}
          <div className="px-3 py-1.5 border-b border-border/20 flex items-center justify-between text-[10px] text-muted-foreground shrink-0">
            <span>{loading ? "Caricamento…" : `${total.toLocaleString("it-IT")} fermate${search ? ` · "${search}"` : ""}`}</span>
            {totalPages > 1 && (
              <div className="flex items-center gap-1">
                <button disabled={page <= 1} onClick={() => setPage(p => p - 1)}
                  className="p-0.5 rounded hover:bg-muted/40 disabled:opacity-30 transition-colors">
                  <ChevronLeft className="w-3 h-3" />
                </button>
                <span>{page}/{totalPages}</span>
                <button disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}
                  className="p-0.5 rounded hover:bg-muted/40 disabled:opacity-30 transition-colors">
                  <ChevronRight className="w-3 h-3" />
                </button>
              </div>
            )}
          </div>

          <div className="flex-1 overflow-y-auto">
            {loading && (
              <div className="flex flex-col items-center gap-3 py-16 text-muted-foreground">
                <div className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                <p className="text-xs">Caricamento fermate…</p>
              </div>
            )}
            {!loading && stops.map((stop, i) => {
              const isSelected = selectedStop?.stop.stopId === stop.stopId;
              return (
                <motion.button key={stop.stopId}
                  initial={{ opacity: 0, x: -4 }} animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: Math.min(i * 0.008, 0.25) }}
                  onClick={() => { if (!isSelected) fetchDetail(stop.stopId); else setSelectedStop(null); }}
                  className={`w-full text-left px-3 py-2.5 border-b border-border/20 hover:bg-muted/20 transition-all ${
                    isSelected ? "bg-primary/5 border-l-2 border-l-primary" : ""
                  }`}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium truncate leading-tight">{stop.name}</p>
                      <p className="text-[10px] text-muted-foreground mt-0.5">
                        {stop.routeCount} {stop.routeCount === 1 ? "linea" : "linee"} · {stop.stopId}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-0.5 max-w-[130px] justify-end shrink-0">
                      {stop.routeIds.slice(0, 5).map(rid => (
                        <RouteBadge key={rid} id={rid} />
                      ))}
                      {stop.routeIds.length > 5 && (
                        <span className="text-[9px] text-muted-foreground self-center">+{stop.routeIds.length - 5}</span>
                      )}
                    </div>
                  </div>
                </motion.button>
              );
            })}
            {!loading && stops.length === 0 && (
              <div className="flex flex-col items-center gap-2 py-16 text-muted-foreground">
                <MapPin className="w-8 h-8 opacity-15" />
                <p className="text-xs">Nessuna fermata trovata</p>
              </div>
            )}
          </div>
        </div>

        {/* Right: detail */}
        <div className="flex-1 overflow-y-auto">
          <AnimatePresence mode="wait">
            {loadingDetail ? (
              <motion.div key="loading-detail" initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                className="h-full flex items-center justify-center">
                <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
              </motion.div>
            ) : selectedStop ? (
              <StopDetailPanel key={selectedStop.stop.stopId} detail={selectedStop} />
            ) : (
              <motion.div key="empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                className="h-full flex flex-col items-center justify-center gap-4 text-muted-foreground p-8">
                <MapPin className="w-14 h-14 opacity-10" />
                <div className="text-center max-w-sm">
                  <p className="font-semibold text-base">Seleziona una fermata</p>
                  <p className="text-sm mt-1 opacity-70">
                    Clicca su qualsiasi fermata per vedere le linee che la servono
                    e tutti gli orari di partenza.
                  </p>
                </div>
                <div className="grid grid-cols-2 gap-3 max-w-sm w-full">
                  <InfoCard icon="🚌" title="Fermata più servita" value="Piazza Cavour" sub="6 linee diverse" />
                  <InfoCard icon="📍" title="Fermate totali" value="3.943" sub="nella rete Ancona/Marche" />
                  <InfoCard icon="🔄" title="Corse giornaliere" value="12.541" sub="trip programmati" />
                  <InfoCard icon="🗓️" title="Calendario attivo" value="Gen–Dic 2026" sub="355 giorni coperti" />
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}

// ─── Stop Detail Panel ────────────────────────────────────────
function StopDetailPanel({ detail }: { detail: StopDetail }) {
  const { stop, routes } = detail;
  const [expandedRoute, setExpandedRoute] = useState<string | null>(null);

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
      className="p-5 space-y-4 max-w-2xl">

      {/* Stop header */}
      <div>
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center shrink-0">
            <MapPin className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h2 className="text-base font-bold leading-tight">{stop.name}</h2>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              ID {stop.stopId} · {stop.lat.toFixed(5)}, {stop.lon.toFixed(5)}
            </p>
          </div>
        </div>
      </div>

      {/* Route summary */}
      <div>
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
          {routes.length} {routes.length === 1 ? "linea serve" : "linee servono"} questa fermata
        </p>
        <div className="flex flex-wrap gap-1.5 mb-3">
          {routes.map(r => (
            <button key={r.routeId}
              onClick={() => setExpandedRoute(expandedRoute === r.routeId ? null : r.routeId)}
              className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 border text-xs font-medium transition-all hover:opacity-90"
              style={{
                backgroundColor: routeColor(r.color) + "20",
                borderColor: routeColor(r.color) + "40",
                color: routeColor(r.color),
              }}>
              <span className="font-bold">{r.shortName}</span>
              <span className="text-[10px] opacity-70">{r.departures.length} corse</span>
            </button>
          ))}
        </div>
      </div>

      {/* Expanded route detail */}
      <AnimatePresence>
        {expandedRoute && (() => {
          const r = routes.find(x => x.routeId === expandedRoute);
          if (!r) return null;
          const groups = groupDepartures(r.departures);
          return (
            <motion.div key={expandedRoute}
              initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="rounded-xl border overflow-hidden"
              style={{ borderColor: routeColor(r.color) + "30" }}>
              <div className="px-4 py-3 flex items-center gap-2"
                style={{ backgroundColor: routeColor(r.color) + "12" }}>
                <span className="text-sm font-black" style={{ color: routeColor(r.color) }}>{r.shortName}</span>
                <ArrowRight className="w-3.5 h-3.5 text-muted-foreground" />
                <span className="text-xs text-muted-foreground truncate">{r.longName}</span>
                <span className="ml-auto text-[10px] text-muted-foreground">{r.departures.length} partenze</span>
              </div>
              <div className="p-3 space-y-3">
                {Object.entries(groups).filter(([, times]) => times.length > 0).map(([band, times]) => (
                  <div key={band}>
                    <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">{band}</p>
                    <div className="flex flex-wrap gap-1">
                      {times.map(t => (
                        <span key={t} className="text-[11px] font-mono px-2 py-0.5 rounded-md bg-muted/40 border border-border/30">{t.slice(0, 5)}</span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </motion.div>
          );
        })()}
      </AnimatePresence>

      {/* All routes departure overview */}
      <div className="space-y-2">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
          <Clock className="w-3.5 h-3.5 inline mr-1" />
          Prossime partenze per fascia (clicca una linea per i dettagli)
        </p>
        {routes.map(r => {
          const color = routeColor(r.color);
          const earlyDeps = r.departures.filter(d => {
            const h = parseInt(d.split(":")[0]);
            return h >= 5 && h < 22;
          }).slice(0, 8);
          return (
            <div key={r.routeId}
              className="flex items-center gap-3 px-3 py-2 rounded-xl border border-border/30 bg-card/30 hover:bg-card/60 transition-colors cursor-pointer"
              onClick={() => setExpandedRoute(expandedRoute === r.routeId ? null : r.routeId)}>
              <span className="shrink-0 inline-flex items-center justify-center px-2 py-0.5 rounded text-[11px] font-bold text-white"
                style={{ backgroundColor: color }}>
                {r.shortName}
              </span>
              <div className="flex flex-wrap gap-1 flex-1 min-w-0">
                {earlyDeps.map(t => (
                  <span key={t} className="text-[10px] font-mono text-muted-foreground">{t.slice(0, 5)}</span>
                ))}
                {r.departures.length > 8 && (
                  <span className="text-[10px] text-muted-foreground/50">+{r.departures.length - 8}</span>
                )}
              </div>
              <ChevronRight className={`w-3 h-3 text-muted-foreground/30 shrink-0 transition-transform ${expandedRoute === r.routeId ? "rotate-90" : ""}`} />
            </div>
          );
        })}
      </div>

      {/* Map link */}
      <a href={`https://www.google.com/maps?q=${stop.lat},${stop.lon}`} target="_blank" rel="noopener noreferrer"
        className="flex items-center gap-2 text-xs text-primary hover:underline">
        <MapPin className="w-3.5 h-3.5" />
        Apri su Google Maps ({stop.lat.toFixed(4)}, {stop.lon.toFixed(4)})
      </a>
    </motion.div>
  );
}

// ─── Sub-components ───────────────────────────────────────────
function RouteBadge({ id }: { id: string }) {
  return (
    <span className="inline-flex items-center justify-center px-1.5 py-0.5 rounded text-[9px] font-bold bg-muted/60 border border-border/40 text-muted-foreground leading-none">
      {id}
    </span>
  );
}

function KpiChip({ icon, label, value, color }: { icon: React.ReactNode; label: string; value: string; color: string }) {
  return (
    <div className="flex items-center gap-1.5 bg-card/40 border border-border/30 rounded-lg px-2.5 py-1.5">
      {icon}
      <div>
        <p className={`text-sm font-bold leading-none ${color}`}>{value}</p>
        <p className="text-[9px] text-muted-foreground leading-tight mt-0.5">{label}</p>
      </div>
    </div>
  );
}

function InfoCard({ icon, title, value, sub }: { icon: string; title: string; value: string; sub: string }) {
  return (
    <div className="bg-card/30 border border-border/30 rounded-xl p-3">
      <div className="text-xl mb-1">{icon}</div>
      <p className="text-[10px] text-muted-foreground">{title}</p>
      <p className="text-sm font-bold mt-0.5">{value}</p>
      <p className="text-[10px] text-muted-foreground/70">{sub}</p>
    </div>
  );
}
