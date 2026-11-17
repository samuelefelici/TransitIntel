import { describe, it, expect } from "vitest";
import {
  corpoModificaTitolo, corpoNuovoTitolo, domandaAllinea, durataInParole, erroriTitolo, euro, idDaNome, idDelModulo, moduloDa, moduloVuoto,
  riassuntoCatalogo, riassuntoConfronto, titoliPerRete, type TitoloCatalogo,
} from "./titoli-catalogo";

const RETI = [
  { rete: "urbano_ancona", tipo: "urbano" as const }, { rete: "urbano_jesi", tipo: "urbano" as const }, { rete: "extraurbano", tipo: "extraurbano" as const },
];
const t = (parte: Partial<TitoloCatalogo>): TitoloCatalogo => ({
  titolo: "jesi_60min", nome: "Biglietto Urbano Jesi 60 min", rete: "urbano_jesi", tipo: "single", categoria: "ordinario", prezzo: 1.35,
  durataMinuti: 60, fascia: null, diRiferimento: true, ordine: 5, ...parte,
});

describe("come si mostra il catalogo", () => {
  it("i prezzi e le durate a parole", () => {
    expect([euro(1.35), euro(35), euro(1236)]).toEqual(["1,35", "35,00", "1236,00"]);
    expect([null, 1, 60, 100, 180, 1440, 10080, 43200, 525600, 1051200].map(durataInParole))
      .toEqual(["—", "un minuto", "60 minuti", "100 minuti", "3 ore", "un giorno", "7 giorni", "30 giorni", "un anno", "2 anni"]);
  });

  it("il riassunto: quanti titoli, quanti biglietti e quanti abbonamenti", () => {
    expect(riassuntoCatalogo([t({}), t({ titolo: "a", tipo: "return" }), t({ titolo: "b", tipo: "abbonamento_mensile" })])).toBe("3 titoli: 2 biglietti e un abbonamento.");
    expect(riassuntoCatalogo([t({})])).toBe("Un titolo: un biglietto.");
    expect(riassuntoCatalogo([])).toMatch(/^Il catalogo è vuoto/);
  });

  it("i titoli per rete, nell'ordine delle reti; in fondo quelli di una rete che non c'è più", () => {
    const gruppi = titoliPerRete([t({ titolo: "x", rete: "urbano_osimo" }), t({ titolo: "e", rete: "extraurbano" }), t({}), t({ titolo: "a", rete: "urbano_ancona" })], RETI);
    expect(gruppi.map((g) => [g.rete, g.titoli.map((x) => x.titolo)])).toEqual([
      ["urbano_ancona", ["a"]], ["urbano_jesi", ["jesi_60min"]], ["extraurbano", ["e"]], ["urbano_osimo", ["x"]],
    ]);
  });
});

