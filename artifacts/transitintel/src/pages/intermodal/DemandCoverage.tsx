/**
 * COPERTURA DELLA DOMANDA — pannello di verdetto sui poli attrattori.
 *
 * Risponde alla domanda del pianificatore: "le linee e le corse che ho
 * costruito servono davvero stazioni, aeroporti, scuole e luoghi di lavoro?".
 * I poli scoperti stanno in cima, perché sono quelli su cui si interviene.
 */
import { useMemo, useState } from "react";
import {
  TrainFront, Plane, GraduationCap, Briefcase, Loader2, ChevronDown, ChevronUp,
  CheckCircle2, AlertTriangle, XCircle, Footprints, Clock, Route as RouteIcon,
} from "lucide-react";

export type GeneratorKind = "stazione" | "aeroporto" | "scuola" | "lavoro";
type Status = "servito" | "parziale" | "non-servito";

export interface WindowVerdict {
  label: string; from: string; to: string;
  trips: number; firstTime: string | null; lastTime: string | null;
  routes: string[]; ok: boolean;
}
/** Come è distribuito l'orario: il "quante corse" da solo non basta. */
export interface ScheduleShape {
  trips: number; firstTime: string | null; lastTime: string | null;
  hourly: number[]; hoursCovered: number;
  medianHeadwayMin: number | null;
  maxGapMin: number | null; maxGapFrom: string | null;
  emptyHoursInSpan: number;
}

export interface GeneratorCoverage {
  generator: { id: string; kind: GeneratorKind; name: string; lat: number; lng: number; detail?: string };
  nearStops: { stopId: string; stopName: string; distKm: number; walkMin: number }[];
  status: Status;
  reason: string;
  windows: WindowVerdict[];
  span: { trips: number; firstTime: string | null; lastTime: string | null; hoursCovered: number } | null;
  schedule?: ScheduleShape;
  routes: string[];
}
export interface DemandCoverageResult {
  scope: {
    psProjectId: string | null; feedId: string | null; day: string; maxWalkKm: number;
    calendarApplied?: boolean;
    /** "ps" = dati vivi del progetto, "gtfs" = feed (fuori da un progetto) */
    source?: "ps" | "gtfs";
  };
  windows?: Record<string, { label: string; from: string; to: string }>;
  generators: GeneratorCoverage[];
  byKind: Record<string, { totale: number; servito: number; parziale: number; nonServito: number }>;
  byRoute: { route: string; poli: number; perKind: Record<string, number> }[];
  summary: { totale: number; servito: number; parziale: number; nonServito: number; lineeValutate: number };
  /** Analisi dell'orario per linea */
  schedules?: Array<{ routeId: string; route: string } & ScheduleShape>;
  note?: string;
}

const KIND_META: Record<GeneratorKind, { label: string; plural: string; Icon: typeof TrainFront; color: string }> = {
  stazione:  { label: "Stazione",  plural: "Stazioni",        Icon: TrainFront,    color: "#06b6d4" },
  aeroporto: { label: "Aeroporto", plural: "Aeroporti",       Icon: Plane,         color: "#a855f7" },
  scuola:    { label: "Scuola",    plural: "Scuole",          Icon: GraduationCap, color: "#f59e0b" },
  lavoro:    { label: "Lavoro",    plural: "Aree di lavoro",  Icon: Briefcase,     color: "#10b981" },
};

const STATUS_META: Record<Status, { label: string; color: string; bg: string; Icon: typeof CheckCircle2 }> = {
  "servito":     { label: "Servito",     color: "#10b981", bg: "bg-emerald-500/10 border-emerald-500/30", Icon: CheckCircle2 },
  "parziale":    { label: "Parziale",    color: "#f59e0b", bg: "bg-amber-500/10 border-amber-500/30",     Icon: AlertTriangle },
  "non-servito": { label: "Non servito", color: "#ef4444", bg: "bg-red-500/10 border-red-500/30",         Icon: XCircle },
};

