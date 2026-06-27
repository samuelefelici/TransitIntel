/**
 * QUADRO D'ESERCIZIO — vista consolidata per progetto PS.
 *
 * Per ogni Unità di Progettazione (UDP) del progetto mostra il turni-macchina e
 * il turni-guida marcati "in esercizio", con stato di completezza. È il punto
 * dove l'utente verifica, a colpo d'occhio, cosa è pronto per il Roster e cosa
 * manca ancora — senza perdere il filo tra le tante UDP/scenari.
 */
import { useState } from "react";
import { Link, useParams, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft, Loader2, Truck, Users, CheckCircle2, AlertTriangle, XCircle, CalendarRange,
} from "lucide-react";
import { getPsOperationalBoard, type OperationalUnit } from "@/lib/scheduling-projects-api";
import { getPsProject } from "@/lib/planning-studio-api";

function StatusBadge({ status }: { status: OperationalUnit["status"] }) {
  if (status === "complete") {
    return <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/40"><CheckCircle2 className="w-3 h-3" /> Completa</span>;
  }
  if (status === "missing_driver") {
    return <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/40"><AlertTriangle className="w-3 h-3" /> Manca turni guida</span>;
  }
  return <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-rose-500/15 text-rose-300 border border-rose-500/40"><XCircle className="w-3 h-3" /> Manca turni macchina</span>;
}

