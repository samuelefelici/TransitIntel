-- ═══════════════════════════════════════════════════════════════════════════
-- Migrazione additiva idempotente — Sala Operativa (live operations) + GTFS-RT
--
--   • caronte.stop_transits     — transiti reali alle fermate scritti da AVM
--                                 (finora la tabella esisteva solo lato AVM:
--                                 questa migrazione la porta nel gestionale,
--                                 source of truth in lib/db/src/schema/index.ts)
--   • caronte.vehicle_positions — colonna heading (rotta GPS, gradi 0-360)
--   • indici per le query "ultima posizione per mezzo" della Sala Operativa
--
--   psql "$DATABASE_URL" -f migrations/2026-06_operations_live.sql
-- ═══════════════════════════════════════════════════════════════════════════

CREATE SCHEMA IF NOT EXISTS caronte;

-- ── transiti reali alle fermate (programmato vs effettivo) ──────────────────
CREATE TABLE IF NOT EXISTS caronte.stop_transits (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id       TEXT,
  route_id      TEXT,
  vehicle_id    TEXT,
  device_id     TEXT,
  stop_id       TEXT NOT NULL,
  stop_seq      INTEGER,
  scheduled     TEXT,                                -- HH:MM:SS programmato (GTFS)
  actual_ts     TIMESTAMPTZ NOT NULL DEFAULT now(),
  delay_seconds INTEGER,                             -- >0 ritardo, <0 anticipo
  lat           DOUBLE PRECISION,
  lon           DOUBLE PRECISION
);
CREATE INDEX IF NOT EXISTS idx_caronte_transit_trip  ON caronte.stop_transits(trip_id);
CREATE INDEX IF NOT EXISTS idx_caronte_transit_route ON caronte.stop_transits(route_id);
CREATE INDEX IF NOT EXISTS idx_caronte_transit_ts    ON caronte.stop_transits(actual_ts);

-- ── heading sulla posizione mezzo (marker direzionali in Sala Operativa) ────
ALTER TABLE caronte.vehicle_positions ADD COLUMN IF NOT EXISTS heading DOUBLE PRECISION;

-- ── ultima posizione per mezzo: indice per DISTINCT ON (vehicle_id) ... ts ──
CREATE INDEX IF NOT EXISTS idx_caronte_vpos_vehicle_ts
  ON caronte.vehicle_positions(vehicle_id, ts DESC);
