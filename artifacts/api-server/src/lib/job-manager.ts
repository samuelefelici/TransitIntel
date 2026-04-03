/**
 * JobManager — gestione job asincroni con progress streaming SSE
 *
 * Features:
 *  - Concurrency limiter: max N solver simultanei (default 2)
 *  - Queued jobs are FIFO-ordered with priority support
 *  - Progress streaming via SSE (EventEmitter)
 *  - Job state persistence to disk (survives restarts for completed jobs)
 *  - Auto-cleanup after TTL
 *
 * Ogni job spawna un processo Python, parsifica le righe PROGRESS su stderr,
 * e le emette tramite EventEmitter ai client SSE connessi.
 *
 * Protocollo stderr:  PROGRESS|phase|percentage|detail|extra_json
 * Esempio:  PROGRESS|enum_duties|35|Enumerating 12400 duties|{"duties":12400}
 */

import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/* ─── Types ─────────────────────────────────────────────────── */

export type JobStatus = "queued" | "running" | "completed" | "failed" | "stopped";

export interface JobProgress {
  phase: string;
  percentage: number;
  detail: string;
  extra?: Record<string, unknown>;
  timestamp: number;
}

export interface Job {
  id: string;
  scenarioId: string;
  status: JobStatus;
  progress: JobProgress;
  progressHistory: JobProgress[];
  result: unknown | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  pid: number | null;
  /** Arbitrary metadata attached at creation (e.g. scenarioName, date) */
  metadata?: Record<string, unknown>;
}

/* ─── Internal state per job ───────────────────────────────── */

interface JobInternal extends Job {
  process: ChildProcess | null;
  emitter: EventEmitter;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
}

interface CreateJobOpts {
  scenarioId: string;
  scriptPath: string;
  args: string[];
  inputJson: unknown;
  logger: { info: (...a: any[]) => void; error: (...a: any[]) => void };
  metadata?: Record<string, unknown>;
}

/* ─── Constants ─────────────────────────────────────────────── */

const JOB_TTL_MS = 30 * 60_000; // 30 min dopo completion → cleanup
const MAX_PROGRESS_HISTORY = 200;
const MAX_CONCURRENCY = 2; // max 2 solver Python in parallelo

// ── Persistence ─────────────────────────────────────────────
const CACHE_DIR = path.resolve(process.cwd(), ".cache");
const JOBS_SNAPSHOT = path.join(CACHE_DIR, "jobs-snapshot.json");

/* ─── Manager singleton ─────────────────────────────────────── */

class JobManager {
  private jobs = new Map<string, JobInternal>();
  private runningCount = 0;
  private pendingQueue: { jobId: string; opts: CreateJobOpts }[] = [];

  constructor() {
    this.restoreCompletedFromDisk();
  }

  /* ── Persistence helpers ──────────────────────────────────── */

  private restoreCompletedFromDisk() {
    try {
      if (fs.existsSync(JOBS_SNAPSHOT)) {
        const raw = JSON.parse(fs.readFileSync(JOBS_SNAPSHOT, "utf-8")) as Job[];
        const now = Date.now();
        for (const j of raw) {
          if (now - j.updatedAt > JOB_TTL_MS) continue; // expired
          if (j.status !== "completed" && j.status !== "failed") continue; // only restore terminal states
          const internal: JobInternal = {
            ...j,
            process: null,
            emitter: new EventEmitter(),
            cleanupTimer: null,
          };
          this.jobs.set(j.id, internal);
          this.scheduleCleanup(internal);
        }
      }
    } catch {
      // corrupted → ignore
    }
  }

  private snapshotToDisk() {
    try {
      if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
      const terminal: Job[] = [];
      for (const j of this.jobs.values()) {
        if (j.status === "completed" || j.status === "failed") {
          terminal.push(this.toPublicJob(j));
        }
      }
      fs.writeFileSync(JOBS_SNAPSHOT, JSON.stringify(terminal), "utf-8");
    } catch {
      // best-effort
    }
  }

  /* ── Concurrency gate ─────────────────────────────────────── */

