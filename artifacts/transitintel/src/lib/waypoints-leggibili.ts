import type { PsWaypoint } from "./planning-studio-api";

/**
 * I punti d'appoggio del tracciato come li salva il server, resi sicuri per la
 * mappa: un marcatore con coordinate non numeriche manda in crash Mapbox
 * («Invalid LngLat object: (NaN, NaN)») e con lui l'intera pagina dell'editor.
 * Si accettano anche le coppie [lon, lat] e "lon" al posto di "lng" (così
 * salvava Argos fino al 26/11); si scarta ogni punto senza coordinate valide.
 * Il server fa la stessa pulizia: questa è la seconda rete.
 */
export function waypointsLeggibili(raw: unknown): PsWaypoint[] {
  if (!Array.isArray(raw)) return [];
  const num = (v: unknown, limite: number): number | null => {
    const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
    return typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= limite ? n : null;
  };
  const out: PsWaypoint[] = [];
  for (const w of raw) {
    if (Array.isArray(w)) {
      const lng = num(w[0], 180), lat = num(w[1], 90);
      if (lng != null && lat != null) out.push({ lng, lat, mode: "snap" });
      continue;
    }
    if (!w || typeof w !== "object") continue;
    const o = w as Record<string, unknown>;
    const lng = num(o.lng ?? o.lon, 180), lat = num(o.lat, 90);
    if (lng == null || lat == null) continue;
    const p: PsWaypoint = { lng, lat };
    if (typeof o.stopId === "string" && o.stopId) p.stopId = o.stopId;
    if (o.mode === "snap" || o.mode === "manual") p.mode = o.mode;
    if (o.legMode === "manual") p.legMode = "manual";
    out.push(p);
  }
  return out;
}
