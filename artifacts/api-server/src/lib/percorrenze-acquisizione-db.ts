/**
 * Acquisire i tempi reali nel programma: lettura delle corse del progetto,
 * calcolo (regole in percorrenze-acquisizione.ts) e scrittura degli orari.
 * Lo stesso calcolo serve l'anteprima e la scrittura: quello che si scrive è
 * quello che si è visto, ricalcolato sul server e non preso dal browser.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { leggiOsservato } from "./percorrenze-reali-db";
import {
  giorniOsservati, tipoPerGiornoTipo, secondi, Osservato,
  type CorsaProgetto, type FermataCorsa, type TipoGiorno,
} from "./percorrenze-reali";
import {
  ricalcolaCorsa, confronto, hms, hhmm, variazioneArrivoMin,
  type Valore, type Ricalcolo, type EsitoBreve, type FonteNuovoTratto,
} from "./percorrenze-acquisizione";
import { giornataOggi } from "./service-day";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Corse ricalcolabili in un colpo solo. */
export const MAX_CORSE_AMBITO = 3000;
/** Corse lette per il delta finale (tutte quelle delle linee coinvolte). */
export const MAX_CORSE_CONTESTO = 6000;
const MAX_CORSE_SCELTE = 50;

export type Ambito = "corsa" | "percorso" | "linee";

export interface ParametriAcquisizione {
  ambito: Ambito;
  /** ambito corsa: le corse scelte (1–50) */
  tripIds: string[];
  /** ambito percorso */
  variantId: string | null;
  /** ambito linee: vuoto = tutte le linee del progetto */
  routeIds: string[];
  /** il giorno-tipo delle corse: decide quali corse e quali giornate osservare */
  dayTypeId: string;
  valore: Valore;
  /** dove il tipo di giorno non ha dati, i feriali (dichiarati) */
  ripiego: boolean;
  /** finestra osservata, giorni */
  giorni: number;
}

const elenco = (v: unknown): string[] => (Array.isArray(v) ? v : String(v ?? "").split(","))
  .map(x => String(x).trim()).filter(Boolean);

export function leggiParametri(src: Record<string, unknown>): { ok: true; p: ParametriAcquisizione } | { ok: false; errore: string } {
  const ambito = String(src.ambito ?? "");
  if (ambito !== "corsa" && ambito !== "percorso" && ambito !== "linee") return { ok: false, errore: "ambito: corsa, percorso o linee" };
  const dayTypeId = String(src.dayTypeId ?? "");
  if (!UUID_RE.test(dayTypeId)) return { ok: false, errore: "dayTypeId non valido: scegli il giorno-tipo delle corse" };
  const tripIds = elenco(src.tripIds);
  const routeIds = elenco(src.routeIds);
  if (tripIds.some(x => !UUID_RE.test(x)) || routeIds.some(x => !UUID_RE.test(x))) return { ok: false, errore: "id non validi" };
  const variantId = src.variantId ? String(src.variantId) : null;
  if (ambito === "corsa" && (tripIds.length === 0 || tripIds.length > MAX_CORSE_SCELTE)) {
    return { ok: false, errore: `ambito corsa: da 1 a ${MAX_CORSE_SCELTE} corse` };
  }
  if (ambito === "percorso" && (!variantId || !UUID_RE.test(variantId))) return { ok: false, errore: "ambito percorso: variantId non valido" };
  if (routeIds.length > 300) return { ok: false, errore: "troppe linee" };
  const valore: Valore = String(src.valore ?? "mediana") === "p85" ? "p85" : "mediana";
  const r = String(src.ripiego ?? "feriale").toLowerCase();
  const ripiego = !(r === "nessuno" || r === "false" || r === "0" || r === "no");
  const giorni = Math.min(180, Math.max(7, Math.round(Number(src.giorni) || 91)));
  return {
    ok: true,
    p: {
      ambito, dayTypeId, valore, ripiego, giorni,
      tripIds: ambito === "corsa" ? [...new Set(tripIds)] : [],
      variantId: ambito === "percorso" ? variantId : null,
      routeIds: ambito === "linee" ? [...new Set(routeIds)] : [],
    },
  };
}

export interface CorsaCaricata extends CorsaProgetto { routeId: string; seqs: number[] }

const uuids = (ids: string[]) => `{${ids.filter(x => UUID_RE.test(x)).join(",")}}`;

/** Le corse attive di alcune linee valide nel giorno-tipo (prototipi esclusi),
 *  con le fermate in ordine. Se il progetto non usa la matrice di validità,
 *  tutte le corse attive, e lo si dice. */
