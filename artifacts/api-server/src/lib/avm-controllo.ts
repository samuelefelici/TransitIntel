/**
 * ═══════════════════════════════════════════════════════════════════════════
 * IL CONTROLLO SETTIMANALE DELL'AVM — chi ha ripreso, chi si è fermato
 * ───────────────────────────────────────────────────────────────────────────
 * Il diario dice com'è andato ogni apparato in un periodo. Mentre l'officina
 * e Mizar rimettono a posto gli apparati, la domanda cambia: rispetto alla
 * settimana prima, quali hanno RIPRESO a funzionare e quali si sono ROTTI?
 * È una domanda di confronto, e la risposta si scrive una volta a settimana.
 *
 * Il metro è l'apparato, non il servizio: una vettura «funziona» in una
 * settimana se si è LOCALIZZATA almeno in una giornata contata. La corsa
 * dipende dal conducente che qualifica il turno a bordo, quindi si riporta
 * accanto ma non decide la categoria.
 *
 * La settimana è lunedì–domenica di giornate di esercizio (taglio alle 03:00,
 * fuso di esercizio), identificata dal suo lunedì. Una giornata conta solo
 * con almeno mezza raccolta e solo quando è finita (oggi non conta mai), come
 * nel diario: un buco del connettore non è un apparato rotto. Una settimana
 * si giudica solo con almeno GIORNATE_MINIME giornate contate: con una o due
 * giornate un mezzo rimasto in rimessa la domenica diventa «si è fermata».
 *
 * «Prima» non è per forza la settimana precedente: è l'ultima settimana in
 * cui la vettura si poteva giudicare. Se il connettore è stato fermo tutta la
 * settimana scorsa, il confronto si fa con quella prima ancora, invece di
 * dichiarare «non giudicabile» mezzo parco.
 *
 * Funzioni pure: niente database, niente rete (vedi __tests__/avm-controllo.test.ts).
 * ═══════════════════════════════════════════════════════════════════════════
 */
import {
  esclusioneOfficina, CAMPIONI_MINIMI_GIORNATA, GIORNATE_MINIME, GIORNI_SMESSA,
  type RigaDiario, type Esclusione,
} from "./avm-diario";
import { identitaVettura } from "./parco-anagrafica";
import { giornateDelPeriodo } from "./fleet-trend";
import { giornataDiIstante } from "./service-day";
import type { MezzoOfficina } from "./officina";

/**
 * Cambia quando cambia il modo di calcolare: resta scritto in ogni istantanea,
 * e l'archivio rifà da sé quelle calcolate con una versione più vecchia.
 * 2: giudizio degli interventi sulla finestra dall'apertura, oggi non conta,
 *    prima settimana del diario non giudicabile, almeno 3 giornate contate.
 */
export const VERSIONE_CONTROLLO = 2;

/** Quante settimane si guardano all'indietro, compresa quella sotto controllo. */
export const SETTIMANE_STORIA = 8;

/**
 * Giornate con contatto dopo la chiusura di un intervento prima di dire che
 * non è servito. Contano solo le giornate in cui l'apparato ha parlato col
 * centro: un mezzo rimasto spento in rimessa dopo la riparazione non dice
 * niente dell'apparato, e chi legge «senza effetto» richiama l'officina per
 * niente. Dopo una settimana intera si giudica comunque.
 */
export const GIORNATE_DOPO_MINIME = 3;

/* ── Il vocabolario ────────────────────────────────────────────────────────
 * Le strisce viaggiano come stringhe di un carattere per giornata o per
 * settimana: sono leggibili nel JSON, leggere nell'archivio, e la pagina e il
 * foglio Excel ne fanno quadratini colorati. */

/**
 * Lo stato di una vettura in una settimana:
 *   F funziona  — almeno una giornata contata con posizione
 *   P parla     — contatto col centro, mai una posizione
 *   M muta      — elencata, nessun contatto nelle giornate contate
 *   A assente   — non elencata dal flusso SIRI in nessuna giornata contata
 *   . non giudicabile — meno di GIORNATE_MINIME giornate contate
 */
export type StatoSettimana = "F" | "P" | "M" | "A" | ".";

/**
 * Una giornata nella striscia, sull'apparato:
 *   S si localizza ed è su una corsa · T si localizza, senza corsa
 *   C parla col centro senza posizione · M muta
 *   - non elencata · . giornata non contata (connettore fermo o a metà)
 *   ' ' giornata non ancora finita (oggi e i giorni a venire)
 */
export type CarattereGiorno = "S" | "T" | "C" | "M" | "-" | "." | " ";

export type Categoria =
  | "fermata"         // si localizzava, non si localizza più
  | "ripresa"         // non si localizzava, ora sì
  | "guasta"          // non si localizza né prima né ora
  | "nuova"           // prima volta nel flusso, nelle settimane guardate
  | "uscita"          // c'era, questa settimana il flusso non la elenca più
  | "funziona"        // si localizza prima e ora
  | "non_giudicabile";// troppo poche giornate, o niente con cui confrontare

/** L'ordine di lettura: prima le notizie da girare a qualcuno. */
export const ORDINE_CATEGORIE: Categoria[] = [
  "fermata", "ripresa", "guasta", "nuova", "uscita", "funziona", "non_giudicabile",
];

