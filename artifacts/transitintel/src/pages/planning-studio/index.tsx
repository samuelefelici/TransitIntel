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
  Users, Clock, Trash2, FolderOpen, MapPin, Share2, Power, Copy, Download, Search, X,
} from "lucide-react";
import { getApiBase } from "@/lib/api";
import {
  listPsProjects, createPsProject, deletePsProject, activatePsProject, duplicatePsProject,
  getPsProjectHealth, type PsProjectHealth, type PsProject,
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

  // ── Ricerca + ordinamento lista ──
  const [query, setQuery] = useState("");
  const [sortBy, setSortBy] = useState<"updated" | "name" | "created" | "trips">("updated");
  const visibleProjects = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? projects.filter(p =>
          p.name.toLowerCase().includes(q)
          || (p.agencyName ?? "").toLowerCase().includes(q)
          || (p.description ?? "").toLowerCase().includes(q))
      : projects;
    const sorted = [...filtered];
    // Il progetto in esercizio resta sempre in testa, poi il criterio scelto.
    const op = (p: PsProject) => (p.isOperational ? 0 : 1);
    if (sortBy === "name") sorted.sort((a, b) => op(a) - op(b) || a.name.localeCompare(b.name, "it"));
    else if (sortBy === "created") sorted.sort((a, b) => op(a) - op(b) || b.createdAt.localeCompare(a.createdAt));
    else if (sortBy === "trips") sorted.sort((a, b) => op(a) - op(b) || (b.counts?.trips ?? 0) - (a.counts?.trips ?? 0));
    else sorted.sort((a, b) => op(a) - op(b) || b.updatedAt.localeCompare(a.updatedAt));
    return sorted;
  }, [projects, query, sortBy]);

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
    // NB: niente window.confirm — il browser può sopprimerlo ("impedisci
    // altre finestre di dialogo") e il click diventava un no-op silenzioso.
    // La conferma è il doppio click sul cestino (vedi ProjectCard).
    try {
      await deletePsProject(p.id);
      toast.success("Progetto eliminato", { description: p.name });
      refresh();
    } catch (e: any) {
      toast.error("Errore eliminazione", { description: e?.message || "errore sconosciuto" });
    }
  }

  // Dialog in-app (niente prompt/confirm nativi: i browser possono sopprimerli
  // rendendo il click un no-op silenzioso — vedi nota su handleDelete).
  const [dupTarget, setDupTarget] = useState<PsProject | null>(null);
  const [activateTarget, setActivateTarget] = useState<PsProject | null>(null);

  async function doDuplicate(p: PsProject, name: string) {
    const tid = toast.loading(`Duplico "${p.name}"…`, { description: "Copia del programma in corso…" });
    try {
      const copy = await duplicatePsProject(p.id, name.trim() || undefined);
      toast.success(`Copia creata: "${copy.name}"`, { id: tid });
      refresh();
    } catch (e: any) {
      toast.error("Duplicazione fallita", { id: tid, description: e?.message });
      throw e;
    }
  }

  async function handleExportGtfs(p: PsProject) {
    const tid = toast.loading(`Genero il GTFS di "${p.name}"…`);
    try {
      const resp = await fetch(`${getApiBase()}/api/planning-studio/projects/${p.id}/export-gtfs`, { credentials: "include" });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${resp.status}`);
      }
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `gtfs_${p.name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40)}.zip`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success("GTFS esportato", { id: tid, description: "Zip pronto per Regione/open data/AVM." });
    } catch (e: any) {
      toast.error("Export GTFS fallito", { id: tid, description: e?.message });
    }
  }

  // Invocata dal dialog di attivazione: effTrim vuoto = subito, altrimenti
  // decorrenza futura (snapshot materializzato ora, switch automatico quel giorno).
  async function doActivate(p: PsProject, effTrim: string) {
    const tid = toast.loading(`Metto in esercizio "${p.name}"…`, {
      description: "Materializzazione del programma in corso…",
    });
    try {
      const r = await activatePsProject(p.id, effTrim || undefined);
      if (r.scheduledFor) {
        toast.success(`"${p.name}" programmato per il ${new Date(`${r.scheduledFor}T00:00:00`).toLocaleDateString("it-IT")}`, {
          id: tid,
          description: "Lo snapshot è già materializzato; lo switch a operativo avverrà automaticamente alla decorrenza.",
        });
      } else {
        toast.success(`"${p.name}" è ora il programma di esercizio operativo`, { id: tid });
      }
      refresh();
    } catch (e: any) {
      toast.error("Messa in esercizio fallita", { id: tid, description: e?.message });
      throw e;
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

        {/* Ricerca + ordinamento */}
        {projects.length > 0 && (
          <div className="flex flex-wrap items-center gap-3 mb-5">
            <div className="relative flex-1 min-w-56 max-w-md">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500 pointer-events-none" />
              <input
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="Cerca per nome, agenzia o descrizione…"
                className="w-full pl-9 pr-8 py-2 rounded-lg bg-slate-900 border border-slate-800 text-sm focus:outline-none focus:border-emerald-500 placeholder:text-slate-600"
              />
              {query && (
                <button onClick={() => setQuery("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded text-slate-500 hover:text-slate-200"
                  title="Pulisci ricerca">
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
            <label className="flex items-center gap-2 text-xs text-slate-400">
              Ordina per
              <select
                value={sortBy}
                onChange={e => setSortBy(e.target.value as typeof sortBy)}
                className="px-2 py-1.5 rounded-lg bg-slate-900 border border-slate-800 text-xs text-slate-200 focus:outline-none focus:border-emerald-500"
              >
                <option value="updated">Ultima modifica</option>
                <option value="name">Nome (A→Z)</option>
                <option value="created">Data creazione</option>
                <option value="trips">Numero corse</option>
              </select>
            </label>
            {query && (
              <span className="text-xs text-slate-500">
                {visibleProjects.length} su {projects.length} progetti
              </span>
            )}
          </div>
        )}

        {/* Lista */}
        {loading ? (
          <div className="flex items-center justify-center py-24 text-slate-500">
            <Loader2 className="w-6 h-6 animate-spin mr-2" /> Caricamento…
          </div>
        ) : projects.length === 0 ? (
          <EmptyState onCreate={() => setCreateOpen(true)} />
        ) : visibleProjects.length === 0 ? (
          <div className="text-center py-16 text-slate-500 text-sm">
            Nessun progetto corrisponde a "{query}".
            <button onClick={() => setQuery("")} className="ml-2 underline hover:text-slate-300">Pulisci la ricerca</button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {visibleProjects.map(p => (
              <ProjectCard key={p.id} project={p}
                onOpen={() => navigate(`/planning-studio/${p.id}`)}
                onDelete={() => handleDelete(p)}
                onShare={() => setShareProject(p)}
                onActivate={() => setActivateTarget(p)}
                onDuplicate={() => setDupTarget(p)}
                onExportGtfs={() => handleExportGtfs(p)}
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

      {/* Dialog duplica (niente prompt nativo) */}
      {dupTarget && (
        <DuplicateProjectDialog
          project={dupTarget}
          onClose={() => setDupTarget(null)}
          onConfirm={(name) => doDuplicate(dupTarget, name)}
        />
      )}

      {/* Dialog messa in esercizio con decorrenza */}
      {activateTarget && (
        <ActivateProjectDialog
          project={activateTarget}
          onClose={() => setActivateTarget(null)}
          onConfirm={(eff) => doActivate(activateTarget, eff)}
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
  project: p, onOpen, onDelete, onShare, onActivate, onDuplicate, onExportGtfs,
}: { project: PsProject; onOpen: () => void; onDelete: () => void; onShare: () => void; onActivate: () => void; onDuplicate: () => void; onExportGtfs: () => void }) {
  const isOwner = p.myRole === "owner";
  // Eliminazione a DUE CLICK: il primo arma (cestino rosso "Confermi?"),
  // il secondo elimina. Si disarma da solo dopo 4 secondi.
  const [delArmed, setDelArmed] = useState(false);
  useEffect(() => {
    if (!delArmed) return;
    const t = setTimeout(() => setDelArmed(false), 4000);
    return () => clearTimeout(t);
  }, [delArmed]);
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
        <Link href={`/fucina/esercizio/${p.id}`}>
          <button
            onClick={(e) => e.stopPropagation()}
            className="px-2 py-1 rounded-md text-[11px] border border-indigo-500/30 text-indigo-300 hover:bg-indigo-500/10 transition"
            title="Quadro d'esercizio (Scheduling Engine): turni macchina/guida e corse scoperte per UDP"
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
                onClick={(e) => { e.stopPropagation(); onActivate(); }}
                className="p-1 rounded hover:bg-emerald-500/10 text-slate-500 hover:text-emerald-400 transition"
                title="Metti in esercizio (materializza il programma e lo rende operativo)"
              >
                <Power className="w-3.5 h-3.5" />
              </button>
            )}
            <button
              onClick={(e) => { e.stopPropagation(); onDuplicate(); }}
              className="p-1 rounded hover:bg-indigo-500/10 text-slate-500 hover:text-indigo-400 transition"
              title="Duplica il progetto (copia completa: fermate, linee, corse, calendari, validità)"
            >
              <Copy className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); onExportGtfs(); }}
              className="p-1 rounded hover:bg-teal-500/10 text-slate-500 hover:text-teal-400 transition"
              title="Esporta GTFS (zip per Regione/open data/AVM)"
            >
              <Download className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); onShare(); }}
              className="p-1 rounded hover:bg-cyan-500/10 text-slate-500 hover:text-cyan-400 transition"
              title="Condividi"
            >
              <Share2 className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                if (!delArmed) { setDelArmed(true); return; }
                setDelArmed(false);
                onDelete();
              }}
              className={`p-1 rounded transition flex items-center gap-1 ${
                delArmed
                  ? "bg-red-500/20 text-red-300 ring-1 ring-red-500/50"
                  : "hover:bg-red-500/10 text-slate-500 hover:text-red-400"
              }`}
              title={delArmed ? "Clicca di nuovo per ELIMINARE definitivamente" : "Elimina (doppio click di conferma)"}
            >
              <Trash2 className="w-3.5 h-3.5" />
              {delArmed && <span className="text-[10px] font-bold">Confermi?</span>}
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

/* ── Dialog duplica progetto (sostituisce il prompt() nativo) ── */
function DuplicateProjectDialog({
  project, onClose, onConfirm,
}: {
  project: PsProject;
  onClose: () => void;
  onConfirm: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(`${project.name} (copia)`);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try { await onConfirm(name); onClose(); } catch { setBusy(false); }
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => !busy && onClose()}>
      <motion.div
        initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}
        onClick={e => e.stopPropagation()}
        className="w-full max-w-md mx-4 rounded-2xl bg-slate-900 border border-slate-800 shadow-2xl"
      >
        <div className="px-6 py-4 border-b border-slate-800">
          <h2 className="text-lg font-semibold flex items-center gap-2"><Copy className="w-4 h-4 text-cyan-400" /> Duplica progetto</h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Copia profonda di "{project.name}": rete, corse, calendari e classificazione giorni.
            La copia nasce non operativa — è la base per la prossima versione del servizio.
          </p>
        </div>
        <div className="px-6 py-5">
          <label className="block text-xs font-medium text-slate-400 mb-1.5">Nome della copia *</label>
          <input value={name} onChange={e => setName(e.target.value)} autoFocus
            onKeyDown={e => { if (e.key === "Enter") submit(); if (e.key === "Escape" && !busy) onClose(); }}
            className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-sm focus:outline-none focus:border-emerald-500"
          />
        </div>
        <div className="px-6 py-4 border-t border-slate-800 flex justify-end gap-2">
          <button onClick={onClose} disabled={busy}
            className="px-4 py-2 rounded-lg text-sm text-slate-400 hover:text-slate-200 disabled:opacity-40">Annulla</button>
          <button onClick={submit} disabled={!name.trim() || busy}
            className="px-4 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-sm font-medium disabled:opacity-50 flex items-center gap-2"
          >
            {busy && <Loader2 className="w-4 h-4 animate-spin" />} Duplica
          </button>
        </div>
      </motion.div>
    </div>
  );
}

/* ── Dialog messa in esercizio: subito o con DECORRENZA ──
 * Sostituisce la sequenza confirm()+prompt() (sopprimibile dal browser e
 * fragile sul formato data) con un'unica scelta esplicita + date-picker. */
function ActivateProjectDialog({
  project, onClose, onConfirm,
}: {
  project: PsProject;
  onClose: () => void;
  onConfirm: (effectiveFrom: string) => Promise<void>;
}) {
  const [mode, setMode] = useState<"now" | "scheduled">("now");
  const [date, setDate] = useState("");
  const [busy, setBusy] = useState(false);
  const tomorrow = useMemo(() => {
    const d = new Date(Date.now() + 86_400_000);
    return d.toISOString().slice(0, 10);
  }, []);

  // ── PRE-FLIGHT: controllo salute del progetto prima dell'attivazione ──
  // Gli ERRORI (orari non monotoni, finestre di validità impossibili) bloccano
  // il pulsante finché l'operatore non spunta esplicitamente "attiva comunque";
  // i warning sono informativi. Se il check fallisce (endpoint giù) non blocca.
  const [health, setHealth] = useState<PsProjectHealth | null>(null);
  const [healthLoading, setHealthLoading] = useState(true);
  const [overrideErrors, setOverrideErrors] = useState(false);
  useEffect(() => {
    let alive = true;
    getPsProjectHealth(project.id)
      .then((h) => { if (alive) setHealth(h); })
      .catch(() => { /* pre-flight best-effort: non bloccare l'attivazione */ })
      .finally(() => { if (alive) setHealthLoading(false); });
    return () => { alive = false; };
  }, [project.id]);
  const failing = (health?.checks ?? []).filter((ch) => ch.count > 0);
  const hasErrors = failing.some((ch) => ch.level === "error");

  const canSubmit = !busy && !healthLoading
    && (!hasErrors || overrideErrors)
    && (mode === "now" || (date && date >= tomorrow));
  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    try { await onConfirm(mode === "scheduled" ? date : ""); onClose(); } catch { setBusy(false); }
  };
  const c = project.counts;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => !busy && onClose()}>
      <motion.div
        initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}
        onClick={e => e.stopPropagation()}
        className="w-full max-w-lg mx-4 rounded-2xl bg-slate-900 border border-slate-800 shadow-2xl"
      >
        <div className="px-6 py-4 border-b border-slate-800">
          <h2 className="text-lg font-semibold flex items-center gap-2"><Power className="w-4 h-4 text-emerald-400" /> Metti in esercizio</h2>
          <p className="text-xs text-slate-500 mt-0.5">"{project.name}" diventerà il programma operativo unico.</p>
        </div>
        <div className="px-6 py-5 space-y-4">
          {/* Riepilogo impatto */}
          <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3 text-xs text-slate-300 space-y-1.5">
            {c && (
              <p>
                Verranno materializzate <b className="text-slate-100">{c.trips.toLocaleString("it-IT")}</b> corse
                su <b className="text-slate-100">{c.routes}</b> linee ({c.stops.toLocaleString("it-IT")} fermate).
              </p>
            )}
            <p>
              Sala Operativa, AVM, GTFS-RT e tariffe punteranno al feed di questo programma;
              il feed operativo precedente viene <b>archiviato</b> (non cancellato) e resta consultabile nello storico attivazioni.
            </p>
          </div>

          {/* PRE-FLIGHT: controllo salute progetto */}
          <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3 text-xs space-y-2">
            {healthLoading ? (
              <p className="text-slate-400 flex items-center gap-2">
                <Loader2 className="w-3.5 h-3.5 animate-spin" /> Controllo di salute del programma…
              </p>
            ) : !health ? (
              <p className="text-slate-500">Controllo di salute non disponibile (proseguo senza pre-flight).</p>
            ) : failing.length === 0 ? (
              <p className="text-emerald-400 font-medium">✓ Controllo di salute superato: nessuna anomalia rilevata.</p>
            ) : (
              <>
                <p className="font-semibold text-slate-200">
                  Controllo di salute: {health.errors > 0 && <span className="text-rose-400">{health.errors} problem{health.errors === 1 ? "a" : "i"} bloccant{health.errors === 1 ? "e" : "i"}</span>}
                  {health.errors > 0 && health.warnings > 0 && " · "}
                  {health.warnings > 0 && <span className="text-amber-400">{health.warnings} avvis{health.warnings === 1 ? "o" : "i"}</span>}
                </p>
                <ul className="space-y-1.5">
                  {failing.map((ch) => (
                    <li key={ch.key} className={`flex items-start gap-1.5 ${ch.level === "error" ? "text-rose-300" : "text-amber-300/90"}`}>
                      <span className="shrink-0 mt-px">{ch.level === "error" ? "✕" : "⚠"}</span>
                      <span>
                        <b>{ch.count}</b> {ch.label}
                        {ch.samples.length > 0 && (
                          <span className="block text-[11px] text-slate-500">
                            es. {ch.samples.join(" · ")}{ch.count > ch.samples.length ? " …" : ""}
                          </span>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
                {hasErrors && (
                  <label className="flex items-center gap-2 pt-1 text-rose-200 cursor-pointer">
                    <input type="checkbox" checked={overrideErrors} onChange={(e) => setOverrideErrors(e.target.checked)} className="accent-rose-500" />
                    Ho verificato: metti in esercizio comunque
                  </label>
                )}
              </>
            )}
          </div>

          {/* Scelta: subito o con decorrenza */}
          <div className="space-y-2">
            <label className={`flex items-start gap-2.5 p-3 rounded-lg border cursor-pointer transition-colors ${
              mode === "now" ? "border-emerald-500/50 bg-emerald-500/10" : "border-slate-800 hover:border-slate-700"
            }`}>
              <input type="radio" checked={mode === "now"} onChange={() => setMode("now")} className="mt-0.5 accent-emerald-500" />
              <span>
                <span className="block text-sm font-medium text-slate-100">Attiva subito</span>
                <span className="block text-xs text-slate-500">Lo switch avviene immediatamente.</span>
              </span>
            </label>
            <label className={`flex items-start gap-2.5 p-3 rounded-lg border cursor-pointer transition-colors ${
              mode === "scheduled" ? "border-emerald-500/50 bg-emerald-500/10" : "border-slate-800 hover:border-slate-700"
            }`}>
              <input type="radio" checked={mode === "scheduled"} onChange={() => setMode("scheduled")} className="mt-0.5 accent-emerald-500" />
              <span className="flex-1">
                <span className="block text-sm font-medium text-slate-100">Attiva con decorrenza</span>
                <span className="block text-xs text-slate-500 mb-2">
                  Lo snapshot viene preparato ORA (congelato e verificabile); lo switch a operativo
                  avviene automaticamente il giorno scelto. Il programma attuale resta in esercizio fino ad allora.
                </span>
                {mode === "scheduled" && (
                  <input
                    type="date" value={date} min={tomorrow}
                    onChange={e => setDate(e.target.value)}
                    className="px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-sm focus:outline-none focus:border-emerald-500 [color-scheme:dark]"
                  />
                )}
                {mode === "scheduled" && date && date < tomorrow && (
                  <span className="block text-[11px] text-rose-400 mt-1">La decorrenza deve essere una data futura.</span>
                )}
              </span>
            </label>
          </div>
        </div>
        <div className="px-6 py-4 border-t border-slate-800 flex justify-end gap-2">
          <button onClick={onClose} disabled={busy}
            className="px-4 py-2 rounded-lg text-sm text-slate-400 hover:text-slate-200 disabled:opacity-40">Annulla</button>
          <button onClick={submit} disabled={!canSubmit}
            className="px-4 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-white text-sm font-medium disabled:opacity-50 flex items-center gap-2"
          >
            {busy && <Loader2 className="w-4 h-4 animate-spin" />}
            <Power className="w-4 h-4" />
            {mode === "now" ? "Metti in esercizio" : "Programma attivazione"}
          </button>
        </div>
      </motion.div>
    </div>
  );
}
