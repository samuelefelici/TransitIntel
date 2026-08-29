/**
 * Percorrenze «Tempi a mano» — la matematica, senza React.
 *
 * Due operazioni sugli orari di una corsa (sequenza di transiti arr/dep in
 * HH:MM:SS, ore >24 ammesse per il dopo-mezzanotte):
 *
 *  · CASCATA A VALLE — l'operatore corregge UN tempo (arrivo o partenza a una
 *    fermata) e tutti i tempi successivi slittano dello stesso delta: sta di
 *    fatto correggendo la percorrenza della tratta che precede quel punto.
 *    I tempi PRIMA del punto editato non si toccano mai. Il valore nuovo non
 *    può scavalcare all'indietro il tempo immediatamente precedente.
 *
 *  · PROFILO DI TRATTA — da una corsa si estraggono i minuti fermata→fermata
 *    (legProfile) e si riapplicano a un'altra corsa (applyLegProfile) tenendo
 *    FERMA la partenza e CONSERVANDO le soste alle fermate: è il cuore della
 *    colonna verticale «tempi di tratta per percorso» della zona Percorrenze.
 *
 * Modulo puro perché la matematica va potuta verificare a tavolino (test Node):
 * la resa sta in components/planning-studio/TripTransitsEditor.tsx e nella
 * modalità C di PercorrenzePage.
 */
import { ttToSec, ttSecToHms } from "@/lib/traffic-profile";

export interface TransitoLike {
  arrivalTime: string;   // HH:MM:SS (anche >24)
  departureTime: string; // HH:MM:SS
}

const fmtHm = (sec: number) => ttSecToHms(sec).slice(0, 5);

/** Sequenza piatta [arr0, dep0, arr1, dep1, …] in secondi. */
function flatten(sts: TransitoLike[]): number[] {
  const out: number[] = [];
  for (const s of sts) { out.push(ttToSec(s.arrivalTime), ttToSec(s.departureTime)); }
  return out;
}

function rebuild<T extends TransitoLike>(sts: T[], flat: number[]): T[] {
  return sts.map((s, i) => ({
    ...s,
    arrivalTime: ttSecToHms(flat[i * 2]),
    departureTime: ttSecToHms(flat[i * 2 + 1]),
  }));
}

/**
 * Edit con cascata a valle: il tempo alla posizione (idx, field) diventa
 * `newHms` e TUTTI i tempi successivi nella sequenza piatta slittano dello
 * stesso delta (editando l'arrivo slitta anche la partenza della stessa
 * fermata; editando la partenza della prima fermata trasla la corsa intera
 * tranne il suo arrivo iniziale; editando l'arrivo della prima fermata trasla
 * TUTTO). Delta negativo ammesso finché non si scavalca il tempo precedente.
 */
export function cascadeEdit<T extends TransitoLike>(
  sts: T[], idx: number, field: "arr" | "dep", newHms: string,
): { ok: true; rows: T[]; deltaSec: number } | { ok: false; error: string } {
  if (idx < 0 || idx >= sts.length) return { ok: false, error: "Transito inesistente" };
  const flat = flatten(sts);
  const pos = idx * 2 + (field === "dep" ? 1 : 0);
  const newSec = ttToSec(newHms.split(":").length === 2 ? `${newHms}:00` : newHms);
  const delta = newSec - flat[pos];
  if (delta === 0) return { ok: true, rows: sts, deltaSec: 0 };
  if (pos > 0 && newSec < flat[pos - 1]) {
    const prevName = pos % 2 === 1 ? "l'arrivo alla stessa fermata" : "la partenza dalla fermata precedente";
    return { ok: false, error: `L'orario non può precedere ${prevName} (${fmtHm(flat[pos - 1])})` };
  }
  if (newSec < 0) return { ok: false, error: "Orario negativo" };
  const next = flat.slice();
  for (let p = pos; p < next.length; p++) next[p] += delta;
  return { ok: true, rows: rebuild(sts, next), deltaSec: delta };
}

/** Profilo di una corsa: tratte (dep fermata i → arr fermata i+1) e soste. */
export function legProfile(sts: TransitoLike[]): { legSec: number[]; dwellSec: number[] } {
  const legSec: number[] = [];
  const dwellSec = sts.map(s => ttToSec(s.departureTime) - ttToSec(s.arrivalTime));
  for (let i = 0; i < sts.length - 1; i++) {
    legSec.push(ttToSec(sts[i + 1].arrivalTime) - ttToSec(sts[i].departureTime));
  }
  return { legSec, dwellSec };
}

/**
 * Riapplica un profilo di tratte a una corsa: la PARTENZA resta ferma
 * (arrivo e partenza alla prima fermata invariati), le soste alle fermate
 * restano quelle della corsa, i tempi a valle si ricostruiscono con le
 * nuove tratte. `legSec.length` deve essere `sts.length - 1`.
 */
export function applyLegProfile<T extends TransitoLike>(
  sts: T[], legSec: number[],
): { ok: true; rows: T[] } | { ok: false; error: string } {
  if (sts.length < 2) return { ok: false, error: "Servono almeno 2 fermate" };
  if (legSec.length !== sts.length - 1) {
    return { ok: false, error: `Profilo di ${legSec.length} tratte su una corsa da ${sts.length - 1}` };
  }
  if (legSec.some(s => !Number.isFinite(s) || s < 0)) {
    return { ok: false, error: "Tempi di tratta negativi o non validi" };
  }
  const { dwellSec } = legProfile(sts);
  const flat = flatten(sts);
  const next = flat.slice(0, 2); // prima fermata invariata (arr0, dep0)
  for (let i = 1; i < sts.length; i++) {
    const arr = next[(i - 1) * 2 + 1] + legSec[i - 1];
    next.push(arr, arr + Math.max(0, dwellSec[i]));
  }
  return { ok: true, rows: rebuild(sts, next) };
}
