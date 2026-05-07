/**
 * PR3+PR4 — test puri sulle helper extracted in validity-matrix-shared:
 *  - mapCalendarPatternToSystemDayTypes
 *  - validateGenerateUnitInput
 *  - validateBulkOpInput
 *  - isUUID / isISODate
 *
 * NB: gli endpoint REST (handler Express) richiederebbero un Postgres reale
 * o testcontainers; qui copriamo la logica pura che concentra >90% dei bug
 * realistici (validation + mapping).
 */
import { describe, it, expect } from "vitest";
import {
  mapCalendarPatternToSystemDayTypes,
  validateGenerateUnitInput,
  validateBulkOpInput,
  isUUID,
  isISODate,
} from "../lib/validity-matrix-shared";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const UUID_C = "33333333-3333-4333-8333-333333333333";

describe("validators puri", () => {
  it("isUUID accetta v4 maiuscole/minuscole, rifiuta tutto il resto", () => {
    expect(isUUID(UUID_A)).toBe(true);
    expect(isUUID(UUID_A.toUpperCase())).toBe(true);
    expect(isUUID("not-a-uuid")).toBe(false);
    expect(isUUID(123)).toBe(false);
    expect(isUUID(null)).toBe(false);
    expect(isUUID(undefined)).toBe(false);
  });
  it("isISODate accetta YYYY-MM-DD", () => {
    expect(isISODate("2026-01-15")).toBe(true);
    expect(isISODate("2026-1-1")).toBe(false);
    expect(isISODate("15/01/2026")).toBe(false);
    expect(isISODate(20260115)).toBe(false);
  });
});

describe("mapCalendarPatternToSystemDayTypes (PR3 auto-import)", () => {
  it("pattern lun-ven → solo 'feriale'", () => {
    expect(mapCalendarPatternToSystemDayTypes({
      monday: true, tuesday: true, wednesday: true, thursday: true, friday: true,
      saturday: false, sunday: false,
    })).toEqual(["feriale"]);
  });
  it("pattern parziale lun-mer → 'feriale'", () => {
    expect(mapCalendarPatternToSystemDayTypes({
      monday: true, tuesday: true, wednesday: true, thursday: false, friday: false,
      saturday: false, sunday: false,
    })).toEqual(["feriale"]);
  });
  it("solo sabato", () => {
    expect(mapCalendarPatternToSystemDayTypes({
      monday: false, tuesday: false, wednesday: false, thursday: false, friday: false,
      saturday: true, sunday: false,
    })).toEqual(["sabato"]);
  });
  it("solo domenica → 'festivo'", () => {
    expect(mapCalendarPatternToSystemDayTypes({
      monday: false, tuesday: false, wednesday: false, thursday: false, friday: false,
      saturday: false, sunday: true,
    })).toEqual(["festivo"]);
  });
  it("tutti i giorni → ['feriale','sabato','festivo'] in ordine", () => {
    expect(mapCalendarPatternToSystemDayTypes({
      monday: true, tuesday: true, wednesday: true, thursday: true, friday: true,
      saturday: true, sunday: true,
    })).toEqual(["feriale", "sabato", "festivo"]);
  });
  it("pattern vuoto → []", () => {
    expect(mapCalendarPatternToSystemDayTypes({
      monday: false, tuesday: false, wednesday: false, thursday: false, friday: false,
      saturday: false, sunday: false,
    })).toEqual([]);
  });
  it("sabato + domenica (weekend only)", () => {
    expect(mapCalendarPatternToSystemDayTypes({
      monday: false, tuesday: false, wednesday: false, thursday: false, friday: false,
      saturday: true, sunday: true,
    })).toEqual(["sabato", "festivo"]);
  });
});

