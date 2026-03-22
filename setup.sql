-- ═══════════════════════════════════════════════════════════
-- TransitIntel — Schema SQL per Neon.tech (PostgreSQL)
-- Esegui nella Neon SQL Console o con: psql $DATABASE_URL < setup.sql
-- ═══════════════════════════════════════════════════════════

-- Traffic snapshots (dati TomTom)
CREATE TABLE IF NOT EXISTS traffic_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  segment_id TEXT NOT NULL,
  lng DOUBLE PRECISION NOT NULL,
  lat DOUBLE PRECISION NOT NULL,
  speed DOUBLE PRECISION NOT NULL,
  freeflow_speed DOUBLE PRECISION NOT NULL,
  congestion_level DOUBLE PRECISION NOT NULL,
  captured_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_traffic_captured ON traffic_snapshots(captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_traffic_segment ON traffic_snapshots(segment_id);

-- Census sections (dati ISTAT)
CREATE TABLE IF NOT EXISTS census_sections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  istat_code TEXT UNIQUE,
  centroid_lng DOUBLE PRECISION NOT NULL DEFAULT 0,
  centroid_lat DOUBLE PRECISION NOT NULL DEFAULT 0,
  population INTEGER NOT NULL DEFAULT 0,
  area_km2 DOUBLE PRECISION NOT NULL DEFAULT 0,
  density DOUBLE PRECISION NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Points of interest (Google Places / OpenStreetMap)
CREATE TABLE IF NOT EXISTS points_of_interest (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  osm_id INTEGER UNIQUE,
  name TEXT,
  category TEXT NOT NULL,
  lng DOUBLE PRECISION NOT NULL,
  lat DOUBLE PRECISION NOT NULL,
  properties JSONB DEFAULT '{}',
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_poi_category ON points_of_interest(category);

-- Bus stops (gestione manuale)
CREATE TABLE IF NOT EXISTS bus_stops (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT UNIQUE,
  name TEXT NOT NULL,
  lng DOUBLE PRECISION NOT NULL,
  lat DOUBLE PRECISION NOT NULL,
  lines TEXT[] DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Bus routes (gestione manuale)
CREATE TABLE IF NOT EXISTS bus_routes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  line_code TEXT,
  name TEXT NOT NULL,
  service_type TEXT NOT NULL DEFAULT 'urban',
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ═══ GTFS Tables ═══════════════════════════════════════════

CREATE TABLE IF NOT EXISTS gtfs_feeds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  filename TEXT NOT NULL,
  agency_name TEXT,
  feed_start_date TEXT,
  feed_end_date TEXT,
  stops_count INTEGER DEFAULT 0,
  routes_count INTEGER DEFAULT 0,
  trips_count INTEGER DEFAULT 0,
  shapes_count INTEGER DEFAULT 0,
  uploaded_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS gtfs_stops (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  feed_id UUID REFERENCES gtfs_feeds(id) ON DELETE CASCADE,
  stop_id TEXT NOT NULL,
  stop_code TEXT,
  stop_name TEXT NOT NULL,
  stop_desc TEXT,
  stop_lat DOUBLE PRECISION NOT NULL,
  stop_lon DOUBLE PRECISION NOT NULL,
  wheelchair_boarding INTEGER DEFAULT 0,
  trips_count INTEGER DEFAULT 0,
  morning_peak_trips INTEGER DEFAULT 0,
  evening_peak_trips INTEGER DEFAULT 0,
  service_score DOUBLE PRECISION DEFAULT 0
);

CREATE TABLE IF NOT EXISTS gtfs_routes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  feed_id UUID REFERENCES gtfs_feeds(id) ON DELETE CASCADE,
  route_id TEXT NOT NULL,
  agency_id TEXT,
  route_short_name TEXT,
  route_long_name TEXT,
  route_type INTEGER DEFAULT 3,
  route_color TEXT,
  route_text_color TEXT,
  trips_count INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS gtfs_shapes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  feed_id UUID REFERENCES gtfs_feeds(id) ON DELETE CASCADE,
  shape_id TEXT NOT NULL,
  route_id TEXT,
  route_short_name TEXT,
  route_color TEXT,
  geojson JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS gtfs_trips (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  feed_id UUID REFERENCES gtfs_feeds(id) ON DELETE CASCADE,
  trip_id TEXT NOT NULL,
  route_id TEXT NOT NULL,
  service_id TEXT NOT NULL,
  trip_headsign TEXT,
  direction_id INTEGER DEFAULT 0,
  shape_id TEXT
);

CREATE TABLE IF NOT EXISTS gtfs_stop_times (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  feed_id UUID REFERENCES gtfs_feeds(id) ON DELETE CASCADE,
  trip_id TEXT NOT NULL,
  stop_id TEXT NOT NULL,
  stop_sequence INTEGER NOT NULL,
  departure_time TEXT,
  arrival_time TEXT
);
CREATE INDEX IF NOT EXISTS idx_stop_times_trip ON gtfs_stop_times(trip_id);
CREATE INDEX IF NOT EXISTS idx_stop_times_stop ON gtfs_stop_times(stop_id);

CREATE TABLE IF NOT EXISTS gtfs_calendar (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  feed_id UUID REFERENCES gtfs_feeds(id) ON DELETE CASCADE,
  service_id TEXT NOT NULL,
  monday INTEGER NOT NULL DEFAULT 0,
  tuesday INTEGER NOT NULL DEFAULT 0,
  wednesday INTEGER NOT NULL DEFAULT 0,
  thursday INTEGER NOT NULL DEFAULT 0,
  friday INTEGER NOT NULL DEFAULT 0,
  saturday INTEGER NOT NULL DEFAULT 0,
  sunday INTEGER NOT NULL DEFAULT 0,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS gtfs_calendar_dates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  feed_id UUID REFERENCES gtfs_feeds(id) ON DELETE CASCADE,
  service_id TEXT NOT NULL,
  date TEXT NOT NULL,
  exception_type INTEGER NOT NULL
);