export async function caricaCorse(projectId: string, routeIds: string[], dayTypeId: string | null): Promise<{
  corse: CorsaCaricata[]; notaValidita: string | null;
}> {
  if (routeIds.length === 0) return { corse: [], notaValidita: null };
  const conValidita = !!(await db.execute<any>(sql`
    SELECT EXISTS (SELECT 1 FROM ps_trip_day_validity v JOIN ps_trips t ON t.id = v.trip_id
                    WHERE t.project_id = ${projectId}::uuid) AS has`)).rows[0]?.has;
  const filtroGiorno = dayTypeId && conValidita
    ? sql`AND EXISTS (SELECT 1 FROM ps_trip_day_validity v
                       WHERE v.trip_id = t.id AND v.day_type_id = ${dayTypeId}::uuid AND v.is_valid = true)`
    : sql``;
  const r = await db.execute<any>(sql`
    SELECT t.id AS trip_id, t.route_id, t.variant_id, t.direction,
           st.stop_seq, st.arrival_time, st.departure_time,
           s.id AS stop_id, s.gtfs_id, s.name AS stop_name, s.cluster_id, s.lat, s.lon
      FROM ps_trips t
      JOIN ps_stop_times st ON st.trip_id = t.id
      JOIN ps_stops s ON s.id = st.stop_id
     WHERE t.project_id = ${projectId}::uuid
       AND t.route_id = ANY(${uuids(routeIds)}::uuid[])
       AND COALESCE(t.is_active, true) = true
       AND (t.attributes->>'prototype') IS DISTINCT FROM 'true'
       ${filtroGiorno}
     ORDER BY t.id, st.stop_seq`);
  const per = new Map<string, CorsaCaricata>();
  for (const x of r.rows as any[]) {
    let c = per.get(x.trip_id);
    if (!c) {
      c = { tripId: x.trip_id, variantId: x.variant_id, direzione: x.direction ?? null, routeId: x.route_id, fermate: [], seqs: [] };
      per.set(x.trip_id, c);
    }
    c.fermate.push({
      stopId: x.stop_id, gtfsId: x.gtfs_id ?? null, nome: x.stop_name ?? "", clusterId: x.cluster_id ?? null,
      lat: x.lat != null ? Number(x.lat) : null, lon: x.lon != null ? Number(x.lon) : null,
      arrivoS: secondi(x.arrival_time), partenzaS: secondi(x.departure_time),
    });
    c.seqs.push(Number(x.stop_seq));
  }
  return {
    corse: [...per.values()],
    notaValidita: dayTypeId && !conValidita
      ? "Validità per giorno non configurata sul progetto: considerate tutte le corse attive" : null,
  };
}

export interface RigaAnteprima {
  tripId: string;
  routeId: string;
  linea: string | null;
  variantId: string;
  percorso: string | null;
  direzione: number | null;
  partenza: string | null;
  arrivoAttuale: string | null;
  arrivoNuovo: string | null;
  /** differenza d'arrivo al capolinea, minuti */
  variazioneMin: number | null;
  tratti: number;
  fonti: Record<FonteNuovoTratto, number>;
  cambia: boolean;
  saltata: string | null;
  /** la sosta al capolinea prima della corsa dopo, e il giudizio: prima e dopo */
  prima: EsitoBreve | null;
  dopo: EsitoBreve | null;
}

export interface Acquisizione {
  giornoTipo: { id: string; codice: string | null; nome: string | null };
  osservazione: {
    tipoGiorno: TipoGiorno; giorni: number; giorniDelTipo: number; dal: string | null; al: string | null;
    transiti: number; fonte: string; disponibile: boolean;
    /** coppie di fermate prese dai feriali perché il tipo di giorno non le vede */
    coppieDaFeriale: number;
  };
  notaValidita: string | null;
  corse: RigaAnteprima[];
  riepilogo: {
    corse: number; cambiano: number; saltate: number;
    prima: Record<string, number>; dopo: Record<string, number>;
  };
  /** per la scrittura: non va nella risposta */
  ricalcoli: Map<string, { r: Ricalcolo; seqs: number[]; originali: FermataCorsa[] }>;
}

export type EsitoCalcolo = { ok: true; a: Acquisizione } | { ok: false; stato: number; errore: string };

