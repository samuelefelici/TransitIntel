/**
 * L'anagrafica del personale, nelle parti che non toccano il database: i
 * lettori dei valori (date, orari, telefoni, parametri…), la scheda, il
 * riconoscimento delle colonne dell'import, la mascheratura, lo
 * scadenziario e l'esportazione.
 */
import { describe, it, expect } from "vitest";
import { inflateRawSync } from "node:zlib";
import {
  CAMPI_OPERATIVI, DEPOSITI_INIZIALI, classificaTelefoni, componiIndirizzo, dataDaSeriale, leggiData,
  leggiEsitoVisita, leggiOrario, leggiParametro, mascheraConducente, matricolaCanonica, normalizzaScaglioneFerie,
  rigaRotazione, scadenzeDi, statoPeggiore, statoScadenza, trovaDeposito, type Conducente,
} from "../lib/anagrafica-campi";
import { leggiCorpoScheda } from "../lib/anagrafica-scheda";
import { analizza, dividiNominativo, leggiTabella, mappaColonne } from "../lib/anagrafica-import";
import { cellaSicura, colonneDi, esportaAnagraficaCsv, esportaAnagraficaXlsx } from "../lib/anagrafica-export";
import { Stili, scriviXlsx } from "../lib/xlsx-mini";

const ok = <T>(l: any): T => { expect(l?.ok).toBe(true); return l.valore as T; };

describe("la matricola", () => {
  it("si confronta senza zeri iniziali, spazi e maiuscole", () => {
    expect(matricolaCanonica("00123")).toBe("123");
    expect(matricolaCanonica(" ab 12 ")).toBe("AB12");
    expect(matricolaCanonica("123.0")).toBe("123");
    expect(matricolaCanonica("0000")).toBe("0");
    expect(matricolaCanonica("")).toBeNull();
  });
});

describe("le date", () => {
  it("ISO, italiane, del gestionale e seriali di Excel", () => {
    expect(ok(leggiData("2026-10-13"))).toBe("2026-10-13");
    expect(ok(leggiData("13/10/2026"))).toBe("2026-10-13");
    expect(ok(leggiData("1-2-26"))).toBe("2026-02-01");
    expect(ok(leggiData("1998-03-02 00:00:00.000"))).toBe("1998-03-02");
    expect(dataDaSeriale(45292)).toBe("2024-01-01");
    expect(ok(leggiData("45292"))).toBe("2024-01-01");
  });
  it("il 1/1/1900 è il vuoto del gestionale; una data impossibile è un errore", () => {
    expect(leggiData("1900-01-01 00:00:00.000")?.ok).toBe("ignora");
    expect(leggiData("31/02/2026")?.ok).toBe(false);
    expect(leggiData("")).toBeNull();
    expect(leggiData("12/12/1890", { min: 1920 })?.ok).toBe("ignora");
    expect(leggiData("12/12/1910", { min: 1920 })?.ok).toBe(false);
  });
});

describe("l'orario settimanale", () => {
  it("ore e minuti in tutte le forme in cui si scrive", () => {
    expect(ok(leggiOrario("38:30"))).toBe(2310);
    expect(ok(leggiOrario("38h30"))).toBe(2310);
    expect(ok(leggiOrario("38 h"))).toBe(2280);
    expect(ok(leggiOrario("39 ore"))).toBe(2340);
    expect(ok(leggiOrario("38"))).toBe(2280);
    expect(ok(leggiOrario("2280"))).toBe(2280);
    expect(ok(leggiOrario("2310 min"))).toBe(2310);
    expect(ok(leggiOrario("37,5"))).toBe(2250);
    expect(ok(leggiOrario("38.5h"))).toBe(2310);
  });
  it("le durate salvate come data: seriale di Excel ed epoche del gestionale", () => {
    expect(ok(leggiOrario("1.625"))).toBe(2340);
    expect(ok(leggiOrario("1900-01-02 15:00:00.000"))).toBe(2340);
    expect(ok(leggiOrario("1899-12-31 15:00"))).toBe(2340);
  });
  it("fuori misura è un errore, insolito è un avviso", () => {
    expect(leggiOrario("61:00")?.ok).toBe(false);
    const l = leggiOrario("100") as any;
    expect(l.ok).toBe(true);
    expect(l.avviso).toMatch(/insolito/);
    expect(leggiOrario("tanto")?.ok).toBe(false);
  });
});

