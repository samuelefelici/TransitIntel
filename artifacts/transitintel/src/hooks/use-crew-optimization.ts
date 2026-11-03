/**
 * useCrewOptimization — Hook per ottimizzazione turni guida con SSE progress streaming
 *
 * Gestisce il ciclo di vita: idle → starting → running → completed/failed
 * Utilizza EventSource (SSE) per progress real-time, con fallback polling.
 *
 * Il calcolo gira sulla coda dei lavori del server e sopravvive ai riavvii e
 * alla pagina (2.7b): uscire o ricaricare non lo ferma. Il calcolo aperto per
 * uno scenario è ricordato nel browser (lib/memoria-calcoli) e la pagina lo
 * riprende al montaggio, anche se è finito mentre era chiusa; «I miei
 * calcoli» lo apre con ?calcolo=<id>. Lo fermano solo lo stop, il reset e un
 * nuovo avvio. Dopo il salvataggio dello scenario la pagina chiama
 * dimenticaCalcolo().
 */

import { useState, useRef, useCallback, useEffect } from "react";
import { getApiBase } from "@/lib/api";
import { ricorda, richiama, dimentica, chiaveTurniGuida } from "@/lib/memoria-calcoli";
import { annunciaAvvio } from "@/lib/calcoli";

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
  /* legacy (non più letti da crew_scheduler_v4) */
  undertimeDeduction?: number;
  drivingPremium?: number;
  idlePenalty?: number;
  companyCar?: number;
  taxiTransfer?: number;
  fragmentationPenalty?: number;
  imbalancePenalty?: number;
  /* chiavi allineate a cost_model.py CostRates.from_config (v4) */
  hourlyRate?: number;
  overtimeMultiplier?: number;
  supplementoFixed?: number;
  supplementoDaily?: number;
  idleRateFraction?: number;
  interruptionRateFraction?: number;
  preTurnoRateFraction?: number;
  transferRateFraction?: number;
  companyCarPerUse?: number;
  taxiBase?: number;
  taxiPerKm?: number;
  taxiPerMinWait?: number;
  cambioOverhead?: number;
  cambioRiskPerMinShort?: number;
  fragmentationPerGap?: number;
  workImbalancePerMin?: number;
  longIdlePenaltyPerMin?: number;
  extraDriverDaily?: number;
  companyCars?: number;
}

export interface OperatorConfig {
  shiftRules?: Record<string, { maxNastro?: number; intMin?: number; intMax?: number; maxPct?: number }>;
  weights?: Record<string, number>;
  solverIntensity?: number;
  /** budget di tempo del solver in secondi (pannello Parametri & Regole) */
  timeLimit?: number;
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
    /** profilo regole per tipo servizio (urbano/extraurbano/misto) */
    shiftRules?: Record<string, { maxNastro?: number; maxLavoro?: number; intMin?: number; intMax?: number; maxPct?: number; sostaMinCapolinea?: number }>;
    targetWork?: { low?: number; high?: number; mid?: number };
    serviceType?: "urbano" | "extraurbano" | "misto";
    prePost?: Record<string, number>;
    /** RD 131/1938 — guida continuativa (Python legge bds.rd131 con fallback cee561) */
    rd131?: Record<string, any>;
    cee561?: Record<string, any>;
    pasto?: Record<string, any>;
    stacco?: Record<string, number>;
    riprese?: Record<string, any>;
    copertura?: Record<string, any>;
    collegamento?: Record<string, any>;
    /* Fase 2 — avanzate: soglie/scoring tagli e multi-scenario */
    cuts?: Record<string, number>;
    cutScoring?: Record<string, number>;
    scenari?: Record<string, number>;
    /* Sosta inoperosa (extraurbano): durata minima + contributo all'orario */
    sostaInoperosa?: Record<string, number>;
    /* CSP optimizer overrides — saturazione & cap vetture */
    optimizer?: {
      minWorkPerDuty?: number;     // min lavoro/turno (min) — default 360
      maxCompanyCars?: number;     // cap HARD vetture aziendali — default 5
      weightDutyCount?: number;    // peso minimizzazione N turni — default 20000 (FIX-CSP-1)
      weightIdlePenalty?: number;  // peso penalizzazione idle time — default 30
      idlePenaltyMaxMin?: number;  // soglia max idle penalizzato — default 60
      scorePerDuty?: number;       // bonus score per duty (FIX-CSP-2) — default 100
      pctOverPenalty?: number;     // penalità per punto-% oltre cap soft — default 150
    };
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
  optimizationAnalysis?: any;
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
  /** Il risultato è salvato: il calcolo non va più ripreso riaprendo la pagina */
  dimenticaCalcolo: () => void;
}

