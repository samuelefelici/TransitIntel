/**
 * Dizionario centralizzato stringhe UI — Italiano.
 *
 * Tutte le label, messaggi e testi dell'interfaccia sono qui.
 * Se in futuro servisse l'inglese, basterà aggiungere un `en.ts`
 * e uno switch su `navigator.language`.
 */

export const t = {
  // ── Navigazione ─────────────────────────────────────────────
  nav: {
    dashboard: "Cruscotto",
    traffic: "Traffico",
    territory: "Territorio",
    stops: "Fermate",
    routes: "Linee",
    gtfs: "Dati GTFS",
    travelTime: "Tempi di Percorrenza",
    sync: "Sincronizzazione",
    demand: "Domanda",
    segments: "Segmenti",
    scenarios: "Scenari",
    intermodal: "Intermodale",
    optimizerRoute: "Ottimizzatore Percorsi",
    optimizerSchedule: "Ottimizzatore Orari",
    driverShifts: "Turni Guida",
    clusterManagement: "Gestione Cluster",
    coincidenceZones: "Zone di Coincidenza",
    reports: "Report",
    settings: "Impostazioni",
    logout: "Esci",
  },

  // ── Azioni comuni ───────────────────────────────────────────
  actions: {
    save: "Salva",
    cancel: "Annulla",
    delete: "Elimina",
    edit: "Modifica",
    add: "Aggiungi",
    create: "Crea",
    upload: "Carica",
    download: "Scarica",
    export: "Esporta",
    import: "Importa",
    search: "Cerca",
    filter: "Filtra",
    refresh: "Aggiorna",
    retry: "Riprova",
    confirm: "Conferma",
    close: "Chiudi",
    back: "Indietro",
    next: "Avanti",
    run: "Esegui",
    stop: "Ferma",
    reset: "Ripristina",
    selectAll: "Seleziona tutto",
    deselectAll: "Deseleziona tutto",
    compare: "Confronta",
    generate: "Genera",
    optimize: "Ottimizza",
  },

  // ── Stato / feedback ───────────────────────────────────────
  status: {
    loading: "Caricamento in corso…",
    saving: "Salvataggio in corso…",
    noData: "Nessun dato disponibile",
    noResults: "Nessun risultato",
    success: "Operazione completata",
    error: "Si è verificato un errore",
    errorRetry: "Errore. Riprova più tardi.",
    networkError: "Errore di connessione al server",
    notFound: "Risorsa non trovata",
    unauthorized: "Accesso non autorizzato",
    forbidden: "Accesso negato",
    tooManyRequests: "Troppe richieste, riprova tra un minuto",
    deleted: "Eliminato con successo",
    saved: "Salvato con successo",
    uploaded: "Caricato con successo",
  },

  // ── Login ──────────────────────────────────────────────────
  login: {
    title: "Accesso",
    subtitle: "Piattaforma di Analisi e Pianificazione del Trasporto Pubblico Locale",
    username: "Nome utente",
    password: "Password",
    signIn: "Accedi",
    invalidCredentials: "Credenziali non valide",
  },

  // ── GTFS ──────────────────────────────────────────────────
  gtfs: {
    uploadTitle: "Carica Feed GTFS",
    uploadHint: "Trascina un file .zip GTFS o clicca per selezionarlo",
    feeds: "Feed caricati",
    noFeeds: "Nessun feed GTFS caricato",
    stopsCount: "Fermate",
    routesCount: "Linee",
    tripsCount: "Corse",
    shapesCount: "Tracciati",
    deleteFeed: "Elimina feed",
    deleteFeedConfirm: "Sei sicuro di voler eliminare questo feed? Tutti i dati associati verranno cancellati.",
  },

  // ── Ottimizzatore ──────────────────────────────────────────
  optimizer: {
    routePlacement: "Piazzamento Fermate",
    scheduleOptimizer: "Ottimizzazione Orari",
    vehicleSchedule: "Turni Macchina",
    driverSchedule: "Turni Guida",
    running: "Ottimizzazione in corso…",
    completed: "Ottimizzazione completata",
    noScenario: "Seleziona uno scenario per iniziare",
    cost: "Costo",
    score: "Punteggio",
    vehicles: "Veicoli",
    drivers: "Conducenti",
    shifts: "Turni",
    deadheadKm: "Km a vuoto",
  },

  // ── Tabelle ────────────────────────────────────────────────
  table: {
    name: "Nome",
    description: "Descrizione",
    date: "Data",
    createdAt: "Creato il",
    updatedAt: "Aggiornato il",
    actions: "Azioni",
    rowsPerPage: "Righe per pagina",
    of: "di",
    noRows: "Nessuna riga",
  },

  // ── Mappe ──────────────────────────────────────────────────
  map: {
    zoomIn: "Avvicina",
    zoomOut: "Allontana",
    layers: "Livelli",
    satellite: "Satellite",
    streets: "Stradale",
    heatmap: "Mappa di calore",
  },

  // ── Unità di misura ────────────────────────────────────────
  units: {
    km: "km",
    min: "min",
    hours: "ore",
    trips: "corse",
    stops: "fermate",
    vehicles: "veicoli",
    drivers: "conducenti",
    passengers: "passeggeri",
    euro: "€",
  },
} as const;

/** Helper tipizzato per accedere a stringhe nidificate. */
export type TranslationKeys = typeof t;
