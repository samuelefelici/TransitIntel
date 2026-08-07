/**
 * TRENI ↔ CORSE — la tabella delle coincidenze, stazione per stazione.
 *
 * È la vista che prima non esisteva: l'orario dei treni e le corse del
 * progetto FIANCO A FIANCO, riga per riga, nei due versi del viaggio.
 * Ogni riga risponde a una domanda sola: "questo treno ha la sua corsa?".
 * Le righe scoperte si isolano con un filtro: è lì che si interviene.
 */
import { useMemo, useState } from "react";
import { TrainFront, ArrowRight, ArrowLeft, Footprints } from "lucide-react";
import type { HubAnalysis } from "./types";
import { HUB_COLORS, hubIcon } from "./constants";

type Dir = "arrivi" | "partenze";
type Verdict = { label: string; cls: string };

const V = {
  ok:       { label: "✓ ok",       cls: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30" },
  stretto:  { label: "△ stretto",  cls: "bg-amber-500/15 text-amber-300 border-amber-500/30" },
  attesa:   { label: "△ attesa",   cls: "bg-amber-500/15 text-amber-300 border-amber-500/30" },
  perso:    { label: "⚠ perso",    cls: "bg-orange-500/15 text-orange-300 border-orange-500/30" },
  scoperto: { label: "✗ scoperto", cls: "bg-red-500/15 text-red-300 border-red-500/40" },
} satisfies Record<string, Verdict>;

interface Row {
  time: string;          // orario del TRENO (l'evento a cui ci si aggancia)
  place: string;         // da dove viene / dove va
  bus: string | null;    // la corsa: "[L1] 06:31 → Ospedale" o "[L3] arr. 07:29"
  delta: string | null;  // attesa o margine, in minuti
  verdict: Verdict;
  covered: boolean;
}

function arrivalRows(h: HubAnalysis): Row[] {
  return (h.arrivalConnections ?? []).map(ac => {
    const covered = ac.status === "ok" || ac.status === "long-wait";
    const verdict =
      ac.status === "ok" ? V.ok
      : ac.status === "long-wait" ? V.attesa
      : ac.status === "just-missed" ? V.perso
      : V.scoperto;
    return {
      time: ac.arrivalTime,
      place: ac.origin,
      bus: ac.firstBus
        ? `[${ac.firstBus.routeShortName}] ${ac.firstBus.departureTime}${ac.firstBus.destination ? ` → ${ac.firstBus.destination}` : ""}`
        : ac.justMissed[0]
          ? `[${ac.justMissed[0].routeShortName}] partito ${ac.justMissed[0].departureTime}`
          : null,
      delta: ac.firstBus ? `${ac.firstBus.waitMin}′`
        : ac.justMissed[0] ? `−${ac.justMissed[0].missedByMin}′` : null,
      verdict, covered,
    };
  }).sort((a, b) => a.time.localeCompare(b.time));
}

function departureRows(h: HubAnalysis): Row[] {
  return (h.departureConnections ?? []).map(dc => {
    const covered = dc.bestBusArrival != null;
    /* Margine sotto i 10′: il bus arriva, ma basta un ritardo per perdere
     * il treno — merita un verdetto suo, non un "ok" qualunque. */
    const verdict = covered
      ? ((dc.waitMinutes ?? 99) < 10 ? V.stretto : V.ok)
      : dc.missedBy != null ? V.perso : V.scoperto;
    return {
      time: dc.departureTime,
      place: dc.destination,
      bus: dc.bestBusArrival ? `[${dc.bestBusRoute}] arr. ${dc.bestBusArrival}` : null,
      delta: dc.waitMinutes != null ? `${dc.waitMinutes}′`
        : dc.missedBy != null ? `−${dc.missedBy}′` : null,
      verdict, covered,
    };
  }).sort((a, b) => a.time.localeCompare(b.time));
}

export default function TrainConnections({
  hubs, onFocus,
}: {
  hubs: HubAnalysis[];
  onFocus?: (lat: number, lng: number) => void;
}) {
  const [dir, setDir] = useState<Dir>("arrivi");
  const [soloScoperti, setSoloScoperti] = useState(false);

  /* Solo i nodi con un orario da incrociare: gli altri non hanno righe. */
  const stations = useMemo(() =>
    hubs
      .map(h => ({ h, rows: dir === "arrivi" ? arrivalRows(h) : departureRows(h) }))
      .filter(s => s.rows.length > 0),
    [hubs, dir]);

  if (stations.length === 0 && hubs.length > 0) {
    return (
      <div className="rounded-xl border border-slate-700/40 bg-slate-800/40 p-4 text-center">
        <p className="text-xs text-slate-300 font-medium">Nessun orario treno da incrociare</p>
        <p className="text-[10px] text-slate-500 mt-1">Premi «Sync orari» nella barra in alto per scaricare gli orari reali delle stazioni.</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {/* ── Verso del viaggio + filtro ── */}
      <div className="flex items-center gap-1.5">
        <div className="flex gap-1 p-0.5 rounded-lg bg-slate-900/60 border border-slate-700/40 flex-1">
          <button onClick={() => setDir("arrivi")}
            title="Il passeggero scende dal treno: trova una tua corsa?"
            className={`flex-1 flex items-center justify-center gap-1 text-[10px] px-2 py-1.5 rounded-md transition-all ${
              dir === "arrivi" ? "bg-cyan-500/20 text-cyan-300 font-semibold border border-cyan-500/40" : "text-slate-400 hover:text-slate-200 border border-transparent"
            }`}>
            <TrainFront className="w-3 h-3" /><ArrowRight className="w-3 h-3" /> Treno → tua corsa
          </button>
          <button onClick={() => setDir("partenze")}
            title="Il passeggero deve prendere il treno: una tua corsa lo porta in tempo?"
            className={`flex-1 flex items-center justify-center gap-1 text-[10px] px-2 py-1.5 rounded-md transition-all ${
              dir === "partenze" ? "bg-cyan-500/20 text-cyan-300 font-semibold border border-cyan-500/40" : "text-slate-400 hover:text-slate-200 border border-transparent"
            }`}>
            <ArrowLeft className="w-3 h-3" /><TrainFront className="w-3 h-3" /> Tua corsa → treno
          </button>
        </div>
        <button onClick={() => setSoloScoperti(v => !v)}
          className={`text-[10px] px-2.5 py-1.5 rounded-lg border font-semibold transition-all ${
            soloScoperti ? "bg-red-500/15 text-red-300 border-red-500/40" : "bg-slate-900/40 text-slate-400 border-slate-700/40 hover:text-slate-200"
          }`}>
          Solo scoperti
        </button>
      </div>

      {stations.map(({ h, rows }) => {
        const shown = soloScoperti ? rows.filter(r => !r.covered) : rows;
        const ok = rows.filter(r => r.covered).length;
        return (
          <div key={h.hub.id} className="rounded-xl border border-slate-700/40 bg-slate-800/40 overflow-hidden">
            {/* Intestazione stazione — clic = zoom in mappa */}
            <button
              onClick={() => onFocus?.(h.hub.lat, h.hub.lng)}
              className="w-full px-2.5 py-2 flex items-center gap-2 text-left hover:bg-slate-700/20 transition-colors">
              <div className="w-6 h-6 rounded-lg flex items-center justify-center shrink-0"
                style={{ backgroundColor: HUB_COLORS[h.hub.type] + "22", color: HUB_COLORS[h.hub.type] }}>
                {hubIcon(h.hub.type, "w-3.5 h-3.5")}
              </div>
              <span className="text-[11px] font-bold text-white truncate flex-1">{h.hub.name}</span>
              {h.hub.dataTrust === "stima" && (
                <span className="text-[8px] font-semibold px-1.5 py-0.5 rounded border bg-amber-500/15 text-amber-300 border-amber-500/40 shrink-0">stima</span>
              )}
              <span className="text-[9px] font-mono shrink-0">
                <span className={ok === rows.length ? "text-emerald-400" : "text-slate-300"}>{ok}</span>
                <span className="text-slate-500">/{rows.length} coperti</span>
              </span>
            </button>

            {/* La tabella: un treno per riga, la sua corsa accanto */}
            {shown.length === 0 ? (
              <p className="px-2.5 pb-2 text-[10px] text-emerald-400/80">Tutte le coincidenze di questa stazione sono coperte.</p>
            ) : (
              <div className="max-h-56 overflow-y-auto">
                <table className="w-full text-[10px]" style={{ fontVariantNumeric: "tabular-nums" }}>
                  <thead>
                    <tr className="text-[8px] uppercase tracking-wide text-slate-500 border-t border-b border-slate-700/30 sticky top-0 bg-slate-800/95">
                      <th className="text-left font-semibold px-2.5 py-1">Treno</th>
                      <th className="text-left font-semibold px-1 py-1">{dir === "arrivi" ? "Da" : "Per"}</th>
                      <th className="text-left font-semibold px-1 py-1">Tua corsa</th>
                      <th className="text-right font-semibold px-1 py-1" title={dir === "arrivi" ? "Attesa alla fermata" : "Margine per raggiungere il treno"}>Δ</th>
                      <th className="text-right font-semibold px-2.5 py-1">Esito</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((r, i) => (
                      <tr key={i} className={`border-b border-slate-700/15 ${r.covered ? "" : "bg-red-500/5"}`}>
                        <td className="px-2.5 py-1 font-mono font-semibold text-white whitespace-nowrap">{r.time}</td>
                        <td className="px-1 py-1 text-slate-400 truncate max-w-[90px]">{r.place}</td>
                        <td className="px-1 py-1 whitespace-nowrap">
                          {r.bus
                            ? <span className={r.covered ? "text-cyan-300 font-mono" : "text-slate-500 font-mono line-through"}>{r.bus}</span>
                            : <span className="text-slate-600 italic">nessuna utile</span>}
                        </td>
                        <td className="px-1 py-1 text-right font-mono text-slate-300 whitespace-nowrap">{r.delta ?? "—"}</td>
                        <td className="px-2.5 py-1 text-right whitespace-nowrap">
                          <span className={`inline-block text-[8px] font-bold px-1.5 py-0.5 rounded border ${r.verdict.cls}`}>{r.verdict.label}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })}

      <p className="text-[8px] text-slate-600 leading-relaxed flex items-start gap-1 px-1">
        <Footprints className="w-3 h-3 shrink-0" />
        <span>Δ = {dir === "arrivi" ? "attesa alla fermata dopo il cammino dalla banchina" : "margine tra l'arrivo della corsa e la partenza del treno (cammino incluso)"}.
        «Stretto» = margine sotto i 10′: basta un piccolo ritardo per perdere la coincidenza.</span>
      </p>
    </div>
  );
}
