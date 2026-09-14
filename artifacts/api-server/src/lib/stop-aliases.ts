/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Transcodifica delle paline — il codice di Mizar ↔ lo stop_id del feed
 * ───────────────────────────────────────────────────────────────────────────
 * Le fermate hanno due numerazioni. Mizar (l'AVM, e quindi il flusso SIRI)
 * chiama «1122» la fermata che il feed GTFS chiama «20045»; e le due
 * numerazioni si sovrappongono: nel feed esiste anche uno stop_id 200, ed è
 * un'altra fermata rispetto alla 200 di Mizar. Agganciare per numero senza
 * tabella non produce assenze: produce fermate sbagliate.
 *
 * La tabella esiste — «Transcodifica Conerobus Paline Maior vs SWI», 4 400
 * righe, 13 aprile 2026 — e sta in data/transcodifica-paline-mizar.csv:
 *   mizar_ref,stop_id,nome
 * Si carica una volta per processo. Un'altra copia si può indicare con
 * SIRI_STOP_ALIAS_FILE. Le righe con uno stop_id non numerico ("new_CT":
 * palina non ancora codificata) si ignorano.
 *
 * Verificata sui dati il 14 settembre 2026: 1122→20045, 200→20001,
 * 461→20928, esattamente le coppie che il confronto per orario aveva
 * dimostrato passando dal nome.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import fs from "node:fs";
import path from "node:path";

export interface RigaTranscodifica {
  mizarRef: string;
  stopId: string;
  nome: string | null;
  /** da dove viene la riga: il file dell'azienda o una correzione dell'operatore */
  fonte?: "file" | "manuale";
  nota?: string | null;
  utente?: string | null;
}

/** Una palina del file senza un codice del feed ("new_CT"): esiste per
 *  Mizar, non ancora per l'esportazione. */
export interface RigaScartata { mizarRef: string; nome: string | null; stopIdGrezzo: string; fonte?: "file" | "manuale"; nota?: string | null; utente?: string | null }

/**
 * La tabella effettiva: il file più le correzioni dell'operatore. Una
 * correzione sostituisce la riga del file con lo stesso codice, o ne aggiunge
 * una nuova; una correzione con stop_id vuoto toglie l'abbinamento e sposta
 * la palina fra quelle «senza fermata». Pura: si collauda senza database.
 */
export function applicaOverrides(
  valide: RigaTranscodifica[], scartate: RigaScartata[],
  overrides: Array<{ mizarRef: string; stopId: string | null; nome: string | null; nota: string | null; utente: string | null }>,
): { valide: RigaTranscodifica[]; scartate: RigaScartata[] } {
  if (!overrides.length) return { valide, scartate };
  const per = new Map(overrides.map(o => [o.mizarRef, o]));
  const outValide: RigaTranscodifica[] = [];
  const outScartate: RigaScartata[] = [];
  const viste = new Set<string>();
  const applica = (mizarRef: string, nomeFile: string | null) => {
    const o = per.get(mizarRef)!;
    viste.add(mizarRef);
    if (o.stopId) outValide.push({ mizarRef, stopId: o.stopId, nome: o.nome ?? nomeFile, fonte: "manuale", nota: o.nota, utente: o.utente });
    else outScartate.push({ mizarRef, nome: o.nome ?? nomeFile, stopIdGrezzo: "", fonte: "manuale", nota: o.nota, utente: o.utente });
  };
  for (const r of valide) {
    if (per.has(r.mizarRef)) applica(r.mizarRef, r.nome);
    else outValide.push({ ...r, fonte: r.fonte ?? "file" });
  }
  for (const s of scartate) {
    if (per.has(s.mizarRef)) applica(s.mizarRef, s.nome);
    else outScartate.push({ ...s, fonte: s.fonte ?? "file" });
  }
  /* Correzioni su codici che il file non ha: paline nuove viste nel flusso. */
  for (const o of overrides) if (!viste.has(o.mizarRef)) applica(o.mizarRef, null);
  return { valide: outValide, scartate: outScartate };
}

/** Legge il CSV per intero: le righe valide e quelle senza codice, separate. */
export function leggiTranscodificaCompleta(testo: string): { valide: RigaTranscodifica[]; scartate: RigaScartata[] } {
  const righe = testo.replace(/^﻿/, "").split(/\r?\n/);
  const valide: RigaTranscodifica[] = [];
  const scartate: RigaScartata[] = [];
  let prima = true;
  for (const riga of righe) {
    if (!riga.trim()) continue;
    const campi = spezzaCsv(riga);
    if (prima) {
      prima = false;
      if (/mizar/i.test(campi[0] ?? "")) continue;   // intestazione
    }
    const mizarRef = (campi[0] ?? "").trim();
    const stopId = (campi[1] ?? "").trim();
    const nome = (campi[2] ?? "").trim() || null;
    if (!mizarRef) continue;
    if (!stopId || !/^[0-9A-Za-z_.:-]+$/.test(stopId) || /^new_/i.test(stopId)) {
      scartate.push({ mizarRef, nome, stopIdGrezzo: stopId });
      continue;
    }
    valide.push({ mizarRef, stopId, nome });
  }
  return { valide, scartate };
}

/** Legge il CSV; tollera BOM, righe vuote e virgolette. Solo le righe valide. */
export function parseTranscodifica(testo: string): RigaTranscodifica[] {
  return leggiTranscodificaCompleta(testo).valide;
}

function spezzaCsv(riga: string): string[] {
  const out: string[] = [];
  let cur = "", inQ = false;
  for (let i = 0; i < riga.length; i++) {
    const c = riga[i];
    if (inQ) {
      if (c === '"' && riga[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQ = false;
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

/** mizar_ref → stop_id. Il primo vince, come per i nomi. */
export function indiceTranscodifica(righe: RigaTranscodifica[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const r of righe) if (!m.has(r.mizarRef)) m.set(r.mizarRef, r.stopId);
  return m;
}

/* ── Il file ─────────────────────────────────────────────────────────────── */

const NOME_FILE = "transcodifica-paline-mizar.csv";

/** Dove cercare il file, nell'ordine: variabile d'ambiente, poi le
 *  posizioni relative al processo (sorgenti con tsx, dist con esbuild,
 *  radice del repo nel container). */
export function percorsiCandidati(): string[] {
  const out: string[] = [];
  if (process.env.SIRI_STOP_ALIAS_FILE) out.push(process.env.SIRI_STOP_ALIAS_FILE);
  const qui = typeof __dirname === "string" ? __dirname : process.cwd();
  out.push(
    path.resolve(qui, "..", "data", NOME_FILE),          // src/lib → data
    path.resolve(qui, "..", "..", "data", NOME_FILE),    // dist → data
    path.resolve(process.cwd(), "artifacts", "api-server", "data", NOME_FILE),
    path.resolve(process.cwd(), "data", NOME_FILE),
  );
  return [...new Set(out)];
}

interface Transcodifica {
  percorso: string | null;
  righe: RigaTranscodifica[];
  scartate: RigaScartata[];
  indice: Map<string, string>;
  errore: string | null;
}
let cache: Transcodifica | null = null;

/** La transcodifica caricata una volta per processo. Senza file: vuota, con il motivo. */
export function caricaTranscodifica(force = false): Transcodifica {
  if (cache && !force) return cache;
  for (const p of percorsiCandidati()) {
    try {
      if (!fs.existsSync(p)) continue;
      const { valide, scartate } = leggiTranscodificaCompleta(fs.readFileSync(p, "utf8"));
      cache = { percorso: p, righe: valide, scartate, indice: indiceTranscodifica(valide), errore: null };
      return cache;
    } catch (e: any) {
      cache = { percorso: p, righe: [], scartate: [], indice: new Map(), errore: e?.message ?? String(e) };
      return cache;
    }
  }
  cache = { percorso: null, righe: [], scartate: [], indice: new Map(), errore: `file ${NOME_FILE} non trovato (SIRI_STOP_ALIAS_FILE per indicarlo)` };
  return cache;
}

/* ── Gli abbinamenti, uno per uno ───────────────────────────────────────────
 * La verifica qui sopra conta. Questa elenca: ogni palina con il suo stato,
 * perché chi tiene la tabella possa correggerla riga per riga. Gli stati
 * sono esclusivi; la collisione è un'informazione in più, perché un
 * abbinamento giusto può comunque avere un numero che nel feed è un'altra
 * fermata. */

export type StatoAbbinamento =
  | "abbinata"          // fermata nel feed, nomi compatibili
  | "sospetta"          // fermata nel feed, ma il nome dice un'altra cosa
  | "fermata_assente"   // lo stop_id della tabella non esiste nel feed in uso
  | "senza_codice";     // palina di Mizar senza codice del feed ("new_CT")

export interface Abbinamento {
  mizarRef: string;
  stopId: string | null;
  nomeMizar: string | null;
  nomeFeed: string | null;
  stato: StatoAbbinamento;
  /** file dell'azienda, o correzione dell'operatore (con nota e autore) */
  fonte: "file" | "manuale";
  nota: string | null;
  utente: string | null;
  /** il codice Mizar coincide con lo stop_id di un'ALTRA fermata del feed */
  collisione: string | null;
  /** quante altre paline Mizar puntano alla stessa fermata */
  condivisaCon: number;
  /** vista nel flusso SIRI dell'ultimo giro */
  vistaNelFlusso: boolean;
}

export interface FermataSenzaCodice { stopId: string; nome: string | null }

export interface Abbinamenti {
  righe: Abbinamento[];
  /** fermate del feed che nessun codice Mizar raggiunge */
  feedSenzaCodice: FermataSenzaCodice[];
  /** codici visti nel flusso SIRI che la tabella non ha */
  flussoNonTrascodificato: string[];
  riepilogo: {
    paline: number;
    abbinate: number; sospette: number; fermateAssenti: number; senzaCodice: number;
    collisioni: number; feedSenzaCodice: number; flussoNonTrascodificato: number;
  };
  lettura: string[];
}

export function classificaAbbinamenti(
  righe: RigaTranscodifica[], scartate: RigaScartata[],
  feed: { stops: Set<string>; stopNames: Map<string, string> },
  flusso: { refs: string[] } = { refs: [] },
  nomiCompatibili: (a: string | null, b: string | null) => boolean = (a, b) => !a || !b || a.trim().toUpperCase() === b.trim().toUpperCase(),
): Abbinamenti {
  const perStop = new Map<string, number>();
  for (const r of righe) perStop.set(r.stopId, (perStop.get(r.stopId) ?? 0) + 1);
  const visti = new Set(flusso.refs.map(x => x.trim()));
  const trascodificati = new Set(righe.map(r => r.mizarRef));

  const out: Abbinamento[] = righe.map(r => {
    const nelFeed = feed.stops.has(r.stopId);
    const nomeFeed = nelFeed ? (feed.stopNames.get(r.stopId) ?? null) : null;
    const stato: StatoAbbinamento = !nelFeed ? "fermata_assente"
      : nomiCompatibili(r.nome, nomeFeed) ? "abbinata" : "sospetta";
    const collisione = feed.stops.has(r.mizarRef) && r.mizarRef !== r.stopId
      ? `${r.mizarRef} = ${feed.stopNames.get(r.mizarRef) ?? "?"}` : null;
    return {
      mizarRef: r.mizarRef, stopId: r.stopId, nomeMizar: r.nome, nomeFeed, stato, collisione,
      fonte: r.fonte ?? "file", nota: r.nota ?? null, utente: r.utente ?? null,
      condivisaCon: (perStop.get(r.stopId) ?? 1) - 1,
      vistaNelFlusso: visti.has(r.mizarRef),
    };
  });
  for (const s of scartate) {
    out.push({
      mizarRef: s.mizarRef, stopId: null, nomeMizar: s.nome, nomeFeed: null, stato: "senza_codice",
      collisione: feed.stops.has(s.mizarRef) ? `${s.mizarRef} = ${feed.stopNames.get(s.mizarRef) ?? "?"}` : null,
      fonte: s.fonte ?? "file", nota: s.nota ?? null, utente: s.utente ?? null,
      condivisaCon: 0, vistaNelFlusso: visti.has(s.mizarRef),
    });
  }

  const feedSenzaCodice: FermataSenzaCodice[] = [...feed.stops]
    .filter(s => !perStop.has(s)).sort()
    .map(s => ({ stopId: s, nome: feed.stopNames.get(s) ?? null }));
  const flussoNonTrascodificato = [...visti].filter(x => x && !trascodificati.has(x)).sort();

  const conta = (st: StatoAbbinamento) => out.filter(x => x.stato === st).length;
  const riepilogo: Abbinamenti["riepilogo"] = {
    paline: out.length,
    abbinate: conta("abbinata"), sospette: conta("sospetta"),
    fermateAssenti: conta("fermata_assente"), senzaCodice: conta("senza_codice"),
    collisioni: out.filter(x => x.collisione).length,
    feedSenzaCodice: feedSenzaCodice.length,
    flussoNonTrascodificato: flussoNonTrascodificato.length,
  };

  const lettura: string[] = [];
  lettura.push(`${riepilogo.paline} paline nella tabella: ${riepilogo.abbinate} abbinate a una fermata del feed con lo stesso nome.`);
  if (riepilogo.sospette) lettura.push(`${riepilogo.sospette} sospette: la fermata esiste nel feed ma il nome è un altro; da controllare una per una.`);
  if (riepilogo.fermateAssenti) lettura.push(`${riepilogo.fermateAssenti} puntano a uno stop_id che il feed in uso non ha: paline nuove, o feed vecchio.`);
  if (riepilogo.senzaCodice) lettura.push(`${riepilogo.senzaCodice} paline senza codice del feed («new_CT»): da codificare nel software aziendale.`);
  if (riepilogo.feedSenzaCodice) lettura.push(`${riepilogo.feedSenzaCodice} fermate del feed non hanno nessun codice Mizar: da lì non arriverà mai un passaggio dichiarato dall'AVM.`);
  if (riepilogo.collisioni) lettura.push(`${riepilogo.collisioni} codici Mizar coincidono con lo stop_id di un'altra fermata: senza la tabella sarebbero fermate sbagliate.`);
  if (riepilogo.flussoNonTrascodificato) lettura.push(`${riepilogo.flussoNonTrascodificato} codici visti nel flusso SIRI dell'ultimo giro mancano dalla tabella.`);
  return { righe: out, feedSenzaCodice, flussoNonTrascodificato, riepilogo, lettura };
}

/** Per i collaudi. */
export function resetTranscodifica(): void { cache = null; }

/**
 * La tabella effettiva: file + correzioni dal database. È questa che
 * l'indice del feed, il ciclo StopMonitoring e la scheda usano.
 */
export async function transcodificaEffettiva(force = false): Promise<Transcodifica & { correzioni: number }> {
  const t = caricaTranscodifica(force);
  const { leggiOverrides } = await import("./stop-alias-overrides");
  const overrides = await leggiOverrides(force);
  const { valide, scartate } = applicaOverrides(t.righe, t.scartate, overrides);
  return { percorso: t.percorso, errore: t.errore, righe: valide, scartate, indice: indiceTranscodifica(valide), correzioni: overrides.length };
}

/**
 * Candidati per nome nel feed, per una palina sospetta o senza fermata:
 * stesso nome normalizzato, poi contenimento. Al più cinque, i migliori
 * prima. Un suggerimento, non una decisione: la decide l'operatore.
 */
export function suggerimentiPerNome(
  nome: string | null, feed: { stops: Set<string>; stopNames: Map<string, string> }, escludi: string | null = null, max = 5,
): Array<{ stopId: string; nome: string | null; motivo: "stesso_nome" | "nome_contenuto" }> {
  if (!nome) return [];
  const norm = (v: string) => v.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
  const q = norm(nome);
  if (q.length < 4) return [];
  const esatti: Array<{ stopId: string; nome: string | null; motivo: "stesso_nome" | "nome_contenuto" }> = [];
  const parziali: typeof esatti = [];
  for (const stopId of feed.stops) {
    if (stopId === escludi) continue;
    const n = feed.stopNames.get(stopId);
    if (!n) continue;
    const nn = norm(n);
    if (!nn) continue;
    if (nn === q) esatti.push({ stopId, nome: n, motivo: "stesso_nome" });
    /* Contenimento in entrambi i versi, ma un nome del feed troppo corto
     * ("OSIMO") starebbe dentro a mezza provincia: non è un suggerimento. */
    else if (nn.includes(q) || (nn.length >= 8 && q.includes(nn))) parziali.push({ stopId, nome: n, motivo: "nome_contenuto" });
  }
  return [...esatti, ...parziali].slice(0, max);
}

/* ── Verifica contro il feed ─────────────────────────────────────────────── */

export interface VerificaTranscodifica {
  righe: number;
  /** stop_id della transcodifica presenti nel feed */
  nelFeed: number;
  /** stop_id che il feed non ha: paline nuove, o feed vecchio */
  nonNelFeed: string[];
  /** fermate del feed che nessun codice Mizar raggiunge */
  feedSenzaCodice: number;
  /** stessa fermata raggiunta da più codici Mizar (banchine unite?) */
  stopConPiuCodici: Array<{ stopId: string; mizarRefs: string[] }>;
  /** codici Mizar che coincidono con uno stop_id del feed DI UN'ALTRA fermata:
   *  gli agganci per numero che sarebbero stati sbagliati */
  collisioni: Array<{ mizarRef: string; stopIdGiusto: string; stopIdOmonimo: string }>;
}

export function verificaTranscodifica(
  righe: RigaTranscodifica[], stopsFeed: Set<string>,
): VerificaTranscodifica {
  const nonNelFeed: string[] = [];
  const perStop = new Map<string, string[]>();
  const collisioni: VerificaTranscodifica["collisioni"] = [];
  let nelFeed = 0;
  for (const r of righe) {
    if (stopsFeed.has(r.stopId)) nelFeed++; else nonNelFeed.push(r.stopId);
    const arr = perStop.get(r.stopId) ?? [];
    arr.push(r.mizarRef); perStop.set(r.stopId, arr);
    if (stopsFeed.has(r.mizarRef) && r.mizarRef !== r.stopId) {
      collisioni.push({ mizarRef: r.mizarRef, stopIdGiusto: r.stopId, stopIdOmonimo: r.mizarRef });
    }
  }
  return {
    righe: righe.length, nelFeed, nonNelFeed,
    feedSenzaCodice: [...stopsFeed].filter(s => !perStop.has(s)).length,
    stopConPiuCodici: [...perStop.entries()].filter(([, v]) => v.length > 1).map(([stopId, mizarRefs]) => ({ stopId, mizarRefs })),
    collisioni,
  };
}
