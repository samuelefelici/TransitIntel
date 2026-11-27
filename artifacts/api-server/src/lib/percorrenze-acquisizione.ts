/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ACQUISIRE I TEMPI REALI NEL PROGRAMMA — le regole
 * ───────────────────────────────────────────────────────────────────────────
 * Planning Studio prende i tempi di percorrenza osservati (il calcolo unico,
 * tratte-osservate) e li mette nelle corse del progetto: una corsa, le corse
 * di un percorso, o le corse di una o più linee.
 *
 *   · La PARTENZA dal capolinea non si tocca: cambiano i passaggi successivi.
 *   · Ogni tratto prende il tempo dell'ORA in cui la corsa lo percorre (con i
 *     tempi nuovi: una corsa che slitta nell'ora di punta ne prende i tempi),
 *     poi della sua FASCIA oraria, poi della giornata; se il tipo di giorno
 *     non ha dati, dai feriali quando lo si chiede, dichiarato; se niente,
 *     resta il tempo programmato.
 *   · Il reale fra due arrivi contiene la sosta normale alla fermata (fino a
 *     un minuto): dove l'orario ha una sosta programmata, quella resta
 *     esplicita e non si conta due volte.
 *   · Prima e dopo, il DELTA FINALE di ogni corsa (la sosta al capolinea fino
 *     alla corsa dopo della linea) e il suo giudizio: è lì che si vede se i
 *     tempi nuovi reggono il cadenzamento.
 *
 * Funzioni pure: la lettura e la scrittura stanno in
 * percorrenze-acquisizione-db.ts.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { Osservato, esitiCorse, hhmm, type CorsaProgetto, type FermataCorsa, type EsitoCorsa } from "./percorrenze-reali";
import { SOSTA_NORMALE_S } from "./tratte-osservate";

/** Quale numero del reale si mette nell'orario. */
export type Valore = "mediana" | "p85";
export type FonteNuovoTratto = "ora" | "fascia" | "giornata" | "feriale" | "programmato";
/** Un tratto non dura mai meno di così, qualunque cosa dicano i dati. */
export const TRATTO_MINIMO_S = 10;

export interface Ricalcolo {
  tripId: string;
  /** le fermate con gli orari nuovi (stesso ordine, stesse fermate) */
  fermate: FermataCorsa[];
  fonti: Record<FonteNuovoTratto, number>;
  tratti: number;
  /** perché la corsa non si ricalcola (orari mancanti, una fermata sola) */
  saltata: string | null;
  /** almeno un orario cambia */
  cambia: boolean;
}

const vuote = (): Record<FonteNuovoTratto, number> => ({ ora: 0, fascia: 0, giornata: 0, feriale: 0, programmato: 0 });

/**
 * Gli orari nuovi di una corsa dai tempi osservati.
 * `daRipiego` = le coppie `${da}>${a}` che vengono dai feriali (Osservato.assorbi).
 */
export function ricalcolaCorsa(
  c: CorsaProgetto, oss: Osservato,
  opt: { valore: Valore; daRipiego?: Set<string> },
): Ricalcolo {
  const fs = c.fermate;
  const fonti = vuote();
  const fermo = (saltata: string): Ricalcolo => ({ tripId: c.tripId, fermate: fs, fonti, tratti: 0, saltata, cambia: false });
  if (fs.length < 2) return fermo("una fermata sola");
  const arr = fs.map(f => f.arrivoS ?? f.partenzaS);
  const dep = fs.map(f => f.partenzaS ?? f.arrivoS);
  if (arr.some(x => x == null) || dep.some(x => x == null)) return fermo("orari mancanti a qualche fermata");

  const nuove: FermataCorsa[] = fs.map(f => ({ ...f }));
  nuove[0].arrivoS = arr[0]!;
  nuove[0].partenzaS = dep[0]!;
  let partenza = dep[0]!;
  for (let i = 0; i + 1 < fs.length; i++) {
    const programmato = Math.max(0, arr[i + 1]! - dep[i]!);
    // la sosta programmata alla fermata di partenza del tratto (non al capolinea)
    const sosta = i === 0 ? 0 : Math.max(0, dep[i]! - arr[i]!);
    const da = fs[i].gtfsId, a = fs[i + 1].gtfsId;
    // l'ora del GTFS oltre le 24 (25:10) è l'1 di notte della giornata dopo
    const s = oss.per(da, a, Math.floor(partenza / 3600) % 24);
    let viaggio = programmato;
    if (s) {
      const reale = opt.valore === "p85" ? s.p85S : s.medianaS;
      viaggio = Math.max(TRATTO_MINIMO_S, Math.round(reale - Math.min(sosta, SOSTA_NORMALE_S)));
      fonti[opt.daRipiego?.has(`${da}>${a}`) ? "feriale" : s.fonte]++;
    } else fonti.programmato++;
    const arrivo = partenza + viaggio;
    const sostaDopo = Math.max(0, dep[i + 1]! - arr[i + 1]!);
    nuove[i + 1].arrivoS = arrivo;
    nuove[i + 1].partenzaS = arrivo + sostaDopo;
    partenza = arrivo + sostaDopo;
  }
  const cambia = nuove.some((f, i) => f.arrivoS !== arr[i] || f.partenzaS !== dep[i]);
  return { tripId: c.tripId, fermate: nuove, fonti, tratti: fs.length - 1, saltata: null, cambia };
}

export interface EsitoBreve {
  sostaMin: number | null;
  prossimaPartenza: string | null;
  giudizio: EsitoCorsa["giudizio"];
  ritardoP85Min: number | null;
}

const breve = (e: EsitoCorsa | undefined): EsitoBreve | null => e ? {
  sostaMin: e.deltaFinaleMin, prossimaPartenza: e.prossimaPartenza, giudizio: e.giudizio, ritardoP85Min: e.ritardoP85Min,
} : null;

/**
 * Il delta finale prima e dopo: si calcola su TUTTE le corse delle linee
 * coinvolte (la corsa dopo può non essere fra quelle ricalcolate), con le
 * ricalcolate al posto delle originali.
 */
export function confronto(
  contesto: CorsaProgetto[], ricalcoli: Map<string, Ricalcolo>, oss: Osservato,
): Map<string, { prima: EsitoBreve | null; dopo: EsitoBreve | null }> {
  const prima = new Map(esitiCorse(contesto, oss).map(e => [e.tripId, e]));
  const nuovo = contesto.map(c => {
    const r = ricalcoli.get(c.tripId);
    return r && !r.saltata ? { ...c, fermate: r.fermate } : c;
  });
  const dopo = new Map(esitiCorse(nuovo, oss).map(e => [e.tripId, e]));
  const out = new Map<string, { prima: EsitoBreve | null; dopo: EsitoBreve | null }>();
  for (const id of ricalcoli.keys()) out.set(id, { prima: breve(prima.get(id)), dopo: breve(dopo.get(id)) });
  return out;
}

/** Orario HH:MM:SS anche oltre le 24 (25:10:00 = 01:10 della giornata dopo). */
export function hms(s: number): string {
  const t = Math.max(0, Math.round(s));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), x = t % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(x).padStart(2, "0")}`;
}

/** Arrivo all'ultima fermata, in minuti di differenza (una cifra decimale). */
export function variazioneArrivoMin(prima: FermataCorsa[], dopo: FermataCorsa[]): number | null {
  const a = prima[prima.length - 1], b = dopo[dopo.length - 1];
  const x = a?.arrivoS ?? a?.partenzaS, y = b?.arrivoS ?? b?.partenzaS;
  return x == null || y == null ? null : Math.round((y - x) / 6) / 10;
}

export { hhmm };
