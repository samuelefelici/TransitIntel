/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ANAGRAFICA DEL PARCO — da matricola SIRI a mezzo
 * ───────────────────────────────────────────────────────────────────────────
 * Il flusso SIRI dell'AVM identifica le vetture con un numero: per le vetture
 * dell'azienda è la matricola così com'è (263, 1372: la regola è in
 * vetture-azienda.ts), per le consorziate è un numero a cinque cifre in cui
 * le DUE cifre iniziali sostituiscono la sigla dell'azienda e le tre finali
 * sono il progressivo:
 *
 *     10003 → SA003    11096 → CJ096    13163 → RE163
 *
 * Un prefisso può valere per due sigle i cui progressivi non si
 * sovrappongono: decide quale codice esiste in anagrafica. Un prefisso può
 * anche non seguire il progressivo: allora si abbina solo con le eccezioni,
 * una matricola per volta.
 *
 * L'officina applica la stessa transcodifica al contrario e mostra il codice
 * con le lettere, insieme a una descrizione del mezzo (ambito, classe di
 * lunghezza, modello). Questo modulo porta quella descrizione in Cerbero: nel
 * diario AVM, nello stato del parco e nei fogli da allegare, così una
 * segnalazione all'officina dice «1372, X30p Interurbano 29+1 posti» e non
 * solo un numero.
 *
 * I prefissi, le eccezioni e l'anagrafica sono dati dell'azienda (tappa 6.21,
 * migrazione 0049): li scrive l'amministratore in Amministrazione → Azienda →
 * AVM, e l'anagrafica si importa dall'export dell'officina. Le funzioni qui
 * sotto sono pure e sincrone, come prima: i dati in vigore stanno in memoria,
 * li aggiorna `leggiAzienda()` insieme alla regola delle vetture (lib/
 * azienda.ts, al più ogni minuto). Finché nessuno li ha letti valgono quelli
 * neutri: nessuna consorziata, nessuna descrizione.
 *
 * Una matricola che non si riesce ad attribuire si legge «consorziata,
 * prefisso NN», o con le sigle possibili, e non viene attribuita a caso.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { eDellAzienda, nomeAzienda } from "./vetture-azienda";

/* ── I dati dell'azienda, in memoria ──────────────────────────────────────── */

/** Un prefisso SIRI delle consorziate: le sigle possibili, e se le tre cifre finali sono il progressivo del codice. */
export interface PrefissoConsorziata { prefisso: string; sigle: readonly string[]; aProgressivo: boolean }
/** Una matricola SIRI che non segue la regola, abbinata a mano al suo codice. */
export interface EccezioneSiri { siriRef: string; codice: string; nota: string }
/** Una vettura dell'anagrafica: il codice dell'officina e la sua descrizione. */
export interface VoceAnagrafica { codice: string; descrizione: string }

export interface ParcoAzienda {
  consorziate: readonly PrefissoConsorziata[];
  eccezioni: readonly EccezioneSiri[];
  vetture: readonly VoceAnagrafica[];
}

/** Nessuna consorziata, nessuna descrizione: un'installazione nuova, o i dati non ancora letti. */
export const PARCO_NEUTRO: ParcoAzienda = Object.freeze({ consorziate: [], eccezioni: [], vetture: [] });

interface Indici {
  parco: ParcoAzienda;
  prefissi: ReadonlyMap<string, PrefissoConsorziata>;
  eccezioni: ReadonlyMap<string, string>;
  eccezioniInverse: ReadonlyMap<string, string>;
  siglaAPrefisso: ReadonlyMap<string, string>;
  anagrafica: ReadonlyMap<string, VoceAnagrafica>;
}

function indici(p: ParcoAzienda): Indici {
  const siglaAPrefisso = new Map<string, string>();
  for (const c of p.consorziate) if (c.aProgressivo) for (const s of c.sigle) if (!siglaAPrefisso.has(s)) siglaAPrefisso.set(s, c.prefisso);
  return {
    parco: p,
    prefissi: new Map(p.consorziate.map((c) => [c.prefisso, c])),
    eccezioni: new Map(p.eccezioni.map((e) => [e.siriRef, e.codice])),
    eccezioniInverse: new Map(p.eccezioni.map((e) => [e.codice, e.siriRef])),
    siglaAPrefisso,
    anagrafica: new Map(p.vetture.map((v) => [v.codice, v])),
  };
}

