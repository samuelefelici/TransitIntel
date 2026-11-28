import { describe, expect, it } from "vitest";
import { driverShiftSheetsHtml, pickStops, vehicleLabel, type StopPassage } from "./DriverShiftSheetExport";
import type { DriverShiftData, DriverShiftsResult, RipresaTrip } from "@/pages/fucina/turni-guida/types";

const fermate = (n: number, timepoint?: (i: number) => number | null): StopPassage[] =>
  Array.from({ length: n }, (_, i) => ({
    stopName: `Fermata ${i}`, time: `15:${String(10 + i).padStart(2, "0")}:00`, timepoint: timepoint ? timepoint(i) : 1,
  }));

const corsa = (id: string, dep: number, arr: number, vt: string, extra: Partial<RipresaTrip> = {}): RipresaTrip => ({
  tripId: id, routeId: "r30", routeName: "30", variantCode: "30A", headsign: null,
  departureTime: `${String(Math.floor(dep / 60)).padStart(2, "0")}:${String(dep % 60).padStart(2, "0")}:00`,
  arrivalTime: `${String(Math.floor(arr / 60)).padStart(2, "0")}:${String(arr % 60).padStart(2, "0")}:00`,
  departureMin: dep, arrivalMin: arr, firstStopName: "Ospedale Regionale", lastStopName: "Piazza U.Bassi",
  vehicleId: "U012", vehicleType: vt, ...extra,
});

const turno = (codice: string, trips: RipresaTrip[], vt = "10m"): DriverShiftData => ({
  driverId: codice, type: "intero", nastroStart: "14:59", nastroEnd: "21:03", nastroStartMin: 899, nastroEndMin: 1263,
  nastroMin: 364, nastro: "6:04", workMin: 349, work: "5:49", interruptionMin: 0, interruption: null,
  riprese: [{
    startTime: "14:59", endTime: "21:03", startMin: 899, endMin: 1263, preTurnoMin: 5, preTurnoKind: "auto",
    transferMin: 15, transferType: "auto", transferToStop: "Ospedale Regionale", transferBackMin: 0, transferBackType: "bus",
    workMin: 349, vehicleIds: ["U012"], vehicleType: vt, cambi: [], trips,
  }],
  bdsValidation: { valid: true, violations: [], warnings: [] },
} as unknown as DriverShiftData);

const risultato = (shifts: DriverShiftData[]): DriverShiftsResult => ({
  scenarioName: "Domenica Ancona", date: "2026-11-29", driverShifts: shifts,
} as unknown as DriverShiftsResult);

describe("fermate del percorso sul foglio turno", () => {
  it("non le stampa tutte: al massimo quattro, distribuite lungo il percorso", () => {
    const s = pickStops(fermate(22));
    expect(s).toHaveLength(4);
    const idx = s.map(x => Number(x.stopName.split(" ")[1]));
    expect(idx).toEqual([...idx].sort((a, b) => a - b));          // nell'ordine del percorso
    expect(idx[0]).toBeGreaterThan(0);                            // i capolinea li dice già la scheda
    expect(idx[idx.length - 1]).toBeLessThan(21);
  });

  it("preferisce le fermate orario quando il percorso le distingue", () => {
    const s = pickStops(fermate(12, i => (i === 3 || i === 7 ? 1 : 0)));
    expect(s.map(x => x.stopName)).toEqual(["Fermata 3", "Fermata 7"]);
  });

  it("percorsi corti: le intermedie che ci sono; con 0 nessuna", () => {
    expect(pickStops(fermate(4)).map(x => x.stopName)).toEqual(["Fermata 1", "Fermata 2"]);
    expect(pickStops(fermate(10), 0)).toEqual([]);
    expect(pickStops(undefined)).toEqual([]);
  });
});

describe("foglio turno a schede", () => {
  const trips = [corsa("t1", 920, 936, "10m"), corsa("t2", 945, 970, "10m"), corsa("t3", 1000, 1020, "12m", { vehicleId: "U020" })];
  const stops = { t1: fermate(20), t2: fermate(3), t3: fermate(15) };
  const html = driverShiftSheetsHtml(risultato([turno("A108", trips)]), { maxStops: 4 }, stops, { autoPrint: false });

  it("dice su ogni corsa la dimensione della vettura, e in testata quelle del turno", () => {
    expect(html.match(/class="mezzo">10 m</g)).toHaveLength(2);
    expect(html.match(/class="mezzo">12 m</g)).toHaveLength(1);
    expect(html).toContain("<span>Vettura</span><b>10 m · 12 m</b>");
    expect(vehicleLabel("autosnodato")).toBe("Snodato 18 m");
  });

  it("stampa poche fermate per corsa", () => {
    const tappe = html.match(/class="tappa"/g) ?? [];
    expect(tappe.length).toBe(4 + 1 + 4);   // 20 → 4, 3 → 1 intermedia, 15 → 4
  });

  it("ha l'accento del tipo di giorno e una pagina per turno", () => {
    expect(html).toContain('style="--accento:#DC2626"');      // domenica: festivo, rosso
    expect(html).toContain("@page { size: A4 portrait; margin: 0; }");
    expect(html).toContain("window.adattaFogli()");
    expect(html).not.toContain("window.print(); }, 300");      // autoPrint spento
    expect(html.match(/<article class="foglio-card"/g)).toHaveLength(1);
  });
});
