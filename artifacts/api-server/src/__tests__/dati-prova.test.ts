import { describe, it, expect } from "vitest";
import { datiProvaAttivi } from "../lib/dati-prova";

describe("i dati di prova", () => {
  it("solo con CERBERO_DATI_PROVA=1", () => {
    expect(datiProvaAttivi({})).toBe(false);
    expect(datiProvaAttivi({ CERBERO_DATI_PROVA: "0" })).toBe(false);
    expect(datiProvaAttivi({ CERBERO_DATI_PROVA: "true" })).toBe(false);
    expect(datiProvaAttivi({ CERBERO_DATI_PROVA: "1" })).toBe(true);
  });
});
