/**
 * Le polimetriche dal programma di esercizio (tappa 6.36, migrazione 0057).
 *
 * Le polimetriche si fanno su un programma di Planning Studio: di solito
 * quello in esercizio (la sua versione pubblicata, congelata alla messa in
 * esercizio), o uno programmato o una bozza per preparare quelle del
 * prossimo. Prima si facevano su un GTFS caricato a mano (uno ZIP).
 *
 * Dal programma si fa una FOTOGRAFIA, scritta in polim_imports come quelle
 * degli ZIP: le linee extraurbane (le dicono le reti dell'azienda), le loro
 * varianti con almeno una corsa attiva, le fermate coi km. I km sono quelli
 * della geometria della variante, con le fermate proiettate sopra; senza una
 * geometria utile, la somma delle distanze in linea d'aria fra le fermate.
 *
 * Una fotografia e non il programma vivo: le polimetriche salvate puntano
 * alle fermate per posizione, e una modifica in Planning Studio le
 * sposterebbe senza dirlo.
 *
 * Il lavoro già fatto passa alla fotografia nuova percorso per percorso,
 * dove la linea e la sequenza delle fermate (per codice) sono le stesse:
 *   - le polimetriche salvate della fotografia più recente che ne ha si
 *     copiano, coi km ricalcolati sul percorso nuovo (componiPolimetrica,
 *     tappa 6.35);
 *   - le decisioni del confronto con la bigliettazione (tappa 6.34b) non si
 *     toccano: ricordano le fermate del percorso scelto, e valgono su ogni
 *     fotografia dove c'è un percorso con quelle fermate
 *     (percorsoDellaDecisione). Qui si contano.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { haversineKm } from "./geo-utils";
import { servizioDellaLinea } from "./reti-linee";
import { componiPolimetrica, leggiCorpo, type PercorsoImport } from "./polimetrica-salvata";
import { percorsoDellaDecisione } from "./polimetrica-ufficiale";

type Esecutore = { execute: (q: any) => Promise<any> };
const righe = (r: any): any[] => r?.rows ?? [];

/* ─────────────────────────────────────────────────────────────
 *  Il contenuto di una fotografia (polim_imports.payload)
 * ───────────────────────────────────────────────────────────── */
export interface PercorsoStop { stopId: string; stopName: string; lat: number; lon: number; km: number; distPrev: number }
export interface Percorso {
  variantId: string;
  routeId: string;
  routeIds: string[];
  directionId: number | null; // il verso della variante: 0 andata, 1 ritorno
  tripCount: number;
  firstStopName: string;
  lastStopName: string;
  stopCount: number;
  totalKm: number;
  distanceMethod: "shape" | "haversine";
  stops: PercorsoStop[];
  shape: [number, number][] | null; // [lon, lat]
}
export interface Linea { lineCode: string; lineName: string; routeIds: string[]; percorsi: Percorso[] }
export interface Fotografia { agencyName: string | null; lines: Linea[] }

/* ─────────────────────────────────────────────────────────────
 *  Geometria: le fermate proiettate sulla geometria della variante
 * ───────────────────────────────────────────────────────────── */
type LatLon = { lat: number; lon: number };

/** Il punto più vicino su un segmento A→B (lat/lon in una metrica locale quasi isotropa). */
function proiezioneSulSegmento(p: LatLon, a: LatLon, b: LatLon): number {
  const kx = Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
  const ax = a.lon * kx, ay = a.lat, bx = b.lon * kx, by = b.lat, px = p.lon * kx, py = p.lat;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return 0;
  return Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / len2));
}

/**
 * Il km di ogni fermata lungo la geometria, senza mai tornare indietro.
 * null se la geometria non serve: meno di due punti, o una fermata a più di
 * 2 km dalla geometria (la proiezione non direbbe niente di vero).
 */
