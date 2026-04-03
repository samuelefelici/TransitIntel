import React, { useState, useEffect, useMemo, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Clock, Bus, Search, Route, Timer, AlertCircle,
  ArrowRight, Info, X, Filter, Activity,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { getApiBase } from "@/lib/api";

import type {
  DayType, ScheduleData, ScheduleTrip, TripVisual, TrafficAvailability, RouteItem,
} from "./travel-time/types";
import { DAY_OPTS, minToHM, parseHour } from "./travel-time/constants";
import { MiniTripCard, TripVisualPanel } from "./travel-time/components";

// ─── Main Page ────────────────────────────────────────────────
export default function TravelTime() {
  const [routeList, setRouteList] = useState<RouteItem[]>([]);
  const [routeSearch, setRouteSearch] = useState("");
  const [selectedRouteId, setSelectedRouteId] = useState<string | null>(null);
  const [day, setDay] = useState<DayType>("weekday");
  const [selectedDirection, setSelectedDirection] = useState<0 | 1 | null>(null);
  const [hourFrom, setHourFrom] = useState<number>(4);
  const [hourTo, setHourTo] = useState<number>(26);

  const [schedule, setSchedule] = useState<ScheduleData | null>(null);
  const [scheduleLoading, setScheduleLoading] = useState(false);
  const [scheduleError, setScheduleError] = useState<string | null>(null);

  const [detailTripId, setDetailTripId] = useState<string | null>(null);
  const [tripVisual, setTripVisual] = useState<TripVisual | null>(null);
  const [visualLoading, setVisualLoading] = useState(false);

  // Traffic context filters
  const [trafficAvail, setTrafficAvail] = useState<TrafficAvailability | null>(null);
  const [trafficDateFrom, setTrafficDateFrom] = useState<string>("");
  const [trafficDateTo, setTrafficDateTo] = useState<string>("");
  const [trafficDayTypes, setTrafficDayTypes] = useState<string[]>(["weekday", "saturday", "sunday"]);

  // Load route list
  useEffect(() => {
    fetch(`${getApiBase()}/api/gtfs/routes`, { cache: "no-store" })
      .then(r => r.json())
      .then(d => {
        const all = Array.isArray(d.data) ? d.data : [];
        const seen: Record<string, RouteItem> = {};
        for (const r of all) {
          if (!seen[r.routeId] || (r.tripsCount ?? 0) > (seen[r.routeId] as any).tripsCount) {
            seen[r.routeId] = { routeId: r.routeId, routeShortName: r.routeShortName ?? r.routeId, routeColor: r.routeColor ?? "#6b7280" };
          }
        }
        setRouteList(Object.values(seen).sort((a, b) => a.routeShortName.localeCompare(b.routeShortName, undefined, { numeric: true })));
      })
      .catch(err => console.error("Errore caricamento routes GTFS:", err));
  }, []);

  // Load traffic availability
  useEffect(() => {
    fetch(`${getApiBase()}/api/traffic/availability`, { cache: "no-store" })
      .then(r => r.json())
      .then(d => {
        setTrafficAvail(d);
        if (d.available && d.dateRange) {
          setTrafficDateFrom(d.dateRange.from);
          setTrafficDateTo(d.dateRange.to);
          if (d.dayTypes?.length) setTrafficDayTypes(d.dayTypes);
        }
      })
      .catch(err => console.error("Errore caricamento traffic availability:", err));
  }, []);

  // Auto-sync traffic day types with selected day
  useEffect(() => {
    setTrafficDayTypes([day]);
  }, [day]);

  // Load schedule when route + day changes
  useEffect(() => {
    if (!selectedRouteId) { setSchedule(null); setScheduleError(null); return; }
    setScheduleLoading(true); setSchedule(null); setScheduleError(null);
    const qs = new URLSearchParams({ routeId: selectedRouteId, day });
    if (selectedDirection !== null) qs.set("directionId", String(selectedDirection));
    fetch(`${getApiBase()}/api/gtfs/trips/schedule?${qs}`, { cache: "no-store" })
      .then(r => r.json())
      .then(d => {
        setScheduleLoading(false);
        if (d.error && !d.trips?.length) { setScheduleError(d.error); return; }
        setSchedule({ trips: d.trips ?? [], routeColor: d.routeColor ?? "#6b7280", routeShortName: d.routeShortName ?? selectedRouteId });
        if (!d.trips?.length) setScheduleError(`Nessuna corsa trovata per ${selectedRouteId} (${day})`);
      })
      .catch(() => { setScheduleLoading(false); setScheduleError("Errore nel caricamento corse"); });
  }, [selectedRouteId, day, selectedDirection]);

  // Load visual detail when a trip is selected (with traffic context)
  useEffect(() => {
    if (!detailTripId) { setTripVisual(null); return; }
    setVisualLoading(true); setTripVisual(null);
    const qs = new URLSearchParams({ tripId: detailTripId });
    if (trafficDateFrom) qs.set("dateFrom", trafficDateFrom);
    if (trafficDateTo) qs.set("dateTo", trafficDateTo);
    if (trafficDayTypes.length < 3) qs.set("dayTypes", trafficDayTypes.join(","));
    fetch(`${getApiBase()}/api/gtfs/trips/visual?${qs}`, { cache: "no-store" })
      .then(r => r.json())
      .then(d => { setVisualLoading(false); if (d.stops?.length > 0) setTripVisual(d); })
      .catch(() => setVisualLoading(false));
  }, [detailTripId, trafficDateFrom, trafficDateTo, trafficDayTypes]);

  const filteredRoutes = useMemo(() => {
    const q = routeSearch.toLowerCase();
    return routeList.filter(r => !q || r.routeShortName.toLowerCase().includes(q) || r.routeId.toLowerCase().includes(q));
  }, [routeList, routeSearch]);

  const filteredTrips = useMemo(() => {
    if (!schedule?.trips.length) return [];
    const isFullDay = hourFrom === 4 && hourTo === 26;
    return schedule.trips.filter(t => {
      if (!isFullDay) {
        const h = parseHour(t.firstDeparture);
        if (h < hourFrom || h >= hourTo) return false;
      }
      return true;
    });
  }, [schedule, hourFrom, hourTo]);

  const selectedRoute = useMemo(() => routeList.find(r => r.routeId === selectedRouteId), [routeList, selectedRouteId]);
  const routeColor = schedule?.routeColor ?? selectedRoute?.routeColor ?? "#6b7280";
  const displayColor = routeColor !== "#6b7280" ? routeColor : "#64748b";

  const openDetail = useCallback((tripId: string) => {
    setDetailTripId(tripId);
  }, []);

  const closeDetail = useCallback(() => {
    setDetailTripId(null);
    setTripVisual(null);
  }, []);

  const hasHourFilter = hourFrom !== 4 || hourTo !== 26;

  return (
    <div className="h-full flex flex-col overflow-hidden">

      {/* ── Time Range Top Bar ─────────────────────────────────── */}
      <div className="flex items-center gap-2 px-3 py-1.5 bg-background/80 backdrop-blur-xl border-b border-border/30 shrink-0">
        <Clock className="w-3 h-3 text-muted-foreground/70 shrink-0" />
        <span className="text-[10px] text-muted-foreground shrink-0">Orario</span>

        <select
          value={hourFrom}
          onChange={e => {
            const v = +e.target.value;
            setHourFrom(v);
            if (v >= hourTo) setHourTo(Math.min(v + 1, 26));
          }}
          className="text-[11px] bg-background/60 border border-border/40 rounded-md px-1.5 py-0.5 text-foreground focus:outline-none focus:ring-1 focus:ring-primary cursor-pointer"
        >
          {Array.from({ length: 23 }, (_, i) => i + 4).map(h => (
            <option key={h} value={h}>{h.toString().padStart(2, "0")}:00</option>
          ))}
        </select>

        <span className="text-[10px] text-muted-foreground/60">→</span>

        <select
          value={hourTo}
          onChange={e => {
            const v = +e.target.value;
            setHourTo(v);
            if (v <= hourFrom) setHourFrom(Math.max(v - 1, 4));
          }}
          className="text-[11px] bg-background/60 border border-border/40 rounded-md px-1.5 py-0.5 text-foreground focus:outline-none focus:ring-1 focus:ring-primary cursor-pointer"
        >
          {Array.from({ length: 22 }, (_, i) => i + 5).map(h => (
            <option key={h} value={h}>{h.toString().padStart(2, "0")}:00</option>
          ))}
        </select>

        <div className="w-px h-3.5 bg-border/40 mx-0.5 shrink-0" />

        {/* Day type buttons */}
        {DAY_OPTS.map(opt => (
          <button key={opt.key} onClick={() => setDay(opt.key)}
            className={`shrink-0 flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full border transition-all ${
              day === opt.key
                ? "bg-primary text-primary-foreground border-primary"
                : "border-border/40 text-muted-foreground hover:text-foreground hover:border-border"
            }`}>
            <span>{opt.icon}</span>
            <span>{opt.label}</span>
          </button>
        ))}

        {/* Reset button */}
        {hasHourFilter && (
          <button
            onClick={() => { setHourFrom(4); setHourTo(26); }}
            className="shrink-0 text-[10px] text-muted-foreground/60 hover:text-primary transition-colors ml-1"
          >
            Ripristina orario
          </button>
        )}

        {/* Trip count badge */}
        {selectedRouteId && filteredTrips.length > 0 && (
          <span className="ml-auto shrink-0 text-[10px] text-primary/80 bg-primary/10 px-2 py-0.5 rounded-full border border-primary/20">
            {filteredTrips.length} corse
          </span>
        )}
      </div>

      {/* ── Content row ────────────────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden">

      {/* ── Left sidebar ──────────────────────────────────── */}
      <div className="w-64 shrink-0 flex flex-col gap-0 border-r border-border/30 overflow-y-auto bg-card/30">
        <div className="p-3 space-y-3">
          {/* Header */}
          <div className="flex items-center gap-2 pt-1">
            <Timer className="w-4 h-4 text-primary" />
            <h2 className="text-sm font-semibold">Tempi di percorrenza</h2>
          </div>

          {/* Route selector */}
          <div className="space-y-1.5">
            <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
              <Bus className="w-3 h-3" /> Linea
            </p>
            <div className="relative">
              <Search className="absolute left-2 top-2 w-3 h-3 text-muted-foreground" />
              <input placeholder="Cerca..." value={routeSearch} onChange={e => setRouteSearch(e.target.value)}
                className="w-full pl-6 pr-2 py-1.5 text-xs bg-muted rounded-lg border border-border/40 focus:outline-none focus:ring-1 focus:ring-primary" />
            </div>
            <div className="max-h-36 overflow-y-auto space-y-0.5">
              {filteredRoutes.length === 0 && <p className="text-xs text-muted-foreground text-center py-2">Nessuna linea</p>}
              {filteredRoutes.map(r => (
                <button key={r.routeId} onClick={() => { setSelectedRouteId(r.routeId); setRouteSearch(""); setSelectedDirection(null); setHourFrom(4); setHourTo(26); }}
                  className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left text-xs transition-colors ${selectedRouteId === r.routeId ? "bg-primary/15 border border-primary/30" : "hover:bg-muted/70 border border-transparent"}`}>
                  <span className="w-7 h-5 inline-flex items-center justify-center rounded text-[10px] font-bold text-white shrink-0"
                    style={{ backgroundColor: r.routeColor && r.routeColor !== "#6b7280" ? r.routeColor : "#64748b" }}>
                    {r.routeShortName}
                  </span>
                  <span className="text-muted-foreground truncate">{r.routeId}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Direction filter */}
          {selectedRouteId && (
            <div className="space-y-1.5">
              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Verso</p>
              <div className="grid grid-cols-3 gap-1">
                {[
                  { val: null, label: "Tutti" },
                  { val: 0,    label: "Andata" },
                  { val: 1,    label: "Ritorno" },
                ].map(opt => (
                  <button key={String(opt.val)} onClick={() => setSelectedDirection(opt.val as any)}
                    className={`px-1.5 py-1 rounded-lg border text-[10px] font-medium transition-all ${
                      selectedDirection === opt.val
                        ? "bg-primary/15 border-primary/40 text-primary"
                        : "border-border/40 text-muted-foreground hover:bg-muted/50"
                    }`}>
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Traffic context */}
          <div className="space-y-1.5 border-t border-border/20 pt-3">
            <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1">
              <Activity className="w-3 h-3" /> Contesto Traffico
            </p>
            {trafficAvail && !trafficAvail.available && (
              <p className="text-[10px] text-amber-400/80 bg-amber-500/10 rounded-lg px-2 py-1.5">
                Nessun dato traffico disponibile.
              </p>
            )}
            {trafficAvail?.available && (
              <div className="text-[10px] text-muted-foreground bg-muted/30 rounded-lg px-2 py-1.5 space-y-0.5">
                <div>{trafficAvail.totalSnapshots} snapshot disponibili</div>
                <div>Ore rilevate: {trafficAvail.hours?.[0]}–{(trafficAvail.hours?.[trafficAvail.hours.length - 1] ?? 0) + 1}</div>
                <div className="text-primary/70">Tipo giorno: <span className="font-medium">auto ({day})</span></div>
              </div>
            )}
            {/* Date range */}
            <div className="space-y-1">
              <p className="text-[9px] text-muted-foreground uppercase tracking-wide">Periodo analisi</p>
              <div className="grid grid-cols-2 gap-1">
                <div>
                  <p className="text-[8px] text-muted-foreground mb-0.5">Da</p>
                  <input type="date" value={trafficDateFrom}
                    onChange={e => setTrafficDateFrom(e.target.value)}
                    className="w-full text-[9px] bg-muted border border-border/40 rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-primary" />
                </div>
                <div>
                  <p className="text-[8px] text-muted-foreground mb-0.5">A</p>
                  <input type="date" value={trafficDateTo}
                    onChange={e => setTrafficDateTo(e.target.value)}
                    className="w-full text-[9px] bg-muted border border-border/40 rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-primary" />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── Main area ─────────────────────────────────────── */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Topbar */}
        <div className="px-4 py-2.5 border-b border-border/30 flex items-center gap-3 shrink-0 bg-card/20">
          {selectedRoute ? (
            <>
              <span className="inline-flex items-center justify-center px-2.5 py-1 rounded font-bold text-sm text-white"
                style={{ backgroundColor: displayColor }}>
                {schedule?.routeShortName ?? selectedRoute.routeShortName}
              </span>
              <span className="text-sm text-muted-foreground">
                {scheduleLoading ? "Caricamento…" : filteredTrips.length > 0 ? `${filteredTrips.length} corse` : ""}
              </span>
              {hasHourFilter && (
                <Badge variant="secondary" className="text-xs">
                  🕐 {hourFrom.toString().padStart(2, "0")}:00–{hourTo.toString().padStart(2, "0")}:00
                </Badge>
              )}
              {selectedDirection !== null && (
                <Badge variant="secondary" className="text-xs">
                  {selectedDirection === 0 ? "→ Andata" : "← Ritorno"}
                </Badge>
              )}
            </>
          ) : (
            <span className="text-sm text-muted-foreground">Seleziona una linea per visualizzare le corse</span>
          )}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          {/* Empty state */}
          {!selectedRouteId && (
            <div className="h-full flex flex-col items-center justify-center gap-4 text-muted-foreground">
              <Route className="w-16 h-16 opacity-10" />
              <div className="text-center">
                <p className="text-lg font-semibold">Seleziona una linea</p>
                <p className="text-sm mt-1 max-w-sm">Scegli la linea a sinistra per vedere tutte le corse del giorno con i tempi per fermata.</p>
              </div>
              <div className="flex items-start gap-2 bg-blue-500/10 border border-blue-500/20 rounded-xl p-3 text-xs text-left max-w-sm">
                <Info className="w-4 h-4 text-blue-400 shrink-0 mt-0.5" />
                <span className="text-muted-foreground">
                  Ogni riga mostra il diagramma temporale della corsa. Clicca su una corsa per vedere i dettagli fermata per fermata.
                </span>
              </div>
            </div>
          )}

          {/* Loading */}
          {scheduleLoading && (
            <div className="h-48 flex flex-col items-center justify-center gap-3">
              <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
              <p className="text-sm text-muted-foreground animate-pulse">Caricamento corse…</p>
            </div>
          )}

          {/* Error */}
          {scheduleError && !scheduleLoading && (
            <div className="flex flex-col items-center gap-3 py-12 text-center">
              <AlertCircle className="w-8 h-8 text-amber-400" />
              <p className="text-sm text-muted-foreground">{scheduleError}</p>
              {scheduleError.includes("reimporta") && (
                <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg p-3 text-xs text-amber-400 max-w-xs">
                  Vai su "Import GTFS" e ricarica il feed
                </div>
              )}
            </div>
          )}

          {/* Trip mini-diagrams */}
          {!scheduleLoading && !scheduleError && filteredTrips.length > 0 && (
            <div className="space-y-1.5">
              {filteredTrips.map((trip, i) => (
                <MiniTripCard
                  key={trip.tripId}
                  trip={trip}
                  color={displayColor}
                  shortName={schedule?.routeShortName ?? ""}
                  onClick={() => openDetail(trip.tripId)}
                  index={i}
                />
              ))}
              {/* Footer total */}
              <div className="pt-2 pb-4 text-center text-xs text-muted-foreground">
                {filteredTrips.length} corse totali
                {hasHourFilter ? ` (${hourFrom.toString().padStart(2,"0")}:00–${hourTo.toString().padStart(2,"0")}:00)` : ""}
              </div>
            </div>
          )}

          {/* No results after filter */}
          {!scheduleLoading && !scheduleError && schedule && filteredTrips.length === 0 && schedule.trips.length > 0 && (
            <div className="flex flex-col items-center gap-3 py-12 text-center">
              <Filter className="w-8 h-8 opacity-20" />
              <p className="text-sm text-muted-foreground">
                Nessuna corsa nella fascia selezionata
              </p>
              <button onClick={() => { setHourFrom(4); setHourTo(26); }} className="text-xs text-primary underline">
                Rimuovi filtro orario
              </button>
            </div>
          )}
        </div>
      </div>
      </div>

      {/* ── Detail overlay ────────────────────────────────── */}
      <AnimatePresence>
        {detailTripId && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 z-50 bg-background/60 backdrop-blur-sm flex items-center justify-center p-4"
            onClick={closeDetail}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.96, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: 20 }}
              transition={{ type: "spring", stiffness: 320, damping: 32 }}
              className="bg-card rounded-2xl shadow-2xl border border-border/60 w-full max-w-4xl max-h-[90vh] flex flex-col overflow-hidden"
              onClick={e => e.stopPropagation()}
            >
              {/* Detail header */}
              <div className="flex items-center justify-between p-4 border-b border-border/30 shrink-0">
                <div className="flex items-center gap-3">
                  <span className="inline-flex items-center justify-center px-3 py-1.5 rounded-lg font-bold text-lg text-white"
                    style={{ backgroundColor: displayColor }}>
                    {schedule?.routeShortName}
                  </span>
                  {(() => {
                    const t = filteredTrips.find(x => x.tripId === detailTripId);
                    return t ? (
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-mono font-bold">{t.firstDeparture?.substring(0,5)}</span>
                          <ArrowRight className="w-3.5 h-3.5 text-muted-foreground" />
                          <span className="font-mono text-muted-foreground">{t.lastArrival?.substring(0,5)}</span>
                        </div>
                        {t.headsign && <p className="text-xs text-muted-foreground">{t.headsign}</p>}
                      </div>
                    ) : null;
                  })()}
                </div>
                <button onClick={closeDetail} className="text-muted-foreground hover:text-foreground transition-colors">
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* Detail body */}
              <div className="flex-1 overflow-y-auto p-4">
                {visualLoading && (
                  <div className="flex flex-col items-center justify-center h-48 gap-3">
                    <div className="w-7 h-7 border-4 border-primary border-t-transparent rounded-full animate-spin" />
                    <p className="text-sm text-muted-foreground">Caricamento dettaglio…</p>
                  </div>
                )}
                {!visualLoading && tripVisual && (
                  <TripVisualPanel
                    visual={tripVisual}
                    day={day}
                    selectedRoute={selectedRoute}
                  />
                )}
                {!visualLoading && !tripVisual && (
                  <div className="flex flex-col items-center gap-3 py-8 text-center">
                    {/* Fallback: show schedule data from mini card */}
                    {(() => {
                      const t = filteredTrips.find(x => x.tripId === detailTripId);
                      if (!t) return <p className="text-muted-foreground text-sm">Dati non disponibili</p>;
                      return (
                        <div className="w-full max-w-2xl space-y-4">
                          <div className="flex flex-wrap gap-2 justify-center">
                            <Badge variant="outline"><Timer className="w-3 h-3 mr-1" />{minToHM(t.totalMin)}</Badge>
                            <Badge variant="outline"><Bus className="w-3 h-3 mr-1" />{t.stopCount} fermate</Badge>
                          </div>
                          {/* Stop list */}
                          <div className="border border-border/40 rounded-xl overflow-hidden">
                            <table className="w-full text-xs">
                              <thead>
                                <tr className="bg-muted/30 border-b border-border/40">
                                  <th className="px-3 py-1.5 text-left font-medium text-muted-foreground">#</th>
                                  <th className="px-3 py-1.5 text-left font-medium text-muted-foreground">Fermata</th>
                                  <th className="px-3 py-1.5 text-left font-medium text-muted-foreground">Partenza</th>
                                  <th className="px-3 py-1.5 text-right font-medium text-muted-foreground">Min. tratto</th>
                                </tr>
                              </thead>
                              <tbody>
                                {t.stops.map((s, i) => (
                                  <tr key={i} className="border-b border-border/30 hover:bg-muted/20">
                                    <td className="px-3 py-1.5 text-muted-foreground font-mono">{i+1}</td>
                                    <td className="px-3 py-1.5 font-medium max-w-[220px] truncate">{s.stopName}</td>
                                    <td className="px-3 py-1.5 font-mono text-primary">{s.departureTime?.substring(0,5)}</td>
                                    <td className="px-3 py-1.5 text-right font-mono text-muted-foreground">
                                      {i > 0 ? `${Math.round(s.minsFromPrev)}'` : "—"}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
