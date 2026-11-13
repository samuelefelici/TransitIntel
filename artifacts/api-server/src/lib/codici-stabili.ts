/**
 * Codici stabili di corsa, fermata e linea (PR 3.1, migrazioni 0017 e 0018).
 *
 * Ogni riga di ps_trips, ps_stops e ps_routes ha un `codice`: obbligatorio,
 * unico dentro il progetto, lo stesso nella copia di un programma. È il nome
 * che esce nel GTFS; l'id interno (un UUID) cambia a ogni copia e resta
 * interno.
 *
 * - Una riga importata prende l'id che ha nel file. Lo decide l'import, qui
 *   (CodiciDelProgetto): il database non può, perché il default di una colonna
 *   non vede le altre.
 * - Una riga creata a mano non porta il codice: lo dà il default della
 *   colonna, «CB-» più la lettera del tipo (C corsa, F fermata, L linea) e il
 *   prossimo numero di ps_codici_seq.
 * - gtfs_id resta com'è: dice da quale file viene la riga.
 */
import { sql } from "drizzle-orm";

/** Gli stessi limiti del vincolo della 0018. */
export const LUNGHEZZA_MASSIMA_DEL_CODICE = 200;

/** La forma dei codici che dà il database alle righe create a mano. */
const GENERATO = /^CB-[CFL]([0-9]{1,15})$/;

/**
 * L'id di un file come codice: senza caratteri di controllo, senza spazi ai
 * lati, al più 200 caratteri. Vuoto se non resta niente.
 */
export function codiceDalFile(id: unknown): string {
  // eslint-disable-next-line no-control-regex
  return String(id ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim().slice(0, LUNGHEZZA_MASSIMA_DEL_CODICE).trim();
}

/**
 * I codici di una tabella dentro un progetto, durante un import: dà a ogni id
 * del file un codice libero e se lo segna.
 */
export class CodiciDelProgetto {
  private readonly usati: Set<string>;
  /** il numero più alto fra i codici presi che hanno la forma di quelli generati */
  private massimo = 0;

  constructor(giaUsati: Iterable<string> = []) {
    this.usati = new Set(giaUsati);
  }

  /**
   * Il codice per l'id del file: lui stesso se è libero. Se è già di un'altra
   * riga (un file con lo stesso id due volte) diventa «id~2», «id~3»…: il
   * vincolo di unicità fermerebbe l'import intero.
   */
  prendi(idDelFile: unknown): string {
    const base = codiceDalFile(idDelFile) || "senza-id";
    let codice = base;
    for (let n = 2; this.usati.has(codice); n++) {
      const coda = `~${n}`;
      codice = base.slice(0, LUNGHEZZA_MASSIMA_DEL_CODICE - coda.length) + coda;
    }
    this.usati.add(codice);
    const m = GENERATO.exec(codice);
    if (m) this.massimo = Math.max(this.massimo, Number(m[1]));
    return codice;
  }

  /** Fra i codici presi, il numero più alto di quelli con la forma dei generati (0 se non ce ne sono). */
  get numeroPiuAlto(): number { return this.massimo; }
}

/**
 * Porta ps_codici_seq oltre `numero`. Serve quando un file porta codici con
 * la forma di quelli generati (un GTFS esportato da un'altra installazione di
 * Cerbero): senza, il database arriverebbe a dare a una riga nuova un codice
 * che il progetto ha già, e la creazione fallirebbe.
 */
export async function portaLaSequenzaOltre(tx: { execute: (q: any) => Promise<any> }, numero: number): Promise<void> {
  if (!Number.isSafeInteger(numero) || numero <= 0) return;
  await tx.execute(sql`
    SELECT pg_catalog.setval('public.ps_codici_seq'::regclass, ${numero}::bigint)
     WHERE COALESCE(pg_catalog.pg_sequence_last_value('public.ps_codici_seq'::regclass), 0) < ${numero}::bigint`);
}
