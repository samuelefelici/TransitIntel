/**
 * Le regole dell'accesso, pure e senza database: blocco dopo i tentativi
 * falliti, chi deve usare la verifica in due passaggi, che cosa può fare una
 * sessione «limitata» (password da cambiare, verifica da attivare).
 *
 * Riferimenti da verificare con il DPO: GDPR art. 32 (misure adeguate),
 * Direttiva NIS2 2022/2555 art. 21 (controllo degli accessi, autenticazione a
 * più fattori «dove appropriato»).
 */
import { createHash, randomBytes } from "node:crypto";

export const TENTATIVI_PRIMA_DEL_BLOCCO = 5;
const BLOCCO_MINUTI = 15;
const BLOCCO_MASSIMO_MINUTI = 24 * 60;

/** Minuti di blocco dopo n errori di fila: 15 al quinto, poi il doppio a ogni errore, al massimo un giorno. */
export function minutiDiBlocco(errori: number): number {
  if (errori < TENTATIVI_PRIMA_DEL_BLOCCO) return 0;
  return Math.min(BLOCCO_MINUTI * 2 ** (errori - TENTATIVI_PRIMA_DEL_BLOCCO), BLOCCO_MASSIMO_MINUTI);
}

/** La verifica in due passaggi è obbligatoria per chi amministra o vede dati personali e sanitari. */
export function mfaObbligatoria(u: { role: string; permissions?: Record<string, boolean> | null }): boolean {
  return u.role === "admin" || !!u.permissions?.personale || !!u.permissions?.roster;
}

export type Limitazione = null | "password" | "mfa";

/**
 * Che cosa può fare questa sessione.
 *  - "password": l'admin ha impostato una password provvisoria, va cambiata;
 *  - "mfa": il ruolo chiede la verifica in due passaggi e non è ancora attiva;
 *  - "rifiuta": la verifica è attiva ma la sessione non l'ha fatta: si rientra.
 */
export function limitazione(
  u: { role: string; permissions?: Record<string, boolean> | null; deveCambiarePassword: boolean; mfaAttiva: boolean },
  sessione: { mfa?: boolean },
): Limitazione | "rifiuta" {
  if (u.mfaAttiva && !sessione.mfa) return "rifiuta";
  if (u.deveCambiarePassword) return "password";
  if (mfaObbligatoria(u) && !u.mfaAttiva) return "mfa";
  return null;
}

/** Le sole rotte aperte a una sessione limitata: quelle per mettersi in regola. */
export function percorsoConsentitoLimitato(percorso: string): boolean {
  const p = percorso.toLowerCase();
  return p === "/auth/me" || p === "/auth/logout" || p === "/auth/password" || p.startsWith("/auth/mfa/");
}

/** Codici di recupero: dieci, da 10 caratteri leggibili (senza 0/O, 1/I), mostrati una volta sola. */
export function nuoviCodiciDiRecupero(quanti = 10): string[] {
  const alfabeto = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: quanti }, () => {
    const b = randomBytes(10);
    const s = [...b].map(x => alfabeto[x % alfabeto.length]).join("");
    return `${s.slice(0, 5)}-${s.slice(5)}`;
  });
}

/** Si salva solo l'impronta del codice di recupero, come per le password. */
export function improntaRecupero(codice: string): string {
  return createHash("sha256").update(codice.toUpperCase().replace(/[^A-Z0-9]/g, "")).digest("hex");
}
