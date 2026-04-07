import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { weatherSnapshots, trafficSnapshots } from "@workspace/db/schema";
import { sql, desc, and, gte, lte } from "drizzle-orm";
import { cache } from "../middlewares/cache";

const router: IRouter = Router();

const OWM_KEY = process.env.OPENWEATHER_API_KEY || "";
const OWM_BASE = "https://api.openweathermap.org/data/2.5";

// Province di Ancona — grid di punti rappresentativi
const WEATHER_LOCATIONS = [
  { name: "Ancona",      lat: 43.6158, lng: 13.5189 },
  { name: "Jesi",        lat: 43.5222, lng: 13.2436 },
  { name: "Senigallia",  lat: 43.7151, lng: 13.2175 },
  { name: "Fabriano",    lat: 43.3368, lng: 12.9078 },
  { name: "Falconara M.", lat: 43.6280, lng: 13.3940 },
];

// ─── Cron: fetch weather snapshots ─────────────────────────────

function verifyCronSecret(req: any, res: any): boolean {
  const secret = req.headers["x-cron-secret"];
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

/**
 * POST /api/cron/weather
 * Fetches current weather for all monitoring points and stores snapshots.
 * Should be called every 30–60 minutes.
 */
router.post("/cron/weather", async (req, res) => {
  if (!verifyCronSecret(req, res)) return;

  if (!OWM_KEY) {
    res.status(500).json({ error: "OPENWEATHER_API_KEY not configured" });
    return;
  }

  try {
    const results: any[] = [];

    for (const loc of WEATHER_LOCATIONS) {
      const url = `${OWM_BASE}/weather?lat=${loc.lat}&lon=${loc.lng}&appid=${OWM_KEY}&units=metric&lang=it`;
      const resp = await fetch(url);
      if (!resp.ok) {
        req.log.warn(`OWM fetch failed for ${loc.name}: ${resp.status}`);
        continue;
      }
      const data = await resp.json() as any;
      const weather = data.weather?.[0] || {};

      const row = {
        lat: loc.lat,
        lng: loc.lng,
        locationName: loc.name,
        temp: data.main?.temp ?? null,
        feelsLike: data.main?.feels_like ?? null,
        humidity: data.main?.humidity ?? null,
        windSpeed: data.wind?.speed ?? null,
        weatherMain: weather.main ?? null,
        weatherDescription: weather.description ?? null,
        weatherIcon: weather.icon ?? null,
        rain1h: data.rain?.["1h"] ?? null,
        snow1h: data.snow?.["1h"] ?? null,
        visibility: data.visibility ?? null,
      };

      await db.insert(weatherSnapshots).values(row);
      results.push({ location: loc.name, weather: weather.main, temp: row.temp });
    }

    req.log.info(`Weather sync: ${results.length}/${WEATHER_LOCATIONS.length} locations`);
    res.json({ synced: results.length, total: WEATHER_LOCATIONS.length, data: results });
  } catch (err: any) {
    req.log.error(err, "Error in weather cron");
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/weather/current ──────────────────────────────────

/**
 * Fetch live weather from OWM for all locations (fallback / refresh).
 * Returns data in the camelCase WeatherSnapshot shape the frontend expects.
 */
async function fetchLiveWeather(): Promise<any[]> {
  if (!OWM_KEY) return [];
  const results: any[] = [];
  for (const loc of WEATHER_LOCATIONS) {
    try {
      const url = `${OWM_BASE}/weather?lat=${loc.lat}&lon=${loc.lng}&appid=${OWM_KEY}&units=metric&lang=it`;
      const resp = await fetch(url);
      if (!resp.ok) continue;
      const data = await resp.json() as any;
      const w = data.weather?.[0] || {};
      results.push({
        lat: loc.lat,
        lng: loc.lng,
        locationName: loc.name,
        temp: data.main?.temp ?? null,
        feelsLike: data.main?.feels_like ?? null,
        humidity: data.main?.humidity ?? null,
        windSpeed: data.wind?.speed ?? null,
        weatherMain: w.main ?? null,
        weatherDescription: w.description ?? null,
        weatherIcon: w.icon ?? null,
        rain1h: data.rain?.["1h"] ?? null,
        snow1h: data.snow?.["1h"] ?? null,
        visibility: data.visibility ?? null,
        capturedAt: new Date().toISOString(),
      });
    } catch { /* skip location */ }
  }
  return results;
}

/** Convert a snake_case DB row to camelCase WeatherSnapshot */
function rowToSnapshot(r: any): any {
  return {
    id: r.id,
    lat: Number(r.lat),
    lng: Number(r.lng),
    locationName: r.location_name,
    temp: r.temp != null ? Number(r.temp) : null,
    feelsLike: r.feels_like != null ? Number(r.feels_like) : null,
    humidity: r.humidity != null ? Number(r.humidity) : null,
    windSpeed: r.wind_speed != null ? Number(r.wind_speed) : null,
    weatherMain: r.weather_main,
    weatherDescription: r.weather_description,
    weatherIcon: r.weather_icon,
    rain1h: r.rain_1h != null ? Number(r.rain_1h) : null,
    snow1h: r.snow_1h != null ? Number(r.snow_1h) : null,
    visibility: r.visibility != null ? Number(r.visibility) : null,
    capturedAt: r.captured_at,
  };
}

/**
 * Returns the latest weather snapshot for each monitoring location.
 * Falls back to a live OWM call when the DB has no recent data (< 2 h).
 */
router.get("/weather/current", cache({ ttlSeconds: 300 }), async (req, res) => {
  try {
    // Get latest snapshot per location using distinct on
    const latest = await db.execute(sql`
      SELECT DISTINCT ON (location_name)
        id, lat, lng, location_name, temp, feels_like, humidity, wind_speed,
        weather_main, weather_description, weather_icon,
        rain_1h, snow_1h, visibility, captured_at
      FROM weather_snapshots
      WHERE captured_at > NOW() - INTERVAL '2 hours'
      ORDER BY location_name, captured_at DESC
    `);

    if (latest.rows.length > 0) {
      res.json(latest.rows.map(rowToSnapshot));
      return;
    }

    // No recent data in DB → fetch live from OWM
    req.log.info("No recent weather snapshots, fetching live from OWM");
    const live = await fetchLiveWeather();
    res.json(live);
  } catch (err: any) {
    // DB error → try live fallback
    req.log.error(err, "Error fetching current weather, trying live fallback");
    try {
      const live = await fetchLiveWeather();
      res.json(live);
    } catch (e2: any) {
      res.status(500).json({ error: e2.message });
    }
  }
});

// ─── GET /api/weather/correlation ──────────────────────────────

/**
 * Correlates weather conditions with traffic congestion.
 * Groups by weather_main (Rain, Clear, Clouds, etc.) and computes
 * average congestion and traffic speed for each weather condition.
 * 
 * Query params:
 *   days - lookback window in days (default: 30)
 */
router.get("/weather/correlation", cache({ ttlSeconds: 600 }), async (req, res) => {
  try {
    const hours = parseInt((req.query as any).hours as string) || 168;
    const since = new Date();
    since.setTime(since.getTime() - hours * 3600_000);
    const sinceISO = since.toISOString();

    // Join weather and traffic on time proximity (same hour) and location proximity
    const result = await db.execute(sql`
      WITH weather_hourly AS (
        SELECT
          weather_main,
          DATE_TRUNC('hour', captured_at) AS hour,
          AVG(temp) AS avg_temp,
          AVG(humidity) AS avg_humidity,
          AVG(wind_speed) AS avg_wind_speed,
          AVG(COALESCE(rain_1h, 0)) AS avg_rain,
          COUNT(*) AS weather_samples
        FROM weather_snapshots
        WHERE captured_at >= ${sinceISO}::timestamptz
          AND weather_main IS NOT NULL
        GROUP BY weather_main, DATE_TRUNC('hour', captured_at)
      ),
      traffic_hourly AS (
        SELECT
          DATE_TRUNC('hour', captured_at) AS hour,
          AVG(congestion_level) AS avg_congestion,
          AVG(speed) AS avg_speed,
          AVG(freeflow_speed) AS avg_freeflow,
          COUNT(*) AS traffic_samples
        FROM traffic_snapshots
        WHERE captured_at >= ${sinceISO}::timestamptz
        GROUP BY DATE_TRUNC('hour', captured_at)
      )
      SELECT
        w.weather_main,
        SUM(t.traffic_samples)::int AS sample_count,
        ROUND(AVG(t.avg_congestion)::numeric, 3) AS avg_congestion,
        ROUND(AVG(t.avg_speed)::numeric, 1) AS avg_speed_kmh,
        ROUND(AVG(w.avg_temp)::numeric, 1) AS avg_temp,
        ROUND(AVG(w.avg_humidity)::numeric, 0) AS avg_humidity,
        ROUND(AVG(w.avg_wind_speed)::numeric, 1) AS avg_wind_speed
      FROM weather_hourly w
      JOIN traffic_hourly t ON w.hour = t.hour
      GROUP BY w.weather_main
      ORDER BY avg_congestion DESC
    `);

    // Return array directly per OpenAPI spec
    res.json(result.rows);
  } catch (err: any) {
    req.log.error(err, "Error computing weather correlation");
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/weather/history ──────────────────────────────────

/**
 * Returns weather history for a given time range.
 * Query params:
 *   hours - lookback in hours (default: 24)
 *   location - filter by location_name (optional)
 */
router.get("/weather/history", cache({ ttlSeconds: 120 }), async (req, res) => {
  try {
    const hours = parseInt((req.query as any).hours as string) || 24;
    const location = (req.query as any).location as string | undefined;

    const since = new Date();
    since.setHours(since.getHours() - hours);
    const sinceISO = since.toISOString();

    let q = `
      SELECT id, lat, lng, location_name, temp, feels_like, humidity, wind_speed,
             weather_main, weather_description, weather_icon,
             rain_1h, snow_1h, visibility, captured_at
      FROM weather_snapshots
      WHERE captured_at >= '${sinceISO}'::timestamptz
    `;
    if (location) q += ` AND location_name = '${location.replace(/'/g, "''")}'`;
    q += ` ORDER BY captured_at DESC LIMIT 500`;

    const result = await db.execute(sql.raw(q));
    res.json({ hours, data: result.rows });
  } catch (err: any) {
    req.log.error(err, "Error fetching weather history");
    res.status(500).json({ error: err.message });
  }
});

export default router;
