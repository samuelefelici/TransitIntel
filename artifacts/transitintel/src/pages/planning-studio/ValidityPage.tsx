/**
 * PlannerStudio · Validity Matrix — UI matrice (PR2).
 *
 * Layout:
 *   ┌──────────────────────────────────────────────────────┐
 *   │ TopBar: ← back · titolo · range from/to · ↶↷ · Day-types │
 *   ├──────┬───────────────────────────────────────────────┤
 *   │ Trip │ [data1][data2]...[dataN]                      │
 *   │ info │  cella  cella  ...  cella                     │
 *   │ stky │  ...                                          │
 *   └──────┴───────────────────────────────────────────────┘
 *
 * Colore cella:
 *   verde acceso = eccezione "add" (forza valida)
 *   rosso acceso = eccezione "remove" (forza invalida)
 *   verde tenue  = valida da default
 *   grigio       = invalida da default
 *
 * Click cella: cicla 3 stati equivalenti a toggle:
 *   - se cella ha già eccezione → DELETE (ripristina default)
 *   - altrimenti se default=true → PUT exception_type=2 (forza false)
 *   - altrimenti                 → PUT exception_type=1 (forza true)
 *
 * Header data: click → popover con dropdown day-types per override puntuale
 * (scope=project; rimosso il default tenant viene riesposto).
 *
 * Undo/Redo: stack locale di azioni puntuali (max 50). Ogni azione conosce
 * come ripristinare lo stato precedente lato server.
 *
 * Virtualizzazione verticale: render solo le righe nel viewport (con
 * spacers top/bottom). Per range tipico (60-90gg × <300 trip) il carico
 * è gestibile; per >2000 trip il server già blocca con 400.
 */
import { useEffect, useMemo, useRef, useState, useCallback, type CSSProperties } from "react";
import { Link, useParams, useLocation } from "wouter";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ArrowLeft, Calendar as CalendarIcon, Loader2, Undo2, Redo2,
  Palette, Plus, Trash2, Check, X, Settings2, Wand2, Eraser, Layers, Rocket,
} from "lucide-react";
import {
  getPsValidityMatrix, upsertPsTripException, deletePsTripExceptionMatrix,
  upsertPsDayCalendar, upsertPsTripDayValidity,
  listPsDayTypes, createPsDayType, updatePsDayType, deletePsDayType,
  postPsValidityBulk, autoImportPsValidityFromCalendars,
  postPsValidityGenerateUnit,
  type PsValidityMatrix, type PsDayType, type PsValidityTrip,
  type AutoImportSummary,
} from "@/lib/planning-studio-validity-api";
import {
  getPsProject, type PsProject,
  listPsServicePeriods, type PsServicePeriod,
} from "@/lib/planning-studio-api";
import {
  getCellValidity, inferDefaultDayType,
  type DayType as AlgoDayType, type Trip as AlgoTrip, type MatrixContext,
} from "@/lib/planning-studio/validity-matrix";

/* ════════════════════════════════════════════════════════════
 *  Helpers data
 * ════════════════════════════════════════════════════════════ */

