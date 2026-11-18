import { describe, it, expect } from "vitest";
import {
  avvisoSenzaGestore, conteggi, corpoModificaGestore, corpoNuovoGestore, domandaTogli, erroriGestore, esitoAssegnazione, lineeFiltrate,
  moduloDa, moduloVuoto, nomeDelGestore, riassuntoGestori, type GestoreConLinee, type GestoriDelProgramma, type LineaColGestore,
} from "./gestori";
import type { AgenziaNelGtfs } from "./elenchi-tariffe";

const AZIENDA: AgenziaNelGtfs = {
  agency_id: "azienda", agency_name: "Azienda S.p.A.", agency_url: "https://azienda.example", agency_timezone: "Europe/Rome", agency_lang: "it",
  agency_phone: "", agency_fare_url: "", agency_email: "", daAzienda: true,
};
const UNO: GestoreConLinee = { gestore: "UNO", nome: "Autolinee Uno S.p.A.", sito: "https://uno.example", telefono: "071 000001", email: "info@uno.example", tariffeUrl: null, predefinito: true, linee: 12 };
const DUE: GestoreConLinee = { gestore: "DUE", nome: "Due Bus", sito: "https://due.example", telefono: null, email: null, tariffeUrl: "https://due.example/tariffe", predefinito: false, linee: 1 };
const TRE: GestoreConLinee = { gestore: "TRE", nome: "Tre Trasporti", sito: "https://tre.example", telefono: null, email: null, tariffeUrl: null, predefinito: false, linee: 0 };

const linea = (id: string, shortName: string, longName: string | null, detto: string | null, gestore: string | null, assegnato: boolean): LineaColGestore =>
  ({ id, shortName, longName, detto, gestore, assegnato });
const PROGRAMMA: GestoriDelProgramma = {
  gestori: [UNO, DUE, TRE].map((g) => ({ gestore: g.gestore, nome: g.nome, predefinito: g.predefinito })),
  linee: [
    linea("a", "1", "Stazione - Centro", "UNO", "UNO", true),
    linea("b", "2", "Centro - Ospedale", "DUE", "DUE", true),
    linea("c", "3", "Porto - Università", "ATMA", "UNO", false),
    linea("d", "4", null, null, "UNO", false),
    linea("e", "21", "Ospedale - Stazione", "DUE", "DUE", true),
  ],
  puoScrivere: true,
};

describe("il modulo di un gestore", () => {
  it("andata e ritorno: quello che è salvato torna uguale, senza l'identificativo nella modifica", () => {
    expect(corpoNuovoGestore(moduloDa(UNO))).toEqual({ gestore: "UNO", nome: "Autolinee Uno S.p.A.", sito: "https://uno.example", telefono: "071 000001", email: "info@uno.example", tariffeUrl: null });
    expect(corpoModificaGestore(moduloDa(DUE))).toEqual({ nome: "Due Bus", sito: "https://due.example", telefono: null, email: null, tariffeUrl: "https://due.example/tariffe" });
    expect(corpoNuovoGestore({ ...moduloVuoto(), gestore: " UNO ", nome: " Uno ", sito: " https://uno.example ", telefono: " " }))
      .toEqual({ gestore: "UNO", nome: "Uno", sito: "https://uno.example", telefono: null, email: null, tariffeUrl: null });
  });

  it("identificativo, nome e sito ci vogliono; il resto è facoltativo", () => {
    expect(erroriGestore(moduloDa(UNO))).toEqual([]);
    expect(erroriGestore(moduloDa(TRE))).toEqual([]);
    expect(erroriGestore(moduloVuoto()).length).toBe(3);
    const m = moduloDa(UNO);
    expect(erroriGestore({ ...m, gestore: "Uno Bus" })).toEqual(["L'identificativo ha solo lettere, cifre e . _ - (al più 40), senza spazi."]);
    expect(erroriGestore({ ...m, nome: 'Uno "bus"' })).toEqual(["Il nome non può contenere virgolette."]);
    expect(erroriGestore({ ...m, sito: "uno.example" })).toEqual(["Il sito comincia con http:// o https://: nei GTFS è obbligatorio."]);
    expect(erroriGestore({ ...m, telefono: "zero71" })).toEqual(["Il telefono ha solo cifre, spazi e + ( ) . / -."]);
    expect(erroriGestore({ ...m, email: "info" })).toEqual(["L'indirizzo di posta non è valido."]);
    expect(erroriGestore({ ...m, tariffeUrl: "tariffe" })).toEqual(["La pagina delle tariffe comincia con http:// o https://."]);
  });

  it("un gestore nuovo non può avere l'identificativo di uno che c'è già", () => {
    expect(erroriGestore(moduloDa(UNO), ["UNO", "DUE"])).toEqual(["C'è già un gestore con l'identificativo «UNO»."]);
    expect(erroriGestore(moduloDa(UNO), ["DUE"])).toEqual([]);
  });
});

