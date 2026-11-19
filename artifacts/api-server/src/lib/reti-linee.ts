/**
 * ═══════════════════════════════════════════════════════════════════════════
 * LE RETI DELLE LINEE — urbano o extraurbano, dal nome della linea
 * ───────────────────────────────────────────────────────────────────────────
 * Due cose, ognuna in un posto solo:
 *   1. l'elenco delle reti (l'extraurbana e le urbane), con quello che ogni
 *      rete urbana porta con sé: nome, sigla, zona tariffaria, codici di
 *      classificazione delle fermate;
 *   2. le regole che dal nome breve di una linea ricavano la sua rete.
 * Le usano le tariffe (reti, zone, classificazione delle fermate, tariffe
 * minime, nodi) e le Unità di Progettazione, che ne ricavano se sono urbane o
 * extraurbane (riposo minimo 8h o 9h fra due turni nel Roster).
 *
 * Dalla tappa 6.7 sono dati dell'azienda (tabelle `reti` e `reti_regole`,
 * migrazione 0040): li cambia l'amministratore dalla pagina Azienda. Chi li
 * usa sono funzioni pure e sincrone, in profondità: per non passarli da ogni
 * firma, quelli in vigore stanno in memoria. Li aggiorna `leggiAzienda()` a
 * ogni lettura (lib/azienda.ts, al più ogni minuto), e chi apre un punto
 * d'ingresso — una richiesta, un timer, un giro del lavoratore — legge
 * l'azienda prima di cominciare. Finché nessuno li ha letti vale l'elenco
 * neutro: il solo extraurbano, nessuna regola, quindi ogni linea è
 * extraurbana (nel Roster è la regola più severa).
 *
 * Niente import: lo leggono lib/azienda.ts e chiunque altro.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** La rete di tutto quello che non è urbano. C'è sempre, ed è una sola. */
export const RETE_EXTRAURBANA = "extraurbano";

/** Una rete, come sta nella tabella `reti`. */
export interface Rete {
  /** L'identificativo della rete (network_id): «extraurbano» oppure «urbano_<luogo>». */
  rete: string;
  tipo: "urbano" | "extraurbano";
  /** Il nome nell'elenco delle reti e nel GTFS: «Urbano di Ancona». */
  nome: string;
  /** Solo delle urbane: il luogo, come si legge nei nomi («Zona Urbana Ancona»). */
  luogo: string | null;
  /** Solo delle urbane: la sigla nelle classificazioni delle fermate (URB_AN, MIX_EX_AN). */
  sigla: string | null;
  /** Solo delle urbane: la zona tariffaria (area_id), una sola, a tariffa piatta. */
  zona: string | null;
  /** Solo delle urbane: il codice di una fermata servita solo da questa rete. */
  codice: number | null;
  /** Il colore nelle pagine: «#3b82f6». */
  colore: string;
  ordine: number;
  /** Il corrispettivo €/km della rete, al netto dell'IVA (lo fissa la Regione); null: non indicato (tappa 6.29). */
  corrispettivoKm: number | null;
  /** Vero se il corrispettivo si incassa anche sui km a vuoto (uscite, rientri, trasferimenti). */
  corrispettivoSuVuoti: boolean;
}

/** Una rete urbana, con tutto quello che porta con sé. */
export interface ReteUrbana {
  rete: string;
  nome: string;
  luogo: string;
  sigla: string;
  zona: string;
  /** Il codice di una fermata servita solo da questa rete. */
  codice: number;
  /** Il codice di una fermata servita da questa rete e dall'extraurbano: il codice più 10. */
  codiceMisto: number;
  colore: string;
}

/** I tipi di regola: un elenco chiuso, niente espressioni scritte a mano. */
export const TIPI_REGOLA = ["inizia", "uguale", "inizia_poi_cifra", "inizia_con_cifra", "lettere_puntate"] as const;
export type TipoRegola = (typeof TIPI_REGOLA)[number];

/** I tipi che vogliono un valore; gli altri due non ne hanno. */
export const TIPI_CON_VALORE: readonly TipoRegola[] = ["inizia", "uguale", "inizia_poi_cifra"];
export const regolaVuoleValore = (tipo: TipoRegola): boolean => TIPI_CON_VALORE.includes(tipo);

