/**
 * Vehicle Scenarios Page — Lista scenari vetture di un progetto.
 *
 * Modello:
 *   Project ──< VehicleScenario (service_program_scenarios)
 *
 * Click su uno scenario → naviga al workspace step 6 con deep-link ?scenario=ID.
 */
import { useEffect, useMemo, useState } from "react";
import { useLocation, useRoute } from "wouter";
import { motion } from "framer-motion";
import { toast } from "sonner";
import {
  ArrowLeft, Truck, Plus, Loader2, Calendar, FolderOpen, ChevronRight,
  Share2, Users as UsersIcon, Lock,
} from "lucide-react";
import {
  getProject, listProjectVehicleScenarios, attachVehicleScenarioToProject,
  type SchedulingProject, type ProjectVehicleScenario,
} from "@/lib/scheduling-projects-api";
import {
  listVehicleSchedules, type VehicleScheduleProject,
} from "@/lib/schedule-shares-api";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/hooks/use-auth";
import ShareScheduleDialog from "@/components/scheduling/ShareScheduleDialog";

export default function VehicleScenariosPage() {
  const [, navigate] = useLocation();
  const [, params] = useRoute<{ projectId: string }>("/fucina/:projectId/vehicles");
  const projectId = params?.projectId ?? null;
  const { user } = useAuth();

  const [project, setProject] = useState<SchedulingProject | null>(null);
  const [scenarios, setScenarios] = useState<ProjectVehicleScenario[]>([]);
  const [shares, setShares] = useState<VehicleScheduleProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAttach, setShowAttach] = useState(false);
  const [shareDialog, setShareDialog] = useState<{ id: string; name: string; canManage: boolean } | null>(null);

  async function reload() {
    if (!projectId) return;
    setLoading(true);
    try {
      const [p, s, sh] = await Promise.all([
        getProject(projectId),
        listProjectVehicleScenarios(projectId),
        listVehicleSchedules({ schedulingProjectId: projectId }).catch(() => [] as VehicleScheduleProject[]),
      ]);
      setProject(p);
      setScenarios(s);
      setShares(sh);
    } catch (e: any) {
      toast.error(e?.message || "Errore caricamento");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void reload(); }, [projectId]);

  // Index degli share per id (per merge dei metadati owner/membri sulle card)
  const shareById = useMemo(() => {
    const m = new Map<string, VehicleScheduleProject>();
    for (const x of shares) m.set(x.id, x);
    return m;
  }, [shares]);

  if (!projectId) return null;

  function openScenario(s: ProjectVehicleScenario) {
    // Riusa il deep-link esistente di FucinaPage (?scenario=ID → step 6)
    navigate(`/fucina/${projectId}/vehicles/${s.id}`);
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
            <Truck className="w-4 h-4 text-amber-400 shrink-0" />
            <span className="font-bold text-zinc-100 truncate">{project?.name ?? "…"}</span>
            <ChevronRight className="w-3 h-3 text-zinc-600 shrink-0" />
            <span className="text-zinc-400">Scenari Vetture</span>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <button onClick={() => setShowAttach(true)}
              className="text-[11px] text-zinc-400 hover:text-orange-300 px-2 py-1.5 rounded-lg hover:bg-orange-500/8 transition-colors"
              title="Aggancia uno scenario vetture esistente al progetto"
            >
              + Aggancia esistente
            </button>
            <button onClick={() => navigate(`/fucina/${projectId}/pipeline`)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold text-black bg-gradient-to-r from-orange-400 to-amber-400 hover:shadow-[0_0_20px_rgba(251,146,60,0.4)] transition-shadow"
            >
              <Plus className="w-3.5 h-3.5" /> Nuovo scenario
            </button>
          </div>
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-6 py-8">
        {loading ? (
          <div className="flex items-center justify-center py-20 text-zinc-500">
            <Loader2 className="w-5 h-5 animate-spin mr-2" /> Caricamento…
          </div>
        ) : scenarios.length === 0 ? (
          <div className="rounded-xl border border-dashed border-orange-500/30 bg-orange-500/5 p-10 text-center">
            <FolderOpen className="w-10 h-10 text-orange-400/50 mx-auto mb-3" />
            <p className="text-sm text-zinc-300 font-semibold mb-1">Nessuno scenario di vetture in questo progetto</p>
            <p className="text-xs text-zinc-500 mb-4">
              Esegui la pipeline per generare il tuo primo scenario di turni macchina.
            </p>
            <button onClick={() => navigate(`/fucina/${projectId}/pipeline`)}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-bold text-black bg-gradient-to-r from-orange-400 to-amber-400"
            >
              <Plus className="w-3.5 h-3.5" /> Esegui pipeline ora
            </button>
            <p className="text-[10px] text-zinc-600 mt-4 italic">
              Hai uno scenario salvato in passato? Aggancialo al progetto via "+ Aggancia esistente" in alto.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-[10px] text-zinc-500 font-mono uppercase tracking-widest mb-2">
              {scenarios.length} scenari vetture
            </p>
            {scenarios.map((s) => {
              const sh = shareById.get(s.id);
              const isOwner = !!(user && sh && sh.ownerUserId === user.id);
              const myRole = sh?.myRole;
              const ownerLabel = sh?.ownerFullName || sh?.ownerEmail;
              const memberCount = sh?.memberCount ?? 0;
              return (
              <motion.div key={s.id}
                whileHover={{ x: 3 }}
                className="rounded-xl border border-zinc-800 bg-gradient-to-br from-zinc-950 to-black hover:border-amber-500/40 transition-colors group flex items-center gap-4 p-4"
              >
                <button onClick={() => openScenario(s)} className="flex items-center gap-4 flex-1 min-w-0 text-left">
                <div className="w-10 h-10 rounded-lg bg-amber-500/15 border border-amber-500/30 flex items-center justify-center shrink-0">
                  <Truck className="w-5 h-5 text-amber-400" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="font-semibold text-zinc-100 text-sm truncate">{s.name}</h3>
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
                  <div className="flex items-center gap-3 text-xs text-zinc-500 mt-1 flex-wrap">
                    <span className="flex items-center gap-1">
                      <Calendar className="w-3 h-3" />
                      {s.date.length === 8 ? `${s.date.slice(6,8)}/${s.date.slice(4,6)}/${s.date.slice(0,4)}` : s.date}
                    </span>
                    {s.numVehicles != null && (
                      <span className="font-mono text-amber-400/80">
                        {s.numVehicles} vetture
                      </span>
                    )}
                    {s.totalDeadheadKm != null && (
                      <span className="font-mono text-zinc-600">
                        DH {s.totalDeadheadKm.toFixed(1)} km
                      </span>
                    )}
                    {ownerLabel && (
                      <span className="text-zinc-600">
                        Owner: <span className="text-zinc-400">{ownerLabel}</span>
                      </span>
                    )}
                    {memberCount > 0 && (
                      <span className="inline-flex items-center gap-1 text-cyan-400/80">
                        <UsersIcon className="w-3 h-3" /> {memberCount}
                      </span>
                    )}
                    <span className="text-zinc-600">
                      Salvato {new Date(s.createdAt).toLocaleString("it-IT", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}
                    </span>
                  </div>
                </div>
                </button>
                <div className="flex items-center gap-1 shrink-0">
                  {sh && (
                    <button
                      onClick={(e) => { e.stopPropagation(); setShareDialog({ id: s.id, name: s.name, canManage: isOwner }); }}
                      title={isOwner ? "Condividi questo scenario" : "Vedi membri"}
                      className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-1.5 rounded-lg border border-cyan-500/30 text-cyan-300 hover:bg-cyan-500/10 transition-colors"
                    >
                      <Share2 className="w-3 h-3" />
                      {isOwner ? "Condividi" : "Membri"}
                    </button>
                  )}
                  <ChevronRight className="w-4 h-4 text-zinc-600 group-hover:text-amber-400 group-hover:translate-x-1 transition-all" />
                </div>
              </motion.div>
              );
            })}
          </div>
        )}
      </div>

      {showAttach && (
        <AttachExistingDialog
          projectId={projectId}
          onClose={() => setShowAttach(false)}
          onAttached={() => { setShowAttach(false); void reload(); }}
        />
      )}

      {shareDialog && (
        <ShareScheduleDialog
          kind="vehicle"
          id={shareDialog.id}
          scheduleName={shareDialog.name}
          open={true}
          canManage={shareDialog.canManage}
          onClose={() => setShareDialog(null)}
          onChange={() => void reload()}
        />
      )}
    </div>
  );
}

/* ───── Dialog per agganciare uno scenario vetture esistente ───── */
function AttachExistingDialog({
  projectId, onClose, onAttached,
}: {
  projectId: string;
  onClose: () => void;
  onAttached: () => void;
}) {
  const [all, setAll] = useState<{ id: string; name: string; date: string; createdAt: string }[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const r = await apiFetch<any[]>("/api/service-program/scenarios");
        setAll(r);
      } catch (e: any) {
        toast.error(e?.message || "Errore caricamento scenari");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function attach(scenarioId: string) {
    try {
      await attachVehicleScenarioToProject(projectId, scenarioId);
      toast.success("Scenario agganciato al progetto");
      onAttached();
    } catch (e: any) {
      toast.error(e?.message || "Errore aggancio");
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-lg mx-4 max-h-[80vh] flex flex-col rounded-xl border border-orange-500/30 bg-gradient-to-br from-zinc-950 to-black shadow-2xl">
        <div className="p-5 border-b border-zinc-800">
          <h2 className="text-base font-bold text-zinc-100">Aggancia scenario vetture esistente</h2>
          <p className="text-xs text-zinc-500 mt-1">
            Tutti gli scenari salvati nel sistema. Click per agganciarli a questo progetto.
          </p>
        </div>
        <div className="flex-1 overflow-y-auto p-3">
          {loading ? (
            <div className="text-center py-8 text-zinc-500"><Loader2 className="w-4 h-4 animate-spin inline mr-2" /> Caricamento…</div>
          ) : all.length === 0 ? (
            <p className="text-center text-zinc-500 py-8 text-sm">Nessuno scenario disponibile</p>
          ) : (
            <div className="space-y-1.5">
              {all.map(s => (
                <button key={s.id} onClick={() => attach(s.id)}
                  className="w-full text-left rounded-lg border border-zinc-800 hover:border-amber-500/40 p-3 transition-colors"
                >
                  <p className="text-sm text-zinc-200 font-medium">{s.name}</p>
                  <p className="text-[10px] text-zinc-500 font-mono mt-0.5">
                    {s.date} · {new Date(s.createdAt).toLocaleString("it-IT")}
                  </p>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="p-3 border-t border-zinc-800 flex justify-end">
          <button onClick={onClose}
            className="px-3 py-1.5 rounded-lg text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
          >
            Chiudi
          </button>
        </div>
      </div>
    </div>
  );
}
