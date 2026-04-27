/**
 * PlannerStudio — API routes
 * Scenari di pianificazione GTFS (single-tenant).
 * Endpoint sotto /api/planning
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import {
  planningScenarios,
  planningScenarioEdits,
  planningAnalysisResults,
  gtfsFeeds,
  gtfsFeedAnalysis,
  gtfsFeedEconomicParams,
  gtfsRoutes,
  gtfsShapes,
  gtfsTrips,
  censusSections,
  planningRouteClassifications,
  planningPois,
  pointsOfInterest,
  istatCommutingOd,
} from "@workspace/db/schema";
import { eq, desc, and, sql } from "drizzle-orm";
import { analyzeFeed, getOrCreateEconomicParams, DEFAULT_ECON } from "../lib/planning/feed-analyzer";

const router: IRouter = Router();

// ───────────────────────────── helpers ─────────────────────────────
function bad(res: Response, msg: string, code = 400) {
  return res.status(code).json({ error: msg });
}

// ───────────────────────────── scenari ─────────────────────────────

/** GET /api/planning/scenarios — lista scenari */
router.get("/planning/scenarios", async (_req: Request, res: Response) => {
  try {
    const rows = await db
      .select({
        id: planningScenarios.id,
        name: planningScenarios.name,
        description: planningScenarios.description,
        baselineFeedId: planningScenarios.baselineFeedId,
        mode: planningScenarios.mode,
        status: planningScenarios.status,
        summary: planningScenarios.summary,
        createdBy: planningScenarios.createdBy,
        createdAt: planningScenarios.createdAt,
        updatedAt: planningScenarios.updatedAt,
        baselineFeedName: gtfsFeeds.filename,
        baselineAgency: gtfsFeeds.agencyName,
      })
      .from(planningScenarios)
      .leftJoin(gtfsFeeds, eq(gtfsFeeds.id, planningScenarios.baselineFeedId))
      .orderBy(desc(planningScenarios.updatedAt));
    return res.json({ scenarios: rows });
  } catch (e: any) {
    console.error("[planning] list error", e);
    return bad(res, e?.message || "Errore lettura scenari", 500);
  }
});

/** POST /api/planning/scenarios — crea nuovo scenario */
router.post("/planning/scenarios", async (req: Request, res: Response) => {
  try {
    const { name, description, baselineFeedId, mode, economicParams, createdBy } = req.body || {};
    if (!name || typeof name !== "string") return bad(res, "name obbligatorio");
    if (!baselineFeedId) return bad(res, "baselineFeedId obbligatorio");
    if (mode && !["single", "ab"].includes(mode)) return bad(res, "mode non valido (single|ab)");

    // Verifica che il feed esista
    const feed = await db.select().from(gtfsFeeds).where(eq(gtfsFeeds.id, baselineFeedId)).limit(1);
    if (!feed.length) return bad(res, "GTFS feed non trovato", 404);

    const [created] = await db
      .insert(planningScenarios)
      .values({
        name: name.trim(),
        description: description ?? null,
        baselineFeedId,
        mode: mode ?? "ab",
        status: "draft",
        economicParams: economicParams ?? null,
        summary: { editsCount: 0, routesAffected: 0 },
        createdBy: createdBy ?? null,
      })
      .returning();

    return res.status(201).json({ scenario: created });
  } catch (e: any) {
    console.error("[planning] create error", e);
    return bad(res, e?.message || "Errore creazione scenario", 500);
  }
});

/** GET /api/planning/scenarios/:id — dettaglio scenario */
router.get("/planning/scenarios/:id", async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const [row] = await db
      .select()
      .from(planningScenarios)
      .where(eq(planningScenarios.id, id))
      .limit(1);
    if (!row) return bad(res, "Scenario non trovato", 404);

    // Conta edits
    const edits = await db
      .select()
      .from(planningScenarioEdits)
      .where(eq(planningScenarioEdits.scenarioId, id))
      .orderBy(desc(planningScenarioEdits.appliedAt))
      .limit(50);

    // Feed baseline info
    const [feed] = await db
      .select()
      .from(gtfsFeeds)
      .where(eq(gtfsFeeds.id, row.baselineFeedId))
      .limit(1);

    return res.json({ scenario: row, recentEdits: edits, baselineFeed: feed ?? null });
  } catch (e: any) {
    console.error("[planning] get error", e);
    return bad(res, e?.message || "Errore lettura scenario", 500);
  }
});

/** PATCH /api/planning/scenarios/:id — aggiorna metadati */
router.patch("/planning/scenarios/:id", async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const { name, description, status, economicParams, summary } = req.body || {};
    const patch: Record<string, any> = { updatedAt: new Date() };
    if (name !== undefined) patch.name = name;
    if (description !== undefined) patch.description = description;
    if (status !== undefined) {
      if (!["draft", "analyzing", "ready", "archived"].includes(status))
        return bad(res, "status non valido");
      patch.status = status;
    }
    if (economicParams !== undefined) patch.economicParams = economicParams;
    if (summary !== undefined) patch.summary = summary;

    const [updated] = await db
      .update(planningScenarios)
      .set(patch)
      .where(eq(planningScenarios.id, id))
      .returning();
    if (!updated) return bad(res, "Scenario non trovato", 404);
    return res.json({ scenario: updated });
  } catch (e: any) {
    console.error("[planning] patch error", e);
    return bad(res, e?.message || "Errore aggiornamento scenario", 500);
  }
});

/** DELETE /api/planning/scenarios/:id — elimina scenario (cascata su edits e analisi) */
router.delete("/planning/scenarios/:id", async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const result = await db
      .delete(planningScenarios)
      .where(eq(planningScenarios.id, id))
      .returning({ id: planningScenarios.id });
    if (!result.length) return bad(res, "Scenario non trovato", 404);
    return res.json({ ok: true });
  } catch (e: any) {
    console.error("[planning] delete error", e);
    return bad(res, e?.message || "Errore eliminazione scenario", 500);
  }
});

// ───────────────────────────── edits ─────────────────────────────

/** GET /api/planning/scenarios/:id/edits — lista edit log */
router.get("/planning/scenarios/:id/edits", async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const rows = await db
      .select()
      .from(planningScenarioEdits)
      .where(eq(planningScenarioEdits.scenarioId, id))
      .orderBy(desc(planningScenarioEdits.appliedAt));
    return res.json({ edits: rows });
  } catch (e: any) {
    console.error("[planning] edits list error", e);
    return bad(res, e?.message || "Errore lettura edits", 500);
  }
});

/** POST /api/planning/scenarios/:id/edits — registra una modifica */
router.post("/planning/scenarios/:id/edits", async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const { kind, targetType, targetGtfsId, payload, appliedBy } = req.body || {};
    if (!kind || typeof kind !== "string") return bad(res, "kind obbligatorio");
    if (payload === undefined) return bad(res, "payload obbligatorio");

    // Verifica scenario
    const [scn] = await db
      .select({ id: planningScenarios.id })
      .from(planningScenarios)
      .where(eq(planningScenarios.id, id))
      .limit(1);
    if (!scn) return bad(res, "Scenario non trovato", 404);

    const [edit] = await db
      .insert(planningScenarioEdits)
      .values({
        scenarioId: id,
        kind,
        targetType: targetType ?? null,
        targetGtfsId: targetGtfsId ?? null,
        payload,
        appliedBy: appliedBy ?? null,
      })
      .returning();

    // Touch scenario.updatedAt
    await db
      .update(planningScenarios)
      .set({ updatedAt: new Date() })
      .where(eq(planningScenarios.id, id));

    return res.status(201).json({ edit });
  } catch (e: any) {
    console.error("[planning] edit add error", e);
    return bad(res, e?.message || "Errore registrazione edit", 500);
  }
});

/** POST /api/planning/scenarios/:id/undo — annulla l'ultimo edit non già annullato */
router.post("/planning/scenarios/:id/undo", async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    // Trova l'ultimo edit non-undo che non sia già stato annullato
    const all = await db
      .select()
      .from(planningScenarioEdits)
      .where(eq(planningScenarioEdits.scenarioId, id))
      .orderBy(desc(planningScenarioEdits.appliedAt));

    const undone = new Set(all.filter((e) => e.kind === "undo" && e.undoOfEditId).map((e) => e.undoOfEditId!));
    const target = all.find((e) => e.kind !== "undo" && !undone.has(e.id));
    if (!target) return bad(res, "Niente da annullare", 400);

    const [undo] = await db
      .insert(planningScenarioEdits)
      .values({
        scenarioId: id,
        kind: "undo",
        targetType: target.targetType,
        targetGtfsId: target.targetGtfsId,
        payload: { undoneEditId: target.id, originalKind: target.kind },
        undoOfEditId: target.id,
      })
      .returning();

    return res.json({ undo, undoneEditId: target.id });
  } catch (e: any) {
    console.error("[planning] undo error", e);
    return bad(res, e?.message || "Errore undo", 500);
  }
});

// ───────────────────────────── analisi ─────────────────────────────

