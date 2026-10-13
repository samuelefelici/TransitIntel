-- ═══════════════════════════════════════════════════════════════════════════
-- Anagrafica del personale: permesso «personale», cataloghi, colonne nuove
-- ───────────────────────────────────────────────────────────────────────────
-- Il roster aveva già una scheda conducente (roster_drivers); diventa
-- un'anagrafica completa: deposito da catalogo, orario in minuti, contatti,
-- inquadramento e parametro, ferie, scaglioni, rotazione turni, visite.
--
-- Il permesso «personale» protegge i dati personali e di busta paga: nessun
-- utente esistente lo riceve, lo accende l'admin dalla Gestione Utenti. Senza,
-- chi ha lo Scheduling vede nel roster solo i dati operativi.
--
-- L'applicazione crea e aggiorna tutto da sé al primo avvio
-- (api-server/src/lib/anagrafica-store.ts e lib/auth.ts), compresi i passi
-- sui dati che qui NON ci sono: orario in minuti dallo storico, righe di
-- storico «stato iniziale», categorie, matricola canonica e indice unico. Il
-- file serve a chi preferisce preparare le tabelle prima, e a lasciarne
-- traccia nel repository.
-- ═══════════════════════════════════════════════════════════════════════════

-- Permesso: nessuno lo riceve da sé
UPDATE users SET permissions = permissions || '{"personale":false}'::jsonb
 WHERE NOT (permissions ? 'personale');
ALTER TABLE users ALTER COLUMN permissions SET DEFAULT
  '{"analytics":true,"fares":true,"scheduling":true,"network":true,"fleetcare":false,"centrale":false,"personale":false}'::jsonb;

-- Colonne nuove del conducente
ALTER TABLE roster_drivers
  ADD COLUMN IF NOT EXISTS orario_settimanale_min integer,
  ADD COLUMN IF NOT EXISTS telefono text,
  ADD COLUMN IF NOT EXISTS inquadramento text,
  ADD COLUMN IF NOT EXISTS parametro smallint,
  ADD COLUMN IF NOT EXISTS ferie_annue numeric(6,1),
  ADD COLUMN IF NOT EXISTS ferie_residue numeric(6,1),
  ADD COLUMN IF NOT EXISTS ferie_residue_al date,
  ADD COLUMN IF NOT EXISTS ferie_unita text NOT NULL DEFAULT 'giorni',
  ADD COLUMN IF NOT EXISTS scaglione_ferie text,
  ADD COLUMN IF NOT EXISTS rotazione_turni_gruppo_id uuid,
  ADD COLUMN IF NOT EXISTS rotazione_turni_posizione integer,
  ADD COLUMN IF NOT EXISTS visita_ferrovie_data date,
  ADD COLUMN IF NOT EXISTS visita_medico_competente_data date,
  ADD COLUMN IF NOT EXISTS visita_ferrovie_esito text,
  ADD COLUMN IF NOT EXISTS visita_medico_competente_esito text,
  ADD COLUMN IF NOT EXISTS patente_numero text,
  ADD COLUMN IF NOT EXISTS matricola_chiave text,
  ADD COLUMN IF NOT EXISTS versione integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz;

-- I sette depositi con rotazione (gruppo A: niente servizio la domenica;
-- B: anche la domenica). Gli alias sono i microdepositi assorbiti.
CREATE TABLE IF NOT EXISTS roster_depositi (
  codice text PRIMARY KEY,
  nome text NOT NULL UNIQUE,
  gruppo text NOT NULL CHECK (gruppo IN ('A', 'B')),
  cadenza_turni text NOT NULL CHECK (cadenza_turni IN ('settimanale', 'semimensile')),
  alias text[] NOT NULL DEFAULT '{}'::text[],
  ordine integer NOT NULL DEFAULT 0
);
INSERT INTO roster_depositi (codice, nome, gruppo, cadenza_turni, alias, ordine) VALUES
  ('ancona', 'Ancona', 'B', 'semimensile', '{polverigi}', 1),
  ('marina', 'Marina', 'B', 'semimensile', '{belvedere,"belvedere ostrense",ostra,"marina di montemarciano"}', 2),
  ('osimo', 'Osimo', 'B', 'semimensile', '{}', 3),
  ('jesi', 'Jesi', 'A', 'semimensile', '{}', 4),
  ('jesi-urbano', 'Jesi Urbano', 'A', 'settimanale', '{moie,"jesi u","jesi urb"}', 5),
  ('castelfidardo', 'Castelfidardo', 'A', 'semimensile', '{}', 6),
  ('filottrano', 'Filottrano', 'A', 'semimensile', '{}', 7)
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS roster_categorie (
  codice text PRIMARY KEY,
  nome text NOT NULL UNIQUE,
  alias text[] NOT NULL DEFAULT '{}'::text[]
);

-- Gruppi della rotazione turni, per deposito (la data di riferimento si
-- fissa nella fase di abbinamento turni-conducenti)
CREATE TABLE IF NOT EXISTS roster_gruppi_turni (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deposito_codice text NOT NULL REFERENCES roster_depositi(codice),
  nome text NOT NULL,
  data_riferimento date,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (deposito_codice, nome)
);

-- Chi ha scritto che cosa: i NOMI dei campi, mai i valori
CREATE TABLE IF NOT EXISTS roster_anagrafica_log (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  user_id uuid,
  driver_id uuid,
  azione text NOT NULL,
  campi text[] NOT NULL DEFAULT '{}'::text[],
  dettaglio jsonb
);
CREATE INDEX IF NOT EXISTS idx_roster_anag_log_driver ON roster_anagrafica_log(driver_id, at DESC);
