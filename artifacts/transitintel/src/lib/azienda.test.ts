import { describe, expect, it } from "vitest";
import {
  AZIENDA_DA_COMPILARE, aziendaValida, datiDaSalvare, erroriDelModulo, intestazioneDocumenti, luogoDellAzienda, nomeNeiDocumenti,
  moduloCambiato, moduloDa, vistaIniziale, type Azienda, eDellAzienda, esempioIdNetex, conRiferimento,
  orarioDaMinuti, minutiDaOrario, esempioCodiciTurni, fornitoreAvm, vicinoAlCentro, dintorniDelCentro,
} from "./azienda";

const CONEROBUS: Azienda = {
  ragioneSociale: "Conerobus S.p.A.", nome: "Conerobus", sito: "https://www.conerobus.it", telefono: "+39 071 2837411",
  gtfsAgencyId: "conerobus", citta: "Ancona", regione: "Marche", centro: { lat: 43.58, lng: 13.45, zoom: 10 },
  provinciaIstat: "042", netexCodiceLocale: "ITI3", netexFornitore: null,
  netexPrefisso: "epd", netexPrefissoCodici: "ATMA", netexCodiceRete: "RETE_TPL_ATMA",
  tariffeRiferimento: "DGR Marche n. 1036/2022, art. 2.d", turniGuidaPomeriggioDa: 720, avmFornitore: "Mizar", avmMatricolaCifre: 4, compilata: true,
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

describe("il fornitore dell'AVM nei testi (tappa 6.27)", () => {
  it("col nome: il nome in tutte le forme; senza: «il fornitore dell'AVM»", () => {
    expect(fornitoreAvm(CONEROBUS)).toEqual({ breve: "Mizar", nome: "Mizar", Nome: "Mizar", a: "a Mizar", di: "di Mizar", da: "da Mizar" });
    expect(fornitoreAvm(AZIENDA_DA_COMPILARE)).toEqual({
      breve: "AVM", nome: "il fornitore dell'AVM", Nome: "Il fornitore dell'AVM",
      a: "al fornitore dell'AVM", di: "del fornitore dell'AVM", da: "dal fornitore dell'AVM",
    });
    expect(fornitoreAvm({ avmFornitore: "  " }).breve).toBe("AVM");
  });

  it("dal server una riga di al più 40 caratteri; nel modulo è facoltativo", () => {
    expect(aziendaValida({ ...CONEROBUS, avmFornitore: "x".repeat(41) }).avmFornitore).toBeNull();
    const m = moduloDa(CONEROBUS);
    expect(datiDaSalvare({ ...m, avmFornitore: " " }).avmFornitore).toBeNull();
    expect(erroriDelModulo({ ...m, avmFornitore: "x".repeat(41) })).toEqual({ avmFornitore: "Al più 40 caratteri" });
  });
});

describe("i codici dei turni guida (tappa 6.25)", () => {
  it("l'inizio del pomeriggio si scrive come orario e si salva in minuti", () => {
    expect(orarioDaMinuti(720)).toBe("12:00");
    expect(orarioDaMinuti(845)).toBe("14:05");
    expect(minutiDaOrario("12:00")).toBe(720);
    expect(minutiDaOrario(" 9.30 ")).toBe(570);
    for (const no of ["24:00", "12:60", "00:00", "mezzogiorno", "12"]) expect(minutiDaOrario(no), no).toBeNull();
    const m = moduloDa(CONEROBUS);
    expect(datiDaSalvare({ ...m, turniGuidaPomeriggioDa: "13:30" }).turniGuidaPomeriggioDa).toBe(810);
    expect(datiDaSalvare({ ...m, turniGuidaPomeriggioDa: " " }).turniGuidaPomeriggioDa).toBeNull();
    expect(erroriDelModulo({ ...m, turniGuidaPomeriggioDa: "25:00" })).toEqual({ turniGuidaPomeriggioDa: "Un orario fra 00:01 e 23:59, come 12:00" });
    expect(aziendaValida({ ...CONEROBUS, turniGuidaPomeriggioDa: 1440 }).turniGuidaPomeriggioDa).toBeNull();
  });

  it("l'esempio accanto alla casella", () => {
    expect(esempioCodiciTurni("12:00")).toBe("A001… al mattino, A100… dalle 12:00");
    expect(esempioCodiciTurni("")).toBe("A001, A002… in ordine di inizio");
    expect(esempioCodiciTurni("no")).toBe("");
  });
});

describe("il riferimento della regola regionale delle tariffe (tappa 6.24)", () => {
  it("si scrive dopo il testo del calcolo, se l'azienda l'ha scritto", () => {
    expect(conRiferimento(CONEROBUS)).toBe(" — DGR Marche n. 1036/2022, art. 2.d");
    expect(conRiferimento(AZIENDA_DA_COMPILARE)).toBe("");
  });

  it("dal server arriva una riga di testo di al più 200 caratteri, altrimenti niente", () => {
    expect(aziendaValida({ ...CONEROBUS, tariffeRiferimento: "  DGR 1/2020  " }).tariffeRiferimento).toBe("DGR 1/2020");
    expect(aziendaValida({ ...CONEROBUS, tariffeRiferimento: "x".repeat(201) }).tariffeRiferimento).toBeNull();
    expect(aziendaValida({ ...CONEROBUS, tariffeRiferimento: "DGR\n1" }).tariffeRiferimento).toBeNull();
    expect(aziendaValida({ ...CONEROBUS, tariffeRiferimento: 3 }).tariffeRiferimento).toBeNull();
  });

  it("nel modulo è facoltativo: vuoto si salva come null, troppo lungo si dice accanto alla casella", () => {
    const m = moduloDa(CONEROBUS);
    expect(datiDaSalvare({ ...m, tariffeRiferimento: "  " }).tariffeRiferimento).toBeNull();
    expect(erroriDelModulo({ ...m, tariffeRiferimento: "x".repeat(201) })).toEqual({ tariffeRiferimento: "Al più 200 caratteri" });
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

  it("le ricerche di indirizzi partono dal centro dell'azienda (tappa 6.22)", () => {
    expect(vicinoAlCentro(CONEROBUS)).toBe("13.4500,43.5800");
    /* 80 km per parte: in latitudine 0,72 gradi, in longitudine di più, perché a 43° un grado è più corto */
    expect(dintorniDelCentro(CONEROBUS)).toBe("12.46,42.86,14.44,44.30");
    expect(dintorniDelCentro({ centro: { lat: 46.5, lng: 11.35, zoom: 10 } }, 20)).toBe("11.09,46.32,11.61,46.68");
    /* un'installazione da compilare cerca attorno al centro d'Italia */
    expect(dintorniDelCentro(AZIENDA_DA_COMPILARE)).toBe("11.53,41.78,13.47,43.22");
    /* vicino al polo il riquadro resta dentro i limiti */
    expect(dintorniDelCentro({ centro: { lat: 89.9, lng: 0, zoom: 3 } })).toBe("-71.86,89.18,71.86,90.00");
  });

  it("l'intestazione dei documenti porta il nome solo se l'azienda è compilata", () => {
    expect(intestazioneDocumenti(CONEROBUS)).toBe("Conerobus · Trasporto Pubblico Locale");
    expect(intestazioneDocumenti(AZIENDA_DA_COMPILARE)).toBe("Trasporto Pubblico Locale");
  });

  it("il nome corto sulle stampe è quello dell'azienda; da compilare, nessun nome", () => {
    expect(nomeNeiDocumenti(CONEROBUS)).toBe("Conerobus");
    expect(nomeNeiDocumenti(AZIENDA_DA_COMPILARE)).toBe("Trasporto Pubblico Locale");
  });
});

describe("il modulo dell'amministratore", () => {
  it("parte dai valori salvati; da compilare, con i nomi vuoti e il centro neutro", () => {
    expect(moduloDa(CONEROBUS)).toEqual({
      ragioneSociale: "Conerobus S.p.A.", nome: "Conerobus", sito: "https://www.conerobus.it", telefono: "+39 071 2837411",
      gtfsAgencyId: "conerobus", citta: "Ancona", regione: "Marche", centroLat: "43.58", centroLng: "13.45", zoom: "10",
      provinciaIstat: "042", netexCodiceLocale: "ITI3", netexFornitore: "",
      netexPrefisso: "epd", netexPrefissoCodici: "ATMA", netexCodiceRete: "RETE_TPL_ATMA",
      tariffeRiferimento: "DGR Marche n. 1036/2022, art. 2.d", turniGuidaPomeriggioDa: "12:00", avmFornitore: "Mizar", avmMatricolaCifre: "4",
    });
    expect(moduloDa(AZIENDA_DA_COMPILARE)).toMatchObject({ ragioneSociale: "", nome: "", gtfsAgencyId: "", citta: "", centroLat: "42.5", zoom: "5.5" });
  });

  it("un modulo buono non ha errori, e si spedisce con i numeri veri e i facoltativi a null", () => {
    const m = { ...moduloDa(CONEROBUS), sito: "  ", telefono: "", regione: " ", centroLat: "43,6", zoom: " 11 " };
    expect(erroriDelModulo(m)).toEqual({});
    expect(datiDaSalvare(m)).toEqual({
      ragioneSociale: "Conerobus S.p.A.", nome: "Conerobus", sito: null, telefono: null, gtfsAgencyId: "conerobus",
      citta: "Ancona", regione: null, centroLat: 43.6, centroLng: 13.45, zoom: 11, provinciaIstat: "042",
      netexCodiceLocale: "ITI3", netexFornitore: null,
      netexPrefisso: "epd", netexPrefissoCodici: "ATMA", netexCodiceRete: "RETE_TPL_ATMA",
      tariffeRiferimento: "DGR Marche n. 1036/2022, art. 2.d", turniGuidaPomeriggioDa: 720, avmFornitore: "Mizar", avmMatricolaCifre: 4,
    });
    expect(erroriDelModulo({ ...m, netexCodiceLocale: "iti3" })).toEqual({ netexCodiceLocale: "Un codice NUTS in maiuscolo, come ITI3" });
    expect(erroriDelModulo({ ...m, netexFornitore: "A T" })).toEqual({ netexFornitore: "Lettere, cifre, - e _ (al più 40)" });
    // gli identificativi come quelli della Regione (tappa 6.19c): niente «:», spazi o «/» nei pezzi
    expect(erroriDelModulo({ ...m, netexPrefisso: "ep:d", netexPrefissoCodici: "AT MA", netexCodiceRete: "RETE/TPL" })).toEqual({
      netexPrefisso: "Una lettera e poi lettere o cifre (al più 10), come epd",
      netexPrefissoCodici: "Lettere, cifre e - (al più 20), come ABC",
      netexCodiceRete: "Lettere, cifre, - e _ (al più 40)",
    });
    expect(datiDaSalvare({ ...m, netexPrefisso: " ", netexPrefissoCodici: "", netexCodiceRete: " " }))
      .toMatchObject({ netexPrefisso: null, netexPrefissoCodici: null, netexCodiceRete: null });
    expect(aziendaValida({ ...CONEROBUS, netexPrefisso: "e:p", netexPrefissoCodici: "A B", netexCodiceRete: "R/T" }))
      .toMatchObject({ netexPrefisso: null, netexPrefissoCodici: null, netexCodiceRete: null });
    // la provincia è facoltativa, ma se c'è sono tre cifre
    expect(datiDaSalvare({ ...m, provinciaIstat: " " }).provinciaIstat).toBeNull();
    expect(erroriDelModulo({ ...m, provinciaIstat: "42" })).toEqual({ provinciaIstat: "Tre cifre, come 042" });
    expect(aziendaValida({ ...CONEROBUS, provinciaIstat: "4x2" }).provinciaIstat).toBeNull();
    // le cifre della matricola nell'AVM: facoltative (vuoto = tutte le vetture sono dell'azienda), da 1 a 9
    expect(datiDaSalvare({ ...m, avmMatricolaCifre: " " }).avmMatricolaCifre).toBeNull();
    for (const v of ["0", "10", "4,5", "quattro"]) {
      expect(erroriDelModulo({ ...m, avmMatricolaCifre: v }), v).toEqual({ avmMatricolaCifre: "Un numero da 1 a 9, oppure vuoto" });
    }
    for (const v of [0, 10, 4.5, "4", null, undefined]) expect(aziendaValida({ ...CONEROBUS, avmMatricolaCifre: v as any }).avmMatricolaCifre, String(v)).toBeNull();
    expect(moduloDa({ ...CONEROBUS, avmMatricolaCifre: null }).avmMatricolaCifre).toBe("");
  });

  it("le vetture dell'azienda nel canale dell'AVM: la stessa regola dell'API, dallo stesso dato", () => {
    for (const ref of ["5", "305", "1372", " 305 "]) expect(eDellAzienda(ref, 4), ref).toBe(true);
    for (const ref of ["11096", "AB12", "30S", "", null, undefined]) expect(eDellAzienda(ref, 4), String(ref)).toBe(false);
    expect(eDellAzienda("110960", 6)).toBe(true);
    // senza cifre non ci sono consorziate: tutte le vetture sono dell'azienda
    for (const ref of ["305", "11096", "AB12", ""]) expect(eDellAzienda(ref, null), ref).toBe(true);
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

describe("l'anteprima dell'identificativo NeTEx (tappa 6.19c)", () => {
  it("come nei file della Regione, e senza i pezzi facoltativi", () => {
    const m = moduloDa(CONEROBUS);
    expect(esempioIdNetex(m)).toBe("epd:IT:ITI3:Line:ATMA_1/3");
    expect(esempioIdNetex({ ...m, netexFornitore: "RM" })).toBe("epd:IT:ITI3:Line:ATMA_1/3:RM");
    expect(esempioIdNetex({ ...m, netexPrefisso: "", netexPrefissoCodici: "" })).toBe("IT:ITI3:Line:1/3");
    expect(esempioIdNetex({ ...m, netexCodiceLocale: " " })).toBeNull();
  });
});
