import { describe, expect, it } from "vitest";
import { datiDaSalvare, erroriConsorziate, esempioDellaRegola, moduloCambiato, moduloDa, sigleDa } from "./parco";

const STATO = {
  consorziate: [
    { prefisso: "10", sigle: ["SA", "BV"], aProgressivo: true },
    { prefisso: "15", sigle: ["AF", "SAP"], aProgressivo: false },
  ],
  eccezioni: [{ siriRef: "15004", codice: "SAP052", nota: "confronto del 6/10" }],
};

describe("il modulo dei prefissi e delle eccezioni", () => {
  it("parte dai valori salvati e torna uguale", () => {
    const m = moduloDa(STATO);
    expect(m.consorziate[0]).toEqual({ prefisso: "10", sigle: "SA, BV", aProgressivo: true });
    expect(erroriConsorziate(m)).toEqual([]);
    expect(datiDaSalvare(m)).toEqual(STATO);
    expect(moduloCambiato(m, moduloDa(STATO))).toBe(false);
  });

  it("le sigle si scrivono come si vuole: virgole o spazi, maiuscole o no", () => {
    expect(sigleDa(" sa,bv  BV / re")).toEqual(["SA", "BV", "RE"]);
    expect(sigleDa("")).toEqual([]);
  });

  it("dice che cosa non va, con la riga", () => {
    const m = moduloDa(STATO);
    m.consorziate.push({ prefisso: "10", sigle: "SA", aProgressivo: true }, { prefisso: "1", sigle: "", aProgressivo: true }, { prefisso: "12", sigle: "B2", aProgressivo: true });
    m.eccezioni.push({ siriRef: "15004", codice: "x y", nota: "" }, { siriRef: "abc", codice: "AF006", nota: "n".repeat(301) });
    expect(erroriConsorziate(m)).toEqual([
      "Prefissi, riga 3: il prefisso 10 c'è due volte",
      "Prefissi, riga 4: il prefisso sono due cifre, come «11»",
      "Prefissi, riga 4: almeno una sigla, come «CJ»",
      "Prefissi, riga 5: la sigla «B2» non va (da 1 a 5 lettere)",
      "Eccezioni, riga 2: la matricola 15004 c'è due volte",
      "Eccezioni, riga 2: il codice del mezzo è fatto di lettere, cifre e . _ -",
      "Eccezioni, riga 3: la matricola SIRI è fatta di cifre",
      "Eccezioni, riga 3: la nota è al più 300 caratteri",
    ]);
  });

  it("una sigla porta a un solo prefisso", () => {
    const m = moduloDa(STATO);
    m.consorziate.push({ prefisso: "11", sigle: "BV", aProgressivo: true });
    expect(erroriConsorziate(m)).toEqual(["Prefissi, riga 3: la sigla BV è già del prefisso 10"]);
  });

  it("le righe vuote non si spediscono; i codici diventano maiuscoli", () => {
    const m = moduloDa(STATO);
    m.consorziate.push({ prefisso: " ", sigle: "", aProgressivo: true });
    m.eccezioni.push({ siriRef: "", codice: "", nota: "" }, { siriRef: " 15006 ", codice: "af006", nota: " da riconfermare " });
    expect(erroriConsorziate({ ...m, consorziate: m.consorziate.slice(0, 2), eccezioni: m.eccezioni.filter((x) => x.siriRef) })).toEqual([]);
    expect(datiDaSalvare(m).consorziate).toHaveLength(2);
    expect(datiDaSalvare(m).eccezioni).toEqual([...STATO.eccezioni, { siriRef: "15006", codice: "AF006", nota: "da riconfermare" }]);
    expect(moduloCambiato(m, moduloDa(STATO))).toBe(true);
  });

  it("la regola in un esempio", () => {
    expect(esempioDellaRegola({ prefisso: "10", sigle: "SA, BV", aProgressivo: true })).toBe("10007 → SA007 o 10007 → BV007");
    expect(esempioDellaRegola({ prefisso: "15", sigle: "AF", aProgressivo: false })).toBe("15… solo con le eccezioni");
    expect(esempioDellaRegola({ prefisso: "1", sigle: "AF", aProgressivo: true })).toBe("");
  });
});