describe("i telefoni", () => {
  it("cellulare e fisso si riconoscono dal numero, col prefisso internazionale tolto", () => {
    expect(classificaTelefoni(["+39 333 1234567", "071 123456"])).toEqual({ cellulare: "3331234567", telefono: "071123456", avvisi: [] });
    expect(classificaTelefoni(["0039-347.1234567"]).cellulare).toBe("3471234567");
  });
  it("due cellulari: il secondo va nel telefono, con un avviso", () => {
    const t = classificaTelefoni(["3331234567", "3479876543"]);
    expect(t.cellulare).toBe("3331234567");
    expect(t.telefono).toBe("3479876543");
    expect(t.avvisi).toHaveLength(1);
  });
});

describe("parametro, visite, deposito, scaglioni, indirizzo", () => {
  it("il parametro si legge dalle cifre; fuori elenco non si salva ma non blocca", () => {
    expect(ok(leggiParametro("P158"))).toBe(158);
    expect(ok(leggiParametro("183.00"))).toBe(183);
    expect(leggiParametro("150")?.ok).toBe("ignora");
  });
  it("l'esito della visita", () => {
    expect(ok(leggiEsitoVisita("Temporaneamente non idoneo"))).toBe("temp_non_idoneo");
    expect(ok(leggiEsitoVisita("Idoneo con prescrizioni"))).toBe("idoneo_prescrizioni");
    expect(ok(leggiEsitoVisita("IDONEO"))).toBe("idoneo");
    expect(ok(leggiEsitoVisita("non idonea"))).toBe("non_idoneo");
    expect(leggiEsitoVisita("boh")?.ok).toBe(false);
  });
  it("i microdepositi assorbiti portano al deposito che li ha assorbiti", () => {
    expect(trovaDeposito("Moie", DEPOSITI_INIZIALI)?.nome).toBe("Jesi Urbano");
    expect(trovaDeposito("JESI URBANO", DEPOSITI_INIZIALI)?.codice).toBe("jesi-urbano");
    expect(trovaDeposito("Ostra", DEPOSITI_INIZIALI)?.nome).toBe("Marina");
    expect(trovaDeposito("Polverigi", DEPOSITI_INIZIALI)?.nome).toBe("Ancona");
    expect(trovaDeposito("Senigallia", DEPOSITI_INIZIALI)).toBeNull();
    const conCodice = DEPOSITI_INIZIALI.map(d => d.codice === "osimo" ? { ...d, alias: ["03"] } : d);
    expect(trovaDeposito("3", conCodice)?.nome).toBe("Osimo");
  });
  it("lo scaglione ferie in una forma sola", () => {
    expect(normalizzaScaglioneFerie("Gruppo 03")).toBe("3");
    expect(normalizzaScaglioneFerie("gr. 3")).toBe("3");
    expect(normalizzaScaglioneFerie("estate a")).toBe("ESTATE A");
  });
  it("l'indirizzo da colonne separate solo se c'è la via", () => {
    expect(componiIndirizzo({ indirizzo: "Via Roma 1", cap: "60100", citta: "Ancona", prov: "an" })).toBe("Via Roma 1, 60100 Ancona (AN)");
    expect(componiIndirizzo({ cap: "60100", citta: "Ancona" })).toBeNull();
  });
  it("la riga della rotazione: stessa aritmetica di genera-riposi", () => {
    expect(rigaRotazione(0, 11, "2026-10-05", "2026-10-13")).toBe(1);
    expect(rigaRotazione(0, 11, "2026-10-07", "2026-10-05")).toBe(0);
    expect(rigaRotazione(0, 11, "2026-10-05", "2026-09-30")).toBe(10);
    expect(rigaRotazione(10, 11, "2026-10-05", "2026-10-12")).toBe(0);
  });
});

