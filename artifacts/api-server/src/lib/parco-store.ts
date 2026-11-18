/**
 * Il parco dell'azienda nel canale dell'AVM, per l'amministratore (tappa
 * 6.21, migrazione 0049): l'anagrafica dei mezzi importata dall'export
 * dell'officina, i prefissi SIRI delle consorziate e le eccezioni.
 *
 * Le regole che li usano sono in lib/parco-anagrafica.ts e stanno in memoria;
 * dopo ogni scrittura si rileggono (lib/azienda.ts), così il diario, lo stato
 * del parco e il report vedono subito i dati nuovi.
 */
import { z } from "zod";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { dimenticaAzienda, leggiAzienda } from "./azienda";
import { spezzaCsv } from "./stop-aliases";
import type { PrefissoConsorziata, EccezioneSiri } from "./parco-anagrafica";

/** Le forme ammesse, le stesse dei vincoli delle tabelle. */
export const CODICE_MEZZO = /^[A-Z0-9_.-]{1,20}$/;
export const MASSIMO_VETTURE = 20_000;
const SIGLA = /^[A-Z]{1,5}$/;

/* ── L'anagrafica: l'export dell'officina ─────────────────────────────────── */

export interface LetturaExport {
  vetture: Array<{ codice: string; descrizione: string }>;
  doppie: number;
  errori: string[];
}

/**
 * L'export dell'officina, una vettura per riga: codice e descrizione separati
 * da una tabulazione (copiato da un foglio di calcolo), da un punto e virgola
 * o da una virgola (un CSV, anche con le virgolette). L'intestazione si
 * riconosce e si salta. Pura: si collauda senza database.
 */
export function leggiExportParco(testo: string): LetturaExport {
  const vetture: LetturaExport["vetture"] = [];
  const errori: string[] = [];
  const visti = new Set<string>();
  let doppie = 0;
  const linee = testo.replace(/^﻿/, "").split(/\r?\n/);
  for (let n = 0; n < linee.length; n++) {
    const linea = linee[n]!;
    if (!linea.trim()) continue;
    const sep = linea.includes("\t") ? "\t" : linea.includes(";") ? ";" : ",";
    const campi = sep === "\t" ? linea.split("\t") : sep === ";" ? linea.split(";") : spezzaCsv(linea);
    const grezzo = (campi[0] ?? "").replace(/^"|"$/g, "").trim();
    /* le colonne in più restano nella descrizione, come prima; le virgole di una descrizione non tra virgolette pure */
    const descrizione = campi.slice(1).join(sep === "\t" ? " " : sep === ";" ? "; " : ", ").replace(/^"|"$/g, "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
    /* l'intestazione: «Codice veicolo  Descrizione veicolo» o simili */
    if (n === 0 || !vetture.length) { if (/codice|veicolo|matricola/i.test(grezzo) && !/\d/.test(grezzo)) continue; }
    const codice = grezzo.toUpperCase();
    if (!codice) continue;
    if (!CODICE_MEZZO.test(codice)) {
      if (errori.length < 5) errori.push(`riga ${n + 1}: il codice «${grezzo.slice(0, 30)}» non va (lettere, cifre e . _ -, al più 20)`);
      else if (errori.length === 5) errori.push("…e altre");
      continue;
    }
    if (!descrizione) {
      if (errori.length < 5) errori.push(`riga ${n + 1}: il mezzo ${codice} non ha una descrizione`);
      else if (errori.length === 5) errori.push("…e altre");
      continue;
    }
    if (visti.has(codice)) { doppie++; continue; }
    visti.add(codice);
    vetture.push({ codice, descrizione: descrizione.slice(0, 200) });
    if (vetture.length > MASSIMO_VETTURE) {
      errori.splice(0, errori.length, `più di ${MASSIMO_VETTURE.toLocaleString("it-IT")} righe: non sembra l'export del parco`);
      break;
    }
  }
  if (!vetture.length && !errori.length) errori.push("il file non ha nessuna vettura (codice e descrizione)");
  return { vetture, doppie, errori };
}

/** Sostituisce l'anagrafica, tutta insieme: o tutte le righe o nessuna. */
export async function importaAnagrafica(vetture: LetturaExport["vetture"], utenteId: string | null): Promise<number> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`DELETE FROM parco_vetture`);
    for (let i = 0; i < vetture.length; i += 500) {
      const pezzo = vetture.slice(i, i + 500);
      await tx.execute(sql`
        INSERT INTO parco_vetture (codice, descrizione, ordine, importata_da)
        VALUES ${sql.join(pezzo.map((v, k) => sql`(${v.codice}, ${v.descrizione}, ${i + k + 1}, ${utenteId}::uuid)`), sql`, `)}`);
    }
  });
  await rileggi();
  return vetture.length;
}