describe("le frasi della scheda", () => {
  it("chi figura come agenzia: l'azienda, un gestore solo, o più gestori col predefinito", () => {
    expect(riassuntoGestori({ gestori: [], azienda: AZIENDA })).toBe("Non ci sono gestori: nei GTFS l'agenzia è l'azienda, Azienda S.p.A. (azienda), per tutte le linee.");
    expect(riassuntoGestori({ gestori: [UNO], azienda: AZIENDA })).toBe("Un gestore: Autolinee Uno S.p.A. (UNO). Nei GTFS è l'agenzia di tutte le linee.");
    expect(riassuntoGestori({ gestori: [UNO, DUE, TRE], azienda: AZIENDA }))
      .toBe("3 gestori. Il predefinito è Autolinee Uno S.p.A. (UNO): è il gestore delle linee che non ne hanno uno loro.");
  });

  it("l'avviso sulle linee senza un gestore dell'elenco: solo con più gestori", () => {
    expect(avvisoSenzaGestore({ gestori: [UNO, DUE], lineeSenzaGestore: 0 })).toBeNull();
    expect(avvisoSenzaGestore({ gestori: [UNO], lineeSenzaGestore: 40 })).toBeNull();
    expect(avvisoSenzaGestore({ gestori: [UNO, DUE], lineeSenzaGestore: 1 }))
      .toBe("Una linea dei programmi non ha un gestore dell'elenco e per ora è di Autolinee Uno S.p.A.: si assegna in Planning Studio, dalla pagina della rete.");
    expect(avvisoSenzaGestore({ gestori: [UNO, DUE], lineeSenzaGestore: 37 }))
      .toBe("37 linee dei programmi non hanno un gestore dell'elenco e per ora sono di Autolinee Uno S.p.A.: si assegnano in Planning Studio, dalla pagina della rete.");
  });

  it("prima di togliere un gestore si dice che cosa succede alle sue linee", () => {
    const elenco = [UNO, DUE, TRE];
    expect(domandaTogli(TRE, elenco)).toBe("Tolgo Tre Trasporti?");
    expect(domandaTogli(DUE, elenco)).toBe("Due Bus ha una linea nei programmi. Se lo tolgo, quelle linee passano a Autolinee Uno S.p.A. finché non le assegni a un altro. Lo tolgo?");
    expect(domandaTogli(UNO, [UNO])).toBe("Autolinee Uno S.p.A. ha 12 linee nei programmi. È l'ultimo gestore: tolto lui, nei GTFS torna l'azienda per tutte le linee. Lo tolgo?");
  });
});

describe("le linee di un programma", () => {
  it("il filtro: tutte, di un gestore (solo quelle assegnate a lui), senza un gestore loro", () => {
    const id = (l: LineaColGestore[]) => l.map((x) => x.id);
    expect(id(lineeFiltrate(PROGRAMMA.linee, "tutte", ""))).toEqual(["a", "b", "c", "d", "e"]);
    expect(id(lineeFiltrate(PROGRAMMA.linee, { gestore: "UNO" }, ""))).toEqual(["a"]);
    expect(id(lineeFiltrate(PROGRAMMA.linee, { gestore: "DUE" }, ""))).toEqual(["b", "e"]);
    expect(id(lineeFiltrate(PROGRAMMA.linee, "senza", ""))).toEqual(["c", "d"]);
  });

  it("la ricerca: nel codice e nel nome, senza badare alle maiuscole", () => {
    const id = (l: LineaColGestore[]) => l.map((x) => x.id);
    expect(id(lineeFiltrate(PROGRAMMA.linee, "tutte", "2"))).toEqual(["b", "e"]);
    expect(id(lineeFiltrate(PROGRAMMA.linee, "tutte", " ospedale "))).toEqual(["b", "e"]);
    expect(id(lineeFiltrate(PROGRAMMA.linee, { gestore: "DUE" }, "stazione"))).toEqual(["e"]);
    expect(id(lineeFiltrate(PROGRAMMA.linee, "senza", "zzz"))).toEqual([]);
  });

  it("i conteggi delle linguette tornano con le linee", () => {
    expect(conteggi(PROGRAMMA)).toEqual({ perGestore: { UNO: 1, DUE: 2, TRE: 0 }, senza: 2 });
  });

  it("il nome del gestore: il suo, o il predefinito dicendo perché", () => {
    const [a, , c, d] = PROGRAMMA.linee as [LineaColGestore, LineaColGestore, LineaColGestore, LineaColGestore];
    expect(nomeDelGestore(a, PROGRAMMA.gestori)).toBe("Autolinee Uno S.p.A.");
    expect(nomeDelGestore(c, PROGRAMMA.gestori)).toBe("Autolinee Uno S.p.A. (predefinito: «ATMA» non è fra i gestori)");
    expect(nomeDelGestore(d, PROGRAMMA.gestori)).toBe("Autolinee Uno S.p.A. (predefinito)");
    expect(nomeDelGestore({ ...a, gestore: null }, PROGRAMMA.gestori)).toBe("—");
  });

  it("che cosa si dice dopo un'assegnazione", () => {
    expect(esitoAssegnazione(3, 3, "Due Bus")).toBe("3 linee assegnate a Due Bus.");
    expect(esitoAssegnazione(1, 1, "Due Bus")).toBe("Una linea assegnata a Due Bus.");
    expect(esitoAssegnazione(2, 5, "Due Bus")).toBe("2 linee assegnate a Due Bus; 3 lo erano già.");
    expect(esitoAssegnazione(4, 5, null)).toBe("4 linee assegnate al predefinito; una lo era già.");
    expect(esitoAssegnazione(0, 1, "Due Bus")).toBe("La linea era già assegnata a Due Bus.");
    expect(esitoAssegnazione(0, 4, null)).toBe("Le 4 linee erano già assegnate al predefinito.");
  });
});
