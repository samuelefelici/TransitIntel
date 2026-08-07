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

/* ── Corse che circolano in una DATA precisa ─────────────────────────────
 * È l'"intreccio" vero del calendario aziendale con le validità delle
 * singole corse, la stessa regola delle unità di validità (UDP):
 *   1. eccezioni per corsa (ps_trip_exceptions: forzata sì/no in quel giorno)
 *   2. calendario della corsa (ps_calendars: giorni settimana + range,
 *      con le eccezioni ps_calendar_dates) — è qui che vivono le validità
 *      tipo "682_CodUdp:D1885" o "Unione corse gemelle"
 *   3. in mancanza di calendario: matrice corsa × giorno-tipo
 *      (ps_trip_day_validity, se il progetto la usa)
 *   4. maschera giorni-settimana della corsa (attributes.weekdays)
 *   5. vincolo categorie del calendario aziendale (una corsa marcata
 *      "Scuole Chiuse" vale solo nei giorni di quella classe). */
export async function tripsOnDate(projectId: string, iso: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const [yy, mm, dd] = iso.split("-").map(Number);
  const dow = new Date(Date.UTC(yy, mm - 1, dd)).getUTCDay(); // 0=dom
  const wdIdx = (dow + 6) % 7;                                // 0=lun (attributes.weekdays)
  const DOWCOLS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const col = DOWCOLS[dow];

  const rows = await db.execute<any>(sql`
    SELECT t.id::text AS trip_id, t.route_id::text AS route_id, t.attributes,
           c.id::text AS cal_id,
           c.monday, c.tuesday, c.wednesday, c.thursday, c.friday, c.saturday, c.sunday,
           c.start_date::text AS cal_start, c.end_date::text AS cal_end
      FROM ps_trips t
      LEFT JOIN ps_calendars c ON c.id = t.calendar_id
     WHERE t.project_id = ${projectId}::uuid
       AND COALESCE(t.is_active, true) = true
       AND COALESCE((t.attributes->>'prototype')::boolean, false) = false
       AND (t.valid_from IS NULL OR t.valid_from <= ${iso}::date)
       AND (t.valid_to   IS NULL OR t.valid_to   >= ${iso}::date)`);
  const trips = ((rows as any).rows ?? []) as any[];
  if (trips.length === 0) return out;

  // Eccezioni del calendario legacy per la data (1 = aggiunta, 2 = rimossa)
  const excCal = new Map<string, number>();
  try {
    const r = await db.execute<any>(sql`
      SELECT cd.calendar_id::text AS cal_id, cd.exception_type
        FROM ps_calendar_dates cd JOIN ps_calendars c ON c.id = cd.calendar_id
       WHERE c.project_id = ${projectId}::uuid AND cd.date = ${iso}::date`);
    for (const x of ((r as any).rows ?? [])) excCal.set(String(x.cal_id), Number(x.exception_type));
  } catch { /* tabella assente */ }

  // Eccezioni per corsa nella data
  const excTrip = new Map<string, number>();
  try {
    const r = await db.execute<any>(sql`
      SELECT e.trip_id::text AS trip_id, e.exception_type
        FROM ps_trip_exceptions e JOIN ps_trips t ON t.id = e.trip_id
       WHERE t.project_id = ${projectId}::uuid AND e.date = ${iso}::date`);
    for (const x of ((r as any).rows ?? [])) excTrip.set(String(x.trip_id), Number(x.exception_type));
  } catch { /* tabella assente */ }

  // Matrice corsa × giorno-tipo (solo per corse SENZA calendario legacy)
  let tdv: Map<string, boolean> | null = null;
  try {
    const dtR = await db.execute<any>(sql`
      SELECT day_type_id::text AS id FROM ps_day_calendar
       WHERE date = ${iso}::date AND (project_id = ${projectId}::uuid OR project_id IS NULL)
       ORDER BY project_id NULLS LAST LIMIT 1`);
    let dayTypeId: string | null = ((dtR as any).rows?.[0]?.id as string | undefined) ?? null;
    if (!dayTypeId) {
      const code = dow === 0 ? "festivo" : dow === 6 ? "sabato" : "feriale";
      const sysR = await db.execute<any>(sql`
        SELECT id::text AS id FROM ps_day_types WHERE project_id IS NULL AND code = ${code} LIMIT 1`);
      dayTypeId = ((sysR as any).rows?.[0]?.id as string | undefined) ?? null;
    }
    if (dayTypeId) {
      const r = await db.execute<any>(sql`
        SELECT v.trip_id::text AS trip_id, v.is_valid
          FROM ps_trip_day_validity v JOIN ps_trips t ON t.id = v.trip_id
         WHERE t.project_id = ${projectId}::uuid AND v.day_type_id = ${dayTypeId}::uuid`);
      tdv = new Map();
      for (const x of ((r as any).rows ?? [])) tdv.set(String(x.trip_id), !!x.is_valid);
    }
  } catch { /* tabelle assenti: si resta sul calendario legacy */ }

  // Vincolo categorie del calendario aziendale (guardato: tabelle opzionali)
  const tripCats = new Map<string, Set<string>>();
  const umbrellaChiuse = new Set<string>();
  let catOfDate: { id: string; code: string | null } | null = null;
  try {
    const cR = await db.execute<any>(sql`
      SELECT DISTINCT ON (c.date) c.category_id::text AS id, cat.code
        FROM ps_validity_category_calendar c
        LEFT JOIN ps_validity_categories cat ON cat.id = c.category_id
       WHERE (c.project_id = ${projectId}::uuid OR c.project_id IS NULL) AND c.date = ${iso}::date
       ORDER BY c.date, c.project_id ASC NULLS LAST`);
    const row = ((cR as any).rows ?? [])[0];
    if (row) catOfDate = { id: String(row.id), code: row.code ?? null };
    const tcR = await db.execute<any>(sql`
      SELECT tc.trip_id::text AS trip_id, tc.category_id::text AS category_id, cat.code
        FROM ps_trip_category_validity tc
        JOIN ps_trips t ON t.id = tc.trip_id
        LEFT JOIN ps_validity_categories cat ON cat.id = tc.category_id
       WHERE t.project_id = ${projectId}::uuid`);
    for (const x of ((tcR as any).rows ?? [])) {
      const id = String(x.trip_id);
      if (!tripCats.has(id)) tripCats.set(id, new Set());
      tripCats.get(id)!.add(String(x.category_id));
      if (x.code === "scuole_chiuse") umbrellaChiuse.add(id);
    }
  } catch { /* tabelle assenti */ }

  for (const t of trips) {
    const id = String(t.trip_id);
    const exc = excTrip.get(id);
    let active: boolean;
    if (exc === 2) active = false;
    else if (exc === 1) active = true;
    else if (t.cal_id) {
      active = !!t[col]
        && (!t.cal_start || t.cal_start <= iso)
        && (!t.cal_end || t.cal_end >= iso);
      const ce = excCal.get(String(t.cal_id));
      if (ce === 1) active = true; else if (ce === 2) active = false;
    } else if (tdv) {
      active = tdv.get(id) ?? false;
    } else {
      active = true; // nessun sistema di validità configurato: non si filtra
    }
    const wd = t.attributes?.weekdays;
    if (active && Array.isArray(wd) && wd.length === 7 && wd[wdIdx] === false) active = false;
    const cats = tripCats.get(id);
    if (active && cats && cats.size > 0) {
      let match = !!catOfDate && cats.has(catOfDate.id);
      if (!match && catOfDate?.code && umbrellaChiuse.has(id) && catOfDate.code.startsWith("scuole_chiuse")) {
        match = true;
      }
      active = match;
    }
    if (active) out.set(id, String(t.route_id));
  }
  return out;
}

