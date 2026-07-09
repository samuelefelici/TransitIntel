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

// Chiavi jsonb scrivibili via attributesMerge: solo flag business noti, tipizzati.
// Evita che un client inietti chiavi arbitrarie (o sovrascriva flag interpretati
// dal sistema con tipi sbagliati) nel campo attributes della corsa.
function sanitizeAttrMerge(input: any): Record<string, any> | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const out: Record<string, any> = {};
  if ("prototype" in input) out.prototype = !!input.prototype;
  // prototypeReady: il prototipo ha orari reali inseriti a mano → "Corsa MADRE",
  // lo step successivo in attesa di essere moltiplicato a cadenza.
  if ("prototypeReady" in input) out.prototypeReady = !!input.prototypeReady;
  if ("onDemand" in input) out.onDemand = !!input.onDemand;
  if ("weekdays" in input && Array.isArray(input.weekdays) && input.weekdays.length === 7) {
    out.weekdays = input.weekdays.map((x: any) => x !== false);
  }
  return Object.keys(out).length > 0 ? out : null;
}

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
  const attrMerge = sanitizeAttrMerge(req.body.attributesMerge);
  if (fields.length === 0 && !attrMerge) { res.status(400).json({ error: "no fields to update" }); return; }

  // valid_from <= valid_to (se entrambi forniti)
  if (req.body.validFrom && req.body.validTo && new Date(req.body.validFrom) > new Date(req.body.validTo)) {
    res.status(400).json({ error: "validFrom must be ≤ validTo" }); return;
  }

  const parts = fields.map((f, i) => sql`${sql.raw(f)} = ${vals[i]}`);
  if (attrMerge) parts.push(sql`attributes = COALESCE(attributes, '{}'::jsonb) || ${JSON.stringify(attrMerge)}::jsonb`);
  // marca le corse come modificate: l'auto-refresh delle categorie del
  // calendario aziendale risincronizza solo le corse toccate dopo l'ultimo sync
  parts.push(sql`updated_at = now()`);
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
  const attrMerge = sanitizeAttrMerge(patch.attributesMerge);
  if (fields.length === 0 && !attrMerge) { res.status(400).json({ error: "no fields to update" }); return; }

  const idsSql = sql.join(tripIds.map(id => sql`${id}::uuid`), sql`, `);
  const parts = fields.map((f, i) => sql`${sql.raw(f)} = ${vals[i]}`);
  if (attrMerge) parts.push(sql`attributes = COALESCE(attributes, '{}'::jsonb) || ${JSON.stringify(attrMerge)}::jsonb`);
  // marca le corse come modificate: l'auto-refresh delle categorie del
  // calendario aziendale risincronizza solo le corse toccate dopo l'ultimo sync
  parts.push(sql`updated_at = now()`);
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
  if (tripIds.length > 5000) { res.status(400).json({ error: "max 5000 corse per richiesta" }); return; }
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

  // EREDITÀ VALIDITÀ: le corse generate dal grafico (copia/cadenzamento)
  // ereditano day-type (feriale/sabato/festivo) e macro-categorie del
  // calendario aziendale dalla corsa base — altrimenti nascono "senza
  // validità" e spariscono da tutte le viste filtrate (Corse, TTD, stampe).
  // Best-effort fuori transazione: le tabelle possono non esistere ancora.
  for (let i = 0; i < trips.length; i++) {
    const baseId = String(trips[i]?.baseTripId ?? "");
    if (!UUID_RE.test(baseId)) continue;
    try {
      const own = await db.execute(sql`
        SELECT 1 FROM ps_trips WHERE id = ${baseId}::uuid AND project_id = ${projId}::uuid LIMIT 1`);
      if (!((own as any).rows?.length)) continue;
      await db.execute(sql`
        INSERT INTO ps_trip_day_validity (trip_id, day_type_id, is_valid)
        SELECT ${tripIds[i]}::uuid, day_type_id, is_valid
          FROM ps_trip_day_validity WHERE trip_id = ${baseId}::uuid
        ON CONFLICT DO NOTHING`);
      await db.execute(sql`
        INSERT INTO ps_trip_category_validity (trip_id, category_id)
        SELECT ${tripIds[i]}::uuid, category_id
          FROM ps_trip_category_validity WHERE trip_id = ${baseId}::uuid
        ON CONFLICT DO NOTHING`);
    } catch { /* validità non configurata sul progetto: nessuna eredità */ }
  }

  await logActivity(req.params.id, userId, "trip.batch_create", "trip", null, { count: tripIds.length });
  res.status(201).json({ ok: true, count: tripIds.length, tripIds });
});

