/**
 * La lunghezza dei percorsi della funzione unica dei km (PR 3.5).
 * La stessa formula la usa la migrazione 0022 per ricalcolare le lunghezze già
 * salvate: se cambia qui, va cambiata anche là.
 */
import { describe, it, expect } from "vitest";
import { lunghezzaDellaGeometria, lunghezzaDelleFermate } from "../lib/km-programmati";

/* un centesimo di grado di latitudine sulla sfera di 6.371 km */
const CENTESIMO = 6_371_000 * (0.01 * Math.PI / 180);

describe("lunghezzaDellaGeometria", () => {
  it("somma le distanze fra i punti di una LineString", () => {
    const g = { type: "LineString", coordinates: [[13.5, 43.6], [13.5, 43.61], [13.5, 43.62]] };
    expect(lunghezzaDellaGeometria(g)).toBeCloseTo(2 * CENTESIMO, 6);
  });

  it("somma i tratti di una MultiLineString senza unire la fine di uno all'inizio dell'altro", () => {
    const g = { type: "MultiLineString", coordinates: [[[13.5, 43.6], [13.5, 43.61]], [[13.6, 43.6], [13.6, 43.61]]] };
    expect(lunghezzaDellaGeometria(g)).toBeCloseTo(2 * CENTESIMO, 6);
  });

  it("legge la geometria dentro un Feature", () => {
    const f = { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [[13.5, 43.6], [13.5, 43.61]] } };
    expect(lunghezzaDellaGeometria(f)).toBeCloseTo(CENTESIMO, 6);
  });

  it("salta i punti non validi e unisce il punto valido prima con quello dopo", () => {
    const g = { type: "LineString", coordinates: [[13.5, 43.6], null, ["13.5", "43.605"], [200, 43.605], [13.5, 95], [13.5, 43.61]] };
    expect(lunghezzaDellaGeometria(g)).toBeCloseTo(CENTESIMO, 6);
  });

  it("dà 0 per quello che non è una linea", () => {
    for (const g of [null, undefined, "LineString", 3, {}, { type: "Point", coordinates: [13.5, 43.6] },
      { type: "LineString" }, { type: "LineString", coordinates: [[13.5, 43.6]] },
      { type: "Polygon", coordinates: [[[13.5, 43.6], [13.6, 43.6], [13.6, 43.7], [13.5, 43.6]]] }]) {
      expect(lunghezzaDellaGeometria(g)).toBe(0);
    }
  });

  it("non si fida di distanze scritte dentro la geometria", () => {
    const g = { type: "LineString", coordinates: [[13.5, 43.6], [13.5, 43.61]], properties: { distance: 99999 } };
    expect(lunghezzaDellaGeometria(g)).toBeCloseTo(CENTESIMO, 6);
  });
});

describe("lunghezzaDelleFermate", () => {
  it("somma le distanze fra fermate consecutive", () => {
    expect(lunghezzaDelleFermate([{ lat: 43.6, lon: 13.5 }, { lat: 43.61, lon: 13.5 }, { lat: 43.62, lon: 13.5 }])).toBeCloseTo(2 * CENTESIMO, 6);
  });
  it("dà 0 con meno di due fermate o coordinate non valide", () => {
    expect(lunghezzaDelleFermate([])).toBe(0);
    expect(lunghezzaDelleFermate([{ lat: 43.6, lon: 13.5 }])).toBe(0);
    expect(lunghezzaDelleFermate([{ lat: Number.NaN, lon: 13.5 }, { lat: 43.61, lon: 13.5 }])).toBe(0);
  });
});
