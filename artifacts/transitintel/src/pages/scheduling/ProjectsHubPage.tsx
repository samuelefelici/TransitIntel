/**
 * Scheduling Projects Hub — nuova landing di /fucina (S1).
 *
 * Flusso:
 *   1. Splash "SCHEDULING ENGINE" (riadattato dallo splash di fucina.tsx)
 *   2. "Entra nel Motore" → lista progetti dell'utente
 *   3. Click su progetto → navigate("/fucina/:id") apre il workspace esistente
 *   4. "Nuovo progetto" → dialog → POST /api/scheduling/projects → entra
 *
 * IMPORTANTE: nessuna modifica al codice del workspace (fucina.tsx + steps/*).
 * Quel componente continua a funzionare quando montato a /fucina/:projectId.
 */
import { useEffect, useState, useMemo } from "react";
import { useLocation } from "wouter";
import { motion, AnimatePresence } from "framer-motion";
import {
  Flame, ChevronRight, Plus, FolderOpen, Trash2, ArrowRight,
  Loader2, Calendar, Layers, Zap, Database, Bus, Building2, Route, Truck, Users, ArrowLeft, X,
} from "lucide-react";
import { toast } from "sonner";
import {
  listProjects, createProject, deleteProject,
  STAGE_META, stageProgress,
  type SchedulingProject, type ProjectStage,
} from "@/lib/scheduling-projects-api";
import { listPsProjects, type PsProject } from "@/lib/planning-studio-api";

const STAGE_ICONS: Record<ProjectStage, React.ComponentType<{ className?: string }>> = {
  setup: Database,
  service: Bus,
  vehicle: Truck,
  crew: Users,
  workspace: Layers,
  publish: Route,
};

/* ───────────────────────── Splash ───────────────────────── */
function SplashScreen({ onEnter, onBack }: { onEnter: () => void; onBack: () => void }) {
  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      transition={{ duration: 0.5 }}
      className="fixed inset-0 z-50 flex flex-col items-center justify-center overflow-hidden"
      style={{ background: "radial-gradient(ellipse at 50% 60%, #1a0a00 0%, #0a0500 60%, #000000 100%)" }}
    >
      {[...Array(20)].map((_, i) => (
        <motion.div key={i}
          className="absolute rounded-full pointer-events-none"
          style={{
            width: Math.random() * 4 + 2, height: Math.random() * 4 + 2,
            left: `${Math.random() * 100}%`, top: `${Math.random() * 100}%`,
            background: `hsl(${20 + Math.random() * 30}, 100%, ${50 + Math.random() * 30}%)`,
          }}
          animate={{ y: [0, -(80 + Math.random() * 120)], opacity: [0, 0.8, 0], scale: [0, 1, 0] }}
          transition={{ duration: 2 + Math.random() * 3, repeat: Infinity, delay: Math.random() * 4, ease: "easeOut" }}
        />
      ))}

      <button onClick={onBack}
        className="absolute top-5 left-5 flex items-center gap-1.5 text-xs text-orange-300/60 hover:text-orange-300 transition-colors"
      >
        <ArrowLeft className="w-3.5 h-3.5" /> <span>Torna all'app</span>
      </button>

      <motion.div initial={{ scale: 0.7, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
        transition={{ duration: 0.7, delay: 0.2, ease: [0.16, 1, 0.3, 1] }} className="relative mb-6"
      >
        <div className="absolute inset-0 blur-3xl bg-orange-500/20 rounded-full scale-150 pointer-events-none" />
        <img src="/schedulingengine.png" alt="Scheduling Engine"
          className="relative h-52 w-auto drop-shadow-[0_0_40px_rgba(251,146,60,0.5)]" />
      </motion.div>

      <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, delay: 0.4 }} className="text-center px-6"
      >
        <h1 className="text-4xl font-black tracking-tight mb-1 bg-gradient-to-r from-orange-300 via-amber-400 to-orange-500 bg-clip-text text-transparent">
          SCHEDULING ENGINE
        </h1>
        <p className="text-sm text-orange-300/70 font-mono mb-2 tracking-widest uppercase">
          Progetti di Esercizio · CP-SAT
        </p>
        <p className="text-sm text-orange-200/50 max-w-md mx-auto leading-relaxed mt-3 mb-8">
          Ogni esercizio è un progetto: dal feed GTFS al servizio pubblicato, con run versionate e genealogia delle scelte.
        </p>

        <motion.button onClick={onEnter} whileHover={{ scale: 1.04 }} whileTap={{ scale: 0.97 }}
          className="inline-flex items-center gap-2.5 px-8 py-3.5 rounded-xl font-bold text-sm text-black bg-gradient-to-r from-orange-400 to-amber-400 shadow-[0_0_30px_rgba(251,146,60,0.4)] hover:shadow-[0_0_45px_rgba(251,146,60,0.6)] transition-shadow"
        >
          <Flame className="w-4 h-4" /> Apri Progetti <ChevronRight className="w-4 h-4" />
        </motion.button>
      </motion.div>
    </motion.div>
  );
}

