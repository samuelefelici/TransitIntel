import React, { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Users, MapPin, BarChart2, AlertTriangle, Building2,
  TrendingUp, ArrowRight, Info, CheckCircle, XCircle,
} from "lucide-react";
import { getApiBase } from "@/lib/api";

// ─── Types ────────────────────────────────────────────────────
interface DemandData {
  coverage: {
    totalPop: number; pop400: number; pop800: number;
    pct400: number; pct800: number;
  };
  topStops: Array<{
    stopId: string; name: string; lat: number; lon: number;
    tripCount: number; routeCount: number; routeIds: string[];
  }>;
  underserved: Array<{
    id: number; lng: number; lat: number;
    population: number; density: number; nearestStopM: number;
  }>;
  routeCoverage: Array<{
    routeId: string; shortName: string; color: string;
    stopCount: number; tripCount: number;
  }>;
  poi: { total: number; hospitals: number; schools: number; offices: number; shopping: number };
}

// ─── Helpers ─────────────────────────────────────────────────
function rc(c: string) { return c.startsWith("#") ? c : c ? `#${c}` : "#64748b"; }
function fmt(n: number) { return n.toLocaleString("it-IT"); }

type Tab = "coverage" | "stops" | "underserved";
const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: "coverage",    label: "Copertura rete",      icon: <BarChart2 className="w-3.5 h-3.5" /> },
  { id: "stops",       label: "Fermate più attive",  icon: <MapPin className="w-3.5 h-3.5" /> },
  { id: "underserved", label: "Zone scoperte",        icon: <AlertTriangle className="w-3.5 h-3.5" /> },
];

const GAP_LABELS: [number, string, string][] = [
  [400, "400 m", "A piedi 5 min"],
  [800, "800 m", "A piedi 10 min"],
];

