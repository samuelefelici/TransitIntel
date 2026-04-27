/**
 * DEPOTS — Gestione Depositi
 *
 * I depositi sono i punti di rimessaggio degli autobus e di presa di
 * servizio dei conducenti. Ogni deposito ha posizione, capacità,
 * tipi di rifornimento e orari operativi.
 *
 * GET    /api/depots       — lista tutti i depositi
 * POST   /api/depots       — crea un deposito
 * PUT    /api/depots/:id   — aggiorna un deposito
 * DELETE /api/depots/:id   — elimina un deposito
 */

import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { depots } from "@workspace/db/schema";
import { eq, asc } from "drizzle-orm";
import { asyncHandler } from "../middlewares/error-handler";

const router: IRouter = Router();

/* ── GET /api/depots ─────────────────────────────────────── */
router.get("/depots", asyncHandler(async (_req, res) => {
  const rows = await db.select().from(depots).orderBy(asc(depots.name));
  res.json({ data: rows });
}));

/* ── POST /api/depots ────────────────────────────────────── */
router.post("/depots", asyncHandler(async (req, res) => {
  const {
    name, address, lat, lon,
    capacity, operatingHoursStart, operatingHoursEnd,
    hasDiesel, hasMethane, hasElectric,
    chargingPoints, cngPoints,
    color, notes,
  } = req.body;

  if (!name || typeof name !== "string" || name.trim() === "") {
    res.status(400).json({ error: "name is required" });
    return;
  }

  const [depot] = await db.insert(depots).values({
    name: name.trim(),
    address: address ?? null,
    lat: lat != null ? Number(lat) : null,
    lon: lon != null ? Number(lon) : null,
    capacity: capacity != null ? Number(capacity) : null,
    operatingHoursStart: operatingHoursStart ?? null,
    operatingHoursEnd: operatingHoursEnd ?? null,
    hasDiesel: hasDiesel ?? false,
    hasMethane: hasMethane ?? false,
    hasElectric: hasElectric ?? false,
    chargingPoints: chargingPoints != null ? Number(chargingPoints) : 0,
    cngPoints: cngPoints != null ? Number(cngPoints) : 0,
    color: color ?? "#3b82f6",
    notes: notes ?? null,
  }).returning();

  res.status(201).json(depot);
}));

/* ── PUT /api/depots/:id ─────────────────────────────────── */
router.put("/depots/:id", asyncHandler(async (req, res) => {
  const id = req.params.id as string;
  const {
    name, address, lat, lon,
    capacity, operatingHoursStart, operatingHoursEnd,
    hasDiesel, hasMethane, hasElectric,
    chargingPoints, cngPoints,
    color, notes,
  } = req.body;

  const patch: Record<string, any> = { updatedAt: new Date() };
  if (name !== undefined)                patch.name                = name.trim();
  if (address !== undefined)             patch.address             = address;
  if (lat !== undefined)                 patch.lat                 = lat != null ? Number(lat) : null;
  if (lon !== undefined)                 patch.lon                 = lon != null ? Number(lon) : null;
  if (capacity !== undefined)            patch.capacity            = capacity != null ? Number(capacity) : null;
  if (operatingHoursStart !== undefined) patch.operatingHoursStart = operatingHoursStart;
  if (operatingHoursEnd !== undefined)   patch.operatingHoursEnd   = operatingHoursEnd;
  if (hasDiesel !== undefined)           patch.hasDiesel           = hasDiesel;
  if (hasMethane !== undefined)          patch.hasMethane          = hasMethane;
  if (hasElectric !== undefined)         patch.hasElectric         = hasElectric;
  if (chargingPoints !== undefined)      patch.chargingPoints      = Number(chargingPoints);
  if (cngPoints !== undefined)           patch.cngPoints           = Number(cngPoints);
  if (color !== undefined)               patch.color               = color;
  if (notes !== undefined)               patch.notes               = notes;

  const [updated] = await db.update(depots).set(patch).where(eq(depots.id, id)).returning();
  if (!updated) {
    res.status(404).json({ error: "Depot not found" });
    return;
  }
  res.json(updated);
}));

/* ── DELETE /api/depots/:id ──────────────────────────────── */
router.delete("/depots/:id", asyncHandler(async (req, res) => {
  const id = req.params.id as string;
  await db.delete(depots).where(eq(depots.id, id));
  res.status(204).send();
}));

export default router;