export default function DemandCoverage({
  data, loading, onFocus,
}: {
  data: DemandCoverageResult | null;
  loading: boolean;
  onFocus?: (lat: number, lng: number, id: string) => void;
}) {
  const [kindFilter, setKindFilter] = useState<GeneratorKind | "tutti">("tutti");
  const [statusFilter, setStatusFilter] = useState<Status | "tutti">("tutti");
  const [expanded, setExpanded] = useState<string | null>(null);

  const shown = useMemo(() => {
    if (!data) return [];
    return data.generators.filter(g =>
      (kindFilter === "tutti" || g.generator.kind === kindFilter) &&
      (statusFilter === "tutti" || g.status === statusFilter));
  }, [data, kindFilter, statusFilter]);

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-12 text-slate-400">
        <Loader2 className="w-4 h-4 animate-spin text-cyan-400" />
        <span className="text-xs">Valuto la copertura dei poli…</span>
      </div>
    );
  }
  if (!data) return null;

  if (data.generators.length === 0) {
    return (
      <div className="rounded-xl border border-slate-700/40 bg-slate-800/40 p-4 text-center space-y-1">
        <p className="text-xs text-slate-300 font-medium">Nessun polo attrattore nell'area</p>
        <p className="text-[10px] text-slate-500">{data.note ?? "Importa i POI (scuole, uffici, industrie) o allarga l'ambito."}</p>
      </div>
    );
  }

  const pct = data.summary.totale > 0
    ? Math.round((data.summary.servito / data.summary.totale) * 100) : 0;

  return (
    <div className="space-y-3">
      {/* ─── Verdetto complessivo ─── */}
      <div className="rounded-xl border border-slate-700/40 bg-slate-800/40 p-3 space-y-2">
        <div className="flex items-baseline justify-between">
          <span className="text-[10px] uppercase tracking-wide text-slate-400 font-semibold">Poli serviti</span>
          <span className="text-lg font-bold text-white">{pct}%</span>
        </div>
        <div className="h-2 rounded-full bg-slate-900/70 overflow-hidden flex">
          <div className="h-full bg-emerald-500" style={{ width: `${(data.summary.servito / data.summary.totale) * 100}%` }} />
          <div className="h-full bg-amber-500" style={{ width: `${(data.summary.parziale / data.summary.totale) * 100}%` }} />
          <div className="h-full bg-red-500" style={{ width: `${(data.summary.nonServito / data.summary.totale) * 100}%` }} />
        </div>
        <div className="flex gap-3 text-[10px]">
          <span className="text-emerald-400">{data.summary.servito} serviti</span>
          <span className="text-amber-400">{data.summary.parziale} parziali</span>
          <span className="text-red-400">{data.summary.nonServito} scoperti</span>
          <span className="text-slate-500 ml-auto">{data.summary.lineeValutate} linee · {data.scope.day}</span>
        </div>
        {/* Da dove vengono i dati: dentro un progetto devono essere i suoi,
            vivi. Se si sta guardando un feed, va detto. */}
        <div className="flex items-center gap-1.5">
          {data.scope.source === "gtfs" ? (
            <>
              <AlertTriangle className="w-3 h-3 text-amber-400 shrink-0" />
              <span className="text-[9px] text-amber-300/90">Dati da feed GTFS, non da un progetto</span>
            </>
          ) : (
            <>
              <CheckCircle2 className="w-3 h-3 text-emerald-400/70 shrink-0" />
              <span className="text-[9px] text-slate-500">Rete del progetto, aggiornata in tempo reale</span>
            </>
          )}
        </div>
      </div>

      {/* ─── Per famiglia di polo ─── */}
      <div className="grid grid-cols-2 gap-1.5">
        {(Object.keys(KIND_META) as GeneratorKind[]).map(k => {
          const m = KIND_META[k], agg = data.byKind[k];
          const active = kindFilter === k;
          return (
            <button key={k} onClick={() => setKindFilter(active ? "tutti" : k)} disabled={!agg}
              className={`rounded-lg border p-2 text-left transition-all disabled:opacity-40 ${
                active ? "border-cyan-500/50 bg-cyan-500/10" : "border-slate-700/40 bg-slate-800/40 hover:border-slate-600"
              }`}>
              <div className="flex items-center gap-1.5 mb-1">
                <m.Icon className="w-3.5 h-3.5 shrink-0" style={{ color: m.color }} />
                <span className="text-[10px] font-semibold text-slate-200 truncate">{m.plural}</span>
              </div>
              {agg ? (
                <div className="flex items-center gap-1.5 text-[10px] font-mono">
                  <span className="text-emerald-400">{agg.servito}</span>
                  <span className="text-amber-400">{agg.parziale}</span>
                  <span className="text-red-400">{agg.nonServito}</span>
                  <span className="text-slate-500 ml-auto">/{agg.totale}</span>
                </div>
              ) : <span className="text-[10px] text-slate-600">nessuno</span>}
            </button>
          );
        })}
      </div>

      {/* ─── Filtro per verdetto ─── */}
      <div className="flex gap-1">
        {(["tutti", "non-servito", "parziale", "servito"] as const).map(s => (
          <button key={s} onClick={() => setStatusFilter(s as any)}
            className={`flex-1 text-[9px] px-2 py-1 rounded border transition-all ${
              statusFilter === s
                ? "bg-slate-700/70 text-white border-slate-600 font-semibold"
                : "bg-slate-900/40 text-slate-400 border-slate-700/40 hover:text-slate-200"
            }`}>
            {s === "tutti" ? "Tutti" : STATUS_META[s as Status].label}
          </button>
        ))}
      </div>

      {/* ─── Elenco poli (scoperti in cima) ─── */}
      <div className="space-y-1.5">
        {shown.length === 0 && (
          <p className="text-[10px] text-slate-500 text-center py-4">Nessun polo con questi filtri.</p>
        )}
        {shown.map(g => {
          const m = KIND_META[g.generator.kind];
          const st = STATUS_META[g.status];
          const isOpen = expanded === g.generator.id;
          return (
            <div key={g.generator.id} className={`rounded-lg border ${st.bg}`}>
              <button
                onClick={() => {
                  setExpanded(isOpen ? null : g.generator.id);
                  onFocus?.(g.generator.lat, g.generator.lng, g.generator.id);
                }}
                className="w-full p-2 flex items-start gap-2 text-left">
                <m.Icon className="w-3.5 h-3.5 shrink-0 mt-0.5" style={{ color: m.color }} />
                <div className="flex-1 min-w-0">
                  <p className="text-[11px] font-semibold text-white truncate">{g.generator.name}</p>
                  <p className="text-[9px] text-slate-400">
                    {m.label}{g.generator.detail && g.generator.detail !== g.generator.kind ? ` · ${g.generator.detail}` : ""}
                    {g.nearStops.length > 0 && ` · ${g.nearStops.length} fermate a ≤${g.nearStops[g.nearStops.length - 1].walkMin}′`}
                  </p>
                </div>
                <st.Icon className="w-3.5 h-3.5 shrink-0" style={{ color: st.color }} />
                {isOpen ? <ChevronUp className="w-3 h-3 text-slate-500 shrink-0 mt-0.5" />
                        : <ChevronDown className="w-3 h-3 text-slate-500 shrink-0 mt-0.5" />}
              </button>

              {isOpen && (
                <div className="px-2 pb-2 space-y-2 border-t border-slate-700/30 pt-2">
                  <p className="text-[10px] text-slate-300 leading-relaxed">{g.reason}</p>

                  {/* Finestre (scuole e lavoro) */}
                  {g.windows.length > 0 && (
                    <div className="space-y-1">
                      {g.windows.map((w, i) => (
                        <div key={i} className={`rounded px-2 py-1.5 border ${
                          w.ok ? "bg-emerald-500/5 border-emerald-500/25" : "bg-red-500/5 border-red-500/25"}`}>
                          <div className="flex items-center gap-1.5">
                            <Clock className="w-3 h-3 shrink-0" style={{ color: w.ok ? "#10b981" : "#ef4444" }} />
                            <span className="text-[10px] font-semibold text-slate-200 capitalize">{w.label}</span>
                            <span className="text-[9px] text-slate-500 font-mono">{w.from}–{w.to}</span>
                            <span className={`text-[10px] font-bold ml-auto ${w.ok ? "text-emerald-400" : "text-red-400"}`}>
                              {w.trips} {w.trips === 1 ? "corsa" : "corse"}
                            </span>
                          </div>
                          {w.ok && w.firstTime && (
                            <p className="text-[9px] text-slate-500 mt-0.5 pl-4.5">
                              dalle {w.firstTime} alle {w.lastTime} · {w.routes.join(", ")}
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Ampiezza (stazioni e aeroporti) */}
                  {g.span && (
                    <div className="rounded px-2 py-1.5 border bg-slate-900/40 border-slate-700/40">
                      <div className="flex items-center gap-1.5 text-[10px] text-slate-300">
                        <Clock className="w-3 h-3 text-cyan-400" />
                        <span>{g.span.trips} passaggi · {g.span.hoursCovered} ore coperte</span>
                        <span className="font-mono text-slate-500 ml-auto">{g.span.firstTime}–{g.span.lastTime}</span>
                      </div>
                    </div>
                  )}

                  {/* Come è distribuito l'orario: dieci corse concentrate in
                      due ore e dieci ben spalmate danno lo stesso numero. */}
                  {g.schedule && g.schedule.trips > 0 && (
                    <div className="rounded px-2 py-1.5 border bg-slate-900/40 border-slate-700/40 space-y-1">
                      <div className="flex items-center gap-1.5 text-[9px] text-slate-400">
                        <Clock className="w-3 h-3 text-cyan-400" />
                        <span>{g.schedule.firstTime}–{g.schedule.lastTime}</span>
                        {g.schedule.medianHeadwayMin != null && (
                          <span>· ogni ~{g.schedule.medianHeadwayMin}′</span>
                        )}
                        {g.schedule.maxGapMin != null && g.schedule.maxGapMin >= 60 && (
                          <span className="text-amber-400 ml-auto">
                            buco {Math.round(g.schedule.maxGapMin / 6) / 10}h dalle {g.schedule.maxGapFrom}
                          </span>
                        )}
                      </div>
                      <div className="flex items-end gap-[1px] h-6">
                        {g.schedule.hourly.map((n, h) => {
                          const max = Math.max(...g.schedule!.hourly, 1);
                          return (
                            <div key={h} title={`${String(h).padStart(2, "0")}:00 — ${n} ${n === 1 ? "corsa" : "corse"}`}
                              className="flex-1 rounded-t"
                              style={{
                                height: `${Math.max(n > 0 ? 12 : 2, (n / max) * 100)}%`,
                                background: n === 0 ? "rgba(100,116,139,0.25)" : "rgba(6,182,212,0.75)",
                              }} />
                          );
                        })}
                      </div>
                      <div className="flex justify-between text-[8px] text-slate-600 font-mono">
                        <span>0</span><span>6</span><span>12</span><span>18</span><span>23</span>
                      </div>
                    </div>
                  )}

                  {g.routes.length > 0 && (
                    <p className="text-[9px] text-slate-400 flex items-start gap-1">
                      <RouteIcon className="w-3 h-3 shrink-0 mt-0.5 text-cyan-400" />
                      <span>Linee: <span className="text-slate-300">{g.routes.join(", ")}</span></span>
                    </p>
                  )}
                  {g.nearStops.length > 0 && (
                    <p className="text-[9px] text-slate-500 flex items-start gap-1">
                      <Footprints className="w-3 h-3 shrink-0 mt-0.5 text-amber-400" />
                      <span>{g.nearStops.slice(0, 3).map(s => `${s.stopName} (${s.walkMin}′)`).join(" · ")}</span>
                    </p>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* ─── Orario per linea ─── */}
      {data.schedules && data.schedules.length > 0 && (
        <div className="rounded-xl border border-slate-700/40 bg-slate-800/40 p-2.5 space-y-1.5">
          <p className="text-[10px] uppercase tracking-wide text-slate-400 font-semibold">Orario per linea</p>
          <div className="grid grid-cols-[42px_1fr_46px_52px] gap-1 text-[8px] text-slate-500 font-semibold pb-0.5 border-b border-slate-700/30">
            <span>Linea</span><span>Arco</span><span>Corse</span><span>Ogni</span>
          </div>
          {data.schedules.slice(0, 14).map(sc => (
            <div key={sc.routeId} className="grid grid-cols-[42px_1fr_46px_52px] gap-1 items-center text-[10px]">
              <span className="font-mono font-bold text-cyan-300 truncate">{sc.route}</span>
              <span className="text-slate-400 font-mono text-[9px]">
                {sc.firstTime}–{sc.lastTime}
                {sc.maxGapMin != null && sc.maxGapMin >= 120 && (
                  <span className="text-amber-400" title={`Buco di ${Math.round(sc.maxGapMin / 6) / 10} h dalle ${sc.maxGapFrom}`}> ⚠</span>
                )}
              </span>
              <span className="text-slate-300 font-mono">{sc.trips}</span>
              <span className="text-slate-400 font-mono">
                {sc.medianHeadwayMin != null ? `${sc.medianHeadwayMin}′` : "—"}
              </span>
            </div>
          ))}
          {data.schedules.length > 14 && (
            <p className="text-[9px] text-slate-500">+{data.schedules.length - 14} altre linee</p>
          )}
          <p className="text-[9px] text-slate-500 pt-1 border-t border-slate-700/30">
            ⚠ = buco di almeno 2 ore nell'arco di servizio.
          </p>
        </div>
      )}

      {/* ─── Contributo per linea ─── */}
      {data.byRoute.length > 0 && (
        <div className="rounded-xl border border-slate-700/40 bg-slate-800/40 p-2.5 space-y-1.5">
          <p className="text-[10px] uppercase tracking-wide text-slate-400 font-semibold">Poli serviti per linea</p>
          {data.byRoute.slice(0, 12).map(r => (
            <div key={r.route} className="flex items-center gap-2">
              <span className="text-[10px] font-mono font-bold text-cyan-300 w-12 shrink-0 truncate">{r.route}</span>
              <div className="flex-1 h-1.5 rounded-full bg-slate-900/70 overflow-hidden">
                <div className="h-full bg-cyan-500/70 rounded-full"
                  style={{ width: `${(r.poli / data.byRoute[0].poli) * 100}%` }} />
              </div>
              <span className="text-[10px] font-mono text-slate-400 w-6 text-right shrink-0">{r.poli}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
