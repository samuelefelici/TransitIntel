/**
 * PlannerStudio · Validity Matrix · test algoritmo cell value (PR1).
 * Spec Cerbero §5 — 6 casi obbligatori.
 */
import { describe, it, expect } from "vitest";
import {
  getCellValidity,
  inferDefaultDayType,
  italianHolidays,
  type DayType,
  type Trip,
  type MatrixContext,
} from "../lib/validity-matrix-shared";

const DT: Record<string, DayType> = {
  feriale:  { id: "dt-feriale",  code: "feriale",  name: "Feriale",  color: "#3b82f6", is_system: true },
  sabato:   { id: "dt-sabato",   code: "sabato",   name: "Sabato",   color: "#06b6d4", is_system: true },
  festivo:  { id: "dt-festivo",  code: "festivo",  name: "Festivo",  color: "#ef4444", is_system: true },
};

function buildCtx(overrides: Partial<MatrixContext> = {}): MatrixContext {
  return {
    trips: new Map(),
    dayTypes: new Map(Object.values(DT).map((d) => [d.id, d])),
    tripDayValidity: new Map(),
    dayCalendar: new Map(),
    tripExceptions: new Map(),
    patronSaints: new Set(),
    ...overrides,
  };
}

function makeTrip(id: string, opts: Partial<Trip> = {}): Trip {
  return { id, is_active: true, valid_from: null, valid_to: null, ...opts };
}

describe("validity-matrix · getCellValidity", () => {
  it("[1] eccezione 'add' (1) su corsa altrimenti invalida → true", () => {
    const ctx = buildCtx({
      trips: new Map([["t1", makeTrip("t1")]]),
      tripExceptions: new Map([["t1", new Map([["2025-03-15", 1]])]]),
      // Nessuna validity in tripDayValidity → default false, ma l'eccezione vince
    });
    expect(getCellValidity(ctx, "t1", "2025-03-15")).toBe(true);
  });

  it("[2] eccezione 'remove' (2) su corsa altrimenti valida → false", () => {
    const ctx = buildCtx({
      trips: new Map([["t1", makeTrip("t1")]]),
      // 15 marzo 2025 è sabato → mappa a sabato
      tripDayValidity: new Map([["t1", new Map([[DT.sabato.id, true]])]]),
      tripExceptions: new Map([["t1", new Map([["2025-03-15", 2]])]]),
    });
    expect(getCellValidity(ctx, "t1", "2025-03-15")).toBe(false);
  });

  it("[3] data fuori valid_from/valid_to → false anche con day-type valido", () => {
    const ctx = buildCtx({
      trips: new Map([["t1", makeTrip("t1", { valid_from: "2025-04-01", valid_to: "2025-04-30" })]]),
      tripDayValidity: new Map([["t1", new Map([
        [DT.feriale.id, true], [DT.sabato.id, true], [DT.festivo.id, true],
      ])]]),
    });
    // 2025-03-31 è LUN, day-type feriale e validity=true, ma fuori range trip
    expect(getCellValidity(ctx, "t1", "2025-03-31")).toBe(false);
    // dentro range invece passa
    expect(getCellValidity(ctx, "t1", "2025-04-01")).toBe(true);
  });

  it("[4] domenica senza override → mappa a 'festivo'", () => {
    const ctx = buildCtx();
    // 2025-03-16 è domenica
    expect(inferDefaultDayType("2025-03-16", ctx)).toBe(DT.festivo.id);
    expect(inferDefaultDayType("2025-03-15", ctx)).toBe(DT.sabato.id);
    expect(inferDefaultDayType("2025-03-17", ctx)).toBe(DT.feriale.id);
  });

  it("[5] patrono locale (mmdd) → mappa a 'festivo'", () => {
    const ctx = buildCtx({ patronSaints: new Set(["09-29"]) });
    // 2025-09-29 è LUN feriale, ma patrono lo rende festivo
    expect(inferDefaultDayType("2025-09-29", ctx)).toBe(DT.festivo.id);
  });

  it("[6] trip senza riga in tripDayValidity per quel day-type → false (non null)", () => {
    const ctx = buildCtx({
      trips: new Map([["t1", makeTrip("t1")]]),
      // tripDayValidity vuoto: nessun default
    });
    const v = getCellValidity(ctx, "t1", "2025-03-17"); // lunedì, feriale
    expect(v).toBe(false);
    expect(typeof v).toBe("boolean");
  });

  it("italianHolidays · 2025 contiene Pasqua e Lunedì dell'Angelo", () => {
    const h = italianHolidays(2025);
    // Pasqua 2025 = 20 aprile, Pasquetta = 21 aprile
    expect(h).toContain("2025-04-20");
    expect(h).toContain("2025-04-21");
    expect(h).toContain("2025-01-01");
    expect(h).toContain("2025-12-25");
    expect(h).toContain("2025-12-26");
    expect(h.length).toBe(12);
  });
});
