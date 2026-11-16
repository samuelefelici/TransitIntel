-- ════════════════════════════════════════════════════════════════════════
-- 0024 — Le regole del turno macchina pubblicato, nel database (PR 3.6)
-- ────────────────────────────────────────────────────────────────────────
-- La 0023 ha scritto il turno macchina (vss_id) su ogni riga del canale. Da
-- qui il database tiene:
--
--   vss_id obbligatorio            ogni giorno pubblicato ha il suo turno
--                                  macchina;
--   roster_turni_pubblicati_coppia (dss_id, vss_id) è un turno guida col SUO
--                                  turno macchina: non si può pubblicare un
--                                  turno guida con le vetture di un altro;
--   ON DELETE RESTRICT             un turno macchina pubblicato non si
--                                  cancella (prima lo fermava solo la cascata
--                                  sul turno guida).
--
-- La coppia ha bisogno di una chiave unica su driver_shift_scenarios
-- (id, service_program_scenario_id): id è già unico, quindi ogni riga la
-- rispetta. L'indice serve a chi legge il canale per turno macchina.
-- Lock: un attimo su roster_turni_pubblicati e driver_shift_scenarios, tabelle
-- piccole; i vincoli leggono le righe una volta.
-- ════════════════════════════════════════════════════════════════════════
DO $regole$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
                  WHERE conrelid = pg_catalog.to_regclass('public.driver_shift_scenarios')
                    AND conname = 'driver_shift_scenarios_con_turni_macchina') THEN
    ALTER TABLE public.driver_shift_scenarios ADD CONSTRAINT driver_shift_scenarios_con_turni_macchina
      UNIQUE (id, service_program_scenario_id);
  END IF;
  ALTER TABLE public.roster_turni_pubblicati ALTER COLUMN vss_id SET NOT NULL;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
                  WHERE conrelid = pg_catalog.to_regclass('public.roster_turni_pubblicati')
                    AND conname = 'roster_turni_pubblicati_coppia') THEN
    ALTER TABLE public.roster_turni_pubblicati ADD CONSTRAINT roster_turni_pubblicati_coppia
      FOREIGN KEY (dss_id, vss_id) REFERENCES public.driver_shift_scenarios (id, service_program_scenario_id)
      ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
                  WHERE conrelid = pg_catalog.to_regclass('public.roster_turni_pubblicati')
                    AND conname = 'roster_turni_pubblicati_vss_id_fkey') THEN
    ALTER TABLE public.roster_turni_pubblicati ADD CONSTRAINT roster_turni_pubblicati_vss_id_fkey
      FOREIGN KEY (vss_id) REFERENCES public.service_program_scenarios (id) ON DELETE RESTRICT;
  END IF;
  IF pg_catalog.to_regclass('public.idx_roster_turni_pubblicati_vss') IS NULL THEN
    CREATE INDEX idx_roster_turni_pubblicati_vss ON public.roster_turni_pubblicati (vss_id, day) WHERE sostituita_da IS NULL;
  END IF;
END $regole$;
