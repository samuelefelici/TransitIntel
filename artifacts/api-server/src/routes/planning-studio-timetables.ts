/**
 * ═══════════════════════════════════════════════════════════════════════════
 * STAMPA ORARI — sorgente: PROGRAMMA DI ESERCIZIO del progetto Planning Studio
 * ───────────────────────────────────────────────────────────────────────────
 * Legge direttamente dalle tabelle ps_* del progetto (NON dal feed GTFS):
 *   ps_routes / ps_route_variants / ps_variant_stops / ps_stops /
 *   ps_trips / ps_stop_times  + validità via ps_calendars / ps_calendar_dates
 *   e categorie globali ps_validity_categories / ps_validity_category_calendar.
 *
 *   GET /planning-studio/:projectId/timetables/routes
 *   GET /planning-studio/:projectId/timetables/route-stops?routeIds=a,b
 *   GET /planning-studio/:projectId/timetables/stops/search?q=
 *   GET /planning-studio/:projectId/timetables/route/:routeId?dayType=&validity=&directionId=
 *   GET /planning-studio/:projectId/timetables/stop/:stopId?dayType=&validity=
 *
 * Validità (scuole_aperte|scuole_chiuse) × giorno → "data rappresentativa"
 * (giorno tipo) → calendari attivi su quella data → corse filtrate.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { mergeStopPatterns } from "../lib/timetable-merge";

const router: IRouter = Router();

const UUID_RE = /^[0-9a-f-]{36}$/i;
type DayType = "weekday" | "saturday" | "sunday";
type Validity = "scuole_aperte" | "scuole_chiuse";

function parseDayType(q: unknown): DayType {
  const s = String(q ?? "weekday");
  return s === "saturday" || s === "sunday" ? s : "weekday";
}
function parseValidity(q: unknown): Validity {
  return q === "scuole_chiuse" ? "scuole_chiuse" : "scuole_aperte";
}
/** lista SQL di uuid validati (per IN/ANY senza problemi di binding array) */
function uuidList(ids: string[]): string {
  return ids.filter((x) => UUID_RE.test(x)).map((x) => `'${x}'`).join(",");
}
const DOW_COL = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/** calendar_id attivi su una data (ISO) per il progetto: settimanale ∪ +dates − −dates. */
async function activeCalendarIdsOnDate(projectId: string, dISO: string): Promise<Set<string>> {
  const dow = new Date(`${dISO}T00:00:00Z`).getUTCDay(); // 0=dom..6=sab
  const col = DOW_COL[dow];
  const weekly = await db.execute<any>(sql.raw(`
    SELECT id FROM ps_calendars
    WHERE project_id = '${projectId}'
      AND start_date <= DATE '${dISO}' AND end_date >= DATE '${dISO}'
      AND ${col} = true
  `));
  const add = await db.execute<any>(sql`
    SELECT cd.calendar_id FROM ps_calendar_dates cd
    JOIN ps_calendars c ON c.id = cd.calendar_id AND c.project_id = ${projectId}::uuid
    WHERE cd.date = ${dISO}::date AND cd.exception_type = 1`);
  const rem = await db.execute<any>(sql`
    SELECT cd.calendar_id FROM ps_calendar_dates cd
    JOIN ps_calendars c ON c.id = cd.calendar_id AND c.project_id = ${projectId}::uuid
    WHERE cd.date = ${dISO}::date AND cd.exception_type = 2`);
  const removed = new Set((rem.rows as any[]).map((x) => x.calendar_id));
  const set = new Set<string>();
  for (const x of weekly.rows as any[]) if (!removed.has(x.id)) set.add(x.id);
  for (const x of add.rows as any[]) if (!removed.has(x.calendar_id)) set.add(x.calendar_id);
  return set;
}

