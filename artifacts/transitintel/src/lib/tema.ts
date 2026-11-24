/**
 * Il tema dell'app, chiaro o scuro (tappa 7.32). Funzioni pure, coi loro test;
 * l'aggancio alla pagina è in hooks/use-tema.tsx.
 *
 * - La scelta è della persona: scuro (com'era sempre stato), chiaro, o come
 *   il sistema. Resta nel browser (localStorage): è una comodità, non un dato.
 * - Il tema chiaro è la classe `tema-chiaro` su <html>: le variabili di
 *   index.css e la rimappatura delle scale di Tailwind (styles/tema-chiaro-
 *   scale.css) fanno il resto.
 */

export type SceltaTema = "scuro" | "chiaro" | "sistema";
export type Tema = "scuro" | "chiaro";

export const CHIAVE_TEMA = "cerbero-tema";
export const CLASSE_CHIARO = "tema-chiaro";

export const SCELTE_TEMA: ReadonlyArray<{ valore: SceltaTema; etichetta: string }> = [
  { valore: "scuro", etichetta: "Scuro" },
  { valore: "chiaro", etichetta: "Chiaro" },
  { valore: "sistema", etichetta: "Come il sistema" },
];

/** Un valore letto dal browser: se non è una scelta valida, si resta sullo scuro di sempre. */
export function sceltaValida(v: unknown): SceltaTema {
  return v === "chiaro" || v === "scuro" || v === "sistema" ? v : "scuro";
}

/** Il tema da mostrare: la scelta, o quello del sistema se la scelta è «sistema». */
export function temaRisolto(scelta: SceltaTema, sistemaChiaro: boolean): Tema {
  if (scelta === "sistema") return sistemaChiaro ? "chiaro" : "scuro";
  return scelta;
}

/** La scelta successiva, per il pulsante del menu compresso: scuro → chiaro → sistema → scuro. */
export function sceltaSeguente(s: SceltaTema): SceltaTema {
  return s === "scuro" ? "chiaro" : s === "chiaro" ? "sistema" : "scuro";
}

/**
 * Lo stile della mappa di base per il tema: i fondi scuri di Mapbox hanno il
 * loro gemello chiaro. Satellite, strade e «standard» vanno bene in tutti e due.
 */
const GEMELLI: Record<string, string> = {
  "mapbox://styles/mapbox/dark-v11": "mapbox://styles/mapbox/light-v11",
  "mapbox://styles/mapbox/navigation-night-v1": "mapbox://styles/mapbox/navigation-day-v1",
};
const ROVESCI: Record<string, string> = Object.fromEntries(Object.entries(GEMELLI).map(([a, b]) => [b, a]));

export function stileMappa(stile: string, tema: Tema): string {
  if (tema === "chiaro") return GEMELLI[stile] ?? stile;
  return ROVESCI[stile] ?? stile;
}

/** Il colore della barra del browser sul telefono, per tema. */
export const COLORE_BARRA: Record<Tema, string> = { scuro: "#030712", chiaro: "#f6f8fb" };
