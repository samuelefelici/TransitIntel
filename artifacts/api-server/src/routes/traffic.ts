import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { trafficSnapshots } from "@workspace/db/schema";
import { desc, gte, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { asyncHandler } from "../middlewares/error-handler";
import { validateQuery } from "../middlewares/validate";
import { cache } from "../middlewares/cache";

const router: IRouter = Router();

const trafficQuerySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(2000).default(500),
});

router.get("/traffic", validateQuery(trafficQuerySchema), cache({ ttlSeconds: 30 }), asyncHandler(async (req, res) => {
  const { limit: lim } = res.locals.query as z.infer<typeof trafficQuerySchema>;

  const rows = await db
    .select()
    .from(trafficSnapshots)
    .orderBy(desc(trafficSnapshots.capturedAt))
    .limit(lim);

  const data = rows.map((r) => ({
    id: r.id,
    segmentId: r.segmentId,
    lng: r.lng,
    lat: r.lat,
    speed: r.speed,
    freeflowSpeed: r.freeflowSpeed,
    congestionLevel: r.congestionLevel,
    capturedAt: r.capturedAt,
  }));

  res.json({ data, total: data.length });
}));

router.get("/traffic/heatmap", cache({ ttlSeconds: 60 }), asyncHandler(async (req, res) => {
  const rows = await db.execute(sql`
    SELECT
      ROUND(lng::numeric, 3) as lng,
      ROUND(lat::numeric, 3) as lat,
      AVG(congestion_level) as avg_congestion,
      COUNT(*)::int as sample_count
    FROM traffic_snapshots
    WHERE captured_at > NOW() - INTERVAL '7 days'
    GROUP BY ROUND(lng::numeric, 3), ROUND(lat::numeric, 3)
    HAVING COUNT(*) > 0
    LIMIT 1000
  `);

  const data = (rows.rows as any[]).map((r) => ({
    lng: parseFloat(r.lng),
    lat: parseFloat(r.lat),
    avgCongestion: parseFloat(r.avg_congestion) || 0,
    sampleCount: parseInt(r.sample_count) || 0,
  }));

  res.json({ data });
}));

router.get("/traffic/stats", cache({ ttlSeconds: 60 }), asyncHandler(async (req, res) => {
  const summaryResult = await db.execute(sql`
    SELECT
      AVG(congestion_level) as avg_congestion,
      COUNT(*)::int as total_snapshots,
      MAX(captured_at) as last_updated
    FROM traffic_snapshots
  `);
  const summary = (summaryResult.rows as any[])[0] ?? {};

  const byHour = await db.execute(sql`
    SELECT
      EXTRACT(HOUR FROM captured_at)::int as hour,
      AVG(congestion_level) as avg_congestion
    FROM traffic_snapshots
    WHERE captured_at > NOW() - INTERVAL '30 days'
    GROUP BY EXTRACT(HOUR FROM captured_at)
    ORDER BY hour
  `);

  const congestionByHour = (byHour.rows as any[]).map((r) => ({
    hour: parseInt(r.hour),
    avgCongestion: parseFloat(r.avg_congestion) || 0,
  }));

  const peak = congestionByHour.reduce(
    (max, h) => (h.avgCongestion > (max?.avgCongestion ?? 0) ? h : max),
    congestionByHour[0] ?? null
  );

  // --- By day type (feriale / sabato / festivo) ---
  const byDayType = await db.execute(sql`
    SELECT
      CASE
        WHEN EXTRACT(DOW FROM captured_at) IN (0) THEN 'festivo'
        WHEN EXTRACT(DOW FROM captured_at) IN (6) THEN 'sabato'
        ELSE 'feriale'
      END as day_type,
      EXTRACT(HOUR FROM captured_at)::int as hour,
      AVG(congestion_level) as avg_congestion,
      AVG(speed) as avg_speed,
      AVG(freeflow_speed) as avg_freeflow
    FROM traffic_snapshots
    WHERE captured_at > NOW() - INTERVAL '90 days'
    GROUP BY day_type, EXTRACT(HOUR FROM captured_at)
    ORDER BY day_type, hour
  `);

  const congestionByDayType: Record<string, any[]> = { feriale: [], sabato: [], festivo: [] };
  for (const r of byDayType.rows as any[]) {
    const dt = r.day_type as string;
    if (!congestionByDayType[dt]) congestionByDayType[dt] = [];
    congestionByDayType[dt].push({
      hour: parseInt(r.hour),
      avgCongestion: parseFloat(r.avg_congestion) || 0,
      avgSpeed: parseFloat(r.avg_speed) || 0,
      avgFreeflow: parseFloat(r.avg_freeflow) || 0,
    });
  }

  // Speed impact by zone (aggregate by geographic area name)
  const byZone = await db.execute(sql`
    WITH zone_map AS (
      SELECT *,
        CASE
          WHEN lat BETWEEN 43.59 AND 43.62 AND lng BETWEEN 13.50 AND 13.52 THEN 'Centro storico'
          WHEN lat BETWEEN 43.60 AND 43.63 AND lng BETWEEN 13.52 AND 13.57 THEN 'Porto / Lido'
          WHEN lat BETWEEN 43.60 AND 43.65 AND lng BETWEEN 13.42 AND 13.50 THEN 'Zona Ovest'
          WHEN lat BETWEEN 43.62 AND 43.69 AND lng BETWEEN 13.38 AND 13.52 THEN 'Nord / Falconara'
          ELSE 'Entroterra'
        END as zone_name
      FROM traffic_snapshots
      WHERE captured_at > NOW() - INTERVAL '30 days'
    )
    SELECT
      zone_name,
      AVG(congestion_level) as avg_congestion,
      AVG(speed) as avg_speed,
      AVG(freeflow_speed) as avg_freeflow,
      COUNT(*)::int as samples
    FROM zone_map
    GROUP BY zone_name
    ORDER BY avg_congestion DESC
  `);

  const zoneStats = (byZone.rows as any[]).map(r => ({
    zone: r.zone_name,
    avgCongestion: parseFloat(r.avg_congestion) || 0,
    avgSpeed: parseFloat(r.avg_speed) || 0,
    avgFreeflow: parseFloat(r.avg_freeflow) || 0,
    samples: parseInt(r.samples) || 0,
    speedReduction: parseFloat(r.avg_freeflow) > 0
      ? Math.round((1 - parseFloat(r.avg_speed) / parseFloat(r.avg_freeflow)) * 100)
      : 0,
  }));

  // Overall speed stats
  const speedResult = await db.execute(sql`
    SELECT
      AVG(speed) as avg_speed,
      AVG(freeflow_speed) as avg_freeflow
    FROM traffic_snapshots
    WHERE captured_at > NOW() - INTERVAL '30 days'
  `);
  const speedSummary = (speedResult.rows as any[])[0] ?? {};

  res.json({
    avgCongestion: parseFloat(summary.avg_congestion) || 0,
    totalSnapshots: parseInt(summary.total_snapshots) || 0,
    lastUpdated: summary.last_updated || new Date().toISOString(),
    peakHour: peak?.hour ?? 8,
    congestionByHour,
    congestionByDayType,
    zoneStats,
    avgSpeed: parseFloat(speedSummary.avg_speed) || 0,
    avgFreeflow: parseFloat(speedSummary.avg_freeflow) || 0,
  });
}));

export default router;
