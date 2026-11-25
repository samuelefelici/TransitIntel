/**
 * La pagina di accesso (tappe 7.33 e 7.34): che cosa racconta di Cerbero a chi
 * entra, e il nome con cui lo saluta. Funzioni pure, coi loro test.
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

/** I moduli di Cerbero, per la griglia «Dentro Cerbero» (tappa 7.34). */
export interface Modulo {
  chiave: "rete" | "turni" | "roster" | "esercizio" | "consuntivo" | "tariffe" | "dati" | "argos";
  titolo: string;
  sotto: string;
  testo: string;
}
export const MODULI: readonly Modulo[] = [
  { chiave: "rete", titolo: "Planning Studio", sotto: "Rete e orari", testo: "Linee, percorsi, fermate, corse e calendari, con la matrice di validità e il controllo del GTFS." },
  { chiave: "turni", titolo: "Fucina", sotto: "Turni macchina e turni guida", testo: "Ottimizzati con le regole del contratto, ritoccati a mano, pubblicati insieme." },
  { chiave: "roster", titolo: "Roster", sotto: "Personale", testo: "Il tabellone dei conducenti, le assenze col sostituto suggerito, le rotazioni." },
  { chiave: "esercizio", titolo: "Esercizio", sotto: "AVM e sala operativa", testo: "I mezzi in linea sulla mappa, i passaggi alle fermate, la diagnosi della giornata." },
  { chiave: "consuntivo", titolo: "Consuntivo", sotto: "Il mese chiuso", testo: "La giornata congelata, l'esito di ogni corsa, la chiusura del mese e il report." },
  { chiave: "tariffe", titolo: "Tariffe", sotto: "Polimetriche e zone", testo: "Fasce chilometriche, zone e prodotti, confrontati con la bigliettazione." },
  { chiave: "dati", titolo: "Dati aperti", sotto: "GTFS e NeTEx", testo: "GTFS completo di tariffe e NeTEx col profilo italiano, a indirizzi stabili." },
  { chiave: "argos", titolo: "Argos", sotto: "L'assistente", testo: "Legge e lavora su Planning Studio; ogni modifica aspetta la tua conferma." },
];

/** La sicurezza, detta com'è (tappa 7.34). */
export const SICUREZZA: readonly { titolo: string; testo: string }[] = [
  { titolo: "Verifica in due passaggi", testo: "Il codice dell'app sul telefono, con i codici di recupero. Obbligatoria per i ruoli che la richiedono." },
  { titolo: "Ruoli per area", testo: "Ognuno legge e scrive solo dove il suo ruolo lo permette, anche deposito per deposito." },
  { titolo: "Registro delle modifiche", testo: "Chi ha cambiato che cosa, e quando, nel database stesso. Si accende quando l'azienda lo decide." },
  { titolo: "Copie cifrate", testo: "Ogni notte una copia cifrata del database, fuori dal server, con la prova di ripristino." },
];

/** Il nastro che scorre sotto la prima schermata. */
export const NASTRO: readonly string[] = [
  "Planning Studio", "Matrice di validità", "Turni macchina", "Turni guida", "Roster", "Vestizione",
  "AVM", "Consuntivo", "Polimetriche", "GTFS", "NeTEx", "Argos", "Registro delle modifiche",
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
