/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SALA OPERATIVA — monitoraggio live della flotta
 * ───────────────────────────────────────────────────────────────────────────
 * Chiude il cerchio Planning → Scheduling → Esercizio: mappa live dei mezzi
 * (posizioni AVM dallo schema caronte), corse attive, ritardi alle fermate e
 * KPI di puntualità della giornata. Polling ogni 10s via TanStack Query
 * (stessa filosofia del resto dell'app: niente websocket, refetch interval).
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { useMemo, useRef, useState, type ReactNode } from "react";
import Map, { Marker, Popup, Source, Layer, type MapRef } from "react-map-gl/mapbox";
import { useQuery } from "@tanstack/react-query";
import {
  Activity, AlertTriangle, Bus, Clock, Crosshair, Gauge, ListOrdered,
  MapPin, Navigation2, Radio, SatelliteDish, TimerOff, TrendingUp, X,
} from "lucide-react";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip as ReTooltip, ResponsiveContainer, Cell,
} from "recharts";
import { apiFetch } from "@/lib/api";
import { MAPBOX_TOKEN, MAP_STYLES } from "./dashboard/constants";

// ── Tipi (allineati a /api/operations/*) ─────────────────────────────────────

interface LiveVehicle {
  vehicleId: string | null;
  tripId: string | null;
  routeId: string | null;
  routeShortName: string | null;
  routeLongName: string | null;
  routeColor: string | null;
  headsign: string | null;
  deviceId: string | null;
  startedAt: string | null;
  lat: number;
  lon: number;
  speed: number | null;
  heading: number | null;
  ts: string;
  nearestStopId: string | null;
  nearestStopName: string | null;
  delaySeconds: number | null;
  lastTransitTs: string | null;
  lastStopSeq: number | null;
  totalStops: number | null;
}

interface LiveSnapshot {
  caronteAvailable: boolean;
  generatedAt?: string;
  windowMinutes?: number;
  vehicles: LiveVehicle[];
  tripsWithoutGps: Array<{
    tripId: string | null; routeId: string | null; routeShortName: string | null;
    routeColor: string | null; headsign: string | null; vehicleId: string | null;
    deviceId: string | null; startedAt: string | null; lastPositionTs: string | null;
  }>;
  kpis: {
    vehiclesActive: number; tripsActive: number; transitsToday: number;
    onTimePct: number | null; latePct: number | null; earlyPct: number | null;
    avgDelaySeconds: number | null; medianDelaySeconds: number | null;
  };
}

interface PunctualityData {
  caronteAvailable: boolean;
  date?: string;
  byRoute: Array<{
    routeId: string | null; routeShortName: string | null; routeLongName: string | null;
    routeColor: string | null; transits: number; trips: number;
    avgDelaySeconds: number | null; maxDelaySeconds: number | null; onTimePct: number | null;
  }>;
  byHour: Array<{ hour: number; transits: number; avgDelaySeconds: number | null; onTimePct: number | null }>;
  worstStops: Array<{ stopId: string | null; stopName: string | null; transits: number; avgDelaySeconds: number | null; maxDelaySeconds: number | null }>;
}

interface TripTransits {
  caronteAvailable: boolean;
  trip: {
    tripId: string; routeId: string | null; headsign: string | null;
    routeShortName: string | null; routeLongName: string | null; routeColor: string | null;
  } | null;
  stops: Array<{
    seq: number | null; stopId: string | null; stopName: string | null;
    lat: number | null; lon: number | null; scheduled: string | null;
    actualTs: string | null; delaySeconds: number | null;
  }>;
}

