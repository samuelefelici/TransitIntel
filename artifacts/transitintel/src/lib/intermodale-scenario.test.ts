import { describe, it, expect } from "vitest";
import { modificaPerCorsa, type ModificaProposta } from "./intermodale-scenario";

const m = (tripId: string, shiftMin: number, severity: ModificaProposta["severity"], priorityClass?: ModificaProposta["priorityClass"]): ModificaProposta =>
  ({ tripId, changeType: "shift_arrival", shiftMin, severity, priorityClass });

describe("scenario intermodale: una modifica per corsa", () => {
  it("non somma: tre modifiche per la stessa corsa ne danno una", () => {
    const scelte = modificaPerCorsa([m("C1", -3, "warning", "bus_other"), m("C1", -3, "warning", "bus_other"), m("C1", -5, "warning", "bus_other")]);
    expect(scelte.size).toBe(1);
    expect(scelte.get("C1")!.shiftMin).toBe(-3);
  });

  it("prima la più grave, poi il treno sugli autobus, poi lo spostamento più piccolo", () => {
    expect(modificaPerCorsa([m("C1", -3, "warning", "rail"), m("C1", -8, "critical", "bus_other")]).get("C1")!.shiftMin).toBe(-8);
    expect(modificaPerCorsa([m("C1", -3, "warning", "bus_other"), m("C1", -6, "warning", "rail")]).get("C1")!.shiftMin).toBe(-6);
    expect(modificaPerCorsa([m("C1", 9, "info", "rail"), m("C1", -4, "info", "rail")]).get("C1")!.shiftMin).toBe(-4);
    // a parità di tutto, la prima dell'elenco
    expect(modificaPerCorsa([m("C1", 3, "warning", "rail"), m("C1", -3, "warning", "rail")]).get("C1")!.shiftMin).toBe(3);
  });

  it("una modifica senza classe (risposta di prima) vale come un autobus", () => {
    expect(modificaPerCorsa([m("C1", -3, "warning"), m("C1", -5, "warning", "port")]).get("C1")!.shiftMin).toBe(-5);
  });

  it("le corse restano separate; aggiunte di corse e spostamenti nulli non si applicano", () => {
    const scelte = modificaPerCorsa([
      m("C1", -3, "warning", "rail"),
      m("C2", 5, "info", "bus_other"),
      { tripId: "C3", changeType: "add_trip", shiftMin: 0, severity: "info" },
      m("C4", 0, "info", "rail"),
    ]);
    expect([...scelte.keys()]).toEqual(["C1", "C2"]);
  });
});
