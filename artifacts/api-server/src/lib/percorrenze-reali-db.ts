/**
 * Le percorrenze reali dai transiti SIRI/AVM (caronte.stop_transits), per le
 * sole coppie di fermate che servono: il calcolo è in percorrenze-reali.ts.
 *
 * "Consecutive" vale secondo l'orario del feed (rango della sequenza), come
 * in /operations/runtimes: se il bus passa da A, poi da X, poi da B, la coppia
 * A→B non è un tratto. Filtrare le fermate prima della finestra è quindi
 * sicuro: il rango scarta la coppia che salta una fermata non in elenco.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { giornataDi, oraDi } from "./service-day";
import { hasSourceColumn, schemaState, SOURCE_SIRI } from "./caronte-schema";
import { Osservato } from "./percorrenze-reali";

export interface Lettura { osservato: Osservato; transiti: number; disponibile: boolean; soloSiri: boolean }

export async function leggiOsservato(
  coppie: Array<{ da: string; a: string }>, date: string[], feedId: string | null,
): Promise<Lettura> {
  const osservato = new Osservato();
  const stato = await schemaState();
  if (!stato.ready || coppie.length === 0 || date.length === 0) {
    return { osservato, transiti: 0, disponibile: stato.ready, soloSiri: false };
  }
  const siri = await hasSourceColumn();
  const fSt = siri ? sql`st.source = ${SOURCE_SIRI}` : sql`TRUE`;
  const fermate = [...new Set(coppie.flatMap(c => [c.da, c.a]))];
  const da = coppie.map(c => c.da), a = coppie.map(c => c.a);
  const ordinate = [...date].sort();
  const dal = ordinate[0], al = ordinate[ordinate.length - 1];
  const giorno = giornataDi(sql`st.actual_ts`);
  const r = await db.execute<any>(sql`
    WITH coppie AS (
      SELECT DISTINCT c.da, c.a FROM unnest(${`{${da.map(q).join(",")}}`}::text[], ${`{${a.map(q).join(",")}}`}::text[]) AS c(da, a)
    ),
    t AS (
      SELECT st.trip_id, st.vehicle_id, st.stop_id, st.stop_seq, st.actual_ts, ${giorno} AS giorno
        FROM caronte.stop_transits st
       WHERE ${fSt}
         AND st.actual_ts >= (${dal}::date - interval '1 day')
         AND st.actual_ts <  (${al}::date + interval '2 day')
         AND st.stop_seq IS NOT NULL
         AND st.stop_id = ANY(${`{${fermate.map(q).join(",")}}`}::text[])
         AND ${giorno} = ANY(${`{${ordinate.join(",")}}`}::date[])
    ),
    prog AS (
      SELECT trip_id, stop_sequence,
             DENSE_RANK() OVER (PARTITION BY trip_id ORDER BY stop_sequence) AS rango
        FROM gtfs_stop_times
       WHERE ${feedId}::text IS NOT NULL AND feed_id = ${feedId}::uuid
         AND trip_id IN (SELECT DISTINCT trip_id FROM t)
    ),
    seq AS (
      SELECT t.stop_id, t.actual_ts, t.giorno,
             COALESCE(p.rango, t.stop_seq) AS rango,
             LAG(t.stop_id)   OVER w AS prev_stop,
             LAG(t.actual_ts) OVER w AS prev_ts,
             LAG(COALESCE(p.rango, t.stop_seq)) OVER w AS prev_rango
        FROM t LEFT JOIN prog p ON p.trip_id = t.trip_id AND p.stop_sequence = t.stop_seq
      WINDOW w AS (PARTITION BY t.trip_id, t.vehicle_id, t.giorno ORDER BY t.stop_seq)
    ),
    oss AS (
      SELECT s.prev_stop AS da, s.stop_id AS a, ${oraDi(sql`s.prev_ts`)} AS ora, s.giorno,
             EXTRACT(EPOCH FROM s.actual_ts - s.prev_ts) AS sec
        FROM seq s JOIN coppie c ON c.da = s.prev_stop AND c.a = s.stop_id
       WHERE s.prev_stop IS NOT NULL AND s.rango = s.prev_rango + 1
         AND EXTRACT(EPOCH FROM s.actual_ts - s.prev_ts) BETWEEN 5 AND 3600
    )
    SELECT da, a, ora, COUNT(*)::int AS n, COUNT(DISTINCT giorno)::int AS giorni,
           percentile_cont(0.5)  WITHIN GROUP (ORDER BY sec) AS mediana,
           percentile_cont(0.85) WITHIN GROUP (ORDER BY sec) AS p85
      FROM oss
     GROUP BY GROUPING SETS ((da, a, ora), (da, a))
  `);
  let transiti = 0;
  for (const x of (r.rows ?? []) as any[]) {
    const stat = { n: Number(x.n), giorni: Number(x.giorni), medianaS: Number(x.mediana), p85S: Number(x.p85) };
    if (!Number.isFinite(stat.medianaS) || !Number.isFinite(stat.p85S)) continue;
    osservato.aggiungi(String(x.da), String(x.a), x.ora == null ? null : Number(x.ora), stat);
    if (x.ora == null) transiti += stat.n;
  }
  return { osservato, transiti, disponibile: true, soloSiri: siri };
}

/** Un valore dentro un letterale d'array di Postgres: tra virgolette, con
 *  virgolette e barre rovesciate protette (gli id delle fermate sono testo). */
function q(v: string): string {
  return `"${String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
