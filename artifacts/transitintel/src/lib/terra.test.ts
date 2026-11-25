import { describe, it, expect } from "vitest";
import { eTerra, grigliaTerre } from "./terra";

describe("le terre emerse del globo", () => {
  it("una griglia di un grado, 180 righe per 360 colonne", () => {
    expect(grigliaTerre()).toHaveLength(180 * 360);
  });

  it("i continenti sono terra, gli oceani mare", () => {
    expect(eTerra(23, 10)).toBe(true); // Sahara
    expect(eTerra(-25, 134)).toBe(true); // Australia
    expect(eTerra(-10, -55)).toBe(true); // Brasile
    expect(eTerra(60, 100)).toBe(true); // Siberia
    expect(eTerra(0, -150)).toBe(false); // Pacifico
    expect(eTerra(30, -40)).toBe(false); // Atlantico
    expect(eTerra(-30, 80)).toBe(false); // Indiano
  });

  it("le terre sono circa tre decimi della superficie", () => {
    const g = grigliaTerre();
    let terra = 0, tutto = 0;
    for (let r = 0; r < 180; r++) {
      const peso = Math.cos(((89.5 - r) * Math.PI) / 180);
      for (let c = 0; c < 360; c++) { tutto += peso; if (g[r * 360 + c]) terra += peso; }
    }
    expect(terra / tutto).toBeGreaterThan(0.25);
    expect(terra / tutto).toBeLessThan(0.34);
  });

  it("la longitudine si avvolge: 180 e -180 sono la stessa colonna", () => {
    expect(eTerra(65, 180)).toBe(eTerra(65, -180));
    expect(eTerra(10, 370)).toBe(eTerra(10, 10));
  });
});
