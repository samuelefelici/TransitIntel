import React, { useState, useCallback, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Upload, FileArchive, Trash2, Bus, MapPin, Route,
  CheckCircle2, AlertCircle, Loader2, ChevronDown, ChevronRight,
  BarChart3, Calendar, Building2, Shapes, Star, TrendingUp,
  TrendingDown, Users, AlertTriangle, ShieldCheck, Clock, Zap
} from "lucide-react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  RadialBarChart, RadialBar, Cell, PieChart, Pie, Legend
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { getApiBase } from "@/lib/api";
import PlanningAnalysisTab from "@/components/planning/PlanningAnalysisTab";

interface GtfsFeed {
  id: string; filename: string; agencyName: string | null;
  feedStartDate: string | null; feedEndDate: string | null;
  stopsCount: number; routesCount: number; tripsCount: number;
  shapesCount: number; uploadedAt: string;
}

interface Analysis {
  overallScore: number;
  summary: {
    totalStops: number; totalRoutes: number; avgDailyTrips: number;
    avgMorningPeak: number; avgEveningPeak: number; avgServiceScore: number;
    stopsWithService: number; stopsNoService: number;
  };
  frequency: {
    distribution: { label: string; count: number }[];
    avgDailyTrips: number; avgMorningPeak: number; avgEveningPeak: number;
  };
  routeRanking: {
    routeId: string; shortName: string; longName: string;
    color: string; tripsCount: number; frequencyScore: number;
  }[];
  poiCoverage: {
    totalPoi: number; coveredPoi: number; uncoveredPoi: number;
    coveragePercent: number;
    byCategory: { category: string; total: number; covered: number; pct: number }[];
    uncoveredSample: { name: string | null; category: string; lat: number; lng: number }[];
  };
  populationCoverage: { totalPopulation: number; coveredPopulation: number; coveragePercent: number };
  trafficAlignment: { poorAlignmentCount: number };
  worstServed: {
    stopId: string; stopName: string; dailyTrips: number;
    morningPeak: number; eveningPeak: number; serviceScore: number;
    nearbyPopulation: number; nearbyPoiCount: number; demandScore: number; gap: number;
  }[];
}

const SCORE_COLOR = (s: number) =>
  s >= 70 ? "#22c55e" : s >= 45 ? "#eab308" : "#ef4444";

const SCORE_LABEL = (s: number) =>
  s >= 70 ? "Buono" : s >= 45 ? "Sufficiente" : "Scarso";

const ROUTE_TYPE_LABEL: Record<number, string> = {
  0: "Tram", 1: "Metro", 2: "Ferrovia", 3: "Bus", 4: "Traghetto",
};

const CAT_LABEL: Record<string, string> = {
  school: "Scuole", hospital: "Ospedali", shopping: "Commercio",
  industrial: "Industria", leisure: "Sport/Svago", office: "Uffici", transit: "Hub trasporti",
  workplace: "Aziende", worship: "Culto", elderly: "RSA", parking: "Parcheggi", tourism: "Cultura",
};

function ScoreGauge({ score }: { score: number }) {
  const color = SCORE_COLOR(score);
  const label = SCORE_LABEL(score);
  const data = [{ value: score, fill: color }, { value: 100 - score, fill: "transparent" }];

  return (
    <div className="flex flex-col items-center justify-center">
      <div className="relative w-40 h-40">
        <RadialBarChart
          width={160} height={160}
          innerRadius={50} outerRadius={75}
          startAngle={220} endAngle={-40}
          data={[{ value: score, fill: color }]}
        >
          <RadialBar dataKey="value" cornerRadius={6} background={{ fill: "rgba(255,255,255,0.05)" }} />
        </RadialBarChart>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-3xl font-bold" style={{ color }}>{score}</span>
          <span className="text-xs text-muted-foreground">/ 100</span>
        </div>
      </div>
      <Badge
        className="mt-2 text-sm font-semibold border-0"
        style={{ backgroundColor: `${color}25`, color }}
      >
        {label}
      </Badge>
      <p className="text-xs text-muted-foreground mt-1">Punteggio qualità servizio</p>
    </div>
  );
}

