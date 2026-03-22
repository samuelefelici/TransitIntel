import React, { useState, useEffect, useMemo, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Network, GitFork, Clock, AlertTriangle, Search,
  ChevronRight, ArrowRight, BarChart3, Layers, Zap, Info, X,
  AlertCircle, CheckCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { getApiBase } from "@/lib/api";

// ─── Types ────────────────────────────────────────────────────
type DayType = "weekday" | "saturday" | "sunday" | "";

interface CollisionDetail { stopName: string; times: string[] }
interface OverlapPair {
  routeA: string; routeB: string;
  sharedStops: number; stopsA: number; stopsB: number;
  jaccardPct: number; minCoveragePct: number;
  sharedSample: string[];
  collisionCount: number;
  collisionDetails: CollisionDetail[];
}
interface HeadwayBand { id: string; label: string; avgMin: number; departures: number }
interface HeadwayStats {
  routeId: string; departures: number;
  avgHeadwayMin: number; maxHeadwayMin: number; minHeadwayMin: number;
  worstGapHour: number; bands: HeadwayBand[];
}
interface RouteRow {
  routeId: string; shortName: string; longName: string;
  color: string; textColor: string;
  tripsCount: number; uniqueStops: number;
  avgHeadway: number | null; maxHeadway: number | null;
  overlapCount: number; collisionCount: number;
}
interface Kpis {
  scheduleCollisions: number; routePairsWithCollisions: number;
  worstHeadway: number; irregularRoutes: number; totalPairs: number;
}
interface NetworkData {
  kpis: Kpis; overlaps: OverlapPair[];
  headways: HeadwayStats[]; routes: RouteRow[];
  filters: { day: string; hourFrom: number; hourTo: number };
}

type Tab = "overlaps" | "headways" | "routes";

// ─── Helpers ─────────────────────────────────────────────────
function overlapColors(pct: number) {
  if (pct >= 60) return { bar: "#ef4444", text: "text-red-400", bg: "bg-red-500/10 border-red-500/25" };
  if (pct >= 40) return { bar: "#f97316", text: "text-orange-400", bg: "bg-orange-500/10 border-orange-500/20" };
  if (pct >= 25) return { bar: "#eab308", text: "text-yellow-400", bg: "bg-yellow-500/10 border-yellow-500/20" };
  return { bar: "#94a3b8", text: "text-muted-foreground", bg: "bg-muted/30 border-border/30" };
}

function bandColor(min: number): string {
  if (min === 0) return "#94a3b8";
  if (min < 20) return "#22c55e";
  if (min < 40) return "#eab308";
  if (min < 80) return "#f97316";
  return "#ef4444";
}
function bandLabel(min: number): string {
  if (min === 0) return "No corse";
  if (min < 20) return "Ottimo";
  if (min < 40) return "Accettabile";
  if (min < 80) return "Lungo";
  return "Critico";
}

function RoutePill({ routeId, routes, size = "sm" }: { routeId: string; routes: RouteRow[]; size?: "sm" | "lg" }) {
  const r = routes.find(x => x.routeId === routeId);
  const color = r?.color && r.color !== "#6b7280" ? r.color : "#64748b";
  return (
    <span className={`inline-flex items-center justify-center rounded font-bold text-white shrink-0 ${size === "lg" ? "px-3 py-1 text-sm" : "px-2 py-0.5 text-[11px]"}`}
      style={{ backgroundColor: color }}>
      {r?.shortName ?? routeId}
    </span>
  );
}

const DAY_OPTS: { key: DayType; label: string; icon: string }[] = [
  { key: "",         label: "Tutti",    icon: "📅" },
  { key: "weekday",  label: "Feriale",  icon: "🏫" },
  { key: "saturday", label: "Sabato",   icon: "⛔" },
  { key: "sunday",   label: "Domenica", icon: "🌙" },
];

// ─── Main Page ────────────────────────────────────────────────
export default function Routes() {
  const [data, setData] = useState<NetworkData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("overlaps");
  const [selectedPair, setSelectedPair] = useState<OverlapPair | null>(null);
  const [search, setSearch] = useState("");
  const [sortRoutes, setSortRoutes] = useState<"collisionCount" | "tripsCount" | "uniqueStops" | "avgHeadway" | "overlapCount">("collisionCount");

  // Calendar filter
  const [dateFrom, setDateFrom] = useState("2026-03-01");
  const [dateTo, setDateTo] = useState("2026-03-31");
  const [dayType, setDayType] = useState<DayType>("weekday");

  // When a single day is selected, infer day type automatically from the date
  const isSingleDay = dateFrom === dateTo;
  const inferredDayType = useMemo<DayType>(() => {
    const d = new Date(dateFrom + "T12:00:00");
    const dow = d.getDay();
    if (dow === 0) return "sunday";
    if (dow === 6) return "saturday";
    return "weekday";
  }, [dateFrom]);
  const effectiveDayType: DayType = isSingleDay ? inferredDayType : dayType;

  const fetchData = useCallback(() => {
    setLoading(true);
    setSelectedPair(null);
    const params = new URLSearchParams();
    params.set("day", effectiveDayType);
    if (dateFrom) params.set("dateFrom", dateFrom.replace(/-/g, ""));
    if (dateTo)   params.set("dateTo",   dateTo.replace(/-/g, ""));
    fetch(`${getApiBase()}/api/gtfs/routes/network-analysis?${params}`, { cache: "no-store" })
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false); })
      .catch(() => { setError("Errore caricamento analisi"); setLoading(false); });
  }, [effectiveDayType, dateFrom, dateTo]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const filteredOverlaps = useMemo(() => {
    if (!data?.overlaps) return [];
    const q = search.toLowerCase();
    return data.overlaps.filter(p => {
      if (!q) return true;
      const ra = data.routes.find(r => r.routeId === p.routeA);
      const rb = data.routes.find(r => r.routeId === p.routeB);
      return [p.routeA, p.routeB, ra?.shortName, rb?.shortName].some(v => v?.toLowerCase().includes(q));
    });
  }, [data, search]);

  const filteredRoutes = useMemo(() => {
    if (!data?.routes) return [];
    const q = search.toLowerCase();
    return data.routes
      .filter(r => !q || r.shortName.toLowerCase().includes(q) || r.routeId.toLowerCase().includes(q))
      .sort((a, b) => {
        if (sortRoutes === "avgHeadway") return (b.avgHeadway ?? 0) - (a.avgHeadway ?? 0);
        if (sortRoutes === "overlapCount") return b.overlapCount - a.overlapCount;
        if (sortRoutes === "uniqueStops") return b.uniqueStops - a.uniqueStops;
        if (sortRoutes === "collisionCount") return b.collisionCount - a.collisionCount;
        return b.tripsCount - a.tripsCount;
      });
  }, [data, search, sortRoutes]);

  const routes = data?.routes ?? [];
  const kpis = data?.kpis;

  return (
    <div className="h-full flex flex-col overflow-hidden">

      {/* ── Filter bar ───────────────────────────────────────── */}
      <div className="flex items-center gap-2 px-3 py-1.5 bg-background/80 backdrop-blur-xl border-b border-border/30 shrink-0 flex-wrap">
        <Clock className="w-3 h-3 text-muted-foreground/70 shrink-0" />
        <span className="text-[10px] text-muted-foreground shrink-0">
          {isSingleDay ? "Giorno" : "Periodo"}
        </span>

        <input type="date" value={dateFrom} min="2026-01-11" max="2026-12-31"
          onChange={e => {
            const v = e.target.value;
            setDateFrom(v);
            // If currently a range and new from > to, clamp to
            if (v > dateTo) setDateTo(v);
          }}
          className="text-[11px] bg-background/60 border border-border/40 rounded-md px-2 py-0.5 text-foreground focus:outline-none focus:ring-1 focus:ring-primary cursor-pointer" />

        {/* Only show "to" date when not single-day — but user can always expand */}
        {isSingleDay ? (
          <button onClick={() => {
            // Expand by 30 days from dateFrom
            const d = new Date(dateFrom + "T12:00:00");
            d.setDate(d.getDate() + 30);
            const yyyy = d.getFullYear();
            const mm = String(d.getMonth() + 1).padStart(2, "0");
            const dd = String(d.getDate()).padStart(2, "0");
            const end = `${yyyy}-${mm}-${dd}`;
            setDateTo(end <= "2026-12-31" ? end : "2026-12-31");
          }}
            title="Espandi a intervallo mensile"
            className="text-[10px] text-muted-foreground/50 hover:text-muted-foreground border border-dashed border-border/30 rounded px-1.5 py-0.5 transition-colors">
            + range
          </button>
        ) : (
          <>
            <span className="text-[10px] text-muted-foreground/60">→</span>
            <input type="date" value={dateTo} min={dateFrom} max="2026-12-31"
              onChange={e => { if (e.target.value >= dateFrom) setDateTo(e.target.value); }}
              className="text-[11px] bg-background/60 border border-border/40 rounded-md px-2 py-0.5 text-foreground focus:outline-none focus:ring-1 focus:ring-primary cursor-pointer" />
          </>
        )}

        <div className="w-px h-3.5 bg-border/40 mx-0.5 shrink-0" />

        {isSingleDay ? (
          /* Read-only day badge derived from date */
          <span className="shrink-0 flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full border bg-primary/10 border-primary/30 text-primary">
            {DAY_OPTS.find(o => o.key === inferredDayType)?.icon}{" "}
            {DAY_OPTS.find(o => o.key === inferredDayType)?.label}
            <span className="text-[9px] text-muted-foreground ml-1">rilevato</span>
          </span>
        ) : (
          /* Range mode: show day-type toggle buttons */
          DAY_OPTS.map(opt => (
            <button key={opt.key} onClick={() => setDayType(opt.key)}
              className={`shrink-0 flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full border transition-all ${
                dayType === opt.key ? "bg-primary text-primary-foreground border-primary" : "border-border/40 text-muted-foreground hover:text-foreground hover:border-border"
              }`}>
              <span>{opt.icon}</span><span>{opt.label}</span>
            </button>
          ))
        )}

        {/* Search */}
        <div className="ml-auto relative w-40">
          <Search className="absolute left-2 top-1.5 w-3 h-3 text-muted-foreground" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Cerca linea…"
            className="w-full pl-6 pr-2 py-1 text-[11px] bg-muted/40 border border-border/40 rounded-lg focus:outline-none focus:ring-1 focus:ring-primary" />
        </div>
      </div>

      {/* ── Header ───────────────────────────────────────────── */}
      <div className="px-4 pt-3 pb-2 border-b border-border/30 shrink-0">
        <div className="flex items-center gap-2 mb-2">
          <Network className="w-4 h-4 text-primary" />
          <h1 className="text-base font-display font-bold">Diagnostica Rete</h1>
          <span className="text-[10px] text-muted-foreground">· Sovrapposizioni orario · Attese · Classifiche</span>
          {loading && <div className="ml-2 w-3.5 h-3.5 border-2 border-primary border-t-transparent rounded-full animate-spin" />}
        </div>

        {/* KPI strip */}
        {kpis && (
          <div className="flex gap-3 flex-wrap">
            <KpiChip icon={<AlertCircle className="w-3.5 h-3.5 text-red-400" />}
              label="Collisioni orario (±2min)" value={kpis.scheduleCollisions} color="text-red-400"
              hint="corse diverse, stessa fermata, stesso momento" />
            <KpiChip icon={<GitFork className="w-3.5 h-3.5 text-orange-400" />}
              label="Coppie con collisioni" value={kpis.routePairsWithCollisions} color="text-orange-400" />
            <KpiChip icon={<Clock className="w-3.5 h-3.5 text-yellow-400" />}
              label="Attesa max rilevata" value={`${kpis.worstHeadway}min`} color="text-yellow-400" />
            <KpiChip icon={<Zap className="w-3.5 h-3.5 text-blue-400" />}
              label="Linee con attese irregolari" value={kpis.irregularRoutes} color="text-blue-400" />
          </div>
        )}
      </div>

      {/* ── Tabs ─────────────────────────────────────────────── */}
      <div className="flex border-b border-border/30 shrink-0 bg-background/20">
        {([
          { key: "overlaps", label: "Collisioni orario", icon: <Layers className="w-3.5 h-3.5" />, badge: kpis?.routePairsWithCollisions },
          { key: "headways", label: "Attese per fascia", icon: <Clock className="w-3.5 h-3.5" />, badge: kpis?.irregularRoutes },
          { key: "routes",   label: "Tutte le linee",   icon: <BarChart3 className="w-3.5 h-3.5" /> },
        ] as { key: Tab; label: string; icon: React.ReactNode; badge?: number }[]).map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`flex items-center gap-1.5 px-4 py-2 text-xs font-medium border-b-2 transition-all ${
              tab === t.key ? "border-primary text-primary bg-primary/5" : "border-transparent text-muted-foreground hover:text-foreground hover:bg-muted/20"
            }`}>
            {t.icon}{t.label}
            {t.badge != null && t.badge > 0 && (
              <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-bold ${tab === t.key ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>{t.badge}</span>
            )}
          </button>
        ))}
      </div>

      {/* ── Content ──────────────────────────────────────────── */}
      <div className="flex-1 overflow-hidden flex">

        {/* ── Tab: Collisioni orario ─────────────────────────── */}
        {tab === "overlaps" && (
          <>
            {/* Left: list */}
            <div className="w-[360px] shrink-0 border-r border-border/30 flex flex-col overflow-hidden">
              <div className="px-3 py-1.5 border-b border-border/20 flex items-center justify-between shrink-0">
                <span className="text-[10px] text-muted-foreground">
                  {filteredOverlaps.length} coppie · ordinate per collisioni
                </span>
              </div>
              <div className="flex-1 overflow-y-auto">
                {loading && (
                  <div className="flex flex-col items-center gap-3 py-16 text-muted-foreground">
                    <div className="w-6 h-6 border-3 border-primary border-t-transparent rounded-full animate-spin" />
                    <p className="text-xs">Calcolo collisioni in corso…</p>
                  </div>
                )}
                {!loading && filteredOverlaps.length === 0 && (
                  <div className="flex flex-col items-center gap-2 py-16 text-muted-foreground">
                    <CheckCircle className="w-8 h-8 opacity-20 text-green-400" />
                    <p className="text-xs">Nessuna collisione trovata</p>
                    <p className="text-[10px] opacity-60">Prova ad allargare il range orario</p>
                  </div>
                )}
                {!loading && filteredOverlaps.map((pair, i) => {
                  const c = overlapColors(pair.minCoveragePct);
                  const isSelected = selectedPair?.routeA === pair.routeA && selectedPair?.routeB === pair.routeB;
                  const hasCollisions = (pair.collisionCount ?? 0) > 0;
                  return (
                    <motion.button key={`${pair.routeA}-${pair.routeB}`}
                      initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: Math.min(i * 0.015, 0.3) }}
                      onClick={() => setSelectedPair(isSelected ? null : pair)}
                      className={`w-full text-left p-3 border-b border-border/20 transition-all hover:bg-muted/20 ${isSelected ? "bg-primary/5 border-l-2 border-l-primary" : ""}`}>
                      {/* Route pills + collision badge */}
                      <div className="flex items-center gap-2 mb-2">
                        <RoutePill routeId={pair.routeA} routes={routes} />
                        <ArrowRight className="w-3 h-3 text-muted-foreground/40 shrink-0" />
                        <RoutePill routeId={pair.routeB} routes={routes} />
                        <div className="ml-auto flex items-center gap-1.5">
                          {hasCollisions ? (
                            <span className="text-xs font-bold text-red-400 tabular-nums">
                              {pair.collisionCount}× 💥
                            </span>
                          ) : (
                            <span className="text-[10px] text-muted-foreground/40">no coll.</span>
                          )}
                        </div>
                      </div>
                      {/* Stats row */}
                      <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
                        <span>{pair.sharedStops} fermate in comune</span>
                        <span className={`font-bold ${c.text}`}>{pair.minCoveragePct}% sovrapp.</span>
                      </div>
                      {/* Collision detail preview */}
                      {(pair.collisionDetails?.length ?? 0) > 0 && (
                        <div className="mt-1.5 space-y-0.5">
                          {pair.collisionDetails.slice(0, 2).map((d, di) => (
                            <div key={di} className="flex items-center gap-1.5 text-[10px]">
                              <span className="w-1.5 h-1.5 rounded-full bg-red-400 shrink-0" />
                              <span className="text-muted-foreground truncate">{d.stopName}</span>
                              <span className="text-red-400/80 font-mono shrink-0">{d.times.slice(0, 2).join(", ")}</span>
                            </div>
                          ))}
                          {pair.collisionDetails.length > 2 && (
                            <p className="text-[9px] text-muted-foreground/50 pl-3">+{pair.collisionDetails.length - 2} fermate…</p>
                          )}
                        </div>
                      )}
                      <ChevronRight className={`absolute right-3 top-3 w-3 h-3 transition-transform ${isSelected ? "rotate-90 text-primary" : "text-muted-foreground/20"}`} />
                    </motion.button>
                  );
                })}
              </div>
            </div>

            {/* Right: detail */}
            <div className="flex-1 overflow-y-auto">
              <AnimatePresence mode="wait">
                {selectedPair ? (
                  <OverlapDetail key={`${selectedPair.routeA}-${selectedPair.routeB}`} pair={selectedPair} routes={routes} />
                ) : (
                  <motion.div key="empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                    className="h-full flex flex-col items-center justify-center gap-4 text-muted-foreground p-8">
                    <GitFork className="w-14 h-14 opacity-10" />
                    <div className="text-center max-w-sm">
                      <p className="font-semibold text-base">Seleziona una coppia</p>
                      <p className="text-sm mt-1 opacity-70">
                        Una <strong>collisione orario</strong> avviene quando due bus di linee diverse passano
                        dalla stessa fermata entro 2 minuti l'uno dall'altro — lasciando poi lunghe attese in altre fasce.
                      </p>
                    </div>
                    <div className="bg-red-500/8 border border-red-500/15 rounded-xl p-3 max-w-sm text-xs text-muted-foreground">
                      <span className="text-red-400 font-semibold">💥 Collisione orario</span>: due corse di linee diverse
                      alla stessa fermata nello stesso momento — servizio doppio inutile, con buchi altrove.
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </>
        )}

        {/* ── Tab: Attese per fascia ─────────────────────────── */}
        {tab === "headways" && (
          <div className="flex-1 overflow-y-auto p-4">
            <div className="max-w-3xl mx-auto space-y-2">
              <div className="flex items-center gap-3 mb-4 flex-wrap">
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Info className="w-3.5 h-3.5" />
                  Quanto tempo aspetti il prossimo bus in ogni fascia oraria?
                </div>
                <div className="flex items-center gap-3 ml-auto">
                  {[{ c: "#22c55e", l: "<20min ottimo" }, { c: "#eab308", l: "20–40min ok" }, { c: "#f97316", l: "40–80min lungo" }, { c: "#ef4444", l: ">80min critico" }].map(x => (
                    <div key={x.l} className="flex items-center gap-1">
                      <div className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: x.c }} />
                      <span className="text-[10px] text-muted-foreground">{x.l}</span>
                    </div>
                  ))}
                </div>
              </div>

              {loading && (
                <div className="text-center py-16 text-muted-foreground text-sm">Caricamento…</div>
              )}

              {!loading && data?.headways.map((h, i) => {
                const r = routes.find(x => x.routeId === h.routeId);
                const color = r?.color && r.color !== "#6b7280" ? r.color : "#64748b";
                const activeBands = h.bands.filter(b => b.departures > 0);
                const worstBand = activeBands.reduce<HeadwayBand | null>((best, b) =>
                  b.avgMin > (best?.avgMin ?? 0) ? b : best, null);

                return (
                  <motion.div key={h.routeId}
                    initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: Math.min(i * 0.012, 0.4) }}
                    className="bg-card/40 border border-border/30 rounded-xl p-3 hover:bg-card/60 transition-colors">
                    <div className="flex items-start gap-3">
                      <span className="inline-flex items-center justify-center px-2 py-0.5 rounded text-[11px] font-bold text-white shrink-0 mt-0.5"
                        style={{ backgroundColor: color }}>
                        {r?.shortName ?? h.routeId}
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-2">
                          <span className="text-xs text-muted-foreground truncate">{r?.longName ?? h.routeId}</span>
                          <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">{h.departures} corse/giorno</span>
                        </div>
                        {/* Bands grid */}
                        <div className="grid grid-cols-5 gap-1.5">
                          {h.bands.map(band => {
                            const bc = bandColor(band.avgMin);
                            const bl = bandLabel(band.avgMin);
                            const isWorst = band.id === worstBand?.id && band.avgMin >= 40;
                            return (
                              <div key={band.id}
                                className={`rounded-lg p-2 border text-center ${isWorst ? "border-orange-500/40 bg-orange-500/8" : "border-border/20 bg-background/30"}`}>
                                <div className="text-[9px] text-muted-foreground/70 mb-1 leading-tight">{band.label}</div>
                                {band.departures > 0 ? (
                                  <>
                                    <div className="text-sm font-bold tabular-nums" style={{ color: bc }}>
                                      {band.avgMin}<span className="text-[9px] font-normal ml-0.5">min</span>
                                    </div>
                                    <div className="text-[9px] mt-0.5" style={{ color: bc }}>{bl}</div>
                                  </>
                                ) : (
                                  <div className="text-[10px] text-muted-foreground/30 mt-1">—</div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                        {/* Summary sentence */}
                        <div className="mt-1.5 text-[10px] text-muted-foreground">
                          {worstBand && worstBand.avgMin >= 40 ? (
                            <span>
                              ⚠️ Attesa più lunga nella fascia <strong>{worstBand.label}</strong>:{" "}
                              <span className="text-orange-400 font-bold">{worstBand.avgMin} min</span> in media
                            </span>
                          ) : activeBands.length > 0 ? (
                            <span className="text-green-400/80">✓ Frequenze accettabili su tutte le fasce</span>
                          ) : (
                            <span>Nessuna corsa nel periodo selezionato</span>
                          )}
                        </div>
                      </div>
                    </div>
                  </motion.div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── Tab: Tutte le linee ────────────────────────────── */}
        {tab === "routes" && (
          <div className="flex-1 overflow-hidden flex flex-col">
            <div className="px-4 py-2 border-b border-border/20 flex items-center gap-2 shrink-0">
              <span className="text-[10px] text-muted-foreground mr-1">Ordina per:</span>
              {([
                { key: "collisionCount", label: "Collisioni" },
                { key: "tripsCount",     label: "N° corse" },
                { key: "uniqueStops",    label: "Fermate" },
                { key: "avgHeadway",     label: "Attesa" },
                { key: "overlapCount",   label: "Sovrapposiz." },
              ] as { key: typeof sortRoutes; label: string }[]).map(s => (
                <button key={s.key} onClick={() => setSortRoutes(s.key)}
                  className={`text-[10px] px-2.5 py-1 rounded-full border transition-all ${sortRoutes === s.key ? "bg-primary text-primary-foreground border-primary" : "border-border/40 text-muted-foreground hover:border-border"}`}>
                  {s.label}
                </button>
              ))}
              <span className="ml-auto text-[10px] text-muted-foreground">{filteredRoutes.length} linee</span>
            </div>
            <div className="flex-1 overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-background/95 backdrop-blur-sm border-b border-border/30">
                  <tr className="text-muted-foreground text-[10px] uppercase tracking-wide">
                    <th className="text-left px-4 py-2">Linea</th>
                    <th className="text-left px-4 py-2 hidden lg:table-cell">Percorso</th>
                    <th className="text-right px-4 py-2">Corse</th>
                    <th className="text-right px-4 py-2">Fermate</th>
                    <th className="text-right px-4 py-2">Attesa media</th>
                    <th className="text-right px-4 py-2 text-red-400">Collisioni</th>
                    <th className="text-right px-4 py-2">Segnali</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRoutes.map((r, i) => {
                    const color = r.color && r.color !== "#6b7280" ? r.color : "#64748b";
                    const flags: { label: string; style: string }[] = [];
                    if (r.collisionCount >= 5) flags.push({ label: `${r.collisionCount} collisioni`, style: "bg-red-500/15 text-red-400" });
                    else if (r.collisionCount > 0) flags.push({ label: `${r.collisionCount} collisioni`, style: "bg-orange-500/15 text-orange-400" });
                    if ((r.avgHeadway ?? 0) >= 60) flags.push({ label: "attesa lunga", style: "bg-yellow-500/15 text-yellow-400" });
                    return (
                      <motion.tr key={r.routeId}
                        initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                        transition={{ delay: Math.min(i * 0.008, 0.3) }}
                        className="border-b border-border/30 hover:bg-muted/20 transition-colors">
                        <td className="px-4 py-2.5">
                          <span className="inline-flex items-center justify-center px-2 py-0.5 rounded text-[11px] font-bold text-white" style={{ backgroundColor: color }}>
                            {r.shortName}
                          </span>
                        </td>
                        <td className="px-4 py-2.5 hidden lg:table-cell text-muted-foreground max-w-[180px] truncate" title={r.longName}>{r.longName || "—"}</td>
                        <td className="px-4 py-2.5 text-right font-mono">{r.tripsCount}</td>
                        <td className="px-4 py-2.5 text-right font-mono">{r.uniqueStops}</td>
                        <td className="px-4 py-2.5 text-right font-mono font-bold"
                          style={{ color: r.avgHeadway ? bandColor(r.avgHeadway) : undefined }}>
                          {r.avgHeadway != null ? `${r.avgHeadway}min` : "—"}
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          {r.collisionCount > 0 ? (
                            <span className={`font-mono font-bold ${r.collisionCount >= 5 ? "text-red-400" : "text-orange-400"}`}>
                              {r.collisionCount}×
                            </span>
                          ) : <span className="text-muted-foreground/30">—</span>}
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          <div className="flex items-center justify-end gap-1 flex-wrap">
                            {flags.slice(0, 2).map(f => (
                              <span key={f.label} className={`text-[9px] px-1.5 py-0.5 rounded-full font-medium ${f.style}`}>{f.label}</span>
                            ))}
                          </div>
                        </td>
                      </motion.tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Overlap detail panel ─────────────────────────────────────
function OverlapDetail({ pair, routes }: { pair: OverlapPair; routes: RouteRow[] }) {
  const ra = routes.find(r => r.routeId === pair.routeA);
  const rb = routes.find(r => r.routeId === pair.routeB);
  const colorA = ra?.color && ra.color !== "#6b7280" ? ra.color : "#64748b";
  const colorB = rb?.color && rb.color !== "#6b7280" ? rb.color : "#64748b";

  const recommendation = pair.collisionCount >= 10
    ? `Le linee ${ra?.shortName} e ${rb?.shortName} generano ${pair.collisionCount} sovrapposizioni di orario. I passeggeri si trovano con due bus in arrivo quasi contemporaneamente — poi nessuno per un lungo periodo. Valuta una sfasatura degli orari di almeno 5-10 minuti, oppure una riduzione delle corse nei tratti sovrapposti.`
    : pair.collisionCount > 0
    ? `${pair.collisionCount} momenti in cui entrambe le linee passano dalla stessa fermata in contemporanea. Considera una lieve sfasatura degli orari per distribuire meglio il servizio.`
    : `Nessuna collisione oraria rilevata nel periodo selezionato — le corse sono ben distribuite nel tempo, nonostante la sovrapposizione di percorso (${pair.minCoveragePct}% fermate in comune).`;

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
      className="p-5 h-full overflow-y-auto space-y-4">

      {/* Header */}
      <div className="flex items-center gap-3 flex-wrap">
        <RoutePill routeId={pair.routeA} routes={routes} size="lg" />
        <ArrowRight className="w-4 h-4 text-muted-foreground" />
        <RoutePill routeId={pair.routeB} routes={routes} size="lg" />
        <div className="ml-auto flex items-center gap-3">
          {pair.collisionCount > 0 ? (
            <div className="flex items-center gap-1.5 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-1.5">
              <span className="text-xl font-black text-red-400 tabular-nums">{pair.collisionCount}</span>
              <div className="text-[10px] text-muted-foreground leading-tight">collisioni<br />orario</div>
            </div>
          ) : (
            <div className="flex items-center gap-1.5 bg-green-500/10 border border-green-500/20 rounded-lg px-3 py-1.5">
              <CheckCircle className="w-4 h-4 text-green-400" />
              <span className="text-xs text-green-400">Nessuna collisione</span>
            </div>
          )}
          <div className="flex items-center gap-1.5 bg-muted/40 border border-border/30 rounded-lg px-3 py-1.5">
            <span className="text-lg font-black text-muted-foreground tabular-nums">{pair.minCoveragePct}%</span>
            <div className="text-[10px] text-muted-foreground leading-tight">fermate<br />in comune</div>
          </div>
        </div>
      </div>

      {/* Route names */}
      {(ra?.longName || rb?.longName) && (
        <div className="text-[11px] text-muted-foreground space-y-0.5">
          {ra?.longName && <div><strong style={{ color: colorA }}>{ra.shortName}</strong>: {ra.longName}</div>}
          {rb?.longName && <div><strong style={{ color: colorB }}>{rb.shortName}</strong>: {rb.longName}</div>}
        </div>
      )}

      {/* Collision details */}
      {pair.collisionDetails.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
            💥 Fermate con collisioni orario (±2min)
          </p>
          <div className="space-y-1.5">
            {pair.collisionDetails.map((d, i) => (
              <div key={i} className="flex items-center gap-3 bg-red-500/8 border border-red-500/15 rounded-xl px-3 py-2">
                <div className="w-2 h-2 rounded-full bg-red-400 shrink-0" />
                <span className="text-xs flex-1 font-medium">{d.stopName}</span>
                <div className="flex items-center gap-1.5">
                  {d.times.map(t => (
                    <span key={t} className="text-[11px] font-mono font-bold text-red-300 bg-red-500/15 rounded px-1.5 py-0.5">{t}</span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Shared stops sample */}
      <div>
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
          Fermate in comune ({pair.sharedStops} totali)
        </p>
        <div className="flex flex-wrap gap-1.5">
          {pair.sharedSample.map((name, i) => (
            <span key={i} className="text-[11px] bg-muted/50 border border-border/40 rounded-lg px-2 py-1">{name}</span>
          ))}
          {pair.sharedStops > pair.sharedSample.length && (
            <span className="text-[11px] text-muted-foreground px-2 py-1">+ altri {pair.sharedStops - pair.sharedSample.length}</span>
          )}
        </div>
      </div>

      {/* Visual bar */}
      <div>
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Composizione percorsi</p>
        <div className="space-y-2">
          {([{ route: ra, color: colorA, stops: pair.stopsA }, { route: rb, color: colorB, stops: pair.stopsB }]).map((item, idx) => (
            <div key={idx}>
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] font-medium" style={{ color: item.color }}>{item.route?.shortName} ({item.stops} fermate)</span>
                <span className="text-[10px] text-muted-foreground">
                  {pair.sharedStops} condivise · {item.stops - pair.sharedStops} esclusive
                </span>
              </div>
              <div className="h-2.5 bg-muted/30 rounded-full overflow-hidden flex">
                <div className="h-full" style={{ width: `${Math.round(pair.sharedStops / item.stops * 100)}%`, backgroundColor: item.color }} />
                <div className="h-full flex-1" style={{ backgroundColor: item.color + "22" }} />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Recommendation */}
      <div className={`rounded-xl p-4 border ${pair.collisionCount > 0 ? "bg-red-500/8 border-red-500/20" : "bg-green-500/8 border-green-500/20"}`}>
        <div className="flex items-start gap-2">
          <Info className={`w-4 h-4 mt-0.5 shrink-0 ${pair.collisionCount > 0 ? "text-red-400" : "text-green-400"}`} />
          <div>
            <p className={`text-xs font-semibold mb-1 ${pair.collisionCount > 0 ? "text-red-400" : "text-green-400"}`}>
              Raccomandazione
            </p>
            <p className="text-xs text-muted-foreground leading-relaxed">{recommendation}</p>
          </div>
        </div>
      </div>

      {/* Stats footer */}
      <div className="grid grid-cols-3 gap-2">
        <StatBox label="Fermate condivise" value={pair.sharedStops} unit="fermate" />
        <StatBox label="Jaccard similarity" value={`${pair.jaccardPct}%`} unit="dell'unione" />
        <StatBox label="Copertura minima" value={`${pair.minCoveragePct}%`} unit="linea più corta" />
      </div>
    </motion.div>
  );
}

// ─── Sub-components ───────────────────────────────────────────
function KpiChip({ icon, label, value, color, hint }: {
  icon: React.ReactNode; label: string; value: string | number; color: string; hint?: string;
}) {
  return (
    <div className="flex items-center gap-1.5 bg-card/40 border border-border/30 rounded-lg px-2.5 py-1.5" title={hint}>
      {icon}
      <div>
        <p className={`text-sm font-bold leading-none ${color}`}>{value}</p>
        <p className="text-[9px] text-muted-foreground leading-tight mt-0.5">{label}</p>
      </div>
    </div>
  );
}

function StatBox({ label, value, unit }: { label: string; value: string | number; unit?: string }) {
  return (
    <div className="bg-card/30 border border-border/30 rounded-xl p-3">
      <p className="text-[10px] text-muted-foreground">{label}</p>
      <p className="text-base font-bold mt-0.5">{value}</p>
      {unit && <p className="text-[10px] text-muted-foreground">{unit}</p>}
    </div>
  );
}
