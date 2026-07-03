/**
 * ═══════════════════════════════════════════════════════════════════════════
 * STAMPA ORARI — sorgente: PROGRAMMA DI ESERCIZIO del progetto Planning Studio
 * ───────────────────────────────────────────────────────────────────────────
 * Legge dalle tabelle ps_* del progetto (NON dal feed GTFS):
 *   ps_routes / ps_route_variants / ps_variant_stops / ps_stops /
 *   ps_trips / ps_stop_times.
 *
 * Validità: il progetto classifica i giorni in DAY-TYPE (ps_day_types) e per
 * ogni corsa definisce la validità per day-type (ps_trip_day_validity). La
 * stampa filtra le corse per il day-type scelto (es. "Feriale Scuole Aperte").
 *
 *   GET /planning-studio/:projectId/timetables/routes
 *   GET /planning-studio/:projectId/timetables/route-stops?routeIds=a,b
 *   GET /planning-studio/:projectId/timetables/stops/search?q=
 *   GET /planning-studio/:projectId/timetables/route/:routeId?dayTypeId=&directionId=
 *   GET /planning-studio/:projectId/timetables/stop/:stopId?dayTypeId=
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { Router, type IRouter } from "express";
import { randomBytes } from "node:crypto";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { mergeStopPatterns } from "../lib/timetable-merge";

const router: IRouter = Router();

/** True se l'utente è owner o membro del progetto PS (admin sempre true). */
async function canAccessPsProject(projectId: string, req: any): Promise<boolean> {
  const u = req.user;
  if (!u) return false;
  if (u.role === "admin") return true;
  const r = await db.execute(sql`
    SELECT 1 FROM ps_projects p
      LEFT JOIN ps_project_members pm ON pm.project_id = p.id AND pm.user_id = ${u.id}::uuid
     WHERE p.id = ${projectId}::uuid
       AND (p.owner_user_id = ${u.id}::uuid OR pm.user_id IS NOT NULL) LIMIT 1`);
  return !!((r as any).rows?.length);
}

const UUID_RE = /^[0-9a-f-]{36}$/i;

/** lista SQL di uuid validati (per IN senza problemi di binding array) */
function uuidList(ids: string[]): string {
  return ids.filter((x) => UUID_RE.test(x)).map((x) => `'${x}'`).join(",");
}

/** Il progetto ha almeno una riga di validità corsa×day-type? */
async function projectHasTripValidity(projectId: string): Promise<boolean> {
  const r = await db.execute<any>(sql`
    SELECT EXISTS(
      SELECT 1 FROM ps_trip_day_validity v
      JOIN ps_trips t ON t.id = v.trip_id
      WHERE t.project_id = ${projectId}::uuid
    ) AS has`);
  return !!r.rows[0]?.has;
}

/** Nome del day-type (system globale o del progetto). */
async function dayTypeName(projectId: string, dayTypeId: string): Promise<string | null> {
  const r = await db.execute<any>(sql`
    SELECT name FROM ps_day_types
    WHERE id = ${dayTypeId}::uuid AND (project_id IS NULL OR project_id = ${projectId}::uuid)
    LIMIT 1`);
  return r.rows[0]?.name ?? null;
}

/**
 * Clausola SQL (stringa, per sql.raw) che filtra le corse `t` per validità.
 * - dayTypeId valido + il progetto usa la validità → EXISTS su ps_trip_day_validity.
 * - altrimenti nessun filtro (tutte le corse attive), con nota.
 */
function tripValidityClause(dayTypeId: string | null, hasValidity: boolean): { clause: string; note: string | null } {
  if (dayTypeId && hasValidity) {
    return {
      clause: `AND EXISTS (SELECT 1 FROM ps_trip_day_validity v
                 WHERE v.trip_id = t.id AND v.day_type_id = '${dayTypeId}' AND v.is_valid = true)`,
      note: null,
    };
  }
  if (dayTypeId && !hasValidity) {
    return { clause: "", note: "Validità per giorno non configurata sul progetto: mostrate tutte le corse attive" };
  }
  return { clause: "", note: null };
}

