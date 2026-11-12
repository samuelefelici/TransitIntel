/**
 * Il menu di Cerbero, nell'ordine della giornata dell'azienda: la rete e gli
 * orari, i turni, la pubblicazione, il personale, l'esercizio, la flotta, le
 * tariffe; poi l'Analisi (spenta per i nuovi utenti) e l'Amministrazione.
 *
 * È l'unica fonte: la barra laterale (components/layout/Layout.tsx), la home
 * «Oggi» e le aree delle pagine (App.tsx, AREE_PAGINA) leggono da qui.
 * Un'area dice che cosa serve poter almeno leggere per aprire la pagina (i
 * ruoli aziendali e i loro diritti: il pacchetto @workspace/permessi); con più
 * aree ne basta una; l'amministratore vede tutto.
 */
import {
  BarChart3, CalendarDays, ClipboardList, Coins, Gamepad2, Layers, Map, MapPinned,
  Milestone, Navigation, Network, Printer, Route, SatelliteDish, Send, Shield, Ticket, Timer,
  Users, IdCard, Activity, Database, Wrench, Zap, Settings2, Cpu, History, type LucideIcon,
} from "lucide-react";
import { NOMI_AREE, type Area } from "@workspace/permessi";

/** La pagina d'ingresso: dopo il login, e dove si torna quando una pagina non è permessa. */
export const CASA = "/oggi";

/** Il nome di ogni area, come lo vede chi usa il menu. */
export { NOMI_AREE };

export interface VoceMenu {
  href: string;
  etichetta: string;
  icona: LucideIcon;
  /** sotto l'etichetta, quando c'è spazio */
  descrizione?: string;
  /** le aree che aprono la voce: basta poterne leggere una; senza, la vede chiunque sia entrato */
  aree?: readonly Area[];
  soloAdmin?: boolean;
  /** non è una pagina: FleetCare si apre con il biglietto di accesso (Layout) */
  azione?: "fleetcare";
  /** percorsi che accendono questa voce oltre al suo (le pagine dentro un modulo) */
  ancheSu?: readonly string[];
}

export interface SezioneMenu {
  titolo: string;
  voci: readonly VoceMenu[];
}

/**
 * Le aree delle pagine: per aprirne una basta la lettura su una delle sue
 * aree. Le voci del menu ripetono le stesse (lo controlla il test), così una
 * voce non porta mai a una pagina che rimanda indietro.
 */
export const AREE_PAGINA = {
  "/planning-studio": ["rete"],
  "/planning": ["rete"],
  "/coincidence-zones": ["rete"],
  "/fucina/esercizio": ["turni"],
  /* i turni misti sono fuori dal menu (PR 2.13b): la pagina resta al suo indirizzo */
  "/misto": ["turni"],
  /* «I miei calcoli»: turni macchina, turni guida, sincronizzazioni, giri di Argos */
  "/calcoli": ["turni"],
  /* pubblicare i turni al roster e gli orari al pubblico sono due aree a sé */
  "/roster/pubblicazione": ["pubblicazione_turni"],
  /* gli orari al pubblico si leggono dal programma di Planning Studio */
  "/timetables": ["pubblicazione_orari"],
  "/roster": ["roster"],
  "/roster/anagrafica": ["roster", "personale"],
  "/operations": ["esercizio"],
  "/avm": ["esercizio"],
  /* i tempi osservati vengono dall'AVM: sono dell'Esercizio, e chi li aveva con Analisi li tiene */
  "/runtimes": ["esercizio", "analisi"],
  "/fares": ["tariffe"],
  "/fares-polimetriche": ["tariffe"],
  "/fare-simulator": ["tariffe"],
  "/fare-analytics": ["tariffe"],
  "/trip-planner": ["tariffe"],
  "/dashboard": ["analisi"],
  "/traffic": ["analisi"],
  "/territory": ["analisi"],
  "/network": ["analisi"],
  "/scenarios": ["analisi"],
  /* i feed GTFS sono dell'Analisi; le paline Mizar servono all'Esercizio (pages/data.tsx sceglie le schede) */
  "/data": ["analisi", "esercizio"],
} as const satisfies Record<string, readonly Area[]>;

