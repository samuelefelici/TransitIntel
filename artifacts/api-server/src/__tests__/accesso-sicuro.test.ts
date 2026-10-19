import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { base32, daBase32, hotp, nuovoSegreto, totp, uriOtpauth, verificaCodice, passoDi } from "../lib/totp";
import { apriSegreto, chiaveDa, chiavePrecedenteDa, cifra, decifra, improntaRecupero } from "../lib/mfa-cifratura";
import {
  accessoRecente, chiaveEmail, limitazione, mfaObbligatoria, minutiDiBlocco, nuoviCodiciDiRecupero, percorsoConsentitoLimitato,
  percorsoVietatoAiServizi, prenotaTentativo, REGOLA_ACCOUNT, REGOLA_CODICI, REGOLA_INDIRIZZO, type StatoTentativi,
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
    /* lo stesso codice, riusato: non va, e si dice perché (non è un errore da contare) */
    expect(verificaCodice(segreto, codice, ora, passoDi(ora))).toEqual({ ok: false, riusato: true });
    expect(verificaCodice(segreto, "000000", ora, passoDi(ora))).toEqual({ ok: false });
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

  it("cambio di chiave: si apre anche con la precedente, e si sa che va ricifrato", () => {
    const vecchia = chiaveDa({ CERBERO_CHIAVE_MFA: "a".repeat(64) });
    const nuova = chiaveDa({ CERBERO_CHIAVE_MFA: "b".repeat(64) });
    const c = cifra("SEGRETO", vecchia);
    expect(apriSegreto(c, { attuale: nuova, precedente: vecchia })).toEqual({ testo: "SEGRETO", vecchiaChiave: true });
    expect(apriSegreto(cifra("SEGRETO", nuova), { attuale: nuova, precedente: vecchia })).toEqual({ testo: "SEGRETO", vecchiaChiave: false });
    expect(() => apriSegreto(c, { attuale: nuova, precedente: null })).toThrow();
    expect(chiavePrecedenteDa({})).toBeNull();
    expect(() => chiavePrecedenteDa({ CERBERO_CHIAVE_MFA_PRECEDENTE: "corta" })).toThrow(/32 byte/);
  });

  it("le impronte dei codici di recupero dipendono dalla chiave: da un dump non si risale ai codici", () => {
    const k1 = chiaveDa({ CERBERO_CHIAVE_MFA: "a".repeat(64) });
    const k2 = chiaveDa({ CERBERO_CHIAVE_MFA: "b".repeat(64) });
    expect(improntaRecupero("ABCDE-FGHJK", k1)).toBe(improntaRecupero("abcde fghjk", k1));
    expect(improntaRecupero("ABCDE-FGHJK", k1)).not.toBe(improntaRecupero("ABCDE-FGHJK", k2));
    /* non è più lo sha256 semplice di prima */
    expect(improntaRecupero("ABCDE-FGHJK", k1)).not.toBe(createHash("sha256").update("ABCDEFGHJK").digest("hex"));
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

  it("i token dati ad Argos non toccano l'accesso: niente /auth (tranne /auth/me) e niente /admin", () => {
    for (const p of ["/auth/password", "/auth/mfa/attiva", "/AUTH/sessioni/chiudi", "/auth/fleetcare-sso", "/admin/users", "/admin/accessi", "/admin"]) {
      expect(percorsoVietatoAiServizi(p)).toBe(true);
    }
    for (const p of ["/auth/me", "/planning-studio/projects", "/authors", "/administration-x"]) expect(percorsoVietatoAiServizi(p)).toBe(false);
  });

  it("accesso recente: la password data da meno di 10 minuti", () => {
    const ora = 1_700_000_000_000;
    expect(accessoRecente(ora / 1000 - 60, ora)).toBe(true);
    expect(accessoRecente(ora / 1000 - 11 * 60, ora)).toBe(false);
    expect(accessoRecente(undefined, ora)).toBe(false);
  });

  it("l'email come chiave: senza spazi né maiuscole", () => {
    expect(chiaveEmail("  Mario.Rossi@Conerobus.IT ")).toBe("mario.rossi@conerobus.it");
    expect(chiaveEmail("x".repeat(300))).toHaveLength(200);
  });
});

describe("le serie di tentativi sbagliati", () => {
  const T0 = 1_700_000_000_000;
  const MIN = 60_000;
  const vuoto: StatoTentativi = { errori: 0, inizio: null, ultimo: null, bloccatoFino: null };
  /** n tentativi di fila a un minuto l'uno dall'altro, finché non si blocca */
  function serie(r: typeof REGOLA_INDIRIZZO, n: number, da = vuoto, t0 = T0) {
    let s = da;
    for (let i = 0; i < n; i++) {
      const p = prenotaTentativo(s, t0 + i * MIN, r);
      if (!("stato" in p)) return { s, bloccato: p.bloccatoFino, al: i };
      s = p.stato;
    }
    return { s, bloccato: null, al: n };
  }

  it("da un indirizzo: il quinto tentativo passa e blocca i successivi per 15 minuti", () => {
    const { s, bloccato, al } = serie(REGOLA_INDIRIZZO, 10);
    expect(al).toBe(5);
    expect(s.errori).toBe(5);
    expect(bloccato!.getTime()).toBe(T0 + 4 * MIN + 15 * MIN);
  });

  it("da un indirizzo: finito il blocco, un errore raddoppia; dopo un giorno di quiete si riparte", () => {
    const { s } = serie(REGOLA_INDIRIZZO, 5);
    const dopo = s.bloccatoFino!.getTime() + 1;
    const p = prenotaTentativo(s, dopo, REGOLA_INDIRIZZO);
    expect("stato" in p && p.stato.errori).toBe(6);
    expect("stato" in p && p.stato.bloccatoFino!.getTime()).toBe(dopo + 30 * MIN);
    const domani = prenotaTentativo(s, s.ultimo!.getTime() + 24 * 60 * MIN, REGOLA_INDIRIZZO);
    expect("stato" in domani && domani.stato.errori).toBe(1);
    expect("stato" in domani && domani.stato.bloccatoFino).toBeNull();
  });

  it("per l'account: 20 errori in 15 minuti da qualunque indirizzo, poi 15 minuti, poi si riparte", () => {
    /* 20 tentativi in 20 secondi */
    let s = vuoto;
    for (let i = 0; i < 20; i++) {
      const p = prenotaTentativo(s, T0 + i * 1000, REGOLA_ACCOUNT);
      expect("stato" in p).toBe(true);
      if ("stato" in p) s = p.stato;
    }
    expect(s.bloccatoFino!.getTime()).toBe(T0 + 19_000 + 15 * MIN);
    expect("bloccatoFino" in prenotaTentativo(s, T0 + 20_000, REGOLA_ACCOUNT)).toBe(true);
    const dopo = prenotaTentativo(s, s.bloccatoFino!.getTime() + 1, REGOLA_ACCOUNT);
    expect("stato" in dopo && dopo.stato.errori).toBe(1);
    /* errori lenti, uno al minuto: in 15 minuti ne stanno 15, la finestra si chiude e non si blocca mai */
    const lenti = serie(REGOLA_ACCOUNT, 60);
    expect(lenti.bloccato).toBeNull();
  });

  it("i codici: la serie non si chiude da sé, il blocco raddoppia fino a un giorno", () => {
    const { s, al } = serie(REGOLA_CODICI, 10);
    expect(al).toBe(5);
    let t = s.bloccatoFino!.getTime() + 1;
    let x = s;
    for (const minuti of [30, 60, 120, 240, 480, 960, 1440, 1440]) {
      const p = prenotaTentativo(x, t, REGOLA_CODICI);
      if (!("stato" in p)) throw new Error("bloccato");
      expect(p.stato.bloccatoFino!.getTime()).toBe(t + minuti * MIN);
      x = p.stato;
      t = x.bloccatoFino!.getTime() + 1;
    }
  });
});
