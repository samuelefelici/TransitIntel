/**
 * Sorveglianza Argos (Agentic 2) — il controllo periodico del progetto, e i
 * giri automatici sugli obiettivi, quando il pannello è CHIUSO.
 *
 * Chi la attiva ne diventa l'owner: lo scheduler lavora per suo conto (token
 * on-behalf mintato al momento, come per la chat agentica). Cadenza per
 * progetto; l'esito arriva "a novità": il rapporto tutto_ok non disturba
 * nessuno, i findings accendono il badge nel pannello (unseen).
 *
 * Rotte utente (autenticate): GET/POST /api/ai/argos/watch, POST .../seen.
 * Rotta cron (pubblica, x-cron-secret): POST /api/cron/argos-watch — da
 * agganciare a uno scheduler esterno (es. ogni ora); a ogni tick processa un
 * lotto limitato di sorveglianze scadute, in sequenza, con timeout duri.
 */
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { hasProjectAccess } from "./argos-context";
import { mintShortLivedUserToken } from "../lib/auth";
import { logger } from "../lib/logger";

const ARGOS_URL = (process.env.ARGOS_URL || "").replace(/\/+$/, "");
const ARGOS_CLIENT_SLUG = process.env.ARGOS_CLIENT_SLUG || "tpl-personale";
const UUID_RE = /^[0-9a-f-]{36}$/i;

/* Lotto e timeout del tick: la sorveglianza gira in sequenza (un progetto
 * alla volta) e ogni giro ha un tetto duro — un progetto lento non deve
 * mangiarsi il tick degli altri. */
const BATCH_PER_TICK = 3;
const WATCH_TIMEOUT_MS = 300_000; // 5' per il giro di sorveglianza
const GOAL_TIMEOUT_MS = 540_000; // 9' per un giro-obiettivo (il token vive 10')