export type PaginaConArea = keyof typeof AREE_PAGINA;

export const SEZIONI: readonly SezioneMenu[] = [
  {
    titolo: "Oggi",
    voci: [{ href: CASA, etichetta: "Oggi", icona: CalendarDays, descrizione: "Il servizio del giorno" }],
  },
  {
    titolo: "Rete e orari",
    voci: [
      { href: "/planning-studio", etichetta: "Planning Studio", icona: Map, descrizione: "Fermate, linee, corse, validità", aree: AREE_PAGINA["/planning-studio"] },
      { href: "/planning", etichetta: "Confronta programmi", icona: Layers, descrizione: "Due programmi a confronto", aree: AREE_PAGINA["/planning"] },
      { href: "/coincidence-zones", etichetta: "Zone di coincidenza", icona: Zap, descrizione: "Hub e trasbordi", aree: AREE_PAGINA["/coincidence-zones"] },
    ],
  },
  {
    titolo: "Turni",
    voci: [
      {
        href: "/fucina/esercizio", etichetta: "Progetti di esercizio", icona: ClipboardList, descrizione: "Turni macchina e turni guida",
        aree: AREE_PAGINA["/fucina/esercizio"], ancheSu: ["/fucina", "/misto"],
      },
      { href: "/calcoli", etichetta: "I miei calcoli", icona: Cpu, descrizione: "In corso e finiti, anche a pagina chiusa", aree: AREE_PAGINA["/calcoli"] },
    ],
  },
  {
    titolo: "Pubblicazione",
    voci: [
      { href: "/roster/pubblicazione", etichetta: "Turni al roster", icona: Send, descrizione: "Quali turni guida, per periodo", aree: AREE_PAGINA["/roster/pubblicazione"] },
      { href: "/timetables", etichetta: "Orari al pubblico", icona: Printer, descrizione: "Stampa orari, quadri di palina, QR", aree: AREE_PAGINA["/timetables"] },
    ],
  },
  {
    titolo: "Personale",
    voci: [
      { href: "/roster", etichetta: "Roster", icona: Users, descrizione: "Tabellone, assegnazioni, assenze", aree: AREE_PAGINA["/roster"] },
      { href: "/roster/anagrafica", etichetta: "Anagrafica", icona: IdCard, descrizione: "Conducenti e personale", aree: AREE_PAGINA["/roster/anagrafica"] },
    ],
  },
  {
    titolo: "Esercizio",
    voci: [
      { href: "/operations", etichetta: "Mappa live", icona: MapPinned, descrizione: "Il servizio adesso", aree: AREE_PAGINA["/operations"] },
      { href: "/avm", etichetta: "AVM", icona: SatelliteDish, descrizione: "Diario e controllo degli apparati", aree: AREE_PAGINA["/avm"] },
      { href: "/runtimes", etichetta: "Tempi osservati", icona: Timer, descrizione: "Percorrenze dall'AVM", aree: AREE_PAGINA["/runtimes"] },
    ],
  },
  {
    titolo: "Flotta",
    voci: [
      { href: "/fleetcare", etichetta: "FleetCare", icona: Wrench, descrizione: "Mezzi, fermi, officina", aree: ["flotta"], azione: "fleetcare" },
    ],
  },
  {
    titolo: "Tariffe",
    voci: [
      { href: "/fares", etichetta: "Bigliettazione", icona: Ticket, descrizione: "Tariffe, titoli, zone", aree: AREE_PAGINA["/fares"] },
      { href: "/fares-polimetriche", etichetta: "Polimetriche", icona: Milestone, descrizione: "Tratte e prezzi", aree: AREE_PAGINA["/fares-polimetriche"] },
      { href: "/fare-simulator", etichetta: "Simulatore", icona: Gamepad2, descrizione: "Ipotesi tariffarie", aree: AREE_PAGINA["/fare-simulator"] },
      { href: "/fare-analytics", etichetta: "Prodotti e KPI", icona: Coins, descrizione: "Titoli, indicatori, controlli", aree: AREE_PAGINA["/fare-analytics"] },
      { href: "/trip-planner", etichetta: "Percorso e tariffa", icona: Navigation, descrizione: "Da porta a porta, con il prezzo", aree: AREE_PAGINA["/trip-planner"] },
    ],
  },
  {
    titolo: "Analisi",
    voci: [
      { href: "/dashboard", etichetta: "Mappa del territorio", icona: BarChart3, descrizione: "Linee, fermate, domanda", aree: AREE_PAGINA["/dashboard"] },
      { href: "/traffic", etichetta: "Traffico", icona: Activity, descrizione: "Velocità e congestione", aree: AREE_PAGINA["/traffic"] },
      { href: "/territory", etichetta: "Territorio e domanda", icona: Map, descrizione: "Popolazione e servizi", aree: AREE_PAGINA["/territory"] },
      { href: "/network", etichetta: "Linee e fermate GTFS", icona: Network, descrizione: "Il feed caricato", aree: AREE_PAGINA["/network"] },
      { href: "/scenarios", etichetta: "Ipotesi di linea", icona: Route, descrizione: "Tracciati KML e copertura", aree: AREE_PAGINA["/scenarios"] },
    ],
  },
  {
    titolo: "Amministrazione",
    voci: [
      { href: "/admin/users", etichetta: "Utenti e accessi", icona: Users, descrizione: "Permessi, sblocchi, registro", soloAdmin: true },
      { href: "/admin/parametri", etichetta: "Parametri di esercizio", icona: Settings2, descrizione: "Autovetture aziendali", soloAdmin: true },
      { href: "/admin/registro", etichetta: "Registro delle modifiche", icona: History, descrizione: "Chi ha cambiato che cosa", soloAdmin: true },
      { href: "/data", etichetta: "Dati e integrazioni", icona: Database, descrizione: "Feed GTFS, paline Mizar", aree: AREE_PAGINA["/data"] },
      { href: "/account", etichetta: "Sicurezza dell'account", icona: Shield, descrizione: "Password e verifica" },
    ],
  },
];

