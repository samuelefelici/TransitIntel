/**
 * Trip Planner — Game Maps style v2
 *
 * Pianifica un viaggio porta-a-porta con supporto multi-bus (1 cambio):
 *   walk → bus 1 → [transfer → bus 2] → walk
 *
 * Features:
 *   • Mappa outdoors (verde, ricca di dettagli)
 *   • Input indirizzi con autocompletamento Mapbox Geocoding
 *   • Polilinee bus enfatizzate con dasharray animato (effetto flusso)
 *   • Combinazioni multi-bus con marker di trasferimento
 *
 * Backend: POST /api/fares/journey-plan
 */
import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";
import Map, {
  Marker, Source, Layer, NavigationControl, type MapRef,
} from "react-map-gl/mapbox";
import "mapbox-gl/dist/mapbox-gl.css";
import { motion, AnimatePresence } from "framer-motion";
import {
  Navigation, Footprints, Bus, Clock, Route as RouteIcon,
  Crosshair, RotateCcw, Loader2, Trophy, PiggyBank, Zap, ArrowRight,
  Sparkles, Target, Flag, Search, Repeat, MapPin,
} from "lucide-react";
import { getApiBase } from "@/lib/api";

const BASE = () => getApiBase();
const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN || "";

/* ── Tipi ─────────────────────────────────────────────────── */
interface LatLon { lat: number; lon: number; label?: string }

type WalkLeg = {
  kind: "walk";
  fromName: string; toName: string;
  distanceM: number; durationMin: number;
  fromLat: number; fromLon: number; toLat: number; toLon: number;
};
type BusLeg = {
  kind: "bus";
  tripId: string; routeId: string;
  routeShortName: string; routeLongName: string;
  routeColor: string; routeTextColor: string;
  headsign: string;
  network: string; networkLabel: string;
  fromStop: { stopId: string; name: string; lat: number; lon: number };
  toStop:   { stopId: string; name: string; lat: number; lon: number };
  depTime: string; arrTime: string;
  busMin: number; numStops: number; distanceKm: number;
  amount: number; fareName: string; fascia: number | null; bandRange: string | null;
  segmentShape: [number, number][];
};
type TransferLeg = {
  kind: "transfer";
  hubStopName: string; durationMin: number; lat: number; lon: number;
};
type Leg = WalkLeg | BusLeg | TransferLeg;

interface JourneyAlt {
  kind: "direct" | "transfer";
  legs: Leg[];
  totalMin: number; totalWalkM: number; totalAmount: number;
  depTime: string; arrTime: string;
  badges?: string[];
}
interface JourneyResponse {
  query: any;
  alternatives: JourneyAlt[];
  reason?: string;
  extendedWalk?: boolean;
  nearOriginCount?: number;
  nearDestCount?: number;
}

interface GeoResult { id: string; name: string; place: string; lat: number; lon: number }

/* ── Utils ────────────────────────────────────────────────── */
const fmtMin = (m: number) => m < 60 ? `${m} min` : `${Math.floor(m/60)}h ${m%60}m`;
const fmtPrice = (n: number) => `€ ${n.toFixed(2).replace(".", ",")}`;
const fmtTime = (s: string) => s.slice(0, 5);
const fmtDateLabel = (d: string) => {
  if (!d || d.length !== 8) return d;
  const dt = new Date(`${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}T00:00:00`);
  return dt.toLocaleDateString("it-IT", { weekday: "short", day: "numeric", month: "short" });
};

const BADGE_META: Record<string, { label: string; icon: any; cls: string }> = {
  fastest:   { label: "Più Veloce",    icon: Zap,        cls: "from-amber-500/20 to-orange-500/20 border-amber-500/40 text-amber-200" },
  cheapest:  { label: "Più Economico", icon: PiggyBank,  cls: "from-emerald-500/20 to-green-500/20 border-emerald-500/40 text-emerald-200" },
  leastWalk: { label: "Meno Cammino",  icon: Trophy,     cls: "from-cyan-500/20 to-sky-500/20 border-cyan-500/40 text-cyan-200" },
};

const busLegs = (a: JourneyAlt): BusLeg[] => a.legs.filter((l): l is BusLeg => l.kind === "bus");

