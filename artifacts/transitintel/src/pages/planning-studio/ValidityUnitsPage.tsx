/**
 * PlannerStudio · Lista Unità di Progettazione (validity_id-based).
 *
 * Sezione separata che mostra le Unità salvate per il progetto. Da qui:
 *   - rinomina / elimina
 *   - vai alla pipeline scheduling (TODO link)
 *
 * Le unità vengono CREATE dalla ValidityPage (dialog "Calcola Unità").
 */
import { useMemo, useState } from "react";
import { Link, useParams, useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ArrowLeft, Layers, Loader2, Pencil, Trash2, Check, X, Rocket, Calendar as CalendarIcon,
} from "lucide-react";
import {
  listPsValidityUnits, deletePsValidityUnit, renamePsValidityUnit,
  type PsValidityUnit,
} from "@/lib/planning-studio-validity-units-api";
import { getPsProject } from "@/lib/planning-studio-api";
import { apiFetch } from "@/lib/api";

export default function PlanningStudioValidityUnitsPage() {
  const params = useParams<{ id: string }>();
  const projectId = params?.id ?? "";
  const qc = useQueryClient();
  const [, setLocation] = useLocation();

  const projectQ = useQuery({
    queryKey: ["ps", "project", projectId],
    queryFn: () => getPsProject(projectId),
    enabled: !!projectId,
  });

  const unitsQ = useQuery({
    queryKey: ["ps", projectId, "validity-units"],
    queryFn: () => listPsValidityUnits(projectId),
    enabled: !!projectId,
  });

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: ["ps", projectId, "validity-units"] });

  const delMut = useMutation({
    mutationFn: (id: string) => deletePsValidityUnit(projectId, id),
    onSuccess: () => { toast.success("Unità eliminata"); invalidate(); },
    onError: (e: Error) => toast.error(e.message),
  });

  // Ponte PS → Scheduling Engine: riusa il progetto di esercizio agganciato a
  // questo progetto PS (se esiste), altrimenti lo crea (la creazione avvia in
  // automatico la materializzazione PS → feed GTFS) e apre la pipeline Fucina.
  const pipelineMut = useMutation({
    mutationFn: async () => {
      const found = await apiFetch<{ projects: Array<{ id: string }> }>(
        `/api/scheduling/projects?planningStudioProjectId=${projectId}`,
      );
      if (found.projects.length > 0) return found.projects[0].id;
      const created = await apiFetch<{ project: { id: string } }>(
        "/api/scheduling/projects",
        {
          method: "POST",
          body: JSON.stringify({
            name: `${projectQ.data?.name ?? "Progetto"} · Esercizio`,
            description: "Creato dalle Unità di Progettazione (Planner Studio)",
            planningStudioProjectId: projectId,
          }),
        },
      );
      return created.project.id;
    },
    onSuccess: (schedulingProjectId) => {
      setLocation(`/fucina/${schedulingProjectId}/pipeline`);
    },
    onError: (e: Error) => toast.error(`Pipeline scheduling: ${e.message}`),
  });

  const sorted = useMemo(() => {
    const list = unitsQ.data ?? [];
    return [...list].sort((a, b) => b.dayCount - a.dayCount);
  }, [unitsQ.data]);

  if (!projectId) return <div className="p-6">ID progetto mancante</div>;

  return (
    <div className="flex flex-col h-screen bg-slate-50">
      {/* TopBar */}
      <div className="border-b bg-white shadow-sm">
        <div className="flex items-center gap-3 px-4 py-3">
          <Link href={`/planning-studio/${projectId}`}>
            <button className="p-2 rounded hover:bg-slate-100" title="Torna al progetto">
              <ArrowLeft className="h-4 w-4" />
            </button>
          </Link>
          <Layers className="h-5 w-5 text-indigo-600" />
          <h1 className="font-semibold text-slate-900">
            Unità di Progettazione · {projectQ.data?.name ?? "…"}
          </h1>
          <span className="ml-2 text-xs text-slate-500">
            Insiemi univoci di (categoria · day-type · corse attive) raggruppati per giorni equivalenti.
          </span>
          <div className="ml-auto flex items-center gap-2">
            <Link href={`/planning-studio/${projectId}/validity`}>
              <button className="px-3 py-1.5 text-sm rounded border border-slate-300 bg-white hover:bg-slate-50 flex items-center gap-1.5">
                <CalendarIcon className="h-4 w-4" /> Vai alla matrice di validità
              </button>
            </Link>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-6">
        {unitsQ.isLoading && (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="h-6 w-6 animate-spin text-indigo-600" />
          </div>
        )}

        {unitsQ.isError && (
          <div className="text-sm text-red-600">Errore: {(unitsQ.error as Error).message}</div>
        )}

        {!unitsQ.isLoading && sorted.length === 0 && (
          <div className="border-2 border-dashed border-slate-300 rounded-lg p-10 text-center text-slate-500">
            <Layers className="h-12 w-12 mx-auto text-slate-300 mb-3" />
            <p className="font-medium text-slate-700 mb-1">Nessuna unità salvata</p>
            <p className="text-xs">
              Vai alla matrice di validità, clicca "Calcola Unità" per generare i gruppi
              dal range corrente, scegli quali salvare.
            </p>
          </div>
        )}

        {sorted.length > 0 && (
          <div className="space-y-2">
            <div className="text-xs text-slate-500 mb-2">
              {sorted.length} unità · totale {sorted.reduce((s, u) => s + u.dayCount, 0)} giorni
            </div>
            {sorted.map((u) => (
              <UnitCard
                key={u.id}
                unit={u}
                projectId={projectId}
                onDelete={() => {
                  if (confirm(`Eliminare l'unità "${u.name}"?`)) delMut.mutate(u.id);
                }}
                onPipeline={() => {
                  if (pipelineMut.isPending) return;
                  toast.info("Apro la pipeline scheduling…");
                  pipelineMut.mutate();
                }}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

interface UnitCardProps {
  unit: PsValidityUnit;
  projectId: string;
  onDelete: () => void;
  onPipeline: () => void;
}

function UnitCard({ unit, projectId, onDelete, onPipeline }: UnitCardProps) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(unit.name);
  const [description, setDescription] = useState(unit.description ?? "");

  const renameMut = useMutation({
    mutationFn: () => renamePsValidityUnit(projectId, unit.id, { name: name.trim(), description }),
    onSuccess: () => {
      toast.success("Unità aggiornata");
      qc.invalidateQueries({ queryKey: ["ps", projectId, "validity-units"] });
      setEditing(false);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const dateRangeLabel = useMemo(() => {
    const ds = [...unit.representativeDates].sort();
    if (ds.length === 0) return "—";
    if (ds.length === 1) return ds[0];
    return `${ds[0]} … ${ds[ds.length - 1]}`;
  }, [unit.representativeDates]);

  return (
    <div className="bg-white border rounded-lg shadow-sm p-4">
      <div className="flex items-start gap-3">
        {/* Pillole categoria + day-type */}
        <div className="flex flex-col gap-1.5 shrink-0 min-w-[150px]">
          {unit.categoryId ? (
            <span
              className="inline-flex items-center gap-1.5 text-xs font-medium px-2 py-0.5 rounded-full text-white shadow-sm"
              style={{ backgroundColor: unit.categoryColor ?? "#64748b" }}
            >
              <span className="w-1.5 h-1.5 rounded-full bg-white" />
              {unit.categoryName ?? unit.categoryId.slice(0, 6)}
            </span>
          ) : (
            <span className="inline-flex items-center text-xs text-slate-400 italic">
              (senza categoria)
            </span>
          )}
          {unit.dayTypeId ? (
            <span
              className="inline-flex items-center gap-1.5 text-xs font-medium px-2 py-0.5 rounded-full"
              style={{
                backgroundColor: (unit.dayTypeColor ?? "#94a3b8") + "33",
                color: unit.dayTypeColor ?? "#475569",
                border: `1px solid ${unit.dayTypeColor ?? "#94a3b8"}`,
              }}
            >
              {unit.dayTypeName ?? unit.dayTypeId.slice(0, 6)}
            </span>
          ) : (
            <span className="inline-flex items-center text-xs text-slate-400 italic">
              (senza day-type)
            </span>
          )}
        </div>

        {/* Nome + descrizione */}
        <div className="flex-1 min-w-0">
          {editing ? (
            <div className="space-y-2">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full border rounded px-2 py-1 text-sm font-semibold"
              />
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
                placeholder="Descrizione opzionale"
                className="w-full border rounded px-2 py-1 text-xs"
              />
            </div>
          ) : (
            <>
              <div className="font-semibold text-slate-900 truncate">{unit.name}</div>
              {unit.description && (
                <div className="text-xs text-slate-500 mt-0.5 line-clamp-2">{unit.description}</div>
              )}
              <div className="text-[11px] text-slate-400 font-mono mt-1 truncate">
                validityId: {unit.validityId.slice(0, 16)}…
              </div>
            </>
          )}
        </div>

        {/* Stats */}
        <div className="text-right shrink-0">
          <div className="text-2xl font-bold text-indigo-700 tabular-nums">{unit.dayCount}</div>
          <div className="text-[10px] uppercase tracking-wide text-slate-500">giorni</div>
          <div className="text-sm text-slate-700 mt-1 tabular-nums">{unit.tripCount}</div>
          <div className="text-[10px] uppercase tracking-wide text-slate-500">corse</div>
        </div>

        {/* Azioni */}
        <div className="flex flex-col gap-1.5 shrink-0">
          {editing ? (
            <>
              <button
                onClick={() => renameMut.mutate()}
                disabled={!name.trim() || renameMut.isPending}
                className="p-1.5 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
                title="Salva"
              >
                {renameMut.isPending
                  ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  : <Check className="h-3.5 w-3.5" />}
              </button>
              <button
                onClick={() => { setEditing(false); setName(unit.name); setDescription(unit.description ?? ""); }}
                className="p-1.5 rounded border border-slate-300 hover:bg-slate-100"
                title="Annulla"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </>
          ) : (
            <>
              <button
                onClick={onPipeline}
                className="p-1.5 rounded bg-indigo-600 text-white hover:bg-indigo-700"
                title="Vai alla pipeline scheduling"
              >
                <Rocket className="h-3.5 w-3.5" />
              </button>
              <button
                onClick={() => setEditing(true)}
                className="p-1.5 rounded border border-slate-300 hover:bg-slate-100"
                title="Rinomina"
              >
                <Pencil className="h-3.5 w-3.5 text-slate-600" />
              </button>
              <button
                onClick={onDelete}
                className="p-1.5 rounded border border-red-300 hover:bg-red-50"
                title="Elimina"
              >
                <Trash2 className="h-3.5 w-3.5 text-red-600" />
              </button>
            </>
          )}
        </div>
      </div>

      {/* Footer date */}
      <div className="mt-3 pt-2 border-t border-slate-100 flex items-center gap-2 text-[11px] text-slate-500">
        <CalendarIcon className="h-3 w-3" />
        <span>Range giorni: {dateRangeLabel}</span>
        {unit.representativeDates.length > 1 && (
          <span className="text-slate-400">
            ({unit.representativeDates.length} giorni totali)
          </span>
        )}
      </div>
    </div>
  );
}