/** Questa voce si può aprire? `legge` dice se l'utente può almeno leggere un'area. */
export function voceVisibile(v: VoceMenu, legge: (a: Area) => boolean, admin: boolean): boolean {
  if (admin) return true;
  if (v.soloAdmin) return false;
  return !v.aree || v.aree.some(a => legge(a));
}

/** Il menu di chi è entrato: solo le voci che può aprire, e niente sezioni vuote. */
export function sezioniVisibili(ha: (a: Area) => boolean, admin: boolean): SezioneMenu[] {
  return SEZIONI
    .map(s => ({ ...s, voci: s.voci.filter(v => voceVisibile(v, ha, admin)) }))
    .filter(s => s.voci.length > 0);
}

const sotto = (location: string, href: string) => location === href || location.startsWith(href + "/");

/**
 * La voce accesa per questo percorso: la più specifica fra quelle visibili
 * (/roster/anagrafica accende Anagrafica, non Roster).
 */
export function voceAttiva(location: string, sezioni: readonly SezioneMenu[]): string | null {
  let migliore: { href: string; lunghezza: number } | null = null;
  for (const s of sezioni) for (const v of s.voci) {
    for (const h of [v.href, ...(v.ancheSu ?? [])]) {
      if (sotto(location, h) && (!migliore || h.length > migliore.lunghezza)) migliore = { href: v.href, lunghezza: h.length };
    }
  }
  return migliore?.href ?? null;
}

/** Le pagine di lavoro a tutto schermo: qui il menu si può nascondere del tutto. */
export function paginaDiLavoro(location: string): boolean {
  return /^\/planning-studio\/[^/]+/.test(location) || sotto(location, "/fucina");
}

/** Le pagine delle tariffe hanno la loro tinta (index.css, .fares-zone). */
export function paginaTariffe(location: string): boolean {
  return SEZIONI.find(s => s.titolo === "Tariffe")!.voci.some(v => sotto(location, v.href));
}

/** I percorsi pubblici (QR alle paline, mappe condivise): nessuna pagina dell'app può cominciare così. */
export const PREFISSI_PUBBLICI = ["/m/", "/o/"] as const;
