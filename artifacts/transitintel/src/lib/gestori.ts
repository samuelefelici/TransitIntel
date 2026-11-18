/**
 * I gestori (tappa 6.11): le aziende che gestiscono le linee, ognuna
 * un'agenzia nei GTFS. I tipi delle API (/api/admin/gestori per l'elenco,
 * /api/planning-studio/projects/:id/gestori per le linee di un programma),
 * il modulo della scheda in Amministrazione › Azienda e i conti del
 * riquadro «Gestori delle linee» di Planning Studio.
 * Senza React: si prova da solo.
 */
import type { AgenziaNelGtfs } from "./elenchi-tariffe";

export interface Gestore {
  /** l'identificativo: quello del GTFS (agency_id) e quello che sta sulle linee */
  gestore: string;
  nome: string;
  sito: string;
  telefono: string | null;
  email: string | null;
  tariffeUrl: string | null;
  predefinito: boolean;
}

/** Un gestore dell'elenco con le linee che lo dicono nei programmi di lavoro. */
export interface GestoreConLinee extends Gestore { linee: number }

export interface ElencoGestori {
  gestori: GestoreConLinee[];
  /** le linee dei programmi che non dicono un gestore dell'elenco: prendono il predefinito */
  lineeSenzaGestore: number;
  massimo: number;
  /** l'azienda dell'installazione: è lei l'agenzia finché l'elenco è vuoto */
  azienda: AgenziaNelGtfs;
}

/* ── Il modulo di un gestore ──────────────────────────────────────────────── */

export interface ModuloGestore { gestore: string; nome: string; sito: string; telefono: string; email: string; tariffeUrl: string }

export const moduloVuoto = (): ModuloGestore => ({ gestore: "", nome: "", sito: "", telefono: "", email: "", tariffeUrl: "" });
export const moduloDa = (g: Gestore): ModuloGestore => ({
  gestore: g.gestore, nome: g.nome, sito: g.sito, telefono: g.telefono ?? "", email: g.email ?? "", tariffeUrl: g.tariffeUrl ?? "",
});

