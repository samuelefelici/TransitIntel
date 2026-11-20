/**
 * La polimetrica della bigliettazione, per confrontarla con quella generata
 * nella pagina Polimetriche (tappa 6.34, migrazione 0055).
 *
 * Entra da due file CSV in un formato che non dipende dal sistema di
 * bigliettazione da cui escono (le query per ricavarli stanno nel DEPLOY):
 *
 *   punti       linea, percorso, direzione, ordine, codice, nome, nodo, km
 *               i punti tariffari di ogni linea, nell'ordine, col km
 *               progressivo; `nodo` è il nodo tariffario a cui la località fa
 *               capo (vuoto: è lei stessa)
 *   polimetrica linea, percorso, direzione, da, a, km, tariffario, fascia, forzata
 *               una riga per coppia di nodi; percorso e direzione vuoti: la
 *               riga vale per ogni percorso e direzione della linea
 *
 * Intestazione obbligatoria; colonne in qualunque ordine, quelle in più si
 * ignorano; separatore virgola o punto e virgola; i decimali col punto o con
 * la virgola. Solo rete e tariffe: nessun dato di persone.
 *
 * Qui stanno la lettura dei file e la proposta di abbinamento fra le linee
 * della bigliettazione e quelle dell'azienda. Niente database: si collauda
 * da solo. Le scritture stanno in polimetrica-ufficiale-store.ts.
 */
import { parse } from "csv-parse/sync";

/** Un punto tariffario di una linea della bigliettazione. */
export interface PuntoUfficiale {
  linea: string; percorso: string; direzione: string; ordine: number;
  codice: string; nome: string | null; nodo: string | null; km: number;
}

/** Una riga della polimetrica della bigliettazione: la coppia di nodi, i km e la fascia. */
export interface RigaUfficiale {
  linea: string; percorso: string; direzione: string; da: string; a: string;
  km: number | null; tariffario: string | null; fascia: number | null; forzata: boolean;
}

export const MASSIMO_PUNTI = 100_000;
export const MASSIMO_RIGHE = 500_000;
const MASSIMO_ERRORI = 5;

export interface Lettura<T> {
  righe: T[];
  /** righe lasciate fuori senza che sia un errore (punti senza km), con il motivo */
  saltate: number;
  /** i problemi che fermano il caricamento, col numero di riga del file */
  errori: string[];
}

/** Toglie i caratteri di controllo e gli spazi ai lati. */
const pulito = (v: unknown): string => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim();

/** Un numero col punto o con la virgola dei decimali; null se vuoto, NaN se non è un numero. */
function numero(v: string): number | null {
  if (v === "") return null;
  const t = /^\d+,\d+$/.test(v) ? v.replace(",", ".") : v;
  return /^\d+(\.\d+)?$/.test(t) ? Number(t) : Number.NaN;
}

const VERO = new Set(["true", "1", "si", "sì", "vero", "y", "yes", "s"]);
const FALSO = new Set(["", "false", "0", "no", "falso", "n"]);

/**
 * Le righe di un CSV come oggetti, con i nomi delle colonne in minuscolo.
 * Il separatore è quello che compare di più nell'intestazione.
 */
function righeCsv(testo: string): { colonne: string[]; righe: Record<string, string>[] } | { errore: string } {
  const senzaBom = testo.replace(/^\uFEFF/, "");
  const intestazione = senzaBom.split(/\r?\n/, 1)[0] ?? "";
  const separatore = (intestazione.match(/;/g)?.length ?? 0) > (intestazione.match(/,/g)?.length ?? 0) ? ";" : ",";
  let colonne: string[] = [];
  try {
    const righe = parse(senzaBom, {
      columns: (h: string[]) => (colonne = h.map((c) => pulito(c).toLowerCase())),
      delimiter: separatore, skip_empty_lines: true, trim: true, relax_column_count: true,
    }) as Record<string, string>[];
    return { colonne, righe };
  } catch {
    return { errore: "il file non si legge come CSV (virgolette non chiuse?)" };
  }
}

/** Raccoglie al più cinque problemi, poi li conta soltanto. */
function raccolta() {
  const errori: string[] = [];
  let altri = 0;
  return {
    aggiungi(riga: number, testo: string) { if (errori.length < MASSIMO_ERRORI) errori.push(`riga ${riga}: ${testo}`); else altri++; },
    tutti: () => (altri ? [...errori, `…e altre ${altri} righe che non vanno`] : errori),
    quanti: () => errori.length + altri,
  };
}

