import React, { useMemo, useState } from "react";
import { useGetTrafficStats, useGetTrafficHeatmap } from "@workspace/api-client-react";
import { Activity, Clock, MapPin, AlertCircle, TrendingUp, TrendingDown, Minus, Calendar } from "lucide-react";
import { StatCard } from "@/components/ui/stat-card";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
  BarChart, Bar, Cell, ReferenceLine, Legend,
} from "recharts";

const ZONE_DEFS = [
  { id: "centro",   label: "Centro storico", lat: [43.59, 43.62], lon: [13.50, 13.52], color: "#ef4444" },
  { id: "porto",    label: "Porto / Lido",   lat: [43.60, 43.63], lon: [13.52, 13.57], color: "#f97316" },
  { id: "ovest",    label: "Zona Ovest",     lat: [43.60, 43.65], lon: [13.42, 13.50], color: "#eab308" },
  { id: "nord",     label: "Nord / Falconara", lat: [43.62, 43.69], lon: [13.38, 13.52], color: "#22c55e" },
  { id: "hinterland", label: "Entroterra",   lat: [43.40, 43.60], lon: [12.70, 13.42], color: "#6b7280" },
];

const HOUR_LABELS: Record<number, string> = {
  6: "Prima mattina", 7: "Prima mattina",
  8: "Punta mattina", 9: "Punta mattina",
  10: "Mattina", 11: "Mattina", 12: "Mattina",
  13: "Pomeriggio", 14: "Pomeriggio", 15: "Pomeriggio", 16: "Pomeriggio",
  17: "Punta sera", 18: "Punta sera", 19: "Punta sera",
  20: "Sera", 21: "Sera",
};

function congestionColor(c: number) {
  if (c < 0.25) return "#22c55e";
  if (c < 0.45) return "#84cc16";
  if (c < 0.60) return "#eab308";
  if (c < 0.75) return "#f97316";
  return "#ef4444";
}
function congestionLabel(c: number) {
  if (c < 0.25) return "Scorrevole";
  if (c < 0.45) return "Fluido";
  if (c < 0.60) return "Moderato";
  if (c < 0.75) return "Rallentato";
  return "Congestionato";
}

const THEORETICAL_PROFILE = [
  { hour: 5, expected: 0.08 }, { hour: 6, expected: 0.18 }, { hour: 7, expected: 0.38 },
  { hour: 8, expected: 0.62 }, { hour: 9, expected: 0.55 }, { hour: 10, expected: 0.32 },
  { hour: 11, expected: 0.28 }, { hour: 12, expected: 0.34 }, { hour: 13, expected: 0.36 },
  { hour: 14, expected: 0.30 }, { hour: 15, expected: 0.35 }, { hour: 16, expected: 0.42 },
  { hour: 17, expected: 0.65 }, { hour: 18, expected: 0.72 }, { hour: 19, expected: 0.55 },
  { hour: 20, expected: 0.30 }, { hour: 21, expected: 0.18 }, { hour: 22, expected: 0.10 },
];

const CustomTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-card border border-border rounded-xl px-3 py-2 shadow-lg text-xs space-y-1">
      <p className="font-semibold">{label} · {HOUR_LABELS[parseInt(label)] ?? ""}</p>
      {payload.map((p: any) => (
        <div key={p.dataKey} className="flex items-center gap-2">
          <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: p.color }} />
          <span className="text-muted-foreground">{p.name}:</span>
          <span className="font-mono font-semibold">{(p.value as number)?.toFixed(1)}%</span>
        </div>
      ))}
    </div>
  );
};

