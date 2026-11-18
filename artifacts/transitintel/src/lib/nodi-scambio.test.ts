import { describe, expect, it } from "vitest";
import {
  corpoNodo, corseStimate, domandaTogli, erroriNodo, moduloDa, moduloVuoto, nomeDelTipo, orariDalTesto, orarioNormale, testoDegliOrari,
  type NodoDiScambio,
} from "./nodi-scambio";

const STAZIONE: NodoDiScambio = {
  nodo: "stazione-centrale", nome: "Stazione Centrale", tipo: "railway", lat: 44.506, lng: 11.343, fermateGtfs: ["1201", "1202"],
  minutiAPiedi: 3, descrizione: "Treni regionali e nazionali",
  arrivi: [{ luogo: "Bologna (R)", orari: ["07:10", "08:10"] }],
  partenze: [{ luogo: "Roma (FR)", orari: ["06:30", "10:00"] }, { luogo: "Milano (IC)", orari: ["09:00"] }],
  ordine: 10,
};

describe("gli orari come testo", () => {
  it("una riga per luogo, e si torna indietro uguali", () => {
    expect(testoDegliOrari(STAZIONE.partenze)).toBe("Roma (FR): 06:30 10:00\nMilano (IC): 09:00");
    expect(orariDalTesto(testoDegliOrari(STAZIONE.partenze))).toEqual({ corse: STAZIONE.partenze, errori: [] });
  });

  it("orari con virgole, senza lo zero, doppi o in disordine: si mettono a posto; le righe vuote non contano", () => {
    expect(orariDalTesto("  Roma (FR) : 10:00, 6:30 06:30\n\nMilano: 9:00;\n")).toEqual({
      corse: [{ luogo: "Roma (FR)", orari: ["06:30", "10:00"] }, { luogo: "Milano", orari: ["09:00"] }], errori: [],
    });
  });

  it("dice la riga che non va, e perché", () => {
    expect(orariDalTesto("Roma 06:30").errori).toEqual(["riga 1: prima dei due punti va il luogo, come «Roma: 06:10 07:35»"]);
    expect(orariDalTesto(": 06:30").errori).toEqual(["riga 1: prima dei due punti va il luogo, come «Roma: 06:10 07:35»"]);
    expect(orariDalTesto("Linea 1: 08:00\nRoma:06:30").corse).toEqual([{ luogo: "Linea 1", orari: ["08:00"] }, { luogo: "Roma", orari: ["06:30"] }]);
    expect(orariDalTesto("Roma: 06:30\nMilano: 25:61").errori).toEqual(["riga 2: «25:61» non è un orario (HH:MM, da 00:00 a 47:59)"]);
    expect(orariDalTesto("Roma:").errori).toEqual(["riga 1: dopo «Roma:» manca almeno un orario"]);
    expect(orariDalTesto(Array.from({ length: 41 }, (_, i) => `L${i}: 08:00`).join("\n")).errori).toEqual(["Al più 40 righe"]);
  });

  it("un orario: la stessa regola dell'API", () => {
    expect(["6:10", "24:00", "47:59"].map(orarioNormale)).toEqual(["06:10", "24:00", "47:59"]);
    expect(["48:00", "06:60", "6.10"].map(orarioNormale)).toEqual([null, null, null]);
  });
});

describe("il modulo di un nodo", () => {
  it("da un nodo e di nuovo al corpo: gli stessi dati", () => {
    const m = moduloDa(STAZIONE);
    expect(m).toMatchObject({ fermate: "1201, 1202", arrivi: "Bologna (R): 07:10 08:10", lat: "44.506", ordine: "10" });
    expect(erroriNodo(m, false)).toEqual([]);
    const { nodo: _id, zone: _z, ...atteso } = { ...STAZIONE, zone: 0 };
    expect(corpoNodo(m, false)).toEqual(atteso);
    expect(corpoNodo(m, true)).toMatchObject({ nodo: "stazione-centrale" });
  });

  it("un nodo nuovo: l'identificativo, unico e non come quelli trovati dall'analisi", () => {
    const m = { ...moduloVuoto(), nome: "Porto", tipo: "port" as const, lat: "44,1", lng: "12,4" };
    expect(erroriNodo({ ...m, nodo: "porto" }, true, [])).toEqual([]);
    expect(erroriNodo({ ...m, nodo: "porto" }, true, ["porto"])).toEqual(["C'è già un nodo «porto»"]);
    expect(erroriNodo({ ...m, nodo: "Porto" }, true)[0]).toMatch(/^Identificativo: da 2 a 40/);
    expect(erroriNodo({ ...m, nodo: "gtfs-port-1" }, true)[0]).toMatch(/l'analisi trova da sola/);
    expect(corpoNodo({ ...m, nodo: "porto" }, true)).toMatchObject({ lat: 44.1, lng: 12.4, minutiAPiedi: 2, fermateGtfs: [], arrivi: [], ordine: 0 });
  });

  it("i campi sbagliati, e gli orari con la casella in cui sono", () => {
    const m = { ...moduloDa(STAZIONE), nome: " ", lat: "100", minutiAPiedi: "61", partenze: "Roma 10:00" };
    expect(erroriNodo(m, false)).toEqual([
      "Il nome va scritto", "Latitudine: un numero fra -90 e 90", "Minuti a piedi: un numero intero da 0 a 60",
      "Partenze, riga 1: prima dei due punti va il luogo, come «Roma: 06:10 07:35»",
    ]);
  });
});

describe("in breve", () => {
  it("le corse stimate, il nome del tipo e la domanda prima di togliere", () => {
    expect(corseStimate(STAZIONE)).toBe(5);
    expect(nomeDelTipo("park-ride")).toBe("Parcheggio scambiatore");
    expect(domandaTogli({ nome: "Porto", zone: 0 })).toBe("Togliere «Porto»?");
    expect(domandaTogli({ nome: "Porto", zone: 2 })).toMatch(/^Togliere «Porto»\? 2 zone di coincidenza lo ricordano/);
  });
});
