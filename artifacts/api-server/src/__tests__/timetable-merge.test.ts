import { describe, it, expect } from "vitest";
import { mergeStopPatterns, type PatternStop } from "../lib/timetable-merge";

const S = (...ids: string[]): PatternStop[] => ids.map((id) => ({ stopId: id, stopName: `Fermata ${id}` }));
const ids = (out: PatternStop[]) => out.map((s) => s.stopId);

describe("mergeStopPatterns", () => {
  it("identical patterns → same order", () => {
    expect(ids(mergeStopPatterns([S("A", "B", "C"), S("A", "B", "C")]))).toEqual(["A", "B", "C"]);
  });

  it("trip skipping a stop keeps the full order", () => {
    // corsa veloce salta B: l'ordine master resta A B C D
    expect(ids(mergeStopPatterns([S("A", "B", "C", "D"), S("A", "C", "D")]))).toEqual(["A", "B", "C", "D"]);
  });

  it("trip with extra stop inserts it in the right relative position", () => {
    // la deviazione aggiunge X tra B e C
    const out = ids(mergeStopPatterns([S("A", "B", "C", "D"), S("A", "B", "X", "C", "D")]));
    expect(out.indexOf("X")).toBeGreaterThan(out.indexOf("B"));
    expect(out.indexOf("X")).toBeLessThan(out.indexOf("C"));
    expect(out).toHaveLength(5);
  });

  it("disjoint tails are both kept", () => {
    // due rami dopo B (capolinea diversi)
    const out = ids(mergeStopPatterns([S("A", "B", "C"), S("A", "B", "Z")]));
    expect(out.slice(0, 2)).toEqual(["A", "B"]);
    expect(out).toContain("C");
    expect(out).toContain("Z");
  });

  it("contradictory patterns (cycle) still include every stop once", () => {
    // B→C in una corsa, C→B nell'altra: impossibile rispettare entrambe
    const out = ids(mergeStopPatterns([S("A", "B", "C"), S("A", "C", "B")]));
    expect(new Set(out).size).toBe(3);
    expect(out).toHaveLength(3);
    expect(out[0]).toBe("A");
  });

  it("empty input → empty output", () => {
    expect(mergeStopPatterns([])).toEqual([]);
  });

  it("preserves stop names", () => {
    const out = mergeStopPatterns([S("A", "B")]);
    expect(out[0].stopName).toBe("Fermata A");
  });
});
