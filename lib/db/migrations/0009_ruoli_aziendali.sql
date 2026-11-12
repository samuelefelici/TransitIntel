-- ═══════════════════════════════════════════════════════════════════════════
-- PR 2.14a — Ruoli aziendali: che cosa si scrive di ogni utente
-- ───────────────────────────────────────────────────────────────────────────
-- Fino a qui un utente aveva otto interruttori, uno per modulo
-- (users.permissions): acceso voleva dire «può tutto» su quel modulo. Da qui
-- ha uno o più RUOLI AZIENDALI, e ogni ruolo dà lettura o scrittura per area.
-- I ruoli e la matrice sono nel codice (lib/permessi); qui c'è solo dove si
-- scrive che cosa ha ciascuno.
--
-- 1. Quattro colonne su public.users:
--      ruoli             i ruoli aziendali (pianificatore, ufficio_turni,
--                        capo_deposito, centrale_operativa, officina,
--                        amministrazione). Un vincolo rifiuta gli altri nomi:
--                        un ruolo nuovo passa da una migrazione.
--      accesso_di_prima  gli interruttori di prima che restano validi, come
--                        scrittura sulla loro area, finché l'amministratore
--                        non assegna i ruoli. Solo le chiavi accese.
--      dati_sanitari     vede i codici di malattia, infortunio e 104 nel
--                        roster. Prima veniva con l'interruttore «roster».
--      analisi           vede l'area Analisi. Prima era l'interruttore
--                        «analytics».
--
-- 2. Il passaggio: nessuno cambia accesso. Ogni interruttore acceso oggi
--    finisce in accesso_di_prima; chi ha «roster» tiene i dati sanitari; chi
--    ha «analytics» tiene l'Analisi. «Acceso» come lo intendono l'API e la
--    0008: qualunque valore che non sia false, null, 0 o la stringa vuota.
--
-- 3. users.permissions resta, e i suoi valori non cambiano in questa
--    migrazione: è la vista che leggono FleetCare (chi può entrare) e la
--    colonna calcolata mfa_obbligatoria (0008). Da qui in poi la tiene l'API:
--    un interruttore è acceso se l'utente ha almeno la lettura su una delle
--    sue aree. Cambia solo il default della colonna: tutto spento.
--
-- 4. Il registro delle modifiche riporta i valori anche dei campi nuovi: sono
--    diritti d'accesso, come role e permissions.
--
-- Lock: quattro ADD COLUMN con un default costante non riscrivono la tabella;
-- prendono ACCESS EXCLUSIVE per un attimo. Il vincolo legge public.users
-- (decine di righe). Se la tabella è occupata il migratore aspetta al più 5 s
-- e riprova.
-- ═══════════════════════════════════════════════════════════════════════════
DO $ruoli$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
                  WHERE attrelid = pg_catalog.to_regclass('public.users') AND attname = 'ruoli'
                    AND attnum > 0 AND NOT attisdropped) THEN
    ALTER TABLE public.users
      ADD COLUMN ruoli text[] NOT NULL DEFAULT '{}'::text[],
      ADD COLUMN accesso_di_prima jsonb NOT NULL DEFAULT '{}'::jsonb,
      ADD COLUMN dati_sanitari boolean NOT NULL DEFAULT false,
      ADD COLUMN analisi boolean NOT NULL DEFAULT false;
  END IF;
  -- Una riga inserita senza dire i permessi non ne ha: prima il default della
  -- colonna accendeva Tariffe, Turni e Rete. L'API li ha sempre scritti da sé.
  ALTER TABLE public.users ALTER COLUMN permissions SET DEFAULT
    '{"analytics": false, "fares": false, "scheduling": false, "network": false, "fleetcare": false, "centrale": false, "personale": false, "roster": false}'::jsonb;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
                  WHERE conrelid = pg_catalog.to_regclass('public.users') AND conname = 'users_ruoli_validi') THEN
    ALTER TABLE public.users ADD CONSTRAINT users_ruoli_validi CHECK (
      ruoli <@ ARRAY['pianificatore', 'ufficio_turni', 'capo_deposito', 'centrale_operativa', 'officina', 'amministrazione']::text[]
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
                  WHERE conrelid = pg_catalog.to_regclass('public.users') AND conname = 'users_accesso_di_prima_oggetto') THEN
    -- «è un oggetto»: solo un oggetto JSON contiene l'oggetto vuoto. Con l'operatore
    -- e non con jsonb_typeof(), che le espressioni delle tabelle di Cerbero non ammettono (PR 2.8)
    ALTER TABLE public.users ADD CONSTRAINT users_accesso_di_prima_oggetto CHECK (
      accesso_di_prima @> '{}'::jsonb
    );
  END IF;
END
$ruoli$;
--> statement-breakpoint
-- La regola di public.users nel registro: quella della 0008, con i valori anche dei campi dei ruoli.
-- Prima del passaggio dei dati: a registro acceso il passaggio resta scritto, con i valori.
SELECT registro.sorveglia('public.users', ARRAY['id'], 'utente', 'id', false,
  ARRAY['role', 'permissions', 'ruoli', 'accesso_di_prima', 'dati_sanitari', 'analisi'],
  ARRAY['password_hash', 'mfa\_segreto', 'mfa\_recupero%', 'mfa\_ultimo\_passo', 'mfa\_errori', 'mfa\_bloccata\_fino',
        'mfa\_obbligatoria', 'last_login_at', 'sessione_versione', 'dispositivi_versione', 'password_controllata']);
--> statement-breakpoint
-- Il passaggio dei dati, come cerbero_owner se la tabella è già sua (README,
-- «Chi possiede cosa»). Su un database appena creato la tabella è ancora di chi
-- migra, anche quando il ruolo c'è già nel cluster: lì si resta chi si è.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c
              WHERE c.oid = pg_catalog.to_regclass('public.users')
                AND c.relowner = pg_catalog.to_regrole('cerbero_owner')) THEN
    EXECUTE 'SET LOCAL ROLE cerbero_owner';
  END IF;
END $$;
--> statement-breakpoint
UPDATE public.users u
   SET accesso_di_prima = coalesce((
         SELECT pg_catalog.jsonb_object_agg(k.nome, true)
           FROM pg_catalog.unnest(ARRAY['fares', 'scheduling', 'network', 'fleetcare', 'centrale', 'personale', 'roster']) AS k(nome)
          WHERE coalesce(u.permissions -> k.nome, 'false'::jsonb) NOT IN ('false'::jsonb, 'null'::jsonb, '0'::jsonb, '""'::jsonb)
       ), '{}'::jsonb),
       dati_sanitari = coalesce(u.permissions -> 'roster', 'false'::jsonb) NOT IN ('false'::jsonb, 'null'::jsonb, '0'::jsonb, '""'::jsonb),
       analisi = coalesce(u.permissions -> 'analytics', 'false'::jsonb) NOT IN ('false'::jsonb, 'null'::jsonb, '0'::jsonb, '""'::jsonb)
 WHERE u.ruoli = '{}'::text[] AND u.accesso_di_prima = '{}'::jsonb AND NOT u.dati_sanitari AND NOT u.analisi;
--> statement-breakpoint
RESET ROLE;
