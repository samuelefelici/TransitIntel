-- ============================================================
-- Il registro delle modifiche (migrazioni 0006 e 0007, PR 2.10 e 2.11)
--   psql "$URL_DI_POSTGRES" -v ON_ERROR_STOP=1 -f lib/db/tests/registro.test.sql
-- Tutto in una transazione che alla fine si annulla: il database resta com'era
-- (anche il registro, che in produzione nasce spento, si accende solo qui dentro).
-- Controlla le regole del 25/10: chi, quando, quale riga, quali campi; i valori
-- solo per programmi, orari, turni e tariffe; utenti, roster e anagrafica solo
-- coi nomi dei campi (degli utenti ruolo e permessi col valore); mai un hash,
-- un segreto della verifica, un codice sanitario; un login non scrive niente;
-- riepiloghi per le istruzioni grandi, le cascate e il modo «riepilogo»; l'app
-- non lo legge, non lo cambia, non lo spegne; anonimizzazione e conservazione.
-- Dalla 0007: i riepiloghi si sommano al COMMIT; gli orari di dettaglio sono
-- sempre in riepilogo e senza valori; la lettura passa da registro.leggi(), che
-- non filtra per persona e annota ogni consultazione.
-- ============================================================
\set ON_ERROR_STOP 1
\set QUIET 1
\pset tuples_only on
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL client_min_messages = warning;

-- I riepiloghi si sommano al COMMIT (trigger differito su registro.parziali):
-- qui, dove non si arriva mai al COMMIT, la somma si chiede prima di guardare.
\set somma 'SET CONSTRAINTS registro.registro_chiude IMMEDIATE; SET CONSTRAINTS registro.registro_chiude DEFERRED;'
-- le righe scritte in questa transazione
CREATE TEMP VIEW nostre AS SELECT * FROM registro.modifiche WHERE transazione = pg_current_xact_id();

-- ── spento: niente ──
INSERT INTO public.users (id, email, password_hash, full_name)
VALUES ('f0000000-0000-4000-8000-000000000001', 'registro-1@prova.local', 'x', 'Prova Registro');
DO $$ BEGIN
  ASSERT (SELECT count(*) FROM nostre) = 0, 'spento: il registro non scrive';
  ASSERT NOT (SELECT attivo FROM registro.impostazioni), 'il registro nasce spento';
END $$;

-- ── acceso, come una richiesta dell'app (contesto della 2.9) ──
UPDATE registro.impostazioni SET attivo = true, base_giuridica = 'prova', attivato_il = now();
DO $$ BEGIN PERFORM set_config('cerbero.attore', 'a0000000-0000-4000-8000-0000000000aa', true),
       set_config('cerbero.via', 'api', true), set_config('cerbero.richiesta', 'r-registro', true); END $$;

-- utenti: un login non scrive (ultimo accesso, contatori, l'hash rifatto da
-- un costo vecchio); un cambio di password si vede da password_cambiata_il,
-- senza valori; ruolo e permessi col valore; l'azzeramento della verifica sì
UPDATE public.users SET last_login_at = now(), sessione_versione = sessione_versione + 1, mfa_errori = 1
 WHERE id = 'f0000000-0000-4000-8000-000000000001';
UPDATE public.users SET password_controllata = true, password_hash = '$2b$12$UNHASHRIFATTODALLOGIN', mfa_ultimo_passo = 1
 WHERE id = 'f0000000-0000-4000-8000-000000000001';
DO $$ BEGIN ASSERT (SELECT count(*) FROM nostre) = 0, 'un login (ultimo accesso, contatori, hash rifatto) non scrive'; END $$;
UPDATE public.users SET password_hash = '$2b$12$UNHASHSEGRETISSIMO', password_cambiata_il = now(), mfa_segreto = 'SEGRETOMFA'
 WHERE id = 'f0000000-0000-4000-8000-000000000001';
UPDATE public.users SET role = 'admin', full_name = 'Prova Due' WHERE id = 'f0000000-0000-4000-8000-000000000001';
UPDATE public.users SET mfa_attiva = true WHERE id = 'f0000000-0000-4000-8000-000000000001';
UPDATE public.users SET mfa_attiva = false, mfa_segreto = NULL, mfa_recupero = NULL, sessione_versione = sessione_versione + 1
 WHERE id = 'f0000000-0000-4000-8000-000000000001';
DO $$
DECLARE r record;
BEGIN
  ASSERT (SELECT count(*) FROM nostre WHERE tabella = 'public.users' AND campi = '{mfa_attiva}' AND prima IS NULL AND dopo IS NULL) = 2,
    'attivazione e azzeramento della verifica si vedono, solo il nome';
  SELECT * INTO r FROM nostre WHERE tabella = 'public.users' AND campi = '{password_cambiata_il}';
  ASSERT FOUND, 'il cambio di password si registra col solo nome';
  ASSERT r.prima IS NULL AND r.dopo IS NULL, 'il cambio di password non ha valori';
  ASSERT r.attore = 'a0000000-0000-4000-8000-0000000000aa' AND r.via = 'api' AND r.richiesta = 'r-registro'
         AND r.ruolo_db = session_user AND r.chiave = '{"id": "f0000000-0000-4000-8000-000000000001"}'
         AND r.ambito_tipo = 'utente' AND NOT r.riepilogo, format('chi e dove: %s', row_to_json(r));
  SELECT * INTO r FROM nostre WHERE tabella = 'public.users' AND 'role' = ANY (campi);
  ASSERT r.campi = '{full_name,role}' AND r.prima = '{"role": "user"}' AND r.dopo = '{"role": "admin"}',
    format('ruolo col valore, nome senza: %s', row_to_json(r));
  ASSERT NOT EXISTS (SELECT 1 FROM nostre m WHERE m::text ~ 'UNHASH|SEGRETOMFA|password_hash|mfa_segreto|mfa_recupero'),
    'nessun hash, nessun segreto della verifica';
END $$;

-- programmi: valori prima/dopo, colonne di servizio escluse
INSERT INTO public.ps_projects (id, owner_user_id, name)
VALUES ('f0000000-0000-4000-8000-0000000000a1', 'f0000000-0000-4000-8000-000000000001', 'Programma prova');
UPDATE public.ps_projects SET name = 'Programma prova bis', last_opened_at = now()
 WHERE id = 'f0000000-0000-4000-8000-0000000000a1';
