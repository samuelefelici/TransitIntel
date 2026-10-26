/**
 * Analisi di un feed GTFS (Dati e integrazioni › Importa GTFS, PlanningAnalysisTab):
 * analisi salvata, parametri economici, linee e forme, calendario, classificazione
 * delle linee, catalogo POI, flussi, preset di domanda, orario per fascia.
 * Endpoint sotto /api/planning/feeds. Il confronto fra programmi è in
 * lib/planning-compare.ts; il vecchio planner sugli scenari non c'è più.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import {
  gtfsFeeds,
  gtfsFeedAnalysis,
  gtfsFeedEconomicParams,
  gtfsRoutes,
  gtfsShapes,
  planningRouteClassifications,
} from "@workspace/db/schema";
import { eq, and, sql } from "drizzle-orm";
import { analyzeFeed, getOrCreateEconomicParams, DEFAULT_ECON } from "../lib/planning/feed-analyzer";

const router: IRouter = Router();

// ───────────────────────────── helpers ─────────────────────────────
function bad(res: Response, msg: string, code = 400) {
  return res.status(code).json({ error: msg });
}

// ─────────────────── Sprint S1: analisi feed GTFS ───────────────────

/** GET /api/planning/feeds/:id/analysis — risultato salvato (o null) */
router.get("/planning/feeds/:id/analysis", async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const [row] = await db
      .select()
      .from(gtfsFeedAnalysis)
      .where(eq(gtfsFeedAnalysis.feedId, id))
      .limit(1);
    return res.json({ analysis: row ?? null });
  } catch (e: any) {
    console.error("[planning] feed analysis get error", e);
    return bad(res, e?.message || "Errore lettura analisi feed", 500);
  }
});

/** POST /api/planning/feeds/:id/analyze — calcola/ricalcola KPI feed */
router.post("/planning/feeds/:id/analyze", async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const [feed] = await db.select().from(gtfsFeeds).where(eq(gtfsFeeds.id, id)).limit(1);
    if (!feed) return bad(res, "Feed GTFS non trovato", 404);

    const body = (req.body && typeof req.body === "object") ? req.body : {};
    const dayType = ["weekday", "saturday", "sunday", "all"].includes(body.dayType) ? body.dayType : "weekday";
    const routeIds = Array.isArray(body.routeIds) && body.routeIds.length > 0 ? body.routeIds.map(String) : null;
    const categoryFilter = Array.isArray(body.categoryFilter) && body.categoryFilter.length > 0 ? body.categoryFilter.map(String) : null;
    const serviceDate = typeof body.serviceDate === "string" && /^\d{8}$/.test(body.serviceDate) ? body.serviceDate : null;
    const paramsOverride = body.params;

    const result = await analyzeFeed(id, { paramsOverride, dayType, routeIds, categoryFilter, serviceDate });
    return res.json({ analysis: result });
  } catch (e: any) {
    console.error("[planning] feed analyze error", e);
    return bad(res, e?.message || "Errore analisi feed", 500);
  }
});

/** GET /api/planning/feeds/:id/routes — lista linee del feed (per filtro) */
router.get("/planning/feeds/:id/routes", async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const rows = await db.select({
      routeId: gtfsRoutes.routeId,
      shortName: gtfsRoutes.routeShortName,
      longName: gtfsRoutes.routeLongName,
      color: gtfsRoutes.routeColor,
      routeType: gtfsRoutes.routeType,
    }).from(gtfsRoutes).where(eq(gtfsRoutes.feedId, id));
    return res.json({ routes: rows });
  } catch (e: any) {
    console.error("[planning] feed routes error", e);
    return bad(res, e?.message || "Errore", 500);
  }
});