/** Un testo obbligatorio di al più `max` caratteri: pulito, o null dopo aver segnato che cosa non va. */
function obbligato(v: unknown, cosa: string, max: number, riga: number, e: ReturnType<typeof raccolta>): string | null {
  const t = pulito(v);
  if (!t) { e.aggiungi(riga, `manca ${cosa}`); return null; }
  if (t.length > max) { e.aggiungi(riga, `${cosa} è più lungo di ${max} caratteri`); return null; }
  return t;
}

const mancano = (colonne: string[], attese: readonly string[]): string | null => {
  const m = attese.filter((c) => !colonne.includes(c));
  return m.length ? `${m.length === 1 ? "manca la colonna" : "mancano le colonne"} ${m.map((c) => `«${c}»`).join(", ")} (le colonne sono: ${attese.join(", ")})` : null;
};

export const COLONNE_PUNTI = ["linea", "percorso", "direzione", "ordine", "codice", "nome", "nodo", "km"] as const;
export const COLONNE_RIGHE = ["linea", "percorso", "direzione", "da", "a", "km", "tariffario", "fascia", "forzata"] as const;

/** Il file dei punti tariffari. Un punto senza km non entra (lo si conta fra i saltati). */
export function leggiCsvPunti(csv: string): Lettura<PuntoUfficiale> {
  const letto = righeCsv(csv);
  if ("errore" in letto) return { righe: [], saltate: 0, errori: [letto.errore] };
  const manca = mancano(letto.colonne, COLONNE_PUNTI.filter((c) => c !== "nome" && c !== "nodo"));
  if (manca) return { righe: [], saltate: 0, errori: [manca] };
  if (letto.righe.length > MASSIMO_PUNTI) return { righe: [], saltate: 0, errori: [`più di ${MASSIMO_PUNTI.toLocaleString("it-IT")} righe: non sembra un elenco di punti tariffari`] };

  const righe: PuntoUfficiale[] = [];
  const e = raccolta();
  const viste = new Map<string, number>();
  let saltate = 0;
  letto.righe.forEach((r, i) => {
    const n = i + 2;
    const linea = obbligato(r.linea, "la linea", 40, n, e); if (linea == null) return;
    const percorso = obbligato(r.percorso, "il percorso", 40, n, e); if (percorso == null) return;
    const direzione = obbligato(r.direzione, "la direzione", 10, n, e); if (direzione == null) return;
    const codice = obbligato(r.codice, "il codice del punto", 40, n, e); if (codice == null) return;
    const ordine = numero(pulito(r.ordine));
    if (ordine == null || !Number.isInteger(ordine) || ordine < 1 || ordine > 100_000) { e.aggiungi(n, "l'ordine è un numero intero da 1 in su"); return; }
    const km = numero(pulito(r.km));
    if (km == null) { saltate++; return; }
    if (Number.isNaN(km) || km > 2000) { e.aggiungi(n, `i km «${pulito(r.km).slice(0, 20)}» non sono un numero fra 0 e 2000`); return; }
    const nodo = pulito(r.nodo);
    if (nodo.length > 40) { e.aggiungi(n, "il nodo è più lungo di 40 caratteri"); return; }
    const punto: PuntoUfficiale = {
      linea: linea.toUpperCase(), percorso, direzione, ordine, codice,
      nome: pulito(r.nome).slice(0, 200) || null, nodo: nodo || null, km: Math.round(km * 1000) / 1000,
    };
    const chiave = `${punto.linea}\u0000${punto.percorso}\u0000${punto.direzione}\u0000${punto.ordine}`;
    const prima = viste.get(chiave);
    if (prima !== undefined) { e.aggiungi(n, `il punto ${punto.ordine} della linea ${punto.linea} (percorso ${punto.percorso}, direzione ${punto.direzione}) c'è già alla riga ${prima}`); return; }
    viste.set(chiave, n);
    righe.push(punto);
  });
  if (!e.quanti() && !righe.length) return { righe: [], saltate, errori: ["il file non ha nessun punto tariffario con i suoi km"] };
  return { righe: e.quanti() ? [] : righe, saltate, errori: e.tutti() };
}

