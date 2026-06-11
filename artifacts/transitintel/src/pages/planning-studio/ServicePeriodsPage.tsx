/**
 * PlannerStudio — Service Periods (periodi di esercizio).
 *
 * Tipici esempi:
 *   - "Estivo 2026" (15/06 → 15/09)
 *   - "Invernale 2025-26" (15/09 → 15/06)
 *   - "Scolastico" (sovrapposto all'invernale)
 *
 * Layout: lista sx + timeline visuale dx (Gantt semplice).
 */
import { useMemo, useState } from "react";
import { useLocation, useParams, Link } from "wouter";
import PsProjectNav from "@/components/planning-studio/PsProjectNav";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ArrowLeft, Plus, Trash2, Save, X, CalendarRange, Loader2, Check, Star, StarOff,
} from "lucide-react";
import {
  getPsProject,
  listPsServicePeriods, createPsServicePeriod, updatePsServicePeriod, deletePsServicePeriod,
  type PsServicePeriod,
} from "@/lib/planning-studio-api";

const DEFAULT_COLORS = ["#0ea5e9", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899", "#14b8a6"];

function fmtDate(d: string) {
  if (!d) return "";
  const [y, m, day] = d.split("-");
  return `${day}/${m}/${y}`;
}
function diffDays(a: string, b: string) {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86400000) + 1;
}

