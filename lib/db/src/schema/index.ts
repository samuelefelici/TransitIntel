import { pgTable, uuid, text, doublePrecision, integer, timestamp, jsonb } from "drizzle-orm/pg-core";

export const trafficSnapshots = pgTable("traffic_snapshots", {
  id: uuid("id").primaryKey().defaultRandom(),
  segmentId: text("segment_id").notNull(),
  lng: doublePrecision("lng").notNull(),
  lat: doublePrecision("lat").notNull(),
  speed: doublePrecision("speed").notNull(),
  freeflowSpeed: doublePrecision("freeflow_speed").notNull(),
  congestionLevel: doublePrecision("congestion_level").notNull(),
  capturedAt: timestamp("captured_at", { withTimezone: true }).defaultNow(),
});

export const censusSections = pgTable("census_sections", {
  id: uuid("id").primaryKey().defaultRandom(),
  istatCode: text("istat_code").unique(),
  centroidLng: doublePrecision("centroid_lng").notNull().default(0),
  centroidLat: doublePrecision("centroid_lat").notNull().default(0),
  population: integer("population").notNull().default(0),
  areaKm2: doublePrecision("area_km2").notNull().default(0),
  density: doublePrecision("density").notNull().default(0),
  geojson: jsonb("geojson"),                         // GeoJSON Polygon/MultiPolygon geometry (WGS84)
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export const pointsOfInterest = pgTable("points_of_interest", {
  id: uuid("id").primaryKey().defaultRandom(),
  osmId: integer("osm_id").unique(),
  name: text("name"),
  category: text("category").notNull(),
  lng: doublePrecision("lng").notNull(),
  lat: doublePrecision("lat").notNull(),
  properties: jsonb("properties").default({}),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export const busStops = pgTable("bus_stops", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: text("code").unique(),
  name: text("name").notNull(),
  lng: doublePrecision("lng").notNull(),
  lat: doublePrecision("lat").notNull(),
  lines: text("lines").array().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const busRoutes = pgTable("bus_routes", {
  id: uuid("id").primaryKey().defaultRandom(),
  lineCode: text("line_code"),
  name: text("name").notNull(),
  serviceType: text("service_type").notNull().default("urban"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const gtfsFeeds = pgTable("gtfs_feeds", {
  id: uuid("id").primaryKey().defaultRandom(),
  filename: text("filename").notNull(),
  agencyName: text("agency_name"),
  feedStartDate: text("feed_start_date"),
  feedEndDate: text("feed_end_date"),
  stopsCount: integer("stops_count").default(0),
  routesCount: integer("routes_count").default(0),
  tripsCount: integer("trips_count").default(0),
  shapesCount: integer("shapes_count").default(0),
  uploadedAt: timestamp("uploaded_at", { withTimezone: true }).defaultNow(),
});

export const gtfsStops = pgTable("gtfs_stops", {
  id: uuid("id").primaryKey().defaultRandom(),
  feedId: uuid("feed_id").references(() => gtfsFeeds.id, { onDelete: "cascade" }),
  stopId: text("stop_id").notNull(),
  stopCode: text("stop_code"),
  stopName: text("stop_name").notNull(),
  stopDesc: text("stop_desc"),
  stopLat: doublePrecision("stop_lat").notNull(),
  stopLon: doublePrecision("stop_lon").notNull(),
  wheelchairBoarding: integer("wheelchair_boarding").default(0),
  tripsCount: integer("trips_count").default(0),
  morningPeakTrips: integer("morning_peak_trips").default(0),
  eveningPeakTrips: integer("evening_peak_trips").default(0),
  serviceScore: doublePrecision("service_score").default(0),
});

export const gtfsRoutes = pgTable("gtfs_routes", {
  id: uuid("id").primaryKey().defaultRandom(),
  feedId: uuid("feed_id").references(() => gtfsFeeds.id, { onDelete: "cascade" }),
  routeId: text("route_id").notNull(),
  agencyId: text("agency_id"),
  routeShortName: text("route_short_name"),
  routeLongName: text("route_long_name"),
  routeType: integer("route_type").default(3),
  routeColor: text("route_color"),
  routeTextColor: text("route_text_color"),
  tripsCount: integer("trips_count").default(0),
});

export const gtfsShapes = pgTable("gtfs_shapes", {
  id: uuid("id").primaryKey().defaultRandom(),
  feedId: uuid("feed_id").references(() => gtfsFeeds.id, { onDelete: "cascade" }),
  shapeId: text("shape_id").notNull(),
  routeId: text("route_id"),
  routeShortName: text("route_short_name"),
  routeColor: text("route_color"),
  geojson: jsonb("geojson").notNull(),
});

// GTFS Trips — one record per trip in the feed
export const gtfsTrips = pgTable("gtfs_trips", {
  id: uuid("id").primaryKey().defaultRandom(),
  feedId: uuid("feed_id").references(() => gtfsFeeds.id, { onDelete: "cascade" }),
  tripId: text("trip_id").notNull(),
  routeId: text("route_id").notNull(),
  serviceId: text("service_id").notNull(),
  tripHeadsign: text("trip_headsign"),
  directionId: integer("direction_id").default(0),
  shapeId: text("shape_id"),
});

// GTFS Stop Times — departure time at each stop in a trip
export const gtfsStopTimes = pgTable("gtfs_stop_times", {
  id: uuid("id").primaryKey().defaultRandom(),
  feedId: uuid("feed_id").references(() => gtfsFeeds.id, { onDelete: "cascade" }),
  tripId: text("trip_id").notNull(),
  stopId: text("stop_id").notNull(),
  stopSequence: integer("stop_sequence").notNull(),
  departureTime: text("departure_time"),  // HH:MM:SS (may be >24h for overnight)
  arrivalTime: text("arrival_time"),
});

// GTFS Calendar — regular weekly service patterns
export const gtfsCalendar = pgTable("gtfs_calendar", {
  id: uuid("id").primaryKey().defaultRandom(),
  feedId: uuid("feed_id").references(() => gtfsFeeds.id, { onDelete: "cascade" }),
  serviceId: text("service_id").notNull(),
  monday: integer("monday").notNull().default(0),
  tuesday: integer("tuesday").notNull().default(0),
  wednesday: integer("wednesday").notNull().default(0),
  thursday: integer("thursday").notNull().default(0),
  friday: integer("friday").notNull().default(0),
  saturday: integer("saturday").notNull().default(0),
  sunday: integer("sunday").notNull().default(0),
  startDate: text("start_date").notNull(),
  endDate: text("end_date").notNull(),
});

// GTFS Calendar Dates — exceptions (added/removed service on specific dates)
export const gtfsCalendarDates = pgTable("gtfs_calendar_dates", {
  id: uuid("id").primaryKey().defaultRandom(),
  feedId: uuid("feed_id").references(() => gtfsFeeds.id, { onDelete: "cascade" }),
  serviceId: text("service_id").notNull(),
  date: text("date").notNull(),            // YYYYMMDD
  exceptionType: integer("exception_type").notNull(), // 1=added, 2=removed
});

// Scenarios — planned route scenarios built from KML/KMZ files
export const scenarios = pgTable("scenarios", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  description: text("description"),
  color: text("color").notNull().default("#3b82f6"),
  geojson: jsonb("geojson").notNull(),             // GeoJSON FeatureCollection (lines + points from KML)
  stopsCount: integer("stops_count").default(0),
  lengthKm: doublePrecision("length_km").default(0),
  metadata: jsonb("metadata").default({}),          // extra KML metadata, folder names, etc.
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

// Isochrone cache — avoids re-calling ORS for the same stop + minutes
export const isochroneCache = pgTable("isochrone_cache", {
  id: uuid("id").primaryKey().defaultRandom(),
  latRound: doublePrecision("lat_round").notNull(), // rounded to 4 decimals (~11m)
  lngRound: doublePrecision("lng_round").notNull(),
  minutes: integer("minutes").notNull(),
  geojson: jsonb("geojson").notNull(),              // GeoJSON geometry (Polygon/MultiPolygon)
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

// Service Program Scenarios — saved vehicle shift plans for driver shift generation
export const serviceProgramScenarios = pgTable("service_program_scenarios", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  date: text("date").notNull(),                      // YYYYMMDD
  feedId: uuid("feed_id"),
  /** Full optimizer input: route→vehicleType→forced mappings */
  input: jsonb("input").notNull(),
  /** Full optimizer output: shifts, costs, score, advisories, summary, etc. */
  result: jsonb("result").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

// Driver Shift Scenarios — scenari turni guida salvati (N:1 con turni macchina)
export const driverShiftScenarios = pgTable("driver_shift_scenarios", {
  id: uuid("id").primaryKey().defaultRandom(),
  serviceProgramScenarioId: uuid("service_program_scenario_id")
    .references(() => serviceProgramScenarios.id, { onDelete: "cascade" })
    .notNull(),
  name: text("name").notNull(),
  result: jsonb("result").notNull(),
  config: jsonb("config"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

// Scenario Service Programs — programmi di esercizio generati da scenari KML
export const scenarioServicePrograms = pgTable("scenario_service_programs", {
  id: uuid("id").primaryKey().defaultRandom(),
  scenarioId: uuid("scenario_id")
    .references(() => scenarios.id, { onDelete: "cascade" })
    .notNull(),
  name: text("name").notNull(),
  /** Configuration used to generate: targetKm, serviceWindow, etc. */
  config: jsonb("config").notNull(),
  /** Generated program: trips with stop times, cadences, metrics */
  result: jsonb("result").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

// Stop Clusters — gruppi di fermate per cambi in linea
export const stopClusters = pgTable("stop_clusters", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  transferFromDepotMin: integer("transfer_from_depot_min").notNull().default(10),
  color: text("color").notNull().default("#3b82f6"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

// Stop Cluster Stops — fermate GTFS assegnate a un cluster
export const stopClusterStops = pgTable("stop_cluster_stops", {
  id: uuid("id").primaryKey().defaultRandom(),
  clusterId: uuid("cluster_id").references(() => stopClusters.id, { onDelete: "cascade" }).notNull(),
  gtfsStopId: text("gtfs_stop_id").notNull(),   // stop_id dal GTFS
  stopName: text("stop_name").notNull(),
  stopLat: doublePrecision("stop_lat").notNull(),
  stopLon: doublePrecision("stop_lon").notNull(),
});

// App Settings — configurazione globale (autovetture, ecc.)
export const appSettings = pgTable("app_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export type TrafficSnapshot = typeof trafficSnapshots.$inferSelect;
export type CensusSection = typeof censusSections.$inferSelect;
export type PointOfInterest = typeof pointsOfInterest.$inferSelect;
export type BusStop = typeof busStops.$inferSelect;
export type BusRoute = typeof busRoutes.$inferSelect;
export type GtfsFeed = typeof gtfsFeeds.$inferSelect;
export type GtfsStop = typeof gtfsStops.$inferSelect;
export type GtfsRoute = typeof gtfsRoutes.$inferSelect;
export type GtfsShape = typeof gtfsShapes.$inferSelect;
export type GtfsTrip = typeof gtfsTrips.$inferSelect;
export type GtfsStopTime = typeof gtfsStopTimes.$inferSelect;
export type GtfsCalendar = typeof gtfsCalendar.$inferSelect;
export type GtfsCalendarDate = typeof gtfsCalendarDates.$inferSelect;
export type IsochroneCache = typeof isochroneCache.$inferSelect;
export type Scenario = typeof scenarios.$inferSelect;
export type ServiceProgramScenario = typeof serviceProgramScenarios.$inferSelect;
export type StopCluster = typeof stopClusters.$inferSelect;
export type StopClusterStop = typeof stopClusterStops.$inferSelect;
export type AppSetting = typeof appSettings.$inferSelect;
export type DriverShiftScenario = typeof driverShiftScenarios.$inferSelect;
export type ScenarioServiceProgram = typeof scenarioServicePrograms.$inferSelect;
