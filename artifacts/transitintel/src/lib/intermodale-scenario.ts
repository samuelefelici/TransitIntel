/**
 * Lo scenario alternativo dell'analisi intermodale (tappa 7.28): una modifica
 * per corsa.
 *
 * Prima lo scenario sommava gli spostamenti di tutte le modifiche proposte per
 * la stessa corsa. Con i dati veri una corsa ne riceve fino a 22 (un treno,
 * più linee di autobus vicine, in arrivo e in partenza), e la somma la
 * spostava di decine di minuti.
 *
 * Ora se ne applica una sola, scelta così:
 * 1. la più grave: critica, poi avviso, poi informazione;
 * 2. a parità, quella di un treno, poi aereo, nave, autostazione, altri autobus;
 * 3. a parità, lo spostamento più piccolo;
 * 4. a parità, la prima dell'elenco.
 */

export type GravitaModifica = "critical" | "warning" | "info";
export type ClasseNodo = "rail" | "air" | "port" | "bus_terminal" | "bus_other";

export interface ModificaProposta {
  tripId: string;
  changeType: "shift_departure" | "shift_arrival" | "add_trip";
  shiftMin: number;
  severity: GravitaModifica;
  priorityClass?: ClasseNodo;
}

const ORDINE_GRAVITA: Record<GravitaModifica, number> = { critical: 0, warning: 1, info: 2 };
const ORDINE_NODO: Record<ClasseNodo, number> = { rail: 0, air: 1, port: 2, bus_terminal: 3, bus_other: 4 };

function viene_prima(a: ModificaProposta, b: ModificaProposta): boolean {
  const g = ORDINE_GRAVITA[a.severity] - ORDINE_GRAVITA[b.severity];
  if (g !== 0) return g < 0;
  // senza classe (risposta di una versione di prima): come gli altri autobus
  const n = ORDINE_NODO[a.priorityClass ?? "bus_other"] - ORDINE_NODO[b.priorityClass ?? "bus_other"];
  if (n !== 0) return n < 0;
  return Math.abs(a.shiftMin) < Math.abs(b.shiftMin);
}

/** La modifica da applicare per ogni corsa; le aggiunte di corse non si applicano. */
export function modificaPerCorsa<T extends ModificaProposta>(modifiche: readonly T[]): Map<string, T> {
  const scelte = new Map<string, T>();
  for (const m of modifiche) {
    if (m.changeType === "add_trip" || !m.shiftMin) continue;
    const prima = scelte.get(m.tripId);
    if (!prima || viene_prima(m, prima)) scelte.set(m.tripId, m);
  }
  return scelte;
}
