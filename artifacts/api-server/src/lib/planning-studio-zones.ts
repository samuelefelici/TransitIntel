/**
 * ZONIZZAZIONE — confini comunali + km sviluppati per comune.
 *
 * Tabella globale `zones` (confini amministrativi, tipicamente comuni ISTAT):
 *   id, name, istat_code, geometry (GeoJSON Polygon/MultiPolygon), properties.
 *
 * Endpoint:
 *   POST   /zones/import   — importa una FeatureCollection GeoJSON (upsert per istat_code)
 *   GET    /zones          — lista zone con geometria (per la mappa)
 *   DELETE /zones/:id      — elimina una zona
 *   DELETE /zones          — svuota tutte le zone
 *   POST   /planning-studio/projects/:id/zones/compute?year=YYYY
 *     → km/anno per (comune × linea): per ogni variante con shape calcola i km
 *       dentro ogni zona (pre-filtro bbox), poi moltiplica per le corse/anno
 *       della variante (calendari settimanali ∩ anno + eccezioni + validità trip).
 *
 * Serve per i corrispettivi chilometrici dovuti agli enti locali.
 */
import type { Request } from "express";
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import {
  lineKmInsidePolygon,
  bboxOfCoords,
  bboxOfGeometry,
  bboxIntersects,
  type ZoneGeometry,
} from "./geo-zones";
import { haversineKm } from "./geo-utils";
import { loadCalendarProfile } from "./planning-studio-calendar";
import { classifyDate, italianHolidays } from "./day-classifier";

/** Categorie del Calendario Aziendale (classi level1 del day-classifier). */
const CATEGORY_META: Record<string, { name: string; color: string; order: number }> = {
  scuole_aperte: { name: "Scuole Aperte", color: "#3b82f6", order: 0 },
  scuole_chiuse: { name: "Scuole Chiuse", color: "#f59e0b", order: 1 },
  festivo:       { name: "Festività",     color: "#ef4444", order: 2 },
};

const router: IRouter = Router();

