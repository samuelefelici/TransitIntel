/**
 * AI Copilot endpoints
 * - POST /api/ai/chat → streaming SSE chat con tool-calling loop
 * - GET  /api/ai/health → verifica configurazione (presenza API key)
 */
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { mintShortLivedUserToken } from "../lib/auth";
import { getAnthropic, COPILOT_MODEL, COPILOT_MAX_TOKENS } from "../lib/ai/provider";
import { SYSTEM_PROMPT } from "../lib/ai/system-prompt";
import { TOOL_DEFS, executeTool, UI_TOOL_NAMES } from "../lib/ai/tools";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// ─────────────────────────────────────────────────────────────
// Argos — assistente alternativo usato SOLO dentro Planning Studio.
// Il browser non parla mai direttamente con Argos: passa da qui (stesso
// dominio, stessa auth/cookie). Argos gira come servizio separato (FastAPI)
// e viene raggiunto sull'URL interno `ARGOS_URL`. Dentro Planning Studio
// Argos legge i dati del PROGETTO aperto (tabelle ps_*), non il feed in
// esercizio: gli passiamo il project_id come contesto.
// ─────────────────────────────────────────────────────────────
const ARGOS_URL = (process.env.ARGOS_URL || "").replace(/\/+$/, "");
const ARGOS_CLIENT_SLUG = process.env.ARGOS_CLIENT_SLUG || "tpl-personale";
const UUID_RE = /^[0-9a-f-]{36}$/i;

function getUserId(req: any): string | null {
  return req?.session?.userId ?? req?.user?.id ?? null;
}

/** Ritorna la riga del progetto se l'utente vi ha accesso (owner/membro o
 *  progetto messo in esercizio), altrimenti null. Stesso criterio delle altre
 *  rotte Planning Studio (vedi planning-studio-network.ts:loadProject). */
async function loadProjectAccess(projectId: string, userId: string): Promise<any | null> {
  const r = await db.execute(sql`
    SELECT p.id
      FROM ps_projects p
      LEFT JOIN ps_project_members pm
             ON pm.project_id = p.id AND pm.user_id = ${userId}::uuid
     WHERE p.id = ${projectId}::uuid
       AND (
         p.owner_user_id = ${userId}::uuid
         OR pm.user_id IS NOT NULL
         OR (p.materialized_feed_id IS NOT NULL
             AND EXISTS (SELECT 1 FROM gtfs_feeds gf
                          WHERE gf.id = p.materialized_feed_id AND gf.is_active = true))
       )
     LIMIT 1
  `);
  return (r as any).rows?.[0] ?? null;
}

// ─────────────────────────────────────────────────────────────
// GET /api/ai/health  → verifica setup
// ─────────────────────────────────────────────────────────────
router.get("/ai/health", (_req, res) => {
  const configured = !!process.env.ANTHROPIC_API_KEY;
  res.json({
    configured,
    model: COPILOT_MODEL,
    tools: TOOL_DEFS.length,
  });
});