describe("validateGenerateUnitInput (PR4)", () => {
  const baseValid = {
    name: "Inverno 2026",
    from: "2026-01-01",
    to: "2026-03-31",
    dayTypeIds: [UUID_A, UUID_B],
  };

  it("payload valido base", () => {
    const r = validateGenerateUnitInput(baseValid);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.name).toBe("Inverno 2026");
      expect(r.value.includeOnlyValid).toBe(true); // default
      expect(r.value.dayTypeIds).toHaveLength(2);
    }
  });

  it("trim del nome", () => {
    const r = validateGenerateUnitInput({ ...baseValid, name: "  Estate 2026  " });
    expect(r.ok && r.value.name).toBe("Estate 2026");
  });

  it("includeOnlyValid esplicito false viene preservato", () => {
    const r = validateGenerateUnitInput({ ...baseValid, includeOnlyValid: false });
    expect(r.ok && r.value.includeOnlyValid).toBe(false);
  });

  it("rifiuta name vuoto", () => {
    const r = validateGenerateUnitInput({ ...baseValid, name: "   " });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/name/);
  });

  it("rifiuta from/to invertiti", () => {
    const r = validateGenerateUnitInput({ ...baseValid, from: "2026-12-31", to: "2026-01-01" });
    expect(r.ok).toBe(false);
  });

  it("rifiuta date malformate", () => {
    const r = validateGenerateUnitInput({ ...baseValid, from: "2026/01/01" });
    expect(r.ok).toBe(false);
  });

  it("rifiuta dayTypeIds vuoto", () => {
    const r = validateGenerateUnitInput({ ...baseValid, dayTypeIds: [] });
    expect(r.ok).toBe(false);
  });

  it("rifiuta dayTypeIds con elementi non-UUID", () => {
    const r = validateGenerateUnitInput({ ...baseValid, dayTypeIds: [UUID_A, "x"] });
    expect(r.ok).toBe(false);
  });

  it("rifiuta body null/non-object", () => {
    expect(validateGenerateUnitInput(null).ok).toBe(false);
    expect(validateGenerateUnitInput("string").ok).toBe(false);
  });
});

describe("validateBulkOpInput (PR3)", () => {
  it("trip-row-set valido", () => {
    const r = validateBulkOpInput({
      op: "trip-row-set", tripId: UUID_A, dayTypeIds: [UUID_B, UUID_C], isValid: true,
    });
    expect(r.ok).toBe(true);
    if (r.ok && r.value.op === "trip-row-set") {
      expect(r.value.tripId).toBe(UUID_A);
      expect(r.value.dayTypeIds).toHaveLength(2);
    }
  });

  it("date-column-set valido", () => {
    const r = validateBulkOpInput({ op: "date-column-set", date: "2026-04-25", isValid: false });
    expect(r.ok).toBe(true);
  });

  it("period-fill valido", () => {
    const r = validateBulkOpInput({
      op: "period-fill", periodId: UUID_A, dayTypeIds: [UUID_B], isValid: true,
    });
    expect(r.ok).toBe(true);
  });

  it("clear-exceptions valido", () => {
    const r = validateBulkOpInput({
      op: "clear-exceptions", from: "2026-01-01", to: "2026-12-31",
    });
    expect(r.ok).toBe(true);
  });

  it("rifiuta op sconosciuto", () => {
    const r = validateBulkOpInput({ op: "wat" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/op sconosciuto/);
  });

  it("rifiuta trip-row-set senza tripId", () => {
    const r = validateBulkOpInput({ op: "trip-row-set", dayTypeIds: [UUID_A], isValid: true });
    expect(r.ok).toBe(false);
  });

  it("rifiuta trip-row-set con dayTypeIds vuoto", () => {
    const r = validateBulkOpInput({
      op: "trip-row-set", tripId: UUID_A, dayTypeIds: [], isValid: true,
    });
    expect(r.ok).toBe(false);
  });

  it("rifiuta trip-row-set senza isValid bool", () => {
    const r = validateBulkOpInput({
      op: "trip-row-set", tripId: UUID_A, dayTypeIds: [UUID_B], isValid: "true",
    });
    expect(r.ok).toBe(false);
  });

  it("rifiuta date-column-set con data invalida", () => {
    const r = validateBulkOpInput({ op: "date-column-set", date: "26-04-25", isValid: true });
    expect(r.ok).toBe(false);
  });

  it("rifiuta period-fill senza periodId UUID", () => {
    const r = validateBulkOpInput({
      op: "period-fill", periodId: "x", dayTypeIds: [UUID_A], isValid: true,
    });
    expect(r.ok).toBe(false);
  });

  it("rifiuta clear-exceptions con range invertito", () => {
    const r = validateBulkOpInput({
      op: "clear-exceptions", from: "2026-12-31", to: "2026-01-01",
    });
    expect(r.ok).toBe(false);
  });

  it("rifiuta body senza op", () => {
    expect(validateBulkOpInput({}).ok).toBe(false);
    expect(validateBulkOpInput(null).ok).toBe(false);
  });
});
