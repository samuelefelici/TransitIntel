/**
 * Il traffico com'era scritto nel codice prima della tappa 6.15: i 37 punti
 * stradali (routes/cron.ts), le cinque zone come rettangoli di coordinate
 * (routes/traffic.ts) e il centro del modello (routes/gtfs-helpers.ts). I
 * test ci confrontano i dati di partenza della migrazione 0045 e i conti di
 * oggi: per Conerobus non deve cambiare niente.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface PuntoDiPrima { punto: string; lat: number; lng: number }
export const PUNTI_DI_PRIMA: readonly PuntoDiPrima[] = JSON.parse(readFileSync(join(__dirname, "traffico-di-prima.json"), "utf8"));

/** Le zone di prima, nell'ordine dei colori che avevano nella pagina. */
export const ZONE_DI_PRIMA = ["Centro storico", "Porto / Lido", "Zona Ovest", "Nord / Falconara", "Entroterra"] as const;

/** La regola di prima: i confini sono compresi, vale il primo rettangolo che corrisponde, il resto è «Entroterra». */
export function zonaDiPrima(lat: number, lng: number): (typeof ZONE_DI_PRIMA)[number] {
  if (lat >= 43.59 && lat <= 43.62 && lng >= 13.50 && lng <= 13.52) return "Centro storico";
  if (lat >= 43.60 && lat <= 43.63 && lng >= 13.52 && lng <= 13.57) return "Porto / Lido";
  if (lat >= 43.60 && lat <= 43.65 && lng >= 13.42 && lng <= 13.50) return "Zona Ovest";
  if (lat >= 43.62 && lat <= 43.69 && lng >= 13.38 && lng <= 13.52) return "Nord / Falconara";
  return "Entroterra";
}

/** La stessa regola come la scriveva la query: per provarla sul database. */
export const ZONA_DI_PRIMA_SQL = `
  CASE
    WHEN lat BETWEEN 43.59 AND 43.62 AND lng BETWEEN 13.50 AND 13.52 THEN 'Centro storico'
    WHEN lat BETWEEN 43.60 AND 43.63 AND lng BETWEEN 13.52 AND 13.57 THEN 'Porto / Lido'
    WHEN lat BETWEEN 43.60 AND 43.65 AND lng BETWEEN 13.42 AND 13.50 THEN 'Zona Ovest'
    WHEN lat BETWEEN 43.62 AND 43.69 AND lng BETWEEN 13.38 AND 13.52 THEN 'Nord / Falconara'
    ELSE 'Entroterra'
  END`;

/** Il centro di prima. */
export const CENTRO_DI_PRIMA = { lat: 43.616, lng: 13.516 } as const;

/** Il modello di prima, com'era: la curva oraria per un fattore che cala con la distanza da quel centro. */
export function congestioneDiPrima(curva: Record<number, number>, hour: number, lng: number, lat: number): number {
  const h = Math.max(0, Math.min(26, Math.round(hour)));
  const base = curva[h] ?? 0.05;
  const dist = Math.sqrt((lng - CENTRO_DI_PRIMA.lng) ** 2 + (lat - CENTRO_DI_PRIMA.lat) ** 2);
  const zoneFactor = dist < 0.04 ? 1.30
    : dist < 0.08 ? 1.10
    : dist < 0.16 ? 1.00
    : dist < 0.30 ? 0.75
    : 0.55;
  const jitter = (Math.sin((lng * 23.7 + lat * 47.3) * 100) * 0.5 + 0.5) * 0.24 - 0.12;
  return Math.min(0.98, Math.max(0.02, base * zoneFactor + jitter * base));
}
