/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Completamento dei transiti: dare un orario alle fermate non rilevate
 * ───────────────────────────────────────────────────────────────────────────
 * Il passaggio si riconosce quando il mezzo si trova entro il raggio di una
 * fermata NELL'ISTANTE della lettura. A 60 secondi un autobus urbano copre
 * 400-500 metri, quindi fra due letture ne supera spesso due o tre: la corsa
 * esce con i transiti sparsi — le fermate 1, 4, 7, 12 — e i buchi in mezzo.
 *
 * Per l'esercizio va bene: un passaggio osservato è un fatto. Per l'analisi
 * delle percorrenze no: lì serve il tempo a OGNI fermata, altrimenti non si
 * possono calcolare i tempi di tratta né confrontarli col programmato, ed è
 * proprio quel confronto il motivo per cui il dato viene raccolto.
 *
 * COME SI COMPLETA. Non si interpola l'orario, si interpola lo SCARTO.
 *
 * Interpolare gli orari fra due fermate osservate distribuirebbe il tempo in
 * parti uguali, come se ogni tratta durasse quanto le altre — e non è vero:
 * fra due fermate in centro ci vogliono tre minuti, in periferia quaranta
 * secondi. L'orario programmato quelle proporzioni le conosce già. Quindi si
 * tiene il programmato come forma e gli si applica lo scarto misurato:
 *
 *     reale(K) = programmato(K) + scarto(K)
 *
 * dove lo scarto delle fermate intermedie si interpola fra i due scarti noti,
 * in proporzione al tempo programmato. Se a una fermata il mezzo aveva 60
 * secondi di ritardo e alla successiva 180, a metà strada — in termini di
 * tempo previsto — ne aveva 120.
 *
 * AI CAPOLINEA si estrapola invece di interpolare: prima della prima fermata
 * osservata e dopo l'ultima non c'è un secondo scarto con cui fare la media,
 * quindi si mantiene costante quello più vicino. È l'ipotesi più prudente:
 * dice "il mezzo ha continuato con lo stesso scarto", non inventa un recupero
 * o un peggioramento che nessuno ha misurato.
 *
 * OGNI VALORE PORTA LA SUA ORIGINE. Un orario calcolato non è un orario
 * misurato, e presentarli allo stesso modo renderebbe l'analisi inattendibile
 * proprio dove conta. Chi legge deve poter distinguere — e chi decide di
 * spostare un orario deve sapere su quante osservazioni vere si sta basando.
 *
 * Il completamento avviene IN LETTURA, non in scrittura: nel database restano
 * solo i passaggi realmente osservati. Così l'algoritmo può migliorare senza
 * riscrivere il passato, e non si perde mai la distinzione fra ciò che è
 * stato visto e ciò che è stato dedotto.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { scheduledSeconds, delayFromSchedule } from "./siri-vm";

/** Da dove viene l'orario di una fermata. */
export type OrigineOrario =
  /** il mezzo è stato visto passare */
  | "osservato"
  /** dedotto fra due passaggi osservati */
  | "interpolato"
  /** dedotto oltre l'ultimo passaggio osservato (capolinea) */
  | "estrapolato";

/** Una fermata della corsa come la prevede l'orario. */
export interface FermataProgrammata {
  seq: number;
  stopId: string;
  stopName?: string | null;
  /** "HH:MM:SS", anche oltre le 24 */
  scheduled: string | null;
}

/** Un passaggio realmente rilevato. */
export interface PassaggioOsservato {
  stopId: string;
  actualTs: Date;
  /** ritardo dichiarato dall'AVM, quando c'è */
  delaySeconds?: number | null;
}

export interface FermataCompletata {
  seq: number;
  stopId: string;
  stopName: string | null;
  scheduled: string | null;
  /** orario reale, osservato o ricostruito; null se non ricostruibile */
  actualTs: Date | null;
  /** scarto in secondi: positivo = ritardo */
  delaySeconds: number | null;
  origine: OrigineOrario | null;
}

