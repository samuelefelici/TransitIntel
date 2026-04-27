/**
 * DemandVsSupplyChart — confronto offerta reale (Bar) vs domanda attesa (Area).
 * Evidenzia ore sotto/sovra-servite con bande colorate sul background.
 */
import { useMemo } from "react";
import {
  ComposedChart, Bar, Area, XAxis, YAxis, CartesianGrid,
  ResponsiveContainer, Tooltip as RTooltip, ReferenceArea, Cell,
} from "recharts";
import { AlertCircle } from "lucide-react";

type Props = {
  byHour: { hour: number; trips: number }[];
  expectedProfile?: number[];      // 24 valori 0..1
  rationale?: string;
  warning?: string;
};

export default function DemandVsSupplyChart({ byHour, expectedProfile, rationale, warning }: Props) {
  const data = useMemo(() => {
    const maxTrips = Math.max(1, ...byHour.map((d) => d.trips));
    return byHour.map((d) => {
      const expectedNorm = expectedProfile?.[d.hour] ?? 0;
      const expected = expectedNorm * maxTrips;
      const supplyNorm = d.trips / maxTrips;
      const delta = supplyNorm - expectedNorm;
      let status: "under" | "over" | "ok" = "ok";
      if (expectedNorm >= 0.15 && delta < -0.3) status = "under";
      else if (delta > 0.3) status = "over";
      return { hour: d.hour, trips: d.trips, expected: Math.round(expected * 10) / 10, expectedNorm, status };
    });
  }, [byHour, expectedProfile]);

  const underHours = data.filter((d) => d.status === "under").map((d) => d.hour);
  const overHours = data.filter((d) => d.status === "over").map((d) => d.hour);

  // indice di allineamento: Σ min(s,d) / Σ max(s,d) (su normalizzati)
  const alignment = useMemo(() => {
    if (!expectedProfile) return null;
    const maxTrips = Math.max(1, ...byHour.map((d) => d.trips));
    let mn = 0, mx = 0;
    for (const d of byHour) {
      const s = d.trips / maxTrips;
      const e = expectedProfile[d.hour] ?? 0;
      mn += Math.min(s, e);
      mx += Math.max(s, e);
    }
    return mx > 0 ? Math.round((mn / mx) * 100) : null;
  }, [byHour, expectedProfile]);

  return (
    <div className="bg-card border border-border rounded-lg p-3">
      <div className="flex items-center gap-2 mb-1">
        <div className="text-sm font-semibold">Domanda attesa vs offerta reale</div>
        {warning && (
          <span className="text-[10px] text-amber-400 flex items-center gap-1">
            <AlertCircle className="w-3 h-3" /> {warning}
          </span>
        )}
      </div>
      {rationale && <div className="text-[11px] text-muted-foreground mb-2">{rationale}</div>}

      <div className="h-[200px]" role="img" aria-label="Grafico domanda attesa vs offerta oraria">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data}>
            <CartesianGrid strokeDasharray="3 3" stroke="#374151" opacity={0.3} />
            <XAxis dataKey="hour" tick={{ fontSize: 10 }} tickFormatter={(h) => `${h}h`} />
            <YAxis tick={{ fontSize: 10 }} />
            {/* bande di disallineamento */}
            {underHours.map((h) => (
              <ReferenceArea key={`u${h}`} x1={h - 0.5} x2={h + 0.5} fill="#ef4444" fillOpacity={0.12} />
            ))}
            {overHours.map((h) => (
              <ReferenceArea key={`o${h}`} x1={h - 0.5} x2={h + 0.5} fill="#f59e0b" fillOpacity={0.12} />
            ))}
            <RTooltip
              contentStyle={{ background: "#1f2937", border: "1px solid #374151", borderRadius: 6, fontSize: 12 }}
              formatter={(v: any, key) => key === "trips" ? [`${v} corse`, "offerta"] : [`${v} corse equiv.`, "domanda attesa"]}
              labelFormatter={(h) => `Ora ${h}:00`}
            />
            {expectedProfile && (
              <Area type="monotone" dataKey="expected" fill="#93c5fd" stroke="#60a5fa" fillOpacity={0.35} strokeWidth={1.5} />
            )}
            <Bar dataKey="trips" radius={[3, 3, 0, 0]}>
              {data.map((d, i) => (
                <Cell
                  key={i}
                  fill={d.status === "under" ? "#ef4444" : d.status === "over" ? "#f59e0b" : "#1e40af"}
                />
              ))}
            </Bar>
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <div className="flex flex-wrap gap-3 mt-2 text-[11px]">
        <Kpi label="Ore sotto-servite" value={underHours.length} tone="bad" hint={underHours.length > 0 ? `(${underHours.join(", ")})` : ""} />
        <Kpi label="Ore sovra-offerte" value={overHours.length} tone="warn" hint={overHours.length > 0 ? `(${overHours.join(", ")})` : ""} />
        {alignment != null && (
          <Kpi label="Indice allineamento" value={`${alignment}/100`} tone={alignment >= 70 ? "good" : alignment >= 50 ? "warn" : "bad"} />
        )}
      </div>
      <div className="text-[10px] text-muted-foreground mt-1">
        <span className="inline-block w-2 h-2 bg-blue-700 rounded mr-1" />offerta · 
        <span className="inline-block w-2 h-2 bg-blue-300 rounded ml-2 mr-1" />domanda attesa · 
        <span className="inline-block w-2 h-2 bg-red-500 rounded ml-2 mr-1" />sotto-servizio · 
        <span className="inline-block w-2 h-2 bg-amber-500 rounded ml-2 mr-1" />sovra-offerta
      </div>
    </div>
  );
}

function Kpi({ label, value, tone, hint }: { label: string; value: any; tone: "good"|"warn"|"bad"|"neutral"; hint?: string }) {
  const cls = tone === "good" ? "text-emerald-400" : tone === "warn" ? "text-amber-400" : tone === "bad" ? "text-red-400" : "";
  return (
    <div className="bg-muted/20 rounded px-2 py-1">
      <div className="text-[9px] text-muted-foreground uppercase">{label}</div>
      <div className={`font-semibold ${cls}`}>{value} <span className="text-[9px] opacity-70">{hint}</span></div>
    </div>
  );
}