/** Il file della polimetrica: una riga per coppia di nodi. */
export function leggiCsvRighe(csv: string): Lettura<RigaUfficiale> {
  const letto = righeCsv(csv);
  if ("errore" in letto) return { righe: [], saltate: 0, errori: [letto.errore] };
  const manca = mancano(letto.colonne, COLONNE_RIGHE.filter((c) => c !== "tariffario" && c !== "forzata"));
  if (manca) return { righe: [], saltate: 0, errori: [manca] };
  if (letto.righe.length > MASSIMO_RIGHE) return { righe: [], saltate: 0, errori: [`più di ${MASSIMO_RIGHE.toLocaleString("it-IT")} righe: non sembra una polimetrica`] };

  const righe: RigaUfficiale[] = [];
  const e = raccolta();
  const viste = new Map<string, number>();
  letto.righe.forEach((r, i) => {
    const n = i + 2;
    const linea = obbligato(r.linea, "la linea", 40, n, e); if (linea == null) return;
    /* percorso e direzione possono mancare: la riga vale per tutti */
    const percorso = pulito(r.percorso), direzione = pulito(r.direzione);
    if (percorso.length > 40) { e.aggiungi(n, "il percorso è più lungo di 40 caratteri"); return; }
    if (direzione.length > 10) { e.aggiungi(n, "la direzione è più lunga di 10 caratteri"); return; }
    const da = obbligato(r.da, "il nodo di partenza", 40, n, e); if (da == null) return;
    const a = obbligato(r.a, "il nodo di arrivo", 40, n, e); if (a == null) return;
    const km = numero(pulito(r.km));
    if (km != null && (Number.isNaN(km) || km > 2000)) { e.aggiungi(n, `i km «${pulito(r.km).slice(0, 20)}» non sono un numero fra 0 e 2000`); return; }
    const fascia = numero(pulito(r.fascia));
    if (fascia != null && (!Number.isInteger(fascia) || fascia > 999)) { e.aggiungi(n, `la fascia «${pulito(r.fascia).slice(0, 20)}» non è un numero intero fra 0 e 999`); return; }
    const tariffario = pulito(r.tariffario);
    if (tariffario.length > 40) { e.aggiungi(n, "il tariffario è più lungo di 40 caratteri"); return; }
    const forzata = pulito(r.forzata).toLowerCase();
    if (!VERO.has(forzata) && !FALSO.has(forzata)) { e.aggiungi(n, `«forzata» vale vero o falso (qui «${forzata.slice(0, 20)}»)`); return; }
    const riga: RigaUfficiale = {
      linea: linea.toUpperCase(), percorso, direzione, da, a,
      km: km == null ? null : Math.round(km * 1000) / 1000, tariffario: tariffario || null, fascia, forzata: VERO.has(forzata),
    };
    const chiave = `${riga.linea}\u0000${riga.percorso}\u0000${riga.direzione}\u0000${riga.da}\u0000${riga.a}`;
    const prima = viste.get(chiave);
    if (prima !== undefined) { e.aggiungi(n, `la coppia ${riga.da} → ${riga.a} della linea ${riga.linea} (percorso ${riga.percorso || "tutti"}, direzione ${riga.direzione || "tutte"}) c'è già alla riga ${prima}`); return; }
    viste.set(chiave, n);
    righe.push(riga);
  });
  if (!e.quanti() && !righe.length) return { righe: [], saltate: 0, errori: ["il file non ha nessuna riga di polimetrica"] };
  return { righe: e.quanti() ? [] : righe, saltate: 0, errori: e.tutti() };
}

/* ── L'abbinamento delle linee ──────────────────────────────────────────────
 * Una linea della bigliettazione e una dell'azienda sono la stessa quando i
 * punti tariffari della prima si ritrovano fra le fermate della seconda: per
 * codice (la località e la fermata hanno lo stesso numero) o per nome. */

/** Un codice come si confronta: maiuscolo, e senza gli zeri davanti se è un numero («051» e «51»). */
export function normaCodice(c: string): string {
  const t = c.trim().toUpperCase();
  return /^\d+$/.test(t) ? t.replace(/^0+(?=\d)/, "") : t;
}

/** Le parole che non distinguono un luogo da un altro. */
const PAROLE_VUOTE = new Set([
  "VIA", "VIALE", "PIAZZA", "PIAZZALE", "CORSO", "LARGO", "STRADA", "BIVIO", "INCROCIO", "INCR", "INC", "CAPOLINEA", "FERMATA",
  "DI", "DEL", "DELLA", "DELLE", "DEI", "DEGLI", "DA", "A", "AL", "ALLA", "E", "IL", "LA", "LE", "LO", "IN", "SU", "PER", "CON",
  "S", "SAN", "SANTA", "SANTO", "SS", "V", "P", "M", "N", "KM",
]);

