-- ============================================================
-- Il turno macchina di ogni giorno pubblicato (migrazione 0023, PR 3.6):
-- quello che c'è in un database PRIMA della migrazione.
--   psql "$URL_DI_POSTGRES" -v ON_ERROR_STOP=1 -f lib/db/tests/turni-pubblicati-prima.sql
-- Va caricato su un database non ancora migrato alla 0023, poi si migra e si
-- controlla con turni-pubblicati-dopo.sql. Due giorni pubblicati coi turni
-- guida di un turni macchina: uno attivo e uno sostituito da una
-- pubblicazione successiva. Tutti e due prendono il turno macchina dei loro
-- turni guida.
-- ============================================================
\set ON_ERROR_STOP 1
\set QUIET 1
BEGIN;
INSERT INTO public.service_program_scenarios (id, name, date, input, result)
VALUES ('c3600000-0000-4000-8000-0000000000a1', 'Prova turni macchina pubblicati', '20310303', '{}', '{"shifts":[]}');
INSERT INTO public.driver_shift_scenarios (id, service_program_scenario_id, name, result)
VALUES ('c3600000-0000-4000-8000-0000000000b1', 'c3600000-0000-4000-8000-0000000000a1', 'Prova turni guida pubblicati', '{"driverShifts":[]}');
INSERT INTO public.roster_pubblicazioni (id, tipo, programma, dal, al) VALUES
  ('c3600000-0000-4000-8000-0000000000c1', 'pubblica', 'Prova 0023', '2031-03-03', '2031-03-04'),
  ('c3600000-0000-4000-8000-0000000000c2', 'pubblica', 'Prova 0023', '2031-03-04', '2031-03-04');
INSERT INTO public.roster_turni_pubblicati (day, udp_id, dss_id, pubblicazione_id, sostituita_da) VALUES
  ('2031-03-03', 'c3600000-0000-4000-8000-0000000000d1', 'c3600000-0000-4000-8000-0000000000b1', 'c3600000-0000-4000-8000-0000000000c1', NULL),
  ('2031-03-04', 'c3600000-0000-4000-8000-0000000000d1', 'c3600000-0000-4000-8000-0000000000b1', 'c3600000-0000-4000-8000-0000000000c1', 'c3600000-0000-4000-8000-0000000000c2');
COMMIT;
