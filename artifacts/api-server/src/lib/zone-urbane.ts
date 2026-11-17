/**
 * Le zone tariffarie urbane (tappa 6.6): una zona a tariffa piatta per ogni
 * rete urbana dell'azienda (lib/reti-linee.ts), con dentro le fermate servite
 * dalle linee di quella rete.
 *
 * Prima questo codice stava in tre copie, una per ogni modo di generare le
 * zone, e tutte e tre mettevano le fermate di Senigallia, Castelfidardo e
 * Sassoferrato nella zona di Falconara. Qui ogni rete ha la sua zona, e le
 * fermate finite in una zona urbana che non è la loro si tolgono: le zone
 * urbane non si compilano a mano, sono sempre e solo ricavate dalle linee.
 */
import { db } from "@workspace/db";
import { gtfsFareAreas } from "@workspace/db/schema";
import { sql, type SQL } from "drizzle-orm";
import { nomeZonaUrbana, retiUrbane, type ReteUrbana } from "./reti-linee";

export interface ZoneUrbaneAssegnate {
  /** Quante zone urbane ci sono: una per rete dell'elenco. */
  zone: number;
  /** Le fermate di ogni zona dopo l'assegnazione, per area_id. */
  fermate: Record<string, number>;
  /** Le fermate messe adesso nella loro zona. */
  aggiunte: number;
  /** Le fermate tolte da una zona urbana che non era la loro. */
  tolte: number;
}

/** Le righe (rete, zona) dell'elenco, come VALUES con i valori passati per parametro. */
function retiEZone(reti: readonly ReteUrbana[]): SQL {
  return sql.join(reti.map((r) => sql`(${r.rete}::text, ${r.zona}::text)`), sql`, `);
}

/**
 * Crea le zone urbane del feed e ci mette le fermate servite dalle linee di
 * ogni rete (l'assegnazione linea → rete è quella della pagina Tariffe). Si
 * può rifare quante volte si vuole: una seconda volta non cambia niente.
 * Tutto in una transazione: o le zone tornano giuste, o restano com'erano.
 *
 * Con `soloSeCiSono` non crea niente in un feed che di zone urbane non ne ha:
 * rimette a posto quelle che trova. Serve alla generazione dai cluster, che
 * le zone urbane le tiene come sono e non le ha mai create.
 */
export async function assegnaZoneUrbane(feedId: string, opzioni: { soloSeCiSono?: boolean } = {}): Promise<ZoneUrbaneAssegnate> {
  /* le reti urbane dell'azienda, lette una volta: se cambiano a metà, la generazione resta coerente */
  const reti = retiUrbane();
  /* un'azienda senza reti urbane non ha zone urbane da fare */
  if (reti.length === 0) return { zone: 0, fermate: {}, aggiunte: 0, tolte: 0 };
  return db.transaction(async (tx) => {
    if (opzioni.soloSeCiSono) {
      const ciSono = await tx.execute(sql`
        SELECT 1 FROM (VALUES ${retiEZone(reti)}) AS r(rete, zona)
         WHERE EXISTS (SELECT 1 FROM gtfs_fare_areas a WHERE a.feed_id = ${feedId} AND a.area_id = r.zona)
            OR EXISTS (SELECT 1 FROM gtfs_stop_areas sa WHERE sa.feed_id = ${feedId} AND sa.area_id = r.zona)
         LIMIT 1
      `);
      if (ciSono.rows.length === 0) return { zone: 0, fermate: {}, aggiunte: 0, tolte: 0 };
    }

    await tx.insert(gtfsFareAreas)
      .values(reti.map((r) => ({ feedId, areaId: r.zona, areaName: nomeZonaUrbana(r), networkId: r.rete })))
      .onConflictDoUpdate({
        target: [gtfsFareAreas.feedId, gtfsFareAreas.areaId],
        set: { areaName: sql`excluded.area_name`, networkId: sql`excluded.network_id`, updatedAt: sql`now()` },
      });

    /* Una sola lettura delle fermate servite da ogni rete: con quella si tolgono
       le righe sbagliate e si aggiungono le mancanti. Le due parti non toccano
       mai la stessa riga: una è fuori dall'insieme, l'altra dentro. */
    const conti = await tx.execute<{ tolte: string; aggiunte: string }>(sql`
      WITH reti AS (SELECT * FROM (VALUES ${retiEZone(reti)}) AS v(rete, zona)),
      servite AS MATERIALIZED (
        SELECT DISTINCT r.zona, s.stop_id
          FROM reti r
          JOIN gtfs_route_networks rn ON rn.feed_id = ${feedId} AND rn.network_id = r.rete
          JOIN gtfs_trips t ON t.feed_id = rn.feed_id AND t.route_id = rn.route_id
          JOIN gtfs_stop_times st ON st.feed_id = t.feed_id AND st.trip_id = t.trip_id
          JOIN gtfs_stops s ON s.feed_id = st.feed_id AND s.stop_id = st.stop_id
      ),
      tolte AS (
        DELETE FROM gtfs_stop_areas sa
         USING reti r
         WHERE sa.feed_id = ${feedId} AND sa.area_id = r.zona
           AND NOT EXISTS (SELECT 1 FROM servite v WHERE v.zona = sa.area_id AND v.stop_id = sa.stop_id)
        RETURNING 1
      ),
      aggiunte AS (
        INSERT INTO gtfs_stop_areas (feed_id, area_id, stop_id)
        SELECT ${feedId}::uuid, v.zona, v.stop_id
          FROM servite v
         WHERE NOT EXISTS (
           SELECT 1 FROM gtfs_stop_areas x
            WHERE x.feed_id = ${feedId} AND x.area_id = v.zona AND x.stop_id = v.stop_id)
        ON CONFLICT DO NOTHING
        RETURNING 1
      )
      SELECT (SELECT count(*) FROM tolte) AS tolte, (SELECT count(*) FROM aggiunte) AS aggiunte
    `);

    const perZona = await tx.execute<{ area_id: string; n: string }>(sql`
      SELECT sa.area_id, count(*) AS n
        FROM gtfs_stop_areas sa
        JOIN (VALUES ${retiEZone(reti)}) AS r(rete, zona) ON r.zona = sa.area_id
       WHERE sa.feed_id = ${feedId}
       GROUP BY sa.area_id
    `);
    const fermate: Record<string, number> = Object.fromEntries(reti.map((r) => [r.zona, 0]));
    for (const riga of perZona.rows) fermate[riga.area_id] = Number(riga.n);

    return {
      zone: reti.length,
      fermate,
      aggiunte: Number(conti.rows[0]?.aggiunte ?? 0),
      tolte: Number(conti.rows[0]?.tolte ?? 0),
    };
  });
}