/** POST /api/planning/scenarios/:id/analyze — esegue (stub) un modulo di analisi */
router.post("/planning/scenarios/:id/analyze", async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const { module, inputParams } = req.body || {};
    if (!module || !["service_coverage", "demand_supply", "trip_utility", "economic"].includes(module)) {
      return bad(res, "module non valido");
    }

    const [scn] = await db
      .select()
      .from(planningScenarios)
      .where(eq(planningScenarios.id, id))
      .limit(1);
    if (!scn) return bad(res, "Scenario non trovato", 404);

    // STUB: produce un risultato fittizio. Layer 2/3 implementeranno i calcoli reali.
    const editsCount = await db
      .select()
      .from(planningScenarioEdits)
      .where(eq(planningScenarioEdits.scenarioId, id));

    const stubResult = {
      module,
      message: "Modulo di analisi non ancora implementato (Layer 3). Risultato stub.",
      kpis: {
        editsApplied: editsCount.length,
        baselineFeedId: scn.baselineFeedId,
      },
    };

    const [saved] = await db
      .insert(planningAnalysisResults)
      .values({
        scenarioId: id,
        module,
        inputParams: inputParams ?? null,
        result: stubResult,
        editsHash: `edits:${editsCount.length}`,
      })
      .returning();

    return res.json({ analysis: saved });
  } catch (e: any) {
    console.error("[planning] analyze error", e);
    return bad(res, e?.message || "Errore analisi", 500);
  }
});

/** GET /api/planning/scenarios/:id/analyses — risultati salvati */
router.get("/planning/scenarios/:id/analyses", async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const moduleFilter = (req.query.module as string | undefined) ?? null;
    const rows = await db
      .select()
      .from(planningAnalysisResults)
      .where(
        moduleFilter
          ? and(eq(planningAnalysisResults.scenarioId, id), eq(planningAnalysisResults.module, moduleFilter))
          : eq(planningAnalysisResults.scenarioId, id),
      )
      .orderBy(desc(planningAnalysisResults.computedAt));
    return res.json({ analyses: rows });
  } catch (e: any) {
    console.error("[planning] analyses list error", e);
    return bad(res, e?.message || "Errore lettura analisi", 500);
  }
});

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

