/**
 * La console di Argos (pagina /argos): i dati che arrivano dal proxy
 * /api/ai/argos/console/* (routes/argos-console.ts dell'API) e le regole pure
 * per mostrarli. Niente React qui: le funzioni hanno i loro test.
 *
 * Il vocabolario è quello di Argos: un agente ha una fascia di modello, un'
 * autonomia (osserva < propone < applica) e delle skill; ogni strumento ha un
 * modulo di Cerbero e un effetto (lettura < esito < memoria < scrittura <
 * distruttivo); ogni esecuzione lascia una traccia di eventi in ordine.
 */
import { getApiBase } from "@/lib/api";
import type { ArcoGrafo, NodoGrafo } from "@/lib/argos-grafo";

export const EFFETTI = ["lettura", "esito", "memoria", "scrittura", "distruttivo"] as const;
export type Effetto = (typeof EFFETTI)[number];
export const AUTONOMIE = ["osserva", "propone", "applica"] as const;
export type Autonomia = (typeof AUTONOMIE)[number];
export type Fascia = "veloce" | "standard" | "profondo";

/** In questa fase un agente della console non scrive su Cerbero (argos/api/esecuzione.py). */
export const AUTONOMIA_MASSIMA: Autonomia = "propone";

export interface Capacita {
  name: string;
  modulo: string;
  effetto: Effetto;
  descrizione: string;
  fonte?: string;
}

export interface Registro {
  totale: number;
  perModulo: Record<string, number>;
  perEffetto: Partial<Record<Effetto, number>>;
  autonomie: string[];
  capacita: Capacita[];
}

export interface SchedaAgente {
  chiave: string;
  nome: string;
  descrizione: string;
  livelloModello: Fascia;
  autonomia: Autonomia;
  skills: Array<{ chiave: string; nome: string; versione: number }>;
  strumenti: string[];
  perEffetto: Partial<Record<Effetto, number>>;
}

export interface DettaglioAgente extends SchedaAgente {
  systemPrompt: string;
  capacita: Capacita[];
}

export interface Skill {
  chiave: string;
  nome: string;
  descrizione: string;
  versioneAttiva: number;
  origine: string;
  versioni: Array<{ versione: number; stato: string; origine: string; strumenti: string[]; nota: string | null; punteggio: number | null; creata: string | null }>;
}

export type StatoEsecuzione = "running" | "completed" | "failed" | "empty";

export interface RigaEsecuzione {
  id: number;
  agent_key: string;
  project_id: string;
  objective: string;
  status: StatoEsecuzione;
  tokens: number;
  error: string | null;
  created_at: string;
  updated_at: string;
  eventi: number;
  proposte: number;
}

export const TIPI_EVENTO = ["avvio", "nota", "strumento", "esito", "rifiuto", "piano", "domanda", "rapporto", "testo", "fine", "errore"] as const;
export type TipoEvento = (typeof TIPI_EVENTO)[number];

export interface EventoTraccia {
  seq: number;
  tipo: TipoEvento;
  dati: Record<string, any>;
  at: string;
}

export interface Proposta {
  id: number;
  kind: string;
  title: string;
  line: string | null;
  detail: string;
  rationale: string;
  impact: string;
  confidence: string;
  priority: string;
  status: string;
}

export interface DettaglioEsecuzione extends Omit<RigaEsecuzione, "eventi" | "proposte"> {
  summary: string;
  diagnosis: string;
  eventi: EventoTraccia[];
  proposte: Proposta[];
}

export interface StatoArgos {
  configured: boolean;
  reachable?: boolean;
  cerbero?: boolean;
  transitintel?: boolean;
  proxySecret?: boolean;
  argosProxy?: boolean;
  reason?: string;
  error?: string;
}

export interface Budget { used: number; limit: number; remaining: number }

