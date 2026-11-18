/**
 * La lettura unica della geometria di una linea (lib/geometria-linea.ts).
 * gtfs_shapes.geojson arriva in due forme: un Feature dall'import di un GTFS,
 * una LineString nuda dai feed nati da Planning Studio. Chi leggeva solo la
 * prima lasciava vuota la mappa delle linee di quei feed.
 */
import { describe, it, expect } from "vitest";
import { trattiDellaLinea, coordinateDellaLinea } from "../lib/geometria-linea";
import { coordinateDaGeojson } from "../routes/operations";
import { lunghezzaDellaGeometria } from "../lib/km-programmati";

const A: [number, number] = [13.5, 43.6];
const B: [number, number] = [13.51, 43.6];
const C: [number, number] = [13.52, 43.61];
const LINEA = { type: "LineString", coordinates: [A, B, C] };

describe("trattiDellaLinea", () => {
  it("legge la LineString nuda, come la scrive un feed di Planning Studio", () => {
    expect(trattiDellaLinea(LINEA)).toEqual([[A, B, C]]);
  });

  it("legge il Feature, come lo scrive l'import di un GTFS", () => {
    expect(trattiDellaLinea({ type: "Feature", geometry: LINEA, properties: { shapeId: "S1" } })).toEqual([[A, B, C]]);
  });

  it("le due forme danno gli stessi punti", () => {
    expect(coordinateDellaLinea(LINEA)).toEqual(coordinateDellaLinea({ type: "Feature", geometry: LINEA }));
  });

  it("MultiLineString e FeatureCollection: un tratto per pezzo", () => {
    expect(trattiDellaLinea({ type: "MultiLineString", coordinates: [[A, B], [B, C]] })).toEqual([[A, B], [B, C]]);
    expect(trattiDellaLinea({
      type: "FeatureCollection",
      features: [{ type: "Feature", geometry: { type: "LineString", coordinates: [A, B] } },
                 { type: "Feature", geometry: { type: "LineString", coordinates: [B, C] } }],
    })).toEqual([[A, B], [B, C]]);
  });

  it("il testo JSON si legge; quello rotto no", () => {
    expect(trattiDellaLinea(JSON.stringify(LINEA))).toEqual([[A, B, C]]);
    expect(trattiDellaLinea("{non è json")).toEqual([]);
  });

  it("i punti non validi si saltano; un tratto con meno di due punti buoni non conta", () => {
    expect(trattiDellaLinea({ type: "LineString", coordinates: [A, [null, null], ["13", "43"], [200, 43], B] })).toEqual([[A, B]]);
    expect(trattiDellaLinea({ type: "LineString", coordinates: [A] })).toEqual([]);
    expect(trattiDellaLinea({ type: "MultiLineString", coordinates: [[A], [B, C]] })).toEqual([[B, C]]);
  });

  it("niente linea: vuoto, senza errori", () => {
    for (const g of [null, undefined, 3, {}, { type: "Point", coordinates: A }, { type: "Feature", geometry: null },
                     { type: "LineString" }, { type: "MultiLineString", coordinates: "x" }]) {
      expect(trattiDellaLinea(g)).toEqual([]);
      expect(coordinateDellaLinea(g)).toEqual([]);
    }
  });

  it("un annidamento troppo profondo non la blocca", () => {
    let g: unknown = LINEA;
    for (let i = 0; i < 10; i++) g = { type: "Feature", geometry: g };
    expect(trattiDellaLinea(g)).toEqual([]);
  });
});

describe("i lettori che la usano", () => {
  it("il fuori percorso vede la LineString nuda come il Feature, con lat e lon al posto giusto", () => {
    const atteso = [{ lat: 43.6, lon: 13.5 }, { lat: 43.6, lon: 13.51 }, { lat: 43.61, lon: 13.52 }];
    expect(coordinateDaGeojson(LINEA)).toEqual(atteso);
    expect(coordinateDaGeojson({ type: "Feature", geometry: LINEA })).toEqual(atteso);
    expect(coordinateDaGeojson({ type: "LineString", coordinates: [A] })).toBeNull();
  });

  it("i km programmati non cambiano fra le due forme", () => {
    const m = lunghezzaDellaGeometria(LINEA);
    expect(m).toBeGreaterThan(1000);
    expect(lunghezzaDellaGeometria({ type: "Feature", geometry: LINEA })).toBe(m);
  });
});
