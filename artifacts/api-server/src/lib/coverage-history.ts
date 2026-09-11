/**
 * ═══════════════════════════════════════════════════════════════════════════
 * QUANTO VEDIAMO DAVVERO — la copertura del monitoraggio, e cosa la limita
 * ───────────────────────────────────────────────────────────────────────────
 * Ogni numero del prodotto — puntualità, percorrenze, anomalie — vale quanto
 * la frazione di servizio che il flusso ci lascia vedere. Quella frazione non
 * è mai stata misurata: si sapeva che era bassa, non quanto, né se stesse
 * migliorando o peggiorando.
 *
 * Serve a due cose diverse, e la seconda è il motivo per cui è scritta qui e
 * non in una query buttata in una pagina:
 *
 *   1. Sapere se un numero regge. Una puntualità calcolata sul 9% delle corse
 *      non è la puntualità dell'azienda, è quella di un campione che nessuno
 *      ha scelto.
 *
 *   2. Dire al fornitore CHE COSA cambierebbe alzando la frequenza. "Vorremmo
 *      un refresh più frequente" è un desiderio; "a 60 secondi un mezzo a 30
 *      km/h percorre mezzo chilometro fra due letture, e ne bastano 60 metri
 *      per riconoscere una fermata" è un argomento.
 *
 * ── Il conto che lega l'intervallo a ciò che si riesce a misurare ──
 *
 * Per riconoscere il passaggio da una fermata serve almeno una lettura mentre
 * il mezzo è dentro il raggio. Un mezzo che passa senza fermarsi ci resta
 * dentro per 2R/v secondi: a 60 m di raggio e 30 km/h sono quattordici
 * secondi. Se le letture arrivano ogni G secondi con fase qualunque, la
 * probabilità che una cada in quella finestra è la finestra diviso G.
 *
 * È un LIMITE INFERIORE, e va detto: quando il mezzo si ferma davvero, la
 * finestra si allunga di tutta la sosta e il passaggio diventa quasi certo.
 * Per questo la copertura osservata è di norma più alta di questa stima — e
 * la differenza fra le due è l'unica traccia che abbiamo delle fermate
 * effettivamente servite.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** Raggio entro cui una lettura vale come passaggio dalla fermata. */
export const RAGGIO_M = 60;
/** Velocità commerciale tipica di un urbano, in m/s (≈30 km/h). */
export const VELOCITA_MS = 30_000 / 3600;

/* ── Copertura giorno per giorno ──────────────────────────────────────────── */

/** Una giornata di esercizio, come risulta da ciò che abbiamo scritto. */
export interface GiornataOsservata {
  day: string;
  /** matricole distinte viste nel flusso */
  vetture: number;
  /** vetture con almeno una posizione utilizzabile scritta */
  vettureConPosizione: number;
  /** corse del feed che circolavano quel giorno */
  corseProgrammate: number | null;
  /** corse per cui abbiamo almeno un transito */
  corseConTransito: number;
  /** passaggi alle fermate registrati */
  transiti: number;
  /** fermate programmate sulle corse che abbiamo seguito */
  fermateProgrammate: number;
  /** distanza tipica fra due letture consecutive dello stesso mezzo */
  passoLettureSec: number | null;
}

export interface GiornataCopertura extends GiornataOsservata {
  /** quota di corse programmate di cui vediamo almeno un passaggio */
  quotaCorse: number | null;
  /** quota di fermate rilevate sulle corse seguite */
  quotaFermate: number | null;
}

/* ── Cosa si può misurare a un dato intervallo ────────────────────────────── */

export interface CapacitaDiMisura {
  intervalloSec: number;
  /** metri percorsi fra due letture, a velocità commerciale */
  passoMetri: number;
  /** quota di passaggi riconoscibili su un mezzo che NON si ferma */
  quotaMinima: number;
  /** cosa diventa possibile o impossibile a questo intervallo */
  cosaComporta: string;
}