/** Sceglie la data rappresentativa (giorno tipo) per (validità, giorno). */
async function representativeDate(
  projectId: string, validity: Validity, dayType: DayType,
): Promise<{ iso: string | null; note?: string }> {
  const dows = dayType === "saturday" ? [6] : dayType === "sunday" ? [0] : [1, 2, 3, 4, 5];
  const dowList = dows.join(",");
  // festivo (sunday) → qualunque categoria; altrimenti la categoria scelta
  const catWhere = dayType === "sunday" ? "" : `AND vc.code = '${validity}'`;
  const dowCase = `CASE EXTRACT(DOW FROM d)
      WHEN 0 THEN c.sunday WHEN 1 THEN c.monday WHEN 2 THEN c.tuesday
      WHEN 3 THEN c.wednesday WHEN 4 THEN c.thursday WHEN 5 THEN c.friday
      WHEN 6 THEN c.saturday END`;

  // 1) candidate dal calendario delle categorie globali
  let r = await db.execute<any>(sql.raw(`
    SELECT vcc.date::text AS d,
      (SELECT count(*) FROM ps_calendars c
        WHERE c.project_id = '${projectId}'
          AND c.start_date <= vcc.date AND c.end_date >= vcc.date
          AND CASE EXTRACT(DOW FROM vcc.date)
                WHEN 0 THEN c.sunday WHEN 1 THEN c.monday WHEN 2 THEN c.tuesday
                WHEN 3 THEN c.wednesday WHEN 4 THEN c.thursday WHEN 5 THEN c.friday
                WHEN 6 THEN c.saturday END)::int AS n
    FROM ps_validity_category_calendar vcc
    JOIN ps_validity_categories vc ON vc.id = vcc.category_id
    WHERE EXTRACT(DOW FROM vcc.date) IN (${dowList}) ${catWhere}
    ORDER BY n DESC, vcc.date DESC
    LIMIT 1
  `));
  let row = r.rows[0];

  // 2) fallback: nessuna categoria assegnata → enumera il range dei calendari del progetto
  if (!row) {
    r = await db.execute<any>(sql.raw(`
      WITH rng AS (
        SELECT MIN(start_date) AS a, MAX(end_date) AS b
        FROM ps_calendars WHERE project_id = '${projectId}'
      )
      SELECT d::text AS d,
        (SELECT count(*) FROM ps_calendars c
          WHERE c.project_id = '${projectId}'
            AND c.start_date <= d AND c.end_date >= d
            AND ${dowCase})::int AS n
      FROM rng, generate_series(rng.a, rng.b, INTERVAL '1 day') d
      WHERE EXTRACT(DOW FROM d) IN (${dowList})
      ORDER BY n DESC, d DESC
      LIMIT 1
    `));
    row = r.rows[0];
  }

  if (!row?.d) return { iso: null, note: "Nessuna data del calendario corrisponde alla validità/giorno scelti" };
  if (!row.n || Number(row.n) === 0) return { iso: String(row.d), note: "Nessun servizio attivo per la combinazione scelta" };
  return { iso: String(row.d) };
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
    const dayType = parseDayType(req.query.dayType);
    const validity = parseValidity(req.query.validity);
    const dirRaw = req.query.directionId;
    const directionId = dirRaw === "0" || dirRaw === "1" ? Number(dirRaw) : null;

    const routeQ = await db.execute<any>(sql`
      SELECT id, short_name, long_name, color FROM ps_routes
      WHERE project_id = ${projectId}::uuid AND id = ${routeId}::uuid LIMIT 1`);
    const route = routeQ.rows[0];
    if (!route) { res.status(404).json({ error: "Linea non trovata" }); return; }

    const rep = await representativeDate(projectId, validity, dayType);
    const activeCals = rep.iso ? await activeCalendarIdsOnDate(projectId, rep.iso) : new Set<string>();
    const calList = uuidList([...activeCals]);

    // Corse della linea attive nella data rappresentativa
    const dirClause = directionId === null ? "" : `AND t.direction = ${directionId}`;
    const calClause = calList
      ? `AND (t.calendar_id IN (${calList})
              OR (t.calendar_id IS NULL AND COALESCE(t.valid_from, DATE '${rep.iso}') <= DATE '${rep.iso}'
                                        AND COALESCE(t.valid_to,   DATE '${rep.iso}') >= DATE '${rep.iso}'))`
      : "AND false";
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
        ${calClause}
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

    res.json({
      feedId: projectId,
      dayType, directionId, validity,
      representativeDate: rep.iso,
      validityNote: rep.note ?? null,
      route: { routeId: route.id, shortName: route.short_name, longName: route.long_name, color: route.color },
      stops: master,
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
    const dayType = parseDayType(req.query.dayType);
    const validity = parseValidity(req.query.validity);

    const stopQ = await db.execute<any>(sql`
      SELECT id, name, code FROM ps_stops
      WHERE project_id = ${projectId}::uuid AND id = ${stopId}::uuid LIMIT 1`);
    const stop = stopQ.rows[0];
    if (!stop) { res.status(404).json({ error: "Fermata non trovata" }); return; }

    const rep = await representativeDate(projectId, validity, dayType);
    const activeCals = rep.iso ? await activeCalendarIdsOnDate(projectId, rep.iso) : new Set<string>();
    const calList = uuidList([...activeCals]);
    const calClause = calList
      ? `AND (t.calendar_id IN (${calList})
              OR (t.calendar_id IS NULL AND COALESCE(t.valid_from, DATE '${rep.iso}') <= DATE '${rep.iso}'
                                        AND COALESCE(t.valid_to,   DATE '${rep.iso}') >= DATE '${rep.iso}'))`
      : "AND false";

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
        ${calClause}
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
      dayType, validity,
      representativeDate: rep.iso,
      validityNote: rep.note ?? null,
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

export default router;