/** GET /api/planning/feeds/:id/census-coverage?radius=300 — census sections nel bbox del feed con flag covered */
router.get("/planning/feeds/:id/census-coverage", async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const radiusM = Math.max(50, Math.min(2000, parseInt(String(req.query.radius ?? "300"), 10) || 300));
    const radiusKm = radiusM / 1000;

    // bbox dalle stops
    const bbox = await db.execute(sql`
      SELECT MIN(stop_lat) AS min_lat, MAX(stop_lat) AS max_lat,
             MIN(stop_lon) AS min_lon, MAX(stop_lon) AS max_lon
      FROM gtfs_stops WHERE feed_id = ${id}
    `);
    const b = bbox.rows[0] as any;
    if (!b || b.min_lat === null) return res.json({ sections: [] });

    const sections = await db.execute(sql`
      SELECT id, istat_code, centroid_lat, centroid_lng, population, density, area_km2
      FROM census_sections
      WHERE centroid_lat BETWEEN ${b.min_lat - 0.05} AND ${b.max_lat + 0.05}
        AND centroid_lng BETWEEN ${b.min_lon - 0.05} AND ${b.max_lon + 0.05}
        AND population > 0
      ORDER BY population DESC
      LIMIT 5000
    `);

    // per coverage: prendi stops e calcola haversine
    const stopsR = await db.execute(sql`
      SELECT stop_lat, stop_lon FROM gtfs_stops WHERE feed_id = ${id}
    `);
    const stops = (stopsR.rows as any[]).map(s => [s.stop_lat, s.stop_lon] as [number, number]);

    const EARTH_R_KM = 6371.0088;
    const hav = (la1: number, lo1: number, la2: number, lo2: number) => {
      const toRad = (d: number) => (d * Math.PI) / 180;
      const dLat = toRad(la2 - la1), dLon = toRad(lo2 - lo1);
      const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(la1)) * Math.cos(toRad(la2)) * Math.sin(dLon / 2) ** 2;
      return 2 * EARTH_R_KM * Math.asin(Math.sqrt(a));
    };

    const out = (sections.rows as any[]).map(s => {
      let covered = false;
      for (const [slat, slon] of stops) {
        if (hav(slat, slon, s.centroid_lat, s.centroid_lng) <= radiusKm) { covered = true; break; }
      }
      return {
        id: s.id,
        istatCode: s.istat_code,
        lat: s.centroid_lat,
        lng: s.centroid_lng,
        population: s.population,
        density: s.density,
        areaKm2: s.area_km2,
        covered,
      };
    });
    return res.json({ sections: out, radiusM });
  } catch (e: any) {
    console.error("[planning] census-coverage error", e);
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
async function ensureNewTables() {
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

// ─────────────── POI ───────────────

/** GET /api/planning/feeds/:id/pois */
router.get("/planning/feeds/:id/pois", async (req: Request, res: Response) => {
  try {
    await ensureNewTables();
    const id = String(req.params.id);
    const rows = await db
      .select()
      .from(planningPois)
      .where(eq(planningPois.feedId, id));
    return res.json({ pois: rows });
  } catch (e: any) {
    console.error("[planning] pois get error", e);
    return bad(res, e?.message || "Errore", 500);
  }
});

/** POST /api/planning/feeds/:id/pois — crea POI */
router.post("/planning/feeds/:id/pois", async (req: Request, res: Response) => {
  try {
    await ensureNewTables();
    const id = String(req.params.id);
    const { name, category, lat, lng, weight, notes } = req.body || {};
    if (!name || !category || typeof lat !== "number" || typeof lng !== "number") {
      return bad(res, "Campi obbligatori: name, category, lat, lng");
    }
    const [created] = await db
      .insert(planningPois)
      .values({
        feedId: id,
        name: String(name),
        category: String(category),
        lat,
        lng,
        weight: typeof weight === "number" ? weight : 1,
        notes: notes ?? null,
      })
      .returning();
    return res.status(201).json({ poi: created });
  } catch (e: any) {
    console.error("[planning] pois post error", e);
    return bad(res, e?.message || "Errore", 500);
  }
});

/** DELETE /api/planning/feeds/:id/pois/:poiId */
router.delete("/planning/feeds/:id/pois/:poiId", async (req: Request, res: Response) => {
  try {
    const poiId = String(req.params.poiId);
    await db.delete(planningPois).where(eq(planningPois.id, poiId));
    return res.json({ ok: true });
  } catch (e: any) {
    console.error("[planning] pois delete error", e);
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

    // POI dentro bbox + categorie scelte
    const poiR = await db.execute(sql`
      SELECT id, name, category, lat, lng
      FROM points_of_interest
      WHERE category = ANY(${cats}::text[])
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
    const serviceDate = req.query.serviceDate ? String(req.query.serviceDate) : null;
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

// ─────────────── Service coverage (popolazione + POI per giorno) ───────────────

/**
 * Matrice rilevanza POI × giorno settimana.
 * Indice array: 0=Lun ... 6=Dom
 * Valore: peso domanda (0 = irrilevante, 1 = normale, >1 = picco).
 * Categorie sconosciute → fallback DEFAULT_REL.
 */
const POI_DAY_RELEVANCE: Record<string, number[]> = {
  // Educazione: nessuna domanda nel weekend
  school:        [1.0, 1.0, 1.0, 1.0, 1.0, 0.0, 0.0],
  university:    [1.0, 1.0, 1.0, 1.0, 1.0, 0.2, 0.0],
  library:       [0.8, 0.8, 0.8, 0.8, 0.8, 0.6, 0.0],
  // Lavoro / PA
  office:        [1.0, 1.0, 1.0, 1.0, 1.0, 0.2, 0.0],
  government:    [1.0, 1.0, 1.0, 1.0, 1.0, 0.0, 0.0],
  bank:          [1.0, 1.0, 1.0, 1.0, 1.0, 0.3, 0.0],
  post_office:   [1.0, 1.0, 1.0, 1.0, 1.0, 0.4, 0.0],
  // Sanità: tutti i giorni
  hospital:      [1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0],
  clinic:        [1.0, 1.0, 1.0, 1.0, 1.0, 0.5, 0.2],
  doctor:        [1.0, 1.0, 1.0, 1.0, 1.0, 0.4, 0.0],
  pharmacy:      [1.0, 1.0, 1.0, 1.0, 1.0, 0.7, 0.4],
  // Spesa
  supermarket:   [1.0, 1.0, 1.0, 1.0, 1.0, 1.2, 0.5],
  shopping_mall: [0.9, 0.9, 0.9, 0.9, 1.0, 1.4, 1.0],
  marketplace:   [0.9, 0.9, 0.9, 0.9, 0.9, 1.3, 0.4],
  // Ristorazione / nightlife
  restaurant:    [0.6, 0.6, 0.6, 0.7, 1.0, 1.2, 1.0],
  fast_food:     [0.7, 0.7, 0.7, 0.8, 1.1, 1.2, 1.0],
  bar:           [0.6, 0.6, 0.6, 0.8, 1.2, 1.3, 0.8],
  cafe:          [0.9, 0.9, 0.9, 0.9, 1.0, 1.1, 0.9],
  // Culto
  church:        [0.2, 0.2, 0.2, 0.2, 0.3, 0.5, 1.6],
  place_of_worship: [0.2, 0.2, 0.2, 0.2, 0.3, 0.5, 1.6],
  // Cultura / svago
  museum:        [0.4, 0.9, 0.9, 0.9, 1.0, 1.3, 1.4],
  cinema:        [0.5, 0.5, 0.5, 0.6, 1.2, 1.5, 1.3],
  theatre:       [0.4, 0.5, 0.6, 0.7, 1.2, 1.5, 1.2],
  attraction:    [0.6, 0.7, 0.7, 0.7, 0.9, 1.4, 1.5],
  tourism:       [0.7, 0.7, 0.7, 0.7, 0.9, 1.4, 1.4],
  // Outdoor / sport
  park:          [0.5, 0.5, 0.5, 0.5, 0.7, 1.3, 1.5],
  stadium:       [0.3, 0.3, 0.3, 0.3, 0.6, 1.6, 1.6],
  sports_centre: [0.7, 0.8, 0.8, 0.9, 1.0, 1.4, 1.2],
  fitness_centre:[0.8, 0.8, 0.8, 0.8, 1.0, 1.1, 0.9],
  // Trasporti / hub
  transit:       [1.0, 1.0, 1.0, 1.0, 1.0, 0.8, 0.6],
  station:       [1.0, 1.0, 1.0, 1.0, 1.0, 0.9, 0.7],
  airport:       [1.0, 1.0, 1.0, 1.0, 1.1, 1.0, 0.9],
  // Servizi alla persona / anziani
  elderly:       [1.0, 1.0, 1.0, 1.0, 1.0, 0.8, 0.7],
  // ── Stagionali (vedi seasonMultiplier) ──
  beach:         [0.3, 0.3, 0.3, 0.3, 0.6, 1.6, 1.7],
  seaside:       [0.3, 0.3, 0.3, 0.3, 0.6, 1.6, 1.7],
  coast:         [0.3, 0.3, 0.3, 0.3, 0.6, 1.6, 1.7],
  swimming_pool: [0.7, 0.7, 0.7, 0.7, 0.9, 1.4, 1.5],
  water_park:    [0.4, 0.4, 0.4, 0.4, 0.7, 1.6, 1.7],
  ski_resort:    [0.4, 0.4, 0.4, 0.4, 0.7, 1.6, 1.7],
  // ── Alias categorie usate dai POI Google attuali (ATMA) ──
  worship:       [0.2, 0.2, 0.2, 0.2, 0.3, 0.5, 1.6],   // come church
  leisure:       [0.6, 0.6, 0.6, 0.7, 1.0, 1.4, 1.4],   // svago weekend ↑
  shopping:      [0.9, 0.9, 0.9, 0.9, 1.1, 1.4, 0.7],   // mercoledì/sab picco
  workplace:     [1.0, 1.0, 1.0, 1.0, 1.0, 0.2, 0.0],   // come office
  other:         [1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0],
};
const DEFAULT_REL = [1, 1, 1, 1, 1, 1, 1];

/** Categorie sensibili alla stagione: estive boost, invernali cut */
const SUMMER_BOOST: Record<string, number> = {
  beach: 1.5, seaside: 1.5, coast: 1.5, swimming_pool: 1.4, water_park: 1.6,
  tourism: 1.4, attraction: 1.3, park: 1.2, leisure: 1.15,
  ski_resort: 0.1,
};
const WINTER_BOOST: Record<string, number> = {
  beach: 0.2, seaside: 0.2, coast: 0.2, swimming_pool: 0.7, water_park: 0.1,
  tourism: 0.7, attraction: 0.85, park: 0.7, leisure: 0.95,
  ski_resort: 1.6,
  shopping_mall: 1.15, cinema: 1.1, theatre: 1.1, // shopping al chiuso
};

function seasonMultiplier(category: string, season: string): number {
  if (season === "summer") return SUMMER_BOOST[category] ?? 1;
  if (season === "winter") return WINTER_BOOST[category] ?? 1;
  return 1; // "all"
}

/** Ritorna il peso rilevanza per (categoria, dayIndex 0=Lun..6=Dom, stagione) */
function relevanceFor(category: string, dayIdx: number, season = "all"): number {
  const v = POI_DAY_RELEVANCE[category] ?? DEFAULT_REL;
  return (v[dayIdx] ?? 1) * seasonMultiplier(category, season);
}

/**
 * GET /api/planning/feeds/:id/service-coverage
 *
 * Misura quanto bene il servizio (per un dato giorno) soddisfa l'utenza:
 *  - popolazione raggiungibile a piedi da una fermata "attiva" quel giorno;
 *  - POI rilevanti per il giorno scelto raggiungibili a piedi.
 *
 * Query:
 *   dayType=weekday|saturday|sunday|all   (default weekday)
 *   serviceDate=YYYYMMDD                  (alternativa: data specifica)
 *   radiusM=400                           (raggio pedonale, default 400m ≈ 5min)
 *   minTrips=1                            (corse minime/giorno per ritenere la stop "attiva")
 *   windowFrom=00:00 windowTo=24:00       (finestra oraria, opz.)
 */
router.get("/planning/feeds/:id/service-coverage", async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const serviceDate = req.query.serviceDate ? String(req.query.serviceDate) : null;
    const rawDayType = String(req.query.dayType || "weekday").toLowerCase();
    const dayTypeAliases: Record<string, string> = {
      feriale: "weekday", weekday: "weekday", weekdays: "weekday",
      sabato: "saturday", saturday: "saturday",
      domenica: "sunday", sunday: "sunday",
      festivo: "sunday", tutti: "all", all: "all",
    };
    const dayType = dayTypeAliases[rawDayType] ?? "weekday";
    const radiusM = Math.max(50, Math.min(2000, Number(req.query.radiusM) || 400));
    const minTrips = Math.max(1, Number(req.query.minTrips) || 1);
    const windowFrom = String(req.query.windowFrom || "00:00");
    const windowTo = String(req.query.windowTo || "26:00"); // include over-midnight
    const seasonRaw = String(req.query.season || "all").toLowerCase();
    const season = ["summer","winter","all"].includes(seasonRaw) ? seasonRaw : "all";
    // Filtro routeIds (CSV) — se presente, considera solo i trip di quelle linee
    const routeIdsRaw = String(req.query.routeIds || "").trim();
    const routeIdsFilter: string[] = routeIdsRaw
      ? routeIdsRaw.split(",").map(s => s.trim()).filter(Boolean)
      : [];

    // --- Determina dayIdx (0=Lun .. 6=Dom) "rappresentativo" per la rilevanza POI
    let dayIdxForRelevance = 0;
    if (serviceDate) {
      const y = parseInt(serviceDate.slice(0, 4), 10);
      const m = parseInt(serviceDate.slice(4, 6), 10);
      const d = parseInt(serviceDate.slice(6, 8), 10);
      const jsDow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=dom..6=sab
      dayIdxForRelevance = (jsDow + 6) % 7; // → 0=Lun..6=Dom
    } else {
      dayIdxForRelevance = dayType === "saturday" ? 5 : dayType === "sunday" ? 6 : 0;
    }

    // --- Risolvi service_ids attivi quel giorno
    let serviceIds: string[] = [];
    if (serviceDate) {
      const y = parseInt(serviceDate.slice(0, 4), 10);
      const m = parseInt(serviceDate.slice(4, 6), 10);
      const d = parseInt(serviceDate.slice(6, 8), 10);
      const jsDate = new Date(Date.UTC(y, m - 1, d));
      const dow = jsDate.getUTCDay();
      const dowCol = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"][dow];
      const r1 = await db.execute(sql.raw(`
        SELECT DISTINCT service_id FROM gtfs_calendar
        WHERE feed_id = '${id.replace(/'/g, "''")}'
          AND start_date <= '${serviceDate}' AND end_date >= '${serviceDate}'
          AND ${dowCol} = 1
      `));
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
      const dowMap: Record<string, string[]> = {
        weekday:  ["monday","tuesday","wednesday","thursday","friday"],
        saturday: ["saturday"],
        sunday:   ["sunday"],
        all:      ["monday","tuesday","wednesday","thursday","friday","saturday","sunday"],
      };
      const targetDows = dowMap[dayType] ?? dowMap.weekday;
      const dowIdx: Record<string, number> = {
        sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
      };
      const targetDowIdxs = targetDows.map((d) => dowIdx[d]);
      const dowOrClause = targetDows.map((c) => `${c} = 1`).join(" OR ");
      const r1 = await db.execute(sql.raw(`
        SELECT DISTINCT service_id FROM gtfs_calendar
        WHERE feed_id = '${id.replace(/'/g, "''")}'
          AND (${dowOrClause})
      `));
      const r2 = await db.execute(sql.raw(`
        SELECT DISTINCT service_id FROM gtfs_calendar_dates
        WHERE feed_id = '${id.replace(/'/g, "''")}'
          AND exception_type = 1
          AND EXTRACT(DOW FROM TO_DATE(date, 'YYYYMMDD')) IN (${targetDowIdxs.join(",")})
      `));
      const set = new Set<string>();
      for (const x of r1.rows as any[]) set.add(x.service_id);
      for (const x of r2.rows as any[]) set.add(x.service_id);
      serviceIds = Array.from(set);
    }

    if (serviceIds.length === 0) {
      return res.json({
        meta: { dayType, serviceDate, radiusM, minTrips, season, dayIdx: dayIdxForRelevance, dayLabel: dayType === "saturday" ? "Sabato" : dayType === "sunday" ? "Domenica/festivo" : "Feriale", serviceIds: 0 },
        summary: { populationServed: 0, populationTotal: 0, coveragePct: 0,
                   poiServed: 0, poiTotal: 0, poiCoverageWeighted: 0,
                   activeStops: 0, totalStops: 0, totalTrips: 0, uncoveredPopulation: 0 },
        byCategory: [], byHour: [], stopsActive: [], coverageGeo: null, suggestions: [],
        warning: "Nessun service_id attivo per il giorno selezionato",
      });
    }

    const sqlList = (arr: string[]) =>
      sql.raw(arr.map((s) => `'${String(s).replace(/'/g, "''")}'`).join(","));

    // --- Stop attive quel giorno con conteggio corse (fascia oraria opz.)
    const windowClause = (windowFrom !== "00:00" || windowTo !== "26:00")
      ? sql` AND st.departure_time >= ${windowFrom} AND st.departure_time <= ${windowTo}`
      : sql``;
    const routeFilterClause = routeIdsFilter.length > 0
      ? sql` AND route_id IN (${sqlList(routeIdsFilter)})`
      : sql``;

    const stopsRows = await db.execute(sql`
      WITH active_trips AS (
        SELECT trip_id FROM gtfs_trips
        WHERE feed_id = ${id} AND service_id IN (${sqlList(serviceIds)})${routeFilterClause}
      ),
      stop_trips AS (
        SELECT st.stop_id, COUNT(DISTINCT st.trip_id)::int AS trips
        FROM gtfs_stop_times st
        JOIN active_trips at ON at.trip_id = st.trip_id
        WHERE st.feed_id = ${id}${windowClause}
        GROUP BY st.stop_id
      )
      SELECT s.stop_id, s.stop_name, s.stop_lat AS lat, s.stop_lon AS lon, COALESCE(stt.trips, 0) AS trips
      FROM gtfs_stops s
      LEFT JOIN stop_trips stt ON stt.stop_id = s.stop_id
      WHERE s.feed_id = ${id}
    `);

    const allStops = (stopsRows.rows as any[]).map(r => ({
      stopId: r.stop_id, stopName: r.stop_name,
      lat: Number(r.lat), lon: Number(r.lon), trips: Number(r.trips) || 0,
    })).filter(s => Number.isFinite(s.lat) && Number.isFinite(s.lon));
    const activeStops = allStops.filter(s => s.trips >= minTrips);
    const totalTrips = activeStops.reduce((s, x) => s + x.trips, 0);

    if (activeStops.length === 0) {
      return res.json({
        meta: { dayType, serviceDate, radiusM, minTrips, season, dayIdx: dayIdxForRelevance, dayLabel: dayType === "saturday" ? "Sabato" : dayType === "sunday" ? "Domenica/festivo" : "Feriale", serviceIds: serviceIds.length },
        summary: { populationServed: 0, populationTotal: 0, coveragePct: 0,
                   poiServed: 0, poiTotal: 0, poiCoverageWeighted: 0,
                   activeStops: 0, totalStops: allStops.length, totalTrips: 0, uncoveredPopulation: 0 },
        byCategory: [], byHour: [], stopsActive: [], coverageGeo: null, suggestions: [],
        warning: "Nessuna stop attiva con i filtri selezionati",
      });
    }

    // --- Bbox feed (con margine)
    let minLat = +Infinity, maxLat = -Infinity, minLon = +Infinity, maxLon = -Infinity;
    for (const s of allStops) {
      if (s.lat < minLat) minLat = s.lat;
      if (s.lat > maxLat) maxLat = s.lat;
      if (s.lon < minLon) minLon = s.lon;
      if (s.lon > maxLon) maxLon = s.lon;
    }
    const margin = 0.05;

    // --- Census sections nel bbox
    const censusRows = await db.execute(sql`
      SELECT istat_code, population, centroid_lat AS lat, centroid_lng AS lon
      FROM census_sections
      WHERE centroid_lat BETWEEN ${minLat - margin} AND ${maxLat + margin}
        AND centroid_lng BETWEEN ${minLon - margin} AND ${maxLon + margin}
        AND population > 0
    `);
    const census = (censusRows.rows as any[]).map(r => ({
      population: Number(r.population) || 0,
      lat: Number(r.lat), lon: Number(r.lon),
    })).filter(c => Number.isFinite(c.lat) && Number.isFinite(c.lon));

    // --- POI nel bbox
    const poiRows = await db.execute(sql`
      SELECT id, name, category, lat, lng AS lon
      FROM points_of_interest
      WHERE lat BETWEEN ${minLat - margin} AND ${maxLat + margin}
        AND lng BETWEEN ${minLon - margin} AND ${maxLon + margin}
    `);
    const pois = (poiRows.rows as any[]).map(r => ({
      id: r.id, name: r.name, category: String(r.category || "other"),
      lat: Number(r.lat), lon: Number(r.lon),
    })).filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lon));

    // --- Funzione distanza (haversine, m). Per perf: pre-calcoliamo
    //     conversione lat/lon → metri locali (planar approx) usando lat media.
    const latMean = (minLat + maxLat) / 2;
    const mPerLat = 111_320;
    const mPerLon = 111_320 * Math.cos((latMean * Math.PI) / 180);
    const radiusM2 = radiusM * radiusM;
    const stopXY = activeStops.map(s => ({
      ...s, x: s.lon * mPerLon, y: s.lat * mPerLat,
    }));

    function isCovered(lat: number, lon: number): boolean {
      const x = lon * mPerLon, y = lat * mPerLat;
      // Filtro bbox grossolano per perf
      const r = radiusM;
      for (const s of stopXY) {
        const dx = s.x - x; if (dx > r || dx < -r) continue;
        const dy = s.y - y; if (dy > r || dy < -r) continue;
        if (dx * dx + dy * dy <= radiusM2) return true;
      }
      return false;
    }

    // --- Popolazione coperta
    let populationTotal = 0, populationServed = 0;
    for (const c of census) {
      populationTotal += c.population;
      if (isCovered(c.lat, c.lon)) populationServed += c.population;
    }

    // --- POI coperti + breakdown per categoria (rilevanza pesata)
    type Cat = { category: string; total: number; served: number; relevance: number;
                 weightedTotal: number; weightedServed: number;
                 uncoveredCritical: { id: string; name: string | null; lat: number; lon: number; nearestStopM: number }[] };
    const byCatMap = new Map<string, Cat>();
    let poiTotal = 0, poiServed = 0, weightedTotal = 0, weightedServed = 0;

    // Helper: distanza stop più vicina (m), per i POI scoperti rilevanti
    function nearestStopM(lat: number, lon: number): number {
      const x = lon * mPerLon, y = lat * mPerLat;
      let best = Infinity;
      for (const s of stopXY) {
        const dx = s.x - x, dy = s.y - y;
        const d2 = dx * dx + dy * dy;
        if (d2 < best) best = d2;
      }
      return Math.sqrt(best);
    }

    for (const p of pois) {
      const rel = relevanceFor(p.category, dayIdxForRelevance, season);
      poiTotal++;
      const covered = isCovered(p.lat, p.lon);
      if (covered) poiServed++;
      weightedTotal += rel;
      if (covered) weightedServed += rel;

      let row = byCatMap.get(p.category);
      if (!row) {
        row = { category: p.category, total: 0, served: 0, relevance: rel,
                weightedTotal: 0, weightedServed: 0, uncoveredCritical: [] };
        byCatMap.set(p.category, row);
      }
      row.total++;
      row.weightedTotal += rel;
      if (covered) { row.served++; row.weightedServed += rel; }
      else if (rel >= 0.8) {
        // Traccia POI rilevanti scoperti per i suggerimenti (gap "facili")
        const dM = nearestStopM(p.lat, p.lon);
        if (dM <= radiusM * 4) { // entro 4× raggio = potenziale
          row.uncoveredCritical.push({
            id: p.id, name: p.name, lat: p.lat, lon: p.lon,
            nearestStopM: Math.round(dM),
          });
        }
      }
    }

    // --- POI NON serviti (TUTTI con qualche rilevanza, anche bassa) per la mappa "negativo"
    //     Include spiagge in qualsiasi stagione, ski_resort, ecc. — non filtra per distanza.
    const unservedPoisAll: { id: string; name: string | null; category: string;
                             lat: number; lon: number; relevance: number; nearestStopM: number }[] = [];
    for (const p of pois) {
      const rel = relevanceFor(p.category, dayIdxForRelevance, season);
      if (rel < 0.05) continue;            // categoria totalmente non rilevante quel giorno
      if (isCovered(p.lat, p.lon)) continue;
      const dM = nearestStopM(p.lat, p.lon);
      unservedPoisAll.push({
        id: p.id, name: p.name, category: p.category,
        lat: p.lat, lon: p.lon,
        relevance: Math.round(rel * 100) / 100,
        nearestStopM: Math.round(dM),
      });
    }
    unservedPoisAll.sort((a, b) =>
      (b.relevance - a.relevance) || (a.nearestStopM - b.nearestStopM)
    );
    const unservedPoisCap = unservedPoisAll.slice(0, 1500);

    const byCategory = Array.from(byCatMap.values())
      .map(r => ({
        category: r.category,
        relevance: Math.round(r.relevance * 100) / 100,
        total: r.total,
        served: r.served,
        servedPct: r.total > 0 ? Math.round((r.served / r.total) * 1000) / 10 : 0,
        weightedTotal: Math.round(r.weightedTotal * 10) / 10,
        weightedServed: Math.round(r.weightedServed * 10) / 10,
      }))
      // Mostra prima le categorie più rilevanti per il giorno scelto
      .sort((a, b) => (b.relevance * b.total) - (a.relevance * a.total));

    // --- POI rilevanti NON serviti: usato il blocco "unservedPoisAll" calcolato sopra direttamente nel POI loop.

    // --- Corse per ora del giorno (su tutte le stop attive: somma)
    const hourRouteFilter = routeIdsFilter.length > 0
      ? sql` AND t.route_id IN (${sqlList(routeIdsFilter)})`
      : sql``;
    const hourRows = await db.execute(sql`
      SELECT
        LEAST(23, GREATEST(0, CAST(SPLIT_PART(st.departure_time, ':', 1) AS INT) % 24)) AS hour,
        COUNT(DISTINCT t.trip_id)::int AS trips
      FROM gtfs_trips t
      JOIN gtfs_stop_times st ON st.feed_id = t.feed_id AND st.trip_id = t.trip_id
      WHERE t.feed_id = ${id}
        AND t.service_id IN (${sqlList(serviceIds)})${hourRouteFilter}
        AND st.stop_sequence = 1
      GROUP BY 1
      ORDER BY 1
    `);
    const tripsByHour = new Array(24).fill(0);
    for (const r of hourRows.rows as any[]) {
      const h = Number(r.hour);
      if (h >= 0 && h < 24) tripsByHour[h] = Number(r.trips) || 0;
    }
    const byHour = tripsByHour.map((trips, hour) => ({ hour, trips }));

    // --- Coverage GeoJSON (cerchi-buffer attorno alle stop attive)
    //     Ne facciamo uno per stop (semplici poligoni a 24 vertici).
    const coverageFeatures = activeStops.slice(0, 1500).map(s => {
      const coords: [number, number][] = [];
      const steps = 24;
      const dLat = radiusM / mPerLat;
      const dLon = radiusM / mPerLon;
      for (let i = 0; i <= steps; i++) {
        const ang = (i / steps) * 2 * Math.PI;
        coords.push([s.lon + Math.cos(ang) * dLon, s.lat + Math.sin(ang) * dLat]);
      }
      return {
        type: "Feature" as const,
        properties: { stopId: s.stopId, stopName: s.stopName, trips: s.trips },
        geometry: { type: "Polygon" as const, coordinates: [coords] },
      };
    });
    const coverageGeo = { type: "FeatureCollection" as const, features: coverageFeatures };

    // --- ENGINE SUGGERIMENTI: regole basate su gap reali
    type Suggestion = {
      severity: "high" | "med" | "low";
      kind: string;
      title: string;
      detail: string;
      action: string;
      data?: any;
    };
    const suggestions: Suggestion[] = [];

    // 1) Categorie rilevanti ma sottoservite
    const relevantUnderserved = byCategory
      .filter(c => c.relevance >= 1 && c.servedPct < 60 && c.total >= 5)
      .sort((a, b) => (b.relevance * b.total) - (a.relevance * a.total))
      .slice(0, 3);
    for (const c of relevantUnderserved) {
      const cat = byCatMap.get(c.category)!;
      const nearMisses = cat.uncoveredCritical
        .filter(u => u.nearestStopM <= radiusM * 2)
        .sort((a, b) => a.nearestStopM - b.nearestStopM)
        .slice(0, 5);
      suggestions.push({
        severity: c.servedPct < 40 ? "high" : "med",
        kind: "category-gap",
        title: `${c.category}: solo ${c.servedPct}% coperto (peso ${c.relevance.toFixed(2)}×)`,
        detail: `${c.total - c.served} POI di categoria "${c.category}" sono fuori dal raggio pedonale di ${radiusM}m. ${nearMisses.length} sono entro ${radiusM*2}m da una fermata esistente — sufficiente estendere il raggio o spostare la fermata.`,
        action: nearMisses.length > 0
          ? `Sposta o aggiungi una fermata vicino a: ${nearMisses.slice(0, 3).map(n => n.name || `(${n.lat.toFixed(4)},${n.lon.toFixed(4)})`).join(", ")}`
          : `Estendi il percorso di una linea esistente verso la zona ${c.category}`,
        data: { category: c.category, nearMisses },
      });
    }

    // 2) Stop attive con bassa frequenza in zona ad alta domanda
    const lowFreqStops = activeStops
      .filter(s => s.trips < 5)
      .map(s => {
        const x = s.lon * mPerLon, y = s.lat * mPerLat;
        let pop = 0;
        for (const c of census) {
          const dx = c.lon * mPerLon - x, dy = c.lat * mPerLat - y;
          if (dx * dx + dy * dy <= radiusM2) pop += c.population;
        }
        return { ...s, popNearby: pop };
      })
      .filter(s => s.popNearby > 500)
      .sort((a, b) => b.popNearby - a.popNearby)
      .slice(0, 5);
    if (lowFreqStops.length > 0) {
      suggestions.push({
        severity: "med",
        kind: "low-frequency",
        title: `${lowFreqStops.length} fermate con frequenza bassa in zone densamente popolate`,
        detail: `Fermate con < 5 corse/giorno che servono > 500 abitanti nel raggio ${radiusM}m. Esempio: "${lowFreqStops[0].stopName}" ha solo ${lowFreqStops[0].trips} corse e copre ${lowFreqStops[0].popNearby} persone.`,
        action: "Aumenta la frequenza della linea passante o aggiungi corse di rinforzo nelle ore di punta",
        data: { stops: lowFreqStops },
      });
    }

    // 3) Sezioni censuarie scoperte ma vicine al servizio (potenziale facile)
    const uncoveredSections: { lat: number; lon: number; pop: number; nearM: number }[] = [];
    for (const c of census) {
      if (isCovered(c.lat, c.lon)) continue;
      const dM = nearestStopM(c.lat, c.lon);
      if (dM <= radiusM * 2 && c.population >= 100) {
        uncoveredSections.push({ lat: c.lat, lon: c.lon, pop: c.population, nearM: Math.round(dM) });
      }
    }
    uncoveredSections.sort((a, b) => b.pop - a.pop);
    const top3 = uncoveredSections.slice(0, 3);
    if (top3.length > 0) {
      const totalPotential = uncoveredSections.reduce((s, x) => s + x.pop, 0);
      suggestions.push({
        severity: "high",
        kind: "uncovered-population",
        title: `${fmtNum0(totalPotential)} abitanti recuperabili con piccole estensioni`,
        detail: `${uncoveredSections.length} sezioni censuarie sono scoperte ma entro ${radiusM*2}m da una fermata esistente. Top 3 sezioni: ${top3.map(s => `${s.pop} ab. (${s.nearM}m dalla fermata)`).join(", ")}.`,
        action: `Estendi il raggio operativo (sposta fermata o aggiungi nuova fermata) — recupero potenziale ${(totalPotential / Math.max(1, populationTotal) * 100).toFixed(1)}% popolazione`,
        data: { sections: top3 },
      });
    }

    // 4) Drop weekend → suggerisci servizio dedicato (solo se siamo in feriale)
    if (dayType === "weekday") {
      const weekendCritical = byCategory
        .filter(c => ["hospital","pharmacy","clinic","worship","leisure","tourism"].includes(c.category) && c.relevance >= 1);
      if (weekendCritical.length >= 2) {
        suggestions.push({
          severity: "low",
          kind: "weekend-service",
          title: "Verifica il servizio festivo per categorie sensibili al weekend",
          detail: `Categorie come ${weekendCritical.slice(0,3).map(c=>c.category).join(", ")} mantengono o aumentano la rilevanza nel weekend. Confronta i KPI domenicali per assicurarti che le destinazioni critiche restino raggiungibili.`,
          action: "Apri questa pagina con dayType=sunday e confronta la copertura",
        });
      }
    }

    // 5) Stagione: se siamo in estate suggerisci coperture lungomare
    if (season === "summer") {
      const beachCats = byCategory.filter(c => ["beach","seaside","coast","tourism"].includes(c.category));
      const totalBeach = beachCats.reduce((s, c) => s + c.total, 0);
      const servedBeach = beachCats.reduce((s, c) => s + c.served, 0);
      if (totalBeach > 0 && servedBeach / totalBeach < 0.7) {
        suggestions.push({
          severity: "med",
          kind: "summer-beach",
          title: "Copertura turistica/balneare insufficiente",
          detail: `In estate solo ${Math.round(servedBeach/totalBeach*100)}% delle destinazioni turistiche/balneari (${servedBeach}/${totalBeach}) è raggiungibile a piedi da una fermata.`,
          action: "Considera una linea estiva stagionale lungomare o navette dedicate weekend",
        });
      }
    }

    // 6) OVERSERVICE: categorie con relevance ≈0 ma servizio alto
    //    = stiamo spendendo corse su POI chiusi/non rilevanti per quel giorno (es. uffici/scuole/fabbriche di domenica)
    const overserved = byCategory
      .filter(c => c.relevance <= 0.3 && c.served >= 5 && c.servedPct >= 60)
      .sort((a, b) => (a.relevance - b.relevance) || (b.served - a.served))
      .slice(0, 4);
    if (overserved.length > 0) {
      const dayLbl = ["lunedì","martedì","mercoledì","giovedì","venerdì","sabato","domenica"][dayIdxForRelevance];
      const seasonLbl = season === "summer" ? " (estate)" : season === "winter" ? " (inverno)" : "";
      const totalServed = overserved.reduce((s, c) => s + c.served, 0);
      suggestions.push({
        severity: "med",
        kind: "overservice",
        title: `Possibile sovra-servizio: ${totalServed} POI con domanda nulla/bassa il ${dayLbl}${seasonLbl}`,
        detail: `Categorie ${overserved.map(c => `"${c.category}" (peso ${c.relevance.toFixed(2)}×, ${c.servedPct}% coperto)`).join(", ")} sono ben servite ma generano poca domanda effettiva il ${dayLbl}. Le risorse impiegate qui potrebbero essere riallocate verso destinazioni con peso più alto.`,
        action: `Riduci frequenza/corse delle linee che servono prevalentemente queste destinazioni il ${dayLbl}, o riassegnale a categorie con peso alto`,
        data: { categories: overserved },
      });
    }

    // 7) MISMATCH STAGIONE: in estate POI invernali sovra-serviti / in inverno POI estivi sovra-serviti
    if (season === "summer") {
      const winterOver = byCategory.filter(c =>
        ["ski_resort"].includes(c.category) && c.served >= 3
      );
      if (winterOver.length > 0) {
        suggestions.push({
          severity: "low", kind: "season-mismatch",
          title: "Servizio invernale ancora attivo in estate",
          detail: `Categorie tipicamente invernali (${winterOver.map(c=>c.category).join(", ")}) risultano coperte: verifica se le corse stagionali sono ancora attive senza domanda.`,
          action: "Disattiva o riduci le corse dedicate a destinazioni invernali nel periodo estivo",
        });
      }
    } else if (season === "winter") {
      const summerOver = byCategory.filter(c =>
        ["beach","seaside","coast","water_park"].includes(c.category) && c.served >= 3
      );
      if (summerOver.length > 0) {
        suggestions.push({
          severity: "low", kind: "season-mismatch",
          title: "Servizio balneare/estivo ancora attivo in inverno",
          detail: `Categorie ${summerOver.map(c=>c.category).join(", ")} risultano servite ma in inverno hanno domanda quasi nulla.`,
          action: "Sospendi o riduci le corse stagionali estive durante l'inverno",
        });
      }
    }

    // 8) MISMATCH ORARIO domenica/festivo: troppe corse in fascia "lavorativa" (7-9) e poche pomeriggio/sera
    //    Segnale di un orario tarato sui giorni feriali, non sul weekend.
    if (dayIdxForRelevance === 6 || dayType === "sunday") {
      const morningPeak = tripsByHour.slice(7, 10).reduce((s, n) => s + n, 0); // 7-9
      const afternoon = tripsByHour.slice(15, 19).reduce((s, n) => s + n, 0);  // 15-18
      const evening = tripsByHour.slice(19, 23).reduce((s, n) => s + n, 0);    // 19-22
      const totalDayTrips = tripsByHour.reduce((s, n) => s + n, 0);
      if (totalDayTrips >= 30 && morningPeak > afternoon * 1.5 && morningPeak >= 20) {
        suggestions.push({
          severity: "med", kind: "schedule-mismatch-sunday",
          title: "Orario domenicale tarato sui giorni feriali",
          detail: `La domenica ci sono ${morningPeak} partenze tra le 7 e le 9 (fascia "lavoro/scuola") contro ${afternoon} nel pomeriggio (15-18) e ${evening} di sera (19-22). Il pattern suggerisce un orario non ottimizzato per la domanda festiva (svago, ristorazione, attività religiose, turismo).`,
          action: "Riduci le corse mattutine non necessarie e rinforza fasce 10-13 e 17-22 dove la domanda festiva è concentrata",
          data: { morningPeak, afternoon, evening },
        });
      }
      if (totalDayTrips >= 30 && evening < 5 && tripsByHour.slice(20, 24).reduce((s,n)=>s+n,0) < 3) {
        suggestions.push({
          severity: "low", kind: "no-evening-sunday",
          title: "Servizio serale domenicale assente o minimo",
          detail: `Solo ${evening} corse tra le 19 e le 22 la domenica: insufficiente per ristoranti, cinema, eventi. Categorie come "restaurant", "cinema", "leisure" mantengono buona rilevanza in questa fascia.`,
          action: "Aggiungi 2-4 corse serali domenicali su una linea principale che colleghi centro e zone di svago",
        });
      }
    }

    // 9) MISMATCH ORARIO sabato: spesso chiuso il pomeriggio in alcune categorie
    if (dayIdxForRelevance === 5) {
      const lateMorningTrips = tripsByHour.slice(10, 13).reduce((s, n) => s + n, 0);
      const earlyMorningTrips = tripsByHour.slice(6, 9).reduce((s, n) => s + n, 0);
      if (earlyMorningTrips >= 15 && lateMorningTrips < earlyMorningTrips * 0.6) {
        suggestions.push({
          severity: "low", kind: "schedule-mismatch-saturday",
          title: "Orario sabato sbilanciato sul mattino presto",
          detail: `Il sabato la fascia 6-9 ha ${earlyMorningTrips} partenze contro ${lateMorningTrips} nella 10-13, ma la domanda sabato si sposta più tardi (commercio, mercati, svago).`,
          action: "Bilancia le corse spostandone alcune dalla fascia 6-9 a 10-13",
        });
      }
    }

    // helper locale per number format senza dipendenze
    function fmtNum0(n: number) {
      return Math.round(n).toLocaleString("it-IT");
    }

    // --- ZONE NON SERVITE (negativo) per la mappa
    //     Ritorniamo i centroidi delle sezioni censuarie scoperte con popolazione > 0
    //     classificati per "criticità": severity high se >300 ab oppure entro 2× raggio.
    const uncoveredAreasAll: { lat: number; lon: number; pop: number; nearM: number;
                               severity: "high" | "med" | "low" }[] = [];
    for (const c of census) {
      if (c.population <= 0) continue;
      if (isCovered(c.lat, c.lon)) continue;
      const dM = nearestStopM(c.lat, c.lon);
      let sev: "high" | "med" | "low" = "low";
      if (c.population >= 300 && dM <= radiusM * 2) sev = "high";
      else if (c.population >= 150 || dM <= radiusM * 2) sev = "med";
      uncoveredAreasAll.push({
        lat: c.lat, lon: c.lon,
        pop: c.population,
        nearM: Math.round(dM),
        severity: sev,
      });
    }
    // Ordino per popolazione desc; cap a 2000 punti per non gonfiare il payload
    uncoveredAreasAll.sort((a, b) => b.pop - a.pop);
    const uncoveredAreas = uncoveredAreasAll.slice(0, 2000);

    // --- BILANCIAMENTO OFFERTA / DOMANDA su griglia (~700 m) per visualizzare
    //     dove sto servendo TROPPO (oversupply) o TROPPO POCO (undersupply).
    //     Per ogni cella calcoliamo:
    //       - supply  = somma corse delle stop attive che cadono nella cella + alone (radius)
    //       - demand  = popolazione + Σ(rel × peso) dei POI rilevanti nella cella + alone
    //     ratio = (supply/medianSupply) / (demand/medianDemand)
    //     >  +0.6 → red    (servizio in eccesso rispetto alla domanda relativa)
    //     in [-0.4..+0.4] → green (bilanciato)
    //     <  -0.4 → blue   (domanda non servita)
    const cellSizeM = Math.max(500, radiusM * 1.5);
    const cellLatStep = cellSizeM / mPerLat;
    const cellLonStep = cellSizeM / mPerLon;
    type Cell = { lat: number; lon: number; supply: number; demand: number; pop: number; poi: number };
    const cellMap = new Map<string, Cell>();

    function cellKey(lat: number, lon: number): { key: string; cLat: number; cLon: number } {
      const i = Math.floor((lat - minLat) / cellLatStep);
      const j = Math.floor((lon - minLon) / cellLonStep);
      const cLat = minLat + (i + 0.5) * cellLatStep;
      const cLon = minLon + (j + 0.5) * cellLonStep;
      return { key: `${i}:${j}`, cLat, cLon };
    }
    function getCell(lat: number, lon: number): Cell {
      const { key, cLat, cLon } = cellKey(lat, lon);
      let c = cellMap.get(key);
      if (!c) { c = { lat: cLat, lon: cLon, supply: 0, demand: 0, pop: 0, poi: 0 }; cellMap.set(key, c); }
      return c;
    }

    for (const s of activeStops) getCell(s.lat, s.lon).supply += s.trips;
    for (const c of census)      { const cell = getCell(c.lat, c.lon); cell.pop += c.population; cell.demand += c.population; }
    for (const p of pois) {
      const rel = relevanceFor(p.category, dayIdxForRelevance, season);
      if (rel < 0.05) continue;
      const cell = getCell(p.lat, p.lon);
      // Una persona-POI "vale" come ~50 abitanti per la stessa cella (calibrato grossolanamente)
      cell.poi += rel;
      cell.demand += rel * 50;
    }

    const cells = Array.from(cellMap.values()).filter(c => c.supply > 0 || c.demand > 100);
    // Calcoli mediane per normalizzare
    const sortedSupply = cells.map(c => c.supply).filter(v => v > 0).sort((a, b) => a - b);
    const sortedDemand = cells.map(c => c.demand).filter(v => v > 0).sort((a, b) => a - b);
    const medSupply = sortedSupply.length > 0 ? sortedSupply[Math.floor(sortedSupply.length / 2)] : 1;
    const medDemand = sortedDemand.length > 0 ? sortedDemand[Math.floor(sortedDemand.length / 2)] : 1;

    type BalCell = { lat: number; lon: number; supply: number; demand: number; pop: number;
                     score: number; status: "over" | "balanced" | "under" | "void"; sizeM: number };
    const balanceGrid: BalCell[] = cells.map(c => {
      const sNorm = c.supply / Math.max(medSupply, 1);
      const dNorm = c.demand / Math.max(medDemand, 1);
      // log-ratio simmetrico in [-1, +1] con saturazione
      const raw = Math.log((sNorm + 0.1) / (dNorm + 0.1));
      const score = Math.max(-1, Math.min(1, raw / 2));
      let status: BalCell["status"];
      if (c.supply <= 0 && c.demand >= 200) status = "void";
      else if (score > 0.4)  status = "over";
      else if (score < -0.4) status = "under";
      else status = "balanced";
      return {
        lat: c.lat, lon: c.lon,
        supply: Math.round(c.supply),
        demand: Math.round(c.demand),
        pop: Math.round(c.pop),
        score: Math.round(score * 100) / 100,
        status, sizeM: Math.round(cellSizeM),
      };
    });
    const overCells   = balanceGrid.filter(b => b.status === "over").length;
    const underCells  = balanceGrid.filter(b => b.status === "under").length;
    const voidCells   = balanceGrid.filter(b => b.status === "void").length;
    const balCells    = balanceGrid.filter(b => b.status === "balanced").length;

    // --- NARRATIVA testuale (paragrafetti pronti da mostrare in UI / report)
    const narrative: { kind: string; text: string; tone: "good" | "warn" | "bad" | "neutral" }[] = [];
    const dayLbl = ["lunedì","martedì","mercoledì","giovedì","venerdì","sabato","domenica"][dayIdxForRelevance];
    const seasonLbl = season === "summer" ? "in estate" : season === "winter" ? "in inverno" : "su base annuale";

    // overview
    {
      const covPct = populationTotal > 0 ? (populationServed / populationTotal) * 100 : 0;
      const tone: "good" | "warn" | "bad" | "neutral" =
        covPct >= 70 ? "good" : covPct >= 45 ? "warn" : "bad";
      narrative.push({
        kind: "overview", tone,
        text: `Il ${dayLbl} ${seasonLbl} il servizio analizzato copre il ${covPct.toFixed(1)}% della popolazione (${fmtNum0(populationServed)} su ${fmtNum0(populationTotal)} abitanti) con ${activeStops.length} fermate attive su ${allStops.length} totali e ${totalTrips} corse complessive.`,
      });
    }

    // POI panorama
    {
      const wPct = weightedTotal > 0 ? (weightedServed / weightedTotal) * 100 : 0;
      narrative.push({
        kind: "poi", tone: wPct >= 60 ? "good" : wPct >= 35 ? "warn" : "bad",
        text: `La copertura POI pesata sul giorno è ${wPct.toFixed(1)}% (${poiServed}/${poiTotal} POI raggiungibili a piedi). Le categorie con peso più alto ${dayLbl} sono: ${byCategory.filter(c => c.relevance >= 1).slice(0, 4).map(c => `${c.category} (${c.relevance.toFixed(1)}×, ${c.servedPct}%)`).join(", ") || "nessuna categoria critica"}.`,
      });
    }

    // gap principale
    if (uncoveredAreasAll.length > 0) {
      const top = uncoveredAreasAll.slice(0, 5);
      const popTop = top.reduce((s, x) => s + x.pop, 0);
      const totalUncoveredPop = uncoveredAreasAll.reduce((s, x) => s + x.pop, 0);
      narrative.push({
        kind: "uncovered", tone: "bad",
        text: `Restano ${fmtNum0(populationTotal - populationServed)} abitanti scoperti distribuiti su ${uncoveredAreasAll.length} sezioni censuarie. Le 5 zone più grandi totalizzano ${fmtNum0(popTop)} abitanti (${(popTop / Math.max(1, totalUncoveredPop) * 100).toFixed(0)}% dello scoperto).`,
      });
    }

    // bilanciamento
    if (balanceGrid.length > 5) {
      const totalCells = balanceGrid.length;
      narrative.push({
        kind: "balance", tone: overCells > underCells * 2 ? "warn" : "neutral",
        text: `Bilanciamento offerta/domanda su griglia ${Math.round(cellSizeM)} m: ${balCells} celle (${(balCells/totalCells*100).toFixed(0)}%) bilanciate, ${overCells} (${(overCells/totalCells*100).toFixed(0)}%) in sovra-offerta, ${underCells} (${(underCells/totalCells*100).toFixed(0)}%) sotto-servite, ${voidCells} (${(voidCells/totalCells*100).toFixed(0)}%) con domanda significativa e ZERO corse.`,
      });
      const topOver = balanceGrid.filter(b => b.status === "over").sort((a, b) => b.supply - a.supply).slice(0, 3);
      if (topOver.length > 0) {
        narrative.push({
          kind: "over-cells", tone: "warn",
          text: `Top zone in sovra-offerta: ${topOver.map(b => `(${b.lat.toFixed(3)},${b.lon.toFixed(3)}) supply=${b.supply} corse vs demand≈${b.demand}`).join(" — ")}. Possibili candidati a riduzione frequenza o riallocazione.`,
        });
      }
      const topVoid = balanceGrid.filter(b => b.status === "void").sort((a, b) => b.demand - a.demand).slice(0, 3);
      if (topVoid.length > 0) {
        narrative.push({
          kind: "void-cells", tone: "bad",
          text: `Top zone con domanda ma SENZA corse: ${topVoid.map(b => `(${b.lat.toFixed(3)},${b.lon.toFixed(3)}) pop=${b.pop}, demand=${b.demand}`).join(" — ")}. Sono le opportunità più alte per estendere il servizio.`,
        });
      }
    }

    // POI scoperti rilevanti per categoria — top 5 categorie
    if (unservedPoisCap.length > 0) {
      const byCat = new Map<string, number>();
      for (const u of unservedPoisCap) byCat.set(u.category, (byCat.get(u.category) ?? 0) + 1);
      const topCats = Array.from(byCat.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5);
      narrative.push({
        kind: "unserved-poi", tone: "warn",
        text: `${unservedPoisAll.length} POI rilevanti (peso ≥ 0.05×) sono fuori dal raggio pedonale di ${radiusM} m. Le categorie più colpite: ${topCats.map(([c, n]) => `${c} (${n})`).join(", ")}.`,
      });
    }

    // suggestion summary
    if (suggestions.length > 0) {
      const high = suggestions.filter(s => s.severity === "high").length;
      const med  = suggestions.filter(s => s.severity === "med").length;
      narrative.push({
        kind: "suggestions", tone: high > 0 ? "bad" : med > 0 ? "warn" : "neutral",
        text: `L'engine ha identificato ${suggestions.length} interventi (${high} ad alta priorità, ${med} a media). Vedi blocco "Interventi suggeriti" per il dettaglio.`,
      });
    }

    // --- ROUTE COMPARISON: se filtro linee attivo, calcolo baseline (rete completa) per delta
    let routeComparison: {
      filteredRoutes: string[];
      baselineCoveragePct: number;
      filteredCoveragePct: number;
      filteredContributionPct: number;
      populationOnlyOnFiltered: number;
      populationLostIfRemoved: number;
    } | undefined = undefined;

    if (routeIdsFilter.length > 0) {
      try {
        const cacheKey = `${id}|${dayType}|${serviceDate ?? ""}|${radiusM}|${season}`;
        const baseline = await getBaselineCoverage(cacheKey, async () => {
          // Stop attive su TUTTE le linee
          const baselineStops = await db.execute(sql`
            WITH active_trips AS (
              SELECT trip_id FROM gtfs_trips
              WHERE feed_id = ${id} AND service_id IN (${sqlList(serviceIds)})
            ),
            stop_trips AS (
              SELECT st.stop_id, COUNT(DISTINCT st.trip_id)::int AS trips
              FROM gtfs_stop_times st
              JOIN active_trips at ON at.trip_id = st.trip_id
              WHERE st.feed_id = ${id}
              GROUP BY st.stop_id
            )
            SELECT s.stop_lat AS lat, s.stop_lon AS lon, COALESCE(stt.trips, 0) AS trips
            FROM gtfs_stops s
            LEFT JOIN stop_trips stt ON stt.stop_id = s.stop_id
            WHERE s.feed_id = ${id}
          `);
          const allActive = (baselineStops.rows as any[])
            .map(r => ({ lat: Number(r.lat), lon: Number(r.lon), trips: Number(r.trips) || 0 }))
            .filter(s => s.trips >= minTrips && Number.isFinite(s.lat) && Number.isFinite(s.lon));
          const baseStopXY = allActive.map(s => ({ x: s.lon * mPerLon, y: s.lat * mPerLat }));
          const r2 = radiusM * radiusM;
          function baseCovered(lat: number, lon: number) {
            const x = lon * mPerLon, y = lat * mPerLat;
            for (const s of baseStopXY) {
              const dx = s.x - x; if (dx > radiusM || dx < -radiusM) continue;
              const dy = s.y - y; if (dy > radiusM || dy < -radiusM) continue;
              if (dx * dx + dy * dy <= r2) return true;
            }
            return false;
          }
          let basePopServed = 0;
          for (const c of census) if (baseCovered(c.lat, c.lon)) basePopServed += c.population;
          // Pop. servita SOLO da linee filtrate (coperta dal filtro ma non da rete - non filtro = non senso)
          // Invece: pop coperta dal filtro che NON è coperta dalla rete senza queste linee.
          // Approx: stop attive senza routes filtrate = baseline meno le routes filtrate.
          // Calcolo: l'insieme {non filtrate} = active_trips - filtrate. Lancio query inversa.
          const inverseStops = await db.execute(sql`
            WITH active_trips AS (
              SELECT trip_id FROM gtfs_trips
              WHERE feed_id = ${id}
                AND service_id IN (${sqlList(serviceIds)})
                AND route_id NOT IN (${sqlList(routeIdsFilter)})
            ),
            stop_trips AS (
              SELECT st.stop_id, COUNT(DISTINCT st.trip_id)::int AS trips
              FROM gtfs_stop_times st
              JOIN active_trips at ON at.trip_id = st.trip_id
              WHERE st.feed_id = ${id}
              GROUP BY st.stop_id
            )
            SELECT s.stop_lat AS lat, s.stop_lon AS lon, COALESCE(stt.trips, 0) AS trips
            FROM gtfs_stops s
            LEFT JOIN stop_trips stt ON stt.stop_id = s.stop_id
            WHERE s.feed_id = ${id}
          `);
          const inverseActive = (inverseStops.rows as any[])
            .map(r => ({ lat: Number(r.lat), lon: Number(r.lon), trips: Number(r.trips) || 0 }))
            .filter(s => s.trips >= minTrips && Number.isFinite(s.lat) && Number.isFinite(s.lon));
          const invStopXY = inverseActive.map(s => ({ x: s.lon * mPerLon, y: s.lat * mPerLat }));
          function invCovered(lat: number, lon: number) {
            const x = lon * mPerLon, y = lat * mPerLat;
            for (const s of invStopXY) {
              const dx = s.x - x; if (dx > radiusM || dx < -radiusM) continue;
              const dy = s.y - y; if (dy > radiusM || dy < -radiusM) continue;
              if (dx * dx + dy * dy <= r2) return true;
            }
            return false;
          }
          let popOnlyOnFiltered = 0;
          for (const c of census) {
            if (isCovered(c.lat, c.lon) && !invCovered(c.lat, c.lon)) popOnlyOnFiltered += c.population;
          }
          return { basePopServed, popOnlyOnFiltered };
        });

        const baselineCovPct = populationTotal > 0
          ? Math.round((baseline.basePopServed / populationTotal) * 1000) / 10 : 0;
        const filteredCovPct = populationTotal > 0
          ? Math.round((populationServed / populationTotal) * 1000) / 10 : 0;
        const contribPct = baseline.basePopServed > 0
          ? Math.round((populationServed / baseline.basePopServed) * 1000) / 10 : 0;
        routeComparison = {
          filteredRoutes: routeIdsFilter,
          baselineCoveragePct: baselineCovPct,
          filteredCoveragePct: filteredCovPct,
          filteredContributionPct: contribPct,
          populationOnlyOnFiltered: baseline.popOnlyOnFiltered,
          populationLostIfRemoved: baseline.popOnlyOnFiltered,
        };
      } catch (cmpErr) {
        console.warn("[planning] routeComparison failed:", cmpErr);
      }
    }

    return res.json({
      meta: {
        dayType,
        serviceDate,
        radiusM,
        minTrips,
        season,
        dayIdx: dayIdxForRelevance,
        dayLabel: dayType === "saturday" ? "Sabato" : dayType === "sunday" ? "Domenica/festivo" : "Feriale",
        serviceIds: serviceIds.length,
      },
      summary: {
        populationServed,
        populationTotal,
        coveragePct: populationTotal > 0
          ? Math.round((populationServed / populationTotal) * 1000) / 10 : 0,
        poiServed, poiTotal,
        poiServedPct: poiTotal > 0
          ? Math.round((poiServed / poiTotal) * 1000) / 10 : 0,
        poiCoverageWeighted: weightedTotal > 0
          ? Math.round((weightedServed / weightedTotal) * 1000) / 10 : 0,
        weightedTotal: Math.round(weightedTotal * 10) / 10,
        weightedServed: Math.round(weightedServed * 10) / 10,
        activeStops: activeStops.length,
        totalStops: allStops.length,
        totalTrips,
        uncoveredPopulation: populationTotal - populationServed,
      },
      byCategory,
      byHour,
      stopsActive: activeStops.map(s => ({
        stopId: s.stopId, stopName: s.stopName, lat: s.lat, lon: s.lon, trips: s.trips,
      })),
      coverageGeo,
      suggestions,
      unservedPois: unservedPoisCap,
      uncoveredAreas,
      balanceGrid,
      balanceSummary: { over: overCells, under: underCells, balanced: balCells, void: voidCells, cellSizeM: Math.round(cellSizeM) },
      narrative,
      routeComparison,
    });
  } catch (e: any) {
    console.error("[planning] service-coverage error", e);
    return bad(res, e?.message || "Errore", 500);
  }
});

