/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SCHEMA `caronte` — endpoint per il validatore di bordo + ingestione/metriche
 * ───────────────────────────────────────────────────────────────────────────
 * Alimentati da Caronte (AVM: active_trips, vehicle_positions) e dal validatore
 * iPhone (tap NFC, journeys). Tutto nello schema dedicato `caronte`.
 *
 * Auth: header `Authorization: Bearer <CERBERO_API_KEY>` (vedi requireCaronteKey).
 *
 * Per il validatore:
 *   GET  /api/caronte/active-trip?vehicle_id=   — corsa attiva + fermata corrente
 *   GET  /api/caronte/current-stop?vehicle_id=  — solo fermata corrente
 *   POST /api/caronte/taps                      — ingest tap (+ journey su tap-OUT)
 *
 * Ingest/metriche di supporto:
 *   POST /api/caronte/tap-events
 *   POST /api/caronte/vehicle-positions
 *   POST /api/caronte/journeys
 *   GET  /api/caronte/onboard?tripId=
 *   GET  /api/caronte/stop-flows?tripId=
 *   GET  /api/caronte/revenue
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { Router, type IRouter, type RequestHandler } from "express";
import { db } from "@workspace/db";
import { carontetapEvents, carontejourneys, carontevehiclePositions } from "@workspace/db/schema";
import { sql } from "drizzle-orm";
import { getLatestFeedId } from "./gtfs-helpers";
import { computeFareQuote, persistStopsClassification, markUrbanHourly } from "./fares";

const router: IRouter = Router();

// ── Auth: Bearer API key statica condivisa col validatore ───────────────────
// Se CERBERO_API_KEY è impostata viene applicata; se non lo è, si lascia passare
// (comodità dev) loggando un avviso. In produzione imposta sempre la chiave.
const requireCaronteKey: RequestHandler = (req, res, next) => {
  const key = process.env.CERBERO_API_KEY;
  if (!key) {
    console.warn("[caronte] CERBERO_API_KEY non impostata: endpoint non protetti");
    return next();
  }
  const auth = req.headers.authorization;
  const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  if (token !== key) { res.status(401).json({ error: "Non autorizzato" }); return; }
  next();
};
router.use(requireCaronteKey);

// Feed GTFS attivo: GTFS_FEED_ID forza, altrimenti il feed is_active=true.
async function resolveFeedId(): Promise<string | null> {
  if (process.env.GTFS_FEED_ID) return process.env.GTFS_FEED_ID;
  return getLatestFeedId();
}

// Arricchisce una fermata GTFS con nome + cluster tariffario.
async function enrichStop(feedId: string | null, stopId: string | null) {
  if (!feedId || !stopId) return { stopName: null, clusterId: null };
  const r = await db.execute<any>(sql`
    SELECT s.stop_name, zcs.cluster_id
    FROM gtfs_stops s
    LEFT JOIN gtfs_fare_zone_cluster_stops zcs
      ON zcs.feed_id = s.feed_id AND zcs.stop_id = s.stop_id
    WHERE s.feed_id = ${feedId} AND s.stop_id = ${stopId}
    LIMIT 1
  `);
  const row = r.rows[0];
  return { stopName: row?.stop_name ?? null, clusterId: row?.cluster_id ?? null };
}

// ── Admin (stessa API-key): setup tariffario lanciabile via curl ────────────
// Equivalenti API-key delle route JWT in fares.ts, per non dover loggare.

