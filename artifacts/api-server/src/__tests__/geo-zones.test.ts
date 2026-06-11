/**
 * Test della libreria geometrica pura per la ZONIZZAZIONE
 * (km di polilinea dentro un poligono comunale).
 */
import { describe, it, expect } from "vitest";
import {
  lineKmInsidePolygon,
  pointInRings,
  ringsOf,
  bboxOfGeometry,
  bboxIntersects,
  type GeoPolygon,
  type GeoMultiPolygon,
  type LonLat,
} from "../lib/geo-zones";
import { haversineKm } from "../lib/geo-utils";

/** Quadrato unitario [0,1]×[0,1] in gradi (≈111 km di lato all'equatore). */
const square: GeoPolygon = {
  type: "Polygon",
  coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
};

/** Stesso quadrato con un buco centrale [0.4,0.6]×[0.4,0.6]. */
const squareWithHole: GeoPolygon = {
  type: "Polygon",
  coordinates: [
    [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]],
    [[0.4, 0.4], [0.6, 0.4], [0.6, 0.6], [0.4, 0.6], [0.4, 0.4]],
  ],
};

/** Due quadrati disgiunti: [0,1]² e [2,3]×[0,1]. */
const multi: GeoMultiPolygon = {
  type: "MultiPolygon",
  coordinates: [
    [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
    [[[2, 0], [3, 0], [3, 1], [2, 1], [2, 0]]],
  ],
};

/** Lunghezza haversine di una polilinea [lon,lat][] in km (riferimento test). */
function lenKm(coords: LonLat[]): number {
  let km = 0;
  for (let i = 1; i < coords.length; i++) {
    km += haversineKm(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]);
  }
  return km;
}

describe("geo-zones · lineKmInsidePolygon", () => {
  it("segmento tutto dentro → lunghezza piena", () => {
    const line: LonLat[] = [[0.2, 0.5], [0.8, 0.5]];
    const expected = lenKm(line);
    const got = lineKmInsidePolygon(line, square);
    expect(got).toBeCloseTo(expected, 6);
    expect(got).toBeGreaterThan(60); // ~66.7 km: sanity check ordine di grandezza
  });

  it("segmento tutto fuori → 0 km", () => {
    const line: LonLat[] = [[2, 2], [3, 3]];
    expect(lineKmInsidePolygon(line, square)).toBe(0);
  });

  it("segmento attraversante (entra ed esce) → solo il tratto interno", () => {
    // Da lon -0.5 a lon 1.5 alla stessa latitudine: dentro solo tra lon 0 e 1,
    // cioè metà della lunghezza totale.
    const line: LonLat[] = [[-0.5, 0.5], [1.5, 0.5]];
    const expected = lenKm(line) / 2;
    expect(lineKmInsidePolygon(line, square)).toBeCloseTo(expected, 4);
  });

  it("poligono con buco → il tratto nel buco non conta", () => {
    // Segmento da 0.2 a 0.8: attraversa il buco [0.4,0.6].
    // Dentro: [0.2,0.4] ∪ [0.6,0.8] = 0.4 gradi su 0.6 totali → 2/3 della lunghezza.
    const line: LonLat[] = [[0.2, 0.5], [0.8, 0.5]];
    const expected = lenKm(line) * (2 / 3);
    expect(lineKmInsidePolygon(line, squareWithHole)).toBeCloseTo(expected, 4);
  });

  it("MultiPolygon → somma i tratti dentro ciascuna isola", () => {
    // Da lon 0.5 a lon 2.5: dentro il primo quadrato per [0.5,1] e nel secondo
    // per [2,2.5] → 1 grado su 2 totali → metà lunghezza.
    const line: LonLat[] = [[0.5, 0.5], [2.5, 0.5]];
    const expected = lenKm(line) / 2;
    expect(lineKmInsidePolygon(line, multi)).toBeCloseTo(expected, 4);
  });

  it("polilinea multi-segmento mista dentro/fuori", () => {
    // [0.5,0.5]→[0.5,1.5] (metà dentro) →[1.5,1.5] (tutto fuori)
    const line: LonLat[] = [[0.5, 0.5], [0.5, 1.5], [1.5, 1.5]];
    const expected = lenKm([[0.5, 0.5], [0.5, 1.0]]);
    expect(lineKmInsidePolygon(line, square)).toBeCloseTo(expected, 4);
  });

  it("input degeneri → 0 km", () => {
    expect(lineKmInsidePolygon([], square)).toBe(0);
    expect(lineKmInsidePolygon([[0.5, 0.5]], square)).toBe(0);
    expect(lineKmInsidePolygon([[0.5, 0.5], [0.5, 0.5]], square)).toBe(0);
  });
});

describe("geo-zones · helper", () => {
  it("pointInRings: dentro/fuori/buco", () => {
    const rings = ringsOf(squareWithHole);
    expect(pointInRings(0.2, 0.2, rings)).toBe(true);   // dentro
    expect(pointInRings(1.5, 0.5, rings)).toBe(false);  // fuori
    expect(pointInRings(0.5, 0.5, rings)).toBe(false);  // nel buco
  });

  it("bbox di Polygon e MultiPolygon + intersezione", () => {
    expect(bboxOfGeometry(square)).toEqual([0, 0, 1, 1]);
    expect(bboxOfGeometry(multi)).toEqual([0, 0, 3, 1]);
    expect(bboxIntersects([0, 0, 1, 1], [0.5, 0.5, 2, 2])).toBe(true);
    expect(bboxIntersects([0, 0, 1, 1], [2, 2, 3, 3])).toBe(false);
  });
});