/** GET /api/planning/feeds/:id/shapes?routes=A,B,C — shapes (FeatureCollection) per mappa */
router.get("/planning/feeds/:id/shapes", async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const routesParam = String(req.query.routes ?? "").trim();
    const routeFilter = routesParam ? new Set(routesParam.split(",").map(s => s.trim()).filter(Boolean)) : null;

    // 1 shape per route (la più usata) — query semplificata: prendi tutti gli shape della route
    // Per performance limitiamo: prima troviamo per ogni route lo shape più usato.
    const tripStats = await db.execute(sql`
      SELECT route_id, shape_id, COUNT(*)::int AS n
      FROM gtfs_trips
      WHERE feed_id = ${id} AND shape_id IS NOT NULL
      GROUP BY route_id, shape_id
    `);
    const bestShapeByRoute = new Map<string, string>();
    const bestCount = new Map<string, number>();
    for (const r of (tripStats.rows as any[])) {
      const cur = bestCount.get(r.route_id) ?? 0;
      if (r.n > cur) {
        bestCount.set(r.route_id, r.n);
        bestShapeByRoute.set(r.route_id, r.shape_id);
      }
    }

    const wantedShapeIds = new Set<string>();
    for (const [routeId, shapeId] of bestShapeByRoute.entries()) {
      if (!routeFilter || routeFilter.has(routeId)) wantedShapeIds.add(shapeId);
    }

    const shapes = await db.select().from(gtfsShapes).where(eq(gtfsShapes.feedId, id));
    const features: any[] = [];
    for (const s of shapes) {
      if (!wantedShapeIds.has(s.shapeId)) continue;
      const g: any = s.geojson;
      let coords: number[][] | null = null;
      if (g?.type === "LineString") coords = g.coordinates;
      else if (g?.type === "Feature" && g.geometry?.type === "LineString") coords = g.geometry.coordinates;
      else if (g?.type === "FeatureCollection" && g.features?.[0]?.geometry?.coordinates) coords = g.features[0].geometry.coordinates;
      if (!coords) continue;
      features.push({
        type: "Feature",
        properties: {
          shapeId: s.shapeId,
          routeId: s.routeId,
          shortName: s.routeShortName,
          color: s.routeColor || "#3b82f6",
        },
        geometry: { type: "LineString", coordinates: coords },
      });
    }
    return res.json({ type: "FeatureCollection", features });
  } catch (e: any) {
    console.error("[planning] feed shapes error", e);
    return bad(res, e?.message || "Errore", 500);
  }
});

/** GET /api/planning/feeds/:id/economic-params — leggi parametri (creando default se mancanti) */
router.get("/planning/feeds/:id/economic-params", async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const [feed] = await db.select().from(gtfsFeeds).where(eq(gtfsFeeds.id, id)).limit(1);
    if (!feed) return bad(res, "Feed GTFS non trovato", 404);
    const params = await getOrCreateEconomicParams(id);
    return res.json({ params, defaults: DEFAULT_ECON });
  } catch (e: any) {
    console.error("[planning] econ-params get error", e);
    return bad(res, e?.message || "Errore parametri", 500);
  }
});

/** PATCH /api/planning/feeds/:id/economic-params — aggiorna parametri */
router.patch("/planning/feeds/:id/economic-params", async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const allowed = [
      "fuelConsumptionL100", "fuelPriceEurL", "driverCostEurH",
      "maintenanceEurKm", "amortizationEurKm",
      "fareUrbanEurKm", "fareSuburbanEurKm", "fareNightEurKm",
      "perRouteOverrides",
    ] as const;
    const patch: Record<string, any> = {};
    for (const k of allowed) {
      if (req.body && k in req.body) patch[k] = req.body[k];
    }
    if (Object.keys(patch).length === 0) return bad(res, "Nessun campo da aggiornare");

    await getOrCreateEconomicParams(id);
    const [updated] = await db
      .update(gtfsFeedEconomicParams)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(gtfsFeedEconomicParams.feedId, id))
      .returning();
    return res.json({ params: updated });
  } catch (e: any) {
    console.error("[planning] econ-params patch error", e);
    return bad(res, e?.message || "Errore aggiornamento parametri", 500);
  }
});

// ─────────────── Bootstrap tabelle nuove (idempotent) ───────────────
let bootstrapped = false;
export async function ensureNewTables() {
  if (bootstrapped) return;
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS planning_route_classifications (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        feed_id uuid NOT NULL REFERENCES gtfs_feeds(id) ON DELETE CASCADE,
        route_id text NOT NULL,
        category text NOT NULL,
        fare_type text,
        updated_at timestamptz DEFAULT now()
      )
    `);
    await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_planning_routeclass_unique ON planning_route_classifications(feed_id, route_id)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_planning_routeclass_cat ON planning_route_classifications(feed_id, category)`);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS planning_pois (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        feed_id uuid NOT NULL REFERENCES gtfs_feeds(id) ON DELETE CASCADE,
        name text NOT NULL,
        category text NOT NULL,
        lat double precision NOT NULL,
        lng double precision NOT NULL,
        weight double precision NOT NULL DEFAULT 1,
        notes text,
        created_at timestamptz DEFAULT now()
      )
    `);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_planning_pois_feed ON planning_pois(feed_id)`);
    bootstrapped = true;
  } catch (e: any) {
    console.error("[planning] bootstrap tables error", e?.message);
  }
}
// fire & forget al primo import
void ensureNewTables();