let inVigore: Indici = indici(PARCO_NEUTRO);

/** Mette in memoria i dati dell'azienda (lo fa leggiAzienda; i test lo chiamano a mano). */
export function impostaParco(p: ParcoAzienda): void { inVigore = indici(p); }

/** I dati in vigore: prefissi, eccezioni e anagrafica. */
export function parcoInVigore(): ParcoAzienda { return inVigore.parco; }

/** Le tre tabelle dell'azienda (migrazione 0049), nell'ordine in cui si scrivono. */
export async function parcoDalDatabase(): Promise<ParcoAzienda> {
  const [c, e, v] = await Promise.all([
    db.execute<any>(sql`SELECT prefisso, sigle, a_progressivo FROM parco_consorziate ORDER BY ordine, prefisso`),
    db.execute<any>(sql`SELECT siri_ref, codice, nota FROM parco_eccezioni ORDER BY siri_ref`),
    db.execute<any>(sql`SELECT codice, descrizione FROM parco_vetture ORDER BY ordine, codice`),
  ]);
  return {
    consorziate: ((c as any).rows ?? []).map((x: any) => ({
      prefisso: String(x.prefisso), sigle: (x.sigle ?? []).map(String), aProgressivo: x.a_progressivo !== false,
    })),
    eccezioni: ((e as any).rows ?? []).map((x: any) => ({ siriRef: String(x.siri_ref), codice: String(x.codice), nota: String(x.nota ?? "") })),
    vetture: ((v as any).rows ?? []).map((x: any) => ({ codice: String(x.codice), descrizione: String(x.descrizione) })),
  };
}

export type Ambito = "urbano" | "interurbano";

export interface SchedaVettura {
  /** matricola come la pubblica SIRI */
  siriRef: string;
  /** codice dell'officina: uguale alla matricola per le vetture dell'azienda */
  codice: string;
  /** il nome dell'azienda, oppure la sigla della consorziata */
  azienda: string;
  /** la descrizione dell'officina così com'è */
  descrizione: string;
  ambito: Ambito | null;
  /** classe di lunghezza normalizzata: "<7,5 m", "7,5–9 m", "9–11 m", "11–15 m", "18 m snodato" */
  classe: string | null;
  /** il modello, quando la descrizione lo porta */
  modello: string | null;
}

/* ── Transcodifica ────────────────────────────────────────────────────────── */

/**
 * Da matricola SIRI al codice dell'officina; `null` se non si può dire.
 *
 * Con una sola sigla per prefisso il codice si costruisce anche se non è in
 * anagrafica (una vettura nuova di CJ resta CJ). Con due sigle, come per il
 * 10, decide l'anagrafica: se il progressivo non c'è in nessuna delle due la
 * vettura non viene attribuita.
 */
export function codiceDaSiri(siriRef: string): string | null {
  const ref = siriRef.trim();
  if (eDellAzienda(ref)) return ref;
  const eccezione = inVigore.eccezioni.get(ref);
  if (eccezione) return eccezione;
  if (!/^\d{5}$/.test(ref)) return null;
  const regola = inVigore.prefissi.get(ref.slice(0, 2));
  if (!regola?.aProgressivo) return null;
  const candidati = regola.sigle.map(s => s + ref.slice(2));
  const inAnagrafica = candidati.filter(c => inVigore.anagrafica.has(c));
  if (inAnagrafica.length === 1) return inAnagrafica[0];
  return candidati.length === 1 ? candidati[0] : null;
}

/** Dal codice dell'officina alla matricola SIRI. `null` se la sigla non ha una regola. */
export function siriDaCodice(codice: string): string | null {
  const c = codice.trim().toUpperCase();
  if (eDellAzienda(c)) return c;
  const eccezione = inVigore.eccezioniInverse.get(c);
  if (eccezione) return eccezione;
  const m = c.match(/^([A-Z]+)(\d{3})$/);
  if (!m) return null;
  const prefisso = inVigore.siglaAPrefisso.get(m[1]);
  return prefisso ? prefisso + m[2] : null;
}

/**
 * Il nome dell'azienda, la sigla della consorziata, le sigle possibili ("AF/SAP") se
 * il prefisso è noto ma la vettura no, oppure `null` se il prefisso è ignoto.
 */
