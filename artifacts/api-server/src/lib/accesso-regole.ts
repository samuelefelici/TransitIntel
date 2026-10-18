/**
 * Le regole dell'accesso, pure e senza database: blocco dopo i tentativi
 * falliti, chi deve usare la verifica in due passaggi, che cosa può fare una
 * sessione «limitata» (password da cambiare, verifica da attivare).
 *
 * Riferimenti da verificare con il DPO: GDPR art. 32 (misure adeguate),
 * Direttiva NIS2 2022/2555 art. 21 (controllo degli accessi, autenticazione a
 * più fattori «dove appropriato»).
 */
import { randomBytes } from "node:crypto";

export const TENTATIVI_PRIMA_DEL_BLOCCO = 5;
const BLOCCO_MINUTI = 15;
const BLOCCO_MASSIMO_MINUTI = 24 * 60;
const MINUTO_MS = 60_000;

/** Minuti di blocco dopo n errori di fila: 15 al quinto, poi il doppio a ogni errore, al massimo un giorno. */
export function minutiDiBlocco(errori: number): number {
  if (errori < TENTATIVI_PRIMA_DEL_BLOCCO) return 0;
  return Math.min(BLOCCO_MINUTI * 2 ** (errori - TENTATIVI_PRIMA_DEL_BLOCCO), BLOCCO_MASSIMO_MINUTI);
}

/** Una serie di errori: per un indirizzo, per un account, o dei codici di un utente. */
export interface StatoTentativi { errori: number; inizio: Date | null; ultimo: Date | null; bloccatoFino: Date | null }

export interface RegolaBlocco {
  /** il tentativo numero `soglia` è l'ultimo: i successivi aspettano */
  soglia: number;
  minuti: (errori: number) => number;
  /** la serie è chiusa e si riparte da zero */
  serieFinita: (s: StatoTentativi, ora: number) => boolean;
}

/**
 * Password, da un indirizzo: 5 errori e quell'indirizzo aspetta 15 minuti,
 * poi il doppio a ogni errore, al massimo un giorno; dopo un giorno senza
 * errori si riparte. Chi sbaglia da un altro posto non blocca il titolare.
 */
export const REGOLA_INDIRIZZO: RegolaBlocco = {
  soglia: TENTATIVI_PRIMA_DEL_BLOCCO,
  minuti: minutiDiBlocco,
  serieFinita: (s, ora) => !s.ultimo || ora - s.ultimo.getTime() >= 24 * 60 * MINUTO_MS,
};

/**
 * Password, da qualunque indirizzo: al massimo 20 errori in 15 minuti, poi
 * l'account aspetta 15 minuti. Ferma chi prova da tanti indirizzi, ma per
 * tenere fermo un account bisogna insistere da molti indirizzi diversi.
 */
export const TENTATIVI_ACCOUNT_IN_FINESTRA = 20;
export const REGOLA_ACCOUNT: RegolaBlocco = {
  soglia: TENTATIVI_ACCOUNT_IN_FINESTRA,
  minuti: () => BLOCCO_MINUTI,
  serieFinita: (s, ora) => !s.inizio || ora - s.inizio.getTime() >= BLOCCO_MINUTI * MINUTO_MS,
};

/**
 * Codici della verifica: chi li sbaglia conosce già la password, quindi la
 * serie è per utente e si chiude solo con un codice giusto (o con l'admin):
 * 5 errori e 15 minuti, poi il doppio, al massimo un giorno.
 */
export const REGOLA_CODICI: RegolaBlocco = {
  soglia: TENTATIVI_PRIMA_DEL_BLOCCO,
  minuti: minutiDiBlocco,
  serieFinita: () => false,
};

/**
 * Un errore in più nella serie, o il blocco ancora in corso. Per la password
 * si conta PRIMA del confronto, che è lento: senza, dieci richieste insieme
 * passerebbero tutte; il tentativo che arriva alla soglia blocca già i
 * successivi, e se va bene la serie si azzera.
 */
export function prenotaTentativo(s: StatoTentativi, ora: number, r: RegolaBlocco): { bloccatoFino: Date } | { stato: StatoTentativi } {
  if (s.bloccatoFino && s.bloccatoFino.getTime() > ora) return { bloccatoFino: s.bloccatoFino };
  const nuova = s.errori <= 0 || r.serieFinita(s, ora);
  const errori = nuova ? 1 : s.errori + 1;
  const minuti = errori >= r.soglia ? r.minuti(errori) : 0;
  return {
    stato: {
      errori,
      inizio: nuova ? new Date(ora) : s.inizio,
      ultimo: new Date(ora),
      bloccatoFino: minuti > 0 ? new Date(ora + minuti * MINUTO_MS) : null,
    },
  };
}

/** L'email come chiave dei tentativi: senza spazi né maiuscole, anche per chi non esiste. */
export function chiaveEmail(email: string): string {
  return email.trim().toLowerCase().slice(0, 200);
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

/**
 * I token dati a un servizio che agisce per conto della persona (Argos) non
 * toccano il suo accesso: niente sicurezza dell'account, accesso a FleetCare
 * o amministrazione. Leggere chi è (/auth/me) sì.
 */
export function percorsoVietatoAiServizi(percorso: string): boolean {
  const p = percorso.toLowerCase();
  if (p === "/auth/me") return false;
  return p === "/auth" || p.startsWith("/auth/") || p === "/admin" || p.startsWith("/admin/");
}

/** Accesso recente: la password è stata data da poco, e per attivare la verifica non si richiede. */
export const MINUTI_ACCESSO_RECENTE = 10;
export function accessoRecente(at: number | undefined, oraMs: number): boolean {
  return typeof at === "number" && oraMs / 1000 - at < MINUTI_ACCESSO_RECENTE * 60;
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
