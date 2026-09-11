/**
 * ═══════════════════════════════════════════════════════════════════════════
 * VERIFICA DELL'AGGANCIO CORSA — il controllo che manca sotto a tutto il resto
 * ───────────────────────────────────────────────────────────────────────────
 * Ogni transito, ritardo e tempo di percorrenza che scriviamo è attribuito a
 * una corsa. Quella corsa la scegliamo noi: o perché l'identificativo che
 * manda l'AVM esiste anche nel feed, o perché linea e ora di partenza
 * combaciano. In entrambi i casi la scelta viene poi data per buona e non
 * viene più messa in discussione da nessuno.
 *
 * Se è sbagliata, non ce ne accorgiamo: i dati continuano ad arrivare, le
 * tabelle si riempiono, le medie si spostano. Un aggancio errato non produce
 * un errore — produce uno storico plausibile e falso, che è peggio.
 *
 * Eppure l'AVM, sulle corse in cui parla, dichiara anche altro: la linea, il
 * capolinea, la partenza e l'arrivo PROGRAMMATI. Sono termini di confronto
 * indipendenti, e finora li buttavamo.
 *
 * Due avvertenze che questo modulo tratta come sostanza, non come dettaglio:
 *
 * 1. Si confronta PROGRAMMATO CON PROGRAMMATO. L'OriginAimedDepartureTime di
 *    SIRI e il departure_time del feed dicono la stessa cosa — quando parte
 *    per orario, non quando è partita. Una differenza non è un ritardo: è un
 *    disallineamento fra i due sistemi. Per questo la tolleranza è stretta.
 *
 * 2. Un controllo che ripete il criterio con cui la corsa è stata scelta non
 *    dimostra niente. Se l'aggancio è stato fatto per orario di partenza, il
 *    confronto sull'orario di partenza tornerà sempre. Quei riscontri sono
 *    marcati `tautologico` e non contano: chiamare "verificato" un aggancio
 *    sulla base della propria stessa regola è il modo più rapido per darsi
 *    ragione da soli.
 *
 * Il verdetto peggiore — `incoerente` — è l'unico che il chiamante dovrebbe
 * usare per NON scrivere: uno storico mancante si riempie domani, uno storico
 * sbagliato resta.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import {
  normalizeStopName, scheduledSeconds, localHHMM, type TripStop,
} from "./siri-vm";
import { distanzaDalPercorso } from "./anomaly-detection";

/* ── Soglie ───────────────────────────────────────────────────────────────
 * Programmato contro programmato dovrebbe coincidere al secondo. I due minuti
 * di tolleranza coprono solo l'arrotondamento e uno sfasamento di versione
 * dell'orario, non un errore di corsa: alla frequenza tipica di una linea
 * urbana, la corsa successiva è comunque più lontana di così. */
export const TOLLERANZA_ORARIO_SEC = 120;

/** Oltre questa distanza dal tracciato il mezzo non sta facendo quel percorso.
 *  Volutamente larga: 300 m sono un autista che devia, mezzo chilometro no.
 *  Resta comunque un indizio debole, perché le due cause si somigliano. */
export const LONTANO_DAL_TRACCIATO_M = 500;

/* ── Tipi ─────────────────────────────────────────────────────────────────── */

/** Quello che il feed dice della corsa che abbiamo agganciato. */
export interface SchedaCorsa {
  tripId: string;
  routeId: string | null;
  /** partenza dalla prima fermata, "HH:MM:SS" (può superare le 24) */
  partenza: string | null;
  /** arrivo all'ultima fermata, "HH:MM:SS" */
  arrivo: string | null;
  /** capolinea dichiarato dal feed (headsign o nome dell'ultima fermata) */
  capolinea: string | null;
  /** fermate con coordinate, in ordine di percorso */
  fermate: TripStop[];
}

/** Quello che l'AVM dichiara della corsa che sta facendo. */
export interface DichiarazioneAvm {
  vehicleRef: string | null;
  journeyRef: string | null;
  /** linea riconosciuta dai campi dell'AVM, non dedotta dalla corsa */
  routeIdDichiarato: string | null;
  destinationName: string | null;
  originAimedDeparture: Date | null;
  destinationAimedArrival: Date | null;
  lat: number | null;
  lon: number | null;
}

export type CampoRiscontro = "linea" | "partenza" | "arrivo" | "capolinea" | "posizione";
export type EsitoRiscontro = "coerente" | "discorde" | "non_verificabile";