export function kmSullaGeometria(fermate: readonly LatLon[], forma: readonly LatLon[]): number[] | null {
  if (forma.length < 2) return null;
  const cum: number[] = [0];
  for (let i = 1; i < forma.length; i++) cum.push(cum[i - 1]! + haversineKm(forma[i - 1]!.lat, forma[i - 1]!.lon, forma[i]!.lat, forma[i]!.lon));
  const out: number[] = [];
  let da = 0;
  for (const f of fermate) {
    let meglio = { dist: Infinity, km: 0, seg: da };
    for (let i = da; i < forma.length - 1; i++) {
      const a = forma[i]!, b = forma[i + 1]!;
      const t = proiezioneSulSegmento(f, a, b);
      const d = haversineKm(f.lat, f.lon, a.lat + t * (b.lat - a.lat), a.lon + t * (b.lon - a.lon));
      if (d < meglio.dist) meglio = { dist: d, km: cum[i]! + t * (cum[i + 1]! - cum[i]!), seg: i };
    }
    if (meglio.dist > 2) return null;
    out.push(out.length ? Math.max(meglio.km, out[out.length - 1]!) : meglio.km);
    da = meglio.seg;
  }
  return out;
}

/** Il km di ogni fermata sommando le distanze in linea d'aria. */
export function kmInLineaDAria(fermate: readonly LatLon[]): number[] {
  const out: number[] = [];
  let km = 0;
  fermate.forEach((f, i) => {
    if (i > 0) km += haversineKm(fermate[i - 1]!.lat, fermate[i - 1]!.lon, f.lat, f.lon);
    out.push(km);
  });
  return out;
}

function campiona<T>(arr: readonly T[], max: number): T[] {
  if (arr.length <= max) return [...arr];
  const passo = (arr.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => arr[Math.round(i * passo)]!);
}

const tondo = (n: number, d = 3) => Math.round(n * 10 ** d) / 10 ** d;

/* ─────────────────────────────────────────────────────────────
 *  Le linee extraurbane e la fotografia
 * ───────────────────────────────────────────────────────────── */

/** Una linea di Planning Studio. */
export interface LineaDelProgramma { id: string; codice: string; nomeCorto: string | null; nomeLungo: string | null }

/**
 * Le linee extraurbane di un programma, raggruppate per codice (il nome
 * corto, o il codice se manca): più linee di Planning Studio col nome uguale
 * sono una linea. Urbana o extraurbana lo dicono le reti dell'azienda.
 */
export function lineeExtraurbane(linee: readonly LineaDelProgramma[]): Map<string, LineaDelProgramma[]> {
  const per = new Map<string, LineaDelProgramma[]>();
  for (const l of linee) {
    const codice = (l.nomeCorto || l.codice || "").trim();
    if (!codice || servizioDellaLinea(codice) !== "extraurbano") continue;
    if (!per.has(codice)) per.set(codice, []);
    per.get(codice)!.push(l);
  }
  return per;
}

/** Quello che la fotografia legge da Planning Studio. */
export interface DatiDelProgramma {
  agencyName: string | null;
  linee: LineaDelProgramma[];
  varianti: { id: string; lineaId: string; direzione: number | null }[];
  /** le fermate di ogni variante, in ordine */
  fermateDelleVarianti: Map<string, string[]>;
  fermate: Map<string, { codice: string; nome: string; lat: number; lon: number }>;
  /** la geometria di ogni variante, [lon, lat] */
  forme: Map<string, [number, number][]>;
  /** le corse attive di ogni variante */
  corse: Map<string, number>;
}

/**
 * La fotografia di un programma: le linee extraurbane con le loro varianti
 * (almeno una corsa attiva, almeno due fermate), le fermate col codice, il
 * nome e il km. Linee per codice, varianti dalla più servita.
 */
