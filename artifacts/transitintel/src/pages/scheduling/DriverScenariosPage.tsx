/**
 * Driver Scenarios Page — Lista scenari turni guida (DSS) di un progetto.
 *
 * Modello:
 *   Project ──< VehicleScenario ──< DriverShiftScenario (DSS)
 *
 * Visualizzazione raggruppata per scenario vetture: per ogni vehicle scenario
 * vediamo i suoi DSS. Click su un vehicle scenario → apre il workspace DSS
 * (FucinaPage step 7 con vehicleScenarioId pre-caricato via deep-link).
 */
import { useEffect, useMemo, useState } from "react";
import { useLocation, useRoute } from "wouter";
import { motion } from "framer-motion";
import { toast } from "sonner";
import {
  ArrowLeft, Users, Truck, Loader2, Calendar, FolderOpen, ChevronRight, ChevronDown,
  Share2, Lock, Users as UsersIcon, Power, Trash2, X, AlertTriangle,
} from "lucide-react";
import {
  getProject, listProjectVehicleScenarios, listProjectDriverScenarios,
  setDriverScenarioOperational,
  type SchedulingProject, type ProjectVehicleScenario, type ProjectDriverScenario,
} from "@/lib/scheduling-projects-api";
import {
  listDriverSchedules, type DriverScheduleProject,
} from "@/lib/schedule-shares-api";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/hooks/use-auth";
import ShareScheduleDialog from "@/components/scheduling/ShareScheduleDialog";

