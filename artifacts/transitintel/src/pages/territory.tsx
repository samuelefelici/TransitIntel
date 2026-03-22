import React, { useState, useEffect } from "react";
import {
  Users, Building2, MapPin, TrendingUp, Map, AlertTriangle, CheckCircle2
} from "lucide-react";
import { StatCard } from "@/components/ui/stat-card";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, Cell, LabelList
} from "recharts";
import { getApiBase } from "@/lib/api";

interface TerritoryData {
  stats: {
    totalPop: number;
    totalSections: number;
    avgDensity: number;
    totalPoi: number;
  };
  poiByCategory: { category: string; label: string; count: number; color: string }[];
  topSections: {
    rank: number;
    population: number;
    density: number;
    nearestStopM: number;
    poiCount: number;
    lat: number;
    lng: number;
  }[];
  densityBands: { band: string; sections: number; population: number }[];
  densityCoverage: { band: string; avgNearestM: number; sectionCount: number }[];
}

const BAND_ORDER = ["Rurale", "Periurbano", "Urbano", "Alta densità"];

function coverageColor(m: number) {
  if (m < 200)  return "text-emerald-400";
  if (m < 500)  return "text-yellow-400";
  if (m < 1000) return "text-orange-400";
  return "text-red-400";
}
function coverageBadge(m: number) {
  if (m < 200)  return { label: "Ottima", cls: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30" };
  if (m < 500)  return { label: "Buona",  cls: "bg-yellow-500/15  text-yellow-400  border-yellow-500/30" };
  if (m < 1000) return { label: "Media",  cls: "bg-orange-500/15  text-orange-400  border-orange-500/30" };
  return              { label: "Scarsa",  cls: "bg-red-500/15     text-red-400     border-red-500/30" };
}

const BAND_COLORS: Record<string, string> = {
  "Rurale":        "#64748b",
  "Periurbano":    "#3b82f6",
  "Urbano":        "#8b5cf6",
  "Alta densità":  "#ef4444",
};

export default function Territory() {
  const [data, setData] = useState<TerritoryData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${getApiBase()}/api/territory/overview`)
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false); })
      .catch(() => { setError("Errore nel caricamento dei dati."); setLoading(false); });
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 gap-3 text-muted-foreground">
        <div className="w-5 h-5 rounded-full border-2 border-primary border-t-transparent animate-spin" />
        Caricamento analisi territorio…
      </div>
    );
  }
  if (error || !data) {
    return <div className="text-red-400 p-8">{error ?? "Dati non disponibili."}</div>;
  }

  const sortedCoverage = [...data.densityCoverage].sort(
    (a, b) => BAND_ORDER.indexOf(a.band) - BAND_ORDER.indexOf(b.band)
  );

  return (
    <div className="max-w-7xl mx-auto space-y-8">

      {/* Header */}
      <div>
        <h1 className="text-4xl font-display font-bold text-foreground">Analisi Territorio</h1>
        <p className="text-muted-foreground mt-2">
          Distribuzione demografica, punti di interesse e qualità della copertura per le {data.stats.totalSections} sezioni censuarie della provincia.
        </p>
      </div>

      {/* KPI Strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          title="Popolazione totale"
          value={data.stats.totalPop.toLocaleString("it-IT")}
          icon={Users}
          delay={0}
        />
        <StatCard
          title="Sezioni censuarie"
          value={data.stats.totalSections.toString()}
          description="Fonte: ISTAT"
          icon={Map}
          delay={0.05}
        />
        <StatCard
          title="Punti di interesse"
          value={data.stats.totalPoi.toLocaleString("it-IT")}
          description="Ospedali, scuole, uffici…"
          icon={Building2}
          delay={0.1}
        />
        <StatCard
          title="Densità media"
          value={`${Math.round(data.stats.avgDensity)} ab/km²`}
          icon={TrendingUp}
          delay={0.15}
        />
      </div>

      {/* Row 1: POI per categoria + Top sezioni */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

        {/* POI per categoria */}
        <Card className="bg-card/50 backdrop-blur-sm border-border/50">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Building2 className="w-4 h-4 text-primary" />
              Punti di interesse per categoria
            </CardTitle>
            <CardDescription>
              {data.stats.totalPoi.toLocaleString("it-IT")} POI mappati nella provincia di Ancona / Marche
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={data.poiByCategory}
                  layout="vertical"
                  margin={{ top: 0, right: 50, left: 10, bottom: 0 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" horizontal={false} />
                  <XAxis
                    type="number"
                    stroke="hsl(var(--muted-foreground))"
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis
                    dataKey="label"
                    type="category"
                    stroke="hsl(var(--muted-foreground))"
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                    width={150}
                  />
                  <Tooltip
                    cursor={{ fill: "hsl(var(--muted)/0.4)" }}
                    contentStyle={{
                      backgroundColor: "hsl(var(--card))",
                      borderColor: "hsl(var(--border))",
                      borderRadius: "10px",
                      fontSize: "12px",
                    }}
                    formatter={(v: number) => [v.toLocaleString("it-IT"), "POI"]}
                  />
                  <Bar dataKey="count" radius={[0, 4, 4, 0]}>
                    <LabelList dataKey="count" position="right" style={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} />
                    {data.poiByCategory.map((entry, i) => (
                      <Cell key={i} fill={entry.color} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        {/* Copertura per classe di densità */}
        <Card className="bg-card/50 backdrop-blur-sm border-border/50">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <MapPin className="w-4 h-4 text-primary" />
              Distanza media fermata per classe di densità
            </CardTitle>
            <CardDescription>
              Le aree urbane dense ricevono una copertura migliore?
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={sortedCoverage}
                  margin={{ top: 10, right: 20, left: 0, bottom: 0 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                  <XAxis
                    dataKey="band"
                    stroke="hsl(var(--muted-foreground))"
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis
                    stroke="hsl(var(--muted-foreground))"
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                    unit=" m"
                  />
                  <Tooltip
                    cursor={{ fill: "hsl(var(--muted)/0.4)" }}
                    contentStyle={{
                      backgroundColor: "hsl(var(--card))",
                      borderColor: "hsl(var(--border))",
                      borderRadius: "10px",
                      fontSize: "12px",
                    }}
                    formatter={(v: number) => [`${v.toLocaleString("it-IT")} m`, "Distanza media"]}
                  />
                  <Bar dataKey="avgNearestM" radius={[4, 4, 0, 0]}>
                    <LabelList
                      dataKey="avgNearestM"
                      position="top"
                      formatter={(v: number) => `${v} m`}
                      style={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                    />
                    {sortedCoverage.map((entry, i) => (
                      <Cell key={i} fill={BAND_COLORS[entry.band] ?? "#94a3b8"} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
            <p className="text-[11px] text-muted-foreground mt-3 border-t border-border/30 pt-3">
              Distanza calcolata dal centroide di ogni sezione censuaria alla fermata GTFS più vicina (3.943 fermate reali).
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Row 2: Distribuzione densità + Top 10 sezioni */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

        {/* Distribuzione per classe di densità */}
        <Card className="bg-card/50 backdrop-blur-sm border-border/50">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <TrendingUp className="w-4 h-4 text-primary" />
              Distribuzione demografica per classe
            </CardTitle>
            <CardDescription>Sezioni censuarie raggruppate per densità abitativa (ab/km²)</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 pt-2">
            {data.densityBands.map((band) => {
              const pct = Math.round((band.population / data.stats.totalPop) * 100);
              const col = BAND_COLORS[band.band.split(" ")[0]] ?? "#94a3b8";
              return (
                <div key={band.band}>
                  <div className="flex justify-between text-sm mb-1">
                    <span className="text-foreground font-medium">{band.band}</span>
                    <span className="text-muted-foreground">
                      {band.sections} sezioni · {band.population.toLocaleString("it-IT")} ab. ({pct}%)
                    </span>
                  </div>
                  <div className="h-2 bg-muted/30 rounded-full overflow-hidden">
                    <div
                      className="h-full rounded-full transition-all duration-700"
                      style={{ width: `${pct}%`, backgroundColor: col }}
                    />
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>

        {/* Top 10 sezioni per popolazione */}
        <Card className="bg-card/50 backdrop-blur-sm border-border/50">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Users className="w-4 h-4 text-primary" />
              Top 10 sezioni per popolazione
            </CardTitle>
            <CardDescription>Con distanza alla fermata GTFS più vicina e POI nel raggio 5 km</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border/40 text-muted-foreground text-xs">
                    <th className="px-4 py-2 text-left">#</th>
                    <th className="px-4 py-2 text-right">Abitanti</th>
                    <th className="px-4 py-2 text-right">Den. ab/km²</th>
                    <th className="px-4 py-2 text-right">Fermata</th>
                    <th className="px-4 py-2 text-right">POI</th>
                    <th className="px-4 py-2 text-left">Copertura</th>
                  </tr>
                </thead>
                <tbody>
                  {data.topSections.map((s) => {
                    const badge = coverageBadge(s.nearestStopM);
                    return (
                      <tr key={s.rank} className="border-b border-border/20 hover:bg-white/3 transition-colors">
                        <td className="px-4 py-2.5 text-muted-foreground font-mono">{s.rank}</td>
                        <td className="px-4 py-2.5 text-right font-semibold">
                          {s.population.toLocaleString("it-IT")}
                        </td>
                        <td className="px-4 py-2.5 text-right text-muted-foreground">
                          {Math.round(s.density).toLocaleString("it-IT")}
                        </td>
                        <td className={`px-4 py-2.5 text-right font-mono ${coverageColor(s.nearestStopM)}`}>
                          {s.nearestStopM < 1000
                            ? `${s.nearestStopM} m`
                            : `${(s.nearestStopM / 1000).toFixed(1)} km`}
                        </td>
                        <td className="px-4 py-2.5 text-right text-muted-foreground">{s.poiCount}</td>
                        <td className="px-4 py-2.5">
                          <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${badge.cls}`}>
                            {badge.label}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="flex items-center gap-6 px-4 py-3 border-t border-border/30 text-[11px] text-muted-foreground flex-wrap gap-y-1">
              {[
                { cls: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30", label: "Ottima < 200 m" },
                { cls: "bg-yellow-500/15 text-yellow-400 border-yellow-500/30",   label: "Buona < 500 m" },
                { cls: "bg-orange-500/15 text-orange-400 border-orange-500/30",   label: "Media < 1 km" },
                { cls: "bg-red-500/15 text-red-400 border-red-500/30",            label: "Scarsa > 1 km" },
              ].map(b => (
                <span key={b.label} className={`px-2 py-0.5 rounded-full border ${b.cls}`}>{b.label}</span>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Insight banner */}
      <Card className="bg-card/40 backdrop-blur-sm border-border/50">
        <CardContent className="flex items-start gap-4 pt-5 pb-5">
          <div className="shrink-0 mt-0.5">
            {sortedCoverage.find(b => b.band === "Alta densità")?.avgNearestM ?? 999 < 300
              ? <CheckCircle2 className="w-5 h-5 text-emerald-400" />
              : <AlertTriangle className="w-5 h-5 text-yellow-400" />
            }
          </div>
          <div className="text-sm text-muted-foreground space-y-1">
            <p className="font-semibold text-foreground text-base">Lettura dell'analisi</p>
            <p>
              Le <strong className="text-foreground">{data.stats.totalSections} sezioni censuarie</strong> coprono una popolazione di{" "}
              <strong className="text-foreground">{data.stats.totalPop.toLocaleString("it-IT")} abitanti</strong>.{" "}
              Il grafico "distanza per classe" mostra come le aree a <em>bassa densità rurale</em> si trovino mediamente più lontane
              dalle fermate: questo è il principale gap di copertura della rete attuale.
            </p>
            <p>
              I <strong className="text-foreground">{data.stats.totalPoi.toLocaleString("it-IT")} punti di interesse</strong> — ospedali,
              scuole, uffici, negozi — rappresentano i principali <em>generatori di domanda</em> di mobilità pubblica.
              Una rete ottimale dovrebbe collegare in modo diretto le sezioni ad alta densità con i cluster di POI più rilevanti.
            </p>
          </div>
        </CardContent>
      </Card>

    </div>
  );
}
