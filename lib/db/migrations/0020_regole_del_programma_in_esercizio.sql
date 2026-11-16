-- ════════════════════════════════════════════════════════════════════════
-- 0020 — Le regole del programma in esercizio, nel database (PR 3.2)
-- ────────────────────────────────────────────────────────────────────────
-- La 0019 ha messo in regola lo stato di oggi. Da qui il database tiene:
--
--   gtfs_feeds_un_solo_in_esercizio     al più un feed acceso (is_active);
--   ps_activation_log_un_solo_aperto    al più un periodo aperto nello storico.
--
-- Differiti alla fine della transazione: chi cambia il feed acceso (la porta
-- unica, lib/esercizio-porta.ts) spegne il vecchio e accende il nuovo, e solo
-- il risultato deve avere un feed acceso e un periodo aperto. Nel vincolo
-- solo operatori di sistema (README, «Funzioni nei default, nei vincoli e
-- negli indici»).
--
-- Il registro delle modifiche sorveglia anche lo storico, con i valori: chi
-- ha attivato (user_id) solo come nome della colonna, come ovunque.
--
-- Lock: tabelle piccole; i due indici si costruiscono in un attimo.
-- ════════════════════════════════════════════════════════════════════════
-- Le due regole, nel database: al più un feed acceso, al più un periodo
-- aperto. Differite alla fine della transazione.
DO $regole$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
                  WHERE conrelid = pg_catalog.to_regclass('public.gtfs_feeds') AND conname = 'gtfs_feeds_un_solo_in_esercizio') THEN
    ALTER TABLE public.gtfs_feeds ADD CONSTRAINT gtfs_feeds_un_solo_in_esercizio
      EXCLUDE USING btree (is_active WITH =) WHERE (is_active) DEFERRABLE INITIALLY DEFERRED;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
                  WHERE conrelid = pg_catalog.to_regclass('public.ps_activation_log') AND conname = 'ps_activation_log_un_solo_aperto') THEN
    ALTER TABLE public.ps_activation_log ADD CONSTRAINT ps_activation_log_un_solo_aperto
      EXCLUDE USING btree ((deactivated_at IS NULL) WITH =) WHERE (deactivated_at IS NULL) DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $regole$;
--> statement-breakpoint
SELECT registro.sorveglia('public.ps_activation_log', ARRAY['id'], 'progetto_ps', 'project_id', true);