// ─── etichette ──────────────────────────────────────────────────────────────
export const NOMI_EFFETTO: Record<Effetto, string> = {
  lettura: "Lettura", esito: "Esito", memoria: "Memoria", scrittura: "Scrittura", distruttivo: "Distruttivo",
};
export const SPIEGA_EFFETTO: Record<Effetto, string> = {
  lettura: "legge i dati, non cambia niente",
  esito: "il canale d'uscita: piano, domanda, rapporto, anteprima",
  memoria: "scrive solo la memoria di Argos (note, migliorie)",
  scrittura: "cambia i dati di Cerbero",
  distruttivo: "toglie dati da Cerbero",
};
export const NOMI_MODULO: Record<string, string> = {
  planning: "Planning Studio", scheduling: "Turni", territorio: "Territorio",
  esercizio: "Esercizio", roster: "Roster (senza nomi)", documenti: "Documenti", argos: "Argos", web: "Web",
};
export const NOMI_AUTONOMIA: Record<Autonomia, string> = { osserva: "Osserva", propone: "Propone", applica: "Applica" };
export const SPIEGA_AUTONOMIA: Record<Autonomia, string> = {
  osserva: "legge e riferisce, non tocca niente",
  propone: "legge, propone piani e aggiorna la memoria del progetto",
  applica: "può scrivere su Cerbero, sempre con anteprima e conferma",
};
export const NOMI_FASCIA: Record<Fascia, string> = { veloce: "Veloce", standard: "Standard", profondo: "Profondo" };
export const NOMI_STATO: Record<StatoEsecuzione, string> = {
  running: "In corso", completed: "Completata", failed: "Fallita", empty: "Vuota",
};
export const NOMI_TIPO: Record<TipoEvento, string> = {
  avvio: "Avvio", nota: "Nota", strumento: "Strumento", esito: "Esito", rifiuto: "Rifiuto del guardiano",
  piano: "Piano", domanda: "Domanda", rapporto: "Rapporto", testo: "Risposta", fine: "Fine", errore: "Errore",
};

export function nomeModulo(m: string): string {
  return NOMI_MODULO[m] ?? m;
}

/** L'autonomia con cui l'agente lavora davvero in questa fase. */
export function autonomiaEffettiva(a: Autonomia): Autonomia {
  return AUTONOMIE.indexOf(a) > AUTONOMIE.indexOf(AUTONOMIA_MASSIMA) ? AUTONOMIA_MASSIMA : a;
}

// ─── formati ────────────────────────────────────────────────────────────────
export function durata(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${Math.round(s - m * 60)} s`;
}

export function token(n: number | null | undefined): string {
  if (!n || n < 0) return "0";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)} M`;
}

/** Quanto tempo fa, in parole brevi. `ora` per i test. */
export function quandoFa(iso: string | null | undefined, ora: Date = new Date()): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "—";
  const s = Math.max(0, Math.round((ora.getTime() - t) / 1000));
  if (s < 60) return "adesso";
  if (s < 3600) return `${Math.floor(s / 60)} min fa`;
  if (s < 86400) return `${Math.floor(s / 3600)} h fa`;
  const g = Math.floor(s / 86400);
  return g === 1 ? "ieri" : `${g} giorni fa`;
}

// ─── la traccia ─────────────────────────────────────────────────────────────
export interface Riepilogo {
  strumenti: number;
  falliti: number;
  rifiuti: number;
  proposte: number;
  token: number;
  ms: number | null;
  modello: string | null;
  limitata: boolean;
  /** strumento → quante volte e quanto tempo in tutto */
  perStrumento: Array<{ nome: string; volte: number; ms: number; falliti: number }>;
  perModulo: Record<string, number>;
}

/** I numeri di un'esecuzione, letti dalla sua traccia. */
export function riepilogo(eventi: readonly EventoTraccia[]): Riepilogo {
  const per = new Map<string, { nome: string; volte: number; ms: number; falliti: number }>();
  const perModulo: Record<string, number> = {};
  let falliti = 0, rifiuti = 0, strumenti = 0;
  let fine: Record<string, any> | null = null, avvio: Record<string, any> | null = null, limitata = false;
  for (const e of eventi) {
    if (e.tipo === "avvio") avvio = e.dati;
    else if (e.tipo === "fine") fine = e.dati;
    else if (e.tipo === "rifiuto") rifiuti++;
    else if (e.tipo === "nota" && /limitata/.test(String(e.dati?.testo ?? ""))) limitata = true;
    else if (e.tipo === "strumento") {
      strumenti++;
      const m = String(e.dati?.modulo ?? "");
      if (m) perModulo[m] = (perModulo[m] ?? 0) + 1;
    } else if (e.tipo === "esito") {
      const nome = String(e.dati?.nome ?? "?");
      const r = per.get(nome) ?? { nome, volte: 0, ms: 0, falliti: 0 };
      r.volte++;
      r.ms += Number(e.dati?.ms) || 0;
      if (e.dati?.ok === false) { r.falliti++; falliti++; }
      per.set(nome, r);
    }
  }
  return {
    strumenti, falliti, rifiuti,
    proposte: Number(fine?.proposte) || 0,
    token: Number(fine?.tokens) || 0,
    ms: fine && Number.isFinite(Number(fine.ms)) ? Number(fine.ms) : null,
    modello: avvio?.modello ? String(avvio.modello) : null,
    limitata,
    perStrumento: [...per.values()].sort((a, b) => b.ms - a.ms || b.volte - a.volte),
    perModulo,
  };
}

