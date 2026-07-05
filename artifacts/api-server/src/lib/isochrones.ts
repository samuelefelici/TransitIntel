/**
 * Isocrone a piedi (accessibilità a tempo di percorrenza) — provider ORS/Mapbox
 * con cache su DB (isochrone_cache). Estratto per riuso fuori da routes/analysis.
 *
 * Nessuna chiave configurata → hasIsochroneProvider() = false e i chiamanti
 * ricadono sul raggio in linea d'aria.
 */
import { db } from "@workspace/db";
import { isochroneCache } from "@workspace/db/schema";
import { and, eq } from "drizzle-orm";

const ORS_BASE = "https://api.openrouteservice.org/v2";
const ORS_KEY = process.env.OPENROUTE_API_KEY || "";
const MAPBOX_TOKEN = process.env.MAPBOX_ACCESS_TOKEN || "";

export function hasIsochroneProvider(): boolean {
  return !!(ORS_KEY || MAPBOX_TOKEN);
}

async function fetchIsochroneORS(lng: number, lat: number, rangeSeconds: number[]): Promise<any> {
  for (let attempt = 0; attempt <= 2; attempt++) {
    const resp = await fetch(`${ORS_BASE}/isochrones/foot-walking`, {
      method: "POST",
      headers: {
        Authorization: ORS_KEY,
        "Content-Type": "application/json; charset=utf-8",
        Accept: "application/json, application/geo+json",
      },
      body: JSON.stringify({ locations: [[lng, lat]], range: rangeSeconds, range_type: "time" }),
    });
    if (resp.status === 429 && attempt < 2) { await new Promise((r) => setTimeout(r, 1500 * (attempt + 1))); continue; }
    if (resp.status === 403) throw new Error("ORS 403: quota esaurita");
    if (!resp.ok) throw new Error(`ORS ${resp.status}`);
    return resp.json();
  }
}

async function fetchIsochroneMapbox(lng: number, lat: number, rangeMinutes: number[]): Promise<any> {
  const contours = rangeMinutes.slice(0, 4).join(",");
  const url = `https://api.mapbox.com/isochrone/v1/mapbox/walking/${lng},${lat}?contours_minutes=${contours}&polygons=true&access_token=${MAPBOX_TOKEN}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Mapbox ${resp.status}`);
  return resp.json();
}

async function fetchIsochrone(lng: number, lat: number, rangeSeconds: number[]): Promise<any> {
  const rangeMinutes = rangeSeconds.map((s) => Math.round(s / 60));
  if (MAPBOX_TOKEN) {
    try { return await fetchIsochroneMapbox(lng, lat, rangeMinutes); }
    catch { if (ORS_KEY) return fetchIsochroneORS(lng, lat, rangeSeconds); throw new Error("nessun provider"); }
  }
  return fetchIsochroneORS(lng, lat, rangeSeconds);
}

const r4 = (n: number) => Math.round(n * 10000) / 10000;

/**
 * Recupera le geometrie isocrona per più bande (minuti) da un punto, usando la
 * cache; le bande mancanti sono richieste in UNA sola chiamata al provider.
 * Ritorna { minuti: geometry }. Le bande non ottenute sono assenti dalla mappa.
 */
export async function fetchIsochronesMulti(lng: number, lat: number, minutesList: number[]): Promise<Record<number, any>> {
  const latR = r4(lat), lngR = r4(lng);
  const out: Record<number, any> = {};
  const missing: number[] = [];
  for (const m of minutesList) {
    const cached = await db.select({ geojson: isochroneCache.geojson })
      .from(isochroneCache)
      .where(and(eq(isochroneCache.latRound, latR), eq(isochroneCache.lngRound, lngR), eq(isochroneCache.minutes, m)))
      .limit(1);
    if (cached.length > 0) out[m] = cached[0].geojson; else missing.push(m);
  }
  if (missing.length > 0) {
    const fc = await fetchIsochrone(lng, lat, missing.map((m) => m * 60));
    for (const f of (fc?.features ?? [])) {
      const secs = f?.properties?.value;
      const contour = f?.properties?.contour;
      const m = secs != null ? Math.round(secs / 60) : (contour != null ? Number(contour) : null);
      if (m != null && missing.includes(m) && f?.geometry) {
        out[m] = f.geometry;
        try {
          await db.insert(isochroneCache).values({ latRound: latR, lngRound: lngR, minutes: m, geojson: f.geometry }).onConflictDoNothing();
        } catch { /* ignore cache write errors */ }
      }
    }
  }
  return out;
}

/** Ray-casting su un anello [ [lng,lat], ... ]. */
function pointInRing(lng: number, lat: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if (((yi > lat) !== (yj > lat)) && (lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

/** Punto dentro una geometry GeoJSON Polygon/MultiPolygon (anello esterno). */
export function pointInIsoGeometry(lng: number, lat: number, geom: any): boolean {
  if (!geom) return false;
  if (geom.type === "Polygon") return pointInRing(lng, lat, geom.coordinates?.[0] ?? []);
  if (geom.type === "MultiPolygon") return (geom.coordinates ?? []).some((poly: any) => pointInRing(lng, lat, poly?.[0] ?? []));
  return false;
}
