/**
 * COPERTURA DELLA DOMANDA — pannello di verdetto sui poli attrattori.
 *
 * Risponde alla domanda del pianificatore: "le linee e le corse che ho
 * costruito servono davvero stazioni, aeroporti, scuole e luoghi di lavoro?".
 * I poli scoperti stanno in cima, perché sono quelli su cui si interviene.
 */
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
  TrainFront, Plane, GraduationCap, Briefcase, Loader2,
  CheckCircle2, AlertTriangle, XCircle, Footprints, Clock, Route as RouteIcon,
  Cross, Wrench, Download, Printer, Table2, Search,
} from "lucide-react";
import { exportCoverageCsv, exportSchedulesCsv, openCoverageReport } from "./intermodal-export";

export type GeneratorKind = "stazione" | "aeroporto" | "scuola" | "lavoro" | "ospedale";
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
  /** Lettura d'insieme della rete */
  rete?: ScheduleShape & {
    oraPiuServita: string | null;
    oreScoperteDiurne: string[];
    camminoMedioMin: number | null;
    poliIrraggiungibili: number;
  };
  /** Che cosa fare, in ordine di gravità */
  criticita?: Array<{
    polo: string; famiglia: GeneratorKind; stato: Status;
    gravita: number; motivo: string; azione: string; lat: number; lng: number;
  }>;
  /** Domanda e offerta sulla stessa linea del tempo (per ora del giorno) */
  timeline?: {
    demandHourly: number[];
    serviceHourly: number[];
    perKind: Record<"scuola" | "lavoro" | "ospedale" | "treni", number[]>;
    oreCritiche: Array<{ hour: number; demand: number; service: number }>;
  };
  note?: string;
}

const KIND_META: Record<GeneratorKind, { label: string; plural: string; Icon: typeof TrainFront; color: string }> = {
  stazione:  { label: "Stazione",  plural: "Stazioni",        Icon: TrainFront,    color: "#06b6d4" },
  aeroporto: { label: "Aeroporto", plural: "Aeroporti",       Icon: Plane,         color: "#a855f7" },
  scuola:    { label: "Scuola",    plural: "Scuole",          Icon: GraduationCap, color: "#f59e0b" },
  lavoro:    { label: "Lavoro",    plural: "Aree di lavoro",  Icon: Briefcase,     color: "#10b981" },
  ospedale:  { label: "Ospedale",  plural: "Sanità",          Icon: Cross,         color: "#ef4444" },
};

const STATUS_META: Record<Status, { label: string; color: string; bg: string; Icon: typeof CheckCircle2 }> = {
  "servito":     { label: "Servito",     color: "#10b981", bg: "bg-emerald-500/10 border-emerald-500/30", Icon: CheckCircle2 },
  "parziale":    { label: "Parziale",    color: "#f59e0b", bg: "bg-amber-500/10 border-amber-500/30",     Icon: AlertTriangle },
  "non-servito": { label: "Non servito", color: "#ef4444", bg: "bg-red-500/10 border-red-500/30",         Icon: XCircle },
};