export interface OpzioniCrewOptimization {
  /** lo scenario dei turni macchina della pagina: il calcolo aperto per lui si riprende al montaggio */
  scenarioId?: string | null;
  /** un calcolo da aprire (da «I miei calcoli», ?calcolo=<id>) */
  calcolo?: string | null;
  /**
   * La vecchia pagina /driver-shifts: lì il calcolo resta legato alla pagina
   * come prima (uscire lo ferma) e non si ricorda, perché quella pagina non lo
   * riprenderebbe.
   */
  vecchiaPagina?: boolean;
}

/* ─── Hook ─────────────────────────────────────────────────── */

const JOB_GONE_MESSAGE =
  "L'ottimizzazione non è più disponibile sul server. Rilancia l'ottimizzazione.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Ferma un calcolo sul server senza aspettare la risposta (keepalive: vale anche uscendo dalla pagina). */
function fermaSulServer(jId: string): void {
  fetch(`${getApiBase()}/api/driver-shifts/jobs/${jId}/stop`, { method: "POST", keepalive: true }).catch(() => {});
}

export function useCrewOptimization(opzioni: OpzioniCrewOptimization = {}): UseCrewOptimizationReturn {
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
  // conteggio 404 consecutivi in polling: il job è sparito (oltre 30 giorni)
  const notFoundRef = useRef<number>(0);
  // il calcolo vivo sul server seguito dalla pagina (un nuovo avvio o il reset lo fermano)
  const vivoRef = useRef<string | null>(null);
  // lo scenario del calcolo seguito: la chiave della memoria nel browser
  const scenarioRef = useRef<string | null>(null);
  // sale a ogni avvio, reset e smontaggio: una risposta di un avvio vecchio non si aggancia
  const generazioneRef = useRef<number>(0);

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
    vivoRef.current = null;
    closeSSE();
    stopPolling();
    stopTimer();
  }, [closeSSE, stopPolling, stopTimer]);

  /** Il calcolo non va più ripreso (finito male, fermato, salvato, scartato). */
  const dimenticaCalcolo = useCallback(() => {
    if (scenarioRef.current) dimentica(chiaveTurniGuida(scenarioRef.current));
  }, []);

  /** Un esito che chiude il calcolo senza risultato da tenere: fallito o fermato. */
  const finitoMale = useCallback((stato: "failed" | "stopped", messaggio: string) => {
    setError(messaggio);
    setState(stato);
    dimenticaCalcolo();
    cleanup();
  }, [cleanup, dimenticaCalcolo]);

  /** La pagina lascia il calcolo (nuovo avvio, reset): lo si ferma anche sul server. */
  const abbandona = useCallback(() => {
    generazioneRef.current += 1;
    const j = vivoRef.current;
    vivoRef.current = null;
    if (j) fermaSulServer(j);
  }, []);

  // Smontaggio: si smette di seguire, il calcolo continua sul server (e si riprende
  // riaprendo). Nella vecchia pagina invece uscire lo ferma, come prima.
  const vecchiaPagina = !!opzioni.vecchiaPagina;
  useEffect(() => () => {
    generazioneRef.current += 1;
    if (vecchiaPagina && vivoRef.current) fermaSulServer(vivoRef.current);
    cleanup();
  }, [cleanup, vecchiaPagina]);

  /* ── Start timer ──────────────────────────────────────────── */

  const startTimer = useCallback((dal: number = Date.now()) => {
    stopTimer();
    startTimeRef.current = dal;
    setElapsedSec(Math.max(0, Math.round((Date.now() - dal) / 1000)));
    timerRef.current = setInterval(() => {
      setElapsedSec(Math.round((Date.now() - startTimeRef.current) / 1000));
    }, 1000);
  }, [stopTimer]);

  /* ── Fallback polling ─────────────────────────────────────── */

  const startFallbackPolling = useCallback((jId: string) => {
    stopPolling();
    notFoundRef.current = 0;
    const base = getApiBase();

    pollingRef.current = setInterval(async () => {
      try {
        const resp = await fetch(`${base}/api/driver-shifts/jobs/${jId}`);
        // 404 dell'API (JSON con error) = il job non esiste più. Dopo alcuni
        // tentativi consecutivi lo dichiariamo perso invece di ciclare all'infinito.
        // Il 404 del proxy (pagina di testo, API giù durante un riavvio) è transitorio.
        if (resp.status === 404) {
          const corpo = await resp.json().catch(() => null);
          if (!corpo || typeof corpo.error !== "string") return;
          notFoundRef.current += 1;
          if (notFoundRef.current >= 3) finitoMale("failed", JOB_GONE_MESSAGE);
          return;
        }
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        notFoundRef.current = 0;
        const data = await resp.json();

        if (data.progress) {
          setProgress(data.progress);
        }

        if (data.status === "completed" && data.data) {
          setResult(data.data);
          setState("completed");
          cleanup();
        } else if (data.status === "failed" || data.status === "stopped") {
          finitoMale(data.status, data.error || "Ottimizzazione terminata");
        }
      } catch {
        // Errore di rete transitorio — riprova al prossimo intervallo (non è un 404)
      }
    }, 2000);
  }, [stopPolling, cleanup, finitoMale]);

  /* ── SSE connection ───────────────────────────────────────── */

  const connectSSE = useCallback((jId: string) => {
    closeSSE();
    const base = getApiBase();
    const url = `${base}/api/driver-shifts/jobs/${jId}/stream`;
    // withCredentials: in produzione l'API è su un'altra origine e senza il cookie
    // lo stream risponderebbe 401 (si ripiegava sempre sul polling)
    const es = new EventSource(url, { withCredentials: true });
    eventSourceRef.current = es;

    es.addEventListener("progress", (evt) => {
      try {
        const data = JSON.parse((evt as MessageEvent).data);
        const prog = data.progress as OptimizationProgress;
        setProgress(prog);
        setProgressHistory((prev) => [...prev, prog]);
        setState("running");
      } catch { /* ignore bad event */ }
    });

    es.addEventListener("status", (evt) => {
      try {
        const data = JSON.parse((evt as MessageEvent).data);
        if (data.progress) {
          setProgress(data.progress);
        }
      } catch { /* ignore */ }
    });

    es.addEventListener("result", (evt) => {
      try {
        const data = JSON.parse((evt as MessageEvent).data);
        setResult(data.data);
        setState("completed");
        cleanup();
      } catch {
        finitoMale("failed", "Errore parsing risultato");
      }
    });

    es.addEventListener("error", (evt) => {
      // SSE "error" event can be either a server error event or connection error
      if (evt instanceof MessageEvent) {
        try {
          const data = JSON.parse(evt.data);
          finitoMale(data.status === "stopped" ? "stopped" : "failed", data.error || "Errore ottimizzazione");
          return;
        } catch { /* fallthrough */ }
      }
      // Connection error — try fallback polling
      if (eventSourceRef.current !== es) return;
      closeSSE();
      startFallbackPolling(jId);
    });

    es.onerror = () => {
      // Connection lost — try polling (solo se è ancora questo lo stream seguito:
      // dopo un risultato, uno stop o un nuovo avvio non si riparte a interrogare)
      if (eventSourceRef.current !== es) return;
      closeSSE();
      startFallbackPolling(jId);
    };
  }, [closeSSE, cleanup, finitoMale, startFallbackPolling]);

  /* ── Ripresa al montaggio ─────────────────────────────────── */

  // Il calcolo aperto per lo scenario (o quello chiesto da «I miei calcoli»): se
  // c'è ancora, lo si segue; finito mentre la pagina era chiusa, arriva il risultato.
  useEffect(() => {
    const sid = opzioni.scenarioId;
    if (!sid) return;
    const daLink = opzioni.calcolo && UUID.test(opzioni.calcolo) ? opzioni.calcolo : null;
    const jId = daLink ?? richiama(chiaveTurniGuida(sid))?.jobId ?? null;
    if (!jId) return;
    const generazione = generazioneRef.current;
    fetch(`${getApiBase()}/api/driver-shifts/jobs/${jId}`)
      .then(async (resp) => {
        if (generazione !== generazioneRef.current) return;
        if (resp.status === 404) {
          const corpo = await resp.json().catch(() => null);
          if (corpo && typeof corpo.error === "string") dimentica(chiaveTurniGuida(sid));
          return;
        }
        if (!resp.ok) return;
        const data = await resp.json();
        if (generazione !== generazioneRef.current) return;
        // un calcolo di un altro scenario (link sbagliato o memoria vecchia) non si apre qui
        if (data.scenarioId && data.scenarioId !== sid) {
          if (!daLink) dimentica(chiaveTurniGuida(sid));
          return;
        }
        scenarioRef.current = sid;
        if (daLink) ricorda(chiaveTurniGuida(sid), { jobId: jId, avviatoIl: Number(data.createdAt) || Date.now() });
        setJobId(jId);
        setError(null);
        if (data.progress) setProgress(data.progress);
        if (data.status === "completed" && data.data) {
          setResult(data.data);
          setState("completed");
          return;
        }
        if (data.status === "completed") {
          // riuscito, ma il risultato è stato tolto dalla pulizia (oltre 7 giorni)
          setError("Il risultato di questo calcolo non è più disponibile (oltre 7 giorni): rilancialo.");
          setState("idle");
          dimentica(chiaveTurniGuida(sid));
          return;
        }
        if (data.status === "failed" || data.status === "stopped") {
          // finito male a pagina chiusa: si dice una volta, poi non si riprende più
          finitoMale(data.status, data.error || "Ottimizzazione terminata");
          return;
        }
        vivoRef.current = jId;
        setState("running");
        startTimer(Number(data.createdAt) || Date.now());
        connectSSE(jId);
      })
      .catch(() => { /* server non raggiungibile: niente ripresa, la memoria resta */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opzioni.scenarioId]);
  // (nella vecchia pagina scenarioId non si passa: niente ripresa)

  /* ── Start optimization ───────────────────────────────────── */

  const start = useCallback((scenarioId: string, timeLimit = 120, config?: OperatorConfig) => {
    abbandona();
    dimenticaCalcolo();
    cleanup();
    const generazione = generazioneRef.current;
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
        // nel frattempo la pagina ha rilanciato o resettato: questo calcolo non lo segue nessuno
        if (generazione !== generazioneRef.current) { fermaSulServer(jId); return; }
        vivoRef.current = jId;
        if (!vecchiaPagina) {
          scenarioRef.current = scenarioId;
          ricorda(chiaveTurniGuida(scenarioId), { jobId: jId, avviatoIl: Date.now() });
        }
        annunciaAvvio();
        setJobId(jId);
        setState("running");
        connectSSE(jId);
      })
      .catch((err) => {
        if (generazione !== generazioneRef.current) return;
        setError(err.message);
        setState("failed");
        stopTimer();
      });
  }, [abbandona, dimenticaCalcolo, cleanup, startTimer, connectSSE, stopTimer, vecchiaPagina]);

  /* ── Stop optimization ────────────────────────────────────── */

  const stop = useCallback(() => {
    if (!jobId) return;
    const base = getApiBase();
    dimenticaCalcolo();

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
  }, [jobId, cleanup, dimenticaCalcolo]);

  /* ── Reset ────────────────────────────────────────────────── */

  const reset = useCallback(() => {
    abbandona();
    dimenticaCalcolo();
    cleanup();
    setState("idle");
    setProgress(null);
    setProgressHistory([]);
    setResult(null);
    setError(null);
    setJobId(null);
    setElapsedSec(0);
  }, [abbandona, cleanup, dimenticaCalcolo]);

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
    dimenticaCalcolo,
  };
}
