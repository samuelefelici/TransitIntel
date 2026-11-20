-- ══════════════════════════════════════════════════════════════════════
-- 0055 — La polimetrica della bigliettazione, per confrontarla (tappa 6.34)
-- ──────────────────────────────────────────────────────────────────────
-- La polimetrica che sta nel sistema di bigliettazione invecchia: le linee
-- cambiano e nessuno la riallinea. L'azienda genera la sua nella pagina
-- Polimetriche (tappa 6.33) e la confronta con quella. Qui entra quella della
-- bigliettazione, caricata da due file CSV in un formato che non dipende dal
-- sistema da cui escono:
--   polim_ufficiale_punti        i punti tariffari di ogni linea, nell'ordine,
--                                col loro km progressivo, il nome e il nodo
--                                tariffario a cui fanno capo
--   polim_ufficiale_righe        le righe della polimetrica: per linea e
--                                coppia di nodi, i km, il tariffario, la
--                                fascia, e se la riga è stata forzata a mano.
--                                Percorso e direzione vuoti: vale per tutti
--   polim_ufficiale_caricamento  una riga sola: quando è stata caricata, da
--                                chi, da quali file
--   polim_abbinamenti_linee      per ogni linea della bigliettazione, la linea
--                                dell'azienda a cui corrisponde, o che è
--                                esclusa dal confronto. Senza riga: da abbinare
-- Un caricamento sostituisce punti e righe per intero; gli abbinamenti
-- restano. Solo rete e tariffe: nessun dato di persone.
-- Tutte e quattro nel registro delle modifiche: punti e righe sempre come
-- riepilogo (si riscrivono a migliaia), le altre due col valore.
-- ══════════════════════════════════════════════════════════════════════
DO $polim$
BEGIN
  IF pg_catalog.to_regclass('public.polim_ufficiale_punti') IS NULL THEN
    CREATE TABLE public.polim_ufficiale_punti (
      -- il codice della linea nella bigliettazione, in maiuscolo
      linea      text NOT NULL CONSTRAINT polim_ufficiale_punti_linea CHECK (char_length(linea) BETWEEN 1 AND 40 AND linea !~ '[[:cntrl:]]' AND linea !~ '[[:lower:]]'),
      percorso   text NOT NULL CONSTRAINT polim_ufficiale_punti_percorso CHECK (char_length(percorso) BETWEEN 1 AND 40 AND percorso !~ '[[:cntrl:]]'),
      direzione  text NOT NULL CONSTRAINT polim_ufficiale_punti_direzione CHECK (char_length(direzione) BETWEEN 1 AND 10 AND direzione !~ '[[:cntrl:]]'),
      ordine     integer NOT NULL CONSTRAINT polim_ufficiale_punti_ordine CHECK (ordine BETWEEN 1 AND 100000),
      -- il codice della località che fa da punto tariffario
      codice     text NOT NULL CONSTRAINT polim_ufficiale_punti_codice CHECK (char_length(codice) BETWEEN 1 AND 40 AND codice !~ '[[:cntrl:]]'),
      nome       text CONSTRAINT polim_ufficiale_punti_nome CHECK (char_length(nome) BETWEEN 1 AND 200 AND nome !~ '[[:cntrl:]]'),
      -- il nodo tariffario a cui la località fa capo; vuoto: è lei stessa
      nodo       text CONSTRAINT polim_ufficiale_punti_nodo CHECK (char_length(nodo) BETWEEN 1 AND 40 AND nodo !~ '[[:cntrl:]]'),
      km         numeric(8,3) NOT NULL CONSTRAINT polim_ufficiale_punti_km CHECK (km >= 0 AND km <= 2000),
      CONSTRAINT polim_ufficiale_punti_pkey PRIMARY KEY (linea, percorso, direzione, ordine)
    );
  END IF;
  IF pg_catalog.to_regclass('public.polim_ufficiale_righe') IS NULL THEN
    CREATE TABLE public.polim_ufficiale_righe (
      linea       text NOT NULL CONSTRAINT polim_ufficiale_righe_linea CHECK (char_length(linea) BETWEEN 1 AND 40 AND linea !~ '[[:cntrl:]]' AND linea !~ '[[:lower:]]'),
      -- vuoti: la riga vale per ogni percorso e per ogni direzione della linea
      percorso    text NOT NULL CONSTRAINT polim_ufficiale_righe_percorso CHECK (char_length(percorso) <= 40 AND percorso !~ '[[:cntrl:]]'),
      direzione   text NOT NULL CONSTRAINT polim_ufficiale_righe_direzione CHECK (char_length(direzione) <= 10 AND direzione !~ '[[:cntrl:]]'),
      -- i due nodi tariffari della coppia
      da          text NOT NULL CONSTRAINT polim_ufficiale_righe_da CHECK (char_length(da) BETWEEN 1 AND 40 AND da !~ '[[:cntrl:]]'),
      a           text NOT NULL CONSTRAINT polim_ufficiale_righe_a CHECK (char_length(a) BETWEEN 1 AND 40 AND a !~ '[[:cntrl:]]'),
      km          numeric(8,3) CONSTRAINT polim_ufficiale_righe_km CHECK (km >= 0 AND km <= 2000),
      tariffario  text CONSTRAINT polim_ufficiale_righe_tariffario CHECK (char_length(tariffario) BETWEEN 1 AND 40 AND tariffario !~ '[[:cntrl:]]'),
      fascia      smallint CONSTRAINT polim_ufficiale_righe_fascia CHECK (fascia BETWEEN 0 AND 999),
      -- la riga è stata scritta a mano nella bigliettazione, non calcolata dai km
      forzata     boolean NOT NULL DEFAULT false,
      CONSTRAINT polim_ufficiale_righe_pkey PRIMARY KEY (linea, percorso, direzione, da, a)
    );
  END IF;
  IF pg_catalog.to_regclass('public.polim_ufficiale_caricamento') IS NULL THEN
    CREATE TABLE public.polim_ufficiale_caricamento (
      unica        boolean PRIMARY KEY DEFAULT true CONSTRAINT polim_ufficiale_caricamento_unica CHECK (unica),
      caricata_il  timestamptz NOT NULL DEFAULT now(),
      caricata_da  uuid REFERENCES public.users(id) ON DELETE SET NULL,
      file_punti   text CONSTRAINT polim_ufficiale_caricamento_file_punti CHECK (char_length(file_punti) BETWEEN 1 AND 200 AND file_punti !~ '[[:cntrl:]]'),
      file_righe   text CONSTRAINT polim_ufficiale_caricamento_file_righe CHECK (char_length(file_righe) BETWEEN 1 AND 200 AND file_righe !~ '[[:cntrl:]]'),
      punti        integer NOT NULL CONSTRAINT polim_ufficiale_caricamento_punti CHECK (punti >= 0),
      righe        integer NOT NULL CONSTRAINT polim_ufficiale_caricamento_righe CHECK (righe >= 0)
    );
  END IF;
  IF pg_catalog.to_regclass('public.polim_abbinamenti_linee') IS NULL THEN
    CREATE TABLE public.polim_abbinamenti_linee (
      linea_ufficiale  text PRIMARY KEY CONSTRAINT polim_abbinamenti_linee_ufficiale CHECK (char_length(linea_ufficiale) BETWEEN 1 AND 40 AND linea_ufficiale !~ '[[:cntrl:]]' AND linea_ufficiale !~ '[[:lower:]]'),
      -- il codice della linea dell'azienda (quello dei GTFS); vuoto se è esclusa
      linea            text CONSTRAINT polim_abbinamenti_linee_linea CHECK (char_length(linea) BETWEEN 1 AND 64 AND linea !~ '[[:cntrl:]]'),
      -- non è una linea da confrontare: non è più dell'azienda, o è un servizio speciale
      esclusa          boolean NOT NULL DEFAULT false,
      deciso_il        timestamptz NOT NULL DEFAULT now(),
      deciso_da        uuid REFERENCES public.users(id) ON DELETE SET NULL,
      CONSTRAINT polim_abbinamenti_linee_una_scelta CHECK ((linea IS NOT NULL) <> esclusa)
    );
  END IF;
  IF pg_catalog.to_regrole('cerbero_owner') IS NOT NULL THEN
    ALTER TABLE public.polim_ufficiale_punti OWNER TO cerbero_owner;
    ALTER TABLE public.polim_ufficiale_righe OWNER TO cerbero_owner;
    ALTER TABLE public.polim_ufficiale_caricamento OWNER TO cerbero_owner;
    ALTER TABLE public.polim_abbinamenti_linee OWNER TO cerbero_owner;
  END IF;
END $polim$;
--> statement-breakpoint
SELECT registro.sorveglia('public.polim_ufficiale_punti', ARRAY['linea', 'percorso', 'direzione', 'ordine'], NULL, NULL, false, '{}', '{}', '{}', true);
--> statement-breakpoint
SELECT registro.sorveglia('public.polim_ufficiale_righe', ARRAY['linea', 'percorso', 'direzione', 'da', 'a'], NULL, NULL, false, '{}', '{}', '{}', true);
--> statement-breakpoint
SELECT registro.sorveglia('public.polim_ufficiale_caricamento', ARRAY['unica'], NULL, NULL, true, '{}', '{}', '{}');
--> statement-breakpoint
SELECT registro.sorveglia('public.polim_abbinamenti_linee', ARRAY['linea_ufficiale'], NULL, NULL, true, '{}', ARRAY['deciso_il']);
