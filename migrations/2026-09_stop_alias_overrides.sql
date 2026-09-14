-- ═══════════════════════════════════════════════════════════════════════════
-- Migrazione additiva idempotente — le correzioni alla transcodifica paline
--
-- Il file «Transcodifica Paline Maior vs SWI» è il punto di partenza per
-- abbinare il codice palina di Mizar allo stop_id del feed. Le correzioni
-- fatte dalla scheda «Paline Mizar» vivono qui, una riga per codice Mizar;
-- stop_id vuoto = «questa palina non ha una fermata nel feed». La tabella
-- effettiva è file + correzioni; il file non si tocca.
--
-- Il connettore la crea da sé al primo bisogno se il ruolo glielo concede.
--
--   psql "$DATABASE_URL" -f migrations/2026-09_stop_alias_overrides.sql
-- ═══════════════════════════════════════════════════════════════════════════

CREATE SCHEMA IF NOT EXISTS caronte;

CREATE TABLE IF NOT EXISTS caronte.stop_alias_overrides (
  mizar_ref   TEXT PRIMARY KEY,      -- il codice palina di Mizar
  stop_id     TEXT,                  -- lo stop_id del feed; NULL = nessuna fermata
  nome        TEXT,                  -- il nome della palina, per leggibilità
  nota        TEXT,                  -- perché è stata corretta
  updated_by  TEXT,                  -- chi l'ha decisa
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
