import React, { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import type { ServiceCategory } from "@/pages/optimizer-route/types";
import type { DeadheadEstimate } from "@/pages/fucina/deadhead-calculator";

interface Props {
  open: boolean;
  anchor: { x: number; y: number } | null;
  mode: "before" | "after";
  category: ServiceCategory;
  stopOptions: string[];
  defaultFromStop: string;
  defaultToStop: string;
  gapMin: number;
  onClose: () => void;
  onInsert: (data: {
    fromStop: string;
    toStop: string;
    km: number;
    durationMin: number;
  }) => void;
  calculate: (fromStop: string, toStop: string, category: ServiceCategory) => DeadheadEstimate;
}

function InlineDeadheadPopoverComponent({
  open,
  anchor,
  mode,
  category,
  stopOptions,
  defaultFromStop,
  defaultToStop,
  gapMin,
  onClose,
  onInsert,
  calculate,
}: Props) {
  const [fromStop, setFromStop] = useState(defaultFromStop);
  const [toStop, setToStop] = useState(defaultToStop);
  const [km, setKm] = useState(0);
  const [durationMin, setDurationMin] = useState(1);
  const [kmAuto, setKmAuto] = useState(true);
  const [durationAuto, setDurationAuto] = useState(true);
  const [source, setSource] = useState<DeadheadEstimate["source"]>("fallback");

  useEffect(() => {
    const first = stopOptions[0] ?? "";
    setFromStop(defaultFromStop || first);
    setToStop(defaultToStop || first);
    setKmAuto(true);
    setDurationAuto(true);
  }, [defaultFromStop, defaultToStop, mode, open, stopOptions]);

  useEffect(() => {
    const est = calculate(fromStop, toStop, category);
    setSource(est.source);
    if (kmAuto) setKm(est.km);
    if (durationAuto) setDurationMin(est.durationMin);
  }, [fromStop, toStop, category, calculate, kmAuto, durationAuto]);

  const overlapMin = Math.max(0, durationMin - Math.max(0, gapMin));
  const canInsert = fromStop.trim().length > 0 && toStop.trim().length > 0 && overlapMin === 0;

  const sourceLabel = useMemo(() => {
    if (source === "matrix") return "matrice deadhead";
    if (source === "haversine") return "coordinate GTFS";
    return "fallback";
  }, [source]);

  if (!open || !anchor) return null;

  return (
    <div
      className="fixed z-[65] w-[360px] rounded-lg border border-orange-500/30 bg-background/95 backdrop-blur p-3 shadow-2xl"
      style={{ left: anchor.x, top: anchor.y }}
      role="dialog"
      aria-label="Inserimento trasferimento a vuoto"
    >
      <div className="text-[12px] font-semibold text-orange-300 mb-2">
        ↝ Inserisci vuoto {mode === "before" ? "prima" : "dopo"} la corsa
      </div>

      <div className="grid grid-cols-1 gap-2">
        <div>
          <Label className="text-[10px]">Fermata di partenza</Label>
          <select
            value={fromStop}
            onChange={e => setFromStop(e.target.value)}
            className="h-7 w-full rounded border border-input bg-background px-2 text-[11px]"
          >
            {stopOptions.map(stop => (
              <option key={stop} value={stop}>{stop}</option>
            ))}
          </select>
        </div>

        <div>
          <Label className="text-[10px]">Fermata di arrivo</Label>
          <select
            value={toStop}
            onChange={e => setToStop(e.target.value)}
            className="h-7 w-full rounded border border-input bg-background px-2 text-[11px]"
          >
            {stopOptions.map(stop => (
              <option key={stop} value={stop}>{stop}</option>
            ))}
          </select>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div>
            <Label className="text-[10px]">Tempo (min)</Label>
            <div className="flex items-center gap-1">
              <input
                type="number"
                min={1}
                value={durationMin}
                onChange={e => {
                  setDurationMin(Math.max(1, parseInt(e.target.value || "1", 10)));
                  setDurationAuto(false);
                }}
                className="h-7 w-full rounded border border-input bg-background px-2 text-[11px] font-mono"
              />
              {durationAuto && <Badge className="text-[9px]">auto-calcolato</Badge>}
            </div>
          </div>

          <div>
            <Label className="text-[10px]">Km</Label>
            <div className="flex items-center gap-1">
              <input
                type="number"
                min={0}
                step={0.1}
                value={km}
                onChange={e => {
                  setKm(Math.max(0, parseFloat(e.target.value || "0")));
                  setKmAuto(false);
                }}
                className="h-7 w-full rounded border border-input bg-background px-2 text-[11px] font-mono"
              />
              {kmAuto && <Badge className="text-[9px]">auto-calcolato</Badge>}
            </div>
          </div>
        </div>

        <div className="text-[10px] text-muted-foreground">
          Fonte stima: <span className="text-orange-300">{sourceLabel}</span> · gap disponibile: {gapMin}′
        </div>

        {overlapMin > 0 && (
          <div className="text-[10px] text-red-300 border border-red-500/30 bg-red-500/10 rounded px-2 py-1">
            ⚠ Sovrapposizione con corsa successiva (mancano {overlapMin} min)
          </div>
        )}
      </div>

      <div className="mt-3 flex items-center justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onClose} className="h-7 text-[11px]">
          Annulla
        </Button>
        <Button
          size="sm"
          disabled={!canInsert}
          onClick={() => onInsert({ fromStop: fromStop.trim(), toStop: toStop.trim(), km, durationMin })}
          className="h-7 text-[11px] bg-orange-500 hover:bg-orange-600 text-black"
        >
          Inserisci
        </Button>
      </div>
    </div>
  );
}

export const InlineDeadheadPopover = React.memo(InlineDeadheadPopoverComponent);
