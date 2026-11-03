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
 *    quelli più vecchi di 2 giorni che nessuno usa: non attivi, non di
 *    default, non archiviati (un feed in esercizio sostituito si archivia e
 *    resta), non puntati da nessun progetto, scenario o attivazione, senza
 *    lavoro dell'utente sopra (tariffe, POI, classificazioni delle linee). Al
 *    più 5 a giro, uno per riga nel log.
 *
 * I giri di Argos (agent_optimize_jobs) rimasti «running» non si toccano: il
 * loro stato vero lo calcola già vistaGiro dalla coda, e per un giro
 * interrotto restituisce la richiesta per rilanciarlo.
 */
import { pool } from "@workspace/db";

export const OGNI_MS = 6 * 60 * 60 * 1000;
const PRIMO_GIRO_MS = 2 * 60 * 1000;
export const ORE_RUN_APPESO = 24;
export const GIORNI_FEED_ORFANO = 2;
export const FEED_PER_GIRO = 5;
const MESSAGGIO_RUN = "Calcolo interrotto (riavvio del server): rilancialo";

type Log = { info: (...a: any[]) => void; warn: (...a: any[]) => void; error: (...a: any[]) => void };
type Client = { query: (text: string, values?: unknown[]) => Promise<{ rows: any[] }> };

/**
 * Chi usa un feed, oltre alle sue righe GTFS: i puntatori (con o senza
 * chiave esterna) e le tabelle dove l'utente lavora sopra un feed. Un feed
 * con anche una sola di queste righe non è orfano. Una colonna nuova che
 * punta a gtfs_feeds va aggiunta qui (lo controlla pulizie-db.test.ts sul
 * catalogo).
 */
export const USI_DEL_FEED: ReadonlyArray<readonly [tabella: string, colonna: string]> = [
  ["scheduling_projects", "feed_id"],
  ["ps_projects", "materialized_feed_id"],
  ["ps_projects", "source_feed_id"],
  ["ps_pending_activations", "feed_id"],
  ["ps_activation_log", "feed_id"],
  ["service_program_scenarios", "feed_id"],
  ["planning_scenarios", "baseline_feed_id"],
  ["planning_pois", "feed_id"],
  ["planning_route_classifications", "feed_id"],
  ["gtfs_feed_economic_params", "feed_id"],
  ["gtfs_fare_products", "feed_id"],
  ["gtfs_fare_networks", "feed_id"],
  ["gtfs_fare_zone_clusters", "feed_id"],
  ["gtfs_fare_zone_cluster_stops", "feed_id"],
  ["gtfs_fare_official_nodes", "feed_id"],
  ["gtfs_fare_od_matrix", "feed_id"],
  ["gtfs_fare_od_matrix_runs", "feed_id"],
  ["gtfs_fare_node_assignment_runs", "feed_id"],
  ["gtfs_fare_network_edges", "feed_id"],
  ["gtfs_fare_stop_assignment_overrides", "feed_id"],
  ["gtfs_fare_audit_log", "feed_id"],
  ["gtfs_fare_attributes", "feed_id"],
  ["gtfs_fare_rules", "feed_id"],
  ["gtfs_fare_leg_rules", "feed_id"],
  ["gtfs_fare_transfer_rules", "feed_id"],
  ["gtfs_fare_media", "feed_id"],
  ["gtfs_fare_areas", "feed_id"],
  ["gtfs_rider_categories", "feed_id"],
  ["gtfs_route_networks", "feed_id"],
  ["gtfs_timeframes", "feed_id"],
  ["gtfs_stop_areas", "feed_id"],
];

/**
 * Le tabelle con le righe del feed stesso (quelle che scrive il materializzatore,
 * più la cache dell'analisi): non sono usi, vanno via con il feed (CASCADE).
 */
export const RIGHE_DEL_FEED = [
  "gtfs_stops", "gtfs_routes", "gtfs_trips", "gtfs_stop_times", "gtfs_shapes", "gtfs_calendar",
  "gtfs_calendar_dates", "gtfs_feed_info", "gtfs_feed_analysis",
] as const;

