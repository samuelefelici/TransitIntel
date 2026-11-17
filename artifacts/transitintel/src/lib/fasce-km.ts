/**
 * Le fasce chilometriche dell'extraurbano (tappa 6.8): a ogni fascia di
 * chilometri il suo prezzo. Le scrive l'amministratore dalla pagina Azienda.
 * API: GET e PUT /api/admin/fasce-km. I conti stanno qui.
 *
 * Nel modulo ogni fascia ha solo dove finisce e quanto costa: comincia dove
 * finisce quella prima (la prima da 0 km), quindi buchi e sovrapposizioni
 * non si possono scrivere.
 */

/** Una fascia come la dà e la vuole l'API: una distanza le appartiene se è più di `kmFrom` e al più `kmTo`. */
export interface FasciaKm { fascia: number; kmFrom: number; kmTo: number; price: number }
export interface ElencoFasce { fasce: FasciaKm[]; massimoFasce: number }

/** Una riga del modulo: tutto testo, come lo scrive chi compila. */
export interface RigaFascia { a: string; prezzo: string }

export const MASSIMO_KM = 2000;
export const MASSIMO_PREZZO = 999.99;

/** Un numero scritto all'italiana («7,5») o col punto; NaN se non è un numero. */
export function numero(s: string): number {
  const t = s.trim().replace(",", ".");
  return /^\d+(\.\d+)?$/.test(t) ? Number(t) : NaN;
}

const decimali = (n: number, cifre: number) => Math.abs(n * 10 ** cifre - Math.round(n * 10 ** cifre)) < 1e-6;

/** I chilometri come si scrivono: «6», «7,5». */
export const km = (n: number): string => String(n).replace(".", ",");
/** Un prezzo come si scrive: «1,35». */
export const euro = (n: number): string => n.toFixed(2).replace(".", ",");

/** Le righe del modulo dalle fasce salvate. */
export const bozzaDa = (fasce: readonly FasciaKm[]): RigaFascia[] => fasce.map((f) => ({ a: km(f.kmTo), prezzo: euro(f.price) }));

/** Da dove comincia la riga i: dove finisce quella prima; la prima da 0. NaN se quella prima non è un numero. */
export const daDellaRiga = (bozza: readonly RigaFascia[], i: number): number => (i === 0 ? 0 : numero(bozza[i - 1]!.a));

/** Le fasce che il modulo descrive: numerate da 1, ognuna da dove finisce quella prima. */
export function fasceDaBozza(bozza: readonly RigaFascia[]): FasciaKm[] {
  return bozza.map((r, i) => ({ fascia: i + 1, kmFrom: daDellaRiga(bozza, i), kmTo: numero(r.a), price: numero(r.prezzo) }));
}

/** Che cosa non va nel modulo, una riga per problema; vuoto se si può salvare. */
export function erroriFasce(bozza: readonly RigaFascia[], massimo: number): string[] {
  const e: string[] = [];
  if (bozza.length > massimo) e.push(`Le fasce sono al più ${massimo}.`);
  fasceDaBozza(bozza).forEach((f) => {
    const n = f.fascia;
    if (Number.isNaN(f.kmTo)) e.push(`Fascia ${n}: scrivi fino a quanti chilometri arriva.`);
    else if (!decimali(f.kmTo, 1)) e.push(`Fascia ${n}: i chilometri hanno al più un decimale.`);
    else if (f.kmTo > MASSIMO_KM) e.push(`Fascia ${n}: al più ${MASSIMO_KM} km.`);
    else if (!Number.isNaN(f.kmFrom) && f.kmTo <= f.kmFrom) e.push(`Fascia ${n}: deve finire dopo ${km(f.kmFrom)} km, dove comincia.`);
    if (Number.isNaN(f.price)) e.push(`Fascia ${n}: scrivi il prezzo.`);
    else if (f.price <= 0) e.push(`Fascia ${n}: il prezzo è maggiore di zero.`);
    else if (!decimali(f.price, 2)) e.push(`Fascia ${n}: il prezzo ha al più due decimali.`);
    else if (f.price > MASSIMO_PREZZO) e.push(`Fascia ${n}: il prezzo è al più ${euro(MASSIMO_PREZZO)} €.`);
  });
  return e;
}

/** Cose che si possono salvare ma di solito sono una svista: una fascia più lunga che costa meno di quella prima. */
export function avvisiFasce(bozza: readonly RigaFascia[]): string[] {
  const fasce = fasceDaBozza(bozza);
  const a: string[] = [];
  for (let i = 1; i < fasce.length; i++) {
    const [prima, questa] = [fasce[i - 1]!.price, fasce[i]!.price];
    if (!Number.isNaN(prima) && !Number.isNaN(questa) && questa < prima) {
      a.push(`La fascia ${i + 1} costa meno della ${i} (${euro(questa)} € contro ${euro(prima)} €).`);
    }
  }
  return a;
}

/** Il corpo di PUT /api/admin/fasce-km. Si chiama solo se `erroriFasce` è vuoto. */
export const corpoFasce = (bozza: readonly RigaFascia[]) => ({ fasce: fasceDaBozza(bozza) });

/** Vero se il modulo è diverso dalle fasce salvate (un numero riscritto uguale non conta). */
export function fasceCambiate(bozza: readonly RigaFascia[], salvate: readonly FasciaKm[]): boolean {
  const chiave = (f: FasciaKm) => `${f.fascia}|${f.kmFrom}|${f.kmTo}|${f.price}`;
  return fasceDaBozza(bozza).map(chiave).join(";") !== salvate.map(chiave).join(";");
}

/**
 * La riga che si aggiunge in fondo: lunga come l'ultima fascia (6 km se è la
 * prima), col prezzo da scrivere.
 */
export function rigaNuova(bozza: readonly RigaFascia[]): RigaFascia {
  const fasce = fasceDaBozza(bozza);
  const ultima = fasce[fasce.length - 1];
  if (!ultima) return { a: "6", prezzo: "" };
  const lunga = ultima.kmTo - ultima.kmFrom;
  if (Number.isNaN(lunga) || lunga <= 0) return { a: "", prezzo: "" };
  return { a: km(Math.round((ultima.kmTo + lunga) * 10) / 10), prezzo: "" };
}

/** Il riassunto sotto il titolo: quante fasce, fino a quanti chilometri, da quanto a quanto. */
export function riassuntoFasce(fasce: readonly FasciaKm[]): string {
  if (fasce.length === 0) return "Nessuna fascia: i prezzi dell'extraurbano non si possono calcolare.";
  const prezzi = fasce.map((f) => f.price);
  const quante = fasce.length === 1 ? "Una fascia" : `${fasce.length} fasce`;
  return `${quante} fino a ${km(fasce[fasce.length - 1]!.kmTo)} km, da ${euro(Math.min(...prezzi))} € a ${euro(Math.max(...prezzi))} €.`;
}
