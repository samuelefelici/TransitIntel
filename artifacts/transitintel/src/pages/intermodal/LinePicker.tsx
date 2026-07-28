/**
 * SELETTORE LINEE — decide su quali linee gira l'analisi e cosa si vede.
 *
 * È il comando centrale della sezione: la selezione filtra insieme la
 * copertura della domanda, le coincidenze e le geometrie disegnate sulla
 * mappa, così quello che si legge nel pannello e quello che si vede sulla
 * carta sono sempre la stessa cosa.
 *
 * Nessuna linea selezionata = tutta la rete (è il caso più comune all'apertura).
 */
import { useMemo, useState } from "react";
import { Search, Check, Loader2, Bus, Eye, EyeOff } from "lucide-react";

export interface NetworkLine {
  routeId: string;
  label: string;
  longName: string | null;
  color: string | null;
  trips: number;
}

/** Colore stabile per linea: quello del GTFS se c'è, altrimenti da palette. */
const PALETTE = ["#06b6d4", "#a855f7", "#f59e0b", "#10b981", "#ef4444", "#3b82f6", "#ec4899", "#84cc16"];
export function lineColor(l: NetworkLine, index: number): string {
  return l.color && /^#[0-9a-f]{6}$/i.test(l.color) ? l.color : PALETTE[index % PALETTE.length];
}

export default function LinePicker({
  lines, loading, selected, onChange, showOnMap, onToggleMap, day,
}: {
  lines: NetworkLine[];
  loading: boolean;
  /** vuoto = tutta la rete */
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
  showOnMap: boolean;
  onToggleMap: (v: boolean) => void;
  day: string;
}) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(true);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return lines;
    return lines.filter(l =>
      l.label.toLowerCase().includes(needle) ||
      (l.longName ?? "").toLowerCase().includes(needle));
  }, [lines, q]);

  const colorOf = useMemo(() => {
    const m = new Map<string, string>();
    lines.forEach((l, i) => m.set(l.routeId, lineColor(l, i)));
    return m;
  }, [lines]);

  const toggle = (routeId: string) => {
    const next = new Set(selected);
    if (next.has(routeId)) next.delete(routeId); else next.add(routeId);
    onChange(next);
  };

  const tutte = selected.size === 0;
  const senzaCorse = lines.filter(l => l.trips === 0).length;

  return (
    <div className="bg-slate-800/60 rounded-lg border border-slate-700/40 overflow-hidden">
      {/* Intestazione */}
      <div className="px-3 py-2 flex items-center gap-2">
        <Bus className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
        <button onClick={() => setOpen(v => !v)} className="flex-1 text-left min-w-0">
          <p className="text-[10px] text-slate-300 font-medium">
            Linee analizzate
            <span className="text-slate-500 font-normal">
              {" · "}{tutte ? `tutte (${lines.length})` : `${selected.size} di ${lines.length}`}
            </span>
          </p>
        </button>
        <button
          onClick={() => onToggleMap(!showOnMap)}
          title={showOnMap ? "Nascondi i percorsi sulla mappa" : "Mostra i percorsi sulla mappa"}
          className={`text-[9px] px-1.5 py-1 rounded flex items-center gap-1 border transition-all ${
            showOnMap
              ? "bg-cyan-500/15 text-cyan-300 border-cyan-500/40"
              : "bg-slate-900/40 text-slate-500 border-slate-700/40 hover:text-slate-300"
          }`}>
          {showOnMap ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
          Mappa
        </button>
      </div>

      {open && (
        <div className="px-2 pb-2 space-y-1.5">
          {/* Ricerca + azioni rapide */}
          <div className="flex gap-1">
            <div className="relative flex-1">
              <Search className="w-3 h-3 text-slate-500 absolute left-2 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                value={q} onChange={e => setQ(e.target.value)}
                placeholder="Cerca linea…"
                className="w-full bg-slate-900/60 border border-slate-700/50 rounded pl-6 pr-2 py-1 text-[10px] text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-cyan-500/50"
              />
            </div>
            <button
              onClick={() => onChange(new Set())}
              disabled={tutte}
              className="text-[9px] px-2 py-1 rounded border border-slate-700/50 text-slate-400 hover:text-slate-200 disabled:opacity-40 transition-all">
              Tutte
            </button>
            <button
              onClick={() => onChange(new Set(filtered.map(l => l.routeId)))}
              disabled={filtered.length === 0}
              title="Seleziona le linee mostrate dal filtro"
              className="text-[9px] px-2 py-1 rounded border border-slate-700/50 text-slate-400 hover:text-slate-200 disabled:opacity-40 transition-all">
              Filtrate
            </button>
          </div>

          {loading ? (
            <div className="flex items-center justify-center gap-2 py-4 text-slate-500">
              <Loader2 className="w-3 h-3 animate-spin" />
              <span className="text-[10px]">Carico le linee…</span>
            </div>
          ) : lines.length === 0 ? (
            <p className="text-[10px] text-slate-500 text-center py-3">
              Nessuna linea nella rete di questo progetto.
            </p>
          ) : (
            <>
              <div className="max-h-44 overflow-y-auto space-y-0.5 pr-0.5">
                {filtered.map(l => {
                  const on = selected.has(l.routeId);
                  const col = colorOf.get(l.routeId)!;
                  return (
                    <button key={l.routeId} onClick={() => toggle(l.routeId)}
                      title={l.longName ?? l.label}
                      className={`w-full flex items-center gap-1.5 px-1.5 py-1 rounded text-left transition-all border ${
                        on ? "bg-cyan-500/10 border-cyan-500/30" : "border-transparent hover:bg-slate-700/30"
                      }`}>
                      <span className="w-3 h-3 rounded-sm shrink-0 flex items-center justify-center"
                        style={{ background: on || tutte ? col : "transparent", border: `1.5px solid ${col}` }}>
                        {on && <Check className="w-2.5 h-2.5 text-slate-900" strokeWidth={4} />}
                      </span>
                      <span className="text-[10px] font-semibold text-slate-200 truncate max-w-[70px]">{l.label}</span>
                      <span className="text-[9px] text-slate-500 truncate flex-1">{l.longName ?? ""}</span>
                      <span className={`text-[9px] font-mono shrink-0 ${l.trips === 0 ? "text-red-400" : "text-slate-500"}`}>
                        {l.trips}
                      </span>
                    </button>
                  );
                })}
                {filtered.length === 0 && (
                  <p className="text-[10px] text-slate-500 text-center py-2">Nessuna linea trovata.</p>
                )}
              </div>

              <p className="text-[9px] text-slate-500">
                Il numero è quello delle corse del giorno <span className="text-slate-400">{day}</span>.
                {senzaCorse > 0 && (
                  <span className="text-amber-400/80"> {senzaCorse} {senzaCorse === 1 ? "linea non circola" : "linee non circolano"} in questo giorno.</span>
                )}
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
