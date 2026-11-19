/**
 * Le reti e le regole di un'azienda di prova: quelle di Conerobus, le stesse
 * che la migrazione 0040 carica nella sua installazione (un test le confronta
 * riga per riga), coi corrispettivi €/km della migrazione 0054 (DGR Marche
 * 456/2026), incassati anche sui km a vuoto. Chi prova la classificazione delle linee le mette in vigore
 * con `conLeRetiDiProva()`; senza, vale l'elenco neutro: il solo extraurbano.
 */
import { impostaReti, RETI_NEUTRE, type RegolaLinea, type Rete, type RetiAzienda } from "../../lib/reti-linee";

const urbana = (luogo: string, sigla: string, codice: number, colore: string, corrispettivoKm: number): Rete => {
  const chiave = luogo.toLowerCase();
  return {
    rete: `urbano_${chiave}`, tipo: "urbano", nome: `Urbano di ${luogo}`, luogo, sigla,
    zona: `${chiave}_urban`, codice, colore, ordine: codice - 1, corrispettivoKm, corrispettivoSuVuoti: true,
  };
};

export const RETI_DI_PROVA: RetiAzienda = {
  reti: [
    urbana("Ancona", "AN", 2, "#3b82f6", 2.6),
    urbana("Jesi", "JE", 3, "#8b5cf6", 1.76),
    urbana("Falconara", "FA", 4, "#06b6d4", 1.92),
    urbana("Senigallia", "SE", 5, "#10b981", 1.84),
    urbana("Castelfidardo", "CF", 6, "#f97316", 1.68),
    urbana("Sassoferrato", "SS", 7, "#ec4899", 2.79),
    { rete: "extraurbano", tipo: "extraurbano", nome: "Extraurbano Provincia di Ancona", luogo: null, sigla: null, zona: null, codice: null, colore: "#f59e0b", ordine: 7,
      corrispettivoKm: 1.66, corrispettivoSuVuoti: true },
  ],
  regole: [
    { tipo: "inizia", valore: "JE", rete: "urbano_jesi" },
    { tipo: "inizia", valore: "Y", rete: "urbano_falconara" },
    { tipo: "inizia_poi_cifra", valore: "BUS", rete: "urbano_senigallia" },
    { tipo: "inizia_poi_cifra", valore: "BUSS", rete: "urbano_senigallia" },
    { tipo: "uguale", valore: "CIRCA", rete: "urbano_castelfidardo" },
    { tipo: "uguale", valore: "CIRCB", rete: "urbano_castelfidardo" },
    { tipo: "inizia_con_cifra", valore: null, rete: "urbano_ancona" },
    { tipo: "lettere_puntate", valore: null, rete: "urbano_ancona" },
  ] satisfies RegolaLinea[],
};

/**
 * Mette le reti di prova nel database (tabella `reti`, senza le regole) e in
 * vigore in questo processo; rende la funzione che rimette le reti di prima.
 * Serve a chi prova qualcosa che punta alle reti con una chiave esterna.
 */
export async function retiDiProvaNelDatabase(): Promise<() => Promise<void>> {
  const { db } = await import("@workspace/db");
  const { sql } = await import("drizzle-orm");
  const diPrima = (await db.execute<any>(sql`SELECT to_jsonb(r) AS riga FROM reti r`)).rows.map((r) => r.riga);
  const regoleDiPrima = (await db.execute<any>(sql`SELECT to_jsonb(g) AS riga FROM reti_regole g`)).rows.map((r) => r.riga);
  await db.execute(sql`DELETE FROM reti_regole`);
  await db.execute(sql`DELETE FROM reti`);
  for (const r of RETI_DI_PROVA.reti) {
    await db.execute(sql`INSERT INTO reti (rete, tipo, nome, luogo, sigla, zona, codice, colore, ordine, corrispettivo_km, corrispettivo_su_vuoti)
                         VALUES (${r.rete}, ${r.tipo}, ${r.nome}, ${r.luogo}, ${r.sigla}, ${r.zona}, ${r.codice}, ${r.colore}, ${r.ordine},
                                 ${r.corrispettivoKm}, ${r.corrispettivoSuVuoti})`);
  }
  impostaReti(RETI_DI_PROVA);
  return async () => {
    await db.execute(sql`DELETE FROM reti_regole`);
    await db.execute(sql`DELETE FROM reti`);
    for (const riga of diPrima) await db.execute(sql`INSERT INTO reti SELECT * FROM jsonb_populate_record(NULL::reti, ${JSON.stringify(riga)}::jsonb)`);
    for (const riga of regoleDiPrima) await db.execute(sql`INSERT INTO reti_regole SELECT * FROM jsonb_populate_record(NULL::reti_regole, ${JSON.stringify(riga)}::jsonb)`);
    impostaReti(RETI_NEUTRE);
  };
}

/** Mette in vigore le reti di prova in questo processo. */
export function conLeRetiDiProva(): void { impostaReti(RETI_DI_PROVA); }

/** Rimette l'elenco neutro: il solo extraurbano, nessuna regola. */
export function senzaReti(): void { impostaReti(RETI_NEUTRE); }
