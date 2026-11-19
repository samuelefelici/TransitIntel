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

/** Chilometri in un grado di latitudine: quasi lo stesso ovunque. */
export const KM_PER_GRADO_LAT = 111.32;

/**
 * Chilometri in un grado di longitudine alla latitudine data: si accorciano
 * andando verso nord (circa 89 km in Sicilia, 77 in Alto Adige). Mai zero,
 * così chi divide non si ritrova un infinito vicino ai poli.
 */
export function kmPerGradoLng(lat: number): number {
  return KM_PER_GRADO_LAT * Math.max(Math.cos((lat * Math.PI) / 180), 0.01);
}

/** Un riquadro geografico: i suoi quattro lati, in gradi. */
export interface Riquadro { sud: number; ovest: number; nord: number; est: number }

/**
 * Il riquadro che contiene tutti i cerchi dati (centro e raggio in metri), con
 * un margine in chilometri attorno a ognuno: l'area di un'azienda ricavata dai
 * luoghi che ha scritto, invece di un riquadro scritto nel codice. Senza
 * cerchi, null.
 */
export function riquadroDeiCerchi(
  cerchi: Iterable<{ lat: number; lng: number; raggioM: number }>, margineKm = 0,
): Riquadro | null {
  let r: Riquadro | null = null;
  for (const c of cerchi) {
    if (!Number.isFinite(c.lat) || !Number.isFinite(c.lng)) continue;
    const km = Math.max(0, Number.isFinite(c.raggioM) ? c.raggioM / 1000 : 0) + Math.max(0, margineKm);
    const dLat = km / KM_PER_GRADO_LAT, dLng = km / kmPerGradoLng(c.lat);
    const q = { sud: c.lat - dLat, nord: c.lat + dLat, ovest: c.lng - dLng, est: c.lng + dLng };
    r = r ? { sud: Math.min(r.sud, q.sud), nord: Math.max(r.nord, q.nord), ovest: Math.min(r.ovest, q.ovest), est: Math.max(r.est, q.est) } : q;
  }
  if (!r) return null;
  return { sud: Math.max(-90, r.sud), nord: Math.min(90, r.nord), ovest: Math.max(-180, r.ovest), est: Math.min(180, r.est) };
}

/**
 * Il punto medio di un insieme di punti: il ripiego per una fermata senza
 * coordinate, invece di un luogo scritto nel codice. Senza punti, null.
 */
export function centroDeiPunti(punti: Iterable<{ lat: number; lon: number }>): { lat: number; lon: number } | null {
  let n = 0, lat = 0, lon = 0;
  for (const p of punti) {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) continue;
    n++; lat += p.lat; lon += p.lon;
  }
  return n ? { lat: lat / n, lon: lon / n } : null;
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
