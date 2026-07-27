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
  ArrowLeft, Flame, Truck, Users, Zap, ChevronRight,
  Loader2, Calendar, Database, ArrowRight, Share2, Activity, Shield, UserPlus,
  Check, Lock,
} from "lucide-react";
import {
  getProject, STAGE_META, stageProgress,
  listProjectMembers, listProjectActivity,
  listProjectVehicleScenarios, listProjectDriverScenarios,
  syncProjectFromPs,
  type SchedulingProject, type ProjectMember, type ProjectActivity,
  type ProjectVehicleScenario, type ProjectDriverScenario,
} from "@/lib/scheduling-projects-api";
import { RefreshCw, AlertTriangle } from "lucide-react";
import { Power } from "lucide-react";
import ShareProjectDialog from "@/components/scheduling/ShareProjectDialog";
import { useAuth } from "@/hooks/use-auth";

type StepState = "done" | "current" | "locked";

interface GuidedStepProps {
  n: number;
  state: StepState;
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  desc: string;
  cta: string;
  onClick: () => void;
  lockedHint?: string;
  /** azione secondaria (es. "Rivedi") mostrata quando il passo è già fatto */
  secondary?: { label: string; onClick: () => void };
}

/** Passo di un percorso guidato verticale: numero, stato, descrizione, CTA. */
function GuidedStep({ n, state, icon: Icon, title, desc, cta, onClick, lockedHint, secondary }: GuidedStepProps) {
  const badge =
    state === "done"
      ? { ring: "border-emerald-500/60 bg-emerald-500/15 text-emerald-300", content: <Check className="w-4 h-4" /> }
      : state === "current"
        ? { ring: "border-orange-500/70 bg-orange-500/20 text-orange-300", content: <span className="text-sm font-black">{n}</span> }
        : { ring: "border-zinc-700 bg-zinc-900 text-zinc-600", content: <Lock className="w-3.5 h-3.5" /> };
  const chip =
    state === "done"
      ? <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/40">Fatto</span>
      : state === "current"
        ? <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-orange-500/20 text-orange-300 border border-orange-500/50 animate-pulse">Fai questo ora</span>
        : <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-zinc-800 text-zinc-500 border border-zinc-700">Bloccato</span>;

  return (
    <div className={`relative flex gap-4 rounded-2xl border p-5 transition-all ${
      state === "current"
        ? "border-orange-500/50 bg-gradient-to-br from-orange-950/30 via-zinc-950 to-black shadow-[0_0_30px_rgba(251,146,60,0.12)]"
        : state === "done"
          ? "border-zinc-800 bg-gradient-to-br from-zinc-950 to-black"
          : "border-zinc-800/60 bg-zinc-950/40 opacity-70"
    }`}>
      {/* numero/stato */}
      <div className={`shrink-0 w-9 h-9 rounded-full border flex items-center justify-center ${badge.ring}`}>
        {badge.content}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 mb-1">
          <Icon className={`w-4 h-4 ${state === "current" ? "text-orange-400" : state === "done" ? "text-emerald-400/80" : "text-zinc-600"}`} />
          <h3 className={`text-sm font-bold ${state === "locked" ? "text-zinc-500" : "text-zinc-100"}`}>{title}</h3>
          {chip}
        </div>
        <p className="text-xs text-zinc-400 leading-relaxed mb-3">{desc}</p>
        <div className="flex items-center gap-3 flex-wrap">
          {state === "locked" ? (
            <span className="inline-flex items-center gap-1.5 text-[11px] text-zinc-600">
              <Lock className="w-3 h-3" /> {lockedHint}
            </span>
          ) : (
            <button
              onClick={onClick}
              className={`inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors ${
                state === "current"
                  ? "bg-orange-500 text-black hover:bg-orange-400"
                  : "border border-zinc-700 text-zinc-300 hover:border-orange-500/50 hover:text-orange-300"
              }`}
            >
              {cta}
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          )}
          {secondary && state === "done" && (
            <button onClick={secondary.onClick} className="text-[11px] text-zinc-500 hover:text-orange-300 inline-flex items-center gap-1">
              {secondary.label} <ArrowRight className="w-3 h-3" />
            </button>
          )}
        </div>
      </div>
    </div>
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
  const [resyncing, setResyncing] = useState(false);

  // Ri-sincronizza il feed col Planning Studio: il badge "dati superati" sparisce
  // quando la materializzazione torna più recente delle modifiche PS.
  const handleResync = React.useCallback(async () => {
    if (!projectId) return;
    setResyncing(true);
    try {
      await syncProjectFromPs(projectId);
      const p = await getProject(projectId);
      setProject(p);
      toast.success("Feed risincronizzato col Planning Studio", {
        description: "I turni ora usano gli orari e i calendari aggiornati.",
      });
    } catch (e: any) {
      toast.error("Risincronizzazione fallita", { description: e?.message });
    } finally {
      setResyncing(false);
    }
  }, [projectId]);

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

            {/* Avviso STALENESS: il Planning Studio è cambiato dopo l'ultima
                materializzazione → i turni girerebbero su dati vecchi. */}
            {project.feedStale && (
              <motion.div
                initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }}
                className="mb-6 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 flex items-start gap-3"
              >
                <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-bold text-amber-200">Dati superati: il Planning Studio è cambiato dopo l'ultima sincronizzazione</p>
                  <p className="text-xs text-amber-300/80 mt-0.5">
                    Corse, orari o calendari sono stati modificati
                    {project.psLastChangeAt ? ` il ${new Date(project.psLastChangeAt).toLocaleString("it-IT", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}` : ""}
                    {project.feedSyncedAt ? `, dopo la materializzazione del feed (${new Date(project.feedSyncedAt).toLocaleString("it-IT", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })})` : ""}.
                    Ottimizzare ora userebbe gli orari vecchi: risincronizza prima di generare o mettere in esercizio i turni.
                  </p>
                </div>
                <button
                  onClick={handleResync}
                  disabled={resyncing}
                  className="shrink-0 inline-flex items-center gap-1.5 text-[11px] font-semibold px-3 py-1.5 rounded-lg border border-amber-500/50 bg-amber-500/15 text-amber-100 hover:bg-amber-500/25 disabled:opacity-60"
                >
                  {resyncing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                  {resyncing ? "Risincronizzo…" : "Sincronizza con Planning Studio"}
                </button>
              </motion.div>
            )}

            {/* Avviso UDP STANTIA (verifica hash-based): l'insieme di corse
                dell'unità non corrisponde più al progetto — coglie anche le
                modifiche invisibili al confronto per data (orari, matrice
                validità, eccezioni, calendario categorie). */}
            {project.udpStale && (
              <motion.div
                initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }}
                className="mb-6 rounded-xl border border-orange-500/40 bg-orange-500/10 p-4 flex items-start gap-3"
              >
                <AlertTriangle className="w-5 h-5 text-orange-400 shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-bold text-orange-200">UDP superata: le corse del periodo non corrispondono più al Planning Studio</p>
                  <p className="text-xs text-orange-300/80 mt-0.5">
                    L'unità di pianificazione «{project.validityUnitName ?? "—"}» è stata calcolata su un insieme di corse che nel frattempo è cambiato
                    (corse aggiunte/rimosse, orari, validità o calendario aziendale). Ricalcola le unità in Planning Studio → Validità
                    e ricrea il progetto di scheduling sull'unità aggiornata prima di generare nuovi turni.
                  </p>
                </div>
              </motion.div>
            )}

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

            {/* Percorso guidato — l'ordine giusto dei passi */}
            {(() => {
              const hasVehicles = vehScenarios.length > 0;
              const hasDrivers = drvScenarios.length > 0;
              const opVehicle = vehScenarios.some((s) => s.isOperational);
              const opDriver = drvScenarios.some((s) => s.isOperational);
              const fullyOperational = opVehicle && opDriver;
              // stato dei 3 passi in cascata
              const s1: StepState = hasVehicles ? "done" : "current";
              const s2: StepState = !hasVehicles ? "locked" : hasDrivers ? "done" : "current";
              const s3: StepState = !hasDrivers ? "locked" : fullyOperational ? "done" : "current";
              return (
                <div>
                  <div className="flex items-center gap-2 mb-4">
                    <p className="text-[10px] text-zinc-500 font-mono uppercase tracking-widest">Come procedere · scegli la pipeline</p>
                    {fullyOperational && (
                      <span className="text-[9px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/40 inline-flex items-center gap-1">
                        <Power className="w-2.5 h-2.5" /> Scenario in esercizio
                      </span>
                    )}
                  </div>

                  {/* ══ SEZIONE 1 — PIPELINE CLASSICA · VSP → CSP ══ */}
                  <div className="rounded-2xl border border-amber-500/20 bg-gradient-to-br from-amber-950/10 to-black p-4 mb-4">
                    <div className="flex items-center gap-2 mb-3 flex-wrap">
                      <span className="text-lg">🚌</span>
                      <p className="text-xs font-bold text-amber-300 uppercase tracking-wider">Pipeline classica · VSP → CSP</p>
                      <span className="text-[10px] text-zinc-500">prima i mezzi, poi gli autisti — il procedimento di sempre</span>
                    </div>
                    <div className="space-y-3">
                      <GuidedStep
                        n={1} state={s1} icon={Zap}
                        title="Genera i turni macchina (VSP)"
                        desc="Avvia la pipeline: dalle corse dell'UDP il sistema costruisce i turni delle vetture (vetture → depositi → fuori linea → ottimizzazione CP-SAT)."
                        cta={hasVehicles ? "Riottimizza" : "Avvia pipeline"}
                        onClick={() => navigate(`/fucina/${projectId}/pipeline`)}
                        secondary={hasVehicles ? { label: "Rivedi turni macchina", onClick: () => navigate(`/fucina/${projectId}/vehicles`) } : undefined}
                      />
                      <GuidedStep
                        n={2} state={s2} icon={Truck}
                        title="Genera i turni guida (CSP)"
                        desc="Dai turni macchina il sistema costruisce i turni degli autisti (saturazione, cambi vettura, tempi morti). Serve almeno uno scenario di vetture."
                        cta={hasDrivers ? "Rigenera turni guida" : "Genera turni guida"}
                        onClick={() => navigate(`/fucina/${projectId}/drivers`)}
                        lockedHint="Prima genera i turni macchina (passo 1)."
                        secondary={hasDrivers ? { label: "Rivedi turni guida", onClick: () => navigate(`/fucina/${projectId}/drivers`) } : undefined}
                      />
                    </div>
                  </div>

                  {/* ══ SEZIONE 2 — PIPELINE INTEGRATA · VCSP (TM+TG insieme) ══ */}
                  <div className="rounded-2xl border border-cyan-500/25 bg-gradient-to-br from-cyan-950/15 to-black p-4 mb-4 relative">
                    <span className="absolute top-3 right-3 text-[9px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-cyan-500/15 text-cyan-300 border border-cyan-500/40">Nuovo</span>
                    <div className="flex items-center gap-2 mb-3 flex-wrap">
                      <span className="text-lg">🔗</span>
                      <p className="text-xs font-bold text-cyan-300 uppercase tracking-wider">Pipeline integrata · VCSP</p>
                      <span className="text-[10px] text-zinc-500">mezzi e autisti ottimizzati INSIEME, in un colpo solo</span>
                    </div>
                    <GuidedStep
                      n={1} state={"current" as StepState} icon={Zap}
                      title="Avvia la pipeline integrata (turni macchina + turni guida)"
                      desc="Stessa preparazione (vetture → depositi → fuori linea), ma l'ottimizzatore VCSP genera turni macchina e turni guida in round con feedback: i turni guida «correggono» i turni macchina fino al costo totale minimo. Al salvataggio crea ENTRAMBI gli scenari, che ritrovi nelle stesse aree di lavoro di sempre."
                      cta="Avvia pipeline integrata"
                      onClick={() => navigate(`/fucina/${projectId}/pipeline?mode=vcsp`)}
                    />
                    <p className="text-[10px] text-zinc-500 mt-2 pl-1">
                      ⏱️ Più lenta della classica (esegue anche i turni guida a ogni round) · consigliata quando conta il costo totale mezzi + personale.
                    </p>
                  </div>

                  {/* ══ Messa in esercizio (comune a entrambe le pipeline) ══ */}
                  <GuidedStep
                    n={3} state={s3} icon={Power}
                    title="Metti in esercizio"
                    desc="Scegli lo scenario vetture e quello turni guida definitivi e segnali «in esercizio»: diventano la soluzione ufficiale del progetto, usata da confronti, stampe e Sala Operativa."
                    cta={fullyOperational ? "Gestisci esercizio" : "Vai agli scenari"}
                    onClick={() => navigate(`/fucina/${projectId}/vehicles`)}
                    lockedHint="Prima genera i turni guida (con la pipeline classica o quella integrata)."
                  />
                </div>
              );
            })()}

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