/** Una regola: se il nome breve della linea corrisponde, la linea è di quella rete. */
export interface RegolaLinea {
  tipo: TipoRegola;
  /** In maiuscole; null per i tipi che non ne hanno. */
  valore: string | null;
  rete: string;
}

/** Le reti e le regole di un'azienda. Le regole sono in ordine: vale la prima che corrisponde. */
export interface RetiAzienda {
  reti: readonly Rete[];
  regole: readonly RegolaLinea[];
}

/**
 * I codici con cui si classificano le fermate: 0 non servita, 1 extraurbano,
 * poi uno per rete urbana (da CODICE_URBANO_MIN a CODICE_URBANO_MAX) e lo
 * stesso più SCARTO_CODICE_MISTO se la fermata la serve anche l'extraurbano;
 * 99 tutto il resto. Quindi le reti urbane sono al più otto.
 */
export const CODICE_URBANO_MIN = 2;
export const CODICE_URBANO_MAX = 9;
export const SCARTO_CODICE_MISTO = 10;

/** L'extraurbano di un'installazione che non ha ancora detto niente. */
export const EXTRAURBANO_NEUTRO: Rete = Object.freeze({
  rete: RETE_EXTRAURBANA, tipo: "extraurbano", nome: "Extraurbano", luogo: null, sigla: null, zona: null, codice: null, colore: "#f59e0b", ordine: 1,
  corrispettivoKm: null, corrispettivoSuVuoti: false,
});

/** L'elenco di un'installazione che non ha ancora detto niente: il solo extraurbano, nessuna regola. */
export const RETI_NEUTRE: RetiAzienda = Object.freeze({ reti: Object.freeze([EXTRAURBANO_NEUTRO]), regole: Object.freeze([]) });

/* ── Quello che è in vigore in questo processo ───────────────────────────── */

let inVigore: RetiAzienda = RETI_NEUTRE;
let urbane: readonly ReteUrbana[] = Object.freeze([]);
let perRete = new Map<string, ReteUrbana>();

function urbanaDa(r: Rete): ReteUrbana | null {
  if (r.tipo !== "urbano" || !r.luogo || !r.sigla || !r.zona || r.codice == null) return null;
  return Object.freeze({
    rete: r.rete, nome: r.nome, luogo: r.luogo, sigla: r.sigla, zona: r.zona,
    codice: r.codice, codiceMisto: r.codice + SCARTO_CODICE_MISTO, colore: r.colore,
  });
}

/**
 * Mette in vigore le reti e le regole (la chiama `leggiAzienda()`; nei test,
 * chi prova un'azienda con le sue reti). L'extraurbano c'è sempre: se manca
 * fra le reti si aggiunge quello neutro. Una regola verso una rete che non
 * c'è non vale.
 */
export function impostaReti(r: RetiAzienda): void {
  const reti = [...r.reti].sort((a, b) => a.ordine - b.ordine || a.rete.localeCompare(b.rete)).map((x) => Object.freeze({ ...x }));
  if (!reti.some((x) => x.rete === RETE_EXTRAURBANA)) reti.push(EXTRAURBANO_NEUTRO);
  const note = new Set(reti.map((x) => x.rete));
  const regole = r.regole
    .filter((g) => note.has(g.rete))
    .map((g) => Object.freeze({ tipo: g.tipo, valore: g.valore === null ? null : g.valore.trim().toUpperCase(), rete: g.rete }));
  inVigore = Object.freeze({ reti: Object.freeze(reti), regole: Object.freeze(regole) });
  urbane = Object.freeze(reti.map(urbanaDa).filter((x): x is ReteUrbana => x !== null));
  perRete = new Map(urbane.map((x) => [x.rete, x]));
}

/** Le reti e le regole in vigore in questo processo. */
export const retiInVigore = (): RetiAzienda => inVigore;

/** Le reti urbane in vigore, nell'ordine in cui si mostrano. */
export const retiUrbane = (): readonly ReteUrbana[] => urbane;

/** Gli identificativi delle reti urbane, nello stesso ordine. */
export const idRetiUrbane = (): string[] => urbane.map((r) => r.rete);

