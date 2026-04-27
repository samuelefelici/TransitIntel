import Anthropic from "@anthropic-ai/sdk";

/**
 * Anthropic client singleton.
 * Richiede ANTHROPIC_API_KEY in env.
 */
let _client: Anthropic | null = null;

export function getAnthropic(): Anthropic {
  if (_client) return _client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY mancante. Aggiungila a .env (root del repo) o nelle env vars di Render."
    );
  }
  _client = new Anthropic({ apiKey });
  return _client;
}

/**
 * Modello di default per il copilot.
 * Haiku 4.5 = qualità alta, prezzo basso, ottimo tool-calling.
 * Override via env COPILOT_MODEL.
 */
export const COPILOT_MODEL =
  process.env.COPILOT_MODEL || "claude-haiku-4-5-20251001";

export const COPILOT_MAX_TOKENS = 4096;
