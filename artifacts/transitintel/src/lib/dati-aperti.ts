/**
 * I dati aperti nella pagina Amministrazione › Azienda (tappa 6.3; nell'API
 * lib/dati-aperti.ts, GET, PUT e POST su /api/admin/dati-aperti): il GTFS e il
 * NeTEx pubblicati a un indirizzo stabile, per il NAP. Funzioni pure, coi loro
 * test.
 */

export type TipoFile = "gtfs" | "netex" | "netex_l3";
export type EsitoFile = "pubblicato" | "gtfs_con_errori" | "non_valido" | "senza_xmllint" | "senza_codice" | "senza_versione" | "errore" | "senza_tariffe";

export interface StatoFile {
  tipo: TipoFile;
  formato: string;
  percorso: string;
  inLinea: null | {
    impronta: string; byte: number; preparatoIl: string; inEsercizioDal: string | null;
    dellaVersioneInEsercizio: boolean; conteggi: any;
  };
  ultimoTentativo: null | { esito: EsitoFile; messaggio: string | null; provatoIl: string | null; dettagli: any };
}

export interface StatoDatiAperti {
  attivi: boolean;
  aziendaCompilata: boolean;
  versione: { nome: string; dal: string | null } | null;
  senzaVersione: string | null;
  file: StatoFile[];
}

export const NOME_FILE: Record<TipoFile, string> = { gtfs: "GTFS", netex: "NeTEx", netex_l3: "NeTEx con le tariffe" };
export const DETTAGLIO_FILE: Record<TipoFile, string> = {
  gtfs: "orari, fermate e percorsi nel formato più diffuso, con le tariffe",
  netex: "profilo italiano, livello 1: il formato che chiede il NAP",
  netex_l3: "profilo italiano, livello 3: rete, orari e tariffe",
};

/** L'indirizzo intero da registrare: l'origine dell'API e il percorso, che non cambia. */
export const indirizzo = (origine: string, percorso: string) => `${origine.replace(/\/+$/, "")}${percorso}`;

/** «1,8 MB», «740 kB», «512 byte». */
export function dimensione(byte: number): string {
  if (!Number.isFinite(byte) || byte < 0) return "—";
  if (byte < 1000) return `${byte} byte`;
  if (byte < 1_000_000) return `${Math.round(byte / 1000)} kB`;
  return `${(byte / 1_000_000).toLocaleString("it-IT", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} MB`;
}

/** «17/11/2026, 08:12» in ora italiana; «—» senza data. */
export function quando(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("it-IT", { timeZone: "Europe/Rome", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export type Tono = "ok" | "attenzione" | "fermo";

/**
 * Com'è messo un file, in una riga: in linea e aggiornato; in linea ma è
 * quello di prima (il nuovo non è uscito); niente in linea.
 */
export function riassunto(f: StatoFile): { tono: Tono; testo: string } {
  const esito = f.ultimoTentativo?.esito ?? null;
  if (f.inLinea) {
    if (esito === "pubblicato" && f.inLinea.dellaVersioneInEsercizio) return { tono: "ok", testo: "In linea" };
    return { tono: "attenzione", testo: "In linea c'è il file di prima: quello nuovo non è uscito" };
  }
  if (!esito) return { tono: "fermo", testo: "Non ancora preparato" };
  return { tono: "fermo", testo: "Niente in linea" };
}

const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v.toLocaleString("it-IT") : null);

/** Che cosa c'è dentro il file in linea, in poche voci: «3.502 corse», «128 linee»… */
export function contenuto(f: StatoFile): string[] {
  const c = f.inLinea?.conteggi;
  if (!c || typeof c !== "object") return [];
  const voci: Array<[unknown, string, string]> = f.tipo === "gtfs"
    ? [[c.righe?.["trips.txt"], "corsa", "corse"], [c.righe?.["stops.txt"], "fermata", "fermate"], [c.righe?.["routes.txt"], "linea", "linee"]]
    : [[c.corse, "corsa", "corse"], [c.fermate, "fermata", "fermate"], [c.linee, "linea", "linee"]];
  const out = voci.filter(([v]) => n(v) !== null).map(([v, uno, tanti]) => `${n(v)} ${v === 1 ? uno : tanti}`);
  /* i gestori (tappe 6.11 e 6.12): le agenzie del GTFS, gli operatori del NeTEx. Si dicono solo se sono più d'uno. */
  const gestori = f.tipo === "gtfs" ? c.righe?.["agency.txt"] : c.operatori;
  if (typeof gestori === "number" && gestori > 1) out.push(`${n(gestori)} ${f.tipo === "gtfs" ? "agenzie" : "operatori"}`);
  if (f.tipo === "gtfs" && typeof c.avvisi === "number" && c.avvisi > 0) out.push(`${n(c.avvisi)} ${c.avvisi === 1 ? "avviso" : "avvisi"} del controllo`);
  /* il NeTEx di livello 3 (tappa 6.41): i titoli e le zone tariffarie */
  if (c.tariffe && typeof c.tariffe === "object") {
    if (n(c.tariffe.prodotti)) out.push(`${n(c.tariffe.prodotti)} ${c.tariffe.prodotti === 1 ? "titolo" : "titoli"}`);
    if (n(c.tariffe.zone)) out.push(`${n(c.tariffe.zone)} ${c.tariffe.zone === 1 ? "zona tariffaria" : "zone tariffarie"}`);
  }
  if (f.tipo !== "gtfs" && typeof c.corseSenzaGiorni === "number" && c.corseSenzaGiorni > 0) {
    out.push(`${n(c.corseSenzaGiorni)} ${c.corseSenzaGiorni === 1 ? "corsa lasciata fuori" : "corse lasciate fuori"} (senza giorni di servizio)`);
  }
  return out;
}

/** Le righe d'errore dell'ultimo tentativo, da mostrare sotto il motivo (al più `quante`). */
export function erroriDelTentativo(f: StatoFile, quante = 5): string[] {
  const e = f.ultimoTentativo?.dettagli?.errori;
  if (!Array.isArray(e)) return [];
  return e.slice(0, quante).map((x: any) =>
    typeof x === "string" ? x : `${x?.messaggio ?? "errore"}${typeof x?.quante === "number" ? ` (${x.quante.toLocaleString("it-IT")})` : ""}`);
}
