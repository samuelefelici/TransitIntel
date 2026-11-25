/**
 * Il file dei turni esistenti (tappa 7.38): l'esportazione dei turni in
 * vigore che il sistema di pianificazione dell'azienda produce nel formato
 * «BDROP» (testo a sezioni `{#NOME … #END}`, campi separati da tabulazioni).
 *
 * Qui si legge soltanto il testo: nessun accesso al database. Il file contiene
 * dati riservati dell'azienda (turni, codici di corse e fermate; nessun nome di
 * persona): si legge in memoria, non si salva, e da qui escono solo i turni.
 *
 * Le sezioni che servono:
 *  - il periodo (la riga «dal  al» in testa);
 *  - SUPERLIVELLO: un insieme di turni guida per tipo di giorno e zona;
 *    dentro, TGUIDA (codice del turno), GIORNATA (residenza, deposito, lavoro,
 *    nastro, tipo) e PEZZI (le righe del turno);
 *  - CALENDARIO: quali insiemi valgono in quale data (più insiemi per data);
 *  - TURNI MACCHINA: il tipo di mezzo di ogni turno macchina;
 *  - NODI: il nome di ogni nodo (capolinea, deposito);
 *  - TIPOPEZZI: il nome di ogni tipo di pezzo.
 *
 * Una riga dei PEZZI ha 20 campi:
 *   0 tipo di pezzo (1 in linea, 2 fuori linea, 60 pre-turno, …)
 *   1 linea («fl» se non è una corsa)      2 turno macchina mostrato (-1 nessuno)
 *   3 nodo di partenza   4 partenza (minuti dalla mezzanotte)   5 (ripetuta)
 *   6 nodo di arrivo     7 arrivo                                8 (ripetuto)
 *   9 ripresa (0, 1, …)  10 segmento del turno   11 —   12 verso (a, d, n)
 *  13 —   14 metri (virgola decimale)   15 id del pezzo   16 id del turno macchina
 *  17 percorso   18 numero della corsa   19 —
 */

export interface PezzoFile {
  /** codice del tipo di pezzo: 1 in linea, 2 fuori linea, 60 pre-turno, 61 pre-ripresa, 42 taxi, … */
  tipo: number;
  /** la linea della corsa; null fuori linea */
  linea: string | null;
  /** il codice del turno macchina come lo mostra il file; null se il pezzo non usa un mezzo */
  turnoMacchina: string | null;
  /** l'identificativo del turno macchina (unico nel file); null se il pezzo non usa un mezzo */
  idTurnoMacchina: string | null;
  da: string;
  partenza: number;
  a: string;
  arrivo: number;
  /** la ripresa del turno guida (0 la prima) */
  ripresa: number;
  verso: "a" | "d" | null;
  metri: number | null;
  /** identificativo del pezzo nel file */
  id: string;
  percorso: string | null;
  /** il numero della corsa: lo stesso che chiude il codice della corsa nel GTFS */
  corsa: string | null;
  /** la riga del file, per i messaggi */
  riga: number;
}

export interface TurnoGuidaFile {
  codice: string;
  superlivello: string;
  residenza: string | null;
  deposito: string | null;
  /** lavoro e nastro come li calcola il file, in minuti */
  lavoroMin: number | null;
  nastroMin: number | null;
  /** il tipo come lo chiama il file (Interi, Semiunici, Spezzati, …) */
  tipo: string | null;
  pezzi: PezzoFile[];
}

export interface SuperlivelloFile {
  id: string;
  nome: string;
  turni: TurnoGuidaFile[];
}

export interface FileTurni {
  /** il periodo del file, AAAA-MM-GG */
  dal: string | null;
  al: string | null;
  superlivelli: SuperlivelloFile[];
  /** data (AAAA-MM-GG) → gli insiemi di turni che valgono quel giorno */
  calendario: Map<string, string[]>;
  /** id del turno macchina → tipo di mezzo come lo scrive il file (12m, 18mi, Filobus, …) */
  mezzi: Map<string, string>;
  /** codice del nodo → nome */
  nodi: Map<string, string>;
  /** codice del tipo di pezzo → nome */
  tipiPezzo: Map<number, string>;
}

