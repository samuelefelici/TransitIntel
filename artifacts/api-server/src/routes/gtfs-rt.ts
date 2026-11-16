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
 *   GET /api/gtfs-rt/trip-updates        — ritardi corse dai transiti reali,
 *                                          e le corse soppresse del giorno
 *
 * Le righe e la traduzione nei codici del GTFS pubblicato: lib/gtfs-rt-dati.ts.
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
import { timingSafeEqual } from "node:crypto";
import GtfsRealtimeBindings from "gtfs-realtime-bindings";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import {
  buildVehiclePositionsFeed, buildTripUpdatesFeed,
  type RtPositionRow, type RtDelayRow,
} from "../lib/gtfs-rt-builders";
import { posizioniRecenti, ritardiRecenti, soppresseDelGiorno } from "../lib/gtfs-rt-dati";
import { giornataOggi } from "../lib/service-day";

import { schemaState } from "../lib/caronte-schema";

const router: IRouter = Router();
const { FeedMessage } = GtfsRealtimeBindings.transit_realtime;

// ── Auth opzionale: GTFS_RT_API_KEY via ?key= o Authorization: Bearer ───────
const requireRtKey: RequestHandler = (req, res, next) => {
  const key = process.env.GTFS_RT_API_KEY;
  if (!key) return next(); // feed READ-ONLY pubblico per aggregatori: nessuna scrittura, ok aperto
  const auth = req.headers.authorization;
  const token = auth?.startsWith("Bearer ") ? auth.slice(7) : String(req.query.key ?? "");
  const a = Buffer.from(token), b = Buffer.from(key);
  if (a.length !== b.length || !timingSafeEqual(a, b)) { res.status(401).json({ error: "Non autorizzato" }); return; }
  next();
};
router.use(requireRtKey);

// ── Helpers risposta ─────────────────────────────────────────────────────────

/* Il feed è pubblico: fuori va un messaggio generico, i dettagli nel log. */
function erroreInterno(res: any, feed: string, e: any) {
  console.error(`[gtfs-rt] ${feed}:`, e?.cause?.code ?? e?.code ?? e?.name ?? "errore");
  res.status(500).json({ error: "Feed temporaneamente non disponibile" });
}

function sendFeed(res: any, payload: object, asJson: boolean, filename: string) {
  // verify() ritorna un messaggio d'errore se il payload non rispetta lo schema
  const err = FeedMessage.verify(payload);
  if (err) { erroreInterno(res, filename, { name: `feed non valido: ${err}` }); return; }
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
    /* Stesso controllo della Sala Operativa: le tabelle possono esistere ma
     * mancare una colonna, e questo è un feed PUBBLICO — un 500 andrebbe agli
     * aggregatori esterni invece del feed vuoto previsto dal design. Il
     * controllo copre anche active_trips, che le query qui usano in LATERAL
     * e che la vecchia versione non verificava affatto. */
    const st0 = await schemaState();
    if (!st0.unknown) {
      caronteCheck = { ok: st0.ready, at: Date.now() };
      return st0.ready;
    }
    const r = await db.execute<any>(sql`
      SELECT to_regclass('caronte.vehicle_positions') AS vp,
             to_regclass('caronte.active_trips')      AS at,
             to_regclass('caronte.stop_transits')     AS st
    `);
    const ok = !!(r.rows[0]?.vp && r.rows[0]?.at && r.rows[0]?.st);
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
    const rows: RtPositionRow[] = (await caronteAvailable()) ? await posizioniRecenti() : [];
    sendFeed(res, buildVehiclePositionsFeed(rows, nowSec),
      req.query.format === "json", "vehicle-positions.pb");
  } catch (e: any) {
    erroreInterno(res, "vehicle-positions", e);
  }
});

// ── GET /gtfs-rt/trip-updates ────────────────────────────────────────────────
router.get("/trip-updates", async (req, res): Promise<void> => {
  try {
    const now = new Date();
    const nowSec = Math.floor(now.getTime() / 1000);
    /* Le soppressioni vengono dal consuntivo, non dall'AVM: ci sono anche
     * quando lo schema caronte manca. */
    const soppresse = await soppresseDelGiorno(giornataOggi(now));
    const rows: RtDelayRow[] = (await caronteAvailable()) ? await ritardiRecenti() : [];
    sendFeed(res, buildTripUpdatesFeed(rows, nowSec, soppresse),
      req.query.format === "json", "trip-updates.pb");
  } catch (e: any) {
    erroreInterno(res, "trip-updates", e);
  }
});

export default router;
