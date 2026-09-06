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
import { computeWeekValidityByTrip } from "../lib/planning-studio-validity-eval";

const router: IRouter = Router();

/** True se l'utente è owner o membro del progetto PS (admin sempre true).
 *  Con allowOperational=true (endpoint di sola lettura) è visibile anche il
 *  programma di esercizio operativo — stessa semantica della lista progetti. */
async function canAccessPsProject(
  projectId: string, req: any, opts?: { allowOperational?: boolean },
): Promise<boolean> {
  const u = req.user;
  if (!u) return false;
  if (u.role === "admin") return true;
  const r = await db.execute(sql`
    SELECT 1 FROM ps_projects p
      LEFT JOIN ps_project_members pm ON pm.project_id = p.id AND pm.user_id = ${u.id}::uuid
      LEFT JOIN gtfs_feeds f ON f.id = p.materialized_feed_id
     WHERE p.id = ${projectId}::uuid
       AND (p.owner_user_id = ${u.id}::uuid OR pm.user_id IS NOT NULL
            OR (${opts?.allowOperational === true}
                AND p.materialized_feed_id IS NOT NULL AND COALESCE(f.is_active, false)))
     LIMIT 1`);
  return !!((r as any).rows?.length);
}

/** Gate di lettura per gli endpoint timetables: 400 su id malformato, 403 se
 *  il progetto non è né proprio né condiviso né operativo. */
