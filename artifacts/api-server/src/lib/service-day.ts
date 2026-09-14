/**
 * ═══════════════════════════════════════════════════════════════════════════
 * LA GIORNATA DI ESERCIZIO
 * ───────────────────────────────────────────────────────────────────────────
 * Il server gira in UTC. Il servizio è in Europe/Rome. Le colonne `actual_ts`
 * e `ts` sono istanti assoluti (timestamptz). Ogni volta che si tronca a
 * giorno, si estrae l'ora, o si dice "oggi" senza passare dal fuso
 * dell'azienda, si ottiene un numero plausibile e sbagliato:
 *
 *   · `EXTRACT(HOUR FROM actual_ts)` dà l'ora UTC: la fascia 8-9 mostra i
 *     transiti delle 10-11, e l'istogramma della puntualità è spostato di
 *     due ore d'estate e una d'inverno;
 *   · `actual_ts::date` dà il giorno UTC: i transiti fra mezzanotte e le due
 *     finiscono nel giorno prima;
 *   · `new Date().toISOString().slice(0, 10)` dà la data UTC: alla mezzanotte
 *     italiana "oggi" è ancora ieri.
 *
 * Erano trenta punti sparsi in un file solo. Qui c'è UNA definizione, e chi
 * la usa non deve sapere niente di fusi.
 *
 * ── Perché la giornata non finisce a mezzanotte ──
 *
 * Il GTFS scrive "24:15:00" per l'orario di una corsa che passa dopo la
 * mezzanotte: appartiene alla giornata di servizio in cui è partita. Una
 * corsa notturna delle 23:55 → 00:18 è UNA corsa, e spezzarla a mezzanotte
 * — un pezzo ieri, un pezzo oggi — la fa sparire da entrambe le giornate e
 * inventa una corsa "non completata" e una "cominciata a metà".
 *
 * La giornata di esercizio comincia quindi a un'ora di taglio nel cuore della
 * notte, quando il servizio è fermo: prima di quell'ora si è ancora nella
 * giornata precedente. Tre del mattino è la convenzione consueta nel TPL; si
 * cambia con SIRI_SERVICE_DAY_CUTOVER_HOUR (0 = giorno civile).
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { sql, type SQL } from "drizzle-orm";

/** Fuso dell'azienda. */
export const FUSO_ESERCIZIO = process.env.SIRI_TIMEZONE || "Europe/Rome";

/** Ora locale (0-23) prima della quale si è ancora nella giornata precedente. */
export const TAGLIO_GIORNATA_ORE = (() => {
  const n = Number(process.env.SIRI_SERVICE_DAY_CUTOVER_HOUR);
  return Number.isFinite(n) && n >= 0 && n <= 12 ? Math.floor(n) : 3;
})();

/* ── Lato SQL ────────────────────────────────────────────────────────────
 * Frammenti da incastonare nelle query. Tutti prendono una colonna
 * timestamptz e restituiscono qualcosa nel fuso dell'azienda. */

/** L'istante come ora di parete dell'azienda: un `timestamp` senza fuso. */
export function oraDiParete(col: SQL, timeZone: string = FUSO_ESERCIZIO): SQL {
  return sql`(${col} AT TIME ZONE ${timeZone})`;
}

/**
 * La giornata di esercizio a cui appartiene un istante, come `date`.
 * Sottrae l'ora di taglio prima di troncare: le 01:30 del 13 sono ancora
 * il 12.
 */
export function giornataDi(col: SQL, timeZone: string = FUSO_ESERCIZIO): SQL {
  /* Le tre ore si tolgono sull'ISTANTE, prima di passare all'ora di parete:
   * è la stessa cosa che fa la versione JavaScript, e nelle notti di cambio
   * d'ora — quando le due e mezza esistono due volte — le due strade non
   * divergono. */
  return sql`((${col} - (${TAGLIO_GIORNATA_ORE}::int * interval '1 hour')) AT TIME ZONE ${timeZone})::date`;
}