/** Una riga leggibile per un evento della traccia. */
export function sintesiEvento(e: EventoTraccia): string {
  const d = e.dati ?? {};
  switch (e.tipo) {
    case "avvio": return `${d.agente ?? "agente"} · ${d.fascia ?? ""} · ${Array.isArray(d.strumenti) ? d.strumenti.length : 0} strumenti offerti`;
    case "nota": return String(d.testo ?? "");
    case "strumento": return `${d.nome} · ${nomeModulo(String(d.modulo ?? ""))} · ${d.effetto ?? ""}`;
    case "esito": return d.ok === false ? `${d.nome}: ${d.errore ?? "errore"}` : `${d.nome}: ok · ${durata(d.ms)} · ${d.caratteri ?? 0} caratteri`;
    case "rifiuto": return `${d.nome}: ${d.motivo ?? ""}`;
    case "piano": return `${d.proposte ?? 0} proposte · ${d.sintesi ?? ""}`;
    case "domanda": return String(d.domanda ?? "");
    case "rapporto": return String(d.titolo ?? d.sintesi ?? "rapporto");
    case "testo": return String(d.testo ?? "").slice(0, 160);
    case "fine": return `${NOMI_STATO[d.status as StatoEsecuzione] ?? d.status} · ${token(d.tokens)} token · ${durata(d.ms)}`;
    case "errore": return String(d.messaggio ?? "");
    default: return "";
  }
}

// ─── lo stream di un'esecuzione ─────────────────────────────────────────────
export type EventoStream =
  | { run_id: number }
  | { t: string }
  | { reset: true }
  | { note: string }
  | { tool: { name: string } }
  | { tool_done: { name: string; ok: boolean } }
  | { plan: Record<string, any> }
  | { ask: Record<string, any> }
  | { error: string }
  | { done: { run_id: number; status: StatoEsecuzione; tokens: number; proposte: number; ms: number } };

/**
 * Spezza il testo arrivato dallo stream SSE in eventi completi. Ritorna gli
 * eventi e il pezzo non ancora finito, da rimettere davanti al prossimo.
 * I commenti (": hb", il battito per i proxy) e le righe illeggibili si saltano.
 */
export function spezzaSSE(buffer: string): { eventi: EventoStream[]; resto: string } {
  const parti = buffer.replace(/\r\n/g, "\n").split("\n\n");
  const resto = parti.pop() ?? "";
  const eventi: EventoStream[] = [];
  for (const p of parti) {
    const dati = p.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
    if (!dati) continue;
    try {
      const v = JSON.parse(dati);
      if (v && typeof v === "object") eventi.push(v as EventoStream);
    } catch { /* riga illeggibile: si salta */ }
  }
  return { eventi, resto };
}

/** Lo stato di un'esecuzione dal vivo, aggiornato evento per evento. */
export interface Diretta {
  runId: number | null;
  testo: string;
  note: string[];
  strumenti: Array<{ nome: string; ok: boolean | null }>;
  piano: Record<string, any> | null;
  domanda: Record<string, any> | null;
  errore: string | null;
  fine: { status: StatoEsecuzione; tokens: number; proposte: number; ms: number } | null;
}

export const DIRETTA_VUOTA: Diretta = { runId: null, testo: "", note: [], strumenti: [], piano: null, domanda: null, errore: null, fine: null };

export function applica(d: Diretta, ev: EventoStream): Diretta {
  if ("run_id" in ev) return { ...d, runId: ev.run_id };
  if ("t" in ev) return { ...d, testo: d.testo + ev.t };
  if ("reset" in ev) return { ...d, testo: "" };
  if ("note" in ev) return ev.note ? { ...d, note: [...d.note, ev.note] } : d;
  if ("tool" in ev) return { ...d, strumenti: [...d.strumenti, { nome: ev.tool.name, ok: null }] };
  if ("tool_done" in ev) {
    // gli strumenti di un giro si eseguono in ordine: l'esito va alla prima chiamata ancora aperta
    const i = d.strumenti.findIndex((s) => s.nome === ev.tool_done.name && s.ok === null);
    const strumenti = i < 0
      ? [...d.strumenti, { nome: ev.tool_done.name, ok: ev.tool_done.ok }]
      : d.strumenti.map((s, k) => (k === i ? { ...s, ok: ev.tool_done.ok } : s));
    return { ...d, strumenti };
  }
  if ("plan" in ev) return { ...d, piano: ev.plan };
  if ("ask" in ev) return { ...d, domanda: ev.ask };
  if ("error" in ev) return { ...d, errore: ev.error };
  if ("done" in ev) return { ...d, runId: ev.done.run_id ?? d.runId, fine: ev.done };
  return d;
}

