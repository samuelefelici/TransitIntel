import { describe, it, expect } from "vitest";
import { waypointsLeggibili } from "./waypoints-leggibili";

describe("i punti del tracciato che arrivano alla mappa", () => {
  it("le coppie [lon, lat] salvate da Argos si leggono come punti su strada", () => {
    expect(waypointsLeggibili([[13.50718, 43.60352]])).toEqual([{ lng: 13.50718, lat: 43.60352, mode: "snap" }]);
  });

  it("nessun punto con coordinate non numeriche arriva a Mapbox", () => {
    const fuori = waypointsLeggibili([
      [undefined, undefined], { lat: 43.6 }, { lng: NaN, lat: 1 }, { lng: 13.5, lat: -91 }, null, "x",
    ]);
    expect(fuori).toEqual([]);
  });

  it("i punti dell'editor passano intatti", () => {
    const w = [{ lng: 13.5, lat: 43.6, stopId: "s1", mode: "manual" as const, legMode: "manual" as const }];
    expect(waypointsLeggibili(w)).toEqual(w);
  });

  it("senza tracciato salvato non c'è nessun punto", () => {
    expect(waypointsLeggibili(undefined)).toEqual([]);
    expect(waypointsLeggibili({})).toEqual([]);
  });
});
