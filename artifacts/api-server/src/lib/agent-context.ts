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
import { contestoDb } from "@workspace/db/contesto";

const store = new AsyncLocalStorage<{ via: string }>();

/** Valori ammessi per il canale: tutto il resto collassa su "argos". */
const KNOWN = new Set(["agent", "mcp", "watch", "goal"]);

export function agentAttribution(req: Request, _res: Response, next: NextFunction): void {
  const raw = String(req.headers["x-argos"] || "").trim().toLowerCase();
  if (!raw) { next(); return; }
  const channel = KNOWN.has(raw) ? raw : "agent";
  store.run({ via: channel === "agent" ? "argos" : `argos:${channel}` }, next);
}

/** Il canale dichiarato dall'header X-Argos (solo per precisare quello del token). */
function viaDichiarata(): string | null {
  return store.getStore()?.via ?? null;
}

/**
 * "argos" / "argos:mcp" / "argos:coda:…" se la modifica corrente viene
 * dall'agente, altrimenti null. Dalla PR 2.10 si legge dal contesto della
 * connessione (lib/db/src/contesto.ts), che si fida solo del token: una
 * persona che manda l'header non risulta Argos, un token di Argos senza
 * header sì. Così il registro attività dice quello che dice il registro
 * delle modifiche.
 */
export function requestVia(): string | null {
  const via = contestoDb.getStore()?.via;
  return via && /^argos(:|$)/.test(via) ? via : null;
}

/**
 * Il canale da scrivere sulla connessione al database (cerbero.via, PR 2.9):
 * conta solo il claim `via` del token (autorevole); l'header X-Argos può solo
 * precisarne il canale (argos → argos:mcp), mai crearlo. Una persona che manda
 * l'header resta «api».
 */
export function viaPerIlDatabase(authVia: string | undefined | null): string {
  if (!authVia) return "api";
  const dichiarata = viaDichiarata();
  return dichiarata && (dichiarata === authVia || dichiarata.startsWith(`${authVia}:`)) ? dichiarata : authVia;
}

/**
 * La via con cui il giro delle attivazioni programmate esegue un'attivazione
 * (PR 2.11): quella di chi l'ha programmata, se era Argos, come fa la coda dei
 * lavori (`argos:mcp:coda:<tipo>`). Altrimenti il solo nome del giro.
 */
export function viaDelGiro(viaSalvata: unknown): string {
  return typeof viaSalvata === "string" && /^argos(:|$)/.test(viaSalvata) ? `${viaSalvata}:timer:attivazioni` : "timer:attivazioni";
}

/** Payload del log attività con l'eventuale marcatura `via` della richiesta corrente. */
export function withVia(payload: Record<string, any> | null | undefined): Record<string, any> {
  const via = requestVia();
  const base = payload ?? {};
  return via ? { ...base, via } : base;
}
