import { describe, expect, it } from "vitest";
import { dettaglioSolaLettura, frenoAvvisi, rifiutoDiSolaLettura } from "./sola-lettura";

describe("rifiutoDiSolaLettura", () => {
  it("lo riconosce dal campo, non dal testo", () => {
    expect(rifiutoDiSolaLettura(403, { error: "Sola lettura: per modificare serve la scrittura su «Turni»", solaLettura: true }))
      .toEqual({ messaggio: "Sola lettura: per modificare serve la scrittura su «Turni»" });
    // il testo da solo non basta: un handler può dire «Sola lettura» per altri motivi
    expect(rifiutoDiSolaLettura(403, { error: "Sola lettura: per modificare serve la scrittura su «Turni»" })).toBeNull();
    expect(rifiutoDiSolaLettura(403, { error: "Manca l'accesso a «Turni»" })).toBeNull();
    expect(rifiutoDiSolaLettura(403, { solaLettura: "true" })).toBeNull();
  });

  it("solo sui 403", () => {
    expect(rifiutoDiSolaLettura(200, { solaLettura: true })).toBeNull();
    expect(rifiutoDiSolaLettura(401, { solaLettura: true })).toBeNull();
    expect(rifiutoDiSolaLettura(500, { solaLettura: true })).toBeNull();
  });

  it("non si rompe con corpi strani, e senza messaggio ne dà uno suo", () => {
    for (const corpo of [null, undefined, "testo", 7, []]) expect(rifiutoDiSolaLettura(403, corpo)).toBeNull();
    expect(rifiutoDiSolaLettura(403, { solaLettura: true })?.messaggio).toMatch(/^Sola lettura/);
    expect(rifiutoDiSolaLettura(403, { solaLettura: true, error: { x: 1 } })?.messaggio).toMatch(/^Sola lettura/);
    expect(rifiutoDiSolaLettura(403, { solaLettura: true, error: "x".repeat(900) })?.messaggio).toHaveLength(300);
  });
});

describe("dettaglioSolaLettura", () => {
  it("toglie il prefisso e mette la maiuscola", () => {
    expect(dettaglioSolaLettura("Sola lettura: per modificare serve la scrittura su «Turni»")).toBe("Per modificare serve la scrittura su «Turni»");
    expect(dettaglioSolaLettura("Un altro testo")).toBe("Un altro testo");
    expect(dettaglioSolaLettura("Sola lettura:")).toBe("");
  });
});

describe("frenoAvvisi", () => {
  it("lo stesso messaggio non si ripete prima del tempo", () => {
    const annuncia = frenoAvvisi(4000);
    expect(annuncia("a", 1000)).toBe(true);
    expect(annuncia("a", 2000)).toBe(false);
    expect(annuncia("a", 4999)).toBe(false);
    expect(annuncia("a", 5000)).toBe(true);
  });
  it("un messaggio diverso passa subito", () => {
    const annuncia = frenoAvvisi(4000);
    expect(annuncia("turni", 1000)).toBe(true);
    expect(annuncia("roster", 1100)).toBe(true);
    expect(annuncia("roster", 1200)).toBe(false);
  });
});
