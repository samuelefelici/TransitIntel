-- ============================================================
-- Le chiavi esterne di Planning Studio (migrazioni 0010, 0011 e 0013, PR 2.15 e 2.15c)
--   psql "$URL_DI_POSTGRES" -v ON_ERROR_STOP=1 -f lib/db/tests/chiavi-esterne.test.sql
-- Tutto in una transazione che alla fine si annulla: il database resta com'era.
-- Come cerbero_owner (il ruolo con cui lavora l'app):
--   - i tre vincoli ci sono e sono validi;
--   - una riga senza padre non si può più scrivere (corsa, progetto, categoria);
--   - cancellare la corsa o il progetto porta via le figlie;
--   - una categoria usata da una corsa non si cancella (RESTRICT): prima va
--     tolta dalle corse. Cancellarla lasciava corse che non valevano più in
--     nessun giorno.
-- ============================================================
\set ON_ERROR_STOP 1
\set QUIET 1
\pset tuples_only on
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL client_min_messages = warning;

DO $$
DECLARE n bigint; d text;
BEGIN
  SELECT pg_catalog.count(*) INTO n FROM pg_catalog.pg_constraint k
   WHERE k.contype = 'f' AND k.convalidated
     AND ((k.conrelid = 'public.ps_trip_category_validity'::regclass AND k.conname = 'ps_trip_category_validity_trip_id_fkey'
           AND pg_catalog.pg_get_constraintdef(k.oid) = 'FOREIGN KEY (trip_id) REFERENCES ps_trips(id) ON DELETE CASCADE')
       OR (k.conrelid = 'public.ps_no_go_zones'::regclass AND k.conname = 'ps_no_go_zones_project_id_fkey'
           AND pg_catalog.pg_get_constraintdef(k.oid) = 'FOREIGN KEY (project_id) REFERENCES ps_projects(id) ON DELETE CASCADE'));
  IF n <> 2 THEN RAISE EXCEPTION 'le due chiavi esterne non ci sono, o non sono valide, o non sono quelle attese (%)', n; END IF;

  -- la chiave sulla categoria (0013): valida, e non cancella a cascata
  SELECT pg_catalog.count(*) INTO n FROM pg_catalog.pg_constraint k
   WHERE k.contype = 'f' AND k.convalidated
     AND k.conrelid = 'public.ps_trip_category_validity'::regclass AND k.conname = 'ps_trip_category_validity_category_id_fkey'
     AND pg_catalog.pg_get_constraintdef(k.oid) = 'FOREIGN KEY (category_id) REFERENCES ps_validity_categories(id) ON DELETE RESTRICT';
  IF n <> 1 THEN RAISE EXCEPTION 'la chiave esterna sulla categoria non c''è, o non è valida, o non è RESTRICT'; END IF;
END $$;

SET LOCAL ROLE cerbero_owner;
INSERT INTO public.ps_projects (id, owner_user_id, name)
VALUES ('c2000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-0000000000ff', 'Prova chiavi esterne');
INSERT INTO public.ps_routes (id, project_id, short_name)
VALUES ('c2000000-0000-4000-8000-000000000002', 'c2000000-0000-4000-8000-000000000001', 'K2');
INSERT INTO public.ps_route_variants (id, project_id, route_id, name)
VALUES ('c2000000-0000-4000-8000-000000000003', 'c2000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000002', 'andata');
INSERT INTO public.ps_trips (id, project_id, route_id, variant_id)
VALUES ('c2000000-0000-4000-8000-000000000004', 'c2000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000002', 'c2000000-0000-4000-8000-000000000003'),
       ('c2000000-0000-4000-8000-000000000005', 'c2000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000002', 'c2000000-0000-4000-8000-000000000003');
INSERT INTO public.ps_validity_categories (id, code, name, color)
VALUES ('c2000000-0000-4000-8000-000000000006', 'prova_chiavi_esterne_2', 'Prova chiavi esterne', '#000000');
INSERT INTO public.ps_trip_category_validity (trip_id, category_id)
VALUES ('c2000000-0000-4000-8000-000000000004', 'c2000000-0000-4000-8000-000000000006'),
       ('c2000000-0000-4000-8000-000000000005', 'c2000000-0000-4000-8000-000000000006');
INSERT INTO public.ps_no_go_zones (project_id, name, polygon)
VALUES ('c2000000-0000-4000-8000-000000000001', 'zona', '[]'::jsonb);

DO $$
DECLARE n bigint; rifiutata boolean;
BEGIN
  -- una riga per una corsa che non esiste: rifiutata
  rifiutata := false;
  BEGIN
    INSERT INTO public.ps_trip_category_validity (trip_id, category_id)
    VALUES ('c2000000-0000-4000-8000-0000000000aa', 'c2000000-0000-4000-8000-000000000006');
  EXCEPTION WHEN foreign_key_violation THEN rifiutata := true;
  END;
  IF NOT rifiutata THEN RAISE EXCEPTION 'una categoria per una corsa che non esiste è stata accettata'; END IF;

  -- una categoria che non esiste: rifiutata (prima restava sulla corsa una riga che punta nel vuoto)
  rifiutata := false;
  BEGIN
    INSERT INTO public.ps_trip_category_validity (trip_id, category_id)
    VALUES ('c2000000-0000-4000-8000-000000000004', 'c2000000-0000-4000-8000-0000000000cc');
  EXCEPTION WHEN foreign_key_violation THEN rifiutata := true;
  END;
  IF NOT rifiutata THEN RAISE EXCEPTION 'una categoria che non esiste è stata accettata su una corsa'; END IF;

  -- una categoria usata da una corsa non si cancella
  rifiutata := false;
  BEGIN
    DELETE FROM public.ps_validity_categories WHERE id = 'c2000000-0000-4000-8000-000000000006';
  EXCEPTION WHEN foreign_key_violation THEN rifiutata := true;
  END;
  IF NOT rifiutata THEN RAISE EXCEPTION 'una categoria in uso è stata cancellata'; END IF;

  -- una zona per un progetto che non esiste: rifiutata
  rifiutata := false;
  BEGIN
    INSERT INTO public.ps_no_go_zones (project_id, name, polygon)
    VALUES ('c2000000-0000-4000-8000-0000000000ab', 'zona', '[]'::jsonb);
  EXCEPTION WHEN foreign_key_violation THEN rifiutata := true;
  END;
  IF NOT rifiutata THEN RAISE EXCEPTION 'una zona vietata per un progetto che non esiste è stata accettata'; END IF;

  -- cancellare UNA corsa porta via le sue categorie, non quelle dell'altra
  DELETE FROM public.ps_trips WHERE id = 'c2000000-0000-4000-8000-000000000004';
  SELECT pg_catalog.count(*) INTO n FROM public.ps_trip_category_validity
   WHERE trip_id IN ('c2000000-0000-4000-8000-000000000004', 'c2000000-0000-4000-8000-000000000005');
  IF n <> 1 THEN RAISE EXCEPTION 'cancellata una corsa: attesa 1 riga di categorie (dell''altra corsa), trovate %', n; END IF;

  -- cancellare il progetto porta via le zone; le corse si tolgono prima (un
  -- percorso non si cancella finché ha corse: lo fa così anche l'API), e con
  -- loro se ne vanno le categorie rimaste
  DELETE FROM public.ps_trips WHERE project_id = 'c2000000-0000-4000-8000-000000000001';
  DELETE FROM public.ps_projects WHERE id = 'c2000000-0000-4000-8000-000000000001';
  SELECT (SELECT pg_catalog.count(*) FROM public.ps_trip_category_validity WHERE trip_id = 'c2000000-0000-4000-8000-000000000005')
       + (SELECT pg_catalog.count(*) FROM public.ps_no_go_zones WHERE project_id = 'c2000000-0000-4000-8000-000000000001') INTO n;
  IF n <> 0 THEN RAISE EXCEPTION 'cancellato il progetto restano % righe sue', n; END IF;

  -- la categoria non è toccata dalla cancellazione delle corse, e ora che nessuna corsa la usa si cancella
  SELECT pg_catalog.count(*) INTO n FROM public.ps_validity_categories WHERE id = 'c2000000-0000-4000-8000-000000000006';
  IF n <> 1 THEN RAISE EXCEPTION 'cancellando le corse è sparita la categoria'; END IF;
  DELETE FROM public.ps_validity_categories WHERE id = 'c2000000-0000-4000-8000-000000000006';
END $$;
RESET ROLE;
ROLLBACK;
\echo 'chiavi esterne: tre vincoli validi, niente righe senza padre, cascata su corsa e progetto, categoria in uso non cancellabile'
