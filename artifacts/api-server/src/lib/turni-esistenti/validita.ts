/**
 * Le validità delle corse dal file dei turni (tappa 7.39).
 *
 * Il calendario del file dice quali insiemi di turni valgono in quale data;
 * ogni insieme contiene i turni, e i turni le corse. Quindi per ogni corsa il
 * file dice esattamente in quali date gira. Qui quelle date diventano la
 * validità della corsa di Planning Studio, nella matrice di validità:
 *  - il periodo della corsa è quello del file;
 *  - valgono i giorni tipo (feriale, sabato, festivo) delle sue date;
 *  - le date dei suoi giorni tipo in cui non gira sono eccezioni «spenta».
 * Funzioni pure: il giorno tipo di ogni data lo passa chi chiama, con la
 * stessa regola della valutazione della validità (lib/planning-studio-validity-eval.ts).
 */
import { createHash } from "node:crypto";
import { PEZZO, giorniDelFile, tipiDiGiorno, type FileTurni } from "./file";
import { lineaNormale, numeroDellaCorsa, type CorsaDelFile, type CorsaGtfs } from "./abbina";

/** Le date (AAAA-MM-GG) in cui gira ogni corsa del file, dal calendario degli insiemi di turni. */
export function dateDelleCorse(f: FileTurni): Map<string, Set<string>> {
  const datePerInsieme = new Map<string, string[]>();
  for (const [data, insiemi] of f.calendario) {
    for (const id of insiemi) {
      const v = datePerInsieme.get(id) ?? [];
      v.push(data);
      datePerInsieme.set(id, v);
    }
  }
  const out = new Map<string, Set<string>>();
  for (const s of f.superlivelli) {
    const date = datePerInsieme.get(s.id);
    if (!date?.length) continue;
    for (const t of s.turni) {
      for (const p of t.pezzi) {
        if (p.tipo !== PEZZO.inLinea || !p.corsa) continue;
        const v = out.get(p.corsa) ?? new Set<string>();
        for (const d of date) v.add(d);
        out.set(p.corsa, v);
      }
    }
  }
  return out;
}

