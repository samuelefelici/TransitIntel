/**
 * La scheda «Proposte»: le proposte di tutti i piani degli agenti, con lo
 * stato di avanzamento, per decidere da quale partire. Qui le parti pure:
 * nomi, ordine, avanzamento, e il piano di una proposta sola da passare al
 * Pianificatore («Parti da questa»), nella chat da cui la proposta è nata.
 */
import type { PianoArgos } from "./argos-applica";
import type { PropostaAgente, StatoProposta } from "./argos-console";

export const NOME_STATO: Record<StatoProposta, string> = {
  open: "da fare", accepted: "in corso", applied: "fatta", rejected: "scartata",
};

export const NOME_PRIORITA: Record<string, string> = { critica: "critica", alta: "alta", media: "media", bassa: "bassa" };
const ORDINE_PRIORITA: Record<string, number> = { critica: 0, alta: 1, media: 2, bassa: 3 };
export const rangoPriorita = (p: string) => ORDINE_PRIORITA[p] ?? 4;

/** Quante fatte sul totale da fare (le scartate non contano). */
export function avanzamento(c: Partial<Record<StatoProposta, number>>): { fatte: number; totale: number; percento: number } {
  const fatte = c.applied ?? 0;
  const totale = fatte + (c.open ?? 0) + (c.accepted ?? 0);
  return { fatte, totale, percento: totale ? Math.round((fatte / totale) * 100) : 0 };
}

/** Il nome dell'agente che l'ha proposta. */
export function nomeAgente(chiave: string | null): string {
  if (!chiave) return "Pianificatore";
  if (chiave === "regista") return "Argos";
  return chiave.split("-").map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(" ");
}

/** Le azioni possibili da uno stato: Parti da questa solo se c'è un progetto e non è fatta né scartata. */
export function azioni(p: Pick<PropostaAgente, "status" | "project_id">): Array<"parti" | "fatta" | "scarta" | "da_fare" | "riapri"> {
  switch (p.status) {
    case "open": return [...(p.project_id ? ["parti" as const] : []), "fatta", "scarta"];
    case "accepted": return [...(p.project_id ? ["parti" as const] : []), "fatta", "da_fare", "scarta"];
    default: return ["riapri"];
  }
}

/** Che cosa fa la scheda Conversazione quando arriva dalla scheda Proposte: apre la chat d'origine,
 *  oppure applica una proposta (nella sua chat, se è dell'utente; se no, in una chat nuova col
 *  Pianificatore sul progetto). */
export type Avvio =
  | { tipo: "apri"; conversazione: string }
  | { tipo: "applica"; piano: PianoArgos; progetto: string; chat: { id: string; agente: string | null } | null };

export function avvioDa(p: PropostaAgente): Avvio {
  return { tipo: "applica", piano: pianoDaProposta(p), progetto: p.project_id,
           chat: p.chat ? { id: p.chat.id, agente: p.chat.agente } : null };
}

/** Il piano di una proposta sola, da passare al Pianificatore. */
export function pianoDaProposta(p: PropostaAgente): PianoArgos {
  return {
    sintesi: p.title,
    interventi: [{
      id: p.id, titolo: p.title, dettaglio: p.detail || "", linea: p.line, giornoTipo: p.day_type,
      motivo: p.rationale || null, effetto: p.impact || null,
    }],
  };
}
