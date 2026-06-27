/**
 * Fucina — Scheduling Engine Workspace
 *
 * Flusso lineare in 5 step:
 *   0. Dati GTFS           – selezione / importazione feed
 *   1. Abbinamento Vetture – linee, date, tipo vettura
 *   2. Cluster di Cambio   – cluster toccati dalle linee selezionate
 *   3. Ottimizzazione      – run CP-SAT/Greedy, analisi risultati, salva
 *   4. Area di Lavoro      – Gantt interattivo + drag & drop + esporta
 */
import React, { lazy, Suspense, useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useLocation, useRoute } from "wouter";
import { toast } from "sonner";
import {
  Flame, ArrowLeft, ChevronRight, Zap,
  Database, Bus, Truck, CheckCircle2, ArrowRight, Layers, Route, Building2, Users,
} from "lucide-react";
import type { ServiceProgramResult } from "@/pages/optimizer-route/types";
import type { DeadheadMatrix } from "@/pages/fucina/steps/DeadheadStep";
import { getApiBase } from "@/lib/api";
import { getProject as getSchedulingProject, syncProjectFromPs } from "@/lib/scheduling-projects-api";

// NB: GtfsSelectorStep deprecato — il feed arriva sempre dal Planning Studio
const VehicleAssignmentStep = lazy(() => import("@/pages/fucina/steps/VehicleAssignmentStep"));
const DepotStep = lazy(() => import("@/pages/fucina/steps/DepotStep"));
// ClustersStep deprecato — i cluster vivono solo nel Network Engine
const DeadheadStep = lazy(() => import("@/pages/fucina/steps/DeadheadStep"));
const OptimizerStep = lazy(() => import("@/pages/fucina/steps/OptimizerStep"));
const WorkspaceStep = lazy(() => import("@/pages/fucina/steps/WorkspaceStep"));
const DriverWorkspaceStep = lazy(() => import("@/pages/fucina/steps/DriverWorkspaceStep"));

/* ── Tipi condivisi tra step ─────────────────────────────── */
export interface GtfsSelection {
  source: "existing" | "import";
  date: string;        // YYYYMMDD
  label: string;       // display label
  tempFeedId?: string; // solo per import temporaneo
}

export interface VehicleAssignment {
  selectedDate: string;
  selectedRoutes: Map<string, import("@/pages/optimizer-route/types").VehicleType>;
  forcedRoutes: Set<string>;
  tripVehicleOverrides: Map<string, import("@/pages/optimizer-route/types").VehicleType>;
}

/* ── Definizione step ──────────────────────────────────────
 * NB: lo "step 0 — Dati GTFS" è stato deprecato: il feed di scheduling
 * è sempre derivato (materializzato) dal Planning Studio collegato al
 * progetto. Lo manteniamo come ID nel codice per non rinumerare tutti
 * i riferimenti, ma lo escludiamo dalla stepper visibile (STEPS_VISIBLE).
 */
const STEPS = [
  { id: 0, label: "Dati GTFS",          icon: Database, desc: "Seleziona o importa feed" },
  { id: 1, label: "Abbinamento Vetture", icon: Bus,      desc: "Linee, date, tipo vettura" },
  { id: 2, label: "Deposito",            icon: Building2,desc: "Punto di partenza veicoli" },
  { id: 3, label: "Cluster di Cambio",   icon: Layers,   desc: "Punti di cambio vettura" },
  { id: 4, label: "Fuori Linea",         icon: Route,    desc: "Distanze · tempi · costi" },
  { id: 5, label: "Ottimizzazione",      icon: Zap,      desc: "CP-SAT · analisi · salva" },
  { id: 6, label: "Area di Lavoro",      icon: Truck,    desc: "Gantt · drag & drop · esporta" },
  { id: 7, label: "Turni Guida",         icon: Users,    desc: "CSP · saturazione · cap vetture · idle" },
] as const;

// Step effettivamente visibili nella stepper:
//   - step 0 "Dati GTFS" rimosso (feed sempre dal Network Engine)
//   - step 3 "Cluster di Cambio" rimosso (la gestione cluster vive solo nel
//     Network Engine; qui i PsCluster interchange vengono caricati in automatico)
const STEPS_VISIBLE = STEPS.filter((s) => s.id !== 0 && s.id !== 3);

