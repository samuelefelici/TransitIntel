/**
 * Planning Studio — Import GTFS
 *
 * Endpoint: POST /api/planning-studio/projects/:id/import-gtfs
 * Body multipart: campo "file" con uno zip GTFS standard (RFC).
 *
 * Comportamento:
 *  - Wipe completo dei dati operativi del progetto (stops, routes, varianti,
 *    shapes, calendari, trips, stop_times) → mantiene il progetto + members.
 *  - Re-import idempotente: ogni import sovrascrive completamente.
 *  - L'utente deve essere owner o editor del progetto.
 *
 * File GTFS supportati (iter1):
 *   stops.txt           → ps_stops
 *   routes.txt          → ps_routes
 *   shapes.txt          → (raccolto in memoria, attaccato alla variante)
 *   calendar.txt        → ps_calendars
 *   calendar_dates.txt  → ps_calendar_dates
 *   trips.txt           → ps_route_variants (raggruppando per stop_pattern) + ps_trips
 *   stop_times.txt      → ps_variant_stops (per la variante) + ps_stop_times (per il trip)
 *
 * Esclusi iter1: agency.txt (solo nome → ps_projects.agency_name), frequencies.txt,
 *   transfers.txt, fare_*.txt, feed_info.txt.
 */
import type { Request, Response } from "express";
import { Router, type IRouter } from "express";
import multer from "multer";
import AdmZip from "adm-zip";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { parseCsv } from "../routes/gtfs-helpers";
import { runValidityAutoImportFromCalendars } from "./planning-studio-validity";

const router: IRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });

/* ─── Helpers ─────────────────────────────────────────────── */

const UUID_RE = /^[0-9a-f-]{36}$/i;

/** GTFS date YYYYMMDD → ISO YYYY-MM-DD. */
function gtfsDate(d: string): string | null {
  if (!d || !/^\d{8}$/.test(d)) return null;
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
}

