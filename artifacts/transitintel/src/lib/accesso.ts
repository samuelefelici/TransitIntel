/**
 * La pagina di accesso (tappe 7.33–7.36): che cosa racconta di Cerbero a chi
 * entra, in italiano e in inglese, e il nome con cui lo saluta. Funzioni pure
 * e testi, coi loro test.
 *
 * Le regole dei testi:
 * - dicono solo quello che l'app fa davvero, niente promesse e niente slogan;
 * - titoli corti, che dicono che cosa c'è nella sezione (le citazioni della
 *   7.35 erano lunghe e coprivano le animazioni: tolte nella 7.36);
 * - i nomi dei sistemi (moduli, tappe, punti di Argos e della sicurezza, il
 *   nastro) sono in inglese anche nella pagina italiana; le descrizioni sono
 *   nella lingua della pagina;
 * - il ciclo segue il menu (lib/navigazione.ts), che è nell'ordine del lavoro
 *   dell'azienda: per questo le tappe hanno un numero e il nome della sezione
 *   del menu a cui corrispondono.
 */

export type Lingua = "it" | "en";
export const LINGUE: readonly Lingua[] = ["it", "en"];

/** Un titolo di sezione: la prima parte e quella messa in evidenza. */
export interface Titolo {
  prima: string;
  evidenza: string;
}

export interface TappaDelCiclo {
  numero: string;
  /** la sezione del menu (in italiano, come nel menu) */
  menu: string;
  titolo: string;
  testo: string;
}

/** I moduli di Cerbero, per la griglia «Dentro Cerbero». */
export interface Modulo {
  chiave: "rete" | "turni" | "roster" | "esercizio" | "consuntivo" | "tariffe" | "dati" | "pubblico";
  titolo: string;
  sotto: string;
  testo: string;
}

/** Come lavora Argos, il nucleo. */
export interface Pilastro {
  chiave: "squadra" | "biblioteca" | "dati" | "guardiano";
  titolo: string;
  testo: string;
}

export interface Voce {
  titolo: string;
  testo: string;
}

export interface TestiLanding {
  barra: { sezioni: string; argos: string; ciclo: string; moduli: string; sicurezza: string; accedi: string; torna: string; lingua: string };
  eroe: { occhiello: string; sottotitolo: string; testo: string; accedi: string; scopri: string; scorri: string; scorriEtichetta: string; ora: string };
  nastro: readonly string[];
  argos: { occhiello: string; titolo: Titolo; testo: string; pilastri: readonly Pilastro[] };
  ciclo: { occhiello: string; titolo: Titolo; testo: string; tappa: string; tappe: readonly TappaDelCiclo[] };
  moduli: { occhiello: string; titolo: Titolo; testo: string; elenco: readonly Modulo[] };
  sicurezza: { occhiello: string; titolo: Titolo; testo: string; elenco: readonly Voce[] };
  invito: { occhiello: string; titolo: Titolo; testo: string; bottone: string };
  piede: { riservato: string };
  accesso: {
    chiudi: string; area: string; titolo: string; sotto: string; email: string; segnaposto: string; password: string;
    mostra: string; nascondi: string; accedi: string; verifico: string; secondo: string; titoloMfa: string;
    aiutoCodice: string; aiutoRecupero: string; codice: string; codiceRecupero: string; verifica: string;
    usaApp: string; persoTelefono: string; indietro: string; note: readonly string[]; confermato: string;
  };
  visivi: { inLinea: string; tariffe: string };
}

