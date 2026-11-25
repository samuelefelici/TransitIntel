import { describe, it, expect } from "vitest";
import { dataLeggibile, etichettaTipo, giudizio, nomeProposto, percentuale, primaDataUtile, riconosciute, tipoProposto, type Resoconto, type TipoDiGiorno } from "./turni-esistenti";

const r = (numero: number, orario: number, totale: number): Resoconto => ({
  turniGuida: 1, turniMacchina: 1, corseNelFile: totale, riconosciutePerNumero: numero, riconosciutePerOrario: orario,
  nonTrovate: totale - numero - orario, corseDelGtfsSenzaTurno: 0, turniMacchinaVuoti: 0, pezziSenzaCorsa: 0,
});

describe("import dei turni esistenti: testi", () => {
  it("date leggibili, col giorno della settimana", () => {
    expect(dataLeggibile("2026-12-01")).toBe("mar 01/12/2026");
    expect(dataLeggibile("2026-12-06", false)).toBe("06/12/2026");
    expect(dataLeggibile("01/12/2026")).toBe("—");
    expect(dataLeggibile(null)).toBe("—");
  });

  it("la prima data da oggi in poi, o la prima", () => {
    expect(primaDataUtile(["2026-11-28", "2026-12-05", "2026-12-12"], "2026-12-01")).toBe("2026-12-05");
    expect(primaDataUtile(["2026-11-28"], "2026-12-01")).toBe("2026-11-28");
    expect(primaDataUtile([], "2026-12-01")).toBeNull();
  });

  it("il nome del tipo di giorno si accorcia", () => {
    expect(etichettaTipo(["A", "B"])).toBe("A + B");
    expect(etichettaTipo(["x".repeat(100)], 10)).toBe("xxxxxxxxx…");
    expect(nomeProposto("2026-12-01")).toBe("Turni esistenti · 01/12/2026");
  });

  it("il giudizio sull'aggancio delle corse", () => {
    expect(riconosciute(r(90, 6, 100))).toBe(96);
    expect(percentuale(1, 3)).toBe(33);
    expect(percentuale(1, 0)).toBe(0);
    expect(giudizio(r(90, 6, 100))).toBe("bene");
    expect(giudizio(r(60, 10, 100))).toBe("attenzione");
    expect(giudizio(r(40, 10, 100))).toBe("grave");
  });

  it("il tipo di giorno proposto: quello dell'unità del progetto, altrimenti il primo", () => {
    const t = (chiave: string, date: string[]): TipoDiGiorno => ({ chiave, nomi: [chiave], date, turniGuida: 1, turniMacchina: 1 });
    const tipi = [t("feriale", ["2026-12-01", "2026-12-02", "2026-12-03"]), t("sabato", ["2026-12-05", "2026-12-12"])];
    expect(tipoProposto(tipi, ["2026-12-05", "2026-12-12"], "2026-12-06")).toEqual({ tipo: tipi[1], data: "2026-12-12" });
    expect(tipoProposto(tipi, undefined, "2026-12-02")).toEqual({ tipo: tipi[0], data: "2026-12-02" });
    expect(tipoProposto(tipi, ["2027-03-01"], "2026-12-01")).toEqual({ tipo: tipi[0], data: "2026-12-01" });
    expect(tipoProposto([], undefined, "2026-12-01")).toBeNull();
  });
});
