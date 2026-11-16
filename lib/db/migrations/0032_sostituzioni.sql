-- ════════════════════════════════════════════════════════════════════════
-- 0032 — Le sostituzioni per assenza (tappa 5.1)
-- ────────────────────────────────────────────────────────────────────────
-- Un'assenza (non il riposo) del conducente assegnato libera il turno: lo
-- calcola il tabellone dalle voci del roster, senza scrivere niente, così se
-- l'assenza si toglie e nessuno ha coperto il turno il titolare torna.
--
-- Quando il turno passa a un sostituto, l'assegnazione lo ricorda:
--   titolare_id   il conducente che il turno aveva prima dell'assenza;
--   sostituzione  chi ha deciso la sostituzione, quando, e perché
--                 ("assenza": il codice dell'assenza non si scrive qui, è un
--                 dato che vede solo chi ha il permesso del roster).
-- Una riassegnazione normale (il titolare non è assente) le svuota.
-- La tabella è già nel registro delle modifiche (0006, solo i nomi dei campi).
-- ════════════════════════════════════════════════════════════════════════
DO $sostituzioni$
BEGIN
  ALTER TABLE public.roster_assignments
    ADD COLUMN IF NOT EXISTS titolare_id uuid,
    ADD COLUMN IF NOT EXISTS sostituzione jsonb;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
                  WHERE conrelid = 'public.roster_assignments'::regclass AND conname = 'roster_assignments_titolare_fkey') THEN
    ALTER TABLE public.roster_assignments
      ADD CONSTRAINT roster_assignments_titolare_fkey FOREIGN KEY (titolare_id) REFERENCES public.roster_drivers(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
                  WHERE conrelid = 'public.roster_assignments'::regclass AND conname = 'roster_assignments_sostituzione') THEN
    -- il titolare può sparire dall'anagrafica (SET NULL): la sostituzione resta come traccia
    ALTER TABLE public.roster_assignments
      ADD CONSTRAINT roster_assignments_sostituzione CHECK (titolare_id IS NULL OR sostituzione IS NOT NULL);
  END IF;
END $sostituzioni$;