export interface RisultatoCompletamento {
  fermate: FermataCompletata[];
  osservate: number;
  interpolate: number;
  estrapolate: number;
  /** fermate rimaste senza orario: né viste né ricostruibili */
  scoperte: number;
  /** quota di fermate con un orario reale misurato, non dedotto */
  coperturaOsservata: number;
  nota: string | null;
}

/** Uno scarto ancorato a una fermata, in secondi dalla mezzanotte. */
interface Ancora {
  i: number;          // indice nell'elenco delle fermate
  schedSec: number;
  delay: number;
  actualMs: number;
}

/**
 * Completa gli orari mancanti di una corsa.
 *
 * `fermate` è la sequenza programmata COMPLETA, in ordine di percorso;
 * `osservati` sono i passaggi realmente rilevati, anche solo alcuni.
 */
export function completeTransits(
  fermate: FermataProgrammata[],
  osservati: PassaggioOsservato[],
  timeZone = "Europe/Rome",
): RisultatoCompletamento {
  const out: FermataCompletata[] = fermate.map(f => ({
    seq: f.seq,
    stopId: f.stopId,
    stopName: f.stopName ?? null,
    scheduled: f.scheduled,
    actualTs: null,
    delaySeconds: null,
    origine: null,
  }));

  if (fermate.length === 0) {
    return {
      fermate: out, osservate: 0, interpolate: 0, estrapolate: 0, scoperte: 0,
      coperturaOsservata: 0, nota: "La corsa non ha fermate programmate.",
    };
  }

  /* Un passaggio per fermata: se la stessa fermata compare più volte si tiene
   * il primo, che è l'arrivo. Su un percorso circolare la stessa fermata può
   * ricorrere a progressivi diversi, ma il dato osservato non lo distingue —
   * meglio attribuirlo una volta sola che raddoppiarlo su entrambe. */
  const perFermata = new Map<string, PassaggioOsservato>();
  for (const o of osservati) {
    const p = perFermata.get(o.stopId);
    if (!p || o.actualTs.getTime() < p.actualTs.getTime()) perFermata.set(o.stopId, o);
  }

  /* Le ancore: le fermate osservate di cui si conosce anche il programmato.
   * Senza programmato lo scarto non è definito e non si può propagare. */
  const ancore: Ancora[] = [];
  for (let i = 0; i < fermate.length; i++) {
    const oss = perFermata.get(fermate[i].stopId);
    if (!oss) continue;
    out[i].actualTs = oss.actualTs;
    out[i].origine = "osservato";

    const schedSec = scheduledSeconds(fermate[i].scheduled);
    /* Lo scarto dichiarato dall'AVM ha la precedenza dove c'è: è la sua
     * misura. Altrimenti si calcola dal confronto col programmato. */
    const delay = oss.delaySeconds
      ?? delayFromSchedule(fermate[i].scheduled, oss.actualTs, timeZone);
    out[i].delaySeconds = delay;

    if (schedSec != null && delay != null) {
      ancore.push({ i, schedSec, delay, actualMs: oss.actualTs.getTime() });
    }
  }

  const osservate = out.filter(x => x.origine === "osservato").length;

  if (ancore.length === 0) {
    const scoperte = out.filter(x => x.actualTs == null).length;
    return {
      fermate: out, osservate, interpolate: 0, estrapolate: 0, scoperte,
      coperturaOsservata: fermate.length ? osservate / fermate.length : 0,
      nota: osservate === 0
        ? "Nessun passaggio osservato su questa corsa: non c'è nulla da cui "
          + "ricostruire gli orari mancanti."
        : "Passaggi osservati senza orario programmato con cui confrontarli: "
          + "gli scarti non sono calcolabili e i buchi restano tali.",
    };
  }

  /* Ricostruisce l'orario di una fermata dato il suo scarto, ancorandosi a un
   * passaggio osservato: si lavora sulle DIFFERENZE, così non serve sapere a
   * quale giorno civile appartenga la corsa — che con gli orari oltre le 24
   * ("25:10" = l'01:10 del giorno dopo) sarebbe una fonte di errori. */
  const ricostruisci = (schedSec: number, delay: number, a: Ancora): Date =>
    new Date(a.actualMs + ((schedSec - a.schedSec) + (delay - a.delay)) * 1000);

  let interpolate = 0;
  let estrapolate = 0;

  for (let i = 0; i < fermate.length; i++) {
    if (out[i].origine) continue;                       // già osservata
    const schedSec = scheduledSeconds(fermate[i].scheduled);
    if (schedSec == null) continue;                     // senza programmato non si deduce

    const prima = ultimaAncoraPrima(ancore, i);
    const dopo = primaAncoraDopo(ancore, i);

    if (prima && dopo) {
      /* Interpolazione dello SCARTO, in proporzione al tempo programmato.
       * Se le due ancore hanno lo stesso orario previsto — capita su fermate
       * a distanza di pochi secondi arrotondati al minuto — la proporzione
       * non è definita e si ripiega sulla posizione nella sequenza. */
      const arco = dopo.schedSec - prima.schedSec;
      const f = arco > 0
        ? (schedSec - prima.schedSec) / arco
        : (i - prima.i) / Math.max(1, dopo.i - prima.i);
      const delay = Math.round(prima.delay + (dopo.delay - prima.delay) * clamp01(f));
      out[i].delaySeconds = delay;
      out[i].actualTs = ricostruisci(schedSec, delay, prima);
      out[i].origine = "interpolato";
      interpolate++;
    } else {
      /* Oltre l'ultima osservazione (o prima della prima): si mantiene lo
       * scarto più vicino. Ipotesi prudente — "ha continuato così" — invece
       * di inventare un recupero che nessuno ha misurato. */
      const a = prima ?? dopo!;
      out[i].delaySeconds = a.delay;
      out[i].actualTs = ricostruisci(schedSec, a.delay, a);
      out[i].origine = "estrapolato";
      estrapolate++;
    }
  }

  const scoperte = out.filter(x => x.actualTs == null).length;
  const copertura = osservate / fermate.length;

  return {
    fermate: out,
    osservate, interpolate, estrapolate, scoperte,
    coperturaOsservata: Math.round(copertura * 1000) / 1000,
    nota: nota(osservate, interpolate, estrapolate, scoperte, fermate.length),
  };
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function ultimaAncoraPrima(ancore: Ancora[], i: number): Ancora | null {
  let r: Ancora | null = null;
  for (const a of ancore) { if (a.i < i) r = a; else break; }
  return r;
}

function primaAncoraDopo(ancore: Ancora[], i: number): Ancora | null {
  for (const a of ancore) if (a.i > i) return a;
  return null;
}

/** Quanto ci si può fidare del risultato, in una frase. */
function nota(
  oss: number, inter: number, estr: number, scoperte: number, totale: number,
): string | null {
  if (oss === totale) return null;                      // tutto misurato
  const parti: string[] = [];
  parti.push(`${oss} fermate su ${totale} misurate davvero`);
  if (inter > 0) parti.push(`${inter} ricostruite fra due passaggi`);
  if (estr > 0) parti.push(`${estr} stimate ai capolinea mantenendo lo scarto più vicino`);
  if (scoperte > 0) parti.push(`${scoperte} senza orario programmato, non ricostruibili`);
  const base = parti.join(", ") + ".";
  /* Sotto un terzo di fermate osservate il profilo della corsa è più dedotto
   * che misurato: si può guardare, non ci si può ritarare un orario. */
  return oss / totale < 0.34
    ? base + " Copertura bassa: il profilo è più dedotto che misurato, "
      + "prudenza prima di usarlo per ritarare l'orario."
    : base;
}
