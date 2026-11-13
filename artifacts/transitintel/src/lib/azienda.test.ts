import { describe, expect, it } from "vitest";
import {
  AZIENDA_DA_COMPILARE, aziendaValida, datiDaSalvare, erroriDelModulo, intestazioneDocumenti, luogoDellAzienda,
  moduloCambiato, moduloDa, vistaIniziale, type Azienda,
} from "./azienda";

const CONEROBUS: Azienda = {
  ragioneSociale: "Conerobus S.p.A.", nome: "Conerobus", sito: "https://www.conerobus.it", telefono: "+39 071 2837411",
  gtfsAgencyId: "conerobus", citta: "Ancona", regione: "Marche", centro: { lat: 43.58, lng: 13.45, zoom: 10 }, compilata: true,
};

describe("aziendaValida", () => {
  it("tiene quello che arriva dal server", () => {
    expect(aziendaValida(CONEROBUS)).toEqual(CONEROBUS);
    expect(aziendaValida({ ...CONEROBUS, sito: "", regione: null })).toMatchObject({ sito: null, regione: null, nome: "Conerobus" });
  });

  it("senza un pezzo che serve valgono i valori neutri, mai una mappa nel vuoto", () => {
    for (const rotto of [null, undefined, "x", 3, {}, { ...CONEROBUS, nome: "" }, { ...CONEROBUS, centro: null },
      { ...CONEROBUS, centro: { lat: "43", lng: 13, zoom: 10 } }, { ...CONEROBUS, centro: { lat: 430, lng: 13, zoom: 10 } },
      { ...CONEROBUS, centro: { lat: 43, lng: 13, zoom: NaN } }]) {
      expect(aziendaValida(rotto), JSON.stringify(rotto)).toBe(AZIENDA_DA_COMPILARE);
    }
  });

  it("i valori neutri non hanno il nome di nessuna azienda", () => {
    expect(JSON.stringify(AZIENDA_DA_COMPILARE).toLowerCase()).not.toMatch(/conerobus|ancona/);
    expect(AZIENDA_DA_COMPILARE.compilata).toBe(false);
  });
});

describe("le etichette e le mappe", () => {
  it("il luogo: città e regione, solo la città, o niente", () => {
    expect(luogoDellAzienda(CONEROBUS)).toBe("Ancona / Marche");
    expect(luogoDellAzienda({ citta: "Pesaro", regione: null })).toBe("Pesaro");
    expect(luogoDellAzienda(AZIENDA_DA_COMPILARE)).toBeNull();
  });

  it("la vista iniziale delle mappe di rete è il centro dell'azienda", () => {
    expect(vistaIniziale(CONEROBUS)).toEqual({ longitude: 13.45, latitude: 43.58, zoom: 10 });
  });

  it("l'intestazione dei documenti porta il nome solo se l'azienda è compilata", () => {
    expect(intestazioneDocumenti(CONEROBUS)).toBe("Conerobus · Trasporto Pubblico Locale");
    expect(intestazioneDocumenti(AZIENDA_DA_COMPILARE)).toBe("Trasporto Pubblico Locale");
  });
});

describe("il modulo dell'amministratore", () => {
  it("parte dai valori salvati; da compilare, con i nomi vuoti e il centro neutro", () => {
    expect(moduloDa(CONEROBUS)).toEqual({
      ragioneSociale: "Conerobus S.p.A.", nome: "Conerobus", sito: "https://www.conerobus.it", telefono: "+39 071 2837411",
      gtfsAgencyId: "conerobus", citta: "Ancona", regione: "Marche", centroLat: "43.58", centroLng: "13.45", zoom: "10",
    });
    expect(moduloDa(AZIENDA_DA_COMPILARE)).toMatchObject({ ragioneSociale: "", nome: "", gtfsAgencyId: "", citta: "", centroLat: "42.5", zoom: "5.5" });
  });

  it("un modulo buono non ha errori, e si spedisce con i numeri veri e i facoltativi a null", () => {
    const m = { ...moduloDa(CONEROBUS), sito: "  ", telefono: "", regione: " ", centroLat: "43,6", zoom: " 11 " };
    expect(erroriDelModulo(m)).toEqual({});
    expect(datiDaSalvare(m)).toEqual({
      ragioneSociale: "Conerobus S.p.A.", nome: "Conerobus", sito: null, telefono: null, gtfsAgencyId: "conerobus",
      citta: "Ancona", regione: null, centroLat: 43.6, centroLng: 13.45, zoom: 11,
    });
  });

  it("dice accanto a quale casella c'è l'errore", () => {
    const buono = moduloDa(CONEROBUS);
    expect(erroriDelModulo(moduloDa(AZIENDA_DA_COMPILARE))).toMatchObject({ ragioneSociale: "Va compilato", nome: "Va compilato", citta: "Va compilato", gtfsAgencyId: expect.any(String) });
    expect(erroriDelModulo({ ...buono, sito: "javascript:alert(1)" })).toEqual({ sito: expect.stringMatching(/http/) });
    expect(erroriDelModulo({ ...buono, sito: "https://a.it,b" })).toHaveProperty("sito");
    expect(erroriDelModulo({ ...buono, telefono: "abc" })).toHaveProperty("telefono");
    expect(erroriDelModulo({ ...buono, gtfsAgencyId: "a b" })).toHaveProperty("gtfsAgencyId");
    expect(erroriDelModulo({ ...buono, nome: "x".repeat(41) })).toEqual({ nome: "Al più 40 caratteri" });
    expect(erroriDelModulo({ ...buono, centroLat: "91" })).toHaveProperty("centroLat");
    expect(erroriDelModulo({ ...buono, centroLng: "" })).toHaveProperty("centroLng");
    expect(erroriDelModulo({ ...buono, zoom: "1e1" })).toHaveProperty("zoom");
    expect(erroriDelModulo({ ...buono, zoom: "19" })).toHaveProperty("zoom");
  });

  it("cambiato o no, senza contare gli spazi ai lati", () => {
    const a = moduloDa(CONEROBUS);
    expect(moduloCambiato(a, { ...a, nome: " Conerobus " })).toBe(false);
    expect(moduloCambiato(a, { ...a, zoom: "11" })).toBe(true);
  });
});
