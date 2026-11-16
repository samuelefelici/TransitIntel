import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  ASSENZA_GENERICA, aDisposizione, catalogoDa, catalogoPer, esitoScrittura, liberaIlTurno, mascheraVoce, problemaRotazione,
  VOCI_DI_PARTENZA, type VoceCatalogo,
} from "../lib/roster-voci";

const cat = catalogoDa(VOCI_DI_PARTENZA);
const SANITARI = ["MA3", "MA", "I", "PAD"];

describe("i codici sanitari del roster", () => {
  const voce = (category: string, code: string) => ({ id: "x", driverId: "d", day: "2026-11-02", category, code, source: null });

  it("chi non li vede legge ASS al posto di malattia, infortunio e 104", () => {
    for (const c of SANITARI) expect(mascheraVoce(voce("assenza", c), false, cat).code).toBe(ASSENZA_GENERICA);
    for (const c of SANITARI) expect(mascheraVoce(voce("assenza", c), true, cat).code).toBe(c);
  });

  it("riposi, presenze e l'assenza generica non cambiano", () => {
    expect(mascheraVoce(voce("assenza", "R"), false, cat).code).toBe("R");
    expect(mascheraVoce(voce("assenza", "ASS"), false, cat).code).toBe("ASS");
    expect(mascheraVoce(voce("presenza", "D1"), false, cat).code).toBe("D1");
    /* il resto della voce resta: si toglie e si sposta per id */
    expect(mascheraVoce(voce("assenza", "MA"), false, cat)).toMatchObject({ id: "x", driverId: "d", day: "2026-11-02" });
  });

  it("il catalogo senza permesso non ha i codici sanitari, ma ha ASS; le voci spente non si offrono", () => {
    const senza = catalogoPer(false, cat).assenza.map(v => v.code);
    expect(senza).toContain("ASS");
    expect(senza.some(c => SANITARI.includes(c))).toBe(false);
    expect(catalogoPer(true, cat).assenza.map(v => v.code)).toEqual(expect.arrayContaining(SANITARI));
    const spenta = catalogoDa([...VOCI_DI_PARTENZA, { ...VOCI_DI_PARTENZA[6]!, codice: "VEC", attiva: false }]);
    expect(catalogoPer(true, spenta).presenza.map(v => v.code)).not.toContain("VEC");
    // con le regole, per il roster
    expect(catalogoPer(true, cat).presenza.find(v => v.code === "D1")).toEqual({ code: "D1", label: "Disposizione mattinale", liberaTurno: false, aDisposizione: true });
  });

  it("scrivere: i codici sanitari solo a chi li vede; codici, categorie sconosciute e voci spente no", () => {
    expect(esitoScrittura("assenza", "MA", false, cat)).toBe("riservato");
    expect(esitoScrittura("assenza", "MA", true, cat)).toBe("ok");
    expect(esitoScrittura("assenza", "ASS", false, cat)).toBe("ok");
    expect(esitoScrittura("presenza", "D2", false, cat)).toBe("ok");
    expect(esitoScrittura("assenza", "FERIE?", true, cat)).toBe("non-valido");
    expect(esitoScrittura("altro", "R", true, cat)).toBe("non-valido");
    // la categoria deve essere quella della voce
    expect(esitoScrittura("presenza", "R", true, cat)).toBe("non-valido");
    const spenta = catalogoDa(VOCI_DI_PARTENZA.map(v => (v.codice === "DISP" ? { ...v, attiva: false } : v)));
    expect(esitoScrittura("presenza", "DISP", true, spenta)).toBe("spenta");
  });
});

describe("le regole delle voci", () => {
  it("libera il turno: le assenze tranne il riposo; un codice fuori catalogo come prima", () => {
    expect(liberaIlTurno({ category: "assenza", code: "MA" }, cat)).toBe(true);
    expect(liberaIlTurno({ category: "assenza", code: "ASS" }, cat)).toBe(true);
    expect(liberaIlTurno({ category: "assenza", code: "R" }, cat)).toBe(false);
    expect(liberaIlTurno({ category: "presenza", code: "D1" }, cat)).toBe(false);
    expect(liberaIlTurno({ category: "assenza", code: "XX" }, cat)).toBe(true);
    // una voce nuova che non libera il turno (un riposo compensativo)
    const rc = catalogoDa([...VOCI_DI_PARTENZA, { ...VOCI_DI_PARTENZA[0]!, codice: "RC", nome: "Riposo compensativo", diSistema: false }]);
    expect(liberaIlTurno({ category: "assenza", code: "RC" }, rc)).toBe(false);
  });

  it("a disposizione: D1 e D2, non DISP; una voce nuova se lo dice", () => {
    expect(aDisposizione({ category: "presenza", code: "D1" }, cat)).toBe(true);
    expect(aDisposizione({ category: "presenza", code: "D2" }, cat)).toBe(true);
    expect(aDisposizione({ category: "presenza", code: "DISP" }, cat)).toBe(false);
    expect(aDisposizione({ category: "assenza", code: "D1" }, cat)).toBe(false);
    const d3 = catalogoDa([...VOCI_DI_PARTENZA, { ...VOCI_DI_PARTENZA[7]!, codice: "D3", nome: "Disposizione serale" }]);
    expect(aDisposizione({ category: "presenza", code: "D3" }, d3)).toBe(true);
  });

  it("le rotazioni: solo assenze attive e non sanitarie del catalogo; per rigenerare, anche le spente", () => {
    expect(problemaRotazione(["R", "ASS"], cat)).toBeNull();
    expect(problemaRotazione(["R", "MA"], cat)).toMatch(/Malattia/);
    expect(problemaRotazione(["FERIE"], cat)).toMatch(/non è un'assenza del catalogo/);
    expect(problemaRotazione(["D1"], cat)).toMatch(/non è un'assenza del catalogo/);
    const spenta = catalogoDa([...VOCI_DI_PARTENZA, { ...VOCI_DI_PARTENZA[0]!, codice: "RV", diSistema: false, attiva: false }]);
    expect(problemaRotazione(["RV"], spenta)).toMatch(/spenta/);
    expect(problemaRotazione(["RV"], spenta, true)).toBeNull();
  });

  it("le voci di partenza sono quelle della migrazione 0034, con le stesse regole", () => {
    const sqlFile = readFileSync(path.resolve(__dirname, "../../../../lib/db/migrations/0034_voci_del_roster.sql"), "utf8");
    const righe = [...sqlFile.matchAll(/\('([A-Z0-9]+)',\s*'(assenza|presenza)',\s*'([^']+)',\s*(true|false),\s*(true|false),\s*(true|false),\s*(\d+),\s*(true|false)\)/g)]
      .map(m => ({ codice: m[1], categoria: m[2], nome: m[3], sanitaria: m[4] === "true", liberaTurno: m[5] === "true", aDisposizione: m[6] === "true", ordine: Number(m[7]), diSistema: m[8] === "true" }));
    const attese = VOCI_DI_PARTENZA.map(({ codicePaghe: _p, attiva: _a, ...v }: VoceCatalogo) => v);
    expect(righe).toEqual(attese);
  });
});