interface VehicleTrack {
  caronteAvailable: boolean;
  points: Array<{ ts: string; lat: number; lon: number; speed: number | null; heading: number | null; tripId: string | null }>;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

// Stato puntualità: in orario tra 1' di anticipo e 5' di ritardo (standard TPL)
type DelayStatus = "onTime" | "late" | "early" | "unknown";
function delayStatus(s: number | null | undefined): DelayStatus {
  if (s == null) return "unknown";
  if (s > 300) return "late";
  if (s < -60) return "early";
  return "onTime";
}
const STATUS_COLOR: Record<DelayStatus, string> = {
  onTime: "#10b981",  // emerald
  late: "#ef4444",    // red
  early: "#f59e0b",   // amber
  unknown: "#64748b", // slate
};
const STATUS_LABEL: Record<DelayStatus, string> = {
  onTime: "In orario", late: "In ritardo", early: "In anticipo", unknown: "Senza dati",
};

function fmtDelay(s: number | null | undefined): string {
  if (s == null) return "—";
  const sign = s < 0 ? "-" : "+";
  const abs = Math.abs(s);
  const m = Math.floor(abs / 60);
  const ss = abs % 60;
  return `${sign}${m}'${String(ss).padStart(2, "0")}"`;
}

function fmtTime(ts: string | null | undefined): string {
  if (!ts) return "—";
  try { return new Date(ts).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit", second: "2-digit" }); }
  catch { return "—"; }
}

function ageSeconds(ts: string): number {
  return Math.max(0, Math.round((Date.now() - new Date(ts).getTime()) / 1000));
}

function vehicleKey(v: LiveVehicle): string {
  return v.vehicleId ?? v.tripId ?? `${v.lat},${v.lon}`;
}

// ── Pagina ───────────────────────────────────────────────────────────────────

export default function OperationsPage() {
  const mapRef = useRef<MapRef | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [showPunctuality, setShowPunctuality] = useState(false);

  const liveQ = useQuery({
    queryKey: ["operations", "live"],
    queryFn: () => apiFetch<LiveSnapshot>("/api/operations/live"),
    refetchInterval: 10_000,
    refetchOnWindowFocus: true,
    staleTime: 5_000,
  });

  const punctualityQ = useQuery({
    queryKey: ["operations", "punctuality"],
    queryFn: () => apiFetch<PunctualityData>("/api/operations/punctuality"),
    refetchInterval: 60_000,
    enabled: showPunctuality,
  });

  const vehicles = liveQ.data?.vehicles ?? [];
  const selected = useMemo(
    () => vehicles.find((v) => vehicleKey(v) === selectedKey) ?? null,
    [vehicles, selectedKey],
  );

  const transitsQ = useQuery({
    queryKey: ["operations", "transits", selected?.tripId],
    queryFn: () => apiFetch<TripTransits>(`/api/operations/trips/${encodeURIComponent(selected!.tripId!)}/transits`),
    enabled: !!selected?.tripId,
    refetchInterval: 20_000,
  });

  const trackQ = useQuery({
    queryKey: ["operations", "track", selected ? vehicleKey(selected) : null],
    queryFn: () => apiFetch<VehicleTrack>(`/api/operations/vehicles/${encodeURIComponent(vehicleKey(selected!))}/track?minutes=120`),
    enabled: !!selected,
    refetchInterval: 20_000,
  });

  const trackGeojson = useMemo(() => {
    const pts = trackQ.data?.points ?? [];
    if (pts.length < 2) return null;
    return {
      type: "Feature" as const,
      properties: {},
      geometry: { type: "LineString" as const, coordinates: pts.map((p) => [p.lon, p.lat]) },
    };
  }, [trackQ.data]);

  const kpis = liveQ.data?.kpis;

  const flyTo = (v: LiveVehicle) => {
    mapRef.current?.flyTo({ center: [v.lon, v.lat], zoom: Math.max(mapRef.current.getZoom(), 14), duration: 800 });
  };

  const fitFleet = () => {
    if (vehicles.length === 0) return;
    if (vehicles.length === 1) { flyTo(vehicles[0]); return; }
    const lons = vehicles.map((v) => v.lon);
    const lats = vehicles.map((v) => v.lat);
    mapRef.current?.fitBounds(
      [[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]],
      { padding: 120, duration: 800, maxZoom: 14 },
    );
  };

  if (!MAPBOX_TOKEN) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
        VITE_MAPBOX_TOKEN mancante: impossibile mostrare la mappa.
      </div>
    );
  }

