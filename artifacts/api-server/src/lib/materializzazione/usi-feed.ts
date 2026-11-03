/**
 * Quando un feed GTFS è «in uso»: una sola definizione per la sincronizzazione
 * (che cancella il feed vecchio di un progetto) e per le pulizie del
 * lavoratore (che cancellano i feed sintetici orfani). Un feed in uso non si
 * cancella: resta, e se smette di servire lo riprendono le pulizie.
 *
 * Una colonna nuova che punta a gtfs_feeds va classificata qui: uso o riga del
 * feed stesso (lo controlla pulizie-db.test.ts sul catalogo atteso delle
 * migrazioni).
 */

/** I puntatori (con o senza chiave esterna) e le tabelle dove l'utente lavora sopra un feed. */
export const USI_DEL_FEED: ReadonlyArray<readonly [tabella: string, colonna: string]> = [
  ["scheduling_projects", "feed_id"],
  // la relazione di processo legge il feed dello scenario (mappa delle coincidenze)
  ["service_program_scenarios", "feed_id"],
  ["ps_projects", "materialized_feed_id"],
  ["ps_projects", "source_feed_id"],
  ["ps_pending_activations", "feed_id"],
  ["ps_activation_log", "feed_id"],
  ["planning_scenarios", "baseline_feed_id"],
  ["planning_pois", "feed_id"],
  ["planning_route_classifications", "feed_id"],
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
 * Le tabelle con le righe del feed stesso: quelle che scrive il
 * materializzatore, la cache dell'analisi e i parametri economici (li crea già
 * una lettura della scheda «Pianificazione», con i valori di default). Non sono
 * usi: vanno via con il feed (CASCADE), come prima della 2.7a.
 */
export const RIGHE_DEL_FEED = [
  "gtfs_stops", "gtfs_routes", "gtfs_trips", "gtfs_stop_times", "gtfs_shapes", "gtfs_calendar",
  "gtfs_calendar_dates", "gtfs_feed_info", "gtfs_feed_analysis", "gtfs_feed_economic_params",
] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * La condizione SQL «il feed f non è in uso»: nessun puntatore, nessun lavoro
 * dell'utente sopra, nessun calcolo vivo in coda che lo legge
 * (richiesta.feedId dei turni macchina, dei VCSP e dei giri). Testo SQL
 * costante (nomi dall'elenco qui sopra), sull'alias `f` di gtfs_feeds.
 *
 * `progettoSincronizzato`: la sincronizzazione di quel progetto di scheduling
 * non conta gli scenari dei turni del progetto stesso, che marca «superati»
 * subito dopo (come prima della 2.7a, il feed vecchio va via e lo scenario
 * resta col suo id); quelli di altri progetti lo tengono.
 */
export function nonInUso(o: { progettoSincronizzato?: string } = {}): string {
  if (o.progettoSincronizzato !== undefined && !UUID.test(o.progettoSincronizzato)) throw new Error("progetto non valido");
  const usi = USI_DEL_FEED.map(([t, c]) =>
    t === "service_program_scenarios" && o.progettoSincronizzato
      ? `NOT EXISTS (SELECT 1 FROM ${t} u WHERE u.${c} = f.id AND u.project_id IS DISTINCT FROM '${o.progettoSincronizzato}'::uuid)`
      : `NOT EXISTS (SELECT 1 FROM ${t} u WHERE u.${c} = f.id)`);
  usi.push(`NOT EXISTS (SELECT 1 FROM coda.lavori l
                         WHERE l.stato IN ('in_coda', 'in_corso') AND l.richiesta->>'feedId' = f.id::text)`);
  return usi.join("\n     AND ");
}

/** Un feed sintetico di Planning Studio che non è in esercizio (né attivo, né di default, né archiviato). */
export const SINTETICO_FUORI_ESERCIZIO = `f.filename LIKE 'ps-%.synthetic'
     AND NOT f.is_active AND NOT f.is_default AND f.archived_at IS NULL`;

/**
 * Il nome di un feed caricato a mano. «ps-….synthetic» è il nome dei feed che
 * Planning Studio genera, e le pulizie del lavoratore cancellano quelli orfani:
 * un file caricato con quel nome prende «.zip» in fondo, così non si confonde.
 */
export function nomeCaricato(originale: string): string {
  return /^ps-.*\.synthetic$/.test(originale) ? `${originale}.zip` : originale;
}
