import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { busStops, censusSections, pointsOfInterest, trafficSnapshots, gtfsStops, gtfsTrips, gtfsStopTimes, gtfsRoutes, isochroneCache } from "@workspace/db/schema";
import { sql, count, inArray, and, eq } from "drizzle-orm";

const router: IRouter = Router();

// Coverage analysis: % population within radius of any bus stop
router.get("/analysis/coverage", async (req, res) => {
  try {
    const radius = parseInt((req.query.radius as string) || "400");
    // Approx degrees for given meters (1 deg ≈ 111km)
    const degRadius = radius / 111000;

    const totalPopResult = await db.execute(sql`
      SELECT COALESCE(SUM(population), 0)::int as total FROM census_sections
    `);
    const totalPop = (totalPopResult as any).rows?.[0] ?? totalPopResult;

    const stops = await db.select({ lng: busStops.lng, lat: busStops.lat }).from(busStops);

    let coveredPop = 0;
    if (stops.length > 0) {
      // Build a union of stop buffers and sum population of sections within
      const stopConditions = stops.map(
        (s) => `(ABS(centroid_lng - ${s.lng}) < ${degRadius} AND ABS(centroid_lat - ${s.lat}) < ${degRadius})`
      ).join(" OR ");

      const covResultRaw = await db.execute(sql.raw(`
        SELECT COALESCE(SUM(population), 0)::int as covered
        FROM census_sections
        WHERE ${stopConditions}
      `));
      const covResult = (covResultRaw as any).rows?.[0] ?? covResultRaw;
      coveredPop = parseInt((covResult as any).covered ?? 0);
    }

    const totalPopulation = parseInt((totalPop as any).total) || 0;
    const coveragePercent = totalPopulation > 0 ? (coveredPop / totalPopulation) * 100 : 0;

    res.json({
      radiusMeters: radius,
      totalPopulation,
      coveredPopulation: coveredPop,
      coveragePercent: Math.round(coveragePercent * 10) / 10,
      totalStops: stops.length,
    });
  } catch (err) {
    req.log.error(err, "Error in coverage analysis");
    res.status(500).json({ error: "Internal server error" });
  }
});

// Demand score: uses actual data points (census sections + POI locations)
// NO synthetic grid — all points are on land (real geographic locations)
router.get("/analysis/demand-score", async (req, res) => {
  try {
    const RADIUS_DEG = 0.025; // ~2.5km lookup radius

    const stops = await db.select({ lng: busStops.lng, lat: busStops.lat }).from(busStops);
    const pois = await db.select({ lng: pointsOfInterest.lng, lat: pointsOfInterest.lat }).from(pointsOfInterest);
    const sections = await db.select({
      lng: censusSections.centroidLng,
      lat: censusSections.centroidLat,
      pop: censusSections.population,
      density: censusSections.density,
    }).from(censusSections);
    const traffic = await db.select({
      lng: trafficSnapshots.lng,
      lat: trafficSnapshots.lat,
      congestion: trafficSnapshots.congestionLevel,
    }).from(trafficSnapshots).limit(2000);

    const maxPop = Math.max(...sections.map(s => s.pop ?? 0), 1);
    const maxDensity = Math.max(...sections.map(s => s.density ?? 0), 1);
    const cells: any[] = [];

    // ── Points from census sections (population demand) ──
    for (const section of sections) {
      const { lng: cellLng, lat: cellLat, pop, density } = section;

      const poiCount = pois.filter(
        p => Math.abs(p.lng - cellLng) < RADIUS_DEG && Math.abs(p.lat - cellLat) < RADIUS_DEG
      ).length;

      const trafficNearby = traffic.filter(
        t => Math.abs(t.lng - cellLng) < RADIUS_DEG && Math.abs(t.lat - cellLat) < RADIUS_DEG
      );
      const avgCongestion = trafficNearby.length > 0
        ? trafficNearby.reduce((s, t) => s + (t.congestion ?? 0), 0) / trafficNearby.length
        : 0;

      const popScore = Math.min((pop ?? 0) / 15000, 1);
      const densityScore = Math.min((density ?? 0) / 3000, 1);
      const poiScore = Math.min(poiCount / 5, 1);
      const trafficScore = avgCongestion;

      const score = popScore * 0.4 + densityScore * 0.25 + poiScore * 0.2 + trafficScore * 0.15;
      if (score < 0.05) continue;

      const hasStop = stops.some(
        s => Math.abs(s.lng - cellLng) < RADIUS_DEG * 2 && Math.abs(s.lat - cellLat) < RADIUS_DEG * 2
      );

      cells.push({
        cellId: `cs-${cells.length}`,
        lng: cellLng,
        lat: cellLat,
        score: Math.round(score * 100) / 100,
        populationScore: Math.round(popScore * 100) / 100,
        poiScore: Math.round(poiScore * 100) / 100,
        trafficScore: Math.round(trafficScore * 100) / 100,
        hasStop,
        source: "census",
      });
    }

    // ── Points from POI locations (activity demand) ──
    for (const poi of pois) {
      const { lng: cellLng, lat: cellLat } = poi;

      const trafficNearby = traffic.filter(
        t => Math.abs(t.lng - cellLng) < RADIUS_DEG && Math.abs(t.lat - cellLat) < RADIUS_DEG
      );
      const avgCongestion = trafficNearby.length > 0
        ? trafficNearby.reduce((s, t) => s + (t.congestion ?? 0), 0) / trafficNearby.length
        : 0;

      const nearPop = sections
        .filter(s => Math.abs((s.lng ?? 0) - cellLng) < RADIUS_DEG * 2 && Math.abs((s.lat ?? 0) - cellLat) < RADIUS_DEG * 2)
        .reduce((sum, s) => sum + (s.pop ?? 0), 0);

      const popScore = Math.min(nearPop / 15000, 1);
      const poiScore = 0.6; // POI location is inherently a demand point
      const trafficScore = avgCongestion;

      const score = popScore * 0.35 + poiScore * 0.45 + trafficScore * 0.2;
      if (score < 0.1) continue;

      const hasStop = stops.some(
        s => Math.abs(s.lng - cellLng) < RADIUS_DEG * 1.5 && Math.abs(s.lat - cellLat) < RADIUS_DEG * 1.5
      );

      cells.push({
        cellId: `poi-${cells.length}`,
        lng: cellLng,
        lat: cellLat,
        score: Math.round(score * 100) / 100,
        populationScore: Math.round(popScore * 100) / 100,
        poiScore,
        trafficScore: Math.round(trafficScore * 100) / 100,
        hasStop,
        source: "poi",
      });
    }

    res.json({ data: cells });
  } catch (err) {
    req.log.error(err, "Error computing demand score");
    res.status(500).json({ error: "Internal server error" });
  }
});

