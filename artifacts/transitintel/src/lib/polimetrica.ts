/**
 * I conti della polimetrica di un percorso (tappa 6.33).
 *
 * Un percorso è diviso in tratte di fermate consecutive; ogni tratta è un
 * nodo tariffario e ha un punto tariffario: una sua fermata, quella scelta
 * da chi compila o, se non ne ha scelta nessuna, la prima.
 *
 * La tariffa fra due nodi viene dai chilometri fra i loro punti tariffari:
 * la fascia di quella distanza, letta dalle fasce chilometriche
 * dell'azienda (lib/fasce-km.ts). Così lavora la bigliettazione: il km di un
 * punto meno il km dell'altro, e la fascia di quel numero.
 *
 * Prima la pagina contava le tratte da 6 km attraversate partendo dal
 * capolinea: due fermate a 2 km l'una dall'altra, a cavallo di un multiplo
 * di 6, pagavano due tratte invece di una; e oltre i 42 km, dove le fasce
 * dell'azienda sono più lunghe, il conto saliva ancora.
 *
 * Solo conti, niente rete.
 */
import type { FasciaKm } from "./fasce-km";

/** I chilometri arrotondati al metro: una differenza di progressivi non scavalca una fascia per un resto di virgola mobile. */
const alMetro = (km: number) => Math.round(km * 1000) / 1000;

/**
 * Il numero della fascia di una distanza: quella in cui la distanza è più di
 * «da» e al più «a» (6 km esatti stanno nella fascia che finisce a 6). A zero
 * chilometri vale la prima, oltre l'ultima vale l'ultima. `null` se l'azienda
 * non ha scritto le fasce: nessun numero inventato.
 * Le fasce arrivano in ordine, ognuna da dove finisce quella prima.
 */
export function fasciaDeiKm(distKm: number, fasce: readonly FasciaKm[]): number | null {
  if (fasce.length === 0 || !Number.isFinite(distKm)) return null;
  const d = Math.max(0, alMetro(distKm));
  return (fasce.find((f) => d <= f.kmTo) ?? fasce[fasce.length - 1]!).fascia;
}

/**
 * I confini delle tratte fatte dal programma: una tratta nuova comincia alla
 * prima fermata che, dal capolinea, sta in un'altra fascia. Ogni fermata di
 * una tratta sta quindi nella stessa fascia dal capolinea. Senza fasce il
 * percorso resta una tratta sola.
 */
export function confiniDalleFasce(fermate: readonly { km: number }[], fasce: readonly FasciaKm[]): number[] {
  const confini: number[] = [];
  for (let i = 1; i < fermate.length; i++) {
    if (fasciaDeiKm(fermate[i]!.km, fasce) !== fasciaDeiKm(fermate[i - 1]!.km, fasce)) confini.push(i);
  }
  return confini;
}

/** I confini come servono ai conti: dentro il percorso, senza doppioni, in ordine. */
const confiniPuliti = (nFermate: number, confini: readonly number[]): number[] =>
  [...new Set(confini)].filter((i) => Number.isInteger(i) && i > 0 && i < nFermate).sort((a, b) => a - b);

/** La tratta (da 0) di ogni fermata: un confine è la prima fermata di una tratta nuova. */
export function trattaDelleFermate(nFermate: number, confini: readonly number[]): number[] {
  const puliti = confiniPuliti(nFermate, confini);
  const tratta: number[] = [];
  let t = 0, prossimo = 0;
  for (let i = 0; i < nFermate; i++) {
    if (prossimo < puliti.length && i === puliti[prossimo]) { t++; prossimo++; }
    tratta.push(t);
  }
  return tratta;
}

/**
 * Il punto tariffario di ogni tratta, come indice di fermata: la fermata
 * scelta dentro la tratta (la prima che si incontra, se dopo aver spostato un
 * confine ce ne sono due), altrimenti la prima fermata della tratta.
 */
export function puntiDelleTratte(trattaDi: readonly number[], scelte: readonly number[]): number[] {
  const punti: number[] = [];
  trattaDi.forEach((t, i) => { if (punti[t] === undefined) punti[t] = i; });
  const conScelta = new Set<number>();
  for (const i of [...new Set(scelte)].sort((a, b) => a - b)) {
    const t = trattaDi[i];
    if (t === undefined || conScelta.has(t)) continue;
    conScelta.add(t);
    punti[t] = i;
  }
  return punti;
}

/**
 * Le scelte dopo un clic su una fermata: diventa il punto tariffario della
 * sua tratta al posto di quello di prima; un clic sul punto già scelto lo
 * toglie, e la tratta torna alla sua prima fermata.
 */
export function conPuntoScelto(scelte: readonly number[], fermata: number, trattaDi: readonly number[]): number[] {
  if (trattaDi[fermata] === undefined) return [...scelte];
  if (scelte.includes(fermata)) return scelte.filter((i) => i !== fermata);
  return [...scelte.filter((i) => trattaDi[i] !== trattaDi[fermata]), fermata].sort((a, b) => a - b);
}

/** Una fermata di una polimetrica salvata: il suo km dal capolinea, la sua tratta e, se è stata scelta, il segno del punto tariffario. */
export interface FermataSalvata { km: number; tratta: number; punto?: boolean }

/**
 * Di ogni tratta di una polimetrica salvata: l'indice della sua prima
 * fermata e quello del suo punto tariffario. `null` per una tratta senza
 * fermate (un salvataggio rovinato): chi stampa lo dice invece di inventare.
 */
export function nodiSalvati(fermate: readonly FermataSalvata[], nTratte: number): ({ prima: number; punto: number } | null)[] {
  const trattaDi = fermate.map((f) => f.tratta);
  const punti = puntiDelleTratte(trattaDi, fermate.flatMap((f, i) => (f.punto === true ? [i] : [])));
  const prime: number[] = [];
  trattaDi.forEach((t, i) => { if (prime[t] === undefined) prime[t] = i; });
  return Array.from({ length: nTratte }, (_, t) => (prime[t] === undefined ? null : { prima: prime[t]!, punto: punti[t]! }));
}

/**
 * La matrice a gradoni: per il nodo r e ogni nodo c prima di lui, la fascia
 * dei chilometri fra i loro punti tariffari. `null` dove manca un km o
 * mancano le fasce.
 */
export function matriceDelleFasce(kmDeiPunti: readonly (number | null)[], fasce: readonly FasciaKm[]): (number | null)[][] {
  return kmDeiPunti.map((kr, r) => kmDeiPunti.slice(0, r).map((kc) => (kr == null || kc == null ? null : fasciaDeiKm(Math.abs(kr - kc), fasce))));
}