function fmtISO(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function todayISO(): string { return fmtISO(new Date()); }
function plusDaysISO(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const t = new Date(y, m - 1, d); t.setDate(t.getDate() + n);
  return fmtISO(t);
}
function isoRange(from: string, to: string): string[] {
  const out: string[] = [];
  let cur = from;
  while (cur <= to) { out.push(cur); cur = plusDaysISO(cur, 1); }
  return out;
}
function dayLabel(iso: string): { day: string; dow: string; isWeekend: boolean } {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  const dow = dt.getDay(); // 0=dom
  return {
    day: String(d),
    dow: ["D", "L", "M", "M", "G", "V", "S"][dow],
    isWeekend: dow === 0 || dow === 6,
  };
}
function monthLabel(iso: string): string {
  const months = ["gen","feb","mar","apr","mag","giu","lug","ago","set","ott","nov","dic"];
  return months[Number(iso.slice(5, 7)) - 1];
}

/* ════════════════════════════════════════════════════════════
 *  Costruzione contesto algoritmo
 * ════════════════════════════════════════════════════════════ */

function buildAlgoContext(matrix: PsValidityMatrix): MatrixContext {
  const trips = new Map<string, AlgoTrip>();
  for (const t of matrix.trips) {
    trips.set(t.id, {
      id: t.id, is_active: t.isActive,
      valid_from: t.validFrom, valid_to: t.validTo,
    });
  }
  const dayTypes = new Map<string, AlgoDayType>();
  for (const dt of matrix.dayTypes) {
    dayTypes.set(dt.id, {
      id: dt.id, code: dt.code, name: dt.name, color: dt.color, is_system: dt.isSystem,
    });
  }
  const tripDayValidity = new Map<string, Map<string, boolean>>();
  for (const v of matrix.tripDayValidity) {
    if (!tripDayValidity.has(v.tripId)) tripDayValidity.set(v.tripId, new Map());
    tripDayValidity.get(v.tripId)!.set(v.dayTypeId, v.isValid);
  }
  const dayCalendar = new Map<string, string>();
  for (const e of matrix.dayCalendar) dayCalendar.set(e.date, e.dayTypeId);
  const tripExceptions = new Map<string, Map<string, 1 | 2>>();
  for (const e of matrix.tripExceptions) {
    if (!tripExceptions.has(e.tripId)) tripExceptions.set(e.tripId, new Map());
    tripExceptions.get(e.tripId)!.set(e.date, e.exceptionType);
  }
  return {
    trips, dayTypes, tripDayValidity, dayCalendar, tripExceptions,
    patronSaints: new Set(matrix.patronSaints),
  };
}

/* ════════════════════════════════════════════════════════════
 *  Undo/Redo stack
 * ════════════════════════════════════════════════════════════ */

interface CellAction {
  kind: "exception";
  tripId: string;
  date: string;
  /** Stato precedente: undefined = nessuna eccezione | 1 = add | 2 = remove */
  prev: 1 | 2 | undefined;
  /** Stato applicato dall'azione */
  next: 1 | 2 | undefined;
}

/* ════════════════════════════════════════════════════════════
 *  Pagina
 * ════════════════════════════════════════════════════════════ */

const ROW_H = 28;
const COL_W = 24;
const STICKY_W = 360;
const HEADER_H = 64;
const VIEWPORT_BUFFER = 8;

export default function PlanningStudioValidityPage() {
  const params = useParams<{ id: string }>();
  const projectId = params?.id ?? "";
  const qc = useQueryClient();

  /* ─── Range ─── */
  const [from, setFrom] = useState<string>(() => todayISO());
  const [to, setTo] = useState<string>(() => plusDaysISO(todayISO(), 60));

  /* ─── Queries ─── */
  const projectQ = useQuery({
    queryKey: ["ps", "project", projectId],
    queryFn: () => getPsProject(projectId),
    enabled: !!projectId,
  });

  const matrixQ = useQuery({
    queryKey: ["ps", projectId, "validity", "matrix", from, to],
    queryFn: () => getPsValidityMatrix(projectId, { from, to }),
    enabled: !!projectId,
  });

  const dayTypesQ = useQuery({
    queryKey: ["ps", projectId, "day-types"],
    queryFn: () => listPsDayTypes(projectId),
    enabled: !!projectId,
  });

  const periodsQ = useQuery({
    queryKey: ["ps", projectId, "service-periods"],
    queryFn: () => listPsServicePeriods(projectId),
    enabled: !!projectId,
  });

  /* ─── Algorithm context (memoizzato) ─── */
  const ctx = useMemo<MatrixContext | null>(() => {
    if (!matrixQ.data) return null;
    return buildAlgoContext(matrixQ.data);
  }, [matrixQ.data]);

  const dates = useMemo(() => isoRange(from, to), [from, to]);

  /* ─── Trips raggruppate per route ─── */
  const groups = useMemo(() => {
    if (!matrixQ.data) return [] as { route: PsValidityTrip; trips: PsValidityTrip[] }[];
    const byRoute = new Map<string, PsValidityTrip[]>();
    for (const t of matrixQ.data.trips) {
      if (!byRoute.has(t.routeId)) byRoute.set(t.routeId, []);
      byRoute.get(t.routeId)!.push(t);
    }
    return Array.from(byRoute.values()).map((trips) => ({ route: trips[0], trips }));
  }, [matrixQ.data]);

  /** flatten: header riga di route + righe trip; ogni riga ha altezza costante. */
  const flatRows = useMemo(() => {
    const rows: Array<
      | { kind: "route-header"; routeId: string; routeShortName: string | null; routeColor: string | null; tripCount: number }
      | { kind: "trip"; trip: PsValidityTrip }
    > = [];
    for (const g of groups) {
      rows.push({
        kind: "route-header",
        routeId: g.route.routeId,
        routeShortName: g.route.routeShortName,
        routeColor: g.route.routeColor,
        tripCount: g.trips.length,
      });
      for (const t of g.trips) rows.push({ kind: "trip", trip: t });
    }
    return rows;
  }, [groups]);

  /* ─── Virtualizzazione verticale ─── */
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(600);

  useEffect(() => {
    if (!scrollerRef.current) return;
    const ro = new ResizeObserver(() => {
      if (scrollerRef.current) setViewportH(scrollerRef.current.clientHeight);
    });
    ro.observe(scrollerRef.current);
    setViewportH(scrollerRef.current.clientHeight);
    return () => ro.disconnect();
  }, []);

  const totalH = flatRows.length * ROW_H;
  const startIdx = Math.max(0, Math.floor(scrollTop / ROW_H) - VIEWPORT_BUFFER);
  const endIdx = Math.min(flatRows.length, Math.ceil((scrollTop + viewportH) / ROW_H) + VIEWPORT_BUFFER);
  const visibleRows = flatRows.slice(startIdx, endIdx);
  const offsetY = startIdx * ROW_H;

  /* ─── Undo / Redo ─── */
  const [undoStack, setUndoStack] = useState<CellAction[]>([]);
  const [redoStack, setRedoStack] = useState<CellAction[]>([]);

  const invalidateMatrix = useCallback(() => {
    qc.invalidateQueries({ queryKey: ["ps", projectId, "validity", "matrix", from, to] });
  }, [qc, projectId, from, to]);

  const applyExceptionAction = useCallback(async (a: CellAction): Promise<void> => {
    if (a.next === undefined) {
      await deletePsTripExceptionMatrix(projectId, { trip_id: a.tripId, date: a.date });
    } else {
      await upsertPsTripException(projectId, {
        trip_id: a.tripId, date: a.date, exception_type: a.next,
      });
    }
  }, [projectId]);

  /* ─── Mutations ─── */
  const cellMut = useMutation({
    mutationFn: async (a: CellAction) => { await applyExceptionAction(a); return a; },
    onSuccess: (a) => {
      setUndoStack((s) => [...s.slice(-49), a]);
      setRedoStack([]);
      invalidateMatrix();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const undoMut = useMutation({
    mutationFn: async () => {
      const last = undoStack[undoStack.length - 1];
      if (!last) return null;
      const inverse: CellAction = { ...last, prev: last.next, next: last.prev };
      await applyExceptionAction(inverse);
      return last;
    },
    onSuccess: (last) => {
      if (!last) return;
      setUndoStack((s) => s.slice(0, -1));
      setRedoStack((s) => [...s.slice(-49), last]);
      invalidateMatrix();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const redoMut = useMutation({
    mutationFn: async () => {
      const last = redoStack[redoStack.length - 1];
      if (!last) return null;
      await applyExceptionAction(last);
      return last;
    },
    onSuccess: (last) => {
      if (!last) return;
      setRedoStack((s) => s.slice(0, -1));
      setUndoStack((s) => [...s.slice(-49), last]);
      invalidateMatrix();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  /* ─── Click cella ─── */
  const onCellClick = useCallback((tripId: string, date: string) => {
    if (!ctx) return;
    const proj = projectQ.data;
    if (proj && proj.myRole === "viewer") {
      toast.error("Modalità sola lettura");
      return;
    }
    const exMap = ctx.tripExceptions.get(tripId);
    const cur = exMap?.get(date);

    // Se c'è già un'eccezione, la rimuovo (ripristino default).
    if (cur !== undefined) {
      cellMut.mutate({ kind: "exception", tripId, date, prev: cur, next: undefined });
      return;
    }
    // Altrimenti calcolo il default e applico l'eccezione opposta.
    const trip = ctx.trips.get(tripId);
    if (!trip) return;
    let defaultValue = false;
    if (trip.is_active
        && (!trip.valid_from || date >= trip.valid_from)
        && (!trip.valid_to || date <= trip.valid_to)) {
      const dtId = ctx.dayCalendar.get(date) ?? inferDefaultDayType(date, ctx);
      if (dtId) defaultValue = ctx.tripDayValidity.get(tripId)?.get(dtId) ?? false;
    }
    const target: 1 | 2 = defaultValue ? 2 : 1;
    cellMut.mutate({ kind: "exception", tripId, date, prev: undefined, next: target });
  }, [ctx, cellMut, projectQ.data]);

  /* ─── Day-Type Editor side panel ─── */
  const [dtEditorOpen, setDtEditorOpen] = useState(false);

  /* ─── Bulk + Auto-import dialogs ─── */
  const [bulkOpen, setBulkOpen] = useState(false);
  const [autoImportOpen, setAutoImportOpen] = useState(false);
  const [genUnitOpen, setGenUnitOpen] = useState(false);
  const [, setLocation] = useLocation();

  /* ─── Dropdown override day-type su data ─── */
  const [dropdownDate, setDropdownDate] = useState<string | null>(null);
  const dayCalMut = useMutation({
    mutationFn: async (input: { date: string; day_type_id: string; scope: "tenant" | "project" }) =>
      upsertPsDayCalendar(projectId, input),
    onSuccess: () => {
      invalidateMatrix();
      setDropdownDate(null);
      toast.success("Override day-type applicato");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  /* ─── Render ─── */

  if (!projectId) return <div className="p-6">ID progetto mancante</div>;

  return (
    <div className="flex flex-col h-screen bg-slate-50">
      {/* TopBar */}
      <div className="flex items-center gap-3 px-4 py-3 border-b bg-white shadow-sm">
        <Link href={`/planning-studio/${projectId}`}>
          <button className="p-2 rounded hover:bg-slate-100" title="Torna al progetto">
            <ArrowLeft className="h-4 w-4" />
          </button>
        </Link>
        <div className="flex items-center gap-2">
          <CalendarIcon className="h-5 w-5 text-blue-600" />
          <h1 className="font-semibold text-slate-900">
            Validità · {projectQ.data?.name ?? "…"}
          </h1>
        </div>

        <div className="flex items-center gap-2 ml-6">
          <label className="text-xs text-slate-500">Da</label>
          <input
            type="date" value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="border rounded px-2 py-1 text-sm"
          />
          <label className="text-xs text-slate-500">A</label>
          <input
            type="date" value={to}
            onChange={(e) => setTo(e.target.value)}
            className="border rounded px-2 py-1 text-sm"
          />
          <button
            onClick={() => { setFrom(todayISO()); setTo(plusDaysISO(todayISO(), 60)); }}
            className="px-2 py-1 text-xs rounded border hover:bg-slate-50"
            title="Reset a oggi → +60gg"
          >Reset</button>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() => undoMut.mutate()}
            disabled={undoStack.length === 0 || undoMut.isPending}
            className="p-2 rounded border hover:bg-slate-100 disabled:opacity-30"
            title="Annulla"
          ><Undo2 className="h-4 w-4" /></button>
          <button
            onClick={() => redoMut.mutate()}
            disabled={redoStack.length === 0 || redoMut.isPending}
            className="p-2 rounded border hover:bg-slate-100 disabled:opacity-30"
            title="Ripeti"
          ><Redo2 className="h-4 w-4" /></button>
          <button
            onClick={() => setDtEditorOpen(true)}
            className="px-3 py-1.5 text-sm rounded border bg-white hover:bg-slate-50 flex items-center gap-1.5"
          >
            <Palette className="h-4 w-4" /> Day-types
          </button>
          <button
            onClick={() => setBulkOpen(true)}
            className="px-3 py-1.5 text-sm rounded border bg-white hover:bg-slate-50 flex items-center gap-1.5"
            title="Operazioni bulk"
          >
            <Layers className="h-4 w-4" /> Bulk
          </button>
          <button
            onClick={() => setAutoImportOpen(true)}
            className="px-3 py-1.5 text-sm rounded border bg-emerald-50 hover:bg-emerald-100 text-emerald-800 flex items-center gap-1.5"
            title="Auto-import da GTFS calendars"
          >
            <Wand2 className="h-4 w-4" /> Auto-import
          </button>
          <button
            onClick={() => setGenUnitOpen(true)}
            className="px-3 py-1.5 text-sm rounded bg-indigo-600 hover:bg-indigo-700 text-white flex items-center gap-1.5 shadow-sm"
            title="Crea Unità di Progettazione (Scheduling) dal filtro corrente"
          >
            <Rocket className="h-4 w-4" /> Genera Unità
          </button>
        </div>
      </div>

      {/* Banda Service Periods (PR3) — mostra i periodi che intersecano il range visibile */}
      {(periodsQ.data?.length ?? 0) > 0 && (
        <ServicePeriodsBand
          periods={periodsQ.data!}
          dates={dates}
        />
      )}

      {/* Stato caricamento */}
      {(matrixQ.isLoading || dayTypesQ.isLoading) && (
        <div className="flex items-center justify-center flex-1">
          <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
        </div>
      )}
      {matrixQ.isError && (
        <div className="p-6 text-sm text-red-600">
          Errore: {(matrixQ.error as Error)?.message}
        </div>
      )}

      {/* Body matrice */}
      {ctx && matrixQ.data && (
        <div className="flex-1 overflow-hidden flex">
          {/* Scroller principale */}
          <div
            ref={scrollerRef}
            onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}
            className="flex-1 overflow-auto relative bg-white"
            style={{ scrollBehavior: "auto" }}
          >
            {/* HEADER sticky top */}
            <div
              className="sticky top-0 z-30 flex bg-white border-b shadow-sm"
              style={{ height: HEADER_H }}
            >
              <div
                className="sticky left-0 z-40 bg-slate-100 border-r flex items-center justify-center text-xs font-medium text-slate-600"
                style={{ width: STICKY_W, minWidth: STICKY_W }}
              >
                Linea / Corsa ({matrixQ.data.trips.length})
              </div>
              <div className="flex" style={{ height: HEADER_H }}>
                {dates.map((d) => {
                  const lbl = dayLabel(d);
                  const dtId = ctx.dayCalendar.get(d) ?? inferDefaultDayType(d, ctx);
                  const dt = dtId ? ctx.dayTypes.get(dtId) : undefined;
                  return (
                    <button
                      key={d}
                      onClick={() => setDropdownDate(d === dropdownDate ? null : d)}
                      className={`flex flex-col items-center justify-center border-r text-[10px] hover:bg-slate-50 ${
                        lbl.isWeekend ? "bg-rose-50/40" : ""
                      } ${dropdownDate === d ? "bg-blue-100" : ""}`}
                      style={{ width: COL_W, minWidth: COL_W }}
                      title={`${d} · ${dt?.name ?? "?"}`}
                    >
                      <span className="text-slate-400">{monthLabel(d)}</span>
                      <span className="font-semibold text-slate-700">{lbl.day}</span>
                      <span className={lbl.isWeekend ? "text-rose-600" : "text-slate-500"}>{lbl.dow}</span>
                      <span
                        className="w-2 h-2 rounded-full mt-0.5"
                        style={{ backgroundColor: dt?.color ?? "#cbd5e1" }}
                      />
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Body righe (windowed) */}
            <div style={{ height: totalH, position: "relative" }}>
              <div style={{ position: "absolute", top: offsetY, left: 0, right: 0 }}>
                {visibleRows.map((row, i) => {
                  const absIdx = startIdx + i;
                  if (row.kind === "route-header") {
                    return (
                      <div
                        key={`r-${absIdx}`}
                        className="flex items-center sticky-route-header bg-slate-100 border-b border-slate-200"
                        style={{ height: ROW_H }}
                      >
                        <div
                          className="sticky left-0 z-20 bg-slate-100 border-r flex items-center gap-2 px-3 text-xs font-semibold text-slate-700"
                          style={{ width: STICKY_W, minWidth: STICKY_W, height: ROW_H }}
                        >
                          <span
                            className="inline-block w-3 h-3 rounded-sm"
                            style={{ backgroundColor: row.routeColor || "#94a3b8" }}
                          />
                          <span>{row.routeShortName ?? "—"}</span>
                          <span className="text-slate-400 font-normal">({row.tripCount} corse)</span>
                        </div>
                        <div
                          className="bg-slate-100"
                          style={{ width: dates.length * COL_W, height: ROW_H }}
                        />
                      </div>
                    );
                  }
                  // riga corsa
                  const t = row.trip;
                  return (
                    <div
                      key={`t-${t.id}`}
                      className="flex border-b border-slate-100"
                      style={{ height: ROW_H }}
                    >
                      <div
                        className="sticky left-0 z-10 bg-white border-r flex items-center gap-2 px-3 text-xs"
                        style={{ width: STICKY_W, minWidth: STICKY_W, height: ROW_H }}
                      >
                        <span className="text-slate-400 tabular-nums w-12">
                          {t.firstDeparture ? t.firstDeparture.slice(0, 5) : "—"}
                        </span>
                        <span className="text-slate-700 truncate flex-1">
                          {t.headsign || t.shortName || t.variantName}
                        </span>
                        <span className="text-slate-400 truncate" style={{ maxWidth: 80 }}>
                          {t.variantName}
                        </span>
                      </div>
                      <CellsRow
                        ctx={ctx}
                        tripId={t.id}
                        dates={dates}
                        onClick={onCellClick}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Side panel Day-Type Editor */}
          {dtEditorOpen && (
            <DayTypeEditor
              projectId={projectId}
              dayTypes={dayTypesQ.data ?? []}
              onClose={() => setDtEditorOpen(false)}
              canEdit={projectQ.data?.myRole !== "viewer"}
            />
          )}

          {/* Popover dropdown override data */}
          {dropdownDate && (
            <DateOverridePopover
              date={dropdownDate}
              dayTypes={dayTypesQ.data ?? []}
              currentEntry={matrixQ.data.dayCalendar.find((e) => e.date === dropdownDate)}
              onClose={() => setDropdownDate(null)}
              onApply={(dayTypeId, scope) =>
                dayCalMut.mutate({ date: dropdownDate, day_type_id: dayTypeId, scope })
              }
              isPending={dayCalMut.isPending}
            />
          )}
        </div>
      )}

      {/* Dialogs (PR3) */}
      {bulkOpen && (
        <BulkDialog
          projectId={projectId}
          range={{ from, to }}
          dayTypes={dayTypesQ.data ?? []}
          periods={periodsQ.data ?? []}
          trips={matrixQ.data?.trips ?? []}
          onClose={() => setBulkOpen(false)}
          onDone={() => {
            invalidateMatrix();
            setBulkOpen(false);
          }}
        />
      )}
      {autoImportOpen && (
        <AutoImportDialog
          projectId={projectId}
          onClose={() => setAutoImportOpen(false)}
          onDone={() => {
            invalidateMatrix();
            setAutoImportOpen(false);
          }}
        />
      )}
      {genUnitOpen && (
        <GenerateUnitDialog
          projectId={projectId}
          projectName={projectQ.data?.name ?? "PS"}
          range={{ from, to }}
          dayTypes={dayTypesQ.data ?? []}
          onClose={() => setGenUnitOpen(false)}
          onCreated={(schedulingProjectId) => {
            setGenUnitOpen(false);
            setLocation(`/fucina/${schedulingProjectId}/pipeline`);
          }}
        />
      )}

      {/* Footer status */}
      <div className="border-t bg-white px-4 py-1.5 text-[11px] text-slate-500 flex gap-4">
        <span>Range: {from} → {to} ({dates.length} giorni)</span>
        <span>Corse: {matrixQ.data?.trips.length ?? 0}</span>
        <span>Day-types: {dayTypesQ.data?.length ?? 0}</span>
        {undoStack.length > 0 && <span>Undo stack: {undoStack.length}</span>}
        {cellMut.isPending && <span className="text-blue-600">Salvataggio…</span>}
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════
 *  Riga celle (memoizzata per evitare re-render eccessivi)
 * ════════════════════════════════════════════════════════════ */

interface CellsRowProps {
  ctx: MatrixContext;
  tripId: string;
  dates: string[];
  onClick: (tripId: string, date: string) => void;
}

function CellsRow({ ctx, tripId, dates, onClick }: CellsRowProps) {
  return (
    <>
      {dates.map((d) => {
        const valid = getCellValidity(ctx, tripId, d);
        const exMap = ctx.tripExceptions.get(tripId);
        const ex = exMap?.get(d);
        const style = cellStyle(valid, ex);
        return (
          <div
            key={d}
            onClick={() => onClick(tripId, d)}
            className="border-r border-slate-100 cursor-pointer"
            style={{ width: COL_W, minWidth: COL_W, height: ROW_H, ...style }}
            title={`${d} · ${valid ? "valida" : "invalida"}${ex ? (ex === 1 ? " (eccezione +)" : " (eccezione −)") : ""}`}
          />
        );
      })}
    </>
  );
}

function cellStyle(valid: boolean, ex: 1 | 2 | undefined): CSSProperties {
  if (ex === 1) return { backgroundColor: "#22c55e" }; // verde acceso
  if (ex === 2) return { backgroundColor: "#ef4444" }; // rosso acceso
  if (valid) return { backgroundColor: "#bbf7d0" };    // verde tenue
  return { backgroundColor: "#f1f5f9" };               // grigio tenue
}

/* ════════════════════════════════════════════════════════════
 *  Popover override data
 * ════════════════════════════════════════════════════════════ */

interface DateOverridePopoverProps {
  date: string;
  dayTypes: PsDayType[];
  currentEntry: { dayTypeId: string; scope: "tenant" | "project" } | undefined;
  onClose: () => void;
  onApply: (dayTypeId: string, scope: "tenant" | "project") => void;
  isPending: boolean;
}

function DateOverridePopover({ date, dayTypes, currentEntry, onClose, onApply, isPending }: DateOverridePopoverProps) {
  const [selected, setSelected] = useState<string>(currentEntry?.dayTypeId ?? "");
  const [scope, setScope] = useState<"tenant" | "project">("project");

  return (
    <div
      className="absolute z-50 bg-white border shadow-xl rounded-lg p-4 w-72"
      style={{ top: HEADER_H + 4, right: 12 }}
    >
      <div className="flex items-center justify-between mb-3">
        <div className="font-semibold text-sm">Override · {date}</div>
        <button onClick={onClose} className="p-1 rounded hover:bg-slate-100">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="text-xs text-slate-500 mb-2">Day-type per questa data</div>
      <select
        value={selected}
        onChange={(e) => setSelected(e.target.value)}
        className="w-full border rounded px-2 py-1.5 text-sm mb-3"
      >
        <option value="">— scegli —</option>
        {dayTypes.map((dt) => (
          <option key={dt.id} value={dt.id}>
            {dt.name} {dt.isSystem ? "(sys)" : ""}
          </option>
        ))}
      </select>
      <div className="text-xs text-slate-500 mb-2">Ambito</div>
      <div className="flex gap-3 mb-4 text-xs">
        <label className="flex items-center gap-1.5 cursor-pointer">
          <input type="radio" checked={scope === "project"} onChange={() => setScope("project")} />
          Solo questo progetto
        </label>
        <label className="flex items-center gap-1.5 cursor-pointer">
          <input type="radio" checked={scope === "tenant"} onChange={() => setScope("tenant")} />
          Globale
        </label>
      </div>
      <div className="flex gap-2 justify-end">
        <button onClick={onClose} className="px-3 py-1.5 text-sm rounded border">Annulla</button>
        <button
          onClick={() => selected && onApply(selected, scope)}
          disabled={!selected || isPending}
          className="px-3 py-1.5 text-sm rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 flex items-center gap-1"
        >
          {isPending && <Loader2 className="h-3 w-3 animate-spin" />}
          Applica
        </button>
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════
 *  DayTypeEditor side panel
 * ════════════════════════════════════════════════════════════ */

interface DayTypeEditorProps {
  projectId: string;
  dayTypes: PsDayType[];
  onClose: () => void;
  canEdit: boolean;
}

function DayTypeEditor({ projectId, dayTypes, onClose, canEdit }: DayTypeEditorProps) {
  const qc = useQueryClient();
  const [showNew, setShowNew] = useState(false);
  const [newCode, setNewCode] = useState("");
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState("#10b981");

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["ps", projectId, "day-types"] });
    qc.invalidateQueries({ queryKey: ["ps", projectId, "validity", "matrix"] });
  };

  const createMut = useMutation({
    mutationFn: () => createPsDayType(projectId, { code: newCode.trim(), name: newName.trim(), color: newColor }),
    onSuccess: () => {
      toast.success("Day-type creato");
      setShowNew(false); setNewCode(""); setNewName(""); setNewColor("#10b981");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const updateMut = useMutation({
    mutationFn: (p: { id: string; patch: { name?: string; color?: string } }) =>
      updatePsDayType(projectId, p.id, p.patch),
    onSuccess: () => { toast.success("Aggiornato"); invalidate(); },
    onError: (e: Error) => toast.error(e.message),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => deletePsDayType(projectId, id),
    onSuccess: () => { toast.success("Eliminato"); invalidate(); },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="w-80 border-l bg-white flex flex-col h-full overflow-hidden">
      <div className="px-4 py-3 border-b flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Settings2 className="h-4 w-4 text-slate-500" />
          <h2 className="font-semibold text-sm">Day-types</h2>
        </div>
        <button onClick={onClose} className="p-1 rounded hover:bg-slate-100">
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 overflow-auto">
        <div className="p-3 space-y-2">
          {dayTypes.map((dt) => (
            <DayTypeRow
              key={dt.id}
              dt={dt}
              canEdit={canEdit}
              onSave={(patch) => updateMut.mutate({ id: dt.id, patch })}
              onDelete={() => {
                if (confirm(`Eliminare "${dt.name}"? L'azione fallisce se è referenziato.`)) {
                  deleteMut.mutate(dt.id);
                }
              }}
            />
          ))}
        </div>
      </div>

      {canEdit && (
        <div className="border-t p-3">
          {!showNew ? (
            <button
              onClick={() => setShowNew(true)}
              className="w-full px-3 py-2 text-sm rounded border bg-white hover:bg-slate-50 flex items-center justify-center gap-1.5"
            >
              <Plus className="h-4 w-4" /> Nuovo day-type custom
            </button>
          ) : (
            <div className="space-y-2">
              <input
                placeholder="Codice (es. festa_patronale)"
                value={newCode}
                onChange={(e) => setNewCode(e.target.value)}
                className="w-full border rounded px-2 py-1.5 text-sm"
              />
              <input
                placeholder="Nome visibile"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                className="w-full border rounded px-2 py-1.5 text-sm"
              />
              <div className="flex items-center gap-2">
                <input
                  type="color" value={newColor}
                  onChange={(e) => setNewColor(e.target.value)}
                  className="w-10 h-8 border rounded"
                />
                <span className="text-xs font-mono">{newColor}</span>
              </div>
              <div className="flex gap-2 justify-end">
                <button
                  onClick={() => setShowNew(false)}
                  className="px-3 py-1.5 text-sm rounded border"
                >Annulla</button>
                <button
                  onClick={() => createMut.mutate()}
                  disabled={!newCode.trim() || !newName.trim() || createMut.isPending}
                  className="px-3 py-1.5 text-sm rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 flex items-center gap-1"
                >
                  {createMut.isPending && <Loader2 className="h-3 w-3 animate-spin" />}
                  Crea
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface DayTypeRowProps {
  dt: PsDayType;
  canEdit: boolean;
  onSave: (patch: { name?: string; color?: string }) => void;
  onDelete: () => void;
}

function DayTypeRow({ dt, canEdit, onSave, onDelete }: DayTypeRowProps) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(dt.name);
  const [color, setColor] = useState(dt.color);

  if (editing && canEdit && !dt.isSystem) {
    return (
      <div className="border rounded p-2 space-y-2 bg-slate-50">
        <input
          value={name} onChange={(e) => setName(e.target.value)}
          className="w-full border rounded px-2 py-1 text-sm"
        />
        <div className="flex items-center gap-2">
          <input
            type="color" value={color}
            onChange={(e) => setColor(e.target.value)}
            className="w-8 h-7 border rounded"
          />
          <span className="text-xs font-mono">{color}</span>
          <div className="ml-auto flex gap-1">
            <button onClick={() => setEditing(false)} className="p-1 rounded hover:bg-slate-200">
              <X className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={() => { onSave({ name, color }); setEditing(false); }}
              className="p-1 rounded bg-blue-600 text-white hover:bg-blue-700"
            >
              <Check className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-slate-50 group">
      <span
        className="inline-block w-4 h-4 rounded"
        style={{ backgroundColor: dt.color }}
      />
      <div className="flex-1 min-w-0">
        <div className="text-sm text-slate-800 truncate">{dt.name}</div>
        <div className="text-[10px] text-slate-400 font-mono truncate">
          {dt.code} {dt.isSystem ? "· system" : ""}
        </div>
      </div>
      {canEdit && !dt.isSystem && (
        <div className="opacity-0 group-hover:opacity-100 flex gap-1">
          <button
            onClick={() => setEditing(true)}
            className="p-1 rounded hover:bg-slate-200" title="Modifica"
          >
            <Palette className="h-3.5 w-3.5 text-slate-500" />
          </button>
          <button
            onClick={onDelete}
            className="p-1 rounded hover:bg-red-50" title="Elimina"
          >
            <Trash2 className="h-3.5 w-3.5 text-red-500" />
          </button>
        </div>
      )}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════
 *  Service Periods Band (PR3)
 * ════════════════════════════════════════════════════════════
 *
 * Banda orizzontale che mostra i Service Periods (es. Estivo / Invernale)
 * mappati sulla stessa griglia delle date della matrice.
 * Allineata visivamente con la sticky-left + header date.
 */
interface ServicePeriodsBandProps {
  periods: PsServicePeriod[];
  dates: string[];
}
function ServicePeriodsBand({ periods, dates }: ServicePeriodsBandProps) {
  if (dates.length === 0) return null;
  const from = dates[0];
  const to = dates[dates.length - 1];
  // Filtra solo i periodi che si sovrappongono al range visibile
  const visible = periods.filter((p) => p.startDate <= to && p.endDate >= from);

  return (
    <div className="border-b bg-slate-50 flex" style={{ height: 28 }}>
      <div
        className="border-r bg-slate-100 flex items-center px-3 text-[11px] font-medium text-slate-600"
        style={{ width: STICKY_W, minWidth: STICKY_W }}
      >
        Service Periods ({visible.length})
      </div>
      <div className="relative flex-1 overflow-hidden" style={{ height: 28 }}>
        {visible.map((p) => {
          const startIdx = Math.max(0, dates.indexOf(p.startDate >= from ? p.startDate : from));
          // se startDate < from, la barra inizia da 0
          const realStart = p.startDate >= from
            ? dates.indexOf(p.startDate)
            : 0;
          const realEnd = p.endDate <= to
            ? dates.indexOf(p.endDate)
            : dates.length - 1;
          if (realStart < 0 || realEnd < 0) return null;
          const left = realStart * COL_W;
          const width = (realEnd - realStart + 1) * COL_W;
          return (
            <div
              key={p.id}
              className="absolute top-1 bottom-1 rounded text-[10px] flex items-center justify-center px-2 text-white font-medium truncate cursor-default"
              style={{
                left, width,
                backgroundColor: p.color || "#64748b",
                opacity: 0.85,
              }}
              title={`${p.name} · ${p.startDate} → ${p.endDate}`}
            >
              {width > 60 ? p.name : ""}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════
 *  BulkDialog (PR3) — 4 operazioni
 * ════════════════════════════════════════════════════════════ */

interface BulkDialogProps {
  projectId: string;
  range: { from: string; to: string };
  dayTypes: PsDayType[];
  periods: PsServicePeriod[];
  trips: PsValidityTrip[];
  onClose: () => void;
  onDone: () => void;
}
function BulkDialog({ projectId, range, dayTypes, periods, trips, onClose, onDone }: BulkDialogProps) {
  const [op, setOp] = useState<"trip-row-set" | "date-column-set" | "period-fill" | "clear-exceptions">(
    "period-fill",
  );

  // Stato per ogni op
  const [tripId, setTripId] = useState("");
  const [date, setDate] = useState(range.from);
  const [periodId, setPeriodId] = useState(periods[0]?.id ?? "");
  const [selectedDayTypes, setSelectedDayTypes] = useState<Set<string>>(new Set());
  const [isValid, setIsValid] = useState(true);
  const [confirmClear, setConfirmClear] = useState(false);

  const mut = useMutation({
    mutationFn: async () => {
      if (op === "trip-row-set") {
        if (!tripId || selectedDayTypes.size === 0) throw new Error("Seleziona corsa e day-types");
        return postPsValidityBulk(projectId, {
          op, tripId, dayTypeIds: Array.from(selectedDayTypes), isValid,
        });
      }
      if (op === "date-column-set") {
        return postPsValidityBulk(projectId, { op, date, isValid });
      }
      if (op === "period-fill") {
        if (!periodId || selectedDayTypes.size === 0) throw new Error("Seleziona periodo e day-types");
        return postPsValidityBulk(projectId, {
          op, periodId, dayTypeIds: Array.from(selectedDayTypes), isValid,
        });
      }
      if (op === "clear-exceptions") {
        if (!confirmClear) throw new Error("Conferma richiesta");
        return postPsValidityBulk(projectId, { op, from: range.from, to: range.to });
      }
      throw new Error("op?");
    },
    onSuccess: (r) => {
      toast.success(`Bulk completato: ${r.count} record`);
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const toggleDt = (id: string) => {
    setSelectedDayTypes((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center" onClick={onClose}>
      <div
        className="bg-white rounded-lg shadow-2xl w-[560px] max-h-[80vh] overflow-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b px-5 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Layers className="h-5 w-5 text-blue-600" />
            <h2 className="font-semibold">Operazioni Bulk</h2>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-slate-100">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {/* Selettore op */}
          <div>
            <label className="text-xs font-medium text-slate-600 block mb-1.5">Operazione</label>
            <select
              value={op} onChange={(e) => setOp(e.target.value as any)}
              className="w-full border rounded px-2 py-2 text-sm"
            >
              <option value="period-fill">Riempi periodo · imposta default per (periodo × day-types) su tutte le corse</option>
              <option value="trip-row-set">Imposta riga corsa · default validità per (corsa × day-types)</option>
              <option value="date-column-set">Imposta colonna data · forza eccezione per tutte le corse a quella data</option>
              <option value="clear-exceptions">Pulisci eccezioni · rimuovi tutte le eccezioni nel range visibile</option>
            </select>
          </div>

          {/* Form per op selezionata */}
          {op === "trip-row-set" && (
            <>
              <FieldTrip trips={trips} value={tripId} onChange={setTripId} />
              <FieldDayTypes dayTypes={dayTypes} selected={selectedDayTypes} onToggle={toggleDt} />
              <FieldIsValid value={isValid} onChange={setIsValid} />
            </>
          )}

          {op === "date-column-set" && (
            <>
              <div>
                <label className="text-xs font-medium text-slate-600 block mb-1">Data</label>
                <input
                  type="date" value={date} min={range.from} max={range.to}
                  onChange={(e) => setDate(e.target.value)}
                  className="w-full border rounded px-2 py-1.5 text-sm"
                />
              </div>
              <FieldIsValid value={isValid} onChange={setIsValid} />
              <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">
                ⚠ Sovrascrive eventuali eccezioni esistenti per questa data.
              </p>
            </>
          )}

          {op === "period-fill" && (
            <>
              <div>
                <label className="text-xs font-medium text-slate-600 block mb-1">Service Period</label>
                <select
                  value={periodId} onChange={(e) => setPeriodId(e.target.value)}
                  className="w-full border rounded px-2 py-1.5 text-sm"
                >
                  <option value="">— scegli —</option>
                  {periods.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} · {p.startDate} → {p.endDate}
                    </option>
                  ))}
                </select>
                {periods.length === 0 && (
                  <p className="text-xs text-slate-500 mt-1">
                    Nessun service period definito. Crealo dalla pagina Service Periods.
                  </p>
                )}
              </div>
              <FieldDayTypes dayTypes={dayTypes} selected={selectedDayTypes} onToggle={toggleDt} />
              <FieldIsValid value={isValid} onChange={setIsValid} />
            </>
          )}

          {op === "clear-exceptions" && (
            <div className="space-y-2">
              <p className="text-sm">
                Rimuove tutte le eccezioni puntuali nel range
                <strong> {range.from} → {range.to}</strong>.
              </p>
              <label className="flex items-center gap-2 text-sm bg-red-50 border border-red-200 rounded p-2">
                <input
                  type="checkbox" checked={confirmClear}
                  onChange={(e) => setConfirmClear(e.target.checked)}
                />
                Confermo: l'operazione non è reversibile.
              </label>
            </div>
          )}
        </div>

        <div className="border-t px-5 py-3 flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 text-sm rounded border">Annulla</button>
          <button
            onClick={() => mut.mutate()}
            disabled={mut.isPending}
            className="px-3 py-1.5 text-sm rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 flex items-center gap-1.5"
          >
            {mut.isPending && <Loader2 className="h-3 w-3 animate-spin" />}
            {op === "clear-exceptions" ? <Eraser className="h-3.5 w-3.5" /> : <Check className="h-3.5 w-3.5" />}
            Applica
          </button>
        </div>
      </div>
    </div>
  );
}

function FieldTrip({ trips, value, onChange }: { trips: PsValidityTrip[]; value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <label className="text-xs font-medium text-slate-600 block mb-1">Corsa</label>
      <select
        value={value} onChange={(e) => onChange(e.target.value)}
        className="w-full border rounded px-2 py-1.5 text-sm"
      >
        <option value="">— scegli —</option>
        {trips.map((t) => (
          <option key={t.id} value={t.id}>
            {t.routeShortName ?? "?"} · {t.firstDeparture?.slice(0, 5) ?? "—"} · {t.headsign || t.shortName || t.variantName}
          </option>
        ))}
      </select>
    </div>
  );
}

function FieldDayTypes({ dayTypes, selected, onToggle }: {
  dayTypes: PsDayType[]; selected: Set<string>; onToggle: (id: string) => void;
}) {
  return (
    <div>
      <label className="text-xs font-medium text-slate-600 block mb-1.5">Day-types</label>
      <div className="grid grid-cols-2 gap-1.5">
        {dayTypes.map((dt) => (
          <label key={dt.id} className="flex items-center gap-2 text-sm border rounded px-2 py-1 cursor-pointer hover:bg-slate-50">
            <input
              type="checkbox" checked={selected.has(dt.id)}
              onChange={() => onToggle(dt.id)}
            />
            <span className="inline-block w-3 h-3 rounded-sm" style={{ backgroundColor: dt.color }} />
            <span className="truncate">{dt.name}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

function FieldIsValid({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div>
      <label className="text-xs font-medium text-slate-600 block mb-1">Imposta a</label>
      <div className="flex gap-3">
        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input type="radio" checked={value === true} onChange={() => onChange(true)} />
          <span className="px-2 py-0.5 rounded bg-emerald-100 text-emerald-800 text-xs">Valido</span>
        </label>
        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input type="radio" checked={value === false} onChange={() => onChange(false)} />
          <span className="px-2 py-0.5 rounded bg-slate-200 text-slate-700 text-xs">Invalido</span>
        </label>
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════
 *  AutoImportDialog (PR3)
 * ════════════════════════════════════════════════════════════ */

interface AutoImportDialogProps {
  projectId: string;
  onClose: () => void;
  onDone: () => void;
}
function AutoImportDialog({ projectId, onClose, onDone }: AutoImportDialogProps) {
  const [preview, setPreview] = useState<AutoImportSummary | null>(null);

  const previewMut = useMutation({
    mutationFn: () => autoImportPsValidityFromCalendars(projectId, { dryRun: true }),
    onSuccess: (r) => setPreview(r),
    onError: (e: Error) => toast.error(e.message),
  });

  const applyMut = useMutation({
    mutationFn: () => autoImportPsValidityFromCalendars(projectId, { dryRun: false }),
    onSuccess: (r) => {
      toast.success(`Auto-import completato: ${r.summary.validityUpserts} validità + ${r.summary.exceptionInserts} eccezioni`);
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center" onClick={onClose}>
      <div
        className="bg-white rounded-lg shadow-2xl w-[640px] max-h-[80vh] overflow-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b px-5 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Wand2 className="h-5 w-5 text-emerald-600" />
            <h2 className="font-semibold">Auto-import da GTFS calendars</h2>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-slate-100">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-5 space-y-3 text-sm">
          <p className="text-slate-600">
            Mappa i <strong>ps_calendars</strong> esistenti del progetto in <strong>ps_trip_day_validity</strong>:
          </p>
          <ul className="text-xs text-slate-500 list-disc pl-5 space-y-1">
            <li>Pattern lun-ven → day-type <span className="font-mono">feriale</span></li>
            <li>Pattern sabato → day-type <span className="font-mono">sabato</span></li>
            <li>Pattern domenica → day-type <span className="font-mono">festivo</span></li>
            <li>Date eccezione (calendar_dates) → eccezioni puntuali per ogni corsa del calendar</li>
            <li>Imposta valid_from/valid_to del trip dal range del calendar (solo se NULL)</li>
          </ul>

          {!preview && (
            <button
              onClick={() => previewMut.mutate()}
              disabled={previewMut.isPending}
              className="px-3 py-1.5 text-sm rounded border bg-white hover:bg-slate-50 flex items-center gap-1.5"
            >
              {previewMut.isPending && <Loader2 className="h-3 w-3 animate-spin" />}
              1. Anteprima (dry-run)
            </button>
          )}

          {preview && (
            <div className="border rounded">
              <div className="px-3 py-2 bg-slate-50 border-b text-xs font-medium">
                Preview · {preview.summary.calendars} calendari · {preview.summary.validityUpserts} righe validità
                + {preview.summary.exceptionInserts} eccezioni
              </div>
              <table className="w-full text-xs">
                <thead className="bg-slate-50 border-b">
                  <tr>
                    <th className="text-left px-3 py-1.5">Calendar</th>
                    <th className="text-right px-3 py-1.5">Trip</th>
                    <th className="text-right px-3 py-1.5">DayTypes</th>
                    <th className="text-right px-3 py-1.5">Validità</th>
                    <th className="text-right px-3 py-1.5">Eccezioni</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.perCalendar.map((c) => (
                    <tr key={c.calendarId} className="border-b">
                      <td className="px-3 py-1 font-mono">{c.calendarCode ?? c.calendarId.slice(0, 8)}</td>
                      <td className="px-3 py-1 text-right">{c.tripCount}</td>
                      <td className="px-3 py-1 text-right">{c.dayTypeCount}</td>
                      <td className="px-3 py-1 text-right">{c.validityRowsToWrite}</td>
                      <td className="px-3 py-1 text-right">{c.exceptionRowsToWrite}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="border-t px-5 py-3 flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 text-sm rounded border">Annulla</button>
          <button
            onClick={() => applyMut.mutate()}
            disabled={!preview || applyMut.isPending}
            className="px-3 py-1.5 text-sm rounded bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 flex items-center gap-1.5"
          >
            {applyMut.isPending && <Loader2 className="h-3 w-3 animate-spin" />}
            <Wand2 className="h-3.5 w-3.5" />
            2. Applica
          </button>
        </div>
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════
 *  GenerateUnitDialog (PR4)
 * ════════════════════════════════════════════════════════════
 *
 * Dialog finale del workflow PlannerStudio: dalla matrice di validità
 * crea un'"Unità di Progettazione" (= scheduling_project) che eredita
 * il filtro corrente (range date + day-types selezionati) e fa da ponte
 * verso la pipeline Scheduling.
 *
 * Dopo la creazione: redirect automatico a /fucina/:id/pipeline.
 */
interface GenerateUnitDialogProps {
  projectId: string;
  projectName: string;
  range: { from: string; to: string };
  dayTypes: PsDayType[];
  onClose: () => void;
  onCreated: (schedulingProjectId: string) => void;
}
function GenerateUnitDialog({
  projectId, projectName, range, dayTypes, onClose, onCreated,
}: GenerateUnitDialogProps) {
  // Default name suggerito
  const defaultName = useMemo(() => {
    const from = range.from.slice(0, 10);
    const to = range.to.slice(0, 10);
    return `${projectName} · ${from} → ${to}`;
  }, [projectName, range.from, range.to]);

  const [name, setName] = useState(defaultName);
  const [description, setDescription] = useState("");
  const [from, setFrom] = useState(range.from);
  const [to, setTo] = useState(range.to);
  // Default: tutti i day-types selezionati
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(dayTypes.map((dt) => dt.id)),
  );
  const [includeOnlyValid, setIncludeOnlyValid] = useState(true);

  const toggle = (id: string) => {
    setSelected((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  };

  const mut = useMutation({
    mutationFn: () => postPsValidityGenerateUnit(projectId, {
      name: name.trim(),
      description: description.trim() || undefined,
      from, to,
      dayTypeIds: Array.from(selected),
      includeOnlyValid,
    }),
    onSuccess: (r) => {
      toast.success(`Unità "${r.name}" creata`);
      onCreated(r.schedulingProjectId);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const canSubmit = name.trim().length > 0
    && from && to && from <= to
    && selected.size > 0
    && !mut.isPending;

  // Calcolo durata
  const days = useMemo(() => {
    if (!from || !to || from > to) return 0;
    return Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
  }, [from, to]);

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center" onClick={onClose}>
      <div
        className="bg-white rounded-lg shadow-2xl w-[600px] max-h-[88vh] overflow-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b px-5 py-3 flex items-center justify-between bg-gradient-to-r from-indigo-50 to-white">
          <div className="flex items-center gap-2">
            <Rocket className="h-5 w-5 text-indigo-600" />
            <h2 className="font-semibold">Genera Unità di Progettazione</h2>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-slate-100">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <p className="text-xs text-slate-600 bg-slate-50 border rounded p-2">
            Crea un nuovo progetto Scheduling collegato a <strong>{projectName}</strong> con
            il filtro di validità snapshot (range + day-types). La pipeline Scheduling potrà
            poi materializzare il GTFS filtrato e procedere con vehicle/driver scheduling.
          </p>

          <div>
            <label className="text-xs font-medium text-slate-600 block mb-1">Nome unità *</label>
            <input
              type="text" value={name} onChange={(e) => setName(e.target.value)}
              className="w-full border rounded px-2 py-1.5 text-sm"
              placeholder="es. Inverno 2026 · Feriali"
            />
          </div>

          <div>
            <label className="text-xs font-medium text-slate-600 block mb-1">Descrizione (opzionale)</label>
            <textarea
              value={description} onChange={(e) => setDescription(e.target.value)}
              className="w-full border rounded px-2 py-1.5 text-sm"
              rows={2}
              placeholder="Note libere sull'unità di progettazione"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-slate-600 block mb-1">Da</label>
              <input
                type="date" value={from} onChange={(e) => setFrom(e.target.value)}
                className="w-full border rounded px-2 py-1.5 text-sm"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-slate-600 block mb-1">A</label>
              <input
                type="date" value={to} onChange={(e) => setTo(e.target.value)}
                className="w-full border rounded px-2 py-1.5 text-sm"
              />
            </div>
          </div>
          {days > 0 && (
            <p className="text-[11px] text-slate-500 -mt-2">
              Range: <strong>{days}</strong> giorni
            </p>
          )}

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-xs font-medium text-slate-600">
                Day-types da includere ({selected.size}/{dayTypes.length})
              </label>
              <div className="flex gap-1">
                <button
                  type="button"
                  onClick={() => setSelected(new Set(dayTypes.map((dt) => dt.id)))}
                  className="text-[11px] text-blue-600 hover:underline"
                >Tutti</button>
                <span className="text-slate-300">·</span>
                <button
                  type="button"
                  onClick={() => setSelected(new Set())}
                  className="text-[11px] text-blue-600 hover:underline"
                >Nessuno</button>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-1.5 max-h-44 overflow-auto border rounded p-2">
              {dayTypes.map((dt) => (
                <label key={dt.id} className="flex items-center gap-2 text-sm cursor-pointer hover:bg-slate-50 px-1 py-0.5 rounded">
                  <input
                    type="checkbox" checked={selected.has(dt.id)}
                    onChange={() => toggle(dt.id)}
                  />
                  <span className="inline-block w-3 h-3 rounded-sm" style={{ backgroundColor: dt.color }} />
                  <span className="truncate">{dt.name}</span>
                </label>
              ))}
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="checkbox" checked={includeOnlyValid}
              onChange={(e) => setIncludeOnlyValid(e.target.checked)}
            />
            <span>Includi solo le corse valide nel filtro (consigliato)</span>
          </label>
        </div>

        <div className="border-t px-5 py-3 flex justify-end gap-2 bg-slate-50">
          <button onClick={onClose} className="px-3 py-1.5 text-sm rounded border bg-white">Annulla</button>
          <button
            onClick={() => mut.mutate()}
            disabled={!canSubmit}
            className="px-3 py-1.5 text-sm rounded bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 flex items-center gap-1.5"
          >
            {mut.isPending && <Loader2 className="h-3 w-3 animate-spin" />}
            <Rocket className="h-3.5 w-3.5" />
            Crea Unità & vai alla pipeline
          </button>
        </div>
      </div>
    </div>
  );
}