// ─────────────── Calendar days disponibili ───────────────

/** GET /api/planning/feeds/:id/calendar-days — elenco date di servizio con metadati */
router.get("/planning/feeds/:id/calendar-days", async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);

    // Determina range dates: prova calendar.txt, poi calendar_dates.txt
    const rangeR = await db.execute(sql`
      SELECT
        LEAST(
          (SELECT MIN(start_date) FROM gtfs_calendar WHERE feed_id = ${id}),
          (SELECT MIN(date)       FROM gtfs_calendar_dates WHERE feed_id = ${id})
        ) AS start_d,
        GREATEST(
          (SELECT MAX(end_date)   FROM gtfs_calendar WHERE feed_id = ${id}),
          (SELECT MAX(date)       FROM gtfs_calendar_dates WHERE feed_id = ${id})
        ) AS end_d
    `);
    const rr = rangeR.rows[0] as any;
    const startStr: string | null = rr?.start_d || null;
    const endStr:   string | null = rr?.end_d   || null;

    if (!startStr || !endStr) {
      // Nessun servizio definito
      return res.json({ days: [] });
    }

    // Espande i giorni nel range e conta service attivi per ciascuno.
    // Uso binding parametrici; la NULLIF protegge da stringhe vuote.
    const days = await db.execute(sql`
      WITH range_dates AS (
        SELECT to_char(d, 'YYYYMMDD') AS date,
               EXTRACT(ISODOW FROM d)::int AS dow
        FROM generate_series(
          TO_DATE(${startStr}, 'YYYYMMDD'),
          TO_DATE(${endStr},   'YYYYMMDD'),
          INTERVAL '1 day'
        ) d
      ),
      cal_active AS (
        SELECT rd.date, rd.dow, c.service_id
        FROM range_dates rd
        JOIN gtfs_calendar c ON c.feed_id = ${id}
          AND rd.date BETWEEN c.start_date AND c.end_date
          AND CASE rd.dow
                WHEN 1 THEN c.monday WHEN 2 THEN c.tuesday WHEN 3 THEN c.wednesday
                WHEN 4 THEN c.thursday WHEN 5 THEN c.friday WHEN 6 THEN c.saturday
                ELSE c.sunday END = 1
      ),
      add_dates AS (
        SELECT date, service_id FROM gtfs_calendar_dates
        WHERE feed_id = ${id} AND exception_type = 1
      ),
      rem_dates AS (
        SELECT date, service_id FROM gtfs_calendar_dates
        WHERE feed_id = ${id} AND exception_type = 2
      ),
      union_act AS (
        SELECT date, service_id FROM cal_active
        UNION
        SELECT date, service_id FROM add_dates
      ),
      filtered AS (
        SELECT u.date, u.service_id
        FROM union_act u
        WHERE NOT EXISTS (
          SELECT 1 FROM rem_dates r
          WHERE r.date = u.date AND r.service_id = u.service_id
        )
      ),
      counts AS (
        SELECT date, COUNT(DISTINCT service_id)::int AS service_count
        FROM filtered GROUP BY date
      )
      SELECT date, service_count,
             EXTRACT(ISODOW FROM TO_DATE(date,'YYYYMMDD'))::int AS dow
      FROM counts
      WHERE service_count > 0
      ORDER BY date
    `);
    return res.json({ days: days.rows });
  } catch (e: any) {
    console.error("[planning] calendar-days error", e);
    return bad(res, e?.message || "Errore", 500);
  }
});

// ─────────────── Route classifications (categorie linee) ───────────────

/** GET /api/planning/feeds/:id/route-classifications */
router.get("/planning/feeds/:id/route-classifications", async (req: Request, res: Response) => {
  try {
    await ensureNewTables();
    const id = String(req.params.id);
    const rows = await db
      .select()
      .from(planningRouteClassifications)
      .where(eq(planningRouteClassifications.feedId, id));
    return res.json({ classifications: rows });
  } catch (e: any) {
    console.error("[planning] classifications get error", e);
    return bad(res, e?.message || "Errore", 500);
  }
});

