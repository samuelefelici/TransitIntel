-- ============================================================
-- La chiave esterna sulla categoria quando NON si può mettere
-- (migrazione 0013, PR 2.15c).
--   psql "$URL_DI_POSTGRES" -v ON_ERROR_STOP=1 -f lib/db/tests/chiave-categoria-rimandata.test.sql
-- Da lanciare dalla radice del repository (include i file delle migrazioni),
-- su un database già migrato. Tutto in una transazione che alla fine si
-- annulla: il database resta com'era.
--
-- Il caso: quando passa la 0013 c'è una corsa legata a una categoria
-- cancellata. La migrazione non deve fallire (il deploy va avanti), non deve
-- toccare quella riga (cambierebbe i giorni in cui la corsa vale) e non deve
-- mettere il vincolo. Sistemata la corsa, il vincolo si mette col comando di
-- DEPLOY, e rilanciare la migrazione non fa più niente.
-- ============================================================
\set ON_ERROR_STOP 1
\set QUIET 1
\pset tuples_only on
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL client_min_messages = error;

-- com'era un database prima della 0013, con una corsa legata a una categoria cancellata
ALTER TABLE public.ps_trip_category_validity DROP CONSTRAINT ps_trip_category_validity_category_id_fkey;
INSERT INTO public.ps_projects (id, owner_user_id, name)
VALUES ('c3000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-0000000000ff', 'Prova chiave rimandata');
INSERT INTO public.ps_routes (id, project_id, short_name)
VALUES ('c3000000-0000-4000-8000-000000000002', 'c3000000-0000-4000-8000-000000000001', 'K3');
INSERT INTO public.ps_route_variants (id, project_id, route_id, name)
VALUES ('c3000000-0000-4000-8000-000000000003', 'c3000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000002', 'andata');
INSERT INTO public.ps_trips (id, project_id, route_id, variant_id)
VALUES ('c3000000-0000-4000-8000-000000000004', 'c3000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000002', 'c3000000-0000-4000-8000-000000000003');
INSERT INTO public.ps_trip_category_validity (trip_id, category_id)
VALUES ('c3000000-0000-4000-8000-000000000004', 'c3000000-0000-4000-8000-0000000000cc');

-- la 0013 passa senza errori, e la 0010 (che toglie le righe senza corsa) pure
\i lib/db/migrations/0013_chiave_esterna_sulla_categoria.sql
\i lib/db/migrations/0010_chiavi_esterne_mancanti.sql

DO $$
DECLARE n bigint;
BEGIN
  SELECT pg_catalog.count(*) INTO n FROM pg_catalog.pg_constraint
   WHERE conrelid = 'public.ps_trip_category_validity'::regclass AND conname = 'ps_trip_category_validity_category_id_fkey';
  IF n <> 0 THEN RAISE EXCEPTION 'con una corsa legata a una categoria cancellata la 0013 ha messo lo stesso il vincolo'; END IF;
  SELECT pg_catalog.count(*) INTO n FROM public.ps_trip_category_validity
   WHERE trip_id = 'c3000000-0000-4000-8000-000000000004' AND category_id = 'c3000000-0000-4000-8000-0000000000cc';
  IF n <> 1 THEN RAISE EXCEPTION 'la riga con la categoria cancellata è stata toccata: cambia i giorni in cui la corsa vale'; END IF;
END $$;

-- la corsa viene sistemata (dalla tabella Corse: «Sostituisci»), poi il comando di DEPLOY
DELETE FROM public.ps_trip_category_validity
 WHERE trip_id = 'c3000000-0000-4000-8000-000000000004' AND category_id = 'c3000000-0000-4000-8000-0000000000cc';
ALTER TABLE public.ps_trip_category_validity
  ADD CONSTRAINT ps_trip_category_validity_category_id_fkey
  FOREIGN KEY (category_id) REFERENCES public.ps_validity_categories(id) ON DELETE RESTRICT;

-- rilanciata, la 0013 non fa più niente e il vincolo è quello atteso
\i lib/db/migrations/0013_chiave_esterna_sulla_categoria.sql
DO $$
DECLARE n bigint;
BEGIN
  SELECT pg_catalog.count(*) INTO n FROM pg_catalog.pg_constraint k
   WHERE k.conrelid = 'public.ps_trip_category_validity'::regclass AND k.conname = 'ps_trip_category_validity_category_id_fkey'
     AND k.convalidated
     AND pg_catalog.pg_get_constraintdef(k.oid) = 'FOREIGN KEY (category_id) REFERENCES ps_validity_categories(id) ON DELETE RESTRICT';
  IF n <> 1 THEN RAISE EXCEPTION 'dopo il comando di DEPLOY il vincolo non è quello atteso'; END IF;
END $$;
ROLLBACK;
\echo 'chiave sulla categoria: con una corsa da sistemare la migrazione avvisa e non tocca niente; sistemata, il vincolo si mette'
