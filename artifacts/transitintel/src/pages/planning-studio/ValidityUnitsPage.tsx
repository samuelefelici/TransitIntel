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
  ChevronDown, Database, Save,
} from "lucide-react";
import {
  listPsValidityUnits, deletePsValidityUnit, renamePsValidityUnit, getPsValidityUnitDetail,
  type PsValidityUnit,
} from "@/lib/planning-studio-validity-units-api";
import { getPsProject } from "@/lib/planning-studio-api";
import { apiFetch } from "@/lib/api";
import ValiditySectionNav from "./ValiditySectionNav";

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
    <div className="flex flex-col h-screen bg-slate-950 text-slate-100">
      {/* TopBar */}
      <div className="border-b border-slate-800 bg-slate-900 shadow-sm">
        <div className="flex items-center gap-3 px-4 py-3">
          <Link href={`/planning-studio/${projectId}`}>
            <button className="p-2 rounded hover:bg-slate-800 text-slate-400 hover:text-slate-100 transition-colors" title="Torna al progetto">
              <ArrowLeft className="h-4 w-4" />
            </button>
          </Link>
          <Layers className="h-5 w-5 text-indigo-400" />
          <h1 className="font-semibold text-slate-100 shrink-0">
            {projectQ.data?.name ?? "…"}
          </h1>
          <div className="ml-auto">
            <ValiditySectionNav projectId={projectId} active="units" />
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-6">
        {unitsQ.isLoading && (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="h-6 w-6 animate-spin text-indigo-400" />
          </div>
        )}

        {unitsQ.isError && (
          <div className="text-sm text-rose-400">Errore: {(unitsQ.error as Error).message}</div>
        )}

        {!unitsQ.isLoading && sorted.length === 0 && (
          <div className="border-2 border-dashed border-slate-700 rounded-lg p-10 text-center text-slate-400">
            <Layers className="h-12 w-12 mx-auto text-slate-600 mb-3" />
            <p className="font-medium text-slate-200 mb-1">Nessuna unità salvata</p>
            <p className="text-xs">
              Vai alla matrice di validità, clicca "Calcola Unità" per generare i gruppi
              dal range corrente, scegli quali salvare.
            </p>
          </div>
        )}

        {sorted.length > 0 && (
          <div className="space-y-2">
            <div className="text-xs text-slate-400 mb-2">
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

  // ── Dataset consultabile + modifica corse dell'UDP ──
  const [expanded, setExpanded] = useState(false);
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const detailQ = useQuery({
    queryKey: ["ps", projectId, "validity-unit-detail", unit.id],
    queryFn: () => getPsValidityUnitDetail(projectId, unit.id),
    enabled: expanded,
  });
  const tripsMut = useMutation({
    mutationFn: (tripIds: string[]) => renamePsValidityUnit(projectId, unit.id, { tripIds }),
    onSuccess: () => {
      toast.success("Corse dell'unità aggiornate");
      qc.invalidateQueries({ queryKey: ["ps", projectId, "validity-units"] });
      qc.invalidateQueries({ queryKey: ["ps", projectId, "validity-unit-detail", unit.id] });
      setRemoved(new Set());
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const toggleRemoved = (id: string) =>
    setRemoved((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const dateRangeLabel = useMemo(() => {
    const ds = [...unit.representativeDates].sort();
    if (ds.length === 0) return "—";
    if (ds.length === 1) return ds[0];
    return `${ds[0]} … ${ds[ds.length - 1]}`;
  }, [unit.representativeDates]);

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-lg shadow-sm p-4">
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
                className="w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-sm font-semibold text-slate-100 focus:border-indigo-500 focus:outline-none"
              />
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
                placeholder="Descrizione opzionale"
                className="w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200 focus:border-indigo-500 focus:outline-none"
              />
            </div>
          ) : (
            <>
              <div className="font-semibold text-slate-100 truncate">{unit.name}</div>
              {unit.description && (
                <div className="text-xs text-slate-400 mt-0.5 line-clamp-2">{unit.description}</div>
              )}
              <div className="text-[11px] text-slate-500 font-mono mt-1 truncate">
                validityId: {unit.validityId.slice(0, 16)}…
              </div>
            </>
          )}
        </div>

        {/* Stats */}
        <div className="text-right shrink-0">
          <div className="text-2xl font-bold text-indigo-300 tabular-nums">{unit.dayCount}</div>
          <div className="text-[10px] uppercase tracking-wide text-slate-500">giorni</div>
          <div className="text-sm text-slate-300 mt-1 tabular-nums">{unit.tripCount}</div>
          <div className="text-[10px] uppercase tracking-wide text-slate-500">corse</div>
        </div>

        {/* Azioni */}
        <div className="flex flex-col gap-1.5 shrink-0">
          {editing ? (
            <>
              <button
                onClick={() => renameMut.mutate()}
                disabled={!name.trim() || renameMut.isPending}
                className="p-1.5 rounded bg-indigo-600 text-white hover:bg-indigo-500 disabled:opacity-50"
                title="Salva"
              >
                {renameMut.isPending
                  ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  : <Check className="h-3.5 w-3.5" />}
              </button>
              <button
                onClick={() => { setEditing(false); setName(unit.name); setDescription(unit.description ?? ""); }}
                className="p-1.5 rounded border border-slate-700 text-slate-300 hover:bg-slate-800"
                title="Annulla"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => setExpanded((v) => !v)}
                className={`p-1.5 rounded border ${expanded ? "bg-indigo-500/15 border-indigo-500/40 text-indigo-300" : "border-slate-700 hover:bg-slate-800 text-slate-400"}`}
                title="Consulta il dataset (corse) e modifica l'unità"
              >
                {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <Database className="h-3.5 w-3.5" />}
              </button>
              <button
                onClick={onPipeline}
                className="p-1.5 rounded bg-indigo-600 text-white hover:bg-indigo-500"
                title="Vai alla pipeline scheduling"
              >
                <Rocket className="h-3.5 w-3.5" />
              </button>
              <button
                onClick={() => setEditing(true)}
                className="p-1.5 rounded border border-slate-700 hover:bg-slate-800 text-slate-400"
                title="Rinomina"
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
              <button
                onClick={onDelete}
                className="p-1.5 rounded border border-rose-500/40 text-rose-400 hover:bg-rose-500/10"
                title="Elimina"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </>
          )}
        </div>
      </div>

      {/* Footer date */}
      <div className="mt-3 pt-2 border-t border-slate-800 flex items-center gap-2 text-[11px] text-slate-500">
        <CalendarIcon className="h-3 w-3" />
        <span>Range giorni: {dateRangeLabel}</span>
        {unit.representativeDates.length > 1 && (
          <span className="text-slate-400">
            ({unit.representativeDates.length} giorni totali)
          </span>
        )}
      </div>

      {/* Dataset consultabile: corse dell'UDP (con modifica) */}
      {expanded && (
        <div className="mt-3 border-t border-slate-800 pt-3">
          {detailQ.isLoading && (
            <div className="flex items-center gap-2 text-xs text-slate-400 py-3">
              <Loader2 className="h-4 w-4 animate-spin" /> Carico il dataset…
            </div>
          )}
          {detailQ.isError && (
            <div className="text-xs text-rose-400 py-2">Errore: {(detailQ.error as Error).message}</div>
          )}
          {detailQ.data && (
            <>
              <div className="flex items-center justify-between mb-2">
                <div className="text-xs font-semibold text-slate-200 flex items-center gap-1.5">
                  <Database className="h-3.5 w-3.5 text-indigo-400" />
                  Corse nell'unità: {detailQ.data.trips.length - removed.size}/{detailQ.data.trips.length}
                </div>
                {removed.size > 0 && (
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setRemoved(new Set())}
                      className="text-[11px] text-slate-400 hover:underline"
                    >Annulla</button>
                    <button
                      onClick={() => tripsMut.mutate(detailQ.data!.trips.filter((t) => !removed.has(t.id)).map((t) => t.id))}
                      disabled={tripsMut.isPending}
                      className="flex items-center gap-1 text-[11px] px-2 py-1 rounded bg-indigo-600 text-white hover:bg-indigo-500 disabled:opacity-50"
                      title="Salva la nuova composizione corse dell'unità"
                    >
                      {tripsMut.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
                      Salva ({removed.size} rimosse)
                    </button>
                  </div>
                )}
              </div>
              {detailQ.data.trips.length === 0 ? (
                <div className="text-xs text-slate-500 py-3">Nessuna corsa in questa unità.</div>
              ) : (
                <div className="max-h-72 overflow-auto border border-slate-800 rounded">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-slate-950 text-[10px] uppercase tracking-wide text-slate-500">
                      <tr>
                        <th className="px-2 py-1.5 text-left">Linea</th>
                        <th className="px-2 py-1.5 text-left">Cod.</th>
                        <th className="px-2 py-1.5 text-left">Part.</th>
                        <th className="px-2 py-1.5 text-left">Partenza → Arrivo</th>
                        <th className="px-2 py-1.5" />
                      </tr>
                    </thead>
                    <tbody>
                      {detailQ.data.trips.map((t) => {
                        const isRemoved = removed.has(t.id);
                        return (
                          <tr key={t.id} className={`border-t border-slate-800/70 ${isRemoved ? "opacity-40" : "hover:bg-slate-800/40"}`}>
                            <td className="px-2 py-1">
                              <span
                                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-white text-[10px] font-semibold"
                                style={{ backgroundColor: t.routeColor ?? "#64748b" }}
                              >{t.routeShortName ?? "?"}</span>
                            </td>
                            <td className="px-2 py-1 font-mono text-slate-400">{t.shortName ?? "—"}</td>
                            <td className="px-2 py-1 tabular-nums text-slate-400">{t.firstDeparture ? t.firstDeparture.slice(0, 5) : "—"}</td>
                            <td className={`px-2 py-1 text-slate-300 ${isRemoved ? "line-through" : ""}`}>
                              {(t.firstStopName || "—")} <span className="text-slate-500">→</span> {(t.lastStopName || t.headsign || "—")}
                            </td>
                            <td className="px-2 py-1 text-right">
                              <button
                                onClick={() => toggleRemoved(t.id)}
                                className={`p-1 rounded ${isRemoved ? "text-emerald-400 hover:bg-emerald-500/10" : "text-rose-400 hover:bg-rose-500/10"}`}
                                title={isRemoved ? "Reintegra la corsa" : "Rimuovi la corsa dall'unità"}
                              >
                                {isRemoved ? <Check className="h-3.5 w-3.5" /> : <X className="h-3.5 w-3.5" />}
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