/** PUT /api/planning/feeds/:id/route-classifications — bulk upsert */
router.put("/planning/feeds/:id/route-classifications", async (req: Request, res: Response) => {
  try {
    await ensureNewTables();
    const id = String(req.params.id);
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (items.length === 0) return bad(res, "items vuoto");

    let upserts = 0;
    for (const it of items) {
      if (!it.routeId || !it.category) continue;
      const cat = String(it.category);
      const fareType = it.fareType ? String(it.fareType) : null;
      // upsert via raw SQL su unique(feed_id, route_id)
      await db.execute(sql`
        INSERT INTO planning_route_classifications (feed_id, route_id, category, fare_type, updated_at)
        VALUES (${id}, ${String(it.routeId)}, ${cat}, ${fareType}, now())
        ON CONFLICT (feed_id, route_id) DO UPDATE
          SET category = EXCLUDED.category,
              fare_type = EXCLUDED.fare_type,
              updated_at = now()
      `);
      upserts++;
    }
    return res.json({ ok: true, upserts });
  } catch (e: any) {
    console.error("[planning] classifications put error", e);
    return bad(res, e?.message || "Errore", 500);
  }
});

/** DELETE /api/planning/feeds/:id/route-classifications/:routeId */
router.delete("/planning/feeds/:id/route-classifications/:routeId", async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const routeId = String(req.params.routeId);
    await db.delete(planningRouteClassifications).where(and(
      eq(planningRouteClassifications.feedId, id),
      eq(planningRouteClassifications.routeId, routeId),
    ));
    return res.json({ ok: true });
  } catch (e: any) {
    console.error("[planning] classifications delete error", e);
    return bad(res, e?.message || "Errore", 500);
  }
});

// ─────────────── POI catalog (Google Places, già acquisiti) ───────────────

/**
 * GET /api/planning/feeds/:id/poi-catalog
 * Restituisce TUTTI i POI già acquisiti tramite Google Places (tabella
 * points_of_interest), filtrati al bbox della rete del feed e raggruppati
 * per categoria.
 *
 * Risposta:
 *   {
 *     categories: [{ category, count, color, label, icon }],
 *     pois: [{ id, name, category, lat, lng }]
 *   }
 */
router.get("/planning/feeds/:id/poi-catalog", async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);

    // Determina bbox del feed dalle stops
    const bboxR = await db.execute(sql`
      SELECT MIN(stop_lat) AS min_lat, MAX(stop_lat) AS max_lat,
             MIN(stop_lon) AS min_lon, MAX(stop_lon) AS max_lon
      FROM gtfs_stops WHERE feed_id = ${id}
    `);
    const b = bboxR.rows[0] as any;
    if (!b?.min_lat) return res.json({ categories: [], pois: [] });

    const margin = 0.05;
    const pois = await db.execute(sql`
      SELECT id, name, category, lat, lng
      FROM points_of_interest
      WHERE lat BETWEEN ${b.min_lat - margin} AND ${b.max_lat + margin}
        AND lng BETWEEN ${b.min_lon - margin} AND ${b.max_lon + margin}
    `);

    const grouped = new Map<string, number>();
    for (const r of (pois.rows as any[])) {
      grouped.set(r.category, (grouped.get(r.category) ?? 0) + 1);
    }
    const categories = Array.from(grouped.entries())
      .map(([category, count]) => ({ category, count }))
      .sort((a, b) => b.count - a.count);

    return res.json({ categories, pois: pois.rows });
  } catch (e: any) {
    console.error("[planning] poi-catalog error", e);
    return bad(res, e?.message || "Errore", 500);
  }
});

// ─────────────── Mobility flows (ISTAT O/D) ───────────────

/**
 * GET /api/planning/feeds/:id/mobility-flows
 * Query:
 *   reason=work|study|all
 *   mode=bus_urban|bus_extraurban|all
 *   minFlow=10
 *   poiCategories=tourism,leisure   (per fallback synthetic)
 *   synthetic=auto|true|false       (default auto: usa ISTAT se ha dati, altrimenti sintetici)
 *
 * Restituisce gli archi origine→destinazione. Se la matrice ISTAT è vuota
 * (caso comune in dev) cade su un modello sintetico census→POI basato su
 * gravity model (popolazione_sezione × peso_categoria / distanza²).
 */
