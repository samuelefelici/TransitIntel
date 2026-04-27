import { pgTable, uuid, text, doublePrecision, integer, timestamp, jsonb, boolean, date, index, uniqueIndex } from "drizzle-orm/pg-core";

export const trafficSnapshots = pgTable("traffic_snapshots", {
  id: uuid("id").primaryKey().defaultRandom(),
  segmentId: text("segment_id").notNull(),
  lng: doublePrecision("lng").notNull(),
  lat: doublePrecision("lat").notNull(),
  speed: doublePrecision("speed").notNull(),
  freeflowSpeed: doublePrecision("freeflow_speed").notNull(),
  congestionLevel: doublePrecision("congestion_level").notNull(),
  capturedAt: timestamp("captured_at", { withTimezone: true }).defaultNow(),
}, (t) => [
  index("idx_traffic_segment_id").on(t.segmentId),
  index("idx_traffic_captured_at").on(t.capturedAt),
  index("idx_traffic_segment_captured").on(t.segmentId, t.capturedAt),
]);

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
}, (t) => [
  index("idx_census_istat_code").on(t.istatCode),
]);

export const pointsOfInterest = pgTable("points_of_interest", {
  id: uuid("id").primaryKey().defaultRandom(),
  osmId: integer("osm_id").unique(),
  name: text("name"),
  category: text("category").notNull(),
  lng: doublePrecision("lng").notNull(),
  lat: doublePrecision("lat").notNull(),
  properties: jsonb("properties").default({}),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
}, (t) => [
  index("idx_poi_category").on(t.category),
]);

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
}, (t) => [
  index("idx_gtfs_stops_feed_id").on(t.feedId),
  index("idx_gtfs_stops_feed_stop").on(t.feedId, t.stopId),
]);

export const gtfsRoutes = pgTable("gtfs_routes", {
  id: uuid("id").primaryKey().defaultRandom(),
  feedId: uuid("feed_id").references(() => gtfsFeeds.id, { onDelete: "cascade" }),
  routeId: text("route_id").notNull(),
  agencyId: text("agency_id"),
  routeShortName: text("route_short_name"),
  routeLongName: text("route_long_name"),
  routeType: integer("route_type").default(3),
  routeUrl: text("route_url"),
  routeColor: text("route_color"),
  routeTextColor: text("route_text_color"),
  tripsCount: integer("trips_count").default(0),
}, (t) => [
  index("idx_gtfs_routes_feed_id").on(t.feedId),
  index("idx_gtfs_routes_feed_route").on(t.feedId, t.routeId),
]);

export const gtfsShapes = pgTable("gtfs_shapes", {
  id: uuid("id").primaryKey().defaultRandom(),
  feedId: uuid("feed_id").references(() => gtfsFeeds.id, { onDelete: "cascade" }),
  shapeId: text("shape_id").notNull(),
  routeId: text("route_id"),
  routeShortName: text("route_short_name"),
  routeColor: text("route_color"),
  geojson: jsonb("geojson").notNull(),
}, (t) => [
  index("idx_gtfs_shapes_feed_id").on(t.feedId),
  index("idx_gtfs_shapes_feed_shape").on(t.feedId, t.shapeId),
]);

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
}, (t) => [
  index("idx_gtfs_trips_feed_id").on(t.feedId),
  index("idx_gtfs_trips_feed_trip").on(t.feedId, t.tripId),
  index("idx_gtfs_trips_feed_route").on(t.feedId, t.routeId),
  index("idx_gtfs_trips_feed_service").on(t.feedId, t.serviceId),
]);

// GTFS Stop Times — departure time at each stop in a trip
export const gtfsStopTimes = pgTable("gtfs_stop_times", {
  id: uuid("id").primaryKey().defaultRandom(),
  feedId: uuid("feed_id").references(() => gtfsFeeds.id, { onDelete: "cascade" }),
  tripId: text("trip_id").notNull(),
  stopId: text("stop_id").notNull(),
  stopSequence: integer("stop_sequence").notNull(),
  departureTime: text("departure_time"),  // HH:MM:SS (may be >24h for overnight)
  arrivalTime: text("arrival_time"),
  pickupType: integer("pickup_type").notNull().default(0),    // 0=Regular, 1=No pickup
  dropOffType: integer("drop_off_type").notNull().default(0), // 0=Regular, 1=No drop-off
}, (t) => [
  index("idx_gtfs_stop_times_feed_id").on(t.feedId),
  index("idx_gtfs_stop_times_feed_trip").on(t.feedId, t.tripId),
  index("idx_gtfs_stop_times_feed_stop").on(t.feedId, t.stopId),
  index("idx_gtfs_stop_times_feed_trip_seq").on(t.feedId, t.tripId, t.stopSequence),
]);

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
}, (t) => [
  index("idx_gtfs_calendar_feed_id").on(t.feedId),
  uniqueIndex("idx_gtfs_calendar_feed_service").on(t.feedId, t.serviceId),
]);

