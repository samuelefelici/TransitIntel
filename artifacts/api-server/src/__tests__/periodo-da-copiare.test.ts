/**
 * Quando i calendari importati passano nella matrice di validità, il loro
 * periodo diventa quello delle corse, ma non quello di un giorno solo (tappa
 * 6.46): è il giorno di un'esportazione, e chiuderebbe le corse in quel giorno.
 */
import { describe, it, expect } from "vitest";
import { periodoDaCopiare } from "../lib/planning-studio-validity";

describe("Il periodo dei calendari importati", () => {
  it("un orario stagionale resta il periodo delle corse", () => {
    expect(periodoDaCopiare("2026-06-15", "2026-09-15")).toBe(true);
    expect(periodoDaCopiare("2026-12-05", "2026-12-06")).toBe(true);
  });
  it("un giorno solo, o un calendario senza date, no", () => {
    expect(periodoDaCopiare("2025-12-05", "2025-12-05")).toBe(false);
    expect(periodoDaCopiare(null, "2026-09-15")).toBe(false);
    expect(periodoDaCopiare("2026-06-15", undefined)).toBe(false);
  });
});
