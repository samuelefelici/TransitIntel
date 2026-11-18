/**
 * I nodi di scambio dell'azienda (tappa 6.16, migrazione 0046): stazioni,
 * porti, aeroporti e parcheggi scambiatori, con gli orari stimati di arrivi e
 * partenze. Le regole, senza database: le usano il salvataggio
 * (lib/nodi-scambio-store.ts), l'analisi intermodale, le zone di
 * coincidenza, l'ottimizzatore, il confronto fra programmi e i test.
 *
 * Prima erano scritti nel codice in due copie diverse (routes/intermodal.ts e
 * routes/coincidence-zones.ts).
 */

export const TIPI_NODO = ["railway", "port", "airport", "park-ride"] as const;
export type TipoNodo = (typeof TIPI_NODO)[number];

/**
 * I tipi che l'analisi intermodale considera: quelli con treni, navi e aerei
 * da cui si scende. I parcheggi scambiatori servono alle zone di coincidenza.
 */
export const TIPI_DELL_ANALISI: readonly TipoNodo[] = ["railway", "port", "airport"];

/** Le corse da o per un luogo: «Ancona (R)» con i suoi orari «HH:MM». */
export interface Corse { luogo: string; orari: string[] }

export interface NodoDiScambio {
  /** l'identificativo: è quello che le zone di coincidenza ricordano (hub_id) */
  nodo: string;
  nome: string;
  tipo: TipoNodo;
  lat: number;
  lng: number;
  /** gli stop_id del GTFS del nodo; dentro un progetto di Planning Studio non valgono */
  fermateGtfs: string[];
  /** dal binario, dalla nave o dall'aereo alla fermata */
  minutiAPiedi: number;
  descrizione: string;
  /** stima scritta a mano: per le stazioni la sostituisce l'orario vero scaricato */
  arrivi: Corse[];
  partenze: Corse[];
  ordine: number;
}

export const MASSIMO_NODI = 100;
export const MASSIMO_RIGHE_ORARI = 40;
export const MASSIMO_ORARI_PER_RIGA = 300;

/** Un nodo come lo usavano le due copie nel codice: le rotte e i calcoli restano quelli. */
export interface HubDelNodo {
  id: string; name: string; type: TipoNodo; lat: number; lng: number;
  gtfsStopIds: string[]; description: string; platformWalkMinutes: number;
  typicalArrivals: { origin: string; times: string[] }[];
  typicalDepartures: { destination: string; times: string[] }[];
}

export function comeHub(n: NodoDiScambio): HubDelNodo {
  return {
    id: n.nodo, name: n.nome, type: n.tipo, lat: n.lat, lng: n.lng,
    gtfsStopIds: [...n.fermateGtfs], description: n.descrizione, platformWalkMinutes: n.minutiAPiedi,
    typicalArrivals: n.arrivi.map((c) => ({ origin: c.luogo, times: [...c.orari] })),
    typicalDepartures: n.partenze.map((c) => ({ destination: c.luogo, times: [...c.orari] })),
  };
}

/** I nodi che l'analisi intermodale considera, come hub. */
export const hubDellAnalisi = (nodi: readonly NodoDiScambio[]): HubDelNodo[] =>
  nodi.filter((n) => TIPI_DELL_ANALISI.includes(n.tipo)).map(comeHub);

/* ── Gli orari ───────────────────────────────────────────────────────────── */

const ORARIO = /^([0-9]{1,2}):([0-5][0-9])$/;

/** «6:10» → «06:10»; null se non è un orario fra 00:00 e 47:59 (il servizio può passare la mezzanotte). */
export function orarioNormale(s: string): string | null {
  const m = ORARIO.exec(s.trim());
  if (!m || Number(m[1]) > 47) return null;
  return `${m[1]!.padStart(2, "0")}:${m[2]}`;
}

/** Gli orari di una riga: normali, senza doppioni, in ordine. */
export const orariInOrdine = (orari: readonly string[]): string[] =>
  [...new Set(orari)].sort((a, b) => a.localeCompare(b));
