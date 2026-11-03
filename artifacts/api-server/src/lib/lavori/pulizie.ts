/**
 * Pulizie periodiche, solo nel lavoratore (ogni 6 ore, una sola istanza alla
 * volta grazie a un lucchetto consultivo di sessione). SQL diretto, niente
 * import dalle rotte, niente DDL.
 *
 * 1. Calcoli delle tariffe rimasti «running»: la matrice O/D minima e
 *    l'assegnazione dei nodi girano dentro una richiesta dell'API; se l'API
 *    muore a metà la riga resta «running» per sempre e la pagina mostra uno
 *    spinner infinito. Dopo 24 ore diventano «error», da rilanciare.
 * 2. Feed sintetici orfani: ogni sincronizzazione di un progetto crea un feed
 *    `ps-xxxxxxxx.synthetic` nuovo e cancella il vecchio solo se nessuno lo
 *    usa; quelli rimasti (una sincronizzazione morta a metà prima della 2.7a,
 *    un feed vecchio che uno scenario teneva) si accumulano. Si cancellano
 *    quelli più vecchi di 2 giorni che nessuno usa (lib/materializzazione/
 *    usi-feed.ts, la stessa definizione della sincronizzazione): non attivi,
 *    non di default, non archiviati (un feed in esercizio sostituito si
 *    archivia e resta), non puntati da progetti o attivazioni, senza lavoro
 *    dell'utente sopra (tariffe, POI, classificazioni delle linee), non letti
 *    da un calcolo vivo in coda; e solo se c'è un feed in esercizio. Al più 5
 *    a giro, uno per riga nel log.
 *
 * I giri di Argos (agent_optimize_jobs) rimasti «running» non si toccano: il
 * loro stato vero lo calcola già vistaGiro dalla coda, e per un giro
 * interrotto restituisce la richiesta per rilanciarlo.
 */
import { pool } from "@workspace/db";
import { SINTETICO_FUORI_ESERCIZIO, nonInUso } from "../materializzazione/usi-feed";

export { USI_DEL_FEED, RIGHE_DEL_FEED } from "../materializzazione/usi-feed";

export const OGNI_MS = 6 * 60 * 60 * 1000;
const PRIMO_GIRO_MS = 2 * 60 * 1000;
export const ORE_RUN_APPESO = 24;
export const GIORNI_FEED_ORFANO = 2;
export const FEED_PER_GIRO = 5;
const MESSAGGIO_RUN = "Calcolo interrotto (riavvio del server): rilancialo";

type Log = { info: (...a: any[]) => void; warn: (...a: any[]) => void; error: (...a: any[]) => void };
type Client = { query: (text: string, values?: unknown[]) => Promise<{ rows: any[] }> };

/** Filtro per i test: solo i propri dati (un prefisso del nome del feed, i propri feed). */
export interface Ambito { filename?: string; feedIds?: string[] }

/**
 * «Orfano» su gtfs_feeds f, nella SELECT e di nuovo nella DELETE: sintetico,
 * fuori esercizio, più vecchio di `giorni` e non in uso (lib/materializzazione/
 * usi-feed.ts, la stessa definizione della sincronizzazione). Solo se c'è un
 * feed in esercizio: senza, l'API ripiega sull'ultimo caricato e un sintetico
 * potrebbe essere proprio quello.
 */
function condizioniOrfano(giorniParam: string, filtroParam: string): string {
  return `${SINTETICO_FUORI_ESERCIZIO}
     AND f.uploaded_at < now() - make_interval(days => ${giorniParam})
     AND (${filtroParam}::text IS NULL OR f.filename LIKE ${filtroParam}::text)
     AND EXISTS (SELECT 1 FROM gtfs_feeds g WHERE g.is_active)
     AND ${nonInUso()}`;
}

/** Calcoli delle tariffe «running» da oltre `ore`: «error», da rilanciare. */
export async function chiudiRunAppesi(c: Client, ore = ORE_RUN_APPESO, ambito: Ambito = {}): Promise<{ odMinima: number; assegnazioneNodi: number }> {
  const chiudi = (tabella: string) => c.query(
    `UPDATE public.${tabella}
        SET status = 'error', error_message = $2, finished_at = now()
      WHERE status = 'running' AND started_at < now() - make_interval(hours => $1)
        AND ($3::uuid[] IS NULL OR feed_id = ANY($3::uuid[]))
        AND ($4::text IS NULL OR feed_id IN (SELECT id FROM gtfs_feeds WHERE filename LIKE $4::text))
     RETURNING id`, [ore, MESSAGGIO_RUN, ambito.feedIds ?? null, ambito.filename ?? null]);
  const a = await chiudi("gtfs_fare_od_matrix_runs");
  const b = await chiudi("gtfs_fare_node_assignment_runs");
  return { odMinima: a.rows.length, assegnazioneNodi: b.rows.length };
}

