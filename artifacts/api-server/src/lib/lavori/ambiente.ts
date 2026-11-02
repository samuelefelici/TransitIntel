/** Configurazione degli esecutori dall'ambiente (lavoratore ed esecutore interno dell'API). */
import os from "node:os";
import type { Corsia } from "./coda";

const intero = (v: string | undefined, def: number, max: number) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? Math.min(n, max) : def;
};

/** LAVORI_SLOT_LUNGA e LAVORI_SLOT_VELOCE: quanti calcoli insieme per corsia (default 1 e 1). */
export function slotDaAmbiente(env: NodeJS.ProcessEnv = process.env): Record<Corsia, number> {
  return { lunga: intero(env.LAVORI_SLOT_LUNGA, 1, 8), veloce: intero(env.LAVORI_SLOT_VELOCE, 1, 8) };
}

/** Il nome di chi esegue, per il lease: ruolo, host (il container) e pid. */
export function chiSono(ruolo: "api" | "lavoratore"): string {
  return `${ruolo}:${os.hostname()}:${process.pid}`;
}

/** L'esecutore interno dell'API è acceso salvo CERBERO_LAVORATORE_INTERNO=0. */
export function esecutoreInternoAcceso(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CERBERO_LAVORATORE_INTERNO !== "0";
}
