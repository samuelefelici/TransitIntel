/**
 * La transcodifica fra matricola SIRI e codice FlashNet, e la lettura delle
 * descrizioni del parco. I casi con matricola vera sono quelli visti nel
 * feed: ogni prefisso in AZIENDE_SIRI è stato confermato così.
 */
import { describe, it, expect } from "vitest";
import {
  codiceDaSiri, siriDaCodice, aziendaDaSiri, etichettaAzienda, schedaVettura,
  identitaVettura, interpretaDescrizione, anagraficaParco, AZIENDE_SIRI, SIGLE_SENZA_PREFISSO,
} from "../lib/parco-anagrafica";

describe("da matricola SIRI a codice FlashNet", () => {
  it("le Conerobus sono la matricola così com'è", () => {
    expect(codiceDaSiri("263")).toBe("263");
    expect(codiceDaSiri("1372")).toBe("1372");
    expect(codiceDaSiri("10")).toBe("10");
    expect(aziendaDaSiri("1372")).toBe("Conerobus");
  });

  it("le consorziate: due cifre di azienda più il progressivo", () => {
    expect(codiceDaSiri("11096")).toBe("CJ096");
    expect(codiceDaSiri("10003")).toBe("SA003");
    expect(codiceDaSiri("13163")).toBe("RE163");
    expect(aziendaDaSiri("13155")).toBe("RE");
  });

  it("un prefisso non confermato non viene attribuito a caso", () => {
    expect(codiceDaSiri("12001")).toBeNull();
    expect(aziendaDaSiri("12001")).toBeNull();
    expect(etichettaAzienda("12001")).toBe("consorziata, prefisso 12");
    expect(etichettaAzienda("CJ096")).toBe("matricola non riconosciuta");
  });

  it("la transcodifica torna indietro", () => {
    expect(siriDaCodice("CJ096")).toBe("11096");
    expect(siriDaCodice("sa015")).toBe("10015");
    expect(siriDaCodice("263")).toBe("263");
    expect(siriDaCodice("BU002")).toBeNull();
    for (const [prefisso, sigla] of Object.entries(AZIENDE_SIRI)) {
      expect(siriDaCodice(sigla + "001")).toBe(prefisso + "001");
    }
  });
});

describe("l'anagrafica FlashNet", () => {
  it("ha tutte le righe dell'export e ogni sigla è nota o dichiarata in attesa", () => {
    const voci = anagraficaParco();
    expect(voci.length).toBeGreaterThan(340);
    const sigle = new Set(voci.map(v => v.codice.match(/^[A-Z]+/)?.[0]).filter(Boolean));
    for (const s of sigle) {
      expect(Object.values(AZIENDE_SIRI).includes(s!) || SIGLE_SENZA_PREFISSO.includes(s!), s).toBe(true);
    }
  });

  it("la scheda di una vettura Conerobus e di una consorziata", () => {
    expect(schedaVettura("1372")).toMatchObject({
      codice: "1372", azienda: "Conerobus", descrizione: "X30p - Interurbano 29+1 posti",
      ambito: "interurbano", classe: null, modello: null,
    });
    expect(schedaVettura("11096")).toMatchObject({
      codice: "CJ096", azienda: "CJ", ambito: "interurbano", classe: "11–15 m", modello: "Iveco Crossway",
    });
    expect(schedaVettura("10003")?.modello).toBe("Setra S 418 LE");
  });

  it("una matricola fuori anagrafica non ha scheda, ma ha un'identità", () => {
    expect(schedaVettura("9999")).toBeNull();
    expect(identitaVettura("9999")).toEqual({ codice: "9999", azienda: "Conerobus", mezzo: null });
    expect(identitaVettura("12001")).toEqual({ codice: null, azienda: "consorziata, prefisso 12", mezzo: null });
  });
});

describe("la lettura delle descrizioni", () => {
  it("ambito, classe e modello nelle tre forme dell'export", () => {
    expect(interpretaDescrizione("Urbano =11<15m Irisbus Citelis 12M PS09D1/B/100"))
      .toEqual({ ambito: "urbano", classe: "11–15 m", modello: "Irisbus Citelis 12M PS09D1/B/100" });
    expect(interpretaDescrizione("Interurbano =11<15m - De Simon IL1E12 Scania"))
      .toEqual({ ambito: "interurbano", classe: "11–15 m", modello: "De Simon IL1E12 Scania" });
    expect(interpretaDescrizione("Urbano Snodato 18m - Solaris Trollino T18AC"))
      .toEqual({ ambito: "urbano", classe: "18 m snodato", modello: "Solaris Trollino T18AC" });
    expect(interpretaDescrizione("Urbano snodato 18M Irisbus 491 E18.31 CNG").classe).toBe("18 m snodato");
    expect(interpretaDescrizione("Urbano <7,5m Fiat Ducato City 21A").classe).toBe("<7,5 m");
    expect(interpretaDescrizione("10m - Urbano normale (=9<11mt)"))
      .toEqual({ ambito: "urbano", classe: "9–11 m", modello: null });
    expect(interpretaDescrizione("E4 - Interurbano corto (<7,5mt)"))
      .toEqual({ ambito: "interurbano", classe: "<7,5 m", modello: null });
    expect(interpretaDescrizione("IVECO Crossway"))
      .toEqual({ ambito: null, classe: null, modello: "IVECO Crossway" });
  });

  it("ogni descrizione dell'export si legge senza eccezioni e l'ambito manca solo dove non c'è", () => {
    const senzaAmbito = anagraficaParco().filter(v => interpretaDescrizione(v.descrizione).ambito == null);
    expect(senzaAmbito.every(v => v.descrizione === "IVECO Crossway")).toBe(true);
    expect(senzaAmbito.length).toBe(11);
  });
});
