import { describe, it, expect } from "vitest";
import { easterDate, italianHolidays, classifyDate, classifyRange, type CalendarProfile } from "../lib/day-classifier";

// Modello standardizzato: si dichiarano i periodi di SCUOLE CHIUSE (vacanze),
// tutto il resto è scuole aperte. Equivale alle vecchie "scuole aperte" dal
// 07/01 al 06/06 e dal 15/09 al 22/12.
const PROFILE: CalendarProfile = {
  closedPeriods: [
    { from: "2026-01-01", to: "2026-01-06" }, // vacanze di inizio anno
    { from: "2026-06-07", to: "2026-09-14" }, // estate (parte estivo, parte inv.)
    { from: "2026-12-23", to: "2026-12-31" }, // vacanze di Natale
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
  it("domenica scuole aperte → festivo · domenica_aperte", () => {
    const c = classifyDate("2026-03-15", PROFILE); // domenica fuori dai periodi chiusi
    expect(c.level1).toBe("festivo");
    expect(c.level2).toBe("domenica_aperte");
  });
  it("domenica in periodo scuole chiuse → festivo · domenica_chiuse", () => {
    const c = classifyDate("2026-07-12", PROFILE); // domenica d'estate (scuole chiuse)
    expect(c.level1).toBe("festivo");
    expect(c.level2).toBe("domenica_chiuse");
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

describe("classifyDate — tipo per periodo (kind), più periodi invernali", () => {
  // Nuovo modello: ogni periodo di scuole chiuse porta il proprio `kind`.
  // Niente summerPeriod: si possono avere PIÙ periodi invernali.
  const PROFILE_KIND: CalendarProfile = {
    closedPeriods: [
      { from: "2026-01-01", to: "2026-01-06", kind: "invernale", label: "Befana" },
      { from: "2026-04-03", to: "2026-04-07", kind: "invernale", label: "Pasqua" },
      { from: "2026-06-08", to: "2026-09-14", kind: "estivo", label: "Estivo" },
      { from: "2026-12-23", to: "2026-12-31", kind: "invernale", label: "Natale" },
    ],
    summerPeriod: null,
    extraHolidays: [],
  };

  it("periodo con kind=estivo → estivo (senza summerPeriod)", () => {
    const c = classifyDate("2026-07-15", PROFILE_KIND); // mercoledì
    expect(c.level1).toBe("scuole_chiuse");
    expect(c.level2).toBe("estivo");
  });
  it("primo periodo invernale (gennaio) → invernale", () => {
    const c = classifyDate("2026-01-02", PROFILE_KIND); // venerdì
    expect(c.level2).toBe("invernale");
  });
  it("secondo periodo invernale (Pasqua) → invernale", () => {
    const c = classifyDate("2026-04-03", PROFILE_KIND); // venerdì, non rosso
    expect(c.level1).toBe("scuole_chiuse");
    expect(c.level2).toBe("invernale");
  });
  it("terzo periodo invernale (Natale) → invernale", () => {
    const c = classifyDate("2026-12-28", PROFILE_KIND); // lunedì
    expect(c.level2).toBe("invernale");
  });
  it("il kind esplicito vince sul summerPeriod legacy", () => {
    // periodo dentro il vecchio summerPeriod ma marcato invernale → invernale
    const mixed: CalendarProfile = {
      closedPeriods: [{ from: "2026-07-01", to: "2026-07-31", kind: "invernale" }],
      summerPeriod: { from: "2026-06-15", to: "2026-09-14" },
      extraHolidays: [],
    };
    const c = classifyDate("2026-07-15", mixed); // mercoledì
    expect(c.level2).toBe("invernale");
  });
});

describe("classifyRange — copertura totale e riepilogo", () => {
  it("ogni giorno dell'anno ha esattamente una foglia", () => {
    const { days, summary } = classifyRange("2026-01-01", "2026-12-31", PROFILE);
    expect(days).toHaveLength(365);
    expect(summary.reduce((s, x) => s + x.count, 0)).toBe(365);
    // foglie tipiche (~9): sc.aperte fer/sab, sc.chiuse inv fer/sab, sc.chiuse
    // est fer/sab, domenica aperte/chiuse, rossi — mai esplosione di unità
    expect(summary.length).toBeLessThanOrEqual(10);
    expect(summary.length).toBeGreaterThanOrEqual(5);
  });
});