// ─── le chiamate ────────────────────────────────────────────────────────────
const BASE = "/api/ai/argos/console";

async function leggiJson<T>(percorso: string): Promise<T> {
  const r = await fetch(`${getApiBase()}${percorso}`, { credentials: "include" });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((d as any)?.error || `HTTP ${r.status}`);
  return d as T;
}

export const console_ = {
  stato: () => leggiJson<StatoArgos>("/api/ai/argos/health"),
  budget: () => leggiJson<Budget>(`${BASE}/budget`),
  registro: () => leggiJson<Registro>(`${BASE}/registro`),
  agenti: () => leggiJson<{ totale: number; agenti: SchedaAgente[] }>(`${BASE}/agenti`),
  agente: (chiave: string) => leggiJson<DettaglioAgente>(`${BASE}/agenti/${encodeURIComponent(chiave)}`),
  skill: () => leggiJson<{ totale: number; skill: Skill[] }>(`${BASE}/skill`),
  esecuzioni: (agente?: string, limit = 30) => {
    const q = new URLSearchParams({ limit: String(limit) });
    if (agente) q.set("agente", agente);
    return leggiJson<{ totale: number; esecuzioni: RigaEsecuzione[] }>(`${BASE}/esecuzioni?${q}`);
  },
  esecuzione: (id: number) => leggiJson<DettaglioEsecuzione>(`${BASE}/esecuzioni/${id}`),
};

/**
 * Fa lavorare un agente e chiama `suEvento` per ogni evento dello stream.
 * Ritorna quando lo stream finisce; `segnale` lo interrompe.
 */
export async function esegui(
  chiave: string, compito: string, projectId: string | null,
  suEvento: (ev: EventoStream) => void, segnale?: AbortSignal,
): Promise<void> {
  const r = await fetch(`${getApiBase()}${BASE}/agenti/${encodeURIComponent(chiave)}/esegui`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(projectId ? { compito, projectId } : { compito }),
    signal: segnale,
  });
  if (!r.ok || !r.body) {
    const d = await r.json().catch(() => ({}));
    suEvento({ error: (d as any)?.error || `HTTP ${r.status}` });
    return;
  }
  const lettore = r.body.getReader();
  const dec = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await lettore.read();
    if (done) break;
    buffer += dec.decode(value, { stream: true });
    const { eventi, resto } = spezzaSSE(buffer);
    buffer = resto;
    for (const ev of eventi) suEvento(ev);
  }
  const { eventi } = spezzaSSE(buffer + "\n\n");
  for (const ev of eventi) suEvento(ev);
}

// ─── la biblioteca, le mappe, il crawler ────────────────────────────────────

export interface DocumentoBiblioteca { id: number; title: string; category: string | null; created_at: string; chunks: number }
export interface StatoCostruzione { state: "idle" | "running" | "done" | "error" | string; error?: string | null; [k: string]: unknown }
export interface Biblioteca {
  documenti: DocumentoBiblioteca[];
  categorie: string[];
  caricamenti: Partial<Record<"queued" | "running" | "done" | "error", number>>;
  concetti: StatoCostruzione;
  cervello: StatoCostruzione;
  /** i conteggi veri dal DB (lo stato dei lavori si azzera a ogni riavvio di Argos); null = non disponibili */
  totali?: { concetti: number | null; legami: number | null };
}
export type StatoCaricamento = "queued" | "running" | "done" | "error";
export interface Caricamento {
  id: number; title: string | null; category: string | null; filename: string | null;
  status: StatoCaricamento; stage: string | null; progress: number;
  document_id: number | null; total_chunks: number | null; error: string | null;
  created_at: string; updated_at: string; parser?: string;
}
export interface ChunkDocumento { index: number; tokens: number | null; section: string | null; content: string }
export interface DettaglioDocumento { document: { id: number; title: string; category: string | null }; total_chunks: number; chunks: ChunkDocumento[] }
export interface MappaDati { nodes: NodoGrafo[]; edges: ArcoGrafo[]; categories: string[]; warning?: string }
export interface LegamiDocumento {
  document: { id: number; title: string };
  links: Array<{ src_section: string | null; dst_document_id: number; dst_title: string; dst_section: string | null; score: number }>;
}