export default function OperationalBoardPage() {
  const params = useParams<{ id: string }>();
  const psProjectId = params?.id ?? "";
  const [, navigate] = useLocation();

  const projectQ = useQuery({
    queryKey: ["ps", "project", psProjectId],
    queryFn: () => getPsProject(psProjectId),
    enabled: !!psProjectId,
  });
  const boardQ = useQuery({
    queryKey: ["scheduling", "operational-board", psProjectId],
    queryFn: () => getPsOperationalBoard(psProjectId),
    enabled: !!psProjectId,
  });

  // Flusso spezzato: prima TUTTI i turni macchina, poi TUTTI i turni guida.
  const [phase, setPhase] = useState<"vehicle" | "driver">("vehicle");

  const board = boardQ.data;
  const projects = board?.projects ?? [];
  const withVehicle = projects.filter((p) => p.vehicleScenario).length;
  const withDriver = projects.filter((p) => p.driverScenario).length;
  // "manca" nella fase corrente: TM assente (fase vetture) o TG assente con TM presente (fase guida)
  const incomplete = phase === "vehicle"
    ? projects.filter((p) => !p.vehicleScenario)
    : projects.filter((p) => p.vehicleScenario && !p.driverScenario);

  return (
    <div className="flex flex-col h-screen bg-slate-950 text-slate-100">
      {/* TopBar */}
      <div className="border-b border-slate-800 bg-slate-900 shadow-sm">
        <div className="flex items-center gap-3 px-4 py-3">
          <Link href={`/planning-studio/${psProjectId}/validity-units`}>
            <button className="p-2 rounded hover:bg-slate-800 text-slate-400 hover:text-slate-100 transition-colors" title="Torna alle Unità di Progettazione">
              <ArrowLeft className="h-4 w-4" />
            </button>
          </Link>
          <CalendarRange className="h-5 w-5 text-emerald-400" />
          <div>
            <h1 className="font-semibold text-slate-100 leading-tight">Quadro d'esercizio</h1>
            <p className="text-[11px] text-slate-500 leading-tight">{projectQ.data?.name ?? "…"} · turni macchina e guida in esercizio per UDP</p>
          </div>
          {board && (
            <div className="ml-auto flex items-center gap-4 text-xs">
              <div className="text-right">
                <div className="text-slate-200 font-semibold tabular-nums">{board.totals.complete}/{board.totals.udp}</div>
                <div className="text-[10px] uppercase tracking-wide text-slate-500">UDP complete</div>
              </div>
              <div className="text-right">
                <div className="text-amber-300 font-semibold tabular-nums">{board.totals.vehicles}</div>
                <div className="text-[10px] uppercase tracking-wide text-slate-500">vetture</div>
              </div>
              <div className="text-right">
                <div className="text-purple-300 font-semibold tabular-nums">{board.totals.duties}</div>
                <div className="text-[10px] uppercase tracking-wide text-slate-500">turni guida</div>
              </div>
              <button
                onClick={() => navigate(`/roster?psProjectId=${psProjectId}&operational=1`)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-600 text-white hover:bg-emerald-500 transition-colors"
                title="Apri il Roster con i soli turni guida in esercizio di questo servizio"
              >
                <Users className="h-3.5 w-3.5" /> Apri nel Roster
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-auto p-6">
        {boardQ.isLoading && (
          <div className="flex items-center justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-emerald-400" /></div>
        )}
        {boardQ.isError && (
          <div className="text-sm text-rose-400">Errore: {(boardQ.error as Error).message}</div>
        )}

        {board && board.projects.length === 0 && (
          <div className="border-2 border-dashed border-slate-700 rounded-lg p-10 text-center text-slate-400">
            <CalendarRange className="h-12 w-12 mx-auto text-slate-600 mb-3" />
            <p className="font-medium text-slate-200 mb-1">Nessuna UDP avviata allo scheduling</p>
            <p className="text-xs">Dalle Unità di Progettazione premi il razzo per portare un'UDP allo scheduling, poi marca turni macchina e guida "in esercizio".</p>
          </div>
        )}

        {board && board.projects.length > 0 && (
          <div className="max-w-5xl mx-auto space-y-4">
            {/* Fasi: prima TUTTI i turni macchina, poi TUTTI i turni guida */}
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPhase("vehicle")}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${
                  phase === "vehicle" ? "border-amber-400 bg-amber-500/15 text-amber-200" : "border-slate-700 text-slate-400 hover:text-amber-200"
                }`}
              >
                <Truck className="h-3.5 w-3.5" /> Fase 1 · Turni macchina
                <span className="text-[10px] font-mono opacity-80">{withVehicle}/{board.totals.udp}</span>
              </button>
              <button
                onClick={() => setPhase("driver")}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${
                  phase === "driver" ? "border-purple-400 bg-purple-500/15 text-purple-200" : "border-slate-700 text-slate-400 hover:text-purple-200"
                }`}
              >
                <Users className="h-3.5 w-3.5" /> Fase 2 · Turni guida
                <span className="text-[10px] font-mono opacity-80">{withDriver}/{board.totals.udp}</span>
              </button>
            </div>

            {incomplete.length > 0 && (
              <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200 flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                <span>
                  <strong>{incomplete.length}</strong> UDP senza {phase === "vehicle" ? "turni macchina" : "turni guida"} in esercizio.
                  {phase === "driver" && " (Servono i turni macchina prima.)"}
                </span>
              </div>
            )}

            <div className="rounded-xl border border-slate-800 overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-slate-900 text-[10px] uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-3 py-2 text-left">Unità di Progettazione</th>
                    <th className="px-3 py-2 text-left">{phase === "vehicle" ? "Turni macchina (in esercizio)" : "Turni guida (in esercizio)"}</th>
                    <th className="px-3 py-2 text-left">Stato</th>
                  </tr>
                </thead>
                <tbody>
                  {board.projects.map((p) => (
                    <tr key={p.projectId} className="border-t border-slate-800/70 hover:bg-slate-900/40">
                      <td className="px-3 py-2">
                        <div className="font-medium text-slate-100">{p.validityUnitName ?? p.projectName}</div>
                      </td>
                      {phase === "vehicle" ? (
                        <td className="px-3 py-2">
                          {p.vehicleScenario ? (
                            <Link href={`/fucina/${p.projectId}/vehicles`}>
                              <button className="inline-flex items-center gap-1.5 text-left hover:underline">
                                <Truck className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                                <span className="text-slate-200">{p.vehicleScenario.name}</span>
                                {p.vehicleScenario.numVehicles != null && (
                                  <span className="text-[11px] text-amber-400/80 font-mono">· {p.vehicleScenario.numVehicles} vetture</span>
                                )}
                              </button>
                            </Link>
                          ) : (
                            <Link href={`/fucina/${p.projectId}/vehicles`}>
                              <button className="text-[11px] text-rose-300/80 hover:underline">— nessuno · genera/scegli turni macchina</button>
                            </Link>
                          )}
                        </td>
                      ) : (
                        <td className="px-3 py-2">
                          {p.driverScenario ? (
                            <Link href={`/fucina/${p.projectId}/drivers`}>
                              <button className="inline-flex items-center gap-1.5 text-left hover:underline">
                                <Users className="w-3.5 h-3.5 text-purple-400 shrink-0" />
                                <span className="text-slate-200">{p.driverScenario.name}</span>
                                <span className="text-[11px] text-purple-300/80 font-mono">· {p.driverScenario.dutyCount} turni</span>
                              </button>
                            </Link>
                          ) : p.vehicleScenario ? (
                            <Link href={`/fucina/${p.projectId}/drivers`}>
                              <button className="text-[11px] text-amber-300/80 hover:underline">— nessuno · genera/scegli turni guida</button>
                            </Link>
                          ) : (
                            <span className="text-[11px] text-slate-500">prima i turni macchina</span>
                          )}
                        </td>
                      )}
                      <td className="px-3 py-2">
                        {phase === "vehicle"
                          ? (p.vehicleScenario
                              ? <StatusBadge status="complete" />
                              : <StatusBadge status="missing_vehicle" />)
                          : (p.driverScenario
                              ? <StatusBadge status="complete" />
                              : <StatusBadge status={p.vehicleScenario ? "missing_driver" : "missing_vehicle"} />)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-[11px] text-slate-500">
              {phase === "vehicle"
                ? "Fase 1: per ogni UDP genera o scegli il turni-macchina e marcalo “in esercizio”. Poi passa alla Fase 2."
                : "Fase 2: sui turni-macchina in esercizio, genera/scegli i turni-guida e marcali “in esercizio”. Quando tutte le UDP sono complete, apri il Roster."}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