// GTFS Calendar Dates — exceptions (added/removed service on specific dates)
export const gtfsCalendarDates = pgTable("gtfs_calendar_dates", {
  id: uuid("id").primaryKey().defaultRandom(),
  feedId: uuid("feed_id").references(() => gtfsFeeds.id, { onDelete: "cascade" }),
  serviceId: text("service_id").notNull(),
  date: text("date").notNull(),            // YYYYMMDD
  exceptionType: integer("exception_type").notNull(), // 1=added, 2=removed
}, (t) => [
  index("idx_gtfs_cal_dates_feed_id").on(t.feedId),
  index("idx_gtfs_cal_dates_feed_service").on(t.feedId, t.serviceId),
  index("idx_gtfs_cal_dates_feed_date").on(t.feedId, t.date),
]);

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
}, (t) => [
  index("idx_isochrone_lat_lng_min").on(t.latRound, t.lngRound, t.minutes),
]);

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
}, (t) => [
  index("idx_sps_feed_id").on(t.feedId),
  index("idx_sps_date").on(t.date),
]);

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
}, (t) => [
  index("idx_dss_sps_id").on(t.serviceProgramScenarioId),
]);

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
}, (t) => [
  index("idx_ssp_scenario_id").on(t.scenarioId),
]);

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
}, (t) => [
  index("idx_scs_cluster_id").on(t.clusterId),
  index("idx_scs_gtfs_stop_id").on(t.gtfsStopId),
]);