/* ── Stato mancante: render-guard per step che richiedono vehicleAssignment ── */
function MissingStateNotice({ onRestart, onForward }: { onRestart: () => void; onForward?: () => void }) {
  return (
    <div className="p-6 max-w-xl mx-auto">
      <div className="bg-amber-500/5 border border-amber-500/30 rounded-xl p-5 space-y-3">
        <div className="flex items-center gap-2 text-amber-300">
          <span className="text-sm font-semibold">⚠ Stato della pipeline non disponibile</span>
        </div>
        <p className="text-sm text-zinc-300">
          Stai aprendo uno scenario salvato (deep-link) e non è più disponibile la
          configurazione delle linee/vetture usata per generarlo. Per modificarla
          devi ripartire dallo step "Abbinamento Vetture".
        </p>
        <div className="flex gap-2 pt-1">
          <button
            onClick={onRestart}
            className="px-4 py-2 rounded-lg text-sm bg-amber-500 hover:bg-amber-400 text-black font-semibold"
          >
            Riparti dall'Abbinamento
          </button>
          {onForward && (
            <button
              onClick={onForward}
              className="px-4 py-2 rounded-lg text-sm border border-zinc-700 text-zinc-300 hover:bg-zinc-800"
            >
              Torna al Workspace
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Splash Screen ───────────────────────────────────────── */
function SplashScreen({ onEnter, onBack }: { onEnter: () => void; onBack: () => void }) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.5 }}
      className="fixed inset-0 z-50 flex flex-col items-center justify-center overflow-hidden"
      style={{ background: "radial-gradient(ellipse at 50% 60%, #1a0a00 0%, #0a0500 60%, #000000 100%)" }}
    >
      {[...Array(20)].map((_, i) => (
        <motion.div
          key={i}
          className="absolute rounded-full pointer-events-none"
          style={{
            width: Math.random() * 4 + 2,
            height: Math.random() * 4 + 2,
            left: `${Math.random() * 100}%`,
            top: `${Math.random() * 100}%`,
            background: `hsl(${20 + Math.random() * 30}, 100%, ${50 + Math.random() * 30}%)`,
          }}
          animate={{ y: [0, -(80 + Math.random() * 120)], opacity: [0, 0.8, 0], scale: [0, 1, 0] }}
          transition={{ duration: 2 + Math.random() * 3, repeat: Infinity, delay: Math.random() * 4, ease: "easeOut" }}
        />
      ))}

      <button
        onClick={onBack}
        className="absolute top-5 left-5 flex items-center gap-1.5 text-xs text-orange-300/60 hover:text-orange-300 transition-colors"
      >
        <ArrowLeft className="w-3.5 h-3.5" />
        <span>Torna all'app</span>
      </button>

      <motion.div
        initial={{ scale: 0.7, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ duration: 0.7, delay: 0.2, ease: [0.16, 1, 0.3, 1] }}
        className="relative mb-6"
      >
        <div className="absolute inset-0 blur-3xl bg-orange-500/20 rounded-full scale-150 pointer-events-none" />
        <img
          src="/schedulingengine.png"
          alt="Scheduling Engine"
          className="relative h-52 w-auto drop-shadow-[0_0_40px_rgba(251,146,60,0.5)]"
        />
      </motion.div>

      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, delay: 0.4 }}
        className="text-center px-6"
      >
        <h1 className="text-4xl font-black tracking-tight mb-1 bg-gradient-to-r from-orange-300 via-amber-400 to-orange-500 bg-clip-text text-transparent">
          SCHEDULING ENGINE
        </h1>
        <p className="text-sm text-orange-300/70 font-mono mb-2 tracking-widest uppercase">
          CP-SAT · Ottimizzazione combinatoria
        </p>
        <p className="text-sm text-orange-200/50 max-w-sm mx-auto leading-relaxed mt-3">
          Tre teste, un unico obiettivo — turni macchina, orari di servizio e gestione cluster fusi in un motore a soluzione ottimale.
        </p>

        <div className="flex items-center justify-center gap-1.5 flex-wrap mt-5 mb-8">
          {STEPS_VISIBLE.map((s, i) => (
            <React.Fragment key={s.id}>
              <span className="flex items-center gap-1.5 text-[10px] px-2.5 py-1 rounded-full border border-orange-500/30 text-orange-400/80 bg-orange-500/5">
                <s.icon className="w-3 h-3" />
                {s.label}
              </span>
              {i < STEPS_VISIBLE.length - 1 && <ArrowRight className="w-2.5 h-2.5 text-orange-400/30 shrink-0" />}
            </React.Fragment>
          ))}
        </div>

        <motion.button
          onClick={onEnter}
          whileHover={{ scale: 1.04 }}
          whileTap={{ scale: 0.97 }}
          className="inline-flex items-center gap-2.5 px-8 py-3.5 rounded-xl font-bold text-sm text-black bg-gradient-to-r from-orange-400 to-amber-400 shadow-[0_0_30px_rgba(251,146,60,0.4)] hover:shadow-[0_0_45px_rgba(251,146,60,0.6)] transition-shadow"
        >
          <Flame className="w-4 h-4" />
          Entra nel Motore
          <ChevronRight className="w-4 h-4" />
        </motion.button>
      </motion.div>
    </motion.div>
  );
}

