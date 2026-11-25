/**
 * La pagina di accesso (tappa 7.33): che cosa racconta di Cerbero a chi entra,
 * e il nome con cui lo saluta. Funzioni pure, coi loro test.
 *
 * Il ciclo segue il menu (lib/navigazione.ts), che è nell'ordine del lavoro
 * dell'azienda: per questo le tappe hanno un numero. Le affermazioni devono
 * restare vere: niente promesse che l'app non mantiene.
 */

export interface TappaDelCiclo {
  numero: string;
  titolo: string;
  testo: string;
}

/** Il lavoro dell'azienda, dal programma al consuntivo del mese. */
export const CICLO: readonly TappaDelCiclo[] = [
  { numero: "01", titolo: "Rete e orari", testo: "Linee, percorsi, corse, calendari e validità in Planning Studio." },
  { numero: "02", titolo: "Turni", testo: "Turni macchina e turni guida ottimizzati, con le regole del contratto." },
  { numero: "03", titolo: "Pubblicazione", testo: "Turni al roster e orari al pubblico: stampe, mappe e link." },
  { numero: "04", titolo: "Personale", testo: "Roster, assenze con il sostituto suggerito, vestizione per deposito." },
  { numero: "05", titolo: "Esercizio", testo: "I mezzi in linea dall'AVM, sulla mappa e in sala operativa." },
  { numero: "06", titolo: "Consuntivo", testo: "La giornata congelata, l'esito di ogni corsa, la chiusura del mese." },
];

/** Quello che sta accanto al ciclo, per tutto l'anno. */
export const ACCANTO: readonly { titolo: string; testo: string }[] = [
  { titolo: "Tariffe", testo: "Polimetriche, zone e prodotti, con il confronto con la bigliettazione." },
  { titolo: "Dati aperti", testo: "GTFS completo di tariffe e NeTEx con il profilo italiano." },
  { titolo: "Argos", testo: "L'assistente che legge e lavora su Planning Studio, con la tua conferma." },
  { titolo: "Sicurezza", testo: "Verifica in due passaggi, ruoli per area, copie cifrate del database." },
];

/** Il nome per il saluto: il nome di battesimo, o la parte più lunga dell'email; vuoto se non c'è niente. */
export function nomeDiBenvenuto(fullName: string | null | undefined, email: string | null | undefined): string {
  const pulito = (fullName ?? "").replace(/\([^)]*\)/g, "").trim();
  if (pulito) return pulito.split(/\s+/)[0]!;
  const e = (email ?? "").trim();
  if (e.includes("@")) {
    const parti = e.split("@")[0]!.split(/[.\-_]+/).filter(Boolean);
    const piuLunga = [...parti].sort((a, b) => b.length - a.length)[0];
    if (piuLunga) return piuLunga.charAt(0).toUpperCase() + piuLunga.slice(1);
  }
  return "";
}

/** Il saluto dopo l'accesso, uguale per tutti: «Buon lavoro, Ada», o solo «Buon lavoro». */
export function saluto(nome: string): string {
  return nome ? `Buon lavoro, ${nome}` : "Buon lavoro";
}

/** Il codice dell'app di verifica: sei cifre, anche scritte con uno spazio in mezzo. */
export function codiceCompleto(codice: string): boolean {
  return /^\d{6}$/.test(codice.replace(/\s+/g, ""));
}
