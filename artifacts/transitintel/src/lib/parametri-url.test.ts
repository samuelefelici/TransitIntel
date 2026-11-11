import { describe, it, expect } from "vitest";
import { conParametri } from "./parametri-url";

/* Gli indirizzi delle sette letture di traffico, meteo e analisi sono quelli
 * che costruiva il client generato (tolto con la PR 2.13a): stessi parametri,
 * stessa codifica, niente punto di domanda quando non ce ne sono. */
describe("conParametri", () => {
  it("senza parametri, o con soli parametri non dati, resta il percorso", () => {
    expect(conParametri("/api/traffic/stats")).toBe("/api/traffic/stats");
    expect(conParametri("/api/poi", {})).toBe("/api/poi");
    expect(conParametri("/api/poi", { categories: undefined })).toBe("/api/poi");
  });

  it("i parametri dati vanno nell'indirizzo, nell'ordine in cui sono scritti", () => {
    expect(conParametri("/api/weather/correlation", { hours: 168 })).toBe("/api/weather/correlation?hours=168");
    expect(conParametri("/api/analysis/underserved", { minScore: 3 })).toBe("/api/analysis/underserved?minScore=3");
    expect(conParametri("/x", { a: 1, b: undefined, c: false })).toBe("/x?a=1&c=false");
  });

  it("i valori si codificano; null si scrive «null», come faceva il client generato", () => {
    expect(conParametri("/api/poi", { categories: "scuole,ospedali & altro" })).toBe("/api/poi?categories=scuole%2Cospedali+%26+altro");
    expect(conParametri("/x", { a: null })).toBe("/x?a=null");
  });
});
