/**
 * Project Dashboard — landing per /fucina/:projectId.
 *
 * Mostra le 3 azioni principali per un progetto di esercizio:
 *   1. Pipeline / Riottimizza            → /fucina/:id/pipeline (step 0)
 *   2. Scenari Vetture (lista)           → /fucina/:id/vehicles (VehicleScenariosPage)
 *   3. Scenari Turni Guida (lista)       → /fucina/:id/drivers  (DriverScenariosPage)
 *
 * Mantiene la spina dorsale "un progetto = un esercizio", ma offre
 * accesso rapido alle aree di lavoro senza ripercorrere la pipeline.
 */
import React, { useEffect, useState } from "react";
import { useLocation, useRoute } from "wouter";
import { motion } from "framer-motion";
import { toast } from "sonner";
import {
  ArrowLeft, Flame, Truck, Users, Layers, Zap, ChevronRight,
  Loader2, Calendar, Database, ArrowRight, Share2, Activity, Shield, UserPlus,
} from "lucide-react";
import {
  getProject, STAGE_META, stageProgress,
  listProjectMembers, listProjectActivity,
  listProjectVehicleScenarios, listProjectDriverScenarios,
  type SchedulingProject, type ProjectMember, type ProjectActivity,
  type ProjectVehicleScenario, type ProjectDriverScenario,
} from "@/lib/scheduling-projects-api";
import { Power } from "lucide-react";
import ShareProjectDialog from "@/components/scheduling/ShareProjectDialog";
import { useAuth } from "@/hooks/use-auth";

interface ActionCardProps {
  icon: React.ComponentType<{ className?: string }>;
  iconColor: string;
  iconBg: string;
  title: string;
  desc: string;
  cta: string;
  onClick: () => void;
  primary?: boolean;
}

function ActionCard({ icon: Icon, iconColor, iconBg, title, desc, cta, onClick, primary }: ActionCardProps) {
  return (
    <motion.button
      onClick={onClick}
      whileHover={{ y: -3 }}
      whileTap={{ scale: 0.98 }}
      className={`group relative text-left rounded-2xl border p-6 transition-all overflow-hidden ${
        primary
          ? "border-orange-500/40 bg-gradient-to-br from-orange-950/40 via-zinc-950 to-black hover:border-orange-500/70 hover:shadow-[0_0_40px_rgba(251,146,60,0.2)]"
          : "border-zinc-800 bg-gradient-to-br from-zinc-950 to-black hover:border-orange-500/40"
      }`}
    >
      <div className={`w-14 h-14 rounded-xl ${iconBg} border flex items-center justify-center mb-4`}>
        <Icon className={`w-7 h-7 ${iconColor}`} />
      </div>
      <h3 className={`text-base font-bold mb-1.5 ${primary ? "text-orange-100" : "text-zinc-100"}`}>
        {title}
      </h3>
      <p className="text-xs text-zinc-400 leading-relaxed mb-4 min-h-[2.5rem]">{desc}</p>
      <div className={`inline-flex items-center gap-1.5 text-xs font-semibold ${primary ? "text-orange-300" : "text-zinc-300 group-hover:text-orange-300"} transition-colors`}>
        {cta}
        <ArrowRight className="w-3.5 h-3.5 group-hover:translate-x-1 transition-transform" />
      </div>
    </motion.button>
  );
}

