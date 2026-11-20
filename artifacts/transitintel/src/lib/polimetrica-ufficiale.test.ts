import { describe, it, expect } from "vitest";
import {
  conDecisioni, conteggi, decisioniDalleProposte, filtrate, senzaCorrispondenza, statoDellaLinea, testoProposta, vociPerLinea,
  type LineaAzienda, type LineaUfficiale,
} from "./polimetrica-ufficiale";

const linea = (l: Partial<LineaUfficiale> & { linea: string }): LineaUfficiale => ({
  percorsi: 2, punti: 9, da: "Borgo Alto", a: "Molino", righe: 30, forzate: 0, tariffari: ["EXT"],
  abbinata: null, esclusa: false, candidate: [], proposta: null, motivo: null, ...l,
});

const LINEE: LineaUfficiale[] = [
  linea({ linea: "D", proposta: "D", motivo: "codice", candidate: [{ linea: "D", trovati: 8 }, { linea: "E", trovati: 5 }] }),
  linea({ linea: "D1", proposta: "D", motivo: "punti", candidate: [{ linea: "D", trovati: 8 }, { linea: "E", trovati: 5 }] }),
  linea({ linea: "900", da: "Fornace", a: "Torre", candidate: [{ linea: "V1", trovati: 4 }, { linea: "E", trovati: 4 }] }),
  linea({ linea: "V5", abbinata: "V1", proposta: "V1", motivo: "punti", candidate: [{ linea: "V1", trovati: 9 }] }),
  linea({ linea: "SPEC", punti: 0, esclusa: true }),
];
const AZIENDA: LineaAzienda[] = [{ codice: "D", nome: "Borgo - Città" }, { codice: "E", nome: "Est" }, { codice: "K", nome: "Costa" }, { codice: "V1", nome: "Valle" }];

describe("lo stato di una linea della bigliettazione", () => {
  it("esclusa, abbinata, o da abbinare", () => {
    expect(LINEE.map(statoDellaLinea)).toEqual(["da_abbinare", "da_abbinare", "da_abbinare", "abbinata", "esclusa"]);
  });

  it("i conteggi: per stato, e quante da abbinare hanno una proposta", () => {
    expect(conteggi(LINEE)).toEqual({ tutte: 5, da_abbinare: 3, abbinata: 1, esclusa: 1, proposte: 2 });
    expect(conteggi([])).toEqual({ tutte: 0, da_abbinare: 0, abbinata: 0, esclusa: 0, proposte: 0 });
  });

  it("il filtro per stato, e la ricerca su codice, capolinea e linea abbinata", () => {
    expect(filtrate(LINEE, "da_abbinare", "").map((l) => l.linea)).toEqual(["D", "D1", "900"]);
    expect(filtrate(LINEE, "tutte", "torre").map((l) => l.linea)).toEqual(["900"]);
    expect(filtrate(LINEE, "tutte", " v1 ").map((l) => l.linea)).toEqual(["V5"]);
    expect(filtrate(LINEE, "esclusa", "d")).toEqual([]);
  });
});

describe("le proposte", () => {
  it("dice perché una linea è proposta", () => {
    expect(LINEE.map(testoProposta)).toEqual(["stesso codice", "8 punti su 9", "", "9 punti su 9", ""]);
  });

  it("accettarle tutte tocca solo le linee ancora da abbinare", () => {
    expect(decisioniDalleProposte(LINEE)).toEqual([
      { lineaUfficiale: "D", linea: "D", esclusa: false },
      { lineaUfficiale: "D1", linea: "D", esclusa: false },
    ]);
  });
});

describe("la tendina di una linea", () => {
  it("prima le linee dove si ritrovano i punti, con quanti; poi le altre", () => {
    expect(vociPerLinea(LINEE[2]!, AZIENDA)).toEqual([
      { codice: "V1", etichetta: "V1 · Valle · 4 punti su 9", candidata: true },
      { codice: "E", etichetta: "E · Est · 4 punti su 9", candidata: true },
      { codice: "D", etichetta: "D · Borgo - Città", candidata: false },
      { codice: "K", etichetta: "K · Costa", candidata: false },
    ]);
  });

  it("la linea con lo stesso codice è in testa anche se nessun punto si ritrova", () => {
    const voci = vociPerLinea(linea({ linea: "K", proposta: "K", motivo: "codice" }), AZIENDA);
    expect(voci[0]).toEqual({ codice: "K", etichetta: "K · Costa · stesso codice", candidata: true });
    expect(voci.map((v) => v.codice)).toEqual(["K", "D", "E", "V1"]);
  });

  it("una linea abbinata che in questo import non c'è resta fra le voci; una candidata che non c'è no", () => {
    const voci = vociPerLinea(linea({ linea: "Z", abbinata: "VECCHIA", candidate: [{ linea: "SPARITA", trovati: 3 }] }), AZIENDA);
    expect(voci[0]).toEqual({ codice: "VECCHIA", etichetta: "VECCHIA · non è in questo import", candidata: false });
    expect(voci.map((v) => v.codice)).toEqual(["VECCHIA", "D", "E", "K", "V1"]);
  });
});

describe("dopo una decisione", () => {
  it("le linee cambiano stato senza aspettare l'API", () => {
    const dopo = conDecisioni(LINEE, [
      { lineaUfficiale: "D", linea: "D", esclusa: false },
      { lineaUfficiale: "900", linea: null, esclusa: true },
      { lineaUfficiale: "V5", linea: null, esclusa: false },
    ]);
    expect(dopo.map((l) => [l.linea, statoDellaLinea(l), l.abbinata])).toEqual([
      ["D", "abbinata", "D"], ["D1", "da_abbinare", null], ["900", "esclusa", null], ["V5", "da_abbinare", null], ["SPEC", "esclusa", null],
    ]);
  });

  it("le linee dell'import senza una linea della bigliettazione: quelle da creare là", () => {
    expect(senzaCorrispondenza(LINEE, AZIENDA).map((x) => x.codice)).toEqual(["D", "E", "K"]);
    expect(senzaCorrispondenza(conDecisioni(LINEE, decisioniDalleProposte(LINEE)), AZIENDA).map((x) => x.codice)).toEqual(["E", "K"]);
  });
});
