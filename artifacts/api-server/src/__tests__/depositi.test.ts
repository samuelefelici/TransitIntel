/**
 * I depositi dell'azienda (tappa 6.4): le regole senza database. Il codice che
 * si propone, gli altri nomi puliti, e due depositi che non possono chiamarsi
 * allo stesso modo.
 */
import { describe, it, expect } from "vitest";
import { aliasPuliti, codiceDaNome, collisione, comeIlDatabase, ModificaDeposito, NuovoDeposito } from "../lib/depositi";
import type { Deposito } from "../lib/anagrafica-campi";

const dep = (codice: string, nome: string, alias: string[] = []): Deposito =>
  ({ codice, nome, gruppo: "A", cadenzaTurni: "semimensile", alias, ordine: 1 });

describe("depositi: il codice dal nome", () => {
  it("minuscole, senza accenti, trattini al posto del resto", () => {
    expect(codiceDaNome("Jesi Urbano")).toBe("jesi-urbano");
    expect(codiceDaNome("  San Benedetto del Tronto  ")).toBe("san-benedetto-del-tronto");
    expect(codiceDaNome("Città Alta / Nord")).toBe("citta-alta-nord");
    expect(codiceDaNome("Deposito n° 2")).toBe("deposito-n-2");
  });
  it("al più 40 caratteri, senza trattino in fondo; da un nome senza lettere non esce niente", () => {
    const c = codiceDaNome("Deposito della zona industriale di levante e ponente");
    expect(c.length).toBeLessThanOrEqual(40);
    expect(c).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(codiceDaNome("—")).toBe("");
  });
});

describe("depositi: gli altri nomi", () => {
  it("senza vuoti, senza doppioni, senza quelli che sono già il nome o il codice", () => {
    expect(aliasPuliti([" Moie ", "moie", "", "Jesi U", "JESI URBANO", "jesi-urbano"], { nome: "Jesi Urbano", codice: "jesi-urbano" }))
      .toEqual(["Moie", "Jesi U"]);
  });
  it("il nome di prima resta, anche se somiglia al codice: il database ritrova solo la scrittura esatta", () => {
    expect(aliasPuliti(["Jesi Urbano"], { nome: "Jesi Città", codice: "jesi-urbano" })).toEqual(["Jesi Urbano"]);
    expect(aliasPuliti(["03", "3"], { nome: "Osimo", codice: "osimo" })).toEqual(["03", "3"]);
  });
});

describe("depositi: come li ritrova il database", () => {
  const catalogo = [dep("jesi-urbano", "Jesi Città", ["Jesi Urbano", "Moie"]), dep("jesi", "Jesi")];
  it("solo la scrittura esatta di nome, codice o alias, a parte le maiuscole", () => {
    expect(comeIlDatabase(" jesi urbano ", catalogo)?.codice).toBe("jesi-urbano");
    expect(comeIlDatabase("JESI-URBANO", catalogo)?.codice).toBe("jesi-urbano");
    expect(comeIlDatabase("moie", catalogo)?.codice).toBe("jesi-urbano");
    expect(comeIlDatabase("Jesi", catalogo)?.codice).toBe("jesi");
  });
  it("senza accenti o con la punteggiatura diversa non lo ritrova (il codice dell'app sì)", () => {
    expect(comeIlDatabase("Jesi Citta", catalogo)).toBeNull();
    expect(comeIlDatabase("jesi.urbano", catalogo)).toBeNull();
    expect(comeIlDatabase("", catalogo)).toBeNull();
  });
});

describe("depositi: due depositi non si chiamano allo stesso modo", () => {
  const catalogo = [dep("ancona", "Ancona", ["Polverigi"]), dep("jesi", "Jesi"), dep("jesi-urbano", "Jesi Urbano", ["Moie", "03"])];
  it("un nome, un codice o un alias già di un altro: il messaggio dice quale e di chi", () => {
    expect(collisione(dep("nuovo", "Polverigi"), catalogo)).toMatch(/«Polverigi».*Ancona/);
    expect(collisione(dep("nuovo", "Nuovo", ["JESI"]), catalogo)).toMatch(/«JESI».*Jesi/);
    expect(collisione(dep("nuovo", "Nuovo", ["3"]), catalogo)).toMatch(/Jesi Urbano/);
    expect(collisione(dep("nuovo", "ancona"), catalogo)).toMatch(/Ancona/);
  });
  it("niente in comune: va bene; e un deposito non collide con sé stesso", () => {
    expect(collisione(dep("osimo", "Osimo", ["Offagna"]), catalogo)).toBeNull();
    expect(collisione(dep("ancona", "Ancona Centro", ["Polverigi", "Ancona"]), catalogo)).toBeNull();
  });
});

describe("depositi: quello che l'amministratore può scrivere", () => {
  it("un deposito nuovo: il nome e il gruppo; il resto ha un valore di partenza", () => {
    const p = NuovoDeposito.safeParse({ nome: "  Nord ", gruppo: "B" });
    expect(p.success && p.data).toEqual({ nome: "Nord", gruppo: "B", cadenzaTurni: "semimensile", alias: [] });
  });
  it("rifiuta: gruppo sconosciuto, codice con maiuscole o spazi, campi in più, troppi altri nomi", () => {
    expect(NuovoDeposito.safeParse({ nome: "Nord", gruppo: "C" }).success).toBe(false);
    expect(NuovoDeposito.safeParse({ nome: "Nord", gruppo: "A", codice: "Nord 1" }).success).toBe(false);
    expect(NuovoDeposito.safeParse({ nome: "", gruppo: "A" }).success).toBe(false);
    expect(NuovoDeposito.safeParse({ nome: "Nord", gruppo: "A", colore: "#fff" }).success).toBe(false);
    expect(NuovoDeposito.safeParse({ nome: "Nord", gruppo: "A", alias: Array.from({ length: 31 }, (_, i) => `n${i}`) }).success).toBe(false);
  });
  it("in modifica il codice non si cambia", () => {
    expect(ModificaDeposito.safeParse({ codice: "altro" }).success).toBe(false);
    expect(ModificaDeposito.safeParse({ cadenzaTurni: "settimanale", ordine: 3 }).success).toBe(true);
  });
});
