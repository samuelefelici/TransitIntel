/**
 * ═══════════════════════════════════════════════════════════════════════════
 * QUALE AREA E QUALE LIVELLO SERVONO PER UN PERCORSO DELL'API
 * ───────────────────────────────────────────────────────────────────────────
 * È il controllo centrale dei permessi: i router sono montati senza prefisso
 * (i percorsi vivono dentro), quindi una sola tabella «prefisso → area» è più
 * sicura di tanti controlli sparsi. Chi può cosa lo dice lib/permessi
 * (ruoli aziendali, aree, lettura e scrittura); qui c'è solo:
 *
 *   1. a quale area appartiene un percorso (AREE_PER_PREFISSO, le voci più
 *      specifiche prima);
 *   2. quali letture servono anche ad altre aree (LETTURE_CONDIVISE);
 *   3. quale livello serve: lettura per GET e HEAD, scrittura per il resto,
 *      tranne le richieste di CALCOLANO_SENZA_SCRIVERE.
 *
 * Deny by default: un percorso senza voce è solo dell'amministratore, e il
 * test inventario-rotte controlla che ogni rotta montata ne abbia una.
 * Niente database e niente Express: funzioni pure, con i loro test.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { livelloDelMetodo, puoSuUna, NOMI_AREE, type Area, type Diritti, type Livello } from "@workspace/permessi";

const AREE_PER_PREFISSO: Array<[string, Area | Area[]]> = [
  // Turni: progetti di esercizio, ottimizzatori, calcoli
  ["/service-program", "turni"], ["/driver-shifts", "turni"],
  // «I miei calcoli»: ogni calcolo in coda nasce da una funzione dei Turni
  ["/lavori", "turni"],
  ["/driver-schedules", "turni"], ["/vehicle-schedules", "turni"],
  // La pubblicazione dei turni guida al roster; le sorgenti dei turni servono
  // anche ai Misti e al tabellone.
  ["/roster/pubblicazioni", "pubblicazione_turni"],
  ["/roster/duty-sources", ["turni", "roster"]],
  // Anagrafica del personale: chi ha i dati personali la legge e la scrive
  // anche senza il roster, e chi ha il roster ne legge i dati operativi (la
  // mascheratura e le scritture si decidono nel singolo handler). Queste voci
  // stanno PRIMA di "/roster", che altrimenti vince.
  ["/roster/anagrafica/import", "personale"],
  ["/roster/anagrafica", ["roster", "personale"]],
  ["/roster/drivers", ["roster", "personale"]],
  ["/roster/history", "personale"],
  ["/roster/depositi", ["roster", "personale"]],
  ["/roster/categorie", ["roster", "personale"]],
  ["/roster/gruppi-turni", ["roster", "personale"]],
  ["/roster/rotazioni-riposi", ["roster", "personale"]],
  // il roster (tabellone, assegnazioni, voci, calendario, tratte dei turni)
  ["/roster", "roster"], ["/scheduling", "turni"],
  ["/deadheads", "turni"],
  // Depositi, archi fuorilinea e zone di coincidenza sono infrastruttura di
  // PROGETTO: si gestiscono in Planning Studio e servono alla pipeline dei
  // turni. Basta una delle due aree.
  ["/deadhead-arcs", ["turni", "rete"]], ["/depots", ["turni", "rete"]],
  ["/coincidence-zones", ["turni", "rete"]],
  // Rete e orari: Planning Studio, zonizzazione, intermodale
  ["/planning-studio", "rete"], ["/zones", "rete"],
  // I nodi sono l'infrastruttura condivisa per eccellenza: Planning Studio li
  // disegna, i turni li usano come punti di cambio vettura.
  ["/clusters", ["rete", "turni"]],
  ["/intermodal", "rete"],
  // Argos vive dentro Planning Studio: il pannello, la chat, l'agente, il
  // territorio (Mapbox, a consumo). Il controllo sul progetto resta negli handler.
  ["/ai/argos", "rete"],
  // la Fucina: regole salvate dell'ottimizzatore e analisi intermodale dei turni macchina
  ["/optimizer-rule-profiles", "turni"],
  ["/intermodal-optimizer", "turni"],
  // Tariffe
  ["/fares", "tariffe"],
  // Esercizio (Mappa live + AVM). Il parco letto da SIRI serve solo alle due
  // pagine del modulo; il resto di /siri (paline Mizar, diagnostica) lo usa la
  // pagina Dati e integrazioni, aperta ad Analisi ed Esercizio. POST
  // /siri/sync, che scrive, è solo dell'admin (routes/siri.ts).
  ["/siri/parco", "esercizio"],
  ["/siri", ["esercizio", "analisi"]],
  // /operations è condiviso: la Mappa legge /live, /punctuality, /anomalie,
  // /vehicles; i Tempi di percorrenza (Analisi) leggono /runtimes, /copertura,
  // e /trips lo leggono entrambi. Basta una delle due aree.
  ["/operations", ["esercizio", "analisi"]],
  // Analisi (territorio, GTFS, vecchi orari, scenari)
  ["/analysis", "analisi"], ["/territory", "analisi"], ["/gtfs", "analisi"],
  ["/traffic", "analisi"], ["/poi", "analisi"], ["/population", "analisi"],
  ["/timetables", "analisi"], ["/planning", "analisi"],
  ["/scenarios", "analisi"], ["/weather", "analisi"],
  ["/settings", "analisi"],
];

/**
 * Letture che servono a più aree, oltre a quella che possiede i dati: solo GET
 * e HEAD, con il percorso esatto. Si guardano prima della tabella qui sopra.
 * Senza, chi non ha l'Analisi resterebbe con la Fucina senza feed e fermate,
 * le Tariffe senza linee e confini, la Stampa Orari col dominio dei QR
 * sbagliato. Le scritture restano all'area che possiede i dati. Gli handler
 * rispondono solo sui feed e sui progetti che l'utente vede.
 */
