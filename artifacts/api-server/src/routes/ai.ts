/**
 * AI Copilot endpoints
 * - POST /api/ai/chat → streaming SSE chat con tool-calling loop
 * - GET  /api/ai/health → verifica configurazione (presenza API key)
 */
import { Router, type IRouter } from "express";
import { getAnthropic, COPILOT_MODEL, COPILOT_MAX_TOKENS } from "../lib/ai/provider";
import { SYSTEM_PROMPT } from "../lib/ai/system-prompt";
import { TOOL_DEFS, executeTool, UI_TOOL_NAMES } from "../lib/ai/tools";
import { logger } from "../lib/logger";

const router: IRouter = Router();

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

export default router;
