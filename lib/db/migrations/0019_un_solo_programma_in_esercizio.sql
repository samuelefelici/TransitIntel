-- ════════════════════════════════════════════════════════════════════════
-- 0019 — Un solo programma in esercizio, sempre nello storico (PR 3.2)
-- ────────────────────────────────────────────────────────────────────────
-- Il programma in esercizio è il feed GTFS che leggono AVM, tariffe, turni e
-- le pagine dell'esercizio (gtfs_feeds.is_active). Fino a qui lo cambiavano
-- due porte diverse:
--   - «Metti in esercizio» di Planning Studio spegneva solo i feed dello
--     stesso proprietario (ne potevano restare due accesi) e scriveva lo
--     storico (ps_activation_log) «se riusciva»;
--   - «Attiva» nella pagina GTFS spegneva tutti gli altri, ma non scriveva lo
--     storico.
-- Da qui c'è una porta sola (artifacts/api-server/src/lib/esercizio-porta.ts)
-- e il database tiene le due regole:
--
--   gtfs_feeds                 al più un feed acceso (is_active), in tutta
--                              l'installazione: un'azienda, un programma in
--                              esercizio;
--   ps_activation_log          al più un periodo aperto (deactivated_at NULL),
--                              quello del feed acceso. È lo storico che dice
--                              quale programma era in esercizio in un giorno.
--     project_id               ora facoltativo: un GTFS caricato a mano non ha
--                              progetto. Se il progetto si cancella resta la
--                              riga, senza progetto (prima se ne andava con
--                              lui, e con lei lo storico).
--     via                      il canale di chi ha attivato (api, argos:…,
--                              timer:attivazioni…), come in coda.lavori.
--
-- Qui le colonne e lo stato di oggi messo in regola; i due vincoli e la
-- sorveglianza del registro sono nella 0020 (DDL, da chi migra, dopo i dati
-- scritti come cerbero_owner: README, «Chi possiede cosa»).
--
-- I due vincoli sono differiti alla fine della transazione: chi cambia il
-- feed acceso spegne il vecchio e accende il nuovo, e solo il risultato deve
-- avere un feed acceso. Così passa anche il codice di prima, che durante il
-- deploy serve ancora e cambia il feed con un UPDATE solo; fallisce soltanto
-- se lascerebbe due feed accesi (il «Metti in esercizio» di prima, quando il
-- feed acceso è di un altro proprietario).
--
-- Lo stato di oggi si mette in regola qui, senza cambiare il feed che legge
-- l'AVM: resta acceso quello che l'AVM sceglie già (fra gli accesi, l'ultimo
-- caricato), gli altri si spengono, e diventa anche quello «di default». Ogni
-- feed spento e ogni periodo chiuso finisce nel log del deploy con un
-- WARNING. Se il feed acceso non ha un periodo aperto (era stato attivato
-- dalla pagina GTFS) se ne apre uno da adesso, con via «migrazione:0019».
--
-- Lock: tabelle piccole (feed e periodi). Il vincolo sul progetto si rifà e
-- legge tutto lo storico: righe quante sono le attivazioni.
-- ════════════════════════════════════════════════════════════════════════
DO $storico$
BEGIN
  ALTER TABLE public.ps_activation_log ALTER COLUMN project_id DROP NOT NULL;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
                  WHERE attrelid = pg_catalog.to_regclass('public.ps_activation_log') AND attname = 'via'
                    AND attnum > 0 AND NOT attisdropped) THEN
    ALTER TABLE public.ps_activation_log ADD COLUMN via text;
  END IF;
  -- lo storico resta anche se il progetto si cancella
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
              WHERE conrelid = pg_catalog.to_regclass('public.ps_activation_log')
                AND conname = 'ps_activation_log_project_id_fkey' AND confdeltype <> 'n') THEN
    ALTER TABLE public.ps_activation_log DROP CONSTRAINT ps_activation_log_project_id_fkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
                  WHERE conrelid = pg_catalog.to_regclass('public.ps_activation_log')
                    AND conname = 'ps_activation_log_project_id_fkey') THEN
    ALTER TABLE public.ps_activation_log ADD CONSTRAINT ps_activation_log_project_id_fkey
      FOREIGN KEY (project_id) REFERENCES public.ps_projects(id) ON DELETE SET NULL;
  END IF;
END $storico$;
--> statement-breakpoint
-- I dati come cerbero_owner, se le tre tabelle sono già sue (su un database
-- appena creato in un cluster che ha già i ruoli sono ancora di chi migra).
DO $come$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c
                  WHERE c.oid IN (pg_catalog.to_regclass('public.gtfs_feeds'), pg_catalog.to_regclass('public.ps_activation_log'),
                                  pg_catalog.to_regclass('public.ps_projects'))
                    AND c.relowner IS DISTINCT FROM pg_catalog.to_regrole('cerbero_owner')) THEN
    EXECUTE 'SET LOCAL ROLE cerbero_owner';
  END IF;
END $come$;
--> statement-breakpoint
DO $in_regola$
DECLARE
  acceso uuid;
  r record;
  n bigint;
BEGIN
  -- il feed che l'AVM legge oggi: fra gli accesi, l'ultimo caricato
  SELECT f.id INTO acceso FROM public.gtfs_feeds f WHERE f.is_active ORDER BY f.uploaded_at DESC NULLS LAST, f.id LIMIT 1;

  IF acceso IS NOT NULL THEN
    FOR r IN SELECT f.filename FROM public.gtfs_feeds f WHERE f.is_active AND f.id <> acceso ORDER BY f.uploaded_at LOOP
      RAISE WARNING '0019: spento il feed «%»: era acceso insieme a un altro, e l''AVM leggeva già quell''altro', r.filename;
    END LOOP;
    UPDATE public.gtfs_feeds SET is_active = false WHERE is_active AND id <> acceso;
    UPDATE public.gtfs_feeds SET is_default = (id = acceso) WHERE is_default OR id = acceso;
  END IF;

  -- un solo periodo aperto: quello del feed acceso, il più recente
  UPDATE public.ps_activation_log l
     SET deactivated_at = pg_catalog.now()
   WHERE l.deactivated_at IS NULL
     AND (acceso IS NULL OR l.feed_id <> acceso
          OR l.id <> (SELECT x.id FROM public.ps_activation_log x
                       WHERE x.deactivated_at IS NULL AND x.feed_id = acceso
                       ORDER BY x.activated_at DESC, x.id LIMIT 1));
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    RAISE WARNING '0019: chiusi % periodi dello storico rimasti aperti su feed non più in esercizio', n;
  END IF;

  -- il feed acceso senza un periodo aperto: se ne apre uno da adesso
  IF acceso IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.ps_activation_log
                                          WHERE deactivated_at IS NULL AND feed_id = acceso) THEN
    INSERT INTO public.ps_activation_log (project_id, feed_id, user_id, via)
    SELECT (SELECT p.id FROM public.ps_projects p WHERE p.materialized_feed_id = acceso ORDER BY p.created_at LIMIT 1),
           acceso, NULL, 'migrazione:0019';
    RAISE NOTICE '0019: aperto nello storico il periodo del feed in esercizio, da adesso';
  END IF;
END $in_regola$;
--> statement-breakpoint
RESET ROLE;
