/**
 * Planning Studio — Validità per corsa + eccezioni date.
 *
 * Endpoints:
 *   PATCH  /projects/:id/trips/:tripId        (campi validità + base)
 *   GET    /projects/:id/trips/:tripId/exceptions
 *   POST   /projects/:id/trips/:tripId/exceptions
 *   DELETE /projects/:id/trips/:tripId/exceptions/:date
 *   POST   /projects/:id/trips/:tripId/shift  (trasla tutti gli orari di ±N minuti — orario grafico)
 *   POST   /projects/:id/trips/batch-create   (crea N corse con stop_times — cadenzamento orario grafico)
 *
 * exception_type (semantica GTFS-like):
 *   1 = aggiunta (corsa attiva quel giorno anche se calendar non lo prevede)
 *   2 = soppressione (corsa NON attiva quel giorno anche se calendar lo prevede)
 */
import type { Request, Response } from "express";
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const router: IRouter = Router();

const UUID_RE = /^[0-9a-f-]{36}$/i;

async function loadProject(projectId: string, userId: string, needWrite: boolean): Promise<any | null> {
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
  const row: any = (r as any).rows?.[0] ?? null;
  if (!row) return null;
  if (needWrite && row.my_role !== "owner" && row.my_role !== "editor") return null;
  return row;
}

function getUserId(req: Request): string | null {
  return (req as any).session?.userId ?? (req as any).user?.id ?? null;
}

async function logActivity(
  projectId: string, userId: string, action: string,
  targetType: string | null, targetId: string | null, payload: Record<string, any> = {},
): Promise<void> {
  try {
    await db.execute(sql`
      INSERT INTO ps_project_activity_log (project_id, user_id, action, target_type, target_id, payload)
      VALUES (${projectId}::uuid, ${userId}::uuid, ${action}, ${targetType}, ${targetId}, ${JSON.stringify(payload)}::jsonb)
    `);
  } catch (e: any) {
    console.warn("[ps-trips-ext] activity log error:", e?.message || e);
  }
}

/* ─── Contatore km del progetto (badge toolbar Planner Studio) ───
 * km totali = Σ per corsa della lunghezza del SUO percorso:
 * distance_m dello shape della variante, con fallback sull'ultima
 * shape_dist_traveled della sequenza fermate. Cresce man mano che si
 * aggiungono corse (vetture·km programmate). */

router.get("/planning-studio/projects/:id/trips-count", async (req, res): Promise<void> => {
  const userId = getUserId(req);
  if (!userId) { res.status(401).json({ error: "auth required" }); return; }
  const proj = await loadProject(req.params.id, userId, false);
  if (!proj) { res.status(403).json({ error: "no access" }); return; }
  const r = await db.execute(sql`
    WITH vlen AS (
      SELECT v.id AS variant_id,
             COALESCE(sh.distance_m, vs.max_dist, 0) AS len_m
        FROM ps_route_variants v
        LEFT JOIN ps_shapes sh ON sh.variant_id = v.id
        LEFT JOIN (
          SELECT variant_id, MAX(shape_dist_traveled) AS max_dist
            FROM ps_variant_stops GROUP BY variant_id
        ) vs ON vs.variant_id = v.id
    )
    SELECT (count(t.id) FILTER (WHERE NOT proto))::int                          AS total,
           (count(*) FILTER (WHERE t.is_active AND NOT proto))::int             AS active,
           (count(*) FILTER (WHERE proto))::int                                 AS prototypes,
           COALESCE(SUM(vlen.len_m) FILTER (WHERE NOT proto), 0)                AS km_m,
           COALESCE(SUM(vlen.len_m) FILTER (WHERE t.is_active AND NOT proto), 0) AS km_m_active
      FROM (SELECT *, COALESCE((attributes->>'prototype')::boolean, false) AS proto
              FROM ps_trips) t
      LEFT JOIN vlen ON vlen.variant_id = t.variant_id
     WHERE t.project_id = ${req.params.id}::uuid
  `);
  const row: any = (r as any).rows?.[0] ?? {};
  res.json({
    count: Number(row.total) || 0,
    active: Number(row.active) || 0,
    prototypes: Number(row.prototypes) || 0, // corse ZERO: non generano km
    km: Math.round(((Number(row.km_m) || 0) / 1000) * 10) / 10,
    kmActive: Math.round(((Number(row.km_m_active) || 0) / 1000) * 10) / 10,
  });
});

