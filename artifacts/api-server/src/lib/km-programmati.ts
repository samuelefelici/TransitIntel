/**
 * I km programmati di un programma di Planning Studio: una sola funzione
 * (PR 3.5, contratto C5 dell'analisi).
 *
 * Prima i km dello stesso programma si contavano in tre modi:
 *   - GTFS in esercizio, UDP e turni: la circolazione vera (matrice di
 *     validità, eccezioni, periodo della corsa: planning-studio-validity-eval);
 *   - «Elenco corse / km annui per categoria»: la matrice, senza periodo né
 *     eccezioni;
 *   - «Zonizzazione / km per comune»: i calendari settimanali, senza matrice.
 * E la lunghezza del percorso era quella che mandava il browser.
 *
 * Da qui, per tutti (scelta del 15/11):
 *
 *   km = giorni in cui la corsa circola davvero × lunghezza del suo percorso
 *
 *  - i giorni sono quelli del GTFS materializzato (lib/materializzazione/feed.ts)
 *    e delle UDP: se il progetto usa la matrice di validità, quelli di
 *    computeActiveDatesByTrip (matrice, eccezioni, periodo della corsa);
 *    altrimenti i calendari settimanali con le loro eccezioni, e 7 giorni su 7
 *    per le corse senza calendario (giorniDiCircolazione);
 *  - la lunghezza la calcola il server dalla geometria del percorso (somma
 *    delle distanze fra i punti) e la salva in ps_shapes.distance_m; senza
 *    geometria, dalla sequenza delle fermate. Mai dal valore mandato dal
 *    browser, né da shape_dist_traveled, che nei file importati può essere in
 *    km o in metri.
 *
 * Le corse prototipo («corse zero») e quelle disattivate non fanno km.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { computeActiveDatesByTrip, projectHasTripValidity } from "./planning-studio-validity-eval";

const RAGGIO_M = 6_371_000;

/** La distanza in metri fra due punti [lon, lat]. */
function metri(a: number[], b: number[]): number {
  const rad = Math.PI / 180;
  const dLat = (b[1]! - a[1]!) * rad, dLon = (b[0]! - a[0]!) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1]! * rad) * Math.cos(b[1]! * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * RAGGIO_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

const punto = (p: unknown): p is number[] =>
  Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[1] as number) <= 90 && Math.abs(p[0] as number) <= 180;

/**
 * La lunghezza in metri di una geometria GeoJSON: LineString, MultiLineString
 * (i tratti si sommano), o un Feature che ne avvolge una. 0 se non c'è niente
 * da misurare.
 */
export function lunghezzaDellaGeometria(g: unknown): number {
  if (!g || typeof g !== "object") return 0;
  const geom: any = (g as any).type === "Feature" ? (g as any).geometry : g;
  if (!geom || typeof geom !== "object") return 0;
  const tratti: unknown[][] = geom.type === "LineString" ? [geom.coordinates]
    : geom.type === "MultiLineString" ? geom.coordinates
    : [];
  let tot = 0;
  for (const t of tratti ?? []) {
    if (!Array.isArray(t)) continue;
    let prima: number[] | null = null;
    for (const p of t) {
      if (!punto(p)) continue;
      if (prima) tot += metri(prima, p);
      prima = p;
    }
  }
  return tot;
}

/** La lunghezza in metri di una sequenza di fermate (lat, lon). */
export function lunghezzaDelleFermate(fermate: Array<{ lat: number; lon: number }>): number {
  let tot = 0;
  for (let i = 1; i < fermate.length; i++) {
    const a = fermate[i - 1]!, b = fermate[i]!;
    if (punto([a.lon, a.lat]) && punto([b.lon, b.lat])) tot += metri([a.lon, a.lat], [b.lon, b.lat]);
  }
  return tot;
}

/**
 * La lunghezza in metri del percorso di ogni variante del progetto.
 *
 * È ps_shapes.distance_m, che dalla PR 3.5 scrive solo il server con
 * lunghezzaDellaGeometria (salvataggio del tracciato, import; la migrazione
 * 0022 ha ricalcolato quelle di prima con la stessa formula). Se manca, la
 * si ricava dalla geometria; senza tracciato, dalla sequenza delle fermate.
 */
