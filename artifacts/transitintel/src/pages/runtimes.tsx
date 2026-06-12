/**
 * TEMPI DI PERCORRENZA AUTOMATICI — programmato vs osservato per tratta.
 *
 * I transiti reali dell'AVM (caronte.stop_transits) diventano tempi di
 * percorrenza misurati tra fermate consecutive: mediana e p85 osservati
 * contro il tempo programmato, aggregati per linea + tratta. Le tratte
 * "fuori soglia" (osservato >> programmato) sono quelle da ritarare nel
 * TTD / Planner Studio.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Clock, Download, Gauge, Loader2, Timer } from "lucide-react";
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

export default function RuntimesPage() {
  const [days, setDays] = useState(14);
  const [routeId, setRouteId] = useState("");
  const [band, setBand] = useState(0);

  const routesQ = useQuery({
    queryKey: ["runtimes", "routes"],
    queryFn: () => apiFetch<{ data: GtfsRoute[] }>("/api/gtfs/routes"),
    staleTime: 5 * 60 * 1000,
  });

  const b = BANDS[band];
  const qs = new URLSearchParams({ days: String(days) });
  if (routeId) qs.set("routeId", routeId);
  if (b.hourFrom != null) { qs.set("hourFrom", String(b.hourFrom)); qs.set("hourTo", String(b.hourTo)); }

  const dataQ = useQuery({
    queryKey: ["runtimes", days, routeId, band],
    queryFn: () => apiFetch<RuntimesResp>(`/api/operations/runtimes?${qs.toString()}`),
  });

  const segments = dataQ.data?.segments ?? [];
  const critical = useMemo(() => segments.filter(s => (s.deltaPct ?? 0) > 20).length, [segments]);
  const loose = useMemo(() => segments.filter(s => (s.deltaPct ?? 0) < -15).length, [segments]);

  const sortedRoutes = useMemo(() => {
    const list = routesQ.data?.data ?? [];
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
            Programmato vs osservato per tratta, misurato automaticamente dai transiti AVM
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
    </div>
  );
}