  private tryDequeue() {
    while (this.runningCount < MAX_CONCURRENCY && this.pendingQueue.length > 0) {
      const next = this.pendingQueue.shift()!;
      const job = this.jobs.get(next.jobId);
      if (job && job.status === "queued") {
        this.runJob(job, next.opts);
      }
    }
  }

  /* ── Create & run job ─────────────────────────────────────── */

  createJob(opts: CreateJobOpts): string {
    const id = randomUUID();
    const now = Date.now();

    const emitter = new EventEmitter();
    emitter.setMaxListeners(50); // allow many SSE clients

    const job: JobInternal = {
      id,
      scenarioId: opts.scenarioId,
      status: "queued",
      progress: { phase: "init", percentage: 0, detail: "In coda…", timestamp: now },
      progressHistory: [],
      result: null,
      error: null,
      createdAt: now,
      updatedAt: now,
      pid: null,
      metadata: opts.metadata,
      process: null,
      emitter,
      cleanupTimer: null,
    };

    this.jobs.set(id, job);

    // Queue the job — it will be dequeued when a slot is free
    this.pendingQueue.push({ jobId: id, opts });
    this.tryDequeue();

    return id;
  }

  /** Queue position (0-based). Returns -1 if not queued. */
  getQueuePosition(jobId: string): number {
    return this.pendingQueue.findIndex(q => q.jobId === jobId);
  }

  /** Number of currently running solver processes. */
  getRunningCount(): number {
    return this.runningCount;
  }

  /** Number of jobs waiting in queue. */
  getQueueLength(): number {
    return this.pendingQueue.length;
  }

  private runJob(
    job: JobInternal,
    opts: CreateJobOpts,
  ) {
    this.runningCount++;
    try {
      const py = spawn("python3", [opts.scriptPath, ...opts.args], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env },
      });

      job.process = py;
      job.pid = py.pid ?? null;
      job.status = "running";
      job.updatedAt = Date.now();
      this.emitProgress(job, { phase: "starting", percentage: 0, detail: "Processo Python avviato", timestamp: Date.now() });

      let stdout = "";
      let stderrBuf = "";

      py.stdout!.on("data", (d: Buffer) => {
        stdout += d.toString();
      });

