-- ============================================================
-- La riga dell'azienda scritta dalla migrazione 0014 (PR 2.17a).
--   psql "$URL_DI_POSTGRES" -v ON_ERROR_STOP=1 -f lib/db/tests/azienda.test.sql
-- Da lanciare dalla radice del repository (include il file della migrazione),
-- su un database già migrato e SENZA utenti (un database nuovo). Tutto in una
-- transazione che alla fine si annulla: il database resta com'era.
--
-- La migrazione scrive la riga di Conerobus solo se il database è già in uso
-- (ha utenti): è l'installazione che esiste. Un database nuovo resta con la
-- tabella vuota, e l'app usa valori neutri finché l'amministratore non compila
-- la pagina: un'installazione nuova non nasce col nome di un'altra azienda.
-- ============================================================
\set ON_ERROR_STOP 1
\set QUIET 1
\pset tuples_only on
BEGIN;
SET LOCAL client_min_messages = error;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.users) THEN
    RAISE EXCEPTION 'azienda.test.sql va lanciato su un database senza utenti';
  END IF;
  -- database nuovo: la migrazione è già passata e la tabella è vuota
  IF EXISTS (SELECT 1 FROM public.azienda) THEN
    RAISE EXCEPTION 'su un database senza utenti la 0014 ha scritto lo stesso una riga';
  END IF;
END $$;

-- rilanciata su un database ancora senza utenti: ancora niente
\i lib/db/migrations/0014_azienda.sql
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.azienda) THEN
    RAISE EXCEPTION 'rilanciata su un database senza utenti la 0014 ha scritto una riga';
  END IF;
END $$;

-- un database già in uso: c'è almeno un utente
INSERT INTO public.users (id, email, password_hash, role, active)
VALUES ('c5000000-0000-4000-8000-000000000001', 'prova-azienda@prova.local', 'x', 'admin', true);
\i lib/db/migrations/0014_azienda.sql
DO $$
DECLARE r public.azienda;
BEGIN
  SELECT * INTO r FROM public.azienda;
  IF NOT FOUND THEN RAISE EXCEPTION 'su un database in uso la 0014 non ha scritto la riga dell''azienda'; END IF;
  -- i valori che il codice aveva fino alla 2.17a: per chi la usa già non cambia niente
  IF (r.ragione_sociale, r.nome, r.sito, r.telefono, r.gtfs_agency_id, r.citta, r.regione, r.centro_lat, r.centro_lng, r.zoom)
     IS DISTINCT FROM ('Conerobus S.p.A.'::text, 'Conerobus'::text, 'https://www.conerobus.it'::text, '+39 071 2837411'::text,
                       'conerobus'::text, 'Ancona'::text, 'Marche'::text, 43.58::double precision, 13.45::double precision, 10::real) THEN
    RAISE EXCEPTION 'la riga scritta dalla 0014 non ha i valori che erano nel codice: %', pg_catalog.row_to_json(r);
  END IF;
  IF r.aggiornata_da IS NOT NULL THEN RAISE EXCEPTION 'la riga della migrazione non l''ha salvata nessun utente'; END IF;
END $$;

-- l'amministratore la cambia; rilanciare la migrazione non la riporta indietro e non ne aggiunge un'altra
UPDATE public.azienda SET nome = 'Altro nome', citta = 'Altra città';
\i lib/db/migrations/0014_azienda.sql
DO $$
DECLARE n bigint; v text;
BEGIN
  SELECT pg_catalog.count(*), pg_catalog.min(nome) INTO n, v FROM public.azienda;
  IF n <> 1 OR v <> 'Altro nome' THEN
    RAISE EXCEPTION 'rilanciata, la 0014 ha toccato la riga dell''amministratore (% righe, nome %)', n, v;
  END IF;
  -- la tabella resta di cerbero_owner (quando il ruolo c'è) e sorvegliata dal registro
  IF pg_catalog.to_regrole('cerbero_owner') IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid = 'public.azienda'::pg_catalog.regclass
          AND c.relowner = pg_catalog.to_regrole('cerbero_owner')) THEN
    RAISE EXCEPTION 'public.azienda non è di cerbero_owner';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM registro.sorvegliate s WHERE s.tabella = 'public.azienda' AND s.con_valori) THEN
    RAISE EXCEPTION 'public.azienda non è sorvegliata dal registro con i valori';
  END IF;
  SELECT pg_catalog.count(*) INTO n FROM pg_catalog.pg_trigger t
   WHERE t.tgrelid = 'public.azienda'::pg_catalog.regclass AND t.tgname LIKE 'registro\_%' AND t.tgenabled = 'A';
  IF n <> 6 THEN RAISE EXCEPTION 'i trigger del registro su public.azienda sono %, non 6', n; END IF;
END $$;
ROLLBACK;
\echo 'azienda: database nuovo senza riga, database in uso con i valori di prima, la riga dell''amministratore non si tocca'
