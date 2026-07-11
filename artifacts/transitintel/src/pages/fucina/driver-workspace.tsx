/**
 * DriverWorkspace — Area di Lavoro Turni Guida (interno fucina, step 7)
 *
 * Sorella del VehicleWorkspace ma per i Turni Guida (CSP autisti).
 * Pattern:
 *   ┌──────────────────────────────────────────────────────────┐
 *   │  Toolbar: solver mode + Riottimizza + Config CSP + Save  │
 *   ├──────────────────────────────────────────────────────────┤
 *   │  Summary cards (autisti, ore, %, costo, conformità BDS)  │
 *   ├──────────────────────────────────────────────────────────┤
 *   │  Progress panel (durante CP-SAT)                         │
 *   │  Gantt interattivo turni guida                           │
 *   └──────────────────────────────────────────────────────────┘
 *
 * Espone tutti i 6 nuovi parametri `bds.optimizer.*` introdotti in:
 *   FIX-CSP-1: weightDutyCount (default 20000)
 *   FIX-CSP-2: scorePerDuty (default 100)
 *   HARD: maxCompanyCars (cumulative cap), minWorkPerDuty (saturazione)
 *   SOFT: weightIdlePenalty + idlePenaltyMaxMin (penalizza idle)
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Users, Clock, Timer, Coffee, Repeat, Car, DollarSign, Shield,
  AlertTriangle, Zap, Settings, Play, Save, RotateCcw, Brain, Loader2,
  Download, FileText, FileSpreadsheet, Printer, ChevronDown, Undo2, Redo2, Layers,
  MapPin, Minus, Plus, SlidersHorizontal, Trash2, X,
} from "lucide-react";
import { toast } from "sonner";
import { useLocation } from "wouter";
import { getApiBase } from "@/lib/api";
import { useCrewOptimization, type OperatorConfig } from "@/hooks/use-crew-optimization";
import { OperatorConfigPanel } from "@/components/OperatorConfigPanel";
import { OptimizerRulesPanel } from "@/components/OptimizerRulesPanel";
import { buildDefaultConfig, deepClone, SERVICE_PROFILES, type ServiceType } from "@/lib/optimizer-rules";
import { resolveRuleProfile } from "@/lib/rule-profiles-api";
import { OptimizationProgressPanel } from "@/components/OptimizationProgress";
import InteractiveGantt, { type GanttChange, type GanttBar } from "@/components/InteractiveGantt";
import { SummaryCard } from "@/pages/driver-shifts/components";
import { formatDuration, minToTime } from "@/pages/driver-shifts/constants";
import {
  driverShiftsToRows,
  driverShiftsToBars,
  driverShiftsToTripBars,
  driverShiftsBoundsHours,
  applyDriverTripChange,
  suggestDriversForTrip,
  recomputeSummary,
  diffSummary,
  computeTripCompatibilityMap,
  compatibilityGlow,
  createEmptyDriverShift,
  nextDriverId,
} from "@/pages/driver-shifts/gantt-adapters";
import {
  exportDriverShiftsToPrint,
  exportDriverShiftsToCsv,
  triggerDownload,
} from "@/pages/fucina/DriverShiftsPrintExport";
import type { DriverShiftsResult, DriverShiftSummary, DriverShiftType, DriverActivity, DriverActivityType, RipresaTrip, DriverShiftData } from "@/pages/driver-shifts/types";
import { mkRipresaFromTrips } from "@/pages/driver-shifts/bdsi-tools";
import WorkWindowPanel, { type WorkShiftView } from "@/components/WorkWindowPanel";
import { TYPE_LABELS, ACTIVITY_LABELS, ACTIVITY_COLORS, timeToMin } from "@/pages/driver-shifts/constants";
import { AddDriverShiftDialog } from "@/pages/driver-shifts/AddDriverShiftDialog";
import { AddActivityDialog } from "@/pages/driver-shifts/AddActivityDialog";

interface DriverWorkspaceProps {
  /** ID dello scenario turni macchina (input al solver autisti) */
  vehicleScenarioId: string;
  /** Risultato precaricato (es. da DSS salvato), opzionale */
  initialResult?: DriverShiftsResult | null;
  /** Se valorizzato, apre lo scenario turni guida SALVATO (niente ri-ottimizzazione). */
  dssId?: string | null;
  /** Etichetta GTFS/scenario per display */
  scenarioLabel?: string;
}

/* Default config COMPLETO (tutti i parametri letti da crew_scheduler_v4).
 * Fonte unica: lib/optimizer-rules (default = regole attuali, editabili). */
const DEFAULT_CONFIG: OperatorConfig = buildDefaultConfig("urbano");

