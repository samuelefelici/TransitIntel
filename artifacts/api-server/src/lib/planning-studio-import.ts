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
 * frequencies.txt: ESPANSO in corse concrete (vedi expandFrequencies).
 * Esclusi iter1: agency.txt (solo nome → ps_projects.agency_name),
 *   transfers.txt, fare_*.txt, feed_info.txt.
 */
import type { Request, Response } from "express";
import { Router, type IRouter } from "express";
import multer from "multer";
import AdmZip from "adm-zip";
import { createHash } from "node:crypto";
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

/** Esecutore SQL: db (autocommit) oppure una transazione drizzle. */
type Executor = { execute: (q: any) => Promise<any> };

/** Wipe dati operativi (mantiene il progetto + membri). */
async function wipeProjectData(projectId: string, exec: Executor = db): Promise<void> {
  // ON DELETE CASCADE fa il grosso del lavoro: cancellando i trips spariscono
  // gli stop_times, cancellando le varianti spariscono variant_stops + shape, etc.
  await exec.execute(sql`DELETE FROM ps_trips WHERE project_id = ${projectId}::uuid`);
  await exec.execute(sql`DELETE FROM ps_route_variants WHERE project_id = ${projectId}::uuid`);
  await exec.execute(sql`DELETE FROM ps_routes WHERE project_id = ${projectId}::uuid`);
  await exec.execute(sql`DELETE FROM ps_calendars WHERE project_id = ${projectId}::uuid`);
  await exec.execute(sql`DELETE FROM ps_stops WHERE project_id = ${projectId}::uuid`);
}

/** Esegue una INSERT in batch usando VALUES multipli. */
async function bulkInsert(
  table: string,
  cols: string[],
  rows: any[][],
  exec: Executor = db,
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
    await exec.execute(sql`INSERT INTO ${tableSql} (${colsSql}) VALUES ${valuesSql}`);
  }
}

/* ═══════════════════════════════════════════════════════════════════
 * RE-IMPORT NON DISTRUTTIVO (modalità "merge")
 * ───────────────────────────────────────────────────────────────────
 * Il wipe totale rigenerava TUTTI gli UUID: matrice di validità, categorie ed
 * eccezioni cascavano via con le corse, i cluster si svuotavano (fermate
 * ricreate), le UDP restavano con trip_ids orfani e gli archi fuorilinea
 * puntavano a fermate inesistenti. In modalità merge le entità vengono
 * riconosciute con le CHIAVI STABILI (gtfs_id; per le varianti la
 * import_signature route|direction|pattern) e gli UUID vengono CONSERVATI:
 *
 *  - fermate:  matched → UPDATE dei soli campi GTFS (nome/coordinate/…);
 *              i campi curati in PS (comune, dotazioni, cluster, note, foto)
 *              NON si toccano. Nuove → INSERT. Assenti dal feed → restano.
 *  - linee:    matched → UPDATE campi descrittivi; il code (modificabile a
 *              mano) resta. Nuove → INSERT. Assenti → restano.
 *  - varianti: matched per firma → UUID conservato (shape e riferimenti dei
 *              trip sopravvivono); nome operatore conservato. Nuove firme →
 *              INSERT completo (variant_stops + shape GTFS). Assenti → restano.
 *  - calendari: matched → UPDATE flag/periodo + rebuild delle date eccezione.
 *  - corse:    matched per gtfs_id → UPDATE + REPLACE degli stop_times;
 *              validità/categorie/eccezioni della matrice SOPRAVVIVONO.
 *              Nuove → INSERT. Assenti dal feed → DISATTIVATE (is_active
 *              false + attributes.importMissing) — mai cancellate. Le corse
 *              create A MANO (senza gtfs_id) non vengono toccate.
 *
 * L'auto-import della matrice dai calendari NON viene rilanciato in merge:
 * sovrascriverebbe le curatele manuali. Le corse nuove seguono il fallback
 * standard ("nessuna riga in matrice → circola") finché non vengono
 * classificate.
 * ═══════════════════════════════════════════════════════════════════ */

interface MergeCounts {
  stops: { added: number; updated: number };
  routes: { added: number; updated: number };
  variants: { added: number; matched: number };
  calendars: { added: number; updated: number };
  trips: { added: number; updated: number; deactivated: number; keptManual: number };
  stopTimes: number;
  shapes: number;
}

/** UPDATE batch set-based: un solo statement per lotto via jsonb_to_recordset
 *  (binding sicuro di testo arbitrario, niente literal array fragili). */
async function batchUpdate(
  exec: Executor, table: string, setCols: string[], colDefs: string,
  rows: Record<string, any>[], batchSize = 2000,
): Promise<void> {
  for (let i = 0; i < rows.length; i += batchSize) {
    const slice = rows.slice(i, i + batchSize);
    const sets = sql.raw(setCols.map(c => `${c} = d.${c}`).join(", "));
    await exec.execute(sql`
      UPDATE ${sql.raw(table)} s SET ${sets}
        FROM jsonb_to_recordset(${JSON.stringify(slice)}::jsonb) AS d(${sql.raw(colDefs)})
       WHERE s.id = d.id
    `);
  }
}

