/**
 * Planning Studio — Export GTFS
 *
 * Endpoint: GET /api/planning-studio/projects/:id/export-gtfs
 * Risposta: zip GTFS standard costruito direttamente dalle tabelle ps_*
 * (stops, routes, trips, stop_times, calendar, calendar_dates, shapes, agency,
 * feed_info). È il deliverable che l'ufficio programmazione consegna a
 * Regione/osservatorio, open data (NAP), fornitori AVM/bigliettazione.
 *
 * Scelte di mappatura (stessa semantica della materializzazione interna):
 *  - route_id / trip_id / stop_id / service_id / shape_id = UUID ps_* in testo
 *    (stabili tra export finché non si reimporta).
 *  - Corse senza calendario → service fallback attivo 7/7 nel range del feed
 *    (come planning-studio-materialize). Prototipi e corse inattive ESCLUSE.
 *  - shapes.txt: ricampionato dalla geometry GeoJSON della variante.
 *
 * Solo lettura: nessuna scrittura su DB.
 */
import type { Request, Response } from "express";
import { Router, type IRouter } from "express";
import AdmZip from "adm-zip";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const router: IRouter = Router();
const UUID_RE = /^[0-9a-f-]{36}$/i;

/** Escape CSV RFC4180: quota se contiene virgola, doppio apice o newline. */
function csv(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csvLine(cols: unknown[]): string {
  return cols.map(csv).join(",");
}

/** 'YYYY-MM-DD' (o Date) → 'YYYYMMDD' GTFS. */
function gtfsDate(d: unknown): string {
  const s = d instanceof Date ? d.toISOString().slice(0, 10) : String(d ?? "");
  return s.replace(/-/g, "").slice(0, 8);
}

async function rows(q: any): Promise<any[]> {
  const r: any = await db.execute(q);
  return r.rows ?? r ?? [];
}

router.get("/planning-studio/projects/:id/export-gtfs", async (req: Request, res: Response): Promise<void> => {
  const userId = req.user?.id;
  if (!userId) { res.status(401).json({ error: "Non autenticato" }); return; }
  const projectId = String(req.params.id || "");
  if (!UUID_RE.test(projectId)) { res.status(400).json({ error: "ID progetto non valido" }); return; }

  try {
    // Accesso: owner o membro (lettura basta: l'export non scrive nulla).
    const projR = await rows(sql`
      SELECT p.*
        FROM ps_projects p
        LEFT JOIN ps_project_members pm ON pm.project_id = p.id AND pm.user_id = ${userId}::uuid
       WHERE p.id = ${projectId}::uuid
         AND (p.owner_user_id = ${userId}::uuid OR pm.user_id IS NOT NULL)
       LIMIT 1
    `);
    const project = projR[0];
    if (!project) { res.status(404).json({ error: "Progetto non trovato o non accessibile" }); return; }

    /* ── range date feed dai calendari (fallback: anno corrente) ── */
    const drR = await rows(sql`
      SELECT to_char(MIN(start_date), 'YYYYMMDD') AS min_start,
             to_char(MAX(end_date),   'YYYYMMDD') AS max_end
        FROM ps_calendars WHERE project_id = ${projectId}::uuid
    `);
    const today = new Date();
    const fallbackStart = `${today.getFullYear()}0101`;
    const fallbackEnd = `${today.getFullYear()}1231`;
    const feedStart: string = drR[0]?.min_start || fallbackStart;
    const feedEnd: string = drR[0]?.max_end || fallbackEnd;

    const agencyId = "1";
    const agencyName = project.agency_name || project.name || "Azienda TPL";
    const tz = project.agency_timezone || "Europe/Rome";

    const zip = new AdmZip();

    /* ── agency.txt ── */
    zip.addFile("agency.txt", Buffer.from(
      "agency_id,agency_name,agency_url,agency_timezone,agency_lang\n" +
      csvLine([agencyId, agencyName, "https://example.com", tz, "it"]) + "\n", "utf8"));

    /* ── feed_info.txt ── */
    zip.addFile("feed_info.txt", Buffer.from(
      "feed_publisher_name,feed_publisher_url,feed_lang,feed_start_date,feed_end_date,feed_version\n" +
      csvLine([agencyName, "https://example.com", "it", feedStart, feedEnd,
               `cerbero-${new Date().toISOString().slice(0, 10)}`]) + "\n", "utf8"));

    /* ── stops.txt ── */
    const stops = await rows(sql`
      SELECT id, code, name, description, lat, lon, zone_id, location_type,
             wheelchair_boarding, platform_code
        FROM ps_stops WHERE project_id = ${projectId}::uuid ORDER BY name
    `);
    zip.addFile("stops.txt", Buffer.from(
      "stop_id,stop_code,stop_name,stop_desc,stop_lat,stop_lon,zone_id,location_type,wheelchair_boarding,platform_code\n" +
      stops.map(s => csvLine([
        s.id, s.code ?? "", s.name, s.description ?? "", s.lat, s.lon,
        s.zone_id ?? "", s.location_type ?? 0, s.wheelchair_boarding ?? 0, s.platform_code ?? "",
      ])).join("\n") + "\n", "utf8"));

    /* ── routes.txt ── */
    const routes = await rows(sql`
      SELECT id, code, short_name, long_name, description, route_type, color, text_color, sort_order
        FROM ps_routes WHERE project_id = ${projectId}::uuid
       ORDER BY sort_order NULLS LAST, short_name
    `);
    zip.addFile("routes.txt", Buffer.from(
      "route_id,agency_id,route_short_name,route_long_name,route_desc,route_type,route_color,route_text_color,route_sort_order\n" +
      routes.map(r => csvLine([
        r.id, agencyId,
        r.short_name || r.code || "", r.long_name ?? "", r.description ?? "",
        r.route_type ?? 3,
        (r.color ?? "").replace(/^#/, ""), (r.text_color ?? "").replace(/^#/, ""),
        r.sort_order ?? "",
      ])).join("\n") + "\n", "utf8"));

    /* ── calendar.txt (+ fallback 7/7 per corse senza calendario) ── */
    const calendars = await rows(sql`
      SELECT id, monday, tuesday, wednesday, thursday, friday, saturday, sunday, start_date, end_date
        FROM ps_calendars WHERE project_id = ${projectId}::uuid
    `);
    const needFallbackR = await rows(sql`
      SELECT EXISTS (
        SELECT 1 FROM ps_trips
         WHERE project_id = ${projectId}::uuid
           AND COALESCE(is_active, true) = true
           AND COALESCE((attributes->>'prototype')::boolean, false) = false
           AND calendar_id IS NULL
      ) AS need
    `);
    const fallbackServiceId = "fallback-tutti-i-giorni";
    const calLines = calendars.map(c => csvLine([
      c.id,
      c.monday ? 1 : 0, c.tuesday ? 1 : 0, c.wednesday ? 1 : 0, c.thursday ? 1 : 0,
      c.friday ? 1 : 0, c.saturday ? 1 : 0, c.sunday ? 1 : 0,
      gtfsDate(c.start_date) || feedStart, gtfsDate(c.end_date) || feedEnd,
    ]));
    if (needFallbackR[0]?.need) {
      calLines.push(csvLine([fallbackServiceId, 1, 1, 1, 1, 1, 1, 1, feedStart, feedEnd]));
    }
    zip.addFile("calendar.txt", Buffer.from(
      "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n" +
      calLines.join("\n") + "\n", "utf8"));

    /* ── calendar_dates.txt ── */
    const calDates = await rows(sql`
      SELECT cd.calendar_id, cd.date, cd.exception_type
        FROM ps_calendar_dates cd
        JOIN ps_calendars c ON c.id = cd.calendar_id
       WHERE c.project_id = ${projectId}::uuid
       ORDER BY cd.calendar_id, cd.date
    `);
    zip.addFile("calendar_dates.txt", Buffer.from(
      "service_id,date,exception_type\n" +
      calDates.map(d => csvLine([d.calendar_id, gtfsDate(d.date), d.exception_type ?? 1])).join("\n") + "\n", "utf8"));

    /* ── trips.txt (attive, non prototipo) ── */
    const trips = await rows(sql`
      SELECT t.id, t.route_id, t.calendar_id, t.headsign, t.short_name, t.direction,
             t.block_id, t.variant_id,
             EXISTS (SELECT 1 FROM ps_shapes sh WHERE sh.variant_id = t.variant_id) AS has_shape
        FROM ps_trips t
       WHERE t.project_id = ${projectId}::uuid
         AND COALESCE(t.is_active, true) = true
         AND COALESCE((t.attributes->>'prototype')::boolean, false) = false
       ORDER BY t.route_id, t.id
    `);
    zip.addFile("trips.txt", Buffer.from(
      "route_id,service_id,trip_id,trip_headsign,trip_short_name,direction_id,block_id,shape_id\n" +
      trips.map(t => csvLine([
        t.route_id, t.calendar_id ?? fallbackServiceId, t.id,
        t.headsign ?? "", t.short_name ?? "", t.direction ?? 0, t.block_id ?? "",
        t.has_shape ? t.variant_id : "",
      ])).join("\n") + "\n", "utf8"));

    /* ── stop_times.txt (query pesante: righe in streaming di memoria unica) ── */
    const stopTimes = await rows(sql`
      SELECT st.trip_id, st.stop_seq, st.stop_id, st.arrival_time, st.departure_time,
             st.pickup_type, st.drop_off_type, st.timepoint, st.shape_dist_traveled
        FROM ps_stop_times st
        JOIN ps_trips t ON t.id = st.trip_id
       WHERE t.project_id = ${projectId}::uuid
         AND COALESCE(t.is_active, true) = true
         AND COALESCE((t.attributes->>'prototype')::boolean, false) = false
       ORDER BY st.trip_id, st.stop_seq
    `);
    zip.addFile("stop_times.txt", Buffer.from(
      "trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type,timepoint,shape_dist_traveled\n" +
      stopTimes.map(s => csvLine([
        s.trip_id, s.arrival_time, s.departure_time, s.stop_id, s.stop_seq,
        s.pickup_type ?? 0, s.drop_off_type ?? 0, s.timepoint ?? 1, s.shape_dist_traveled ?? "",
      ])).join("\n") + "\n", "utf8"));

    /* ── shapes.txt dalle geometry GeoJSON delle varianti ── */
    const shapes = await rows(sql`
      SELECT variant_id, geometry FROM ps_shapes WHERE project_id = ${projectId}::uuid
    `);
    const shapeLines: string[] = [];
    for (const sh of shapes) {
      const coords: any[] = sh.geometry?.coordinates ?? [];
      coords.forEach((c: any, i: number) => {
        if (!Array.isArray(c) || c.length < 2) return;
        shapeLines.push(csvLine([sh.variant_id, c[1], c[0], i + 1]));
      });
    }
    zip.addFile("shapes.txt", Buffer.from(
      "shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\n" +
      shapeLines.join("\n") + "\n", "utf8"));

    /* ── invio ── */
    const safeName = String(project.name || "programma").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="gtfs_${safeName}_${dateStr}.zip"`);
    res.send(zip.toBuffer());
  } catch (e: any) {
    req.log?.error?.({ err: e?.message, projectId }, "export GTFS fallito");
    res.status(500).json({ error: "Errore durante l'export GTFS" });
  }
});

export default router;