router.get("/planning/feeds/:id/mobility-flows", async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const reason = String(req.query.reason || "all");        // work | study | all
    const mode   = String(req.query.mode   || "all");        // bus_urban | bus_extraurban | all
    const minFlow = Math.max(0, Number(req.query.minFlow) || 0);
    const poiCategories = String(req.query.poiCategories || "")
      .split(",").map((s) => s.trim()).filter(Boolean);
    const syntheticFlag = String(req.query.synthetic || "auto"); // auto|true|false

    const bboxR = await db.execute(sql`
      SELECT MIN(stop_lat) AS min_lat, MAX(stop_lat) AS max_lat,
             MIN(stop_lon) AS min_lon, MAX(stop_lon) AS max_lon
      FROM gtfs_stops WHERE feed_id = ${id}
    `);
    const b = bboxR.rows[0] as any;
    if (!b?.min_lat) return res.json({ flows: [], totalFlow: 0, source: "empty" });

    const margin = 0.15;

    // Tentativo ISTAT (a meno che synthetic=true forzato)
    if (syntheticFlag !== "true") {
      const reasonClause = reason !== "all" ? sql` AND reason = ${reason}` : sql``;
      // NOTA: i record S della matrice ISTAT 2011 non hanno il dettaglio mezzo
      //   (mode è NULL). Quando l'utente filtra per modo specifico applichiamo
      //   una quota stimata (TPL share) sul flusso totale anziché un WHERE.
      const tplShare =
        mode === "bus_urban" ? 0.10 :
        mode === "bus_extraurban" ? 0.06 :
        mode === "train" ? 0.04 :
        1.0;

      const rows = await db.execute(sql`
        SELECT origin_istat, origin_name, origin_lat, origin_lon,
               dest_istat,   dest_name,   dest_lat,   dest_lon,
               SUM(flow)::int AS flow
        FROM istat_commuting_od
        WHERE flow > 0
          ${reasonClause}
          AND (
            (origin_lat BETWEEN ${b.min_lat - margin} AND ${b.max_lat + margin}
              AND origin_lon BETWEEN ${b.min_lon - margin} AND ${b.max_lon + margin})
            OR
            (dest_lat   BETWEEN ${b.min_lat - margin} AND ${b.max_lat + margin}
              AND dest_lon BETWEEN ${b.min_lon - margin} AND ${b.max_lon + margin})
          )
        GROUP BY origin_istat, origin_name, origin_lat, origin_lon,
                 dest_istat,   dest_name,   dest_lat,   dest_lon
        HAVING SUM(flow) >= ${Math.max(1, Math.floor(minFlow / Math.max(tplShare, 0.01)))}
        ORDER BY SUM(flow) DESC
        LIMIT 500
      `);
      const flowsRaw = rows.rows as any[];
      if (flowsRaw.length > 0 || syntheticFlag === "false") {
        const flows = flowsRaw
          .map((r) => ({ ...r, flow: Math.round((r.flow ?? 0) * tplShare) }))
          .filter((r) => r.flow >= minFlow);
        const totalFlow = flows.reduce((s, r) => s + (r.flow ?? 0), 0);
        const note =
          mode === "all"
            ? "Censimento ISTAT 2011 — pendolari giornalieri (tutti i mezzi)."
            : `Censimento ISTAT 2011 — quota stimata "${mode}" = ${(tplShare * 100).toFixed(0)}% dei pendolari (mezzo non disaggregato nei record S).`;
        return res.json({ flows, totalFlow, source: "istat", note });
      }
    }

    // ── Fallback: flussi sintetici census → POI (gravity model) ──
    // Pesi per categoria (riflettono attrattività media giornaliera)
    const W: Record<string, number> = {
      hospital: 1.4, school: 2.5, shopping: 3.0, leisure: 1.8,
      office: 2.2, transit: 1.5, workplace: 2.0, worship: 0.6,
      elderly: 0.8, parking: 0.4, tourism: 2.0, industrial: 1.2,
    };
    const cats = poiCategories.length > 0 ? poiCategories : Object.keys(W);
    const catsLiteral = `{${cats.map(String).join(",")}}`;

    // POI dentro bbox + categorie scelte
    const poiR = await db.execute(sql`
      SELECT id, name, category, lat, lng
      FROM points_of_interest
      WHERE category = ANY(${catsLiteral}::text[])
        AND lat BETWEEN ${b.min_lat - 0.05} AND ${b.max_lat + 0.05}
        AND lng BETWEEN ${b.min_lon - 0.05} AND ${b.max_lon + 0.05}
      LIMIT 800
    `);
    const pois = poiR.rows as any[];

    // Sezioni censuarie più popolate dentro bbox (cap 400 per perf)
    const cenR = await db.execute(sql`
      SELECT istat_code, centroid_lat, centroid_lng, population
      FROM census_sections
      WHERE population > 0
        AND centroid_lat BETWEEN ${b.min_lat - margin} AND ${b.max_lat + margin}
        AND centroid_lng BETWEEN ${b.min_lon - margin} AND ${b.max_lon + margin}
      ORDER BY population DESC
      LIMIT 400
    `);
    const sections = cenR.rows as any[];

    // Per ogni sezione, top-K POI per attrattività (peso/distanza²) → archi
    const flows: any[] = [];
    const K = 3; // top 3 POI per sezione = max 1200 archi pre-cap
    for (const s of sections) {
      const sLat = Number(s.centroid_lat); const sLng = Number(s.centroid_lng);
      const pop = Number(s.population);
      const scored = pois.map((p) => {
        const dLat = Number(p.lat) - sLat;
        const dLng = (Number(p.lng) - sLng) * Math.cos(sLat * Math.PI / 180);
        const d2km = (dLat*dLat + dLng*dLng) * 111 * 111;
        const dist = Math.sqrt(d2km);
        if (dist < 0.2 || dist > 15) return null; // 200m..15km
        const w = W[p.category] ?? 1;
        const attractiveness = (pop * w) / (1 + d2km); // gravity
        return { p, dist, attractiveness };
      }).filter(Boolean) as { p: any; dist: number; attractiveness: number }[];

      scored.sort((a, b) => b.attractiveness - a.attractiveness);
      const top = scored.slice(0, K);
      const totA = top.reduce((acc, t) => acc + t.attractiveness, 0);
      if (totA <= 0) continue;

      // Quota di pop. che usa il TPL (assunzione conservativa 8%)
      const tplShare = 0.08;
      const movingPax = pop * tplShare;
      for (const t of top) {
        const flow = Math.round(movingPax * (t.attractiveness / totA));
        if (flow < minFlow) continue;
        flows.push({
          origin_istat: s.istat_code,
          origin_name: `Sezione ${s.istat_code}`,
          origin_lat: sLat,
          origin_lon: sLng,
          dest_istat: t.p.id,
          dest_name: t.p.name || t.p.category,
          dest_lat: Number(t.p.lat),
          dest_lon: Number(t.p.lng),
          flow,
          dest_category: t.p.category,
        });
      }
    }
    flows.sort((a, b) => b.flow - a.flow);
    const capped = flows.slice(0, 500);
    const totalFlow = capped.reduce((s, r) => s + r.flow, 0);
    return res.json({
      flows: capped,
      totalFlow,
      source: "synthetic",
      note: "Flussi stimati con gravity model census→POI (matrice ISTAT non popolata).",
      poiCategoriesUsed: cats,
    });
  } catch (e: any) {
    console.error("[planning] mobility-flows error", e);
    return bad(res, e?.message || "Errore", 500);
  }
});

