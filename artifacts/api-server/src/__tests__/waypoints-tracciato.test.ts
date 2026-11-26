/**
 * I punti d'appoggio del tracciato: il formato che l'editor sa disegnare.
 * Il caso vero: la 22/24 creata da Argos aveva i waypoints come [lon, lat],
 * l'editor li leggeva come (NaN, NaN) e la pagina del tracciato crollava.
 */
import { describe, it, expect } from "vitest";
import { normalizzaWaypoints, MAX_WAYPOINTS } from "../lib/waypoints-tracciato";

describe("normalizzaWaypoints", () => {
  it("le coppie [lon, lat] di Argos diventano punti {lng, lat} su strada", () => {
    expect(normalizzaWaypoints([[13.50718, 43.60352], [13.50633, 43.6017]])).toEqual([
      { lng: 13.50718, lat: 43.60352, mode: "snap" },
      { lng: 13.50633, lat: 43.6017, mode: "snap" },
    ]);
  });

  it("i punti dell'editor restano com'erano, campi compresi", () => {
    const w = [
      { lng: 13.5, lat: 43.6, stopId: "99cf1ed3-3b97-4438-bef5-b7603e46c70e", mode: "snap" },
      { lng: 13.51, lat: 43.61, mode: "manual", legMode: "manual" },
    ];
    expect(normalizzaWaypoints(w)).toEqual(w);
  });

  it("accetta 'lon' al posto di 'lng' e i numeri scritti come testo", () => {
    expect(normalizzaWaypoints([{ lon: "13.5", lat: "43.6" }])).toEqual([{ lng: 13.5, lat: 43.6 }]);
  });

  it("scarta i punti senza coordinate valide invece di passarli alla mappa", () => {
    expect(normalizzaWaypoints([
      [null, 43.6], [13.5], { lat: 43.6 }, { lng: NaN, lat: 43.6 }, { lng: 13.5, lat: 95 },
      { lng: 200, lat: 43 }, "13.5,43.6", null, 7, { lng: "", lat: "" },
    ])).toEqual([]);
  });

  it("toglie i campi sconosciuti e i valori fuori elenco", () => {
    expect(normalizzaWaypoints([{ lng: 13.5, lat: 43.6, mode: "volo", legMode: "x", stopId: 42, extra: "<script>" }]))
      .toEqual([{ lng: 13.5, lat: 43.6 }]);
  });

  it("tutto ciò che non è un elenco vale come nessun punto", () => {
    expect(normalizzaWaypoints(null)).toEqual([]);
    expect(normalizzaWaypoints(undefined)).toEqual([]);
    expect(normalizzaWaypoints({ lng: 13.5, lat: 43.6 })).toEqual([]);
  });

  it("un elenco enorme si ferma al tetto", () => {
    const tanti = Array.from({ length: MAX_WAYPOINTS + 50 }, () => [13.5, 43.6]);
    expect(normalizzaWaypoints(tanti)).toHaveLength(MAX_WAYPOINTS);
  });
});
