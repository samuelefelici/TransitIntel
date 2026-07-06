/**
 * Planning Studio — Network Inspector (vista relazionale aggregata).
 *
 * Endpoints read-only che fanno join lato SQL per evitare N+1 dal client:
 *
 *   GET /projects/:id/routes/:routeId/detail
 *     → { route, agency, variants[], stops[] (uniche aggregate),
 *         tripCount, validity{from,to} }
 *
 *   GET /projects/:id/variants/:variantId/detail
 *     → { variant, route, stops[] (ordinate), shape, trips{count,sample} }
 *
 *   GET /projects/:id/stops/:stopId/detail
 *     → { stop, cluster, routes[] (con varianti che la toccano + tripCount),
 *         tripCount totale }
 */
import type { Request } from "express";
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const router: IRouter = Router();
const UUID_RE = /^[0-9a-f-]{36}$/i;

function getUserId(req: Request): string | null {
  return (req as any).session?.userId ?? (req as any).user?.id ?? null;
}
async function loadProject(projectId: string, userId: string): Promise<any | null> {
  const r = await db.execute(sql`
    SELECT p.*,
           CASE WHEN p.owner_user_id = ${userId}::uuid THEN 'owner'
                ELSE pm.role END AS my_role
      FROM ps_projects p
      LEFT JOIN ps_project_members pm
             ON pm.project_id = p.id AND pm.user_id = ${userId}::uuid
     WHERE p.id = ${projectId}::uuid
       AND (
         p.owner_user_id = ${userId}::uuid
         OR pm.user_id IS NOT NULL
         OR (p.materialized_feed_id IS NOT NULL
             AND EXISTS (SELECT 1 FROM gtfs_feeds gf
                          WHERE gf.id = p.materialized_feed_id AND gf.is_active = true))
       )
     LIMIT 1
  `);
  return (r as any).rows?.[0] ?? null;
}

/* ─── Route detail aggregato ─── */

router.get("/planning-studio/projects/:id/routes/:routeId/detail", async (req, res): Promise<void> => {
  const userId = getUserId(req);
  if (!userId) { res.status(401).json({ error: "auth required" }); return; }
  const proj = await loadProject(req.params.id, userId);
  if (!proj) { res.status(404).json({ error: "not found" }); return; }
  const projectId = req.params.id;
  const routeId = req.params.routeId;
  if (!UUID_RE.test(routeId)) { res.status(400).json({ error: "routeId invalid" }); return; }

  // 1. route
  const rRoute = await db.execute(sql`
    SELECT * FROM ps_routes
     WHERE id = ${routeId}::uuid AND project_id = ${projectId}::uuid LIMIT 1
  `);
  const route: any = (rRoute as any).rows?.[0];
  if (!route) { res.status(404).json({ error: "route not found" }); return; }

  // 2. variants con stop_count e trip_count
  const rVariants = await db.execute(sql`
    SELECT v.*,
           (SELECT COUNT(*) FROM ps_variant_stops vs WHERE vs.variant_id = v.id) AS stop_count,
           (SELECT COUNT(*) FROM ps_trips t WHERE t.variant_id = v.id) AS trip_count,
           (SELECT EXISTS(SELECT 1 FROM ps_shapes s WHERE s.variant_id = v.id)) AS has_shape
      FROM ps_variants v
     WHERE v.route_id = ${routeId}::uuid
     ORDER BY v.direction, v.is_default DESC, v.name
  `);

  // 3. fermate aggregate (uniche) toccate da una qualsiasi variante della linea
  const rStops = await db.execute(sql`
    SELECT s.id, s.code, s.name, s.lat, s.lon,
           COUNT(DISTINCT vs.variant_id) AS variant_count
      FROM ps_stops s
      JOIN ps_variant_stops vs ON vs.stop_id = s.id
      JOIN ps_variants v ON v.id = vs.variant_id
     WHERE v.route_id = ${routeId}::uuid
     GROUP BY s.id, s.code, s.name, s.lat, s.lon
     ORDER BY s.name
  `);

  // 4. validità (min/max validità trips) e total trip count
  const rValidity = await db.execute(sql`
    SELECT COUNT(*)::int AS trip_count,
           MIN(t.valid_from) AS valid_from,
           MAX(t.valid_to) AS valid_to,
           COUNT(*) FILTER (WHERE t.is_active = true)::int AS active_count
      FROM ps_trips t
      JOIN ps_variants v ON v.id = t.variant_id
     WHERE v.route_id = ${routeId}::uuid
  `);
  const v: any = (rValidity as any).rows?.[0] ?? {};

  // 5. agency: per ora solo a livello progetto (ps_projects.agency_name)
  //    ps_routes.agency_id è uno slot per future ps_agencies; lo restituiamo se esiste
  const agency = {
    id: route.agency_id ?? null,
    name: proj.agency_name ?? null,
    url: proj.agency_url ?? null,
    timezone: proj.agency_timezone ?? null,
  };

  res.json({
    route: {
      id: route.id, code: route.code, shortName: route.short_name, longName: route.long_name,
      description: route.description, routeType: route.route_type,
      color: route.color, textColor: route.text_color, sortOrder: route.sort_order,
      attributes: route.attributes ?? {},
    },
    agency,
    // Codice progressivo del percorso per linea: <codice linea>/<n>, con n
    // assegnato nell'ordine di visualizzazione (direction, default, nome).
    // La query è già ordinata così → l'indice dà il progressivo stabile.
    variants: ((rVariants as any).rows ?? []).map((r: any, i: number) => ({
      id: r.id, name: r.name,
      code: r.code || `${route.short_name || route.code || "L"}/${i + 1}`,
      direction: r.direction, headsign: r.headsign,
      isDefault: r.is_default,
      stopCount: Number(r.stop_count) || 0,
      tripCount: Number(r.trip_count) || 0,
      hasShape: !!r.has_shape,
    })),
    stops: ((rStops as any).rows ?? []).map((r: any) => ({
      id: r.id, code: r.code, name: r.name,
      lat: Number(r.lat), lon: Number(r.lon),
      variantCount: Number(r.variant_count) || 0,
    })),
    validity: {
      from: v.valid_from ?? null,
      to: v.valid_to ?? null,
    },
    tripCount: v.trip_count ?? 0,
    activeCount: v.active_count ?? 0,
  });
});

