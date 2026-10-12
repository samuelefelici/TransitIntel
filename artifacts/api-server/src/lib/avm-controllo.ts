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
 * settimana se si è LOCALIZZATA almeno in una giornata osservata. La corsa
 * dipende dal conducente che qualifica il turno a bordo, quindi si riporta
 * accanto ma non decide la categoria.
 *
 * La settimana è lunedì–domenica di giornate di esercizio (taglio alle 03:00,
 * fuso di esercizio), identificata dal suo lunedì. Le giornate con meno di
 * mezza raccolta non contano, come nel diario: un buco del connettore non è
 * un apparato rotto.
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
  esitoGiorno, esclusioneOfficina, CAMPIONI_MINIMI_GIORNATA,
  type RigaDiario, type Esclusione, type EsitoGiorno,
} from "./avm-diario";
import { identitaVettura } from "./parco-anagrafica";
import { giornateDelPeriodo } from "./fleet-trend";
import { giornataDiIstante } from "./service-day";
import type { MezzoOfficina } from "./officina";

/** Cambia quando cambia il modo di calcolare: resta scritto in ogni istantanea. */
export const VERSIONE_CONTROLLO = 1;

/** Quante settimane si guardano all'indietro, compresa quella sotto controllo. */
export const SETTIMANE_STORIA = 8;

/**
 * Giornate osservate dopo la chiusura di un intervento prima di dire che non
 * è servito: un mezzo può restare in rimessa un giorno o due dopo la
 * riparazione, e chi legge «senza effetto» dopo un giorno richiama l'officina
 * per niente.
 */
export const GIORNATE_DOPO_MINIME = 3;

/* ── Il vocabolario ────────────────────────────────────────────────────────
 * Le strisce viaggiano come stringhe di un carattere per giornata o per
 * settimana: sono leggibili nel JSON, leggere nell'archivio, e la pagina e il
 * foglio Excel ne fanno quadratini colorati. */

/**
 * Lo stato di una vettura in una settimana:
 *   F funziona  — almeno una giornata osservata con posizione
 *   P parla     — contatto col centro, mai una posizione
 *   M muta      — elencata, nessun contatto nelle giornate osservate
 *   A assente   — non elencata dal flusso SIRI in nessuna giornata osservata
 *   . senza dati — la settimana non ha giornate osservate: non si giudica
 */
export type StatoSettimana = "F" | "P" | "M" | "A" | ".";

/**
 * Una giornata nella striscia:
 *   S in servizio · T si localizza · C collegata senza posizione · M muta
 *   - non elencata · . giornata non osservata (connettore fermo o a metà)
 *   ' ' giornata ancora da venire (settimana in corso)
 */
export type CarattereGiorno = "S" | "T" | "C" | "M" | "-" | "." | " ";

export type Categoria =
  | "fermata"         // si localizzava, non si localizza più
  | "ripresa"         // non si localizzava, ora sì
  | "guasta"          // non si localizza né prima né ora
  | "nuova"           // prima volta nel flusso, nella finestra guardata
  | "uscita"          // c'era, questa settimana il flusso non la elenca più
  | "funziona"        // si localizza prima e ora
  | "non_giudicabile";// settimana senza dati

/** L'ordine di lettura: prima le notizie da girare a qualcuno. */
export const ORDINE_CATEGORIE: Categoria[] = [
  "fermata", "ripresa", "guasta", "nuova", "uscita", "funziona", "non_giudicabile",
];

export const ETICHETTE_CATEGORIA: Record<Categoria, { titolo: string; breve: string; perche: string }> = {
  fermata: {
    titolo: "Ha smesso di localizzarsi", breve: "Si è fermata",
    perche: "Nella settimana precedente si localizzava, in questa no. È un guasto nuovo, oppure il mezzo "
      + "è rimasto fermo: la nota dice quale dei due è più probabile.",
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
    titolo: "Non giudicabile", breve: "Senza dati",
    perche: "La settimana non ha giornate con abbastanza raccolta per giudicare.",
  },
};

/** Che cosa ha prodotto un intervento chiuso, misurato sull'apparato. */
export type EsitoIntervento = "riuscito" | "gia_funzionava" | "senza_effetto" | "peggiorato" | "da_verificare";

