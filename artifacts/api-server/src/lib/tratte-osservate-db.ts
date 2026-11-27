/**
 * Le tratte osservate dai passaggi SIRI (caronte.stop_transits): la lettura
 * del calcolo unico. Le regole (sosta di regolazione, fasce orarie) sono in
 * tratte-osservate.ts; qui c'è solo il database.
 *
 * "Consecutive" vale secondo l'orario del feed (rango della sequenza): se il
 * bus passa da A, poi da X, poi da B, la coppia A→B non è un tratto. Filtrare
 * le fermate prima della finestra è quindi sicuro: il rango scarta la coppia
 * che salta una fermata non in elenco.
 *
 * La sosta alla fermata di partenza si misura sul GPS (vehicle_positions,
 * indice per vettura e istante): l'ultimo rilevamento entro RAGGIO_SOSTA_M
 * dalla fermata, fra il suo passaggio e quello della fermata dopo, è la
 * ripartenza. Si cerca solo quando il tratto dura più della sosta normale:
 * sotto, non c'è nulla da togliere.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { giornataDi, oraDi } from "./service-day";
import { hasSourceColumn, schemaState, SOURCE_SIRI } from "./caronte-schema";
import { SOSTA_NORMALE_S, RAGGIO_SOSTA_M, fasciaSql, type CodiceFascia } from "./tratte-osservate";

export interface OpzioniTratte {
  /** giornate di esercizio da leggere ("YYYY-MM-DD"): decidono il tipo di giorno */
  date: string[];
  /** solo queste coppie di fermate GTFS (consigliato quando si conoscono) */
  coppie?: Array<{ da: string; a: string }>;
  /** solo i passaggi di questa linea del feed */
  routeId?: string | null;
  /** fascia oraria di partenza dalla prima fermata del tratto [oraDa, oraA) */
  oraDa?: number | null;
  oraA?: number | null;
  /** una riga per linea: la stessa tratta su due linee resta separata */
  perLinea?: boolean;
  /** anche le righe per ora e per fascia oraria, oltre alla giornata */
  perOra?: boolean;
  /** campioni minimi perché una riga esca */
  minCampioni?: number;
  /** al massimo tante righe, le più osservate (solo senza perOra) */
  limite?: number;
  feedId: string | null;
}

export interface TrattaOsservata {
  linea: string | null;
  da: string;
  a: string;
  /** ora di partenza dal primo nodo; null = fascia o giornata */
  ora: number | null;
  /** fascia oraria; null = ora o giornata */
  fascia: CodiceFascia | null;
  n: number;
  giorni: number;
  medianaS: number;
  p85S: number;
  /** il programmato del feed per quel tratto (media), dai passaggi */
  programmatoS: number | null;
  /** la sosta di regolazione tolta: su quante corse, e quanto (mediana) */
  sosta: { corse: number; medianaS: number } | null;
}

export interface LetturaTratte {
  tratte: TrattaOsservata[];
  /** passaggi usati (righe di giornata) */
  transiti: number;
  disponibile: boolean;
  soloSiri: boolean;
}