/** L'anagrafica com'è, per scaricarla nello stesso formato dell'import (codice, tabulazione, descrizione). */
export async function esportaAnagrafica(): Promise<string> {
  const r = await db.execute<any>(sql`SELECT codice, descrizione FROM parco_vetture ORDER BY ordine, codice`);
  return ["Codice veicolo\tDescrizione veicolo", ...((r as any).rows ?? []).map((x: any) => `${x.codice}\t${x.descrizione}`)].join("\r\n") + "\r\n";
}

/* ── Prefissi ed eccezioni ────────────────────────────────────────────────── */

const testo = (max: number) => z.string().transform((s) => s.trim()).pipe(z.string().max(max, `al più ${max} caratteri`)
  .regex(/^[^\u0000-\u001f\u007f]*$/, "senza caratteri di controllo"));

export const DatiConsorziate = z.object({
  consorziate: z.array(z.object({
    prefisso: z.string().trim().regex(/^[0-9]{2}$/, "due cifre, come «11»"),
    sigle: z.array(z.string().trim().transform((s) => s.toUpperCase()).pipe(z.string().regex(SIGLA, "da 1 a 5 lettere, come «CJ»")))
      .min(1, "almeno una sigla").max(5, "al più 5 sigle"),
    aProgressivo: z.boolean(),
  }).strict()).max(99, "al più 99 prefissi"),
  eccezioni: z.array(z.object({
    siriRef: z.string().trim().regex(/^[0-9]{1,10}$/, "la matricola SIRI: solo cifre, al più 10"),
    codice: z.string().trim().transform((s) => s.toUpperCase()).pipe(z.string().regex(CODICE_MEZZO, "il codice del mezzo: lettere, cifre e . _ -")),
    nota: testo(300).default(""),
  }).strict()).max(1000, "al più 1000 eccezioni"),
}).strict().superRefine((d, ctx) => {
  const prefissi = new Set<string>();
  const sigle = new Map<string, string>();
  d.consorziate.forEach((c, i) => {
    if (prefissi.has(c.prefisso)) ctx.addIssue({ code: "custom", path: ["consorziate", i, "prefisso"], message: `il prefisso ${c.prefisso} c'è due volte` });
    prefissi.add(c.prefisso);
    for (const s of c.sigle) {
      /* una sigla porta a un solo prefisso: altrimenti dal codice non si torna alla matricola */
      if (sigle.has(s) && sigle.get(s) !== c.prefisso) ctx.addIssue({ code: "custom", path: ["consorziate", i, "sigle"], message: `la sigla ${s} è già del prefisso ${sigle.get(s)}` });
      sigle.set(s, c.prefisso);
    }
  });
  const matricole = new Set<string>();
  d.eccezioni.forEach((e, i) => {
    if (matricole.has(e.siriRef)) ctx.addIssue({ code: "custom", path: ["eccezioni", i, "siriRef"], message: `la matricola ${e.siriRef} c'è due volte` });
    matricole.add(e.siriRef);
  });
});
export type DatiConsorziate = z.infer<typeof DatiConsorziate>;

