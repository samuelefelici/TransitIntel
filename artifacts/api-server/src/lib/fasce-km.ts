/**
 * Le fasce chilometriche dell'extraurbano (tappa 6.8, migrazione 0041).
 *
 * Il prezzo di una corsa extraurbana viene dalla distanza: a ogni fascia di
 * chilometri il suo prezzo. La tabella era scritta due volte nel codice
 * (tariffe a zone e tariffe minime), uguale. Ora è un dato dell'azienda
 * (tabella `fasce_km`) e sta qui, una volta sola.
 *
 * Le usano solo le rotte delle tariffe, con funzioni sincrone e in
 * profondità: quelle in vigore stanno in memoria. Le legge
 * lib/fasce-km-store.ts quando si apre una rotta delle tariffe (al più ogni
 * minuto), e chi le salva le rimette in vigore subito.
 *
 * Un'azienda che non le ha ancora scritte non ha fasce: chi chiede una
 * fascia riceve `SenzaFasce`, col testo da mostrare. Niente prezzi inventati.
 *
 * Niente import.
 */

/** Una fascia: una distanza le appartiene se è più di `kmFrom` e al più `kmTo`. */
export interface FasciaKm {
  /** il numero della fascia, da 1 */
  fascia: number;
  kmFrom: number;
  kmTo: number;
  /** il prezzo della corsa semplice, in euro */
  price: number;
}

export const MASSIMO_FASCE = 60;
export const MASSIMO_KM = 2000;
export const MASSIMO_PREZZO = 999.99;

/** Le fasce non ci sono: l'azienda non le ha ancora scritte. Il messaggio è quello da mostrare. */
export class SenzaFasce extends Error {
  constructor() {
    super("Mancano le fasce chilometriche dell'extraurbano: le scrive l'amministratore in Amministrazione › Azienda, scheda «Fasce chilometriche»");
    this.name = "SenzaFasce";
  }
}

let inVigore: readonly FasciaKm[] = Object.freeze([]);

/** Mette in vigore le fasce (lib/fasce-km-store.ts; nei test, chi prova un'azienda con le sue fasce). In ordine di numero. */
export function impostaFasce(fasce: readonly FasciaKm[]): void {
  inVigore = Object.freeze([...fasce].sort((a, b) => a.fascia - b.fascia).map((f) => Object.freeze({ ...f })));
}

/** Le fasce in vigore, in ordine; vuoto se l'azienda non le ha scritte. */
export const fasceKm = (): readonly FasciaKm[] => inVigore;

/** Le fasce in vigore, o `SenzaFasce` se non ce ne sono. */
export function fasceObbligate(): readonly FasciaKm[] {
  if (inVigore.length === 0) throw new SenzaFasce();
  return inVigore;
}

/** La prima fascia: quella delle distanze più corte. */
export const primaFascia = (): FasciaKm => fasceObbligate()[0]!;

/** L'ultima fascia: quella delle distanze più lunghe. */
export const ultimaFascia = (): FasciaKm => { const f = fasceObbligate(); return f[f.length - 1]!; };

/** La fascia con quel numero. I numeri vengono dalle fasce stesse: se non c'è, le fasce sono cambiate a metà del conto. */
export function fasciaNumero(n: number): FasciaKm {
  const f = fasceObbligate().find((x) => x.fascia === n);
  if (!f) throw new Error(`La fascia ${n} non c'è fra le fasce chilometriche in vigore`);
  return f;
}

/**
 * La fascia di una distanza: quella in cui la distanza è più di «da» e al più
 * «a». Oltre l'ultima vale l'ultima; a zero chilometri (o meno) nessuna.
 */
export function fasciaPerDistanza(distKm: number): FasciaKm | undefined {
  const fasce = fasceObbligate();
  if (distKm <= 0) return undefined;
  return fasce.find((b) => distKm > b.kmFrom && distKm <= b.kmTo) ?? fasce[fasce.length - 1];
}

/**
 * Il numero della fascia di una distanza come la contano le polimetriche
 * (tappa 6.33, la stessa regola di artifacts/transitintel/src/lib/polimetrica.ts):
 * i km arrotondati al metro, la fascia in cui la distanza è al più «a» (6 km
 * esatti stanno nella fascia che finisce a 6), a zero km la prima, oltre
 * l'ultima l'ultima. `null` senza fasce. Diversa da `fasciaPerDistanza`, che a
 * zero km non dà nessuna fascia: due fermate dello stesso nodo pagano la prima.
 */
export function fasciaDeiKm(distKm: number, fasce: readonly FasciaKm[]): number | null {
  if (fasce.length === 0 || !Number.isFinite(distKm)) return null;
  const d = Math.max(0, Math.round(distKm * 1000) / 1000);
  return (fasce.find((f) => d <= f.kmTo) ?? fasce[fasce.length - 1]!).fascia;
}

/**
 * Che cosa non va in un elenco di fasce, in parole; vuoto se sta in piedi.
 * Le fasce sono numerate da 1 senza buchi, la prima parte da 0 km, ognuna
 * comincia dove finisce quella prima (né buchi né sovrapposizioni) e finisce
 * dopo dov'è cominciata; i prezzi sono maggiori di zero.
 */
export function erroriFasce(fasce: readonly FasciaKm[]): string[] {
  const e: string[] = [];
  if (fasce.length > MASSIMO_FASCE) e.push(`Le fasce sono al più ${MASSIMO_FASCE}.`);
  fasce.forEach((f, i) => {
    const n = i + 1;
    if (f.fascia !== n) e.push(`Fascia ${n}: le fasce si numerano da 1 senza saltare (qui c'è ${f.fascia}).`);
    if (!Number.isFinite(f.kmFrom) || !Number.isFinite(f.kmTo) || f.kmFrom < 0) e.push(`Fascia ${n}: i chilometri sono numeri da 0 in su.`);
    else if (f.kmTo <= f.kmFrom) e.push(`Fascia ${n}: finisce a ${f.kmTo} km, prima di dove comincia (${f.kmFrom} km).`);
    else if (f.kmTo > MASSIMO_KM) e.push(`Fascia ${n}: al più ${MASSIMO_KM} km.`);
    const prima = i === 0 ? 0 : fasce[i - 1]!.kmTo;
    if (Number.isFinite(f.kmFrom) && f.kmFrom !== prima) {
      e.push(i === 0 ? `Fascia 1: la prima fascia parte da 0 km (qui da ${f.kmFrom}).`
        : f.kmFrom > prima ? `Fascia ${n}: resta un buco fra ${prima} e ${f.kmFrom} km.`
          : `Fascia ${n}: si sovrappone alla ${n - 1} (comincia a ${f.kmFrom} km, l'altra finisce a ${prima}).`);
    }
    if (!Number.isFinite(f.price) || f.price <= 0) e.push(`Fascia ${n}: il prezzo è maggiore di zero.`);
    else if (f.price > MASSIMO_PREZZO) e.push(`Fascia ${n}: il prezzo è al più ${MASSIMO_PREZZO} €.`);
  });
  return e;
}
