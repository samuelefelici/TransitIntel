/**
 * La rotazione dei turni (PR 7.8): la regola, senza database.
 */
import { describe, it, expect } from "vitest";
import { inizioPeriodo, periodiFra, postoDi, rotazione, type Ingresso, type Posto } from "../lib/roster-rotazione-turni";

describe("periodi", () => {
  it("settimanale: dal lunedì; semimensile: il 1° e il 16", () => {
    expect(inizioPeriodo("2032-07-07", "settimanale")).toBe("2032-07-05"); // mercoledì → lunedì
    expect(inizioPeriodo("2032-07-05", "settimanale")).toBe("2032-07-05");
    expect(inizioPeriodo("2032-07-11", "settimanale")).toBe("2032-07-05"); // domenica
    expect(inizioPeriodo("2032-07-15", "semimensile")).toBe("2032-07-01");
    expect(inizioPeriodo("2032-07-16", "semimensile")).toBe("2032-07-16");
    expect(inizioPeriodo("2032-02-29", "semimensile")).toBe("2032-02-16");
  });

  it("quanti periodi fra due giorni, anche fra mesi e anni e all'indietro", () => {
    expect(periodiFra("2032-07-05", "2032-07-11", "settimanale")).toBe(0);
    expect(periodiFra("2032-07-05", "2032-07-12", "settimanale")).toBe(1);
    expect(periodiFra("2032-07-12", "2032-07-05", "settimanale")).toBe(-1);
    expect(periodiFra("2032-07-01", "2032-07-15", "semimensile")).toBe(0);
    expect(periodiFra("2032-07-01", "2032-07-16", "semimensile")).toBe(1);
    expect(periodiFra("2032-12-16", "2033-01-01", "semimensile")).toBe(1);
    expect(periodiFra("2032-07-20", "2032-07-01", "semimensile")).toBe(-1);
    // 24 periodi in un anno
    expect(periodiFra("2032-01-01", "2033-01-01", "semimensile")).toBe(24);
  });

  it("il posto gira: dall'ultimo si torna al primo, anche all'indietro", () => {
    expect(postoDi(1, 0, 3)).toBe(1);
    expect(postoDi(3, 1, 3)).toBe(1);
    expect(postoDi(2, 4, 3)).toBe(3);
    expect(postoDi(1, -1, 3)).toBe(3);
  });
});

describe("rotazione", () => {
  const posti: Posto[] = [
    { feriale: "A1", sabato: "S1", domenica: null },
    { feriale: "A2", sabato: null, domenica: "D2" },
    { feriale: "A3", sabato: "S3", domenica: null },
  ];
  const giorni = ["2032-07-09", "2032-07-10", "2032-07-11", "2032-07-12"]; // ven, sab, dom, lun (nuova settimana)
  const tipi: Record<string, "feriale" | "sabato" | "domenica"> = { "2032-07-09": "feriale", "2032-07-10": "sabato", "2032-07-11": "domenica", "2032-07-12": "feriale" };
  const base = (over: Partial<Ingresso> = {}): Ingresso => ({
    posti, giorni, riferimento: "2032-07-05", cadenza: "settimanale",
    tipoDi: (g) => tipi[g]!,
    cerca: (_g, codice) => ({ dssId: "d", codice }),
    occupato: () => null,
    membri: [
      { id: "uno", nome: "Uno", posizione: 1, liberi: new Set(giorni) },
      { id: "due", nome: "Due", posizione: 2, liberi: new Set(giorni) },
      { id: "tre", nome: "Tre", posizione: 3, liberi: new Set(giorni) },
    ],
    ...over,
  });
  const coppie = (r: ReturnType<typeof rotazione>) => r.assegnazioni.map((a) => `${a.giorno.slice(8)}:${a.driverId}=${a.codice}`);

  it("il turno del posto per il tipo di giorno; la settimana dopo ognuno passa al posto successivo", () => {
    const r = rotazione(base());
    expect(coppie(r)).toEqual([
      "09:uno=A1", "09:due=A2", "09:tre=A3",
      "10:uno=S1", "10:tre=S3",          // il posto 2 il sabato non ha turno
      "11:due=D2",                        // la domenica solo il posto 2
      "12:uno=A2", "12:due=A3", "12:tre=A1",
    ]);
    expect(r.nonFatte).toEqual([]);
    expect(r.assegnazioni.find((a) => a.giorno === "2032-07-12" && a.driverId === "tre")!.posto).toBe(1);
  });

  it("solo nei giorni liberi; codici non pubblicati, ambigui o già presi si dicono", () => {
    const r = rotazione(base({
      giorni: ["2032-07-09"],
      membri: [
        { id: "uno", nome: "Uno", posizione: 1, liberi: new Set() },
        { id: "due", nome: "Due", posizione: 2, liberi: new Set(["2032-07-09"]) },
        { id: "tre", nome: "Tre", posizione: 3, liberi: new Set(["2032-07-09"]) },
      ],
      cerca: (_g, codice) => (codice === "A2" ? "non_pubblicato" : { dssId: "d", codice }),
      occupato: (_g, t) => (t.codice === "A3" ? "altro" : null),
    }));
    expect(r.assegnazioni).toEqual([]);
    expect(r.nonFatte.map((n) => [n.driverId, n.codice, n.motivo])).toEqual([["due", "A2", "non_pubblicato"], ["tre", "A3", "gia_assegnato"]]);
    const amb = rotazione(base({ giorni: ["2032-07-09"], cerca: () => "ambiguo" }));
    expect(amb.nonFatte.map((n) => n.motivo)).toEqual(["ambiguo", "ambiguo", "ambiguo"]);
  });

  it("chi non ha posizione o l'ha oltre i posti non riceve niente e lo si dice una volta; due non prendono lo stesso turno", () => {
    const r = rotazione(base({
      giorni: ["2032-07-09"],
      membri: [
        { id: "uno", nome: "Uno", posizione: 1, liberi: new Set(["2032-07-09"]) },
        { id: "doppio", nome: "Doppio", posizione: 1, liberi: new Set(["2032-07-09"]) },
        { id: "senza", nome: "Senza", posizione: null, liberi: new Set(["2032-07-09"]) },
        { id: "oltre", nome: "Oltre", posizione: 7, liberi: new Set(["2032-07-09"]) },
      ],
    }));
    expect(coppie(r)).toEqual(["09:doppio=A1"]); // a parità di posizione, per nome
    expect(r.nonFatte.map((n) => [n.driverId, n.motivo])).toEqual([["oltre", "posizione_oltre"], ["senza", "senza_posizione"], ["uno", "gia_assegnato"]]);
  });

  it("semimensile: il 16 si cambia posto", () => {
    const r = rotazione(base({
      cadenza: "semimensile", riferimento: "2032-07-01", giorni: ["2032-07-15", "2032-07-16"],
      tipoDi: () => "feriale",
      membri: [{ id: "uno", nome: "Uno", posizione: 1, liberi: new Set(["2032-07-15", "2032-07-16"]) }],
    }));
    expect(coppie(r)).toEqual(["15:uno=A1", "16:uno=A2"]);
  });
});
