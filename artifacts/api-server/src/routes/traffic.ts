import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { trafficSnapshots } from "@workspace/db/schema";
import { desc, gte, lte, sql } from "drizzle-orm";

const router: IRouter = Router();

router.get("/traffic", async (req, res) => {
  try {
    const { from, to, limit = "500" } = req.query as Record<string, string>;
    const lim = Math.min(parseInt(limit) || 500, 2000);

    let query = db.select().from(trafficSnapshots).orderBy(desc(trafficSnapshots.capturedAt)).limit(lim);

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
  } catch (err) {
    req.log.error(err, "Error fetching traffic");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/traffic/heatmap", async (req, res) => {
  try {
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
  } catch (err) {
    req.log.error(err, "Error fetching heatmap");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/traffic/stats", async (req, res) => {
  try {
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

    res.json({
      avgCongestion: parseFloat(summary.avg_congestion) || 0,
      totalSnapshots: parseInt(summary.total_snapshots) || 0,
      lastUpdated: summary.last_updated || new Date().toISOString(),
      peakHour: peak?.hour ?? 8,
      congestionByHour,
    });
  } catch (err) {
    req.log.error(err, "Error fetching traffic stats");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
