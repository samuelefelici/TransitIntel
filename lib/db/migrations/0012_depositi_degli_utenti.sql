-- ════════════════════════════════════════════════════════════════════════
-- PR 2.14c — I depositi di una persona
-- ────────────────────────────────────────────────────────────────────────
-- Il ruolo «Capo deposito» scrive sul roster. Finora su tutto il roster: non
-- c'era modo di dire di quali depositi. Da qui ogni utente può avere un elenco
-- di depositi (i codici di public.roster_depositi), e la sua scrittura sul
-- roster vale solo per i conducenti di quelli.
--
--   depositi   text[], vuoto per tutti. **Vuoto vuol dire nessun limite**:
--              il giorno del rilascio nessuno cambia accesso, e il limite
--              comincia quando l'amministratore sceglie i depositi di una
--              persona (Amministrazione › Utenti e accessi).
--
-- Riguarda solo la scrittura sul roster: non quello che si legge, e non la
-- scrittura sui dati del personale. Lo fa rispettare l'API
-- (lib/roster-limite-depositi.ts); la regola sta in lib/permessi.
--
-- Niente vincolo sui codici: text[] non può avere una chiave verso
-- roster_depositi. L'API li controlla quando li salva, e un codice che non
-- esiste più semplicemente non corrisponde a nessun conducente.
--
-- Il registro delle modifiche riporta il valore anche di questo campo: è un
-- diritto d'accesso, come ruoli e accesso_di_prima.
--
-- Lock: un ADD COLUMN con un default costante non riscrive la tabella; prende
-- ACCESS EXCLUSIVE per un attimo. Se la tabella è occupata il migratore
-- aspetta al più 5 s e riprova.
-- ════════════════════════════════════════════════════════════════════════
DO $depositi$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
                  WHERE attrelid = pg_catalog.to_regclass('public.users') AND attname = 'depositi'
                    AND attnum > 0 AND NOT attisdropped) THEN
    ALTER TABLE public.users ADD COLUMN depositi text[] NOT NULL DEFAULT '{}'::text[];
  END IF;
END $depositi$;
--> statement-breakpoint
-- La regola di public.users nel registro: quella della 0009, con il valore anche dei depositi.
SELECT registro.sorveglia('public.users', ARRAY['id'], 'utente', 'id', false,
  ARRAY['role', 'permissions', 'ruoli', 'accesso_di_prima', 'dati_sanitari', 'analisi', 'depositi'],
  ARRAY['password_hash', 'mfa\_segreto', 'mfa\_recupero%', 'mfa\_ultimo\_passo', 'mfa\_errori', 'mfa\_bloccata\_fino',
        'mfa\_obbligatoria', 'last_login_at', 'sessione_versione', 'dispositivi_versione', 'password_controllata']);