export default function DriverWorkspace({
  vehicleScenarioId,
  initialResult,
  dssId,
  scenarioLabel,
}: DriverWorkspaceProps) {
  // ── Routing: ricaviamo il projectId dalla URL per tornare alla home progetto
  //    dopo aver salvato lo scenario turni guida.
  const [currentLocation, navigate] = useLocation();
  const projectIdFromUrl = useMemo(() => {
    const m = currentLocation.match(/\/fucina\/([^/?#]+)/);
    return m?.[1] ?? null;
  }, [currentLocation]);

  const [result, setResult] = useState<DriverShiftsResult | null>(initialResult ?? null);
  const [solverMode, setSolverMode] = useState<"greedy" | "cpsat">("cpsat");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [configOpen, setConfigOpen] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [operatorConfig, setOperatorConfig] = useState<OperatorConfig>(DEFAULT_CONFIG);
  const [serviceType, setServiceTypeState] = useState<ServiceType>("urbano");
  // Cambiando tipo servizio si re-applica il preset dei gruppi service-scoped
  // (regole turno + target), preservando gli altri parametri già modificati.
  const setServiceType = useCallback((t: ServiceType) => {
    setServiceTypeState(t);
    const p = SERVICE_PROFILES[t];
    setOperatorConfig((c) => ({
      ...c,
      bds: { ...c.bds, serviceType: t, shiftRules: deepClone(p.shiftRules), targetWork: { ...p.targetWork } },
    }));
  }, []);
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [dssName, setDssName] = useState("");
  const [savingDss, setSavingDss] = useState(false);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  /* ── Modalità visualizzazione Gantt ──
   *  exploded = 1 bar per corsa (drag-and-drop); aggregated = 1 bar per ripresa (read-only) */
  const [ganttMode, setGanttMode] = useState<"exploded" | "aggregated">("exploded");
  /* ── History undo/redo per modifiche al risultato ── */
  const [history, setHistory] = useState<Array<{ result: DriverShiftsResult; description: string; ts: number }>>([]);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const [modifiedCount, setModifiedCount] = useState(0);
  /* L'ottimizzatore (solver, parametri, config) è visibile solo senza
   * risultato o dopo "Riottimizza": il workspace resta pulito. */
  const [showOptimizer, setShowOptimizer] = useState(false);
  /* ── Finestra di lavoro (bozze, spacchetta/rimpacchetta) ── */
  const [wwOpen, setWwOpen] = useState(false);
  const [wwShiftIds, setWwShiftIds] = useState<string[]>([]);
  const [wwSelected, setWwSelected] = useState<Set<string>>(new Set());
  const [wwPool, setWwPool] = useState<Array<{
    trip?: RipresaTrip;
    activity?: { id: string; type: DriverActivityType; startMin: number; endMin: number; fromNode?: string; toNode?: string };
    importedFrom?: string; udpName?: string;
  }>>([]);
  const wwPoolId = (p: { trip?: RipresaTrip; activity?: { id: string } }) =>
    p.trip ? String(p.trip.tripId) : (p.activity?.id ?? "");
  /* Rimpacchetta stile Bdsi: prima di chiudere il turno si sceglie il DEPOSITO
   * di appartenenza (residenza); la tipologia la rileva la normativa da sola. */
  const [wwDepots, setWwDepots] = useState<Array<{ id: string; name: string; color: string | null }>>([]);
  const [wwRepackAsk, setWwRepackAsk] = useState<{ ids?: string[] } | null>(null);
  const [wwRepackDepot, setWwRepackDepot] = useState<string>("auto");
  /* Verifica normativa puntuale (stile Bdsi): dialogo con tipologia + regole BDS */
  const [wwVerify, setWwVerify] = useState<{ shiftId: string; busy: boolean; type?: string | null; validation?: DriverShiftData["bdsValidation"] | null; residenza?: string | null } | null>(null);
  useEffect(() => {
    if (!wwOpen || wwDepots.length > 0) return;
    void fetch(`${getApiBase()}/api/depots`, { credentials: "include" })
      .then(r => (r.ok ? r.json() : null))
      .then(data => {
        const arr = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : Array.isArray(data?.depots) ? data.depots : [];
        setWwDepots(arr.filter((d: any) => d?.id && d?.name).map((d: any) => ({ id: String(d.id), name: String(d.name), color: d.color ?? null })));
      })
      .catch(() => { /* senza depositi resta solo "Auto" */ });
  }, [wwOpen, wwDepots.length]);
  /* form "nuova attività" della Finestra di lavoro */
  const [wwActOpen, setWwActOpen] = useState(false);
  /* nodi selezionabili per le attività: TUTTE le fermate del sistema + depositi */
  const [wwNodes, setWwNodes] = useState<string[]>([]);
  useEffect(() => {
    if (!wwActOpen || wwNodes.length > 0) return;
    void (async () => {
      const names = new Set<string>();
      try {
        const r = await fetch(`${getApiBase()}/api/gtfs/stops/all`, { credentials: "include" });
        if (r.ok) {
          const data = await r.json();
          for (const st of (data?.stops ?? data?.data ?? data ?? [])) {
            const n = st?.stopName ?? st?.stop_name ?? st?.name;
            if (n) names.add(String(n));
          }
        }
      } catch { /* fallback sotto */ }
      try {
        const r = await fetch(`${getApiBase()}/api/depots`, { credentials: "include" });
        if (r.ok) {
          const data = await r.json();
          for (const d of (data?.depots ?? data?.data ?? data ?? [])) {
            const n = d?.name ?? d?.label;
            if (n) names.add(`Deposito ${n}`);
          }
        }
      } catch { /* opzionale */ }
      // fallback: capolinea presenti nel risultato corrente
      if (result) for (const s of result.driverShifts) for (const rp of s.riprese) for (const tp of rp.trips) {
        if (tp.firstStopName) names.add(tp.firstStopName);
        if (tp.lastStopName) names.add(tp.lastStopName);
      }
      setWwNodes(Array.from(names).sort((a, b) => a.localeCompare(b)));
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wwActOpen]);
  const [wwActForm, setWwActForm] = useState({ type: "riserva" as DriverActivityType, start: "08:00", end: "09:00", fromNode: "", toNode: "" });
  const [wwImportBusy, setWwImportBusy] = useState(false);

  /* ── Baseline KPI per modalità what-if ── */
  const baselineSummaryRef = useRef<DriverShiftSummary | null>(
    initialResult?.summary ? { ...initialResult.summary } : null,
  );

  /* ── Baseline bars per diff (#5) ── */
  const baselineBarsRef = useRef<Map<string, { rowId: string; startMin: number; endMin: number }> | null>(
    initialResult?.driverShifts
      ? new Map(driverShiftsToTripBars(initialResult.driverShifts).map(b => [b.id, { rowId: b.rowId, startMin: b.startMin, endMin: b.endMin }]))
      : null,
  );
  const [showDiff, setShowDiff] = useState(false);
  // ── Pannello modifiche pendenti (#4) ──
  const [showChangesPanel, setShowChangesPanel] = useState(false);
  // ── Glow compatibilità per ogni corsa (#NEW) ──
  const [showCompatGlow, setShowCompatGlow] = useState(false);
  // ── Aggiungi turno guida manuale (#NEW) ──
  const [showAddDriverDialog, setShowAddDriverDialog] = useState(false);
  // ── Aggiungi attività non di guida (Riserva/Presidio/Verifica) ──
  const [showAddActivityDialog, setShowAddActivityDialog] = useState(false);
  const [activityPrefill, setActivityPrefill] = useState<{ driverId?: string; startMin?: number } | null>(null);
  // ── Filtro turni: null = tutti; altrimenti solo i driverId selezionati ──
  const [visibleDrivers, setVisibleDrivers] = useState<Set<string> | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  // ── Menu contestuale (click destro sul Gantt) ──
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; bar: GanttBar } | null>(null);
  // ── Card di dettaglio segmento (click sinistro su un elemento non-corsa) ──
  const [segmentCard, setSegmentCard] = useState<{ x: number; y: number; bar: GanttBar } | null>(null);

  /* ── Cluster di cambio (interchange) per il setup banner ──
   * Sono i nodi dove gli autisti possono cambiare bus in linea senza tornare
   * al deposito. Letti via /api/clusters (include il mirror live PS->legacy). */
  const [interchangeClusters, setInterchangeClusters] = useState<Array<{
    id: string; name: string; color: string; stopCount: number;
  }> | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch(`${getApiBase()}/api/clusters`)
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data: any) => {
        if (cancelled) return;
        const list = Array.isArray(data?.data) ? data.data
                   : Array.isArray(data) ? data
                   : (data?.clusters ?? []);
        // Mostriamo solo cluster effettivamente di cambio (interchange).
        // Il backend marchia is_interchange=true di default; PS clusters
        // logici puri non vengono mirrorati nel legacy quindi non compaiono qui.
        const interchange = list.filter((c: any) =>
          c.isInterchange !== false && Array.isArray(c.stops) && c.stops.length > 0
        );
        setInterchangeClusters(interchange.map((c: any) => ({
          id: String(c.id),
          name: c.name ?? "Cluster",
          color: c.color ?? "#3b82f6",
          stopCount: Array.isArray(c.stops) ? c.stops.length
                   : Array.isArray(c.stopIds) ? c.stopIds.length
                   : (c.stopCount ?? 0),
        })));
      })
      .catch(() => { if (!cancelled) setInterchangeClusters([]); });
    return () => { cancelled = true; };
  }, []);

  const liveSummary = useMemo(() => {
    if (!result || !baselineSummaryRef.current) return result?.summary;
    return recomputeSummary(result.driverShifts, baselineSummaryRef.current);
  }, [result]);

  const summaryDelta = useMemo(() => {
    if (!liveSummary || !baselineSummaryRef.current) return null;
    return diffSummary(liveSummary, baselineSummaryRef.current);
  }, [liveSummary]);

  // ── Highlight target durante drag (#2) ──
  const [rowHighlights, setRowHighlights] = useState<Record<string, string> | undefined>(undefined);

  const handleBarDragStart = useCallback((bar: GanttBar) => {
    if (!result) return;
    const meta: any = bar.meta || {};
    if (meta.type !== "trip" || !meta.tripId) return;
    const suggs = suggestDriversForTrip(result.driverShifts, meta.tripId);
    const map: Record<string, string> = {};
    suggs.slice(0, 3).forEach(s => { map[s.driverId] = "rgba(16, 185, 129, 0.18)"; });
    suggs.slice(3, 8).forEach(s => { map[s.driverId] = "rgba(245, 158, 11, 0.14)"; });
    if (meta.driverId && !map[meta.driverId]) {
      map[meta.driverId] = "rgba(99, 102, 241, 0.12)";
    }
    setRowHighlights(map);
  }, [result]);

  const handleBarDragEnd = useCallback(() => {
    setRowHighlights(undefined);
  }, []);

  const cpsat = useCrewOptimization();

  // ── Carica il profilo-regole di default (azienda ⊕ progetto) come config di
  //    partenza. Una sola volta: non sovrascrive le modifiche live dell'operatore.
  //    1) tipo servizio ereditato dallo scenario turni macchina (input.serviceType);
  //    2) un profilo-regole salvato (azienda ⊕ progetto), se presente, vince.
  //    Sequenziale per evitare race; una sola volta.
  const profileLoadedRef = useRef(false);
  useEffect(() => {
    if (profileLoadedRef.current) return;
    profileLoadedRef.current = true; // guard PRIMA dei fetch: niente race con le modifiche live
    (async () => {
      // base: tipo servizio scelto sullo step turni macchina
      let baseSt: ServiceType = "urbano";
      try {
        if (vehicleScenarioId) {
          const sc = await fetch(`${getApiBase()}/api/service-program/scenarios/${vehicleScenarioId}`).then((r) => (r.ok ? r.json() : null));
          const st = sc?.input?.serviceType as ServiceType | undefined;
          if (st === "urbano" || st === "extraurbano" || st === "misto") baseSt = st;
        }
      } catch { /* best-effort */ }
      setServiceType(baseSt); // applica preset regole del tipo servizio
      // profilo-regole salvato → vince
      try {
        const r = await resolveRuleProfile(projectIdFromUrl);
        if (r?.config) {
          const st = (r.config.bds?.serviceType as ServiceType) ?? baseSt;
          const base = buildDefaultConfig(st);
          setServiceTypeState(st);
          setOperatorConfig({ ...base, ...r.config, bds: { ...base.bds, ...(r.config.bds ?? {}) } } as OperatorConfig);
        }
      } catch { /* nessun profilo → resta sul tipo servizio ereditato */ }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectIdFromUrl, vehicleScenarioId]);

  // Apri uno scenario turni guida SALVATO (dssId): carica il result, niente ottimizzazione.
  const dssLoadedRef = useRef(false);
  useEffect(() => {
    if (dssLoadedRef.current || !dssId || !vehicleScenarioId) return;
    dssLoadedRef.current = true;
    setLoading(true);
    fetch(`${getApiBase()}/api/driver-shifts/${vehicleScenarioId}/scenarios/${dssId}`)
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((row: any) => {
        const res = row?.result as DriverShiftsResult | undefined;
        if (!res || !Array.isArray(res.driverShifts)) throw new Error("Scenario turni guida senza risultato");
        setResult(res);
        baselineSummaryRef.current = res.summary ? { ...res.summary } : null;
        baselineBarsRef.current = res.driverShifts
          ? new Map(driverShiftsToTripBars(res.driverShifts).map((b: GanttBar) => [b.id, { rowId: b.rowId, startMin: b.startMin, endMin: b.endMin }]))
          : null;
        if (row?.name) setDssName(row.name);
      })
      .catch((e: any) => toast.error("Impossibile aprire lo scenario turni guida", { description: e?.message }))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dssId, vehicleScenarioId]);

  // Ricezione risultati CP-SAT
  useEffect(() => {
    if (cpsat.state === "completed" && cpsat.result) {
      setResult(cpsat.result as any);
      baselineSummaryRef.current = (cpsat.result as any)?.summary
        ? { ...(cpsat.result as any).summary }
        : null;
      baselineBarsRef.current = (cpsat.result as any)?.driverShifts
        ? new Map(driverShiftsToTripBars((cpsat.result as any).driverShifts).map((b: GanttBar) => [b.id, { rowId: b.rowId, startMin: b.startMin, endMin: b.endMin }]))
        : null;
      setLoading(false);
      setError(null);
      setHistory([]); setHistoryIdx(-1); setModifiedCount(0);
      {
        const an = (cpsat.result as any).optimizationAnalysis;
        const nT = (cpsat.result as any).summary?.totalDriverShifts ?? "?";
        const verify = an
          ? ` · ${an.nOptimal}/${an.nScenariosRun} scenari all'ottimo · ${an.nSegments} segmenti, ${an.nFeasiblePairs} coppie · ${an.totalElapsedSec}s`
          : "";
        toast.success("Ottimizzazione completata", {
          description: `${nT} turni guida generati${verify}`,
        });
      }
    } else if (cpsat.state === "failed") {
      setError(cpsat.error || "Errore ottimizzazione CP-SAT");
      setLoading(false);
      toast.error("Ottimizzazione fallita", { description: cpsat.error ?? undefined });
    }
  }, [cpsat.state, cpsat.result, cpsat.error]);

  // Lancia ottimizzazione greedy
  const launchGreedy = useCallback(() => {
    if (!vehicleScenarioId) return;
    setLoading(true); setError(null); setResult(null);
    fetch(`${getApiBase()}/api/driver-shifts/${vehicleScenarioId}`)
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(data => {
        setResult(data);
        baselineSummaryRef.current = data?.summary ? { ...data.summary } : null;
        baselineBarsRef.current = data?.driverShifts
          ? new Map(driverShiftsToTripBars(data.driverShifts).map((b: GanttBar) => [b.id, { rowId: b.rowId, startMin: b.startMin, endMin: b.endMin }]))
          : null;
        toast.success("Turni guida (greedy) generati");
      })
      .catch(e => { setError(e.message); toast.error("Errore greedy", { description: e.message }); })
      .finally(() => setLoading(false));
  }, [vehicleScenarioId]);

  // Lancia ottimizzazione CP-SAT (con i nuovi optimizer overrides)
  const launchCPSAT = useCallback(() => {
    if (!vehicleScenarioId) return;
    cpsat.reset();
    setResult(null);
    setError(null);
    // timeLimit: se l'operatore lo ha impostato nel pannello usa quello,
    // altrimenti scala con l'intensità (compat. comportamento precedente).
    const intensity = Number(operatorConfig.solverIntensity ?? 2);
    const computed =
      intensity === 1 ? 90 :
      intensity === 3 ? 480 :
      intensity === 4 ? 900 : 240;
    const panelTL = Number(operatorConfig.timeLimit);
    const timeLimit = panelTL > 0 ? panelTL : computed;
    cpsat.start(vehicleScenarioId, timeLimit, operatorConfig);
    toast.info(`CP-SAT avviato (timeLimit ${timeLimit}s)`, {
      description: "I parametri optimizer (saturazione · cap vetture · idle) sono attivi",
    });
  }, [vehicleScenarioId, cpsat, operatorConfig]);

  const runOptimization = useCallback(() => {
    if (solverMode === "cpsat") launchCPSAT();
    else launchGreedy();
  }, [solverMode, launchCPSAT, launchGreedy]);

  // Salva DSS
  const saveDss = useCallback(async () => {
    if (!vehicleScenarioId || !result || !dssName.trim()) return;
    setSavingDss(true);
    try {
      const resp = await fetch(`${getApiBase()}/api/driver-shifts/${vehicleScenarioId}/scenarios`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: dssName.trim(),
          result,
          config: { ...operatorConfig, solverMode },
        }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      setShowSaveDialog(false); setDssName("");
      toast.success("Scenario turni guida salvato");
      // ── Ritorno alla home del progetto dopo salvataggio turni guida ──
      if (projectIdFromUrl) {
        setTimeout(() => navigate(`/fucina/${projectIdFromUrl}`), 400);
      }
    } catch (e: any) {
      toast.error("Errore salvataggio", { description: e.message });
    } finally {
      setSavingDss(false);
    }
  }, [vehicleScenarioId, result, dssName, operatorConfig, solverMode]);

  /* ── Export handlers ─────────────────────────────────── */
  const handleExportPrint = useCallback(() => {
    if (!result) return;
    setExportMenuOpen(false);
    exportDriverShiftsToPrint(result, {
      scenarioName: scenarioLabel,
      columnsPerPage: 2,
      orientation: "landscape",
    });
    toast.success("Stampa A4 generata", { description: "Si è aperta la finestra di stampa" });
  }, [result, scenarioLabel]);

  const handleExportCsv = useCallback(() => {
    if (!result) return;
    setExportMenuOpen(false);
    const csv = exportDriverShiftsToCsv(result);
    const fname = `turni-guida-${result.date || "export"}-${Date.now()}.csv`;
    triggerDownload(csv, fname, "text/csv;charset=utf-8");
    toast.success("CSV scaricato", { description: fname });
  }, [result]);

  const handleExportJson = useCallback(() => {
    if (!result) return;
    setExportMenuOpen(false);
    const json = JSON.stringify(result, null, 2);
    const fname = `turni-guida-${result.date || "export"}-${Date.now()}.json`;
    triggerDownload(json, fname, "application/json");
    toast.success("JSON scaricato", { description: fname });
  }, [result]);

  // Gantt rows/bars
  const ganttRows = useMemo(() => result ? driverShiftsToRows(result.driverShifts) : [], [result]);
  const ganttBars = useMemo(() => {
    if (!result) return [];
    return ganttMode === "exploded"
      ? driverShiftsToTripBars(result.driverShifts)
      : driverShiftsToBars(result.driverShifts);
  }, [result, ganttMode]);
  const ganttBounds = useMemo(() => result ? driverShiftsBoundsHours(result.driverShifts) : { min: 4, max: 25 }, [result]);

  /* ── Bars con styling diff vs baseline (#5) + glow compatibilità (#NEW) ── */
  const tripCompatMap = useMemo(() => {
    if (!showCompatGlow || !result || ganttMode !== "exploded") return null;
    return computeTripCompatibilityMap(result.driverShifts);
  }, [result, showCompatGlow, ganttMode]);

  const displayBars = useMemo<GanttBar[]>(() => {
    const baseline = (showDiff && baselineBarsRef.current && ganttMode === "exploded")
      ? baselineBarsRef.current
      : null;
    if (!baseline && !tripCompatMap) return ganttBars;
    return ganttBars.map(b => {
      const meta: any = b.meta || {};
      if (meta.type !== "trip") return b;
      let next: GanttBar = b;
      if (tripCompatMap && meta.tripId) {
        const c = tripCompatMap.get(meta.tripId);
        if (c) {
          next = {
            ...next,
            glow: compatibilityGlow(c.level),
            tooltip: [...(next.tooltip ?? []), `⚙ ${c.count} turn${c.count === 1 ? "o" : "i"} alternativ${c.count === 1 ? "o" : "i"} compatibil${c.count === 1 ? "e" : "i"}`],
          };
        }
      }
      if (baseline) {
        const orig = baseline.get(b.id);
        if (!orig) {
          next = { ...next, color: "#06b6d4", tooltip: [...(next.tooltip ?? []), "✨ nuova"] };
        } else {
          const reassigned = orig.rowId !== b.rowId;
          const shifted = orig.startMin !== b.startMin || orig.endMin !== b.endMin;
          if (reassigned && shifted) {
            next = { ...next, color: "#a855f7", tooltip: [...(next.tooltip ?? []), `↔ riassegnata + spostata (era ${orig.rowId} ${minToTime(orig.startMin)})`] };
          } else if (reassigned) {
            next = { ...next, color: "#3b82f6", tooltip: [...(next.tooltip ?? []), `↔ riassegnata (era ${orig.rowId})`] };
          } else if (shifted) {
            next = { ...next, color: "#fbbf24", tooltip: [...(next.tooltip ?? []), `⇄ spostata (era ${minToTime(orig.startMin)}-${minToTime(orig.endMin)})`] };
          } else {
            next = { ...next, style: "dashed" as const };
          }
        }
      }
      return next;
    });
  }, [ganttBars, showDiff, ganttMode, tripCompatMap]);

  /* ── Filtro turni: mostra solo i driver selezionati (null = tutti) ── */
  const shownRows = useMemo(
    () => visibleDrivers ? ganttRows.filter(r => visibleDrivers.has(r.id)) : ganttRows,
    [ganttRows, visibleDrivers],
  );
  const shownBars = useMemo(
    () => visibleDrivers ? displayBars.filter(b => visibleDrivers.has(b.rowId)) : displayBars,
    [displayBars, visibleDrivers],
  );

  /* ── History + drag handler ─────────────────────────── */
  const wwFmtH = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(Math.round(m) % 60).padStart(2, "0")}`;
  const pushHistory = useCallback((newRes: DriverShiftsResult, description: string) => {
    setHistory(prev => {
      // Tronca eventuali "future" se siamo in mezzo
      const truncated = historyIdx >= 0 ? prev.slice(0, historyIdx + 1) : prev;
      // Capacità: max 30
      const next = [...truncated, { result: newRes, description, ts: Date.now() }].slice(-30);
      setHistoryIdx(next.length - 1);
      return next;
    });
    setModifiedCount(c => c + 1);
  }, [historyIdx]);

  /** Aggiunge manualmente un nuovo turno guida vuoto (#NEW). */
  const handleAddDriverShift = useCallback((opts: {
    driverId: string;
    type: DriverShiftType;
    nastroStartMin: number;
    nastroEndMin: number;
  }) => {
    if (!result) return;
    const newShift = createEmptyDriverShift(opts);
    const newShifts = [...result.driverShifts, newShift];
    const newResult: DriverShiftsResult = {
      ...result,
      driverShifts: newShifts,
      summary: recomputeSummary(newShifts, result.summary),
    };
    setResult(newResult);
    pushHistory(newResult, `➕ Nuovo turno ${opts.driverId} (${TYPE_LABELS[opts.type]})`);
    setShowAddDriverDialog(false);
    toast.success("Turno creato", { description: `${opts.driverId} aggiunto al piano (vuoto)` });
  }, [result, pushHistory]);

  /** Aggiunge un'attività non di guida (riserva/presidio/verifica) a un turno. */
  const handleAddActivity = useCallback((opts: {
    driverId: string; type: DriverActivityType; startMin: number; endMin: number; note?: string;
  }) => {
    if (!result) return;
    const dur = Math.max(0, opts.endMin - opts.startMin);
    const activity: DriverActivity = {
      id: `act_${Date.now().toString(36)}`,
      type: opts.type, startMin: opts.startMin, endMin: opts.endMin, note: opts.note,
    };
    const newShifts = result.driverShifts.map(s => {
      if (s.driverId !== opts.driverId) return s;
      const activities = [...(s.activities ?? []), activity];
      // estende il nastro per includere l'attività e la conta come lavoro
      const nastroStartMin = Math.min(s.nastroStartMin, opts.startMin);
      const nastroEndMin = Math.max(s.nastroEndMin, opts.endMin);
      const workMin = s.workMin + dur;
      return {
        ...s,
        activities,
        nastroStartMin, nastroEndMin,
        nastroStart: minToTime(nastroStartMin),
        nastroEnd: minToTime(nastroEndMin),
        nastroMin: nastroEndMin - nastroStartMin,
        workMin,
        work: formatDuration(workMin),
      };
    });
    const newResult: DriverShiftsResult = {
      ...result,
      driverShifts: newShifts,
      summary: recomputeSummary(newShifts, result.summary),
    };
    setResult(newResult);
    pushHistory(newResult, `➕ ${ACTIVITY_LABELS[opts.type]} → ${opts.driverId}`);
    setShowAddActivityDialog(false);
    setActivityPrefill(null);
    toast.success("Attività aggiunta", { description: `${ACTIVITY_LABELS[opts.type]} su ${opts.driverId}` });
  }, [result, pushHistory]);

  /* ── Finestra di lavoro: adapter + spacchetta/rimpacchetta/import ── */
  useEffect(() => { if (result) setShowOptimizer(false); }, [result]);

  const wwShifts = useMemo<WorkShiftView[]>(() => {
    if (!result) return [];
    return wwShiftIds
      .map(id => result.driverShifts.find(s => s.driverId === id))
      .filter((s): s is DriverShiftData => !!s)
      .map(sh => ({
        id: sh.driverId,
        label: sh.driverId,
        sub: `${TYPE_LABELS[sh.type] ?? sh.type} · ${sh.riprese.reduce((n, r) => n + r.trips.length, 0)} corse${sh.residenzaName ? ` · ${sh.residenzaName}` : ""}`,
        unpacked: false,
        activities: sh.riprese.flatMap((r) => r.trips.map(tp => ({
          id: String(tp.tripId), isTrip: true, kindLabel: tp.routeName || "Corsa", kindColor: "#a78bfa",
          timeLabel: `${wwFmtH(tp.departureMin)}→${wwFmtH(tp.arrivalMin)}`,
          desc: `${tp.firstStopName ?? ""} → ${tp.lastStopName ?? ""}`,
          startMin: tp.departureMin, endMin: tp.arrivalMin,
        }))),
      }));
  }, [result, wwShiftIds]);

  const wwDrop = useCallback((rowId: string) => {
    if (!result?.driverShifts.some(s => s.driverId === rowId)) return;
    setWwShiftIds(ids => (ids.includes(rowId) ? ids : [...ids, rowId]));
    setWwOpen(true);
  }, [result]);

  const wwDissolve = useCallback((shiftIds: string[]) => {
    if (!result) return;
    const ids = new Set(shiftIds);
    const freed: RipresaTrip[] = [];
    for (const s of result.driverShifts) {
      if (!ids.has(s.driverId)) continue;
      for (const r of s.riprese) for (const tp of r.trips) freed.push({ ...tp });
    }
    if (!freed.length) return;
    const newRes: DriverShiftsResult = { ...result, driverShifts: result.driverShifts.filter(s => !ids.has(s.driverId)) };
    setResult(newRes);
    pushHistory(newRes, `Finestra di lavoro · spacchettati ${shiftIds.length} turni (${freed.length} corse scoperte)`);
    setWwPool(prev => [...prev, ...freed.map(trip => ({ trip }))]);
    setWwShiftIds(prev => prev.filter(id => !ids.has(id)));
  }, [result, pushHistory]);

  const wwImport = useCallback(async () => {
    setWwImportBusy(true);
    try {
      const r = await fetch(`${getApiBase()}/api/scheduling/vehicle-scenarios/${vehicleScenarioId}/uncovered-imports`, { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      const have = new Set(wwPool.map(wwPoolId));
      const cards: Array<{ trip: RipresaTrip; importedFrom?: string; udpName?: string }> = [];
      for (const s of (data.sources ?? [])) for (const tp of (s.trips ?? [])) {
        if (!tp?.tripId || have.has(String(tp.tripId))) continue;
        have.add(String(tp.tripId));
        cards.push({ trip: { ...tp, vehicleId: tp.vehicleId ?? "", vehicleType: tp.vehicleType ?? "12m" } as RipresaTrip, importedFrom: s.scenarioId, udpName: s.udpName });
      }
      if (!cards.length) { toast.info("Nessuna corsa scoperta nelle UDP con la stessa validità"); return; }
      setWwPool(prev => [...prev, ...cards]);
      toast.success(`${cards.length} corse scoperte importate`);
    } catch (e: any) {
      toast.error("Import scoperte fallito", { description: e?.message });
    } finally { setWwImportBusy(false); }
  }, [wwPool, vehicleScenarioId]);

  const wwRepack = useCallback((onlyIds?: string[], residenza?: { id: string; name: string; color: string | null } | null) => {
    const sel = onlyIds && onlyIds.length ? new Set(onlyIds) : wwSelected;
    if (!result || sel.size === 0) return;
    const srcIds = new Set(wwShiftIds);
    const chosen: RipresaTrip[] = [];
    for (const s of result.driverShifts) {
      if (!srcIds.has(s.driverId)) continue;
      for (const r of s.riprese) for (const tp of r.trips) if (sel.has(String(tp.tripId))) chosen.push({ ...tp });
    }
    const chosenPool = wwPool.filter(p => sel.has(wwPoolId(p)));
    for (const p of chosenPool) if (p.trip) chosen.push({ ...p.trip });
    const chosenActs = chosenPool.filter(p => p.activity).map(p => p.activity!);
    if (!chosen.length) { if (chosenActs.length) toast.info("Seleziona anche almeno una corsa: un turno non può essere fatto di sole attività"); return; }
    chosen.sort((a, b) => a.departureMin - b.departureMin);
    for (let i = 1; i < chosen.length; i++) {
      if (chosen[i].departureMin < chosen[i - 1].arrivalMin) {
        toast.error("Corse sovrapposte", { description: `"${chosen[i - 1].routeName}" e "${chosen[i].routeName}" si accavallano.` });
        return;
      }
    }
    const newId = nextDriverId(result.driverShifts, "FL");
    let split = -1, gmax = 0;
    for (let i = 0; i < chosen.length - 1; i++) {
      const g = chosen[i + 1].departureMin - chosen[i].arrivalMin;
      if (g > gmax) { gmax = g; split = i; }
    }
    const chunks = gmax >= 60 && split >= 0 ? [chosen.slice(0, split + 1), chosen.slice(split + 1)] : [chosen];
    const riprese = chunks.map(c => mkRipresaFromTrips(c, String((c[0] as any).vehicleId ?? ""), String((c[0] as any).vehicleType ?? "12m")));
    const aS = riprese[0].startMin, aE = riprese[riprese.length - 1].endMin;
    const newShift = {
      driverId: newId, type: "intero" as DriverShiftType,
      nastroStart: wwFmtH(aS), nastroEnd: wwFmtH(aE), nastroStartMin: aS, nastroEndMin: aE,
      nastroMin: aE - aS, nastro: formatDuration(aE - aS),
      workMin: riprese.reduce((a, r) => a + r.workMin, 0), work: formatDuration(riprese.reduce((a, r) => a + r.workMin, 0)),
      interruptionMin: riprese.length === 2 ? Math.max(0, riprese[1].startMin - riprese[0].endMin) : 0,
      interruption: riprese.length === 2 ? formatDuration(Math.max(0, riprese[1].startMin - riprese[0].endMin)) : null,
      transferMin: 0, transferBackMin: 0, preTurnoMin: 0, cambiCount: 0, riprese,
      // attività standard (riserva/presidio = verde, taxi = giallo) inserite dal pool
      ...(chosenActs.length ? { activities: chosenActs.map(a => ({
        id: a.id, type: a.type, startMin: a.startMin, endMin: a.endMin,
        note: [a.fromNode, a.toNode].filter(Boolean).join(" → ") || undefined,
      })) } : {}),
      // deposito di appartenenza scelto dall'operatore alla chiusura (stile Bdsi)
      ...(residenza ? { residenzaDepotId: residenza.id, residenzaName: residenza.name, residenzaColor: residenza.color } : {}),
      verifyState: "da_verificare" as const,
    } as DriverShiftData;
    const chosenIds = new Set(chosen.map(tp => String(tp.tripId)));
    const kept = result.driverShifts
      .map(s => {
        if (!srcIds.has(s.driverId)) return s;
        const rp = s.riprese
          .map(r => ({ ...r, trips: r.trips.filter(tp => !chosenIds.has(String(tp.tripId))) }))
          .filter(r => r.trips.length > 0);
        return rp.length === 0 ? null : { ...s, riprese: rp };
      })
      .filter((s): s is DriverShiftData => !!s);
    const newRes: DriverShiftsResult = { ...result, driverShifts: [...kept, newShift] };
    setResult(newRes);
    pushHistory(newRes, `Finestra di lavoro · rimpacchettato ${newId} (${chosen.length} corse)`);
    const usedActIds = new Set(chosenActs.map(a => a.id));
    setWwPool(prev => prev.filter(p => !chosenIds.has(wwPoolId(p)) && !usedActIds.has(wwPoolId(p))));
    setWwSelected(prev => new Set([...prev].filter(id => !chosenIds.has(id) && !usedActIds.has(id))));
    // ri-verifica FONTE UNICA: tipologia + fuorilinea automatici sul turno nuovo
    void fetch(`${getApiBase()}/api/driver-shifts/tools/validate`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shifts: [newShift], config: operatorConfig }),
    }).then(r => (r.ok ? r.json() : null)).then(data => {
      const rr = data?.results?.[newId];
      if (!rr || rr.error) return;
      setResult(cur => cur ? {
        ...cur,
        driverShifts: cur.driverShifts.map(s => s.driverId === newId ? {
          ...s,
          type: (rr.type as DriverShiftType) ?? s.type,
          bdsValidation: rr.bdsValidation ?? s.bdsValidation,
          ...(typeof rr.transferMin === "number" ? { preTurnoMin: rr.preTurnoMin ?? 0, transferMin: rr.transferMin ?? 0, transferBackMin: rr.transferBackMin ?? 0 } : {}),
          riprese: s.riprese.map((rp2, i, arr) => ({
            ...rp2,
            ...(i === 0 ? { preTurnoMin: rr.preTurnoMin ?? rp2.preTurnoMin, transferMin: rr.transferMin ?? rp2.transferMin, transferType: (rr.transferMin ?? 0) > 0 ? "depot_to_start" : rp2.transferType } : {}),
            ...(i === arr.length - 1 ? { transferBackMin: rr.transferBackMin ?? rp2.transferBackMin, transferBackType: (rr.transferBackMin ?? 0) > 0 ? "end_to_depot" : rp2.transferBackType } : {}),
          })),
        } : s),
      } : cur);
      // feedback stile Bdsi: la tipologia rilevata compare appena la normativa risponde
      if (rr.type) toast.success(`Tipologia rilevata: ${TYPE_LABELS[rr.type as DriverShiftType] ?? rr.type}`, {
        description: `${newId}${residenza ? ` · deposito ${residenza.name}` : ""}`,
      });
    }).catch(() => { /* la tipologia resta da verificare */ });
    const importedPacked = chosenPool.filter(p => p.importedFrom && p.trip);
    if (importedPacked.length) {
      void (async () => {
        const bySrc = new Map<string, string[]>();
        for (const p of importedPacked) bySrc.set(p.importedFrom!, [...(bySrc.get(p.importedFrom!) ?? []), String(p.trip!.tripId)]);
        for (const [scenId, tripIds] of bySrc) {
          try {
            const gr = await fetch(`${getApiBase()}/api/service-program/scenarios/${scenId}`, { credentials: "include" });
            if (!gr.ok) continue;
            const sc = await gr.json();
            const rm = new Set(tripIds);
            await fetch(`${getApiBase()}/api/service-program/scenarios/${scenId}`, {
              method: "PUT", credentials: "include", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ name: sc.name, result: { ...sc.result, unassigned: ((sc.result?.unassigned ?? []) as any[]).filter(u => !rm.has(String(u?.tripId))) } }),
            });
          } catch { /* best-effort */ }
        }
      })();
    }
    toast.success(`Turno guida ${newId} creato`, { description: `${chosen.length} corse · tipologia e fuorilinea in verifica automatica.` });
  }, [result, wwShiftIds, wwSelected, wwPool, pushHistory, operatorConfig]);

  /* Anteprima LIVE della tipologia per le bozze (stile Bdsi): monta un turno
   * temporaneo con le card della bozza e chiede alla normativa che tipo è. */
  const wwPreviewType = useCallback(async (ids: string[]): Promise<string | null> => {
    const sel = new Set(ids);
    const chosen: RipresaTrip[] = [];
    if (result) {
      const srcIds = new Set(wwShiftIds);
      for (const s of result.driverShifts) {
        if (!srcIds.has(s.driverId)) continue;
        for (const r of s.riprese) for (const tp of r.trips) if (sel.has(String(tp.tripId))) chosen.push({ ...tp });
      }
    }
    for (const p of wwPool) if (p.trip && sel.has(wwPoolId(p))) chosen.push({ ...p.trip });
    if (!chosen.length) return null;
    chosen.sort((a, b) => a.departureMin - b.departureMin);
    for (let i = 1; i < chosen.length; i++) if (chosen[i].departureMin < chosen[i - 1].arrivalMin) return "⚠ corse sovrapposte";
    let split = -1, gmax = 0;
    for (let i = 0; i < chosen.length - 1; i++) {
      const g = chosen[i + 1].departureMin - chosen[i].arrivalMin;
      if (g > gmax) { gmax = g; split = i; }
    }
    const chunks = gmax >= 60 && split >= 0 ? [chosen.slice(0, split + 1), chosen.slice(split + 1)] : [chosen];
    const riprese = chunks.map(c => mkRipresaFromTrips(c, String((c[0] as any).vehicleId ?? ""), String((c[0] as any).vehicleType ?? "12m")));
    const aS = riprese[0].startMin, aE = riprese[riprese.length - 1].endMin;
    const probe = {
      driverId: "PREVIEW", type: "intero" as DriverShiftType,
      nastroStart: wwFmtH(aS), nastroEnd: wwFmtH(aE), nastroStartMin: aS, nastroEndMin: aE,
      nastroMin: aE - aS, nastro: formatDuration(aE - aS),
      workMin: riprese.reduce((a, r) => a + r.workMin, 0), work: formatDuration(riprese.reduce((a, r) => a + r.workMin, 0)),
      interruptionMin: riprese.length === 2 ? Math.max(0, riprese[1].startMin - riprese[0].endMin) : 0,
      interruption: null, transferMin: 0, transferBackMin: 0, preTurnoMin: 0, cambiCount: 0, riprese,
      verifyState: "da_verificare" as const,
    } as DriverShiftData;
    try {
      const r = await fetch(`${getApiBase()}/api/driver-shifts/tools/validate`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shifts: [probe], config: operatorConfig }),
      });
      if (!r.ok) return null;
      const data = await r.json();
      const rr = data?.results?.PREVIEW;
      return rr?.type ? (TYPE_LABELS[rr.type as DriverShiftType] ?? String(rr.type)) : null;
    } catch { return null; }
  }, [result, wwShiftIds, wwPool, operatorConfig]);

  /* Verifica normativa PUNTUALE su un turno della finestra (dialogo stile Bdsi) */
  const wwVerifyShift = useCallback(async (shiftId: string) => {
    const sh = result?.driverShifts.find(s => s.driverId === shiftId);
    if (!sh) return;
    setWwVerify({ shiftId, busy: true, residenza: sh.residenzaName ?? null });
    try {
      const r = await fetch(`${getApiBase()}/api/driver-shifts/tools/validate`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shifts: [sh], config: operatorConfig }),
      });
      const data = r.ok ? await r.json() : null;
      const rr = data?.results?.[shiftId];
      setWwVerify({
        shiftId, busy: false, residenza: sh.residenzaName ?? null,
        type: rr?.type ? (TYPE_LABELS[rr.type as DriverShiftType] ?? String(rr.type)) : (TYPE_LABELS[sh.type] ?? sh.type),
        validation: rr?.bdsValidation ?? sh.bdsValidation ?? null,
      });
    } catch {
      setWwVerify({ shiftId, busy: false, residenza: sh.residenzaName ?? null, type: TYPE_LABELS[sh.type] ?? sh.type, validation: sh.bdsValidation ?? null });
    }
  }, [result, operatorConfig]);

  // Tipi di segmento eliminabili dal Gantt (tutto tranne le corse: fuori linea,
  // taxi/auto aziendale, pre-turno, attività).
  const DELETABLE = new Set(["transfer", "transferBack", "carpool", "activity", "preTurno"]);
  /** Elimina un segmento non-corsa dal turno (fuori linea, taxi/auto aziendale, attività). */
  const deleteSegment = useCallback((bar: GanttBar) => {
    if (!result) return;
    const meta: any = bar.meta || {};
    if (!DELETABLE.has(meta.type)) return;
    const driverId = meta.driverId ?? bar.rowId;
    const ri = meta.ripreseIdx;
    let label = "";
    const newShifts = result.driverShifts.map(s => {
      if (s.driverId !== driverId) return s;
      if (meta.type === "activity") {
        const act = (s.activities ?? []).find(a => a.id === meta.activityId);
        const dur = act ? Math.max(0, act.endMin - act.startMin) : 0;
        const workMin = Math.max(0, s.workMin - dur);
        label = "attività";
        return { ...s, activities: (s.activities ?? []).filter(a => a.id !== meta.activityId), workMin, work: formatDuration(workMin) };
      }
      const riprese = s.riprese.map((r, i) => {
        if (i !== ri) return r;
        if (meta.type === "carpool") { label = "taxi / auto aziendale"; return { ...r, ...(meta.cpIndex === 1 ? { carPoolReturn: null } : { carPoolOut: null }) }; }
        if (meta.type === "transfer") { label = "fuori linea (andata)"; return { ...r, transferMin: 0 }; }
        if (meta.type === "transferBack") { label = "fuori linea (rientro)"; return { ...r, transferBackMin: 0 }; }
        if (meta.type === "preTurno") { label = "pre-turno"; return { ...r, preTurnoMin: 0 }; }
        return r;
      });
      return { ...s, riprese };
    });
    if (!label) return;
    const newResult: DriverShiftsResult = { ...result, driverShifts: newShifts, summary: recomputeSummary(newShifts, result.summary) };
    setResult(newResult);
    pushHistory(newResult, `🗑 Rimosso ${label} · ${driverId}`);
    toast.success(`Rimosso: ${label}`, { description: "Annullabile con Undo" });
  }, [result, pushHistory]);

  const handleBarChange = useCallback((change: GanttChange) => {
    if (!result) return;
    // Ignora bar non-trip (locked)
    const bar = ganttBars.find(b => b.id === change.barId);
    if (!bar || bar.meta?.type !== "trip") return;
    if (change.fromRowId === change.toRowId && change.oldStartMin === change.newStartMin) return;

    const tripId: string | undefined = bar.meta?.tripId;
    if (!tripId) return;

    const { shifts: newShifts, movedTrip, warning } = applyDriverTripChange(
      result.driverShifts,
      {
        tripId,
        fromDriverId: change.fromRowId,
        toDriverId: change.toRowId,
        newStartMin: change.newStartMin,
        newEndMin: change.newEndMin,
      },
    );
    if (warning) { toast.warning(warning); return; }

    const reassigned = change.fromRowId !== change.toRowId;
    const shifted = change.newStartMin !== change.oldStartMin;
    const desc = reassigned && shifted
      ? `${movedTrip?.routeName} ${change.fromRowId}→${change.toRowId} (${change.newStartMin - change.oldStartMin > 0 ? "+" : ""}${change.newStartMin - change.oldStartMin}′)`
      : reassigned
        ? `${movedTrip?.routeName} ${change.fromRowId}→${change.toRowId}`
        : `${movedTrip?.routeName} ${change.newStartMin - change.oldStartMin > 0 ? "+" : ""}${change.newStartMin - change.oldStartMin}′`;

    const newResult: DriverShiftsResult = { ...result, driverShifts: newShifts };
    setResult(newResult);
    pushHistory(newResult, desc);
    toast.success("Corsa spostata", { description: desc });
  }, [result, ganttBars, pushHistory]);

  const canUndo = historyIdx > 0;
  const canRedo = historyIdx >= 0 && historyIdx < history.length - 1;

  const handleUndo = useCallback(() => {
    if (!canUndo) return;
    const newIdx = historyIdx - 1;
    setHistoryIdx(newIdx);
    setResult(history[newIdx].result);
    toast.info("Annullato");
  }, [canUndo, historyIdx, history]);

  const handleRedo = useCallback(() => {
    if (!canRedo) return;
    const newIdx = historyIdx + 1;
    setHistoryIdx(newIdx);
    setResult(history[newIdx].result);
    toast.info("Ripristinato");
  }, [canRedo, historyIdx, history]);

  // Jump to a specific history entry (#4)
  const jumpToHistory = useCallback((idx: number) => {
    if (idx < 0 || idx >= history.length) return;
    setHistoryIdx(idx);
    setResult(history[idx].result);
  }, [history]);

  // Keyboard shortcuts: Cmd/Ctrl+Z = undo, Cmd/Ctrl+Shift+Z = redo
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || target?.isContentEditable) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) handleRedo();
        else handleUndo();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleUndo, handleRedo]);

  const optimizerCfg = operatorConfig.bds?.optimizer;

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* ── Toolbar ───────────────────────────────────── */}
      <div className="shrink-0 px-4 py-2 border-b border-purple-500/15 bg-purple-950/15 flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <Users className="w-4 h-4 text-purple-300/70" />
          <span className="text-xs font-medium text-purple-200">{(!result || showOptimizer) ? "Solver:" : "Area di Lavoro"}</span>
          {(!result || showOptimizer) && (
          <div className="flex rounded-md overflow-hidden border border-purple-500/30">
            <button
              onClick={() => setSolverMode("greedy")}
              className={`px-2.5 py-1 text-[11px] font-medium transition ${
                solverMode === "greedy"
                  ? "bg-purple-500/30 text-white"
                  : "text-purple-300/60 hover:bg-purple-500/10"
              }`}
            >
              ⚡ Greedy
            </button>
            <button
              onClick={() => setSolverMode("cpsat")}
              className={`px-2.5 py-1 text-[11px] font-medium transition flex items-center gap-1 ${
                solverMode === "cpsat"
                  ? "bg-purple-500/30 text-white"
                  : "text-purple-300/60 hover:bg-purple-500/10"
              }`}
            >
              <Brain className="w-3 h-3" /> CP-SAT
            </button>
          </div>
          )}
          {scenarioLabel && (
            <span className="text-[10px] text-purple-300/40 font-mono px-1.5 py-0.5 bg-purple-500/5 rounded border border-purple-500/10 ml-1 truncate max-w-[200px]">
              {scenarioLabel}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {/* Quick view dei parametri optimizer attivi */}
          {(!result || showOptimizer) && solverMode === "cpsat" && optimizerCfg && (
            <div className="hidden lg:flex items-center gap-1.5 text-[10px] text-purple-300/60 px-2 py-1 rounded border border-purple-500/15 bg-purple-500/5">
              <span title="Min lavoro/turno">⏱ {optimizerCfg.minWorkPerDuty ?? 360}min</span>
              <span className="text-purple-500/30">·</span>
              <span title="Max vetture aziendali">🚗 ≤{optimizerCfg.maxCompanyCars ?? 5}</span>
              <span className="text-purple-500/30">·</span>
              <span title="Peso N turni">N·{optimizerCfg.weightDutyCount ?? 20000}</span>
              <span className="text-purple-500/30">·</span>
              <span title="Score per duty">+{optimizerCfg.scorePerDuty ?? 100}/duty</span>
            </div>
          )}
          {(!result || showOptimizer) && (
          <>
          <button
            onClick={() => setRulesOpen(true)}
            className="flex items-center gap-1.5 text-[11px] text-indigo-300 px-2.5 py-1 rounded border border-indigo-500/30 bg-indigo-500/8 hover:bg-indigo-500/15 transition"
          >
            <SlidersHorizontal className="w-3 h-3" /> Parametri & Regole
          </button>
          <button
            onClick={() => setConfigOpen(true)}
            className="flex items-center gap-1.5 text-[11px] text-purple-300 px-2.5 py-1 rounded border border-purple-500/30 bg-purple-500/8 hover:bg-purple-500/15 transition"
          >
            <Settings className="w-3 h-3" /> Config CSP
          </button>
          </>
          )}
          <button
            onClick={() => setWwOpen(o => !o)}
            title="Finestra di lavoro: trascina turni interi, spacchetta, componi bozze e rimpacchetta"
            className={`flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded border transition ${wwOpen ? "border-purple-500/50 bg-purple-500/20 text-purple-200" : "border-purple-500/30 text-purple-300/70 hover:bg-purple-500/10"}`}
          >
            🪟 Finestra di lavoro{wwShiftIds.length > 0 ? ` (${wwShiftIds.length})` : ""}
          </button>
          <button
            onClick={() => {
              if (result && !showOptimizer) { setShowOptimizer(true); toast.info("Parametri ottimizzatore riaperti", { description: "Regola solver e parametri, poi premi di nuovo per rilanciare." }); return; }
              runOptimization();
            }}
            disabled={loading || cpsat.state === "starting" || cpsat.state === "running"}
            className="flex items-center gap-1.5 text-[11px] font-medium text-white px-3 py-1.5 rounded-lg bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-500 hover:to-pink-500 disabled:opacity-50 disabled:cursor-not-allowed transition"
          >
            {(loading || cpsat.state === "starting" || cpsat.state === "running") ? (
              <><Loader2 className="w-3.5 h-3.5 animate-spin" /> In corso…</>
            ) : result ? (
              <><RotateCcw className="w-3.5 h-3.5" /> Riottimizza</>
            ) : (
              <><Play className="w-3.5 h-3.5" /> Genera Turni Guida</>
            )}
          </button>
          {result && (
            <button
              onClick={() => setShowSaveDialog(true)}
              className="flex items-center gap-1.5 text-[11px] text-emerald-300 px-2.5 py-1 rounded border border-emerald-500/30 bg-emerald-500/8 hover:bg-emerald-500/15 transition"
            >
              <Save className="w-3 h-3" /> Salva DSS
            </button>
          )}
          {result && (
            <div className="relative">
              <button
                onClick={() => setExportMenuOpen(v => !v)}
                onBlur={() => setTimeout(() => setExportMenuOpen(false), 150)}
                className="flex items-center gap-1.5 text-[11px] text-blue-300 px-2.5 py-1 rounded border border-blue-500/30 bg-blue-500/8 hover:bg-blue-500/15 transition"
              >
                <Download className="w-3 h-3" /> Esporta
                <ChevronDown className={`w-3 h-3 transition-transform ${exportMenuOpen ? "rotate-180" : ""}`} />
              </button>
              {exportMenuOpen && (
                <div className="absolute right-0 top-full mt-1 z-30 bg-zinc-900 border border-blue-500/30 rounded-lg shadow-xl py-1 min-w-[200px]">
                  <button
                    onMouseDown={handleExportPrint}
                    className="w-full text-left px-3 py-2 text-[11px] text-blue-200 hover:bg-blue-500/15 flex items-center gap-2 transition"
                  >
                    <Printer className="w-3.5 h-3.5" />
                    <div>
                      <div className="font-medium">Stampa A4 dettagliata</div>
                      <div className="text-[10px] text-blue-300/50">turni · corse · BDS · KPI</div>
                    </div>
                  </button>
                  <button
                    onMouseDown={handleExportCsv}
                    className="w-full text-left px-3 py-2 text-[11px] text-blue-200 hover:bg-blue-500/15 flex items-center gap-2 transition"
                  >
                    <FileSpreadsheet className="w-3.5 h-3.5" />
                    <div>
                      <div className="font-medium">CSV (1 riga = 1 corsa)</div>
                      <div className="text-[10px] text-blue-300/50">apri in Excel/Numbers</div>
                    </div>
                  </button>
                  <button
                    onMouseDown={handleExportJson}
                    className="w-full text-left px-3 py-2 text-[11px] text-blue-200 hover:bg-blue-500/15 flex items-center gap-2 transition"
                  >
                    <FileText className="w-3.5 h-3.5" />
                    <div>
                      <div className="font-medium">JSON completo</div>
                      <div className="text-[10px] text-blue-300/50">struttura dati grezza</div>
                    </div>
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── Body scrollable ───────────────────────────── */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {/* Progress panel CP-SAT */}
        {solverMode === "cpsat" && (cpsat.state === "starting" || cpsat.state === "running" || cpsat.state === "stopped" || (cpsat.state === "failed" && !result)) && (
          <OptimizationProgressPanel
            state={cpsat.state}
            progress={cpsat.progress}
            progressHistory={cpsat.progressHistory}
            elapsedSec={cpsat.elapsedSec}
            onStop={cpsat.stop}
          />
        )}

        {/* Error banner */}
        {error && cpsat.state !== "running" && cpsat.state !== "starting" && (
          <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3 text-sm text-red-400 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <div>{error}</div>
          </div>
        )}

        {/* Setup banner — appare quando non c'e ancora un risultato */}
        {!result && !loading && cpsat.state !== "running" && cpsat.state !== "starting" && (
          <div className="rounded-2xl border border-purple-500/30 bg-gradient-to-br from-purple-950/40 via-zinc-950 to-black p-6">
            <div className="flex items-center gap-3 mb-5">
              <div className="w-10 h-10 rounded-xl bg-purple-500/15 border border-purple-500/40 flex items-center justify-center">
                <Users className="w-5 h-5 text-purple-300" />
              </div>
              <div>
                <h3 className="text-base font-semibold text-purple-100">CSP · Ottimizzatore Turni Guida</h3>
                <p className="text-xs text-zinc-400">
                  Verifica i parametri principali prima di lanciare l'ottimizzazione.
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
              {/* Cluster di cambio */}
              <div className="rounded-xl border border-zinc-800 bg-black/40 p-4">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <MapPin className="w-4 h-4 text-orange-400" />
                    <span className="text-xs font-semibold uppercase tracking-wider text-zinc-200">
                      Cluster di cambio
                    </span>
                  </div>
                  <span className="text-[10px] font-mono text-zinc-500">
                    {interchangeClusters == null ? "…" : `${interchangeClusters.length} cluster`}
                  </span>
                </div>
                <p className="text-[11px] text-zinc-500 mb-3 leading-relaxed">
                  I cluster definiscono i punti dove gli autisti possono cambiare bus in linea
                  (cambio cross-cluster). Vengono caricati dal Planning Studio in tempo reale.
                </p>
                {interchangeClusters == null ? (
                  <div className="text-xs text-zinc-500 flex items-center gap-2 py-3">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" /> Caricamento cluster…
                  </div>
                ) : interchangeClusters.length === 0 ? (
                  <div className="text-xs text-amber-300/80 bg-amber-500/5 border border-amber-500/20 rounded-lg p-3">
                    Nessun cluster di cambio configurato. Gli autisti potranno cambiare solo
                    al rientro deposito. Definisci cluster di tipo <em>Di Cambio</em> nel
                    Planning Studio del progetto network.
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-1.5 max-h-32 overflow-y-auto">
                    {interchangeClusters.map(c => (
                      <span key={c.id}
                        className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] font-medium border"
                        style={{
                          background: `${c.color}15`,
                          borderColor: `${c.color}55`,
                          color: c.color,
                        }}
                        title={`${c.stopCount} fermate`}
                      >
                        <span className="w-2 h-2 rounded-full" style={{ background: c.color }} />
                        {c.name}
                        <span className="font-mono opacity-60">{c.stopCount}</span>
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {/* Tipo di ottimizzazione (profilo normativo) */}
              <div className="rounded-xl border border-zinc-800 bg-black/40 p-4">
                <div className="flex items-center gap-2 mb-3">
                  <span className="text-xs font-semibold uppercase tracking-wider text-zinc-200">Tipo di ottimizzazione</span>
                </div>
                <p className="text-[11px] text-zinc-500 mb-3 leading-relaxed">
                  Profilo regole turni guida. I limiti percentuali sono flessibili (soft): il solver li rispetta se possibile.
                </p>
                <div className="flex gap-2">
                  {([
                    { key: "urbano", label: "Urbano" },
                    { key: "extraurbano", label: "Extraurbano" },
                    { key: "misto", label: "Misto" },
                  ] as const).map((o) => (
                    <button
                      key={o.key}
                      type="button"
                      onClick={() => setServiceType(o.key)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${
                        serviceType === o.key
                          ? "border-purple-400 bg-purple-500/15 text-purple-200"
                          : "border-zinc-700 text-zinc-400 hover:text-purple-200 hover:border-purple-500/40"
                      }`}
                    >
                      {o.label}
                    </button>
                  ))}
                </div>
                <p className="text-[10px] text-zinc-600 mt-2">
                  {serviceType === "urbano" && "Unico 7h15 · semiunico interr. 75'–179' · spezzato max 13%."}
                  {serviceType === "extraurbano" && "Unico 8h · semiunico interr. 40'–2h59'/9h · spezzato ≥3h/10h30 (max 9%) · semiunici max 39%."}
                  {serviceType === "misto" && "Profilo combinato (urbano+extraurbano). Logica mista dettagliata in arrivo."}
                </p>
                {/* Media oraria giornaliera scelta dall'operatore (per deposito) */}
                <div className="mt-3 flex items-center gap-2">
                  <span className="text-[11px] text-zinc-400">Media oraria giornaliera</span>
                  <input
                    type="number" min={300} max={540} step={1}
                    value={operatorConfig.bds?.targetWork?.mid ?? 408}
                    onChange={(e) => {
                      const mid = Math.max(300, Math.min(540, Number(e.target.value) || 408));
                      setOperatorConfig((c) => ({ ...c, bds: { ...c.bds, targetWork: { low: mid, high: mid, mid } } }));
                    }}
                    className="w-20 px-2 py-1 text-xs rounded bg-black/40 border border-zinc-700 text-zinc-100"
                    title="Orario medio di riferimento per le rotazioni (es. 402 = 6h42, 390 = 6h30)"
                  />
                  <span className="text-[10px] text-zinc-500 font-mono">
                    min = {Math.floor((operatorConfig.bds?.targetWork?.mid ?? 408) / 60)}h{String((operatorConfig.bds?.targetWork?.mid ?? 408) % 60).padStart(2, "0")}
                  </span>
                </div>

                {/* Intensità ottimizzazione = quanti scenari il portfolio CP-SAT esplora.
                    Più scenari = più esplorazione (non più tempo: l'ottimo per scenario è già dimostrato). */}
                <div className="mt-3">
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-[11px] text-zinc-400">Intensità (scenari esplorati)</span>
                    <span className="text-[10px] text-zinc-600">più scenari = più esplorazione</span>
                  </div>
                  <div className="grid grid-cols-4 gap-1.5">
                    {([
                      { lvl: 1, label: "Rapida", n: 14, t: 90 },
                      { lvl: 2, label: "Media", n: 24, t: 240 },
                      { lvl: 3, label: "Alta", n: 36, t: 480 },
                      { lvl: 4, label: "Massima", n: 48, t: 900 },
                    ]).map((o) => {
                      const active = Number(operatorConfig.solverIntensity ?? 2) === o.lvl;
                      return (
                        <button
                          key={o.lvl}
                          type="button"
                          onClick={() => setOperatorConfig((c) => ({ ...c, solverIntensity: o.lvl, timeLimit: o.t }))}
                          className={`flex flex-col items-center gap-0.5 py-1.5 rounded-lg border text-[11px] font-medium transition ${
                            active
                              ? "bg-indigo-500/20 border-indigo-500 text-indigo-200"
                              : "bg-zinc-900 border-zinc-700 text-zinc-400 hover:bg-zinc-800"
                          }`}
                        >
                          <span className="font-semibold">{o.label}</span>
                          <span className="text-[9px] opacity-70">{o.n} scenari</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>

              {/* Numero auto aziendali */}
              <div className="rounded-xl border border-zinc-800 bg-black/40 p-4">
                <div className="flex items-center gap-2 mb-3">
                  <Car className="w-4 h-4 text-emerald-400" />
                  <span className="text-xs font-semibold uppercase tracking-wider text-zinc-200">
                    Auto aziendali per cambi
                  </span>
                </div>
                <p className="text-[11px] text-zinc-500 mb-4 leading-relaxed">
                  Numero massimo di vetture aziendali disponibili per portare gli autisti
                  ai punti di cambio. Limita quanti cambi simultanei sono possibili.
                </p>
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => setOperatorConfig(cfg => ({
                      ...cfg,
                      bds: {
                        ...cfg.bds,
                        optimizer: {
                          ...cfg.bds?.optimizer,
                          maxCompanyCars: Math.max(0, (cfg.bds?.optimizer?.maxCompanyCars ?? 5) - 1),
                        },
                      },
                    }))}
                    className="w-9 h-9 rounded-lg border border-zinc-700 bg-zinc-900 hover:border-emerald-500/50 hover:text-emerald-300 text-zinc-400 flex items-center justify-center transition-colors"
                  >
                    <Minus className="w-4 h-4" />
                  </button>
                  <input
                    type="number"
                    min={0}
                    max={50}
                    value={operatorConfig.bds?.optimizer?.maxCompanyCars ?? 5}
                    onChange={(e) => {
                      const n = Math.max(0, Math.min(50, parseInt(e.target.value || "0", 10) || 0));
                      setOperatorConfig(cfg => ({
                        ...cfg,
                        bds: {
                          ...cfg.bds,
                          optimizer: { ...cfg.bds?.optimizer, maxCompanyCars: n },
                        },
                      }));
                    }}
                    className="w-20 h-9 text-center text-base font-mono font-bold rounded-lg bg-zinc-900 border border-zinc-700 text-emerald-300 focus:border-emerald-500/50 focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => setOperatorConfig(cfg => ({
                      ...cfg,
                      bds: {
                        ...cfg.bds,
                        optimizer: {
                          ...cfg.bds?.optimizer,
                          maxCompanyCars: Math.min(50, (cfg.bds?.optimizer?.maxCompanyCars ?? 5) + 1),
                        },
                      },
                    }))}
                    className="w-9 h-9 rounded-lg border border-zinc-700 bg-zinc-900 hover:border-emerald-500/50 hover:text-emerald-300 text-zinc-400 flex items-center justify-center transition-colors"
                  >
                    <Plus className="w-4 h-4" />
                  </button>
                  <span className="text-[11px] text-zinc-500 ml-2">vetture</span>
                </div>
              </div>
            </div>

            {/* CTA primaria */}
            <div className="flex items-center justify-between mt-6 pt-5 border-t border-zinc-800">
              <div className="text-[11px] text-zinc-500">
                Ulteriori parametri (saturazione, pesi, intensità solver) in
                <button
                  type="button"
                  onClick={() => setConfigOpen(true)}
                  className="ml-1 text-zinc-300 underline decoration-dotted hover:text-purple-300"
                >
                  Configurazione avanzata
                </button>
                .
              </div>
              <button
                type="button"
                onClick={runOptimization}
                disabled={loading || !vehicleScenarioId}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-bold bg-gradient-to-r from-purple-500 to-pink-500 text-white shadow-lg hover:shadow-purple-500/30 disabled:opacity-50 disabled:cursor-not-allowed transition-shadow"
              >
                <Play className="w-4 h-4" />
                Genera Turni Guida
              </button>
            </div>
          </div>
        )}

        {/* Summary cards */}
        {result && result.summary && (
          <div>
            <div className="flex items-center gap-2 mb-2">
              <div className="h-6 w-1 rounded-full bg-gradient-to-b from-purple-500 to-pink-500" />
              <h3 className="text-xs font-semibold uppercase tracking-wider text-purple-300">
                Risultato Turni Guida
              </h3>
              <span className="text-[10px] text-muted-foreground">— indicatori chiave (delta vs baseline)</span>
            </div>
            <div className="flex flex-wrap gap-3">
              <SummaryCard
                icon={<Users className="w-4 h-4" />}
                label="Autisti"
                value={String(liveSummary?.totalDriverShifts ?? "—")}
                sub={liveSummary?.byType
                  ? `${liveSummary.byType.intero ?? 0} interi · ${liveSummary.byType.semiunico ?? 0} semiunici · ${liveSummary.byType.spezzato ?? 0} spezzati`
                  : undefined}
                delta={summaryDelta && { value: summaryDelta.driversΔ, unit: "", lowerIsBetter: true }}
              />
              {liveSummary?.totalWorkHours != null && (
                <SummaryCard
                  icon={<Clock className="w-4 h-4" />}
                  label="Ore Lavoro Totali"
                  value={`${liveSummary.totalWorkHours}h`}
                  sub={liveSummary.avgWorkMin != null ? `media: ${formatDuration(liveSummary.avgWorkMin)}/turno` : undefined}
                  delta={summaryDelta && { value: summaryDelta.workHoursΔ, unit: "h", lowerIsBetter: true, format: v => `${v > 0 ? "+" : ""}${v}h` }}
                />
              )}
              {liveSummary?.totalNastroHours != null && (
                <SummaryCard
                  icon={<Timer className="w-4 h-4" />}
                  label="Ore Nastro Totali"
                  value={`${liveSummary.totalNastroHours}h`}
                  sub={liveSummary.avgNastroMin != null ? `media: ${formatDuration(liveSummary.avgNastroMin)}/turno` : undefined}
                />
              )}
              {liveSummary?.semiunicoPct != null && (
                <SummaryCard
                  icon={<Coffee className="w-4 h-4" />}
                  label="Semiunici"
                  value={`${liveSummary.semiunicoPct}%`}
                  color={liveSummary.semiunicoPct <= 12 ? "#fbbf24" : "#ef4444"}
                  sub="limite ≤ 12%"
                  delta={summaryDelta && { value: summaryDelta.semiPctΔ, unit: "%", lowerIsBetter: true, format: v => `${v > 0 ? "+" : ""}${v}%` }}
                />
              )}
              {liveSummary?.spezzatoPct != null && (
                <SummaryCard
                  icon={<Timer className="w-4 h-4" />}
                  label="Spezzati"
                  value={`${liveSummary.spezzatoPct}%`}
                  color={liveSummary.spezzatoPct <= 13 ? "#fbbf24" : "#ef4444"}
                  sub="limite ≤ 13%"
                  delta={summaryDelta && { value: summaryDelta.spezPctΔ, unit: "%", lowerIsBetter: true, format: v => `${v > 0 ? "+" : ""}${v}%` }}
                />
              )}
              {liveSummary?.byType?.supplemento ? (
                <SummaryCard
                  icon={<Zap className="w-4 h-4" />}
                  label="Supplementi"
                  value={String(liveSummary.byType.supplemento)}
                  sub="straordinari (≤ 2h30)"
                  color="#dc2626"
                />
              ) : null}
              {liveSummary?.totalCambi ? (
                <SummaryCard
                  icon={<Repeat className="w-4 h-4" />}
                  label="Cambi in Linea"
                  value={String(liveSummary.totalCambi)}
                  color="#fb923c"
                  delta={summaryDelta && { value: summaryDelta.cambiΔ, unit: "", lowerIsBetter: true }}
                />
              ) : null}
              {liveSummary?.companyCarsUsed != null && (
                <SummaryCard
                  icon={<Car className="w-4 h-4" />}
                  label="Auto Aziendali"
                  value={`${liveSummary.companyCarsUsed}/${result.companyCars ?? optimizerCfg?.maxCompanyCars ?? "?"}`}
                  sub="cap HARD attivo"
                  color={result.companyCars && liveSummary.companyCarsUsed >= result.companyCars ? "#f59e0b" : undefined}
                  delta={summaryDelta && { value: summaryDelta.carsΔ, unit: "", lowerIsBetter: true }}
                />
              )}
              {liveSummary?.totalDailyCost != null && liveSummary.totalDailyCost > 0 && (
                <SummaryCard
                  icon={<DollarSign className="w-4 h-4" />}
                  label="Costo Giornaliero"
                  value={`€${liveSummary.totalDailyCost.toLocaleString("it-IT", { maximumFractionDigits: 0 })}`}
                  sub={liveSummary.efficiency?.costPerDriver
                    ? `€${liveSummary.efficiency.costPerDriver.toFixed(0)}/autista`
                    : "ottimizzato"}
                  color="#f59e0b"
                  delta={summaryDelta && { value: summaryDelta.costΔ, unit: "€", lowerIsBetter: true, format: v => `${v > 0 ? "+" : ""}${v.toLocaleString("it-IT", { maximumFractionDigits: 0 })}€` }}
                />
              )}
              {result.unassignedBlocks > 0 && (
                <SummaryCard
                  icon={<AlertTriangle className="w-4 h-4" />}
                  label="Non assegnati"
                  value={String(result.unassignedBlocks)}
                  color="#ef4444"
                  sub="blocchi rimasti"
                />
              )}
              {/* Conformità BDS */}
              {result.driverShifts.some((s: any) => s.bdsValidation) && (() => {
                const withBds = result.driverShifts.filter((s: any) => s.bdsValidation);
                const conformi = withBds.filter((s: any) => s.bdsValidation!.valid).length;
                const pct = Math.round((conformi / withBds.length) * 100);
                return (
                  <SummaryCard
                    icon={<Shield className="w-4 h-4" />}
                    label="Conformità BDS"
                    value={`${pct}%`}
                    color={pct >= 90 ? "#fbbf24" : pct >= 70 ? "#f59e0b" : "#ef4444"}
                    sub={`${conformi}/${withBds.length} turni`}
                  />
                );
              })()}
            </div>
          </div>
        )}

        {/* Gantt */}
        {result && result.driverShifts.length > 0 && (
          <div className="rounded-lg border border-purple-500/15 bg-purple-950/10 overflow-hidden">
            <div className="px-3 py-2 border-b border-purple-500/15 flex items-center justify-between gap-2 flex-wrap">
              <div className="flex items-center gap-2">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-purple-300">Gantt Turni Guida</span>
                <span className="text-[10px] text-muted-foreground">
                  {result.driverShifts.length} turni · {ganttBars.length} elementi
                </span>
                {modifiedCount > 0 && (
                  <span className="text-[10px] font-medium text-amber-300 bg-amber-500/10 border border-amber-500/30 px-1.5 py-0.5 rounded">
                    ● {modifiedCount} modific{modifiedCount === 1 ? "a" : "he"}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {/* Toggle vista esplosa/aggregata */}
                <div className="flex rounded-md overflow-hidden border border-purple-500/30 text-[10px]">
                  <button
                    onClick={() => setGanttMode("exploded")}
                    className={`px-2 py-1 font-medium transition flex items-center gap-1 ${
                      ganttMode === "exploded"
                        ? "bg-purple-500/30 text-white"
                        : "text-purple-300/60 hover:bg-purple-500/10"
                    }`}
                    title="1 bar per corsa (drag-and-drop tra autisti)"
                  >
                    <Layers className="w-3 h-3" /> Corse
                  </button>
                  <button
                    onClick={() => setGanttMode("aggregated")}
                    className={`px-2 py-1 font-medium transition ${
                      ganttMode === "aggregated"
                        ? "bg-purple-500/30 text-white"
                        : "text-purple-300/60 hover:bg-purple-500/10"
                    }`}
                    title="1 bar per ripresa (vista compatta)"
                  >
                    Riprese
                  </button>
                </div>
                {/* Undo / Redo */}
                <button
                  onClick={handleUndo}
                  disabled={!canUndo}
                  className="flex items-center gap-1 text-[10px] text-purple-300 px-2 py-1 rounded border border-purple-500/30 bg-purple-500/8 hover:bg-purple-500/15 transition disabled:opacity-30 disabled:cursor-not-allowed"
                  title="Annulla (Ctrl+Z)"
                >
                  <Undo2 className="w-3 h-3" />
                </button>
                <button
                  onClick={handleRedo}
                  disabled={!canRedo}
                  className="flex items-center gap-1 text-[10px] text-purple-300 px-2 py-1 rounded border border-purple-500/30 bg-purple-500/8 hover:bg-purple-500/15 transition disabled:opacity-30 disabled:cursor-not-allowed"
                  title="Ripristina (Ctrl+Shift+Z)"
                >
                  <Redo2 className="w-3 h-3" />
                </button>
                {/* Toggle diff baseline (#5) */}
                {baselineBarsRef.current && ganttMode === "exploded" && (
                  <button
                    onClick={() => setShowDiff(v => !v)}
                    className={`flex items-center gap-1 text-[10px] px-2 py-1 rounded border transition ${
                      showDiff
                        ? "border-purple-500/60 bg-purple-500/30 text-white"
                        : "border-purple-500/30 bg-purple-500/8 text-purple-300 hover:bg-purple-500/15"
                    }`}
                    title="Evidenzia corse spostate/riassegnate vs ottimo iniziale"
                  >
                    🔍 Diff
                  </button>
                )}
                {/* Pannello modifiche pendenti (#4) */}
                {history.length > 0 && (
                  <button
                    onClick={() => setShowChangesPanel(v => !v)}
                    className={`flex items-center gap-1 text-[10px] px-2 py-1 rounded border transition ${
                      showChangesPanel
                        ? "border-amber-500/60 bg-amber-500/30 text-amber-100"
                        : "border-purple-500/30 bg-purple-500/8 text-purple-300 hover:bg-purple-500/15"
                    }`}
                    title="Mostra cronologia modifiche manuali"
                  >
                    📜 Modifiche ({history.length})
                  </button>
                )}
                {/* Glow compatibilità (#NEW) */}
                {ganttMode === "exploded" && (
                  <button
                    onClick={() => setShowCompatGlow(v => !v)}
                    className={`flex items-center gap-1 text-[10px] px-2 py-1 rounded border transition ${
                      showCompatGlow
                        ? "border-emerald-500/60 bg-emerald-500/30 text-emerald-100"
                        : "border-purple-500/30 bg-purple-500/8 text-purple-300 hover:bg-purple-500/15"
                    }`}
                    title="Illumina ogni corsa secondo la sua compatibilità con altri turni"
                  >
                    💡 Compat
                  </button>
                )}
                {/* Filtra turni: mostra solo alcuni autisti */}
                {result && result.driverShifts.length > 0 && (
                  <div className="relative">
                    <button
                      onClick={() => setFilterOpen(o => !o)}
                      className={`flex items-center gap-1 text-[10px] px-2 py-1 rounded border transition ${visibleDrivers ? "border-amber-500/50 bg-amber-500/10 text-amber-300" : "border-zinc-700 text-zinc-400 hover:text-zinc-200"}`}
                      title="Mostra solo i turni selezionati"
                    >
                      🔎 Filtra turni{visibleDrivers ? ` (${visibleDrivers.size})` : ""}
                    </button>
                    {filterOpen && (
                      <>
                        <div className="fixed inset-0 z-40" onClick={() => setFilterOpen(false)} />
                        <div className="absolute z-50 mt-1 right-0 w-56 max-h-72 overflow-y-auto rounded-lg border border-border/60 bg-popover shadow-2xl p-2">
                          <div className="flex items-center justify-between mb-1.5 text-[10px]">
                            <button onClick={() => setVisibleDrivers(null)} className="text-emerald-300 hover:underline">Tutti</button>
                            <button onClick={() => setVisibleDrivers(new Set())} className="text-zinc-400 hover:underline">Nessuno</button>
                          </div>
                          {result.driverShifts.map(s => {
                            const checked = !visibleDrivers || visibleDrivers.has(s.driverId);
                            return (
                              <label key={s.driverId} className="flex items-center gap-2 px-1 py-0.5 text-[11px] text-zinc-300 cursor-pointer hover:bg-white/5 rounded">
                                <input type="checkbox" checked={checked} className="accent-purple-500"
                                  onChange={() => setVisibleDrivers(prev => {
                                    const base = prev ?? new Set(result.driverShifts.map(x => x.driverId));
                                    const n = new Set(base);
                                    if (n.has(s.driverId)) n.delete(s.driverId); else n.add(s.driverId);
                                    return n.size === result.driverShifts.length ? null : n;
                                  })}
                                />
                                {s.driverId}
                              </label>
                            );
                          })}
                        </div>
                      </>
                    )}
                  </div>
                )}
                {/* "+ Turno guida" e "+ Attività" vivono nella Finestra di lavoro:
                    i turni si creano con le bozze, le attività come card. */}
                <span className="text-[10px] text-purple-300/40 italic hidden xl:inline">
                  {ganttMode === "exploded" ? "Trascina le corse tra gli autisti" : "Vista compatta — passa a 'Corse' per modificare"}
                </span>
              </div>
            </div>
            <div className="p-2">
              {/* Pannello modifiche pendenti (#4) */}
              {showChangesPanel && history.length > 0 && (
                <div className="mb-2 rounded border border-amber-500/30 bg-amber-950/15 p-2">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-amber-300">
                      Cronologia modifiche manuali
                    </span>
                    <button
                      onClick={() => { setHistory([]); setHistoryIdx(-1); setModifiedCount(0); setShowChangesPanel(false); }}
                      className="text-[10px] text-red-300 hover:text-red-200 underline"
                      title="Svuota cronologia (non annulla le modifiche già applicate)"
                    >
                      Svuota
                    </button>
                  </div>
                  <ol className="space-y-0.5 max-h-40 overflow-y-auto text-[11px]">
                    {history.map((h, i) => {
                      const isCurrent = i === historyIdx;
                      const isFuture = i > historyIdx;
                      return (
                        <li key={`${h.ts}-${i}`}>
                          <button
                            onClick={() => jumpToHistory(i)}
                            className={`w-full text-left flex items-center gap-2 px-2 py-1 rounded transition ${
                              isCurrent
                                ? "bg-amber-500/25 text-amber-100 font-medium"
                                : isFuture
                                  ? "text-muted-foreground/50 hover:bg-white/5"
                                  : "text-amber-200/80 hover:bg-white/5"
                            }`}
                            title={isCurrent ? "Stato corrente" : isFuture ? "Click per ripristinare" : "Click per tornare a questo punto"}
                          >
                            <span className="text-[9px] tabular-nums w-10 opacity-70">
                              {new Date(h.ts).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                            </span>
                            <span className="text-[9px] tabular-nums w-6 text-right opacity-50">#{i + 1}</span>
                            <span className="flex-1 truncate">{h.description}</span>
                            {isCurrent && <span className="text-[9px] text-amber-300">● ora</span>}
                          </button>
                        </li>
                      );
                    })}
                  </ol>
                </div>
              )}
              {/* Verifica normativa puntuale (stile Bdsi) */}
              {wwVerify && (
                <div className="fixed inset-0 z-[60] bg-black/60 flex items-center justify-center p-4" onClick={() => setWwVerify(null)}>
                  <div className="w-full max-w-sm rounded-xl border border-emerald-500/30 bg-zinc-950 p-4 space-y-2.5" onClick={(e) => e.stopPropagation()}>
                    <p className="text-sm font-bold text-emerald-300">⚖ Verifica normativa · {wwVerify.shiftId}</p>
                    {wwVerify.busy ? (
                      <p className="text-xs text-zinc-400">Verifica in corso…</p>
                    ) : (
                      <>
                        <div className="flex items-center gap-2 text-xs">
                          <span className="px-2 py-0.5 rounded bg-emerald-500/15 border border-emerald-500/40 text-emerald-300 font-semibold">{wwVerify.type ?? "—"}</span>
                          {wwVerify.residenza && <span className="text-zinc-400">zona di riferimento: <b className="text-zinc-200">{wwVerify.residenza}</b></span>}
                        </div>
                        {wwVerify.validation ? (
                          <div className="space-y-1">
                            {([
                              ["classificazioneValida", "Classificazione tipologia"],
                              ["cee561", "Guida continuativa (RD131/CEE561)"],
                              ["intervalloPasto", "Intervallo pasto"],
                              ["staccoMinimo", "Stacco minimo fra turni"],
                              ["nastro", "Nastro massimo"],
                              ["riprese", "Riprese"],
                            ] as const).map(([k, label]) => (
                              <div key={k} className="flex items-center gap-2 text-[11px]">
                                <span className={(wwVerify.validation as any)?.[k] ? "text-emerald-400" : "text-rose-400"}>{(wwVerify.validation as any)?.[k] ? "✔" : "✘"}</span>
                                <span className="text-zinc-300">{label}</span>
                              </div>
                            ))}
                            {(wwVerify.validation.violations ?? []).length > 0 && (
                              <div className="mt-1.5 rounded-lg border border-rose-500/30 bg-rose-500/10 p-2 space-y-0.5">
                                {wwVerify.validation.violations.map((v, i) => (
                                  <p key={i} className="text-[10px] text-rose-300">• {v}</p>
                                ))}
                              </div>
                            )}
                            {wwVerify.validation.valid && (wwVerify.validation.violations ?? []).length === 0 && (
                              <p className="text-[11px] text-emerald-400 font-semibold">Turno conforme alla normativa attiva ✔</p>
                            )}
                          </div>
                        ) : (
                          <p className="text-[11px] text-zinc-500">Nessun dettaglio normativa disponibile per questo turno.</p>
                        )}
                        <div className="flex justify-end pt-1">
                          <button onClick={() => setWwVerify(null)}
                            className="px-3 py-1.5 rounded-lg border border-zinc-700 text-zinc-300 text-xs hover:text-zinc-100">Chiudi</button>
                        </div>
                      </>
                    )}
                  </div>
                </div>
              )}
              {/* Rimpacchetta stile Bdsi: scelta del DEPOSITO di appartenenza del
                  nuovo turno guida; la tipologia la rileva la normativa da sola. */}
              {wwRepackAsk && (
                <div className="fixed inset-0 z-[60] bg-black/60 flex items-center justify-center p-4" onClick={() => setWwRepackAsk(null)}>
                  <div className="w-full max-w-sm rounded-xl border border-purple-500/30 bg-zinc-950 p-4 space-y-2.5" onClick={(e) => e.stopPropagation()}>
                    <p className="text-sm font-bold text-purple-300">📦 Chiudi turno · deposito di appartenenza</p>
                    <p className="text-[11px] text-zinc-400">Il turno guida verrà domiciliato al deposito scelto; la <b>tipologia</b> (Intero, Semiunico…) viene rilevata automaticamente dalla normativa attiva.</p>
                    <div className="space-y-1 max-h-52 overflow-y-auto">
                      <label className={`flex items-center gap-2 px-2 py-1.5 rounded-lg border cursor-pointer text-xs ${wwRepackDepot === "auto" ? "border-purple-500/50 bg-purple-500/10 text-purple-200" : "border-zinc-800 text-zinc-400 hover:border-zinc-600"}`}>
                        <input type="radio" className="hidden" checked={wwRepackDepot === "auto"} onChange={() => setWwRepackDepot("auto")} />
                        <span className="w-2.5 h-2.5 rounded-full bg-zinc-600 shrink-0" />
                        Auto (nessun deposito assegnato)
                      </label>
                      {wwDepots.map(d => (
                        <label key={d.id} className={`flex items-center gap-2 px-2 py-1.5 rounded-lg border cursor-pointer text-xs ${wwRepackDepot === d.id ? "border-purple-500/50 bg-purple-500/10 text-purple-200" : "border-zinc-800 text-zinc-400 hover:border-zinc-600"}`}>
                          <input type="radio" className="hidden" checked={wwRepackDepot === d.id} onChange={() => setWwRepackDepot(d.id)} />
                          <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: d.color || "#a78bfa" }} />
                          {d.name}
                        </label>
                      ))}
                    </div>
                    <div className="flex justify-end gap-2 pt-1">
                      <button onClick={() => setWwRepackAsk(null)}
                        className="px-3 py-1.5 rounded-lg border border-zinc-700 text-zinc-400 text-xs hover:text-zinc-200">Annulla</button>
                      <button onClick={() => {
                        const dep = wwDepots.find(d => d.id === wwRepackDepot) ?? null;
                        wwRepack(wwRepackAsk.ids, dep);
                        setWwRepackAsk(null);
                      }}
                        className="px-3 py-1.5 rounded-lg border border-purple-500/50 bg-purple-500/20 text-purple-200 text-xs font-semibold hover:bg-purple-500/30">
                        Chiudi turno
                      </button>
                    </div>
                  </div>
                </div>
              )}
              {wwActOpen && (
                <div className="fixed inset-0 z-[60] bg-black/60 flex items-center justify-center p-4" onClick={() => setWwActOpen(false)}>
                  <div className="w-full max-w-sm rounded-xl border border-emerald-500/30 bg-zinc-950 p-4 space-y-2.5" onClick={(e) => e.stopPropagation()}>
                    <p className="text-sm font-bold text-emerald-300">➕ Nuova attività</p>
                    <div className="flex gap-1.5">
                      {(["riserva", "presidio", "taxi"] as DriverActivityType[]).map(k => (
                        <button key={k} onClick={() => setWwActForm(f => ({ ...f, type: k }))}
                          className={`flex-1 px-2 py-1.5 rounded-lg border text-[11px] font-semibold ${wwActForm.type === k ? "" : "opacity-50"}`}
                          style={{ borderColor: (ACTIVITY_COLORS[k] ?? "#22c55e") + "88", color: ACTIVITY_COLORS[k] ?? "#22c55e", backgroundColor: wwActForm.type === k ? (ACTIVITY_COLORS[k] ?? "#22c55e") + "22" : "transparent" }}>
                          {ACTIVITY_LABELS[k]}
                        </button>
                      ))}
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <label className="text-[10px] text-zinc-400">Inizio
                        <input value={wwActForm.start} onChange={e => setWwActForm(f => ({ ...f, start: e.target.value }))} placeholder="08:00"
                          className="w-full mt-0.5 px-2 py-1.5 rounded bg-zinc-900 border border-zinc-700 text-xs text-zinc-100 font-mono" />
                      </label>
                      <label className="text-[10px] text-zinc-400">Fine
                        <input value={wwActForm.end} onChange={e => setWwActForm(f => ({ ...f, end: e.target.value }))} placeholder="09:00"
                          className="w-full mt-0.5 px-2 py-1.5 rounded bg-zinc-900 border border-zinc-700 text-xs text-zinc-100 font-mono" />
                      </label>
                      <label className="text-[10px] text-zinc-400">Nodo inizio
                        <input list="ww-nodes" value={wwActForm.fromNode} onChange={e => setWwActForm(f => ({ ...f, fromNode: e.target.value }))} placeholder="cerca fermata o deposito…"
                          className="w-full mt-0.5 px-2 py-1.5 rounded bg-zinc-900 border border-zinc-700 text-xs text-zinc-100" />
                      </label>
                      <label className="text-[10px] text-zinc-400">Nodo fine
                        <input list="ww-nodes" value={wwActForm.toNode} onChange={e => setWwActForm(f => ({ ...f, toNode: e.target.value }))} placeholder="cerca fermata o deposito…"
                          className="w-full mt-0.5 px-2 py-1.5 rounded bg-zinc-900 border border-zinc-700 text-xs text-zinc-100" />
                      </label>
                      <datalist id="ww-nodes">
                        {wwNodes.map(n => <option key={n} value={n} />)}
                      </datalist>
                    </div>
                    <div className="flex justify-end gap-2 pt-1">
                      <button onClick={() => setWwActOpen(false)} className="text-xs px-3 py-1.5 rounded text-zinc-400 hover:text-zinc-100">Annulla</button>
                      <button onClick={() => {
                        const sMin = timeToMin(wwActForm.start), eMin = timeToMin(wwActForm.end);
                        if (sMin == null || eMin == null || eMin <= sMin) { toast.error("Orari non validi", { description: "Formato HH:MM, fine dopo inizio." }); return; }
                        setWwPool(prev => [...prev, { activity: {
                          id: `act-${Date.now()}`, type: wwActForm.type, startMin: sMin, endMin: eMin,
                          fromNode: wwActForm.fromNode.trim() || undefined, toNode: wwActForm.toNode.trim() || undefined,
                        } }]);
                        setWwActOpen(false); setWwOpen(true);
                        toast.success(`Attività ${ACTIVITY_LABELS[wwActForm.type]} creata`, { description: "È una card nella Finestra di lavoro: mettila in una bozza e chiudi il turno." });
                      }}
                        className="text-xs font-bold px-4 py-1.5 rounded bg-emerald-600 hover:bg-emerald-500 text-white">Crea card</button>
                    </div>
                  </div>
                </div>
              )}
              {wwOpen && (
                <div className="mb-2">
                  <WorkWindowPanel
                    shifts={wwShifts}
                    loose={wwPool.map((p) => p.trip ? ({
                      id: String(p.trip.tripId), isTrip: true,
                      kindLabel: p.trip.routeName || "Corsa",
                      kindColor: p.importedFrom ? "#fb7185" : "#a78bfa",
                      timeLabel: `${wwFmtH(p.trip.departureMin)}→${wwFmtH(p.trip.arrivalMin)}`,
                      desc: `${p.trip.firstStopName ?? ""} → ${p.trip.lastStopName ?? ""}${p.udpName ? ` · da ${p.udpName}` : ""}`,
                      startMin: p.trip.departureMin, endMin: p.trip.arrivalMin,
                    }) : ({
                      id: p.activity!.id, isTrip: true,
                      kindLabel: ACTIVITY_LABELS[p.activity!.type] ?? p.activity!.type,
                      kindColor: ACTIVITY_COLORS[p.activity!.type] ?? "#22c55e",
                      timeLabel: `${wwFmtH(p.activity!.startMin)}→${wwFmtH(p.activity!.endMin)}`,
                      desc: [p.activity!.fromNode, p.activity!.toNode].filter(Boolean).join(" → ") || "attività",
                      deletable: true,
                      startMin: p.activity!.startMin, endMin: p.activity!.endMin,
                    }))}
                    onAddActivity={() => setWwActOpen(true)}
                    onDeleteLoose={(id) => {
                      setWwPool(prev => prev.filter(p => wwPoolId(p) !== id));
                      setWwSelected(prev => { const n = new Set(prev); n.delete(id); return n; });
                    }}
                    onReorderLoose={(from, to) => setWwPool(prev => { const n = [...prev]; const [m] = n.splice(from, 1); n.splice(to, 0, m); return n; })}
                    onImport={wwImport}
                    selected={wwSelected}
                    onToggleSelect={(id) => setWwSelected(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; })}
                    onToggleSelectAll={(shiftId) => {
                      const sh = wwShifts.find(s => s.id === shiftId); if (!sh) return;
                      const tripIds = sh.activities.filter(a => a.isTrip).map(a => a.id);
                      setWwSelected(prev => {
                        const n = new Set(prev);
                        const all = tripIds.every(id => n.has(id));
                        tripIds.forEach(id => { if (all) n.delete(id); else n.add(id); });
                        return n;
                      });
                    }}
                    onDropShift={wwDrop}
                    onRemoveShift={(id) => setWwShiftIds(ids => ids.filter(x => x !== id))}
                    onUnpack={(id) => wwDissolve([id])}
                    onUnpackAll={() => wwDissolve(wwShiftIds)}
                    onRepack={() => setWwRepackAsk({})}
                    onRepackIds={(ids) => setWwRepackAsk({ ids })}
                    onPreviewIds={wwPreviewType}
                    onVerifyShift={(id) => { void wwVerifyShift(id); }}
                    onClose={() => setWwOpen(false)}
                    busy={wwImportBusy}
                    accent="purple"
                  />
                </div>
              )}
              <InteractiveGantt
                rows={shownRows}
                bars={shownBars}
                rowsDraggable={wwOpen}
                minHour={ganttBounds.min}
                maxHour={ganttBounds.max}
                editable={ganttMode === "exploded"}
                onBarChange={ganttMode === "exploded" ? handleBarChange : undefined}
                onBarClick={(bar, anchor) => {
                  const meta: any = bar.meta || {};
                  // Corse (trip/service): nessuna card di eliminazione.
                  if (meta.type === "trip" || meta.type === "service") return;
                  // Ogni altro elemento → apre una card con dettagli + eliminazione.
                  setSegmentCard({ x: anchor?.x ?? window.innerWidth / 2, y: anchor?.y ?? window.innerHeight / 2, bar });
                }}
                onBarContextMenu={ganttMode === "exploded" ? (bar, anchor) => setCtxMenu({ x: anchor.x, y: anchor.y, bar }) : undefined}
                getSuggestions={ganttMode === "exploded" && result ? (bar) => {
                  const meta: any = bar.meta || {};
                  if (meta.type !== "trip" || !meta.tripId) return [];
                  const suggs = suggestDriversForTrip(result.driverShifts, meta.tripId);
                  return suggs.slice(0, 6).map(s => ({
                    rowId: s.driverId,
                    label: s.driverId,
                    reason: s.reason,
                    detail: s.detail,
                  }));
                } : undefined}
                rowHighlights={ganttMode === "exploded" ? rowHighlights : undefined}
                onBarDragStart={ganttMode === "exploded" ? handleBarDragStart : undefined}
                onBarDragEnd={ganttMode === "exploded" ? handleBarDragEnd : undefined}
              />
            </div>
          </div>
        )}
      </div>

      {/* ── Parametri & Regole: pannello completo pre-ottimizzazione ── */}
      <OptimizerRulesPanel
        isOpen={rulesOpen}
        onClose={() => setRulesOpen(false)}
        config={operatorConfig}
        onChange={setOperatorConfig}
        serviceType={serviceType}
        onServiceTypeChange={setServiceType}
        projectId={projectIdFromUrl}
      />

      {/* ── Operator Config Drawer (legacy: pesi/intensità) ── */}
      <OperatorConfigPanel
        isOpen={configOpen}
        onClose={() => setConfigOpen(false)}
        config={operatorConfig}
        onChange={setOperatorConfig}
      />

      {/* ── Save DSS Dialog ─────────────────────────────────── */}
      {showSaveDialog && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={() => setShowSaveDialog(false)}>
          <div className="bg-zinc-900 border border-purple-500/30 rounded-lg p-4 max-w-md w-full" onClick={e => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-purple-200 mb-3">Salva scenario turni guida</h3>
            <input
              autoFocus
              type="text"
              value={dssName}
              onChange={e => setDssName(e.target.value)}
              placeholder="Nome scenario (es. CSP saturato 360min)"
              className="w-full text-sm px-3 py-2 rounded-md bg-zinc-800 border border-zinc-700 text-white placeholder-zinc-500 focus:outline-none focus:border-purple-500"
              onKeyDown={e => { if (e.key === "Enter" && dssName.trim()) saveDss(); }}
            />
            <div className="flex justify-end gap-2 mt-3">
              <button
                onClick={() => setShowSaveDialog(false)}
                className="text-xs text-zinc-400 hover:text-white px-3 py-1.5"
              >
                Annulla
              </button>
              <button
                onClick={saveDss}
                disabled={!dssName.trim() || savingDss}
                className="text-xs font-medium text-white px-3 py-1.5 rounded-md bg-purple-600 hover:bg-purple-500 disabled:opacity-50"
              >
                {savingDss ? "Salvataggio…" : "Salva"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Aggiungi turno guida manuale (#NEW) */}
      {showAddDriverDialog && result && (
        <AddDriverShiftDialog
          suggestedDriverId={nextDriverId(result.driverShifts)}
          existingDriverIds={result.driverShifts.map(s => s.driverId)}
          onClose={() => setShowAddDriverDialog(false)}
          onConfirm={handleAddDriverShift}
        />
      )}

      {/* Aggiungi attività non di guida */}
      {showAddActivityDialog && result && (
        <AddActivityDialog
          driverIds={result.driverShifts.map(s => s.driverId)}
          suggestedDriverId={activityPrefill?.driverId}
          suggestedStartMin={activityPrefill?.startMin}
          onClose={() => { setShowAddActivityDialog(false); setActivityPrefill(null); }}
          onConfirm={handleAddActivity}
        />
      )}

      {/* Menu contestuale (click destro sul Gantt) */}
      {ctxMenu && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setCtxMenu(null)} onContextMenu={(e) => { e.preventDefault(); setCtxMenu(null); }} />
          <div className="fixed z-50 min-w-[190px] rounded-lg border border-border/60 bg-popover shadow-2xl py-1 text-xs"
               style={{ left: Math.min(ctxMenu.x, window.innerWidth - 210), top: Math.min(ctxMenu.y, window.innerHeight - 120) }}>
            <button
              className="w-full text-left px-3 py-1.5 hover:bg-teal-500/10 text-teal-300 flex items-center gap-2"
              onClick={() => {
                const meta: any = ctxMenu.bar.meta || {};
                setActivityPrefill({ driverId: meta.driverId ?? ctxMenu.bar.rowId, startMin: ctxMenu.bar.startMin });
                setShowAddActivityDialog(true);
                setCtxMenu(null);
              }}
            >
              ➕ Aggiungi attività qui
            </button>
            {DELETABLE.has((ctxMenu.bar.meta as any)?.type) && (
              <button
                className="w-full text-left px-3 py-1.5 hover:bg-rose-500/10 text-rose-300 flex items-center gap-2"
                onClick={() => { deleteSegment(ctxMenu.bar); setCtxMenu(null); }}
              >
                🗑 Elimina questo segmento
              </button>
            )}
          </div>
        </>
      )}

      {/* Card dettaglio segmento (click sinistro) con eliminazione */}
      {segmentCard && (() => {
        const meta: any = segmentCard.bar.meta || {};
        const TYPE_IT: Record<string, string> = {
          transfer: "Fuori linea (andata)", transferBack: "Fuori linea (rientro)",
          carpool: "Taxi / auto aziendale", preTurno: "Pre-turno",
          interruption: "Sosta / interruzione", activity: "Attività non di guida",
        };
        const title = TYPE_IT[meta.type] ?? "Elemento";
        const canDelete = DELETABLE.has(meta.type);
        return (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setSegmentCard(null)} />
            <div className="fixed z-50 w-64 rounded-lg border border-border/60 bg-popover shadow-2xl text-xs"
                 style={{ left: Math.min(segmentCard.x, window.innerWidth - 270), top: Math.min(segmentCard.y, window.innerHeight - 170) }}>
              <div className="flex items-center justify-between px-3 py-2 border-b border-border/40">
                <span className="font-semibold text-foreground">{title}</span>
                <button onClick={() => setSegmentCard(null)} className="text-muted-foreground hover:text-foreground"><X className="w-3.5 h-3.5" /></button>
              </div>
              <div className="px-3 py-2 space-y-1 text-muted-foreground">
                <div className="text-[11px]">Autista: <span className="text-foreground font-medium">{meta.driverId ?? segmentCard.bar.rowId}</span></div>
                <div className="text-[11px]">Orario: <span className="text-foreground font-mono">{minToTime(segmentCard.bar.startMin)}–{minToTime(segmentCard.bar.endMin)}</span></div>
                {(segmentCard.bar.tooltip ?? []).map((t, i) => <div key={i} className="text-[10px] text-muted-foreground/80">{t}</div>)}
              </div>
              <div className="px-3 py-2 border-t border-border/40 flex justify-end">
                {canDelete ? (
                  <button
                    onClick={() => { deleteSegment(segmentCard.bar); setSegmentCard(null); }}
                    className="inline-flex items-center gap-1.5 text-[11px] font-medium px-2.5 py-1 rounded-md bg-rose-600 text-white hover:bg-rose-500 transition"
                  >
                    <Trash2 className="w-3.5 h-3.5" /> Elimina
                  </button>
                ) : (
                  <span className="text-[10px] text-muted-foreground/60 italic">Elemento non eliminabile</span>
                )}
              </div>
            </div>
          </>
        );
      })()}
    </div>
  );
}