export const ETICHETTE_CATEGORIA: Record<Categoria, { titolo: string; breve: string; perche: string }> = {
  fermata: {
    titolo: "Ha smesso di localizzarsi", breve: "Si è fermata",
    perche: "Nella settimana precedente si localizzava, in questa no. È un guasto nuovo, oppure il mezzo "
      + "è rimasto fermo: la nota dice che cosa fa l'apparato e che cosa sa l'officina.",
  },
  ripresa: {
    titolo: "Ha ripreso a localizzarsi", breve: "Ripresa",
    perche: "Nella settimana precedente non si localizzava, in questa sì: l'intervento ha funzionato, "
      + "oppure il mezzo è tornato in servizio.",
  },
  guasta: {
    titolo: "Ancora non si localizza", breve: "Ancora guasta",
    perche: "Non si localizza né nella settimana precedente né in questa.",
  },
  nuova: {
    titolo: "Nuova nel flusso SIRI", breve: "Nuova",
    perche: "Compare nel flusso SIRI per la prima volta nelle settimane guardate.",
  },
  uscita: {
    titolo: "Uscita dal flusso SIRI", breve: "Uscita",
    perche: "C'era nelle settimane precedenti, in questa il flusso SIRI non la elenca più.",
  },
  funziona: {
    titolo: "Funziona", breve: "Funziona",
    perche: "Si localizza sia nella settimana precedente sia in questa.",
  },
  non_giudicabile: {
    titolo: "Non giudicabile", breve: "Non giudicabile",
    perche: "Troppo poche giornate contate per giudicare, oppure nessuna settimana precedente con cui confrontare.",
  },
};

/** Che cosa ha prodotto un intervento chiuso, misurato sull'apparato. */
export type EsitoIntervento =
  | "riuscito"        // era guasto prima, dopo si localizza
  | "gia_funzionava"  // si localizzava già prima della chiusura
  | "senza_effetto"   // era guasto, dopo continua a non localizzarsi
  | "peggiorato"      // si localizzava prima, dopo no
  | "ricaduta"        // dopo si è localizzato, poi ha smesso di nuovo
  | "senza_confronto" // dopo si localizza, ma prima non c'erano giornate contate
  | "da_verificare"   // troppo poche giornate dopo per dirlo
  | "non_nel_flusso"; // la vettura non compare nel flusso SIRI

export const ORDINE_ESITI_INTERVENTO: EsitoIntervento[] = [
  "riuscito", "ricaduta", "senza_effetto", "peggiorato", "gia_funzionava", "senza_confronto",
  "da_verificare", "non_nel_flusso",
];

export const ETICHETTE_ESITO_INTERVENTO: Record<EsitoIntervento, string> = {
  riuscito: "Riuscito: prima non si localizzava, dopo sì",
  gia_funzionava: "Si localizzava già prima",
  senza_effetto: "Senza effetto: dopo non si localizza",
  peggiorato: "Prima si localizzava, dopo no",
  ricaduta: "Ricaduta: dopo si è localizzata, poi ha smesso di nuovo",
  senza_confronto: "Dopo si localizza; prima nessuna giornata contata per confrontare",
  da_verificare: "Da verificare: troppo poche giornate dopo",
  non_nel_flusso: "La vettura non compare nel flusso SIRI",
};

/** La stessa cosa in minuscolo, da mettere in una frase dopo una virgola. */
const ESITO_IN_FRASE: Record<EsitoIntervento, string> = {
  riuscito: "riuscito, dopo si localizza",
  gia_funzionava: "si localizzava già prima",
  senza_effetto: "senza effetto, dopo non si localizza",
  peggiorato: "prima si localizzava, dopo no",
  ricaduta: "dopo si è localizzata, poi ha smesso di nuovo",
  senza_confronto: "dopo si localizza, ma prima non c'erano giornate contate per confrontare",
  da_verificare: "da verificare, troppo poche giornate dopo",
  non_nel_flusso: "la vettura non compare nel flusso SIRI",
};

/** Un intervento AVM chiuso, come lo restituisce FleetCare. */
export interface InterventoAvm {
  /** matricola SIRI */
  matricola: string;
  fonte: string;
  riferimento: string;
  apertaIl: string | null;
  /** istante di chiusura (ISO) */
  chiusaIl: string;
  descrizione: string | null;
  esito: string | null;
  commessa: string | null;
}

export interface InterventoGiudicato extends InterventoAvm {
  /** la giornata di esercizio della chiusura */
  giornoChiusura: string;
  esitoAvm: EsitoIntervento;
  /** giornate contate guardate prima della chiusura, e quante con posizione */
  giorniPrima: number;
  posizionePrima: number;
  /** se prima della chiusura c'era un tratto senza posizione: il guasto riparato */
  guastoPrima: boolean;
  /** giornate contate dopo la chiusura, quante con contatto e quante con posizione */
  giorniDopo: number;
  giorniDopoConContatto: number;
  posizioneDopo: number;
  /** la prima giornata con posizione dopo la chiusura, se c'è */
  primaPosizioneDopo: string | null;
  /** la prima giornata con posizione dopo il guasto, anche prima della chiusura (commessa chiusa in ritardo) */
  ripresaIl: string | null;
}

