/**
 * I dati di prova (conducenti fittizi con rotazioni e riposi) si creano solo
 * nelle installazioni di prova o dimostrative, con CERBERO_DATI_PROVA=1. In
 * produzione l'endpoint risponde 404 e i pulsanti non compaiono.
 */
export function datiProvaAttivi(env: { CERBERO_DATI_PROVA?: string } = process.env): boolean {
  return env.CERBERO_DATI_PROVA === "1";
}
