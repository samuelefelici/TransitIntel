/**
 * Step 1 — Abbinamento Vetture
 *
 * Seleziona data di esercizio, linee GTFS e tipo vettura per linea.
 * Consente di personalizzare il tipo vettura per singola corsa.
 * Salva il VehicleAssignment e procede allo step Ottimizzazione.
 */
import React, { useState, useEffect, useCallback, useMemo } from "react";
import { motion } from "framer-motion";
import {
  Bus, Calendar, ChevronRight, Loader2, Search, ArrowLeft, ArrowRight,
  CheckSquare, Square, Lock, Unlock, ChevronDown, ChevronUp, X, AlertTriangle,
} from "lucide-react";
import { getApiBase } from "@/lib/api";
import type { GtfsSelection, VehicleAssignment } from "@/pages/fucina";
import type { RouteItem, VehicleType, ServiceCategory, TripInfo } from "@/pages/optimizer-route/types";
import { CATEGORY_COLORS, ymdToIso, ymdToDisplay } from "@/pages/optimizer-route/constants.tsx";

interface Props {
  gtfsSelection: GtfsSelection;
  initial?: VehicleAssignment;
  /** Se valorizzato (progetto agganciato a un'UDP), mostra SOLO queste linee. */
  allowedRouteIds?: string[] | null;
  /** Nomi/short-name delle linee UDP: match di fallback quando il feed usa
   *  route_id diversi (es. GTFS importato) anziché ps_routes.id. */
  allowedRouteNames?: string[] | null;
  /** Dettaglio UDP: se presente, la validità è definita dall'UDP → niente scelta data. */
  udpInfo?: {
    name?: string; dayTypeName?: string | null; dayTypeColor?: string | null;
    categoryName?: string | null; categoryColor?: string | null;
    tripCount?: number; dayCount?: number; representativeDates?: string[];
  } | null;
  onBack: () => void;
  onComplete: (assignment: VehicleAssignment) => void;
}

