-- ════════════════════════════════════════════════════════════════════════
-- 0044 — I gestori: più agenzie nei GTFS, una per linea (tappa 6.11)
-- ────────────────────────────────────────────────────────────────────────
-- Chi programma il servizio può farlo per più aziende: un consorzio per i
-- suoi consorziati. Nei GTFS ogni azienda è un'agenzia (agency.txt) e ogni
-- linea è di una di loro (routes.txt). Fin qui l'agenzia era una sola.
--   gestori   una riga per azienda che gestisce linee.
--     gestore       l'identificativo, quello che finisce nel GTFS
--                   (agency_id) e che sta sulle linee (ps_routes.agency_id,
--                   gtfs_routes.agency_id): non cambia;
--     predefinito   il gestore delle linee che non ne dicono uno, o ne dicono
--                   uno che non è nell'elenco: al più uno, e l'API ne vuole
--                   uno finché l'elenco non è vuoto.
-- Senza righe vale l'azienda dell'installazione (Amministrazione › Azienda),
-- per tutte le linee.
-- La tabella agenzia_gtfs della migrazione 0043 (l'agenzia unica) resta
-- dov'è: la sua riga, se c'è, diventa qui il primo gestore, predefinito, e
-- chi torna all'immagine precedente la ritrova. Il codice nuovo non la legge
-- più.
-- ════════════════════════════════════════════════════════════════════════
DO $gestori$
BEGIN
  IF pg_catalog.to_regclass('public.gestori') IS NULL THEN
    CREATE TABLE public.gestori (
      gestore       text PRIMARY KEY CONSTRAINT gestori_gestore CHECK (gestore ~ '^[A-Za-z0-9_.-]{1,40}$'),
      nome          text NOT NULL CONSTRAINT gestori_nome CHECK (char_length(btrim(nome)) BETWEEN 1 AND 120 AND nome !~ '[[:cntrl:]"]'),
      sito          text NOT NULL CONSTRAINT gestori_sito CHECK (sito ~ '^https?://[^[:space:]",<>]{1,200}$'),
      telefono      text CONSTRAINT gestori_telefono CHECK (telefono ~ '^[0-9+() ./-]{3,40}$'),
      email         text CONSTRAINT gestori_email CHECK (email ~ '^[^[:space:]",<>@]{1,64}@[^[:space:]",<>@]{1,190}$'),
      tariffe_url   text CONSTRAINT gestori_tariffe_url CHECK (tariffe_url ~ '^https?://[^[:space:]",<>]{1,200}$'),
      predefinito   boolean NOT NULL DEFAULT false,
      ordine        integer NOT NULL DEFAULT 0 CONSTRAINT gestori_ordine CHECK (ordine BETWEEN 0 AND 99999),
      aggiornato_il timestamptz NOT NULL DEFAULT now()
    );
  END IF;
  IF pg_catalog.to_regclass('public.gestori_un_predefinito') IS NULL THEN
    CREATE UNIQUE INDEX gestori_un_predefinito ON public.gestori (predefinito) WHERE predefinito;
  END IF;
  IF pg_catalog.to_regrole('cerbero_owner') IS NOT NULL THEN
    ALTER TABLE public.gestori OWNER TO cerbero_owner;
  END IF;
END $gestori$;
--> statement-breakpoint
SELECT registro.sorveglia('public.gestori', ARRAY['gestore'], NULL, NULL, true, '{}', ARRAY['aggiornato_il']);
--> statement-breakpoint
-- I dati come cerbero_owner, solo se sono già sue le tabelle che si toccano
-- (su un database appena creato sono ancora di chi migra) e se può già usare
-- lo schema: dove public non è aperto a tutti, il permesso lo dà il
-- riallineamento dei ruoli, dopo le migrazioni.
DO $come$ BEGIN
  IF pg_catalog.to_regrole('cerbero_owner') IS NOT NULL THEN
    IF pg_catalog.has_schema_privilege('cerbero_owner', 'public', 'USAGE')
       AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c
                        WHERE c.oid IN (pg_catalog.to_regclass('public.agenzia_gtfs'), pg_catalog.to_regclass('public.gestori'))
                          AND c.relowner IS DISTINCT FROM pg_catalog.to_regrole('cerbero_owner')) THEN
      EXECUTE 'SET LOCAL ROLE cerbero_owner';
    END IF;
  END IF;
END $come$;
--> statement-breakpoint
-- L'agenzia unica che c'era diventa il primo gestore, predefinito. Solo se
-- l'elenco è ancora vuoto: una seconda esecuzione non la rimette.
INSERT INTO public.gestori (gestore, nome, sito, telefono, email, tariffe_url, predefinito, ordine)
SELECT a.agency_id, a.nome, a.sito, a.telefono, a.email, a.tariffe_url, true, 10
  FROM public.agenzia_gtfs a
 WHERE NOT EXISTS (SELECT 1 FROM public.gestori);
--> statement-breakpoint
RESET ROLE;
