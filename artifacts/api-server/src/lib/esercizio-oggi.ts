/**
 * La giornata di esercizio in breve, per la pagina Oggi (tappa 4.9).
 *
 * La giornata intera (lib/esercizio-giornate.ts, leggiGiornata) porta tutte
 * le corse, circa 3.500 in un feriale: la home ne vuole solo i conteggi. Qui:
 *   - la giornata in corso: stato, corse programmate, esiti confermati,
 *     corse da decidere, aggiunte, e le corse che l'AVM ha visto fare
 *     (proposta «effettuata dall'AVM» o «parziale»: la proposta si aggiorna
 *     durante il giorno, la conferma resta di una persona);
 *   - le giornate cominciate e ancora aperte dopo tre giorni, «da chiudere»,
 *     con la stessa regola della pagina del consuntivo (nessun blocco
 *     automatico, solo il segnale).
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const righe = (r: any): any[] => r?.rows ?? r ?? [];
const n = (x: unknown) => Number(x ?? 0);

/** Quante giornate «da chiudere» si elencano per nome: oltre, solo il totale. */
export const DA_CHIUDERE_ELENCATE = 10;

export async function esercizioInBreve(giorno: string) {
  const g = righe(await db.execute(sql`
    SELECT stato, ricostruita, (proposta IS NOT NULL) AS con_proposta, chiusa_il
      FROM esercizio_giornate WHERE giorno = ${giorno}::date`))[0];
  let giornata = null;
  if (g) {
    const c = righe(await db.execute(sql`
      SELECT count(*) FILTER (WHERE origine = 'programmata') AS programmate,
             count(*) FILTER (WHERE origine = 'programmata' AND esito = 'effettuata') AS effettuate,
             count(*) FILTER (WHERE origine = 'programmata' AND esito = 'presunta') AS presunte,
             count(*) FILTER (WHERE origine = 'programmata' AND esito = 'parziale') AS parziali,
             count(*) FILTER (WHERE origine = 'programmata' AND esito = 'soppressa') AS soppresse,
             count(*) FILTER (WHERE origine = 'programmata' AND esito IS NULL) AS da_decidere,
             count(*) FILTER (WHERE origine = 'programmata' AND esito IS NULL AND proposta = 'da_verificare') AS da_verificare,
             count(*) FILTER (WHERE origine = 'programmata' AND proposta IN ('effettuata_avm', 'parziale')) AS viste_avm,
             count(*) FILTER (WHERE origine = 'aggiunta') AS aggiunte
        FROM esercizio_corse WHERE giorno = ${giorno}::date`))[0] ?? {};
    const programmate = n(c.programmate), visteAvm = n(c.viste_avm);
    giornata = {
      stato: String(g.stato) as "preparata" | "congelata" | "chiusa",
      ricostruita: !!g.ricostruita,
      chiusaIl: g.chiusa_il ? new Date(g.chiusa_il).toISOString() : null,
      programmate,
      effettuate: n(c.effettuate), presunte: n(c.presunte), parziali: n(c.parziali), soppresse: n(c.soppresse),
      daDecidere: n(c.da_decidere), daVerificare: n(c.da_verificare), aggiunte: n(c.aggiunte),
      /* null finché l'AVM non ha fatto una proposta: zero sarebbe un'altra notizia */
      visteAvm: g.con_proposta ? visteAvm : null,
      quotaVisteAvm: g.con_proposta && programmate > 0 ? Math.round((visteAvm / programmate) * 1000) / 10 : null,
    };
  }
  const aperte = righe(await db.execute(sql`
    SELECT giorno::text AS giorno, stato, count(*) OVER () AS totale
      FROM esercizio_giornate
     WHERE stato <> 'chiusa' AND giorno < ${giorno}::date - 3
     ORDER BY giorno
     LIMIT ${DA_CHIUDERE_ELENCATE}`));
  return {
    giorno,
    giornata,
    daChiudere: {
      totale: aperte.length ? n(aperte[0].totale) : 0,
      giorni: aperte.map((x) => ({ giorno: String(x.giorno).slice(0, 10), stato: String(x.stato) })),
    },
  };
}
