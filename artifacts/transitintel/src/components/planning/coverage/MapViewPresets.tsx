/**
 * MapViewPresets — 4 preset di visualizzazione mappa, mutuamente esclusivi.
 * Ogni preset configura un set di toggle granulari coerenti.
 */
import { Eye, AlertTriangle, Waypoints, Scale, ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import type { LucideIcon } from "lucide-react";
import { MapViewPreset } from "../PlanningFiltersContext";

export interface LayerToggles {
  showBuffer: boolean;
  showPois: boolean;
  showUnservedPois: boolean;
  showUncovered: boolean;
  showBalance: boolean;
  showFlows: boolean;
}

export const PRESET_LAYERS: Record<Exclude<MapViewPreset, "custom">, LayerToggles> = {
  coverage: { showBuffer: true,  showPois: true,  showUnservedPois: false, showUncovered: false, showBalance: false, showFlows: false },
  gaps:     { showBuffer: false, showPois: false, showUnservedPois: true,  showUncovered: true,  showBalance: false, showFlows: false },
  flows:    { showBuffer: true,  showPois: false, showUnservedPois: false, showUncovered: false, showBalance: false, showFlows: true  },
  balance:  { showBuffer: false, showPois: false, showUnservedPois: false, showUncovered: false, showBalance: true,  showFlows: false },
};

const PRESETS: { id: Exclude<MapViewPreset, "custom">; label: string; sub: string; Icon: LucideIcon }[] = [
  { id: "coverage", label: "Cosa copriamo",      sub: "raggi pedonali + POI serviti", Icon: Eye },
  { id: "gaps",     label: "Cosa manca",         sub: "POI e zone non servite",       Icon: AlertTriangle },
  { id: "flows",    label: "Dove si muovono",    sub: "linee di desiderio (OD)",      Icon: Waypoints },
  { id: "balance",  label: "Offerta vs domanda", sub: "griglia bilanciamento",        Icon: Scale },
];

type Props = {
  current: MapViewPreset;
  onPresetChange: (p: MapViewPreset) => void;
  toggles: LayerToggles;
  onToggle: (key: keyof LayerToggles, value: boolean) => void;
};

export default function MapViewPresets({ current, onPresetChange, toggles, onToggle }: Props) {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Preset di visualizzazione mappa">
        {PRESETS.map((p) => {
          const active = current === p.id;
          return (
            <button
              key={p.id}
              role="radio"
              aria-checked={active}
              onClick={() => onPresetChange(p.id)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs border transition-colors
                ${active
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-background border-border hover:bg-muted"}`}
            >
              <p.Icon className="w-3.5 h-3.5" />
              <div className="text-left">
                <div className="font-semibold">{p.label}</div>
                <div className="text-[9px] opacity-70">{p.sub}</div>
              </div>
            </button>
          );
        })}
        {current === "custom" && (
          <span className="px-2 py-1 rounded-md text-[10px] border border-dashed border-muted-foreground/40 text-muted-foreground self-center">
            personalizzato
          </span>
        )}
      </div>

      <button
        onClick={() => setAdvancedOpen(!advancedOpen)}
        className="text-[10px] text-muted-foreground hover:text-foreground flex items-center gap-1"
        aria-expanded={advancedOpen}
      >
        {advancedOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        Layer avanzati (override manuale)
      </button>

      {advancedOpen && (
        <div className="bg-muted/20 rounded-md p-2 flex flex-wrap gap-3 text-xs">
          {([
            ["showBuffer", "raggio pedonale"],
            ["showPois", "POI serviti"],
            ["showUnservedPois", "POI NON serviti"],
            ["showUncovered", "zone NON servite"],
            ["showFlows", "flussi OD"],
            ["showBalance", "bilanciamento"],
          ] as [keyof LayerToggles, string][]).map(([key, label]) => (
            <label key={key} className="flex items-center gap-1 cursor-pointer">
              <input
                type="checkbox"
                checked={toggles[key]}
                onChange={(e) => onToggle(key, e.target.checked)}
                aria-label={`Toggle layer ${label}`}
              />
              <span>{label}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
