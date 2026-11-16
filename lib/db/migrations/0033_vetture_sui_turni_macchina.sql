-- ════════════════════════════════════════════════════════════════════════
-- 0033 — Le vetture sui turni macchina del giorno (tappa 5.4)
-- ────────────────────────────────────────────────────────────────────────
-- Il capo deposito assegna una vettura (la matricola dell'AVM) a ogni turno
-- macchina di una giornata di esercizio.
--
-- Tabella a parte: i turni macchina della giornata (esercizio_turni_macchina,
-- 0026) si riscrivono da capo finché la giornata non comincia, e
-- un'assegnazione scritta lì andrebbe persa. Qui resta; se il turno macchina
-- sparisce (una nuova pubblicazione), l'assegnazione si vede «da
-- riassegnare».
--
-- La usa anche il consuntivo: alla conferma, una corsa che l'AVM non ha
-- visto prende la vettura del suo turno macchina (i km per vettura, 0030).
-- Nel registro delle modifiche, coi valori; chi ha assegnato solo come nome.
-- ════════════════════════════════════════════════════════════════════════
DO $vetture$
BEGIN
  IF pg_catalog.to_regclass('public.esercizio_vetture') IS NULL THEN
    CREATE TABLE public.esercizio_vetture (
      giorno          date NOT NULL,
      vss_id          uuid NOT NULL,
      turno_macchina  text NOT NULL,
      vettura         text NOT NULL,
      assegnata_da    uuid REFERENCES public.users(id) ON DELETE SET NULL,
      assegnata_il    timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (giorno, vss_id, turno_macchina),
      CONSTRAINT esercizio_vetture_vettura CHECK (char_length(vettura) BETWEEN 1 AND 40)
    );
  END IF;
  IF pg_catalog.to_regclass('public.idx_esercizio_vetture_vettura') IS NULL THEN
    CREATE INDEX idx_esercizio_vetture_vettura ON public.esercizio_vetture (giorno, vettura);
  END IF;
  IF pg_catalog.to_regrole('cerbero_owner') IS NOT NULL THEN
    ALTER TABLE public.esercizio_vetture OWNER TO cerbero_owner;
  END IF;
END $vetture$;
--> statement-breakpoint
SELECT registro.sorveglia('public.esercizio_vetture', ARRAY['giorno', 'vss_id', 'turno_macchina'], NULL, NULL, true, '{}', '{}', ARRAY['assegnata_da']);
