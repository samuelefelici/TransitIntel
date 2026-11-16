/**
 * Le righe dei feed GTFS-Realtime (routes/gtfs-rt.ts), lette dal database
 * (tappa 4.8; analisi, PR 9).
 *
 * Gli aggregatori abbinano il tempo reale all'orario che hanno ricevuto: il
 * GTFS esportato da Planning Studio, dove corse, linee e fermate hanno il loro
 * CODICE stabile (lib/planning-studio-export.ts: `codice ?? id`). L'AVM invece
 * scrive gli identificativi del feed in esercizio, che per un programma di
 * Planning Studio sono gli id interni. Qui si traducono con le stesse regole
 * dell'export:
 *   - corsa: il codice salvato nel programmato congelato della sua giornata
 *     (esercizio_corse), altrimenti l'identificativo com'è (feed caricati);
 *   - linea e fermata: il codice di Planning Studio, se l'id è di Planning
 *     Studio, altrimenti com'è.
 *
 * Ritardi: solo i passaggi scritti dal connettore SIRI (source = 'siri'):
 * il sistema AVM scrive i propri nelle stesse tabelle, con altri codici
 * (come la proposta dall'AVM, lib/esercizio-proposta.ts).
 *
 * Soppressioni: le corse programmate che il giornale del consuntivo dà per
 * soppresse nella giornata in corso. Solo quelle confermate: un annullamento
 * dell'AVM resta un indizio finché qualcuno non lo conferma.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { giornataDi } from "./service-day";
import { hasSourceColumn, SOURCE_SIRI } from "./caronte-schema";
import type { RtCancelRow, RtDelayRow, RtPositionRow } from "./gtfs-rt-builders";

const righe = (r: any): any[] => r?.rows ?? r ?? [];
const n = (x: unknown) => (x == null ? null : Number(x));

/** Le corse soppresse della giornata "YYYY-MM-DD", coi codici del GTFS pubblicato. */
export async function soppresseDelGiorno(giorno: string): Promise<RtCancelRow[]> {
  return righe(await db.execute(sql`
    SELECT COALESCE(c.codice, c.chiave) AS trip_id, COALESCE(pr.codice, c.route_id) AS route_id,
           to_char(c.giorno, 'YYYYMMDD') AS start_date, c.partenza AS start_time
      FROM esercizio_corse c
      LEFT JOIN ps_routes pr ON pr.id::text = c.route_id
     WHERE c.giorno = ${giorno}::date AND c.origine = 'programmata' AND c.esito = 'soppressa'
     ORDER BY c.partenza NULLS LAST, 1`)).map((r) => ({
    trip_id: String(r.trip_id), route_id: r.route_id ?? null, start_date: String(r.start_date), start_time: r.start_time ?? null,
  }));
}

/** L'ultimo passaggio di SIRI di ogni corsa negli ultimi 30 minuti, coi codici del GTFS pubblicato. */
export async function ritardiRecenti(): Promise<RtDelayRow[]> {
  const soloSiri = await hasSourceColumn();
  return righe(await db.execute(sql`
    SELECT DISTINCT ON (st.trip_id)
           COALESCE(c.codice, st.trip_id) AS trip_id, COALESCE(pr.codice, st.route_id) AS route_id, st.vehicle_id,
           COALESCE(ps.codice, st.stop_id) AS stop_id, st.stop_seq, st.delay_seconds,
           EXTRACT(EPOCH FROM st.actual_ts)::bigint AS ts_epoch, to_char(c.giorno, 'YYYYMMDD') AS start_date
      FROM caronte.stop_transits st
      LEFT JOIN esercizio_corse c ON c.giorno = ${giornataDi(sql`st.actual_ts`)} AND c.chiave = st.trip_id
      LEFT JOIN ps_routes pr ON pr.id::text = st.route_id
      LEFT JOIN ps_stops ps ON ps.id::text = st.stop_id
     WHERE st.actual_ts > now() - interval '30 minutes'
       AND st.trip_id IS NOT NULL
       AND st.delay_seconds IS NOT NULL
       ${soloSiri ? sql`AND st.source = ${SOURCE_SIRI}` : sql``}
     ORDER BY st.trip_id, st.actual_ts DESC`)).map((r) => ({
    trip_id: String(r.trip_id), route_id: r.route_id ?? null, vehicle_id: r.vehicle_id ?? null,
    stop_id: r.stop_id ?? null, stop_seq: n(r.stop_seq), delay_seconds: Number(r.delay_seconds),
    ts_epoch: Number(r.ts_epoch), start_date: r.start_date ?? null,
  }));
}

/** L'ultima posizione di ogni mezzo negli ultimi 10 minuti, con la corsa attiva, coi codici del GTFS pubblicato. */
export async function posizioniRecenti(): Promise<RtPositionRow[]> {
  return righe(await db.execute(sql`
    WITH latest AS (
      SELECT DISTINCT ON (COALESCE(vp.vehicle_id, vp.trip_id))
             vp.vehicle_id, vp.trip_id, vp.lat, vp.lon, vp.speed, vp.heading,
             vp.nearest_stop_id, vp.ts, EXTRACT(EPOCH FROM vp.ts)::bigint AS ts_epoch
      FROM caronte.vehicle_positions vp
      WHERE vp.ts > now() - interval '10 minutes'
        AND (vp.vehicle_id IS NOT NULL OR vp.trip_id IS NOT NULL)
      ORDER BY COALESCE(vp.vehicle_id, vp.trip_id), vp.ts DESC
    ), con_corsa AS (
      SELECT l.*, COALESCE(a.trip_id, l.trip_id) AS corsa, a.route_id
      FROM latest l
      LEFT JOIN LATERAL (
        SELECT a.trip_id, a.route_id FROM caronte.active_trips a
        WHERE a.ended_at IS NULL
          AND ((l.vehicle_id IS NOT NULL AND a.vehicle_id = l.vehicle_id)
            OR (l.vehicle_id IS NULL AND a.trip_id = l.trip_id))
        ORDER BY a.started_at DESC LIMIT 1
      ) a ON true
    )
    SELECT k.vehicle_id,
           COALESCE(c.codice, k.corsa) AS trip_id,
           COALESCE(pr.codice, k.route_id) AS route_id,
           k.lat, k.lon, k.speed, k.heading,
           COALESCE(ps.codice, k.nearest_stop_id) AS stop_id,
           st.stop_seq, k.ts_epoch, to_char(c.giorno, 'YYYYMMDD') AS start_date
    FROM con_corsa k
    LEFT JOIN esercizio_corse c ON c.giorno = ${giornataDi(sql`k.ts`)} AND c.chiave = k.corsa
    LEFT JOIN ps_routes pr ON pr.id::text = k.route_id
    LEFT JOIN ps_stops ps ON ps.id::text = k.nearest_stop_id
    LEFT JOIN LATERAL (
      SELECT st.stop_seq FROM caronte.stop_transits st
      WHERE st.trip_id = k.corsa
        AND st.actual_ts > now() - interval '6 hours'
      ORDER BY st.actual_ts DESC LIMIT 1
    ) st ON true`)).map((r) => ({
    vehicle_id: r.vehicle_id ?? null, trip_id: r.trip_id ?? null, route_id: r.route_id ?? null,
    lat: Number(r.lat), lon: Number(r.lon), speed: n(r.speed), heading: n(r.heading),
    stop_id: r.stop_id ?? null, stop_seq: n(r.stop_seq), ts_epoch: Number(r.ts_epoch), start_date: r.start_date ?? null,
  }));
}
