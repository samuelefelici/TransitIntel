-- ══════════════════════════════════════════════════════════════════════
-- 0056 — I punti tariffari della bigliettazione sulle fermate (tappa 6.34b)
-- ──────────────────────────────────────────────────────────────────────
-- Dopo aver abbinato le linee (0055) si confronta punto per punto: ogni
-- percorso di una linea della bigliettazione corrisponde a un percorso
-- dell'azienda, e ogni suo punto tariffario a una fermata di quel percorso.
-- Da lì escono i km nuovi dei punti e le fasce nuove delle coppie, da
-- mettere accanto a quelle della bigliettazione.
--   polim_abbinamenti_percorsi  per un percorso della bigliettazione (linea,
--                               percorso, direzione): il percorso dell'azienda
--                               (linea dei GTFS e variante) e il verso in cui
--                               si legge (AB com'è, BA al contrario)
--   polim_abbinamenti_punti     per ogni suo punto (per ordine): la fermata.
--                               Vuota: il punto non ha una fermata su quel
--                               percorso (non c'è più, o non è servito)
-- Le proposte le fa l'API (stesso codice, stesso nome); qui restano le
-- decisioni di chi lavora alle tariffe. Nel registro delle modifiche, col
-- valore.
-- ══════════════════════════════════════════════════════════════════════
DO $punti$
BEGIN
  IF pg_catalog.to_regclass('public.polim_abbinamenti_percorsi') IS NULL THEN
    CREATE TABLE public.polim_abbinamenti_percorsi (
      linea_ufficiale  text NOT NULL CONSTRAINT polim_abbinamenti_percorsi_linea CHECK (char_length(linea_ufficiale) BETWEEN 1 AND 40 AND linea_ufficiale !~ '[[:cntrl:]]' AND linea_ufficiale !~ '[[:lower:]]'),
      percorso         text NOT NULL CONSTRAINT polim_abbinamenti_percorsi_percorso CHECK (char_length(percorso) BETWEEN 1 AND 40 AND percorso !~ '[[:cntrl:]]'),
      direzione        text NOT NULL CONSTRAINT polim_abbinamenti_percorsi_direzione CHECK (char_length(direzione) BETWEEN 1 AND 10 AND direzione !~ '[[:cntrl:]]'),
      -- il percorso dell'azienda: la linea dei GTFS e la sua variante
      route_id         text NOT NULL CONSTRAINT polim_abbinamenti_percorsi_route CHECK (char_length(route_id) BETWEEN 1 AND 200 AND route_id !~ '[[:cntrl:]]'),
      variant_id       text NOT NULL CONSTRAINT polim_abbinamenti_percorsi_variante CHECK (char_length(variant_id) BETWEEN 1 AND 64 AND variant_id !~ '[[:cntrl:]]'),
      -- AB: le fermate nell'ordine del percorso; BA: al contrario, coi km contati dall'altro capo
      verso            text NOT NULL CONSTRAINT polim_abbinamenti_percorsi_verso CHECK (verso IN ('AB', 'BA')),
      deciso_il        timestamptz NOT NULL DEFAULT now(),
      deciso_da        uuid REFERENCES public.users(id) ON DELETE SET NULL,
      CONSTRAINT polim_abbinamenti_percorsi_pkey PRIMARY KEY (linea_ufficiale, percorso, direzione)
    );
  END IF;
  IF pg_catalog.to_regclass('public.polim_abbinamenti_punti') IS NULL THEN
    CREATE TABLE public.polim_abbinamenti_punti (
      linea_ufficiale  text NOT NULL,
      percorso         text NOT NULL,
      direzione        text NOT NULL,
      ordine           integer NOT NULL CONSTRAINT polim_abbinamenti_punti_ordine CHECK (ordine BETWEEN 1 AND 100000),
      -- la fermata del percorso dell'azienda; vuota: il punto non ha una fermata su quel percorso
      fermata          text CONSTRAINT polim_abbinamenti_punti_fermata CHECK (char_length(fermata) BETWEEN 1 AND 200 AND fermata !~ '[[:cntrl:]]'),
      CONSTRAINT polim_abbinamenti_punti_pkey PRIMARY KEY (linea_ufficiale, percorso, direzione, ordine),
      CONSTRAINT polim_abbinamenti_punti_percorso FOREIGN KEY (linea_ufficiale, percorso, direzione)
        REFERENCES public.polim_abbinamenti_percorsi (linea_ufficiale, percorso, direzione) ON DELETE CASCADE
    );
  END IF;
  IF pg_catalog.to_regrole('cerbero_owner') IS NOT NULL THEN
    ALTER TABLE public.polim_abbinamenti_percorsi OWNER TO cerbero_owner;
    ALTER TABLE public.polim_abbinamenti_punti OWNER TO cerbero_owner;
  END IF;
END $punti$;
--> statement-breakpoint
SELECT registro.sorveglia('public.polim_abbinamenti_percorsi', ARRAY['linea_ufficiale', 'percorso', 'direzione'], NULL, NULL, true, '{}', ARRAY['deciso_il']);
--> statement-breakpoint
SELECT registro.sorveglia('public.polim_abbinamenti_punti', ARRAY['linea_ufficiale', 'percorso', 'direzione', 'ordine'], NULL, NULL, true, '{}', '{}');