// ─────────────── Cache in-memoria per baseline routeComparison (TTL 60s) ───────────────
const _baselineCache = new Map<string, { ts: number; value: { basePopServed: number; popOnlyOnFiltered: number } }>();
async function getBaselineCoverage(
  key: string,
  compute: () => Promise<{ basePopServed: number; popOnlyOnFiltered: number }>,
): Promise<{ basePopServed: number; popOnlyOnFiltered: number }> {
  const now = Date.now();
  const hit = _baselineCache.get(key);
  if (hit && now - hit.ts < 60_000) return hit.value;
  const value = await compute();
  _baselineCache.set(key, { ts: now, value });
  // pulizia opportunistica
  if (_baselineCache.size > 200) {
    for (const [k, v] of _baselineCache) if (now - v.ts > 60_000) _baselineCache.delete(k);
  }
  return value;
}

// ─────────────── Profilo di domanda oraria atteso (per preset) ───────────────
/**
 * GET /api/planning/feeds/:id/expected-hourly-demand
 *   ?preset=weekday-work|sat-shopping|sun-summer-coast|sun-winter-mall|evening-leisure|custom
 *   &dayType=...&season=...&poiCategories=csv (opz, per custom)
 *
 * Restituisce una "forma" 0..1 della domanda attesa per ora del giorno.
 */
