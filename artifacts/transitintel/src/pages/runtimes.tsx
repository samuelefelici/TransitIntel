/**
 * TEMPI DI PERCORRENZA AUTOMATICI — programmato vs osservato per tratta.
 *
 * I transiti reali dell'AVM (caronte.stop_transits) diventano tempi di
 * percorrenza misurati tra fermate consecutive: mediana e p85 osservati
 * contro il tempo programmato, aggregati per linea + tratta. Le tratte
 * "fuori soglia" (osservato >> programmato) sono quelle da ritarare nel
 * TTD / Planner Studio.
 */
import { Fragment, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle, CheckCircle2, Clock, Download, Gauge, Loader2,
  MapPin, Radio, Timer, XCircle,
} from "lucide-react";
import { apiFetch } from "@/lib/api";

interface RuntimeSegment {
  routeId: string | null;
  routeShortName: string | null;
  routeColor: string | null;
  fromStopId: string | null;
  fromStopName: string | null;
  toStopId: string | null;
  toStopName: string | null;
  samples: number;
  schedSeconds: number | null;
  obsMedianSeconds: number | null;
  obsP85Seconds: number | null;
  deltaSeconds: number | null;
  deltaPct: number | null;
}
interface RuntimesResp {
  caronteAvailable: boolean;
  days: number;
  segments: RuntimeSegment[];
}
interface GtfsRoute { routeId: string; routeShortName: string | null; routeLongName: string | null }

interface TripRuntime {
  tripId: string;
  routeId: string | null;
  routeShortName: string | null;
  routeLongName: string | null;
  routeColor: string | null;
  directionId: number | null;
  headsign: string | null;
  shapeId: string | null;
  startTime: string | null;
  runs: number;
  avgObsStops: number | null;
  totalStops: number | null;
  schedSeconds: number | null;
  obsMedianSeconds: number | null;
  deltaSeconds: number | null;
  deltaPct: number | null;
}
interface ByTripResp { caronteAvailable: boolean; trips: TripRuntime[] }

interface DetailStop {
  seq: number;
  stopId: string;
  stopName: string | null;
  lat: number | null;
  lon: number | null;
  scheduledSec: number | null;
  actualTs: string | null;
  delaySeconds: number | null;
  recorded: boolean;
  arcSchedSeconds: number | null;
  arcObsSeconds: number | null;
  arcDeltaSeconds: number | null;
  dwellSeconds: number | null;
  served: boolean;
}
interface RuntimeDetail {
  caronteAvailable: boolean;
  day: string | null;
  availableDays: Array<{ day: string; transits: number }>;
  dwellRadius: number;
  dwellSeconds: number;
  trip: { headsign: string | null; routeShortName: string | null; routeColor: string | null } | null;
  totals: {
    scheduledStops: number; recordedStops: number; servedStops: number; missingStops: number;
    schedTotalSeconds: number | null; obsTotalSeconds: number | null; deltaSeconds: number | null;
    gpsPoints: number;
  } | null;
  stops: DetailStop[];
  missing: Array<{ seq: number; stopId: string; stopName: string | null }>;
}

const BANDS = [
  { label: "Tutto il giorno", hourFrom: null as number | null, hourTo: null as number | null },
  { label: "Punta AM (6–9)", hourFrom: 6, hourTo: 9 },
  { label: "Morbida (9–13)", hourFrom: 9, hourTo: 13 },
  { label: "Punta PM (16–19)", hourFrom: 16, hourTo: 19 },
];

