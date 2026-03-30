import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { busRoutes } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { asyncHandler } from "../middlewares/error-handler";

const router: IRouter = Router();

router.get("/routes", asyncHandler(async (req, res) => {
  const rows = await db.select().from(busRoutes).orderBy(busRoutes.name);
  const data = rows.map((r) => ({
    id: r.id,
    lineCode: r.lineCode,
    name: r.name,
    serviceType: r.serviceType,
    stopCount: 0,
  }));
  res.json({ data, total: data.length });
}));

router.post("/routes", asyncHandler(async (req, res) => {
  const { lineCode, name, serviceType } = req.body;
  if (!name || !serviceType) {
    res.status(400).json({ error: "name and serviceType are required" });
    return;
  }
  const [row] = await db
    .insert(busRoutes)
    .values({ lineCode, name, serviceType })
    .returning();
  res.status(201).json({ id: row.id, lineCode: row.lineCode, name: row.name, serviceType: row.serviceType, stopCount: 0 });
}));

router.delete("/routes/:id", asyncHandler(async (req, res) => {
  const id = req.params.id as string;
  await db.delete(busRoutes).where(eq(busRoutes.id, id));
  res.status(204).send();
}));

export default router;