export function fotografia(d: DatiDelProgramma): Fotografia {
  const lines: Linea[] = [];
  for (const [lineCode, linee] of lineeExtraurbane(d.linee)) {
    const codiceDi = new Map(linee.map((l) => [l.id, l.codice]));
    const percorsi: Percorso[] = [];
    for (const v of d.varianti) {
      const routeId = codiceDi.get(v.lineaId);
      if (routeId === undefined) continue;
      const corse = d.corse.get(v.id) ?? 0;
      if (corse === 0) continue;
      const fermate = (d.fermateDelleVarianti.get(v.id) ?? []).map((id) => d.fermate.get(id));
      if (fermate.length < 2 || fermate.some((f) => !f)) continue;
      const ll = fermate.map((f) => ({ lat: f!.lat, lon: f!.lon }));
      const forma = (d.forme.get(v.id) ?? []).map(([lon, lat]) => ({ lat, lon }));
      const sullaForma = kmSullaGeometria(ll, forma);
      const km = sullaForma ?? kmInLineaDAria(ll);
      const stops: PercorsoStop[] = fermate.map((f, i) => ({
        stopId: f!.codice, stopName: f!.nome, lat: tondo(f!.lat, 6), lon: tondo(f!.lon, 6),
        km: tondo(km[i]!), distPrev: tondo(i > 0 ? km[i]! - km[i - 1]! : 0),
      }));
      percorsi.push({
        variantId: v.id, routeId, routeIds: [routeId],
        directionId: v.direzione === 0 || v.direzione === 1 ? v.direzione : null,
        tripCount: corse,
        firstStopName: stops[0]!.stopName, lastStopName: stops[stops.length - 1]!.stopName,
        stopCount: stops.length, totalKm: tondo(stops[stops.length - 1]!.km, 2),
        distanceMethod: sullaForma ? "shape" : "haversine",
        stops,
        shape: sullaForma ? campiona(forma, 600).map((p) => [tondo(p.lon, 6), tondo(p.lat, 6)] as [number, number]) : null,
      });
    }
    if (!percorsi.length) continue;
    percorsi.sort((a, b) => b.tripCount - a.tripCount || a.firstStopName.localeCompare(b.firstStopName, "it"));
    const nome = linee.map((l) => l.nomeLungo?.trim()).find(Boolean);
    lines.push({
      lineCode,
      lineName: nome || `${percorsi[0]!.firstStopName} ↔ ${percorsi[0]!.lastStopName}`,
      routeIds: [...new Set(linee.map((l) => l.codice))],
      percorsi,
    });
  }
  lines.sort((a, b) => a.lineCode.localeCompare(b.lineCode, "it", { numeric: true }));
  return { agencyName: d.agencyName, lines };
}

/** Le coordinate di una geometria salvata da Planning Studio (GeoJSON LineString). */
export function coordinateDellaForma(g: unknown): [number, number][] {
  const c = (g as any)?.type === "LineString" ? (g as any).coordinates : null;
  if (!Array.isArray(c)) return [];
  return c.flatMap((p: unknown) => (Array.isArray(p) && Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1])) ? [[Number(p[0]), Number(p[1])] as [number, number]] : []));
}