export interface SintesiSettimana {
  lunedi: string;
  stato: StatoSettimana;
  giornateOsservate: number;
  conContatto: number;
  conPosizione: number;
  conCorsa: number;
  conErroreGps: number;
}

export interface VetturaControllo {
  vehicleRef: string;
  codice: string | null;
  azienda: string;
  mezzo: string | null;
  categoria: Categoria;
  /** la settimana sotto controllo */
  settimana: SintesiSettimana;
  /** l'ultima settimana giudicabile prima di quella sotto controllo */
  prima: SintesiSettimana | null;
  /** ripresa: prima giornata con posizione; fermata: prima giornata senza */
  dal: string | null;
  /** ultima giornata con posizione nelle settimane guardate */
  ultimaPosizione: string | null;
  /** giornate contate dall'ultima posizione alla fine dei dati; null se mai nella finestra */
  giorniSenzaPosizione: number | null;
  /** 14 caratteri: settimana precedente (di calendario) + settimana sotto controllo */
  giorni: string;
  /** SETTIMANE_STORIA caratteri, dalla più vecchia a quella sotto controllo */
  storia: string;
  officina: MezzoOfficina | null;
  /** solo fuori parco e dismesse: le altre informazioni dell'officina stanno nella nota */
  esclusa: Esclusione | null;
  interventi: InterventoGiudicato[];
  nota: string;
}

export interface SettimanaDelControllo {
  lunedi: string;
  domenica: string;
  giornateOsservate: number;
  giornateParziali: number;
  giornateSenzaDati: number;
  /** giornate non ancora finite: oggi e i giorni a venire, solo per la settimana in corso */
  giornateFuture: number;
}

export interface ControlloSettimanale {
  versione: number;
  generatoIl: string;
  /** la settimana sotto controllo; `chiusa` se la domenica è passata */
  settimana: SettimanaDelControllo & { chiusa: boolean };
  /** la settimana di calendario precedente (quella delle prime 7 giornate della striscia) */
  precedente: SettimanaDelControllo;
  /** le 14 giornate della striscia */
  giornate: string[];
  /** le SETTIMANE_STORIA settimane della storia, dalla più vecchia */
  settimane: SettimanaDelControllo[];
  /** su tutto il flusso: per un perimetro si ricontano con contaCategorie */
  conteggi: Record<Categoria, number>;
  vetture: VetturaControllo[];
  /** gli interventi chiusi nelle settimane guardate, compresi quelli su vetture fuori dal flusso */
  interventi: InterventoGiudicato[];
  /** la frase di sintesi su tutto il flusso: per un perimetro si riscrive con notaGenerale */
  nota: string;
  /** che cosa si è letto dall'officina al momento del calcolo (lo scrive il servizio) */
  officina?: { disponibile: boolean; motivo: string | null; tenant: string | null; lettoAlle: string; mezzi: number } | null;
  /** se gli interventi AVM di FleetCare erano leggibili al momento del calcolo */
  fonteInterventi?: { disponibile: boolean; motivo: string | null } | null;
}

/* ── Le date ──────────────────────────────────────────────────────────────
 * Aritmetica su stringhe "YYYY-MM-DD" a mezzanotte UTC: nessun fuso, nessun
 * cambio d'ora, come giornateDelPeriodo. */

