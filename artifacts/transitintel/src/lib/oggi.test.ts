import { describe, it, expect } from "vitest";
import { oggiARoma, riassuntoTurni } from "./oggi";

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
        { day: g, category: "assenza" }, { day: g, category: "presenza" }, { day: "2026-10-22", category: "assenza" },
      ],
      violazioni: [{}],
    }, g);
    expect(r).toEqual({ pubblicati: 3, assegnati: 1, scoperti: 2, assenze: 1, violazioni: 1, unita: 2 });
  });

  it("un giorno senza pubblicazioni non ha turni scoperti", () => {
    expect(riassuntoTurni({}, "2026-10-21")).toMatchObject({ pubblicati: 0, scoperti: 0, unita: 0 });
  });
});