async function runMergeImport(
  tx: Executor,
  projectId: string,
  data: {
    stopRows: any[]; routeRows: any[]; tripRows: any[]; stopTimeRows: any[];
    shapeRows: any[]; calRows: any[]; calDateRows: any[];
  },
  filters: { keepRoutes: Set<string> | null; usedStopGtfs: Set<string> | null; usedServiceGtfs: Set<string> | null },
): Promise<MergeCounts> {
  const { keepRoutes, usedStopGtfs, usedServiceGtfs } = filters;
  const counts: MergeCounts = {
    stops: { added: 0, updated: 0 }, routes: { added: 0, updated: 0 },
    variants: { added: 0, matched: 0 }, calendars: { added: 0, updated: 0 },
    trips: { added: 0, updated: 0, deactivated: 0, keptManual: 0 },
    stopTimes: 0, shapes: 0,
  };
  const rowsOf = (r: any) => (r as any).rows ?? [];

  /* ── Mappe delle entità esistenti (chiavi stabili → uuid).
   * Fallback legacy: per linee e calendari importati prima di questa feature
   * il gtfs_id vive in `code` (l'import lo ha sempre scritto lì). */
  const exStops = new Map<string, string>();
  for (const r of rowsOf(await tx.execute(sql`
    SELECT id, gtfs_id FROM ps_stops WHERE project_id = ${projectId}::uuid AND gtfs_id IS NOT NULL`)))
    exStops.set(r.gtfs_id, r.id);
  const exRoutes = new Map<string, string>();
  for (const r of rowsOf(await tx.execute(sql`
    SELECT id, COALESCE(gtfs_id, code) AS key FROM ps_routes WHERE project_id = ${projectId}::uuid`)))
    if (r.key) exRoutes.set(r.key, r.id);
  const exCals = new Map<string, string>();
  for (const r of rowsOf(await tx.execute(sql`
    SELECT id, COALESCE(gtfs_id, code) AS key FROM ps_calendars WHERE project_id = ${projectId}::uuid`)))
    if (r.key) exCals.set(r.key, r.id);
  const exVariants = new Map<string, string>(); // signature → uuid
  const variantCountByRoute = new Map<string, number>();
  for (const r of rowsOf(await tx.execute(sql`
    SELECT id, route_id, import_signature FROM ps_route_variants WHERE project_id = ${projectId}::uuid`))) {
    if (r.import_signature) exVariants.set(r.import_signature, r.id);
    variantCountByRoute.set(r.route_id, (variantCountByRoute.get(r.route_id) || 0) + 1);
  }
  const exTrips = new Map<string, string>();
  for (const r of rowsOf(await tx.execute(sql`
    SELECT id, gtfs_id FROM ps_trips WHERE project_id = ${projectId}::uuid AND gtfs_id IS NOT NULL`)))
    exTrips.set(r.gtfs_id, r.id);
  const variantsWithShape = new Set<string>();
  for (const r of rowsOf(await tx.execute(sql`
    SELECT variant_id FROM ps_shapes WHERE project_id = ${projectId}::uuid`)))
    variantsWithShape.add(r.variant_id);

  /* ── 1. STOPS: update matched (solo campi GTFS), insert nuove ── */
  const stopGtfsToUuid = new Map<string, string>();
  const stopUpdates: Record<string, any>[] = [];
  const stopInserts: any[][] = [];
  for (const s of data.stopRows) {
    const gtfsId = s.stop_id?.trim();
    if (!gtfsId) continue;
    if (usedStopGtfs && !usedStopGtfs.has(gtfsId) && !exStops.has(gtfsId)) continue;
    const lat = num(s.stop_lat, NaN);
    const lon = num(s.stop_lon, NaN);
    if (!isFinite(lat) || !isFinite(lon)) continue;
    const existing = exStops.get(gtfsId);
    if (existing) {
      stopGtfsToUuid.set(gtfsId, existing);
      stopUpdates.push({
        id: existing, gtfs_id: gtfsId, code: s.stop_code || null,
        name: s.stop_name || gtfsId, description: s.stop_desc || null,
        lat, lon, zone_id: s.zone_id || null,
        location_type: int(s.location_type, 0),
        wheelchair_boarding: int(s.wheelchair_boarding, 0),
        platform_code: s.platform_code || null,
      });
    } else {
      if (usedStopGtfs && !usedStopGtfs.has(gtfsId)) continue;
      const id = crypto.randomUUID();
      stopGtfsToUuid.set(gtfsId, id);
      stopInserts.push([
        id, projectId, gtfsId, s.stop_code || null, s.stop_name || gtfsId,
        s.stop_desc || null, lat, lon, s.zone_id || null,
        int(s.location_type, 0), int(s.wheelchair_boarding, 0), s.platform_code || null,
      ]);
    }
  }
  await batchUpdate(tx, "ps_stops",
    ["gtfs_id", "code", "name", "description", "lat", "lon", "zone_id", "location_type", "wheelchair_boarding", "platform_code"],
    "id uuid, gtfs_id text, code text, name text, description text, lat double precision, lon double precision, zone_id text, location_type int, wheelchair_boarding int, platform_code text",
    stopUpdates);
  await bulkInsert("ps_stops",
    ["id", "project_id", "gtfs_id", "code", "name", "description", "lat", "lon", "zone_id",
     "location_type", "wheelchair_boarding", "platform_code"],
    stopInserts, tx);
  counts.stops = { added: stopInserts.length, updated: stopUpdates.length };

  /* ── 2. ROUTES: update campi descrittivi (il code editabile resta), insert nuove ── */
  const routeGtfsToUuid = new Map<string, string>();
  const importedRouteUuids: string[] = [];
  const routeUpdates: Record<string, any>[] = [];
  const routeInserts: any[][] = [];
  for (const r of data.routeRows) {
    const gtfsId = r.route_id?.trim();
    if (!gtfsId) continue;
    if (keepRoutes && !keepRoutes.has(gtfsId)) continue;
    const existing = exRoutes.get(gtfsId);
    if (existing) {
      routeGtfsToUuid.set(gtfsId, existing);
      importedRouteUuids.push(existing);
      routeUpdates.push({
        id: existing, gtfs_id: gtfsId,
        short_name: r.route_short_name || gtfsId,
        long_name: r.route_long_name || null,
        description: r.route_desc || null,
        route_type: int(r.route_type, 3),
        color: color(r.route_color), text_color: color(r.route_text_color),
        sort_order: int(r.route_sort_order, 0),
      });
    } else {
      const id = crypto.randomUUID();
      routeGtfsToUuid.set(gtfsId, id);
      importedRouteUuids.push(id);
      routeInserts.push([
        id, projectId, gtfsId, gtfsId, r.route_short_name || gtfsId,
        r.route_long_name || null, r.route_desc || null, int(r.route_type, 3),
        color(r.route_color), color(r.route_text_color), r.agency_id || null,
        int(r.route_sort_order, 0),
      ]);
    }
  }
  await batchUpdate(tx, "ps_routes",
    ["gtfs_id", "short_name", "long_name", "description", "route_type", "color", "text_color", "sort_order"],
    "id uuid, gtfs_id text, short_name text, long_name text, description text, route_type int, color text, text_color text, sort_order int",
    routeUpdates);
  await bulkInsert("ps_routes",
    ["id", "project_id", "gtfs_id", "code", "short_name", "long_name", "description",
     "route_type", "color", "text_color", "agency_id", "sort_order"],
    routeInserts, tx);
  counts.routes = { added: routeInserts.length, updated: routeUpdates.length };

  /* ── 3. CALENDARS: update matched + rebuild date, insert nuovi ── */
  const calGtfsToUuid = new Map<string, string>();
  const calUpdates: Record<string, any>[] = [];
  const calInserts: any[][] = [];
  for (const c of data.calRows) {
    const gtfsId = c.service_id?.trim();
    if (!gtfsId) continue;
    if (usedServiceGtfs && !usedServiceGtfs.has(gtfsId) && !exCals.has(gtfsId)) continue;
    const start = gtfsDate(c.start_date);
    const end = gtfsDate(c.end_date);
    if (!start || !end) continue;
    const existing = exCals.get(gtfsId);
    if (existing) {
      calGtfsToUuid.set(gtfsId, existing);
      calUpdates.push({
        id: existing, gtfs_id: gtfsId,
        monday: bool01(c.monday), tuesday: bool01(c.tuesday), wednesday: bool01(c.wednesday),
        thursday: bool01(c.thursday), friday: bool01(c.friday),
        saturday: bool01(c.saturday), sunday: bool01(c.sunday),
        start_date: start, end_date: end,
      });
    } else {
      if (usedServiceGtfs && !usedServiceGtfs.has(gtfsId)) continue;
      const id = crypto.randomUUID();
      calGtfsToUuid.set(gtfsId, id);
      calInserts.push([
        id, projectId, gtfsId, gtfsId, gtfsId,
        bool01(c.monday), bool01(c.tuesday), bool01(c.wednesday),
        bool01(c.thursday), bool01(c.friday), bool01(c.saturday), bool01(c.sunday),
        start, end,
      ]);
    }
  }
  // Stub per i service presenti solo in calendar_dates (come nel percorso pieno)
  const stubDates = new Map<string, string[]>();
  for (const cd of data.calDateRows) {
    const sid = cd.service_id?.trim();
    if (!sid || calGtfsToUuid.has(sid) || exCals.has(sid)) continue;
    if (usedServiceGtfs && !usedServiceGtfs.has(sid)) continue;
    const d = gtfsDate(cd.date);
    if (!d) continue;
    if (!stubDates.has(sid)) stubDates.set(sid, []);
    stubDates.get(sid)!.push(d);
  }
  for (const [sid, dates] of stubDates) {
    dates.sort();
    const id = crypto.randomUUID();
    calGtfsToUuid.set(sid, id);
    calInserts.push([
      id, projectId, sid, sid, sid,
      false, false, false, false, false, false, false,
      dates[0], dates[dates.length - 1],
    ]);
  }
  // Anche i matched legacy per gtfs_id (erano in exCals ma non in calGtfsToUuid se il file
  // li ridefinisce solo via calendar_dates): registra il mapping per i trips.
  for (const [key, id] of exCals) if (!calGtfsToUuid.has(key)) calGtfsToUuid.set(key, id);
  await batchUpdate(tx, "ps_calendars",
    ["gtfs_id", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "start_date", "end_date"],
    "id uuid, gtfs_id text, monday boolean, tuesday boolean, wednesday boolean, thursday boolean, friday boolean, saturday boolean, sunday boolean, start_date date, end_date date",
    calUpdates);
  await bulkInsert("ps_calendars",
    ["id", "project_id", "gtfs_id", "code", "name",
     "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
     "start_date", "end_date"],
    calInserts, tx);
  // Rebuild delle date eccezione per i calendari aggiornati
  const updatedCalIds = calUpdates.map(c => c.id);
  if (updatedCalIds.length > 0) {
    await tx.execute(sql`
      DELETE FROM ps_calendar_dates WHERE calendar_id = ANY(${`{${updatedCalIds.join(",")}}`}::uuid[])`);
  }
  const calDateValues: any[][] = [];
  for (const cd of data.calDateRows) {
    const sid = cd.service_id?.trim();
    const calId = sid ? calGtfsToUuid.get(sid) : undefined;
    if (!calId) continue;
    // solo per calendari toccati da QUESTO import (aggiornati o nuovi)
    if (!updatedCalIds.includes(calId) && !calInserts.some(v => v[0] === calId)) continue;
    const d = gtfsDate(cd.date);
    if (!d) continue;
    calDateValues.push([calId, d, int(cd.exception_type, 1)]);
  }
  await bulkInsert("ps_calendar_dates", ["calendar_id", "date", "exception_type"], calDateValues, tx);
  counts.calendars = { added: calInserts.length, updated: calUpdates.length };

  /* ── 4. STOP_TIMES indicizzati + raggruppamento varianti (stessa logica del full) ── */
  type StopTime = { seq: number; stopGtfs: string; arr: string; dep: string; pickup: number; dropoff: number; timepoint: number; dist: number | null };
  const stopTimesByTrip = new Map<string, StopTime[]>();
  for (const st of data.stopTimeRows) {
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

  const shapesByGtfsId = new Map<string, { lng: number; lat: number; seq: number }[]>();
  for (const p of data.shapeRows) {
    const sid = p.shape_id?.trim();
    if (!sid) continue;
    const lng = num(p.shape_pt_lon, NaN);
    const lat = num(p.shape_pt_lat, NaN);
    if (!isFinite(lng) || !isFinite(lat)) continue;
    if (!shapesByGtfsId.has(sid)) shapesByGtfsId.set(sid, []);
    shapesByGtfsId.get(sid)!.push({ lng, lat, seq: int(p.shape_pt_sequence, 0) });
  }

  type VariantInfo = {
    id: string; isNew: boolean; routeId: string; routeGtfs: string; direction: number;
    headsign: string | null; stopGtfsSeq: string[]; shapeGtfsId: string | null; tripIds: string[];
  };
  const variants = new Map<string, VariantInfo>();
  for (const t of data.tripRows) {
    const tripGtfs = t.trip_id?.trim();
    const routeGtfs = t.route_id?.trim();
    if (!tripGtfs || !routeGtfs) continue;
    if (keepRoutes && !keepRoutes.has(routeGtfs)) continue;
    const routeUuid = routeGtfsToUuid.get(routeGtfs);
    if (!routeUuid) continue;
    const sts = stopTimesByTrip.get(tripGtfs);
    if (!sts || sts.length === 0) continue;
    const stopSeq = sts.map(s => s.stopGtfs);
    if (stopSeq.some(s => !stopGtfsToUuid.has(s))) continue;
    const dir = int(t.direction_id, 0);
    const pattern = stopSeq.join(">");
    const signature = createHash("sha1").update(`${routeGtfs}|${dir}|${pattern}`).digest("hex");
    let v = variants.get(signature);
    if (!v) {
      const existing = exVariants.get(signature);
      v = {
        id: existing ?? crypto.randomUUID(),
        isNew: !existing,
        routeId: routeUuid, routeGtfs, direction: dir,
        headsign: (t.trip_headsign || "").trim() || null,
        stopGtfsSeq: stopSeq,
        shapeGtfsId: t.shape_id?.trim() || null,
        tripIds: [],
      };
      variants.set(signature, v);
    }
    v.tripIds.push(tripGtfs);
  }

  /* ── 5. Varianti NUOVE: insert + variant_stops + shape GTFS ── */
  const variantInserts: any[][] = [];
  const variantStopInserts: any[][] = [];
  const shapeInserts: any[][] = [];
  for (const [signature, v] of variants) {
    if (!v.isNew) { counts.variants.matched++; continue; }
    const n = (variantCountByRoute.get(v.routeId) || 0) + 1;
    variantCountByRoute.set(v.routeId, n);
    const name = v.headsign
      ? `${v.headsign}${v.direction === 1 ? " ↩" : ""}`
      : `Var. ${n}${v.direction === 1 ? " (ritorno)" : ""}`;
    variantInserts.push([v.id, projectId, v.routeId, name, v.direction, v.headsign, n === 1, signature]);
    v.stopGtfsSeq.forEach((stopGtfs, idx) => {
      const stopUuid = stopGtfsToUuid.get(stopGtfs);
      if (stopUuid) variantStopInserts.push([v.id, idx + 1, stopUuid, 0, 0, 1, null]);
    });
  }
  // Shape dal GTFS: per varianti nuove e per matched SENZA shape (mai
  // sovrascrivere un tracciato disegnato dall'operatore).
  for (const v of variants.values()) {
    if (!v.shapeGtfsId) continue;
    if (!v.isNew && variantsWithShape.has(v.id)) continue;
    const pts = shapesByGtfsId.get(v.shapeGtfsId);
    if (!pts || pts.length < 2) continue;
    pts.sort((a, b) => a.seq - b.seq);
    const coords = pts.map(p => [p.lng, p.lat]);
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
    shapeInserts.push([
      crypto.randomUUID(), projectId, v.id, "driving",
      JSON.stringify({ type: "LineString", coordinates: coords }),
      JSON.stringify([
        { lng: coords[0][0], lat: coords[0][1], mode: "snap" },
        { lng: coords[coords.length - 1][0], lat: coords[coords.length - 1][1], mode: "snap" },
      ]),
      distM, distM / 8.33,
    ]);
  }
  await bulkInsert("ps_route_variants",
    ["id", "project_id", "route_id", "name", "direction", "headsign", "is_default", "import_signature"],
    variantInserts, tx);
  await bulkInsert("ps_variant_stops",
    ["variant_id", "seq", "stop_id", "pickup_type", "drop_off_type", "timepoint", "shape_dist_traveled"],
    variantStopInserts, tx);
  await bulkInsert("ps_shapes",
    ["id", "project_id", "variant_id", "mode", "geometry", "waypoints", "distance_m", "duration_s"],
    shapeInserts, tx);
  counts.variants.added = variantInserts.length;
  counts.shapes = shapeInserts.length;

  /* ── 6. TRIPS: update matched (+ replace stop_times), insert nuove ── */
  const tripGtfsToVariant = new Map<string, VariantInfo>();
  for (const v of variants.values()) for (const tid of v.tripIds) tripGtfsToVariant.set(tid, v);
  const tripUpdates: Record<string, any>[] = [];
  const tripInserts: any[][] = [];
  const tripUuidByGtfs = new Map<string, string>();
  const feedTripGtfs = new Set<string>();
  for (const t of data.tripRows) {
    const gtfs = t.trip_id?.trim();
    if (!gtfs) continue;
    const v = tripGtfsToVariant.get(gtfs);
    if (!v) continue;
    feedTripGtfs.add(gtfs);
    const calId = t.service_id ? calGtfsToUuid.get(t.service_id.trim()) || null : null;
    const existing = exTrips.get(gtfs);
    const common = {
      route_id: v.routeId, variant_id: v.id, calendar_id: calId,
      headsign: (t.trip_headsign || "").trim() || null,
      short_name: (t.trip_short_name || "").trim() || null,
      direction: int(t.direction_id, 0),
      block_id: (t.block_id || "").trim() || null,
    };
    if (existing) {
      tripUuidByGtfs.set(gtfs, existing);
      tripUpdates.push({ id: existing, gtfs_id: gtfs, ...common });
    } else {
      const id = crypto.randomUUID();
      tripUuidByGtfs.set(gtfs, id);
      tripInserts.push([
        id, projectId, gtfs, common.route_id, common.variant_id, common.calendar_id,
        common.headsign, common.short_name, common.direction, common.block_id,
      ]);
    }
  }
  await batchUpdate(tx, "ps_trips",
    ["gtfs_id", "route_id", "variant_id", "calendar_id", "headsign", "short_name", "direction", "block_id"],
    "id uuid, gtfs_id text, route_id uuid, variant_id uuid, calendar_id uuid, headsign text, short_name text, direction smallint, block_id text",
    tripUpdates);
  await bulkInsert("ps_trips",
    ["id", "project_id", "gtfs_id", "route_id", "variant_id", "calendar_id",
     "headsign", "short_name", "direction", "block_id"],
    tripInserts, tx);
  counts.trips.added = tripInserts.length;
  counts.trips.updated = tripUpdates.length;

  // Replace stop_times per le corse aggiornate; insert per le nuove.
  const updatedTripIds = tripUpdates.map(t => t.id);
  for (let i = 0; i < updatedTripIds.length; i += 5000) {
    const slice = updatedTripIds.slice(i, i + 5000);
    await tx.execute(sql`
      DELETE FROM ps_stop_times WHERE trip_id = ANY(${`{${slice.join(",")}}`}::uuid[])`);
  }
  const stValues: any[][] = [];
  for (const [tripGtfs, sts] of stopTimesByTrip) {
    const tripUuid = tripUuidByGtfs.get(tripGtfs);
    if (!tripUuid) continue;
    sts.forEach((st, idx) => {
      const stopUuid = stopGtfsToUuid.get(st.stopGtfs);
      if (stopUuid) stValues.push([tripUuid, idx + 1, stopUuid, st.arr, st.dep, st.pickup, st.dropoff, st.timepoint, st.dist]);
    });
  }
  await bulkInsert("ps_stop_times",
    ["trip_id", "stop_seq", "stop_id", "arrival_time", "departure_time",
     "pickup_type", "drop_off_type", "timepoint", "shape_dist_traveled"],
    stValues, tx);
  counts.stopTimes = stValues.length;

  /* ── 7. Corse SPARITE dal feed: disattiva (mai cancellare). Scope: solo le
   * linee toccate da QUESTO import (con filtro linee, le altre non c'entrano).
   * Le corse manuali (gtfs_id NULL) non vengono toccate. ── */
  if (importedRouteUuids.length > 0) {
    const deact = await tx.execute(sql`
      UPDATE ps_trips t
         SET is_active = false,
             attributes = COALESCE(t.attributes, '{}'::jsonb) || '{"importMissing":true}'::jsonb,
             updated_at = now()
       WHERE t.project_id = ${projectId}::uuid
         AND t.route_id = ANY(${`{${importedRouteUuids.join(",")}}`}::uuid[])
         AND t.gtfs_id IS NOT NULL
         AND t.is_active = true
         AND NOT EXISTS (
           SELECT 1 FROM jsonb_array_elements_text(${JSON.stringify([...feedTripGtfs])}::jsonb) e
            WHERE e.value = t.gtfs_id)
    `);
    counts.trips.deactivated = (deact as any).rowCount ?? 0;
  }
  const manual = await tx.execute(sql`
    SELECT count(*)::int AS n FROM ps_trips
     WHERE project_id = ${projectId}::uuid AND gtfs_id IS NULL`);
  counts.trips.keptManual = Number(rowsOf(manual)[0]?.n ?? 0);

  return counts;
}

/* ─── FREQUENCIES.TXT → espansione in corse concrete ────────────────────────
 * I feed frequency-based erano scartati in silenzio (frequencies.txt ignorato:
 * restava UNA corsa template per finestra, tutte le ripetizioni perse). Tutto
 * il sistema a valle (matrice, UDP, scheduler, stampe) ragiona per corse
 * concrete: le finestre vengono ESPANSE qui, a monte di full e merge — una
 * corsa per partenza t_k = start + k·headway, profilo del template traslato.
 * Il gtfs_id sintetico "<trip>#f<k>" è DETERMINISTICO: il re-import merge
 * riconosce le stesse corse tra un aggiornamento e l'altro.
 * La riga template originale viene sostituita dalle espansioni. */
function hmsToSecs(t: string): number {
  const [h, m, s] = String(t).split(":").map(Number);
  return (h || 0) * 3600 + (m || 0) * 60 + (s || 0);
}
function secsToHms(sec: number): string {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
function expandFrequencies(
  tripRows: any[], stopTimeRows: any[], freqRows: any[],
): { tripRows: any[]; stopTimeRows: any[]; expandedTrips: number; templateTrips: number } {
  if (freqRows.length === 0) return { tripRows, stopTimeRows, expandedTrips: 0, templateTrips: 0 };

  const freqByTrip = new Map<string, Array<{ start: number; end: number; headway: number }>>();
  for (const f of freqRows) {
    const tid = f.trip_id?.trim();
    const headway = parseInt(f.headway_secs, 10);
    if (!tid || !isFinite(headway) || headway < 30) continue;
    const start = hmsToSecs(f.start_time || "");
    const end = hmsToSecs(f.end_time || "");
    if (end <= start) continue;
    if (!freqByTrip.has(tid)) freqByTrip.set(tid, []);
    freqByTrip.get(tid)!.push({ start, end, headway });
  }
  if (freqByTrip.size === 0) return { tripRows, stopTimeRows, expandedTrips: 0, templateTrips: 0 };

  const stByTrip = new Map<string, any[]>();
  for (const st of stopTimeRows) {
    const tid = st.trip_id?.trim();
    if (!tid || !freqByTrip.has(tid)) continue;
    if (!stByTrip.has(tid)) stByTrip.set(tid, []);
    stByTrip.get(tid)!.push(st);
  }
  for (const arr of stByTrip.values()) arr.sort((a, b) => parseInt(a.stop_sequence, 10) - parseInt(b.stop_sequence, 10));

  const outTrips: any[] = [];
  const outStopTimes: any[] = [...stopTimeRows.filter(st => !freqByTrip.has(st.trip_id?.trim() ?? ""))];
  let expandedTrips = 0;
  const CAP_PER_TRIP = 1000, CAP_TOTAL = 50000;

  for (const t of tripRows) {
    const tid = t.trip_id?.trim();
    const windows = tid ? freqByTrip.get(tid) : undefined;
    if (!windows) { outTrips.push(t); continue; }
    const profile = stByTrip.get(tid!);
    if (!profile || profile.length < 2) { outTrips.push(t); continue; } // template inutilizzabile: tienilo com'è
    const baseDep = hmsToSecs(profile[0].departure_time || profile[0].arrival_time || "0:0:0");
    let k = 0;
    for (const w of windows) {
      // GTFS: partenze da start_time INCLUSA fino a end_time ESCLUSA
      for (let dep = w.start; dep < w.end; dep += w.headway) {
        if (k >= CAP_PER_TRIP || expandedTrips >= CAP_TOTAL) break;
        const delta = dep - baseDep;
        const newTripId = `${tid}#f${k}`;
        outTrips.push({ ...t, trip_id: newTripId });
        for (const st of profile) {
          outStopTimes.push({
            ...st,
            trip_id: newTripId,
            arrival_time: secsToHms(hmsToSecs(st.arrival_time || st.departure_time || "0:0:0") + delta),
            departure_time: secsToHms(hmsToSecs(st.departure_time || st.arrival_time || "0:0:0") + delta),
          });
        }
        k++; expandedTrips++;
      }
    }
    if (k === 0) outTrips.push(t); // nessuna partenza generata: conserva il template
  }
  return { tripRows: outTrips, stopTimeRows: outStopTimes, expandedTrips, templateTrips: freqByTrip.size };
}

/* ─── Preview: leggi lo zip e restituisci l'elenco linee (senza scrivere) ───
 * Serve alla UI per far scegliere QUALI linee importare prima dell'import vero.
 * Parsa solo routes.txt e trips.txt: veloce anche su feed grandi. */
router.post(
  "/planning-studio/projects/:id/import-gtfs/preview",
  upload.single("file"),
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.id;
    const projectId = String(req.params.id || "");
    if (!UUID_RE.test(projectId)) { res.status(400).json({ error: "ID progetto non valido" }); return; }
    if (!req.file?.buffer) { res.status(400).json({ error: "Nessun file ricevuto." }); return; }
    const project = await loadProjectWritable(projectId, userId);
    if (!project) { res.status(403).json({ error: "Progetto non trovato o senza permessi di scrittura" }); return; }

    let zip: AdmZip;
    try { zip = new AdmZip(req.file.buffer); }
    catch (e: any) { res.status(400).json({ error: "ZIP non valido: " + (e?.message || "errore parsing") }); return; }

    const routesCsv = readZipFile(zip, "routes.txt");
    const tripsCsv  = readZipFile(zip, "trips.txt");
    if (!routesCsv || !tripsCsv) {
      res.status(400).json({ error: "GTFS incompleto: mancano routes.txt e/o trips.txt" }); return;
    }
    const routeRows = parseCsv(routesCsv);
    const tripRows  = parseCsv(tripsCsv);

    // corse per route_id
    const tripsByRoute = new Map<string, number>();
    for (const t of tripRows) {
      const rid = t.route_id?.trim();
      if (!rid) continue;
      tripsByRoute.set(rid, (tripsByRoute.get(rid) || 0) + 1);
    }
    const routes = routeRows
      .map(r => {
        const routeId = r.route_id?.trim();
        if (!routeId) return null;
        return {
          routeId,
          shortName: (r.route_short_name || "").trim() || routeId,
          longName: (r.route_long_name || "").trim() || null,
          routeType: int(r.route_type, 3),
          color: color(r.route_color),
          trips: tripsByRoute.get(routeId) || 0,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x != null)
      // ordina per codice linea in modo naturale (10 dopo 9)
      .sort((a, b) => a.shortName.localeCompare(b.shortName, "it", { numeric: true }));

    res.json({ routes, totalRoutes: routes.length, totalTrips: tripRows.length });
  },
);

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
    // Anti zip-bomb: cap sulla somma dei size DECOMPRESSI (multer limita solo il compresso).
    const totalUncompressed = zip.getEntries().reduce((s, e) => s + (e.header?.size || 0), 0);
    if (totalUncompressed > 600 * 1024 * 1024) {
      res.status(413).json({ error: "Archivio troppo grande una volta decompresso" }); return;
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
    const freqCsv      = readZipFile(zip, "frequencies.txt");

    if (!stopsCsv || !routesCsv || !tripsCsv || !stopTimesCsv) {
      res.status(400).json({
        error: "GTFS incompleto. Mancano uno o più file obbligatori: stops.txt, routes.txt, trips.txt, stop_times.txt",
      });
      return;
    }

    const stopRows     = parseCsv(stopsCsv);
    const routeRows    = parseCsv(routesCsv);
    let tripRows       = parseCsv(tripsCsv);
    let stopTimeRows   = parseCsv(stopTimesCsv);
    const shapeRows    = shapesCsv ? parseCsv(shapesCsv) : [];
    const calRows      = calendarCsv ? parseCsv(calendarCsv) : [];
    const calDateRows  = calDatesCsv ? parseCsv(calDatesCsv) : [];
    const agencyRows   = agencyCsv ? parseCsv(agencyCsv) : [];
    const freqRows     = freqCsv ? parseCsv(freqCsv) : [];

    // Feed frequency-based: le finestre di frequencies.txt vengono espanse in
    // corse concrete PRIMA di filtri/full/merge (gtfs_id deterministici).
    let frequenciesExpanded = 0;
    if (freqRows.length > 0) {
      const exp = expandFrequencies(tripRows, stopTimeRows, freqRows);
      tripRows = exp.tripRows;
      stopTimeRows = exp.stopTimeRows;
      frequenciesExpanded = exp.expandedTrips;
      if (exp.expandedTrips > 0) {
        console.log(`[ps import] frequencies.txt: ${exp.templateTrips} template espansi in ${exp.expandedTrips} corse concrete`);
      }
    }

    /* ─── Filtro linee (opzionale): importa solo le route_id scelte dall'utente.
     * Assente/vuoto → importa tutto (compatibile con il comportamento storico).
     * Da un feed parziale importiamo SOLO le fermate e i calendari effettivamente
     * usati dalle linee scelte, così il progetto non si riempie di orfani. */
    let keepRoutes: Set<string> | null = null;
    try {
      const raw = req.body?.routeIds;
      const arr = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (Array.isArray(arr) && arr.length > 0) {
        keepRoutes = new Set(arr.map((x: any) => String(x).trim()).filter(Boolean));
      }
    } catch { /* routeIds malformato → importa tutto */ }

    let usedStopGtfs: Set<string> | null = null;
    let usedServiceGtfs: Set<string> | null = null;
    if (keepRoutes) {
      const keptTripGtfs = new Set<string>();
      usedServiceGtfs = new Set<string>();
      for (const t of tripRows) {
        const rid = t.route_id?.trim();
        if (!rid || !keepRoutes.has(rid)) continue;
        const tid = t.trip_id?.trim();
        if (tid) keptTripGtfs.add(tid);
        const sid = t.service_id?.trim();
        if (sid) usedServiceGtfs.add(sid);
      }
      usedStopGtfs = new Set<string>();
      for (const st of stopTimeRows) {
        const tid = st.trip_id?.trim();
        if (tid && keptTripGtfs.has(tid)) {
          const s = st.stop_id?.trim();
          if (s) usedStopGtfs.add(s);
        }
      }
    }

    /* ─── MODALITÀ MERGE (re-import non distruttivo) ───
     * mode="merge" nel body: le entità vengono riconosciute per chiave stabile
     * e gli UUID conservati — matrice di validità, cluster, UDP e archi
     * fuorilinea sopravvivono all'aggiornamento del feed. */
    if (String(req.body?.mode ?? "") === "merge") {
      // dryRun=1 → ANTEPRIMA: si esegue il merge vero dentro la transazione e
      // poi si forza il ROLLBACK con una sentinella. I conteggi sono quelli
      // esatti dell'applicazione reale, ma nel DB non resta nulla.
      const isDryRun = String(req.body?.dryRun ?? "") === "1";
      class DryRunRollback extends Error {}
      try {
        let mergeCounts: MergeCounts | null = null;
        try {
          await db.transaction(async (tx) => {
            if (agencyRows[0]?.agency_name) {
              await tx.execute(sql`
                UPDATE ps_projects SET agency_name = ${agencyRows[0].agency_name},
                                       agency_timezone = ${agencyRows[0].agency_timezone || "Europe/Rome"}
                 WHERE id = ${projectId}::uuid
              `);
            }
            mergeCounts = await runMergeImport(tx, projectId,
              { stopRows, routeRows, tripRows, stopTimeRows, shapeRows, calRows, calDateRows },
              { keepRoutes, usedStopGtfs, usedServiceGtfs });
            if (isDryRun) throw new DryRunRollback();
          });
        } catch (e) {
          if (!(e instanceof DryRunRollback)) throw e;
        }
        if (isDryRun) {
          res.json({ ok: true, mode: "merge", dryRun: true, merge: mergeCounts });
          return;
        }
        try {
          await db.execute(sql`
            INSERT INTO ps_project_activity_log (project_id, user_id, action, target_type, payload)
            VALUES (${projectId}::uuid, ${userId}::uuid, 'ps.import.gtfs.merge', 'project',
                    ${JSON.stringify({ fileName: req.file.originalname, sizeKb: Math.round(req.file.size / 1024), counts: mergeCounts })}::jsonb)
          `);
        } catch (e: any) { console.warn("[ps import merge] activity log failed:", e?.message); }
        // NB: niente auto-import della matrice in merge (sovrascriverebbe le
        // curatele manuali); le corse nuove seguono il fallback standard.
        res.json({ ok: true, mode: "merge", merge: mergeCounts, frequenciesExpanded });
      } catch (e: any) {
        console.error("[ps import merge] failed:", e);
        res.status(500).json({ error: "Errore durante il re-import (merge) del GTFS" });
      }
      return;
    }

    // conteggi popolati a fine transazione: le variabili *Values sono scopate
    // dentro la callback, qui teniamo solo i numeri per log e risposta.
    let counts = { stops: 0, routes: 0, variants: 0, trips: 0, stopTimes: 0, calendars: 0, calendarDates: 0, shapes: 0 };
    try {
      /* Wipe + tutti gli insert in UNA transazione: se qualcosa fallisce a metà
       * (riga malformata, violazione FK, timeout) si fa rollback e il progetto
       * resta INTATTO, invece di restare svuotato/mezzo importato. */
      await db.transaction(async (tx) => {
      /* ─── 2. Wipe ─── */
      await wipeProjectData(projectId, tx);

      /* ─── 3. Aggiorna agency_name dal primo agency.txt ─── */
      if (agencyRows[0]?.agency_name) {
        await tx.execute(sql`
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
        if (usedStopGtfs && !usedStopGtfs.has(gtfsId)) continue; // import parziale: solo fermate usate
        const lat = num(s.stop_lat, NaN);
        const lon = num(s.stop_lon, NaN);
        if (!isFinite(lat) || !isFinite(lon)) continue;
        const id = crypto.randomUUID();
        stopGtfsToUuid.set(gtfsId, id);
        stopValues.push([
          id, projectId, gtfsId, s.stop_code || null, s.stop_name || gtfsId,
          s.stop_desc || null, lat, lon, s.zone_id || null,
          int(s.location_type, 0), int(s.wheelchair_boarding, 0),
          s.platform_code || null,
        ]);
      }
      await bulkInsert(
        "ps_stops",
        ["id", "project_id", "gtfs_id", "code", "name", "description", "lat", "lon", "zone_id",
         "location_type", "wheelchair_boarding", "platform_code"],
        stopValues,
        tx,
      );

      /* ─── 5. ROUTES ─── */
      const routeGtfsToUuid = new Map<string, string>();
      const routeValues: any[][] = [];
      for (const r of routeRows) {
        const gtfsId = r.route_id?.trim();
        if (!gtfsId) continue;
        if (keepRoutes && !keepRoutes.has(gtfsId)) continue; // importa solo le linee scelte
        const id = crypto.randomUUID();
        routeGtfsToUuid.set(gtfsId, id);
        routeValues.push([
          id, projectId, gtfsId, gtfsId,
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
        ["id", "project_id", "gtfs_id", "code", "short_name", "long_name", "description",
         "route_type", "color", "text_color", "agency_id", "sort_order"],
        routeValues,
        tx,
      );

      /* ─── 6. CALENDARS ─── */
      const calGtfsToUuid = new Map<string, string>();
      const calValues: any[][] = [];
      for (const c of calRows) {
        const gtfsId = c.service_id?.trim();
        if (!gtfsId) continue;
        if (usedServiceGtfs && !usedServiceGtfs.has(gtfsId)) continue; // solo calendari usati dalle linee scelte
        const start = gtfsDate(c.start_date);
        const end = gtfsDate(c.end_date);
        if (!start || !end) continue;
        const id = crypto.randomUUID();
        calGtfsToUuid.set(gtfsId, id);
        calValues.push([
          id, projectId, gtfsId, gtfsId, gtfsId,
          bool01(c.monday), bool01(c.tuesday), bool01(c.wednesday),
          bool01(c.thursday), bool01(c.friday), bool01(c.saturday), bool01(c.sunday),
          start, end,
        ]);
      }
      await bulkInsert(
        "ps_calendars",
        ["id", "project_id", "gtfs_id", "code", "name",
         "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
         "start_date", "end_date"],
        calValues,
        tx,
      );

      /* ─── 7. CALENDAR_DATES ─── */
      // Se il service_id non era in calendar.txt → creo un calendario "stub" tutto false
      // con start/end = min/max delle date eccezione (caso "calendar_dates only").
      const stubByService = new Map<string, { dates: string[] }>();
      for (const cd of calDateRows) {
        const sid = cd.service_id?.trim();
        if (!sid) continue;
        if (usedServiceGtfs && !usedServiceGtfs.has(sid)) continue; // solo servizi usati dalle linee scelte
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
          id, projectId, sid, sid, sid,
          false, false, false, false, false, false, false,
          info.dates[0], info.dates[info.dates.length - 1],
        ]);
      }
      await bulkInsert(
        "ps_calendars",
        ["id", "project_id", "gtfs_id", "code", "name",
         "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
         "start_date", "end_date"],
        stubValues,
        tx,
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
        tx,
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
        // Firma stabile della variante: sopravvive al re-import (gli UUID no).
        // Stessa chiave del raggruppamento: route GTFS | direction | stop pattern.
        const signature = createHash("sha1")
          .update(`${v.routeGtfs}|${v.direction}|${v.stopGtfsSeq.join(">")}`)
          .digest("hex");
        variantValues.push([
          v.id, projectId, v.routeId, name, v.direction, v.headsign,
          n === 1, // is_default = la prima variante per route
          signature,
        ]);
      }
      await bulkInsert(
        "ps_route_variants",
        ["id", "project_id", "route_id", "name", "direction", "headsign", "is_default", "import_signature"],
        variantValues,
        tx,
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
        tx,
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
        tx,
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
          id, projectId, gtfs, routeUuid, variantId, calId,
          (t.trip_headsign || "").trim() || null,
          (t.trip_short_name || "").trim() || null,
          int(t.direction_id, 0),
          (t.block_id || "").trim() || null,
        ]);
      }
      await bulkInsert(
        "ps_trips",
        ["id", "project_id", "gtfs_id", "route_id", "variant_id", "calendar_id",
         "headsign", "short_name", "direction", "block_id"],
        tripValues,
        tx,
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
        tx,
      );

      counts = {
        stops: stopValues.length,
        routes: routeValues.length,
        variants: variantValues.length,
        trips: tripValues.length,
        stopTimes: stValues.length,
        calendars: calValues.length + stubValues.length,
        calendarDates: calDateValues.length,
        shapes: shapeValues.length,
      };
      }); // fine transazione import

      /* ─── 16. Activity log ─── */
      try {
        await db.execute(sql`
          INSERT INTO ps_project_activity_log (project_id, user_id, action, target_type, payload)
          VALUES (${projectId}::uuid, ${userId}::uuid, 'ps.import.gtfs', 'project',
                  ${JSON.stringify({
                    fileName: req.file.originalname,
                    sizeKb: Math.round(req.file.size / 1024),
                    counts: {
                      stops: counts.stops,
                      routes: counts.routes,
                      variants: counts.variants,
                      trips: counts.trips,
                      stopTimes: counts.stopTimes,
                      calendars: counts.calendars,
                      shapes: counts.shapes,
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
          stops: counts.stops,
          routes: counts.routes,
          calendars: counts.calendars,
          calendarDates: counts.calendarDates,
          variants: counts.variants,
          shapes: counts.shapes,
          trips: counts.trips,
          stopTimes: counts.stopTimes,
        },
        autoValidity: autoImport?.summary ?? null,
        frequenciesExpanded,
      });
    } catch (e: any) {
      // dettaglio solo nei log (poteva leakare schema/constraint DB al client)
      console.error("[ps import] failed:", e);
      res.status(500).json({ error: "Errore durante l'import del GTFS" });
    }
  },
);

export default router;