// ─────────────── Demand presets (scenari di domanda) ───────────────

/**
 * GET /api/planning/feeds/:id/demand-preset?preset=weekday-work|sat-shopping|sun-summer-coast|sun-winter-mall
 *
 * Restituisce un preset che combina:
 *   - categorie POI suggerite (da spuntare di default)
 *   - categorie ISTAT (reason/mode) da considerare
 *   - hint testuale spiegativo
 *
 * NB: i presets sono regole client-side hard-coded; questo endpoint serve
 * per consistenza e futura customizzazione lato DB.
 */
router.get("/planning/feeds/:id/demand-preset", async (req: Request, res: Response) => {
  try {
    const preset = String(req.query.preset || "weekday-work");
    const presets: Record<string, any> = {
      "weekday-work": {
        label: "Feriale lavoro/studio",
        description: "Pendolari verso uffici, scuole, ospedali, stazioni nelle ore di punta.",
        poiCategories: ["office", "school", "hospital", "transit", "workplace"],
        istatReason: "all",
        istatMode: "all",
        weight: { school: 2.5, office: 2, hospital: 1.5, transit: 2, workplace: 1.5 },
      },
      "sat-shopping": {
        label: "Sabato shopping",
        description: "Movimenti verso centri commerciali, supermercati, centri storici.",
        poiCategories: ["shopping", "leisure", "tourism"],
        istatReason: "all",
        istatMode: "all",
        weight: { shopping: 3, leisure: 1.5, tourism: 1 },
      },
      "sun-summer-coast": {
        label: "Domenica estiva (lungomare)",
        description: "Spostamenti verso spiagge, strutture turistiche, lungomare.",
        poiCategories: ["tourism", "leisure", "transit"],
        istatReason: "all",
        istatMode: "all",
        weight: { tourism: 4, leisure: 2, transit: 1 },
        coastBoost: true,
      },
      "sun-winter-mall": {
        label: "Domenica invernale (centri commerciali)",
        description: "Centri commerciali, cinema, ristorazione: poca domanda di lavoro.",
        poiCategories: ["shopping", "leisure"],
        istatReason: "all",
        istatMode: "all",
        weight: { shopping: 4, leisure: 2 },
      },
      "evening-leisure": {
        label: "Sera tempo libero",
        description: "Cinema, ristoranti, eventi sportivi.",
        poiCategories: ["leisure", "tourism", "shopping"],
        istatReason: "all",
        istatMode: "all",
        weight: { leisure: 3, tourism: 1.5 },
      },
    };
    const def = presets[preset] ?? presets["weekday-work"];
    return res.json({ preset, ...def });
  } catch (e: any) {
    console.error("[planning] demand-preset error", e);
    return bad(res, e?.message || "Errore", 500);
  }
});

