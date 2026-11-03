/**
 * Gli ambiti dei calcoli in coda (metadati.ambito): dicono di che calcolo si
 * tratta all'elenco «i miei calcoli» e al tetto per utente. Un ambito nuovo si
 * aggiunge qui, così compare anche nell'elenco.
 */
export const AMBITI = {
  turniGuida: "turni-guida",
  turniMacchina: "turni-macchina",
  giroAgente: "giro-agente",
  materializzazione: "materializzazione",
} as const;

export type Ambito = (typeof AMBITI)[keyof typeof AMBITI];
export const TUTTI_GLI_AMBITI: readonly Ambito[] = Object.values(AMBITI);