  return (
    <div className="relative h-full w-full">
      <Map
        ref={mapRef}
        initialViewState={{ longitude: 13.45, latitude: 43.58, zoom: 10 }}
        mapStyle={MAP_STYLES.dark}
        mapboxAccessToken={MAPBOX_TOKEN}
        attributionControl={false}
      >
        {/* Traccia GPS del mezzo selezionato */}
        {trackGeojson && (
          <Source id="vehicle-track" type="geojson" data={trackGeojson}>
            <Layer
              id="vehicle-track-line"
              type="line"
              paint={{ "line-color": "#38bdf8", "line-width": 3, "line-opacity": 0.55 }}
              layout={{ "line-cap": "round", "line-join": "round" }}
            />
          </Source>
        )}

        {/* Marker mezzi */}
        {vehicles.map((v) => {
          const key = vehicleKey(v);
          const st = delayStatus(v.delaySeconds);
          const isSel = key === selectedKey;
          const stale = ageSeconds(v.ts) > 120;
          return (
            <Marker
              key={key}
              longitude={v.lon}
              latitude={v.lat}
              anchor="center"
              onClick={(e) => {
                e.originalEvent.stopPropagation();
                setSelectedKey(key);
                flyTo(v);
              }}
            >
              <div
                className="relative cursor-pointer group"
                title={`${v.routeShortName ?? "?"} · ${v.vehicleId ?? v.tripId ?? ""}`}
                style={{ opacity: stale ? 0.55 : 1 }}
              >
                {isSel && (
                  <span
                    className="absolute -inset-2 rounded-full animate-ping"
                    style={{ backgroundColor: `${STATUS_COLOR[st]}55` }}
                  />
                )}
                <div
                  className="w-8 h-8 rounded-full border-2 border-white/80 shadow-lg flex items-center justify-center"
                  style={{ backgroundColor: STATUS_COLOR[st] }}
                >
                  {v.heading != null ? (
                    <Navigation2
                      className="w-4 h-4 text-white"
                      style={{ transform: `rotate(${v.heading}deg)` }}
                    />
                  ) : (
                    <Bus className="w-4 h-4 text-white" />
                  )}
                </div>
                <div
                  className="absolute -bottom-1.5 left-1/2 -translate-x-1/2 px-1 rounded text-[9px] font-bold text-white shadow"
                  style={{ backgroundColor: v.routeColor ? `#${v.routeColor.replace(/^#/, "")}` : "#0f172a" }}
                >
                  {v.routeShortName ?? "?"}
                </div>
              </div>
            </Marker>
          );
        })}

        {/* Popup del mezzo selezionato */}
        {selected && (
          <Popup
            longitude={selected.lon}
            latitude={selected.lat}
            anchor="bottom"
            offset={22}
            closeButton={false}
            closeOnClick={false}
            className="operations-popup"
          >
            <div className="text-xs space-y-1 min-w-[180px]">
              <div className="flex items-center gap-2 font-semibold text-sm">
                <span
                  className="px-1.5 py-0.5 rounded text-white text-[11px]"
                  style={{ backgroundColor: selected.routeColor ? `#${selected.routeColor.replace(/^#/, "")}` : "#0f172a" }}
                >
                  {selected.routeShortName ?? "?"}
                </span>
                <span className="truncate">{selected.headsign ?? selected.routeLongName ?? selected.tripId ?? "—"}</span>
              </div>
              <div className="flex items-center gap-1.5 text-muted-foreground">
                <Bus className="w-3 h-3" /> {selected.vehicleId ?? "matricola n/d"}
                {selected.speed != null && <span className="ml-auto font-mono">{Math.round(selected.speed)} km/h</span>}
              </div>
              {selected.nearestStopName && (
                <div className="flex items-center gap-1.5 text-muted-foreground">
                  <MapPin className="w-3 h-3" /> {selected.nearestStopName}
                </div>
              )}
              <div className="flex items-center gap-1.5">
                <Clock className="w-3 h-3" />
                <span style={{ color: STATUS_COLOR[delayStatus(selected.delaySeconds)] }} className="font-semibold">
                  {STATUS_LABEL[delayStatus(selected.delaySeconds)]} {selected.delaySeconds != null && `(${fmtDelay(selected.delaySeconds)})`}
                </span>
              </div>
              {selected.lastStopSeq != null && selected.totalStops != null && selected.totalStops > 0 && (
                <div className="flex items-center gap-1.5 text-muted-foreground">
                  <ListOrdered className="w-3 h-3" />
                  fermata {selected.lastStopSeq}/{selected.totalStops}
                </div>
              )}
              <div className="text-[10px] text-muted-foreground">GPS {fmtTime(selected.ts)} · {ageSeconds(selected.ts)}s fa</div>
            </div>
          </Popup>
        )}
      </Map>

      {/* ── KPI bar in alto ── */}
      <div className="absolute top-3 left-3 right-3 md:right-auto flex flex-wrap gap-2 pointer-events-none">
        <KpiChip icon={<Radio className="w-3.5 h-3.5" />} label="Mezzi in linea" value={String(kpis?.vehiclesActive ?? "—")} accent="#38bdf8" pulse={!!kpis && kpis.vehiclesActive > 0} />
        <KpiChip icon={<Activity className="w-3.5 h-3.5" />} label="Corse attive" value={String(kpis?.tripsActive ?? "—")} accent="#a78bfa" />
        <KpiChip
          icon={<Gauge className="w-3.5 h-3.5" />}
          label="Puntualità oggi"
          value={kpis?.onTimePct != null ? `${kpis.onTimePct}%` : "—"}
          accent={kpis?.onTimePct == null ? "#64748b" : kpis.onTimePct >= 80 ? "#10b981" : kpis.onTimePct >= 60 ? "#f59e0b" : "#ef4444"}
        />
        <KpiChip
          icon={<Clock className="w-3.5 h-3.5" />}
          label="Ritardo medio"
          value={kpis?.avgDelaySeconds != null ? fmtDelay(kpis.avgDelaySeconds) : "—"}
          accent={STATUS_COLOR[delayStatus(kpis?.avgDelaySeconds)]}
        />
        <KpiChip icon={<TrendingUp className="w-3.5 h-3.5" />} label="Transiti oggi" value={String(kpis?.transitsToday ?? "—")} accent="#94a3b8" />
      </div>

      {/* ── Pannello flotta a sinistra ── */}
      <div className="absolute left-3 top-16 bottom-3 w-72 max-w-[85vw] flex flex-col gap-2 pointer-events-none">
        <div className="pointer-events-auto bg-background/85 backdrop-blur-xl border border-border/60 rounded-xl shadow-2xl flex flex-col min-h-0 flex-1">
          <div className="px-3 py-2.5 border-b border-border/50 flex items-center gap-2">
            <SatelliteDish className="w-4 h-4 text-sky-400" />
            <span className="text-sm font-semibold">Flotta live</span>
            <span className="ml-auto text-[10px] text-muted-foreground font-mono">
              {liveQ.isFetching ? "agg…" : liveQ.data?.generatedAt ? fmtTime(liveQ.data.generatedAt) : ""}
            </span>
            <button
              onClick={fitFleet}
              title="Inquadra tutta la flotta"
              className="p-1 rounded hover:bg-white/10 text-muted-foreground hover:text-foreground"
            >
              <Crosshair className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-1.5 space-y-1">
            {liveQ.isLoading && (
              <div className="text-xs text-muted-foreground p-3">Caricamento flotta…</div>
            )}

            {liveQ.data && !liveQ.data.caronteAvailable && (
              <div className="text-xs p-3 space-y-2">
                <div className="flex items-center gap-2 text-amber-400 font-semibold">
                  <AlertTriangle className="w-4 h-4" /> Schema caronte non inizializzato
                </div>
                <p className="text-muted-foreground leading-relaxed">
                  I dati live arrivano dall'AVM Caronte (schema <code>caronte</code> sul database).
                  Esegui la migrazione e collega l'AVM:
                </p>
                <pre className="bg-black/40 rounded p-2 text-[10px] overflow-x-auto">psql "$DATABASE_URL" -f migrations/2026-06_operations_live.sql</pre>
              </div>
            )}

            {liveQ.data?.caronteAvailable && vehicles.length === 0 && (
              <div className="text-xs p-3 space-y-1.5 text-muted-foreground leading-relaxed">
                <div className="flex items-center gap-2 text-foreground font-medium">
                  <TimerOff className="w-4 h-4" /> Nessun mezzo in linea
                </div>
                <p>
                  Quando un autista avvia una corsa dal navigatore AVM (Caronte), il mezzo
                  compare qui in tempo reale con posizione, linea e ritardo.
                </p>
              </div>
            )}

            {vehicles.map((v) => {
              const key = vehicleKey(v);
              const st = delayStatus(v.delaySeconds);
              const isSel = key === selectedKey;
              return (
                <button
                  key={key}
                  onClick={() => { setSelectedKey(key); flyTo(v); }}
                  className={`w-full text-left px-2.5 py-2 rounded-lg transition-all flex items-center gap-2.5 ${
                    isSel ? "bg-sky-500/15 ring-1 ring-sky-500/40" : "hover:bg-white/5"
                  }`}
                >
                  <span
                    className="shrink-0 w-9 h-6 rounded flex items-center justify-center text-[11px] font-bold text-white"
                    style={{ backgroundColor: v.routeColor ? `#${v.routeColor.replace(/^#/, "")}` : "#334155" }}
                  >
                    {v.routeShortName ?? "?"}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-xs font-medium truncate">
                      {v.vehicleId ?? v.headsign ?? v.tripId ?? "mezzo"}
                    </span>
                    <span className="block text-[10px] text-muted-foreground truncate">
                      {v.nearestStopName ?? v.headsign ?? "—"}
                    </span>
                  </span>
                  <span
                    className="shrink-0 text-[10px] font-mono font-semibold px-1.5 py-0.5 rounded"
                    style={{ color: STATUS_COLOR[st], backgroundColor: `${STATUS_COLOR[st]}1a` }}
                  >
                    {v.delaySeconds != null ? fmtDelay(v.delaySeconds) : "GPS"}
                  </span>
                </button>
              );
            })}

            {(liveQ.data?.tripsWithoutGps?.length ?? 0) > 0 && (
              <>
                <div className="px-2 pt-2 pb-1 text-[10px] uppercase tracking-wider text-amber-400/80 font-semibold flex items-center gap-1.5">
                  <AlertTriangle className="w-3 h-3" /> Corse senza GPS recente
                </div>
                {liveQ.data!.tripsWithoutGps.map((t, i) => (
                  <div key={`${t.tripId}-${i}`} className="px-2.5 py-1.5 rounded-lg bg-amber-500/5 border border-amber-500/15 flex items-center gap-2.5">
                    <span
                      className="shrink-0 w-9 h-6 rounded flex items-center justify-center text-[11px] font-bold text-white"
                      style={{ backgroundColor: t.routeColor ? `#${t.routeColor.replace(/^#/, "")}` : "#334155" }}
                    >
                      {t.routeShortName ?? "?"}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-xs truncate">{t.vehicleId ?? t.headsign ?? t.tripId}</span>
                      <span className="block text-[10px] text-muted-foreground">
                        ultimo GPS: {t.lastPositionTs ? fmtTime(t.lastPositionTs) : "mai"}
                      </span>
                    </span>
                  </div>
                ))}
              </>
            )}
          </div>

          <button
            onClick={() => setShowPunctuality((s) => !s)}
            className="m-1.5 px-3 py-2 rounded-lg text-xs font-medium bg-white/5 hover:bg-white/10 transition-colors flex items-center justify-center gap-2"
          >
            <Gauge className="w-3.5 h-3.5" />
            {showPunctuality ? "Nascondi puntualità" : "Analisi puntualità di oggi"}
          </button>
        </div>
      </div>

      {/* ── Drawer dettaglio corsa (destra) ── */}
      {selected && (
        <div className="absolute right-3 top-16 bottom-3 w-80 max-w-[90vw] pointer-events-auto bg-background/85 backdrop-blur-xl border border-border/60 rounded-xl shadow-2xl flex flex-col min-h-0">
          <div className="px-3 py-2.5 border-b border-border/50 flex items-center gap-2">
            <span
              className="px-1.5 py-0.5 rounded text-white text-[11px] font-bold"
              style={{ backgroundColor: selected.routeColor ? `#${selected.routeColor.replace(/^#/, "")}` : "#334155" }}
            >
              {selected.routeShortName ?? "?"}
            </span>
            <span className="text-sm font-semibold truncate flex-1">
              {selected.headsign ?? selected.routeLongName ?? "Corsa"}
            </span>
            <button onClick={() => setSelectedKey(null)} className="p-1 rounded hover:bg-white/10 text-muted-foreground hover:text-foreground">
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="px-3 py-2 text-[11px] text-muted-foreground border-b border-border/40 grid grid-cols-2 gap-x-3 gap-y-1">
            <span>Mezzo: <b className="text-foreground">{selected.vehicleId ?? "n/d"}</b></span>
            <span>Velocità: <b className="text-foreground">{selected.speed != null ? `${Math.round(selected.speed)} km/h` : "—"}</b></span>
            <span>Avvio corsa: <b className="text-foreground">{fmtTime(selected.startedAt)}</b></span>
            <span>GPS: <b className="text-foreground">{ageSeconds(selected.ts)}s fa</b></span>
          </div>

          <div className="flex-1 overflow-y-auto p-2">
            {!selected.tripId && (
              <div className="text-xs text-muted-foreground p-2">Nessuna corsa associata al mezzo.</div>
            )}
            {selected.tripId && transitsQ.isLoading && (
              <div className="text-xs text-muted-foreground p-2">Caricamento transiti…</div>
            )}
            {selected.tripId && transitsQ.data && transitsQ.data.stops.length === 0 && (
              <div className="text-xs text-muted-foreground p-2">Nessun transito registrato per la corsa.</div>
            )}
            {transitsQ.data && transitsQ.data.stops.length > 0 && (
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="text-muted-foreground text-left">
                    <th className="px-1.5 py-1 font-medium">Fermata</th>
                    <th className="px-1.5 py-1 font-medium text-right">Progr.</th>
                    <th className="px-1.5 py-1 font-medium text-right">Reale</th>
                    <th className="px-1.5 py-1 font-medium text-right">Δ</th>
                  </tr>
                </thead>
                <tbody>
                  {transitsQ.data.stops.map((s, i) => {
                    const st = delayStatus(s.delaySeconds);
                    const transited = s.actualTs != null;
                    return (
                      <tr key={`${s.stopId}-${i}`} className={`border-t border-border/30 ${transited ? "" : "opacity-50"}`}>
                        <td className="px-1.5 py-1 truncate max-w-[120px]" title={s.stopName ?? s.stopId ?? ""}>
                          {s.stopName ?? s.stopId ?? "—"}
                        </td>
                        <td className="px-1.5 py-1 text-right font-mono">{s.scheduled?.slice(0, 5) ?? "—"}</td>
                        <td className="px-1.5 py-1 text-right font-mono">{transited ? fmtTime(s.actualTs).slice(0, 5) : "—"}</td>
                        <td className="px-1.5 py-1 text-right font-mono font-semibold" style={{ color: transited ? STATUS_COLOR[st] : undefined }}>
                          {transited && s.delaySeconds != null ? fmtDelay(s.delaySeconds) : ""}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {/* ── Pannello puntualità (in basso) ── */}
      {showPunctuality && (
        <div className="absolute left-3 right-3 md:left-80 md:right-6 bottom-3 max-h-[45%] pointer-events-auto bg-background/90 backdrop-blur-xl border border-border/60 rounded-xl shadow-2xl flex flex-col overflow-hidden">
          <div className="px-4 py-2.5 border-b border-border/50 flex items-center gap-2">
            <Gauge className="w-4 h-4 text-emerald-400" />
            <span className="text-sm font-semibold">Puntualità di oggi</span>
            <span className="text-[10px] text-muted-foreground">in orario = da −1' a +5' (transiti reali alle fermate)</span>
            <button onClick={() => setShowPunctuality(false)} className="ml-auto p-1 rounded hover:bg-white/10 text-muted-foreground hover:text-foreground">
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="flex-1 overflow-auto p-3 grid md:grid-cols-2 gap-4">
            {/* Istogramma per ora */}
            <div className="min-h-[160px]">
              <p className="text-[11px] text-muted-foreground mb-1.5">Puntualità per fascia oraria (%)</p>
              {punctualityQ.data?.byHour?.length ? (
                <ResponsiveContainer width="100%" height={150}>
                  <BarChart data={punctualityQ.data.byHour} margin={{ top: 4, right: 4, bottom: 0, left: -22 }}>
                    <XAxis dataKey="hour" tick={{ fontSize: 10 }} tickFormatter={(h) => `${h}`} />
                    <YAxis domain={[0, 100]} tick={{ fontSize: 10 }} />
                    <ReTooltip
                      contentStyle={{ background: "#0f172a", border: "1px solid #334155", borderRadius: 8, fontSize: 11 }}
                      formatter={(val: any, name: any) => [name === "onTimePct" ? `${val}%` : val, name === "onTimePct" ? "in orario" : name]}
                      labelFormatter={(h) => `Ore ${h}:00`}
                    />
                    <Bar dataKey="onTimePct" radius={[3, 3, 0, 0]}>
                      {punctualityQ.data.byHour.map((h, i) => (
                        <Cell key={i} fill={h.onTimePct == null ? "#64748b" : h.onTimePct >= 80 ? "#10b981" : h.onTimePct >= 60 ? "#f59e0b" : "#ef4444"} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <div className="text-xs text-muted-foreground py-8 text-center">
                  {punctualityQ.isLoading ? "Caricamento…" : "Nessun transito registrato oggi."}
                </div>
              )}
            </div>

            {/* Tabella per linea */}
            <div className="min-h-[160px] overflow-y-auto">
              <p className="text-[11px] text-muted-foreground mb-1.5">Per linea</p>
              {punctualityQ.data?.byRoute?.length ? (
                <table className="w-full text-[11px]">
                  <thead>
                    <tr className="text-muted-foreground text-left">
                      <th className="px-1.5 py-1 font-medium">Linea</th>
                      <th className="px-1.5 py-1 font-medium text-right">Transiti</th>
                      <th className="px-1.5 py-1 font-medium text-right">In orario</th>
                      <th className="px-1.5 py-1 font-medium text-right">Rit. medio</th>
                      <th className="px-1.5 py-1 font-medium text-right">Rit. max</th>
                    </tr>
                  </thead>
                  <tbody>
                    {punctualityQ.data.byRoute.map((r, i) => (
                      <tr key={`${r.routeId}-${i}`} className="border-t border-border/30">
                        <td className="px-1.5 py-1">
                          <span
                            className="inline-flex px-1.5 py-0.5 rounded text-white text-[10px] font-bold"
                            style={{ backgroundColor: r.routeColor ? `#${r.routeColor.replace(/^#/, "")}` : "#334155" }}
                          >
                            {r.routeShortName ?? r.routeId ?? "?"}
                          </span>
                        </td>
                        <td className="px-1.5 py-1 text-right font-mono">{r.transits}</td>
                        <td className="px-1.5 py-1 text-right font-mono font-semibold"
                            style={{ color: r.onTimePct == null ? undefined : r.onTimePct >= 80 ? "#10b981" : r.onTimePct >= 60 ? "#f59e0b" : "#ef4444" }}>
                          {r.onTimePct != null ? `${r.onTimePct}%` : "—"}
                        </td>
                        <td className="px-1.5 py-1 text-right font-mono">{fmtDelay(r.avgDelaySeconds)}</td>
                        <td className="px-1.5 py-1 text-right font-mono">{fmtDelay(r.maxDelaySeconds)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div className="text-xs text-muted-foreground py-8 text-center">
                  {punctualityQ.isLoading ? "Caricamento…" : "Nessun dato per linea."}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── KPI chip ─────────────────────────────────────────────────────────────────

function KpiChip({ icon, label, value, accent, pulse }: {
  icon: ReactNode; label: string; value: string; accent: string; pulse?: boolean;
}) {
  return (
    <div className="pointer-events-auto flex items-center gap-2 px-3 py-1.5 rounded-lg bg-background/85 backdrop-blur-xl border border-border/60 shadow-lg">
      <span className="relative flex items-center justify-center" style={{ color: accent }}>
        {pulse && <span className="absolute inline-flex h-full w-full rounded-full opacity-40 animate-ping" style={{ backgroundColor: accent }} />}
        {icon}
      </span>
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</span>
      <span className="text-sm font-bold font-mono" style={{ color: accent }}>{value}</span>
    </div>
  );
}
