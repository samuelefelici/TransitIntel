import { describe, it, expect } from "vitest";
import { aDisposizione, aRiposo, liberaTurno } from "./voci-roster";
import { vestizione, type TabelloneVestizione } from "./vestizione";
import { riassuntoTurni } from "./oggi";

describe("le regole delle voci del roster", () => {
  it("dal catalogo, se il tabellone le manda", () => {
    expect(liberaTurno({ category: "assenza", code: "RC", liberaTurno: false })).toBe(false);
    expect(aRiposo({ category: "assenza", code: "RC", liberaTurno: false })).toBe(true);
    expect(liberaTurno({ category: "assenza", code: "FE", liberaTurno: true })).toBe(true);
    expect(aDisposizione({ category: "presenza", code: "D3", aDisposizione: true })).toBe(true);
    expect(aDisposizione({ category: "presenza", code: "D1", aDisposizione: false })).toBe(false);
  });
  it("senza i campi, quelle di prima", () => {
    expect(liberaTurno({ category: "assenza", code: "R" })).toBe(false);
    expect(liberaTurno({ category: "assenza", code: "MA" })).toBe(true);
    expect(liberaTurno({ category: "presenza", code: "D1" })).toBe(false);
    expect(aDisposizione({ category: "presenza", code: "D2" })).toBe(true);
    expect(aDisposizione({ category: "presenza", code: "DISP" })).toBe(false);
  });
  it("una voce nuova che funziona come il riposo: non libera il turno, il conducente è a riposo; una disposizione nuova", () => {
    const g = "2032-07-06";
    const b: TabelloneVestizione = {
      drivers: [{ id: "a", name: "A", cognome: "Rossi", nome: "Anna" }, { id: "b", name: "B", cognome: "Bianchi", nome: "Bruno" }],
      depositi: [], pubblicati: { [g]: [{ dssId: "s", udpNome: null }] },
      dutiesByDss: { s: [{ code: "T1", start: "06:00", end: "12:00" }] },
      assignments: [{ day: g, dssId: "s", dutyCode: "T1", driverId: "a" }],
      entries: [
        { driverId: "a", day: g, category: "assenza", code: "RC", liberaTurno: false },
        { driverId: "b", day: g, category: "presenza", code: "D3", aDisposizione: true },
      ],
    } as unknown as TabelloneVestizione;
    const v = vestizione(b, g, null);
    expect(v.turni[0]!.stato).toBe("coperto");
    expect(v.conducenti.riposo.map((c) => [c.id, c.voce])).toEqual([["a", "RC"]]);
    expect(v.conducenti.disposizione.map((c) => [c.id, c.voce])).toEqual([["b", "D3"]]);
    expect(riassuntoTurni(b as any, g)).toMatchObject({ liberati: 0, assenze: 0, riposi: 1 });
  });
});

describe("la pagina del catalogo", () => {
  it("regole, uso e cancellazione in parole", async () => {
    const { regoleDi, usoDi, siCancella, CODICE_NUOVO, CODICE_PAGHE } = await import("./voci-roster");
    expect(regoleDi({ categoria: "assenza", sanitaria: true, liberaTurno: true, aDisposizione: false })).toEqual(["libera il turno", "dato sanitario"]);
    expect(regoleDi({ categoria: "assenza", sanitaria: false, liberaTurno: false, aDisposizione: false })).toEqual(["come il riposo: non libera il turno"]);
    expect(regoleDi({ categoria: "presenza", sanitaria: false, liberaTurno: false, aDisposizione: true })).toEqual(["a disposizione"]);
    expect(usoDi({ voci: 12345, rotazioni: ["Gruppo A"] })).toBe("12.345 voci nel roster · rotazione: Gruppo A");
    expect(usoDi({ voci: 0, rotazioni: [] })).toBe("mai usata");
    expect(siCancella({ voci: 0, rotazioni: [], diSistema: false })).toBe(true);
    expect(siCancella({ voci: 0, rotazioni: [], diSistema: true })).toBe(false);
    expect(siCancella({ voci: 2, rotazioni: [], diSistema: false })).toBe(false);
    expect(CODICE_NUOVO.test("RC")).toBe(true);
    expect(CODICE_NUOVO.test("rc")).toBe(false);
    expect(CODICE_NUOVO.test("ABCDEFGHI")).toBe(false);
    expect(CODICE_PAGHE.test("R.02")).toBe(true);
    expect(CODICE_PAGHE.test("a b")).toBe(false);
  });
});
