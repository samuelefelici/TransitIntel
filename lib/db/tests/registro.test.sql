-- ============================================================
-- Il registro delle modifiche (migrazione 0006, PR 2.10)
--   psql "$URL_DI_POSTGRES" -v ON_ERROR_STOP=1 -f lib/db/tests/registro.test.sql
-- Tutto in una transazione che alla fine si annulla: il database resta com'era
-- (anche il registro, che in produzione nasce spento, si accende solo qui dentro).
-- Controlla le regole del 25/10: chi, quando, quale riga, quali campi; i valori
-- solo per programmi, orari, turni e tariffe; utenti, roster e anagrafica solo
-- coi nomi dei campi (degli utenti ruolo e permessi col valore); mai un hash,
-- un segreto della verifica, un codice sanitario; un login non scrive niente;
-- riepiloghi per le istruzioni grandi, le cascate e il modo «riepilogo»; l'app
-- non lo legge, non lo cambia, non lo spegne; anonimizzazione e conservazione.
-- ============================================================
\set ON_ERROR_STOP 1
\set QUIET 1
\pset tuples_only on
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL client_min_messages = warning;

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

-- utenti: l'ultimo accesso e i contatori non scrivono; la password solo come nome; ruolo e permessi col valore
UPDATE public.users SET last_login_at = now(), sessione_versione = sessione_versione + 1, mfa_errori = 1
 WHERE id = 'f0000000-0000-4000-8000-000000000001';
DO $$ BEGIN ASSERT (SELECT count(*) FROM nostre) = 0, 'un login (ultimo accesso, contatori) non scrive'; END $$;
UPDATE public.users SET password_hash = '$2b$12$UNHASHSEGRETISSIMO', mfa_segreto = 'SEGRETOMFA'
 WHERE id = 'f0000000-0000-4000-8000-000000000001';
UPDATE public.users SET role = 'admin', full_name = 'Prova Due' WHERE id = 'f0000000-0000-4000-8000-000000000001';
DO $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM nostre WHERE tabella = 'public.users' AND campi = '{password_hash}';
  ASSERT FOUND, 'il cambio di password si registra col solo nome';
  ASSERT r.prima IS NULL AND r.dopo IS NULL, 'il cambio di password non ha valori';
  ASSERT r.attore = 'a0000000-0000-4000-8000-0000000000aa' AND r.via = 'api' AND r.richiesta = 'r-registro'
         AND r.ruolo_db = session_user AND r.chiave = '{"id": "f0000000-0000-4000-8000-000000000001"}'
         AND r.ambito_tipo = 'utente' AND NOT r.riepilogo, format('chi e dove: %s', row_to_json(r));
  SELECT * INTO r FROM nostre WHERE tabella = 'public.users' AND 'role' = ANY (campi);
  ASSERT r.campi = '{full_name,role}' AND r.prima = '{"role": "user"}' AND r.dopo = '{"role": "admin"}',
    format('ruolo col valore, nome senza: %s', row_to_json(r));
  ASSERT NOT EXISTS (SELECT 1 FROM nostre m WHERE m::text ~ 'UNHASHSEGRETISSIMO|SEGRETOMFA|mfa_'),
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

-- 501 righe: un riepilogo; altre 60 nella stessa transazione: lo stesso riepilogo
INSERT INTO public.ps_stops (project_id, name, lat, lon)
SELECT 'f0000000-0000-4000-8000-0000000000a1', 'F' || g, 43.6, 13.5 FROM generate_series(1, 501) g;
INSERT INTO public.ps_stops (project_id, name, lat, lon)
SELECT 'f0000000-0000-4000-8000-0000000000a1', 'G' || g, 43.6, 13.5 FROM generate_series(1, 60) g;
DO $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM nostre WHERE tabella = 'public.ps_stops' AND operazione = 'INSERT';
  ASSERT (SELECT count(*) FROM nostre WHERE tabella = 'public.ps_stops' AND operazione = 'INSERT') = 1, 'un solo riepilogo';
  ASSERT r.riepilogo AND r.righe = 561 AND jsonb_array_length(r.campione) = 20 AND r.chiave IS NULL
         AND r.ambito_id = 'f0000000-0000-4000-8000-0000000000a1' AND NOT r.a_cascata, format('riepilogo: %s', row_to_json(r));
END $$;

-- 50 righe in un UPDATE: una riga per record; il modo «riepilogo» le raccoglie anche se poche
UPDATE public.ps_stops SET name = name || '!' WHERE name LIKE 'G%' AND name::text ~ '^G([1-9]|[1-4][0-9]|50)$';
DO $$ BEGIN PERFORM set_config('cerbero.registro', 'riepilogo', true); END $$;
UPDATE public.ps_stops SET lat = 43.7 WHERE name = 'F1';
DO $$ BEGIN PERFORM set_config('cerbero.registro', '', true); END $$;
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
DO $$ BEGIN
  ASSERT (SELECT righe = 60 AND campi = '{prova_j,prova_p,prova_x}' FROM nostre
           WHERE tabella = 'public.depots' AND operazione = 'UPDATE' AND riepilogo), 'UPDATE grande su json[], point, xml';
END $$;
ROLLBACK TO SAVEPOINT tipi;

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

-- cancellare il programma: le fermate se ne vanno in cascata, in un riepilogo
DELETE FROM public.ps_projects WHERE id = 'f0000000-0000-4000-8000-0000000000a1';
DO $$
DECLARE r record;
BEGIN
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

-- l'app (cerbero_owner): non legge, non cambia, non svuota, non spegne
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
    'SELECT registro.sorveglia(''public.users'', ARRAY[''id''], NULL, NULL, true)'] LOOP
    BEGIN
      EXECUTE prova;
      RAISE EXCEPTION 'l''app non doveva poter: %', prova;
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
  END LOOP;
  -- la manutenzione e la verifica sì
  PERFORM registro.manutenzione();
  PERFORM count(*) FROM registro.verifica();
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
DO $$ BEGIN PERFORM registro.manutenzione(); END $$;
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

DO $$ BEGIN RAISE WARNING 'registro.test.sql: tutto ok'; END $$;
ROLLBACK;
