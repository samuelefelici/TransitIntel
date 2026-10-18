import { describe, it, expect } from "vitest";
import { decidiPrimoAdmin, erroreNuovaPassword, PASSWORD_MIN } from "../lib/password-regole";

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
    expect(erroreNuovaPassword("cerbero-cerbero")).toMatch(/ovvia/);
    expect(erroreNuovaPassword("conerobus e la luna piena")).toBeNull();
    expect(erroreNuovaPassword("Mario-del-2026!", { email: "mario.rossi@azienda.it" })).toMatch(/nome o l'email/);
    expect(erroreNuovaPassword("tantissimi rossi 1", { nome: "Paolo Rossi" })).toMatch(/nome o l'email/);
    expect(erroreNuovaPassword("lampione verde 77", { email: "mario.rossi@azienda.it", nome: "Mario Rossi" })).toBeNull();
  });
});

describe("il primo amministratore", () => {
  const buona = "lampione verde 77";
  it("con utenti già presenti non si fa niente, anche con le variabili impostate", () => {
    expect(decidiPrimoAdmin(3, { CERBERO_ADMIN_EMAIL: "a@b.it", CERBERO_ADMIN_PASSWORD: buona })).toEqual({ tipo: "niente" });
  });

  it("a database vuoto senza variabili: nessun utente, un avviso", () => {
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
