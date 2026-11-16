import { describe, it, expect } from "vitest";
import { oggiARoma, riassuntoEsercizio, riassuntoTurni, type EsercizioInBreve } from "./oggi";

describe("Oggi", () => {
  it("il giorno è quello di Roma, anche a cavallo della mezzanotte UTC", () => {
    expect(oggiARoma(new Date("2026-10-21T22:30:00Z"))).toBe("2026-10-22");
    expect(oggiARoma(new Date("2026-10-21T21:30:00Z"))).toBe("2026-10-21");
  });

  it("turni del giorno: pubblicati, scoperti, assenze, solo di quel giorno", () => {
    const g = "2026-10-21";
    const r = riassuntoTurni({
      pubblicati: { [g]: [{ dssId: "a", udpNome: "Urbano" }, { dssId: "b", udpNome: null }], "2026-10-22": [{ dssId: "c", udpNome: null }] },
      dutiesByDss: { a: [{ code: "A001" }, { code: "A002" }], b: [{ code: "B100" }], c: [{ code: "C1" }] },
      assignments: [
        { day: g, dssId: "a", dutyCode: "A001" },
        { day: "2026-10-22", dssId: "a", dutyCode: "A002" },
      ],
      entries: [
        { day: g, driverId: "d1", category: "assenza", code: "MA" },
        { day: g, driverId: "d1", category: "assenza", code: "PAD" },
        { day: g, driverId: "d2", category: "assenza", code: "R" },
        { day: g, driverId: "d3", category: "presenza", code: "CORSO" },
        { day: "2026-10-22", driverId: "d4", category: "assenza", code: "FE" },
      ],
      violazioni: [{ forzata: false }, { forzata: true }],
    }, g);
    /* d1 con due voci è una persona sola; d2 è a riposo, non assente; la violazione forzata non si conta */
    expect(r).toEqual({ pubblicati: 3, assegnati: 1, scoperti: 2, liberati: 0, assenze: 1, riposi: 1, violazioni: 1, unita: 2 });
  });

  it("il turno di un conducente assente torna scoperto, e si conta fra i liberati; il riposo no", () => {
    const g = "2026-11-16";
    const r = riassuntoTurni({
      pubblicati: { [g]: [{ dssId: "a", udpNome: null }] },
      dutiesByDss: { a: [{ code: "A1" }, { code: "A2" }, { code: "A3" }] },
      assignments: [
        { day: g, dssId: "a", dutyCode: "A1", driverId: "malato" },
        { day: g, dssId: "a", dutyCode: "A2", driverId: "riposa" },
      ],
      entries: [
        { day: g, driverId: "malato", category: "assenza", code: "ASS" },
        { day: g, driverId: "riposa", category: "assenza", code: "R" },
      ],
    }, g);
    expect(r).toMatchObject({ pubblicati: 3, assegnati: 1, scoperti: 2, liberati: 1 });
  });

  it("un giorno senza pubblicazioni non ha turni scoperti", () => {
    expect(riassuntoTurni({}, "2026-10-21")).toMatchObject({ pubblicati: 0, scoperti: 0, unita: 0 });
  });
  it("la giornata di esercizio: stato a parole, confermate, giornate da chiudere dalla più vecchia", () => {
    const giornata: NonNullable<EsercizioInBreve["giornata"]> = {
      stato: "congelata", ricostruita: false, chiusaIl: null, programmate: 120, effettuate: 30, presunte: 0, parziali: 2,
      soppresse: 3, daDecidere: 85, daVerificare: 4, aggiunte: 1, visteAvm: 40, quotaVisteAvm: 33.3,
    };
    const d: EsercizioInBreve = { giorno: "2026-11-16", giornata, daChiudere: { totale: 12, giorni: [{ giorno: "2026-10-30", stato: "congelata" }, { giorno: "2026-11-02", stato: "congelata" }] } };
    expect(riassuntoEsercizio(d)).toEqual({ stato: "in corso", confermate: 35, daChiudere: 12, dal: "2026-10-30" });
    expect(riassuntoEsercizio({ ...d, giornata: { ...giornata, stato: "preparata" } }).stato).toBe("non ancora cominciata");
    expect(riassuntoEsercizio({ ...d, giornata: { ...giornata, stato: "chiusa" } }).stato).toBe("chiusa");
    expect(riassuntoEsercizio({ giorno: "2026-11-16", giornata: null, daChiudere: { totale: 0, giorni: [] } }))
      .toEqual({ stato: null, confermate: 0, daChiudere: 0, dal: null });
  });
});
