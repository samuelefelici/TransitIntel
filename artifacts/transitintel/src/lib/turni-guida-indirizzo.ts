/* L'indirizzo della pagina dei turni guida.
 *
 * La pagina vive dentro la Fucina: /fucina/<progetto>/drivers/<scenario>.
 * Prima ce n'era una seconda a /driver-shifts/<scenario>: i link salvati a
 * quell'indirizzo vengono portati qui. Lì il progetto non c'era, quindi lo si
 * chiede all'API con lo scenario; se manca si va all'elenco dei progetti. */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const ELENCO_PROGETTI = "/fucina/esercizio";

/** Un id è buono solo se è un uuid: finisce dentro un indirizzo. */
export function eUuid(v: unknown): v is string {
  return typeof v === "string" && UUID.test(v);
}

/**
 * La pagina dei turni guida di uno scenario dei turni macchina, con il
 * salvataggio da aprire se c'è. Con un progetto o uno scenario che non sono
 * uuid restituisce l'elenco dei progetti.
 */
export function paginaTurniGuida(progetto: unknown, scenario: unknown, salvataggio?: unknown): string {
  if (!eUuid(progetto) || !eUuid(scenario)) return ELENCO_PROGETTI;
  const base = `/fucina/${progetto}/drivers/${scenario}`;
  return eUuid(salvataggio) ? `${base}?dss=${salvataggio}` : base;
}

/** Il salvataggio chiesto da un vecchio link (?dss=<id>), se è un uuid. */
export function salvataggioDelLink(query: string): string | null {
  const v = new URLSearchParams(query).get("dss");
  return eUuid(v) ? v : null;
}