UPDATE public.ps_projects SET last_opened_at = now() WHERE id = 'f0000000-0000-4000-8000-0000000000a1';
DO $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM nostre WHERE tabella = 'public.ps_projects' AND operazione = 'UPDATE';
  ASSERT r.campi = '{name}' AND r.prima = '{"name": "Programma prova"}' AND r.dopo = '{"name": "Programma prova bis"}',
    format('programma: %s', row_to_json(r));
  ASSERT (SELECT count(*) FROM nostre WHERE tabella = 'public.ps_projects' AND operazione = 'UPDATE') = 1,
    'un UPDATE che cambia solo last_opened_at non scrive';
  SELECT * INTO r FROM nostre WHERE tabella = 'public.ps_projects' AND operazione = 'INSERT';
  ASSERT r.dopo ->> 'name' = 'Programma prova' AND r.ambito_id = 'f0000000-0000-4000-8000-0000000000a1'
         AND NOT r.dopo ? 'agency_settings' AND NOT r.dopo ? 'updated_at', format('inserimento: %s', row_to_json(r));
END $$;

-- gli uuid della pianificazione col valore, i riferimenti alle persone solo il nome
UPDATE public.ps_projects SET source_feed_id = 'f0000000-0000-4000-8000-0000000000fe',
       owner_user_id = 'f0000000-0000-4000-8000-000000000001' WHERE id = 'f0000000-0000-4000-8000-0000000000a1';
INSERT INTO public.users (id, email, password_hash, full_name)
VALUES ('f0000000-0000-4000-8000-000000000002', 'registro-2@prova.local', 'x', 'Prova Registro Due');
UPDATE public.ps_projects SET owner_user_id = 'f0000000-0000-4000-8000-000000000002' WHERE id = 'f0000000-0000-4000-8000-0000000000a1';
DO $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM nostre WHERE tabella = 'public.ps_projects' AND operazione = 'UPDATE' AND 'source_feed_id' = ANY (campi);
  ASSERT r.campi = '{source_feed_id}' AND r.dopo = '{"source_feed_id": "f0000000-0000-4000-8000-0000000000fe"}',
    format('uuid col valore: %s', row_to_json(r));
  ASSERT EXISTS (SELECT 1 FROM nostre WHERE tabella = 'public.ps_projects' AND campi = '{owner_user_id}' AND prima IS NULL AND dopo IS NULL),
    'il proprietario cambiato: solo il nome';
  ASSERT NOT EXISTS (SELECT 1 FROM nostre WHERE tabella = 'public.ps_projects' AND (prima ? 'owner_user_id' OR dopo ? 'owner_user_id')),
    'il proprietario: mai il valore';
END $$;

-- 501 righe: un riepilogo; altre 60 nella stessa transazione: lo stesso riepilogo
INSERT INTO public.ps_stops (project_id, name, lat, lon)
SELECT 'f0000000-0000-4000-8000-0000000000a1', 'F' || g, 43.6, 13.5 FROM generate_series(1, 501) g;
INSERT INTO public.ps_stops (project_id, name, lat, lon)
SELECT 'f0000000-0000-4000-8000-0000000000a1', 'G' || g, 43.6, 13.5 FROM generate_series(1, 60) g;
DO $$ BEGIN
  ASSERT (SELECT count(*) FROM registro.parziali) = 2 AND NOT EXISTS (SELECT 1 FROM nostre WHERE riepilogo),
    'prima del COMMIT i riepiloghi sono parziali in coda';
END $$;
:somma
DO $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM nostre WHERE tabella = 'public.ps_stops' AND operazione = 'INSERT';
  ASSERT (SELECT count(*) FROM nostre WHERE tabella = 'public.ps_stops' AND operazione = 'INSERT') = 1, 'un solo riepilogo';
  ASSERT r.riepilogo AND r.righe = 561 AND jsonb_array_length(r.campione) = 20 AND r.chiave IS NULL
         AND r.ambito_id = 'f0000000-0000-4000-8000-0000000000a1' AND NOT r.a_cascata, format('riepilogo: %s', row_to_json(r));
END $$;

-- 50 righe in un UPDATE: una riga per record; il modo «riepilogo» le raccoglie anche se poche
UPDATE public.ps_stops SET name = name || '!'
 WHERE project_id = 'f0000000-0000-4000-8000-0000000000a1' AND name ~ '^G([1-9]|[1-4][0-9]|50)$';
DO $$ BEGIN PERFORM set_config('cerbero.registro', 'riepilogo', true); END $$;
UPDATE public.ps_stops SET lat = 43.7 WHERE name = 'F1' AND project_id = 'f0000000-0000-4000-8000-0000000000a1';
DO $$ BEGIN PERFORM set_config('cerbero.registro', '', true); END $$;
:somma
DO $$ BEGIN
  ASSERT (SELECT count(*) FROM nostre WHERE tabella = 'public.ps_stops' AND operazione = 'UPDATE' AND NOT riepilogo) = 50,
    'fino a 50 righe: una per record';
  ASSERT (SELECT righe FROM nostre WHERE tabella = 'public.ps_stops' AND operazione = 'UPDATE' AND riepilogo) = 1
     AND (SELECT campi FROM nostre WHERE tabella = 'public.ps_stops' AND operazione = 'UPDATE' AND riepilogo) = '{lat}',
    'modo riepilogo: un riepilogo, coi campi';
END $$;

-- un UPDATE grande su colonne senza uguaglianza (json[], point, xml): il
-- confronto passa per il testo, la scrittura non fallisce mai per il registro
SAVEPOINT tipi;
ALTER TABLE public.depots ADD COLUMN prova_j json[], ADD COLUMN prova_p point, ADD COLUMN prova_x xml;
INSERT INTO public.depots (name, prova_j, prova_p, prova_x)
SELECT 'Deposito ' || g, ARRAY['{"a": 1}'::json], point(1, 1), '<a/>' FROM generate_series(1, 60) g;
UPDATE public.depots SET prova_j = ARRAY['{"a": 2}'::json], prova_p = point(2, 2), prova_x = '<b/>' WHERE name LIKE 'Deposito %';
:somma
DO $$ BEGIN
  ASSERT (SELECT righe = 60 AND campi = '{prova_j,prova_p,prova_x}' FROM nostre
           WHERE tabella = 'public.depots' AND operazione = 'UPDATE' AND riepilogo), 'UPDATE grande su json[], point, xml';
