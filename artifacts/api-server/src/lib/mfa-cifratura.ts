/**
 * Il segreto della verifica in due passaggi si salva cifrato (AES-256-GCM):
 * chi legge il database, o un suo backup, non può generare i codici.
 *
 * La chiave è CERBERO_CHIAVE_MFA: 32 byte, in esadecimale (64 caratteri) o in
 * base64. In produzione è obbligatoria e senza l'API non parte, come per
 * JWT_SECRET; in sviluppo e nei test se ne ricava una fissa.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export function chiaveDa(env: { CERBERO_CHIAVE_MFA?: string; NODE_ENV?: string; JWT_SECRET?: string }): Buffer {
  const v = (env.CERBERO_CHIAVE_MFA ?? "").trim();
  if (v) {
    const k = /^[0-9a-f]{64}$/i.test(v) ? Buffer.from(v, "hex") : Buffer.from(v, "base64");
    if (k.length !== 32) throw new Error("CERBERO_CHIAVE_MFA deve essere di 32 byte (64 caratteri esadecimali o base64)");
    return k;
  }
  if (env.NODE_ENV === "production") {
    throw new Error("CERBERO_CHIAVE_MFA obbligatoria in produzione (genera con: openssl rand -hex 32)");
  }
  return createHash("sha256").update(`cerbero-solo-sviluppo|${env.JWT_SECRET ?? ""}`).digest();
}

const CHIAVE = chiaveDa(process.env);

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
