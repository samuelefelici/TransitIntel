-- ════════════════════════════════════════════════════════════════════════
-- 0028 — Il giornale di esercizio e la conferma degli esiti (tappa 4.5)
-- ────────────────────────────────────────────────────────────────────────
-- La proposta dall'AVM (0027) suggerisce; da qui una persona decide.
--
--   esercizio_causali   il catalogo delle causali: descrizione, gruppo, se è
--                       imputabile all'azienda, il codice per l'ente (vuoto
--                       finché non lo si sa), attiva, ordine. Un catalogo
--                       iniziale, che l'amministratore cambia;
--   esercizio_eventi    il giornale della giornata, solo in aggiunta: un
--                       evento sbagliato si annulla con un altro evento
--                       (annulla → l'evento annullato, una volta sola).
--                       Ogni evento ha autore, momento, fonte, le corse che
--                       tocca e com'erano prima. Fa da registro del
--                       consuntivo;
--   esercizio_corse     in più l'esito confermato (effettuata, parziale,
--                       soppressa, da verificare), i km effettivi, la causale,
--                       la vettura, una nota, chi l'ha confermato e quando;
--                       le corse aggiunte (origine «aggiunta», con il tipo);
--   esercizio_giornate  in più la versione, per le scritture concorrenti: chi
--                       scrive dice quale versione ha visto.
--
-- Il codice non aggiorna né cancella gli eventi: lo scrive solo
-- lib/esercizio-giornale.ts. La giornata non si cancella se ha eventi
-- (ON DELETE RESTRICT).
-- ════════════════════════════════════════════════════════════════════════
DO $giornale$
BEGIN
  IF pg_catalog.to_regclass('public.esercizio_causali') IS NULL THEN
    CREATE TABLE public.esercizio_causali (
      codice              text PRIMARY KEY,
      descrizione         text NOT NULL,
      gruppo              text NOT NULL DEFAULT 'altro',
      imputabile_azienda  boolean NOT NULL DEFAULT true,
      codice_ente         text,
      attiva              boolean NOT NULL DEFAULT true,
      ordine              integer NOT NULL DEFAULT 0,
      CONSTRAINT esercizio_causali_codice CHECK (codice ~ '^[A-Z0-9_]{1,30}$'),
      CONSTRAINT esercizio_causali_gruppo CHECK (gruppo IN ('mezzo', 'personale', 'esterna', 'servizio', 'altro')),
      CONSTRAINT esercizio_causali_testi CHECK (length(descrizione) BETWEEN 1 AND 120 AND (codice_ente IS NULL OR length(codice_ente) <= 30))
    );
  END IF;

  ALTER TABLE public.esercizio_giornate ADD COLUMN IF NOT EXISTS versione integer NOT NULL DEFAULT 0;

  ALTER TABLE public.esercizio_corse
    ADD COLUMN IF NOT EXISTS origine        text NOT NULL DEFAULT 'programmata',
    ADD COLUMN IF NOT EXISTS tipo_aggiunta  text,
    ADD COLUMN IF NOT EXISTS esito          text,
    ADD COLUMN IF NOT EXISTS km_eff         numeric(9, 3),
    ADD COLUMN IF NOT EXISTS causale        text REFERENCES public.esercizio_causali(codice) ON DELETE RESTRICT,
    ADD COLUMN IF NOT EXISTS vettura        text,
    ADD COLUMN IF NOT EXISTS nota           text,
    ADD COLUMN IF NOT EXISTS confermata_da  uuid REFERENCES public.users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS confermata_il  timestamptz;

  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'public.esercizio_corse'::regclass AND conname = 'esercizio_corse_esito') THEN
    ALTER TABLE public.esercizio_corse
      ADD CONSTRAINT esercizio_corse_origine CHECK (origine IN ('programmata', 'aggiunta')),
      ADD CONSTRAINT esercizio_corse_aggiunta CHECK ((origine = 'aggiunta') = (tipo_aggiunta IS NOT NULL)
                                                     AND (tipo_aggiunta IS NULL OR tipo_aggiunta IN ('bis', 'recupero', 'sostitutiva', 'fuori_programma'))),
      ADD CONSTRAINT esercizio_corse_esito CHECK (esito IS NULL OR esito IN ('effettuata', 'parziale', 'soppressa', 'da_verificare')),
      -- soppressa e parziale dicono perché
      ADD CONSTRAINT esercizio_corse_causale CHECK (esito IS NULL OR esito NOT IN ('soppressa', 'parziale') OR causale IS NOT NULL),
      -- un esito ha sempre il suo momento di conferma
      ADD CONSTRAINT esercizio_corse_conferma CHECK ((esito IS NULL) = (confermata_il IS NULL)),
      ADD CONSTRAINT esercizio_corse_km_eff CHECK (km_eff IS NULL OR km_eff >= 0),
      ADD CONSTRAINT esercizio_corse_nota CHECK (nota IS NULL OR length(nota) <= 500);
  END IF;

  IF pg_catalog.to_regclass('public.esercizio_eventi') IS NULL THEN
    CREATE TABLE public.esercizio_eventi (
      id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      giorno    date NOT NULL REFERENCES public.esercizio_giornate(giorno) ON DELETE RESTRICT,
      ts        timestamptz NOT NULL DEFAULT now(),
      tipo      text NOT NULL,
      chiavi    text[] NOT NULL DEFAULT '{}',
      dati      jsonb NOT NULL DEFAULT '{}'::jsonb,
      causale   text REFERENCES public.esercizio_causali(codice) ON DELETE RESTRICT,
      fonte     text NOT NULL,
      autore    uuid REFERENCES public.users(id) ON DELETE SET NULL,
      annulla   bigint REFERENCES public.esercizio_eventi(id) ON DELETE RESTRICT,
      CONSTRAINT esercizio_eventi_tipo CHECK (tipo IN ('esito', 'conferma', 'aggiunta', 'annullamento', 'cancellazione_avm', 'nota')),
      CONSTRAINT esercizio_eventi_fonte CHECK (fonte IN ('centrale', 'deposito', 'movimento', 'avm', 'sistema')),
      CONSTRAINT esercizio_eventi_annullamento CHECK ((tipo = 'annullamento') = (annulla IS NOT NULL))
    );
  END IF;
  IF pg_catalog.to_regclass('public.uq_esercizio_eventi_annullato') IS NULL THEN
    -- un evento si annulla una volta sola
    CREATE UNIQUE INDEX uq_esercizio_eventi_annullato ON public.esercizio_eventi (annulla) WHERE annulla IS NOT NULL;
  END IF;
  IF pg_catalog.to_regclass('public.idx_esercizio_eventi_giorno') IS NULL THEN
    CREATE INDEX idx_esercizio_eventi_giorno ON public.esercizio_eventi (giorno, id);
  END IF;

  IF pg_catalog.to_regrole('cerbero_owner') IS NOT NULL THEN
    ALTER TABLE public.esercizio_causali OWNER TO cerbero_owner;
    ALTER TABLE public.esercizio_eventi OWNER TO cerbero_owner;
  END IF;