END $$;
ROLLBACK TO SAVEPOINT tipi;

-- riepiloghi: l'ambito solo se è lo stesso per tutte le righe (anche contro i
-- NULL); il campione di un UPDATE grande solo con le righe cambiate
SAVEPOINT ambito;
INSERT INTO public.depots (name, ps_project_id)
SELECT 'Ambito ' || g, CASE WHEN g = 60 THEN 'f0000000-0000-4000-8000-0000000000a1'::uuid END FROM generate_series(1, 60) g;
UPDATE public.depots SET capacity = CASE WHEN name = 'Ambito 60' THEN 7 ELSE capacity END WHERE name LIKE 'Ambito %';
:somma
DO $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM nostre WHERE tabella = 'public.depots' AND operazione = 'INSERT' AND riepilogo;
  ASSERT r.righe = 60 AND r.ambito_id IS NULL, format('59 righe senza progetto: niente ambito (%s)', row_to_json(r));
  SELECT * INTO r FROM nostre WHERE tabella = 'public.depots' AND operazione = 'UPDATE' AND riepilogo;
  ASSERT r.righe = 1 AND r.campi = '{capacity}' AND jsonb_array_length(r.campione) = 1
         AND r.ambito_id = 'f0000000-0000-4000-8000-0000000000a1'
         AND r.campione -> 0 ->> 'id' = (SELECT id::text FROM public.depots WHERE name = 'Ambito 60'),
    format('UPDATE grande: righe, campione e ambito delle sole cambiate (%s)', row_to_json(r));
END $$;
ROLLBACK TO SAVEPOINT ambito;

-- un savepoint annullato toglie anche quello che aveva scritto
SAVEPOINT prova;
UPDATE public.ps_projects SET name = 'Da annullare' WHERE id = 'f0000000-0000-4000-8000-0000000000a1';
ROLLBACK TO SAVEPOINT prova;
DO $$ BEGIN
  ASSERT NOT EXISTS (SELECT 1 FROM nostre WHERE dopo ->> 'name' = 'Da annullare'), 'un savepoint annullato non lascia niente';
END $$;

-- roster: solo nomi; i codici sanitari mai, né da soli né nei riepiloghi
INSERT INTO public.roster_drivers (id, name) VALUES ('f0000000-0000-4000-8000-0000000000d1', 'Conducente Prova');
INSERT INTO public.roster_entries (driver_id, day, code, category)
VALUES ('f0000000-0000-4000-8000-0000000000d1', current_date, 'MA', 'assenza');
UPDATE public.roster_entries SET code = 'MA3' WHERE driver_id = 'f0000000-0000-4000-8000-0000000000d1';
INSERT INTO public.roster_entries (driver_id, day, code, category)
SELECT 'f0000000-0000-4000-8000-0000000000d1', current_date + g, 'PAD', 'assenza' FROM generate_series(1, 60) g;
DELETE FROM public.roster_entries WHERE driver_id = 'f0000000-0000-4000-8000-0000000000d1' AND code = 'MA3';
UPDATE public.roster_drivers SET name = 'Conducente Due', versione = versione + 1 WHERE id = 'f0000000-0000-4000-8000-0000000000d1';
:somma
DO $$ BEGIN
  ASSERT (SELECT count(*) FROM nostre WHERE tabella LIKE 'public.roster%') >= 5, 'il roster si registra';
  ASSERT NOT EXISTS (SELECT 1 FROM nostre m WHERE m.tabella LIKE 'public.roster%' AND (m.prima IS NOT NULL OR m.dopo IS NOT NULL)),
    'roster e anagrafica senza valori';
  ASSERT NOT EXISTS (SELECT 1 FROM nostre m WHERE m::text ~ '"(MA|MA3|PAD|I)"|Conducente'), 'nessun codice sanitario, nessun nome';
  ASSERT (SELECT campi FROM nostre WHERE tabella = 'public.roster_entries' AND operazione = 'UPDATE') = '{code}',
    'un codice cambiato: il nome del campo';
  ASSERT (SELECT campi FROM nostre WHERE tabella = 'public.roster_drivers' AND operazione = 'UPDATE') = '{name}',
    'la versione del conducente non conta';
END $$;

-- ── la seconda ondata (0007) ─────────────────────────────────────────────
-- Gli orari di dettaglio sono sempre in riepilogo e senza valori: l'app li
-- salva cancellando tutto e reinserendo una riga per fermata.
INSERT INTO public.ps_routes (id, project_id, short_name)
VALUES ('f0000000-0000-4000-8000-0000000000b1', 'f0000000-0000-4000-8000-0000000000a1', '1');
INSERT INTO public.ps_route_variants (id, project_id, route_id, name)
VALUES ('f0000000-0000-4000-8000-0000000000b2', 'f0000000-0000-4000-8000-0000000000a1', 'f0000000-0000-4000-8000-0000000000b1', 'Andata');
INSERT INTO public.ps_calendars (id, project_id, code, start_date, end_date)
VALUES ('f0000000-0000-4000-8000-0000000000b3', 'f0000000-0000-4000-8000-0000000000a1', 'FER', '2026-01-01', '2026-12-31');
INSERT INTO public.ps_trips (id, project_id, route_id, variant_id)
VALUES ('f0000000-0000-4000-8000-0000000000c1', 'f0000000-0000-4000-8000-0000000000a1', 'f0000000-0000-4000-8000-0000000000b1', 'f0000000-0000-4000-8000-0000000000b2'),
       ('f0000000-0000-4000-8000-0000000000c2', 'f0000000-0000-4000-8000-0000000000a1', 'f0000000-0000-4000-8000-0000000000b1', 'f0000000-0000-4000-8000-0000000000b2');
CREATE TEMP TABLE fermate_prova AS
SELECT row_number() OVER (ORDER BY x.name)::int AS f, x.id
  FROM (SELECT id, name FROM public.ps_stops WHERE project_id = 'f0000000-0000-4000-8000-0000000000a1' AND name ~ '^F[0-9]+$' ORDER BY name LIMIT 30) x;
-- come PUT /trips/:id/stop-times
CREATE FUNCTION pg_temp.salva_orari(corsa uuid, ora text) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE r record;
BEGIN
  DELETE FROM public.ps_stop_times WHERE trip_id = corsa;
  FOR r IN SELECT f, id FROM fermate_prova ORDER BY f LOOP
    INSERT INTO public.ps_stop_times (trip_id, stop_seq, stop_id, arrival_time, departure_time)
    VALUES (corsa, r.f, r.id, ora || ':' || lpad(r.f::text, 2, '0') || ':00', ora || ':' || lpad(r.f::text, 2, '0') || ':30');
  END LOOP;
