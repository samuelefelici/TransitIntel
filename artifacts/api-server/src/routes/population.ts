import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { censusSections } from "@workspace/db/schema";

const router: IRouter = Router();

router.get("/population/density", async (req, res) => {
  try {
    const rows = await db.select().from(censusSections).limit(2000);

    const data = rows.map((r) => ({
      id: r.id,
      istatCode: r.istatCode,
      population: r.population,
      areaKm2: r.areaKm2,
      density: r.density,
      centroidLng: r.centroidLng,
      centroidLat: r.centroidLat,
    }));

    res.json({ data, total: data.length });
  } catch (err) {
    req.log.error(err, "Error fetching population");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