/* ─── Variant detail aggregato ─── */

router.get("/planning-studio/projects/:id/variants/:variantId/detail", async (req, res): Promise<void> => {
  const userId = getUserId(req);
  if (!userId) { res.status(401).json({ error: "auth required" }); return; }
  const proj = await loadProject(req.params.id, userId);
  if (!proj) { res.status(404).json({ error: "not found" }); return; }
  const projectId = req.params.id;
  const variantId = req.params.variantId;
  if (!UUID_RE.test(variantId)) { res.status(400).json({ error: "variantId invalid" }); return; }

  // 1. variant + route (+ progressivo per linea nell'ordine di visualizzazione)
  const rV = await db.execute(sql`
    SELECT v.*, r.id AS r_id, r.short_name AS r_short, r.long_name AS r_long,
           r.code AS r_code,
           r.color AS r_color, r.text_color AS r_text, r.route_type AS r_type,
           (SELECT 1 + COUNT(*) FROM ps_variants v2
              WHERE v2.route_id = v.route_id
                AND (v2.direction < v.direction
                  OR (v2.direction = v.direction AND v2.is_default AND NOT v.is_default)
                  OR (v2.direction = v.direction AND v2.is_default = v.is_default AND v2.name < v.name))
           ) AS variant_seq
      FROM ps_variants v
      JOIN ps_routes r ON r.id = v.route_id
     WHERE v.id = ${variantId}::uuid AND v.project_id = ${projectId}::uuid
     LIMIT 1
  `);
  const v: any = (rV as any).rows?.[0];
  if (!v) { res.status(404).json({ error: "variant not found" }); return; }

  // 2. fermate ordinate
  const rS = await db.execute(sql`
    SELECT vs.seq, vs.stop_id, s.code, s.name, s.lat, s.lon,
           vs.pickup_type, vs.drop_off_type, vs.timepoint, vs.shape_dist_traveled
      FROM ps_variant_stops vs
      JOIN ps_stops s ON s.id = vs.stop_id
     WHERE vs.variant_id = ${variantId}::uuid
     ORDER BY vs.seq
  `);

  // 3. shape
  const rShape = await db.execute(sql`
    SELECT id, mode, distance_m, duration_s
      FROM ps_shapes WHERE variant_id = ${variantId}::uuid LIMIT 1
  `);

  // 4. trips count + esempio (primi 5 con orario partenza)
  const rTrips = await db.execute(sql`
    SELECT t.id, t.headsign, t.short_name, t.valid_from, t.valid_to, t.is_active,
           t.calendar_id, c.code AS cal_code,
           (SELECT departure_time FROM ps_stop_times st
             WHERE st.trip_id = t.id ORDER BY st.stop_seq LIMIT 1) AS first_dep
      FROM ps_trips t
      LEFT JOIN ps_calendars c ON c.id = t.calendar_id
     WHERE t.variant_id = ${variantId}::uuid
     ORDER BY first_dep NULLS LAST
     LIMIT 50
  `);
  const rCount = await db.execute(sql`
    SELECT COUNT(*)::int AS c FROM ps_trips WHERE variant_id = ${variantId}::uuid
  `);

  res.json({
    variant: {
      id: v.id, name: v.name,
      code: v.code || `${v.r_short || v.r_code || "L"}/${v.variant_seq ?? 1}`,
      direction: v.direction, headsign: v.headsign,
      isDefault: v.is_default, attributes: v.attributes ?? {},
    },
    route: {
      id: v.r_id, shortName: v.r_short, longName: v.r_long,
      color: v.r_color, textColor: v.r_text, routeType: v.r_type,
    },
    stops: ((rS as any).rows ?? []).map((r: any) => ({
      seq: r.seq, stopId: r.stop_id, code: r.code, name: r.name,
      lat: Number(r.lat), lon: Number(r.lon),
      pickupType: r.pickup_type, dropOffType: r.drop_off_type,
      timepoint: r.timepoint, shapeDistTraveled: r.shape_dist_traveled,
    })),
    shape: ((rShape as any).rows?.[0]) ? {
      id: (rShape as any).rows[0].id,
      mode: (rShape as any).rows[0].mode,
      distanceM: (rShape as any).rows[0].distance_m,
      durationS: (rShape as any).rows[0].duration_s,
    } : null,
    trips: {
      total: (rCount as any).rows?.[0]?.c ?? 0,
      sample: ((rTrips as any).rows ?? []).map((t: any) => ({
        id: t.id, headsign: t.headsign, shortName: t.short_name,
        validFrom: t.valid_from, validTo: t.valid_to, isActive: t.is_active,
        calendarId: t.calendar_id, calendarCode: t.cal_code,
        firstDeparture: t.first_dep,
      })),
    },
  });
});

