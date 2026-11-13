-- ════════════════════════════════════════════════════════════════════════
-- 0017 — Codici stabili di corsa, fermata e linea (PR 3.1)
-- ────────────────────────────────────────────────────────────────────────
-- Una corsa, una fermata e una linea di Planning Studio avevano un solo nome
-- sicuro: l'id interno (un UUID). Ma l'id cambia a ogni copia del programma,
-- e il GTFS esportato consegnava proprio quello: chi lo riceveva (Regione,
-- open data, AVM, bigliettazione) vedeva cambiare tutti gli identificativi
-- da un programma all'altro. L'id del file d'origine (gtfs_id) c'era, ma non
-- lo usava nessuno, e le righe create a mano non lo avevano.
--
--   codice   text, obbligatorio, unico dentro il progetto. È il nome che
--            resta: lo stesso nella copia di un programma, quello che esce
--            nel GTFS. L'id interno resta interno.
--
-- Da dove viene:
--   - righe importate da un GTFS: l'id che avevano nel file (gtfs_id). Per le
--     linee importate prima che esistesse gtfs_id, il loro `code`, dove
--     l'import lo scriveva allora;
--   - righe create a mano, e quelle col gtfs_id ripetuto nel progetto (una
--     corsa sdoppiata ne è la copia): un codice nuovo, «CB-» più la lettera
--     del tipo (C corsa, F fermata, L linea) e un numero che non si ripete
--     (la sequenza ps_codici_seq, una per tutti i progetti).
-- gtfs_id resta com'è: dice da quale file viene la riga, e l'import lo usa
-- ancora per riconoscerla.
--
-- Qui la colonna e i codici delle righe che ci sono già. Il default, il NOT
-- NULL e i vincoli sono nella 0018: è DDL, e va fatto da chi migra dopo che i
-- dati sono stati scritti come cerbero_owner (README, «Chi possiede cosa»).
--
-- Il registro delle modifiche sorveglia già le tre tabelle con i valori: il
-- codice ci entra come gli altri campi (non è un dato di persone).
--
-- Lock: la colonna si aggiunge senza default (nessuna riscrittura), poi un
-- UPDATE per tabella scrive il codice su ogni riga, una volta sola. Le tre
-- tabelle restano chiuse (ACCESS EXCLUSIVE) dal primo ALTER alla fine della
-- transazione: su 300.000 corse e 85.000 fermate, misurati 13 secondi con la
-- 0018 (16 col registro delle modifiche acceso). In quei secondi le pagine di
-- Planning Studio aspettano. Se una tabella è occupata il migratore aspetta
-- al più 5 s e riprova.
-- ════════════════════════════════════════════════════════════════════════
DO $codici$
DECLARE
  t text;
BEGIN
  IF pg_catalog.to_regclass('public.ps_codici_seq') IS NULL THEN
    CREATE SEQUENCE public.ps_codici_seq AS bigint;
  END IF;
  IF pg_catalog.to_regrole('cerbero_owner') IS NOT NULL THEN
    ALTER SEQUENCE public.ps_codici_seq OWNER TO cerbero_owner;
  END IF;
  FOREACH t IN ARRAY ARRAY['ps_trips', 'ps_stops', 'ps_routes'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
                    WHERE attrelid = pg_catalog.to_regclass('public.' || t) AND attname = 'codice'
                      AND attnum > 0 AND NOT attisdropped) THEN
      EXECUTE pg_catalog.format('ALTER TABLE public.%I ADD COLUMN codice text', t);
    END IF;
  END LOOP;
END $codici$;
--> statement-breakpoint
-- I dati come cerbero_owner, se le tre tabelle sono già sue (la sequenza lo è
-- dal blocco qui sopra): su un database appena creato in un cluster che ha
-- già i ruoli sono ancora di chi migra, e cerbero_owner non le scriverebbe.
DO $come$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c
                  WHERE c.oid IN (pg_catalog.to_regclass('public.ps_trips'), pg_catalog.to_regclass('public.ps_stops'),
                                  pg_catalog.to_regclass('public.ps_routes'), pg_catalog.to_regclass('public.ps_codici_seq'))
                    AND c.relowner IS DISTINCT FROM pg_catalog.to_regrole('cerbero_owner')) THEN
    EXECUTE 'SET LOCAL ROLE cerbero_owner';
  END IF;
END $come$;
--> statement-breakpoint
-- Corse. Un gtfs_id «buono» è quello che il vincolo più sotto accetta, e che
-- non ha la forma dei codici generati qui. Se nel progetto si ripete, lo
-- tiene la riga più vecchia.
WITH ordinate AS (
  SELECT t.id, v.voluto,
         pg_catalog.row_number() OVER (PARTITION BY t.project_id, v.voluto ORDER BY t.created_at, t.id) AS n
    FROM public.ps_trips t
   CROSS JOIN LATERAL (
     SELECT CASE WHEN pg_catalog.btrim(t.gtfs_id) <> ''
                  AND pg_catalog.char_length(pg_catalog.btrim(t.gtfs_id)) <= 200
                  AND pg_catalog.btrim(t.gtfs_id) !~ '[[:cntrl:]]'
                  AND pg_catalog.btrim(t.gtfs_id) !~ '^CB-[CFL][0-9]+$'
                 THEN pg_catalog.btrim(t.gtfs_id) END AS voluto) v
   WHERE t.codice IS NULL
)
UPDATE public.ps_trips t
   SET codice = CASE WHEN o.voluto IS NOT NULL AND o.n = 1 THEN o.voluto
                     ELSE 'CB-C' || pg_catalog.nextval('public.ps_codici_seq'::pg_catalog.regclass) END
  FROM ordinate o
 WHERE o.id = t.id;
