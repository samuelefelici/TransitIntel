/**
 * Il menu di Cerbero, nell'ordine della giornata dell'azienda: la rete e gli
 * orari, i turni, la pubblicazione, il personale, l'esercizio, la flotta, le
 * tariffe; poi l'Analisi (spenta per i nuovi utenti) e l'Amministrazione.
 *
 * È l'unica fonte: la barra laterale (components/layout/Layout.tsx), la home
 * «Oggi» e i permessi delle pagine (App.tsx, PERMESSI_PAGINA) leggono da qui.
 * Un permesso dice quale modulo serve (api-server/src/lib/permessi.ts); con
 * più permessi ne basta uno; l'admin vede tutto.
 */
import {
  BarChart3, BookOpen, CalendarDays, ClipboardList, Coins, Gamepad2, Layers, Map, MapPinned,
  Milestone, Navigation, Network, Printer, Route, SatelliteDish, Send, Shield, Shuffle, Ticket, Timer,
  Users, IdCard, Activity, Database, Wrench, Zap, type LucideIcon,
} from "lucide-react";
import type { Permission } from "@/hooks/use-auth";

/** La pagina d'ingresso: dopo il login, e dove si torna quando una pagina non è permessa. */
export const CASA = "/oggi";

/** Il nome del modulo di ogni permesso, come lo vede chi usa il menu. */
export const NOMI_PERMESSI: Readonly<Record<Permission, string>> = {
  network: "Rete e orari",
  scheduling: "Turni",
  roster: "Roster",
  personale: "Personale",
  centrale: "Esercizio",
  fleetcare: "Flotta",
  fares: "Tariffe",
  analytics: "Analisi",
};

