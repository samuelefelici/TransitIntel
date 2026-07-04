/**
 * Planner Legacy — CONFRONTO tra due progetti Planning Studio.
 *
 * Aiuta i capi a capire quale scenario di servizio è migliore, confrontando
 * ogni aspetto (project-aware, sul feed materializzato di ciascun progetto):
 *   • Pianificazione: rete/km, copertura popolazione, traffico, intermodale
 *   • Scheduling: turni macchina e turni guida (non solo costi)
 *
 * Dati da GET /api/planning/compare?a=&b=.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  GitCompareArrows, Loader2, AlertTriangle, ArrowRight, Trophy, Minus,
  Bus, Users, Map as MapIcon, Activity, ArrowRightLeft, Route, Gauge, Clock, Wallet,
} from "lucide-react";
import { apiFetch } from "@/lib/api";

/* ─── Tipi ─── */
interface PsProjectLite {
  id: string; name: string;
  materializedFeedId?: string | null;
  materializedAt?: string | null;
  counts?: { routes?: number; trips?: number };
}
interface PlanningMetrics {
  routes: number; trips: number; stops: number; networkKm: number;
  population: number; coveredPopulation: number; coveragePct: number; comuniServed: number;
  trafficStopsMeasured: number; avgCongestion: number; stopsInCongestionPct: number;
  intermodalHubsServed: number; intermodalHubsTotal: number;
  populationIntermodalAccess: number; interchangeStops: number;
}
interface SchedulingMetrics {
  hasOperational: boolean;
  vehicles: number; serviceHours: number; deadheadKm: number; deadheadRatioPct: number; dailyCost: number;
  driverDuties: number; workHours: number; nastroHours: number; cambi: number; spezzatoPct: number;
  udpTotal: number; udpComplete: number; udpWithIssues: number; uncoveredTrips: number;
}
interface ProjectMetrics {
  id: string; name: string; materialized: boolean; materializedAt: string | null;
  planning: PlanningMetrics; scheduling: SchedulingMetrics;
}
interface CompareResult { a: ProjectMetrics; b: ProjectMetrics }

/* ─── Formattazione ─── */
const nf = (v: number) => (isFinite(v) ? Math.round(v) : 0).toLocaleString("it-IT");
const nf1 = (v: number) => (isFinite(v) ? v : 0).toLocaleString("it-IT", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const pct = (v: number) => nf1(v) + "%";

type Dir = "up" | "down" | "neutral";
interface Row {
  label: string;
  a: number; b: number;
  fmt: (v: number) => string;
  /** direzione del "meglio": up = più alto meglio, down = più basso meglio, neutral = informativo */
  dir: Dir;
  hint?: string;
}

/* ─── Riga di confronto ─── */
function CompareRow({ r }: { r: Row }) {
  const better: "a" | "b" | null =
    r.dir === "neutral" || r.a === r.b ? null
      : r.dir === "up" ? (r.a > r.b ? "a" : "b")
        : (r.a < r.b ? "a" : "b");
  const delta = r.a - r.b;
  const cell = (side: "a" | "b", val: number) => (
    <td className={`px-3 py-2 text-right font-mono tabular-nums ${better === side ? "font-bold text-emerald-600 dark:text-emerald-400" : "text-foreground"}`}>
      <span className="inline-flex items-center gap-1.5 justify-end">
        {better === side && <Trophy className="w-3.5 h-3.5 text-emerald-500" />}
        {r.fmt(val)}
      </span>
    </td>
  );
  return (
    <tr className="border-t border-border/50 hover:bg-muted/30">
      <td className="px-3 py-2 text-sm">
        {r.label}
        {r.hint && <span className="block text-[10px] text-muted-foreground">{r.hint}</span>}
      </td>
      {cell("a", r.a)}
      {cell("b", r.b)}
      <td className="px-3 py-2 text-right text-xs text-muted-foreground font-mono">
        {delta === 0 ? <Minus className="w-3 h-3 inline" /> : (delta > 0 ? "+" : "") + r.fmt(delta)}
      </td>
    </tr>
  );
}

function Section({ icon, title, rows }: { icon: React.ReactNode; title: string; rows: Row[] }) {
  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-2.5 bg-muted/40 border-b border-border">
        <span className="text-primary">{icon}</span>
        <h3 className="text-sm font-semibold">{title}</h3>
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-[11px] uppercase tracking-wide text-muted-foreground">
            <th className="px-3 py-1.5 text-left font-medium">Indicatore</th>
            <th className="px-3 py-1.5 text-right font-medium">A</th>
            <th className="px-3 py-1.5 text-right font-medium">B</th>
            <th className="px-3 py-1.5 text-right font-medium">Δ (A−B)</th>
          </tr>
        </thead>
        <tbody>{rows.map((r, i) => <CompareRow key={i} r={r} />)}</tbody>
      </table>
    </div>
  );
}

