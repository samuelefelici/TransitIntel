/**
 * Il segreto che apre la porta di Argos.
 *
 * Argos non risponde più a nessuno senza credenziali (argos/api/accesso.py):
 * prima chiunque conoscesse l'id di un progetto ne leggeva lo storico dei piani
 * e poteva scrivere nella memoria dell'agente. Il proxy di Cerbero si presenta
 * con ARGOS_PROXY_SECRET nell'header X-Argos-Proxy-Secret, lo stesso valore
 * impostato nel servizio Argos (distinto dal CRON_SECRET, che serve al verso
 * opposto: Argos → Cerbero).
 *
 * OGNI fetch verso ARGOS_URL passa le sue intestazioni da qui: lo verifica un
 * test che legge i sorgenti (argos-proxy.test.ts), così una chiamata nuova
 * senza segreto non arriva in produzione a prendersi un 401.
 */
import { logger } from "./logger";

export const ARGOS_PROXY_HEADER = "x-argos-proxy-secret";

/** Letto a ogni chiamata, non all'avvio: una rotazione del segreto in Coolify
 *  vale al primo riavvio senza toccare il codice, e i test lo possono variare. */
function segreto(): string {
  return (process.env.ARGOS_PROXY_SECRET || "").trim();
}

export function argosProxyConfigured(): boolean {
  return segreto().length > 0;
}

/** Le intestazioni di una chiamata ad Argos: quelle date più il segreto. */
export function argosHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const s = segreto();
  return s ? { ...extra, [ARGOS_PROXY_HEADER]: s } : { ...extra };
}

/** All'avvio dell'API: quello che non torna nel segreto verso Argos. */
export function controllaSegretoArgosProxy(): string[] {
  const avvisi: string[] = [];
  const s = segreto();
  if (process.env.ARGOS_URL && !s) {
    avvisi.push("ARGOS_URL è impostata ma ARGOS_PROXY_SECRET no: Argos rifiuta ogni chiamata del pannello e della sorveglianza (DEPLOY.md, «Argos: il segreto del proxy»)");
  }
  if (s && (s === (process.env.CRON_SECRET || "").trim() || s === (process.env.ARGOS_CRON_SECRET || "").trim())) {
    avvisi.push("ARGOS_PROXY_SECRET è uguale a un segreto cron: chi ha l'uno ha anche l'altro. Generane uno diverso (DEPLOY.md, «Argos: il segreto del proxy»)");
  }
  for (const a of avvisi) logger.warn(a);
  return avvisi;
}
