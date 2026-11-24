import { describe, it, expect } from "vitest";
import { ACCANTO, CICLO, codiceCompleto, nomeDiBenvenuto, saluto } from "./accesso";
import { SEZIONI } from "./navigazione";

describe("la panoramica della pagina di accesso", () => {
  it("il ciclo ha sei tappe numerate in ordine, ognuna con un testo breve", () => {
    expect(CICLO.map((t) => t.numero)).toEqual(["01", "02", "03", "04", "05", "06"]);
    for (const t of [...CICLO, ...ACCANTO]) {
      expect(t.titolo.length).toBeGreaterThan(2);
      expect(t.testo.length).toBeLessThanOrEqual(90);
      expect(t.testo.endsWith(".")).toBe(true);
    }
  });

  it("le tappe del ciclo sono le sezioni del menu, nello stesso ordine", () => {
    const sezioni = SEZIONI.map((s) => s.titolo.toLowerCase());
    const posizioni = ["rete e orari", "turni", "pubblicazione", "personale", "esercizio"].map((t) => sezioni.indexOf(t));
    expect(posizioni.every((p) => p >= 0)).toBe(true);
    expect([...posizioni].sort((a, b) => a - b)).toEqual(posizioni);
  });
});

describe("il saluto e il codice", () => {
  it("il nome di battesimo, senza le note fra parentesi", () => {
    expect(nomeDiBenvenuto("Ada Amministra", "ada@prova.local")).toBe("Ada");
    expect(nomeDiBenvenuto("Piero (admin) Pianifica", null)).toBe("Piero");
  });

  it("senza nome, la parte più lunga dell'email; senza niente, il saluto senza nome", () => {
    expect(nomeDiBenvenuto(null, "m.bianchini@prova.local")).toBe("Bianchini");
    expect(nomeDiBenvenuto("  ", "sala@prova.local")).toBe("Sala");
    expect(nomeDiBenvenuto(undefined, "")).toBe("");
    expect(saluto("Ada")).toBe("Buon lavoro, Ada");
    expect(saluto("")).toBe("Buon lavoro");
  });

  it("il codice dell'app: sei cifre, lo spazio in mezzo non conta", () => {
    expect(codiceCompleto("123456")).toBe(true);
    expect(codiceCompleto("123 456")).toBe(true);
    expect(codiceCompleto("12345")).toBe(false);
    expect(codiceCompleto("12a456")).toBe(false);
  });
});
