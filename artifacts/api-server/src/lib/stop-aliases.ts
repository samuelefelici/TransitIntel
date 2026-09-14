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
}

/** Legge il CSV; tollera BOM, righe vuote e virgolette. */
export function parseTranscodifica(testo: string): RigaTranscodifica[] {
  const righe = testo.replace(/^﻿/, "").split(/\r?\n/);
  const out: RigaTranscodifica[] = [];
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
    if (!mizarRef || !stopId) continue;
    if (!/^[0-9A-Za-z_.:-]+$/.test(stopId) || /^new_/i.test(stopId)) continue;
    out.push({ mizarRef, stopId, nome: (campi[2] ?? "").trim() || null });
  }
  return out;
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

let cache: { percorso: string | null; righe: RigaTranscodifica[]; indice: Map<string, string>; errore: string | null } | null = null;

/** La transcodifica caricata una volta per processo. Senza file: vuota, con il motivo. */
export function caricaTranscodifica(force = false): { percorso: string | null; righe: RigaTranscodifica[]; indice: Map<string, string>; errore: string | null } {
  if (cache && !force) return cache;
  for (const p of percorsiCandidati()) {
    try {
      if (!fs.existsSync(p)) continue;
      const righe = parseTranscodifica(fs.readFileSync(p, "utf8"));
      cache = { percorso: p, righe, indice: indiceTranscodifica(righe), errore: null };
      return cache;
    } catch (e: any) {
      cache = { percorso: p, righe: [], indice: new Map(), errore: e?.message ?? String(e) };
      return cache;
    }
  }
  cache = { percorso: null, righe: [], indice: new Map(), errore: `file ${NOME_FILE} non trovato (SIRI_STOP_ALIAS_FILE per indicarlo)` };
  return cache;
}

/** Per i collaudi. */
export function resetTranscodifica(): void { cache = null; }

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