/** Legge da Planning Studio quello che serve alla fotografia; null se il programma non c'è. */
export async function datiDelProgramma(ex: Esecutore, progettoId: string): Promise<(DatiDelProgramma & { nome: string }) | null> {
  const p = righe(await ex.execute(sql`SELECT name, agency_name FROM ps_projects WHERE id = ${progettoId}::uuid`))[0];
  if (!p) return null;
  const linee: LineaDelProgramma[] = righe(await ex.execute(sql`
    SELECT id, codice, short_name, long_name FROM ps_routes WHERE project_id = ${progettoId}::uuid AND is_active`))
    .map((r) => ({ id: String(r.id), codice: String(r.codice), nomeCorto: r.short_name ?? null, nomeLungo: r.long_name ?? null }));
  const extra = [...lineeExtraurbane(linee).values()].flat().map((l) => l.id);
  const vuoti: DatiDelProgramma = {
    agencyName: p.agency_name ?? null, linee, varianti: [],
    fermateDelleVarianti: new Map(), fermate: new Map(), forme: new Map(), corse: new Map(),
  };
  if (!extra.length) return { ...vuoti, nome: String(p.name) };
  const ids = `{${extra.join(",")}}`;
  const [v, vs, f, fo, c] = await Promise.all([
    ex.execute(sql`SELECT id, route_id, direction FROM ps_variants WHERE project_id = ${progettoId}::uuid AND route_id = ANY(${ids}::uuid[])`),
    ex.execute(sql`
      SELECT vs.variant_id, vs.stop_id FROM ps_variant_stops vs JOIN ps_variants v ON v.id = vs.variant_id
       WHERE v.project_id = ${progettoId}::uuid AND v.route_id = ANY(${ids}::uuid[]) ORDER BY vs.variant_id, vs.seq`),
    ex.execute(sql`SELECT id, codice, name, lat, lon FROM ps_stops WHERE project_id = ${progettoId}::uuid`),
    ex.execute(sql`
      SELECT DISTINCT ON (s.variant_id) s.variant_id, s.geometry FROM ps_shapes s JOIN ps_variants v ON v.id = s.variant_id
       WHERE s.project_id = ${progettoId}::uuid AND v.route_id = ANY(${ids}::uuid[]) ORDER BY s.variant_id, s.updated_at DESC NULLS LAST`),
    ex.execute(sql`
      SELECT variant_id, count(*)::int AS n FROM ps_trips
       WHERE project_id = ${progettoId}::uuid AND is_active AND route_id = ANY(${ids}::uuid[]) GROUP BY variant_id`),
  ]);
  const dati: DatiDelProgramma = { ...vuoti };
  dati.varianti = righe(v).map((r) => ({ id: String(r.id), lineaId: String(r.route_id), direzione: r.direction == null ? null : Number(r.direction) }));
  for (const r of righe(vs)) {
    const k = String(r.variant_id);
    if (!dati.fermateDelleVarianti.has(k)) dati.fermateDelleVarianti.set(k, []);
    dati.fermateDelleVarianti.get(k)!.push(String(r.stop_id));
  }
  for (const r of righe(f)) dati.fermate.set(String(r.id), { codice: String(r.codice), nome: String(r.name ?? r.codice), lat: Number(r.lat), lon: Number(r.lon) });
  for (const r of righe(fo)) dati.forme.set(String(r.variant_id), coordinateDellaForma(r.geometry));
  for (const r of righe(c)) dati.corse.set(String(r.variant_id), Number(r.n));
  return { ...dati, nome: String(p.name) };
}

/* ─────────────────────────────────────────────────────────────
 *  I programmi da cui si può fare una fotografia
 * ───────────────────────────────────────────────────────────── */
export type StatoProgramma = "in esercizio" | "programmato" | "bozza";

export interface ProgrammaPerPolimetriche {
  id: string; nome: string; stato: StatoProgramma;
  /** per un programma programmato: da quando va in esercizio */
  dal: string | null;
  aggiornato: string | null;
  /** l'ultima fotografia fatta da questo programma */
  ultimaFotografia: string | null;
}

/**
 * I programmi da cui chi lavora alle tariffe può fare una fotografia:
 *   - quello in esercizio: la versione pubblicata del feed acceso, o il
 *     progetto stesso se è andato in esercizio senza una versione;
 *   - quelli programmati: le versioni dei feed che aspettano la decorrenza;
 *   - le bozze di Planning Studio che può aprire (proprietario o membro;
 *     l'amministratore tutte).
 * In quest'ordine; le bozze dalla più recente.
 */
