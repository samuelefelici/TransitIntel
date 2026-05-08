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
import { useEffect, useMemo, useRef, useState, useCallback, type CSSProperties, type MouseEvent as ReactMouseEvent } from "react";
import { Link, useParams, useLocation } from "wouter";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ArrowLeft, Calendar as CalendarIcon, Loader2, Undo2, Redo2,
  Palette, Plus, Trash2, Check, X, Settings2, Wand2, Eraser, Layers, Rocket,
  Sparkles, Save,
} from "lucide-react";
import {
  getPsValidityMatrix, upsertPsTripException, deletePsTripExceptionMatrix,
  upsertPsDayCalendar, upsertPsTripDayValidity,
  listPsDayTypes, createPsDayType, updatePsDayType, deletePsDayType,
  postPsValidityBulk, autoImportPsValidityFromCalendars,
  postPsValidityGenerateUnit,
  listPsValidityRoutes,
  type PsValidityMatrix, type PsDayType, type PsValidityTrip,
  type AutoImportSummary, type PsValidityRoute,
} from "@/lib/planning-studio-validity-api";
import {
  listPsValidityCategories, createPsValidityCategory,
  updatePsValidityCategory, deletePsValidityCategory,
  listPsValidityCategoryCalendar, setPsValidityCategoryCalendar,
  computePsValidityUnits, savePsValidityUnits,
  type PsValidityCategory, type PsValidityUnitComputed,
} from "@/lib/planning-studio-validity-units-api";
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
const COL_W = 28;
const STICKY_W = 380;
const MONTH_BAND_H = 22;
const HEADER_H = 64;
const SIDEBAR_W = 260;
const VIEWPORT_BUFFER = 8;

/** Calcola gruppi mese consecutivi per la banda mese sopra l'header giorni. */
function computeMonthGroups(dates: string[]): { label: string; year: number; span: number; startIdx: number }[] {
  const months = ["Gennaio","Febbraio","Marzo","Aprile","Maggio","Giugno","Luglio","Agosto","Settembre","Ottobre","Novembre","Dicembre"];
  const groups: { label: string; year: number; span: number; startIdx: number }[] = [];
  for (let i = 0; i < dates.length; i++) {
    const m = Number(dates[i].slice(5, 7));
    const y = Number(dates[i].slice(0, 4));
    const last = groups[groups.length - 1];
    if (last && last.label === months[m - 1] && last.year === y) {
      last.span += 1;
    } else {
      groups.push({ label: months[m - 1], year: y, span: 1, startIdx: i });
    }
  }
  return groups;
}

