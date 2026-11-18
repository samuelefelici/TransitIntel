/**
 * I nodi di scambio dell'azienda (tappa 6.16): stazioni, porti, aeroporti e
 * parcheggi scambiatori, con gli orari stimati di arrivi e partenze. I tipi
 * dell'API /api/admin/nodi-scambio e il modulo della scheda in
 * Amministrazione › Azienda. Gli orari si scrivono come testo, una riga per
 * provenienza o destinazione: «Roma (FR): 06:10 07:35 08:55».
 * Senza React: si prova da solo.
 */
import { numeroScritto } from "./territorio";

export type TipoNodo = "railway" | "port" | "airport" | "park-ride";
export const TIPI_NODO: Array<[TipoNodo, string]> = [
  ["railway", "Stazione"], ["port", "Porto"], ["airport", "Aeroporto"], ["park-ride", "Parcheggio scambiatore"],
];
export const nomeDelTipo = (t: TipoNodo): string => TIPI_NODO.find(([x]) => x === t)?.[1] ?? t;

export interface Corse { luogo: string; orari: string[] }

export interface NodoDiScambio {
  nodo: string; nome: string; tipo: TipoNodo; lat: number; lng: number;
  fermateGtfs: string[]; minutiAPiedi: number; descrizione: string;
  arrivi: Corse[]; partenze: Corse[]; ordine: number;
}
/** Un nodo dell'elenco con le zone di coincidenza che lo ricordano. */
export interface NodoConZone extends NodoDiScambio { zone: number }
export interface ElencoNodi { nodi: NodoConZone[]; massimo: number }

/** Quante corse stimate ha un nodo, fra arrivi e partenze. */
export const corseStimate = (n: Pick<NodoDiScambio, "arrivi" | "partenze">): number =>
  [...n.arrivi, ...n.partenze].reduce((s, c) => s + c.orari.length, 0);

/* ── Gli orari come testo ─────────────────────────────────────────────────── */

/** «6:10» → «06:10»; null se non è un orario fra 00:00 e 47:59. La stessa regola dell'API. */
export function orarioNormale(s: string): string | null {
  const m = /^([0-9]{1,2}):([0-5][0-9])$/.exec(s.trim());
  if (!m || Number(m[1]) > 47) return null;
  return `${m[1]!.padStart(2, "0")}:${m[2]}`;
}

/** Le corse come testo: una riga per luogo, «luogo: HH:MM HH:MM». */
export const testoDegliOrari = (corse: readonly Corse[]): string =>
  corse.map((c) => `${c.luogo}: ${c.orari.join(" ")}`).join("\n");

/**
 * Il testo di una casella degli orari: una riga per luogo, il luogo prima dei
 * due punti e gli orari dopo, separati da spazi o virgole. Le righe vuote non
 * contano. Gli orari si mettono in ordine, senza doppioni.
 */
export function orariDalTesto(testo: string): { corse: Corse[]; errori: string[] } {
  const corse: Corse[] = [], errori: string[] = [];
  testo.split("\n").forEach((riga, i) => {
    if (!riga.trim()) return;
    const dove = `riga ${i + 1}`;
    /* i due punti che chiudono il luogo: i primi che non stanno fra due cifre (quelli sono di un orario) */
    const due = [...riga].findIndex((c, k) => c === ":" && !(/[0-9]/.test(riga[k - 1] ?? "") && /[0-9]/.test(riga[k + 1] ?? "")));
    const luogo = due < 0 ? "" : riga.slice(0, due).trim();
    if (!luogo) { errori.push(`${dove}: prima dei due punti va il luogo, come «Roma: 06:10 07:35»`); return; }
    if (luogo.length > 80) { errori.push(`${dove}: il luogo ha al più 80 caratteri`); return; }
    const scritti = riga.slice(due + 1).split(/[\s,;]+/).filter(Boolean);
    const sbagliati = scritti.filter((o) => !orarioNormale(o));
    if (sbagliati.length) { errori.push(`${dove}: «${sbagliati[0]}» non è un orario (HH:MM, da 00:00 a 47:59)`); return; }
    if (!scritti.length) { errori.push(`${dove}: dopo «${luogo}:» manca almeno un orario`); return; }
    if (scritti.length > 300) { errori.push(`${dove}: al più 300 orari per riga`); return; }
    corse.push({ luogo, orari: [...new Set(scritti.map((o) => orarioNormale(o)!))].sort() });
  });
  if (corse.length > 40) errori.push("Al più 40 righe");
  return { corse, errori };
}

/* ── Il modulo di un nodo ─────────────────────────────────────────────────── */

