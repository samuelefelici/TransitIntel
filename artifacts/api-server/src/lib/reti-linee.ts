/**
 * ═══════════════════════════════════════════════════════════════════════════
 * LE RETI DELLE LINEE — urbano o extraurbano, dal nome della linea
 * ───────────────────────────────────────────────────────────────────────────
 * Due cose, ognuna in un posto solo (tappa 6.6):
 *   1. l'elenco delle reti urbane, con quello che ogni rete porta con sé
 *      (nome, sigla, zona tariffaria, codici di classificazione delle fermate);
 *   2. la regola che dal nome breve di una linea ricava la sua rete.
 * Le usano le tariffe (reti, zone, classificazione delle fermate, tariffe
 * minime, nodi) e le Unità di Progettazione, che ne ricavano se sono urbane o
 * extraurbane (riposo minimo 8h o 9h fra due turni nel Roster).
 *
 * Oggi sono dati di partenza scritti qui, quelli dell'azienda per cui il
 * programma è nato. Questo file non importa niente: lo può leggere chiunque.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** La rete di tutto quello che non è urbano. */
export const RETE_EXTRAURBANA = "extraurbano";

export interface ReteUrbana {
  /** L'identificativo della rete (network_id). */
  rete: string;
  /** Il luogo, come si legge nei nomi: «Urbano di Ancona», «Zona Urbana Ancona». */
  luogo: string;
  /** La sigla nelle classificazioni delle fermate: URB_AN, MIX_EX_AN. */
  sigla: string;
  /** La zona tariffaria della rete (area_id): una sola, a tariffa piatta. */
  zona: string;
  /** Il codice di una fermata servita solo da questa rete. */
  codice: number;
  /** Il codice di una fermata servita da questa rete e dall'extraurbano. */
  codiceMisto: number;
}

/**
 * Le reti urbane, nell'ordine in cui si mostrano. Ogni elenco di reti urbane
 * del programma si ricava da qui: aggiungerne una è una riga sola.
 */
export const RETI_URBANE: readonly Readonly<ReteUrbana>[] = Object.freeze([
  { rete: "urbano_ancona",        luogo: "Ancona",        sigla: "AN", zona: "ancona_urban",        codice: 2, codiceMisto: 12 },
  { rete: "urbano_jesi",          luogo: "Jesi",          sigla: "JE", zona: "jesi_urban",          codice: 3, codiceMisto: 13 },
  { rete: "urbano_falconara",     luogo: "Falconara",     sigla: "FA", zona: "falconara_urban",     codice: 4, codiceMisto: 14 },
  { rete: "urbano_senigallia",    luogo: "Senigallia",    sigla: "SE", zona: "senigallia_urban",    codice: 5, codiceMisto: 15 },
  { rete: "urbano_castelfidardo", luogo: "Castelfidardo", sigla: "CF", zona: "castelfidardo_urban", codice: 6, codiceMisto: 16 },
  { rete: "urbano_sassoferrato",  luogo: "Sassoferrato",  sigla: "SS", zona: "sassoferrato_urban",  codice: 7, codiceMisto: 17 },
].map((r) => Object.freeze(r)));

/** Gli identificativi delle reti urbane, nell'ordine dell'elenco. */
export const ID_RETI_URBANE: readonly string[] = Object.freeze(RETI_URBANE.map((r) => r.rete));

const PER_RETE = new Map(RETI_URBANE.map((r) => [r.rete, r]));

/** La rete urbana con quell'identificativo, o null se non è una rete urbana dell'elenco. */
export function reteUrbana(rete: string | null | undefined): Readonly<ReteUrbana> | null {
  return rete ? PER_RETE.get(rete) ?? null : null;
}

/** Vero se è una delle reti urbane dell'elenco. */
export const eReteUrbana = (rete: string | null | undefined): boolean => reteUrbana(rete) !== null;

/** La zona tariffaria di una rete urbana; null per l'extraurbano e per una rete che non è nell'elenco. */
export const zonaDellaRete = (rete: string | null | undefined): string | null => reteUrbana(rete)?.zona ?? null;

/** Il nome della rete urbana, come sta nell'elenco delle reti: «Urbano di Jesi». */
export const nomeReteUrbana = (r: Pick<ReteUrbana, "luogo">): string => `Urbano di ${r.luogo}`;

/** Il nome della zona tariffaria di una rete urbana: «Zona Urbana Jesi». */
export const nomeZonaUrbana = (r: Pick<ReteUrbana, "luogo">): string => `Zona Urbana ${r.luogo}`;

/**
 * La rete di default di una linea dal suo nome breve (route_short_name).
 * Rende sempre una rete dell'elenco oppure RETE_EXTRAURBANA. Nessuna regola
 * porta a Sassoferrato: quelle linee si assegnano a mano dalla pagina Tariffe.
 */
export function classifyRoute(shortName: string | null | undefined): string {
  if (!shortName) return RETE_EXTRAURBANA;
  const s = shortName.trim().toUpperCase();

  // Urbano Jesi — starts with "JE"
  if (s.startsWith("JE")) return "urbano_jesi";

  // Urbano Falconara — starts with "Y"
  if (s.startsWith("Y")) return "urbano_falconara";

  // Urbano Senigallia — BUS* e BUSS* (es. BUS3, BUS5, BUS6, BUS7, BUS8, BUS10, BUS87, BUSS2, BUSS3)
  if (/^BUSS?\d/.test(s)) return "urbano_senigallia";

  // Urbano Castelfidardo — CIRCA e CIRCB
  if (s === "CIRCA" || s === "CIRCB") return "urbano_castelfidardo";

  // Urbano Ancona — starts with a digit, OR is C.D., C.S., or similar single-letter+dot combos
  if (/^\d/.test(s)) return "urbano_ancona";
  if (/^[A-Z]\.[A-Z]\.?$/.test(s)) return "urbano_ancona"; // C.D., C.S., etc.

  // Everything else → extraurbano
  return RETE_EXTRAURBANA;
}

/** Urbano o extraurbano: le linee di una rete urbana dell'elenco sono urbane, tutte le altre no. */
export function servizioDellaLinea(shortName: string | null | undefined): "urbano" | "extraurbano" {
  return eReteUrbana(classifyRoute(shortName)) ? "urbano" : "extraurbano";
}
