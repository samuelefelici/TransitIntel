/**
 * Le assenze che liberano il turno e i sostituti suggeriti (tappa 5.1;
 * migrazione 0032).
 *
 * Un'assenza (non il riposo, «R») del conducente assegnato libera il turno:
 * il turno torna «da coprire», ma l'assegnazione resta, come titolare. Non si
 * scrive niente: lo si calcola dalle voci del roster, così se l'assenza si
 * toglie e nessuno ha coperto il turno il titolare torna.
 *
 * Il sostituto lo sceglie una persona. Qui solo il suggerimento: i conducenti
 * dello stesso deposito, attivi e in servizio quel giorno, non fittizi, senza
 * voci di assenza (riposo compreso), a cui il turno non creerebbe violazioni
 * di riposo o sovrapposizione (lib/roster-normativa.ts), in quest'ordine:
 *   1. liberi: nessun turno e nessuna disposizione quel giorno;
 *   2. a disposizione (D1, D2) e senza turni;
 *   3. già in servizio, ma compatibili.
 * Dentro ogni gruppo, per nome. Nessun punteggio sulle persone: l'ordine è
 * solo quello dei gruppi.
 */
import { sql } from "drizzle-orm";
import { righe, type Ex } from "./anagrafica-store";

/** Il riposo della rotazione non libera un turno: chi riposa non doveva averne. */
export const NON_LIBERA = new Set(["R"]);
/** Le presenze che dicono «a disposizione» (catalogo in lib/roster-voci.ts). */
export const DISPOSIZIONE = new Set(["D1", "D2"]);

export interface Voce { driverId: string; day: string; category: string; code: string }

/** Vero se la voce libera il turno del conducente quel giorno. */
export const liberaIlTurno = (v: Pick<Voce, "category" | "code">) => v.category === "assenza" && !NON_LIBERA.has(v.code);

/** I conducenti fra `ids` che quel giorno hanno un'assenza che libera il turno. */
export async function assentiNelGiorno(ex: Ex, ids: string[], giorno: string): Promise<Set<string>> {
  if (!ids.length) return new Set();
  return new Set(righe(await ex.execute(sql`
    SELECT DISTINCT driver_id::text AS id FROM roster_entries
     WHERE day = ${giorno}::date AND category = 'assenza' AND code <> ALL(${`{${[...NON_LIBERA].join(",")}}`}::text[])
       AND driver_id IN (${sql.join(ids.map(id => sql`${id}::uuid`), sql`, `)})`)).map(x => String(x.id)));
}

export type Gruppo = "libero" | "disposizione" | "in_servizio";
export const ORDINE: Gruppo[] = ["libero", "disposizione", "in_servizio"];

export interface Candidato { id: string; nome: string; matricola: string | null; deposito: string | null }
export interface Sostituto extends Candidato { gruppo: Gruppo; turni: string[] }

/**
 * I sostituti, dai candidati già filtrati per deposito, servizio e visibilità:
 * fuori chi ha un'assenza quel giorno (anche il riposo), chi è già il
 * conducente del turno, chi avrebbe una violazione. Restituisce anche quanti
 * sono rimasti fuori e perché.
 */
export function sostitutiDa(input: {
  candidati: Candidato[];
  esclusi: Set<string>;
  voci: Voce[];
  /** i turni del giorno di ciascun candidato (codici) */
  turni: Map<string, string[]>;
  /** le violazioni che il turno creerebbe a ciascun candidato */
  violazioni: Map<string, number>;
}): { sostituti: Sostituto[]; fuori: { assenti: number; violazioni: number } } {
  const assenti = new Set(input.voci.filter(v => v.category === "assenza").map(v => v.driverId));
  const aDisposizione = new Set(input.voci.filter(v => v.category === "presenza" && DISPOSIZIONE.has(v.code)).map(v => v.driverId));
  const fuori = { assenti: 0, violazioni: 0 };
  const sostituti: Sostituto[] = [];
  for (const c of input.candidati) {
    if (input.esclusi.has(c.id)) continue;
    if (assenti.has(c.id)) { fuori.assenti++; continue; }
    if ((input.violazioni.get(c.id) ?? 0) > 0) { fuori.violazioni++; continue; }
    const turni = input.turni.get(c.id) ?? [];
    const gruppo: Gruppo = turni.length ? "in_servizio" : aDisposizione.has(c.id) ? "disposizione" : "libero";
    sostituti.push({ ...c, gruppo, turni });
  }
  sostituti.sort((a, b) => ORDINE.indexOf(a.gruppo) - ORDINE.indexOf(b.gruppo) || a.nome.localeCompare(b.nome, "it"));
  return { sostituti, fuori };
}