export async function programmiPerLePolimetriche(ex: Esecutore, u: { id: string; admin: boolean }): Promise<ProgrammaPerPolimetriche[]> {
  const r = righe(await ex.execute(sql`
    WITH in_esercizio AS (
      SELECT p.id, 1 AS ordine, 'in esercizio' AS stato, NULL::date AS dal
        FROM gtfs_feeds f JOIN ps_projects p ON p.versione_del_feed = f.id
       WHERE f.is_active
      UNION ALL
      SELECT p.id, 1, 'in esercizio', NULL::date
        FROM gtfs_feeds f JOIN ps_projects p ON p.materialized_feed_id = f.id AND p.versione_del_feed IS NULL
       WHERE f.is_active AND NOT EXISTS (SELECT 1 FROM ps_projects v WHERE v.versione_del_feed = f.id)
    ), programmati AS (
      SELECT v.id, 2 AS ordine, 'programmato' AS stato, min(a.effective_from) AS dal
        FROM ps_pending_activations a JOIN ps_projects v ON v.versione_del_feed = a.feed_id
       GROUP BY v.id
    ), bozze AS (
      SELECT p.id, 3 AS ordine, 'bozza' AS stato, NULL::date AS dal
        FROM ps_projects p
       WHERE p.versione_del_feed IS NULL
         AND (${u.admin}::boolean OR p.owner_user_id = ${u.id}::uuid
              OR EXISTS (SELECT 1 FROM ps_project_members m WHERE m.project_id = p.id AND m.user_id = ${u.id}::uuid))
    ), tutti AS (
      SELECT * FROM in_esercizio
      UNION ALL SELECT * FROM programmati WHERE id NOT IN (SELECT id FROM in_esercizio)
      UNION ALL SELECT * FROM bozze WHERE id NOT IN (SELECT id FROM in_esercizio)
    )
    SELECT t.id, p.name, t.stato, t.dal, p.updated_at, t.ordine,
           (SELECT max(i.created_at) FROM polim_imports i WHERE i.progetto_id = t.id) AS ultima
      FROM tutti t JOIN ps_projects p ON p.id = t.id
     ORDER BY t.ordine, p.updated_at DESC NULLS LAST, p.name`));
  const visti = new Set<string>();
  return r.flatMap((x) => {
    if (visti.has(String(x.id))) return [];
    visti.add(String(x.id));
    return [{
      id: String(x.id), nome: String(x.name ?? ""), stato: x.stato as StatoProgramma,
      dal: x.dal ? new Date(x.dal).toISOString().slice(0, 10) : null,
      aggiornato: x.updated_at ? new Date(x.updated_at).toISOString() : null,
      ultimaFotografia: x.ultima ? new Date(x.ultima).toISOString() : null,
    }];
  });
}

/* ─────────────────────────────────────────────────────────────
 *  Il lavoro fatto passa alla fotografia nuova
 * ───────────────────────────────────────────────────────────── */

/** La chiave di un percorso fra due fotografie: la linea e le fermate per codice, in ordine. */
export const chiaveDelPercorso = (linea: string, fermate: readonly string[]) => `${linea}\u0000${fermate.join("|")}`;

/** I percorsi di una fotografia per chiave (a parità, il più servito: vengono in quest'ordine). */
export function percorsiPerChiave(f: Fotografia): Map<string, { linea: Linea; percorso: Percorso }> {
  const per = new Map<string, { linea: Linea; percorso: Percorso }>();
  for (const linea of f.lines) {
    for (const percorso of linea.percorsi) {
      const k = chiaveDelPercorso(linea.lineCode, percorso.stops.map((s) => s.stopId));
      if (!per.has(k)) per.set(k, { linea, percorso });
    }
  }
  return per;
}

/**
 * Il corpo con cui ricomporre una polimetrica salvata su un percorso con le
 * stesse fermate (di un'altra fotografia, o del programma stesso): le sue
 * decisioni (confini, nodi, punti tariffari), gli identificativi del percorso
 * nuovo. Lo legge `leggiCorpo`, come un salvataggio dalla pagina.
 */
export function corpoDallaSalvata(s: any, importId: string, p: Pick<Percorso, "routeId" | "variantId">): unknown {
  return {
    importId, routeId: p.routeId, variantId: p.variantId,
    direction: s.direction, name: s.name, boundaries: Array.isArray(s.boundaries) ? s.boundaries : [],
    tratte: (Array.isArray(s.tratte) ? s.tratte : []).map((t: any) => ({
      index: t?.index, number: t?.number, label: t?.label, color: t?.color, nodeName: t?.nodeName,
    })),
    stops: (Array.isArray(s.stops) ? s.stops : []).map((f: any) => ({ stopId: f?.stopId, ...(f?.punto === true ? { punto: true } : {}) })),
  };
}

export const percorsoPerIlSalvataggio = (linea: Linea, p: Percorso): PercorsoImport => ({
  routeId: p.routeId, variantId: p.variantId, lineCode: linea.lineCode, lineName: linea.lineName, totalKm: p.totalKm, stops: p.stops,
});

export interface LavoroPortato {
  /** la fotografia da cui sono venute le polimetriche salvate */
  da: { importId: string; nome: string } | null;
  polimetriche: number;
  /** quelle rimaste indietro, col motivo */
  nonPortate: { linea: string | null; nome: string | null; motivo: string }[];
  /** le decisioni del confronto che valgono anche sulla fotografia nuova */
  decisioni: number;
  /** le decisioni il cui percorso non c'è nella fotografia nuova (lì torna la proposta) */
  decisioniSenzaPercorso: number;
}

