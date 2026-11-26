/**
 * «Applica col Pianificatore»: il piano di Argos (il regista, o un agente che
 * propone soltanto) passa al Pianificatore, l'unico che scrive sul progetto,
 * con la conferma del turno («accetta modifiche») e il suo annullo. Qui il
 * piano si legge con prudenza (arriva dal modello) e si scrive il messaggio
 * che il Pianificatore riceve: gli interventi, uno per uno, e la verifica con
 * un giro dell'ottimizzatore confrontato con quello di partenza.
 */
export interface InterventoPiano {
  /** l'id della proposta salvata (scheda «Proposte»), se c'è: la si segna fatta quando si applica */
  id: number | null;
  titolo: string;
  dettaglio: string;
  linea: string | null;
  giornoTipo: string | null;
  motivo: string | null;
  effetto: string | null;
}

export interface PianoArgos {
  sintesi: string;
  interventi: InterventoPiano[];
}

const MAX_INTERVENTI = 12;
const testo = (v: unknown, max: number): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
const forse = (v: unknown, max: number): string | null => testo(v, max) || null;

/** Il piano emesso da un agente (emit_transit_plan), letto campo per campo; senza interventi → null. */
export function pianoDa(v: unknown): PianoArgos | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const grezzi = Array.isArray(o.proposals) ? o.proposals : [];
  const interventi = grezzi.slice(0, MAX_INTERVENTI).flatMap((p): InterventoPiano[] => {
    if (!p || typeof p !== "object") return [];
    const q = p as Record<string, unknown>;
    const titolo = testo(q.title, 200);
    if (!titolo) return [];
    return [{
      id: typeof q.id === "number" && Number.isInteger(q.id) && q.id > 0 ? q.id : null,
      titolo, dettaglio: testo(q.detail, 1200), linea: forse(q.line, 40), giornoTipo: forse(q.day_type, 40),
      motivo: forse(q.rationale, 600), effetto: forse(q.impact, 300),
    }];
  });
  if (!interventi.length) return null;
  return { sintesi: testo(o.summary, 600), interventi };
}

/** Gli id delle proposte salvate da cui parte il lavoro (si segnano in corso, poi fatte). */
export function origineDi(p: PianoArgos): number[] {
  return p.interventi.map(x => x.id).filter((id): id is number => id !== null);
}

/** Gli interventi ancora da applicare: senza quelli già fatti o scartati (lo stato viene dalla
 *  scheda «Proposte»; un intervento senza proposta salvata resta). */
export function ancoraDaFare(p: PianoArgos, stati: ReadonlyMap<number, string>): PianoArgos {
  return { ...p, interventi: p.interventi.filter(x => x.id === null || !FINITI.has(stati.get(x.id) ?? "")) };
}
const FINITI = new Set(["applied", "rejected"]);

/** Il turno che applica un piano DENTRO una chat (niente chat nuove): parte da solo, in
 *  «accetta modifiche». Nella chat di un altro agente il Pianificatore entra come ospite. */
export interface DaInviare { chiave: string; testo: string; ospite: boolean; origine: number[] }

export function applicaInChat(p: PianoArgos, agenteDellaChat: string | null, chiave: string): DaInviare {
  return { chiave, testo: promptApplica(p), ospite: agenteDellaChat !== "pianificatore", origine: origineDi(p) };
}

/** Il titolo della conversazione col Pianificatore. */
export function titoloApplica(p: PianoArgos): string {
  return `Applica: ${p.sintesi || p.interventi[0]!.titolo}`.slice(0, 110);
}

/** Il primo messaggio al Pianificatore, in modalità «accetta modifiche». */
export function promptApplica(p: PianoArgos): string {
  const righe = p.interventi.map((x, i) => [
    `${i + 1}. ${x.titolo}`,
    x.linea ? ` — linea ${x.linea}` : "",
    x.giornoTipo ? `, giorno-tipo ${x.giornoTipo}` : "",
    x.dettaglio ? `\n   Intervento: ${x.dettaglio}` : "",
    x.effetto ? `\n   Effetto atteso: ${x.effetto}` : "",
    x.motivo ? `\n   Perché: ${x.motivo}` : "",
  ].join(""));
  return [
    "Applica ORA il piano che Argos ha preparato con la squadra e che ho approvato" + (p.sintesi ? `: ${p.sintesi}` : "."),
    "",
    righe.join("\n"),
    "",
    "Per ogni intervento usa i tool di scrittura (per gli spostamenti di corse ti_shift_trip), rileggi dopo ogni scrittura "
      + "e riporta i numeri veri. Se uno stato è GIÀ sul progetto non riapplicarlo: dillo e passa al successivo.",
    "Nel resoconto, per ogni corsa spostata, scrivi come tornare indietro (stessa corsa, minuti opposti): l'annullo del "
      + "turno toglie le corse create, non riporta gli spostamenti.",
    "Poi la verifica: se c'è un giro dell'ottimizzatore di riferimento (il più recente, ti_vcsp_status senza jobId), "
      + "lanciane uno nuovo con gli stessi parametri (ti_vcsp_run), aspetta l'esito e confrontali con ti_vcsp_compare: "
      + "di' se vetture e turni sono scesi come atteso.",
  ].join("\n");
}