export interface Riscontro {
  campo: CampoRiscontro;
  esito: EsitoRiscontro;
  /** quello che dice il feed */
  atteso: string | null;
  /** quello che dice l'AVM */
  dichiarato: string | null;
  /** secondi (orari) o metri (posizione) */
  scostamento?: number;
  /** il riscontro ripete il criterio con cui la corsa è stata scelta */
  tautologico?: boolean;
  nota?: string;
}

export type VerdettoAggancio =
  /** almeno un riscontro indipendente conferma, nessuno smentisce */
  | "verificato"
  /** smentito su un campo che identifica la corsa: da non scrivere */
  | "incoerente"
  /** smentito su un campo che può avere altre spiegazioni */
  | "sospetto"
  /** l'AVM non ha mandato niente con cui confrontarsi */
  | "non_verificabile";

export interface EsitoAggancio {
  vehicleRef: string | null;
  tripId: string;
  journeyRef: string | null;
  agganciatoCome: ModoAggancio;
  verdetto: VerdettoAggancio;
  riscontri: Riscontro[];
  /** i soli riscontri che hanno pesato sul verdetto */
  indipendenti: number;
  /** una riga leggibile: cosa non torna, o perché non si può dire */
  motivo: string;
}

export type ModoAggancio = "id" | "orario";

/**
 * Quando una smentita basta a NON scrivere.
 *
 * La linea da sola basta: una corsa appartiene a una linea e basta, i due
 * sistemi la chiamano con lo stesso identificativo, e non c'è lettura in cui
 * "R44 contro R31" voglia dire qualcos'altro.
 *
 * La partenza programmata da sola NON basta, anche se sembrerebbe altrettanto
 * netta. I due sistemi possono far cominciare la corsa in punti diversi — il
 * feed dal capolinea, l'AVM dal punto di presa servizio — e lo scarto che ne
 * nasce non è un errore di aggancio. Serve che qualcos'altro la smentisca a
 * sua volta: due disaccordi indipendenti non sono una differenza di
 * convenzione. Con una sola smentita il verdetto resta `sospetto` e il dato
 * si scrive: buttare dati buoni su un indizio solo è l'altro modo di
 * sbagliare, meno appariscente e non meno dannoso.
 */
function verdettoDa(discordi: Riscontro[]): VerdettoAggancio | null {
  if (discordi.length === 0) return null;
  if (discordi.some(r => r.campo === "linea")) return "incoerente";
  if (discordi.some(r => r.campo === "partenza") && discordi.length >= 2) return "incoerente";
  return "sospetto";
}

/* ── Riscontri ────────────────────────────────────────────────────────────── */

/** Differenza fra due orari del giorno, nella finestra ±12 h.
 *  Il passaggio dalla mezzanotte va gestito o una corsa dell'una di notte
 *  risulta lontana ventitré ore dalla sua. */
function scartoOrario(attesoSec: number, dichiaratoSec: number): number {
  const DAY = 86_400;
  const raw = dichiaratoSec - (attesoSec % DAY);
  return (((raw + DAY / 2) % DAY) + DAY) % DAY - DAY / 2;
}

function hhmmLocale(d: Date | null, timeZone: string): string | null {
  return d ? localHHMM(d, timeZone) : null;
}

function riscontroOrario(
  campo: "partenza" | "arrivo",
  atteso: string | null,
  dichiarato: Date | null,
  timeZone: string,
  tautologico: boolean,
): Riscontro {
  const attesoSec = atteso == null ? null : scheduledSeconds(atteso);
  const testo = hhmmLocale(dichiarato, timeZone);
  if (atteso == null || attesoSec == null || !dichiarato) {
    return {
      campo, esito: "non_verificabile", atteso: atteso?.slice(0, 5) ?? null, dichiarato: testo,
      nota: attesoSec == null ? "il feed non ha l'orario" : "l'AVM non lo dichiara",
    };
  }
  const [hh, mm] = (testo ?? "00:00").split(":").map(Number);
  const scarto = scartoOrario(attesoSec, hh * 3600 + mm * 60);
  const coerente = Math.abs(scarto) <= TOLLERANZA_ORARIO_SEC;
  return {
    campo, esito: coerente ? "coerente" : "discorde",
    atteso: atteso.slice(0, 5), dichiarato: testo,
    scostamento: Math.round(scarto),
    ...(tautologico ? { tautologico: true } : {}),
    ...(coerente ? {} : {
      nota: "programmato contro programmato: questa differenza non è un ritardo",
    }),
  };
}

