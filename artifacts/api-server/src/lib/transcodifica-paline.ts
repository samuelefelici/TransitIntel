/**
 * ═══════════════════════════════════════════════════════════════════════════
 * La transcodifica delle paline dell'AVM — la base, dato dell'azienda (6.20)
 * ───────────────────────────────────────────────────────────────────────────
 * Quale stop_id del feed corrisponde a ogni codice palina dell'AVM. Era un
 * file dentro il codice (data/transcodifica-paline-mizar.csv, di un solo
 * cliente); ora è la tabella transcodifica_paline (migrazione 0048), che
 * l'amministratore sostituisce per intero importando un CSV nello stesso
 * formato del file:
 *   mizar_ref,stop_id,nome
 * Le correzioni dell'operatore (lib/stop-alias-overrides.ts) restano sopra
 * questa base, come prima sopra il file.
 *
 * Una riga senza uno stop_id valido («new_CT»: palina non ancora codificata
 * nel feed) si tiene, con lo stop_id vuoto e il codice del file a parte: è
 * fra le paline «senza fermata».
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { fornitoreAvm } from "./vetture-azienda";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { spezzaCsv, type RigaScartata, type RigaTranscodifica } from "./stop-aliases";

/** Le forme ammesse, le stesse dei vincoli della tabella. */
export const PALINA = /^[0-9A-Za-z_.:-]{1,40}$/;
const STOP_ID = /^[0-9A-Za-z_.:-]{1,64}$/;
/** Quante righe al più in un import: le aziende vere ne hanno qualche migliaio. */
export const MASSIMO_RIGHE = 50_000;

/** Una riga della base, com'è nella tabella. */
export interface RigaBase { palina: string; stopId: string | null; codiceFile: string | null; nome: string | null }

/** Lo stop_id del file vale se ha la forma giusta e non è un segnaposto («new_…»). */
export function stopIdValido(v: string): boolean {
  return STOP_ID.test(v) && !/^new_/i.test(v);
}

