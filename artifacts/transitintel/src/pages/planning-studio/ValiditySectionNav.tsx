/**
 * Sub-navigazione della sezione "Validità" del Planning Studio, in ordine di
 * flusso: Calendario aziendale → Matrice validità → Unità di Progettazione.
 * Riusata nelle tre pagine per dare una UI coerente.
 */
import { Link } from "wouter";
import { CalendarRange, Grid3x3, Layers, ChevronRight } from "lucide-react";

const STEPS = [
  { key: "calendar", label: "Calendario aziendale", path: "calendar", Icon: CalendarRange },
  { key: "validity", label: "Matrice validità", path: "validity", Icon: Grid3x3 },
  { key: "units", label: "Unità di Progettazione", path: "validity-units", Icon: Layers },
] as const;

export default function ValiditySectionNav({
  projectId, active, theme = "dark",
}: {
  projectId: string;
  active: "calendar" | "validity" | "units";
  theme?: "dark" | "light";
}) {
  const dark = theme === "dark";
  return (
    <div className="flex items-center gap-1">
      {STEPS.map((s, i) => {
        const isActive = s.key === active;
        return (
          <div key={s.key} className="flex items-center gap-1">
            {i > 0 && (
              <ChevronRight className={`h-3.5 w-3.5 ${dark ? "text-slate-600" : "text-slate-300"}`} />
            )}
            <Link href={`/planning-studio/${projectId}/${s.path}`}>
              <button
                className={`flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md transition-colors whitespace-nowrap ${
                  isActive
                    ? dark
                      ? "bg-sky-500/15 text-sky-300 border border-sky-500/40 font-semibold"
                      : "bg-indigo-50 text-indigo-700 border border-indigo-200 font-semibold"
                    : dark
                      ? "text-slate-400 hover:text-slate-200 hover:bg-white/5 border border-transparent"
                      : "text-slate-500 hover:text-slate-800 hover:bg-slate-100 border border-transparent"
                }`}
                title={s.label}
              >
                <s.Icon className="h-3.5 w-3.5 shrink-0" />
                {s.label}
              </button>
            </Link>
          </div>
        );
      })}
    </div>
  );
}