/**
 * Porta il lavoro sulla fotografia `nuova` (già scritta, id `importId`):
 * le polimetriche salvate della fotografia più recente che ne ha. E conta le
 * decisioni del confronto con la bigliettazione che valgono anche qui.
 */
export async function portaIlLavoro(ex: Esecutore, importId: string, nuova: Fotografia): Promise<LavoroPortato> {
  const indice = percorsiPerChiave(nuova);
  const esito: LavoroPortato = { da: null, polimetriche: 0, nonPortate: [], decisioni: 0, decisioniSenzaPercorso: 0 };

  /* i percorsi delle altre fotografie, con le loro fermate: per ritrovare il percorso uguale */
  const vecchi = righe(await ex.execute(sql`
    SELECT i.id AS import_id, l.value->>'lineCode' AS linea, p.value->>'routeId' AS route_id, p.value->'routeIds' AS route_ids,
           p.value->>'variantId' AS variant_id,
           (SELECT array_agg(s.value->>'stopId' ORDER BY s.n) FROM jsonb_array_elements(p.value->'stops') WITH ORDINALITY AS s(value, n)) AS fermate
      FROM polim_imports i
      CROSS JOIN LATERAL jsonb_array_elements(i.payload->'lines') AS l(value)
      CROSS JOIN LATERAL jsonb_array_elements(l.value->'percorsi') AS p(value)
     WHERE i.id <> ${importId}::uuid
     ORDER BY i.created_at DESC`));
  /* per fotografia: linea GTFS (o una sorella) e variante → chiave */
  const perFotografia = new Map<string, Map<string, string>>();
  for (const v of vecchi) {
    const chiave = chiaveDelPercorso(String(v.linea), (v.fermate ?? []).map(String));
    const linee = new Set([String(v.route_id), ...(Array.isArray(v.route_ids) ? v.route_ids.map(String) : [])]);
    if (!perFotografia.has(v.import_id)) perFotografia.set(v.import_id, new Map());
    for (const r of linee) {
      const k = `${r}\u0000${v.variant_id}`;
      if (!perFotografia.get(v.import_id)!.has(k)) perFotografia.get(v.import_id)!.set(k, chiave);
    }
  }
  const chiaveDi = (impId: string, routeId: string, variantId: string): string | null =>
    perFotografia.get(impId)?.get(`${routeId}\u0000${variantId}`) ?? null;

  /* le polimetriche salvate: dalla fotografia più recente che ne ha */
  const sorgente = righe(await ex.execute(sql`
    SELECT i.id, i.filename FROM polim_imports i
     WHERE i.id <> ${importId}::uuid AND EXISTS (SELECT 1 FROM polim_polimetriche p WHERE p.import_id = i.id)
     ORDER BY i.created_at DESC LIMIT 1`))[0];
  if (sorgente) {
    esito.da = { importId: String(sorgente.id), nome: String(sorgente.filename ?? "") };
    const salvate = righe(await ex.execute(sql`
      SELECT route_id, variant_id, direction, name, line_code, boundaries, tratte, stops, created_by
        FROM polim_polimetriche WHERE import_id = ${sorgente.id}::uuid ORDER BY line_code, created_at`));
    for (const s of salvate) {
      const nonPortata = (motivo: string) => esito.nonPortate.push({ linea: s.line_code ?? null, nome: s.name ?? null, motivo });
      const k = chiaveDi(String(sorgente.id), String(s.route_id), String(s.variant_id));
      const trovato = k ? indice.get(k) : undefined;
      if (!trovato) { nonPortata("il percorso non c'è più, o le sue fermate sono cambiate"); continue; }
      const letto = leggiCorpo(corpoDallaSalvata(s, importId, trovato.percorso));
      if (!letto.ok) { nonPortata(letto.errore); continue; }
      const composta = componiPolimetrica(letto.corpo, percorsoPerIlSalvataggio(trovato.linea, trovato.percorso));
      if (!composta.ok) { nonPortata(composta.errore); continue; }
      const p = composta.polimetrica;
      const scritta = righe(await ex.execute(sql`
        INSERT INTO polim_polimetriche (
          import_id, route_id, line_code, line_name, variant_id, direction, name,
          total_km, stop_count, tratta_count, boundaries, tratte, stops, created_by, updated_at
        ) VALUES (
          ${importId}::uuid, ${p.routeId}, ${p.lineCode}, ${p.lineName}, ${p.variantId}, ${p.direction}, ${p.name},
          ${p.totalKm}, ${p.stops.length}, ${p.tratte.length},
          ${JSON.stringify(p.boundaries)}::jsonb, ${JSON.stringify(p.tratte)}::jsonb, ${JSON.stringify(p.stops)}::jsonb,
          ${s.created_by ?? null}, now()
        )
        ON CONFLICT (import_id, route_id, variant_id, direction) DO NOTHING
        RETURNING id`));
      if (scritta.length) esito.polimetriche++;
      else nonPortata("c'è già una polimetrica per quel percorso e verso");
    }
  }

  /* le decisioni del confronto che valgono anche qui: stessi identificativi, o stesse fermate */
  const percorsi = nuova.lines.flatMap((l) => l.percorsi.map((p) => ({ routeId: p.routeId, variantId: p.variantId, corse: p.tripCount, fermate: p.stops })));
  for (const d of righe(await ex.execute(sql`SELECT route_id, variant_id, fermate FROM polim_abbinamenti_percorsi`))) {
    const vale = percorsoDellaDecisione({ routeId: String(d.route_id), variantId: String(d.variant_id), fermate: Array.isArray(d.fermate) ? d.fermate.map(String) : null }, percorsi);
    if (vale) esito.decisioni++; else esito.decisioniSenzaPercorso++;
  }
  return esito;
}