async function requireTimetableRead(projectId: string, req: any, res: any): Promise<boolean> {
  if (!UUID_RE.test(String(projectId ?? ""))) {
    res.status(400).json({ error: "projectId non valido" });
    return false;
  }
  if (!(await canAccessPsProject(projectId, req, { allowOperational: true }))) {
    res.status(403).json({ error: "Accesso negato al progetto" });
    return false;
  }
  return true;
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
    if (!(await requireTimetableRead(projectId, req, res))) return;
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

// ── GET /timetables/day-types — day-type per le stampe (system + custom) ──────
// Lettura consentita a owner/membri e sul programma operativo (come le altre
// GET di stampa). Il CRUD dei day-type resta protetto nel router validità.
router.get("/planning-studio/:projectId/timetables/day-types", async (req, res): Promise<void> => {
  try {
    const projectId = String(req.params.projectId);
    if (!UUID_RE.test(projectId)) { res.status(400).json({ error: "projectId non valido" }); return; }
    if (!(await requireTimetableRead(projectId, req, res))) return;
    const r = await db.execute<any>(sql`
      SELECT id, project_id, code, name, color, is_system, is_custom, sort_order
        FROM ps_day_types
       WHERE project_id IS NULL OR project_id = ${projectId}::uuid
       ORDER BY sort_order ASC, name ASC`);
    res.json({
      dayTypes: (r.rows as any[]).map((d) => ({
        id: d.id, projectId: d.project_id, code: d.code, name: d.name, color: d.color,
        isSystem: !!d.is_system, isCustom: !!d.is_custom, sortOrder: d.sort_order,
      })),
    });
  } catch {
    // tabelle validità non ancora create sul progetto → nessun day-type
    res.json({ dayTypes: [] });
  }
});

// ── GET /timetables/route-stops?routeIds=a,b — fermate uniche delle linee ─────
router.get("/planning-studio/:projectId/timetables/route-stops", async (req, res): Promise<void> => {
  try {
    const projectId = String(req.params.projectId);
    if (!UUID_RE.test(projectId)) { res.status(400).json({ error: "projectId non valido" }); return; }
    if (!(await requireTimetableRead(projectId, req, res))) return;
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
    if (!(await requireTimetableRead(projectId, req, res))) return;
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
    if (!(await requireTimetableRead(projectId, req, res))) return;
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
             t.attributes AS attributes,
             v.code AS variant_code,
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

    interface TripRow { tripId: string; headsign: string | null; directionId: number | null; variantCode: string | null; attributes: any; stops: Array<{ stopId: string; stopName: string | null; time: string | null }> }
    const trips = new Map<string, TripRow>();
    for (const r of rowsQ.rows as any[]) {
      let t = trips.get(r.trip_id);
      if (!t) { t = { tripId: r.trip_id, headsign: r.headsign, directionId: r.direction, variantCode: r.variant_code ?? null, attributes: r.attributes ?? {}, stops: [] }; trips.set(r.trip_id, t); }
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

    // Validità per corsa dal calendario aziendale di Planner Studio:
    // day-type (feriale/sabato/festivo/custom) + macro-categoria (es. Scuole
    // aperte). Servono alla stampa locandine per raggruppare e per marcare le
    // corse feriali NON effettuate il sabato ("Escluso il sabato").
    const tripIdsList = uuidList([...trips.keys()]);
    const dayCodesByTrip = new Map<string, string[]>();
    const categoryIdsByTrip = new Map<string, string[]>();
    const categoriesInfo: Array<{ id: string; code: string; name: string; color: string | null }> = [];
    if (tripIdsList) {
      try {
        const dv = await db.execute<any>(sql.raw(`
          SELECT v.trip_id, dt.code
          FROM ps_trip_day_validity v
          JOIN ps_day_types dt ON dt.id = v.day_type_id
          WHERE v.is_valid = true AND v.trip_id IN (${tripIdsList})
        `));
        for (const r of dv.rows as any[]) {
          const a = dayCodesByTrip.get(r.trip_id) ?? [];
          if (!a.includes(r.code)) a.push(r.code);
          dayCodesByTrip.set(r.trip_id, a);
        }
      } catch { /* tabelle validità non ancora create sul progetto */ }
      try {
        const cv = await db.execute<any>(sql.raw(`
          SELECT cv.trip_id, c.id, c.code, c.name, c.color, c.sort_order
          FROM ps_trip_category_validity cv
          JOIN ps_validity_categories c ON c.id = cv.category_id
          WHERE cv.trip_id IN (${tripIdsList})
          ORDER BY c.sort_order, c.name
        `));
        const seenCat = new Set<string>();
        for (const r of cv.rows as any[]) {
          const a = categoryIdsByTrip.get(r.trip_id) ?? [];
          if (!a.includes(r.id)) a.push(r.id);
          categoryIdsByTrip.set(r.trip_id, a);
          if (!seenCat.has(r.id)) { seenCat.add(r.id); categoriesInfo.push({ id: r.id, code: r.code, name: r.name, color: r.color }); }
        }
      } catch { /* tabelle categorie non ancora create */ }
    }

    const tripList = [...trips.values()]
      .map((t) => {
        const timeBy = new Map(t.stops.map((s2) => [s2.stopId, s2.time]));
        return {
          tripId: t.tripId, headsign: t.headsign, directionId: t.directionId,
          // Il CODICE PERCORSO della variante segue la corsa: serve alle viste
          // (elenco corse, locandine) e ad Argos per ragionare per percorso.
          variantCode: t.variantCode,
          firstTime: t.stops.find((s2) => s2.time)?.time ?? "99:99:99",
          // Arrivo AUTOREVOLE (ultima fermata per stop_seq): partenza/arrivo
          // NON vanno dedotti dal vettore `times`, che è allineato al master —
          // e il master, quando si fondono le due direzioni (nessun
          // directionId), contiene cicli (A dice X→Y, R dice Y→X):
          // l'ordinamento topologico si spezza, il ripiego appende in ordine
          // di apparizione e il primo/ultimo valore del vettore non è più il
          // primo/ultimo transito. I consumatori (Argos, viste) devono usare
          // firstTime/lastTime, mai gli estremi di `times`.
          lastTime: [...t.stops].reverse().find((s2) => s2.time)?.time ?? null,
          times: masterIds.map((sId) => timeBy.get(sId)?.slice(0, 5) ?? null),
          dayTypeCodes: dayCodesByTrip.get(t.tripId) ?? [],
          categoryIds: categoryIdsByTrip.get(t.tripId) ?? [],
          onDemand: !!t.attributes?.onDemand,
          weekdays: Array.isArray(t.attributes?.weekdays) && t.attributes.weekdays.length === 7
            ? t.attributes.weekdays.map((x: any) => x !== false) : null,
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
      categories: categoriesInfo,
      // firstTime resta nella risposta (prima serviva solo all'ordinamento e
      // veniva tolto): senza, chi legge ripiega sugli estremi di `times`, che
      // col master fuso delle due direzioni davano «partenza 08:01, arrivo 07:59».
      trips: tripList.map((t) => ({ ...t, firstTime: t.firstTime === "99:99:99" ? null : t.firstTime })),
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ── GET /timetables/route/:routeId/week — ORARIO UNICO per CALENDARIO ─────────
// Tutte le corse della linea che circolano nella categoria scelta (Scuole
// Aperte / Scuole Chiuse / …), con per ciascuna il vettore Lun→Dom di validità
// (giorni reali del calendario aziendale) + flag a chiamata → una sola tabella.
router.get("/planning-studio/:projectId/timetables/route/:routeId/week", async (req, res): Promise<void> => {
  try {
    const projectId = String(req.params.projectId);
    const routeId = String(req.params.routeId);
    if (!UUID_RE.test(projectId) || !UUID_RE.test(routeId)) { res.status(400).json({ error: "ID non valido" }); return; }
    if (!(await requireTimetableRead(projectId, req, res))) return;
    const categoryCode = typeof req.query.category === "string" ? req.query.category : "";
    const dirRaw = req.query.directionId;
    const directionId = dirRaw === "0" || dirRaw === "1" ? Number(dirRaw) : null;

    const routeQ = await db.execute<any>(sql`
      SELECT id, short_name, long_name, color FROM ps_routes
      WHERE project_id = ${projectId}::uuid AND id = ${routeId}::uuid LIMIT 1`);
    const route = routeQ.rows[0];
    if (!route) { res.status(404).json({ error: "Linea non trovata" }); return; }

    const dirClause = directionId === null ? "" : `AND t.direction = ${directionId}`;
    const rowsQ = await db.execute<any>(sql.raw(`
      SELECT t.id AS trip_id, COALESCE(t.headsign, v.headsign) AS headsign, t.direction,
             t.attributes AS attributes,
             st.stop_id, st.stop_seq, st.departure_time, st.arrival_time, s.name AS stop_name
      FROM ps_trips t
      JOIN ps_route_variants v ON v.id = t.variant_id
      JOIN ps_stop_times st ON st.trip_id = t.id
      JOIN ps_stops s ON s.id = st.stop_id
      WHERE t.project_id = '${projectId}' AND t.route_id = '${routeId}'
        AND COALESCE(t.is_active, true) = true
        AND COALESCE((t.attributes->>'prototype')::boolean, false) = false
        ${dirClause}
      ORDER BY t.id, st.stop_seq
    `));
    interface WTrip { tripId: string; headsign: string | null; directionId: number | null; attributes: any; stops: Array<{ stopId: string; stopName: string | null; time: string | null }> }
    const trips = new Map<string, WTrip>();
    for (const r of rowsQ.rows as any[]) {
      let t = trips.get(r.trip_id);
      if (!t) { t = { tripId: r.trip_id, headsign: r.headsign, directionId: r.direction, attributes: r.attributes ?? {}, stops: [] }; trips.set(r.trip_id, t); }
      t.stops.push({ stopId: r.stop_id, stopName: r.stop_name, time: (r.departure_time ?? r.arrival_time ?? null) });
    }
    const master = mergeStopPatterns([...trips.values()].map((t) => t.stops));
    const masterIds = master.map((m) => m.stopId);

    // validità Lun→Dom di ogni corsa dentro la categoria (logica autoritativa 5C)
    const { repDates, daysByTrip } = await computeWeekValidityByTrip(projectId, categoryCode, [...trips.keys()]);

    const tripList = [...trips.values()]
      .map((t) => {
        const timeBy = new Map(t.stops.map((s2) => [s2.stopId, s2.time]));
        return {
          tripId: t.tripId, headsign: t.headsign, directionId: t.directionId,
          firstTime: t.stops.find((s2) => s2.time)?.time ?? "99:99:99",
          // vedi sopra: l'arrivo si legge da qui, mai dagli estremi di `times`
          lastTime: [...t.stops].reverse().find((s2) => s2.time)?.time ?? null,
          times: masterIds.map((sId) => timeBy.get(sId)?.slice(0, 5) ?? null),
          onDemand: !!t.attributes?.onDemand,
          days: daysByTrip.get(t.tripId) ?? [false, false, false, false, false, false, false],
        };
      })
      // solo le corse che circolano almeno un giorno nel periodo scelto
      .filter((t) => t.days.some(Boolean))
      .sort((a, b) => a.firstTime.localeCompare(b.firstTime));

    const catQ = await db.execute<any>(sql`SELECT name FROM ps_validity_categories WHERE code = ${categoryCode} LIMIT 1`);

    res.json({
      route: { routeId: route.id, shortName: route.short_name, longName: route.long_name, color: route.color },
      directionId,
      category: { code: categoryCode, name: catQ.rows[0]?.name ?? categoryCode },
      repDates,
      stops: master.map((m: any) => ({ stopId: m.stopId, stopName: m.stopName })),
      // firstTime resta nella risposta (prima serviva solo all'ordinamento e
      // veniva tolto): senza, chi legge ripiega sugli estremi di `times`, che
      // col master fuso delle due direzioni davano «partenza 08:01, arrivo 07:59».
      trips: tripList.map((t) => ({ ...t, firstTime: t.firstTime === "99:99:99" ? null : t.firstTime })),
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ── GET /timetables/stop/:stopId — quadro di palina (ps_*) ───────────────────
router.get("/planning-studio/:projectId/timetables/stop/:stopId", async (req, res): Promise<void> => {
  try {
    const projectId = String(req.params.projectId);
    const stopId = String(req.params.stopId);
    if (!UUID_RE.test(projectId) || !UUID_RE.test(stopId)) { res.status(400).json({ error: "ID non valido" }); return; }
    if (!(await requireTimetableRead(projectId, req, res))) return;
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

// ── GET /timetables/stop/:stopId/full — QUADRO DI PALINA completo ────────────
// Tutte le linee che transitano dalla fermata, con OGNI partenza classificata
// per CATEGORIA di calendario (Scuole Aperte / Chiuse, con ombrello) e per tipo
// di giorno (feriale/sabato/festivo). Nessun filtro: la stampa organizza tutto.
router.get("/planning-studio/:projectId/timetables/stop/:stopId/full", async (req, res): Promise<void> => {
  try {
    const projectId = String(req.params.projectId);
    const stopId = String(req.params.stopId);
    if (!UUID_RE.test(projectId) || !UUID_RE.test(stopId)) { res.status(400).json({ error: "ID non valido" }); return; }
    if (!(await requireTimetableRead(projectId, req, res))) return;

    const stopQ = await db.execute<any>(sql`
      SELECT id, name, code FROM ps_stops
      WHERE project_id = ${projectId}::uuid AND id = ${stopId}::uuid LIMIT 1`);
    const stop = stopQ.rows[0];
    if (!stop) { res.status(404).json({ error: "Fermata non trovata" }); return; }

    // Partenze dalla fermata (escluso il capolinea d'arrivo) + attributi corsa.
    const depQ = await db.execute<any>(sql.raw(`
      SELECT st.trip_id, st.departure_time, t.attributes AS attributes,
             COALESCE(t.headsign, v.headsign) AS trip_headsign,
             r.id AS route_id, r.short_name, r.long_name, r.color, r.sort_order
      FROM (
        SELECT st.*, MAX(st.stop_seq) OVER (PARTITION BY st.trip_id) AS last_seq
        FROM ps_stop_times st
        WHERE st.trip_id IN (
          SELECT id FROM ps_trips WHERE project_id = '${projectId}' AND COALESCE(is_active,true) = true
            AND COALESCE((attributes->>'prototype')::boolean, false) = false
        )
      ) st
      JOIN ps_trips t ON t.id = st.trip_id
      JOIN ps_route_variants v ON v.id = t.variant_id
      JOIN ps_routes r ON r.id = t.route_id
      WHERE st.stop_id = '${stopId}'
        AND st.departure_time IS NOT NULL
        AND st.stop_seq < st.last_seq
      ORDER BY r.sort_order, r.short_name, st.departure_time
    `));
    const rows = depQ.rows as any[];
    const tripList = uuidList([...new Set(rows.map((r) => String(r.trip_id)))]);

    // day-type codes + category codes per corsa
    const dayCodesByTrip = new Map<string, Set<string>>();
    const catCodesByTrip = new Map<string, Set<string>>();
    if (tripList) {
      try {
        const dv = await db.execute<any>(sql.raw(`
          SELECT v.trip_id, dt.code FROM ps_trip_day_validity v
          JOIN ps_day_types dt ON dt.id = v.day_type_id
          WHERE v.is_valid = true AND v.trip_id IN (${tripList})`));
        for (const r of dv.rows as any[]) {
          if (!dayCodesByTrip.has(r.trip_id)) dayCodesByTrip.set(r.trip_id, new Set());
          dayCodesByTrip.get(r.trip_id)!.add(r.code);
        }
      } catch { /* validità non configurata */ }
      try {
        const cv = await db.execute<any>(sql.raw(`
          SELECT cv.trip_id, c.code FROM ps_trip_category_validity cv
          JOIN ps_validity_categories c ON c.id = cv.category_id
          WHERE cv.trip_id IN (${tripList})`));
        for (const r of cv.rows as any[]) {
          if (!catCodesByTrip.has(r.trip_id)) catCodesByTrip.set(r.trip_id, new Set());
          catCodesByTrip.get(r.trip_id)!.add(r.code);
        }
      } catch { /* categorie non configurate */ }
    }

    const catInfoQ = await db.execute<any>(sql`
      SELECT code, name FROM ps_validity_categories WHERE code IN ('scuole_aperte','scuole_chiuse')`)
      .catch(() => ({ rows: [] as any[] }));
    const catName = new Map<string, string>();
    for (const r of (catInfoQ.rows as any[])) catName.set(r.code, r.name);

    interface Line { routeId: string; shortName: string | null; longName: string | null; color: string | null; headsigns: string[]; departures: any[] }
    const lines = new Map<string, Line>();
    for (const row of rows) {
      const m = /^(\d{1,2}):(\d{2})/.exec(String(row.departure_time));
      if (!m) continue;
      const time = `${String(Number(m[1]) % 24).padStart(2, "0")}:${m[2]}`;
      let line = lines.get(row.route_id);
      if (!line) { line = { routeId: row.route_id, shortName: row.short_name, longName: row.long_name, color: row.color, headsigns: [], departures: [] }; lines.set(row.route_id, line); }
      const hs = String(row.trip_headsign ?? "").trim();
      let hsIdx = line.headsigns.indexOf(hs);
      if (hsIdx < 0) { line.headsigns.push(hs); hsIdx = line.headsigns.length - 1; }

      // tipo di giorno: bollini day-type se presenti, altrimenti maschera weekdays
      const dtc = dayCodesByTrip.get(row.trip_id) ?? new Set<string>();
      const wd = Array.isArray(row.attributes?.weekdays) && row.attributes.weekdays.length === 7
        ? row.attributes.weekdays.map((x: any) => x !== false) : null;
      const days: string[] = [];
      if (dtc.size) {
        if (dtc.has("feriale")) days.push("feriale");
        if (dtc.has("sabato")) days.push("sabato");
        if (dtc.has("festivo")) days.push("festivo");
      } else if (wd) {
        if (wd.slice(0, 5).some((x: boolean) => x)) days.push("feriale");
        if (wd[5]) days.push("sabato");
        if (wd[6]) days.push("festivo");
      }
      if (!days.length) days.push("feriale");

      // categoria macro: scuole_aperte / scuole_chiuse (ombrello). Nessuna
      // categoria (o solo festività) → circola sempre → in ENTRAMBE le sezioni.
      const cc = catCodesByTrip.get(row.trip_id) ?? new Set<string>();
      const hasA = cc.has("scuole_aperte");
      const hasC = [...cc].some((c) => c.startsWith("scuole_chiuse"));
      const cats = (hasA && !hasC) ? ["scuole_aperte"] : (hasC && !hasA) ? ["scuole_chiuse"] : ["scuole_aperte", "scuole_chiuse"];

      line.departures.push({ time, headsignIdx: hsIdx, onDemand: !!row.attributes?.onDemand, days, cats });
    }

    res.json({
      stop: { stopId: stop.id, stopName: stop.name, stopCode: stop.code },
      categories: [
        { code: "scuole_aperte", name: catName.get("scuole_aperte") ?? "Scuole Aperte" },
        { code: "scuole_chiuse", name: catName.get("scuole_chiuse") ?? "Scuole Chiuse" },
      ],
      lines: [...lines.values()].sort((a, b) =>
        String(a.shortName ?? "").localeCompare(String(b.shortName ?? ""), "it", { numeric: true })),
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
    if (!(await requireTimetableRead(projectId, req, res))) return;
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

// ── POST /planning-studio/:projectId/timetable-map-share — link MAPPA ORARI ──
// Pagina pubblica /o/:token: l'utente sceglie la linea → percorsi e fermate
// accesi → clic sulla fermata → orari di transito con corse a chiamata.
router.post("/planning-studio/:projectId/timetable-map-share", async (req, res): Promise<void> => {
  try {
    const projectId = String(req.params.projectId);
    if (!UUID_RE.test(projectId)) { res.status(400).json({ error: "projectId non valido" }); return; }
    if (!(await canAccessPsProject(projectId, req))) { res.status(404).json({ error: "Progetto non accessibile" }); return; }
    // routeIds opzionali: assenti/vuoti = TUTTE le linee del progetto
    const routeIds: string[] = Array.isArray(req.body?.routeIds)
      ? req.body.routeIds.filter((x: any) => UUID_RE.test(String(x))) : [];
    const title = typeof req.body?.title === "string" ? req.body.title.slice(0, 120) : null;
    const days = Number(req.body?.expiresInDays);
    const expiresAt = Number.isFinite(days) && days > 0 ? new Date(Date.now() + days * 86_400_000).toISOString() : null;
    const { ensureTimetableMapShareTable } = await import("./timetable-map-share");
    await ensureTimetableMapShareTable();
    const token = randomBytes(18).toString("base64url");
    const userId = (req as any).user?.id ?? null;
    await db.execute(sql`
      INSERT INTO ps_timetable_map_shares (token, project_id, route_ids, title, created_by, expires_at)
      VALUES (${token}, ${projectId}::uuid, ${JSON.stringify(routeIds)}::jsonb, ${title}, ${userId}::uuid, ${expiresAt}::timestamptz)`);
    res.json({ token, expiresAt });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ── GESTIONE link Mappa Orari: i QR stampati alle paline NON si ristampano.
// Il token (→ URL → QR) resta lo stesso per sempre; qui si aggiorna il
// CONTENUTO del link (linee incluse, titolo, scadenza) o lo si revoca.
router.get("/planning-studio/:projectId/timetable-map-shares", async (req, res): Promise<void> => {
  try {
    const projectId = String(req.params.projectId);
    if (!UUID_RE.test(projectId)) { res.status(400).json({ error: "projectId non valido" }); return; }
    if (!(await canAccessPsProject(projectId, req))) { res.status(404).json({ error: "Progetto non accessibile" }); return; }
    const { ensureTimetableMapShareTable } = await import("./timetable-map-share");
    await ensureTimetableMapShareTable();
    const r = await db.execute<any>(sql`
      SELECT token, title, route_ids, created_at, expires_at
        FROM ps_timetable_map_shares
       WHERE project_id = ${projectId}::uuid
       ORDER BY created_at DESC`);
    res.json({
      shares: (r.rows ?? []).map((s: any) => ({
        token: s.token,
        title: s.title ?? null,
        routeIds: Array.isArray(s.route_ids) ? s.route_ids : [],
        createdAt: s.created_at,
        expiresAt: s.expires_at ?? null,
      })),
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// PATCH: aggiorna il link MANTENENDO lo stesso token (stesso QR).
// expiresInDays: assente = non toccare; 0 = sempre online; >0 = ora + N giorni.
router.patch("/planning-studio/:projectId/timetable-map-shares/:token", async (req, res): Promise<void> => {
  try {
    const projectId = String(req.params.projectId);
    const token = String(req.params.token);
    if (!UUID_RE.test(projectId) || !/^[A-Za-z0-9_-]{6,64}$/.test(token)) {
      res.status(400).json({ error: "parametri non validi" }); return;
    }
    if (!(await canAccessPsProject(projectId, req))) { res.status(404).json({ error: "Progetto non accessibile" }); return; }
    const sets: any[] = [];
    if (Array.isArray(req.body?.routeIds)) {
      const ids = req.body.routeIds.filter((x: any) => UUID_RE.test(String(x)));
      sets.push(sql`route_ids = ${JSON.stringify(ids)}::jsonb`);
    }
    if (typeof req.body?.title === "string") sets.push(sql`title = ${req.body.title.slice(0, 120)}`);
    if (req.body?.expiresInDays !== undefined) {
      const days = Number(req.body.expiresInDays);
      const expiresAt = Number.isFinite(days) && days > 0
        ? new Date(Date.now() + days * 86_400_000).toISOString() : null;
      sets.push(sql`expires_at = ${expiresAt}::timestamptz`);
    }
    if (sets.length === 0) { res.status(400).json({ error: "Nessuna modifica indicata" }); return; }
    const r = await db.execute<any>(sql`
      UPDATE ps_timetable_map_shares SET ${sql.join(sets, sql`, `)}
       WHERE token = ${token} AND project_id = ${projectId}::uuid
       RETURNING token, title, route_ids, created_at, expires_at`);
    const row = r.rows?.[0];
    if (!row) { res.status(404).json({ error: "Link non trovato" }); return; }
    res.json({
      token: row.token, title: row.title ?? null,
      routeIds: Array.isArray(row.route_ids) ? row.route_ids : [],
      createdAt: row.created_at, expiresAt: row.expires_at ?? null,
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/planning-studio/:projectId/timetable-map-shares/:token", async (req, res): Promise<void> => {
  try {
    const projectId = String(req.params.projectId);
    const token = String(req.params.token);
    if (!UUID_RE.test(projectId) || !/^[A-Za-z0-9_-]{6,64}$/.test(token)) {
      res.status(400).json({ error: "parametri non validi" }); return;
    }
    if (!(await canAccessPsProject(projectId, req))) { res.status(404).json({ error: "Progetto non accessibile" }); return; }
    await db.execute(sql`
      DELETE FROM ps_timetable_map_shares
       WHERE token = ${token} AND project_id = ${projectId}::uuid`);
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ── Dominio dedicato dei link Mappa Orari (env RUNTIME del server) ──
// TIMETABLE_MAP_DOMAIN (es. https://map.conerobus.it): variabile d'ambiente
// NORMALE sull'app — niente flag "build variable", niente rebuild: basta
// impostarla e riavviare. Il frontend la chiede qui e la usa per comporre
// link e QR. Assente/invalida → si usa il dominio dell'app (funziona sempre).
router.get("/settings/timetable-map-domain", async (_req, res): Promise<void> => {
  const raw = process.env.TIMETABLE_MAP_DOMAIN || process.env.VITE_TIMETABLE_MAP_DOMAIN || "";
  let domain: string | null = null;
  if (raw) {
    try {
      const u = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
      domain = `${u.protocol}//${u.host}`;
    } catch { domain = null; }
  }
  res.json({ domain });
});

export default router;
