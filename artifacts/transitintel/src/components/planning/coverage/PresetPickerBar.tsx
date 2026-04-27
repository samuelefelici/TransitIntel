/**
 * PresetPickerBar — 6 card di preset di domanda. Selezionare un preset aggiorna
 * day+season nel context. "custom" è non-cliccabile (stato implicito).
 */
import { Briefcase, ShoppingBag, Sun, Snowflake, Moon, Settings2 } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { DemandPreset, usePlanningFilters } from "../PlanningFiltersContext";

type PresetMeta = { id: DemandPreset; label: string; sub: string; Icon: LucideIcon; tone: string };

const PRESETS: PresetMeta[] = [
  { id: "weekday-work",    label: "Feriale lavoro/studio",   sub: "Lun-Ven · pendolare",      Icon: Briefcase, tone: "bg-blue-500/10 border-blue-500/40 text-blue-300" },
  { id: "sat-shopping",    label: "Sabato commercio",         sub: "Sab · shopping/mercati",   Icon: ShoppingBag, tone: "bg-amber-500/10 border-amber-500/40 text-amber-300" },
  { id: "sun-summer-coast",label: "Domenica mare",            sub: "Dom estate · spiagge",     Icon: Sun, tone: "bg-cyan-500/10 border-cyan-500/40 text-cyan-300" },
  { id: "sun-winter-mall", label: "Domenica città",           sub: "Dom inverno · centri",     Icon: Snowflake, tone: "bg-indigo-500/10 border-indigo-500/40 text-indigo-300" },
  { id: "evening-leisure", label: "Sera svago",               sub: "Tutti · ristoranti/eventi",Icon: Moon, tone: "bg-violet-500/10 border-violet-500/40 text-violet-300" },
  { id: "custom",          label: "Personalizzato",           sub: "Filtri manuali",           Icon: Settings2, tone: "bg-muted/40 border-border text-muted-foreground" },
];

export default function PresetPickerBar() {
  const ctx = usePlanningFilters();
  if (!ctx) return null;
  const { demandPreset, setDemandPreset } = ctx;
  return (
    <div className="bg-card border border-border rounded-lg p-2.5">
      <div className="text-[10px] uppercase text-muted-foreground mb-1.5 px-1">
        Scenario di domanda
        <span className="ml-2 text-muted-foreground/70 normal-case">scegli un preset per impostare giorno + stagione coerenti</span>
      </div>
      <div className="flex gap-2 overflow-x-auto pb-1">
        {PRESETS.map((p) => {
          const active = demandPreset === p.id;
          return (
            <button
              key={p.id}
              onClick={() => setDemandPreset(p.id)}
              aria-label={`Preset di domanda: ${p.label}`}
              aria-pressed={active}
              className={`shrink-0 min-w-[160px] text-left px-3 py-2 rounded-md border transition-all
                ${active
                  ? `${p.tone} ring-2 ring-offset-1 ring-offset-background`
                  : "bg-background border-border hover:bg-muted text-foreground"}`}
            >
              <div className="flex items-center gap-1.5">
                <p.Icon className="w-3.5 h-3.5" />
                <span className="font-semibold text-xs">{p.label}</span>
              </div>
              <div className="text-[10px] mt-0.5 opacity-80">{p.sub}</div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export { PRESETS as DEMAND_PRESETS };
