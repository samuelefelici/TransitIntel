/**
 * I gestori di un'installazione di prova (tappa 6.11). Quello di prima: il
 * consorzio che la migrazione 0043 scrive come agenzia unica di Conerobus e
 * che la 0044 fa diventare il primo gestore. E tre consorziati, per provare
 * più agenzie nello stesso GTFS.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import type { Gestore } from "../../lib/gestori";

/** L'agenzia unica di prima, come gestore predefinito. */
export const GESTORE_DI_PRIMA: Gestore = {
  gestore: "ATMA", nome: "Atma Scpa", sito: "https://www.atmaancona.it", telefono: "0712837468",
  email: "info@atmaancona.it", tariffeUrl: "https://www.atmaancona.it/tariffe/tariffe-generale/", predefinito: true,
};

/** Tre consorziati di prova: il primo è il predefinito. */
export const CONSORZIATI: Gestore[] = [
  { gestore: "UNO", nome: "Autolinee Uno S.p.A.", sito: "https://uno.example", telefono: "071 000001", email: "info@uno.example", tariffeUrl: null, predefinito: true },
  { gestore: "DUE", nome: "Due, Bus & Co.", sito: "https://due.example", telefono: null, email: null, tariffeUrl: "https://due.example/tariffe", predefinito: false },
  { gestore: "TRE", nome: "Tre Trasporti", sito: "https://tre.example", telefono: null, email: null, tariffeUrl: null, predefinito: false },
];

/** Mette questi gestori nel database al posto di quelli che ci sono; rende la funzione che rimette quelli di prima. */
export async function gestoriDiProvaNelDatabase(gestori: readonly Gestore[]): Promise<() => Promise<void>> {
  const prima = (await db.execute<any>(sql`SELECT to_jsonb(g) AS riga FROM gestori g`)).rows.map((r) => r.riga);
  const metti = async (lista: readonly Gestore[]) => {
    await db.execute(sql`DELETE FROM gestori`);
    for (const [i, g] of lista.entries()) {
      await db.execute(sql`
        INSERT INTO gestori (gestore, nome, sito, telefono, email, tariffe_url, predefinito, ordine)
        VALUES (${g.gestore}, ${g.nome}, ${g.sito}, ${g.telefono}, ${g.email}, ${g.tariffeUrl}, ${g.predefinito}, ${(i + 1) * 10})`);
    }
  };
  await metti(gestori);
  return async () => {
    await db.execute(sql`DELETE FROM gestori`);
    for (const riga of prima) {
      await db.execute(sql`INSERT INTO gestori SELECT * FROM jsonb_populate_record(NULL::gestori, ${JSON.stringify(riga)}::jsonb)`);
    }
  };
}