export async function loadDayTypes(src: Source): Promise<SrcDayType[]> {
  if (src.kind !== "ps") return [];
  try {
    /* Il CALENDARIO AZIENDALE della pagina /calendar è il profilo a classi
     * (planning-studio-calendar + day-classifier): "Scuole Aperte",
     * "Scuole Chiuse · Estivo", "Festivo"… Qui si enumerano i prossimi 120
     * giorni, si classifica ciascuno, e ogni classe diventa un'opzione del
     * periodo con una DATA RAPPRESENTATIVA (la prima occorrenza): l'analisi
     * gira su un giorno che esiste davvero, con le corse che circolano
     * davvero quel giorno secondo l'intreccio completo delle validità. */
    const { loadCalendarProfile } = await import("../lib/planning-studio-calendar");
    const { classifyDate, italianHolidays } = await import("../lib/day-classifier");
    const profile = await loadCalendarProfile(src.psProjectId!);
    const holidaysByYear = new Map<number, Set<string>>();
    const classes = new Map<string, { key: string; label: string; dates: string[] }>();
    const base = new Date();
    for (let i = 0; i < 120; i++) {
      const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i);
      const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const y = d.getFullYear();
      if (!holidaysByYear.has(y)) holidaysByYear.set(y, italianHolidays(y));
      const c = classifyDate(iso, profile, holidaysByYear.get(y));
      const e = classes.get(c.key) ?? { key: c.key, label: c.label, dates: [] };
      e.dates.push(iso);
      classes.set(c.key, e);
    }
    const GG = ["dom", "lun", "mar", "mer", "gio", "ven", "sab"];
    const out: SrcDayType[] = [];
    for (const c of classes.values()) {
      const rep = c.dates[0];
      const trips = await tripsOnDate(src.psProjectId!, rep);
      const [ry, rm, rd] = rep.split("-").map(Number);
      const gg = GG[new Date(Date.UTC(ry, rm - 1, rd)).getUTCDay()];
      out.push({
        id: `date:${rep}`,
        code: c.key,
        name: `${c.label} · es. ${gg} ${String(rd).padStart(2, "0")}/${String(rm).padStart(2, "0")}`,
        color: null,
        trips: trips.size,
        giorni: 0, // l'etichetta "gg/anno" non ha senso su un orizzonte di 120 giorni
      });
    }
    out.sort((a, b) => a.id.localeCompare(b.id)); // prima occorrenza più vicina in cima
    return out;
  } catch {
    return []; // profilo calendario assente
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
    /* Classe del calendario aziendale, risolta su una data rappresentativa:
     * si calcolano le corse che circolano DAVVERO quel giorno (intreccio
     * completo: eccezioni, calendario della corsa, matrice giorno-tipo,
     * maschera settimanale, vincolo categorie). */
    if (categoryId && categoryId.startsWith("date:")) {
      const iso = categoryId.slice(5);
      if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return tripsOnDate(src.psProjectId!, iso);
    }
    if (categoryId && UUID_RE.test(categoryId)) {
      const trips = await db.execute<any>(sql`
        SELECT t.id::text AS trip_id, t.route_id::text AS route_id
          FROM ps_trips t
          JOIN ps_trip_day_validity v ON v.trip_id = t.id
         WHERE t.project_id = ${src.psProjectId}::uuid
           AND v.day_type_id = ${categoryId}::uuid
           AND v.is_valid = true`);
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
