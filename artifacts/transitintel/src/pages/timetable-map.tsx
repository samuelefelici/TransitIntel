/**
 * MAPPA ORARI pubblica (/o/:token) — nessuna autenticazione.
 *
 * UI in stile APP (tema chiaro, come le app di trasporto che i passeggeri
 * già conoscono), user-friendly su mobile E desktop:
 *
 *  MOBILE (< md): flusso guidato a fogli dal basso —
 *    1. "Che giorno viaggi?" (dai giorni di validità reali del GTFS/matrice)
 *    2. "Scegli la linea" (solo quelle che circolano in quel giorno)
 *    3. mappa; tocca una fermata → orari del giorno in bottom-sheet,
 *       corse A CHIAMATA (📞) evidenziate
 *
 *  DESKTOP (≥ md): pannello fisso a sinistra con giorno (segmented control)
 *  e elenco linee sempre visibili; mappa a destra; orari in card laterale.
 *  Cambiare giorno NON resetta la linea se circola anche nel nuovo giorno.
 *
 * Robustezza: gli errori di caricamento sono SEMPRE visibili (banner con
 * Riprova), mai pagina muta. I colori dei percorsi sono quelli scelti
 * dall'operatore nell'app (attributes.color per percorso → colore linea).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useRoute } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Map as MapGL, Source, Layer, NavigationControl } from "react-map-gl/mapbox";
import type { MapRef } from "react-map-gl/mapbox";
import "mapbox-gl/dist/mapbox-gl.css";
import {
  Loader2, MapPinned, Search, X, PhoneCall, Clock, CalendarDays,
  ChevronLeft, ChevronRight, AlertTriangle, Bus,
} from "lucide-react";
import { apiFetch } from "@/lib/api";

const MAPBOX_TOKEN: string = import.meta.env.VITE_MAPBOX_TOKEN || "";

interface MetaResp {
  title: string | null;
  agencyName: string | null;
  expiresAt: string | null;
  hasValidity: boolean;
  dayTypes: Array<{ id: string; code: string; name: string; color: string | null }>;
  lines: Array<{ routeId: string; code: string; longName: string | null; color: string | null; dayTypeIds: string[] }>;
}
interface VariantResp {
  routeId: string;
  variants: Array<{
    variantId: string; code: string; name: string | null; headsign: string | null;
    direction: number; color: string | null; geometry: any | null;
    stops: Array<{ stopId: string; name: string; lat: number; lon: number; seq: number }>;
  }>;
}
interface StopResp {
  stop: { stopId: string; name: string; code: string | null };
  hasValidity: boolean;
  departures: Array<{ time: string; headsign: string | null; variantCode: string | null; onDemand: boolean; days: string[] }>;
}

function col(c: string | null | undefined, fallback = "#0e7490"): string {
  if (!c) return fallback;
  return c.startsWith("#") ? c : `#${c}`;
}

/** estrae tutte le coordinate [lon,lat] da LineString o MultiLineString */
function geomCoords(geom: any): Array<[number, number]> {
  if (!geom) return [];
  if (geom.type === "LineString") return (geom.coordinates ?? []).filter((c: any) => Array.isArray(c) && c.length >= 2);
  if (geom.type === "MultiLineString") {
    const out: Array<[number, number]> = [];
    for (const part of geom.coordinates ?? []) for (const c of part ?? []) {
      if (Array.isArray(c) && c.length >= 2) out.push(c as [number, number]);
    }
    return out;
  }
  return [];
}

