/**
 * Il registro delle modifiche, letto in italiano (pagina dell'amministratore,
 * pages/admin-registro.tsx; API GET /api/admin/registro, PR 2.11).
 *
 * Solo funzioni pure: nomi delle tabelle, delle operazioni e dei canali, il
 * confronto prima/dopo di una riga, il periodo. Niente qui (né nella pagina)
 * filtra, ordina o conta per persona: è una decisione, non una dimenticanza.
 */

export interface AttoreRegistro { id: string; nome: string | null; email: string | null }
export interface AmbitoRegistro { tipo: string; id: string | null; nome: string | null }

export interface RigaRegistro {
  ts: string;
  transazione: string;
  richiesta: string | null;
  attore: AttoreRegistro | null;
  via: string | null;
  origine: string | null;
  ruoloDb: string;
  tabella: string;
  operazione: string;
  chiave: Record<string, unknown> | null;
  ambito: AmbitoRegistro | null;
  campi: string[] | null;
  prima: Record<string, unknown> | null;
  dopo: Record<string, unknown> | null;
  riepilogo: boolean;
  righe: number | null;
  campione: Array<Record<string, unknown>> | null;
  aCascata: boolean;
}

export interface StatoRegistro {
  attivo: boolean;
  attivatoIl: string | null;
  baseGiuridica: string;
  anonimizzaDopoMesi: number;
  conservazioneMesi: number;
  tabelle: Array<{ tabella: string; ambitoTipo: string | null; conValori: boolean; riepilogoSempre: boolean }>;
}

export interface RispostaRegistro {
  stato: StatoRegistro;
  righe: RigaRegistro[];
  successivo: string | null;
  troppeInUnaTransazione: boolean;
}

const TABELLE: Record<string, string> = {
  "public.users": "Utenti",
  "public.app_settings": "Parametri di esercizio",
  "public.gtfs_feeds": "Feed GTFS",
  "public.gtfs_fare_products": "Prodotti tariffari",
  "public.ps_projects": "Programmi di esercizio",
  "public.ps_project_members": "Membri dei programmi",
  "public.ps_routes": "Linee",
  "public.ps_route_variants": "Varianti di percorso",
  "public.ps_stops": "Fermate",
  "public.ps_trips": "Corse",
  "public.ps_calendars": "Calendari",
  "public.ps_validity_units": "Unità di validità",
  "public.scheduling_projects": "Progetti dei turni",
  "public.service_program_scenarios": "Scenari dei turni macchina",
  "public.driver_shift_scenarios": "Scenari dei turni guida",
  "public.depots": "Depositi",
  "public.roster_drivers": "Anagrafica dei conducenti",
  "public.roster_driver_history": "Storico dei conducenti",
  "public.roster_assignments": "Assegnazioni del roster",
  "public.roster_entries": "Voci del roster",
  "public.roster_pubblicazioni": "Pubblicazioni del roster",
  "public.ps_stop_times": "Orari alle fermate",
  "public.ps_variant_stops": "Fermate delle varianti",
  "public.ps_calendar_dates": "Eccezioni dei calendari",
  "public.ps_shapes": "Tracciati",
  "public.ps_service_periods": "Periodi di servizio",
  "public.ps_stop_clusters": "Nodi di interscambio",
  "public.ps_no_go_zones": "Zone vietate",
  "public.ps_pending_activations": "Attivazioni programmate",
};

/** Il nome di una tabella per chi legge; una tabella che qui non c'è ancora resta col suo nome. */
export function nomeTabella(tabella: string): string {
  return TABELLE[tabella] ?? tabella.replace(/^public\./, "");
}

const OPERAZIONI: Record<string, string> = {
  INSERT: "aggiunta", UPDATE: "modifica", DELETE: "cancellazione", TRUNCATE: "svuotamento",
};
export const ELENCO_OPERAZIONI = Object.keys(OPERAZIONI);
export function nomeOperazione(op: string): string {
  return OPERAZIONI[op] ?? op;
}

