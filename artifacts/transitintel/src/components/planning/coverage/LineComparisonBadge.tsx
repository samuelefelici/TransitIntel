/**
 * LineComparisonBadge — confronto linee selezionate vs rete totale.
 * Mostra contributo % e popolazione esclusiva tramite barra bicolore + narrativa.
 */
import { GitCompare } from "lucide-react";

export type RouteComparison = {
  filteredRoutes: string[];
  baselineCoveragePct: number;
  filteredCoveragePct: number;
  filteredContributionPct: number;
  populationOnlyOnFiltered: number;
  populationLostIfRemoved: number;
};

type Props = {
  comparison?: RouteComparison | null;
};

const fmtPop = (n: number) =>
  n >= 1000 ? `${(n / 1000).toFixed(1)}k` : Math.round(n).toLocaleString("it-IT");

export default function LineComparisonBadge({ comparison }: Props) {
  if (!comparison || comparison.filteredRoutes.length === 0) return null;

  const {
    filteredRoutes,
    baselineCoveragePct,
    filteredCoveragePct,
    filteredContributionPct,
    populationLostIfRemoved,
  } = comparison;

  const contribution = Math.max(0, Math.min(100, filteredContributionPct));
  const overlap = Math.max(0, 100 - contribution);

  const labelLines =
    filteredRoutes.length <= 3
      ? filteredRoutes.join(", ")
      : `${filteredRoutes.slice(0, 3).join(", ")} +${filteredRoutes.length - 3}`;

  let tone: "good" | "warn" | "neutral" = "neutral";
  let narrative = "";
  if (contribution >= 60) {
    tone = "good";
    narrative = `Le linee selezionate (${labelLines}) coprono territorio ampiamente esclusivo: rappresentano il ${contribution.toFixed(0)}% della copertura totale. Rimuoverle lascerebbe ${fmtPop(populationLostIfRemoved)} abitanti senza servizio.`;
  } else if (contribution >= 30) {
    tone = "warn";
    narrative = `Le linee selezionate contribuiscono per il ${contribution.toFixed(0)}% della copertura, con sovrapposizione parziale (${overlap.toFixed(0)}%) ad altre linee della rete.`;
  } else {
    tone = "neutral";
    narrative = `Le linee selezionate aggiungono solo il ${contribution.toFixed(0)}% di copertura esclusiva: forte sovrapposizione (${overlap.toFixed(0)}%) con il resto della rete. Possibile candidato a razionalizzazione.`;
  }

  const toneCls =
    tone === "good"
      ? "border-emerald-500/40 bg-emerald-500/5"
      : tone === "warn"
      ? "border-amber-500/40 bg-amber-500/5"
      : "border-border bg-muted/10";

  return (
    <div className={`rounded-lg border p-3 ${toneCls}`}>
      <div className="flex items-center gap-2 mb-2">
        <GitCompare className="w-4 h-4 text-blue-400" />
        <div className="text-sm font-semibold">Confronto linee selezionate vs rete</div>
      </div>

      <div className="grid grid-cols-3 gap-2 text-[11px] mb-2">
        <KPI label="Copertura rete totale" value={`${baselineCoveragePct.toFixed(1)}%`} />
        <KPI label="Copertura linee scelte" value={`${filteredCoveragePct.toFixed(1)}%`} />
        <KPI label="Contributo esclusivo" value={`${contribution.toFixed(0)}%`} />
      </div>

      {/* barra bicolore */}
      <div
        className="w-full h-3 rounded overflow-hidden flex"
        role="img"
        aria-label={`Contributo esclusivo ${contribution.toFixed(0)}%, sovrapposizione ${overlap.toFixed(0)}%`}
      >
        <div className="bg-blue-500" style={{ width: `${contribution}%` }} title={`Esclusivo ${contribution.toFixed(0)}%`} />
        <div className="bg-slate-500/60" style={{ width: `${overlap}%` }} title={`Sovrapposizione ${overlap.toFixed(0)}%`} />
      </div>
      <div className="flex justify-between text-[9px] text-muted-foreground mt-1">
        <span>Esclusivo</span>
        <span>Sovrapposto ad altre linee</span>
      </div>

      <p className="text-[12px] text-foreground/90 mt-2 leading-relaxed">{narrative}</p>
    </div>
  );
}

function KPI({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-muted/20 rounded px-2 py-1">
      <div className="text-[9px] text-muted-foreground uppercase">{label}</div>
      <div className="font-semibold">{value}</div>
    </div>
  );
}