END $f$;
DO $$ BEGIN PERFORM pg_temp.salva_orari('f0000000-0000-4000-8000-0000000000c1', '07'); END $$;
:somma
DO $$
DECLARE r record;
BEGIN
  ASSERT (SELECT count(*) FROM nostre WHERE tabella = 'public.ps_stop_times') = 1, 'gli orari di una corsa: un riepilogo (il DELETE a vuoto non scrive)';
  SELECT * INTO r FROM nostre WHERE tabella = 'public.ps_stop_times' AND operazione = 'INSERT';
  ASSERT r.riepilogo AND r.righe = 30 AND r.ambito_tipo = 'corsa' AND r.ambito_id = 'f0000000-0000-4000-8000-0000000000c1'
         AND r.chiave IS NULL AND r.prima IS NULL AND r.dopo IS NULL AND r.campi IS NULL AND NOT r.a_cascata
         AND jsonb_array_length(r.campione) = 20
         AND r.campione -> 0 = '{"trip_id": "f0000000-0000-4000-8000-0000000000c1", "stop_seq": 1}'::jsonb
         AND r.attore = 'a0000000-0000-4000-8000-0000000000aa' AND r.via = 'api' AND r.ruolo_db = session_user,
    format('orari di una corsa: %s', row_to_json(r));
END $$;
-- la stessa corsa salvata di nuovo, poi un'altra: i riepiloghi della transazione si sommano
DO $$ BEGIN PERFORM pg_temp.salva_orari('f0000000-0000-4000-8000-0000000000c1', '08'); END $$;
:somma
DO $$ BEGIN
  ASSERT (SELECT righe = 30 AND ambito_id = 'f0000000-0000-4000-8000-0000000000c1' AND NOT a_cascata FROM nostre
           WHERE tabella = 'public.ps_stop_times' AND operazione = 'DELETE'), 'la seconda volta il DELETE toglie 30 righe';
  ASSERT (SELECT righe = 60 AND ambito_id = 'f0000000-0000-4000-8000-0000000000c1' FROM nostre
           WHERE tabella = 'public.ps_stop_times' AND operazione = 'INSERT'), 'gli inserimenti si sommano, la corsa è sempre quella';
END $$;
DO $$ BEGIN PERFORM pg_temp.salva_orari('f0000000-0000-4000-8000-0000000000c2', '09'); END $$;
-- «sposta orari»: un UPDATE per fermata; uno che non cambia niente non conta;
-- quelli di un savepoint annullato nemmeno
UPDATE public.ps_stop_times SET arrival_time = '09:59:00' WHERE trip_id = 'f0000000-0000-4000-8000-0000000000c2' AND stop_seq = 1;
UPDATE public.ps_stop_times SET arrival_time = '09:59:00' WHERE trip_id = 'f0000000-0000-4000-8000-0000000000c2' AND stop_seq = 2;
UPDATE public.ps_stop_times SET arrival_time = '09:59:00' WHERE trip_id = 'f0000000-0000-4000-8000-0000000000c2' AND stop_seq = 3;
UPDATE public.ps_stop_times SET arrival_time = arrival_time WHERE trip_id = 'f0000000-0000-4000-8000-0000000000c2' AND stop_seq = 4;
SAVEPOINT orari;
UPDATE public.ps_stop_times SET departure_time = '10:00:00' WHERE trip_id = 'f0000000-0000-4000-8000-0000000000c2' AND stop_seq = 5;
UPDATE public.ps_stop_times SET departure_time = '10:00:00' WHERE trip_id = 'f0000000-0000-4000-8000-0000000000c1';
ROLLBACK TO SAVEPOINT orari;
INSERT INTO public.ps_variant_stops (variant_id, seq, stop_id)
SELECT 'f0000000-0000-4000-8000-0000000000b2', f, id FROM fermate_prova WHERE f <= 2;
INSERT INTO public.ps_calendar_dates (calendar_id, date, exception_type) VALUES ('f0000000-0000-4000-8000-0000000000b3', '2026-12-25', 2);
:somma
DO $$
DECLARE r record;
BEGIN
  ASSERT (SELECT righe = 90 AND ambito_id IS NULL FROM nostre WHERE tabella = 'public.ps_stop_times' AND operazione = 'INSERT'),
    'due corse nella stessa transazione: niente ambito';
  SELECT * INTO r FROM nostre WHERE tabella = 'public.ps_stop_times' AND operazione = 'UPDATE';
  ASSERT r.riepilogo AND r.righe = 3 AND r.campi = '{arrival_time}' AND r.ambito_id = 'f0000000-0000-4000-8000-0000000000c2'
         AND jsonb_array_length(r.campione) = 3, format('sposta orari: %s', row_to_json(r));
  ASSERT NOT EXISTS (SELECT 1 FROM nostre m WHERE m.tabella IN ('public.ps_stop_times', 'public.ps_variant_stops', 'public.ps_calendar_dates')
                        AND (NOT m.riepilogo OR m.prima IS NOT NULL OR m.dopo IS NOT NULL OR m.chiave IS NOT NULL
                             OR m.campione::text ~ '[0-9]{2}:[0-9]{2}')),
    'gli orari di dettaglio: solo riepiloghi, mai un valore';
  ASSERT (SELECT righe = 2 AND ambito_tipo = 'variante' AND ambito_id = 'f0000000-0000-4000-8000-0000000000b2' FROM nostre
           WHERE tabella = 'public.ps_variant_stops'), 'le fermate di una variante';
  ASSERT (SELECT righe = 1 AND ambito_tipo = 'calendario' AND ambito_id = 'f0000000-0000-4000-8000-0000000000b3'
                 AND campione -> 0 = '{"calendar_id": "f0000000-0000-4000-8000-0000000000b3", "date": "2026-12-25"}'::jsonb
            FROM nostre WHERE tabella = 'public.ps_calendar_dates'), 'le eccezioni di un calendario';
