/**
 * Simulatore Bigliettazione — Transit Intel
 * Flusso: setup → salita → discesa → pagamento → ricevuta
 */

import { useState, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Bus, MapPin, Ticket, CheckCircle2, ChevronRight,
  User, CreditCard, Smartphone, Clock, Euro, RotateCcw,
  AlertCircle, Zap, Search, ArrowDown, Navigation, Calendar,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ── Types ──────────────────────────────────────────────────
interface SimRoute {
  route_id: string;
  route_short_name: string;
  route_long_name: string;
  route_color: string | null;
  network_id: string | null;
}
interface SimTrip {
  trip_id: string;
  trip_headsign: string;
  direction_id: number;
  departure_time: string;
  stop_count: number;
}
interface SimStop {
  stop_sequence: number;
  arrival_time: string;
  departure_time: string;
  stop_id: string;
  stop_name: string;
  lat: number;
  lon: number;
}
interface FareResult {
  type?: string;
  ruleApplied?: "regola1" | "regola2";
  amount: number | null;
  currency: string;
  fascia: string | null;
  bandRange: string | null;
  distanceKm: number;
  products?: { name: string; amount: number; durationMinutes: number }[];
  // Regola 1/2 dominant
  dominantTripCount?: number;
  dominantShapeId?: string | null;
  altDistances?: { shapeId: string | null; tripCount: number; km: number }[] | null;
  lineResults?: {
    routeId: string;
    km: number;
    fromStopName: string;
    toStopName: string;
    dominantTripCount: number;
    totalTripsDay: number;
  }[];
}
type PaymentMethod = "cash" | "card" | "app";
type PassengerType = "standard" | "ridotto" | "abbonato";
type Phase = "setup" | "boarding" | "alighting" | "paying" | "receipt";
type CalcMethod = "media_ponderata" | "regola1" | "regola1_2_auto";

// ── Constants ──────────────────────────────────────────────
const PHASES: Phase[] = ["setup", "boarding", "alighting", "paying", "receipt"];
const PHASE_LABELS = ["Linea", "Salita", "Discesa", "Pagamento", "Ricevuta"];

const NET_COLORS: Record<string, string> = {
  urbano_ancona: "#3b82f6",
  urbano_jesi: "#22c55e",
  urbano_falconara: "#a855f7",
  urbano_senigallia: "#f97316",
  urbano_castelfidardo: "#06b6d4",
  extraurbano: "#ef4444",
};
const NET_LABELS: Record<string, string> = {
  urbano_ancona: "Urbano Ancona",
  urbano_jesi: "Urbano Jesi",
  urbano_falconara: "Urbano Falconara",
  urbano_senigallia: "Urbano Senigallia",
  urbano_castelfidardo: "Urbano Castelfidardo",
  extraurbano: "Extraurbano",
};

// ── Helpers ────────────────────────────────────────────────
function routeBg(color: string | null) {
  if (!color) return "#475569";
  return color.startsWith("#") ? color : `#${color}`;
}
function textOnColor(color: string | null) {
  const hex = (color ?? "475569").replace("#", "");
  const rgb = hex.length === 6
    ? [parseInt(hex.slice(0,2),16), parseInt(hex.slice(2,4),16), parseInt(hex.slice(4,6),16)]
    : [71, 85, 105];
  return (0.299*rgb[0] + 0.587*rgb[1] + 0.114*rgb[2]) / 255 > 0.55 ? "#0f172a" : "#ffffff";
}
function formatTime(t: string) { return t ? t.slice(0, 5) : "--:--"; }

// Formatta YYYYMMDD → "Lun 19 Apr 2026"
function formatDateLabel(yyyymmdd: string): { weekday: string; day: string; month: string; year: string; iso: string } {
  const y = yyyymmdd.slice(0, 4);
  const m = yyyymmdd.slice(4, 6);
  const d = yyyymmdd.slice(6, 8);
  const date = new Date(`${y}-${m}-${d}T00:00:00`);
  const weekday = date.toLocaleDateString("it-IT", { weekday: "short" }).replace(".", "");
  const day = date.toLocaleDateString("it-IT", { day: "numeric" });
  const month = date.toLocaleDateString("it-IT", { month: "short" }).replace(".", "");
  const year = String(date.getFullYear());
  return { weekday, day, month, year, iso: `${y}-${m}-${d}` };
}

// ── Sub-components ─────────────────────────────────────────

function StopList({
  stops,
  selected,
  onSelect,
  highlightId,
  disableBefore,
}: {
  stops: SimStop[];
  selected: SimStop | null;
  onSelect: (s: SimStop) => void;
  highlightId?: string;
  disableBefore?: string;
}) {
  const [filter, setFilter] = useState("");
  const disableIdx = disableBefore ? stops.findIndex(s => s.stop_id === disableBefore) : -1;
  const filtered = filter
    ? stops.filter(s => s.stop_name.toLowerCase().includes(filter.toLowerCase()))
    : stops;

  return (
    <div className="flex flex-col gap-2">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
        <input
          type="text"
          placeholder="Cerca fermata..."
          value={filter}
          onChange={e => setFilter(e.target.value)}
          className="w-full bg-slate-800 border border-slate-700 rounded-xl pl-9 pr-4 py-2.5 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-blue-500 transition-colors"
        />
      </div>
      <div className="max-h-80 overflow-y-auto divide-y divide-slate-800/50 rounded-xl border border-slate-800 bg-slate-900">
        {filtered.map((s, i) => {
          const realIdx = stops.indexOf(s);
          const isSelected = selected?.stop_id === s.stop_id;
          const isHighlight = s.stop_id === highlightId;
          const isDisabled = disableIdx >= 0 && realIdx <= disableIdx;
          return (
            <button
              key={s.stop_id}
              disabled={isDisabled}
              onClick={() => !isDisabled && onSelect(s)}
              className={cn(
                "w-full flex items-center gap-3 px-4 py-3 text-left transition-all",
                isSelected ? "bg-blue-500/20" :
                isHighlight ? "bg-emerald-500/10" :
                isDisabled ? "opacity-25 cursor-not-allowed" :
                "hover:bg-slate-800 cursor-pointer"
              )}
            >
              <div className={cn(
                "w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold shrink-0 transition-all",
                isSelected ? "bg-blue-500 text-white" :
                isHighlight ? "bg-emerald-500/30 text-emerald-300" :
                "bg-slate-800 text-slate-500"
              )}>
                {isSelected ? <CheckCircle2 className="w-4 h-4" /> : realIdx + 1}
              </div>
              <div className="flex-1 min-w-0">
                <div className={cn("text-sm font-medium truncate",
                  isSelected ? "text-blue-200" : isHighlight ? "text-emerald-300" : "text-slate-200"
                )}>{s.stop_name}</div>
                <div className="text-xs text-slate-500">{formatTime(s.departure_time)}</div>
              </div>
              {isHighlight && !isSelected && <span className="text-[10px] bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 px-2 py-0.5 rounded-full font-bold shrink-0">SALITA</span>}
            </button>
          );
        })}
        {filtered.length === 0 && (
          <div className="px-4 py-6 text-center text-sm text-slate-500">Nessuna fermata trovata</div>
        )}
      </div>
    </div>
  );
}

// ── Main ───────────────────────────────────────────────────
export default function FareSimulatorPage() {
  const [selectedDate, setSelectedDate] = useState<string | null>(null); // YYYYMMDD
  const [selectedRoute, setSelectedRoute] = useState<SimRoute | null>(null);
  const [selectedTrip, setSelectedTrip] = useState<SimTrip | null>(null);
  const [phase, setPhase] = useState<Phase>("setup");
  const [boardingStop, setBoardingStop] = useState<SimStop | null>(null);
  const [alightingStop, setAlightingStop] = useState<SimStop | null>(null);
  const [passengerType, setPassengerType] = useState<PassengerType>("standard");
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("card");
  const [calcMethod, setCalcMethod] = useState<CalcMethod>("regola1_2_auto");
  const [fareResult, setFareResult] = useState<FareResult | null>(null);
  const [payStep, setPayStep] = useState(0); // 0-3
  const [routeFilter, setRouteFilter] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  // ── Queries ──
  const { data: routes = [] } = useQuery<SimRoute[]>({
    queryKey: ["/api/fares/simulator/routes"],
    queryFn: () => fetch("/api/fares/simulator/routes").then(r => r.json()),
  });
  const { data: dates = [] } = useQuery<{ date: string; trip_count: number }[]>({
    queryKey: ["/api/fares/simulator/dates"],
    queryFn: () => fetch("/api/fares/simulator/dates").then(r => r.json()),
  });
  const { data: trips = [] } = useQuery<SimTrip[]>({
    queryKey: ["/api/fares/simulator/trips", selectedRoute?.route_id, selectedDate],
    queryFn: () => fetch(
      `/api/fares/simulator/trips?routeId=${selectedRoute!.route_id}` +
      (selectedDate ? `&date=${selectedDate}` : "")
    ).then(r => r.json()),
    enabled: !!selectedRoute,
  });
  const { data: stops = [] } = useQuery<SimStop[]>({
    queryKey: ["/api/fares/simulator/trip-stops", selectedTrip?.trip_id],
    queryFn: () => fetch(`/api/fares/simulator/trip-stops?tripId=${selectedTrip!.trip_id}`).then(r => r.json()),
    enabled: !!selectedTrip,
  });

  const routesByNet = routes.reduce<Record<string, SimRoute[]>>((acc, r) => {
    const k = r.network_id ?? "altro";
    (acc[k] ??= []).push(r);
    return acc;
  }, {});

  const filteredRoutes = routeFilter
    ? routes.filter(r =>
        r.route_short_name?.toLowerCase().includes(routeFilter.toLowerCase()) ||
        r.route_long_name?.toLowerCase().includes(routeFilter.toLowerCase())
      )
    : null;

  // ── Reset ──
  const reset = () => {
    setSelectedDate(null);
    setSelectedRoute(null); setSelectedTrip(null); setPhase("setup");
    setBoardingStop(null); setAlightingStop(null); setFareResult(null);
    setPayStep(0); setRouteFilter(""); setIsLoading(false); setCalcMethod("regola1_2_auto");
  };

  // ── Pagamento animato + fetch ──
  const doPay = async () => {
    setPhase("paying");
    setPayStep(0);
    await new Promise(r => setTimeout(r, 500));
    setPayStep(1);
    await new Promise(r => setTimeout(r, 700));
    setPayStep(2);
    setIsLoading(true);
    try {
      const networkId = selectedRoute?.network_id ?? "extraurbano";
      const isUrban = networkId !== "extraurbano";

      let endpoint = "/api/fares/simulate";
      let body: Record<string, unknown>;

      if (isUrban) {
        body = { networkId };
      } else if (calcMethod === "media_ponderata") {
        endpoint = "/api/fares/simulate";
        body = { networkId, routeId: selectedRoute!.route_id, fromStopId: boardingStop!.stop_id, toStopId: alightingStop!.stop_id };
      } else if (calcMethod === "regola1") {
        endpoint = "/api/fares/simulate-dominant";
        body = { routeId: selectedRoute!.route_id, fromStopId: boardingStop!.stop_id, toStopId: alightingStop!.stop_id };
      } else {
        // regola1_2_auto — senza routeId, cerca tutte le linee candidate
        endpoint = "/api/fares/simulate-dominant";
        body = { fromStopId: boardingStop!.stop_id, toStopId: alightingStop!.stop_id };
      }

      const r = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      setFareResult(await r.json());
    } catch { /* ignore */ }
    setIsLoading(false);
    setPayStep(3);
    await new Promise(r => setTimeout(r, 600));
    setPhase("receipt");
  };

  // ── Derived ──
  const phaseIdx = PHASES.indexOf(phase);
  const netColor = selectedRoute ? (NET_COLORS[selectedRoute.network_id ?? ""] ?? "#475569") : "#3b82f6";
  const isUrban = selectedRoute?.network_id !== "extraurbano" && !!selectedRoute?.network_id;
  const basePrice = fareResult?.amount ?? null;
  const finalPrice = (basePrice == null && !(fareResult?.products?.length))
    ? null
    : passengerType === "abbonato" ? 0 : null; // handled per-product for urban

  // ─────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-slate-950 text-white">
      <div className="max-w-2xl mx-auto px-4 py-6 space-y-5">

        {/* ── HEADER ── */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-black flex items-center gap-2.5 tracking-tight">
              <div className="w-9 h-9 rounded-xl bg-blue-500 flex items-center justify-center shrink-0">
                <Bus className="w-5 h-5 text-white" />
              </div>
              Simulatore Bigliettazione
            </h1>
            <p className="text-sm text-slate-400 mt-1">Simula un viaggio e calcola la tariffa</p>
          </div>
          {phase !== "setup" && (
            <button onClick={reset}
              className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium transition-colors border border-slate-700">
              <RotateCcw className="w-3.5 h-3.5" /> Ricomincia
            </button>
          )}
        </div>

        {/* ── STEP BAR ── */}
        <div className="bg-slate-900 border border-slate-800 rounded-2xl px-5 py-4">
          <div className="flex items-center justify-between">
            {PHASES.map((p, i) => (
              <div key={p} className="flex items-center">
                <div className="flex flex-col items-center gap-1.5">
                  <div className={cn(
                    "w-9 h-9 rounded-xl flex items-center justify-center text-sm font-black transition-all duration-300",
                    phaseIdx === i ? "bg-white text-slate-900 scale-110 shadow-lg shadow-white/10" :
                    phaseIdx > i ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/40" :
                    "bg-slate-800 text-slate-500 border border-slate-700"
                  )}>
                    {phaseIdx > i ? <CheckCircle2 className="w-4 h-4" /> : i + 1}
                  </div>
                  <span className={cn("text-[10px] font-semibold hidden sm:block",
                    phaseIdx === i ? "text-white" :
                    phaseIdx > i ? "text-emerald-400" : "text-slate-600"
                  )}>{PHASE_LABELS[i]}</span>
                </div>
                {i < 4 && (
                  <div className={cn("h-px w-5 sm:w-8 mx-1 mb-3 transition-all duration-500",
                    phaseIdx > i ? "bg-emerald-500/50" : "bg-slate-800"
                  )} />
                )}
              </div>
            ))}
          </div>
        </div>

        {/* ══════════════════════════════════════════
            STEP 1 — Linea, corsa, passeggero, pagamento
        ══════════════════════════════════════════ */}
        {phase === "setup" && (
          <div className="space-y-4">

            {/* Data servizio */}
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
              <h2 className="text-sm font-bold text-slate-300 uppercase tracking-wide mb-3 flex items-center gap-2">
                <Calendar className="w-4 h-4 text-amber-400" /> Giorno del servizio
              </h2>
              <p className="text-xs text-slate-500 mb-3">
                Seleziona la data per filtrare le corse effettivamente attive (evita orari ripetuti da validità diverse).
              </p>
              {dates.length === 0 ? (
                <div className="text-xs text-slate-500 italic">Nessuna data servita disponibile…</div>
              ) : (
                <div className="flex gap-2 overflow-x-auto pb-2 -mx-1 px-1 snap-x">
                  {dates.map(d => {
                    const lbl = formatDateLabel(d.date);
                    const active = selectedDate === d.date;
                    return (
                      <button
                        key={d.date}
                        onClick={() => {
                          setSelectedDate(d.date);
                          setSelectedRoute(null);
                          setSelectedTrip(null);
                        }}
                        title={`${lbl.iso} · ${d.trip_count} corse`}
                        className={cn(
                          "shrink-0 snap-start rounded-xl px-3 py-2 text-center transition-all border min-w-[68px]",
                          active
                            ? "bg-amber-500/20 border-amber-400 text-white scale-105 shadow-lg shadow-amber-500/10"
                            : "bg-slate-800 border-slate-700 hover:border-slate-500 text-slate-300"
                        )}
                      >
                        <div className={cn("text-[9px] uppercase font-bold tracking-wider",
                          active ? "text-amber-300" : "text-slate-500")}>
                          {lbl.weekday}
                        </div>
                        <div className={cn("text-xl font-black leading-none mt-0.5",
                          active ? "text-white" : "text-slate-200")}>
                          {lbl.day}
                        </div>
                        <div className={cn("text-[9px] uppercase mt-0.5",
                          active ? "text-amber-200/80" : "text-slate-500")}>
                          {lbl.month} {lbl.year.slice(2)}
                        </div>
                        <div className={cn("text-[9px] font-mono mt-1",
                          active ? "text-amber-200/60" : "text-slate-600")}>
                          {d.trip_count} ↻
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Linea */}
            {selectedDate && (
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
              <h2 className="text-sm font-bold text-slate-300 uppercase tracking-wide mb-4 flex items-center gap-2">
                <Ticket className="w-4 h-4 text-blue-400" /> Linea
              </h2>
              <div className="relative mb-3">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
                <input type="text" placeholder="Cerca linea..."
                  value={routeFilter} onChange={e => setRouteFilter(e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 rounded-xl pl-9 pr-4 py-2 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-blue-500 transition-colors" />
              </div>
              <div className="max-h-48 overflow-y-auto space-y-3 pr-0.5">
                {filteredRoutes ? (
                  <div className="flex flex-wrap gap-2">
                    {filteredRoutes.map(r => {
                      const bg = routeBg(r.route_color); const fg = textOnColor(r.route_color);
                      return (
                        <button key={r.route_id}
                          onClick={() => { setSelectedRoute(r); setSelectedTrip(null); setRouteFilter(""); }}
                          className={cn("rounded-xl px-3 py-1.5 text-xs font-bold transition-all",
                            selectedRoute?.route_id === r.route_id ? "ring-2 ring-white ring-offset-2 ring-offset-slate-900 scale-105" : "hover:scale-105 opacity-80 hover:opacity-100"
                          )}
                          style={{ backgroundColor: bg, color: fg }}>
                          {r.route_short_name || r.route_id}
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  Object.entries(routesByNet).sort(([a],[b]) => a.localeCompare(b)).map(([netId, netRoutes]) => (
                    <div key={netId}>
                      <div className="flex items-center gap-2 mb-1.5">
                        <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: NET_COLORS[netId] ?? "#94a3b8" }} />
                        <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide">{NET_LABELS[netId] ?? netId}</span>
                      </div>
                      <div className="flex flex-wrap gap-1.5 pl-4">
                        {netRoutes.map(r => {
                          const bg = routeBg(r.route_color); const fg = textOnColor(r.route_color);
                          return (
                            <button key={r.route_id}
                              onClick={() => { setSelectedRoute(r); setSelectedTrip(null); }}
                              className={cn("rounded-lg px-2.5 py-1 text-xs font-bold transition-all",
                                selectedRoute?.route_id === r.route_id ? "ring-2 ring-white ring-offset-1 ring-offset-slate-900 scale-110 relative z-10" : "hover:scale-105 opacity-80 hover:opacity-100"
                              )}
                              style={{ backgroundColor: bg, color: fg }}>
                              {r.route_short_name || r.route_id}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ))
                )}
              </div>
              {selectedRoute && (
                <div className="mt-3 rounded-xl px-4 py-2.5 flex items-center gap-3"
                  style={{ backgroundColor: routeBg(selectedRoute.route_color) + "18", border: `1px solid ${routeBg(selectedRoute.route_color)}40` }}>
                  <div className="w-8 h-8 rounded-lg flex items-center justify-center font-black text-xs shrink-0"
                    style={{ backgroundColor: routeBg(selectedRoute.route_color), color: textOnColor(selectedRoute.route_color) }}>
                    {selectedRoute.route_short_name?.slice(0,4)}
                  </div>
                  <div className="min-w-0">
                    <div className="font-bold text-sm text-white truncate">{selectedRoute.route_long_name || selectedRoute.route_short_name}</div>
                    <div className="text-xs text-slate-400">{NET_LABELS[selectedRoute.network_id ?? ""] ?? selectedRoute.network_id ?? "—"}</div>
                  </div>
                  <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 ml-auto" />
                </div>
              )}
            </div>
            )}

            {/* Corsa */}
            {selectedRoute && (
              <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
                <h2 className="text-sm font-bold text-slate-300 uppercase tracking-wide mb-4 flex items-center gap-2">
                  <Clock className="w-4 h-4 text-purple-400" /> Partenza
                </h2>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 max-h-48 overflow-y-auto pr-0.5">
                  {trips.map(t => {
                    const active = selectedTrip?.trip_id === t.trip_id;
                    return (
                      <button key={t.trip_id} onClick={() => setSelectedTrip(t)}
                        className={cn("rounded-xl p-3 text-left transition-all border",
                          active ? "bg-purple-500/20 border-purple-400 text-white" : "bg-slate-800 border-slate-700 hover:border-slate-500 text-slate-300"
                        )}>
                        <div className="font-black text-xl leading-none">{formatTime(t.departure_time)}</div>
                        <div className="text-xs mt-1 truncate opacity-60">{t.trip_headsign || `Dir. ${t.direction_id}`}</div>
                        <div className="text-[10px] mt-0.5 opacity-40">{t.stop_count} fermate</div>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Passeggero + pagamento */}
            {selectedTrip && (
              <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-5">
                <div>
                  <h2 className="text-sm font-bold text-slate-300 uppercase tracking-wide mb-3 flex items-center gap-2">
                    <User className="w-4 h-4 text-emerald-400" /> Tipologia cliente
                  </h2>
                  <div className="grid grid-cols-3 gap-2">
                    {([
                      ["standard", "Ordinario", "Tariffa piena", "🧑"],
                      ["ridotto", "Ridotto", "Sconto 50%", "👶"],
                      ["abbonato", "Abbonamento", "Viaggio gratuito", "🪪"],
                    ] as [PassengerType, string, string, string][]).map(([val, label, sub, emoji]) => (
                      <button key={val} onClick={() => setPassengerType(val)}
                        className={cn("rounded-xl p-3 text-center transition-all border flex flex-col items-center gap-1.5",
                          passengerType === val ? "bg-emerald-500/20 border-emerald-400 text-white" : "bg-slate-800 border-slate-700 hover:border-slate-500 text-slate-400"
                        )}>
                        <span className="text-2xl">{emoji}</span>
                        <span className="text-xs font-bold">{label}</span>
                        <span className="text-[10px] opacity-60 leading-tight">{sub}</span>
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <h2 className="text-sm font-bold text-slate-300 uppercase tracking-wide mb-3 flex items-center gap-2">
                    <CreditCard className="w-4 h-4 text-blue-400" /> Metodo di pagamento
                  </h2>
                  <div className="grid grid-cols-3 gap-2">
                    {([
                      ["cash", "Contanti", "🪙"],
                      ["card", "Carta / NFC", "💳"],
                      ["app", "App Mobile", "📱"],
                    ] as [PaymentMethod, string, string][]).map(([val, label, emoji]) => (
                      <button key={val} onClick={() => setPaymentMethod(val)}
                        className={cn("rounded-xl p-3 text-center transition-all border flex flex-col items-center gap-1.5",
                          paymentMethod === val ? "bg-blue-500/20 border-blue-400 text-white" : "bg-slate-800 border-slate-700 hover:border-slate-500 text-slate-400"
                        )}>
                        <span className="text-2xl">{emoji}</span>
                        <span className="text-xs font-bold">{label}</span>
                      </button>
                    ))}
                  </div>
                </div>
                <button onClick={() => setPhase("boarding")}
                  className="w-full rounded-xl py-3.5 font-bold text-sm bg-white text-slate-900 hover:bg-slate-100 flex items-center justify-center gap-2 transition-all shadow-lg shadow-white/10">
                  Avanti — scegli fermata di salita <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            )}

            {/* Metodo calcolo — solo extraurbano, appare quando la linea è selezionata */}
            {selectedRoute?.network_id === "extraurbano" && (
              <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
                <h2 className="text-sm font-bold text-slate-300 uppercase tracking-wide mb-1 flex items-center gap-2">
                  <Zap className="w-4 h-4 text-yellow-400" /> Metodo di calcolo tariffa
                </h2>
                <p className="text-xs text-slate-500 mb-4">Scegli come viene calcolata la distanza per determinare la fascia km</p>
                <div className="space-y-2">
                  {([
                    ["media_ponderata", "Media ponderata percorsi", "Distanza calcolata come media pesata su tutti i percorsi della linea, ponderata per numero di corse. Strumento analitico di confronto — non raccomandato per tariffazione ufficiale.", "⚖️"],
                    ["regola1", "Regola 1 — Percorso dominante", "Usa il percorso con più corse (percorso dominante) della linea selezionata per misurare la distanza OD", "📏"],
                    ["regola1_2_auto", "Regola 1/2 — Ricerca automatica", "Cerca tutte le linee extraurbane che servono le due fermate. Se condividono lo stesso capolinea applica la Regola 2 (media tra linee), altrimenti Regola 1", "🔍"],
                  ] as [CalcMethod, string, string, string][]).map(([val, label, desc, emoji]) => (
                    <button key={val} onClick={() => setCalcMethod(val)}
                      className={cn(
                        "w-full rounded-xl p-3.5 text-left transition-all border flex items-start gap-3",
                        calcMethod === val
                          ? "bg-yellow-500/10 border-yellow-500/50 text-white"
                          : "bg-slate-800 border-slate-700 hover:border-slate-600 text-slate-400"
                      )}>
                      <span className="text-xl shrink-0 mt-0.5">{emoji}</span>
                      <div className="flex-1 min-w-0">
                        <div className={cn("text-sm font-bold", calcMethod === val ? "text-yellow-300" : "text-slate-200")}>{label}</div>
                        <div className="text-xs mt-0.5 leading-relaxed opacity-70">{desc}</div>
                      </div>
                      {calcMethod === val && <CheckCircle2 className="w-4 h-4 text-yellow-400 shrink-0 mt-0.5" />}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
        {phase === "boarding" && (
          <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-800 flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center shrink-0">
                <MapPin className="w-5 h-5 text-emerald-400" />
              </div>
              <div>
                <h2 className="font-bold text-white">Dove sali?</h2>
                <p className="text-xs text-slate-400">Seleziona la fermata di salita</p>
              </div>
            </div>
            <div className="p-5">
              <StopList
                stops={stops}
                selected={boardingStop}
                onSelect={s => { setBoardingStop(s); setAlightingStop(null); }}
              />
            </div>
            {boardingStop && (
              <div className="px-5 pb-5">
                <div className="flex items-center gap-3 bg-emerald-500/10 border border-emerald-500/30 rounded-xl px-4 py-3 mb-3">
                  <MapPin className="w-4 h-4 text-emerald-400 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="text-xs text-slate-400">Salita a</div>
                    <div className="text-sm font-bold text-emerald-300 truncate">{boardingStop.stop_name}</div>
                  </div>
                  <span className="text-sm font-mono text-slate-400 shrink-0">{formatTime(boardingStop.departure_time)}</span>
                </div>
                <button onClick={() => setPhase("alighting")}
                  className="w-full rounded-xl py-3.5 font-bold text-sm bg-white text-slate-900 hover:bg-slate-100 flex items-center justify-center gap-2 transition-all shadow-lg">
                  Avanti — scegli dove scendi <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            )}
          </div>
        )}

        {/* ══════════════════════════════════════════
            STEP 3 — Fermata di discesa
        ══════════════════════════════════════════ */}
        {phase === "alighting" && boardingStop && (
          <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-800 flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-orange-500/20 border border-orange-500/40 flex items-center justify-center shrink-0">
                <ArrowDown className="w-5 h-5 text-orange-400" />
              </div>
              <div>
                <h2 className="font-bold text-white">Dove scendi?</h2>
                <p className="text-xs text-slate-400">Salita: <span className="text-emerald-300 font-medium">{boardingStop.stop_name}</span></p>
              </div>
            </div>
            <div className="p-5">
              <StopList
                stops={stops}
                selected={alightingStop}
                onSelect={setAlightingStop}
                highlightId={boardingStop.stop_id}
                disableBefore={boardingStop.stop_id}
              />
            </div>
            {alightingStop && (
              <div className="px-5 pb-5">
                {/* OD summary */}
                <div className="rounded-xl border border-slate-700 bg-slate-800/50 overflow-hidden mb-3">
                  <div className="flex items-stretch">
                    <div className="flex flex-col items-center py-3 px-3 gap-1">
                      <div className="w-2.5 h-2.5 rounded-full bg-emerald-400" />
                      <div className="w-0.5 flex-1 bg-gradient-to-b from-emerald-400 to-orange-400" />
                      <div className="w-2.5 h-2.5 rounded-full bg-orange-400" />
                    </div>
                    <div className="flex-1 divide-y divide-slate-700/50">
                      <div className="px-3 py-2.5">
                        <div className="text-[10px] text-slate-500 uppercase">Salita</div>
                        <div className="text-sm font-semibold text-emerald-300">{boardingStop.stop_name}</div>
                        <div className="text-xs text-slate-500">{formatTime(boardingStop.departure_time)}</div>
                      </div>
                      <div className="px-3 py-2.5">
                        <div className="text-[10px] text-slate-500 uppercase">Discesa</div>
                        <div className="text-sm font-semibold text-orange-300">{alightingStop.stop_name}</div>
                        <div className="text-xs text-slate-500">{formatTime(alightingStop.departure_time)}</div>
                      </div>
                    </div>
                  </div>
                </div>
                <button onClick={doPay}
                  className="w-full rounded-xl py-3.5 font-bold text-sm bg-white text-slate-900 hover:bg-slate-100 flex items-center justify-center gap-2 transition-all shadow-lg">
                  <Zap className="w-4 h-4" /> Procedi al pagamento
                </button>
              </div>
            )}
          </div>
        )}

        {/* ══════════════════════════════════════════
            STEP 4 — Pagamento animato
        ══════════════════════════════════════════ */}
        {phase === "paying" && (
          <div className="bg-slate-900 border border-slate-800 rounded-2xl px-6 py-12 flex flex-col items-center gap-8">
            <div className={cn(
              "w-24 h-24 rounded-2xl flex items-center justify-center transition-all duration-500",
              payStep >= 3 ? "bg-emerald-500/20 border-2 border-emerald-500 scale-110" :
              payStep >= 1 ? "bg-blue-500/20 border-2 border-blue-500 animate-pulse" :
              "bg-slate-800 border-2 border-slate-700"
            )}>
              {paymentMethod === "cash" ? <Euro className="w-10 h-10 text-white" />
                : paymentMethod === "card" ? <CreditCard className="w-10 h-10 text-white" />
                : <Smartphone className="w-10 h-10 text-white" />}
            </div>
            <div className="w-full max-w-xs space-y-2">
              {[
                "Avvicina il dispositivo…",
                "Lettura titolo di viaggio…",
                "Calcolo tariffa in corso…",
                "✅ Validazione completata!",
              ].map((label, i) => (
                <div key={i} className={cn(
                  "flex items-center gap-3 px-4 py-3 rounded-xl text-sm transition-all duration-300",
                  payStep > i ? "bg-emerald-500/15 border border-emerald-500/30 text-emerald-300" :
                  payStep === i ? "bg-blue-500/15 border border-blue-500/30 text-white animate-pulse" :
                  "bg-slate-800/50 border border-slate-800 text-slate-600"
                )}>
                  <div className={cn("w-5 h-5 rounded-full flex items-center justify-center text-xs font-bold shrink-0",
                    payStep > i ? "bg-emerald-500 text-white" :
                    payStep === i ? "bg-blue-500 text-white" :
                    "bg-slate-700 text-slate-500"
                  )}>
                    {payStep > i ? "✓" : i + 1}
                  </div>
                  {label}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ══════════════════════════════════════════
            STEP 5 — Ricevuta
        ══════════════════════════════════════════ */}
        {phase === "receipt" && fareResult && boardingStop && alightingStop && (
          <div className="space-y-4">
            {/* Tariffa headline */}
            <div className={cn(
              "rounded-2xl p-6 flex flex-col items-center gap-4 border",
              passengerType === "abbonato" ? "bg-emerald-500/10 border-emerald-500/40" : "bg-slate-900 border-slate-700"
            )}>
              <div className="w-14 h-14 rounded-2xl bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center">
                <CheckCircle2 className="w-7 h-7 text-emerald-400" />
              </div>
              <div className="text-center w-full">
                <p className="text-slate-400 text-sm mb-2">Titolo di viaggio validato</p>
                {passengerType === "abbonato" ? (
                  <div className="text-3xl font-black text-emerald-400">ABBONAMENTO ✓</div>
                ) : isUrban && fareResult.products && fareResult.products.length > 0 ? (
                  <div className="w-full space-y-2 mt-1">
                    <p className="text-xs text-slate-500 uppercase tracking-wide mb-3">Biglietti disponibili — tariffa a tempo</p>
                    {fareResult.products.map((p, pi) => {
                      const price = passengerType === "ridotto" ? Math.round(p.amount * 0.5 * 100) / 100 : p.amount;
                      return (
                        <div key={pi} className="flex items-center justify-between bg-slate-800 border border-slate-700 rounded-xl px-4 py-3">
                          <div className="text-left">
                            <div className="text-sm font-bold text-white">{p.name}</div>
                            <div className="text-xs text-slate-400">{p.durationMinutes} min di validità</div>
                          </div>
                          <div className="text-2xl font-black text-white">€ {price.toFixed(2)}</div>
                        </div>
                      );
                    })}
                    {passengerType === "ridotto" && (
                      <p className="text-xs text-slate-500 text-center">Riduzione 50% applicata</p>
                    )}
                  </div>
                ) : fareResult.amount != null ? (
                  <>
                    <div className="text-6xl font-black tracking-tight text-white">
                      € {(passengerType === "ridotto" ? Math.round(fareResult.amount * 0.5 * 100) / 100 : fareResult.amount).toFixed(2)}
                    </div>
                    {passengerType === "ridotto" && (
                      <div className="text-xs text-slate-400 mt-1">Ridotto 50% · tariffa piena € {fareResult.amount.toFixed(2)}</div>
                    )}
                  </>
                ) : (
                  <div className="text-xl font-bold text-orange-400">Tariffa non disponibile</div>
                )}
              </div>
            </div>

            {/* Dettaglio viaggio */}
            <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden">
              {/* Linea */}
              <div className="px-5 py-3.5 border-b border-slate-800 flex items-center gap-3">
                <div className="w-9 h-9 rounded-lg flex items-center justify-center font-black text-xs shrink-0"
                  style={{ backgroundColor: routeBg(selectedRoute?.route_color ?? null), color: textOnColor(selectedRoute?.route_color ?? null) }}>
                  {selectedRoute?.route_short_name?.slice(0,4)}
                </div>
                <div>
                  <div className="font-bold text-sm text-white">{selectedRoute?.route_long_name || selectedRoute?.route_short_name}</div>
                  <div className="text-xs text-slate-400">{NET_LABELS[selectedRoute?.network_id ?? ""] ?? "—"} · {formatTime(selectedTrip?.departure_time ?? "")}</div>
                </div>
              </div>

              {/* OD */}
              <div className="px-5 py-4 flex items-start gap-3">
                <div className="flex flex-col items-center shrink-0 mt-1">
                  <div className="w-3 h-3 rounded-full bg-emerald-400" />
                  <div className="w-0.5 flex-1 min-h-[36px] bg-gradient-to-b from-emerald-400 to-orange-400" />
                  <div className="w-3 h-3 rounded-full bg-orange-400" />
                </div>
                <div className="flex-1 space-y-4">
                  <div>
                    <div className="text-[10px] text-slate-500 uppercase tracking-wide">Salita</div>
                    <div className="font-semibold text-white">{boardingStop.stop_name}</div>
                    <div className="text-xs text-slate-400">{formatTime(boardingStop.departure_time)}</div>
                  </div>
                  <div>
                    <div className="text-[10px] text-slate-500 uppercase tracking-wide">Discesa</div>
                    <div className="font-semibold text-white">{alightingStop.stop_name}</div>
                    <div className="text-xs text-slate-400">{formatTime(alightingStop.departure_time)}</div>
                  </div>
                </div>
              </div>

              {/* Stats extraurbano */}
              {!isUrban && fareResult.distanceKm > 0 && (
                <div className="grid grid-cols-3 divide-x divide-slate-800 border-t border-slate-800">
                  {[
                    ["Distanza", `${fareResult.distanceKm.toFixed(1)} km`],
                    ["Fascia", fareResult.fascia ?? "—"],
                    ["Range", fareResult.bandRange ?? "—"],
                  ].map(([label, val]) => (
                    <div key={label} className="px-4 py-3 text-center">
                      <div className="text-[10px] text-slate-500 uppercase tracking-wide mb-0.5">{label}</div>
                      <div className="font-bold text-sm text-white">{val}</div>
                    </div>
                  ))}
                </div>
              )}

              {/* Passeggero & pagamento */}
              <div className="grid grid-cols-2 divide-x divide-slate-800 border-t border-slate-800">
                <div className="px-4 py-3 flex items-center gap-2">
                  <User className="w-4 h-4 text-slate-500 shrink-0" />
                  <div>
                    <div className="text-[10px] text-slate-500 uppercase tracking-wide">Passeggero</div>
                    <div className="text-sm font-semibold text-white">
                      {passengerType === "standard" ? "Ordinario" : passengerType === "ridotto" ? "Ridotto" : "Abbonamento"}
                    </div>
                  </div>
                </div>
                <div className="px-4 py-3 flex items-center gap-2">
                  {paymentMethod === "cash" ? <Euro className="w-4 h-4 text-slate-500 shrink-0" />
                    : paymentMethod === "card" ? <CreditCard className="w-4 h-4 text-slate-500 shrink-0" />
                    : <Smartphone className="w-4 h-4 text-slate-500 shrink-0" />}
                  <div>
                    <div className="text-[10px] text-slate-500 uppercase tracking-wide">Pagamento</div>
                    <div className="text-sm font-semibold text-white">
                      {paymentMethod === "cash" ? "Contanti" : paymentMethod === "card" ? "Carta / NFC" : "App Mobile"}
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {fareResult.amount == null && !fareResult.products?.length && passengerType !== "abbonato" && (
              <div className="bg-orange-500/10 border border-orange-500/30 rounded-xl px-4 py-3 flex items-start gap-2 text-sm text-orange-300">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-orange-400" />
                Nessuna fascia tariffaria trovata. Verificare la configurazione delle fasce km.
              </div>
            )}

            <button onClick={reset}
              className="w-full rounded-xl py-3.5 font-bold text-sm bg-slate-800 hover:bg-slate-700 border border-slate-700 text-white flex items-center justify-center gap-2 transition-all">
              <RotateCcw className="w-4 h-4" /> Nuova simulazione
            </button>
          </div>
        )}

      </div>
    </div>
  );
}