let ensured = false;
async function ensureWatchTable(): Promise<void> {
  if (ensured) return;
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS ps_argos_watches (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      project_id    uuid NOT NULL UNIQUE,
      user_id       uuid NOT NULL,
      enabled       boolean NOT NULL DEFAULT true,
      work_goals    boolean NOT NULL DEFAULT false,
      cadence_hours int NOT NULL DEFAULT 24,
      last_run_at   timestamptz,
      last_status   text,
      last_summary  text,
      last_findings jsonb,
      last_goal_note text,
      unseen        boolean NOT NULL DEFAULT false,
      created_at    timestamptz NOT NULL DEFAULT now(),
      updated_at    timestamptz NOT NULL DEFAULT now()
    )
  `);
  ensured = true;
}

function rowToWatch(r: any) {
  return {
    projectId: r.project_id,
    enabled: !!r.enabled,
    workGoals: !!r.work_goals,
    cadenceHours: Number(r.cadence_hours) || 24,
    lastRunAt: r.last_run_at,
    lastStatus: r.last_status,
    lastSummary: r.last_summary,
    lastFindings: r.last_findings || [],
    lastGoalNote: r.last_goal_note,
    unseen: !!r.unseen,
  };
}

async function requireMember(req: any, res: any, projectId: string): Promise<string | null> {
  if (!UUID_RE.test(projectId)) {
    res.status(400).json({ error: "projectId non valido" });
    return null;
  }
  const userId = (req.user?.id ?? req.user?.userId) as string | undefined;
  if (!userId) { res.status(401).json({ error: "Non autenticato" }); return null; }
  const ok = await hasProjectAccess(projectId, userId).catch(() => false);
  if (!ok) { res.status(404).json({ error: "Progetto non trovato o accesso negato" }); return null; }
  return userId;
}

/* ── Rotte utente (montate DOPO requireAuth) ─────────────────────────────── */
const userRouter: IRouter = Router();

// GET /api/ai/argos/watch?projectId=… → stato della sorveglianza (o null)
userRouter.get("/ai/argos/watch", async (req: any, res: any) => {
  const projectId = String(req.query.projectId || "");
  const userId = await requireMember(req, res, projectId);
  if (!userId) return;
  await ensureWatchTable();
  const r = await db.execute(sql`SELECT * FROM ps_argos_watches WHERE project_id = ${projectId}::uuid`);
  const row = ((r as any).rows ?? [])[0];
  res.json({ watch: row ? rowToWatch(row) : null });
});

// POST /api/ai/argos/watch { projectId, enabled?, workGoals?, cadenceHours? }
// Upsert: chi tocca la sorveglianza ne diventa l'owner (il cron lavorerà per
// suo conto). Cadenza tra 1 e 168 ore.
userRouter.post("/ai/argos/watch", async (req: any, res: any) => {
  const { projectId, enabled, workGoals, cadenceHours } = req.body as {
    projectId?: string; enabled?: boolean; workGoals?: boolean; cadenceHours?: number;
  };
  const userId = await requireMember(req, res, String(projectId || ""));
  if (!userId) return;
  await ensureWatchTable();
  const cad = Math.min(168, Math.max(1, Math.round(Number(cadenceHours) || 24)));
  const r = await db.execute(sql`
    INSERT INTO ps_argos_watches (project_id, user_id, enabled, work_goals, cadence_hours)
    VALUES (${projectId}::uuid, ${userId}::uuid, ${enabled !== false}, ${workGoals === true}, ${cad})
    ON CONFLICT (project_id) DO UPDATE
      SET user_id = EXCLUDED.user_id,
          enabled = COALESCE(${typeof enabled === "boolean" ? enabled : null}, ps_argos_watches.enabled),
          work_goals = COALESCE(${typeof workGoals === "boolean" ? workGoals : null}, ps_argos_watches.work_goals),
          cadence_hours = ${typeof cadenceHours === "number" ? cad : sql`ps_argos_watches.cadence_hours`},
          updated_at = now()
    RETURNING *
  `);
  res.json({ watch: rowToWatch(((r as any).rows ?? [])[0]) });
});

// POST /api/ai/argos/watch/seen { projectId } → novità lette
userRouter.post("/ai/argos/watch/seen", async (req: any, res: any) => {
  const { projectId } = req.body as { projectId?: string };
  const userId = await requireMember(req, res, String(projectId || ""));
  if (!userId) return;
  await ensureWatchTable();
  await db.execute(sql`
    UPDATE ps_argos_watches SET unseen = false, updated_at = now()
     WHERE project_id = ${projectId}::uuid
  `);
  res.json({ ok: true });
});

/* ── Drenaggio SSE: il cron consuma gli stream di Argos come farebbe la UI ── */
async function drainSse(path: string, body: any, timeoutMs: number): Promise<Record<string, any>> {
  const found: Record<string, any> = {};
  try {
    const upstream = await fetch(`${ARGOS_URL}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!upstream.ok || !upstream.body) {
      const detail = await upstream.text().catch(() => "");
      return { error: `HTTP ${upstream.status}${detail ? `: ${detail.slice(0, 200)}` : ""}` };
    }
    let buffer = "";
    const decoder = new TextDecoder();
    for await (const chunk of upstream.body as any) {
      buffer += decoder.decode(chunk, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() || "";
      for (const part of parts) {
        let data = "";
        for (const line of part.split("\n")) {
          if (line.startsWith("data:")) data += line.slice(5).trimStart();
        }
        if (!data) continue;
        try {
          const p = JSON.parse(data);
          for (const k of ["watch", "goal", "error", "done"]) {
            if (p[k] !== undefined) found[k] = p[k];
          }
        } catch { /* frammento non-JSON: testo del giro, non ci serve */ }
      }
    }
  } catch (err: any) {
    return { ...found, error: err?.message || "stream interrotto" };
  }
  return found;
}

/** Se work_goals: un giro sull'obiettivo ATTIVO fermo da più tempo (uno per
 *  tick: il budget va dosato — gli altri toccheranno ai tick successivi). */
async function runOldestActiveGoal(projectId: string, userId: string): Promise<{ goal?: any; error?: string } | null> {
  try {
    const r = await fetch(`${ARGOS_URL}/agent/goals?project_id=${encodeURIComponent(projectId)}`,
                          { signal: AbortSignal.timeout(15000) });
    const d: any = await r.json().catch(() => ({}));
    const goals: any[] = (d?.goals || []).filter((g: any) => g.status === "active");
    if (goals.length === 0) return null;
    goals.sort((a, b) => String(a.updated_at || "").localeCompare(String(b.updated_at || "")));
    const target = goals[0];
    const out = await drainSse(`/agent/goals/${target.id}/run/stream`, {
      client_slug: ARGOS_CLIENT_SLUG, project_id: projectId,
      // Token fresco: quello del giro di sorveglianza potrebbe essere a fine vita.
      ti_auth_token: mintShortLivedUserToken(userId), note: "",
    }, GOAL_TIMEOUT_MS);
    return { goal: out.goal, error: out.error };
  } catch (err: any) {
    return { error: err?.message || "giro obiettivo fallito" };
  }
}

