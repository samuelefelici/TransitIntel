-- ═══════════════════════════════════════════════════════════════════════════
-- Migrazione additiva idempotente — le previsioni di Mizar alle fermate
--
-- Lo StopMonitoring di Mizar dice, per un mezzo seguito, a che ora passerà
-- dalle prossime fermate. È una previsione: cambia a ogni giro e a mezzo
-- passato sparisce. Non è un transito e NON entra in caronte.stop_transits,
-- da cui tempi di percorrenza, puntualità e anomalie prendono i numeri.
--
--   • caronte.stop_predictions — una riga per (giornata, corsa, fermata):
--                                l'ultima previsione e la prima ricevuta
--
-- Il connettore SIRI la crea da sé al primo bisogno se il ruolo glielo
-- concede; questa migrazione serve dove non lo concede.
--
--   psql "$DATABASE_URL" -f migrations/2026-09_stop_predictions.sql
-- ═══════════════════════════════════════════════════════════════════════════

CREATE SCHEMA IF NOT EXISTS caronte;

CREATE TABLE IF NOT EXISTS caronte.stop_predictions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  day               DATE NOT NULL,              -- giornata di servizio
  trip_id           TEXT NOT NULL,              -- la corsa GTFS
  stop_id           TEXT NOT NULL,              -- la fermata GTFS
  mizar_ref         TEXT NOT NULL,              -- il codice palina di Mizar
  vehicle_ref       TEXT,
  line_ref          TEXT,
  aimed_ts          TIMESTAMPTZ,                -- programmato secondo Mizar
  expected_ts       TIMESTAMPTZ NOT NULL,       -- l'ultima previsione
  expected_first_ts TIMESTAMPTZ NOT NULL,       -- la prima previsione ricevuta
  status            TEXT,                       -- onTime / delayed / early…
  recorded_at       TIMESTAMPTZ,                -- ultimo contatto AVM alla base della previsione
  observations      INTEGER NOT NULL DEFAULT 1, -- giri che l'hanno aggiornata
  first_seen        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_caronte_stop_pred_key
  ON caronte.stop_predictions(day, trip_id, stop_id);
CREATE INDEX IF NOT EXISTS idx_caronte_stop_pred_trip
  ON caronte.stop_predictions(trip_id, day);