END $$;
-- tracciati, periodi, nodi, zone vietate, attivazioni programmate: coi valori
-- (geometrie e poligoni solo come nome, chi ha programmato solo come nome)
INSERT INTO public.ps_service_periods (id, project_id, code, name, start_date, end_date)
VALUES ('f0000000-0000-4000-8000-0000000000e1', 'f0000000-0000-4000-8000-0000000000a1', 'INV', 'Invernale', '2026-09-15', '2027-06-10');
UPDATE public.ps_service_periods SET name = 'Invernale scolastico' WHERE id = 'f0000000-0000-4000-8000-0000000000e1';
INSERT INTO public.ps_stop_clusters (id, project_id, name) VALUES ('f0000000-0000-4000-8000-0000000000e2', 'f0000000-0000-4000-8000-0000000000a1', 'Stazione');
INSERT INTO public.ps_no_go_zones (id, project_id, name, polygon)
VALUES ('f0000000-0000-4000-8000-0000000000e3', 'f0000000-0000-4000-8000-0000000000a1', 'Centro storico', '{"type": "Polygon", "coordinates": []}');
INSERT INTO public.ps_shapes (id, project_id, variant_id, mode, geometry)
VALUES ('f0000000-0000-4000-8000-0000000000e4', 'f0000000-0000-4000-8000-0000000000a1', 'f0000000-0000-4000-8000-0000000000b2', 'manual', '{"type": "LineString", "coordinates": [[13.5, 43.6]]}');
INSERT INTO public.gtfs_feeds (id, filename) VALUES ('f0000000-0000-4000-8000-0000000000fd', 'prova-registro.zip');
INSERT INTO public.ps_pending_activations (id, project_id, feed_id, user_id, effective_from, via)
VALUES ('f0000000-0000-4000-8000-0000000000e5', 'f0000000-0000-4000-8000-0000000000a1', 'f0000000-0000-4000-8000-0000000000fd', 'f0000000-0000-4000-8000-000000000001', current_date + 7, 'argos:mcp');
DO $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM nostre WHERE tabella = 'public.ps_service_periods' AND operazione = 'UPDATE';
  ASSERT r.campi = '{name}' AND r.prima = '{"name": "Invernale"}' AND r.dopo = '{"name": "Invernale scolastico"}'
         AND r.ambito_tipo = 'progetto_ps' AND r.ambito_id = 'f0000000-0000-4000-8000-0000000000a1', format('periodo di servizio: %s', row_to_json(r));
  ASSERT (SELECT dopo ->> 'name' = 'Stazione' FROM nostre WHERE tabella = 'public.ps_stop_clusters'), 'nodo di interscambio';
  ASSERT (SELECT dopo ->> 'name' = 'Centro storico' AND NOT dopo ? 'polygon' FROM nostre WHERE tabella = 'public.ps_no_go_zones'),
    'zona vietata: il poligono solo come nome';
  ASSERT (SELECT dopo ->> 'mode' = 'manual' AND NOT dopo ? 'geometry' AND NOT dopo ? 'waypoints' FROM nostre WHERE tabella = 'public.ps_shapes'),
    'tracciato: la geometria solo come nome';
  SELECT * INTO r FROM nostre WHERE tabella = 'public.ps_pending_activations';
  ASSERT r.dopo ->> 'via' = 'argos:mcp' AND r.dopo ? 'effective_from' AND r.dopo ->> 'feed_id' = 'f0000000-0000-4000-8000-0000000000fd'
         AND NOT r.dopo ? 'user_id', format('attivazione programmata: %s', row_to_json(r));
END $$;

-- cancellare il programma: le fermate se ne vanno in cascata, in un riepilogo.
-- Come fa l'app, prima gli orari e le fermate delle varianti (le loro chiavi
-- verso le fermate sono RESTRICT); il resto lo portano via le cascate.
DELETE FROM public.ps_stop_times WHERE trip_id IN (SELECT id FROM public.ps_trips WHERE project_id = 'f0000000-0000-4000-8000-0000000000a1');
DELETE FROM public.ps_variant_stops WHERE variant_id IN (SELECT id FROM public.ps_route_variants WHERE project_id = 'f0000000-0000-4000-8000-0000000000a1');
DELETE FROM public.ps_projects WHERE id = 'f0000000-0000-4000-8000-0000000000a1';
:somma
DO $$
DECLARE r record;
BEGIN
  ASSERT (SELECT righe = 90 AND ambito_id IS NULL FROM nostre WHERE tabella = 'public.ps_stop_times' AND operazione = 'DELETE' AND NOT a_cascata),
    'gli orari cancellati: 30 del secondo salvataggio più 60';
  ASSERT (SELECT righe = 1 AND a_cascata FROM nostre WHERE tabella = 'public.ps_calendar_dates' AND operazione = 'DELETE'),
    'le eccezioni del calendario se ne vanno in cascata';
  ASSERT (SELECT righe = 2 AND a_cascata FROM nostre WHERE tabella = 'public.ps_trips' AND operazione = 'DELETE'), 'le corse in cascata';
  ASSERT (SELECT bool_and(a_cascata AND riepilogo) AND count(*) = 4 FROM nostre
           WHERE operazione = 'DELETE' AND tabella IN ('public.ps_service_periods', 'public.ps_stop_clusters', 'public.ps_shapes', 'public.ps_pending_activations')),
    'periodi, nodi, tracciati e attivazioni in cascata';
  SELECT * INTO r FROM nostre WHERE tabella = 'public.ps_stops' AND operazione = 'DELETE';
  ASSERT FOUND AND r.riepilogo AND r.a_cascata AND r.righe = 561, format('cascata: %s', row_to_json(r));
  SELECT * INTO r FROM nostre WHERE tabella = 'public.ps_projects' AND operazione = 'DELETE';
  ASSERT r.prima ->> 'name' = 'Programma prova bis' AND NOT r.riepilogo, format('il programma cancellato: %s', row_to_json(r));
END $$;

-- TRUNCATE: una riga
TRUNCATE public.app_settings;
DO $$ BEGIN
  ASSERT EXISTS (SELECT 1 FROM nostre WHERE tabella = 'public.app_settings' AND operazione = 'TRUNCATE'), 'TRUNCATE registrato';
END $$;