/* ─── PROTOTIPI PER I PERCORSI SENZA CORSE ─────────────────────────────────
 * Caso d'uso: import GTFS con TUTTE le corse poi cancellate (o percorsi
 * disegnati a mano). Le varianti restano senza alcuna corsa: manca il template
 * da cui far partire «Genera a cadenza».
 *
 * Questo endpoint crea automaticamente una CORSA ZERO (prototipo) per OGNI
 * variante del progetto che ha ≥2 fermate e NESSUNA corsa. I tempi per arco
 * sono calcolati dalle distanze (shape_dist_traveled se coerente, altrimenti
 * Haversine da lat/lon) a una velocità commerciale di default; gli orari sono
 * ancorati a 00:00 (è un prototipo: nessun orario reale, non genera km, escluso
 * dalle UDP) e la validità è impostata a feriale. Da qui l'utente genera le
 * corse reali con «Genera a cadenza».
 *
 * Body (tutti opzionali): { variantIds?, speedKmh=18, dwellSec=0, dayTypeCode="feriale" }
 * ──────────────────────────────────────────────────────────────────────── */
router.post("/planning-studio/projects/:id/trips/prototype-missing", async (req, res): Promise<void> => {
  const userId = getUserId(req);
  if (!userId) { res.status(401).json({ error: "auth required" }); return; }
  const proj = await loadProject(req.params.id, userId, true);
  if (!proj) { res.status(403).json({ error: "no write access" }); return; }
  const projId = req.params.id;

  const speedKmh = Math.min(120, Math.max(3, Number(req.body?.speedKmh) || 18));
  const dwellSec = Math.min(600, Math.max(0, Math.round(Number(req.body?.dwellSec) || 0)));
  const dayTypeCode = typeof req.body?.dayTypeCode === "string" && req.body.dayTypeCode.trim()
    ? req.body.dayTypeCode.trim() : "feriale";
  const restrict: string[] | null = Array.isArray(req.body?.variantIds)
    ? req.body.variantIds.filter((x: any) => UUID_RE.test(String(x))) : null;
  const restrictLit = restrict && restrict.length ? `{${restrict.join(",")}}` : null;

  // varianti del progetto con ≥2 fermate e NESSUNA corsa
  const cand = await db.execute(sql`
    SELECT v.id, v.route_id, v.name, v.headsign, v.direction
      FROM ps_route_variants v
     WHERE v.project_id = ${projId}::uuid
       ${restrictLit ? sql`AND v.id = ANY(${restrictLit}::uuid[])` : sql``}
       AND (SELECT count(*) FROM ps_variant_stops vs WHERE vs.variant_id = v.id) >= 2
       AND NOT EXISTS (SELECT 1 FROM ps_trips t WHERE t.variant_id = v.id AND t.project_id = ${projId}::uuid)
     ORDER BY v.name`);
  const variants: any[] = (cand as any).rows ?? [];
  if (variants.length === 0) { res.json({ ok: true, created: 0, tripIds: [], variants: [] }); return; }

  // feriale: day-type custom del progetto se esiste, altrimenti globale
  const dtR = await db.execute(sql`
    SELECT id FROM ps_day_types
     WHERE code = ${dayTypeCode} AND (project_id = ${projId}::uuid OR project_id IS NULL)
     ORDER BY (project_id IS NOT NULL) DESC LIMIT 1`);
  const dayTypeId: string | null = (dtR as any).rows?.[0]?.id ?? null;

  const mps = Math.max(1, speedKmh * 1000 / 3600);
  const hms = (s: number) => {
    const t = Math.max(0, Math.round(s));
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), ss = t % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
  };
  const R = 6371000, rad = (d: number) => d * Math.PI / 180;

  const createdTripIds: string[] = [];
  const perVariant: { variantId: string; name: string; tripId: string; stops: number; giroMin: number }[] = [];

  await db.transaction(async (tx) => {
    for (const v of variants) {
      const sr = await tx.execute(sql`
        SELECT vs.seq, vs.stop_id, vs.timepoint, vs.shape_dist_traveled AS sdt, s.lat, s.lon
          FROM ps_variant_stops vs JOIN ps_stops s ON s.id = vs.stop_id
         WHERE vs.variant_id = ${v.id}::uuid ORDER BY vs.seq`);
      const st: any[] = (sr as any).rows ?? [];
      if (st.length < 2) continue;

      // distanze cumulate: shape_dist_traveled se valido e monotòno, altrimenti Haversine
      const sdt = st.map(r => (r.sdt == null ? null : Number(r.sdt)));
      const sdtOk = sdt.every(d => d != null && Number.isFinite(d))
        && sdt.every((d, i) => i === 0 || (d as number) >= (sdt[i - 1] as number))
        && (sdt[sdt.length - 1] as number) > (sdt[0] as number);
      const cum: number[] = [0];
      if (sdtOk) {
        const base = sdt[0] as number;
        for (let i = 0; i < st.length; i++) cum[i] = (sdt[i] as number) - base;
      } else {
        for (let i = 1; i < st.length; i++) {
          const a = st[i - 1], b = st[i];
          const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
          const hv = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
          cum[i] = cum[i - 1] + 2 * R * Math.atan2(Math.sqrt(hv), Math.sqrt(1 - hv));
        }
      }
      // tempi ancorati a 00:00 (arco ≥ 30s), sosta solo alle fermate intermedie
      const arr: number[] = [0], dep: number[] = [0];
      for (let i = 1; i < st.length; i++) {
        const arcSec = Math.max(30, Math.round((cum[i] - cum[i - 1]) / mps));
        arr[i] = dep[i - 1] + arcSec;
        dep[i] = (i === st.length - 1) ? arr[i] : arr[i] + dwellSec;
      }

      const ins = await tx.execute(sql`
        INSERT INTO ps_trips (project_id, route_id, variant_id, calendar_id, headsign, direction, attributes)
        VALUES (${projId}::uuid, ${v.route_id}::uuid, ${v.id}::uuid, NULL,
                ${v.headsign ?? null}, ${v.direction ?? 0}, ${JSON.stringify({ prototype: true })}::jsonb)
        RETURNING id`);
      const tripId: string = (ins as any).rows?.[0]?.id;
      let seq = 1;
      for (let i = 0; i < st.length; i++) {
        await tx.execute(sql`
          INSERT INTO ps_stop_times (trip_id, stop_seq, stop_id, arrival_time, departure_time, timepoint)
          VALUES (${tripId}::uuid, ${seq}, ${String(st[i].stop_id)}::uuid,
                  ${hms(arr[i])}, ${hms(dep[i])}, ${st[i].timepoint ?? 1})`);
        seq++;
      }
      createdTripIds.push(tripId);
      perVariant.push({ variantId: v.id, name: v.name, tripId, stops: st.length, giroMin: Math.round(arr[st.length - 1] / 60) });
    }
  });

  // validità feriale: best-effort FUORI transazione (la matrice di validità ha
  // bootstrap lazy → non deve far abortire la creazione dei prototipi).
  if (dayTypeId && createdTripIds.length) {
    try {
      const lit = `{${createdTripIds.join(",")}}`;
      await db.execute(sql`
        INSERT INTO ps_trip_day_validity (trip_id, day_type_id, is_valid)
        SELECT tid, ${dayTypeId}::uuid, true FROM unnest(${lit}::uuid[]) AS tid
        ON CONFLICT DO NOTHING`);
    } catch { /* matrice validità non ancora inizializzata sul progetto */ }
  }

  await logActivity(projId, userId, "trip.prototype_missing", "trip", null, { created: createdTripIds.length });
  res.status(201).json({ ok: true, created: createdTripIds.length, tripIds: createdTripIds, variants: perVariant });
});

