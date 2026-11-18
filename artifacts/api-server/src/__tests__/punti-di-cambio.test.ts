/**
 * I punti di cambio dei turni guida (tappa 6.17): il calcolo rapido usa quelli
 * dell'azienda e le sue auto aziendali, come il calcolo CP-SAT. Prima usava
 * sei punti di Ancona e cinque auto scritti nel codice, qualunque cosa
 * l'azienda avesse scritto.
 */
import { describe, it, expect } from "vitest";
import { buildDriverShifts } from "../routes/driver-shifts";
import { puntoDellaFermata, type PuntoDiCambio } from "../lib/dati-solver";

const PUNTI: PuntoDiCambio[] = [
  { id: "centro", name: "Piazza Centrale", transferFromDepotMin: 10, stopNames: ["Piazza Centrale A", "Piazza Centrale B"] },
  { id: "ospedale", name: "Ospedale", transferFromDepotMin: 15, stopNames: ["Ospedale Civile"] },
];

describe("il punto di cambio di una fermata", () => {
  it("dal nome intero della fermata, senza badare a maiuscole e spazi ai lati: come il calcolo CP-SAT", () => {
    expect(puntoDellaFermata("Piazza Centrale B", PUNTI)).toBe("centro");
    expect(puntoDellaFermata("  OSPEDALE CIVILE ", PUNTI)).toBe("ospedale");
    expect(puntoDellaFermata("Piazza Centrale", PUNTI)).toBeNull();      // non un pezzo del nome
    expect(puntoDellaFermata("Via Roma", PUNTI)).toBeNull();
    expect([puntoDellaFermata(null, PUNTI), puntoDellaFermata("", PUNTI), puntoDellaFermata("   ", PUNTI)]).toEqual([null, null, null]);
  });

  it("senza punti dell'azienda non vale nessun punto, nemmeno quelli di prima", () => {
    for (const nome of ["Stazione FS Ancona", "Piazza Cavour", "TAVERNELLE", "Ospedale Regionale Torrette", "Piazza Ugo Bassi"]) {
      expect(puntoDellaFermata(nome, [])).toBeNull();
    }
  });
});

describe("il calcolo rapido dei turni guida", () => {
  /* due vetture urbane dalle 6 alle 20, avanti e indietro fra un capolinea e la piazza, 6 minuti di sosta */
  const corsa = (i: number, da: string, a: string, p: number, f: number) =>
    ({ type: "trip", tripId: `T${i}`, routeId: "R", routeName: "1", headsign: null, departureTime: "", arrivalTime: "", departureMin: p, arrivalMin: f, firstStopName: da, lastStopName: a });
  function vettura(id: string, inizio: number): any {
    const trips: any[] = [];
    let t = inizio, i = 0, da = "Capolinea Nord", a = "Piazza Centrale A";
    while (t + 50 <= 20 * 60) { trips.push(corsa(i++, da, a, t, t + 50)); t += 56; [da, a] = [a, da]; }
    return { vehicleId: id, vehicleType: "12m", category: "urbano", trips, startMin: inizio, endMin: t };
  }
  const VETTURE = [vettura("V1", 360), vettura("V2", 380)];

  it("con il punto dell'azienda cambia in linea alla piazza; senza punti non cambia in linea", () => {
    const con = buildDriverShifts(VETTURE, PUNTI, 8);
    const senza = buildDriverShifts(VETTURE, [], 8);
    expect(con.summary.totalCambi).toBeGreaterThan(0);
    expect(senza.summary.totalCambi).toBe(0);
    /* i cambi stanno solo dove l'azienda ha un punto */
    const inizi = (r: typeof con) => r.driverShifts.flatMap((d) => d.riprese.map((x) => x.blocks[0]!.segment.firstStop));
    expect(new Set(inizi(con).filter((s) => s !== "Capolinea Nord"))).toEqual(new Set(["Piazza Centrale A"]));
  });

  it("le auto aziendali sono quelle dell'azienda: le usate non sono mai di più", () => {
    expect(buildDriverShifts(VETTURE, PUNTI, 0).summary.companyCarsUsed).toBe(0);
    expect(buildDriverShifts(VETTURE, PUNTI, 8).summary.companyCarsUsed).toBeGreaterThan(0);
    expect(buildDriverShifts(VETTURE, PUNTI, 8).summary.companyCarsUsed).toBeLessThanOrEqual(8);
  });
});