const conducente = (p: Partial<Conducente> = {}): Conducente => ({
  id: "d1", name: "Rossi Mario", badge: null, isFictitious: false, isActive: true, versione: 3, updatedAt: null,
  matricola: "512", cognome: "Rossi", nome: "Mario", residenzaServizio: "Ancona", categoria: "Autista",
  orarioSettimanaleMin: 2340, rotazioneRiposi: null, rotazioniRiposi: 0, scaglioneFerie: "3", rotazioneTurni: null,
  abilitazioni: ["autobus"], photoUrl: null, patente: "D", patenteValidita: "2027-01-01", cqcValidita: "2026-11-01",
  visitaFerrovieValidita: "2026-10-01", visitaMedicoCompetenteValidita: null,
  visitaFerrovieEsito: "idoneo_prescrizioni", visitaMedicoCompetenteEsito: "temp_non_idoneo",
  cellulare: "3331234567", dataFineServizio: null,
  cf: "RSSMRA80A01A271X", dataNascita: "1980-01-01", dataAssunzione: "2005-03-01", residenzaAnagrafica: "Via Roma 1",
  telefono: "071123456", inquadramento: "Operatore di esercizio", parametro: 175, ferieAnnue: 26, ferieResidue: 12.5,
  ferieResidueAl: "2026-09-30", ferieUnita: "giorni", patenteNumero: "AN123", cqcNumero: "AN123",
  visitaFerrovieData: "2024-10-01", visitaMedicoCompetenteData: "2026-09-01", note: "nota",
  ...p,
});

describe("la mascheratura", () => {
  it("senza «personale» escono esattamente i campi operativi", () => {
    const m = mascheraConducente(conducente(), false);
    expect(Object.keys(m).sort()).toEqual([...CAMPI_OPERATIVI].sort());
    expect((m as any).cf).toBeUndefined();
    expect((m as any).parametro).toBeUndefined();
    expect((m as any).note).toBeUndefined();
  });
  it("dell'esito della visita resta solo la non idoneità, non le prescrizioni", () => {
    const m = mascheraConducente(conducente(), false);
    expect(m.visitaFerrovieEsito).toBeNull();
    expect(m.visitaMedicoCompetenteEsito).toBe("temp_non_idoneo");
  });
  it("con «personale» esce tutto", () => {
    expect(mascheraConducente(conducente(), true).cf).toBe("RSSMRA80A01A271X");
  });
});

describe("lo scadenziario", () => {
  it("stati per distanza, e la non idoneità che prevale sulla data", () => {
    expect(statoScadenza("2026-10-01", "2026-10-13").stato).toBe("scaduta");
    expect(statoScadenza("2026-11-01", "2026-10-13")).toEqual({ stato: "entro_30", giorni: 19 });
    expect(statoScadenza("2026-12-01", "2026-10-13").stato).toBe("entro_60");
    expect(statoScadenza("2027-01-01", "2026-10-13").stato).toBe("entro_90");
    expect(statoScadenza("2028-01-01", "2026-10-13").stato).toBe("ok");
    expect(statoScadenza(null, "2026-10-13").stato).toBe("mancante");
    expect(statoScadenza("2030-01-01", "2026-10-13", "non_idoneo").stato).toBe("non_idoneo");
  });
  it("lo stato peggiore di un conducente", () => {
    const voci = scadenzeDi(conducente(), "2026-10-13");
    expect(voci.map(v => v.stato)).toEqual(["entro_90", "entro_30", "scaduta", "non_idoneo"]);
    expect(statoPeggiore(voci)).toBe("non_idoneo");
  });
});