const LETTURE_CONDIVISE: Array<[string | RegExp, Area[]]> = [
  // feed e fermate: Fucina (scelta della data), fuorilinea, editor dei turni guida, zone di coincidenza
  ["/gtfs/feeds", ["analisi", "turni", "rete"]],
  ["/gtfs/stops/all", ["analisi", "turni", "rete"]],
  // la mappa delle Tariffe: linee, forme, fermate per linea, confini dei comuni
  ["/gtfs/routes", ["analisi", "tariffe"]],
  ["/gtfs/shapes/geojson", ["analisi", "tariffe"]],
  ["/gtfs/route-stop-ids", ["analisi", "tariffe"]],
  ["/territory/comuni-boundaries", ["analisi", "tariffe"]],
  // parametri letti dai motori dei turni e dalla Stampa Orari (il dominio dei QR)
  ["/settings/company-cars", ["analisi", "turni", "rete"]],
  ["/settings/timetable-map-domain", ["analisi", "rete", "pubblicazione_orari"]],
  // le linee per i Tempi osservati (Esercizio)
  ["/timetables/routes", ["analisi", "esercizio"]],
  // Rete e orari: confronto fra programmi; Analisi: elenco delle zone per le ipotesi di linea
  ["/planning/compare", ["analisi", "rete"]],
  ["/coincidence-zones", ["turni", "rete", "analisi"]],
  // Turni: la scelta del programma e l'unità di validità nel Quadro d'esercizio
  ["/planning-studio/projects", ["rete", "turni"]],
  [/^\/planning-studio\/projects\/[0-9a-f-]{36}$/, ["rete", "turni"]],
  [/^\/planning-studio\/projects\/[0-9a-f-]{36}\/validity-units\/[0-9a-f-]{36}\/detail$/, ["rete", "turni"]],
];

/**
 * Richieste che non sono GET ma calcolano, cercano o leggono senza scrivere
 * niente: chi ha la sola lettura sull'area le può fare. Elenco corto e rivisto
 * a mano, handler per handler: una richiesta che manca qui chiede la scrittura
 * (si sbaglia dalla parte chiusa). Il test controlla che ognuna sia una rotta
 * vera. Il percorso è quello della rotta, coi suoi parametri (`:id`): un
 * parametro vale un solo pezzo di percorso.
 */
export const CALCOLANO_SENZA_SCRIVERE: ReadonlyArray<readonly [string, string]> = [
  // quali nodi toccano le linee scelte (una ricerca)
  ["POST", "/clusters/by-routes"],
  // la matrice dei fuorilinea calcolata dalle distanze
  ["POST", "/deadheads/compute"],
  // verifica normativa, proposte di scambio e turni unici: calcoli sui turni mandati dal browser
  ["POST", "/driver-shifts/tools/validate"],
  ["POST", "/driver-shifts/tools/swap"],
  ["POST", "/driver-shifts/tools/turni-unici"],
  // simulazioni di tariffa e piano di viaggio
  ["POST", "/fares/simulate"],
  ["POST", "/fares/simulate-direct"],
  ["POST", "/fares/simulate-cluster"],
  ["POST", "/fares/simulate-dominant"],
  ["POST", "/fares/journey-plan"],
  // l'anteprima di una pubblicazione dei turni, senza pubblicare
  ["POST", "/roster/pubblicazioni/anteprima"],
  // le domande ad Argos: quello che Argos fa lo fa con i diritti di chi chiede
  ["POST", "/ai/argos/chat"],
  ["POST", "/ai/argos/agent/chat"],
  // letture di molte corse insieme: sono POST solo perché l'elenco delle corse
  // non sta in un indirizzo. Le usano la tabella Corse, i quadri orari, le
  // percorrenze e la scheda del turno guida: senza, chi legge le vede vuote.
  ["POST", "/planning-studio/projects/:id/trips/validity-bulk"],
  ["POST", "/planning-studio/projects/:id/stop-times/bulk"],
];