function riscontroLinea(scheda: SchedaCorsa, avm: DichiarazioneAvm): Riscontro {
  /* Se la linea non l'ha detta l'AVM ma l'abbiamo dedotta dalla corsa, il
   * confronto sarebbe con noi stessi. */
  if (!avm.routeIdDichiarato) {
    return {
      campo: "linea", esito: "non_verificabile",
      atteso: scheda.routeId, dichiarato: null,
      nota: "linea non dichiarata dall'AVM: dedotta dalla corsa",
    };
  }
  if (!scheda.routeId) {
    return {
      campo: "linea", esito: "non_verificabile",
      atteso: null, dichiarato: avm.routeIdDichiarato,
      nota: "la corsa del feed non ha linea",
    };
  }
  const uguale = scheda.routeId === avm.routeIdDichiarato;
  return {
    campo: "linea", esito: uguale ? "coerente" : "discorde",
    atteso: scheda.routeId, dichiarato: avm.routeIdDichiarato,
    ...(uguale ? {} : { nota: "la corsa agganciata è di un'altra linea" }),
  };
}

function riscontroCapolinea(
  scheda: SchedaCorsa, avm: DichiarazioneAvm, tautologico: boolean,
): Riscontro {
  if (!scheda.capolinea || !avm.destinationName) {
    return {
      campo: "capolinea", esito: "non_verificabile",
      atteso: scheda.capolinea, dichiarato: avm.destinationName,
      nota: scheda.capolinea ? "l'AVM non lo dichiara" : "il feed non ha il capolinea",
    };
  }
  const a = normalizeStopName(scheda.capolinea);
  const b = normalizeStopName(avm.destinationName);
  /* I due sistemi scrivono gli stessi luoghi in modo diverso ("ANCONA STAZ."
   * contro "ANCONA STAZIONE FS"): l'inclusione di uno nell'altro è il
   * confronto che regge senza un dizionario di sinonimi. */
  const uguale = a === b || a.includes(b) || b.includes(a);
  return {
    campo: "capolinea", esito: uguale ? "coerente" : "discorde",
    atteso: scheda.capolinea, dichiarato: avm.destinationName,
    ...(tautologico ? { tautologico: true } : {}),
    ...(uguale ? {} : { nota: "capolinea diverso da quello della corsa agganciata" }),
  };
}

function riscontroPosizione(scheda: SchedaCorsa, avm: DichiarazioneAvm): Riscontro {
  if (avm.lat == null || avm.lon == null || scheda.fermate.length < 2) {
    return {
      campo: "posizione", esito: "non_verificabile", atteso: null, dichiarato: null,
      nota: avm.lat == null ? "nessuna posizione" : "percorso senza coordinate",
    };
  }
  const d = distanzaDalPercorso(avm.lat, avm.lon, scheda.fermate);
  if (d == null) {
    return {
      campo: "posizione", esito: "non_verificabile", atteso: null, dichiarato: null,
      nota: "percorso senza coordinate",
    };
  }
  const vicino = d <= LONTANO_DAL_TRACCIATO_M;
  return {
    campo: "posizione", esito: vicino ? "coerente" : "discorde",
    atteso: `${scheda.fermate.length} fermate`, dichiarato: `${avm.lat.toFixed(5)},${avm.lon.toFixed(5)}`,
    scostamento: Math.round(d),
    ...(vicino ? {} : {
      /* Le due cause si somigliano e non vanno confuse in un verdetto grave. */
      nota: "lontano dal tracciato: o la corsa è sbagliata, o l'autista ha deviato",
    }),
  };
}

/* ── Verdetto ─────────────────────────────────────────────────────────────── */

/**
 * Confronta quello che l'AVM dichiara con quello che il feed dice della corsa
 * che gli abbiamo attribuito.
 */
