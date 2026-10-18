import { describe, it, expect } from "vitest";
import { ASSENZA_GENERICA, catalogoPer, CODICI_SANITARI, esitoScrittura, mascheraVoce } from "../lib/roster-voci";

describe("i codici sanitari del roster", () => {
  const voce = (category: string, code: string) => ({ id: "x", driverId: "d", day: "2026-11-02", category, code, source: null });

  it("chi non li vede legge ASS al posto di malattia, infortunio e 104", () => {
    for (const c of CODICI_SANITARI) expect(mascheraVoce(voce("assenza", c), false).code).toBe(ASSENZA_GENERICA);
    for (const c of CODICI_SANITARI) expect(mascheraVoce(voce("assenza", c), true).code).toBe(c);
  });

  it("riposi, presenze e l'assenza generica non cambiano", () => {
    expect(mascheraVoce(voce("assenza", "R"), false).code).toBe("R");
    expect(mascheraVoce(voce("assenza", "ASS"), false).code).toBe("ASS");
    expect(mascheraVoce(voce("presenza", "D1"), false).code).toBe("D1");
    /* il resto della voce resta: si toglie e si sposta per id */
    expect(mascheraVoce(voce("assenza", "MA"), false)).toMatchObject({ id: "x", driverId: "d", day: "2026-11-02" });
  });

  it("il catalogo senza permesso non ha i codici sanitari, ma ha ASS", () => {
    const senza = catalogoPer(false).assenza.map(v => v.code);
    expect(senza).toContain("ASS");
    expect(senza.some(c => CODICI_SANITARI.has(c))).toBe(false);
    expect(catalogoPer(true).assenza.map(v => v.code)).toEqual(expect.arrayContaining([...CODICI_SANITARI]));
  });

  it("scrivere: i codici sanitari solo a chi li vede; codici e categorie sconosciuti no", () => {
    expect(esitoScrittura("assenza", "MA", false)).toBe("riservato");
    expect(esitoScrittura("assenza", "MA", true)).toBe("ok");
    expect(esitoScrittura("assenza", "ASS", false)).toBe("ok");
    expect(esitoScrittura("presenza", "D2", false)).toBe("ok");
    expect(esitoScrittura("assenza", "FERIE?", true)).toBe("non-valido");
    expect(esitoScrittura("altro", "R", true)).toBe("non-valido");
  });
});
