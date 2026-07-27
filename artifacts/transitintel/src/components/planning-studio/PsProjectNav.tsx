/**
 * Barra di navigazione di PROGETTO del Planner Studio, persistente su tutte le
 * pagine del modulo. Ordine = flusso di lavoro canonico:
 * rete → ispezione → corse → grafico → calendario → validità → UDP → esercizio.
 *
 * Prima esisteva solo la sub-nav a 3 step della sezione Validità: per passare
 * da Corse al Grafico si tornava all'editor mappa (rimontaggio Mapbox, stato
 * perso). Questa barra elimina il giro: ogni pagina è a un click da ogni altra.
 */
import { Link } from "wouter";
import {
  Map as MapIcon, ScanSearch, Bus, Activity, CalendarRange, Grid3x3, Layers,
  CircleDot, Landmark, ClipboardList,
} from "lucide-react";

export type PsNavKey =
  | "editor" | "network" | "trips" | "ttd" | "calendar" | "validity"
  | "units" | "clusters" | "zones" | "esercizio";

const TABS: Array<{
  key: PsNavKey; label: string; Icon: typeof MapIcon;
  /** path relativo a /planning-studio/:id ("" = editor); assoluto se inizia con "/" */
  path: string;
}> = [
  { key: "editor",    label: "Editor rete",  Icon: MapIcon,       path: "" },
  { key: "network",   label: "Ispettore",    Icon: ScanSearch,    path: "network" },
  { key: "trips",     label: "Corse",        Icon: Bus,           path: "trips" },
  { key: "ttd",       label: "Grafico",      Icon: Activity,      path: "ttd" },
  { key: "calendar",  label: "Calendario",   Icon: CalendarRange, path: "calendar" },
  { key: "validity",  label: "Validità",     Icon: Grid3x3,       path: "validity" },
  { key: "units",     label: "UDP",          Icon: Layers,        path: "validity-units" },
  { key: "clusters",  label: "Nodi",         Icon: CircleDot,     path: "clusters" },
  { key: "zones",     label: "Zonizzazione", Icon: Landmark,      path: "zones" },
  { key: "esercizio", label: "Esercizio",    Icon: ClipboardList, path: "/fucina/esercizio/:id" },
];

export default function PsProjectNav({
  projectId, active, theme = "dark",
}: {
  projectId: string;
  active: PsNavKey;
  theme?: "dark" | "light";
}) {
  const dark = theme === "dark";
  return (
    <nav
      className={`flex items-center gap-0.5 px-2 py-1 overflow-x-auto border-b shrink-0 ${
        dark ? "bg-slate-900/70 border-slate-800" : "bg-slate-50 border-slate-200"
      }`}
      aria-label="Sezioni del progetto"
    >
      {TABS.map((t) => {
        const isActive = t.key === active;
        const href = t.path.startsWith("/")
          ? t.path.replace(":id", projectId)
          : `/planning-studio/${projectId}${t.path ? `/${t.path}` : ""}`;
        return (
          <Link key={t.key} href={href}>
            <button
              className={`flex items-center gap-1 px-2 py-1 text-[11px] rounded-md whitespace-nowrap transition-colors ${
                isActive
                  ? dark
                    ? "bg-emerald-500/15 text-emerald-300 border border-emerald-500/40 font-semibold"
                    : "bg-emerald-50 text-emerald-700 border border-emerald-200 font-semibold"
                  : dark
                    ? "text-slate-400 hover:text-slate-200 hover:bg-white/5 border border-transparent"
                    : "text-slate-500 hover:text-slate-800 hover:bg-slate-100 border border-transparent"
              }`}
              title={t.label}
            >
              <t.Icon className="h-3.5 w-3.5 shrink-0" />
              {t.label}
            </button>
          </Link>
        );
      })}
    </nav>
  );
}
