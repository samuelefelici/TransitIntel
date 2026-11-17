/**
 * Le fasce chilometriche di un'azienda di prova: le 23 di Conerobus, le
 * stesse che la migrazione 0041 carica nella sua installazione (un test le
 * confronta riga per riga). Chi prova un prezzo extraurbano le mette in
 * vigore con `conLeFasceDiProva()`; senza, l'azienda non ha fasce.
 */
import type { FasciaKm } from "../../lib/fasce-km";
import { dimenticaFasce, mettiInVigore } from "../../lib/fasce-km-store";
import { impostaFasce } from "../../lib/fasce-km";

const f = (fascia: number, kmFrom: number, kmTo: number, price: number): FasciaKm => ({ fascia, kmFrom, kmTo, price });

export const FASCE_DI_PROVA: FasciaKm[] = [
  f(1, 0, 6, 1.35), f(2, 6, 12, 1.85), f(3, 12, 18, 2.35), f(4, 18, 24, 2.85), f(5, 24, 30, 3.20), f(6, 30, 36, 3.55),
  f(7, 36, 42, 3.90), f(8, 42, 50, 4.25), f(9, 50, 60, 4.55), f(10, 60, 70, 4.85), f(11, 70, 80, 5.15), f(12, 80, 90, 5.45),
  f(13, 90, 100, 5.75), f(14, 100, 110, 6.05), f(15, 110, 120, 6.35), f(16, 120, 130, 6.65), f(17, 130, 140, 6.95),
  f(18, 140, 150, 7.25), f(19, 150, 160, 7.55), f(20, 160, 170, 7.85), f(21, 170, 180, 8.15), f(22, 180, 190, 8.45), f(23, 190, 200, 8.75),
];

/** Mette in vigore le fasce di prova in questo processo, come appena lette dal database. */
export function conLeFasceDiProva(): void { mettiInVigore(FASCE_DI_PROVA); }

/** Toglie le fasce: l'azienda non le ha ancora scritte. Alla prossima rotta delle tariffe si rileggono dal database. */
export function senzaFasce(): void { impostaFasce([]); dimenticaFasce(); }
