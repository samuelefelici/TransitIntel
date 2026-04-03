import React, { useMemo, useState } from "react";
import { useGetTrafficStats, useGetTrafficHeatmap, useGetWeatherCorrelation, useGetWeatherCurrent } from "@workspace/api-client-react";
import {
  Activity, Clock, MapPin, AlertCircle, TrendingDown,
  Calendar, ShieldCheck, Timer, Bus, Cloud, Droplets, Wind,
} from "lucide-react";
import { StatCard } from "@/components/ui/stat-card";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
  BarChart, Bar, Cell, ReferenceLine, Legend,
} from "recharts";

/* ────────────────────────────── CONSTANTS ────────────────────────────── */

type DayType = "feriale" | "sabato" | "festivo";

const DAY_TYPE_OPTIONS: { value: DayType; label: string; icon: string }[] = [
  { value: "feriale", label: "Feriale (Lun–Ven)", icon: "🏢" },
  { value: "sabato", label: "Sabato", icon: "🛒" },
  { value: "festivo", label: "Domenica / Festivo", icon: "☀️" },
];

const ZONE_COLORS: Record<string, string> = {
  "Centro storico": "#ef4444",
  "Porto / Lido": "#f97316",
  "Zona Ovest": "#eab308",
  "Nord / Falconara": "#22c55e",
  "Entroterra": "#6b7280",
};

const HOUR_BANDS: Record<string, string> = {
  "6": "Prima mattina", "7": "Prima mattina",
  "8": "Punta mattina", "9": "Punta mattina",
  "10": "Mattina", "11": "Mattina", "12": "Mattina",
  "13": "Pomeriggio", "14": "Pomeriggio", "15": "Pomeriggio", "16": "Pomeriggio",
  "17": "Punta sera", "18": "Punta sera", "19": "Punta sera",
  "20": "Sera", "21": "Sera",
};

const THEORETICAL: Record<DayType, { hour: number; expected: number }[]> = {
  feriale: [
    { hour: 5, expected: 0.08 }, { hour: 6, expected: 0.20 }, { hour: 7, expected: 0.42 },
    { hour: 8, expected: 0.65 }, { hour: 9, expected: 0.52 }, { hour: 10, expected: 0.30 },
    { hour: 11, expected: 0.27 }, { hour: 12, expected: 0.33 }, { hour: 13, expected: 0.38 },
    { hour: 14, expected: 0.28 }, { hour: 15, expected: 0.32 }, { hour: 16, expected: 0.40 },
    { hour: 17, expected: 0.62 }, { hour: 18, expected: 0.70 }, { hour: 19, expected: 0.50 },
    { hour: 20, expected: 0.28 }, { hour: 21, expected: 0.15 }, { hour: 22, expected: 0.08 },
  ],
  sabato: [
    { hour: 5, expected: 0.05 }, { hour: 6, expected: 0.08 }, { hour: 7, expected: 0.15 },
    { hour: 8, expected: 0.28 }, { hour: 9, expected: 0.42 }, { hour: 10, expected: 0.55 },
    { hour: 11, expected: 0.58 }, { hour: 12, expected: 0.50 }, { hour: 13, expected: 0.35 },
    { hour: 14, expected: 0.30 }, { hour: 15, expected: 0.38 }, { hour: 16, expected: 0.52 },
    { hour: 17, expected: 0.58 }, { hour: 18, expected: 0.55 }, { hour: 19, expected: 0.42 },
    { hour: 20, expected: 0.35 }, { hour: 21, expected: 0.25 }, { hour: 22, expected: 0.12 },
  ],
  festivo: [
    { hour: 5, expected: 0.03 }, { hour: 6, expected: 0.05 }, { hour: 7, expected: 0.08 },
    { hour: 8, expected: 0.12 }, { hour: 9, expected: 0.22 }, { hour: 10, expected: 0.35 },
    { hour: 11, expected: 0.40 }, { hour: 12, expected: 0.38 }, { hour: 13, expected: 0.30 },
    { hour: 14, expected: 0.25 }, { hour: 15, expected: 0.28 }, { hour: 16, expected: 0.35 },
    { hour: 17, expected: 0.40 }, { hour: 18, expected: 0.42 }, { hour: 19, expected: 0.35 },
    { hour: 20, expected: 0.30 }, { hour: 21, expected: 0.20 }, { hour: 22, expected: 0.10 },
  ],
};

