/**
 * Le corse di una giornata di esercizio (tappa 4): il programma in esercizio
 * all'inizio della giornata e le corse del suo feed che circolano quel giorno.
 * Le usano la diagnosi (lib/esercizio-diagnosi.ts) e le giornate congelate
 * (lib/esercizio-giornate.ts). Solo lettura; il lavoratore la può importare.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { inizioDi } from "./service-day";
import { codiceCorsaDi } from "./siri-vm";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const righe = (r: any): any[] => r?.rows ?? r ?? [];
const lista = (xs: unknown[]) => sql`(SELECT jsonb_array_elements_text(${JSON.stringify(xs)}::jsonb))`;

export interface CorsaDelGiorno {
  /** il trip_id del feed: per i feed di Planning Studio è l'id della corsa */
  tripId: string;
  routeId: string | null;
  linea: string | null;
  shapeId: string | null;
  /** il codice del percorso nel feed (variant_code), se c'è */
  variante: string | null;
  direzione: number | null;
  aChiamata: boolean;
  partenza: string | null;
  arrivo: string | null;
  fermataDa: string | null;
  fermataA: string | null;
  /** il codice stabile di Planning Studio, se la corsa ne viene */
  codice: string | null;
  /** il numero di corsa: l'ultima parte del codice (o del trip_id) */
  numero: string;
}

export interface ProgrammaDelGiorno {
  feedId: string;
  progettoId: string | null;
  progetto: string | null;
  file: string | null;
  via: string | null;
  attivatoIl: string | null;
}

/** Il programma (progetto e feed) in esercizio all'inizio della giornata, dallo storico delle attivazioni. */
export async function programmaAllInizio(giorno: string): Promise<ProgrammaDelGiorno | null> {
  const r = righe(await db.execute(sql`
    SELECT l.feed_id::text AS feed_id, l.project_id::text AS project_id, l.via,
           l.activated_at, f.filename, p.name AS progetto
      FROM ps_activation_log l
      LEFT JOIN gtfs_feeds f ON f.id = l.feed_id
      LEFT JOIN ps_projects p ON p.id = l.project_id
     WHERE l.activated_at <= ${inizioDi(giorno)}
       AND (l.deactivated_at IS NULL OR l.deactivated_at > ${inizioDi(giorno)})
     ORDER BY l.activated_at DESC LIMIT 1`));
  const x = r[0];
  return x ? {
    feedId: x.feed_id as string, progettoId: (x.project_id as string | null) ?? null, progetto: x.progetto ?? null,
    file: x.filename ?? null, via: x.via ?? null, attivatoIl: x.activated_at ? new Date(x.activated_at).toISOString() : null,
  } : null;
}

/**
 * Le corse di un feed che circolano nel giorno: settimana del calendario nel
 * periodo, meno le date tolte, più quelle aggiunte (la regola dell'aggancio,
 * siri-ingest, e della copertura, operations). Con orari e capolinea dalla
 * prima e dall'ultima fermata.
 */
export async function corseDelFeedNelGiorno(feedId: string, giorno: string): Promise<CorsaDelGiorno[]> {
  const ymd = giorno.replace(/-/g, "");
  const r = righe(await db.execute(sql`
    WITH attivi AS (
      SELECT c.service_id FROM gtfs_calendar c
       WHERE c.feed_id = ${feedId}::uuid AND c.start_date <= ${ymd} AND c.end_date >= ${ymd}
         AND CASE EXTRACT(ISODOW FROM ${giorno}::date)::int
               WHEN 1 THEN c.monday    WHEN 2 THEN c.tuesday WHEN 3 THEN c.wednesday
               WHEN 4 THEN c.thursday  WHEN 5 THEN c.friday  WHEN 6 THEN c.saturday
               ELSE c.sunday END = 1
         AND NOT EXISTS (SELECT 1 FROM gtfs_calendar_dates x
                          WHERE x.feed_id = c.feed_id AND x.service_id = c.service_id
                            AND x.date = ${ymd} AND x.exception_type = 2)
      UNION
      SELECT a.service_id FROM gtfs_calendar_dates a
       WHERE a.feed_id = ${feedId}::uuid AND a.date = ${ymd} AND a.exception_type = 1
    ), corse AS (
      SELECT t.* FROM gtfs_trips t JOIN attivi a ON a.service_id = t.service_id WHERE t.feed_id = ${feedId}::uuid
    ), estremi AS (
      SELECT st.trip_id, min(st.stop_sequence) AS primo, max(st.stop_sequence) AS ultimo
        FROM gtfs_stop_times st
       WHERE st.feed_id = ${feedId}::uuid AND st.trip_id IN (SELECT trip_id FROM corse)
       GROUP BY st.trip_id
    )
    SELECT c.trip_id, c.route_id, c.shape_id, c.variant_code, c.direction_id, COALESCE(c.on_demand, false) AS on_demand,
           r.route_short_name, a.departure_time AS partenza, b.arrival_time AS arrivo,
           sa.stop_name AS fermata_da, sb.stop_name AS fermata_a
      FROM corse c
      LEFT JOIN estremi e ON e.trip_id = c.trip_id
      LEFT JOIN gtfs_stop_times a ON a.feed_id = c.feed_id AND a.trip_id = c.trip_id AND a.stop_sequence = e.primo
      LEFT JOIN gtfs_stop_times b ON b.feed_id = c.feed_id AND b.trip_id = c.trip_id AND b.stop_sequence = e.ultimo
      LEFT JOIN gtfs_stops sa ON sa.feed_id = c.feed_id AND sa.stop_id = a.stop_id
      LEFT JOIN gtfs_stops sb ON sb.feed_id = c.feed_id AND sb.stop_id = b.stop_id
      LEFT JOIN gtfs_routes r ON r.feed_id = c.feed_id AND r.route_id = c.route_id
     ORDER BY a.departure_time NULLS LAST, c.trip_id`));
  /* il codice stabile: le corse dei feed di Planning Studio hanno per trip_id l'id della corsa */
  const ids = r.map(x => String(x.trip_id)).filter(id => UUID.test(id));
  const codici = new Map<string, string>();
  if (ids.length) {
    for (const x of righe(await db.execute(sql`
      SELECT id::text AS id, codice FROM ps_trips WHERE id::text IN ${lista(ids)}`))) codici.set(x.id, x.codice);
  }
  return r.map(x => {
    const tripId = String(x.trip_id), codice = codici.get(tripId) ?? null;
    return {
      tripId, routeId: x.route_id ?? null, linea: x.route_short_name ?? null, shapeId: x.shape_id ?? null,
      variante: x.variant_code ?? null, direzione: x.direction_id != null ? Number(x.direction_id) : null,
      aChiamata: !!x.on_demand, partenza: x.partenza ?? null, arrivo: x.arrivo ?? null,
      fermataDa: x.fermata_da ?? null, fermataA: x.fermata_a ?? null,
      codice, numero: codiceCorsaDi(codice ?? tripId),
    };
  });
}
