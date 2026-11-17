/**
 * I depositi di esempio per i test sul database. Dalla tappa 6.4 l'API non
 * ne inserisce più da sé: un test che ne ha bisogno li mette qui, e alla fine
 * toglie quelli che ha messo lui (quelli che c'erano già restano).
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { DEPOSITI_DI_PROVA } from "../../lib/anagrafica-prova";

/** Inserisce i depositi di esempio che mancano. Restituisce la funzione che toglie quelli appena inseriti. */
export async function depositiDiProva(): Promise<() => Promise<void>> {
  const messi: string[] = [];
  for (const d of DEPOSITI_DI_PROVA) {
    const r = await db.execute(sql`
      INSERT INTO roster_depositi (codice, nome, gruppo, cadenza_turni, alias, ordine)
      VALUES (${d.codice}, ${d.nome}, ${d.gruppo}, ${d.cadenzaTurni}, ${`{${d.alias.map(a => `"${a}"`).join(",")}}`}::text[], ${d.ordine})
      ON CONFLICT DO NOTHING RETURNING codice`);
    if (r.rows.length) messi.push(d.codice);
  }
  return async () => {
    if (messi.length === 0) return;
    await db.execute(sql`
      DELETE FROM roster_depositi d
       WHERE d.codice = ANY(${`{${messi.join(",")}}`}::text[])
         AND NOT EXISTS (SELECT 1 FROM roster_gruppi_turni g WHERE g.deposito_codice = d.codice)`);
  };
}
