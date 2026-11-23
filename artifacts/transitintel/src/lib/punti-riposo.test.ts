import { describe, it, expect } from "vitest";
import { corpoPunto, erroriPunto, fermateDelModulo, MODULO_PUNTO_VUOTO, moduloPuntoDa, serviziInBreve } from "./punti-riposo";

describe("i punti di riposo nel modulo", () => {
  it("le fermate: una per riga o col punto e virgola, senza vuoti né doppioni (anche con maiuscole diverse)", () => {
    expect(fermateDelModulo("Capolinea Nord\n  ; Piazza\ncapolinea nord\n\n")).toEqual(["Capolinea Nord", "Piazza"]);
  });

  it("il corpo per l'API e il modulo da un punto salvato", () => {
    const m = { nome: "  Capolinea  ", conServizi: true, fermate: "A\nB", nota: " bagno " };
    expect(corpoPunto(m)).toEqual({ nome: "Capolinea", conServizi: true, fermate: ["A", "B"], nota: "bagno" });
    expect(moduloPuntoDa({ id: "x", nome: "N", conServizi: false, fermate: ["A", "B"], nota: "", fermateNonTrovate: [] }))
      .toEqual({ nome: "N", conServizi: false, fermate: "A\nB", nota: "" });
  });

  it("che cosa manca: nome e almeno una fermata", () => {
    expect(erroriPunto(MODULO_PUNTO_VUOTO)).toEqual([
      "Scrivi il nome del luogo.",
      "Scrivi almeno una fermata: il calcolo riconosce il luogo dalle sue fermate.",
    ]);
    expect(erroriPunto({ nome: "Capolinea", conServizi: false, fermate: "A", nota: "" })).toEqual([]);
    expect(erroriPunto({ nome: "x".repeat(121), conServizi: false, fermate: "A", nota: "" })).toEqual(["Il nome è al più di 120 caratteri."]);
  });

  it("in breve", () => {
    expect(serviziInBreve({ conServizi: true })).toBe("con servizi");
    expect(serviziInBreve({ conServizi: false })).toBe("senza servizi");
  });
});
