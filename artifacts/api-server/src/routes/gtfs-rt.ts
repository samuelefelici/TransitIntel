/**
 * ═══════════════════════════════════════════════════════════════════════════
 * GTFS-REALTIME — feed standard VehiclePositions + TripUpdates
 * ───────────────────────────────────────────────────────────────────────────
 * Espone i dati live dell'AVM (schema `caronte`) nel formato GTFS-Realtime
 * (protobuf), lo standard de-facto consumato da Google Maps, Moovit, Transit
 * e da qualsiasi sistema di infomobilità. Interoperabilità immediata: basta
 * registrare l'URL del feed presso l'aggregatore.
 *
 *   GET /api/gtfs-rt/vehicle-positions   — posizioni mezzi (ultimi 10 minuti)
 *   GET /api/gtfs-rt/trip-updates        — ritardi corse dai transiti reali
 *
 * Querystring:
 *   ?format=json  → payload JSON di debug (stessa struttura del protobuf)
 *   ?key=...      → API key se GTFS_RT_API_KEY è impostata (anche Bearer)
 *
 * Auth: i consumer sono esterni (aggregatori), quindi il router è montato
 * PRIMA di requireAuth con chiave statica opzionale, come /api/caronte.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { Router, type IRouter, type RequestHandler } from "express";
import GtfsRealtimeBindings from "gtfs-realtime-bindings";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import {
  buildVehiclePositionsFeed, buildTripUpdatesFeed,
  type RtPositionRow, type RtDelayRow,
} from "../lib/gtfs-rt-builders";

const router: IRouter = Router();
const { FeedMessage } = GtfsRealtimeBindings.transit_realtime;

// ── Auth opzionale: GTFS_RT_API_KEY via ?key= o Authorization: Bearer ───────
const requireRtKey: RequestHandler = (req, res, next) => {
  const key = process.env.GTFS_RT_API_KEY;
  if (!key) return next(); // feed pubblico (default: gli aggregatori non mandano header)
  const auth = req.headers.authorization;
  const token = auth?.startsWith("Bearer ") ? auth.slice(7) : String(req.query.key ?? "");
  if (token !== key) { res.status(401).json({ error: "Non autorizzato" }); return; }
  next();
};
router.use(requireRtKey);

// ── Helpers risposta ─────────────────────────────────────────────────────────

function sendFeed(res: any, payload: object, asJson: boolean, filename: string) {
  // verify() ritorna un messaggio d'errore se il payload non rispetta lo schema
  const err = FeedMessage.verify(payload);
  if (err) { res.status(500).json({ error: `feed non valido: ${err}` }); return; }
  if (asJson) { res.json(payload); return; }
  const buf = FeedMessage.encode(FeedMessage.fromObject(payload)).finish();
  res.setHeader("Content-Type", "application/x-protobuf");
  res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
  res.send(Buffer.from(buf));
}

let caronteCheck: { ok: boolean; at: number } | null = null;
async function caronteAvailable(): Promise<boolean> {
  if (caronteCheck && Date.now() - caronteCheck.at < 60_000) return caronteCheck.ok;
  try {
    const r = await db.execute<any>(sql`
      SELECT to_regclass('caronte.vehicle_positions') AS vp,
             to_regclass('caronte.stop_transits')     AS st
    `);
    const ok = !!(r.rows[0]?.vp && r.rows[0]?.st);
    caronteCheck = { ok, at: Date.now() };
    return ok;
  } catch {
    caronteCheck = { ok: false, at: Date.now() };
    return false;
  }
}

// ── GET /gtfs-rt/vehicle-positions ───────────────────────────────────────────
router.get("/vehicle-positions", async (req, res): Promise<void> => {
  try {
    const nowSec = Math.floor(Date.now() / 1000);
    let rows: RtPositionRow[] = [];
    if (await caronteAvailable()) {
      // Ultima posizione per mezzo negli ultimi 10' + corsa attiva per il TripDescriptor
      const q = await db.execute<any>(sql`
        WITH latest AS (
          SELECT DISTINCT ON (COALESCE(vp.vehicle_id, vp.trip_id))
                 vp.vehicle_id, vp.trip_id, vp.lat, vp.lon, vp.speed, vp.heading,
                 vp.nearest_stop_id, EXTRACT(EPOCH FROM vp.ts)::bigint AS ts_epoch
          FROM caronte.vehicle_positions vp
          WHERE vp.ts > now() - interval '10 minutes'
            AND (vp.vehicle_id IS NOT NULL OR vp.trip_id IS NOT NULL)
          ORDER BY COALESCE(vp.vehicle_id, vp.trip_id), vp.ts DESC
        )
        SELECT l.vehicle_id,
               COALESCE(a.trip_id, l.trip_id) AS trip_id,
               a.route_id,
               l.lat, l.lon, l.speed, l.heading,
               l.nearest_stop_id AS stop_id,
               st.stop_seq,
               l.ts_epoch
        FROM latest l
        LEFT JOIN LATERAL (
          SELECT a.trip_id, a.route_id FROM caronte.active_trips a
          WHERE a.ended_at IS NULL
            AND ((l.vehicle_id IS NOT NULL AND a.vehicle_id = l.vehicle_id)
              OR (l.vehicle_id IS NULL AND a.trip_id = l.trip_id))
          ORDER BY a.started_at DESC LIMIT 1
        ) a ON true
        LEFT JOIN LATERAL (
          SELECT st.stop_seq FROM caronte.stop_transits st
          WHERE st.trip_id = COALESCE(a.trip_id, l.trip_id)
            AND st.actual_ts > now() - interval '6 hours'
          ORDER BY st.actual_ts DESC LIMIT 1
        ) st ON true
      `);
      rows = q.rows.map((r: any) => ({
        vehicle_id: r.vehicle_id,
        trip_id: r.trip_id,
        route_id: r.route_id,
        lat: Number(r.lat),
        lon: Number(r.lon),
        speed: r.speed != null ? Number(r.speed) : null,
        heading: r.heading != null ? Number(r.heading) : null,
        stop_id: r.stop_id,
        stop_seq: r.stop_seq != null ? Number(r.stop_seq) : null,
        ts_epoch: Number(r.ts_epoch),
      }));
    }
    sendFeed(res, buildVehiclePositionsFeed(rows, nowSec),
      req.query.format === "json", "vehicle-positions.pb");
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /gtfs-rt/trip-updates ────────────────────────────────────────────────
router.get("/trip-updates", async (req, res): Promise<void> => {
  try {
    const nowSec = Math.floor(Date.now() / 1000);
    let rows: RtDelayRow[] = [];
    if (await caronteAvailable()) {
      const q = await db.execute<any>(sql`
        SELECT DISTINCT ON (st.trip_id)
               st.trip_id, st.route_id, st.vehicle_id, st.stop_id, st.stop_seq,
               st.delay_seconds, EXTRACT(EPOCH FROM st.actual_ts)::bigint AS ts_epoch
        FROM caronte.stop_transits st
        WHERE st.actual_ts > now() - interval '30 minutes'
          AND st.trip_id IS NOT NULL
          AND st.delay_seconds IS NOT NULL
        ORDER BY st.trip_id, st.actual_ts DESC
      `);
      rows = q.rows.map((r: any) => ({
        trip_id: r.trip_id,
        route_id: r.route_id,
        vehicle_id: r.vehicle_id,
        stop_id: r.stop_id,
        stop_seq: r.stop_seq != null ? Number(r.stop_seq) : null,
        delay_seconds: Number(r.delay_seconds),
        ts_epoch: Number(r.ts_epoch),
      }));
    }
    sendFeed(res, buildTripUpdatesFeed(rows, nowSec),
      req.query.format === "json", "trip-updates.pb");
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
