-- ============================================================
-- I codici stabili di corsa, fermata e linea (migrazioni 0017 e 0018, PR 3.1):
-- che cosa deve esserci DOPO la migrazione nelle righe di
-- codici-stabili-prima.sql, e che cosa il database rifiuta da lì in poi.
-- Alla fine toglie le righe di prova.
--   psql "$URL_DI_POSTGRES" -v ON_ERROR_STOP=1 -f lib/db/tests/codici-stabili-dopo.sql
-- ============================================================
\set ON_ERROR_STOP 1
\set QUIET 1
\pset tuples_only on
DO $$
DECLARE
  n bigint;
  c text;
  generato constant text := '^CB-[CFL][0-9]+$';
  p constant uuid := 'c3000000-0000-4000-8000-000000000001';
  codice_di CONSTANT text := 'SELECT codice FROM public.%I WHERE id = %L';
  atteso record;
BEGIN
  -- nessuna riga senza codice, in tutto il database
  SELECT (SELECT pg_catalog.count(*) FROM public.ps_trips WHERE codice IS NULL)
       + (SELECT pg_catalog.count(*) FROM public.ps_stops WHERE codice IS NULL)
       + (SELECT pg_catalog.count(*) FROM public.ps_routes WHERE codice IS NULL) INTO n;
  IF n <> 0 THEN RAISE EXCEPTION '% righe sono rimaste senza codice', n; END IF;

  -- riga per riga: il codice atteso, oppure «un codice nuovo» (NULL)
  FOR atteso IN
    SELECT * FROM (VALUES
      ('ps_routes', 'c3000000-0000-4000-8000-0000000000a1', '1/3',  'la linea importata tiene il gtfs_id'),
      ('ps_routes', 'c3000000-0000-4000-8000-0000000000a2', 'LEG1', 'la linea di prima di gtfs_id tiene il code'),
      ('ps_routes', 'c3000000-0000-4000-8000-0000000000a3', NULL,   'la linea a mano prende un codice nuovo'),
      ('ps_routes', 'c3000000-0000-4000-8000-0000000000a4', NULL,   'fra code e gtfs_id uguali perde il code'),
      ('ps_routes', 'c3000000-0000-4000-8000-0000000000a5', 'X9',   'fra code e gtfs_id uguali vince il gtfs_id'),
      ('ps_routes', 'c3000000-0000-4000-8000-0000000000a6', NULL,   'il code ripetuto lo tiene la linea più vecchia'),
      ('ps_routes', 'c3000000-0000-4000-8000-0000000000a7', NULL,   'gtfs_id e code vuoti: un codice nuovo'),
      ('ps_stops',  'c3000000-0000-4000-8000-0000000000c1', '10',   'la fermata importata tiene il gtfs_id'),
      ('ps_stops',  'c3000000-0000-4000-8000-0000000000c2', NULL,   'la fermata a mano prende un codice nuovo, non il suo code'),
      ('ps_stops',  'c3000000-0000-4000-8000-0000000000c3', NULL,   'il gtfs_id ripetuto lo tiene la fermata più vecchia'),
      ('ps_trips',  'c3000000-0000-4000-8000-0000000000d1', '623_CodUdp:D1333_363485', 'la corsa importata tiene il gtfs_id'),
      ('ps_trips',  'c3000000-0000-4000-8000-0000000000d2', NULL,   'la corsa sdoppiata prende un codice nuovo'),
      ('ps_trips',  'c3000000-0000-4000-8000-0000000000d3', NULL,   'la corsa a mano prende un codice nuovo'),
      ('ps_trips',  'c3000000-0000-4000-8000-0000000000d4', NULL,   'gtfs_id di soli spazi: un codice nuovo'),
      ('ps_trips',  'c3000000-0000-4000-8000-0000000000d5', 'con spazi', 'gli spazi ai lati si tolgono'),
      ('ps_trips',  'c3000000-0000-4000-8000-0000000000d6', NULL,   'uguale a un altro una volta tolti gli spazi: un codice nuovo'),
      ('ps_trips',  'c3000000-0000-4000-8000-0000000000d7', NULL,   'un carattere di controllo: un codice nuovo'),
      ('ps_trips',  'c3000000-0000-4000-8000-0000000000d8', NULL,   'la forma dei codici generati non si prende dal file'),
      ('ps_trips',  'c3000000-0000-4000-8000-0000000000d9', NULL,   'più di 200 caratteri: un codice nuovo')
    ) AS x(tabella, id, codice, perche)
  LOOP
    EXECUTE pg_catalog.format(codice_di, atteso.tabella, atteso.id) INTO c;
    IF atteso.codice IS NOT NULL AND c IS DISTINCT FROM atteso.codice THEN
      RAISE EXCEPTION '%: atteso «%», trovato «%»', atteso.perche, atteso.codice, c;
    END IF;
    IF atteso.codice IS NULL AND (c IS NULL OR c !~ generato) THEN
      RAISE EXCEPTION '%: trovato «%»', atteso.perche, c;
    END IF;
  END LOOP;
  -- la lettera dice il tipo
  IF EXISTS (SELECT 1 FROM public.ps_trips  WHERE project_id = p AND codice ~ generato AND codice !~ '^CB-C')
  OR EXISTS (SELECT 1 FROM public.ps_stops  WHERE project_id = p AND codice ~ generato AND codice !~ '^CB-F')
  OR EXISTS (SELECT 1 FROM public.ps_routes WHERE project_id = p AND codice ~ generato AND codice !~ '^CB-L') THEN
    RAISE EXCEPTION 'un codice generato ha la lettera di un altro tipo';
  END IF;
  -- gtfs_id non è stato toccato
  SELECT pg_catalog.count(*) INTO n FROM public.ps_trips WHERE project_id = p AND gtfs_id = '623_CodUdp:D1333_363485';
  IF n <> 2 THEN RAISE EXCEPTION 'la migrazione ha cambiato gtfs_id'; END IF;

  -- una riga nuova senza codice ne riceve uno
  INSERT INTO public.ps_trips (id, project_id, route_id, variant_id)
  VALUES ('c3000000-0000-4000-8000-0000000000e1', p, 'c3000000-0000-4000-8000-0000000000a1', 'c3000000-0000-4000-8000-0000000000b1')
  RETURNING codice INTO c;
  IF c !~ '^CB-C[0-9]+$' THEN RAISE EXCEPTION 'la corsa nuova non ha ricevuto un codice: «%»', c; END IF;
  INSERT INTO public.ps_stops (id, project_id, name, lat, lon)
  VALUES ('c3000000-0000-4000-8000-0000000000e2', p, 'nuova', 43.6, 13.5) RETURNING codice INTO c;
  IF c !~ '^CB-F[0-9]+$' THEN RAISE EXCEPTION 'la fermata nuova non ha ricevuto un codice: «%»', c; END IF;
  INSERT INTO public.ps_routes (id, project_id, short_name)
  VALUES ('c3000000-0000-4000-8000-0000000000e3', p, 'nuova') RETURNING codice INTO c;
  IF c !~ '^CB-L[0-9]+$' THEN RAISE EXCEPTION 'la linea nuova non ha ricevuto un codice: «%»', c; END IF;

  -- lo stesso codice due volte nel progetto: no
  BEGIN
    INSERT INTO public.ps_trips (project_id, route_id, variant_id, codice)
    VALUES (p, 'c3000000-0000-4000-8000-0000000000a1', 'c3000000-0000-4000-8000-0000000000b1', '623_CodUdp:D1333_363485');
    RAISE EXCEPTION 'due corse dello stesso progetto hanno lo stesso codice';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.ps_stops (project_id, name, lat, lon, codice) VALUES (p, 'doppia', 43.6, 13.5, '10');
    RAISE EXCEPTION 'due fermate dello stesso progetto hanno lo stesso codice';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.ps_routes (project_id, short_name, codice) VALUES (p, 'doppia', '1/3');
    RAISE EXCEPTION 'due linee dello stesso progetto hanno lo stesso codice';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  -- in un altro progetto sì: la copia di un programma tiene i codici
  INSERT INTO public.ps_projects (id, owner_user_id, name)
  VALUES ('c3000000-0000-4000-8000-000000000002', 'c3000000-0000-4000-8000-0000000000ff', 'Prova codici stabili (copia)');
  INSERT INTO public.ps_stops (project_id, name, lat, lon, codice)
  VALUES ('c3000000-0000-4000-8000-000000000002', 'stessa fermata', 43.6, 13.5, '10');

  -- senza codice, vuoto, con spazi ai lati, con un a capo, troppo lungo: no
  BEGIN
    UPDATE public.ps_stops SET codice = NULL WHERE id = 'c3000000-0000-4000-8000-0000000000c1';
    RAISE EXCEPTION 'il codice si può togliere';
  EXCEPTION WHEN not_null_violation THEN NULL;
  END;
  FOREACH c IN ARRAY ARRAY['', ' 10', '10 ', E'1\n0', pg_catalog.repeat('x', 201)] LOOP
    BEGIN
      UPDATE public.ps_stops SET codice = c WHERE id = 'c3000000-0000-4000-8000-0000000000c1';
      RAISE EXCEPTION 'il vincolo accetta il codice «%»', c;
    EXCEPTION WHEN check_violation THEN NULL;
    END;
  END LOOP;

  -- via le righe di prova (prima le corse: un percorso non si cancella finché ne ha)
  DELETE FROM public.ps_trips WHERE project_id = p;
  DELETE FROM public.ps_projects WHERE id IN (p, 'c3000000-0000-4000-8000-000000000002');
  SELECT (SELECT pg_catalog.count(*) FROM public.ps_stops WHERE project_id IN (p, 'c3000000-0000-4000-8000-000000000002'))
       + (SELECT pg_catalog.count(*) FROM public.ps_routes WHERE project_id = p) INTO n;
  IF n <> 0 THEN RAISE EXCEPTION 'le righe di prova non se ne sono andate'; END IF;
END $$;
\echo codici stabili: ok
