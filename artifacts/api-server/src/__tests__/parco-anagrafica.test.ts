/**
 * La transcodifica fra matricola SIRI e codice FlashNet, e la lettura delle
 * descrizioni del parco. I casi con matricola vera sono quelli visti nel
 * feed: ogni prefisso in AZIENDE_SIRI è stato confermato così.
 */
import { describe, it, expect } from "vitest";
import {
  codiceDaSiri, siriDaCodice, aziendaDaSiri, etichettaAzienda, schedaVettura,
  identitaVettura, interpretaDescrizione, anagraficaParco, impostaParco, parcoInVigore, PARCO_NEUTRO,
} from "../lib/parco-anagrafica";
import { impostaRegolaVetture } from "../lib/vetture-azienda";
import { PARCO_DI_PRIMA } from "./helpers/parco-di-prima";

/* i test provano un'azienda col suo canale AVM condiviso con le consorziate: la regola è un dato
 * dell'azienda (tappa 6.5, lib/vetture-azienda.ts), e qui la si dichiara */
impostaRegolaVetture({ cifre: 4, nome: "Conerobus" });
/* e i prefissi, le eccezioni e l'anagrafica sono dati dell'azienda (tappa 6.21): quelli che erano nel codice */
impostaParco(PARCO_DI_PRIMA);

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
    expect(codiceDaSiri("12002")).toBe("BU002");
    expect(aziendaDaSiri("13155")).toBe("RE");
    expect(aziendaDaSiri("12046")).toBe("BU");
  });

  it("il prefisso 10 vale per SA e per BV: decide l'anagrafica", () => {
    expect(codiceDaSiri("10016")).toBe("SA016");
    expect(codiceDaSiri("10031")).toBe("BV031");
    expect(codiceDaSiri("10040")).toBe("BV040");
    expect(aziendaDaSiri("10034")).toBe("BV");
    /* un progressivo che non è né SA né BV non si attribuisce */
    expect(codiceDaSiri("10099")).toBeNull();
    expect(etichettaAzienda("10099")).toBe("SA/BV");
  });

  it("il prefisso 15 si abbina solo con la tabella, il progressivo non c'entra", () => {
    expect(codiceDaSiri("15004")).toBe("SAP052");
    expect(codiceDaSiri("15005")).toBe("SAP051");
    expect(codiceDaSiri("15007")).toBe("SAP053");
    expect(aziendaDaSiri("15004")).toBe("SAP");
    /* le tre mai collegate restano senza codice, con le sigle possibili */
    expect(codiceDaSiri("15001")).toBeNull();
    expect(etichettaAzienda("15001")).toBe("AF/SAP");
  });

  it("un prefisso sconosciuto non viene attribuito a caso", () => {
    expect(codiceDaSiri("14001")).toBeNull();
    expect(aziendaDaSiri("14001")).toBeNull();
    expect(etichettaAzienda("14001")).toBe("consorziata, prefisso 14");
    expect(etichettaAzienda("CJ096")).toBe("matricola non riconosciuta");
  });

  it("la transcodifica torna indietro", () => {
    expect(siriDaCodice("CJ096")).toBe("11096");
    expect(siriDaCodice("sa015")).toBe("10015");
    expect(siriDaCodice("BV023")).toBe("10023");
    expect(siriDaCodice("BU002")).toBe("12002");
    expect(siriDaCodice("SAP052")).toBe("15004");
    expect(siriDaCodice("AF002")).toBeNull();
    expect(siriDaCodice("263")).toBe("263");
    for (const { siriRef: siri, codice } of parcoInVigore().eccezioni) {
      expect(siriDaCodice(codice)).toBe(siri);
      expect(codiceDaSiri(siri)).toBe(codice);
    }
  });
});

describe("l'anagrafica FlashNet", () => {
  it("ha tutte le righe dell'export e ogni sigla ha un prefisso SIRI", () => {
    const voci = anagraficaParco();
    expect(voci.length).toBeGreaterThan(340);
    const sigle = new Set(voci.map(v => v.codice.match(/^[A-Z]+/)?.[0]).filter(Boolean));
    const note = new Set(parcoInVigore().consorziate.flatMap(c => c.sigle));
    for (const s of sigle) expect(note.has(s!), s).toBe(true);
  });

  it("ogni codice SA, BV, CJ, BU, RE dell'export fa andata e ritorno", () => {
    for (const v of anagraficaParco()) {
      if (!/^(SA|BV|CJ|BU|RE)\d{3}$/.test(v.codice)) continue;
      const siri = siriDaCodice(v.codice);
      expect(siri, v.codice).not.toBeNull();
      expect(codiceDaSiri(siri!), v.codice).toBe(v.codice);
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
    expect(identitaVettura("14001")).toEqual({ codice: null, azienda: "consorziata, prefisso 14", mezzo: null });
    expect(identitaVettura("10031")).toEqual({ codice: "BV031", azienda: "BV", mezzo: "Interurbano =11<15m Setra S 415 UL" });
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

/* ── Tappa 6.21: i dati dell'azienda, non più il codice ───────────────────── */

describe("senza i dati dell'azienda", () => {
  it("nessuna consorziata e nessuna descrizione: le matricole lunghe non si attribuiscono", () => {
    impostaParco(PARCO_NEUTRO);
    try {
      expect(codiceDaSiri("11096")).toBeNull();
      expect(aziendaDaSiri("11096")).toBeNull();
      expect(etichettaAzienda("11096")).toBe("consorziata, prefisso 11");
      expect(schedaVettura("1372")).toBeNull();
      expect(identitaVettura("1372")).toEqual({ codice: "1372", azienda: "Conerobus", mezzo: null });
      expect(anagraficaParco()).toEqual([]);
    } finally {
      impostaParco(PARCO_DI_PRIMA);
    }
  });

  it("un'altra azienda con le sue regole: un prefisso, un'eccezione, la sua anagrafica", () => {
    impostaParco({
      consorziate: [{ prefisso: "21", sigle: ["XY"], aProgressivo: true }],
      eccezioni: [{ siriRef: "21999", codice: "XY001", nota: "" }],
      vetture: [{ codice: "XY007", descrizione: "Urbano =9<11m Esempio" }, { codice: "XY001", descrizione: "Interurbano <7,5m Altro" }],
    });
    try {
      expect(codiceDaSiri("21007")).toBe("XY007");
      expect(codiceDaSiri("21999")).toBe("XY001");
      expect(siriDaCodice("XY007")).toBe("21007");
      expect(siriDaCodice("XY001")).toBe("21999");
      expect(codiceDaSiri("11096")).toBeNull();
      expect(schedaVettura("21007")).toMatchObject({ codice: "XY007", azienda: "XY", ambito: "urbano", classe: "9–11 m" });
    } finally {
      impostaParco(PARCO_DI_PRIMA);
    }
  });
});
