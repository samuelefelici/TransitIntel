/**
 * Planning Studio → GTFS Feed materializer.
 *
 * Esporta i dati di un PsProject (tabelle ps_*) in un gtfs_feed dedicato (gtfs_*),
 * così la pipeline di scheduling (fucina) può lavorarci sopra senza dover importare
 * un secondo zip GTFS.
 *
 * Idempotente: se il PsProject ha già un feed materializzato (ps_projects.materialized_feed_id),
 * viene cancellato e ricreato (ON DELETE CASCADE pulisce tutte le tabelle gtfs_*).
 *
 * Uso programmatico:
 *   const { feedId, label } = await materializePsToFeed(psProjectId, ownerUserId);
 *
 * Endpoint HTTP:
 *   POST /api/scheduling/projects/:id/sync-from-ps  → re-materializza e aggiorna scheduling_projects.feed_id
 */
import type { Request, Response } from "express";
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const router: IRouter = Router();
const UUID_RE = /^[0-9a-f-]{36}$/i;

/* ════════════════════════════════════════════════════════════
 *  Bootstrap colonna materialized_feed_id su ps_projects
 * ════════════════════════════════════════════════════════════ */
let bootstrapped = false;
async function ensureMaterializedColumn(): Promise<void> {
  if (bootstrapped) return;
  await db.execute(sql`
    ALTER TABLE ps_projects
      ADD COLUMN IF NOT EXISTS materialized_feed_id uuid,
      ADD COLUMN IF NOT EXISTS materialized_at timestamptz
  `);
  bootstrapped = true;
}

/* ════════════════════════════════════════════════════════════
 *  Helpers
 * ════════════════════════════════════════════════════════════ */

/** YYYY-MM-DD → YYYYMMDD */
function dateToGtfs(d: string | Date | null | undefined): string {
  if (!d) return "";
  const s = typeof d === "string" ? d : d.toISOString().slice(0, 10);
  return s.replace(/-/g, "").slice(0, 8);
}

/** Bulk insert con VALUES multipli. */
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

/* ════════════════════════════════════════════════════════════
 *  Permessi: il chiamante deve essere owner/member del PsProject
 * ════════════════════════════════════════════════════════════ */
async function loadPsProjectAccessible(psProjectId: string, userId: string): Promise<any | null> {
  const r = await db.execute(sql`
    SELECT p.*,
           CASE WHEN p.owner_user_id = ${userId}::uuid THEN 'owner'
                ELSE pm.role END AS my_role
      FROM ps_projects p
      LEFT JOIN ps_project_members pm
             ON pm.project_id = p.id AND pm.user_id = ${userId}::uuid
     WHERE p.id = ${psProjectId}::uuid
       AND (p.owner_user_id = ${userId}::uuid OR pm.user_id IS NOT NULL)
     LIMIT 1
  `);
  const row: any = (r as any).rows?.[0] ?? (r as any)[0] ?? null;
  return row;
}

/* ════════════════════════════════════════════════════════════
 *  Funzione principale: PS → gtfs_feed
 * ════════════════════════════════════════════════════════════ */

export interface MaterializeResult {
  feedId: string;
  label: string;
  feedStartDate: string;  // YYYYMMDD
  feedEndDate: string;    // YYYYMMDD
  counts: {
    stops: number;
    routes: number;
    trips: number;
    stopTimes: number;
    calendars: number;
    calendarDates: number;
    shapes: number;
  };
}