/* ─── Costruzione righe ─── */
function planningRows(a: PlanningMetrics, b: PlanningMetrics): Row[] {
  return [
    { label: "Linee", a: a.routes, b: b.routes, fmt: nf, dir: "neutral" },
    { label: "Corse", a: a.trips, b: b.trips, fmt: nf, dir: "neutral" },
    { label: "Fermate", a: a.stops, b: b.stops, fmt: nf, dir: "neutral" },
    { label: "Km di rete sviluppati", a: a.networkKm, b: b.networkKm, fmt: nf1, dir: "neutral", hint: "offerta di servizio" },
    { label: "Popolazione coperta", a: a.coveredPopulation, b: b.coveredPopulation, fmt: nf, dir: "up", hint: "≤ 400 m da una fermata" },
    { label: "Copertura popolazione", a: a.coveragePct, b: b.coveragePct, fmt: pct, dir: "up" },
    { label: "Comuni serviti", a: a.comuniServed, b: b.comuniServed, fmt: nf, dir: "up" },
    { label: "Nodi intermodali serviti", a: a.intermodalHubsServed, b: b.intermodalHubsServed, fmt: nf, dir: "up", hint: `su ${a.intermodalHubsTotal} nodi` },
    { label: "Popolazione con accesso intermodale", a: a.populationIntermodalAccess, b: b.populationIntermodalAccess, fmt: nf, dir: "up" },
    { label: "Fermate di interscambio", a: a.interchangeStops, b: b.interchangeStops, fmt: nf, dir: "up", hint: "servite da ≥ 2 linee" },
    { label: "Esposizione media al traffico", a: a.avgCongestion, b: b.avgCongestion, fmt: (v) => nf1(v * 100) + "%", dir: "down", hint: "congestione media alle fermate" },
    { label: "Fermate in area trafficata", a: a.stopsInCongestionPct, b: b.stopsInCongestionPct, fmt: pct, dir: "down" },
  ];
}
function schedulingRows(a: SchedulingMetrics, b: SchedulingMetrics): Row[] {
  return [
    { label: "Veicoli (turni macchina)", a: a.vehicles, b: b.vehicles, fmt: nf, dir: "down", hint: "meno mezzi = più efficiente" },
    { label: "Ore di servizio", a: a.serviceHours, b: b.serviceHours, fmt: nf1, dir: "neutral" },
    { label: "Km a vuoto (deadhead)", a: a.deadheadKm, b: b.deadheadKm, fmt: nf1, dir: "down" },
    { label: "Incidenza deadhead", a: a.deadheadRatioPct, b: b.deadheadRatioPct, fmt: pct, dir: "down", hint: "km a vuoto / km totali" },
    { label: "Costo giornaliero", a: a.dailyCost, b: b.dailyCost, fmt: (v) => "€ " + nf(v), dir: "down" },
    { label: "Turni guida", a: a.driverDuties, b: b.driverDuties, fmt: nf, dir: "down" },
    { label: "Ore di lavoro guida", a: a.workHours, b: b.workHours, fmt: nf1, dir: "neutral" },
    { label: "Ore di nastro", a: a.nastroHours, b: b.nastroHours, fmt: nf1, dir: "neutral" },
    { label: "Cambi vettura", a: a.cambi, b: b.cambi, fmt: nf, dir: "down", hint: "meno cambi = turni più stabili" },
    { label: "Turni spezzati", a: a.spezzatoPct, b: b.spezzatoPct, fmt: pct, dir: "down" },
    { label: "UDP complete", a: a.udpComplete, b: b.udpComplete, fmt: nf, dir: "up", hint: "veicoli + guida in esercizio" },
    { label: "Corse scoperte", a: a.uncoveredTrips, b: b.uncoveredTrips, fmt: nf, dir: "down" },
  ];
}