/* ────────── Bootstrap idempotente ────────── */
let bootstrapped = false;
async function ensureTables(): Promise<void> {
  if (bootstrapped) return;
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS zones (
        id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name       text NOT NULL,
        istat_code text,
        geometry   jsonb NOT NULL,
        properties jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_zones_istat ON zones(istat_code)`);
    bootstrapped = true;
    console.log("[planning-studio.zones] tables ready");
  } catch (e: any) {
    console.error("[ps-zones] bootstrap error:", e?.message || e);
  }
}

function getUserId(req: Request): string | null {
  return (req as any).session?.userId ?? (req as any).user?.id ?? null;
}

async function loadProject(projectId: string, userId: string): Promise<any | null> {
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
  return (r as any).rows?.[0] ?? null;
}

function isZoneGeometry(g: any): g is ZoneGeometry {
  return !!g && (g.type === "Polygon" || g.type === "MultiPolygon") && Array.isArray(g.coordinates);
}

/** Ricava il nome del comune dalle properties (vari formati ISTAT/geojson-italy). */
function featureName(props: Record<string, any>, index: number): string {
  const candidates = ["COMUNE", "name", "NOME", "comune", "COMUNE_NOM", "denominazione"];
  for (const key of candidates) {
    const v = props?.[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return `Zona ${index + 1}`;
}

/** Ricava il codice ISTAT dalle properties (opzionale). */
function featureIstat(props: Record<string, any>): string | null {
  const candidates = ["PRO_COM", "PRO_COM_T", "ISTAT", "istat", "com_istat_code", "com_istat_code_num"];
  for (const key of candidates) {
    const v = props?.[key];
    if (v !== undefined && v !== null && String(v).trim()) return String(v).trim();
  }
  return null;
}

/** Arrotonda a 1 decimale (output sempre numerico, mai stringa). */
function r1(x: number): number {
  return Math.round(x * 10) / 10;
}

/* ════════════════════════ CRUD zone ════════════════════════ */

/* ─── POST /zones/import — FeatureCollection GeoJSON ─── */
router.post("/zones/import", async (req, res): Promise<void> => {
  await ensureTables();
  if (!getUserId(req)) { res.status(401).json({ error: "unauth" }); return; }

  const fc = req.body;
  if (!fc || fc.type !== "FeatureCollection" || !Array.isArray(fc.features)) {
    res.status(400).json({ error: "feature_collection_required" }); return;
  }

  try {
    let inserted = 0, updated = 0, skipped = 0;
    for (let i = 0; i < fc.features.length; i++) {
      const f = fc.features[i];
      const geom = f?.geometry;
      if (!isZoneGeometry(geom)) { skipped++; continue; }
      const props = (f.properties ?? {}) as Record<string, any>;
      const name = featureName(props, i);
      const istat = featureIstat(props);

      if (istat) {
        // Upsert per istat_code (nessun vincolo UNIQUE: update-then-insert)
        const u = await db.execute(sql`
          UPDATE zones
             SET name = ${name},
                 geometry = ${JSON.stringify(geom)}::jsonb,
                 properties = ${JSON.stringify(props)}::jsonb
           WHERE istat_code = ${istat}
           RETURNING id
        `);
        if (((u as any).rows ?? []).length > 0) { updated++; continue; }
      }
      await db.execute(sql`
        INSERT INTO zones (name, istat_code, geometry, properties)
        VALUES (${name}, ${istat}, ${JSON.stringify(geom)}::jsonb, ${JSON.stringify(props)}::jsonb)
      `);
      inserted++;
    }
    res.json({ ok: true, inserted, updated, skipped, total: fc.features.length });
  } catch (e: any) {
    console.error("[ps-zones.import] error:", e?.message || e);
    res.status(500).json({ error: e?.message || "internal_error" });
  }
});

/* ─── GET /zones — lista con geometria intera (per la mappa) ─── */
router.get("/zones", async (req, res): Promise<void> => {
  await ensureTables();
  if (!getUserId(req)) { res.status(401).json({ error: "unauth" }); return; }
  try {
    const r = await db.execute(sql`
      SELECT id, name, istat_code, geometry
        FROM zones
       ORDER BY name ASC
    `);
    const zones = ((r as any).rows ?? []).map((row: any) => ({
      id: row.id,
      name: row.name,
      istatCode: row.istat_code,
      geometry: row.geometry,
    }));
    res.json({ zones });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "internal_error" });
  }
});

/* ─── DELETE /zones/:id ─── */
router.delete("/zones/:id", async (req, res): Promise<void> => {
  await ensureTables();
  if (!getUserId(req)) { res.status(401).json({ error: "unauth" }); return; }
  try {
    await db.execute(sql`DELETE FROM zones WHERE id = ${req.params.id}::uuid`);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "internal_error" });
  }
});

/* ─── DELETE /zones — svuota tutto ─── */
router.delete("/zones", async (req, res): Promise<void> => {
  await ensureTables();
  if (!getUserId(req)) { res.status(401).json({ error: "unauth" }); return; }
  try {
    await db.execute(sql`DELETE FROM zones`);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "internal_error" });
  }
});

/* ════════════════════════ Compute ════════════════════════ */

/** Date ISO dell'anno + giorno settimana GTFS (monday..sunday). */
const DOW_KEYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;

function yearDates(year: number): Array<{ iso: string; dowKey: (typeof DOW_KEYS)[number] }> {
  const out: Array<{ iso: string; dowKey: (typeof DOW_KEYS)[number] }> = [];
  const d = new Date(Date.UTC(year, 0, 1));
  while (d.getUTCFullYear() === year) {
    const iso = `${year}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
    out.push({ iso, dowKey: DOW_KEYS[d.getUTCDay()] });
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/* ─── POST /planning-studio/projects/:id/zones/compute?year=YYYY ─── */
router.post("/planning-studio/projects/:id/zones/compute", async (req, res): Promise<void> => {
  await ensureTables();
  const userId = getUserId(req);
  if (!userId) { res.status(401).json({ error: "unauth" }); return; }
  const proj = await loadProject(req.params.id, userId);
  if (!proj) { res.status(404).json({ error: "not_found_or_no_access" }); return; }

  const year = Number(req.query.year ?? new Date().getFullYear());
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    res.status(400).json({ error: "invalid_year" }); return;
  }

  try {
    /* ── 1. Zone (confini) ── */
    const zonesR = await db.execute(sql`
      SELECT id, name, istat_code, geometry FROM zones
    `);
    const zones: Array<{
      id: string; name: string; istatCode: string | null;
      geometry: ZoneGeometry; bbox: ReturnType<typeof bboxOfGeometry>;
    }> = ((zonesR as any).rows ?? [])
      .filter((z: any) => isZoneGeometry(z.geometry))
      .map((z: any) => ({
        id: z.id as string,
        name: z.name as string,
        istatCode: (z.istat_code as string | null) ?? null,
        geometry: z.geometry as ZoneGeometry,
        bbox: bboxOfGeometry(z.geometry as ZoneGeometry),
      }));
    if (zones.length === 0) {
      res.status(400).json({ error: "no_zones", message: "Nessun confine importato: carica prima un GeoJSON di comuni." });
      return;
    }

    /* ── 2. Varianti del progetto con shape ── */
    const varR = await db.execute(sql`
      SELECT v.id AS variant_id, v.route_id,
             r.short_name, r.color,
             s.geometry
        FROM ps_route_variants v
        JOIN ps_routes r ON r.id = v.route_id
        JOIN ps_shapes s ON s.variant_id = v.id
       WHERE v.project_id = ${proj.id}::uuid
    `);
    interface VariantGeo {
      variantId: string;
      routeId: string;
      shortName: string;
      color: string | null;
      coords: number[][];
      totalKm: number;
      bbox: [number, number, number, number];
      /** km dentro ciascuna zona (solo zone con bbox intersecante) */
      kmByZone: Map<string, number>;
    }
    const variants: VariantGeo[] = [];
    for (const row of ((varR as any).rows ?? []) as any[]) {
      const geom = row.geometry;
      const coords: number[][] = geom?.type === "LineString" && Array.isArray(geom.coordinates)
        ? geom.coordinates
        : [];
      if (coords.length < 2) continue;
      let totalKm = 0;
      for (let i = 1; i < coords.length; i++) {
        totalKm += haversineKm(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]);
      }
      variants.push({
        variantId: row.variant_id,
        routeId: row.route_id,
        shortName: row.short_name,
        color: row.color ?? null,
        coords,
        totalKm,
        bbox: bboxOfCoords(coords),
        kmByZone: new Map(),
      });
    }

    /* ── 3. km dentro ogni zona, UNA volta per (variante × zona).
           Pre-filtro bbox: fondamentale con centinaia di comuni. ── */
    for (const v of variants) {
      for (const z of zones) {
        if (!bboxIntersects(v.bbox, z.bbox)) continue;
        const km = lineKmInsidePolygon(v.coords as [number, number][], z.geometry);
        if (km > 0) v.kmByZone.set(z.id, km);
      }
    }

    /* ── 4. Corse/anno per variante ── */
    // Trips attivi con shape-variant nel progetto
    const tripsR = await db.execute(sql`
      SELECT t.id, t.variant_id, t.calendar_id,
             to_char(t.valid_from, 'YYYY-MM-DD') AS valid_from,
             to_char(t.valid_to,   'YYYY-MM-DD') AS valid_to
        FROM ps_trips t
       WHERE t.project_id = ${proj.id}::uuid
         AND t.is_active = true
    `);
    const trips = ((tripsR as any).rows ?? []) as Array<{
      id: string; variant_id: string; calendar_id: string | null;
      valid_from: string | null; valid_to: string | null;
    }>;

    const yStart = `${year}-01-01`;
    const yEnd = `${year}-12-31`;
    const allDates = yearDates(year);

    // Calendari del progetto
    const calR = await db.execute(sql`
      SELECT id, code, name,
             monday, tuesday, wednesday, thursday, friday, saturday, sunday,
             to_char(start_date, 'YYYY-MM-DD') AS start_date,
             to_char(end_date,   'YYYY-MM-DD') AS end_date
        FROM ps_calendars
       WHERE project_id = ${proj.id}::uuid
    `);
    const calRows = ((calR as any).rows ?? []) as any[];

    // Eccezioni calendario nell'anno (array → literal Postgres {a,b}, MAI ${array} diretto)
    const calIds = calRows.map((c) => c.id);
    const calDates = new Map<string, Array<{ date: string; type: number }>>();
    if (calIds.length > 0) {
      const cdR = await db.execute(sql`
        SELECT calendar_id, to_char(date, 'YYYY-MM-DD') AS date, exception_type
          FROM ps_calendar_dates
         WHERE calendar_id = ANY(${`{${calIds.join(",")}}`}::uuid[])
           AND date >= ${yStart}::date AND date <= ${yEnd}::date
      `);
      for (const r of (cdR as any).rows ?? []) {
        if (!calDates.has(r.calendar_id)) calDates.set(r.calendar_id, []);
        calDates.get(r.calendar_id)!.push({ date: r.date, type: Number(r.exception_type) });
      }
    }

    // Set di date attive per calendario nell'anno (pattern settimanale ∩ [start,end] ∩ anno ± eccezioni)
    const calActiveDates = new Map<string, Set<string>>();
    for (const c of calRows) {
      const set = new Set<string>();
      const from = c.start_date > yStart ? c.start_date : yStart;
      const to = c.end_date < yEnd ? c.end_date : yEnd;
      if (from <= to) {
        for (const d of allDates) {
          if (d.iso < from || d.iso > to) continue;
          if (c[d.dowKey]) set.add(d.iso);
        }
      }
      for (const ex of calDates.get(c.id) ?? []) {
        if (ex.type === 1) set.add(ex.date);
        else set.delete(ex.date);
      }
      calActiveDates.set(c.id, set);
    }

    // Eccezioni per-trip nell'anno
    const tripIds = trips.map((t) => t.id);
    const tripExc = new Map<string, Array<{ date: string; type: number }>>();
    if (tripIds.length > 0) {
      const exR = await db.execute(sql`
        SELECT trip_id, to_char(date, 'YYYY-MM-DD') AS date, exception_type
          FROM ps_trip_exceptions
         WHERE trip_id = ANY(${`{${tripIds.join(",")}}`}::uuid[])
           AND date >= ${yStart}::date AND date <= ${yEnd}::date
      `);
      for (const r of (exR as any).rows ?? []) {
        if (!tripExc.has(r.trip_id)) tripExc.set(r.trip_id, []);
        tripExc.get(r.trip_id)!.push({ date: r.date, type: Number(r.exception_type) });
      }
    }

    // Mappa ISO → giorno settimana, per ripartire le corse per weekday
    const dowByIso = new Map<string, (typeof DOW_KEYS)[number]>();
    for (const d of allDates) dowByIso.set(d.iso, d.dowKey);

    // Mappa ISO → categoria del Calendario Aziendale (Scuole Aperte/Chiuse/
    // Festività): classificazione una volta sola per data, poi lookup.
    const profile = await loadCalendarProfile(proj.id);
    const yearHolidays = italianHolidays(year);
    const catByIso = new Map<string, string>();
    for (const d of allDates) {
      catByIso.set(d.iso, classifyDate(d.iso, profile, yearHolidays).level1);
    }

    // Corse/anno per variante = Σ giorni di circolazione dei suoi trip.
    // Oltre al totale, teniamo la ripartizione per calendario aziendale e per
    // giorno della settimana (servono all'export per rendere trasparente il calcolo).
    const NO_CAL = "__nocal__"; // trip senza calendario che circola solo per eccezioni
    const runsByVariant = new Map<string, number>();
    const calRunsByVariant = new Map<string, Map<string, number>>(); // variantId → calId → corse
    const dowRunsByVariant = new Map<string, Map<string, number>>(); // variantId → dowKey → corse
    const catRunsByVariant = new Map<string, Map<string, number>>(); // variantId → categoria → corse
    for (const t of trips) {
      // base dal calendario, ritagliata su valid_from/valid_to del trip
      const base = t.calendar_id ? (calActiveDates.get(t.calendar_id) ?? new Set<string>()) : new Set<string>();
      const days = new Set<string>();
      for (const d of base) {
        if (t.valid_from && d < t.valid_from) continue;
        if (t.valid_to && d > t.valid_to) continue;
        days.add(d);
      }
      // eccezioni per-trip: 1 = aggiunta forzata, 2 = rimozione forzata
      for (const ex of tripExc.get(t.id) ?? []) {
        if (ex.type === 1) days.add(ex.date);
        else days.delete(ex.date);
      }
      if (days.size === 0) continue;

      const vId = t.variant_id;
      runsByVariant.set(vId, (runsByVariant.get(vId) ?? 0) + days.size);

      // ripartizione per calendario
      const calKey = t.calendar_id ?? NO_CAL;
      let cm = calRunsByVariant.get(vId);
      if (!cm) { cm = new Map(); calRunsByVariant.set(vId, cm); }
      cm.set(calKey, (cm.get(calKey) ?? 0) + days.size);

      // ripartizione per giorno della settimana + categoria aziendale
      let dm = dowRunsByVariant.get(vId);
      if (!dm) { dm = new Map(); dowRunsByVariant.set(vId, dm); }
      let km = catRunsByVariant.get(vId);
      if (!km) { km = new Map(); catRunsByVariant.set(vId, km); }
      for (const iso of days) {
        const dow = dowByIso.get(iso);
        if (dow) dm.set(dow, (dm.get(dow) ?? 0) + 1);
        const cat = catByIso.get(iso);
        if (cat) km.set(cat, (km.get(cat) ?? 0) + 1);
      }
    }

    // Metadati calendario per etichette leggibili nell'export
    const calMeta = new Map<string, {
      id: string; code: string | null; name: string;
      weekdays: Record<string, boolean>; startDate: string | null; endDate: string | null;
      activeDays: number;
    }>();
    for (const c of calRows) {
      calMeta.set(c.id, {
        id: c.id,
        code: c.code ?? null,
        name: c.name || c.code || "Calendario",
        weekdays: {
          monday: !!c.monday, tuesday: !!c.tuesday, wednesday: !!c.wednesday,
          thursday: !!c.thursday, friday: !!c.friday, saturday: !!c.saturday, sunday: !!c.sunday,
        },
        startDate: c.start_date ?? null,
        endDate: c.end_date ?? null,
        activeDays: calActiveDates.get(c.id)?.size ?? 0,
      });
    }
    const calLabel = (calId: string) =>
      calId === NO_CAL ? "Senza calendario (solo eccezioni)" : (calMeta.get(calId)?.name ?? calId);
    const calCode = (calId: string) =>
      calId === NO_CAL ? null : (calMeta.get(calId)?.code ?? null);

    /* ── 5. Aggregazione: km/anno per (zona × linea) + km fuori da ogni zona ──
       Ogni linea porta anche il breakdown per calendario aziendale e per
       giorno della settimana. La somma dei km per calendario (o per giorno)
       coincide con i km/anno della linea nel comune: sono due ripartizioni
       esatte dello stesso insieme di giorni di circolazione. ── */
    interface DimAgg { kmYear: number; runsYear: number }
    interface RouteAgg {
      routeId: string; shortName: string; color: string | null; kmYear: number; runsYear: number;
      byCal: Map<string, DimAgg>; byDow: Map<string, DimAgg>; byCat: Map<string, DimAgg>;
    }
    const zoneAgg = new Map<string, Map<string, RouteAgg>>(); // zoneId → routeId → agg
    let unassignedKm = 0;
    // Totali di rete (km assegnati dentro i comuni) per calendario, giorno e
    // categoria aziendale. Le corse/anno di rete si contano UNA volta per
    // variante (non moltiplicate per il numero di comuni attraversati).
    const globalCalKm = new Map<string, number>();
    const globalDowKm = new Map<string, number>();
    const globalCatKm = new Map<string, number>();
    const globalCalRuns = new Map<string, number>();
    const globalDowRuns = new Map<string, number>();
    const globalCatRuns = new Map<string, number>();

    for (const v of variants) {
      const runs = runsByVariant.get(v.variantId) ?? 0;
      if (runs === 0) continue;
      const calRuns = calRunsByVariant.get(v.variantId) ?? new Map<string, number>();
      const dowRuns = dowRunsByVariant.get(v.variantId) ?? new Map<string, number>();
      const catRuns = catRunsByVariant.get(v.variantId) ?? new Map<string, number>();

      // corse/anno di rete per calendario / giorno / categoria (una volta per variante)
      for (const [k, n] of calRuns) globalCalRuns.set(k, (globalCalRuns.get(k) ?? 0) + n);
      for (const [k, n] of dowRuns) globalDowRuns.set(k, (globalDowRuns.get(k) ?? 0) + n);
      for (const [k, n] of catRuns) globalCatRuns.set(k, (globalCatRuns.get(k) ?? 0) + n);

      let insideSum = 0;
      for (const [zoneId, kmInside] of v.kmByZone) {
        insideSum += kmInside;
        if (!zoneAgg.has(zoneId)) zoneAgg.set(zoneId, new Map());
        const byRoute = zoneAgg.get(zoneId)!;
        const agg = byRoute.get(v.routeId) ?? {
          routeId: v.routeId, shortName: v.shortName, color: v.color, kmYear: 0, runsYear: 0,
          byCal: new Map<string, DimAgg>(), byDow: new Map<string, DimAgg>(), byCat: new Map<string, DimAgg>(),
        };
        agg.kmYear += kmInside * runs;
        agg.runsYear += runs;
        for (const [k, n] of calRuns) {
          const e = agg.byCal.get(k) ?? { kmYear: 0, runsYear: 0 };
          e.kmYear += kmInside * n; e.runsYear += n;
          agg.byCal.set(k, e);
          globalCalKm.set(k, (globalCalKm.get(k) ?? 0) + kmInside * n);
        }
        for (const [k, n] of dowRuns) {
          const e = agg.byDow.get(k) ?? { kmYear: 0, runsYear: 0 };
          e.kmYear += kmInside * n; e.runsYear += n;
          agg.byDow.set(k, e);
          globalDowKm.set(k, (globalDowKm.get(k) ?? 0) + kmInside * n);
        }
        for (const [k, n] of catRuns) {
          const e = agg.byCat.get(k) ?? { kmYear: 0, runsYear: 0 };
          e.kmYear += kmInside * n; e.runsYear += n;
          agg.byCat.set(k, e);
          globalCatKm.set(k, (globalCatKm.get(k) ?? 0) + kmInside * n);
        }
        byRoute.set(v.routeId, agg);
      }
      // tratti di shape fuori da ogni comune (clamp: zone sovrapposte → 0)
      const outside = Math.max(0, v.totalKm - insideSum);
      unassignedKm += outside * runs;
    }

    // Ordine di visualizzazione dei giorni: lun → dom
    const DOW_ORDER: Record<string, number> = {
      monday: 0, tuesday: 1, wednesday: 2, thursday: 3, friday: 4, saturday: 5, sunday: 6,
    };

    const zonesOut = zones
      .map((z) => {
        const byRouteMap = zoneAgg.get(z.id);
        if (!byRouteMap || byRouteMap.size === 0) return null;
        const byRoute = Array.from(byRouteMap.values())
          .map((a) => ({
            routeId: a.routeId,
            shortName: a.shortName,
            color: a.color,
            kmYear: r1(a.kmYear),
            runsYear: a.runsYear,
            kmPerRun: r1(a.runsYear > 0 ? a.kmYear / a.runsYear : 0),
            byCalendar: Array.from(a.byCal.entries())
              .map(([calId, e]) => ({
                calendarId: calId, code: calCode(calId), name: calLabel(calId),
                kmYear: r1(e.kmYear), runsYear: e.runsYear,
              }))
              .sort((x, y) => y.kmYear - x.kmYear),
            byWeekday: Array.from(a.byDow.entries())
              .map(([dow, e]) => ({ dow, kmYear: r1(e.kmYear), runsYear: e.runsYear }))
              .sort((x, y) => (DOW_ORDER[x.dow] ?? 9) - (DOW_ORDER[y.dow] ?? 9)),
            byCategory: Array.from(a.byCat.entries())
              .map(([key, e]) => ({
                key,
                name: CATEGORY_META[key]?.name ?? key,
                color: CATEGORY_META[key]?.color ?? null,
                kmYear: r1(e.kmYear), runsYear: e.runsYear,
              }))
              .sort((x, y) => (CATEGORY_META[x.key]?.order ?? 9) - (CATEGORY_META[y.key]?.order ?? 9)),
          }))
          .sort((a, b) => b.kmYear - a.kmYear);
        const totalKmYear = r1(Array.from(byRouteMap.values()).reduce((s, a) => s + a.kmYear, 0));
        return { zoneId: z.id, name: z.name, istatCode: z.istatCode, totalKmYear, byRoute };
      })
      .filter((z): z is NonNullable<typeof z> => z !== null)
      .sort((a, b) => b.totalKmYear - a.totalKmYear);

    // Definizioni calendari aziendali usate nel calcolo (per la legenda dell'export)
    const usedCalIds = new Set<string>([...globalCalRuns.keys()]);
    const calendars = calRows
      .map((c) => ({
        id: c.id as string,
        code: (c.code as string | null) ?? null,
        name: (c.name as string) || (c.code as string) || "Calendario",
        weekdays: calMeta.get(c.id)?.weekdays ?? null,
        startDate: (c.start_date as string | null) ?? null,
        endDate: (c.end_date as string | null) ?? null,
        activeDays: calMeta.get(c.id)?.activeDays ?? 0,
        runsYear: globalCalRuns.get(c.id) ?? 0,
        kmYear: r1(globalCalKm.get(c.id) ?? 0),
      }))
      .sort((a, b) => b.kmYear - a.kmYear);
    // Calendario sintetico "senza calendario", se presente
    if (usedCalIds.has(NO_CAL)) {
      calendars.push({
        id: NO_CAL, code: null, name: "Senza calendario (solo eccezioni)",
        weekdays: null, startDate: null, endDate: null, activeDays: 0,
        runsYear: globalCalRuns.get(NO_CAL) ?? 0,
        kmYear: r1(globalCalKm.get(NO_CAL) ?? 0),
      });
    }

    // Totali di rete per calendario e per giorno (km dentro i comuni)
    const totalsByCalendar = calendars
      .map((c) => ({ calendarId: c.id, code: c.code, name: c.name, kmYear: c.kmYear, runsYear: c.runsYear }))
      .filter((c) => c.kmYear > 0)
      .sort((a, b) => b.kmYear - a.kmYear);
    const totalsByWeekday = Object.keys(DOW_ORDER)
      .sort((a, b) => DOW_ORDER[a] - DOW_ORDER[b])
      .map((dow) => ({ dow, kmYear: r1(globalDowKm.get(dow) ?? 0), runsYear: globalDowRuns.get(dow) ?? 0 }));
    const totalsByCategory = Object.keys(CATEGORY_META)
      .sort((a, b) => CATEGORY_META[a].order - CATEGORY_META[b].order)
      .map((key) => ({
        key,
        name: CATEGORY_META[key].name,
        color: CATEGORY_META[key].color,
        kmYear: r1(globalCatKm.get(key) ?? 0),
        runsYear: globalCatRuns.get(key) ?? 0,
      }))
      .filter((c) => c.kmYear > 0 || c.runsYear > 0);

    res.json({
      year,
      zones: zonesOut,
      unassignedKm: r1(unassignedKm),
      calendars,
      totals: { byCalendar: totalsByCalendar, byWeekday: totalsByWeekday, byCategory: totalsByCategory },
      meta: {
        zoneCount: zones.length,
        variantCount: variants.length,
        tripCount: trips.length,
      },
    });
  } catch (e: any) {
    console.error("[ps-zones.compute] error:", e?.message || e);
    res.status(500).json({ error: e?.message || "internal_error" });
  }
});

export default router;