// POST /api/caronte/persist-classification — calcola e persiste fare_kind su gtfs_stops (§6.1)
router.post("/caronte/persist-classification", async (_req, res): Promise<void> => {
  try {
    const feedId = await resolveFeedId();
    if (!feedId) { res.status(400).json({ error: "No GTFS feed" }); return; }
    const out = await persistStopsClassification(feedId);
    res.json({ ok: true, feedId, ...out });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// POST /api/caronte/mark-urban-hourly — marca il biglietto orario urbano (§6.2)
router.post("/caronte/mark-urban-hourly", async (req, res): Promise<void> => {
  try {
    const feedId = await resolveFeedId();
    if (!feedId) { res.status(400).json({ error: "No GTFS feed" }); return; }
    const out = await markUrbanHourly(feedId, req.body?.products ?? {});
    res.json({ ok: true, feedId, ...out });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// GET /api/caronte/quote?stopIn=&stopOut= — alias API-key dell'oracolo /api/fares/quote
router.get("/caronte/quote", async (req, res): Promise<void> => {
  try {
    const feedId = await resolveFeedId();
    if (!feedId) { res.status(400).json({ error: "No GTFS feed" }); return; }
    const stopIn = String(req.query.stopIn ?? "");
    const stopOut = String(req.query.stopOut ?? "");
    const q = await computeFareQuote(feedId, stopIn, stopOut);
    res.status(q.httpStatus).json(q.body);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// GET /api/caronte/active-trip — corsa attiva (da Caronte) + fermata corrente
router.get("/caronte/active-trip", async (req, res): Promise<void> => {
  try {
    const vehicleId = req.query.vehicle_id ? String(req.query.vehicle_id) : null;
    const feedId = await resolveFeedId();

    const r = await db.execute<any>(sql`
      SELECT a.trip_id, a.route_id, a.vehicle_id, a.started_at,
             p.nearest_stop_id, p.lat, p.lon, p.ts AS pos_ts
      FROM caronte.active_trips a
      LEFT JOIN LATERAL (
        SELECT nearest_stop_id, lat, lon, ts
        FROM caronte.vehicle_positions vp
        WHERE vp.trip_id = a.trip_id
          AND (a.vehicle_id IS NULL OR vp.vehicle_id = a.vehicle_id)
        ORDER BY vp.ts DESC
        LIMIT 1
      ) p ON true
      WHERE a.ended_at IS NULL
        AND (${vehicleId}::text IS NULL OR a.vehicle_id = ${vehicleId})
      ORDER BY a.started_at DESC
      LIMIT 1
    `);
    const row = r.rows[0];
    if (!row) { res.status(404).json({ error: "Nessuna corsa attiva" }); return; }

    let stop = null;
    if (row.nearest_stop_id) {
      const { stopName, clusterId } = await enrichStop(feedId, row.nearest_stop_id);
      stop = {
        stopId: row.nearest_stop_id,
        stopName,
        clusterId,
        lat: row.lat, lon: row.lon, ts: row.pos_ts,
      };
    }
    res.json({ tripId: row.trip_id, routeId: row.route_id, vehicleId: row.vehicle_id, stop });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// GET /api/caronte/current-stop — solo fermata corrente di un veicolo
router.get("/caronte/current-stop", async (req, res): Promise<void> => {
  try {
    const vehicleId = String(req.query.vehicle_id ?? "");
    if (!vehicleId) { res.status(400).json({ error: "vehicle_id richiesto" }); return; }
    const feedId = await resolveFeedId();

    const r = await db.execute<any>(sql`
      SELECT nearest_stop_id, trip_id, lat, lon, ts
      FROM caronte.vehicle_positions
      WHERE vehicle_id = ${vehicleId}
      ORDER BY ts DESC
      LIMIT 1
    `);
    const row = r.rows[0];
    if (!row?.nearest_stop_id) { res.status(404).json({ error: "Nessuna fermata corrente" }); return; }

    const { stopName, clusterId } = await enrichStop(feedId, row.nearest_stop_id);
    res.json({
      tripId: row.trip_id,
      stop: { stopId: row.nearest_stop_id, stopName, clusterId, lat: row.lat, lon: row.lon, ts: row.ts },
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// POST /api/caronte/taps — ingest tap NFC; su tap-OUT chiude la journey con tariffa
router.post("/caronte/taps", async (req, res): Promise<void> => {
  try {
    const b = req.body ?? {};
    if (!b.deviceId || (b.direction !== "in" && b.direction !== "out")) {
      res.status(400).json({ error: "deviceId e direction ('in'|'out') richiesti" });
      return;
    }

    // Passo A — inserisci sempre il tap
    const [tap] = await db.insert(carontetapEvents).values({
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

    // tap-IN: niente journey
    if (b.direction === "in") { res.status(201).json({ tapId: tap.id, journey: null }); return; }

    // tap-OUT: trova il tap-IN aperto più recente dello stesso biglietto
    if (!b.ticketUid) { res.status(201).json({ tapId: tap.id, journey: null, note: "ticketUid assente: journey non creata" }); return; }
    const inq = await db.execute<any>(sql`
      SELECT t.id, t.stop_id, t.cluster_id, t.ts
      FROM caronte.tap_events t
      WHERE t.ticket_uid = ${b.ticketUid}
        AND t.direction = 'in'
        AND NOT EXISTS (SELECT 1 FROM caronte.journeys j WHERE j.tap_in_id = t.id)
      ORDER BY t.ts DESC
      LIMIT 1
    `);
    const tapIn = inq.rows[0];
    if (!tapIn) { res.status(201).json({ tapId: tap.id, journey: null, note: "Nessun tap-IN aperto per questo biglietto" }); return; }

    // Tariffa attesa via oracolo
    const feedId = await resolveFeedId();
    const stopIn = tapIn.stop_id as string | null;
    const stopOut = (b.stopId ?? null) as string | null;
    let expectedPrice: number | null = null;
    let fareKind: string | null = null;
    let branch: string | null = null;
    if (feedId && stopIn && stopOut) {
      const q = await computeFareQuote(feedId, stopIn, stopOut);
      expectedPrice = q.body?.expectedPrice ?? null;
      fareKind = q.body?.fareKind ?? null;
      branch = q.body?.branch ?? null;
    }

    // chargedPrice: per ora default = expectedPrice finché non c'è il pagamento reale
    const chargedPrice: number | null = b.chargedPrice ?? expectedPrice;
    const priceMatch =
      expectedPrice != null && chargedPrice != null
        ? Math.abs(Number(expectedPrice) - Number(chargedPrice)) < 0.005
        : null;

    const [journey] = await db.insert(carontejourneys).values({
      deviceId:      b.deviceId,
      ticketUid:     b.ticketUid,
      tripId:        b.tripId ?? null,
      routeId:       b.routeId ?? null,
      stopIn:        stopIn,
      stopOut:       stopOut,
      clusterIn:     tapIn.cluster_id ?? null,
      clusterOut:    b.clusterId ?? null,
      fareKind:      fareKind,
      expectedPrice: expectedPrice,
      chargedPrice:  chargedPrice,
      priceMatch:    priceMatch,
      tapInId:       tapIn.id,
      tapOutId:      tap.id,
      tsStart:       tapIn.ts ? new Date(tapIn.ts) : null,
      tsEnd:         b.ts ? new Date(b.ts) : new Date(),
    }).returning();

    res.status(201).json({
      tapId: tap.id,
      journey: {
        id: journey.id,
        expectedPrice, chargedPrice, priceMatch, fareKind, branch,
      },
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// POST /api/caronte/tap-events — insert grezzo di una timbrata (debug/import)
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
