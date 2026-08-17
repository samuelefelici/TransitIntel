/**
 * La matematica della stima istantanea: è il «riflesso rapido» su cui Argos
 * confronta scenari, quindi i numeri devono essere INCHIODATI — una stima
 * sbagliata qui orienta male tutte le scelte a monte del CP-SAT.
 */
import { describe, expect, it } from "vitest";
import { parseHM, quickEstimate, type EstTrip } from "../lib/quick-estimate";

const trip = (start: string, end: string, routeKey?: string): EstTrip => ({
  start: parseHM(start)!, end: parseHM(end)!, routeKey,
});

describe("parseHM", () => {
  it("legge le forme comuni, anche oltre le 24 (convenzione GTFS)", () => {
    expect(parseHM("07:30")).toBe(450);
    expect(parseHM("7:30")).toBe(450);
    expect(parseHM("07:30:00")).toBe(450);
    expect(parseHM("25:10")).toBe(1510);
  });
  it("rifiuta il dato sporco invece di inventare", () => {
    expect(parseHM("")).toBeNull();
    expect(parseHM("7h30")).toBeNull();
    expect(parseHM("07:61")).toBeNull();
    expect(parseHM("48:00")).toBeNull();
    expect(parseHM(null)).toBeNull();
  });
});

describe("quickEstimate", () => {
  it("insieme vuoto → tutto a zero, niente crash", () => {
    const e = quickEstimate([]);
    expect(e.corse).toBe(0);
    expect(e.stimaVetture).toBe(0);
    expect(e.oreServizio).toBe(0);
  });

  it("una cadenza incatenabile sta su UNA vettura", () => {
    // corse ogni 30', durata 25', giro 5': l'arrivo +5 coincide con la partenza dopo
    const trips = Array.from({ length: 10 }, (_, i) => {
      const s = 8 * 60 + i * 30;
      return { start: s, end: s + 25 } as EstTrip;
    });
    const e = quickEstimate(trips, 5);
    expect(e.stimaVetture).toBe(1);
    expect(e.corse).toBe(10);
    expect(e.oreServizio).toBeCloseTo((10 * 25) / 60, 1);
    // ore vettura = dalla prima partenza (8:00) all'ultimo arrivo (12:55)
    expect(e.stimaOreVettura).toBeCloseTo((4 * 60 + 55) / 60, 1);
  });

  it("lo stesso orario con giro più largo raddoppia le vetture: il costo del turnaround si vede", () => {
    const trips = Array.from({ length: 10 }, (_, i) => {
      const s = 8 * 60 + i * 30;
      return { start: s, end: s + 25 } as EstTrip;
    });
    expect(quickEstimate(trips, 8).stimaVetture).toBe(2);
  });

  it("sovrapposizione massima = corse in strada nel momento peggiore", () => {
    const e = quickEstimate([
      trip("08:00", "09:00"), trip("08:30", "09:30"), trip("08:45", "09:15"),
      trip("11:00", "11:30"),
    ], 0);
    expect(e.sovrapposizioneMax).toBe(3);
    expect(e.stimaVetture).toBe(3);
  });

  it("arrivo alle :00 e partenza alle :00 con giro 0 non contano come sovrapposte", () => {
    // l'arrivo libera PRIMA della partenza a pari orario
    const e = quickEstimate([trip("08:00", "09:00"), trip("09:00", "10:00")], 0);
    expect(e.sovrapposizioneMax).toBe(1);
    expect(e.stimaVetture).toBe(1);
  });

  it("una corsa che scavalca la mezzanotte viene srotolata, non negativa", () => {
    const e = quickEstimate([trip("23:50", "00:20")], 8);
    expect(e.oreServizio).toBeCloseTo(0.5, 1);
    expect(e.ultimoArrivo).toBe("24:20");
  });

  it("spaccato per linea con conteggi e ore", () => {
    const e = quickEstimate([
      trip("08:00", "08:40", "21"), trip("09:00", "09:40", "21"), trip("08:10", "08:50", "44"),
    ], 5);
    const l21 = e.perLinea.find((x) => x.linea === "21")!;
    expect(l21.corse).toBe(2);
    expect(l21.oreServizio).toBeCloseTo(80 / 60, 1);
    expect(e.perLinea.find((x) => x.linea === "44")!.corse).toBe(1);
  });

  it("best-fit: la catena resta compatta, le ore vettura non si gonfiano", () => {
    // Tre corse: A 8:00-8:30, B 8:20-8:50, C 9:00-9:30 (giro 10).
    // Servono 2 vetture (A e B si sovrappongono); C va sulla vettura di B
    // (arrivo 8:50, il più tardo compatibile), NON su quella di A: così la
    // vettura di A chiude alle 8:30 e le ore totali restano minime.
    const e = quickEstimate([trip("08:00", "08:30"), trip("08:20", "08:50"), trip("09:00", "09:30")], 10);
    expect(e.stimaVetture).toBe(2);
    // vettura A: 8:00→8:30 (0.5h) · vettura B: 8:20→9:30 (≈1.17h)
    expect(e.stimaOreVettura).toBeCloseTo(0.5 + 70 / 60, 1);
  });
});
