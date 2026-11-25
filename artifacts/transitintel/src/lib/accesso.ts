/**
 * La pagina di accesso (tappe 7.33–7.35): che cosa racconta di Cerbero a chi
 * entra, in italiano e in inglese, e il nome con cui lo saluta. Funzioni pure
 * e testi, coi loro test.
 *
 * Le regole dei testi:
 * - dicono solo quello che l'app fa davvero, niente promesse;
 * - niente slogan inventati: i titoli delle sezioni sono citazioni vere, con
 *   autore e opera. Controllate alla fonte il 25/11/2026: Calvino, «Le città
 *   invisibili» (1972; in inglese la traduzione di William Weaver); Turing,
 *   «Computing Machinery and Intelligence» (Mind, 1950, l'ultima frase);
 *   Seneca, Lettere a Lucilio 71 (in inglese la traduzione di Richard M.
 *   Gummere); Kelvin, «Electrical Units of Measurement» (1883); Schneier,
 *   «The Process of Security» (2000); Jane Jacobs, «The Death and Life of
 *   Great American Cities» (1961). Le traduzioni italiane di Turing, Seneca,
 *   Kelvin, Schneier e Jacobs sono nostre;
 * - il ciclo segue il menu (lib/navigazione.ts), che è nell'ordine del lavoro
 *   dell'azienda: per questo le tappe hanno un numero.
 */

export type Lingua = "it" | "en";
export const LINGUE: readonly Lingua[] = ["it", "en"];

/** Una citazione: la prima parte, quella messa in evidenza, chi l'ha detta e dove. */
export interface Citazione {
  prima: string;
  evidenza: string;
  autore: string;
  fonte: string;
}

export interface TappaDelCiclo {
  numero: string;
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
  eroe: { occhiello: string; citazione: Citazione; testo: string; accedi: string; scopri: string; scorri: string; scorriEtichetta: string; ora: string };
  nastro: readonly string[];
  argos: { occhiello: string; citazione: Citazione; testo: string; nucleo: string; fonti: readonly string[]; agenti: string; pilastri: readonly Pilastro[] };
  ciclo: { occhiello: string; citazione: Citazione; testo: string; tappa: string; tappe: readonly TappaDelCiclo[] };
  moduli: { occhiello: string; citazione: Citazione; testo: string; elenco: readonly Modulo[] };
  sicurezza: { occhiello: string; citazione: Citazione; testo: string; elenco: readonly Voce[] };
  invito: { occhiello: string; citazione: Citazione; testo: string; bottone: string };
  piede: { riservato: string };
  accesso: {
    chiudi: string; area: string; titolo: string; sotto: string; email: string; segnaposto: string; password: string;
    mostra: string; nascondi: string; accedi: string; verifico: string; secondo: string; titoloMfa: string;
    aiutoCodice: string; aiutoRecupero: string; codice: string; codiceRecupero: string; verifica: string;
    usaApp: string; persoTelefono: string; indietro: string; note: readonly string[]; confermato: string;
  };
  visivi: { inLinea: string; tariffe: string };
}