/** route_color GTFS senza '#' → "#RRGGBB". */
function color(c?: string): string | null {
  if (!c) return null;
  const v = c.trim();
  if (!v) return null;
  if (/^#?[0-9a-f]{6}$/i.test(v)) return v.startsWith("#") ? v.toUpperCase() : `#${v.toUpperCase()}`;
  return null;
}

function num(v?: string, def = 0): number {
  if (v === undefined || v === null || v === "") return def;
  const n = parseFloat(v);
  return isFinite(n) ? n : def;
}
function int(v?: string, def = 0): number {
  if (v === undefined || v === null || v === "") return def;
  const n = parseInt(v, 10);
  return isFinite(n) ? n : def;
}
function bool01(v?: string): boolean {
  return v === "1" || v === "true" || v === "TRUE";
}

/** Trova un file dentro lo zip (case insensitive, supporta path con prefix). */
function readZipFile(zip: AdmZip, name: string): string | null {
  const wanted = name.toLowerCase();
  for (const e of zip.getEntries()) {
    if (e.isDirectory) continue;
    const base = e.entryName.split("/").pop()?.toLowerCase();
    if (base === wanted) return e.getData().toString("utf8");
  }
  return null;
}

/** Verifica permessi sul progetto (owner o editor). */
async function loadProjectWritable(projectId: string, userId: string): Promise<any | null> {
  const r = await db.execute(sql`
    SELECT p.*,
           CASE WHEN p.owner_user_id = ${userId}::uuid THEN 'owner'
                ELSE pm.role END AS my_role
      FROM ps_projects p
      LEFT JOIN ps_project_members pm
             ON pm.project_id = p.id AND pm.user_id = ${userId}::uuid
     WHERE p.id = ${projectId}::uuid
       AND (p.owner_user_id = ${userId}::uuid OR pm.user_id IS NOT NULL)
     LIMIT 1
  `);
  const row: any = (r as any).rows?.[0] ?? (r as any)[0] ?? null;
  if (!row) return null;
  if (row.my_role !== "owner" && row.my_role !== "editor") return null;
  return row;
}

/** Wipe dati operativi (mantiene il progetto + membri). */
async function wipeProjectData(projectId: string): Promise<void> {
  // ON DELETE CASCADE fa il grosso del lavoro: cancellando i trips spariscono
  // gli stop_times, cancellando le varianti spariscono variant_stops + shape, etc.
  await db.execute(sql`DELETE FROM ps_trips WHERE project_id = ${projectId}::uuid`);
  await db.execute(sql`DELETE FROM ps_route_variants WHERE project_id = ${projectId}::uuid`);
  await db.execute(sql`DELETE FROM ps_routes WHERE project_id = ${projectId}::uuid`);
  await db.execute(sql`DELETE FROM ps_calendars WHERE project_id = ${projectId}::uuid`);
  await db.execute(sql`DELETE FROM ps_stops WHERE project_id = ${projectId}::uuid`);
}

/** Esegue una INSERT in batch usando VALUES multipli. */
async function bulkInsert(
  table: string,
  cols: string[],
  rows: any[][],
  batchSize = 500,
): Promise<void> {
  if (rows.length === 0) return;
  for (let i = 0; i < rows.length; i += batchSize) {
    const slice = rows.slice(i, i + batchSize);
    const valuesSql = sql.join(
      slice.map(r => sql`(${sql.join(r.map(v => sql`${v}`), sql`, `)})`),
      sql`, `,
    );
    const colsSql = sql.raw(cols.join(", "));
    const tableSql = sql.raw(table);
    await db.execute(sql`INSERT INTO ${tableSql} (${colsSql}) VALUES ${valuesSql}`);
  }
}

/* ─── Endpoint principale ─────────────────────────────────── */

router.post(
  "/planning-studio/projects/:id/import-gtfs",
  upload.single("file"),
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.id;
    const projectId = String(req.params.id || "");
    if (!UUID_RE.test(projectId)) { res.status(400).json({ error: "ID progetto non valido" }); return; }
    if (!req.file || !req.file.buffer) {
      res.status(400).json({ error: "Nessun file ricevuto. Invia uno zip GTFS nel campo 'file'." });
      return;
    }
    const project = await loadProjectWritable(projectId, userId);
    if (!project) { res.status(403).json({ error: "Progetto non trovato o senza permessi di scrittura" }); return; }

    let zip: AdmZip;
    try {
      zip = new AdmZip(req.file.buffer);
    } catch (e: any) {
      res.status(400).json({ error: "ZIP non valido: " + (e?.message || "errore parsing") });
      return;
    }

    /* ─── 1. Parse ─── */
    const stopsCsv     = readZipFile(zip, "stops.txt");
    const routesCsv    = readZipFile(zip, "routes.txt");
    const tripsCsv     = readZipFile(zip, "trips.txt");
    const stopTimesCsv = readZipFile(zip, "stop_times.txt");
    const shapesCsv    = readZipFile(zip, "shapes.txt");
    const calendarCsv  = readZipFile(zip, "calendar.txt");
    const calDatesCsv  = readZipFile(zip, "calendar_dates.txt");
    const agencyCsv    = readZipFile(zip, "agency.txt");

    if (!stopsCsv || !routesCsv || !tripsCsv || !stopTimesCsv) {
      res.status(400).json({
        error: "GTFS incompleto. Mancano uno o più file obbligatori: stops.txt, routes.txt, trips.txt, stop_times.txt",
      });
      return;
    }

    const stopRows     = parseCsv(stopsCsv);
    const routeRows    = parseCsv(routesCsv);
    const tripRows     = parseCsv(tripsCsv);
    const stopTimeRows = parseCsv(stopTimesCsv);
    const shapeRows    = shapesCsv ? parseCsv(shapesCsv) : [];
    const calRows      = calendarCsv ? parseCsv(calendarCsv) : [];
    const calDateRows  = calDatesCsv ? parseCsv(calDatesCsv) : [];
    const agencyRows   = agencyCsv ? parseCsv(agencyCsv) : [];

    try {
      /* ─── 2. Wipe ─── */
      await wipeProjectData(projectId);

      /* ─── 3. Aggiorna agency_name dal primo agency.txt ─── */
      if (agencyRows[0]?.agency_name) {
        await db.execute(sql`
          UPDATE ps_projects SET agency_name = ${agencyRows[0].agency_name},
                                 agency_timezone = ${agencyRows[0].agency_timezone || "Europe/Rome"}
           WHERE id = ${projectId}::uuid
        `);
      }

      /* ─── 4. STOPS ─── */
      // Genero UUID lato app (gen_random_uuid è troppo) — uso quello del DB con RETURNING
      // ma per perf: generiamo lato app con crypto.randomUUID()
      const stopGtfsToUuid = new Map<string, string>();
      const stopValues: any[][] = [];
      for (const s of stopRows) {
        const gtfsId = s.stop_id?.trim();
        if (!gtfsId) continue;
        const lat = num(s.stop_lat, NaN);
        const lon = num(s.stop_lon, NaN);
        if (!isFinite(lat) || !isFinite(lon)) continue;
        const id = crypto.randomUUID();
        stopGtfsToUuid.set(gtfsId, id);
        stopValues.push([
          id, projectId, s.stop_code || null, s.stop_name || gtfsId,
          s.stop_desc || null, lat, lon, s.zone_id || null,
          int(s.location_type, 0), int(s.wheelchair_boarding, 0),
          s.platform_code || null,
        ]);
      }
      await bulkInsert(
        "ps_stops",
        ["id", "project_id", "code", "name", "description", "lat", "lon", "zone_id",
         "location_type", "wheelchair_boarding", "platform_code"],
        stopValues,
      );

      /* ─── 5. ROUTES ─── */
      const routeGtfsToUuid = new Map<string, string>();
      const routeValues: any[][] = [];
      for (const r of routeRows) {
        const gtfsId = r.route_id?.trim();
        if (!gtfsId) continue;
        const id = crypto.randomUUID();
        routeGtfsToUuid.set(gtfsId, id);
        routeValues.push([
          id, projectId, gtfsId,
          r.route_short_name || gtfsId,
          r.route_long_name || null,
          r.route_desc || null,
          int(r.route_type, 3),
          color(r.route_color),
          color(r.route_text_color),
          r.agency_id || null,
          int(r.route_sort_order, 0),
        ]);
      }
      await bulkInsert(
        "ps_routes",
        ["id", "project_id", "code", "short_name", "long_name", "description",
         "route_type", "color", "text_color", "agency_id", "sort_order"],
        routeValues,
      );

      /* ─── 6. CALENDARS ─── */
      const calGtfsToUuid = new Map<string, string>();
      const calValues: any[][] = [];
      for (const c of calRows) {
        const gtfsId = c.service_id?.trim();
        if (!gtfsId) continue;
        const start = gtfsDate(c.start_date);
        const end = gtfsDate(c.end_date);
        if (!start || !end) continue;
        const id = crypto.randomUUID();
        calGtfsToUuid.set(gtfsId, id);
        calValues.push([
          id, projectId, gtfsId, gtfsId,
          bool01(c.monday), bool01(c.tuesday), bool01(c.wednesday),
          bool01(c.thursday), bool01(c.friday), bool01(c.saturday), bool01(c.sunday),
          start, end,
        ]);
      }
      await bulkInsert(
        "ps_calendars",
        ["id", "project_id", "code", "name",
         "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
         "start_date", "end_date"],
        calValues,
      );

      /* ─── 7. CALENDAR_DATES ─── */
      // Se il service_id non era in calendar.txt → creo un calendario "stub" tutto false
      // con start/end = min/max delle date eccezione (caso "calendar_dates only").
      const stubByService = new Map<string, { dates: string[] }>();
      for (const cd of calDateRows) {
        const sid = cd.service_id?.trim();
        if (!sid) continue;
        if (!calGtfsToUuid.has(sid)) {
          if (!stubByService.has(sid)) stubByService.set(sid, { dates: [] });
          const d = gtfsDate(cd.date);
          if (d) stubByService.get(sid)!.dates.push(d);
        }
      }
      // Crea stub
      const stubValues: any[][] = [];
      for (const [sid, info] of stubByService.entries()) {
        if (info.dates.length === 0) continue;
        info.dates.sort();
        const id = crypto.randomUUID();
        calGtfsToUuid.set(sid, id);
        stubValues.push([
          id, projectId, sid, sid,
          false, false, false, false, false, false, false,
          info.dates[0], info.dates[info.dates.length - 1],
        ]);
      }
      await bulkInsert(
        "ps_calendars",
        ["id", "project_id", "code", "name",
         "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
         "start_date", "end_date"],
        stubValues,
      );

      // Inserisci le date eccezione
      const calDateValues: any[][] = [];
      for (const cd of calDateRows) {
        const sid = cd.service_id?.trim();
        const calId = sid ? calGtfsToUuid.get(sid) : undefined;
        if (!calId) continue;
        const d = gtfsDate(cd.date);
        if (!d) continue;
        calDateValues.push([calId, d, int(cd.exception_type, 1)]);
      }
      await bulkInsert(
        "ps_calendar_dates",
        ["calendar_id", "date", "exception_type"],
        calDateValues,
      );

      /* ─── 8. SHAPES (solo geometry, le attacchiamo per shape_id) ─── */
      const shapesByGtfsId = new Map<string, { lng: number; lat: number; seq: number }[]>();
      for (const p of shapeRows) {
        const sid = p.shape_id?.trim();
        if (!sid) continue;
        const lng = num(p.shape_pt_lon, NaN);
        const lat = num(p.shape_pt_lat, NaN);
        const seq = int(p.shape_pt_sequence, 0);
        if (!isFinite(lng) || !isFinite(lat)) continue;
        if (!shapesByGtfsId.has(sid)) shapesByGtfsId.set(sid, []);
        shapesByGtfsId.get(sid)!.push({ lng, lat, seq });
      }

      /* ─── 9. STOP_TIMES indicizzati per trip_id ─── */
      type StopTime = { seq: number; stopGtfs: string; arr: string; dep: string; pickup: number; dropoff: number; timepoint: number; dist: number | null };
      const stopTimesByTrip = new Map<string, StopTime[]>();
      for (const st of stopTimeRows) {
        const tripId = st.trip_id?.trim();
        if (!tripId) continue;
        if (!stopTimesByTrip.has(tripId)) stopTimesByTrip.set(tripId, []);
        stopTimesByTrip.get(tripId)!.push({
          seq: int(st.stop_sequence, 0),
          stopGtfs: st.stop_id?.trim() || "",
          arr: st.arrival_time || "00:00:00",
          dep: st.departure_time || st.arrival_time || "00:00:00",
          pickup: int(st.pickup_type, 0),
          dropoff: int(st.drop_off_type, 0),
          timepoint: st.timepoint === "0" ? 0 : 1,
          dist: st.shape_dist_traveled ? num(st.shape_dist_traveled, 0) : null,
        });
      }
      for (const arr of stopTimesByTrip.values()) arr.sort((a, b) => a.seq - b.seq);

      /* ─── 10. RAGGRUPPA TRIPS IN VARIANTI per stop_pattern ─── */
      // Variante = (route_id, direction_id, headsign?, stop_pattern serialized)
      // Oss. uso direction + stop_pattern come chiave principale, headsign come tag.
      type VariantKey = string; // `${routeGtfs}|${direction}|${stopPattern}`
      type VariantInfo = {
        id: string;
        routeId: string;
        routeGtfs: string;
        direction: number;
        headsign: string | null;
        stopGtfsSeq: string[];
        shapeGtfsId: string | null;
        tripIds: string[]; // GTFS trip ids
      };
      const variants = new Map<VariantKey, VariantInfo>();

      for (const t of tripRows) {
        const tripGtfs = t.trip_id?.trim();
        const routeGtfs = t.route_id?.trim();
        if (!tripGtfs || !routeGtfs) continue;
        const routeUuid = routeGtfsToUuid.get(routeGtfs);
        if (!routeUuid) continue;
        const sts = stopTimesByTrip.get(tripGtfs);
        if (!sts || sts.length === 0) continue;
        const stopSeq = sts.map(s => s.stopGtfs);
        // Salta trip con stop sconosciuti
        if (stopSeq.some(s => !stopGtfsToUuid.has(s))) continue;

        const dir = int(t.direction_id, 0);
        const headsign = (t.trip_headsign || "").trim() || null;
        const pattern = stopSeq.join(">");
        const key = `${routeGtfs}|${dir}|${pattern}`;
        let v = variants.get(key);
        if (!v) {
          v = {
            id: crypto.randomUUID(),
            routeId: routeUuid,
            routeGtfs,
            direction: dir,
            headsign,
            stopGtfsSeq: stopSeq,
            shapeGtfsId: t.shape_id?.trim() || null,
            tripIds: [],
          };
          variants.set(key, v);
        }
        v.tripIds.push(tripGtfs);
      }

      /* ─── 11. INSERISCI VARIANTS ─── */
      const variantValues: any[][] = [];
      // Numera le varianti per route per dare un name leggibile.
      const variantCounterByRoute = new Map<string, number>();
      for (const v of variants.values()) {
        const n = (variantCounterByRoute.get(v.routeId) || 0) + 1;
        variantCounterByRoute.set(v.routeId, n);
        const name = v.headsign
          ? `${v.headsign}${v.direction === 1 ? " ↩" : ""}`
          : `Var. ${n}${v.direction === 1 ? " (ritorno)" : ""}`;
        variantValues.push([
          v.id, projectId, v.routeId, name, v.direction, v.headsign,
          n === 1, // is_default = la prima variante per route
        ]);
      }
      await bulkInsert(
        "ps_route_variants",
        ["id", "project_id", "route_id", "name", "direction", "headsign", "is_default"],
        variantValues,
      );

      /* ─── 12. VARIANT_STOPS (sequenza canonica della variante = quella del primo trip) ─── */
      const variantStopsValues: any[][] = [];
      const tripGtfsToVariantId = new Map<string, string>(); // per la fase trips
      for (const v of variants.values()) {
        // Sequenza fermate dalla variante
        v.stopGtfsSeq.forEach((stopGtfs, idx) => {
          const stopUuid = stopGtfsToUuid.get(stopGtfs);
          if (!stopUuid) return;
          variantStopsValues.push([v.id, idx + 1, stopUuid, 0, 0, 1, null]);
        });
        for (const tid of v.tripIds) tripGtfsToVariantId.set(tid, v.id);
      }
      await bulkInsert(
        "ps_variant_stops",
        ["variant_id", "seq", "stop_id", "pickup_type", "drop_off_type", "timepoint", "shape_dist_traveled"],
        variantStopsValues,
      );

      /* ─── 13. SHAPES delle varianti ─── */
      const shapeValues: any[][] = [];
      for (const v of variants.values()) {
        if (!v.shapeGtfsId) continue;
        const pts = shapesByGtfsId.get(v.shapeGtfsId);
        if (!pts || pts.length < 2) continue;
        pts.sort((a, b) => a.seq - b.seq);
        const coords = pts.map(p => [p.lng, p.lat]);
        const geom = { type: "LineString", coordinates: coords };
        // waypoints minimi: solo i 2 estremi come 'snap'
        const waypoints = [
          { lng: coords[0][0], lat: coords[0][1], mode: "snap" },
          { lng: coords[coords.length - 1][0], lat: coords[coords.length - 1][1], mode: "snap" },
        ];
        // distanza approssimata
        let distM = 0;
        for (let i = 1; i < coords.length; i++) {
          const [x1, y1] = coords[i - 1];
          const [x2, y2] = coords[i];
          const R = 6371000;
          const dLat = ((y2 - y1) * Math.PI) / 180;
          const dLon = ((x2 - x1) * Math.PI) / 180;
          const a = Math.sin(dLat / 2) ** 2 + Math.cos((y1 * Math.PI) / 180) * Math.cos((y2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
          distM += 2 * R * Math.asin(Math.sqrt(a));
        }
        shapeValues.push([
          crypto.randomUUID(), projectId, v.id, "driving",
          JSON.stringify(geom), JSON.stringify(waypoints), distM, distM / 8.33,
        ]);
      }
      await bulkInsert(
        "ps_shapes",
        ["id", "project_id", "variant_id", "mode", "geometry", "waypoints", "distance_m", "duration_s"],
        shapeValues,
      );

      /* ─── 14. TRIPS ─── */
      const tripGtfsToUuid = new Map<string, string>();
      const tripValues: any[][] = [];
      for (const t of tripRows) {
        const gtfs = t.trip_id?.trim();
        if (!gtfs) continue;
        const variantId = tripGtfsToVariantId.get(gtfs);
        if (!variantId) continue;
        const routeGtfs = t.route_id?.trim();
        const routeUuid = routeGtfs ? routeGtfsToUuid.get(routeGtfs) : undefined;
        if (!routeUuid) continue;
        const calId = t.service_id ? calGtfsToUuid.get(t.service_id.trim()) || null : null;
        const id = crypto.randomUUID();
        tripGtfsToUuid.set(gtfs, id);
        tripValues.push([
          id, projectId, routeUuid, variantId, calId,
          (t.trip_headsign || "").trim() || null,
          (t.trip_short_name || "").trim() || null,
          int(t.direction_id, 0),
          (t.block_id || "").trim() || null,
        ]);
      }
      await bulkInsert(
        "ps_trips",
        ["id", "project_id", "route_id", "variant_id", "calendar_id",
         "headsign", "short_name", "direction", "block_id"],
        tripValues,
      );

      /* ─── 15. STOP_TIMES ─── */
      const stValues: any[][] = [];
      for (const [tripGtfs, sts] of stopTimesByTrip.entries()) {
        const tripUuid = tripGtfsToUuid.get(tripGtfs);
        if (!tripUuid) continue;
        sts.forEach((st, idx) => {
          const stopUuid = stopGtfsToUuid.get(st.stopGtfs);
          if (!stopUuid) return;
          stValues.push([
            tripUuid, idx + 1, stopUuid,
            st.arr, st.dep,
            st.pickup, st.dropoff, st.timepoint, st.dist,
          ]);
        });
      }
      await bulkInsert(
        "ps_stop_times",
        ["trip_id", "stop_seq", "stop_id", "arrival_time", "departure_time",
         "pickup_type", "drop_off_type", "timepoint", "shape_dist_traveled"],
        stValues,
      );

      /* ─── 16. Activity log ─── */
      try {
        await db.execute(sql`
          INSERT INTO ps_project_activity_log (project_id, user_id, action, target_type, payload)
          VALUES (${projectId}::uuid, ${userId}::uuid, 'ps.import.gtfs', 'project',
                  ${JSON.stringify({
                    fileName: req.file.originalname,
                    sizeKb: Math.round(req.file.size / 1024),
                    counts: {
                      stops: stopValues.length,
                      routes: routeValues.length,
                      variants: variantValues.length,
                      trips: tripValues.length,
                      stopTimes: stValues.length,
                      calendars: calValues.length + stubValues.length,
                      shapes: shapeValues.length,
                    },
                  })}::jsonb)
        `);
      } catch (e: any) { console.warn("[ps import] activity log failed:", e?.message); }

      /* ─── 17. Auto-popolamento Validity Matrix da GTFS calendars ─── */
      let autoImport: any = null;
      try {
        autoImport = await runValidityAutoImportFromCalendars(projectId, { dryRun: false });
        console.log(
          `[ps import] auto-validity: ${autoImport.summary.validityUpserts} upserts, ` +
          `${autoImport.summary.exceptionInserts} exceptions su ${autoImport.summary.calendars} calendars`,
        );
      } catch (e: any) {
        console.warn("[ps import] auto-validity skipped:", e?.message || e);
      }

      res.json({
        ok: true,
        counts: {
          stops: stopValues.length,
          routes: routeValues.length,
          calendars: calValues.length + stubValues.length,
          calendarDates: calDateValues.length,
          variants: variantValues.length,
          shapes: shapeValues.length,
          trips: tripValues.length,
          stopTimes: stValues.length,
        },
        autoValidity: autoImport?.summary ?? null,
      });
    } catch (e: any) {
      console.error("[ps import] failed:", e);
      res.status(500).json({ error: "Errore durante l'import: " + (e?.message || "sconosciuto") });
    }
  },
);

export default router;
