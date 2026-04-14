/**
 * GTFS Fares V2 — Bigliettazione Elettronica
 *
 * Endpoints:
 * GET    /api/fares/networks                — list networks
 * POST   /api/fares/networks/seed           — seed default 4 networks
 * GET    /api/fares/route-networks           — list route↔network assignments
 * POST   /api/fares/route-networks/auto-classify — auto-classify routes
 * PUT    /api/fares/route-networks/:routeId  — manual re-assign
 * POST   /api/fares/route-networks/bulk      — bulk save all assignments
 * GET    /api/fares/media                    — list fare media
 * POST   /api/fares/media/seed              — seed default media
 * PUT    /api/fares/media/:fareMediaId       — toggle active / edit
 * GET    /api/fares/rider-categories         — list categories
 * POST   /api/fares/rider-categories/seed   — seed default
 * POST   /api/fares/rider-categories         — add new
 * PUT    /api/fares/rider-categories/:id    — update
 * DELETE /api/fares/rider-categories/:id     — delete
 * GET    /api/fares/calendar                 — list calendar entries
 * POST   /api/fares/calendar/seed           — seed Feriale/Sabato/Festivo
 * POST   /api/fares/calendar                 — add new entry
 * PUT    /api/fares/calendar/:id            — update entry
 * DELETE /api/fares/calendar/:id            — delete entry
 * GET    /api/fares/calendar-dates           — list exceptions
 * POST   /api/fares/calendar-dates           — add exception
 * DELETE /api/fares/calendar-dates/:id      — delete exception
 * GET    /api/fares/products                 — list fare products
 * POST   /api/fares/products/seed           — seed default products (urban + extraurban)
 * PUT    /api/fares/products/:id            — update price
 * GET    /api/fares/areas                    — list areas
 * GET    /api/fares/stop-areas               — list stop↔area
 * POST   /api/fares/zones/generate/:routeId — generate zones for an extraurban route
 * POST   /api/fares/zones/generate-all      — generate zones for ALL extraurban routes
 * PUT    /api/fares/stop-areas/:id          — manual override
 * GET    /api/fares/leg-rules               — list leg rules
 * POST   /api/fares/leg-rules/generate      — generate all leg rules from areas+products
 * GET    /api/fares/transfer-rules          — list transfer rules
 * POST   /api/fares/generate-gtfs           — generate all GTFS Fares V2 CSV files
 * POST   /api/fares/simulate                — simulate ticket price for OD pair
 */
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  gtfsFeeds, gtfsRoutes, gtfsStops, gtfsTrips, gtfsStopTimes, gtfsShapes,
  gtfsCalendar, gtfsCalendarDates,
  gtfsFareNetworks, gtfsRouteNetworks, gtfsFareMedia, gtfsRiderCategories,
  gtfsFareProducts, gtfsFareAreas, gtfsStopAreas, gtfsFareLegRules, gtfsFareTransferRules,
  gtfsTimeframes, gtfsFareAttributes, gtfsFareRules,
  gtfsFareZoneClusters, gtfsFareZoneClusterStops,
  gtfsFeedInfo,
} from "@workspace/db/schema";
import { eq, and, sql, inArray } from "drizzle-orm";
import { getLatestFeedId } from "./gtfs-helpers";
import { haversineKm } from "../lib/geo-utils";

const router: IRouter = Router();

// ═══════════════════════════════════════════════════════════
// HELPER: classify a route_short_name into a default network
// ═══════════════════════════════════════════════════════════
function classifyRoute(shortName: string): string {
  if (!shortName) return "extraurbano";
  const s = shortName.trim().toUpperCase();

  // Urbano Jesi — starts with "JE"
  if (s.startsWith("JE")) return "urbano_jesi";

  // Urbano Falconara — starts with "Y"
  if (s.startsWith("Y")) return "urbano_falconara";

  // Urbano Ancona — starts with a digit, OR is C.D., C.S., or similar single-letter+dot combos
  if (/^\d/.test(s)) return "urbano_ancona";
  if (/^[A-Z]\.[A-Z]\.?$/.test(s)) return "urbano_ancona"; // C.D., C.S., etc.

  // Everything else → extraurbano
  return "extraurbano";
}

// ═══════════════════════════════════════════════════════════
// The 23 extraurban fare bands (DGR Regione Marche)
// ═══════════════════════════════════════════════════════════
const EXTRA_BANDS: { fascia: number; kmFrom: number; kmTo: number; price: number }[] = [
  { fascia: 1, kmFrom: 0, kmTo: 6, price: 1.35 },
  { fascia: 2, kmFrom: 6, kmTo: 12, price: 1.85 },
  { fascia: 3, kmFrom: 12, kmTo: 18, price: 2.35 },
  { fascia: 4, kmFrom: 18, kmTo: 24, price: 2.85 },
  { fascia: 5, kmFrom: 24, kmTo: 30, price: 3.20 },
  { fascia: 6, kmFrom: 30, kmTo: 36, price: 3.55 },
  { fascia: 7, kmFrom: 36, kmTo: 42, price: 3.90 },
  { fascia: 8, kmFrom: 42, kmTo: 50, price: 4.25 },
  { fascia: 9, kmFrom: 50, kmTo: 60, price: 4.55 },
  { fascia: 10, kmFrom: 60, kmTo: 70, price: 4.85 },
  { fascia: 11, kmFrom: 70, kmTo: 80, price: 5.15 },
  { fascia: 12, kmFrom: 80, kmTo: 90, price: 5.45 },
  { fascia: 13, kmFrom: 90, kmTo: 100, price: 5.75 },
  { fascia: 14, kmFrom: 100, kmTo: 110, price: 6.05 },
  { fascia: 15, kmFrom: 110, kmTo: 120, price: 6.35 },
  { fascia: 16, kmFrom: 120, kmTo: 130, price: 6.65 },
  { fascia: 17, kmFrom: 130, kmTo: 140, price: 6.95 },
  { fascia: 18, kmFrom: 140, kmTo: 150, price: 7.25 },
  { fascia: 19, kmFrom: 150, kmTo: 160, price: 7.55 },
  { fascia: 20, kmFrom: 160, kmTo: 170, price: 7.85 },
  { fascia: 21, kmFrom: 170, kmTo: 180, price: 8.15 },
  { fascia: 22, kmFrom: 180, kmTo: 190, price: 8.45 },
  { fascia: 23, kmFrom: 190, kmTo: 200, price: 8.75 },
];

function getBandForDistance(distKm: number): typeof EXTRA_BANDS[0] | undefined {
  return EXTRA_BANDS.find(b => distKm > b.kmFrom && distKm <= b.kmTo)
    ?? (distKm <= 0 ? undefined : EXTRA_BANDS[EXTRA_BANDS.length - 1]);
}

// ═══════════════════════════════════════════════════════════
// NETWORKS
// ═══════════════════════════════════════════════════════════

const DEFAULT_NETWORKS = [
  { networkId: "urbano_ancona", networkName: "Urbano di Ancona" },
  { networkId: "urbano_jesi", networkName: "Urbano di Jesi" },
  { networkId: "urbano_falconara", networkName: "Urbano di Falconara" },
  { networkId: "extraurbano", networkName: "Extraurbano Provincia di Ancona" },
];

