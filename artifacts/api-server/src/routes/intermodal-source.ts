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

export interface Bbox { minLat: number; maxLat: number; minLng: number; maxLng: number }

/**
 * Bounding box delle fermate del progetto (con tolleranza), o null fuori da
 * un progetto. Serve a confinare i poli attrattori (POI) all'AREA della rete:
 * senza, la copertura della domanda pescava i POI di tutta la provincia —
 * poli a decine di km che un urbano non può servire — e il "servito %"
 * risultava schiacciato a zero.
 */
export async function projectBbox(src: Source, padKm = 1.5): Promise<Bbox | null> {
  if (src.kind !== "ps" || !src.psProjectId) return null;
  const r = await db.execute<any>(sql`
    SELECT min(lat) AS min_lat, max(lat) AS max_lat, min(lon) AS min_lng, max(lon) AS max_lng
      FROM ps_stops WHERE project_id = ${src.psProjectId}::uuid`);
  const b = (r as any).rows?.[0];
  if (b?.min_lat == null) return null;
  const padLat = padKm / 111;                    // ~111 km per grado di latitudine
  const padLng = padKm / 85;                     // ~85 km per grado a lat. 43° (Marche)
  return {
    minLat: Number(b.min_lat) - padLat, maxLat: Number(b.max_lat) + padLat,
    minLng: Number(b.min_lng) - padLng, maxLng: Number(b.max_lng) + padLng,
  };
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

/* ── Validità (calendari del progetto) ───────────────────────────────── */
export interface SrcValidity {
  id: string; code: string; name: string | null;
  days: boolean[];           // lun..dom
  startDate: string | null; endDate: string | null;
  trips: number;
}

/** Le validità del progetto, con quante corse ciascuna porta con sé. */
export async function loadValidities(src: Source): Promise<SrcValidity[]> {
  if (src.kind !== "ps") return [];
  const cal = await db.execute<any>(sql`
    SELECT c.id::text AS id, c.code, c.name,
           c.monday, c.tuesday, c.wednesday, c.thursday, c.friday, c.saturday, c.sunday,
           c.start_date::text AS start_date, c.end_date::text AS end_date,
           (SELECT count(*) FROM ps_trips t WHERE t.calendar_id = c.id)::int AS trips
      FROM ps_calendars c
     WHERE c.project_id = ${src.psProjectId}::uuid
     ORDER BY c.code`);
  return ((cal as any).rows ?? []).map((x: any) => ({
    id: String(x.id), code: x.code ?? String(x.id), name: x.name ?? null,
    days: [x.monday, x.tuesday, x.wednesday, x.thursday, x.friday, x.saturday, x.sunday].map(Boolean),
    startDate: x.start_date ?? null, endDate: x.end_date ?? null,
    trips: Number(x.trips ?? 0),
  }));
}

/* ── Giorni-tipo dal CALENDARIO AZIENDALE ────────────────────────────
 * "feriale / sabato / festivo" è una semplificazione che l'azienda non
 * usa: il calendario aziendale distingue Lu-Ve scuole aperte, Lu-Ve
 * scuole chiuse, sabato scolastico, sabato estivo, festivo… e ogni corsa
 * appartiene a una o più di queste categorie. Sono QUELLE i giorni-tipo
 * su cui ha senso analizzare un orario. */
export interface SrcDayType {
  id: string; code: string; name: string; color: string | null;
  /** quante corse del progetto appartengono a questa categoria */
  trips: number;
  /** quanti giorni dell'anno ricadono in questa categoria */
  giorni: number;
}

export async function loadDayTypes(src: Source): Promise<SrcDayType[]> {
  if (src.kind !== "ps") return [];
  try {
    const r = await db.execute<any>(sql`
      SELECT c.id::text AS id, c.code, c.name, c.color, c.sort_order,
             (SELECT count(*) FROM ps_trip_category_validity tcv
                JOIN ps_trips t ON t.id = tcv.trip_id
               WHERE tcv.category_id = c.id AND t.project_id = ${src.psProjectId}::uuid)::int AS trips,
             (SELECT count(*) FROM ps_validity_category_calendar cc
               WHERE cc.category_id = c.id)::int AS giorni
        FROM ps_validity_categories c
       WHERE c.project_id = ${src.psProjectId}::uuid OR c.project_id IS NULL
       ORDER BY c.sort_order, c.name`);
    return ((r as any).rows ?? []).map((x: any) => ({
      id: String(x.id), code: x.code, name: x.name, color: x.color ?? null,
      trips: Number(x.trips ?? 0), giorni: Number(x.giorni ?? 0),
    }));
  } catch {
    return []; // tabelle categorie assenti su progetti vecchi
  }
}

/* ── Corse circolanti nel giorno-tipo ────────────────────────────────── */
/**
 * tripId → routeId delle sole corse attive nel giorno scelto.
 * Se il progetto/feed non ha calendari, non si filtra (meglio contare
 * tutto che restituire zero corse e far sembrare la rete inesistente).
 */
export async function loadActiveTrips(
  src: Source, day: DayKind, calendarId?: string | null, categoryId?: string | null,
): Promise<Map<string, string>> {
  const col = DAY_COLUMN[day];
  const out = new Map<string, string>();

  if (src.kind === "ps") {
    /* GIORNO-TIPO AZIENDALE: si prendono le corse che appartengono a quella
     * categoria del calendario (Lu-Ve scuole chiuse, sabato estivo…). È il
     * modo in cui l'azienda ragiona davvero sull'orario. */
    if (categoryId && UUID_RE.test(categoryId)) {
      const trips = await db.execute<any>(sql`
        SELECT t.id::text AS trip_id, t.route_id::text AS route_id
          FROM ps_trips t
          JOIN ps_trip_category_validity tcv ON tcv.trip_id = t.id
         WHERE t.project_id = ${src.psProjectId}::uuid AND tcv.category_id = ${categoryId}::uuid`);
      for (const t of ((trips as any).rows ?? [])) out.set(String(t.trip_id), String(t.route_id));
      return out;
    }
    /* Con una VALIDITÀ scelta si guardano solo le corse di quel calendario:
     * è più preciso del giorno-tipo, perché una rete reale ha più validità
     * che insistono sullo stesso giorno (scolastico, estivo, festivo…) e
     * sommarle darebbe un orario che non esiste in nessun periodo. */
    if (calendarId && UUID_RE.test(calendarId)) {
      const trips = await db.execute<any>(sql`
        SELECT id::text AS trip_id, route_id::text AS route_id
          FROM ps_trips
         WHERE project_id = ${src.psProjectId}::uuid AND calendar_id = ${calendarId}::uuid`);
      for (const t of ((trips as any).rows ?? [])) out.set(String(t.trip_id), String(t.route_id));
      return out;
    }
    const cal = await db.execute<any>(sql`
      SELECT id::text AS id FROM ps_calendars
       WHERE project_id = ${src.psProjectId}::uuid AND ${sql.raw(col)} = true`);
    const active = new Set<string>(((cal as any).rows ?? []).map((x: any) => String(x.id)));
    /* Filtriamo per giorno SOLO se il progetto usa davvero i flag settimanali
     * (lunedì…domenica) sui calendari. Molte reti aziendali modellano la
     * validità come periodi/categorie e lasciano quei flag a zero: in quel
     * caso "active" sarebbe vuoto e scartare ogni corsa con calendar_id
     * azzererebbe l'intera rete — la corsa c'è, ma il giorno-tipo generico la
     * buttava via. Senza flag settimanali si contano tutte le corse. */
    const flags = await db.execute<any>(sql`
      SELECT count(*)::int AS n FROM ps_calendars
       WHERE project_id = ${src.psProjectId}::uuid
         AND (monday OR tuesday OR wednesday OR thursday OR friday OR saturday OR sunday)`);
    const weekdayModelUsed = Number((flags as any).rows?.[0]?.n ?? 0) > 0;

    const trips = await db.execute<any>(sql`
      SELECT id::text AS trip_id, route_id::text AS route_id, calendar_id::text AS calendar_id
        FROM ps_trips WHERE project_id = ${src.psProjectId}::uuid`);
    for (const t of ((trips as any).rows ?? [])) {
      if (weekdayModelUsed && t.calendar_id && !active.has(String(t.calendar_id))) continue;
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

  /* Nel progetto le fermate hanno id uuid, ma tra gli id in ingresso
   * arrivano anche i gtfsStopIds cablati degli hub curati ("13", "18"…):
   * castarli a uuid fa fallire l'intera query con "invalid input syntax
   * for type uuid", e l'analisi restituiva 500. Si tengono solo gli id
   * che possono davvero appartenere alla sorgente. */
  const ids = src.kind === "ps" ? stopIds.filter(id => UUID_RE.test(id)) : stopIds;
  if (ids.length === 0) return out;

  for (let i = 0; i < ids.length; i += 500) {
    const batch = ids.slice(i, i + 500);
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
