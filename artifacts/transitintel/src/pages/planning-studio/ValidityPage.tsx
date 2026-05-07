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
import { Link, useParams } from "wouter";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ArrowLeft, Calendar as CalendarIcon, Loader2, Undo2, Redo2,
  Palette, Plus, Trash2, Check, X, Settings2,
} from "lucide-react";
import {
  getPsValidityMatrix, upsertPsTripException, deletePsTripExceptionMatrix,
  upsertPsDayCalendar, upsertPsTripDayValidity,
  listPsDayTypes, createPsDayType, updatePsDayType, deletePsDayType,
  type PsValidityMatrix, type PsDayType, type PsValidityTrip,
} from "@/lib/planning-studio-validity-api";
import { getPsProject, type PsProject } from "@/lib/planning-studio-api";
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
        </div>
      </div>

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