export default function PlanningStudioValidityPage() {
  const params = useParams<{ id: string }>();
  const projectId = params?.id ?? "";
  const qc = useQueryClient();

  /* ─── Range ─── */
  const [from, setFrom] = useState<string>(() => todayISO());
  const [to, setTo] = useState<string>(() => plusDaysISO(todayISO(), 60));
  /* ─── Filtro Linea (richiesto se trips > 2000) ─── */
  const [routeId, setRouteId] = useState<string | null>(null);

  /* ─── Queries ─── */
  const projectQ = useQuery({
    queryKey: ["ps", "project", projectId],
    queryFn: () => getPsProject(projectId),
    enabled: !!projectId,
  });

  const routesQ = useQuery({
    queryKey: ["ps", projectId, "validity", "routes"],
    queryFn: () => listPsValidityRoutes(projectId),
    enabled: !!projectId,
  });

  const matrixQ = useQuery({
    queryKey: ["ps", projectId, "validity", "matrix", from, to, routeId],
    queryFn: () => getPsValidityMatrix(projectId, { from, to, routeId }),
    enabled: !!projectId,
    retry: false, // l'errore "too many trips" non va riprovato
  });

  // Diagnostica errore matrice → suggerimento "scegli una linea"
  const matrixErrBody = (matrixQ.error as any)?.body as
    | { error?: string; tripCount?: number; maxTripsPerPage?: number; needsRouteFilter?: boolean }
    | undefined;
  const needsRouteFilter = !!matrixErrBody?.needsRouteFilter;

  // Auto-selezione: se la matrice è troppo grande e non c'è ancora una linea scelta,
  // pre-seleziona la prima disponibile per sbloccare la UI
  useEffect(() => {
    if (needsRouteFilter && !routeId && (routesQ.data?.length ?? 0) > 0) {
      setRouteId(routesQ.data![0].id);
    }
  }, [needsRouteFilter, routeId, routesQ.data]);

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

  /* ─── Auto-import dialogs ─── */
  const [autoImportOpen, setAutoImportOpen] = useState(false);
  const [genUnitOpen, setGenUnitOpen] = useState(false);
  /* ─── Calcola Unità (validity_id-based) ─── */
  const [computeUnitsOpen, setComputeUnitsOpen] = useState(false);
  /* ─── Categorie validità: editor globale + dialog "Categorie Periodi" (calendario dipinto) ─── */
  const [catEditorOpen, setCatEditorOpen] = useState(false);
  const [categoryPeriodsOpen, setCategoryPeriodsOpen] = useState(false);
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

  /* ─── Selezione multipla date (CTRL/SHIFT/Click su header giorno) ─── */
  const [selectedDates, setSelectedDates] = useState<Set<string>>(() => new Set());
  const [lastSelectedIdx, setLastSelectedIdx] = useState<number | null>(null);
  const handleDateHeaderClick = useCallback(
    (date: string, idx: number, e: ReactMouseEvent) => {
      const isMulti = e.metaKey || e.ctrlKey;
      const isRange = e.shiftKey && lastSelectedIdx !== null;
      setSelectedDates((prev) => {
        const next = new Set(prev);
        if (isRange) {
          const a = Math.min(lastSelectedIdx!, idx);
          const b = Math.max(lastSelectedIdx!, idx);
          for (let i = a; i <= b; i++) next.add(dates[i]);
        } else if (isMulti) {
          if (next.has(date)) next.delete(date); else next.add(date);
        } else {
          // click semplice: se è già l'unica selezionata, deseleziona; altrimenti selezione singola
          if (next.size === 1 && next.has(date)) {
            next.clear();
          } else {
            next.clear();
            next.add(date);
          }
        }
        return next;
      });
      setLastSelectedIdx(idx);
    },
    [lastSelectedIdx, dates],
  );
  const clearDateSelection = useCallback(() => {
    setSelectedDates(new Set());
    setLastSelectedIdx(null);
  }, []);

  /* ─── Riga corsa evidenziata (click sulla sticky cell della corsa) ─── */
  const [highlightedTripId, setHighlightedTripId] = useState<string | null>(null);

  /* ─── Categorie di Validità (globali) ─── */
  const categoriesQ = useQuery({
    queryKey: ["ps-validity-categories"],
    queryFn: () => listPsValidityCategories(),
  });
  const categoryCalQ = useQuery({
    queryKey: ["ps-validity-categories", "calendar", from, to],
    queryFn: () => listPsValidityCategoryCalendar({ from, to }),
    enabled: !!from && !!to,
  });
  const categoryByDate = useMemo(() => {
    const m = new Map<string, PsValidityCategory>();
    const cats = categoriesQ.data ?? [];
    const byId = new Map(cats.map((c) => [c.id, c]));
    for (const e of (categoryCalQ.data ?? [])) {
      const c = byId.get(e.categoryId);
      if (c) m.set(e.date, c);
    }
    return m;
  }, [categoriesQ.data, categoryCalQ.data]);

  const setCategoryMut = useMutation({
    mutationFn: (input: { dates: string[]; categoryId: string | null }) =>
      setPsValidityCategoryCalendar(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ps-validity-categories", "calendar"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  /* ─── Selezione 2D celle (SHIFT+Click) ─── */
  const [selectedCells, setSelectedCells] = useState<Set<string>>(() => new Set());
  const [lastCellAnchor, setLastCellAnchor] = useState<{ tripId: string; date: string } | null>(null);
  const cellKey = (tripId: string, date: string) => `${tripId}::${date}`;

  /** Estrae l'elenco trip in ordine di riga (esclude header route). */
  const tripIdsInOrder = useMemo(
    () => flatRows.filter((r) => r.kind === "trip").map((r: any) => r.trip.id as string),
    [flatRows],
  );

  const handleCellSelect = useCallback(
    (tripId: string, date: string, e: ReactMouseEvent) => {
      // SHIFT+Click: range 2D dal precedente anchor (se manca, usa la cella stessa)
      if (e.shiftKey) {
        const anchor = lastCellAnchor ?? { tripId, date };
        const tIdxA = tripIdsInOrder.indexOf(anchor.tripId);
        const tIdxB = tripIdsInOrder.indexOf(tripId);
        const dIdxA = dates.indexOf(anchor.date);
        const dIdxB = dates.indexOf(date);
        if (tIdxA < 0 || tIdxB < 0 || dIdxA < 0 || dIdxB < 0) return;
        const tA = Math.min(tIdxA, tIdxB), tB = Math.max(tIdxA, tIdxB);
        const dA = Math.min(dIdxA, dIdxB), dB = Math.max(dIdxA, dIdxB);
        setSelectedCells((prev) => {
          const next = new Set(prev);
          for (let ti = tA; ti <= tB; ti++) {
            for (let di = dA; di <= dB; di++) {
              next.add(cellKey(tripIdsInOrder[ti], dates[di]));
            }
          }
          return next;
        });
        setLastCellAnchor({ tripId, date });
        return;
      }
      // CMD/CTRL+Click: toggle singolo
      if (e.metaKey || e.ctrlKey) {
        const k = cellKey(tripId, date);
        setSelectedCells((prev) => {
          const next = new Set(prev);
          if (next.has(k)) next.delete(k); else next.add(k);
          return next;
        });
        setLastCellAnchor({ tripId, date });
        return;
      }
      // Click semplice: NON tocca selezione 2D, esegue il toggle eccezione classico
      // ma aggiorna l'ancora così uno SHIFT+Click successivo crea range
      setLastCellAnchor({ tripId, date });
      onCellClick(tripId, date);
    },
    [dates, lastCellAnchor, tripIdsInOrder, onCellClick],
  );

  const clearCellSelection = useCallback(() => {
    setSelectedCells(new Set());
    setLastCellAnchor(null);
  }, []);

  /* ─── Bulk apply su celle selezionate (set valid/invalid/clear) ─── */
  const cellsBulkMut = useMutation({
    mutationFn: async (target: "valid" | "invalid" | "clear") => {
      const items = Array.from(selectedCells);
      let count = 0;
      for (const k of items) {
        const [tripId, date] = k.split("::");
        if (target === "clear") {
          await deletePsTripExceptionMatrix(projectId, { trip_id: tripId, date });
        } else {
          await upsertPsTripException(projectId, {
            trip_id: tripId, date, exception_type: target === "valid" ? 1 : 2,
          });
        }
        count++;
      }
      return count;
    },
    onSuccess: (n) => {
      toast.success(`${n} cell${n === 1 ? "a" : "e"} aggiornata${n === 1 ? "" : "e"}`);
      invalidateMatrix();
      clearCellSelection();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  /* ─── Sincronizza validità da GTFS calendars ─── */
  const syncFromGtfsMut = useMutation({
    mutationFn: () => autoImportPsValidityFromCalendars(projectId, { dryRun: false }),
    onSuccess: (r) => {
      toast.success(
        `Sincronizzato da GTFS: ${r.summary.calendars} calendari, ${r.summary.validityUpserts} bollini, ${r.summary.exceptionInserts} eccezioni`,
      );
      invalidateMatrix();
    },
    onError: (e: Error) => toast.error(`Sincronizzazione fallita: ${e.message}`),
  });

  /* ─── Applica day-type a tutte le date selezionate ─── */
  const applyDayTypeToSelection = useCallback(
    async (dayTypeId: string) => {
      if (selectedDates.size === 0) {
        toast.error("Seleziona almeno un giorno cliccando sull'header");
        return;
      }
      if (projectQ.data?.myRole === "viewer") {
        toast.error("Modalità sola lettura");
        return;
      }
      const arr = Array.from(selectedDates);
      try {
        for (const d of arr) {
          await upsertPsDayCalendar(projectId, { date: d, day_type_id: dayTypeId, scope: "project" });
        }
        invalidateMatrix();
        toast.success(`Day-type applicato a ${arr.length} giorn${arr.length === 1 ? "o" : "i"}`);
        clearDateSelection();
      } catch (err) {
        toast.error((err as Error).message);
      }
    },
    [selectedDates, projectId, projectQ.data, clearDateSelection],
  );

  /* ─── Render ─── */

  if (!projectId) return <div className="p-6">ID progetto mancante</div>;

  return (
    <div className="flex flex-col h-screen bg-slate-50">
      {/* TopBar — stepper visivo: 1 Filtra · 2 Configura · 3 Modifica · 4 Genera */}
      <div className="border-b bg-white shadow-sm">
        {/* Riga 1: titolo + back */}
        <div className="flex items-center gap-3 px-4 pt-3">
          <Link href={`/planning-studio/${projectId}`}>
            <button className="p-2 rounded hover:bg-slate-100" title="Torna al progetto">
              <ArrowLeft className="h-4 w-4" />
            </button>
          </Link>
          <CalendarIcon className="h-5 w-5 text-blue-600" />
          <h1 className="font-semibold text-slate-900">
            Validità · {projectQ.data?.name ?? "…"}
          </h1>
          <span className="ml-2 text-xs text-slate-500">
            Definisci <em>quando</em> circolano le corse, prima dello scheduling.
          </span>
          <div className="ml-auto flex items-center gap-1.5">
            <button
              onClick={() => undoMut.mutate()}
              disabled={undoStack.length === 0 || undoMut.isPending}
              className="p-2 rounded border border-slate-300 text-slate-700 hover:bg-slate-100 disabled:opacity-30"
              title="Annulla"
            ><Undo2 className="h-4 w-4" /></button>
            <button
              onClick={() => redoMut.mutate()}
              disabled={redoStack.length === 0 || redoMut.isPending}
              className="p-2 rounded border border-slate-300 text-slate-700 hover:bg-slate-100 disabled:opacity-30"
              title="Ripeti"
            ><Redo2 className="h-4 w-4" /></button>
          </div>
        </div>

        {/* Riga 2: stepper con 4 sezioni */}
        <div className="flex items-stretch gap-2 px-4 py-3 overflow-x-auto">
          {/* STEP 1 — Filtro temporale e linea */}
          <div className="flex flex-col gap-1 px-3 py-2 rounded-lg bg-sky-50 border border-sky-200 min-w-fit">
            <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-sky-800">
              <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-sky-600 text-white text-[10px]">1</span>
              Filtra
            </div>
            <div className="flex items-center gap-2">
              <label className="text-xs text-sky-900 font-medium">Da</label>
              <input
                type="date" value={from}
                onChange={(e) => setFrom(e.target.value)}
                className="border border-sky-300 bg-white rounded px-2 py-1 text-sm text-slate-900"
              />
              <label className="text-xs text-sky-900 font-medium">A</label>
              <input
                type="date" value={to}
                onChange={(e) => setTo(e.target.value)}
                className="border border-sky-300 bg-white rounded px-2 py-1 text-sm text-slate-900"
              />
              <button
                onClick={() => { setFrom(todayISO()); setTo(plusDaysISO(todayISO(), 60)); }}
                className="px-2 py-1 text-xs rounded border border-sky-300 bg-white text-sky-800 hover:bg-sky-100"
                title="Reset a oggi → +60gg"
              >Reset</button>
              <span className="mx-1 text-sky-300">|</span>
              <label className="text-xs text-sky-900 font-medium">Linea</label>
              <select
                value={routeId ?? ""}
                onChange={(e) => setRouteId(e.target.value || null)}
                className="border border-sky-300 bg-white rounded px-2 py-1 text-sm text-slate-900 max-w-[220px]"
                title="Filtra la matrice per linea (obbligatorio sopra 2000 corse)"
              >
                <option value="">— Tutte le linee —</option>
                {(routesQ.data ?? []).map((r) => (
                  <option key={r.id} value={r.id}>
                    {(r.shortName ?? r.longName ?? "?")} · {r.tripCount} corse
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* STEP 2 — Configura day-types */}
          <div className="flex flex-col gap-1 px-3 py-2 rounded-lg bg-violet-50 border border-violet-200 min-w-fit">
            <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-violet-800">
              <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-violet-600 text-white text-[10px]">2</span>
              Configura
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setDtEditorOpen(true)}
                className="px-3 py-1.5 text-sm rounded border border-violet-400 bg-white hover:bg-violet-100 text-violet-900 font-medium flex items-center gap-1.5"
                title="Crea/modifica i tipi-giornata (Feriale, Festivo, ecc.) e i loro colori"
              >
                <Palette className="h-4 w-4" /> Day-types
              </button>
              <button
                onClick={() => setCategoryPeriodsOpen(true)}
                className="px-3 py-1.5 text-sm rounded border border-fuchsia-400 bg-white hover:bg-fuchsia-100 text-fuchsia-900 font-medium flex items-center gap-1.5"
                title="Definisci 'Categorie Periodi' (es. Scuole Aperte/Chiuse, Festività) e dipingi i giorni del calendario"
              >
                <CalendarIcon className="h-4 w-4" /> Categorie Periodi
              </button>
            </div>
          </div>

          {/* STEP 3 — Sincronizza da GTFS */}
          <div className="flex flex-col gap-1 px-3 py-2 rounded-lg bg-amber-50 border border-amber-200 min-w-fit">
            <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-amber-800">
              <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-amber-600 text-white text-[10px]">3</span>
              Sincronizza
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => syncFromGtfsMut.mutate()}
                disabled={syncFromGtfsMut.isPending}
                className="px-3 py-1.5 text-sm rounded border border-amber-400 bg-white hover:bg-amber-100 text-amber-900 font-medium flex items-center gap-1.5 disabled:opacity-50"
                title="Accendi automaticamente i bollini di validità leggendo i calendari del file GTFS già importato (lun-ven → Feriale, sab → Sabato, dom → Festivo, + eccezioni)"
              >
                {syncFromGtfsMut.isPending
                  ? <Loader2 className="h-4 w-4 animate-spin" />
                  : <Wand2 className="h-4 w-4" />}
                Sincronizza GTFS
              </button>
              <span className="text-[11px] text-slate-700 px-2 font-medium max-w-[260px]">
                Tip: <kbd className="px-1 bg-white border rounded text-slate-900">SHIFT</kbd>+Click sui pallini per selezionare un range
              </span>
            </div>
          </div>

          {/* STEP 4 — Unità di Progettazione */}
          <div className="flex flex-col gap-1 px-3 py-2 rounded-lg bg-indigo-100 border-2 border-indigo-400 min-w-fit">
            <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-indigo-900">
              <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-indigo-700 text-white text-[10px]">4</span>
              Unità di Progettazione
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setComputeUnitsOpen(true)}
                className="px-3 py-1.5 text-sm rounded bg-indigo-700 hover:bg-indigo-800 text-white font-semibold flex items-center gap-1.5 shadow"
                title="Calcola le Unità (gruppi di giorni con stessa categoria + day-type + corse attive) e salva"
              >
                <Rocket className="h-4 w-4" /> Calcola Unità
              </button>
              <Link href={`/planning-studio/${projectId}/validity-units`}>
                <button
                  className="px-3 py-1.5 text-sm rounded border border-indigo-400 bg-white hover:bg-indigo-50 text-indigo-900 font-medium flex items-center gap-1.5"
                  title="Vai alla sezione Unità di Progettazione salvate"
                >
                  <Layers className="h-4 w-4" /> Vedi Unità Salvate
                </button>
              </Link>
            </div>
          </div>
        </div>

        {/* Banner errore: matrice troppo grande → invita a scegliere una linea */}
        {needsRouteFilter && (
          <div className="mx-4 mb-3 px-3 py-2 rounded border border-amber-400 bg-amber-50 text-amber-900 text-sm flex items-start gap-2">
            <span className="font-bold">⚠</span>
            <div>
              <div className="font-semibold">
                Troppe corse nel range selezionato ({matrixErrBody?.tripCount?.toLocaleString("it-IT")} &gt; {matrixErrBody?.maxTripsPerPage?.toLocaleString("it-IT")})
              </div>
              <div className="text-xs">
                Per visualizzare la matrice, scegli una <strong>Linea</strong> nello step 1 (oppure restringi il range di date).
                Abbiamo pre-selezionato la prima linea disponibile.
              </div>
            </div>
          </div>
        )}
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
            {/* HEADER sticky top: 2 righe (mesi + giorni) */}
            <div
              className="sticky top-0 z-30 bg-white border-b shadow-sm"
              style={{ height: HEADER_H + MONTH_BAND_H }}
            >
              {/* Riga 1: banda MESI raggruppati */}
              <div className="flex" style={{ height: MONTH_BAND_H }}>
                <div
                  className="sticky left-0 z-40 bg-slate-200 border-r border-b flex items-center justify-between px-3 text-[11px] font-bold uppercase tracking-wide text-slate-700"
                  style={{ width: STICKY_W, minWidth: STICKY_W }}
                >
                  <span>Mese</span>
                  {selectedDates.size > 0 && (
                    <button
                      onClick={clearDateSelection}
                      className="text-[10px] font-medium normal-case text-slate-600 hover:text-slate-900 underline"
                      title="Deseleziona tutti i giorni"
                    >
                      ✕ deseleziona ({selectedDates.size})
                    </button>
                  )}
                </div>
                <div className="flex">
                  {computeMonthGroups(dates).map((g) => (
                    <div
                      key={`${g.year}-${g.label}-${g.startIdx}`}
                      className="flex items-center justify-center text-[11px] font-bold uppercase tracking-wide text-slate-700 bg-slate-100 border-r border-b border-slate-300"
                      style={{ width: g.span * COL_W, minWidth: g.span * COL_W }}
                      title={`${g.label} ${g.year}`}
                    >
                      {g.span >= 3 ? `${g.label} ${g.year}` : g.label.slice(0, 3)}
                    </div>
                  ))}
                </div>
              </div>

              {/* Riga 2: giorni (numero + sigla DOW) */}
              <div className="flex" style={{ height: HEADER_H }}>
                <div
                  className="sticky left-0 z-40 bg-slate-100 border-r flex items-center justify-center text-xs font-medium text-slate-600"
                  style={{ width: STICKY_W, minWidth: STICKY_W }}
                >
                  Linea / Corsa ({matrixQ.data.trips.length})
                </div>
                <div className="flex" style={{ height: HEADER_H }}>
                  {dates.map((d, idx) => {
                    const lbl = dayLabel(d);
                    const dtId = ctx.dayCalendar.get(d) ?? inferDefaultDayType(d, ctx);
                    const dt = dtId ? ctx.dayTypes.get(dtId) : undefined;
                    const cat = categoryByDate.get(d);
                    const isSelected = selectedDates.has(d);
                    const isFirstOfMonth = d.slice(8, 10) === "01";
                    return (
                      <button
                        key={d}
                        onClick={(e) => handleDateHeaderClick(d, idx, e)}
                        onDoubleClick={() => setDropdownDate(d === dropdownDate ? null : d)}
                        className={`flex flex-col items-center justify-center text-[10px] hover:bg-slate-100 transition-colors ${
                          lbl.isWeekend ? "bg-rose-50/40" : ""
                        } ${isSelected ? "ring-2 ring-inset ring-blue-500 bg-blue-50" : ""} ${
                          dropdownDate === d ? "bg-blue-100" : ""
                        }`}
                        style={{
                          width: COL_W,
                          minWidth: COL_W,
                          borderRight: isFirstOfMonth ? "2px solid #94a3b8" : "1px solid #e2e8f0",
                          borderTop: cat ? `3px solid ${cat.color}` : undefined,
                        }}
                        title={`${d} · ${dt?.name ?? "?"}${cat ? `\nCategoria: ${cat.name}` : ""}\nClick: seleziona · ⌘/Ctrl+Click: aggiungi · Shift+Click: range · Doppio-click: override singolo`}
                      >
                        <span className="font-semibold text-slate-800 text-[12px] leading-tight">{lbl.day}</span>
                        <span className={`leading-tight ${lbl.isWeekend ? "text-rose-600 font-semibold" : "text-slate-500"}`}>{lbl.dow}</span>
                        <span
                          className="w-2.5 h-2.5 rounded-full mt-0.5 ring-1 ring-white"
                          style={{ backgroundColor: dt?.color ?? "#cbd5e1" }}
                        />
                      </button>
                    );
                  })}
                </div>
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
                  const isHighlighted = highlightedTripId === t.id;
                  return (
                    <div
                      key={`t-${t.id}`}
                      className={`flex border-b ${isHighlighted ? "bg-blue-100 border-blue-300 ring-1 ring-inset ring-blue-300" : "border-slate-100"}`}
                      style={{ height: ROW_H }}
                    >
                      <button
                        type="button"
                        onClick={() => setHighlightedTripId(isHighlighted ? null : t.id)}
                        className={`sticky left-0 z-10 border-r flex items-center gap-2 px-3 text-xs text-left ${
                          isHighlighted ? "bg-blue-200 hover:bg-blue-200 border-blue-400 font-semibold text-slate-900" : "bg-white hover:bg-slate-50"
                        }`}
                        style={{ width: STICKY_W, minWidth: STICKY_W, height: ROW_H }}
                        title={`Click: evidenzia riga in tutto il calendario · ${t.shortName ?? ""} · ${t.headsign ?? ""}`}
                      >
                        <span className="text-slate-500 tabular-nums w-12 shrink-0">
                          {t.firstDeparture ? t.firstDeparture.slice(0, 5) : "—"}
                        </span>
                        <span className="font-mono text-[10px] text-slate-700 bg-slate-100 rounded px-1 py-0.5 shrink-0 max-w-[80px] truncate">
                          {t.shortName ?? t.id.slice(0, 6)}
                        </span>
                        <span className="text-slate-800 truncate flex-1">
                          {t.headsign || t.variantName || "—"}
                        </span>
                        <span className="text-slate-500 truncate text-[10px]" style={{ maxWidth: 70 }}>
                          {t.variantName}
                        </span>
                      </button>
                      <CellsRow
                        ctx={ctx}
                        tripId={t.id}
                        dates={dates}
                        onClick={onCellClick}
                        onSelect={handleCellSelect}
                        selectedDates={selectedDates}
                        selectedCells={selectedCells}
                        highlighted={isHighlighted}
                        categoryByDate={categoryByDate}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Sidebar destra: SOLO Day-Types (le categorie sono gestite dal dialog "Categorie Periodi" in topbar) */}
          <ValiditySidebar
            dayTypes={dayTypesQ.data ?? []}
            selectedCount={selectedDates.size}
            onApplyDayType={applyDayTypeToSelection}
            openDayTypeAdvanced={() => setDtEditorOpen(true)}
          />

          {/* Side panel Day-Type Editor (avanzato, modal) */}
          {dtEditorOpen && (
            <DayTypeEditor
              projectId={projectId}
              dayTypes={dayTypesQ.data ?? []}
              onClose={() => setDtEditorOpen(false)}
              canEdit={projectQ.data?.myRole !== "viewer"}
            />
          )}

          {/* Editor categorie validità (modal) */}
          {catEditorOpen && (
            <CategoryEditorDialog
              categories={categoriesQ.data ?? []}
              onClose={() => setCatEditorOpen(false)}
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
      {computeUnitsOpen && (
        <ComputeUnitsDialog
          projectId={projectId}
          range={{ from, to }}
          onClose={() => setComputeUnitsOpen(false)}
          onSaved={() => {
            setComputeUnitsOpen(false);
            setLocation(`/planning-studio/${projectId}/validity-units`);
          }}
        />
      )}
      {categoryPeriodsOpen && (
        <CategoryPeriodsDialog
          onClose={() => setCategoryPeriodsOpen(false)}
          categories={categoriesQ.data ?? []}
          openCategoryEditor={() => setCatEditorOpen(true)}
        />
      )}

      {/* Toolbar contestuale celle selezionate (SHIFT+Click) */}
      {selectedCells.size > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 bg-slate-900 text-white rounded-lg shadow-2xl px-4 py-2 flex items-center gap-3">
          <span className="text-sm font-medium">
            {selectedCells.size} cell{selectedCells.size === 1 ? "a" : "e"} selezionat{selectedCells.size === 1 ? "a" : "e"}
          </span>
          <button
            onClick={() => cellsBulkMut.mutate("valid")}
            disabled={cellsBulkMut.isPending}
            className="px-3 py-1.5 text-xs rounded bg-emerald-600 hover:bg-emerald-700 font-semibold disabled:opacity-50 flex items-center gap-1"
          >
            {cellsBulkMut.isPending && <Loader2 className="h-3 w-3 animate-spin" />}
            <Check className="h-3 w-3" /> Imposta Valide
          </button>
          <button
            onClick={() => cellsBulkMut.mutate("invalid")}
            disabled={cellsBulkMut.isPending}
            className="px-3 py-1.5 text-xs rounded bg-red-600 hover:bg-red-700 font-semibold disabled:opacity-50 flex items-center gap-1"
          >
            <X className="h-3 w-3" /> Imposta Invalide
          </button>
          <button
            onClick={() => cellsBulkMut.mutate("clear")}
            disabled={cellsBulkMut.isPending}
            className="px-3 py-1.5 text-xs rounded bg-slate-600 hover:bg-slate-700 font-semibold disabled:opacity-50 flex items-center gap-1"
          >
            <Eraser className="h-3 w-3" /> Pulisci eccezioni
          </button>
          <button
            onClick={clearCellSelection}
            className="px-2 py-1.5 text-xs rounded hover:bg-slate-700"
            title="Annulla selezione"
          >
            <X className="h-3.5 w-3.5" />
          </button>
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
  onSelect: (tripId: string, date: string, e: ReactMouseEvent) => void;
  selectedDates: Set<string>;
  selectedCells: Set<string>;
  highlighted?: boolean;
  categoryByDate?: Map<string, PsValidityCategory>;
}

function CellsRow({ ctx, tripId, dates, onSelect, selectedDates, selectedCells, highlighted, categoryByDate }: CellsRowProps) {
  return (
    <>
      {dates.map((d) => {
        const valid = getCellValidity(ctx, tripId, d);
        const exMap = ctx.tripExceptions.get(tripId);
        const ex = exMap?.get(d);
        const fill = cellFillColor(valid, ex);
        const isFirstOfMonth = d.slice(8, 10) === "01";
        const isMonday = (() => {
          const [y, m, dd] = d.split("-").map(Number);
          return new Date(y, m - 1, dd).getDay() === 1;
        })();
        const isSelectedCol = selectedDates.has(d);
        const isCellSelected = selectedCells.has(`${tripId}::${d}`);
        const cat = categoryByDate?.get(d);
        const catBg = cat?.color ? `${cat.color}22` : undefined; // ~13% opacity overlay
        return (
          <div
            key={d}
            onClick={(e) => onSelect(tripId, d, e)}
            className={`flex items-center justify-center cursor-pointer transition-colors ${
              highlighted ? "bg-blue-100/50" : isSelectedCol ? "bg-blue-50/60" : ""
            } ${isCellSelected ? "ring-2 ring-inset ring-blue-500 bg-blue-100/40" : ""}`}
            style={{
              width: COL_W,
              minWidth: COL_W,
              height: ROW_H,
              backgroundColor: !isCellSelected && !isSelectedCol && !highlighted ? catBg : undefined,
              borderRight: isFirstOfMonth
                ? "2px solid #94a3b8"
                : isMonday
                ? "1px solid #cbd5e1"
                : "1px solid #f1f5f9",
            }}
            title={`${d} · ${valid ? "valida" : "invalida"}${ex ? (ex === 1 ? " (eccezione +)" : " (eccezione −)") : ""}${cat ? `\nCategoria: ${cat.name}` : ""}\nClick: toggle · Shift+Click: range · Cmd/Ctrl+Click: aggiungi alla selezione`}
          >
            <div
              className="rounded-md transition-transform hover:scale-110"
              style={{
                width: COL_W - 8,
                height: ROW_H - 8,
                backgroundColor: fill,
                boxShadow: ex ? "0 0 0 1.5px rgba(0,0,0,0.12) inset" : undefined,
              }}
            />
          </div>
        );
      })}
    </>
  );
}

function cellFillColor(valid: boolean, ex: 1 | 2 | undefined): string {
  if (ex === 1) return "#16a34a"; // verde acceso (override attiva)
  if (ex === 2) return "#dc2626"; // rosso acceso (override disattiva)
  if (valid) return "#86efac";    // verde tenue (default valida)
  return "#e2e8f0";               // grigio tenue (default invalida)
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
 *  DayTypeSidebar (sempre montato a destra della matrice)
 *  - elenco day-types come "pillole" colorate cliccabili
 *  - applica il day-type a tutte le date selezionate (CTRL/SHIFT/Click sull'header)
 *  - quick-add per creare un nuovo day-type al volo
 * ════════════════════════════════════════════════════════════ */

interface DayTypeSidebarProps {
  projectId: string;
  dayTypes: PsDayType[];
  selectedCount: number;
  onApply: (dayTypeId: string) => void | Promise<void>;
  canEdit: boolean;
  openAdvanced: () => void;
}

function DayTypeSidebar({ projectId, dayTypes, selectedCount, onApply, canEdit, openAdvanced }: DayTypeSidebarProps) {
  const qc = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [newCode, setNewCode] = useState("");
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState("#10b981");

  const createMut = useMutation({
    mutationFn: () =>
      createPsDayType(projectId, { code: newCode.trim(), name: newName.trim(), color: newColor }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ps", projectId, "day-types"] });
      qc.invalidateQueries({ queryKey: ["ps", projectId, "validity", "matrix"] });
      toast.success("Day-type creato");
      setShowAdd(false);
      setNewCode("");
      setNewName("");
      setNewColor("#10b981");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <aside
      className="border-l bg-slate-50 flex flex-col"
      style={{ width: SIDEBAR_W, minWidth: SIDEBAR_W }}
    >
      <div className="px-3 py-2 border-b bg-white">
        <div className="text-xs font-bold uppercase tracking-wide text-slate-700">Day-Types</div>
        <div className="text-[11px] text-slate-500 mt-0.5">
          {selectedCount > 0
            ? `${selectedCount} giorn${selectedCount === 1 ? "o" : "i"} selezionat${selectedCount === 1 ? "o" : "i"} → click su un day-type per applicarlo`
            : "Seleziona giorni cliccando sull'header (Ctrl/Shift per più giorni)"}
        </div>
      </div>

      <div className="flex-1 overflow-auto p-2 space-y-1.5">
        {dayTypes.length === 0 && (
          <div className="text-xs text-slate-400 italic p-2">Nessun day-type</div>
        )}
        {dayTypes.map((dt) => {
          const disabled = selectedCount === 0 || !canEdit;
          return (
            <button
              key={dt.id}
              type="button"
              disabled={disabled}
              onClick={() => onApply(dt.id)}
              className={`w-full flex items-center gap-2 px-2 py-2 rounded-lg border text-left text-sm transition ${
                disabled
                  ? "bg-white border-slate-200 text-slate-400 cursor-not-allowed"
                  : "bg-white border-slate-300 text-slate-800 hover:border-blue-500 hover:shadow-sm cursor-pointer"
              }`}
              title={disabled ? "Seleziona prima dei giorni" : `Applica '${dt.name}' a ${selectedCount} giorn${selectedCount === 1 ? "o" : "i"}`}
            >
              <span
                className="w-5 h-5 rounded-md ring-2 ring-white shadow-sm shrink-0"
                style={{ backgroundColor: dt.color }}
              />
              <div className="flex-1 min-w-0">
                <div className="font-medium truncate">{dt.name}</div>
                <div className="text-[10px] text-slate-500 font-mono truncate">{dt.code}</div>
              </div>
            </button>
          );
        })}
      </div>

      {/* Quick-add */}
      {canEdit && (
        <div className="border-t bg-white p-2">
          {!showAdd ? (
            <div className="flex gap-1.5">
              <button
                type="button"
                onClick={() => setShowAdd(true)}
                className="flex-1 px-2 py-1.5 text-xs rounded border border-emerald-400 bg-emerald-50 text-emerald-800 hover:bg-emerald-100 font-medium"
              >
                + Nuovo day-type
              </button>
              <button
                type="button"
                onClick={openAdvanced}
                className="px-2 py-1.5 text-xs rounded border border-slate-300 bg-white text-slate-700 hover:bg-slate-100"
                title="Editor avanzato (modifica/elimina)"
              >
                ⚙
              </button>
            </div>
          ) : (
            <div className="space-y-1.5">
              <input
                value={newCode}
                onChange={(e) => setNewCode(e.target.value.toUpperCase().slice(0, 16))}
                placeholder="CODICE (es. FER)"
                className="w-full border rounded px-2 py-1 text-xs font-mono"
              />
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Nome (es. Feriale)"
                className="w-full border rounded px-2 py-1 text-xs"
              />
              <div className="flex items-center gap-1.5">
                <input
                  type="color"
                  value={newColor}
                  onChange={(e) => setNewColor(e.target.value)}
                  className="w-8 h-7 border rounded cursor-pointer"
                />
                <button
                  type="button"
                  disabled={!newCode.trim() || !newName.trim() || createMut.isPending}
                  onClick={() => createMut.mutate()}
                  className="flex-1 px-2 py-1 text-xs rounded bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 font-medium"
                >
                  {createMut.isPending ? "…" : "Crea"}
                </button>
                <button
                  type="button"
                  onClick={() => setShowAdd(false)}
                  className="px-2 py-1 text-xs rounded border border-slate-300 hover:bg-slate-100"
                >
                  ✕
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </aside>
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

/* ════════════════════════════════════════════════════════════════════
   ValiditySidebar — tab Day-Types | Categorie
   ════════════════════════════════════════════════════════════════════ */
function ValiditySidebar(props: {
  dayTypes: PsDayType[];
  selectedCount: number;
  onApplyDayType: (id: string) => void;
  openDayTypeAdvanced: () => void;
}) {
  return (
    <aside className="w-64 border-l bg-white flex flex-col">
      <div className="px-3 py-2 border-b bg-slate-50">
        <div className="text-xs font-bold uppercase tracking-wide text-slate-700">Giorni-Tipo</div>
      </div>
      <div className="flex-1 overflow-auto p-3">
        <DayTypesPanel
          dayTypes={props.dayTypes}
          selectedCount={props.selectedCount}
          onApply={(id) => id && props.onApplyDayType(id)}
          onManage={props.openDayTypeAdvanced}
        />
      </div>
    </aside>
  );
}

function DayTypesPanel(props: {
  dayTypes: PsDayType[];
  selectedCount: number;
  onApply: (id: string | null) => void;
  onManage: () => void;
}) {
  const hasSel = props.selectedCount > 0;
  return (
    <div className="space-y-2">
      <div className="text-xs uppercase tracking-wide text-slate-700 font-semibold px-1">
        Giorni-Tipo
        {hasSel && <span className="ml-2 text-blue-700 font-bold">({props.selectedCount} sel.)</span>}
      </div>
      <div className="space-y-1">
        {props.dayTypes.map((dt) => (
          <button
            key={dt.id}
            disabled={!hasSel}
            onClick={() => props.onApply(dt.id)}
            className="w-full flex items-center gap-2 px-2 py-1.5 rounded border bg-white hover:bg-slate-100 text-sm text-slate-900 font-medium disabled:opacity-50 disabled:cursor-not-allowed"
            title={hasSel ? `Applica "${dt.name}" alle date selezionate` : "Seleziona prima delle celle"}
          >
            <span className="inline-block h-3 w-3 rounded" style={{ backgroundColor: dt.color || "#94a3b8" }} />
            <span className="truncate">{dt.name}</span>
          </button>
        ))}
      </div>
      <button
        onClick={props.onManage}
        className="w-full mt-2 px-2 py-1.5 text-xs rounded border bg-slate-100 hover:bg-slate-200 text-slate-800 font-medium"
      >
        Gestisci giorni-tipo…
      </button>
      {!hasSel && (
        <div className="text-[12px] text-slate-700 px-1 pt-2 leading-snug">
          Suggerimento: clicca sull'<strong>header data</strong> (in alto) per selezionare giorni, poi clicca un giorno-tipo per applicarlo.
        </div>
      )}
    </div>
  );
}

function CategoryEditorDialog(props: {
  onClose: () => void;
  categories: PsValidityCategory[];
}) {
  const qc = useQueryClient();
  const [draftName, setDraftName] = useState("");
  const [draftCode, setDraftCode] = useState("");
  const [draftColor, setDraftColor] = useState("#6366f1");

  const createMut = useMutation({
    mutationFn: () =>
      createPsValidityCategory({
        code: draftCode.trim() || draftName.trim().toLowerCase().replace(/\s+/g, "_"),
        name: draftName.trim(),
        color: draftColor,
      }),
    onSuccess: () => {
      setDraftName("");
      setDraftCode("");
      setDraftColor("#6366f1");
      qc.invalidateQueries({ queryKey: ["validity-categories"] });
    },
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-3 border-b">
          <div className="font-medium">Categorie Validità (globali)</div>
          <button onClick={props.onClose} className="p-1 hover:bg-slate-100 rounded">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 overflow-auto p-4 space-y-2">
          {props.categories.map((c) => (
            <CategoryRow key={c.id} category={c} />
          ))}
          {props.categories.length === 0 && (
            <div className="text-sm text-slate-500">Nessuna categoria. Creane una qui sotto.</div>
          )}
        </div>
        <div className="border-t p-3 bg-slate-50 space-y-2">
          <div className="text-xs uppercase tracking-wide text-slate-500">Nuova categoria</div>
          <div className="flex items-center gap-2">
            <input
              type="text"
              placeholder="Nome (es. Scuole Aperte)"
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              className="flex-1 px-2 py-1 text-sm border rounded"
            />
            <input
              type="text"
              placeholder="code"
              value={draftCode}
              onChange={(e) => setDraftCode(e.target.value)}
              className="w-32 px-2 py-1 text-sm border rounded"
            />
            <input
              type="color"
              value={draftColor}
              onChange={(e) => setDraftColor(e.target.value)}
              className="h-8 w-10 border rounded"
            />
            <button
              onClick={() => createMut.mutate()}
              disabled={!draftName.trim() || createMut.isPending}
              className="px-3 py-1.5 text-sm rounded bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {createMut.isPending ? "…" : "Crea"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function CategoryRow({ category }: { category: PsValidityCategory }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(category.name);
  const [color, setColor] = useState(category.color || "#6366f1");

  const updateMut = useMutation({
    mutationFn: () => updatePsValidityCategory(category.id, { name, color }),
    onSuccess: () => {
      setEditing(false);
      qc.invalidateQueries({ queryKey: ["validity-categories"] });
    },
  });
  const deleteMut = useMutation({
    mutationFn: () => deletePsValidityCategory(category.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["validity-categories"] });
      qc.invalidateQueries({ queryKey: ["validity-category-calendar"] });
    },
  });

  return (
    <div className="flex items-center gap-2 border rounded px-2 py-1.5 bg-white">
      <span className="inline-block h-4 w-4 rounded" style={{ backgroundColor: color }} />
      {editing ? (
        <>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="flex-1 px-2 py-0.5 text-sm border rounded"
          />
          <input
            type="color"
            value={color}
            onChange={(e) => setColor(e.target.value)}
            className="h-6 w-8 border rounded"
          />
          <button
            onClick={() => updateMut.mutate()}
            disabled={updateMut.isPending}
            className="px-2 py-0.5 text-xs rounded bg-indigo-600 text-white"
          >
            Salva
          </button>
          <button onClick={() => setEditing(false)} className="px-2 py-0.5 text-xs rounded border">
            Annulla
          </button>
        </>
      ) : (
        <>
          <div className="flex-1 text-sm">
            <span className="font-medium">{category.name}</span>{" "}
            <span className="text-xs text-slate-500">({category.code})</span>
          </div>
          <button onClick={() => setEditing(true)} className="px-2 py-0.5 text-xs rounded border">
            Modifica
          </button>
          <button
            onClick={() => {
              if (confirm(`Eliminare la categoria "${category.name}"?`)) deleteMut.mutate();
            }}
            disabled={deleteMut.isPending}
            className="px-2 py-0.5 text-xs rounded border text-rose-700 hover:bg-rose-50"
          >
            Elimina
          </button>
        </>
      )}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════
   ComputeUnitsDialog — calcolo & salvataggio Unità di Progettazione
   ════════════════════════════════════════════════════════════════════ */
function ComputeUnitsDialog(props: {
  onClose: () => void;
  onSaved: () => void;
  projectId: string;
  range: { from: string; to: string };
}) {
  const [from, setFrom] = useState(props.range.from);
  const [to, setTo] = useState(props.range.to);
  const [groups, setGroups] = useState<PsValidityUnitComputed[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [names, setNames] = useState<Record<string, string>>({});

  useEffect(() => {
    setFrom(props.range.from);
    setTo(props.range.to);
    setGroups(null);
    setSelected(new Set());
    setNames({});
  }, [props.range.from, props.range.to]);

  const computeMut = useMutation({
    mutationFn: () => computePsValidityUnits(props.projectId, { from, to }),
    onSuccess: (res) => {
      setGroups(res.units);
      const all = new Set<string>(res.units.map((g) => g.validityId));
      setSelected(all);
      const n: Record<string, string> = {};
      for (const g of res.units) {
        const cat = g.categoryName ?? "Generico";
        const dt = g.dayTypeName ?? "—";
        n[g.validityId] = `${cat} · ${dt} (${g.tripCount} corse)`;
      }
      setNames(n);
    },
  });

  const saveMut = useMutation({
    mutationFn: () => {
      const items = (groups ?? [])
        .filter((g) => selected.has(g.validityId))
        .map((g) => ({
          validityId: g.validityId,
          name: names[g.validityId] || `Unità ${g.validityId.slice(0, 8)}`,
          categoryId: g.categoryId,
          dayTypeId: g.dayTypeId,
          tripIds: g.tripIds,
          dates: g.dates,
          dayCount: g.dates.length,
          tripCount: g.tripIds.length,
        }));
      return savePsValidityUnits(props.projectId, items);
    },
    onSuccess: () => {
      props.onSaved();
    },
  });

  const toggleAll = () => {
    if (!groups) return;
    if (selected.size === groups.length) setSelected(new Set());
    else setSelected(new Set(groups.map((g) => g.validityId)));
  };
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-3xl max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-3 border-b">
          <div className="font-medium flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-indigo-600" />
            Calcola Unità di Progettazione
          </div>
          <button onClick={props.onClose} className="p-1 hover:bg-slate-100 rounded">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="px-5 py-3 border-b bg-slate-50 flex items-end gap-2">
          <label className="text-xs text-slate-600">
            Dal
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="block px-2 py-1 text-sm border rounded"
            />
          </label>
          <label className="text-xs text-slate-600">
            Al
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="block px-2 py-1 text-sm border rounded"
            />
          </label>
          <button
            onClick={() => computeMut.mutate()}
            disabled={!from || !to || computeMut.isPending}
            className="px-3 py-1.5 text-sm rounded bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 flex items-center gap-1.5"
          >
            {computeMut.isPending && <Loader2 className="h-3 w-3 animate-spin" />}
            Calcola
          </button>
          {groups && (
            <div className="ml-auto text-xs text-slate-600">
              {groups.length} gruppi · {selected.size} selezionati
            </div>
          )}
        </div>
        <div className="flex-1 overflow-auto p-3">
          {!groups && !computeMut.isPending && (
            <div className="text-sm text-slate-500 px-2 py-6 text-center">
              Imposta il range e clicca <strong>Calcola</strong>. Le corse attive di ogni giorno verranno raggruppate per
              categoria + giorno-tipo + composizione corse.
            </div>
          )}
          {computeMut.isPending && (
            <div className="text-sm text-slate-500 px-2 py-6 text-center flex items-center justify-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              Calcolo in corso…
            </div>
          )}
          {groups && groups.length === 0 && (
            <div className="text-sm text-slate-500 px-2 py-6 text-center">
              Nessun gruppo trovato nel range selezionato.
            </div>
          )}
          {groups && groups.length > 0 && (
            <table className="w-full text-sm">
              <thead className="text-xs text-slate-500 uppercase tracking-wide">
                <tr>
                  <th className="px-2 py-1 text-left">
                    <input
                      type="checkbox"
                      checked={selected.size === groups.length}
                      onChange={toggleAll}
                    />
                  </th>
                  <th className="px-2 py-1 text-left">Nome</th>
                  <th className="px-2 py-1 text-left">Categoria</th>
                  <th className="px-2 py-1 text-left">Giorno-Tipo</th>
                  <th className="px-2 py-1 text-right">Giorni</th>
                  <th className="px-2 py-1 text-right">Corse</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => (
                  <tr key={g.validityId} className="border-t hover:bg-slate-50">
                    <td className="px-2 py-1.5">
                      <input
                        type="checkbox"
                        checked={selected.has(g.validityId)}
                        onChange={() => toggle(g.validityId)}
                      />
                    </td>
                    <td className="px-2 py-1.5">
                      <input
                        type="text"
                        value={names[g.validityId] ?? ""}
                        onChange={(e) => setNames({ ...names, [g.validityId]: e.target.value })}
                        className="w-full px-2 py-0.5 text-sm border rounded"
                      />
                    </td>
                    <td className="px-2 py-1.5">
                      {g.categoryName ? (
                        <span
                          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs"
                          style={{ backgroundColor: (g.categoryColor || "#94a3b8") + "33" }}
                        >
                          <span
                            className="inline-block h-2 w-2 rounded"
                            style={{ backgroundColor: g.categoryColor || "#94a3b8" }}
                          />
                          {g.categoryName}
                        </span>
                      ) : (
                        <span className="text-xs text-slate-400">—</span>
                      )}
                    </td>
                    <td className="px-2 py-1.5">
                      {g.dayTypeName ? (
                        <span
                          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs"
                          style={{ backgroundColor: (g.dayTypeColor || "#94a3b8") + "33" }}
                        >
                          <span
                            className="inline-block h-2 w-2 rounded"
                            style={{ backgroundColor: g.dayTypeColor || "#94a3b8" }}
                          />
                          {g.dayTypeName}
                        </span>
                      ) : (
                        <span className="text-xs text-slate-400">—</span>
                      )}
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{g.dates.length}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{g.tripIds.length}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="border-t px-5 py-3 flex justify-end gap-2 bg-slate-50">
          <button onClick={props.onClose} className="px-3 py-1.5 text-sm rounded border bg-white">
            Annulla
          </button>
          <button
            onClick={() => saveMut.mutate()}
            disabled={!groups || selected.size === 0 || saveMut.isPending}
            className="px-3 py-1.5 text-sm rounded bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 flex items-center gap-1.5"
          >
            {saveMut.isPending && <Loader2 className="h-3 w-3 animate-spin" />}
            <Save className="h-3.5 w-3.5" />
            Salva {selected.size} unità
          </button>
        </div>
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════
   CategoryPeriodsDialog — calendario mensile per dipingere giorni
   con una "Categoria Periodo" (Scuole Aperte, Festività, ecc.).
   Sostituisce la sidebar tab "Categorie" con un'esperienza più chiara.
   ════════════════════════════════════════════════════════════════════ */
function CategoryPeriodsDialog(props: {
  onClose: () => void;
  categories: PsValidityCategory[];
  openCategoryEditor: () => void;
}) {
  const qc = useQueryClient();
  const today = new Date();
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth()); // 0..11
  const [activeCategoryId, setActiveCategoryId] = useState<string | null>(
    props.categories[0]?.id ?? null,
  );
  const [paintMode, setPaintMode] = useState<"paint" | "erase">("paint");

  // Calcola first/last del mese
  const firstISO = useMemo(() => `${year}-${String(month + 1).padStart(2, "0")}-01`, [year, month]);
  const lastDay = useMemo(() => new Date(year, month + 1, 0).getDate(), [year, month]);
  const lastISO = useMemo(() => `${year}-${String(month + 1).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`, [year, month, lastDay]);

  const calQ = useQuery({
    queryKey: ["ps-validity-categories", "calendar", firstISO, lastISO],
    queryFn: () => listPsValidityCategoryCalendar({ from: firstISO, to: lastISO }),
  });

  const dateToCatId = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of calQ.data ?? []) m.set(e.date, e.categoryId);
    return m;
  }, [calQ.data]);

  const catById = useMemo(() => {
    const m = new Map<string, PsValidityCategory>();
    for (const c of props.categories) m.set(c.id, c);
    return m;
  }, [props.categories]);

  const setMut = useMutation({
    mutationFn: (input: { dates: string[]; categoryId: string | null }) =>
      setPsValidityCategoryCalendar(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ps-validity-categories", "calendar"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  /* ─── Paint immediato ───
   * - Click semplice:
   *     · paintMode='erase' → rimuove la categoria (se presente)
   *     · paintMode='paint' & cella ha la stessa categoria attiva → toggle off (rimuove)
   *     · paintMode='paint' & cella vuota o diversa → set/aggiorna alla categoria attiva
   * - SHIFT+Click su iso2 con anchor=iso1: applica la stessa azione a tutto il range
   *   (forza set della categoria attiva o erase, senza toggle).
   */
  const [anchorISO, setAnchorISO] = useState<string | null>(null);

  const handleDayClick = (iso: string, e: ReactMouseEvent) => {
    // SHIFT+Click → range
    if (e.shiftKey && anchorISO) {
      const a = anchorISO < iso ? anchorISO : iso;
      const b = anchorISO < iso ? iso : anchorISO;
      const out: string[] = [];
      const start = new Date(a + "T00:00:00");
      const end = new Date(b + "T00:00:00");
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        out.push(d.toISOString().slice(0, 10));
      }
      const target =
        paintMode === "erase" ? null : (activeCategoryId ?? null);
      if (target === undefined) return;
      if (paintMode === "paint" && !activeCategoryId) {
        toast.error("Seleziona prima una categoria a sinistra");
        return;
      }
      setMut.mutate(
        { dates: out, categoryId: target },
        {
          onSuccess: () => {
            const verb = target === null ? "rimossa da" : "applicata a";
            toast.success(`Categoria ${verb} ${out.length} giorni`);
          },
        },
      );
      setAnchorISO(iso);
      return;
    }

    // Click singolo
    setAnchorISO(iso);
    const currentCatId = dateToCatId.get(iso);

    if (paintMode === "erase") {
      if (!currentCatId) return; // nulla da fare
      setMut.mutate({ dates: [iso], categoryId: null });
      return;
    }
    // paintMode === "paint"
    if (!activeCategoryId) {
      toast.error("Seleziona prima una categoria a sinistra");
      return;
    }
    if (currentCatId === activeCategoryId) {
      // Stessa categoria → toggle off
      setMut.mutate({ dates: [iso], categoryId: null });
    } else {
      // Vuota o diversa → applica/aggiorna
      setMut.mutate({ dates: [iso], categoryId: activeCategoryId });
    }
  };

  // Costruisci la griglia 7 colonne (Lun-Dom)
  const firstWeekday = useMemo(() => {
    const d = new Date(year, month, 1).getDay(); // 0=Dom
    return (d + 6) % 7; // 0=Lun .. 6=Dom
  }, [year, month]);
  const todayISOStr = useMemo(() => {
    const t = new Date();
    return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
  }, []);
  const cells: Array<{ iso: string; day: number; weekend: boolean; isToday: boolean } | null> = [];
  for (let i = 0; i < firstWeekday; i++) cells.push(null);
  for (let d = 1; d <= lastDay; d++) {
    const iso = `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const dow = new Date(year, month, d).getDay();
    cells.push({ iso, day: d, weekend: dow === 0 || dow === 6, isToday: iso === todayISOStr });
  }
  while (cells.length % 7 !== 0) cells.push(null);

  const monthName = new Date(year, month, 1).toLocaleDateString("it-IT", { month: "long", year: "numeric" });

  const goPrev = () => {
    if (month === 0) { setYear((y) => y - 1); setMonth(11); }
    else setMonth((m) => m - 1);
  };
  const goNext = () => {
    if (month === 11) { setYear((y) => y + 1); setMonth(0); }
    else setMonth((m) => m + 1);
  };
  const goToday = () => {
    const t = new Date();
    setYear(t.getFullYear());
    setMonth(t.getMonth());
  };

  const activeCat = activeCategoryId ? catById.get(activeCategoryId) : undefined;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-6xl max-h-[92vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b bg-gradient-to-r from-fuchsia-50 to-violet-50">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-fuchsia-500 to-violet-600 flex items-center justify-center shadow-md">
              <CalendarIcon className="h-5 w-5 text-white" />
            </div>
            <div>
              <div className="font-bold text-slate-900 text-lg">Categorie Periodi</div>
              <div className="text-xs text-slate-600">
                Attiva una categoria a sinistra, poi clicca i giorni per dipingerli. Riclicca per togliere.
              </div>
            </div>
          </div>
          <button onClick={props.onClose} className="p-2 hover:bg-white/70 rounded-lg transition-colors">
            <X className="h-5 w-5 text-slate-700" />
          </button>
        </div>

        <div className="flex-1 overflow-hidden flex">
          {/* SIDEBAR sinistra: lista categorie */}
          <div className="w-72 border-r bg-slate-50 flex flex-col">
            <div className="px-4 py-3 border-b bg-white">
              <div className="text-xs font-bold uppercase tracking-wide text-slate-700 mb-1">Pennello attivo</div>
              {paintMode === "paint" && activeCat ? (
                <div className="flex items-center gap-2 mt-1">
                  <span className="inline-block h-5 w-5 rounded shadow-sm" style={{ backgroundColor: activeCat.color }} />
                  <span className="text-sm font-semibold text-slate-900 truncate">{activeCat.name}</span>
                </div>
              ) : paintMode === "erase" ? (
                <div className="flex items-center gap-2 mt-1 text-rose-700">
                  <Eraser className="h-4 w-4" />
                  <span className="text-sm font-semibold">Gomma</span>
                </div>
              ) : (
                <div className="text-xs text-slate-500 italic mt-1">Nessuna categoria selezionata</div>
              )}
            </div>
            <div className="flex-1 overflow-auto p-3 space-y-1.5">
              {props.categories.length === 0 && (
                <div className="text-sm text-slate-600 px-2 py-3 text-center">
                  Nessuna categoria.<br />Creane una qui sotto.
                </div>
              )}
              {props.categories.map((c) => {
                const isActive = activeCategoryId === c.id && paintMode === "paint";
                return (
                  <button
                    key={c.id}
                    onClick={() => { setActiveCategoryId(c.id); setPaintMode("paint"); }}
                    className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg border text-sm font-medium transition-all ${
                      isActive
                        ? "bg-white border-fuchsia-500 ring-2 ring-fuchsia-200 text-slate-900 shadow-sm"
                        : "bg-white border-slate-200 hover:border-slate-300 hover:shadow-sm text-slate-800"
                    }`}
                  >
                    <span className="inline-block h-5 w-5 rounded shadow-sm shrink-0" style={{ backgroundColor: c.color || "#94a3b8" }} />
                    <span className="truncate flex-1 text-left">{c.name}</span>
                    {isActive && <Check className="h-4 w-4 text-fuchsia-600 shrink-0" />}
                  </button>
                );
              })}
              <button
                onClick={() => setPaintMode("erase")}
                className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg border text-sm font-medium mt-3 transition-all ${
                  paintMode === "erase"
                    ? "bg-rose-50 border-rose-500 ring-2 ring-rose-200 text-rose-900 shadow-sm"
                    : "bg-white border-slate-200 hover:border-rose-300 hover:bg-rose-50/50 text-rose-700"
                }`}
              >
                <Eraser className="h-4 w-4 shrink-0" />
                <span className="truncate flex-1 text-left">Gomma (cancella)</span>
                {paintMode === "erase" && <Check className="h-4 w-4 text-rose-600 shrink-0" />}
              </button>
            </div>
            <div className="border-t p-3 bg-white">
              <button
                onClick={props.openCategoryEditor}
                className="w-full px-3 py-2 text-xs rounded-lg border bg-white hover:bg-slate-50 text-slate-800 font-semibold flex items-center gap-1.5 justify-center shadow-sm"
              >
                <Settings2 className="h-3.5 w-3.5" />
                Gestisci categorie…
              </button>
            </div>
          </div>

          {/* CALENDARIO mensile */}
          <div className="flex-1 flex flex-col overflow-hidden bg-white">
            <div className="flex items-center justify-between px-5 py-3 border-b bg-white">
              <div className="flex items-center gap-2">
                <button onClick={goPrev} className="px-3 py-1.5 text-sm rounded-lg border bg-white hover:bg-slate-100 text-slate-700 font-medium">‹</button>
                <button onClick={goToday} className="px-3 py-1.5 text-xs rounded-lg border bg-white hover:bg-slate-100 text-slate-700 font-semibold">Oggi</button>
                <button onClick={goNext} className="px-3 py-1.5 text-sm rounded-lg border bg-white hover:bg-slate-100 text-slate-700 font-medium">›</button>
                <div className="ml-3 text-lg font-bold text-slate-900 capitalize">{monthName}</div>
              </div>
              <div className="text-xs text-slate-600 flex items-center gap-3">
                <span>
                  Click = applica/togli · <kbd className="px-1.5 py-0.5 bg-slate-100 border rounded text-slate-900 text-[10px] font-mono">SHIFT</kbd>+Click = range
                </span>
                {setMut.isPending && (
                  <span className="text-xs text-fuchsia-700 font-semibold flex items-center gap-1">
                    <Loader2 className="h-3 w-3 animate-spin" /> salvo…
                  </span>
                )}
              </div>
            </div>

            <div className="flex-1 overflow-auto p-5 bg-gradient-to-b from-slate-50/50 to-white">
              {/* Intestazione giorni della settimana */}
              <div className="grid grid-cols-7 gap-2 mb-2">
                {["Lun", "Mar", "Mer", "Gio", "Ven", "Sab", "Dom"].map((g, i) => (
                  <div key={g} className={`text-center text-[11px] font-bold uppercase tracking-wider py-1.5 ${i >= 5 ? "text-rose-600" : "text-slate-600"}`}>
                    {g}
                  </div>
                ))}
              </div>
              <div className="grid grid-cols-7 gap-2">
                {cells.map((c, idx) => {
                  if (!c) return <div key={`e-${idx}`} className="h-24 bg-transparent" />;
                  const catId = dateToCatId.get(c.iso);
                  const cat = catId ? catById.get(catId) : undefined;
                  const bg = cat?.color ? `${cat.color}33` : undefined; // ~20% opacity
                  const ringColor = cat?.color;
                  const wouldRemove =
                    paintMode === "paint" &&
                    cat && activeCategoryId === cat.id;
                  return (
                    <button
                      key={c.iso}
                      onClick={(e) => handleDayClick(c.iso, e)}
                      disabled={setMut.isPending}
                      className={`group relative h-24 rounded-xl border text-left p-2 transition-all hover:shadow-lg hover:-translate-y-0.5 active:translate-y-0 ${
                        c.weekend && !cat ? "bg-rose-50/40" : !cat ? "bg-white" : ""
                      } ${cat ? "border-2 shadow-sm" : "border-slate-200"} ${
                        c.isToday ? "ring-2 ring-blue-400 ring-offset-1" : ""
                      } disabled:opacity-50 disabled:cursor-wait`}
                      style={cat ? { backgroundColor: bg, borderColor: ringColor } : undefined}
                      title={cat ? `${c.iso} · ${cat.name}${wouldRemove ? "\n(click per togliere)" : ""}` : `${c.iso} · nessuna categoria`}
                    >
                      <div className="flex items-start justify-between">
                        <span className={`text-base font-bold leading-none ${
                          c.isToday ? "text-blue-700" :
                          c.weekend ? "text-rose-700" : "text-slate-900"
                        }`}>{c.day}</span>
                        {c.isToday && (
                          <span className="text-[9px] font-bold text-blue-700 bg-blue-100 rounded px-1 py-0.5 leading-none">OGGI</span>
                        )}
                      </div>
                      {cat && (
                        <div className="mt-2 flex items-center gap-1">
                          <span
                            className="inline-block h-2.5 w-2.5 rounded-full shrink-0"
                            style={{ backgroundColor: cat.color }}
                          />
                          <span
                            className="text-[10px] font-semibold truncate"
                            style={{ color: cat.color }}
                          >
                            {cat.name}
                          </span>
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Legenda */}
            {props.categories.length > 0 && (
              <div className="border-t px-5 py-2.5 bg-slate-50/80 flex items-center gap-4 flex-wrap">
                <span className="text-xs font-bold uppercase tracking-wide text-slate-600">Legenda:</span>
                {props.categories.map((c) => (
                  <span key={c.id} className="inline-flex items-center gap-1.5 text-xs text-slate-800 font-medium">
                    <span className="inline-block h-3 w-3 rounded shadow-sm" style={{ backgroundColor: c.color }} />
                    {c.name}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="border-t px-6 py-3 flex justify-end gap-2 bg-slate-50">
          <button
            onClick={props.onClose}
            className="px-4 py-2 text-sm rounded-lg bg-slate-800 text-white hover:bg-slate-900 font-semibold shadow-sm"
          >
            Chiudi
          </button>
        </div>
      </div>
    </div>
  );
}
