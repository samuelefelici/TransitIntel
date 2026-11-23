/**
 * Quanti calcoli pesanti insieme (tappa 7.21). Chi li può lanciare lo dicono i
 * diritti (scrittura sull'area dei turni, lib/permessi-rotte.ts); qui si
 * decide quanti:
 * - per persona e per tipo di calcolo, in coda o in corso: oltre, 429;
 * - per tutta l'installazione, in coda: oltre, 503 col tempo per riprovare.
 *   La coda è persistente e il lavoratore ha pochi posti: senza un tetto, molti
 *   calcoli lanciati insieme farebbero aspettare tutti per ore.
 * L'ordine in cui si eseguono lo decide coda.prendi(): prima chi non ha calcoli
 * in corso, così chi ne lancia tre non ferma gli altri.
 */
import * as coda from "./coda";
import { AMBITI } from "./ambiti";

/** In coda o in corso, per persona. */
export const TETTI_PER_PERSONA = {
  [AMBITI.turniMacchina]: 3,
  [AMBITI.turniGuida]: 3,
  [AMBITI.giroAgente]: 2,
} as const;

export type AmbitoConTetto = keyof typeof TETTI_PER_PERSONA;

const COSA: Record<AmbitoConTetto, string> = {
  [AMBITI.turniMacchina]: "calcoli dei turni macchina",
  [AMBITI.turniGuida]: "calcoli dei turni guida",
  [AMBITI.giroAgente]: "ottimizzazioni iterative",
};

/** In coda (non ancora partiti), per tutta l'installazione, se CALCOLI_IN_CODA_MAX non dice altro. */
export const CODA_MAX_PREDEFINITA = 30;
/** Quanto aspettare prima di riprovare quando la coda è piena. */
export const RIPROVA_SEC = 60;

export function tettoCoda(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.CALCOLI_IN_CODA_MAX);
  return Number.isInteger(n) && n > 0 ? n : CODA_MAX_PREDEFINITA;
}

export interface Rifiuto {
  codice: 429 | 503;
  corpo: { error: string; limite: number };
  riprovaTraSec?: number;
}

/** null se il calcolo si può accodare; altrimenti la risposta da dare. */
export async function controllaTetti(utenteId: string, ambito: AmbitoConTetto, env: NodeJS.ProcessEnv = process.env): Promise<Rifiuto | null> {
  const { miei, inCoda } = await coda.contaVivi(utenteId, ambito);
  const perPersona = TETTI_PER_PERSONA[ambito];
  if (miei >= perPersona) {
    return {
      codice: 429,
      corpo: { error: `Hai già ${perPersona} ${COSA[ambito]} in coda o in corso: aspetta che finiscano o fermane uno.`, limite: perPersona },
    };
  }
  const massimo = tettoCoda(env);
  if (inCoda >= massimo) {
    return {
      codice: 503,
      corpo: { error: `La coda dei calcoli è piena (${massimo} in attesa): riprova fra qualche minuto.`, limite: massimo },
      riprovaTraSec: RIPROVA_SEC,
    };
  }
  return null;
}

/** La risposta di un rifiuto, col Retry-After quando c'è. */
export function rispondiRifiuto(res: { set: (k: string, v: string) => unknown; status: (c: number) => { json: (b: unknown) => unknown } }, r: Rifiuto): void {
  if (r.riprovaTraSec) res.set("Retry-After", String(r.riprovaTraSec));
  res.status(r.codice).json(r.corpo);
}
