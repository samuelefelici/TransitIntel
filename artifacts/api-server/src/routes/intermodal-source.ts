/* ═══════════════════════════════════════════════════════════════════════
 *  SORGENTE DATI DELL'INTERMODALE — il progetto vivo, non uno snapshot
 *
 *  L'Intermodale leggeva le tabelle gtfs_*, risolvendo il feed come
 *  "materialized_feed_id, altrimenti source_feed_id". Sono ENTRAMBI
 *  snapshot:
 *    ▸ il feed materializzato si aggiorna solo quando si mette in
 *      esercizio il progetto, quindi resta indietro rispetto al lavoro
 *      in corso;
 *    ▸ il feed sorgente è il GTFS importato all'inizio, cioè lo stato
 *      PRIMA di qualunque modifica.
 *  Effetto: cancellavi una linea dal progetto e l'Intermodale continuava
 *  a valutarla, perché stava guardando un'altra fotografia della rete.
 *
 *  Qui la rete del progetto si legge dalle ps_* — le stesse tabelle che
 *  vedono Corse, Grafico e l'editor — così una modifica si riflette
 *  subito. Il ramo GTFS resta solo per l'uso fuori da un progetto
 *  (pagina standalone, flusso embedded della Fucina).
 * ═══════════════════════════════════════════════════════════════════════ */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { getLatestFeedId } from "./gtfs-helpers";

const UUID_RE = /^[0-9a-f-]{36}$/i;

export type DayKind = "feriale" | "sabato" | "festivo";
const DAY_COLUMN: Record<DayKind, string> = {
  feriale: "wednesday", sabato: "saturday", festivo: "sunday",
};

export function parseDayKind(v: unknown): DayKind {
  const s = String(v ?? "").toLowerCase();
  if (s === "sabato" || s === "saturday") return "sabato";
  if (s === "festivo" || s === "domenica" || s === "sunday") return "festivo";
  return "feriale";
}

/** Da dove arrivano i dati: dal progetto (vivo) o da un feed GTFS. */
export interface Source {
  kind: "ps" | "gtfs";
  psProjectId: string | null;
  feedId: string | null;
}

export interface SrcStop { stopId: string; stopName: string; lat: number; lng: number }
export interface SrcRoute { routeId: string; shortName: string | null; longName: string | null; color: string | null }
/** Un passaggio: corsa, fermata, orario (minuti) e linea di appartenenza. */
export interface SrcPassage {
  stopId: string; tripId: string; routeId: string; time: number;
  /** orari grezzi e sequenza: servono all'analisi coincidenze */
  departureTime: string | null; arrivalTime: string | null; stopSequence: number | null;
}

/**
 * Risolve la sorgente. Con ?psProjectId= valido si lavora SEMPRE sul
 * progetto vivo: nessun fallback silenzioso al feed, che rimetterebbe in
 * gioco proprio i dati sbagliati che si vogliono evitare.
 */
export async function resolveSource(req: any): Promise<Source> {
  const psProjectId = String(req?.query?.psProjectId ?? "").trim();
  if (UUID_RE.test(psProjectId)) {
    const r = await db.execute<any>(sql`SELECT id FROM ps_projects WHERE id = ${psProjectId}::uuid`);
    if (((r as any).rows ?? []).length > 0) {
      return { kind: "ps", psProjectId, feedId: null };
    }
  }
  return { kind: "gtfs", psProjectId: null, feedId: await getLatestFeedId(req) };
}

const hhmmToMin = (t: string | null): number | null => {
  if (!t) return null;
  const m = /^(\d{1,3}):(\d{2})/.exec(t);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
};

