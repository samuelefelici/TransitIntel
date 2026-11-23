/**
 * Le copie del database fuori dal server, nella pagina dell'amministratore
 * (tappa 7.23): le etichette degli stati e il giudizio sull'ultima copia.
 */
export type StatoCopia = "chiesta" | "in_corso" | "riuscita" | "fallita" | "interrotta";

export interface Copia {
  id: string;
  stato: StatoCopia;
  chiestaDa: string | null;
  creataIl: string;
  iniziataIl: string | null;
  finitaIl: string | null;
  oggetto: string | null;
  byte: number | null;
  sha256: string | null;
  tabelle: number | null;
  versione: string | null;
  /** le tabelle saltate perché il ruolo della copia non le legge */
  escluse: string[];
  errore: string | null;
}

export const ETICHETTE_STATO: Record<StatoCopia, { testo: string; classe: string }> = {
  chiesta: { testo: "chiesta", classe: "bg-sky-100 text-sky-900 dark:bg-sky-900/40 dark:text-sky-100" },
  in_corso: { testo: "in corso", classe: "bg-sky-100 text-sky-900 dark:bg-sky-900/40 dark:text-sky-100" },
  riuscita: { testo: "riuscita", classe: "bg-emerald-100 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-100" },
  fallita: { testo: "non riuscita", classe: "bg-red-100 text-red-900 dark:bg-red-900/40 dark:text-red-100" },
  interrotta: { testo: "interrotta", classe: "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-100" },
};

/** Oltre questo tempo dall'ultima copia riuscita la pagina avvisa: la notte è saltata. */
export const ORE_AVVISO = 36;

/** Il giudizio sull'ultima copia riuscita. */
export function statoCopie(ultima: Copia | null, adesso: Date): { livello: "bene" | "attenzione"; titolo: string; dettaglio: string } {
  if (!ultima) {
    return {
      livello: "attenzione",
      titolo: "Nessuna copia riuscita",
      dettaglio: "Finché non ce n'è una, un guasto del server può far perdere i dati. Il lavoratore va impostato con le variabili BACKUP_* (DEPLOY.md, «Copia del database fuori dal server»); poi «Fai una copia adesso» la prova.",
    };
  }
  const ore = (adesso.getTime() - new Date(ultima.finitaIl ?? ultima.creataIl).getTime()) / 3_600_000;
  if (ore > ORE_AVVISO) {
    return {
      livello: "attenzione",
      titolo: "L'ultima copia riuscita è vecchia",
      dettaglio: `È di ${etaCopia(ultima.finitaIl ?? ultima.creataIl, adesso)}: le copie della notte non riescono. Il motivo è nelle righe qui sotto e nel log del lavoratore.`,
    };
  }
  return {
    livello: "bene",
    titolo: "Copie in regola",
    dettaglio: "L'ultima copia è stata caricata e riscaricata uguale. La prova di ripristino con la chiave privata va fatta ogni tanto (DEPLOY.md).",
  };
}

/** «3 ore fa», «2 giorni fa». */
export function etaCopia(quando: string, adesso: Date): string {
  const minuti = Math.max(0, Math.round((adesso.getTime() - new Date(quando).getTime()) / 60_000));
  if (minuti < 2) return "adesso";
  if (minuti < 90) return `${minuti} minuti fa`;
  const ore = Math.round(minuti / 60);
  if (ore < 36) return `${ore} ${ore === 1 ? "ora" : "ore"} fa`;
  const giorni = Math.round(ore / 24);
  return `${giorni} giorni fa`;
}

export function megabyte(byte: number | null): string {
  if (byte == null) return "—";
  return `${(byte / 1_000_000).toLocaleString("it-IT", { maximumFractionDigits: 1 })} MB`;
}
