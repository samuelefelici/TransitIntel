import { describe, it, expect } from "vitest";
import { decidiPrimoAdmin, ePasswordPubblicata, erroreNuovaPassword, PASSWORD_MIN, PASSWORD_PUBBLICATE } from "../lib/password-regole";

describe("le password nuove", () => {
  it("la lunghezza: almeno 12 caratteri, al massimo 128; nessun obbligo di simboli", () => {
    expect(erroreNuovaPassword("corta1")).toMatch(/almeno 12/);
    expect(erroreNuovaPassword("dodicicaratt")).toBeNull();
    expect(erroreNuovaPassword("tre parole qualsiasi")).toBeNull();
    expect(erroreNuovaPassword("a".repeat(129))).toMatch(/al massimo/);
    expect(erroreNuovaPassword(undefined)).toMatch(/obbligatoria/);
    expect(erroreNuovaPassword(12345678901234)).toMatch(/obbligatoria/);
    expect(PASSWORD_MIN).toBe(12);
  });

  it("si rifiutano le comuni, i pezzi ripetuti e le sequenze della tastiera", () => {
    expect(erroreNuovaPassword("Password1234")).toMatch(/comune/);
    expect(erroreNuovaPassword("qwertyuiop12")).toMatch(/comune/);
    expect(erroreNuovaPassword("aaaaaaaaaaaa")).toMatch(/ripetuto/);
    expect(erroreNuovaPassword("123123123123")).toMatch(/ripetuto/);
    expect(erroreNuovaPassword("1234567890123")).toMatch(/sequenza/);
    expect(erroreNuovaPassword("asdfghjklzxc")).toMatch(/sequenza/);
  });

  it("si rifiutano il nome dell'azienda con poco altro e i dati della persona", () => {
    expect(erroreNuovaPassword("Conerobus2026!")).toMatch(/ovvia/);
    expect(erroreNuovaPassword("cerbero-cerbero")).toMatch(/ripetuto|ovvia/);
    expect(erroreNuovaPassword("conerobus e la luna piena")).toBeNull();
    expect(erroreNuovaPassword("Mario-del-2026!", { email: "mario.rossi@azienda.it" })).toMatch(/nome o l'email/);
    expect(erroreNuovaPassword("tantissimi rossi 1", { nome: "Paolo Rossi" })).toMatch(/nome o l'email/);
    expect(erroreNuovaPassword("lampione verde 77", { email: "mario.rossi@azienda.it", nome: "Mario Rossi" })).toBeNull();
    expect(erroreNuovaPassword("mariorossi-2026!", { nome: "Mario Rossi" })).toMatch(/nome o l'email/);
  });

  it("parole ripetute: la stessa parola più volte non basta", () => {
    expect(erroreNuovaPassword("Password Password Password")).toMatch(/ripetuto|ovvia/);
    expect(erroreNuovaPassword("Conerobus Conerobus")).toMatch(/ripetuto|ovvia/);
    expect(erroreNuovaPassword("Cerbero Cerbero 1")).toMatch(/ovvia/);
    expect(erroreNuovaPassword("Ancona Ancona Ancona")).toMatch(/ripetuto|ovvia/);
    expect(erroreNuovaPassword("passwordpassword1")).toMatch(/ovvia|comune/);
  });

  it("un nome corto dentro una parola qualsiasi non conta", () => {
    expect(erroreNuovaPassword("il camaleonte verde 7", { nome: "Leo Bianchi" })).toBeNull();
    expect(erroreNuovaPassword("la strada di casa mia", { nome: "Ada Neri" })).toBeNull();
    expect(erroreNuovaPassword("il motivo della corsa", { nome: "Ivo Verdi" })).toBeNull();
    expect(erroreNuovaPassword("corriera blu e treni", { email: "ufficio.turni@azienda.it" })).toBeNull();
    expect(erroreNuovaPassword("informazioni utili 2026", { email: "info@azienda.it" })).toBeNull();
    /* ma il nome da solo, anche con numeri, sì */
    expect(erroreNuovaPassword("leo e la sua bici 7", { nome: "Leo Bianchi" })).toMatch(/nome o l'email/);
    expect(erroreNuovaPassword("ufficio turni sereno", { email: "ufficio.turni@azienda.it" })).toMatch(/nome o l'email/);
  });
});

describe("le password pubblicate dal vecchio codice", () => {
  it("si riconoscono tutte e quattro, e nessuna passerebbe come password nuova", () => {
    expect(PASSWORD_PUBBLICATE).toHaveLength(4);
    for (const p of PASSWORD_PUBBLICATE) {
      expect(ePasswordPubblicata(p)).toBe(true);
      expect(erroreNuovaPassword(p)).not.toBeNull();
    }
    expect(ePasswordPubblicata("lampione verde 77")).toBe(false);
    expect(ePasswordPubblicata(undefined)).toBe(false);
  });
});

describe("il primo amministratore", () => {
  const buona = "lampione verde 77";
  it("con un amministratore attivo non si fa niente, anche con le variabili impostate", () => {
    expect(decidiPrimoAdmin(3, { CERBERO_ADMIN_EMAIL: "a@b.it", CERBERO_ADMIN_PASSWORD: buona })).toEqual({ tipo: "niente" });
  });

  it("senza amministratori attivi e senza variabili: nessun utente, un avviso", () => {
    const d = decidiPrimoAdmin(0, {});
    expect(d.tipo).toBe("avviso");
  });

  it("variabili sbagliate: nessun utente, un avviso col motivo", () => {
    expect(decidiPrimoAdmin(0, { CERBERO_ADMIN_EMAIL: "senza-chiocciola", CERBERO_ADMIN_PASSWORD: buona })).toMatchObject({ tipo: "avviso" });
    const corta = decidiPrimoAdmin(0, { CERBERO_ADMIN_EMAIL: "capo@azienda.it", CERBERO_ADMIN_PASSWORD: "corta" });
    expect(corta).toMatchObject({ tipo: "avviso" });
    expect((corta as any).messaggio).toMatch(/almeno 12/);
  });

  it("variabili giuste: si crea, con l'email normalizzata", () => {
    expect(decidiPrimoAdmin(0, { CERBERO_ADMIN_EMAIL: "  Capo@Azienda.IT ", CERBERO_ADMIN_PASSWORD: buona }))
      .toEqual({ tipo: "crea", email: "capo@azienda.it", password: buona });
  });
});

describe("il ripristino dell'amministratore", () => {
  it("con CERBERO_ADMIN_RIPRISTINA=1 si rimette in piedi anche se un admin attivo c'è", () => {
    const env = { CERBERO_ADMIN_EMAIL: "capo@azienda.it", CERBERO_ADMIN_PASSWORD: "lampione verde 77" };
    expect(decidiPrimoAdmin(1, env)).toEqual({ tipo: "niente" });
    expect(decidiPrimoAdmin(1, { ...env, CERBERO_ADMIN_RIPRISTINA: "1" })).toMatchObject({ tipo: "crea", email: "capo@azienda.it" });
  });
});
