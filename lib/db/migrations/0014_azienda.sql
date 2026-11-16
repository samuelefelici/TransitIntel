-- ════════════════════════════════════════════════════════════════════════
-- 0014 — L'azienda (PR 2.17a)
-- ────────────────────────────────────────────────────────────────────────
-- I dati dell'azienda che usa Cerbero erano scritti nel codice: «Conerobus
-- S.p.A.» nei GTFS esportati, «Ancona» nelle parole vietate delle password,
-- il centro della mappa in ogni pagina. Da qui stanno in una tabella, e si
-- cambiano da Amministrazione › Azienda.
--
--   public.azienda   una riga sola (la chiave `unica` vale sempre true).
--     ragione_sociale, nome       il nome per esteso e quello corto
--     sito, telefono              per agency.txt e feed_info.txt
--     gtfs_agency_id              l'agency_id dei GTFS esportati
--     citta, regione              la città principale del servizio
--     centro_lat, centro_lng, zoom  dove si aprono le mappe di tutta la rete
--
-- Non è per più aziende nello stesso database: ogni azienda ha la sua
-- installazione, e questa è la sua riga.
--
-- La riga di Conerobus, con i valori che il codice aveva fino a oggi, si
-- scrive solo se il database è già in uso (ha utenti): è l'installazione che
-- esiste. Un database nuovo resta con la tabella vuota: l'app usa valori
-- neutri («Azienda di trasporto») finché l'amministratore non compila la
-- pagina. Così un'installazione nuova non nasce col nome di un'altra azienda.
--
-- Il registro delle modifiche la sorveglia con i valori: sono dati
-- dell'azienda, non di persone.
--
-- Lock: tabella nuova, nessuno la sta usando.
-- ════════════════════════════════════════════════════════════════════════
DO $azienda$
BEGIN
  IF pg_catalog.to_regclass('public.azienda') IS NULL THEN
    CREATE TABLE public.azienda (
      unica            boolean PRIMARY KEY DEFAULT true CONSTRAINT azienda_una_riga CHECK (unica),
      ragione_sociale  text NOT NULL CONSTRAINT azienda_ragione_sociale CHECK (char_length(btrim(ragione_sociale)) BETWEEN 1 AND 120),
      nome             text NOT NULL CONSTRAINT azienda_nome CHECK (char_length(btrim(nome)) BETWEEN 1 AND 40),
      -- solo http e https, senza spazi, virgole e virgolette: finisce in un CSV e in un link
      sito             text CONSTRAINT azienda_sito CHECK (sito ~ '^https?://[^[:space:]",<>]{1,200}$'),
      telefono         text CONSTRAINT azienda_telefono CHECK (telefono ~ '^[0-9+() ./-]{3,40}$'),
      gtfs_agency_id   text NOT NULL CONSTRAINT azienda_gtfs_agency_id CHECK (gtfs_agency_id ~ '^[A-Za-z0-9_.-]{1,40}$'),
      citta            text NOT NULL CONSTRAINT azienda_citta CHECK (char_length(btrim(citta)) BETWEEN 1 AND 60),
      regione          text CONSTRAINT azienda_regione CHECK (char_length(btrim(regione)) BETWEEN 1 AND 60),
      centro_lat       double precision NOT NULL CONSTRAINT azienda_centro_lat CHECK (centro_lat BETWEEN -90 AND 90),
      centro_lng       double precision NOT NULL CONSTRAINT azienda_centro_lng CHECK (centro_lng BETWEEN -180 AND 180),
      zoom             real NOT NULL CONSTRAINT azienda_zoom CHECK (zoom BETWEEN 3 AND 18),
      aggiornata_il    timestamptz NOT NULL DEFAULT now(),
      -- chi l'ha salvata dall'app (users.id); vuoto per la riga scritta da questa migrazione
      aggiornata_da    uuid
    );
  END IF;
  IF pg_catalog.to_regrole('cerbero_owner') IS NOT NULL THEN
    ALTER TABLE public.azienda OWNER TO cerbero_owner;
  END IF;
END $azienda$;
--> statement-breakpoint
SELECT registro.sorveglia('public.azienda', ARRAY['unica'], NULL, NULL, true, '{}', ARRAY['aggiornata_il']);
--> statement-breakpoint
-- Come cerbero_owner solo se sono già sue tutte e due le tabelle che l'INSERT
-- tocca: su un database appena creato in un cluster che ha già i ruoli
-- public.users è ancora di chi migra, e cerbero_owner non la leggerebbe.
DO $come$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c
                  WHERE c.oid IN (pg_catalog.to_regclass('public.azienda'), pg_catalog.to_regclass('public.users'))
                    AND c.relowner IS DISTINCT FROM pg_catalog.to_regrole('cerbero_owner')) THEN
    EXECUTE 'SET LOCAL ROLE cerbero_owner';
  END IF;
END $come$;
--> statement-breakpoint
INSERT INTO public.azienda (ragione_sociale, nome, sito, telefono, gtfs_agency_id, citta, regione, centro_lat, centro_lng, zoom)
SELECT 'Conerobus S.p.A.', 'Conerobus', 'https://www.conerobus.it', '+39 071 2837411', 'conerobus',
       'Ancona', 'Marche', 43.58, 13.45, 10
 WHERE EXISTS (SELECT 1 FROM public.users)
ON CONFLICT (unica) DO NOTHING;
--> statement-breakpoint
RESET ROLE;
