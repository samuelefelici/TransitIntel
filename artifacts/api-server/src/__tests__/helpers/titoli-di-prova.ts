/**
 * Il catalogo dei titoli di un'azienda di prova: quello di Conerobus, lo
 * stesso che la migrazione 0042 carica nella sua installazione (un test lo
 * confronta riga per riga). E, accanto, quello che i due pulsanti della pagina
 * Tariffe scrivevano in un feed vuoto prima della tappa 6.9, quando i titoli
 * erano elenchi nel codice: serve a provare che il risultato è lo stesso.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import type { TitoloCatalogo, TitoloNelFeed } from "../../lib/titoli-catalogo";

const leggi = (nome: string) => JSON.parse(readFileSync(join(__dirname, nome), "utf8"));

export const TITOLI_DI_PROVA: TitoloCatalogo[] = leggi("titoli-di-prova.json");

/** Quello che scrivevano prima «seed» (base) e «seed-abbonamenti», ognuno su un feed vuoto con le 23 fasce di prova. */
export const TITOLI_DI_PRIMA: { base: TitoloNelFeed[]; abbonamenti: TitoloNelFeed[] } = leggi("titoli-di-prima.json");

/** Mette il catalogo di prova nel database (le sue reti ci devono già essere); rende la funzione che lo toglie. */
export async function catalogoDiProvaNelDatabase(): Promise<() => Promise<void>> {
  await db.execute(sql`DELETE FROM titoli_catalogo`);
  await db.execute(sql`
    INSERT INTO titoli_catalogo (titolo, nome, rete, tipo, categoria, prezzo, durata_minuti, fascia, di_riferimento, ordine)
    SELECT v.titolo, v.nome, v.rete, v.tipo, v.categoria, v.prezzo, v."durataMinuti", v.fascia, v."diRiferimento", v.ordine
      FROM jsonb_to_recordset(${JSON.stringify(TITOLI_DI_PROVA)}::jsonb)
           AS v(titolo text, nome text, rete text, tipo text, categoria text, prezzo numeric, "durataMinuti" int, fascia int, "diRiferimento" boolean, ordine int)`);
  return async () => { await db.execute(sql`DELETE FROM titoli_catalogo`); };
}
