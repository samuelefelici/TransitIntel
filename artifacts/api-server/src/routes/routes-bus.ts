import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { busRoutes } from "@workspace/db/schema";
import { eq } from "drizzle-orm";

const router: IRouter = Router();

router.get("/routes", async (req, res) => {
  try {
    const rows = await db.select().from(busRoutes).orderBy(busRoutes.name);
    const data = rows.map((r) => ({
      id: r.id,
      lineCode: r.lineCode,
      name: r.name,
      serviceType: r.serviceType,
      stopCount: 0,
    }));
    res.json({ data, total: data.length });
  } catch (err) {
    req.log.error(err, "Error fetching routes");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/routes", async (req, res) => {
  try {
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
  } catch (err) {
    req.log.error(err, "Error creating route");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.delete("/routes/:id", async (req, res) => {
  try {
    const { id } = req.params;
    await db.delete(busRoutes).where(eq(busRoutes.id, id));
    res.status(204).send();
  } catch (err) {
    req.log.error(err, "Error deleting route");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
