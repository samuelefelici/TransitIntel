import { describe, it, expect } from "vitest";
import { easterDate, italianHolidays, classifyDate, classifyRange, type CalendarProfile } from "../lib/day-classifier";

const PROFILE: CalendarProfile = {
  schoolPeriods: [
    { from: "2026-01-07", to: "2026-06-06" },
    { from: "2026-09-15", to: "2026-12-22" },
  ],
  summerPeriod: { from: "2026-06-15", to: "2026-09-14" },
  extraHolidays: ["05-04"], // patrono (es. Ancona, San Ciriaco)
};

describe("easterDate", () => {
  it("known Easters", () => {
    expect(easterDate(2024)).toBe("2024-03-31");
    expect(easterDate(2025)).toBe("2025-04-20");
    expect(easterDate(2026)).toBe("2026-04-05");
  });
});

describe("italianHolidays", () => {
  it("includes fixed and Easter Monday", () => {
    const h = italianHolidays(2026);
    expect(h.has("2026-01-01")).toBe(true);
    expect(h.has("2026-04-06")).toBe(true);  // Pasquetta 2026
    expect(h.has("2026-12-26")).toBe(true);
    expect(h.has("2026-03-15")).toBe(false);
  });
});

describe("classifyDate — albero a 3 livelli", () => {
  it("rosso batte tutto (anche se cade in periodo scolastico)", () => {
    const c = classifyDate("2026-06-02", PROFILE); // Festa Repubblica, martedì, scuole aperte
    expect(c.level1).toBe("festivo");
    expect(c.level2).toBe("rosso");
  });
  it("domenica non rossa → festivo · domenica", () => {
    const c = classifyDate("2026-03-15", PROFILE);
    expect(c.level1).toBe("festivo");
    expect(c.level2).toBe("domenica");
  });
  it("feriale in periodo scolastico → scuole aperte", () => {
    const c = classifyDate("2026-03-16", PROFILE); // lunedì
    expect(c.level1).toBe("scuole_aperte");
    expect(c.label).toBe("Scuole Aperte · Feriale");
  });
  it("sabato scolastico distinto dal feriale", () => {
    const c = classifyDate("2026-03-21", PROFILE);
    expect(c.label).toBe("Scuole Aperte · Sabato");
  });
  it("scuole chiuse + periodo estivo → estivo", () => {
    const c = classifyDate("2026-07-15", PROFILE); // mercoledì
    expect(c.level1).toBe("scuole_chiuse");
    expect(c.level2).toBe("estivo");
  });
  it("scuole chiuse fuori estate → invernale (es. vacanze di Natale)", () => {
    const c = classifyDate("2026-12-28", PROFILE); // lunedì dopo Natale
    expect(c.level1).toBe("scuole_chiuse");
    expect(c.level2).toBe("invernale");
  });
  it("festività extra (patrono MM-DD) → rosso", () => {
    const c = classifyDate("2026-05-04", PROFILE); // lunedì, scuole aperte ma patrono
    expect(c.level2).toBe("rosso");
  });
});

describe("classifyRange — copertura totale e riepilogo", () => {
  it("ogni giorno dell'anno ha esattamente una foglia", () => {
    const { days, summary } = classifyRange("2026-01-01", "2026-12-31", PROFILE);
    expect(days).toHaveLength(365);
    expect(summary.reduce((s, x) => s + x.count, 0)).toBe(365);
    // le foglie tipiche: ~7 classi (sc.aperte fer/sab, sc.chiuse inv fer/sab,
    // sc.chiuse est fer/sab, dom, rossi) — mai esplosione di unità
    expect(summary.length).toBeLessThanOrEqual(8);
    expect(summary.length).toBeGreaterThanOrEqual(5);
  });
});