-- ── la lettura (0007): registro.leggi() ─────────────────────────────────
-- Dal più recente, a pagine, col cursore; filtri solo per periodo, tabella,
-- operazione e ambito che non sia una persona; ogni chiamata lascia una riga
-- in registro.letture.
INSERT INTO registro.modifiche (ts, transazione, attore, via, ruolo_db, tabella, operazione, chiave, riepilogo, righe, a_cascata)
SELECT now() - make_interval(mins => g / 3), (1000 + g / 3)::text::xid8, 'a-lettura', 'api', 'cerbero_app', 'public.prova_lettura', 'UPDATE',
       jsonb_build_object('id', g), false, 1, false
  FROM generate_series(1, 25) g;
DO $$
DECLARE
  cerca   jsonb := '{"tabella": "public.prova_lettura"}';
  tutte   text[];
  viste   text[] := '{}';
  r       record;
  c_ts    text;
  c_tx    text;
  salta   integer := 0;
  n       integer;
  prima_  bigint := (SELECT count(*) FROM registro.letture);
BEGIN
  SELECT array_agg(l.chiave ->> 'id' ORDER BY l.ordinality) INTO tutte FROM registro.leggi(cerca, 200, 0) WITH ORDINALITY AS l;
  ASSERT cardinality(tutte) = 25 AND tutte[1] IN ('1', '2') AND tutte[25] IN ('24', '25'), format('dal più recente: %s', tutte);
  -- a pagine da 7, come fa l'API: il cursore è l'ultima riga vista, il salto le righe già viste di quella transazione
  LOOP
    n := 0;
    FOR r IN SELECT * FROM registro.leggi(cerca || CASE WHEN c_ts IS NULL THEN '{}'::jsonb
                                                         ELSE jsonb_build_object('cursore_ts', c_ts, 'cursore_transazione', c_tx) END, 7, salta) LOOP
      n := n + 1;
      viste := viste || (r.chiave ->> 'id');
      IF r.ts_esatto = c_ts AND r.transazione = c_tx THEN
        salta := salta + 1;
      ELSE
        c_ts := r.ts_esatto; c_tx := r.transazione; salta := 1;
      END IF;
    END LOOP;
    EXIT WHEN n < 7;
  END LOOP;
  ASSERT viste = tutte, format('le pagine danno le stesse righe, una volta sola e nello stesso ordine: %s contro %s', viste, tutte);
  -- ogni chiamata è annotata: chi, con quali filtri, quante righe
  ASSERT (SELECT count(*) FROM registro.letture) = prima_ + 5, 'una riga per consultazione (1 + 4 pagine)';
  ASSERT (SELECT attore = 'a0000000-0000-4000-8000-0000000000aa' AND via = 'api' AND richiesta = 'r-registro' AND ruolo_db = session_user
                 AND filtri = '{"tabella": "public.prova_lettura"}' AND chieste = 200 AND saltate = 0 AND righe = 25
            FROM registro.letture WHERE chieste = 200 ORDER BY ts DESC LIMIT 1), 'la consultazione annotata';
  -- i filtri
  ASSERT (SELECT count(*) = (SELECT count(*) FROM nostre WHERE tabella = 'public.ps_stop_times') AND bool_and(l.tabella = 'public.ps_stop_times')
            FROM registro.leggi('{"tabella": "public.ps_stop_times"}', 200, 0) l), 'filtro per tabella';
  ASSERT (SELECT count(*) = 1 AND bool_and(l.tabella = 'public.app_settings') FROM registro.leggi('{"operazione": "TRUNCATE"}', 200, 0) l), 'filtro per operazione';
  ASSERT (SELECT count(*) = 1 AND bool_and(l.operazione = 'UPDATE' AND l.riepilogo AND l.righe = 3)
            FROM registro.leggi('{"ambito_tipo": "corsa", "ambito_id": "f0000000-0000-4000-8000-0000000000c2"}', 200, 0) l), 'filtro per ambito';
  ASSERT (SELECT count(*) = 0 FROM registro.leggi(jsonb_build_object('a', now() - interval '2 days'), 200, 0)), 'fuori dal periodo: niente';
  ASSERT (SELECT count(*) > 0 AND bool_and(l.ts >= now() - interval '7 days') FROM registro.leggi('{}', 200, 0) l), 'senza periodo: gli ultimi 7 giorni';
END $$;
-- quello che non si può chiedere: una persona, troppe righe, troppo tempo
DO $$
DECLARE prova text;
BEGIN
  FOREACH prova IN ARRAY ARRAY[
    $q$SELECT * FROM registro.leggi('{"attore": "a0000000-0000-4000-8000-0000000000aa"}', 10, 0)$q$,
    $q$SELECT * FROM registro.leggi('{"chiave": "x"}', 10, 0)$q$,
    $q$SELECT * FROM registro.leggi('{"ambito_tipo": "utente", "ambito_id": "f0000000-0000-4000-8000-000000000001"}', 10, 0)$q$,
    $q$SELECT * FROM registro.leggi('{"ambito_tipo": "conducente", "ambito_id": "f0000000-0000-4000-8000-0000000000d1"}', 10, 0)$q$,
    $q$SELECT * FROM registro.leggi('{"ambito_id": "f0000000-0000-4000-8000-0000000000a1"}', 10, 0)$q$,
    $q$SELECT * FROM registro.leggi('{}', 0, 0)$q$,
    $q$SELECT * FROM registro.leggi('{}', 201, 0)$q$,
    $q$SELECT * FROM registro.leggi('{}', 10, 5001)$q$,
    $q$SELECT * FROM registro.leggi('{}', 10, -1)$q$,
    $q$SELECT * FROM registro.leggi(jsonb_build_object('da', now() - interval '93 days'), 10, 0)$q$,
    $q$SELECT * FROM registro.leggi(jsonb_build_object('da', now(), 'a', now() - interval '1 day'), 10, 0)$q$,
    $q$SELECT * FROM registro.leggi('{"cursore_ts": "2026-01-01 00:00:00+00"}', 10, 0)$q$,
    $q$SELECT * FROM registro.leggi('[]', 10, 0)$q$] LOOP
    BEGIN
      EXECUTE prova;
      RAISE EXCEPTION 'registro.leggi doveva rifiutare: %', prova;
    EXCEPTION WHEN invalid_parameter_value THEN NULL;
    END;
  END LOOP;
  -- le persone si possono vedere tutte insieme (per tabella o per tipo di ambito), mai una per una
  PERFORM count(*) FROM registro.leggi('{"ambito_tipo": "conducente"}', 10, 0);
  PERFORM count(*) FROM registro.leggi('{"tabella": "public.users"}', 10, 0);
