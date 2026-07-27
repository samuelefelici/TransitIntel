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
import { createHash } from "crypto";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { computeActiveDatesByTrip, projectHasTripValidity } from "./planning-studio-validity-eval";

const router: IRouter = Router();

/** 'YYYYMMDD' → 'YYYY-MM-DD'. */
function ymdToIso(ymd: string): string {
  return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
}
/** aggiunge n giorni a una data ISO 'YYYY-MM-DD' (UTC). */
function plusDaysIso(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  t.setUTCDate(t.getUTCDate() + n);
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
}
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
  opts?: {
    tripIds?: string[] | null;
    /** Feed VECCHIO da rimuovere DOPO aver costruito il nuovo (delete-last).
     *  Se undefined: per l'esercizio (non scoped) usa ps_projects.materialized_feed_id;
     *  per una UDP (scoped) NON tocca nessun feed a meno che non sia passato esplicito.
     *  Passare null per non cancellare nulla. */
    replaceFeedId?: string | null;
    /** Se aggiornare ps_projects.materialized_feed_id (feed d'esercizio globale).
     *  Default: true solo per l'esercizio (non scoped). Le UDP NON devono toccarlo. */
    updateProjectPointer?: boolean;
  },
): Promise<MaterializeResult> {
  await ensureMaterializedColumn();

  const project = await loadPsProjectAccessible(psProjectId, ownerUserId);
  if (!project) {
    throw new Error("PsProject non trovato o senza permessi di lettura");
  }

  // Scoping per UDP: se passiamo un sottoinsieme di corse, il feed materializzato
  // contiene SOLO quelle (e le linee/calendari/shape che usano) — così "mandare
  // una UDP" non porta tutto il progetto nello scheduling.
  const scoped = Array.isArray(opts?.tripIds) && opts!.tripIds!.length > 0;
  // Un feed PER SCOPO, non uno slot unico per progetto: l'esercizio usa
  // ps_projects.materialized_feed_id, ogni UDP il proprio scheduling_projects.feed_id.
  // Prima ogni materializzazione cancellava lo slot unico → le UDP sorelle si
  // distruggevano il feed a vicenda (ping-pong). Ora ognuno rimpiazza SOLO il suo.
  const replaceFeedId = opts?.replaceFeedId !== undefined
    ? opts.replaceFeedId
    : (scoped ? null : (project.materialized_feed_id ?? null));
  const updateProjectPointer = opts?.updateProjectPointer ?? !scoped;
  const tripIdsLit = scoped ? `{${opts!.tripIds!.join(",")}}` : "";
  // frammenti riusabili: alias `t`, senza alias, e sottoinsiemi route/calendar/variant
  const fT = scoped ? sql`AND t.id = ANY(${tripIdsLit}::uuid[])` : sql``;
  const fBare = scoped ? sql`AND id = ANY(${tripIdsLit}::uuid[])` : sql``;
  const fRoute = scoped ? sql`AND r.id IN (SELECT DISTINCT route_id FROM ps_trips WHERE id = ANY(${tripIdsLit}::uuid[]))` : sql``;
  const fCalProj = scoped ? sql`AND id IN (SELECT DISTINCT calendar_id FROM ps_trips WHERE id = ANY(${tripIdsLit}::uuid[]) AND calendar_id IS NOT NULL)` : sql``;
  const fCalC = scoped ? sql`AND c.id IN (SELECT DISTINCT calendar_id FROM ps_trips WHERE id = ANY(${tripIdsLit}::uuid[]) AND calendar_id IS NOT NULL)` : sql``;
  const fShape = scoped ? sql`AND s.variant_id IN (SELECT DISTINCT variant_id FROM ps_trips WHERE id = ANY(${tripIdsLit}::uuid[]))` : sql``;

  /* ────────────────────────────────────────────────────────────
   * STRATEGIA "ALL-IN-POSTGRES":
   * I dati NON passano per Node. Usiamo INSERT ... SELECT con
   * cast (uuid → text). Per Conerobus (321k stop_times) passiamo
   * da ~3 minuti + 500MB RAM Node a ~5 secondi e ~10MB RAM Node.
   * Niente più OOM su Render starter.
   * ──────────────────────────────────────────────────────────── */

  /* ── 1. (delete-last) Il vecchio feed si cancella SOLO alla fine, dopo aver
   *    costruito e agganciato il nuovo: se qualcosa fallisce a metà il feed
   *    esistente (esercizio o UDP) resta intatto invece di sparire. ── */

  /* ── 2. Calcola feed_start_date / feed_end_date dai calendari ──
   * Singola query aggregata, evita load di tutti i calendari in Node. */
  const dateRangeR: any = await db.execute(sql`
    SELECT to_char(MIN(start_date), 'YYYYMMDD') AS min_start,
           to_char(MAX(end_date),   'YYYYMMDD') AS max_end
      FROM ps_calendars WHERE project_id = ${psProjectId}::uuid
  `);
  const dr: any = dateRangeR.rows?.[0] ?? dateRangeR[0] ?? {};
  let minStart: string = dr.min_start || "";
  let maxEnd: string = dr.max_end || "";
  if (!minStart) {
    const today = new Date();
    minStart = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, "0")}${String(today.getDate()).padStart(2, "0")}`;
  }
  if (!maxEnd) {
    const next = new Date();
    next.setFullYear(next.getFullYear() + 1);
    maxEnd = `${next.getFullYear()}${String(next.getMonth() + 1).padStart(2, "0")}${String(next.getDate()).padStart(2, "0")}`;
  }

  /* ── 3. Crea gtfs_feeds row (con counter aggregati) ─────────── */
  const label = `PS · ${project.name}`;
  const filename = `ps-${psProjectId.slice(0, 8)}.synthetic`;
  const agencyName = project.agency_name || project.name;

  const feedR: any = await db.execute(sql`
    INSERT INTO gtfs_feeds (filename, agency_name, feed_start_date, feed_end_date,
                            stops_count, routes_count, trips_count, shapes_count)
    SELECT ${filename}, ${agencyName}, ${minStart}, ${maxEnd},
           (SELECT count(*) FROM ps_stops  WHERE project_id = ${psProjectId}::uuid),
           (SELECT count(*) FROM ps_routes WHERE project_id = ${psProjectId}::uuid),
           (SELECT count(*) FROM ps_trips  WHERE project_id = ${psProjectId}::uuid AND COALESCE(is_active, true) = true),
           (SELECT count(*) FROM ps_shapes WHERE project_id = ${psProjectId}::uuid)
    RETURNING id
  `);
  const feedId: string = (feedR.rows?.[0] ?? feedR[0]).id;

  // owner_user_id (colonna additiva runtime)
  await db.execute(sql`
    UPDATE gtfs_feeds SET owner_user_id = ${ownerUserId}::uuid WHERE id = ${feedId}::uuid
  `);

  /* ── 4. INSERT ... SELECT puro Postgres ──────────────────────
   * Tutti i dati restano nel DB. Node non vede una sola riga. */

  /* ── 5C · VALIDITÀ EFFETTIVA ──────────────────────────────────
   * Se il progetto usa la MATRICE di validità (bollini corsa×day-type),
   * il feed rappresenta la validità EFFETTIVA (day_validity + weekdays +
   * eccezioni + valid_from/to + categorie/ombrello) come gtfs_calendar_dates
   * PURI (una riga add per ogni data attiva), con gtfs_calendar VUOTA. Così i
   * giorni di servizio del feed coincidono con matrice/UDP/stampe.
   * Vincolo "no-mix" dei consumatori del feed (buildServiceDayMap ecc.):
   * o TUTTO settimanale (legacy, ramo else più sotto) o TUTTO calendar_dates
   * con gtfs_calendar a zero righe — mai un misto. La scelta è per-feed. */
  const useEffectiveValidity = await projectHasTripValidity(psProjectId);
  let effectiveTripSvc: Map<string, string> | null = null;
  if (useEffectiveValidity) {
    const isoFrom = ymdToIso(minStart);
    let isoTo = ymdToIso(maxEnd);
    // cap difensivo ~2 anni (come il compute UDP) per non esplodere le righe
    const capTo = plusDaysIso(isoFrom, 731);
    if (isoTo > capTo) isoTo = capTo;
    const activeByTrip = await computeActiveDatesByTrip({
      projectId: psProjectId,
      from: isoFrom,
      to: isoTo,
      tripIds: scoped ? opts!.tripIds! : null,
    });
    // Raggruppamento per FIRMA di circolazione: corse con lo stesso insieme di
    // date condividono un service_id → poche righe invece di una per corsa.
    const sigToDates = new Map<string, string[]>();
    effectiveTripSvc = new Map<string, string>();
    for (const [tripId, dts] of activeByTrip) {
      const sig = createHash("sha1").update(dts.join(",")).digest("hex").slice(0, 16);
      if (!sigToDates.has(sig)) sigToDates.set(sig, dts);
      effectiveTripSvc.set(tripId, sig);
    }
    // gtfs_calendar_dates puri (exception_type=1 per data). gtfs_calendar VUOTA.
    const svcCol: string[] = [];
    const dateCol: string[] = [];
    for (const [sig, dts] of sigToDates) for (const d of dts) { svcCol.push(sig); dateCol.push(d); }
    const BATCH = 10000;
    for (let i = 0; i < svcCol.length; i += BATCH) {
      const s = svcCol.slice(i, i + BATCH);
      const dd = dateCol.slice(i, i + BATCH);
      await db.execute(sql`
        INSERT INTO gtfs_calendar_dates (feed_id, service_id, date, exception_type)
        SELECT ${feedId}::uuid, x.s, x.d, 1
          FROM unnest(${`{${s.join(",")}}`}::text[], ${`{${dd.join(",")}}`}::text[]) AS x(s, d)
      `);
    }
  }

  // 4a. gtfs_stops
  await db.execute(sql`
    INSERT INTO gtfs_stops
           (feed_id, stop_id, stop_code, stop_name, stop_desc,
            stop_lat, stop_lon, wheelchair_boarding)
    SELECT ${feedId}::uuid, id::text, code, name, description,
           lat, lon, COALESCE(wheelchair_boarding, 0)
      FROM ps_stops
     WHERE project_id = ${psProjectId}::uuid
  `);

  // 4b. gtfs_routes (con trips_count aggregato)
  await db.execute(sql`
    INSERT INTO gtfs_routes
           (feed_id, route_id, agency_id, route_short_name, route_long_name,
            route_type, route_color, route_text_color, trips_count)
    SELECT ${feedId}::uuid, r.id::text, r.agency_id,
           COALESCE(NULLIF(r.short_name, ''), r.code, ''),
           r.long_name,
           COALESCE(r.route_type, 3), r.color, r.text_color,
           COALESCE((SELECT count(*) FROM ps_trips t
                      WHERE t.route_id = r.id
                        AND COALESCE(t.is_active, true) = true ${fT}), 0)
      FROM ps_routes r
     WHERE r.project_id = ${psProjectId}::uuid ${fRoute}
  `);

  // 4c/4d. Calendario LEGACY (ps_calendars settimanale + eccezioni).
  // Solo quando NON usiamo la validità effettiva (vincolo no-mix: la
  // gtfs_calendar resta vuota nel ramo calendar_dates-only).
  if (!useEffectiveValidity) {
    // 4c. gtfs_calendar
    await db.execute(sql`
      INSERT INTO gtfs_calendar
             (feed_id, service_id, monday, tuesday, wednesday, thursday,
              friday, saturday, sunday, start_date, end_date)
      SELECT ${feedId}::uuid, id::text,
             CASE WHEN monday    THEN 1 ELSE 0 END,
             CASE WHEN tuesday   THEN 1 ELSE 0 END,
             CASE WHEN wednesday THEN 1 ELSE 0 END,
             CASE WHEN thursday  THEN 1 ELSE 0 END,
             CASE WHEN friday    THEN 1 ELSE 0 END,
             CASE WHEN saturday  THEN 1 ELSE 0 END,
             CASE WHEN sunday    THEN 1 ELSE 0 END,
             COALESCE(to_char(start_date, 'YYYYMMDD'), ${minStart}),
             COALESCE(to_char(end_date,   'YYYYMMDD'), ${maxEnd})
        FROM ps_calendars
       WHERE project_id = ${psProjectId}::uuid ${fCalProj}
    `);

    // 4d. gtfs_calendar_dates
    await db.execute(sql`
      INSERT INTO gtfs_calendar_dates
             (feed_id, service_id, date, exception_type)
      SELECT ${feedId}::uuid, cd.calendar_id::text,
             to_char(cd.date, 'YYYYMMDD'),
             COALESCE(cd.exception_type, 1)
        FROM ps_calendar_dates cd
        JOIN ps_calendars c ON c.id = cd.calendar_id
       WHERE c.project_id = ${psProjectId}::uuid ${fCalC}
    `);
  }

  // 4e. gtfs_trips — service_id.
  // Ramo LEGACY: fallback service_id 7/7 per i trip senza calendar_id.
  // Ramo VALIDITÀ EFFETTIVA: nessun fallback settimanale (gtfs_calendar resta
  // vuota); il service_id è la firma di circolazione già emessa in calendar_dates.
  const fallbackServiceId = `fallback-${feedId.slice(0, 8)}`;
  if (!useEffectiveValidity) {
    // Crea il fallback calendar SOLO se ci sono trip senza calendario
    const needFallbackR: any = await db.execute(sql`
      SELECT EXISTS (
        SELECT 1 FROM ps_trips
         WHERE project_id = ${psProjectId}::uuid
           AND COALESCE(is_active, true) = true
           AND COALESCE((attributes->>'prototype')::boolean, false) = false
           AND calendar_id IS NULL ${fBare}
      ) AS need
    `);
    const needFallback = !!(needFallbackR.rows?.[0]?.need ?? needFallbackR[0]?.need);
    if (needFallback) {
      await db.execute(sql`
        INSERT INTO gtfs_calendar (feed_id, service_id, monday, tuesday, wednesday,
                                   thursday, friday, saturday, sunday, start_date, end_date)
        VALUES (${feedId}::uuid, ${fallbackServiceId}, 1, 1, 1, 1, 1, 1, 1, ${minStart}, ${maxEnd})
        ON CONFLICT (feed_id, service_id) DO NOTHING
      `);
    }
  }

  // colonna "a chiamata" (idempotente: feed storici senza colonna)
  await db.execute(sql`
    ALTER TABLE gtfs_trips ADD COLUMN IF NOT EXISTS on_demand boolean DEFAULT false
  `);
  // codice percorso (relazione corsa→percorso→linea): visibile su Corse, TM e TG
  await db.execute(sql`
    ALTER TABLE gtfs_trips ADD COLUMN IF NOT EXISTS variant_code text
  `);
  if (useEffectiveValidity) {
    // service_id dalla firma di circolazione (JOIN unnest). L'INNER JOIN esclude
    // automaticamente le corse MAI attive nel range (non presenti nella mappa) —
    // coerente con la semantica "assenza di validità = non circola".
    const tripArr = effectiveTripSvc ? Array.from(effectiveTripSvc.keys()) : [];
    const sigArr = effectiveTripSvc ? tripArr.map((id) => effectiveTripSvc!.get(id)!) : [];
    if (tripArr.length > 0) {
      await db.execute(sql`
        INSERT INTO gtfs_trips
               (feed_id, trip_id, route_id, service_id,
                trip_headsign, direction_id, shape_id, on_demand, variant_code)
        SELECT ${feedId}::uuid, t.id::text, t.route_id::text, m.service_id,
               t.headsign, COALESCE(t.direction, 0), t.variant_id::text,
               COALESCE((t.attributes->>'onDemand')::boolean, false),
               (SELECT COALESCE(NULLIF(v.code, ''), NULLIF(v.name, ''))
                  FROM ps_route_variants v WHERE v.id = t.variant_id)
          FROM ps_trips t
          JOIN unnest(${`{${tripArr.join(",")}}`}::text[], ${`{${sigArr.join(",")}}`}::text[])
               AS m(trip_id, service_id) ON m.trip_id = t.id::text
         WHERE t.project_id = ${psProjectId}::uuid
           AND COALESCE(t.is_active, true) = true
           AND COALESCE((t.attributes->>'prototype')::boolean, false) = false ${fT}
      `);
    }
  } else {
    await db.execute(sql`
      INSERT INTO gtfs_trips
             (feed_id, trip_id, route_id, service_id,
              trip_headsign, direction_id, shape_id, on_demand, variant_code)
      SELECT ${feedId}::uuid, t.id::text, t.route_id::text,
             COALESCE(t.calendar_id::text, ${fallbackServiceId}),
             t.headsign, COALESCE(t.direction, 0), t.variant_id::text,
             COALESCE((t.attributes->>'onDemand')::boolean, false),
             (SELECT COALESCE(NULLIF(v.code, ''), NULLIF(v.name, ''))
                FROM ps_route_variants v WHERE v.id = t.variant_id)
        FROM ps_trips t
       WHERE t.project_id = ${psProjectId}::uuid
         AND COALESCE(t.is_active, true) = true
         AND COALESCE((t.attributes->>'prototype')::boolean, false) = false ${fT}
    `);
  }

  // 4f. gtfs_stop_times — la query più pesante (300k+ righe per Conerobus).
  // Con INSERT ... SELECT resta tutto nel motore Postgres.
  // Nel ramo validità effettiva, escludi le corse NON emesse in gtfs_trips
  // (mai attive nel range) per non lasciare stop_times orfani.
  const fEffStopTimes = (useEffectiveValidity && effectiveTripSvc)
    ? sql`AND t.id = ANY(${`{${Array.from(effectiveTripSvc.keys()).join(",")}}`}::uuid[])`
    : sql``;
  await db.execute(sql`
    INSERT INTO gtfs_stop_times
           (feed_id, trip_id, stop_id, stop_sequence,
            departure_time, arrival_time, pickup_type, drop_off_type)
    SELECT ${feedId}::uuid, st.trip_id::text, st.stop_id::text, st.stop_seq,
           st.departure_time, st.arrival_time,
           COALESCE(st.pickup_type, 0), COALESCE(st.drop_off_type, 0)
      FROM ps_stop_times st
      JOIN ps_trips t ON t.id = st.trip_id
     WHERE t.project_id = ${psProjectId}::uuid
       AND COALESCE(t.is_active, true) = true
       AND COALESCE((t.attributes->>'prototype')::boolean, false) = false ${fT} ${fEffStopTimes}
  `);

  // 4g. gtfs_shapes (geometry jsonb → geojson jsonb diretto, niente JSON.stringify)
  await db.execute(sql`
    INSERT INTO gtfs_shapes
           (feed_id, shape_id, route_id, route_short_name, route_color, geojson)
    SELECT ${feedId}::uuid, s.variant_id::text, r.id::text,
           COALESCE(NULLIF(r.short_name, ''), r.code),
           r.color, s.geometry
      FROM ps_shapes s
      LEFT JOIN ps_route_variants v ON v.id = s.variant_id
      LEFT JOIN ps_routes r ON r.id = v.route_id
     WHERE s.project_id = ${psProjectId}::uuid ${fShape}
  `);

  /* ── 5. Propaga ps_stop_clusters → stop_clusters legacy ──────
   *
   * Single source of truth: i cluster vivono in Planner Studio
   * (ps_stop_clusters). Lo Scheduling Engine legge ancora dalle
   * tabelle legacy stop_clusters / stop_cluster_stops (Fucina,
   * /api/clusters/by-routes), quindi a ogni materializzazione
   * facciamo un mirror idempotente.
   *
   * Tracciamento via colonna additiva `source_ps_project_id`:
   * a ogni run cancelliamo TUTTI i cluster legacy provenienti
   * da questo PS project (anche quelli con UUID vecchi, ormai
   * spariti da ps_stop_clusters → orfani = doppioni). Poi
   * reinseriamo lo stato corrente. CASCADE su stop_cluster_stops
   * pulisce automaticamente le righe figlie.
   */
  await db.execute(sql`
    ALTER TABLE stop_clusters
      ADD COLUMN IF NOT EXISTS source_ps_project_id uuid
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_stop_clusters_source_ps_project
      ON stop_clusters(source_ps_project_id)
  `);

  // 5a. Wipe completo dei cluster legacy provenienti da QUESTO progetto
  // (CASCADE pulisce stop_cluster_stops grazie al FK con onDelete: cascade).
  await db.execute(sql`
    DELETE FROM stop_clusters WHERE source_ps_project_id = ${psProjectId}::uuid
  `);

  // 5b. Reinserisci con stesso UUID di ps_stop_clusters (così la dedupe
  // by name nel /by-routes risolve in modo deterministico) e marker
  // di provenienza per cleanup futuri.
  await db.execute(sql`
    INSERT INTO stop_clusters (id, name, transfer_from_depot_min, color, source_ps_project_id)
    SELECT id,
           COALESCE(NULLIF(name, ''), 'Cluster'),
           COALESCE((attributes->>'transferFromDepotMin')::int,
                    (attributes->>'transfer_from_depot_min')::int, 10),
           COALESCE(attributes->>'color', '#3b82f6'),
           ${psProjectId}::uuid
      FROM ps_stop_clusters
     WHERE project_id = ${psProjectId}::uuid
       AND COALESCE(kind, 'interchange') = 'interchange'
  `);

  // 5c. Mappa fermate. gtfs_stop_id usa ps_stops.id::text per coerenza
  // con quanto fatto in 4a (INSERT INTO gtfs_stops … SELECT id::text).
  await db.execute(sql`
    INSERT INTO stop_cluster_stops (cluster_id, gtfs_stop_id, stop_name, stop_lat, stop_lon)
    SELECT s.cluster_id, s.id::text,
           COALESCE(NULLIF(s.name, ''), s.id::text),
           s.lat, s.lon
      FROM ps_stops s
      JOIN ps_stop_clusters c ON c.id = s.cluster_id
     WHERE s.project_id = ${psProjectId}::uuid
       AND s.cluster_id IS NOT NULL
       AND COALESCE(c.kind, 'interchange') = 'interchange'
  `);

  /* ── 6. Aggancia il nuovo feed d'ESERCIZIO (solo se non scoped/UDP) ──
   * Le UDP NON toccano ps_projects.materialized_feed_id: il loro feed vive
   * su scheduling_projects.feed_id, aggiornato dal chiamante (startSyncJob). */
  if (updateProjectPointer) {
    await db.execute(sql`
      UPDATE ps_projects
         SET materialized_feed_id = ${feedId}::uuid,
             materialized_at = now()
       WHERE id = ${psProjectId}::uuid
    `);
  }

  /* ── 6b. Sorte del feed VECCHIO, ora che il nuovo è completo e agganciato.
   * - Percorso d'ESERCIZIO (updateProjectPointer): il feed rimpiazzato è lo
   *   SNAPSHOT che era in produzione → si ARCHIVIA (archived_at), non si
   *   cancella: "cosa era in esercizio il giorno X" resta interrogabile e il
   *   rollback resta possibile. Gli archiviati sono esclusi da risoluzione
   *   feed attivo e liste (gtfs-helpers / gtfs-upload).
   * - Percorso UDP (scoped, replaceFeedId esplicito): il feed è un artefatto
   *   di lavoro rigenerabile → si CANCELLA come prima (CASCADE su gtfs_*),
   *   per non accumulare copie a ogni resync. */
  if (replaceFeedId && replaceFeedId !== feedId) {
    if (updateProjectPointer) {
      await db.execute(sql`
        UPDATE gtfs_feeds
           SET is_active = false, is_default = false, archived_at = now()
         WHERE id = ${replaceFeedId}::uuid
      `);
    } else {
      await db.execute(sql`DELETE FROM gtfs_feeds WHERE id = ${replaceFeedId}::uuid`);
    }
  }

  /* ── 7. Counts finali per la response (singola query aggregata) ── */
  const countsR: any = await db.execute(sql`
    SELECT
      (SELECT count(*) FROM gtfs_stops          WHERE feed_id = ${feedId}::uuid) AS stops,
      (SELECT count(*) FROM gtfs_routes         WHERE feed_id = ${feedId}::uuid) AS routes,
      (SELECT count(*) FROM gtfs_trips          WHERE feed_id = ${feedId}::uuid) AS trips,
      (SELECT count(*) FROM gtfs_stop_times     WHERE feed_id = ${feedId}::uuid) AS stop_times,
      (SELECT count(*) FROM gtfs_calendar       WHERE feed_id = ${feedId}::uuid) AS calendars,
      (SELECT count(*) FROM gtfs_calendar_dates WHERE feed_id = ${feedId}::uuid) AS calendar_dates,
      (SELECT count(*) FROM gtfs_shapes         WHERE feed_id = ${feedId}::uuid) AS shapes
  `);
  const c: any = countsR.rows?.[0] ?? countsR[0];

  return {
    feedId,
    label,
    feedStartDate: minStart,
    feedEndDate: maxEnd,
    counts: {
      stops: Number(c.stops),
      routes: Number(c.routes),
      trips: Number(c.trips),
      stopTimes: Number(c.stop_times),
      calendars: Number(c.calendars),
      calendarDates: Number(c.calendar_dates),
      shapes: Number(c.shapes),
    },
  };
}

/* ════════════════════════════════════════════════════════════
 *  Mirror live PS → stop_clusters legacy
 *  ────────────────────────────────────────────────────────────
 *  Sincronizza i cluster PS verso le tabelle legacy stop_clusters /
 *  stop_cluster_stops (lette da /api/clusters/by-routes nello
 *  Scheduling Engine). Stessa logica del blocco "5." del materialize,
 *  ma invocabile a ogni CRUD cluster nel PS così l'utente vede subito
 *  i cluster nello Scheduling Engine senza dover ri-materializzare il
 *  feed. Idempotente: wipe-by-source + reinsert.
 *  Filtro: solo cluster di tipo "cambio" (kind='interchange').
 * ════════════════════════════════════════════════════════════ */
export async function mirrorPsClustersToLegacy(psProjectId: string): Promise<void> {
  await db.execute(sql`
    ALTER TABLE stop_clusters
      ADD COLUMN IF NOT EXISTS source_ps_project_id uuid
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_stop_clusters_source_ps_project
      ON stop_clusters(source_ps_project_id)
  `);
  await db.execute(sql`
    DELETE FROM stop_clusters WHERE source_ps_project_id = ${psProjectId}::uuid
  `);
  await db.execute(sql`
    INSERT INTO stop_clusters (id, name, transfer_from_depot_min, color, source_ps_project_id)
    SELECT id,
           COALESCE(NULLIF(name, ''), 'Cluster'),
           COALESCE((attributes->>'transferFromDepotMin')::int,
                    (attributes->>'transfer_from_depot_min')::int, 10),
           COALESCE(attributes->>'color', '#3b82f6'),
           ${psProjectId}::uuid
      FROM ps_stop_clusters
     WHERE project_id = ${psProjectId}::uuid
       AND COALESCE(kind, 'interchange') = 'interchange'
  `);
  await db.execute(sql`
    INSERT INTO stop_cluster_stops (cluster_id, gtfs_stop_id, stop_name, stop_lat, stop_lon)
    SELECT s.cluster_id, s.id::text,
           COALESCE(NULLIF(s.name, ''), s.id::text),
           s.lat, s.lon
      FROM ps_stops s
      JOIN ps_stop_clusters c ON c.id = s.cluster_id
     WHERE s.project_id = ${psProjectId}::uuid
       AND s.cluster_id IS NOT NULL
       AND COALESCE(c.kind, 'interchange') = 'interchange'
  `);
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
      // Se il progetto-scheduling è agganciato a una UDP, materializza SOLO le
      // sue corse (feed = pacchetto della UDP, niente corse di altre UDP).
      let tripIds: string[] | null = null;
      try {
        const vuR: any = await db.execute(sql`SELECT validity_unit_id FROM scheduling_projects WHERE id = ${projectId}::uuid LIMIT 1`);
        const vuId = vuR.rows?.[0]?.validity_unit_id;
        if (vuId) {
          const tR: any = await db.execute(sql`SELECT trip_ids FROM ps_validity_units WHERE id = ${vuId}::uuid LIMIT 1`);
          const arr = tR.rows?.[0]?.trip_ids;
          if (Array.isArray(arr) && arr.length > 0) {
            // Interseca con le corse ESISTENTI: trip_ids stantii (corse
            // rigenerate in PS) produrrebbero un feed scopato VUOTO.
            const raw = arr.map((x: any) => String(x));
            const exR: any = await db.execute(sql`
              SELECT id::text AS id FROM ps_trips WHERE id = ANY(${`{${raw.join(",")}}`}::uuid[])`);
            const existing = ((exR.rows ?? []) as any[]).map((r) => String(r.id));
            if (existing.length < raw.length) {
              logger?.warn?.({ projectId, vuId, requested: raw.length, existing: existing.length },
                "UDP trip_ids parzialmente stantii: scoping sulle corse ancora esistenti");
            }
            tripIds = existing.length > 0 ? existing : null;
          }
        }
      } catch (scopeErr: any) {
        logger?.warn?.({ err: scopeErr, projectId }, "UDP scope lookup failed, materializzo tutto il progetto");
      }
      // Feed VECCHIO di QUESTA UDP (non lo slot globale del progetto): lo
      // rimpiazziamo col nuovo in modalità delete-last, senza toccare né il
      // feed d'esercizio né quello delle UDP sorelle.
      let oldFeedId: string | null = null;
      try {
        const ofR: any = await db.execute(sql`SELECT feed_id FROM scheduling_projects WHERE id = ${projectId}::uuid LIMIT 1`);
        oldFeedId = ofR.rows?.[0]?.feed_id ?? null;
      } catch { /* colonna assente su DB legacy → nessun vecchio feed da rimuovere */ }
      const result = await materializePsToFeed(psProjectId, ownerUserId, {
        tripIds,
        replaceFeedId: oldFeedId,
        updateProjectPointer: false,
      });
      await db.execute(sql`
        UPDATE scheduling_projects
           SET feed_id = ${result.feedId}::uuid,
               feed_label = ${result.label},
               updated_at = now()
         WHERE id = ${projectId}::uuid
      `);
      // Il feed è cambiato sotto gli scenari salvati: il loro result riflette
      // il feed precedente → marcali "dati superati" (stale_since). Un nuovo
      // salvataggio dello scenario azzera il flag. Best-effort su DB legacy.
      try {
        await db.execute(sql`
          UPDATE service_program_scenarios
             SET stale_since = COALESCE(stale_since, now())
           WHERE project_id = ${projectId}::uuid
        `);
        await db.execute(sql`
          UPDATE driver_shift_scenarios d
             SET stale_since = COALESCE(d.stale_since, now())
            FROM service_program_scenarios s
           WHERE d.service_program_scenario_id = s.id
             AND (s.project_id = ${projectId}::uuid OR d.project_id = ${projectId}::uuid)
        `);
      } catch (staleErr: any) {
        logger?.warn?.({ err: staleErr?.message, projectId }, "marcatura stale_since scenari fallita (sync comunque ok)");
      }
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