export async function materializePsToFeed(
  psProjectId: string,
  ownerUserId: string,
): Promise<MaterializeResult> {
  await ensureMaterializedColumn();

  const project = await loadPsProjectAccessible(psProjectId, ownerUserId);
  if (!project) {
    throw new Error("PsProject non trovato o senza permessi di lettura");
  }

  /* ── 1. Carica tutti i dati PS in memoria ──────────────────── */
  const stopsR = await db.execute(sql`
    SELECT id, code, name, description, lat, lon, wheelchair_boarding
      FROM ps_stops WHERE project_id = ${psProjectId}::uuid
  `);
  const psStops: any[] = (stopsR as any).rows ?? stopsR ?? [];

  const routesR = await db.execute(sql`
    SELECT id, code, short_name, long_name, description, route_type, color, text_color, agency_id
      FROM ps_routes WHERE project_id = ${psProjectId}::uuid
  `);
  const psRoutes: any[] = (routesR as any).rows ?? routesR ?? [];

  const calendarsR = await db.execute(sql`
    SELECT id, code, name, monday, tuesday, wednesday, thursday, friday, saturday, sunday,
           start_date, end_date
      FROM ps_calendars WHERE project_id = ${psProjectId}::uuid
  `);
  const psCalendars: any[] = (calendarsR as any).rows ?? calendarsR ?? [];

  const calDatesR = await db.execute(sql`
    SELECT cd.calendar_id, cd.date, cd.exception_type
      FROM ps_calendar_dates cd
      JOIN ps_calendars c ON c.id = cd.calendar_id
     WHERE c.project_id = ${psProjectId}::uuid
  `);
  const psCalDates: any[] = (calDatesR as any).rows ?? calDatesR ?? [];

  const tripsR = await db.execute(sql`
    SELECT id, route_id, variant_id, calendar_id, headsign, short_name, direction
      FROM ps_trips
     WHERE project_id = ${psProjectId}::uuid
       AND COALESCE(is_active, true) = true
  `);
  const psTrips: any[] = (tripsR as any).rows ?? tripsR ?? [];

  const stopTimesR = await db.execute(sql`
    SELECT st.trip_id, st.stop_seq, st.stop_id, st.arrival_time, st.departure_time,
           st.pickup_type, st.drop_off_type
      FROM ps_stop_times st
      JOIN ps_trips t ON t.id = st.trip_id
     WHERE t.project_id = ${psProjectId}::uuid
       AND COALESCE(t.is_active, true) = true
  `);
  const psStopTimes: any[] = (stopTimesR as any).rows ?? stopTimesR ?? [];

  const shapesR = await db.execute(sql`
    SELECT variant_id, geometry
      FROM ps_shapes WHERE project_id = ${psProjectId}::uuid
  `);
  const psShapes: any[] = (shapesR as any).rows ?? shapesR ?? [];

  /* ── 2. Cancella vecchio feed materializzato (CASCADE pulisce gtfs_*) ── */
  if (project.materialized_feed_id) {
    await db.execute(sql`DELETE FROM gtfs_feeds WHERE id = ${project.materialized_feed_id}::uuid`);
  }

  /* ── 3. Calcola feed_start_date / feed_end_date dai calendari ── */
  let minStart: string | null = null;
  let maxEnd: string | null = null;
  for (const c of psCalendars) {
    const s = dateToGtfs(c.start_date);
    const e = dateToGtfs(c.end_date);
    if (s && (!minStart || s < minStart)) minStart = s;
    if (e && (!maxEnd || e > maxEnd)) maxEnd = e;
  }
  // Fallback: se nessun calendario ha date utilizzabili, usa range "oggi → +1 anno"
  if (!minStart) {
    const today = new Date();
    minStart = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, "0")}${String(today.getDate()).padStart(2, "0")}`;
  }
  if (!maxEnd) {
    const next = new Date();
    next.setFullYear(next.getFullYear() + 1);
    maxEnd = `${next.getFullYear()}${String(next.getMonth() + 1).padStart(2, "0")}${String(next.getDate()).padStart(2, "0")}`;
  }

  /* ── 4. Crea gtfs_feeds row ─────────────────────────────────── */
  const label = `PS · ${project.name}`;
  const filename = `ps-${psProjectId.slice(0, 8)}.synthetic`;

  const feedR = await db.execute(sql`
    INSERT INTO gtfs_feeds (filename, agency_name, feed_start_date, feed_end_date,
                            stops_count, routes_count, trips_count, shapes_count)
    VALUES (${filename}, ${project.agency_name || project.name}, ${minStart}, ${maxEnd},
            ${psStops.length}, ${psRoutes.length}, ${psTrips.length}, ${psShapes.length})
    RETURNING id
  `);
  const feedId: string = ((feedR as any).rows?.[0] ?? (feedR as any)[0]).id;

  // owner_user_id (colonna additiva runtime → UPDATE separato)
  await db.execute(sql`
    UPDATE gtfs_feeds SET owner_user_id = ${ownerUserId}::uuid WHERE id = ${feedId}::uuid
  `);

  /* ── 5. Bulk insert gtfs_stops ──────────────────────────────── */
  const stopRows = psStops.map(s => [
    feedId, String(s.id), s.code || null, s.name, s.description || null,
    Number(s.lat), Number(s.lon), s.wheelchair_boarding ?? 0,
  ]);
  await bulkInsert(
    "gtfs_stops",
    ["feed_id", "stop_id", "stop_code", "stop_name", "stop_desc",
     "stop_lat", "stop_lon", "wheelchair_boarding"],
    stopRows,
  );

  /* ── 6. Bulk insert gtfs_routes ─────────────────────────────── */
  const routeTripCount = new Map<string, number>();
  for (const t of psTrips) {
    const k = String(t.route_id);
    routeTripCount.set(k, (routeTripCount.get(k) || 0) + 1);
  }
  const routeRows = psRoutes.map(r => [
    feedId, String(r.id), r.agency_id || null,
    r.short_name || r.code || "", r.long_name || null,
    r.route_type ?? 3, r.color || null, r.text_color || null,
    routeTripCount.get(String(r.id)) || 0,
  ]);
  await bulkInsert(
    "gtfs_routes",
    ["feed_id", "route_id", "agency_id", "route_short_name", "route_long_name",
     "route_type", "route_color", "route_text_color", "trips_count"],
    routeRows,
  );

  /* ── 7. Bulk insert gtfs_calendar / gtfs_calendar_dates ─────── */
  const calRows = psCalendars.map(c => [
    feedId, String(c.id),
    c.monday ? 1 : 0, c.tuesday ? 1 : 0, c.wednesday ? 1 : 0, c.thursday ? 1 : 0,
    c.friday ? 1 : 0, c.saturday ? 1 : 0, c.sunday ? 1 : 0,
    dateToGtfs(c.start_date) || minStart, dateToGtfs(c.end_date) || maxEnd,
  ]);
  await bulkInsert(
    "gtfs_calendar",
    ["feed_id", "service_id", "monday", "tuesday", "wednesday", "thursday",
     "friday", "saturday", "sunday", "start_date", "end_date"],
    calRows,
  );

  const calDateRows = psCalDates.map(cd => [
    feedId, String(cd.calendar_id), dateToGtfs(cd.date), cd.exception_type ?? 1,
  ]);
  await bulkInsert(
    "gtfs_calendar_dates",
    ["feed_id", "service_id", "date", "exception_type"],
    calDateRows,
  );

  /* ── 8. Bulk insert gtfs_trips ──────────────────────────────── */
  // Calendari "fittizi" per trip senza calendar_id: uso primo calendario disponibile o un service_id placeholder
  const fallbackServiceId = psCalendars.length > 0 ? String(psCalendars[0].id) : "DEFAULT";
  if (psCalendars.length === 0 && psTrips.length > 0) {
    // crea un calendario di fallback "tutti i giorni"
    await db.execute(sql`
      INSERT INTO gtfs_calendar (feed_id, service_id, monday, tuesday, wednesday,
                                 thursday, friday, saturday, sunday, start_date, end_date)
      VALUES (${feedId}::uuid, ${fallbackServiceId}, 1, 1, 1, 1, 1, 1, 1, ${minStart}, ${maxEnd})
    `);
  }

  const tripRows = psTrips.map(t => [
    feedId, String(t.id), String(t.route_id),
    t.calendar_id ? String(t.calendar_id) : fallbackServiceId,
    t.headsign || null, t.direction ?? 0,
    String(t.variant_id),  // shape_id = variant_id (1 shape per variante)
  ]);
  await bulkInsert(
    "gtfs_trips",
    ["feed_id", "trip_id", "route_id", "service_id",
     "trip_headsign", "direction_id", "shape_id"],
    tripRows,
  );

  /* ── 9. Bulk insert gtfs_stop_times ───────────────────────────
   * Tabella più grande (300k+ righe). Usa batch da 5000 (8 cols → 40k
   * parametri/query, sotto il limite Postgres di 65535) per ridurre il
   * round-trip count da 215 a ~65, quasi 4× più veloce.
   */
  const stRows = psStopTimes.map(st => [
    feedId, String(st.trip_id), String(st.stop_id), Number(st.stop_seq),
    st.departure_time, st.arrival_time,
    st.pickup_type ?? 0, st.drop_off_type ?? 0,
  ]);
  await bulkInsert(
    "gtfs_stop_times",
    ["feed_id", "trip_id", "stop_id", "stop_sequence",
     "departure_time", "arrival_time", "pickup_type", "drop_off_type"],
    stRows,
    5000,
  );

  /* ── 10. Bulk insert gtfs_shapes (geometry come geojson LineString) ── */
  // Mappa variant_id → route info per alimentare gtfs_shapes.route_short_name/route_color
  const variantToRoute = new Map<string, { id: string; shortName: string; color: string | null }>();
  // Carica varianti per ottenere route_id
  const variantsR = await db.execute(sql`
    SELECT v.id, v.route_id FROM ps_route_variants v
     WHERE v.project_id = ${psProjectId}::uuid
  `);
  const psVariants: any[] = (variantsR as any).rows ?? variantsR ?? [];
  const routeById = new Map(psRoutes.map(r => [String(r.id), r]));
  for (const v of psVariants) {
    const rt = routeById.get(String(v.route_id));
    variantToRoute.set(String(v.id), {
      id: String(v.route_id),
      shortName: rt?.short_name || rt?.code || "",
      color: rt?.color || null,
    });
  }

  const shapeRows = psShapes.map(s => {
    const vid = String(s.variant_id);
    const rt = variantToRoute.get(vid);
    return [
      feedId, vid, rt?.id || null, rt?.shortName || null, rt?.color || null,
      JSON.stringify(s.geometry),
    ];
  });
  await bulkInsert(
    "gtfs_shapes",
    ["feed_id", "shape_id", "route_id", "route_short_name", "route_color", "geojson"],
    shapeRows,
  );

  /* ── 10b. Propaga ps_stop_clusters → stop_clusters legacy ───
   * I cluster di interscambio gestiti nel Network Engine vengono replicati
   * nelle tabelle legacy `stop_clusters` / `stop_cluster_stops` riusando lo
   * stesso UUID, così che gli endpoint di scheduling (deadheads, driver-shifts)
   * possano referenziarli usando gli ID conosciuti dal frontend PS.
   * Idempotente: cancella i precedenti (stesso id) e reinserisce.
   */
  const psClustersR = await db.execute(sql`
    SELECT id, name, kind, COALESCE(radius_m, 150) AS radius_m,
           COALESCE(attributes, '{}'::jsonb) AS attributes
      FROM ps_stop_clusters
     WHERE project_id = ${psProjectId}::uuid
       AND COALESCE(kind, 'interchange') = 'interchange'
  `);
  const psClusters: any[] = (psClustersR as any).rows ?? psClustersR ?? [];

  if (psClusters.length > 0) {
    const ids = psClusters.map(c => String(c.id));
    // Postgres array literal: drizzle's sql`` espande gli array JS come tupla
    // ($1,$2,...) che non castabile a uuid[]. Passiamo un singolo literal '{...}'.
    const idsLiteral = `{${ids.join(",")}}`;
    // Cleanup precedenti (CASCADE pulisce stop_cluster_stops)
    await db.execute(sql`
      DELETE FROM stop_clusters WHERE id = ANY(${idsLiteral}::uuid[])
    `);

    // Insert cluster (id riusato)
    const clusterRows = psClusters.map(c => {
      const attrs = (typeof c.attributes === "string" ? JSON.parse(c.attributes) : c.attributes) || {};
      const transferMin = Number(attrs.transferFromDepotMin ?? attrs.transfer_from_depot_min ?? 10);
      const color = String(attrs.color ?? "#3b82f6");
      return [String(c.id), c.name || "Cluster", transferMin, color];
    });
    await bulkInsert(
      "stop_clusters",
      ["id", "name", "transfer_from_depot_min", "color"],
      clusterRows,
    );

    // Carica fermate assegnate ai cluster (ps_stops.cluster_id)
    const clusterStopsR = await db.execute(sql`
      SELECT s.id AS stop_id, s.name AS stop_name, s.lat, s.lon, s.cluster_id
        FROM ps_stops s
       WHERE s.project_id = ${psProjectId}::uuid
         AND s.cluster_id IS NOT NULL
         AND s.cluster_id = ANY(${idsLiteral}::uuid[])
    `);
    const clusterStopRows: any[] = (clusterStopsR as any).rows ?? clusterStopsR ?? [];
    if (clusterStopRows.length > 0) {
      const rows = clusterStopRows.map(r => [
        String(r.cluster_id), String(r.stop_id), r.stop_name || String(r.stop_id),
        Number(r.lat), Number(r.lon),
      ]);
      await bulkInsert(
        "stop_cluster_stops",
        ["cluster_id", "gtfs_stop_id", "stop_name", "stop_lat", "stop_lon"],
        rows,
      );
    }
  }

  /* ── 11. Aggiorna ps_projects.materialized_feed_id ──────────── */
  await db.execute(sql`
    UPDATE ps_projects
       SET materialized_feed_id = ${feedId}::uuid,
           materialized_at = now()
     WHERE id = ${psProjectId}::uuid
  `);

  return {
    feedId,
    label,
    feedStartDate: minStart,
    feedEndDate: maxEnd,
    counts: {
      stops: psStops.length,
      routes: psRoutes.length,
      trips: psTrips.length,
      stopTimes: psStopTimes.length,
      calendars: psCalendars.length,
      calendarDates: psCalDates.length,
      shapes: psShapes.length,
    },
  };
}

/* ════════════════════════════════════════════════════════════
 *  Job tracker in-memory per sync async
 *  ────────────────────────────────────────────────────────────
 *  La materializzazione di un PS grande (300k+ stop_times) impiega
 *  60-180 secondi: oltre il timeout del proxy Render (~100 s) → 502.
 *  Quindi sync-from-ps è ASYNC: avvia il job e ritorna 202 subito;
 *  il frontend polla GET /scheduling/projects/:id/sync-status.
 * ════════════════════════════════════════════════════════════ */
type SyncJob = {
  status: "running" | "done" | "error";
  startedAt: number;
  finishedAt?: number;
  result?: MaterializeResult;
  error?: string;
};
const syncJobs = new Map<string, SyncJob>(); // key = scheduling project id

export function startSyncJob(
  projectId: string,
  psProjectId: string,
  ownerUserId: string,
  logger?: { info?: any; error?: any; warn?: any },
): SyncJob {
  const existing = syncJobs.get(projectId);
  if (existing && existing.status === "running") return existing;

  const job: SyncJob = { status: "running", startedAt: Date.now() };
  syncJobs.set(projectId, job);

  void (async () => {
    try {
      const result = await materializePsToFeed(psProjectId, ownerUserId);
      await db.execute(sql`
        UPDATE scheduling_projects
           SET feed_id = ${result.feedId}::uuid,
               feed_label = ${result.label},
               updated_at = now()
         WHERE id = ${projectId}::uuid
      `);
      job.status = "done";
      job.result = result;
      job.finishedAt = Date.now();
      logger?.info?.({ projectId, feedId: result.feedId, counts: result.counts,
        durationMs: job.finishedAt - job.startedAt }, "sync-from-ps completed");
    } catch (e: any) {
      job.status = "error";
      job.error = e?.message || String(e);
      job.finishedAt = Date.now();
      logger?.error?.({ err: e, projectId }, "sync-from-ps failed");
    }
  })();

  return job;
}

/* ════════════════════════════════════════════════════════════
 *  Endpoint HTTP: re-sync di uno scheduling_project con il PS linkato
 *  ────────────────────────────────────────────────────────────
 *  ASYNC: ritorna 202 subito + stato del job. Per attendere il
 *  completamento usa GET /scheduling/projects/:id/sync-status.
 *  Se ?wait=1 è passato, prova ad attendere fino a 90 s (utile in
 *  dev locale, in prod il proxy timeout potrebbe rispondere 502).
 * ════════════════════════════════════════════════════════════ */

async function loadProjectForSync(req: Request, res: Response): Promise<any | null> {
  const userId = req.user!.id;
  const projectId = String(req.params.id || "");
  if (!UUID_RE.test(projectId)) { res.status(400).json({ error: "ID progetto non valido" }); return null; }

  const projR = await db.execute(sql`
    SELECT p.id, p.name, p.owner_user_id, p.planning_studio_project_id, p.feed_id, p.feed_label,
           CASE WHEN p.owner_user_id = ${userId}::uuid THEN 'owner'
                ELSE pm.role END AS my_role
      FROM scheduling_projects p
      LEFT JOIN project_members pm
             ON pm.project_id = p.id AND pm.user_id = ${userId}::uuid
     WHERE p.id = ${projectId}::uuid
       AND (p.owner_user_id = ${userId}::uuid OR pm.user_id IS NOT NULL)
     LIMIT 1
  `);
  const proj: any = (projR as any).rows?.[0] ?? (projR as any)[0] ?? null;
  if (!proj) { res.status(404).json({ error: "Progetto non trovato o senza permessi" }); return null; }
  if (proj.my_role === "viewer") {
    res.status(403).json({ error: "I viewer non possono sincronizzare il feed dal Planning Studio" });
    return null;
  }
  if (!proj.planning_studio_project_id) {
    res.status(400).json({ error: "Questo progetto non è collegato a nessun PsProject" });
    return null;
  }
  return proj;
}

router.post(
  "/scheduling/projects/:id/sync-from-ps",
  async (req: Request, res: Response): Promise<void> => {
    try {
      const proj = await loadProjectForSync(req, res);
      if (!proj) return;
      const projectId = String(proj.id);
      const userId = req.user!.id;
      const wantWait = req.query.wait === "1" || (req.body && (req.body as any).wait === true);

      const job = startSyncJob(
        projectId,
        String(proj.planning_studio_project_id),
        userId,
        req.log,
      );

      // Modalità sync (legacy / dev): aspetta max 90 s prima di rispondere.
      if (wantWait) {
        const start = Date.now();
        while (job.status === "running" && (Date.now() - start) < 90_000) {
          await new Promise(r => setTimeout(r, 500));
        }
        if (job.status === "done" && job.result) {
          res.json({ ok: true, ...job.result });
          return;
        }
        if (job.status === "error") {
          res.status(500).json({ error: job.error || "Errore materializzazione" });
          return;
        }
        // ancora in esecuzione → riporta 202 con stato
      }

      res.status(202).json({
        ok: true,
        status: job.status,
        message: "Sincronizzazione avviata in background. Polla /sync-status per il risultato.",
        startedAt: new Date(job.startedAt).toISOString(),
      });
    } catch (e: any) {
      req.log?.error?.({ err: e }, "sync-from-ps endpoint error");
      res.status(500).json({ error: e?.message || "Errore avvio sincronizzazione" });
    }
  },
);

router.get(
  "/scheduling/projects/:id/sync-status",
  async (req: Request, res: Response): Promise<void> => {
    try {
      const proj = await loadProjectForSync(req, res);
      if (!proj) return;
      const projectId = String(proj.id);
      const job = syncJobs.get(projectId);

      // Se non c'è nessun job in memoria, il feed potrebbe essere già pronto
      // (job completato in una vita precedente del processo, o creato senza job).
      if (!job) {
        if (proj.feed_id) {
          // Recupera info sintetiche dal feed per allineare la response al
          // formato di MaterializeResult (counts/feedStartDate/feedEndDate).
          const fr: any = await db.execute(sql`
            SELECT id, feed_start_date, feed_end_date,
                   stops_count, routes_count, trips_count, shapes_count
              FROM gtfs_feeds WHERE id = ${proj.feed_id}::uuid
          `);
          const f: any = fr.rows?.[0] ?? fr[0];
          res.json({
            status: "done",
            feedId: proj.feed_id,
            label: proj.feed_label || `PS · ${proj.name || ""}`.trim(),
            feedStartDate: (f?.feed_start_date || "").toString().replace(/-/g, "").slice(0, 8),
            feedEndDate: (f?.feed_end_date || "").toString().replace(/-/g, "").slice(0, 8),
            counts: {
              stops: Number(f?.stops_count ?? 0),
              routes: Number(f?.routes_count ?? 0),
              trips: Number(f?.trips_count ?? 0),
              stopTimes: 0, calendars: 0, calendarDates: 0,
              shapes: Number(f?.shapes_count ?? 0),
            },
          });
          return;
        }
        res.json({ status: "idle" });
        return;
      }

      if (job.status === "done" && job.result) {
        res.json({ status: "done", ...job.result, durationMs: (job.finishedAt || Date.now()) - job.startedAt });
        return;
      }
      if (job.status === "error") {
        res.json({ status: "error", error: job.error });
        return;
      }
      res.json({
        status: "running",
        startedAt: new Date(job.startedAt).toISOString(),
        elapsedMs: Date.now() - job.startedAt,
      });
    } catch (e: any) {
      req.log?.error?.({ err: e }, "sync-status endpoint error");
      res.status(500).json({ error: e?.message || "Errore stato sincronizzazione" });
    }
  },
);

export default router;