const AMBITI: Record<string, string> = {
  progetto_ps: "programma", progetto_turni: "progetto dei turni", feed: "feed", scenario: "scenario",
  corsa: "corsa", variante: "variante", calendario: "calendario", utente: "utente", conducente: "conducente",
};
/** Gli ambiti che si possono fissare col loro id: mai una persona (lo rifiutano anche l'API e il database). */
export const AMBITI_FILTRABILI = ["progetto_ps", "progetto_turni", "feed", "scenario", "corsa", "variante", "calendario"];
export const ELENCO_AMBITI = Object.keys(AMBITI);
export function nomeAmbito(tipo: string): string {
  return AMBITI[tipo] ?? tipo;
}

/** Da dove è arrivata la modifica (cerbero.via, PR 2.9), in parole. */
export function nomeVia(via: string | null): string {
  if (!via) return "—";
  if (/^argos(:|$)/.test(via)) {
    if (via.endsWith(":timer:attivazioni")) return "Argos, attivazione programmata";
    const coda = /:coda:(.+)$/.exec(via);
    if (coda) return `Argos, calcolo in coda (${coda[1]})`;
    const canale = via.slice("argos".length + 1);
    return canale ? `Argos (${canale})` : "Argos";
  }
  if (via === "api") return "dall'app";
  if (via === "accesso") return "all'accesso";
  if (via === "caronte") return "Caronte";
  if (via === "pulizie" || via.startsWith("pulizie:")) return "pulizie automatiche";
  if (via === "timer:attivazioni") return "attivazione programmata";
  if (via.startsWith("timer:")) return `automatismo (${via.slice(6)})`;
  if (via.startsWith("cron:")) return `operazione pianificata (${via.slice(5)})`;
  if (via === "coda") return "coda dei calcoli";
  if (via.startsWith("coda:")) return `calcolo in coda (${via.slice(5)})`;
  if (via.startsWith("avvio")) return "avvio del sistema";
  if (via === "anagrafica:giorno") return "sincronizzazione dell'anagrafica";
  if (via === "registro") return "manutenzione del registro";
  return via;
}

/** Chi ha fatto la modifica. Senza attore: un processo di sistema, o il nome già cancellato. */
export function nomeAttore(r: Pick<RigaRegistro, "attore" | "via">): string {
  if (r.attore) return r.attore.nome || r.attore.email || `utente ${r.attore.id.slice(0, 8)}`;
  return r.via && /^(timer|cron|coda|pulizie|avvio|anagrafica|registro)(:|$)/.test(r.via) ? "sistema" : "—";
}

const LUNGHEZZA_MAX = 240;
/** Un valore del registro come testo (mai come HTML: lo mette React in un nodo di testo). */
export function mostraValore(v: unknown): string {
  if (v === null || v === undefined) return "vuoto";
  if (v === true) return "sì";
  if (v === false) return "no";
  const t = typeof v === "string" ? v : JSON.stringify(v);
  if (t === "") return "vuoto";
  return t.length > LUNGHEZZA_MAX ? `${t.slice(0, LUNGHEZZA_MAX)}…` : t;
}

export interface VoceConfronto {
  campo: string;
  /** null: il registro di questo campo tiene solo il nome (persone, roster, dati pesanti) */
  prima: string | null;
  dopo: string | null;
  soloNome: boolean;
}

/**
 * Il prima e dopo di una riga per record, campo per campo. Un campo cambiato di
 * cui il registro non tiene il valore resta col solo nome. Un'aggiunta mostra i
 * valori nuovi, una cancellazione quelli vecchi. I riepiloghi non hanno confronto.
 */
export function confronto(r: Pick<RigaRegistro, "operazione" | "campi" | "prima" | "dopo" | "riepilogo">): VoceConfronto[] {
  if (r.riepilogo) return [];
  const prima = r.prima ?? {};
  const dopo = r.dopo ?? {};
  const ha = (o: Record<string, unknown>, c: string) => Object.prototype.hasOwnProperty.call(o, c);
  const campi = r.operazione === "UPDATE"
    ? (r.campi ?? [])
    : Object.keys(r.operazione === "DELETE" ? prima : dopo).sort();
  return campi.map((campo) => {
    const p = ha(prima, campo), d = ha(dopo, campo);
    return { campo, prima: p ? mostraValore(prima[campo]) : null, dopo: d ? mostraValore(dopo[campo]) : null, soloNome: !p && !d };
  });
}

