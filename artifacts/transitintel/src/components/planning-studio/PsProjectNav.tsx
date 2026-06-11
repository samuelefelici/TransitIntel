/**
 * PsProjectNav — barra di navigazione unica del progetto Planner Studio.
 *
 * Tab orizzontali nell'ordine del flusso di lavoro:
 *   Editor Rete → Nodi → Periodi → Calendario → Corse → Validità → Unità → Rete
 *
 * Colori neutri (bianco/slate + attivo indigo) pensati per funzionare sia
 * sulle pagine chiare (slate-50) sia su quelle scure (slate-950).
 */
import { Link, useLocation } from "wouter";
import {
  Workflow,
  Layers,
  CalendarRange,
  CalendarDays,
  Bus,
  CalendarCheck,
  Boxes,
  Network,
  type LucideIcon,
} from "lucide-react";

interface PsProjectNavProps {
  projectId: string;
}

interface NavTab {
  label: string;
  /** Segmento aggiunto a /planning-studio/:id ("" = editor). */
  segment: string;
  icon: LucideIcon;
}

const TABS: NavTab[] = [
  { label: "Editor Rete", segment: "", icon: Workflow },
  { label: "Nodi", segment: "/clusters", icon: Layers },
  { label: "Periodi", segment: "/service-periods", icon: CalendarRange },
  { label: "Calendario", segment: "/calendar", icon: CalendarDays },
  { label: "Corse", segment: "/trips", icon: Bus },
  { label: "Validità", segment: "/validity", icon: CalendarCheck },
  { label: "Unità", segment: "/validity-units", icon: Boxes },
  { label: "Rete", segment: "/network", icon: Network },
];

export default function PsProjectNav({ projectId }: PsProjectNavProps) {
  const [location] = useLocation();
  const base = `/planning-studio/${projectId}`;

  return (
    <nav
      aria-label="Sezioni progetto"
      className="shrink-0 border-b border-slate-300 bg-white/80 backdrop-blur-sm overflow-x-auto"
    >
      <div className="flex items-center gap-1 px-3 py-1.5 min-w-max">
        {TABS.map((tab) => {
          const href = `${base}${tab.segment}`;
          const normalized = location.replace(/\/+$/, "") || "/";
          const active = normalized === href;
          const Icon = tab.icon;
          return (
            <Link
              key={tab.segment}
              href={href}
              className={
                active
                  ? "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold bg-indigo-600 text-white shadow-sm whitespace-nowrap"
                  : "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium text-slate-700 border border-transparent hover:border-slate-300 hover:bg-slate-100 whitespace-nowrap transition-colors"
              }
            >
              <Icon className="h-3.5 w-3.5" />
              {tab.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
