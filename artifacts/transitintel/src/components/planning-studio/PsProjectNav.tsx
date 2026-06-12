/**
 * PsProjectNav — navigazione del progetto Planner Studio.
 *
 * STESSE categorie della toolbar dell'Editor Rete (un solo modello mentale):
 *   Editor Rete | Rete ▾ | Orari ▾ | Validità ▾ | Territorio ▾
 * Click sulla categoria → elenco delle sezioni. La categoria che contiene la
 * pagina corrente è evidenziata. Colori neutri che funzionano sia sulle
 * pagine chiare (slate-50) sia su quelle scure (slate-950).
 */
import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import {
  Workflow, ChevronDown, LineChart, Activity, Bus, CalendarRange,
  CalendarDays, CalendarCheck, Boxes, Layers, Landmark,
  type LucideIcon,
} from "lucide-react";

interface PsProjectNavProps {
  projectId: string;
}

interface NavItem {
  label: string;
  /** Segmento aggiunto a /planning-studio/:id ("" = editor). */
  segment: string;
  icon: LucideIcon;
}

interface NavCategory {
  label: string;
  icon: LucideIcon;
  items: NavItem[];
}

// Stesse categorie della toolbar dell'editor (solo le voci-pagina:
// i pannelli Fermate/Linee/Depositi vivono dentro l'Editor Rete).
const CATEGORIES: NavCategory[] = [
  {
    label: "Rete", icon: Workflow,
    items: [
      { label: "Orario grafico (TTD)", segment: "/ttd", icon: LineChart },
      { label: "Inspector di rete", segment: "/network", icon: Activity },
    ],
  },
  {
    label: "Orari", icon: CalendarDays,
    items: [
      { label: "Corse", segment: "/trips", icon: Bus },
      { label: "Periodi di esercizio", segment: "/service-periods", icon: CalendarRange },
      { label: "Calendario Aziendale", segment: "/calendar", icon: CalendarDays },
    ],
  },
  {
    label: "Validità", icon: CalendarCheck,
    items: [
      { label: "Matrice di validità", segment: "/validity", icon: CalendarCheck },
      { label: "Unità di Progettazione", segment: "/validity-units", icon: Boxes },
    ],
  },
  {
    label: "Territorio", icon: Landmark,
    items: [
      { label: "Nodi", segment: "/clusters", icon: Layers },
      { label: "Zonizzazione", segment: "/zones", icon: Landmark },
    ],
  },
];

export default function PsProjectNav({ projectId }: PsProjectNavProps) {
  const [location, navigate] = useLocation();
  const base = `/planning-studio/${projectId}`;
  const [open, setOpen] = useState<string | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);

  // chiusura con click fuori
  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (barRef.current && !barRef.current.contains(e.target as Node)) setOpen(null);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  const isCurrent = (segment: string) => location === `${base}${segment}`;

  return (
    <div
      ref={barRef}
      className="flex items-center gap-1 px-4 py-1.5 border-b border-slate-200 bg-white/95 backdrop-blur text-slate-700"
    >
      {/* Editor Rete: link diretto, è la home del progetto */}
      <Link href={base}>
        <button
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
            location === base
              ? "bg-indigo-600 text-white"
              : "hover:bg-slate-100 text-slate-600"
          }`}
        >
          <Workflow className="w-3.5 h-3.5" /> Editor Rete
        </button>
      </Link>

      <div className="w-px h-5 bg-slate-200 mx-1" />

      {CATEGORIES.map((cat) => {
        const containsCurrent = cat.items.some((i) => isCurrent(i.segment));
        const isOpen = open === cat.label;
        return (
          <div key={cat.label} className="relative">
            <button
              onClick={() => setOpen(isOpen ? null : cat.label)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                containsCurrent
                  ? "bg-indigo-50 text-indigo-700 border border-indigo-200"
                  : isOpen
                    ? "bg-slate-100 text-slate-900"
                    : "hover:bg-slate-100 text-slate-600"
              }`}
            >
              <cat.icon className="w-3.5 h-3.5" />
              {cat.label}
              <ChevronDown className={`w-3 h-3 transition-transform ${isOpen ? "rotate-180" : ""}`} />
            </button>

            {isOpen && (
              <div className="absolute left-0 top-full mt-1 z-50 min-w-56 rounded-xl border border-slate-200 bg-white shadow-xl py-1">
                {cat.items.map((item) => {
                  const active = isCurrent(item.segment);
                  return (
                    <button
                      key={item.segment}
                      onClick={() => { setOpen(null); navigate(`${base}${item.segment}`); }}
                      className={`w-full text-left flex items-center gap-2.5 px-3 py-2 text-xs transition-colors ${
                        active
                          ? "bg-indigo-50 text-indigo-700 font-semibold"
                          : "text-slate-700 hover:bg-slate-50"
                      }`}
                    >
                      <item.icon className={`w-3.5 h-3.5 ${active ? "text-indigo-600" : "text-slate-400"}`} />
                      {item.label}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
