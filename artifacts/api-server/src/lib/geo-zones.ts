/**
 * ZONIZZAZIONE — libreria geometrica pura (nessuna dipendenza da DB/Express).
 *
 * Scopo: calcolare quanti km di una polilinea (shape di percorso, GeoJSON
 * LineString) ricadono dentro un confine comunale (GeoJSON Polygon o
 * MultiPolygon, buchi inclusi). Serve per i corrispettivi chilometrici
 * dovuti agli enti: km sviluppati per comune.
 *
 * Algoritmo (planare in lon/lat, adeguato a scala comunale):
 *   1. per ogni segmento della polilinea si trovano TUTTE le intersezioni
 *      con TUTTI i ring del poligono (esterni, buchi, isole del MultiPolygon);
 *   2. il segmento viene spezzato nei punti di intersezione;
 *   3. il punto medio di ogni sotto-segmento viene classificato con
 *      ray-casting pari/dispari cumulato su tutti i ring (così i buchi
 *      "tolgono" e le isole "aggiungono" automaticamente);
 *   4. si sommano le lunghezze haversine dei soli tratti interni.
 */
import { haversineKm } from "./geo-utils";

export type LonLat = [number, number];

export interface GeoPolygon {
  type: "Polygon";
  coordinates: number[][][];
}
export interface GeoMultiPolygon {
  type: "MultiPolygon";
  coordinates: number[][][][];
}
export type ZoneGeometry = GeoPolygon | GeoMultiPolygon;

/** Estrae tutti i ring (esterni + buchi, di tutti i poligoni) come lista piatta. */
export function ringsOf(geometry: ZoneGeometry): number[][][] {
  if (geometry.type === "Polygon") return geometry.coordinates;
  const rings: number[][][] = [];
  for (const poly of geometry.coordinates) for (const ring of poly) rings.push(ring);
  return rings;
}

/**
 * Ray-casting pari/dispari cumulato su tutti i ring.
 * Un punto è "dentro" se il raggio orizzontale verso +∞ attraversa un numero
 * dispari di lati complessivi: dentro l'esterno = 1 (dispari → dentro),
 * dentro un buco = 2 (pari → fuori), dentro un'isola di un MultiPolygon = 1.
 */
export function pointInRings(lon: number, lat: number, rings: number[][][]): boolean {
  let inside = false;
  for (const ring of rings) {
    const n = ring.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = ring[i][0], yi = ring[i][1];
      const xj = ring[j][0], yj = ring[j][1];
      if ((yi > lat) !== (yj > lat)) {
        const xCross = ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
        if (lon < xCross) inside = !inside;
      }
    }
  }
  return inside;
}

/**
 * Intersezione parametrica segmento A→B vs segmento C→D (planare).
 * Ritorna t ∈ (0,1) lungo A→B se i segmenti si incrociano, altrimenti null.
 * Segmenti paralleli/collineari → null (il punto medio classifica comunque
 * correttamente i tratti che corrono lungo il bordo).
 */
function segmentIntersectionT(
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, dx: number, dy: number,
): number | null {
  const rX = bx - ax, rY = by - ay;
  const sX = dx - cx, sY = dy - cy;
  const denom = rX * sY - rY * sX;
  if (Math.abs(denom) < 1e-15) return null; // paralleli o collineari
  const t = ((cx - ax) * sY - (cy - ay) * sX) / denom;
  const u = ((cx - ax) * rY - (cy - ay) * rX) / denom;
  const EPS = 1e-12;
  if (t <= EPS || t >= 1 - EPS) return null; // estremi: gestiti dallo split a 0/1
  if (u < -EPS || u > 1 + EPS) return null;
  return t;
}

/** Bounding box [minLon, minLat, maxLon, maxLat] di una lista di coordinate. */
export function bboxOfCoords(coords: number[][]): [number, number, number, number] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of coords) {
    if (c[0] < minX) minX = c[0];
    if (c[0] > maxX) maxX = c[0];
    if (c[1] < minY) minY = c[1];
    if (c[1] > maxY) maxY = c[1];
  }
  return [minX, minY, maxX, maxY];
}

/** Bounding box di un Polygon/MultiPolygon. */
export function bboxOfGeometry(geometry: ZoneGeometry): [number, number, number, number] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const ring of ringsOf(geometry)) {
    const [a, b, c, d] = bboxOfCoords(ring);
    if (a < minX) minX = a;
    if (b < minY) minY = b;
    if (c > maxX) maxX = c;
    if (d > maxY) maxY = d;
  }
  return [minX, minY, maxX, maxY];
}

/** True se due bbox [minLon,minLat,maxLon,maxLat] si intersecano. */
export function bboxIntersects(
  a: [number, number, number, number],
  b: [number, number, number, number],
): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

/**
 * Km della polilinea `coords` ([lon,lat][]) che ricadono DENTRO il poligono.
 * Gestisce Polygon e MultiPolygon, buchi inclusi.
 */
export function lineKmInsidePolygon(coords: LonLat[] | number[][], polygon: ZoneGeometry): number {
  if (!coords || coords.length < 2) return 0;
  const rings = ringsOf(polygon);
  if (rings.length === 0) return 0;

  let kmInside = 0;
  for (let i = 1; i < coords.length; i++) {
    const ax = coords[i - 1][0], ay = coords[i - 1][1];
    const bx = coords[i][0], by = coords[i][1];
    if (ax === bx && ay === by) continue; // segmento degenere

    // 1. raccoglie i parametri t delle intersezioni con tutti i lati di tutti i ring
    const ts: number[] = [0, 1];
    for (const ring of rings) {
      const n = ring.length;
      for (let k = 0, j = n - 1; k < n; j = k++) {
        const t = segmentIntersectionT(ax, ay, bx, by, ring[j][0], ring[j][1], ring[k][0], ring[k][1]);
        if (t !== null) ts.push(t);
      }
    }
    ts.sort((a, b) => a - b);

    // 2. spezza e classifica il punto medio di ogni sotto-segmento
    for (let k = 1; k < ts.length; k++) {
      const t0 = ts[k - 1], t1 = ts[k];
      if (t1 - t0 < 1e-12) continue; // dedup di intersezioni coincidenti
      const midT = (t0 + t1) / 2;
      const midLon = ax + (bx - ax) * midT;
      const midLat = ay + (by - ay) * midT;
      if (pointInRings(midLon, midLat, rings)) {
        const x0 = ax + (bx - ax) * t0, y0 = ay + (by - ay) * t0;
        const x1 = ax + (bx - ax) * t1, y1 = ay + (by - ay) * t1;
        kmInside += haversineKm(y0, x0, y1, x1);
      }
    }
  }
  return kmInside;
}