export interface ModuloNodo {
  nodo: string; nome: string; tipo: TipoNodo; lat: string; lng: string; minutiAPiedi: string;
  /** i codici delle fermate GTFS, separati da virgole o spazi */
  fermate: string;
  descrizione: string; arrivi: string; partenze: string; ordine: string;
}

export const moduloVuoto = (): ModuloNodo => ({
  nodo: "", nome: "", tipo: "railway", lat: "", lng: "", minutiAPiedi: "2", fermate: "", descrizione: "", arrivi: "", partenze: "", ordine: "",
});
export const moduloDa = (n: NodoDiScambio): ModuloNodo => ({
  nodo: n.nodo, nome: n.nome, tipo: n.tipo, lat: String(n.lat), lng: String(n.lng), minutiAPiedi: String(n.minutiAPiedi),
  fermate: n.fermateGtfs.join(", "), descrizione: n.descrizione,
  arrivi: testoDegliOrari(n.arrivi), partenze: testoDegliOrari(n.partenze), ordine: String(n.ordine),
});

const fermateDalTesto = (t: string): string[] => [...new Set(t.split(/[\s,;]+/).filter(Boolean))];

/** Che cosa non va, prima di salvare. `gia`: gli identificativi che ci sono (per un nodo nuovo). */
export function erroriNodo(m: ModuloNodo, nuovo: boolean, gia: readonly string[] = []): string[] {
  const e: string[] = [];
  if (nuovo) {
    const id = m.nodo.trim();
    if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(id)) e.push("Identificativo: da 2 a 40 fra lettere minuscole, cifre e trattini, come «stazione-centrale»");
    else if (/^(gtfs|synthetic)-/.test(id)) e.push("Identificativo: «gtfs-» e «synthetic-» sono dei nodi che l'analisi trova da sola");
    else if (gia.includes(id)) e.push(`C'è già un nodo «${id}»`);
  }
  if (!m.nome.trim()) e.push("Il nome va scritto");
  else if (m.nome.trim().length > 120) e.push("Nome: al più 120 caratteri");
  const lat = numeroScritto(m.lat), lng = numeroScritto(m.lng), min = numeroScritto(m.minutiAPiedi), o = numeroScritto(m.ordine);
  if (lat == null || !(lat >= -90 && lat <= 90)) e.push("Latitudine: un numero fra -90 e 90");
  if (lng == null || !(lng >= -180 && lng <= 180)) e.push("Longitudine: un numero fra -180 e 180");
  if (min == null || !(Number.isInteger(min) && min >= 0 && min <= 60)) e.push("Minuti a piedi: un numero intero da 0 a 60");
  if (o != null && !(Number.isInteger(o) && o >= 0 && o <= 99999)) e.push("Ordine: un numero intero");
  if (m.descrizione.trim().length > 300) e.push("Descrizione: al più 300 caratteri");
  if (fermateDalTesto(m.fermate).length > 50) e.push("Al più 50 fermate GTFS");
  for (const [casella, nome] of [["arrivi", "Arrivi"], ["partenze", "Partenze"]] as const) {
    for (const x of orariDalTesto(m[casella]).errori) e.push(`${nome}, ${x}`);
  }
  return e;
}

/** Il corpo per l'API; per un nodo nuovo anche l'identificativo. */
export function corpoNodo(m: ModuloNodo, nuovo: boolean) {
  return {
    ...(nuovo ? { nodo: m.nodo.trim() } : {}),
    nome: m.nome.trim(), tipo: m.tipo, lat: numeroScritto(m.lat), lng: numeroScritto(m.lng),
    fermateGtfs: fermateDalTesto(m.fermate), minutiAPiedi: numeroScritto(m.minutiAPiedi) ?? 2,
    descrizione: m.descrizione.trim(),
    arrivi: orariDalTesto(m.arrivi).corse, partenze: orariDalTesto(m.partenze).corse,
    ordine: numeroScritto(m.ordine) ?? 0,
  };
}

/** La domanda prima di togliere un nodo: le zone che lo ricordano restano, ma perdono i suoi orari. */
export function domandaTogli(n: Pick<NodoConZone, "nome" | "zone">): string {
  const zone = n.zone === 0 ? ""
    : n.zone === 1 ? " Una zona di coincidenza lo ricorda: resta com'è, ma senza orari suoi perde quelli stimati del nodo."
    : ` ${n.zone} zone di coincidenza lo ricordano: restano come sono, ma quelle senza orari loro perdono quelli stimati del nodo.`;
  return `Togliere «${n.nome}»?${zone}`;
}