END $giornale$;
--> statement-breakpoint
DO $come$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c
                  WHERE c.oid = pg_catalog.to_regclass('public.esercizio_causali')
                    AND c.relowner IS DISTINCT FROM pg_catalog.to_regrole('cerbero_owner')) THEN
    EXECUTE 'SET LOCAL ROLE cerbero_owner';
  END IF;
END $come$;
--> statement-breakpoint
-- il catalogo iniziale (decisione aperta 5): l'amministratore lo cambia; il
-- codice per l'ente resta vuoto finché non lo si sa
INSERT INTO public.esercizio_causali (codice, descrizione, gruppo, imputabile_azienda, ordine) VALUES
  ('GUASTO_MEZZO',        'Guasto del mezzo',              'mezzo',     true,  10),
  ('SINISTRO',            'Sinistro',                      'mezzo',     true,  20),
  ('MANCANZA_PERSONALE',  'Mancanza di personale',         'personale', true,  30),
  ('SCIOPERO',            'Sciopero',                      'personale', false, 40),
  ('TRAFFICO',            'Traffico o strada interrotta',  'esterna',   false, 50),
  ('METEO',               'Condizioni meteo',              'esterna',   false, 60),
  ('ORDINE_AUTORITA',     'Ordine dell''autorità',         'esterna',   false, 70),
  ('MANIFESTAZIONE',      'Manifestazione o evento',       'esterna',   false, 80),
  ('ALTRO',               'Altro (dirlo nella nota)',      'altro',     true,  90)
ON CONFLICT (codice) DO NOTHING;
--> statement-breakpoint
RESET ROLE;