/* I nomi dei sistemi, in inglese in tutte e due le lingue. */
const NASTRO = [
  "Argos · multi-agent RAG", "Planning Studio", "Validity Matrix", "Vehicle Scheduling", "Crew Scheduling", "Crew Rostering", "Duty Assignment",
  "AVL", "Service Reporting", "Distance Fare Tables", "GTFS", "NeTEx", "Audit Log",
] as const;
const SISTEMI = {
  tappe: ["Network & Timetables", "Scheduling", "Publishing", "Rostering", "Operations", "Service Reporting"],
  menu: ["Rete e orari", "Turni", "Pubblicazione", "Personale", "Esercizio", "Consuntivo"],
  moduli: {
    rete: ["Planning Studio", "Network & Timetables"],
    turni: ["Fucina", "Vehicle & Crew Scheduling"],
    roster: ["Roster", "Crew Rostering"],
    esercizio: ["Operations", "AVL & Control Room"],
    consuntivo: ["Service Reporting", "Monthly Close"],
    tariffe: ["Fares", "Distance Tables & Zones"],
    dati: ["Open Data", "GTFS & NeTEx"],
    pubblico: ["Passenger Information", "Prints, Maps & Links"],
  },
  pilastri: { squadra: "Agent Team", biblioteca: "Knowledge Library", dati: "Live Data", guardiano: "Guardrails" },
  sicurezza: ["Two-Factor Authentication", "Role-Based Access", "Audit Log", "Encrypted Backups"],
} as const;

function tappe(testi: readonly string[]): TappaDelCiclo[] {
  return testi.map((testo, i) => ({ numero: String(i + 1).padStart(2, "0"), menu: SISTEMI.menu[i]!, titolo: SISTEMI.tappe[i]!, testo }));
}
function moduli(testi: Record<Modulo["chiave"], string>): Modulo[] {
  return (Object.keys(SISTEMI.moduli) as Array<Modulo["chiave"]>).map((chiave) => ({
    chiave, titolo: SISTEMI.moduli[chiave][0], sotto: SISTEMI.moduli[chiave][1], testo: testi[chiave],
  }));
}
function pilastri(testi: Record<Pilastro["chiave"], string>): Pilastro[] {
  return (Object.keys(SISTEMI.pilastri) as Array<Pilastro["chiave"]>).map((chiave) => ({ chiave, titolo: SISTEMI.pilastri[chiave], testo: testi[chiave] }));
}
function sicurezza(testi: readonly string[]): Voce[] {
  return testi.map((testo, i) => ({ titolo: SISTEMI.sicurezza[i]!, testo }));
}

