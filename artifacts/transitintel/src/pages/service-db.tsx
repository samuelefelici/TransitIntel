/**
 * DATABASE DI ESERCIZIO — vista unica della catena di pianificazione:
 * programmi (con quello operativo evidenziato), unità di progettazione,
 * turni macchina, turni guida, roster. Ogni riga linka al modulo che la
 * gestisce: è il punto d'ingresso "vedo tutto" chiesto dagli operatori.
 */
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  Bus, CalendarRange, Database, Layers, Loader2, Power, Users, ClipboardList,
} from "lucide-react";
import { apiFetch } from "@/lib/api";

interface Overview {
  projects: Array<{ id: string; name: string; agencyName: string | null; status: string; updatedAt: string; isOperational: boolean; materializedAt: string | null; routes: number; trips: number; validityUnits: number }>;
  validityUnits: Array<{ id: string; projectId: string; projectName: string; name: string; dayCount: number; tripCount: number; representativeDates: string[] }>;
  vehicleScenarios: Array<{ id: string; name: string; date: string; createdAt: string; dssCount: number }>;
  driverScenarios: Array<{ id: string; name: string; createdAt: string; vehicleScenarioId: string; vehicleScenarioName: string | null; date: string | null; duties: number }>;
  roster: { drivers: number; assignmentsNext7: number };
}

function fmtDate(s: string | null | undefined): string {
  if (!s) return "—";
  if (/^\d{8}$/.test(s)) return `${s.slice(6, 8)}/${s.slice(4, 6)}/${s.slice(0, 4)}`;
  try { return new Date(s).toLocaleDateString("it-IT"); } catch { return s; }
}

function Section({ icon, title, count, children }: {
  icon: React.ReactNode; title: string; count: number; children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-border/60 bg-card/60 overflow-hidden">
      <div className="px-4 py-2.5 border-b border-border/50 flex items-center gap-2">
        <span className="text-sky-400">{icon}</span>
        <span className="text-sm font-semibold">{title}</span>
        <span className="ml-auto text-[10px] font-mono text-muted-foreground">{count}</span>
      </div>
      <div className="max-h-72 overflow-y-auto divide-y divide-border/30">{children}</div>
    </div>
  );
}

