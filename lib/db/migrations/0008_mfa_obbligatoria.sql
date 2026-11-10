-- ═══════════════════════════════════════════════════════════════════════════
-- PR 2.12 — Per chi la verifica in due passaggi è obbligatoria lo dice il database
-- ───────────────────────────────────────────────────────────────────────────
-- La regola (chi amministra, chi vede i dati del personale o il roster) era
-- scritta due volte: nell'API (mfaObbligatoria) e, copiata a mano, nella
-- funzione con cui FleetCare rilegge lo stato di chi entra da Cerbero
-- (fleetcare.cerbero_stato_utente). Cambiarla voleva dire cambiarla in due
-- repository, nello stesso momento.
--
-- 1. public.users.mfa_obbligatoria: una colonna calcolata dal database da
--    role e permissions. Non si scrive: la tiene Postgres, a ogni INSERT e a
--    ogni UPDATE. La leggono l'API di Cerbero e, colonna per colonna,
--    fleetcare_legge_cerbero (il diritto glielo dà il migratore, LETTORI in
--    lib/db/scripts/ruoli-regole.mjs).
--
--    Un permesso conta come «sì» per qualunque valore che non sia false,
--    null, 0 o la stringa vuota: come l'API, che lo leggeva con `!!`. L'API
--    scrive solo true e false; se qualcuno scrive altro a mano nel JSON, la
--    verifica resta obbligatoria invece di sparire.
--
--    L'espressione usa solo operatori di sistema (=, ->, <>): passa il
--    controllo delle espressioni delle tabelle di Cerbero (PR 2.8).
--
-- 2. Il registro delle modifiche non la segna: è un dato derivato, cambia
--    solo insieme a role o permissions, che il registro riporta già. La regola
--    di public.users è quella della 0006 con questa colonna fra le escluse.
--
-- Lock: ADD COLUMN … STORED riscrive public.users (decine di righe) sotto
-- ACCESS EXCLUSIVE, per un attimo; sorveglia() prende SHARE ROW EXCLUSIVE per
-- riaccendere i trigger. Se la tabella è occupata il migratore aspetta al più
-- 5 s e riprova.
-- ═══════════════════════════════════════════════════════════════════════════
DO $mfa$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
                  WHERE attrelid = pg_catalog.to_regclass('public.users') AND attname = 'mfa_obbligatoria'
                    AND attnum > 0 AND NOT attisdropped) THEN
    ALTER TABLE public.users ADD COLUMN mfa_obbligatoria boolean NOT NULL GENERATED ALWAYS AS (
      role = 'admin'
      OR coalesce(permissions -> 'personale', 'false'::jsonb) NOT IN ('false'::jsonb, 'null'::jsonb, '0'::jsonb, '""'::jsonb)
      OR coalesce(permissions -> 'roster', 'false'::jsonb) NOT IN ('false'::jsonb, 'null'::jsonb, '0'::jsonb, '""'::jsonb)
    ) STORED;
  END IF;
END
$mfa$;
--> statement-breakpoint
-- La regola di public.users nel registro: quella della 0006, più mfa_obbligatoria fra le escluse
SELECT registro.sorveglia('public.users', ARRAY['id'], 'utente', 'id', false, ARRAY['role', 'permissions'],
  ARRAY['password_hash', 'mfa\_segreto', 'mfa\_recupero%', 'mfa\_ultimo\_passo', 'mfa\_errori', 'mfa\_bloccata\_fino',
        'mfa\_obbligatoria', 'last_login_at', 'sessione_versione', 'dispositivi_versione', 'password_controllata']);
