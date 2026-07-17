/**
 * MAPPA ORARI pubblica — condivisione via link dalla sezione Stampa Orari.
 *
 * Esperienza utente (pagina /o/:token, nessuna autenticazione):
 *   1. l'utente sceglie la LINEA → si accendono tutti i suoi percorsi e fermate
 *   2. clicca una FERMATA → orari di transito, con evidenza delle corse
 *      A CHIAMATA e dei giorni di validità (Feriale/Sabato/Festivo…)
 *
 * Il link è il segreto (token CSPRNG). La creazione avviene dall'endpoint
 * autenticato POST /planning-studio/:projectId/timetable-map-share
 * (in planning-studio-timetables.ts, accanto al gemello network-share).
 *
 * Tre endpoint pubblici, pensati per il caricamento LAZY (la pagina resta
 * leggera anche su reti con centinaia di corse):
 *   GET /timetable-map/:token                      → meta + elenco linee
 *   GET /timetable-map/:token/route/:routeId       → percorsi + fermate della linea
 *   GET /timetable-map/:token/stop/:stopId?routeId → transiti alla fermata
 */
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { projectHasTripValidity } from "../lib/planning-studio-validity-eval";

const router: IRouter = Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let booted = false;
export async function ensureTimetableMapShareTable(): Promise<void> {
  if (booted) return;
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS ps_timetable_map_shares (
      token       text PRIMARY KEY,
      project_id  uuid NOT NULL,
      route_ids   jsonb NOT NULL DEFAULT '[]'::jsonb,
      title       text,
      created_by  uuid,
      created_at  timestamptz NOT NULL DEFAULT now(),
      expires_at  timestamptz
    )`);
  booted = true;
}
router.use(async (_req, _res, next) => { await ensureTimetableMapShareTable(); next(); });

interface ShareRow { project_id: string; route_ids: string[]; title: string | null; expires_at: string | null }

/** Valida token e scadenza; risponde con l'errore se invalido (→ null). */
async function loadShare(token: string, res: any): Promise<ShareRow | null> {
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(token)) { res.status(400).json({ error: "token non valido" }); return null; }
  const r = await db.execute<any>(sql`
    SELECT project_id, route_ids, title, expires_at
      FROM ps_timetable_map_shares WHERE token = ${token} LIMIT 1`);
  const row = r.rows[0];
  if (!row) { res.status(404).json({ error: "Link non trovato o scaduto" }); return null; }
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
    res.status(410).json({ error: "Link scaduto", expired: true }); return null;
  }
  return {
    project_id: row.project_id,
    route_ids: Array.isArray(row.route_ids) ? row.route_ids.filter((x: any) => UUID_RE.test(String(x))) : [],
    title: row.title ?? null,
    expires_at: row.expires_at ?? null,
  };
}

/** Frammento SQL: filtro linee del link (lista vuota = TUTTE le linee). */
function routeScope(share: ShareRow) {
  return share.route_ids.length > 0
    ? sql`AND r.id = ANY(${`{${share.route_ids.join(",")}}`}::uuid[])`
    : sql``;
}

/* ── 1) Meta + elenco linee + giorni di validità ───────────────────
 * Il passeggero sceglie PRIMA il giorno (Feriale/Sabato/Festivo…): i
 * dayTypes elencati sono SOLO quelli realmente usati da ≥1 corsa attiva. */
router.get("/timetable-map/:token", async (req, res): Promise<void> => {
  try {
    const share = await loadShare(String(req.params.token), res);
    if (!share) return;
    const projR = await db.execute<any>(sql`
      SELECT name, agency_name FROM ps_projects WHERE id = ${share.project_id}::uuid LIMIT 1`);
    const proj = projR.rows[0] ?? {};
    // Solo linee con almeno una corsa reale (le linee vuote confonderebbero l'utente)
    const linesR = await db.execute<any>(sql`
      SELECT r.id, COALESCE(NULLIF(r.short_name, ''), r.code, '') AS code,
             r.long_name, r.color
        FROM ps_routes r
       WHERE r.project_id = ${share.project_id}::uuid ${routeScope(share)}
         AND EXISTS (
           SELECT 1 FROM ps_trips t
            WHERE t.route_id = r.id AND COALESCE(t.is_active, true) = true
              AND COALESCE((t.attributes->>'prototype')::boolean, false) = false)
       ORDER BY code
    `);
    // Giorni di validità (dalla matrice GTFS/PS): guida lo step 1 del flusso
    const hasValidity = await projectHasTripValidity(share.project_id);
    let dayTypes: any[] = [];
    // linea → giorni in cui ha ≥1 corsa valida: serve al FE per FILTRARE le
    // linee dopo la scelta del giorno (una linea solo-feriale non deve
    // comparire scegliendo Festivo).
    const daysByRoute = new Map<string, string[]>();
    if (hasValidity) {
      const dtR = await db.execute<any>(sql`
        SELECT DISTINCT dt.id, dt.code, dt.name, dt.color, dt.sort_order
          FROM ps_day_types dt
          JOIN ps_trip_day_validity tdv ON tdv.day_type_id = dt.id AND tdv.is_valid = true
          JOIN ps_trips t ON t.id = tdv.trip_id
         WHERE t.project_id = ${share.project_id}::uuid
           AND COALESCE(t.is_active, true) = true
           AND COALESCE((t.attributes->>'prototype')::boolean, false) = false
         ORDER BY dt.sort_order NULLS LAST, dt.code
      `);
      dayTypes = (dtR.rows ?? []).map((d: any) => ({
        id: d.id, code: d.code, name: d.name, color: d.color ?? null,
      }));
      const rdR = await db.execute<any>(sql`
        SELECT DISTINCT t.route_id, tdv.day_type_id
          FROM ps_trips t
          JOIN ps_trip_day_validity tdv ON tdv.trip_id = t.id AND tdv.is_valid = true
         WHERE t.project_id = ${share.project_id}::uuid
           AND COALESCE(t.is_active, true) = true
           AND COALESCE((t.attributes->>'prototype')::boolean, false) = false
      `);
      for (const r of rdR.rows ?? []) {
        if (!daysByRoute.has(r.route_id)) daysByRoute.set(r.route_id, []);
        daysByRoute.get(r.route_id)!.push(r.day_type_id);
      }
    }
    res.json({
      title: share.title,
      agencyName: proj.agency_name ?? proj.name ?? null,
      expiresAt: share.expires_at,
      hasValidity,
      dayTypes,
      lines: (linesR.rows ?? []).map((r: any) => ({
        routeId: r.id, code: r.code, longName: r.long_name ?? null, color: r.color ?? null,
        // giorni in cui la linea circola; [] = nessun bollino → il FE la
        // mostra sempre (fallback permissivo: meglio mostrare che nascondere)
        dayTypeIds: daysByRoute.get(r.id) ?? [],
      })),
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

/* ── 2) Percorsi + fermate della linea scelta ───────────────────── */
router.get("/timetable-map/:token/route/:routeId", async (req, res): Promise<void> => {
  try {
    const share = await loadShare(String(req.params.token), res);
    if (!share) return;
    const routeId = String(req.params.routeId);
    if (!UUID_RE.test(routeId)) { res.status(400).json({ error: "routeId non valido" }); return; }
    if (share.route_ids.length > 0 && !share.route_ids.includes(routeId)) {
      res.status(404).json({ error: "Linea non inclusa in questo link" }); return;
    }
    // Filtro opzionale per GIORNO scelto dal passeggero: mostra solo i
    // percorsi con almeno una corsa valida in quel tipo-giorno (un percorso
    // solo-festivo non compare scegliendo Feriale).
    const dayTypeId = typeof req.query.dayTypeId === "string" && UUID_RE.test(req.query.dayTypeId)
      ? req.query.dayTypeId : null;
    const fDay = dayTypeId
      ? sql`AND EXISTS (SELECT 1 FROM ps_trip_day_validity tdv
                         WHERE tdv.trip_id = t.id AND tdv.day_type_id = ${dayTypeId}::uuid
                           AND tdv.is_valid = true)`
      : sql``;
    // Varianti con almeno una corsa reale (colore per-percorso opzionale da
    // attributes.color, scelto dall'operatore nell'app; fallback colore linea)
    const varsR = await db.execute<any>(sql`
      SELECT v.id, COALESCE(NULLIF(v.code, ''), v.name, '') AS code,
             v.name, v.headsign, COALESCE(v.direction, 0) AS direction,
             NULLIF(v.attributes->>'color', '') AS variant_color,
             r.color AS route_color
        FROM ps_route_variants v
        JOIN ps_routes r ON r.id = v.route_id
       WHERE v.route_id = ${routeId}::uuid AND r.project_id = ${share.project_id}::uuid
         AND EXISTS (
           SELECT 1 FROM ps_trips t
            WHERE t.variant_id = v.id AND COALESCE(t.is_active, true) = true
              AND COALESCE((t.attributes->>'prototype')::boolean, false) = false ${fDay})
       ORDER BY direction, code
    `);
    const variants: any[] = varsR.rows ?? [];
    if (variants.length === 0) { res.json({ routeId, variants: [] }); return; }
    const varIdsLit = `{${variants.map((v) => v.id).join(",")}}`;
    const [shapesR, stopsR] = await Promise.all([
      db.execute<any>(sql`
        SELECT variant_id, geometry FROM ps_shapes
         WHERE variant_id = ANY(${varIdsLit}::uuid[])`),
      db.execute<any>(sql`
        SELECT vs.variant_id, vs.seq, s.id AS stop_id, s.name, s.lat, s.lon
          FROM ps_variant_stops vs
          JOIN ps_stops s ON s.id = vs.stop_id
         WHERE vs.variant_id = ANY(${varIdsLit}::uuid[])
         ORDER BY vs.variant_id, vs.seq`),
    ]);
    const geomByVar = new Map<string, any>();
    for (const s of shapesR.rows ?? []) geomByVar.set(s.variant_id, s.geometry);
    const stopsByVar = new Map<string, any[]>();
    for (const st of stopsR.rows ?? []) {
      if (!stopsByVar.has(st.variant_id)) stopsByVar.set(st.variant_id, []);
      stopsByVar.get(st.variant_id)!.push({
        stopId: st.stop_id, name: st.name,
        lat: Number(st.lat), lon: Number(st.lon), seq: Number(st.seq),
      });
    }
    res.json({
      routeId,
      variants: variants.map((v) => ({
        variantId: v.id, code: v.code, name: v.name ?? null,
        headsign: v.headsign ?? null, direction: Number(v.direction) || 0,
        color: v.variant_color ?? v.route_color ?? null,
        geometry: geomByVar.get(v.id) ?? null,
        stops: stopsByVar.get(v.id) ?? [],
      })),
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

/* ── 3) Transiti alla fermata (per la linea scelta) ─────────────── */
router.get("/timetable-map/:token/stop/:stopId", async (req, res): Promise<void> => {
  try {
    const share = await loadShare(String(req.params.token), res);
    if (!share) return;
    const stopId = String(req.params.stopId);
    const routeId = typeof req.query.routeId === "string" ? req.query.routeId : "";
    if (!UUID_RE.test(stopId) || !UUID_RE.test(routeId)) {
      res.status(400).json({ error: "stopId/routeId non validi" }); return;
    }
    if (share.route_ids.length > 0 && !share.route_ids.includes(routeId)) {
      res.status(404).json({ error: "Linea non inclusa in questo link" }); return;
    }
    const stopR = await db.execute<any>(sql`
      SELECT id, name, code FROM ps_stops
       WHERE project_id = ${share.project_id}::uuid AND id = ${stopId}::uuid LIMIT 1`);
    const stop = stopR.rows[0];
    if (!stop) { res.status(404).json({ error: "Fermata non trovata" }); return; }

    // Filtro per GIORNO scelto dal passeggero (step 1 del flusso): solo le
    // corse valide in quel tipo-giorno secondo la matrice di validità.
    const dayTypeId = typeof req.query.dayTypeId === "string" && UUID_RE.test(req.query.dayTypeId)
      ? req.query.dayTypeId : null;
    const fDay = dayTypeId
      ? sql`AND EXISTS (SELECT 1 FROM ps_trip_day_validity tdv
                         WHERE tdv.trip_id = t.id AND tdv.day_type_id = ${dayTypeId}::uuid
                           AND tdv.is_valid = true)`
      : sql``;

    // Transiti: partenze dalla fermata (escluso il capolinea d'arrivo),
    // con flag A CHIAMATA (attributes.onDemand) per la prenotazione.
    const depR = await db.execute<any>(sql`
      SELECT st.departure_time,
             COALESCE(NULLIF(t.headsign, ''), v.headsign) AS headsign,
             COALESCE(NULLIF(v.code, ''), v.name, '') AS variant_code,
             COALESCE((t.attributes->>'onDemand')::boolean, false) AS on_demand,
             t.id AS trip_id
        FROM ps_stop_times st
        JOIN ps_trips t ON t.id = st.trip_id
        JOIN ps_route_variants v ON v.id = t.variant_id
        JOIN (SELECT trip_id, MAX(stop_seq) AS last_seq
                FROM ps_stop_times GROUP BY trip_id) last ON last.trip_id = st.trip_id
       WHERE st.stop_id = ${stopId}::uuid
         AND t.route_id = ${routeId}::uuid
         AND t.project_id = ${share.project_id}::uuid
         AND COALESCE(t.is_active, true) = true
         AND COALESCE((t.attributes->>'prototype')::boolean, false) = false ${fDay}
         AND st.departure_time IS NOT NULL
         AND st.stop_seq < last.last_seq
       ORDER BY st.departure_time
    `);
    const deps: any[] = depR.rows ?? [];

    // Giorni di validità per corsa (matrice: Feriale/Sabato/Festivo/custom)
    const hasValidity = await projectHasTripValidity(share.project_id);
    const daysByTrip = new Map<string, string[]>();
    if (hasValidity && deps.length > 0) {
      const tripIdsLit = `{${[...new Set(deps.map((d) => d.trip_id))].join(",")}}`;
      const dvR = await db.execute<any>(sql`
        SELECT tdv.trip_id, dt.code, dt.name, dt.sort_order
          FROM ps_trip_day_validity tdv
          JOIN ps_day_types dt ON dt.id = tdv.day_type_id
         WHERE tdv.is_valid = true AND tdv.trip_id = ANY(${tripIdsLit}::uuid[])
         ORDER BY dt.sort_order NULLS LAST, dt.code
      `);
      for (const r of dvR.rows ?? []) {
        if (!daysByTrip.has(r.trip_id)) daysByTrip.set(r.trip_id, []);
        daysByTrip.get(r.trip_id)!.push(r.name || r.code);
      }
    }

    res.json({
      stop: { stopId: stop.id, name: stop.name, code: stop.code ?? null },
      hasValidity,
      departures: deps.map((d) => {
        const m = /^(\d{1,2}):(\d{2})/.exec(String(d.departure_time));
        return {
          time: m ? `${String(Number(m[1]) % 24).padStart(2, "0")}:${m[2]}` : String(d.departure_time),
          headsign: d.headsign ?? null,
          variantCode: d.variant_code ?? null,
          onDemand: !!d.on_demand,
          days: daysByTrip.get(d.trip_id) ?? [],
        };
      }),
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
