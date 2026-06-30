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
import { useEffect } from "react";
import { Link, useParams, useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { toast } from "sonner";
import {
  ArrowLeft, Loader2, Truck, Users, CheckCircle2, AlertTriangle, XCircle,
  ClipboardList, ChevronRight, Layers, Power, Plus, ArrowRight, Sparkles,
} from "lucide-react";
import { getPsOperationalBoard, listProjects, type OperationalUnit } from "@/lib/scheduling-projects-api";
import { listPsProjects, getPsProject } from "@/lib/planning-studio-api";

/* ─── Picker: scegli il programma di esercizio (default = quello attivo) ─── */
function ProgramPicker() {
  const [, navigate] = useLocation();
  // ?pick=1 → forza la scelta (evita il redirect automatico al programma attivo)
  const forcePick = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("pick") === "1";

  const schedQ = useQuery({ queryKey: ["scheduling", "projects", "all"], queryFn: () => listProjects() });
  const psQ = useQuery({ queryKey: ["ps", "projects"], queryFn: () => listPsProjects() });
  const loading = schedQ.isLoading || psQ.isLoading;

  // programma "attivo" = progetto PS operativo (feed in esercizio)
  const active = (psQ.data ?? []).find((p) => p.isOperational) ?? null;

  // gruppi: SOLO progetti PS accessibili (psQ) con UDP avviate o attivi. Costruire
  // dalle sole liste accessibili evita voci "orfane" (scheduling project che punta
  // a un PS cancellato/non accessibile) che davano 404 al click.
  const groups = (() => {
    const udpCount = new Map<string, number>();
    for (const p of schedQ.data ?? []) {
      if (p.planningStudioProjectId)
        udpCount.set(p.planningStudioProjectId, (udpCount.get(p.planningStudioProjectId) ?? 0) + 1);
    }
    return (psQ.data ?? [])
      .map((p) => ({ psId: p.id, name: p.name, udp: udpCount.get(p.id) ?? 0, isActive: !!p.isOperational }))
      .filter((g) => g.udp > 0 || g.isActive)
      .sort((a, b) => (b.isActive ? 1 : 0) - (a.isActive ? 1 : 0)); // attivo in cima
  })();

  // Default: apri direttamente il programma attivo (se non si è forzata la scelta)
  useEffect(() => {
    if (loading || forcePick || !active) return;
    navigate(`/fucina/esercizio/${active.id}`, { replace: true });
  }, [loading, forcePick, active, navigate]);

  return (
    <div className="flex flex-col h-screen bg-slate-950 text-slate-100">
      <div className="border-b border-slate-800 bg-slate-900 px-4 py-3 flex items-center gap-3">
        <ClipboardList className="h-5 w-5 text-emerald-400" />
        <h1 className="font-semibold text-slate-100">Progetti di esercizio</h1>
        <span className="text-[11px] text-slate-500">scegli il progetto da gestire</span>
      </div>
      <div className="flex-1 overflow-auto p-6">
        {loading && <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-emerald-400" /></div>}
        {!loading && groups.length === 0 && (
          <div className="max-w-xl mx-auto border-2 border-dashed border-slate-700 rounded-lg p-10 text-center text-slate-400">
            <Layers className="h-12 w-12 mx-auto text-slate-600 mb-3" />
            <p className="font-medium text-slate-200 mb-1">Nessun programma avviato allo scheduling</p>
            <p className="text-xs">Crea le UDP in Planning Studio e portane almeno una allo Scheduling Engine.</p>
          </div>
        )}
        <div className="max-w-2xl mx-auto space-y-2">
          {groups.map((g) => (
            <button key={g.psId} onClick={() => navigate(`/fucina/esercizio/${g.psId}`)}
              className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl border transition-colors text-left ${
                g.isActive ? "border-emerald-500/60 bg-emerald-500/10 ring-1 ring-emerald-500/30" : "border-slate-800 bg-slate-900 hover:border-emerald-500/40 hover:bg-slate-900/60"
              }`}>
              <ClipboardList className="h-5 w-5 text-emerald-400 shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-slate-100 truncate">{g.name}</span>
                  {g.isActive && (
                    <span className="inline-flex items-center gap-1 text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-emerald-500 text-black"><Power className="w-2.5 h-2.5" /> Attivo</span>
                  )}
                </div>
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

/* ─── Card di una UDP: cliccabile → entra nel progetto (dashboard). Lo stepper
       TM → TG → Operativo è solo stato visivo; generazione/scenari stanno dentro. ─── */
function UdpCard({ u, onEnter, entering }: {
  u: OperationalUnit;
  onEnter: (u: OperationalUnit) => void;
  entering: boolean;
}) {
  const tmDone = !!u.vehicleScenario;
  const tgDone = !!u.driverScenario;
  const operative = u.status === "complete" && u.vehicleUncovered === 0;
  const accent = operative ? "border-l-emerald-500" : u.status === "missing_vehicle" || u.status === "not_started" ? "border-l-rose-500/70" : "border-l-amber-500/70";

  return (
    <button
      onClick={() => onEnter(u)}
      disabled={entering}
      className={`w-full text-left rounded-xl border border-slate-800 border-l-[3px] ${accent} bg-slate-900/40 p-3.5 hover:border-slate-600 hover:bg-slate-900/70 transition-colors disabled:opacity-60`}
    >
      {/* riga 1: nome UDP + stato + entra */}
      <div className="flex items-center gap-2 mb-3">
        <Layers className="w-4 h-4 text-slate-500 shrink-0" />
        <div className="min-w-0">
          <div className="font-semibold text-slate-100 truncate">{u.validityUnitName ?? "UDP"}</div>
          <div className="text-[10px] text-slate-500">{u.tripCount} corse</div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <UnitStatus u={u} />
          {entering ? <Loader2 className="w-4 h-4 animate-spin text-emerald-400" /> : <ArrowRight className="w-4 h-4 text-slate-500" />}
        </div>
      </div>

      {/* stepper (solo stato) */}
      <div className="grid grid-cols-[1fr_auto_1fr_auto_auto] items-center gap-2">
        {/* Step 1 — Turni macchina */}
        <div className="rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2">
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-slate-500 mb-1">
            <Truck className="w-3 h-3 text-amber-400" /> Turni macchina
          </div>
          {tmDone ? (
            <span className="inline-flex items-center gap-1.5 text-xs text-slate-200">
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
              <span className="truncate max-w-[150px]">{u.vehicleScenario!.name}</span>
              {u.vehicleScenario!.numVehicles != null && <span className="text-[10px] text-amber-400/80 font-mono shrink-0">{u.vehicleScenario!.numVehicles} vett.</span>}
            </span>
          ) : (
            <span className="text-[11px] text-slate-500">da generare</span>
          )}
          {u.vehicleUncovered > 0 && (
            <div className="text-[10px] text-amber-300 mt-1 flex items-center gap-1"><AlertTriangle className="w-2.5 h-2.5" /> {u.vehicleUncovered} corse scoperte</div>
          )}
        </div>

        <ChevronRight className="w-4 h-4 text-slate-600 shrink-0" />

        {/* Step 2 — Turni guida */}
        <div className="rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2">
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-slate-500 mb-1">
            <Users className="w-3 h-3 text-purple-400" /> Turni guida
          </div>
          {tgDone ? (
            <span className="inline-flex items-center gap-1.5 text-xs text-slate-200">
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
              <span className="truncate max-w-[150px]">{u.driverScenario!.name}</span>
              <span className="text-[10px] text-purple-300/80 font-mono shrink-0">{u.driverScenario!.dutyCount} turni</span>
            </span>
          ) : tmDone ? (
            <span className="text-[11px] text-slate-500">da generare</span>
          ) : (
            <span className="text-[11px] text-slate-600">prima i turni macchina</span>
          )}
        </div>

        <ChevronRight className="w-4 h-4 text-slate-600 shrink-0" />

        {/* Step 3 — Operativo */}
        <div className={`rounded-lg border px-3 py-2 text-center ${operative ? "border-emerald-500/40 bg-emerald-500/10" : "border-slate-800 bg-slate-950/40"}`}>
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-slate-500 mb-1">
            <Power className={`w-3 h-3 ${operative ? "text-emerald-400" : "text-slate-600"}`} /> Operativo
          </div>
          {operative
            ? <span className="inline-flex items-center gap-1 text-xs text-emerald-300"><CheckCircle2 className="w-3.5 h-3.5" /> Pronto</span>
            : <span className="text-[11px] text-slate-600">—</span>}
        </div>
      </div>
    </button>
  );
}

/* ─── Contenitore: Progetto di esercizio ─── */
function Board({ psId }: { psId: string }) {
  const [, navigate] = useLocation();
  const boardQ = useQuery({
    queryKey: ["scheduling", "operational-board", psId],
    queryFn: () => getPsOperationalBoard(psId),
    enabled: !!psId,
    retry: false, // 404 "non accessibile" → niente retry storm
  });
  const projectQ = useQuery({
    queryKey: ["ps", "project", psId],
    queryFn: () => getPsProject(psId),
    enabled: !!psId,
    retry: false,
  });
  const board = boardQ.data;
  const isActive = !!projectQ.data?.isOperational;

  // Avvio scheduling per una UDP: riusa/crea il progetto di scheduling dell'unità
  // (la creazione avvia la materializzazione PS→feed) e parte con l'ottimizzazione.
  const startMut = useMutation({
    mutationFn: async (u: OperationalUnit) => {
      const found = await apiFetch<{ projects: Array<{ id: string; validityUnitId?: string | null }> }>(
        `/api/scheduling/projects?planningStudioProjectId=${psId}`,
      );
      const forUnit = found.projects.find((p) => p.validityUnitId === u.validityUnitId);
      if (forUnit) return forUnit.id;
      const created = await apiFetch<{ project: { id: string } }>("/api/scheduling/projects", {
        method: "POST",
        body: JSON.stringify({
          name: `${projectQ.data?.name ?? "Progetto"} · ${u.validityUnitName ?? "UDP"}`,
          description: "Creato da Progetti di Esercizio",
          planningStudioProjectId: psId,
          validityUnitId: u.validityUnitId,
        }),
      });
      return created.project.id;
    },
    onSuccess: (schedulingProjectId) => {
      navigate(`/fucina/${schedulingProjectId}`);
    },
    onError: (e: Error) => toast.error(`Scheduling: ${e.message}`),
  });

  const pct = board && board.totals.udp > 0 ? Math.round((board.totals.complete / board.totals.udp) * 100) : 0;
  const valleUncovered = board ? board.projects.reduce((s, u) => s + u.vehicleUncovered, 0) : 0;
  const totUncovered = (board?.programUncoveredTrips ?? 0) + valleUncovered;

  return (
    <div className="flex flex-col h-screen bg-slate-950 text-slate-100">
      {/* Header contenitore */}
      <div className="border-b border-slate-800 bg-slate-900 shadow-sm">
        <div className="flex items-center gap-3 px-4 py-3">
          <Link href="/fucina/esercizio?pick=1">
            <button className="p-2 rounded hover:bg-slate-800 text-slate-400 hover:text-slate-100 transition-colors" title="Cambia progetto"><ArrowLeft className="h-4 w-4" /></button>
          </Link>
          <ClipboardList className="h-5 w-5 text-emerald-400" />
          <div className="min-w-0">
            <h1 className="font-semibold text-slate-100 leading-tight flex items-center gap-2 truncate">
              {projectQ.data?.name ?? "Progetto di esercizio"}
              {isActive && (
                <span className="inline-flex items-center gap-1 text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-emerald-500 text-black shrink-0"><Power className="w-2.5 h-2.5" /> Attivo</span>
              )}
            </h1>
            <p className="text-[11px] text-slate-500 leading-tight">Progetto di esercizio · UDP, scheduling per unità, corse scoperte</p>
          </div>
          {board && (
            <button onClick={() => navigate(`/roster?psProjectId=${psId}&operational=1`)}
              className="ml-auto inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-600 text-white hover:bg-emerald-500 transition-colors shrink-0">
              <Users className="h-3.5 w-3.5" /> Apri nel Roster
            </button>
          )}
        </div>
        {/* Strip avanzamento processo */}
        {board && (
          <div className="px-4 pb-3 flex items-center gap-4">
            <div className="flex-1 max-w-md">
              <div className="flex items-center justify-between text-[10px] text-slate-500 mb-1">
                <span>Avanzamento UDP</span>
                <span className="tabular-nums">{board.totals.complete}/{board.totals.udp} complete · {pct}%</span>
              </div>
              <div className="h-1.5 rounded-full bg-slate-800 overflow-hidden">
                <div className="h-full bg-emerald-500 transition-all" style={{ width: `${pct}%` }} />
              </div>
            </div>
            <div className="flex items-center gap-4 text-xs ml-auto">
              <div className="text-right"><div className="text-amber-300 font-semibold tabular-nums">{board.totals.vehicles}</div><div className="text-[10px] uppercase tracking-wide text-slate-500">vetture</div></div>
              <div className="text-right"><div className="text-purple-300 font-semibold tabular-nums">{board.totals.duties}</div><div className="text-[10px] uppercase tracking-wide text-slate-500">turni guida</div></div>
              <div className="text-right"><div className={`font-semibold tabular-nums ${totUncovered > 0 ? "text-rose-300" : "text-slate-300"}`}>{totUncovered}</div><div className="text-[10px] uppercase tracking-wide text-slate-500">corse scoperte</div></div>
            </div>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-auto p-6">
        {boardQ.isLoading && <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-emerald-400" /></div>}
        {(boardQ.isError || projectQ.isError) && (
          <div className="max-w-lg mx-auto border border-rose-500/40 bg-rose-500/10 rounded-xl p-6 text-center">
            <AlertTriangle className="h-8 w-8 mx-auto text-rose-400 mb-2" />
            <p className="font-medium text-rose-200 mb-1">Progetto non disponibile</p>
            <p className="text-xs text-rose-300/80 mb-4">
              {((boardQ.error ?? projectQ.error) as Error)?.message ?? "Impossibile caricare il progetto."}
              {" "}Potrebbe essere stato eliminato o non è accessibile da questo account.
            </p>
            <Link href="/fucina/esercizio?pick=1">
              <button className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-slate-800 text-slate-100 hover:bg-slate-700"><ArrowLeft className="w-3.5 h-3.5" /> Torna ai progetti</button>
            </Link>
          </div>
        )}

        {board && (
          <div className="max-w-4xl mx-auto space-y-3">
            {/* Corse scoperte a monte (fuori da ogni UDP) */}
            {board.programUncoveredTrips > 0 && (
              <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3.5 py-2.5 text-xs text-rose-200 flex items-start gap-2">
                <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                <div>
                  <strong>{board.programUncoveredTrips} corse non sono in nessuna UDP</strong> (scoperte a monte).
                  <Link href={`/planning-studio/${psId}/validity-units`}>
                    <button className="ml-1 underline hover:text-rose-100">Assegnale nella Matrice di validità →</button>
                  </Link>
                </div>
              </div>
            )}

            {board.projects.length === 0 && (
              <div className="border-2 border-dashed border-slate-700 rounded-lg p-10 text-center text-slate-400">
                <Layers className="h-12 w-12 mx-auto text-slate-600 mb-3" />
                <p className="font-medium text-slate-200 mb-1">Nessuna UDP in questo progetto</p>
                <p className="text-xs mb-3">Crea le Unità di Progettazione nella Matrice di validità.</p>
                <Link href={`/planning-studio/${psId}/validity-units`}>
                  <button className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-600 text-white hover:bg-emerald-500"><Plus className="w-3.5 h-3.5" /> Crea UDP</button>
                </Link>
              </div>
            )}

            {/* Lista UDP — clic su una UDP = entra nel suo progetto (dashboard) */}
            {board.projects.map((u) => (
              <UdpCard
                key={u.validityUnitId}
                u={u}
                onEnter={(unit) => {
                  if (unit.schedulingProjectId) navigate(`/fucina/${unit.schedulingProjectId}`);
                  else startMut.mutate(unit);
                }}
                entering={startMut.isPending && startMut.variables?.validityUnitId === u.validityUnitId}
              />
            ))}

            {board.projects.length > 0 && (
              <p className="text-[11px] text-slate-500 flex items-center gap-1.5 pt-1">
                <Sparkles className="w-3 h-3 text-emerald-400/70" />
                Clicca una UDP per entrare nel suo progetto: lì generi e gestisci gli scenari di turni macchina e turni guida. Verde = unità operativa.
              </p>
            )}
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
