/**
 * Le percorrenze reali per l'analisi di una linea del progetto: le coppie di
 * fermate che servono, lette col calcolo unico (tratte-osservate-db.ts) per
 * ora, fascia oraria e giornata. Il calcolo del delta finale è in
 * percorrenze-reali.ts.
 */
import { leggiTratte } from "./tratte-osservate-db";
import { Osservato } from "./percorrenze-reali";

export interface Lettura { osservato: Osservato; transiti: number; disponibile: boolean; soloSiri: boolean }

export async function leggiOsservato(
  coppie: Array<{ da: string; a: string }>, date: string[], feedId: string | null,
): Promise<Lettura> {
  const osservato = new Osservato();
  if (coppie.length === 0 || date.length === 0) {
    const l = await leggiTratte({ date: [], feedId });
    return { osservato, transiti: 0, disponibile: l.disponibile, soloSiri: false };
  }
  const l = await leggiTratte({ date, coppie, perOra: true, feedId });
  for (const t of l.tratte) {
    const stat = { n: t.n, giorni: t.giorni, medianaS: t.medianaS, p85S: t.p85S, sosta: t.sosta };
    if (t.ora != null) osservato.aggiungi(t.da, t.a, t.ora, stat);
    else if (t.fascia != null) osservato.aggiungiFascia(t.da, t.a, t.fascia, stat);
    else osservato.aggiungi(t.da, t.a, null, stat);
  }
  return { osservato, transiti: l.transiti, disponibile: l.disponibile, soloSiri: l.soloSiri };
}
