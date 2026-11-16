-- ════════════════════════════════════════════════════════════════════════
-- 0027 — La proposta dall'AVM (tappa 4.4)
-- ────────────────────────────────────────────────────────────────────────
-- Per ogni corsa programmata di una giornata congelata, l'esito che le prove
-- dell'AVM suggeriscono, con le prove accanto. È una PROPOSTA: la conferma è
-- di una persona (giornale e conferma, tappa successiva). Una corsa senza
-- prove resta «non rilevata»: non diventa mai «soppressa» da sola.
--
--   esercizio_corse.proposta    effettuata_avm, parziale, continuita,
--                               da_verificare, soppressione_indizio,
--                               non_rilevata (NULL: non ancora proposta);
--   esercizio_corse.prove       le prove in breve: come la corsa è stata
--                               riconosciuta (id, codice, numero), fermate
--                               osservate su quelle programmate, prima e
--                               ultima, vetture, partenza reale;
--   esercizio_giornate.proposta il riepilogo: soglie usate, conteggi,
--                               copertura, definitiva o no;
--   esercizio_aggiunte_proposte i viaggi dell'AVM che non si riconducono a
--                               nessuna corsa del programmato: candidate
--                               corse aggiunte, da confermare.
-- ════════════════════════════════════════════════════════════════════════
DO $proposta$
BEGIN
  ALTER TABLE public.esercizio_giornate ADD COLUMN IF NOT EXISTS proposta jsonb;

  ALTER TABLE public.esercizio_corse
    ADD COLUMN IF NOT EXISTS proposta text,
    ADD COLUMN IF NOT EXISTS prove    jsonb;

  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
                  WHERE conrelid = 'public.esercizio_corse'::regclass AND conname = 'esercizio_corse_proposta') THEN
    ALTER TABLE public.esercizio_corse ADD CONSTRAINT esercizio_corse_proposta CHECK (proposta IS NULL OR proposta IN
      ('effettuata_avm', 'parziale', 'continuita', 'da_verificare', 'soppressione_indizio', 'non_rilevata'));
  END IF;

  IF pg_catalog.to_regclass('public.esercizio_aggiunte_proposte') IS NULL THEN
    CREATE TABLE public.esercizio_aggiunte_proposte (
      giorno        date NOT NULL REFERENCES public.esercizio_giornate(giorno) ON DELETE CASCADE,
      chiave_avm    text NOT NULL,
      journey_ref   text,
      trip_id_avm   text,
      linea         text,
      numero        text,
      partenza      text,
      destinazione  text,
      vetture       text[] NOT NULL DEFAULT '{}',
      transiti      integer NOT NULL DEFAULT 0,
      osservazioni  integer NOT NULL DEFAULT 0,
      PRIMARY KEY (giorno, chiave_avm),
      CONSTRAINT esercizio_aggiunte_proposte_conteggi CHECK (transiti >= 0 AND osservazioni >= 0)
    );
  END IF;

  IF pg_catalog.to_regrole('cerbero_owner') IS NOT NULL THEN
    ALTER TABLE public.esercizio_aggiunte_proposte OWNER TO cerbero_owner;
  END IF;
END $proposta$;
