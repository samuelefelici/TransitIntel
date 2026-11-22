/**
 * Le risposte di errore interno non mostrano più i dettagli (tappa 7.13).
 *
 * Più di 150 punti dell'API rispondevano a un errore con `e.message` (o
 * `String(e)`): il testo del database (nomi di tabelle e vincoli, la query e i
 * suoi parametri), di un servizio esterno o di Python arrivava così a chi
 * aveva fatto la richiesta. Qui, per ogni risposta 5xx:
 *  - al client va un messaggio generico con il codice della richiesta (lo
 *    stesso dell'header `x-request-id` e dei log), più i soli campi sì/no e
 *    numerici della risposta di prima (`success: false`, `configured: true`);
 *  - il dettaglio resta nel log del server, senza i parametri della query;
 *  - 503 e 504 restano come sono: si scrivono apposta (servizio occupato,
 *    tempo scaduto), mai col testo di un errore;
 *  - un messaggio scritto apposta per l'utente («il programma di prima resta
 *    in esercizio») passa se si risponde con `erroreLeggibile`.
 *
 * Tocca solo res.json e res.send (come la compressione): si monta dopo
 * comprimiRisposte, così il corpo pulito è quello che si comprime.
 */
import type { Request, Response, NextFunction } from "express";

export const MESSAGGIO_ERRORE_INTERNO = "Errore interno del server";

/** I 5xx che si scrivono apposta e non portano mai il testo di un errore. */
const STATI_SCRITTI_APPOSTA = new Set([503, 504]);

/** Lunghezza massima del dettaglio scritto nel log. */
const MASSIMO_NEL_LOG = 2000;

/**
 * Una risposta d'errore con un testo scritto per l'utente, che resta visibile
 * anche con uno stato 5xx. Il testo dev'essere fisso: mai `e.message`.
 */
export function erroreLeggibile(res: Response, stato: number, testo: string, extra: Record<string, unknown> = {}): void {
  res.locals.erroreLeggibile = true;
  res.status(stato).json({ ...extra, error: testo });
}

export function daNascondere(stato: number, res: Response): boolean {
  return stato >= 500 && stato <= 599 && !STATI_SCRITTI_APPOSTA.has(stato) && res.locals?.erroreLeggibile !== true;
}

/** Il corpo che va al client: messaggio generico, codice, e i soli campi sì/no e numerici. */
export function corpoPulito(originale: unknown, richiesta: string | undefined): Record<string, unknown> {
  const pulito: Record<string, unknown> = {};
  if (originale && typeof originale === "object" && !Array.isArray(originale) && !Buffer.isBuffer(originale)) {
    for (const [k, v] of Object.entries(originale as Record<string, unknown>)) {
      if (typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))) pulito[k] = v;
    }
  }
  pulito.error = richiesta ? `${MESSAGGIO_ERRORE_INTERNO}. Se si ripete, comunica il codice ${richiesta}` : MESSAGGIO_ERRORE_INTERNO;
  if (richiesta) pulito.richiesta = richiesta;
  return pulito;
}

/**
 * Il dettaglio per il log: troncato, senza i parametri delle query (drizzle li
 * mette nel messaggio dopo «params:», e possono essere dati di persone).
 */
export function dettaglioPerIlLog(corpo: unknown): string {
  let testo: string;
  if (typeof corpo === "string") testo = corpo;
  else if (Buffer.isBuffer(corpo)) testo = corpo.toString("utf8");
  else {
    try { testo = JSON.stringify(corpo) ?? ""; } catch { testo = String(corpo); }
  }
  testo = testo.replace(/(params:)[\s\S]*?(?=",|"}|$)/g, "$1 [nascosti]");
  return testo.length > MASSIMO_NEL_LOG ? `${testo.slice(0, MASSIMO_NEL_LOG)}…` : testo;
}

function registra(req: Request, stato: number, corpo: unknown): void {
  const log = (req as any).log;
  const voce = { stato, dettaglio: dettaglioPerIlLog(corpo) };
  if (log?.error) log.error(voce, "risposta di errore interno: il dettaglio resta nel log");
  else console.error("risposta di errore interno:", voce);
}

export function nascondiErroriInterni(req: Request, res: Response, next: NextFunction): void {
  const json = res.json.bind(res);
  const send = res.send.bind(res);
  /* res.json chiama res.send con il testo JSON: una sola decisione per risposta */
  let deciso = false;
  res.json = ((corpo?: unknown) => {
    if (!deciso && daNascondere(res.statusCode, res)) {
      deciso = true;
      registra(req, res.statusCode, corpo);
      return json(corpoPulito(corpo, (req as any).id));
    }
    deciso = true;
    return json(corpo);
  }) as Response["json"];
  res.send = ((corpo?: unknown) => {
    if (!deciso && daNascondere(res.statusCode, res) && (typeof corpo === "string" || Buffer.isBuffer(corpo))) {
      deciso = true;
      registra(req, res.statusCode, corpo);
      res.type("application/json");
      return json(corpoPulito(undefined, (req as any).id));
    }
    return send(corpo as any);
  }) as Response["send"];
  next();
}