export async function calcolaAcquisizione(projectId: string, p: ParametriAcquisizione, feedId: string | null): Promise<EsitoCalcolo> {
  const dt = (await db.execute<any>(sql`
    SELECT id, code, name FROM ps_day_types
     WHERE id = ${p.dayTypeId}::uuid AND (project_id IS NULL OR project_id = ${projectId}::uuid) LIMIT 1`)).rows[0];
  if (!dt) return { ok: false, stato: 404, errore: "Giorno-tipo non trovato" };

  /* Le linee coinvolte: il delta finale guarda la corsa dopo della linea,
   * che può non essere fra quelle ricalcolate. */
  let routeIds: string[];
  if (p.ambito === "corsa") {
    const q = await db.execute<any>(sql`
      SELECT id, route_id FROM ps_trips WHERE project_id = ${projectId}::uuid AND id = ANY(${uuids(p.tripIds)}::uuid[])`);
    if (q.rows.length !== p.tripIds.length) return { ok: false, stato: 404, errore: "Corse non trovate nel progetto" };
    routeIds = [...new Set((q.rows as any[]).map(x => String(x.route_id)))];
  } else if (p.ambito === "percorso") {
    const q = await db.execute<any>(sql`
      SELECT route_id FROM ps_route_variants WHERE id = ${p.variantId}::uuid AND project_id = ${projectId}::uuid LIMIT 1`);
    if (!q.rows[0]) return { ok: false, stato: 404, errore: "Percorso non trovato nel progetto" };
    routeIds = [String(q.rows[0].route_id)];
  } else if (p.routeIds.length > 0) {
    const q = await db.execute<any>(sql`
      SELECT id FROM ps_routes WHERE project_id = ${projectId}::uuid AND id = ANY(${uuids(p.routeIds)}::uuid[])`);
    if (q.rows.length !== p.routeIds.length) return { ok: false, stato: 404, errore: "Linee non trovate nel progetto" };
    routeIds = p.routeIds;
  } else {
    routeIds = ((await db.execute<any>(sql`SELECT id FROM ps_routes WHERE project_id = ${projectId}::uuid`)).rows as any[])
      .map(x => String(x.id));
  }

  const { corse: contesto, notaValidita } = await caricaCorse(projectId, routeIds, p.dayTypeId);
  if (contesto.length > MAX_CORSE_CONTESTO) {
    return { ok: false, stato: 400, errore: `${contesto.length} corse da leggere: troppe, restringi le linee` };
  }
  const scelte = new Set(p.tripIds);
  const bersaglio = contesto.filter(c =>
    p.ambito === "corsa" ? scelte.has(c.tripId) : p.ambito === "percorso" ? c.variantId === p.variantId : true);
  if (bersaglio.length === 0) {
    return {
      ok: false, stato: 400,
      errore: p.ambito === "corsa" ? "La corsa non circola nel giorno-tipo scelto" : "Nessuna corsa del giorno-tipo nell'ambito scelto",
    };
  }
  if (bersaglio.length > MAX_CORSE_AMBITO) {
    return { ok: false, stato: 400, errore: `${bersaglio.length} corse: oltre ${MAX_CORSE_AMBITO} in un colpo, restringi l'ambito` };
  }

  /* I tempi osservati: il tipo di giorno delle corse, poi (se chiesto) i
   * feriali per le coppie che quel tipo non vede. */
  const tipo = tipoPerGiornoTipo(dt.code ?? dt.name);
  const coppie = new Map<string, { da: string; a: string }>();
  for (const c of contesto) {
    for (let i = 0; i + 1 < c.fermate.length; i++) {
      const da = c.fermate[i].gtfsId, a = c.fermate[i + 1].gtfsId;
      if (da && a) coppie.set(`${da}>${a}`, { da, a });
    }
  }
  const oggi = giornataOggi();
  const date = giorniOsservati(tipo, oggi, p.giorni);
  const lettura = await leggiOsservato([...coppie.values()], date, feedId);
  const oss: Osservato = lettura.osservato;
  let daRipiego = new Set<string>();
  if (p.ripiego && tipo !== "feriale") {
    const mancanti = [...coppie.values()].filter(c => !oss.haDati(c.da, c.a));
    if (mancanti.length > 0) {
      const feriali = await leggiOsservato(mancanti, giorniOsservati("feriale", oggi, p.giorni), feedId);
      daRipiego = oss.assorbi(feriali.osservato);
    }
  }

  const ricalcoli = new Map<string, { r: Ricalcolo; seqs: number[]; originali: FermataCorsa[] }>();
  const soloRicalcoli = new Map<string, Ricalcolo>();
  for (const c of bersaglio) {
    const r = ricalcolaCorsa(c, oss, { valore: p.valore, daRipiego });
    ricalcoli.set(c.tripId, { r, seqs: c.seqs, originali: c.fermate });
    soloRicalcoli.set(c.tripId, r);
  }
  const esiti = confronto(contesto, soloRicalcoli, oss);

  const linee = new Map<string, string | null>();
  for (const x of (await db.execute<any>(sql`
    SELECT id, short_name FROM ps_routes WHERE id = ANY(${uuids(routeIds)}::uuid[])`)).rows as any[]) linee.set(String(x.id), x.short_name ?? null);
  const varianti = new Map<string, string | null>();
  const vIds = [...new Set(bersaglio.map(c => c.variantId))];
  for (const x of (await db.execute<any>(sql`
    SELECT id, code, name FROM ps_route_variants WHERE id = ANY(${uuids(vIds)}::uuid[])`)).rows as any[]) {
    varianti.set(String(x.id), x.code || x.name || null);
  }

  const corse: RigaAnteprima[] = bersaglio.map(c => {
    const { r } = ricalcoli.get(c.tripId)!;
    const e = esiti.get(c.tripId);
    const ultimaPrima = c.fermate[c.fermate.length - 1], ultimaDopo = r.fermate[r.fermate.length - 1];
    return {
      tripId: c.tripId, routeId: c.routeId, linea: linee.get(c.routeId) ?? null,
      variantId: c.variantId, percorso: varianti.get(c.variantId) ?? null, direzione: c.direzione,
      partenza: hhmm(c.fermate[0]?.partenzaS ?? c.fermate[0]?.arrivoS ?? null),
      arrivoAttuale: hhmm(ultimaPrima?.arrivoS ?? ultimaPrima?.partenzaS ?? null),
      arrivoNuovo: r.saltata ? null : hhmm(ultimaDopo?.arrivoS ?? ultimaDopo?.partenzaS ?? null),
      variazioneMin: r.saltata ? null : variazioneArrivoMin(c.fermate, r.fermate),
      tratti: r.tratti, fonti: r.fonti, cambia: r.cambia, saltata: r.saltata,
      prima: e?.prima ?? null, dopo: r.saltata ? (e?.prima ?? null) : (e?.dopo ?? null),
    };
  }).sort((x, y) =>
    String(x.linea ?? "").localeCompare(String(y.linea ?? ""), "it", { numeric: true })
    || String(x.percorso ?? "").localeCompare(String(y.percorso ?? ""), "it")
    || String(x.partenza ?? "").localeCompare(String(y.partenza ?? "")));

  const conta = (lato: "prima" | "dopo") => corse.reduce<Record<string, number>>((m, x) => {
    const g = x[lato]?.giudizio ?? "senza_dati";
    m[g] = (m[g] ?? 0) + 1;
    return m;
  }, {});

  return {
    ok: true,
    a: {
      giornoTipo: { id: dt.id, codice: dt.code ?? null, nome: dt.name ?? null },
      osservazione: {
        tipoGiorno: tipo, giorni: p.giorni, giorniDelTipo: date.length,
        dal: date.length ? date[date.length - 1] : null, al: date.length ? date[0] : null,
        transiti: lettura.transiti,
        fonte: lettura.soloSiri ? "SIRI" : "transiti AVM (origine non distinta)",
        disponibile: lettura.disponibile,
        coppieDaFeriale: daRipiego.size,
      },
      notaValidita,
      corse,
      riepilogo: {
        corse: corse.length,
        cambiano: corse.filter(x => x.cambia).length,
        saltate: corse.filter(x => x.saltata).length,
        prima: conta("prima"), dopo: conta("dopo"),
      },
      ricalcoli,
    },
  };
}

