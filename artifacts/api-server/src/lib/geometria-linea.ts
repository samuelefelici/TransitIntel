/**
 * I punti della geometria di una linea, in qualunque forma sia salvata.
 *
 * `gtfs_shapes.geojson` non ha una forma sola:
 *  - l'import di un file GTFS salva un Feature con dentro la LineString;
 *  - un feed nato da Planning Studio (materializzazione) salva la LineString
 *    nuda, presa da `ps_shapes.geometry`.
 * Chi leggeva solo una delle due vedeva vuoti i feed dell'altra (la mappa
 * delle linee era vuota per i feed nati da Planning Studio). Qui le forme si
 * leggono tutte, in un posto solo: LineString, MultiLineString, un Feature che
 * ne avvolge una, una FeatureCollection, e lo stesso scritto come testo JSON.
 *
 * I punti sono [lon, lat] come in GeoJSON. Un punto con numeri non validi o
 * fuori dal mondo si salta; un tratto con meno di due punti buoni non conta.
 */

export type Punto = [number, number];

const valido = (p: unknown): p is number[] =>
  Array.isArray(p) && p.length >= 2
  && typeof p[0] === "number" && typeof p[1] === "number"
  && Number.isFinite(p[0]) && Number.isFinite(p[1])
  && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90;

function trattiDellaGeometria(geom: any, profondita: number): Punto[][] {
  if (!geom || typeof geom !== "object" || profondita > 3) return [];
  switch (geom.type) {
    case "LineString":
      return [geom.coordinates];
    case "MultiLineString":
      return Array.isArray(geom.coordinates) ? geom.coordinates : [];
    case "Feature":
      return trattiDellaGeometria(geom.geometry, profondita + 1);
    case "FeatureCollection":
      return Array.isArray(geom.features)
        ? geom.features.flatMap((f: unknown) => trattiDellaGeometria(f, profondita + 1))
        : [];
    case "GeometryCollection":
      return Array.isArray(geom.geometries)
        ? geom.geometries.flatMap((g: unknown) => trattiDellaGeometria(g, profondita + 1))
        : [];
    default:
      return [];
  }
}

/** I tratti della linea, ognuno con almeno due punti validi. */
export function trattiDellaLinea(g: unknown): Punto[][] {
  let geom: unknown = g;
  if (typeof geom === "string") {
    try { geom = JSON.parse(geom); } catch { return []; }
  }
  const tratti: Punto[][] = [];
  for (const t of trattiDellaGeometria(geom, 0)) {
    if (!Array.isArray(t)) continue;
    const punti = t.filter(valido).map((p) => [p[0], p[1]] as Punto);
    if (punti.length >= 2) tratti.push(punti);
  }
  return tratti;
}

/**
 * Tutti i punti della linea uno dopo l'altro, per chi la tratta come un
 * percorso solo (disegno, distanze, fermate lungo la linea). Vuoto se non c'è
 * una linea da leggere.
 */
export function coordinateDellaLinea(g: unknown): Punto[] {
  return trattiDellaLinea(g).flat();
}
