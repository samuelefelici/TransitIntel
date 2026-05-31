/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SCHEMA `caronte` — ingestione + metriche (read-write)
 * ───────────────────────────────────────────────────────────────────────────
 * Endpoint alimentati da AVM (posizioni veicolo) e dal validatore iPhone
 * (tap NFC IN/OUT, viaggi con prezzo atteso vs addebitato). Tutto vive nello
 * schema dedicato `caronte`, separato dai gtfs_* (sola lettura dal gestionale).
 *
 *   POST /api/caronte/tap-events          — ingest singola timbrata NFC
 *   POST /api/caronte/vehicle-positions   — ingest posizione mezzo da AVM
 *   POST /api/caronte/journeys            — registra viaggio (IN→OUT) + verifica prezzo
 *   GET  /api/caronte/onboard?tripId=     — saldo persone a bordo (IN − OUT) per corsa
 *   GET  /api/caronte/stop-flows?tripId=  — salite/discese per fermata
 *   GET  /api/caronte/revenue             — fatturato (somma charged/expected)
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { carontetapEvents, carontejourneys, carontevehiclePositions } from "@workspace/db/schema";
import { sql } from "drizzle-orm";

const router: IRouter = Router();

// POST /api/caronte/tap-events — ogni timbrata NFC (tap-IN / tap-OUT)
router.post("/caronte/tap-events", async (req, res): Promise<void> => {
  try {
    const b = req.body ?? {};
    if (!b.deviceId || (b.direction !== "in" && b.direction !== "out")) {
      res.status(400).json({ error: "deviceId e direction ('in'|'out') richiesti" });
      return;
    }
    const [row] = await db.insert(carontetapEvents).values({
      deviceId:  b.deviceId,
      vehicleId: b.vehicleId ?? null,
      tripId:    b.tripId ?? null,
      routeId:   b.routeId ?? null,
      direction: b.direction,
      stopId:    b.stopId ?? null,
      clusterId: b.clusterId ?? null,
      stopSeq:   b.stopSeq ?? null,
      ticketUid: b.ticketUid ?? null,
      ts:        b.ts ? new Date(b.ts) : undefined,
      lat:       b.lat ?? null,
      lon:       b.lon ?? null,
      rawNfc:    b.rawNfc ?? null,
    }).returning();
    res.status(201).json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// POST /api/caronte/vehicle-positions — traccia posizione mezzo (da AVM)
router.post("/caronte/vehicle-positions", async (req, res): Promise<void> => {
  try {
    const b = req.body ?? {};
    if (typeof b.lat !== "number" || typeof b.lon !== "number") {
      res.status(400).json({ error: "lat e lon numerici richiesti" });
      return;
    }
    const [row] = await db.insert(carontevehiclePositions).values({
      vehicleId:     b.vehicleId ?? null,
      tripId:        b.tripId ?? null,
      ts:            b.ts ? new Date(b.ts) : undefined,
      lat:           b.lat,
      lon:           b.lon,
      nearestStopId: b.nearestStopId ?? null,
      speed:         b.speed ?? null,
    }).returning();
    res.status(201).json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// POST /api/caronte/journeys — viaggio IN→OUT con verifica prezzo (oracolo vs addebitato)
router.post("/caronte/journeys", async (req, res): Promise<void> => {
  try {
    const b = req.body ?? {};
    // price_match calcolato lato server se entrambi i prezzi sono noti
    const expected = b.expectedPrice ?? null;
    const charged = b.chargedPrice ?? null;
    const priceMatch =
      expected != null && charged != null
        ? Math.abs(Number(expected) - Number(charged)) < 0.005
        : null;

    const [row] = await db.insert(carontejourneys).values({
      deviceId:      b.deviceId ?? null,
      ticketUid:     b.ticketUid ?? null,
      tripId:        b.tripId ?? null,
      routeId:       b.routeId ?? null,
      stopIn:        b.stopIn ?? null,
      stopOut:       b.stopOut ?? null,
      clusterIn:     b.clusterIn ?? null,
      clusterOut:    b.clusterOut ?? null,
      fareKind:      b.fareKind ?? null,
      expectedPrice: expected,
      chargedPrice:  charged,
      priceMatch,
      tapInId:       b.tapInId ?? null,
      tapOutId:      b.tapOutId ?? null,
      tsStart:       b.tsStart ? new Date(b.tsStart) : null,
      tsEnd:         b.tsEnd ? new Date(b.tsEnd) : null,
    }).returning();
    res.status(201).json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// GET /api/caronte/onboard?tripId= — persone a bordo (saldo progressivo IN − OUT)
router.get("/caronte/onboard", async (req, res): Promise<void> => {
  try {
    const tripId = String(req.query.tripId ?? "");
    if (!tripId) { res.status(400).json({ error: "tripId richiesto" }); return; }
    const r = await db.execute<any>(sql`
      SELECT
        COUNT(*) FILTER (WHERE direction = 'in')::int  AS boardings,
        COUNT(*) FILTER (WHERE direction = 'out')::int AS alightings,
        (COUNT(*) FILTER (WHERE direction = 'in') - COUNT(*) FILTER (WHERE direction = 'out'))::int AS onboard
      FROM caronte.tap_events
      WHERE trip_id = ${tripId}
    `);
    res.json(r.rows[0] ?? { boardings: 0, alightings: 0, onboard: 0 });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// GET /api/caronte/stop-flows?tripId= — salite/discese per fermata
router.get("/caronte/stop-flows", async (req, res): Promise<void> => {
  try {
    const tripId = String(req.query.tripId ?? "");
    const r = await db.execute<any>(sql`
      SELECT
        stop_id,
        COUNT(*) FILTER (WHERE direction = 'in')::int  AS boardings,
        COUNT(*) FILTER (WHERE direction = 'out')::int AS alightings
      FROM caronte.tap_events
      ${tripId ? sql`WHERE trip_id = ${tripId}` : sql``}
      GROUP BY stop_id
      ORDER BY stop_id
    `);
    res.json(r.rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// GET /api/caronte/revenue — fatturato (charged, fallback expected) + verifica prezzi
router.get("/caronte/revenue", async (req, res): Promise<void> => {
  try {
    const r = await db.execute<any>(sql`
      SELECT
        COUNT(*)::int                                            AS journeys,
        COALESCE(SUM(COALESCE(charged_price, expected_price)), 0)::float AS revenue,
        COALESCE(SUM(expected_price), 0)::float                  AS expected_total,
        COUNT(*) FILTER (WHERE price_match IS TRUE)::int          AS matches,
        COUNT(*) FILTER (WHERE price_match IS FALSE)::int         AS mismatches
      FROM caronte.journeys
    `);
    res.json(r.rows[0] ?? { journeys: 0, revenue: 0, expected_total: 0, matches: 0, mismatches: 0 });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