/** Le date da `dal` ad `al` comprese (AAAA-MM-GG), al più 800. */
export function giorniDa(dal: string, al: string): string[] {
  const out: string[] = [];
  const [a, m, g] = dal.split("-").map(Number);
  const d = new Date(Date.UTC(a!, m! - 1, g!));
  for (let i = 0; i < 800; i++) {
    const iso = d.toISOString().slice(0, 10);
    if (iso > al) break;
    out.push(iso);
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/** Il periodo del file: quello in testa, altrimenti dalla prima all'ultima data del calendario. */
export function periodoDelFile(f: FileTurni): { dal: string; al: string } | null {
  const date = [...f.calendario.keys()].sort();
  const dal = f.dal ?? date[0] ?? null;
  const al = f.al ?? date[date.length - 1] ?? null;
  return dal && al && dal <= al ? { dal, al } : null;
}

/**
 * L'abbinamento per le validità, su tutto il progetto (non su un giorno solo):
 *  1. col numero della corsa, come per i turni;
 *  2. con linea, partenza e arrivo (±3 minuti) solo se nel progetto c'è UNA
 *     corsa sola con quell'orario: allora le corse del file con quell'orario
 *     (di solito la stessa corsa in tipi di giorno diversi) le danno tutte le
 *     loro date. Con più corse candidate l'abbinamento è incerto e la corsa
 *     del file resta fuori: una corsa feriale non deve prendere le date di
 *     una festiva con lo stesso orario.
 */
export interface AbbinamentoValidita {
  /** corsa del progetto → corse del file che le danno le date */
  corsePerTrip: Map<string, string[]>;
  perNumero: number;
  perOrario: number;
  incerte: CorsaDelFile[];
  nonTrovate: CorsaDelFile[];
}

export function abbinaPerValidita(corseFile: CorsaDelFile[], progetto: CorsaGtfs[]): AbbinamentoValidita {
  const perNumero = new Map<string, CorsaGtfs[]>();
  const perLinea = new Map<string, CorsaGtfs[]>();
  for (const g of progetto) {
    const n = numeroDellaCorsa(g.codice ?? g.tripId);
    if (n) { const v = perNumero.get(n) ?? []; v.push(g); perNumero.set(n, v); }
    const l = lineaNormale(g.linea);
    const v = perLinea.get(l) ?? []; v.push(g); perLinea.set(l, v);
  }
  const out: AbbinamentoValidita = { corsePerTrip: new Map(), perNumero: 0, perOrario: 0, incerte: [], nonTrovate: [] };
  const assegna = (tripId: string, corsa: string) => {
    const v = out.corsePerTrip.get(tripId) ?? [];
    v.push(corsa);
    out.corsePerTrip.set(tripId, v);
  };
  const usatePerNumero = new Set<string>();
  const resto: CorsaDelFile[] = [];
  for (const c of corseFile) {
    const cand = (perNumero.get(numeroDellaCorsa(c.corsa) ?? "") ?? []).filter((g) => !usatePerNumero.has(g.tripId));
    const scelte = cand.length > 1 ? cand.filter((g) => Math.abs(g.partenza - c.partenza) <= 2) : cand;
    if (scelte.length === 1) {
      usatePerNumero.add(scelte[0]!.tripId);
      assegna(scelte[0]!.tripId, c.corsa);
      out.perNumero++;
    } else {
      resto.push(c);
    }
  }
  for (const c of resto) {
    const cand = (perLinea.get(lineaNormale(c.linea)) ?? [])
      .filter((g) => g.partenza === c.partenza && Math.abs(g.arrivo - c.arrivo) <= 3);
    if (cand.length === 1) { assegna(cand[0]!.tripId, c.corsa); out.perOrario++; }
    else if (cand.length > 1) out.incerte.push(c);
    else out.nonTrovate.push(c);
  }
  const ordina = (a: CorsaDelFile, b: CorsaDelFile) => lineaNormale(a.linea).localeCompare(lineaNormale(b.linea), "it", { numeric: true }) || a.partenza - b.partenza;
  out.incerte.sort(ordina);
  out.nonTrovate.sort(ordina);
  return out;
}

export interface ValiditaDiUnaCorsa {
  tripId: string;
  /** le date in cui gira, in ordine */
  date: string[];
  /** i giorni tipo da accendere */
  giorniTipo: string[];
  /** le date dei suoi giorni tipo in cui non gira: eccezioni «spenta» */
  spente: string[];
}

/**
 * La validità di ogni corsa del progetto riconosciuta nel file.
 * `giornoTipo` dà l'id del giorno tipo di una data (null se non ne ha).
 */
export function validitaDalFile(
  f: FileTurni,
  corsePerTrip: Map<string, string[]>,
  giornoTipo: (data: string) => string | null,
  periodo: { dal: string; al: string },
): ValiditaDiUnaCorsa[] {
  const perCorsa = dateDelleCorse(f);
  const giorni = giorniDa(periodo.dal, periodo.al);
  const out: ValiditaDiUnaCorsa[] = [];
  for (const [tripId, corse] of corsePerTrip) {
    const tutte = new Set<string>();
    for (const c of corse) for (const d of perCorsa.get(c) ?? []) tutte.add(d);
    const date = [...tutte].filter((d) => d >= periodo.dal && d <= periodo.al).sort();
    if (date.length === 0) continue;
    const quando = new Set(date);
    const tipi = new Set<string>();
    for (const d of date) { const t = giornoTipo(d); if (t) tipi.add(t); }
    const spente = giorni.filter((d) => !quando.has(d) && tipi.has(giornoTipo(d) ?? ""));
    out.push({ tripId, date, giorniTipo: [...tipi].sort(), spente });
  }
  return out;
}

/* ─── Le unità di progettazione dal file (tappa 7.40) ───────────────── */

export interface UnitaDelFile {
  /** id stabile dell'unità: lo stesso tipo di giorno, ricaricato, aggiorna la stessa unità */
  validityId: string;
  nome: string;
  /** gli insiemi di turni del file, uno per riga */
  insiemi: string[];
  date: string[];
  tripIds: string[];
}

const MAX_NOME = 240;

/** Il nome di un'unità: gli insiemi di turni del file, uniti; accorciato se troppo lungo. */
export function nomeUnita(nomi: string[]): string {
  const t = nomi.join(" + ");
  return t.length > MAX_NOME ? `${t.slice(0, MAX_NOME - 1)}…` : t;
}

/** L'id dell'unità di un tipo di giorno del file: dal prefisso si riconoscono le unità nate dal file. */
export function idUnita(chiave: string): string {
  return `file-${createHash("sha256").update(`file-turni|${chiave}`).digest("hex").slice(0, 27)}`;
}

/**
 * Un'unità di progettazione per ogni tipo di giorno del file (le date con gli
 * stessi insiemi di turni): le sue date e le corse del progetto che in quei
 * giorni girano, cioè quelle abbinate alle corse dei suoi insiemi. Un tipo
 * di giorno senza nessuna corsa del progetto non dà un'unità.
 */
export function unitaDalFile(f: FileTurni, corsePerTrip: Map<string, string[]>): UnitaDelFile[] {
  const corsePerInsieme = new Map<string, Set<string>>();
  for (const s of f.superlivelli) {
    const v = new Set<string>();
    for (const t of s.turni) for (const p of t.pezzi) if (p.tipo === PEZZO.inLinea && p.corsa) v.add(p.corsa);
    corsePerInsieme.set(s.id, v);
  }
  const tripPerCorsa = new Map<string, string>();
  for (const [tripId, corse] of corsePerTrip) for (const c of corse) tripPerCorsa.set(c, tripId);
  const out: UnitaDelFile[] = [];
  for (const tipo of tipiDiGiorno(giorniDelFile(f))) {
    const trips = new Set<string>();
    for (const id of tipo.chiave.split("+")) {
      for (const c of corsePerInsieme.get(id) ?? []) {
        const t = tripPerCorsa.get(c);
        if (t) trips.add(t);
      }
    }
    if (trips.size === 0) continue;
    out.push({
      validityId: idUnita(tipo.chiave),
      nome: nomeUnita(tipo.nomi),
      insiemi: tipo.nomi,
      date: [...tipo.date].sort(),
      tripIds: [...trips].sort(),
    });
  }
  return out;
}
