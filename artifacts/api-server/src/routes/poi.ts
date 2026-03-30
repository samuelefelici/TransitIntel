import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { pointsOfInterest } from "@workspace/db/schema";
import { eq, inArray, sql } from "drizzle-orm";
import { asyncHandler } from "../middlewares/error-handler";
import { cache } from "../middlewares/cache";

const router: IRouter = Router();

router.get("/poi", cache({ ttlSeconds: 120 }), asyncHandler(async (req, res) => {
  const { categories } = req.query as Record<string, string>;

  let rows;
  if (categories) {
    const cats = categories.split(",").map((c) => c.trim()).filter(Boolean);
    rows = await db
      .select()
      .from(pointsOfInterest)
      .where(inArray(pointsOfInterest.category, cats))
      .limit(2000);
  } else {
    rows = await db.select().from(pointsOfInterest).limit(2000);
  }

  const data = rows.map((r) => ({
    id: r.id,
    osmId: r.osmId,
    name: r.name,
    category: r.category,
    lng: r.lng,
    lat: r.lat,
    properties: r.properties,
  }));

  res.json({ data, total: data.length });
}));

export default router;