describe("la scheda", () => {
  it("valida campo per campo invece di salvare NULL in silenzio", () => {
    const c = leggiCorpoScheda({ dataNascita: "31/02/1980", parametro: 150, cellulare: "abc", ferieResidue: 3 });
    expect(Object.keys(c.errori).sort()).toEqual(["cellulare", "dataNascita", "ferieResidueAl", "parametro"]);
  });
  it("normalizza e lascia fuori le chiavi assenti; vuoto vuol dire svuota", () => {
    const c = leggiCorpoScheda({ cellulare: "+39 333 123 4567", orarioSettimanaleMin: 2310, telefono: "", versione: 4 });
    expect(c.errori).toEqual({});
    expect(c.variazioni).toEqual({ cellulare: "3331234567", orarioSettimanaleMin: 2310, telefono: null });
    expect(c.versione).toBe(4);
  });
  it("le visite viaggiano solo con le parti presenti", () => {
    const c = leggiCorpoScheda({ visitaFerrovieValidita: "2028-01-01" });
    expect(c.variazioni.visitaFerrovie).toEqual({ scadenza: "2028-01-01" });
  });
});

describe("l'import: colonne del gestionale", () => {
  const intestazioni = [
    "Id_dipendente", "Cognome", "Nome", "Codice_Deposito", "Id_residenza", "Gruppo_Ferie", "ID_Parametro",
    "NumeroPatente", "NUMERO_CQC", "DataScadenzaPatente", "DATA_SCADENZA_CQC", "Tel", "Tel1",
    "Indirizzo", "Cap", "Città", "Prov", "Data_licenziamento", "Codice_per_paghe", "Desc_qualifica",
  ];
  it("ogni colonna al suo campo, con le preferenze giuste", () => {
    const c = mappaColonne(intestazioni);
    const campo = (h: string) => c.find(x => x.intestazione === h)?.campo;
    expect(campo("Id_dipendente")).toBe("matricola");
    expect(campo("Codice_per_paghe")).toBeNull();
    expect(c.filter(x => x.candidataChiave).map(x => x.intestazione)).toEqual(["Id_dipendente", "Codice_per_paghe"]);
    expect(campo("Id_residenza")).toBe("deposito");
    expect(campo("Codice_Deposito")).toBeNull();
    expect(campo("Gruppo_Ferie")).toBe("scaglioneFerie");
    expect(campo("DATA_SCADENZA_CQC")).toBe("cqcValidita");
    expect(campo("Tel")).toBe("telefono");
    expect(campo("Tel1")).toBe("telefono");
    expect(campo("Città")).toBe("citta");
    expect(campo("Data_licenziamento")).toBe("dataFineServizio");
    expect(campo("Desc_qualifica")).toBe("categoria");
    expect(mappaColonne(intestazioni, 18).find(x => x.campo === "matricola")?.intestazione).toBe("Codice_per_paghe");
  });

  it("le righe portano solo i valori non vuoti, già normalizzati", () => {
    const tabella = [
      ["Esportazione DIPENDENTE"],
      intestazioni,
      ["00512", "Rossi", "Mario", "AN", "MOIE", "Gruppo 03", "P158", "an123", "AN123", "2027-01-01 00:00:00.000",
        "1900-01-01 00:00:00.000", "+39 333 1234567", "071 123456", "Via Roma 1", "60100", "Ancona", "AN", null, "9001", "Operatore di esercizio"],
      [],
      ["513", "Bianchi", null, null, null, null, null, null, null, null, null, null, null, null, "60100", "Jesi", null, "31/12/2025", null, null],
    ];
    const a = analizza(tabella);
    expect(a.rigaIntestazioni).toBe(2);
    expect(a.righe).toHaveLength(2);
    const [r, s] = a.righe;
    expect(r.n).toBe(3);
    expect(r.valori).toEqual({
      matricola: "00512", cognome: "Rossi", nome: "Mario", scaglioneFerie: "Gruppo 03", parametro: 158,
      residenzaAnagrafica: "Via Roma 1, 60100 Ancona (AN)", cellulare: "3331234567", telefono: "071123456",
      patenteNumero: "AN123", cqcNumero: "AN123", patenteValidita: "2027-01-01",
    });
    expect(r.depositoGrezzo).toBe("MOIE");
    expect(r.categoriaGrezza).toBe("Operatore di esercizio");
    expect(r.avvisi.join(" ")).toMatch(/vuoto del gestionale/);
    expect(r.errori).toEqual([]);
    /* l'indirizzo senza la via non sovrascrive niente; la cella vuota non porta niente */
    expect(s.valori).toEqual({ matricola: "513", cognome: "Bianchi", dataFineServizio: "2025-12-31" });
    expect(a.depositi).toEqual([{ valore: "MOIE", righe: 1 }]);
  });

  it("senza matricola o senza intestazioni il file si ferma con un messaggio", () => {
    expect(() => analizza([["Cognome", "Nome"], ["Rossi", "Mario"]])).toThrow(/matricola/);
    expect(() => analizza([["a", "b"], ["1", "2"]])).toThrow(/intestazioni/);
  });

  it("il nominativo unico si divide sull'ultima parola", () => {
    expect(dividiNominativo("De Luca Marco")).toEqual({ cognome: "De Luca", nome: "Marco" });
  });

  it("legge un CSV col punto e virgola in latin1, e un .xlsx", () => {
    const csv = Buffer.from("Matricola;Cognome;Città\n12;Nicolò;Ancona\n", "latin1");
    expect(leggiTabella(csv, "dip.csv")).toEqual([["Matricola", "Cognome", "Città"], ["12", "Nicolò", "Ancona"]]);
    const xlsx = scriviXlsx([{ nome: "F", righe: [["Matricola", "Cognome"], [512, "Rossi"]] }], new Stili());
    expect(leggiTabella(xlsx, "dip.xlsx")).toEqual([["Matricola", "Cognome"], ["512", "Rossi"]]);
    expect(() => leggiTabella(Buffer.from("x"), "dip.xls")).toThrow(/xlsx/);
  });
});

