-- ═══════════════════════════════════════════════════════════════════════════
-- 0002 · Argos legge solo le tabelle che usa
-- ───────────────────────────────────────────────────────────────────────────
-- Il ruolo argos_ro (creato da argos/cerbero_readonly_user.sql) poteva leggere
-- TUTTE le tabelle di public e caronte, compresi utenti (hash delle password,
-- segreti della verifica in due passaggi), registro degli accessi, anagrafica
-- e codici sanitari del roster; e, con i permessi di default, ogni tabella
-- nuova. Argos ne usa 23: le stesse di
-- artifacts/api-server/src/lib/contratto-argos.ts, che un test confronta con
-- l'elenco qui sotto.
--
-- 1. tolti i permessi di default che danno ad argos_ro le tabelle future;
-- 2. tolta ogni lettura sulle tabelle di public e caronte;
-- 3. ridata la lettura solo sulle 23 tabelle dell'elenco.
-- Se argos_ro non esiste non fa niente. Si può rieseguire.
-- Per tornare indietro in emergenza (ridà tutto):
--   GRANT SELECT ON ALL TABLES IN SCHEMA public, caronte TO argos_ro;
-- ═══════════════════════════════════════════════════════════════════════════

DO $argos$
DECLARE
  lettura constant text[] := ARRAY[
    'public.gtfs_feeds', 'public.gtfs_routes', 'public.gtfs_stops', 'public.gtfs_trips', 'public.gtfs_stop_times',
    'public.points_of_interest', 'public.census_sections', 'public.traffic_snapshots', 'public.scenarios',
    'public.gtfs_fare_official_nodes', 'public.gtfs_fare_od_matrix', 'public.gtfs_fare_od_matrix_runs',
    'public.ps_projects', 'public.ps_routes', 'public.ps_route_variants', 'public.ps_variant_stops',
    'public.ps_stops', 'public.ps_trips', 'public.ps_stop_times', 'public.ps_calendars',
    'caronte.stop_transits', 'caronte.vehicle_positions', 'caronte.active_trips'
  ];
  t text;
  d record;
  puo boolean;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'argos_ro') THEN
    RAISE NOTICE '0002: il ruolo argos_ro non c''è, niente da fare';
    RETURN;
  END IF;

  -- 1. Permessi di default: chi li ha dati si legge dal catalogo (in
  --    produzione è postgres), invece di scriverne il nome qui.
  FOR d IN
    SELECT pg_get_userbyid(da.defaclrole) AS ruolo, n.nspname AS schema
      FROM pg_default_acl da
      LEFT JOIN pg_namespace n ON n.oid = da.defaclnamespace
     WHERE da.defaclobjtype = 'r'
       AND (n.nspname IS NULL OR n.nspname IN ('public', 'caronte'))
       AND EXISTS (SELECT 1 FROM aclexplode(da.defaclacl) a WHERE a.grantee = 'argos_ro'::regrole)
  LOOP
    SELECT r.rolsuper OR pg_has_role(current_user, d.ruolo, 'MEMBER') INTO puo
      FROM pg_roles r WHERE r.rolname = current_user;
    IF NOT puo THEN
      RAISE WARNING '0002: restano i permessi di default di % per argos_ro: toglierli richiede quel ruolo o un superutente', d.ruolo;
      CONTINUE;
    END IF;
    IF d.schema IS NULL THEN
      EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I REVOKE ALL ON TABLES FROM argos_ro', d.ruolo);
    ELSE
      EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I REVOKE ALL ON TABLES FROM argos_ro', d.ruolo, d.schema);
    END IF;
  END LOOP;

  -- 2. Via ogni lettura sulle tabelle (e le viste) di public e caronte
  EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM argos_ro';
  IF to_regnamespace('caronte') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA caronte FROM argos_ro';
  END IF;

  -- 3. La lettura sulle tabelle che Argos usa
  EXECUTE 'GRANT USAGE ON SCHEMA public TO argos_ro';
  IF to_regnamespace('caronte') IS NOT NULL THEN
    EXECUTE 'GRANT USAGE ON SCHEMA caronte TO argos_ro';
  END IF;
  FOREACH t IN ARRAY lettura LOOP
    IF to_regclass(t) IS NOT NULL THEN
      EXECUTE format('GRANT SELECT ON %I.%I TO argos_ro', split_part(t, '.', 1), split_part(t, '.', 2));
    ELSE
      RAISE NOTICE '0002: % non c''è, niente da concedere', t;
    END IF;
  END LOOP;
END
$argos$;