/** Scrive gli orari nuovi delle corse scelte (fra quelle ricalcolate), in una
 *  transazione sola: solo le fermate il cui orario cambia davvero. */
export async function scriviAcquisizione(a: Acquisizione, applica: string[]): Promise<{
  corse: number; fermate: number; nonNellAmbito: number; senzaModifiche: number; saltate: number;
}> {
  const ids: string[] = [], seqs: number[] = [], arrivi: string[] = [], partenze: string[] = [];
  const corse = new Set<string>();
  let nonNellAmbito = 0, senzaModifiche = 0, saltate = 0;
  for (const id of new Set(applica)) {
    const x = a.ricalcoli.get(id);
    if (!x) { nonNellAmbito++; continue; }
    if (x.r.saltata) { saltate++; continue; }
    if (!x.r.cambia) { senzaModifiche++; continue; }
    x.r.fermate.forEach((f, i) => {
      const o = x.originali[i];
      if (f.arrivoS === (o.arrivoS ?? o.partenzaS) && f.partenzaS === (o.partenzaS ?? o.arrivoS)) return;
      ids.push(id); seqs.push(x.seqs[i]);
      arrivi.push(hms(f.arrivoS!)); partenze.push(hms(f.partenzaS!));
      corse.add(id);
    });
  }
  if (ids.length > 0) {
    await db.transaction(async (tx) => {
      await tx.execute(sql`
        UPDATE ps_stop_times st
           SET arrival_time = v.arrivo, departure_time = v.partenza
          FROM unnest(${`{${ids.join(",")}}`}::uuid[], ${`{${seqs.join(",")}}`}::int[],
                      ${`{${arrivi.join(",")}}`}::text[], ${`{${partenze.join(",")}}`}::text[])
               AS v(trip_id, seq, arrivo, partenza)
         WHERE st.trip_id = v.trip_id AND st.stop_seq = v.seq`);
    });
  }
  return { corse: corse.size, fermate: ids.length, nonNellAmbito, senzaModifiche, saltate };
}
