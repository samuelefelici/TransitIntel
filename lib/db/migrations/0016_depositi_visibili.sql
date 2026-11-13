-- ════════════════════════════════════════════════════════════════════════
-- PR 2.14d — I depositi che una persona vede
-- ────────────────────────────────────────────────────────────────────────
-- Dalla 2.14c un utente può avere un elenco di depositi (users.depositi): sul
-- roster modifica solo i conducenti di quelli, ma vede quelli di tutti. Da qui
-- l'amministratore sceglie anche che cosa vede:
--
--   depositi_visibili   text[], vuoto per tutti. I depositi di cui la persona
--                       vede i conducenti senza modificarli. **Vuoto vuol dire
--                       nessun limite**: il giorno del rilascio nessuno cambia
--                       quello che vede.
--
-- Quello che una persona modifica (users.depositi) lo vede sempre, anche se
-- questo elenco non lo nomina. Chi ha un elenco qui non vede i conducenti
-- degli altri depositi: né nel tabellone, né nell'anagrafica. La regola sta in
-- lib/permessi (limitiSuiDepositi); la fa rispettare l'API
-- (lib/roster-limite-depositi.ts).
--
-- Niente vincolo sui codici, come per users.depositi: l'API li controlla
-- quando li salva, e un codice che non esiste più non corrisponde a nessun
-- conducente.
--
-- Il registro delle modifiche riporta il valore anche di questo campo: è un
-- diritto d'accesso.
--
-- Lock: un ADD COLUMN con un default costante non riscrive la tabella; prende
-- ACCESS EXCLUSIVE per un attimo. Se la tabella è occupata il migratore
-- aspetta al più 5 s e riprova.
-- ════════════════════════════════════════════════════════════════════════
DO $visibili$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
                  WHERE attrelid = pg_catalog.to_regclass('public.users') AND attname = 'depositi_visibili'
                    AND attnum > 0 AND NOT attisdropped) THEN
    ALTER TABLE public.users ADD COLUMN depositi_visibili text[] NOT NULL DEFAULT '{}'::text[];
  END IF;
END $visibili$;
--> statement-breakpoint
-- La regola di public.users nel registro: quella della 0012, con il valore anche dei depositi visibili.
SELECT registro.sorveglia('public.users', ARRAY['id'], 'utente', 'id', false,
  ARRAY['role', 'permissions', 'ruoli', 'accesso_di_prima', 'dati_sanitari', 'analisi', 'depositi', 'depositi_visibili'],
  ARRAY['password_hash', 'mfa\_segreto', 'mfa\_recupero%', 'mfa\_ultimo\_passo', 'mfa\_errori', 'mfa\_bloccata\_fino',
        'mfa\_obbligatoria', 'last_login_at', 'sessione_versione', 'dispositivi_versione', 'password_controllata']);