export default function VehicleAssignmentStep({ gtfsSelection, initial, allowedRouteIds, allowedRouteNames, udpInfo, onBack, onComplete }: Props) {
  const fromUdp = !!udpInfo;
  /* ── Date state ── */
  const [availableDates, setAvailableDates] = useState<{ date: string; services: number }[]>([]);
  const [datesMode, setDatesMode] = useState<"calendar" | "calendar_dates" | null>(null);
  const [dateRange, setDateRange] = useState<{ min: string; max: string } | null>(null);
  const [selectedDate, setSelectedDate] = useState<string>(initial?.selectedDate || "");
  const [loadingDates, setLoadingDates] = useState(true);

  /* ── Routes state ── */
  const [allRoutes, setAllRoutes] = useState<RouteItem[]>([]);
  const [loadingRoutes, setLoadingRoutes] = useState(true);
  const [selectedRoutes, setSelectedRoutes] = useState<Map<string, VehicleType>>(
    initial?.selectedRoutes ?? new Map(),
  );
  const [forcedRoutes, setForcedRoutes] = useState<Set<string>>(initial?.forcedRoutes ?? new Set());
  const [tripVehicleOverrides, setTripVehicleOverrides] = useState<Map<string, VehicleType>>(
    initial?.tripVehicleOverrides ?? new Map(),
  );
  const [expandedRouteTrips, setExpandedRouteTrips] = useState<Set<string>>(new Set());
  const [routeTrips, setRouteTrips] = useState<Map<string, TripInfo[]>>(new Map());
  const [loadingTrips, setLoadingTrips] = useState<Set<string>>(new Set());
  const [routeSearch, setRouteSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<ServiceCategory | "all">("all");
  /** Incrementato dal pulsante "Ricarica" per rieseguire il fetch di date+linee. */
  const [reloadKey, setReloadKey] = useState(0);

  /* ── Load dates + routes on mount (e su "Ricarica") ── */
  useEffect(() => {
    setLoadingDates(true);
    setLoadingRoutes(true);
    const base = getApiBase();
    // Pinpoint sul feed scelto nello step precedente (se presente),
    // altrimenti il backend usa il feed "attivo" del tenant.
    const fid = gtfsSelection.tempFeedId ? `?feedId=${encodeURIComponent(gtfsSelection.tempFeedId)}` : "";
    Promise.all([
      fetch(`${base}/api/service-program/dates${fid}`).then(r => r.json()).catch(() => null),
      fetch(`${base}/api/service-program/routes${fid}`).then(r => r.json()).catch(() => null),
    ]).then(([datesData, routesData]) => {
      if (datesData) {
        // Da UDP: la data di esercizio è quella RAPPRESENTATIVA dell'unità (es. la
        // domenica festiva), così le corse mostrate sono quelle della UDP e non un
        // giorno qualsiasi del feed. La data UDP ha priorità sul default del feed.
        const repRaw = fromUdp ? udpInfo?.representativeDates?.[0] : undefined;
        const udpDate = repRaw ? (repRaw.includes("-") ? repRaw : ymdToIso(repRaw)) : "";
        if (datesData.mode === "calendar") {
          setDatesMode("calendar");
          const minD = ymdToIso(datesData.minDate);
          const maxD = ymdToIso(datesData.maxDate);
          setDateRange({ min: minD, max: maxD });
          if (!initial?.selectedDate) {
            if (udpDate) setSelectedDate(udpDate);
            else {
              const today = new Date().toISOString().slice(0, 10);
              setSelectedDate(today >= minD && today <= maxD ? today : minD);
            }
          }
        } else {
          setDatesMode("calendar_dates");
          setAvailableDates(datesData.dates || []);
          if (!initial?.selectedDate) {
            if (udpDate) setSelectedDate(udpDate);
            else {
              const best = (datesData.dates || []).sort((a: any, b: any) => b.services - a.services)[0];
              if (best) setSelectedDate(ymdToIso(best.date));
            }
          }
        }
      }
      if (routesData) {
        const feedRoutes: RouteItem[] = routesData.routes || [];
        let routes = feedRoutes;
        // Progetto agganciato a un'UDP → restringi alle SOLE linee dell'unità.
        // Match per route_id (feed materializzato dal PS) OPPURE per nome/short-name
        // (feed importato con route_id reali diversi da ps_routes.id). Così si vedono
        // solo le poche linee della UDP, non tutta la rete.
        if (fromUdp && ((allowedRouteIds?.length ?? 0) > 0 || (allowedRouteNames?.length ?? 0) > 0)) {
          const allowId = new Set(allowedRouteIds ?? []);
          const allowName = new Set((allowedRouteNames ?? []).map((n) => n.trim().toLowerCase()));
          const scoped = feedRoutes.filter(
            (r) => allowId.has(r.routeId) || allowName.has((r.name ?? "").trim().toLowerCase()),
          );
          // Se qualcosa combacia usiamo il sottoinsieme; se nulla combacia
          // lasciamo l'intero feed (il feed potrebbe essere già scoped sulla UDP).
          if (scoped.length > 0) routes = scoped;
        }
        // Pre-seleziona tutte le linee mostrate quando si parte da un'UDP.
        if (fromUdp && (!initial?.selectedRoutes || initial.selectedRoutes.size === 0)) {
          setSelectedRoutes(new Map(routes.map((r) => [r.routeId, "12m" as VehicleType])));
        }
        setAllRoutes(routes);
      }
      setLoadingDates(false);
      setLoadingRoutes(false);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadKey]);

  /* ── Da UDP: la validità definisce la data → auto-selezione data rappresentativa ── */
  useEffect(() => {
    if (!fromUdp || selectedDate) return;
    const rep = udpInfo?.representativeDates?.[0];
    if (rep) setSelectedDate(rep.includes("-") ? rep : ymdToIso(rep));
  }, [fromUdp, udpInfo, selectedDate]);

  /* ── Derived ── */
  const filteredRoutes = useMemo(() => {
    let list = allRoutes;
    if (categoryFilter !== "all") list = list.filter(r => r.category === categoryFilter);
    if (routeSearch.trim()) {
      const q = routeSearch.toLowerCase();
      list = list.filter(r => r.name.toLowerCase().includes(q) || r.routeId.toLowerCase().includes(q) || (r.longName?.toLowerCase().includes(q) ?? false));
    }
    return list;
  }, [allRoutes, routeSearch, categoryFilter]);

  const urbanCount = useMemo(() => allRoutes.filter(r => r.category === "urbano").length, [allRoutes]);
  const suburbanCount = useMemo(() => allRoutes.filter(r => r.category === "extraurbano").length, [allRoutes]);

  /* ── Route handlers ── */
  const toggleRoute = (routeId: string) => {
    setSelectedRoutes(prev => { const n = new Map(prev); if (n.has(routeId)) n.delete(routeId); else n.set(routeId, "12m"); return n; });
    setForcedRoutes(prev => { const n = new Set(prev); n.delete(routeId); return n; });
  };
  const setRouteVehicle = (routeId: string, vt: VehicleType) => {
    setSelectedRoutes(prev => { const n = new Map(prev); n.set(routeId, vt); return n; });
    const trips = routeTrips.get(routeId);
    if (trips) setTripVehicleOverrides(prev => { const n = new Map(prev); for (const tr of trips) n.delete(tr.tripId); return n; });
  };
  const toggleForced = (routeId: string) => {
    setForcedRoutes(prev => { const n = new Set(prev); if (n.has(routeId)) n.delete(routeId); else n.add(routeId); return n; });
  };
  const selectAllVisible = () => { const n = new Map(selectedRoutes); for (const r of filteredRoutes) if (!n.has(r.routeId)) n.set(r.routeId, "12m"); setSelectedRoutes(n); };
  const deselectAllVisible = () => {
    const ids = new Set(filteredRoutes.map(r => r.routeId));
    setSelectedRoutes(prev => { const n = new Map(prev); for (const id of ids) n.delete(id); return n; });
  };

  const toggleRouteTrips = useCallback(async (routeId: string) => {
    setExpandedRouteTrips(prev => { const n = new Set(prev); if (n.has(routeId)) n.delete(routeId); else n.add(routeId); return n; });
    if (!routeTrips.has(routeId) && selectedDate) {
      setLoadingTrips(prev => new Set(prev).add(routeId));
      try {
        const fid = gtfsSelection.tempFeedId ? `&feedId=${encodeURIComponent(gtfsSelection.tempFeedId)}` : "";
        const resp = await fetch(`${getApiBase()}/api/service-program/trips?date=${selectedDate}&routeIds=${routeId}${fid}`);
        if (resp.ok) { const data = await resp.json(); setRouteTrips(prev => new Map(prev).set(routeId, data.trips || [])); }
      } catch {}
      finally { setLoadingTrips(prev => { const n = new Set(prev); n.delete(routeId); return n; }); }
    }
  }, [routeTrips, selectedDate]);

  const setTripVehicle = useCallback((tripId: string, vt: VehicleType) => {
    setTripVehicleOverrides(prev => { const n = new Map(prev); n.set(tripId, vt); return n; });
  }, []);

  const canProceed = selectedDate && selectedRoutes.size > 0;

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Sub-header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-orange-500/10 bg-orange-950/10 shrink-0">
        <div className="flex items-center gap-2">
          <Bus className="w-3.5 h-3.5 text-orange-400/60" />
          <span className="text-[11px] text-orange-300/60 font-medium">Abbinamento Vetture</span>
          <span className="text-[10px] text-orange-400/30 font-mono px-1.5 py-0.5 bg-orange-500/5 rounded border border-orange-500/10">
            {gtfsSelection.label}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={onBack} className="flex items-center gap-1.5 text-[11px] text-orange-300/50 hover:text-orange-300 transition-colors px-2 py-1 rounded-lg hover:bg-orange-500/8">
            <ArrowLeft className="w-3.5 h-3.5" /> Indietro
          </button>
          <button
            onClick={() => canProceed && onComplete({ selectedDate, selectedRoutes, forcedRoutes, tripVehicleOverrides })}
            disabled={!canProceed}
            className="flex items-center gap-1.5 text-[11px] text-black font-semibold px-3 py-1.5 rounded-lg bg-gradient-to-r from-orange-400 to-amber-400 disabled:opacity-40 disabled:cursor-not-allowed hover:shadow-[0_0_12px_rgba(251,146,60,0.3)] transition-shadow"
          >
            Avanti ({selectedRoutes.size} linee) <ChevronRight className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4 max-w-5xl mx-auto w-full">
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">

          {/* ── 1. Validità ── */}
          {fromUdp ? (
            /* Da UDP: la validità è già definita dall'unità di programmazione → niente scelta data */
            <section className="bg-card/40 border border-indigo-500/30 rounded-xl p-4 space-y-2">
              <h3 className="text-sm font-semibold flex items-center gap-2 text-foreground">
                <div className="w-5 h-5 rounded-full bg-indigo-500/20 border border-indigo-500/40 flex items-center justify-center text-[10px] font-bold text-indigo-300">1</div>
                <Calendar className="w-4 h-4 text-indigo-400/60" />
                Validità (UDP)
              </h3>
              <div className="text-sm font-medium text-foreground">{udpInfo?.name ?? "Unità di programmazione"}</div>
              <div className="flex flex-wrap gap-1.5 text-[11px]">
                {udpInfo?.dayTypeName && (
                  <span className="px-2 py-0.5 rounded-full border" style={{ borderColor: (udpInfo.dayTypeColor || "#6366f1") + "66", color: udpInfo.dayTypeColor || "#a5b4fc" }}>
                    {udpInfo.dayTypeName}
                  </span>
                )}
                {udpInfo?.categoryName && (
                  <span className="px-2 py-0.5 rounded-full border" style={{ borderColor: (udpInfo.categoryColor || "#64748b") + "66", color: udpInfo.categoryColor || "#94a3b8" }}>
                    {udpInfo.categoryName}
                  </span>
                )}
                <span className="px-2 py-0.5 rounded-full bg-muted/40 text-muted-foreground">{udpInfo?.tripCount ?? 0} corse</span>
                <span className="px-2 py-0.5 rounded-full bg-muted/40 text-muted-foreground">{udpInfo?.dayCount ?? 0} giorni</span>
              </div>
              {udpInfo?.representativeDates && udpInfo.representativeDates.length > 0 && (
                <p className="text-[11px] text-muted-foreground">
                  Giorni rappresentativi: {udpInfo.representativeDates.slice(0, 5).map((d) => {
                    const iso = d.includes("-") ? d : ymdToIso(d);
                    return new Date(iso + "T12:00:00").toLocaleDateString("it-IT", { day: "2-digit", month: "2-digit" });
                  }).join(", ")}{udpInfo.representativeDates.length > 5 ? "…" : ""}
                </p>
              )}
              <p className="text-[10px] text-muted-foreground/70">
                La data di esercizio non va scelta: è determinata dalla validità dell'UDP.
              </p>
            </section>
          ) : (
            <section className="bg-card/40 border border-border/30 rounded-xl p-4 space-y-3">
              <h3 className="text-sm font-semibold flex items-center gap-2 text-foreground">
                <div className="w-5 h-5 rounded-full bg-orange-500/20 border border-orange-500/40 flex items-center justify-center text-[10px] font-bold text-orange-300">1</div>
                <Calendar className="w-4 h-4 text-orange-400/60" />
                Data di esercizio
              </h3>
              {loadingDates ? (
                <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
                  <Loader2 className="w-3 h-3 animate-spin text-orange-400" /> Caricamento date…
                </div>
              ) : datesMode === "calendar_dates" && availableDates.length > 0 ? (
                <select value={selectedDate} onChange={e => setSelectedDate(e.target.value)}
                  className="w-full bg-background border border-border/50 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-orange-500/50">
                  <option value="">— Seleziona data —</option>
                  {availableDates.map(d => {
                    const iso = ymdToIso(d.date);
                    const day = new Date(iso + "T12:00:00").toLocaleDateString("it-IT", { weekday: "short" });
                    return <option key={d.date} value={iso}>{ymdToDisplay(d.date)} ({day}) — {d.services} servizi</option>;
                  })}
                </select>
              ) : (
                <input type="date" value={selectedDate} onChange={e => setSelectedDate(e.target.value)}
                  min={dateRange?.min} max={dateRange?.max}
                  className="w-full bg-background border border-border/50 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-orange-500/50" />
              )}
              {selectedDate && (
                <p className="text-xs text-muted-foreground">
                  📅 <strong>{new Date(selectedDate + "T12:00:00").toLocaleDateString("it-IT", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}</strong>
                </p>
              )}
            </section>
          )}

          {/* ── 2. Linee + Vetture ── */}
          <section className="bg-card/40 border border-border/30 rounded-xl p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold flex items-center gap-2 text-foreground">
                <div className="w-5 h-5 rounded-full bg-orange-500/20 border border-orange-500/40 flex items-center justify-center text-[10px] font-bold text-orange-300">2</div>
                <Bus className="w-4 h-4 text-orange-400/60" />
                Abbina linee e tipo vettura
              </h3>
              <div className="flex gap-2 text-[10px]">
                <button onClick={selectAllVisible} className="text-orange-400 hover:underline">Sel. visibili</button>
                <button onClick={deselectAllVisible} className="text-muted-foreground hover:underline">Desel. visibili</button>
                <button onClick={() => { setSelectedRoutes(new Map()); setForcedRoutes(new Set()); setTripVehicleOverrides(new Map()); }} className="text-red-400 hover:underline">Togli tutte</button>
              </div>
            </div>

            {/* Filters */}
            <div className="flex flex-col sm:flex-row gap-2">
              <div className="flex gap-1 shrink-0 flex-wrap">
                {(["all", "urbano", "extraurbano"] as const).map(cat => (
                  <button key={cat} onClick={() => setCategoryFilter(cat)}
                    className={`px-2.5 py-1 text-[11px] rounded-lg transition-colors ${categoryFilter === cat ? "bg-orange-500/15 text-orange-300 border border-orange-500/30" : "bg-background/50 text-muted-foreground hover:bg-muted/40 border border-transparent"}`}>
                    {cat === "all" ? `Tutte (${allRoutes.length})` : cat === "urbano" ? `🏙 Urb. (${urbanCount})` : `🛣 Extra (${suburbanCount})`}
                  </button>
                ))}
              </div>
              <div className="relative flex-1">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                <input value={routeSearch} onChange={e => setRouteSearch(e.target.value)} placeholder="Cerca linea…"
                  className="w-full pl-8 pr-3 py-1.5 text-sm bg-background border border-border/50 rounded-lg focus:outline-none focus:border-orange-500/50" />
              </div>
              {selectedRoutes.size > 0 && (
                <div className="flex items-center gap-1.5 shrink-0">
                  <span className="text-[10px] text-muted-foreground whitespace-nowrap">Assegna a tutte:</span>
                  <select defaultValue=""
                    onChange={e => {
                      const vt = e.target.value as VehicleType;
                      if (!vt) return;
                      setSelectedRoutes(prev => { const n = new Map(prev); for (const [id] of n) n.set(id, vt); return n; });
                      e.target.value = "";
                    }}
                    className="text-xs bg-background border border-border/50 rounded-lg px-1.5 py-1 cursor-pointer">
                    <option value="">— Tipo —</option>
                    <option value="autosnodato">Autosnodato</option>
                    <option value="12m">12 metri</option>
                    <option value="10m">10 metri</option>
                    <option value="pollicino">Pollicino</option>
                  </select>
                </div>
              )}
            </div>

            {loadingRoutes ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground py-4">
                <Loader2 className="w-3 h-3 animate-spin text-orange-400" /> Caricamento linee…
              </div>
            ) : allRoutes.length === 0 ? (
              <div className="text-xs text-muted-foreground bg-background/40 border border-border/30 rounded-lg p-5 text-center space-y-2">
                <p>Nessuna linea trovata nel feed di questa unità. Il feed potrebbe non essere ancora pronto (materializzazione in corso).</p>
                <button onClick={() => setReloadKey(k => k + 1)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-orange-600/90 hover:bg-orange-500 text-white text-[11px] font-medium">
                  <Loader2 className="w-3 h-3" /> Ricarica
                </button>
              </div>
            ) : (
              <>
                <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                  <span>{selectedRoutes.size} di {allRoutes.length} linee selezionate</span>
                  {forcedRoutes.size > 0 && <span className="text-amber-400"><Lock className="w-2.5 h-2.5 inline" /> {forcedRoutes.size} forzate</span>}
                  <span className="text-muted-foreground/40">🔒 solo quel mezzo · 🔓 flessibile (±1 taglia)</span>
                </div>
                {/* Alert: selezione parziale delle linee della UDP */}
                {fromUdp && allRoutes.length > 0 && selectedRoutes.size < allRoutes.length && (
                  <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200 flex items-start gap-2">
                    <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                    <span>
                      <strong>Attenzione:</strong> hai lasciato fuori {allRoutes.length - selectedRoutes.size} di {allRoutes.length} linee di questa UDP.
                      Le loro corse <strong>non saranno pianificate</strong> in questo scenario di turni macchina (potrai coprirle con un altro scenario complementare).
                    </span>
                  </div>
                )}
                <div className="max-h-[380px] overflow-y-auto space-y-0.5 pr-1">
                  {filteredRoutes.map(route => {
                    const isSelected = selectedRoutes.has(route.routeId);
                    const vt = selectedRoutes.get(route.routeId) || "12m";
                    const isForced = forcedRoutes.has(route.routeId);
                    const isExpanded = expandedRouteTrips.has(route.routeId);
                    const trips = routeTrips.get(route.routeId) || [];
                    const isLoadingTr = loadingTrips.has(route.routeId);
                    const overrideCount = trips.filter(tr => tripVehicleOverrides.has(tr.tripId) && tripVehicleOverrides.get(tr.tripId) !== vt).length;

                    return (
                      <div key={route.routeId}>
                        <div className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition-colors cursor-pointer ${isSelected ? "bg-orange-500/8 border border-orange-500/20" : "bg-background/40 border border-transparent hover:bg-muted/40"}`}>
                          <button onClick={() => toggleRoute(route.routeId)} className="shrink-0">
                            {isSelected ? <CheckSquare className="w-4 h-4 text-orange-400" /> : <Square className="w-4 h-4 text-muted-foreground" />}
                          </button>
                          <div className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: route.color || "#6b7280" }} />
                          <span className="font-medium min-w-[40px] text-sm">{route.name}</span>
                          <span className="text-[9px] px-1.5 py-0.5 rounded shrink-0"
                            style={{ backgroundColor: route.category === "urbano" ? "rgba(59,130,246,0.15)" : "rgba(245,158,11,0.15)", color: CATEGORY_COLORS[route.category] }}>
                            {route.category === "urbano" ? "URB" : "EXT"}
                          </span>
                          <span className="text-xs text-muted-foreground truncate flex-1">{route.longName || ""}</span>
                          <span className="text-[10px] text-muted-foreground shrink-0">{route.tripsCount} corse</span>
                          {isSelected && (
                            <>
                              <select value={vt} onChange={e => { e.stopPropagation(); setRouteVehicle(route.routeId, e.target.value as VehicleType); }}
                                onClick={e => e.stopPropagation()}
                                className="ml-1 text-xs bg-background border border-border/50 rounded-lg px-1.5 py-0.5 shrink-0 focus:outline-none focus:border-orange-500/50">
                                <option value="autosnodato">Autosnodato</option>
                                <option value="filobus">Filobus</option>
                                <option value="12m">12 metri</option>
                                <option value="10m">10 metri</option>
                                <option value="pollicino">Pollicino</option>
                              </select>
                              <button onClick={e => { e.stopPropagation(); toggleForced(route.routeId); }}
                                title={isForced ? "Forzato: solo questo tipo" : "Flessibile: ±1 taglia"}
                                className={`shrink-0 p-1 rounded transition-colors ${isForced ? "bg-amber-500/20 text-amber-400" : "text-muted-foreground/40 hover:text-muted-foreground hover:bg-muted/30"}`}>
                                {isForced ? <Lock className="w-3.5 h-3.5" /> : <Unlock className="w-3.5 h-3.5" />}
                              </button>
                              <button onClick={e => { e.stopPropagation(); toggleRouteTrips(route.routeId); }}
                                title="Personalizza per singola corsa"
                                className={`shrink-0 p-1 rounded transition-colors ${isExpanded ? "bg-blue-500/20 text-blue-400" : overrideCount > 0 ? "bg-orange-500/20 text-orange-400" : "text-muted-foreground/40 hover:text-muted-foreground hover:bg-muted/30"}`}>
                                {isExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                              </button>
                              {overrideCount > 0 && !isExpanded && (
                                <span className="text-[9px] text-orange-400 shrink-0">{overrideCount} override</span>
                              )}
                            </>
                          )}
                        </div>

                        {/* Per-trip vehicle override panel */}
                        {isSelected && isExpanded && (
                          <div className="ml-8 mr-2 mb-1 border-l-2 border-orange-500/20 pl-3 py-2 space-y-1 bg-muted/10 rounded-r-lg">
                            <div className="flex items-center justify-between mb-1.5">
                              <span className="text-[10px] text-orange-300/60 font-medium">
                                Corse linea {route.name} — vettura per corsa
                              </span>
                              {overrideCount > 0 && (
                                <button onClick={() => setTripVehicleOverrides(prev => {
                                  const n = new Map(prev);
                                  for (const tr of trips) n.delete(tr.tripId);
                                  return n;
                                })} className="text-[9px] text-red-400 hover:underline">Reset tutti</button>
                              )}
                            </div>
                            {isLoadingTr ? (
                              <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground py-1">
                                <Loader2 className="w-3 h-3 animate-spin text-orange-400" /> Caricamento corse…
                              </div>
                            ) : trips.length === 0 ? (
                              <div className="text-[10px] text-muted-foreground py-1">Nessuna corsa attiva per questa data</div>
                            ) : (
                              <div className="max-h-[180px] overflow-y-auto space-y-0.5 pr-1">
                                {trips.map(trip => {
                                  const tripVt = tripVehicleOverrides.get(trip.tripId) || vt;
                                  const isOverridden = tripVehicleOverrides.has(trip.tripId) && tripVehicleOverrides.get(trip.tripId) !== vt;
                                  return (
                                    <div key={trip.tripId} className={`flex items-center gap-2 text-[11px] px-2 py-1 rounded ${isOverridden ? "bg-orange-500/10 border border-orange-500/20" : "bg-background/30"}`}>
                                      <span className="text-muted-foreground shrink-0 w-[46px] font-mono">{trip.departureTime?.substring(0, 5)}</span>
                                      <ArrowRight className="w-2.5 h-2.5 text-muted-foreground/50 shrink-0" />
                                      <span className="text-muted-foreground shrink-0 w-[46px] font-mono">{trip.arrivalTime?.substring(0, 5)}</span>
                                      <span className="text-[9px] px-1 py-0.5 rounded bg-muted/30 shrink-0">{trip.directionId === 0 ? "A" : "R"}</span>
                                      <span className="truncate flex-1 text-muted-foreground text-[10px]" title={`${trip.firstStopName} → ${trip.lastStopName}`}>
                                        {trip.firstStopName} → {trip.lastStopName}
                                      </span>
                                      <select value={tripVt} onChange={e => setTripVehicle(trip.tripId, e.target.value as VehicleType)}
                                        className={`text-[10px] bg-background border rounded px-1 py-0.5 shrink-0 focus:outline-none ${isOverridden ? "border-orange-500/40 text-orange-300" : "border-border/50"}`}>
                                        <option value="autosnodato">Autosnodato</option>
                                        <option value="filobus">Filobus</option>
                                        <option value="12m">12 metri</option>
                                        <option value="10m">10 metri</option>
                                        <option value="pollicino">Pollicino</option>
                                      </select>
                                      {isOverridden && (
                                        <button onClick={() => setTripVehicleOverrides(prev => { const n = new Map(prev); n.delete(trip.tripId); return n; })}
                                          className="text-muted-foreground/40 hover:text-red-400 shrink-0">
                                          <X className="w-3 h-3" />
                                        </button>
                                      )}
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </section>

        </motion.div>
      </div>
    </div>
  );
}