END $$;
-- lo stato, per la pagina
DO $$
DECLARE st jsonb := registro.stato();
BEGIN
  ASSERT (st ->> 'attivo')::boolean AND st ->> 'base_giuridica' = 'prova' AND (st ->> 'anonimizza_dopo_mesi')::int = 12
         AND jsonb_array_length(st -> 'tabelle') = 29, format('stato: %s', st);
  ASSERT EXISTS (SELECT 1 FROM jsonb_array_elements(st -> 'tabelle') t WHERE t ->> 'tabella' = 'public.ps_stop_times'
                    AND (t ->> 'riepilogo_sempre')::boolean AND NOT (t ->> 'con_valori')::boolean AND t ->> 'ambito_tipo' = 'corsa'),
    'gli orari: sempre in riepilogo, senza valori';
  ASSERT EXISTS (SELECT 1 FROM jsonb_array_elements(st -> 'tabelle') t WHERE t ->> 'tabella' = 'public.users' AND (t ->> 'con_valori')::boolean),
    'gli utenti: qualche valore (ruolo e permessi)';
END $$;

-- l'app (cerbero_owner): non legge le tabelle, non cambia, non svuota, non spegne
DO $$
DECLARE prova text;
BEGIN
  IF pg_catalog.to_regrole('cerbero_owner') IS NULL THEN
    RAISE NOTICE 'registro.test.sql: cerbero_owner non c''è, parte dell''app saltata';
    RETURN;
  END IF;
  EXECUTE 'SET LOCAL ROLE cerbero_owner';
  FOREACH prova IN ARRAY ARRAY[
    'SELECT count(*) FROM registro.modifiche', 'DELETE FROM registro.modifiche', 'TRUNCATE registro.modifiche',
    'UPDATE registro.modifiche SET attore = NULL', 'UPDATE registro.impostazioni SET attivo = false',
    'INSERT INTO registro.modifiche (ts, transazione, ruolo_db, tabella, operazione, riepilogo, a_cascata) VALUES (now(), pg_current_xact_id(), ''x'', ''x'', ''x'', false, false)',
    'ALTER TABLE public.users DISABLE TRIGGER registro_cambia',
    'ALTER TABLE public.users ENABLE REPLICA TRIGGER registro_cambia',
    'ALTER TABLE public.depots RENAME TO depots_altrove',
    'ALTER TABLE public.users RENAME COLUMN role TO role_cached',
    'ALTER TABLE public.users ALTER COLUMN role TYPE text USING ''admin''',
    'CREATE TABLE public.registro_figlia () INHERITS (public.ps_projects)',
    'SELECT registro.sorveglia(''public.users'', ARRAY[''id''], NULL, NULL, true)',
    -- 0007: né le consultazioni, né i parziali, né le funzioni interne
    'SELECT count(*) FROM registro.letture', 'DELETE FROM registro.letture', 'SELECT count(*) FROM registro.impostazioni',
    'SELECT count(*) FROM registro.parziali', 'DELETE FROM registro.parziali',
    'INSERT INTO registro.parziali (ts, transazione, primo, ruolo_db, tabella, operazione, a_cascata, righe) VALUES (now(), pg_current_xact_id(), false, ''x'', ''x'', ''x'', false, 1)',
    'SELECT registro.somma(pg_current_xact_id())',
    'SELECT registro.accoda(''public.x'', ''INSERT'', false, 1, NULL, NULL, NULL, NULL, ARRAY[''a'', ''b'', ''c'', ''d''])',
    'ALTER TABLE registro.parziali DISABLE TRIGGER registro_chiude'] LOOP
    BEGIN
      EXECUTE prova;
      RAISE EXCEPTION 'l''app non doveva poter: %', prova;
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
  END LOOP;
  -- la manutenzione e la verifica sì; e, dalla 0007, la lettura e lo stato
  PERFORM registro.manutenzione();
  PERFORM count(*) FROM registro.verifica();
  ASSERT (SELECT count(*) FROM registro.leggi('{"tabella": "public.prova_lettura"}', 5, 0)) = 5, 'l''app legge con leggi()';
  ASSERT registro.stato() ? 'attivo', 'l''app chiede lo stato';
  EXECUTE 'RESET ROLE';
END $$;

-- una partizione che manca: la scrittura va nella riserva, la verifica lo dice, la manutenzione la sposta
DO $$
DECLARE mese timestamptz := date_trunc('month', now()) + interval '2 months';
BEGIN
  EXECUTE format('DROP TABLE registro.%I', 'modifiche_' || to_char(mese, 'YYYY_MM'));
  INSERT INTO registro.modifiche (ts, transazione, ruolo_db, tabella, operazione, chiave, riepilogo, a_cascata)
  VALUES (mese + interval '3 days', pg_current_xact_id(), 'cerbero_app', 'public.ps_trips', 'DELETE', '{"id": "z"}', false, false);
  ASSERT EXISTS (SELECT 1 FROM registro.modifiche_altro WHERE chiave = '{"id": "z"}'), 'senza partizione: nella riserva';
  ASSERT EXISTS (SELECT 1 FROM registro.verifica() v WHERE v LIKE '%riserva%'), 'la verifica segnala la riserva';
  ASSERT (registro.manutenzione() ->> 'spostate')::int = 1, 'la manutenzione sposta la riga';
  ASSERT NOT EXISTS (SELECT 1 FROM registro.modifiche_altro), 'la riserva è vuota';
  ASSERT EXISTS (SELECT 1 FROM registro.modifiche WHERE chiave = '{"id": "z"}'), 'la riga c''è ancora';
  ASSERT NOT EXISTS (SELECT 1 FROM registro.verifica()), format('la verifica è pulita: %s', (SELECT string_agg(v, '; ') FROM registro.verifica() v));
END $$;

-- un trigger spento: la verifica lo dice
ALTER TABLE public.depots DISABLE TRIGGER registro_cambia;
DO $$ BEGIN
  ASSERT EXISTS (SELECT 1 FROM registro.verifica() v WHERE v LIKE '%depots%'), 'la verifica vede un trigger spento';
END $$;
ALTER TABLE public.depots ENABLE ALWAYS TRIGGER registro_cambia;

