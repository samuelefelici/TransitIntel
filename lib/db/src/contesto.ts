/**
 * Chi fa la modifica, su ogni connessione (PR 2.9).
 *
 * Il registro delle modifiche (2.10) attribuisce ogni modifica con un trigger
 * nel database, che vede soltanto la connessione. Qui la connessione lo
 * impara: ogni volta che il pool presta un client, gli imposta (a livello di
 * sessione) quattro valori presi dal contesto async di chi lo chiede:
 *
 *   cerbero.attore     l'id dell'utente (vuoto per i processi di sistema)
 *   cerbero.via        il canale: api, argos[:canale], cron:<nome>, caronte,
 *                      timer:<nome>, coda[:<tipo>], pulizie
 *   cerbero.richiesta  l'id della richiesta HTTP (x-request-id) o del lavoro
 *   cerbero.registro   il modo del registro (dalla 2.10: «riepilogo» per le
 *                      operazioni in blocco)
 *
 * Solo quando cambiano: ogni client ricorda l'ultima firma che ha ricevuto, e
 * un client nuovo senza contesto non fa niente. Una transazione per richiesta
 * non si può usare (il pool ha 10 connessioni e il codice fa letture annidate),
 * quindi il punto giusto è il prestito: anche `pool.query` e le query di
 * drizzle passano da `connect` (pg-pool 3.13, `query()` → `this.connect(cb)`).
 *
 * Il contesto si legge al momento della chiamata a `connect`, non nella
 * callback: quando il pool è pieno, la callback di un prestito in coda la
 * chiama il pool nel contesto async di chi ha appena rilasciato un client.
 *
 * I valori sono parametri della query (mai concatenati). Se l'impostazione
 * fallisce, il client si scarta (`release(err)`) e l'errore arriva a chi lo
 * aveva chiesto: meglio una richiesta fallita che una modifica attribuita a
 * qualcun altro.
 *
 * Non è una difesa contro un'app compromessa (che può impostarli da sé): lo è
 * `session_user`, che il registro salva a parte. Serve ad attribuire bene i
 * percorsi onesti.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import pg from "pg";

export interface ContestoDb {
  /** id dell'utente che ha chiesto (vuoto: un processo di sistema) */
  attore?: string;
  /** il canale da cui arriva la modifica */
  via?: string;
  /** l'id della richiesta HTTP o del lavoro della coda */
  richiesta?: string;
  /** il modo del registro (2.10) */
  registro?: string;
}

/** Il contesto async di chi sta usando il database. */
export const contestoDb = new AsyncLocalStorage<ContestoDb>();

const CAMPI = ["attore", "via", "richiesta", "registro"] as const;
/** Le impostazioni di sessione, nell'ordine dei parametri di SQL_IMPOSTA. */
export const IMPOSTAZIONI = Object.freeze(CAMPI.map((c) => `cerbero.${c}`));
/** Un valore più lungo si tronca: sono id e nomi brevi, non testo libero. */
export const LUNGHEZZA_MAX = 200;

export const SQL_IMPOSTA = `SELECT ${IMPOSTAZIONI.map((n, i) => `pg_catalog.set_config('${n}', $${i + 1}, false)`).join(", ")}`;

/** I quattro valori del contesto (stringhe, vuote se mancano). */
export function valoriDi(c: ContestoDb | undefined): string[] {
  return CAMPI.map((k) => {
    const v = c?.[k];
    // il byte nullo Postgres non lo accetta in un testo: non deve far fallire la richiesta
    return typeof v === "string" ? v.replace(/\0/g, "").slice(0, LUNGHEZZA_MAX) : "";
  });
}

const firmaDi = (valori: string[]) => JSON.stringify(valori);
const VUOTA = firmaDi(valoriDi(undefined));
/** L'ultima firma impostata su ogni client: un client nuovo non ha niente (cioè la firma vuota). */
const firme = new WeakMap<object, string>();

async function imposta(client: pg.PoolClient, valori: string[]): Promise<void> {
  const firma = firmaDi(valori);
  if ((firme.get(client) ?? VUOTA) === firma) return;
  // se la query fallisce il client si scarta: niente firma a metà da ricordare
  firme.delete(client);
  await client.query(SQL_IMPOSTA, valori);
  firme.set(client, firma);
}

type Fatto = (release?: unknown) => void;
type Richiamo = (err: Error | undefined, client: pg.PoolClient | undefined, done: Fatto) => void;

/**
 * Il pool di pg che, a ogni prestito, porta sul client il contesto di chi lo
 * chiede (forma promise, usata da `db.transaction` di drizzle, e forma
 * callback, usata da `pool.query`).
 */
export class PoolConContesto extends pg.Pool {
  connect(): Promise<pg.PoolClient>;
  connect(callback: Richiamo): void;
  connect(callback?: Richiamo): Promise<pg.PoolClient> | void {
    // subito, nel contesto di chi chiede (vedi sopra: la coda del pool)
    const valori = valoriDi(contestoDb.getStore());
    if (typeof callback === "function") {
      super.connect((err, client, done) => {
        if (err || !client) {
          callback(err, client, done);
          return;
        }
        imposta(client, valori).then(
          () => callback(undefined, client, done),
          (e: Error) => {
            done(e);
            callback(e, undefined, () => {});
          },
        );
      });
      return;
    }
    return super.connect().then(async (client) => {
      try {
        await imposta(client, valori);
      } catch (e) {
        client.release(e as Error);
        throw e;
      }
      return client;
    });
  }
}

/** Esegue `fn` col contesto corrente arricchito (o sostituito, campo per campo) da `parziale`. */
export function conContesto<T>(parziale: ContestoDb, fn: () => T): T {
  return contestoDb.run({ ...contestoDb.getStore(), ...parziale }, fn);
}

/** Esegue `fn` in un contesto di sistema nuovo, senza ereditare quello di chi lo avvia. */
export function inSistema<T>(via: string, fn: () => T): T {
  return contestoDb.run({ via }, fn);
}
