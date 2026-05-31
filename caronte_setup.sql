-- ═══════════════════════════════════════════════════════════════════════════
-- SCHEMA `caronte` — dati read-write di AVM + validatore biglietti
-- ───────────────────────────────────────────────────────────────────────────
-- Le TABELLE sono definite (source of truth) in lib/db/src/schema/index.ts e
-- create da `pnpm --filter @workspace/db push`. Questo file serve per:
--   1. creare lo schema se non si usa drizzle push;
--   2. creare l'UTENTE applicativo con permessi di SCRITTURA limitati a `caronte`
--      e SOLA LETTURA sui gtfs_* in `public` (il gestionale non va mai inquinato).
--
-- Eseguire come superuser/owner:  psql "$DATABASE_URL" -f caronte_setup.sql
-- ═══════════════════════════════════════════════════════════════════════════

CREATE SCHEMA IF NOT EXISTS caronte;

-- Tabelle (mirror di lib/db/src/schema/index.ts; usare drizzle push in dev) ----

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
  expected_price DOUBLE PRECISION,           -- oracolo (fares engine)
  charged_price  DOUBLE PRECISION,           -- addebitato dalla bigliettazione
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

-- ─── Utente applicativo: scrive SOLO su `caronte`, legge SOLO i gtfs_* ──────────
-- Imposta la password reale via psql o cambiandola dopo la creazione.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'caronte_app') THEN
    CREATE ROLE caronte_app LOGIN PASSWORD 'CHANGE_ME';
  END IF;
END$$;

-- Scrittura completa sullo schema caronte (presente e futuro)
GRANT USAGE, CREATE ON SCHEMA caronte TO caronte_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA caronte TO caronte_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA caronte TO caronte_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA caronte
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO caronte_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA caronte
  GRANT USAGE, SELECT ON SEQUENCES TO caronte_app;

-- Sola lettura sui dati del gestionale (public). NIENTE INSERT/UPDATE/DELETE.
GRANT USAGE ON SCHEMA public TO caronte_app;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO caronte_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO caronte_app;