// Coincidence Zones — zone di coincidenza intermodale (treni/navi ↔ bus)
export const coincidenceZones = pgTable("coincidence_zones", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  hubId: text("hub_id").notNull(),
  hubName: text("hub_name").notNull(),
  hubType: text("hub_type").notNull(),
  hubLat: doublePrecision("hub_lat").notNull(),
  hubLng: doublePrecision("hub_lng").notNull(),
  walkMinutes: integer("walk_minutes").notNull().default(5),
  radiusKm: doublePrecision("radius_km").notNull().default(0.5),
  color: text("color").notNull().default("#06b6d4"),
  notes: text("notes"),
  // Orari custom della zona: { arrivals: [{label, times[]}], departures: [{label, times[]}] }
  // Es. { "arrivals":[{"label":"Roma","times":["07:42","09:42"]}], "departures":[...] }
  schedules: jsonb("schedules"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

// Coincidence Zone Stops — fermate GTFS nella zona di coincidenza
export const coincidenceZoneStops = pgTable("coincidence_zone_stops", {
  id: uuid("id").primaryKey().defaultRandom(),
  zoneId: uuid("zone_id").references(() => coincidenceZones.id, { onDelete: "cascade" }).notNull(),
  gtfsStopId: text("gtfs_stop_id").notNull(),
  stopName: text("stop_name").notNull(),
  stopLat: doublePrecision("stop_lat").notNull(),
  stopLon: doublePrecision("stop_lon").notNull(),
  distanceKm: doublePrecision("distance_km"),
  walkMinFromHub: integer("walk_min_from_hub"),
}, (t) => [
  index("idx_czs_zone_id").on(t.zoneId),
  index("idx_czs_gtfs_stop_id").on(t.gtfsStopId),
]);

// Scenario Program Calendars — validità temporali per programmi di esercizio (→ GTFS calendar.txt)
export const scenarioProgramCalendars = pgTable("scenario_program_calendars", {
  id: uuid("id").primaryKey().defaultRandom(),
  programId: uuid("program_id").notNull().references(() => scenarioServicePrograms.id, { onDelete: "cascade" }),
  serviceId: text("service_id").notNull(),
  serviceName: text("service_name").notNull(),
  monday: boolean("monday").notNull().default(true),
  tuesday: boolean("tuesday").notNull().default(true),
  wednesday: boolean("wednesday").notNull().default(true),
  thursday: boolean("thursday").notNull().default(true),
  friday: boolean("friday").notNull().default(true),
  saturday: boolean("saturday").notNull().default(false),
  sunday: boolean("sunday").notNull().default(false),
  startDate: date("start_date").notNull(),
  endDate: date("end_date").notNull(),
  cadenceMultiplier: doublePrecision("cadence_multiplier").notNull().default(1.0),
  isVariant: boolean("is_variant").notNull().default(false),
  variantConfig: jsonb("variant_config"),
  color: text("color").default("#3b82f6"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
}, (t) => [
  index("idx_spc_program_id").on(t.programId),
]);

// Scenario Program Calendar Exceptions — eccezioni (festivi, scioperi, eventi)
export const scenarioProgramCalendarExceptions = pgTable("scenario_program_calendar_exceptions", {
  id: uuid("id").primaryKey().defaultRandom(),
  calendarId: uuid("calendar_id").notNull().references(() => scenarioProgramCalendars.id, { onDelete: "cascade" }),
  exceptionDate: date("exception_date").notNull(),
  exceptionType: integer("exception_type").notNull(), // 1=added, 2=removed
  description: text("description"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (t) => [
  index("idx_spce_calendar_id").on(t.calendarId),
  index("idx_spce_exception_date").on(t.exceptionDate),
]);

// App Settings — configurazione globale (autovetture, ecc.)
export const appSettings = pgTable("app_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

// Weather Snapshots — hourly weather data from OpenWeatherMap
export const weatherSnapshots = pgTable("weather_snapshots", {
  id: uuid("id").primaryKey().defaultRandom(),
  lat: doublePrecision("lat").notNull(),
  lng: doublePrecision("lng").notNull(),
  locationName: text("location_name"),
  temp: doublePrecision("temp"),                  // °C
  feelsLike: doublePrecision("feels_like"),       // °C
  humidity: integer("humidity"),                   // %
  windSpeed: doublePrecision("wind_speed"),       // m/s
  weatherMain: text("weather_main"),              // "Rain", "Clear", "Clouds", etc.
  weatherDescription: text("weather_description"),// "light rain", "overcast clouds", etc.
  weatherIcon: text("weather_icon"),              // icon code e.g. "10d"
  rain1h: doublePrecision("rain_1h"),             // mm precipitation last 1h
  snow1h: doublePrecision("snow_1h"),             // mm snow last 1h
  visibility: integer("visibility"),              // metres
  capturedAt: timestamp("captured_at", { withTimezone: true }).defaultNow(),
}, (t) => [
  index("idx_weather_captured_at").on(t.capturedAt),
  index("idx_weather_location").on(t.lat, t.lng),
  index("idx_weather_main").on(t.weatherMain),
]);

// ═══════════════════════════════════════════════════════════════
// GTFS Fares V2 — Bigliettazione Elettronica
// ═══════════════════════════════════════════════════════════════

// Fare Networks — reti tariffarie (urbano_ancona, urbano_jesi, urbano_falconara, extraurbano)
export const gtfsFareNetworks = pgTable("gtfs_fare_networks", {
  id: uuid("id").primaryKey().defaultRandom(),
  feedId: uuid("feed_id").references(() => gtfsFeeds.id, { onDelete: "cascade" }),
  networkId: text("network_id").notNull(),         // e.g. "urbano_ancona"
  networkName: text("network_name").notNull(),     // e.g. "Urbano di Ancona"
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
}, (t) => [
  uniqueIndex("idx_fare_networks_feed_network").on(t.feedId, t.networkId),
]);

// Route–Network association — each route belongs to exactly one network
export const gtfsRouteNetworks = pgTable("gtfs_route_networks", {
  id: uuid("id").primaryKey().defaultRandom(),
  feedId: uuid("feed_id").references(() => gtfsFeeds.id, { onDelete: "cascade" }),
  routeId: text("route_id").notNull(),
  networkId: text("network_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (t) => [
  uniqueIndex("idx_route_networks_feed_route").on(t.feedId, t.routeId),
  index("idx_route_networks_feed_network").on(t.feedId, t.networkId),
]);

// Fare Media — payment methods (contactless card, paper, cEMV, app, cash)
export const gtfsFareMedia = pgTable("gtfs_fare_media", {
  id: uuid("id").primaryKey().defaultRandom(),
  feedId: uuid("feed_id").references(() => gtfsFeeds.id, { onDelete: "cascade" }),
  fareMediaId: text("fare_media_id").notNull(),       // e.g. "carta_contactless"
  fareMediaName: text("fare_media_name").notNull(),
  fareMediaType: integer("fare_media_type").notNull(), // 0=cash,1=paper,2=contactless,3=cEMV,4=app
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
}, (t) => [
  uniqueIndex("idx_fare_media_feed_media").on(t.feedId, t.fareMediaId),
]);

// Rider Categories — passenger types (ordinario, studente, anziano, ...)
export const gtfsRiderCategories = pgTable("gtfs_rider_categories", {
  id: uuid("id").primaryKey().defaultRandom(),
  feedId: uuid("feed_id").references(() => gtfsFeeds.id, { onDelete: "cascade" }),
  riderCategoryId: text("rider_category_id").notNull(),
  riderCategoryName: text("rider_category_name").notNull(),
  isDefault: boolean("is_default").notNull().default(false),
  eligibilityUrl: text("eligibility_url"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
}, (t) => [
  uniqueIndex("idx_rider_cat_feed_cat").on(t.feedId, t.riderCategoryId),
]);

// Fare Products — actual ticket products with prices
export const gtfsFareProducts = pgTable("gtfs_fare_products", {
  id: uuid("id").primaryKey().defaultRandom(),
  feedId: uuid("feed_id").references(() => gtfsFeeds.id, { onDelete: "cascade" }),
  fareProductId: text("fare_product_id").notNull(),    // e.g. "ancona_60min"
  fareProductName: text("fare_product_name").notNull(),
  networkId: text("network_id"),                        // which network it belongs to
  riderCategoryId: text("rider_category_id"),
  fareMediaId: text("fare_media_id"),
  amount: doublePrecision("amount").notNull(),          // price in EUR
  currency: text("currency").notNull().default("EUR"),
  durationMinutes: integer("duration_minutes"),         // validity in minutes (60, 100, etc.)
  fareType: text("fare_type").notNull().default("single"), // "single", "return", "zone"
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
}, (t) => [
  index("idx_fare_products_feed").on(t.feedId),
  index("idx_fare_products_network").on(t.feedId, t.networkId),
]);

// Fare Areas — tariff zones (urban flat areas + extraurban km-based areas per route)
export const gtfsFareAreas = pgTable("gtfs_fare_areas", {
  id: uuid("id").primaryKey().defaultRandom(),
  feedId: uuid("feed_id").references(() => gtfsFeeds.id, { onDelete: "cascade" }),
  areaId: text("area_id").notNull(),               // e.g. "ancona_urban" or "A_zona_1"
  areaName: text("area_name").notNull(),
  networkId: text("network_id"),                    // which network
  routeId: text("route_id"),                        // for extraurban: which route this area belongs to
  kmFrom: doublePrecision("km_from"),              // start km for this zone (extraurban only)
  kmTo: doublePrecision("km_to"),                  // end km for this zone (extraurban only)
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
}, (t) => [
  uniqueIndex("idx_fare_areas_feed_area").on(t.feedId, t.areaId),
  index("idx_fare_areas_feed_network").on(t.feedId, t.networkId),
  index("idx_fare_areas_feed_route").on(t.feedId, t.routeId),
]);

// Stop–Area assignment — a stop can belong to multiple areas
export const gtfsStopAreas = pgTable("gtfs_stop_areas", {
  id: uuid("id").primaryKey().defaultRandom(),
  feedId: uuid("feed_id").references(() => gtfsFeeds.id, { onDelete: "cascade" }),
  areaId: text("area_id").notNull(),
  stopId: text("stop_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (t) => [
  uniqueIndex("idx_stop_areas_unique_feed_area_stop").on(t.feedId, t.areaId, t.stopId),
  index("idx_stop_areas_feed_area").on(t.feedId, t.areaId),
  index("idx_stop_areas_feed_stop").on(t.feedId, t.stopId),
]);

// Fare Leg Rules — the pricing matrix: network × from_area × to_area → fare_product
export const gtfsFareLegRules = pgTable("gtfs_fare_leg_rules", {
  id: uuid("id").primaryKey().defaultRandom(),
  feedId: uuid("feed_id").references(() => gtfsFeeds.id, { onDelete: "cascade" }),
  legGroupId: text("leg_group_id").notNull(),
  networkId: text("network_id"),
  fromAreaId: text("from_area_id"),
  toAreaId: text("to_area_id"),
  fromTimeframeGroupId: text("from_timeframe_group_id"),
  toTimeframeGroupId: text("to_timeframe_group_id"),
  fareProductId: text("fare_product_id").notNull(),
  rulePriority: integer("rule_priority").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (t) => [
  index("idx_fare_leg_rules_feed").on(t.feedId),
  index("idx_fare_leg_rules_network").on(t.feedId, t.networkId),
]);

// Timeframes — fare variation by time-of-day / day-of-week (GTFS timeframes.txt)
export const gtfsTimeframes = pgTable("gtfs_timeframes", {
  id: uuid("id").primaryKey().defaultRandom(),
  feedId: uuid("feed_id").references(() => gtfsFeeds.id, { onDelete: "cascade" }),
  timeframeGroupId: text("timeframe_group_id").notNull(),
  startTime: text("start_time"),       // HH:MM:SS
  endTime: text("end_time"),           // HH:MM:SS
  serviceId: text("service_id"),       // FK → calendar.service_id
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (t) => [
  index("idx_timeframes_feed").on(t.feedId),
  index("idx_timeframes_group").on(t.feedId, t.timeframeGroupId),
]);

// Fare Transfer Rules — inter-network transfer discounts/free transfers
export const gtfsFareTransferRules = pgTable("gtfs_fare_transfer_rules", {
  id: uuid("id").primaryKey().defaultRandom(),
  feedId: uuid("feed_id").references(() => gtfsFeeds.id, { onDelete: "cascade" }),
  fromLegGroupId: text("from_leg_group_id"),
  toLegGroupId: text("to_leg_group_id"),
  transferCount: integer("transfer_count"),
  durationLimit: integer("duration_limit"),             // seconds
  durationLimitType: integer("duration_limit_type"),    // 0=start-to-start, 1=start-to-end
  fareTransferType: integer("fare_transfer_type"),      // 0=A+B, 1=A+discount, 2=max(A,B)
  fareProductId: text("fare_product_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (t) => [
  index("idx_fare_transfer_rules_feed").on(t.feedId),
]);

// GTFS Fare Attributes (Fares V1) — fare_attributes.txt
export const gtfsFareAttributes = pgTable("gtfs_fare_attributes", {
  id: uuid("id").primaryKey().defaultRandom(),
  feedId: uuid("feed_id").references(() => gtfsFeeds.id, { onDelete: "cascade" }),
  fareId: text("fare_id").notNull(),
  price: doublePrecision("price").notNull(),
  currencyType: text("currency_type").notNull().default("EUR"),
  paymentMethod: integer("payment_method").notNull().default(0),     // 0=On board, 1=Before boarding
  transfers: integer("transfers"),                                    // 0=None, 1=One, 2=Two, null=Unlimited
  agencyId: text("agency_id"),
  transferDuration: integer("transfer_duration"),                    // seconds
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (t) => [
  index("idx_fare_attr_feed").on(t.feedId),
  index("idx_fare_attr_feed_fare").on(t.feedId, t.fareId),
]);

// GTFS Fare Rules (Fares V1) — fare_rules.txt
export const gtfsFareRules = pgTable("gtfs_fare_rules", {
  id: uuid("id").primaryKey().defaultRandom(),
  feedId: uuid("feed_id").references(() => gtfsFeeds.id, { onDelete: "cascade" }),
  fareId: text("fare_id").notNull(),
  routeId: text("route_id"),
  originId: text("origin_id"),           // zone_id of origin stop
  destinationId: text("destination_id"), // zone_id of destination stop
  containsId: text("contains_id"),       // zone_id of traversed zone
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (t) => [
  index("idx_fare_rules_feed").on(t.feedId),
  index("idx_fare_rules_feed_fare").on(t.feedId, t.fareId),
]);

// Fare Zone Clusters — polygonal clusters for cluster-based zoning (alternative to km-based)
export const gtfsFareZoneClusters = pgTable("gtfs_fare_zone_clusters", {
  id: uuid("id").primaryKey().defaultRandom(),
  feedId: uuid("feed_id").references(() => gtfsFeeds.id, { onDelete: "cascade" }),
  clusterId: text("cluster_id").notNull(),          // e.g. "cluster_ancona_nord"
  clusterName: text("cluster_name").notNull(),       // human name
  polygon: jsonb("polygon"),                         // GeoJSON Polygon geometry
  centroidLat: doublePrecision("centroid_lat"),
  centroidLon: doublePrecision("centroid_lon"),
  color: text("color").notNull().default("#3b82f6"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
}, (t) => [
  uniqueIndex("idx_fare_zone_clusters_feed_cluster").on(t.feedId, t.clusterId),
]);

// Fare Zone Cluster Stops — stops assigned to a cluster
export const gtfsFareZoneClusterStops = pgTable("gtfs_fare_zone_cluster_stops", {
  id: uuid("id").primaryKey().defaultRandom(),
  feedId: uuid("feed_id").references(() => gtfsFeeds.id, { onDelete: "cascade" }),
  clusterId: text("cluster_id").notNull(),
  stopId: text("stop_id").notNull(),
  stopName: text("stop_name").notNull(),
  stopLat: doublePrecision("stop_lat").notNull(),
  stopLon: doublePrecision("stop_lon").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (t) => [
  index("idx_fare_zone_cs_feed_cluster").on(t.feedId, t.clusterId),
  index("idx_fare_zone_cs_feed_stop").on(t.feedId, t.stopId),
]);

// Fare Audit Log — tracciamento normativo delle azioni sulla tariffazione
export const gtfsFareAuditLog = pgTable("gtfs_fare_audit_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  feedId: uuid("feed_id").references(() => gtfsFeeds.id, { onDelete: "cascade" }),
  action: text("action").notNull(),         // "generate_gtfs" | "validate" | "update_product" | "update_price" | "manual_note" | "seed_products" | "generate_zones" | "generate_leg_rules"
  description: text("description").notNull(),
  actor: text("actor").notNull().default("system"), // "system" or username
  metadata: jsonb("metadata").default({}),           // snapshot of what changed (product old/new price, etc.)
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (t) => [
  index("idx_fare_audit_feed").on(t.feedId),
  index("idx_fare_audit_created").on(t.createdAt),
  index("idx_fare_audit_action").on(t.action),
]);

// Feed Info — metadata about the GTFS feed (feed_info.txt)
export const gtfsFeedInfo = pgTable("gtfs_feed_info", {
  id: uuid("id").primaryKey().defaultRandom(),
  feedId: uuid("feed_id").references(() => gtfsFeeds.id, { onDelete: "cascade" }),
  feedPublisherName: text("feed_publisher_name").notNull(),
  feedPublisherUrl: text("feed_publisher_url").notNull(),
  feedLang: text("feed_lang").notNull().default("it"),
  defaultLang: text("default_lang"),
  feedStartDate: text("feed_start_date"),
  feedEndDate: text("feed_end_date"),
  feedVersion: text("feed_version"),
  feedContactEmail: text("feed_contact_email"),
  feedContactUrl: text("feed_contact_url"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (t) => [
  uniqueIndex("idx_feed_info_feed").on(t.feedId),
]);

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
export type CoincidenceZone = typeof coincidenceZones.$inferSelect;
export type CoincidenceZoneStop = typeof coincidenceZoneStops.$inferSelect;
export type AppSetting = typeof appSettings.$inferSelect;
export type DriverShiftScenario = typeof driverShiftScenarios.$inferSelect;
export type ScenarioServiceProgram = typeof scenarioServicePrograms.$inferSelect;
export type ScenarioProgramCalendar = typeof scenarioProgramCalendars.$inferSelect;
export type ScenarioProgramCalendarException = typeof scenarioProgramCalendarExceptions.$inferSelect;
export type WeatherSnapshot = typeof weatherSnapshots.$inferSelect;
export type GtfsFareNetwork = typeof gtfsFareNetworks.$inferSelect;
export type GtfsRouteNetwork = typeof gtfsRouteNetworks.$inferSelect;
export type GtfsFareMedia = typeof gtfsFareMedia.$inferSelect;
export type GtfsRiderCategory = typeof gtfsRiderCategories.$inferSelect;
export type GtfsFareProduct = typeof gtfsFareProducts.$inferSelect;
export type GtfsFareArea = typeof gtfsFareAreas.$inferSelect;
export type GtfsStopArea = typeof gtfsStopAreas.$inferSelect;
export type GtfsFareLegRule = typeof gtfsFareLegRules.$inferSelect;
export type GtfsTimeframe = typeof gtfsTimeframes.$inferSelect;
export type GtfsFareTransferRule = typeof gtfsFareTransferRules.$inferSelect;
export type GtfsFareAttribute = typeof gtfsFareAttributes.$inferSelect;
export type GtfsFareRule = typeof gtfsFareRules.$inferSelect;
export type GtfsFareZoneCluster = typeof gtfsFareZoneClusters.$inferSelect;
export type GtfsFareZoneClusterStop = typeof gtfsFareZoneClusterStops.$inferSelect;
export type GtfsFeedInfo = typeof gtfsFeedInfo.$inferSelect;
export type GtfsFareAuditLog = typeof gtfsFareAuditLog.$inferSelect;

/* ── Depots ─────────────────────────────────────────────────────────────────
 * Depositi — punti di rimessaggio autobus e presa di servizio dei conducenti.
 *
 * Ogni deposito ha:
 *   - Dati anagrafici: nome, indirizzo
 *   - Posizione geografica: lat/lon (obbligatoria per la mappa e i calcoli)
 *   - Operatività: capacità (n. bus), orari apertura/chiusura
 *   - Rifornimento: tipi carburante (diesel | methane | electric),
 *       punti ricarica elettrica, punti metano
 *   - Metadati: note libere, colore per la mappa
 * ─────────────────────────────────────────────────────────────────────────── */
export const depots = pgTable("depots", {
  id:                  uuid("id").primaryKey().defaultRandom(),
  name:                text("name").notNull(),
  address:             text("address"),
  lat:                 doublePrecision("lat"),               // WGS84
  lon:                 doublePrecision("lon"),               // WGS84
  // Operatività
  capacity:            integer("capacity"),                  // n. max autobus ospitabili
  operatingHoursStart: text("operating_hours_start"),        // "HH:mm"
  operatingHoursEnd:   text("operating_hours_end"),          // "HH:mm"
  // Rifornimento
  hasDiesel:           boolean("has_diesel").default(false),
  hasMethane:          boolean("has_methane").default(false),
  hasElectric:         boolean("has_electric").default(false),
  chargingPoints:      integer("charging_points").default(0), // colonnine elettriche
  cngPoints:           integer("cng_points").default(0),      // distributori metano
  // Presentazione
  color:               text("color").default("#3b82f6"),
  notes:               text("notes"),
  // Audit
  createdAt:           timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt:           timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export type Depot = typeof depots.$inferSelect;

/* ── PlannerStudio ──────────────────────────────────────────────────────────
 * Scenari di pianificazione GTFS: si parte da un feed baseline e si
 * applicano modifiche (edit log) → nuovo scenario simulato. Single-tenant.
 * ─────────────────────────────────────────────────────────────────────────── */
export const planningScenarios = pgTable("planning_scenarios", {
  id:               uuid("id").primaryKey().defaultRandom(),
  name:             text("name").notNull(),
  description:      text("description"),
  baselineFeedId:   uuid("baseline_feed_id").notNull().references(() => gtfsFeeds.id, { onDelete: "restrict" }),
  mode:             text("mode").notNull().default("ab"),    // "single" | "ab"
  status:           text("status").notNull().default("draft"), // "draft" | "validated" | "archived"
  economicParams:   jsonb("economic_params"),                  // override parametri economici (€/km, €/h, …)
  summary:          jsonb("summary"),                          // { editsCount, routesAffected, … }
  createdBy:        text("created_by"),
  createdAt:        timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt:        timestamp("updated_at", { withTimezone: true }).defaultNow(),
}, (t) => [
  index("idx_planning_scenarios_baseline").on(t.baselineFeedId),
  index("idx_planning_scenarios_status").on(t.status),
]);

export const planningScenarioEdits = pgTable("planning_scenario_edits", {
  id:            uuid("id").primaryKey().defaultRandom(),
  scenarioId:    uuid("scenario_id").notNull().references(() => planningScenarios.id, { onDelete: "cascade" }),
  kind:          text("kind").notNull(),          // "route.update" | "route.suspend" | "stop.update" | "stop.delete" | …
  targetType:    text("target_type"),             // "route" | "stop" | "trip" | "pattern"
  targetGtfsId:  text("target_gtfs_id"),          // GTFS id (route_id, stop_id, …)
  payload:       jsonb("payload").notNull(),      // dati dell'edit (campi modificati)
  undoOfEditId:  uuid("undo_of_edit_id"),         // se è un undo, id dell'edit annullato
  appliedBy:     text("applied_by"),
  appliedAt:     timestamp("applied_at", { withTimezone: true }).defaultNow(),
}, (t) => [
  index("idx_planning_edits_scenario").on(t.scenarioId),
  index("idx_planning_edits_scenario_applied").on(t.scenarioId, t.appliedAt),
]);

export const planningAnalysisResults = pgTable("planning_analysis_results", {
  id:           uuid("id").primaryKey().defaultRandom(),
  scenarioId:   uuid("scenario_id").notNull().references(() => planningScenarios.id, { onDelete: "cascade" }),
  module:       text("module").notNull(),         // "service-coverage" | "demand-supply" | "trip-utility" | "economic"
  inputParams:  jsonb("input_params"),
  result:       jsonb("result").notNull(),
  editsHash:    text("edits_hash"),               // hash della sequenza edit per cache invalidation
  computedAt:   timestamp("computed_at", { withTimezone: true }).defaultNow(),
}, (t) => [
  index("idx_planning_analysis_scenario").on(t.scenarioId),
  index("idx_planning_analysis_scenario_module").on(t.scenarioId, t.module),
]);

export type PlanningScenario = typeof planningScenarios.$inferSelect;
export type PlanningScenarioEdit = typeof planningScenarioEdits.$inferSelect;
export type PlanningAnalysisResult = typeof planningAnalysisResults.$inferSelect;

/* ── Analisi feed GTFS (Sprint S1) ──────────────────────────────────────────
 * gtfs_feed_analysis: KPI calcolati una volta dopo upload (vetture-km,
 *   vetture-ore, n. corse, costi/ricavi, copertura, gap di servizio).
 * gtfs_feed_economic_params: parametri economici per feed (override default).
 * ─────────────────────────────────────────────────────────────────────────── */
export const gtfsFeedAnalysis = pgTable("gtfs_feed_analysis", {
  id:                uuid("id").primaryKey().defaultRandom(),
  feedId:            uuid("feed_id").notNull().references(() => gtfsFeeds.id, { onDelete: "cascade" }),
  // KPI aggregati giornalieri (giorno feriale tipo)
  totalKmDay:        doublePrecision("total_km_day").default(0),
  totalHoursDay:     doublePrecision("total_hours_day").default(0),
  totalTripsDay:     integer("total_trips_day").default(0),
  activeRoutes:      integer("active_routes").default(0),
  activeStops:       integer("active_stops").default(0),
  // Copertura
  bboxMinLat:        doublePrecision("bbox_min_lat"),
  bboxMaxLat:        doublePrecision("bbox_max_lat"),
  bboxMinLon:        doublePrecision("bbox_min_lon"),
  bboxMaxLon:        doublePrecision("bbox_max_lon"),
  populationCovered: integer("population_covered").default(0),  // popolazione entro 300m da una fermata
  populationTotal:   integer("population_total").default(0),    // popolazione bbox
  // Economia (calcolata con i parametri attivi al momento dell'analisi)
  totalCostDay:      doublePrecision("total_cost_day").default(0),       // €/giorno
  totalRevenueDay:   doublePrecision("total_revenue_day").default(0),    // €/giorno (corrispettivi)
  marginDay:         doublePrecision("margin_day").default(0),           // ricavi - costi
  // Per linea / dettagli (jsonb)
  perRoute:          jsonb("per_route"),         // [{ routeId, name, kmDay, hoursDay, trips, costDay, revenueDay, margin, ... }]
  anomalies:         jsonb("anomalies"),         // { tripsWithoutShape, orphanStops, irregularHeadways, ... }
  computedAt:        timestamp("computed_at", { withTimezone: true }).defaultNow(),
}, (t) => [
  uniqueIndex("idx_gtfs_feed_analysis_feed").on(t.feedId),
]);

export const gtfsFeedEconomicParams = pgTable("gtfs_feed_economic_params", {
  id:                  uuid("id").primaryKey().defaultRandom(),
  feedId:              uuid("feed_id").notNull().references(() => gtfsFeeds.id, { onDelete: "cascade" }),
  // Costi
  fuelConsumptionL100: doublePrecision("fuel_consumption_l_100").notNull().default(35),    // l/100km
  fuelPriceEurL:       doublePrecision("fuel_price_eur_l").notNull().default(1.65),        // €/l
  driverCostEurH:      doublePrecision("driver_cost_eur_h").notNull().default(28),         // €/h guida
  maintenanceEurKm:    doublePrecision("maintenance_eur_km").notNull().default(0.35),      // €/km
  amortizationEurKm:   doublePrecision("amortization_eur_km").notNull().default(0.25),     // €/km
  // Ricavi (corrispettivi €/vetture-km per tipo servizio)
  fareUrbanEurKm:      doublePrecision("fare_urban_eur_km").notNull().default(2.50),
  fareSuburbanEurKm:   doublePrecision("fare_suburban_eur_km").notNull().default(1.80),
  fareNightEurKm:      doublePrecision("fare_night_eur_km").notNull().default(2.20),
  // Override per linea (mappa routeId → { serviceType, ... })
  perRouteOverrides:   jsonb("per_route_overrides"),
  updatedAt:           timestamp("updated_at", { withTimezone: true }).defaultNow(),
}, (t) => [
  uniqueIndex("idx_gtfs_feed_econ_feed").on(t.feedId),
]);

export type GtfsFeedAnalysis = typeof gtfsFeedAnalysis.$inferSelect;
export type GtfsFeedEconomicParams = typeof gtfsFeedEconomicParams.$inferSelect;

/* ── ISTAT pendolari (matrice O/D) ──────────────────────────────────────────
 * Matrice degli spostamenti pendolari ISTAT (Censimento 2011, 9.1.1):
 *   per ogni coppia comune-origine → comune-destinazione, quante persone
 *   si spostano per motivo (lavoro/studio), mezzo, fascia oraria.
 * ─────────────────────────────────────────────────────────────────────────── */
export const istatCommutingOd = pgTable("istat_commuting_od", {
  id:               uuid("id").primaryKey().defaultRandom(),
  originIstat:      text("origin_istat").notNull(),   // codice ISTAT comune origine (es. "042002")
  originName:       text("origin_name"),
  destIstat:        text("dest_istat").notNull(),
  destName:         text("dest_name"),
  reason:           text("reason"),                   // "work" | "study"
  mode:             text("mode"),                     // "car_driver" | "car_passenger" | "bus_urban" | "bus_extraurban" | "train" | "bike" | "walk" | "other"
  timeSlot:         text("time_slot"),                // "before_715" | "715_815" | "815_915" | "after_915"
  durationMin:      integer("duration_min"),          // categoria durata (5, 15, 30, 60)
  flow:             integer("flow").notNull().default(0), // n. persone
  // geografia precomputata (centroide comune)
  originLat:        doublePrecision("origin_lat"),
  originLon:        doublePrecision("origin_lon"),
  destLat:          doublePrecision("dest_lat"),
  destLon:          doublePrecision("dest_lon"),
  importedAt:       timestamp("imported_at", { withTimezone: true }).defaultNow(),
}, (t) => [
  index("idx_istat_od_origin").on(t.originIstat),
  index("idx_istat_od_dest").on(t.destIstat),
  index("idx_istat_od_pair").on(t.originIstat, t.destIstat),
]);

export type IstatCommutingOd = typeof istatCommutingOd.$inferSelect;

/* ── PlannerStudio v2: classificazione linee + POI ──────────────────────────
 * route_classifications: l'utente assegna una categoria custom a ogni linea
 *   (es. "urbano-ancona", "urbano-falconara", "urbano-jesi", "extraurbano",
 *   "notturno"). Influenza il calcolo del corrispettivo €/km.
 * pois: punti di interesse della zona (scuole, ospedali, stazioni, mall, …)
 *   usati nel modello di stima passeggeri.
 * ─────────────────────────────────────────────────────────────────────────── */
export const planningRouteClassifications = pgTable("planning_route_classifications", {
  id:        uuid("id").primaryKey().defaultRandom(),
  feedId:    uuid("feed_id").notNull().references(() => gtfsFeeds.id, { onDelete: "cascade" }),
  routeId:   text("route_id").notNull(),
  category:  text("category").notNull(),  // libera: "urbano-ancona", "urbano-falconara", "urbano-jesi", "extraurbano", "notturno", "altro"
  fareType:  text("fare_type"),           // "urban" | "suburban" | "night" — derivato/forzabile
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
}, (t) => [
  uniqueIndex("idx_planning_routeclass_unique").on(t.feedId, t.routeId),
  index("idx_planning_routeclass_cat").on(t.feedId, t.category),
]);

export const planningPois = pgTable("planning_pois", {
  id:        uuid("id").primaryKey().defaultRandom(),
  feedId:    uuid("feed_id").notNull().references(() => gtfsFeeds.id, { onDelete: "cascade" }),
  name:      text("name").notNull(),
  category:  text("category").notNull(),  // "school" | "hospital" | "station" | "mall" | "office" | "tourism" | "other"
  lat:       doublePrecision("lat").notNull(),
  lng:       doublePrecision("lng").notNull(),
  weight:    doublePrecision("weight").notNull().default(1),  // attrattività relativa
  notes:     text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (t) => [
  index("idx_planning_pois_feed").on(t.feedId),
  index("idx_planning_pois_geo").on(t.feedId, t.lat, t.lng),
]);

export type PlanningRouteClassification = typeof planningRouteClassifications.$inferSelect;
export type PlanningPoi = typeof planningPois.$inferSelect;