/* ── Rotta cron (montata PRIMA di requireAuth, guardia x-cron-secret) ────── */
const cronRouter: IRouter = Router();

/* POST /api/cron/argos-mcp-token — token utente a breve scadenza per il
 * connettore MCP di Argos (SOLA LETTURA): dato il progetto, si conia un token
 * per il suo OWNER, con cui Argos legge on-behalf-of-user gli endpoint di
 * Planning Studio. Stessa guardia x-cron-secret del tick di sorveglianza: il
 * segreto è condiviso solo col backend di Argos, mai coi client MCP (che
 * hanno la loro chiave dedicata, verificata da Argos). */
cronRouter.post("/cron/argos-mcp-token", async (req: any, res: any) => {
  const secret = req.headers["x-cron-secret"];
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const projectId = String(req.body?.projectId || "");
  if (!UUID_RE.test(projectId)) { res.status(400).json({ error: "projectId non valido" }); return; }
  const r = await db.execute(sql`
    SELECT owner_user_id FROM ps_projects WHERE id = ${projectId}::uuid
  `);
  const owner = (r as any).rows?.[0]?.owner_user_id;
  if (!owner) { res.status(404).json({ error: "progetto non trovato" }); return; }
  res.json({ token: mintShortLivedUserToken(String(owner)), expiresInSec: 600 });
});

// POST /api/cron/argos-watch — un tick dello scheduler esterno (es. ogni ora)
cronRouter.post("/cron/argos-watch", async (req: any, res: any) => {
  const secret = req.headers["x-cron-secret"];
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  if (!ARGOS_URL) { res.status(503).json({ error: "Argos non configurato (ARGOS_URL mancante)" }); return; }
  await ensureWatchTable();
  const due = await db.execute(sql`
    SELECT * FROM ps_argos_watches
     WHERE enabled = true
       AND (last_run_at IS NULL OR last_run_at < now() - (cadence_hours * interval '1 hour'))
     ORDER BY last_run_at ASC NULLS FIRST
     LIMIT ${BATCH_PER_TICK}
  `);
  const rows: any[] = (due as any).rows ?? [];
  const results: any[] = [];
  for (const w of rows) {
    const projectId = String(w.project_id);
    let status = "errore";
    let summary = "";
    let findings: any[] = [];
    let goalNote: string | null = null;
    let goalChanged = false;
    try {
      const out = await drainSse("/agent/watch/stream", {
        client_slug: ARGOS_CLIENT_SLUG, project_id: projectId,
        ti_auth_token: mintShortLivedUserToken(String(w.user_id)),
      }, WATCH_TIMEOUT_MS);
      if (out.watch) {
        status = String(out.watch.status || "errore");
        summary = String(out.watch.summary || "");
        findings = Array.isArray(out.watch.findings) ? out.watch.findings : [];
      } else if (out.error) {
        summary = String(out.error).slice(0, 300);
      }
      if (w.work_goals) {
        const g = await runOldestActiveGoal(projectId, String(w.user_id));
        if (g?.goal) {
          const last = (g.goal.progress || [])[(g.goal.progress || []).length - 1];
          goalNote = `#${g.goal.id} ${g.goal.title} — ${g.goal.status}${last?.note ? `: ${String(last.note).slice(0, 300)}` : ""}`;
          goalChanged = g.goal.status === "achieved" || g.goal.status === "blocked";
        } else if (g?.error) {
          goalNote = `giro obiettivo non riuscito: ${String(g.error).slice(0, 200)}`;
        }
      }
    } catch (err: any) {
      summary = err?.message || "tick fallito";
    }
    // Il badge (unseen) si accende SOLO per cose che l'utente vorrebbe vedere:
    // findings nuovi, o un obiettivo passato a raggiunto/bloccato.
    await db.execute(sql`
      UPDATE ps_argos_watches
         SET last_run_at = now(), last_status = ${status}, last_summary = ${summary},
             last_findings = ${JSON.stringify(findings)}::jsonb,
             last_goal_note = ${goalNote},
             unseen = unseen OR ${findings.length > 0 || goalChanged},
             updated_at = now()
       WHERE id = ${String(w.id)}::uuid
    `);
    results.push({ projectId, status, findings: findings.length, goal: goalNote });
    logger.info({ projectId, status, findings: findings.length }, "argos-watch tick");
  }
  res.json({ processed: rows.length, results });
});

export { userRouter as argosWatchRouter, cronRouter as argosWatchCronRouter };