/* ───────────────────── Card singolo progetto ───────────────────── */
function ProjectCard({
  project, onOpen, onDelete,
}: {
  project: SchedulingProject;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const StageIcon = STAGE_ICONS[project.currentStage] ?? Database;
  const progress = stageProgress(project.currentStage);
  const stageLabel = STAGE_META[project.currentStage].label;
  const lastTouch = project.lastOpenedAt || project.updatedAt;

  return (
    <motion.div
      whileHover={{ y: -2 }}
      className="relative group rounded-xl border border-orange-500/20 bg-gradient-to-br from-zinc-900/80 to-black/80 p-4 hover:border-orange-500/50 transition-colors"
    >
      <button
        onClick={(e) => { e.stopPropagation(); if (confirm(`Eliminare il progetto "${project.name}"? L'azione non è reversibile.`)) onDelete(); }}
        className="absolute top-2 right-2 p-1.5 rounded-md text-zinc-600 hover:text-red-400 hover:bg-red-500/10 opacity-0 group-hover:opacity-100 transition-all"
        title="Elimina progetto"
      >
        <Trash2 className="w-3.5 h-3.5" />
      </button>

      <button onClick={onOpen} className="w-full text-left">
        <div className="flex items-start gap-3 mb-3">
          <div className="w-10 h-10 rounded-lg bg-orange-500/15 border border-orange-500/30 flex items-center justify-center shrink-0">
            <StageIcon className="w-5 h-5 text-orange-400" />
          </div>
          <div className="flex-1 min-w-0 pr-6">
            <h3 className="font-semibold text-zinc-100 text-sm truncate">{project.name}</h3>
            {project.planningStudioProjectName && (
              <p className="text-[10px] text-violet-300/80 font-mono uppercase tracking-wider mt-0.5 truncate">
                ◇ {project.planningStudioProjectName}
              </p>
            )}
            {project.description && (
              <p className="text-xs text-zinc-500 truncate mt-0.5">{project.description}</p>
            )}
          </div>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between text-[10px]">
            <span className="text-orange-400/80 font-mono uppercase tracking-wider">{stageLabel}</span>
            <span className="text-zinc-500">{progress}%</span>
          </div>
          <div className="h-1 rounded-full bg-zinc-800 overflow-hidden">
            <div className="h-full bg-gradient-to-r from-orange-500 to-amber-400" style={{ width: `${progress}%` }} />
          </div>

          <div className="flex items-center gap-3 text-[10px] text-zinc-500 pt-1">
            <span className="flex items-center gap-1">
              <Calendar className="w-3 h-3" />
              {new Date(lastTouch).toLocaleDateString("it-IT", { day: "2-digit", month: "short", year: "2-digit" })}
            </span>
            {project.feedLabel && (
              <span className="flex items-center gap-1 truncate">
                <Database className="w-3 h-3" /> {project.feedLabel}
              </span>
            )}
            <span className={`ml-auto px-1.5 py-0.5 rounded font-mono ${
              project.status === "active" ? "bg-emerald-500/15 text-emerald-400" :
              project.status === "archived" ? "bg-zinc-700 text-zinc-500" :
              "bg-orange-500/10 text-orange-400/80"
            }`}>
              {project.status}
            </span>
          </div>
        </div>
      </button>
    </motion.div>
  );
}

/* ───────────────────── Dialog "Nuovo progetto" ───────────────────── */
function NewProjectDialog({
  open, onClose, onCreated, defaultPsProjectId,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (p: SchedulingProject) => void;
  defaultPsProjectId?: string;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [psList, setPsList] = useState<PsProject[] | null>(null);
  const [psId, setPsId] = useState<string>("");

  useEffect(() => {
    if (open) {
      const today = new Date().toLocaleDateString("it-IT", { month: "long", year: "numeric" });
      setName(`Esercizio ${today.charAt(0).toUpperCase() + today.slice(1)}`);
      setDescription("");
      setPsId(defaultPsProjectId || "");
      // Carica PsProjects accessibili
      listPsProjects()
        .then(list => {
          setPsList(list);
          if (!defaultPsProjectId && list.length === 1) setPsId(list[0].id);
        })
        .catch((e: any) => toast.error(e?.message || "Errore caricamento PlannerStudio"));
    }
  }, [open, defaultPsProjectId]);

  if (!open) return null;

  async function handleSubmit() {
    if (!name.trim()) { toast.error("Il nome è obbligatorio"); return; }
    if (!psId) { toast.error("Seleziona un progetto PlannerStudio"); return; }
    setSubmitting(true);
    try {
      const p = await createProject({
        name: name.trim(),
        description: description.trim() || undefined,
        planningStudioProjectId: psId,
      });
      toast.success(`Progetto "${p.name}" creato`);
      onCreated(p);
    } catch (e: any) {
      toast.error(e?.message || "Errore creazione progetto");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-md mx-4 rounded-xl border border-orange-500/30 bg-gradient-to-br from-zinc-950 to-black p-6 shadow-2xl">
        <div className="flex items-center gap-2 mb-4">
          <div className="w-8 h-8 rounded-lg bg-orange-500/15 border border-orange-500/30 flex items-center justify-center">
            <Plus className="w-4 h-4 text-orange-400" />
          </div>
          <h2 className="text-lg font-bold text-zinc-100">Nuovo Progetto di Esercizio</h2>
        </div>

        <div className="space-y-3">
          <div>
            <label className="block text-xs text-zinc-400 mb-1.5 font-mono uppercase tracking-wider">
              PlannerStudio di origine <span className="text-orange-400">*</span>
            </label>
            {psList === null ? (
              <div className="px-3 py-2 rounded-lg bg-black/50 border border-zinc-800 text-xs text-zinc-500">
                <Loader2 className="inline w-3 h-3 animate-spin mr-1.5" /> Caricamento progetti…
              </div>
            ) : psList.length === 0 ? (
              <div className="px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/30 text-xs text-red-300">
                Non hai progetti PlannerStudio. Creane uno prima da{" "}
                <a href="/planning-studio" className="underline">PlannerStudio</a>.
              </div>
            ) : (
              <select
                value={psId} onChange={(e) => setPsId(e.target.value)}
                disabled={!!defaultPsProjectId}
                className="w-full px-3 py-2 rounded-lg bg-black/50 border border-zinc-800 focus:border-orange-500/50 text-sm text-zinc-100 outline-none transition-colors disabled:opacity-60"
              >
                <option value="">— Seleziona —</option>
                {psList.map(p => (
                  <option key={p.id} value={p.id}>
                    {p.name}{p.myRole && p.myRole !== "owner" ? ` (condiviso · ${p.myRole})` : ""}
                  </option>
                ))}
              </select>
            )}
          </div>
          <div>
            <label className="block text-xs text-zinc-400 mb-1.5 font-mono uppercase tracking-wider">Nome</label>
            <input
              autoFocus value={name} onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-black/50 border border-zinc-800 focus:border-orange-500/50 text-sm text-zinc-100 outline-none transition-colors"
              placeholder="Es. Esercizio Aprile 2026"
            />
          </div>
          <div>
            <label className="block text-xs text-zinc-400 mb-1.5 font-mono uppercase tracking-wider">Descrizione (opzionale)</label>
            <textarea
              value={description} onChange={(e) => setDescription(e.target.value)} rows={3}
              className="w-full px-3 py-2 rounded-lg bg-black/50 border border-zinc-800 focus:border-orange-500/50 text-sm text-zinc-100 outline-none transition-colors resize-none"
              placeholder="Note di scopo, perimetro, vincoli..."
            />
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 mt-6">
          <button onClick={onClose} disabled={submitting}
            className="px-3 py-1.5 rounded-lg text-xs text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50 transition-colors"
          >
            Annulla
          </button>
          <button onClick={handleSubmit} disabled={submitting || !name.trim() || !psId}
            className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-bold text-black bg-gradient-to-r from-orange-400 to-amber-400 hover:shadow-[0_0_20px_rgba(251,146,60,0.4)] disabled:opacity-50 transition-all"
          >
            {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Flame className="w-3.5 h-3.5" />}
            Crea ed entra
          </button>
        </div>
      </div>
    </div>
  );
}

/* ───────────────────── Hub principale ───────────────────── */
const SPLASH_SEEN_KEY = "fucina_splash_seen";

export default function ProjectsHubPage() {
  const [, navigate] = useLocation();
  // Lo splash "Entra nel Motore" si mostra SOLO la prima volta (poi è solo
  // rumore). Saltato anche quando si arriva da un contesto esplicito (?ps/?new).
  const [showSplash, setShowSplash] = useState(() => {
    if (typeof window === "undefined") return false;
    const u = new URLSearchParams(window.location.search);
    if (u.get("ps") || u.get("new") === "1") return false;
    try { return localStorage.getItem(SPLASH_SEEN_KEY) !== "1"; } catch { return true; }
  });
  const [projects, setProjects] = useState<SchedulingProject[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [showNewDialog, setShowNewDialog] = useState(false);

  // Querystring ?ps=<psProjectId> → filtra elenco e pre-seleziona nel dialog
  const psFilter = useMemo(() => {
    if (typeof window === "undefined") return undefined;
    const u = new URLSearchParams(window.location.search);
    return u.get("ps") || undefined;
  }, []);
  const autoOpenNew = useMemo(() => {
    if (typeof window === "undefined") return false;
    return new URLSearchParams(window.location.search).get("new") === "1";
  }, []);

  async function reload() {
    setLoading(true);
    try {
      const list = await listProjects(psFilter ? { planningStudioProjectId: psFilter } : {});
      setProjects(list);
    } catch (e: any) {
      toast.error(e?.message || "Errore caricamento progetti");
      setProjects([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void reload(); }, [psFilter]);
  useEffect(() => {
    if (autoOpenNew && psFilter) {
      setShowSplash(false);
      setShowNewDialog(true);
    }
  }, [autoOpenNew, psFilter]);

  // Se ho esattamente 1 progetto attivo, è il "progetto attuale" (CTA primaria)
  const currentProject = useMemo(() => {
    if (!projects || projects.length === 0) return null;
    // Più recentemente toccato (ordering già fatto dal backend)
    return projects[0];
  }, [projects]);

  function openProject(p: SchedulingProject) {
    navigate(`/fucina/${p.id}`);
  }

  async function handleDelete(id: string) {
    try {
      await deleteProject(id);
      toast.success("Progetto eliminato");
      await reload();
    } catch (e: any) {
      toast.error(e?.message || "Errore eliminazione");
    }
  }

  return (
    <>
      <AnimatePresence>
        {showSplash && (
          <SplashScreen
            onEnter={() => { try { localStorage.setItem(SPLASH_SEEN_KEY, "1"); } catch { /* ignore */ } setShowSplash(false); }}
            onBack={() => navigate("/")}
          />
        )}
      </AnimatePresence>

      {!showSplash && (
        <div className="min-h-screen w-full" style={{ background: "radial-gradient(ellipse at 30% 0%, #1a0a00 0%, #050200 70%, #000 100%)" }}>
          {/* Header */}
          <div className="border-b border-orange-500/15 bg-black/40 backdrop-blur-sm sticky top-0 z-10">
            <div className="max-w-7xl mx-auto px-6 py-3 flex items-center gap-4">
              <button onClick={() => navigate("/")}
                className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-orange-300 transition-colors"
              >
                <ArrowLeft className="w-3.5 h-3.5" /> Torna all'app
              </button>
              <div className="h-4 w-px bg-zinc-800" />
              <div className="flex items-center gap-2">
                <Flame className="w-4 h-4 text-orange-400" />
                <h1 className="text-sm font-bold text-zinc-100">Scheduling Engine</h1>
                <span className="text-xs text-zinc-500 font-mono">/ Progetti</span>
              </div>
              {psFilter && (
                <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-violet-500/15 border border-violet-500/30 text-[11px] text-violet-200">
                  <span className="font-mono uppercase tracking-wider opacity-70">PS:</span>
                  <span className="truncate max-w-[260px]">
                    {projects?.[0]?.planningStudioProjectName || psFilter.slice(0, 8)}
                  </span>
                  <button onClick={() => navigate("/fucina")} title="Rimuovi filtro" className="ml-1 text-violet-300 hover:text-white">
                    <X className="w-3 h-3" />
                  </button>
                </div>
              )}
              <button onClick={() => setShowNewDialog(true)}
                className="ml-auto inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-black bg-gradient-to-r from-orange-400 to-amber-400 hover:shadow-[0_0_20px_rgba(251,146,60,0.4)] transition-shadow"
              >
                <Plus className="w-3.5 h-3.5" /> Nuovo progetto
              </button>
            </div>
          </div>

          <div className="max-w-7xl mx-auto px-6 py-8">
            {/* Continua progetto attuale (CTA in alto se hai progetti) */}
            {currentProject && (
              <motion.div
                initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }}
                className="mb-8 rounded-xl border border-orange-500/40 bg-gradient-to-br from-orange-950/40 via-zinc-950 to-black p-5 hover:border-orange-500/70 transition-colors cursor-pointer group"
                onClick={() => openProject(currentProject)}
              >
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 rounded-xl bg-orange-500/20 border border-orange-500/40 flex items-center justify-center shrink-0">
                    <Zap className="w-6 h-6 text-orange-400" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-[10px] text-orange-400/80 font-mono uppercase tracking-widest mb-0.5">
                      Continua il tuo lavoro
                    </p>
                    <h2 className="text-lg font-bold text-zinc-100 truncate">{currentProject.name}</h2>
                    <p className="text-xs text-zinc-400 mt-0.5">
                      Stage corrente: <span className="text-orange-300">{STAGE_META[currentProject.currentStage].label}</span>
                      {" · "}
                      {stageProgress(currentProject.currentStage)}% completato
                    </p>
                  </div>
                  <ArrowRight className="w-5 h-5 text-orange-400 group-hover:translate-x-1 transition-transform" />
                </div>
              </motion.div>
            )}

            {/* Lista progetti */}
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-xs text-zinc-400 font-mono uppercase tracking-widest">
                {projects && projects.length > 0
                  ? `${projects.length} progett${projects.length === 1 ? "o" : "i"}`
                  : "Nessun progetto"}
              </h3>
            </div>

            {loading ? (
              <div className="flex items-center justify-center py-20 text-zinc-500">
                <Loader2 className="w-5 h-5 animate-spin mr-2" /> Caricamento…
              </div>
            ) : projects && projects.length > 0 ? (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                {projects.map((p) => (
                  <ProjectCard
                    key={p.id} project={p}
                    onOpen={() => openProject(p)}
                    onDelete={() => handleDelete(p.id)}
                  />
                ))}
              </div>
            ) : (
              <div className="rounded-xl border border-dashed border-orange-500/30 bg-orange-500/5 p-10 text-center">
                <FolderOpen className="w-10 h-10 text-orange-400/50 mx-auto mb-3" />
                <p className="text-sm text-zinc-300 font-semibold mb-1">Nessun progetto di esercizio</p>
                <p className="text-xs text-zinc-500 mb-4">Inizia creando il tuo primo progetto. Conterrà feed GTFS, cluster, depositi, run e turni.</p>
                <button onClick={() => setShowNewDialog(true)}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-bold text-black bg-gradient-to-r from-orange-400 to-amber-400 hover:shadow-[0_0_20px_rgba(251,146,60,0.4)] transition-shadow"
                >
                  <Plus className="w-3.5 h-3.5" /> Crea il tuo primo progetto
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      <NewProjectDialog
        open={showNewDialog}
        onClose={() => setShowNewDialog(false)}
        defaultPsProjectId={psFilter}
        onCreated={(p) => {
          setShowNewDialog(false);
          openProject(p);
        }}
      />
    </>
  );
}