function gauss(mu: number, sigma: number, amp: number) {
  return (x: number) => amp * Math.exp(-((x - mu) ** 2) / (2 * sigma * sigma));
}
function buildExpectedProfile(preset: string, poiCats: string[] = []): { profile: number[]; rationale: string } {
  const hours = Array.from({ length: 24 }, (_, h) => h);
  let curve: ((h: number) => number)[] = [];
  let rationale = "";
  switch (preset) {
    case "weekday-work":
      curve = [gauss(8, 1.2, 1.0), gauss(18, 1.4, 0.95), (h) => (h >= 10 && h <= 16 ? 0.35 : 0)];
      rationale = "Profilo pendolare: doppio picco mattino (7-9) e sera (17-19), plateau mediano in fascia diurna.";
      break;
    case "sat-shopping":
      curve = [gauss(11, 1.8, 0.85), gauss(17, 2.0, 1.0)];
      rationale = "Profilo commerciale del sabato: picco tardo-mattina e secondo picco pomeridiano.";
      break;
    case "sun-summer-coast":
      curve = [gauss(11, 1.6, 1.0), gauss(13, 1.5, 0.9), gauss(18, 2.5, 0.6)];
      rationale = "Profilo turistico estivo: forte concentrazione 10-13 verso il mare, coda fino a sera.";
      break;
    case "sun-winter-mall":
      curve = [(h) => (h >= 10 && h <= 20 ? 0.7 : 0), gauss(16, 1.6, 1.0)];
      rationale = "Profilo invernale festivo: plateau largo diurno, picco metà pomeriggio (centri commerciali, cinema).";
      break;
    case "evening-leisure":
      curve = [gauss(20, 2.5, 1.0), (h) => (h >= 22 ? 0.5 : 0)];
      rationale = "Profilo serale: picco 19-21, coda notturna ridotta.";
      break;
    case "custom":
    default: {
      // Composizione da categorie POI
      if (poiCats.length === 0) {
        curve = [gauss(8, 1.2, 1.0), gauss(18, 1.4, 0.95)];
        rationale = "Profilo generico (default pendolare): nessuna categoria specifica fornita.";
      } else {
        const parts: string[] = [];
        for (const cat of poiCats) {
          if (cat === "school" || cat === "university") {
            curve.push(gauss(8, 1.0, 1.0), gauss(14, 1.0, 0.9));
            parts.push("scuole");
          } else if (cat === "office" || cat === "workplace" || cat === "government") {
            curve.push(gauss(8, 1.2, 0.95), gauss(18, 1.4, 0.85));
            parts.push("uffici");
          } else if (cat === "shopping" || cat === "supermarket" || cat === "shopping_mall") {
            curve.push(gauss(11, 1.8, 0.7), gauss(17, 2.0, 0.9));
            parts.push("commercio");
          } else if (cat === "restaurant" || cat === "bar") {
            curve.push(gauss(13, 1.2, 0.6), gauss(20, 2.0, 0.95));
            parts.push("ristorazione");
          } else if (cat === "hospital" || cat === "clinic" || cat === "doctor") {
            curve.push((h) => (h >= 8 && h <= 19 ? 0.6 : 0));
            parts.push("sanità");
          } else if (cat === "beach" || cat === "seaside" || cat === "coast") {
            curve.push(gauss(11, 2.0, 1.0));
            parts.push("balneare");
          } else if (cat === "leisure" || cat === "tourism" || cat === "attraction") {
            curve.push(gauss(11, 2.0, 0.7), gauss(17, 2.0, 0.8));
            parts.push("svago");
          } else if (cat === "church" || cat === "worship" || cat === "place_of_worship") {
            curve.push(gauss(10, 0.8, 1.0), gauss(18, 1.0, 0.6));
            parts.push("culto");
          } else {
            curve.push((h) => (h >= 7 && h <= 20 ? 0.5 : 0));
          }
        }
        rationale = `Profilo composito basato su categorie: ${parts.join(", ")}.`;
      }
    }
  }
  // Somma e normalizza
  const raw = hours.map((h) => curve.reduce((s, fn) => s + fn(h), 0));
  const max = Math.max(...raw, 0.0001);
  const profile = raw.map((v) => Math.round((v / max) * 1000) / 1000);
  return { profile, rationale };
}

router.get("/planning/feeds/:id/expected-hourly-demand", async (req: Request, res: Response) => {
  try {
    const presetRaw = String(req.query.preset || "weekday-work");
    const validPresets = ["weekday-work","sat-shopping","sun-summer-coast","sun-winter-mall","evening-leisure","custom"];
    const preset = validPresets.includes(presetRaw) ? presetRaw : "weekday-work";
    const poiCats = String(req.query.poiCategories || "")
      .split(",").map((s) => s.trim()).filter(Boolean);
    const { profile, rationale } = buildExpectedProfile(preset, poiCats);
    const peakHours: number[] = [];
    for (let h = 0; h < 24; h++) if (profile[h] > 0.7) peakHours.push(h);
    return res.json({
      preset,
      hours: Array.from({ length: 24 }, (_, h) => h),
      expectedProfile: profile,
      peakHours,
      rationale,
      poiCategoriesUsed: preset === "custom" ? poiCats : null,
    });
  } catch (e: any) {
    console.error("[planning] expected-hourly-demand error", e);
    return bad(res, e?.message || "Errore", 500);
  }
});

export default router;
