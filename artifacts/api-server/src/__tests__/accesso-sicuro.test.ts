import { describe, it, expect } from "vitest";
import { base32, daBase32, hotp, nuovoSegreto, totp, uriOtpauth, verificaCodice, passoDi } from "../lib/totp";
import { chiaveDa, cifra, decifra } from "../lib/mfa-cifratura";
import {
  improntaRecupero, limitazione, mfaObbligatoria, minutiDiBlocco, nuoviCodiciDiRecupero, percorsoConsentitoLimitato,
} from "../lib/accesso-regole";

/* RFC 6238, appendice B: segreto ASCII "12345678901234567890", SHA1, 8 cifre */
const RFC = Buffer.from("12345678901234567890", "ascii");

describe("TOTP", () => {
  it("i vettori dell'RFC 6238 (8 cifre) e le ultime 6", () => {
    const casi: Array<[number, string]> = [
      [59, "94287082"], [1111111109, "07081804"], [1111111111, "14050471"],
      [1234567890, "89005924"], [2000000000, "69279037"], [20000000000, "65353130"],
    ];
    for (const [s, atteso] of casi) {
      expect(totp(RFC, s * 1000, 8)).toBe(atteso);
      expect(totp(RFC, s * 1000)).toBe(atteso.slice(2));
    }
  });

  it("HOTP dell'RFC 4226", () => {
    expect([0, 1, 2, 3, 4].map(c => hotp(RFC, c))).toEqual(["755224", "287082", "359152", "969429", "338314"]);
  });

  it("base32 andata e ritorno; un segreto nuovo è di 160 bit", () => {
    expect(base32(Buffer.from("12345678901234567890"))).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(daBase32("GEZD GNBV-GY3TQOJQ GEZDGNBVGY3TQOJQ").toString()).toBe("12345678901234567890");
    const s = nuovoSegreto();
    expect(daBase32(s)).toHaveLength(20);
    expect(() => daBase32("1!")).toThrow();
  });

  it("verifica: passo vicino sì, lontano no, mai un passo già usato", () => {
    const segreto = base32(RFC);
    const ora = 1_700_000_000_000;
    const codice = totp(RFC, ora);
    const v = verificaCodice(segreto, codice, ora, null);
    expect(v).toEqual({ ok: true, passo: passoDi(ora) });
    /* lo stesso codice, riusato */
    expect(verificaCodice(segreto, codice, ora, passoDi(ora)).ok).toBe(false);
    /* un passo prima e uno dopo vanno bene (orologi sfasati), due no */
    expect(verificaCodice(segreto, totp(RFC, ora - 30_000), ora, null).ok).toBe(true);
    expect(verificaCodice(segreto, totp(RFC, ora + 30_000), ora, null).ok).toBe(true);
    expect(verificaCodice(segreto, totp(RFC, ora - 90_000), ora, null).ok).toBe(false);
    expect(verificaCodice(segreto, "12345", ora, null).ok).toBe(false);
    expect(verificaCodice(segreto, undefined, ora, null).ok).toBe(false);
    expect(verificaCodice(segreto, ` ${codice.slice(0, 3)} ${codice.slice(3)} `, ora, null).ok).toBe(true);
  });

  it("l'indirizzo per il QR", () => {
    expect(uriOtpauth("ABC", "capo@azienda.it")).toBe("otpauth://totp/Cerbero%3Acapo%40azienda.it?secret=ABC&issuer=Cerbero&algorithm=SHA1&digits=6&period=30");
  });
});

describe("il segreto cifrato", () => {
  it("andata e ritorno; ogni cifratura è diversa; un'altra chiave non apre", () => {
    const k1 = chiaveDa({ CERBERO_CHIAVE_MFA: "a".repeat(64) });
    const k2 = chiaveDa({ CERBERO_CHIAVE_MFA: "b".repeat(64) });
    const c = cifra("SEGRETOBASE32", k1);
    expect(c).not.toContain("SEGRETOBASE32");
    expect(cifra("SEGRETOBASE32", k1)).not.toBe(c);
    expect(decifra(c, k1)).toBe("SEGRETOBASE32");
    expect(() => decifra(c, k2)).toThrow();
    expect(() => decifra("rotto", k1)).toThrow();
  });

  it("la chiave: obbligatoria in produzione, di 32 byte", () => {
    expect(() => chiaveDa({ NODE_ENV: "production" })).toThrow(/obbligatoria/);
    expect(() => chiaveDa({ CERBERO_CHIAVE_MFA: "corta" })).toThrow(/32 byte/);
    expect(chiaveDa({ CERBERO_CHIAVE_MFA: Buffer.alloc(32, 7).toString("base64") })).toHaveLength(32);
    expect(chiaveDa({ NODE_ENV: "development" })).toHaveLength(32);
  });
});

describe("le regole dell'accesso", () => {
  it("blocco: dal quinto errore, 15 minuti che raddoppiano, al massimo un giorno", () => {
    expect([0, 4, 5, 6, 7, 20].map(minutiDiBlocco)).toEqual([0, 0, 15, 30, 60, 1440]);
  });

  it("la verifica in due passaggi: obbligatoria per admin, Personale e Roster", () => {
    expect(mfaObbligatoria({ role: "admin" })).toBe(true);
    expect(mfaObbligatoria({ role: "user", permissions: { personale: true } })).toBe(true);
    expect(mfaObbligatoria({ role: "user", permissions: { roster: true } })).toBe(true);
    expect(mfaObbligatoria({ role: "user", permissions: { scheduling: true, analytics: true } })).toBe(false);
  });

  it("la sessione limitata: prima la password provvisoria, poi la verifica da attivare", () => {
    const base = { role: "user", permissions: { roster: true }, deveCambiarePassword: false, mfaAttiva: false };
    expect(limitazione({ ...base, deveCambiarePassword: true }, {})).toBe("password");
    expect(limitazione(base, {})).toBe("mfa");
    expect(limitazione({ ...base, mfaAttiva: true }, { mfa: true })).toBeNull();
    /* verifica attiva ma sessione senza: si rientra */
    expect(limitazione({ ...base, mfaAttiva: true }, {})).toBe("rifiuta");
    expect(limitazione({ ...base, permissions: { scheduling: true } }, {})).toBeNull();
  });

  it("una sessione limitata raggiunge solo le rotte per mettersi in regola", () => {
    for (const p of ["/auth/me", "/auth/logout", "/auth/password", "/auth/mfa/attiva", "/AUTH/MFA/conferma"]) expect(percorsoConsentitoLimitato(p)).toBe(true);
    for (const p of ["/auth/fleetcare-sso", "/roster/board", "/users/lookup", "/auth/mfa"]) expect(percorsoConsentitoLimitato(p)).toBe(false);
  });

  it("codici di recupero: dieci, diversi, e l'impronta non dipende da maiuscole e trattini", () => {
    const c = nuoviCodiciDiRecupero();
    expect(c).toHaveLength(10);
    expect(new Set(c).size).toBe(10);
    expect(c[0]).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
    expect(improntaRecupero(c[0]!)).toBe(improntaRecupero(c[0]!.toLowerCase().replace("-", " ")));
  });
});
