/**
 * Helper geometrico per archi OD curvi (Bezier quadratica).
 */
export function odArcCoords(
  o: [number, number], d: [number, number],
  flow: number, maxFlow: number,
  steps = 24,
): [number, number][] {
  const [ox, oy] = o, [dx, dy] = d;
  const mx = (ox + dx) / 2, my = (oy + dy) / 2;
  // perpendicolare normalizzata
  const vx = dx - ox, vy = dy - oy;
  const len = Math.hypot(vx, vy) || 1;
  const px = -vy / len, py = vx / len;
  const offsetMag = 0.15 * len * Math.sqrt(Math.max(0, flow / Math.max(1, maxFlow)));
  const cx = mx + px * offsetMag;
  const cy = my + py * offsetMag;
  const out: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = (1 - t) ** 2 * ox + 2 * (1 - t) * t * cx + t ** 2 * dx;
    const y = (1 - t) ** 2 * oy + 2 * (1 - t) * t * cy + t ** 2 * dy;
    out.push([x, y]);
  }
  return out;
}

export interface ODFlow {
  origin_lat: number; origin_lon: number;
  dest_lat: number;   dest_lon: number;
  flow: number;
  origin_name?: string;
  dest_name?: string;
  dest_category?: string;
}

export function buildODGeoJSON(flows: ODFlow[], cap = 150): GeoJSON.FeatureCollection {
  const sorted = [...flows].sort((a, b) => b.flow - a.flow).slice(0, cap);
  const maxFlow = sorted[0]?.flow || 1;
  return {
    type: "FeatureCollection",
    features: sorted.map((f) => ({
      type: "Feature",
      properties: {
        flow: f.flow,
        origin: f.origin_name || "",
        dest: f.dest_name || "",
        category: f.dest_category || "",
      },
      geometry: {
        type: "LineString",
        coordinates: odArcCoords(
          [f.origin_lon, f.origin_lat],
          [f.dest_lon, f.dest_lat],
          f.flow, maxFlow,
        ),
      },
    })),
  };
}
