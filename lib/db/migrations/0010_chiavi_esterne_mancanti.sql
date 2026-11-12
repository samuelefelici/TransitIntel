-- ============================================================
-- 0010 — Le chiavi esterne che mancavano (PR 2.15)
--
-- Due tabelle di Planning Studio non avevano la chiave verso il loro padre:
--   ps_trip_category_validity.trip_id  → ps_trips
--   ps_no_go_zones.project_id          → ps_projects
-- Cancellando una corsa o un progetto le loro righe restavano, senza padre:
-- ogni cancellazione doveva ricordarsi di toglierle a mano, e non tutte lo
-- facevano (l'import che sostituisce le corse di un progetto, per esempio).
--
-- Qui, in quest'ordine:
--   1. i due vincoli, NOT VALID: da subito non nascono più righe senza padre e
--      la cancellazione del padre porta via le figlie (come per le tabelle
--      sorelle: ps_trip_day_validity, ps_trip_exceptions, ps_service_periods);
--   2. si tolgono le righe già orfane. Nessuna richiesta le può più leggere:
--      si arriva a loro solo dalla corsa o dal progetto, che non ci sono più.
-- La 0011 convalida i vincoli. Sono due file perché i dati si toccano come
-- cerbero_owner, e quel blocco chiude il file (README, «Chi possiede cosa»).
--
-- NON c'è la chiave su ps_trip_category_validity.category_id: una categoria
-- cancellata lascia sulle corse una riga che oggi le rende non valide in ogni
-- giorno. Toglierla o tenerla cambia il servizio: si decide a parte (DEPLOY,
-- «Chiavi esterne di Planning Studio»).
-- ============================================================
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint k
                  WHERE k.conrelid = pg_catalog.to_regclass('public.ps_trip_category_validity')
                    AND k.conname = 'ps_trip_category_validity_trip_id_fkey') THEN
    ALTER TABLE public.ps_trip_category_validity
      ADD CONSTRAINT ps_trip_category_validity_trip_id_fkey
      FOREIGN KEY (trip_id) REFERENCES public.ps_trips(id) ON DELETE CASCADE NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint k
                  WHERE k.conrelid = pg_catalog.to_regclass('public.ps_no_go_zones')
                    AND k.conname = 'ps_no_go_zones_project_id_fkey') THEN
    ALTER TABLE public.ps_no_go_zones
      ADD CONSTRAINT ps_no_go_zones_project_id_fkey
      FOREIGN KEY (project_id) REFERENCES public.ps_projects(id) ON DELETE CASCADE NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
-- Le righe orfane, come cerbero_owner se le tabelle sono già sue (su un
-- database appena creato sono ancora di chi migra: lì si resta chi si è).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c
                  WHERE c.oid IN (pg_catalog.to_regclass('public.ps_trip_category_validity'),
                                  pg_catalog.to_regclass('public.ps_no_go_zones'))
                    AND c.relowner IS DISTINCT FROM pg_catalog.to_regrole('cerbero_owner')) THEN
    EXECUTE 'SET LOCAL ROLE cerbero_owner';
  END IF;
END $$;
--> statement-breakpoint
-- Quante se ne tolgono resta scritto nel log del deploy (un WARNING: gli altri
-- livelli il migratore non li riporta). Zero righe, nessun avviso.
DO $$
DECLARE tolte bigint;
BEGIN
  DELETE FROM public.ps_trip_category_validity v
   WHERE NOT EXISTS (SELECT 1 FROM public.ps_trips t WHERE t.id = v.trip_id);
  GET DIAGNOSTICS tolte = ROW_COUNT;
  IF tolte > 0 THEN
    RAISE WARNING '0010: tolte % righe di ps_trip_category_validity di corse che non esistono più (nessuna richiesta poteva leggerle)', tolte;
  END IF;
  DELETE FROM public.ps_no_go_zones z
   WHERE NOT EXISTS (SELECT 1 FROM public.ps_projects p WHERE p.id = z.project_id);
  GET DIAGNOSTICS tolte = ROW_COUNT;
  IF tolte > 0 THEN
    RAISE WARNING '0010: tolte % zone vietate di progetti che non esistono più (nessuna richiesta poteva leggerle)', tolte;
  END IF;
END $$;
--> statement-breakpoint
RESET ROLE;
