/**
 * La pagina Traffico: le zone e i loro colori (tappa 6.15). Una zona è un
 * attributo dei punti stradali, che l'azienda scrive in Amministrazione ›
 * Azienda › Luoghi di riferimento. Senza React: si prova da solo.
 */

/** Una zona come la dà GET /api/traffic/stats. */
export interface ZonaDelTraffico {
  zone: string;
  /** il posto della zona nell'elenco dei punti (il più piccolo dei loro ordini); null per le rilevazioni senza zona */
  ordine?: number | null;
  avgCongestion: number; avgSpeed: number; avgFreeflow: number; samples: number; speedReduction: number;
}

/** I colori delle zone, nell'ordine in cui le zone compaiono nell'elenco dei punti. */
export const COLORI_ZONE = ["#ef4444", "#f97316", "#eab308", "#22c55e", "#6b7280", "#3b82f6", "#8b5cf6", "#ec4899", "#14b8a6", "#a16207"] as const;
/** Il colore delle rilevazioni che non hanno una zona. */
export const COLORE_SENZA_ZONA = "#6b7280";

/**
 * Il colore di ogni zona. Le zone si mettono nell'ordine dei loro punti (a
 * parità, per nome) e prendono i colori uno dopo l'altro: il colore di una
 * zona non cambia quando cambia la classifica. Oltre i dieci colori si
 * ricomincia. Le rilevazioni senza zona sono grigie.
 */
export function coloriDelleZone(zone: readonly Pick<ZonaDelTraffico, "zone" | "ordine">[]): Record<string, string> {
  const conOrdine = zone.filter((z) => z.ordine != null)
    .sort((a, b) => (a.ordine as number) - (b.ordine as number) || a.zone.localeCompare(b.zone, "it"));
  const colori: Record<string, string> = {};
  conOrdine.forEach((z, i) => { colori[z.zone] = COLORI_ZONE[i % COLORI_ZONE.length]; });
  for (const z of zone) if (z.ordine == null) colori[z.zone] = COLORE_SENZA_ZONA;
  return colori;
}
