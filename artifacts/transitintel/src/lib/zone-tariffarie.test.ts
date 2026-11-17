import { describe, it, expect } from "vitest";
import { notaFermateTolte, riassuntoZoneGenerate } from "./zone-tariffarie";

describe("il riassunto delle zone generate", () => {
  it("dice quante zone urbane ed extraurbane, e su quante linee", () => {
    expect(riassuntoZoneGenerate({ urbanAreas: 6, totalZones: 412, extraurbanRoutes: 64 }))
      .toBe("6 aree urbane + 412 zone extraurbane su 64 linee");
    expect(riassuntoZoneGenerate({ urbanAreas: 6, totalZones: 3, extraurbanRoutes: 1, urbanStopsRemoved: 0 }))
      .toBe("6 aree urbane + 3 zone extraurbane su 1 linea");
  });

  it("dice quante fermate ha tolto dalla zona sbagliata", () => {
    expect(riassuntoZoneGenerate({ urbanAreas: 6, totalZones: 412, extraurbanRoutes: 64, urbanStopsAdded: 290, urbanStopsRemoved: 290 }))
      .toBe("6 aree urbane + 412 zone extraurbane su 64 linee. 290 fermate tolte da una zona urbana che non era la sua.");
    expect(riassuntoZoneGenerate({ urbanAreas: 6, totalZones: 0, extraurbanRoutes: 0, urbanStopsRemoved: 1 }))
      .toBe("6 aree urbane + 0 zone extraurbane su 0 linee. Una fermata tolta da una zona urbana che non era la sua.");
  });

  it("la frase sulle fermate tolte è vuota se non ce n'erano", () => {
    for (const v of [0, null, undefined, -3]) expect(notaFermateTolte(v), String(v)).toBe("");
    expect(notaFermateTolte(56)).toBe(". 56 fermate tolte da una zona urbana che non era la sua.");
  });

  it("raggruppa le migliaia all'italiana", () => {
    expect(riassuntoZoneGenerate({ urbanAreas: 6, totalZones: 12345, extraurbanRoutes: 64 })).toContain("12.345 zone extraurbane");
  });
});
