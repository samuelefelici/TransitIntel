/**
 * ═══════════════════════════════════════════════════════════════════════════
 * QUANDO COMINCIA "OGGI"
 * ───────────────────────────────────────────────────────────────────────────
 * `date_trunc('day', now())` tronca nel fuso della SESSIONE del database, che
 * in produzione è UTC. La mezzanotte UTC in Italia è l'una o le due di notte:
 * "oggi" cominciava quindi a servizio già iniziato, e nelle ore piccole durava
 * ventisei ore. Il servizio notturno finiva contato nel giorno prima, e i
 * totali della giornata non tornavano con l'orario senza che nulla lo dicesse.
 *
 * La giornata di esercizio è quella dell'AZIENDA. È lo stesso fuso in cui si
 * confronta ogni orario programmato: ora è anche quello in cui si conta.
 *
 * Sta in un modulo suo perché lo usano tre file diversi, e la stessa giornata
 * definita in tre punti è la stessa giornata finché qualcuno non ne cambia uno.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { sql } from "drizzle-orm";

/** Fuso dell'azienda. */
export const FUSO_ESERCIZIO = process.env.SIRI_TIMEZONE || "Europe/Rome";

/**
 * L'istante in cui è cominciata la giornata di esercizio in corso.
 *
 * `now() AT TIME ZONE tz` dà l'ora di parete dell'azienda; troncata al giorno
 * dà la sua mezzanotte; riportata `AT TIME ZONE tz` torna a essere un istante
 * assoluto, confrontabile con una colonna timestamptz.
 */
export function inizioGiornata(timeZone: string = FUSO_ESERCIZIO) {
  return sql`(date_trunc('day', now() AT TIME ZONE ${timeZone}) AT TIME ZONE ${timeZone})`;
}