/** Le fasi di un caricamento, per la barra: dalla coda agli embedding. */
export const FASI_CARICAMENTO = ["in coda", "conversione", "chunking", "embedding", "scrittura", "completato"] as const;

/** A quale fase della barra corrisponde lo stato di un caricamento. */
export function faseCaricamento(c: Pick<Caricamento, "status" | "stage" | "progress">): number {
  if (c.status === "done") return FASI_CARICAMENTO.length - 1;
  if (c.status === "queued") return 0;
  const s = (c.stage ?? "").toLowerCase();
  if (s.startsWith("conversione")) return 1;
  if (s.startsWith("chunking")) return 2;
  if (s.startsWith("embedding")) return 3;
  if (s.startsWith("scrittura")) return 4;
  if (c.progress >= 98) return 4;
  if (c.progress >= 10) return 3;
  return 1;
}

async function invia<T>(metodo: string, percorso: string, corpo?: unknown): Promise<T> {
  const r = await fetch(`${getApiBase()}${percorso}`, {
    method: metodo, credentials: "include",
    headers: corpo === undefined ? undefined : { "Content-Type": "application/json" },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((d as any)?.error || `HTTP ${r.status}`);
  return d as T;
}

export const biblioteca = {
  stato: () => leggiJson<Biblioteca>(`${BASE}/biblioteca`),
  caricamenti: (limit = 30) => leggiJson<{ caricamenti: Caricamento[] }>(`${BASE}/biblioteca/caricamenti?limit=${limit}`),
  documento: (id: number) => leggiJson<DettaglioDocumento>(`${BASE}/biblioteca/documenti/${id}?limit=60`),
  rinomina: (id: number, title: string) => invia(`PATCH`, `${BASE}/biblioteca/documenti/${id}`, { title }),
  categoria: (id: number, category: string | null) => invia(`PATCH`, `${BASE}/biblioteca/documenti/${id}`, { category }),
  elimina: (id: number) => invia(`DELETE`, `${BASE}/biblioteca/documenti/${id}`),
  riprova: (id: number) => invia(`POST`, `${BASE}/biblioteca/caricamenti/${id}/riprova`),
  riprovaErrori: () => invia(`POST`, `${BASE}/biblioteca/caricamenti/riprova-errori`),
  nuovaCategoria: (name: string) => invia(`POST`, `${BASE}/biblioteca/categorie`, { name }),
  estraiConcetti: () => invia<StatoCostruzione>(`POST`, `${BASE}/biblioteca/concetti`),
  costruisciCervello: () => invia<StatoCostruzione>(`POST`, `${BASE}/biblioteca/cervello`),
};

export const mappe = {
  documenti: () => leggiJson<MappaDati>(`${BASE}/mappa/documenti`),
  concetti: (limit = 120) => leggiJson<MappaDati>(`${BASE}/mappa/concetti?limit=${limit}`),
  documento: (id: number) => leggiJson<LegamiDocumento>(`${BASE}/mappa/documento/${id}`),
};

export interface OpzioniCaricamento { category?: string; title?: string; parser?: "auto" | "mathpix" | "text" | "markdown"; page_from?: number; page_to?: number; replace?: boolean }

/**
 * Carica un file nella biblioteca, con l'avanzamento del trasferimento
 * (fetch non lo dà: si usa XMLHttpRequest). Ritorna l'id del caricamento in coda.
 */
export function carica(file: File, o: OpzioniCaricamento, suAvanzamento?: (frazione: number) => void): Promise<{ job_id: number; status: string }> {
  return new Promise((risolvi, rifiuta) => {
    const form = new FormData();
    form.append("file", file, file.name);
    if (o.category) form.append("category", o.category);
    if (o.title) form.append("title", o.title);
    form.append("parser", o.parser ?? "auto");
    if (o.page_from) form.append("page_from", String(o.page_from));
    if (o.page_to) form.append("page_to", String(o.page_to));
    if (o.replace) form.append("replace", "true");
    const x = new XMLHttpRequest();
    x.open("POST", `${getApiBase()}${BASE}/biblioteca/carica`);
    x.withCredentials = true;
    x.upload.onprogress = e => { if (e.lengthComputable) suAvanzamento?.(e.loaded / e.total); };
    x.onload = () => {
      let d: any = {};
      try { d = JSON.parse(x.responseText || "{}"); } catch { /* risposta non JSON */ }
      if (x.status >= 200 && x.status < 300) risolvi(d);
      else rifiuta(new Error(d?.error || `HTTP ${x.status}`));
    };
    x.onerror = () => rifiuta(new Error("Collegamento interrotto durante il caricamento"));
    x.send(form);
  });
}

/** Gli eventi dello stream di una domanda col ragionamento in vista. */
export type EventoDomanda =
  | { trace: Record<string, any> }
  | { t: string }
  | { reset: true }
  | { tool: { name: string; args?: Record<string, unknown>; lato?: "server" } }
  | { note: string }
  | { error: string }
  | { done: true; sources?: unknown[]; tokens?: number };

/** Fa una domanda ad Argos col ragionamento in vista (documenti, dati, web). */
export async function chiedi(domanda: string, deep: boolean, suEvento: (ev: EventoDomanda) => void, segnale?: AbortSignal): Promise<void> {
  const r = await fetch(`${getApiBase()}${BASE}/chiedi`, {
    method: "POST", credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ domanda, deep }),
    signal: segnale,
  });
  if (!r.ok || !r.body) {
    const d = await r.json().catch(() => ({}));
    suEvento({ error: (d as any)?.error || `HTTP ${r.status}` });
    return;
  }
  const lettore = r.body.getReader();
  const dec = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await lettore.read();
    if (done) break;
    buffer += dec.decode(value, { stream: true });
    const { eventi, resto } = spezzaSSE(buffer);
    buffer = resto;
    for (const ev of eventi) suEvento(ev as unknown as EventoDomanda);
  }
  const { eventi } = spezzaSSE(buffer + "\n\n");
  for (const ev of eventi) suEvento(ev as unknown as EventoDomanda);
}

