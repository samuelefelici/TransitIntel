import React, { useState, useEffect, useMemo, lazy, Suspense } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Users, Building2, MapPin, TrendingUp, Map, AlertTriangle, CheckCircle2,
  Shield, Target, Layers, BarChart3, Activity, ArrowRight, Zap, Eye, Navigation,
  GraduationCap,
} from "lucide-react";
import { StatCard } from "@/components/ui/stat-card";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, Cell, LabelList, AreaChart, Area, ScatterChart, Scatter,
  ZAxis, PieChart, Pie, Legend,
} from "recharts";
import { getApiBase } from "@/lib/api";
import { useGetAnalysisUnderserved } from "@workspace/api-client-react";

// Lazy-load sub-pages for "Qualità Servizio" and "Segmenti Utenza"
const DemandContent = lazy(() => import("@/pages/demand"));
const SegmentsContent = lazy(() => import("@/pages/segments"));

/* ═══════════════════════════════════════════════════════════════════════
   TYPES
   ═══════════════════════════════════════════════════════════════════════ */

interface TerritoryData {
  stats: {
    totalPop: number; totalSections: number; avgDensity: number;
    totalPoi: number; minDensity: number; maxDensity: number;
  };
  poiByCategory: { category: string; label: string; count: number; color: string }[];
  topSections: {
    rank: number; population: number; density: number;
    nearestStopM: number; poiCount: number; lat: number; lng: number;
  }[];
  densityBands: { band: string; sections: number; population: number }[];
  densityCoverage: { band: string; avgNearestM: number; sectionCount: number }[];
}

interface DeepData {
  coverageCurve: { threshold: number; popCovered: number; totalPop: number; pct: number }[];
  distanceHistogram: { band: string; sections: number; population: number }[];
  densityVsDistance: { density: number; distance: number; population: number }[];
  gapAnalysis: {
    population: number; density: number; nearestM: number;
    poiCount: number; gapScore: number; lat: number; lng: number;
  }[];
  populationPyramid: {
    classe: string; sections: number; population: number;
    avgDensity: number; medianPop: number;
  }[];
  poiCoverage: {
    category: string; label: string; total: number;
    nearStop: number; farFromStop: number; pct: number;
  }[];
}

/* ═══════════════════════════════════════════════════════════════════════
   CONSTANTS
   ═══════════════════════════════════════════════════════════════════════ */

const PYRAMID_COLORS: Record<string, string> = {
  "Rurale": "#64748b", "Periurbano": "#06b6d4", "Suburbano": "#3b82f6",
  "Urbano": "#8b5cf6", "Urbano denso": "#f59e0b", "Centro città": "#ef4444",
};

const HISTO_COLORS = [
  "#22c55e", "#22c55e", "#84cc16", "#eab308", "#f97316", "#ef4444", "#dc2626", "#991b1b",
];

const POI_COLORS: Record<string, string> = {
  hospital: "#ef4444", transit: "#06b6d4", leisure: "#22c55e",
  school: "#eab308", office: "#3b82f6", shopping: "#a855f7",
  industrial: "#f97316", workplace: "#64748b", worship: "#d946ef",
  elderly: "#f43f5e", parking: "#94a3b8", tourism: "#14b8a6",
};

/* ═══════════════════════════════════════════════════════════════════════
   ANIMATED COUNTER
   ═══════════════════════════════════════════════════════════════════════ */

function AnimatedNumber({ value, suffix = "" }: { value: number; suffix?: string }) {
  const [display, setDisplay] = useState(0);
  useEffect(() => {
    let start = 0;
    const step = Math.ceil(value / 75);
    const timer = setInterval(() => {
      start += step;
      if (start >= value) { setDisplay(value); clearInterval(timer); }
      else setDisplay(start);
    }, 16);
    return () => clearInterval(timer);
  }, [value]);
  return <>{display.toLocaleString("it-IT")}{suffix}</>;
}

/* ═══════════════════════════════════════════════════════════════════════
   CUSTOM TOOLTIPS
   ═══════════════════════════════════════════════════════════════════════ */

const CoverageTooltip = ({ active, payload }: any) => {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className="bg-card border border-border rounded-xl px-4 py-3 shadow-xl text-xs space-y-1">
      <p className="font-semibold text-sm">Entro {d.threshold >= 1000 ? `${d.threshold / 1000} km` : `${d.threshold} m`}</p>
      <p><span className="text-primary font-mono font-bold">{d.pct}%</span> della popolazione servita</p>
      <p className="text-muted-foreground">{d.popCovered.toLocaleString("it-IT")} su {d.totalPop.toLocaleString("it-IT")} abitanti</p>
    </div>
  );
};

const HistoTooltip = ({ active, payload }: any) => {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className="bg-card border border-border rounded-xl px-4 py-3 shadow-xl text-xs space-y-1">
      <p className="font-semibold text-sm">{d.band}</p>
      <p><span className="font-mono font-bold text-primary">{d.population.toLocaleString("it-IT")}</span> abitanti</p>
      <p className="text-muted-foreground">{d.sections} sezioni censuarie</p>
    </div>
  );
};