export function spostaGiorni(giorno: string, n: number): string {
  const t = new Date(`${giorno}T00:00:00Z`).getTime() + n * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/** Il lunedì della settimana che contiene la giornata. */
export function lunediDi(giorno: string): string {
  const dow = new Date(`${giorno}T00:00:00Z`).getUTCDay(); // 0 = domenica
  return spostaGiorni(giorno, -((dow + 6) % 7));
}

/** È un lunedì valido ("YYYY-MM-DD")? */
export function eLunedi(giorno: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(giorno)
    && !Number.isNaN(new Date(`${giorno}T00:00:00Z`).getTime())
    && new Date(`${giorno}T00:00:00Z`).toISOString().slice(0, 10) === giorno
    && lunediDi(giorno) === giorno;
}

/** L'ultima settimana chiusa rispetto alla giornata di esercizio di oggi. */
export function ultimaSettimanaChiusa(oggi: string): string {
  return spostaGiorni(lunediDi(oggi), -7);
}

/** Una settimana è chiusa quando la giornata di oggi è oltre la sua domenica. */
export function settimanaChiusa(lunedi: string, oggi: string): boolean {
  return oggi > spostaGiorni(lunedi, 6);
}

/** La prima giornata da leggere nel diario per il controllo della settimana. */
export function inizioFinestra(lunedi: string): string {
  return spostaGiorni(lunedi, -7 * (SETTIMANE_STORIA - 1));
}

export function ddmm(giorno: string | null): string {
  if (!giorno) return "";
  const [, m, g] = giorno.split("-");
  return `${g}/${m}`;
}

/** «1 giornata», «3 giornate». */
function giornate(n: number): string {
  return `${n} ${n === 1 ? "giornata" : "giornate"}`;
}

/* ── Il calcolo ─────────────────────────────────────────────────────────── */

export interface DatiControllo {
  /** righe del diario dal lunedì della prima settimana di storia alla domenica di quella sotto controllo */
  righe: RigaDiario[];
  /** lunedì della settimana sotto controllo */
  lunedi: string;
  /** giornata di esercizio di oggi */
  oggi: string;
  /** parco dell'officina per matricola SIRI, se disponibile e credibile */
  officina?: ReadonlyMap<string, MezzoOfficina> | null;
  /** interventi AVM chiusi (FleetCare), se disponibili */
  interventi?: InterventoAvm[] | null;
  generatoIl?: string;
}

/**
 * La giornata sull'apparato. Non è l'esito del diario: lì una corsa vale più
 * di tutto, anche senza posizione (il codice corsa non dipende dal GPS); qui
 * conta se l'apparato si è localizzato, e la corsa colora solo le giornate
 * in cui si è localizzato.
 */
function carattereGiorno(r: RigaDiario): CarattereGiorno {
  if (r.letturePosizione > 0) return r.lettureCorsa > 0 ? "S" : "T";
  return r.lettureFresche > 0 ? "C" : "M";
}

function vuoti(): Record<Categoria, number> {
  return { fermata: 0, ripresa: 0, guasta: 0, nuova: 0, uscita: 0, funziona: 0, non_giudicabile: 0 };
}

export function contaCategorie(vetture: Pick<VetturaControllo, "categoria">[]): Record<Categoria, number> {
  const c = vuoti();
  for (const v of vetture) c[v.categoria]++;
  return c;
}

/**
 * L'andamento delle settimane guardate, sulle vetture passate: quante
 * funzionavano, parlavano soltanto, tacevano. Si calcola dalle storie, così
 * vale per qualunque perimetro scelga chi legge.
 */
export function andamentoSettimane(
  c: Pick<ControlloSettimanale, "settimane">, vetture: Pick<VetturaControllo, "storia">[],
): Array<SettimanaDelControllo & { F: number; P: number; M: number; A: number }> {
  return c.settimane.map((s, i) => {
    const n = { F: 0, P: 0, M: 0, A: 0 };
    for (const v of vetture) {
      const ch = v.storia[i] as StatoSettimana | undefined;
      if (ch === "F" || ch === "P" || ch === "M" || ch === "A") n[ch]++;
    }
    return { ...s, ...n };
  });
}

/**
 * Il giudizio di un intervento, sulle giornate contate della vettura.
 *
 * «Prima» non sono le sette giornate prima della chiusura: un apparato rotto
 * due giorni prima della riparazione in quelle sette giornate si localizzava
 * ancora, e l'intervento sembrerebbe inutile. Prima è il tratto dall'apertura
 * della segnalazione o della commessa alla chiusura; senza apertura, le sette
 * giornate contate prima. In quel tratto si cerca il guasto: almeno
 * GIORNI_SMESSA giornate di fila senza posizione (o tutto il tratto, se è più
 * corto). Se dopo il guasto la posizione torna, anche prima della chiusura
 * (la commessa chiusa in ritardo), l'intervento è riuscito.
 */
export function giudicaIntervento(
  i: InterventoAvm,
  osservate: string[],
  posizioneIl: (g: string) => boolean,
  contattoIl: (g: string) => boolean = posizioneIl,
  giornoChiusura: string = giornataDiIstante(new Date(i.chiusaIl)),
): InterventoGiudicato {
  const giornoApertura = i.apertaIl ? giornataDiIstante(new Date(i.apertaIl)) : null;
  const precedenti = osservate.filter(g => g < giornoChiusura);
  let prima = giornoApertura && giornoApertura < giornoChiusura
    ? precedenti.filter(g => g >= giornoApertura)
    : [];
  if (prima.length === 0) prima = precedenti.slice(-7);
  const dopo = osservate.filter(g => g > giornoChiusura);

  /* Il guasto: l'ultimo tratto di giornate di fila senza posizione abbastanza lungo. */
  const minimo = Math.min(GIORNI_SMESSA, prima.length);
  let fila = 0;
  let fineGuasto = -1;
  prima.forEach((g, k) => {
    if (posizioneIl(g)) { fila = 0; return; }
    fila++;
    if (minimo > 0 && fila >= minimo) fineGuasto = k;
  });
  const guastoPrima = fineGuasto >= 0;

  const dopoIlGuasto = guastoPrima ? [...prima.slice(fineGuasto + 1), ...dopo] : dopo;
  const conPosizioneDopoGuasto = dopoIlGuasto.filter(posizioneIl);
  const ripresaIl = guastoPrima ? conPosizioneDopoGuasto[0] ?? null : null;
  const conPosDopo = dopo.filter(posizioneIl);
  const conContattoDopo = dopo.filter(contattoIl);
  /* Abbastanza giornate per dire che non va: tre con contatto, o una settimana intera. */
  const abbastanzaDopo = conContattoDopo.length >= GIORNATE_DOPO_MINIME || dopo.length >= 7;

  /* La ricaduta: si è localizzata dopo, poi è tornata zitta per GIORNI_SMESSA giornate. */
  const ultimaDopo = (guastoPrima ? conPosizioneDopoGuasto : conPosDopo).at(-1) ?? null;
  const ricaduta = ultimaDopo != null && dopo.filter(g => g > ultimaDopo).length >= GIORNI_SMESSA;

  const esitoAvm: EsitoIntervento =
    prima.length === 0
      ? (conPosDopo.length ? (ricaduta ? "ricaduta" : "senza_confronto") : abbastanzaDopo ? "senza_effetto" : "da_verificare")
      : guastoPrima
        ? (ripresaIl ? (ricaduta ? "ricaduta" : "riuscito") : abbastanzaDopo ? "senza_effetto" : "da_verificare")
        : (conPosDopo.length ? (ricaduta ? "ricaduta" : "gia_funzionava") : abbastanzaDopo ? "peggiorato" : "da_verificare");

  return {
    ...i, giornoChiusura, esitoAvm,
    giorniPrima: prima.length, posizionePrima: prima.filter(posizioneIl).length, guastoPrima,
    giorniDopo: dopo.length, giorniDopoConContatto: conContattoDopo.length, posizioneDopo: conPosDopo.length,
    primaPosizioneDopo: conPosDopo[0] ?? null, ripresaIl,
  };
}

function dataBreve(iso: string | null): string {
  if (!iso) return "";
  const [a, m, g] = iso.slice(0, 10).split("-");
  return `${g}/${m}/${a}`;
}

/** Il fermo in officina, detto in una frase: è la spiegazione che toglie ogni altra diagnosi. */
function fermoInOfficina(m: MezzoOfficina): string {
  return `Ferma in officina${m.fermoDal ? ` dal ${dataBreve(m.fermoDal)}` : ""}`
    + `${m.fermoMotivo ? ` (${m.fermoMotivo})` : ""}${m.commessa ? `, commessa ${m.commessa}` : ""}: `
    + "il silenzio dell'apparato si spiega col fermo, si riguarda al rientro in servizio.";
}

/** Le altre frasi dell'officina da accodare alla nota, se c'è qualcosa da dire. */
function notaOfficina(m: MezzoOfficina | null, esclusa: Esclusione | null, fermoGiaDetto: boolean): string | null {
  if (esclusa) return esclusa.motivo === "fuori_parco"
    ? "Non è nel parco dell'officina: con ogni probabilità venduta o demolita."
    : "L'officina la dà dismessa.";
  if (!m) return null;
  const pezzi: string[] = [];
  if (m.stato === "in_officina" && !fermoGiaDetto) pezzi.push(fermoInOfficina(m));
  else if (m.stato === "riserva") pezzi.push("Di riserva per l'officina: può essere rimasta in rimessa.");
  if (m.segnalazioneAvm) {
    const s = m.segnalazioneAvm;
    pezzi.push(`Segnalazione AVM aperta in FleetCare: ${s.numero} (${s.fonte}${s.dal ? `, dal ${dataBreve(s.dal)}` : ""}).`);
  }
  return pezzi.length ? pezzi.join(" ") : null;
}

export function calcolaControllo(dati: DatiControllo): ControlloSettimanale {
  const { righe, lunedi, oggi } = dati;
  const lunediSettimane = Array.from({ length: SETTIMANE_STORIA },
    (_, k) => spostaGiorni(lunedi, -7 * (SETTIMANE_STORIA - 1 - k)));
  const inizio = lunediSettimane[0];
  const fine = spostaGiorni(lunedi, 6);
  const tutteLeGiornate = giornateDelPeriodo(inizio, fine);
  const nellaFinestra = new Set(tutteLeGiornate);

  /* Quanta raccolta ha ogni giornata: il massimo dei campioni fra le vetture,
   * come nel diario. Conta solo una giornata finita (oggi no) con almeno
   * mezza raccolta. */
  const campioni = new Map<string, number>();
  const perVettura = new Map<string, Map<string, RigaDiario>>();
  for (const r of righe) {
    if (!nellaFinestra.has(r.giorno)) continue;
    campioni.set(r.giorno, Math.max(campioni.get(r.giorno) ?? 0, r.letture));
    let m = perVettura.get(r.vehicleRef);
    if (!m) { m = new Map(); perVettura.set(r.vehicleRef, m); }
    m.set(r.giorno, r);
  }
  const osservata = (g: string) => g < oggi && (campioni.get(g) ?? 0) >= CAMPIONI_MINIMI_GIORNATA;
  const osservate = tutteLeGiornate.filter(osservata);
  const inizioDati = osservate[0] ?? inizio;

  /* Le giornate contate di ogni settimana, calcolate una volta sola. */
  const giorniDi = new Map(lunediSettimane.map(l => [l, giornateDelPeriodo(l, spostaGiorni(l, 6))]));
  const contateDi = new Map(lunediSettimane.map(l => [l, giorniDi.get(l)!.filter(osservata)]));

  const descriviSettimana = (lun: string): SettimanaDelControllo => {
    const giorni = giorniDi.get(lun) ?? giornateDelPeriodo(lun, spostaGiorni(lun, 6));
    const future = giorni.filter(g => g >= oggi).length;
    const oss = giorni.filter(osservata).length;
    const parziali = giorni.filter(g => g < oggi && campioni.has(g) && !osservata(g)).length;
    return {
      lunedi: lun, domenica: spostaGiorni(lun, 6),
      giornateOsservate: oss, giornateParziali: parziali,
      giornateSenzaDati: giorni.length - oss - parziali - future, giornateFuture: future,
    };
  };
  const settimane = lunediSettimane.map(descriviSettimana);
  /* C'è stata almeno una settimana giudicabile prima di questa? Se no, è la
   * prima settimana del diario: nessuna vettura è «nuova», non c'è confronto. */
  const storiaPrima = settimane.slice(0, -1).some(s => s.giornateOsservate >= GIORNATE_MINIME);
  const precedenteLun = spostaGiorni(lunedi, -7);
  const giornateStriscia = giornateDelPeriodo(precedenteLun, fine);

  /* Gli interventi chiusi nelle settimane guardate, per matricola. Una
   * chiusura dopo la domenica si giudica nelle settimane dopo, non in questa. */
  const interventiPer = new Map<string, InterventoAvm[]>();
  for (const i of dati.interventi ?? []) {
    const giorno = giornataDiIstante(new Date(i.chiusaIl));
    if (giorno < inizio || giorno > fine) continue;
    const l = interventiPer.get(i.matricola) ?? [];
    l.push(i);
    interventiPer.set(i.matricola, l);
  }

  const vetture: VetturaControllo[] = [];
  for (const [ref, giorniVettura] of perVettura) {
    const conPosizione = (g: string) => (giorniVettura.get(g)?.letturePosizione ?? 0) > 0;
    const conContatto = (g: string) => (giorniVettura.get(g)?.lettureFresche ?? 0) > 0;

    const sintesi = (lun: string): SintesiSettimana => {
      const giorni = contateDi.get(lun)!;
      const presenti = giorni.map(g => giorniVettura.get(g)).filter((r): r is RigaDiario => !!r);
      const s = {
        lunedi: lun,
        giornateOsservate: giorni.length,
        conContatto: presenti.filter(r => r.lettureFresche > 0).length,
        conPosizione: presenti.filter(r => r.letturePosizione > 0).length,
        conCorsa: presenti.filter(r => r.letturePosizione > 0 && r.lettureCorsa > 0).length,
        conErroreGps: presenti.filter(r => r.lettureErroreGps > 0).length,
      };
      const stato: StatoSettimana = giorni.length < GIORNATE_MINIME ? "."
        : presenti.length === 0 ? "A"
          : s.conPosizione > 0 ? "F"
            : s.conContatto > 0 ? "P"
              : "M";
      return { ...s, stato };
    };

    const storiaSintesi = lunediSettimane.map(sintesi);
    const questa = storiaSintesi[storiaSintesi.length - 1];
    const giudicabile = (s: SintesiSettimana) => s.stato === "F" || s.stato === "P" || s.stato === "M";
    const prima = [...storiaSintesi.slice(0, -1)].reverse().find(giudicabile) ?? null;

    const funziona = (s: SintesiSettimana) => s.stato === "F";
    const categoria: Categoria =
      questa.stato === "." ? "non_giudicabile"
        : questa.stato === "A" ? (prima ? "uscita" : "non_giudicabile")
          : !prima ? (storiaPrima ? "nuova" : "non_giudicabile")
            : funziona(prima) && funziona(questa) ? "funziona"
              : funziona(prima) ? "fermata"
                : funziona(questa) ? "ripresa"
                  : "guasta";

    const giorniPos = osservate.filter(conPosizione);
    const ultimaPosizione = giorniPos.length ? giorniPos[giorniPos.length - 1] : null;
    const giorniSenzaPosizione = ultimaPosizione
      ? osservate.filter(g => g > ultimaPosizione).length
      : null;
    const dal = categoria === "ripresa"
      ? giorniPos.find(g => g > spostaGiorni(prima!.lunedi, 6)) ?? null
      : categoria === "fermata" && ultimaPosizione
        ? osservate.find(g => g > ultimaPosizione) ?? null
        : null;

    const giorni = giornateStriscia.map((g): CarattereGiorno => {
      if (g >= oggi) return " ";
      if (!osservata(g)) return ".";
      const r = giorniVettura.get(g);
      return r ? carattereGiorno(r) : "-";
    }).join("");
    const storia = storiaSintesi.map(s => s.stato).join("");

    const mezzoOfficina = dati.officina ? dati.officina.get(ref) ?? null : null;
    const escl = dati.officina
      ? esclusioneOfficina(ref, funziona(questa) ? "funziona" : "muta", mezzoOfficina ?? undefined)
      : null;
    const esclusa = escl && (escl.motivo === "fuori_parco" || escl.motivo === "dismesso") ? escl : null;

    const interventi = (interventiPer.get(ref) ?? [])
      .map(i => giudicaIntervento(i, osservate, conPosizione, conContatto))
      .sort((a, b) => a.chiusaIl.localeCompare(b.chiusaIl));

    const id = identitaVettura(ref);
    const v: VetturaControllo = {
      vehicleRef: ref, codice: id.codice, azienda: id.azienda, mezzo: id.mezzo,
      categoria, settimana: questa, prima, dal, ultimaPosizione, giorniSenzaPosizione,
      giorni, storia, officina: mezzoOfficina, esclusa, interventi, nota: "",
    };
    v.nota = scriviNota(v, osservate, conPosizione, inizioDati, storiaPrima);
    vetture.push(v);
  }

  const peso = new Map(ORDINE_CATEGORIE.map((c, i) => [c, i]));
  vetture.sort((a, b) =>
    (peso.get(a.categoria)! - peso.get(b.categoria)!)
    || a.vehicleRef.localeCompare(b.vehicleRef, undefined, { numeric: true }));

  /* Gli interventi su vetture che il flusso non ha mai elencato nelle
   * settimane guardate: sono spesso proprio quelle da far censire a Mizar, e
   * un intervento che sparisce dal foglio è peggio di uno senza giudizio. */
  const conRighe = new Set(perVettura.keys());
  const fuoriFlusso: InterventoGiudicato[] = [];
  for (const [ref, lista] of interventiPer) {
    if (conRighe.has(ref)) continue;
    for (const i of lista) {
      fuoriFlusso.push({ ...giudicaIntervento(i, [], () => false), esitoAvm: "non_nel_flusso" });
    }
  }

  const conteggi = contaCategorie(vetture);
  const settimana = settimane[settimane.length - 1];
  const chiusa = settimanaChiusa(lunedi, oggi);
  const interventi = [...vetture.flatMap(v => v.interventi), ...fuoriFlusso]
    .sort((a, b) => a.chiusaIl.localeCompare(b.chiusaIl));

  return {
    versione: VERSIONE_CONTROLLO,
    generatoIl: dati.generatoIl ?? new Date().toISOString(),
    settimana: { ...settimana, chiusa },
    precedente: descriviSettimana(precedenteLun),
    giornate: giornateStriscia,
    settimane,
    conteggi,
    vetture,
    interventi,
    nota: notaGenerale(settimana, chiusa, conteggi, vetture.length),
  };
}

/* ── Le parole ──────────────────────────────────────────────────────────── */

const FRASE_CATEGORIA: Record<Categoria, [string, string]> = {
  fermata: ["ha smesso di localizzarsi", "hanno smesso di localizzarsi"],
  ripresa: ["ha ripreso a localizzarsi", "hanno ripreso a localizzarsi"],
  guasta: ["ancora non si localizza", "ancora non si localizzano"],
  nuova: ["è nuova nel flusso", "sono nuove nel flusso"],
  uscita: ["è uscita dal flusso", "sono uscite dal flusso"],
  funziona: ["funziona", "funzionano"],
  non_giudicabile: ["non si può giudicare", "non si possono giudicare"],
};

/**
 * La frase di sintesi della settimana. Si scrive sulle vetture che si stanno
 * guardando: la pagina e il foglio Excel la richiamano col perimetro scelto,
 * così la frase e le schede contano le stesse vetture.
 */
export function notaGenerale(
  s: SettimanaDelControllo, chiusa: boolean, c: Record<Categoria, number>, totale: number,
): string {
  const periodo = `dal ${ddmm(s.lunedi)} al ${ddmm(s.domenica)}`;
  if (s.giornateOsservate === 0) {
    return chiusa
      ? `Nessuna giornata con abbastanza raccolta ${periodo}: la settimana non si può giudicare.`
      : `La settimana ${periodo} non ha ancora giornate finite con abbastanza raccolta.`;
  }
  const voci = ORDINE_CATEGORIE.filter(k => c[k] > 0)
    .map(k => `${c[k]} ${FRASE_CATEGORIA[k][c[k] === 1 ? 0 : 1]}`);
  const pezzi = [`${totale} ${totale === 1 ? "vettura" : "vetture"} ${periodo}`
    + `${chiusa ? "" : " (settimana in corso, risultato provvisorio)"}: ${voci.join(", ")}.`];
  const possibili = 7 - s.giornateFuture;
  if (s.giornateOsservate < GIORNATE_MINIME) {
    pezzi.push(`Solo ${giornate(s.giornateOsservate)} contate: ne servono almeno ${GIORNATE_MINIME} per giudicare.`);
  } else if (s.giornateOsservate < possibili) {
    pezzi.push(`Giornate contate: ${s.giornateOsservate} su ${possibili} (le altre senza raccolta sufficiente).`);
  }
  return pezzi.join(" ");
}

/**
 * La nota di una vettura: deve reggere da sola in una mail all'officina, con
 * le date e i numeri che chi la riceve chiederebbe indietro.
 */
function scriviNota(
  v: VetturaControllo, osservate: string[], conPosizione: (g: string) => boolean,
  inizioDati: string, storiaPrima: boolean,
): string {
  const s = v.settimana;
  const pezzi: string[] = [];
  const corse = s.conCorsa > 0
    ? `con corse in ${s.conCorsa}`
    : "senza corse agganciate (turno non qualificato a bordo?)";
  /* Se l'officina dice che il mezzo è fermo, la diagnosi dell'apparato non
   * serve: dentro l'officina l'apparato tace o non vede il cielo. */
  const fermo = v.officina?.stato === "in_officina" && (v.categoria === "fermata" || v.categoria === "guasta");

  switch (v.categoria) {
    case "ripresa": {
      /* Da quanto non si localizzava: giornate contate fra l'ultima
       * posizione prima della ripresa e la ripresa stessa. */
      const precedente = v.dal ? osservate.filter(g => g < v.dal! && conPosizione(g)).pop() : undefined;
      const buco = v.dal && precedente
        ? osservate.filter(g => g > precedente && g < v.dal!).length
        : null;
      pezzi.push(`Si localizza di nuovo dal ${ddmm(v.dal)}: ${s.conPosizione} su ${giornate(s.giornateOsservate)}, ${corse}.`);
      pezzi.push(buco != null
        ? `Prima non si localizzava da ${giornate(buco)} contate (ultima posizione il ${ddmm(precedente!)}).`
        : `Non si localizzava in nessuna giornata contata dal ${ddmm(inizioDati)}.`);
      break;
    }
    case "fermata":
      pezzi.push(`Ultima posizione il ${ddmm(v.ultimaPosizione)}; da allora ${giornate(v.giorniSenzaPosizione ?? 0)} contate senza.`);
      if (fermo) pezzi.push(fermoInOfficina(v.officina!));
      else pezzi.push(s.stato === "P"
        ? `Parla col centro ma non si localizza${s.conErroreGps ? ", con errore GPS dichiarato" : ""}: `
          + "da guardare antenna e GPS."
        : "Non dà più segno: apparato spento, SIM, oppure mezzo rimasto fermo in rimessa.");
      break;
    case "guasta":
      if (fermo) {
        pezzi.push(fermoInOfficina(v.officina!));
      } else if (s.stato === "P") {
        pezzi.push(v.ultimaPosizione
          /* Si è già localizzata: il centro la conosce, non è l'attivazione. */
          ? `Parla col centro in ${giornate(s.conContatto)} ma non si localizza dal ${ddmm(v.ultimaPosizione)}`
            + `${s.conErroreGps ? ", con errore GPS" : ""}: antenna o apparato, non l'attivazione.`
          : s.conErroreGps
            ? `Parla col centro in ${giornate(s.conContatto)} ma non si localizza, con errore GPS: antenna.`
            : `Parla col centro in ${giornate(s.conContatto)} ma non si è mai localizzata, senza errori dichiarati: `
              + "attivazione al centro Mizar.");
      } else {
        pezzi.push("Nessun contatto col centro: apparato spento, SIM, o mezzo fermo.");
      }
      if (!(s.stato === "P" && v.ultimaPosizione && !fermo)) {
        pezzi.push(v.ultimaPosizione
          ? `Ultima posizione il ${ddmm(v.ultimaPosizione)}.`
          : `Nessuna posizione nelle giornate contate dal ${ddmm(inizioDati)}.`);
      }
      break;
    case "funziona":
      pezzi.push(`Si localizza in ${s.conPosizione} su ${giornate(s.giornateOsservate)}, ${corse}.`);
      break;
    case "nuova":
      pezzi.push(`Non compariva nel flusso SIRI nelle giornate contate dal ${ddmm(inizioDati)}: `
        + (s.stato === "F" ? `ora si localizza in ${s.conPosizione} su ${giornate(s.giornateOsservate)}.`
          : s.stato === "P" ? "ora parla col centro ma non si localizza." : "ora è elencata ma muta."));
      break;
    case "uscita":
      pezzi.push(`Il flusso SIRI non la elenca più in questa settimana${v.ultimaPosizione
        ? `; ultima posizione il ${ddmm(v.ultimaPosizione)}` : ""}.`);
      break;
    case "non_giudicabile":
      pezzi.push(s.stato === "."
        ? (s.giornateOsservate === 0
          ? "Settimana senza giornate contate: non si può giudicare."
          : `Solo ${giornate(s.giornateOsservate)} contate in settimana: troppo poche per giudicare.`)
        : s.stato === "A"
          ? "Non elencata dal flusso SIRI in nessuna giornata contata."
          : !storiaPrima
            ? "Prima settimana del diario: nessuna settimana precedente con cui confrontare."
            : "Nessuna settimana precedente con cui confrontare.");
      break;
  }
  /* Funziona o ripresa, ma da qualche giornata non si localizza più: da tenere d'occhio. */
  if ((v.categoria === "funziona" || v.categoria === "ripresa")
      && v.giorniSenzaPosizione != null && v.giorniSenzaPosizione >= GIORNI_SMESSA) {
    pezzi.push(`Ma dall'ultima posizione (${ddmm(v.ultimaPosizione)}) sono passate ${giornate(v.giorniSenzaPosizione)} `
      + "contate senza: da tenere d'occhio.");
  }
  const officina = notaOfficina(v.officina, v.esclusa, fermo);
  if (officina) pezzi.push(officina);
  for (const i of v.interventi) {
    pezzi.push(`Intervento ${i.riferimento} chiuso il ${ddmm(i.giornoChiusura)}, ${ESITO_IN_FRASE[i.esitoAvm]}.`);
  }
  return pezzi.join(" ");
}
