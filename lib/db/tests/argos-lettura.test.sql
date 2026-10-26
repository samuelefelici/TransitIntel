-- Dopo la migrazione 0002: argos_ro legge esattamente le tabelle del contratto
-- (artifacts/api-server/src/lib/contratto-argos.ts, stesso elenco qui sotto:
-- un test vitest controlla che coincidano) e nessuna tabella futura.
-- Fallisce con un'eccezione al primo scostamento.
DO $$
DECLARE
  contratto constant text[] := ARRAY[
    'public.gtfs_feeds', 'public.gtfs_routes', 'public.gtfs_stops', 'public.gtfs_trips', 'public.gtfs_stop_times',
    'public.points_of_interest', 'public.census_sections', 'public.traffic_snapshots', 'public.scenarios',
    'public.gtfs_fare_official_nodes', 'public.gtfs_fare_od_matrix', 'public.gtfs_fare_od_matrix_runs',
    'public.ps_projects', 'public.ps_routes', 'public.ps_route_variants', 'public.ps_variant_stops',
    'public.ps_stops', 'public.ps_trips', 'public.ps_stop_times', 'public.ps_calendars',
    'caronte.stop_transits', 'caronte.vehicle_positions', 'caronte.active_trips'
  ];
  fuori text;
  manca text;
BEGIN
  SELECT string_agg(n.nspname || '.' || c.relname, ', ' ORDER BY 1) INTO fuori
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname IN ('public', 'caronte') AND c.relkind IN ('r', 'v', 'm', 'p')
     AND has_table_privilege('argos_ro', c.oid, 'SELECT')
     AND n.nspname || '.' || c.relname <> ALL (contratto);
  IF fuori IS NOT NULL THEN
    RAISE EXCEPTION 'argos_ro legge ancora tabelle fuori dal contratto: %', fuori;
  END IF;

  SELECT string_agg(t, ', ') INTO manca
    FROM unnest(contratto) t
   WHERE to_regclass(t) IS NULL OR NOT has_table_privilege('argos_ro', t, 'SELECT');
  IF manca IS NOT NULL THEN
    RAISE EXCEPTION 'argos_ro non legge tabelle del contratto: %', manca;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_default_acl d
              WHERE EXISTS (SELECT 1 FROM aclexplode(d.defaclacl) a WHERE a.grantee = 'argos_ro'::regrole)) THEN
    RAISE EXCEPTION 'restano permessi di default per argos_ro: leggerebbe le tabelle future';
  END IF;

  CREATE TABLE public.ci_tabella_nuova (x int);
  CREATE TABLE caronte.ci_tabella_nuova (x int);
  IF has_table_privilege('argos_ro', 'public.ci_tabella_nuova', 'SELECT')
     OR has_table_privilege('argos_ro', 'caronte.ci_tabella_nuova', 'SELECT') THEN
    RAISE EXCEPTION 'una tabella nuova è leggibile da argos_ro';
  END IF;
  DROP TABLE public.ci_tabella_nuova;
  DROP TABLE caronte.ci_tabella_nuova;
  RAISE NOTICE 'argos_ro: % tabelle del contratto, nient''altro', array_length(contratto, 1);
END
$$;
