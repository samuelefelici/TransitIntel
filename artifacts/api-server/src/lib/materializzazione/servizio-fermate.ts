/**
 * Il servizio di ogni fermata di un feed (tappa 7.26): corse che ci passano,
 * corse nella punta del mattino (7–9) e della sera (17–19), e il punteggio
 * di servizio 0–100. Le stesse regole del caricamento di un GTFS
 * (routes/gtfs-upload.ts), qui in un'istruzione sola sul database.
 *
 * Il caricamento li calcolava già; i feed nati da Planning Studio no, così la
 * pagina GTFS e le analisi che li leggono mostravano zero corse a ogni
 * fermata. La materializzazione li calcola alla fine, e le pulizie del
 * lavoratore li recuperano per i feed nati prima.
 *
 * Una corsa conta una volta per fermata, con l'orario del primo passaggio
 * (partenza, o arrivo se manca).
 */

type Client = { query: (text: string, values?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };

export const SQL_SERVIZIO_FERMATE = `
  WITH passaggi AS (
    SELECT DISTINCT ON (st.trip_id, st.stop_id)
           st.stop_id,
           COALESCE(NULLIF(st.departure_time, ''), NULLIF(st.arrival_time, '')) AS ora
      FROM gtfs_stop_times st
     WHERE st.feed_id = $1::uuid
       AND COALESCE(NULLIF(st.departure_time, ''), NULLIF(st.arrival_time, '')) ~ '^[0-9]{1,3}:[0-9]{2}'
     ORDER BY st.trip_id, st.stop_id, st.stop_sequence
  ),
  per_fermata AS (
    SELECT stop_id,
           count(*)::int AS corse,
           count(*) FILTER (WHERE minuti BETWEEN 420 AND 540)::int AS mattina,
           count(*) FILTER (WHERE minuti BETWEEN 1020 AND 1140)::int AS sera
      FROM (SELECT stop_id,
                   split_part(ora, ':', 1)::int * 60 + split_part(ora, ':', 2)::int AS minuti
              FROM passaggi) p
     GROUP BY stop_id
  ),
  massimo AS (
    SELECT GREATEST(COALESCE(max(corse), 0), 1) AS m FROM per_fermata
  ),
  nuovi AS (
    SELECT s.id,
           COALESCE(p.corse, 0) AS corse,
           COALESCE(p.mattina, 0) AS mattina,
           COALESCE(p.sera, 0) AS sera
      FROM gtfs_stops s
      LEFT JOIN per_fermata p ON p.stop_id = s.stop_id
     WHERE s.feed_id = $1::uuid
  )
  UPDATE gtfs_stops s
     SET trips_count = n.corse,
         morning_peak_trips = n.mattina,
         evening_peak_trips = n.sera,
         service_score = round(((LEAST(n.corse / GREATEST(m.m * 0.3, 1), 1) * 50
                               + LEAST(n.mattina / 6.0, 1) * 25
                               + LEAST(n.sera / 6.0, 1) * 25) * 10)::numeric) / 10
    FROM nuovi n, massimo m
   WHERE s.id = n.id`;

/** Ricalcola il servizio delle fermate del feed; restituisce quante fermate ha aggiornato. */
export async function contaServizioFermate(c: Client, feedId: string): Promise<number> {
  const r = await c.query(SQL_SERVIZIO_FERMATE, [feedId]);
  return r.rowCount ?? 0;
}

/**
 * I feed con gli orari ma senza il servizio delle fermate (nati da Planning
 * Studio prima della tappa 7.26), al più `limite` per volta. `ambito` è il
 * filtro dei test (un prefisso del nome, i propri feed).
 */
export async function feedSenzaServizio(
  c: Client, limite: number, ambito: { filename?: string; feedIds?: string[] } = {},
): Promise<string[]> {
  const r = await c.query(`
    SELECT f.id
      FROM gtfs_feeds f
     WHERE ($2::uuid[] IS NULL OR f.id = ANY($2::uuid[]))
       AND ($3::text IS NULL OR f.filename LIKE $3::text)
       AND EXISTS (SELECT 1 FROM gtfs_stop_times st WHERE st.feed_id = f.id)
       AND NOT EXISTS (SELECT 1 FROM gtfs_stops s WHERE s.feed_id = f.id AND s.trips_count > 0)
     ORDER BY f.uploaded_at DESC
     LIMIT $1`, [limite, ambito.feedIds ?? null, ambito.filename ?? null]);
  return r.rows.map(x => String(x.id));
}
