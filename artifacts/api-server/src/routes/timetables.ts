/**
 * Le linee del programma di esercizio per i Tempi osservati (Esercizio).
 *
 *   GET /api/timetables/routes?feedId=   — linee del feed risolto (default: il feed attivo)
 *
 * Quadri di fermata e orari di linea si stampano da Planning Studio
 * (routes/planning-studio-timetables.ts, pagina Orari al pubblico): le vecchie
 * rotte sul feed GTFS (stops/search, stop/:id, route/:id) non avevano più chiamanti.
 */
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { getLatestFeedId } from "./gtfs-helpers";

const router: IRouter = Router();

// ── GET /timetables/routes — linee del feed risolto (programma attivo) ──────
// Il picker della pagina DEVE elencare solo le linee del feed su cui poi si
// calcola l'orario: /api/gtfs/routes senza feedId mescola tutti i feed e
// porta a 404 "Linea non trovata" selezionando linee di feed vecchi.
router.get("/timetables/routes", async (req, res): Promise<void> => {
  try {
    const feedId = String(req.query.feedId ?? "") || (await getLatestFeedId(req));
    if (!feedId) { res.json({ feedId: null, routes: [] }); return; }
    const r = await db.execute<any>(sql`
      SELECT route_id, route_short_name, route_long_name, route_color
      FROM gtfs_routes WHERE feed_id = ${feedId}
      ORDER BY route_short_name
    `);
    res.json({
      feedId,
      routes: r.rows.map((x: any) => ({
        routeId: x.route_id,
        routeShortName: x.route_short_name,
        routeLongName: x.route_long_name,
        routeColor: x.route_color,
      })),
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
