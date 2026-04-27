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
import React, { lazy, Suspense, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useLocation } from "wouter";
import { toast } from "sonner";
import {
  Flame, ArrowLeft, ChevronRight, Zap,
  Database, Bus, Truck, CheckCircle2, ArrowRight, Layers, Route, Building2,
} from "lucide-react";
import type { ServiceProgramResult } from "@/pages/optimizer-route/types";
import type { DeadheadMatrix } from "@/pages/fucina/steps/DeadheadStep";
import { getApiBase } from "@/lib/api";

const GtfsSelectorStep = lazy(() => import("@/pages/fucina/steps/GtfsSelectorStep"));
const VehicleAssignmentStep = lazy(() => import("@/pages/fucina/steps/VehicleAssignmentStep"));
const DepotStep = lazy(() => import("@/pages/fucina/steps/DepotStep"));
const ClustersStep = lazy(() => import("@/pages/fucina/steps/ClustersStep"));
const DeadheadStep = lazy(() => import("@/pages/fucina/steps/DeadheadStep"));
const OptimizerStep = lazy(() => import("@/pages/fucina/steps/OptimizerStep"));
const WorkspaceStep = lazy(() => import("@/pages/fucina/steps/WorkspaceStep"));

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

/* ── Definizione step ────────────────────────────────────── */
const STEPS = [
  { id: 0, label: "Dati GTFS",          icon: Database, desc: "Seleziona o importa feed" },
  { id: 1, label: "Abbinamento Vetture", icon: Bus,      desc: "Linee, date, tipo vettura" },
  { id: 2, label: "Deposito",            icon: Building2,desc: "Punto di partenza veicoli" },
  { id: 3, label: "Cluster di Cambio",   icon: Layers,   desc: "Punti di cambio vettura" },
  { id: 4, label: "Fuori Linea",         icon: Route,    desc: "Distanze · tempi · costi" },
  { id: 5, label: "Ottimizzazione",      icon: Zap,      desc: "CP-SAT · analisi · salva" },
  { id: 6, label: "Area di Lavoro",      icon: Truck,    desc: "Gantt · drag & drop · esporta" },
] as const;

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
          {STEPS.map((s, i) => (
            <React.Fragment key={s.id}>
              <span className="flex items-center gap-1.5 text-[10px] px-2.5 py-1 rounded-full border border-orange-500/30 text-orange-400/80 bg-orange-500/5">
                <s.icon className="w-3 h-3" />
                {s.label}
              </span>
              {i < STEPS.length - 1 && <ArrowRight className="w-2.5 h-2.5 text-orange-400/30 shrink-0" />}
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
      {STEPS.map((step, i) => {
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
                {done ? <CheckCircle2 className="w-3 h-3" /> : <span className="text-[10px] font-bold">{step.id + 1}</span>}
              </div>
              <div>
                <p className={`text-[11px] font-semibold leading-tight ${active ? "text-orange-300" : done ? "text-orange-400/80" : "text-zinc-500"}`}>
                  {step.label}
                </p>
                <p className="text-[9px] text-orange-400/30 font-mono">{step.desc}</p>
              </div>
            </button>
            {i < STEPS.length - 1 && (
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
  const [showSplash, setShowSplash] = useState(true);
  const [step, setStep] = useState(0);
  const [completedSteps, setCompletedSteps] = useState<Set<number>>(new Set());
  const [gtfsSelection, setGtfsSelection] = useState<GtfsSelection | null>(null);
  const [vehicleAssignment, setVehicleAssignment] = useState<VehicleAssignment | null>(null);
  const [selectedDepotId, setSelectedDepotId] = useState<string | null>(null);
  const [selectedClusterIds, setSelectedClusterIds] = useState<string[]>([]);
  const [deadheadMatrix, setDeadheadMatrix] = useState<DeadheadMatrix | null>(null);
  const [optimizationResult, setOptimizationResult] = useState<ServiceProgramResult | null>(null);
  const [savedScenarioId, setSavedScenarioId] = useState<string | null>(null);

  const completeStep = (s: number) => {
    setCompletedSteps(prev => new Set([...prev, s]));
    setStep(s + 1);
  };

  // ── 🐙 Virgilio Wizard listener — controlla la pagina via chat ──
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
        setStep(Math.max(0, Math.min(6, d.step)));
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

  // ── Deep-link: /fucina?scenario=ID → carica scenario salvato e va all'Area di Lavoro ──
  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const scenarioId = params.get("scenario");
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
        // Salta la splash e va direttamente all'Area di Lavoro (step 6)
        setShowSplash(false);
        setCompletedSteps(new Set([0, 1, 2, 3, 4, 5]));
        setStep(6);
        toast.success("Scenario riaperto", {
          description: detail.name || `Scenario #${scenarioId}`,
        });
      } catch (e: any) {
        if (cancelled) return;
        toast.error("Errore caricamento scenario", { description: e.message });
      }
    })();

    return () => { cancelled = true; };
  }, []);

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
                  {step === 0 && (
                    <GtfsSelectorStep
                      onComplete={(sel: GtfsSelection) => {
                        setGtfsSelection(sel);
                        completeStep(0);
                      }}
                    />
                  )}
                  {step === 1 && (
                    <VehicleAssignmentStep
                      gtfsSelection={gtfsSelection!}
                      initial={vehicleAssignment ?? undefined}
                      onBack={() => setStep(0)}
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
                        completeStep(2);
                      }}
                    />
                  )}
                  {step === 3 && (
                    <ClustersStep
                      gtfsSelection={gtfsSelection!}
                      assignment={vehicleAssignment!}
                      onBack={() => setStep(2)}
                      onComplete={(ids) => {
                        setSelectedClusterIds(ids);
                        completeStep(3);
                      }}
                    />
                  )}
                  {step === 4 && (
                    <DeadheadStep
                      gtfsSelection={gtfsSelection!}
                      assignment={vehicleAssignment!}
                      depotId={selectedDepotId!}
                      clusterIds={selectedClusterIds}
                      initial={deadheadMatrix}
                      onBack={() => setStep(3)}
                      onComplete={(matrix) => {
                        setDeadheadMatrix(matrix);
                        completeStep(4);
                      }}
                    />
                  )}
                  {step === 5 && (
                    <OptimizerStep
                      gtfsSelection={gtfsSelection!}
                      assignment={vehicleAssignment!}
                      initialResult={optimizationResult ?? undefined}
                      onBack={() => setStep(4)}
                      onComplete={(r, id) => {
                        setOptimizationResult(r);
                        if (id) setSavedScenarioId(id);
                        completeStep(5);
                      }}
                    />
                  )}
                  {step === 6 && (
                    <WorkspaceStep
                      gtfsSelection={gtfsSelection!}
                      optimizationResult={optimizationResult!}
                      savedScenarioId={savedScenarioId ?? undefined}
                      onBack={() => setStep(5)}
                    />
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