/** Toglie i caratteri di controllo e gli spazi ai lati; vuoto → null. */
const pulito = (v: string | undefined, max: number): string | null => {
  const t = (v ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return t ? t.slice(0, max) : null;
};

export interface LetturaCsv {
  righe: RigaBase[];
  /** righe con un codice palina già visto: vale la prima, come prima col file */
  doppie: number;
  /** i problemi che fermano l'import, con il numero di riga */
  errori: string[];
}

/**
 * Il CSV dell'import, riga per riga e nell'ordine: intestazione facoltativa,
 * BOM, righe vuote e virgolette tollerati. Pura: si collauda senza database.
 */
export function leggiCsvTranscodifica(testo: string): LetturaCsv {
  const righe: RigaBase[] = [];
  const errori: string[] = [];
  const viste = new Set<string>();
  let doppie = 0;
  const linee = testo.replace(/^﻿/, "").split(/\r?\n/);
  let prima = true;
  for (let n = 0; n < linee.length; n++) {
    const linea = linee[n]!;
    if (!linea.trim()) continue;
    const campi = spezzaCsv(linea);
    if (prima) {
      prima = false;
      /* l'intestazione: «mizar_ref,stop_id,nome» o simili */
      if (/mizar|palina/i.test(campi[0] ?? "") || /^\s*stop_id\s*$/i.test(campi[1] ?? "")) continue;
    }
    const palina = (campi[0] ?? "").trim();
    if (!palina) continue;
    if (!PALINA.test(palina)) {
      if (errori.length < 5) errori.push(`riga ${n + 1}: il codice palina «${palina.slice(0, 40)}» non va (lettere, cifre e . _ : -, al più 40)`);
      else if (errori.length === 5) errori.push("…e altre");
      continue;
    }
    if (viste.has(palina)) { doppie++; continue; }
    viste.add(palina);
    const grezzo = (campi[1] ?? "").trim();
    const valido = stopIdValido(grezzo);
    righe.push({
      palina,
      stopId: valido ? grezzo : null,
      codiceFile: valido ? null : pulito(grezzo, 64),
      nome: pulito(campi[2], 200),
    });
    if (righe.length > MASSIMO_RIGHE) {
      errori.splice(0, errori.length, `più di ${MASSIMO_RIGHE.toLocaleString("it-IT")} righe: non sembra una transcodifica delle paline`);
      break;
    }
  }
  if (!righe.length && !errori.length) errori.push("il file non ha nessuna riga con un codice palina");
  return { righe, doppie, errori };
}

/**
 * Le righe della base come le usano le regole (lib/stop-aliases.ts): con la
 * fermata, e senza (la palina c'è, la fermata nel feed non ancora).
 */
export function righeDellaBase(base: readonly RigaBase[]): { righe: RigaTranscodifica[]; scartate: RigaScartata[] } {
  const righe: RigaTranscodifica[] = [];
  const scartate: RigaScartata[] = [];
  for (const x of base) {
    if (x.stopId) righe.push({ mizarRef: x.palina, stopId: x.stopId, nome: x.nome, fonte: "azienda" });
    else scartate.push({ mizarRef: x.palina, nome: x.nome, stopIdGrezzo: x.codiceFile ?? "", fonte: "azienda" });
  }
  return { righe, scartate };
}

/* ── La lettura, con la memoria di un minuto ─────────────────────────────── */

export interface BaseTranscodifica {
  righe: RigaTranscodifica[];
  scartate: RigaScartata[];
  /** quando è stata importata l'ultima volta, e da chi (nome o email) */
  importataIl: string | null;
  importataDa: string | null;
  errore: string | null;
}

const DURATA_MS = 60_000;
let inMemoria: { base: BaseTranscodifica; lettaIl: number } | null = null;

/** Fa rileggere la tabella alla prossima richiesta (dopo un import, e nei test). */
export function dimenticaTranscodifica(): void { inMemoria = null; }

/**
 * La base della transcodifica, dalla tabella. Se il database non risponde
 * vale l'ultima lettura; senza, una base vuota con il motivo: le fermate
 * dell'AVM si agganciano allora solo per codice o per nome.
 */
export async function leggiBaseTranscodifica(force = false): Promise<BaseTranscodifica> {
  if (!force && inMemoria && Date.now() - inMemoria.lettaIl < DURATA_MS) return inMemoria.base;
  try {
    const r = await db.execute<any>(sql`
      SELECT t.palina, t.stop_id, t.codice_file, t.nome, t.importata_il,
             coalesce(nullif(btrim(u.full_name), ''), u.email) AS importata_da
        FROM transcodifica_paline t LEFT JOIN users u ON u.id = t.importata_da
       ORDER BY t.ordine, t.palina`);
    const tutte = ((r as any).rows ?? []) as any[];
    const { righe, scartate } = righeDellaBase(tutte.map((x) => ({
      palina: String(x.palina), stopId: x.stop_id ?? null, codiceFile: x.codice_file ?? null, nome: x.nome ?? null,
    })));
    const ultima = tutte.reduce<any>((a, x) => (!a || new Date(x.importata_il) > new Date(a.importata_il) ? x : a), null);
    const base: BaseTranscodifica = {
      righe, scartate,
      importataIl: ultima ? new Date(ultima.importata_il).toISOString() : null,
      importataDa: ultima?.importata_da ?? null,
      errore: tutte.length ? null : `la tabella della transcodifica delle paline è vuota: si importa dalla pagina «Paline ${fornitoreAvm().breve}»`,
    };
    inMemoria = { base, lettaIl: Date.now() };
    return base;
  } catch (e: any) {
    if (inMemoria) return inMemoria.base;
    return { righe: [], scartate: [], importataIl: null, importataDa: null, errore: e?.cause?.message ?? e?.message ?? String(e) };
  }
}

/* ── L'import ────────────────────────────────────────────────────────────── */

export interface EsitoImport { righe: number; conFermata: number; senzaFermata: number; doppie: number }

/**
 * Sostituisce la base con le righe del CSV, tutte insieme: o tutte o
 * nessuna. Le correzioni dell'operatore non si toccano. Chi chiama ha già
 * controllato che l'utente sia un amministratore.
 */
export async function importaTranscodifica(righe: readonly RigaBase[], doppie: number, utenteId: string | null): Promise<EsitoImport> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`DELETE FROM transcodifica_paline`);
    for (let i = 0; i < righe.length; i += 500) {
      const pezzo = righe.slice(i, i + 500);
      await tx.execute(sql`
        INSERT INTO transcodifica_paline (palina, stop_id, codice_file, nome, ordine, importata_da)
        VALUES ${sql.join(pezzo.map((r, k) => sql`(${r.palina}, ${r.stopId}, ${r.codiceFile}, ${r.nome}, ${i + k + 1}, ${utenteId}::uuid)`), sql`, `)}`);
    }
  });
  dimenticaTranscodifica();
  const conFermata = righe.filter((r) => r.stopId).length;
  return { righe: righe.length, conFermata, senzaFermata: righe.length - conFermata, doppie };
}

/** Quante paline ha la base (per lo stato dell'installazione). */
export async function contaPaline(): Promise<number> {
  const r = await db.execute<any>(sql`SELECT count(*)::int AS n FROM transcodifica_paline`);
  return Number((r as any).rows?.[0]?.n ?? 0);
}