// GET /api/fares/networks
router.get("/fares/networks", async (_req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.json([]); return; }
    const rows = await db.select().from(gtfsFareNetworks).where(eq(gtfsFareNetworks.feedId, feedId));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// POST /api/fares/networks/seed
router.post("/fares/networks/seed", async (_req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.status(400).json({ error: "No GTFS feed found" }); return; }

    for (const n of DEFAULT_NETWORKS) {
      await db.insert(gtfsFareNetworks)
        .values({ feedId, networkId: n.networkId, networkName: n.networkName })
        .onConflictDoUpdate({
          target: [gtfsFareNetworks.feedId, gtfsFareNetworks.networkId],
          set: { networkName: n.networkName, updatedAt: sql`now()` },
        });
    }
    const rows = await db.select().from(gtfsFareNetworks).where(eq(gtfsFareNetworks.feedId, feedId));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// ROUTE–NETWORK CLASSIFICATION
// ═══════════════════════════════════════════════════════════

// GET /api/fares/route-networks
router.get("/fares/route-networks", async (_req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.json([]); return; }

    // Get all routes with their current assignment (if any)
    const routes = await db.select({
      routeId: gtfsRoutes.routeId,
      shortName: gtfsRoutes.routeShortName,
      longName: gtfsRoutes.routeLongName,
      routeColor: gtfsRoutes.routeColor,
    }).from(gtfsRoutes).where(eq(gtfsRoutes.feedId, feedId));

    const assignments = await db.select().from(gtfsRouteNetworks).where(eq(gtfsRouteNetworks.feedId, feedId));
    const assignMap = new Map(assignments.map(a => [a.routeId, a.networkId]));

    const result = routes.map(r => ({
      routeId: r.routeId,
      shortName: r.shortName,
      longName: r.longName,
      routeColor: r.routeColor,
      networkId: assignMap.get(r.routeId) ?? null,
      defaultNetworkId: classifyRoute(r.shortName || ""),
    }));

    res.json(result);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// POST /api/fares/route-networks/auto-classify — apply default classification to all unassigned
router.post("/fares/route-networks/auto-classify", async (_req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.status(400).json({ error: "No GTFS feed" }); return; }

    const routes = await db.select({
      routeId: gtfsRoutes.routeId,
      shortName: gtfsRoutes.routeShortName,
    }).from(gtfsRoutes).where(eq(gtfsRoutes.feedId, feedId));

    let count = 0;
    for (const r of routes) {
      const networkId = classifyRoute(r.shortName || "");
      await db.insert(gtfsRouteNetworks)
        .values({ feedId, routeId: r.routeId, networkId })
        .onConflictDoUpdate({
          target: [gtfsRouteNetworks.feedId, gtfsRouteNetworks.routeId],
          set: { networkId },
        });
      count++;
    }
    res.json({ classified: count });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// PUT /api/fares/route-networks/:routeId — manual reassign
router.put("/fares/route-networks/:routeId", async (req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.status(400).json({ error: "No GTFS feed" }); return; }
    const { networkId } = req.body;
    if (!networkId) { res.status(400).json({ error: "networkId required" }); return; }

    await db.insert(gtfsRouteNetworks)
      .values({ feedId, routeId: req.params.routeId, networkId })
      .onConflictDoUpdate({
        target: [gtfsRouteNetworks.feedId, gtfsRouteNetworks.routeId],
        set: { networkId },
      });
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// POST /api/fares/route-networks/bulk — save all assignments at once
router.post("/fares/route-networks/bulk", async (req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.status(400).json({ error: "No GTFS feed" }); return; }
    const { assignments } = req.body as { assignments: { routeId: string; networkId: string }[] };
    if (!Array.isArray(assignments)) { res.status(400).json({ error: "assignments array required" }); return; }

    let count = 0;
    for (const a of assignments) {
      await db.insert(gtfsRouteNetworks)
        .values({ feedId, routeId: a.routeId, networkId: a.networkId })
        .onConflictDoUpdate({
          target: [gtfsRouteNetworks.feedId, gtfsRouteNetworks.routeId],
          set: { networkId: a.networkId },
        });
      count++;
    }
    res.json({ saved: count });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// FARE MEDIA
// ═══════════════════════════════════════════════════════════

const DEFAULT_MEDIA = [
  { fareMediaId: "carta_contactless", fareMediaName: "Carta Trasporto Contactless", fareMediaType: 2 },
  { fareMediaId: "biglietto_cartaceo", fareMediaName: "Biglietto Cartaceo", fareMediaType: 1 },
  { fareMediaId: "cemv", fareMediaName: "Carta Bancaria Contactless (cEMV)", fareMediaType: 3 },
  { fareMediaId: "app_mobile", fareMediaName: "App Mobile", fareMediaType: 4 },
  { fareMediaId: "contanti", fareMediaName: "Pagamento a bordo", fareMediaType: 0 },
];

router.get("/fares/media", async (_req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.json([]); return; }
    const rows = await db.select().from(gtfsFareMedia).where(eq(gtfsFareMedia.feedId, feedId));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/fares/media/seed", async (_req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.status(400).json({ error: "No GTFS feed" }); return; }
    for (const m of DEFAULT_MEDIA) {
      await db.insert(gtfsFareMedia)
        .values({ feedId, ...m })
        .onConflictDoUpdate({
          target: [gtfsFareMedia.feedId, gtfsFareMedia.fareMediaId],
          set: { fareMediaName: m.fareMediaName, fareMediaType: m.fareMediaType, updatedAt: sql`now()` },
        });
    }
    const rows = await db.select().from(gtfsFareMedia).where(eq(gtfsFareMedia.feedId, feedId));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.put("/fares/media/:fareMediaId", async (req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.status(400).json({ error: "No GTFS feed" }); return; }
    const { isActive, fareMediaName } = req.body;
    const update: Record<string, any> = { updatedAt: sql`now()` };
    if (typeof isActive === "boolean") update.isActive = isActive;
    if (fareMediaName) update.fareMediaName = fareMediaName;

    await db.update(gtfsFareMedia)
      .set(update)
      .where(and(eq(gtfsFareMedia.feedId, feedId), eq(gtfsFareMedia.fareMediaId, req.params.fareMediaId)));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// RIDER CATEGORIES
// ═══════════════════════════════════════════════════════════

router.get("/fares/rider-categories", async (_req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.json([]); return; }
    const rows = await db.select().from(gtfsRiderCategories).where(eq(gtfsRiderCategories.feedId, feedId));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/fares/rider-categories/seed", async (_req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.status(400).json({ error: "No GTFS feed" }); return; }
    await db.insert(gtfsRiderCategories)
      .values({ feedId, riderCategoryId: "ordinario", riderCategoryName: "Tariffa Ordinaria", isDefault: true })
      .onConflictDoUpdate({
        target: [gtfsRiderCategories.feedId, gtfsRiderCategories.riderCategoryId],
        set: { riderCategoryName: "Tariffa Ordinaria", isDefault: true, updatedAt: sql`now()` },
      });
    const rows = await db.select().from(gtfsRiderCategories).where(eq(gtfsRiderCategories.feedId, feedId));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/fares/rider-categories", async (req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.status(400).json({ error: "No GTFS feed" }); return; }
    const { riderCategoryId, riderCategoryName, eligibilityUrl } = req.body;
    if (!riderCategoryId || !riderCategoryName) { res.status(400).json({ error: "Missing fields" }); return; }
    await db.insert(gtfsRiderCategories)
      .values({ feedId, riderCategoryId, riderCategoryName, isDefault: false, eligibilityUrl })
      .onConflictDoUpdate({
        target: [gtfsRiderCategories.feedId, gtfsRiderCategories.riderCategoryId],
        set: { riderCategoryName, eligibilityUrl, updatedAt: sql`now()` },
      });
    const rows = await db.select().from(gtfsRiderCategories).where(eq(gtfsRiderCategories.feedId, feedId));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/fares/rider-categories/:id", async (req, res) => {
  try {
    await db.delete(gtfsRiderCategories).where(eq(gtfsRiderCategories.id, req.params.id));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.put("/fares/rider-categories/:id", async (req, res): Promise<void> => {
  try {
    const { riderCategoryName, isDefault, eligibilityUrl } = req.body;
    const update: Record<string, unknown> = { updatedAt: sql`now()` };
    if (riderCategoryName !== undefined) update.riderCategoryName = riderCategoryName;
    if (isDefault !== undefined) update.isDefault = isDefault;
    if (eligibilityUrl !== undefined) update.eligibilityUrl = eligibilityUrl;
    await db.update(gtfsRiderCategories).set(update).where(eq(gtfsRiderCategories.id, req.params.id));
    const feedId = await getLatestFeedId();
    const rows = feedId
      ? await db.select().from(gtfsRiderCategories).where(eq(gtfsRiderCategories.feedId, feedId))
      : [];
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// CALENDAR (service patterns)
// ═══════════════════════════════════════════════════════════

router.get("/fares/calendar", async (_req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.json([]); return; }
    const rows = await db.select().from(gtfsCalendar).where(eq(gtfsCalendar.feedId, feedId));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Seed default service patterns: Feriale, Sabato, Festivo
router.post("/fares/calendar/seed", async (_req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.status(400).json({ error: "No GTFS feed" }); return; }
    const now = new Date();
    const startDate = `${now.getFullYear()}0101`;
    const endDate = `${now.getFullYear()}1231`;
    const templates = [
      { serviceId: "feriale", monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1, saturday: 0, sunday: 0 },
      { serviceId: "sabato", monday: 0, tuesday: 0, wednesday: 0, thursday: 0, friday: 0, saturday: 1, sunday: 0 },
      { serviceId: "festivo", monday: 0, tuesday: 0, wednesday: 0, thursday: 0, friday: 0, saturday: 0, sunday: 1 },
    ];
    for (const t of templates) {
      await db.insert(gtfsCalendar)
        .values({ feedId, ...t, startDate, endDate })
        .onConflictDoUpdate({
          target: [gtfsCalendar.feedId, gtfsCalendar.serviceId],
          set: { monday: t.monday, tuesday: t.tuesday, wednesday: t.wednesday, thursday: t.thursday, friday: t.friday, saturday: t.saturday, sunday: t.sunday, startDate, endDate },
        });
    }
    const rows = await db.select().from(gtfsCalendar).where(eq(gtfsCalendar.feedId, feedId));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/fares/calendar", async (req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.status(400).json({ error: "No GTFS feed" }); return; }
    const { serviceId, monday, tuesday, wednesday, thursday, friday, saturday, sunday, startDate, endDate } = req.body;
    if (!serviceId || !startDate || !endDate) { res.status(400).json({ error: "Missing required fields" }); return; }
    await db.insert(gtfsCalendar)
      .values({ feedId, serviceId, monday: monday ?? 0, tuesday: tuesday ?? 0, wednesday: wednesday ?? 0, thursday: thursday ?? 0, friday: friday ?? 0, saturday: saturday ?? 0, sunday: sunday ?? 0, startDate, endDate })
      .onConflictDoUpdate({
        target: [gtfsCalendar.feedId, gtfsCalendar.serviceId],
        set: { monday: monday ?? 0, tuesday: tuesday ?? 0, wednesday: wednesday ?? 0, thursday: thursday ?? 0, friday: friday ?? 0, saturday: saturday ?? 0, sunday: sunday ?? 0, startDate, endDate },
      });
    const rows = await db.select().from(gtfsCalendar).where(eq(gtfsCalendar.feedId, feedId));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.put("/fares/calendar/:id", async (req, res): Promise<void> => {
  try {
    const { monday, tuesday, wednesday, thursday, friday, saturday, sunday, startDate, endDate } = req.body;
    const update: Record<string, unknown> = {};
    if (monday !== undefined) update.monday = monday;
    if (tuesday !== undefined) update.tuesday = tuesday;
    if (wednesday !== undefined) update.wednesday = wednesday;
    if (thursday !== undefined) update.thursday = thursday;
    if (friday !== undefined) update.friday = friday;
    if (saturday !== undefined) update.saturday = saturday;
    if (sunday !== undefined) update.sunday = sunday;
    if (startDate !== undefined) update.startDate = startDate;
    if (endDate !== undefined) update.endDate = endDate;
    await db.update(gtfsCalendar).set(update).where(eq(gtfsCalendar.id, req.params.id));
    const feedId = await getLatestFeedId();
    const rows = feedId
      ? await db.select().from(gtfsCalendar).where(eq(gtfsCalendar.feedId, feedId))
      : [];
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/fares/calendar/:id", async (req, res) => {
  try {
    await db.delete(gtfsCalendar).where(eq(gtfsCalendar.id, req.params.id));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// CALENDAR DATES (exceptions)
// ═══════════════════════════════════════════════════════════

router.get("/fares/calendar-dates", async (_req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.json([]); return; }
    const rows = await db.select().from(gtfsCalendarDates).where(eq(gtfsCalendarDates.feedId, feedId));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/fares/calendar-dates", async (req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.status(400).json({ error: "No GTFS feed" }); return; }
    const { serviceId, date, exceptionType } = req.body;
    if (!serviceId || !date || !exceptionType) { res.status(400).json({ error: "Missing required fields" }); return; }
    await db.insert(gtfsCalendarDates).values({ feedId, serviceId, date, exceptionType });
    const rows = await db.select().from(gtfsCalendarDates).where(eq(gtfsCalendarDates.feedId, feedId));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/fares/calendar-dates/:id", async (req, res) => {
  try {
    await db.delete(gtfsCalendarDates).where(eq(gtfsCalendarDates.id, req.params.id));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// FARE PRODUCTS
// ═══════════════════════════════════════════════════════════

router.get("/fares/products", async (_req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.json([]); return; }
    const rows = await db.select().from(gtfsFareProducts).where(eq(gtfsFareProducts.feedId, feedId));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/fares/products/seed", async (_req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.status(400).json({ error: "No GTFS feed" }); return; }

    const urbanProducts = [
      { fareProductId: "ancona_60min", fareProductName: "Biglietto Urbano Ancona 60 min", networkId: "urbano_ancona", amount: 1.35, durationMinutes: 60, fareType: "single" as const },
      { fareProductId: "ancona_100min", fareProductName: "Biglietto Urbano Ancona 100 min", networkId: "urbano_ancona", amount: 1.50, durationMinutes: 100, fareType: "single" as const },
      { fareProductId: "jesi_60min", fareProductName: "Biglietto Urbano Jesi 60 min", networkId: "urbano_jesi", amount: 1.35, durationMinutes: 60, fareType: "single" as const },
      { fareProductId: "jesi_ar", fareProductName: "Biglietto Urbano Jesi A/R", networkId: "urbano_jesi", amount: 2.20, durationMinutes: 60, fareType: "return" as const },
      { fareProductId: "falconara_60min", fareProductName: "Biglietto Urbano Falconara 60 min", networkId: "urbano_falconara", amount: 1.35, durationMinutes: 60, fareType: "single" as const },
      { fareProductId: "falconara_ar", fareProductName: "Biglietto Urbano Falconara A/R", networkId: "urbano_falconara", amount: 2.00, durationMinutes: 60, fareType: "return" as const },
    ];

    const extraProducts = EXTRA_BANDS.map(b => ({
      fareProductId: `extra_fascia_${b.fascia}`,
      fareProductName: `Extraurbano ${b.kmFrom}-${b.kmTo} km`,
      networkId: "extraurbano",
      amount: b.price,
      durationMinutes: null as number | null,
      fareType: "zone" as const,
    }));

    const all = [...urbanProducts, ...extraProducts];
    for (const p of all) {
      await db.insert(gtfsFareProducts).values({
        feedId,
        fareProductId: p.fareProductId,
        fareProductName: p.fareProductName,
        networkId: p.networkId,
        amount: p.amount,
        durationMinutes: p.durationMinutes,
        fareType: p.fareType,
        riderCategoryId: "ordinario",
        fareMediaId: null, // null = any media (spec: empty fare_media_id means "all media accepted")
      }).onConflictDoNothing();
    }

    const rows = await db.select().from(gtfsFareProducts).where(eq(gtfsFareProducts.feedId, feedId));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.put("/fares/products/:id", async (req, res) => {
  try {
    const { amount, fareProductName, durationMinutes } = req.body;
    const update: Record<string, any> = { updatedAt: sql`now()` };
    if (typeof amount === "number") update.amount = amount;
    if (fareProductName) update.fareProductName = fareProductName;
    if (typeof durationMinutes === "number") update.durationMinutes = durationMinutes;
    await db.update(gtfsFareProducts).set(update).where(eq(gtfsFareProducts.id, req.params.id));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// AREAS & STOP-AREAS (Zone extraurbane)
// ═══════════════════════════════════════════════════════════

router.get("/fares/areas", async (_req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.json([]); return; }
    const rows = await db.select().from(gtfsFareAreas).where(eq(gtfsFareAreas.feedId, feedId));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get("/fares/stop-areas", async (_req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.json([]); return; }
    const rows = await db.select().from(gtfsStopAreas).where(eq(gtfsStopAreas.feedId, feedId));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// POST /api/fares/zones/generate/:routeId — build zones for one extraurban route
router.post("/fares/zones/generate/:routeId", async (req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.status(400).json({ error: "No GTFS feed" }); return; }
    const { routeId } = req.params;

    const result = await generateZonesForRoute(feedId, routeId);
    res.json(result);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// POST /api/fares/zones/generate-all — build zones for ALL extraurban routes + urban areas
router.post("/fares/zones/generate-all", async (_req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.status(400).json({ error: "No GTFS feed" }); return; }

    // 1) Create urban flat areas
    const urbanNets = ["urbano_ancona", "urbano_jesi", "urbano_falconara"];
    const urbanAreas = [
      { areaId: "ancona_urban", areaName: "Zona Urbana Ancona", networkId: "urbano_ancona" },
      { areaId: "jesi_urban", areaName: "Zona Urbana Jesi", networkId: "urbano_jesi" },
      { areaId: "falconara_urban", areaName: "Zona Urbana Falconara", networkId: "urbano_falconara" },
    ];

    for (const ua of urbanAreas) {
      await db.insert(gtfsFareAreas)
        .values({ feedId, areaId: ua.areaId, areaName: ua.areaName, networkId: ua.networkId })
        .onConflictDoUpdate({
          target: [gtfsFareAreas.feedId, gtfsFareAreas.areaId],
          set: { areaName: ua.areaName, updatedAt: sql`now()` },
        });
    }

    // 2) Assign all urban stops to their areas
    for (const net of urbanNets) {
      const urbanAreaId = net === "urbano_ancona" ? "ancona_urban"
        : net === "urbano_jesi" ? "jesi_urban" : "falconara_urban";

      // Find all stops served by routes in this network
      const stopRows = await db.execute<any>(sql`
        SELECT DISTINCT s.stop_id
        FROM gtfs_stops s
        JOIN gtfs_stop_times st ON st.stop_id = s.stop_id AND st.feed_id = s.feed_id
        JOIN gtfs_trips t ON t.trip_id = st.trip_id AND t.feed_id = s.feed_id
        JOIN gtfs_route_networks rn ON rn.route_id = t.route_id AND rn.feed_id = t.feed_id
        WHERE s.feed_id = ${feedId} AND rn.network_id = ${net}
      `);

      for (const row of stopRows.rows) {
        await db.insert(gtfsStopAreas)
          .values({ feedId, areaId: urbanAreaId, stopId: row.stop_id })
          .onConflictDoNothing();
      }
    }

    // 3) Generate zones for all extraurban routes
    const extraRoutes = await db.execute<any>(sql`
      SELECT rn.route_id
      FROM gtfs_route_networks rn
      WHERE rn.feed_id = ${feedId} AND rn.network_id = 'extraurbano'
    `);

    let totalZones = 0;
    const results: { routeId: string; zones: number; stops: number }[] = [];
    for (const row of extraRoutes.rows) {
      const r = await generateZonesForRoute(feedId, row.route_id);
      totalZones += r.zones;
      results.push(r);
    }

    res.json({ urbanAreas: 3, extraurbanRoutes: extraRoutes.rows.length, totalZones, details: results });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

/**
 * Generate km-based zones for a single extraurban route.
 * 1. Pick the trip with most stops (longest variant)
 * 2. For each stop, compute progressive distance from first stop using shape or haversine
 * 3. Assign each stop to a zone based on which fare band its distance falls into
 */
async function generateZonesForRoute(feedId: string, routeId: string) {
  // Get the trip with the most stops for this route
  const tripRows = await db.execute<any>(sql`
    SELECT t.trip_id, t.shape_id, COUNT(*) AS cnt
    FROM gtfs_trips t
    JOIN gtfs_stop_times st ON st.trip_id = t.trip_id AND st.feed_id = t.feed_id
    WHERE t.feed_id = ${feedId} AND t.route_id = ${routeId}
    GROUP BY t.trip_id, t.shape_id
    ORDER BY cnt DESC
    LIMIT 1
  `);

  if (tripRows.rows.length === 0) return { routeId, zones: 0, stops: 0 };

  const tripId = tripRows.rows[0].trip_id;
  const shapeId = tripRows.rows[0].shape_id;

  // Get ordered stops for this trip
  const stopsData = await db.execute<any>(sql`
    SELECT st.stop_id, st.stop_sequence, s.stop_lat::float AS lat, s.stop_lon::float AS lon, s.stop_name
    FROM gtfs_stop_times st
    JOIN gtfs_stops s ON s.stop_id = st.stop_id AND s.feed_id = st.feed_id
    WHERE st.feed_id = ${feedId} AND st.trip_id = ${tripId}
    ORDER BY st.stop_sequence
  `);

  if (stopsData.rows.length === 0) return { routeId, zones: 0, stops: 0 };

  // Try to get shape coordinates for more accurate distances
  let shapeCoords: number[][] | null = null;
  if (shapeId) {
    const shapeRows = await db.execute<any>(sql`
      SELECT geojson FROM gtfs_shapes WHERE feed_id = ${feedId} AND shape_id = ${shapeId} LIMIT 1
    `);
    if (shapeRows.rows.length > 0) {
      const geo = shapeRows.rows[0].geojson;
      if (geo?.geometry?.coordinates) shapeCoords = geo.geometry.coordinates;
    }
  }

  // Compute progressive distance for each stop
  const stops = stopsData.rows as { stop_id: string; stop_sequence: number; lat: number; lon: number; stop_name: string }[];
  const progressiveKm: { stopId: string; stopName: string; km: number; lat: number; lon: number }[] = [];

  let cumulativeKm = 0;
  for (let i = 0; i < stops.length; i++) {
    if (i > 0) {
      cumulativeKm += haversineKm(stops[i - 1].lat, stops[i - 1].lon, stops[i].lat, stops[i].lon);
    }
    progressiveKm.push({
      stopId: stops[i].stop_id,
      stopName: stops[i].stop_name,
      km: Math.round(cumulativeKm * 100) / 100,
      lat: stops[i].lat,
      lon: stops[i].lon,
    });
  }

  // Determine which bands are needed and create zones
  const usedBands = new Set<number>();
  for (const s of progressiveKm) {
    const band = getBandForDistance(s.km);
    if (band) usedBands.add(band.fascia);
    else if (s.km === 0) usedBands.add(1); // first stop → zone 1
  }

  // Create area records for this route
  const createdZones: string[] = [];
  for (const fascia of Array.from(usedBands).sort((a, b) => a - b)) {
    const band = EXTRA_BANDS[fascia - 1];
    const areaId = `${routeId}_zona_${fascia}`;
    const areaName = `Linea ${routeId} - Zona km ${band.kmFrom}-${band.kmTo}`;

    await db.insert(gtfsFareAreas)
      .values({
        feedId, areaId, areaName,
        networkId: "extraurbano", routeId,
        kmFrom: band.kmFrom, kmTo: band.kmTo,
      })
      .onConflictDoUpdate({
        target: [gtfsFareAreas.feedId, gtfsFareAreas.areaId],
        set: { areaName, kmFrom: band.kmFrom, kmTo: band.kmTo, updatedAt: sql`now()` },
      });
    createdZones.push(areaId);
  }

  // Assign stops to zones
  let stopsAssigned = 0;
  for (const s of progressiveKm) {
    let band = getBandForDistance(s.km);
    if (!band && s.km === 0) band = EXTRA_BANDS[0];
    if (!band) continue;

    const areaId = `${routeId}_zona_${band.fascia}`;
    await db.insert(gtfsStopAreas)
      .values({ feedId, areaId, stopId: s.stopId })
      .onConflictDoNothing();
    stopsAssigned++;
  }

  return { routeId, zones: createdZones.length, stops: stopsAssigned };
}

// ═══════════════════════════════════════════════════════════
// FARE LEG RULES
// ═══════════════════════════════════════════════════════════

router.get("/fares/leg-rules", async (_req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.json([]); return; }
    const rows = await db.select().from(gtfsFareLegRules).where(eq(gtfsFareLegRules.feedId, feedId));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// POST /api/fares/leg-rules/generate — generate from current areas & products
router.post("/fares/leg-rules/generate", async (_req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.status(400).json({ error: "No GTFS feed" }); return; }

    // Delete existing leg rules
    await db.delete(gtfsFareLegRules).where(eq(gtfsFareLegRules.feedId, feedId));

    // 1) Urban flat rules (no area constraints)
    const urbanRules = [
      { legGroupId: "lg_ancona_60", networkId: "urbano_ancona", fareProductId: "ancona_60min" },
      { legGroupId: "lg_ancona_100", networkId: "urbano_ancona", fareProductId: "ancona_100min" },
      { legGroupId: "lg_jesi_60", networkId: "urbano_jesi", fareProductId: "jesi_60min" },
      { legGroupId: "lg_jesi_ar", networkId: "urbano_jesi", fareProductId: "jesi_ar" },
      { legGroupId: "lg_falconara_60", networkId: "urbano_falconara", fareProductId: "falconara_60min" },
      { legGroupId: "lg_falconara_ar", networkId: "urbano_falconara", fareProductId: "falconara_ar" },
    ];

    for (const r of urbanRules) {
      await db.insert(gtfsFareLegRules).values({ feedId, ...r, rulePriority: 10 });
    }

    // 2) Extraurban OD matrix
    // Group areas by route
    const areas = await db.select().from(gtfsFareAreas)
      .where(and(eq(gtfsFareAreas.feedId, feedId), eq(gtfsFareAreas.networkId, "extraurbano")));

    const byRoute = new Map<string, typeof areas>();
    for (const a of areas) {
      if (!a.routeId) continue;
      const arr = byRoute.get(a.routeId) || [];
      arr.push(a);
      byRoute.set(a.routeId, arr);
    }

    let odCount = 0;
    for (const [rId, routeAreas] of byRoute) {
      // Sort by kmFrom
      routeAreas.sort((a, b) => (a.kmFrom || 0) - (b.kmFrom || 0));

      // For every pair (i,j) where i≠j, compute distance and assign fare band
      for (let i = 0; i < routeAreas.length; i++) {
        for (let j = 0; j < routeAreas.length; j++) {
          if (i === j) continue;
          const from = routeAreas[i];
          const to = routeAreas[j];
          // Distance = midpoint of "to" zone − midpoint of "from" zone
          const fromMid = ((from.kmFrom || 0) + (from.kmTo || 0)) / 2;
          const toMid = ((to.kmFrom || 0) + (to.kmTo || 0)) / 2;
          const dist = Math.abs(toMid - fromMid);
          const band = getBandForDistance(dist);
          if (!band) continue;

          await db.insert(gtfsFareLegRules).values({
            feedId,
            legGroupId: "lg_extra",
            networkId: "extraurbano",
            fromAreaId: from.areaId,
            toAreaId: to.areaId,
            fareProductId: `extra_fascia_${band.fascia}`,
            rulePriority: 0,
          });
          odCount++;
        }
      }
    }

    res.json({ urbanRules: urbanRules.length, odRules: odCount, total: urbanRules.length + odCount });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// FARE TRANSFER RULES
// ═══════════════════════════════════════════════════════════

router.get("/fares/transfer-rules", async (_req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.json([]); return; }
    const rows = await db.select().from(gtfsFareTransferRules).where(eq(gtfsFareTransferRules.feedId, feedId));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// TIMEFRAMES (GTFS timeframes.txt)
// ═══════════════════════════════════════════════════════════

router.get("/fares/timeframes", async (_req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.json([]); return; }
    const rows = await db.select().from(gtfsTimeframes).where(eq(gtfsTimeframes.feedId, feedId));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/fares/timeframes", async (req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.status(400).json({ error: "No GTFS feed" }); return; }
    const { timeframeGroupId, startTime, endTime, serviceId } = req.body;
    if (!timeframeGroupId) { res.status(400).json({ error: "timeframeGroupId required" }); return; }
    const [row] = await db.insert(gtfsTimeframes).values({
      feedId, timeframeGroupId, startTime, endTime, serviceId,
    }).returning();
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/fares/timeframes/:id", async (req, res): Promise<void> => {
  try {
    await db.delete(gtfsTimeframes).where(eq(gtfsTimeframes.id, req.params.id));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// SIMULATE — ticket price lookup (computes distance on-the-fly, no pre-generated zones needed)
// ═══════════════════════════════════════════════════════════

router.post("/fares/simulate", async (req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.status(400).json({ error: "No GTFS feed" }); return; }
    const { networkId, routeId, fromStopId, toStopId } = req.body;

    if (!networkId) { res.status(400).json({ error: "networkId required" }); return; }

    // Urban → flat fare, just return all products for the network
    if (networkId !== "extraurbano") {
      const products = await db.select().from(gtfsFareProducts)
        .where(and(eq(gtfsFareProducts.feedId, feedId), eq(gtfsFareProducts.networkId, networkId)));
      
      // If no products seeded yet, still return a default response
      if (products.length === 0) {
        res.json({
          type: "urban",
          networkId,
          products: [{ fareProductId: "default_60", name: "Biglietto 60 min", amount: 1.35, currency: "EUR", durationMinutes: 60 }],
        });
        return;
      }
      
      res.json({
        type: "urban",
        networkId,
        products: products.map(p => ({
          fareProductId: p.fareProductId,
          name: p.fareProductName,
          amount: p.amount,
          currency: p.currency,
          durationMinutes: p.durationMinutes,
        })),
      });
      return;
    }

    // Extraurban → need routeId + stops to compute distance
    if (!routeId || !fromStopId || !toStopId) {
      res.status(400).json({ error: "For extraurban, routeId + fromStopId + toStopId required" });
      return;
    }

    // ── Compute distance on-the-fly from stop sequence ──
    // Get the longest trip for this route
    const tripRows = await db.execute<any>(sql`
      SELECT t.trip_id, COUNT(*) AS cnt
      FROM gtfs_trips t
      JOIN gtfs_stop_times st ON st.trip_id = t.trip_id AND st.feed_id = t.feed_id
      WHERE t.feed_id = ${feedId} AND t.route_id = ${routeId}
      GROUP BY t.trip_id ORDER BY cnt DESC LIMIT 1
    `);
    if (tripRows.rows.length === 0) {
      res.status(404).json({ error: "No trips found for this route" }); return;
    }

    const tripId = tripRows.rows[0].trip_id;

    // Get ordered stops with coordinates
    const stopsData = await db.execute<any>(sql`
      SELECT st.stop_id, st.stop_sequence, s.stop_lat::float AS lat, s.stop_lon::float AS lon, s.stop_name
      FROM gtfs_stop_times st
      JOIN gtfs_stops s ON s.stop_id = st.stop_id AND s.feed_id = st.feed_id
      WHERE st.feed_id = ${feedId} AND st.trip_id = ${tripId}
      ORDER BY st.stop_sequence
    `);

    const stops = stopsData.rows as { stop_id: string; stop_sequence: number; lat: number; lon: number; stop_name: string }[];

    // Build progressive km map
    const kmMap = new Map<string, { km: number; name: string; lat: number; lon: number }>();
    let cumulativeKm = 0;
    for (let i = 0; i < stops.length; i++) {
      if (i > 0) {
        cumulativeKm += haversineKm(stops[i - 1].lat, stops[i - 1].lon, stops[i].lat, stops[i].lon);
      }
      kmMap.set(stops[i].stop_id, {
        km: Math.round(cumulativeKm * 100) / 100,
        name: stops[i].stop_name,
        lat: stops[i].lat,
        lon: stops[i].lon,
      });
    }

    const fromInfo = kmMap.get(fromStopId);
    const toInfo = kmMap.get(toStopId);

    if (!fromInfo || !toInfo) {
      res.status(404).json({ error: "Stop not found in this route's trip sequence" }); return;
    }

    const distKm = Math.abs(toInfo.km - fromInfo.km);
    const band = getBandForDistance(distKm) ?? (distKm <= 6 ? EXTRA_BANDS[0] : undefined);

    if (!band) {
      res.status(404).json({ error: `No fare band for distance ${distKm.toFixed(1)} km` }); return;
    }

    // Build intermediate stops for the map
    const fromIdx = stops.findIndex(s => s.stop_id === fromStopId);
    const toIdx = stops.findIndex(s => s.stop_id === toStopId);
    const minIdx = Math.min(fromIdx, toIdx);
    const maxIdx = Math.max(fromIdx, toIdx);
    const intermediateStops = stops.slice(minIdx, maxIdx + 1).map(s => {
      const info = kmMap.get(s.stop_id)!;
      return { stopId: s.stop_id, stopName: s.stop_name, lat: s.lat, lon: s.lon, km: info.km };
    });

    res.json({
      type: "extraurban",
      networkId,
      routeId,
      fromStopId,
      toStopId,
      fromStop: { stopId: fromStopId, name: fromInfo.name, lat: fromInfo.lat, lon: fromInfo.lon, km: fromInfo.km },
      toStop: { stopId: toStopId, name: toInfo.name, lat: toInfo.lat, lon: toInfo.lon, km: toInfo.km },
      distanceKm: Math.round(distKm * 100) / 100,
      fascia: band.fascia,
      fareProductId: `extra_fascia_${band.fascia}`,
      amount: band.price,
      currency: "EUR",
      bandRange: `${band.kmFrom}-${band.kmTo} km`,
      intermediateStops,
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// SIMULATE CLUSTER — ticket price based on cluster centroid distance
// ═══════════════════════════════════════════════════════════
router.post("/fares/simulate-cluster", async (req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.status(400).json({ error: "No GTFS feed" }); return; }
    const { fromStopId, toStopId } = req.body;
    if (!fromStopId || !toStopId) { res.status(400).json({ error: "fromStopId and toStopId required" }); return; }

    // Find the clusters these stops belong to
    const allClusterStops = await db.select().from(gtfsFareZoneClusterStops)
      .where(eq(gtfsFareZoneClusterStops.feedId, feedId));

    const fromCS = allClusterStops.find(s => s.stopId === fromStopId);
    const toCS = allClusterStops.find(s => s.stopId === toStopId);

    if (!fromCS) { res.status(404).json({ error: `Fermata partenza ${fromStopId} non assegnata a nessun cluster` }); return; }
    if (!toCS) { res.status(404).json({ error: `Fermata arrivo ${toStopId} non assegnata a nessun cluster` }); return; }

    // Load full cluster info
    const clusters = await db.select().from(gtfsFareZoneClusters).where(eq(gtfsFareZoneClusters.feedId, feedId));
    const fromCluster = clusters.find(c => c.clusterId === fromCS.clusterId);
    const toCluster = clusters.find(c => c.clusterId === toCS.clusterId);

    if (!fromCluster || !toCluster) { res.status(404).json({ error: "Cluster non trovato" }); return; }

    // Centroid-to-centroid distance
    const distKm = fromCluster.clusterId === toCluster.clusterId
      ? 0
      : haversineKm(fromCluster.centroidLat!, fromCluster.centroidLon!, toCluster.centroidLat!, toCluster.centroidLon!);
    const band = getBandForDistance(distKm) ?? (distKm <= 6 ? EXTRA_BANDS[0] : undefined);

    // Get all stops for both clusters (for hull rendering)
    const fromClusterStops = allClusterStops.filter(s => s.clusterId === fromCS.clusterId)
      .map(s => ({ stopId: s.stopId, stopName: s.stopName, lat: s.stopLat!, lon: s.stopLon! }));
    const toClusterStops = allClusterStops.filter(s => s.clusterId === toCS.clusterId)
      .map(s => ({ stopId: s.stopId, stopName: s.stopName, lat: s.stopLat!, lon: s.stopLon! }));

    // Stop info for from/to
    const fromStopInfo = fromClusterStops.find(s => s.stopId === fromStopId);
    const toStopInfo = toClusterStops.find(s => s.stopId === toStopId);

    res.json({
      type: "cluster",
      fromStop: fromStopInfo ? { stopId: fromStopInfo.stopId, name: fromStopInfo.stopName, lat: fromStopInfo.lat, lon: fromStopInfo.lon } : null,
      toStop: toStopInfo ? { stopId: toStopInfo.stopId, name: toStopInfo.stopName, lat: toStopInfo.lat, lon: toStopInfo.lon } : null,
      fromCluster: {
        clusterId: fromCluster.clusterId,
        clusterName: fromCluster.clusterName,
        color: fromCluster.color,
        centroidLat: fromCluster.centroidLat,
        centroidLon: fromCluster.centroidLon,
        stops: fromClusterStops,
      },
      toCluster: {
        clusterId: toCluster.clusterId,
        clusterName: toCluster.clusterName,
        color: toCluster.color,
        centroidLat: toCluster.centroidLat,
        centroidLon: toCluster.centroidLon,
        stops: toClusterStops,
      },
      sameCluster: fromCluster.clusterId === toCluster.clusterId,
      distanceKm: Math.round(distKm * 100) / 100,
      fascia: band ? band.fascia : null,
      amount: band ? band.price : null,
      currency: "EUR",
      bandRange: band ? `${band.kmFrom}-${band.kmTo} km` : null,
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// GENERATE GTFS FILES — returns JSON with all CSV content
// ═══════════════════════════════════════════════════════════

router.post("/fares/generate-gtfs", async (_req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.status(400).json({ error: "No GTFS feed" }); return; }

    // --- networks.txt ---
    const networks = await db.select().from(gtfsFareNetworks).where(eq(gtfsFareNetworks.feedId, feedId));
    let networksCsv = "network_id,network_name\n";
    for (const n of networks) networksCsv += `${n.networkId},${n.networkName}\n`;

    // --- route_networks.txt ---
    const routeNets = await db.select().from(gtfsRouteNetworks).where(eq(gtfsRouteNetworks.feedId, feedId));
    let routeNetCsv = "network_id,route_id\n";
    for (const rn of routeNets) routeNetCsv += `${rn.networkId},${rn.routeId}\n`;

    // --- fare_media.txt ---
    const media = await db.select().from(gtfsFareMedia)
      .where(and(eq(gtfsFareMedia.feedId, feedId), eq(gtfsFareMedia.isActive, true)));
    let mediaCsv = "fare_media_id,fare_media_name,fare_media_type\n";
    for (const m of media) mediaCsv += `${m.fareMediaId},${m.fareMediaName},${m.fareMediaType}\n`;

    // --- rider_categories.txt ---
    const cats = await db.select().from(gtfsRiderCategories).where(eq(gtfsRiderCategories.feedId, feedId));
    let catCsv = "rider_category_id,rider_category_name,is_default_fare_category,eligibility_url\n";
    for (const c of cats) {
      catCsv += `${c.riderCategoryId},${c.riderCategoryName},${c.isDefault ? 1 : 0},${c.eligibilityUrl || ""}\n`;
    }

    // --- fare_products.txt ---
    const products = await db.select().from(gtfsFareProducts).where(eq(gtfsFareProducts.feedId, feedId));
    let prodCsv = "fare_product_id,fare_product_name,rider_category_id,fare_media_id,amount,currency\n";
    for (const p of products) {
      prodCsv += `${p.fareProductId},${p.fareProductName},${p.riderCategoryId || ""},${p.fareMediaId || ""},${p.amount.toFixed(2)},${p.currency}\n`;
    }

    // --- areas.txt ---
    const areas = await db.select().from(gtfsFareAreas).where(eq(gtfsFareAreas.feedId, feedId));
    let areasCsv = "area_id,area_name\n";
    for (const a of areas) areasCsv += `${a.areaId},${a.areaName}\n`;

    // --- stop_areas.txt ---
    const stopAreas = await db.select().from(gtfsStopAreas).where(eq(gtfsStopAreas.feedId, feedId));
    let stopAreasCsv = "area_id,stop_id\n";
    for (const sa of stopAreas) stopAreasCsv += `${sa.areaId},${sa.stopId}\n`;

    // --- fare_leg_rules.txt ---
    const legRules = await db.select().from(gtfsFareLegRules).where(eq(gtfsFareLegRules.feedId, feedId));
    let legCsv = "leg_group_id,network_id,from_area_id,to_area_id,from_timeframe_group_id,to_timeframe_group_id,fare_product_id,rule_priority\n";
    for (const lr of legRules) {
      legCsv += `${lr.legGroupId},${lr.networkId || ""},${lr.fromAreaId || ""},${lr.toAreaId || ""},${lr.fromTimeframeGroupId || ""},${lr.toTimeframeGroupId || ""},${lr.fareProductId},${lr.rulePriority}\n`;
    }

    // --- fare_transfer_rules.txt ---
    const xferRules = await db.select().from(gtfsFareTransferRules).where(eq(gtfsFareTransferRules.feedId, feedId));
    let xferCsv = "from_leg_group_id,to_leg_group_id,transfer_count,duration_limit,duration_limit_type,fare_transfer_type,fare_product_id\n";
    for (const xr of xferRules) {
      xferCsv += `${xr.fromLegGroupId || ""},${xr.toLegGroupId || ""},${xr.transferCount ?? ""},${xr.durationLimit ?? ""},${xr.durationLimitType ?? ""},${xr.fareTransferType ?? ""},${xr.fareProductId || ""}\n`;
    }

    // --- timeframes.txt ---
    const timeframes = await db.select().from(gtfsTimeframes).where(eq(gtfsTimeframes.feedId, feedId));
    let tfCsv = "timeframe_group_id,start_time,end_time,service_id\n";
    for (const tf of timeframes) {
      tfCsv += `${tf.timeframeGroupId},${tf.startTime || ""},${tf.endTime || ""},${tf.serviceId || ""}\n`;
    }

    // --- fare_attributes.txt (Fares V1) --- REMOVED: using only Fares V2 to avoid consumer confusion
    // --- fare_rules.txt (Fares V1) --- REMOVED: using only Fares V2 to avoid consumer confusion

    // Validation summary
    const routeCount = routeNets.length;
    const allRoutes = await db.select().from(gtfsRoutes).where(eq(gtfsRoutes.feedId, feedId));
    const missingRoutes = allRoutes.filter(r => !routeNets.find(rn => rn.routeId === r.routeId));

    // Build files map — only include non-empty files (beyond header)
    const allFiles: Record<string, string> = {};
    const maybeAdd = (name: string, csv: string) => {
      const lines = csv.split("\n").filter(Boolean);
      if (lines.length > 1) allFiles[name] = csv; // >1 means has data rows beyond header
    };
    // Fares V2 only (no V1 — spec says consumers must use only one)
    maybeAdd("networks.txt", networksCsv);
    maybeAdd("route_networks.txt", routeNetCsv);
    maybeAdd("fare_media.txt", mediaCsv);
    maybeAdd("rider_categories.txt", catCsv);
    maybeAdd("fare_products.txt", prodCsv);
    maybeAdd("areas.txt", areasCsv);
    maybeAdd("stop_areas.txt", stopAreasCsv);
    maybeAdd("fare_leg_rules.txt", legCsv);
    maybeAdd("fare_transfer_rules.txt", xferCsv);
    maybeAdd("timeframes.txt", tfCsv);

    // --- feed_info.txt ---
    const feedInfoRows = await db.select().from(gtfsFeedInfo).where(eq(gtfsFeedInfo.feedId, feedId));
    if (feedInfoRows.length > 0) {
      const fi = feedInfoRows[0];
      let fiCsv = "feed_publisher_name,feed_publisher_url,feed_lang,default_lang,feed_start_date,feed_end_date,feed_version,feed_contact_email,feed_contact_url\n";
      fiCsv += `${fi.feedPublisherName},${fi.feedPublisherUrl},${fi.feedLang},${fi.defaultLang || ""},${fi.feedStartDate || ""},${fi.feedEndDate || ""},${fi.feedVersion || ""},${fi.feedContactEmail || ""},${fi.feedContactUrl || ""}\n`;
      allFiles["feed_info.txt"] = fiCsv;
    }

    res.json({
      files: allFiles,
      validation: {
        routesClassified: routeCount,
        totalRoutes: allRoutes.length,
        missingRoutes: missingRoutes.map(r => r.routeId),
        products: products.length,
        areas: areas.length,
        stopAreaAssignments: stopAreas.length,
        legRules: legRules.length,
        transferRules: xferRules.length,
        timeframes: timeframes.length,
        isComplete: missingRoutes.length === 0 && products.length > 0 && legRules.length > 0,
      },
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// GET /api/fares/route-stops/:routeId — get ordered stops with progressive km (for zone editor)
router.get("/fares/route-stops/:routeId", async (req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.json([]); return; }
    const { routeId } = req.params;

    // Get longest trip
    const tripRows = await db.execute<any>(sql`
      SELECT t.trip_id, COUNT(*) AS cnt
      FROM gtfs_trips t
      JOIN gtfs_stop_times st ON st.trip_id = t.trip_id AND st.feed_id = t.feed_id
      WHERE t.feed_id = ${feedId} AND t.route_id = ${routeId}
      GROUP BY t.trip_id ORDER BY cnt DESC LIMIT 1
    `);
    if (tripRows.rows.length === 0) { res.json([]); return; }

    const tripId = tripRows.rows[0].trip_id;
    const stopsData = await db.execute<any>(sql`
      SELECT st.stop_id, st.stop_sequence, s.stop_lat::float AS lat, s.stop_lon::float AS lon, s.stop_name
      FROM gtfs_stop_times st
      JOIN gtfs_stops s ON s.stop_id = st.stop_id AND s.feed_id = st.feed_id
      WHERE st.feed_id = ${feedId} AND st.trip_id = ${tripId}
      ORDER BY st.stop_sequence
    `);

    const stops = stopsData.rows as { stop_id: string; stop_sequence: number; lat: number; lon: number; stop_name: string }[];
    const result: any[] = [];
    let cumulativeKm = 0;

    // Also get existing area assignments for this route
    const existingAreas = await db.execute<any>(sql`
      SELECT sa.stop_id, sa.area_id, a.area_name, a.km_from, a.km_to
      FROM gtfs_stop_areas sa
      JOIN gtfs_fare_areas a ON a.area_id = sa.area_id AND a.feed_id = sa.feed_id
      WHERE sa.feed_id = ${feedId} AND a.route_id = ${routeId}
    `);
    const areaMap = new Map(existingAreas.rows.map((r: any) => [r.stop_id, r]));

    for (let i = 0; i < stops.length; i++) {
      if (i > 0) {
        cumulativeKm += haversineKm(stops[i - 1].lat, stops[i - 1].lon, stops[i].lat, stops[i].lon);
      }
      const band = getBandForDistance(cumulativeKm) || (cumulativeKm === 0 ? EXTRA_BANDS[0] : null);
      const existing = areaMap.get(stops[i].stop_id);

      result.push({
        stopId: stops[i].stop_id,
        stopName: stops[i].stop_name,
        sequence: stops[i].stop_sequence,
        lat: stops[i].lat,
        lon: stops[i].lon,
        progressiveKm: Math.round(cumulativeKm * 100) / 100,
        suggestedFascia: band?.fascia || null,
        suggestedAreaId: band ? `${routeId}_zona_${band.fascia}` : null,
        currentAreaId: existing?.area_id || null,
        currentAreaName: existing?.area_name || null,
      });
    }

    res.json(result);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// FARES V1 — fare_attributes.txt & fare_rules.txt
// ═══════════════════════════════════════════════════════════

router.get("/fares/fare-attributes", async (_req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.json([]); return; }
    const rows = await db.select().from(gtfsFareAttributes).where(eq(gtfsFareAttributes.feedId, feedId));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/fares/fare-attributes", async (req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.status(400).json({ error: "No GTFS feed" }); return; }
    const { fareId, price, currencyType, paymentMethod, transfers, agencyId, transferDuration } = req.body;
    if (!fareId || price == null) { res.status(400).json({ error: "fareId and price required" }); return; }
    const [row] = await db.insert(gtfsFareAttributes).values({
      feedId, fareId, price: Number(price), currencyType: currencyType || "EUR",
      paymentMethod: paymentMethod ?? 0, transfers: transfers ?? null,
      agencyId: agencyId || "ATMA", transferDuration: transferDuration ?? null,
    }).returning();
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.put("/fares/fare-attributes/:id", async (req, res): Promise<void> => {
  try {
    const updates: any = {};
    if (req.body.price != null) updates.price = Number(req.body.price);
    if (req.body.paymentMethod != null) updates.paymentMethod = req.body.paymentMethod;
    if (req.body.transfers !== undefined) updates.transfers = req.body.transfers;
    if (req.body.transferDuration !== undefined) updates.transferDuration = req.body.transferDuration;
    const [row] = await db.update(gtfsFareAttributes).set(updates).where(eq(gtfsFareAttributes.id, req.params.id)).returning();
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/fares/fare-attributes/:id", async (req, res): Promise<void> => {
  try {
    await db.delete(gtfsFareAttributes).where(eq(gtfsFareAttributes.id, req.params.id));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Auto-seed Fares V1 from existing Fares V2 products
router.post("/fares/fare-attributes/seed", async (_req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.status(400).json({ error: "No GTFS feed" }); return; }
    // Delete existing
    await db.delete(gtfsFareAttributes).where(eq(gtfsFareAttributes.feedId, feedId));
    await db.delete(gtfsFareRules).where(eq(gtfsFareRules.feedId, feedId));
    // Generate from products
    const products = await db.select().from(gtfsFareProducts).where(eq(gtfsFareProducts.feedId, feedId));
    const routeNets = await db.select().from(gtfsRouteNetworks).where(eq(gtfsRouteNetworks.feedId, feedId));
    const attrs: any[] = [];
    const rules: any[] = [];
    for (const p of products) {
      attrs.push({
        feedId, fareId: p.fareProductId, price: p.amount, currencyType: p.currency,
        paymentMethod: 0, transfers: 0, agencyId: "ATMA", transferDuration: null,
      });
      // Create fare rules linking to routes of that product's network
      const matchingRoutes = routeNets.filter(rn => rn.networkId === p.networkId);
      for (const rn of matchingRoutes) {
        rules.push({ feedId, fareId: p.fareProductId, routeId: rn.routeId });
      }
    }
    if (attrs.length > 0) await db.insert(gtfsFareAttributes).values(attrs);
    if (rules.length > 0) await db.insert(gtfsFareRules).values(rules);
    res.json({ fareAttributes: attrs.length, fareRules: rules.length });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get("/fares/fare-rules", async (_req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.json([]); return; }
    const rows = await db.select().from(gtfsFareRules).where(eq(gtfsFareRules.feedId, feedId));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/fares/fare-rules", async (req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.status(400).json({ error: "No GTFS feed" }); return; }
    const { fareId, routeId, originId, destinationId, containsId } = req.body;
    if (!fareId) { res.status(400).json({ error: "fareId required" }); return; }
    const [row] = await db.insert(gtfsFareRules).values({
      feedId, fareId, routeId, originId, destinationId, containsId,
    }).returning();
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/fares/fare-rules/:id", async (req, res): Promise<void> => {
  try {
    await db.delete(gtfsFareRules).where(eq(gtfsFareRules.id, req.params.id));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// STOP TIMES EDITOR — pickup_type / drop_off_type per route
// ═══════════════════════════════════════════════════════════

// GET stop_times for a route (aggregated: one row per stop with pickup/dropoff)
router.get("/fares/stop-times/:routeId", async (req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.json([]); return; }
    const { routeId } = req.params;

    // Get the longest trip for the route (representative)
    const tripRows = await db.execute<any>(sql`
      SELECT t.trip_id, COUNT(*) AS cnt
      FROM gtfs_trips t
      JOIN gtfs_stop_times st ON st.trip_id = t.trip_id AND st.feed_id = t.feed_id
      WHERE t.feed_id = ${feedId} AND t.route_id = ${routeId}
      GROUP BY t.trip_id ORDER BY cnt DESC LIMIT 1
    `);
    if (tripRows.rows.length === 0) { res.json([]); return; }
    const repTripId = tripRows.rows[0].trip_id;

    const stData = await db.execute<any>(sql`
      SELECT st.stop_id, st.stop_sequence, st.pickup_type, st.drop_off_type,
             st.arrival_time, st.departure_time,
             s.stop_name, s.stop_lat::float AS lat, s.stop_lon::float AS lon
      FROM gtfs_stop_times st
      JOIN gtfs_stops s ON s.stop_id = st.stop_id AND s.feed_id = st.feed_id
      WHERE st.feed_id = ${feedId} AND st.trip_id = ${repTripId}
      ORDER BY st.stop_sequence
    `);

    res.json(stData.rows.map((r: any) => ({
      stopId: r.stop_id,
      stopName: r.stop_name,
      sequence: r.stop_sequence,
      lat: r.lat,
      lon: r.lon,
      arrivalTime: r.arrival_time,
      departureTime: r.departure_time,
      pickupType: r.pickup_type ?? 0,
      dropOffType: r.drop_off_type ?? 0,
    })));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// PUT bulk update pickup_type / drop_off_type for ALL trips of a route at a given stop
router.put("/fares/stop-times/:routeId", async (req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.status(400).json({ error: "No GTFS feed" }); return; }
    const { routeId } = req.params;
    const { updates } = req.body as { updates: { stopId: string; pickupType: number; dropOffType: number }[] };
    if (!updates || !Array.isArray(updates)) { res.status(400).json({ error: "updates array required" }); return; }

    // Get all trips for this route
    const trips = await db.select({ tripId: gtfsTrips.tripId }).from(gtfsTrips)
      .where(and(eq(gtfsTrips.feedId, feedId), eq(gtfsTrips.routeId, routeId)));
    const tripIds = trips.map(t => t.tripId);

    let updated = 0;
    for (const u of updates) {
      const result = await db.execute(sql`
        UPDATE gtfs_stop_times
        SET pickup_type = ${u.pickupType}, drop_off_type = ${u.dropOffType}
        WHERE feed_id = ${feedId} AND stop_id = ${u.stopId}
          AND trip_id = ANY(${tripIds})
      `);
      updated += (result as any).rowCount || 0;
    }

    res.json({ ok: true, updated });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// EXPORT ZIP — complete GTFS feed with all base tables + Fares V1 + Fares V2
// ═══════════════════════════════════════════════════════════

router.get("/fares/export-zip", async (_req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.status(400).json({ error: "No GTFS feed" }); return; }

    // Dynamically import archiver
    const archiver = (await import("archiver")).default;
    const archive = archiver("zip", { zlib: { level: 9 } });

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", "attachment; filename=gtfs_export.zip");
    archive.pipe(res);

    // --- agency.txt (hardcoded from original GTFS) ---
    archive.append(
      'agency_id,agency_name,agency_url,agency_timezone,agency_lang,agency_phone,agency_fare_url,agency_email\n' +
      '"ATMA","Atma Scpa","https://www.atmaancona.it","Europe/Rome","it","0712837468","https://www.atmaancona.it/tariffe/tariffe-generale/","info@atmaancona.it"\n',
      { name: "agency.txt" }
    );

    // --- stops.txt ---
    const stops = await db.select().from(gtfsStops).where(eq(gtfsStops.feedId, feedId));
    let stopsCsv = "stop_id,stop_code,stop_name,stop_desc,stop_lat,stop_lon,wheelchair_boarding\n";
    for (const s of stops) {
      stopsCsv += `${s.stopId},${s.stopCode || ""},${csvEscape(s.stopName)},${csvEscape(s.stopDesc || "")},${s.stopLat},${s.stopLon},${s.wheelchairBoarding || 0}\n`;
    }
    archive.append(stopsCsv, { name: "stops.txt" });

    // --- routes.txt ---
    const routes = await db.select().from(gtfsRoutes).where(eq(gtfsRoutes.feedId, feedId));
    let routesCsv = "route_id,agency_id,route_short_name,route_long_name,route_type,route_url,route_color,route_text_color\n";
    for (const r of routes) {
      routesCsv += `${r.routeId},${r.agencyId || "ATMA"},${csvEscape(r.routeShortName || "")},${csvEscape(r.routeLongName || "")},${r.routeType || 3},${r.routeUrl || "https://www.atmaancona.it"},${r.routeColor || ""},${r.routeTextColor || ""}\n`;
    }
    archive.append(routesCsv, { name: "routes.txt" });

    // --- trips.txt ---
    const tripsAll = await db.select().from(gtfsTrips).where(eq(gtfsTrips.feedId, feedId));
    let tripsCsv = "route_id,service_id,trip_id,trip_headsign,direction_id,shape_id\n";
    for (const t of tripsAll) {
      tripsCsv += `${t.routeId},${t.serviceId},${t.tripId},${csvEscape(t.tripHeadsign || "")},${t.directionId || 0},${t.shapeId || ""}\n`;
    }
    archive.append(tripsCsv, { name: "trips.txt" });

    // --- stop_times.txt (with pickup_type and drop_off_type) ---
    // Process in batches to handle ~321k rows
    const batchSize = 50000;
    let offset = 0;
    let stCsv = "trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type\n";
    let hasMore = true;
    while (hasMore) {
      const batch = await db.execute<any>(sql`
        SELECT trip_id, arrival_time, departure_time, stop_id, stop_sequence, pickup_type, drop_off_type
        FROM gtfs_stop_times WHERE feed_id = ${feedId}
        ORDER BY trip_id, stop_sequence
        LIMIT ${batchSize} OFFSET ${offset}
      `);
      for (const st of batch.rows) {
        stCsv += `${st.trip_id},${st.arrival_time || ""},${st.departure_time || ""},${st.stop_id},${st.stop_sequence},${st.pickup_type ?? 0},${st.drop_off_type ?? 0}\n`;
      }
      offset += batchSize;
      hasMore = batch.rows.length === batchSize;
    }
    archive.append(stCsv, { name: "stop_times.txt" });

    // --- calendar.txt ---
    const calendars = await db.select().from(gtfsCalendar).where(eq(gtfsCalendar.feedId, feedId));
    let calCsv = "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n";
    for (const c of calendars) {
      calCsv += `${c.serviceId},${c.monday},${c.tuesday},${c.wednesday},${c.thursday},${c.friday},${c.saturday},${c.sunday},${c.startDate},${c.endDate}\n`;
    }
    archive.append(calCsv, { name: "calendar.txt" });

    // --- calendar_dates.txt ---
    const calDates = await db.select().from(gtfsCalendarDates).where(eq(gtfsCalendarDates.feedId, feedId));
    let cdCsv = "service_id,date,exception_type\n";
    for (const cd of calDates) {
      cdCsv += `${cd.serviceId},${cd.date},${cd.exceptionType}\n`;
    }
    archive.append(cdCsv, { name: "calendar_dates.txt" });

    // --- shapes.txt ---
    const shapes = await db.select().from(gtfsShapes).where(eq(gtfsShapes.feedId, feedId));
    let shapesCsv = "shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\n";
    for (const sh of shapes) {
      const geo = sh.geojson as any;
      // Handle both Feature and bare LineString formats
      const coords = geo?.geometry?.coordinates ?? geo?.coordinates ?? (geo?.type === "LineString" ? geo.coordinates : null);
      if (coords && Array.isArray(coords)) {
        for (let i = 0; i < coords.length; i++) {
          const [lon, lat] = coords[i];
          shapesCsv += `${sh.shapeId},${lat},${lon},${i}\n`;
        }
      }
    }
    archive.append(shapesCsv, { name: "shapes.txt" });

    // --- Fares V1 REMOVED — using only Fares V2 to avoid consumer confusion ---

    // --- Fares V2 files ---
    const networks = await db.select().from(gtfsFareNetworks).where(eq(gtfsFareNetworks.feedId, feedId));
    if (networks.length > 0) {
      let csv = "network_id,network_name\n";
      for (const n of networks) csv += `${n.networkId},${n.networkName}\n`;
      archive.append(csv, { name: "networks.txt" });
    }

    const routeNets = await db.select().from(gtfsRouteNetworks).where(eq(gtfsRouteNetworks.feedId, feedId));
    if (routeNets.length > 0) {
      let csv = "network_id,route_id\n";
      for (const rn of routeNets) csv += `${rn.networkId},${rn.routeId}\n`;
      archive.append(csv, { name: "route_networks.txt" });
    }

    const media = await db.select().from(gtfsFareMedia)
      .where(and(eq(gtfsFareMedia.feedId, feedId), eq(gtfsFareMedia.isActive, true)));
    if (media.length > 0) {
      let csv = "fare_media_id,fare_media_name,fare_media_type\n";
      for (const m of media) csv += `${m.fareMediaId},${m.fareMediaName},${m.fareMediaType}\n`;
      archive.append(csv, { name: "fare_media.txt" });
    }

    const cats = await db.select().from(gtfsRiderCategories).where(eq(gtfsRiderCategories.feedId, feedId));
    if (cats.length > 0) {
      let csv = "rider_category_id,rider_category_name,is_default_fare_category,eligibility_url\n";
      for (const c of cats) csv += `${c.riderCategoryId},${c.riderCategoryName},${c.isDefault ? 1 : 0},${c.eligibilityUrl || ""}\n`;
      archive.append(csv, { name: "rider_categories.txt" });
    }

    const prods = await db.select().from(gtfsFareProducts).where(eq(gtfsFareProducts.feedId, feedId));
    if (prods.length > 0) {
      let csv = "fare_product_id,fare_product_name,rider_category_id,fare_media_id,amount,currency\n";
      for (const p of prods) csv += `${p.fareProductId},${p.fareProductName},${p.riderCategoryId || ""},${p.fareMediaId || ""},${p.amount.toFixed(2)},${p.currency}\n`;
      archive.append(csv, { name: "fare_products.txt" });
    }

    const areas = await db.select().from(gtfsFareAreas).where(eq(gtfsFareAreas.feedId, feedId));
    if (areas.length > 0) {
      let csv = "area_id,area_name\n";
      for (const a of areas) csv += `${a.areaId},${a.areaName}\n`;
      archive.append(csv, { name: "areas.txt" });
    }

    const sa = await db.select().from(gtfsStopAreas).where(eq(gtfsStopAreas.feedId, feedId));
    if (sa.length > 0) {
      let csv = "area_id,stop_id\n";
      for (const s of sa) csv += `${s.areaId},${s.stopId}\n`;
      archive.append(csv, { name: "stop_areas.txt" });
    }

    const lr = await db.select().from(gtfsFareLegRules).where(eq(gtfsFareLegRules.feedId, feedId));
    if (lr.length > 0) {
      let csv = "leg_group_id,network_id,from_area_id,to_area_id,from_timeframe_group_id,to_timeframe_group_id,fare_product_id,rule_priority\n";
      for (const l of lr) csv += `${l.legGroupId},${l.networkId || ""},${l.fromAreaId || ""},${l.toAreaId || ""},${l.fromTimeframeGroupId || ""},${l.toTimeframeGroupId || ""},${l.fareProductId},${l.rulePriority}\n`;
      archive.append(csv, { name: "fare_leg_rules.txt" });
    }

    const xr = await db.select().from(gtfsFareTransferRules).where(eq(gtfsFareTransferRules.feedId, feedId));
    if (xr.length > 0) {
      let csv = "from_leg_group_id,to_leg_group_id,transfer_count,duration_limit,duration_limit_type,fare_transfer_type,fare_product_id\n";
      for (const x of xr) csv += `${x.fromLegGroupId || ""},${x.toLegGroupId || ""},${x.transferCount ?? ""},${x.durationLimit ?? ""},${x.durationLimitType ?? ""},${x.fareTransferType ?? ""},${x.fareProductId || ""}\n`;
      archive.append(csv, { name: "fare_transfer_rules.txt" });
    }

    const tf = await db.select().from(gtfsTimeframes).where(eq(gtfsTimeframes.feedId, feedId));
    if (tf.length > 0) {
      let csv = "timeframe_group_id,start_time,end_time,service_id\n";
      for (const t of tf) csv += `${t.timeframeGroupId},${t.startTime || ""},${t.endTime || ""},${t.serviceId || ""}\n`;
      archive.append(csv, { name: "timeframes.txt" });
    }

    // --- feed_info.txt ---
    const feedInfoRows = await db.select().from(gtfsFeedInfo).where(eq(gtfsFeedInfo.feedId, feedId));
    if (feedInfoRows.length > 0) {
      const fi = feedInfoRows[0];
      let fiCsv = "feed_publisher_name,feed_publisher_url,feed_lang,default_lang,feed_start_date,feed_end_date,feed_version,feed_contact_email,feed_contact_url\n";
      fiCsv += `${fi.feedPublisherName},${fi.feedPublisherUrl},${fi.feedLang},${fi.defaultLang || ""},${fi.feedStartDate || ""},${fi.feedEndDate || ""},${fi.feedVersion || ""},${fi.feedContactEmail || ""},${fi.feedContactUrl || ""}\n`;
      archive.append(fiCsv, { name: "feed_info.txt" });
    }

    await archive.finalize();
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

/** Escape a string for CSV (wraps in quotes if it contains commas, quotes, or newlines) */
function csvEscape(s: string): string {
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

// ═══════════════════════════════════════════════════════════
// STOPS CLASSIFICATION (Urbana=0, Extraurbana=1, Mista=2)
// ═══════════════════════════════════════════════════════════

/**
 * For each stop, determines whether it is served by:
 *   - Only urban routes → 0
 *   - Only extraurban routes → 1
 *   - Both → 2
 * Uses: stop_times → trips → routes → route_networks
 */
async function computeStopsClassification(feedId: string) {
  // 1. Get all stops
  const stops = await db.select({
    stopId: gtfsStops.stopId,
    stopCode: gtfsStops.stopCode,
    stopName: gtfsStops.stopName,
    stopLat: gtfsStops.stopLat,
    stopLon: gtfsStops.stopLon,
    wheelchairBoarding: gtfsStops.wheelchairBoarding,
  }).from(gtfsStops).where(eq(gtfsStops.feedId, feedId));

  // 2. Get route_networks classification map
  const assignments = await db.select().from(gtfsRouteNetworks).where(eq(gtfsRouteNetworks.feedId, feedId));
  const routeNetworkMap = new Map<string, string>();
  for (const a of assignments) {
    routeNetworkMap.set(a.routeId, a.networkId);
  }

  // 3. Raw SQL: for each stop, get distinct route IDs via stop_times → trips
  const stopRoutesQuery = await db.execute(sql`
    SELECT DISTINCT st.stop_id, t.route_id
    FROM gtfs_stop_times st
    JOIN gtfs_trips t ON t.feed_id = st.feed_id AND t.trip_id = st.trip_id
    WHERE st.feed_id = ${feedId}
  `);

  // Build map: stopId → Set<routeId>
  const stopRoutesMap = new Map<string, Set<string>>();
  for (const row of stopRoutesQuery.rows) {
    const stopId = row.stop_id as string;
    const routeId = row.route_id as string;
    if (!stopRoutesMap.has(stopId)) stopRoutesMap.set(stopId, new Set());
    stopRoutesMap.get(stopId)!.add(routeId);
  }

  // 4. Classify each stop
  return stops.map(s => {
    const routeIds = stopRoutesMap.get(s.stopId);
    if (!routeIds || routeIds.size === 0) {
      return { ...s, classification: 0, classLabel: "Urbana", routeCount: 0, urbanRoutes: 0, extraRoutes: 0 };
    }

    let urban = 0;
    let extra = 0;
    for (const rid of routeIds) {
      const net = routeNetworkMap.get(rid);
      if (net === "extraurbano") extra++;
      else urban++;
    }

    let classification: number;
    let classLabel: string;
    if (urban > 0 && extra > 0) { classification = 2; classLabel = "Mista"; }
    else if (extra > 0) { classification = 1; classLabel = "Extraurbana"; }
    else { classification = 0; classLabel = "Urbana"; }

    return {
      ...s,
      classification,
      classLabel,
      routeCount: routeIds.size,
      urbanRoutes: urban,
      extraRoutes: extra,
    };
  });
}

// GET /api/fares/stops-classification — JSON with classification data
router.get("/fares/stops-classification", async (_req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.json([]); return; }
    const result = await computeStopsClassification(feedId);
    res.json(result);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// GET /api/fares/stops-classification/export — stops.txt with extra stop_classification field
router.get("/fares/stops-classification/export", async (_req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.status(400).json({ error: "No GTFS feed" }); return; }
    const classified = await computeStopsClassification(feedId);

    // Build stops.txt with extended field
    let csv = "stop_id,stop_code,stop_name,stop_lat,stop_lon,wheelchair_boarding,stop_classification\n";
    for (const s of classified) {
      csv += `${s.stopId},${s.stopCode || ""},${csvEscape(s.stopName)},${s.stopLat},${s.stopLon},${s.wheelchairBoarding ?? 0},${s.classification}\n`;
    }

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="stops.txt"');
    res.send(csv);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// FARE ZONE CLUSTERS — cluster-based zoning (alternative to km-based)
// ═══════════════════════════════════════════════════════════

// GET /api/fares/zone-clusters — list all clusters
router.get("/fares/zone-clusters", async (_req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.json([]); return; }
    const clusters = await db.select().from(gtfsFareZoneClusters).where(eq(gtfsFareZoneClusters.feedId, feedId));
    // Also fetch stop counts
    const stopCounts = await db.execute<any>(sql`
      SELECT cluster_id, COUNT(*)::int AS cnt
      FROM gtfs_fare_zone_cluster_stops
      WHERE feed_id = ${feedId}
      GROUP BY cluster_id
    `);
    const countMap = new Map<string, number>();
    for (const r of stopCounts.rows) countMap.set(r.cluster_id, r.cnt);
    res.json(clusters.map(c => ({ ...c, stopCount: countMap.get(c.clusterId) || 0 })));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// POST /api/fares/zone-clusters — create or update a cluster
router.post("/fares/zone-clusters", async (req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.status(400).json({ error: "No GTFS feed" }); return; }
    const { clusterId, clusterName, polygon, color } = req.body;
    if (!clusterId || !clusterName) { res.status(400).json({ error: "clusterId and clusterName required" }); return; }

    // Calculate centroid from polygon or from stops
    let centroidLat: number | null = null;
    let centroidLon: number | null = null;
    if (polygon?.coordinates?.[0]) {
      const ring = polygon.coordinates[0] as number[][];
      centroidLon = ring.reduce((s, c) => s + c[0], 0) / ring.length;
      centroidLat = ring.reduce((s, c) => s + c[1], 0) / ring.length;
    }

    const [row] = await db.insert(gtfsFareZoneClusters).values({
      feedId, clusterId, clusterName,
      polygon: polygon || null,
      centroidLat, centroidLon,
      color: color || "#3b82f6",
    }).onConflictDoUpdate({
      target: [gtfsFareZoneClusters.feedId, gtfsFareZoneClusters.clusterId],
      set: { clusterName, polygon: polygon || null, centroidLat, centroidLon, color: color || "#3b82f6", updatedAt: sql`now()` },
    }).returning();
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// PUT /api/fares/zone-clusters/:id — update cluster
router.put("/fares/zone-clusters/:id", async (req, res): Promise<void> => {
  try {
    const { clusterName, polygon, color } = req.body;
    let centroidLat: number | null = null;
    let centroidLon: number | null = null;
    if (polygon?.coordinates?.[0]) {
      const ring = polygon.coordinates[0] as number[][];
      centroidLon = ring.reduce((s, c) => s + c[0], 0) / ring.length;
      centroidLat = ring.reduce((s, c) => s + c[1], 0) / ring.length;
    }
    const [row] = await db.update(gtfsFareZoneClusters)
      .set({ clusterName, polygon: polygon || null, centroidLat, centroidLon, color, updatedAt: sql`now()` })
      .where(eq(gtfsFareZoneClusters.id, req.params.id))
      .returning();
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/fares/zone-clusters/:id — delete cluster + its stops
router.delete("/fares/zone-clusters/:id", async (req, res): Promise<void> => {
  try {
    // Get the cluster to find its clusterId for stop cleanup
    const [cluster] = await db.select().from(gtfsFareZoneClusters).where(eq(gtfsFareZoneClusters.id, req.params.id));
    if (cluster) {
      await db.delete(gtfsFareZoneClusterStops).where(
        and(eq(gtfsFareZoneClusterStops.feedId, cluster.feedId!), eq(gtfsFareZoneClusterStops.clusterId, cluster.clusterId))
      );
    }
    await db.delete(gtfsFareZoneClusters).where(eq(gtfsFareZoneClusters.id, req.params.id));
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// GET /api/fares/zone-clusters/:clusterId/stops — get stops for a cluster
router.get("/fares/zone-clusters/:clusterId/stops", async (req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.json([]); return; }
    const rows = await db.select().from(gtfsFareZoneClusterStops)
      .where(and(eq(gtfsFareZoneClusterStops.feedId, feedId), eq(gtfsFareZoneClusterStops.clusterId, req.params.clusterId)));
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// POST /api/fares/zone-clusters/:clusterId/stops — set stops for a cluster (replace all)
// ENFORCES PARTITION: each stop can belong to only one cluster
router.post("/fares/zone-clusters/:clusterId/stops", async (req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.status(400).json({ error: "No GTFS feed" }); return; }
    const { stops } = req.body as { stops: { stopId: string; stopName: string; stopLat: number; stopLon: number }[] };
    if (!Array.isArray(stops)) { res.status(400).json({ error: "stops array required" }); return; }

    const cid = req.params.clusterId;
    const stopIds = stops.map(s => s.stopId);

    // 1. Remove these stops from ANY other cluster (partition rule)
    if (stopIds.length > 0) {
      await db.delete(gtfsFareZoneClusterStops).where(
        and(
          eq(gtfsFareZoneClusterStops.feedId, feedId),
          inArray(gtfsFareZoneClusterStops.stopId, stopIds),
        )
      );
    }

    // 2. Delete existing stops for this cluster (handles stops removed from this cluster)
    await db.delete(gtfsFareZoneClusterStops).where(
      and(eq(gtfsFareZoneClusterStops.feedId, feedId), eq(gtfsFareZoneClusterStops.clusterId, cid))
    );

    // 3. Insert new stops for this cluster
    if (stops.length > 0) {
      await db.insert(gtfsFareZoneClusterStops).values(
        stops.map(s => ({ feedId, clusterId: cid, stopId: s.stopId, stopName: s.stopName, stopLat: s.stopLat, stopLon: s.stopLon }))
      );
    }

    // 4. Recalculate centroid from stops
    if (stops.length > 0) {
      const avgLat = stops.reduce((s, st) => s + st.stopLat, 0) / stops.length;
      const avgLon = stops.reduce((s, st) => s + st.stopLon, 0) / stops.length;
      await db.update(gtfsFareZoneClusters)
        .set({ centroidLat: avgLat, centroidLon: avgLon, updatedAt: sql`now()` })
        .where(and(eq(gtfsFareZoneClusters.feedId, feedId), eq(gtfsFareZoneClusters.clusterId, cid)));
    }

    // 5. Recalculate stop counts for ALL clusters (since we may have removed stops from others)
    const allStopCounts = await db.execute(sql`
      SELECT cluster_id, COUNT(*)::int AS cnt
      FROM gtfs_fare_zone_cluster_stops
      WHERE feed_id = ${feedId}
      GROUP BY cluster_id
    `);
    // Update centroids for affected clusters too
    for (const row of allStopCounts.rows as any[]) {
      if (row.cluster_id !== cid) {
        const clStops = await db.select().from(gtfsFareZoneClusterStops)
          .where(and(eq(gtfsFareZoneClusterStops.feedId, feedId), eq(gtfsFareZoneClusterStops.clusterId, row.cluster_id)));
        if (clStops.length > 0) {
          const aLat = clStops.reduce((s, st) => s + (st.stopLat || 0), 0) / clStops.length;
          const aLon = clStops.reduce((s, st) => s + (st.stopLon || 0), 0) / clStops.length;
          await db.update(gtfsFareZoneClusters)
            .set({ centroidLat: aLat, centroidLon: aLon, updatedAt: sql`now()` })
            .where(and(eq(gtfsFareZoneClusters.feedId, feedId), eq(gtfsFareZoneClusters.clusterId, row.cluster_id)));
        }
      }
    }

    res.json({ ok: true, stops: stops.length });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// GET /api/fares/zone-clusters/full — returns all clusters with ALL their stops in one call
router.get("/fares/zone-clusters/full", async (_req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.json({ clusters: [], allStops: [] }); return; }
    const clusters = await db.select().from(gtfsFareZoneClusters).where(eq(gtfsFareZoneClusters.feedId, feedId)).orderBy(gtfsFareZoneClusters.clusterName);
    const allClusterStops = await db.select().from(gtfsFareZoneClusterStops).where(eq(gtfsFareZoneClusterStops.feedId, feedId));

    // Group stops by clusterId
    const stopsByCluster = new Map<string, typeof allClusterStops>();
    for (const s of allClusterStops) {
      const arr = stopsByCluster.get(s.clusterId) || [];
      arr.push(s);
      stopsByCluster.set(s.clusterId, arr);
    }

    const result = clusters.map(c => ({
      ...c,
      stopCount: stopsByCluster.get(c.clusterId)?.length || 0,
      stops: (stopsByCluster.get(c.clusterId) || []).map(s => ({
        stopId: s.stopId, stopName: s.stopName, stopLat: s.stopLat, stopLon: s.stopLon,
      })),
    }));

    res.json(result);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// GET /api/fares/zone-clusters/distance-matrix — centroid-to-centroid distance matrix
router.get("/fares/zone-clusters/distance-matrix", async (_req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.json({ clusters: [], matrix: [] }); return; }
    const clusters = await db.select().from(gtfsFareZoneClusters).where(eq(gtfsFareZoneClusters.feedId, feedId));
    const valid = clusters.filter(c => c.centroidLat != null && c.centroidLon != null);

    const matrix: { from: string; to: string; distanceKm: number; fascia: number | null }[] = [];
    for (let i = 0; i < valid.length; i++) {
      for (let j = 0; j < valid.length; j++) {
        if (i === j) continue;
        const dist = haversineKm(valid[i].centroidLat!, valid[i].centroidLon!, valid[j].centroidLat!, valid[j].centroidLon!);
        const band = getBandForDistance(dist);
        matrix.push({
          from: valid[i].clusterId,
          to: valid[j].clusterId,
          distanceKm: Math.round(dist * 100) / 100,
          fascia: band ? band.fascia : null,
        });
      }
    }

    res.json({ clusters: valid.map(c => ({ clusterId: c.clusterId, clusterName: c.clusterName, centroidLat: c.centroidLat, centroidLon: c.centroidLon })), matrix });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// POST /api/fares/zone-clusters/generate-zones — generate areas + stop_areas + leg_rules from clusters
router.post("/fares/zone-clusters/generate-zones", async (_req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.status(400).json({ error: "No GTFS feed" }); return; }

    const clusters = await db.select().from(gtfsFareZoneClusters).where(eq(gtfsFareZoneClusters.feedId, feedId));
    if (clusters.length === 0) { res.status(400).json({ error: "No clusters defined" }); return; }

    // 1) Delete existing extraurban areas, stop_areas, and leg_rules (only extraurban — keep urban)
    const existingExtraAreas = await db.select().from(gtfsFareAreas)
      .where(and(eq(gtfsFareAreas.feedId, feedId), eq(gtfsFareAreas.networkId, "extraurbano")));
    if (existingExtraAreas.length > 0) {
      const areaIds = existingExtraAreas.map(a => a.areaId);
      await db.delete(gtfsStopAreas).where(and(eq(gtfsStopAreas.feedId, feedId), inArray(gtfsStopAreas.areaId, areaIds)));
      await db.delete(gtfsFareAreas).where(and(eq(gtfsFareAreas.feedId, feedId), eq(gtfsFareAreas.networkId, "extraurbano")));
    }
    // Delete existing extraurban leg rules
    await db.delete(gtfsFareLegRules).where(
      and(eq(gtfsFareLegRules.feedId, feedId), eq(gtfsFareLegRules.networkId, "extraurbano"))
    );

    // 2) Create one area per cluster
    let areasCreated = 0;
    for (const c of clusters) {
      await db.insert(gtfsFareAreas).values({
        feedId,
        areaId: `cluster_${c.clusterId}`,
        areaName: c.clusterName,
        networkId: "extraurbano",
      }).onConflictDoUpdate({
        target: [gtfsFareAreas.feedId, gtfsFareAreas.areaId],
        set: { areaName: c.clusterName, updatedAt: sql`now()` },
      });
      areasCreated++;
    }

    // 3) Assign cluster stops to areas
    let stopsAssigned = 0;
    for (const c of clusters) {
      const cStops = await db.select().from(gtfsFareZoneClusterStops)
        .where(and(eq(gtfsFareZoneClusterStops.feedId, feedId), eq(gtfsFareZoneClusterStops.clusterId, c.clusterId)));
      for (const s of cStops) {
        await db.insert(gtfsStopAreas).values({
          feedId, areaId: `cluster_${c.clusterId}`, stopId: s.stopId,
        }).onConflictDoNothing();
        stopsAssigned++;
      }
    }

    // 4) Generate OD leg rules based on centroid distances
    const validClusters = clusters.filter(c => c.centroidLat != null && c.centroidLon != null);
    let odRules = 0;
    for (let i = 0; i < validClusters.length; i++) {
      for (let j = 0; j < validClusters.length; j++) {
        if (i === j) continue;
        const dist = haversineKm(validClusters[i].centroidLat!, validClusters[i].centroidLon!, validClusters[j].centroidLat!, validClusters[j].centroidLon!);
        const band = getBandForDistance(dist);
        if (!band) continue;
        await db.insert(gtfsFareLegRules).values({
          feedId,
          legGroupId: "lg_extra_cluster",
          networkId: "extraurbano",
          fromAreaId: `cluster_${validClusters[i].clusterId}`,
          toAreaId: `cluster_${validClusters[j].clusterId}`,
          fareProductId: `extra_fascia_${band.fascia}`,
          rulePriority: 0,
        });
        odRules++;
      }
    }

    res.json({ areasCreated, stopsAssigned, odRules, totalClusters: clusters.length });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// AUTO-GENERATE CLUSTERS from extraurban route data
// ═══════════════════════════════════════════════════════════

// Shared color palette for auto-generated clusters
const AUTO_CLUSTER_COLORS = [
  "#ef4444", "#f97316", "#eab308", "#22c55e", "#06b6d4", "#3b82f6", "#8b5cf6",
  "#ec4899", "#14b8a6", "#f59e0b", "#6366f1", "#d946ef", "#84cc16", "#0ea5e9",
];

type AutoStop = { stop_id: string; stop_name: string; lat: number; lon: number };

/** Fetch all extraurban stops for the given feed */
async function fetchExtraStops(feedId: string): Promise<AutoStop[]> {
  const r = await db.execute<any>(sql`
    SELECT DISTINCT s.stop_id, s.stop_name, s.stop_lat::float AS lat, s.stop_lon::float AS lon
    FROM gtfs_stops s
    JOIN gtfs_stop_times st ON st.stop_id = s.stop_id AND st.feed_id = s.feed_id
    JOIN gtfs_trips t ON t.trip_id = st.trip_id AND t.feed_id = s.feed_id
    JOIN gtfs_route_networks rn ON rn.route_id = t.route_id AND rn.feed_id = t.feed_id
    WHERE s.feed_id = ${feedId} AND rn.network_id = 'extraurbano'
    ORDER BY s.stop_name
  `);
  return r.rows as AutoStop[];
}

/** Delete all clusters + stops for a feed, then persist the given cluster→stops mapping */
async function persistClusters(
  feedId: string,
  clusterDefs: { clusterId: string; clusterName: string; color: string; stops: AutoStop[] }[],
) {
  await db.delete(gtfsFareZoneClusterStops).where(eq(gtfsFareZoneClusterStops.feedId, feedId));
  await db.delete(gtfsFareZoneClusters).where(eq(gtfsFareZoneClusters.feedId, feedId));

  let clustersCreated = 0;
  let totalStopsAssigned = 0;

  for (const def of clusterDefs) {
    if (def.stops.length === 0) continue;
    const cLat = def.stops.reduce((s, st) => s + st.lat, 0) / def.stops.length;
    const cLon = def.stops.reduce((s, st) => s + st.lon, 0) / def.stops.length;

    await db.insert(gtfsFareZoneClusters).values({
      feedId, clusterId: def.clusterId, clusterName: def.clusterName,
      polygon: null, centroidLat: cLat, centroidLon: cLon, color: def.color,
    }).onConflictDoUpdate({
      target: [gtfsFareZoneClusters.feedId, gtfsFareZoneClusters.clusterId],
      set: { clusterName: def.clusterName, centroidLat: cLat, centroidLon: cLon, color: def.color, updatedAt: sql`now()` },
    });

    const batchSize = 500;
    for (let b = 0; b < def.stops.length; b += batchSize) {
      const batch = def.stops.slice(b, b + batchSize);
      await db.insert(gtfsFareZoneClusterStops).values(
        batch.map(s => ({ feedId, clusterId: def.clusterId, stopId: s.stop_id, stopName: s.stop_name, stopLat: s.lat, stopLon: s.lon }))
      );
    }

    clustersCreated++;
    totalStopsAssigned += def.stops.length;
  }
  return { clustersCreated, totalStopsAssigned };
}

// ─── K-Means implementation (geographic, haversine-based) ───
function kMeansSpatial(stops: AutoStop[], k: number, maxIter = 40): { centroid: { lat: number; lon: number }; stops: AutoStop[] }[] {
  // Initialize centroids using k-means++ for better spread
  const centroids: { lat: number; lon: number }[] = [];
  // Pick first centroid randomly
  centroids.push({ lat: stops[Math.floor(Math.random() * stops.length)].lat, lon: stops[Math.floor(Math.random() * stops.length)].lon });

  for (let c = 1; c < k; c++) {
    // For each stop, compute distance to nearest existing centroid
    const dists = stops.map(s => {
      let minD = Infinity;
      for (const ctr of centroids) {
        const d = haversineKm(s.lat, s.lon, ctr.lat, ctr.lon);
        if (d < minD) minD = d;
      }
      return minD * minD; // square for probability weighting
    });
    const totalDist = dists.reduce((a, b) => a + b, 0);
    // Weighted random pick
    let r = Math.random() * totalDist;
    for (let i = 0; i < dists.length; i++) {
      r -= dists[i];
      if (r <= 0) { centroids.push({ lat: stops[i].lat, lon: stops[i].lon }); break; }
    }
    if (centroids.length === c) centroids.push({ lat: stops[Math.floor(Math.random() * stops.length)].lat, lon: stops[Math.floor(Math.random() * stops.length)].lon });
  }

  let assignments = new Int32Array(stops.length);

  for (let iter = 0; iter < maxIter; iter++) {
    // Assign each stop to nearest centroid
    let changed = false;
    for (let i = 0; i < stops.length; i++) {
      let bestC = 0, bestD = Infinity;
      for (let c = 0; c < centroids.length; c++) {
        const d = haversineKm(stops[i].lat, stops[i].lon, centroids[c].lat, centroids[c].lon);
        if (d < bestD) { bestD = d; bestC = c; }
      }
      if (assignments[i] !== bestC) { assignments[i] = bestC; changed = true; }
    }
    if (!changed) break;

    // Recalculate centroids
    for (let c = 0; c < centroids.length; c++) {
      let sumLat = 0, sumLon = 0, cnt = 0;
      for (let i = 0; i < stops.length; i++) {
        if (assignments[i] === c) { sumLat += stops[i].lat; sumLon += stops[i].lon; cnt++; }
      }
      if (cnt > 0) { centroids[c] = { lat: sumLat / cnt, lon: sumLon / cnt }; }
    }
  }

  // Group
  const groups: { centroid: { lat: number; lon: number }; stops: AutoStop[] }[] = centroids.map(c => ({ centroid: c, stops: [] }));
  for (let i = 0; i < stops.length; i++) groups[assignments[i]].stops.push(stops[i]);
  return groups.filter(g => g.stops.length > 0);
}

/**
 * POST /api/fares/zone-clusters/auto-generate
 *
 * Body: { mode?: "concentric" | "spatial", k?: number }
 *
 * mode="concentric" (default): concentric rings from geographic centroid using EXTRA_BANDS
 * mode="spatial": k-means clustering that finds natural stop density groupings
 *   k = number of clusters (default: auto-calculated from geographic spread)
 */
router.post("/fares/zone-clusters/auto-generate", async (req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.status(400).json({ error: "No GTFS feed" }); return; }

    const mode: string = req.body?.mode || "concentric";
    const stops = await fetchExtraStops(feedId);
    if (stops.length === 0) { res.status(400).json({ error: "Nessuna fermata extraurbana trovata" }); return; }

    if (mode === "spatial") {
      // ─── SPATIAL MODE: k-means on geographic coordinates ───
      // Determine k: if user provided, use it; otherwise auto-calculate
      // Heuristic: find geographic bounding box, divide area into ~6km cells
      let k: number = req.body?.k ? Number(req.body.k) : 0;
      if (!k || k < 2) {
        const minLat = Math.min(...stops.map(s => s.lat));
        const maxLat = Math.max(...stops.map(s => s.lat));
        const minLon = Math.min(...stops.map(s => s.lon));
        const maxLon = Math.max(...stops.map(s => s.lon));
        const spanKmLat = haversineKm(minLat, minLon, maxLat, minLon);
        const spanKmLon = haversineKm(minLat, minLon, minLat, maxLon);
        // ~8km grid → k = area / (8*8)
        const area = spanKmLat * spanKmLon;
        k = Math.max(4, Math.min(25, Math.round(area / 64)));
      }
      k = Math.min(k, Math.floor(stops.length / 3)); // at least 3 stops per cluster

      const groups = kMeansSpatial(stops, k);

      // Sort groups by centroid latitude (north to south) for consistent naming
      groups.sort((a, b) => b.centroid.lat - a.centroid.lat);

      // Name clusters by the most central stop (closest to centroid)
      const clusterDefs = groups.map((g, idx) => {
        const centralStop = g.stops.reduce((best, s) => {
          const d = haversineKm(s.lat, s.lon, g.centroid.lat, g.centroid.lon);
          return d < best.d ? { s, d } : best;
        }, { s: g.stops[0], d: Infinity }).s;

        // Clean up name: use the central stop's locality
        const baseName = centralStop.stop_name.replace(/\s*[-–(].*/g, "").trim();
        return {
          clusterId: `area_${idx + 1}`,
          clusterName: `${baseName} (${g.stops.length})`,
          color: AUTO_CLUSTER_COLORS[idx % AUTO_CLUSTER_COLORS.length],
          stops: g.stops,
        };
      });

      const { clustersCreated, totalStopsAssigned } = await persistClusters(feedId, clusterDefs);

      res.json({
        ok: true, mode: "spatial",
        clustersCreated, totalStopsAssigned, totalExtraStops: stops.length, k,
        clusters: clusterDefs.map(d => ({ id: d.clusterId, name: d.clusterName, stops: d.stops.length })),
      });

    } else {
      // ─── CONCENTRIC MODE: rings from geographic centroid ───
      const centerLat = stops.reduce((sum, s) => sum + s.lat, 0) / stops.length;
      const centerLon = stops.reduce((sum, s) => sum + s.lon, 0) / stops.length;

      const stopsWithDist = stops.map(s => ({
        ...s,
        distKm: haversineKm(centerLat, centerLon, s.lat, s.lon),
      }));

      const rings = new Map<number, typeof stopsWithDist>();
      for (const s of stopsWithDist) {
        const band = getBandForDistance(s.distKm);
        const fascia = band ? band.fascia : (s.distKm === 0 ? 1 : EXTRA_BANDS[EXTRA_BANDS.length - 1].fascia);
        if (!rings.has(fascia)) rings.set(fascia, []);
        rings.get(fascia)!.push(s);
      }

      const sortedFasce = Array.from(rings.keys()).sort((a, b) => a - b);

      const clusterDefs = sortedFasce.filter(f => (rings.get(f)?.length || 0) > 0).map((fascia, idx) => {
        const band = EXTRA_BANDS[fascia - 1];
        return {
          clusterId: `zona_${fascia}`,
          clusterName: `Zona ${fascia} (${band.kmFrom}-${band.kmTo} km)`,
          color: AUTO_CLUSTER_COLORS[idx % AUTO_CLUSTER_COLORS.length],
          stops: rings.get(fascia)!,
        };
      });

      const { clustersCreated, totalStopsAssigned } = await persistClusters(feedId, clusterDefs);

      res.json({
        ok: true, mode: "concentric",
        clustersCreated, totalStopsAssigned, totalExtraStops: stops.length,
        center: { lat: centerLat, lon: centerLon },
        rings: sortedFasce.map(f => ({
          fascia: f, kmFrom: EXTRA_BANDS[f - 1].kmFrom, kmTo: EXTRA_BANDS[f - 1].kmTo, stops: rings.get(f)!.length,
        })),
      });
    }
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// GET /api/fares/extraurban-stops — all stops served by extraurban routes (for cluster assignment)
router.get("/fares/extraurban-stops", async (_req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.json([]); return; }
    const rows = await db.execute<any>(sql`
      SELECT DISTINCT s.stop_id, s.stop_name, s.stop_lat::float AS lat, s.stop_lon::float AS lon
      FROM gtfs_stops s
      JOIN gtfs_stop_times st ON st.stop_id = s.stop_id AND st.feed_id = s.feed_id
      JOIN gtfs_trips t ON t.trip_id = st.trip_id AND t.feed_id = s.feed_id
      JOIN gtfs_route_networks rn ON rn.route_id = t.route_id AND rn.feed_id = t.feed_id
      WHERE s.feed_id = ${feedId} AND rn.network_id = 'extraurbano'
      ORDER BY s.stop_name
    `);
    res.json(rows.rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// BUG FIX: Deduplicate stop_areas
// ═══════════════════════════════════════════════════════════
router.post("/fares/stop-areas/deduplicate", async (_req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.status(400).json({ error: "No GTFS feed" }); return; }
    const result = await db.execute<any>(sql`
      DELETE FROM gtfs_stop_areas
      WHERE id NOT IN (
        SELECT DISTINCT ON (feed_id, area_id, stop_id) id
        FROM gtfs_stop_areas
        WHERE feed_id = ${feedId}
        ORDER BY feed_id, area_id, stop_id, created_at ASC
      ) AND feed_id = ${feedId}
    `);
    const deleted = result.rowCount ?? 0;
    const remaining = await db.select({ count: sql<number>`count(*)` }).from(gtfsStopAreas).where(eq(gtfsStopAreas.feedId, feedId));
    res.json({ deleted, remaining: Number(remaining[0]?.count ?? 0) });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// BUG FIX: Set fare_media_id = NULL on existing products
// ═══════════════════════════════════════════════════════════
router.post("/fares/products/fix-media", async (_req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.status(400).json({ error: "No GTFS feed" }); return; }
    const result = await db.execute<any>(sql`
      UPDATE gtfs_fare_products
      SET fare_media_id = NULL
      WHERE feed_id = ${feedId} AND fare_media_id IS NOT NULL
    `);
    res.json({ updated: result.rowCount ?? 0 });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// FEED INFO — CRUD
// ═══════════════════════════════════════════════════════════
router.get("/fares/feed-info", async (_req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.json(null); return; }
    const rows = await db.select().from(gtfsFeedInfo).where(eq(gtfsFeedInfo.feedId, feedId));
    res.json(rows[0] ?? null);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/fares/feed-info", async (req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.status(400).json({ error: "No GTFS feed" }); return; }
    const { feedPublisherName, feedPublisherUrl, feedLang, defaultLang, feedStartDate, feedEndDate, feedVersion, feedContactEmail, feedContactUrl } = req.body;
    // Upsert: delete existing + insert
    await db.delete(gtfsFeedInfo).where(eq(gtfsFeedInfo.feedId, feedId));
    const [row] = await db.insert(gtfsFeedInfo).values({
      feedId,
      feedPublisherName: feedPublisherName || "ATMA Scpa",
      feedPublisherUrl: feedPublisherUrl || "https://www.atmaancona.it",
      feedLang: feedLang || "it",
      defaultLang: defaultLang || null,
      feedStartDate: feedStartDate || null,
      feedEndDate: feedEndDate || null,
      feedVersion: feedVersion || null,
      feedContactEmail: feedContactEmail || null,
      feedContactUrl: feedContactUrl || null,
    }).returning();
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// VALIDATE — pre-export checklist
// ═══════════════════════════════════════════════════════════
router.get("/fares/validate", async (_req, res): Promise<void> => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.status(400).json({ error: "No GTFS feed" }); return; }

    const checks: { id: string; label: string; ok: boolean; detail?: string }[] = [];

    // 1. Networks exist
    const networks = await db.select({ count: sql<number>`count(*)` }).from(gtfsFareNetworks).where(eq(gtfsFareNetworks.feedId, feedId));
    const netCount = Number(networks[0]?.count ?? 0);
    checks.push({ id: "networks", label: "Reti tariffarie definite", ok: netCount >= 1, detail: `${netCount} reti` });

    // 2. All routes classified
    const allRoutes = await db.select({ count: sql<number>`count(*)` }).from(gtfsRoutes).where(eq(gtfsRoutes.feedId, feedId));
    const classifiedRoutes = await db.select({ count: sql<number>`count(*)` }).from(gtfsRouteNetworks).where(eq(gtfsRouteNetworks.feedId, feedId));
    const totalR = Number(allRoutes[0]?.count ?? 0);
    const classR = Number(classifiedRoutes[0]?.count ?? 0);
    checks.push({ id: "routes_classified", label: "Linee classificate", ok: classR >= totalR, detail: `${classR}/${totalR}` });

    // 3. Products exist
    const prods = await db.select({ count: sql<number>`count(*)` }).from(gtfsFareProducts).where(eq(gtfsFareProducts.feedId, feedId));
    const prodCount = Number(prods[0]?.count ?? 0);
    checks.push({ id: "products", label: "Prodotti tariffari", ok: prodCount > 0, detail: `${prodCount} prodotti` });

    // 4. No products with fare_media_id set
    const prodsWithMedia = await db.select({ count: sql<number>`count(*)` }).from(gtfsFareProducts)
      .where(and(eq(gtfsFareProducts.feedId, feedId), sql`fare_media_id IS NOT NULL`));
    const mediaCount = Number(prodsWithMedia[0]?.count ?? 0);
    checks.push({ id: "products_media_null", label: "Prodotti senza fare_media_id forzato", ok: mediaCount === 0, detail: mediaCount > 0 ? `${mediaCount} prodotti hanno fare_media_id ≠ NULL` : "OK" });

    // 5. Areas exist
    const areasCount = await db.select({ count: sql<number>`count(*)` }).from(gtfsFareAreas).where(eq(gtfsFareAreas.feedId, feedId));
    const ac = Number(areasCount[0]?.count ?? 0);
    checks.push({ id: "areas", label: "Aree tariffarie", ok: ac > 0, detail: `${ac} aree` });

    // 6. Stop areas — no duplicates
    const saTotal = await db.select({ count: sql<number>`count(*)` }).from(gtfsStopAreas).where(eq(gtfsStopAreas.feedId, feedId));
    const saUnique = await db.execute<any>(sql`
      SELECT count(*) AS cnt FROM (SELECT DISTINCT feed_id, area_id, stop_id FROM gtfs_stop_areas WHERE feed_id = ${feedId}) t
    `);
    const tot = Number(saTotal[0]?.count ?? 0);
    const uniq = Number(saUnique.rows[0]?.cnt ?? 0);
    checks.push({ id: "stop_areas_no_dups", label: "Stop-areas senza duplicati", ok: tot === uniq, detail: tot !== uniq ? `${tot - uniq} duplicati` : `${tot} assegnazioni` });

    // 7. Leg rules exist
    const lrCount = await db.select({ count: sql<number>`count(*)` }).from(gtfsFareLegRules).where(eq(gtfsFareLegRules.feedId, feedId));
    const lrc = Number(lrCount[0]?.count ?? 0);
    checks.push({ id: "leg_rules", label: "Regole di tratta (leg rules)", ok: lrc > 0, detail: `${lrc} regole` });

    // 8. Urban rules have priority > 0
    const urbanP0 = await db.execute<any>(sql`
      SELECT count(*) AS cnt FROM gtfs_fare_leg_rules
      WHERE feed_id = ${feedId} AND network_id IN ('urbano_ancona','urbano_jesi','urbano_falconara') AND rule_priority = 0
    `);
    const up0 = Number(urbanP0.rows[0]?.cnt ?? 0);
    checks.push({ id: "urban_priority", label: "Priorità regole urbane > 0", ok: up0 === 0, detail: up0 > 0 ? `${up0} regole urbane con priority=0` : "OK" });

    // 9. Calendar entries
    const calCount = await db.select({ count: sql<number>`count(*)` }).from(gtfsCalendar).where(eq(gtfsCalendar.feedId, feedId));
    const cc = Number(calCount[0]?.count ?? 0);
    checks.push({ id: "calendar", label: "Calendario servizio", ok: cc > 0, detail: `${cc} entry` });

    // 10. Feed info exists
    const fiCount = await db.select({ count: sql<number>`count(*)` }).from(gtfsFeedInfo).where(eq(gtfsFeedInfo.feedId, feedId));
    const fic = Number(fiCount[0]?.count ?? 0);
    checks.push({ id: "feed_info", label: "Feed info compilato", ok: fic > 0, detail: fic > 0 ? "Presente" : "Mancante" });

    const allOk = checks.every(c => c.ok);
    res.json({ ok: allOk, checks });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
