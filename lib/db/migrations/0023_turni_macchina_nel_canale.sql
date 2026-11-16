-- ════════════════════════════════════════════════════════════════════════
-- 0023 — Il turno macchina di ogni giorno pubblicato (PR 3.6)
-- ────────────────────────────────────────────────────────────────────────
-- Il canale dei turni pubblicati (roster_turni_pubblicati) dice, per ogni
-- giorno e UDP, quali turni guida valgono (dss_id). Il turno macchina su cui
-- sono stati calcolati si ricavava solo passando dal turno guida
-- (driver_shift_scenarios.service_program_scenario_id), e i turni macchina
-- si salvavano sopra il vecchio: un giorno pubblicato poteva ritrovarsi con
-- vetture diverse da quelle dei suoi turni guida.
--
-- Da qui (contratto C2 dell'analisi):
--   - i turni macchina usati dal roster non si sovrascrivono più: salvarli
--     crea una versione nuova, come per i turni guida (l'API);
--   - il canale scrive anche il turno macchina, vss_id: per ogni giorno e UDP,
--     la coppia (turno macchina, turno guida) che vale.
--
-- Qui la colonna, riempita dalle righe che ci sono già col turno macchina del
-- loro turno guida. Obbligatoria, coerente col turno guida e non cancellabile
-- nella 0024 (DDL, da chi migra, dopo i dati scritti come cerbero_owner).
-- Lock: un attimo su roster_turni_pubblicati, una tabella piccola.
-- ════════════════════════════════════════════════════════════════════════
DO $colonna$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
                  WHERE attrelid = pg_catalog.to_regclass('public.roster_turni_pubblicati') AND attname = 'vss_id'
                    AND attnum > 0 AND NOT attisdropped) THEN
    ALTER TABLE public.roster_turni_pubblicati ADD COLUMN vss_id uuid;
  END IF;
END $colonna$;
--> statement-breakpoint
-- I dati come cerbero_owner, se le tabelle sono già sue
DO $come$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c
                  WHERE c.oid IN (pg_catalog.to_regclass('public.roster_turni_pubblicati'), pg_catalog.to_regclass('public.driver_shift_scenarios'))
                    AND c.relowner IS DISTINCT FROM pg_catalog.to_regrole('cerbero_owner')) THEN
    EXECUTE 'SET LOCAL ROLE cerbero_owner';
  END IF;
END $come$;
--> statement-breakpoint
DO $riempi$
DECLARE
  n integer;
BEGIN
  UPDATE public.roster_turni_pubblicati p
     SET vss_id = d.service_program_scenario_id
    FROM public.driver_shift_scenarios d
   WHERE d.id = p.dss_id
     AND p.vss_id IS DISTINCT FROM d.service_program_scenario_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE '0023: turno macchina scritto su % righe del canale', n;
END $riempi$;
--> statement-breakpoint
RESET ROLE;