const IT: TestiLanding = {
  barra: { sezioni: "Sezioni", argos: "Argos", ciclo: "Il ciclo", moduli: "Moduli", sicurezza: "Sicurezza", accedi: "Accedi", torna: "Cerbero, torna all'inizio", lingua: "Lingua" },
  eroe: {
    occhiello: "Piattaforma per il trasporto pubblico locale",
    sottotitolo: "Transit Operations Platform",
    testo: "Rete, turni, personale ed esercizio in un unico sistema. Al centro c'è Argos, un RAG multiagente che conosce la tua rete e risponde alle tue domande.",
    accedi: "Accedi",
    scopri: "Guarda Argos",
    scorri: "Scorri",
    scorriEtichetta: "Scorri ad Argos",
    ora: "Ora locale",
  },
  nastro: NASTRO,
  argos: {
    occhiello: "Argos · AI core",
    titolo: { prima: "Un RAG multiagente", evidenza: "per il trasporto pubblico." },
    testo: "Argos recupera quello che serve dalla biblioteca dell'azienda e dai dati di Cerbero, ci ragiona con una squadra di agenti e verifica che ogni affermazione abbia una fonte. Sullo sfondo lo vedi lavorare su una domanda d'esempio.",
    pilastri: pilastri({
      squadra: "Più agenti, ognuno con il suo modello, le sue skill e i suoi strumenti, al lavoro sullo stesso compito.",
      biblioteca: "Documenti e procedure dell'azienda, divisi in passaggi e indicizzati per significato: la memoria da cui Argos recupera.",
      dati: "Gli strumenti di Argos leggono rete, orari, turni ed esercizio da Cerbero e lavorano sui progetti di Planning Studio.",
      guardiano: "Ogni strumento ha un effetto dichiarato e il guardiano decide chi può usarlo. Ogni esecuzione resta tracciata.",
    }),
  },
  ciclo: {
    occhiello: "Il ciclo del lavoro",
    titolo: { prima: "Dal programma", evidenza: "al consuntivo del mese." },
    testo: "Sei tappe, nell'ordine del menu e del lavoro dell'azienda. Quello che esce da una tappa è quello che entra nella successiva: niente copie, niente fogli a parte.",
    tappa: "Tappa",
    tappe: tappe([
      "Linee, percorsi, corse, calendari e validità in Planning Studio.",
      "Turni macchina e turni guida ottimizzati, con le regole del contratto.",
      "Turni al roster e orari al pubblico: stampe, mappe e link.",
      "Roster, assenze con il sostituto suggerito, vestizione per deposito.",
      "I mezzi in linea dall'AVM, sulla mappa e in sala operativa.",
      "La giornata congelata, l'esito di ogni corsa, la chiusura del mese.",
    ]),
  },
  moduli: {
    occhiello: "Dentro Cerbero",
    titolo: { prima: "Otto moduli", evidenza: "sugli stessi dati." },
    testo: "Una corsa cambiata in Planning Studio è la stessa che arriva ai turni, al roster, all'esercizio e al consuntivo. Ogni modulo lavora sul programma in vigore.",
    elenco: moduli({
      rete: "Linee, percorsi, fermate, corse e calendari, con la matrice di validità e il controllo del GTFS.",
      turni: "Turni macchina e turni guida ottimizzati con le regole del contratto, ritoccati a mano, pubblicati insieme.",
      roster: "Il tabellone dei conducenti, le assenze col sostituto suggerito, le rotazioni.",
      esercizio: "I mezzi in linea sulla mappa, i passaggi alle fermate, la diagnosi della giornata.",
      consuntivo: "La giornata congelata, l'esito di ogni corsa, la chiusura del mese e il report.",
      tariffe: "Fasce chilometriche, zone e prodotti, confrontati con la bigliettazione.",
      dati: "GTFS completo di tariffe e NeTEx col profilo italiano, a indirizzi stabili.",
      pubblico: "Gli orari da stampare, la mappa degli orari e la mappa della rete, da condividere con un link.",
    }),
  },
  sicurezza: {
    occhiello: "Sicurezza",
    titolo: { prima: "Chi entra,", evidenza: "e che cosa può fare." },
    testo: "I dati di un'azienda di trasporto sono anche i dati di chi ci lavora. Cerbero li tratta così.",
    elenco: sicurezza([
      "Il codice dell'app sul telefono, con i codici di recupero. Obbligatoria per i ruoli che la richiedono.",
      "Ognuno legge e scrive solo dove il suo ruolo lo permette, anche deposito per deposito.",
      "Chi ha cambiato che cosa, e quando, nel database stesso. Si accende quando l'azienda lo decide.",
      "Ogni notte una copia cifrata del database, fuori dal server, con la prova di ripristino.",
    ]),
  },
  invito: {
    occhiello: "Area riservata",
    titolo: { prima: "Entra in", evidenza: "Cerbero." },
    testo: "Con le credenziali che ti ha dato l'amministratore della tua azienda.",
    bottone: "Accedi a Cerbero",
  },
  piede: { riservato: "Accesso riservato al personale autorizzato" },
  accesso: {
    chiudi: "Chiudi l'accesso",
    area: "Area riservata",
    titolo: "Accedi a Cerbero",
    sotto: "Con le credenziali che ti ha dato l'amministratore della tua azienda.",
    email: "Email",
    segnaposto: "nome@azienda.it",
    password: "Password",
    mostra: "Mostra la password",
    nascondi: "Nascondi la password",
    accedi: "Accedi",
    verifico: "Verifico",
    secondo: "Secondo passaggio",
    titoloMfa: "Verifica in due passaggi",
    aiutoCodice: "Scrivi il codice a sei cifre che vedi adesso nell'app di autenticazione sul telefono.",
    aiutoRecupero: "Scrivi uno dei codici di recupero che hai salvato quando hai attivato la verifica. Ognuno vale una volta.",
    codice: "Codice",
    codiceRecupero: "Codice di recupero",
    verifica: "Verifica e accedi",
    usaApp: "Usa il codice dell'app",
    persoTelefono: "Ho perso il telefono: codice di recupero",
    indietro: "Indietro",
    note: ["Connessione cifrata e sessione legata a questo browser.", "Verifica in due passaggi per i ruoli che la richiedono."],
    confermato: "Accesso confermato",
  },
  visivi: { inLinea: "IN SERVICE", tariffe: "Fares" },
};

