/**
 * Le zone tariffarie (pagina Tariffe): il riassunto di una generazione,
 * uguale per i tre modi di generarle (shape, km diretto, percorso dominante).
 * API: POST /api/fares/zones/generate-all, -direct, -dominant.
 */

/** Che cosa risponde l'API dopo una generazione. */
export interface ZoneGenerate {
  /** Le zone urbane: una per rete urbana. */
  urbanAreas: number;
  /** Le fermate urbane messe adesso nella loro zona. */
  urbanStopsAdded?: number;
  /** Le fermate tolte da una zona urbana che non era la loro. */
  urbanStopsRemoved?: number;
  extraurbanRoutes: number;
  totalZones: number;
}

const numero = (v: number) => v.toLocaleString("it-IT");

/** La frase sulle fermate tolte dalla zona urbana sbagliata; vuota se non ce n'erano. */
export function notaFermateTolte(tolte: number | null | undefined): string {
  if (!tolte || tolte <= 0) return "";
  return `. ${tolte === 1 ? "Una fermata tolta" : `${numero(tolte)} fermate tolte`} da una zona urbana che non era la sua.`;
}

/** Una riga per l'avviso a fine generazione; dice anche se ha corretto fermate nella zona sbagliata. */
export function riassuntoZoneGenerate(z: ZoneGenerate): string {
  return `${numero(z.urbanAreas)} aree urbane + ${numero(z.totalZones)} zone extraurbane su ${numero(z.extraurbanRoutes)} ${z.extraurbanRoutes === 1 ? "linea" : "linee"}`
    + notaFermateTolte(z.urbanStopsRemoved);
}