export default function TimetableMapPage() {
  const [, params] = useRoute("/o/:token");
  const token = params?.token ?? "";
  const mapRef = useRef<MapRef | null>(null);

  const metaQ = useQuery({
    queryKey: ["timetable-map", token],
    queryFn: () => apiFetch<MetaResp>(`/api/timetable-map/${encodeURIComponent(token)}`),
    enabled: !!token,
    staleTime: 60_000,
  });

  const [dayTypeId, setDayTypeId] = useState<string | null>(null);
  const [routeId, setRouteId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [stopId, setStopId] = useState<string | null>(null);

  const dayTypes = metaQ.data?.dayTypes ?? [];
  const needsDay = dayTypes.length > 0;
  const selectedDay = dayTypes.find((d) => d.id === dayTypeId) ?? null;
  const dayQS = dayTypeId ? `?dayTypeId=${dayTypeId}` : "";

  const lines = useMemo(
    () => [...(metaQ.data?.lines ?? [])].sort((a, b) => a.code.localeCompare(b.code, "it", { numeric: true })),
    [metaQ.data],
  );
  const filteredLines = useMemo(() => {
    const q = search.trim().toLowerCase();
    return lines.filter((l) => {
      // la linea compare solo se circola nel giorno scelto; senza bollini di
      // validità resta sempre visibile (meglio mostrare che nascondere)
      if (dayTypeId && Array.isArray(l.dayTypeIds) && l.dayTypeIds.length > 0
          && !l.dayTypeIds.includes(dayTypeId)) return false;
      if (!q) return true;
      return l.code.toLowerCase().includes(q) || (l.longName ?? "").toLowerCase().includes(q);
    });
  }, [lines, search, dayTypeId]);
  const selectedLine = lines.find((l) => l.routeId === routeId) ?? null;
  const lineColor = col(selectedLine?.color);

  const routeQ = useQuery({
    queryKey: ["timetable-map", token, "route", routeId, dayTypeId],
    queryFn: () => apiFetch<VariantResp>(`/api/timetable-map/${encodeURIComponent(token)}/route/${routeId}${dayQS}`),
    enabled: !!token && !!routeId,
    staleTime: 60_000,
    retry: 1,
  });

  const stopQ = useQuery({
    queryKey: ["timetable-map", token, "stop", stopId, routeId, dayTypeId],
    queryFn: () => apiFetch<StopResp>(
      `/api/timetable-map/${encodeURIComponent(token)}/stop/${stopId}?routeId=${routeId}${dayTypeId ? `&dayTypeId=${dayTypeId}` : ""}`),
    enabled: !!token && !!stopId && !!routeId,
    staleTime: 60_000,
    retry: 1,
  });

  /* GeoJSON percorsi (colore per-percorso dell'operatore) + fermate */
  const { linesFC, stopsFC, bounds } = useMemo(() => {
    const variants = routeQ.data?.variants ?? [];
    const lineFeatures: any[] = [];
    const stopFeatures: any[] = [];
    const seenStops = new Set<string>();
    let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
    const extend = (lon: number, lat: number) => {
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
      minLon = Math.min(minLon, lon); maxLon = Math.max(maxLon, lon);
      minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat);
    };
    for (const v of variants) {
      const vColor = col(v.color, lineColor);
      const coords = geomCoords(v.geometry);
      if (coords.length >= 2) {
        lineFeatures.push({ type: "Feature", properties: { variantId: v.variantId, color: vColor }, geometry: v.geometry });
        for (const c of coords) extend(c[0], c[1]);
      } else if (v.stops.length >= 2) {
        // fallback senza shape: spezzata tra le fermate
        lineFeatures.push({
          type: "Feature", properties: { variantId: v.variantId, color: vColor },
          geometry: { type: "LineString", coordinates: v.stops.map((s) => [s.lon, s.lat]) },
        });
      }
      for (const s of v.stops) {
        extend(s.lon, s.lat);
        if (seenStops.has(s.stopId)) continue;
        seenStops.add(s.stopId);
        stopFeatures.push({
          type: "Feature",
          properties: { stopId: s.stopId, name: s.name, color: vColor },
          geometry: { type: "Point", coordinates: [s.lon, s.lat] },
        });
      }
    }
    return {
      linesFC: { type: "FeatureCollection", features: lineFeatures } as any,
      stopsFC: { type: "FeatureCollection", features: stopFeatures } as any,
      bounds: Number.isFinite(minLon) ? ([[minLon, minLat], [maxLon, maxLat]] as [[number, number], [number, number]]) : null,
    };
  }, [routeQ.data, lineColor]);

  /* Zoom automatico sulla linea appena caricata */
  useEffect(() => {
    if (bounds && mapRef.current) {
      mapRef.current.fitBounds(bounds, { padding: 60, duration: 800, maxZoom: 15 });
    }
  }, [bounds]);

  /* Cambio giorno "intelligente": la linea resta selezionata se circola anche
   * nel nuovo giorno; altrimenti si torna alla scelta linea. */
  function pickDay(id: string) {
    setDayTypeId(id);
    const line = lines.find((l) => l.routeId === routeId);
    const stillValid = !!line && (!Array.isArray(line.dayTypeIds) || line.dayTypeIds.length === 0 || line.dayTypeIds.includes(id));
    if (!stillValid) { setRouteId(null); setStopId(null); }
  }
  function pickLine(id: string) { setRouteId(id); setStopId(null); }
  function backToDays() { setDayTypeId(null); setRouteId(null); setStopId(null); }

  const depGroups = useMemo(() => {
    const deps = stopQ.data?.departures ?? [];
    const groups = new Map<string, StopResp["departures"]>();
    for (const d of deps) {
      const key = selectedDay ? selectedDay.name : (d.days.length > 0 ? d.days.join(" · ") : "Tutti i giorni");
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(d);
    }
    return [...groups.entries()];
  }, [stopQ.data, selectedDay]);

  if (metaQ.isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-100 text-slate-700">
        <Loader2 className="w-6 h-6 animate-spin mr-2 text-cyan-600" /> Carico la mappa orari…
      </div>
    );
  }
  if (metaQ.isError || !metaQ.data) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-slate-100 text-slate-800 gap-3 px-6 text-center">
        <div className="w-14 h-14 rounded-2xl bg-white shadow flex items-center justify-center">
          <MapPinned className="w-7 h-7 text-slate-400" />
        </div>
        <p className="text-lg font-bold">Link non valido o scaduto</p>
        <p className="text-sm text-slate-500 max-w-xs">Controlla l'indirizzo o richiedi un nuovo link all'azienda di trasporto.</p>
      </div>
    );
  }
  const meta = metaQ.data;
  const showDayStep = needsDay && !dayTypeId;
  const showLineStep = !showDayStep && !routeId;
  const noDrawable = !!routeQ.data && (routeQ.data.variants.length === 0
    || routeQ.data.variants.every((v) => geomCoords(v.geometry).length < 2 && v.stops.length < 2));

  /* riga-linea stile app (badge colorato + nome + freccia) */
  const lineRow = (l: MetaResp["lines"][number]) => {
    const c = col(l.color);
    const active = l.routeId === routeId;
    return (
      <button key={l.routeId} onClick={() => pickLine(l.routeId)}
        className={`w-full flex items-center gap-3 px-3 py-3 rounded-2xl transition-all text-left border ${
          active ? "bg-white shadow-md border-transparent ring-2" : "bg-white/70 border-slate-200 hover:bg-white hover:shadow-sm"
        }`}
        style={active ? { ["--tw-ring-color" as any]: c } : undefined}>
        <span className="shrink-0 min-w-[48px] text-center px-2 py-1.5 rounded-xl text-sm font-extrabold text-white shadow-sm" style={{ backgroundColor: c }}>
          {l.code}
        </span>
        <span className="flex-1 text-[13px] font-medium text-slate-700 truncate">{l.longName ?? "—"}</span>
        <ChevronRight className={`w-4 h-4 shrink-0 ${active ? "text-slate-600" : "text-slate-300"}`} />
      </button>
    );
  };

  /* segmented control giorni stile app */
  const daySegmented = (
    <div className="grid gap-1 p-1 rounded-2xl bg-slate-200/80" style={{ gridTemplateColumns: `repeat(${Math.min(dayTypes.length, 3)}, minmax(0, 1fr))` }}>
      {dayTypes.map((d) => {
        const active = d.id === dayTypeId;
        return (
          <button key={d.id} onClick={() => pickDay(d.id)}
            className={`px-2 py-2 rounded-xl text-[13px] font-bold transition-all ${
              active ? "bg-white text-slate-900 shadow" : "text-slate-500 hover:text-slate-700"
            }`}>
            {d.name}
          </button>
        );
      })}
    </div>
  );

  const errorBanner = (msg: string, retry: () => void) => (
    <div className="flex items-center gap-2 px-3 py-2.5 rounded-2xl bg-rose-50 border border-rose-200 text-rose-700">
      <AlertTriangle className="w-4 h-4 shrink-0" />
      <span className="text-xs font-medium flex-1">{msg}</span>
      <button onClick={retry} className="text-xs font-bold underline underline-offset-2 shrink-0">Riprova</button>
    </div>
  );

  return (
    <div className="h-screen w-screen flex bg-slate-100 text-slate-900 overflow-hidden">
      {/* ═══ PANNELLO DESKTOP ═══ */}
      <aside className="hidden md:flex flex-col w-96 shrink-0 bg-slate-50 border-r border-slate-200">
        <div className="px-5 pt-5 pb-4 bg-white border-b border-slate-200">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-cyan-600 flex items-center justify-center shadow">
              <Bus className="w-5 h-5 text-white" />
            </div>
            <div className="min-w-0">
              <h1 className="text-[15px] font-extrabold leading-tight truncate">{meta.title || "Mappa Orari"}</h1>
              {meta.agencyName && <p className="text-xs text-slate-500 leading-tight truncate">{meta.agencyName}</p>}
            </div>
          </div>
        </div>
        <div className="flex-1 flex flex-col min-h-0 px-4 py-4 gap-3">
          {needsDay && (
            <div className="space-y-1.5">
              <p className="text-[11px] font-bold uppercase tracking-wider text-slate-400 px-1">Che giorno viaggi?</p>
              {daySegmented}
            </div>
          )}
          {(!needsDay || dayTypeId) ? (
            <>
              <div className="relative">
                <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Cerca linea o destinazione…"
                  className="w-full pl-9 pr-3 py-2.5 text-sm rounded-2xl bg-white border border-slate-200 outline-none focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100 placeholder:text-slate-400 shadow-sm"
                />
              </div>
              <div className="flex-1 overflow-y-auto grid gap-1.5 content-start pr-0.5 -mr-0.5">
                {filteredLines.map(lineRow)}
                {filteredLines.length === 0 && (
                  <p className="text-xs text-slate-400 py-3 text-center">
                    {search.trim()
                      ? "Nessuna linea trovata"
                      : selectedDay ? `Nessuna linea circola nei giorni "${selectedDay.name}"` : "Nessuna linea disponibile"}
                  </p>
                )}
              </div>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center">
              <p className="text-sm text-slate-400 text-center px-6">👆 Scegli il giorno per vedere le linee disponibili</p>
            </div>
          )}
        </div>
        {meta.expiresAt && (
          <div className="px-5 py-2.5 bg-white border-t border-slate-200 text-[10px] text-slate-400">
            Orari sempre aggiornati · pagina online fino al {new Date(meta.expiresAt).toLocaleDateString("it-IT")}
          </div>
        )}
      </aside>

      {/* ═══ COLONNA PRINCIPALE ═══ */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Header MOBILE */}
        <header className="md:hidden shrink-0 px-3 pt-3 pb-2 space-y-2 bg-white border-b border-slate-200 z-10 shadow-sm">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-cyan-600 flex items-center justify-center shadow shrink-0">
              <Bus className="w-4.5 h-4.5 w-[18px] h-[18px] text-white" />
            </div>
            <div className="min-w-0">
              <h1 className="text-sm font-extrabold leading-tight truncate">{meta.title || "Mappa Orari"}</h1>
              {meta.agencyName && <p className="text-[11px] text-slate-500 leading-tight truncate">{meta.agencyName}</p>}
            </div>
            {needsDay && selectedDay && (
              <button onClick={backToDays}
                className="ml-auto shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] font-bold bg-slate-100 text-slate-700 border border-slate-200 active:scale-95 transition"
                title="Cambia giorno">
                <CalendarDays className="w-3.5 h-3.5 text-cyan-600" /> {selectedDay.name}
              </button>
            )}
          </div>
          {!showDayStep && !showLineStep && selectedLine && (
            <button onClick={() => setRouteId(null)}
              className="w-full flex items-center gap-2.5 px-3 py-2 rounded-2xl bg-slate-50 border border-slate-200 active:scale-[0.99] transition text-left">
              <span className="shrink-0 min-w-[44px] text-center px-2 py-1 rounded-lg text-xs font-extrabold text-white" style={{ backgroundColor: lineColor }}>
                {selectedLine.code}
              </span>
              <span className="flex-1 text-xs font-medium text-slate-600 truncate">{selectedLine.longName ?? ""}</span>
              <span className="text-[10px] font-bold text-cyan-700 shrink-0">Cambia ›</span>
            </button>
          )}
        </header>

        {/* ── Mappa ── */}
        <div className="flex-1 relative">
          <MapGL
            ref={mapRef}
            mapboxAccessToken={MAPBOX_TOKEN}
            initialViewState={{ longitude: 13.51, latitude: 43.61, zoom: 10 }}
            mapStyle="mapbox://styles/mapbox/streets-v12"
            interactiveLayerIds={routeId ? ["tm-stops"] : []}
            onClick={(e) => {
              const f = e.features?.find((x: any) => x.layer?.id === "tm-stops");
              if (f?.properties?.stopId) setStopId(String(f.properties.stopId));
            }}
            onMouseMove={(e) => {
              const canvas = mapRef.current?.getCanvas();
              if (canvas) canvas.style.cursor = e.features?.length ? "pointer" : "";
            }}
            style={{ width: "100%", height: "100%" }}
          >
            <NavigationControl position="top-right" />
            {routeId && (
              <>
                <Source id="tm-lines" type="geojson" data={linesFC}>
                  <Layer id="tm-lines-casing" type="line"
                    paint={{ "line-color": "#ffffff", "line-width": 8, "line-opacity": 0.9 }}
                    layout={{ "line-cap": "round", "line-join": "round" }} />
                  <Layer id="tm-lines-core" type="line"
                    paint={{ "line-color": ["get", "color"], "line-width": 4.5 }}
                    layout={{ "line-cap": "round", "line-join": "round" }} />
                </Source>
                <Source id="tm-stops-src" type="geojson" data={stopsFC}>
                  <Layer id="tm-stops" type="circle"
                    paint={{
                      "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 4.5, 14, 9],
                      "circle-color": "#ffffff",
                      "circle-stroke-color": ["get", "color"],
                      "circle-stroke-width": 3,
                    }} />
                  <Layer id="tm-stop-labels" type="symbol" minzoom={13}
                    layout={{
                      "text-field": ["get", "name"],
                      "text-size": 11.5,
                      "text-offset": [0, 1.15],
                      "text-anchor": "top",
                    }}
                    paint={{ "text-color": "#0f172a", "text-halo-color": "#ffffff", "text-halo-width": 1.6 }} />
                </Source>
              </>
            )}
          </MapGL>

          {/* Stato caricamento / ERRORI sempre visibili */}
          <div className="absolute inset-x-3 top-3 md:left-3 md:right-auto md:max-w-md space-y-2 pointer-events-none [&>*]:pointer-events-auto">
            {routeQ.isLoading && (
              <div className="flex items-center gap-2 px-3 py-2 rounded-2xl bg-white/95 border border-slate-200 shadow text-xs font-medium text-slate-600">
                <Loader2 className="w-4 h-4 animate-spin text-cyan-600" /> Carico i percorsi della linea…
              </div>
            )}
            {routeQ.isError && errorBanner("Impossibile caricare i percorsi della linea.", () => routeQ.refetch())}
            {noDrawable && !routeQ.isLoading && (
              <div className="flex items-center gap-2 px-3 py-2.5 rounded-2xl bg-amber-50 border border-amber-200 text-amber-800 shadow">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                <span className="text-xs font-medium">
                  Nessun percorso disponibile per questa linea{selectedDay ? ` nei giorni "${selectedDay.name}"` : ""}.
                </span>
              </div>
            )}
            {selectedLine && !routeQ.isLoading && !routeQ.isError && !noDrawable && (
              <div className="hidden md:flex items-center gap-2 px-3 py-2 rounded-2xl bg-white/95 border border-slate-200 shadow text-xs">
                <span className="px-2 py-0.5 rounded-lg font-extrabold text-white text-[11px]" style={{ backgroundColor: lineColor }}>{selectedLine.code}</span>
                <span className="font-medium text-slate-600 truncate">{selectedLine.longName ?? ""}</span>
                <span className="text-slate-400">· clicca una fermata per gli orari</span>
              </div>
            )}
          </div>

          {/* Hint DESKTOP quando manca la selezione */}
          {!routeId && (
            <div className="hidden md:flex absolute inset-0 items-center justify-center pointer-events-none">
              <div className="px-6 py-5 rounded-3xl bg-white/95 border border-slate-200 shadow-xl text-center max-w-xs">
                <div className="w-11 h-11 rounded-2xl bg-cyan-50 flex items-center justify-center mx-auto mb-2.5">
                  <MapPinned className="w-5.5 h-5.5 w-[22px] h-[22px] text-cyan-600" />
                </div>
                <p className="text-sm font-bold text-slate-800">
                  {needsDay && !dayTypeId ? "Scegli il giorno nel pannello a sinistra" : "Scegli la linea nel pannello a sinistra"}
                </p>
                <p className="text-xs text-slate-500 mt-1">La mappa mostrerà percorsi e fermate; clicca una fermata per gli orari.</p>
              </div>
            </div>
          )}

          {/* ── STEP MOBILE: fogli dal basso stile app ── */}
          {(showDayStep || showLineStep) && (
            <div className="md:hidden absolute inset-0 z-20 flex items-end bg-slate-900/30 backdrop-blur-[2px]">
              <div className="w-full bg-white rounded-t-3xl shadow-2xl max-h-[78vh] flex flex-col animate-in slide-in-from-bottom duration-200">
                <div className="mx-auto mt-2.5 mb-1 w-10 h-1 rounded-full bg-slate-300" />
                {showDayStep ? (
                  <div className="px-5 pb-6 pt-2 space-y-4">
                    <div>
                      <h2 className="text-lg font-extrabold">Che giorno viaggi?</h2>
                      <p className="text-xs text-slate-500 mt-0.5">Gli orari cambiano in base al giorno.</p>
                    </div>
                    <div className="grid gap-2.5">
                      {dayTypes.map((d) => (
                        <button key={d.id} onClick={() => pickDay(d.id)}
                          className="w-full flex items-center gap-3 px-4 py-4 rounded-2xl bg-slate-50 border border-slate-200 active:scale-[0.98] transition text-left">
                          <span className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0" style={{ backgroundColor: `${col(d.color, "#0e7490")}1a` }}>
                            <CalendarDays className="w-4.5 h-4.5 w-[18px] h-[18px]" style={{ color: col(d.color, "#0e7490") }} />
                          </span>
                          <span className="text-[15px] font-bold text-slate-800">{d.name}</span>
                          <ChevronRight className="w-4 h-4 text-slate-300 ml-auto" />
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="px-5 pb-5 pt-2 space-y-3 flex flex-col min-h-0">
                    <div className="flex items-center gap-2">
                      {needsDay && (
                        <button onClick={backToDays} className="p-1.5 -ml-1.5 rounded-xl active:bg-slate-100 text-slate-500" title="Cambia giorno">
                          <ChevronLeft className="w-5 h-5" />
                        </button>
                      )}
                      <h2 className="text-lg font-extrabold">Scegli la linea</h2>
                      {selectedDay && (
                        <span className="ml-auto text-[11px] font-bold px-2.5 py-1 rounded-full bg-slate-100 text-slate-600">{selectedDay.name}</span>
                      )}
                    </div>
                    <div className="relative">
                      <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                      <input
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="Cerca linea o destinazione…"
                        className="w-full pl-9 pr-3 py-2.5 text-sm rounded-2xl bg-slate-100 border border-transparent outline-none focus:bg-white focus:border-cyan-500 placeholder:text-slate-400"
                      />
                    </div>
                    <div className="overflow-y-auto grid gap-1.5 pb-2">
                      {filteredLines.map(lineRow)}
                      {filteredLines.length === 0 && (
                        <p className="text-xs text-slate-400 py-3 text-center">
                          {search.trim()
                            ? "Nessuna linea trovata"
                            : selectedDay ? `Nessuna linea circola nei giorni "${selectedDay.name}"` : "Nessuna linea disponibile"}
                        </p>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── Pannello orari fermata ── */}
          {stopId && (
            <div className="absolute inset-x-0 bottom-0 md:inset-x-auto md:right-3 md:bottom-3 md:top-3 md:w-[400px] z-20">
              <div className="bg-white md:rounded-3xl rounded-t-3xl border-t md:border border-slate-200 shadow-2xl max-h-[60vh] md:max-h-full h-full md:h-auto flex flex-col overflow-hidden">
                <div className="shrink-0" style={{ height: 5, backgroundColor: lineColor }} />
                <div className="flex items-start gap-2.5 px-4 pt-3 pb-2.5 border-b border-slate-100 shrink-0">
                  <div className="min-w-0 flex-1">
                    <h2 className="text-[15px] font-extrabold leading-tight">{stopQ.data?.stop.name ?? "…"}</h2>
                    <p className="text-[11px] text-slate-500 mt-0.5">
                      <span className="px-1.5 py-0.5 rounded font-extrabold text-white text-[10px] mr-1" style={{ backgroundColor: lineColor }}>{selectedLine?.code}</span>
                      Orari di transito{selectedDay ? ` · ${selectedDay.name}` : ""}
                    </p>
                  </div>
                  <button onClick={() => setStopId(null)} aria-label="Chiudi"
                    className="p-2 rounded-xl hover:bg-slate-100 active:bg-slate-200 text-slate-400 shrink-0">
                    <X className="w-4 h-4" />
                  </button>
                </div>
                <div className="overflow-y-auto px-4 py-3 space-y-4">
                  {stopQ.isLoading && (
                    <p className="text-xs text-slate-500 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin text-cyan-600" /> Carico gli orari…</p>
                  )}
                  {stopQ.isError && errorBanner("Impossibile caricare gli orari della fermata.", () => stopQ.refetch())}
                  {stopQ.data && stopQ.data.departures.length === 0 && (
                    <p className="text-xs text-slate-500">
                      Nessun transito di questa linea dalla fermata{selectedDay ? ` nei giorni "${selectedDay.name}"` : ""}.
                    </p>
                  )}
                  {depGroups.map(([daysLabel, deps]) => (
                    <div key={daysLabel}>
                      <p className="text-[11px] font-extrabold uppercase tracking-wider text-slate-400 flex items-center gap-1.5 mb-2">
                        <Clock className="w-3.5 h-3.5" /> {daysLabel}
                      </p>
                      <div className="flex flex-wrap gap-1.5">
                        {deps.map((d, i) => (
                          <span key={i}
                            title={`${d.headsign ? `→ ${d.headsign}` : ""}${d.onDemand ? " · A CHIAMATA: la corsa va prenotata" : ""}`}
                            className={`px-3 py-2 rounded-xl text-sm font-mono font-bold border ${
                              d.onDemand
                                ? "bg-amber-50 text-amber-700 border-amber-300"
                                : "bg-slate-50 text-slate-800 border-slate-200"
                            }`}>
                            {d.time}
                            {d.onDemand && <PhoneCall className="w-3 h-3 inline-block ml-1 -mt-0.5" />}
                          </span>
                        ))}
                      </div>
                    </div>
                  ))}
                  {stopQ.data && stopQ.data.departures.some((d) => d.onDemand) && (
                    <p className="text-[11px] text-amber-700 flex items-center gap-1.5 pt-2 border-t border-slate-100">
                      <PhoneCall className="w-3.5 h-3.5 shrink-0" />
                      Gli orari evidenziati sono corse <b>a chiamata</b>: si effettuano solo su prenotazione.
                    </p>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* footer validità (solo mobile) */}
        {meta.expiresAt && (
          <div className="md:hidden shrink-0 text-center text-[10px] text-slate-400 py-1 bg-white border-t border-slate-200">
            Orari sempre aggiornati · pagina online fino al {new Date(meta.expiresAt).toLocaleDateString("it-IT")}
          </div>
        )}
      </div>
    </div>
  );
}
