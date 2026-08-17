/**
 * Attribuzione delle richieste dell'agente (Argos).
 *
 * Problema: Argos scrive su Planning Studio col token dell'UTENTE, quindi nel
 * registro attività (ps_project_activity_log / project_activity_log) le sue
 * modifiche risultavano indistinguibili da quelle fatte a mano dall'operatore
 * — che infatti "non capisce cosa è successo al sistema".
 *
 * Soluzione: Argos manda l'header `X-Argos` su ogni chiamata; questo modulo lo
 * cattura in un AsyncLocalStorage per l'intera durata della richiesta (regge
 * gli await: l'insert del log avviene molti tick dopo il middleware), e i vari
 * helper logActivity — duplicati in più moduli — vi attingono senza dover far
 * passare `req` per ogni call-site.
 *
 * L'header è dichiarativo, non un'autorizzazione: l'auth resta il token utente.
 * Un client che lo spedisse a mano otterrebbe solo di auto-etichettarsi.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { NextFunction, Request, Response } from "express";

const store = new AsyncLocalStorage<{ via: string }>();

/** Valori ammessi per il canale: tutto il resto collassa su "argos". */
const KNOWN = new Set(["agent", "mcp", "watch", "goal"]);

export function agentAttribution(req: Request, _res: Response, next: NextFunction): void {
  const raw = String(req.headers["x-argos"] || "").trim().toLowerCase();
  if (!raw) { next(); return; }
  const channel = KNOWN.has(raw) ? raw : "agent";
  store.run({ via: channel === "agent" ? "argos" : `argos:${channel}` }, next);
}

/** "argos" / "argos:mcp" / … se la richiesta corrente viene dall'agente, altrimenti null. */
export function requestVia(): string | null {
  return store.getStore()?.via ?? null;
}

/** Payload del log attività con l'eventuale marcatura `via` della richiesta corrente. */
export function withVia(payload: Record<string, any> | null | undefined): Record<string, any> {
  const via = requestVia();
  const base = payload ?? {};
  return via ? { ...base, via } : base;
}
