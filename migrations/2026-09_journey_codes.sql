-- ═══════════════════════════════════════════════════════════════════════════
-- Migrazione additiva idempotente — le coppie di codici corsa AVM ↔ GTFS
--
-- Il codice corsa dichiarato dall'AVM (DatedVehicleJourneyRef, oppure
-- CourseOfJourneyRef su Flashnet) e il trip_id del feed GTFS non combaciano:
-- l'aggancio ripiega su linea + ora di partenza. Funziona, ma è un
-- riconoscimento e non un'identificazione — e la coppia che produce, che
-- sarebbe la chiave per risolvere il disallineamento, finora si perdeva a
-- ogni giro.
--
--   • caronte.journey_codes      — le coppie distinte per giornata
--   • caronte.journey_code_days  — i totali del giro: senza il denominatore,
--                                  "17 coppie" non distingue un collegamento
--                                  che va male da un AVM che il codice lo
--                                  manda solo su 17 mezzi
--
-- Il connettore SIRI crea entrambe da sé al primo giro se il ruolo glielo
-- concede; questa migrazione serve dove non lo concede.
--
--   psql "$DATABASE_URL" -f migrations/2026-09_journey_codes.sql
-- ═══════════════════════════════════════════════════════════════════════════

CREATE SCHEMA IF NOT EXISTS caronte;

CREATE TABLE IF NOT EXISTS caronte.journey_codes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  day           DATE NOT NULL,                  -- giornata di servizio
  journey_ref   TEXT NOT NULL,                  -- il codice dichiarato dall'AVM
  -- '' e non NULL: un indice unico non considera uguali due NULL, e le letture
  -- senza corsa agganciata si moltiplicherebbero a ogni giro.
  trip_id       TEXT NOT NULL DEFAULT '',       -- la corsa GTFS attribuita
  matched_by    TEXT,                           -- 'id' | 'orario'
  -- il contorno dell'AVM: serve a capire che cosa quel codice identifichi
  vehicle_ref   TEXT,
  line_ref      TEXT,
  published_line_name TEXT,
  route_ref     TEXT,
  course_ref    TEXT,
  framed_ref    TEXT,
  data_frame_ref TEXT,
  pattern_ref   TEXT,
  block_ref     TEXT,
  avm_departure TEXT,                           -- HH:MM nell'ora dell'azienda
  avm_destination TEXT,
  -- e il contorno del feed, per il confronto
  route_id      TEXT,
  gtfs_departure TEXT,                          -- HH:MM:SS della prima fermata
  gtfs_headsign TEXT,
  observations  INTEGER NOT NULL DEFAULT 1,     -- letture che l'hanno confermata
  first_seen    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_caronte_jcodes_key
  ON caronte.journey_codes(day, journey_ref, trip_id);

CREATE TABLE IF NOT EXISTS caronte.journey_code_days (
  day           DATE PRIMARY KEY,
  rounds        INTEGER NOT NULL DEFAULT 0,     -- giri del connettore
  vehicles      INTEGER NOT NULL DEFAULT 0,     -- somma dei mezzi per giro
  with_code     INTEGER NOT NULL DEFAULT 0,     -- di cui con codice corsa
  matched       INTEGER NOT NULL DEFAULT 0,     -- agganciati a una corsa
  matched_by_id INTEGER NOT NULL DEFAULT 0,     -- agganciati perché i codici combaciavano
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