export default function ProjectDashboardPage() {
  const [, navigate] = useLocation();
  const [, params] = useRoute<{ projectId: string }>("/fucina/:projectId");
  const projectId = params?.projectId ?? null;
  const { user } = useAuth();

  const [project, setProject] = useState<SchedulingProject | null>(null);
  const [loading, setLoading] = useState(true);
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [activity, setActivity] = useState<ProjectActivity[]>([]);
  const [shareOpen, setShareOpen] = useState(false);
  const [vehScenarios, setVehScenarios] = useState<ProjectVehicleScenario[]>([]);
  const [drvScenarios, setDrvScenarios] = useState<ProjectDriverScenario[]>([]);

  // Carica progetto
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const p = await getProject(projectId);
        if (!cancelled) setProject(p);
      } catch (e: any) {
        toast.error(e?.message || "Progetto non trovato");
        navigate("/fucina");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [projectId, navigate]);

  // Carica membri + attività in parallelo
  const refreshShared = React.useCallback(async () => {
    if (!projectId) return;
    try {
      const [m, a, vs, ds] = await Promise.all([
        listProjectMembers(projectId),
        listProjectActivity(projectId, 50),
        listProjectVehicleScenarios(projectId).catch(() => []),
        listProjectDriverScenarios(projectId).catch(() => []),
      ]);
      setMembers(m);
      setActivity(a);
      setVehScenarios(vs);
      setDrvScenarios(ds);
    } catch {
      // silenzioso (potrebbe essere un progetto appena creato)
    }
  }, [projectId]);

  useEffect(() => { void refreshShared(); }, [refreshShared]);

  const isOwner = !!(user && project && project.ownerUserId === user.id);
  const otherMembers = members.filter(m => m.role !== "owner");

  if (!projectId) return null;

  return (
    <div className="min-h-screen w-full" style={{ background: "radial-gradient(ellipse at 30% 0%, #1a0a00 0%, #050200 70%, #000 100%)" }}>
      {/* Header */}
      <div className="border-b border-orange-500/15 bg-black/40 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-6 py-3 flex items-center gap-4">
          <button onClick={() => navigate("/fucina")}
            className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-orange-300 transition-colors"
          >
            <ArrowLeft className="w-3.5 h-3.5" /> Tutti i progetti
          </button>
          <div className="h-4 w-px bg-zinc-800" />
          <div className="flex items-center gap-2 min-w-0">
            <Flame className="w-4 h-4 text-orange-400 shrink-0" />
            <h1 className="text-sm font-bold text-zinc-100 truncate">
              {project?.name ?? "Caricamento…"}
            </h1>
          </div>

          {/* Avatar group + Condividi (a destra) */}
          {project && (
            <div className="ml-auto flex items-center gap-2">
              {/* Avatar stack — clic apre dialog */}
              <button
                onClick={() => setShareOpen(true)}
                className="flex items-center -space-x-2 hover:opacity-80 transition-opacity"
                title={`${members.length} membr${members.length === 1 ? "o" : "i"}`}
              >
                {members.slice(0, 4).map(m => (
                  <div key={m.userId}
                    className={`w-7 h-7 rounded-full border-2 border-black flex items-center justify-center text-[9px] font-bold ${
                      m.role === "owner"
                        ? "bg-amber-500/30 text-amber-200"
                        : "bg-cyan-500/25 text-cyan-200"
                    }`}>
                    {(m.fullName || m.email).slice(0, 2).toUpperCase()}
                  </div>
                ))}
                {members.length > 4 && (
                  <div className="w-7 h-7 rounded-full border-2 border-black bg-zinc-800 text-zinc-300 text-[9px] font-bold flex items-center justify-center">
                    +{members.length - 4}
                  </div>
                )}
              </button>
              <button
                onClick={() => setShareOpen(true)}
                className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg border border-cyan-500/40 bg-cyan-500/10 text-cyan-200 hover:bg-cyan-500/20 transition-colors"
              >
                <Share2 className="w-3.5 h-3.5" />
                {isOwner ? "Condividi" : "Membri"}
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-6 py-10">
        {loading || !project ? (
          <div className="flex items-center justify-center py-20 text-zinc-500">
            <Loader2 className="w-5 h-5 animate-spin mr-2" /> Caricamento progetto…
          </div>
        ) : (
          <>
            {/* Project header */}
            <motion.div
              initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }}
              className="mb-10"
            >
              <p className="text-[10px] text-orange-400/80 font-mono uppercase tracking-widest mb-1">
                Progetto di Esercizio
              </p>
              <h2 className="text-3xl font-black text-zinc-100 mb-2">{project.name}</h2>
              {project.description && (
                <p className="text-sm text-zinc-400 mb-3">{project.description}</p>
              )}
              <div className="flex items-center gap-4 text-xs text-zinc-500 flex-wrap">
                <span className="flex items-center gap-1.5">
                  <Calendar className="w-3 h-3" />
                  Aggiornato {new Date(project.updatedAt).toLocaleString("it-IT", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}
                </span>
                {project.feedLabel && (
                  <span className="flex items-center gap-1.5">
                    <Database className="w-3 h-3" /> Feed: <span className="text-zinc-300">{project.feedLabel}</span>
                  </span>
                )}
                <span className="flex items-center gap-1.5">
                  Stage: <span className="text-orange-300 font-semibold">{STAGE_META[project.currentStage].label}</span>
                  <span className="text-zinc-600">·</span>
                  <span className="text-zinc-400">{stageProgress(project.currentStage)}%</span>
                </span>
                <span className={`px-1.5 py-0.5 rounded font-mono text-[10px] ${
                  project.status === "active" ? "bg-emerald-500/15 text-emerald-400" :
                  project.status === "archived" ? "bg-zinc-700 text-zinc-500" :
                  "bg-orange-500/10 text-orange-400/80"
                }`}>
                  {project.status}
                </span>
              </div>
            </motion.div>

            {/* Stage map (visual) */}
            <div className="mb-8 rounded-xl border border-zinc-800/60 bg-black/30 p-4">
              <div className="flex items-center justify-between mb-3">
                <p className="text-[10px] text-zinc-500 font-mono uppercase tracking-widest">Pipeline progetto</p>
              </div>
              <div className="flex items-center gap-2 overflow-x-auto">
                {(Object.entries(STAGE_META) as Array<[keyof typeof STAGE_META, typeof STAGE_META[keyof typeof STAGE_META]]>).map(([key, meta], i, arr) => {
                  const reached = STAGE_META[project.currentStage].index >= meta.index;
                  const current = project.currentStage === key;
                  return (
                    <div key={key} className="flex items-center gap-2 shrink-0">
                      <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-mono uppercase tracking-wider transition-colors ${
                        current
                          ? "bg-orange-500/20 border border-orange-500/50 text-orange-300"
                          : reached
                            ? "bg-orange-500/8 border border-orange-500/20 text-orange-400/70"
                            : "bg-zinc-900 border border-zinc-800 text-zinc-600"
                      }`}>
                        {meta.label}
                      </div>
                      {i < arr.length - 1 && (
                        <ChevronRight className={`w-3 h-3 ${reached ? "text-orange-500/40" : "text-zinc-700"}`} />
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* 3 azioni principali */}
            <div>
              <p className="text-[10px] text-zinc-500 font-mono uppercase tracking-widest mb-4">Cosa vuoi fare?</p>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <ActionCard
                  icon={Zap}
                  iconColor="text-orange-400"
                  iconBg="bg-orange-500/15 border-orange-500/40"
                  title="Pipeline / Riottimizza"
                  desc="Esegui o ri-esegui la pipeline completa: GTFS → vetture → cluster → fuori linea → CP-SAT."
                  cta="Avvia pipeline"
                  primary
                  onClick={() => navigate(`/fucina/${projectId}/pipeline`)}
                />
                <ActionCard
                  icon={Truck}
                  iconColor="text-amber-400"
                  iconBg="bg-amber-500/15 border-amber-500/40"
                  title="Area di Lavoro — Vetture"
                  desc="Gantt interattivo dei turni macchina: drag & drop, modifiche, esporta. Richiede uno scenario in memoria."
                  cta="Apri workspace vetture"
                  onClick={() => navigate(`/fucina/${projectId}/vehicles`)}
                />
                <ActionCard
                  icon={Users}
                  iconColor="text-purple-400"
                  iconBg="bg-purple-500/15 border-purple-500/40"
                  title="Area di Lavoro — Turni Guida"
                  desc="CSP autisti: saturazione, cap vetture, idle. Richiede uno scenario di vetture salvato."
                  cta="Apri workspace turni guida"
                  onClick={() => navigate(`/fucina/${projectId}/drivers`)}
                />
              </div>
              <p className="text-[10px] text-zinc-600 mt-4 italic">
                Suggerimento: i workspace richiedono uno scenario in memoria. Se non hai mai eseguito la pipeline,
                parti da <span className="text-orange-400">Pipeline / Riottimizza</span>.
              </p>
            </div>

            {/* ─── Scenari salvati (turni macchina / turni guida) ─── */}
            <div className="mt-10 grid grid-cols-1 lg:grid-cols-2 gap-4">
              {/* Turni macchina */}
              <div className="rounded-xl border border-amber-500/15 bg-gradient-to-br from-amber-950/10 to-black p-4">
                <div className="flex items-center justify-between mb-3">
                  <p className="text-[11px] font-semibold text-amber-300 flex items-center gap-1.5"><Truck className="w-3.5 h-3.5" /> Turni macchina · {vehScenarios.length}</p>
                  <button onClick={() => navigate(`/fucina/${projectId}/vehicles`)} className="text-[10px] text-amber-400/80 hover:underline inline-flex items-center gap-1">Gestisci <ArrowRight className="w-3 h-3" /></button>
                </div>
                {vehScenarios.length === 0 ? (
                  <p className="text-[11px] text-zinc-500">Nessuno scenario salvato. Avvia la pipeline per generarne uno.</p>
                ) : (
                  <div className="space-y-1.5">
                    {vehScenarios.map((s) => (
                      <button key={s.id} onClick={() => navigate(`/fucina/${projectId}/vehicles`)}
                        className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg border border-zinc-800 bg-black/30 hover:border-amber-500/40 transition-colors text-left">
                        <Truck className="w-3.5 h-3.5 text-amber-400/70 shrink-0" />
                        <span className="text-xs text-zinc-200 truncate flex-1">{s.name}</span>
                        {s.numVehicles != null && <span className="text-[10px] text-amber-400/80 font-mono shrink-0">{s.numVehicles} vett.</span>}
                        {s.isOperational && <span className="inline-flex items-center gap-0.5 text-[9px] font-bold uppercase px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/40 shrink-0"><Power className="w-2.5 h-2.5" /> esercizio</span>}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {/* Turni guida */}
              <div className="rounded-xl border border-purple-500/15 bg-gradient-to-br from-purple-950/10 to-black p-4">
                <div className="flex items-center justify-between mb-3">
                  <p className="text-[11px] font-semibold text-purple-300 flex items-center gap-1.5"><Users className="w-3.5 h-3.5" /> Turni guida · {drvScenarios.length}</p>
                  <button onClick={() => navigate(`/fucina/${projectId}/drivers`)} className="text-[10px] text-purple-400/80 hover:underline inline-flex items-center gap-1">Gestisci <ArrowRight className="w-3 h-3" /></button>
                </div>
                {drvScenarios.length === 0 ? (
                  <p className="text-[11px] text-zinc-500">Nessuno scenario salvato. Serve prima uno scenario turni macchina.</p>
                ) : (
                  <div className="space-y-1.5">
                    {drvScenarios.map((s) => (
                      <button key={s.id} onClick={() => navigate(`/fucina/${projectId}/drivers`)}
                        className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg border border-zinc-800 bg-black/30 hover:border-purple-500/40 transition-colors text-left">
                        <Users className="w-3.5 h-3.5 text-purple-400/70 shrink-0" />
                        <span className="text-xs text-zinc-200 truncate flex-1">{s.name}</span>
                        <span className="text-[10px] text-zinc-500 truncate shrink-0 max-w-[90px]">← {s.vehicleScenarioName}</span>
                        {s.isOperational && <span className="inline-flex items-center gap-0.5 text-[9px] font-bold uppercase px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/40 shrink-0"><Power className="w-2.5 h-2.5" /> esercizio</span>}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* ─── Collaborazione: Membri + Attività ─── */}
            <div className="mt-10 grid grid-cols-1 lg:grid-cols-2 gap-4">
              {/* Membri */}
              <div className="rounded-xl border border-cyan-500/15 bg-gradient-to-br from-cyan-950/10 to-black p-4">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <Users className="w-4 h-4 text-cyan-400" />
                    <p className="text-[11px] font-semibold uppercase tracking-widest text-cyan-300/80">
                      Collaboratori
                    </p>
                    <span className="text-[10px] text-zinc-500 font-mono">({members.length})</span>
                  </div>
                  {isOwner && (
                    <button onClick={() => setShareOpen(true)}
                      className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-1 rounded border border-cyan-500/30 text-cyan-300 hover:bg-cyan-500/10 transition-colors">
                      <UserPlus className="w-3 h-3" /> Aggiungi
                    </button>
                  )}
                </div>
                {members.length === 0 ? (
                  <p className="text-xs text-zinc-500 italic">Caricamento…</p>
                ) : (
                  <div className="space-y-1.5">
                    {members.map(m => (
                      <div key={m.userId} className="flex items-center justify-between px-2 py-1.5 rounded hover:bg-cyan-500/5">
                        <div className="flex items-center gap-2 min-w-0">
                          <div className={`w-6 h-6 rounded-full flex items-center justify-center text-[9px] font-bold shrink-0 ${
                            m.role === "owner"
                              ? "bg-amber-500/25 text-amber-200"
                              : "bg-cyan-500/20 text-cyan-200"
                          }`}>
                            {(m.fullName || m.email).slice(0, 2).toUpperCase()}
                          </div>
                          <div className="min-w-0">
                            <p className="text-xs text-zinc-200 truncate">{m.fullName || m.email}</p>
                            <p className="text-[9px] text-zinc-500 font-mono truncate">{m.email}</p>
                          </div>
                        </div>
                        <span className={`text-[9px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded shrink-0 ${
                          m.role === "owner" ? "bg-amber-500/15 text-amber-300" : "bg-zinc-700/50 text-zinc-400"
                        }`}>
                          {m.role === "owner" ? <span className="inline-flex items-center gap-0.5"><Shield className="w-2.5 h-2.5" />owner</span> : m.role}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                {otherMembers.length === 0 && (
                  <p className="text-[10px] text-zinc-600 italic mt-2">
                    {isOwner
                      ? "Nessun collaboratore ancora. Clicca Aggiungi per condividere il progetto."
                      : "Solo l'owner ha accesso a questo progetto."}
                  </p>
                )}
              </div>

              {/* Attività recente */}
              <div className="rounded-xl border border-purple-500/15 bg-gradient-to-br from-purple-950/10 to-black p-4">
                <div className="flex items-center gap-2 mb-3">
                  <Activity className="w-4 h-4 text-purple-400" />
                  <p className="text-[11px] font-semibold uppercase tracking-widest text-purple-300/80">
                    Attività recente
                  </p>
                  <span className="text-[10px] text-zinc-500 font-mono">({activity.length})</span>
                </div>
                {activity.length === 0 ? (
                  <p className="text-xs text-zinc-500 italic">Nessuna attività registrata.</p>
                ) : (
                  <div className="max-h-72 overflow-y-auto space-y-1 pr-1">
                    {activity.map(a => (
                      <div key={a.id} className="flex items-start gap-2 px-2 py-1.5 rounded hover:bg-purple-500/5">
                        <div className="w-5 h-5 rounded-full bg-purple-500/20 text-purple-200 flex items-center justify-center text-[9px] font-bold shrink-0 mt-0.5">
                          {(a.userFullName || a.userEmail || "?").slice(0, 2).toUpperCase()}
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="text-[11px] text-zinc-200 leading-tight">
                            <span className="font-semibold text-zinc-100">{a.userFullName || a.userEmail || "Sconosciuto"}</span>
                            {" "}
                            <span className="text-zinc-400">{describeAction(a)}</span>
                          </p>
                          <p className="text-[9px] text-zinc-600 font-mono">
                            {new Date(a.at).toLocaleString("it-IT", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </div>

      {/* Share dialog */}
      {project && (
        <ShareProjectDialog
          projectId={project.id}
          open={shareOpen}
          onClose={() => setShareOpen(false)}
          canManage={isOwner}
          onChange={refreshShared}
        />
      )}
    </div>
  );
}

/** Trasforma l'azione in stringa user-friendly italiana. */
function describeAction(a: ProjectActivity): string {
  switch (a.action) {
    case "project.create":     return "ha creato il progetto";
    case "project.update":     return "ha aggiornato il progetto";
    case "run.create":         return `ha avviato una run (${a.payload?.kind ?? "?"})`;
    case "scenario.attach":    return "ha agganciato uno scenario vetture";
    case "member.add":         return `ha aggiunto un membro (${a.payload?.email ?? "?"})`;
    case "member.remove":      return "ha rimosso un membro";
    default:                   return `→ ${a.action}`;
  }
}
