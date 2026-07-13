/**
 * Planning Studio · validità effettiva → feed materializzato (5C).
 *
 * Testa la funzione PURA isTripActiveOnDate, cuore del feed calendar_dates-only.
 * È la stessa logica del compute UDP (validity-units.ts:444-478): questi casi
 * congelano la precedenza delle regole così un cambio accidentale la rompe qui.
 */
import { describe, it, expect } from "vitest";
import {
  isTripActiveOnDate,
  type TripValidityFacts,
  type DayFacts,
} from "../lib/planning-studio-validity-eval";

const DT_FERIALE = "dt-feriale";
const DT_SABATO = "dt-sabato";
const DT_FESTIVO = "dt-festivo";

/** corsa "base": attiva, nessun vincolo particolare */
function trip(over: Partial<TripValidityFacts> = {}): TripValidityFacts {
  return { isActive: true, validFrom: null, validTo: null, ...over };
}
function day(over: Partial<DayFacts> = {}): DayFacts {
  return { dayTypeId: DT_FERIALE, category: null, ...over };
}
const validFeriale = new Map([[DT_FERIALE, true]]);

describe("isTripActiveOnDate — precedenza regole", () => {
  it("feriale valido: attiva in un giorno feriale, spenta in sabato/festivo", () => {
    // 2026-07-13 è un lunedì
    expect(isTripActiveOnDate("2026-07-13", trip(), day({ dayTypeId: DT_FERIALE }), validFeriale)).toBe(true);
    expect(isTripActiveOnDate("2026-07-13", trip(), day({ dayTypeId: DT_SABATO }), validFeriale)).toBe(false);
    expect(isTripActiveOnDate("2026-07-13", trip(), day({ dayTypeId: DT_FESTIVO }), validFeriale)).toBe(false);
  });

  it("assenza di bollino day-validity = non circola", () => {
    expect(isTripActiveOnDate("2026-07-13", trip(), day(), new Map())).toBe(false);
  });

  it("nessun day-type per la data = non circola", () => {
    expect(isTripActiveOnDate("2026-07-13", trip(), day({ dayTypeId: null }), validFeriale)).toBe(false);
  });

  it("maschera weekdays spegne il giovedì pur essendo feriale valido", () => {
    // [Lun..Dom]; giovedì = indice 3 = false
    const wd = [true, true, true, false, true, true, true];
    // 2026-07-16 è un giovedì, 2026-07-15 un mercoledì
    expect(isTripActiveOnDate("2026-07-16", trip({ weekdays: wd }), day(), validFeriale)).toBe(false);
    expect(isTripActiveOnDate("2026-07-15", trip({ weekdays: wd }), day(), validFeriale)).toBe(true);
  });

  it("valid_from / valid_to limitano il periodo", () => {
    const t = trip({ validFrom: "2026-07-10", validTo: "2026-07-20" });
    expect(isTripActiveOnDate("2026-07-09", t, day(), validFeriale)).toBe(false);
    expect(isTripActiveOnDate("2026-07-13", t, day(), validFeriale)).toBe(true);
    expect(isTripActiveOnDate("2026-07-21", t, day(), validFeriale)).toBe(false);
  });

  it("is_active=false = non circola mai", () => {
    expect(isTripActiveOnDate("2026-07-13", trip({ isActive: false }), day(), validFeriale)).toBe(false);
  });

  it("eccezione force-ON vince su tutto (anche festivo senza bollino)", () => {
    expect(isTripActiveOnDate("2026-07-13", trip(), day({ dayTypeId: DT_FESTIVO, exception: 1 }), new Map())).toBe(true);
  });

  it("eccezione force-OFF vince anche su un feriale valido", () => {
    expect(isTripActiveOnDate("2026-07-13", trip(), day({ exception: 2 }), validFeriale)).toBe(false);
  });

  it("prototipo non circola mai", () => {
    expect(isTripActiveOnDate("2026-07-13", trip({ prototype: true }), day({ exception: 1 }), validFeriale)).toBe(false);
  });
});

describe("isTripActiveOnDate — vincolo categorie + ombrello scuole_chiuse", () => {
  const estivo = { id: "cat-estivo", code: "scuole_chiuse_estivo" };
  const aperte = { id: "cat-aperte", code: "scuole_aperte" };

  it("corsa vincolata a un periodo: vale solo nei giorni di quel periodo", () => {
    const t = trip({ categoryIds: new Set(["cat-estivo"]) });
    expect(isTripActiveOnDate("2026-07-13", t, day({ category: estivo }), validFeriale)).toBe(true);
    expect(isTripActiveOnDate("2026-07-13", t, day({ category: aperte }), validFeriale)).toBe(false);
  });

  it("ombrello: categoria nuda scuole_chiuse copre ogni periodo scuole_chiuse_*", () => {
    const t = trip({ categoryIds: new Set(["cat-chiuse-nuda"]), umbrellaChiuse: true });
    // giorno classificato scuole_chiuse_estivo, la corsa ha la NUDA scuole_chiuse
    expect(isTripActiveOnDate("2026-07-13", t, day({ category: estivo }), validFeriale)).toBe(true);
    // ma NON copre un giorno scuole_aperte
    expect(isTripActiveOnDate("2026-07-13", t, day({ category: aperte }), validFeriale)).toBe(false);
  });

  it("senza ombrello, la categoria nuda non matcha un periodo diverso", () => {
    const t = trip({ categoryIds: new Set(["cat-estivo"]), umbrellaChiuse: false });
    const invernale = { id: "cat-invernale", code: "scuole_chiuse_invernale" };
    expect(isTripActiveOnDate("2026-07-13", t, day({ category: invernale }), validFeriale)).toBe(false);
  });
});