const ScatterTooltip = ({ active, payload }: any) => {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className="bg-card border border-border rounded-xl px-4 py-3 shadow-xl text-xs space-y-1">
      <p className="font-semibold text-sm">Sezione censuaria</p>
      <p>Densità: <span className="font-mono font-bold">{Math.round(d.density).toLocaleString("it-IT")} ab/km²</span></p>
      <p>Fermata: <span className="font-mono font-bold">{d.distance} m</span></p>
      <p>Popolazione: <span className="font-mono font-bold">{d.population}</span></p>
    </div>
  );
};

/* ═══════════════════════════════════════════════════════════════════════
   MAIN COMPONENT
   ═══════════════════════════════════════════════════════════════════════ */

export default function Territory() {
  const [data, setData] = useState<TerritoryData | null>(null);
  const [deep, setDeep] = useState<DeepData | null>(null);
  const [loading, setLoading] = useState(true);     // blocca solo finché overview non è pronto
  const [deepLoading, setDeepLoading] = useState(true); // spinner inline per le sezioni che dipendono da deep
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"popolazione" | "copertura" | "gap" | "qualita" | "segmenti">("popolazione");

  useEffect(() => {
    // Fetch disaccoppiati: l'overview è veloce (~5s cold, ms warm) e sblocca il render.
    // Il deep è pesante (~27s cold) ma serve solo per chart secondari → spinner inline.
    fetch(`${getApiBase()}/api/territory/overview`)
      .then(r => r.json())
      .then(overview => { setData(overview); setLoading(false); })
      .catch(() => { setError("Errore nel caricamento dei dati."); setLoading(false); });

    fetch(`${getApiBase()}/api/territory/deep`)
      .then(r => r.json())
      .then(deepData => { setDeep(deepData); setDeepLoading(false); })
      .catch(() => { setDeepLoading(false); /* deep è opzionale, non blocca la pagina */ });
  }, []);

  // Underserved areas from API
  const { data: underservedData } = useGetAnalysisUnderserved({ minScore: 3 });
  const underservedAreas = underservedData?.data ?? [];

  const popServed500m = deep?.coverageCurve?.find(c => c.threshold === 500)?.pct ?? 0;
  const popServed300m = deep?.coverageCurve?.find(c => c.threshold === 300)?.pct ?? 0;
  const totalGapPop = deep?.gapAnalysis?.reduce((s, g) => s + g.population, 0) ?? 0;
  const poiAccessScore = deep?.poiCoverage
    ? Math.round(deep.poiCoverage.reduce((s, p) => s + p.pct, 0) / Math.max(deep.poiCoverage.length, 1))
    : 0;

  if (loading) {
    return (
      <div className="max-w-7xl mx-auto space-y-6 p-4">
        <div className="animate-pulse space-y-6">
          <div className="h-10 bg-muted rounded w-96" />
          <div className="grid grid-cols-5 gap-4">
            {[0, 1, 2, 3, 4].map(i => <div key={i} className="h-28 bg-muted rounded-xl" />)}
          </div>
          <div className="h-96 bg-muted rounded-xl" />
        </div>
      </div>
    );
  }
  if (error || !data) return <div className="text-red-400 p-8">{error ?? "Dati non disponibili."}</div>;

  return (
    <div className="max-w-7xl mx-auto space-y-8 p-4 pb-10">

      {/* ═══════ HERO ═══════ */}
      <motion.div initial={{ opacity: 0, y: -20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}>
        <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-primary/10 via-card/80 to-primary/5 border border-border/50 p-6 sm:p-8">
          <div className="absolute -top-20 -right-20 w-64 h-64 bg-primary/5 rounded-full blur-3xl" />
          <div className="absolute -bottom-16 -left-16 w-48 h-48 bg-violet-500/5 rounded-full blur-3xl" />
          <div className="relative">
            <h1 className="text-3xl sm:text-4xl font-display font-bold text-foreground">
              Analisi Territorio e Popolazione
            </h1>
            <p className="text-muted-foreground mt-2 text-sm max-w-2xl">
              Radiografia completa della provincia di Ancona: {data.stats.totalSections.toLocaleString("it-IT")} sezioni censuarie ISTAT,{" "}
              {data.stats.totalPoi.toLocaleString("it-IT")} punti di interesse e{" "}
              {(data.stats.totalPop / 1000).toFixed(0)}k abitanti analizzati in relazione alla rete TPL.
            </p>
            {deepLoading && (
              <div className="mt-3 inline-flex items-center gap-2 text-[11px] text-amber-300/90 bg-amber-500/10 border border-amber-400/30 rounded-full px-3 py-1">
                <div className="w-3 h-3 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
                Calcolo analisi avanzate (copertura · gap · POI)…
              </div>
            )}
          </div>
        </div>
      </motion.div>

      {/* ═══════ KPI STRIP ═══════ */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        {([
          { icon: Users, color: "text-primary", value: data.stats.totalPop, label: "Abitanti" },
          { icon: Map, color: "text-cyan-400", value: data.stats.totalSections, label: "Sezioni ISTAT" },
          { icon: Building2, color: "text-violet-400", value: data.stats.totalPoi, label: "Punti di interesse" },
        ] as const).map((kpi, i) => (
          <motion.div key={kpi.label} initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} transition={{ delay: i * 0.05 }}>
            <Card className="bg-card/60 backdrop-blur border-border/50 p-4 text-center space-y-1">
              <kpi.icon className={`w-5 h-5 mx-auto ${kpi.color}`} />
              <div className="text-2xl font-bold font-mono"><AnimatedNumber value={kpi.value} /></div>
              <p className="text-[11px] text-muted-foreground">{kpi.label}</p>
            </Card>
          </motion.div>
        ))}
        <motion.div initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} transition={{ delay: 0.15 }}>
          <Card className={`backdrop-blur border-border/50 p-4 text-center space-y-1 ${popServed500m >= 70 ? "bg-emerald-500/5" : "bg-orange-500/5"}`}>
            <Target className={`w-5 h-5 mx-auto ${popServed500m >= 70 ? "text-emerald-400" : "text-orange-400"}`} />
            <div className="text-2xl font-bold font-mono">{popServed500m}%</div>
            <p className="text-[11px] text-muted-foreground">Serviti entro 500 m</p>
          </Card>
        </motion.div>
        <motion.div initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} transition={{ delay: 0.2 }}>
          <Card className={`backdrop-blur border-border/50 p-4 text-center space-y-1 ${poiAccessScore >= 60 ? "bg-emerald-500/5" : "bg-amber-500/5"}`}>
            <Zap className={`w-5 h-5 mx-auto ${poiAccessScore >= 60 ? "text-emerald-400" : "text-amber-400"}`} />
            <div className="text-2xl font-bold font-mono">{poiAccessScore}%</div>
            <p className="text-[11px] text-muted-foreground">POI raggiungibili</p>
          </Card>
        </motion.div>
      </div>

      {/* ═══════ TAB BAR ═══════ */}
      <div className="flex flex-wrap bg-muted/40 rounded-xl p-1 border border-border/40 w-fit gap-0.5">
        {([
          { key: "popolazione" as const, label: "Popolazione & Densità", icon: Users },
          { key: "copertura" as const, label: "Copertura Rete TPL", icon: Target },
          { key: "gap" as const, label: "Gap & Opportunità", icon: AlertTriangle },
          { key: "qualita" as const, label: "Qualità Servizio", icon: GraduationCap },
          { key: "segmenti" as const, label: "Segmenti Utenza", icon: BarChart3 },
        ]).map(tab => (
          <button key={tab.key} onClick={() => setActiveTab(tab.key)}
            className={`px-4 py-2 rounded-lg text-xs font-medium transition-all flex items-center gap-1.5 ${
              activeTab === tab.key
                ? "bg-primary text-primary-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground hover:bg-muted/60"
            }`}>
            <tab.icon className="w-3.5 h-3.5" /> {tab.label}
          </button>
        ))}
      </div>

      {/* ═══════ TAB CONTENT ═══════ */}
      <AnimatePresence mode="wait">

        {/* ──── TAB: POPOLAZIONE ──── */}
        {activeTab === "popolazione" && (
          <motion.div key="pop" initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 20 }} className="space-y-6">

            {/* Piramide */}
            {deep?.populationPyramid && (
              <Card className="bg-card/60 backdrop-blur border-border/50">
                <CardHeader>
                  <CardTitle className="text-base flex items-center gap-2">
                    <Layers className="w-4 h-4 text-primary" /> Piramide demografica per classe di densità
                  </CardTitle>
                  <CardDescription className="text-xs">
                    Come si distribuiscono i {data.stats.totalPop.toLocaleString("it-IT")} abitanti tra aree rurali e centri urbani
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    {deep.populationPyramid.map((p, i) => {
                      const pct = Math.round(p.population / data.stats.totalPop * 100);
                      const col = PYRAMID_COLORS[p.classe] ?? "#94a3b8";
                      return (
                        <motion.div key={p.classe} initial={{ opacity: 0, x: -30 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.08 }}>
                          <div className="flex items-center gap-4">
                            <div className="w-28 shrink-0 text-right">
                              <span className="text-sm font-medium">{p.classe}</span>
                            </div>
                            <div className="flex-1 relative">
                              <div className="h-8 bg-muted/20 rounded-lg overflow-hidden">
                                <motion.div className="h-full rounded-lg flex items-center px-3 gap-2"
                                  initial={{ width: 0 }} animate={{ width: `${Math.max(pct, 3)}%` }}
                                  transition={{ duration: 0.8, delay: i * 0.1, ease: "easeOut" }}
                                  style={{ backgroundColor: col }}>
                                  {pct > 8 && (
                                    <span className="text-white text-xs font-bold whitespace-nowrap">
                                      {p.population.toLocaleString("it-IT")} ab.
                                    </span>
                                  )}
                                </motion.div>
                              </div>
                            </div>
                            <div className="w-20 shrink-0 text-right">
                              <div className="text-sm font-bold font-mono">{pct}%</div>
                              <div className="text-[10px] text-muted-foreground">{p.sections} sez.</div>
                            </div>
                          </div>
                          {pct <= 8 && (
                            <div className="ml-32 text-[10px] text-muted-foreground">
                              {p.population.toLocaleString("it-IT")} ab. · densità media {p.avgDensity.toLocaleString("it-IT")} ab/km²
                            </div>
                          )}
                        </motion.div>
                      );
                    })}
                  </div>
                  <div className="mt-4 pt-3 border-t border-border/30 flex flex-wrap gap-3 justify-center">
                    {Object.entries(PYRAMID_COLORS).map(([label, color]) => (
                      <div key={label} className="flex items-center gap-1.5">
                        <div className="w-3 h-3 rounded-sm" style={{ backgroundColor: color }} />
                        <span className="text-[10px] text-muted-foreground">{label}</span>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}

            {/* POI + Donut */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <Card className="bg-card/60 backdrop-blur border-border/50">
                <CardHeader>
                  <CardTitle className="text-base flex items-center gap-2">
                    <Building2 className="w-4 h-4 text-violet-400" /> Generatori di domanda (POI)
                  </CardTitle>
                  <CardDescription className="text-xs">
                    {data.stats.totalPoi.toLocaleString("it-IT")} punti che attraggono mobilità
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="h-72">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={data.poiByCategory.slice(0, 8)} layout="vertical"
                        margin={{ top: 0, right: 50, left: 10, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" horizontal={false} />
                        <XAxis type="number" stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} />
                        <YAxis dataKey="label" type="category" stroke="hsl(var(--muted-foreground))" fontSize={10} tickLine={false} axisLine={false} width={120} />
                        <Tooltip cursor={{ fill: "hsl(var(--muted)/0.4)" }}
                          contentStyle={{ backgroundColor: "hsl(var(--card))", borderColor: "hsl(var(--border))", borderRadius: 12, fontSize: 12 }}
                          formatter={(v: number) => [v.toLocaleString("it-IT"), "POI"]} />
                        <Bar dataKey="count" radius={[0, 6, 6, 0]} animationDuration={1000}>
                          <LabelList dataKey="count" position="right" style={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                            formatter={(v: number) => v.toLocaleString("it-IT")} />
                          {data.poiByCategory.slice(0, 8).map((entry, i) => (
                            <Cell key={i} fill={entry.color} />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </CardContent>
              </Card>

              <Card className="bg-card/60 backdrop-blur border-border/50">
                <CardHeader>
                  <CardTitle className="text-base flex items-center gap-2">
                    <BarChart3 className="w-4 h-4 text-primary" /> Composizione demografica
                  </CardTitle>
                  <CardDescription className="text-xs">Quanta popolazione vive in aree urbane vs rurali?</CardDescription>
                </CardHeader>
                <CardContent>
                  {deep?.populationPyramid ? (
                    <div className="h-72">
                      <ResponsiveContainer width="100%" height="100%">
                        <PieChart>
                          <Pie data={deep.populationPyramid} dataKey="population" nameKey="classe"
                            cx="50%" cy="50%" innerRadius={60} outerRadius={100} paddingAngle={2} animationDuration={1000}>
                            {deep.populationPyramid.map((entry, i) => (
                              <Cell key={i} fill={PYRAMID_COLORS[entry.classe] ?? "#94a3b8"} />
                            ))}
                          </Pie>
                          <Tooltip contentStyle={{ backgroundColor: "hsl(var(--card))", borderColor: "hsl(var(--border))", borderRadius: 12, fontSize: 12 }}
                            formatter={(v: number) => [v.toLocaleString("it-IT") + " ab.", "Popolazione"]} />
                          <Legend iconSize={10} wrapperStyle={{ fontSize: 11 }} />
                        </PieChart>
                      </ResponsiveContainer>
                    </div>
                  ) : (
                    <div className="space-y-3 pt-2">
                      {data.densityBands.map(band => {
                        const pct = Math.round((band.population / data.stats.totalPop) * 100);
                        return (
                          <div key={band.band}>
                            <div className="flex justify-between text-sm mb-1">
                              <span className="font-medium">{band.band}</span>
                              <span className="text-muted-foreground">{band.population.toLocaleString("it-IT")} ab. ({pct}%)</span>
                            </div>
                            <div className="h-2 bg-muted/30 rounded-full overflow-hidden">
                              <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: "#8b5cf6" }} />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>

            {/* Insight */}
            <Card className="bg-gradient-to-r from-primary/5 to-violet-500/5 border-primary/20">
              <CardContent className="flex items-start gap-4 pt-5 pb-5">
                <Eye className="w-5 h-5 text-primary shrink-0 mt-0.5" />
                <div className="text-sm text-muted-foreground space-y-1">
                  <p className="font-semibold text-foreground">Insight demografico</p>
                  <p>
                    La maggior parte della popolazione ({deep?.populationPyramid?.find(p => p.classe === "Centro città")?.population.toLocaleString("it-IT") ?? "N/A"} ab.)
                    si concentra nei <strong>centri città ad alta densità</strong>, mentre le aree rurali ospitano
                    {" "}{deep?.populationPyramid?.find(p => p.classe === "Rurale")?.population.toLocaleString("it-IT") ?? "N/A"} abitanti
                    distribuiti su {deep?.populationPyramid?.find(p => p.classe === "Rurale")?.sections ?? "N/A"} sezioni.
                    Questa polarizzazione richiede <strong>strategie di servizio differenziate</strong>: frequenza in area urbana, servizio a chiamata nelle zone rurali.
                  </p>
                </div>
              </CardContent>
            </Card>
          </motion.div>
        )}

        {/* ──── TAB: COPERTURA ──── */}
        {activeTab === "copertura" && deep && (
          <motion.div key="cov" initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 20 }} className="space-y-6">

            {/* Curva copertura */}
            <Card className="bg-card/60 backdrop-blur border-border/50">
              <CardHeader>
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                  <div>
                    <CardTitle className="text-base flex items-center gap-2">
                      <Activity className="w-4 h-4 text-emerald-400" /> Curva di copertura della popolazione
                    </CardTitle>
                    <CardDescription className="text-xs mt-1">
                      Percentuale di abitanti entro una certa distanza dalla fermata più vicina
                    </CardDescription>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="text-center px-3 py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
                      <div className="text-lg font-bold font-mono text-emerald-400">{popServed300m}%</div>
                      <div className="text-[10px] text-emerald-400/70">entro 300 m</div>
                    </div>
                    <div className="text-center px-3 py-1.5 rounded-lg bg-primary/10 border border-primary/20">
                      <div className="text-lg font-bold font-mono text-primary">{popServed500m}%</div>
                      <div className="text-[10px] text-primary/70">entro 500 m</div>
                    </div>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <div className="h-[320px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={deep.coverageCurve} margin={{ top: 10, right: 30, bottom: 10, left: 0 }}>
                      <defs>
                        <linearGradient id="gradCov" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#22c55e" stopOpacity={0.3} />
                          <stop offset="95%" stopColor="#22c55e" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                      <XAxis dataKey="threshold" stroke="hsl(var(--muted-foreground))" fontSize={11}
                        tickLine={false} axisLine={false}
                        tickFormatter={(v: number) => v >= 1000 ? `${v / 1000} km` : `${v} m`} />
                      <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11}
                        tickLine={false} axisLine={false} tickFormatter={(v: number) => `${v}%`} domain={[0, 100]} />
                      <Tooltip content={<CoverageTooltip />} />
                      <Area type="monotone" dataKey="pct" name="Copertura"
                        stroke="#22c55e" strokeWidth={3} fill="url(#gradCov)"
                        dot={{ r: 5, fill: "#22c55e", strokeWidth: 2, stroke: "hsl(var(--card))" }}
                        animationDuration={1200} />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
                <div className="mt-3 pt-3 border-t border-border/30 text-[11px] text-muted-foreground text-center">
                  📍 Standard europeo UITP: almeno l'80% della popolazione entro 500 m da una fermata
                </div>
              </CardContent>
            </Card>

            {/* Histogram + POI accessibility */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <Card className="bg-card/60 backdrop-blur border-border/50">
                <CardHeader>
                  <CardTitle className="text-base flex items-center gap-2">
                    <MapPin className="w-4 h-4 text-orange-400" /> Distribuzione distanza dalla fermata
                  </CardTitle>
                  <CardDescription className="text-xs">Quanti abitanti vivono a ciascuna distanza?</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="h-[280px]">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={deep.distanceHistogram} margin={{ top: 10, right: 10, bottom: 0, left: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                        <XAxis dataKey="band" stroke="hsl(var(--muted-foreground))" fontSize={10} tickLine={false} axisLine={false}
                          angle={-30} textAnchor="end" height={50} />
                        <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false}
                          tickFormatter={(v: number) => v >= 1000 ? `${(v / 1000).toFixed(0)}k` : v.toString()} />
                        <Tooltip content={<HistoTooltip />} />
                        <Bar dataKey="population" radius={[4, 4, 0, 0]} animationDuration={800}>
                          {deep.distanceHistogram.map((_, i) => (
                            <Cell key={i} fill={HISTO_COLORS[i] ?? "#94a3b8"} />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </CardContent>
              </Card>

              <Card className="bg-card/60 backdrop-blur border-border/50">
                <CardHeader>
                  <CardTitle className="text-base flex items-center gap-2">
                    <Shield className="w-4 h-4 text-emerald-400" /> Accessibilità POI alla rete TPL
                  </CardTitle>
                  <CardDescription className="text-xs">
                    % di punti di interesse raggiungibili entro 400 m da una fermata
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    {deep.poiCoverage.filter(p => p.total >= 10).map((p, i) => {
                      const col = POI_COLORS[p.category] ?? "#94a3b8";
                      return (
                        <motion.div key={p.category} initial={{ opacity: 0, x: -20 }}
                          animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.06 }}>
                          <div className="flex items-center justify-between mb-1">
                            <div className="flex items-center gap-2">
                              <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: col }} />
                              <span className="text-xs font-medium">{p.label}</span>
                              <span className="text-[10px] text-muted-foreground">({p.total})</span>
                            </div>
                            <span className={`text-xs font-bold font-mono ${p.pct >= 60 ? "text-emerald-400" : p.pct >= 40 ? "text-yellow-400" : "text-red-400"}`}>
                              {p.pct}%
                            </span>
                          </div>
                          <div className="h-1.5 bg-muted/30 rounded-full overflow-hidden">
                            <motion.div className="h-full rounded-full"
                              initial={{ width: 0 }} animate={{ width: `${p.pct}%` }}
                              transition={{ duration: 0.7, delay: i * 0.06 }}
                              style={{ backgroundColor: col, opacity: 0.8 }} />
                          </div>
                        </motion.div>
                      );
                    })}
                  </div>
                  <div className="mt-3 pt-3 border-t border-border/30 flex items-center justify-between">
                    <span className="text-[10px] text-muted-foreground">Score medio accessibilità</span>
                    <span className={`text-sm font-bold ${poiAccessScore >= 60 ? "text-emerald-400" : "text-orange-400"}`}>{poiAccessScore}%</span>
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* Coverage quality cards */}
            <Card className="bg-card/60 backdrop-blur border-border/50">
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <Layers className="w-4 h-4 text-cyan-400" /> Qualità copertura per tipo di territorio
                </CardTitle>
                <CardDescription className="text-xs">Distanza media dalla fermata, per classe di densità abitativa</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                  {[...data.densityCoverage].sort((a, b) => {
                    const order = ["Alta densità", "Urbano", "Periurbano", "Rurale"];
                    return order.indexOf(a.band) - order.indexOf(b.band);
                  }).map((c, i) => {
                    const isGood = c.avgNearestM < 300;
                    const isMedium = c.avgNearestM < 600;
                    return (
                      <motion.div key={c.band} initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.1 }}
                        className={`p-4 rounded-xl border text-center space-y-2 ${
                          isGood ? "bg-emerald-500/5 border-emerald-500/20" : isMedium ? "bg-yellow-500/5 border-yellow-500/20" : "bg-red-500/5 border-red-500/20"
                        }`}>
                        <p className="text-xs font-semibold">{c.band}</p>
                        <p className={`text-3xl font-bold font-mono ${isGood ? "text-emerald-400" : isMedium ? "text-yellow-400" : "text-red-400"}`}>
                          {c.avgNearestM >= 1000 ? `${(c.avgNearestM / 1000).toFixed(1)} km` : `${c.avgNearestM} m`}
                        </p>
                        <p className="text-[10px] text-muted-foreground">{c.sectionCount} sezioni</p>
                        <div className={`inline-block text-[10px] font-semibold px-2 py-0.5 rounded-full border ${
                          isGood ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30" :
                          isMedium ? "bg-yellow-500/15 text-yellow-400 border-yellow-500/30" :
                          "bg-red-500/15 text-red-400 border-red-500/30"
                        }`}>
                          {isGood ? "✓ Ottima" : isMedium ? "~ Sufficiente" : "✗ Insufficiente"}
                        </div>
                      </motion.div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          </motion.div>
        )}

        {/* ──── TAB: GAP & OPPORTUNITÀ ──── */}
        {activeTab === "gap" && deep && (
          <motion.div key="gap" initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 20 }} className="space-y-6">

            {/* Scatter */}
            <Card className="bg-card/60 backdrop-blur border-border/50">
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <Target className="w-4 h-4 text-red-400" /> Mappa priorità: Densità vs Distanza dalla fermata
                </CardTitle>
                <CardDescription className="text-xs">
                  Ogni bolla è una sezione censuaria. In <strong>alto a destra</strong> = zone{" "}
                  <span className="text-red-400 font-semibold">critiche</span> (alta densità, lontane dalle fermate).
                  Dimensione bolla = popolazione.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="h-[380px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <ScatterChart margin={{ top: 20, right: 20, bottom: 20, left: 10 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                      <XAxis type="number" dataKey="distance" name="Distanza"
                        stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false}
                        label={{ value: "Distanza fermata (m)", position: "bottom", offset: 0, fontSize: 11, fill: "hsl(var(--muted-foreground))" }} />
                      <YAxis type="number" dataKey="density" name="Densità"
                        stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false}
                        label={{ value: "Densità (ab/km²)", angle: -90, position: "insideLeft", offset: 10, fontSize: 11, fill: "hsl(var(--muted-foreground))" }} />
                      <ZAxis type="number" dataKey="population" range={[30, 300]} name="Popolazione" />
                      <Tooltip content={<ScatterTooltip />} />
                      <Scatter data={deep.densityVsDistance} animationDuration={800}>
                        {deep.densityVsDistance.map((d, i) => (
                          <Cell key={i}
                            fill={d.density > 1500 && d.distance > 400 ? "#ef4444" : d.density > 500 && d.distance > 600 ? "#f97316" : "#3b82f6"}
                            fillOpacity={d.density > 1500 && d.distance > 400 ? 0.8 : d.density > 500 && d.distance > 600 ? 0.6 : 0.3} />
                        ))}
                      </Scatter>
                    </ScatterChart>
                  </ResponsiveContainer>
                </div>
                <div className="mt-3 flex flex-wrap gap-4 justify-center text-[10px] text-muted-foreground">
                  <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-full bg-red-500/80" /> Critico</span>
                  <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-full bg-orange-500/60" /> Attenzione</span>
                  <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-full bg-blue-500/30" /> Adeguato</span>
                </div>
              </CardContent>
            </Card>

            {/* Gap table */}
            <Card className="bg-card/60 backdrop-blur border-border/50">
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 text-orange-400" /> Zone prioritarie: dove mancano le fermate
                </CardTitle>
                <CardDescription className="text-xs">
                  {deep.gapAnalysis.length} aree con popolazione significativa ma lontane dalla fermata (&gt;400 m).
                  Gap Score = popolazione × distanza.
                </CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border/40 text-muted-foreground text-xs">
                        <th className="px-4 py-2 text-left">Priorità</th>
                        <th className="px-4 py-2 text-right">Abitanti</th>
                        <th className="px-4 py-2 text-right">Densità</th>
                        <th className="px-4 py-2 text-right">Dist. fermata</th>
                        <th className="px-4 py-2 text-right">POI vicini</th>
                        <th className="px-4 py-2 text-right">Gap Score</th>
                      </tr>
                    </thead>
                    <tbody>
                      {deep.gapAnalysis.slice(0, 10).map((g, i) => (
                        <tr key={i} className="border-b border-border/20 hover:bg-white/[0.02] transition-colors">
                          <td className="px-4 py-2.5">
                            <span className="mr-1">{g.gapScore > 5000 ? "🔴" : g.gapScore > 2000 ? "🟠" : "🟡"}</span>
                            <span className="text-xs text-muted-foreground">#{i + 1}</span>
                          </td>
                          <td className="px-4 py-2.5 text-right font-semibold font-mono">{g.population.toLocaleString("it-IT")}</td>
                          <td className="px-4 py-2.5 text-right text-muted-foreground font-mono">{Math.round(g.density).toLocaleString("it-IT")}</td>
                          <td className="px-4 py-2.5 text-right font-mono text-red-400">
                            {g.nearestM >= 1000 ? `${(g.nearestM / 1000).toFixed(1)} km` : `${g.nearestM} m`}
                          </td>
                          <td className="px-4 py-2.5 text-right text-muted-foreground">{g.poiCount}</td>
                          <td className="px-4 py-2.5 text-right">
                            <span className={`font-bold font-mono ${g.gapScore > 5000 ? "text-red-400" : g.gapScore > 2000 ? "text-orange-400" : "text-yellow-400"}`}>
                              {g.gapScore.toLocaleString("it-IT")}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>

            {/* Summary cards */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0 }}>
                <Card className="bg-red-500/5 border-red-500/20 p-5 text-center space-y-2">
                  <AlertTriangle className="w-6 h-6 mx-auto text-red-400" />
                  <p className="text-2xl font-bold font-mono text-red-400">{totalGapPop.toLocaleString("it-IT")}</p>
                  <p className="text-xs text-muted-foreground">Abitanti in zone scoperte (&gt;400 m)</p>
                  <p className="text-[10px] text-red-400/60">{(totalGapPop / data.stats.totalPop * 100).toFixed(1)}% della popolazione</p>
                </Card>
              </motion.div>
              <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}>
                <Card className="bg-emerald-500/5 border-emerald-500/20 p-5 text-center space-y-2">
                  <CheckCircle2 className="w-6 h-6 mx-auto text-emerald-400" />
                  <p className="text-2xl font-bold font-mono text-emerald-400">{popServed500m}%</p>
                  <p className="text-xs text-muted-foreground">Copertura entro 500 m</p>
                  <p className="text-[10px] text-emerald-400/60">{popServed500m >= 80 ? "✓ Supera lo standard europeo" : "⚠ Sotto lo standard 80%"}</p>
                </Card>
              </motion.div>
              <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }}>
                <Card className="bg-violet-500/5 border-violet-500/20 p-5 text-center space-y-2">
                  <Zap className="w-6 h-6 mx-auto text-violet-400" />
                  <p className="text-2xl font-bold font-mono text-violet-400">{poiAccessScore}%</p>
                  <p className="text-xs text-muted-foreground">POI raggiungibili in &lt;400 m</p>
                  <p className="text-[10px] text-violet-400/60">{poiAccessScore >= 60 ? "Buona accessibilità" : "Margini di miglioramento"}</p>
                </Card>
              </motion.div>
            </div>

            {/* Raccomandazioni */}

            {/* ═══════════ AREE SOTTSERVITE (API) ═══════════ */}
            {underservedAreas.length > 0 && (
              <Card className="bg-card/60 backdrop-blur border-border/50">
                <CardHeader>
                  <CardTitle className="text-base flex items-center gap-2">
                    <Navigation className="w-4 h-4 text-red-400" /> Aree sottservite — Suggerimenti nuove fermate
                  </CardTitle>
                  <CardDescription className="text-xs">
                    {underservedAreas.length} celle con punteggio ≥ 3 dove il servizio è insufficiente.
                    Per ciascuna, un punto suggerito dove posizionare una nuova fermata.
                  </CardDescription>
                </CardHeader>
                <CardContent className="p-0">
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-border/40 text-muted-foreground text-[10px] uppercase tracking-wide">
                          <th className="text-left px-4 py-2">#</th>
                          <th className="text-right px-4 py-2">Score</th>
                          <th className="text-right px-4 py-2">Popolazione</th>
                          <th className="text-right px-4 py-2">Dist. fermata</th>
                          <th className="text-right px-4 py-2">POI vicini</th>
                          <th className="text-left px-4 py-2">Categorie POI</th>
                          <th className="text-right px-4 py-2">Coord. suggerita</th>
                        </tr>
                      </thead>
                      <tbody>
                        {underservedAreas.slice(0, 15).map((area, i) => (
                          <tr
                            key={area.cellId ?? i}
                            data-virgilio-id={area.cellId ? `zone:${area.cellId}` : undefined}
                            className="border-b border-border/20 hover:bg-white/[0.02] transition-colors scroll-mt-24"
                          >
                            <td className="px-4 py-2">
                              <span className="mr-1">
                                {(area.score ?? 0) >= 7 ? "🔴" : (area.score ?? 0) >= 5 ? "🟠" : "🟡"}
                              </span>
                              <span className="text-[10px] text-muted-foreground">#{i + 1}</span>
                            </td>
                            <td className="px-4 py-2 text-right">
                              <span className={`font-bold font-mono ${(area.score ?? 0) >= 7 ? "text-red-400" : (area.score ?? 0) >= 5 ? "text-orange-400" : "text-yellow-400"}`}>
                                {(area.score ?? 0).toFixed(1)}
                              </span>
                            </td>
                            <td className="px-4 py-2 text-right font-mono">{(area.populationAffected ?? 0).toLocaleString("it-IT")}</td>
                            <td className="px-4 py-2 text-right font-mono text-red-400">
                              {(area.nearestStopDistanceMeters ?? 0) >= 1000
                                ? `${((area.nearestStopDistanceMeters ?? 0) / 1000).toFixed(1)} km`
                                : `${Math.round(area.nearestStopDistanceMeters ?? 0)} m`}
                            </td>
                            <td className="px-4 py-2 text-right text-muted-foreground">{(area.topPoiCategories ?? []).length}</td>
                            <td className="px-4 py-2">
                              <div className="flex gap-1 flex-wrap">
                                {(area.topPoiCategories ?? []).slice(0, 3).map((cat) => (
                                  <span key={cat} className="text-[9px] px-1.5 py-0.5 rounded-full bg-muted/60 border border-border/40 text-muted-foreground">{cat}</span>
                                ))}
                              </div>
                            </td>
                            <td className="px-4 py-2 text-right">
                              {area.suggestedStopLat && area.suggestedStopLng ? (
                                <a href={`https://www.google.com/maps?q=${area.suggestedStopLat},${area.suggestedStopLng}`}
                                  target="_blank" rel="noopener noreferrer"
                                  className="text-[10px] text-primary hover:underline font-mono">
                                  📍 {(area.suggestedStopLat ?? 0).toFixed(4)}, {(area.suggestedStopLng ?? 0).toFixed(4)}
                                </a>
                              ) : (
                                <span className="text-[10px] text-muted-foreground/40">—</span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {underservedAreas.length > 15 && (
                    <p className="text-[10px] text-muted-foreground/60 px-4 py-2">
                      + altre {underservedAreas.length - 15} aree sottservite
                    </p>
                  )}
                </CardContent>
              </Card>
            )}

            <Card className="bg-gradient-to-r from-orange-500/5 to-red-500/5 border-orange-500/20">
              <CardContent className="pt-5 pb-5 space-y-3">
                <div className="flex items-center gap-2">
                  <Zap className="w-5 h-5 text-orange-400" />
                  <p className="font-semibold text-foreground">Raccomandazioni operative</p>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm text-muted-foreground">
                  <div className="flex items-start gap-2">
                    <ArrowRight className="w-4 h-4 text-orange-400 shrink-0 mt-0.5" />
                    <span>Valutare <strong>nuove fermate</strong> nelle {deep.gapAnalysis.filter(g => g.gapScore > 3000).length} zone a gap score elevato</span>
                  </div>
                  <div className="flex items-start gap-2">
                    <ArrowRight className="w-4 h-4 text-orange-400 shrink-0 mt-0.5" />
                    <span>Attivare <strong>servizi a chiamata</strong> per le {deep.populationPyramid?.find(p => p.classe === "Rurale")?.sections ?? 0} sezioni rurali</span>
                  </div>
                  <div className="flex items-start gap-2">
                    <ArrowRight className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                    <span>Ottimizzare <strong>frequenza</strong> nelle aree Centro città ({deep.populationPyramid?.find(p => p.classe === "Centro città")?.population.toLocaleString("it-IT")} ab.)</span>
                  </div>
                  <div className="flex items-start gap-2">
                    <ArrowRight className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                    <span>Collegare i <strong>{deep.poiCoverage.reduce((s, p) => s + p.farFromStop, 0)} POI</strong> attualmente non serviti dalla rete</span>
                  </div>
                </div>
              </CardContent>
            </Card>
          </motion.div>
        )}

        {/* ═══════ QUALITÀ SERVIZIO (lazy-loaded) ═══════ */}
        {activeTab === "qualita" && (
          <motion.div key="qualita" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }} transition={{ duration: 0.3 }}>
            <Suspense fallback={
              <div className="flex items-center justify-center py-24">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
              </div>
            }>
              <DemandContent />
            </Suspense>
          </motion.div>
        )}

        {/* ═══════ SEGMENTI UTENZA (lazy-loaded) ═══════ */}
        {activeTab === "segmenti" && (
          <motion.div key="segmenti" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }} transition={{ duration: 0.3 }}>
            <Suspense fallback={
              <div className="flex items-center justify-center py-24">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
              </div>
            }>
              <SegmentsContent />
            </Suspense>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ═══════ FOOTER ═══════ */}
      <div className="rounded-xl border border-border/30 bg-muted/10 px-4 py-3 text-[11px] text-muted-foreground/70 space-y-1">
        <p className="font-semibold text-muted-foreground/90">Fonti e metodologia</p>
        <p>
          Dati censuari: <strong>ISTAT Censimento 2021</strong> · Sezioni censuarie con popolazione, area e densità.
          POI: <strong>OpenStreetMap</strong>. Fermate: <strong>GTFS Conerobus/Adriabus</strong>.
          Distanze calcolate dal centroide della sezione censuaria alla fermata più vicina (euclidea).
          Standard copertura: <strong>UITP</strong> (Union Internationale des Transports Publics).
        </p>
      </div>
    </div>
  );
}