/**
 * Quanto di ciò che succede è riconoscibile con letture ogni `intervalloSec`.
 *
 * Il conto è geometrico e dichiara le sue assunzioni: velocità commerciale
 * costante, passaggio che attraversa il raggio, fasi delle letture
 * indipendenti dal passaggio. Serve a confrontare INTERVALLI fra loro, non a
 * predire una cifra esatta.
 */
export function capacitaDiMisura(
  intervalloSec: number, velocitaMs = VELOCITA_MS, raggioM = RAGGIO_M,
): CapacitaDiMisura {
  const passoMetri = Math.round(velocitaMs * intervalloSec);
  const finestraSec = (2 * raggioM) / velocitaMs;
  const quota = Math.min(1, finestraSec / intervalloSec);
  return {
    intervalloSec,
    passoMetri,
    quotaMinima: Math.round(quota * 100) / 100,
    cosaComporta: commento(intervalloSec, passoMetri, quota),
  };
}

function commento(intervallo: number, passo: number, quota: number): string {
  if (quota >= 0.95) {
    return `Ogni passaggio viene riconosciuto, anche senza sosta. A ${intervallo} s `
      + `il mezzo percorre ${passo} m fra due letture: meno del raggio di una fermata.`;
  }
  if (quota >= 0.5) {
    return `Circa ${Math.round(quota * 100)}% dei passaggi è riconoscibile senza `
      + `contare le soste (${passo} m fra due letture). Con le soste si arriva `
      + "vicini alla totalità sulle fermate davvero servite.";
  }
  if (quota >= 0.2) {
    return `Solo ${Math.round(quota * 100)}% dei passaggi è riconoscibile senza sosta: `
      + `${passo} m fra due letture contro ${2 * RAGGIO_M} m di finestra utile. `
      + "Le fermate non servite diventano invisibili, e con loro la differenza "
      + "fra «non rilevata» e «non effettuata».";
  }
  return `A ${intervallo} s il mezzo percorre ${passo} m fra due letture: le fermate `
    + "si superano fra un rilevamento e l'altro. Quello che si ottiene non è un "
    + "elenco di passaggi, è un campione casuale di passaggi.";
}

/** Il confronto fra intervalli: è la tabella da mettere in una richiesta. */
export function scalaIntervalli(
  intervalli = [10, 15, 30, 60, 120, 300],
  velocitaMs = VELOCITA_MS, raggioM = RAGGIO_M,
): CapacitaDiMisura[] {
  return intervalli.map(i => capacitaDiMisura(i, velocitaMs, raggioM));
}

/* ── Quadro d'insieme ─────────────────────────────────────────────────────── */

export type Andamento = "in_miglioramento" | "stabile" | "in_peggioramento" | "indeterminato";

export interface QuadroCopertura {
  giorni: GiornataCopertura[];
  /** quota tipica di corse viste, sull'intero periodo */
  quotaCorseMediana: number | null;
  /** quota tipica di fermate rilevate sulle corse seguite */
  quotaFermateMediana: number | null;
  passoLettureMedianoSec: number | null;
  andamento: Andamento;
  /** cosa ci si può aspettare all'intervallo che abbiamo davvero */
  capacitaAttuale: CapacitaDiMisura | null;
  /**
   * Differenza fra copertura osservata e stima senza soste. Positiva = i mezzi
   * si fermano, e le soste allungano la finestra utile: è l'unica traccia che
   * abbiamo delle fermate effettivamente servite.
   */
  margineDaSoste: number | null;
  nota: string;
}