// ─────────────────────────────────────────────────────────────
// POST /api/ai/chat
// Body: { messages: Array<{role:"user"|"assistant", content:string}> }
// Output: SSE stream con eventi:
//   - text: { delta: string }            ← chunk di testo
//   - tool_use: { name, input }          ← LLM sta usando un tool
//   - tool_result: { name, output }      ← risultato del tool
//   - done: { stop_reason, tokens }      ← fine
//   - error: { message }                 ← errore
// ─────────────────────────────────────────────────────────────
router.post("/ai/chat", async (req, res) => {
  const { messages } = req.body as {
    messages: Array<{ role: "user" | "assistant"; content: string }>;
  };

  if (!Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: "messages array richiesto" });
    return;
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    res.status(500).json({ error: "ANTHROPIC_API_KEY non configurata" });
    return;
  }

  // SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // disable nginx buffering
  res.flushHeaders();

  const send = (event: string, data: any) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // Conversation history (sarà mutata mentre il loop tool-call procede)
  const convo: any[] = messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  const MAX_ITERATIONS = 6; // safety cap

  try {
    const client = getAnthropic();

    for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
      // Streaming call
      const stream = client.messages.stream({
        model: COPILOT_MODEL,
        max_tokens: COPILOT_MAX_TOKENS,
        system: SYSTEM_PROMPT,
        tools: TOOL_DEFS,
        messages: convo,
      });

      // raccogli tool_use blocks e testo emesso in questo turno
      const toolUses: Array<{ id: string; name: string; input: any }> = [];
      const assistantContent: any[] = [];

      stream.on("text", (delta: string) => {
        send("text", { delta });
      });

      const finalMsg = await stream.finalMessage();

      totalInputTokens += finalMsg.usage.input_tokens;
      totalOutputTokens += finalMsg.usage.output_tokens;

      // Estrai tool_use blocks
      for (const block of finalMsg.content) {
        assistantContent.push(block);
        if (block.type === "tool_use") {
          toolUses.push({ id: block.id, name: block.name, input: block.input });
        }
      }

      // Aggiungi messaggio assistant alla convo
      convo.push({ role: "assistant", content: assistantContent });

      // Se nessun tool richiesto → fine
      if (toolUses.length === 0 || finalMsg.stop_reason === "end_turn") {
        send("done", {
          stop_reason: finalMsg.stop_reason,
          input_tokens: totalInputTokens,
          output_tokens: totalOutputTokens,
        });
        res.end();
        return;
      }

      // Esegui tools in parallelo
      const toolResults = await Promise.all(
        toolUses.map(async (tu) => {
          send("tool_use", { name: tu.name, input: tu.input });
          try {
            const out = await executeTool(tu.name, tu.input as any);
            send("tool_result", { name: tu.name, output: out });
            // Se è un tool UI, emetti anche l'evento ui_action per il frontend
            if (UI_TOOL_NAMES.has(tu.name)) {
              send("ui_action", { type: tu.name, payload: tu.input });
            }
            return {
              type: "tool_result" as const,
              tool_use_id: tu.id,
              content: JSON.stringify(out).slice(0, 50_000), // safety cap
            };
          } catch (err: any) {
            const errMsg = err?.message || String(err);
            logger.error({ tool: tu.name, err: errMsg }, "tool execution failed");
            send("tool_result", { name: tu.name, output: { error: errMsg } });
            return {
              type: "tool_result" as const,
              tool_use_id: tu.id,
              content: JSON.stringify({ error: errMsg }),
              is_error: true,
            };
          }
        }),
      );

      convo.push({ role: "user", content: toolResults });
      // loop continua → il modello vede i risultati e produce risposta finale (o nuovi tool calls)
    }

    // Hit max iterations
    send("done", {
      stop_reason: "max_iterations",
      input_tokens: totalInputTokens,
      output_tokens: totalOutputTokens,
    });
    res.end();
  } catch (err: any) {
    logger.error({ err: err?.message, stack: err?.stack }, "AI chat error");
    send("error", { message: err?.message || "Errore interno copilot" });
    res.end();
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/ai/argos/health → configurazione (URL Argos + raggiungibilità)
// ─────────────────────────────────────────────────────────────
router.get("/ai/argos/health", async (_req, res) => {
  if (!ARGOS_URL) {
    res.json({ configured: false, reason: "ARGOS_URL non impostata" });
    return;
  }
  try {
    const r = await fetch(`${ARGOS_URL}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    const d: any = await r.json().catch(() => ({}));
    res.json({
      configured: true,
      reachable: r.ok,
      cerbero: !!d?.cerbero_configured, // true ⇒ Argos può leggere i dati ps_*/gtfs_*
      transitintel: !!d?.transitintel_configured, // true ⇒ modalità Agente disponibile
    });
  } catch (err: any) {
    res.json({ configured: true, reachable: false, error: err?.message || "unreachable" });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/ai/argos/chat
// Body: { messages: Array<{role, content}>, projectId?: string }
// Inoltra ad Argos /chat/stream e ristrasmette lo stream SSE così com'è.
// Eventi Argos (data: {...}): {t} testo · {reset} · {error} · {done, sources, budget, tokens}
// ─────────────────────────────────────────────────────────────
router.post("/ai/argos/chat", async (req, res) => {
  const { messages, projectId, deep } = req.body as {
    messages: Array<{ role: "user" | "assistant"; content: string }>;
    projectId?: string;
    deep?: boolean;
  };

  if (!Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: "messages array richiesto" });
    return;
  }
  if (!ARGOS_URL) {
    res.status(503).json({ error: "Argos non configurato (ARGOS_URL mancante)" });
    return;
  }

  // Contesto Planning Studio: se c'è un projectId, verifica che l'utente vi
  // abbia accesso PRIMA di girarlo ad Argos (che legge quel progetto).
  let psProjectId: string | null = null;
  // Token utente a breve scadenza: consente ad Argos di richiamare gli endpoint
  // /api/ai/argos/* e /api/intermodal/* on-behalf-of-user (context, territorio,
  // domanda-copertura). Coniato solo dentro un progetto e con accesso verificato.
  let tiAuthToken: string | null = null;
  if (projectId) {
    if (!UUID_RE.test(projectId)) {
      res.status(400).json({ error: "projectId non valido" });
      return;
    }
    const userId = getUserId(req);
    if (!userId) {
      res.status(401).json({ error: "Non autenticato" });
      return;
    }
    const proj = await loadProjectAccess(projectId, userId).catch(() => null);
    if (!proj) {
      res.status(404).json({ error: "Progetto non trovato o accesso negato" });
      return;
    }
    psProjectId = projectId;
    tiAuthToken = mintShortLivedUserToken(userId);
  }

  // Ultimo turno utente = domanda corrente; il resto = storia della conversazione.
  const last = messages[messages.length - 1];
  const question = (last?.content || "").trim();
  if (!question) {
    res.status(400).json({ error: "domanda vuota" });
    return;
  }
  const history = messages.slice(0, -1).map((m) => ({ role: m.role, content: m.content }));

  // SSE headers (passthrough dello stream di Argos, niente buffering)
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const sendError = (message: string) => {
    res.write(`data: ${JSON.stringify({ error: message })}\n\n`);
  };

  // Abort dell'upstream se il client chiude la connessione.
  const ctrl = new AbortController();
  req.on("close", () => ctrl.abort());

  try {
    const upstream = await fetch(`${ARGOS_URL}/chat/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_slug: ARGOS_CLIENT_SLUG,
        question,
        history,
        planning_studio_project_id: psProjectId,
        ti_auth_token: tiAuthToken, // token on-behalf-of-user per i callback TransitIntel
        deep: !!deep, // ragionamento profondo (Opus, più giri/verifica) — opt-in dal pannello
      }),
      signal: ctrl.signal,
    });

    if (!upstream.ok || !upstream.body) {
      // Errori pre-stream di Argos (404 client / 429 budget / 502 LLM ...):
      // arrivano come JSON {detail}. Li inoltriamo come singolo evento error.
      const detail = await upstream
        .json()
        .then((d: any) => d?.detail || `HTTP ${upstream.status}`)
        .catch(() => `HTTP ${upstream.status}`);
      sendError(String(detail));
      res.end();
      return;
    }

    // Passthrough dei byte dello stream Argos (già in formato SSE `data: {...}`).
    for await (const chunk of upstream.body as any) {
      res.write(chunk);
    }
    res.end();
  } catch (err: any) {
    if (err?.name !== "AbortError") {
      logger.error({ err: err?.message }, "Argos proxy error");
      sendError(err?.message || "Errore proxy Argos");
    }
    res.end();
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/ai/argos/geo — geometria delle linee GTFS per i blocchi ```map
// che Argos inserisce nelle risposte. Passthrough verso Argos /geo/routes.
// ─────────────────────────────────────────────────────────────
router.get("/ai/argos/geo", async (req, res) => {
  if (!ARGOS_URL) {
    res.status(503).json({ error: "Argos non configurato (ARGOS_URL mancante)" });
    return;
  }
  const qs = new URLSearchParams();
  for (const k of ["search", "area", "routes", "pois", "limit"]) {
    const v = req.query[k];
    if (v !== undefined && v !== null && String(v) !== "") qs.set(k, String(v));
  }
  try {
    const upstream = await fetch(`${ARGOS_URL}/geo/routes?${qs.toString()}`, {
      signal: AbortSignal.timeout(12000),
    });
    const data = await upstream.json().catch(() => ({}));
    res.status(upstream.ok ? 200 : 502).json(data);
  } catch (err: any) {
    res.status(502).json({ error: err?.message || "geometria non disponibile" });
  }
});

// ─────────────────────────────────────────────────────────────
// Storico chat Argos — persistente per PROGETTO e per UTENTE.
// La chat di un progetto è unica e sopravvive a chiusura/riapertura e ricarichi.
// ─────────────────────────────────────────────────────────────

/** Verifica projectId valido + utente autenticato + accesso al progetto.
 *  Ritorna lo userId, oppure risponde con l'errore giusto e ritorna null. */
async function requireProjectMember(req: any, res: any, projectId: string): Promise<string | null> {
  if (!UUID_RE.test(projectId || "")) {
    res.status(400).json({ error: "projectId non valido" });
    return null;
  }
  const userId = getUserId(req);
  if (!userId) {
    res.status(401).json({ error: "Non autenticato" });
    return null;
  }
  const proj = await loadProjectAccess(projectId, userId).catch(() => null);
  if (!proj) {
    res.status(404).json({ error: "Progetto non trovato o accesso negato" });
    return null;
  }
  return userId;
}

/** Due conversazioni persistenti per progetto: 'chat' e 'agente'. */
function threadOf(raw: unknown): "chat" | "agente" {
  return raw === "agente" ? "agente" : "chat";
}

// GET /api/ai/argos/history?projectId=...&thread=chat|agente → thread dell'utente
router.get("/ai/argos/history", async (req, res) => {
  const projectId = String(req.query.projectId || "");
  const thread = threadOf(req.query.thread);
  const userId = await requireProjectMember(req, res, projectId);
  if (!userId) return;
  const r = await db.execute(sql`
    SELECT id, role, content, created_at
      FROM ps_argos_messages
     WHERE project_id = ${projectId}::uuid AND user_id = ${userId}::uuid
       AND thread = ${thread}
     ORDER BY id
     LIMIT 2000
  `);
  res.json({ messages: (r as any).rows ?? [] });
});

// POST /api/ai/argos/history  { projectId, thread?, messages:[{role,content}] } → append
router.post("/ai/argos/history", async (req, res) => {
  const { projectId, messages } = req.body as {
    projectId?: string;
    messages?: Array<{ role: string; content: string }>;
  };
  const thread = threadOf((req.body as any)?.thread);
  const userId = await requireProjectMember(req, res, String(projectId || ""));
  if (!userId) return;
  if (!Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: "messages richiesto" });
    return;
  }
  // Insert in ordine: l'id IDENTITY preserva la sequenza dei turni.
  for (const m of messages) {
    const role = m?.role === "assistant" ? "assistant" : "user";
    const content = (m?.content || "").slice(0, 100_000);
    if (!content) continue;
    await db.execute(sql`
      INSERT INTO ps_argos_messages (project_id, user_id, role, content, thread)
      VALUES (${projectId}::uuid, ${userId}::uuid, ${role}, ${content}, ${thread})
    `);
  }
  res.json({ ok: true });
});

// DELETE /api/ai/argos/history?projectId=...&thread=... → svuota QUEL thread
router.delete("/ai/argos/history", async (req, res) => {
  const projectId = String(req.query.projectId || "");
  const thread = threadOf(req.query.thread);
  const userId = await requireProjectMember(req, res, projectId);
  if (!userId) return;
  await db.execute(sql`
    DELETE FROM ps_argos_messages
     WHERE project_id = ${projectId}::uuid AND user_id = ${userId}::uuid
       AND thread = ${thread}
  `);
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────
// L2 "agente su obiettivo" — Argos pianifica verso un obiettivo e PROPONE.
// Il browser passa sempre da qui: verifichiamo l'accesso al progetto, coniamo
// il token utente e inoltriamo ad Argos /agent/*. Restano sola-proposta:
// nessuna scrittura sui dati del progetto (le proposte vivono lato Argos).
// ─────────────────────────────────────────────────────────────

/** GET autenticato verso un endpoint Argos, inoltrando la risposta JSON. */
async function argosGet(path: string, res: any): Promise<void> {
  if (!ARGOS_URL) {
    res.status(503).json({ error: "Argos non configurato (ARGOS_URL mancante)" });
    return;
  }
  try {
    const upstream = await fetch(`${ARGOS_URL}${path}`, { signal: AbortSignal.timeout(15000) });
    const data = await upstream.json().catch(() => ({}));
    res.status(upstream.ok ? 200 : upstream.status).json(data);
  } catch (err: any) {
    res.status(502).json({ error: err?.message || "Argos irraggiungibile" });
  }
}

// POST /api/ai/argos/agent/goal { projectId, objective } → avvia un run
router.post("/ai/argos/agent/goal", async (req, res) => {
  const { projectId, objective } = req.body as { projectId?: string; objective?: string };
  const obj = (objective || "").trim();
  if (!obj) {
    res.status(400).json({ error: "objective richiesto" });
    return;
  }
  if (!ARGOS_URL) {
    res.status(503).json({ error: "Argos non configurato (ARGOS_URL mancante)" });
    return;
  }
  const userId = await requireProjectMember(req, res, String(projectId || ""));
  if (!userId) return;
  const tiAuthToken = mintShortLivedUserToken(userId);
  try {
    // La pianificazione è multi-step (più letture + Opus): timeout generoso.
    const upstream = await fetch(`${ARGOS_URL}/agent/goal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_slug: ARGOS_CLIENT_SLUG,
        project_id: projectId,
        objective: obj,
        ti_auth_token: tiAuthToken,
      }),
      signal: AbortSignal.timeout(180000),
    });
    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      res.status(upstream.status).json({ error: (data as any)?.detail || `HTTP ${upstream.status}` });
      return;
    }
    res.json(data);
  } catch (err: any) {
    logger.error({ err: err?.message }, "Argos agent goal proxy error");
    res.status(502).json({ error: err?.message || "Errore proxy Argos" });
  }
});

