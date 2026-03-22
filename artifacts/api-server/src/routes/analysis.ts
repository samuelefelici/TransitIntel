import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { busStops, censusSections, pointsOfInterest, trafficSnapshots } from "@workspace/db/schema";
import { sql, count } from "drizzle-orm";

const router: IRouter = Router();

// Coverage analysis: % population within radius of any bus stop
router.get("/analysis/coverage", async (req, res) => {
  try {
    const radius = parseInt((req.query.radius as string) || "400");
    // Approx degrees for given meters (1 deg ≈ 111km)
    const degRadius = radius / 111000;

    const [totalPop] = await db.execute(sql`
      SELECT COALESCE(SUM(population), 0)::int as total FROM census_sections
    `);

    const stops = await db.select({ lng: busStops.lng, lat: busStops.lat }).from(busStops);

    let coveredPop = 0;
    if (stops.length > 0) {
      // Build a union of stop buffers and sum population of sections within
      const stopConditions = stops.map(
        (s) => `(ABS(centroid_lng - ${s.lng}) < ${degRadius} AND ABS(centroid_lat - ${s.lat}) < ${degRadius})`
      ).join(" OR ");

      const [covResult] = await db.execute(sql.raw(`
        SELECT COALESCE(SUM(population), 0)::int as covered
        FROM census_sections
        WHERE ${stopConditions}
      `));
      coveredPop = parseInt((covResult as any).rows?.[0]?.covered ?? (covResult as any).covered ?? 0);
    }

    const totalRow = (totalPop as any).rows?.[0] ?? totalPop;
    const totalPopulation = parseInt((totalRow as any).total) || 0;
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
    };
    const CATEGORY_COLORS: Record<string, string> = {
      hospital:   "#ef4444",
      transit:    "#06b6d4",
      leisure:    "#22c55e",
      school:     "#eab308",
      office:     "#3b82f6",
      shopping:   "#a855f7",
      industrial: "#f97316",
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

export default router;