export async function leggiTratte(o: OpzioniTratte): Promise<LetturaTratte> {
  const stato = await schemaState();
  const date = [...new Set(o.date)].filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  if (!stato.ready || date.length === 0 || (o.coppie && o.coppie.length === 0)) {
    return { tratte: [], transiti: 0, disponibile: stato.ready, soloSiri: false };
  }
  const siri = await hasSourceColumn();
  const fSt = siri ? sql`st.source = ${SOURCE_SIRI}` : sql`TRUE`;
  const fVp = siri ? sql`vp.source = ${SOURCE_SIRI}` : sql`TRUE`;
  const dal = date[0], al = date[date.length - 1];
  const giorno = giornataDi(sql`st.actual_ts`);
  const minimo = Math.max(1, Math.floor(o.minCampioni ?? 1));
  const oraDa = o.oraDa ?? null, oraA = o.oraA ?? null;

  const coppie = o.coppie ?? null;
  const fermate = coppie ? [...new Set(coppie.flatMap(c => [c.da, c.a]))] : null;
  /* La CTE delle coppie c'è sempre (vuota se non si filtra): una sola forma
   * di query, e il join si mette solo quando le coppie ci sono. */
  const elencoCoppie = coppie
    ? sql`SELECT DISTINCT c.da, c.a
            FROM unnest(${arr(coppie.map(c => c.da))}::text[], ${arr(coppie.map(c => c.a))}::text[]) AS c(da, a)`
    : sql`SELECT NULL::text AS da, NULL::text AS a WHERE false`;
  const fFermate = fermate ? sql`AND st.stop_id = ANY(${arr(fermate)}::text[])` : sql``;
  const fLinea = o.routeId ? sql`AND st.route_id = ${o.routeId}` : sql``;
  const joinCoppie = coppie ? sql`JOIN coppie c ON c.da = s.prev_stop AND c.a = s.stop_id` : sql``;
  const linea = o.perLinea ? sql`route_id` : sql`NULL::text`;
  const raggruppa = o.perOra
    ? sql`ora, fascia, GROUPING(ora) AS g_ora, GROUPING(fascia) AS g_fascia`
    : sql`NULL::int AS ora, NULL::text AS fascia, 1 AS g_ora, 1 AS g_fascia`;
  const gruppi = o.perOra
    ? sql`GROUP BY GROUPING SETS ((linea, da, a, ora), (linea, da, a, fascia), (linea, da, a))`
    : sql`GROUP BY linea, da, a`;
  /* Il limite vale per le sole righe di giornata: con le ore e le fasce
   * taglierebbe a caso dentro la stessa tratta. */
  const limite = o.limite && o.limite > 0 && !o.perOra
    ? sql`ORDER BY n DESC LIMIT ${Math.floor(o.limite)}`
    : sql``;

  const r = await db.execute<any>(sql`
    WITH coppie AS (
      ${elencoCoppie}
    ),
    t AS (
      SELECT st.trip_id, st.route_id, st.vehicle_id, st.stop_id, st.stop_seq,
             st.actual_ts, st.scheduled, ${giorno} AS giorno
        FROM caronte.stop_transits st
       WHERE ${fSt}
         AND st.actual_ts >= (${dal}::date - interval '1 day')
         AND st.actual_ts <  (${al}::date + interval '2 day')
         AND st.stop_seq IS NOT NULL
         ${fFermate}
         ${fLinea}
         AND ${giorno} = ANY(${`{${date.join(",")}}`}::date[])
    ),
    prog AS (
      SELECT trip_id, stop_sequence,
             DENSE_RANK() OVER (PARTITION BY trip_id ORDER BY stop_sequence) AS rango
        FROM gtfs_stop_times
       WHERE ${o.feedId}::text IS NOT NULL AND feed_id = ${o.feedId}::uuid
         AND trip_id IN (SELECT DISTINCT trip_id FROM t)
    ),
    seq AS (
      SELECT t.route_id, t.vehicle_id, t.stop_id, t.actual_ts, t.scheduled, t.giorno,
             COALESCE(p.rango, t.stop_seq) AS rango,
             LAG(t.stop_id)   OVER w AS prev_stop,
             LAG(t.actual_ts) OVER w AS prev_ts,
             LAG(t.scheduled) OVER w AS prev_sched,
             LAG(COALESCE(p.rango, t.stop_seq)) OVER w AS prev_rango
        FROM t LEFT JOIN prog p ON p.trip_id = t.trip_id AND p.stop_sequence = t.stop_seq
      WINDOW w AS (PARTITION BY t.trip_id, t.vehicle_id, t.giorno ORDER BY t.stop_seq)
    ),
    coppia AS (
      SELECT s.*, EXTRACT(EPOCH FROM s.actual_ts - s.prev_ts) AS lordo
        FROM seq s ${joinCoppie}
       WHERE s.prev_stop IS NOT NULL AND s.rango = s.prev_rango + 1
         AND EXTRACT(EPOCH FROM s.actual_ts - s.prev_ts) BETWEEN 5 AND 3600
         AND (${oraDa}::int IS NULL OR ${oraDi(sql`s.prev_ts`)} >= ${oraDa}::int)
         AND (${oraA}::int IS NULL OR ${oraDi(sql`s.prev_ts`)} < ${oraA}::int)
    ),
    sosta AS (
      SELECT c.*, GREATEST(0, COALESCE(EXTRACT(EPOCH FROM d.partito - c.prev_ts), 0)) AS sosta_s
        FROM coppia c
        LEFT JOIN gtfs_stops gs
          ON ${o.feedId}::text IS NOT NULL AND gs.feed_id = ${o.feedId}::uuid AND gs.stop_id = c.prev_stop
        LEFT JOIN LATERAL (
          SELECT max(vp.ts) AS partito
            FROM caronte.vehicle_positions vp
           WHERE c.lordo > ${SOSTA_NORMALE_S + 10}
             AND c.vehicle_id IS NOT NULL AND gs.stop_lat IS NOT NULL
             AND vp.vehicle_id = c.vehicle_id
             AND vp.ts > c.prev_ts AND vp.ts < c.actual_ts
             AND ${fVp}
             AND vp.lat BETWEEN gs.stop_lat::float - (${RAGGIO_SOSTA_M}::float / 111320.0)
                            AND gs.stop_lat::float + (${RAGGIO_SOSTA_M}::float / 111320.0)
             AND vp.lon BETWEEN gs.stop_lon::float - (${RAGGIO_SOSTA_M}::float / (111320.0 * cos(radians(gs.stop_lat::float))))
                            AND gs.stop_lon::float + (${RAGGIO_SOSTA_M}::float / (111320.0 * cos(radians(gs.stop_lat::float))))
             AND 6371000.0 * sqrt(
                   power(radians(vp.lat - gs.stop_lat::float), 2) +
                   power(radians(vp.lon - gs.stop_lon::float) * cos(radians((vp.lat + gs.stop_lat::float) / 2.0)), 2)
                 ) <= ${RAGGIO_SOSTA_M}::float
        ) d ON true
    ),
    oss AS (
      SELECT ${linea} AS linea, prev_stop AS da, stop_id AS a, giorno,
             ${oraDi(sql`prev_ts`)} AS ora,
             lordo - GREATEST(0, sosta_s - ${SOSTA_NORMALE_S}) AS sec,
             GREATEST(0, sosta_s - ${SOSTA_NORMALE_S}) AS tolta,
             CASE WHEN scheduled ~ '^\\d+:\\d{2}' AND prev_sched ~ '^\\d+:\\d{2}' THEN
               (split_part(scheduled,  ':', 1)::int * 3600 + split_part(scheduled,  ':', 2)::int * 60
                + COALESCE(NULLIF(split_part(scheduled,  ':', 3), ''), '0')::int)
             - (split_part(prev_sched, ':', 1)::int * 3600 + split_part(prev_sched, ':', 2)::int * 60
                + COALESCE(NULLIF(split_part(prev_sched, ':', 3), ''), '0')::int)
             END AS sched_s
        FROM sosta
    ),
    x AS (SELECT oss.*, ${fasciaSql(sql`oss.ora`)} AS fascia FROM oss)
    SELECT linea, da, a, ${raggruppa},
           COUNT(*)::int AS n, COUNT(DISTINCT giorno)::int AS giorni,
           percentile_cont(0.5)  WITHIN GROUP (ORDER BY sec) AS mediana,
           percentile_cont(0.85) WITHIN GROUP (ORDER BY sec) AS p85,
           AVG(sched_s) FILTER (WHERE sched_s >= 0 AND sched_s <= 3600) AS programmato,
           COUNT(*) FILTER (WHERE tolta > 0)::int AS con_sosta,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY tolta) FILTER (WHERE tolta > 0) AS sosta_mediana
      FROM x
     ${gruppi}
    HAVING COUNT(*) >= ${minimo}
     ${limite}
  `);

  const tratte: TrattaOsservata[] = [];
  let transiti = 0;
  for (const x of (r.rows ?? []) as any[]) {
    const medianaS = Number(x.mediana), p85S = Number(x.p85);
    if (!Number.isFinite(medianaS) || !Number.isFinite(p85S)) continue;
    const perOra = Number(x.g_ora) === 0, perFascia = Number(x.g_fascia) === 0;
    const n = Number(x.n), conSosta = Number(x.con_sosta ?? 0);
    tratte.push({
      linea: x.linea == null ? null : String(x.linea),
      da: String(x.da), a: String(x.a),
      ora: perOra && x.ora != null ? Number(x.ora) : null,
      fascia: perFascia && x.fascia != null ? (String(x.fascia) as CodiceFascia) : null,
      n, giorni: Number(x.giorni), medianaS, p85S,
      programmatoS: x.programmato == null ? null : Math.round(Number(x.programmato)),
      sosta: conSosta > 0 && x.sosta_mediana != null
        ? { corse: conSosta, medianaS: Math.round(Number(x.sosta_mediana)) } : null,
    });
    if (!perOra && !perFascia) transiti += n;
  }
  return { tratte, transiti, disponibile: true, soloSiri: siri };
}

/** Un letterale d'array di Postgres: valori fra virgolette, con virgolette e
 *  barre rovesciate protette (gli id delle fermate sono testo libero). */
function arr(valori: string[]): string {
  return `{${valori.map(v => `"${String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(",")}}`;
}