const IT: TestiLanding = {
  barra: { sezioni: "Sezioni", argos: "Argos", ciclo: "Il ciclo", moduli: "Moduli", sicurezza: "Sicurezza", accedi: "Accedi", torna: "Cerbero, torna all'inizio", lingua: "Lingua" },
  eroe: {
    occhiello: "Cerbero · Piattaforma per il trasporto pubblico locale",
    citazione: {
      prima: "D'una città non godi le sette o le settantasette meraviglie,",
      evidenza: "ma la risposta che dà a una tua domanda.",
      autore: "Italo Calvino",
      fonte: "Le città invisibili, 1972",
    },
    testo: "Cerbero programma, pubblica, assegna e rendiconta il servizio di trasporto pubblico. Al centro c'è Argos, un sistema RAG multiagente che conosce la tua rete e risponde alle tue domande.",
    accedi: "Accedi",
    scopri: "Scopri Argos",
    scorri: "Scorri",
    scorriEtichetta: "Scorri ad Argos",
    ora: "Ora locale",
  },
  nastro: [
    "Argos · RAG multiagente", "Planning Studio", "Matrice di validità", "Turni macchina", "Turni guida", "Roster", "Vestizione",
    "AVM", "Consuntivo", "Polimetriche", "GTFS", "NeTEx", "Registro delle modifiche",
  ],
  argos: {
    occhiello: "Argos · il nucleo di Cerbero",
    citazione: {
      prima: "Possiamo vedere solo poco più avanti,",
      evidenza: "ma vediamo che lì c'è molto da fare.",
      autore: "Alan Turing",
      fonte: "Computing Machinery and Intelligence, 1950",
    },
    testo: "Argos è il nucleo di Cerbero: un sistema RAG multiagente per il trasporto pubblico. Recupera quello che serve dalla biblioteca dell'azienda e dai dati veri di Cerbero, ci ragiona con una squadra di agenti e lavora sui progetti insieme a te.",
    nucleo: "RAG multiagente",
    fonti: ["Biblioteca", "Rete e orari", "Turni", "Roster", "Esercizio", "Tariffe"],
    agenti: "agenti",
    pilastri: [
      { chiave: "squadra", titolo: "La squadra di agenti", testo: "Più agenti, ognuno con il suo modello, le sue skill e i suoi strumenti, al lavoro sullo stesso compito." },
      { chiave: "biblioteca", titolo: "La biblioteca", testo: "Documenti e procedure dell'azienda, convertiti, divisi in passaggi e indicizzati per significato: la memoria da cui Argos recupera." },
      { chiave: "dati", titolo: "I dati veri", testo: "Gli strumenti di Argos leggono rete, orari, turni ed esercizio da Cerbero e lavorano sui progetti di Planning Studio." },
      { chiave: "guardiano", titolo: "Il guardiano", testo: "Ogni strumento ha un effetto dichiarato e il guardiano decide chi può usarlo. Ogni esecuzione resta tracciata, passo per passo." },
    ],
  },
  ciclo: {
    occhiello: "Il ciclo del lavoro",
    citazione: {
      prima: "Per chi non sa a quale porto è diretto,",
      evidenza: "nessun vento è favorevole.",
      autore: "Seneca",
      fonte: "Lettere a Lucilio, 71",
    },
    testo: "Sei tappe, nell'ordine del menu e del lavoro dell'azienda. Quello che esce da una tappa è quello che entra nella successiva: niente copie, niente fogli a parte.",
    tappa: "Tappa",
    tappe: [
      { numero: "01", titolo: "Rete e orari", testo: "Linee, percorsi, corse, calendari e validità in Planning Studio." },
      { numero: "02", titolo: "Turni", testo: "Turni macchina e turni guida ottimizzati, con le regole del contratto." },
      { numero: "03", titolo: "Pubblicazione", testo: "Turni al roster e orari al pubblico: stampe, mappe e link." },
      { numero: "04", titolo: "Personale", testo: "Roster, assenze con il sostituto suggerito, vestizione per deposito." },
      { numero: "05", titolo: "Esercizio", testo: "I mezzi in linea dall'AVM, sulla mappa e in sala operativa." },
      { numero: "06", titolo: "Consuntivo", testo: "La giornata congelata, l'esito di ogni corsa, la chiusura del mese." },
    ],
  },
  moduli: {
    occhiello: "Dentro Cerbero",
    citazione: {
      prima: "Quando puoi misurare ciò di cui parli, ed esprimerlo in numeri,",
      evidenza: "ne sai qualcosa.",
      autore: "Lord Kelvin",
      fonte: "Electrical Units of Measurement, 1883",
    },
    testo: "Una corsa cambiata in Planning Studio è la stessa che arriva ai turni, al roster, all'esercizio e al consuntivo. Ogni modulo lavora sul programma in vigore.",
    elenco: [
      { chiave: "rete", titolo: "Planning Studio", sotto: "Rete e orari", testo: "Linee, percorsi, fermate, corse e calendari, con la matrice di validità e il controllo del GTFS." },
      { chiave: "turni", titolo: "Fucina", sotto: "Turni macchina e turni guida", testo: "Ottimizzati con le regole del contratto, ritoccati a mano, pubblicati insieme." },
      { chiave: "roster", titolo: "Roster", sotto: "Personale", testo: "Il tabellone dei conducenti, le assenze col sostituto suggerito, le rotazioni." },
      { chiave: "esercizio", titolo: "Esercizio", sotto: "AVM e sala operativa", testo: "I mezzi in linea sulla mappa, i passaggi alle fermate, la diagnosi della giornata." },
      { chiave: "consuntivo", titolo: "Consuntivo", sotto: "Il mese chiuso", testo: "La giornata congelata, l'esito di ogni corsa, la chiusura del mese e il report." },
      { chiave: "tariffe", titolo: "Tariffe", sotto: "Polimetriche e zone", testo: "Fasce chilometriche, zone e prodotti, confrontati con la bigliettazione." },
      { chiave: "dati", titolo: "Dati aperti", sotto: "GTFS e NeTEx", testo: "GTFS completo di tariffe e NeTEx col profilo italiano, a indirizzi stabili." },
      { chiave: "pubblico", titolo: "Orari al pubblico", sotto: "Stampe, mappe e link", testo: "Gli orari da stampare, la mappa degli orari e la mappa della rete, da condividere con un link." },
    ],
  },
  sicurezza: {
    occhiello: "Sicurezza",
    citazione: { prima: "La sicurezza è", evidenza: "un processo, non un prodotto.", autore: "Bruce Schneier", fonte: "The Process of Security, 2000" },
    testo: "I dati di un'azienda di trasporto sono anche i dati di chi ci lavora. Cerbero li tratta così.",
    elenco: [
      { titolo: "Verifica in due passaggi", testo: "Il codice dell'app sul telefono, con i codici di recupero. Obbligatoria per i ruoli che la richiedono." },
      { titolo: "Ruoli per area", testo: "Ognuno legge e scrive solo dove il suo ruolo lo permette, anche deposito per deposito." },
      { titolo: "Registro delle modifiche", testo: "Chi ha cambiato che cosa, e quando, nel database stesso. Si accende quando l'azienda lo decide." },
      { titolo: "Copie cifrate", testo: "Ogni notte una copia cifrata del database, fuori dal server, con la prova di ripristino." },
    ],
  },
  invito: {
    occhiello: "Area riservata",
    citazione: {
      prima: "Le città sono in grado di offrire qualcosa a tutti",
      evidenza: "solo perché, e solo quando, sono create da tutti.",
      autore: "Jane Jacobs",
      fonte: "Vita e morte delle grandi città, 1961",
    },
    testo: "Entra con le credenziali che ti ha dato l'amministratore della tua azienda.",
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
  visivi: { inLinea: "IN LINEA", tariffe: "Tariffe" },
};

const EN: TestiLanding = {
  barra: { sezioni: "Sections", argos: "Argos", ciclo: "The cycle", moduli: "Modules", sicurezza: "Security", accedi: "Sign in", torna: "Cerbero, back to the top", lingua: "Language" },
  eroe: {
    occhiello: "Cerbero · Platform for local public transport",
    citazione: {
      prima: "You take delight not in a city's seven or seventy wonders,",
      evidenza: "but in the answer it gives to a question of yours.",
      autore: "Italo Calvino",
      fonte: "Invisible Cities, 1972 (tr. William Weaver)",
    },
    testo: "Cerbero plans, publishes, assigns and reports public transport service. At its core is Argos, a multi-agent RAG system that knows your network and answers your questions.",
    accedi: "Sign in",
    scopri: "Discover Argos",
    scorri: "Scroll",
    scorriEtichetta: "Scroll to Argos",
    ora: "Local time",
  },
  nastro: [
    "Argos · multi-agent RAG", "Planning Studio", "Validity matrix", "Vehicle blocks", "Driver duties", "Roster", "Duty assignment",
    "AVL", "Service report", "Distance-based fares", "GTFS", "NeTEx", "Change log",
  ],
  argos: {
    occhiello: "Argos · the core of Cerbero",
    citazione: {
      prima: "We can only see a short distance ahead,",
      evidenza: "but we can see plenty there that needs to be done.",
      autore: "Alan Turing",
      fonte: "Computing Machinery and Intelligence, 1950",
    },
    testo: "Argos is the core of Cerbero: a multi-agent RAG system for public transport. It retrieves what it needs from the company's library and from Cerbero's live data, reasons over it with a team of agents and works on your projects with you.",
    nucleo: "multi-agent RAG",
    fonti: ["Library", "Network & timetables", "Duties", "Roster", "Operations", "Fares"],
    agenti: "agents",
    pilastri: [
      { chiave: "squadra", titolo: "The agent team", testo: "Several agents, each with its own model, skills and tools, working on the same task." },
      { chiave: "biblioteca", titolo: "The library", testo: "Company documents and procedures, converted, split into passages and indexed by meaning: the memory Argos retrieves from." },
      { chiave: "dati", titolo: "Live data", testo: "Argos's tools read network, timetables, duties and operations from Cerbero and work on Planning Studio projects." },
      { chiave: "guardiano", titolo: "The guardian", testo: "Every tool has a declared effect, and the guardian decides who may use it. Every run is traced, step by step." },
    ],
  },
  ciclo: {
    occhiello: "The work cycle",
    citazione: {
      prima: "When a man does not know what harbour he is making for,",
      evidenza: "no wind is the right wind.",
      autore: "Seneca",
      fonte: "Letters to Lucilius, 71 (tr. Richard M. Gummere)",
    },
    testo: "Six steps, in the order of the menu and of the company's work. What comes out of one step is what goes into the next: no copies, no side spreadsheets.",
    tappa: "Step",
    tappe: [
      { numero: "01", titolo: "Network & timetables", testo: "Lines, routes, trips, calendars and validity in Planning Studio." },
      { numero: "02", titolo: "Scheduling", testo: "Vehicle blocks and driver duties, optimised with the labour-agreement rules." },
      { numero: "03", titolo: "Publishing", testo: "Duties to the roster and timetables to the public: prints, maps and links." },
      { numero: "04", titolo: "Staff", testo: "Roster, absences with a suggested replacement, duty assignment by depot." },
      { numero: "05", titolo: "Operations", testo: "Vehicles in service from the AVL, on the map and in the control room." },
      { numero: "06", titolo: "Service report", testo: "The frozen day, the outcome of every trip, the month-end close." },
    ],
  },
  moduli: {
    occhiello: "Inside Cerbero",
    citazione: {
      prima: "When you can measure what you are speaking about, and express it in numbers,",
      evidenza: "you know something about it.",
      autore: "Lord Kelvin",
      fonte: "Electrical Units of Measurement, 1883",
    },
    testo: "A trip changed in Planning Studio is the same trip that reaches duties, the roster, operations and the service report. Every module works on the timetable in force.",
    elenco: [
      { chiave: "rete", titolo: "Planning Studio", sotto: "Network & timetables", testo: "Lines, routes, stops, trips and calendars, with the validity matrix and GTFS checks." },
      { chiave: "turni", titolo: "Fucina", sotto: "Vehicle blocks & driver duties", testo: "Optimised with the labour-agreement rules, refined by hand, published together." },
      { chiave: "roster", titolo: "Roster", sotto: "Staff", testo: "The drivers' board, absences with a suggested replacement, rotations." },
      { chiave: "esercizio", titolo: "Operations", sotto: "AVL & control room", testo: "Vehicles in service on the map, passages at stops, the day's diagnosis." },
      { chiave: "consuntivo", titolo: "Service report", sotto: "The closed month", testo: "The frozen day, the outcome of every trip, the month-end close and the report." },
      { chiave: "tariffe", titolo: "Fares", sotto: "Distance tables & zones", testo: "Distance bands, zones and products, compared with the ticketing system." },
      { chiave: "dati", titolo: "Open data", sotto: "GTFS & NeTEx", testo: "Complete GTFS with fares, and NeTEx with the Italian profile, at stable addresses." },
      { chiave: "pubblico", titolo: "Passenger information", sotto: "Prints, maps & links", testo: "Printable timetables, the timetable map and the network map, shared with a link." },
    ],
  },
  sicurezza: {
    occhiello: "Security",
    citazione: { prima: "Security is", evidenza: "a process, not a product.", autore: "Bruce Schneier", fonte: "The Process of Security, 2000" },
    testo: "A transport company's data is also the data of the people who work there. Cerbero treats it that way.",
    elenco: [
      { titolo: "Two-step verification", testo: "The code from the app on your phone, with recovery codes. Mandatory for the roles that require it." },
      { titolo: "Role-based areas", testo: "Everyone reads and writes only where their role allows, down to individual depots." },
      { titolo: "Change log", testo: "Who changed what, and when, in the database itself. Switched on when the company decides." },
      { titolo: "Encrypted backups", testo: "An encrypted copy of the database every night, off the server, with a restore test." },
    ],
  },
  invito: {
    occhiello: "Restricted area",
    citazione: {
      prima: "Cities have the capability of providing something for everybody,",
      evidenza: "only because, and only when, they are created by everybody.",
      autore: "Jane Jacobs",
      fonte: "The Death and Life of Great American Cities, 1961",
    },
    testo: "Sign in with the credentials your company administrator gave you.",
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
