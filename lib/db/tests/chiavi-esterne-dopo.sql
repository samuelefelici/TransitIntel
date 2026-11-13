-- ============================================================
-- Le chiavi esterne di Planning Studio (migrazioni 0010, 0011 e 0013, PR 2.15 e 2.15c):
-- quello che deve restare DOPO la migrazione delle righe di
-- chiavi-esterne-prima.sql. Alla fine toglie le righe di prova.
--   psql "$URL_DI_POSTGRES" -v ON_ERROR_STOP=1 -f lib/db/tests/chiavi-esterne-dopo.sql
-- ============================================================
\set ON_ERROR_STOP 1
\set QUIET 1
\pset tuples_only on
DO $$
DECLARE n bigint;
BEGIN
  -- le righe orfane non ci sono più
  SELECT pg_catalog.count(*) INTO n FROM public.ps_trip_category_validity v
   WHERE NOT EXISTS (SELECT 1 FROM public.ps_trips t WHERE t.id = v.trip_id);
  IF n <> 0 THEN RAISE EXCEPTION 'restano % righe di categorie di corse che non esistono', n; END IF;
  SELECT pg_catalog.count(*) INTO n FROM public.ps_no_go_zones z
   WHERE NOT EXISTS (SELECT 1 FROM public.ps_projects p WHERE p.id = z.project_id);
  IF n <> 0 THEN RAISE EXCEPTION 'restano % zone vietate di progetti che non esistono', n; END IF;

  -- le righe vere sì
  SELECT pg_catalog.count(*) INTO n FROM public.ps_trip_category_validity
   WHERE trip_id = 'c1000000-0000-4000-8000-000000000004' AND category_id = 'c1000000-0000-4000-8000-000000000005';
  IF n <> 1 THEN RAISE EXCEPTION 'la categoria della corsa vera è sparita'; END IF;
  SELECT pg_catalog.count(*) INTO n FROM public.ps_no_go_zones WHERE id = 'c1000000-0000-4000-8000-000000000006';
  IF n <> 1 THEN RAISE EXCEPTION 'la zona vietata del progetto vero è sparita'; END IF;

  -- senza righe con una categoria cancellata, la 0013 ha messo anche la chiave sulla categoria
  SELECT pg_catalog.count(*) INTO n FROM pg_catalog.pg_constraint
   WHERE conrelid = 'public.ps_trip_category_validity'::regclass AND conname = 'ps_trip_category_validity_category_id_fkey' AND convalidated;
  IF n <> 1 THEN RAISE EXCEPTION 'la chiave esterna sulla categoria non c''è'; END IF;

  -- via le righe di prova. Prima le corse (un percorso non si cancella finché
  -- ha corse: lo fa così anche l'API), poi il progetto: con la corsa se ne
  -- vanno le sue categorie, col progetto la zona vietata.
  DELETE FROM public.ps_trips WHERE project_id = 'c1000000-0000-4000-8000-000000000001';
  DELETE FROM public.ps_projects WHERE id = 'c1000000-0000-4000-8000-000000000001';
  DELETE FROM public.ps_validity_categories WHERE id = 'c1000000-0000-4000-8000-000000000005';
  SELECT (SELECT pg_catalog.count(*) FROM public.ps_trip_category_validity WHERE trip_id = 'c1000000-0000-4000-8000-000000000004')
       + (SELECT pg_catalog.count(*) FROM public.ps_no_go_zones WHERE project_id = 'c1000000-0000-4000-8000-000000000001') INTO n;
  IF n <> 0 THEN RAISE EXCEPTION 'cancellato il progetto restano % righe sue', n; END IF;
END $$;
\echo 'chiavi esterne: le righe orfane sono sparite, quelle vere sono rimaste'
