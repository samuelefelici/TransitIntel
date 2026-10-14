-- ═══════════════════════════════════════════════════════════════════════════
-- Roster: pubblicazione dei turni guida (canale unico)
-- ───────────────────────────────────────────────────────────────────────────
-- Il roster riceve i turni guida solo da qui: per un periodo si sceglie, per
-- ogni Unità di Progettazione del programma, quale turni guida (DSS) vale nei
-- giorni dell'unità. Una riga per giorno e unità; ripubblicando, le righe
-- vecchie restano con chi le ha sostituite.
--
-- Un DSS pubblicato non si cancella (ON DELETE RESTRICT), neanche in cascata.
-- I riassunti dei turni di un DSS si rifanno da sé quando la sua riga cambia.
--
-- L'applicazione crea tabelle e indici da sé al primo avvio
-- (api-server/src/lib/roster-pubblicazione-db.ts); il file serve a chi
-- preferisce applicarli prima, e a lasciarne traccia.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS roster_pubblicazioni (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo text NOT NULL DEFAULT 'pubblica' CHECK (tipo IN ('pubblica', 'ritira')),
  ps_project_id uuid,
  programma text,
  dal date NOT NULL,
  al date NOT NULL,
  scelte jsonb NOT NULL DEFAULT '{}'::jsonb,
  prima jsonb NOT NULL DEFAULT '[]'::jsonb,
  riepilogo jsonb NOT NULL DEFAULT '{}'::jsonb,
  nota text,
  creata_da uuid,
  creata_il timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_roster_pubblicazioni_il ON roster_pubblicazioni(creata_il DESC);

CREATE TABLE IF NOT EXISTS roster_turni_pubblicati (
  id bigserial PRIMARY KEY,
  day date NOT NULL,
  udp_id uuid NOT NULL,
  dss_id uuid NOT NULL REFERENCES driver_shift_scenarios(id) ON DELETE RESTRICT,
  ps_project_id uuid,
  udp_nome text,
  dss_nome text,
  pubblicazione_id uuid NOT NULL REFERENCES roster_pubblicazioni(id),
  sostituita_da uuid REFERENCES roster_pubblicazioni(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_roster_turni_pubblicati_attivi ON roster_turni_pubblicati(day, udp_id) WHERE sostituita_da IS NULL;
CREATE INDEX IF NOT EXISTS idx_roster_turni_pubblicati_dss ON roster_turni_pubblicati(dss_id, day) WHERE sostituita_da IS NULL;

CREATE TABLE IF NOT EXISTS roster_dss_riassunti (
  dss_id uuid PRIMARY KEY REFERENCES driver_shift_scenarios(id) ON DELETE CASCADE,
  impronta text NOT NULL,
  codici_doppi text[] NOT NULL DEFAULT '{}',
  turni integer NOT NULL DEFAULT 0,
  fatto_il timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS roster_turni_dss (
  dss_id uuid NOT NULL REFERENCES driver_shift_scenarios(id) ON DELETE CASCADE,
  codice text NOT NULL,
  ordine integer NOT NULL,
  riassunto jsonb NOT NULL,
  firma text,
  corse jsonb NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (dss_id, codice)
);

ALTER TABLE roster_assignments ADD COLUMN IF NOT EXISTS ricollegamenti jsonb;