describe("l'esportazione", () => {
  it("una cella non diventa una formula, un telefono resta un telefono", () => {
    expect(cellaSicura("=HYPERLINK(\"x\")")).toBe("'=HYPERLINK(\"x\")");
    expect(cellaSicura("@a")).toBe("'@a");
    expect(cellaSicura("-x")).toBe("'-x");
    expect(cellaSicura("+39 333 1234567")).toBe("+39 333 1234567");
    expect(cellaSicura("-1,5")).toBe("-1,5");
  });

  it("senza «personale» non escono le colonne personali, nemmeno vuote", () => {
    const titoli = colonneDi(false).map(c => c.titolo);
    expect(titoli).not.toContain("Codice fiscale");
    expect(titoli).not.toContain("Parametro");
    expect(titoli).toContain("Cellulare");
    const csv = esportaAnagraficaCsv([mascheraConducente(conducente(), false)], { sensibili: false, oggi: "2026-10-13", generatoIl: "" });
    expect(csv).not.toContain("RSSMRA");
    expect(csv.split("\r\n")).toHaveLength(2);
  });

  it("il foglio ha riepilogo, anagrafica e scadenze, con il logo", () => {
    const buf = esportaAnagraficaXlsx([conducente()], { sensibili: true, oggi: "2026-10-13", generatoIl: "" });
    const voci = new Map<string, string>();
    let i = 0;
    while (buf.readUInt32LE(i) === 0x04034b50) {
      const comp = buf.readUInt32LE(i + 18), nl = buf.readUInt16LE(i + 26), el = buf.readUInt16LE(i + 28);
      const nome = buf.subarray(i + 30, i + 30 + nl).toString("utf8");
      const inizio = i + 30 + nl + el;
      voci.set(nome, inflateRawSync(buf.subarray(inizio, inizio + comp)).toString("utf8"));
      i = inizio + comp;
    }
    const wb = voci.get("xl/workbook.xml")!;
    for (const n of ["Riepilogo", "Anagrafica", "Scadenze"]) expect(wb).toContain(`name="${n}"`);
    expect(voci.has("xl/media/image1.png")).toBe(true);
    const tutto = [...voci.values()].join("");
    expect(tutto).toContain("RSSMRA80A01A271X");
    expect(tutto).toContain("Visita medico competente");
    expect(tutto).toContain("Non idoneo");
  });
});