export interface VoceMenu {
  href: string;
  etichetta: string;
  icona: LucideIcon;
  /** sotto l'etichetta, quando c'è spazio */
  descrizione?: string;
  /** basta uno; senza, la vede chiunque sia entrato */
  permessi?: readonly Permission[];
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
 * I permessi delle pagine che hanno un modulo. Le voci del menu ripetono gli
 * stessi (lo controlla il test), così una voce non porta mai a una pagina che
 * rimanda indietro.
 */
export const PERMESSI_PAGINA = {
  "/planning-studio": ["network"],
  "/planning": ["network"],
  "/coincidence-zones": ["network"],
  "/fucina/esercizio": ["scheduling"],
  "/misto": ["scheduling"],
  "/service-db": ["scheduling"],
  "/driver-shifts": ["scheduling"],
  "/roster/pubblicazione": ["scheduling"],
  /* gli orari al pubblico si leggono dal programma di Planning Studio */
  "/timetables": ["network"],
  "/roster": ["roster"],
  "/roster/anagrafica": ["roster", "personale"],
  "/operations": ["centrale"],
  "/avm": ["centrale"],
  /* i tempi osservati vengono dall'AVM: sono dell'Esercizio, e chi li aveva con Analisi li tiene */
  "/runtimes": ["centrale", "analytics"],
  "/fares": ["fares"],
  "/fares-polimetriche": ["fares"],
  "/fare-simulator": ["fares"],
  "/fare-analytics": ["fares"],
  "/trip-planner": ["fares"],
  "/fare-docs": ["fares"],
  "/dashboard": ["analytics"],
  "/traffic": ["analytics"],
  "/territory": ["analytics"],
  "/network": ["analytics"],
  "/scenarios": ["analytics"],
  /* i feed GTFS sono dell'Analisi; le paline Mizar servono all'Esercizio (pages/data.tsx sceglie le schede) */
  "/data": ["analytics", "centrale"],
} as const satisfies Record<string, readonly Permission[]>;

export type PaginaConPermesso = keyof typeof PERMESSI_PAGINA;

export const SEZIONI: readonly SezioneMenu[] = [
  {
    titolo: "Oggi",
    voci: [{ href: CASA, etichetta: "Oggi", icona: CalendarDays, descrizione: "Il servizio del giorno" }],
  },
  {
    titolo: "Rete e orari",
    voci: [
      { href: "/planning-studio", etichetta: "Planning Studio", icona: Map, descrizione: "Fermate, linee, corse, validità", permessi: PERMESSI_PAGINA["/planning-studio"] },
      { href: "/planning", etichetta: "Confronta programmi", icona: Layers, descrizione: "Due programmi a confronto", permessi: PERMESSI_PAGINA["/planning"] },
      { href: "/coincidence-zones", etichetta: "Zone di coincidenza", icona: Zap, descrizione: "Hub e trasbordi", permessi: PERMESSI_PAGINA["/coincidence-zones"] },
    ],
  },
  {
    titolo: "Turni",
    voci: [
      {
        href: "/fucina/esercizio", etichetta: "Progetti di esercizio", icona: ClipboardList, descrizione: "Turni macchina e turni guida",
        permessi: PERMESSI_PAGINA["/fucina/esercizio"], ancheSu: ["/fucina", "/driver-shifts"],
      },
      { href: "/misto", etichetta: "Turni misti", icona: Shuffle, descrizione: "Completamento fra unità", permessi: PERMESSI_PAGINA["/misto"] },
      { href: "/service-db", etichetta: "Database di esercizio", icona: Database, descrizione: "Programmi, unità, turni, roster", permessi: PERMESSI_PAGINA["/service-db"] },
    ],
  },
  {
    titolo: "Pubblicazione",
    voci: [
      { href: "/roster/pubblicazione", etichetta: "Turni al roster", icona: Send, descrizione: "Quali turni guida, per periodo", permessi: PERMESSI_PAGINA["/roster/pubblicazione"] },
      { href: "/timetables", etichetta: "Orari al pubblico", icona: Printer, descrizione: "Stampa orari, quadri di palina, QR", permessi: PERMESSI_PAGINA["/timetables"] },
    ],
  },
  {
    titolo: "Personale",
    voci: [
      { href: "/roster", etichetta: "Roster", icona: Users, descrizione: "Tabellone, assegnazioni, assenze", permessi: PERMESSI_PAGINA["/roster"] },
      { href: "/roster/anagrafica", etichetta: "Anagrafica", icona: IdCard, descrizione: "Conducenti e personale", permessi: PERMESSI_PAGINA["/roster/anagrafica"] },
    ],
  },
  {
    titolo: "Esercizio",
    voci: [
      { href: "/operations", etichetta: "Mappa live", icona: MapPinned, descrizione: "Il servizio adesso", permessi: PERMESSI_PAGINA["/operations"] },
      { href: "/avm", etichetta: "AVM", icona: SatelliteDish, descrizione: "Diario e controllo degli apparati", permessi: PERMESSI_PAGINA["/avm"] },
      { href: "/runtimes", etichetta: "Tempi osservati", icona: Timer, descrizione: "Percorrenze dall'AVM", permessi: PERMESSI_PAGINA["/runtimes"] },
    ],
  },
  {
    titolo: "Flotta",
    voci: [
      { href: "/fleetcare", etichetta: "FleetCare", icona: Wrench, descrizione: "Mezzi, fermi, officina", permessi: ["fleetcare"], azione: "fleetcare" },
    ],
  },
  {
    titolo: "Tariffe",
    voci: [
      { href: "/fares", etichetta: "Bigliettazione", icona: Ticket, descrizione: "Tariffe, titoli, zone", permessi: PERMESSI_PAGINA["/fares"] },
      { href: "/fares-polimetriche", etichetta: "Polimetriche", icona: Milestone, descrizione: "Tratte e prezzi", permessi: PERMESSI_PAGINA["/fares-polimetriche"] },
      { href: "/fare-simulator", etichetta: "Simulatore", icona: Gamepad2, descrizione: "Ipotesi tariffarie", permessi: PERMESSI_PAGINA["/fare-simulator"] },
      { href: "/fare-analytics", etichetta: "Prodotti e KPI", icona: Coins, descrizione: "Titoli, indicatori, controlli", permessi: PERMESSI_PAGINA["/fare-analytics"] },
      { href: "/trip-planner", etichetta: "Percorso e tariffa", icona: Navigation, descrizione: "Da porta a porta, con il prezzo", permessi: PERMESSI_PAGINA["/trip-planner"] },
      { href: "/fare-docs", etichetta: "Documentazione ATMA", icona: BookOpen, descrizione: "Documento stampabile", permessi: PERMESSI_PAGINA["/fare-docs"] },
    ],
  },
  {
    titolo: "Analisi",
    voci: [
      { href: "/dashboard", etichetta: "Mappa del territorio", icona: BarChart3, descrizione: "Linee, fermate, domanda", permessi: PERMESSI_PAGINA["/dashboard"] },
      { href: "/traffic", etichetta: "Traffico", icona: Activity, descrizione: "Velocità e congestione", permessi: PERMESSI_PAGINA["/traffic"] },
      { href: "/territory", etichetta: "Territorio e domanda", icona: Map, descrizione: "Popolazione e servizi", permessi: PERMESSI_PAGINA["/territory"] },
      { href: "/network", etichetta: "Linee e fermate GTFS", icona: Network, descrizione: "Il feed caricato", permessi: PERMESSI_PAGINA["/network"] },
      { href: "/scenarios", etichetta: "Ipotesi di linea", icona: Route, descrizione: "Tracciati KML e copertura", permessi: PERMESSI_PAGINA["/scenarios"] },
    ],
  },
  {
    titolo: "Amministrazione",
    voci: [
      { href: "/admin/users", etichetta: "Utenti e accessi", icona: Users, descrizione: "Permessi, sblocchi, registro", soloAdmin: true },
      { href: "/data", etichetta: "Dati e integrazioni", icona: Database, descrizione: "Feed GTFS, paline Mizar", permessi: PERMESSI_PAGINA["/data"] },
      { href: "/account", etichetta: "Sicurezza dell'account", icona: Shield, descrizione: "Password e verifica" },
    ],
  },
];

/** Questa voce si può aprire con questi permessi? */
export function voceVisibile(v: VoceMenu, ha: (p: Permission) => boolean, admin: boolean): boolean {
  if (admin) return true;
  if (v.soloAdmin) return false;
  return !v.permessi || v.permessi.some(p => ha(p));
}

/**
 * I permessi che servono per aprire un percorso: quelli della pagina più specifica che lo
 * contiene (/planning-studio/abc → /planning-studio), null se il percorso non ne chiede.
 */
export function permessiDelPercorso(percorso: string): readonly Permission[] | null {
  const p = percorso.split(/[?#]/)[0]!;
  let migliore: { pagina: PaginaConPermesso; lunghezza: number } | null = null;
  for (const pagina of Object.keys(PERMESSI_PAGINA) as PaginaConPermesso[]) {
    if (sotto(p, pagina) && (!migliore || pagina.length > migliore.lunghezza)) migliore = { pagina, lunghezza: pagina.length };
  }
  return migliore ? PERMESSI_PAGINA[migliore.pagina] : null;
}

/** Il menu di chi è entrato: solo le voci che può aprire, e niente sezioni vuote. */
export function sezioniVisibili(ha: (p: Permission) => boolean, admin: boolean): SezioneMenu[] {
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
  return /^\/planning-studio\/[^/]+/.test(location) || sotto(location, "/fucina") || sotto(location, "/driver-shifts");
}

/** Le pagine delle tariffe hanno la loro tinta (index.css, .fares-zone). */
export function paginaTariffe(location: string): boolean {
  return SEZIONI.find(s => s.titolo === "Tariffe")!.voci.some(v => sotto(location, v.href));
}

/** I percorsi pubblici (QR alle paline, mappe condivise): nessuna pagina dell'app può cominciare così. */
export const PREFISSI_PUBBLICI = ["/m/", "/o/"] as const;