/* ────────────────────────────── HELPERS ──────────────────────────────── */

function congestionColor(c: number) {
  if (c < 0.25) return "#22c55e";
  if (c < 0.45) return "#84cc16";
  if (c < 0.60) return "#eab308";
  if (c < 0.75) return "#f97316";
  return "#ef4444";
}

function speedReductionBadge(pct: number) {
  if (pct <= 5)  return { label: "Impatto trascurabile", color: "#22c55e", bg: "bg-green-500/10", arrow: "→", arrowColor: "text-green-500" };
  if (pct <= 15) return { label: "Rallentamento lieve",   color: "#84cc16", bg: "bg-lime-500/10",  arrow: "↓", arrowColor: "text-lime-500" };
  if (pct <= 25) return { label: "Rallentamento moderato", color: "#eab308", bg: "bg-yellow-500/10", arrow: "↓", arrowColor: "text-yellow-500" };
  if (pct <= 40) return { label: "Rallentamento forte",    color: "#f97316", bg: "bg-orange-500/10", arrow: "⇊", arrowColor: "text-orange-500" };
  return          { label: "Congestione critica",          color: "#ef4444", bg: "bg-red-500/10",    arrow: "⇊", arrowColor: "text-red-500" };
}

/*
 * Fattori di conversione dalla velocità del traffico stradale
 * alla velocità commerciale stimata degli autobus.
 * La velocità commerciale TPL è molto inferiore a quella del traffico perché include:
 * - Fermate e salita/discesa passeggeri
 * - Semafori e precedenze
 * - Accelerazioni e decelerazioni continue
 * - Percorsi non ottimali (deviazioni in zona residenziale)
 *
 * Valori tipici Ancona (fonte: ISFORT, Conerobus):
 *   Urbano:      15–22 km/h  →  fattore ≈ 0.35
 *   Extraurbano: 25–35 km/h  →  fattore ≈ 0.55
 */
const TPL_FACTOR_URBANO = 0.36;
const TPL_FACTOR_EXTRA  = 0.56;

/* ────────────────────────────── TOOLTIPS ─────────────────────────────── */

const ProfileTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null;
  const hourNum = parseInt(label);
  const band = HOUR_BANDS[String(hourNum)] ?? "";
  return (
    <div className="bg-card border border-border rounded-xl px-4 py-3 shadow-xl text-xs space-y-1.5">
      <p className="font-semibold text-sm">{label} <span className="text-muted-foreground font-normal">· {band}</span></p>
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

/* ────────────────────────────── COMPONENT ────────────────────────────── */

export default function Traffic() {
  const { data: stats, isLoading } = useGetTrafficStats();
  const { data: heatmap } = useGetTrafficHeatmap({});
  const [dayType, setDayType] = useState<DayType>("feriale");

  const extStats = stats as any;
  const congestionByDayType = extStats?.congestionByDayType as Record<string, any[]> | undefined;
  const zoneStats = extStats?.zoneStats as {
    zone: string; avgCongestion: number; avgSpeed: number;
    avgFreeflow: number; samples: number; speedReduction: number;
  }[] | undefined;

  /* ── Profilo orario con tipo giorno ── */
  const hourlyData = useMemo(() => {
    const theoretical = THEORETICAL[dayType];
    const measured: Record<number, { congestion: number }> = {};
    const dayData = congestionByDayType?.[dayType] ?? [];
    if (dayData.length > 0) {
      for (const d of dayData) measured[d.hour!] = { congestion: (d.avgCongestion ?? 0) * 100 };
    } else if (stats?.congestionByHour) {
      for (const d of stats.congestionByHour) measured[d.hour!] = { congestion: (d.avgCongestion ?? 0) * 100 };
    }
    return theoretical.map(p => ({
      name: `${p.hour}:00`,
      hour: p.hour,
      modello: +(p.expected * 100).toFixed(1),
      rilevato: measured[p.hour] != null ? +measured[p.hour].congestion.toFixed(1) : null,
    }));
  }, [stats, congestionByDayType, dayType]);

  /* ── Zone data ── */
  const zoneData = useMemo(() => {
    if (zoneStats && zoneStats.length > 0) return zoneStats;
    if (!heatmap?.data) return [];
    const ZONE_DEFS = [
      { zone: "Centro storico", lat: [43.59, 43.62], lon: [13.50, 13.52] },
      { zone: "Porto / Lido", lat: [43.60, 43.63], lon: [13.52, 13.57] },
      { zone: "Zona Ovest", lat: [43.60, 43.65], lon: [13.42, 13.50] },
      { zone: "Nord / Falconara", lat: [43.62, 43.69], lon: [13.38, 13.52] },
      { zone: "Entroterra", lat: [43.40, 43.60], lon: [12.70, 13.42] },
    ];
    return ZONE_DEFS.map(z => {
      const pts = (heatmap.data ?? []).filter(h =>
        (h.lat ?? 0) >= z.lat[0] && (h.lat ?? 0) < z.lat[1] && (h.lng ?? 0) >= z.lon[0] && (h.lng ?? 0) < z.lon[1]
      );
      const avgCong = pts.length > 0 ? pts.reduce((s, p) => s + (p.avgCongestion ?? 0), 0) / pts.length : 0;
      return { zone: z.zone, avgCongestion: avgCong, avgSpeed: 0, avgFreeflow: 0, samples: pts.length, speedReduction: Math.round(avgCong * 60) };
    }).filter(z => z.samples > 0).sort((a, b) => b.avgCongestion - a.avgCongestion);
  }, [zoneStats, heatmap]);

  /* ── KPI ── */
  const avgSpeed = extStats?.avgSpeed ?? 0;
  const avgFreeflow = extStats?.avgFreeflow ?? 0;
  const overallSpeedReduction = avgFreeflow > 0 ? Math.round((1 - avgSpeed / avgFreeflow) * 100) : 0;

  // Stima velocità commerciale TPL (dal dato stradale)
  const commercialUrban = avgSpeed > 0 ? (avgSpeed * TPL_FACTOR_URBANO) : 0;
  const commercialExtra = avgSpeed > 0 ? (avgSpeed * TPL_FACTOR_EXTRA) : 0;
  const freeflowUrban = avgFreeflow > 0 ? (avgFreeflow * TPL_FACTOR_URBANO) : 0;
  const freeflowExtra = avgFreeflow > 0 ? (avgFreeflow * TPL_FACTOR_EXTRA) : 0;

  const peakHour = stats?.peakHour;
  const reliability = stats?.avgCongestion != null ? Math.max(0, 100 - Math.round(stats.avgCongestion * 100 * 1.2)) : null;

  /* ── Meteo correlazione ── */
  const { data: rawWeatherCorrelation } = useGetWeatherCorrelation({ hours: 168 });
  const { data: weatherCurrent } = useGetWeatherCurrent();
  const currentWeather = weatherCurrent?.[0];

  // Normalize: API may return array directly or { data: [...] } wrapper
  const weatherCorrelation = useMemo(() => {
    if (!rawWeatherCorrelation) return [];
    if (Array.isArray(rawWeatherCorrelation)) return rawWeatherCorrelation;
    if (Array.isArray((rawWeatherCorrelation as any).data)) return (rawWeatherCorrelation as any).data;
    return [];
  }, [rawWeatherCorrelation]);

  const weatherImpact = useMemo(() => {
    if (!weatherCorrelation || weatherCorrelation.length === 0) return null;
    // Find "Clear" baseline
    const clear = weatherCorrelation.find((w: any) => w.weather_main === "Clear");
    const baseCongestion = clear?.avg_congestion ?? 0;
    return weatherCorrelation
      .filter((w: any) => (w.sample_count ?? w.traffic_samples ?? 0) >= 2)
      .map((w: any) => ({
        condition: w.weather_main ?? "N/D",
        samples: w.sample_count ?? 0,
        avgCongestion: w.avg_congestion ?? 0,
        avgSpeed: w.avg_speed_kmh ?? 0,
        delta: baseCongestion > 0 ? ((w.avg_congestion ?? 0) - baseCongestion) / baseCongestion * 100 : 0,
        avgTemp: w.avg_temp ?? 0,
        avgHumidity: w.avg_humidity ?? 0,
      }))
      .sort((a: any, b: any) => b.avgCongestion - a.avgCongestion);
  }, [weatherCorrelation]);

  if (isLoading) {
    return (
      <div className="max-w-7xl mx-auto space-y-6 p-4">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-muted rounded w-80" />
          <div className="grid grid-cols-4 gap-4">
            {[0, 1, 2, 3].map(i => <div key={i} className="h-28 bg-muted rounded-xl" />)}
          </div>
          <div className="h-80 bg-muted rounded-xl" />
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto space-y-6 p-4 pb-8">
      {/* ═══════════ HEADER ═══════════ */}
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
        <div>
          <h1 className="text-3xl font-display font-bold text-foreground">Impatto Traffico sulla Rete TPL</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Analisi della congestione stradale e rallentamento dei mezzi pubblici · Area Ancona
          </p>
          {stats?.lastUpdated && (
            <p className="text-[11px] text-muted-foreground/60 mt-0.5 flex items-center gap-1">
              <Calendar className="w-3 h-3" />
              Dati aggiornati al {new Date(stats.lastUpdated).toLocaleDateString("it-IT", { day: "numeric", month: "long", year: "numeric" })}
            </p>
          )}
        </div>
        <div className="flex bg-muted/40 rounded-xl p-1 border border-border/40">
          {DAY_TYPE_OPTIONS.map(opt => (
            <button key={opt.value} onClick={() => setDayType(opt.value)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                dayType === opt.value
                  ? "bg-primary text-primary-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/60"
              }`}>
              <span className="mr-1">{opt.icon}</span> {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* ═══════════ KPI CARDS ═══════════ */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Velocità commerciale stimata – urbano + extraurbano */}
        <Card className="bg-card/60 backdrop-blur border-border/50 p-4 space-y-3">
          <div className="flex items-center gap-2 text-muted-foreground">
            <Bus className="w-4 h-4" />
            <span className="text-xs font-medium">Velocità commerciale stimata</span>
          </div>
          {commercialUrban > 0 ? (
            <div className="space-y-2">
              <div className="flex items-baseline justify-between">
                <span className="text-[11px] text-muted-foreground">🚌 Urbane <span className="text-muted-foreground/50">(numeri)</span></span>
                <span className="text-lg font-bold font-mono">{commercialUrban.toFixed(1)} <span className="text-xs font-normal text-muted-foreground">km/h</span></span>
              </div>
              <div className="flex items-baseline justify-between">
                <span className="text-[11px] text-muted-foreground">🚍 Extraurbane <span className="text-muted-foreground/50">(lettere)</span></span>
                <span className="text-lg font-bold font-mono">{commercialExtra.toFixed(1)} <span className="text-xs font-normal text-muted-foreground">km/h</span></span>
              </div>
              <p className="text-[10px] text-muted-foreground/60 border-t border-border/30 pt-1.5">
                Flusso libero: {freeflowUrban.toFixed(0)}–{freeflowExtra.toFixed(0)} km/h
              </p>
            </div>
          ) : (
            <span className="text-2xl font-bold font-mono text-muted-foreground">--</span>
          )}
        </Card>

        {/* Rallentamento medio */}
        <Card className="bg-card/60 backdrop-blur border-border/50 p-4 space-y-3">
          <div className="flex items-center gap-2 text-muted-foreground">
            <TrendingDown className="w-4 h-4" />
            <span className="text-xs font-medium">Rallentamento medio</span>
          </div>
          <div className="flex items-baseline gap-2">
            <span className={`text-2xl font-bold font-mono ${overallSpeedReduction > 0 ? "text-orange-500" : "text-green-500"}`}>
              {overallSpeedReduction > 0 ? `−${overallSpeedReduction}%` : overallSpeedReduction === 0 ? "0%" : `+${Math.abs(overallSpeedReduction)}%`}
            </span>
          </div>
          {/* Legenda significato */}
          <div className="space-y-1 border-t border-border/30 pt-2">
            <div className="flex items-center gap-1.5">
              <span className="text-red-500 text-sm">↓</span>
              <span className="text-[10px] text-muted-foreground">Valore negativo = mezzi <strong>più lenti</strong></span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-green-500 text-sm">↑</span>
              <span className="text-[10px] text-muted-foreground">Valore positivo = traffico <strong>più scorrevole</strong></span>
            </div>
            <p className="text-[10px] text-muted-foreground/50 pt-0.5">
              −{overallSpeedReduction}% = i bus impiegano il {overallSpeedReduction}% di tempo in più
            </p>
          </div>
        </Card>

        <StatCard title="Ora più critica" value={peakHour != null ? `${peakHour}:00` : "--"}
          description={peakHour != null ? (HOUR_BANDS[String(peakHour)] ?? "") : undefined}
          icon={AlertCircle} delay={0.1} />
        <StatCard title="Affidabilità rete" value={reliability != null ? `${reliability}%` : "--"}
          description="Prevedibilità tempi di percorrenza" icon={ShieldCheck} delay={0.15} />
      </div>

      {/* ═══════════ PROFILO CONGESTIONE ORARIO ═══════════ */}
      <Card className="bg-card/60 backdrop-blur border-border/50">
        <CardHeader>
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
            <div>
              <CardTitle className="text-base">Profilo di congestione orario</CardTitle>
              <CardDescription className="text-xs mt-1">
                <span className="inline-flex items-center gap-1">
                  <span className="w-5 h-0.5 inline-block rounded" style={{ borderTop: "2px dashed #3b82f6" }} /> Modello teorico
                </span>{" · "}
                <span className="inline-flex items-center gap-1">
                  <span className="w-5 h-0.5 bg-orange-400 inline-block rounded" /> Dati rilevati
                </span>{" · "}
                <span className="text-muted-foreground/70">
                  {DAY_TYPE_OPTIONS.find(o => o.value === dayType)?.icon}{" "}
                  {DAY_TYPE_OPTIONS.find(o => o.value === dayType)?.label}
                </span>
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="h-[340px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={hourlyData} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
                <defs>
                  <linearGradient id="gradModello" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.15} />
                    <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="gradRilevato" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#f97316" stopOpacity={0.30} />
                    <stop offset="95%" stopColor="#f97316" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                <XAxis dataKey="name" stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} />
                <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false}
                  tickFormatter={v => `${v}%`} domain={[0, 80]} />
                <Tooltip content={<ProfileTooltip />} />
                <Legend formatter={(value) => value === "modello" ? "Modello teorico" : "Rilevato"}
                  iconSize={10} wrapperStyle={{ fontSize: 11, color: "hsl(var(--muted-foreground))" }} />
                <ReferenceLine x="8:00" stroke="rgba(99,102,241,0.3)" strokeDasharray="4 2"
                  label={{ value: "Punta AM", fill: "rgba(99,102,241,0.5)", fontSize: 10, position: "top" }} />
                <ReferenceLine x="17:00" stroke="rgba(99,102,241,0.3)" strokeDasharray="4 2"
                  label={{ value: "Punta PM", fill: "rgba(99,102,241,0.5)", fontSize: 10, position: "top" }} />
                <Area type="monotone" dataKey="modello" name="modello"
                  stroke="#3b82f6" strokeWidth={2} strokeDasharray="6 3"
                  fill="url(#gradModello)" dot={false} animationDuration={800} />
                <Area type="monotone" dataKey="rilevato" name="rilevato"
                  stroke="#f97316" strokeWidth={2.5} fill="url(#gradRilevato)"
                  dot={{ r: 3, fill: "#f97316", strokeWidth: 0 }}
                  connectNulls={false} animationDuration={1000} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>

      {/* ═══════════ ZONA IMPATTO + BAR CHART ═══════════ */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Rallentamento per zona */}
        <Card className="bg-card/60 backdrop-blur border-border/50">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Bus className="w-4 h-4 text-primary" /> Rallentamento per zona
            </CardTitle>
            <CardDescription className="text-xs">
              Quanto il traffico rallenta i mezzi pubblici rispetto alla velocità a flusso libero
            </CardDescription>
          </CardHeader>
          <CardContent>
            {zoneData.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-10 gap-3 text-muted-foreground">
                <MapPin className="w-8 h-8 opacity-20" />
                <p className="text-sm">Dati di zona non ancora disponibili</p>
              </div>
            ) : (
              <div className="space-y-4">
                {zoneData.map((z) => {
                  const badge = speedReductionBadge(z.speedReduction);
                  const zoneColor = ZONE_COLORS[z.zone] ?? "#6b7280";
                  return (
                    <div key={z.zone} className="space-y-2">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2.5">
                          <div className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: zoneColor }} />
                          <span className="text-sm font-medium">{z.zone}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${badge.bg}`}
                            style={{ color: badge.color }}>
                            <span className="mr-0.5">{badge.arrow}</span>{badge.label}
                          </span>
                          <span className="text-sm font-bold font-mono" style={{ color: badge.color }}>
                            {z.speedReduction > 0 ? `−${z.speedReduction}%` : "0%"}
                          </span>
                        </div>
                      </div>
                      <div className="h-2 bg-muted/40 rounded-full overflow-hidden">
                        <div className="h-full rounded-full transition-all duration-700"
                          style={{ width: `${Math.min(z.speedReduction * 2, 100)}%`, backgroundColor: badge.color, opacity: 0.7 }} />
                      </div>
                      {z.avgSpeed > 0 && (
                        <div className="flex justify-between text-[10px] text-muted-foreground">
                          <span>🚌 Commerciale stimata: {(z.avgSpeed * TPL_FACTOR_URBANO).toFixed(1)}–{(z.avgSpeed * TPL_FACTOR_EXTRA).toFixed(1)} km/h</span>
                          <span>Flusso libero: {(z.avgFreeflow * TPL_FACTOR_URBANO).toFixed(0)}–{(z.avgFreeflow * TPL_FACTOR_EXTRA).toFixed(0)} km/h</span>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Bar chart intensità oraria */}
        <Card className="bg-card/60 backdrop-blur border-border/50">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Timer className="w-4 h-4 text-primary" /> Intensità traffico per fascia oraria
            </CardTitle>
            <CardDescription className="text-xs">
              Livello di congestione per ciascuna ora · {DAY_TYPE_OPTIONS.find(o => o.value === dayType)?.label}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {(!stats?.congestionByHour || stats.congestionByHour.length === 0) ? (
              <div className="flex flex-col items-center justify-center py-10 gap-3 text-muted-foreground">
                <Clock className="w-8 h-8 opacity-20" />
                <p className="text-sm">Dati orari non disponibili</p>
              </div>
            ) : (
              <>
                <div className="h-[260px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart
                      data={(congestionByDayType?.[dayType] ?? stats.congestionByHour).map((d: any) => ({
                        name: `${d.hour}:00`,
                        valore: +((d.avgCongestion) * 100).toFixed(1),
                        congestion: d.avgCongestion,
                      }))}
                      margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                      <XAxis dataKey="name" stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} />
                      <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false}
                        tickFormatter={v => `${v}%`} domain={[0, 80]} />
                      <Tooltip contentStyle={{ backgroundColor: "hsl(var(--card))", borderColor: "hsl(var(--border))", borderRadius: 12 }}
                        formatter={(v: any) => [`${v}%`, "Congestione"]} />
                      <Bar dataKey="valore" radius={[4, 4, 0, 0]} animationDuration={800}>
                        {(congestionByDayType?.[dayType] ?? stats.congestionByHour).map((d: any, i: number) => (
                          <Cell key={i} fill={congestionColor(d.avgCongestion)} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <div className="mt-3 flex flex-wrap gap-3 justify-center">
                  {[
                    ["#22c55e", "Scorrevole", "< 25%"],
                    ["#84cc16", "Fluido", "25–45%"],
                    ["#eab308", "Moderato", "45–60%"],
                    ["#f97316", "Rallentato", "60–75%"],
                    ["#ef4444", "Congestionato", "> 75%"],
                  ].map(([c, l, r]) => (
                    <div key={l} className="flex items-center gap-1.5">
                      <div className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: c }} />
                      <span className="text-[10px] text-muted-foreground">{l} <span className="text-muted-foreground/50">({r})</span></span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ═══════════ CLASSIFICA ZONE ═══════════ */}
      {zoneData.length > 0 && (
        <Card className="bg-card/60 backdrop-blur border-border/50">
          <CardHeader>
            <CardTitle className="text-base">Classifica zone per impatto sulla rete TPL</CardTitle>
            <CardDescription className="text-xs">
              Aree ordinate per il livello di rallentamento medio dei mezzi pubblici
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-3">
              {zoneData.map((z, i) => {
                const badge = speedReductionBadge(z.speedReduction);
                const zoneColor = ZONE_COLORS[z.zone] ?? "#6b7280";
                return (
                  <div key={z.zone}
                    className="relative p-4 rounded-xl bg-background/40 border border-border/30 hover:border-border/60 transition-colors">
                    <div className="absolute -top-2 -left-2 w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold text-white shadow-md"
                      style={{ backgroundColor: zoneColor }}>{i + 1}</div>
                    <div className="pt-1 space-y-2">
                      <p className="text-sm font-semibold">{z.zone}</p>
                      <div className="flex items-baseline gap-1.5">
                        <span className="text-xl" style={{ color: badge.color }}>{badge.arrow}</span>
                        <span className="text-2xl font-bold font-mono" style={{ color: badge.color }}>
                          {z.speedReduction > 0 ? `−${z.speedReduction}%` : "0%"}
                        </span>
                      </div>
                      <p className="text-[10px]" style={{ color: badge.color }}>{badge.label}</p>
                      <div className="text-[10px] text-muted-foreground space-y-0.5">
                        <p>Congestione: {(z.avgCongestion * 100).toFixed(0)}%</p>
                        {z.avgSpeed > 0 && <p>🚌 {(z.avgSpeed * TPL_FACTOR_URBANO).toFixed(0)}–{(z.avgSpeed * TPL_FACTOR_EXTRA).toFixed(0)} km/h commerciale</p>}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* ═══════════ CORRELAZIONE METEO-TRAFFICO ═══════════ */}
      <Card className="bg-card/60 backdrop-blur border-border/50">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Cloud className="w-4 h-4 text-blue-400" /> Correlazione Meteo ↔ Traffico
          </CardTitle>
          <CardDescription className="text-xs">
            Come le condizioni meteo influenzano la congestione e la velocità dei mezzi
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Current weather card */}
          {currentWeather && (
            <div className="flex items-center gap-4 bg-gradient-to-r from-blue-500/5 to-cyan-500/5 border border-blue-500/20 rounded-xl p-4">
              <span className="text-3xl">
                {currentWeather.weatherMain === "Clear" ? "☀️" : currentWeather.weatherMain === "Clouds" ? "☁️" : currentWeather.weatherMain === "Rain" ? "🌧️" : currentWeather.weatherMain === "Snow" ? "🌨️" : "🌡️"}
              </span>
              <div className="flex-1">
                <p className="text-sm font-semibold">Condizioni attuali — {currentWeather.locationName}</p>
                <p className="text-xs text-muted-foreground">
                  {Math.round(currentWeather.temp ?? 0)}°C · {currentWeather.weatherDescription} ·{" "}
                  <Droplets className="w-3 h-3 inline" /> {currentWeather.humidity}% ·{" "}
                  <Wind className="w-3 h-3 inline" /> {((currentWeather.windSpeed ?? 0) * 3.6).toFixed(0)} km/h
                </p>
              </div>
              {currentWeather.rain1h != null && currentWeather.rain1h > 0 && (
                <div className="text-right">
                  <p className="text-sm font-bold text-blue-400">{currentWeather.rain1h.toFixed(1)} mm/h</p>
                  <p className="text-[10px] text-blue-400/70">pioggia in corso</p>
                </div>
              )}
            </div>
          )}

          {/* Correlation table */}
          {weatherImpact && weatherImpact.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border/40 text-muted-foreground text-[10px] uppercase tracking-wide">
                    <th className="text-left px-3 py-2">Condizione</th>
                    <th className="text-right px-3 py-2">Campioni</th>
                    <th className="text-right px-3 py-2">Congestione media</th>
                    <th className="text-right px-3 py-2">Vel. media</th>
                    <th className="text-right px-3 py-2">Δ vs Sereno</th>
                  </tr>
                </thead>
                <tbody>
                  {weatherImpact.map((w: any) => {
                    const icon = w.condition === "Clear" ? "☀️" : w.condition === "Clouds" ? "☁️" : w.condition === "Rain" ? "🌧️" : w.condition === "Drizzle" ? "🌦️" : w.condition === "Snow" ? "🌨️" : w.condition === "Thunderstorm" ? "⛈️" : w.condition === "Mist" || w.condition === "Fog" ? "🌫️" : "🌡️";
                    const deltaColor = w.delta > 20 ? "text-red-400" : w.delta > 5 ? "text-orange-400" : w.delta > -5 ? "text-muted-foreground" : "text-green-400";
                    return (
                      <tr key={w.condition} className="border-b border-border/20 hover:bg-muted/20 transition-colors">
                        <td className="px-3 py-2">
                          <span className="mr-1.5">{icon}</span>
                          <span className="text-xs font-medium">{w.condition}</span>
                        </td>
                        <td className="px-3 py-2 text-right text-muted-foreground font-mono text-xs">{w.samples}</td>
                        <td className="px-3 py-2 text-right">
                          <span className="font-mono font-bold text-xs" style={{ color: congestionColor(w.avgCongestion) }}>
                            {(w.avgCongestion * 100).toFixed(0)}%
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-xs">
                          {w.avgSpeed > 0 ? `${w.avgSpeed.toFixed(0)} km/h` : "—"}
                        </td>
                        <td className={`px-3 py-2 text-right font-mono font-bold text-xs ${deltaColor}`}>
                          {w.delta > 0 ? "+" : ""}{w.delta.toFixed(0)}%
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="text-center py-8 text-muted-foreground">
              <Cloud className="w-8 h-8 mx-auto opacity-20 mb-2" />
              <p className="text-xs">Dati di correlazione meteo non ancora disponibili.</p>
              <p className="text-[10px] text-muted-foreground/60">Verranno raccolti automaticamente via cron ogni 3 ore.</p>
            </div>
          )}

          {/* Insight box */}
          {weatherImpact && weatherImpact.some((w: any) => w.condition === "Rain" && w.delta > 10) && (
            <div className="rounded-xl border border-blue-500/20 bg-blue-500/5 px-4 py-3">
              <div className="flex items-start gap-2">
                <AlertCircle className="w-4 h-4 text-blue-400 shrink-0 mt-0.5" />
                <div className="text-xs text-muted-foreground">
                  <p className="font-semibold text-blue-400 mb-1">Impatto pioggia sulla rete TPL</p>
                  <p>
                    Nei giorni di pioggia la congestione aumenta del{" "}
                    <strong className="text-blue-400">
                      +{weatherImpact.find((w: any) => w.condition === "Rain")?.delta.toFixed(0)}%
                    </strong>{" "}
                    rispetto al sereno, causando rallentamenti sulla velocità commerciale dei mezzi.
                    Considera di prevedere <strong>tempi di percorrenza maggiorati</strong> nei giorni di maltempo
                    e comunicare ai passeggeri possibili ritardi.
                  </p>
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ═══════════ NOTE ═══════════ */}
      <div className="rounded-xl border border-border/30 bg-muted/10 px-4 py-3 text-[11px] text-muted-foreground/70 space-y-2">
        <p className="font-semibold text-muted-foreground/90">Note metodologiche</p>
        <p>
          I dati rilevati provengono dalla raccolta automatica di velocità e tempi di percorrenza del <strong>traffico stradale</strong> nell'area 
          metropolitana di Ancona (ultimi 90 giorni). Il modello teorico è basato su curve di domanda di mobilità italiane 
          (fonte ISFORT/CNR) adattate al contesto locale.
        </p>
        <p>
          <strong>Velocità commerciale stimata:</strong> la velocità del traffico stradale <strong>non</strong> coincide con quella degli autobus.
          La velocità commerciale TPL tiene conto di fermate, salita/discesa passeggeri, semafori, percorsi obbligati e accelerazioni/decelerazioni.
          I fattori di conversione usati (urbano ×{TPL_FACTOR_URBANO}, extraurbano ×{TPL_FACTOR_EXTRA}) sono derivati dai valori medi
          nazionali ISFORT e dai dati operativi Conerobus, producendo stime coerenti con il range tipico
          di <strong>15–22 km/h</strong> (linee urbane numerate) e <strong>25–35 km/h</strong> (linee extraurbane con lettera).
        </p>
        <p>
          <strong>Rallentamento (%):</strong> indica quanto il traffico riduce la velocità rispetto al flusso libero.
          Un valore <span className="text-red-400 font-semibold">−5%</span> significa che i mezzi sono <strong>più lenti del 5%</strong> 
          rispetto alle condizioni ottimali (↓ = più lento, ↑ = più veloce). L'<strong>affidabilità</strong> stima la prevedibilità dei 
          tempi di percorrenza (100% = nessuna variabilità da congestione).
        </p>
      </div>
    </div>
  );
}