export default function PlanningStudioServicePeriodsPage() {
  const params = useParams<{ id: string }>();
  const projectId = params?.id ?? "";
  const qc = useQueryClient();

  const projectQ = useQuery({
    queryKey: ["ps", "project", projectId],
    queryFn: () => getPsProject(projectId),
    enabled: !!projectId,
  });
  const periodsQ = useQuery({
    queryKey: ["ps", projectId, "service-periods"],
    queryFn: () => listPsServicePeriods(projectId),
    enabled: !!projectId,
  });
  const periods = periodsQ.data ?? [];

  /* ─── Mutations ─── */
  const createMut = useMutation({
    mutationFn: (input: any) => createPsServicePeriod(projectId, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ps", projectId, "service-periods"] });
      toast.success("Periodo creato");
    },
    onError: (e: any) => toast.error(e?.message || "Errore"),
  });
  const updateMut = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<PsServicePeriod> }) =>
      updatePsServicePeriod(projectId, id, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["ps", projectId, "service-periods"] }),
    onError: (e: any) => toast.error(e?.message || "Errore aggiornamento"),
  });
  const deleteMut = useMutation({
    mutationFn: (id: string) => deletePsServicePeriod(projectId, id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ps", projectId, "service-periods"] });
      toast.success("Periodo eliminato");
    },
    onError: (e: any) => toast.error(e?.message || "Errore eliminazione"),
  });

  /* ─── Form nuovo periodo ─── */
  const today = new Date().toISOString().slice(0, 10);
  const yearEnd = `${new Date().getFullYear()}-12-31`;
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newCode, setNewCode] = useState("");
  const [newStart, setNewStart] = useState(today);
  const [newEnd, setNewEnd] = useState(yearEnd);
  const [newColor, setNewColor] = useState(DEFAULT_COLORS[0]);
  const [newIsDefault, setNewIsDefault] = useState(false);

  function resetForm() {
    setCreating(false);
    setNewName(""); setNewCode("");
    setNewStart(today); setNewEnd(yearEnd);
    setNewColor(DEFAULT_COLORS[0]); setNewIsDefault(false);
  }

  /* ─── Timeline (Gantt orizzontale) ─── */
  const range = useMemo(() => {
    if (periods.length === 0) return null;
    const starts = periods.map(p => new Date(p.startDate).getTime());
    const ends = periods.map(p => new Date(p.endDate).getTime());
    const min = Math.min(...starts);
    const max = Math.max(...ends);
    return { min, max, span: max - min || 86400000 };
  }, [periods]);

  return (
    <div className="h-screen w-screen flex flex-col bg-slate-950 text-slate-100">
      {/* Toolbar */}
      <div className="h-14 border-b border-slate-800 bg-slate-900 px-4 flex items-center gap-3 shrink-0">
        <Link href={`/planning-studio/${projectId}`}>
          <button className="p-2 rounded hover:bg-slate-800 text-slate-300">
            <ArrowLeft className="w-4 h-4" />
          </button>
        </Link>
        <div className="flex items-center gap-2">
          <CalendarRange className="w-5 h-5 text-indigo-400" />
          <h1 className="font-semibold text-sm">Periodi di esercizio</h1>
        </div>
        {projectQ.data && (
          <span className="text-xs text-slate-500 ml-2">
            {projectQ.data.name} · <span className="text-slate-400">{periods.length} periodi</span>
          </span>
        )}
        <div className="flex-1" />
        <button
          onClick={() => setCreating(true)}
          className="px-3 py-1.5 rounded bg-indigo-600 hover:bg-indigo-500 text-white text-sm flex items-center gap-1.5"
        >
          <Plus className="w-4 h-4" /> Nuovo periodo
        </button>
      </div>
      <PsProjectNav projectId={projectId} />

      {/* Body */}
      <div className="flex-1 flex overflow-hidden">
        {/* Sidebar sx — lista periodi */}
        <div className="w-[420px] border-r border-slate-800 bg-slate-900/60 flex flex-col">
          {creating && (
            <div className="p-3 border-b border-slate-800 bg-slate-900 space-y-2">
              <input
                autoFocus value={newName} onChange={e => setNewName(e.target.value)}
                placeholder="Nome (es. Estivo 2026)"
                className="w-full px-2 py-1.5 rounded bg-slate-800 text-sm border border-slate-700"
              />
              <input
                value={newCode} onChange={e => setNewCode(e.target.value)}
                placeholder="Codice (opz., es. EST26)"
                className="w-full px-2 py-1.5 rounded bg-slate-800 text-sm border border-slate-700"
              />
              <div className="flex gap-2">
                <div className="flex-1">
                  <label className="text-[10px] text-slate-500 block mb-0.5">Da</label>
                  <input type="date" value={newStart} onChange={e => setNewStart(e.target.value)}
                    className="w-full px-2 py-1.5 rounded bg-slate-800 text-xs border border-slate-700" />
                </div>
                <div className="flex-1">
                  <label className="text-[10px] text-slate-500 block mb-0.5">A</label>
                  <input type="date" value={newEnd} onChange={e => setNewEnd(e.target.value)}
                    className="w-full px-2 py-1.5 rounded bg-slate-800 text-xs border border-slate-700" />
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-slate-500">Colore</span>
                {DEFAULT_COLORS.map(c => (
                  <button key={c} onClick={() => setNewColor(c)}
                    className={`w-5 h-5 rounded ${newColor === c ? "ring-2 ring-white" : ""}`}
                    style={{ background: c }} />
                ))}
              </div>
              <label className="flex items-center gap-2 text-xs text-slate-400">
                <input type="checkbox" checked={newIsDefault} onChange={e => setNewIsDefault(e.target.checked)}
                  className="accent-indigo-500" />
                Periodo di default
              </label>
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    if (!newName.trim()) { toast.error("Nome richiesto"); return; }
                    if (new Date(newStart) > new Date(newEnd)) { toast.error("Data inizio > fine"); return; }
                    createMut.mutate(
                      {
                        name: newName.trim(),
                        code: newCode.trim() || undefined,
                        startDate: newStart, endDate: newEnd,
                        color: newColor, isDefault: newIsDefault,
                      },
                      { onSuccess: resetForm }
                    );
                  }}
                  disabled={createMut.isPending}
                  className="flex-1 px-2 py-1.5 rounded bg-indigo-600 hover:bg-indigo-500 text-white text-sm flex items-center justify-center gap-1"
                >
                  {createMut.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                  Crea
                </button>
                <button onClick={resetForm} className="px-3 py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-sm">
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}

          <div className="flex-1 overflow-auto">
            {periodsQ.isLoading && (
              <div className="p-4 text-slate-500 text-sm flex items-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin" /> Caricamento…
              </div>
            )}
            {!periodsQ.isLoading && periods.length === 0 && (
              <div className="p-6 text-center text-slate-500 text-sm">
                Nessun periodo definito.<br />
                Crea il primo per organizzare il servizio nell'anno.
              </div>
            )}
            {periods.map(p => (
              <div
                key={p.id}
                className="px-3 py-2.5 border-b border-slate-800 hover:bg-slate-800/40 transition flex items-center gap-2"
              >
                <div className="w-2 h-12 rounded shrink-0" style={{ background: p.color || "#64748b" }} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <input
                      value={p.name}
                      onChange={(e) => updateMut.mutate({ id: p.id, patch: { name: e.target.value } })}
                      className="flex-1 bg-transparent text-sm font-medium border-none outline-none focus:bg-slate-800 px-1 rounded"
                    />
                    {p.isDefault && (
                      <span className="text-[9px] uppercase font-semibold text-amber-400 bg-amber-500/10 px-1.5 py-0.5 rounded">
                        Default
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-slate-500 mt-0.5">
                    {p.code && <span className="text-slate-400 mr-2">{p.code}</span>}
                    {fmtDate(p.startDate)} → {fmtDate(p.endDate)}
                    <span className="text-slate-600 ml-2">({diffDays(p.startDate, p.endDate)} gg)</span>
                  </div>
                </div>
                <button
                  onClick={() => updateMut.mutate({ id: p.id, patch: { isDefault: !p.isDefault } })}
                  className={`p-1.5 rounded ${p.isDefault ? "text-amber-400" : "text-slate-500 hover:text-slate-300"}`}
                  title={p.isDefault ? "Rimuovi default" : "Imposta come default"}
                >
                  {p.isDefault ? <Star className="w-4 h-4 fill-amber-400" /> : <StarOff className="w-4 h-4" />}
                </button>
                <button
                  onClick={() => {
                    if (confirm(`Eliminare "${p.name}"?`)) deleteMut.mutate(p.id);
                  }}
                  className="p-1.5 rounded text-rose-400 hover:bg-rose-500/10"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        </div>

        {/* Timeline */}
        <div className="flex-1 overflow-auto p-6 bg-slate-950">
          <h2 className="text-sm font-semibold text-slate-400 mb-4">Timeline</h2>
          {!range ? (
            <div className="text-slate-500 text-sm">Nessun periodo da visualizzare.</div>
          ) : (
            <div className="space-y-3">
              {/* Asse mesi */}
              <div className="relative h-6 border-b border-slate-800">
                {(() => {
                  const labels: { ts: number; label: string }[] = [];
                  const start = new Date(range.min);
                  const end = new Date(range.max);
                  const cur = new Date(start.getFullYear(), start.getMonth(), 1);
                  while (cur <= end) {
                    labels.push({ ts: cur.getTime(), label: cur.toLocaleString("it", { month: "short", year: "2-digit" }) });
                    cur.setMonth(cur.getMonth() + 1);
                  }
                  return labels.map((l, i) => (
                    <div key={i}
                      className="absolute top-0 text-[10px] text-slate-500 border-l border-slate-800 pl-1 h-full"
                      style={{ left: `${((l.ts - range.min) / range.span) * 100}%` }}
                    >{l.label}</div>
                  ));
                })()}
              </div>

              {/* Barre periodi */}
              {periods.map(p => {
                const start = new Date(p.startDate).getTime();
                const end = new Date(p.endDate).getTime();
                const left = ((start - range.min) / range.span) * 100;
                const width = ((end - start) / range.span) * 100;
                return (
                  <div key={p.id} className="relative h-9 bg-slate-900/60 rounded">
                    <div
                      className="absolute h-full rounded flex items-center px-2 text-xs font-medium text-white shadow"
                      style={{
                        left: `${left}%`,
                        width: `${Math.max(width, 0.5)}%`,
                        background: p.color || "#64748b",
                      }}
                      title={`${p.name}: ${fmtDate(p.startDate)} → ${fmtDate(p.endDate)}`}
                    >
                      <span className="truncate">{p.name}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <div className="mt-8 p-3 bg-slate-900/40 border border-slate-800 rounded text-xs text-slate-500 leading-relaxed max-w-2xl">
            <strong className="text-slate-300">Suggerimento.</strong> Definisci almeno
            un periodo "Invernale" e uno "Estivo". Successivamente potrai assegnare
            le singole corse a uno o più periodi (es. una corsa potrà essere attiva
            solo nel periodo scolastico).
          </div>
        </div>
      </div>
    </div>
  );
}
