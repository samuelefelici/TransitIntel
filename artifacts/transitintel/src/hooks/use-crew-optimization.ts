/**
 * useCrewOptimization — Hook per ottimizzazione turni guida con SSE progress streaming
 *
 * Gestisce il ciclo di vita: idle → starting → running → completed/failed
 * Utilizza EventSource (SSE) per progress real-time, con fallback polling.
 */

import { useState, useRef, useCallback, useEffect } from "react";
import { getApiBase } from "@/lib/api";

/* ─── Types ─────────────────────────────────────────────────── */

export interface OptimizationProgress {
  phase: string;
  percentage: number;
  detail: string;
  extra?: Record<string, unknown>;
  timestamp: number;
}

export type OptimizationState = "idle" | "starting" | "running" | "completed" | "failed" | "stopped";

export interface CostRates {
  hourlyRate?: number;
  overtimeMultiplier?: number;
  undertimeDeduction?: number;
  drivingPremium?: number;
  idlePenalty?: number;
  companyCar?: number;
  taxiTransfer?: number;
  cambioOverhead?: number;
  extraDriverDaily?: number;
  supplementoFixed?: number;
  fragmentationPenalty?: number;
  imbalancePenalty?: number;
  companyCars?: number;
}

export interface OperatorConfig {
  shiftRules?: Record<string, { maxNastro?: number; intMin?: number; intMax?: number; maxPct?: number }>;
  weights?: Record<string, number>;
  solverIntensity?: number;
  maxRounds?: number;
  pinnedConstraints?: {
    lockedDuties?: string[];
    pinnedTasks?: Record<number, string>;
    forbidCambi?: [number, number][];
    forceCambi?: [number, number][];
    maxCambiPerTurno?: number | null;
  };
  maxDuties?: number | null;
  /* v2 cost-based fields */
  taskGranularity?: "auto" | "fine" | "medium" | "coarse";
  enableCrossCluster?: boolean;
  enableTaxiFallback?: boolean;
  cutOnlyAtClusters?: boolean;
  costRates?: CostRates;
  /* scenario-level scope */
  selectedClusterIds?: string[];
  companyCars?: number;
  /* v4 BDS normativa */
  bds?: {
    prePost?: Record<string, number>;
    cee561?: Record<string, any>;
    pasto?: Record<string, any>;
    stacco?: Record<string, number>;
    riprese?: Record<string, any>;
    copertura?: Record<string, any>;
    collegamento?: Record<string, any>;
  };
}

export interface CrewOptimizationResult {
  solver: string;
  scenarioId: string;
  driverShifts: any[];
  summary: any;
  unassignedBlocks: number;
  clusters: any[];
  companyCars: number;
  solverMetrics: any;
}

export interface UseCrewOptimizationReturn {
  /** Current state of the optimization */
  state: OptimizationState;
  /** Current progress (updates in real-time via SSE) */
  progress: OptimizationProgress | null;
  /** Full progress history */
  progressHistory: OptimizationProgress[];
  /** Optimization result (when completed) */
  result: CrewOptimizationResult | null;
  /** Error message (when failed) */
  error: string | null;
  /** Job ID (when running) */
  jobId: string | null;
  /** Elapsed seconds since start */
  elapsedSec: number;
  /** Start optimization */
  start: (scenarioId: string, timeLimit?: number, config?: OperatorConfig) => void;
  /** Stop running optimization */
  stop: () => void;
  /** Reset to idle */
  reset: () => void;
}

/* ─── Hook ─────────────────────────────────────────────────── */