// ─── le conversazioni ───────────────────────────────────────────────────────
export type ModoConversazione = "risposta" | "analisi" | "agente";
export interface Conversazione {
  id: string; modo: ModoConversazione; agente: string | null; progetto: string | null;
  titolo: string; turni: number; tokens: number; compattazioni: number;
  archiviata: boolean; occupata: boolean; creata: string | null; aggiornata: string | null;
}
export interface NuovaConversazione { modo: ModoConversazione; agente?: string | null; progetto?: string | null; titolo?: string }

/** I titoli delle conversazioni nate dal vecchio pannello di Planning Studio (routes/argos-console.ts). */
export const TITOLI_PANNELLO = { agente: "Dal pannello · Pianificatore", chat: "Dal pannello · Chat" } as const;

export const NOMI_MODO: Record<ModoConversazione, string> = { risposta: "Risposta", analisi: "Analisi", agente: "Agente" };
export const SPIEGA_MODO: Record<ModoConversazione, string> = {
  risposta: "Documenti, dati di Cerbero e web, in fretta",
  analisi: "Le stesse fonti, più a fondo: più lenta e più costosa",
  agente: "Un agente della squadra che lavora per te",
};

export const conversazioni = {
  elenco: (progetto?: string | null, archiviate = false) => {
    const q = new URLSearchParams();
    if (progetto) q.set("progetto", progetto);
    if (archiviate) q.set("archiviate", "1");
    return leggiJson<{ conversazioni: Conversazione[] }>(`${BASE}/conversazioni?${q}`);
  },
  una: (id: string) => leggiJson<{ conversazione: Conversazione }>(`${BASE}/conversazioni/${id}`),
  crea: (c: NuovaConversazione) => invia<{ conversazione: Conversazione }>("POST", `${BASE}/conversazioni`, c),
  modifica: (id: string, m: { titolo?: string; archiviata?: boolean }) =>
    invia<{ conversazione: Conversazione }>("PATCH", `${BASE}/conversazioni/${id}`, m),
  elimina: (id: string) => invia("DELETE", `${BASE}/conversazioni/${id}`),
  pannello: (projectId: string) => leggiJson<{ chat: number; agente: number }>(`${BASE}/conversazioni/pannello?projectId=${projectId}`),
  importaPannello: (projectId: string, thread: "chat" | "agente") =>
    invia<{ conversazione: Conversazione }>("POST", `${BASE}/conversazioni/importa-pannello`, { projectId, thread }),
};

