/**
 * Corsia e tempo massimo dei calcoli dei turni macchina in coda.
 *
 * Il budget vero del VSP non è `timeLimit` (vehicle_scheduler_cpsat.py lo
 * ignora): è `vspAdvanced.totalTimeOverrideSec`, altrimenti l'intensità
 * (fast 60 s, normal 180, deep 420, extreme 900), come nel Python.
 *
 * - CP-SAT con budget fino a 3 minuti: corsia veloce (la Fucina «Rapida», la
 *   fattibilità di Argos); oltre, corsia lunga.
 * - VCSP e giri di Argos: sempre corsia lunga, tempo massimo 2 ore (un VCSP
 *   «normal» dura circa 17 minuti, un giro fino a 30).
 * - Il tempo massimo è una rete di sicurezza contro un processo appeso, non un
 *   secondo budget: almeno un'ora, 4 volte il budget, al massimo 2 ore.
 */
import type { Corsia } from "../lavori/coda";
import type { ModoVeicoli } from "./esegui";

const BUDGET_INTENSITA: Record<string, number> = { fast: 60, normal: 180, deep: 420, extreme: 900 };
/** il limite della coda (coda.lavori.timeout_sec ≤ 7200) */
const MASSIMO_SEC = 7200;
/** fino a qui un CP-SAT va nella corsia veloce */
const BUDGET_VELOCE_SEC = 180;

/** Il budget del VSP in secondi, letto come lo legge vehicle_scheduler_cpsat.py. */
export function budgetVsp(corpo: unknown): number {
  const c = (corpo ?? {}) as any;
  const adv = c.vspAdvanced && typeof c.vspAdvanced === "object" ? c.vspAdvanced : {};
  if (adv.totalTimeOverrideSec != null) {
    const n = Math.round(Number(adv.totalTimeOverrideSec));
    if (Number.isFinite(n) && n > 0) return Math.min(MASSIMO_SEC, n);
  }
  const intensita = adv.intensity ?? c.solverIntensity ?? "normal";
  return BUDGET_INTENSITA[String(intensita)] ?? BUDGET_INTENSITA.normal;
}

export function corsiaVeicoli(mode: ModoVeicoli, budgetSec: number): Corsia {
  return mode === "cpsat" && budgetSec <= BUDGET_VELOCE_SEC ? "veloce" : "lunga";
}

export function tempoMassimoVeicoli(mode: ModoVeicoli, budgetSec: number): number {
  if (mode === "vcsp") return MASSIMO_SEC;
  return Math.min(MASSIMO_SEC, Math.max(3600, 4 * budgetSec));
}

/** I giri di Argos: un VCSP (o un CP-SAT) con il salvataggio dello scenario. */
export const CORSIA_GIRO: Corsia = "lunga";
export const TEMPO_MASSIMO_GIRO = MASSIMO_SEC;