export function useCrewOptimization(): UseCrewOptimizationReturn {
  const [state, setState] = useState<OptimizationState>("idle");
  const [progress, setProgress] = useState<OptimizationProgress | null>(null);
  const [progressHistory, setProgressHistory] = useState<OptimizationProgress[]>([]);
  const [result, setResult] = useState<CrewOptimizationResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [elapsedSec, setElapsedSec] = useState(0);

  const eventSourceRef = useRef<EventSource | null>(null);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef<number>(0);

  /* ── Cleanup helpers ──────────────────────────────────────── */

  const stopTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const stopPolling = useCallback(() => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
  }, []);

  const closeSSE = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
  }, []);

  const cleanup = useCallback(() => {
    closeSSE();
    stopPolling();
    stopTimer();
  }, [closeSSE, stopPolling, stopTimer]);

  // Cleanup on unmount
  useEffect(() => cleanup, [cleanup]);

  /* ── Start timer ──────────────────────────────────────────── */

  const startTimer = useCallback(() => {
    startTimeRef.current = Date.now();
    setElapsedSec(0);
    timerRef.current = setInterval(() => {
      setElapsedSec(Math.round((Date.now() - startTimeRef.current) / 1000));
    }, 1000);
  }, []);

  /* ── SSE connection ───────────────────────────────────────── */

  const connectSSE = useCallback((jId: string) => {
    closeSSE();
    const base = getApiBase();
    const url = `${base}/api/driver-shifts/jobs/${jId}/stream`;
    const es = new EventSource(url);
    eventSourceRef.current = es;

    es.addEventListener("progress", (evt) => {
      try {
        const data = JSON.parse(evt.data);
        const prog = data.progress as OptimizationProgress;
        setProgress(prog);
        setProgressHistory((prev) => [...prev, prog]);
        setState("running");
      } catch { /* ignore bad event */ }
    });

    es.addEventListener("status", (evt) => {
      try {
        const data = JSON.parse(evt.data);
        if (data.progress) {
          setProgress(data.progress);
        }
      } catch { /* ignore */ }
    });

    es.addEventListener("result", (evt) => {
      try {
        const data = JSON.parse(evt.data);
        setResult(data.data);
        setState("completed");
        cleanup();
      } catch {
        setError("Errore parsing risultato");
        setState("failed");
        cleanup();
      }
    });

    es.addEventListener("error", (evt) => {
      // SSE "error" event can be either a server error event or connection error
      if (evt instanceof MessageEvent) {
        try {
          const data = JSON.parse(evt.data);
          setError(data.error || "Errore ottimizzazione");
          setState(data.status === "stopped" ? "stopped" : "failed");
          cleanup();
          return;
        } catch { /* fallthrough */ }
      }
      // Connection error — try fallback polling
      closeSSE();
      startFallbackPolling(jId);
    });

    es.onerror = () => {
      // Connection lost — try polling
      closeSSE();
      startFallbackPolling(jId);
    };
  }, [closeSSE, cleanup]);

  /* ── Fallback polling ─────────────────────────────────────── */

  const startFallbackPolling = useCallback((jId: string) => {
    stopPolling();
    const base = getApiBase();

    pollingRef.current = setInterval(async () => {
      try {
        const resp = await fetch(`${base}/api/driver-shifts/jobs/${jId}`);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();

        if (data.progress) {
          setProgress(data.progress);
        }

        if (data.status === "completed" && data.data) {
          setResult(data.data);
          setState("completed");
          cleanup();
        } else if (data.status === "failed" || data.status === "stopped") {
          setError(data.error || "Ottimizzazione terminata");
          setState(data.status);
          cleanup();
        }
      } catch {
        // Polling failed — will retry next interval
      }
    }, 2000);
  }, [stopPolling, cleanup]);

  /* ── Start optimization ───────────────────────────────────── */

  const start = useCallback((scenarioId: string, timeLimit = 120, config?: OperatorConfig) => {
    cleanup();
    setState("starting");
    setProgress(null);
    setProgressHistory([]);
    setResult(null);
    setError(null);
    setJobId(null);
    startTimer();

    const base = getApiBase();

    fetch(`${base}/api/driver-shifts/${scenarioId}/cpsat/async`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ timeLimit, config }),
    })
      .then(async (resp) => {
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({}));
          throw new Error(err.error || `HTTP ${resp.status}`);
        }
        return resp.json();
      })
      .then((data) => {
        const jId = data.jobId;
        setJobId(jId);
        setState("running");
        connectSSE(jId);
      })
      .catch((err) => {
        setError(err.message);
        setState("failed");
        stopTimer();
      });
  }, [cleanup, startTimer, connectSSE, stopTimer]);

  /* ── Stop optimization ────────────────────────────────────── */

  const stop = useCallback(() => {
    if (!jobId) return;
    const base = getApiBase();

    fetch(`${base}/api/driver-shifts/jobs/${jobId}/stop`, { method: "POST" })
      .then(() => {
        setState("stopped");
        cleanup();
      })
      .catch(() => {
        // Force cleanup anyway
        setState("stopped");
        cleanup();
      });
  }, [jobId, cleanup]);

  /* ── Reset ────────────────────────────────────────────────── */

  const reset = useCallback(() => {
    cleanup();
    setState("idle");
    setProgress(null);
    setProgressHistory([]);
    setResult(null);
    setError(null);
    setJobId(null);
    setElapsedSec(0);
  }, [cleanup]);

  return {
    state,
    progress,
    progressHistory,
    result,
    error,
    jobId,
    elapsedSec,
    start,
    stop,
    reset,
  };
}
