// Le tabelle di Cerbero che Argos può leggere, col ruolo argos_ro.
//
// Argos legge il database di Cerbero solo da argos/api/cerbero.py e
// argos/api/planning_studio.py (verificato su argos c3991b5, invariato fino ad
// aa9f32a, 26/10/2026, anche eseguendo le sue 48 funzioni di lettura): orari
// GTFS, Planning Studio, territorio e domanda, nodi e matrice delle tariffe,
// Sala Operativa live. Niente utenti, accessi, anagrafica, roster.
//
// È l'elenco che conta: a ogni avvio il migratore riporta i permessi di
// argos_ro esattamente qui (lib/db/scripts/argos-permessi.mjs) e l'API avvisa
// se nel frattempo sono cambiati. Una tabella in più per Argos si aggiunge qui,
// insieme alla modifica di Argos che la usa.

export const RUOLO_ARGOS = "argos_ro";

export const ARGOS_LETTURA = Object.freeze([
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
]);
