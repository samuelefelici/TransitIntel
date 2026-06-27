/**
 * QUADRO D'ESERCIZIO — cockpit di FINE PROCESSO (zona Scheduling Engine).
 *
 * Per un programma di esercizio (progetto Planning Studio) mostra TUTTE le sue
 * Unità di Progettazione, se ci sono corse scoperte (a monte, fuori dalle UDP, e
 * a valle, non coperte dai turni macchina) e, per ogni UDP, se sono stati fatti
 * turni macchina e turni guida. Le UDP incomplete sono segnalate visivamente.
 *
 * Rotte: /fucina/esercizio (scelta programma) · /fucina/esercizio/:id (quadro).
 */
import { useState } from "react";
import { Link, useParams, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft, Loader2, Truck, Users, CheckCircle2, AlertTriangle, XCircle,
  ClipboardList, ChevronRight, Layers,
} from "lucide-react";
import { getPsOperationalBoard, listProjects, type OperationalUnit } from "@/lib/scheduling-projects-api";

/* ─── Picker: scegli il programma di esercizio ─── */
function ProgramPicker() {
  const [, navigate] = useLocation();
  const q = useQuery({ queryKey: ["scheduling", "projects", "all"], queryFn: () => listProjects() });
  const groups = (() => {
    const m = new Map<string, { psId: string; name: string; udp: number }>();
    for (const p of q.data ?? []) {
      if (!p.planningStudioProjectId) continue;
      const g = m.get(p.planningStudioProjectId) ?? { psId: p.planningStudioProjectId, name: p.planningStudioProjectName ?? "Programma", udp: 0 };
      g.udp += 1;
      m.set(p.planningStudioProjectId, g);
    }
    return [...m.values()];
  })();

  return (
    <div className="flex flex-col h-screen bg-slate-950 text-slate-100">
      <div className="border-b border-slate-800 bg-slate-900 px-4 py-3 flex items-center gap-3">
        <ClipboardList className="h-5 w-5 text-emerald-400" />
        <h1 className="font-semibold text-slate-100">Quadro d'esercizio</h1>
        <span className="text-[11px] text-slate-500">scegli il programma di esercizio</span>
      </div>
      <div className="flex-1 overflow-auto p-6">
        {q.isLoading && <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-emerald-400" /></div>}
        {!q.isLoading && groups.length === 0 && (
          <div className="max-w-xl mx-auto border-2 border-dashed border-slate-700 rounded-lg p-10 text-center text-slate-400">
            <Layers className="h-12 w-12 mx-auto text-slate-600 mb-3" />
            <p className="font-medium text-slate-200 mb-1">Nessun programma avviato allo scheduling</p>
            <p className="text-xs">Crea le UDP in Planning Studio e portane almeno una allo Scheduling Engine.</p>
          </div>
        )}
        <div className="max-w-2xl mx-auto space-y-2">
          {groups.map((g) => (
            <button key={g.psId} onClick={() => navigate(`/fucina/esercizio/${g.psId}`)}
              className="w-full flex items-center gap-3 px-4 py-3 rounded-xl border border-slate-800 bg-slate-900 hover:border-emerald-500/40 hover:bg-slate-900/60 transition-colors text-left">
              <ClipboardList className="h-5 w-5 text-emerald-400 shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="font-medium text-slate-100 truncate">{g.name}</div>
                <div className="text-[11px] text-slate-500">{g.udp} UDP avviate</div>
              </div>
              <ChevronRight className="h-4 w-4 text-slate-600" />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ─── Badge stato UDP ─── */
function UnitStatus({ u }: { u: OperationalUnit }) {
  if (u.status === "not_started")
    return <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-slate-700/60 text-slate-300 border border-slate-600"><XCircle className="w-3 h-3" /> Non avviata</span>;
  if (u.status === "missing_vehicle")
    return <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-rose-500/15 text-rose-300 border border-rose-500/40"><XCircle className="w-3 h-3" /> Manca turni macchina</span>;
  if (u.status === "missing_driver")
    return <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/40"><AlertTriangle className="w-3 h-3" /> Manca turni guida</span>;
  return <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/40"><CheckCircle2 className="w-3 h-3" /> Completa</span>;
}

/* ─── Quadro per un programma ─── */
function Board({ psId }: { psId: string }) {
  const [, navigate] = useLocation();
  const boardQ = useQuery({
    queryKey: ["scheduling", "operational-board", psId],
    queryFn: () => getPsOperationalBoard(psId),
    enabled: !!psId,
  });
  const board = boardQ.data;

  const linkVehicles = (u: OperationalUnit) => u.schedulingProjectId ? `/fucina/${u.schedulingProjectId}/vehicles` : `/planning-studio/${psId}/validity-units`;
  const linkDrivers = (u: OperationalUnit) => u.schedulingProjectId ? `/fucina/${u.schedulingProjectId}/drivers` : `/planning-studio/${psId}/validity-units`;
  // bordo sinistro per severità (segnalazione visiva)
  const rowAccent = (u: OperationalUnit) =>
    u.status === "complete" && u.vehicleUncovered === 0 ? "border-l-2 border-l-emerald-500/60"
    : u.status === "not_started" ? "border-l-2 border-l-slate-600"
    : u.status === "missing_vehicle" ? "border-l-2 border-l-rose-500/70"
    : "border-l-2 border-l-amber-500/70";

  return (
    <div className="flex flex-col h-screen bg-slate-950 text-slate-100">
      <div className="border-b border-slate-800 bg-slate-900 shadow-sm">
        <div className="flex items-center gap-3 px-4 py-3">
          <Link href="/fucina/esercizio">
            <button className="p-2 rounded hover:bg-slate-800 text-slate-400 hover:text-slate-100 transition-colors" title="Cambia programma"><ArrowLeft className="h-4 w-4" /></button>
          </Link>
          <ClipboardList className="h-5 w-5 text-emerald-400" />
          <div>
            <h1 className="font-semibold text-slate-100 leading-tight">Quadro d'esercizio</h1>
            <p className="text-[11px] text-slate-500 leading-tight">tutte le UDP del programma · stato turni macchina/guida · corse scoperte</p>
          </div>
          {board && (
            <div className="ml-auto flex items-center gap-4 text-xs">
              <div className="text-right"><div className="text-slate-200 font-semibold tabular-nums">{board.totals.complete}/{board.totals.udp}</div><div className="text-[10px] uppercase tracking-wide text-slate-500">UDP complete</div></div>
              <div className="text-right"><div className="text-amber-300 font-semibold tabular-nums">{board.totals.vehicles}</div><div className="text-[10px] uppercase tracking-wide text-slate-500">vetture</div></div>
              <div className="text-right"><div className="text-purple-300 font-semibold tabular-nums">{board.totals.duties}</div><div className="text-[10px] uppercase tracking-wide text-slate-500">turni guida</div></div>
              <button onClick={() => navigate(`/roster?psProjectId=${psId}&operational=1`)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-600 text-white hover:bg-emerald-500 transition-colors">
                <Users className="h-3.5 w-3.5" /> Apri nel Roster
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-auto p-6">
        {boardQ.isLoading && <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-emerald-400" /></div>}
        {boardQ.isError && <div className="text-sm text-rose-400">Errore: {(boardQ.error as Error).message}</div>}

        {board && (
          <div className="max-w-5xl mx-auto space-y-4">
            {board.programUncoveredTrips > 0 && (
              <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-200 flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                <span><strong>{board.programUncoveredTrips}</strong> corse del programma non sono in nessuna UDP (corse scoperte a monte). Aggiungile a una UDP nella Matrice di validità.</span>
              </div>
            )}
            {board.projects.length === 0 && (
              <div className="border-2 border-dashed border-slate-700 rounded-lg p-10 text-center text-slate-400">
                <Layers className="h-12 w-12 mx-auto text-slate-600 mb-3" />
                <p className="font-medium text-slate-200 mb-1">Nessuna UDP per questo programma</p>
                <p className="text-xs">Crea le Unità di Progettazione nella Matrice di validità.</p>
              </div>
            )}

            {board.projects.length > 0 && (
              <div className="rounded-xl border border-slate-800 overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-slate-900 text-[10px] uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="px-3 py-2 text-left">Unità di Progettazione</th>
                      <th className="px-3 py-2 text-left">Turni macchina</th>
                      <th className="px-3 py-2 text-left">Turni guida</th>
                      <th className="px-3 py-2 text-left">Stato</th>
                    </tr>
                  </thead>
                  <tbody>
                    {board.projects.map((u) => (
                      <tr key={u.validityUnitId} className={`border-t border-slate-800/70 hover:bg-slate-900/40 ${rowAccent(u)}`}>
                        <td className="px-3 py-2">
                          <div className="font-medium text-slate-100">{u.validityUnitName ?? "UDP"}</div>
                          <div className="text-[10px] text-slate-500">{u.tripCount} corse</div>
                        </td>
                        <td className="px-3 py-2">
                          {u.vehicleScenario ? (
                            <Link href={linkVehicles(u)}>
                              <button className="inline-flex items-center gap-1.5 hover:underline">
                                <Truck className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                                <span className="text-slate-200">{u.vehicleScenario.name}</span>
                                {u.vehicleScenario.numVehicles != null && <span className="text-[11px] text-amber-400/80 font-mono">· {u.vehicleScenario.numVehicles} vetture</span>}
                              </button>
                            </Link>
                          ) : (
                            <Link href={linkVehicles(u)}><button className="text-[11px] text-rose-300/80 hover:underline">— {u.status === "not_started" ? "avvia / genera" : "scegline uno"}</button></Link>
                          )}
                          {u.vehicleUncovered > 0 && (
                            <div className="text-[10px] text-amber-300 mt-0.5 flex items-center gap-1"><AlertTriangle className="w-3 h-3" /> {u.vehicleUncovered} corse scoperte nei turni</div>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          {u.driverScenario ? (
                            <Link href={linkDrivers(u)}>
                              <button className="inline-flex items-center gap-1.5 hover:underline">
                                <Users className="w-3.5 h-3.5 text-purple-400 shrink-0" />
                                <span className="text-slate-200">{u.driverScenario.name}</span>
                                <span className="text-[11px] text-purple-300/80 font-mono">· {u.driverScenario.dutyCount} turni</span>
                              </button>
                            </Link>
                          ) : u.vehicleScenario ? (
                            <Link href={linkDrivers(u)}><button className="text-[11px] text-amber-300/80 hover:underline">— genera/scegli</button></Link>
                          ) : (
                            <span className="text-[11px] text-slate-500">prima i turni macchina</span>
                          )}
                        </td>
                        <td className="px-3 py-2"><UnitStatus u={u} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="text-[11px] text-slate-500">
              Verde = UDP completa (turni macchina + guida in esercizio, nessuna corsa scoperta). Rosso/ambra = manca un passo o ci sono corse scoperte.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

export default function OperationalBoardPage() {
  const params = useParams<{ id?: string }>();
  return params?.id ? <Board psId={params.id} /> : <ProgramPicker />;
}
