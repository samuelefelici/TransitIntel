/**
 * ═══════════════════════════════════════════════════════════════════════════
 * IL RITARDO VERO DI OGNI CORSA, PER LA ROBUSTEZZA DEL GIRO
 * ───────────────────────────────────────────────────────────────────────────
 * Lo scheduler, con la robustezza accesa, chiede fra una corsa e la dopo un
 * margine in più: il ritardo atteso. Lo stimava dalla congestione media del
 * traffico (TomTom) su tutta la città, ora per ora: uguale per la 1/4 in
 * centro e per la 93 in collina. Qui viene dai transiti SIRI, col calcolo
 * unico delle percorrenze: per ogni corsa il ritardo all'85° percentile
 * all'arrivo, tratto per tratto all'ora in cui la corsa lo percorre, nei
 * giorni dello stesso tipo (feriali, sabati, festivi) delle ultime 13
 * settimane.
 *
 * Una corsa entra solo se i tratti osservati coprono almeno metà del suo
 * tempo: con meno, il ritardo sarebbe sottostimato, e il giro usa il
 * profilo orario di prima. Il ritardo si conta da 0 (una corsa in anticipo
 * non regala margine) a 15′ (il tetto del giro).
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { caricaCorse } from "./percorrenze-acquisizione-db";
import { leggiOsservato } from "./percorrenze-reali-db";
import { esitiCorse, giorniOsservati, tipoDelGiorno, type EsitoCorsa, type TipoGiorno } from "./percorrenze-reali";
import { giornataOggi } from "./service-day";

export const RITARDO_MAX_MIN = 15;
export const COPERTURA_MINIMA_RITARDO_PCT = 50;
const GIORNI = 91;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Dagli esiti delle corse, i ritardi da dare al giro (minuti interi). */
export function ritardiDagliEsiti(esiti: Pick<EsitoCorsa, "tripId" | "ritardoP85Min" | "coperturaPct">[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of esiti) {
    if (e.ritardoP85Min == null || e.coperturaPct < COPERTURA_MINIMA_RITARDO_PCT) continue;
    out[e.tripId] = Math.min(RITARDO_MAX_MIN, Math.max(0, Math.round(e.ritardoP85Min)));
  }
  return out;
}

export interface RitardiDelGiro {
  ritardi: Record<string, number>;
  corse: number;
  conDati: number;
  tipoGiorno: TipoGiorno;
  transiti: number;
}

/** Il feed d'esercizio attivo più recente: la sequenza delle fermate su cui si leggono i tratti SIRI. */
async function feedAttivo(): Promise<string | null> {
  try {
    const r = await db.execute<any>(sql`SELECT id::text FROM gtfs_feeds WHERE is_active = true ORDER BY uploaded_at DESC LIMIT 1`);
    return (r.rows?.[0]?.id as string | undefined) ?? null;
  } catch { return null; }
}

/** Il ritardo all'85° delle corse del giro (ids = corse di Planning Studio, come nel feed materializzato). */
export async function ritardiP85DelleCorse(
  psProjectId: string, tripIds: string[], data: string, feedId?: string | null,
): Promise<RitardiDelGiro> {
  const ymd = /^\d{8}$/.test(data) ? `${data.slice(0, 4)}-${data.slice(4, 6)}-${data.slice(6, 8)}` : data;
  const tipo = tipoDelGiorno(ymd);
  const ids = [...new Set(tripIds.filter(x => UUID_RE.test(x)))];
  if (!ids.length) return { ritardi: {}, corse: 0, conDati: 0, tipoGiorno: tipo, transiti: 0 };
  const routeIds = ((await db.execute<any>(sql`
    SELECT DISTINCT route_id::text AS r FROM ps_trips
     WHERE project_id = ${psProjectId}::uuid AND id = ANY(${`{${ids.join(",")}}`}::uuid[])`)).rows as any[]).map(x => String(x.r));
  const scelte = new Set(ids);
  const { corse } = await caricaCorse(psProjectId, routeIds, null);
  const mie = corse.filter(c => scelte.has(c.tripId));
  const coppie = new Map<string, { da: string; a: string }>();
  for (const c of mie) for (let i = 0; i + 1 < c.fermate.length; i++) {
    const da = c.fermate[i].gtfsId, a = c.fermate[i + 1].gtfsId;
    if (da && a) coppie.set(`${da}>${a}`, { da, a });
  }
  const lettura = await leggiOsservato([...coppie.values()], giorniOsservati(tipo, giornataOggi(), GIORNI),
    feedId !== undefined ? feedId : await feedAttivo());
  const ritardi = ritardiDagliEsiti(esitiCorse(mie, lettura.osservato));
  return { ritardi, corse: mie.length, conDati: Object.keys(ritardi).length, tipoGiorno: tipo, transiti: lettura.transiti };
}
