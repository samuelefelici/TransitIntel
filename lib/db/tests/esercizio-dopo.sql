-- ============================================================
-- Un solo programma in esercizio (migrazione 0019, PR 3.2): che cosa deve
-- esserci DOPO la migrazione nelle righe di esercizio-prima.sql, e che cosa
-- il database rifiuta da lì in poi. Alla fine toglie le righe di prova.
--   psql "$URL_DI_POSTGRES" -v ON_ERROR_STOP=1 -f lib/db/tests/esercizio-dopo.sql
-- ============================================================
\set ON_ERROR_STOP 1
\set QUIET 1
\pset tuples_only on
DO $$
DECLARE
  n bigint;
  ok boolean;
  ps constant uuid := 'c3200000-0000-4000-8000-0000000000a1';
  maior constant uuid := 'c3200000-0000-4000-8000-0000000000a2';
  vecchio constant uuid := 'c3200000-0000-4000-8000-0000000000a3';
BEGIN
  -- resta acceso il feed che l'AVM leggeva (l'ultimo caricato), ed è anche quello di default
  SELECT pg_catalog.count(*) INTO n FROM public.gtfs_feeds WHERE is_active;
  IF n <> 1 THEN RAISE EXCEPTION 'feed accesi: %, atteso uno', n; END IF;
  IF NOT (SELECT is_active AND is_default FROM public.gtfs_feeds WHERE id = maior) THEN
    RAISE EXCEPTION 'il feed in esercizio non è quello che leggeva l''AVM, o non è di default';
  END IF;
  SELECT pg_catalog.count(*) INTO n FROM public.gtfs_feeds WHERE is_default;
  IF n <> 1 THEN RAISE EXCEPTION 'feed di default: %, atteso uno', n; END IF;

  -- storico: il periodo del feed spento è chiuso, quello vecchio è com'era,
  -- e il feed in esercizio ha il suo periodo aperto
  SELECT deactivated_at IS NOT NULL INTO ok FROM public.ps_activation_log WHERE id = 'c3200000-0000-4000-8000-0000000000b1';
  IF NOT ok THEN RAISE EXCEPTION 'il periodo del feed spento è rimasto aperto'; END IF;
  SELECT deactivated_at = '2026-01-01' INTO ok FROM public.ps_activation_log WHERE id = 'c3200000-0000-4000-8000-0000000000b2';
  IF NOT ok THEN RAISE EXCEPTION 'la migrazione ha cambiato un periodo già chiuso'; END IF;
  SELECT pg_catalog.count(*) INTO n FROM public.ps_activation_log WHERE deactivated_at IS NULL;
  IF n <> 1 THEN RAISE EXCEPTION 'periodi aperti: %, atteso uno', n; END IF;
  SELECT pg_catalog.count(*) INTO n FROM public.ps_activation_log
   WHERE deactivated_at IS NULL AND feed_id = maior AND project_id IS NULL AND via = 'migrazione:0019';
  IF n <> 1 THEN RAISE EXCEPTION 'il feed in esercizio non ha il suo periodo aperto, senza progetto e con via migrazione:0019'; END IF;

  -- da qui il database rifiuta un secondo feed acceso e un secondo periodo aperto
  -- (alla fine della transazione: dentro, si spegne e si accende)
  BEGIN
    UPDATE public.gtfs_feeds SET is_active = true WHERE id = ps;
    SET CONSTRAINTS ALL IMMEDIATE;
    RAISE EXCEPTION 'due feed accesi';
  EXCEPTION WHEN exclusion_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.ps_activation_log (feed_id) VALUES (ps);
    SET CONSTRAINTS ALL IMMEDIATE;
    RAISE EXCEPTION 'due periodi aperti';
  EXCEPTION WHEN exclusion_violation THEN NULL;
  END;
  -- spegnere e accendere nello stesso UPDATE va bene
  UPDATE public.gtfs_feeds SET is_active = (id = ps) WHERE is_active OR id = ps;
  SET CONSTRAINTS ALL IMMEDIATE;
  SET CONSTRAINTS ALL DEFERRED;
  SELECT pg_catalog.count(*) INTO n FROM public.gtfs_feeds WHERE is_active;
  IF n <> 1 THEN RAISE EXCEPTION 'dopo il cambio, feed accesi: %', n; END IF;

  -- un progetto che si cancella non porta via lo storico
  DELETE FROM public.ps_projects WHERE id = 'c3200000-0000-4000-8000-000000000001';
  SELECT pg_catalog.count(*) INTO n FROM public.ps_activation_log WHERE id = 'c3200000-0000-4000-8000-0000000000b1' AND project_id IS NULL;
  IF n <> 1 THEN RAISE EXCEPTION 'cancellando il progetto se n''è andato lo storico'; END IF;

  -- via le righe di prova
  DELETE FROM public.ps_activation_log WHERE feed_id IN (ps, maior, vecchio);
  DELETE FROM public.gtfs_feeds WHERE id IN (ps, maior, vecchio);
END $$;
\echo un solo programma in esercizio: ok