/* ─── UNIFICA CORSE GEMELLE (merge-twins) ─────────────────────────────────
 * Dopo un import GTFS la stessa partenza (stesso percorso, stessi orari a tutte
 * le fermate, stesso headsign) può esistere come PIÙ corse, una per service_id
 * (es. lun-ven + sabato). Sono un artefatto dell'import: nel modello a valle
 * (matrice di validità + UDP) una sola corsa può valere su più giorni, e la
 * UDP la distribuisce da sola sui vari tipi-giorno.
 *
 * Fondere è corretto E sicuro purché la corsa fusa punti a un CALENDARIO
 * UNIONE (lun-ven ∪ sabato = lun-sab): così restano coerenti la
 * materializzazione UDP→feed (service = calendar_id → pattern ps_calendars),
 * la sync categorie (usa il pattern del calendario) e le UDP.
 *
 * ?dryRun=1 (o body.dryRun) → SOLO anteprima, nessuna scrittura.
 * ────────────────────────────────────────────────────────────────────────── */
router.post("/planning-studio/projects/:id/trips/merge-twins", async (req, res): Promise<void> => {
  const userId = getUserId(req);
  if (!userId) { res.status(401).json({ error: "auth required" }); return; }
  const proj = await loadProject(req.params.id, userId, true);
  if (!proj) { res.status(403).json({ error: "no write access" }); return; }
  const projId = req.params.id;
  const dryRun = req.query.dryRun === "1" || req.query.dryRun === "true" || req.body?.dryRun === true;
  const routeId = typeof req.body?.routeId === "string" && UUID_RE.test(req.body.routeId) ? req.body.routeId : null;

  // 1. Corse candidate (attive, non prototipo) + orari
  const tripsR = await db.execute<any>(sql`
    SELECT t.id, t.variant_id, t.calendar_id, t.headsign, t.short_name, t.direction,
           to_char(t.valid_from,'YYYY-MM-DD') AS valid_from,
           to_char(t.valid_to,'YYYY-MM-DD') AS valid_to,
           t.attributes, t.created_at
      FROM ps_trips t
     WHERE t.project_id = ${projId}::uuid
       AND COALESCE(t.is_active, true) = true
       AND COALESCE((t.attributes->>'prototype')::boolean, false) = false
       ${routeId ? sql`AND t.route_id = ${routeId}::uuid` : sql``}
     ORDER BY t.created_at ASC, t.id ASC
  `);
  const trips: any[] = tripsR.rows ?? [];
  if (trips.length === 0) { res.json({ dryRun, groups: [], tripsBefore: 0, tripsAfter: 0, removed: 0 }); return; }

  const tripIds = trips.map(t => t.id);
  const stR = await db.execute<any>(sql`
    SELECT trip_id, stop_seq, stop_id, arrival_time, departure_time
      FROM ps_stop_times
     WHERE trip_id = ANY(${`{${tripIds.join(",")}}`}::uuid[])
     ORDER BY trip_id, stop_seq ASC
  `);
  const stByTrip = new Map<string, string[]>();
  for (const r of stR.rows ?? []) {
    const arr = stByTrip.get(r.trip_id) ?? [];
    arr.push(`${r.stop_id}@${String(r.arrival_time).slice(0, 8)}/${String(r.departure_time).slice(0, 8)}`);
    stByTrip.set(r.trip_id, arr);
  }

  // Categorie di validità (calendario aziendale) per corsa → per mostrare nel
  // preview l'UNIONE che risulterà sulla corsa fusa.
  const catByTrip = new Map<string, Array<{ name: string; code: string; color: string | null }>>();
  {
    const tcR = await db.execute<any>(sql`
      SELECT tc.trip_id, c.name, c.code, c.color
        FROM ps_trip_category_validity tc
        JOIN ps_validity_categories c ON c.id = tc.category_id
       WHERE tc.trip_id = ANY(${`{${tripIds.join(",")}}`}::uuid[])`);
    for (const r of tcR.rows ?? []) {
      const arr = catByTrip.get(r.trip_id) ?? [];
      arr.push({ name: r.name, code: r.code, color: r.color });
      catByTrip.set(r.trip_id, arr);
    }
  }

  // 2. Raggruppa per FIRMA: variante + headsign + orari esatti a tutte le fermate
  const groups = new Map<string, any[]>();
  for (const t of trips) {
    const sts = stByTrip.get(t.id);
    if (!sts || sts.length < 2) continue; // senza orari non è gemella affidabile
    const sig = `${t.variant_id}|${(t.headsign ?? "").trim().toLowerCase()}|${sts.join(">")}`;
    const arr = groups.get(sig) ?? [];
    arr.push(t);
    groups.set(sig, arr);
  }
  const mergeGroups = [...groups.values()].filter(g => g.length >= 2);

  // 3. Calendari sorgente (pattern effettivo per l'unione)
  const calIds = new Set<string>();
  for (const g of mergeGroups) for (const t of g) if (t.calendar_id) calIds.add(t.calendar_id);
  const calById = new Map<string, any>();
  if (calIds.size > 0) {
    const cR = await db.execute<any>(sql`
      SELECT id, monday, tuesday, wednesday, thursday, friday, saturday, sunday,
             to_char(start_date,'YYYY-MM-DD') AS start_date, to_char(end_date,'YYYY-MM-DD') AS end_date
        FROM ps_calendars WHERE id = ANY(${`{${[...calIds].join(",")}}`}::uuid[])
    `);
    for (const c of cR.rows ?? []) calById.set(c.id, c);
  }
  // giorni-settimana EFFETTIVI dei calendari "solo date" (flag tutti false ma
  // con calendar_dates): senza questo la maschera unione uscirebbe vuota per i
  // feed GTFS a date → la corsa fusa perderebbe TUTTI i giorni.
  const dowByCal = new Map<string, boolean[]>();
  if (calIds.size > 0) {
    const dR = await db.execute<any>(sql`
      SELECT calendar_id, EXTRACT(ISODOW FROM date)::int AS isodow
        FROM ps_calendar_dates
       WHERE calendar_id = ANY(${`{${[...calIds].join(",")}}`}::uuid[]) AND exception_type = 1
       GROUP BY calendar_id, EXTRACT(ISODOW FROM date)
    `);
    for (const r of dR.rows ?? []) {
      const arr = dowByCal.get(r.calendar_id) ?? [false, false, false, false, false, false, false];
      arr[(Number(r.isodow) - 1) % 7] = true; // ISODOW 1=Lun … 7=Dom → idx 0..6
      dowByCal.set(r.calendar_id, arr);
    }
  }
  const DOW = ["monday","tuesday","wednesday","thursday","friday","saturday","sunday"] as const;
  const WD_LABEL = ["Lun","Mar","Mer","Gio","Ven","Sab","Dom"];
  /** copertura settimanale EFFETTIVA di una corsa: maschera esplicita, oppure
   *  flag del calendario, oppure giorni dei calendar_dates, oppure tutti. */
  const effWeekdaysOf = (t: any): boolean[] => {
    const m = (t.attributes as any)?.weekdays;
    if (Array.isArray(m) && m.length === 7) return m.map((x: any) => x !== false);
    const c = t.calendar_id ? calById.get(t.calendar_id) : null;
    if (c) {
      const flags = DOW.map(d => !!c[d]);
      if (flags.some(Boolean)) return flags;
      const dow = dowByCal.get(t.calendar_id);
      if (dow && dow.some(Boolean)) return dow;
    }
    return [true, true, true, true, true, true, true]; // nessuna info → non restringere
  };

  // costruisce la descrizione del gruppo + il piano di unione
  const plans = mergeGroups.map(g => {
    const primary = g[0]; // già ordinato per created_at, id
    const others = g.slice(1);
    // effWd = copertura settimanale EFFETTIVA unione (per la maschera della
    // corsa fusa; mai tutta spenta). calFlags = solo FLAG dei calendari (per il
    // calendario-unione, così i feed a date restano a date, non diventano
    // settimanali). minStart/maxEnd/anyCal per il calendario-unione.
    const effWd = [false, false, false, false, false, false, false];
    const calFlags = [false, false, false, false, false, false, false];
    let minStart: string | null = null, maxEnd: string | null = null;
    let anyCal = false;
    const srcCalIds = new Set<string>();
    for (const t of g) {
      effWeekdaysOf(t).forEach((on, i) => { if (on) effWd[i] = true; });
      const c = t.calendar_id ? calById.get(t.calendar_id) : null;
      if (!c) continue;
      anyCal = true;
      srcCalIds.add(t.calendar_id);
      DOW.forEach((d, i) => { if (c[d]) calFlags[i] = true; });
      if (c.start_date && (!minStart || c.start_date < minStart)) minStart = c.start_date;
      if (c.end_date && (!maxEnd || c.end_date > maxEnd)) maxEnd = c.end_date;
    }
    // periodo di validità corsa (valid_from/to): null in QUALSIASI sorgente = illimitato
    const anyNullFrom = g.some(t => !t.valid_from);
    const anyNullTo = g.some(t => !t.valid_to);
    const vFrom = anyNullFrom ? null : g.map(t => t.valid_from).sort()[0];
    const vTo = anyNullTo ? null : g.map(t => t.valid_to).sort().slice(-1)[0];
    const st0 = stByTrip.get(primary.id)![0];
    const dep = st0.split("@")[1]?.split("/")[1]?.slice(0, 5) ?? "";
    // unione categorie di validità di tutte le corse del gruppo (dedup per codice)
    const catMap = new Map<string, { name: string; code: string; color: string | null }>();
    for (const t of g) for (const c of catByTrip.get(t.id) ?? []) if (!catMap.has(c.code)) catMap.set(c.code, c);
    const unionCategories = [...catMap.values()].sort((a, b) => a.name.localeCompare(b.name, "it"));
    return {
      primaryId: primary.id,
      unionCategories,
      removeIds: others.map(t => t.id),
      variantId: primary.variant_id,
      headsign: primary.headsign,
      departure: dep,
      count: g.length,
      unionWeekdays: effWd,
      calFlags,
      srcCalIds: [...srcCalIds].sort(),
      unionWeekdaysLabel: effWd.map((on, i) => on ? WD_LABEL[i] : null).filter(Boolean).join(" "),
      unionStart: minStart, unionEnd: maxEnd, anyCal,
      validFrom: vFrom, validTo: vTo,
    };
  });

  if (dryRun) {
    res.json({
      dryRun: true,
      groups: plans,
      tripsBefore: trips.length,
      tripsAfter: trips.length - plans.reduce((s, p) => s + p.removeIds.length, 0),
      removed: plans.reduce((s, p) => s + p.removeIds.length, 0),
    });
    return;
  }

  // 4. APPLICA in transazione
  let removed = 0;
  const unionCalCache = new Map<string, string>(); // firma pattern+range → calendarId
  await db.transaction(async (tx) => {
    for (const p of plans) {
      const srcCalIds = p.srcCalIds;
      let unionCalId: string | null = null;

      if (p.anyCal) {
        // riusa lo stesso calendario-unione per gruppi con gli STESSI calendari
        // sorgente (evita di crearne uno per ogni gruppo)
        const sigCal = srcCalIds.join(",");
        unionCalId = unionCalCache.get(sigCal) ?? null;
        if (!unionCalId) {
          const ins = await tx.execute<any>(sql`
            INSERT INTO ps_calendars (project_id, code, name, monday, tuesday, wednesday,
                                      thursday, friday, saturday, sunday, start_date, end_date)
            VALUES (${projId}::uuid, ${`U-${p.calFlags.map(b => b ? 1 : 0).join("")}-${p.departure.replace(":", "")}`}, ${"Unione corse gemelle"},
                    ${p.calFlags[0]}, ${p.calFlags[1]}, ${p.calFlags[2]}, ${p.calFlags[3]},
                    ${p.calFlags[4]}, ${p.calFlags[5]}, ${p.calFlags[6]},
                    ${p.unionStart ?? p.validFrom ?? "2020-01-01"}::date, ${p.unionEnd ?? p.validTo ?? "2030-12-31"}::date)
            RETURNING id
          `);
          unionCalId = ins.rows[0].id;
          unionCalCache.set(sigCal, unionCalId!);
          // union delle eccezioni-calendario (calendar_dates) delle sorgenti
          if (srcCalIds.length > 0) {
            await tx.execute(sql`
              INSERT INTO ps_calendar_dates (calendar_id, date, exception_type)
              SELECT ${unionCalId}::uuid, date, MIN(exception_type)
                FROM ps_calendar_dates
               WHERE calendar_id = ANY(${`{${srcCalIds.join(",")}}`}::uuid[])
               GROUP BY date
              ON CONFLICT (calendar_id, date) DO NOTHING
            `);
          }
        }
      }

      const removeLit = `{${p.removeIds.join(",")}}`;
      // union ps_trip_day_validity (is_valid=true da QUALSIASI sorgente)
      await tx.execute(sql`
        INSERT INTO ps_trip_day_validity (trip_id, day_type_id, is_valid)
        SELECT ${p.primaryId}::uuid, day_type_id, true
          FROM ps_trip_day_validity
         WHERE trip_id = ANY(${removeLit}::uuid[]) AND is_valid = true
         GROUP BY day_type_id
        ON CONFLICT (trip_id, day_type_id) DO UPDATE SET is_valid = true
      `);
      // union ps_trip_category_validity
      await tx.execute(sql`
        INSERT INTO ps_trip_category_validity (trip_id, category_id)
        SELECT ${p.primaryId}::uuid, category_id
          FROM ps_trip_category_validity
         WHERE trip_id = ANY(${removeLit}::uuid[])
         GROUP BY category_id
        ON CONFLICT (trip_id, category_id) DO NOTHING
      `);
      // union eccezioni corsa (add vince: MIN(exception_type) → 1 se presente)
      await tx.execute(sql`
        INSERT INTO ps_trip_exceptions (trip_id, date, exception_type, reason)
        SELECT ${p.primaryId}::uuid, date, MIN(exception_type), NULL
          FROM ps_trip_exceptions
         WHERE trip_id = ANY(${removeLit}::uuid[])
         GROUP BY date
        ON CONFLICT (trip_id, date) DO NOTHING
      `);
      // aggiorna la primaria: calendario-unione, periodo più ampio, maschera
      // settimanale = copertura EFFETTIVA unione. Se (caso degenere) fosse
      // tutta spenta, RIMUOVE la chiave weekdays così la corsa NON perde i
      // giorni (ricade su calendario + validità per tipo-giorno).
      const maskOk = p.unionWeekdays.some(Boolean);
      const attrExpr = maskOk
        ? sql`COALESCE(attributes, '{}'::jsonb) || ${JSON.stringify({ weekdays: p.unionWeekdays })}::jsonb`
        : sql`COALESCE(attributes, '{}'::jsonb) - 'weekdays'`;
      await tx.execute(sql`
        UPDATE ps_trips
           SET calendar_id = COALESCE(${unionCalId}::uuid, calendar_id),
               valid_from = ${p.validFrom}::date,
               valid_to = ${p.validTo}::date,
               attributes = ${attrExpr},
               updated_at = now()
         WHERE id = ${p.primaryId}::uuid
      `);
      // elimina le corse fuse (ps_trip_category_validity non ha FK con cascata)
      await tx.execute(sql`DELETE FROM ps_trip_category_validity WHERE trip_id = ANY(${removeLit}::uuid[])`);
      await tx.execute(sql`DELETE FROM ps_trips WHERE id = ANY(${removeLit}::uuid[]) AND project_id = ${projId}::uuid`);
      removed += p.removeIds.length;
    }
  });

  await logActivity(projId, userId, "trip.merge_twins", "trip", null, { groups: plans.length, removed });
  res.json({
    dryRun: false,
    groups: plans,
    tripsBefore: trips.length,
    tripsAfter: trips.length - removed,
    removed,
  });
});