/** La rete urbana con quell'identificativo, o null se non è una rete urbana dell'elenco. */
export function reteUrbana(rete: string | null | undefined): ReteUrbana | null {
  return rete ? perRete.get(rete) ?? null : null;
}

/** Vero se è una delle reti urbane dell'elenco. */
export const eReteUrbana = (rete: string | null | undefined): boolean => reteUrbana(rete) !== null;

/** La zona tariffaria di una rete urbana; null per l'extraurbano e per una rete che non è nell'elenco. */
export const zonaDellaRete = (rete: string | null | undefined): string | null => reteUrbana(rete)?.zona ?? null;

/** Il nome della zona tariffaria di una rete urbana: «Zona Urbana Jesi». */
export const nomeZonaUrbana = (r: Pick<ReteUrbana, "luogo">): string => `Zona Urbana ${r.luogo}`;

/** Una rete come la riceve la web con la sessione: quello che serve a mostrarla (etichetta, sigla, codice delle fermate, colore). */
export type RetePerLaWeb = Pick<Rete, "rete" | "tipo" | "nome" | "luogo" | "sigla" | "codice" | "colore">;

/** Le reti in vigore per la web, nell'ordine in cui si mostrano. Non sono dati di persone: le legge chiunque sia entrato. */
export const retiPerLaWeb = (): RetePerLaWeb[] =>
  inVigore.reti.map(({ rete, tipo, nome, luogo, sigla, codice, colore }) => ({ rete, tipo, nome, luogo, sigla, codice, colore }));

/* ── La rete di una linea ─────────────────────────────────────────────────── */

/** Vero se il nome breve (già in maiuscole e senza spazi ai lati) corrisponde alla regola. */
export function corrisponde(nome: string, regola: Pick<RegolaLinea, "tipo" | "valore">): boolean {
  const v = regola.valore ?? "";
  switch (regola.tipo) {
    case "inizia": return v !== "" && nome.startsWith(v);
    case "uguale": return v !== "" && nome === v;
    case "inizia_poi_cifra": return v !== "" && nome.startsWith(v) && /^\d$/.test(nome.charAt(v.length));
    case "inizia_con_cifra": return /^\d/.test(nome);
    case "lettere_puntate": return /^[A-Z]\.[A-Z]\.?$/.test(nome);
    default: return false;
  }
}

/**
 * La rete di una linea secondo un elenco di regole: la prima che corrisponde
 * al nome breve; se non ne corrisponde nessuna, o il nome è vuoto, l'extraurbano.
 */
export function reteDalleRegole(shortName: string | null | undefined, regole: readonly Pick<RegolaLinea, "tipo" | "valore" | "rete">[]): string {
  if (!shortName) return RETE_EXTRAURBANA;
  const nome = shortName.trim().toUpperCase();
  if (!nome) return RETE_EXTRAURBANA;
  for (const g of regole) if (corrisponde(nome, g)) return g.rete;
  return RETE_EXTRAURBANA;
}

/**
 * La rete di default di una linea dal suo nome breve (route_short_name), con
 * le regole in vigore. Rende sempre una rete dell'elenco.
 */
export function classifyRoute(shortName: string | null | undefined): string {
  return reteDalleRegole(shortName, inVigore.regole);
}

/**
 * Il corrispettivo €/km che l'azienda incassa sui km a vuoto per servire una
 * linea (tappa 6.29): quello della rete della linea, se la rete lo paga anche
 * sui vuoti; altrimenti 0, e i km a vuoto costano per intero. Lo riceve il
 * calcolo dei turni macchina corsa per corsa.
 */
export function corrispettivoSuiVuoti(shortName: string | null | undefined): number {
  const r = inVigore.reti.find((x) => x.rete === classifyRoute(shortName));
  return r && r.corrispettivoSuVuoti && r.corrispettivoKm != null ? r.corrispettivoKm : 0;
}

/** Urbano o extraurbano: le linee di una rete urbana dell'elenco sono urbane, tutte le altre no. */
export function servizioDellaLinea(shortName: string | null | undefined): "urbano" | "extraurbano" {
  return eReteUrbana(classifyRoute(shortName)) ? "urbano" : "extraurbano";
}
