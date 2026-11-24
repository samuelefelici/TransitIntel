/**
 * Le corse di un giorno tipo di un feed (tappa 7.31).
 *
 * La pagina Fermate & Linee mostrava come «corse al giorno» il numero di tutte
 * le corse del feed: con più calendari (invernale, estivo, scolastico) sono
 * molte di più di quelle che girano in un giorno. Qui si contano le corse di
 * ogni giorno del periodo del feed (calendar con le sue eccezioni, più le date
 * aggiunte da calendar_dates) e per feriale, sabato e domenica si prende la
 * mediana: un giorno festivo infrasettimanale o un giorno di sciopero non la
 * spostano.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

export interface CorseNelGiornoTipo {
  feriale: number | null;
  sabato: number | null;
  festivo: number | null;
}

const numero = (v: unknown): number | null => (v == null ? null : Number(v));

export async function corseNelGiornoTipo(feedId: string): Promise<CorseNelGiornoTipo> {
  const r = await db.execute(sql`
    WITH dal_calendario AS (
      SELECT c.service_id, g::date AS giorno
        FROM gtfs_calendar c,
             generate_series(to_date(c.start_date, 'YYYYMMDD'), to_date(c.end_date, 'YYYYMMDD'), interval '1 day') AS g
       WHERE c.feed_id = ${feedId}::uuid
         AND CASE EXTRACT(ISODOW FROM g)::int
               WHEN 1 THEN c.monday   WHEN 2 THEN c.tuesday WHEN 3 THEN c.wednesday
               WHEN 4 THEN c.thursday WHEN 5 THEN c.friday  WHEN 6 THEN c.saturday
               ELSE c.sunday END = 1
    ), attivi AS (
      SELECT k.service_id, k.giorno FROM dal_calendario k
       WHERE NOT EXISTS (SELECT 1 FROM gtfs_calendar_dates x
                          WHERE x.feed_id = ${feedId}::uuid AND x.service_id = k.service_id
                            AND x.date = to_char(k.giorno, 'YYYYMMDD') AND x.exception_type = 2)
      UNION
      SELECT a.service_id, to_date(a.date, 'YYYYMMDD') FROM gtfs_calendar_dates a
       WHERE a.feed_id = ${feedId}::uuid AND a.exception_type = 1
    ), per_servizio AS (
      SELECT service_id, count(*)::int AS corse FROM gtfs_trips WHERE feed_id = ${feedId}::uuid GROUP BY 1
    ), per_giorno AS (
      SELECT a.giorno, sum(p.corse)::int AS corse FROM attivi a JOIN per_servizio p USING (service_id) GROUP BY 1
    )
    SELECT
      percentile_disc(0.5) WITHIN GROUP (ORDER BY corse) FILTER (WHERE EXTRACT(ISODOW FROM giorno) <= 5) AS feriale,
      percentile_disc(0.5) WITHIN GROUP (ORDER BY corse) FILTER (WHERE EXTRACT(ISODOW FROM giorno) = 6) AS sabato,
      percentile_disc(0.5) WITHIN GROUP (ORDER BY corse) FILTER (WHERE EXTRACT(ISODOW FROM giorno) = 7) AS festivo
    FROM per_giorno
  `);
  const riga = (r.rows[0] ?? {}) as Record<string, unknown>;
  return { feriale: numero(riga.feriale), sabato: numero(riga.sabato), festivo: numero(riga.festivo) };
}

/** Media delle linee che passano per ogni fermata servita, da (corsa, fermata) e dalla linea di ogni corsa. */
export function lineePerFermata(passaggi: Iterable<{ trip_id: string; stop_id: string }>, lineaDellaCorsa: Map<string, string>): number | null {
  const perFermata = new Map<string, Set<string>>();
  for (const p of passaggi) {
    const linea = lineaDellaCorsa.get(p.trip_id);
    if (linea === undefined) continue;
    let linee = perFermata.get(p.stop_id);
    if (!linee) perFermata.set(p.stop_id, (linee = new Set()));
    linee.add(linea);
  }
  if (!perFermata.size) return null;
  let somma = 0;
  for (const linee of perFermata.values()) somma += linee.size;
  return Math.round((somma / perFermata.size) * 10) / 10;
}
