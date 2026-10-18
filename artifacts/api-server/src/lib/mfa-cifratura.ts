/**
 * Il segreto della verifica in due passaggi si salva cifrato (AES-256-GCM):
 * chi legge il database, o un suo backup, non può generare i codici. Le
 * impronte dei codici di recupero sono legate alla stessa chiave (HMAC): da
 * un dump del database non si risale ai codici.
 *
 * La chiave è CERBERO_CHIAVE_MFA: 32 byte, in esadecimale (64 caratteri) o in
 * base64. In produzione è obbligatoria e senza l'API non parte, come per
 * JWT_SECRET; in sviluppo e nei test se ne ricava una fissa.
 *
 * Cambio di chiave: la nuova va in CERBERO_CHIAVE_MFA e la vecchia in
 * CERBERO_CHIAVE_MFA_PRECEDENTE. I segreti si leggono con l'una o con l'altra
 * e si ricifrano con la nuova al primo accesso di ciascuno; i codici di
 * recupero di prima valgono finché la vecchia resta impostata.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";

type Env = { CERBERO_CHIAVE_MFA?: string; CERBERO_CHIAVE_MFA_PRECEDENTE?: string; NODE_ENV?: string; JWT_SECRET?: string };

function leggiChiave(v: string, nome: string): Buffer {
  const k = /^[0-9a-f]{64}$/i.test(v) ? Buffer.from(v, "hex") : Buffer.from(v, "base64");
  if (k.length !== 32) throw new Error(`${nome} deve essere di 32 byte (64 caratteri esadecimali o base64)`);
  return k;
}

export function chiaveDa(env: Env): Buffer {
  const v = (env.CERBERO_CHIAVE_MFA ?? "").trim();
  if (v) return leggiChiave(v, "CERBERO_CHIAVE_MFA");
  if (env.NODE_ENV === "production") {
    throw new Error("CERBERO_CHIAVE_MFA obbligatoria in produzione (genera con: openssl rand -hex 32)");
  }
  return createHash("sha256").update(`cerbero-solo-sviluppo|${env.JWT_SECRET ?? ""}`).digest();
}

export function chiavePrecedenteDa(env: Env): Buffer | null {
  const v = (env.CERBERO_CHIAVE_MFA_PRECEDENTE ?? "").trim();
  return v ? leggiChiave(v, "CERBERO_CHIAVE_MFA_PRECEDENTE") : null;
}

const CHIAVE = chiaveDa(process.env);
const PRECEDENTE = chiavePrecedenteDa(process.env);

export function cifra(testo: string, chiave: Buffer = CHIAVE): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", chiave, iv);
  const dati = Buffer.concat([c.update(testo, "utf8"), c.final()]);
  return ["v1", iv.toString("base64"), c.getAuthTag().toString("base64"), dati.toString("base64")].join(":");
}

export function decifra(cifrato: string, chiave: Buffer = CHIAVE): string {
  const [v, iv, tag, dati] = cifrato.split(":");
  if (v !== "v1" || !iv || !tag || !dati) throw new Error("segreto cifrato non leggibile");
  const d = createDecipheriv("aes-256-gcm", chiave, Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(dati, "base64")), d.final()]).toString("utf8");
}

/**
 * Apre un segreto salvato con la chiave di adesso o, durante un cambio di
 * chiave, con quella di prima (`vecchiaChiave`: va ricifrato). Se nessuna lo
 * apre lancia un errore: è un guasto di configurazione, non un codice sbagliato.
 */
export function apriSegreto(cifrato: string, chiavi: { attuale: Buffer; precedente: Buffer | null } = { attuale: CHIAVE, precedente: PRECEDENTE }): { testo: string; vecchiaChiave: boolean } {
  try {
    return { testo: decifra(cifrato, chiavi.attuale), vecchiaChiave: false };
  } catch (e) {
    if (!chiavi.precedente) throw e;
    return { testo: decifra(cifrato, chiavi.precedente), vecchiaChiave: true };
  }
}

/** Maiuscole, trattini e spazi non contano: «abcde-fghij» e «ABCDE FGHIJ» sono lo stesso codice. */
const normaleRecupero = (codice: string) => codice.toUpperCase().replace(/[^A-Z0-9]/g, "");

/** Si salva solo l'impronta del codice di recupero, con una chiave ricavata da CERBERO_CHIAVE_MFA. */
export function improntaRecupero(codice: string, chiave: Buffer = CHIAVE): string {
  const sottochiave = createHmac("sha256", chiave).update("cerbero-codici-recupero-v1").digest();
  return createHmac("sha256", sottochiave).update(normaleRecupero(codice)).digest("hex");
}

/** Le impronte con cui cercare un codice: con la chiave di adesso e, se c'è, con quella di prima. */
export function impronteRecupero(codice: string): string[] {
  return [CHIAVE, PRECEDENTE].filter((k): k is Buffer => !!k).map(k => improntaRecupero(codice, k));
}