// ─── Main Page ────────────────────────────────────────────────
export default function DemandPage() {
  const [data, setData] = useState<DemandData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("coverage");

  useEffect(() => {
    setLoading(true);
    fetch(`${getApiBase()}/api/analysis/demand`, { cache: "no-store" })
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false); })
      .catch(() => { setError("Errore caricamento dati"); setLoading(false); });
  }, []);

  if (loading) return (
    <div className="h-full flex items-center justify-center gap-3 text-muted-foreground">
      <div className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      <p className="text-sm">Calcolo copertura in corso…</p>
    </div>
  );
  if (error || !data) return (
    <div className="h-full flex items-center justify-center text-destructive text-sm">{error ?? "Errore"}</div>
  );

  const { coverage, topStops, underserved, routeCoverage, poi } = data;
  const uncoveredPop800 = coverage.totalPop - coverage.pop800;

  return (
    <div className="h-full flex flex-col overflow-hidden">

      {/* ── Header ───────────────────────────────────────────── */}
      <div className="px-4 pt-3 pb-2 border-b border-border/30 shrink-0">
        <div className="flex items-center gap-2 mb-2">
          <BarChart2 className="w-4 h-4 text-primary" />
          <h1 className="text-base font-display font-bold">Analisi Domanda</h1>
          <span className="text-[10px] text-muted-foreground">· copertura popolazione · fermate attive · zone scoperte</span>
        </div>

        {/* KPI strip */}
        <div className="flex gap-2 flex-wrap">
          <KpiCard icon={<Users className="w-3.5 h-3.5 text-blue-400" />}
            label="Copertura 400 m" value={`${coverage.pct400}%`}
            sub={`${fmt(coverage.pop400)} ab. a 5 min a piedi`} color="text-blue-400" />
          <KpiCard icon={<Users className="w-3.5 h-3.5 text-green-400" />}
            label="Copertura 800 m" value={`${coverage.pct800}%`}
            sub={`${fmt(coverage.pop800)} ab. a 10 min a piedi`} color="text-green-400" />
          <KpiCard icon={<AlertTriangle className="w-3.5 h-3.5 text-orange-400" />}
            label="Scoperta > 800 m" value={fmt(uncoveredPop800)}
            sub="abitanti fuori dalla rete" color="text-orange-400" />
          <KpiCard icon={<MapPin className="w-3.5 h-3.5 text-purple-400" />}
            label="Fermate GTFS" value="3.943"
            sub="nella rete Ancona/Marche" color="text-purple-400" />
          <KpiCard icon={<Building2 className="w-3.5 h-3.5 text-cyan-400" />}
            label="Punti di interesse" value={fmt(poi.total)}
            sub={`${poi.hospitals} osp · ${poi.schools} scuole · ${poi.offices} uffici`} color="text-cyan-400" />
        </div>
      </div>

      {/* ── Disclaimer ───────────────────────────────────────── */}
      <div className="mx-4 mt-2 mb-1 shrink-0 flex items-start gap-2 text-[10px] text-muted-foreground bg-muted/20 border border-border/30 rounded-lg px-3 py-2">
        <Info className="w-3 h-3 mt-0.5 shrink-0 text-muted-foreground/60" />
        <span>
          Copertura calcolata su <strong>86 sezioni censuarie ISTAT</strong> (pop. totale {fmt(coverage.totalPop)} ab.)
          e <strong>3.943 fermate GTFS ATMA/Marche</strong>. Le distanze sono in linea d'aria.
          Dati GTFS aggiornati: gennaio–dicembre 2026.
        </span>
      </div>

      {/* ── Tabs ──────────────────────────────────────────────── */}
      <div className="flex gap-1 px-4 py-1.5 border-b border-border/30 shrink-0">
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`flex items-center gap-1.5 text-[11px] px-3 py-1 rounded-lg border transition-all ${
              tab === t.id
                ? "bg-primary/10 border-primary/30 text-primary font-medium"
                : "border-border/30 text-muted-foreground hover:text-foreground hover:border-border"
            }`}>
            {t.icon}
            {t.label}
          </button>
        ))}
      </div>

      {/* ── Tab content ───────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto">
        <AnimatePresence mode="wait">
          {tab === "coverage" && (
            <motion.div key="coverage" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
              className="p-4 space-y-6 max-w-3xl">
              <CoverageSection coverage={coverage} uncoveredPop800={uncoveredPop800} />
              <RouteSection routes={routeCoverage} />
              <PoiSection poi={poi} />
            </motion.div>
          )}
          {tab === "stops" && (
            <motion.div key="stops" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
              className="p-4 max-w-3xl">
              <StopsSection stops={topStops} />
            </motion.div>
          )}
          {tab === "underserved" && (
            <motion.div key="underserved" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
              className="p-4 max-w-3xl">
              <UnderservedSection items={underserved} />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

// ─── Coverage Section ─────────────────────────────────────────
function CoverageSection({ coverage, uncoveredPop800 }: {
  coverage: DemandData["coverage"]; uncoveredPop800: number;
}) {
  return (
    <section>
      <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
        <Users className="w-4 h-4 text-primary" />
        Popolazione coperta dalla rete ATMA
      </h2>
      <p className="text-xs text-muted-foreground mb-4">
        Percentuale di residenti che hanno una fermata GTFS entro la distanza indicata (linea d'aria).
        Una copertura a 400 m significa che il cittadino può raggiungere la fermata in ~5 minuti a piedi.
      </p>

      {/* Visual coverage bars */}
      <div className="space-y-4">
        {[
          { label: "400 m · 5 min a piedi", pct: coverage.pct400, pop: coverage.pop400, color: "#3b82f6" },
          { label: "800 m · 10 min a piedi", pct: coverage.pct800, pop: coverage.pop800, color: "#22c55e" },
        ].map(row => (
          <div key={row.label}>
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-xs font-medium">{row.label}</span>
              <span className="text-xs font-bold" style={{ color: row.color }}>{row.pct}%</span>
            </div>
            <div className="h-5 w-full bg-muted/40 rounded-full overflow-hidden border border-border/30">
              <motion.div initial={{ width: 0 }} animate={{ width: `${row.pct}%` }}
                transition={{ duration: 0.8, ease: "easeOut" }}
                className="h-full rounded-full flex items-center justify-end pr-2"
                style={{ backgroundColor: row.color + "cc" }}>
                <span className="text-[10px] text-white font-bold">{fmt(row.pop)} ab.</span>
              </motion.div>
            </div>
          </div>
        ))}

        {/* Uncovered bar */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-xs font-medium text-orange-400">Fuori copertura (&gt;800 m)</span>
            <span className="text-xs font-bold text-orange-400">
              {(100 - coverage.pct800).toFixed(1)}%
            </span>
          </div>
          <div className="h-5 w-full bg-muted/40 rounded-full overflow-hidden border border-border/30">
            <motion.div initial={{ width: 0 }}
              animate={{ width: `${(100 - coverage.pct800).toFixed(1)}%` }}
              transition={{ duration: 0.8, ease: "easeOut", delay: 0.2 }}
              className="h-full bg-orange-400/60 rounded-full flex items-center justify-end pr-2">
              <span className="text-[10px] text-white font-bold">{fmt(uncoveredPop800)} ab.</span>
            </motion.div>
          </div>
        </div>
      </div>

      {/* Summary callout */}
      <div className="mt-4 grid grid-cols-2 gap-3">
        <div className="rounded-xl border border-green-500/20 bg-green-500/5 p-3 flex gap-2">
          <CheckCircle className="w-4 h-4 text-green-400 shrink-0 mt-0.5" />
          <div>
            <p className="text-xs font-semibold text-green-400">{coverage.pct800}% coperto a 800 m</p>
            <p className="text-[10px] text-muted-foreground mt-0.5">
              {fmt(coverage.pop800)} su {fmt(coverage.totalPop)} abitanti hanno accesso alla rete
            </p>
          </div>
        </div>
        <div className="rounded-xl border border-orange-500/20 bg-orange-500/5 p-3 flex gap-2">
          <XCircle className="w-4 h-4 text-orange-400 shrink-0 mt-0.5" />
          <div>
            <p className="text-xs font-semibold text-orange-400">{fmt(uncoveredPop800)} ab. scoperti</p>
            <p className="text-[10px] text-muted-foreground mt-0.5">
              Senza fermata GTFS entro 800 m · vedi tab "Zone scoperte"
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

// ─── Route Section ────────────────────────────────────────────
function RouteSection({ routes }: { routes: DemandData["routeCoverage"] }) {
  const max = Math.max(...routes.map(r => r.tripCount), 1);
  return (
    <section>
      <h2 className="text-sm font-semibold mb-1 flex items-center gap-2">
        <TrendingUp className="w-4 h-4 text-primary" />
        Linee per numero di corse giornaliere
      </h2>
      <p className="text-xs text-muted-foreground mb-3">
        Numero di trip programmati per linea. Più trip = più offerta di servizio su quella tratta.
      </p>
      <div className="space-y-2">
        {routes.map((r, i) => {
          const color = rc(r.color);
          const pct = (r.tripCount / max) * 100;
          return (
            <div key={r.routeId} className="flex items-center gap-2">
              <span className="w-16 shrink-0 text-right text-[10px] font-bold px-1.5 py-0.5 rounded text-white"
                style={{ backgroundColor: color }}>
                {r.shortName}
              </span>
              <div className="flex-1 h-4 bg-muted/30 rounded overflow-hidden">
                <motion.div initial={{ width: 0 }} animate={{ width: `${pct}%` }}
                  transition={{ duration: 0.5, delay: i * 0.03 }}
                  className="h-full rounded flex items-center justify-end pr-1"
                  style={{ backgroundColor: color + "99" }}>
                  {pct > 20 && <span className="text-[9px] text-white font-bold">{r.tripCount}</span>}
                </motion.div>
              </div>
              {pct <= 20 && <span className="text-[10px] text-muted-foreground w-8">{r.tripCount}</span>}
              <span className="text-[10px] text-muted-foreground/60 w-16 shrink-0">{r.stopCount} ferm.</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ─── POI Section ──────────────────────────────────────────────
function PoiSection({ poi }: { poi: DemandData["poi"] }) {
  const items = [
    { label: "Ospedali e cliniche", value: poi.hospitals, icon: "🏥", color: "text-red-400" },
    { label: "Scuole e università",  value: poi.schools,   icon: "🏫", color: "text-blue-400" },
    { label: "Uffici e PA",          value: poi.offices,   icon: "🏢", color: "text-purple-400" },
    { label: "Negozi e centri comm.",value: poi.shopping,  icon: "🛒", color: "text-yellow-400" },
  ];
  return (
    <section>
      <h2 className="text-sm font-semibold mb-1 flex items-center gap-2">
        <Building2 className="w-4 h-4 text-primary" />
        Punti di interesse nella rete ({poi.total.toLocaleString("it-IT")} totali)
      </h2>
      <p className="text-xs text-muted-foreground mb-3">
        Generatori di domanda: luoghi che attraggono spostamenti in autobus.
      </p>
      <div className="grid grid-cols-2 gap-3">
        {items.map(item => (
          <div key={item.label} className="bg-card/40 border border-border/30 rounded-xl p-3 flex items-center gap-3">
            <span className="text-xl">{item.icon}</span>
            <div>
              <p className={`text-sm font-bold ${item.color}`}>{item.value}</p>
              <p className="text-[10px] text-muted-foreground">{item.label}</p>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

// ─── Stops Section ────────────────────────────────────────────
function StopsSection({ stops }: { stops: DemandData["topStops"] }) {
  const max = Math.max(...stops.map(s => s.tripCount), 1);
  return (
    <section>
      <h2 className="text-sm font-semibold mb-1 flex items-center gap-2">
        <MapPin className="w-4 h-4 text-primary" />
        Top 20 fermate per numero di corse
      </h2>
      <p className="text-xs text-muted-foreground mb-3">
        Fermate con il maggiore passaggio giornaliero di autobus. Una fermata con molte corse è un nodo
        strategico della rete — la sua efficienza impatta l'intera linea.
      </p>
      <div className="space-y-2">
        {stops.map((s, i) => {
          const pct = (s.tripCount / max) * 100;
          return (
            <motion.div key={s.stopId}
              initial={{ opacity: 0, x: -4 }} animate={{ opacity: 1, x: 0 }}
              transition={{ delay: i * 0.025 }}
              className="flex items-center gap-3 bg-card/30 border border-border/30 rounded-xl px-3 py-2">
              <span className="w-5 text-[10px] text-muted-foreground/60 font-mono shrink-0">{i + 1}</span>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium truncate">{s.name}</p>
                <div className="mt-1 h-1.5 w-full bg-muted/40 rounded overflow-hidden">
                  <motion.div initial={{ width: 0 }} animate={{ width: `${pct}%` }}
                    transition={{ duration: 0.5, delay: i * 0.025 }}
                    className="h-full bg-primary/60 rounded" />
                </div>
              </div>
              <div className="text-right shrink-0">
                <p className="text-xs font-bold text-primary">{s.tripCount.toLocaleString("it-IT")}</p>
                <p className="text-[10px] text-muted-foreground">{s.routeCount} linee</p>
              </div>
              <div className="flex flex-wrap gap-0.5 max-w-[80px] justify-end shrink-0">
                {s.routeIds.slice(0, 3).map(rid => (
                  <span key={rid} className="text-[8px] font-bold px-1 py-0.5 rounded bg-muted/50 border border-border/40 text-muted-foreground">
                    {rid}
                  </span>
                ))}
                {s.routeIds.length > 3 && (
                  <span className="text-[8px] text-muted-foreground/50">+{s.routeIds.length - 3}</span>
                )}
              </div>
            </motion.div>
          );
        })}
      </div>
    </section>
  );
}

// ─── Underserved Section ──────────────────────────────────────
function UnderservedSection({ items }: { items: DemandData["underserved"] }) {
  const coverageOk = items.filter(x => x.nearestStopM <= 400);
  const weak = items.filter(x => x.nearestStopM > 400 && x.nearestStopM <= 800);
  const missing = items.filter(x => x.nearestStopM > 800);

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold mb-1 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-orange-400" />
          Zone con scarsa copertura
        </h2>
        <p className="text-xs text-muted-foreground mb-3">
          Sezioni censuarie ISTAT con oltre 2.000 abitanti, ordinate per distanza dalla fermata GTFS più vicina.
          Le zone in rosso non hanno fermate entro 800 m — i residenti devono camminare di più o usare altri mezzi.
        </p>
      </div>

      {/* Summary badges */}
      <div className="grid grid-cols-3 gap-2">
        <SummaryBadge icon="✅" label="Ben servite (≤400 m)"
          count={coverageOk.length} color="border-green-500/20 bg-green-500/5 text-green-400" />
        <SummaryBadge icon="⚠️" label="Deboli (400–800 m)"
          count={weak.length} color="border-yellow-500/20 bg-yellow-500/5 text-yellow-400" />
        <SummaryBadge icon="❌" label="Scoperte (>800 m)"
          count={missing.length} color="border-red-500/20 bg-red-500/5 text-red-400" />
      </div>

      {/* List */}
      <div className="space-y-2">
        {items.map((item, i) => {
          const d = item.nearestStopM;
          const [bg, border, text] = d > 800
            ? ["bg-red-500/5",    "border-red-500/20",    "text-red-400"]
            : d > 400
            ? ["bg-yellow-500/5", "border-yellow-500/20", "text-yellow-400"]
            : ["bg-green-500/5",  "border-green-500/20",  "text-green-400"];

          return (
            <motion.div key={item.id}
              initial={{ opacity: 0, x: -4 }} animate={{ opacity: 1, x: 0 }}
              transition={{ delay: i * 0.02 }}
              className={`flex items-center gap-3 rounded-xl border ${border} ${bg} px-3 py-2.5`}>
              <div className={`text-xs font-bold w-16 shrink-0 ${text}`}>
                {d >= 1000 ? `${(d / 1000).toFixed(1)} km` : `${d} m`}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium">
                  {item.lat.toFixed(4)}°N · {item.lng.toFixed(4)}°E
                </p>
                <p className="text-[10px] text-muted-foreground mt-0.5">
                  {item.population.toLocaleString("it-IT")} abitanti · densità {item.density.toLocaleString("it-IT")} ab/km²
                </p>
              </div>
              <div className="shrink-0">
                <a href={`https://www.google.com/maps?q=${item.lat},${item.lng}`}
                  target="_blank" rel="noopener noreferrer"
                  className={`text-[10px] ${text} hover:underline`}>
                  Mappa →
                </a>
              </div>
            </motion.div>
          );
        })}
      </div>
    </section>
  );
}

// ─── Sub-components ───────────────────────────────────────────
function KpiCard({ icon, label, value, sub, color }: {
  icon: React.ReactNode; label: string; value: string; sub: string; color: string;
}) {
  return (
    <div className="flex items-center gap-2 bg-card/40 border border-border/30 rounded-xl px-3 py-2">
      {icon}
      <div>
        <p className={`text-sm font-bold leading-none ${color}`}>{value}</p>
        <p className="text-[9px] text-muted-foreground leading-tight mt-0.5">{label}</p>
        <p className="text-[9px] text-muted-foreground/60 leading-tight">{sub}</p>
      </div>
    </div>
  );
}

function SummaryBadge({ icon, label, count, color }: {
  icon: string; label: string; count: number; color: string;
}) {
  return (
    <div className={`rounded-xl border ${color} p-2.5 text-center`}>
      <div className="text-lg mb-0.5">{icon}</div>
      <p className="text-base font-bold">{count}</p>
      <p className="text-[9px] text-muted-foreground leading-tight">{label}</p>
    </div>
  );
}