function mediana(v: number[]): number | null {
  if (v.length === 0) return null;
  const s = [...v].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Confronta la prima metà del periodo con la seconda.
 *
 * Con poche giornate non si pronuncia: due giorni buoni dopo due cattivi non
 * sono una tendenza, e chiamarli così farebbe annunciare miglioramenti che
 * non esistono.
 */
function andamentoDa(quote: Array<number | null>): Andamento {
  const v = quote.filter((x): x is number => x != null);
  if (v.length < 6) return "indeterminato";
  const meta = Math.floor(v.length / 2);
  const prima = mediana(v.slice(0, meta));
  const dopo = mediana(v.slice(-meta));
  if (prima == null || dopo == null || prima === 0) return "indeterminato";
  const variazione = (dopo - prima) / prima;
  if (variazione > 0.15) return "in_miglioramento";
  if (variazione < -0.15) return "in_peggioramento";
  return "stabile";
}

export function quadroCopertura(
  osservate: GiornataOsservata[],
  intervalloConfiguratoSec: number | null,
): QuadroCopertura {
  const giorni: GiornataCopertura[] = [...osservate]
    .sort((a, b) => a.day.localeCompare(b.day))
    .map(g => ({
      ...g,
      quotaCorse: g.corseProgrammate && g.corseProgrammate > 0
        ? Math.round((g.corseConTransito / g.corseProgrammate) * 1000) / 1000
        : null,
      quotaFermate: g.fermateProgrammate > 0
        ? Math.round((g.transiti / g.fermateProgrammate) * 1000) / 1000
        : null,
    }));

  const quotaCorseMediana = mediana(giorni.map(g => g.quotaCorse).filter((x): x is number => x != null));
  const quotaFermateMediana = mediana(giorni.map(g => g.quotaFermate).filter((x): x is number => x != null));
  const passoMediano = mediana(giorni.map(g => g.passoLettureSec).filter((x): x is number => x != null));

  /* L'intervallo VERO è quello che si misura sulle letture, non quello che
   * abbiamo configurato: se il fornitore aggiorna più di rado di quanto
   * chiediamo, è il suo passo a decidere cosa possiamo vedere. */
  const intervalloEffettivo = passoMediano ?? intervalloConfiguratoSec;
  const capacita = intervalloEffettivo != null ? capacitaDiMisura(intervalloEffettivo) : null;

  const margine = capacita != null && quotaFermateMediana != null
    ? Math.round((quotaFermateMediana - capacita.quotaMinima) * 100) / 100
    : null;

  return {
    giorni,
    quotaCorseMediana,
    quotaFermateMediana,
    passoLettureMedianoSec: passoMediano,
    andamento: andamentoDa(giorni.map(g => g.quotaCorse)),
    capacitaAttuale: capacita,
    margineDaSoste: margine,
    nota: riassumi(giorni, quotaCorseMediana, quotaFermateMediana, capacita, margine),
  };
}

function riassumi(
  giorni: GiornataCopertura[],
  quotaCorse: number | null,
  quotaFermate: number | null,
  capacita: CapacitaDiMisura | null,
  margine: number | null,
): string {
  if (giorni.length === 0) {
    return "Nessuna giornata con dati di esercizio nel periodo richiesto.";
  }
  if (quotaCorse == null) {
    return `${giorni.length} giornate con dati, ma non si sa quante corse fossero `
      + "programmate: senza il calendario del feed la copertura non è calcolabile.";
  }

  const pezzi = [
    `Di norma vediamo almeno un passaggio sul ${Math.round(quotaCorse * 100)}% `
    + "delle corse programmate",
  ];
  if (quotaFermate != null) {
    pezzi.push(`e ${Math.round(quotaFermate * 100)}% delle fermate di quelle corse`);
  }

  let testo = pezzi.join(" ") + ".";

  if (capacita) {
    testo += ` Con letture ogni ${capacita.intervalloSec} s il mezzo percorre `
      + `${capacita.passoMetri} m fra una e l'altra: ${capacita.cosaComporta.toLowerCase()}`;
  }

  /* Il margine è l'unico indizio quantitativo sulle soste: va spiegato, non
   * lasciato come numero. */
  if (margine != null && margine > 0.05) {
    testo += ` Rileviamo ${Math.round(margine * 100)} punti percentuali in più di `
      + "quanto la sola geometria spiegherebbe: la differenza viene dalle soste, "
      + "cioè dalle fermate davvero servite.";
  } else if (margine != null && margine < -0.05) {
    testo += ` Rileviamo ${Math.round(-margine * 100)} punti percentuali in MENO di `
      + "quanto la geometria consentirebbe: non è l'intervallo a limitarci, ma "
      + "quante vetture vengono seguite.";
  }

  return testo;
}