/* ─── Validità di UNA corsa: giorni (tipi giorno) + categorie ───
 * Alimenta la sezione "Giorni validità" del dettaglio corsa. */

router.get("/planning-studio/projects/:id/trips/:tripId/validity", async (req, res): Promise<void> => {
  const userId = getUserId(req);
  if (!userId) { res.status(401).json({ error: "auth required" }); return; }
  const proj = await loadProject(req.params.id, userId, false);
  if (!proj) { res.status(403).json({ error: "no access" }); return; }
  if (!UUID_RE.test(req.params.tripId)) { res.status(400).json({ error: "tripId invalid" }); return; }
  const own = await db.execute(sql`
    SELECT 1 FROM ps_trips WHERE id = ${req.params.tripId}::uuid AND project_id = ${req.params.id}::uuid
  `);
  if (!((own as any).rows ?? []).length) { res.status(404).json({ error: "trip not found" }); return; }
  const dvR = await db.execute(sql`
    SELECT day_type_id, is_valid FROM ps_trip_day_validity WHERE trip_id = ${req.params.tripId}::uuid
  `);
  const dayValidity: Record<string, boolean> = {};
  for (const r of (dvR as any).rows ?? []) dayValidity[r.day_type_id] = !!r.is_valid;
  const tcR = await db.execute(sql`
    SELECT category_id FROM ps_trip_category_validity WHERE trip_id = ${req.params.tripId}::uuid
  `);
  const categoryIds = ((tcR as any).rows ?? []).map((r: any) => r.category_id);
  res.json({ dayValidity, categoryIds });
});

/* ─── Validità BULK: giorni + categorie di N corse in una chiamata ───
 * Alimenta le colonne "Giorni" e "Categorie" della tabella Corse. */

router.post("/planning-studio/projects/:id/trips/validity-bulk", async (req, res): Promise<void> => {
  const userId = getUserId(req);
  if (!userId) { res.status(401).json({ error: "auth required" }); return; }
  const proj = await loadProject(req.params.id, userId, false);
  if (!proj) { res.status(403).json({ error: "no access" }); return; }
  const tripIds: string[] = (Array.isArray(req.body?.tripIds) ? req.body.tripIds : [])
    .filter((x: any) => typeof x === "string" && UUID_RE.test(x))
    .slice(0, 1000);
  if (tripIds.length === 0) { res.json({ dayValidity: {}, categories: {} }); return; }
  const idsLit = `{${tripIds.join(",")}}`;
  const dvR = await db.execute(sql`
    SELECT v.trip_id, v.day_type_id, v.is_valid
      FROM ps_trip_day_validity v
      JOIN ps_trips t ON t.id = v.trip_id
     WHERE v.trip_id = ANY(${idsLit}::uuid[]) AND t.project_id = ${req.params.id}::uuid
  `);
  const dayValidity: Record<string, Record<string, boolean>> = {};
  for (const r of (dvR as any).rows ?? []) {
    (dayValidity[r.trip_id] ??= {})[r.day_type_id] = !!r.is_valid;
  }
  const tcR = await db.execute(sql`
    SELECT c.trip_id, c.category_id
      FROM ps_trip_category_validity c
      JOIN ps_trips t ON t.id = c.trip_id
     WHERE c.trip_id = ANY(${idsLit}::uuid[]) AND t.project_id = ${req.params.id}::uuid
  `);
  const categories: Record<string, string[]> = {};
  for (const r of (tcR as any).rows ?? []) {
    (categories[r.trip_id] ??= []).push(r.category_id);
  }
  res.json({ dayValidity, categories });
});

/* ─── PATCH trip (estensione: validità, attivo, label, headsign, calendar) ─── */