/** Le parole di un nome che contano, in maiuscolo: «Via Roma (Chiesa)» → ROMA, CHIESA. */
export function paroleDelNome(nome: string | null | undefined): string[] {
  const parole = (nome ?? "").toUpperCase().normalize("NFD").replace(/[̀-ͯ]/g, "").split(/[^A-Z0-9]+/).filter((p) => p && !PAROLE_VUOTE.has(p));
  return [...new Set(parole)];
}

/** Una linea dell'azienda con le sue fermate: quello che serve per ritrovarci i punti. */
export interface LineaAzienda { codice: string; nome: string; fermate: readonly { codice: string; nome: string }[] }

/** I punti distinti di una linea della bigliettazione (un punto compare in più percorsi e direzioni). */
export interface PuntoDaRitrovare { codice: string; nome: string | null }

/**
 * Quanti punti di una linea della bigliettazione si ritrovano fra le fermate
 * di ogni linea dell'azienda: stesso codice, oppure tutte le parole del nome
 * del punto nel nome di una fermata.
 */
export function puntiRitrovati(punti: readonly PuntoDaRitrovare[], linee: readonly LineaAzienda[]): { linea: string; trovati: number }[] {
  const attesi = punti.map((p) => ({ codice: normaCodice(p.codice), parole: paroleDelNome(p.nome) }));
  return linee.map((l) => {
    const codici = new Set(l.fermate.map((f) => normaCodice(f.codice)));
    const nomi = l.fermate.map((f) => new Set(paroleDelNome(f.nome)));
    const trovati = attesi.filter((p) => codici.has(p.codice) || (p.parole.length > 0 && nomi.some((n) => p.parole.every((w) => n.has(w))))).length;
    return { linea: l.codice, trovati };
  }).filter((x) => x.trovati > 0).sort((a, b) => b.trovati - a.trovati || a.linea.localeCompare(b.linea, "it", { numeric: true }));
}

export interface Candidate {
  /** le linee dell'azienda dove si ritrovano più punti, al più tre */
  candidate: { linea: string; trovati: number }[];
  /** la linea da proporre, se una spicca; chi abbina la conferma o la cambia */
  proposta: string | null;
  /** perché è proposta: ha lo stesso codice, o ci si ritrovano quasi tutti i punti */
  motivo: "codice" | "punti" | null;
}

/**
 * Le linee dell'azienda candidate per una linea della bigliettazione, e la
 * proposta. Si propone la linea con lo stesso codice; altrimenti quella dove
 * si ritrovano almeno 7 punti su 10 (e almeno 3), con almeno 2 punti di
 * distacco dalla seconda. Sotto, nessuna proposta: si sceglie a mano.
 */
export function candidateDellaLinea(lineaUfficiale: string, punti: readonly PuntoDaRitrovare[], linee: readonly LineaAzienda[]): Candidate {
  const distinti = [...new Map(punti.map((p) => [normaCodice(p.codice), p])).values()];
  const ritrovati = puntiRitrovati(distinti, linee);
  const candidate = ritrovati.slice(0, 3);
  const stessa = linee.find((l) => l.codice.trim().toUpperCase() === lineaUfficiale.trim().toUpperCase());
  if (stessa) return { candidate, proposta: stessa.codice, motivo: "codice" };
  const [prima, seconda] = ritrovati;
  const n = distinti.length;
  if (prima && n >= 3 && prima.trovati >= 3 && prima.trovati * 10 >= n * 7 && prima.trovati - (seconda?.trovati ?? 0) >= 2) {
    return { candidate, proposta: prima.linea, motivo: "punti" };
  }
  return { candidate, proposta: null, motivo: null };
}

/* ── I punti tariffari sulle fermate (tappa 6.34b) ──────────────────────────
 * Un percorso di una linea della bigliettazione corrisponde a un percorso
 * dell'azienda, e ogni suo punto tariffario a una fermata di quel percorso.
 * Qui la proposta: i punti si ritrovano nell'ordine, per codice e poi per
 * nome. Chi lavora alle tariffe la conferma o la corregge. */

/** AB: le fermate nell'ordine del percorso; BA: al contrario, coi km contati dall'altro capo. */
export type Verso = "AB" | "BA";

