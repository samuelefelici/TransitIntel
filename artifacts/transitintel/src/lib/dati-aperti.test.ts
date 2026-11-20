import { describe, it, expect } from "vitest";
import { contenuto, dimensione, erroriDelTentativo, indirizzo, quando, riassunto, type StatoFile } from "./dati-aperti";

const inLinea = (extra: Partial<NonNullable<StatoFile["inLinea"]>> = {}) => ({
  impronta: "a".repeat(64), byte: 1_772_091, preparatoIl: "2026-11-17T07:12:00.000Z", inEsercizioDal: "2026-11-13T09:00:00.000Z",
  dellaVersioneInEsercizio: true, conteggi: null, ...extra,
});
const file = (x: Partial<StatoFile>): StatoFile => ({
  tipo: "gtfs", formato: "GTFS", percorso: "/api/dati-aperti/gtfs.zip", inLinea: null, ultimoTentativo: null, ...x,
});

describe("dati aperti: gli indirizzi e le misure", () => {
  it("l'indirizzo intero, senza barre doppie", () => {
    expect(indirizzo("https://cerbero.example/", "/api/dati-aperti/gtfs.zip")).toBe("https://cerbero.example/api/dati-aperti/gtfs.zip");
    expect(indirizzo("https://cerbero.example", "/api/dati-aperti/netex.xml.gz")).toBe("https://cerbero.example/api/dati-aperti/netex.xml.gz");
  });
  it("la dimensione, come la si dice", () => {
    expect(dimensione(512)).toBe("512 byte");
    expect(dimensione(740_400)).toBe("740 kB");
    expect(dimensione(1_772_091)).toBe("1,8 MB");
    expect(dimensione(NaN)).toBe("—");
  });
  it("le date in ora italiana", () => {
    expect(quando("2026-11-17T07:12:00.000Z")).toBe("17/11/2026, 08:12");
    expect(quando(null)).toBe("—");
    expect(quando("boh")).toBe("—");
  });
});

describe("dati aperti: com'è messo un file", () => {
  it("in linea e aggiornato", () => {
    expect(riassunto(file({ inLinea: inLinea(), ultimoTentativo: { esito: "pubblicato", messaggio: null, provatoIl: null, dettagli: null } })))
      .toEqual({ tono: "ok", testo: "In linea" });
  });
  it("in linea, ma è il file di prima: l'ultimo tentativo non è uscito, o la versione è cambiata", () => {
    const nonUscito = file({ inLinea: inLinea(), ultimoTentativo: { esito: "non_valido", messaggio: "x", provatoIl: null, dettagli: null } });
    expect(riassunto(nonUscito).tono).toBe("attenzione");
    const diPrima = file({ inLinea: inLinea({ dellaVersioneInEsercizio: false }), ultimoTentativo: { esito: "pubblicato", messaggio: null, provatoIl: null, dettagli: null } });
    expect(riassunto(diPrima).tono).toBe("attenzione");
  });
  it("niente in linea", () => {
    expect(riassunto(file({}))).toEqual({ tono: "fermo", testo: "Non ancora preparato" });
    expect(riassunto(file({ ultimoTentativo: { esito: "senza_codice", messaggio: "x", provatoIl: null, dettagli: null } })))
      .toEqual({ tono: "fermo", testo: "Niente in linea" });
  });
});