/* ─── Stop detail aggregato (linee/varianti che la toccano) ─── */

router.get("/planning-studio/projects/:id/stops/:stopId/detail", async (req, res): Promise<void> => {
  const userId = getUserId(req);
  if (!userId) { res.status(401).json({ error: "auth required" }); return; }
  const proj = await loadProject(req.params.id, userId);
  if (!proj) { res.status(404).json({ error: "not found" }); return; }
  const projectId = req.params.id;
  const stopId = req.params.stopId;
  if (!UUID_RE.test(stopId)) { res.status(400).json({ error: "stopId invalid" }); return; }

  // 1. stop
  const rS = await db.execute(sql`
    SELECT s.*, c.id AS c_id, c.code AS c_code, c.name AS c_name, c.kind AS c_kind
      FROM ps_stops s
      LEFT JOIN ps_clusters c ON c.id = s.cluster_id
     WHERE s.id = ${stopId}::uuid AND s.project_id = ${projectId}::uuid
     LIMIT 1
  `);
  const s: any = (rS as any).rows?.[0];
  if (!s) { res.status(404).json({ error: "stop not found" }); return; }

  // 2. linee + varianti che la toccano + n. corse per variante
  const rRoutes = await db.execute(sql`
    SELECT r.id AS route_id, r.short_name, r.long_name, r.color, r.text_color, r.route_type, r.code AS route_code,
           v.id AS variant_id, v.name AS variant_name, v.code AS variant_code, v.direction, v.headsign AS variant_headsign,
           (SELECT COUNT(*) FROM ps_trips t WHERE t.variant_id = v.id)::int AS trip_count,
           (SELECT 1 + COUNT(*) FROM ps_variants v2
              WHERE v2.route_id = v.route_id
                AND (v2.direction < v.direction
                  OR (v2.direction = v.direction AND v2.is_default AND NOT v.is_default)
                  OR (v2.direction = v.direction AND v2.is_default = v.is_default AND v2.name < v.name))
           ) AS variant_seq
      FROM ps_variant_stops vs
      JOIN ps_variants v ON v.id = vs.variant_id
      JOIN ps_routes r ON r.id = v.route_id
     WHERE vs.stop_id = ${stopId}::uuid
     ORDER BY r.short_name, v.direction, v.name
  `);

  // raggruppa per route
  const routesMap = new Map<string, any>();
  for (const row of ((rRoutes as any).rows ?? [])) {
    const rid = row.route_id;
    if (!routesMap.has(rid)) {
      routesMap.set(rid, {
        id: rid,
        shortName: row.short_name,
        longName: row.long_name,
        color: row.color,
        textColor: row.text_color,
        routeType: row.route_type,
        variants: [],
        totalTrips: 0,
      });
    }
    const e = routesMap.get(rid)!;
    e.variants.push({
      id: row.variant_id,
      name: row.variant_name,
      code: row.variant_code || `${row.short_name || row.route_code || "L"}/${row.variant_seq ?? 1}`,
      direction: row.direction,
      headsign: row.variant_headsign,
      tripCount: row.trip_count ?? 0,
    });
    e.totalTrips += row.trip_count ?? 0;
  }

  // 3. trip count totale che passa per la fermata
  const rTotal = await db.execute(sql`
    SELECT COUNT(DISTINCT t.id)::int AS c
      FROM ps_trips t
      JOIN ps_variant_stops vs ON vs.variant_id = t.variant_id
     WHERE vs.stop_id = ${stopId}::uuid
  `);

  res.json({
    stop: {
      id: s.id, code: s.code, name: s.name, description: s.description,
      lat: Number(s.lat), lon: Number(s.lon),
      zoneId: s.zone_id, locationType: s.location_type,
      parentStation: s.parent_station,
      wheelchairBoarding: s.wheelchair_boarding,
      platformCode: s.platform_code,
      attributes: s.attributes ?? {},
    },
    cluster: s.c_id ? {
      id: s.c_id, code: s.c_code, name: s.c_name, kind: s.c_kind,
    } : null,
    routes: Array.from(routesMap.values()),
    totalTripCount: (rTotal as any).rows?.[0]?.c ?? 0,
  });
});

export default router;