export default function DemandCoverage({
  data, loading, onFocus, section = "tutto",
}: {
  data: DemandCoverageResult | null;
  loading: boolean;
  onFocus?: (lat: number, lng: number, id: string) => void;
  /** Quale porzione mostrare: nel pannello studio ogni tab prende la sua.
   *  "tutto" mantiene il comportamento storico (tutte le sezioni impilate). */
  section?: "tutto" | "quadro" | "poli" | "linee";
}) {
  const showQuadro = section === "tutto" || section === "quadro";
  const showPoli = section === "tutto" || section === "poli";
  const showLinee = section === "tutto" || section === "linee";
  const [kindFilter, setKindFilter] = useState<GeneratorKind | "tutti">("tutti");
  const [statusFilter, setStatusFilter] = useState<Status | "tutti">("tutti");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [q, setQ] = useState("");

  /* Elenco ordinato per GRAVITÀ (scoperti in cima), filtrato per famiglia,
   * verdetto e ricerca: l'inondazione di poli diventa una tabella. */
  const shown = useMemo(() => {
    if (!data) return [];
    const needle = q.trim().toLowerCase();
    const sev: Record<Status, number> = { "non-servito": 0, "parziale": 1, "servito": 2 };
    return data.generators
      .filter(g =>
        (kindFilter === "tutti" || g.generator.kind === kindFilter) &&
        (statusFilter === "tutti" || g.status === statusFilter) &&
        (!needle || g.generator.name.toLowerCase().includes(needle)))
      .sort((a, b) => sev[a.status] - sev[b.status] || a.generator.name.localeCompare(b.generator.name));
  }, [data, kindFilter, statusFilter, q]);

  /* ── DELTA PRIMA→DOPO: il feedback sulla manovra ─────────────────────
   * A ogni ricalcolo sullo STESSO periodo/ambito si confronta col giro
   * precedente: quanti poli sono passati di stato, quante corse in più o
   * in meno — e SOPRATTUTTO quali poli (attribuzione). È ciò che dice
   * all'operatore se la modifica appena fatta va nella direzione giusta.
   * Cambiare periodo/ambito azzera il confronto (non sarebbe omogeneo). */
  type PrevRun = {
    sig: string; servito: number; parziale: number; nonServito: number;
    trips: number; nonServiti: string[];
  };
  const prevRef = useRef<PrevRun | null>(null);
  const [delta, setDelta] = useState<{
    servito: number; nonServito: number; trips: number;
    coperti: string[]; scoperti: string[];
  } | null>(null);
  useEffect(() => {
    if (!data) return;
    const sig = JSON.stringify({ ...data.scope, linee: data.summary.lineeValutate });
    const nonServiti = data.generators.filter(g => g.status === "non-servito").map(g => g.generator.name);
    const cur: PrevRun = {
      sig, servito: data.summary.servito, parziale: data.summary.parziale,
      nonServito: data.summary.nonServito, trips: data.rete?.trips ?? 0, nonServiti,
    };
    const prev = prevRef.current;
    if (prev && prev.sig === sig) {
      const coperti = prev.nonServiti.filter(n => !nonServiti.includes(n));
      const scoperti = nonServiti.filter(n => !prev.nonServiti.includes(n));
      const d = {
        servito: cur.servito - prev.servito,
        nonServito: cur.nonServito - prev.nonServito,
        trips: cur.trips - prev.trips,
        coperti, scoperti,
      };
      setDelta(d.servito !== 0 || d.nonServito !== 0 || d.trips !== 0 || coperti.length || scoperti.length ? d : null);
    } else {
      setDelta(null);
    }
    prevRef.current = cur;
  }, [data]);

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
      {showQuadro && (<>
      {/* ─── Esportazioni: tabelle per foglio di calcolo + report stampabile ─── */}
      <div className="flex gap-1">
        <button onClick={() => exportCoverageCsv(data)}
          title="Scarica la tabella dei poli (CSV)"
          className="flex-1 flex items-center justify-center gap-1 text-[9px] px-2 py-1.5 rounded border border-slate-700/50 text-slate-300 hover:bg-slate-700/40 transition-colors">
          <Table2 className="w-3 h-3" /> Poli CSV
        </button>
        <button onClick={() => exportSchedulesCsv(data)} disabled={!data.schedules?.length}
          title="Scarica l'orario per linea (CSV)"
          className="flex-1 flex items-center justify-center gap-1 text-[9px] px-2 py-1.5 rounded border border-slate-700/50 text-slate-300 hover:bg-slate-700/40 disabled:opacity-40 transition-colors">
          <Download className="w-3 h-3" /> Orari CSV
        </button>
        <button onClick={() => openCoverageReport(data)}
          title="Apri il report stampabile (PDF)"
          className="flex-1 flex items-center justify-center gap-1 text-[9px] px-2 py-1.5 rounded border border-cyan-500/40 text-cyan-300 hover:bg-cyan-500/15 transition-colors">
          <Printer className="w-3 h-3" /> Report
        </button>
      </div>

      {/* ─── LA MANOVRA APPENA FATTA: prima → dopo ─── */}
      {delta && (
        <div className={`rounded-xl border p-3 space-y-1.5 ${
          delta.scoperti.length > 0 || delta.servito < 0
            ? "border-red-500/40 bg-red-500/10"
            : delta.coperti.length > 0 || delta.servito > 0
              ? "border-emerald-500/40 bg-emerald-500/10"
              : "border-slate-600/40 bg-slate-800/60"}`}>
          <p className="text-[10px] uppercase tracking-wide font-semibold text-slate-300">
            Rispetto all'analisi precedente
          </p>
          <div className="flex flex-wrap gap-1.5 text-[10px] font-mono">
            {delta.servito !== 0 && (
              <span className={`px-1.5 py-0.5 rounded border ${delta.servito > 0 ? "text-emerald-300 border-emerald-500/40 bg-emerald-500/10" : "text-red-300 border-red-500/40 bg-red-500/10"}`}>
                {delta.servito > 0 ? "▲" : "▼"} {Math.abs(delta.servito)} serviti
              </span>
            )}
            {delta.nonServito !== 0 && (
              <span className={`px-1.5 py-0.5 rounded border ${delta.nonServito < 0 ? "text-emerald-300 border-emerald-500/40 bg-emerald-500/10" : "text-red-300 border-red-500/40 bg-red-500/10"}`}>
                {delta.nonServito < 0 ? "▼" : "▲"} {Math.abs(delta.nonServito)} scoperti
              </span>
            )}
            {delta.trips !== 0 && (
              <span className="px-1.5 py-0.5 rounded border text-slate-300 border-slate-600/50 bg-slate-800/60">
                {delta.trips > 0 ? "+" : ""}{delta.trips} corse
              </span>
            )}
          </div>
          {delta.coperti.length > 0 && (
            <p className="text-[10px] text-emerald-200 leading-snug">
              ✓ Ora coperti: <span className="font-semibold">{delta.coperti.slice(0, 4).join(", ")}{delta.coperti.length > 4 ? ` +${delta.coperti.length - 4}` : ""}</span>
            </p>
          )}
          {delta.scoperti.length > 0 && (
            <p className="text-[10px] text-red-200 leading-snug">
              ✗ Rimasti scoperti ora: <span className="font-semibold">{delta.scoperti.slice(0, 4).join(", ")}{delta.scoperti.length > 4 ? ` +${delta.scoperti.length - 4}` : ""}</span>
            </p>
          )}
        </div>
      )}

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

      {/* ─── VERDETTO IN PROSA — la lettura da 5 secondi ─── */}
      {(() => {
        const s = data.summary, r = data.rete;
        if (s.totale === 0) return null;
        const bigGap = (r?.maxGapMin ?? 0) >= 120;
        const level = pct >= 75 && !bigGap ? "adeguata"
          : pct >= 45 ? "da rinforzare" : "insufficiente";
        const lv = level === "adeguata"
          ? { txt: "Rete adeguata", col: "#10b981", bg: "bg-emerald-500/10 border-emerald-500/30" }
          : level === "da rinforzare"
            ? { txt: "Rete da rinforzare", col: "#f59e0b", bg: "bg-amber-500/10 border-amber-500/30" }
            : { txt: "Copertura insufficiente", col: "#ef4444", bg: "bg-red-500/10 border-red-500/30" };
        const worst = (data.criticita ?? []).slice(0, 3).map(c => c.polo);
        return (
          <div className={`rounded-xl border p-3 space-y-1.5 ${lv.bg}`}>
            <p className="text-sm font-bold" style={{ color: lv.col }}>{lv.txt}</p>
            <p className="text-[11px] text-slate-200 leading-relaxed">
              Le linee servono <strong>{s.servito} poli su {s.totale}</strong> ({pct}%)
              {r && r.medianHeadwayMin != null ? <>, un bus ogni ~<strong>{r.medianHeadwayMin}′</strong></> : null}
              {r && bigGap ? <>, con un buco fino a <strong>{Math.round(r.maxGapMin! / 6) / 10} h</strong> dalle {r.maxGapFrom}</> : null}.
            </p>
            {s.nonServito + s.parziale > 0 && (
              <p className="text-[11px] text-slate-300 leading-relaxed">
                <strong>{s.nonServito} scoperti</strong> e {s.parziale} coperti a metà
                {worst.length > 0 ? <>: i più critici sono <span className="text-white">{worst.join(", ")}</span></> : null}.
              </p>
            )}
            <p className="text-[11px] text-slate-300 leading-relaxed">
              {level === "adeguata"
                ? "La domanda è servita in modo diffuso; guarda comunque i poli parziali per rifinire le fasce."
                : level === "da rinforzare"
                  ? "Intervieni sui poli scoperti qui sotto, in ordine: ognuno riporta l'azione consigliata."
                  : "Buona parte della domanda non è raggiunta: parti dai poli senza fermate, poi dalle fasce vuote."}
            </p>
          </div>
        );
      })()}

      {/* ─── La rete nel suo insieme ─── */}
      {data.rete && data.rete.trips > 0 && (
        <div className="rounded-xl border border-slate-700/40 bg-slate-800/40 p-2.5 space-y-1.5">
          <p className="text-[10px] uppercase tracking-wide text-slate-400 font-semibold">La rete nel periodo scelto</p>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[10px]">
            <span className="text-slate-500">Servizio</span>
            <span className="text-slate-200 font-mono text-right">{data.rete.firstTime}–{data.rete.lastTime}</span>
            <span className="text-slate-500">Corse totali</span>
            <span className="text-slate-200 font-mono text-right">{data.rete.trips}</span>
            <span className="text-slate-500">Intervallo tipico</span>
            <span className="text-slate-200 font-mono text-right">{data.rete.medianHeadwayMin != null ? `${data.rete.medianHeadwayMin}′` : "—"}</span>
            <span className="text-slate-500">Buco più lungo</span>
            <span className={`font-mono text-right ${(data.rete.maxGapMin ?? 0) >= 120 ? "text-amber-400" : "text-slate-200"}`}>
              {data.rete.maxGapMin != null ? `${Math.round(data.rete.maxGapMin / 6) / 10} h` : "—"}
              {data.rete.maxGapFrom ? <span className="text-slate-500"> dalle {data.rete.maxGapFrom}</span> : null}
            </span>
            <span className="text-slate-500">Ora di punta</span>
            <span className="text-slate-200 font-mono text-right">{data.rete.oraPiuServita ?? "—"}</span>
            {data.rete.camminoMedioMin != null && (<>
              <span className="text-slate-500">Cammino medio ai poli</span>
              <span className="text-slate-200 font-mono text-right">{data.rete.camminoMedioMin}′</span>
            </>)}
            {data.rete.poliIrraggiungibili > 0 && (<>
              <span className="text-red-400/80">Poli senza fermate</span>
              <span className="text-red-400 font-mono text-right">{data.rete.poliIrraggiungibili}</span>
            </>)}
          </div>
          {data.rete.oreScoperteDiurne.length > 0 && (
            <p className="text-[9px] text-amber-300/90">
              Ore diurne senza corse: {data.rete.oreScoperteDiurne.join(", ")}
            </p>
          )}
        </div>
      )}

      {/* ─── DOMANDA ↔ OFFERTA sulla stessa linea del tempo ───────────
          Ogni dato territoriale tradotto in eventi di domanda per ora
          (finestre scuola/lavoro/ospedale + treni in arrivo/partenza),
          messo accanto alle corse: si vede subito DOVE l'orario manca
          la domanda — è il confronto che guida la manovra. ─── */}
      {data.timeline && data.timeline.demandHourly.some(n => n > 0) && (() => {
        const tl = data.timeline!;
        const maxD = Math.max(...tl.demandHourly, 1);
        const maxS = Math.max(...tl.serviceHourly, 1);
        const KIND_COLORS: Record<string, string> = {
          scuola: "#f59e0b", lavoro: "#10b981", ospedale: "#ef4444", treni: "#06b6d4",
        };
        return (
          <div className="rounded-xl border border-slate-700/40 bg-slate-800/40 p-2.5 space-y-1.5">
            <p className="text-[10px] uppercase tracking-wide text-slate-400 font-semibold">
              Domanda ↔ offerta per ora
            </p>
            {/* Domanda (impilata per famiglia), sopra */}
            <div className="flex items-end gap-[1px] h-12">
              {tl.demandHourly.map((n, h) => {
                const critical = tl.oreCritiche.some(c => c.hour === h);
                const parts = (["treni", "scuola", "ospedale", "lavoro"] as const)
                  .map(k => ({ k, v: tl.perKind[k]?.[h] ?? 0 })).filter(p => p.v > 0);
                return (
                  /* h-full è essenziale: senza, la colonna ha altezza auto e
                   * le percentuali dei segmenti si risolvono a 0 — il grafico
                   * mostrava le corse ma NESSUNA domanda. */
                  <div key={h} className="flex-1 h-full flex flex-col justify-end relative"
                    title={`${String(h).padStart(2, "0")}:00 — domanda ${n} (${parts.map(p => `${p.k} ${p.v}`).join(", ") || "—"}), corse ${tl.serviceHourly[h] ?? 0}${critical ? " ⚠ SCOPERTA" : ""}`}>
                    {critical && <div className="absolute inset-0 rounded-sm bg-red-500/15 border border-red-500/40" />}
                    {parts.map(p => (
                      <div key={p.k} style={{
                        height: `${(p.v / maxD) * 100}%`,
                        minHeight: 2, // un segmento piccolo resta visibile anche accanto a un massimo alto
                        background: KIND_COLORS[p.k], opacity: 0.85,
                      }} />
                    ))}
                  </div>
                );
              })}
            </div>
            {/* Offerta (corse per ora), sotto, specchiata */}
            <div className="flex items-start gap-[1px] h-8">
              {tl.serviceHourly.map((n, h) => (
                <div key={h} className="flex-1"
                  title={`${String(h).padStart(2, "0")}:00 — ${n} ${n === 1 ? "corsa" : "corse"}`}
                  style={{
                    height: `${Math.max(n > 0 ? 12 : 2, (n / maxS) * 100)}%`,
                    background: n === 0 ? "rgba(100,116,139,0.25)" : "rgba(148,163,184,0.8)",
                    borderRadius: "0 0 2px 2px",
                  }} />
              ))}
            </div>
            <div className="flex justify-between text-[8px] text-slate-600 font-mono">
              <span>0</span><span>6</span><span>12</span><span>18</span><span>23</span>
            </div>
            <div className="flex flex-wrap gap-x-2 gap-y-0.5 text-[8px] text-slate-500">
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm" style={{ background: "#06b6d4" }} />treni</span>
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm" style={{ background: "#f59e0b" }} />scuole</span>
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm" style={{ background: "#ef4444" }} />sanità</span>
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm" style={{ background: "#10b981" }} />lavoro</span>
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm" style={{ background: "rgba(148,163,184,0.8)" }} />le tue corse</span>
            </div>
            {tl.oreCritiche.length > 0 ? (
              <p className="text-[9px] text-red-300/90 leading-snug">
                ⚠ Domanda senza corse alle {tl.oreCritiche.map(c => `${String(c.hour).padStart(2, "0")}:00`).join(", ")} — è lì che una corsa in più rende di più.
              </p>
            ) : (
              <p className="text-[9px] text-emerald-400/80">Ogni fascia con domanda ha almeno una corsa.</p>
            )}
          </div>
        );
      })()}

      {/* ─── Che cosa fare, in ordine — ogni voce clicca sulla mappa ─── */}
      {data.criticita && data.criticita.length > 0 && (
        <div className="rounded-xl border border-amber-500/25 bg-amber-500/5 p-2.5 space-y-1">
          <p className="text-[10px] uppercase tracking-wide text-amber-300/90 font-semibold flex items-center gap-1">
            <Wrench className="w-3 h-3" /> Dove intervenire ({data.criticita.length})
          </p>
          <div className="max-h-52 overflow-y-auto space-y-1 pr-0.5">
            {data.criticita.map((c, i) => {
              const cm = KIND_META[c.famiglia];
              return (
                <button key={i}
                  onClick={() => onFocus?.(c.lat, c.lng, `crit-${i}`)}
                  className="w-full text-left text-[10px] space-y-0.5 rounded px-1.5 py-1 hover:bg-amber-500/10 transition-colors">
                  <p className="font-semibold text-slate-200 truncate flex items-center gap-1">
                    {cm && <cm.Icon className="w-3 h-3 shrink-0" style={{ color: cm.color }} />}
                    {c.polo}
                    <span className="ml-auto text-[8px] font-normal shrink-0" style={{ color: STATUS_META[c.stato].color }}>
                      {STATUS_META[c.stato].label}
                    </span>
                  </p>
                  <p className="text-slate-400 leading-snug">{c.azione}</p>
                </button>
              );
            })}
          </div>
        </div>
      )}
      </>)}

      {showPoli && (<>
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

      {/* ─── Elenco poli: DATA-TABLE — ricerca, scoperti in cima, dettaglio
           su selezione. Fine dell'elenco che inonda: righe compatte. ─── */}
      <div className="flex items-center gap-1.5">
        <div className="relative flex-1">
          <Search className="w-3 h-3 text-slate-500 absolute left-2 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Cerca un polo… (es. liceo)"
            className="w-full text-[10px] bg-slate-900/60 text-slate-200 border border-slate-700/50 rounded-md pl-6 pr-2 py-1.5 focus:outline-none focus:border-cyan-500/50 placeholder:text-slate-600" />
        </div>
        <span className="text-[9px] text-slate-500 shrink-0 font-mono">{shown.length}/{data.generators.length}</span>
      </div>
      <div className="rounded-lg border border-slate-700/40 overflow-hidden">
        <table className="w-full text-[10px]" style={{ fontVariantNumeric: "tabular-nums" }}>
          <thead>
            <tr className="text-[8px] uppercase tracking-wide text-slate-500 bg-slate-900/60 border-b border-slate-700/30">
              <th className="text-left font-semibold px-2 py-1.5">Polo</th>
              <th className="text-right font-semibold px-1 py-1.5" title="Cammino alla fermata più vicina">A piedi</th>
              <th className="text-right font-semibold px-1 py-1.5">Corse</th>
              <th className="text-right font-semibold px-2 py-1.5">Esito</th>
            </tr>
          </thead>
          <tbody>
        {shown.length === 0 && (
          <tr><td colSpan={4} className="text-[10px] text-slate-500 text-center py-4">Nessun polo con questi filtri.</td></tr>
        )}
        {shown.map(g => {
          const m = KIND_META[g.generator.kind];
          const st = STATUS_META[g.status];
          const isOpen = expanded === g.generator.id;
          const corse = g.schedule?.trips ?? g.span?.trips ?? g.windows.reduce((s, w) => s + w.trips, 0);
          return (
            <Fragment key={g.generator.id}>
              <tr
                onClick={() => {
                  setExpanded(isOpen ? null : g.generator.id);
                  onFocus?.(g.generator.lat, g.generator.lng, g.generator.id);
                }}
                title={`${m.label}${g.generator.detail && g.generator.detail !== g.generator.kind ? ` · ${g.generator.detail}` : ""}`}
                className={`cursor-pointer border-b border-slate-700/15 transition-colors ${
                  isOpen ? "bg-slate-700/25" : g.status === "non-servito" ? "bg-red-500/5 hover:bg-red-500/10" : "hover:bg-slate-700/20"
                }`}>
                <td className="px-2 py-1.5">
                  <div className="flex items-center gap-1.5 min-w-0 max-w-[210px]">
                    <m.Icon className="w-3.5 h-3.5 shrink-0" style={{ color: m.color }} />
                    <span className="font-semibold text-white truncate">{g.generator.name}</span>
                  </div>
                </td>
                <td className="px-1 py-1.5 text-right font-mono whitespace-nowrap">
                  {g.nearStops.length > 0
                    ? <span className="text-slate-300">{g.nearStops[0].walkMin}′</span>
                    : <span className="text-red-400" title="Nessuna fermata raggiungibile a piedi">—</span>}
                </td>
                <td className="px-1 py-1.5 text-right font-mono text-slate-300">{corse}</td>
                <td className="px-2 py-1.5 text-right whitespace-nowrap">
                  <span className="inline-flex items-center gap-1 text-[8px] font-bold px-1.5 py-0.5 rounded border"
                    style={{ color: st.color, borderColor: `${st.color}55`, background: `${st.color}14` }}>
                    <st.Icon className="w-2.5 h-2.5" /> {st.label}
                  </span>
                </td>
              </tr>

              {isOpen && (
                <tr className="border-b border-slate-700/20 bg-slate-900/40">
                  <td colSpan={4}>
                <div className="px-2 pb-2 space-y-2 pt-2">
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
                  </td>
                </tr>
              )}
            </Fragment>
          );
        })}
          </tbody>
        </table>
      </div>

      </>)}

      {showLinee && (<>
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
      </>)}
    </div>
  );
}