router.patch("/planning-studio/projects/:id/trips/:tripId", async (req, res): Promise<void> => {
  const userId = getUserId(req);
  if (!userId) { res.status(401).json({ error: "auth required" }); return; }
  const proj = await loadProject(req.params.id, userId, true);
  if (!proj) { res.status(403).json({ error: "no write access" }); return; }
  if (!UUID_RE.test(req.params.tripId)) { res.status(400).json({ error: "tripId invalid" }); return; }

  const fields: string[] = [];
  const vals: any[] = [];
  const map: Record<string, string> = {
    headsign: "headsign",
    shortName: "short_name",
    direction: "direction",
    blockId: "block_id",
    calendarId: "calendar_id",
    validFrom: "valid_from",
    validTo: "valid_to",
    isActive: "is_active",
    serviceLabel: "service_label",
  };
  for (const [k, col] of Object.entries(map)) {
    if (k in req.body) { fields.push(col); vals.push(req.body[k]); }
  }
  // Merge di attributi jsonb (es. { onDemand: true } per le corse "a chiamata"):
  // NON sostituisce l'intero oggetto, aggiorna solo le chiavi indicate.
  const attrMerge = req.body.attributesMerge && typeof req.body.attributesMerge === "object"
    ? req.body.attributesMerge : null;
  if (fields.length === 0 && !attrMerge) { res.status(400).json({ error: "no fields to update" }); return; }

  // valid_from <= valid_to (se entrambi forniti)
  if (req.body.validFrom && req.body.validTo && new Date(req.body.validFrom) > new Date(req.body.validTo)) {
    res.status(400).json({ error: "validFrom must be ≤ validTo" }); return;
  }

  const parts = fields.map((f, i) => sql`${sql.raw(f)} = ${vals[i]}`);
  if (attrMerge) parts.push(sql`attributes = COALESCE(attributes, '{}'::jsonb) || ${JSON.stringify(attrMerge)}::jsonb`);
  const setSql = sql.join(parts, sql`, `);
  const r = await db.execute(sql`
    UPDATE ps_trips
       SET ${setSql}
     WHERE id = ${req.params.tripId}::uuid
       AND project_id = ${req.params.id}::uuid
     RETURNING *
  `);
  const row: any = (r as any).rows?.[0];
  if (!row) { res.status(404).json({ error: "trip not found" }); return; }
  await logActivity(req.params.id, userId, "trip.update", "trip", row.id, { fields });
  res.json({ trip: {
    id: row.id, projectId: row.project_id, routeId: row.route_id, variantId: row.variant_id,
    calendarId: row.calendar_id, headsign: row.headsign, shortName: row.short_name,
    direction: row.direction, blockId: row.block_id, attributes: row.attributes ?? {},
    validFrom: row.valid_from, validTo: row.valid_to,
    isActive: row.is_active, serviceLabel: row.service_label,
    createdAt: row.created_at,
  }});
});

/* ─── PATCH bulk (operazioni di massa per filtro variant/calendar) ─── */

router.post("/planning-studio/projects/:id/trips/bulk-update", async (req, res): Promise<void> => {
  const userId = getUserId(req);
  if (!userId) { res.status(401).json({ error: "auth required" }); return; }
  const proj = await loadProject(req.params.id, userId, true);
  if (!proj) { res.status(403).json({ error: "no write access" }); return; }

  const tripIds: string[] = Array.isArray(req.body?.tripIds) ? req.body.tripIds : [];
  if (tripIds.length === 0) { res.status(400).json({ error: "tripIds required" }); return; }
  if (tripIds.length > 500) { res.status(400).json({ error: "max 500 corse per richiesta" }); return; }
  if (tripIds.some(id => !UUID_RE.test(String(id)))) { res.status(400).json({ error: "tripIds invalid" }); return; }

  const patch = req.body?.patch ?? {};
  const fields: string[] = [];
  const vals: any[] = [];
  const map: Record<string, string> = {
    calendarId: "calendar_id",
    validFrom: "valid_from",
    validTo: "valid_to",
    isActive: "is_active",
    serviceLabel: "service_label",
  };
  for (const [k, col] of Object.entries(map)) {
    if (k in patch) { fields.push(col); vals.push(patch[k]); }
  }
  const attrMerge = patch.attributesMerge && typeof patch.attributesMerge === "object"
    ? patch.attributesMerge : null;
  if (fields.length === 0 && !attrMerge) { res.status(400).json({ error: "no fields to update" }); return; }

  const idsSql = sql.join(tripIds.map(id => sql`${id}::uuid`), sql`, `);
  const parts = fields.map((f, i) => sql`${sql.raw(f)} = ${vals[i]}`);
  if (attrMerge) parts.push(sql`attributes = COALESCE(attributes, '{}'::jsonb) || ${JSON.stringify(attrMerge)}::jsonb`);
  const setSql = sql.join(parts, sql`, `);
  const r = await db.execute(sql`
    UPDATE ps_trips
       SET ${setSql}
     WHERE project_id = ${req.params.id}::uuid
       AND id IN (${idsSql})
     RETURNING id
  `);
  const count = ((r as any).rows ?? []).length;
  await logActivity(req.params.id, userId, "trip.bulk_update", "trip", null, { count, fields });
  res.json({ ok: true, count });
});