-- anonimizzazione dopo 12 mesi (attore e richiesta via, la modifica resta), conservazione 60 mesi
INSERT INTO registro.modifiche (ts, transazione, richiesta, attore, via, ruolo_db, tabella, operazione, chiave, campi, riepilogo, righe, a_cascata)
VALUES (now() - interval '13 months', pg_current_xact_id(), 'r-vecchia', 'a-vecchio', 'api', 'cerbero_app', 'public.ps_trips', 'UPDATE',
        '{"id": "x"}', '{name}', false, 1, false),
       (now() - interval '61 months', pg_current_xact_id(), 'r-antica', 'a-antico', 'api', 'cerbero_app', 'public.ps_trips', 'UPDATE',
        '{"id": "y"}', '{name}', false, 1, false);
-- 0007: dove chi ha fatto la modifica è anche la riga modificata (la propria
-- password) a 12 mesi se ne vanno anche ambito e chiave; la riga di un altro resta
INSERT INTO registro.modifiche (ts, transazione, attore, via, ruolo_db, origine, tabella, operazione, chiave, ambito_tipo, ambito_id, campi, riepilogo, righe, a_cascata)
VALUES (now() - interval '13 months', pg_current_xact_id(), 'u-se', 'api', 'cerbero_app', 'prova-se', 'public.users', 'UPDATE',
        '{"id": "u-se"}', 'utente', 'u-se', '{password_cambiata_il}', false, 1, false),
       (now() - interval '13 months', pg_current_xact_id(), 'u-admin', 'api', 'cerbero_app', 'prova-altro', 'public.users', 'UPDATE',
        '{"id": "u-altro"}', 'utente', 'u-altro', '{role}', false, 1, false),
       (now() - interval '13 months', pg_current_xact_id(), 'u-se', 'api', 'cerbero_app', 'prova-membri', 'public.ps_project_members', 'INSERT',
        NULL, 'progetto_ps', 'p-1', NULL, true, 2, false);
UPDATE registro.modifiche SET campione = '[{"user_id": "u-se", "project_id": "p-1"}, {"user_id": "u-altro", "project_id": "p-1"}]'
 WHERE origine = 'prova-membri';
-- le consultazioni scadono con il nome di chi modifica
INSERT INTO registro.letture (ts, attore, ruolo_db, filtri, chieste, saltate, righe)
VALUES (now() - interval '13 months', 'u-vecchio', 'cerbero_app', '{}', 10, 0, 0);
-- un parziale di una transazione chiusa senza la somma: la verifica lo dice, la manutenzione lo somma
INSERT INTO registro.parziali (ts, transazione, primo, attore, ruolo_db, tabella, operazione, a_cascata, ambito_tipo, ambito_id, righe, campione)
VALUES (now() - interval '1 hour', '7'::xid8, false, 'a-rimasto', 'cerbero_app', 'public.ps_stop_times', 'INSERT', false, 'corsa', 'c-rimasta', 3, '[{"k": 1}]'),
       (now() - interval '1 hour', '7'::xid8, false, 'a-rimasto', 'cerbero_app', 'public.ps_stop_times', 'INSERT', false, 'corsa', 'c-rimasta', 4, '[{"k": 2}]');
DO $$ BEGIN
  ASSERT EXISTS (SELECT 1 FROM registro.verifica() v WHERE v LIKE '%non sommati%'), 'la verifica vede i parziali rimasti';
  ASSERT (registro.manutenzione() ->> 'riepiloghi_sommati')::int = 1, 'la manutenzione li somma';
  ASSERT (SELECT righe = 7 AND riepilogo AND attore = 'a-rimasto' AND ambito_id = 'c-rimasta' AND campione = '[{"k": 1}, {"k": 2}]'
                 AND ts < now() - interval '59 minutes'
            FROM registro.modifiche WHERE transazione = '7'::xid8), 'il riepilogo rimasto, con la sua transazione e la sua ora';
  ASSERT NOT EXISTS (SELECT 1 FROM registro.parziali WHERE transazione = '7'::xid8), 'i parziali sommati non restano';
  ASSERT NOT EXISTS (SELECT 1 FROM registro.verifica() v WHERE v LIKE '%non sommati%'), 'la verifica non li segnala più';
  ASSERT (SELECT attore IS NULL AND ambito_id IS NULL AND chiave IS NULL AND campi = '{password_cambiata_il}'
            FROM registro.modifiche WHERE origine = 'prova-se'), 'chi cambia la propria riga: a 12 mesi via anche ambito e chiave';
  ASSERT (SELECT attore IS NULL AND ambito_id = 'u-altro' AND chiave = '{"id": "u-altro"}'
            FROM registro.modifiche WHERE origine = 'prova-altro'), 'la riga di un altro: resta di chi è';
  ASSERT (SELECT attore IS NULL AND campione IS NULL AND ambito_id = 'p-1' AND righe = 2
            FROM registro.modifiche WHERE origine = 'prova-membri'), 'un campione che nomina chi l''ha fatto: via';
  ASSERT NOT EXISTS (SELECT 1 FROM registro.letture WHERE attore = 'u-vecchio'), 'le consultazioni vecchie: via';
  ASSERT (SELECT count(*) FROM registro.letture) > 0, 'le consultazioni recenti restano';
END $$;
DO $$ BEGIN
  ASSERT (SELECT attore IS NULL AND richiesta IS NULL AND via = 'api' AND campi = '{name}'
            FROM registro.modifiche WHERE chiave = '{"id": "x"}'), 'dopo 12 mesi: niente attore né richiesta, la modifica resta';
  ASSERT NOT EXISTS (SELECT 1 FROM registro.modifiche WHERE chiave = '{"id": "y"}'), 'dopo 60 mesi: via';
  ASSERT (SELECT count(*) FROM nostre WHERE attore = 'a0000000-0000-4000-8000-0000000000aa') > 0, 'le righe recenti tengono l''attore';
END $$;

-- le impostazioni: mai meno di 6 mesi, mai acceso senza base giuridica
DO $$ BEGIN
  BEGIN
    UPDATE registro.impostazioni SET anonimizza_dopo_mesi = 3;
    RAISE EXCEPTION 'anonimizzazione a 3 mesi accettata';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE registro.impostazioni SET base_giuridica = '';
    RAISE EXCEPTION 'acceso senza base giuridica';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;

:somma
DO $$ BEGIN
  ASSERT NOT EXISTS (SELECT 1 FROM registro.parziali), 'dopo la somma non resta nessun parziale';
END $$;

DO $$ BEGIN RAISE WARNING 'registro.test.sql: tutto ok'; END $$;
ROLLBACK;
