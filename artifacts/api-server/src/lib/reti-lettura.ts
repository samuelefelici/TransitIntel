/**
 * Le reti e le regole dell'azienda lette dal database (tabelle `reti` e
 * `reti_regole`, migrazione 0040). Sta a parte, piccolo, perché lo legge
 * lib/azienda.ts a ogni lettura dell'azienda, anche nel lavoratore: chi le
 * cambia sta in lib/reti.ts.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { impostaReti, TIPI_REGOLA, type RegolaLinea, type Rete, type RetiAzienda, type TipoRegola } from "./reti-linee";

/** Chi sa eseguire una query: il pool, oppure una transazione. */
type Esecutore = Pick<typeof db, "execute">;

const tipoRegola = (v: unknown): v is TipoRegola => typeof v === "string" && (TIPI_REGOLA as readonly string[]).includes(v);

function reteDa(r: any): Rete {
  return {
    rete: String(r.rete), tipo: r.tipo === "urbano" ? "urbano" : "extraurbano", nome: String(r.nome),
    luogo: r.luogo ?? null, sigla: r.sigla ?? null, zona: r.zona ?? null,
    codice: r.codice == null ? null : Number(r.codice), colore: String(r.colore), ordine: Number(r.ordine),
    corrispettivoKm: r.corrispettivo_km == null ? null : Number(r.corrispettivo_km), corrispettivoSuVuoti: r.corrispettivo_su_vuoti === true,
  };
}

/** Le reti (in ordine) e le regole (in ordine) come stanno nel database. */
export async function retiDalDatabase(ex: Esecutore = db): Promise<RetiAzienda> {
  const reti = await ex.execute<any>(sql`
    SELECT rete, tipo, nome, luogo, sigla, zona, codice, colore, ordine, corrispettivo_km, corrispettivo_su_vuoti FROM reti ORDER BY ordine, rete`);
  const regole = await ex.execute<any>(sql`SELECT tipo, valore, rete FROM reti_regole ORDER BY ordine`);
  return {
    reti: reti.rows.map(reteDa),
    regole: regole.rows.filter((g) => tipoRegola(g.tipo)).map((g): RegolaLinea => ({ tipo: g.tipo, valore: g.valore ?? null, rete: String(g.rete) })),
  };
}

/** Rilegge le reti dal database e le mette in vigore in questo processo. */
export async function rileggiReti(ex: Esecutore = db): Promise<RetiAzienda> {
  const lette = await retiDalDatabase(ex);
  impostaReti(lette);
  return lette;
}