/** I messaggi di una validazione fallita, con la riga e il campo come si leggono nella pagina. */
export function erroriConsorziate(e: z.ZodError): string {
  const estranei = e.issues.filter((i) => i.code === "unrecognized_keys");
  if (estranei.length) return "Campo non previsto nella richiesta";
  const NOMI: Record<string, string> = { prefisso: "prefisso", sigle: "sigle", aProgressivo: "progressivo", siriRef: "matricola", codice: "codice", nota: "nota" };
  return e.issues.slice(0, 5).map((i) => {
    const [lista, riga, campo] = i.path;
    const dove = lista === "consorziate" ? "Prefissi" : lista === "eccezioni" ? "Eccezioni" : "Richiesta";
    return typeof riga === "number" ? `${dove}, riga ${riga + 1}${campo ? ` (${NOMI[String(campo)] ?? String(campo)})` : ""}: ${i.message}` : `${dove}: ${i.message}`;
  }).join("; ");
}

/** Sostituisce prefissi ed eccezioni, insieme: sono una regola sola. */
export async function salvaConsorziate(d: DatiConsorziate): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`DELETE FROM parco_consorziate`);
    await tx.execute(sql`DELETE FROM parco_eccezioni`);
    for (const [i, c] of d.consorziate.entries()) {
      await tx.execute(sql`
        INSERT INTO parco_consorziate (prefisso, sigle, a_progressivo, ordine)
        VALUES (${c.prefisso}, ${arrayDiSigle(c.sigle)}::text[], ${c.aProgressivo}, ${i + 1})`);
    }
    for (const e of d.eccezioni) {
      await tx.execute(sql`INSERT INTO parco_eccezioni (siri_ref, codice, nota) VALUES (${e.siriRef}, ${e.codice}, ${e.nota})`);
    }
  });
  await rileggi();
}

/** Un array Postgres come testo: drizzle spezza un array JS in parametri separati. Le sigle sono già solo lettere. */
const arrayDiSigle = (sigle: readonly string[]) => `{${sigle.join(",")}}`;

/* ── La pagina ─────────────────────────────────────────────────────────────── */

export interface StatoParco {
  vetture: number;
  importataIl: string | null;
  importataDa: string | null;
  consorziate: PrefissoConsorziata[];
  eccezioni: EccezioneSiri[];
  /** le sigle dell'anagrafica che nessun prefisso porta: quei mezzi non si riconoscono dal canale */
  sigleSenzaPrefisso: string[];
}

export async function statoParco(): Promise<StatoParco> {
  const [c, e, v, s] = await Promise.all([
    db.execute<any>(sql`SELECT prefisso, sigle, a_progressivo FROM parco_consorziate ORDER BY ordine, prefisso`),
    db.execute<any>(sql`SELECT siri_ref, codice, nota FROM parco_eccezioni ORDER BY siri_ref`),
    db.execute<any>(sql`
      SELECT count(*)::int AS n, max(v.importata_il) AS il,
             (SELECT coalesce(nullif(btrim(u.full_name), ''), u.email) FROM parco_vetture x JOIN users u ON u.id = x.importata_da
               ORDER BY x.importata_il DESC LIMIT 1) AS da
        FROM parco_vetture v`),
    db.execute<any>(sql`
      SELECT DISTINCT substring(codice from '^[A-Z]+') AS sigla FROM parco_vetture WHERE codice ~ '^[A-Z]+[0-9]{3}$' ORDER BY 1`),
  ]);
  const consorziate: PrefissoConsorziata[] = ((c as any).rows ?? []).map((x: any) => ({
    prefisso: String(x.prefisso), sigle: (x.sigle ?? []).map(String), aProgressivo: x.a_progressivo !== false,
  }));
  const note = new Set(consorziate.flatMap((x) => x.sigle));
  const riga = (v as any).rows?.[0] ?? {};
  return {
    vetture: Number(riga.n ?? 0),
    importataIl: riga.il ? new Date(riga.il).toISOString() : null,
    importataDa: riga.da ?? null,
    consorziate,
    eccezioni: ((e as any).rows ?? []).map((x: any) => ({ siriRef: String(x.siri_ref), codice: String(x.codice), nota: String(x.nota ?? "") })),
    sigleSenzaPrefisso: ((s as any).rows ?? []).map((x: any) => String(x.sigla)).filter((x: string) => x && !note.has(x)),
  };
}

/** Dopo una scrittura: le regole in memoria si rileggono subito, non al minuto dopo. */
async function rileggi(): Promise<void> {
  dimenticaAzienda();
  await leggiAzienda().catch(() => undefined);
}
