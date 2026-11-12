-- ============================================================
-- 0011 — Le due chiavi esterne della 0010, convalidate (PR 2.15)
--
-- La 0010 le ha messe NOT VALID e ha tolto le righe orfane: qui Postgres
-- controlla che non ne resti nessuna e segna i vincoli come validi. La
-- convalida legge la tabella figlia senza fermare letture né scritture.
-- ============================================================
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_constraint k
              WHERE k.conrelid = pg_catalog.to_regclass('public.ps_trip_category_validity')
                AND k.conname = 'ps_trip_category_validity_trip_id_fkey' AND NOT k.convalidated) THEN
    ALTER TABLE public.ps_trip_category_validity VALIDATE CONSTRAINT ps_trip_category_validity_trip_id_fkey;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_constraint k
              WHERE k.conrelid = pg_catalog.to_regclass('public.ps_no_go_zones')
                AND k.conname = 'ps_no_go_zones_project_id_fkey' AND NOT k.convalidated) THEN
    ALTER TABLE public.ps_no_go_zones VALIDATE CONSTRAINT ps_no_go_zones_project_id_fkey;
  END IF;
END $$;