/** Il file come testo: UTF-8 se lo è, altrimenti la codifica di Windows con cui lo esportano i programmi. */
export function testoDelFile(buf: Uint8Array): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(buf); } catch { /* non è UTF-8 */ }
  try { return new TextDecoder("windows-1252").decode(buf); } catch { return Buffer.from(buf).toString("latin1"); }
}

/** Il file non è nel formato atteso: il messaggio dice dove e perché, senza il contenuto della riga. */
export class FileTurniNonValido extends Error {
  constructor(messaggio: string) { super(messaggio); this.name = "FileTurniNonValido"; }
}

/* Tipi di pezzo che servono ai turni (TIPOPEZZI del file; i codici sono quelli del formato). */
export const PEZZO = {
  inLinea: 1,
  fuoriLinea: 2,
  raggiungimentoOrario: 40,
  disposizione: 41,
  taxi: 42,
  preTurno: 60,
  preRipresa: 61,
  postTurno: 80,
  disposizione2: 100,
  taxi2: 101,
  postRipresa: 102,
  capolinea: 103,
  verifica: 104,
  riserva: 105,
  rifornimento: 120,
  manovra: 140,
  raggiungimentoForfait: 160,
  presidio: 200,
  coperturaSosta: 220,
  trasferimentoForfait: 240,
  centrale: 260,
  capolineaRiserva: 280,
  trasferimentoOrario: 320,
} as const;

/** Limiti: un file vero sta molto sotto; oltre, è un file sbagliato o costruito apposta. */
const MAX_RIGHE = 3_000_000;
const MAX_PEZZI_PER_TURNO = 2_000;

function campi(riga: string): string[] {
  return riga.split("\t").map((c) => c.trim());
}

function intero(v: string | undefined, riga: number, cosa: string): number {
  if (v === undefined || !/^-?\d{1,7}$/.test(v)) throw new FileTurniNonValido(`riga ${riga}: ${cosa} non è un numero`);
  return Number(v);
}

function interoOpz(v: string | undefined): number | null {
  return v !== undefined && /^-?\d{1,7}$/.test(v) ? Number(v) : null;
}

function nulla(v: string | undefined): string | null {
  if (v === undefined) return null;
  const t = v.trim();
  return t === "" || t.toUpperCase() === "NULLA" || t.toUpperCase() === "NULL" ? null : t;
}

/** «gg/mm/aaaa» → «aaaa-mm-gg»; null se non è una data vera. */
export function dataIso(v: string | undefined): string | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(v ?? "").trim());
  if (!m) return null;
  const [, g, me, a] = m;
  const d = new Date(Date.UTC(Number(a), Number(me) - 1, Number(g)));
  if (d.getUTCFullYear() !== Number(a) || d.getUTCMonth() !== Number(me) - 1 || d.getUTCDate() !== Number(g)) return null;
  return `${a}-${me}-${g}`;
}

