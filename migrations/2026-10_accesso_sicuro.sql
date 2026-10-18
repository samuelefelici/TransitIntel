-- ═══════════════════════════════════════════════════════════════════════════
-- Accesso sicuro: blocco dopo i tentativi falliti, sessioni revocabili,
-- password provvisorie, verifica in due passaggi (TOTP), registro accessi
-- ───────────────────────────────────────────────────────────────────────────
-- sessione_versione: il token della sessione porta la versione; alzarla
-- (cambio password, reset della verifica, «esci ovunque») chiude le altre
-- sessioni. Parte da 1: i token di prima (senza versione) non entrano più.
-- mfa_segreto è cifrato con CERBERO_CHIAVE_MFA (AES-256-GCM); mfa_recupero
-- tiene solo le impronte dei codici di recupero.
--
-- L'applicazione aggiunge colonne e tabella da sé al primo avvio
-- (api-server/src/lib/auth.ts); il file serve a chi preferisce applicarle
-- prima, e a lasciarne traccia.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE users ADD COLUMN IF NOT EXISTS sessione_versione integer NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_cambiata_il timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS deve_cambiare_password boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS tentativi_falliti integer NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS bloccato_fino timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_attiva boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_segreto text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_recupero jsonb;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_ultimo_passo bigint;

CREATE TABLE IF NOT EXISTS accessi_log (
  id bigserial PRIMARY KEY,
  ts timestamptz NOT NULL DEFAULT now(),
  user_id uuid,
  email text,
  esito text NOT NULL,
  ip text,
  user_agent text
);
CREATE INDEX IF NOT EXISTS idx_accessi_log_ts ON accessi_log(ts DESC);
CREATE INDEX IF NOT EXISTS idx_accessi_log_user ON accessi_log(user_id, ts DESC);