--> statement-breakpoint
-- Fermate: come le corse.
WITH ordinate AS (
  SELECT s.id, v.voluto,
         pg_catalog.row_number() OVER (PARTITION BY s.project_id, v.voluto ORDER BY s.created_at, s.id) AS n
    FROM public.ps_stops s
   CROSS JOIN LATERAL (
     SELECT CASE WHEN pg_catalog.btrim(s.gtfs_id) <> ''
                  AND pg_catalog.char_length(pg_catalog.btrim(s.gtfs_id)) <= 200
                  AND pg_catalog.btrim(s.gtfs_id) !~ '[[:cntrl:]]'
                  AND pg_catalog.btrim(s.gtfs_id) !~ '^CB-[CFL][0-9]+$'
                 THEN pg_catalog.btrim(s.gtfs_id) END AS voluto) v
   WHERE s.codice IS NULL
)
UPDATE public.ps_stops s
   SET codice = CASE WHEN o.voluto IS NOT NULL AND o.n = 1 THEN o.voluto
                     ELSE 'CB-F' || pg_catalog.nextval('public.ps_codici_seq'::pg_catalog.regclass) END
  FROM ordinate o
 WHERE o.id = s.id;
--> statement-breakpoint
-- Linee: il gtfs_id e, se manca, il `code` (dove stava l'id del file prima
-- che esistesse gtfs_id; l'import riconosce ancora così quelle linee). Fra due
-- linee che vogliono lo stesso codice vince quella col gtfs_id, poi la più
-- vecchia.
WITH ordinate AS (
  SELECT r.id, v.voluto,
         pg_catalog.row_number() OVER (PARTITION BY r.project_id, v.voluto
                                       ORDER BY (pg_catalog.btrim(r.gtfs_id) = v.voluto) DESC NULLS LAST, r.created_at, r.id) AS n
    FROM public.ps_routes r
   CROSS JOIN LATERAL (
     SELECT pg_catalog.btrim(x.testo) AS voluto
       FROM (VALUES (1, r.gtfs_id), (2, r.code)) AS x(ordine, testo)
      WHERE pg_catalog.btrim(x.testo) <> ''
        AND pg_catalog.char_length(pg_catalog.btrim(x.testo)) <= 200
        AND pg_catalog.btrim(x.testo) !~ '[[:cntrl:]]'
        AND pg_catalog.btrim(x.testo) !~ '^CB-[CFL][0-9]+$'
      ORDER BY x.ordine
      LIMIT 1) v
   WHERE r.codice IS NULL
)
UPDATE public.ps_routes r
   SET codice = CASE WHEN o.n = 1 THEN o.voluto
                     ELSE 'CB-L' || pg_catalog.nextval('public.ps_codici_seq'::pg_catalog.regclass) END
  FROM ordinate o
 WHERE o.id = r.id;
--> statement-breakpoint
-- Le linee senza gtfs_id e senza code buoni (la LATERAL qui sopra non dà
-- righe): un codice nuovo.
UPDATE public.ps_routes
   SET codice = 'CB-L' || pg_catalog.nextval('public.ps_codici_seq'::pg_catalog.regclass)
 WHERE codice IS NULL;
--> statement-breakpoint
-- Nel log del deploy: quante righe importate non hanno potuto tenere l'id del
-- loro file (ripetuto nel progetto, o non valido come codice) e hanno preso
-- un codice nuovo. Le righe create a mano lo prendono sempre: non si contano.
DO $conta$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT 'corse' AS cosa, pg_catalog.count(*) FILTER (WHERE codice ~ '^CB-[CFL][0-9]+$') AS nuove,
           pg_catalog.count(*) FILTER (WHERE codice ~ '^CB-[CFL][0-9]+$' AND pg_catalog.btrim(gtfs_id) <> '') AS importate
      FROM public.ps_trips
    UNION ALL
    SELECT 'fermate', pg_catalog.count(*) FILTER (WHERE codice ~ '^CB-[CFL][0-9]+$'),
           pg_catalog.count(*) FILTER (WHERE codice ~ '^CB-[CFL][0-9]+$' AND pg_catalog.btrim(gtfs_id) <> '')
      FROM public.ps_stops
    UNION ALL
    SELECT 'linee', pg_catalog.count(*) FILTER (WHERE codice ~ '^CB-[CFL][0-9]+$'),
           pg_catalog.count(*) FILTER (WHERE codice ~ '^CB-[CFL][0-9]+$'
                                         AND (pg_catalog.btrim(gtfs_id) <> '' OR pg_catalog.btrim(code) <> ''))
      FROM public.ps_routes
  LOOP
    RAISE NOTICE '0017: % con un codice nuovo: %', r.cosa, r.nuove;
    IF r.importate > 0 THEN
      RAISE WARNING '0017: % % importate hanno preso un codice nuovo: l''id del loro file era già di un''altra riga del progetto, o non va bene come codice', r.importate, r.cosa;
    END IF;
  END LOOP;
END $conta$;
--> statement-breakpoint
RESET ROLE;