describe("il modulo di un titolo", () => {
  it("l'identificativo si ricava dal nome, se non lo scrivi", () => {
    expect(idDaNome("Biglietto Urbano Pesaro 60 min")).toBe("biglietto_urbano_pesaro_60_min");
    expect(idDaNome("24 ore — Città")).toBe("ore_citta");
    const m = { ...moduloVuoto("urbano_jesi"), nome: "Jesi Giornaliero", prezzo: "3,50" };
    expect(idDelModulo(m)).toBe("jesi_giornaliero");
    expect(idDelModulo({ ...m, titolo: " jesi_giorn " })).toBe("jesi_giorn");
  });

  it("un titolo nuovo: parte quello che serve, coi numeri letti all'italiana", () => {
    const m = { ...moduloVuoto("urbano_jesi"), nome: " Biglietto Urbano Jesi 30 min ", prezzo: "1,10", durata: "30", diRiferimento: true };
    expect(erroriTitolo(m, true, RETI)).toEqual([]);
    expect(corpoNuovoTitolo(m)).toEqual({
      titolo: "biglietto_urbano_jesi_30_min", nome: "Biglietto Urbano Jesi 30 min", rete: "urbano_jesi", tipo: "single", categoria: "ordinario",
      prezzo: 1.1, durataMinuti: 30, fascia: null, diRiferimento: true,
    });
  });

  it("un titolo aperto e salvato senza toccarlo resta com'era", () => {
    const titolo = t({ prezzo: 1236, durataMinuti: null, fascia: null });
    const m = moduloDa(titolo);
    expect(m).toMatchObject({ prezzo: "1236,00", durata: "", fascia: "" });
    expect(erroriTitolo(m, false, RETI)).toEqual([]);
    const { titolo: _id, ...resto } = titolo;
    expect(corpoModificaTitolo(m)).toEqual(resto);
  });

  it("dice che cosa non va, campo per campo", () => {
    const m = { ...moduloVuoto("urbano_altrove"), titolo: "Con Maiuscole", nome: 'Con "virgolette"', categoria: "Studente", prezzo: "1,234", durata: "0", fascia: "99", ordine: "x" };
    expect(erroriTitolo(m, true, RETI)).toEqual([
      "Nel nome non vanno le virgolette doppie: finisce nei file del GTFS.",
      "L'identificativo ha solo lettere minuscole, cifre e trattini bassi, e comincia con una lettera: per esempio «pesaro_60min».",
      "Scegli la rete del titolo.",
      "La categoria ha solo lettere minuscole, cifre e trattini bassi: per esempio «studente».",
      "Il prezzo ha al più due decimali.",
      "La durata è un numero intero di minuti, da 1 in su.",
      "La fascia è un numero da 1 a 60.",
      "L'ordine è un numero da 0 a 99999.",
    ]);
    expect(erroriTitolo({ ...moduloVuoto("urbano_jesi") }, true, RETI).slice(0, 2)).toEqual(["Scrivi il nome del titolo.", "L'identificativo ha solo lettere minuscole, cifre e trattini bassi, e comincia con una lettera: per esempio «pesaro_60min»."]);
  });

  it("la fascia solo sull'extraurbano; di riferimento solo un biglietto di corsa semplice urbano", () => {
    const base = { ...moduloVuoto("urbano_jesi"), nome: "Prova", prezzo: "1" };
    expect(erroriTitolo({ ...base, fascia: "3" }, true, RETI)).toEqual(["Solo un titolo extraurbano ha un prezzo per fascia chilometrica."]);
    expect(erroriTitolo({ ...base, rete: "extraurbano", fascia: "3", tipo: "abbonamento_mensile" }, true, RETI)).toEqual([]);
    expect(erroriTitolo({ ...base, tipo: "return", diRiferimento: true }, true, RETI)).toEqual(["Il biglietto di riferimento può essere solo un biglietto di corsa semplice di una rete urbana."]);
    expect(erroriTitolo({ ...base, rete: "extraurbano", diRiferimento: true }, true, RETI)).toEqual(["Il biglietto di riferimento può essere solo un biglietto di corsa semplice di una rete urbana."]);
  });
});

describe("il feed rispetto al catalogo", () => {
  it("la domanda prima di allineare dice quali titoli e che cosa cambia; se non c'è niente, nessuna domanda", () => {
    expect(domandaAllinea({ diversi: [] })).toBeNull();
    expect(domandaAllinea({ diversi: [{ id: "jesi_60min", differenze: ["prezzo 1,20 → 1,35", "durata nessuna → 60"] }] })).toBe(
      "Un titolo del feed è diverso dal catalogo dell'azienda o dalle fasce chilometriche:\n• jesi_60min: prezzo 1,20 → 1,35; durata nessuna → 60\n\nLi porto ai nomi, ai prezzi e alle durate del catalogo?");
    const tanti = Array.from({ length: 11 }, (_, i) => ({ id: `t${i}`, differenze: ["prezzo 1,00 → 2,00"] }));
    const domanda = domandaAllinea({ diversi: tanti })!;
    expect(domanda.split("\n")[0]).toBe("11 titoli del feed sono diversi dal catalogo dell'azienda o dalle fasce chilometriche:");
    expect(domanda).toContain("• … e altri 3");
  });

  it("l'esito del confronto in una frase", () => {
    expect(riassuntoConfronto({ mancanti: 0, diversi: [], uguali: 182, doppioni: 0 })).toBe("I titoli del feed sono come nel catalogo.");
    expect(riassuntoConfronto({ mancanti: 2, diversi: [], uguali: 180, doppioni: 3 })).toBe("I titoli del feed sono come nel catalogo; mancano 2 titoli del catalogo; ci sono 3 doppioni.");
    expect(riassuntoConfronto({ mancanti: 1, diversi: [{ id: "x", differenze: ["y"] }], uguali: 0, doppioni: 1 })).toBe("Manca un titolo del catalogo; c'è un doppione.");
  });
});
