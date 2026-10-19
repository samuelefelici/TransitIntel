/**
 * Codici a tempo per la verifica in due passaggi (TOTP, RFC 6238), quelli
 * delle app come Google o Microsoft Authenticator. Senza dipendenze: HMAC-SHA1
 * di node:crypto, passo di 30 secondi, 6 cifre.
 *
 * Funzioni pure: il tempo si passa da fuori, così i test usano i vettori
 * dell'RFC e il server l'ora vera.
 */
import { createHmac, randomBytes } from "node:crypto";

const ALFABETO = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const PASSO_SECONDI = 30;
export const CIFRE = 6;

export function base32(buf: Buffer): string {
  let bit = 0, valore = 0, out = "";
  for (const b of buf) {
    valore = (valore << 8) | b; bit += 8;
    while (bit >= 5) { out += ALFABETO[(valore >>> (bit - 5)) & 31]; bit -= 5; }
  }
  if (bit > 0) out += ALFABETO[(valore << (5 - bit)) & 31];
  return out;
}

export function daBase32(s: string): Buffer {
  const pulita = s.toUpperCase().replace(/[\s=-]/g, "");
  let bit = 0, valore = 0;
  const out: number[] = [];
  for (const ch of pulita) {
    const i = ALFABETO.indexOf(ch);
    if (i < 0) throw new Error("base32 non valido");
    valore = (valore << 5) | i; bit += 5;
    if (bit >= 8) { out.push((valore >>> (bit - 8)) & 255); bit -= 8; }
  }
  return Buffer.from(out);
}

/** Un segreto nuovo: 20 byte casuali (160 bit, come chiede l'RFC 4226), in base32. */
export function nuovoSegreto(): string {
  return base32(randomBytes(20));
}

/** Il codice per un contatore (HOTP, RFC 4226). */
export function hotp(chiave: Buffer, contatore: number, cifre = CIFRE): string {
  const c = Buffer.alloc(8);
  c.writeBigUInt64BE(BigInt(contatore));
  const h = createHmac("sha1", chiave).update(c).digest();
  const o = h[h.length - 1]! & 15;
  const n = ((h[o]! & 0x7f) << 24) | (h[o + 1]! << 16) | (h[o + 2]! << 8) | h[o + 3]!;
  return String(n % 10 ** cifre).padStart(cifre, "0");
}

export const passoDi = (ms: number) => Math.floor(ms / 1000 / PASSO_SECONDI);

export function totp(chiave: Buffer, ms: number, cifre = CIFRE): string {
  return hotp(chiave, passoDi(ms), cifre);
}

/**
 * Il codice va bene? Si accetta il passo attuale e quelli subito prima e
 * dopo (orologi un po' sfasati), ma mai un passo già usato: un codice
 * intercettato non si riusa. Restituisce il passo da ricordare; `riusato`
 * dice che il codice era giusto ma già usato (si aspetta il prossimo, e non
 * conta come errore).
 */
export function verificaCodice(segreto: string, codice: unknown, ms: number, ultimoPasso: number | null): { ok: true; passo: number } | { ok: false; riusato?: true } {
  if (typeof codice !== "string") return { ok: false };
  const c = codice.replace(/\s/g, "");
  if (!/^\d{6}$/.test(c)) return { ok: false };
  const chiave = daBase32(segreto);
  const ora = passoDi(ms);
  let riusato = false;
  for (const passo of [ora - 1, ora, ora + 1]) {
    if (hotp(chiave, passo) !== c) continue;
    if (ultimoPasso != null && passo <= ultimoPasso) { riusato = true; continue; }
    return { ok: true, passo };
  }
  return riusato ? { ok: false, riusato: true } : { ok: false };
}

/** L'indirizzo da mettere nel QR: l'app lo legge e aggiunge l'account. */
export function uriOtpauth(segreto: string, email: string, emittente = "Cerbero"): string {
  const etichetta = encodeURIComponent(`${emittente}:${email}`);
  return `otpauth://totp/${etichetta}?secret=${segreto}&issuer=${encodeURIComponent(emittente)}&algorithm=SHA1&digits=${CIFRE}&period=${PASSO_SECONDI}`;
}