function MiniStat({ icon: Icon, label, value, sub, color = "text-primary" }: {
  icon: React.ElementType; label: string; value: string | number; sub?: string; color?: string;
}) {
  return (
    <Card className="bg-card/50 border-border/40">
      <CardContent className="p-4 flex items-center gap-3">
        <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
          <Icon className={`w-4 h-4 ${color}`} />
        </div>
        <div>
          <p className="text-xs text-muted-foreground">{label}</p>
          <p className="text-lg font-bold text-foreground">{typeof value === "number" ? value.toLocaleString() : value}</p>
          {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
        </div>
      </CardContent>
    </Card>
  );
}

const CustomTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-card border border-border rounded-lg p-2 text-xs shadow-xl">
      <p className="font-semibold text-foreground mb-1">{label}</p>
      {payload.map((p: any, i: number) => (
        <p key={i} style={{ color: p.color || p.fill }}>
          {p.name}: {p.value}
        </p>
      ))}
    </div>
  );
};

function AnalysisTab({ feedId }: { feedId: string | null }) {
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!feedId) return;
    setLoading(true);
    setError(null);
    fetch(`${getApiBase()}/api/gtfs/analysis?feedId=${feedId}`)
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(d => {
        if (d.noData) { setError(d.message); }
        else setAnalysis(d);
      })
      .catch((err) => {
        console.error("[GTFS] analysis failed:", err);
        setError("Errore durante il caricamento dell'analisi");
      })
      .finally(() => setLoading(false));
  }, [feedId]);

  if (!feedId) {
    return (
      <div className="py-12 text-center">
        <BarChart3 className="w-10 h-10 text-muted-foreground/40 mx-auto mb-3" />
        <p className="text-muted-foreground">Seleziona un feed dalla lista per avviare l'analisi.</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="py-12 flex items-center justify-center gap-3 text-muted-foreground">
        <Loader2 className="w-5 h-5 animate-spin" />
        <span>Analisi del servizio in corso…</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="py-8 flex items-start gap-3 text-destructive bg-destructive/10 rounded-xl p-4">
        <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
        <p className="text-sm">{error}</p>
      </div>
    );
  }

  if (!analysis) return null;

  const { overallScore, summary, frequency, routeRanking, poiCoverage, populationCoverage, worstServed } = analysis;
  const noTripData = summary.stopsWithService === 0 && summary.totalStops > 0;

  const peakData = [
    { time: "Mattina (7–9h)", corse: Math.round(summary.avgMorningPeak * 10) / 10, fill: "#3b82f6" },
    { time: "Sera (17–19h)", corse: Math.round(summary.avgEveningPeak * 10) / 10, fill: "#8b5cf6" },
    { time: "Media giornaliera", corse: Math.round(summary.avgDailyTrips * 10) / 10, fill: "#22c55e" },
  ];

  const poiChartData = poiCoverage.byCategory.map(c => ({
    name: CAT_LABEL[c.category] || c.category,
    coperta: c.covered,
    nonCoperta: c.total - c.covered,
    pct: c.pct,
  }));

  return (
    <div className="space-y-8">
      {/* No trip data warning */}
      {noTripData && (
        <motion.div
          initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }}
          className="flex items-start gap-3 p-4 rounded-xl border bg-amber-500/10 border-amber-500/30 text-amber-400"
        >
          <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-semibold">Dati di servizio non disponibili</p>
            <p className="text-xs mt-1 text-amber-400/80">
              Questo feed è stato importato senza analisi degli orari (<code className="font-mono">stop_times.txt</code>).
              Per ottenere l'analisi completa (corse per fermata, ore di punta, gap domanda-servizio),
              <strong className="text-amber-400"> elimina il feed e caricalo nuovamente</strong> con il sistema aggiornato.
              Sono comunque disponibili: copertura POI, copertura popolazione e ranking linee.
            </p>
          </div>
        </motion.div>
      )}

      {/* Score + Summary */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 items-start">
        <Card className="bg-card/60 border-border/40">
          <CardContent className="pt-6 pb-4 flex flex-col items-center">
            <ScoreGauge score={overallScore} />
          </CardContent>
        </Card>
        <div className="md:col-span-2 grid grid-cols-2 gap-3">
          <MiniStat icon={MapPin} label="Fermate totali" value={summary.totalStops} color="text-blue-400" />
          <MiniStat icon={Route} label="Linee totali" value={summary.totalRoutes} color="text-violet-400" />
          <MiniStat icon={Clock} label="Media corse/fermata" value={`${summary.avgDailyTrips}`} sub="corse al giorno" color="text-green-400" />
          <MiniStat icon={Zap} label="Corse mattina (7–9h)" value={`${summary.avgMorningPeak}`} sub="media per fermata" color="text-amber-400" />
          <MiniStat icon={Users} label="Popolazione coperta" value={`${populationCoverage.coveragePercent}%`} sub={`${populationCoverage.coveredPopulation.toLocaleString()} ab.`} color="text-cyan-400" />
          <MiniStat icon={ShieldCheck} label="POI con fermata" value={`${poiCoverage.coveragePercent}%`} sub={`${poiCoverage.coveredPoi}/${poiCoverage.totalPoi}`} color="text-emerald-400" />
        </div>
      </div>

      {/* Peak hours */}
      <Card className="bg-card/60 border-border/40">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Clock className="w-4 h-4 text-primary" />
            Corse medie per fascia oraria
            <span className="text-xs font-normal text-muted-foreground ml-1">(media per fermata)</span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-end gap-4 mb-4">
            {peakData.map(p => (
              <div key={p.time} className="flex-1 text-center">
                <div className="text-2xl font-bold" style={{ color: p.fill }}>{p.corse}</div>
                <div className="text-xs text-muted-foreground mt-1">{p.time}</div>
                <div
                  className="h-1.5 rounded-full mt-2 mx-auto"
                  style={{ backgroundColor: p.fill, width: `${Math.min(p.corse * 5, 100)}%`, minWidth: 8 }}
                />
              </div>
            ))}
          </div>
          <div className="text-xs text-muted-foreground border-t border-border/40 pt-3">
            Soglia buon servizio: ≥6 corse/ora in fascia di punta (1 corsa ogni 10 min)
          </div>
        </CardContent>
      </Card>

      {/* Frequency distribution */}
      <Card className="bg-card/60 border-border/40">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <BarChart3 className="w-4 h-4 text-primary" />
            Distribuzione frequenza fermate (corse/giorno)
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={frequency.distribution} barSize={32}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#9ca3af" }} />
              <YAxis tick={{ fontSize: 11, fill: "#9ca3af" }} />
              <Tooltip content={<CustomTooltip />} />
              <Bar dataKey="count" name="Fermate" radius={[4, 4, 0, 0]}>
                {frequency.distribution.map((_, i) => (
                  <Cell key={i} fill={
                    i === 0 ? "#ef4444" : i <= 2 ? "#eab308" : "#22c55e"
                  } />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
          {summary.stopsNoService > 0 && (
            <div className="mt-2 flex items-center gap-2 text-xs text-amber-400 bg-amber-400/10 rounded-lg px-3 py-2">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
              {summary.stopsNoService} fermate senza corse registrate negli orari (stop senza servizio attivo)
            </div>
          )}
        </CardContent>
      </Card>

      {/* Route ranking */}
      <Card className="bg-card/60 border-border/40">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <TrendingUp className="w-4 h-4 text-primary" />
            Ranking linee per frequenza (top 20)
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
            {routeRanking.map((r, i) => (
              <div key={r.routeId} className="flex items-center gap-3">
                <span className="text-xs text-muted-foreground w-5 shrink-0">{i + 1}</span>
                <div
                  className="w-9 h-7 rounded-md flex items-center justify-center text-xs font-bold shrink-0"
                  style={{
                    backgroundColor: r.color ? `${r.color}30` : "rgba(59,130,246,0.15)",
                    color: r.color || "#3b82f6",
                    border: `1px solid ${r.color || "#3b82f6"}50`,
                  }}
                >
                  {r.shortName.slice(0, 4)}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-foreground truncate">{r.longName || r.shortName}</p>
                  <div className="flex items-center gap-2 mt-0.5">
                    <div className="flex-1 h-1.5 bg-white/5 rounded-full overflow-hidden">
                      <div
                        className="h-full rounded-full"
                        style={{
                          width: `${r.frequencyScore}%`,
                          backgroundColor: SCORE_COLOR(r.frequencyScore),
                        }}
                      />
                    </div>
                    <span className="text-xs text-muted-foreground shrink-0">{r.tripsCount} corse</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* POI coverage */}
      <Card className="bg-card/60 border-border/40">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Building2 className="w-4 h-4 text-primary" />
            Copertura Punti di Interesse (raggio 500m)
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-4">
            <div className="flex-1">
              <div className="flex justify-between text-xs mb-1">
                <span className="text-muted-foreground">POI serviti</span>
                <span className="font-semibold" style={{ color: SCORE_COLOR(poiCoverage.coveragePercent) }}>
                  {poiCoverage.coveragePercent}%
                </span>
              </div>
              <div className="h-2 bg-white/5 rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full transition-all"
                  style={{
                    width: `${poiCoverage.coveragePercent}%`,
                    backgroundColor: SCORE_COLOR(poiCoverage.coveragePercent),
                  }}
                />
              </div>
            </div>
            <div className="text-right shrink-0">
              <p className="text-lg font-bold text-foreground">{poiCoverage.coveredPoi}<span className="text-muted-foreground text-sm">/{poiCoverage.totalPoi}</span></p>
              <p className="text-xs text-muted-foreground">POI coperti</p>
            </div>
          </div>

          <div className="space-y-2">
            {poiCoverage.byCategory.map(cat => (
              <div key={cat.category} className="flex items-center gap-3">
                <span className="text-xs text-muted-foreground w-24 shrink-0">{CAT_LABEL[cat.category] || cat.category}</span>
                <div className="flex-1 h-1.5 bg-white/5 rounded-full overflow-hidden">
                  <div
                    className="h-full rounded-full"
                    style={{ width: `${cat.pct}%`, backgroundColor: SCORE_COLOR(cat.pct) }}
                  />
                </div>
                <span className="text-xs text-muted-foreground shrink-0 w-16 text-right">
                  {cat.covered}/{cat.total} ({cat.pct}%)
                </span>
              </div>
            ))}
          </div>

          {poiCoverage.uncoveredSample.length > 0 && (
            <div className="border-t border-border/40 pt-3">
              <p className="text-xs font-semibold text-destructive flex items-center gap-1 mb-2">
                <AlertTriangle className="w-3 h-3" />
                POI non serviti (campione)
              </p>
              <div className="space-y-1">
                {poiCoverage.uncoveredSample.slice(0, 5).map((p, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Badge variant="outline" className="text-xs px-1.5 py-0">
                      {CAT_LABEL[p.category] || p.category}
                    </Badge>
                    <span>{p.name || "N/D"}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Worst served stops */}
      {worstServed.length > 0 && (
        <Card className="bg-card/60 border-border/40">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <TrendingDown className="w-4 h-4 text-destructive" />
              Fermate con maggior gap domanda–servizio
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground mb-3">
              Fermate con alta domanda (popolazione + POI vicini) ma bassa frequenza di servizio. Sono le priorità di miglioramento.
            </p>
            <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
              {worstServed.map((s, i) => (
                <div key={s.stopId} className="p-3 rounded-xl bg-white/[0.03] border border-border/30 hover:border-border/60 transition-colors">
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-foreground truncate">{s.stopName}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">ID: {s.stopId}</p>
                    </div>
                    <Badge
                      className="shrink-0 text-xs border-0"
                      style={{ backgroundColor: `${SCORE_COLOR(s.serviceScore)}20`, color: SCORE_COLOR(s.serviceScore) }}
                    >
                      Punt. {Math.round(s.serviceScore)}
                    </Badge>
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-xs">
                    <div className="text-center bg-white/5 rounded-lg p-2">
                      <p className="text-muted-foreground">Corse/giorno</p>
                      <p className="font-semibold text-foreground">{s.dailyTrips}</p>
                    </div>
                    <div className="text-center bg-white/5 rounded-lg p-2">
                      <p className="text-muted-foreground">Punta mattina</p>
                      <p className={`font-semibold ${s.morningPeak < 3 ? "text-destructive" : "text-foreground"}`}>{s.morningPeak}</p>
                    </div>
                    <div className="text-center bg-white/5 rounded-lg p-2">
                      <p className="text-muted-foreground">POI vicini</p>
                      <p className="font-semibold text-foreground">{s.nearbyPoiCount}</p>
                    </div>
                  </div>
                  <div className="mt-2 flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">Gap domanda–servizio:</span>
                    <div className="flex-1 h-1 bg-white/5 rounded-full">
                      <div
                        className="h-full rounded-full bg-destructive"
                        style={{ width: `${Math.min(s.gap / 20 * 100, 100)}%` }}
                      />
                    </div>
                    <span className="text-xs text-destructive font-semibold">{s.gap.toFixed(1)}</span>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function FeedCard({
  feed, onDelete, isSelected, onSelect
}: {
  feed: GtfsFeed; onDelete: (id: string) => void;
  isSelected: boolean; onSelect: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [routes, setRoutes] = useState<any[]>([]);
  const [loadingRoutes, setLoadingRoutes] = useState(false);

  const handleExpand = async () => {
    setExpanded(e => !e);
    if (!expanded && routes.length === 0) {
      setLoadingRoutes(true);
      try {
        const resp = await fetch(`${getApiBase()}/api/gtfs/routes?feedId=${feed.id}`);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        setRoutes(data.data || []);
      } catch (err) {
        console.error("[GTFS] loadRoutes failed:", err);
      }
      finally { setLoadingRoutes(false); }
    }
  };

  return (
    <Card className={`bg-card/60 border-border/40 overflow-hidden transition-all ${isSelected ? "ring-2 ring-primary/50" : ""}`}>
      <CardContent className="p-0">
        <div className="p-4 flex items-start gap-4">
          <div className="w-10 h-10 rounded-xl bg-blue-500/10 flex items-center justify-center shrink-0 mt-0.5">
            <FileArchive className="w-5 h-5 text-blue-400" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-start justify-between gap-2">
              <div>
                <h3 className="font-semibold text-foreground truncate">{feed.filename}</h3>
                {feed.agencyName && (
                  <p className="text-sm text-muted-foreground flex items-center gap-1 mt-0.5">
                    <Building2 className="w-3 h-3" /> {feed.agencyName}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <Button
                  variant={isSelected ? "secondary" : "ghost"}
                  size="sm"
                  className="h-8 text-xs gap-1"
                  onClick={() => onSelect(feed.id)}
                >
                  <BarChart3 className="w-3 h-3" />
                  {isSelected ? "Analisi attiva" : "Analizza"}
                </Button>
                <Button
                  variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive"
                  onClick={() => onDelete(feed.id)}
                >
                  <Trash2 className="w-4 h-4" />
                </Button>
              </div>
            </div>
            <div className="flex flex-wrap gap-2 mt-3">
              <Badge variant="secondary" className="gap-1 text-xs">
                <MapPin className="w-3 h-3" /> {feed.stopsCount.toLocaleString()} fermate
              </Badge>
              <Badge variant="secondary" className="gap-1 text-xs">
                <Route className="w-3 h-3" /> {feed.routesCount} linee
              </Badge>
              <Badge variant="secondary" className="gap-1 text-xs">
                <Bus className="w-3 h-3" /> {feed.tripsCount.toLocaleString()} corse
              </Badge>
            </div>
            {(feed.feedStartDate || feed.feedEndDate) && (
              <p className="text-xs text-muted-foreground flex items-center gap-1 mt-2">
                <Calendar className="w-3 h-3" />
                {feed.feedStartDate} → {feed.feedEndDate}
              </p>
            )}
            <Button
              variant="ghost" size="sm"
              className="mt-2 h-7 px-2 text-xs text-muted-foreground hover:text-foreground gap-1"
              onClick={handleExpand}
            >
              {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
              {expanded ? "Nascondi linee" : "Mostra linee"}
            </Button>
          </div>
        </div>

        <AnimatePresence>
          {expanded && (
            <motion.div
              initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2 }}
              className="overflow-hidden border-t border-border/40"
            >
              <div className="p-4">
                {loadingRoutes ? (
                  <div className="flex items-center gap-2 text-muted-foreground text-sm py-2">
                    <Loader2 className="w-4 h-4 animate-spin" /> Caricamento…
                  </div>
                ) : routes.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-2">Nessuna linea trovata.</p>
                ) : (
                  <div className="space-y-1.5 max-h-56 overflow-y-auto pr-1">
                    {routes.map(r => (
                      <div key={r.id} className="flex items-center gap-3 py-1 border-b border-border/20 last:border-0">
                        <div
                          className="w-8 h-7 rounded-md flex items-center justify-center text-xs font-bold shrink-0"
                          style={{
                            backgroundColor: r.routeColor ? `${r.routeColor}30` : "rgba(59,130,246,0.15)",
                            color: r.routeColor || "#3b82f6",
                            border: `1px solid ${r.routeColor || "#3b82f6"}50`,
                          }}
                        >
                          {(r.routeShortName || r.routeId).slice(0, 4)}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-medium text-foreground truncate">
                            {r.routeLongName || r.routeShortName || r.routeId}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {ROUTE_TYPE_LABEL[r.routeType] || "Bus"} · {r.tripsCount} corse
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </CardContent>
    </Card>
  );
}

export default function GtfsPage() {
  const [feeds, setFeeds] = useState<GtfsFeed[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState<{ success: boolean; message: string } | null>(null);
  const [selectedFeed, setSelectedFeed] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"upload" | "analysis" | "planning">("upload");
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadFeeds = useCallback(async () => {
    setLoading(true);
    try {
      const resp = await fetch(`${getApiBase()}/api/gtfs/feeds`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      const f = data.data || [];
      setFeeds(f);
      if (f.length > 0 && !selectedFeed) setSelectedFeed(f[0].id);
    } catch (err) {
      console.error("[GTFS] loadFeeds failed:", err);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { loadFeeds(); }, [loadFeeds]);

  const handleUpload = async (file: File) => {
    if (!file.name.endsWith(".zip")) {
      setUploadResult({ success: false, message: "Seleziona un file GTFS in formato .zip" });
      return;
    }
    setUploading(true);
    setUploadResult(null);
    const form = new FormData();
    form.append("file", file);
    try {
      let resp: Response;
      try {
        resp = await fetch(`${getApiBase()}/api/gtfs/upload`, { method: "POST", body: form });
      } catch (networkErr) {
        // fetch itself threw — network error, backend unreachable, proxy down
        throw new Error("Impossibile raggiungere il server. Verifica che il backend sia in esecuzione.");
      }
      let data: any;
      const contentType = resp.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        data = await resp.json();
      } else {
        // Server returned non-JSON (proxy error page, HTML error, etc.)
        const text = await resp.text();
        console.error("[GTFS] non-JSON response:", resp.status, text.slice(0, 500));
        throw new Error(
          resp.status === 504 || resp.status === 502
            ? "Il server non ha risposto in tempo. Il file potrebbe essere troppo grande, riprova."
            : `Errore del server (HTTP ${resp.status}). Verifica che il backend sia avviato.`
        );
      }
      if (resp.ok && data.success) {
        setUploadResult({
          success: true,
          message: `Importate ${(data.stopsImported ?? 0).toLocaleString()} fermate, ${data.routesImported ?? 0} linee, ${(data.tripsImported ?? data.tripsCount ?? 0).toLocaleString()} corse, ${(data.stopTimesImported ?? data.stopTimesProcessed ?? 0).toLocaleString()} orari${data.agencyName ? ` — ${data.agencyName}` : ""}`,
        });
        await loadFeeds();
        setActiveTab("analysis");
      } else {
        setUploadResult({ success: false, message: data.error || `Errore HTTP ${resp.status}` });
      }
    } catch (err) {
      console.error("[GTFS] upload failed:", err);
      setUploadResult({ success: false, message: err instanceof Error ? err.message : "Errore di rete durante il caricamento" });
    } finally {
      setUploading(false);
    }
  };

  const handleDelete = async (feedId: string) => {
    try {
      const resp = await fetch(`${getApiBase()}/api/gtfs/feeds/${feedId}`, { method: "DELETE" });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    } catch (err) {
      console.error("[GTFS] delete failed:", err);
      return;
    }
    const next = feeds.filter(f => f.id !== feedId);
    setFeeds(next);
    if (selectedFeed === feedId) setSelectedFeed(next[0]?.id || null);
  };

  const totalStops = feeds.reduce((s, f) => s + f.stopsCount, 0);
  const totalRoutes = feeds.reduce((s, f) => s + f.routesCount, 0);
  const totalTrips = feeds.reduce((s, f) => s + f.tripsCount, 0);

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-display font-bold text-foreground">GTFS & Analisi Servizio</h1>
        <p className="text-muted-foreground mt-1">
          Importa i dati GTFS e analizza la qualità del servizio offerto rispetto a traffico, domanda e punti di interesse.
        </p>
      </div>

      {/* Summary stats when feeds exist */}
      {feeds.length > 0 && (
        <div className="grid grid-cols-3 gap-3">
          <MiniStat icon={MapPin} label="Fermate totali" value={totalStops} color="text-green-400" />
          <MiniStat icon={Route} label="Linee" value={totalRoutes} color="text-blue-400" />
          <MiniStat icon={Bus} label="Corse" value={totalTrips} color="text-amber-400" />
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 p-1 bg-card/40 rounded-xl border border-border/40 w-fit">
        {(["upload", "analysis", "planning"] as const).map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
              activeTab === tab
                ? "bg-primary text-primary-foreground shadow"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {tab === "upload" ? "Feed & Caricamento" : tab === "analysis" ? "Analisi Qualità" : "Pianificazione & Costi"}
          </button>
        ))}
      </div>

      {activeTab === "upload" && (
        <div className="space-y-6">
          {/* Upload zone */}
          <Card className="bg-card/60 border-border/40">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Upload className="w-4 h-4 text-primary" />
                Carica nuovo feed GTFS
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div
                onDragOver={e => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={e => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files?.[0]; if (f) handleUpload(f); }}
                onClick={() => fileInputRef.current?.click()}
                className={`border-2 border-dashed rounded-xl p-10 text-center cursor-pointer transition-all duration-200 ${
                  dragOver ? "border-primary bg-primary/10" : "border-border/60 hover:border-primary/50 hover:bg-white/[0.02]"
                }`}
              >
                <input ref={fileInputRef} type="file" accept=".zip" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) handleUpload(f); e.target.value = ""; }} />
                {uploading ? (
                  <div className="flex flex-col items-center gap-3">
                    <Loader2 className="w-10 h-10 text-primary animate-spin" />
                    <p className="text-sm text-muted-foreground">Analisi orari, corse e percorsi in corso…</p>
                  </div>
                ) : (
                  <div className="flex flex-col items-center gap-3">
                    <div className="w-14 h-14 rounded-2xl bg-primary/10 flex items-center justify-center">
                      <FileArchive className="w-7 h-7 text-primary" />
                    </div>
                    <div>
                      <p className="font-semibold text-foreground">Trascina il file GTFS (.zip)</p>
                      <p className="text-sm text-muted-foreground mt-1">oppure clicca per selezionare</p>
                    </div>
                    <p className="text-xs text-muted-foreground">stops.txt · routes.txt · trips.txt · stop_times.txt · shapes.txt · Max 150 MB</p>
                  </div>
                )}
              </div>

              <AnimatePresence>
                {uploadResult && (
                  <motion.div
                    initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
                    className={`mt-4 flex items-start gap-3 p-4 rounded-xl border ${
                      uploadResult.success
                        ? "bg-green-500/10 border-green-500/30 text-green-400"
                        : "bg-destructive/10 border-destructive/30 text-destructive"
                    }`}
                  >
                    {uploadResult.success ? <CheckCircle2 className="w-5 h-5 shrink-0 mt-0.5" /> : <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />}
                    <p className="text-sm">{uploadResult.message}</p>
                  </motion.div>
                )}
              </AnimatePresence>
            </CardContent>
          </Card>

          {/* Feed list */}
          <div>
            <h2 className="text-base font-semibold text-foreground flex items-center gap-2 mb-4">
              <BarChart3 className="w-4 h-4 text-primary" />
              Feed caricati
              {feeds.length > 0 && <Badge variant="secondary">{feeds.length}</Badge>}
            </h2>
            {loading ? (
              <div className="flex items-center justify-center gap-2 py-8 text-muted-foreground">
                <Loader2 className="w-5 h-5 animate-spin" /> Caricamento…
              </div>
            ) : feeds.length === 0 ? (
              <Card className="bg-card/40 border-border/30">
                <CardContent className="py-12 text-center">
                  <FileArchive className="w-10 h-10 text-muted-foreground/50 mx-auto mb-3" />
                  <p className="text-muted-foreground">Nessun feed GTFS caricato.</p>
                </CardContent>
              </Card>
            ) : (
              <div className="space-y-3">
                {feeds.map(feed => (
                  <FeedCard
                    key={feed.id} feed={feed} onDelete={handleDelete}
                    isSelected={selectedFeed === feed.id}
                    onSelect={id => { setSelectedFeed(id); setActiveTab("analysis"); }}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {activeTab === "analysis" && (
        <div className="space-y-4">
          {feeds.length > 1 && (
            <div className="flex flex-wrap gap-2">
              {feeds.map(f => (
                <button
                  key={f.id}
                  onClick={() => setSelectedFeed(f.id)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all border ${
                    selectedFeed === f.id
                      ? "bg-primary/15 border-primary/50 text-primary"
                      : "bg-card/40 border-border/40 text-muted-foreground hover:border-border"
                  }`}
                >
                  {f.agencyName || f.filename}
                </button>
              ))}
            </div>
          )}
          <AnalysisTab feedId={selectedFeed} />
        </div>
      )}

      {activeTab === "planning" && (
        <div className="space-y-4">
          {feeds.length > 1 && (
            <div className="flex flex-wrap gap-2">
              {feeds.map(f => (
                <button
                  key={f.id}
                  onClick={() => setSelectedFeed(f.id)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all border ${
                    selectedFeed === f.id
                      ? "bg-primary/15 border-primary/50 text-primary"
                      : "bg-card/40 border-border/40 text-muted-foreground hover:border-border"
                  }`}
                >
                  {f.agencyName || f.filename}
                </button>
              ))}
            </div>
          )}
          <PlanningAnalysisTab feedId={selectedFeed} />
        </div>
      )}
    </div>
  );
}