// POST /api/ai/argos/agent/chat
// Body: { messages: [{role, content}], projectId }
// L'agente in CONVERSAZIONE: inoltra ad Argos /agent/chat/stream e ristrasmette
// lo stream SSE. Eventi: {t} testo · {reset} · {tool:{name,args}} strumento in
// lettura · {plan:{...}} piano emesso · {error} · {done, tokens, budget}.
router.post("/ai/argos/agent/chat", async (req, res) => {
  const { messages, projectId, mode } = req.body as {
    messages: Array<{ role: "user" | "assistant"; content: string }>;
    projectId?: string;
    mode?: string;
  };
  if (!Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: "messages array richiesto" });
    return;
  }
  if (!ARGOS_URL) {
    res.status(503).json({ error: "Argos non configurato (ARGOS_URL mancante)" });
    return;
  }
  const userId = await requireProjectMember(req, res, String(projectId || ""));
  if (!userId) return;
  const tiAuthToken = mintShortLivedUserToken(userId);

  const last = messages[messages.length - 1];
  const question = (last?.content || "").trim();
  if (!question) {
    res.status(400).json({ error: "messaggio vuoto" });
    return;
  }
  const history = messages.slice(0, -1).map((m) => ({ role: m.role, content: m.content }));

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const sendError = (message: string) => {
    res.write(`data: ${JSON.stringify({ error: message })}\n\n`);
  };
  const ctrl = new AbortController();
  req.on("close", () => ctrl.abort());

  try {
    const upstream = await fetch(`${ARGOS_URL}/agent/chat/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_slug: ARGOS_CLIENT_SLUG,
        project_id: projectId,
        question,
        history,
        ti_auth_token: tiAuthToken,
        // Postura del turno: 'piano' = card garantite a fine turno; default 'agente'.
        mode: mode === "piano" ? "piano" : "agente",
      }),
      signal: ctrl.signal,
    });
    if (!upstream.ok || !upstream.body) {
      const detail = await upstream
        .json()
        .then((d: any) => d?.detail || `HTTP ${upstream.status}`)
        .catch(() => `HTTP ${upstream.status}`);
      sendError(String(detail));
      res.end();
      return;
    }
    for await (const chunk of upstream.body as any) {
      res.write(chunk);
    }
    res.end();
  } catch (err: any) {
    if (err?.name !== "AbortError") {
      logger.error({ err: err?.message }, "Argos agent chat proxy error");
      sendError(err?.message || "Errore proxy Argos");
    }
    res.end();
  }
});

// GET /api/ai/argos/agent/runs?projectId=... → storico run del progetto
router.get("/ai/argos/agent/runs", async (req, res) => {
  const projectId = String(req.query.projectId || "");
  const userId = await requireProjectMember(req, res, projectId);
  if (!userId) return;
  const limit = String(req.query.limit || "30");
  await argosGet(`/agent/runs?project_id=${encodeURIComponent(projectId)}&limit=${encodeURIComponent(limit)}`, res);
});

// GET /api/ai/argos/agent/runs/:id?projectId=... → un run con le proposte
router.get("/ai/argos/agent/runs/:id", async (req, res) => {
  const projectId = String(req.query.projectId || "");
  const userId = await requireProjectMember(req, res, projectId);
  if (!userId) return;
  const runId = String(req.params.id || "");
  if (!/^\d+$/.test(runId)) {
    res.status(400).json({ error: "id non valido" });
    return;
  }
  await argosGet(`/agent/runs/${runId}?project_id=${encodeURIComponent(projectId)}`, res);
});

// POST /api/ai/argos/agent/proposals/:id { projectId, status } → revisione umana
router.post("/ai/argos/agent/proposals/:id", async (req, res) => {
  const { projectId, status } = req.body as { projectId?: string; status?: string };
  const userId = await requireProjectMember(req, res, String(projectId || ""));
  if (!userId) return;
  const proposalId = String(req.params.id || "");
  if (!/^\d+$/.test(proposalId)) {
    res.status(400).json({ error: "id non valido" });
    return;
  }
  if (!ARGOS_URL) {
    res.status(503).json({ error: "Argos non configurato (ARGOS_URL mancante)" });
    return;
  }
  try {
    const upstream = await fetch(`${ARGOS_URL}/agent/proposals/${proposalId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status, project_id: projectId }),
      signal: AbortSignal.timeout(15000),
    });
    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      res.status(upstream.status).json({ error: (data as any)?.detail || `HTTP ${upstream.status}` });
      return;
    }
    res.json(data);
  } catch (err: any) {
    res.status(502).json({ error: err?.message || "Errore proxy Argos" });
  }
});

export default router;
