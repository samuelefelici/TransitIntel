/**
 * Gli elenchi delle tariffe di un'azienda di prova: quelli di Conerobus, gli
 * stessi che la migrazione 0043 carica nella sua installazione (un test li
 * confronta riga per riga), presi dal codice com'era prima della tappa 6.10.
 * Con la riga di agency.txt che il GTFS delle tariffe scriveva.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import type { AgenziaGtfs, CategoriaCatalogo, NodoCatalogo, SupportoCatalogo } from "../../lib/elenchi-tariffe";

export const ELENCHI_DI_PRIMA: {
  categorie: CategoriaCatalogo[]; supporti: SupportoCatalogo[]; nodi: NodoCatalogo[]; agencyTxt: string;
} = JSON.parse(readFileSync(join(__dirname, "elenchi-di-prima.json"), "utf8"));

/** Il consorzio che pubblica i GTFS dell'azienda di prova. */
export const AGENZIA_DI_PROVA: AgenziaGtfs = {
  agencyId: "ATMA", nome: "Atma Scpa", sito: "https://www.atmaancona.it", telefono: "0712837468",
  email: "info@atmaancona.it", tariffeUrl: "https://www.atmaancona.it/tariffe/tariffe-generale/",
};

const TABELLE = ["categorie_catalogo", "supporti_catalogo", "nodi_catalogo", "agenzia_gtfs"] as const;

/** Mette gli elenchi di prova nel database al posto di quelli che ci sono; rende la funzione che rimette quelli di prima. */
export async function elenchiDiProvaNelDatabase(): Promise<() => Promise<void>> {
  const prima: Record<string, unknown[]> = {};
  for (const t of TABELLE) {
    prima[t] = (await db.execute<any>(sql`SELECT to_jsonb(x) AS riga FROM ${sql.identifier(t)} x`)).rows.map((r) => r.riga);
    await db.execute(sql`DELETE FROM ${sql.identifier(t)}`);
  }
  const e = ELENCHI_DI_PRIMA, a = AGENZIA_DI_PROVA;
  await db.execute(sql`
    INSERT INTO categorie_catalogo (categoria, nome, predefinita, url, ordine)
    SELECT v.categoria, v.nome, v.predefinita, v.url, (j.n * 10)::int
      FROM jsonb_array_elements(${JSON.stringify(e.categorie)}::jsonb) WITH ORDINALITY AS j(riga, n),
           jsonb_to_record(j.riga) AS v(categoria text, nome text, predefinita boolean, url text)`);
  await db.execute(sql`
    INSERT INTO supporti_catalogo (supporto, nome, tipo, ordine)
    SELECT v.supporto, v.nome, v.tipo, (j.n * 10)::int
      FROM jsonb_array_elements(${JSON.stringify(e.supporti)}::jsonb) WITH ORDINALITY AS j(riga, n),
           jsonb_to_record(j.riga) AS v(supporto text, nome text, tipo int)`);
  await db.execute(sql`
    INSERT INTO nodi_catalogo (codice, nome, lat, lon, alias, ordine)
    SELECT v.codice, v.nome, v.lat, v.lon, v.alias, (j.n * 10)::int
      FROM jsonb_array_elements(${JSON.stringify(e.nodi.map((n) => ({ ...n, alias: n.alias.join(";") })))}::jsonb) WITH ORDINALITY AS j(riga, n),
           jsonb_to_record(j.riga) AS v(codice text, nome text, lat float8, lon float8, alias text)`);
  await db.execute(sql`
    INSERT INTO agenzia_gtfs (agency_id, nome, sito, telefono, email, tariffe_url)
    VALUES (${a.agencyId}, ${a.nome}, ${a.sito}, ${a.telefono}, ${a.email}, ${a.tariffeUrl})`);
  return async () => {
    for (const t of TABELLE) {
      await db.execute(sql`DELETE FROM ${sql.identifier(t)}`);
      for (const riga of prima[t]!) {
        await db.execute(sql`INSERT INTO ${sql.identifier(t)} SELECT * FROM jsonb_populate_record(NULL::${sql.identifier(t)}, ${JSON.stringify(riga)}::jsonb)`);
      }
    }
  };
}
