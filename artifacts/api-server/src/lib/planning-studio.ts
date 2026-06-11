/**
 * PlannerStudio — DB master del servizio (L1-L5).
 *
 * A differenza di /planning (simulazione di scenari sopra un feed GTFS read-only),
 * PlannerStudio è il database canonico del servizio: fermate, percorsi (shapes),
 * linee + varianti, orari, calendari di validità.
 *
 * Architettura:
 *   - tabelle ps_*  (planning studio) tutte create idempotentemente con
 *     CREATE TABLE IF NOT EXISTS, sul modello di lib/auth.ts e
 *     lib/scheduling-projects.ts.
 *   - condivisione progetti: stesso pattern di scheduling_projects
 *     (owner + ps_project_members + ps_project_activity_log).
 *   - snap routing stile Google Maps via OSRM pubblico, con cache server-side
 *     (tabella ps_route_snap_cache) per evitare di sbattere sul rate limit.
 *   - tutto il routing è montato sotto /api/planning-studio/*.
 *
 * Tutte le rotte sono protette da requireAuth (montato globalmente in routes/index.ts).
 */
import type { Request, Response } from "express";
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

/* ════════════════════════════════════════════════════════════
 *  Bootstrap tabelle
 * ════════════════════════════════════════════════════════════ */
let bootstrapped = false;
async function ensurePsTables(): Promise<void> {
  if (bootstrapped) return;
  try {
    /* ─── Progetti ─── */
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS ps_projects (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_user_id uuid NOT NULL,
        name text NOT NULL,
        description text,
        is_shared boolean NOT NULL DEFAULT false,
        source_feed_id uuid,
        source_feed_label text,
        agency_name text,
        agency_url text,
        agency_timezone text NOT NULL DEFAULT 'Europe/Rome',
        default_lang text NOT NULL DEFAULT 'it',
        scheduling_project_id uuid,
        status text NOT NULL DEFAULT 'draft',
        last_opened_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_ps_proj_owner ON ps_projects(owner_user_id)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_ps_proj_updated ON ps_projects(updated_at DESC)`);

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS ps_project_members (
        project_id uuid NOT NULL REFERENCES ps_projects(id) ON DELETE CASCADE,
        user_id uuid NOT NULL,
        role text NOT NULL DEFAULT 'editor',
        added_by uuid,
        added_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (project_id, user_id)
      )
    `);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_ps_pm_user ON ps_project_members(user_id)`);

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS ps_project_activity_log (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id uuid NOT NULL REFERENCES ps_projects(id) ON DELETE CASCADE,
        user_id uuid NOT NULL,
        action text NOT NULL,
        target_type text,
        target_id text,
        payload jsonb NOT NULL DEFAULT '{}'::jsonb,
        at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_ps_pal_project ON ps_project_activity_log(project_id, at DESC)`);

    /* ─── L1 — Fermate ─── */
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS ps_stops (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id uuid NOT NULL REFERENCES ps_projects(id) ON DELETE CASCADE,
        code text,
        name text NOT NULL,
        description text,
        lat double precision NOT NULL,
        lon double precision NOT NULL,
        zone_id text,
        location_type smallint NOT NULL DEFAULT 0,
        parent_station uuid,
        wheelchair_boarding smallint NOT NULL DEFAULT 0,
        platform_code text,
        attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_ps_stops_project ON ps_stops(project_id)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_ps_stops_geo ON ps_stops(project_id, lat, lon)`);

    /* ─── L3 — Linee + Varianti ─── */
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS ps_routes (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id uuid NOT NULL REFERENCES ps_projects(id) ON DELETE CASCADE,
        code text,
        short_name text NOT NULL,
        long_name text,
        description text,
        route_type smallint NOT NULL DEFAULT 3,
        color text,
        text_color text,
        agency_id text,
        sort_order int NOT NULL DEFAULT 0,
        attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_ps_routes_project ON ps_routes(project_id)`);

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS ps_route_variants (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id uuid NOT NULL REFERENCES ps_projects(id) ON DELETE CASCADE,
        route_id uuid NOT NULL REFERENCES ps_routes(id) ON DELETE CASCADE,
        name text NOT NULL,
        direction smallint NOT NULL DEFAULT 0,
        headsign text,
        is_default boolean NOT NULL DEFAULT false,
        attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_ps_variants_route ON ps_route_variants(route_id)`);

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS ps_variant_stops (
        variant_id uuid NOT NULL REFERENCES ps_route_variants(id) ON DELETE CASCADE,
        seq int NOT NULL,
        stop_id uuid NOT NULL REFERENCES ps_stops(id) ON DELETE RESTRICT,
        pickup_type smallint NOT NULL DEFAULT 0,
        drop_off_type smallint NOT NULL DEFAULT 0,
        timepoint smallint NOT NULL DEFAULT 1,
        shape_dist_traveled double precision,
        PRIMARY KEY (variant_id, seq)
      )
    `);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_ps_vs_stop ON ps_variant_stops(stop_id)`);

    /* ─── L2 — Shapes (geometria del percorso) ─── */
    // Una shape è legata 1:1 a una variante. Geometry = GeoJSON LineString.
    // waypoints = lista di "ancore" cliccate dall'utente
    //   [{ lng, lat, stopId?, mode: 'snap'|'manual', segmentBefore?: {distance, duration} }, ...]
    // così un futuro re-render dell'editor può ricostruire i segmenti senza
    // ricalcolarli (e li ricalcola solo se l'utente sposta una ancora).
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS ps_shapes (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id uuid NOT NULL REFERENCES ps_projects(id) ON DELETE CASCADE,
        variant_id uuid UNIQUE NOT NULL REFERENCES ps_route_variants(id) ON DELETE CASCADE,
        mode text NOT NULL DEFAULT 'driving',
        geometry jsonb NOT NULL,
        waypoints jsonb NOT NULL DEFAULT '[]'::jsonb,
        distance_m double precision,
        duration_s double precision,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    /* ─── L5 — Calendari di validità ─── */
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS ps_calendars (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id uuid NOT NULL REFERENCES ps_projects(id) ON DELETE CASCADE,
        code text NOT NULL,
        name text,
        monday boolean NOT NULL DEFAULT false,
        tuesday boolean NOT NULL DEFAULT false,
        wednesday boolean NOT NULL DEFAULT false,
        thursday boolean NOT NULL DEFAULT false,
        friday boolean NOT NULL DEFAULT false,
        saturday boolean NOT NULL DEFAULT false,
        sunday boolean NOT NULL DEFAULT false,
        start_date date NOT NULL,
        end_date date NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_ps_cal_project ON ps_calendars(project_id)`);

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS ps_calendar_dates (
        calendar_id uuid NOT NULL REFERENCES ps_calendars(id) ON DELETE CASCADE,
        date date NOT NULL,
        exception_type smallint NOT NULL DEFAULT 1,
        PRIMARY KEY (calendar_id, date)
      )
    `);

    /* ─── L4 — Corse + orari ─── */
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS ps_trips (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id uuid NOT NULL REFERENCES ps_projects(id) ON DELETE CASCADE,
        route_id uuid NOT NULL REFERENCES ps_routes(id) ON DELETE CASCADE,
        variant_id uuid NOT NULL REFERENCES ps_route_variants(id) ON DELETE RESTRICT,
        calendar_id uuid REFERENCES ps_calendars(id) ON DELETE SET NULL,
        headsign text,
        short_name text,
        direction smallint NOT NULL DEFAULT 0,
        block_id text,
        attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_ps_trips_project ON ps_trips(project_id)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_ps_trips_variant ON ps_trips(variant_id)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_ps_trips_cal ON ps_trips(calendar_id)`);

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS ps_stop_times (
        trip_id uuid NOT NULL REFERENCES ps_trips(id) ON DELETE CASCADE,
        stop_seq int NOT NULL,
        stop_id uuid NOT NULL REFERENCES ps_stops(id) ON DELETE RESTRICT,
        arrival_time text NOT NULL,
        departure_time text NOT NULL,
        pickup_type smallint NOT NULL DEFAULT 0,
        drop_off_type smallint NOT NULL DEFAULT 0,
        timepoint smallint NOT NULL DEFAULT 1,
        shape_dist_traveled double precision,
        PRIMARY KEY (trip_id, stop_seq)
      )
    `);

    /* ─── Cache routing OSRM ─── */
    // Chiave logica: mode + coordinate from/to arrotondate a 6 decimali (~10 cm).
    // Ci basta per non rifare la stessa chiamata HTTP centinaia di volte mentre
    // l'utente trascina i waypoint.
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS ps_route_snap_cache (
        id bigserial PRIMARY KEY,
        mode text NOT NULL,
        from_lon double precision NOT NULL,
        from_lat double precision NOT NULL,
        to_lon double precision NOT NULL,
        to_lat double precision NOT NULL,
        geometry jsonb NOT NULL,
        distance_m double precision NOT NULL,
        duration_s double precision NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await db.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_ps_snap_key
        ON ps_route_snap_cache (mode, from_lon, from_lat, to_lon, to_lat)
    `);

    /* ════════════════════════════════════════════════════════════
     *  ESTENSIONI EPIC PlannerStudio Core
     *  (additive, idempotenti — vedi prompt §2)
     * ════════════════════════════════════════════════════════════ */

    /* §2.1 — Fermate: campi estesi */
    await db.execute(sql`
      ALTER TABLE ps_stops
        ADD COLUMN IF NOT EXISTS municipality text,
        ADD COLUMN IF NOT EXISTS province text,
        ADD COLUMN IF NOT EXISTS region text,
        ADD COLUMN IF NOT EXISTS shelter boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS bench boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS lighting boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS realtime_display boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS ticket_vending boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS bike_parking boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS surface_type text,
        ADD COLUMN IF NOT EXISTS pole_type text,
        ADD COLUMN IF NOT EXISTS signage_state text,
        ADD COLUMN IF NOT EXISTS photo_urls jsonb NOT NULL DEFAULT '[]'::jsonb,
        ADD COLUMN IF NOT EXISTS notes text,
        ADD COLUMN IF NOT EXISTS cluster_id uuid
    `);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_ps_stops_cluster ON ps_stops(cluster_id)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_ps_stops_municipality ON ps_stops(project_id, municipality)`);

    /* §2.2 — Cluster fermate (nodi di interscambio) */
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS ps_stop_clusters (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id uuid NOT NULL REFERENCES ps_projects(id) ON DELETE CASCADE,
        code text,
        name text NOT NULL,
        kind text NOT NULL DEFAULT 'interchange',
        center_lat double precision,
        center_lon double precision,
        radius_m int NOT NULL DEFAULT 150,
        attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_ps_clusters_project ON ps_stop_clusters(project_id)`);

    /* §2.3 — Linee: campi estesi */
    await db.execute(sql`
      ALTER TABLE ps_routes
        ADD COLUMN IF NOT EXISTS service_type text NOT NULL DEFAULT 'urban',
        ADD COLUMN IF NOT EXISTS contract_id text,
        ADD COLUMN IF NOT EXISTS km_year_planned numeric,
        ADD COLUMN IF NOT EXISTS notes text,
        ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true
    `);

    /* §2.4 — Varianti: campi estesi */
    await db.execute(sql`
      ALTER TABLE ps_route_variants
        ADD COLUMN IF NOT EXISTS variant_kind text NOT NULL DEFAULT 'standard',
        ADD COLUMN IF NOT EXISTS valid_from date,
        ADD COLUMN IF NOT EXISTS valid_to date,
        ADD COLUMN IF NOT EXISTS distance_m_cached double precision,
        ADD COLUMN IF NOT EXISTS duration_s_cached double precision,
        ADD COLUMN IF NOT EXISTS notes text
    `);

    /* §2.5 — Validità per singola corsa */
    await db.execute(sql`
      ALTER TABLE ps_trips
        ADD COLUMN IF NOT EXISTS valid_from date,
        ADD COLUMN IF NOT EXISTS valid_to date,
        ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true,
        ADD COLUMN IF NOT EXISTS service_label text
    `);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_ps_trips_validity ON ps_trips(project_id, valid_from, valid_to)`);

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS ps_trip_exceptions (
        trip_id uuid NOT NULL REFERENCES ps_trips(id) ON DELETE CASCADE,
        date date NOT NULL,
        exception_type smallint NOT NULL DEFAULT 2,
        reason text,
        PRIMARY KEY (trip_id, date)
      )
    `);

    /* §2.6 — Service Periods (Estate/Inverno/Scolastico…) */
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS ps_service_periods (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id uuid NOT NULL REFERENCES ps_projects(id) ON DELETE CASCADE,
        code text NOT NULL,
        name text NOT NULL,
        start_date date NOT NULL,
        end_date date NOT NULL,
        is_default boolean NOT NULL DEFAULT false,
        color text,
        notes text,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_ps_sp_project ON ps_service_periods(project_id)`);

    /* Programma di esercizio: feed materializzato + flag operativo sui feed.
       (le stesse ALTER vivono anche in planning-studio-materialize.ts e
       gtfs-upload: qui garantiamo che la lista progetti non dipenda
       dall'ordine di bootstrap dei moduli) */
    await db.execute(sql`
      ALTER TABLE ps_projects
      ADD COLUMN IF NOT EXISTS materialized_feed_id uuid,
      ADD COLUMN IF NOT EXISTS materialized_at timestamptz
    `);
    await db.execute(sql`
      ALTER TABLE gtfs_feeds
      ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS is_default boolean NOT NULL DEFAULT false
    `);

    bootstrapped = true;
    console.log("[planning-studio] tables ready (epic schema v2)");
  } catch (e: any) {
    console.error("[planning-studio] bootstrap error:", e?.message || e);
  }
}
void ensurePsTables();

/* ════════════════════════════════════════════════════════════
 *  Helpers
 * ════════════════════════════════════════════════════════════ */
const UUID_RE = /^[0-9a-f-]{36}$/i;
const HHMMSS_RE = /^\d{1,2}:[0-5]\d:[0-5]\d$/;

function badId(res: Response, what = "ID") {
  res.status(400).json({ error: `${what} non valido` });
}

function rowToProject(r: any) {
  return {
    id: r.id,
    ownerUserId: r.owner_user_id,
    name: r.name,
    description: r.description,
    isShared: !!r.is_shared,
    sourceFeedId: r.source_feed_id,
    sourceFeedLabel: r.source_feed_label,
    agencyName: r.agency_name,
    agencyUrl: r.agency_url,
    agencyTimezone: r.agency_timezone,
    defaultLang: r.default_lang,
    schedulingProjectId: r.scheduling_project_id,
    status: r.status,
    lastOpenedAt: r.last_opened_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    ownerEmail: r.owner_email ?? undefined,
    ownerFullName: r.owner_full_name ?? undefined,
    memberCount: r.member_count != null ? Number(r.member_count) : undefined,
    myRole: r.my_role ?? (r.owner_user_id ? "owner" : undefined),
    counts: r.counts ?? undefined,
    materializedFeedId: r.materialized_feed_id ?? null,
    materializedAt: r.materialized_at ?? null,
    // "Programma di esercizio operativo": il feed materializzato è quello attivo
    isOperational: r.is_operational != null ? !!r.is_operational : undefined,
  };
}

function rowToStop(r: any) {
  return {
    id: r.id,
    projectId: r.project_id,
    code: r.code,
    name: r.name,
    description: r.description,
    lat: Number(r.lat),
    lon: Number(r.lon),
    zoneId: r.zone_id,
    locationType: r.location_type,
    parentStation: r.parent_station,
    wheelchairBoarding: r.wheelchair_boarding,
    platformCode: r.platform_code,
    attributes: r.attributes ?? {},
    clusterId: r.cluster_id ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToRoute(r: any) {
  return {
    id: r.id,
    projectId: r.project_id,
    code: r.code,
    shortName: r.short_name,
    longName: r.long_name,
    description: r.description,
    routeType: r.route_type,
    color: r.color,
    textColor: r.text_color,
    agencyId: r.agency_id,
    sortOrder: r.sort_order,
    attributes: r.attributes ?? {},
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    variantCount: r.variant_count != null ? Number(r.variant_count) : undefined,
  };
}

function rowToVariant(r: any) {
  return {
    id: r.id,
    projectId: r.project_id,
    routeId: r.route_id,
    name: r.name,
    direction: r.direction,
    headsign: r.headsign,
    isDefault: !!r.is_default,
    attributes: r.attributes ?? {},
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    stopCount: r.stop_count != null ? Number(r.stop_count) : undefined,
    hasShape: r.has_shape != null ? !!r.has_shape : undefined,
  };
}

function rowToShape(r: any) {
  return {
    id: r.id,
    projectId: r.project_id,
    variantId: r.variant_id,
    mode: r.mode,
    geometry: r.geometry,
    waypoints: r.waypoints ?? [],
    distanceM: r.distance_m != null ? Number(r.distance_m) : null,
    durationS: r.duration_s != null ? Number(r.duration_s) : null,
    updatedAt: r.updated_at,
  };
}

function rowToCalendar(r: any) {
  return {
    id: r.id,
    projectId: r.project_id,
    code: r.code,
    name: r.name,
    monday: r.monday, tuesday: r.tuesday, wednesday: r.wednesday,
    thursday: r.thursday, friday: r.friday,
    saturday: r.saturday, sunday: r.sunday,
    startDate: r.start_date,
    endDate: r.end_date,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToTrip(r: any) {
  return {
    id: r.id,
    projectId: r.project_id,
    routeId: r.route_id,
    variantId: r.variant_id,
    calendarId: r.calendar_id,
    headsign: r.headsign,
    shortName: r.short_name,
    direction: r.direction,
    blockId: r.block_id,
    attributes: r.attributes ?? {},
    validFrom: r.valid_from ?? null,
    validTo: r.valid_to ?? null,
    isActive: r.is_active === undefined ? true : !!r.is_active,
    serviceLabel: r.service_label ?? null,
    createdAt: r.created_at,
  };
}

/** Carica progetto se l'utente è owner o membro. Espone `my_role`. */
async function loadProjectAccessible(id: string, userId: string): Promise<any | null> {
  const r = await db.execute(sql`
    SELECT p.*,
           CASE WHEN p.owner_user_id = ${userId}::uuid THEN 'owner'
                ELSE pm.role END AS my_role
      FROM ps_projects p
      LEFT JOIN ps_project_members pm
             ON pm.project_id = p.id AND pm.user_id = ${userId}::uuid
     WHERE p.id = ${id}::uuid
       AND (p.owner_user_id = ${userId}::uuid OR pm.user_id IS NOT NULL)
     LIMIT 1
  `);
  return (r as any).rows?.[0] ?? (r as any)[0] ?? null;
}

function isOwner(row: any, userId: string): boolean {
  return row?.owner_user_id === userId;
}

function canWrite(row: any): boolean {
  return row?.my_role === "owner" || row?.my_role === "editor";
}

async function logActivity(
  projectId: string,
  userId: string,
  action: string,
  opts: { targetType?: string; targetId?: string; payload?: any } = {}
): Promise<void> {
  try {
    await db.execute(sql`
      INSERT INTO ps_project_activity_log (project_id, user_id, action, target_type, target_id, payload)
      VALUES (${projectId}::uuid, ${userId}::uuid, ${action},
              ${opts.targetType ?? null}, ${opts.targetId ?? null},
              ${JSON.stringify(opts.payload ?? {})}::jsonb)
    `);
  } catch (e: any) {
    console.warn("[ps activity-log] insert failed:", e?.message || e);
  }
}

/** Middleware-like: risolve :id e mette req._project + verifica accesso. */
async function requireProject(req: Request, res: Response): Promise<any | null> {
  const id = String(req.params.id || "");
  if (!UUID_RE.test(id)) { badId(res, "ID progetto"); return null; }
  const proj = await loadProjectAccessible(id, req.user!.id);
  if (!proj) { res.status(404).json({ error: "Progetto non trovato o non accessibile" }); return null; }
  return proj;
}

/* ════════════════════════════════════════════════════════════
 *  Router
 * ════════════════════════════════════════════════════════════ */
const router: IRouter = Router();

router.use(async (req, res, next) => {
  await ensurePsTables();
  if (!req.user) { res.status(401).json({ error: "Non autenticato" }); return; }
  next();
});

/* ────────────────────────────────────────────────────────────
 *  PROGETTI
 * ──────────────────────────────────────────────────────────── */

// GET /api/planning-studio/projects — lista progetti accessibili
router.get("/planning-studio/projects", async (req, res) => {
  const userId = req.user!.id;
  const r = await db.execute(sql`
    SELECT p.*,
           u.email AS owner_email,
           u.full_name AS owner_full_name,
           (SELECT count(*)::int FROM ps_project_members pm2 WHERE pm2.project_id = p.id) AS member_count,
           CASE WHEN p.owner_user_id = ${userId}::uuid THEN 'owner'
                ELSE pm.role END AS my_role,
           (p.materialized_feed_id IS NOT NULL AND COALESCE(f.is_active, false)) AS is_operational
      FROM ps_projects p
      LEFT JOIN users u ON u.id = p.owner_user_id
      LEFT JOIN gtfs_feeds f ON f.id = p.materialized_feed_id
      LEFT JOIN ps_project_members pm
             ON pm.project_id = p.id AND pm.user_id = ${userId}::uuid
     WHERE p.owner_user_id = ${userId}::uuid OR pm.user_id IS NOT NULL
     ORDER BY is_operational DESC, p.updated_at DESC
  `);
  const rows: any[] = (r as any).rows ?? (r as any) ?? [];
  res.json({ projects: rows.map(rowToProject) });
});

// POST /api/planning-studio/projects
router.post("/planning-studio/projects", async (req, res): Promise<void> => {
  const userId = req.user!.id;
  const { name, description, agencyName, agencyTimezone, schedulingProjectId } = req.body || {};
  if (typeof name !== "string" || name.trim().length === 0) {
    res.status(400).json({ error: "Nome obbligatorio" }); return;
  }
  const r = await db.execute(sql`
    INSERT INTO ps_projects (owner_user_id, name, description, agency_name, agency_timezone, scheduling_project_id)
    VALUES (${userId}::uuid, ${name.trim()}, ${description ?? null},
            ${agencyName ?? null}, ${agencyTimezone ?? "Europe/Rome"},
            ${schedulingProjectId ?? null})
    RETURNING *
  `);
  const row: any = (r as any).rows?.[0] ?? (r as any)[0];
  await logActivity(row.id, userId, "ps.project.create", { payload: { name } });
  res.json({ project: rowToProject({ ...row, my_role: "owner" }) });
});

/* POST /api/planning-studio/projects/:id/activate — "Metti in esercizio".
 *
 * Il flusso aziendale prevede più programmi di esercizio ma UNO SOLO operativo:
 * questo endpoint promuove il feed materializzato del progetto a feed attivo
 * (is_active + is_default esclusivi su gtfs_feeds). Da quel momento tutto il
 * resto del sistema — Sala Operativa, AVM Caronte, GTFS-RT, tariffe — risolve
 * automaticamente questo feed (getLatestFeedId / ORDER BY is_active DESC).
 */
router.post("/planning-studio/projects/:id/activate", async (req, res): Promise<void> => {
  const proj = await requireProject(req, res); if (!proj) return;
  if (!canWrite(proj)) { res.status(403).json({ error: "Permessi insufficienti (serve owner/editor)" }); return; }
  if (!proj.materialized_feed_id) {
    res.status(400).json({
      error: "Il programma non è ancora materializzato: esegui prima la sincronizzazione (PS → feed GTFS), poi mettilo in esercizio.",
    });
    return;
  }
  const feedCheck = await db.execute(sql`SELECT id FROM gtfs_feeds WHERE id = ${proj.materialized_feed_id}::uuid LIMIT 1`);
  if (!((feedCheck as any).rows?.[0] ?? (feedCheck as any)[0])) {
    res.status(409).json({ error: "Il feed materializzato non esiste più: rimaterializza il programma e riprova." });
    return;
  }

  await db.execute(sql`
    UPDATE gtfs_feeds
       SET is_active = (id = ${proj.materialized_feed_id}::uuid),
           is_default = (id = ${proj.materialized_feed_id}::uuid)
  `);
  await logActivity(proj.id, req.user!.id, "ps.project.activate", {
    targetType: "feed", targetId: proj.materialized_feed_id,
    payload: { name: proj.name },
  });
  res.json({ ok: true, feedId: proj.materialized_feed_id });
});

// GET /api/planning-studio/projects/:id — dettaglio + counts
router.get("/planning-studio/projects/:id", async (req, res): Promise<void> => {
  const proj = await requireProject(req, res); if (!proj) return;
  const c = await db.execute(sql`
    SELECT
      (SELECT count(*)::int FROM ps_stops WHERE project_id = ${proj.id}::uuid) AS stops,
      (SELECT count(*)::int FROM ps_routes WHERE project_id = ${proj.id}::uuid) AS routes,
      (SELECT count(*)::int FROM ps_route_variants WHERE project_id = ${proj.id}::uuid) AS variants,
      (SELECT count(*)::int FROM ps_trips WHERE project_id = ${proj.id}::uuid) AS trips,
      (SELECT count(*)::int FROM ps_calendars WHERE project_id = ${proj.id}::uuid) AS calendars
  `);
  const counts: any = (c as any).rows?.[0] ?? (c as any)[0] ?? {};
  // touch last_opened_at
  await db.execute(sql`UPDATE ps_projects SET last_opened_at = now() WHERE id = ${proj.id}::uuid`);
  res.json({ project: rowToProject({ ...proj, counts }) });
});

// PATCH /api/planning-studio/projects/:id
router.patch("/planning-studio/projects/:id", async (req, res): Promise<void> => {
  const proj = await requireProject(req, res); if (!proj) return;
  if (!canWrite(proj)) { res.status(403).json({ error: "Permessi insufficienti" }); return; }
  const userId = req.user!.id;
  const { name, description, agencyName, agencyUrl, agencyTimezone, defaultLang,
          status, isShared, schedulingProjectId } = req.body || {};
  const sets: any[] = [];
  if (name !== undefined) sets.push(sql`name = ${name}`);
  if (description !== undefined) sets.push(sql`description = ${description}`);
  if (agencyName !== undefined) sets.push(sql`agency_name = ${agencyName}`);
  if (agencyUrl !== undefined) sets.push(sql`agency_url = ${agencyUrl}`);
  if (agencyTimezone !== undefined) sets.push(sql`agency_timezone = ${agencyTimezone}`);
  if (defaultLang !== undefined) sets.push(sql`default_lang = ${defaultLang}`);
  if (status !== undefined) sets.push(sql`status = ${status}`);
  if (schedulingProjectId !== undefined) sets.push(sql`scheduling_project_id = ${schedulingProjectId}`);
  if (isShared !== undefined) {
    if (!isOwner(proj, userId)) { res.status(403).json({ error: "Solo l'owner può cambiare la condivisione" }); return; }
    sets.push(sql`is_shared = ${!!isShared}`);
  }
  if (sets.length === 0) { res.json({ ok: true, noop: true }); return; }
  sets.push(sql`updated_at = now()`);
  const assignments = sql.join(sets, sql`, `);
  const r = await db.execute(sql`
    UPDATE ps_projects SET ${assignments} WHERE id = ${proj.id}::uuid RETURNING *
  `);
  const row: any = (r as any).rows?.[0] ?? (r as any)[0];
  await logActivity(proj.id, userId, "ps.project.update",
    { payload: { fields: Object.keys(req.body || {}) } });
  res.json({ project: rowToProject({ ...row, my_role: proj.my_role }) });
});

// DELETE /api/planning-studio/projects/:id (solo owner)
router.delete("/planning-studio/projects/:id", async (req, res): Promise<void> => {
  const proj = await requireProject(req, res); if (!proj) return;
  if (!isOwner(proj, req.user!.id)) { res.status(403).json({ error: "Solo l'owner può eliminare" }); return; }
  await db.execute(sql`DELETE FROM ps_projects WHERE id = ${proj.id}::uuid`);
  res.json({ ok: true });
});

/* ────────────────────────────────────────────────────────────
 *  CONDIVISIONE — membri + activity log
 * ──────────────────────────────────────────────────────────── */

router.get("/planning-studio/projects/:id/members", async (req, res): Promise<void> => {
  const proj = await requireProject(req, res); if (!proj) return;
  const r = await db.execute(sql`
    SELECT pm.user_id, pm.role, pm.added_at, u.email, u.full_name
      FROM ps_project_members pm
      LEFT JOIN users u ON u.id = pm.user_id
     WHERE pm.project_id = ${proj.id}::uuid
     ORDER BY pm.added_at ASC
  `);
  const rows: any[] = (r as any).rows ?? (r as any) ?? [];
  // Includiamo l'owner come primo elemento "virtuale".
  const own = await db.execute(sql`
    SELECT id, email, full_name FROM users WHERE id = ${proj.owner_user_id}::uuid LIMIT 1
  `);
  const ownerRow: any = (own as any).rows?.[0] ?? (own as any)[0];
  const members = [
    {
      userId: proj.owner_user_id,
      role: "owner" as const,
      email: ownerRow?.email ?? null,
      fullName: ownerRow?.full_name ?? null,
      addedAt: proj.created_at,
    },
    ...rows.map(r => ({
      userId: r.user_id,
      role: r.role,
      email: r.email,
      fullName: r.full_name,
      addedAt: r.added_at,
    })),
  ];
  res.json({ members });
});

router.post("/planning-studio/projects/:id/members", async (req, res): Promise<void> => {
  const proj = await requireProject(req, res); if (!proj) return;
  if (!isOwner(proj, req.user!.id)) { res.status(403).json({ error: "Solo l'owner può aggiungere membri" }); return; }
  const { userId, role } = req.body || {};
  if (typeof userId !== "string" || !UUID_RE.test(userId)) { res.status(400).json({ error: "userId mancante" }); return; }
  if (userId === proj.owner_user_id) { res.status(400).json({ error: "L'owner è già membro" }); return; }
  const safeRole = role === "viewer" ? "viewer" : "editor";
  await db.execute(sql`
    INSERT INTO ps_project_members (project_id, user_id, role, added_by)
    VALUES (${proj.id}::uuid, ${userId}::uuid, ${safeRole}, ${req.user!.id}::uuid)
    ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role
  `);
  await db.execute(sql`UPDATE ps_projects SET is_shared = true WHERE id = ${proj.id}::uuid`);
  await logActivity(proj.id, req.user!.id, "ps.member.add", { targetId: userId, payload: { role: safeRole } });
  res.json({ ok: true });
});

router.delete("/planning-studio/projects/:id/members/:userId", async (req, res): Promise<void> => {
  const proj = await requireProject(req, res); if (!proj) return;
  if (!isOwner(proj, req.user!.id)) { res.status(403).json({ error: "Solo l'owner può rimuovere membri" }); return; }
  const uid = String(req.params.userId);
  if (!UUID_RE.test(uid)) { badId(res, "userId"); return; }
  await db.execute(sql`
    DELETE FROM ps_project_members WHERE project_id = ${proj.id}::uuid AND user_id = ${uid}::uuid
  `);
  await logActivity(proj.id, req.user!.id, "ps.member.remove", { targetId: uid });
  res.json({ ok: true });
});

router.get("/planning-studio/projects/:id/activity", async (req, res): Promise<void> => {
  const proj = await requireProject(req, res); if (!proj) return;
  const limit = Math.min(parseInt(String(req.query.limit || "50"), 10) || 50, 500);
  const r = await db.execute(sql`
    SELECT a.*, u.email AS user_email, u.full_name AS user_full_name
      FROM ps_project_activity_log a
      LEFT JOIN users u ON u.id = a.user_id
     WHERE a.project_id = ${proj.id}::uuid
     ORDER BY a.at DESC
     LIMIT ${limit}
  `);
  const rows: any[] = (r as any).rows ?? (r as any) ?? [];
  res.json({
    activity: rows.map(r => ({
      id: r.id, action: r.action,
      targetType: r.target_type, targetId: r.target_id,
      payload: r.payload ?? {},
      at: r.at,
      userId: r.user_id,
      userEmail: r.user_email,
      userFullName: r.user_full_name,
    })),
  });
});

/* ────────────────────────────────────────────────────────────
 *  L1 — FERMATE
 * ──────────────────────────────────────────────────────────── */

router.get("/planning-studio/projects/:id/stops", async (req, res): Promise<void> => {
  const proj = await requireProject(req, res); if (!proj) return;
  const r = await db.execute(sql`
    SELECT * FROM ps_stops WHERE project_id = ${proj.id}::uuid
     ORDER BY name ASC
  `);
  const rows: any[] = (r as any).rows ?? (r as any) ?? [];
  res.json({ stops: rows.map(rowToStop) });
});

router.post("/planning-studio/projects/:id/stops", async (req, res): Promise<void> => {
  const proj = await requireProject(req, res); if (!proj) return;
  if (!canWrite(proj)) { res.status(403).json({ error: "Permessi insufficienti" }); return; }
  const { code, name, description, lat, lon, zoneId, locationType,
          parentStation, wheelchairBoarding, platformCode, attributes } = req.body || {};
  if (typeof name !== "string" || name.trim().length === 0) {
    res.status(400).json({ error: "name obbligatorio" }); return;
  }
  const la = Number(lat), lo = Number(lon);
  if (!isFinite(la) || !isFinite(lo)) { res.status(400).json({ error: "lat/lon non validi" }); return; }
  const r = await db.execute(sql`
    INSERT INTO ps_stops (project_id, code, name, description, lat, lon, zone_id,
                          location_type, parent_station, wheelchair_boarding, platform_code, attributes)
    VALUES (${proj.id}::uuid, ${code ?? null}, ${name.trim()}, ${description ?? null},
            ${la}, ${lo}, ${zoneId ?? null},
            ${locationType ?? 0},
            ${parentStation ?? null},
            ${wheelchairBoarding ?? 0},
            ${platformCode ?? null},
            ${JSON.stringify(attributes ?? {})}::jsonb)
    RETURNING *
  `);
  const row: any = (r as any).rows?.[0] ?? (r as any)[0];
  await logActivity(proj.id, req.user!.id, "ps.stop.create", { targetId: row.id, payload: { name: row.name } });
  res.json({ stop: rowToStop(row) });
});

// Bulk insert (utile per import) — body: { stops: [...] }
router.post("/planning-studio/projects/:id/stops/bulk", async (req, res): Promise<void> => {
  const proj = await requireProject(req, res); if (!proj) return;
  if (!canWrite(proj)) { res.status(403).json({ error: "Permessi insufficienti" }); return; }
  const list: any[] = Array.isArray(req.body?.stops) ? req.body.stops : [];
  if (list.length === 0) { res.json({ inserted: 0 }); return; }
  let inserted = 0;
  for (const s of list) {
    const la = Number(s.lat), lo = Number(s.lon);
    if (!s?.name || !isFinite(la) || !isFinite(lo)) continue;
    await db.execute(sql`
      INSERT INTO ps_stops (project_id, code, name, lat, lon, zone_id, location_type, attributes)
      VALUES (${proj.id}::uuid, ${s.code ?? null}, ${String(s.name)},
              ${la}, ${lo}, ${s.zoneId ?? null}, ${s.locationType ?? 0},
              ${JSON.stringify(s.attributes ?? {})}::jsonb)
    `);
    inserted++;
  }
  await logActivity(proj.id, req.user!.id, "ps.stop.bulk", { payload: { inserted } });
  res.json({ inserted });
});

router.patch("/planning-studio/projects/:id/stops/:stopId", async (req, res): Promise<void> => {
  const proj = await requireProject(req, res); if (!proj) return;
  if (!canWrite(proj)) { res.status(403).json({ error: "Permessi insufficienti" }); return; }
  const stopId = String(req.params.stopId);
  if (!UUID_RE.test(stopId)) { badId(res, "stopId"); return; }
  const b = req.body || {};
  const sets: any[] = [];
  if (b.code !== undefined) sets.push(sql`code = ${b.code}`);
  if (b.name !== undefined) sets.push(sql`name = ${b.name}`);
  if (b.description !== undefined) sets.push(sql`description = ${b.description}`);
  if (b.lat !== undefined) sets.push(sql`lat = ${Number(b.lat)}`);
  if (b.lon !== undefined) sets.push(sql`lon = ${Number(b.lon)}`);
  if (b.zoneId !== undefined) sets.push(sql`zone_id = ${b.zoneId}`);
  if (b.locationType !== undefined) sets.push(sql`location_type = ${Number(b.locationType)}`);
  if (b.parentStation !== undefined) sets.push(sql`parent_station = ${b.parentStation}`);
  if (b.wheelchairBoarding !== undefined) sets.push(sql`wheelchair_boarding = ${Number(b.wheelchairBoarding)}`);
  if (b.platformCode !== undefined) sets.push(sql`platform_code = ${b.platformCode}`);
  if (b.attributes !== undefined) sets.push(sql`attributes = ${JSON.stringify(b.attributes)}::jsonb`);
  if (sets.length === 0) { res.json({ ok: true, noop: true }); return; }
  sets.push(sql`updated_at = now()`);
  const assignments = sql.join(sets, sql`, `);
  const r = await db.execute(sql`
    UPDATE ps_stops SET ${assignments}
     WHERE id = ${stopId}::uuid AND project_id = ${proj.id}::uuid
     RETURNING *
  `);
  const row: any = (r as any).rows?.[0] ?? (r as any)[0];
  if (!row) { res.status(404).json({ error: "Fermata non trovata" }); return; }
  await logActivity(proj.id, req.user!.id, "ps.stop.update", { targetId: stopId });
  res.json({ stop: rowToStop(row) });
});

router.delete("/planning-studio/projects/:id/stops/:stopId", async (req, res): Promise<void> => {
  const proj = await requireProject(req, res); if (!proj) return;
  if (!canWrite(proj)) { res.status(403).json({ error: "Permessi insufficienti" }); return; }
  const stopId = String(req.params.stopId);
  if (!UUID_RE.test(stopId)) { badId(res, "stopId"); return; }
  try {
    await db.execute(sql`
      DELETE FROM ps_stops WHERE id = ${stopId}::uuid AND project_id = ${proj.id}::uuid
    `);
    await logActivity(proj.id, req.user!.id, "ps.stop.delete", { targetId: stopId });
    res.json({ ok: true });
  } catch (e: any) {
    res.status(409).json({ error: "Impossibile eliminare: la fermata è usata in varianti o orari" });
  }
});

/* ────────────────────────────────────────────────────────────
 *  L3 — LINEE
 * ──────────────────────────────────────────────────────────── */

router.get("/planning-studio/projects/:id/routes", async (req, res): Promise<void> => {
  const proj = await requireProject(req, res); if (!proj) return;
  const r = await db.execute(sql`
    SELECT r.*,
           (SELECT count(*)::int FROM ps_route_variants v WHERE v.route_id = r.id) AS variant_count
      FROM ps_routes r
     WHERE r.project_id = ${proj.id}::uuid
     ORDER BY r.sort_order ASC, r.short_name ASC
  `);
  const rows: any[] = (r as any).rows ?? (r as any) ?? [];
  res.json({ routes: rows.map(rowToRoute) });
});

router.post("/planning-studio/projects/:id/routes", async (req, res): Promise<void> => {
  const proj = await requireProject(req, res); if (!proj) return;
  if (!canWrite(proj)) { res.status(403).json({ error: "Permessi insufficienti" }); return; }
  const b = req.body || {};
  if (typeof b.shortName !== "string" || b.shortName.trim().length === 0) {
    res.status(400).json({ error: "shortName obbligatorio" }); return;
  }
  const r = await db.execute(sql`
    INSERT INTO ps_routes (project_id, code, short_name, long_name, description,
                           route_type, color, text_color, agency_id, sort_order, attributes)
    VALUES (${proj.id}::uuid, ${b.code ?? null}, ${b.shortName.trim()},
            ${b.longName ?? null}, ${b.description ?? null},
            ${b.routeType ?? 3}, ${b.color ?? null}, ${b.textColor ?? null},
            ${b.agencyId ?? null}, ${b.sortOrder ?? 0},
            ${JSON.stringify(b.attributes ?? {})}::jsonb)
    RETURNING *
  `);
  const row: any = (r as any).rows?.[0] ?? (r as any)[0];
  await logActivity(proj.id, req.user!.id, "ps.route.create", { targetId: row.id, payload: { shortName: row.short_name } });
  res.json({ route: rowToRoute(row) });
});

router.patch("/planning-studio/projects/:id/routes/:routeId", async (req, res): Promise<void> => {
  const proj = await requireProject(req, res); if (!proj) return;
  if (!canWrite(proj)) { res.status(403).json({ error: "Permessi insufficienti" }); return; }
  const routeId = String(req.params.routeId);
  if (!UUID_RE.test(routeId)) { badId(res, "routeId"); return; }
  const b = req.body || {};
  const sets: any[] = [];
  if (b.code !== undefined) sets.push(sql`code = ${b.code}`);
  if (b.shortName !== undefined) sets.push(sql`short_name = ${b.shortName}`);
  if (b.longName !== undefined) sets.push(sql`long_name = ${b.longName}`);
  if (b.description !== undefined) sets.push(sql`description = ${b.description}`);
  if (b.routeType !== undefined) sets.push(sql`route_type = ${Number(b.routeType)}`);
  if (b.color !== undefined) sets.push(sql`color = ${b.color}`);
  if (b.textColor !== undefined) sets.push(sql`text_color = ${b.textColor}`);
  if (b.agencyId !== undefined) sets.push(sql`agency_id = ${b.agencyId}`);
  if (b.sortOrder !== undefined) sets.push(sql`sort_order = ${Number(b.sortOrder)}`);
  if (b.attributes !== undefined) sets.push(sql`attributes = ${JSON.stringify(b.attributes)}::jsonb`);
  if (sets.length === 0) { res.json({ ok: true, noop: true }); return; }
  sets.push(sql`updated_at = now()`);
  const assignments = sql.join(sets, sql`, `);
  const r = await db.execute(sql`
    UPDATE ps_routes SET ${assignments}
     WHERE id = ${routeId}::uuid AND project_id = ${proj.id}::uuid
     RETURNING *
  `);
  const row: any = (r as any).rows?.[0] ?? (r as any)[0];
  if (!row) { res.status(404).json({ error: "Linea non trovata" }); return; }
  await logActivity(proj.id, req.user!.id, "ps.route.update", { targetId: routeId });
  res.json({ route: rowToRoute(row) });
});

router.delete("/planning-studio/projects/:id/routes/:routeId", async (req, res): Promise<void> => {
  const proj = await requireProject(req, res); if (!proj) return;
  if (!canWrite(proj)) { res.status(403).json({ error: "Permessi insufficienti" }); return; }
  const routeId = String(req.params.routeId);
  if (!UUID_RE.test(routeId)) { badId(res, "routeId"); return; }
  await db.execute(sql`
    DELETE FROM ps_routes WHERE id = ${routeId}::uuid AND project_id = ${proj.id}::uuid
  `);
  await logActivity(proj.id, req.user!.id, "ps.route.delete", { targetId: routeId });
  res.json({ ok: true });
});

/* ────────────────────────────────────────────────────────────
 *  VARIANTI
 * ──────────────────────────────────────────────────────────── */

router.get("/planning-studio/projects/:id/routes/:routeId/variants", async (req, res): Promise<void> => {
  const proj = await requireProject(req, res); if (!proj) return;
  const routeId = String(req.params.routeId);
  if (!UUID_RE.test(routeId)) { badId(res, "routeId"); return; }
  const r = await db.execute(sql`
    SELECT v.*,
      (SELECT count(*)::int FROM ps_variant_stops vs WHERE vs.variant_id = v.id) AS stop_count,
      (SELECT count(*)::int FROM ps_shapes s WHERE s.variant_id = v.id) > 0 AS has_shape
      FROM ps_route_variants v
     WHERE v.route_id = ${routeId}::uuid AND v.project_id = ${proj.id}::uuid
     ORDER BY v.direction ASC, v.is_default DESC, v.created_at ASC
  `);
  const rows: any[] = (r as any).rows ?? (r as any) ?? [];
  res.json({ variants: rows.map(rowToVariant) });
});

router.post("/planning-studio/projects/:id/routes/:routeId/variants", async (req, res): Promise<void> => {
  const proj = await requireProject(req, res); if (!proj) return;
  if (!canWrite(proj)) { res.status(403).json({ error: "Permessi insufficienti" }); return; }
  const routeId = String(req.params.routeId);
  if (!UUID_RE.test(routeId)) { badId(res, "routeId"); return; }
  const b = req.body || {};
  if (typeof b.name !== "string" || b.name.trim().length === 0) {
    res.status(400).json({ error: "name obbligatorio" }); return;
  }
  const r = await db.execute(sql`
    INSERT INTO ps_route_variants (project_id, route_id, name, direction, headsign, is_default, attributes)
    VALUES (${proj.id}::uuid, ${routeId}::uuid, ${b.name.trim()},
            ${b.direction ?? 0}, ${b.headsign ?? null},
            ${!!b.isDefault}, ${JSON.stringify(b.attributes ?? {})}::jsonb)
    RETURNING *
  `);
  const row: any = (r as any).rows?.[0] ?? (r as any)[0];
  await logActivity(proj.id, req.user!.id, "ps.variant.create", { targetId: row.id, payload: { name: row.name } });
  res.json({ variant: rowToVariant(row) });
});

router.get("/planning-studio/projects/:id/variants/:variantId", async (req, res): Promise<void> => {
  const proj = await requireProject(req, res); if (!proj) return;
  const variantId = String(req.params.variantId);
  if (!UUID_RE.test(variantId)) { badId(res, "variantId"); return; }
  const r = await db.execute(sql`
    SELECT v.*,
      (SELECT count(*)::int FROM ps_variant_stops vs WHERE vs.variant_id = v.id) AS stop_count,
      (SELECT count(*)::int FROM ps_shapes s WHERE s.variant_id = v.id) > 0 AS has_shape
      FROM ps_route_variants v
     WHERE v.id = ${variantId}::uuid AND v.project_id = ${proj.id}::uuid
     LIMIT 1
  `);
  const row: any = (r as any).rows?.[0] ?? (r as any)[0];
  if (!row) { res.status(404).json({ error: "Variante non trovata" }); return; }
  // Sequenza fermate
  const sr = await db.execute(sql`
    SELECT vs.*, s.name AS stop_name, s.lat AS stop_lat, s.lon AS stop_lon, s.code AS stop_code
      FROM ps_variant_stops vs
      JOIN ps_stops s ON s.id = vs.stop_id
     WHERE vs.variant_id = ${variantId}::uuid
     ORDER BY vs.seq ASC
  `);
  const stopRows: any[] = (sr as any).rows ?? (sr as any) ?? [];
  // Shape se presente
  const sh = await db.execute(sql`
    SELECT * FROM ps_shapes WHERE variant_id = ${variantId}::uuid LIMIT 1
  `);
  const shapeRow: any = (sh as any).rows?.[0] ?? (sh as any)[0];
  res.json({
    variant: rowToVariant(row),
    stops: stopRows.map(s => ({
      seq: s.seq,
      stopId: s.stop_id,
      stopName: s.stop_name,
      stopCode: s.stop_code,
      lat: Number(s.stop_lat), lon: Number(s.stop_lon),
      pickupType: s.pickup_type,
      dropOffType: s.drop_off_type,
      timepoint: s.timepoint,
      shapeDistTraveled: s.shape_dist_traveled,
    })),
    shape: shapeRow ? rowToShape(shapeRow) : null,
  });
});

router.patch("/planning-studio/projects/:id/variants/:variantId", async (req, res): Promise<void> => {
  const proj = await requireProject(req, res); if (!proj) return;
  if (!canWrite(proj)) { res.status(403).json({ error: "Permessi insufficienti" }); return; }
  const variantId = String(req.params.variantId);
  if (!UUID_RE.test(variantId)) { badId(res, "variantId"); return; }
  const b = req.body || {};
  const sets: any[] = [];
  if (b.name !== undefined) sets.push(sql`name = ${b.name}`);
  if (b.direction !== undefined) sets.push(sql`direction = ${Number(b.direction)}`);
  if (b.headsign !== undefined) sets.push(sql`headsign = ${b.headsign}`);
  if (b.isDefault !== undefined) sets.push(sql`is_default = ${!!b.isDefault}`);
  if (b.attributes !== undefined) sets.push(sql`attributes = ${JSON.stringify(b.attributes)}::jsonb`);
  if (sets.length === 0) { res.json({ ok: true, noop: true }); return; }
  sets.push(sql`updated_at = now()`);
  const assignments = sql.join(sets, sql`, `);
  const r = await db.execute(sql`
    UPDATE ps_route_variants SET ${assignments}
     WHERE id = ${variantId}::uuid AND project_id = ${proj.id}::uuid
     RETURNING *
  `);
  const row: any = (r as any).rows?.[0] ?? (r as any)[0];
  if (!row) { res.status(404).json({ error: "Variante non trovata" }); return; }
  await logActivity(proj.id, req.user!.id, "ps.variant.update", { targetId: variantId });
  res.json({ variant: rowToVariant(row) });
});

router.delete("/planning-studio/projects/:id/variants/:variantId", async (req, res): Promise<void> => {
  const proj = await requireProject(req, res); if (!proj) return;
  if (!canWrite(proj)) { res.status(403).json({ error: "Permessi insufficienti" }); return; }
  const variantId = String(req.params.variantId);
  if (!UUID_RE.test(variantId)) { badId(res, "variantId"); return; }
  await db.execute(sql`
    DELETE FROM ps_route_variants WHERE id = ${variantId}::uuid AND project_id = ${proj.id}::uuid
  `);
  await logActivity(proj.id, req.user!.id, "ps.variant.delete", { targetId: variantId });
  res.json({ ok: true });
});

/** PUT /variants/:variantId/stops — sostituisce l'intera sequenza.
 *  body: { stops: [{ stopId, pickupType?, dropOffType?, timepoint?, shapeDistTraveled? }, ...] } */
router.put("/planning-studio/projects/:id/variants/:variantId/stops", async (req, res): Promise<void> => {
  const proj = await requireProject(req, res); if (!proj) return;
  if (!canWrite(proj)) { res.status(403).json({ error: "Permessi insufficienti" }); return; }
  const variantId = String(req.params.variantId);
  if (!UUID_RE.test(variantId)) { badId(res, "variantId"); return; }
  const list: any[] = Array.isArray(req.body?.stops) ? req.body.stops : [];
  await db.execute(sql`DELETE FROM ps_variant_stops WHERE variant_id = ${variantId}::uuid`);
  let seq = 1;
  for (const s of list) {
    if (!s?.stopId || !UUID_RE.test(String(s.stopId))) continue;
    await db.execute(sql`
      INSERT INTO ps_variant_stops (variant_id, seq, stop_id, pickup_type, drop_off_type, timepoint, shape_dist_traveled)
      VALUES (${variantId}::uuid, ${seq}, ${String(s.stopId)}::uuid,
              ${s.pickupType ?? 0}, ${s.dropOffType ?? 0},
              ${s.timepoint ?? 1}, ${s.shapeDistTraveled ?? null})
    `);
    seq++;
  }
  await db.execute(sql`UPDATE ps_route_variants SET updated_at = now() WHERE id = ${variantId}::uuid`);
  await logActivity(proj.id, req.user!.id, "ps.variant.sequence", { targetId: variantId, payload: { count: seq - 1 } });
  res.json({ ok: true, count: seq - 1 });
});

/** PUT /variants/:variantId/shape — upsert dello shape della variante.
 *  body: { mode: 'driving'|'manual'|..., geometry: GeoJSON LineString, waypoints: [...],
 *          distanceM?: number, durationS?: number } */
router.put("/planning-studio/projects/:id/variants/:variantId/shape", async (req, res): Promise<void> => {
  const proj = await requireProject(req, res); if (!proj) return;
  if (!canWrite(proj)) { res.status(403).json({ error: "Permessi insufficienti" }); return; }
  const variantId = String(req.params.variantId);
  if (!UUID_RE.test(variantId)) { badId(res, "variantId"); return; }
  const b = req.body || {};
  if (!b.geometry || b.geometry.type !== "LineString" || !Array.isArray(b.geometry.coordinates)) {
    res.status(400).json({ error: "geometry: LineString GeoJSON richiesto" }); return;
  }
  const mode = typeof b.mode === "string" ? b.mode : "driving";
  const wpts = Array.isArray(b.waypoints) ? b.waypoints : [];
  const r = await db.execute(sql`
    INSERT INTO ps_shapes (project_id, variant_id, mode, geometry, waypoints, distance_m, duration_s, updated_at)
    VALUES (${proj.id}::uuid, ${variantId}::uuid, ${mode},
            ${JSON.stringify(b.geometry)}::jsonb,
            ${JSON.stringify(wpts)}::jsonb,
            ${b.distanceM ?? null}, ${b.durationS ?? null}, now())
    ON CONFLICT (variant_id) DO UPDATE
      SET mode = EXCLUDED.mode,
          geometry = EXCLUDED.geometry,
          waypoints = EXCLUDED.waypoints,
          distance_m = EXCLUDED.distance_m,
          duration_s = EXCLUDED.duration_s,
          updated_at = now()
    RETURNING *
  `);
  const row: any = (r as any).rows?.[0] ?? (r as any)[0];
  await logActivity(proj.id, req.user!.id, "ps.shape.save",
    { targetId: variantId, payload: { distanceM: row.distance_m, mode } });
  res.json({ shape: rowToShape(row) });
});

/* ────────────────────────────────────────────────────────────
 *  L5 — CALENDARI
 * ──────────────────────────────────────────────────────────── */

router.get("/planning-studio/projects/:id/calendars", async (req, res): Promise<void> => {
  const proj = await requireProject(req, res); if (!proj) return;
  const r = await db.execute(sql`
    SELECT * FROM ps_calendars WHERE project_id = ${proj.id}::uuid ORDER BY code ASC
  `);
  const rows: any[] = (r as any).rows ?? (r as any) ?? [];
  res.json({ calendars: rows.map(rowToCalendar) });
});

router.post("/planning-studio/projects/:id/calendars", async (req, res): Promise<void> => {
  const proj = await requireProject(req, res); if (!proj) return;
  if (!canWrite(proj)) { res.status(403).json({ error: "Permessi insufficienti" }); return; }
  const b = req.body || {};
  if (typeof b.code !== "string" || !b.startDate || !b.endDate) {
    res.status(400).json({ error: "code, startDate, endDate obbligatori" }); return;
  }
  const r = await db.execute(sql`
    INSERT INTO ps_calendars (project_id, code, name,
      monday, tuesday, wednesday, thursday, friday, saturday, sunday,
      start_date, end_date)
    VALUES (${proj.id}::uuid, ${b.code}, ${b.name ?? null},
      ${!!b.monday}, ${!!b.tuesday}, ${!!b.wednesday}, ${!!b.thursday},
      ${!!b.friday}, ${!!b.saturday}, ${!!b.sunday},
      ${b.startDate}::date, ${b.endDate}::date)
    RETURNING *
  `);
  const row: any = (r as any).rows?.[0] ?? (r as any)[0];
  await logActivity(proj.id, req.user!.id, "ps.calendar.create", { targetId: row.id, payload: { code: row.code } });
  res.json({ calendar: rowToCalendar(row) });
});

router.patch("/planning-studio/projects/:id/calendars/:calId", async (req, res): Promise<void> => {
  const proj = await requireProject(req, res); if (!proj) return;
  if (!canWrite(proj)) { res.status(403).json({ error: "Permessi insufficienti" }); return; }
  const calId = String(req.params.calId);
  if (!UUID_RE.test(calId)) { badId(res, "calId"); return; }
  const b = req.body || {};
  const sets: any[] = [];
  for (const k of ["code","name"] as const) if (b[k] !== undefined) sets.push(sql`${sql.raw(k)} = ${b[k]}`);
  for (const k of ["monday","tuesday","wednesday","thursday","friday","saturday","sunday"] as const)
    if (b[k] !== undefined) sets.push(sql`${sql.raw(k)} = ${!!b[k]}`);
  if (b.startDate !== undefined) sets.push(sql`start_date = ${b.startDate}::date`);
  if (b.endDate !== undefined) sets.push(sql`end_date = ${b.endDate}::date`);
  if (sets.length === 0) { res.json({ ok: true, noop: true }); return; }
  sets.push(sql`updated_at = now()`);
  const assignments = sql.join(sets, sql`, `);
  const r = await db.execute(sql`
    UPDATE ps_calendars SET ${assignments}
     WHERE id = ${calId}::uuid AND project_id = ${proj.id}::uuid
     RETURNING *
  `);
  const row: any = (r as any).rows?.[0] ?? (r as any)[0];
  if (!row) { res.status(404).json({ error: "Calendario non trovato" }); return; }
  await logActivity(proj.id, req.user!.id, "ps.calendar.update", { targetId: calId });
  res.json({ calendar: rowToCalendar(row) });
});

router.delete("/planning-studio/projects/:id/calendars/:calId", async (req, res): Promise<void> => {
  const proj = await requireProject(req, res); if (!proj) return;
  if (!canWrite(proj)) { res.status(403).json({ error: "Permessi insufficienti" }); return; }
  const calId = String(req.params.calId);
  if (!UUID_RE.test(calId)) { badId(res, "calId"); return; }
  await db.execute(sql`
    DELETE FROM ps_calendars WHERE id = ${calId}::uuid AND project_id = ${proj.id}::uuid
  `);
  await logActivity(proj.id, req.user!.id, "ps.calendar.delete", { targetId: calId });
  res.json({ ok: true });
});

// PUT /calendars/:calId/dates — sostituisce le eccezioni
router.put("/planning-studio/projects/:id/calendars/:calId/dates", async (req, res): Promise<void> => {
  const proj = await requireProject(req, res); if (!proj) return;
  if (!canWrite(proj)) { res.status(403).json({ error: "Permessi insufficienti" }); return; }
  const calId = String(req.params.calId);
  if (!UUID_RE.test(calId)) { badId(res, "calId"); return; }
  const list: any[] = Array.isArray(req.body?.dates) ? req.body.dates : [];
  await db.execute(sql`DELETE FROM ps_calendar_dates WHERE calendar_id = ${calId}::uuid`);
  for (const d of list) {
    if (!d?.date) continue;
    await db.execute(sql`
      INSERT INTO ps_calendar_dates (calendar_id, date, exception_type)
      VALUES (${calId}::uuid, ${d.date}::date, ${Number(d.exceptionType ?? 1)})
      ON CONFLICT (calendar_id, date) DO UPDATE SET exception_type = EXCLUDED.exception_type
    `);
  }
  await logActivity(proj.id, req.user!.id, "ps.calendar.dates", { targetId: calId, payload: { count: list.length } });
  res.json({ ok: true, count: list.length });
});

/* ────────────────────────────────────────────────────────────
 *  L4 — CORSE + ORARI
 * ──────────────────────────────────────────────────────────── */

router.get("/planning-studio/projects/:id/trips", async (req, res): Promise<void> => {
  const proj = await requireProject(req, res); if (!proj) return;
  const routeId = req.query.routeId ? String(req.query.routeId) : null;
  const variantId = req.query.variantId ? String(req.query.variantId) : null;
  const r = await db.execute(sql`
    SELECT t.* FROM ps_trips t
     WHERE t.project_id = ${proj.id}::uuid
       AND (${routeId}::uuid IS NULL OR t.route_id = ${routeId}::uuid)
       AND (${variantId}::uuid IS NULL OR t.variant_id = ${variantId}::uuid)
     ORDER BY t.created_at ASC
     LIMIT 5000
  `);
  const rows: any[] = (r as any).rows ?? (r as any) ?? [];
  res.json({ trips: rows.map(rowToTrip) });
});

router.post("/planning-studio/projects/:id/trips", async (req, res): Promise<void> => {
  const proj = await requireProject(req, res); if (!proj) return;
  if (!canWrite(proj)) { res.status(403).json({ error: "Permessi insufficienti" }); return; }
  const b = req.body || {};
  if (!UUID_RE.test(String(b.routeId ?? "")) || !UUID_RE.test(String(b.variantId ?? ""))) {
    res.status(400).json({ error: "routeId e variantId obbligatori" }); return;
  }
  const r = await db.execute(sql`
    INSERT INTO ps_trips (project_id, route_id, variant_id, calendar_id,
                          headsign, short_name, direction, block_id, attributes)
    VALUES (${proj.id}::uuid, ${b.routeId}::uuid, ${b.variantId}::uuid,
            ${b.calendarId ?? null}, ${b.headsign ?? null}, ${b.shortName ?? null},
            ${b.direction ?? 0}, ${b.blockId ?? null},
            ${JSON.stringify(b.attributes ?? {})}::jsonb)
    RETURNING *
  `);
  const row: any = (r as any).rows?.[0] ?? (r as any)[0];
  await logActivity(proj.id, req.user!.id, "ps.trip.create", { targetId: row.id });
  res.json({ trip: rowToTrip(row) });
});

router.delete("/planning-studio/projects/:id/trips/:tripId", async (req, res): Promise<void> => {
  const proj = await requireProject(req, res); if (!proj) return;
  if (!canWrite(proj)) { res.status(403).json({ error: "Permessi insufficienti" }); return; }
  const tripId = String(req.params.tripId);
  if (!UUID_RE.test(tripId)) { badId(res, "tripId"); return; }
  await db.execute(sql`
    DELETE FROM ps_trips WHERE id = ${tripId}::uuid AND project_id = ${proj.id}::uuid
  `);
  await logActivity(proj.id, req.user!.id, "ps.trip.delete", { targetId: tripId });
  res.json({ ok: true });
});

router.get("/planning-studio/projects/:id/trips/:tripId/stop-times", async (req, res): Promise<void> => {
  const proj = await requireProject(req, res); if (!proj) return;
  const tripId = String(req.params.tripId);
  if (!UUID_RE.test(tripId)) { badId(res, "tripId"); return; }
  const r = await db.execute(sql`
    SELECT st.*, s.name AS stop_name, s.code AS stop_code
      FROM ps_stop_times st
      JOIN ps_stops s ON s.id = st.stop_id
     WHERE st.trip_id = ${tripId}::uuid
     ORDER BY st.stop_seq ASC
  `);
  const rows: any[] = (r as any).rows ?? (r as any) ?? [];
  res.json({
    stopTimes: rows.map(r => ({
      tripId: r.trip_id,
      stopSeq: r.stop_seq,
      stopId: r.stop_id,
      stopName: r.stop_name,
      stopCode: r.stop_code,
      arrivalTime: r.arrival_time,
      departureTime: r.departure_time,
      pickupType: r.pickup_type,
      dropOffType: r.drop_off_type,
      timepoint: r.timepoint,
      shapeDistTraveled: r.shape_dist_traveled,
    })),
  });
});

// POST /stop-times/bulk — orari di MOLTE corse in una sola chiamata.
// Nato per il TTD (orario grafico): la versione corsa-per-corsa generava
// centinaia di GET e faceva scattare il rate limiter (429).
router.post("/planning-studio/projects/:id/stop-times/bulk", async (req, res): Promise<void> => {
  const proj = await requireProject(req, res); if (!proj) return;
  const tripIds: string[] = Array.isArray(req.body?.tripIds)
    ? req.body.tripIds.filter((t: unknown) => UUID_RE.test(String(t))).slice(0, 2000)
    : [];
  if (tripIds.length === 0) { res.json({ stopTimesByTrip: {} }); return; }
  // array come literal Postgres: l'interpolazione diretta genera una tupla invalida
  const idsLiteral = `{${tripIds.join(",")}}`;
  const r = await db.execute(sql`
    SELECT st.*, s.name AS stop_name, s.code AS stop_code
      FROM ps_stop_times st
      JOIN ps_stops s ON s.id = st.stop_id
      JOIN ps_trips t ON t.id = st.trip_id
     WHERE st.trip_id = ANY(${idsLiteral}::uuid[])
       AND t.project_id = ${proj.id}::uuid
     ORDER BY st.trip_id, st.stop_seq ASC
  `);
  const rows: any[] = (r as any).rows ?? (r as any) ?? [];
  const byTrip: Record<string, any[]> = {};
  for (const row of rows) {
    (byTrip[row.trip_id] ??= []).push({
      tripId: row.trip_id,
      stopSeq: row.stop_seq,
      stopId: row.stop_id,
      stopName: row.stop_name,
      stopCode: row.stop_code,
      arrivalTime: row.arrival_time,
      departureTime: row.departure_time,
      pickupType: row.pickup_type,
      dropOffType: row.drop_off_type,
      timepoint: row.timepoint,
      shapeDistTraveled: row.shape_dist_traveled,
    });
  }
  res.json({ stopTimesByTrip: byTrip });
});

// PUT /trips/:tripId/stop-times — sostituisce gli orari
router.put("/planning-studio/projects/:id/trips/:tripId/stop-times", async (req, res): Promise<void> => {
  const proj = await requireProject(req, res); if (!proj) return;
  if (!canWrite(proj)) { res.status(403).json({ error: "Permessi insufficienti" }); return; }
  const tripId = String(req.params.tripId);
  if (!UUID_RE.test(tripId)) { badId(res, "tripId"); return; }
  const list: any[] = Array.isArray(req.body?.stopTimes) ? req.body.stopTimes : [];
  // Validazione formato HH:MM:SS (consente >24)
  for (const st of list) {
    if (!UUID_RE.test(String(st.stopId ?? ""))) {
      res.status(400).json({ error: "stopId non valido" }); return;
    }
    if (!HHMMSS_RE.test(String(st.arrivalTime ?? "")) || !HHMMSS_RE.test(String(st.departureTime ?? ""))) {
      res.status(400).json({ error: "arrivalTime/departureTime devono essere HH:MM:SS" }); return;
    }
  }
  await db.execute(sql`DELETE FROM ps_stop_times WHERE trip_id = ${tripId}::uuid`);
  let seq = 1;
  for (const st of list) {
    await db.execute(sql`
      INSERT INTO ps_stop_times (trip_id, stop_seq, stop_id, arrival_time, departure_time,
                                 pickup_type, drop_off_type, timepoint, shape_dist_traveled)
      VALUES (${tripId}::uuid, ${seq}, ${String(st.stopId)}::uuid,
              ${st.arrivalTime}, ${st.departureTime},
              ${st.pickupType ?? 0}, ${st.dropOffType ?? 0},
              ${st.timepoint ?? 1}, ${st.shapeDistTraveled ?? null})
    `);
    seq++;
  }
  await logActivity(proj.id, req.user!.id, "ps.trip.stop-times", { targetId: tripId, payload: { count: seq - 1 } });
  res.json({ ok: true, count: seq - 1 });
});

/* ════════════════════════════════════════════════════════════
 *  ROUTE-SNAP (OSRM proxy con cache)
 * ════════════════════════════════════════════════════════════ */

const OSRM_BASE = process.env.OSRM_URL || "https://router.project-osrm.org";

function roundCoord(n: number): number {
  // 6 decimali ≈ 11 cm. Coerente con quanto OSRM tollera per cache hit.
  return Math.round(n * 1e6) / 1e6;
}

async function snapSegment(
  mode: string,
  a: [number, number], b: [number, number]
): Promise<{ geometry: any; distanceM: number; durationS: number } | null> {
  const fromLon = roundCoord(a[0]), fromLat = roundCoord(a[1]);
  const toLon   = roundCoord(b[0]), toLat   = roundCoord(b[1]);

  // 1. Cache lookup
  const cached = await db.execute(sql`
    SELECT geometry, distance_m, duration_s FROM ps_route_snap_cache
     WHERE mode = ${mode}
       AND from_lon = ${fromLon} AND from_lat = ${fromLat}
       AND to_lon = ${toLon}     AND to_lat = ${toLat}
     LIMIT 1
  `);
  const hit: any = (cached as any).rows?.[0] ?? (cached as any)[0];
  if (hit) return { geometry: hit.geometry, distanceM: Number(hit.distance_m), durationS: Number(hit.duration_s) };

  // 2. OSRM (driving fisso per ora; mode 'manual' non chiama OSRM ed è gestito a monte)
  if (mode !== "driving") return null;

  const profile = "driving";
  const url = `${OSRM_BASE}/route/v1/${profile}/${fromLon},${fromLat};${toLon},${toLat}`
            + `?overview=full&geometries=geojson&continue_straight=false`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const j: any = await r.json();
    const route = j?.routes?.[0];
    if (!route?.geometry) return null;
    const geom = route.geometry; // GeoJSON LineString
    const distanceM = Number(route.distance) || 0;
    const durationS = Number(route.duration) || 0;
    // 3. Cache write (ON CONFLICT DO NOTHING)
    await db.execute(sql`
      INSERT INTO ps_route_snap_cache (mode, from_lon, from_lat, to_lon, to_lat, geometry, distance_m, duration_s)
      VALUES (${mode}, ${fromLon}, ${fromLat}, ${toLon}, ${toLat},
              ${JSON.stringify(geom)}::jsonb, ${distanceM}, ${durationS})
      ON CONFLICT (mode, from_lon, from_lat, to_lon, to_lat) DO NOTHING
    `);
    return { geometry: geom, distanceM, durationS };
  } catch (e: any) {
    console.warn("[osrm] fetch failed:", e?.message || e);
    return null;
  }
}

/** POST /planning-studio/route-snap
 *  body: { mode?: 'driving'|'manual', points: [[lng,lat], [lng,lat], ...] }
 *  Calcola la polyline che passa per i punti dati. Per ogni coppia consecutiva
 *  fa un OSRM call (con cache). Modalità 'manual' = ritorna la polyline dei
 *  punti tale e quale (linea retta), utile per zone fuori rete stradale. */
router.post("/planning-studio/route-snap", async (req, res): Promise<void> => {
  const b = req.body || {};
  const mode = typeof b.mode === "string" ? b.mode : "driving";
  const pts: any[] = Array.isArray(b.points) ? b.points : [];
  if (pts.length < 2) { res.status(400).json({ error: "points: almeno 2 coppie [lng,lat]" }); return; }
  const coords: [number, number][] = pts.map((p: any) => {
    const lng = Number(p[0]), lat = Number(p[1]);
    return [lng, lat];
  });
  if (coords.some(c => !isFinite(c[0]) || !isFinite(c[1]))) {
    res.status(400).json({ error: "coordinate non valide" }); return;
  }

  const segments: { geometry: any; distanceM: number; durationS: number; mode: string }[] = [];
  let totalDist = 0, totalDur = 0;

  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i], c = coords[i + 1];
    let seg: { geometry: any; distanceM: number; durationS: number } | null = null;

    if (mode === "driving") {
      seg = await snapSegment("driving", a, c);
    }
    if (!seg) {
      // Fallback / mode === 'manual' — linea retta + euristica distanza haversine
      const distanceM = haversine(a, c);
      seg = {
        geometry: { type: "LineString", coordinates: [a, c] },
        distanceM,
        durationS: distanceM / 8.33, // ~30 km/h fallback
      };
      segments.push({ ...seg, mode: "manual" });
    } else {
      segments.push({ ...seg, mode: "driving" });
    }
    totalDist += seg.distanceM;
    totalDur  += seg.durationS;
  }

  // Geometria unificata: concatena coordinate evitando duplicati di giunzione
  const unified: [number, number][] = [];
  for (const s of segments) {
    const cs = s.geometry?.coordinates ?? [];
    for (let i = 0; i < cs.length; i++) {
      const c = cs[i];
      if (unified.length && unified[unified.length - 1][0] === c[0] && unified[unified.length - 1][1] === c[1]) continue;
      unified.push([c[0], c[1]]);
    }
  }

  res.json({
    geometry: { type: "LineString", coordinates: unified },
    segments,
    distanceM: totalDist,
    durationS: totalDur,
  });
});

function haversine(a: [number, number], b: [number, number]): number {
  const R = 6371000;
  const toRad = (d: number) => d * Math.PI / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(b[0] - a[0]);
  const la1 = toRad(a[1]), la2 = toRad(b[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export default router;