// ─────────────── Hourly schedule (matrice ora × linea) ───────────────

/**
 * GET /api/planning/feeds/:id/hourly-schedule
 * Query: ?serviceDate=YYYYMMDD | ?dayType=weekday|saturday|sunday|all
 *        &routes=routeId1,routeId2 (opzionale)
 *
 * Restituisce per ogni ora del giorno il numero di partenze per linea.
 *   { hours: [0..23], routes: [{routeId, shortName, total, perHour:[0..23]}] }
 */
router.get("/planning/feeds/:id/hourly-schedule", async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    // YYYYMMDD validato: interpolato in sql.raw più sotto → mai valore grezzo (no SQLi).
    const serviceDate = /^\d{8}$/.test(String(req.query.serviceDate || "")) ? String(req.query.serviceDate) : null;
    const rawDayType = String(req.query.dayType || "weekday").toLowerCase();
    // Mappa sinonimi italiani/inglesi
    const dayTypeAliases: Record<string, string> = {
      feriale: "weekday", weekday: "weekday", weekdays: "weekday",
      sabato: "saturday", saturday: "saturday",
      domenica: "sunday", sunday: "sunday",
      festivo: "sunday",
      tutti: "all", all: "all",
    };
    const dayType = dayTypeAliases[rawDayType] ?? "weekday";
    const routesFilter = String(req.query.routes || "")
      .split(",").map((s) => s.trim()).filter(Boolean);

    // Risolvi service_ids per il giorno richiesto.
    //   - Se viene passata una data: cerca in calendar (start/end + DOW)
    //     UNION calendar_dates (exception_type=1, "added").
    //   - Se viene passato un dayType: per il calendar standard usa la
    //     colonna DOW; per il calendar_dates calcola il DOW da `date` (YYYYMMDD).
    let serviceIds: string[] = [];
    if (serviceDate) {
      // YYYYMMDD → JS Date → DOW
      const y = parseInt(serviceDate.slice(0, 4), 10);
      const m = parseInt(serviceDate.slice(4, 6), 10);
      const d = parseInt(serviceDate.slice(6, 8), 10);
      const jsDate = new Date(Date.UTC(y, m - 1, d));
      const dow = jsDate.getUTCDay(); // 0=dom .. 6=sab
      const dowCol = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"][dow];

      // Calendar standard
      const r1 = await db.execute(sql.raw(`
        SELECT DISTINCT service_id FROM gtfs_calendar
        WHERE feed_id = '${id.replace(/'/g, "''")}'
          AND start_date <= '${serviceDate}' AND end_date >= '${serviceDate}'
          AND ${dowCol} = 1
      `));
      // Calendar_dates con eccezione "added" sulla data esatta, escludi rimosse
      const r2 = await db.execute(sql`
        SELECT DISTINCT service_id FROM gtfs_calendar_dates
        WHERE feed_id = ${id} AND date = ${serviceDate} AND exception_type = 1
      `);
      const r3 = await db.execute(sql`
        SELECT DISTINCT service_id FROM gtfs_calendar_dates
        WHERE feed_id = ${id} AND date = ${serviceDate} AND exception_type = 2
      `);
      const removed = new Set((r3.rows as any[]).map((x) => x.service_id));
      const set = new Set<string>();
      for (const x of r1.rows as any[]) if (!removed.has(x.service_id)) set.add(x.service_id);
      for (const x of r2.rows as any[]) if (!removed.has(x.service_id)) set.add(x.service_id);
      serviceIds = Array.from(set);
    } else {
      // dayType
      const dowMap: Record<string, string[]> = {
        weekday:  ["monday","tuesday","wednesday","thursday","friday"],
        saturday: ["saturday"],
        sunday:   ["sunday"],
        all:      ["monday","tuesday","wednesday","thursday","friday","saturday","sunday"],
      };
      const targetDows = dowMap[dayType] ?? dowMap.weekday;
      // Indici DOW di Postgres EXTRACT(DOW): 0=dom .. 6=sab
      const dowIdx: Record<string, number> = {
        sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
      };
      const targetDowIdxs = targetDows.map((d) => dowIdx[d]);

      // Calendar standard: OR sui flag DOW
      const dowOrClause = targetDows.map((c) => `${c} = 1`).join(" OR ");
      const r1 = await db.execute(sql.raw(`
        SELECT DISTINCT service_id FROM gtfs_calendar
        WHERE feed_id = '${id.replace(/'/g, "''")}'
          AND (${dowOrClause})
      `));

      // Calendar_dates: estrai DOW da `date` (YYYYMMDD → date), filtra sui DOW richiesti.
      // Per evitare di considerare un service "valido" ovunque, basta che esista
      // ALMENO una data del DOW giusto con exception_type=1.
      const r2 = await db.execute(sql.raw(`
        SELECT DISTINCT service_id
        FROM gtfs_calendar_dates
        WHERE feed_id = '${id.replace(/'/g, "''")}'
          AND exception_type = 1
          AND EXTRACT(DOW FROM TO_DATE(date, 'YYYYMMDD')) IN (${targetDowIdxs.join(",")})
      `));

      const set = new Set<string>();
      for (const x of r1.rows as any[]) set.add(x.service_id);
      for (const x of r2.rows as any[]) set.add(x.service_id);
      serviceIds = Array.from(set);
    }
    if (serviceIds.length === 0) return res.json({ hours: Array.from({length:24},(_,i)=>i), routes: [] });

    // ── Helper: serializza array string → SQL list (per evitare problemi di
    //   binding ::text[] di Drizzle quando l'array contiene stringhe non-uuid).
    const sqlList = (arr: string[]) =>
      sql.raw(arr.map((s) => `'${String(s).replace(/'/g, "''")}'`).join(","));

    const routesClause = routesFilter.length > 0
      ? sql` AND t.route_id IN (${sqlList(routesFilter)})`
      : sql``;

    // Estrai (route_id, hour del primo departure_time del trip)
    // Hour parsato da HH (può essere >24 per servizi notturni → mod 24 oppure 24-bucket)
    const rows = await db.execute(sql`
      WITH first_dep AS (
        SELECT t.route_id, t.trip_id,
          MIN(st.departure_time) AS dep
        FROM gtfs_trips t
        JOIN gtfs_stop_times st ON st.feed_id = t.feed_id AND st.trip_id = t.trip_id
        WHERE t.feed_id = ${id}
          AND t.service_id IN (${sqlList(serviceIds)})
          ${routesClause}
        GROUP BY t.route_id, t.trip_id
      )
      SELECT route_id,
             CASE
               WHEN dep IS NULL THEN -1
               ELSE LEAST(23, GREATEST(0, CAST(SPLIT_PART(dep, ':', 1) AS INT) % 24))
             END AS hour,
             COUNT(*)::int AS cnt
      FROM first_dep
      GROUP BY route_id, hour
    `);

    // Aggrega
    const map = new Map<string, number[]>();
    for (const r of rows.rows as any[]) {
      const rid = r.route_id;
      const h = Number(r.hour);
      if (h < 0 || h > 23) continue;
      if (!map.has(rid)) map.set(rid, Array(24).fill(0));
      map.get(rid)![h] = Number(r.cnt) || 0;
    }

    // Join coi nomi
    const routesMeta = await db.execute(sql`
      SELECT route_id, route_short_name, route_long_name, route_color
      FROM gtfs_routes WHERE feed_id = ${id}
    `);
    const metaMap = new Map((routesMeta.rows as any[]).map((r) => [r.route_id, r]));

    const result = Array.from(map.entries()).map(([routeId, perHour]) => {
      const m = metaMap.get(routeId) || {};
      return {
        routeId,
        shortName: m.route_short_name ?? null,
        longName:  m.route_long_name ?? null,
        color: m.route_color ?? null,
        perHour,
        total: perHour.reduce((s, x) => s + x, 0),
      };
    }).sort((a, b) => b.total - a.total);

    return res.json({ hours: Array.from({ length: 24 }, (_, i) => i), routes: result });
  } catch (e: any) {
    console.error("[planning] hourly-schedule error", e);
    return bad(res, e?.message || "Errore", 500);
  }
});

export default router;