const EN: TestiLanding = {
  barra: { sezioni: "Sections", argos: "Argos", ciclo: "The cycle", moduli: "Modules", sicurezza: "Security", accedi: "Sign in", torna: "Cerbero, back to the top", lingua: "Language" },
  eroe: {
    occhiello: "Platform for local public transport",
    sottotitolo: "Transit Operations Platform",
    testo: "Network, duties, staff and operations in a single system. At its core is Argos, a multi-agent RAG that knows your network and answers your questions.",
    accedi: "Sign in",
    scopri: "Watch Argos",
    scorri: "Scroll",
    scorriEtichetta: "Scroll to Argos",
    ora: "Local time",
  },
  nastro: NASTRO,
  argos: {
    occhiello: "Argos · AI core",
    titolo: { prima: "A multi-agent RAG", evidenza: "for public transport." },
    testo: "Argos retrieves what it needs from the company's library and from Cerbero's data, reasons over it with a team of agents and checks that every claim has a source. In the background, you can watch it work on a sample question.",
    pilastri: pilastri({
      squadra: "Several agents, each with its own model, skills and tools, working on the same task.",
      biblioteca: "Company documents and procedures, split into passages and indexed by meaning: the memory Argos retrieves from.",
      dati: "Argos's tools read network, timetables, duties and operations from Cerbero and work on Planning Studio projects.",
      guardiano: "Every tool has a declared effect, and the guardian decides who may use it. Every run stays traced.",
    }),
  },
  ciclo: {
    occhiello: "The work cycle",
    titolo: { prima: "From the timetable", evidenza: "to the monthly report." },
    testo: "Six steps, in the order of the menu and of the company's work. What comes out of one step is what goes into the next: no copies, no side spreadsheets.",
    tappa: "Step",
    tappe: tappe([
      "Lines, routes, trips, calendars and validity in Planning Studio.",
      "Vehicle blocks and driver duties, optimised with the labour-agreement rules.",
      "Duties to the roster and timetables to the public: prints, maps and links.",
      "Roster, absences with a suggested replacement, duty assignment by depot.",
      "Vehicles in service from the AVL, on the map and in the control room.",
      "The frozen day, the outcome of every trip, the month-end close.",
    ]),
  },
  moduli: {
    occhiello: "Inside Cerbero",
    titolo: { prima: "Eight modules", evidenza: "on the same data." },
    testo: "A trip changed in Planning Studio is the same trip that reaches duties, the roster, operations and the service report. Every module works on the timetable in force.",
    elenco: moduli({
      rete: "Lines, routes, stops, trips and calendars, with the validity matrix and GTFS checks.",
      turni: "Vehicle blocks and driver duties optimised with the labour-agreement rules, refined by hand, published together.",
      roster: "The drivers' board, absences with a suggested replacement, rotations.",
      esercizio: "Vehicles in service on the map, passages at stops, the day's diagnosis.",
      consuntivo: "The frozen day, the outcome of every trip, the month-end close and the report.",
      tariffe: "Distance bands, zones and products, compared with the ticketing system.",
      dati: "Complete GTFS with fares, and NeTEx with the Italian profile, at stable addresses.",
      pubblico: "Printable timetables, the timetable map and the network map, shared with a link.",
    }),
  },
  sicurezza: {
    occhiello: "Security",
    titolo: { prima: "Who gets in,", evidenza: "and what they can do." },
    testo: "A transport company's data is also the data of the people who work there. Cerbero treats it that way.",
    elenco: sicurezza([
      "The code from the app on your phone, with recovery codes. Mandatory for the roles that require it.",
      "Everyone reads and writes only where their role allows, down to individual depots.",
      "Who changed what, and when, in the database itself. Switched on when the company decides.",
      "An encrypted copy of the database every night, off the server, with a restore test.",
    ]),
  },
  invito: {
    occhiello: "Restricted area",
    titolo: { prima: "Sign in to", evidenza: "Cerbero." },
    testo: "With the credentials your company administrator gave you.",
    bottone: "Sign in to Cerbero",
  },
  piede: { riservato: "Restricted to authorised staff" },
  accesso: {
    chiudi: "Close sign-in",
    area: "Restricted area",
    titolo: "Sign in to Cerbero",
    sotto: "With the credentials your company administrator gave you.",
    email: "Email",
    segnaposto: "name@company.com",
    password: "Password",
    mostra: "Show password",
    nascondi: "Hide password",
    accedi: "Sign in",
    verifico: "Checking",
    secondo: "Second step",
    titoloMfa: "Two-step verification",
    aiutoCodice: "Enter the six-digit code shown right now in the authenticator app on your phone.",
    aiutoRecupero: "Enter one of the recovery codes you saved when you turned on verification. Each one works once.",
    codice: "Code",
    codiceRecupero: "Recovery code",
    verifica: "Verify and sign in",
    usaApp: "Use the app code",
    persoTelefono: "Lost your phone? Use a recovery code",
    indietro: "Back",
    note: ["Encrypted connection, session tied to this browser.", "Two-step verification for the roles that require it."],
    confermato: "Access confirmed",
  },
  visivi: { inLinea: "IN SERVICE", tariffe: "Fares" },
};