/* ── Pagina ───────────────────────────────────────────────── */
export default function TripPlanner() {
  const mapRef = useRef<MapRef | null>(null);

  const [origin, setOrigin] = useState<LatLon | null>(null);
  const [dest, setDest]     = useState<LatLon | null>(null);
  const [pickMode, setPickMode] = useState<"origin" | "dest" | null>("origin");

  const today = new Date();
  const defaultDate = `${today.getFullYear()}${String(today.getMonth()+1).padStart(2,"0")}${String(today.getDate()).padStart(2,"0")}`;
  const [date, setDate] = useState<string>(defaultDate);
  const [time, setTime] = useState<string>("08:00");
  const [allowTransfers, setAllowTransfers] = useState<boolean>(true);

  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<JourneyResponse | null>(null);
  const [selectedIdx, setSelectedIdx] = useState<number>(0);
  const [detailsOpen, setDetailsOpen] = useState<boolean>(false);

  const [availableDates, setAvailableDates] = useState<string[]>([]);

  useEffect(() => {
    fetch(`${BASE()}/api/fares/simulator/dates`)
      .then(r => r.ok ? r.json() : [])
      .then((d: any[]) => {
        const ds = d.map(x => x.date as string);
        setAvailableDates(ds);
        if (ds.length > 0 && !ds.includes(defaultDate)) setDate(ds[0]);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleMapClick = useCallback((e: any) => {
    const { lng, lat } = e.lngLat;
    const p: LatLon = { lat, lon: lng };
    if (pickMode === "origin") { setOrigin(p); setPickMode("dest"); }
    else if (pickMode === "dest") { setDest(p); setPickMode(null); }
    setResult(null);
  }, [pickMode]);

  const compute = async () => {
    if (!origin || !dest) return;
    setLoading(true); setResult(null);
    try {
      const r = await fetch(`${BASE()}/api/fares/journey-plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: origin, to: dest, date, time, maxWalkM: 1500, allowTransfers }),
      });
      const data = await r.json();
      setResult(data);
      setSelectedIdx(0);
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  };

  // Fit bounds
  useEffect(() => {
    if (!mapRef.current) return;
    if (origin && dest) {
      const minLon = Math.min(origin.lon, dest.lon);
      const maxLon = Math.max(origin.lon, dest.lon);
      const minLat = Math.min(origin.lat, dest.lat);
      const maxLat = Math.max(origin.lat, dest.lat);
      mapRef.current.fitBounds(
        [[minLon, minLat], [maxLon, maxLat]],
        { padding: { top: 80, bottom: 80, left: 460, right: 60 }, duration: 800 }
      );
    } else if (origin) {
      mapRef.current.flyTo({ center: [origin.lon, origin.lat], zoom: 13, duration: 600 });
    } else if (dest) {
      mapRef.current.flyTo({ center: [dest.lon, dest.lat], zoom: 13, duration: 600 });
    }
  }, [origin, dest]);

  const reset = () => {
    setOrigin(null); setDest(null); setResult(null); setPickMode("origin");
  };

  // ── 🐙 Virgilio: ascolta evento 'virgilio:plan-trip' e simula la compilazione del form
  useEffect(() => {
    (window as any).__virgilioTripPlannerReady = true;
    const handler = (e: Event) => {
      const d = (e as CustomEvent).detail as {
        origin_lat: number; origin_lon: number; origin_label?: string;
        dest_lat: number; dest_lon: number; dest_label?: string;
        date?: string; time?: string; allow_transfers?: boolean;
      };
      if (!d) return;
      const o: LatLon = { lat: d.origin_lat, lon: d.origin_lon, label: d.origin_label };
      const dst: LatLon = { lat: d.dest_lat, lon: d.dest_lon, label: d.dest_label };
      // Animazione "macchina da scrivere" — riempie i campi visualmente uno alla volta
      setPickMode(null);
      setResult(null);
      setOrigin(null);
      setDest(null);
      setTimeout(() => setOrigin(o), 200);
      setTimeout(() => setDest(dst), 800);
      if (d.date) setTimeout(() => setDate(d.date!), 1100);
      if (d.time) setTimeout(() => setTime(d.time!), 1300);
      if (typeof d.allow_transfers === "boolean") {
        setTimeout(() => setAllowTransfers(d.allow_transfers!), 1500);
      }
      // Click "Calcola viaggio"
      setTimeout(async () => {
        if (!o.lat || !dst.lat) return;
        setLoading(true); setResult(null);
        try {
          const r = await fetch(`${BASE()}/api/fares/journey-plan`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              from: o, to: dst,
              date: d.date || date,
              time: d.time || time,
              maxWalkM: 1500,
              allowTransfers: typeof d.allow_transfers === "boolean" ? d.allow_transfers : allowTransfers,
            }),
          });
          const data = await r.json();
          setResult(data);
          setSelectedIdx(0);
        } catch (err) { console.error(err); }
        finally { setLoading(false); }
      }, 1900);
    };
    window.addEventListener("virgilio:plan-trip", handler as EventListener);
    return () => {
      window.removeEventListener("virgilio:plan-trip", handler as EventListener);
      (window as any).__virgilioTripPlannerReady = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selected = result?.alternatives?.[selectedIdx];
  const selectedBusLegs = useMemo(() => selected ? busLegs(selected) : [], [selected]);

  // Camminate (walk legs come dashed lines)
  const walkLines = useMemo(() => {
    if (!selected) return null;
    const features: GeoJSON.Feature[] = selected.legs
      .filter((l): l is WalkLeg => l.kind === "walk")
      .map((w, i) => ({
        type: "Feature",
        geometry: { type: "LineString", coordinates: [[w.fromLon, w.fromLat], [w.toLon, w.toLat]] },
        properties: { idx: i },
      }));
    if (features.length === 0) return null;
    return { type: "FeatureCollection", features } as GeoJSON.FeatureCollection;
  }, [selected]);

  // Hub di trasferimento
  const transferHubs = useMemo(() => {
    if (!selected) return [] as TransferLeg[];
    return selected.legs.filter((l): l is TransferLeg => l.kind === "transfer");
  }, [selected]);

  return (
    <div className="relative h-[calc(100vh-1px)] w-full overflow-hidden bg-[#0a1410]">
      {/* Tinta verde ambient */}
      <div className="pointer-events-none absolute inset-0 z-[5] bg-gradient-to-br from-emerald-500/5 via-transparent to-lime-500/5 mix-blend-screen" />

      {/* ── Mappa ── */}
      {MAPBOX_TOKEN ? (
        <Map
          ref={mapRef}
          mapboxAccessToken={MAPBOX_TOKEN}
          initialViewState={{ longitude: 13.5, latitude: 43.6, zoom: 9 }}
          style={{ width: "100%", height: "100%" }}
          mapStyle="mapbox://styles/mapbox/dark-v11"
          onClick={handleMapClick}
          onLoad={(e) => {
            const m = e.target;
            // Tweak: tinte verde scuro ai layer naturali per "dark + accenti verdi"
            const greenTweaks: Record<string, string> = {
              "land": "#0a1410",
              "landuse": "#0d2419",
              "national-park": "#0e3a2a",
              "landuse-park": "#0e3a2a",
              "park": "#0e3a2a",
              "pitch": "#0e3a2a",
              "pitch-line": "#10b981",
              "water": "#062017",
              "waterway": "#0a3326",
              "natural": "#0d2419",
              "wood": "#0e3a2a",
              "scrub": "#0d2419",
              "grass": "#0e3a2a",
            };
            try {
              const layers = m.getStyle()?.layers ?? [];
              for (const layer of layers) {
                for (const key of Object.keys(greenTweaks)) {
                  if (layer.id.includes(key) && (layer.type === "fill" || layer.type === "background")) {
                    try { m.setPaintProperty(layer.id, "fill-color" as any, greenTweaks[key]); } catch {}
                    try { m.setPaintProperty(layer.id, "background-color" as any, greenTweaks[key]); } catch {}
                  }
                }
                // strade più verdognole
                if (layer.type === "line" && /road|street|tunnel|bridge/.test(layer.id) && !/label|shield/.test(layer.id)) {
                  try { m.setPaintProperty(layer.id, "line-color" as any, "#1a3a2e"); } catch {}
                }
              }
            } catch (err) { /* noop */ }
          }}
          cursor={pickMode ? "crosshair" : "grab"}
        >
          <NavigationControl position="bottom-right" />

          {/* camminate */}
          {walkLines && (
            <Source id="walks" type="geojson" data={walkLines}>
              <Layer
                id="walk-glow"
                type="line"
                paint={{
                  "line-color": "#34d399",
                  "line-width": 8,
                  "line-opacity": 0.25,
                  "line-blur": 4,
                }}
              />
              <Layer
                id="walk-line"
                type="line"
                paint={{
                  "line-color": "#6ee7b7",
                  "line-width": 3,
                  "line-dasharray": [1.5, 1.5],
                  "line-opacity": 0.95,
                }}
              />
            </Source>
          )}

          {/* bus legs — effetto NEON multi-layer */}
          {selectedBusLegs.map((leg, i) => {
            const fc: GeoJSON.Feature = {
              type: "Feature",
              geometry: { type: "LineString", coordinates: leg.segmentShape },
              properties: {},
            };
            return (
              <Source key={`bus-${i}`} id={`bus-${i}`} type="geojson" data={fc}>
                {/* halo esterno molto soft */}
                <Layer
                  id={`bus-halo-${i}`}
                  type="line"
                  paint={{
                    "line-color": leg.routeColor,
                    "line-width": 28,
                    "line-opacity": 0.12,
                    "line-blur": 14,
                  }}
                  layout={{ "line-cap": "round", "line-join": "round" }}
                />
                {/* glow medio */}
                <Layer
                  id={`bus-glow-${i}`}
                  type="line"
                  paint={{
                    "line-color": leg.routeColor,
                    "line-width": 16,
                    "line-opacity": 0.35,
                    "line-blur": 6,
                  }}
                  layout={{ "line-cap": "round", "line-join": "round" }}
                />
                {/* glow stretto e intenso */}
                <Layer
                  id={`bus-inner-glow-${i}`}
                  type="line"
                  paint={{
                    "line-color": leg.routeColor,
                    "line-width": 9,
                    "line-opacity": 0.65,
                    "line-blur": 2,
                  }}
                  layout={{ "line-cap": "round", "line-join": "round" }}
                />
                {/* anima neon: bianca brillante con sfumatura colore */}
                <Layer
                  id={`bus-line-${i}`}
                  type="line"
                  paint={{
                    "line-color": leg.routeColor,
                    "line-width": 4.5,
                    "line-opacity": 1,
                  }}
                  layout={{ "line-cap": "round", "line-join": "round" }}
                />
                {/* core bianco luminoso al centro */}
                <Layer
                  id={`bus-core-${i}`}
                  type="line"
                  paint={{
                    "line-color": "#ffffff",
                    "line-width": 1.5,
                    "line-opacity": 0.95,
                    "line-blur": 0.5,
                  }}
                  layout={{ "line-cap": "round", "line-join": "round" }}
                />
              </Source>
            );
          })}

          {/* marker origine */}
          {origin && (
            <Marker longitude={origin.lon} latitude={origin.lat} anchor="bottom">
              <PinMarker color="#10b981" icon={<Flag className="w-4 h-4 text-white" />} pulse />
            </Marker>
          )}
          {dest && (
            <Marker longitude={dest.lon} latitude={dest.lat} anchor="bottom">
              <PinMarker color="#dc2626" icon={<Target className="w-4 h-4 text-white" />} pulse />
            </Marker>
          )}

          {/* fermate dei bus + transfer hubs */}
          {selectedBusLegs.map((leg, i) => (
            <React.Fragment key={`stops-${i}`}>
              <Marker longitude={leg.fromStop.lon} latitude={leg.fromStop.lat} anchor="center">
                <StopDot color={leg.routeColor} label={leg.routeShortName} />
              </Marker>
              <Marker longitude={leg.toStop.lon} latitude={leg.toStop.lat} anchor="center">
                <StopDot color={leg.routeColor} label={leg.routeShortName} ring />
              </Marker>
            </React.Fragment>
          ))}
          {transferHubs.map((h, i) => (
            <Marker key={`hub-${i}`} longitude={h.lon} latitude={h.lat} anchor="center">
              <TransferHub label={`${h.durationMin}'`} />
            </Marker>
          ))}
        </Map>
      ) : (
        <div className="h-full w-full flex items-center justify-center text-emerald-300/60 text-sm">
          Token Mapbox non configurato (VITE_MAPBOX_TOKEN)
        </div>
      )}

      {/* ── HUD overlay sx ── */}
      <div className="absolute inset-y-0 left-0 z-10 w-full md:w-[440px] p-3 flex flex-col gap-3 pointer-events-none">

        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }}
          className="pointer-events-auto rounded-2xl border border-emerald-400/40 bg-zinc-950/85 backdrop-blur-xl shadow-[0_8px_32px_rgba(16,185,129,0.25)]"
        >
          <div className="px-4 py-3 flex items-center gap-3 border-b border-emerald-400/20">
            <div className="relative">
              <div className="absolute inset-0 rounded-full bg-emerald-400/40 blur-lg" />
              <Navigation className="relative w-5 h-5 text-emerald-300" />
            </div>
            <div className="min-w-0 flex-1">
              <h1 className="text-sm font-black tracking-wide bg-gradient-to-r from-emerald-300 via-green-300 to-lime-300 bg-clip-text text-transparent drop-shadow-[0_0_8px_rgba(16,185,129,0.5)]">
                TRIP PLANNER
              </h1>
              <p className="text-[10px] text-emerald-300/70 font-mono">door-to-door · multi-bus · v2</p>
            </div>
            <button
              onClick={reset} title="Reset"
              className="p-1.5 rounded-lg text-emerald-300/70 hover:text-emerald-200 hover:bg-emerald-500/15 transition"
            >
              <RotateCcw className="w-4 h-4" />
            </button>
          </div>

          {/* Inputs origin/dest */}
          <div className="p-3 space-y-2">
            <PointRow
              label="Da"
              icon={<Flag className="w-3.5 h-3.5" />}
              point={origin}
              active={pickMode === "origin"}
              onActivate={() => setPickMode("origin")}
              onClear={() => { setOrigin(null); setResult(null); }}
              onPick={(p) => { setOrigin(p); setResult(null); if (!dest) setPickMode("dest"); else setPickMode(null); }}
              accent="emerald"
            />
            <PointRow
              label="A"
              icon={<Target className="w-3.5 h-3.5" />}
              point={dest}
              active={pickMode === "dest"}
              onActivate={() => setPickMode("dest")}
              onClear={() => { setDest(null); setResult(null); }}
              onPick={(p) => { setDest(p); setResult(null); setPickMode(null); }}
              accent="rose"
            />

            <div className="text-[10px] text-emerald-300/80 px-1 flex items-center gap-1.5">
              <Crosshair className="w-3 h-3" />
              {pickMode === "origin" ? "Cerca un indirizzo o clicca sulla mappa per l'origine"
                : pickMode === "dest" ? "Cerca un indirizzo o clicca sulla mappa per la destinazione"
                : "Pronto — modifica i punti se necessario"}
            </div>

            {/* Data + Ora + Transfers */}
            <div className="grid grid-cols-[1fr_100px] gap-2 pt-1">
              <div className="bg-black/40 border border-emerald-400/25 rounded-lg px-2.5 py-1.5">
                <label className="text-[9px] text-emerald-300/70 uppercase tracking-widest">Data</label>
                <select
                  value={date} onChange={e => setDate(e.target.value)}
                  className="w-full bg-transparent text-[12px] text-emerald-100 focus:outline-none cursor-pointer"
                >
                  {availableDates.length === 0 && <option value={date} className="bg-zinc-900">{fmtDateLabel(date)}</option>}
                  {availableDates.map(d => (
                    <option key={d} value={d} className="bg-zinc-900">{fmtDateLabel(d)}</option>
                  ))}
                </select>
              </div>
              <div className="bg-black/40 border border-emerald-400/25 rounded-lg px-2.5 py-1.5">
                <label className="text-[9px] text-emerald-300/70 uppercase tracking-widest">Ora</label>
                <input
                  type="time" value={time} onChange={e => setTime(e.target.value)}
                  className="w-full bg-transparent text-[12px] text-emerald-100 focus:outline-none [color-scheme:dark]"
                />
              </div>
            </div>

            <label className="flex items-center gap-2 px-1 text-[11px] text-emerald-200/90 cursor-pointer select-none">
              <input
                type="checkbox" checked={allowTransfers}
                onChange={e => setAllowTransfers(e.target.checked)}
                className="accent-emerald-500"
              />
              <Repeat className="w-3 h-3" /> Considera combinazioni con cambio bus
            </label>

            <button
              onClick={compute}
              disabled={!origin || !dest || loading}
              className="w-full mt-1 h-10 rounded-xl font-bold text-sm tracking-wide
                         bg-gradient-to-r from-emerald-400 via-green-400 to-lime-400
                         text-black shadow-[0_4px_24px_rgba(16,185,129,0.55)]
                         hover:shadow-[0_6px_32px_rgba(16,185,129,0.85)]
                         disabled:opacity-40 disabled:cursor-not-allowed
                         transition-all flex items-center justify-center gap-2"
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
              {loading ? "Calcolo in corso…" : "Calcola viaggio"}
            </button>
          </div>
        </motion.div>

        {/* Risultati */}
        <div className="pointer-events-auto flex-1 overflow-y-auto pr-1 space-y-2">
          <AnimatePresence>
            {loading && <ComputingCard key="loading" />}
            {result && !loading && result.alternatives.length === 0 && (
              <motion.div key="empty"
                initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
                className="rounded-2xl border border-amber-500/30 bg-amber-950/60 backdrop-blur-xl p-4 text-amber-200 text-xs"
              >
                Nessun viaggio trovato. {result.reason ?? "Prova un'altra ora o data."}
              </motion.div>
            )}
            {result && !loading && result.alternatives.length > 0 && result.extendedWalk && (
              <motion.div key="extwalk"
                initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
                className="rounded-2xl border border-amber-500/30 bg-amber-950/40 backdrop-blur-xl px-3 py-2 text-amber-200 text-[11px] flex items-start gap-2"
              >
                <span className="text-base leading-none">🚶</span>
                <span>
                  <strong>Camminata estesa:</strong> nessuna fermata bus entro 1.5 km dal punto selezionato.
                  Mostro le alternative con le fermate più vicine — preparati a camminare di più.
                </span>
              </motion.div>
            )}
            {result && !loading && result.alternatives.map((alt, idx) => (
              <AltCard key={idx}
                alt={alt} index={idx}
                selected={idx === selectedIdx}
                onSelect={() => { setSelectedIdx(idx); setDetailsOpen(false); }}
                onOpenDetails={() => setDetailsOpen(true)}
              />
            ))}
          </AnimatePresence>
        </div>
      </div>

      {/* ── Modal Dettagli ── */}
      <AnimatePresence>
        {detailsOpen && selected && (
          <DetailModal
            alt={selected}
            origin={origin} dest={dest}
            date={date} time={time}
            onClose={() => setDetailsOpen(false)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

/* ── Sub-componenti ────────────────────────────────────────── */

function PointRow({
  label, icon, point, active, onActivate, onClear, onPick, accent,
}: {
  label: string; icon: React.ReactNode; point: LatLon | null;
  active: boolean; onActivate: () => void; onClear: () => void;
  onPick: (p: LatLon) => void;
  accent: "emerald" | "rose";
}) {
  const colors = accent === "emerald"
    ? { bg: "bg-emerald-500/15", border: "border-emerald-400/60", text: "text-emerald-300", focus: "focus-within:border-emerald-400" }
    : { bg: "bg-rose-500/15", border: "border-rose-400/60", text: "text-rose-300", focus: "focus-within:border-rose-400" };

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<GeoResult[]>([]);
  const [showResults, setShowResults] = useState(false);
  const [loadingGeo, setLoadingGeo] = useState(false);
  const debounceRef = useRef<any>(null);

  useEffect(() => {
    if (point?.label) setQuery(point.label);
    else if (point) setQuery(`${point.lat.toFixed(5)}, ${point.lon.toFixed(5)}`);
    else setQuery("");
  }, [point]);

  const search = useCallback(async (q: string) => {
    if (!MAPBOX_TOKEN || q.trim().length < 2) { setResults([]); return; }
    setLoadingGeo(true);
    try {
      // Bbox Marche allargato: lon 12.18–13.92, lat 42.69–43.97
      const baseUrl = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(q)}.json`
        + `?access_token=${MAPBOX_TOKEN}&country=it&language=it&autocomplete=true&limit=8`
        + `&proximity=13.51,43.61`;
      // 1) Try restricted (Marche bbox + tipi indirizzo/poi)
      const url1 = baseUrl + `&bbox=12.18,42.69,13.92,43.97&types=address,poi,place,locality,neighborhood,postcode`;
      let r = await fetch(url1).then(x => x.json()).catch(() => ({ features: [] }));
      let feats: any[] = r.features || [];
      // 2) Fallback senza bbox (per indirizzi fuori regione o nomi ambigui)
      if (feats.length < 3) {
        const url2 = baseUrl + `&types=address,poi,place,locality,neighborhood,postcode`;
        const r2 = await fetch(url2).then(x => x.json()).catch(() => ({ features: [] }));
        const seen = new Set(feats.map((f: any) => f.id));
        for (const f of r2.features || []) if (!seen.has(f.id)) feats.push(f);
      }
      // 3) Fallback finale senza filtro types
      if (feats.length === 0) {
        const url3 = baseUrl;
        const r3 = await fetch(url3).then(x => x.json()).catch(() => ({ features: [] }));
        feats = r3.features || [];
      }
      setResults(feats.slice(0, 8).map((f: any): GeoResult => ({
        id: f.id,
        name: f.text || f.place_name,
        place: f.place_name,
        lat: f.center[1], lon: f.center[0],
      })));
    } finally {
      setLoadingGeo(false);
    }
  }, []);

  const onChange = (v: string) => {
    setQuery(v);
    setShowResults(true);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => search(v), 300);
  };

  return (
    <div
      onClick={onActivate}
      className={`relative rounded-lg border transition-all
        ${active ? `${colors.bg} ${colors.border} shadow-[0_0_0_2px_rgba(16,185,129,0.20)_inset]`
                 : `bg-black/40 border-white/10 hover:border-white/25 ${colors.focus}`}`}
    >
      <div className="flex items-center gap-2.5 px-2.5 py-2">
        <span className={`shrink-0 w-7 h-7 rounded-md flex items-center justify-center ${colors.bg} ${colors.text}`}>
          {icon}
        </span>
        <div className="flex-1 min-w-0">
          <p className={`text-[9px] uppercase tracking-widest ${colors.text}/80`}>{label}</p>
          <input
            value={query}
            onChange={e => onChange(e.target.value)}
            onFocus={() => { onActivate(); setShowResults(true); }}
            onBlur={() => setTimeout(() => setShowResults(false), 200)}
            placeholder="Cerca indirizzo o clicca sulla mappa…"
            className="w-full bg-transparent text-[11.5px] text-zinc-100 placeholder:text-zinc-500 focus:outline-none"
          />
        </div>
        {loadingGeo
          ? <Loader2 className="w-3.5 h-3.5 text-zinc-400 animate-spin shrink-0" />
          : <Search className="w-3.5 h-3.5 text-zinc-500 shrink-0" />}
        {point && (
          <span
            onClick={(e) => { e.stopPropagation(); onClear(); setQuery(""); setResults([]); }}
            className="text-zinc-500 hover:text-rose-300 text-[12px] px-1 shrink-0 cursor-pointer"
          >✕</span>
        )}
      </div>
      {showResults && (results.length > 0 || (query.length >= 2 && !loadingGeo)) && (
        <div className="absolute z-30 left-0 right-0 mt-1 max-h-64 overflow-y-auto rounded-lg border border-emerald-400/40 bg-zinc-950/95 backdrop-blur-xl shadow-[0_8px_32px_rgba(16,185,129,0.25)]">
          {results.length === 0 ? (
            <div className="px-3 py-3 text-[11px] text-zinc-400 italic">
              Nessun risultato. Prova con "Via X, Città" o clicca direttamente sulla mappa.
            </div>
          ) : results.map(r => (
            <button
              key={r.id}
              onMouseDown={(e) => {
                e.preventDefault();
                onPick({ lat: r.lat, lon: r.lon, label: r.place });
                setQuery(r.place);
                setResults([]);
                setShowResults(false);
              }}
              className="w-full text-left px-3 py-2 hover:bg-emerald-500/15 transition flex items-start gap-2 border-b border-white/5 last:border-0"
            >
              <MapPin className="w-3 h-3 text-emerald-400 mt-0.5 shrink-0" />
              <div className="min-w-0">
                <p className="text-[12px] text-zinc-100 truncate font-medium">{r.name}</p>
                <p className="text-[10px] text-zinc-400 truncate">{r.place}</p>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function PinMarker({ color, icon, pulse }: { color: string; icon: React.ReactNode; pulse?: boolean }) {
  return (
    <div className="relative flex flex-col items-center">
      {pulse && (
        <span
          className="absolute bottom-1 w-9 h-9 rounded-full animate-ping"
          style={{ background: color, opacity: 0.4 }}
        />
      )}
      <div
        className="relative w-9 h-9 rounded-full border-2 border-white flex items-center justify-center shadow-lg"
        style={{ background: color, boxShadow: `0 4px 14px ${color}80` }}
      >
        {icon}
      </div>
      <div
        className="w-0 h-0 -mt-px"
        style={{
          borderLeft: "5px solid transparent",
          borderRight: "5px solid transparent",
          borderTop: `7px solid ${color}`,
        }}
      />
    </div>
  );
}

function StopDot({ color, label, ring }: { color: string; label: string; ring?: boolean }) {
  return (
    <div className="relative flex items-center justify-center">
      {ring && (
        <span
          className="absolute w-7 h-7 rounded-full border-2"
          style={{ borderColor: color, boxShadow: `0 0 12px ${color}` }}
        />
      )}
      <div
        className="w-4 h-4 rounded-full border-2 border-white shadow-md"
        style={{ background: color }}
        title={label}
      />
    </div>
  );
}

function TransferHub({ label }: { label: string }) {
  return (
    <div className="relative flex flex-col items-center">
      <span className="absolute w-10 h-10 rounded-full bg-amber-300/30 animate-ping" />
      <div className="relative w-8 h-8 rounded-full border-2 border-white bg-gradient-to-br from-amber-400 to-orange-500 flex items-center justify-center shadow-[0_4px_14px_rgba(245,158,11,0.7)]">
        <Repeat className="w-4 h-4 text-white" />
      </div>
      <div className="mt-1 px-1.5 py-0.5 rounded bg-amber-500 text-black text-[9px] font-black shadow">
        {label}
      </div>
    </div>
  );
}

function ComputingCard() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
      className="rounded-2xl border border-emerald-400/40 bg-zinc-950/85 backdrop-blur-xl p-4 overflow-hidden relative"
    >
      <motion.div
        className="absolute inset-x-0 -top-px h-px bg-gradient-to-r from-transparent via-emerald-300 to-transparent"
        animate={{ x: ["-100%", "100%"] }}
        transition={{ duration: 1.6, repeat: Infinity, ease: "linear" }}
      />
      <div className="flex items-center gap-3">
        <Loader2 className="w-4 h-4 text-emerald-300 animate-spin" />
        <div>
          <p className="text-xs font-semibold text-emerald-200">Routing in corso…</p>
          <p className="text-[10px] text-emerald-300/60 font-mono">stop matching · transfers · band lookup</p>
        </div>
      </div>
    </motion.div>
  );
}

function AltCard({
  alt, index, selected, onSelect, onOpenDetails,
}: { alt: JourneyAlt; index: number; selected: boolean; onSelect: () => void; onOpenDetails: () => void }) {
  const buses = busLegs(alt);
  const numTransfers = buses.length - 1;
  const firstBus = buses[0];
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.04 }}
      onClick={() => { if (selected) onOpenDetails(); else onSelect(); }}
      className={`w-full text-left rounded-2xl border backdrop-blur-xl transition-all overflow-hidden cursor-pointer
        ${selected
          ? "border-emerald-400/80 bg-gradient-to-br from-emerald-950/90 to-black/90 shadow-[0_8px_40px_rgba(16,185,129,0.45)]"
          : "border-white/10 bg-zinc-950/70 hover:border-emerald-400/60 hover:bg-zinc-900/80"}`}
    >
      {/* Header */}
      <div className="px-3 pt-3 pb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0 flex-wrap">
          {buses.map((b, i) => (
            <React.Fragment key={i}>
              <span
                className="px-2 py-0.5 rounded-md text-[11px] font-black tracking-wide shrink-0"
                style={{ background: b.routeColor, color: b.routeTextColor }}
              >
                {b.routeShortName}
              </span>
              {i < buses.length - 1 && <Repeat className="w-3 h-3 text-amber-300 shrink-0" />}
            </React.Fragment>
          ))}
          {numTransfers > 0 && (
            <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-200 border border-amber-400/40 shrink-0">
              {numTransfers} cambio
            </span>
          )}
          {firstBus && (
            <span
              className={`text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded shrink-0
                ${firstBus.network === "extraurbano"
                  ? "bg-purple-500/20 text-purple-200 border border-purple-400/40"
                  : "bg-sky-500/20 text-sky-200 border border-sky-400/40"}`}
            >
              {firstBus.networkLabel}
            </span>
          )}
        </div>
        <div className="text-right shrink-0">
          <p className="text-base font-black text-emerald-300 leading-none drop-shadow-[0_0_6px_rgba(16,185,129,0.5)]">{fmtPrice(alt.totalAmount)}</p>
          <p className="text-[9px] text-emerald-300/60 font-mono">
            {fmtTime(alt.depTime)} → {fmtTime(alt.arrTime)}
          </p>
        </div>
      </div>

      {/* Badges */}
      {alt.badges && alt.badges.length > 0 && (
        <div className="px-3 pb-2 flex gap-1.5 flex-wrap">
          {alt.badges.map(b => {
            const meta = BADGE_META[b];
            if (!meta) return null;
            const Icon = meta.icon;
            return (
              <span
                key={b}
                className={`text-[9px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-gradient-to-r border ${meta.cls} flex items-center gap-1`}
              >
                <Icon className="w-2.5 h-2.5" />{meta.label}
              </span>
            );
          })}
        </div>
      )}

      {/* Timeline dinamica */}
      <div className="px-3 pb-3 flex items-stretch gap-1 text-[10px] text-zinc-300 flex-wrap">
        {alt.legs.map((leg, i) => (
          <React.Fragment key={i}>
            {i > 0 && <Connector />}
            {leg.kind === "walk" && (
              <LegBlock
                icon={<Footprints className="w-3 h-3" />}
                label={`${leg.durationMin}'`}
                sub={`${leg.distanceM} m`}
                color="#34d399"
              />
            )}
            {leg.kind === "bus" && (
              <LegBlock
                icon={<Bus className="w-3 h-3" />}
                label={`${leg.busMin}'`}
                sub={`${leg.routeShortName} · ${leg.numStops}f`}
                color={leg.routeColor}
                big
                time={`${fmtTime(leg.depTime)} → ${fmtTime(leg.arrTime)}`}
              />
            )}
            {leg.kind === "transfer" && (
              <LegBlock
                icon={<Repeat className="w-3 h-3" />}
                label={`${leg.durationMin}'`}
                sub="cambio"
                color="#fbbf24"
              />
            )}
          </React.Fragment>
        ))}
      </div>

      {/* Footer */}
      <div className="px-3 py-2 border-t border-white/5 bg-black/40 flex items-center justify-between text-[10px]">
        <span className="text-zinc-400 flex items-center gap-1">
          <Clock className="w-3 h-3" /> Totale <strong className="text-emerald-300 ml-0.5">{fmtMin(alt.totalMin)}</strong>
        </span>
        <span className="text-zinc-400 flex items-center gap-1">
          <Footprints className="w-3 h-3" /> Cammino <strong className="text-emerald-300 ml-0.5">{alt.totalWalkM} m</strong>
        </span>
        <span className="text-zinc-400 flex items-center gap-1">
          <RouteIcon className="w-3 h-3" /> Bus <strong className="text-emerald-300 ml-0.5">{buses.reduce((s,b)=>s+b.distanceKm,0).toFixed(1)} km</strong>
        </span>
      </div>
      {selected && (
        <div className="px-3 py-1.5 bg-gradient-to-r from-emerald-400 via-green-400 to-lime-400 text-black text-[10px] font-black flex items-center justify-center gap-1 hover:brightness-110 transition shadow-[0_0_20px_rgba(16,185,129,0.6)]">
          <Sparkles className="w-3 h-3" /> Tocca per i dettagli completi
        </div>
      )}
    </motion.div>
  );
}

function LegBlock({
  icon, label, sub, color, big, time,
}: { icon: React.ReactNode; label: string; sub: string; color: string; big?: boolean; time?: string }) {
  return (
    <div className={`flex flex-col items-center justify-center rounded-lg p-1.5 ${big ? "flex-[2] min-w-[80px]" : "flex-1 min-w-[55px]"}`}
         style={{ background: `${color}20`, border: `1px solid ${color}55`, boxShadow: big ? `0 0 12px ${color}30` : undefined }}>
      <div className="flex items-center gap-1" style={{ color }}>{icon}<span className="font-semibold">{label}</span></div>
      <div className="text-[9px] text-zinc-300 truncate max-w-full">{sub}</div>
      {time && <div className="text-[9px] font-mono text-zinc-400 mt-0.5">{time}</div>}
    </div>
  );
}

function Connector() {
  return <div className="self-center w-2 text-emerald-400/60"><ArrowRight className="w-2.5 h-2.5" /></div>;
}

function DetailModal({
  alt, origin, dest, date, time, onClose,
}: { alt: JourneyAlt; origin: LatLon | null; dest: LatLon | null; date: string; time: string; onClose: () => void }) {
  const buses = busLegs(alt);
  const totalKm = buses.reduce((s, b) => s + b.distanceKm, 0);
  const totalBusMin = buses.reduce((s, b) => s + b.busMin, 0);
  const totalWalkMin = alt.legs.filter((l): l is WalkLeg => l.kind === "walk").reduce((s, w) => s + w.durationMin, 0);
  const totalTransferMin = alt.legs.filter((l): l is TransferLeg => l.kind === "transfer").reduce((s, t) => s + t.durationMin, 0);

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.95, y: 20 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.95, y: 20 }}
        onClick={e => e.stopPropagation()}
        className="bg-zinc-950 rounded-2xl shadow-[0_20px_80px_rgba(16,185,129,0.35)] max-w-2xl w-full max-h-[90vh] overflow-hidden flex flex-col border border-emerald-400/40"
      >
        {/* Header */}
        <div className="px-5 py-4 bg-gradient-to-r from-emerald-500 via-green-500 to-lime-500 text-white flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <p className="text-[10px] font-mono uppercase tracking-widest opacity-80">Dettaglio viaggio · {fmtDateLabel(date)} · partenza ≥ {time}</p>
            <h2 className="text-lg font-black mt-0.5 flex items-center gap-2 flex-wrap">
              {buses.map((b, i) => (
                <React.Fragment key={i}>
                  <span className="px-2 py-0.5 rounded-md text-sm font-black bg-white/20 backdrop-blur" style={{ color: "#fff" }}>
                    {b.routeShortName}
                  </span>
                  {i < buses.length - 1 && <Repeat className="w-4 h-4 opacity-80" />}
                </React.Fragment>
              ))}
              <span className="text-[11px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-white/20 ml-1">
                {buses.length === 1 ? "Diretto" : `${buses.length - 1} cambio`}
              </span>
            </h2>
            <p className="text-[11px] mt-1 opacity-90">
              {fmtTime(alt.depTime)} → {fmtTime(alt.arrTime)} · {fmtMin(alt.totalMin)} totali · {fmtPrice(alt.totalAmount)}
            </p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-white/20 transition shrink-0">
            <span className="text-2xl leading-none">×</span>
          </button>
        </div>

        {/* Body scroll */}
        <div className="flex-1 overflow-y-auto p-5 space-y-5 text-sm text-zinc-200">

          {/* KPI riepilogo */}
          <div className="grid grid-cols-4 gap-2">
            <KPI icon={<Clock className="w-3.5 h-3.5" />} label="Totale" value={fmtMin(alt.totalMin)} />
            <KPI icon={<Bus className="w-3.5 h-3.5" />}   label="In bus" value={`${totalBusMin}'`} />
            <KPI icon={<Footprints className="w-3.5 h-3.5" />} label="A piedi" value={`${totalWalkMin}'`} />
            <KPI icon={<RouteIcon className="w-3.5 h-3.5" />}  label="Distanza" value={`${totalKm.toFixed(1)} km`} />
          </div>

          {/* Timeline dettagliata step-by-step */}
          <div>
            <h3 className="text-xs font-black uppercase tracking-widest text-emerald-300 mb-3 flex items-center gap-1.5">
              <RouteIcon className="w-3.5 h-3.5" /> Itinerario passo-passo
            </h3>
            <div className="space-y-0">
              {alt.legs.map((leg, i) => (
                <DetailLegRow key={i} leg={leg} isLast={i === alt.legs.length - 1} />
              ))}
            </div>
          </div>

          {/* Tariffa */}
          <div>
            <h3 className="text-xs font-black uppercase tracking-widest text-emerald-300 mb-2 flex items-center gap-1.5">
              <PiggyBank className="w-3.5 h-3.5" /> Calcolo tariffa
            </h3>
            <div className="rounded-xl border border-emerald-400/30 bg-black/40 overflow-hidden">
              <table className="w-full text-[12px]">
                <thead className="bg-emerald-500/15 text-emerald-200 text-[10px] uppercase tracking-wider">
                  <tr>
                    <th className="text-left px-3 py-1.5">Linea</th>
                    <th className="text-left px-3 py-1.5">Rete</th>
                    <th className="text-left px-3 py-1.5">Tariffa</th>
                    <th className="text-right px-3 py-1.5">Distanza</th>
                    <th className="text-right px-3 py-1.5">Importo</th>
                  </tr>
                </thead>
                <tbody>
                  {buses.map((b, i) => (
                    <tr key={i} className="border-t border-white/5 hover:bg-emerald-500/5">
                      <td className="px-3 py-1.5">
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-black"
                              style={{ background: b.routeColor, color: b.routeTextColor }}>
                          {b.routeShortName}
                        </span>
                      </td>
                      <td className="px-3 py-1.5 text-zinc-300">
                        {b.networkLabel}{b.network !== "extraurbano" && ` · ${b.network.replace("urbano_", "")}`}
                      </td>
                      <td className="px-3 py-1.5 text-zinc-300">
                        {b.fascia ? `Fascia ${b.fascia} (${b.bandRange})` : b.fareName}
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono text-zinc-300">{b.distanceKm} km</td>
                      <td className="px-3 py-1.5 text-right font-mono font-bold text-emerald-300">{fmtPrice(b.amount)}</td>
                    </tr>
                  ))}
                  <tr className="border-t-2 border-emerald-400/40 bg-emerald-500/15 font-bold">
                    <td colSpan={4} className="px-3 py-2 text-right text-emerald-100">TOTALE</td>
                    <td className="px-3 py-2 text-right text-emerald-100 font-mono">{fmtPrice(alt.totalAmount)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          {/* Metodologia */}
          <div>
            <h3 className="text-xs font-black uppercase tracking-widest text-emerald-300 mb-2 flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5" /> Metodo di calcolo
            </h3>
            <div className="rounded-xl border border-white/10 bg-black/40 p-3 space-y-2 text-[12px] text-zinc-300 leading-relaxed">
              <p><strong className="text-emerald-200">1. Fermate candidate.</strong> Selezione delle 12 fermate più vicine a origine e destinazione (formula di Haversine), filtrate entro 900 m a piedi.</p>
              <p><strong className="text-emerald-200">2. Servizi attivi.</strong> Espansione GTFS dei <code className="bg-black/60 px-1 rounded text-[11px] text-emerald-300">calendar</code> e <code className="bg-black/60 px-1 rounded text-[11px] text-emerald-300">calendar_dates</code> per la data {fmtDateLabel(date)}, con esclusione delle eccezioni di tipo 2 e inclusione di quelle di tipo 1.</p>
              <p><strong className="text-emerald-200">3. Trip diretti.</strong> Su <code className="bg-black/60 px-1 rounded text-[11px] text-emerald-300">stop_times</code> si cercano trip che visitano una fermata di origine alla partenza ≥ {time} e successivamente una fermata di destinazione (<code className="text-emerald-300">d_seq &gt; o_seq</code>).</p>
              {buses.length > 1 && (
                <p><strong className="text-emerald-200">4. Trasferimenti.</strong> Si cercano coppie di trip <em>(bus 1, bus 2)</em> che condividono una fermata di interscambio (hub), con linee differenti, attesa hub tra 4 e 30 minuti, hub diverso dalla fermata di destinazione.</p>
              )}
              <p><strong className="text-emerald-200">{buses.length > 1 ? "5" : "4"}. Distanze.</strong> Calcolo per somma di Haversine tra fermate consecutive del tratto percorso ({totalKm.toFixed(2)} km totali).</p>
              <p><strong className="text-emerald-200">{buses.length > 1 ? "6" : "5"}. Tariffa.</strong> Classificazione automatica della linea: <em>Urbano</em> → tariffa flat di rete (€1,35 / 60'); <em>Extraurbano</em> → fasce DGR Marche basate sui km. Per percorsi multi-bus l'importo è la somma delle tariffe per leg.</p>
              <p><strong className="text-emerald-200">{buses.length > 1 ? "7" : "6"}. Tempi a piedi.</strong> Velocità media 4,8 km/h (≈80 m/min).</p>
              <p className="pt-1 text-[11px] italic text-zinc-500">Source: GTFS RAM/AMTAB Marche · DGR Marche fasce extraurbane · Mapbox Geocoding (lookup indirizzi).</p>
            </div>
          </div>

          {origin && dest && (
            <div className="text-[10px] text-zinc-500 font-mono pt-1">
              Origine: {origin.label || `${origin.lat.toFixed(5)}, ${origin.lon.toFixed(5)}`}<br/>
              Destinazione: {dest.label || `${dest.lat.toFixed(5)}, ${dest.lon.toFixed(5)}`}
            </div>
          )}
        </div>

        <div className="px-5 py-3 bg-black/60 border-t border-white/10 flex justify-end">
          <button onClick={onClose}
            className="px-4 py-1.5 rounded-lg bg-gradient-to-r from-emerald-400 to-lime-400 hover:brightness-110 text-black text-sm font-black transition shadow-[0_0_20px_rgba(16,185,129,0.5)]">
            Chiudi
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

function KPI({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-lg border border-emerald-400/30 bg-emerald-500/10 p-2 text-center">
      <div className="flex items-center justify-center gap-1 text-emerald-300 text-[10px] font-bold uppercase tracking-wider">
        {icon}<span>{label}</span>
      </div>
      <p className="text-base font-black text-emerald-100 mt-0.5 drop-shadow-[0_0_6px_rgba(16,185,129,0.4)]">{value}</p>
    </div>
  );
}

function DetailLegRow({ leg, isLast }: { leg: Leg; isLast: boolean }) {
  if (leg.kind === "walk") {
    return (
      <div className="flex gap-3 pb-3">
        <div className="flex flex-col items-center">
          <div className="w-8 h-8 rounded-full bg-emerald-500/20 border border-emerald-400/50 flex items-center justify-center">
            <Footprints className="w-4 h-4 text-emerald-300" />
          </div>
          {!isLast && <div className="w-px flex-1 border-l-2 border-dashed border-emerald-400/40 mt-1" />}
        </div>
        <div className="flex-1 pb-2">
          <p className="text-[13px] font-bold text-zinc-100">A piedi · {leg.durationMin} min</p>
          <p className="text-[11px] text-zinc-400">
            Da <span className="font-medium text-zinc-200">{leg.fromName}</span> a <span className="font-medium text-zinc-200">{leg.toName}</span> · {leg.distanceM} m
          </p>
        </div>
      </div>
    );
  }
  if (leg.kind === "transfer") {
    return (
      <div className="flex gap-3 pb-3">
        <div className="flex flex-col items-center">
          <div className="w-8 h-8 rounded-full bg-amber-500/20 border border-amber-400/50 flex items-center justify-center">
            <Repeat className="w-4 h-4 text-amber-300" />
          </div>
          {!isLast && <div className="w-px flex-1 border-l-2 border-dashed border-amber-400/40 mt-1" />}
        </div>
        <div className="flex-1 pb-2">
          <p className="text-[13px] font-bold text-amber-200">Cambio bus · attesa {leg.durationMin} min</p>
          <p className="text-[11px] text-zinc-400">Trasferimento alla fermata <span className="font-medium text-zinc-200">{leg.hubStopName}</span></p>
        </div>
      </div>
    );
  }
  // bus
  return (
    <div className="flex gap-3 pb-3">
      <div className="flex flex-col items-center">
        <div className="w-8 h-8 rounded-full border-2 flex items-center justify-center"
             style={{ background: leg.routeColor, borderColor: leg.routeColor, boxShadow: `0 0 14px ${leg.routeColor}99` }}>
          <Bus className="w-4 h-4" style={{ color: leg.routeTextColor }} />
        </div>
        {!isLast && <div className="w-1 flex-1 mt-1" style={{ background: leg.routeColor, opacity: 0.6, boxShadow: `0 0 8px ${leg.routeColor}` }} />}
      </div>
      <div className="flex-1 pb-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="px-1.5 py-0.5 rounded text-[11px] font-black"
                style={{ background: leg.routeColor, color: leg.routeTextColor }}>
            {leg.routeShortName}
          </span>
          <span className="text-[13px] font-bold text-zinc-100">{leg.busMin} min</span>
          <span className={`text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded
            ${leg.network === "extraurbano"
              ? "bg-purple-500/20 text-purple-200 border border-purple-400/40"
              : "bg-sky-500/20 text-sky-200 border border-sky-400/40"}`}>
            {leg.networkLabel}
          </span>
        </div>
        <p className="text-[11px] text-zinc-300 mt-0.5">{leg.headsign || leg.routeLongName}</p>
        <div className="text-[11px] text-zinc-400 mt-1 space-y-0.5">
          <p><Clock className="inline w-2.5 h-2.5 mr-1" /><span className="font-mono text-emerald-300">{fmtTime(leg.depTime)}</span> da <strong className="text-zinc-200">{leg.fromStop.name}</strong></p>
          <p><Clock className="inline w-2.5 h-2.5 mr-1" /><span className="font-mono text-emerald-300">{fmtTime(leg.arrTime)}</span> a <strong className="text-zinc-200">{leg.toStop.name}</strong></p>
          <p className="text-zinc-500">{leg.numStops} fermate · {leg.distanceKm} km · <span className="text-emerald-300 font-bold">{fmtPrice(leg.amount)}</span> ({leg.fareName})</p>
        </div>
      </div>
    </div>
  );
}
