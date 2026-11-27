/**
 * Le regole del calcolo unico delle tratte osservate — collaudo senza
 * database. Il caso vero: a Piazza Cavour i bus si fermano a regolare, e il
 * tratto Cavour → P.le Libertà (51″ in orario) risultava di 294″.
 */
import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import {
  FASCE, fasciaDi, fasciaSql, etichettaFascia, sostaEccedente, giornateFinestra, classiDelleGiornate,
  SOSTA_NORMALE_S,
} from "../lib/tratte-osservate";

describe("le fasce orarie", () => {
  it("coprono le 24 ore senza buchi né sovrapposizioni", () => {
    for (let h = 0; h < 24; h++) {
      expect(FASCE.filter(f => h >= f.da && h < f.a)).toHaveLength(1);
    }
    expect(FASCE[0].da).toBe(0);
    expect(FASCE[FASCE.length - 1].a).toBe(24);
  });

  it("le ore di punta e le ore dopo la mezzanotte del GTFS", () => {
    expect(fasciaDi(7)).toBe("punta_mattino");
    expect(fasciaDi(9)).toBe("morbida");
    expect(fasciaDi(17)).toBe("punta_pomeriggio");
    expect(fasciaDi(23)).toBe("sera");
    expect(fasciaDi(24)).toBe("notte");   // 24:20 del GTFS = 00:20
    expect(fasciaDi(25)).toBe("notte");
    expect(etichettaFascia("punta_mattino")).toMatch(/6–9/);
    expect(etichettaFascia("boh")).toBeNull();
  });

  it("la regola in SQL è generata dalle stesse fasce", () => {
    const q = new PgDialect().sqlToQuery(fasciaSql(sql`x.ora`));
    expect(q.sql).toMatch(/^\(CASE WHEN x\.ora >= \$1 AND x\.ora < \$2 THEN \$3/);
    expect(q.params).toEqual([...FASCE.flatMap(f => [f.da, f.a, f.codice]), FASCE[0].codice]);
  });
});

describe("la sosta di regolazione", () => {
  it("resta nel tratto fino alla soglia, oltre si toglie", () => {
    expect(sostaEccedente(20)).toBe(0);
    expect(sostaEccedente(SOSTA_NORMALE_S)).toBe(0);
    expect(sostaEccedente(SOSTA_NORMALE_S + 183)).toBe(183);
    expect(sostaEccedente(null)).toBe(0);
    expect(sostaEccedente(Number.NaN)).toBe(0);
  });
});

describe("le giornate e i loro tipi", () => {
  it("la finestra finisce oggi, compreso, e attraversa i cambi di mese", () => {
    expect(giornateFinestra("2026-12-02", 4)).toEqual(["2026-11-29", "2026-11-30", "2026-12-01", "2026-12-02"]);
    expect(giornateFinestra("2026-12-02", 0)).toEqual(["2026-12-02"]);
  });

  it("raggruppa per tipo, dal più frequente", () => {
    const tipo = (d: string) => new Date(`${d}T12:00:00Z`).getUTCDay() === 0
      ? { key: "festivo/domenica_aperte/-", label: "Domenica" }
      : { key: "scuole_aperte/-/Feriale", label: "Feriale" };
    const c = classiDelleGiornate(giornateFinestra("2026-12-02", 10), tipo);
    expect(c.map(x => x.key)).toEqual(["scuole_aperte/-/Feriale", "festivo/domenica_aperte/-"]);
    expect(c[1].giorni).toEqual(["2026-11-29"]);
    expect(c[0].giorni).toHaveLength(9);
  });
});
