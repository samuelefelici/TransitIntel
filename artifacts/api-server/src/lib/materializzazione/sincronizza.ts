/**
 * La sincronizzazione di un progetto di scheduling col suo progetto Planning
 * Studio: il feed nuovo (solo le corse dell'UDP, se il progetto ne ha una), il
 * puntatore del progetto, il feed vecchio, gli scenari superati. Senza Express
 * e senza DDL: la eseguono il lavoratore (lavoro materializza_feed) e, con
 * LAVORI_FEED_IN_CODA=0, l'API.
 *
 * L'ordine conta: prima si costruisce il feed nuovo, poi si sposta il puntatore
 * di scheduling_projects, solo alla fine si cancella il feed vecchio. Prima la
 * cancellazione veniva prima del puntatore: un processo morto in mezzo lasciava
 * il progetto agganciato a un feed che non c'era più. Si cancella solo un feed
 * sintetico di Planning Studio non in uso (mai un GTFS caricato a mano che un
 * PATCH ha agganciato al progetto); se la cancellazione non riesce (per esempio
 * uno scenario di pianificazione lo tiene), il feed resta e la sincronizzazione
 * è comunque riuscita.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { materializePsToFeed, type MaterializeResult } from "./feed";

type Log = { info?: (...a: any[]) => void; warn?: (...a: any[]) => void; error?: (...a: any[]) => void };

export interface OpzioniSincronizzazione {
  log?: Log;
  segnale?: AbortSignal;
  /** il passo in corso, per l'avanzamento */
  passo?: (fase: string, percentuale: number) => void;
}

/** Le corse dell'UDP del progetto (intersecate con quelle che esistono ancora), o null per tutto il progetto. */
async function corseDellUdp(schedulingProjectId: string, log?: Log): Promise<string[] | null> {
  try {
    const vuR: any = await db.execute(sql`SELECT validity_unit_id FROM scheduling_projects WHERE id = ${schedulingProjectId}::uuid LIMIT 1`);
    const vuId = vuR.rows?.[0]?.validity_unit_id;
    if (!vuId) return null;
    const tR: any = await db.execute(sql`SELECT trip_ids FROM ps_validity_units WHERE id = ${vuId}::uuid LIMIT 1`);
    const arr = tR.rows?.[0]?.trip_ids;
    if (!Array.isArray(arr) || arr.length === 0) return null;
    // Interseca con le corse ESISTENTI: trip_ids stantii (corse rigenerate in
    // PS) produrrebbero un feed scopato VUOTO.
    const raw = arr.map((x: any) => String(x));
    const exR: any = await db.execute(sql`
      SELECT id::text AS id FROM ps_trips WHERE id = ANY(${`{${raw.join(",")}}`}::uuid[])`);
    const esistenti = ((exR.rows ?? []) as any[]).map((r) => String(r.id));
    if (esistenti.length < raw.length) {
      log?.warn?.({ projectId: schedulingProjectId, vuId, requested: raw.length, existing: esistenti.length },
        "UDP trip_ids parzialmente stantii: scoping sulle corse ancora esistenti");
    }
    return esistenti.length > 0 ? esistenti : null;
  } catch (err: any) {
    log?.warn?.({ err, projectId: schedulingProjectId }, "UDP scope lookup failed, materializzo tutto il progetto");
    return null;
  }
}

export async function sincronizzaProgetto(
  schedulingProjectId: string,
  psProjectId: string,
  utenteId: string,
  o: OpzioniSincronizzazione = {},
): Promise<MaterializeResult> {
  const { log } = o;
  o.passo?.("udp", 5);
  const tripIds = await corseDellUdp(schedulingProjectId, log);
  const vecchio: string | null = (await db.execute<any>(sql`
    SELECT feed_id FROM scheduling_projects WHERE id = ${schedulingProjectId}::uuid LIMIT 1`)).rows?.[0]?.feed_id ?? null;

  o.passo?.("feed", 15);
  // il feed vecchio NON lo cancella il materializzatore: prima va spostato il puntatore
  const result = await materializePsToFeed(psProjectId, utenteId, {
    tripIds, replaceFeedId: null, updateProjectPointer: false, segnale: o.segnale,
  });

  o.passo?.("aggancio", 85);
  await db.execute(sql`
    UPDATE scheduling_projects
       SET feed_id = ${result.feedId}::uuid,
           feed_label = ${result.label},
           updated_at = now()
     WHERE id = ${schedulingProjectId}::uuid
  `);

  if (vecchio && vecchio !== result.feedId) {
    try {
      await db.execute(sql`
        DELETE FROM gtfs_feeds
         WHERE id = ${vecchio}::uuid AND filename LIKE 'ps-%.synthetic'
           AND NOT is_active AND NOT is_default AND archived_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM scheduling_projects WHERE feed_id = ${vecchio}::uuid)
           AND NOT EXISTS (SELECT 1 FROM ps_projects WHERE materialized_feed_id = ${vecchio}::uuid)`);
    } catch (err: any) {
      log?.warn?.({ err: err?.message, feedId: vecchio, projectId: schedulingProjectId },
        "feed vecchio non cancellato (in uso): resta, la sincronizzazione è riuscita");
    }
  }

  // Il feed è cambiato sotto gli scenari salvati: il loro result riflette il
  // feed precedente → marcali "dati superati" (stale_since). Un nuovo
  // salvataggio dello scenario azzera il flag. Best-effort.
  o.passo?.("scenari", 95);
  try {
    await db.execute(sql`
      UPDATE service_program_scenarios
         SET stale_since = COALESCE(stale_since, now())
       WHERE project_id = ${schedulingProjectId}::uuid
    `);
    await db.execute(sql`
      UPDATE driver_shift_scenarios d
         SET stale_since = COALESCE(d.stale_since, now())
        FROM service_program_scenarios s
       WHERE d.service_program_scenario_id = s.id
         AND (s.project_id = ${schedulingProjectId}::uuid OR d.project_id = ${schedulingProjectId}::uuid)
    `);
  } catch (staleErr: any) {
    log?.warn?.({ err: staleErr?.message, projectId: schedulingProjectId }, "marcatura stale_since scenari fallita (sync comunque ok)");
  }
  return result;
}