export default function ServiceDbPage() {
  const q = useQuery({
    queryKey: ["service-db", "overview"],
    queryFn: () => apiFetch<Overview>("/api/service-db/overview"),
    refetchInterval: 60_000,
  });
  const d = q.data;

  if (q.isLoading) {
    return <div className="flex items-center justify-center py-24 text-muted-foreground text-sm gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Carico il database di esercizio…</div>;
  }

  return (
    <div className="max-w-7xl mx-auto space-y-5">
      <div className="flex items-center gap-3">
        <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-slate-600 to-slate-800 flex items-center justify-center shadow-lg">
          <Database className="w-5 h-5 text-white" />
        </div>
        <div>
          <h1 className="text-xl font-bold">Database di Esercizio</h1>
          <p className="text-xs text-muted-foreground">
            Tutta la catena in un colpo d'occhio: programmi → unità → turni macchina → turni guida → roster
          </p>
        </div>
        <div className="ml-auto flex gap-2 text-[11px]">
          <span className="px-3 py-1.5 rounded-lg bg-violet-500/10 text-violet-300 flex items-center gap-1.5">
            <Users className="w-3.5 h-3.5" /> {d?.roster.drivers ?? 0} operatori · {d?.roster.assignmentsNext7 ?? 0} turni assegnati (7gg)
          </span>
          <Link href="/roster"><span className="px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 cursor-pointer">Apri Roster →</span></Link>
        </div>
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        <Section icon={<Layers className="w-4 h-4" />} title="Programmi di Esercizio (Planner Studio)" count={d?.projects.length ?? 0}>
          {d?.projects.map((p) => (
            <Link key={p.id} href={`/planning-studio/${p.id}`}>
              <div className="px-4 py-2.5 hover:bg-white/5 cursor-pointer flex items-center gap-3">
                {p.isOperational
                  ? <span className="shrink-0 flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500 text-white text-[9px] font-bold uppercase"><Power className="w-2.5 h-2.5" /> Operativo</span>
                  : <span className="shrink-0 px-2 py-0.5 rounded-full bg-slate-700/60 text-slate-300 text-[9px] uppercase">{p.status}</span>}
                <span className="flex-1 min-w-0">
                  <span className="block text-xs font-medium truncate">{p.name}</span>
                  <span className="block text-[10px] text-muted-foreground">
                    {p.routes} linee · {p.trips} corse · {p.validityUnits} unità di progettazione
                  </span>
                </span>
                <span className="text-[10px] text-muted-foreground">{fmtDate(p.updatedAt)}</span>
              </div>
            </Link>
          ))}
          {d?.projects.length === 0 && <p className="px-4 py-4 text-xs text-muted-foreground">Nessun programma. Crealo in Planner Studio.</p>}
        </Section>

        <Section icon={<CalendarRange className="w-4 h-4" />} title="Unità di Progettazione" count={d?.validityUnits.length ?? 0}>
          {d?.validityUnits.map((u) => (
            <Link key={u.id} href={`/planning-studio/${u.projectId}/validity-units`}>
              <div className="px-4 py-2.5 hover:bg-white/5 cursor-pointer flex items-center gap-3">
                <span className="flex-1 min-w-0">
                  <span className="block text-xs font-medium truncate">{u.name}</span>
                  <span className="block text-[10px] text-muted-foreground truncate">{u.projectName}</span>
                </span>
                <span className="text-[10px] font-mono text-sky-300">{u.dayCount} gg</span>
                <span className="text-[10px] font-mono text-muted-foreground">{u.tripCount} corse</span>
              </div>
            </Link>
          ))}
          {d?.validityUnits.length === 0 && <p className="px-4 py-4 text-xs text-muted-foreground">Nessuna unità: calcolale dalla matrice di validità del progetto.</p>}
        </Section>

        <Section icon={<Bus className="w-4 h-4" />} title="Turni Macchina (scenari salvati)" count={d?.vehicleScenarios.length ?? 0}>
          {d?.vehicleScenarios.map((s) => (
            <Link key={s.id} href={`/driver-shifts/${s.id}`}>
              <div className="px-4 py-2.5 hover:bg-white/5 cursor-pointer flex items-center gap-3">
                <span className="flex-1 min-w-0">
                  <span className="block text-xs font-medium truncate">{s.name}</span>
                  <span className="block text-[10px] text-muted-foreground">{fmtDate(s.date)} · {s.dssCount} turni guida derivati</span>
                </span>
                <span className="text-[10px] text-muted-foreground">{fmtDate(s.createdAt)}</span>
              </div>
            </Link>
          ))}
          {d?.vehicleScenarios.length === 0 && <p className="px-4 py-4 text-xs text-muted-foreground">Nessuno scenario: generali nella Fucina (Scheduling Engine).</p>}
        </Section>

        <Section icon={<ClipboardList className="w-4 h-4" />} title="Turni Guida (DSS salvati)" count={d?.driverScenarios.length ?? 0}>
          {d?.driverScenarios.map((s) => (
            <Link key={s.id} href={`/driver-shifts/${s.vehicleScenarioId}?dss=${s.id}`}>
              <div className="px-4 py-2.5 hover:bg-white/5 cursor-pointer flex items-center gap-3">
                <span className="flex-1 min-w-0">
                  <span className="block text-xs font-medium truncate">{s.name}</span>
                  <span className="block text-[10px] text-muted-foreground truncate">
                    {s.vehicleScenarioName ?? "—"} · {fmtDate(s.date)}
                  </span>
                </span>
                <span className="text-[10px] font-mono text-emerald-300">{s.duties} turni</span>
              </div>
            </Link>
          ))}
          {d?.driverScenarios.length === 0 && <p className="px-4 py-4 text-xs text-muted-foreground">Nessun turno guida salvato.</p>}
        </Section>
      </div>
    </div>
  );
}
