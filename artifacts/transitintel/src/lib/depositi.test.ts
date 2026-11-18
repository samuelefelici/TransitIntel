import { describe, it, expect } from "vitest";
import {
  aliasDaTesto, cadenzaInBreve, codiceDaNome, corpoModificaDeposito, corpoNuovoDeposito, depositoInUso, erroriDeposito, MODULO_DEPOSITO_VUOTO,
  gruppoInBreve, moduloDepositoDa, nomeCadenza, nomeGruppo, usoDelDeposito, type DepositoConUso,
} from "./depositi";

const dep = (x: Partial<DepositoConUso> = {}): DepositoConUso => ({
  codice: "jesi-urbano", nome: "Jesi Urbano", gruppo: "A", cadenzaTurni: "settimanale", alias: ["Moie", "Jesi U"], ordine: 5,
  conducenti: 0, cambiProgrammati: 0, gruppiTurni: 0, utenti: 0, ...x,
});

describe("depositi: il modulo", () => {
  it("il codice proposto dal nome, come nell'API", () => {
    expect(codiceDaNome("Jesi Urbano")).toBe("jesi-urbano");
    expect(codiceDaNome("Città Alta / Nord")).toBe("citta-alta-nord");
    expect(codiceDaNome("—")).toBe("");
  });
  it("gli altri nomi: separati da virgola o a capo, senza vuoti né doppioni", () => {
    expect(aliasDaTesto("Moie, Jesi U\n moie ,, Jesi urb")).toEqual(["Moie", "Jesi U", "Jesi urb"]);
    expect(aliasDaTesto("  ")).toEqual([]);
  });
  it("da un deposito al modulo e ritorno", () => {
    const m = moduloDepositoDa(dep());
    expect(m).toEqual({ nome: "Jesi Urbano", codice: "jesi-urbano", gruppo: "A", cadenzaTurni: "settimanale", alias: "Moie, Jesi U", ordine: "5" });
    expect(corpoModificaDeposito(m)).toEqual({ nome: "Jesi Urbano", gruppo: "A", cadenzaTurni: "settimanale", alias: ["Moie", "Jesi U"], ordine: 5 });
  });
  it("un deposito nuovo: il codice e l'ordine si mandano solo se scritti", () => {
    expect(corpoNuovoDeposito({ ...MODULO_DEPOSITO_VUOTO, nome: " Nord " }))
      .toEqual({ nome: "Nord", gruppo: "B", cadenzaTurni: "semimensile", alias: [] });
    expect(corpoNuovoDeposito({ ...MODULO_DEPOSITO_VUOTO, nome: "Nord", codice: "nord-1", ordine: "12" }))
      .toMatchObject({ codice: "nord-1", ordine: 12 });
  });
});

describe("depositi: gli errori del modulo", () => {
  const m = { ...MODULO_DEPOSITO_VUOTO, nome: "Nord" };
  it("un modulo a posto non ha errori; il codice può restare vuoto, se dal nome se ne ricava uno", () => {
    expect(erroriDeposito(m, true)).toEqual([]);
    expect(erroriDeposito({ ...m, nome: "—" }, true)).toEqual(["Codice: lettere minuscole, cifre e trattini, come deposito-nord"]);
  });
  it("il nome, il codice, l'ordine e gli altri nomi hanno i limiti dell'API", () => {
    expect(erroriDeposito({ ...m, nome: " " }, true)).toEqual(["Il nome va scritto"]);
    expect(erroriDeposito({ ...m, nome: "x".repeat(61) }, false)).toEqual(["Nome: al più 60 caratteri"]);
    expect(erroriDeposito({ ...m, codice: "Nord 1" }, true)).toEqual(["Codice: lettere minuscole, cifre e trattini, come deposito-nord"]);
    expect(erroriDeposito({ ...m, ordine: "dodici" }, true)).toEqual(["Ordine: un numero intero fra 0 e 9999"]);
    expect(erroriDeposito({ ...m, alias: Array.from({ length: 31 }, (_, i) => `n${i}`).join(",") }, true)).toEqual(["Al più 30 altri nomi"]);
  });
  it("in modifica il codice non si guarda: non cambia", () => {
    expect(erroriDeposito({ ...m, codice: "Non Valido" }, false)).toEqual([]);
  });
});

describe("depositi: chi lo usa", () => {
  it("le voci al singolare e al plurale; in uso se c'è almeno una voce", () => {
    expect(usoDelDeposito(dep())).toEqual([]);
    expect(depositoInUso(dep())).toBe(false);
    const usato = dep({ conducenti: 1, cambiProgrammati: 2, gruppiTurni: 1, utenti: 3 });
    expect(usoDelDeposito(usato)).toEqual(["1 conducente", "2 cambi programmati", "1 gruppo turni", "3 utenti"]);
    expect(depositoInUso(usato)).toBe(true);
  });
  it("il gruppo e i periodi dei turni, a parole", () => {
    expect(nomeGruppo("A")).toBe("Fermo la domenica e nei festivi");
    expect(nomeGruppo("B")).toBe("In servizio anche la domenica");
    expect(nomeCadenza("settimanale")).toBe("Ogni settimana");
    expect([gruppoInBreve("A"), gruppoInBreve("B")]).toEqual(["Fermo", "In servizio"]);
    expect([cadenzaInBreve("semimensile"), cadenzaInBreve("settimanale")]).toEqual(["Due al mese", "Ogni settimana"]);
  });
});