/** Una fermata di un percorso dell'azienda, col suo km dal capolinea. */
export interface FermataPercorso { stopId: string; nome: string; km: number }

/** Come si è ritrovato un punto: stesso codice della fermata, o stesso nome. */
export type Come = "codice" | "nome";

/** Un punto della bigliettazione e la fermata che gli corrisponde (null: nessuna). */
export interface PuntoAbbinato { ordine: number; fermata: string | null; come: Come | null }

/** Le fermate di un percorso lette nel verso scelto. */
export function fermateNelVerso(fermate: readonly FermataPercorso[], verso: Verso): FermataPercorso[] {
  if (verso === "AB") return fermate.map((f) => ({ ...f }));
  const totale = fermate.length ? fermate[fermate.length - 1]!.km : 0;
  return [...fermate].reverse().map((f) => ({ ...f, km: Math.round((totale - f.km) * 1000) / 1000 }));
}

/**
 * Fra le coppie (punto, fermata) possibili, la catena più lunga in cui
 * crescono tutti e due: i punti si ritrovano nell'ordine in cui il bus li
 * incontra, anche se un codice compare due volte nel percorso.
 */
function catenaPiuLunga(coppie: readonly (readonly [number, number])[]): [number, number][] {
  const ord = [...coppie].sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const lunga = ord.map(() => 1), prima = ord.map(() => -1);
  let fine = -1;
  for (let i = 0; i < ord.length; i++) {
    for (let j = 0; j < i; j++) {
      if (ord[j]![0] < ord[i]![0] && ord[j]![1] < ord[i]![1] && lunga[j]! + 1 > lunga[i]!) { lunga[i] = lunga[j]! + 1; prima[i] = j; }
    }
    if (fine < 0 || lunga[i]! > lunga[fine]!) fine = i;
  }
  const catena: [number, number][] = [];
  for (let i = fine; i >= 0; i = prima[i]!) catena.unshift([ord[i]![0], ord[i]![1]]);
  return catena;
}

/**
 * Abbina i punti tariffari di un percorso della bigliettazione alle fermate
 * di un percorso dell'azienda (già nel verso giusto), nell'ordine:
 * prima per codice; poi, fra un punto abbinato e il successivo, per nome
 * (tutte le parole del nome del punto nel nome della fermata). Se più
 * fermate hanno quel nome (una località ne ha tante) e il punto ha il suo km,
 * vale quella più vicina a dove il punto dovrebbe stare, contando i km della
 * bigliettazione dal punto abbinato accanto; senza km, la prima.
 */
export function abbinaPunti(
  punti: readonly { ordine: number; codice: string; nome: string | null; km?: number }[], fermate: readonly FermataPercorso[],
): PuntoAbbinato[] {
  const codici = fermate.map((f) => normaCodice(f.stopId));
  const coppie: [number, number][] = [];
  punti.forEach((p, i) => { const c = normaCodice(p.codice); codici.forEach((x, k) => { if (x === c) coppie.push([i, k]); }); });
  const esito = new Map<number, { k: number; come: Come }>();
  for (const [i, k] of catenaPiuLunga(coppie)) esito.set(i, { k, come: "codice" });
  const usate = new Set([...esito.values()].map((e) => e.k));
  const nomi = fermate.map((f) => new Set(paroleDelNome(f.nome)));
  punti.forEach((p, i) => {
    if (esito.has(i)) return;
    const parole = paroleDelNome(p.nome);
    if (!parole.length) return;
    /* fra la fermata dell'ultimo punto abbinato prima e quella del primo abbinato dopo */
    let da = -1, a = fermate.length;
    /* dove il punto dovrebbe stare: i suoi km contati dal punto abbinato prima, o da quello dopo */
    let atteso: number | null = null;
    for (let j = i - 1; j >= 0; j--) {
      const e = esito.get(j);
      if (e) { da = e.k; if (p.km != null && punti[j]!.km != null) atteso = fermate[e.k]!.km + (p.km - punti[j]!.km!); break; }
    }
    for (let j = i + 1; j < punti.length; j++) {
      const e = esito.get(j);
      if (e) { a = e.k; if (atteso == null && p.km != null && punti[j]!.km != null) atteso = fermate[e.k]!.km - (punti[j]!.km! - p.km); break; }
    }
    let scelta = -1;
    for (let k = da + 1; k < a; k++) {
      if (usate.has(k) || !parole.every((w) => nomi[k]!.has(w))) continue;
      if (atteso == null) { scelta = k; break; }
      if (scelta < 0 || Math.abs(fermate[k]!.km - atteso) < Math.abs(fermate[scelta]!.km - atteso)) scelta = k;
    }
    if (scelta >= 0) { esito.set(i, { k: scelta, come: "nome" }); usate.add(scelta); }
  });
  return punti.map((p, i) => {
    const e = esito.get(i);
    return { ordine: p.ordine, fermata: e ? fermate[e.k]!.stopId : null, come: e?.come ?? null };
  });
}