describe("dati aperti: che cosa c'è nel file", () => {
  it("il GTFS: corse, fermate, linee e gli avvisi del controllo", () => {
    const f = file({ inLinea: inLinea({ conteggi: { righe: { "trips.txt": 3502, "stops.txt": 13901, "routes.txt": 128 }, avvisi: 221 } }) });
    // come nel resto dell'app: in italiano le migliaia si separano da cinque cifre in su
    expect(contenuto(f)).toEqual(["3502 corse", "13.901 fermate", "128 linee", "221 avvisi del controllo"]);
  });
  it("il NeTEx: anche le corse lasciate fuori; al singolare quando è una", () => {
    const f = file({ tipo: "netex", inLinea: inLinea({ conteggi: { corse: 1, fermate: 2, linee: 1, corseSenzaGiorni: 1 } }) });
    expect(contenuto(f)).toEqual(["1 corsa", "2 fermate", "1 linea", "1 corsa lasciata fuori (senza giorni di servizio)"]);
  });
  it("il NeTEx di livello 3: anche i titoli e le zone tariffarie (tappa 6.41)", () => {
    const f = file({ tipo: "netex_l3", inLinea: inLinea({ conteggi: { corse: 3502, fermate: 3901, linee: 128, corseSenzaGiorni: 0, tariffe: { prodotti: 161, zone: 881 } } }) });
    expect(contenuto(f)).toEqual(["3502 corse", "3901 fermate", "128 linee", "161 titoli", "881 zone tariffarie"]);
    const uno = file({ tipo: "netex_l3", inLinea: inLinea({ conteggi: { corse: 1, fermate: 2, linee: 1, tariffe: { prodotti: 1, zone: 1 } } }) });
    expect(contenuto(uno)).toEqual(["1 corsa", "2 fermate", "1 linea", "1 titolo", "1 zona tariffaria"]);
  });
  it("i gestori: le agenzie del GTFS e gli operatori del NeTEx, solo se sono più d'uno", () => {
    const gtfs = (agenzie: number) => file({ inLinea: inLinea({ conteggi: { righe: { "trips.txt": 10, "stops.txt": 5, "routes.txt": 2, "agency.txt": agenzie } } }) });
    expect(contenuto(gtfs(1))).toEqual(["10 corse", "5 fermate", "2 linee"]);
    expect(contenuto(gtfs(3))).toEqual(["10 corse", "5 fermate", "2 linee", "3 agenzie"]);
    const netex = (operatori: number) => file({ tipo: "netex", inLinea: inLinea({ conteggi: { corse: 10, fermate: 5, linee: 2, corseSenzaGiorni: 0, operatori } }) });
    expect(contenuto(netex(1))).toEqual(["10 corse", "5 fermate", "2 linee"]);
    expect(contenuto(netex(3))).toEqual(["10 corse", "5 fermate", "2 linee", "3 operatori"]);
  });

  it("il NeTEx: le tratte col tracciato e quelle senza (tappa 6.42)", () => {
    const f = file({ tipo: "netex", inLinea: inLinea({ conteggi: { corse: 3502, fermate: 3901, linee: 128, tratte: 5486, tratteSenzaTracciato: 14 } }) });
    expect(contenuto(f)).toEqual(["3502 corse", "3901 fermate", "128 linee", "5486 tratte col tracciato", "14 tratte senza tracciato (in linea retta)"]);
    const uno = file({ tipo: "netex_l3", inLinea: inLinea({ conteggi: { corse: 1, fermate: 2, linee: 1, tratte: 1, tratteSenzaTracciato: 0 } }) });
    expect(contenuto(uno)).toEqual(["1 corsa", "2 fermate", "1 linea", "1 tratta col tracciato"]);
  });

  it("senza conteggi, niente", () => {
    expect(contenuto(file({}))).toEqual([]);
    expect(contenuto(file({ inLinea: inLinea() }))).toEqual([]);
  });
  it("gli errori dell'ultimo tentativo: righe di testo, o problemi del GTFS col numero", () => {
    const t = (dettagli: any) => file({ ultimoTentativo: { esito: "non_valido", messaggio: "x", provatoIl: null, dettagli } });
    expect(erroriDelTentativo(t({ errori: ["riga 1", "riga 2", "riga 3"] }), 2)).toEqual(["riga 1", "riga 2"]);
    expect(erroriDelTentativo(t({ errori: [{ messaggio: "manca il sito", quante: 12345 }] }))).toEqual(["manca il sito (12.345)"]);
    expect(erroriDelTentativo(t(null))).toEqual([]);
  });
});
