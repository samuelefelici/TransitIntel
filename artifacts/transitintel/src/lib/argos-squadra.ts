/**
 * La squadra di Argos: gli agenti che il regista fa lavorare insieme in un
 * turno (argos/api/regia.py). Gli avvisi arrivano in diretta, uno per volta;
 * qui si fondono per incarico e si leggono, con prudenza, dalla storia.
 */
export type StatoMembro = "in_attesa" | "al_lavoro" | "fatto" | "errore" | "tempo_scaduto";

export interface MembroSquadra {
  /** unico nel turno (delega.incarico): lo stesso agente può avere due compiti */
  id: string;
  agente: string;
  nome: string;
  stato: StatoMembro;
  run_id?: number | null;
  strumenti?: number;
  ultimo?: string | null;
  ms?: number | null;
  errore?: string | null;
  /** gli id dei lavori che aspetta (il lavoro in catena: ne riceve i rapporti) */
  dopo?: string[];
}

const STATI: readonly StatoMembro[] = ["in_attesa", "al_lavoro", "fatto", "errore", "tempo_scaduto"];
const MAX_MEMBRI = 12;

/** Un avviso dal server (o una riga della storia), controllato campo per campo; altro → null. */
export function membroDa(v: unknown): MembroSquadra | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const id = typeof o.id === "string" && o.id ? o.id.slice(0, 20) : null;
  const agente = typeof o.agente === "string" && o.agente ? o.agente.slice(0, 60) : null;
  const stato = STATI.find(s => s === o.stato);
  if (!id || !agente || !stato) return null;
  const numero = (x: unknown) => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : null);
  return {
    id, agente, stato,
    nome: typeof o.nome === "string" && o.nome ? o.nome.slice(0, 60) : agente,
    run_id: numero(o.run_id),
    strumenti: numero(o.strumenti) ?? 0,
    ultimo: typeof o.ultimo === "string" ? o.ultimo.slice(0, 80) : null,
    ms: numero(o.ms),
    errore: typeof o.errore === "string" ? o.errore.slice(0, 300) : null,
    dopo: Array.isArray(o.dopo) ? o.dopo.filter((d): d is string => typeof d === "string").slice(0, 6).map(d => d.slice(0, 24)) : [],
  };
}

/** Chi aspetta: i nomi dei colleghi (dalla squadra dello stesso messaggio), altrimenti gli id. */
export function nomiAttesi(m: MembroSquadra, squadra: MembroSquadra[]): string[] {
  return (m.dopo ?? []).map(d => squadra.find(x => x.id === d)?.nome ?? d);
}

/** L'avviso nuovo prende il posto di quello dello stesso incarico, o si aggiunge in coda. */
export function unisciSquadra(lista: MembroSquadra[] | undefined, nuovo: MembroSquadra): MembroSquadra[] {
  const prima = lista ?? [];
  const i = prima.findIndex(m => m.id === nuovo.id);
  if (i < 0) return prima.length >= MAX_MEMBRI ? prima : [...prima, nuovo];
  const copia = prima.slice();
  copia[i] = { ...prima[i]!, ...nuovo };
  return copia;
}

/** La squadra salvata nei metadati di un messaggio (la storia della conversazione). */
export function squadraDa(v: unknown): MembroSquadra[] {
  if (!Array.isArray(v)) return [];
  return v.slice(0, MAX_MEMBRI).map(membroDa).filter((m): m is MembroSquadra => m !== null);
}
