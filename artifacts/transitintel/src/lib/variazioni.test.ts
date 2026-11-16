import { describe, it, expect } from "vitest";
import { descrivi, elenco, leggiFasce } from "./variazioni";

describe("variazioni decise in anticipo", () => {
  it("linee e numeri: separati da virgole o spazi, senza doppioni", () => {
    expect(elenco(" 1, 2/3 ,30 30;  ")).toEqual(["1", "2/3", "30"]);
    expect(elenco("")).toEqual([]);
  });
  it("le fasce garantite: con o senza minuti, col punto o i due punti", () => {
    expect(leggiFasce("6-9, 12:00-15.30")).toEqual([{ dalle: "06:00", alle: "09:00" }, { dalle: "12:00", alle: "15:30" }]);
    expect(leggiFasce("06:00 – 09:00")).toEqual([{ dalle: "06:00", alle: "09:00" }]);
    expect(leggiFasce("")).toBeNull();
    expect(leggiFasce("dalle 6 alle 9")).toBeNull();
    expect(leggiFasce("6-9, 12")).toBeNull();
  });
  it("in poche parole", () => {
    expect(descrivi({ tipo: "sciopero", linee: [], numeri: [], dalle: null, alle: null, fasce: [{ dalle: "06:00", alle: "09:00" }, { dalle: "12:00", alle: "15:00" }] }))
      .toBe("Sciopero, tutte le linee: garantite 06:00–09:00 e 12:00–15:00");
    expect(descrivi({ tipo: "soppressione", linee: ["1", "2"], numeri: [], dalle: "08:00", alle: "10:00", fasce: null }))
      .toBe("Soppressione: linee 1, 2, partenze 08:00–10:00");
    expect(descrivi({ tipo: "soppressione", linee: [], numeri: ["477789"], dalle: null, alle: null, fasce: null }))
      .toBe("Soppressione: corsa n. 477789, tutto il giorno");
  });
});
