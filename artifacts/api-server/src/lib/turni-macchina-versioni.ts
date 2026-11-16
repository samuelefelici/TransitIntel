/**
 * Il salvataggio dei turni macchina, con le versioni (PR 3.6, contratto C2).
 *
 * I turni guida si calcolano su un turni macchina (le loro vetture sono i
 * suoi blocchi) e il roster li assegna e li pubblica giorno per giorno. Se il
 * turni macchina si salvasse sopra il vecchio, i giorni già assegnati o
 * pubblicati si ritroverebbero con vetture diverse da quelle dei loro turni
 * guida. Quindi, come per i turni guida (PUT /driver-shifts/scenarios/:id):
 *
 *  - se il roster usa i suoi turni guida (assegnati o pubblicati, anche nel
 *    passato) e il risultato cambia, si salva una VERSIONE NUOVA: una riga
 *    nuova con version + 1, e la vecchia prende superseded_by. I turni guida
 *    restano sulla versione su cui sono stati calcolati; sulla nuova si
 *    calcolano i turni guida nuovi;
 *  - altrimenti si salva sopra, come prima;
 *  - una versione già superata non si modifica: si lavora sulla più recente
 *    (altrimenti le versioni si dividerebbero in due rami).
 *
 * Il controllo e la scrittura stanno nella stessa transazione, con la riga
 * bloccata (FOR UPDATE). La pubblicazione blocca in lettura (FOR SHARE) i
 * turni macchina dei turni guida che pubblica: chi salva aspetta che finisca,
 * poi vede i giorni pubblicati e crea la versione.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { usiNelRoster } from "./roster-pubblicazione-db";

export type EsitoSalvataggio =
  | { stato: 404 }
  /** con nonVersionare: il roster lo usa, e non si è salvato niente */
  | { stato: 409; motivo: "usato_nel_roster" | "versione_superata"; supersededBy?: string | null }
  | { stato: 200; id: string; versionedFrom?: string; version?: number };

export async function salvaTurniMacchina(
  id: string,
  o: {
    name?: string | null;
    input?: unknown;
    result: unknown;
    /** per i ritocchi automatici (le scoperte prese da un'altra UDP): mai una versione nuova */
    nonVersionare?: boolean;
  },
): Promise<EsitoSalvataggio> {
  const nuovo = JSON.stringify(o.result);
  return db.transaction(async (tx) => {
    const r = await tx.execute<any>(sql`
      SELECT id, superseded_by::text AS superato_da, (result = ${nuovo}::jsonb) AS uguale
        FROM service_program_scenarios WHERE id = ${id}::uuid FOR UPDATE`);
    const riga = r.rows?.[0];
    if (!riga) return { stato: 404 as const };
    if (!riga.uguale) {
      if (riga.superato_da) return { stato: 409 as const, motivo: "versione_superata" as const, supersededBy: riga.superato_da };
      const usi = await usiNelRoster({ spsId: id }, tx as any);
      if (usi.assegnazioni + usi.giorniPubblicati > 0) {
        if (o.nonVersionare) return { stato: 409 as const, motivo: "usato_nel_roster" as const };
        const ins = await tx.execute<any>(sql`
          INSERT INTO service_program_scenarios
            (name, date, feed_id, input, result, owner_user_id, project_id, is_shared, description,
             depot_id, depots, config, valid_from, valid_to, version)
          SELECT ${o.name ? o.name : sql`name`}, date, feed_id,
                 ${o.input !== undefined ? sql`${JSON.stringify(o.input)}::jsonb` : sql`input`},
                 ${nuovo}::jsonb, owner_user_id, project_id, is_shared, description,
                 depot_id, depots, config, valid_from, valid_to, COALESCE(version, 1) + 1
            FROM service_program_scenarios WHERE id = ${id}::uuid
          RETURNING id::text, version`);
        const v = ins.rows?.[0];
        /* chi lavorava sulla versione di prima lavora anche su questa */
        await tx.execute(sql`
          INSERT INTO vehicle_schedule_members (scenario_id, user_id, role, added_by, added_at)
          SELECT ${v.id}::uuid, user_id, role, added_by, added_at
            FROM vehicle_schedule_members WHERE scenario_id = ${id}::uuid`);
        await tx.execute(sql`UPDATE service_program_scenarios SET superseded_by = ${v.id}::uuid WHERE id = ${id}::uuid`);
        return { stato: 200 as const, id: String(v.id), versionedFrom: id, version: Number(v.version) };
      }
    }
    /* salvataggio nuovo = contenuto allineato ai dati correnti: via il segno «dati superati» */
    await tx.execute(sql`
      UPDATE service_program_scenarios
         SET result = ${nuovo}::jsonb,
             ${o.name ? sql`name = ${o.name},` : sql``}
             ${o.input !== undefined ? sql`input = ${JSON.stringify(o.input)}::jsonb,` : sql``}
             stale_since = NULL
       WHERE id = ${id}::uuid`);
    return { stato: 200 as const, id };
  });
}