/** I feed sintetici orfani, i più vecchi prima. */
export async function feedOrfani(c: Client, giorni = GIORNI_FEED_ORFANO, limite = FEED_PER_GIRO, ambito: Ambito = {}): Promise<Array<{ id: string; filename: string; uploaded_at: Date }>> {
  const r = await c.query(
    `SELECT f.id, f.filename, f.uploaded_at FROM public.gtfs_feeds f
      WHERE ${condizioniOrfano("$1", "$3")}
      ORDER BY f.uploaded_at, f.id LIMIT $2`, [giorni, limite, ambito.filename ?? null]);
  return r.rows;
}

/**
 * Cancella i feed orfani, uno per transazione: la DELETE ricontrolla le
 * condizioni (un feed riagganciato nel frattempo resta). Un errore su un
 * feed (per esempio un lock che scade) non ferma gli altri.
 */
export async function cancellaFeedOrfani(c: Client, log: Log, giorni = GIORNI_FEED_ORFANO, limite = FEED_PER_GIRO, ambito: Ambito = {}): Promise<string[]> {
  const cancellati: string[] = [];
  for (const f of await feedOrfani(c, giorni, limite, ambito)) {
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL lock_timeout = '5s'");
      await c.query("SET LOCAL statement_timeout = '10min'");
      const r = await c.query(
        `DELETE FROM public.gtfs_feeds f WHERE f.id = $2 AND ${condizioniOrfano("$1", "$3")} RETURNING f.id`, [giorni, f.id, ambito.filename ?? null]);
      await c.query("COMMIT");
      if (r.rows.length) {
        cancellati.push(f.id);
        log.info({ feedId: f.id, filename: f.filename, caricato: f.uploaded_at }, "pulizie: feed sintetico orfano cancellato");
      }
    } catch (err: any) {
      await c.query("ROLLBACK").catch(() => undefined);
      log.warn({ err: err?.message, feedId: f.id }, "pulizie: feed orfano non cancellato, ci riprovo al prossimo giro");
    }
  }
  return cancellati;
}

/** Un giro di pulizie, se nessun altro lo sta facendo. */
export async function eseguiPulizie(log: Log, ambito: Ambito = {}): Promise<{ saltato: boolean; runChiusi?: { odMinima: number; assegnazioneNodi: number }; feedCancellati?: string[] }> {
  const c = await pool.connect();
  let preso = false;
  try {
    preso = (await c.query("SELECT pg_try_advisory_lock(hashtextextended('cerbero:pulizie', 0)) AS ok")).rows[0]?.ok === true;
    if (!preso) return { saltato: true };
    const runChiusi = await chiudiRunAppesi(c, ORE_RUN_APPESO, ambito);
    if (runChiusi.odMinima || runChiusi.assegnazioneNodi) log.info(runChiusi, "pulizie: calcoli delle tariffe rimasti «running» chiusi come interrotti");
    const feedCancellati = await cancellaFeedOrfani(c, log, GIORNI_FEED_ORFANO, FEED_PER_GIRO, ambito);
    return { saltato: false, runChiusi, feedCancellati };
  } finally {
    if (preso) await c.query("SELECT pg_advisory_unlock(hashtextextended('cerbero:pulizie', 0))").catch(() => undefined);
    c.release();
  }
}

/**
 * Le pulizie ogni 6 ore (la prima 2 minuti dopo l'avvio), solo quando `puo()`:
 * il lavoratore le fa solo con lo schema «ok», non «avanti» (una tabella nuova
 * che punta ai feed il codice vecchio non la conosce). Restituisce lo stop.
 */
export function avviaPulizie(log: Log, puo: () => boolean = () => true, ogniMs = OGNI_MS): () => void {
  const giro = () => {
    if (!puo()) { log.info({}, "pulizie: saltate, lo schema del database non è quello di questo codice"); return; }
    eseguiPulizie(log).catch(err => log.error({ err }, "pulizie: giro non riuscito"));
  };
  const primo = setTimeout(giro, PRIMO_GIRO_MS);
  const ciclo = setInterval(giro, ogniMs);
  primo.unref(); ciclo.unref();
  return () => { clearTimeout(primo); clearInterval(ciclo); };
}