export const TESTI: Readonly<Record<Lingua, TestiLanding>> = { it: IT, en: EN };

/** Il ciclo in italiano: un test controlla che segua il menu. */
export const CICLO = IT.ciclo.tappe;

/** La lingua della pagina: quella scelta l'ultima volta, se no quella del browser (italiano se è italiano, se no inglese). */
export function linguaIniziale(salvata: string | null | undefined, browser: string | null | undefined): Lingua {
  if (salvata === "it" || salvata === "en") return salvata;
  return (browser ?? "it").toLowerCase().startsWith("it") ? "it" : "en";
}

/* I messaggi del server sono in italiano: in inglese si traducono quelli dell'accesso, gli altri restano come sono. */
const ERRORI_EN: ReadonlyArray<[RegExp, (m: RegExpMatchArray) => string]> = [
  [/^Credenziali non valide$/, () => "Invalid credentials"],
  [/^Codice non valido$/, () => "Invalid code"],
  [/^Codice di recupero non valido$/, () => "Invalid recovery code"],
  [/^Codice già usato: aspetta il prossimo$/, () => "Code already used: wait for the next one"],
  [/^Tempo scaduto: inserisci di nuovo email e password$/, () => "Time is up: enter your email and password again"],
  [/^Utente non attivo$/, () => "User not active"],
  [/^Email e password obbligatori$/, () => "Email and password are required"],
  [/^Troppi tentativi di accesso, riprova tra un minuto\.$/, () => "Too many sign-in attempts, try again in a minute."],
  [/^Troppi tentativi sbagliati: riprova fra (\d+) minuti/, (m) => `Too many failed attempts: try again in ${m[1]} minutes, or ask the administrator to unlock the account.`],
  [/^Troppi codici sbagliati: riprova fra (\d+) minuti/, (m) => `Too many wrong codes: try again in ${m[1]} minutes, or ask the administrator to unlock the account.`],
  [/^Troppi tentativi sbagliati su questo account/, () => "Too many failed attempts on this account: try again later, or ask the administrator. Browsers you have already signed in from are not blocked."],
  [/^Questa password era pubblica/, () => "This password was publicly known: the account has been disabled. Ask the administrator to reactivate it with a new password."],
  [/^La verifica in due passaggi non è disponibile/, () => "Two-step verification is not available right now: tell the administrator."],
];

export function erroreInLingua(messaggio: string, lingua: Lingua): string {
  if (lingua === "it") return messaggio;
  for (const [regola, traduci] of ERRORI_EN) {
    const m = messaggio.match(regola);
    if (m) return traduci(m);
  }
  return messaggio;
}

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

/** Il saluto dopo l'accesso, uguale per tutti: «Buon lavoro, Ada», o solo «Buon lavoro»; in inglese «Welcome». */
export function saluto(nome: string, lingua: Lingua = "it"): string {
  const base = lingua === "en" ? "Welcome" : "Buon lavoro";
  return nome ? `${base}, ${nome}` : base;
}

/** Il codice dell'app di verifica: sei cifre, anche scritte con uno spazio in mezzo. */
export function codiceCompleto(codice: string): boolean {
  return /^\d{6}$/.test(codice.replace(/\s+/g, ""));
}
