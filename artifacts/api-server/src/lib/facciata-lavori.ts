/**
 * La facciata sincrona dei lavori in coda (solo API): chi chiama una rotta
 * sincrona (la Fucina, la fattibilità di Argos) riceve la risposta di sempre,
 * mentre il calcolo gira nel lavoratore.
 *
 * - Si legge la riga ogni secondo; a lavoro finito si risponde con lo stesso
 *   codice e lo stesso corpo che il calcolo ha prodotto (anche un 400, 422 o
 *   500: il lavoro «fallito» li porta con sé).
 * - Se chi aspetta si scollega, il calcolo si ferma (chiediAnnullamento): nessuno
 *   leggerebbe più il risultato.
 * - All'arresto dell'API (deploy): 15 s di grazia (meno, se CERBERO_ARRESTO_SECONDI
 *   è più corto), poi il calcolo si ferma e si risponde 503 «rilancia» (Coolify
 *   concede 30 s; la connessione cadrebbe comunque).
 * - Ogni 5 s la facciata scrive nella riga che qualcuno aspetta ancora: se l'API
 *   cade senza fermare il calcolo, il lavoratore lo ferma dopo un minuto
 *   (coda.fermaAbbandonati).
 */
import * as codaReale from "./lavori/coda";
import type { StatoLavoro } from "./lavori/coda";
import { arresto } from "./arresto";

export type RigaLavoro = NonNullable<Awaited<ReturnType<typeof codaReale.leggi>>>;

export const STATO_PUBBLICO: Record<StatoLavoro, string> = {
  in_coda: "queued", in_corso: "running", completato: "completed", fallito: "failed", fermato: "stopped",
};
export const FINITI: ReadonlySet<StatoLavoro> = new Set(["completato", "fallito", "fermato"]);

export const MESSAGGIO_RIAVVIO = "Il server si sta riavviando: rilancia il calcolo tra poco";

/** Codice e corpo HTTP di un lavoro finito: quelli del calcolo, se li ha. */
export function rispostaDi(l: Pick<RigaLavoro, "stato" | "http_codice" | "risultato" | "errore" | "errore_tipo">): { codice: number; corpo: any } {
  if (l.stato === "completato") return { codice: l.http_codice ?? 200, corpo: l.risultato };
  if (l.stato === "fermato") return { codice: 409, corpo: { error: "Calcolo fermato prima della fine" } };
  if (l.risultato != null && l.http_codice) return { codice: l.http_codice, corpo: l.risultato };
  if (l.errore_tipo === "interrotto") return { codice: 503, corpo: { error: l.errore ?? "Calcolo interrotto: rilancialo" } };
  return { codice: 500, corpo: { error: l.errore ?? "Errore nel calcolo" } };
}

/** La grazia all'arresto: 15 s, ma almeno 3 s prima che l'API esca (CERBERO_ARRESTO_SECONDI, come index.ts). */
export function graziaArresto(env: NodeJS.ProcessEnv = process.env): number {
  const uscitaMs = Math.min(Math.max(Number(env.CERBERO_ARRESTO_SECONDI) || 25, 1), 28) * 1000;
  return Math.max(0, Math.min(15_000, uscitaMs - 3_000));
}

/** Ogni quanto la facciata dice al lavoratore che qualcuno aspetta ancora. */
const SEGNO_DI_VITA_MS = 5_000;

export interface OpzioniAttesa {
  coda?: Pick<typeof codaReale, "leggi" | "chiediAnnullamento"> & Partial<Pick<typeof codaReale, "segnaAttesa">>;
  /** l'arresto del processo (di default quello vero) */
  segnaleArresto?: AbortSignal;
  intervalloMs?: number;
  graziaArrestoMs?: number;
  log?: { warn: (...a: any[]) => void };
}

type Res = {
  status: (c: number) => Res; json: (b: unknown) => unknown;
  on: (e: "close", f: () => void) => unknown; off: (e: "close", f: () => void) => unknown;
  destroyed?: boolean; writableEnded?: boolean; headersSent?: boolean;
};

/** Aspetta la fine del lavoro e risponde; si ferma se il client se ne va. */
export async function attendiEsito(res: Res, jobId: string, o: OpzioniAttesa = {}): Promise<void> {
  const coda = o.coda ?? codaReale;
  const segnale = o.segnaleArresto ?? arresto.signal;
  const intervallo = o.intervalloMs ?? 1_000;
  const grazia = o.graziaArrestoMs ?? graziaArresto();
  let risposto = false;
  let andato = false;
  const fermaOra = () => coda.chiediAnnullamento(jobId).catch((err) => { o.log?.warn({ err, lavoro: jobId }, "stop del lavoro non riuscito"); return null; });
  const ferma = () => { void fermaOra(); };
  let ultimoSegno = Date.now();
  /* 'close' arriva anche dopo una risposta completa: conta solo prima */
  const suChiusura = () => { if (!risposto && !andato) { andato = true; ferma(); } };
  const rispondi = (codice: number, corpo: unknown) => {
    risposto = true;
    res.off("close", suChiusura);
    res.status(codice).json(corpo);
  };
  res.on("close", suChiusura);
  /* la connessione può essersi chiusa durante gli await di prima (accoda): 'close' non arriverebbe più.
     Si guarda la risposta, non la richiesta: req.destroyed è vero appena il corpo JSON è stato letto. */
  if (res.destroyed) { suChiusura(); return; }

  let arrestoDal: number | null = null;
  while (!andato) {
    try {
      const l = await coda.leggi(jobId);
      if (andato) return;
      if (!l) { rispondi(500, { error: "Lavoro sparito dalla coda" }); return; }
      if (FINITI.has(l.stato)) { const r = rispostaDi(l); rispondi(r.codice, r.corpo); return; }
    } catch (err) {
      o.log?.warn({ err, lavoro: jobId }, "attesa del lavoro: lettura non riuscita, riprovo");
    }
    if (segnale.aborted) {
      arrestoDal ??= Date.now();
      if (Date.now() - arrestoDal >= grazia) {
        // lo stop prima della risposta: subito dopo il processo esce
        await Promise.race([fermaOra(), new Promise(r => setTimeout(r, 3_000))]);
        rispondi(503, { error: MESSAGGIO_RIAVVIO });
        return;
      }
    }
    if (coda.segnaAttesa && Date.now() - ultimoSegno >= SEGNO_DI_VITA_MS) {
      ultimoSegno = Date.now();
      await coda.segnaAttesa(jobId).catch((err) => o.log?.warn({ err, lavoro: jobId }, "segno di vita dell'attesa non scritto"));
    }
    await new Promise(r => setTimeout(r, intervallo));
    if (res.destroyed || res.writableEnded) { suChiusura(); return; }
  }
}
