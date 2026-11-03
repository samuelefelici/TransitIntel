/**
 * Quale calcolo è aperto in una pagina, ricordato nel browser: dopo un
 * ricaricamento (o riaprendo la pagina) la Fucina e l'area turni guida lo
 * ritrovano e lo seguono. Si ricorda solo l'id del calcolo: il resto (stato,
 * risultato, richiesta) lo tiene il server, per 7 giorni.
 *
 * Il localStorage può mancare o lanciare (navigazione privata, dati del sito
 * bloccati): ogni lettura e scrittura è protetta, e senza memoria la pagina
 * funziona come prima, solo senza ripresa.
 */

/** Oltre questa età il server non ha più il risultato (pulizia della coda): la memoria non serve più. */
export const VALIDITA_MS = 7 * 24 * 60 * 60 * 1000;
const PREFISSO = "cerbero:calcolo:";

export interface CalcoloRicordato {
  jobId: string;
  /** quando è partito (ms) */
  avviatoIl: number;
}

/** Il pezzo di Storage che serve (il localStorage del browser, o uno finto nei test). */
export type Deposito = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function depositoPredefinito(): Deposito | null {
  try { return typeof localStorage !== "undefined" ? localStorage : null; } catch { return null; }
}

/** Chiave della Fucina: un calcolo dei turni macchina aperto per progetto di scheduling. */
export const chiaveFucina = (projectId: string) => `fucina:${projectId}`;
/** Chiave dei turni guida: un calcolo aperto per scenario dei turni macchina. */
export const chiaveTurniGuida = (scenarioId: string) => `turni-guida:${scenarioId}`;

export function ricorda(chiave: string, c: CalcoloRicordato, d: Deposito | null = depositoPredefinito()): void {
  try { d?.setItem(PREFISSO + chiave, JSON.stringify(c)); } catch { /* senza memoria: niente ripresa */ }
}

export function dimentica(chiave: string, d: Deposito | null = depositoPredefinito()): void {
  try { d?.removeItem(PREFISSO + chiave); } catch { /* niente da fare */ }
}

/** Il calcolo ricordato per la chiave, se c'è ed è ancora nei 7 giorni; uno scaduto o rovinato si dimentica. */
export function richiama(chiave: string, adesso = Date.now(), d: Deposito | null = depositoPredefinito()): CalcoloRicordato | null {
  let testo: string | null = null;
  try { testo = d?.getItem(PREFISSO + chiave) ?? null; } catch { return null; }
  if (!testo) return null;
  try {
    const c = JSON.parse(testo);
    if (c && typeof c.jobId === "string" && /^[0-9a-f-]{36}$/i.test(c.jobId)
        && typeof c.avviatoIl === "number" && adesso - c.avviatoIl < VALIDITA_MS) {
      return { jobId: c.jobId, avviatoIl: c.avviatoIl };
    }
  } catch { /* rovinato: si dimentica */ }
  dimentica(chiave, d);
  return null;
}