/* ── Stepper header ──────────────────────────────────────── */
function StepperBar({
  current,
  completed,
  onStepClick,
}: {
  current: number;
  completed: Set<number>;
  onStepClick: (s: number) => void;
}) {
  return (
    <div className="flex items-center px-4 py-2.5 border-b border-orange-500/15 shrink-0 bg-gradient-to-r from-orange-950/30 via-transparent to-transparent">
      {STEPS_VISIBLE.map((step, i) => {
        const done = completed.has(step.id);
        const active = current === step.id;
        const clickable = done || step.id <= current;
        return (
          <React.Fragment key={step.id}>
            <button
              onClick={() => clickable && onStepClick(step.id)}
              disabled={!clickable}
              data-virgilio-id={`fucina:step-${step.id}`}
              className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg transition-all ${
                active ? "bg-orange-500/15 cursor-default" : clickable ? "hover:bg-orange-500/8 cursor-pointer" : "cursor-default opacity-40"
              }`}
            >
              <div className={`w-5 h-5 rounded-full flex items-center justify-center shrink-0 transition-all ${
                done
                  ? "bg-orange-500 text-black"
                  : active
                    ? "bg-orange-500/20 border border-orange-500/60 text-orange-400"
                    : "bg-zinc-800 border border-zinc-700 text-zinc-500"
              }`}>
                {done ? <CheckCircle2 className="w-3 h-3" /> : <span className="text-[10px] font-bold">{i + 1}</span>}
              </div>
              <div>
                <p className={`text-[11px] font-semibold leading-tight ${active ? "text-orange-300" : done ? "text-orange-400/80" : "text-zinc-500"}`}>
                  {step.label}
                </p>
                <p className="text-[9px] text-orange-400/30 font-mono">{step.desc}</p>
              </div>
            </button>
            {i < STEPS_VISIBLE.length - 1 && (
              <ChevronRight className={`w-3.5 h-3.5 mx-0.5 shrink-0 ${done ? "text-orange-500/50" : "text-zinc-700"}`} />
            )}
          </React.Fragment>
        );
      })}
      <div className="ml-auto flex items-center gap-1.5">
        <Zap className="w-3 h-3 text-amber-400/50" />
        <span className="text-[9px] text-muted-foreground/40 font-mono hidden sm:inline">engine v2 · CP-SAT</span>
      </div>
    </div>
  );
}

function TabSpinner() {
  return (
    <div className="flex items-center justify-center h-[60vh] gap-3 text-muted-foreground">
      <div className="w-5 h-5 border-2 border-orange-400 border-t-transparent rounded-full animate-spin" />
      <p className="text-sm">Caricamento modulo…</p>
    </div>
  );
}

/* ── Main page ───────────────────────────────────────────── */
export default function FucinaPage() {
  const [, navigate] = useLocation();
  // Sub-routes:
  //   /fucina/:projectId                          → dashboard (ProjectDashboardPage)
  //   /fucina/:projectId/pipeline                 → pipeline da step 0
  //   /fucina/:projectId/vehicles                 → lista scenari vetture (VehicleScenariosPage)
  //   /fucina/:projectId/vehicles/:scenarioId     → workspace step 6 (questo file)
  //   /fucina/:projectId/drivers                  → lista scenari turni guida (DriverScenariosPage)
  //   /fucina/:projectId/drivers/:scenarioId      → workspace step 7 (questo file)
  const [matchPipeline, paramsPipeline] = useRoute<{ projectId: string }>("/fucina/:projectId/pipeline");
  const [matchVehiclesWs, paramsVehiclesWs] = useRoute<{ projectId: string; scenarioId: string }>("/fucina/:projectId/vehicles/:scenarioId");
  const [matchDriversWs, paramsDriversWs]   = useRoute<{ projectId: string; scenarioId: string }>("/fucina/:projectId/drivers/:scenarioId");
  const projectId =
    paramsPipeline?.projectId ?? paramsVehiclesWs?.projectId ?? paramsDriversWs?.projectId ?? null;
  const startMode: "pipeline" | "vehicles" | "drivers" | null =
    matchVehiclesWs ? "vehicles" : matchDriversWs ? "drivers" : matchPipeline ? "pipeline" : null;
  const routeScenarioId = paramsVehiclesWs?.scenarioId ?? paramsDriversWs?.scenarioId ?? null;

  const initialStep = startMode === "vehicles" ? 6 : startMode === "drivers" ? 7 : 0;
  const initialCompleted = startMode === "vehicles" ? new Set([0,1,2,3,4,5])
                          : startMode === "drivers"  ? new Set([0,1,2,3,4,5,6])
                          : new Set<number>();

  const [showSplash, setShowSplash] = useState(!projectId);
  const [step, setStep] = useState<number>(initialStep);
  const [completedSteps, setCompletedSteps] = useState<Set<number>>(initialCompleted as Set<number>);
  const [gtfsSelection, setGtfsSelection] = useState<GtfsSelection | null>(null);
  const [vehicleAssignment, setVehicleAssignment] = useState<VehicleAssignment | null>(null);
  const [selectedDepotId, setSelectedDepotId] = useState<string | null>(null);
  const [selectedClusterIds, setSelectedClusterIds] = useState<string[]>([]);
  const [deadheadMatrix, setDeadheadMatrix] = useState<DeadheadMatrix | null>(null);
  const [optimizationResult, setOptimizationResult] = useState<ServiceProgramResult | null>(null);
  const [savedScenarioId, setSavedScenarioId] = useState<string | null>(null);

  // ── Lock GTFS al feed materializzato dal PsProject ──────────
  // Quando il progetto ha planning_studio_project_id, il feed è "fissato" e
  // l'utente NON può scegliere/importare un altro GTFS dallo step 0.
  const [psLocked, setPsLocked] = useState(false);
  const [psSyncing, setPsSyncing] = useState(false);
  const [psNeedsSync, setPsNeedsSync] = useState(false);
  // Se il progetto è agganciato a un'UDP, queste sono le sole linee da mostrare.
  const [udpRouteIds, setUdpRouteIds] = useState<string[] | null>(null);
  const [psProjectId, setPsProjectId] = useState<string | null>(null);
  // Lista completa dei cluster del Network Engine (per UI di selezione nel DeadheadStep)
  const [availableClusters, setAvailableClusters] = useState<{ id: string; name: string; color?: string | null }[]>([]);
  // true dopo che il useEffect di auto-bind ha completato il primo run.
  // Serve per evitare di mostrare lo schermo "progetto legacy" durante la fetch.
  const [psBootstrapped, setPsBootstrapped] = useState(false);

  const completeStep = (s: number) => {
    setCompletedSteps(prev => new Set([...prev, s]));
    setStep(s + 1);
  };

  // ── Guard per jump diretti: se entri da /vehicles o /drivers ma manca state, torna alla dashboard
  useEffect(() => {
    if (!projectId || !startMode) return;
    if (startMode === "pipeline") return;
    // Se nell'URL c'è ?scenario=ID o lo scenarioId è nel path, lascia che il deep-link faccia il suo lavoro
    const hasScenarioParam = new URLSearchParams(window.location.search).get("scenario");
    if (hasScenarioParam || routeScenarioId) return;
    // Aspetta un tick per dare tempo a deep-link di popolare lo state
    const t = setTimeout(() => {
      if (startMode === "vehicles" && !optimizationResult) {
        toast.warning("Nessuno scenario in memoria", {
          description: "Apri uno scenario salvato dalla dashboard del progetto.",
        });
        navigate(`/fucina/${projectId}`);
      }
      if (startMode === "drivers" && !savedScenarioId) {
        toast.warning("Nessuno scenario di vetture salvato", {
          description: "Apri uno scenario di vetture per accedere ai turni guida.",
        });
        navigate(`/fucina/${projectId}`);
      }
    }, 600);
    return () => clearTimeout(t);
  }, [projectId, startMode, optimizationResult, savedScenarioId, navigate]);


  // ── Auto-bind GTFS dal PsProject linkato (pipeline mode con projectId) ─────
  // Se il progetto scheduling è collegato a un PsProject, il GTFS è "fissato"
  // sul feed materializzato dal Network Engine: l'utente NON sceglie/importa.
  useEffect(() => {
    if (!projectId || startMode !== "pipeline") return;
    let cancelled = false;
    (async () => {
      try {
        const proj = await getSchedulingProject(projectId);
        if (cancelled) return;
        if (!proj.planningStudioProjectId) {
          // Progetto legacy senza PS linkato → comportamento classico (step 0 con scelta)
          setPsBootstrapped(true);
          return;
        }
        setPsLocked(true);
        setPsProjectId(String(proj.planningStudioProjectId));
        setUdpRouteIds(Array.isArray(proj.validityUnitRouteIds) ? proj.validityUnitRouteIds : null);

        const buildSelection = async (feedIdToUse: string, label: string): Promise<GtfsSelection | null> => {
          // Recupera feedStartDate dal feed
          try {
            const base = getApiBase();
            const r = await fetch(`${base}/api/gtfs/feeds`);
            const data = await r.json();
            const feeds: any[] = Array.isArray(data?.data) ? data.data : [];
            const f = feeds.find(x => x.id === feedIdToUse);
            const date = (f?.feedStartDate || "").replace(/-/g, "").slice(0, 8)
              || new Date().toISOString().slice(0, 10).replace(/-/g, "");
            return { source: "existing", date, label, tempFeedId: feedIdToUse };
          } catch {
            return { source: "existing", date: new Date().toISOString().slice(0, 10).replace(/-/g, ""), label, tempFeedId: feedIdToUse };
          }
        };

        if (proj.feedId) {
          const sel = await buildSelection(proj.feedId, proj.feedLabel || `PS · ${proj.name}`);
          if (cancelled || !sel) return;
          setGtfsSelection(sel);
          setCompletedSteps(prev => new Set([...prev, 0]));
          // Avanza allo step 1 solo se sei ancora allo step 0
          setStep(s => (s === 0 ? 1 : s));
        } else {
          // Manca il feed: tentiamo l'auto-sync silenzioso (la materializzazione
          // viene avviata fire-and-forget alla creazione del progetto, ma può
          // non essere ancora completata; rilanciandola qui chiudiamo la race).
          try {
            const r = await syncProjectFromPs(projectId);
            if (cancelled) return;
            const sel: GtfsSelection = {
              source: "existing",
              date: r.feedStartDate || new Date().toISOString().slice(0, 10).replace(/-/g, ""),
              label: r.label,
              tempFeedId: r.feedId,
            };
            setGtfsSelection(sel);
            setCompletedSteps(prev => new Set([...prev, 0]));
            setStep(s => (s === 0 ? 1 : s));
            toast.success("Dati Planning Studio sincronizzati automaticamente", {
              description: `${r.counts.routes} linee · ${r.counts.trips} corse · ${r.counts.stops} fermate`,
            });
          } catch (syncErr: any) {
            if (cancelled) return;
            // Auto-sync fallita: mostro la schermata "Sincronizza con PS" come fallback
            console.warn("[fucina] auto-sync PS→feed failed:", syncErr?.message);
            setPsNeedsSync(true);
          }
        }
      } catch (e: any) {
        console.warn("[fucina] auto-bind PS feed failed", e);
      } finally {
        if (!cancelled) setPsBootstrapped(true);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, startMode]);

  // Progresso sync (in secondi) da mostrare nella UI durante materializzazione
  const [psSyncElapsed, setPsSyncElapsed] = useState<number>(0);

  // Helper: lancia sync manuale PS → feed
  async function handleSyncFromPs() {
    if (!projectId) return;
    setPsSyncing(true);
    setPsSyncElapsed(0);
    try {
      const r = await syncProjectFromPs(projectId, ({ elapsedMs }) => {
        setPsSyncElapsed(Math.floor(elapsedMs / 1000));
      });
      const sel: GtfsSelection = {
        source: "existing",
        date: r.feedStartDate || new Date().toISOString().slice(0, 10).replace(/-/g, ""),
        label: r.label,
        tempFeedId: r.feedId,
      };
      setGtfsSelection(sel);
      setPsNeedsSync(false);
      setCompletedSteps(prev => new Set([...prev, 0]));
      setStep(s => (s === 0 ? 1 : s));
      toast.success("Dati Planning Studio sincronizzati", {
        description: `${r.counts.routes} linee · ${r.counts.trips} corse · ${r.counts.stops} fermate`,
      });
    } catch (e: any) {
      toast.error("Errore sincronizzazione", { description: e?.message || "Riprova" });
    } finally {
      setPsSyncing(false);
    }
  }

  // ── Auto-popola availableClusters / selectedClusterIds ─────────────────────
  // I cluster vivono nelle tabelle legacy `stop_clusters` (gestione UI: pagina
  // /cluster del Network Engine), che NON sono partizionate per tenant/feed.
  //
  // Per evitare doppioni di cluster appartenenti ad altri progetti/feed,
  // usiamo l'endpoint POST /api/clusters/by-routes che filtra i cluster
  // realmente "toccati" dalle linee selezionate nella data scelta sul feed
  // corrente. Niente assignment ⇒ niente lista (la selezione cluster ha
  // senso solo dopo aver scelto le route in step 1).
  useEffect(() => {
    const feedId = gtfsSelection?.tempFeedId;
    const date = gtfsSelection?.date; // YYYYMMDD
    const routeIds = vehicleAssignment
      ? Array.from(vehicleAssignment.selectedRoutes.keys())
      : [];
    if (!feedId || !date || routeIds.length === 0) return;
    let cancelled = false;
    (async () => {
      try {
        const dateIso = date.replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3");
        const r = await fetch(`${getApiBase()}/api/clusters/by-routes`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ routeIds, date: dateIso, feedId, psProjectId }),
        });
        if (!r.ok) return;
        const data = await r.json();
        const list: any[] = Array.isArray(data?.data) ? data.data : [];
        if (cancelled) return;
        // Solo cluster effettivamente toccati dalle route selezionate sul feed corrente.
        const touched = list.filter(c => c.touched === true);
        // Dedupe difensiva per nome normalizzato (mantiene il primo id).
        const seen = new Set<string>();
        const unique = touched.filter(c => {
          const key = String(c.name || "").trim().toLowerCase();
          if (!key || seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        setAvailableClusters(unique.map(c => ({
          id: c.id,
          name: c.name,
          color: c.color || null,
        })));
        setSelectedClusterIds(unique.map(c => c.id));
      } catch (e) {
        console.warn("[fucina] auto-load clusters failed", e);
      }
    })();
    return () => { cancelled = true; };
  }, [gtfsSelection?.tempFeedId, gtfsSelection?.date, vehicleAssignment, psProjectId]);


  React.useEffect(() => {
    (window as any).__virgilioFucinaReady = true;
    const handler = (e: Event) => {
      const d = (e as CustomEvent).detail as {
        action: "start" | "goto_step" | "highlight_field";
        step?: number;
        field_id?: string;
        label?: string;
      };
      if (!d) return;
      if (d.action === "start") {
        setShowSplash(false);
        setStep(0);
        return;
      }
      if (d.action === "goto_step" && typeof d.step === "number") {
        setShowSplash(false);
        setStep(Math.max(0, Math.min(7, d.step)));
        return;
      }
      if (d.action === "highlight_field" && d.field_id) {
        // riusa il sistema tentacoli con prefisso fucina:
        window.dispatchEvent(
          new CustomEvent("virgilio:highlight", {
            detail: { target: d.field_id, label: d.label, color: "amber" },
          }),
        );
      }
    };
    window.addEventListener("virgilio:fucina", handler as EventListener);
    return () => {
      window.removeEventListener("virgilio:fucina", handler as EventListener);
      (window as any).__virgilioFucinaReady = false;
    };
  }, []);

  // ── Deep-link: /fucina?scenario=ID  oppure  /fucina/:pid/vehicles/:scenarioId  oppure  /drivers/:scenarioId
  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const scenarioId = params.get("scenario") ?? routeScenarioId;
    if (!scenarioId) return;

    let cancelled = false;
    (async () => {
      try {
        const base = getApiBase();
        const res = await fetch(`${base}/api/service-program/scenarios/${scenarioId}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const detail = await res.json();
        if (cancelled) return;
        if (!detail.result) throw new Error("Scenario senza risultato");

        // Ricostruisci uno gtfsSelection minimale dai dati dello scenario salvato
        const dateRaw: string = detail.date || detail.result?.summary?.date || "";
        const dateLabel = dateRaw && dateRaw.length === 8
          ? `${dateRaw.slice(0, 4)}-${dateRaw.slice(4, 6)}-${dateRaw.slice(6, 8)}`
          : dateRaw || "—";
        setGtfsSelection({
          source: "existing",
          date: dateRaw,
          label: detail.name || `Scenario ${dateLabel}`,
        });
        setOptimizationResult(detail.result as ServiceProgramResult);
        setSavedScenarioId(String(scenarioId));
        setShowSplash(false);
        setCompletedSteps(new Set([0, 1, 2, 3, 4, 5]));
        // Se siamo in /drivers/:scenarioId vai allo step 7, altrimenti workspace vetture (6)
        setStep(startMode === "drivers" ? 7 : 6);
        toast.success("Scenario riaperto", {
          description: detail.name || `Scenario #${scenarioId}`,
        });
      } catch (e: any) {
        if (cancelled) return;
        toast.error("Errore caricamento scenario", { description: e.message });
      }
    })();

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeScenarioId]);

  return (
    <>
      <AnimatePresence>
        {showSplash && (
          <SplashScreen
            onEnter={() => setShowSplash(false)}
            onBack={() => navigate("/network")}
          />
        )}
      </AnimatePresence>

      {!showSplash && (
        <div className="h-full flex flex-col overflow-hidden">
          <StepperBar
            current={step}
            completed={completedSteps}
            onStepClick={setStep}
          />

          <div className="flex-1 overflow-y-auto">
            <AnimatePresence mode="wait">
              <motion.div
                key={step}
                initial={{ opacity: 0, x: 18 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -18 }}
                transition={{ duration: 0.2 }}
                className="h-full"
              >
                <Suspense fallback={<TabSpinner />}>
                  {/* Guard hard: se siamo agli step 6/7 ma manca lo state richiesto,
                      mostriamo un placeholder invece di crashare nei figli. */}
                  {(step === 6 || step === 7) && (!gtfsSelection || !optimizationResult) ? (
                    <div className="flex flex-col items-center justify-center h-[60vh] text-center px-6 gap-3">
                      <div className="w-12 h-12 rounded-full bg-orange-500/15 border border-orange-500/30 flex items-center justify-center">
                        <Truck className="w-6 h-6 text-orange-400" />
                      </div>
                      <h3 className="text-base font-bold text-zinc-100">Nessuno scenario in memoria</h3>
                      <p className="text-sm text-zinc-400 max-w-sm">
                        Per aprire l'Area di Lavoro serve uno scenario di vetture caricato.
                        Torna alla dashboard del progetto e seleziona uno degli scenari salvati,
                        oppure esegui la pipeline.
                      </p>
                      {projectId && (
                        <button
                          onClick={() => navigate(`/fucina/${projectId}`)}
                          className="mt-2 inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-bold text-black bg-gradient-to-r from-orange-400 to-amber-400"
                        >
                          ← Torna alla dashboard del progetto
                        </button>
                      )}
                    </div>
                  ) : (
                  <>
                  {step === 0 && (
                    <div className="p-6 max-w-2xl mx-auto">
                      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
                        <div className="flex items-center gap-3 mb-6">
                          <div className="w-10 h-10 rounded-xl bg-purple-500/10 border border-purple-500/30 flex items-center justify-center">
                            <Database className="w-5 h-5 text-purple-300" />
                          </div>
                          <div>
                            <h2 className="text-base font-bold text-foreground">Dati ancorati al Network Engine</h2>
                            <p className="text-xs text-muted-foreground">Il GTFS di questo progetto è quello del Planning Studio collegato.</p>
                          </div>
                        </div>

                        {!psBootstrapped || psSyncing ? (
                          <div className="bg-purple-500/5 border border-purple-500/30 rounded-xl p-5 flex items-center gap-3 text-purple-200">
                            <div className="w-4 h-4 border-2 border-purple-300 border-t-transparent rounded-full animate-spin" />
                            <span className="text-sm">
                              {psSyncing
                                ? `Materializzazione PS → feed in corso… ${psSyncElapsed > 0 ? `(${psSyncElapsed}s)` : ""}`
                                : "Carico il feed dal Planning Studio…"}
                            </span>
                          </div>
                        ) : !psLocked ? (
                          <div className="bg-red-500/5 border border-red-500/30 rounded-xl p-5 space-y-3">
                            <div className="flex items-center gap-2 text-red-300">
                              <Database className="w-4 h-4" />
                              <span className="text-sm font-semibold">Progetto non collegato al Network Engine</span>
                            </div>
                            <p className="text-sm text-zinc-300">
                              Lo Scheduling Engine ora lavora esclusivamente su feed materializzati dal
                              Planning Studio. Questo progetto è legacy: ricrealo dal Network Engine per
                              continuare.
                            </p>
                            <button
                              onClick={() => navigate("/planner-studio")}
                              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm border border-purple-500/40 text-purple-300 hover:bg-purple-500/10"
                            >
                              Vai al Network Engine <ChevronRight className="w-4 h-4" />
                            </button>
                          </div>
                        ) : (
                          <div className="bg-amber-500/5 border border-amber-500/30 rounded-xl p-5 space-y-4">
                            <div className="flex items-center gap-2 text-amber-300">
                              <Database className="w-4 h-4" />
                              <span className="text-sm font-semibold">Feed non ancora sincronizzato</span>
                            </div>
                            <p className="text-sm text-zinc-300">
                              Per lavorare su questo progetto serve materializzare i dati del Planning Studio
                              in un feed di scheduling. È un'operazione idempotente: puoi rilanciarla quando vuoi.
                            </p>
                            <button
                              onClick={handleSyncFromPs}
                              disabled={psSyncing}
                              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg font-semibold text-sm text-black bg-gradient-to-r from-fuchsia-400 to-purple-400 disabled:opacity-50"
                            >
                              {psSyncing
                                ? `Sincronizzazione in corso… ${psSyncElapsed > 0 ? `(${psSyncElapsed}s)` : ""}`
                                : "Sincronizza con Planning Studio"}
                              {!psSyncing && <ChevronRight className="w-4 h-4" />}
                            </button>
                          </div>
                        )}
                      </motion.div>
                    </div>
                  )}
                  {step === 1 && (
                    <VehicleAssignmentStep
                      gtfsSelection={gtfsSelection!}
                      initial={vehicleAssignment ?? undefined}
                      allowedRouteIds={udpRouteIds}
                      onBack={() => projectId ? navigate(`/fucina/${projectId}`) : setStep(0)}
                      onComplete={(a) => {
                        setVehicleAssignment(a);
                        completeStep(1);
                      }}
                    />
                  )}
                  {step === 2 && (
                    <DepotStep
                      initial={selectedDepotId}
                      onBack={() => setStep(1)}
                      onComplete={(depotId) => {
                        setSelectedDepotId(depotId);
                        // Salta lo step 3 (Cluster di Cambio): i cluster sono
                        // gestiti nel Network Engine e auto-caricati come
                        // selectedClusterIds via useEffect.
                        setCompletedSteps(prev => new Set([...prev, 2, 3]));
                        setStep(4);
                      }}
                    />
                  )}
                  {step === 4 && (
                    vehicleAssignment ? (
                      <DeadheadStep
                        gtfsSelection={gtfsSelection!}
                        assignment={vehicleAssignment}
                        depotId={selectedDepotId!}
                        clusterIds={selectedClusterIds}
                        availableClusters={availableClusters}
                        onClusterIdsChange={setSelectedClusterIds}
                        initial={deadheadMatrix}
                        onBack={() => setStep(2)}
                        onComplete={(matrix) => {
                          setDeadheadMatrix(matrix);
                          completeStep(4);
                        }}
                      />
                    ) : (
                      <MissingStateNotice
                        onRestart={() => setStep(1)}
                        onForward={savedScenarioId ? () => setStep(6) : undefined}
                      />
                    )
                  )}
                  {step === 5 && (
                    vehicleAssignment ? (
                      <OptimizerStep
                        gtfsSelection={gtfsSelection!}
                        assignment={vehicleAssignment}
                        initialResult={optimizationResult ?? undefined}
                        projectId={projectId}
                        psProjectId={psProjectId}
                        depotId={selectedDepotId}
                        onBack={() => setStep(4)}
                        onComplete={(r, id) => {
                          setOptimizationResult(r);
                          if (id) setSavedScenarioId(id);
                          completeStep(5);
                        }}
                      />
                    ) : (
                      <MissingStateNotice
                        onRestart={() => setStep(1)}
                        onForward={savedScenarioId ? () => setStep(6) : undefined}
                      />
                    )
                  )}
                  {step === 6 && (
                    <WorkspaceStep
                      gtfsSelection={gtfsSelection!}
                      optimizationResult={optimizationResult!}
                      deadheadMatrix={deadheadMatrix}
                      savedScenarioId={savedScenarioId ?? undefined}
                      onBack={() => setStep(5)}
                      // In pipeline mode con progetto: il bottone diventa
                      // "Salva e torna al progetto" (forziamo il flusso
                      // dashboard-driven). Negli altri casi: classico
                      // "Turni Guida →" che salta allo step 7 in linea.
                      {...(projectId && startMode === "pipeline"
                        ? {
                            projectId,
                            onSaveAndReturn: (id?: string) => {
                              if (id) setSavedScenarioId(id);
                              navigate(`/fucina/${projectId}`);
                            },
                          }
                        : { onContinueToDriverShifts: () => setStep(7) })}
                    />
                  )}
                  {step === 7 && (
                    <DriverWorkspaceStep
                      gtfsSelection={gtfsSelection!}
                      vehicleScenarioId={savedScenarioId ?? ""}
                      onBack={() => setStep(6)}
                    />
                  )}
                  </>
                  )}
                </Suspense>
              </motion.div>
            </AnimatePresence>
          </div>
        </div>
      )}
    </>
  );
}
