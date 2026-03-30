import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { busStops, pointsOfInterest, censusSections } from "@workspace/db/schema";
import { eq, sql } from "drizzle-orm";
import { asyncHandler } from "../middlewares/error-handler";
import { cache } from "../middlewares/cache";

const router: IRouter = Router();

router.get("/stops", cache({ ttlSeconds: 120 }), asyncHandler(async (req, res) => {
  const rows = await db.select().from(busStops).orderBy(busStops.name);
  const data = rows.map((r) => ({
    id: r.id,
    code: r.code,
    name: r.name,
    lng: r.lng,
    lat: r.lat,
    lines: r.lines ?? [],
  }));
  res.json({ data, total: data.length });
}));

router.post("/stops", asyncHandler(async (req, res) => {
  const { code, name, lng, lat, lines } = req.body;
  if (!name || lng == null || lat == null) {
    res.status(400).json({ error: "name, lng, lat are required" });
    return;
  }
  const [row] = await db
    .insert(busStops)
    .values({ code, name, lng: parseFloat(lng), lat: parseFloat(lat), lines: lines ?? [] })
    .returning();
  res.status(201).json({ id: row.id, code: row.code, name: row.name, lng: row.lng, lat: row.lat, lines: row.lines ?? [] });
}));

router.put("/stops/:id", asyncHandler(async (req, res) => {
  const id = req.params.id as string;
  const { code, name, lng, lat, lines } = req.body;
  const [row] = await db
    .update(busStops)
    .set({ code, name, lng: parseFloat(lng), lat: parseFloat(lat), lines: lines ?? [] })
    .where(eq(busStops.id, id))
    .returning();
  if (!row) {
    res.status(404).json({ error: "Stop not found" });
    return;
  }
  res.json({ id: row.id, code: row.code, name: row.name, lng: row.lng, lat: row.lat, lines: row.lines ?? [] });
}));

router.delete("/stops/:id", asyncHandler(async (req, res) => {
  const id = req.params.id as string;
  await db.delete(busStops).where(eq(busStops.id, id));
  res.status(204).send();
}));

router.get("/stops/:id/nearby", cache({ ttlSeconds: 120 }), asyncHandler(async (req, res) => {
  const id = req.params.id as string;
  const [stop] = await db.select().from(busStops).where(eq(busStops.id, id));
  if (!stop) {
    res.status(404).json({ error: "Stop not found" });
    return;
  }

  // Find nearby POIs within ~300m (approx 0.003 degrees)
  const nearbyPois = await db.execute(sql`
    SELECT id, osm_id, name, category, lng, lat, properties
    FROM points_of_interest
    WHERE ABS(lng - ${stop.lng}) < 0.003 AND ABS(lat - ${stop.lat}) < 0.003
    LIMIT 20
  `);

  // Estimate population served within ~400m
  const popResult = await db.execute(sql`
    SELECT COALESCE(SUM(population), 0)::int as total
    FROM census_sections
    WHERE ABS(centroid_lng - ${stop.lng}) < 0.004 AND ABS(centroid_lat - ${stop.lat}) < 0.004
  `);

  const pois = (nearbyPois.rows as any[]).map((r) => ({
    id: r.id,
    osmId: r.osm_id,
    name: r.name,
    category: r.category,
    lng: parseFloat(r.lng),
    lat: parseFloat(r.lat),
    properties: r.properties,
  }));

  const popRow = (popResult.rows as any[])[0];
  const populationServed = parseInt(popRow?.total) || 0;

  res.json({
    stopId: id,
    nearbyPois: pois,
    populationServed,
    poiCount: pois.length,
  });
}));

export default router;
