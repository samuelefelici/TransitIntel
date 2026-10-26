/**
 * Le tabelle di Cerbero che Argos può leggere, col ruolo `argos_ro`.
 *
 * Argos legge il database di Cerbero solo da argos/api/cerbero.py e
 * argos/api/planning_studio.py (verificato su argos c3991b5, 26/10/2026):
 * orari GTFS, Planning Studio, territorio, nodi e matrice delle tariffe, Sala
 * Operativa live. Nient'altro: niente utenti, accessi, anagrafica, roster.
 *
 * L'elenco si cambia insieme al codice di Argos e con una migrazione nuova
 * che dà o toglie il GRANT (la 0002 lo fissa la prima volta): un test
 * controlla che coincida con la migrazione, e all'avvio l'API avvisa se
 * argos_ro legge qualcosa che qui non c'è (lib/controllo-argos.ts).
 */
export const ARGOS_LETTURA: readonly string[] = [
  // orari GTFS (feed in esercizio)
  "public.gtfs_feeds",
  "public.gtfs_routes",
  "public.gtfs_stops",
  "public.gtfs_trips",
  "public.gtfs_stop_times",
  // territorio e domanda
  "public.points_of_interest",
  "public.census_sections",
  "public.traffic_snapshots",
  "public.scenarios",
  // tariffe: nodi ufficiali e matrice origine/destinazione
  "public.gtfs_fare_official_nodes",
  "public.gtfs_fare_od_matrix",
  "public.gtfs_fare_od_matrix_runs",
  // Planning Studio
  "public.ps_projects",
  "public.ps_routes",
  "public.ps_route_variants",
  "public.ps_variant_stops",
  "public.ps_stops",
  "public.ps_trips",
  "public.ps_stop_times",
  "public.ps_calendars",
  // Sala Operativa live (AVM)
  "caronte.stop_transits",
  "caronte.vehicle_positions",
  "caronte.active_trips",
];

/** Le tabelle che argos_ro legge oltre il contratto, in ordine. */
export function letturaFuoriContratto(leggibili: readonly string[], contratto: readonly string[] = ARGOS_LETTURA): string[] {
  const ammesse = new Set(contratto);
  return [...new Set(leggibili)].filter(t => !ammesse.has(t)).sort();
}
