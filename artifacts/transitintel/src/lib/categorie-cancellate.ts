/* Corse legate a una categoria di validità che non esiste più.
 *
 * Fino alla PR 2.15b una categoria in uso si poteva cancellare: sulle corse
 * restava una riga che punta a una categoria che non c'è più. Il calcolo della
 * validità la conta («vale solo nei giorni di quella categoria»): una corsa
 * che ha solo quella non vale in nessun giorno, e non esce in quadri orari,
 * GTFS e turni. La pagina mostrava una casella vuota. L'API ora dice quante
 * righe così ha ogni corsa (`lostCategories`); qui i conti e i testi.
 */

export interface CorsaConCategorie {
  /** righe della corsa che puntano a una categoria cancellata */
  lostCategories?: number;
  /** le categorie che esistono ancora */
  categories?: readonly unknown[] | null;
}

export const haCategoriaCancellata = (t: CorsaConCategorie): boolean => (t.lostCategories ?? 0) > 0;

/** Le restano solo categorie cancellate: non vale in nessun giorno. */
export const nonValeMai = (t: CorsaConCategorie): boolean =>
  haCategoriaCancellata(t) && (t.categories ?? []).length === 0;

/** «Senza categoria» davvero: nessuna riga, nemmeno una che punta nel vuoto. */
export const senzaCategoria = (t: CorsaConCategorie): boolean =>
  (t.categories ?? []).length === 0 && !haCategoriaCancellata(t);

export interface ContoCategorieCancellate { corse: number; nonValgonoMai: number }

export function contaCategorieCancellate(corse: readonly CorsaConCategorie[]): ContoCategorieCancellate {
  let n = 0, mai = 0;
  for (const t of corse) {
    if (!haCategoriaCancellata(t)) continue;
    n++;
    if (nonValeMai(t)) mai++;
  }
  return { corse: n, nonValgonoMai: mai };
}

/** Il testo dell'avviso sopra la tabella; vuoto se non c'è niente da dire. */
export function avvisoCategorieCancellate(c: ContoCategorieCancellate): string {
  if (c.corse === 0) return "";
  const quante = c.corse === 1
    ? "1 corsa è legata a una categoria che è stata cancellata"
    : `${c.corse} corse sono legate a una categoria che è stata cancellata`;
  if (c.nonValgonoMai === 0) return `${quante}. Valgono solo nei giorni delle altre loro categorie.`;
  const mai = c.nonValgonoMai === c.corse
    ? (c.corse === 1 ? "Non vale in nessun giorno" : "Non valgono in nessun giorno")
    : (c.nonValgonoMai === 1 ? "1 non vale in nessun giorno" : `${c.nonValgonoMai} non valgono in nessun giorno`);
  return `${quante}. ${mai}: non ${c.nonValgonoMai === 1 ? "esce" : "escono"} in quadri orari, GTFS e turni.`;
}

/** Il suggerimento sul segno di riga. */
export function titoloCategoriaCancellata(t: CorsaConCategorie): string {
  return nonValeMai(t)
    ? "Questa corsa è legata solo a una categoria che è stata cancellata: non vale in nessun giorno. Ridalle le categorie con «Sostituisci»."
    : "Una delle categorie di questa corsa è stata cancellata: la corsa vale solo nei giorni delle altre. Ridalle le categorie con «Sostituisci» per togliere il riferimento.";
}
