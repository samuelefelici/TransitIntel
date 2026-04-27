/**
 * CoverageRadar — radar copertura per categoria POI rilevante.
 * Mostra solo categorie con relevance > 0.3, max 8 assi, con poligono target 80%.
 */
import { useMemo } from "react";
import {
  Radar, RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis,
  ResponsiveContainer, Tooltip as RTooltip, Legend,
} from "recharts";

type PoiCategory = {
  category: string;
  total: number;
  served: number;
  relevance?: number;     // 0..1 (peso stagionale/contestuale)
};

type Props = {
  categories: PoiCategory[];
  target?: number;        // 0..100, default 80
};

const LABELS: Record<string, string> = {
  school: "Scuole",
  hospital: "Sanità",
  shopping: "Commercio",
  beach: "Spiagge",
  seaside: "Costa",
  tourism: "Turismo",
  workplace: "Lavoro",
  office: "Uffici",
  university: "Università",
  restaurant: "Ristoranti",
  bar: "Bar",
  leisure: "Tempo libero",
  church: "Culto",
  worship: "Culto",
};

export default function CoverageRadar({ categories, target = 80 }: Props) {
  const data = useMemo(() => {
    const filtered = categories
      .filter((c) => (c.relevance ?? 1) > 0.3 && c.total > 0)
      .map((c) => ({
        category: LABELS[c.category] ?? c.category,
        coverage: Math.round((c.served / c.total) * 100),
        target,
        total: c.total,
        served: c.served,
      }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 8);
    return filtered;
  }, [categories, target]);

  if (data.length === 0) {
    return (
      <div className="bg-card border border-border rounded-lg p-3 text-xs text-muted-foreground">
        Nessuna categoria POI rilevante per il contesto selezionato.
      </div>
    );
  }

  return (
    <div className="bg-card border border-border rounded-lg p-3">
      <div className="text-sm font-semibold mb-1">Copertura per categoria POI</div>
      <div className="text-[11px] text-muted-foreground mb-2">
        Solo categorie pertinenti al contesto (rilevanza &gt; 30%). Target di riferimento: {target}%.
      </div>
      <div className="h-[240px]" role="img" aria-label="Radar copertura POI per categoria">
        <ResponsiveContainer width="100%" height="100%">
          <RadarChart data={data}>
            <PolarGrid stroke="#374151" />
            <PolarAngleAxis dataKey="category" tick={{ fontSize: 10, fill: "#cbd5e1" }} />
            <PolarRadiusAxis angle={90} domain={[0, 100]} tick={{ fontSize: 9 }} />
            <Radar
              name={`Target ${target}%`}
              dataKey="target"
              stroke="#64748b"
              fill="#64748b"
              fillOpacity={0.1}
              strokeDasharray="4 4"
            />
            <Radar
              name="Copertura attuale"
              dataKey="coverage"
              stroke="#10b981"
              fill="#10b981"
              fillOpacity={0.35}
            />
            <Legend wrapperStyle={{ fontSize: 10 }} />
            <RTooltip
              contentStyle={{ background: "#1f2937", border: "1px solid #374151", borderRadius: 6, fontSize: 12 }}
              formatter={(v: any, _n, p: any) =>
                p.dataKey === "coverage"
                  ? [`${v}% (${p.payload.served}/${p.payload.total})`, "copertura"]
                  : [`${v}%`, "target"]
              }
            />
          </RadarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