// Underserved areas: high demand (census/POI) with no stop nearby
// Uses real geographic points only — no synthetic grid
router.get("/analysis/underserved", async (req, res) => {
  try {
    const radius = parseInt((req.query.radius as string) || "600");
    const minScore = parseFloat((req.query.minScore as string) || "0.25");
    const LOOKUP = 0.025; // ~2.5km

    const stops = await db.select({ lng: busStops.lng, lat: busStops.lat, id: busStops.id }).from(busStops);
    const pois = await db.select({ lng: pointsOfInterest.lng, lat: pointsOfInterest.lat, category: pointsOfInterest.category }).from(pointsOfInterest);
    const sections = await db.select({
      lng: censusSections.centroidLng,
      lat: censusSections.centroidLat,
      pop: censusSections.population,
      density: censusSections.density,
    }).from(censusSections);

    const underserved: any[] = [];

    // ── Evaluate each census section as a demand point ──
    for (const section of sections) {
      const cellLng = section.lng ?? 0;
      const cellLat = section.lat ?? 0;
      const pop = section.pop ?? 0;
      const density = section.density ?? 0;

      const cellPois = pois.filter(
        p => Math.abs(p.lng - cellLng) < LOOKUP && Math.abs(p.lat - cellLat) < LOOKUP
      );

      const popScore = Math.min(pop / 15000, 1);
      const densityScore = Math.min(density / 3000, 1);
      const poiScore = Math.min(cellPois.length / 5, 1);
      const score = popScore * 0.45 + densityScore * 0.3 + poiScore * 0.25;

      if (score < minScore) continue;

      // Find nearest stop (meters)
      let nearestDist = Infinity;
      for (const s of stops) {
        const dist = Math.sqrt(
          Math.pow((s.lng - cellLng) * 111000 * Math.cos(cellLat * Math.PI / 180), 2) +
          Math.pow((s.lat - cellLat) * 111000, 2)
        );
        if (dist < nearestDist) nearestDist = dist;
      }

      if (nearestDist > radius) {
        const catCounts: Record<string, number> = {};
        for (const p of cellPois) catCounts[p.category] = (catCounts[p.category] ?? 0) + 1;
        const topCats = Object.entries(catCounts).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([c]) => c);

        underserved.push({
          cellId: `cs-${underserved.length}`,
          lng: cellLng,
          lat: cellLat,
          score: Math.round(score * 100) / 100,
          nearestStopDistanceMeters: Math.round(nearestDist),
          suggestedStopLng: cellLng,
          suggestedStopLat: cellLat,
          populationAffected: pop,
          topPoiCategories: topCats,
          source: "census",
        });
      }
    }

    underserved.sort((a, b) => b.score - a.score);
    res.json({ data: underserved.slice(0, 50), total: underserved.length });
  } catch (err) {
    req.log.error(err, "Error computing underserved areas");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ──────────────────────────────────────────────────────────────
// GET /api/analysis/demand
// Domanda reale calcolata su gtfs_stops (3.943 fermate GTFS) + census_sections + POI
// ──────────────────────────────────────────────────────────────
router.get("/analysis/demand", async (req, res) => {
  try {
    // ── 1. Population covered within 400m and 800m of any GTFS stop ──
    const coverage = await db.execute(sql`
      SELECT
        COALESCE(SUM(c.population), 0)::int AS total_pop,
        COALESCE(SUM(CASE WHEN (
          SELECT MIN(
            SQRT(
              POWER((gs.stop_lon::float - c.centroid_lng) * 111000.0 * COS(RADIANS(c.centroid_lat)), 2) +
              POWER((gs.stop_lat::float - c.centroid_lat) * 111000.0, 2)
            )
          ) FROM gtfs_stops gs
        ) < 400 THEN c.population ELSE 0 END), 0)::int AS pop_400,
        COALESCE(SUM(CASE WHEN (
          SELECT MIN(
            SQRT(
              POWER((gs.stop_lon::float - c.centroid_lng) * 111000.0 * COS(RADIANS(c.centroid_lat)), 2) +
              POWER((gs.stop_lat::float - c.centroid_lat) * 111000.0, 2)
            )
          ) FROM gtfs_stops gs
        ) < 800 THEN c.population ELSE 0 END), 0)::int AS pop_800
      FROM census_sections c
    `);
    const cov = (coverage.rows as any[])[0] ?? {};
    const totalPop = cov.total_pop ?? 0;

    // ── 2. Top 20 most served GTFS stops (by trip count) ──
    const topStops = await db.execute(sql`
      SELECT
        s.stop_id, s.stop_name,
        s.stop_lat::float AS lat, s.stop_lon::float AS lon,
        COUNT(DISTINCT t.trip_id)::int AS trip_count,
        COUNT(DISTINCT t.route_id)::int AS route_count,
        ARRAY_AGG(DISTINCT t.route_id ORDER BY t.route_id) AS route_ids
      FROM gtfs_stops s
      JOIN gtfs_stop_times st ON st.stop_id = s.stop_id
      JOIN gtfs_trips t ON t.trip_id = st.trip_id
      GROUP BY s.stop_id, s.stop_name, s.stop_lat, s.stop_lon
      ORDER BY trip_count DESC
      LIMIT 20
    `);

    // ── 3. Underserved census sections: high pop, far from GTFS stop ──
    const underserved = await db.execute(sql`
      SELECT
        c.id, c.centroid_lng AS lng, c.centroid_lat AS lat,
        c.population, c.density,
        (
          SELECT MIN(
            SQRT(
              POWER((gs.stop_lon::float - c.centroid_lng) * 111000.0 * COS(RADIANS(c.centroid_lat)), 2) +
              POWER((gs.stop_lat::float - c.centroid_lat) * 111000.0, 2)
            )
          ) FROM gtfs_stops gs
        )::int AS nearest_stop_m
      FROM census_sections c
      WHERE c.population > 2000
      ORDER BY nearest_stop_m DESC, c.population DESC
      LIMIT 30
    `);

    // ── 4. Coverage breakdown by route (top 15 by stop count) ──
    const routeCoverage = await db.execute(sql`
      SELECT
        r.route_id, r.route_short_name, r.route_color,
        COUNT(DISTINCT s.stop_id)::int AS stop_count,
        COUNT(DISTINCT t.trip_id)::int AS trip_count
      FROM gtfs_routes r
      JOIN gtfs_trips t ON t.route_id = r.route_id
      JOIN gtfs_stop_times st ON st.trip_id = t.trip_id
      JOIN gtfs_stops s ON s.stop_id = st.stop_id
      GROUP BY r.route_id, r.route_short_name, r.route_color
      ORDER BY trip_count DESC
      LIMIT 20
    `);

    // ── 5. Total POI count ──
    const poiRow = await db.execute(sql`
      SELECT COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE category = 'hospital')::int AS hospitals,
        COUNT(*) FILTER (WHERE category = 'school')::int AS schools,
        COUNT(*) FILTER (WHERE category = 'office')::int AS offices,
        COUNT(*) FILTER (WHERE category = 'shopping')::int AS shopping
      FROM points_of_interest
    `);
    const poi = (poiRow.rows as any[])[0] ?? {};

    res.json({
      coverage: {
        totalPop,
        pop400: cov.pop_400 ?? 0,
        pop800: cov.pop_800 ?? 0,
        pct400: totalPop > 0 ? Math.round((cov.pop_400 / totalPop) * 1000) / 10 : 0,
        pct800: totalPop > 0 ? Math.round((cov.pop_800 / totalPop) * 1000) / 10 : 0,
      },
      topStops: (topStops.rows as any[]).map(r => ({
        stopId:     r.stop_id,
        name:       r.stop_name,
        lat:        r.lat,
        lon:        r.lon,
        tripCount:  r.trip_count,
        routeCount: r.route_count,
        routeIds:   r.route_ids,
      })),
      underserved: (underserved.rows as any[]).map(r => ({
        id:          r.id,
        lng:         r.lng,
        lat:         r.lat,
        population:  r.population,
        density:     r.density,
        nearestStopM: r.nearest_stop_m,
      })),
      routeCoverage: (routeCoverage.rows as any[]).map(r => ({
        routeId:   r.route_id,
        shortName: r.route_short_name ?? r.route_id,
        color:     r.route_color ?? "#64748b",
        stopCount: r.stop_count,
        tripCount: r.trip_count,
      })),
      poi: {
        total:    poi.total ?? 0,
        hospitals: poi.hospitals ?? 0,
        schools:   poi.schools ?? 0,
        offices:   poi.offices ?? 0,
        shopping:  poi.shopping ?? 0,
      },
    });
  } catch (err) {
    req.log.error(err, "Error in /analysis/demand");
    res.status(500).json({ error: "Internal server error" });
  }
});

// Dashboard stats
router.get("/analysis/stats", async (req, res) => {
  try {
    const trafficResult = await db.execute(sql`
      SELECT AVG(congestion_level) as avg_congestion, COUNT(*)::int as total_snapshots, MAX(captured_at) as last_updated
      FROM traffic_snapshots
    `);
    const poiResult = await db.execute(sql`SELECT COUNT(*)::int as total FROM points_of_interest`);
    const stopsResult = await db.execute(sql`SELECT COUNT(*)::int as total FROM bus_stops`);
    const popResult = await db.execute(sql`SELECT COALESCE(SUM(population),0)::int as total FROM census_sections`);

    const tRow = (trafficResult.rows as any[])[0] ?? {};
    const pRow = (poiResult.rows as any[])[0] ?? {};
    const sRow = (stopsResult.rows as any[])[0] ?? {};
    const popRow = (popResult.rows as any[])[0] ?? {};

    const totalPopulation = parseInt(popRow.total) || 0;
    const totalStops = parseInt(sRow.total) || 0;

    // Compute real coverage: census sections within 600m of any stop
    const coverageResult = await db.execute(sql`
      SELECT
        COALESCE(SUM(c.population),0)::int as covered_pop,
        COUNT(c.id)::int as covered_sections,
        COUNT(*)::int as total_sections
      FROM census_sections c
      WHERE EXISTS (
        SELECT 1 FROM bus_stops s
        WHERE (
          (s.lng - c.centroid_lng)^2 * (111000 * cos(radians(c.centroid_lat)))^2 +
          (s.lat - c.centroid_lat)^2 * 111000^2
        ) < (600 * 600)
      )
    `);
    const cRow = (coverageResult.rows as any[])[0] ?? {};
    const coveredPop = parseInt(cRow.covered_pop) || 0;
    const coveragePercent = totalPopulation > 0 ? Math.round((coveredPop / totalPopulation) * 1000) / 10 : 0;

    // Count underserved from pre-computed underserved endpoint logic (approx)
    const underservedResult = await db.execute(sql`
      SELECT COUNT(*)::int as n FROM census_sections c
      WHERE c.population > 3000
      AND NOT EXISTS (
        SELECT 1 FROM bus_stops s
        WHERE (
          (s.lng - c.centroid_lng)^2 * (111000 * cos(radians(c.centroid_lat)))^2 +
          (s.lat - c.centroid_lat)^2 * 111000^2
        ) < (800 * 800)
      )
    `);
    const uRow = (underservedResult.rows as any[])[0] ?? {};

    res.json({
      avgCongestion: parseFloat(tRow.avg_congestion) || 0,
      totalPoi: parseInt(pRow.total) || 0,
      totalStops,
      totalPopulation,
      coveredPopulation: coveredPop,
      coveragePercent,
      underservedCount: parseInt(uRow.n) || 0,
      lastTrafficUpdate: tRow.last_updated || null,
    });
  } catch (err) {
    req.log.error(err, "Error fetching dashboard stats");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── Territory overview ────────────────────────────────────────────────────
router.get("/territory/overview", async (req, res) => {
  try {
    // 1. Global stats
    const globalStats = await db.execute(sql`
      SELECT
        SUM(population)::int            AS total_pop,
        COUNT(*)::int                   AS total_sections,
        AVG(density)::numeric(10,1)     AS avg_density,
        MIN(density)::numeric(10,1)     AS min_density,
        MAX(density)::numeric(10,1)     AS max_density
      FROM census_sections
    `);
    const gs = (globalStats.rows as any[])[0] ?? {};

    // 2. POI by category
    const poiRows = await db.execute(sql`
      SELECT category, COUNT(*)::int AS cnt
      FROM points_of_interest
      GROUP BY category
      ORDER BY cnt DESC
    `);
    const CATEGORY_LABELS: Record<string, string> = {
      hospital:   "Ospedali e Sanità",
      transit:    "Infrastrutture Trasporto",
      leisure:    "Svago e Sport",
      school:     "Scuole e Istruzione",
      office:     "Uffici e Servizi",
      shopping:   "Commercio",
      industrial: "Zone Industriali",
      workplace:  "Aziende e Uffici",
      worship:    "Luoghi di Culto",
      elderly:    "RSA e Case Riposo",
      parking:    "Parcheggi",
      tourism:    "Turismo e Cultura",
    };
    const CATEGORY_COLORS: Record<string, string> = {
      hospital:   "#ef4444",
      transit:    "#06b6d4",
      leisure:    "#22c55e",
      school:     "#eab308",
      office:     "#3b82f6",
      shopping:   "#a855f7",
      industrial: "#f97316",
      workplace:  "#64748b",
      worship:    "#d946ef",
      elderly:    "#f43f5e",
      parking:    "#94a3b8",
      tourism:    "#14b8a6",
    };
    const poiByCategory = (poiRows.rows as any[]).map(r => ({
      category: r.category,
      label:    CATEGORY_LABELS[r.category] ?? r.category,
      count:    parseInt(r.cnt),
      color:    CATEGORY_COLORS[r.category] ?? "#94a3b8",
    }));

    // 3. Top 10 census sections by population with nearest GTFS stop distance
    const topSections = await db.execute(sql`
      SELECT
        c.id,
        c.population,
        c.density::numeric(10,1) AS density,
        c.centroid_lng,
        c.centroid_lat,
        (
          SELECT MIN(
            SQRT(
              POWER((gs.stop_lon::float - c.centroid_lng) * 111000 * COS(RADIANS(c.centroid_lat)), 2)
              + POWER((gs.stop_lat::float - c.centroid_lat) * 111000, 2)
            )
          )::int
          FROM gtfs_stops gs
        ) AS nearest_stop_m,
        (
          SELECT COUNT(*)::int
          FROM points_of_interest p
          WHERE ABS(p.lng - c.centroid_lng) < 0.05
            AND ABS(p.lat - c.centroid_lat) < 0.05
        ) AS poi_count
      FROM census_sections c
      ORDER BY c.population DESC
      LIMIT 10
    `);

    // 4. Density bands distribution
    const densityBands = await db.execute(sql`
      SELECT
        CASE
          WHEN density < 100  THEN 'Rurale (<100)'
          WHEN density < 500  THEN 'Periurbano (100–500)'
          WHEN density < 1500 THEN 'Urbano (500–1500)'
          ELSE 'Alta densità (>1500)'
        END AS band,
        COUNT(*)::int         AS sections,
        SUM(population)::int  AS population
      FROM census_sections
      GROUP BY band
      ORDER BY MIN(density)
    `);

    // 5. Average nearest GTFS stop by density band (coverage quality)
    const densityCoverage = await db.execute(sql`
      SELECT
        CASE
          WHEN c.density < 100  THEN 'Rurale'
          WHEN c.density < 500  THEN 'Periurbano'
          WHEN c.density < 1500 THEN 'Urbano'
          ELSE 'Alta densità'
        END AS band,
        ROUND(AVG(
          (SELECT MIN(
            SQRT(
              POWER((gs.stop_lon::float - c.centroid_lng) * 111000 * COS(RADIANS(c.centroid_lat)), 2)
              + POWER((gs.stop_lat::float - c.centroid_lat) * 111000, 2)
            )
          ) FROM gtfs_stops gs)
        ))::int AS avg_nearest_m,
        COUNT(*)::int AS section_count
      FROM census_sections c
      GROUP BY band
      ORDER BY avg_nearest_m DESC
    `);

    // 6. Total POI count
    const poiTotal = await db.execute(sql`SELECT COUNT(*)::int AS n FROM points_of_interest`);
    const totalPoi = parseInt((poiTotal.rows as any[])[0]?.n) || 0;

    res.json({
      stats: {
        totalPop:       parseInt(gs.total_pop) || 0,
        totalSections:  parseInt(gs.total_sections) || 0,
        avgDensity:     parseFloat(gs.avg_density) || 0,
        minDensity:     parseFloat(gs.min_density) || 0,
        maxDensity:     parseFloat(gs.max_density) || 0,
        totalPoi,
      },
      poiByCategory,
      topSections: (topSections.rows as any[]).map((r, i) => ({
        rank:          i + 1,
        population:    parseInt(r.population),
        density:       parseFloat(r.density),
        nearestStopM:  parseInt(r.nearest_stop_m),
        poiCount:      parseInt(r.poi_count),
        lat:           parseFloat(r.centroid_lat),
        lng:           parseFloat(r.centroid_lng),
      })),
      densityBands: (densityBands.rows as any[]).map(r => ({
        band:       r.band,
        sections:   parseInt(r.sections),
        population: parseInt(r.population),
      })),
      densityCoverage: (densityCoverage.rows as any[]).map(r => ({
        band:         r.band,
        avgNearestM:  parseInt(r.avg_nearest_m),
        sectionCount: parseInt(r.section_count),
      })),
    });
  } catch (err) {
    req.log.error(err, "Error in territory overview");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ──────────────────────────────────────────────────────────────────
// OpenRouteService — Isochrone endpoints
// ──────────────────────────────────────────────────────────────────

const ORS_BASE = "https://api.openrouteservice.org/v2";
const ORS_KEY  = process.env.OPENROUTE_API_KEY || "";

/** Call ORS isochrones API for a single point (foot-walking), with retry on 429 */
async function fetchIsochrone(
  lng: number, lat: number, rangeSeconds: number[],
): Promise<any> {
  const MAX_RETRIES = 3;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const resp = await fetch(`${ORS_BASE}/isochrones/foot-walking`, {
      method: "POST",
      headers: {
        "Authorization": ORS_KEY,
        "Content-Type": "application/json; charset=utf-8",
        "Accept": "application/json, application/geo+json",
      },
      body: JSON.stringify({
        locations: [[lng, lat]],
        range: rangeSeconds,
        range_type: "time",
        attributes: ["area"],
      }),
    });
    if (resp.status === 429 && attempt < MAX_RETRIES) {
      // Rate limited — wait with exponential backoff
      const wait = 2000 * Math.pow(2, attempt); // 2s, 4s, 8s
      await new Promise(r => setTimeout(r, wait));
      continue;
    }
    if (resp.status === 403) {
      // Quota exceeded — no point retrying
      throw new Error(`ORS 403: Quota giornaliera esaurita`);
    }
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`ORS ${resp.status}: ${text}`);
    }
    return resp.json();
  }
}

/** Fetch isochrone geometry, using DB cache first. Returns GeoJSON geometry (Polygon/MultiPolygon) or null. */
async function fetchIsochroneCached(
  lng: number, lat: number, minutes: number,
): Promise<any | null> {
  const latR = Math.round(lat * 10000) / 10000; // ~11m precision
  const lngR = Math.round(lng * 10000) / 10000;

  // Check cache
  const cached = await db.select({ geojson: isochroneCache.geojson })
    .from(isochroneCache)
    .where(and(
      eq(isochroneCache.latRound, latR),
      eq(isochroneCache.lngRound, lngR),
      eq(isochroneCache.minutes, minutes),
    ))
    .limit(1);

  if (cached.length > 0) return cached[0].geojson;

  // Fetch from ORS
  const rangeSeconds = [minutes * 60];
  const iso = await fetchIsochrone(lng, lat, rangeSeconds);
  const geometry = iso.features?.[0]?.geometry ?? null;

  // Store in cache
  if (geometry) {
    try {
      await db.insert(isochroneCache).values({
        latRound: latR, lngRound: lngR, minutes, geojson: geometry,
      }).onConflictDoNothing();
    } catch { /* ignore cache write errors */ }
  }

  return geometry;
}

/** Point-in-polygon (ray casting) for flat GeoJSON Polygon coords */
function pointInPolygon(lng: number, lat: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    if (((yi > lat) !== (yj > lat)) && (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

// ──────────────────────────────────────────────────────────────
// GET /api/analysis/isochrone?lat=43.6&lng=13.5&minutes=5,10,15
// Returns GeoJSON FeatureCollection of walking isochrone polygons
// for a single point. Used when user clicks a stop on the map.
// ──────────────────────────────────────────────────────────────
router.get("/analysis/isochrone", async (req, res) => {
  try {
    if (!ORS_KEY) return res.status(503).json({ error: "OpenRouteService API key non configurata" });

    const lat = parseFloat(req.query.lat as string);
    const lng = parseFloat(req.query.lng as string);
    const minutesParam = (req.query.minutes as string) || "5,10,15";

    if (isNaN(lat) || isNaN(lng)) return res.status(400).json({ error: "lat e lng richiesti" });

    const minutes = minutesParam.split(",").map(Number).filter(n => n > 0 && n <= 60);
    if (minutes.length === 0) return res.status(400).json({ error: "minutes non valido (1-60)" });

    const rangeSeconds = minutes.map(m => m * 60);
    const geojson = await fetchIsochrone(lng, lat, rangeSeconds);

    // Enrich each feature with the minute label
    if (geojson.features) {
      for (const f of geojson.features) {
        const sec = f.properties?.value ?? 0;
        f.properties.minutes = Math.round(sec / 60);
        f.properties.label = `${Math.round(sec / 60)} min a piedi`;
      }
    }

    return void res.json(geojson);
  } catch (err: any) {
    if (err?.message?.includes("429")) {
      return void res.status(429).json({ error: "Rate limit ORS raggiunto. Riprova tra 1 minuto." });
    }
    req.log.error(err, "Error fetching isochrone");
    return void res.status(500).json({ error: "Errore nel calcolo isocrona" });
  }
});

// ──────────────────────────────────────────────────────────────
// GET /api/analysis/walkability-coverage?minutes=10&feedId=&routeIds=R001,R002
// Real walkability coverage: for each GTFS stop, fetch a walking
// isochrone from ORS, then count census population inside.
//
// When routeIds is provided, only stops served by those routes are used.
//
// NOTE: To stay within ORS free tier (2000/day), this endpoint
// samples up to 200 stops spread across the territory.
// ──────────────────────────────────────────────────────────────
router.get("/analysis/walkability-coverage", async (req, res) => {
  try {
    if (!ORS_KEY) return res.status(503).json({ error: "OpenRouteService API key non configurata" });

    const minutes = Math.min(parseInt((req.query.minutes as string) || "10"), 20);
    const feedId = req.query.feedId as string | undefined;
    const routeIdsParam = (req.query.routeIds as string || "").split(",").map(s => s.trim()).filter(Boolean);
    const rangeSeconds = [minutes * 60];

    // 1. Get GTFS stops — optionally filtered by routeIds
    let allStops: { stopId: string; stopName: string; lat: number; lng: number; serviceScore: number | null }[];

    if (routeIdsParam.length > 0) {
      // Get distinct stop_ids served by these routes via trips → stop_times
      const stopIdsRows = await db
        .selectDistinct({ stopId: gtfsStopTimes.stopId })
        .from(gtfsStopTimes)
        .innerJoin(gtfsTrips, sql`${gtfsStopTimes.tripId} = ${gtfsTrips.tripId} AND ${gtfsStopTimes.feedId} = ${gtfsTrips.feedId}`)
        .where(inArray(gtfsTrips.routeId, routeIdsParam));

      const stopIdSet = new Set(stopIdsRows.map(r => r.stopId));

      if (stopIdSet.size === 0) {
        return void res.json({
          minutes, routeIds: routeIdsParam,
          totalPopulation: 0, coveredPopulation: 0, coveragePercent: 0,
          message: "Nessuna fermata trovata per le linee selezionate",
          totalStops: 0, sampledStops: 0, stops: [],
          isochroneUnion: { type: "FeatureCollection", features: [] },
        });
      }

      const allStopsRaw = await db.select({
        stopId: gtfsStops.stopId,
        stopName: gtfsStops.stopName,
        lat: gtfsStops.stopLat,
        lng: gtfsStops.stopLon,
        serviceScore: gtfsStops.serviceScore,
      }).from(gtfsStops);

      allStops = allStopsRaw.filter(s => stopIdSet.has(s.stopId));
    } else {
      let stopsQuery = db.select({
        stopId: gtfsStops.stopId,
        stopName: gtfsStops.stopName,
        lat: gtfsStops.stopLat,
        lng: gtfsStops.stopLon,
        serviceScore: gtfsStops.serviceScore,
      }).from(gtfsStops).$dynamic();

      if (feedId) {
        stopsQuery = stopsQuery.where(sql`feed_id = ${feedId}`);
      }
      allStops = await stopsQuery;
    }

    if (allStops.length === 0) {
      return void res.json({
        minutes,
        totalPopulation: 0, coveredPopulation: 0, coveragePercent: 0,
        message: "Nessuna fermata GTFS disponibile",
        stops: [],
      });
    }

    // 2. Deduplicate stops within ~200m (covers opposite-direction pairs on same road)
    //    and apply grid sampling if still over limit.
    //    ORS free tier: ~12 requests per ~60s window.
    const PROXIMITY_DEG = 0.003; // ~300m at 43°N latitude
    const deduped: typeof allStops = [];
    for (const s of allStops) {
      const tooClose = deduped.some(d =>
        Math.abs(d.lat - s.lat) < PROXIMITY_DEG && Math.abs(d.lng - s.lng) < PROXIMITY_DEG
      );
      if (!tooClose) deduped.push(s);
    }

    const MAX_STOPS = 120;
    let sampledStops = deduped;
    if (deduped.length > MAX_STOPS) {
      const lats = deduped.map(s => s.lat);
      const lngs = deduped.map(s => s.lng);
      const minLat = Math.min(...lats), maxLat = Math.max(...lats);
      const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
      const gridSize = Math.ceil(Math.sqrt(MAX_STOPS));
      const cellH = (maxLat - minLat) / gridSize || 0.01;
      const cellW = (maxLng - minLng) / gridSize || 0.01;
      const grid = new Map<string, typeof deduped[0]>();
      for (const s of deduped) {
        const r = Math.floor((s.lat - minLat) / cellH);
        const c = Math.floor((s.lng - minLng) / cellW);
        const key = `${r},${c}`;
        const existing = grid.get(key);
        if (!existing || (s.serviceScore ?? 0) > (existing.serviceScore ?? 0)) {
          grid.set(key, s);
        }
      }
      sampledStops = Array.from(grid.values()).slice(0, MAX_STOPS);
    }

    req.log.info({ totalStops: allStops.length, deduped: deduped.length, sampled: sampledStops.length }, "Walkability stop counts");

    // 3. Fetch isochrones with DB cache (only uncached stops hit ORS)
    const stopResults: {
      stopId: string; stopName: string; lat: number; lng: number;
      coveredPop: number; isochrone: any;
    }[] = [];

    // Split into cached and uncached
    const uncachedStops: typeof sampledStops = [];
    for (const stop of sampledStops) {
      const latR = Math.round(stop.lat * 10000) / 10000;
      const lngR = Math.round(stop.lng * 10000) / 10000;
      const cached = await db.select({ geojson: isochroneCache.geojson })
        .from(isochroneCache)
        .where(and(
          eq(isochroneCache.latRound, latR),
          eq(isochroneCache.lngRound, lngR),
          eq(isochroneCache.minutes, minutes),
        ))
        .limit(1);
      if (cached.length > 0) {
        stopResults.push({
          stopId: stop.stopId, stopName: stop.stopName,
          lat: stop.lat, lng: stop.lng, coveredPop: 0,
          isochrone: cached[0].geojson,
        });
      } else {
        uncachedStops.push(stop);
      }
    }

    req.log.info({ cached: stopResults.length, toFetch: uncachedStops.length }, "Isochrone cache hit/miss");

    // Fetch uncached from ORS: burst 10, then throttle 8s
    // If 403 (quota exceeded) is received, abort immediately
    let quotaExceeded = false;
    if (uncachedStops.length > 0) {
      const BURST_SIZE = 10;
      const THROTTLE_DELAY = 8_000;

      const burstStops = uncachedStops.slice(0, BURST_SIZE);
      const burstResults = await Promise.allSettled(
        burstStops.map(stop =>
          fetchIsochroneCached(stop.lng, stop.lat, minutes)
            .then(geometry => ({
              stopId: stop.stopId, stopName: stop.stopName,
              lat: stop.lat, lng: stop.lng, coveredPop: 0,
              isochrone: geometry,
            }))
        )
      );
      for (let ri = 0; ri < burstResults.length; ri++) {
        const r = burstResults[ri];
        if (r.status === "fulfilled") stopResults.push(r.value);
        else {
          const msg = r.reason?.message ?? "";
          req.log.warn({ stopId: burstStops[ri].stopId, error: msg }, "Isochrone fetch failed");
          if (msg.includes("403")) quotaExceeded = true;
        }
      }

      if (!quotaExceeded) {
        for (let i = BURST_SIZE; i < uncachedStops.length; i++) {
          await new Promise(r => setTimeout(r, THROTTLE_DELAY));
          const stop = uncachedStops[i];
          try {
            const geometry = await fetchIsochroneCached(stop.lng, stop.lat, minutes);
            stopResults.push({
              stopId: stop.stopId, stopName: stop.stopName,
              lat: stop.lat, lng: stop.lng, coveredPop: 0,
              isochrone: geometry,
            });
          } catch (err: any) {
            const msg = err?.message ?? "";
            req.log.warn({ stopId: stop.stopId, error: msg }, "Isochrone fetch failed");
            if (msg.includes("403")) { quotaExceeded = true; break; }
          }
        }
      }
    }

    // 4. Get census sections
    const sections = await db.select({
      centroidLng: censusSections.centroidLng,
      centroidLat: censusSections.centroidLat,
      population: censusSections.population,
    }).from(censusSections);

    const totalPopulation = sections.reduce((s, c) => s + c.population, 0);

    // 5. For each section, check if centroid falls inside any isochrone
    const coveredSectionIds = new Set<number>();
    for (let si = 0; si < sections.length; si++) {
      const sec = sections[si];
      for (const stop of stopResults) {
        if (!stop.isochrone) continue;
        const coords = stop.isochrone.type === "Polygon"
          ? stop.isochrone.coordinates
          : stop.isochrone.type === "MultiPolygon"
            ? stop.isochrone.coordinates.flat()
            : [];
        for (const ring of coords) {
          if (pointInPolygon(sec.centroidLng, sec.centroidLat, ring)) {
            coveredSectionIds.add(si);
            stop.coveredPop += sec.population;
            break;
          }
        }
        if (coveredSectionIds.has(si)) break;
      }
    }

    const coveredPopulation = [...coveredSectionIds].reduce((s, i) => s + sections[i].population, 0);
    const coveragePercent = totalPopulation > 0
      ? Math.round((coveredPopulation / totalPopulation) * 1000) / 10
      : 0;

    const estimatedNote = [
      sampledStops.length < allStops.length
        ? `Campione di ${sampledStops.length}/${allStops.length} fermate (${allStops.length - deduped.length} duplicate per prossimità rimosse)`
        : null,
      quotaExceeded
        ? `Quota ORS giornaliera esaurita — analisi basata su ${stopResults.length} fermate con cache`
        : null,
    ].filter(Boolean).join(". ") || undefined;

    return void res.json({
      minutes,
      routeIds: routeIdsParam.length > 0 ? routeIdsParam : undefined,
      totalPopulation,
      coveredPopulation,
      coveragePercent,
      totalStops: allStops.length,
      sampledStops: sampledStops.length,
      note: estimatedNote,
      stops: stopResults.map(s => ({
        stopId: s.stopId, stopName: s.stopName,
        lat: s.lat, lng: s.lng, coveredPop: s.coveredPop,
      })),
      isochroneUnion: {
        type: "FeatureCollection",
        features: stopResults
          .filter(s => s.isochrone)
          .map(s => ({
            type: "Feature",
            geometry: s.isochrone,
            properties: {
              stopId: s.stopId, stopName: s.stopName,
              minutes, coveredPop: s.coveredPop,
            },
          })),
      },
    });
  } catch (err) {
    req.log.error(err, "Error in walkability coverage");
    return void res.status(500).json({ error: "Errore nel calcolo copertura pedonale" });
  }
});

// ──────────────────────────────────────────────────────────────
// GET /api/analysis/service-quality
// Analisi qualità servizio: copertura POI (scuole, uffici, ospedali)
// con valutazione oraria, coincidenze inter-comunali ai nodi di scambio
// ──────────────────────────────────────────────────────────────
router.get("/analysis/service-quality", async (req, res) => {
  try {
    /* ── helpers ──────────────────────────────────────────────── */
    const dist = (lat1: number, lng1: number, lat2: number, lng2: number) => {
      const dLat = (lat2 - lat1) * 111_000;
      const dLng = (lng2 - lng1) * 111_000 * Math.cos((lat1 * Math.PI) / 180);
      return Math.sqrt(dLat * dLat + dLng * dLng);
    };
    const hhmm = (t: string) => {
      const p = t.split(":");
      return parseInt(p[0]) * 60 + parseInt(p[1]);
    };
    const fmtMin = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

    /* Time windows (in minutes from 00:00) */
    const SCHOOL_ENTRY = { from: hhmm("07:30"), to: hhmm("08:30") };  // ingresso
    const SCHOOL_EXIT  = { from: hhmm("13:00"), to: hhmm("14:30") };  // uscita
    const OFFICE_ENTRY = { from: hhmm("07:30"), to: hhmm("09:30") };
    const OFFICE_EXIT  = { from: hhmm("17:00"), to: hhmm("19:00") };
    const HOSPITAL_WIN = { from: hhmm("07:00"), to: hhmm("20:00") };  // full-day
    const NEAR_M = 500; // max distance POI → stop

    /* ── 1. Fetch all POI ───────────────────────────────────── */
    const allPoi = await db.select({
      id: pointsOfInterest.id,
      name: pointsOfInterest.name,
      category: pointsOfInterest.category,
      lng: pointsOfInterest.lng,
      lat: pointsOfInterest.lat,
      properties: pointsOfInterest.properties,
    }).from(pointsOfInterest);

    /* Classify schools */
    const isSecondaryPlus = (p: any) => {
      const types: string[] = (p.properties as any)?.types ?? [];
      return types.some(t => ["secondary_school", "university"].includes(t)) ||
        (!types.includes("primary_school")); // if no primary tag, assume medie+
    };
    const schools   = allPoi.filter(p => p.category === "school" && isSecondaryPlus(p));

    /* Offices + Shopping + Industrial zones ─────────────────── */
    // Include: office POI + shopping_mall/supermarket/department_store + known industrial areas
    const isRelevantShopping = (p: any) => {
      const types: string[] = (p.properties as any)?.types ?? [];
      return types.some(t => ["shopping_mall", "department_store", "supermarket"].includes(t));
    };
    const officePoi = allPoi.filter(p => p.category === "office");
    const shoppingPoi = allPoi.filter(p => p.category === "shopping" && isRelevantShopping(p));

    // Known industrial/commercial zones in Provincia di Ancona
    // These are synthetic POI representing major employment/commercial hubs
    const INDUSTRIAL_ZONES: Array<{ name: string; lat: number; lng: number; category: string; properties: any }> = [
      { name: "Zona Industriale Baraccola (Ikea, MediaWorld, negozi)", lat: 43.5580, lng: 13.4990, category: "industrial", properties: {} },
      { name: "Centro Comm. Emisfero / Conero (Baraccola)", lat: 43.5757, lng: 13.5041, category: "industrial", properties: {} },
      { name: "Angelini Pharma — Stabilimento Ancona", lat: 43.5850, lng: 13.4780, category: "industrial", properties: {} },
      { name: "Fincantieri — Cantiere Navale Ancona", lat: 43.6250, lng: 13.5080, category: "industrial", properties: {} },
      { name: "Zona Industriale Castelferretti / Falconara", lat: 43.6300, lng: 13.3800, category: "industrial", properties: {} },
      { name: "Fileni — Stabilimento Cingoli/Jesi", lat: 43.5240, lng: 13.2410, category: "industrial", properties: {} },
      { name: "Zona Industriale Osimo — Recanati", lat: 43.4700, lng: 13.5100, category: "industrial", properties: {} },
      { name: "Interporto Marche — Jesi", lat: 43.5100, lng: 13.2600, category: "industrial", properties: {} },
      { name: "Zona Produttiva Fabriano (Elica, Indesit)", lat: 43.3380, lng: 12.9060, category: "industrial", properties: {} },
      { name: "Centro Commerciale Vallemiano — Ancona", lat: 43.6050, lng: 13.5000, category: "industrial", properties: {} },
      { name: "Polo Commerciale Torrette (Auchan/CC Torrette 2000)", lat: 43.6080, lng: 13.4546, category: "industrial", properties: {} },
      { name: "Centro Commerciale Il Maestrale — Senigallia", lat: 43.7150, lng: 13.2200, category: "industrial", properties: {} },
      { name: "Zona Ind. Sentino — Sassoferrato/Fabriano", lat: 43.4310, lng: 12.8550, category: "industrial", properties: {} },
      { name: "Corso Garibaldi — Centro Commerciale Naturale Ancona", lat: 43.6178, lng: 13.5138, category: "industrial", properties: {} },
    ];

    // Merge all into one "workplaces" array
    const workplaces = [
      ...officePoi,
      ...shoppingPoi,
      ...INDUSTRIAL_ZONES.map(z => ({ id: z.name, ...z })),
    ];

    const hospitals = allPoi.filter(p => p.category === "hospital" &&
      ((p.properties as any)?.types ?? []).includes("hospital"));

    /* ── 2. All GTFS stops ──────────────────────────────────── */
    const stops = await db.select({
      stopId: gtfsStops.stopId,
      name: gtfsStops.stopName,
      lat: gtfsStops.stopLat,
      lng: gtfsStops.stopLon,
    }).from(gtfsStops);

    /* ── 3. All stop_times (departure_time per stop) ─────────── */
    const stRows = await db.execute(sql`
      SELECT st.stop_id, st.departure_time, t.route_id
      FROM gtfs_stop_times st
      JOIN gtfs_trips t ON t.trip_id = st.trip_id
      WHERE st.departure_time IS NOT NULL
    `);
    // Map<stopId, { min: number; routeId: string }[]>
    const stopDeps = new Map<string, { min: number; routeId: string }[]>();
    for (const r of stRows.rows as any[]) {
      const m = hhmm(r.departure_time);
      if (!stopDeps.has(r.stop_id)) stopDeps.set(r.stop_id, []);
      stopDeps.get(r.stop_id)!.push({ min: m, routeId: r.route_id });
    }

    /* ── 4. Route metadata ──────────────────────────────────── */
    const routeRows = await db.select({
      routeId: gtfsRoutes.routeId,
      shortName: gtfsRoutes.routeShortName,
      longName: gtfsRoutes.routeLongName,
      color: gtfsRoutes.routeColor,
    }).from(gtfsRoutes);
    const routeMap = new Map(routeRows.map(r => [r.routeId, r]));

    /* ── helper: analyse POI group ──────────────────────────── */
    type PoiResult = {
      name: string; lat: number; lng: number;
      nearestStop: string; distM: number;
      entryBuses: number; exitBuses: number;
      entryRoutes: string[]; exitRoutes: string[];
      verdict: "ottimo" | "buono" | "sufficiente" | "critico";
      tag?: "ufficio" | "negozio" | "industria";
    };

    function analysePois(
      pois: typeof schools,
      entryWin: { from: number; to: number },
      exitWin: { from: number; to: number },
    ): PoiResult[] {
      const results: PoiResult[] = [];
      for (const poi of pois) {
        const isIndustrial = (poi as any).category === "industrial";
        const isShopping = (poi as any).category === "shopping";
        const searchRadius = isIndustrial ? 800 : NEAR_M; // larger radius for industrial zones
        const maxDist = isIndustrial ? 2000 : NEAR_M * 2;

        // find nearest stop
        let bestStop = "", bestDist = Infinity, bestStopId = "";
        for (const s of stops) {
          const d = dist(poi.lat, poi.lng, s.lat, s.lng);
          if (d < bestDist) { bestDist = d; bestStop = s.name; bestStopId = s.stopId; }
        }
        if (bestDist > maxDist) continue; // too far, skip

        // count buses in entry and exit windows at nearby stops
        const nearStopIds: string[] = [];
        for (const s of stops) {
          if (dist(poi.lat, poi.lng, s.lat, s.lng) <= searchRadius) nearStopIds.push(s.stopId);
        }

        const entryRouteSet = new Set<string>();
        const exitRouteSet = new Set<string>();
        let entryCount = 0, exitCount = 0;

        for (const sid of nearStopIds) {
          const deps = stopDeps.get(sid) ?? [];
          for (const d of deps) {
            if (d.min >= entryWin.from && d.min <= entryWin.to) {
              entryCount++;
              entryRouteSet.add(d.routeId);
            }
            if (d.min >= exitWin.from && d.min <= exitWin.to) {
              exitCount++;
              exitRouteSet.add(d.routeId);
            }
          }
        }

        const totalBuses = entryCount + exitCount;
        const verdict: PoiResult["verdict"] =
          totalBuses >= 30 ? "ottimo" :
          totalBuses >= 15 ? "buono" :
          totalBuses >= 5  ? "sufficiente" : "critico";

        results.push({
          name: poi.name ?? "Senza nome",
          lat: poi.lat, lng: poi.lng,
          nearestStop: bestStop,
          distM: Math.round(bestDist),
          entryBuses: entryCount, exitBuses: exitCount,
          entryRoutes: [...entryRouteSet],
          exitRoutes: [...exitRouteSet],
          verdict,
          tag: isIndustrial ? "industria" : isShopping ? "negozio" : "ufficio",
        });
      }
      // sort: critico first, then by total buses ascending
      const vOrd: Record<string, number> = { critico: 0, sufficiente: 1, buono: 2, ottimo: 3 };
      results.sort((a, b) => vOrd[a.verdict] - vOrd[b.verdict] || (a.entryBuses + a.exitBuses) - (b.entryBuses + b.exitBuses));
      return results;
    }

    const schoolResults   = analysePois(schools, SCHOOL_ENTRY, SCHOOL_EXIT);
    const officeResults   = analysePois(workplaces as any, OFFICE_ENTRY, OFFICE_EXIT);
    const hospitalResults = analysePois(hospitals, { from: hhmm("07:00"), to: hhmm("13:00") }, { from: hhmm("13:00"), to: hhmm("20:00") });

    /* ── 5. Coincidenze inter-comunali ──────────────────────── */
    // Find top hub stops (>10 routes) and check how many extra-urban lines converge
    // "Hub" = stops where multiple routes meet → transfer opportunity
    const hubThreshold = 5; // min routes for a hub
    type HubInfo = {
      stopName: string; lat: number; lng: number;
      routeCount: number; routes: { id: string; shortName: string; color: string }[];
      // pairs of routes with arrivals within 10min of each other
      transferPairs: { routeA: string; routeB: string; timeA: string; timeB: string; deltaMin: number }[];
      transferScore: "ottimo" | "buono" | "sufficiente" | "critico";
    };

    // Group nearby stops as one hub (within 150m)
    const hubClusters: { name: string; lat: number; lng: number; stopIds: string[] }[] = [];
    const usedStops = new Set<string>();
    // Find stops with many routes
    const stopRouteCount = new Map<string, Set<string>>();
    for (const [sid, deps] of stopDeps) {
      const routes = new Set(deps.map(d => d.routeId));
      stopRouteCount.set(sid, routes);
    }
    // cluster nearby stops
    const sortedStops = [...stopRouteCount.entries()]
      .sort((a, b) => b[1].size - a[1].size);

    for (const [sid, routes] of sortedStops) {
      if (usedStops.has(sid)) continue;
      if (routes.size < hubThreshold) continue;
      const s = stops.find(x => x.stopId === sid);
      if (!s) continue;
      const cluster = { name: s.name, lat: s.lat, lng: s.lng, stopIds: [sid] };
      usedStops.add(sid);
      // merge nearby stops
      for (const s2 of stops) {
        if (usedStops.has(s2.stopId)) continue;
        if (dist(s.lat, s.lng, s2.lat, s2.lng) <= 200) {
          cluster.stopIds.push(s2.stopId);
          usedStops.add(s2.stopId);
          // merge route count
          const r2 = stopRouteCount.get(s2.stopId);
          if (r2) r2.forEach(r => routes.add(r));
        }
      }
      hubClusters.push(cluster);
    }

    // Analyse transfer pairs at each hub
    const hubs: HubInfo[] = [];
    for (const hub of hubClusters.slice(0, 25)) { // top 25 hubs
      // collect all departures at this hub
      const hubDeps: { routeId: string; min: number }[] = [];
      const hubRouteSet = new Set<string>();
      for (const sid of hub.stopIds) {
        for (const d of stopDeps.get(sid) ?? []) {
          hubDeps.push(d);
          hubRouteSet.add(d.routeId);
        }
      }
      if (hubRouteSet.size < hubThreshold) continue;

      // Find transfer pairs: different routes arriving within 10min
      // Group by route, pick representative departure per route per hour
      const routeTimes = new Map<string, number[]>();
      for (const d of hubDeps) {
        if (!routeTimes.has(d.routeId)) routeTimes.set(d.routeId, []);
        routeTimes.get(d.routeId)!.push(d.min);
      }
      // deduplicate close times per route (within 3min)
      for (const [rid, times] of routeTimes) {
        times.sort((a, b) => a - b);
        const deduped: number[] = [];
        for (const t of times) {
          if (deduped.length === 0 || t - deduped[deduped.length - 1] >= 3) deduped.push(t);
        }
        routeTimes.set(rid, deduped);
      }

      const transferPairs: HubInfo["transferPairs"] = [];
      const routeIds = [...routeTimes.keys()];
      const MAX_TRANSFER = 10; // minutes
      outer:
      for (let i = 0; i < routeIds.length; i++) {
        for (let j = i + 1; j < routeIds.length; j++) {
          const tA = routeTimes.get(routeIds[i])!;
          const tB = routeTimes.get(routeIds[j])!;
          // find best (shortest) transfer in morning peak
          let bestDelta = Infinity, bestTA = 0, bestTB = 0;
          for (const a of tA) {
            if (a < hhmm("06:30") || a > hhmm("09:30")) continue;
            for (const b of tB) {
              const delta = Math.abs(a - b);
              if (delta <= MAX_TRANSFER && delta < bestDelta) {
                bestDelta = delta; bestTA = a; bestTB = b;
              }
            }
          }
          if (bestDelta <= MAX_TRANSFER) {
            transferPairs.push({
              routeA: routeIds[i], routeB: routeIds[j],
              timeA: fmtMin(bestTA), timeB: fmtMin(bestTB),
              deltaMin: bestDelta,
            });
          }
          if (transferPairs.length >= 8) break outer;
        }
      }

      const routeInfos = [...hubRouteSet].map(rid => {
        const r = routeMap.get(rid);
        return { id: rid, shortName: r?.shortName ?? rid, color: r?.color ?? "6b7280" };
      });

      const tScore: HubInfo["transferScore"] =
        transferPairs.length >= 6 ? "ottimo" :
        transferPairs.length >= 3 ? "buono" :
        transferPairs.length >= 1 ? "sufficiente" : "critico";

      hubs.push({
        stopName: hub.name, lat: hub.lat, lng: hub.lng,
        routeCount: hubRouteSet.size,
        routes: routeInfos.sort((a, b) => a.shortName.localeCompare(b.shortName, "it", { numeric: true })),
        transferPairs: transferPairs.sort((a, b) => a.deltaMin - b.deltaMin),
        transferScore: tScore,
      });
    }
    hubs.sort((a, b) => b.routeCount - a.routeCount);

    /* ── 6. Global verdict ──────────────────────────────────── */
    const verdictCounts = (arr: PoiResult[]) => ({
      ottimo:      arr.filter(x => x.verdict === "ottimo").length,
      buono:       arr.filter(x => x.verdict === "buono").length,
      sufficiente: arr.filter(x => x.verdict === "sufficiente").length,
      critico:     arr.filter(x => x.verdict === "critico").length,
      total:       arr.length,
    });
    const hubVerdictCounts = {
      ottimo:      hubs.filter(x => x.transferScore === "ottimo").length,
      buono:       hubs.filter(x => x.transferScore === "buono").length,
      sufficiente: hubs.filter(x => x.transferScore === "sufficiente").length,
      critico:     hubs.filter(x => x.transferScore === "critico").length,
      total:       hubs.length,
    };

    res.json({
      schools:   { items: schoolResults.slice(0, 40),   stats: verdictCounts(schoolResults) },
      offices:   {
        items: officeResults.slice(0, 80),
        stats: verdictCounts(officeResults),
        breakdown: {
          uffici:     officePoi.length,
          shopping:   shoppingPoi.length,
          industriali: INDUSTRIAL_ZONES.length,
        },
      },
      hospitals: { items: hospitalResults.slice(0, 30), stats: verdictCounts(hospitalResults) },
      hubs:      { items: hubs.slice(0, 15),            stats: hubVerdictCounts },
      timeWindows: {
        school: { entry: "07:30–08:30", exit: "13:00–14:30" },
        office: { entry: "07:30–09:30", exit: "17:00–19:00" },
        hospital: { am: "07:00–13:00", pm: "13:00–20:00" },
      },
    });
  } catch (err) {
    req.log.error(err, "Error in service-quality analysis");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
