-- ============================================================
-- Il turno macchina di ogni giorno pubblicato (migrazioni 0023 e 0024,
-- PR 3.6): che cosa deve esserci DOPO la migrazione nelle righe di
-- turni-pubblicati-prima.sql. Alla fine toglie le righe di prova.
--   psql "$URL_DI_POSTGRES" -v ON_ERROR_STOP=1 -f lib/db/tests/turni-pubblicati-dopo.sql
-- ============================================================
\set ON_ERROR_STOP 1
\set QUIET 1
DO $$
DECLARE
  n bigint;
BEGIN
  SELECT pg_catalog.count(*) INTO n FROM public.roster_turni_pubblicati WHERE vss_id IS NULL;
  IF n <> 0 THEN RAISE EXCEPTION '% righe del canale sono rimaste senza turno macchina', n; END IF;
  SELECT pg_catalog.count(*) INTO n FROM public.roster_turni_pubblicati
   WHERE dss_id = 'c3600000-0000-4000-8000-0000000000b1' AND vss_id = 'c3600000-0000-4000-8000-0000000000a1';
  IF n <> 2 THEN RAISE EXCEPTION 'le due righe di prova hanno il turno macchina dei loro turni guida: % su 2', n; END IF;
END $$;
DELETE FROM public.roster_turni_pubblicati WHERE dss_id = 'c3600000-0000-4000-8000-0000000000b1';
DELETE FROM public.roster_pubblicazioni WHERE id IN ('c3600000-0000-4000-8000-0000000000c1', 'c3600000-0000-4000-8000-0000000000c2');
DELETE FROM public.driver_shift_scenarios WHERE id = 'c3600000-0000-4000-8000-0000000000b1';
DELETE FROM public.service_program_scenarios WHERE id = 'c3600000-0000-4000-8000-0000000000a1';
