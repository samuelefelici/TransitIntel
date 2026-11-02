/**
 * I segreti delle rotte cron (header x-cron-secret), montate prima del login.
 *
 * Sono due, perché proteggono cose di peso diverso:
 * - CRON_SECRET: i job dei dati (traffico, POI, popolazione, meteo, controllo
 *   AVM, sorveglianza di Argos). Si dà a uno scheduler esterno;
 * - ARGOS_CRON_SECRET: le rotte che consegnano ad Argos un token utente o
 *   l'elenco dei progetti (/cron/argos-mcp-token, /cron/argos-mcp-projects).
 *   Un token così, se il proprietario del progetto è admin, apre tutto: il
 *   segreto lo ha solo il backend di Argos (la sua TRANSITINTEL_CRON_SECRET).
 *
 * Passaggio: finché ARGOS_CRON_SECRET non è impostata, quelle rotte accettano
 * ancora CRON_SECRET, con un avviso nel log; impostata, solo lei.
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

/* un avviso ogni ora al massimo: il connettore MCP chiama spesso */
const ultimoAvviso = new Map<string, number>();
function avvisa(chiave: string, messaggio: string): void {
  const adesso = Date.now();
  if ((ultimoAvviso.get(chiave) ?? 0) > adesso - 3_600_000) return;
  ultimoAvviso.set(chiave, adesso);
  logger.warn(messaggio);
}

/** Le rotte che danno token o progetti ad Argos: ARGOS_CRON_SECRET (o, nel passaggio, CRON_SECRET con un avviso). */
export function cronDiArgos(req: Request, res: Response): boolean {
  const dato = req.headers["x-cron-secret"];
  const proprio = process.env.ARGOS_CRON_SECRET;
  if (proprio) {
    if (proprio === process.env.CRON_SECRET) {
      avvisa("uguali", "ARGOS_CRON_SECRET è uguale a CRON_SECRET: chi ha il segreto dei job dei dati può avere i token di Argos. Generane uno diverso (DEPLOY.md, «Cron Jobs»)");
    }
    if (segretoUguale(dato, proprio)) return true;
    nonAutorizzato(res);
    return false;
  }
  if (segretoUguale(dato, process.env.CRON_SECRET)) {
    avvisa("ripiego", "ARGOS_CRON_SECRET non è impostata: i token di Argos si danno ancora con CRON_SECRET. "
      + "Impostala nell'API e, con lo stesso valore, TRANSITINTEL_CRON_SECRET in Argos (DEPLOY.md, «Cron Jobs»)");
    return true;
  }
  nonAutorizzato(res);
  return false;
}
