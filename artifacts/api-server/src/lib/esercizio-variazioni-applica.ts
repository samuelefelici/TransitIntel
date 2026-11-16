/**
 * Le variazioni decise in anticipo, applicate alla giornata cominciata
 * (tappa 4.10; lib/esercizio-variazioni.ts).
 *
 * Le chiama il lavoratore a ogni giro, dopo il congelamento, e l'API quando
 * una variazione si scrive per una giornata già cominciata.
 *
 *   soppressione  le corse toccate e ancora da decidere diventano «soppressa»
 *                 con la causale, con un evento del giornale a nome di chi
 *                 ha scritto la variazione (e il suo numero nei dati). Una
 *                 corsa già decisa da qualcuno non si tocca. La variazione si
 *                 segna applicata nella stessa transazione dell'evento: due
 *                 giri insieme non la applicano due volte;
 *   sciopero      non scrive esiti: si segna applicata, con le corse fuori
 *                 fascia. Proposta e presunzione lo leggono da sé.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { registraEvento, RifiutoGiornale } from "./esercizio-giornale";
import { corsePerVariazioni, toccata, type RegolaVariazione } from "./esercizio-variazioni";

const righe = (r: any): any[] => r?.rows ?? r ?? [];

/** Già applicata o annullata da un altro, nel frattempo: non è un errore. */
class GiaFatta extends Error {}

export interface EsitoApplicazione { id: number; tipo: string; corse: number | null; errore?: string }

/** Applica le variazioni in attesa di una giornata congelata. Senza giornata congelata non fa niente. */
export async function applicaVariazioni(giorno: string): Promise<EsitoApplicazione[]> {
  const g = righe(await db.execute(sql`SELECT stato FROM esercizio_giornate WHERE giorno = ${giorno}::date`))[0];
  if (!g || g.stato !== "congelata") return [];
  const attesa = righe(await db.execute(sql`
    SELECT id, tipo, linee, numeri, dalle, alle, fasce, causale, nota, creata_da::text AS creata_da
      FROM esercizio_variazioni
     WHERE giorno = ${giorno}::date AND applicata_il IS NULL AND annullata_il IS NULL
     ORDER BY id`));
  const fatte: EsitoApplicazione[] = [];
  for (const v of attesa) {
    const regola: RegolaVariazione = {
      tipo: v.tipo, linee: v.linee ?? [], numeri: v.numeri ?? [], dalle: v.dalle ?? null, alle: v.alle ?? null,
      fasce: Array.isArray(v.fasce) ? v.fasce : null,
    };
    const segna = async (ex: any, corse: number, evento: number | null) => {
      const r = righe(await ex.execute(sql`
        UPDATE esercizio_variazioni SET applicata_il = now(), corse = ${corse}, evento = ${evento}::bigint
         WHERE id = ${v.id} AND applicata_il IS NULL AND annullata_il IS NULL RETURNING id`));
      if (!r.length) throw new GiaFatta();
    };
    try {
      if (v.tipo === "sciopero") {
        const n = (await corsePerVariazioni(db, giorno)).filter((c) => toccata(regola, c)).length;
        await db.transaction(async (tx) => segna(tx, n, null));
        fatte.push({ id: Number(v.id), tipo: v.tipo, corse: n });
        continue;
      }
      /* due tentativi: se nel frattempo qualcuno ha scritto nel giornale, la versione è cambiata */
      for (let tentativo = 1; ; tentativo++) {
        const chiavi = (await corsePerVariazioni(db, giorno, true)).filter((c) => toccata(regola, c)).map((c) => c.chiave);
        if (!chiavi.length) {
          await db.transaction(async (tx) => segna(tx, 0, null));
          fatte.push({ id: Number(v.id), tipo: v.tipo, corse: 0 });
          break;
        }
        const versione = Number(righe(await db.execute(sql`SELECT versione FROM esercizio_giornate WHERE giorno = ${giorno}::date`))[0]?.versione ?? 0);
        try {
          await registraEvento(giorno, {
            tipo: "esito", versione, fonte: "movimento", chiavi, esito: "soppressa", causale: v.causale,
            nota: v.nota ?? `Soppressione decisa in anticipo (variazione ${v.id})`,
          }, { id: v.creata_da ?? null }, { dati: { variazione: Number(v.id) }, dentro: (ex, evento) => segna(ex, chiavi.length, evento) });
          fatte.push({ id: Number(v.id), tipo: v.tipo, corse: chiavi.length });
          break;
        } catch (e) {
          if (e instanceof RifiutoGiornale && e.status === 409 && tentativo < 2) continue;
          throw e;
        }
      }
    } catch (e: any) {
      if (e instanceof GiaFatta) continue;
      /* una variazione che non si applica (per esempio la causale nel frattempo disattivata) resta in attesa e lo dice */
      fatte.push({ id: Number(v.id), tipo: v.tipo, corse: null, errore: e?.message ?? "non applicata" });
    }
  }
  return fatte;
}

/** Le giornate congelate con variazioni in attesa: le guarda il lavoratore a ogni giro. */
export async function giornateConVariazioni(): Promise<string[]> {
  return righe(await db.execute(sql`
    SELECT DISTINCT v.giorno::text AS giorno
      FROM esercizio_variazioni v JOIN esercizio_giornate g ON g.giorno = v.giorno AND g.stato = 'congelata'
     WHERE v.applicata_il IS NULL AND v.annullata_il IS NULL
     ORDER BY 1`)).map((x) => String(x.giorno).slice(0, 10));
}
