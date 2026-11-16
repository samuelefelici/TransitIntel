-- ════════════════════════════════════════════════════════════════════════
-- 0031 — Le variazioni decise in anticipo (tappa 4.10)
-- ────────────────────────────────────────────────────────────────────────
-- Fino al suo inizio una giornata si ricostruisce da capo, e il giornale si
-- scrive solo da lì (0028): una soppressione nota prima, o uno sciopero
-- proclamato, non avevano dove stare. Da qui:
--
--   esercizio_variazioni   una riga per variazione, per giorno:
--     soppressione  le corse da sopprimere: di alcune linee, eventualmente
--                   in una fascia oraria, o con certi numeri di corsa. Al
--                   congelamento diventano esiti «soppressa» nel giornale, a
--                   nome di chi le ha scritte (e da lì CANCELED nel
--                   GTFS-Realtime);
--     sciopero      le fasce garantite (e le linee, se non tutte): le corse
--                   fuori fascia non si sopprimono in anticipo, ma la
--                   proposta dall'AVM non le dà per «non rilevate» e la
--                   presunzione di effettuazione non le tocca.
--
-- Una variazione si annulla, con chi e quando, finché la giornata non è
-- cominciata; dopo si corregge nel giornale. Il giorno non ha chiave esterna:
-- le giornate future non sono ancora preparate.
-- ════════════════════════════════════════════════════════════════════════
DO $variazioni$
BEGIN
  IF pg_catalog.to_regclass('public.esercizio_variazioni') IS NULL THEN
    CREATE TABLE public.esercizio_variazioni (
      id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      giorno        date NOT NULL,
      tipo          text NOT NULL,
      -- soppressione: linee e/o numeri di corsa, con la fascia (dalle, alle) se c'è
      linee         text[] NOT NULL DEFAULT '{}',
      numeri        text[] NOT NULL DEFAULT '{}',
      dalle         text,
      alle          text,
      -- sciopero: le fasce garantite, [{"dalle": "06:00", "alle": "09:00"}, ...]
      fasce         jsonb,
      causale       text NOT NULL REFERENCES public.esercizio_causali(codice) ON DELETE RESTRICT,
      nota          text,
      creata_da     uuid REFERENCES public.users(id) ON DELETE SET NULL,
      creata_il     timestamptz NOT NULL DEFAULT now(),
      annullata_da  uuid REFERENCES public.users(id) ON DELETE SET NULL,
      annullata_il  timestamptz,
      -- applicata alla giornata congelata: l'evento del giornale che ne è nato e quante corse
      applicata_il  timestamptz,
      evento        bigint REFERENCES public.esercizio_eventi(id) ON DELETE RESTRICT,
      corse         integer,
      CONSTRAINT esercizio_variazioni_tipo CHECK (tipo IN ('soppressione', 'sciopero')),
      CONSTRAINT esercizio_variazioni_fascia CHECK ((dalle IS NULL) = (alle IS NULL)),
      CONSTRAINT esercizio_variazioni_fasce CHECK ((tipo = 'sciopero') = (fasce IS NOT NULL)),
      CONSTRAINT esercizio_variazioni_nota CHECK (nota IS NULL OR char_length(nota) <= 500),
      CONSTRAINT esercizio_variazioni_stato CHECK (annullata_il IS NULL OR applicata_il IS NULL),
      CONSTRAINT esercizio_variazioni_corse CHECK (corse IS NULL OR corse >= 0)
    );
  END IF;
  IF pg_catalog.to_regclass('public.idx_esercizio_variazioni_giorno') IS NULL THEN
    CREATE INDEX idx_esercizio_variazioni_giorno ON public.esercizio_variazioni (giorno, id);
  END IF;
  IF pg_catalog.to_regrole('cerbero_owner') IS NOT NULL THEN
    ALTER TABLE public.esercizio_variazioni OWNER TO cerbero_owner;
  END IF;
END $variazioni$;
