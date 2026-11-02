/**
 * I segreti delle rotte cron (header x-cron-secret), montate prima del login.
 *
 * Sono due, perché proteggono cose di peso diverso:
 * - CRON_SECRET: i job dei dati (traffico, POI, popolazione, meteo, controllo
 *   AVM, sorveglianza di Argos). Si dà a uno scheduler esterno;
 * - ARGOS_CRON_SECRET: le rotte che consegnano ad Argos un token utente (che
 *   può fare tutto quello che può l'utente, scritture comprese, e se è admin
 *   tutto) o l'elenco dei progetti: /cron/argos-mcp-token e
 *   /cron/argos-mcp-projects. Il segreto lo ha solo il backend di Argos, nella
 *   sua TRANSITINTEL_CRON_SECRET.
 *
 * Chiuso per default: senza ARGOS_CRON_SECRET quelle due rotte non danno
 * niente. Per cambiare segreto senza fermare Argos c'è un passaggio esplicito
 * e temporaneo, ARGOS_CRON_PASSAGGIO=1: accetta anche CRON_SECRET (il valore
 * che Argos ha oggi), con un avviso; si toglie appena Argos ha il valore nuovo.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import { logger } from "./logger";

/** Confronto a tempo costante (sugli hash: anche lunghezze diverse costano uguale). */
export function segretoUguale(dato: unknown, atteso: string | undefined): boolean {
  if (!atteso || typeof dato !== "string" || dato.length === 0) return false;
  const h = (s: string) => createHash("sha256").update(s, "utf8").digest();
  return timingSafeEqual(h(dato), h(atteso));
}

const nonAutorizzato = (res: Response) => { res.status(401).json({ error: "Unauthorized" }); };

/** Le cron dei dati: CRON_SECRET. Risponde 401 da sé se manca o è sbagliato. */
export function cronDeiDati(req: Request, res: Response): boolean {
  if (segretoUguale(req.headers["x-cron-secret"], process.env.CRON_SECRET)) return true;
  nonAutorizzato(res);
  return false;
}

/* un avviso per tipo ogni ora al massimo: il connettore MCP chiama spesso */
const ultimoAvviso = new Map<string, number>();
function avvisa(chiave: string, messaggio: string): void {
  const adesso = Date.now();
  if ((ultimoAvviso.get(chiave) ?? -Infinity) > adesso - 3_600_000) return;
  ultimoAvviso.set(chiave, adesso);
  logger.warn(messaggio);
}
/** Solo per i test: ricomincia a contare gli avvisi. */
export function azzeraAvvisiCron(): void { ultimoAvviso.clear(); }

const AVVISI = {
  uguali: "ARGOS_CRON_SECRET è uguale a CRON_SECRET: chi ha il segreto dei job dei dati può avere i token di Argos. Generane uno diverso (DEPLOY.md, «Cron Jobs»)",
  passaggio: "ARGOS_CRON_PASSAGGIO è attivo: i token di Argos si danno anche con CRON_SECRET. Toglilo appena Argos ha in TRANSITINTEL_CRON_SECRET il valore di ARGOS_CRON_SECRET (DEPLOY.md, «Cron Jobs»)",
  manca: "ARGOS_URL è impostata ma ARGOS_CRON_SECRET no: il connettore MCP di Argos e il rinnovo dei suoi token sono chiusi (DEPLOY.md, «Cron Jobs»)",
  sbagliato: "una rotta cron di Argos ha ricevuto un segreto sbagliato: TRANSITINTEL_CRON_SECRET di Argos è uguale ad ARGOS_CRON_SECRET dell'API?",
};

/** All'avvio dell'API: quello che non torna nella configurazione dei segreti di Argos. */
export function controllaSegretiCron(): void {
  const proprio = process.env.ARGOS_CRON_SECRET;
  if (proprio && proprio === process.env.CRON_SECRET) avvisa("uguali", AVVISI.uguali);
  if (process.env.ARGOS_CRON_PASSAGGIO === "1") avvisa("passaggio", AVVISI.passaggio);
  else if (!proprio && process.env.ARGOS_URL) avvisa("manca", AVVISI.manca);
}

/** Le rotte che danno token o progetti ad Argos: ARGOS_CRON_SECRET (e, solo nel passaggio, anche CRON_SECRET). */
export function cronDiArgos(req: Request, res: Response): boolean {
  const dato = req.headers["x-cron-secret"];
  const proprio = process.env.ARGOS_CRON_SECRET;
  const passaggio = process.env.ARGOS_CRON_PASSAGGIO === "1";
  if (proprio && proprio === process.env.CRON_SECRET) avvisa("uguali", AVVISI.uguali);
  if (segretoUguale(dato, proprio)) return true;
  if (passaggio && segretoUguale(dato, process.env.CRON_SECRET)) {
    avvisa("passaggio", AVVISI.passaggio);
    return true;
  }
  if (!proprio && !passaggio) {
    res.status(503).json({ error: "Rotta di Argos non configurata su questa API (manca ARGOS_CRON_SECRET)" });
    return false;
  }
  if (typeof dato === "string" && dato.length > 0) avvisa("sbagliato", AVVISI.sbagliato);
  nonAutorizzato(res);
  return false;
}