export async function lunghezzePercorsi(progettoId: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const forme = await db.execute<any>(sql`
    SELECT v.id, sh.distance_m,
           CASE WHEN sh.id IS NOT NULL AND sh.distance_m IS NULL THEN sh.geometry END AS geometry
      FROM ps_route_variants v
      LEFT JOIN ps_shapes sh ON sh.variant_id = v.id
     WHERE v.project_id = ${progettoId}::uuid`);
  const senzaForma: string[] = [];
  for (const r of forme.rows ?? []) {
    const m = r.distance_m != null ? Number(r.distance_m) : lunghezzaDellaGeometria(r.geometry);
    if (m > 0) out.set(r.id, Math.max(out.get(r.id) ?? 0, m));
    else if (!out.has(r.id)) senzaForma.push(r.id);
  }
  if (senzaForma.length) {
    const fermate = await db.execute<any>(sql`
      SELECT vs.variant_id, s.lat, s.lon
        FROM ps_variant_stops vs JOIN ps_stops s ON s.id = vs.stop_id
       WHERE vs.variant_id = ANY(${`{${senzaForma.join(",")}}`}::uuid[])
       ORDER BY vs.variant_id, vs.seq`);
    const perVariante = new Map<string, Array<{ lat: number; lon: number }>>();
    for (const r of fermate.rows ?? []) {
      let l = perVariante.get(r.variant_id);
      if (!l) { l = []; perVariante.set(r.variant_id, l); }
      l.push({ lat: Number(r.lat), lon: Number(r.lon) });
    }
    for (const id of senzaForma) out.set(id, lunghezzaDelleFermate(perVariante.get(id) ?? []));
  }
  return out;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const isoDi = (d: Date) => d.toISOString().slice(0, 10);
function giorniFra(dal: string, al: string): string[] {
  const out: string[] = [];
  if (!ISO.test(dal) || !ISO.test(al) || dal > al) return out;
  const d = new Date(`${dal}T00:00:00Z`), fine = new Date(`${al}T00:00:00Z`);
  for (; d <= fine; d.setUTCDate(d.getUTCDate() + 1)) out.push(isoDi(d));
  return out;
}
const COLONNE_GIORNO = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;

/**
 * I giorni (AAAA-MM-GG, fra `dal` e `al` inclusi) in cui circola ogni corsa
 * attiva e non prototipo del progetto: gli stessi del GTFS materializzato.
 *
 *  - Con la matrice di validità (almeno una corsa del progetto ha i bollini):
 *    computeActiveDatesByTrip, cioè matrice, giorni della settimana,
 *    categorie, eccezioni e periodo della corsa.
 *  - Senza: il calendario settimanale della corsa fra le sue date, più e meno
 *    le eccezioni del calendario; 7 giorni su 7 fra la prima e l'ultima data
 *    dei calendari per le corse senza calendario. Il periodo e le eccezioni
 *    della corsa qui non contano, come nel GTFS (ramo dei calendari).
 *
 * Una corsa che non circola mai nel periodo ha la lista vuota.
 */
export async function giorniDiCircolazione(o: { progettoId: string; dal: string; al: string; corse?: string[] | null }): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const giorni = giorniFra(o.dal, o.al);
  if (giorni.length === 0) return out;
  const soloCorse = o.corse?.length ? sql`AND t.id = ANY(${`{${o.corse.join(",")}}`}::uuid[])` : sql``;
  const corse = await db.execute<any>(sql`
    SELECT t.id, t.calendar_id
      FROM ps_trips t
     WHERE t.project_id = ${o.progettoId}::uuid
       AND COALESCE(t.is_active, true) = true
       AND COALESCE((t.attributes->>'prototype')::boolean, false) = false
       ${soloCorse}`);
  const righe = (corse.rows ?? []) as Array<{ id: string; calendar_id: string | null }>;
  for (const r of righe) out.set(r.id, []);
  if (righe.length === 0) return out;

  if (await projectHasTripValidity(o.progettoId)) {
    const attive = await computeActiveDatesByTrip({ projectId: o.progettoId, from: o.dal, to: o.al, tripIds: o.corse?.length ? righe.map((r) => r.id) : null });
    for (const r of righe) {
      // computeActiveDatesByTrip dà le date come nel GTFS (AAAAMMGG)
      out.set(r.id, (attive.get(r.id) ?? []).map((d) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`));
    }
    return out;
  }

  // ramo dei calendari settimanali, come lib/materializzazione/feed.ts
  const cal = await db.execute<any>(sql`
    SELECT id, monday, tuesday, wednesday, thursday, friday, saturday, sunday,
           to_char(start_date, 'YYYY-MM-DD') AS dal, to_char(end_date, 'YYYY-MM-DD') AS al
      FROM ps_calendars WHERE project_id = ${o.progettoId}::uuid`);
  const calendari = (cal.rows ?? []) as any[];
  const dalCal = calendari.map((c) => c.dal).filter(Boolean).sort()[0] as string | undefined;
  const alCal = calendari.map((c) => c.al).filter(Boolean).sort().at(-1) as string | undefined;
  const oggi = new Date();
  const fraUnAnno = new Date(oggi); fraUnAnno.setFullYear(oggi.getFullYear() + 1);
  const inizio = dalCal ?? isoDi(oggi), fine = alCal ?? isoDi(fraUnAnno);
  const eccezioni = await db.execute<any>(sql`
    SELECT cd.calendar_id, to_char(cd.date, 'YYYY-MM-DD') AS giorno, COALESCE(cd.exception_type, 1) AS tipo
      FROM ps_calendar_dates cd JOIN ps_calendars c ON c.id = cd.calendar_id
     WHERE c.project_id = ${o.progettoId}::uuid
       AND cd.date BETWEEN ${o.dal}::date AND ${o.al}::date`);
  const eccDi = new Map<string, Map<string, number>>();
  for (const e of eccezioni.rows ?? []) {
    let m = eccDi.get(e.calendar_id);
    if (!m) { m = new Map(); eccDi.set(e.calendar_id, m); }
    m.set(e.giorno, Number(e.tipo));
  }
  const settimana = giorni.map((g) => new Date(`${g}T00:00:00Z`).getUTCDay());
  const perCalendario = new Map<string | null, string[]>();
  for (const c of calendari) {
    const da = c.dal ?? inizio, a = c.al ?? fine, ecc = eccDi.get(c.id);
    perCalendario.set(c.id, giorni.filter((g, i) => {
      const e = ecc?.get(g);
      if (e === 2) return false;
      if (e === 1) return true;
      return g >= da && g <= a && !!c[COLONNE_GIORNO[settimana[i]!]!];
    }));
  }
  perCalendario.set(null, giorni.filter((g) => g >= inizio && g <= fine)); // senza calendario: 7 su 7
  for (const r of righe) out.set(r.id, perCalendario.get(r.calendar_id) ?? []);
  return out;
}

export interface CorsaConKm {
  id: string;
  routeId: string;
  variantId: string;
  onDemand: boolean;
  /** metri del percorso di una corsa */
  metri: number;
  /** i giorni (AAAA-MM-GG) in cui circola fra dal e al */
  giorni: string[];
}

/**
 * Le corse attive del progetto con i giorni in cui circolano fra `dal` e `al`
 * (inclusi, AAAA-MM-GG) e la lunghezza del loro percorso. È la base di ogni
 * conteggio di km: per data, per linea, per categoria.
 */
export async function corseConKm(o: { progettoId: string; dal: string; al: string; linee?: string[] | null }): Promise<CorsaConKm[]> {
  const corse = await db.execute<any>(sql`
    SELECT t.id, t.route_id, t.variant_id, COALESCE((t.attributes->>'onDemand')::boolean, false) AS on_demand
      FROM ps_trips t
     WHERE t.project_id = ${o.progettoId}::uuid
       AND COALESCE(t.is_active, true) = true
       AND COALESCE((t.attributes->>'prototype')::boolean, false) = false
       ${o.linee?.length ? sql`AND t.route_id = ANY(${`{${o.linee.join(",")}}`}::uuid[])` : sql``}`);
  const righe = corse.rows ?? [];
  if (righe.length === 0) return [];
  const [lunghezze, giorni] = await Promise.all([
    lunghezzePercorsi(o.progettoId),
    giorniDiCircolazione({ progettoId: o.progettoId, dal: o.dal, al: o.al, corse: o.linee?.length ? righe.map((r: any) => r.id) : null }),
  ]);
  return righe.map((r: any) => ({
    id: r.id, routeId: r.route_id, variantId: r.variant_id, onDemand: !!r.on_demand,
    metri: lunghezze.get(r.variant_id) ?? 0,
    giorni: giorni.get(r.id) ?? [],
  }));
}

/**
 * Le corse attive con un periodo di validità di un giorno solo (valid_from =
 * valid_to): con alcuni GTFS importati succede spesso, e con la circolazione vera
 * quelle corse fanno i km di un giorno. Lo dicono le pagine dei km. Conta solo
 * nei progetti con la matrice di validità: senza, il periodo della corsa non
 * entra nella circolazione (né nel GTFS).
 */
/**
 * Toglie il periodo di un giorno alle corse che l'hanno (tappa 6.46): le stesse
 * di corseConPeriodoDiUnGiorno. Il periodo vuoto vuol dire «illimitata»: la
 * corsa circola nei giorni che dicono matrice, eccezioni e calendario
 * aziendale. Restituisce quante corse ha cambiato.
 */
export async function togliPeriodoDiUnGiorno(progettoId: string): Promise<number> {
  if (!(await projectHasTripValidity(progettoId))) return 0;
  const r = await db.execute<any>(sql`
    UPDATE ps_trips SET valid_from = NULL, valid_to = NULL
     WHERE project_id = ${progettoId}::uuid
       AND COALESCE(is_active, true) = true
       AND COALESCE((attributes->>'prototype')::boolean, false) = false
       AND valid_from IS NOT NULL AND valid_from = valid_to
    RETURNING id`);
  return (r.rows ?? []).length;
}

export async function corseConPeriodoDiUnGiorno(progettoId: string): Promise<{ quante: number; giorno: string | null }> {
  if (!(await projectHasTripValidity(progettoId))) return { quante: 0, giorno: null };
  const r = await db.execute<any>(sql`
    SELECT count(*)::int AS quante, to_char(min(valid_from), 'YYYY-MM-DD') AS giorno
      FROM ps_trips
     WHERE project_id = ${progettoId}::uuid
       AND COALESCE(is_active, true) = true
       AND COALESCE((attributes->>'prototype')::boolean, false) = false
       AND valid_from IS NOT NULL AND valid_from = valid_to`);
  return { quante: Number(r.rows?.[0]?.quante ?? 0), giorno: r.rows?.[0]?.giorno ?? null };
}