/** Le condizioni di «orfano» su gtfs_feeds f, nella SELECT e di nuovo nella DELETE. */
function condizioniOrfano(giorniParam: string): string {
  const usi = USI_DEL_FEED.map(([t, c]) => `NOT EXISTS (SELECT 1 FROM ${t} u WHERE u.${c} = f.id)`).join("\n         AND ");
  return `f.filename LIKE 'ps-%.synthetic'
         AND NOT f.is_active AND NOT f.is_default AND f.archived_at IS NULL
         AND f.uploaded_at < now() - make_interval(days => ${giorniParam})
         AND ${usi}`;
}

/** Calcoli delle tariffe «running» da oltre `ore`: «error», da rilanciare. */
export async function chiudiRunAppesi(c: Client, ore = ORE_RUN_APPESO): Promise<{ odMinima: number; assegnazioneNodi: number }> {
  const chiudi = (tabella: string) => c.query(
    `UPDATE public.${tabella}
        SET status = 'error', error_message = $2, finished_at = now()
      WHERE status = 'running' AND started_at < now() - make_interval(hours => $1)
     RETURNING id`, [ore, MESSAGGIO_RUN]);
  const a = await chiudi("gtfs_fare_od_matrix_runs");
  const b = await chiudi("gtfs_fare_node_assignment_runs");
  return { odMinima: a.rows.length, assegnazioneNodi: b.rows.length };
}

/** I feed sintetici orfani, i più vecchi prima. */
export async function feedOrfani(c: Client, giorni = GIORNI_FEED_ORFANO, limite = FEED_PER_GIRO): Promise<Array<{ id: string; filename: string; uploaded_at: Date }>> {
  const r = await c.query(
    `SELECT f.id, f.filename, f.uploaded_at FROM public.gtfs_feeds f
      WHERE ${condizioniOrfano("$1")}
      ORDER BY f.uploaded_at, f.id LIMIT $2`, [giorni, limite]);
  return r.rows;
}

/**
 * Cancella i feed orfani, uno per transazione: la DELETE ricontrolla le
 * condizioni (un feed riagganciato nel frattempo resta). Un errore su un
 * feed (per esempio un lock che scade) non ferma gli altri.
 */
export async function cancellaFeedOrfani(c: Client, log: Log, giorni = GIORNI_FEED_ORFANO, limite = FEED_PER_GIRO): Promise<string[]> {
  const cancellati: string[] = [];
  for (const f of await feedOrfani(c, giorni, limite)) {
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL lock_timeout = '5s'");
      await c.query("SET LOCAL statement_timeout = '10min'");
      const r = await c.query(
        `DELETE FROM public.gtfs_feeds f WHERE f.id = $2 AND ${condizioniOrfano("$1")} RETURNING f.id`, [giorni, f.id]);
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
export async function eseguiPulizie(log: Log): Promise<{ saltato: boolean; runChiusi?: { odMinima: number; assegnazioneNodi: number }; feedCancellati?: string[] }> {
  const c = await pool.connect();
  let preso = false;
  try {
    preso = (await c.query("SELECT pg_try_advisory_lock(hashtextextended('cerbero:pulizie', 0)) AS ok")).rows[0]?.ok === true;
    if (!preso) return { saltato: true };
    const runChiusi = await chiudiRunAppesi(c);
    if (runChiusi.odMinima || runChiusi.assegnazioneNodi) log.info(runChiusi, "pulizie: calcoli delle tariffe rimasti «running» chiusi come interrotti");
    const feedCancellati = await cancellaFeedOrfani(c, log);
    return { saltato: false, runChiusi, feedCancellati };
  } finally {
    if (preso) await c.query("SELECT pg_advisory_unlock(hashtextextended('cerbero:pulizie', 0))").catch(() => undefined);
    c.release();
  }
}

/**
 * Le pulizie ogni 6 ore (la prima 2 minuti dopo l'avvio), solo quando `puo()`
 * (lo schema è quello che il lavoratore conosce). Restituisce lo stop.
 */
export function avviaPulizie(log: Log, puo: () => boolean = () => true, ogniMs = OGNI_MS): () => void {
  const giro = () => {
    if (!puo()) return;
    eseguiPulizie(log).catch(err => log.error({ err }, "pulizie: giro non riuscito"));
  };
  const primo = setTimeout(giro, PRIMO_GIRO_MS);
  const ciclo = setInterval(giro, ogniMs);
  primo.unref(); ciclo.unref();
  return () => { clearTimeout(primo); clearInterval(ciclo); };
}
