/**
 * Fino a quando ha corse un GTFS (tappa 6.45). Pura: niente database.
 *
 * Un programma in esercizio può avere tutte le corse in giorni già passati:
 * succede quando il periodo delle corse viene da un GTFS importato che copriva
 * un giorno solo (lo segnala anche il controllo di salute di Planning Studio).
 * Pubblicarlo fra i dati aperti vorrebbe dire dare al NAP un file scaduto: i
 * dati aperti non lo pubblicano, gli export lo dicono in cima al messaggio.
 */
import type { Gtfs } from "./gtfs-verifica";
import { giorniDiServizio } from "./netex";

/** Oggi a Roma, «YYYY-MM-DD». */
export const oggiDiRoma = (d: Date = new Date()): string =>
  new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Rome" }).format(d);

/** L'ultimo giorno in cui c'è almeno una corsa («YYYY-MM-DD»), dai calendari delle corse; null se nessuna corsa ha giorni. */
export function ultimoGiornoDiServizio(g: Gtfs): string | null {
  const giorni = giorniDiServizio(g);
  const usati = new Set((g["trips.txt"]?.righe ?? []).map((t) => String(t.service_id ?? "").trim()));
  let ultimo: string | null = null;
  for (const s of usati) {
    const l = giorni.get(s);
    const u = l?.[l.length - 1];
    if (u && (ultimo === null || u > ultimo)) ultimo = u;
  }
  return ultimo;
}

/** L'ultimo giorno di servizio, se è già passato rispetto a `oggi` («YYYY-MM-DD»); altrimenti null. */
export function scadutoIl(g: Gtfs, oggi: string): string | null {
  const ultimo = ultimoGiornoDiServizio(g);
  return ultimo !== null && ultimo < oggi ? ultimo : null;
}

/** «GG/MM/AAAA». */
export const giornoItaliano = (iso: string): string => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

/** Perché un programma scaduto non si pubblica, e dove si corregge. */
export const motivoScaduto = (ultimo: string): string =>
  `Il programma in esercizio ha corse solo fino al ${giornoItaliano(ultimo)}, giorno già passato: il file non si pubblica, `
  + "perché chi lo scarica lo troverebbe scaduto. Si corregge in Planning Studio: nelle Corse si selezionano e si allarga il «Periodo», "
  + "poi si rimette in esercizio il programma";
