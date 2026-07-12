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
import { apiFetch } from "@/lib/api";
import {
  ArrowLeft, Calendar as CalendarIcon, Loader2, Undo2, Redo2,
  Palette, Plus, Trash2, Check, X, Settings2, Wand2, Eraser, Layers, Rocket,
  Sparkles, Save, Tags, ChevronLeft, ChevronRight,
} from "lucide-react";
import {
  getPsValidityMatrix, upsertPsTripException, deletePsTripExceptionMatrix,
  upsertPsDayCalendar, upsertPsTripDayValidity,
  listPsDayTypes, createPsDayType, updatePsDayType, deletePsDayType,
  autoImportPsValidityFromCalendars,
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
  type PsValidityCategory, type PsValidityUnitComputed, type PsValidityUnitsCoverage,
} from "@/lib/planning-studio-validity-units-api";
import {
  getPsProject, type PsProject,
} from "@/lib/planning-studio-api";
import {
  getCellValidity, inferDefaultDayType,
  type DayType as AlgoDayType, type Trip as AlgoTrip, type MatrixContext,
} from "@/lib/planning-studio/validity-matrix";
import ValiditySectionNav from "./ValiditySectionNav";

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
  tripId: string;              // rappresentante (per stato/undo)
  /** Tutte le corse a cui applicare (corse fuse identiche). Default: [tripId]. */
  tripIds?: string[];
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
  /* ─── Filtri vista (richiesti): ricerca linee + criterio Calendario aziendale ─── */
  const [lineFilter, setLineFilter] = useState<string>("");
  const [calCriterion, setCalCriterion] = useState<string>(""); // "" = tutti i giorni

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

  // Progetti grandi (oltre il cap del backend): matrice SOLO per linea, senza
  // nemmeno tentare la chiamata non filtrata (evita i 400 "too many trips").
  const MATRIX_TRIP_CAP = 2000;
  const projectTrips = projectQ.data?.counts?.trips ?? null;
  const bigProject = projectTrips != null && projectTrips > MATRIX_TRIP_CAP;

  const matrixQ = useQuery({
    queryKey: ["ps", projectId, "validity", "matrix", from, to, routeId],
    queryFn: () => getPsValidityMatrix(projectId, { from, to, routeId }),
    // attende i counts del progetto; se grande, parte solo con una linea scelta
    enabled: !!projectId && projectTrips != null && (!bigProject || !!routeId),
    retry: false, // l'errore "too many trips" non va riprovato
  });

  // Diagnostica errore matrice → suggerimento "scegli una linea"
  const matrixErrBody = (matrixQ.error as any)?.body as
    | { error?: string; tripCount?: number; maxTripsPerPage?: number; needsRouteFilter?: boolean }
    | undefined;
  const needsRouteFilter = bigProject || !!matrixErrBody?.needsRouteFilter;

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

  /* ─── Classificazione giorni (Calendario aziendale) per il range visibile ─── */
  const dayClassQ = useQuery({
    queryKey: ["ps", projectId, "day-classification", from, to],
    queryFn: () => apiFetch<{ days: Array<{ date: string; level1: string; level2: string | null }> }>(
      `/api/planning-studio/projects/${projectId}/day-classification?from=${from}&to=${to}`),
    enabled: !!projectId,
  });
  const leafByDate = useMemo(() => {
    const m = new Map<string, { level1: string; level2: string | null }>();
    for (const d of dayClassQ.data?.days ?? []) m.set(d.date, { level1: d.level1, level2: d.level2 });
    return m;
  }, [dayClassQ.data]);
  // criterio → predicato sulla foglia del Calendario aziendale
  const matchesCriterion = useCallback((date: string): boolean => {
    if (!calCriterion) return true;
    const l = leafByDate.get(date);
    if (!l) return false;
    switch (calCriterion) {
      case "scuole_aperte": return l.level1 === "scuole_aperte";
      case "scuole_chiuse": return l.level1 === "scuole_chiuse";
      case "estivo": return l.level1 === "scuole_chiuse" && l.level2 === "estivo";
      case "invernale": return l.level1 === "scuole_chiuse" && l.level2 === "invernale";
      case "domeniche": return l.level1 === "festivo" && (l.level2 === "domenica_aperte" || l.level2 === "domenica_chiuse");
      case "festivi": return l.level1 === "festivo";
      default: return true;
    }
  }, [calCriterion, leafByDate]);

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

  /* ─── Algorithm context (memoizzato) ─── */
  const ctx = useMemo<MatrixContext | null>(() => {
    if (!matrixQ.data) return null;
    const c = buildAlgoContext(matrixQ.data);
    // Vincolo categorie (calendario aziendale): giorno→categoria + set per corsa.
    const dc = new Map<string, string>();
    for (const [d, catObj] of categoryByDate) dc.set(d, catObj.id);
    c.dayCategory = dc;
    const tc = new Map<string, Set<string>>();
    for (const r of matrixQ.data.tripCategoryValidity ?? []) {
      if (!tc.has(r.tripId)) tc.set(r.tripId, new Set());
      tc.get(r.tripId)!.add(r.categoryId);
    }
    c.tripCategories = tc;
    // maschera giorni-settimana per corsa (attributes.weekdays)
    const tw = new Map<string, boolean[]>();
    for (const t of matrixQ.data.trips) {
      if (Array.isArray(t.weekdays) && t.weekdays.length === 7) tw.set(t.id, t.weekdays);
    }
    c.tripWeekdays = tw;
    // id categoria → code: abilita l'ombrello scuole_chiuse in getCellValidity
    const codeById = new Map<string, string>();
    for (const cat of (categoriesQ.data ?? [])) codeById.set(cat.id, cat.code);
    c.categoryCodeById = codeById;
    return c;
  }, [matrixQ.data, categoryByDate, categoriesQ.data]);

  const allDates = useMemo(() => isoRange(from, to), [from, to]);
  // Filtro colonne per criterio del Calendario aziendale (scuole aperte/chiuse…)
  const dates = useMemo(
    // mentre la classificazione carica (leafByDate vuota) non filtriamo, per
    // non mostrare una matrice vuota a lampo.
    () => (calCriterion && leafByDate.size > 0 ? allDates.filter(matchesCriterion) : allDates),
    [allDates, calCriterion, matchesCriterion, leafByDate],
  );

  /* ─── Trips raggruppate per route + FUSIONE corse identiche (+ filtro ricerca) ───
   * Fondiamo in una sola riga le corse DAVVERO identiche: stessa linea/variante/
   * direzione/orario/percorso E stessa validità (day-type + eccezioni). Così le
   * corse duplicate (stesso 05:14 ripetuto) diventano 1 riga; le modifiche sulla
   * riga si applicano a tutte le corse fuse (mergeMembers). Corse che differiscono
   * per giorni di servizio NON vengono fuse (restano righe distinte). */
  const { groups, mergeMembers } = useMemo(() => {
    const members = new Map<string, string[]>(); // repId → [memberIds]
    if (!matrixQ.data) return { groups: [] as { route: PsValidityTrip; trips: PsValidityTrip[] }[], mergeMembers: members };
    // Corse IDENTICHE = stessa linea + stessa variante/direzione + stesso orario di
    // partenza. La validità NON conta: le corse duplicate diventano 1 riga e i
    // bollini verdi accendono l'UNIONE dei giorni attivi dei GTFS fusi.
    const sig = (t: PsValidityTrip) =>
      [t.routeId, t.variantId, t.direction, t.firstDeparture].join("§");
    const byRoute = new Map<string, PsValidityTrip[]>();
    for (const t of matrixQ.data.trips) {
      if (!byRoute.has(t.routeId)) byRoute.set(t.routeId, []);
      byRoute.get(t.routeId)!.push(t);
    }
    let arr = Array.from(byRoute.values()).map((trips) => {
      const repBySig = new Map<string, PsValidityTrip>();
      const merged: PsValidityTrip[] = [];
      for (const t of trips) {
        const k = sig(t);
        const rep = repBySig.get(k);
        if (rep) { members.get(rep.id)!.push(t.id); }
        else { repBySig.set(k, t); merged.push(t); members.set(t.id, [t.id]); }
      }
      return { route: merged[0], trips: merged };
    });
    const q = lineFilter.trim().toLowerCase();
    if (q) {
      arr = arr.filter((g) =>
        `${g.route.routeShortName ?? ""} ${g.route.routeLongName ?? ""}`.toLowerCase().includes(q));
    }
    return { groups: arr, mergeMembers: members };
  }, [matrixQ.data, lineFilter, ctx]);

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
  /* ─── Scroll orizzontale della matrice (◀ ▶) ─── */
  const scrollH = useCallback((dir: -1 | 1) => {
    const el = scrollerRef.current;
    if (!el) return;
    // scorre di ~80% della larghezza visibile (oltre la colonna sticky)
    el.scrollBy({ left: dir * Math.max(200, (el.clientWidth - STICKY_W) * 0.8), behavior: "smooth" });
  }, []);
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
    const ids = a.tripIds && a.tripIds.length > 0 ? a.tripIds : [a.tripId];
    for (const id of ids) {
      if (a.next === undefined) {
        await deletePsTripExceptionMatrix(projectId, { trip_id: id, date: a.date });
      } else {
        await upsertPsTripException(projectId, { trip_id: id, date: a.date, exception_type: a.next });
      }
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
    // Corse fuse identiche: la modifica si applica a tutte.
    const tripIds = mergeMembers.get(tripId) ?? [tripId];
    const exMap = ctx.tripExceptions.get(tripId);
    const cur = exMap?.get(date);

    // Se c'è già un'eccezione, la rimuovo (ripristino default).
    if (cur !== undefined) {
      cellMut.mutate({ kind: "exception", tripId, tripIds, date, prev: cur, next: undefined });
      return;
    }
    // Stato mostrato = UNIONE delle corse fuse: se almeno una è attiva quel
    // giorno la cella è verde → il toggle la spegne (e viceversa) su TUTTE.
    const unionValid = tripIds.some((id) => getCellValidity(ctx, id, date));
    const target: 1 | 2 = unionValid ? 2 : 1;
    cellMut.mutate({ kind: "exception", tripId, tripIds, date, prev: undefined, next: target });
  }, [ctx, cellMut, projectQ.data, mergeMembers]);

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
        // applica a tutte le corse fuse identiche
        for (const id of (mergeMembers.get(tripId) ?? [tripId])) {
          if (target === "clear") {
            await deletePsTripExceptionMatrix(projectId, { trip_id: id, date });
          } else {
            await upsertPsTripException(projectId, {
              trip_id: id, date, exception_type: target === "valid" ? 1 : 2,
            });
          }
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
    <div className="flex flex-col h-full min-w-0 bg-slate-950 text-slate-100">
      {/* ─── TopBar (riga 1: identità + undo/redo) ───────────────────── */}
      <div className="h-14 border-b border-slate-800 bg-slate-900 px-4 flex items-center gap-3 shrink-0">
        <Link href={`/planning-studio/${projectId}`}>
          <button
            className="p-1.5 rounded-md hover:bg-slate-800 text-slate-400 hover:text-slate-100 transition-colors"
            title="Torna al progetto"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
        </Link>
        <div className="flex items-center gap-2 min-w-0">
          <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-sky-500/20 to-violet-500/20 border border-sky-500/30 flex items-center justify-center shrink-0">
            <CalendarIcon className="h-4 w-4 text-sky-300" />
          </div>
          <div className="flex flex-col min-w-0">
            <h1 className="font-semibold text-sm text-slate-100 truncate leading-tight">
              Validità · {projectQ.data?.name ?? "…"}
            </h1>
            <span className="text-[11px] text-slate-500 leading-tight truncate">
              Definisci quando circolano le corse, prima dello scheduling
            </span>
          </div>
        </div>

        <div className="hidden lg:block ml-4">
          <ValiditySectionNav projectId={projectId} active="validity" />
        </div>

        <div className="ml-auto flex items-center gap-1.5">
          <div className="flex items-center gap-1 bg-slate-950/60 border border-slate-800 rounded-md p-0.5">
            <button
              onClick={() => undoMut.mutate()}
              disabled={undoStack.length === 0 || undoMut.isPending}
              className="p-1.5 rounded text-slate-400 hover:bg-slate-800 hover:text-slate-100 disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
              title="Annulla (Cmd/Ctrl+Z)"
            >
              <Undo2 className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={() => redoMut.mutate()}
              disabled={redoStack.length === 0 || redoMut.isPending}
              className="p-1.5 rounded text-slate-400 hover:bg-slate-800 hover:text-slate-100 disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
              title="Ripeti (Cmd/Ctrl+Shift+Z)"
            >
              <Redo2 className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* ─── Action bar (riga 2: filtri + azioni raggruppate) ───────── */}
      <div className="border-b border-slate-800 bg-slate-900/60 px-4 py-2.5 flex items-center gap-2 flex-wrap shrink-0">
        {/* Gruppo: filtri date + linea */}
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 mr-1">Periodo</span>
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="bg-slate-950 border border-slate-700 rounded-md px-2 py-1 text-xs text-slate-200 focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500/30"
          />
          <span className="text-slate-600 text-xs">→</span>
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="bg-slate-950 border border-slate-700 rounded-md px-2 py-1 text-xs text-slate-200 focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500/30"
          />
          <button
            onClick={() => { setFrom(todayISO()); setTo(plusDaysISO(todayISO(), 60)); }}
            className="px-2 py-1 text-[11px] rounded-md border border-slate-700 bg-slate-950 text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors"
            title="Reset a oggi → +60gg"
          >
            Reset
          </button>
        </div>

        <div className="h-6 w-px bg-slate-800 mx-1" />

        <div className="flex items-center gap-1.5">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 mr-1">Linea</span>
          <select
            value={routeId ?? ""}
            onChange={(e) => setRouteId(e.target.value || null)}
            className="bg-slate-950 border border-slate-700 rounded-md px-2 py-1 text-xs text-slate-200 max-w-[220px] focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500/30"
            title="Filtra la matrice per linea (obbligatorio sopra 2000 corse)"
          >
            <option value="">— Tutte le linee —</option>
            {(routesQ.data ?? []).map((r) => (
              <option key={r.id} value={r.id}>
                {(r.shortName ?? r.longName ?? "?")} · {r.tripCount} corse
              </option>
            ))}
          </select>
          {/* Ricerca/filtro linee visibili (lato client) */}
          <input
            value={lineFilter}
            onChange={(e) => setLineFilter(e.target.value)}
            placeholder="Filtra linee…"
            className="bg-slate-950 border border-slate-700 rounded-md px-2 py-1 text-xs text-slate-200 w-[120px] focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500/30"
            title="Mostra solo le linee il cui nome/codice contiene il testo"
          />
        </div>

        <div className="h-6 w-px bg-slate-800 mx-1" />

        {/* Filtro per criterio del Calendario aziendale */}
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 mr-1">Calendario</span>
          <select
            value={calCriterion}
            onChange={(e) => setCalCriterion(e.target.value)}
            className="bg-slate-950 border border-slate-700 rounded-md px-2 py-1 text-xs text-slate-200 focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500/30"
            title="Mostra solo i giorni che corrispondono al criterio del Calendario aziendale"
          >
            <option value="">— Tutti i giorni —</option>
            <option value="scuole_aperte">Scuole aperte</option>
            <option value="scuole_chiuse">Scuole chiuse</option>
            <option value="estivo">· Estivo</option>
            <option value="invernale">· Invernale</option>
            <option value="domeniche">Domeniche</option>
            <option value="festivi">Festivi (rossi + dom.)</option>
          </select>
          {calCriterion && (
            <span className="text-[10px] text-slate-500 tabular-nums" title="Giorni che corrispondono al criterio nel range visibile">
              {dates.length} gg
            </span>
          )}
        </div>

        <div className="h-6 w-px bg-slate-800 mx-1" />

        {/* Scroll orizzontale della matrice */}
        <div className="flex items-center gap-1">
          <button
            onClick={() => scrollH(-1)}
            className="p-1 rounded-md border border-slate-700 bg-slate-950 text-slate-300 hover:text-sky-300 hover:border-sky-500/40 hover:bg-slate-900 transition-colors"
            title="Scorri la matrice verso sinistra (giorni precedenti)"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            onClick={() => scrollH(1)}
            className="p-1 rounded-md border border-slate-700 bg-slate-950 text-slate-300 hover:text-sky-300 hover:border-sky-500/40 hover:bg-slate-900 transition-colors"
            title="Scorri la matrice verso destra (giorni successivi)"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>

        <div className="h-6 w-px bg-slate-800 mx-1" />

        {/* Gruppo: configura */}
        <button
          onClick={() => setDtEditorOpen(true)}
          className="flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md border border-slate-700 bg-slate-950 text-slate-300 hover:text-violet-300 hover:border-violet-500/40 hover:bg-slate-900 transition-colors"
          title="Crea/modifica i tipi-giornata (Feriale, Festivo, ecc.) e i loro colori"
        >
          <Palette className="h-3.5 w-3.5" />
          Day-types
        </button>
        <button
          onClick={() => setCategoryPeriodsOpen(true)}
          className="flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md border border-slate-700 bg-slate-950 text-slate-300 hover:text-fuchsia-300 hover:border-fuchsia-500/40 hover:bg-slate-900 transition-colors"
          title="Definisci 'Categorie Periodi' (es. Scuole Aperte/Chiuse) e dipingi i giorni del calendario"
        >
          <CalendarIcon className="h-3.5 w-3.5" />
          Categorie Periodi
        </button>

        <div className="h-6 w-px bg-slate-800 mx-1" />

        {/* Gruppo: sync GTFS */}
        <button
          onClick={() => syncFromGtfsMut.mutate()}
          disabled={syncFromGtfsMut.isPending}
          className="flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md border border-amber-500/30 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20 hover:border-amber-500/50 disabled:opacity-50 transition-colors"
          title="Accendi automaticamente i bollini di validità leggendo i calendari GTFS (lun-ven → Feriale, sab → Sabato, dom → Festivo, + eccezioni)"
        >
          {syncFromGtfsMut.isPending
            ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
            : <Wand2 className="h-3.5 w-3.5" />}
          Sincronizza GTFS
        </button>

        <div className="ml-auto flex items-center gap-1.5">
          <Link href={`/planning-studio/${projectId}/validity-units`}>
            <button
              className="flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md border border-slate-700 bg-slate-950 text-slate-300 hover:text-indigo-300 hover:border-indigo-500/40 hover:bg-slate-900 transition-colors"
              title="Vai alle Unità di Progettazione salvate"
            >
              <Layers className="h-3.5 w-3.5" />
              Unità salvate
            </button>
          </Link>
          <button
            onClick={() => setComputeUnitsOpen(true)}
            className="flex items-center gap-1.5 px-3 py-1 text-xs rounded-md bg-gradient-to-r from-indigo-600 to-violet-600 text-white font-semibold hover:from-indigo-500 hover:to-violet-500 shadow-md shadow-indigo-900/30 transition-colors"
            title="Calcola le Unità (gruppi di giorni con stessa categoria + day-type + corse attive) e salva"
          >
            <Rocket className="h-3.5 w-3.5" />
            Calcola Unità
          </button>
        </div>
      </div>

      {/* Banner errore: matrice troppo grande → invita a scegliere una linea */}
      {needsRouteFilter && (
        <div className="mx-4 mt-3 px-3 py-2 rounded-md border border-amber-500/40 bg-amber-500/10 text-amber-200 text-xs flex items-start gap-2 shrink-0">
          <span className="font-bold">⚠</span>
          <div>
            <div className="font-semibold">
              Troppe corse nel range selezionato ({matrixErrBody?.tripCount?.toLocaleString("it-IT")} &gt; {matrixErrBody?.maxTripsPerPage?.toLocaleString("it-IT")})
            </div>
            <div className="text-amber-300/80">
              Per visualizzare la matrice, scegli una <strong>Linea</strong> nei filtri (oppure restringi il range di date).
              Abbiamo pre-selezionato la prima linea disponibile.
            </div>
          </div>
        </div>
      )}

      {/* Stato caricamento */}
      {(matrixQ.isLoading || dayTypesQ.isLoading) && (
        <div className="flex items-center justify-center flex-1">
          <Loader2 className="h-6 w-6 animate-spin text-sky-400" />
        </div>
      )}
      {matrixQ.isError && (
        <div className="p-6 text-sm text-rose-300">
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
            className="flex-1 overflow-auto relative bg-slate-950"
            style={{ scrollBehavior: "auto" }}
          >
            {/* HEADER sticky top: 2 righe (mesi + giorni) */}
            <div
              className="sticky top-0 z-30 bg-slate-900 border-b border-slate-800 shadow-sm"
              style={{ height: HEADER_H + MONTH_BAND_H }}
            >
              {/* Riga 1: banda MESI raggruppati */}
              <div className="flex" style={{ height: MONTH_BAND_H }}>
                <div
                  className="sticky left-0 z-40 bg-slate-900 border-r border-b border-slate-800 flex items-center justify-between px-3 text-[11px] font-bold uppercase tracking-wide text-slate-400"
                  style={{ width: STICKY_W, minWidth: STICKY_W }}
                >
                  <span>Mese</span>
                  {selectedDates.size > 0 && (
                    <button
                      onClick={clearDateSelection}
                      className="text-[10px] font-medium normal-case text-sky-400 hover:text-sky-300 underline"
                      title="Deseleziona tutti i giorni"
                    >
                      ✕ ({selectedDates.size})
                    </button>
                  )}
                </div>
                <div className="flex">
                  {computeMonthGroups(dates).map((g) => (
                    <div
                      key={`${g.year}-${g.label}-${g.startIdx}`}
                      className="flex items-center justify-center text-[11px] font-bold uppercase tracking-wide text-slate-400 bg-slate-900/80 border-r border-b border-slate-800"
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
                  className="sticky left-0 z-40 bg-slate-900 border-r border-slate-800 flex items-center justify-center text-xs font-medium text-slate-400"
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
                        className={`flex flex-col items-center justify-center text-[10px] hover:bg-slate-800 transition-colors ${
                          lbl.isWeekend ? "bg-rose-950/40" : ""
                        } ${isSelected ? "ring-2 ring-inset ring-sky-500 bg-sky-500/15" : ""} ${
                          dropdownDate === d ? "bg-sky-500/25" : ""
                        }`}
                        style={{
                          width: COL_W,
                          minWidth: COL_W,
                          borderRight: isFirstOfMonth ? "2px solid #475569" : "1px solid #1e293b",
                          borderTop: cat ? `3px solid ${cat.color}` : undefined,
                        }}
                        title={`${d} · ${dt?.name ?? "?"}${cat ? `\nCategoria: ${cat.name}` : ""}\nClick: seleziona · ⌘/Ctrl+Click: aggiungi · Shift+Click: range · Doppio-click: override singolo`}
                      >
                        <span className="font-semibold text-slate-200 text-[12px] leading-tight">{lbl.day}</span>
                        <span className={`leading-tight ${lbl.isWeekend ? "text-rose-400 font-semibold" : "text-slate-500"}`}>{lbl.dow}</span>
                        <span
                          className="w-2.5 h-2.5 rounded-full mt-0.5 ring-1 ring-slate-900"
                          style={{ backgroundColor: dt?.color ?? "#475569" }}
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
                        className="flex items-center sticky-route-header bg-slate-900/80 border-b border-slate-800"
                        style={{ height: ROW_H }}
                      >
                        <div
                          className="sticky left-0 z-20 bg-slate-900 border-r border-slate-800 flex items-center gap-2 px-3 text-xs font-semibold text-slate-200"
                          style={{ width: STICKY_W, minWidth: STICKY_W, height: ROW_H }}
                        >
                          <span
                            className="inline-block w-3 h-3 rounded-sm"
                            style={{ backgroundColor: row.routeColor || "#64748b" }}
                          />
                          <span>{row.routeShortName ?? "—"}</span>
                          <span className="text-slate-500 font-normal">({row.tripCount} corse)</span>
                        </div>
                        <div
                          className="bg-slate-900/80"
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
                      className={`flex border-b ${isHighlighted ? "bg-sky-500/15 border-sky-500/40 ring-1 ring-inset ring-sky-500/40" : "border-slate-800/60"}`}
                      style={{ height: ROW_H }}
                    >
                      <button
                        type="button"
                        onClick={() => setHighlightedTripId(isHighlighted ? null : t.id)}
                        className={`sticky left-0 z-10 border-r flex items-center gap-2 px-3 text-xs text-left ${
                          isHighlighted
                            ? "bg-sky-500/20 hover:bg-sky-500/25 border-sky-500/40 font-semibold text-slate-100"
                            : "bg-slate-950 hover:bg-slate-900 border-slate-800 text-slate-300"
                        }`}
                        style={{ width: STICKY_W, minWidth: STICKY_W, height: ROW_H }}
                        title={`Click: evidenzia riga in tutto il calendario · ${t.shortName ?? ""} · ${t.headsign ?? ""}`}
                      >
                        <span className="text-slate-400 tabular-nums w-11 shrink-0" title="Orario di partenza">
                          {t.firstDeparture ? t.firstDeparture.slice(0, 5) : "—"}
                        </span>
                        {(mergeMembers.get(t.id)?.length ?? 1) > 1 && (
                          <span className="font-mono text-[9px] text-amber-300 bg-amber-500/15 border border-amber-500/30 rounded px-1 py-0.5 shrink-0"
                            title={`${mergeMembers.get(t.id)!.length} corse identiche fuse in questa riga — le modifiche si applicano a tutte`}>
                            ×{mergeMembers.get(t.id)!.length}
                          </span>
                        )}
                        <span className="font-mono text-[10px] text-slate-300 bg-slate-800/80 rounded px-1 py-0.5 shrink-0 max-w-[72px] truncate" title="Codice corsa">
                          {t.shortName ?? t.id.slice(0, 6)}
                        </span>
                        <span
                          className="text-slate-200 truncate flex-1 flex items-center gap-1"
                          title={`Partenza: ${t.firstStopName ?? "—"}  →  Arrivo: ${t.lastStopName ?? t.headsign ?? "—"}`}
                        >
                          <span className="truncate">{t.firstStopName || "—"}</span>
                          <span className="text-slate-500 shrink-0">→</span>
                          <span className="truncate">{t.lastStopName || t.headsign || "—"}</span>
                        </span>
                      </button>
                      <CellsRow
                        ctx={ctx}
                        tripId={t.id}
                        memberIds={mergeMembers.get(t.id)}
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
          routes={(routesQ.data ?? []).map((r) => ({
            id: r.id,
            label: r.shortName ?? r.longName ?? "?",
            tripCount: r.tripCount,
          }))}
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
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 bg-slate-900 border border-slate-700 text-slate-100 rounded-xl shadow-2xl shadow-black/60 px-4 py-2 flex items-center gap-3 backdrop-blur">
          <span className="text-sm font-medium">
            {selectedCells.size} cell{selectedCells.size === 1 ? "a" : "e"} selezionat{selectedCells.size === 1 ? "a" : "e"}
          </span>
          <div className="h-5 w-px bg-slate-700" />
          <button
            onClick={() => cellsBulkMut.mutate("valid")}
            disabled={cellsBulkMut.isPending}
            className="px-3 py-1.5 text-xs rounded-md bg-emerald-600 hover:bg-emerald-500 font-semibold disabled:opacity-50 flex items-center gap-1.5 text-white shadow-sm"
          >
            {cellsBulkMut.isPending && <Loader2 className="h-3 w-3 animate-spin" />}
            <Check className="h-3 w-3" /> Imposta Valide
          </button>
          <button
            onClick={() => cellsBulkMut.mutate("invalid")}
            disabled={cellsBulkMut.isPending}
            className="px-3 py-1.5 text-xs rounded-md bg-rose-600 hover:bg-rose-500 font-semibold disabled:opacity-50 flex items-center gap-1.5 text-white shadow-sm"
          >
            <X className="h-3 w-3" /> Imposta Invalide
          </button>
          <button
            onClick={() => cellsBulkMut.mutate("clear")}
            disabled={cellsBulkMut.isPending}
            className="px-3 py-1.5 text-xs rounded-md bg-slate-700 hover:bg-slate-600 font-semibold disabled:opacity-50 flex items-center gap-1.5 text-slate-200"
          >
            <Eraser className="h-3 w-3" /> Pulisci
          </button>
          <button
            onClick={clearCellSelection}
            className="p-1.5 rounded-md text-slate-400 hover:bg-slate-800 hover:text-slate-200"
            title="Annulla selezione"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Footer status */}
      <div className="border-t border-slate-800 bg-slate-900/60 px-4 py-1.5 text-[11px] text-slate-500 flex gap-4 shrink-0">
        <span>Range: <span className="text-slate-300">{from} → {to}</span> ({dates.length} giorni)</span>
        <span>·</span>
        <span>Corse: <span className="text-slate-300">{matrixQ.data?.trips.length ?? 0}</span></span>
        <span>·</span>
        <span>Day-types: <span className="text-slate-300">{dayTypesQ.data?.length ?? 0}</span></span>
        {undoStack.length > 0 && <><span>·</span><span>Undo stack: {undoStack.length}</span></>}
        {cellMut.isPending && <><span>·</span><span className="text-sky-400 flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" />Salvataggio…</span></>}
        <span className="ml-auto text-slate-600">
          Tip: <kbd className="px-1 bg-slate-800 border border-slate-700 rounded text-slate-400">SHIFT</kbd>+Click sui pallini per selezionare un range
        </span>
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
  /** Corse fuse identiche: la validità della cella è l'UNIONE (OR) di queste. */
  memberIds?: string[];
}

function CellsRow({ ctx, tripId, dates, onSelect, selectedDates, selectedCells, highlighted, categoryByDate, memberIds }: CellsRowProps) {
  const ids = memberIds && memberIds.length > 0 ? memberIds : [tripId];
  return (
    <>
      {dates.map((d) => {
        // UNIONE: la cella è valida se ALMENO UNA delle corse fuse è attiva quel giorno.
        const valid = ids.some((id) => getCellValidity(ctx, id, d));
        const ex = ctx.tripExceptions.get(tripId)?.get(d);
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
              highlighted ? "bg-sky-500/15" : isSelectedCol ? "bg-sky-500/10" : ""
            } ${isCellSelected ? "ring-2 ring-inset ring-sky-500 bg-sky-500/20" : ""}`}
            style={{
              width: COL_W,
              minWidth: COL_W,
              height: ROW_H,
              backgroundColor: !isCellSelected && !isSelectedCol && !highlighted ? catBg : undefined,
              borderRight: isFirstOfMonth
                ? "2px solid #475569"
                : isMonday
                ? "1px solid #334155"
                : "1px solid #1e293b",
            }}
            title={`${d} · ${valid ? "valida" : "invalida"}${ex ? (ex === 1 ? " (eccezione +)" : " (eccezione −)") : ""}${cat ? `\nCategoria: ${cat.name}` : ""}\nClick: toggle · Shift+Click: range · Cmd/Ctrl+Click: aggiungi alla selezione`}
          >
            <div
              className="rounded-md transition-transform hover:scale-110"
              style={{
                width: COL_W - 8,
                height: ROW_H - 8,
                backgroundColor: fill,
                boxShadow: ex ? "0 0 0 1.5px rgba(255,255,255,0.18) inset" : undefined,
              }}
            />
          </div>
        );
      })}
    </>
  );
}

function cellFillColor(valid: boolean, ex: 1 | 2 | undefined): string {
  if (ex === 1) return "#10b981"; // verde acceso (override attiva)
  if (ex === 2) return "#ef4444"; // rosso acceso (override disattiva)
  if (valid) return "#34d399";    // verde tenue (default valida)
  return "#475569";               // grigio dark (default invalida)
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
      className="absolute z-50 bg-slate-900 border border-slate-700 shadow-2xl shadow-black/60 rounded-xl p-4 w-72 text-slate-100"
      style={{ top: HEADER_H + 4, right: 12 }}
    >
      <div className="flex items-center justify-between mb-3">
        <div className="font-semibold text-sm">Override · <span className="text-sky-300 font-mono text-xs">{date}</span></div>
        <button onClick={onClose} className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-slate-200">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="text-xs text-slate-400 mb-1.5">Day-type per questa data</div>
      <select
        value={selected}
        onChange={(e) => setSelected(e.target.value)}
        className="w-full bg-slate-950 border border-slate-700 rounded-md px-2 py-1.5 text-sm mb-3 text-slate-200 focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500/30"
      >
        <option value="">— scegli —</option>
        {dayTypes.map((dt) => (
          <option key={dt.id} value={dt.id}>
            {dt.name} {dt.isSystem ? "(sys)" : ""}
          </option>
        ))}
      </select>
      <div className="text-xs text-slate-400 mb-1.5">Ambito</div>
      <div className="flex gap-3 mb-4 text-xs text-slate-300">
        <label className="flex items-center gap-1.5 cursor-pointer">
          <input type="radio" checked={scope === "project"} onChange={() => setScope("project")} className="accent-sky-500" />
          Solo questo progetto
        </label>
        <label className="flex items-center gap-1.5 cursor-pointer">
          <input type="radio" checked={scope === "tenant"} onChange={() => setScope("tenant")} className="accent-sky-500" />
          Globale
        </label>
      </div>
      <div className="flex gap-2 justify-end">
        <button onClick={onClose} className="px-3 py-1.5 text-sm rounded-md border border-slate-700 text-slate-300 hover:bg-slate-800">Annulla</button>
        <button
          onClick={() => selected && onApply(selected, scope)}
          disabled={!selected || isPending}
          className="px-3 py-1.5 text-sm rounded-md bg-sky-600 text-white hover:bg-sky-500 disabled:opacity-50 flex items-center gap-1 font-medium"
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 backdrop-blur-sm" onClick={onClose}>
      <div
        className="bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl w-full max-w-md max-h-[85vh] flex flex-col text-slate-100"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-3.5 border-b border-slate-800 flex items-center justify-between bg-gradient-to-r from-violet-500/10 to-transparent">
          <div className="flex items-center gap-2">
            <div className="h-8 w-8 rounded-lg bg-violet-500/15 border border-violet-500/30 flex items-center justify-center">
              <Settings2 className="h-4 w-4 text-violet-300" />
            </div>
            <div>
              <h2 className="font-semibold text-sm">Day-types</h2>
              <p className="text-[11px] text-slate-500">Tipi-giornata del progetto</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-md hover:bg-slate-800 text-slate-400 hover:text-slate-100">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-auto">
          <div className="p-3 space-y-1.5">
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
            {dayTypes.length === 0 && (
              <div className="text-xs text-slate-500 italic text-center py-6">Nessun day-type</div>
            )}
          </div>
        </div>

        {canEdit && (
          <div className="border-t border-slate-800 p-3 bg-slate-950/40">
            {!showNew ? (
              <button
                onClick={() => setShowNew(true)}
                className="w-full px-3 py-2 text-sm rounded-md border border-dashed border-slate-700 bg-slate-900 hover:bg-slate-800 hover:border-emerald-500/40 hover:text-emerald-300 text-slate-300 flex items-center justify-center gap-1.5 transition-colors"
              >
                <Plus className="h-4 w-4" /> Nuovo day-type custom
              </button>
            ) : (
              <div className="space-y-2">
                <input
                  placeholder="Codice (es. festa_patronale)"
                  value={newCode}
                  onChange={(e) => setNewCode(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-700 rounded-md px-2 py-1.5 text-sm text-slate-200 focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500/30"
                />
                <input
                  placeholder="Nome visibile"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-700 rounded-md px-2 py-1.5 text-sm text-slate-200 focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500/30"
                />
                <div className="flex items-center gap-2">
                  <input
                    type="color" value={newColor}
                    onChange={(e) => setNewColor(e.target.value)}
                    className="w-10 h-8 bg-slate-950 border border-slate-700 rounded cursor-pointer"
                  />
                  <span className="text-xs font-mono text-slate-400">{newColor}</span>
                </div>
                <div className="flex gap-2 justify-end">
                  <button
                    onClick={() => setShowNew(false)}
                    className="px-3 py-1.5 text-sm rounded-md border border-slate-700 text-slate-300 hover:bg-slate-800"
                  >Annulla</button>
                  <button
                    onClick={() => createMut.mutate()}
                    disabled={!newCode.trim() || !newName.trim() || createMut.isPending}
                    className="px-3 py-1.5 text-sm rounded-md bg-violet-600 text-white hover:bg-violet-500 disabled:opacity-50 flex items-center gap-1 font-medium"
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
      <div className="border border-slate-700 rounded-md p-2 space-y-2 bg-slate-950">
        <input
          value={name} onChange={(e) => setName(e.target.value)}
          className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-sm text-slate-200 focus:border-violet-500 focus:outline-none"
        />
        <div className="flex items-center gap-2">
          <input
            type="color" value={color}
            onChange={(e) => setColor(e.target.value)}
            className="w-8 h-7 bg-slate-900 border border-slate-700 rounded"
          />
          <span className="text-xs font-mono text-slate-400">{color}</span>
          <div className="ml-auto flex gap-1">
            <button onClick={() => setEditing(false)} className="p-1 rounded hover:bg-slate-800 text-slate-400">
              <X className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={() => { onSave({ name, color }); setEditing(false); }}
              className="p-1 rounded bg-violet-600 text-white hover:bg-violet-500"
            >
              <Check className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-slate-800/50 group border border-transparent hover:border-slate-700 transition-colors">
      <span
        className="inline-block w-4 h-4 rounded ring-1 ring-slate-700 shrink-0"
        style={{ backgroundColor: dt.color }}
      />
      <div className="flex-1 min-w-0">
        <div className="text-sm text-slate-100 truncate">{dt.name}</div>
        <div className="text-[10px] text-slate-500 font-mono truncate">
          {dt.code} {dt.isSystem ? "· system" : ""}
        </div>
      </div>
      {canEdit && !dt.isSystem && (
        <div className="opacity-0 group-hover:opacity-100 flex gap-1">
          <button
            onClick={() => setEditing(true)}
            className="p-1 rounded hover:bg-slate-700 text-slate-400 hover:text-slate-200" title="Modifica"
          >
            <Palette className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={onDelete}
            className="p-1 rounded hover:bg-rose-500/20 text-rose-400" title="Elimina"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
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
      toast.success(
        `Auto-import completato: ${r.summary.validityUpserts} validità + ${r.summary.exceptionInserts} eccezioni`,
        { description: typeof r.summary.tripCategoryUpserts === "number"
            ? `Calendario Aziendale intrecciato: ${r.summary.categoryDates ?? 0} date classificate, categorie assegnate a ${r.summary.tripsWithCategories ?? 0} corse`
            : undefined },
      );
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/70 backdrop-blur-sm flex items-center justify-center" onClick={onClose}>
      <div
        className="bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl w-[640px] max-h-[80vh] overflow-auto text-slate-100"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-slate-800 px-5 py-3.5 flex items-center justify-between bg-gradient-to-r from-emerald-500/10 to-transparent">
          <div className="flex items-center gap-2">
            <div className="h-8 w-8 rounded-lg bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center">
              <Wand2 className="h-4 w-4 text-emerald-300" />
            </div>
            <div>
              <h2 className="font-semibold text-sm">Auto-import da GTFS calendars</h2>
              <p className="text-[11px] text-slate-500">Mappa i calendari GTFS in validità progetto</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-md hover:bg-slate-800 text-slate-400 hover:text-slate-100">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-5 space-y-3 text-sm">
          <p className="text-slate-300">
            Mappa i <code className="text-emerald-300 bg-slate-950 px-1 py-0.5 rounded text-xs">ps_calendars</code> esistenti del progetto in <code className="text-emerald-300 bg-slate-950 px-1 py-0.5 rounded text-xs">ps_trip_day_validity</code>:
          </p>
          <ul className="text-xs text-slate-400 list-disc pl-5 space-y-1">
            <li>Pattern lun-ven → day-type <span className="font-mono text-slate-300">feriale</span></li>
            <li>Pattern sabato → day-type <span className="font-mono text-slate-300">sabato</span></li>
            <li>Pattern domenica → day-type <span className="font-mono text-slate-300">festivo</span></li>
            <li>Date eccezione (calendar_dates) → eccezioni puntuali per ogni corsa del calendar</li>
            <li>Imposta valid_from/valid_to del trip dal range del calendar (solo se NULL)</li>
            <li>
              <span className="text-emerald-300 font-medium">Intreccio col Calendario Aziendale</span>: classifica ogni data
              (Scuole Aperte / Scuole Chiuse / Festività), popola il calendario delle categorie e assegna a ogni corsa
              le categorie dei periodi in cui circola davvero
            </li>
          </ul>

          {!preview && (
            <button
              onClick={() => previewMut.mutate()}
              disabled={previewMut.isPending}
              className="px-3 py-1.5 text-sm rounded-md border border-slate-700 bg-slate-950 hover:bg-slate-800 text-slate-300 flex items-center gap-1.5 disabled:opacity-50"
            >
              {previewMut.isPending && <Loader2 className="h-3 w-3 animate-spin" />}
              1. Anteprima (dry-run)
            </button>
          )}

          {preview && (
            <div className="border border-slate-700 rounded-lg overflow-hidden">
              <div className="px-3 py-2 bg-slate-950 border-b border-slate-700 text-xs font-medium text-slate-300">
                Preview · <span className="text-emerald-300">{preview.summary.calendars}</span> calendari · <span className="text-emerald-300">{preview.summary.validityUpserts}</span> righe validità
                + <span className="text-emerald-300">{preview.summary.exceptionInserts}</span> eccezioni
                {typeof preview.summary.tripCategoryUpserts === "number" && (
                  <> · <span className="text-amber-300">{preview.summary.categoryDates ?? 0}</span> date classificate
                  · <span className="text-amber-300">{preview.summary.tripCategoryUpserts}</span> categorie su <span className="text-amber-300">{preview.summary.tripsWithCategories ?? 0}</span> corse</>
                )}
              </div>
              <table className="w-full text-xs">
                <thead className="bg-slate-950 border-b border-slate-700 text-slate-400">
                  <tr>
                    <th className="text-left px-3 py-1.5 font-medium">Calendar</th>
                    <th className="text-right px-3 py-1.5 font-medium">Trip</th>
                    <th className="text-right px-3 py-1.5 font-medium">DayTypes</th>
                    <th className="text-right px-3 py-1.5 font-medium">Validità</th>
                    <th className="text-right px-3 py-1.5 font-medium">Eccezioni</th>
                  </tr>
                </thead>
                <tbody className="text-slate-300">
                  {preview.perCalendar.map((c) => (
                    <tr key={c.calendarId} className="border-b border-slate-800 hover:bg-slate-800/30">
                      <td className="px-3 py-1 font-mono text-slate-200">{c.calendarCode ?? c.calendarId.slice(0, 8)}</td>
                      <td className="px-3 py-1 text-right tabular-nums">{c.tripCount}</td>
                      <td className="px-3 py-1 text-right tabular-nums">{c.dayTypeCount}</td>
                      <td className="px-3 py-1 text-right tabular-nums">{c.validityRowsToWrite}</td>
                      <td className="px-3 py-1 text-right tabular-nums">{c.exceptionRowsToWrite}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="border-t border-slate-800 px-5 py-3 flex justify-end gap-2 bg-slate-950/40">
          <button onClick={onClose} className="px-3 py-1.5 text-sm rounded-md border border-slate-700 text-slate-300 hover:bg-slate-800">Annulla</button>
          <button
            onClick={() => applyMut.mutate()}
            disabled={!preview || applyMut.isPending}
            className="px-3 py-1.5 text-sm rounded-md bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-50 flex items-center gap-1.5 font-medium shadow-sm"
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
    <div className="fixed inset-0 z-50 bg-slate-950/70 backdrop-blur-sm flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl w-[620px] max-h-[88vh] overflow-auto text-slate-100"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-slate-800 px-5 py-3 flex items-center justify-between bg-gradient-to-r from-indigo-500/10 via-violet-500/5 to-transparent">
          <div className="flex items-center gap-3">
            <div className="h-8 w-8 rounded-lg bg-indigo-500/15 border border-indigo-500/30 flex items-center justify-center">
              <Rocket className="h-4 w-4 text-indigo-300" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-slate-100">Genera Unità di Progettazione</h2>
              <p className="text-[11px] text-slate-400">Snapshot del filtro validità → nuovo progetto Scheduling</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <p className="text-xs text-slate-400 bg-slate-950 border border-slate-800 rounded-lg p-3 leading-relaxed">
            Crea un nuovo progetto Scheduling collegato a <strong className="text-slate-200">{projectName}</strong> con
            il filtro di validità snapshot (range + day-types). La pipeline Scheduling potrà
            poi materializzare il GTFS filtrato e procedere con vehicle/driver scheduling.
          </p>

          <div>
            <label className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 block mb-1.5">Nome unità *</label>
            <input
              type="text" value={name} onChange={(e) => setName(e.target.value)}
              className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/30"
              placeholder="es. Inverno 2026 · Feriali"
            />
          </div>

          <div>
            <label className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 block mb-1.5">Descrizione (opzionale)</label>
            <textarea
              value={description} onChange={(e) => setDescription(e.target.value)}
              className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/30"
              rows={2}
              placeholder="Note libere sull'unità di progettazione"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 block mb-1.5">Da</label>
              <input
                type="date" value={from} onChange={(e) => setFrom(e.target.value)}
                className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/30 [color-scheme:dark]"
              />
            </div>
            <div>
              <label className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 block mb-1.5">A</label>
              <input
                type="date" value={to} onChange={(e) => setTo(e.target.value)}
                className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/30 [color-scheme:dark]"
              />
            </div>
          </div>
          {days > 0 && (
            <p className="text-[11px] text-slate-400 -mt-2">
              Range: <strong className="text-indigo-300">{days}</strong> giorni
            </p>
          )}

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                Day-types da includere ({selected.size}/{dayTypes.length})
              </label>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setSelected(new Set(dayTypes.map((dt) => dt.id)))}
                  className="text-[11px] text-indigo-400 hover:text-indigo-300 hover:underline"
                >Tutti</button>
                <span className="text-slate-600">·</span>
                <button
                  type="button"
                  onClick={() => setSelected(new Set())}
                  className="text-[11px] text-indigo-400 hover:text-indigo-300 hover:underline"
                >Nessuno</button>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-1 max-h-44 overflow-auto bg-slate-950 border border-slate-800 rounded-lg p-2">
              {dayTypes.map((dt) => (
                <label key={dt.id} className="flex items-center gap-2 text-sm cursor-pointer hover:bg-slate-800/60 px-2 py-1 rounded transition-colors">
                  <input
                    type="checkbox" checked={selected.has(dt.id)}
                    onChange={() => toggle(dt.id)}
                    className="accent-indigo-500"
                  />
                  <span className="inline-block w-3 h-3 rounded-sm border border-slate-700" style={{ backgroundColor: dt.color }} />
                  <span className="truncate text-slate-200">{dt.name}</span>
                </label>
              ))}
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm cursor-pointer text-slate-300">
            <input
              type="checkbox" checked={includeOnlyValid}
              onChange={(e) => setIncludeOnlyValid(e.target.checked)}
              className="accent-indigo-500"
            />
            <span>Includi solo le corse valide nel filtro <span className="text-slate-500">(consigliato)</span></span>
          </label>
        </div>

        <div className="border-t border-slate-800 px-5 py-3 flex justify-end gap-2 bg-slate-950/50">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-sm rounded-lg border border-slate-700 bg-slate-950 text-slate-300 hover:bg-slate-800 hover:text-slate-100 transition-colors"
          >Annulla</button>
          <button
            onClick={() => mut.mutate()}
            disabled={!canSubmit}
            className="px-4 py-1.5 text-sm font-medium rounded-lg bg-gradient-to-r from-indigo-600 to-violet-600 text-white hover:from-indigo-500 hover:to-violet-500 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5 shadow-lg shadow-indigo-900/30 transition-all"
          >
            {mut.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
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
    <aside className="w-64 border-l border-slate-800 bg-slate-900/40 flex flex-col">
      <div className="px-3 py-2.5 border-b border-slate-800 bg-slate-900/60 flex items-center gap-2">
        <div className="h-6 w-6 rounded-md bg-violet-500/15 border border-violet-500/30 flex items-center justify-center">
          <Tags className="h-3 w-3 text-violet-300" />
        </div>
        <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-300">Giorni-Tipo</div>
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
      {hasSel && (
        <div className="px-2 py-1.5 rounded-md bg-sky-500/10 border border-sky-500/30 text-[11px] text-sky-300 font-medium">
          {props.selectedCount} {props.selectedCount === 1 ? "cella selezionata" : "celle selezionate"}
        </div>
      )}
      <div className="space-y-1">
        {props.dayTypes.map((dt) => (
          <button
            key={dt.id}
            disabled={!hasSel}
            onClick={() => props.onApply(dt.id)}
            className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg border border-slate-700 bg-slate-950 hover:bg-slate-800 hover:border-slate-600 text-sm text-slate-200 font-medium disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            title={hasSel ? `Applica "${dt.name}" alle date selezionate` : "Seleziona prima delle celle"}
          >
            <span className="inline-block h-3 w-3 rounded border border-slate-700" style={{ backgroundColor: dt.color || "#94a3b8" }} />
            <span className="truncate">{dt.name}</span>
          </button>
        ))}
        {props.dayTypes.length === 0 && (
          <div className="text-[12px] text-slate-500 px-2 py-3 text-center border border-dashed border-slate-700 rounded-lg">
            Nessun giorno-tipo
          </div>
        )}
      </div>
      <button
        onClick={props.onManage}
        className="w-full mt-2 px-2.5 py-1.5 text-xs rounded-lg border border-slate-700 bg-slate-800/50 hover:bg-slate-800 text-slate-200 font-medium flex items-center justify-center gap-1.5 transition-colors"
      >
        <Settings2 className="h-3 w-3" />
        Gestisci giorni-tipo
      </button>
      {!hasSel && (
        <div className="text-[11px] text-slate-400 px-1 pt-2 leading-relaxed">
          💡 Clicca sull'<strong className="text-slate-300">header di una data</strong> per selezionare i giorni, poi scegli un giorno-tipo da applicare.
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
      qc.invalidateQueries({ queryKey: ["ps-validity-categories"] });
    },
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 backdrop-blur-sm p-4">
      <div className="bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl w-full max-w-2xl max-h-[80vh] flex flex-col text-slate-100">
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-800 bg-gradient-to-r from-fuchsia-500/10 via-violet-500/5 to-transparent">
          <div className="flex items-center gap-3">
            <div className="h-8 w-8 rounded-lg bg-fuchsia-500/15 border border-fuchsia-500/30 flex items-center justify-center">
              <Tags className="h-4 w-4 text-fuchsia-300" />
            </div>
            <div>
              <div className="text-sm font-semibold text-slate-100">Categorie Validità</div>
              <div className="text-[11px] text-slate-400">Tag globali condivisi (es. Scuole, Festività)</div>
            </div>
          </div>
          <button onClick={props.onClose} className="p-1.5 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 overflow-auto p-4 space-y-2">
          {props.categories.map((c) => (
            <CategoryRow key={c.id} category={c} />
          ))}
          {props.categories.length === 0 && (
            <div className="text-sm text-slate-400 text-center py-8 border border-dashed border-slate-700 rounded-lg">
              Nessuna categoria. Creane una qui sotto.
            </div>
          )}
        </div>
        <div className="border-t border-slate-800 p-4 bg-slate-950/50 space-y-2">
          <div className="text-[11px] uppercase tracking-wide text-slate-400 font-semibold">Nuova categoria</div>
          <div className="flex items-center gap-2">
            <input
              type="text"
              placeholder="Nome (es. Scuole Aperte)"
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              className="flex-1 px-3 py-1.5 text-sm bg-slate-950 border border-slate-700 rounded-lg text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-fuchsia-500 focus:ring-1 focus:ring-fuchsia-500/30"
            />
            <input
              type="text"
              placeholder="code"
              value={draftCode}
              onChange={(e) => setDraftCode(e.target.value)}
              className="w-32 px-3 py-1.5 text-sm bg-slate-950 border border-slate-700 rounded-lg text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-fuchsia-500 focus:ring-1 focus:ring-fuchsia-500/30"
            />
            <input
              type="color"
              value={draftColor}
              onChange={(e) => setDraftColor(e.target.value)}
              className="h-8 w-10 bg-slate-950 border border-slate-700 rounded-lg cursor-pointer"
            />
            <button
              onClick={() => createMut.mutate()}
              disabled={!draftName.trim() || createMut.isPending}
              className="px-3 py-1.5 text-sm font-medium rounded-lg bg-fuchsia-600 text-white hover:bg-fuchsia-500 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5 transition-colors"
            >
              {createMut.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
              Crea
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
      qc.invalidateQueries({ queryKey: ["ps-validity-categories"] });
    },
  });
  const deleteMut = useMutation({
    mutationFn: () => deletePsValidityCategory(category.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ps-validity-categories"] });
      qc.invalidateQueries({ queryKey: ["ps-validity-categories", "calendar"] });
    },
  });

  return (
    <div className="flex items-center gap-2 border border-slate-800 hover:border-slate-700 rounded-lg px-3 py-2 bg-slate-950/50 transition-colors">
      <span className="inline-block h-4 w-4 rounded border border-slate-700 flex-shrink-0" style={{ backgroundColor: color }} />
      {editing ? (
        <>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="flex-1 px-2 py-1 text-sm bg-slate-950 border border-slate-700 rounded text-slate-100 focus:outline-none focus:border-fuchsia-500"
          />
          <input
            type="color"
            value={color}
            onChange={(e) => setColor(e.target.value)}
            className="h-7 w-9 bg-slate-950 border border-slate-700 rounded cursor-pointer"
          />
          <button
            onClick={() => updateMut.mutate()}
            disabled={updateMut.isPending}
            className="px-2.5 py-1 text-xs font-medium rounded-md bg-fuchsia-600 text-white hover:bg-fuchsia-500 disabled:opacity-40"
          >
            Salva
          </button>
          <button
            onClick={() => setEditing(false)}
            className="px-2.5 py-1 text-xs rounded-md border border-slate-700 bg-slate-950 text-slate-300 hover:bg-slate-800"
          >
            Annulla
          </button>
        </>
      ) : (
        <>
          <div className="flex-1 text-sm">
            <span className="font-medium text-slate-100">{category.name}</span>{" "}
            <span className="text-xs text-slate-500">({category.code})</span>
          </div>
          <button
            onClick={() => setEditing(true)}
            className="px-2.5 py-1 text-xs rounded-md border border-slate-700 bg-slate-950 text-slate-300 hover:bg-slate-800 hover:text-slate-100 transition-colors"
          >
            Modifica
          </button>
          <button
            onClick={() => {
              if (confirm(`Eliminare la categoria "${category.name}"?`)) deleteMut.mutate();
            }}
            disabled={deleteMut.isPending}
            className="px-2.5 py-1 text-xs rounded-md border border-rose-500/30 bg-rose-500/5 text-rose-300 hover:bg-rose-500/15 transition-colors"
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
  routes: Array<{ id: string; label: string; tripCount: number }>;
}) {
  const [from, setFrom] = useState(props.range.from);
  const [to, setTo] = useState(props.range.to);
  // tolleranza Jaccard (%): fonde i giorni quasi-uguali dentro la stessa
  // foglia del calendario aziendale → meno unità, eccezioni marcate
  const [tolerancePct, setTolerancePct] = useState(0);
  const [exactGroups, setExactGroups] = useState<number | null>(null);
  const [groups, setGroups] = useState<PsValidityUnitComputed[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [names, setNames] = useState<Record<string, string>>({});
  const [coverage, setCoverage] = useState<PsValidityUnitsCoverage | null>(null);
  // Linee INCLUSE nell'UDP (default = tutte). L'automatismo propone tutte le
  // linee, ma l'utente può cercare/selezionare/deselezionare a piacere.
  const allRouteIds = useMemo(() => props.routes.map((r) => r.id), [props.routes]);
  const [selectedRoutes, setSelectedRoutes] = useState<Set<string>>(() => new Set(allRouteIds));
  const [routesInit, setRoutesInit] = useState(false);
  const [routesPanelOpen, setRoutesPanelOpen] = useState(false);
  const [routeSearch, setRouteSearch] = useState("");
  // Criterio Calendario aziendale (limita ai giorni di quella classe) + prefisso nome
  const [calCriterion, setCalCriterion] = useState("");
  const [namePrefix, setNamePrefix] = useState("");

  // Inizializza a "tutte" appena le linee sono caricate (props.routes arriva async)
  useEffect(() => {
    if (!routesInit && props.routes.length > 0) {
      setSelectedRoutes(new Set(allRouteIds));
      setRoutesInit(true);
    }
  }, [props.routes.length, routesInit, allRouteIds]);

  useEffect(() => {
    setFrom(props.range.from);
    setTo(props.range.to);
    setGroups(null);
    setSelected(new Set());
    setNames({});
    setCoverage(null);
    setSelectedRoutes(new Set(allRouteIds));
    setRouteSearch("");
  }, [props.range.from, props.range.to, allRouteIds]);

  const toggleRoute = (id: string) => {
    setSelectedRoutes((prev) => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  };
  const filteredRoutes = useMemo(() => {
    const q = routeSearch.trim().toLowerCase();
    return q ? props.routes.filter((r) => r.label.toLowerCase().includes(q)) : props.routes;
  }, [props.routes, routeSearch]);
  const allSelected = selectedRoutes.size === props.routes.length;

  const computeMut = useMutation({
    mutationFn: () => computePsValidityUnits(props.projectId, {
      from, to, tolerance: tolerancePct / 100,
      // tutte → ometti (= tutte lato server); altrimenti invia la lista esatta
      // (anche vuota = nessuna linea).
      routeIds: allSelected ? undefined : Array.from(selectedRoutes),
      calendarCriterion: calCriterion || undefined,
    }),
    onSuccess: (res) => {
      setGroups(res.units);
      setCoverage(res.coverage ?? null);
      setExactGroups(res.exactGroups ?? null);
      const all = new Set<string>(res.units.map((g) => g.validityId));
      setSelected(all);
      const n: Record<string, string> = {};
      for (const g of res.units) {
        // nome proposto: foglia del calendario aziendale se disponibile
        const base = g.leafLabel ?? `${g.categoryName ?? "Generico"} · ${g.dayTypeName ?? "—"}`;
        n[g.validityId] = `${base} (${g.tripCount} corse)`;
      }
      setNames(n);
    },
  });

  const saveMut = useMutation({
    mutationFn: () => {
      const pfx = namePrefix.trim();
      const items = (groups ?? [])
        .filter((g) => selected.has(g.validityId))
        .map((g) => ({
          validityId: g.validityId,
          name: [pfx, names[g.validityId] || `Unità ${g.validityId.slice(0, 8)}`].filter(Boolean).join(" · "),
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

  // Corse coperte dalle unità SELEZIONATE vs da tutte le unità calcolate:
  // se deselezioni un'unità, le sue corse potrebbero restare fuori dall'UDP.
  const deselectionLeftover = useMemo(() => {
    if (!groups) return 0;
    const all = new Set<string>();
    const sel = new Set<string>();
    for (const g of groups) {
      for (const t of g.tripIds) {
        all.add(t);
        if (selected.has(g.validityId)) sel.add(t);
      }
    }
    let n = 0;
    for (const t of all) if (!sel.has(t)) n++;
    return n;
  }, [groups, selected]);

  const hasCoverageWarning = !!groups && (
    (coverage != null && (coverage.excludedByFilter > 0 || coverage.neverActive > 0)) ||
    deselectionLeftover > 0
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 backdrop-blur-sm p-4">
      <div className="bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl w-full max-w-3xl max-h-[85vh] flex flex-col text-slate-100">
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-800 bg-gradient-to-r from-indigo-500/10 via-violet-500/5 to-transparent">
          <div className="flex items-center gap-3">
            <div className="h-8 w-8 rounded-lg bg-indigo-500/15 border border-indigo-500/30 flex items-center justify-center">
              <Sparkles className="h-4 w-4 text-indigo-300" />
            </div>
            <div>
              <div className="text-sm font-semibold text-slate-100">Calcola Unità di Progettazione</div>
              <div className="text-[11px] text-slate-400">Raggruppa per categoria + giorno-tipo + composizione corse</div>
            </div>
          </div>
          <button onClick={props.onClose} className="p-1.5 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="px-5 py-3 border-b border-slate-800 bg-slate-950/50 flex items-end gap-3">
          <label className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            Dal
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="block mt-1 px-2.5 py-1.5 text-sm bg-slate-950 border border-slate-700 rounded-lg text-slate-100 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/30 [color-scheme:dark]"
            />
          </label>
          <label className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            Al
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="block mt-1 px-2.5 py-1.5 text-sm bg-slate-950 border border-slate-700 rounded-lg text-slate-100 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/30 [color-scheme:dark]"
            />
          </label>
          <label className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            Calendario
            <select
              value={calCriterion}
              onChange={(e) => setCalCriterion(e.target.value)}
              title="Limita le unità ai giorni di una classe del Calendario aziendale"
              className="block mt-1 px-2.5 py-1.5 text-sm bg-slate-950 border border-slate-700 rounded-lg text-slate-100 focus:outline-none focus:border-indigo-500 [color-scheme:dark]"
            >
              <option value="">Tutti i giorni</option>
              <option value="scuole_aperte">Scuole aperte</option>
              <option value="scuole_chiuse">Scuole chiuse</option>
              <option value="estivo">· Estivo</option>
              <option value="invernale">· Invernale</option>
              <option value="domeniche">Domeniche</option>
              <option value="festivi">Festivi</option>
            </select>
          </label>
          <label className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            Nome (prefisso)
            <input
              value={namePrefix}
              onChange={(e) => setNamePrefix(e.target.value)}
              placeholder="es. Jesi"
              title="Prefisso aggiunto all'inizio del nome di ogni unità salvata (es. «Jesi · Scuole Aperte · Feriale»)"
              className="block mt-1 px-2.5 py-1.5 text-sm bg-slate-950 border border-slate-700 rounded-lg text-slate-100 focus:outline-none focus:border-indigo-500 w-32"
            />
          </label>
          <label className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 min-w-36">
            Fusione giorni simili <span className="text-indigo-300 font-mono normal-case">{tolerancePct}%</span>
            <input
              type="range" min={0} max={10} step={1}
              value={tolerancePct}
              onChange={(e) => setTolerancePct(Number(e.target.value))}
              title="Quanto «arrotondare»: 0% tiene separati i giorni con composizione corse anche solo leggermente diversa (più unità). Alzandola, giorni quasi-uguali della stessa classe si fondono in un'unica unità, marcando le differenze come eccezioni (meno unità). Tienila a 0 se vuoi unità esatte."
              className="block mt-2 w-full accent-indigo-500"
            />
          </label>
          {/* Selezione linee da includere nell'UDP (vuoto = tutte) */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setRoutesPanelOpen((o) => !o)}
              className="px-3 py-1.5 text-sm rounded-lg border border-slate-700 bg-slate-950 text-slate-200 hover:border-indigo-500/40 flex items-center gap-1.5"
              title="Scegli quali linee includere nell'UDP. Vuoto = tutte le linee."
            >
              <Layers className="h-3.5 w-3.5" />
              Linee: {allSelected ? "tutte" : `${selectedRoutes.size}/${props.routes.length}`}
            </button>
            {routesPanelOpen && (
              <div className="absolute z-20 mt-1 w-72 rounded-lg border border-slate-700 bg-slate-900 shadow-xl p-2">
                {/* Ricerca + seleziona/deseleziona tutto */}
                <input
                  value={routeSearch}
                  onChange={(e) => setRouteSearch(e.target.value)}
                  placeholder="Cerca linea…"
                  className="w-full mb-2 px-2 py-1 text-xs rounded bg-slate-950 border border-slate-700 text-slate-200 focus:border-indigo-500 focus:outline-none"
                />
                <div className="flex items-center gap-3 px-1 pb-2 mb-1 border-b border-slate-800 text-[11px]">
                  <button className="text-indigo-300 hover:underline" onClick={() => setSelectedRoutes(new Set(allRouteIds))}>Seleziona tutto</button>
                  <span className="text-slate-600">·</span>
                  <button className="text-slate-300 hover:underline" onClick={() => setSelectedRoutes(new Set())}>Deseleziona tutto</button>
                </div>
                <div className="max-h-56 overflow-auto">
                  {filteredRoutes.map((r) => (
                    <label key={r.id} className="flex items-center gap-2 px-1 py-1 text-xs hover:bg-white/5 rounded cursor-pointer">
                      <input
                        type="checkbox"
                        className="accent-indigo-500"
                        checked={selectedRoutes.has(r.id)}
                        onChange={() => toggleRoute(r.id)}
                      />
                      <span className="truncate flex-1 text-slate-200">{r.label}</span>
                      <span className="text-slate-500 tabular-nums">{r.tripCount}</span>
                    </label>
                  ))}
                  {props.routes.length === 0 && <div className="px-1 py-2 text-[11px] text-slate-500">Nessuna linea</div>}
                  {props.routes.length > 0 && filteredRoutes.length === 0 && (
                    <div className="px-1 py-2 text-[11px] text-slate-500">Nessuna linea per "{routeSearch}"</div>
                  )}
                </div>
              </div>
            )}
          </div>
          <button
            onClick={() => computeMut.mutate()}
            disabled={!from || !to || computeMut.isPending}
            className="px-3 py-1.5 text-sm font-medium rounded-lg bg-gradient-to-r from-indigo-600 to-violet-600 text-white hover:from-indigo-500 hover:to-violet-500 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5 shadow-lg shadow-indigo-900/30 transition-all"
          >
            {computeMut.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
            Calcola
          </button>
          {groups && (
            <div className="ml-auto text-xs text-slate-400">
              <span className="text-slate-200 font-semibold">{groups.length}</span> unità
              {exactGroups != null && exactGroups !== groups.length && (
                <span className="text-emerald-400"> (da {exactGroups} gruppi esatti)</span>
              )} · <span className="text-indigo-300 font-semibold">{selected.size}</span> selezionate
            </div>
          )}
        </div>
        <div className="flex-1 overflow-auto p-3">
          {hasCoverageWarning && (
            <div className="mb-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200 space-y-1">
              <div className="font-semibold flex items-center gap-1.5">⚠ Alcune corse restano fuori dall'UDP</div>
              {coverage && coverage.neverActive > 0 && (
                <div>
                  <strong>{coverage.neverActive}</strong> corse attive nel progetto non hanno validità in nessun giorno del periodo (controlla i bollini nella matrice)
                  {coverage.neverActiveRoutes.length > 0 ? ` — linee: ${coverage.neverActiveRoutes.join(", ")}` : ""}.
                </div>
              )}
              {coverage && coverage.excludedByFilter > 0 && (
                <div>
                  <strong>{coverage.excludedByFilter}</strong> corse escluse dal filtro linee
                  {coverage.excludedRoutes.length > 0 ? ` (${coverage.excludedRoutes.join(", ")})` : ""} — riattiva le linee se le vuoi includere.
                </div>
              )}
              {deselectionLeftover > 0 && (
                <div>
                  <strong>{deselectionLeftover}</strong> corse non rientrerebbero in nessuna unità selezionata: spunta le unità mancanti prima di salvare.
                </div>
              )}
            </div>
          )}
          {!groups && !computeMut.isPending && (
            <div className="text-sm text-slate-400 px-2 py-10 text-center">
              <Sparkles className="h-8 w-8 mx-auto mb-2 text-indigo-400/50" />
              Imposta il range e clicca <strong className="text-indigo-300">Calcola</strong>.
              <div className="text-xs text-slate-500 mt-1">
                Le corse attive di ogni giorno verranno raggruppate per categoria + giorno-tipo + composizione.
              </div>
            </div>
          )}
          {computeMut.isPending && (
            <div className="text-sm text-slate-400 px-2 py-10 text-center flex items-center justify-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin text-indigo-400" />
              Calcolo in corso…
            </div>
          )}
          {groups && groups.length === 0 && (
            <div className="text-sm text-slate-400 px-2 py-10 text-center">
              Nessun gruppo trovato nel range selezionato.
            </div>
          )}
          {groups && groups.length > 0 && (
            <table className="w-full text-sm">
              <thead className="text-[11px] text-slate-400 uppercase tracking-wide">
                <tr className="border-b border-slate-800">
                  <th className="px-2 py-2 text-left">
                    <input
                      type="checkbox"
                      checked={selected.size === groups.length}
                      onChange={toggleAll}
                      className="accent-indigo-500"
                    />
                  </th>
                  <th className="px-2 py-2 text-left font-semibold">Nome</th>
                  <th className="px-2 py-2 text-left font-semibold">Categoria</th>
                  <th className="px-2 py-2 text-left font-semibold">Giorno-Tipo</th>
                  <th className="px-2 py-2 text-right font-semibold">Giorni</th>
                  <th className="px-2 py-2 text-right font-semibold">Corse</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => (
                  <tr key={g.validityId} className="border-b border-slate-800/60 hover:bg-slate-800/30 transition-colors">
                    <td className="px-2 py-2">
                      <input
                        type="checkbox"
                        checked={selected.has(g.validityId)}
                        onChange={() => toggle(g.validityId)}
                        className="accent-indigo-500"
                      />
                    </td>
                    <td className="px-2 py-2">
                      <input
                        type="text"
                        value={names[g.validityId] ?? ""}
                        onChange={(e) => setNames({ ...names, [g.validityId]: e.target.value })}
                        className="w-full px-2 py-1 text-sm bg-slate-950 border border-slate-700 rounded text-slate-100 focus:outline-none focus:border-indigo-500"
                      />
                    </td>
                    <td className="px-2 py-2">
                      {g.categoryName ? (
                        <span
                          className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-xs font-medium border"
                          style={{
                            backgroundColor: (g.categoryColor || "#94a3b8") + "20",
                            borderColor: (g.categoryColor || "#94a3b8") + "50",
                            color: g.categoryColor || "#cbd5e1",
                          }}
                        >
                          <span
                            className="inline-block h-2 w-2 rounded-sm"
                            style={{ backgroundColor: g.categoryColor || "#94a3b8" }}
                          />
                          {g.categoryName}
                        </span>
                      ) : (
                        <span className="text-xs text-slate-500">—</span>
                      )}
                    </td>
                    <td className="px-2 py-2">
                      {g.dayTypeName ? (
                        <span
                          className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-xs font-medium border"
                          style={{
                            backgroundColor: (g.dayTypeColor || "#94a3b8") + "20",
                            borderColor: (g.dayTypeColor || "#94a3b8") + "50",
                            color: g.dayTypeColor || "#cbd5e1",
                          }}
                        >
                          <span
                            className="inline-block h-2 w-2 rounded-sm"
                            style={{ backgroundColor: g.dayTypeColor || "#94a3b8" }}
                          />
                          {g.dayTypeName}
                        </span>
                      ) : (
                        <span className="text-xs text-slate-500">—</span>
                      )}
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums text-slate-300">{g.dates.length}</td>
                    <td className="px-2 py-2 text-right tabular-nums text-slate-300">{g.tripIds.length}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="border-t border-slate-800 px-5 py-3 flex justify-end gap-2 bg-slate-950/50">
          <button
            onClick={props.onClose}
            className="px-3 py-1.5 text-sm rounded-lg border border-slate-700 bg-slate-950 text-slate-300 hover:bg-slate-800 hover:text-slate-100 transition-colors"
          >
            Annulla
          </button>
          <button
            onClick={() => saveMut.mutate()}
            disabled={!groups || selected.size === 0 || saveMut.isPending}
            className="px-4 py-1.5 text-sm font-medium rounded-lg bg-gradient-to-r from-indigo-600 to-violet-600 text-white hover:from-indigo-500 hover:to-violet-500 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5 shadow-lg shadow-indigo-900/30 transition-all"
          >
            {saveMut.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            Salva {selected.size} {selected.size === 1 ? "unità" : "unità"}
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 backdrop-blur-sm p-4">
      <div className="bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl w-full max-w-6xl max-h-[92vh] flex flex-col overflow-hidden text-slate-100">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 bg-gradient-to-r from-fuchsia-500/10 via-violet-500/10 to-transparent">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-fuchsia-500 to-violet-600 flex items-center justify-center shadow-lg shadow-fuchsia-900/30">
              <CalendarIcon className="h-5 w-5 text-white" />
            </div>
            <div>
              <div className="font-semibold text-slate-100 text-base">Categorie Periodi</div>
              <div className="text-xs text-slate-400">
                Attiva una categoria a sinistra, poi clicca i giorni per dipingerli. Riclicca per togliere.
              </div>
            </div>
          </div>
          <button onClick={props.onClose} className="p-2 hover:bg-slate-800 rounded-lg transition-colors text-slate-400 hover:text-slate-100">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 overflow-hidden flex">
          {/* SIDEBAR sinistra: lista categorie */}
          <div className="w-72 border-r border-slate-800 bg-slate-950/40 flex flex-col">
            <div className="px-4 py-3 border-b border-slate-800 bg-slate-900/60">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 mb-1.5">Pennello attivo</div>
              {paintMode === "paint" && activeCat ? (
                <div className="flex items-center gap-2">
                  <span className="inline-block h-5 w-5 rounded border border-slate-700 shadow-sm" style={{ backgroundColor: activeCat.color }} />
                  <span className="text-sm font-semibold text-slate-100 truncate">{activeCat.name}</span>
                </div>
              ) : paintMode === "erase" ? (
                <div className="flex items-center gap-2 text-rose-300">
                  <Eraser className="h-4 w-4" />
                  <span className="text-sm font-semibold">Gomma</span>
                </div>
              ) : (
                <div className="text-xs text-slate-500 italic">Nessuna categoria selezionata</div>
              )}
            </div>
            <div className="flex-1 overflow-auto p-3 space-y-1.5">
              {props.categories.length === 0 && (
                <div className="text-sm text-slate-400 px-2 py-3 text-center border border-dashed border-slate-700 rounded-lg">
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
                        ? "bg-fuchsia-500/10 border-fuchsia-500/50 ring-1 ring-fuchsia-500/30 text-slate-100 shadow-sm"
                        : "bg-slate-950 border-slate-700 hover:border-slate-600 hover:bg-slate-900 text-slate-200"
                    }`}
                  >
                    <span className="inline-block h-5 w-5 rounded border border-slate-700 shadow-sm shrink-0" style={{ backgroundColor: c.color || "#94a3b8" }} />
                    <span className="truncate flex-1 text-left">{c.name}</span>
                    {isActive && <Check className="h-4 w-4 text-fuchsia-300 shrink-0" />}
                  </button>
                );
              })}
              <button
                onClick={() => setPaintMode("erase")}
                className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg border text-sm font-medium mt-3 transition-all ${
                  paintMode === "erase"
                    ? "bg-rose-500/10 border-rose-500/50 ring-1 ring-rose-500/30 text-rose-200 shadow-sm"
                    : "bg-slate-950 border-slate-700 hover:border-rose-500/40 hover:bg-rose-500/5 text-rose-300"
                }`}
              >
                <Eraser className="h-4 w-4 shrink-0" />
                <span className="truncate flex-1 text-left">Gomma (cancella)</span>
                {paintMode === "erase" && <Check className="h-4 w-4 text-rose-300 shrink-0" />}
              </button>
            </div>
            <div className="border-t border-slate-800 p-3 bg-slate-950/40">
              <button
                onClick={props.openCategoryEditor}
                className="w-full px-3 py-2 text-xs rounded-lg border border-slate-700 bg-slate-900 hover:bg-slate-800 text-slate-200 font-semibold flex items-center gap-1.5 justify-center transition-colors"
              >
                <Settings2 className="h-3.5 w-3.5" />
                Gestisci categorie
              </button>
            </div>
          </div>

          {/* CALENDARIO mensile */}
          <div className="flex-1 flex flex-col overflow-hidden bg-slate-900">
            <div className="flex items-center justify-between px-5 py-3 border-b border-slate-800 bg-slate-900/60">
              <div className="flex items-center gap-2">
                <button onClick={goPrev} className="px-3 py-1.5 text-sm rounded-lg border border-slate-700 bg-slate-950 hover:bg-slate-800 text-slate-200 font-medium transition-colors">‹</button>
                <button onClick={goToday} className="px-3 py-1.5 text-xs rounded-lg border border-slate-700 bg-slate-950 hover:bg-slate-800 text-slate-200 font-semibold transition-colors">Oggi</button>
                <button onClick={goNext} className="px-3 py-1.5 text-sm rounded-lg border border-slate-700 bg-slate-950 hover:bg-slate-800 text-slate-200 font-medium transition-colors">›</button>
                <div className="ml-3 text-base font-semibold text-slate-100 capitalize">{monthName}</div>
              </div>
              <div className="text-xs text-slate-400 flex items-center gap-3">
                <span>
                  Click = applica/togli · <kbd className="px-1.5 py-0.5 bg-slate-800 border border-slate-700 rounded text-slate-200 text-[10px] font-mono">SHIFT</kbd>+Click = range
                </span>
                {setMut.isPending && (
                  <span className="text-xs text-fuchsia-300 font-semibold flex items-center gap-1">
                    <Loader2 className="h-3 w-3 animate-spin" /> salvo…
                  </span>
                )}
              </div>
            </div>

            <div className="flex-1 overflow-auto p-5 bg-slate-950/30">
              {/* Intestazione giorni della settimana */}
              <div className="grid grid-cols-7 gap-2 mb-2">
                {["Lun", "Mar", "Mer", "Gio", "Ven", "Sab", "Dom"].map((g, i) => (
                  <div key={g} className={`text-center text-[11px] font-bold uppercase tracking-wider py-1.5 ${i >= 5 ? "text-rose-400" : "text-slate-400"}`}>
                    {g}
                  </div>
                ))}
              </div>
              <div className="grid grid-cols-7 gap-2">
                {cells.map((c, idx) => {
                  if (!c) return <div key={`e-${idx}`} className="h-24 bg-transparent" />;
                  const catId = dateToCatId.get(c.iso);
                  const cat = catId ? catById.get(catId) : undefined;
                  const bg = cat?.color ? `${cat.color}40` : undefined; // ~25% opacity
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
                        c.weekend && !cat ? "bg-rose-950/30 border-slate-800" : !cat ? "bg-slate-900 border-slate-800 hover:border-slate-700" : ""
                      } ${cat ? "border-2 shadow-sm" : ""} ${
                        c.isToday ? "ring-2 ring-sky-400/60 ring-offset-2 ring-offset-slate-950" : ""
                      } disabled:opacity-50 disabled:cursor-wait`}
                      style={cat ? { backgroundColor: bg, borderColor: ringColor } : undefined}
                      title={cat ? `${c.iso} · ${cat.name}${wouldRemove ? "\n(click per togliere)" : ""}` : `${c.iso} · nessuna categoria`}
                    >
                      <div className="flex items-start justify-between">
                        <span className={`text-base font-bold leading-none ${
                          c.isToday ? "text-sky-300" :
                          c.weekend ? "text-rose-300" : "text-slate-100"
                        }`}>{c.day}</span>
                        {c.isToday && (
                          <span className="text-[9px] font-bold text-sky-300 bg-sky-500/15 border border-sky-500/30 rounded px-1 py-0.5 leading-none">OGGI</span>
                        )}
                      </div>
                      {cat && (
                        <div className="mt-2 flex items-center gap-1">
                          <span
                            className="inline-block h-2.5 w-2.5 rounded-full shrink-0 border border-slate-900/30"
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
              <div className="border-t border-slate-800 px-5 py-2.5 bg-slate-950/50 flex items-center gap-4 flex-wrap">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Legenda:</span>
                {props.categories.map((c) => (
                  <span key={c.id} className="inline-flex items-center gap-1.5 text-xs text-slate-200 font-medium">
                    <span className="inline-block h-3 w-3 rounded border border-slate-700 shadow-sm" style={{ backgroundColor: c.color }} />
                    {c.name}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="border-t border-slate-800 px-6 py-3 flex justify-end gap-2 bg-slate-950/50">
          <button
            onClick={props.onClose}
            className="px-4 py-2 text-sm rounded-lg bg-fuchsia-600 text-white hover:bg-fuchsia-500 font-semibold shadow-lg shadow-fuchsia-900/30 transition-colors"
          >
            Chiudi
          </button>
        </div>
      </div>
    </div>
  );
}