/* ─── DELETE bulk (elimina N corse selezionate; stop_times/validità in cascata) ─── */

router.post("/planning-studio/projects/:id/trips/bulk-delete", async (req, res): Promise<void> => {
  const userId = getUserId(req);
  if (!userId) { res.status(401).json({ error: "auth required" }); return; }
  const proj = await loadProject(req.params.id, userId, true);
  if (!proj) { res.status(403).json({ error: "no write access" }); return; }

  const tripIds: string[] = Array.isArray(req.body?.tripIds) ? req.body.tripIds : [];
  if (tripIds.length === 0) { res.status(400).json({ error: "tripIds required" }); return; }
  if (tripIds.length > 500) { res.status(400).json({ error: "max 500 corse per richiesta" }); return; }
  if (tripIds.some(id => !UUID_RE.test(String(id)))) { res.status(400).json({ error: "tripIds invalid" }); return; }

  const idsSql = sql.join(tripIds.map(id => sql`${id}::uuid`), sql`, `);
  const r = await db.execute(sql`
    DELETE FROM ps_trips
     WHERE project_id = ${req.params.id}::uuid
       AND id IN (${idsSql})
     RETURNING id
  `);
  const deleted: string[] = ((r as any).rows ?? []).map((row: any) => row.id);
  // ps_trip_category_validity non ha FK con cascata: pulizia esplicita
  if (deleted.length > 0) {
    const delSql = sql.join(deleted.map(id => sql`${id}::uuid`), sql`, `);
    await db.execute(sql`DELETE FROM ps_trip_category_validity WHERE trip_id IN (${delSql})`);
  }
  const count = deleted.length;
  await logActivity(req.params.id, userId, "trip.bulk_delete", "trip", null, { count });
  res.json({ ok: true, count });
});

/* ─── Helper orari HH:MM:SS (consente >24:00 per corse dopo mezzanotte) ─── */

const HHMMSS_RE = /^\d{1,2}:[0-5]\d:[0-5]\d$/;