      py.stderr!.on("data", (d: Buffer) => {
        const chunk = d.toString();
        stderrBuf += chunk;

        // Parse progress lines
        const lines = stderrBuf.split("\n");
        stderrBuf = lines.pop() ?? ""; // keep incomplete line in buffer

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          if (trimmed.startsWith("PROGRESS|")) {
            const parsed = this.parseProgressLine(trimmed);
            if (parsed) {
              this.emitProgress(job, parsed);
            }
          } else {
            // Normal stderr log → forward to logger
            opts.logger.info(`[Job ${job.id.slice(0, 8)}] ${trimmed}`);
          }
        }
      });

      py.on("error", (err) => {
        job.status = "failed";
        job.error = `Errore avvio Python: ${err.message}`;
        job.updatedAt = Date.now();
        this.emitProgress(job, { phase: "error", percentage: 100, detail: job.error, timestamp: Date.now() });
        job.emitter.emit("done");
        this.scheduleCleanup(job);
      });

      py.on("close", (code) => {
        // Flush remaining stderr
        if (stderrBuf.trim()) {
          const trimmed = stderrBuf.trim();
          if (trimmed.startsWith("PROGRESS|")) {
            const parsed = this.parseProgressLine(trimmed);
            if (parsed) this.emitProgress(job, parsed);
          }
        }

        if (job.status === "stopped") {
          // Already handled by stopJob
          job.emitter.emit("done");
          this.scheduleCleanup(job);
          return;
        }

        if (code !== 0) {
          job.status = "failed";
          job.error = `Python exit code ${code}`;
          job.updatedAt = Date.now();
          this.emitProgress(job, { phase: "error", percentage: 100, detail: job.error, timestamp: Date.now() });
        } else {
          try {
            job.result = JSON.parse(stdout);
            job.status = "completed";
            job.updatedAt = Date.now();
            this.emitProgress(job, { phase: "done", percentage: 100, detail: "Ottimizzazione completata", timestamp: Date.now() });
          } catch {
            job.status = "failed";
            job.error = "Errore parsing output JSON";
            job.updatedAt = Date.now();
            this.emitProgress(job, { phase: "error", percentage: 100, detail: job.error, timestamp: Date.now() });
          }
        }

        job.emitter.emit("done");
        this.scheduleCleanup(job);
      });

      // Write input JSON to stdin
      const jsonStr = JSON.stringify(opts.inputJson);
      py.stdin!.write(jsonStr);
      py.stdin!.end();

    } catch (err: any) {
      job.status = "failed";
      job.error = err.message;
      job.updatedAt = Date.now();
      job.emitter.emit("done");
      this.scheduleCleanup(job);
    }
  }

  /* ── Progress parsing & emission ──────────────────────────── */

  private parseProgressLine(line: string): JobProgress | null {
    // PROGRESS|phase|percentage|detail|extra_json
    const parts = line.split("|");
    if (parts.length < 4) return null;

    const phase = parts[1] || "unknown";
    const percentage = Math.min(100, Math.max(0, parseFloat(parts[2]) || 0));
    const detail = parts[3] || "";
    let extra: Record<string, unknown> | undefined;
    if (parts[4]) {
      try { extra = JSON.parse(parts[4]); } catch { /* ignore */ }
    }

    return { phase, percentage, detail, extra, timestamp: Date.now() };
  }

  private emitProgress(job: JobInternal, progress: JobProgress) {
    job.progress = progress;
    job.updatedAt = Date.now();

    // Keep history bounded
    job.progressHistory.push(progress);
    if (job.progressHistory.length > MAX_PROGRESS_HISTORY) {
      job.progressHistory = job.progressHistory.slice(-MAX_PROGRESS_HISTORY);
    }

    // Emit SSE event
    job.emitter.emit("progress", {
      jobId: job.id,
      status: job.status,
      progress,
    });
  }

  /* ── Stop job ─────────────────────────────────────────────── */

  stopJob(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job || !job.process || job.status !== "running") return false;

    job.status = "stopped";
    job.updatedAt = Date.now();
    this.emitProgress(job, { phase: "stopped", percentage: job.progress.percentage, detail: "Fermato dall'utente", timestamp: Date.now() });

    // Send SIGINT for graceful shutdown, then SIGKILL after 5s
    job.process.kill("SIGINT");
    setTimeout(() => {
      if (job.process && !job.process.killed) {
        job.process.kill("SIGKILL");
      }
    }, 5000);

    return true;
  }

  /* ── Query ────────────────────────────────────────────────── */

  private toPublicJob(j: JobInternal): Job {
    return {
      id: j.id,
      scenarioId: j.scenarioId,
      status: j.status,
      progress: j.progress,
      progressHistory: j.progressHistory,
      result: j.result,
      error: j.error,
      createdAt: j.createdAt,
      updatedAt: j.updatedAt,
      pid: j.pid,
      metadata: j.metadata,
    };
  }

  getJob(jobId: string): Job | null {
    const j = this.jobs.get(jobId);
    if (!j) return null;
    return this.toPublicJob(j);
  }

  getJobEmitter(jobId: string): EventEmitter | null {
    return this.jobs.get(jobId)?.emitter ?? null;
  }

  getJobsByScenario(scenarioId: string): Job[] {
    const out: Job[] = [];
    for (const j of this.jobs.values()) {
      if (j.scenarioId === scenarioId) {
        out.push(this.getJob(j.id)!);
      }
    }
    return out;
  }

  /* ── Cleanup ──────────────────────────────────────────────── */

  private scheduleCleanup(job: JobInternal) {
    // Free a concurrency slot and try next queued job
    this.runningCount = Math.max(0, this.runningCount - 1);
    this.tryDequeue();

    // Persist terminal states to disk
    this.snapshotToDisk();

    if (job.cleanupTimer) clearTimeout(job.cleanupTimer);
    job.cleanupTimer = setTimeout(() => {
      job.emitter.removeAllListeners();
      this.jobs.delete(job.id);
    }, JOB_TTL_MS);
  }
}

/* ── Singleton export ───────────────────────────────────────── */

export const jobManager = new JobManager();