/* ─────────────────────────────────────────────────────────────
 *  La fotografia di un programma, scritta
 * ───────────────────────────────────────────────────────────── */
export class FotografiaRifiutata extends Error {
  constructor(messaggio: string, readonly stato: number) { super(messaggio); }
}

/** Un nome che il vincolo della 0057 accetta: niente caratteri di controllo, al più 300 caratteri. */
const nomePulito = (s: string) => s.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 300) || "Programma senza nome";

/**
 * Fa la fotografia del programma `progettoId` (che `u` deve poter
 * scegliere), la scrive e ci porta il lavoro fatto. In una transazione.
 */
export async function fotografaProgramma(progettoId: string, u: { id: string; admin: boolean }) {
  return db.transaction(async (tx) => {
    const programma = (await programmiPerLePolimetriche(tx, u)).find((p) => p.id === progettoId);
    if (!programma) throw new FotografiaRifiutata("Programma non trovato", 404);
    const dati = await datiDelProgramma(tx, progettoId);
    if (!dati) throw new FotografiaRifiutata("Programma non trovato", 404);
    const foto = fotografia(dati);
    if (!foto.lines.length) {
      throw new FotografiaRifiutata("Nel programma non ci sono linee extraurbane con corse: urbana o extraurbana la dicono le reti dell'azienda (Amministrazione → Azienda, «Reti e linee»).", 400);
    }
    const percorsi = foto.lines.reduce((n, l) => n + l.percorsi.length, 0);
    const nome = nomePulito(dati.nome);
    const scritta = righe(await tx.execute(sql`
      INSERT INTO polim_imports (filename, agency_name, created_by, line_count, percorso_count, payload, fonte, progetto_id, progetto_nome, stato_programma)
      VALUES (${nome}, ${foto.agencyName}, ${u.id}, ${foto.lines.length}, ${percorsi}, ${JSON.stringify(foto)}::jsonb,
              'programma', ${progettoId}::uuid, ${nome}, ${programma.stato})
      RETURNING id, created_at`))[0];
    const lavoro = await portaIlLavoro(tx, String(scritta.id), foto);
    return {
      importId: String(scritta.id), createdAt: scritta.created_at, programma: { id: progettoId, nome, stato: programma.stato },
      lineCount: foto.lines.length, percorsoCount: percorsi, lavoro,
    };
  });
}
