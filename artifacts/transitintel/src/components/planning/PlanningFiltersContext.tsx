/**
 * Context filtri condivisi del workspace planning.
 * - serviceDate (YYYYMMDD) → auto-deriva dayType e season
 * - dayType / season manuali sovrascrivibili
 * - radiusM
 * - selectedRouteIds (Set)
 */
import { createContext, useContext, useState, useMemo, ReactNode, useCallback } from "react";

export type SharedDay = "weekday" | "saturday" | "sunday";
export type Season = "all" | "summer" | "winter";
export type DemandPreset =
  | "weekday-work" | "sat-shopping" | "sun-summer-coast"
  | "sun-winter-mall" | "evening-leisure" | "custom";
export type MapViewPreset = "coverage" | "gaps" | "flows" | "balance" | "custom";

export interface PlanningFilters {
  serviceDate: string | null;
  setServiceDate: (d: string | null) => void;
  day: SharedDay;
  setDay: (d: SharedDay) => void;
  radiusM: number;
  setRadiusM: (r: number) => void;
  season: Season;
  setSeason: (s: Season) => void;
  selectedRouteIds: Set<string>;
  setSelectedRouteIds: (ids: Set<string>) => void;
  toggleRouteId: (id: string) => void;
  clearRoutes: () => void;
  dayLabel: string;
  derivedFromDate: boolean;
  demandPreset: DemandPreset;
  setDemandPreset: (p: DemandPreset) => void;
  mapViewPreset: MapViewPreset;
  setMapViewPreset: (p: MapViewPreset) => void;
}

const Ctx = createContext<PlanningFilters | null>(null);

function dayTypeFromDate(yyyymmdd: string): SharedDay {
  const y = parseInt(yyyymmdd.slice(0, 4), 10);
  const m = parseInt(yyyymmdd.slice(4, 6), 10);
  const d = parseInt(yyyymmdd.slice(6, 8), 10);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  if (dow === 0) return "sunday";
  if (dow === 6) return "saturday";
  return "weekday";
}

/** summer = 15 giu → 14 set, altrimenti winter */
function seasonFromDate(yyyymmdd: string): Season {
  const m = parseInt(yyyymmdd.slice(4, 6), 10);
  const d = parseInt(yyyymmdd.slice(6, 8), 10);
  const md = m * 100 + d;
  if (md >= 615 && md <= 914) return "summer";
  return "winter";
}

export function PlanningFiltersProvider({ children }: { children: ReactNode }) {
  const [serviceDate, _setServiceDate] = useState<string | null>(null);
  const [day, _setDay] = useState<SharedDay>("weekday");
  const [season, _setSeason] = useState<Season>("all");
  const [radiusM, setRadiusM] = useState(400);
  const [selectedRouteIds, setSelectedRouteIds] = useState<Set<string>>(new Set());
  const [demandPreset, _setDemandPreset] = useState<DemandPreset>("custom");
  const [mapViewPreset, setMapViewPreset] = useState<MapViewPreset>("coverage");

  // Cambi manuali a day o season → preset diventa "custom"
  const setDay = useCallback((d: SharedDay) => {
    _setDay(d);
    _setDemandPreset("custom");
  }, []);
  const setSeason = useCallback((s: Season) => {
    _setSeason(s);
    _setDemandPreset("custom");
  }, []);
  // Cambio preset → aggiorna day e season coerentemente
  const setDemandPreset = useCallback((p: DemandPreset) => {
    _setDemandPreset(p);
    if (p === "weekday-work")        { _setDay("weekday"); _setSeason("all"); }
    else if (p === "sat-shopping")   { _setDay("saturday"); _setSeason("all"); }
    else if (p === "sun-summer-coast"){ _setDay("sunday"); _setSeason("summer"); }
    else if (p === "sun-winter-mall"){ _setDay("sunday"); _setSeason("winter"); }
    else if (p === "evening-leisure"){ /* lascia day/season correnti */ }
  }, []);

  const setServiceDate = useCallback((d: string | null) => {
    _setServiceDate(d);
    if (d && /^\d{8}$/.test(d)) {
      _setDay(dayTypeFromDate(d));
      _setSeason(seasonFromDate(d));
      _setDemandPreset("custom");
    }
  }, []);

  const dayLabel = useMemo(
    () =>
      day === "weekday" ? "Feriale (Lun→Ven)" :
      day === "saturday" ? "Sabato" : "Domenica/festivo",
    [day]
  );

  const toggleRouteId = useCallback((id: string) => {
    setSelectedRouteIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const clearRoutes = useCallback(() => setSelectedRouteIds(new Set()), []);

  const derivedFromDate = !!serviceDate && /^\d{8}$/.test(serviceDate);

  const value: PlanningFilters = {
    serviceDate, setServiceDate,
    day, setDay,
    radiusM, setRadiusM,
    season, setSeason,
    selectedRouteIds, setSelectedRouteIds, toggleRouteId, clearRoutes,
    dayLabel, derivedFromDate,
    demandPreset, setDemandPreset,
    mapViewPreset, setMapViewPreset,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function usePlanningFilters(): PlanningFilters | null {
  return useContext(Ctx);
}