export function verificaAggancio(
  avm: DichiarazioneAvm,
  scheda: SchedaCorsa,
  agganciatoCome: ModoAggancio,
  timeZone = "Europe/Rome",
): EsitoAggancio {
  /* L'aggancio per orario è stato scelto PROPRIO su partenza e capolinea:
   * ricontrollarli è ricontrollare la propria regola. */
  const perOrario = agganciatoCome === "orario";

  const riscontri: Riscontro[] = [
    riscontroLinea(scheda, avm),
    riscontroOrario("partenza", scheda.partenza, avm.originAimedDeparture, timeZone, perOrario),
    riscontroOrario("arrivo", scheda.arrivo, avm.destinationAimedArrival, timeZone, false),
    riscontroCapolinea(scheda, avm, perOrario),
    riscontroPosizione(scheda, avm),
  ];

  const utili = riscontri.filter(r => !r.tautologico && r.esito !== "non_verificabile");
  const discordi = utili.filter(r => r.esito === "discorde");
  const smentita = verdettoDa(discordi);

  let verdetto: VerdettoAggancio;
  let motivo: string;
  if (smentita) {
    verdetto = smentita;
    motivo = discordi.map(descriviDiscordanza).join("; ");
  } else if (utili.length > 0) {
    verdetto = "verificato";
    motivo = `confermato da ${elenco(utili.map(r => r.campo))}`;
  } else {
    verdetto = "non_verificabile";
    const tautologici = riscontri.filter(r => r.tautologico).length;
    motivo = tautologici > 0
      ? "l'AVM conferma solo i campi con cui la corsa è stata scelta: nessuna prova indipendente"
      : "l'AVM non dichiara né linea, né capolinea, né orari";
  }

  return {
    vehicleRef: avm.vehicleRef, tripId: scheda.tripId, journeyRef: avm.journeyRef,
    agganciatoCome, verdetto, riscontri, indipendenti: utili.length, motivo,
  };
}

function descriviDiscordanza(r: Riscontro): string {
  switch (r.campo) {
    case "linea":
      return `linea ${r.dichiarato} dall'AVM, ${r.atteso} nella corsa agganciata`;
    case "partenza":
    case "arrivo": {
      const min = Math.round(Math.abs(r.scostamento ?? 0) / 60);
      return `${r.campo} ${r.dichiarato} contro ${r.atteso} programmate (${min} min)`;
    }
    case "capolinea":
      return `diretto a ${r.dichiarato}, la corsa va a ${r.atteso}`;
    case "posizione":
      return `${r.scostamento} m dal tracciato della corsa`;
  }
}

function elenco(v: string[]): string {
  if (v.length === 1) return v[0];
  return `${v.slice(0, -1).join(", ")} e ${v[v.length - 1]}`;
}

/* ── Quadro d'insieme ─────────────────────────────────────────────────────── */

export interface RiepilogoAgganci {
  totale: number;
  verificati: number;
  sospetti: number;
  incoerenti: number;
  nonVerificabili: number;
  /** quota di agganci su cui esiste almeno una prova indipendente */
  quotaVerificabile: number;
  nota: string;
}

export function riepilogaAgganci(esiti: EsitoAggancio[]): RiepilogoAgganci {
  const conta = (v: VerdettoAggancio) => esiti.filter(e => e.verdetto === v).length;
  const totale = esiti.length;
  const verificati = conta("verificato");
  const sospetti = conta("sospetto");
  const incoerenti = conta("incoerente");
  const nonVerificabili = conta("non_verificabile");
  const controllabili = totale - nonVerificabili;

  let nota: string;
  if (totale === 0) {
    nota = "Nessuna corsa agganciata in questo giro: non c'è niente da verificare.";
  } else if (incoerenti > 0) {
    nota = incoerenti === 1
      ? "1 corsa agganciata è smentita dall'AVM: i suoi passaggi non vengono "
        + "scritti, perché uno storico sbagliato resta."
      : `${incoerenti} corse agganciate sono smentite dall'AVM: i loro passaggi `
        + "non vengono scritti, perché uno storico sbagliato resta.";
  } else if (controllabili === 0) {
    nota = `Nessuno dei ${totale} agganci è verificabile: su queste corse l'AVM manda `
      + "l'identificativo e basta. È il limite del flusso, non un guasto.";
  } else {
    nota = `${verificati} agganci su ${totale} confermati da un dato indipendente`
      + (sospetti > 0 ? `, ${sospetti} da guardare` : "")
      + `; sui restanti ${nonVerificabili} l'AVM non dice abbastanza per poterli controllare.`;
  }

  return {
    totale, verificati, sospetti, incoerenti, nonVerificabili,
    quotaVerificabile: totale === 0 ? 0 : controllabili / totale,
    nota,
  };
}