function metri(v: string | undefined): number | null {
  const t = String(v ?? "").trim().replace(",", ".");
  if (!/^\d{1,9}(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return n > 0 ? n : null;
}

/** Una riga dei PEZZI. */
function pezzo(c: string[], riga: number): PezzoFile {
  if (c.length < 19) throw new FileTurniNonValido(`riga ${riga}: un pezzo ha ${c.length} campi invece di 20`);
  const tipo = intero(c[0], riga, "il tipo di pezzo");
  const partenza = intero(c[4], riga, "l'orario di partenza");
  const arrivo = intero(c[7], riga, "l'orario di arrivo");
  if (partenza < 0 || arrivo < 0 || partenza > 3 * 1440 || arrivo > 3 * 1440) throw new FileTurniNonValido(`riga ${riga}: orario fuori scala`);
  const tm = c[2] && c[2] !== "-1" ? c[2] : null;
  const idTm = c[16] && c[16] !== "-1" ? c[16] : null;
  const linea = nulla(c[1]);
  const verso = c[12] === "a" || c[12] === "d" ? c[12] : null;
  return {
    tipo,
    linea: linea && linea.toLowerCase() !== "fl" ? linea : null,
    turnoMacchina: tm,
    idTurnoMacchina: idTm ?? (tm ? `tm:${tm}` : null),
    da: c[3] ?? "",
    partenza,
    a: c[6] ?? "",
    arrivo: Math.max(arrivo, partenza),
    ripresa: interoOpz(c[9]) ?? 0,
    verso,
    metri: metri(c[14]),
    id: c[15] || `riga-${riga}`,
    percorso: nulla(c[17]),
    corsa: nulla(c[18]),
    riga,
  };
}

/** Il numero dopo l'apertura di una sezione: quante righe la compongono. */
function conteggio(righe: string[], i: number, sezione: string): number {
  const n = interoOpz(righe[i]?.trim());
  if (n === null || n < 0) throw new FileTurniNonValido(`riga ${i + 1}: manca il numero di righe della sezione ${sezione}`);
  return n;
}

/**
 * Legge il file. Errori di formato → FileTurniNonValido (riga e motivo).
 * Le sezioni che non servono si saltano.
 */
export function leggiFileTurni(testo: string): FileTurni {
  const righe = testo.replace(/^﻿/, "").split(/\r?\n/);
  if (righe.length > MAX_RIGHE) throw new FileTurniNonValido("il file è troppo lungo");
  if (!righe.slice(0, 20).some((r) => /BDROP/i.test(r)) && !righe.some((r) => r.trim() === "{#SUPERLIVELLI")) {
    throw new FileTurniNonValido("non è un file dei turni nel formato atteso (manca la sezione dei turni)");
  }

  const out: FileTurni = {
    dal: null, al: null, superlivelli: [], calendario: new Map(),
    mezzi: new Map(), nodi: new Map(), tipiPezzo: new Map(),
  };
  let sl: SuperlivelloFile | null = null;
  let turno: TurnoGuidaFile | null = null;

  for (let i = 0; i < righe.length; i++) {
    const r = righe[i]!.trim();
    if (!out.dal && /^\d{2}\/\d{2}\/\d{4}\s+\d{2}\/\d{2}\/\d{4}/.test(r)) {
      const [a, b] = r.split(/\s+/);
      out.dal = dataIso(a); out.al = dataIso(b);
      continue;
    }
    if (!r.startsWith("{#")) continue;
    const sezione = r.slice(2).trim();
    switch (sezione) {
      case "SUPERLIVELLO": {
        const c = campi(righe[i + 1] ?? "");
        if (!c[0]) throw new FileTurniNonValido(`riga ${i + 2}: un insieme di turni senza identificativo`);
        sl = { id: c[0], nome: (c[5] || c[0]).replace(/\s+/g, " "), turni: [] };
        out.superlivelli.push(sl);
        turno = null;
        i += 1;
        break;
      }
      case "TGUIDA": {
        if (!sl) throw new FileTurniNonValido(`riga ${i + 1}: un turno guida fuori da un insieme di turni`);
        const codice = (righe[i + 1] ?? "").trim();
        if (!codice || codice.length > 40) throw new FileTurniNonValido(`riga ${i + 2}: codice del turno guida non valido`);
        turno = { codice, superlivello: sl.id, residenza: null, deposito: null, lavoroMin: null, nastroMin: null, tipo: null, pezzi: [] };
        sl.turni.push(turno);
        i += 1;
        break;
      }
      case "GIORNATA": {
        if (!turno) throw new FileTurniNonValido(`riga ${i + 1}: una giornata fuori da un turno guida`);
        const c = campi(righe[i + 1] ?? "");
        turno.residenza = nulla(c[0]);
        turno.deposito = nulla(c[1]);
        turno.lavoroMin = interoOpz(c[4]);
        turno.nastroMin = interoOpz(c[5]);
        turno.tipo = nulla(c[6]);
        i += 1;
        break;
      }
      case "PEZZI": {
        if (!turno) throw new FileTurniNonValido(`riga ${i + 1}: pezzi fuori da un turno guida`);
        const n = conteggio(righe, i + 1, "PEZZI");
        if (n > MAX_PEZZI_PER_TURNO) throw new FileTurniNonValido(`riga ${i + 2}: troppi pezzi in un turno`);
        let j = i + 2;
        for (; j < righe.length && righe[j]!.trim() !== "#END}"; j++) {
          const c = campi(righe[j]!);
          if (c.length < 10) continue; // le righe di servizio fra un pezzo e l'altro
          turno.pezzi.push(pezzo(c, j + 1));
        }
        if (turno.pezzi.length !== n) {
          throw new FileTurniNonValido(`turno ${turno.codice}: attesi ${n} pezzi, trovati ${turno.pezzi.length}`);
        }
        i = j;
        break;
      }
      case "TURNI MACCHINA": {
        const n = conteggio(righe, i + 1, "TURNI MACCHINA");
        for (let k = 0; k < n; k++) {
          const c = campi(righe[i + 2 + k] ?? "");
          if (c[0] && c[1]) out.mezzi.set(c[0], c[1]);
        }
        i += 1 + n;
        break;
      }
      case "CALENDARIO": {
        const n = conteggio(righe, i + 1, "CALENDARIO");
        for (let k = 0; k < n; k++) {
          const c = (righe[i + 2 + k] ?? "").trim().split(/\s+/);
          const d = dataIso(c[0]);
          if (!d || !c[1]) throw new FileTurniNonValido(`riga ${i + 3 + k}: riga del calendario non valida`);
          const v = out.calendario.get(d) ?? [];
          if (!v.includes(c[1])) v.push(c[1]);
          out.calendario.set(d, v);
        }
        i += 1 + n;
        break;
      }
      case "NODI": {
        const n = conteggio(righe, i + 1, "NODI");
        for (let k = 0; k < n; k++) {
          const c = campi(righe[i + 2 + 2 * k] ?? "");
          const nome = (righe[i + 3 + 2 * k] ?? "").trim();
          if (c[0]) out.nodi.set(c[0], nome || c[0]);
        }
        i += 1 + 2 * n;
        break;
      }
      case "TIPOPEZZI": {
        const n = conteggio(righe, i + 1, "TIPOPEZZI");
        for (let k = 0; k < n; k++) {
          const c = campi(righe[i + 2 + k] ?? "");
          const cod = interoOpz(c[1]);
          if (cod !== null && c[0]) out.tipiPezzo.set(cod, c[0]);
        }
        i += 1 + n;
        break;
      }
      default:
        break;
    }
  }

  if (out.superlivelli.length === 0) throw new FileTurniNonValido("il file non contiene turni guida");
  if (out.calendario.size === 0) throw new FileTurniNonValido("il file non ha il calendario: non si sa quali turni valgono in quale giorno");
  return out;
}

/* ─── I giorni del file ─────────────────────────────────────────────── */

export interface GiornoDelFile {
  data: string;
  superlivelli: { id: string; nome: string }[];
  turniGuida: number;
  turniMacchina: number;
}

/** I turni che valgono in una data: l'unione degli insiemi del calendario. */
export function turniDelGiorno(f: FileTurni, data: string): TurnoGuidaFile[] {
  const ids = new Set(f.calendario.get(data) ?? []);
  return f.superlivelli.filter((s) => ids.has(s.id)).flatMap((s) => s.turni);
}

export function giorniDelFile(f: FileTurni): GiornoDelFile[] {
  const perId = new Map(f.superlivelli.map((s) => [s.id, s]));
  return [...f.calendario.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([data, ids]) => {
      const sl = ids.map((id) => perId.get(id)).filter((s): s is SuperlivelloFile => !!s);
      const turni = sl.flatMap((s) => s.turni);
      const tm = new Set<string>();
      for (const t of turni) for (const p of t.pezzi) if (p.idTurnoMacchina) tm.add(p.idTurnoMacchina);
      return {
        data,
        superlivelli: sl.map((s) => ({ id: s.id, nome: s.nome })),
        turniGuida: turni.length,
        turniMacchina: tm.size,
      };
    });
}

/** I tipi di giorno: le date con gli stessi insiemi di turni, raggruppate. */
export interface TipoDiGiorno {
  chiave: string;
  nomi: string[];
  date: string[];
  turniGuida: number;
  turniMacchina: number;
}

export function tipiDiGiorno(giorni: GiornoDelFile[]): TipoDiGiorno[] {
  const gruppi = new Map<string, TipoDiGiorno>();
  for (const g of giorni) {
    const chiave = g.superlivelli.map((s) => s.id).sort().join("+");
    const t = gruppi.get(chiave);
    if (t) { t.date.push(g.data); continue; }
    gruppi.set(chiave, {
      chiave,
      nomi: g.superlivelli.map((s) => s.nome).sort((a, b) => a.localeCompare(b, "it")),
      date: [g.data],
      turniGuida: g.turniGuida,
      turniMacchina: g.turniMacchina,
    });
  }
  return [...gruppi.values()].sort((a, b) => b.date.length - a.date.length || (a.date[0]! < b.date[0]! ? -1 : 1));
}