function fmtSec(s: number | null): string {
  if (s == null) return "—";
  const m = Math.floor(s / 60);
  return `${m}'${String(s % 60).padStart(2, "0")}"`;
}
function deltaColor(pct: number | null): string {
  if (pct == null) return "#64748b";
  if (pct > 20) return "#ef4444";   // molto più lento del programmato
  if (pct > 10) return "#f59e0b";
  if (pct < -15) return "#38bdf8";  // molto più veloce: orario largo
  return "#10b981";
}
// secondi con segno (ritardo +, anticipo −)
function fmtSigned(s: number | null): string {
  if (s == null) return "—";
  const sign = s > 0 ? "+" : s < 0 ? "−" : "";
  const a = Math.abs(s);
  return `${sign}${Math.floor(a / 60)}'${String(a % 60).padStart(2, "0")}"`;
}
// secondi-dal-mezzanotte → HH:MM (gestisce le corse oltre le 24)
function fmtClock(sec: number | null): string {
  if (sec == null) return "—";
  const h = Math.floor(sec / 3600) % 24;
  const m = Math.floor((sec % 3600) / 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}
// puntualità: in orario −60s..+300s = verde, ritardo = ambra/rosso, anticipo = blu
function delayColor(s: number | null): string {
  if (s == null) return "#64748b";
  if (s > 300) return "#ef4444";
  if (s > 60) return "#f59e0b";
  if (s < -60) return "#38bdf8";
  return "#10b981";
}

export default function RuntimesPage() {
  const [days, setDays] = useState(14);
  const [routeId, setRouteId] = useState("");
  const [band, setBand] = useState(0);
  // classificazione richiesta: Linea → Percorso → Corsa (vista default) + per tratta
  const [view, setView] = useState<"corse" | "tratte">("corse");
  const [openRoutes, setOpenRoutes] = useState<Set<string>>(new Set());
  const [openTrip, setOpenTrip] = useState<string | null>(null);

  const routesQ = useQuery({
    queryKey: ["runtimes", "routes"],
    queryFn: () => apiFetch<{ routes: GtfsRoute[] }>("/api/timetables/routes"),
    staleTime: 5 * 60 * 1000,
  });

  const b = BANDS[band];
  const qs = new URLSearchParams({ days: String(days) });
  if (routeId) qs.set("routeId", routeId);
  if (b.hourFrom != null) { qs.set("hourFrom", String(b.hourFrom)); qs.set("hourTo", String(b.hourTo)); }

  const dataQ = useQuery({
    queryKey: ["runtimes", days, routeId, band],
    queryFn: () => apiFetch<RuntimesResp>(`/api/operations/runtimes?${qs.toString()}`),
    enabled: view === "tratte",
  });

  const byTripQ = useQuery({
    queryKey: ["runtimes-trip", days, routeId, band],
    queryFn: () => apiFetch<ByTripResp>(`/api/operations/runtimes/by-trip?${qs.toString()}`),
    enabled: view === "corse",
  });

  /* Gerarchia Linea → Percorso (direzione+destinazione/shape) → Corse */
  const tree = useMemo(() => {
    const trips = byTripQ.data?.trips ?? [];
    const routes = new Map<string, {
      key: string; shortName: string | null; longName: string | null; color: string | null;
      variants: Map<string, { key: string; label: string; trips: TripRuntime[] }>;
    }>();
    for (const t of trips) {
      const rKey = t.routeId ?? "?";
      let r = routes.get(rKey);
      if (!r) {
        r = { key: rKey, shortName: t.routeShortName, longName: t.routeLongName, color: t.routeColor, variants: new Map() };
        routes.set(rKey, r);
      }
      const vKey = t.shapeId ?? `d${t.directionId ?? "?"}|${t.headsign ?? ""}`;
      let v = r.variants.get(vKey);
      if (!v) {
        const dir = t.directionId === 1 ? "Ritorno" : t.directionId === 0 ? "Andata" : "—";
        v = { key: vKey, label: `${dir}${t.headsign ? ` → ${t.headsign}` : ""}`, trips: [] };
        r.variants.set(vKey, v);
      }
      v.trips.push(t);
    }
    const out = [...routes.values()].map(r => ({
      ...r,
      variantList: [...r.variants.values()].map(v => {
        const sorted = [...v.trips].sort((a, c) => String(a.startTime ?? "").localeCompare(String(c.startTime ?? "")));
        const deltas = sorted.map(t => t.deltaPct).filter((d): d is number => d != null);
        const avgDelta = deltas.length ? Math.round((deltas.reduce((x, y) => x + y, 0) / deltas.length) * 10) / 10 : null;
        return { ...v, trips: sorted, avgDelta };
      }).sort((a, c) => a.label.localeCompare(c.label)),
    })).sort((a, c) => String(a.shortName ?? "").localeCompare(String(c.shortName ?? ""), "it", { numeric: true }));
    return out;
  }, [byTripQ.data]);

  const toggleRoute = (k: string) => setOpenRoutes(prev => {
    const n = new Set(prev); n.has(k) ? n.delete(k) : n.add(k); return n;
  });

  const segments = dataQ.data?.segments ?? [];
  const critical = useMemo(() => segments.filter(s => (s.deltaPct ?? 0) > 20).length, [segments]);
  const loose = useMemo(() => segments.filter(s => (s.deltaPct ?? 0) < -15).length, [segments]);

  const sortedRoutes = useMemo(() => {
    const list = routesQ.data?.routes ?? [];
    return [...list].sort((a, c) =>
      String(a.routeShortName ?? "").localeCompare(String(c.routeShortName ?? ""), "it", { numeric: true }));
  }, [routesQ.data]);

  function exportCsv() {
    const head = "linea;da;a;campioni;programmato_s;osservato_mediana_s;osservato_p85_s;delta_s;delta_pct";
    const rows = segments.map(s => [
      s.routeShortName ?? s.routeId, s.fromStopName ?? s.fromStopId, s.toStopName ?? s.toStopId,
      s.samples, s.schedSeconds ?? "", s.obsMedianSeconds ?? "", s.obsP85Seconds ?? "",
      s.deltaSeconds ?? "", s.deltaPct ?? "",
    ].join(";"));
    const blob = new Blob([[head, ...rows].join("\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `tempi-percorrenza-${days}gg.csv`;
    a.click();
  }

  return (
    <div className="max-w-6xl mx-auto space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-rose-500 to-orange-600 flex items-center justify-center shadow-lg">
          <Timer className="w-5 h-5 text-white" />
        </div>
        <div className="flex-1 min-w-52">
          <h1 className="text-xl font-bold">Tempi di Percorrenza</h1>
          <p className="text-xs text-muted-foreground">
            Programmato vs osservato dai transiti AVM · clicca una corsa per il dettaglio fermata×fermata,
            archi, fermate effettivamente fatte e analisi in tempo reale
          </p>
        </div>
        <button
          onClick={exportCsv}
          disabled={segments.length === 0}
          className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white/5 hover:bg-white/10 disabled:opacity-40 text-xs border border-border/60"
        >
          <Download className="w-3.5 h-3.5" /> Export CSV
        </button>
      </div>

      {/* Filtri */}
      <div className="flex flex-wrap items-center gap-2">
        <select value={routeId} onChange={(e) => setRouteId(e.target.value)}
          className="px-3 py-2 rounded-lg bg-card border border-border/60 text-sm min-w-48">
          <option value="">Tutte le linee</option>
          {sortedRoutes.map(r => (
            <option key={r.routeId} value={r.routeId}>{r.routeShortName ?? r.routeId} · {r.routeLongName ?? ""}</option>
          ))}
        </select>
        <select value={days} onChange={(e) => setDays(Number(e.target.value))}
          className="px-3 py-2 rounded-lg bg-card border border-border/60 text-sm">
          <option value={7}>Ultimi 7 giorni</option>
          <option value={14}>Ultimi 14 giorni</option>
          <option value={30}>Ultimi 30 giorni</option>
        </select>
        <div className="flex rounded-lg overflow-hidden border border-border/60">
          {BANDS.map((bb, i) => (
            <button key={bb.label} onClick={() => setBand(i)}
              className={`px-3 py-2 text-xs transition-colors ${band === i ? "bg-rose-500/20 text-rose-300 font-medium" : "hover:bg-white/5 text-muted-foreground"}`}>
              {bb.label}
            </button>
          ))}
        </div>
      </div>

      {/* Selettore vista: classificazione per corsa (Linea→Percorso→Corsa) o per tratta */}
      <div className="flex rounded-lg overflow-hidden border border-border/60 w-fit">
        <button onClick={() => setView("corse")}
          className={`px-4 py-2 text-xs transition-colors ${view === "corse" ? "bg-rose-500/20 text-rose-300 font-semibold" : "hover:bg-white/5 text-muted-foreground"}`}>
          Linee · Percorsi · Corse
        </button>
        <button onClick={() => setView("tratte")}
          className={`px-4 py-2 text-xs transition-colors ${view === "tratte" ? "bg-rose-500/20 text-rose-300 font-semibold" : "hover:bg-white/5 text-muted-foreground"}`}>
          Per tratta
        </button>
      </div>

      {/* ── Vista gerarchica: Linea → Percorso → Corsa ── */}
      {view === "corse" && (
        <div className="space-y-3">
          {byTripQ.isLoading && (
            <div className="p-10 text-center text-sm text-muted-foreground flex items-center justify-center gap-2 rounded-xl border border-border/60 bg-card/60">
              <Loader2 className="w-4 h-4 animate-spin" /> Analizzo le corse osservate…
            </div>
          )}
          {!byTripQ.isLoading && tree.length === 0 && (
            <div className="p-10 text-center text-sm text-muted-foreground rounded-xl border border-border/60 bg-card/60">
              Nessuna corsa osservata nel periodo: i dati si accumulano con l'uso di Caronte.
            </div>
          )}
          {tree.map(r => {
            const nTrips = r.variantList.reduce((sum, v) => sum + v.trips.length, 0);
            const open = openRoutes.has(r.key);
            return (
              <div key={r.key} className="rounded-xl border border-border/60 bg-card/60 overflow-hidden">
                {/* Livello 1: LINEA */}
                <button onClick={() => toggleRoute(r.key)}
                  className="w-full px-4 py-2.5 flex items-center gap-3 hover:bg-white/5 text-left">
                  <span className="px-2 py-0.5 rounded text-white text-xs font-bold"
                    style={{ backgroundColor: r.color ? `#${String(r.color).replace(/^#/, "")}` : "#334155" }}>
                    {r.shortName ?? r.key}
                  </span>
                  <span className="text-xs text-muted-foreground truncate flex-1">{r.longName}</span>
                  <span className="text-[10px] font-mono text-muted-foreground">
                    {r.variantList.length} percorsi · {nTrips} corse
                  </span>
                  <span className={`text-xs transition-transform ${open ? "rotate-90" : ""}`}>▸</span>
                </button>

                {open && r.variantList.map(v => (
                  <div key={v.key} className="border-t border-border/30">
                    {/* Livello 2: PERCORSO */}
                    <div className="px-5 py-1.5 bg-white/[0.03] flex items-center gap-2 text-[11px]">
                      <span className="font-semibold">{v.label}</span>
                      <span className="text-muted-foreground">· {v.trips.length} corse</span>
                      {v.avgDelta != null && (
                        <span className="ml-auto font-mono font-bold" style={{ color: deltaColor(v.avgDelta) }}>
                          Δ medio {v.avgDelta > 0 ? "+" : ""}{v.avgDelta}%
                        </span>
                      )}
                    </div>
                    {/* Livello 3: CORSE */}
                    <table className="min-w-full text-[11px] border-collapse">
                      <thead>
                        <tr className="text-muted-foreground text-left">
                          <th className="px-5 py-1 font-medium">Partenza</th>
                          <th className="px-2 py-1 font-medium text-right">Giornate</th>
                          <th className="px-2 py-1 font-medium text-right">Copertura</th>
                          <th className="px-2 py-1 font-medium text-right">Programmato</th>
                          <th className="px-2 py-1 font-medium text-right">Osservato</th>
                          <th className="px-4 py-1 font-medium text-right">Δ</th>
                        </tr>
                      </thead>
                      <tbody>
                        {v.trips.map(t => {
                          const isOpen = openTrip === t.tripId;
                          return (
                          <Fragment key={t.tripId}>
                          <tr
                            onClick={() => setOpenTrip(isOpen ? null : t.tripId)}
                            className={`cursor-pointer transition-colors ${isOpen ? "bg-rose-500/10" : "odd:bg-white/[0.02] hover:bg-white/[0.05]"}`}>
                            <td className="px-5 py-1 font-mono">
                              <span className={`inline-block mr-1.5 text-[9px] transition-transform ${isOpen ? "rotate-90" : ""}`}>▸</span>
                              {t.startTime ? t.startTime.slice(0, 5) : "—"}
                            </td>
                            <td className="px-2 py-1 text-right font-mono">{t.runs}</td>
                            <td className="px-2 py-1 text-right font-mono text-muted-foreground">
                              {t.avgObsStops != null && t.totalStops ? `${t.avgObsStops}/${t.totalStops}` : "—"}
                            </td>
                            <td className="px-2 py-1 text-right font-mono">{fmtSec(t.schedSeconds)}</td>
                            <td className="px-2 py-1 text-right font-mono font-semibold">{fmtSec(t.obsMedianSeconds)}</td>
                            <td className="px-4 py-1 text-right font-mono font-bold" style={{ color: deltaColor(t.deltaPct) }}>
                              {t.deltaPct != null ? `${t.deltaPct > 0 ? "+" : ""}${t.deltaPct}%` : "—"}
                            </td>
                          </tr>
                          {isOpen && (
                            <tr>
                              <td colSpan={6} className="p-0">
                                <TripRuntimeDetail tripId={t.tripId} days={days} />
                              </td>
                            </tr>
                          )}
                          </Fragment>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      )}

      {view === "tratte" && (<>
      {/* KPI sintesi */}
      <div className="flex flex-wrap gap-2 text-[11px]">
        <span className="px-3 py-1.5 rounded-lg bg-white/5 border border-border/50 flex items-center gap-1.5">
          <Gauge className="w-3.5 h-3.5 text-rose-400" /> {segments.length} tratte analizzate
        </span>
        <span className="px-3 py-1.5 rounded-lg bg-red-500/10 border border-red-500/30 text-red-300 flex items-center gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5" /> {critical} sotto-tempate (osservato &gt;20% del programmato)
        </span>
        <span className="px-3 py-1.5 rounded-lg bg-sky-500/10 border border-sky-500/30 text-sky-300 flex items-center gap-1.5">
          <Clock className="w-3.5 h-3.5" /> {loose} con orario largo (&gt;15% più veloci)
        </span>
      </div>

      {/* Tabella */}
      <div className="rounded-xl border border-border/60 bg-card/60 overflow-auto max-h-[65vh]">
        {dataQ.isLoading ? (
          <div className="p-10 text-center text-sm text-muted-foreground flex items-center justify-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin" /> Analizzo i transiti AVM…
          </div>
        ) : dataQ.data && !dataQ.data.caronteAvailable ? (
          <div className="p-10 text-center text-sm text-muted-foreground">
            Schema caronte non inizializzato: i tempi arrivano dai transiti AVM.
          </div>
        ) : segments.length === 0 ? (
          <div className="p-10 text-center text-sm text-muted-foreground">
            Nessun transito AVM nel periodo (servono almeno 3 campioni per tratta).
            I dati si accumulano man mano che gli autisti usano Caronte.
          </div>
        ) : (
          <table className="min-w-full text-xs border-collapse">
            <thead className="sticky top-0 bg-background z-10">
              <tr className="text-muted-foreground text-left">
                <th className="px-3 py-2 border-b border-border/50">Linea</th>
                <th className="px-3 py-2 border-b border-border/50">Tratta</th>
                <th className="px-3 py-2 border-b border-border/50 text-right">Campioni</th>
                <th className="px-3 py-2 border-b border-border/50 text-right">Programmato</th>
                <th className="px-3 py-2 border-b border-border/50 text-right">Osservato (mediana)</th>
                <th className="px-3 py-2 border-b border-border/50 text-right">p85</th>
                <th className="px-3 py-2 border-b border-border/50 text-right">Δ</th>
              </tr>
            </thead>
            <tbody>
              {[...segments]
                .sort((a, c) => (c.deltaPct ?? -999) - (a.deltaPct ?? -999))
                .map((s, i) => (
                  <tr key={i} className="odd:bg-white/[0.02]">
                    <td className="px-3 py-1.5 border-b border-border/20">
                      <span className="inline-flex px-1.5 py-0.5 rounded text-white text-[10px] font-bold"
                        style={{ backgroundColor: s.routeColor ? `#${String(s.routeColor).replace(/^#/, "")}` : "#334155" }}>
                        {s.routeShortName ?? s.routeId ?? "?"}
                      </span>
                    </td>
                    <td className="px-3 py-1.5 border-b border-border/20 max-w-72 truncate"
                        title={`${s.fromStopName ?? s.fromStopId} → ${s.toStopName ?? s.toStopId}`}>
                      {s.fromStopName ?? s.fromStopId} → {s.toStopName ?? s.toStopId}
                    </td>
                    <td className="px-3 py-1.5 border-b border-border/20 text-right font-mono">{s.samples}</td>
                    <td className="px-3 py-1.5 border-b border-border/20 text-right font-mono">{fmtSec(s.schedSeconds)}</td>
                    <td className="px-3 py-1.5 border-b border-border/20 text-right font-mono font-semibold">{fmtSec(s.obsMedianSeconds)}</td>
                    <td className="px-3 py-1.5 border-b border-border/20 text-right font-mono text-muted-foreground">{fmtSec(s.obsP85Seconds)}</td>
                    <td className="px-3 py-1.5 border-b border-border/20 text-right font-mono font-bold"
                        style={{ color: deltaColor(s.deltaPct) }}>
                      {s.deltaPct != null ? `${s.deltaPct > 0 ? "+" : ""}${s.deltaPct}%` : "—"}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        )}
      </div>

      <p className="text-[11px] text-muted-foreground">
        🔴 osservato &gt;20% oltre il programmato: tratta da ri-tempare (orario irrealistico) ·
        🔵 osservato &gt;15% sotto: orario largo, possibile recupero di minuti nel TTD.
      </p>
      </>)}
    </div>
  );
}

/* ── Dettaglio corsa fermata×fermata: delta, archi, fermate fatte (dwell) ── */
function TripRuntimeDetail({ tripId, days }: { tripId: string; days: number }) {
  const [date, setDate] = useState<string>("");   // "" = ultima giornata osservata
  const [live, setLive] = useState(false);

  const qs = new URLSearchParams({ days: String(days) });
  if (date) qs.set("date", date);

  const q = useQuery({
    queryKey: ["runtime-detail", tripId, days, date],
    queryFn: () => apiFetch<RuntimeDetail>(`/api/operations/trips/${encodeURIComponent(tripId)}/runtime-detail?${qs.toString()}`),
    refetchInterval: live ? 15_000 : false,
  });

  const d = q.data;
  const t = d?.totals;

  return (
    <div className="bg-background/60 border-t border-rose-500/30 px-4 py-3 space-y-3">
      {q.isLoading ? (
        <div className="py-6 text-center text-xs text-muted-foreground flex items-center justify-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin" /> Carico il dettaglio della corsa…
        </div>
      ) : !d || d.stops.length === 0 ? (
        <div className="py-6 text-center text-xs text-muted-foreground">
          Nessun transito o posizione GPS registrati per questa corsa nel periodo.
        </div>
      ) : (
        <>
          {/* Barra controlli: giornata + aggiornamento live */}
          <div className="flex flex-wrap items-center gap-2 text-[11px]">
            <span className="text-muted-foreground">Giornata analizzata:</span>
            <select
              value={date || (d.day ?? "")}
              onChange={(e) => setDate(e.target.value)}
              className="px-2 py-1 rounded bg-card border border-border/60 text-[11px] font-mono">
              {d.availableDays.map((a) => (
                <option key={a.day} value={a.day}>
                  {new Date(a.day).toLocaleDateString("it-IT")} · {a.transits} transiti
                </option>
              ))}
            </select>
            <button
              onClick={() => setLive((v) => !v)}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded border transition-colors ${
                live ? "bg-emerald-500/20 border-emerald-500/40 text-emerald-300" : "bg-white/5 border-border/60 text-muted-foreground hover:bg-white/10"}`}>
              <Radio className={`w-3 h-3 ${live ? "animate-pulse" : ""}`} /> {live ? "Tempo reale (15s)" : "Aggiorna in tempo reale"}
            </button>
            <span className="text-muted-foreground ml-auto">
              sosta ≥ {d.dwellSeconds}s entro {d.dwellRadius}m · {t?.gpsPoints ?? 0} punti GPS
            </span>
          </div>

          {/* Chip riepilogo */}
          <div className="flex flex-wrap gap-2 text-[11px]">
            <span className="px-2.5 py-1 rounded-lg bg-white/5 border border-border/50 flex items-center gap-1.5">
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
              Transito segnalato {t?.recordedStops}/{t?.scheduledStops}
            </span>
            <span className="px-2.5 py-1 rounded-lg bg-white/5 border border-border/50 flex items-center gap-1.5">
              <MapPin className="w-3.5 h-3.5 text-sky-400" />
              Fermate effettivamente fatte {t?.servedStops}/{t?.scheduledStops}
            </span>
            <span className="px-2.5 py-1 rounded-lg bg-red-500/10 border border-red-500/30 text-red-300 flex items-center gap-1.5">
              <XCircle className="w-3.5 h-3.5" /> {t?.missingStops} non rilevate
            </span>
            <span className="px-2.5 py-1 rounded-lg bg-white/5 border border-border/50 flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5 text-rose-400" />
              Totale {fmtSec(t?.obsTotalSeconds ?? null)} oss · {fmtSec(t?.schedTotalSeconds ?? null)} prog
              {t?.deltaSeconds != null && (
                <span className="font-bold font-mono" style={{ color: delayColor(t.deltaSeconds) }}>
                  &nbsp;({fmtSigned(t.deltaSeconds)})
                </span>
              )}
            </span>
          </div>

          {/* Tabella fermata × fermata */}
          <div className="rounded-lg border border-border/50 overflow-auto max-h-[50vh]">
            <table className="min-w-full text-[11px] border-collapse">
              <thead className="sticky top-0 bg-background z-10">
                <tr className="text-muted-foreground text-left">
                  <th className="px-2 py-1.5 font-medium">#</th>
                  <th className="px-2 py-1.5 font-medium">Fermata</th>
                  <th className="px-2 py-1.5 font-medium text-right">Programmato</th>
                  <th className="px-2 py-1.5 font-medium text-right">Reale</th>
                  <th className="px-2 py-1.5 font-medium text-right">Δ orario</th>
                  <th className="px-2 py-1.5 font-medium text-right">Arco oss/prog</th>
                  <th className="px-2 py-1.5 font-medium text-right">Scarto arco</th>
                  <th className="px-2 py-1.5 font-medium text-right">Sosta</th>
                  <th className="px-2 py-1.5 font-medium text-center">Stato</th>
                </tr>
              </thead>
              <tbody>
                {d.stops.map((s) => (
                  <tr key={s.seq} className={`border-t border-border/20 ${!s.served ? "bg-red-500/[0.06]" : "odd:bg-white/[0.02]"}`}>
                    <td className="px-2 py-1 font-mono text-muted-foreground">{s.seq}</td>
                    <td className="px-2 py-1 max-w-[16rem] truncate" title={s.stopName ?? s.stopId}>{s.stopName ?? s.stopId}</td>
                    <td className="px-2 py-1 text-right font-mono">{fmtClock(s.scheduledSec)}</td>
                    <td className="px-2 py-1 text-right font-mono">{fmtTime(s.actualTs)}</td>
                    <td className="px-2 py-1 text-right font-mono font-semibold" style={{ color: delayColor(s.delaySeconds) }}>
                      {fmtSigned(s.delaySeconds)}
                    </td>
                    <td className="px-2 py-1 text-right font-mono text-muted-foreground">
                      {s.arcObsSeconds != null ? fmtSec(s.arcObsSeconds) : "—"}
                      {s.arcSchedSeconds != null && <span className="opacity-50"> / {fmtSec(s.arcSchedSeconds)}</span>}
                    </td>
                    <td className="px-2 py-1 text-right font-mono font-semibold" style={{ color: delayColor(s.arcDeltaSeconds) }}>
                      {fmtSigned(s.arcDeltaSeconds)}
                    </td>
                    <td className="px-2 py-1 text-right font-mono text-muted-foreground">
                      {s.dwellSeconds != null && s.dwellSeconds > 0 ? `${s.dwellSeconds}s` : "—"}
                    </td>
                    <td className="px-2 py-1 text-center">
                      {s.recorded ? (
                        <span title="Transito registrato dal validatore" className="inline-flex items-center gap-1 text-emerald-400">
                          <CheckCircle2 className="w-3.5 h-3.5" />
                        </span>
                      ) : s.served ? (
                        <span title="Fermata fatta (sosta rilevata dal GPS) ma transito non registrato" className="inline-flex items-center gap-1 text-sky-400">
                          <MapPin className="w-3.5 h-3.5" />
                        </span>
                      ) : (
                        <span title="Nessun transito né sosta rilevati: fermata probabilmente non servita" className="inline-flex items-center gap-1 text-red-400">
                          <XCircle className="w-3.5 h-3.5" />
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="text-[10px] text-muted-foreground leading-relaxed">
            <CheckCircle2 className="inline w-3 h-3 text-emerald-400" /> transito registrato dal validatore ·
            <MapPin className="inline w-3 h-3 text-sky-400 ml-1" /> fermata fatta (sosta GPS rilevata) ma transito non segnalato ·
            <XCircle className="inline w-3 h-3 text-red-400 ml-1" /> fermata non rilevata.
            Δ orario = anticipo/ritardo sul programmato · scarto arco = tempo perso/recuperato sulla tratta dalla fermata precedente.
          </p>
        </>
      )}
    </div>
  );
}
