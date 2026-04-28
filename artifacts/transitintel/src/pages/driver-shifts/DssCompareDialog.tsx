/**
 * DssCompareDialog — confronta side-by-side due DSS salvati (#9).
 * Mostra KPI principali con delta colorato (verde/rosso secondo "lower is better").
 */
import { useEffect, useMemo, useState } from "react";
import { X, ArrowRightLeft, Loader2 } from "lucide-react";
import { getApiBase } from "@/lib/api";
import { TYPE_LABELS, formatDuration } from "./constants";
import type { DriverShiftsResult, DriverShiftSummary, DriverShiftType } from "./types";

interface SavedDssRow { id: string; name: string; createdAt: string; summary?: any; }

interface Props {
  scenarioId: string;
  savedDss: SavedDssRow[];
  defaultLeftId?: string | null;
  defaultRightId?: string | null;
  onClose: () => void;
}

interface LoadedDss { id: string; name: string; result: DriverShiftsResult; createdAt: string; }

async function fetchDssFull(scenarioId: string, dssId: string): Promise<LoadedDss | null> {
  try {
    const r = await fetch(`${getApiBase()}/api/driver-shifts/${scenarioId}/scenarios/${dssId}`);
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

type Trend = "good" | "bad" | "same";

function deltaCell(curr: number | undefined, base: number | undefined, opts: { lowerIsBetter?: boolean; format?: (n: number) => string; unit?: string } = {}) {
  if (curr === undefined || base === undefined || isNaN(curr) || isNaN(base)) {
    return { text: "—", trend: "same" as Trend, raw: 0 };
  }
  const d = curr - base;
  const lower = opts.lowerIsBetter ?? true;
  let trend: Trend = "same";
  if (Math.abs(d) > 0.001) trend = (lower ? d < 0 : d > 0) ? "good" : "bad";
  const sign = d > 0 ? "+" : "";
  const text = opts.format ? `${sign}${opts.format(d)}` : `${sign}${d.toFixed(1)}${opts.unit ?? ""}`;
  return { text, trend, raw: d };
}

function trendColor(t: Trend): string {
  return t === "good" ? "text-emerald-400" : t === "bad" ? "text-red-400" : "text-muted-foreground";
}

export function DssCompareDialog({ scenarioId, savedDss, defaultLeftId, defaultRightId, onClose }: Props) {
  const [leftId, setLeftId] = useState<string>(defaultLeftId ?? savedDss[0]?.id ?? "");
  const [rightId, setRightId] = useState<string>(defaultRightId ?? savedDss[1]?.id ?? savedDss[0]?.id ?? "");
  const [left, setLeft] = useState<LoadedDss | null>(null);
  const [right, setRight] = useState<LoadedDss | null>(null);
  const [loadingL, setLoadingL] = useState(false);
  const [loadingR, setLoadingR] = useState(false);

  useEffect(() => {
    if (!leftId) { setLeft(null); return; }
    setLoadingL(true);
    fetchDssFull(scenarioId, leftId).then(d => { setLeft(d); }).finally(() => setLoadingL(false));
  }, [scenarioId, leftId]);

  useEffect(() => {
    if (!rightId) { setRight(null); return; }
    setLoadingR(true);
    fetchDssFull(scenarioId, rightId).then(d => { setRight(d); }).finally(() => setLoadingR(false));
  }, [scenarioId, rightId]);

  const sL: DriverShiftSummary | undefined = left?.result?.summary;
  const sR: DriverShiftSummary | undefined = right?.result?.summary;

  const swap = () => { const t = leftId; setLeftId(rightId); setRightId(t); };

  const rows = useMemo(() => {
    const allTypes: DriverShiftType[] = sL?.byType ? (Object.keys(sL.byType) as DriverShiftType[]) : [];
    const typeRows = allTypes.map(t => ({
      label: TYPE_LABELS[t] ?? t,
      l: sL?.byType?.[t] ?? 0,
      r: sR?.byType?.[t] ?? 0,
      lowerIsBetter: false,
      indent: true,
    }));
    return [
      { label: "Autisti totali",      l: sL?.totalDriverShifts, r: sR?.totalDriverShifts, lowerIsBetter: true,  unit: "" },
      { label: "Ore lavoro totali",   l: sL?.totalWorkHours,    r: sR?.totalWorkHours,    lowerIsBetter: true,  unit: " h" },
      { label: "Costo giornaliero",   l: sL?.totalDailyCost,    r: sR?.totalDailyCost,    lowerIsBetter: true,  format: (n: number) => `${n >= 0 ? "" : "-"}€${Math.abs(n).toFixed(0)}` },
      { label: "Efficienza",          l: sL?.efficiency,        r: sR?.efficiency,        lowerIsBetter: false, unit: "%" },
      { label: "% Semiunico",         l: sL?.semiunicoPct,      r: sR?.semiunicoPct,      lowerIsBetter: false, unit: "%" },
      { label: "% Spezzato",          l: sL?.spezzatoPct,       r: sR?.spezzatoPct,       lowerIsBetter: true,  unit: "%" },
      { label: "Cambi totali",        l: sL?.totalCambi,        r: sR?.totalCambi,        lowerIsBetter: true,  unit: "" },
      { label: "Auto aziendali usate",l: sL?.companyCarsUsed,   r: sR?.companyCarsUsed,   lowerIsBetter: true,  unit: "" },
      { divider: true } as any,
      { sectionLabel: "Ripartizione per tipo turno" } as any,
      ...typeRows,
    ] as Array<any>;
  }, [sL, sR]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="w-full max-w-4xl max-h-[90vh] overflow-hidden rounded-lg border border-orange-500/30 bg-background shadow-2xl flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-border/40 bg-muted/30">
          <h2 className="text-sm font-semibold flex items-center gap-2 text-orange-300">
            <ArrowRightLeft className="w-4 h-4" /> Confronto DSS salvati
          </h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-white/5">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Selettori */}
        <div className="grid grid-cols-[1fr_auto_1fr] gap-2 px-4 py-3 border-b border-border/40 items-center">
          <select
            value={leftId}
            onChange={e => setLeftId(e.target.value)}
            className="text-xs bg-background border border-border/50 rounded px-2 py-1.5 text-orange-200"
          >
            {savedDss.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <button onClick={swap} className="p-1.5 rounded border border-orange-500/30 bg-orange-500/8 hover:bg-orange-500/15" title="Scambia">
            <ArrowRightLeft className="w-3.5 h-3.5 text-orange-300" />
          </button>
          <select
            value={rightId}
            onChange={e => setRightId(e.target.value)}
            className="text-xs bg-background border border-border/50 rounded px-2 py-1.5 text-purple-200"
          >
            {savedDss.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>

        {/* Tabella */}
        <div className="flex-1 overflow-auto p-4">
          {(loadingL || loadingR) && (
            <div className="flex items-center justify-center py-8 text-xs text-muted-foreground gap-2">
              <Loader2 className="w-4 h-4 animate-spin" /> Caricamento DSS…
            </div>
          )}
          {!loadingL && !loadingR && (!left || !right) && (
            <div className="text-xs text-muted-foreground text-center py-6">Seleziona due scenari da confrontare.</div>
          )}
          {!loadingL && !loadingR && left && right && (
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border/40 text-[10px] uppercase tracking-wider text-muted-foreground">
                  <th className="text-left py-1.5 pr-2 w-1/3">Metrica</th>
                  <th className="text-right py-1.5 px-2 text-orange-300">{left.name}</th>
                  <th className="text-right py-1.5 px-2 text-purple-300">{right.name}</th>
                  <th className="text-right py-1.5 pl-2">Δ (R−L)</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, idx) => {
                  if (row.divider) return <tr key={idx}><td colSpan={4} className="pt-3"></td></tr>;
                  if (row.sectionLabel) return (
                    <tr key={idx} className="border-b border-border/30">
                      <td colSpan={4} className="py-1 text-[10px] uppercase tracking-wider text-muted-foreground/80 font-semibold">
                        {row.sectionLabel}
                      </td>
                    </tr>
                  );
                  const d = deltaCell(row.r, row.l, { lowerIsBetter: row.lowerIsBetter, format: row.format, unit: row.unit });
                  const fmt = (n: number | undefined) => {
                    if (n === undefined || n === null) return "—";
                    if (row.format) return row.format(n);
                    if (row.unit === "%") return `${n.toFixed(1)}%`;
                    if (row.unit === " h") return formatDuration(n * 60);
                    return n.toString();
                  };
                  return (
                    <tr key={idx} className="border-b border-border/20 hover:bg-white/3">
                      <td className={`py-1.5 pr-2 ${row.indent ? "pl-4 text-muted-foreground" : "font-medium"}`}>{row.label}</td>
                      <td className="text-right py-1.5 px-2 tabular-nums text-orange-200">{fmt(row.l)}</td>
                      <td className="text-right py-1.5 px-2 tabular-nums text-purple-200">{fmt(row.r)}</td>
                      <td className={`text-right py-1.5 pl-2 tabular-nums font-medium ${trendColor(d.trend)}`}>{d.text}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-2 border-t border-border/40 bg-muted/20 text-[10px] text-muted-foreground italic">
          Δ in <span className="text-emerald-400">verde</span> = miglioramento del DSS destro · in <span className="text-red-400">rosso</span> = peggioramento.
        </div>
      </div>
    </div>
  );
}
