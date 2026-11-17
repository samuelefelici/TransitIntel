/**
 * Gli elenchi di partenza delle tariffe e l'agenzia dei GTFS (tappa 6.10,
 * migrazione 0043): le regole, senza database.
 *
 * Tre elenchi dell'azienda da cui la pagina Tariffe riempie un feed:
 *   - le categorie di passeggero (una sola è quella predefinita);
 *   - i supporti su cui si carica un titolo, col tipo del GTFS;
 *   - i nodi tariffari ufficiali, con gli altri nomi con cui compaiono. La
 *     scheda dei nodi nella pagina Tariffe oggi è spenta: l'elenco si legge
 *     e si copia in un feed, ma non ha ancora una pagina per cambiarlo.
 * E l'agenzia del GTFS delle tariffe: chi figura in agency.txt quando non è
 * l'azienda stessa (per esempio il consorzio di cui fa parte).
 *
 * Questo modulo non importa niente: lo usano le rotte, il salvataggio
 * (lib/elenchi-tariffe-store.ts) e i test.
 */

export interface CategoriaCatalogo {
  /** l'identificativo, quello che finisce nel GTFS (rider_category_id) */
  categoria: string;
  nome: string;
  /** vale quando un titolo non dice la categoria: al più una */
  predefinita: boolean;
  /** dove si leggono i requisiti, se c'è una pagina */
  url: string | null;
}

export interface SupportoCatalogo {
  /** l'identificativo, quello che finisce nel GTFS (fare_media_id) */
  supporto: string;
  nome: string;
  /** il tipo del GTFS: vedi TIPI_SUPPORTO */
  tipo: number;
}

export interface NodoCatalogo {
  codice: string;
  nome: string;
  lat: number | null;
  lon: number | null;
  /** gli altri nomi con cui il nodo compare nelle fermate */
  alias: string[];
}

export interface AgenziaGtfs {
  agencyId: string;
  nome: string;
  sito: string;
  telefono: string | null;
  email: string | null;
  /** la pagina delle tariffe (agency_fare_url) */
  tariffeUrl: string | null;
}

/** I tipi di supporto del GTFS (fare_media_type). */
export const TIPI_SUPPORTO: ReadonlyArray<{ tipo: number; nome: string }> = Object.freeze([
  { tipo: 0, nome: "Nessun supporto (a bordo)" },
  { tipo: 1, nome: "Biglietto o tessera di carta" },
  { tipo: 2, nome: "Tessera di trasporto" },
  { tipo: 3, nome: "Carta bancaria" },
  { tipo: 4, nome: "Applicazione" },
]);

export const MASSIMO_CATEGORIE = 40;
export const MASSIMO_SUPPORTI = 40;

/** Il primo valore che compare due volte, se c'è. */
function doppione(valori: readonly string[]): string | null {
  const visti = new Set<string>();
  for (const v of valori) { if (visti.has(v)) return v; visti.add(v); }
  return null;
}

/** Che cosa non va in un elenco di categorie: vuoto se va bene. */
export function erroriCategorie(lista: readonly CategoriaCatalogo[]): string[] {
  const e: string[] = [];
  const d = doppione(lista.map((c) => c.categoria));
  if (d) e.push(`La categoria «${d}» compare due volte.`);
  const predefinite = lista.filter((c) => c.predefinita).length;
  if (lista.length > 0 && predefinite !== 1) {
    e.push(predefinite === 0
      ? "Una categoria deve essere quella predefinita: vale per i titoli che non ne dicono un'altra."
      : "La categoria predefinita è una sola.");
  }
  return e;
}

export function erroriSupporti(lista: readonly SupportoCatalogo[]): string[] {
  const d = doppione(lista.map((s) => s.supporto));
  return d ? [`Il supporto «${d}» compare due volte.`] : [];
}

/** Gli altri nomi di un nodo come stanno nella tabella: separati da «;». */
export const aliasDaTesto = (testo: string | null | undefined): string[] =>
  String(testo ?? "").split(";").map((a) => a.trim()).filter(Boolean);

/* ── L'agenzia nel GTFS delle tariffe ─────────────────────────────────────── */

/** Dell'azienda, quello che serve quando è lei l'agenzia. */
export interface AziendaPerIlGtfs {
  gtfsAgencyId: string;
  ragioneSociale: string;
  sito: string | null;
  telefono: string | null;
}

/** Le colonne di agency.txt, nell'ordine in cui si scrivono. */
export const COLONNE_AGENZIA = [
  "agency_id", "agency_name", "agency_url", "agency_timezone", "agency_lang", "agency_phone", "agency_fare_url", "agency_email",
] as const;
export type AgenziaNelGtfs = Record<(typeof COLONNE_AGENZIA)[number], string> & {
  /** true se non c'è un'agenzia a parte: è l'azienda dell'installazione */
  daAzienda: boolean;
};

/**
 * L'agenzia che il GTFS delle tariffe scrive: quella dei dati dell'azienda
 * (tabella agenzia_gtfs) se c'è, altrimenti l'azienda stessa. Un campo che
 * manca resta vuoto: lo dice la validazione, non si inventa.
 */
export function agenziaNelGtfs(azienda: AziendaPerIlGtfs, agenzia: AgenziaGtfs | null): AgenziaNelGtfs {
  const comune = { agency_timezone: "Europe/Rome", agency_lang: "it" };
  if (agenzia) {
    return {
      agency_id: agenzia.agencyId, agency_name: agenzia.nome, agency_url: agenzia.sito, ...comune,
      agency_phone: agenzia.telefono ?? "", agency_fare_url: agenzia.tariffeUrl ?? "", agency_email: agenzia.email ?? "",
      daAzienda: false,
    };
  }
  return {
    agency_id: azienda.gtfsAgencyId, agency_name: azienda.ragioneSociale, agency_url: azienda.sito ?? "", ...comune,
    agency_phone: azienda.telefono ?? "", agency_fare_url: "", agency_email: "",
    daAzienda: true,
  };
}

/** Un campo di un CSV: fra virgolette solo se serve, con le virgolette raddoppiate. */
export function campoCsv(valore: unknown): string {
  const s = String(valore ?? "");
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** agency.txt: l'intestazione e la riga dell'agenzia, ogni campo fra virgolette. */
export function agencyTxt(a: AgenziaNelGtfs): string {
  const tra = (s: string) => `"${s.replace(/"/g, '""')}"`;
  return `${COLONNE_AGENZIA.join(",")}\n${COLONNE_AGENZIA.map((c) => tra(a[c])).join(",")}\n`;
}
