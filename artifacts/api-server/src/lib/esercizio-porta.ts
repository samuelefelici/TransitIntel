/**
 * La porta unica del programma in esercizio (PR 3.2, migrazione 0019).
 *
 * Il programma in esercizio è il feed GTFS acceso (gtfs_feeds.is_active): lo
 * leggono AVM, tariffe, turni e le pagine dell'esercizio. Lo si cambia solo da
 * qui, da tre punti:
 *   - «Metti in esercizio» di Planning Studio (subito);
 *   - il giro delle attivazioni programmate, alla decorrenza;
 *   - «Attiva» nella pagina GTFS (un file caricato a mano, solo l'amministratore).
 *
 * In una transazione, sotto un lucchetto (due attivazioni insieme si mettono in
 * fila):
 *   - il feed scelto si accende e diventa quello di default; tutti gli altri si
 *     spengono, in tutta l'installazione (un'azienda, un programma in
 *     esercizio). Prima «Metti in esercizio» spegneva solo i feed dello stesso
 *     proprietario, e ne potevano restare due accesi;
 *   - nello storico (ps_activation_log) si chiude il periodo del feed di prima
 *     e si apre quello del nuovo, con chi e da quale canale. Se lo storico non
 *     si scrive, l'attivazione non avviene: prima andava avanti lo stesso, e lo
 *     storico non diceva più quale programma era in esercizio in un giorno.
 *
 * Il database tiene le stesse due regole (un feed acceso, un periodo aperto):
 * vincoli della 0019, verificati alla fine della transazione.
 */
import { sql } from "drizzle-orm";
import { contestoDb } from "@workspace/db/contesto";

type Esecutore = { execute: (q: any) => Promise<any> };

/** Il motivo per cui un'attivazione non si fa, da mostrare a chi l'ha chiesta. */
export class AttivazioneRifiutata extends Error {
  constructor(messaggio: string, readonly stato = 409) { super(messaggio); }
}

export interface EsitoAttivazione {
  /** il feed che era in esercizio prima (null se nessuno, o se era già questo) */
  precedente: string | null;
  /** il feed era già in esercizio: niente è cambiato */
  giaInEsercizio: boolean;
}

const righe = (r: any): any[] => r?.rows ?? [];

/**
 * Mette in esercizio `feedId`, dentro la transazione `tx` di chi chiama (che
 * può fare altro prima, nella stessa transazione: il giro delle attivazioni
 * programmate archivia il feed di prima del progetto e ne sposta il
 * puntatore). `progettoId` è il progetto di Planning Studio da cui viene il
 * feed; null per un file caricato a mano (lo cerca da sé, se il feed è di un
 * progetto). Chi e da dove li prende dal contesto della connessione (PR 2.9).
 */
export async function mettiInEsercizio(
  tx: Esecutore,
  a: { feedId: string; progettoId?: string | null; utenteId: string | null },
): Promise<EsitoAttivazione> {
  /* un'attivazione alla volta: la seconda aspetta la prima e vede il suo risultato */
  await tx.execute(sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('cerbero:esercizio'))`);

  const feed = righe(await tx.execute(sql`
    SELECT id, is_active FROM gtfs_feeds WHERE id = ${a.feedId}::uuid FOR UPDATE`))[0];
  if (!feed) throw new AttivazioneRifiutata("Il feed da mettere in esercizio non c'è più", 404);

  const precedente: string | null = righe(await tx.execute(sql`
    SELECT id FROM gtfs_feeds WHERE is_active AND id <> ${a.feedId}::uuid ORDER BY uploaded_at DESC LIMIT 1`))[0]?.id ?? null;
  const giaInEsercizio = !!feed.is_active && precedente === null;

  /* acceso il nuovo, spenti tutti gli altri; un feed archiviato che torna in
   * esercizio (il programma di prima, rimesso) non è più archiviato */
  await tx.execute(sql`
    UPDATE gtfs_feeds
       SET is_active = (id = ${a.feedId}::uuid),
           is_default = (id = ${a.feedId}::uuid),
           archived_at = CASE WHEN id = ${a.feedId}::uuid THEN NULL ELSE archived_at END
     WHERE is_active OR is_default OR id = ${a.feedId}::uuid`);

  /* lo storico: si chiude il periodo di prima e si apre quello nuovo. Il
   * periodo già aperto dello stesso feed resta com'è: riattivare il feed in
   * esercizio non cambia niente */
  await tx.execute(sql`
    UPDATE ps_activation_log SET deactivated_at = now()
     WHERE deactivated_at IS NULL AND feed_id <> ${a.feedId}::uuid`);
  const aperto = righe(await tx.execute(sql`
    SELECT 1 FROM ps_activation_log WHERE deactivated_at IS NULL AND feed_id = ${a.feedId}::uuid`)).length > 0;
  if (!aperto) {
    const via = contestoDb.getStore()?.via || null;
    await tx.execute(sql`
      INSERT INTO ps_activation_log (project_id, feed_id, user_id, via)
      VALUES (COALESCE(${a.progettoId ?? null}::uuid,
                       (SELECT id FROM ps_projects WHERE materialized_feed_id = ${a.feedId}::uuid ORDER BY created_at LIMIT 1)),
              ${a.feedId}::uuid, ${a.utenteId}::uuid, ${via})`);
  }
  return { precedente, giaInEsercizio };
}

/**
 * Un feed che si cancella mentre è in esercizio (solo l'amministratore, e solo
 * forzando): nello storico il suo periodo si chiude, nella stessa transazione
 * della cancellazione. Il programma in esercizio, da lì, non c'è finché non se
 * ne attiva un altro.
 */
export async function chiudiPeriodoDelFeed(tx: Esecutore, feedId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('cerbero:esercizio'))`);
  await tx.execute(sql`
    UPDATE ps_activation_log SET deactivated_at = now()
     WHERE deactivated_at IS NULL AND feed_id = ${feedId}::uuid`);
}