/* ─── SDOPPIA PER VALIDITÀ (split-categories) ──────────────────────────────
 * Una corsa valida in più categorie (es. Scuole Aperte + Scuole Chiuse) non può
 * avere due orari diversi. Per spostare l'orario SOLO in una delle validità va
 * SDOPPIATA: si crea una copia identica (stesso orario) a cui si assegnano le
 * categorie scelte, togliendole all'originale. Da lì, nel TTD, si sposta la
 * copia a un altro orario in modo indipendente.
 *
 * Body: { categoryIds: string[] } — le categorie da spostare sulla NUOVA corsa.
 * Vincolo: 1 ≤ scelte < totali (spostarle TUTTE lascerebbe l'originale senza
 * validità = "vale in ogni periodo", che non è ciò che si vuole).
 * ──────────────────────────────────────────────────────────────────────── */
router.post("/planning-studio/projects/:id/trips/:tripId/split-categories", async (req, res): Promise<void> => {
  const userId = getUserId(req);
  if (!userId) { res.status(401).json({ error: "auth required" }); return; }
  const proj = await loadProject(req.params.id, userId, true);
  if (!proj) { res.status(403).json({ error: "no write access" }); return; }
  const projId = req.params.id;
  const tripId = String(req.params.tripId || "");
  if (!UUID_RE.test(tripId)) { res.status(400).json({ error: "tripId non valido" }); return; }
  const catIds: string[] = Array.isArray(req.body?.categoryIds)
    ? req.body.categoryIds.map((x: any) => String(x)).filter((x: string) => UUID_RE.test(x)) : [];
  if (catIds.length === 0) { res.status(400).json({ error: "categoryIds obbligatorio" }); return; }

  const own = await db.execute<any>(sql`SELECT 1 FROM ps_trips WHERE id = ${tripId}::uuid AND project_id = ${projId}::uuid LIMIT 1`);
  if (!own.rows?.length) { res.status(404).json({ error: "corsa non trovata nel progetto" }); return; }

  const curR = await db.execute<any>(sql`SELECT category_id FROM ps_trip_category_validity WHERE trip_id = ${tripId}::uuid`);
  const cur = new Set<string>((curR.rows ?? []).map((r: any) => r.category_id));
  const move = catIds.filter(c => cur.has(c));
  if (move.length === 0) { res.status(400).json({ error: "Le categorie scelte non sono assegnate a questa corsa" }); return; }
  if (move.length >= cur.size) { res.status(400).json({ error: "Non puoi spostare TUTTE le categorie: la corsa originale resterebbe senza validità" }); return; }

  const moveLit = `{${move.join(",")}}`;
  let newTripId = "";
  await db.transaction(async (tx) => {
    // copia riga corsa (tutte le colonne tranne id/created_at → prese da schema)
    const colsR = await tx.execute<any>(sql`
      SELECT column_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name='ps_trips'
         AND column_name NOT IN ('id','created_at') ORDER BY ordinal_position`);
    const cols: string[] = colsR.rows.map((r: any) => r.column_name);
    const ins = await tx.execute<any>(sql`
      INSERT INTO ps_trips (id, ${sql.raw(cols.join(", "))})
      SELECT gen_random_uuid(), ${sql.raw(cols.join(", "))} FROM ps_trips WHERE id = ${tripId}::uuid
      RETURNING id`);
    newTripId = ins.rows[0].id;
    await tx.execute(sql`
      INSERT INTO ps_stop_times (trip_id, stop_seq, stop_id, arrival_time, departure_time, pickup_type, drop_off_type, timepoint, shape_dist_traveled)
      SELECT ${newTripId}::uuid, stop_seq, stop_id, arrival_time, departure_time, pickup_type, drop_off_type, timepoint, shape_dist_traveled
        FROM ps_stop_times WHERE trip_id = ${tripId}::uuid`);
    await tx.execute(sql`
      INSERT INTO ps_trip_day_validity (trip_id, day_type_id, is_valid)
      SELECT ${newTripId}::uuid, day_type_id, is_valid FROM ps_trip_day_validity WHERE trip_id = ${tripId}::uuid
      ON CONFLICT DO NOTHING`);
    // eccezioni della corsa (best-effort: la copia eredita le stesse date)
    await tx.execute(sql`
      INSERT INTO ps_trip_exceptions (trip_id, date, exception_type, reason)
      SELECT ${newTripId}::uuid, date, exception_type, reason FROM ps_trip_exceptions WHERE trip_id = ${tripId}::uuid
      ON CONFLICT DO NOTHING`);
    // categorie: le scelte vanno alla NUOVA corsa e si tolgono dall'originale
    await tx.execute(sql`
      INSERT INTO ps_trip_category_validity (trip_id, category_id)
      SELECT ${newTripId}::uuid, tid FROM unnest(${moveLit}::uuid[]) AS tid
      ON CONFLICT DO NOTHING`);
    await tx.execute(sql`
      DELETE FROM ps_trip_category_validity WHERE trip_id = ${tripId}::uuid AND category_id = ANY(${moveLit}::uuid[])`);
  });

  await logActivity(projId, userId, "trip.split_categories", "trip", tripId, { newTripId, moved: move.length });
  res.status(201).json({ ok: true, newTripId, moved: move.length });
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
  // le eccezioni cambiano i giorni di circolazione → categorie da risincronizzare
  await db.execute(sql`UPDATE ps_trips SET updated_at = now() WHERE id = ${req.params.tripId}::uuid`);
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
  await db.execute(sql`UPDATE ps_trips SET updated_at = now() WHERE id = ${req.params.tripId}::uuid`);
  await logActivity(req.params.id, userId, "trip.exception.remove", "trip", req.params.tripId, { date });
  res.json({ ok: true });
});

export default router;