export function aziendaDaSiri(siriRef: string): string | null {
  const ref = siriRef.trim();
  if (eDellAzienda(ref)) return nomeAzienda();
  const codice = codiceDaSiri(ref);
  if (codice) return codice.match(/^[A-Z]+/)?.[0] ?? null;
  if (/^\d{5}$/.test(ref)) return inVigore.prefissi.get(ref.slice(0, 2))?.sigle.join("/") ?? null;
  return null;
}

/** Com'è vista dalla pagina una vettura che non si riesce ad attribuire. */
export function etichettaAzienda(siriRef: string): string {
  const a = aziendaDaSiri(siriRef);
  if (a) return a;
  if (/^\d{5}$/.test(siriRef)) return `consorziata, prefisso ${siriRef.slice(0, 2)}`;
  return "matricola non riconosciuta";
}

/* ── Lettura della descrizione dell'officina ──────────────────────────────── */

const CLASSI: Array<[RegExp, string]> = [
  [/snodato\s*18\s*m/i, "18 m snodato"],
  [/<7,5\s*m/i, "<7,5 m"],
  [/=7,5<9\s*m/i, "7,5–9 m"],
  [/=9<11\s*m/i, "9–11 m"],
  [/=11<12\s*m/i, "11–12 m"],
  [/=11<15\s*m/i, "11–15 m"],
];

function classeDa(testo: string): string | null {
  for (const [re, classe] of CLASSI) if (re.test(testo)) return classe;
  return null;
}

export function interpretaDescrizione(descrizione: string): Pick<SchedaVettura, "ambito" | "classe" | "modello"> {
  const d = descrizione.replace(/\s+/g, " ").trim();
  const ambito: Ambito | null = /interurbano/i.test(d) ? "interurbano" : /urbano/i.test(d) ? "urbano" : null;

  /* «Urbano =11<15m Irisbus Citelis…», «Interurbano snodato 18m Setra…»,
   * «Urbano Snodato 18m - Solaris…»: ambito, classe, poi il modello. */
  const m1 = d.match(/^(?:Urbano|Interurbano)\s+(snodato\s*18\s*m|<7,5m|=7,5<9m|=9<11m|=11<15m)\s*-?\s*(.*)$/i);
  if (m1) return { ambito, classe: classeDa(m1[1]), modello: m1[2].trim() || null };

  /* «10m - Urbano normale (=9<11mt)», «E3 - Interurbano medio (=7,5<9mt)»,
   * «X30p - Interurbano 29+1 posti»: una categoria, non un modello. */
  const m2 = d.match(/^\S+\s+-\s+(?:Urbano|Interurbano)\s+(.*)$/i);
  if (m2) {
    const dentro = m2[1].match(/\((.*)\)/)?.[1];
    return { ambito, classe: dentro ? classeDa(dentro) : null, modello: null };
  }

  /* «IVECO Crossway»: solo il modello. */
  return { ambito, classe: classeDa(d), modello: d || null };
}

/* ── L'anagrafica ─────────────────────────────────────────────────────────── */

/** Tutte le voci dell'anagrafica, nell'ordine dell'export. */
export function anagraficaParco(): VoceAnagrafica[] {
  return [...inVigore.anagrafica.values()];
}

/** La scheda del mezzo a partire dalla matricola SIRI; `null` se non è in anagrafica. */
export function schedaVettura(siriRef: string): SchedaVettura | null {
  const codice = codiceDaSiri(siriRef);
  if (!codice) return null;
  const voce = inVigore.anagrafica.get(codice);
  if (!voce) return null;
  return {
    siriRef: siriRef.trim(),
    codice,
    azienda: aziendaDaSiri(siriRef) ?? "?",
    descrizione: voce.descrizione,
    ...interpretaDescrizione(voce.descrizione),
  };
}

/** I tre campi che le pagine mostrano accanto alla matricola. */
export interface IdentitaVettura {
  /** codice dell'officina, o null se il prefisso SIRI non è ancora abbinato */
  codice: string | null;
  /** il nome dell'azienda, la sigla della consorziata, o la spiegazione di perché non si sa */
  azienda: string;
  /** descrizione del mezzo dall'officina, o null se la vettura non è in anagrafica */
  mezzo: string | null;
}

export function identitaVettura(siriRef: string): IdentitaVettura {
  const s = schedaVettura(siriRef);
  return {
    codice: s?.codice ?? codiceDaSiri(siriRef),
    azienda: etichettaAzienda(siriRef),
    mezzo: s?.descrizione ?? null,
  };
}