export default function Traffic() {
  const { data: stats, isLoading } = useGetTrafficStats();
  const { data: heatmap } = useGetTrafficHeatmap({});
  const [selectedZone, setSelectedZone] = useState<string | null>(null);

  const hourlyData = useMemo(() => {
    const measured: Record<number, number> = {};
    if (stats?.congestionByHour) {
      for (const d of stats.congestionByHour) {
        measured[d.hour] = d.avgCongestion * 100;
      }
    }
    return THEORETICAL_PROFILE.map(p => ({
      name: `${p.hour}:00`,
      hour: p.hour,
      atteso: +(p.expected * 100).toFixed(1),
      rilevato: measured[p.hour] != null ? +measured[p.hour].toFixed(1) : null,
    }));
  }, [stats]);

  const zoneData = useMemo(() => {
    if (!heatmap?.data) return [];
    return ZONE_DEFS.map(z => {
      const pts = heatmap.data.filter(h =>
        h.lat >= z.lat[0] && h.lat < z.lat[1] &&
        h.lng >= z.lon[0] && h.lng < z.lon[1]
      );
      const avg = pts.length > 0
        ? pts.reduce((s, p) => s + p.avgCongestion, 0) / pts.length
        : null;
      return { ...z, avgCongestion: avg, sampleCount: pts.length };
    }).sort((a, b) => (b.avgCongestion ?? 0) - (a.avgCongestion ?? 0));
  }, [heatmap]);

  const peakHour = stats?.peakHour;
  const peakLabel = peakHour != null ? HOUR_LABELS[peakHour] ?? `${peakHour}:00` : "--";

  const topHotspot = useMemo(() => {
    if (!heatmap?.data?.length) return null;
    return heatmap.data.reduce((a, b) => b.avgCongestion > a.avgCongestion ? b : a);
  }, [heatmap]);

  if (isLoading) {
    return (
      <div className="max-w-6xl mx-auto space-y-6 p-4">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-muted rounded w-64" />
          <div className="grid grid-cols-4 gap-4">
            {[0,1,2,3].map(i => <div key={i} className="h-24 bg-muted rounded-xl" />)}
          </div>
          <div className="h-80 bg-muted rounded-xl" />
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto space-y-6 p-4 pb-8">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-display font-bold text-foreground">Analisi Traffico</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Congestione stradale storica · rete Ancona/Marche · dati TomTom
        </p>
        {stats?.lastUpdated && (
          <p className="text-[11px] text-muted-foreground/60 mt-0.5 flex items-center gap-1">
            <Calendar className="w-3 h-3" />
            Ultimo aggiornamento: {new Date(stats.lastUpdated).toLocaleString("it-IT")}
          </p>
        )}
      </div>

      {/* Stats cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <StatCard
          title="Congestione media"
          value={stats?.avgCongestion != null ? `${(stats.avgCongestion * 100).toFixed(1)}%` : "--"}
          icon={Activity}
          delay={0}
        />
        <StatCard
          title="Snapshot totali"
          value={(stats?.totalSnapshots ?? 0).toLocaleString("it-IT")}
          icon={Clock}
          delay={0.05}
        />
        <StatCard
          title="Ora di punta"
          value={peakHour != null ? `${peakHour}:00` : "--"}
          icon={AlertCircle}
          delay={0.1}
        />
        <StatCard
          title="Zona più critica"
          value={topHotspot
            ? `${(topHotspot.avgCongestion * 100).toFixed(0)}%`
            : "--"}
          icon={MapPin}
          delay={0.15}
        />
      </div>

      {/* Data collection status */}
      {stats && (
        <div className={`rounded-xl border px-4 py-3 flex items-start gap-3 ${
          stats.congestionByHour.length < 12
            ? "bg-yellow-500/8 border-yellow-500/25"
            : "bg-green-500/8 border-green-500/25"
        }`}>
          <AlertCircle className={`w-4 h-4 mt-0.5 shrink-0 ${stats.congestionByHour.length < 12 ? "text-yellow-400" : "text-green-400"}`} />
          <div className="text-xs text-muted-foreground">
            {stats.congestionByHour.length < 12 ? (
              <>
                <span className="font-semibold text-yellow-400">Dati TomTom parziali</span>
                {" — "}raccolta in corso automaticamente.{" "}
                Attualmente disponibili <strong>{stats.congestionByHour.length} fasce orarie</strong>{" "}
                (ore {stats.congestionByHour.map(h => `${h.hour}:00`).join(", ")}) su {stats.totalSnapshots.toLocaleString("it-IT")} snapshot totali.{" "}
                La linea arancione nel grafico mostra solo le ore effettivamente rilevate — il profilo completo si formerà nel tempo.
              </>
            ) : (
              <>
                <span className="font-semibold text-green-400">Dati TomTom completi</span>
                {" — "}{stats.totalSnapshots.toLocaleString("it-IT")} snapshot · {stats.congestionByHour.length} fasce orarie rilevate.
              </>
            )}
          </div>
        </div>
      )}

      {/* Congestion by hour chart */}
      <Card className="bg-card/60 backdrop-blur border-border/50">
        <CardHeader>
          <CardTitle className="text-base">Profilo di congestione orario</CardTitle>
          <CardDescription className="text-xs">
            Linea <span className="text-blue-400 font-medium">blu tratteggiata</span>: modello teorico italiano (sempre mostrato).{" "}
            Linea <span className="text-orange-400 font-medium">arancione</span>: rilevazioni TomTom reali — appare solo nelle ore con snapshot disponibili.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="h-[320px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={hourlyData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                <defs>
                  <linearGradient id="gradAtteso" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.25}/>
                    <stop offset="95%" stopColor="#3b82f6" stopOpacity={0}/>
                  </linearGradient>
                  <linearGradient id="gradRilevato" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#f97316" stopOpacity={0.35}/>
                    <stop offset="95%" stopColor="#f97316" stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                <XAxis dataKey="name" stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} />
                <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false}
                  tickFormatter={v => `${v}%`} domain={[0, 100]} />
                <Tooltip content={<CustomTooltip />} />
                <Legend
                  formatter={(value) => value === "atteso" ? "Atteso (modello)" : "Rilevato (TomTom)"}
                  iconSize={10}
                  wrapperStyle={{ fontSize: 11, color: "hsl(var(--muted-foreground))" }}
                />
                {/* Fasce orarie reference */}
                <ReferenceLine x="8:00" stroke="rgba(99,102,241,0.3)" strokeDasharray="4 2" label={{ value: "Punta", fill: "rgba(99,102,241,0.5)", fontSize: 10 }} />
                <ReferenceLine x="17:00" stroke="rgba(99,102,241,0.3)" strokeDasharray="4 2" label={{ value: "Punta", fill: "rgba(99,102,241,0.5)", fontSize: 10 }} />
                <Area
                  type="monotone" dataKey="atteso" name="atteso"
                  stroke="#3b82f6" strokeWidth={2} strokeDasharray="5 3"
                  fill="url(#gradAtteso)" dot={false}
                />
                <Area
                  type="monotone" dataKey="rilevato" name="rilevato"
                  stroke="#f97316" strokeWidth={2.5}
                  fill="url(#gradRilevato)"
                  dot={{ r: 3, fill: "#f97316", strokeWidth: 0 }}
                  connectNulls={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Zone analysis */}
        <Card className="bg-card/60 backdrop-blur border-border/50">
          <CardHeader>
            <CardTitle className="text-base">Congestione per zona</CardTitle>
            <CardDescription className="text-xs">
              Media sensori TomTom per area geografica — Ancona/Marche
            </CardDescription>
          </CardHeader>
          <CardContent>
            {zoneData.filter(z => z.sampleCount > 0).length === 0 ? (
              <div className="flex flex-col items-center justify-center py-10 gap-3 text-muted-foreground">
                <MapPin className="w-8 h-8 opacity-20" />
                <p className="text-sm">Dati insufficienti per analisi per zona</p>
                <p className="text-xs opacity-60">I sensori TomTom non coprono ancora tutte le zone</p>
              </div>
            ) : (
              <div className="space-y-3">
                {zoneData.map((z, i) => {
                  const c = z.avgCongestion ?? 0;
                  const label = congestionLabel(c);
                  const color = z.color;
                  const isSelected = selectedZone === z.id;
                  return (
                    <button key={z.id} onClick={() => setSelectedZone(isSelected ? null : z.id)}
                      className={`w-full flex items-center gap-3 p-3 rounded-xl border transition-all text-left ${
                        isSelected ? "border-primary/40 bg-primary/5" : "border-border/30 hover:border-border/60 hover:bg-muted/20"
                      }`}>
                      <div className="text-xs font-bold text-muted-foreground/60 w-4">{i+1}</div>
                      <div className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: color }} />
                      <div className="flex-1">
                        <p className="text-sm font-medium">{z.label}</p>
                        <p className="text-[10px] text-muted-foreground">{z.sampleCount} sensori rilevati</p>
                      </div>
                      <div className="text-right shrink-0">
                        {z.avgCongestion != null ? (
                          <>
                            <p className="text-sm font-bold" style={{ color: congestionColor(c) }}>
                              {(c * 100).toFixed(0)}%
                            </p>
                            <p className="text-[10px]" style={{ color: congestionColor(c) }}>{label}</p>
                          </>
                        ) : (
                          <p className="text-xs text-muted-foreground">n/d</p>
                        )}
                      </div>
                      <div className="shrink-0">
                        {z.sampleCount > 0 && c > 0.5 ? (
                          <TrendingUp className="w-3.5 h-3.5 text-orange-400" />
                        ) : z.sampleCount > 0 && c < 0.3 ? (
                          <TrendingDown className="w-3.5 h-3.5 text-green-400" />
                        ) : (
                          <Minus className="w-3.5 h-3.5 text-muted-foreground/40" />
                        )}
                      </div>
                    </button>
                  );
                })}
                {zoneData.filter(z => z.sampleCount === 0).map(z => (
                  <div key={z.id} className="flex items-center gap-3 p-3 rounded-xl border border-border/20 opacity-40">
                    <div className="w-3 h-3 rounded-full shrink-0 bg-muted" />
                    <div className="flex-1">
                      <p className="text-sm text-muted-foreground">{z.label}</p>
                      <p className="text-[10px] text-muted-foreground">Nessun sensore in questa zona</p>
                    </div>
                    <span className="text-xs text-muted-foreground">—</span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Zone congestion bar chart */}
        <Card className="bg-card/60 backdrop-blur border-border/50">
          <CardHeader>
            <CardTitle className="text-base">Intensità per fascia oraria</CardTitle>
            <CardDescription className="text-xs">
              Congestione rilevata dai sensori TomTom per ciascuna ora
            </CardDescription>
          </CardHeader>
          <CardContent>
            {(!stats?.congestionByHour || stats.congestionByHour.length === 0) ? (
              <div className="flex flex-col items-center justify-center py-10 gap-3 text-muted-foreground">
                <Clock className="w-8 h-8 opacity-20" />
                <p className="text-sm">Dati orari non disponibili</p>
              </div>
            ) : (
              <div className="h-[260px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={stats.congestionByHour.map(d => ({
                      name: `${d.hour}:00`,
                      valore: +(d.avgCongestion * 100).toFixed(1),
                      congestion: d.avgCongestion,
                    }))}
                    margin={{ top: 4, right: 8, bottom: 0, left: 0 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                    <XAxis dataKey="name" stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} />
                    <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false}
                      tickFormatter={v => `${v}%`} domain={[0, 100]} />
                    <Tooltip
                      contentStyle={{ backgroundColor: "hsl(var(--card))", borderColor: "hsl(var(--border))", borderRadius: 12 }}
                      formatter={(v: any, name: any) => [`${v}%`, "Congestione"]}
                    />
                    <Bar dataKey="valore" radius={[4, 4, 0, 0]}>
                      {stats.congestionByHour.map((d, i) => (
                        <Cell key={i} fill={congestionColor(d.avgCongestion)} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}

            {/* Fascia legenda */}
            <div className="mt-3 flex flex-wrap gap-2 justify-center">
              {[
                ["#22c55e", "Scorrevole (<25%)"],
                ["#84cc16", "Fluido (25–45%)"],
                ["#eab308", "Moderato (45–60%)"],
                ["#f97316", "Rallentato (60–75%)"],
                ["#ef4444", "Congestionato (>75%)"],
              ].map(([c, l]) => (
                <div key={l} className="flex items-center gap-1.5">
                  <div className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: c }} />
                  <span className="text-[10px] text-muted-foreground">{l}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Hotspot list */}
      {heatmap?.data && heatmap.data.length > 0 && (
        <Card className="bg-card/60 backdrop-blur border-border/50">
          <CardHeader>
            <CardTitle className="text-base">Punti caldi di congestione</CardTitle>
            <CardDescription className="text-xs">
              Aree con maggiore intensità di congestione rilevata dai sensori TomTom
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {heatmap.data.slice(0, 9).map((h, i) => {
                const c = h.avgCongestion;
                return (
                  <div key={i} className="flex items-center gap-3 p-3 rounded-xl bg-background/40 border border-border/30">
                    <div className="w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-bold"
                      style={{ backgroundColor: congestionColor(c) + "25", color: congestionColor(c) }}>
                      {i+1}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-[11px] font-mono truncate text-muted-foreground">
                        {h.lat.toFixed(4)}°N · {h.lng.toFixed(4)}°E
                      </p>
                      <p className="text-[10px] text-muted-foreground/60">{h.sampleCount} campioni</p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-sm font-bold" style={{ color: congestionColor(c) }}>
                        {(c * 100).toFixed(0)}%
                      </p>
                      <p className="text-[9px]" style={{ color: congestionColor(c) }}>{congestionLabel(c)}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