/* ── Fermate ─────────────────────────────────────────────────────────── */
export async function loadStops(src: Source): Promise<SrcStop[]> {
  if (src.kind === "ps") {
    const r = await db.execute<any>(sql`
      SELECT id::text AS stop_id, name, lat, lon FROM ps_stops WHERE project_id = ${src.psProjectId}::uuid`);
    return ((r as any).rows ?? []).map((x: any) => ({
      stopId: String(x.stop_id), stopName: x.name ?? String(x.stop_id),
      lat: Number(x.lat), lng: Number(x.lon),
    })).filter((s: SrcStop) => Number.isFinite(s.lat) && Number.isFinite(s.lng));
  }
  if (!src.feedId) return [];
  const r = await db.execute<any>(sql`
    SELECT stop_id, stop_name, stop_lat, stop_lon FROM gtfs_stops WHERE feed_id = ${src.feedId}::uuid`);
  return ((r as any).rows ?? []).map((x: any) => ({
    stopId: String(x.stop_id), stopName: x.stop_name ?? String(x.stop_id),
    lat: Number(x.stop_lat), lng: Number(x.stop_lon),
  })).filter((s: SrcStop) => Number.isFinite(s.lat) && Number.isFinite(s.lng));
}

/* ── Linee ───────────────────────────────────────────────────────────── */
export async function loadRoutes(src: Source): Promise<SrcRoute[]> {
  if (src.kind === "ps") {
    const r = await db.execute<any>(sql`
      SELECT id::text AS route_id, code, short_name, long_name, color
        FROM ps_routes WHERE project_id = ${src.psProjectId}::uuid`);
    return ((r as any).rows ?? []).map((x: any) => ({
      routeId: String(x.route_id),
      // Il codice di linea è quello che l'utente legge in Corse e sulle stampe
      shortName: x.code || x.short_name || null,
      longName: x.long_name ?? null,
      color: x.color ?? null,
    }));
  }
  if (!src.feedId) return [];
  const r = await db.execute<any>(sql`
    SELECT route_id, route_short_name, route_long_name, route_color
      FROM gtfs_routes WHERE feed_id = ${src.feedId}::uuid`);
  return ((r as any).rows ?? []).map((x: any) => ({
    routeId: String(x.route_id),
    shortName: x.route_short_name ?? null,
    longName: x.route_long_name ?? null,
    color: x.route_color ?? null,
  }));
}

/* ── Corse circolanti nel giorno-tipo ────────────────────────────────── */
/**
 * tripId → routeId delle sole corse attive nel giorno scelto.
 * Se il progetto/feed non ha calendari, non si filtra (meglio contare
 * tutto che restituire zero corse e far sembrare la rete inesistente).
 */
export async function loadActiveTrips(src: Source, day: DayKind): Promise<Map<string, string>> {
  const col = DAY_COLUMN[day];
  const out = new Map<string, string>();

  if (src.kind === "ps") {
    const cal = await db.execute<any>(sql`
      SELECT id::text AS id FROM ps_calendars
       WHERE project_id = ${src.psProjectId}::uuid AND ${sql.raw(col)} = true`);
    const active = new Set<string>(((cal as any).rows ?? []).map((x: any) => String(x.id)));
    const hasCalendars = await db.execute<any>(sql`
      SELECT count(*)::int AS n FROM ps_calendars WHERE project_id = ${src.psProjectId}::uuid`);
    const anyCal = Number((hasCalendars as any).rows?.[0]?.n ?? 0) > 0;

    const trips = await db.execute<any>(sql`
      SELECT id::text AS trip_id, route_id::text AS route_id, calendar_id::text AS calendar_id
        FROM ps_trips WHERE project_id = ${src.psProjectId}::uuid`);
    for (const t of ((trips as any).rows ?? [])) {
      if (anyCal && t.calendar_id && !active.has(String(t.calendar_id))) continue;
      out.set(String(t.trip_id), String(t.route_id));
    }
    return out;
  }

  if (!src.feedId) return out;
  const cal = await db.execute<any>(sql`
    SELECT service_id FROM gtfs_calendar
     WHERE feed_id = ${src.feedId}::uuid AND ${sql.raw(col)} = true`);
  const active = new Set<string>(((cal as any).rows ?? []).map((x: any) => String(x.service_id)));
  const trips = await db.execute<any>(sql`
    SELECT trip_id, route_id, service_id FROM gtfs_trips WHERE feed_id = ${src.feedId}::uuid`);
  for (const t of ((trips as any).rows ?? [])) {
    if (active.size > 0 && t.service_id && !active.has(String(t.service_id))) continue;
    out.set(String(t.trip_id), String(t.route_id));
  }
  return out;
}