/** Un percorso dell'azienda: la linea dei GTFS, la variante, quante corse lo fanno e le fermate nell'ordine AB. */
export interface PercorsoAzienda { routeId: string; variantId: string; corse: number; fermate: readonly FermataPercorso[] }

/** Un percorso dell'azienda candidato per un percorso della bigliettazione, con i punti che ci si ritrovano. */
export interface PercorsoCandidato {
  routeId: string; variantId: string; verso: Verso; trovati: number;
  /** di quanti km, in media, i punti ritrovati si scostano dai km della bigliettazione (contati dal primo punto ritrovato) */
  scarto: number;
  punti: PuntoAbbinato[];
}

/** Lo scarto medio in km fra i punti ritrovati e le loro fermate, contando tutti e due dal primo punto ritrovato. */
function scartoMedio(punti: readonly { ordine: number; km?: number }[], abbinati: readonly PuntoAbbinato[], fermate: readonly FermataPercorso[]): number {
  const scarti: number[] = [];
  let primo: { ufficiale: number; fermata: number } | null = null, dopo = -1;
  for (const [i, a] of abbinati.entries()) {
    const km = punti[i]?.km;
    if (a.fermata == null || km == null) continue;
    const k = fermate.findIndex((f, n) => n > dopo && f.stopId === a.fermata);
    if (k < 0) continue;
    dopo = k;
    primo ??= { ufficiale: km, fermata: fermate[k]!.km };
    scarti.push(Math.abs((fermate[k]!.km - primo.fermata) - (km - primo.ufficiale)));
  }
  return scarti.length ? Math.round((scarti.reduce((x, y) => x + y, 0) / scarti.length) * 1000) / 1000 : 0;
}

/**
 * I percorsi dell'azienda dove si ritrovano i punti di un percorso della
 * bigliettazione, nei due versi, il migliore per primo:
 * - prima i percorsi nel loro verso (AB) che ritrovano quasi tutti i punti
 *   del migliore (almeno 8 su 10): un percorso che va davvero in quella
 *   direzione vale più dell'altro verso letto al contrario, che ha i codici
 *   delle fermate di fronte ma non la stessa strada;
 * - poi chi ritrova più punti; a parità chi ha i km più vicini a quelli
 *   della bigliettazione, poi chi fa più corse.
 * Al più `quanti`; quelli senza nessun punto restano fuori.
 */
export function percorsiCandidati(
  punti: readonly { ordine: number; codice: string; nome: string | null; km?: number }[], percorsi: readonly PercorsoAzienda[], quanti = 5,
): PercorsoCandidato[] {
  const tutti: (PercorsoCandidato & { corse: number })[] = [];
  for (const p of percorsi) {
    for (const verso of ["AB", "BA"] as const) {
      const fermate = fermateNelVerso(p.fermate, verso);
      const abbinati = abbinaPunti(punti, fermate);
      const trovati = abbinati.filter((x) => x.fermata != null).length;
      if (trovati > 0) tutti.push({ routeId: p.routeId, variantId: p.variantId, verso, trovati, scarto: scartoMedio(punti, abbinati, fermate), punti: abbinati, corse: p.corse });
    }
  }
  const soglia = Math.ceil(Math.max(0, ...tutti.map((c) => c.trovati)) * 0.8);
  const nelSuoVerso = (c: PercorsoCandidato) => (c.verso === "AB" && c.trovati >= soglia ? 0 : 1);
  tutti.sort((x, y) => nelSuoVerso(x) - nelSuoVerso(y) || y.trovati - x.trovati || x.scarto - y.scarto || y.corse - x.corse
    || x.routeId.localeCompare(y.routeId) || x.variantId.localeCompare(y.variantId) || x.verso.localeCompare(y.verso));
  return tutti.slice(0, quanti).map(({ corse: _corse, ...c }) => c);
}