/** Che cosa è successo, in una riga. */
export function descrizione(r: Pick<RigaRegistro, "operazione" | "campi" | "riepilogo" | "righe" | "aCascata">): string {
  if (r.operazione === "TRUNCATE") return "tabella svuotata";
  if (r.riepilogo) {
    const n = r.righe ?? 0;
    const quante = n === 1 ? "1 riga" : `${n.toLocaleString("it-IT")} righe`;
    const campi = r.campi?.length ? `: ${r.campi.join(", ")}` : "";
    return `${quante}${campi}${r.aCascata ? " (di conseguenza)" : ""}`;
  }
  if (r.operazione === "INSERT") return "riga aggiunta";
  if (r.operazione === "DELETE") return "riga cancellata";
  return r.campi?.length ? r.campi.join(", ") : "—";
}

const due = (n: number) => String(n).padStart(2, "0");
const giornoLocale = (d: Date) => `${d.getFullYear()}-${due(d.getMonth() + 1)}-${due(d.getDate())}`;

/** Il periodo con cui si apre la pagina: gli ultimi 7 giorni, oggi compreso. */
export function periodoPredefinito(oggi: Date = new Date()): { da: string; a: string } {
  const da = new Date(oggi.getFullYear(), oggi.getMonth(), oggi.getDate() - 6);
  return { da: giornoLocale(da), a: giornoLocale(oggi) };
}

export const GIORNI_MAX = 92;

/**
 * Dai due giorni scelti (AAAA-MM-GG, ora locale) agli istanti per l'API:
 * dall'inizio del primo alla fine del secondo. Un periodo rovesciato, vuoto o
 * più lungo di 92 giorni dà un errore da mostrare.
 */
export function istanti(da: string, a: string): { da: string; a: string } | { errore: string } {
  const giorno = /^(\d{4})-(\d{2})-(\d{2})$/;
  const i = giorno.exec(da), f = giorno.exec(a);
  if (!i || !f) return { errore: "Scegli il primo e l'ultimo giorno" };
  const inizio = new Date(+i[1]!, +i[2]! - 1, +i[3]!, 0, 0, 0, 0);
  const fine = new Date(+f[1]!, +f[2]! - 1, +f[3]!, 23, 59, 59, 999);
  if (!(inizio.getTime() < fine.getTime())) return { errore: "Il primo giorno viene dopo l'ultimo" };
  if ((fine.getTime() - inizio.getTime()) / 86_400_000 > GIORNI_MAX) return { errore: `Al più ${GIORNI_MAX} giorni per volta` };
  return { da: inizio.toISOString(), a: fine.toISOString() };
}

export interface FiltriRegistro {
  da: string;
  a: string;
  tabella: string;
  operazione: string;
  ambitoTipo: string;
  ambitoId: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** La richiesta all'API per questi filtri (e, per le pagine dopo la prima, il cursore). */
export function richiesta(f: FiltriRegistro, cursore?: string | null): { percorso: string } | { errore: string } {
  const periodo = istanti(f.da, f.a);
  if ("errore" in periodo) return periodo;
  const q = new URLSearchParams({ da: periodo.da, a: periodo.a });
  if (f.tabella) q.set("tabella", f.tabella);
  if (f.operazione) q.set("operazione", f.operazione);
  if (f.ambitoTipo) q.set("ambitoTipo", f.ambitoTipo);
  const id = f.ambitoId.trim();
  if (id) {
    if (!AMBITI_FILTRABILI.includes(f.ambitoTipo)) return { errore: "L'identificativo si può indicare solo per un programma, un feed, una corsa e simili: non per una persona" };
    if (!UUID.test(id)) return { errore: "L'identificativo non è valido" };
    q.set("ambitoId", id);
  }
  if (cursore) q.set("cursore", cursore);
  return { percorso: `/api/admin/registro?${q.toString()}` };
}
