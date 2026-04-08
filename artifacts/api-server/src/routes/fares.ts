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
 * DELETE /api/fares/rider-categories/:id     — delete
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
  gtfsFareNetworks, gtfsRouteNetworks, gtfsFareMedia, gtfsRiderCategories,
  gtfsFareProducts, gtfsFareAreas, gtfsStopAreas, gtfsFareLegRules, gtfsFareTransferRules,
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
        fareMediaId: "carta_contactless",
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
      await db.insert(gtfsFareLegRules).values({ feedId, ...r, rulePriority: 0 });
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
      legCsv += `${lr.legGroupId},${lr.networkId || ""},${lr.fromAreaId || ""},${lr.toAreaId || ""},,,${lr.fareProductId},${lr.rulePriority}\n`;
    }

    // --- fare_transfer_rules.txt ---
    const xferRules = await db.select().from(gtfsFareTransferRules).where(eq(gtfsFareTransferRules.feedId, feedId));
    let xferCsv = "from_leg_group_id,to_leg_group_id,transfer_count,duration_limit,duration_limit_type,fare_transfer_type,fare_product_id\n";
    for (const xr of xferRules) {
      xferCsv += `${xr.fromLegGroupId || ""},${xr.toLegGroupId || ""},${xr.transferCount ?? ""},${xr.durationLimit ?? ""},${xr.durationLimitType ?? ""},${xr.fareTransferType ?? ""},${xr.fareProductId || ""}\n`;
    }

    // Validation summary
    const routeCount = routeNets.length;
    const allRoutes = await db.select().from(gtfsRoutes).where(eq(gtfsRoutes.feedId, feedId));
    const missingRoutes = allRoutes.filter(r => !routeNets.find(rn => rn.routeId === r.routeId));

    res.json({
      files: {
        "networks.txt": networksCsv,
        "route_networks.txt": routeNetCsv,
        "fare_media.txt": mediaCsv,
        "rider_categories.txt": catCsv,
        "fare_products.txt": prodCsv,
        "areas.txt": areasCsv,
        "stop_areas.txt": stopAreasCsv,
        "fare_leg_rules.txt": legCsv,
        "fare_transfer_rules.txt": xferCsv,
      },
      validation: {
        routesClassified: routeCount,
        totalRoutes: allRoutes.length,
        missingRoutes: missingRoutes.map(r => r.routeId),
        products: products.length,
        areas: areas.length,
        stopAreaAssignments: stopAreas.length,
        legRules: legRules.length,
        transferRules: xferRules.length,
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

export default router;