/** L'ora del giorno (0-23) nel fuso dell'azienda: per le fasce orarie. */
export function oraDi(col: SQL, timeZone: string = FUSO_ESERCIZIO): SQL {
  return sql`EXTRACT(HOUR FROM (${col} AT TIME ZONE ${timeZone}))::int`;
}

/**
 * L'istante in cui comincia la giornata di esercizio "YYYY-MM-DD": l'ora di
 * taglio di quel giorno, nel fuso dell'azienda, come timestamptz.
 *
 * `date + interval` è un timestamp senza fuso; `AT TIME ZONE` lo interpreta
 * come ora di parete dell'azienda e lo trasforma in istante assoluto.
 */
export function inizioDi(ymd: string | SQL, timeZone: string = FUSO_ESERCIZIO): SQL {
  const giorno = typeof ymd === "string" ? sql`${ymd}::date` : ymd;
  return sql`((${giorno} + (${TAGLIO_GIORNATA_ORE}::int * interval '1 hour')) AT TIME ZONE ${timeZone})`;
}

/** Vero se l'istante cade nella giornata di esercizio "YYYY-MM-DD". */
export function nellaGiornata(col: SQL, ymd: string, timeZone: string = FUSO_ESERCIZIO): SQL {
  /* La fine è l'INIZIO del giorno dopo, non "inizio + 24 ore": nella notte
   * del cambio d'ora la giornata dura 23 o 25 ore, e con le 24 fisse un
   * istante finiva attribuito a una giornata da giornataDi e a un'altra da
   * qui. */
  return sql`(${col} >= ${inizioDi(ymd, timeZone)}
    AND ${col} < ${inizioDi(sql`${ymd}::date + 1`, timeZone)})`;
}

/** L'istante in cui è cominciata la giornata di esercizio in corso. */
export function inizioGiornata(timeZone: string = FUSO_ESERCIZIO): SQL {
  return inizioDi(giornataOggi(new Date(), timeZone), timeZone);
}

/* ── Lato JavaScript ─────────────────────────────────────────────────────── */

const FORMATO_GIORNO = new Map<string, Intl.DateTimeFormat>();
function formatoGiorno(timeZone: string): Intl.DateTimeFormat {
  let f = FORMATO_GIORNO.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
    FORMATO_GIORNO.set(timeZone, f);
  }
  return f;
}

/** La giornata di esercizio di un istante, "YYYY-MM-DD". */
export function giornataDiIstante(d: Date, timeZone: string = FUSO_ESERCIZIO): string {
  return formatoGiorno(timeZone).format(new Date(d.getTime() - TAGLIO_GIORNATA_ORE * 3_600_000));
}

/** La giornata di esercizio in corso, "YYYY-MM-DD". */
export function giornataOggi(now: Date = new Date(), timeZone: string = FUSO_ESERCIZIO): string {
  return giornataDiIstante(now, timeZone);
}

/** La data civile locale di un istante, "YYYY-MM-DD" — SENZA taglio. */
export function dataLocale(d: Date, timeZone: string = FUSO_ESERCIZIO): string {
  return formatoGiorno(timeZone).format(d);
}

/**
 * Un valore `date` come lo restituisce il driver — stringa o Date — reso
 * "YYYY-MM-DD" senza passare da `toISOString()`, che sposterebbe di un giorno
 * ogni data letta come mezzanotte locale su un server in UTC.
 */
export function comeGiorno(v: unknown): string {
  if (typeof v === "string") return v.slice(0, 10);
  if (v instanceof Date) {
    /* Il driver pg restituisce le colonne `date` come Date a mezzanotte nel
     * fuso del PROCESSO: si rileggono i campi locali, non quelli UTC. */
    const y = v.getFullYear(), m = v.getMonth() + 1, g = v.getDate();
    return `${y}-${String(m).padStart(2, "0")}-${String(g).padStart(2, "0")}`;
  }
  return String(v ?? "").slice(0, 10);
}