function hmsToSec(t: string): number {
  const [h, m, s] = t.split(":").map(Number);
  return (h || 0) * 3600 + (m || 0) * 60 + (s || 0);
}
function secToHms(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

/* ─── SHIFT corsa: trasla tutti gli orari del trip di ±N minuti ───
 * Usato dall'orario grafico (drag orizzontale di una corsa nel diagramma
 * tempo-distanza). Aggiorna in blocco tutti i ps_stop_times del trip. */

router.post("/planning-studio/projects/:id/trips/:tripId/shift", async (req, res): Promise<void> => {
  const userId = getUserId(req);
  if (!userId) { res.status(401).json({ error: "auth required" }); return; }
  const proj = await loadProject(req.params.id, userId, true);
  if (!proj) { res.status(403).json({ error: "no write access" }); return; }
  if (!UUID_RE.test(req.params.tripId)) { res.status(400).json({ error: "tripId invalid" }); return; }

  const deltaMinutes = Number(req.body?.deltaMinutes);
  if (!Number.isInteger(deltaMinutes) || deltaMinutes === 0 || Math.abs(deltaMinutes) > 1440) {
    res.status(400).json({ error: "deltaMinutes deve essere un intero non nullo tra -1440 e 1440" }); return;
  }

  // Verifica che il trip appartenga al progetto
  const tr = await db.execute(sql`
    SELECT id FROM ps_trips
     WHERE id = ${req.params.tripId}::uuid AND project_id = ${req.params.id}::uuid
  `);
  if (!((tr as any).rows ?? []).length) { res.status(404).json({ error: "trip not found" }); return; }

  const r = await db.execute(sql`
    SELECT stop_seq, arrival_time, departure_time
      FROM ps_stop_times
     WHERE trip_id = ${req.params.tripId}::uuid
     ORDER BY stop_seq ASC
  `);
  const rows: any[] = (r as any).rows ?? [];
  if (rows.length === 0) { res.status(400).json({ error: "il trip non ha stop_times" }); return; }

  const deltaSec = deltaMinutes * 60;
  // Calcola i nuovi orari e rifiuta se uno scenderebbe sotto 00:00:00
  const updated = rows.map(row => ({
    stopSeq: row.stop_seq,
    arrivalTime: hmsToSec(row.arrival_time) + deltaSec,
    departureTime: hmsToSec(row.departure_time) + deltaSec,
  }));
  if (updated.some(u => u.arrivalTime < 0 || u.departureTime < 0)) {
    res.status(400).json({ error: "lo shift porterebbe orari negativi (prima di 00:00)" }); return;
  }

  for (const u of updated) {
    await db.execute(sql`
      UPDATE ps_stop_times
         SET arrival_time = ${secToHms(u.arrivalTime)},
             departure_time = ${secToHms(u.departureTime)}
       WHERE trip_id = ${req.params.tripId}::uuid AND stop_seq = ${u.stopSeq}
    `);
  }
  await logActivity(req.params.id, userId, "trip.shift", "trip", req.params.tripId, { deltaMinutes, count: updated.length });
  res.json({ ok: true, count: updated.length, deltaMinutes });
});

/* ─── BATCH CREATE corse: crea N trip con i rispettivi stop_times ───
 * Usato dall'orario grafico per il cadenzamento ("moltiplica corsa"):
 * il client genera N corse traslando il profilo tempi di una corsa base. */

router.post("/planning-studio/projects/:id/trips/batch-create", async (req, res): Promise<void> => {
  const userId = getUserId(req);
  if (!userId) { res.status(401).json({ error: "auth required" }); return; }
  const proj = await loadProject(req.params.id, userId, true);
  if (!proj) { res.status(403).json({ error: "no write access" }); return; }

  const trips: any[] = Array.isArray(req.body?.trips) ? req.body.trips : [];
  if (trips.length === 0) { res.status(400).json({ error: "trips required" }); return; }
  if (trips.length > 200) { res.status(400).json({ error: "massimo 200 corse per batch" }); return; }

  // Validazione preventiva di tutto il batch (o tutto o niente)
  const routeIds = new Set<string>(), variantIds = new Set<string>(), stopIds = new Set<string>(), calendarIds = new Set<string>();
  for (const t of trips) {
    if (!UUID_RE.test(String(t?.routeId ?? "")) || !UUID_RE.test(String(t?.variantId ?? ""))) {
      res.status(400).json({ error: "routeId e variantId obbligatori per ogni corsa" }); return;
    }
    routeIds.add(t.routeId); variantIds.add(t.variantId);
    if (t.calendarId != null) {
      if (!UUID_RE.test(String(t.calendarId))) { res.status(400).json({ error: "calendarId non valido" }); return; }
      calendarIds.add(t.calendarId);
    }
    const sts: any[] = Array.isArray(t?.stopTimes) ? t.stopTimes : [];
    if (sts.length < 2) { res.status(400).json({ error: "ogni corsa richiede almeno 2 stopTimes" }); return; }
    for (const st of sts) {
      if (!UUID_RE.test(String(st?.stopId ?? ""))) {
        res.status(400).json({ error: "stopId non valido negli stopTimes" }); return;
      }
      stopIds.add(st.stopId);
      if (!HHMMSS_RE.test(String(st?.arrivalTime ?? "")) || !HHMMSS_RE.test(String(st?.departureTime ?? ""))) {
        res.status(400).json({ error: "arrivalTime/departureTime devono essere HH:MM:SS" }); return;
      }
    }
  }

  // IDOR fix (cross-project FK): tutte le entità referenziate DEVONO appartenere
  // a QUESTO progetto. Senza, un editor potrebbe legare le sue corse alle
  // route/variant/stop private di un altro progetto (FK globali single-column).
  const projId = req.params.id;
  const belongCheck = async (table: string, ids: Set<string>): Promise<boolean> => {
    if (ids.size === 0) return true;
    const lit = `{${[...ids].join(",")}}`;
    const r = await db.execute(sql`SELECT count(*)::int AS c FROM ${sql.raw(table)} WHERE id = ANY(${lit}::uuid[]) AND project_id = ${projId}::uuid`);
    return Number((r as any).rows?.[0]?.c) === ids.size;
  };
  if (!(await belongCheck("ps_routes", routeIds))
      || !(await belongCheck("ps_route_variants", variantIds))
      || !(await belongCheck("ps_stops", stopIds))
      || !(await belongCheck("ps_calendars", calendarIds))) {
    res.status(400).json({ error: "Riferimenti (linea/percorso/fermata/calendario) non appartenenti al progetto" }); return;
  }

  // Transazione: o tutte le corse+orari o nessuna (niente corse orfane su errore).
  const tripIds: string[] = [];
  await db.transaction(async (tx) => {
    for (const t of trips) {
      const ins = await tx.execute(sql`
        INSERT INTO ps_trips (project_id, route_id, variant_id, calendar_id,
                              headsign, short_name, direction, block_id, attributes, service_label)
        VALUES (${projId}::uuid, ${t.routeId}::uuid, ${t.variantId}::uuid,
                ${t.calendarId ?? null}, ${t.headsign ?? null}, ${t.shortName ?? null},
                ${t.direction ?? 0}, ${t.blockId ?? null},
                ${JSON.stringify(t.attributes ?? {})}::jsonb, ${t.serviceLabel ?? null})
        RETURNING id
      `);
      const tripId: string = ((ins as any).rows?.[0])?.id;
      let seq = 1;
      for (const st of t.stopTimes) {
        await tx.execute(sql`
          INSERT INTO ps_stop_times (trip_id, stop_seq, stop_id, arrival_time, departure_time,
                                     pickup_type, drop_off_type, timepoint, shape_dist_traveled)
          VALUES (${tripId}::uuid, ${seq}, ${String(st.stopId)}::uuid,
                  ${st.arrivalTime}, ${st.departureTime},
                  ${st.pickupType ?? 0}, ${st.dropOffType ?? 0},
                  ${st.timepoint ?? 1}, ${st.shapeDistTraveled ?? null})
        `);
        seq++;
      }
      tripIds.push(tripId);
    }
  });
  await logActivity(req.params.id, userId, "trip.batch_create", "trip", null, { count: tripIds.length });
  res.status(201).json({ ok: true, count: tripIds.length, tripIds });
});

/* ─── Eccezioni date ─── */

router.get("/planning-studio/projects/:id/trips/:tripId/exceptions", async (req, res): Promise<void> => {
  const userId = getUserId(req);
  if (!userId) { res.status(401).json({ error: "auth required" }); return; }
  const proj = await loadProject(req.params.id, userId, false);
  if (!proj) { res.status(404).json({ error: "project not found" }); return; }

  const r = await db.execute(sql`
    SELECT trip_id, date, exception_type, reason
      FROM ps_trip_exceptions
     WHERE trip_id = ${req.params.tripId}::uuid
     ORDER BY date ASC
  `);
  const rows: any[] = (r as any).rows ?? [];
  res.json({
    exceptions: rows.map(e => ({
      tripId: e.trip_id,
      date: e.date,
      exceptionType: e.exception_type,
      reason: e.reason,
    })),
  });
});

router.post("/planning-studio/projects/:id/trips/:tripId/exceptions", async (req, res): Promise<void> => {
  const userId = getUserId(req);
  if (!userId) { res.status(401).json({ error: "auth required" }); return; }
  const proj = await loadProject(req.params.id, userId, true);
  if (!proj) { res.status(403).json({ error: "no write access" }); return; }

  const { date, exceptionType = 2, reason = null } = req.body ?? {};
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    res.status(400).json({ error: "date YYYY-MM-DD required" }); return;
  }
  if (exceptionType !== 1 && exceptionType !== 2) {
    res.status(400).json({ error: "exceptionType must be 1 (added) or 2 (removed)" }); return;
  }

  await db.execute(sql`
    INSERT INTO ps_trip_exceptions (trip_id, date, exception_type, reason)
    VALUES (${req.params.tripId}::uuid, ${date}, ${exceptionType}, ${reason})
    ON CONFLICT (trip_id, date) DO UPDATE
      SET exception_type = EXCLUDED.exception_type,
          reason = EXCLUDED.reason
  `);
  await logActivity(req.params.id, userId, "trip.exception.add", "trip", req.params.tripId, { date, exceptionType });
  res.status(201).json({ ok: true });
});

router.delete("/planning-studio/projects/:id/trips/:tripId/exceptions/:date", async (req, res): Promise<void> => {
  const userId = getUserId(req);
  if (!userId) { res.status(401).json({ error: "auth required" }); return; }
  const proj = await loadProject(req.params.id, userId, true);
  if (!proj) { res.status(403).json({ error: "no write access" }); return; }

  const date = req.params.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    res.status(400).json({ error: "date YYYY-MM-DD required" }); return;
  }
  await db.execute(sql`
    DELETE FROM ps_trip_exceptions
     WHERE trip_id = ${req.params.tripId}::uuid AND date = ${date}
  `);
  await logActivity(req.params.id, userId, "trip.exception.remove", "trip", req.params.tripId, { date });
  res.json({ ok: true });
});

export default router;
