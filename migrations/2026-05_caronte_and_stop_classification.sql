-- ═══════════════════════════════════════════════════════════════════════════
-- Migrazione additiva idempotente — equivalente a `drizzle-kit push` per:
--   • §6.1 classificazione fermata persistita  (gtfs_stops)
--   • §6.2 biglietto orario urbano             (gtfs_fare_products.is_urban_hourly)
--   • schema `caronte` + tabelle               (tap_events, journeys, vehicle_positions)
--
-- Da usare quando non è disponibile node/pnpm (es. shell del container Postgres).
-- NON crea l'utente caronte_app: per quello vedi caronte_setup.sql (qui Cerbero e
-- caronte condividono la stessa DATABASE_URL, quindi non serve).
--
--   psql "$DATABASE_URL" -f migrations/2026-05_caronte_and_stop_classification.sql
-- ═══════════════════════════════════════════════════════════════════════════

-- ── §6.1 — classificazione fermata su gtfs_stops ────────────────────────────
ALTER TABLE gtfs_stops ADD COLUMN IF NOT EXISTS stop_classification       integer;
ALTER TABLE gtfs_stops ADD COLUMN IF NOT EXISTS stop_classification_label text;
ALTER TABLE gtfs_stops ADD COLUMN IF NOT EXISTS fare_kind                 text;
CREATE INDEX IF NOT EXISTS idx_gtfs_stops_feed_fare_kind ON gtfs_stops (feed_id, fare_kind);

-- ── §6.2 — biglietto orario urbano su gtfs_fare_products ────────────────────
ALTER TABLE gtfs_fare_products ADD COLUMN IF NOT EXISTS is_urban_hourly boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_fare_products_urban_hourly ON gtfs_fare_products (feed_id, is_urban_hourly);

-- ── schema caronte (read-write) ─────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS caronte;

-- active_trips è scritta da Caronte (AVM); qui IF NOT EXISTS per sicurezza.
CREATE TABLE IF NOT EXISTS caronte.active_trips (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id    TEXT,
  route_id   TEXT,
  vehicle_id TEXT,
  device_id  TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_caronte_active_trips_open ON caronte.active_trips(vehicle_id) WHERE ended_at IS NULL;

CREATE TABLE IF NOT EXISTS caronte.tap_events (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id  TEXT NOT NULL,
  vehicle_id TEXT,
  trip_id    TEXT,
  route_id   TEXT,
  direction  TEXT NOT NULL,                 -- 'in' | 'out'
  stop_id    TEXT,
  cluster_id TEXT,
  stop_seq   INTEGER,
  ticket_uid TEXT,
  ts         TIMESTAMPTZ NOT NULL DEFAULT now(),
  lat        DOUBLE PRECISION,
  lon        DOUBLE PRECISION,
  raw_nfc    JSONB
);
CREATE INDEX IF NOT EXISTS idx_caronte_tap_trip   ON caronte.tap_events(trip_id);
CREATE INDEX IF NOT EXISTS idx_caronte_tap_stop   ON caronte.tap_events(stop_id);
CREATE INDEX IF NOT EXISTS idx_caronte_tap_ticket ON caronte.tap_events(ticket_uid);
CREATE INDEX IF NOT EXISTS idx_caronte_tap_ts     ON caronte.tap_events(ts);

CREATE TABLE IF NOT EXISTS caronte.journeys (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id      TEXT,
  ticket_uid     TEXT,
  trip_id        TEXT,
  route_id       TEXT,
  stop_in        TEXT,
  stop_out       TEXT,
  cluster_in     TEXT,
  cluster_out    TEXT,
  fare_kind      TEXT,                       -- 'orario' | 'od_matrix'
  expected_price DOUBLE PRECISION,
  charged_price  DOUBLE PRECISION,
  price_match    BOOLEAN,
  tap_in_id      UUID,
  tap_out_id     UUID,
  ts_start       TIMESTAMPTZ,
  ts_end         TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_caronte_journey_trip   ON caronte.journeys(trip_id);
CREATE INDEX IF NOT EXISTS idx_caronte_journey_ticket ON caronte.journeys(ticket_uid);
CREATE INDEX IF NOT EXISTS idx_caronte_journey_match  ON caronte.journeys(price_match);

CREATE TABLE IF NOT EXISTS caronte.vehicle_positions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id      TEXT,
  trip_id         TEXT,
  ts              TIMESTAMPTZ NOT NULL DEFAULT now(),
  lat             DOUBLE PRECISION NOT NULL,
  lon             DOUBLE PRECISION NOT NULL,
  nearest_stop_id TEXT,
  speed           DOUBLE PRECISION
);
CREATE INDEX IF NOT EXISTS idx_caronte_vpos_trip ON caronte.vehicle_positions(trip_id);
CREATE INDEX IF NOT EXISTS idx_caronte_vpos_ts   ON caronte.vehicle_positions(ts);
