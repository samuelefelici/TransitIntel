/**
 * I punti d'appoggio (waypoints) del tracciato di una variante, sempre nella
 * forma che l'editor sa disegnare: { lng, lat, stopId?, mode?, legMode? }.
 *
 * Argos fino al 26/11 li salvava come coppie [lon, lat]: l'editor leggeva
 * w.lng = undefined, metteva sulla mappa un marcatore a (NaN, NaN) e la
 * pagina andava in crash all'apertura del tracciato. Qui si accettano anche
 * le coppie (e "lon" al posto di "lng") e si scarta ogni punto senza
 * coordinate valide: meglio un punto in meno che una pagina rotta.
 * Si usa in scrittura (PUT dello shape) e in lettura (i tracciati già
 * salvati così si aprono senza bisogno di migrazione).
 */

export interface WaypointTracciato {
  lng: number;
  lat: number;
  stopId?: string;
  mode?: "snap" | "manual";
  legMode?: "manual";
}

/** Un tracciato vero ha decine di punti, al massimo qualche centinaio. */
export const MAX_WAYPOINTS = 2000;

const coordinata = (v: unknown, limite: number): number | null => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= limite ? n : null;
};

export function normalizzaWaypoints(raw: unknown): WaypointTracciato[] {
  if (!Array.isArray(raw)) return [];
  const out: WaypointTracciato[] = [];
  for (const w of raw) {
    if (out.length >= MAX_WAYPOINTS) break;
    if (Array.isArray(w)) {
      const lng = coordinata(w[0], 180), lat = coordinata(w[1], 90);
      if (lng != null && lat != null) out.push({ lng, lat, mode: "snap" });
      continue;
    }
    if (!w || typeof w !== "object") continue;
    const o = w as Record<string, unknown>;
    const lng = coordinata(o.lng ?? o.lon, 180), lat = coordinata(o.lat, 90);
    if (lng == null || lat == null) continue;
    const p: WaypointTracciato = { lng, lat };
    if (typeof o.stopId === "string" && o.stopId.length > 0 && o.stopId.length <= 64) p.stopId = o.stopId;
    if (o.mode === "snap" || o.mode === "manual") p.mode = o.mode;
    if (o.legMode === "manual") p.legMode = "manual";
    out.push(p);
  }
  return out;
}
