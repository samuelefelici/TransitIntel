/**
 * MAPPA ORARI pubblica (/o/:token) — nessuna autenticazione.
 *
 * Pensata per il PASSEGGERO, non per l'operatore:
 *   1. scegli la linea (chips colorate, ricerca)
 *   2. la mappa accende tutti i percorsi e le fermate della linea
 *   3. tocca una fermata → orari di transito, con le corse A CHIAMATA (📞)
 *      evidenziate e i giorni di validità (Feriale / Sabato / Festivo…)
 *
 * Mobile-first: pannello orari come bottom-sheet, chips scorrevoli, tap
 * target grandi. Dati caricati lazy (linea e fermata su richiesta).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useRoute } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Map as MapGL, Source, Layer, NavigationControl } from "react-map-gl/mapbox";
import type { MapRef } from "react-map-gl/mapbox";
import "mapbox-gl/dist/mapbox-gl.css";
import { Loader2, MapPinned, Search, X, PhoneCall, Clock } from "lucide-react";
import { apiFetch } from "@/lib/api";

const MAPBOX_TOKEN: string = import.meta.env.VITE_MAPBOX_TOKEN || "";

interface MetaResp {
  title: string | null;
  agencyName: string | null;
  lines: Array<{ routeId: string; code: string; longName: string | null; color: string | null }>;
}
interface VariantResp {
  routeId: string;
  variants: Array<{
    variantId: string; code: string; name: string | null; headsign: string | null;
    direction: number; geometry: any | null;
    stops: Array<{ stopId: string; name: string; lat: number; lon: number; seq: number }>;
  }>;
}
interface StopResp {
  stop: { stopId: string; name: string; code: string | null };
  hasValidity: boolean;
  departures: Array<{ time: string; headsign: string | null; variantCode: string | null; onDemand: boolean; days: string[] }>;
}

function col(c: string | null | undefined): string {
  if (!c) return "#2563eb";
  return c.startsWith("#") ? c : `#${c}`;
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

  const [routeId, setRouteId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [stopId, setStopId] = useState<string | null>(null);

  const lines = useMemo(
    () => [...(metaQ.data?.lines ?? [])].sort((a, b) => a.code.localeCompare(b.code, "it", { numeric: true })),
    [metaQ.data],
  );
  const filteredLines = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return lines;
    return lines.filter((l) => l.code.toLowerCase().includes(q) || (l.longName ?? "").toLowerCase().includes(q));
  }, [lines, search]);
  const selectedLine = lines.find((l) => l.routeId === routeId) ?? null;
  const lineColor = col(selectedLine?.color);

  const routeQ = useQuery({
    queryKey: ["timetable-map", token, "route", routeId],
    queryFn: () => apiFetch<VariantResp>(`/api/timetable-map/${encodeURIComponent(token)}/route/${routeId}`),
    enabled: !!token && !!routeId,
    staleTime: 60_000,
  });

  const stopQ = useQuery({
    queryKey: ["timetable-map", token, "stop", stopId, routeId],
    queryFn: () => apiFetch<StopResp>(`/api/timetable-map/${encodeURIComponent(token)}/stop/${stopId}?routeId=${routeId}`),
    enabled: !!token && !!stopId && !!routeId,
    staleTime: 60_000,
  });

  /* GeoJSON percorsi + fermate della linea selezionata */
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
      if (v.geometry?.coordinates?.length) {
        lineFeatures.push({ type: "Feature", properties: { variantId: v.variantId }, geometry: v.geometry });
        for (const c of v.geometry.coordinates) if (Array.isArray(c) && c.length >= 2) extend(c[0], c[1]);
      } else if (v.stops.length >= 2) {
        // fallback senza shape: spezzata tra le fermate
        lineFeatures.push({
          type: "Feature", properties: { variantId: v.variantId },
          geometry: { type: "LineString", coordinates: v.stops.map((s) => [s.lon, s.lat]) },
        });
      }
      for (const s of v.stops) {
        extend(s.lon, s.lat);
        if (seenStops.has(s.stopId)) continue;
        seenStops.add(s.stopId);
        stopFeatures.push({
          type: "Feature",
          properties: { stopId: s.stopId, name: s.name },
          geometry: { type: "Point", coordinates: [s.lon, s.lat] },
        });
      }
    }
    return {
      linesFC: { type: "FeatureCollection", features: lineFeatures } as any,
      stopsFC: { type: "FeatureCollection", features: stopFeatures } as any,
      bounds: Number.isFinite(minLon) ? ([[minLon, minLat], [maxLon, maxLat]] as [[number, number], [number, number]]) : null,
    };
  }, [routeQ.data]);

  /* Zoom automatico sulla linea appena caricata */
  useEffect(() => {
    if (bounds && mapRef.current) {
      mapRef.current.fitBounds(bounds, { padding: 60, duration: 800, maxZoom: 15 });
    }
  }, [bounds]);

  function pickLine(id: string) {
    setRouteId(id);
    setStopId(null);
  }

  /* Raggruppa i transiti per etichetta-giorni (Feriale / Sabato / …) */
  const depGroups = useMemo(() => {
    const deps = stopQ.data?.departures ?? [];
    const groups = new Map<string, StopResp["departures"]>();
    for (const d of deps) {
      const key = d.days.length > 0 ? d.days.join(" · ") : "Tutti i giorni";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(d);
    }
    return [...groups.entries()];
  }, [stopQ.data]);

  if (metaQ.isLoading) {
    return <div className="min-h-screen flex items-center justify-center bg-slate-950 text-white"><Loader2 className="w-6 h-6 animate-spin mr-2" /> Carico la mappa orari…</div>;
  }
  if (metaQ.isError || !metaQ.data) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-slate-950 text-white gap-2 px-6 text-center">
        <MapPinned className="w-8 h-8 text-slate-500" />
        <p className="text-lg font-semibold">Link non valido o scaduto</p>
        <p className="text-sm text-slate-400">Controlla l'indirizzo o richiedi un nuovo link all'azienda di trasporto.</p>
      </div>
    );
  }
  const meta = metaQ.data;

  return (
    <div className="h-screen w-screen flex flex-col bg-slate-950 text-white overflow-hidden">
      {/* ── Header brand + selettore linea ── */}
      <header className="shrink-0 px-3 pt-3 pb-2 space-y-2 bg-slate-950/95 border-b border-slate-800 z-10">
        <div className="flex items-center gap-2">
          <MapPinned className="w-5 h-5 text-cyan-400 shrink-0" />
          <div className="min-w-0">
            <h1 className="text-sm font-bold leading-tight truncate">{meta.title || "Mappa Orari"}</h1>
            {meta.agencyName && <p className="text-[11px] text-slate-400 leading-tight truncate">{meta.agencyName}</p>}
          </div>
          <div className="ml-auto relative">
            <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-slate-500" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Cerca linea…"
              className="w-36 sm:w-52 pl-7 pr-2 py-1.5 text-xs rounded-lg bg-slate-900 border border-slate-700 outline-none focus:border-cyan-500/60 placeholder:text-slate-500"
            />
          </div>
        </div>
        {/* chips linee — scorrevoli in orizzontale, tap target grandi */}
        <div className="flex gap-1.5 overflow-x-auto pb-1 -mx-1 px-1" style={{ scrollbarWidth: "thin" }}>
          {filteredLines.map((l) => {
            const active = l.routeId === routeId;
            const c = col(l.color);
            return (
              <button
                key={l.routeId}
                onClick={() => pickLine(l.routeId)}
                title={l.longName ?? l.code}
                className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-bold border transition-all ${
                  active ? "text-white shadow-lg scale-105" : "text-slate-200 bg-slate-900 hover:scale-105"
                }`}
                style={active
                  ? { backgroundColor: c, borderColor: c }
                  : { borderColor: `${c}66` }}
              >
                <span className="inline-block w-2 h-2 rounded-full mr-1.5 align-middle" style={{ backgroundColor: c }} />
                {l.code}
              </button>
            );
          })}
          {filteredLines.length === 0 && (
            <span className="text-xs text-slate-500 py-1.5">Nessuna linea trovata</span>
          )}
        </div>
        {selectedLine ? (
          <p className="text-[11px] text-slate-400 truncate">
            <span className="font-semibold" style={{ color: lineColor }}>Linea {selectedLine.code}</span>
            {selectedLine.longName ? ` — ${selectedLine.longName}` : ""} · tocca una fermata sulla mappa per gli orari
          </p>
        ) : (
          <p className="text-[11px] text-slate-400">👆 Scegli una linea per vederne percorsi e fermate</p>
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
                  paint={{ "line-color": "#ffffff", "line-width": 7, "line-opacity": 0.85 }}
                  layout={{ "line-cap": "round", "line-join": "round" }} />
                <Layer id="tm-lines-core" type="line"
                  paint={{ "line-color": lineColor, "line-width": 4 }}
                  layout={{ "line-cap": "round", "line-join": "round" }} />
              </Source>
              <Source id="tm-stops-src" type="geojson" data={stopsFC}>
                <Layer id="tm-stops" type="circle"
                  paint={{
                    "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 4, 14, 8],
                    "circle-color": "#ffffff",
                    "circle-stroke-color": lineColor,
                    "circle-stroke-width": 2.5,
                  }} />
                <Layer id="tm-stop-labels" type="symbol" minzoom={13}
                  layout={{
                    "text-field": ["get", "name"],
                    "text-size": 11,
                    "text-offset": [0, 1.1],
                    "text-anchor": "top",
                  }}
                  paint={{ "text-color": "#0f172a", "text-halo-color": "#ffffff", "text-halo-width": 1.4 }} />
              </Source>
            </>
          )}
        </MapGL>

        {routeQ.isLoading && (
          <div className="absolute inset-x-0 top-3 flex justify-center pointer-events-none">
            <span className="px-3 py-1.5 rounded-full bg-slate-900/90 border border-slate-700 text-xs flex items-center gap-2">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Carico i percorsi della linea…
            </span>
          </div>
        )}

        {/* ── Pannello orari fermata: sheet in basso (mobile) / card a destra (desktop) ── */}
        {stopId && (
          <div className="absolute inset-x-0 bottom-0 sm:inset-x-auto sm:right-3 sm:bottom-3 sm:top-3 sm:w-[380px] z-20">
            <div className="bg-slate-950/97 sm:rounded-2xl border-t sm:border border-slate-700 shadow-2xl max-h-[55vh] sm:max-h-full h-full sm:h-auto flex flex-col overflow-hidden">
              <div className="flex items-start gap-2 px-4 pt-3 pb-2 border-b border-slate-800 shrink-0">
                <div className="w-3 h-3 rounded-full mt-1 shrink-0 border-2 border-white" style={{ backgroundColor: lineColor }} />
                <div className="min-w-0 flex-1">
                  <h2 className="text-sm font-bold leading-tight">{stopQ.data?.stop.name ?? "…"}</h2>
                  <p className="text-[11px] text-slate-400">
                    Orari di transito · Linea {selectedLine?.code}
                  </p>
                </div>
                <button onClick={() => setStopId(null)} aria-label="Chiudi"
                  className="p-1.5 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-white shrink-0">
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="overflow-y-auto px-4 py-3 space-y-4">
                {stopQ.isLoading && (
                  <p className="text-xs text-slate-400 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Carico gli orari…</p>
                )}
                {stopQ.data && stopQ.data.departures.length === 0 && (
                  <p className="text-xs text-slate-400">Nessun transito di questa linea dalla fermata.</p>
                )}
                {depGroups.map(([daysLabel, deps]) => (
                  <div key={daysLabel}>
                    <p className="text-[11px] font-bold uppercase tracking-wide text-cyan-300 flex items-center gap-1.5 mb-1.5">
                      <Clock className="w-3.5 h-3.5" /> {daysLabel}
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {deps.map((d, i) => (
                        <span key={i}
                          title={`${d.headsign ? `→ ${d.headsign}` : ""}${d.onDemand ? " · A CHIAMATA: la corsa va prenotata" : ""}`}
                          className={`px-2.5 py-1.5 rounded-lg text-sm font-mono font-semibold border ${
                            d.onDemand
                              ? "bg-amber-500/15 text-amber-300 border-amber-500/40"
                              : "bg-slate-900 text-white border-slate-700"
                          }`}>
                          {d.time}
                          {d.onDemand && <PhoneCall className="w-3 h-3 inline-block ml-1 -mt-0.5" />}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
                {stopQ.data && stopQ.data.departures.some((d) => d.onDemand) && (
                  <p className="text-[11px] text-amber-300/90 flex items-center gap-1.5 pt-1 border-t border-slate-800">
                    <PhoneCall className="w-3.5 h-3.5 shrink-0" />
                    Gli orari evidenziati sono corse <b>a chiamata</b>: si effettuano solo su prenotazione.
                  </p>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
