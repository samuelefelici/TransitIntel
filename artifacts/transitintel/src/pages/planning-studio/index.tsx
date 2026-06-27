/**
 * PlannerStudio — lista progetti.
 *
 * Modulo di pianificazione del servizio: ogni progetto è il DB master
 * (fermate, linee, varianti, percorsi, orari, calendari).
 */
import { useEffect, useMemo, useState } from "react";
import { useLocation, Link } from "wouter";
import { motion } from "framer-motion";
import { toast } from "sonner";
import {
  Map as MapIcon, Plus, Loader2, Calendar, Bus, Route,
  Users, Clock, Trash2, FolderOpen, MapPin, Share2, Power,
} from "lucide-react";
import {
  listPsProjects, createPsProject, deletePsProject, activatePsProject,
  type PsProject,
} from "@/lib/planning-studio-api";
import SharePsProjectDialog from "@/components/planning-studio/SharePsProjectDialog";

export default function PlanningStudioListPage() {
  const [, navigate] = useLocation();
  const [projects, setProjects] = useState<PsProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [agencyName, setAgencyName] = useState("");
  const [creating, setCreating] = useState(false);
  const [shareProject, setShareProject] = useState<PsProject | null>(null);

  async function refresh() {
    setLoading(true);
    try {
      setProjects(await listPsProjects());
    } catch (e: any) {
      toast.error("Errore caricamento progetti", { description: e?.message });
    } finally { setLoading(false); }
  }

  useEffect(() => { refresh(); }, []);

  const ownedCount = useMemo(() => projects.filter(p => p.myRole === "owner").length, [projects]);
  const sharedCount = projects.length - ownedCount;

  async function handleCreate() {
    if (!name.trim()) { toast.error("Nome obbligatorio"); return; }
    setCreating(true);
    try {
      const p = await createPsProject({
        name: name.trim(),
        description: description.trim() || undefined,
        agencyName: agencyName.trim() || undefined,
      });
      toast.success("Progetto creato");
      setCreateOpen(false);
      setName(""); setDescription(""); setAgencyName("");
      navigate(`/planning-studio/${p.id}`);
    } catch (e: any) {
      toast.error("Errore creazione", { description: e?.message });
    } finally { setCreating(false); }
  }

  async function handleDelete(p: PsProject) {
    if (!confirm(`Eliminare il progetto "${p.name}"?\nL'azione è irreversibile.`)) return;
    try {
      await deletePsProject(p.id);
      toast.success("Progetto eliminato");
      refresh();
    } catch (e: any) {
      toast.error("Errore eliminazione", { description: e?.message });
    }
  }

  async function handleActivate(p: PsProject) {
    if (!confirm(
      `Mettere in esercizio "${p.name}"?\n\n` +
      `Diventerà il programma operativo unico: Sala Operativa, AVM, GTFS-RT e ` +
      `tariffe punteranno al suo feed. Gli altri programmi restano modificabili ma non operativi.`,
    )) return;
    try {
      await activatePsProject(p.id);
      toast.success(`"${p.name}" è ora il programma di esercizio operativo`);
      refresh();
    } catch (e: any) {
      toast.error("Messa in esercizio fallita", { description: e?.message });
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-950 via-slate-900 to-slate-950 text-slate-100">
      {/* Header */}
      <div className="border-b border-slate-800/60 bg-slate-950/80 backdrop-blur sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-6 py-5 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-emerald-500 to-cyan-600 flex items-center justify-center shadow-lg shadow-emerald-900/40">
              <MapIcon className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-tight">PlannerStudio</h1>
              <p className="text-xs text-slate-400">Database del servizio · fermate, linee, percorsi, orari</p>
            </div>
          </div>
          <button
            onClick={() => setCreateOpen(true)}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-500/90 hover:bg-emerald-500 text-white font-medium text-sm transition shadow-lg shadow-emerald-900/30"
          >
            <Plus className="w-4 h-4" /> Nuovo progetto
          </button>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-6 py-8">
        {/* Stat strip */}
        <div className="grid grid-cols-3 gap-4 mb-8">
          <StatCard label="Totale progetti" value={projects.length} icon={FolderOpen} accent="emerald" />
          <StatCard label="Di cui tuoi" value={ownedCount} icon={Users} accent="cyan" />
          <StatCard label="Condivisi con te" value={sharedCount} icon={Users} accent="indigo" />
        </div>

        {/* Lista */}
        {loading ? (
          <div className="flex items-center justify-center py-24 text-slate-500">
            <Loader2 className="w-6 h-6 animate-spin mr-2" /> Caricamento…
          </div>
        ) : projects.length === 0 ? (
          <EmptyState onCreate={() => setCreateOpen(true)} />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {projects.map(p => (
              <ProjectCard key={p.id} project={p}
                onOpen={() => navigate(`/planning-studio/${p.id}`)}
                onDelete={() => handleDelete(p)}
                onShare={() => setShareProject(p)}
                onActivate={() => handleActivate(p)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Dialog crea */}
      {createOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setCreateOpen(false)}>
          <motion.div
            initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}
            onClick={e => e.stopPropagation()}
            className="w-full max-w-md mx-4 rounded-2xl bg-slate-900 border border-slate-800 shadow-2xl"
          >
            <div className="px-6 py-4 border-b border-slate-800">
              <h2 className="text-lg font-semibold">Nuovo progetto di pianificazione</h2>
              <p className="text-xs text-slate-500 mt-0.5">Crea un DB master per il servizio di un'agenzia.</p>
            </div>
            <div className="px-6 py-5 space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1.5">Nome *</label>
                <input value={name} onChange={e => setName(e.target.value)} autoFocus
                  placeholder="Es. CTM Cagliari · 2026"
                  className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-sm focus:outline-none focus:border-emerald-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1.5">Agenzia / operatore</label>
                <input value={agencyName} onChange={e => setAgencyName(e.target.value)}
                  placeholder="Es. CTM SpA"
                  className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-sm focus:outline-none focus:border-emerald-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1.5">Descrizione</label>
                <textarea value={description} onChange={e => setDescription(e.target.value)} rows={2}
                  className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-sm focus:outline-none focus:border-emerald-500"
                />
              </div>
            </div>
            <div className="px-6 py-4 border-t border-slate-800 flex justify-end gap-2">
              <button onClick={() => setCreateOpen(false)}
                className="px-4 py-2 rounded-lg text-sm text-slate-400 hover:text-slate-200">Annulla</button>
              <button onClick={handleCreate} disabled={creating}
                className="px-4 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-white text-sm font-medium disabled:opacity-50 flex items-center gap-2"
              >
                {creating && <Loader2 className="w-4 h-4 animate-spin" />} Crea
              </button>
            </div>
          </motion.div>
        </div>
      )}

      {/* Dialog import GTFS */}
      {/* RIMOSSO: l'import GTFS è ora un onboarding step dentro l'editor del progetto */}

      {/* Dialog condividi */}
      {shareProject && (
        <SharePsProjectDialog
          projectId={shareProject.id}
          open
          canManage={shareProject.myRole === "owner"}
          onClose={() => setShareProject(null)}
          onChange={refresh}
        />
      )}
    </div>
  );
}

function StatCard({ label, value, icon: Icon, accent }: { label: string; value: number; icon: any; accent: string }) {
  const accentMap: Record<string, string> = {
    emerald: "from-emerald-500/20 to-emerald-500/5 text-emerald-400 border-emerald-500/20",
    cyan:    "from-cyan-500/20 to-cyan-500/5 text-cyan-400 border-cyan-500/20",
    indigo:  "from-indigo-500/20 to-indigo-500/5 text-indigo-400 border-indigo-500/20",
  };
  return (
    <div className={`rounded-xl border bg-gradient-to-br ${accentMap[accent]} p-4 backdrop-blur`}>
      <div className="flex items-center justify-between mb-2">
        <Icon className="w-4 h-4 opacity-70" />
        <span className="text-2xl font-bold tabular-nums">{value}</span>
      </div>
      <p className="text-[11px] uppercase tracking-wider opacity-80">{label}</p>
    </div>
  );
}

function ProjectCard({
  project: p, onOpen, onDelete, onShare, onActivate,
}: { project: PsProject; onOpen: () => void; onDelete: () => void; onShare: () => void; onActivate: () => void }) {
  const isOwner = p.myRole === "owner";
  const canActivate = (p.myRole === "owner" || p.myRole === "editor") && !p.isOperational;
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
      whileHover={{ y: -2 }}
      className={`group relative rounded-xl bg-slate-900/80 border p-5 cursor-pointer transition shadow-sm hover:shadow-lg ${
        p.isOperational
          ? "border-emerald-500/60 shadow-emerald-900/30 ring-1 ring-emerald-500/30"
          : "border-slate-800 hover:border-emerald-500/50 hover:shadow-emerald-900/20"
      }`}
      onClick={onOpen}
    >
      {p.isOperational && (
        <div className="absolute -top-2.5 left-4 flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-emerald-500 text-white text-[10px] font-bold uppercase tracking-wider shadow-lg shadow-emerald-900/50">
          <span className="relative flex h-1.5 w-1.5">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-white opacity-75" />
            <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-white" />
          </span>
          In esercizio
        </div>
      )}
      <div className="flex items-start justify-between mb-3">
        <div className="flex-1 min-w-0">
          <h3 className="font-semibold text-base text-slate-100 truncate group-hover:text-emerald-300 transition-colors">
            {p.name}
          </h3>
          {p.agencyName && (
            <p className="text-xs text-slate-500 mt-0.5 flex items-center gap-1">
              <Bus className="w-3 h-3" /> {p.agencyName}
            </p>
          )}
        </div>
        <span className={`px-2 py-0.5 rounded text-[10px] font-medium uppercase tracking-wide ${
          isOwner ? "bg-emerald-500/20 text-emerald-300" : "bg-slate-700/60 text-slate-300"
        }`}>
          {isOwner ? "Owner" : p.myRole}
        </span>
      </div>

      {p.description && (
        <p className="text-xs text-slate-400 line-clamp-2 mb-4 min-h-[2rem]">{p.description}</p>
      )}

      {/* Step di mezzo: accessi diretti a Validità (UDP) ed Esercizio */}
      <div className="flex items-center gap-2 mb-3">
        <Link href={`/planning-studio/${p.id}/validity-units`}>
          <button
            onClick={(e) => e.stopPropagation()}
            className="px-2 py-1 rounded-md text-[11px] border border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/10 transition"
            title="Vai alla Validità (Calendario · Matrice · Unità di Progettazione)"
          >
            Validità
          </button>
        </Link>
        <Link href={`/planning-studio/${p.id}/esercizio`}>
          <button
            onClick={(e) => e.stopPropagation()}
            className="px-2 py-1 rounded-md text-[11px] border border-indigo-500/30 text-indigo-300 hover:bg-indigo-500/10 transition"
            title="Quadro d'esercizio: turni macchina e guida in esercizio per UDP"
          >
            Esercizio
          </button>
        </Link>
      </div>

      <div className="flex items-center justify-between text-xs text-slate-500 pt-3 border-t border-slate-800">
        <span className="flex items-center gap-1">
          <Calendar className="w-3 h-3" />
          {new Date(p.updatedAt).toLocaleDateString("it-IT", { day: "2-digit", month: "short", year: "numeric" })}
        </span>
        {isOwner && (
          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition">
            {canActivate && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  if (!p.materializedFeedId) {
                    toast.info("Prima materializza il programma", {
                      description: "Apri il progetto ed esegui la sincronizzazione PS → feed GTFS, poi mettilo in esercizio.",
                    });
                    return;
                  }
                  onActivate();
                }}
                className="p-1 rounded hover:bg-emerald-500/10 text-slate-500 hover:text-emerald-400 transition"
                title={p.materializedFeedId ? "Metti in esercizio (diventa il programma operativo)" : "Da materializzare prima della messa in esercizio"}
              >
                <Power className="w-3.5 h-3.5" />
              </button>
            )}
            <button
              onClick={(e) => { e.stopPropagation(); onShare(); }}
              className="p-1 rounded hover:bg-cyan-500/10 text-slate-500 hover:text-cyan-400 transition"
              title="Condividi"
            >
              <Share2 className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); onDelete(); }}
              className="p-1 rounded hover:bg-red-500/10 text-slate-500 hover:text-red-400 transition"
              title="Elimina"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
        {!isOwner && (
          <button
            onClick={(e) => { e.stopPropagation(); onShare(); }}
            className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-cyan-500/10 text-slate-500 hover:text-cyan-400 transition"
            title="Vedi membri"
          >
            <Share2 className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
    </motion.div>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="text-center py-20">
      <div className="w-16 h-16 mx-auto rounded-2xl bg-emerald-500/10 flex items-center justify-center mb-4">
        <MapPin className="w-7 h-7 text-emerald-400" />
      </div>
      <h2 className="text-lg font-semibold mb-1">Nessun progetto ancora</h2>
      <p className="text-sm text-slate-500 mb-6">Crea il primo DB del servizio per la tua agenzia.</p>
      <button onClick={onCreate}
        className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-white text-sm font-medium"
      >
        <Plus className="w-4 h-4" /> Nuovo progetto
      </button>
    </div>
  );
}
