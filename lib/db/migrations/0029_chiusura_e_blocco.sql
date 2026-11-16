-- ════════════════════════════════════════════════════════════════════════
-- 0029 — Chiusura e blocco del consuntivo (tappa 4.6)
-- ────────────────────────────────────────────────────────────────────────
-- Decisioni del 16/11/2026:
--   - le corse senza prove dell'AVM si chiudono con la PRESUNZIONE di
--     effettuazione salvo segnalazione: un esito a sé, «presunta», distinto
--     dalle effettuate provate (decisione aperta 1);
--   - la giornata la chiude chi ha il ruolo Amministrazione (o
--     l'amministratore); la riapre solo l'amministratore, con un motivo che
--     resta nel giornale;
--   - il mese lo chiude e lo riapre solo l'amministratore; un mese chiuso
--     blocca la riapertura dei suoi giorni.
--
--   esercizio_corse.esito      in più «presunta»;
--   esercizio_giornate         stato in più «chiusa», chi e quando, il
--                              riepilogo congelato alla chiusura;
--   esercizio_eventi.tipo      in più «chiusura» e «riapertura»;
--   esercizio_mesi             un mese chiuso (o riaperto): stato, riepilogo
--                              congelato, chi e quando, e la sua storia.
-- ════════════════════════════════════════════════════════════════════════
DO $chiusura$
BEGIN
  ALTER TABLE public.esercizio_corse DROP CONSTRAINT IF EXISTS esercizio_corse_esito;
  ALTER TABLE public.esercizio_corse ADD CONSTRAINT esercizio_corse_esito
    CHECK (esito IS NULL OR esito IN ('effettuata', 'presunta', 'parziale', 'soppressa', 'da_verificare'));

  ALTER TABLE public.esercizio_giornate
    ADD COLUMN IF NOT EXISTS chiusa_da  uuid REFERENCES public.users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS chiusa_il  timestamptz,
    ADD COLUMN IF NOT EXISTS riepilogo  jsonb;
  ALTER TABLE public.esercizio_giornate DROP CONSTRAINT IF EXISTS esercizio_giornate_stato;
  ALTER TABLE public.esercizio_giornate ADD CONSTRAINT esercizio_giornate_stato CHECK (stato IN ('preparata', 'congelata', 'chiusa'));
  -- una giornata chiusa è stata congelata
  ALTER TABLE public.esercizio_giornate DROP CONSTRAINT IF EXISTS esercizio_giornate_congelamento;
  ALTER TABLE public.esercizio_giornate ADD CONSTRAINT esercizio_giornate_congelamento
    CHECK ((stato IN ('congelata', 'chiusa')) = (congelata_il IS NOT NULL));
  ALTER TABLE public.esercizio_giornate DROP CONSTRAINT IF EXISTS esercizio_giornate_chiusura;
  ALTER TABLE public.esercizio_giornate ADD CONSTRAINT esercizio_giornate_chiusura
    CHECK ((stato = 'chiusa') = (chiusa_il IS NOT NULL) AND (stato = 'chiusa') = (riepilogo IS NOT NULL));

  ALTER TABLE public.esercizio_eventi DROP CONSTRAINT IF EXISTS esercizio_eventi_tipo;
  ALTER TABLE public.esercizio_eventi ADD CONSTRAINT esercizio_eventi_tipo
    CHECK (tipo IN ('esito', 'conferma', 'aggiunta', 'annullamento', 'cancellazione_avm', 'nota', 'chiusura', 'riapertura'));

  IF pg_catalog.to_regclass('public.esercizio_mesi') IS NULL THEN
    CREATE TABLE public.esercizio_mesi (
      -- il primo giorno del mese
      mese       date PRIMARY KEY,
      stato      text NOT NULL,
      riepilogo  jsonb,
      chiuso_da  uuid REFERENCES public.users(id) ON DELETE SET NULL,
      chiuso_il  timestamptz,
      -- chiusure e riaperture: chi, quando, perché
      storia     jsonb NOT NULL DEFAULT '[]'::jsonb,
      CONSTRAINT esercizio_mesi_stato CHECK (stato IN ('aperto', 'chiuso')),
      CONSTRAINT esercizio_mesi_chiusura CHECK ((stato = 'chiuso') = (chiuso_il IS NOT NULL) AND (stato = 'chiuso') = (riepilogo IS NOT NULL))
    );
  END IF;
  IF pg_catalog.to_regrole('cerbero_owner') IS NOT NULL THEN
    ALTER TABLE public.esercizio_mesi OWNER TO cerbero_owner;
  END IF;
END $chiusura$;