/** Le stesse, pronte per il confronto: ogni `:parametro` è un pezzo di percorso qualunque. */
const SENZA_SCRIVERE: ReadonlyArray<readonly [string, RegExp]> = CALCOLANO_SENZA_SCRIVERE.map(([metodo, percorso]) => [
  metodo,
  new RegExp("^" + percorso.split("/").map(pezzo => (pezzo.startsWith(":") ? "[^/]+" : pezzo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("/") + "$"),
]);

/**
 * Prefissi solo dell'admin, per scelta: chi non è admin prende 403 «Solo admin»
 * senza la riga di log della voce dimenticata. Le rotte si proteggono anche da
 * sé (requireAdmin in routes/admin.ts).
 */
export const SOLO_ADMIN: readonly string[] = ["/admin/sync", "/admin/registro"];

const sotto = (p: string, prefix: string) => p === prefix || p.startsWith(prefix + "/");

/** Le aree che aprono questa lettura condivisa, se è una di quelle. */
export function letturaCondivisa(metodo: string, path: string): Area[] | null {
  const m = metodo.toUpperCase();
  if (m !== "GET" && m !== "HEAD") return null;
  const p = path.toLowerCase();
  const voce = LETTURE_CONDIVISE.find(([chi]) => (typeof chi === "string" ? p === chi : chi.test(p)));
  return voce ? voce[1] : null;
}

/** Le aree del prefisso che copre questo percorso (il primo nell'ordine), o null. */
export function areeDelPrefisso(path: string): Area[] | null {
  const p = path.toLowerCase();
  for (const [prefix, aree] of AREE_PER_PREFISSO) {
    if (sotto(p, prefix)) return Array.isArray(aree) ? aree : [aree];
  }
  return null;
}

/** Il livello che serve: lettura per GET, HEAD e per le richieste che calcolano senza scrivere. */
export function livelloPerRichiesta(metodo: string, path: string): Livello {
  const base = livelloDelMetodo(metodo);
  if (base === "L") return "L";
  const m = metodo.toUpperCase(), p = path.toLowerCase();
  return SENZA_SCRIVERE.some(([mm, pp]) => mm === m && pp.test(p)) ? "L" : "S";
}

/**
 * Cosa apre questo percorso: la lettura condivisa (se è una GET di quelle), le
 * aree del prefisso e il livello che serve. Senza lettura condivisa e senza
 * prefisso non c'è nessuna voce: solo l'admin.
 */
export function dirittoPerPercorso(metodo: string, path: string): { condivisa: Area[] | null; aree: Area[] | null; livello: Livello } {
  return { condivisa: letturaCondivisa(metodo, path), aree: areeDelPrefisso(path), livello: livelloPerRichiesta(metodo, path) };
}

export type Decisione =
  | { passa: true }
  | {
    passa: false; errore: string;
    /** nessuna voce copre il percorso: quasi sempre una voce dimenticata */
    senzaVoce?: true;
    /** può leggere l'area ma non scriverla: la web lo dice a modo suo, senza leggere il testo */
    solaLettura?: true;
  };

const elenco = (aree: readonly Area[]) => aree.map(a => `«${NOMI_AREE[a]}»`).join(" o ");

/**
 * Passa o no? Express confronta i percorsi senza badare alle maiuscole
 * (/Roster/drivers arriva allo stesso handler di /roster/drivers): qui si fa
 * lo stesso, altrimenti basta una maiuscola per saltare il controllo.
 */
export function decidi(chi: { admin: boolean; diritti: Diritti }, metodo: string, path: string): Decisione {
  if (chi.admin) return { passa: true };
  const { condivisa, aree, livello } = dirittoPerPercorso(metodo, path);
  if (condivisa && puoSuUna(chi.diritti, condivisa, "L")) return { passa: true };
  if (SOLO_ADMIN.some(a => sotto(path.toLowerCase(), a))) return { passa: false, errore: "Solo admin" };
  if (aree) {
    if (puoSuUna(chi.diritti, aree, livello)) return { passa: true };
    /* può leggere ma non scrivere: lo si dice, perché è il caso che un ruolo crea apposta */
    if (livello === "S" && puoSuUna(chi.diritti, aree, "L")) {
      return { passa: false, errore: `Sola lettura: per modificare serve la scrittura su ${elenco(aree)}`, solaLettura: true };
    }
    return { passa: false, errore: `Manca l'accesso a ${elenco(aree)}` };
  }
  return { passa: false, errore: "Percorso senza permesso assegnato", senzaVoce: true };
}
