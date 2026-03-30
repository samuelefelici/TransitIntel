/**
 * Shared geo/time utility functions.
 * Single source of truth — replaces duplicated helpers in route files.
 */

/** Haversine distance between two points in kilometres. */
export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Total length of a coordinate array [[lng,lat], …] in km. */
export function lineLength(coords: number[][]): number {
  let len = 0;
  for (let i = 1; i < coords.length; i++) {
    len += haversineKm(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]);
  }
  return len;
}

/** Minimum distance (km) from a point to a polyline. */
export function pointToLineDistance(px: number, py: number, line: number[][]): number {
  let minDist = Infinity;
  for (let i = 0; i < line.length - 1; i++) {
    const [ax, ay] = line[i], [bx, by] = line[i + 1];
    const dx = bx - ax, dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    let t = lenSq > 0 ? ((px - ax) * dx + (py - ay) * dy) / lenSq : 0;
    t = Math.max(0, Math.min(1, t));
    const cx = ax + t * dx, cy = ay + t * dy;
    const dist = haversineKm(py, px, cy, cx);
    if (dist < minDist) minDist = dist;
  }
  return minDist;
}

/** Parse "HH:MM:SS" or "HH:MM" → minutes since midnight (handles >24h GTFS times). */
export function timeToMinutes(t: string): number {
  const parts = t.split(":").map(Number);
  return (parts[0] || 0) * 60 + (parts[1] || 0);
}

/** Minutes since midnight → "HH:MM" string. */
export function minToTime(m: number): string {
  const h = Math.floor(m / 60) % 24;
  const mm = m % 60;
  return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

/** Estimated walking time (minutes) for a given distance in km (4.5 km/h pace). */
export function walkMinutes(distKm: number): number {
  return Math.ceil((distKm / 4.5) * 60);
}