export default function DriverScenariosPage() {
  const [, navigate] = useLocation();
  const [, params] = useRoute<{ projectId: string }>("/fucina/:projectId/drivers");
  const projectId = params?.projectId ?? null;
  const { user } = useAuth();

  const [project, setProject] = useState<SchedulingProject | null>(null);
  const [vehicles, setVehicles] = useState<ProjectVehicleScenario[]>([]);
  const [dss, setDss] = useState<ProjectDriverScenario[]>([]);
  const [shares, setShares] = useState<DriverScheduleProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [shareDialog, setShareDialog] = useState<{ id: string; name: string; canManage: boolean } | null>(null);
  // Eliminazione con doppia conferma (modale + checkbox obbligatoria)
  const [deleteTarget, setDeleteTarget] = useState<ProjectDriverScenario | null>(null);
  const [deleteAck, setDeleteAck] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function reload() {
    if (!projectId) return;
    setLoading(true);
    try {
      const [p, v, d, sh] = await Promise.all([
        getProject(projectId),
        listProjectVehicleScenarios(projectId),
        listProjectDriverScenarios(projectId),
        listDriverSchedules({ schedulingProjectId: projectId }).catch(() => [] as DriverScheduleProject[]),
      ]);
      setProject(p);
      setVehicles(v);
      setDss(d);
      setShares(sh);
      if (v.length > 0) setExpanded(prev => prev.size === 0 ? new Set([v[0].id]) : prev);
    } catch (e: any) {
      toast.error(e?.message || "Errore caricamento");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void reload(); }, [projectId]);

  async function toggleDriverOperational(d: ProjectDriverScenario) {
    if (!projectId) return;
    try {
      await setDriverScenarioOperational(projectId, d.id, !d.isOperational);
      toast.success(d.isOperational ? "Rimosso dall'esercizio" : "Turni guida messi in esercizio");
      await reload();
    } catch (e: any) { toast.error(e?.message ?? "Errore"); }
  }

  async function doDelete() {
    if (!deleteTarget || !deleteAck) return;
    setDeleting(true);
    try {
      await apiFetch(`/api/driver-shifts/${deleteTarget.vehicleScenarioId}/scenarios/${deleteTarget.id}`, { method: "DELETE" });
      toast.success("Scenario eliminato", { description: deleteTarget.name });
      setDeleteTarget(null); setDeleteAck(false);
      await reload();
    } catch (e: any) { toast.error(e?.message ?? "Errore eliminazione"); }
    finally { setDeleting(false); }
  }

  // Index DSS per vehicle scenario
  const dssByVehicle = useMemo(() => {
    const m = new Map<string, ProjectDriverScenario[]>();
    for (const d of dss) {
      const arr = m.get(d.vehicleScenarioId) ?? [];
      arr.push(d);
      m.set(d.vehicleScenarioId, arr);
    }
    return m;
  }, [dss]);

  // Index share per id (metadati owner/membri per ogni DSS)
  const shareById = useMemo(() => {
    const m = new Map<string, DriverScheduleProject>();
    for (const x of shares) m.set(x.id, x);
    return m;
  }, [shares]);

  if (!projectId) return null;

  function toggle(vehicleId: string) {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(vehicleId)) next.delete(vehicleId);
      else next.add(vehicleId);
      return next;
    });
  }

  function openVehicleWorkspace(vehicleScenarioId: string) {
    // Va nello step 7 (DriverWorkspaceStep) usando il deep-link su step 6
    // poi l'utente clicca "Turni Guida →". Per ora apriamo il workspace DSS diretto.
    navigate(`/fucina/${projectId}/drivers/${vehicleScenarioId}`);
  }

  return (
    <div className="min-h-screen w-full" style={{ background: "radial-gradient(ellipse at 30% 0%, #1a0a00 0%, #050200 70%, #000 100%)" }}>
      {/* Header */}
      <div className="border-b border-orange-500/15 bg-black/40 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-6 py-3 flex items-center gap-3">
          <button onClick={() => navigate(`/fucina/${projectId}`)}
            className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-orange-300 transition-colors"
          >
            <ArrowLeft className="w-3.5 h-3.5" /> Dashboard progetto
          </button>
          <div className="h-4 w-px bg-zinc-800" />
          <div className="flex items-center gap-2 min-w-0 text-xs">
            <Users className="w-4 h-4 text-purple-400 shrink-0" />
            <span className="font-bold text-zinc-100 truncate">{project?.name ?? "…"}</span>
            <ChevronRight className="w-3 h-3 text-zinc-600 shrink-0" />
            <span className="text-zinc-400">Turni Guida</span>
          </div>
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-6 py-8">
        <div className="mb-6">
          <p className="text-[10px] text-zinc-500 font-mono uppercase tracking-widest mb-1">Modello</p>
          <p className="text-sm text-zinc-400">
            I turni guida si basano su uno scenario di vetture. Apri uno scenario per generare o consultare i suoi turni guida.
          </p>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-20 text-zinc-500">
            <Loader2 className="w-5 h-5 animate-spin mr-2" /> Caricamento…
          </div>
        ) : vehicles.length === 0 ? (
          <div className="rounded-xl border border-dashed border-purple-500/30 bg-purple-500/5 p-10 text-center">
            <FolderOpen className="w-10 h-10 text-purple-400/50 mx-auto mb-3" />
            <p className="text-sm text-zinc-300 font-semibold mb-1">Nessuno scenario di vetture nel progetto</p>
            <p className="text-xs text-zinc-500 mb-4">
              I turni guida richiedono uno scenario vetture. Crea o aggancia prima uno scenario vetture.
            </p>
            <button onClick={() => navigate(`/fucina/${projectId}/vehicles`)}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-bold text-purple-200 border border-purple-500/40 bg-purple-500/15 hover:bg-purple-500/25"
            >
              <Truck className="w-3.5 h-3.5" /> Vai agli scenari vetture
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            {vehicles.map((v) => {
              const items = dssByVehicle.get(v.id) ?? [];
              const isOpen = expanded.has(v.id);
              return (
                <div key={v.id} className="rounded-xl border border-zinc-800 bg-gradient-to-br from-zinc-950 to-black overflow-hidden">
                  {/* Vehicle scenario header */}
                  <div className="flex items-center gap-3 p-4">
                    <button onClick={() => toggle(v.id)}
                      className="w-7 h-7 rounded-lg border border-zinc-800 hover:border-purple-500/50 flex items-center justify-center text-zinc-500 hover:text-purple-300 transition-colors"
                    >
                      {isOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                    </button>
                    <div className="w-10 h-10 rounded-lg bg-amber-500/10 border border-amber-500/30 flex items-center justify-center shrink-0">
                      <Truck className="w-5 h-5 text-amber-400/80" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold text-zinc-100 text-sm truncate">{v.name}</p>
                      <div className="flex items-center gap-3 text-[11px] text-zinc-500 mt-0.5">
                        <span className="flex items-center gap-1">
                          <Calendar className="w-3 h-3" />
                          {v.date.length === 8 ? `${v.date.slice(6,8)}/${v.date.slice(4,6)}/${v.date.slice(0,4)}` : v.date}
                        </span>
                        {v.numVehicles != null && <span className="font-mono text-amber-400/70">{v.numVehicles} vetture</span>}
                        <span className={`px-1.5 py-0.5 rounded font-mono ${items.length > 0 ? "bg-purple-500/15 text-purple-300" : "bg-zinc-800 text-zinc-500"}`}>
                          {items.length} DSS
                        </span>
                      </div>
                    </div>
                    <button onClick={() => openVehicleWorkspace(v.id)}
                      className="inline-flex items-center gap-1.5 text-[11px] font-medium px-3 py-1.5 rounded-lg border border-purple-500/30 bg-purple-500/10 text-purple-300 hover:bg-purple-500/20 transition-colors"
                    >
                      Apri workspace turni guida →
                    </button>
                  </div>

                  {/* DSS list */}
                  {isOpen && items.length > 0 && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: "auto" }}
                      className="border-t border-zinc-800/60 bg-black/40"
                    >
                      <div className="p-3 space-y-1.5">
                        {items.map((d) => {
                          const sh = shareById.get(d.id);
                          const isOwner = !!(user && sh && sh.ownerUserId === user.id);
                          const myRole = sh?.myRole;
                          const ownerLabel = sh?.ownerFullName || sh?.ownerEmail;
                          const memberCount = sh?.memberCount ?? 0;
                          return (
                          <div key={d.id}
                            className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-purple-500/8 transition-colors group"
                          >
                            <button onClick={() => navigate(`/fucina/${projectId}/drivers/${d.vehicleScenarioId}?dss=${d.id}`)}
                              title="Apri questo scenario turni guida salvato"
                              className="flex items-center gap-3 flex-1 min-w-0 text-left">
                            <div className="w-7 h-7 rounded bg-purple-500/15 border border-purple-500/30 flex items-center justify-center shrink-0">
                              <Users className="w-3.5 h-3.5 text-purple-400" />
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                <p className="text-sm text-zinc-200 truncate">{d.name}</p>
                                {d.isOperational && (
                                  <span className="inline-flex items-center gap-1 text-[9px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded bg-emerald-500 text-black border border-emerald-400">
                                    <Power className="w-2.5 h-2.5" /> in esercizio
                                  </span>
                                )}
                                {sh && (
                                  sh.isShared ? (
                                    <span className="inline-flex items-center gap-1 text-[9px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded bg-cyan-500/15 text-cyan-300 border border-cyan-500/30">
                                      <Share2 className="w-2.5 h-2.5" /> condiviso
                                    </span>
                                  ) : (
                                    <span className="inline-flex items-center gap-1 text-[9px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-500 border border-zinc-700">
                                      <Lock className="w-2.5 h-2.5" /> privato
                                    </span>
                                  )
                                )}
                                {myRole && myRole !== "owner" && (
                                  <span className="text-[9px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                                    {myRole}
                                  </span>
                                )}
                              </div>
                              <div className="flex items-center gap-3 text-[10px] text-zinc-500 font-mono mt-0.5 flex-wrap">
                                <span>Salvato {new Date(d.createdAt).toLocaleString("it-IT", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}</span>
                                {(d.dutyCount ?? 0) > 0 && <span className="text-purple-300/80">{d.dutyCount} turni</span>}
                                {(d.uncoveredTrips ?? 0) > 0 && (
                                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30">
                                    ⚠ {d.uncoveredTrips} corse scoperte
                                  </span>
                                )}
                                {d.staleSince && (
                                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-orange-500/15 text-orange-300 border border-orange-500/30"
                                        title={`Il feed è stato risincronizzato il ${new Date(d.staleSince).toLocaleString("it-IT", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}: questi turni riflettono i dati precedenti. Rigenera o risalva per allinearli.`}>
                                    ⚠ dati superati
                                  </span>
                                )}
                                {ownerLabel && <span className="text-zinc-600">Owner: <span className="text-zinc-400">{ownerLabel}</span></span>}
                                {memberCount > 0 && (
                                  <span className="inline-flex items-center gap-1 text-cyan-400/80">
                                    <UsersIcon className="w-3 h-3" /> {memberCount}
                                  </span>
                                )}
                              </div>
                            </div>
                            </button>
                            <button
                              onClick={(e) => { e.stopPropagation(); void toggleDriverOperational(d); }}
                              title={d.isOperational ? "Togli dall'esercizio" : "Metti in esercizio (turni guida ufficiali per questa UDP)"}
                              className={`inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-1 rounded border transition-colors shrink-0 ${
                                d.isOperational
                                  ? "border-emerald-400 bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25"
                                  : "border-zinc-700 text-zinc-400 hover:text-emerald-300 hover:border-emerald-500/40"
                              }`}
                            >
                              <Power className="w-3 h-3" />
                              {d.isOperational ? "In esercizio" : "Metti in esercizio"}
                            </button>
                            {sh && (
                              <button
                                onClick={(e) => { e.stopPropagation(); setShareDialog({ id: d.id, name: d.name, canManage: isOwner }); }}
                                title={isOwner ? "Condividi" : "Vedi membri"}
                                className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-1 rounded border border-cyan-500/30 text-cyan-300 hover:bg-cyan-500/10 transition-colors shrink-0"
                              >
                                <Share2 className="w-3 h-3" />
                                {isOwner ? "Condividi" : "Membri"}
                              </button>
                            )}
                            {isOwner && (
                              <button
                                onClick={(e) => { e.stopPropagation(); setDeleteTarget(d); setDeleteAck(false); }}
                                title="Elimina scenario"
                                className="inline-flex items-center justify-center w-6 h-6 rounded border border-rose-500/30 text-rose-400 hover:bg-rose-500/10 transition-colors shrink-0"
                              >
                                <Trash2 className="w-3 h-3" />
                              </button>
                            )}
                            <ChevronRight className="w-3.5 h-3.5 text-zinc-600 group-hover:text-purple-400 transition-colors" />
                          </div>
                          );
                        })}
                      </div>
                    </motion.div>
                  )}
                  {isOpen && items.length === 0 && (
                    <div className="border-t border-zinc-800/60 bg-black/40 px-4 py-3 text-[11px] text-zinc-500 italic">
                      Nessun turno guida salvato per questo scenario vetture. Apri il workspace per generarne uno.
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {shareDialog && (
        <ShareScheduleDialog
          kind="driver"
          id={shareDialog.id}
          scheduleName={shareDialog.name}
          open={true}
          canManage={shareDialog.canManage}
          onClose={() => setShareDialog(null)}
          onChange={() => void reload()}
        />
      )}

      {/* Doppia conferma eliminazione scenario TG */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={() => !deleting && setDeleteTarget(null)}>
          <div className="w-full max-w-md mx-4 rounded-lg border border-rose-500/30 bg-zinc-950 shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
              <div className="flex items-center gap-2"><Trash2 className="w-4 h-4 text-rose-400" /><h3 className="text-sm font-semibold text-zinc-100">Elimina scenario turni guida</h3></div>
              <button onClick={() => !deleting && setDeleteTarget(null)} className="text-zinc-500 hover:text-zinc-200"><X className="w-4 h-4" /></button>
            </div>
            <div className="p-4 space-y-3">
              <p className="text-sm text-zinc-300">Stai per eliminare <strong className="text-zinc-100">«{deleteTarget.name}»</strong>.</p>
              <p className="text-xs text-rose-300/90 flex items-start gap-1.5"><AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" /> Azione irreversibile: lo scenario di turni guida non sarà più recuperabile.</p>
              <label className="flex items-center gap-2 text-xs text-zinc-300 cursor-pointer select-none">
                <input type="checkbox" checked={deleteAck} onChange={e => setDeleteAck(e.target.checked)} className="accent-rose-500" />
                Confermo di voler eliminare definitivamente questo scenario
              </label>
            </div>
            <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-zinc-800 bg-black/30">
              <button onClick={() => setDeleteTarget(null)} disabled={deleting} className="text-xs px-3 py-1.5 rounded border border-zinc-700 text-zinc-300 hover:bg-zinc-800 disabled:opacity-40">Annulla</button>
              <button onClick={doDelete} disabled={!deleteAck || deleting} className="text-xs px-3 py-1.5 rounded bg-rose-600 text-white hover:bg-rose-500 disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1.5">
                {deleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />} Elimina definitivamente
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
