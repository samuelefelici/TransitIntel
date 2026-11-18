/**
 * Il traffico per zona (tappa 6.15, migrazione 0045).
 *
 * La zona è un attributo del punto stradale: i punti sono i luoghi del
 * territorio con l'uso «traffico» (lib/territorio.ts), e il nome di un punto è
 * l'identificativo delle sue rilevazioni (traffic_snapshots.segment_id).
 * Prima le zone erano cinque rettangoli di coordinate scritti nel codice.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

/** Il gruppo delle rilevazioni che non hanno una zona: di un punto senza zona, o di un punto che non c'è più. */
export const SENZA_ZONA = "Senza zona";

export interface TrafficoDellaZona {
  zone: string;
  /** il posto della zona nell'elenco dei punti (il più piccolo dei loro ordini): la pagina ci sceglie il colore; null per «Senza zona» */
  ordine: number | null;
  avgCongestion: number;
  avgSpeed: number;
  avgFreeflow: number;
  samples: number;
  /** di quanto la velocità è sotto quella a strada libera, in percento */
  speedReduction: number;
}

/**
 * Le rilevazioni degli ultimi 30 giorni per zona, dalla più congestionata.
 * Ogni rilevazione sta in una zona sola, e la somma delle zone è il totale.
 */
export async function trafficoPerZona(): Promise<TrafficoDellaZona[]> {
  const r = await db.execute<any>(sql`
    WITH rilevazioni AS (
      SELECT COALESCE(p.zona, ${SENZA_ZONA}) AS zone_name, p.zona IS NOT NULL AS con_zona, p.ordine,
             s.congestion_level, s.speed, s.freeflow_speed
        FROM traffic_snapshots s
        LEFT JOIN territorio_luoghi p ON p.uso = 'traffico' AND p.nome = s.segment_id
       WHERE s.captured_at > NOW() - INTERVAL '30 days'
    )
    SELECT
      zone_name,
      MIN(ordine) FILTER (WHERE con_zona) AS ordine,
      AVG(congestion_level) AS avg_congestion,
      AVG(speed) AS avg_speed,
      AVG(freeflow_speed) AS avg_freeflow,
      COUNT(*)::int AS samples
    FROM rilevazioni
    GROUP BY zone_name
    ORDER BY avg_congestion DESC, zone_name`);
  return (r.rows as any[]).map((z) => {
    const velocita = parseFloat(z.avg_speed), libera = parseFloat(z.avg_freeflow);
    return {
      zone: String(z.zone_name),
      ordine: z.ordine == null ? null : Number(z.ordine),
      avgCongestion: parseFloat(z.avg_congestion) || 0,
      avgSpeed: velocita || 0,
      avgFreeflow: libera || 0,
      samples: parseInt(z.samples) || 0,
      speedReduction: libera > 0 ? Math.round((1 - velocita / libera) * 100) : 0,
    };
  });
}