export const ETICHETTE_ESITO_INTERVENTO: Record<EsitoIntervento, string> = {
  riuscito: "Riuscito: prima non si localizzava, dopo sì",
  gia_funzionava: "Si localizzava già prima",
  senza_effetto: "Senza effetto: dopo non si localizza",
  peggiorato: "Dopo non si localizza più",
  da_verificare: "Da verificare: troppe poche giornate dopo",
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
  /** giornate osservate guardate prima della chiusura, e quante con posizione */
  giorniPrima: number;
  posizionePrima: number;
  /** giornate osservate dopo la chiusura, e quante con posizione */
  giorniDopo: number;
  posizioneDopo: number;
  /** la prima giornata con posizione dopo la chiusura, se c'è */
  primaPosizioneDopo: string | null;
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
  /** ripresa: prima giornata con posizione; fermata: ultima giornata con posizione */
  dal: string | null;
  /** ultima giornata con posizione nelle settimane guardate */
  ultimaPosizione: string | null;
  /** giornate osservate dall'ultima posizione alla fine dei dati; null se mai nella finestra */
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
  /** giornate ancora da venire: solo per la settimana in corso */
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
  conteggi: Record<Categoria, number>;
  vetture: VetturaControllo[];
  interventi: InterventoGiudicato[];
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

const CARATTERE: Record<EsitoGiorno, CarattereGiorno> = {
  in_servizio: "S", traccia: "T", collegata: "C", muta: "M",
};

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

/** Il giudizio di un intervento, sulle giornate osservate della vettura. */
export function giudicaIntervento(
  i: InterventoAvm,
  osservate: string[],
  posizioneIl: (g: string) => boolean,
  giornoChiusura: string = giornataDiIstante(new Date(i.chiusaIl)),
): InterventoGiudicato {
  const prima = osservate.filter(g => g < giornoChiusura).slice(-7);
  const dopo = osservate.filter(g => g > giornoChiusura);
  const posizionePrima = prima.filter(posizioneIl).length;
  const conPosDopo = dopo.filter(posizioneIl);
  const posizioneDopo = conPosDopo.length;

  const esitoAvm: EsitoIntervento =
    posizioneDopo > 0
      ? (posizionePrima > 0 ? "gia_funzionava" : "riuscito")
      : dopo.length < GIORNATE_DOPO_MINIME
        ? "da_verificare"
        : (posizionePrima > 0 ? "peggiorato" : "senza_effetto");

  return {
    ...i, giornoChiusura, esitoAvm,
    giorniPrima: prima.length, posizionePrima,
    giorniDopo: dopo.length, posizioneDopo,
    primaPosizioneDopo: conPosDopo[0] ?? null,
  };
}

function dataBreve(iso: string | null): string {
  if (!iso) return "";
  const [a, m, g] = iso.slice(0, 10).split("-");
  return `${g}/${m}/${a}`;
}

/** La frase dell'officina da accodare alla nota, se c'è qualcosa da dire. */
function notaOfficina(m: MezzoOfficina | null, esclusa: Esclusione | null): string | null {
  if (esclusa) return esclusa.motivo === "fuori_parco"
    ? "Non è nel parco dell'officina: con ogni probabilità venduta o demolita."
    : "L'officina la dà dismessa.";
  if (!m) return null;
  const pezzi: string[] = [];
  if (m.stato === "in_officina") {
    pezzi.push(`Ferma in officina${m.fermoDal ? ` dal ${dataBreve(m.fermoDal)}` : ""}`
      + `${m.fermoMotivo ? ` (${m.fermoMotivo})` : ""}${m.commessa ? `, commessa ${m.commessa}` : ""}.`);
  } else if (m.stato === "riserva") {
    pezzi.push("Di riserva per l'officina: può essere rimasta in rimessa.");
  }
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
   * come nel diario. Una giornata conta solo con almeno mezza raccolta. */
  const campioni = new Map<string, number>();
  const perVettura = new Map<string, Map<string, RigaDiario>>();
  for (const r of righe) {
    if (!nellaFinestra.has(r.giorno)) continue;
    campioni.set(r.giorno, Math.max(campioni.get(r.giorno) ?? 0, r.letture));
    let m = perVettura.get(r.vehicleRef);
    if (!m) { m = new Map(); perVettura.set(r.vehicleRef, m); }
    m.set(r.giorno, r);
  }
  const osservata = (g: string) => g <= oggi && (campioni.get(g) ?? 0) >= CAMPIONI_MINIMI_GIORNATA;
  const osservate = tutteLeGiornate.filter(osservata);

  const descriviSettimana = (lun: string): SettimanaDelControllo => {
    const giorni = giornateDelPeriodo(lun, spostaGiorni(lun, 6));
    const future = giorni.filter(g => g > oggi).length;
    const oss = giorni.filter(osservata).length;
    const parziali = giorni.filter(g => g <= oggi && campioni.has(g) && !osservata(g)).length;
    return {
      lunedi: lun, domenica: spostaGiorni(lun, 6),
      giornateOsservate: oss, giornateParziali: parziali,
      giornateSenzaDati: giorni.length - oss - parziali - future, giornateFuture: future,
    };
  };
  const settimane = lunediSettimane.map(descriviSettimana);
  const precedenteLun = spostaGiorni(lunedi, -7);
  const giornateStriscia = giornateDelPeriodo(precedenteLun, fine);

  /* Gli interventi per matricola, ordinati per chiusura. */
  const interventiPer = new Map<string, InterventoAvm[]>();
  for (const i of dati.interventi ?? []) {
    const l = interventiPer.get(i.matricola) ?? [];
    l.push(i);
    interventiPer.set(i.matricola, l);
  }

  const vetture: VetturaControllo[] = [];
  for (const [ref, giorniVettura] of perVettura) {
    const conPosizione = (g: string) => (giorniVettura.get(g)?.letturePosizione ?? 0) > 0;

    const sintesi = (lun: string): SintesiSettimana => {
      const giorni = giornateDelPeriodo(lun, spostaGiorni(lun, 6)).filter(osservata);
      const presenti = giorni.map(g => giorniVettura.get(g)).filter((r): r is RigaDiario => !!r);
      const s = {
        lunedi: lun,
        giornateOsservate: giorni.length,
        conContatto: presenti.filter(r => r.lettureFresche > 0).length,
        conPosizione: presenti.filter(r => r.letturePosizione > 0).length,
        conCorsa: presenti.filter(r => r.lettureCorsa > 0).length,
        conErroreGps: presenti.filter(r => r.lettureErroreGps > 0).length,
      };
      const stato: StatoSettimana = giorni.length === 0 ? "."
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
          : !prima ? "nuova"
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
      : categoria === "fermata" ? ultimaPosizione
        : null;

    const giorni = giornateStriscia.map((g): CarattereGiorno => {
      if (g > oggi) return " ";
      if (!osservata(g)) return ".";
      const r = giorniVettura.get(g);
      return r ? CARATTERE[esitoGiorno(r)] : "-";
    }).join("");
    const storia = storiaSintesi.map(s => s.stato).join("");

    const mezzoOfficina = dati.officina ? dati.officina.get(ref) ?? null : null;
    const escl = dati.officina
      ? esclusioneOfficina(ref, funziona(questa) ? "funziona" : "muta", mezzoOfficina ?? undefined)
      : null;
    const esclusa = escl && (escl.motivo === "fuori_parco" || escl.motivo === "dismesso") ? escl : null;

    const interventi = (interventiPer.get(ref) ?? [])
      .map(i => giudicaIntervento(i, osservate, conPosizione))
      .filter(i => i.giornoChiusura >= inizio)
      .sort((a, b) => a.chiusaIl.localeCompare(b.chiusaIl));

    const id = identitaVettura(ref);
    const v: VetturaControllo = {
      vehicleRef: ref, codice: id.codice, azienda: id.azienda, mezzo: id.mezzo,
      categoria, settimana: questa, prima, dal, ultimaPosizione, giorniSenzaPosizione,
      giorni, storia, officina: mezzoOfficina, esclusa, interventi, nota: "",
    };
    v.nota = scriviNota(v, osservate, conPosizione, inizio, notaOfficina(mezzoOfficina, esclusa));
    vetture.push(v);
  }

  const peso = new Map(ORDINE_CATEGORIE.map((c, i) => [c, i]));
  vetture.sort((a, b) =>
    (peso.get(a.categoria)! - peso.get(b.categoria)!)
    || a.vehicleRef.localeCompare(b.vehicleRef, undefined, { numeric: true }));

  const conteggi = contaCategorie(vetture);
  const settimana = settimane[settimane.length - 1];
  const chiusa = settimanaChiusa(lunedi, oggi);
  const interventi = vetture.flatMap(v => v.interventi)
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

function notaGenerale(
  s: SettimanaDelControllo, chiusa: boolean, c: Record<Categoria, number>, totale: number,
): string {
  const periodo = `dal ${ddmm(s.lunedi)} al ${ddmm(s.domenica)}`;
  if (s.giornateOsservate === 0) {
    return `Nessuna giornata con abbastanza raccolta ${periodo}: la settimana non si può giudicare.`;
  }
  const pezzi = [
    `${totale} vetture ${periodo}${chiusa ? "" : " (settimana in corso, risultato provvisorio)"}:`,
    `${c.ripresa} hanno ripreso a localizzarsi, ${c.fermata} hanno smesso,`,
    `${c.guasta} ancora non si localizzano, ${c.funziona} funzionano.`,
  ];
  if (s.giornateOsservate < 7 - s.giornateFuture) {
    pezzi.push(`Giornate contate: ${s.giornateOsservate} su ${7 - s.giornateFuture}`
      + " (le altre senza raccolta sufficiente).");
  }
  return pezzi.join(" ");
}

/**
 * La nota di una vettura: deve reggere da sola in una mail all'officina, con
 * le date e i numeri che chi la riceve chiederebbe indietro.
 */
function scriviNota(
  v: VetturaControllo, osservate: string[], conPosizione: (g: string) => boolean,
  inizio: string, officina: string | null,
): string {
  const s = v.settimana;
  const pezzi: string[] = [];
  const corse = s.conCorsa > 0
    ? `con corse in ${s.conCorsa}`
    : "senza corse agganciate (turno non qualificato a bordo?)";

  switch (v.categoria) {
    case "ripresa": {
      /* Da quanto non si localizzava: giornate osservate fra l'ultima
       * posizione prima della ripresa e la ripresa stessa. */
      const precedente = v.dal ? osservate.filter(g => g < v.dal! && conPosizione(g)).pop() : undefined;
      const buco = v.dal && precedente
        ? osservate.filter(g => g > precedente && g < v.dal!).length
        : null;
      pezzi.push(`Si localizza di nuovo dal ${ddmm(v.dal)}: ${s.conPosizione} giornate su ${s.giornateOsservate}, ${corse}.`);
      pezzi.push(buco != null
        ? `Prima non si localizzava da ${buco} giornate osservate (ultima posizione il ${ddmm(precedente!)}).`
        : `Non si localizzava in nessuna giornata dal ${ddmm(inizio)}.`);
      break;
    }
    case "fermata":
      pezzi.push(`Ultima posizione il ${ddmm(v.dal)}; da allora ${v.giorniSenzaPosizione} giornate osservate senza.`);
      pezzi.push(s.stato === "P"
        ? `Parla col centro ma non si localizza${s.conErroreGps ? ", con errore GPS dichiarato" : ""}: `
          + "da guardare antenna e GPS."
        : "Non dà più segno: apparato spento, SIM, oppure mezzo rimasto fermo in rimessa.");
      break;
    case "guasta":
      if (s.stato === "P") {
        pezzi.push(s.conErroreGps
          ? `Parla col centro in ${s.conContatto} giornate ma non si localizza, con errore GPS: antenna.`
          : `Parla col centro in ${s.conContatto} giornate ma non si localizza, senza errori dichiarati: `
            + "attivazione al centro Mizar.");
      } else {
        pezzi.push("Nessun contatto col centro: apparato spento, SIM, o mezzo fermo.");
      }
      pezzi.push(v.ultimaPosizione
        ? `Ultima posizione il ${ddmm(v.ultimaPosizione)}.`
        : `Nessuna posizione dal ${ddmm(inizio)}.`);
      break;
    case "funziona":
      pezzi.push(`Si localizza in ${s.conPosizione} giornate su ${s.giornateOsservate}, ${corse}.`);
      break;
    case "nuova":
      pezzi.push(`Compare nel flusso SIRI per la prima volta dal ${ddmm(inizio)}: `
        + (s.stato === "F" ? `si localizza in ${s.conPosizione} giornate su ${s.giornateOsservate}.`
          : s.stato === "P" ? "parla col centro ma non si localizza." : "elencata ma muta."));
      break;
    case "uscita":
      pezzi.push(`Il flusso SIRI non la elenca più in questa settimana${v.ultimaPosizione
        ? `; ultima posizione il ${ddmm(v.ultimaPosizione)}` : ""}.`);
      break;
    case "non_giudicabile":
      pezzi.push("Settimana senza raccolta sufficiente: non si può giudicare.");
      break;
  }
  if (officina) pezzi.push(officina);
  for (const i of v.interventi) {
    pezzi.push(`Intervento ${i.riferimento} chiuso il ${ddmm(i.giornoChiusura)}: `
      + `${ETICHETTE_ESITO_INTERVENTO[i.esitoAvm].toLowerCase()}.`);
  }
  return pezzi.join(" ");
}