/* ── Passaggi alle fermate indicate ──────────────────────────────────── */
export async function loadPassages(
  src: Source, stopIds: string[], activeTrips: Map<string, string>,
): Promise<SrcPassage[]> {
  const out: SrcPassage[] = [];
  if (stopIds.length === 0) return out;

  for (let i = 0; i < stopIds.length; i += 500) {
    const batch = stopIds.slice(i, i + 500);
    if (batch.length === 0) continue;
    const rows = src.kind === "ps"
      ? await db.execute<any>(sql`
          SELECT st.stop_id::text AS stop_id, st.trip_id::text AS trip_id,
                 st.departure_time, st.arrival_time, st.stop_seq AS stop_sequence
            FROM ps_stop_times st
           WHERE st.stop_id IN (${sql.join(batch.map(id => sql`${id}::uuid`), sql`, `)})`)
      : await db.execute<any>(sql`
          SELECT stop_id, trip_id, departure_time, arrival_time, stop_sequence
            FROM gtfs_stop_times
           WHERE feed_id = ${src.feedId}::uuid
             AND stop_id IN (${sql.join(batch.map(id => sql`${id}`), sql`, `)})`);
    for (const r of ((rows as any).rows ?? [])) {
      const routeId = activeTrips.get(String(r.trip_id));
      if (!routeId) continue;               // corsa non circolante in questo giorno
      const t = hhmmToMin(r.departure_time) ?? hhmmToMin(r.arrival_time);
      if (t == null) continue;
      out.push({
        stopId: String(r.stop_id), tripId: String(r.trip_id), routeId, time: t,
        departureTime: r.departure_time ?? null, arrivalTime: r.arrival_time ?? null,
        stopSequence: r.stop_sequence != null ? Number(r.stop_sequence) : null,
      });
    }
  }
  return out;
}

/* ── Geometrie delle linee ───────────────────────────────────────────── */
/** GeoJSON dei percorsi, per disegnare sulla mappa le linee selezionate. */
export async function loadShapes(
  src: Source, routeFilter: Set<string> | null,
): Promise<{ type: "FeatureCollection"; features: any[]; total: number }> {
  const features: any[] = [];

  if (src.kind === "ps") {
    const rows = await db.execute<any>(sql`
      SELECT s.geometry, v.route_id::text AS route_id, r.code, r.short_name, r.color
        FROM ps_shapes s
        JOIN ps_route_variants v ON v.id = s.variant_id
        JOIN ps_routes r ON r.id = v.route_id
       WHERE s.project_id = ${src.psProjectId}::uuid`);
    for (const r of ((rows as any).rows ?? [])) {
      if (routeFilter && !routeFilter.has(String(r.route_id))) continue;
      const geom = r.geometry;
      if (!geom) continue;
      features.push({
        type: "Feature",
        geometry: geom.type ? geom : geom.geometry ?? null,
        properties: {
          routeId: String(r.route_id),
          routeShortName: r.code || r.short_name || null,
          routeColor: r.color ? (String(r.color).startsWith("#") ? r.color : `#${r.color}`) : null,
        },
      });
    }
    return { type: "FeatureCollection", features: features.filter(f => f.geometry), total: features.length };
  }

  if (!src.feedId) return { type: "FeatureCollection", features: [], total: 0 };
  const rows = await db.execute<any>(sql`
    SELECT sh.shape_id, sh.route_id, sh.geojson, r.route_short_name, r.route_color
      FROM gtfs_shapes sh
      LEFT JOIN gtfs_routes r ON r.feed_id = sh.feed_id AND r.route_id = sh.route_id
     WHERE sh.feed_id = ${src.feedId}::uuid`);
  for (const r of ((rows as any).rows ?? [])) {
    if (routeFilter && (!r.route_id || !routeFilter.has(String(r.route_id)))) continue;
    if (!r.geojson) continue;
    const g = r.geojson;
    features.push({
      type: "Feature",
      geometry: g.geometry ?? g,
      properties: {
        routeId: r.route_id ? String(r.route_id) : null,
        routeShortName: r.route_short_name ?? null,
        routeColor: r.route_color ? `#${String(r.route_color).replace(/^#/, "")}` : null,
      },
    });
  }
  return { type: "FeatureCollection", features: features.filter(f => f.geometry), total: features.length };
}