/* ─── Verdetto ─── */
function tally(rows: Row[]): { a: number; b: number } {
  let av = 0, bv = 0;
  for (const r of rows) {
    if (r.dir === "neutral" || r.a === r.b) continue;
    const aWins = r.dir === "up" ? r.a > r.b : r.a < r.b;
    if (aWins) av++; else bv++;
  }
  return { a: av, b: bv };
}

export default function PlannerLegacyComparePage() {
  const [aId, setAId] = useState("");
  const [bId, setBId] = useState("");

  const projectsQ = useQuery({
    queryKey: ["ps", "projects", "list"],
    queryFn: () => apiFetch<{ projects: PsProjectLite[] }>("/api/planning-studio/projects").then((r) => r.projects ?? []),
  });
  const projects = projectsQ.data ?? [];

  const compareQ = useQuery({
    queryKey: ["planning", "compare", aId, bId],
    queryFn: () => apiFetch<CompareResult>(`/api/planning/compare?a=${aId}&b=${bId}`),
    enabled: !!aId && !!bId && aId !== bId,
  });

  const cmp = compareQ.data;
  const planRows = useMemo(() => cmp ? planningRows(cmp.a.planning, cmp.b.planning) : [], [cmp]);
  const schedRows = useMemo(() => cmp ? schedulingRows(cmp.a.scheduling, cmp.b.scheduling) : [], [cmp]);
  const verdict = useMemo(() => {
    if (!cmp) return null;
    const p = tally(planRows), s = tally(schedRows);
    const a = p.a + s.a, b = p.b + s.b;
    return { a, b, planning: p, scheduling: s, winner: a === b ? null : (a > b ? "a" : "b") as "a" | "b" };
  }, [cmp, planRows, schedRows]);

  const pickerOptions = (exclude: string) =>
    projects.filter((p) => p.id !== exclude).map((p) => (
      <option key={p.id} value={p.id}>{p.name}{p.materializedFeedId ? "" : " (non materializzato)"}</option>
    ));

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-5">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="p-2 bg-primary/10 rounded-lg">
          <GitCompareArrows className="w-6 h-6 text-primary" />
        </div>
        <div>
          <h1 className="text-2xl font-bold">Confronto Scenari</h1>
          <p className="text-sm text-muted-foreground">
            Confronta due progetti Planning Studio su ogni aspetto — pianificazione e scheduling — per capire quale
            servizio conviene.
          </p>
        </div>
      </div>

      {/* Picker A/B */}
      <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto_1fr] gap-3 items-end">
        <div>
          <label className="block text-xs font-medium text-muted-foreground mb-1">Scenario A</label>
          <select value={aId} onChange={(e) => setAId(e.target.value)}
            className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm">
            <option value="">— seleziona —</option>
            {pickerOptions(bId)}
          </select>
        </div>
        <div className="flex items-center justify-center pb-2 text-muted-foreground">
          <ArrowRightLeft className="w-5 h-5" />
        </div>
        <div>
          <label className="block text-xs font-medium text-muted-foreground mb-1">Scenario B</label>
          <select value={bId} onChange={(e) => setBId(e.target.value)}
            className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm">
            <option value="">— seleziona —</option>
            {pickerOptions(aId)}
          </select>
        </div>
      </div>

      {projectsQ.isLoading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="w-4 h-4 animate-spin" /> Carico i progetti…</div>
      )}
      {!aId || !bId ? (
        <div className="border-2 border-dashed border-border rounded-lg p-12 text-center text-muted-foreground">
          <GitCompareArrows className="w-10 h-10 mx-auto mb-3 opacity-60" />
          Seleziona due scenari da confrontare.
        </div>
      ) : null}

      {compareQ.isLoading && (
        <div className="flex items-center justify-center py-16"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
      )}
      {compareQ.error && (
        <div className="flex items-center gap-3 p-4 bg-destructive/10 text-destructive rounded-lg">
          <AlertTriangle className="w-5 h-5" /> {(compareQ.error as Error).message}
        </div>
      )}

      {cmp && verdict && (
        <>
          {/* Verdetto */}
          <div className="rounded-xl border border-border bg-gradient-to-r from-primary/5 to-transparent p-4">
            <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-4">
              <ProjectHead m={cmp.a} side="A" win={verdict.winner === "a"} score={verdict.a} />
              <div className="text-center">
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Verdetto</div>
                <div className="text-sm font-bold">
                  {verdict.winner === null ? "Pareggio"
                    : verdict.winner === "a" ? "A migliore" : "B migliore"}
                </div>
                <div className="text-[11px] text-muted-foreground">
                  {verdict.a} – {verdict.b} indicatori
                </div>
              </div>
              <ProjectHead m={cmp.b} side="B" win={verdict.winner === "b"} score={verdict.b} />
            </div>
            {(!cmp.a.materialized || !cmp.b.materialized) && (
              <div className="mt-3 flex items-start gap-2 text-xs text-amber-600 dark:text-amber-400">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>
                  Un progetto non è ancora materializzato in feed: le metriche di pianificazione non sono calcolabili
                  finché non lo sincronizzi (Scheduling → sincronizza da PS, o attiva il progetto).
                </span>
              </div>
            )}
          </div>

          {/* Pianificazione */}
          <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2 pt-1">
            <MapIcon className="w-3.5 h-3.5" /> Pianificazione · servizio all'utenza
            <span className="ml-auto normal-case font-normal">A {verdict.planning.a} · B {verdict.planning.b}</span>
          </div>
          <div className="grid gap-4">
            <Section icon={<Route className="w-4 h-4" />} title="Rete, percorsi e territorio" rows={planRows.slice(0, 7)} />
            <Section icon={<ArrowRightLeft className="w-4 h-4" />} title="Intermodalità e coincidenze" rows={planRows.slice(7, 10)} />
            <Section icon={<Activity className="w-4 h-4" />} title="Traffico & rete" rows={planRows.slice(10)} />
          </div>

          {/* Scheduling */}
          <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2 pt-2">
            <Gauge className="w-3.5 h-3.5" /> Scheduling · turni macchina e guida
            <span className="ml-auto normal-case font-normal">A {verdict.scheduling.a} · B {verdict.scheduling.b}</span>
          </div>
          {(!cmp.a.scheduling.hasOperational || !cmp.b.scheduling.hasOperational) && (
            <div className="flex items-start gap-2 text-xs text-muted-foreground">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-amber-500" />
              Uno scenario non ha ancora turni in esercizio: i confronti di scheduling sono parziali.
            </div>
          )}
          <div className="grid gap-4">
            <Section icon={<Bus className="w-4 h-4" />} title="Turni macchina & costo" rows={schedRows.slice(0, 5)} />
            <Section icon={<Clock className="w-4 h-4" />} title="Turni guida" rows={schedRows.slice(5, 10)} />
            <Section icon={<Wallet className="w-4 h-4" />} title="Copertura del programma" rows={schedRows.slice(10)} />
          </div>

          <p className="text-[11px] text-muted-foreground pt-2 flex items-center gap-1.5">
            <Users className="w-3.5 h-3.5" />
            Il trofeo segna lo scenario migliore per ogni indicatore con direzione univoca. Gli indicatori "neutri"
            (linee, km, ore) restano informativi: dipendono dalle scelte di servizio.
          </p>
        </>
      )}
    </div>
  );
}

function ProjectHead({ m, side, win, score }: { m: ProjectMetrics; side: string; win: boolean; score: number }) {
  return (
    <div className={`rounded-lg p-3 border ${win ? "border-emerald-500/60 bg-emerald-500/5" : "border-border bg-background"}`}>
      <div className="flex items-center gap-2">
        <span className={`text-xs font-bold px-1.5 py-0.5 rounded ${win ? "bg-emerald-500 text-white" : "bg-muted text-muted-foreground"}`}>{side}</span>
        <span className="font-semibold text-sm truncate">{m.name}</span>
        {win && <Trophy className="w-4 h-4 text-emerald-500 ml-auto" />}
      </div>
      <div className="text-[11px] text-muted-foreground mt-1">{score} indicatori a favore</div>
    </div>
  );
}