const INDIRIZZO = /^https?:\/\/[^\s",<>]{1,200}$/;
const POSTA = /^[^\s",<>@]{1,64}@[^\s",<>@]{1,190}$/;
const TELEFONO = /^[0-9+() ./-]{3,40}$/;

/** Che cosa non va nel modulo, prima di salvare. `gia`: gli identificativi che ci sono già (per un gestore nuovo). */
export function erroriGestore(m: ModuloGestore, gia: readonly string[] = []): string[] {
  const e: string[] = [];
  const id = m.gestore.trim();
  if (!/^[A-Za-z0-9_.-]{1,40}$/.test(id)) e.push("L'identificativo ha solo lettere, cifre e . _ - (al più 40), senza spazi.");
  else if (gia.includes(id)) e.push(`C'è già un gestore con l'identificativo «${id}».`);
  const nome = m.nome.trim();
  if (!nome) e.push("Manca il nome.");
  else if (nome.length > 120) e.push("Il nome ha al più 120 caratteri.");
  else if (nome.includes('"')) e.push("Il nome non può contenere virgolette.");
  if (!INDIRIZZO.test(m.sito.trim())) e.push("Il sito comincia con http:// o https://: nei GTFS è obbligatorio.");
  if (m.telefono.trim() && !TELEFONO.test(m.telefono.trim())) e.push("Il telefono ha solo cifre, spazi e + ( ) . / -.");
  if (m.email.trim() && !POSTA.test(m.email.trim())) e.push("L'indirizzo di posta non è valido.");
  if (m.tariffeUrl.trim() && !INDIRIZZO.test(m.tariffeUrl.trim())) e.push("La pagina delle tariffe comincia con http:// o https://.");
  return e;
}

const oNiente = (s: string): string | null => (s.trim() === "" ? null : s.trim());

/** Il corpo di POST /api/admin/gestori. */
export const corpoNuovoGestore = (m: ModuloGestore) => ({
  gestore: m.gestore.trim(), nome: m.nome.trim(), sito: m.sito.trim(),
  telefono: oNiente(m.telefono), email: oNiente(m.email), tariffeUrl: oNiente(m.tariffeUrl),
});
/** Il corpo di PUT /api/admin/gestori/:gestore: tutto tranne l'identificativo. */
export const corpoModificaGestore = (m: ModuloGestore) => {
  const { gestore: _id, ...resto } = corpoNuovoGestore(m);
  return resto;
};

/* ── Frasi della scheda ───────────────────────────────────────────────────── */

const linee = (n: number) => (n === 1 ? "una linea" : `${n} linee`);

/** Chi figura come agenzia nei GTFS, in una riga. */
export function riassuntoGestori(e: Pick<ElencoGestori, "gestori" | "azienda">): string {
  if (e.gestori.length === 0) return `Non ci sono gestori: nei GTFS l'agenzia è l'azienda, ${e.azienda.agency_name} (${e.azienda.agency_id}), per tutte le linee.`;
  const p = e.gestori.find((g) => g.predefinito) ?? e.gestori[0]!;
  return e.gestori.length === 1
    ? `Un gestore: ${p.nome} (${p.gestore}). Nei GTFS è l'agenzia di tutte le linee.`
    : `${e.gestori.length} gestori. Il predefinito è ${p.nome} (${p.gestore}): è il gestore delle linee che non ne hanno uno loro.`;
}

/** L'avviso sulle linee che non dicono un gestore dell'elenco; null se non ce ne sono o se il gestore è uno solo. */
export function avvisoSenzaGestore(e: Pick<ElencoGestori, "gestori" | "lineeSenzaGestore">): string | null {
  if (e.gestori.length < 2 || e.lineeSenzaGestore === 0) return null;
  const p = e.gestori.find((g) => g.predefinito) ?? e.gestori[0]!;
  return e.lineeSenzaGestore === 1
    ? `Una linea dei programmi non ha un gestore dell'elenco e per ora è di ${p.nome}: si assegna in Planning Studio, dalla pagina della rete.`
    : `${e.lineeSenzaGestore} linee dei programmi non hanno un gestore dell'elenco e per ora sono di ${p.nome}: si assegnano in Planning Studio, dalla pagina della rete.`;
}

/** Che cosa chiedere prima di togliere un gestore. */
export function domandaTogli(g: GestoreConLinee, elenco: readonly GestoreConLinee[]): string {
  const p = elenco.find((x) => x.predefinito && x.gestore !== g.gestore);
  if (g.linee === 0) return `Tolgo ${g.nome}?`;
  return p
    ? `${g.nome} ha ${linee(g.linee)} nei programmi. Se lo tolgo, quelle linee passano a ${p.nome} finché non le assegni a un altro. Lo tolgo?`
    : `${g.nome} ha ${linee(g.linee)} nei programmi. È l'ultimo gestore: tolto lui, nei GTFS torna l'azienda per tutte le linee. Lo tolgo?`;
}

/* ── Le linee di un programma (Planning Studio) ───────────────────────────── */

export interface LineaColGestore {
  id: string;
  shortName: string;
  longName: string | null;
  /** quello che la linea dice: può non essere nell'elenco */
  detto: string | null;
  /** il gestore che vale: il suo, o il predefinito; null se non ci sono gestori */
  gestore: string | null;
  /** false se vale il predefinito perché la linea non ne dice uno dell'elenco */
  assegnato: boolean;
}

export interface GestoriDelProgramma {
  gestori: Array<Pick<Gestore, "gestore" | "nome" | "predefinito">>;
  linee: LineaColGestore[];
  puoScrivere: boolean;
}

/** Il filtro del riquadro: tutte, quelle senza un gestore loro, o quelle di un gestore. */
export type FiltroGestore = "tutte" | "senza" | { gestore: string };

/** Le linee che passano il filtro e la ricerca (nel codice e nel nome). */
export function lineeFiltrate(tutte: readonly LineaColGestore[], filtro: FiltroGestore, cerca: string): LineaColGestore[] {
  const q = cerca.trim().toLowerCase();
  return tutte.filter((l) => {
    if (filtro === "senza" && l.assegnato) return false;
    if (typeof filtro === "object" && !(l.assegnato && l.gestore === filtro.gestore)) return false;
    return !q || l.shortName.toLowerCase().includes(q) || (l.longName ?? "").toLowerCase().includes(q);
  });
}

/** Quante linee ha ogni gestore nel programma (solo quelle assegnate a lui), e quante sono senza un gestore loro. */
export function conteggi(d: Pick<GestoriDelProgramma, "gestori" | "linee">): { perGestore: Record<string, number>; senza: number } {
  const perGestore: Record<string, number> = Object.fromEntries(d.gestori.map((g) => [g.gestore, 0]));
  let senza = 0;
  for (const l of d.linee) {
    if (l.assegnato && l.gestore) perGestore[l.gestore] = (perGestore[l.gestore] ?? 0) + 1;
    else senza++;
  }
  return { perGestore, senza };
}

/** Il nome del gestore di una linea, come si legge nella tabella. */
export function nomeDelGestore(l: LineaColGestore, gestori: GestoriDelProgramma["gestori"]): string {
  const g = gestori.find((x) => x.gestore === l.gestore);
  if (!g) return "—";
  if (l.assegnato) return g.nome;
  return l.detto ? `${g.nome} (predefinito: «${l.detto}» non è fra i gestori)` : `${g.nome} (predefinito)`;
}

/** Che cosa dire dopo un'assegnazione. */
export function esitoAssegnazione(cambiate: number, scelte: number, nome: string | null): string {
  const a = nome ? `a ${nome}` : "al predefinito";
  if (cambiate === 0) return scelte === 1 ? `La linea era già assegnata ${a}.` : `Le ${scelte} linee erano già assegnate ${a}.`;
  const altre = scelte - cambiate;
  return `${cambiate === 1 ? "Una linea assegnata" : `${cambiate} linee assegnate`} ${a}${altre > 0 ? `; ${altre === 1 ? "una lo era già" : `${altre} lo erano già`}` : ""}.`;
}
