import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { censusSections } from "@workspace/db/schema";
import { gt } from "drizzle-orm";
import { asyncHandler } from "../middlewares/error-handler";
import { cache } from "../middlewares/cache";

const router: IRouter = Router();

router.get("/population/density", cache({ ttlSeconds: 120 }), asyncHandler(async (req, res) => {
  const rows = await db.select().from(censusSections).limit(10000);

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
}));

/**
 * GET /api/population/choropleth
 * Returns a GeoJSON FeatureCollection of census-section polygons
 * with population, density and area properties for choropleth rendering.
 * Only sections with geojson geometry and population > 0 are included.
 */
router.get("/population/choropleth", cache({ ttlSeconds: 300 }), asyncHandler(async (req, res) => {
  req.log.info("choropleth: loading census polygons…");

  const rows = await db
    .select({
      istatCode: censusSections.istatCode,
      population: censusSections.population,
      density: censusSections.density,
      areaKm2: censusSections.areaKm2,
      geojson: censusSections.geojson,
    })
    .from(censusSections)
    .where(gt(censusSections.population, 0))
    .limit(10000);

  // Simplify coordinates to 5 decimals (~1m precision) to reduce payload
  const simplifyCoords = (coords: any): any => {
    if (typeof coords[0] === "number") {
      return [Math.round(coords[0] * 1e5) / 1e5, Math.round(coords[1] * 1e5) / 1e5];
    }
    return coords.map(simplifyCoords);
  };

  const features = rows
    .filter((r) => r.geojson != null)
    .map((r) => {
      const geom = r.geojson as any;
      return {
        type: "Feature" as const,
        geometry: {
          type: geom.type,
          coordinates: simplifyCoords(geom.coordinates),
        },
        properties: {
          istatCode: r.istatCode,
          population: r.population,
          density: r.density,
          areaKm2: r.areaKm2,
        },
      };
    });

  req.log.info(`choropleth: ${features.length} features`);

  res.json({
    type: "FeatureCollection",
    features,
  });
}));

export default router;
