-- ════════════════════════════════════════════════════════════════════════
-- 0021 — Le versioni pubblicate dei programmi (PR 3.3)
-- ────────────────────────────────────────────────────────────────────────
-- Stampa orari, quadri di palina, mappa orari pubblica (il QR alle paline) e
-- mappa di rete condivisa leggevano il progetto di Planning Studio così com'è
-- in quel momento: una modifica di bozza finiva subito negli orari al
-- pubblico, anche se il programma in esercizio era un altro.
--
-- Da qui, quando un programma va in esercizio (o si programma la sua messa in
-- esercizio), se ne fa una COPIA CONGELATA: un altro ps_projects, con le sue
-- corse, fermate, linee e validità. È la versione pubblicata. Stampa e link
-- pubblici leggono quella; il progetto resta la bozza su cui si lavora.
--
--   versione_di         il progetto da cui è stata copiata (diventa vuoto se
--                       il progetto si cancella: la versione resta, è
--                       storia di quello che è stato in esercizio)
--   versione_del_feed   il feed GTFS materializzato insieme a lei: è quello
--                       che dice se la versione è in esercizio (il feed
--                       acceso) o programmata (il feed di
--                       ps_pending_activations). Uno per versione.
--
-- Una versione non ha proprietario: così nessuno la vede fra i suoi progetti
-- e nessuno la apre per modificarla (l'accesso ai progetti passa dal
-- proprietario o dai membri). Per questo owner_user_id diventa facoltativo,
-- ma solo per le versioni: lo dice un vincolo.
--
-- Nessun dato da toccare: le versioni nascono dalla prossima messa in
-- esercizio. Lock: un attimo su ps_projects (colonne nuove senza default,
-- vincoli che leggono la tabella, poche righe).
-- ════════════════════════════════════════════════════════════════════════
DO $versioni$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
                  WHERE attrelid = pg_catalog.to_regclass('public.ps_projects') AND attname = 'versione_di'
                    AND attnum > 0 AND NOT attisdropped) THEN
    ALTER TABLE public.ps_projects ADD COLUMN versione_di uuid;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
                  WHERE attrelid = pg_catalog.to_regclass('public.ps_projects') AND attname = 'versione_del_feed'
                    AND attnum > 0 AND NOT attisdropped) THEN
    ALTER TABLE public.ps_projects ADD COLUMN versione_del_feed uuid;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
                  WHERE conrelid = pg_catalog.to_regclass('public.ps_projects') AND conname = 'ps_projects_versione_di_fkey') THEN
    ALTER TABLE public.ps_projects ADD CONSTRAINT ps_projects_versione_di_fkey
      FOREIGN KEY (versione_di) REFERENCES public.ps_projects(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
                  WHERE conrelid = pg_catalog.to_regclass('public.ps_projects') AND conname = 'ps_projects_una_versione_per_feed') THEN
    ALTER TABLE public.ps_projects ADD CONSTRAINT ps_projects_una_versione_per_feed UNIQUE (versione_del_feed);
  END IF;
  -- una versione è tale per il suo feed; chi è copiato da un progetto è una versione
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
                  WHERE conrelid = pg_catalog.to_regclass('public.ps_projects') AND conname = 'ps_projects_versione_coerente') THEN
    ALTER TABLE public.ps_projects ADD CONSTRAINT ps_projects_versione_coerente
      CHECK (versione_di IS NULL OR versione_del_feed IS NOT NULL);
  END IF;
  -- senza proprietario solo le versioni
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
                  WHERE conrelid = pg_catalog.to_regclass('public.ps_projects') AND conname = 'ps_projects_proprietario') THEN
    ALTER TABLE public.ps_projects ADD CONSTRAINT ps_projects_proprietario
      CHECK (owner_user_id IS NOT NULL OR versione_del_feed IS NOT NULL);
  END IF;
  ALTER TABLE public.ps_projects ALTER COLUMN owner_user_id DROP NOT NULL;
  IF pg_catalog.to_regclass('public.ps_projects_versioni') IS NULL THEN
    CREATE INDEX ps_projects_versioni ON public.ps_projects (versione_di) WHERE versione_di IS NOT NULL;
  END IF;
END $versioni$;