function parseDayTypeId(q: unknown): string | null {
  const s = String(q ?? "");
  return UUID_RE.test(s) ? s : null;
}

/** Punti città per lo sfondo schematico = TUTTI i cluster del progetto con
 *  centroide (interscambi + nodi logici): i "punti principali" per orientarsi. */
async function loadCityNodes(projectId: string): Promise<Array<{ name: string; lat: number; lon: number }>> {
  const r = await db.execute<any>(sql`
    SELECT name, center_lat, center_lon FROM ps_stop_clusters
    WHERE project_id = ${projectId}::uuid
      AND center_lat IS NOT NULL AND center_lon IS NOT NULL
    ORDER BY name`);
  return (r.rows as any[]).map((c) => ({ name: c.name, lat: c.center_lat, lon: c.center_lon }));
}

// ── GET /timetables/routes — linee del progetto ─────────────────────────────
router.get("/planning-studio/:projectId/timetables/routes", async (req, res): Promise<void> => {
  try {
    const projectId = String(req.params.projectId);
    if (!UUID_RE.test(projectId)) { res.status(400).json({ error: "projectId non valido" }); return; }
    const r = await db.execute<any>(sql`
      SELECT id, short_name, long_name, color
      FROM ps_routes WHERE project_id = ${projectId}::uuid
      ORDER BY sort_order, short_name`);
    res.json({
      projectId,
      routes: (r.rows as any[]).map((x) => ({
        routeId: x.id, routeShortName: x.short_name, routeLongName: x.long_name, routeColor: x.color,
      })),
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ── GET /timetables/route-stops?routeIds=a,b — fermate uniche delle linee ─────
router.get("/planning-studio/:projectId/timetables/route-stops", async (req, res): Promise<void> => {
  try {
    const projectId = String(req.params.projectId);
    if (!UUID_RE.test(projectId)) { res.status(400).json({ error: "projectId non valido" }); return; }
    const ids = String(req.query.routeIds ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const list = uuidList(ids);
    if (!list) { res.json({ stops: [] }); return; }
    const r = await db.execute<any>(sql.raw(`
      SELECT DISTINCT s.id AS stop_id, s.name AS stop_name, s.code AS stop_code
      FROM ps_variant_stops vs
      JOIN ps_route_variants v ON v.id = vs.variant_id AND v.project_id = '${projectId}'
      JOIN ps_stops s ON s.id = vs.stop_id
      WHERE v.route_id IN (${list})
      ORDER BY s.name
    `));
    res.json({
      projectId,
      stops: (r.rows as any[]).map((s) => ({ stopId: s.stop_id, stopName: s.stop_name, stopCode: s.stop_code })),
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ── GET /timetables/stops/search?q= — picker fermate ────────────────────────
router.get("/planning-studio/:projectId/timetables/stops/search", async (req, res): Promise<void> => {
  try {
    const projectId = String(req.params.projectId);
    if (!UUID_RE.test(projectId)) { res.status(400).json({ error: "projectId non valido" }); return; }
    const q = String(req.query.q ?? "").trim();
    if (q.length < 2) { res.json({ stops: [] }); return; }
    const r = await db.execute<any>(sql`
      SELECT s.id AS stop_id, s.name AS stop_name, s.code AS stop_code, s.lat, s.lon,
        ARRAY(
          SELECT DISTINCT rr.short_name
          FROM ps_variant_stops vs2
          JOIN ps_route_variants vv ON vv.id = vs2.variant_id
          JOIN ps_routes rr ON rr.id = vv.route_id
          WHERE vs2.stop_id = s.id
          LIMIT 15
        ) AS routes
      FROM ps_stops s
      WHERE s.project_id = ${projectId}::uuid AND s.name ILIKE ${`%${q}%`}
      ORDER BY s.name LIMIT 30`);
    res.json({
      projectId,
      stops: (r.rows as any[]).map((s) => ({
        stopId: s.stop_id, stopName: s.stop_name, stopCode: s.stop_code,
        lat: s.lat, lon: s.lon, routes: s.routes ?? [],
      })),
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ── GET /timetables/route/:routeId — orario generale di linea (ps_*) ─────────
router.get("/planning-studio/:projectId/timetables/route/:routeId", async (req, res): Promise<void> => {
  try {
    const projectId = String(req.params.projectId);
    const routeId = String(req.params.routeId);
    if (!UUID_RE.test(projectId) || !UUID_RE.test(routeId)) { res.status(400).json({ error: "ID non valido" }); return; }
    const dayTypeId = parseDayTypeId(req.query.dayTypeId);
    const dirRaw = req.query.directionId;
    const directionId = dirRaw === "0" || dirRaw === "1" ? Number(dirRaw) : null;

    const routeQ = await db.execute<any>(sql`
      SELECT id, short_name, long_name, color FROM ps_routes
      WHERE project_id = ${projectId}::uuid AND id = ${routeId}::uuid LIMIT 1`);
    const route = routeQ.rows[0];
    if (!route) { res.status(404).json({ error: "Linea non trovata" }); return; }

    const hasValidity = await projectHasTripValidity(projectId);
    const { clause: valClause, note } = tripValidityClause(dayTypeId, hasValidity);
    const dirClause = directionId === null ? "" : `AND t.direction = ${directionId}`;

    const rowsQ = await db.execute<any>(sql.raw(`
      SELECT t.id AS trip_id, COALESCE(t.headsign, v.headsign) AS headsign, t.direction,
             st.stop_id, st.stop_seq, st.departure_time, st.arrival_time,
             s.name AS stop_name
      FROM ps_trips t
      JOIN ps_route_variants v ON v.id = t.variant_id
      JOIN ps_stop_times st ON st.trip_id = t.id
      JOIN ps_stops s ON s.id = st.stop_id
      WHERE t.project_id = '${projectId}' AND t.route_id = '${routeId}'
        AND COALESCE(t.is_active, true) = true
        ${dirClause}
        ${valClause}
      ORDER BY t.id, st.stop_seq
    `));

    interface TripRow { tripId: string; headsign: string | null; directionId: number | null; stops: Array<{ stopId: string; stopName: string | null; time: string | null }> }
    const trips = new Map<string, TripRow>();
    for (const r of rowsQ.rows as any[]) {
      let t = trips.get(r.trip_id);
      if (!t) { t = { tripId: r.trip_id, headsign: r.headsign, directionId: r.direction, stops: [] }; trips.set(r.trip_id, t); }
      t.stops.push({ stopId: r.stop_id, stopName: r.stop_name, time: (r.departure_time ?? r.arrival_time ?? null) });
    }

    const master = mergeStopPatterns([...trips.values()].map((t) => t.stops));
    const masterIds = master.map((m) => m.stopId);

    // coordinate delle fermate master (per lo schematico octolineare della locandina)
    const coordList = uuidList(masterIds);
    const coordBy = new Map<string, any>();
    if (coordList) {
      const cQ = await db.execute<any>(sql.raw(`
        SELECT s.id, s.lat, s.lon, s.cluster_id,
               c.name AS cluster_name, c.center_lat, c.center_lon,
               COALESCE((c.attributes->>'isLogical')::boolean, false) AS cluster_logical
        FROM ps_stops s
        LEFT JOIN ps_stop_clusters c ON c.id = s.cluster_id
        WHERE s.id IN (${coordList})
      `));
      for (const r of cQ.rows as any[]) coordBy.set(r.id, r);
    }
    const masterWithCoords = master.map((m: any) => {
      const c = coordBy.get(m.stopId);
      return {
        stopId: m.stopId, stopName: m.stopName,
        lat: c?.lat ?? null, lon: c?.lon ?? null,
        clusterId: c?.cluster_id ?? null, clusterName: c?.cluster_name ?? null,
        clusterLogical: !!c?.cluster_logical,
        clusterLat: c?.center_lat ?? null, clusterLon: c?.center_lon ?? null,
      };
    });

    const tripList = [...trips.values()]
      .map((t) => {
        const timeBy = new Map(t.stops.map((s2) => [s2.stopId, s2.time]));
        return {
          tripId: t.tripId, headsign: t.headsign, directionId: t.directionId,
          firstTime: t.stops.find((s2) => s2.time)?.time ?? "99:99:99",
          times: masterIds.map((sId) => timeBy.get(sId)?.slice(0, 5) ?? null),
        };
      })
      .sort((a, b) => a.firstTime.localeCompare(b.firstTime));

    // PERCORSO PER IL DISEGNO = variante più esercitata (max n. corse), per la
    // direzione scelta. Gli orari (sopra) restano invece su TUTTE le corse.
    const domQ = await db.execute<any>(sql`
      SELECT t.variant_id FROM ps_trips t
      JOIN ps_route_variants v ON v.id = t.variant_id
      WHERE t.project_id = ${projectId}::uuid AND t.route_id = ${routeId}::uuid
        AND (${directionId}::int IS NULL OR v.direction = ${directionId}::int)
      GROUP BY t.variant_id
      ORDER BY COUNT(*) DESC, t.variant_id
      LIMIT 1`);
    const domVariant: string | null = domQ.rows[0]?.variant_id ?? null;
    let pathStops: any[] = [];
    if (domVariant) {
      const pQ = await db.execute<any>(sql`
        SELECT s.id AS stop_id, s.name, s.lat, s.lon, s.cluster_id,
               c.name AS cluster_name, c.center_lat, c.center_lon,
               COALESCE((c.attributes->>'isLogical')::boolean, false) AS cluster_logical
        FROM ps_variant_stops vs
        JOIN ps_stops s ON s.id = vs.stop_id
        LEFT JOIN ps_stop_clusters c ON c.id = s.cluster_id
        WHERE vs.variant_id = ${domVariant}::uuid
        ORDER BY vs.seq`);
      pathStops = (pQ.rows as any[]).map((r) => ({
        stopId: r.stop_id, stopName: r.name, lat: r.lat, lon: r.lon,
        clusterId: r.cluster_id, clusterName: r.cluster_name, clusterLogical: !!r.cluster_logical,
        clusterLat: r.center_lat, clusterLon: r.center_lon,
      }));
    }

    res.json({
      feedId: projectId,
      directionId,
      dayTypeId,
      dayTypeName: dayTypeId ? await dayTypeName(projectId, dayTypeId) : null,
      validityNote: note,
      route: { routeId: route.id, shortName: route.short_name, longName: route.long_name, color: route.color },
      stops: masterWithCoords,
      pathStops,
      cityNodes: await loadCityNodes(projectId),
      trips: tripList.map(({ firstTime: _f, ...t }) => t),
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ── GET /timetables/stop/:stopId — quadro di palina (ps_*) ───────────────────
router.get("/planning-studio/:projectId/timetables/stop/:stopId", async (req, res): Promise<void> => {
  try {
    const projectId = String(req.params.projectId);
    const stopId = String(req.params.stopId);
    if (!UUID_RE.test(projectId) || !UUID_RE.test(stopId)) { res.status(400).json({ error: "ID non valido" }); return; }
    const dayTypeId = parseDayTypeId(req.query.dayTypeId);

    const stopQ = await db.execute<any>(sql`
      SELECT id, name, code FROM ps_stops
      WHERE project_id = ${projectId}::uuid AND id = ${stopId}::uuid LIMIT 1`);
    const stop = stopQ.rows[0];
    if (!stop) { res.status(404).json({ error: "Fermata non trovata" }); return; }

    const hasValidity = await projectHasTripValidity(projectId);
    const { clause: valClause, note } = tripValidityClause(dayTypeId, hasValidity);

    // Partenze dalla fermata (escluso il capolinea d'arrivo)
    const depQ = await db.execute<any>(sql.raw(`
      SELECT st.departure_time, st.stop_seq, st.last_seq,
             COALESCE(t.headsign, v.headsign) AS trip_headsign,
             r.id AS route_id, r.short_name, r.long_name, r.color
      FROM (
        SELECT st.*, MAX(st.stop_seq) OVER (PARTITION BY st.trip_id) AS last_seq
        FROM ps_stop_times st
        WHERE st.trip_id IN (
          SELECT id FROM ps_trips WHERE project_id = '${projectId}' AND COALESCE(is_active,true) = true
        )
      ) st
      JOIN ps_trips t ON t.id = st.trip_id
      JOIN ps_route_variants v ON v.id = t.variant_id
      JOIN ps_routes r ON r.id = t.route_id
      WHERE st.stop_id = '${stopId}'
        AND st.departure_time IS NOT NULL
        AND st.stop_seq < st.last_seq
        ${valClause}
      ORDER BY r.short_name, st.departure_time
    `));

    interface Line {
      routeId: string; shortName: string | null; longName: string | null; color: string | null;
      headsigns: string[]; byHour: Map<number, Array<{ m: number; headsignIdx: number }>>; total: number;
    }
    const lines = new Map<string, Line>();
    for (const row of depQ.rows as any[]) {
      const mDep = /^(\d{1,2}):(\d{2})/.exec(String(row.departure_time));
      if (!mDep) continue;
      const hour = Number(mDep[1]) % 24;
      const minute = Number(mDep[2]);
      let line = lines.get(row.route_id);
      if (!line) {
        line = { routeId: row.route_id, shortName: row.short_name, longName: row.long_name, color: row.color, headsigns: [], byHour: new Map(), total: 0 };
        lines.set(row.route_id, line);
      }
      const hs = String(row.trip_headsign ?? "").trim();
      let hsIdx = line.headsigns.indexOf(hs);
      if (hsIdx < 0) { line.headsigns.push(hs); hsIdx = line.headsigns.length - 1; }
      if (!line.byHour.has(hour)) line.byHour.set(hour, []);
      line.byHour.get(hour)!.push({ m: minute, headsignIdx: hsIdx });
      line.total += 1;
    }

    res.json({
      feedId: projectId,
      dayTypeId,
      dayTypeName: dayTypeId ? await dayTypeName(projectId, dayTypeId) : null,
      validityNote: note,
      stop: { stopId: stop.id, stopName: stop.name, stopCode: stop.code },
      lines: [...lines.values()]
        .sort((a, b) => String(a.shortName ?? "").localeCompare(String(b.shortName ?? ""), "it", { numeric: true }))
        .map((l) => ({
          routeId: l.routeId, shortName: l.shortName, longName: l.longName, color: l.color,
          headsigns: l.headsigns, total: l.total,
          byHour: [...l.byHour.entries()].sort((a, b) => a[0] - b[0]).map(([hour, deps]) => ({
            hour, departures: deps.sort((a, b) => a.m - b.m).map((d) => ({ minute: d.m, headsignIdx: d.headsignIdx })),
          })),
        })),
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Calcolo della rete (variante più esercitata per linea + fermate con coordinate
// e cluster). Esportato per riuso nell'endpoint pubblico di condivisione.
export async function computeNetwork(projectId: string, routeIds: string[]): Promise<{ projectId: string; lines: any[]; cityNodes: Array<{ name: string; lat: number; lon: number }> }> {
  const list = uuidList(routeIds);
  if (!list) return { projectId, lines: [], cityNodes: [] };
  const varQ = await db.execute<any>(sql.raw(`
    SELECT q.route_id, q.short_name, q.long_name, q.color, q.variant_id
    FROM (
      SELECT r.id AS route_id, r.short_name, r.long_name, r.color, t.variant_id,
             ROW_NUMBER() OVER (PARTITION BY r.id ORDER BY COUNT(*) DESC, t.variant_id) AS rn
      FROM ps_routes r
      JOIN ps_trips t ON t.route_id = r.id
      WHERE r.project_id = '${projectId}' AND r.id IN (${list})
      GROUP BY r.id, r.short_name, r.long_name, r.color, t.variant_id
    ) q
    WHERE q.rn = 1
    ORDER BY q.short_name
  `));
  const variants = varQ.rows as any[];
  const vList = uuidList(variants.map((v) => v.variant_id));
  const stopsByVar = new Map<string, any[]>();
  if (vList) {
    const sQ = await db.execute<any>(sql.raw(`
      SELECT vs.variant_id, vs.seq, s.id AS stop_id, s.name, s.lat, s.lon,
             s.cluster_id,
             c.name AS cluster_name, c.center_lat, c.center_lon,
             COALESCE((c.attributes->>'isLogical')::boolean, false) AS cluster_logical
      FROM ps_variant_stops vs
      JOIN ps_stops s ON s.id = vs.stop_id
      LEFT JOIN ps_stop_clusters c ON c.id = s.cluster_id
      WHERE vs.variant_id IN (${vList})
      ORDER BY vs.variant_id, vs.seq
    `));
    for (const r of sQ.rows as any[]) {
      if (!stopsByVar.has(r.variant_id)) stopsByVar.set(r.variant_id, []);
      stopsByVar.get(r.variant_id)!.push({
        stopId: r.stop_id, name: r.name, lat: r.lat, lon: r.lon,
        clusterId: r.cluster_id, clusterName: r.cluster_name,
        clusterLogical: !!r.cluster_logical,
        clusterLat: r.center_lat, clusterLon: r.center_lon,
      });
    }
  }
  const lines = variants.map((v) => ({
    routeId: v.route_id, shortName: v.short_name, longName: v.long_name, color: v.color,
    stops: stopsByVar.get(v.variant_id) ?? [],
  })).sort((a, b) => String(a.shortName ?? "").localeCompare(String(b.shortName ?? ""), "it", { numeric: true }));
  return { projectId, lines, cityNodes: await loadCityNodes(projectId) };
}

// ── GET /timetables/network?routeIds=a,b — fermate ordinate + coordinate per linea
router.get("/planning-studio/:projectId/timetables/network", async (req, res): Promise<void> => {
  try {
    const projectId = String(req.params.projectId);
    if (!UUID_RE.test(projectId)) { res.status(400).json({ error: "projectId non valido" }); return; }
    const ids = String(req.query.routeIds ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    res.json(await computeNetwork(projectId, ids));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ── POST /planning-studio/:projectId/network-share — crea un link pubblico ───
router.post("/planning-studio/:projectId/network-share", async (req, res): Promise<void> => {
  try {
    const projectId = String(req.params.projectId);
    if (!UUID_RE.test(projectId)) { res.status(400).json({ error: "projectId non valido" }); return; }
    // IDOR fix: solo owner/membro può pubblicare un link PUBBLICO del progetto
    // (prima chiunque poteva creare un link permanente per un progetto altrui).
    if (!(await canAccessPsProject(projectId, req))) { res.status(404).json({ error: "Progetto non accessibile" }); return; }
    const routeIds: string[] = Array.isArray(req.body?.routeIds)
      ? req.body.routeIds.filter((x: any) => UUID_RE.test(String(x))) : [];
    if (!routeIds.length) { res.status(400).json({ error: "routeIds richiesti" }); return; }
    const title = typeof req.body?.title === "string" ? req.body.title.slice(0, 120) : null;
    // scadenza: expiresInDays (0/assente = senza scadenza)
    const days = Number(req.body?.expiresInDays);
    const expiresAt = Number.isFinite(days) && days > 0 ? new Date(Date.now() + days * 86_400_000).toISOString() : null;
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS ps_network_shares (
        token text PRIMARY KEY, project_id uuid NOT NULL,
        route_ids jsonb NOT NULL DEFAULT '[]'::jsonb, title text,
        options jsonb NOT NULL DEFAULT '{}'::jsonb, created_by uuid,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
    await db.execute(sql`ALTER TABLE ps_network_shares ADD COLUMN IF NOT EXISTS expires_at timestamptz`);
    // token CSPRNG non indovinabile (Math.random non è crittografico)
    const token = randomBytes(18).toString("base64url");
    const userId = (req as any).user?.id ?? null;
    await db.execute(sql`
      INSERT INTO ps_network_shares (token, project_id, route_ids, title, created_by, expires_at)
      VALUES (${token}, ${projectId}::uuid, ${JSON.stringify(routeIds)}::jsonb, ${title}, ${userId}::uuid, ${expiresAt}::timestamptz)`);
    res.json({ token, expiresAt });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
