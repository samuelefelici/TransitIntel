/**
 * ═══════════════════════════════════════════════════════════════════════════
 * VALIDITÀ STAMPA ORARI — traduce "scuole aperte/chiuse" × giorno in un
 * filtro sui service_id del feed GTFS (che sono guidati dalle date).
 * ───────────────────────────────────────────────────────────────────────────
 * Strategia "data rappresentativa" (giorno tipo TPL): scelta la combinazione
 * (validità, giorno) si individua nel calendario del progetto PS una data
 * concreta del feed che ricade in quella foglia dell'albero (day-classifier),
 * e si filtra per i service_id attivi in quella data.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { classifyDate, type CalendarProfile } from "./day-classifier";

export type Validity = "scuole_aperte" | "scuole_chiuse";
export type DayType = "weekday" | "saturday" | "sunday";

/** YYYYMMDD → YYYY-MM-DD */
function dash(d: string): string {
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
}

/** banda giorno (allineata a day-classifier): weekday 5=Sabato, festivo=null */
function dayBandOf(weekday: number, level1: string): "Feriale" | "Sabato" | null {
  if (level1 === "festivo") return null;
  return weekday === 5 ? "Sabato" : "Feriale";
}

/**
 * service_id attivi su una data (YYYYMMDD), semantica GTFS completa:
 *   calendar (settimanale, entro start/end e DOW) ∪ calendar_dates(+1) − calendar_dates(−2).
 */
export async function activeServiceIdsOnDate(feedId: string, date: string): Promise<Set<string>> {
  const y = +date.slice(0, 4), m = +date.slice(4, 6), d = +date.slice(6, 8);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=dom..6=sab
  const dowCol = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"][dow];

  const cal = await db.execute<any>(sql.raw(`
    SELECT DISTINCT service_id FROM gtfs_calendar
    WHERE feed_id = '${feedId.replace(/'/g, "''")}'
      AND start_date <= '${date}' AND end_date >= '${date}' AND ${dowCol} = 1
  `));
  const add = await db.execute<any>(sql`
    SELECT DISTINCT service_id FROM gtfs_calendar_dates
    WHERE feed_id = ${feedId} AND date = ${date} AND exception_type = 1`);
  const rem = await db.execute<any>(sql`
    SELECT DISTINCT service_id FROM gtfs_calendar_dates
    WHERE feed_id = ${feedId} AND date = ${date} AND exception_type = 2`);

  const removed = new Set((rem.rows as any[]).map((x) => x.service_id));
  const set = new Set<string>();
  for (const x of cal.rows as any[]) if (!removed.has(x.service_id)) set.add(x.service_id);
  for (const x of add.rows as any[]) if (!removed.has(x.service_id)) set.add(x.service_id);
  return set;
}

/**
 * Sceglie la data rappresentativa ("giorno tipo") del feed per (validità, giorno):
 * tra le date servite dal feed che ricadono nella foglia richiesta, quella con
 * più service_id attivi (giorno a servizio pieno); tie-break sulla più recente.
 */
export async function pickRepresentativeDate(
  feedId: string, profile: CalendarProfile, validity: Validity, dayType: DayType,
): Promise<{ date: string | null; iso: string | null; note?: string }> {
  // Domeniche: ora si dividono per stato scuole → la validità scelta filtra la
  // foglia "domenica (scuole aperte)" vs "domenica (scuole chiuse)".
  const wantSundayLevel2 = validity === "scuole_chiuse" ? "domenica_chiuse" : "domenica_aperte";
  const wantBand = dayType === "sunday" ? null : dayType === "saturday" ? "Sabato" : "Feriale";

  const cand = await db.execute<any>(sql`
    SELECT date, COUNT(DISTINCT service_id)::int AS n
    FROM gtfs_calendar_dates
    WHERE feed_id = ${feedId} AND exception_type = 1
    GROUP BY date`);

  let best: { date: string; n: number } | null = null;
  for (const row of cand.rows as any[]) {
    const ymd = String(row.date);
    if (!/^\d{8}$/.test(ymd)) continue;
    const cls = classifyDate(dash(ymd), profile);
    if (dayType === "sunday") {
      if (cls.level1 !== "festivo" || cls.level2 !== wantSundayLevel2) continue;
    } else {
      if (cls.level1 !== validity) continue;
      if (wantBand !== null && dayBandOf(cls.weekday, cls.level1) !== wantBand) continue;
    }
    const n = Number(row.n) || 0;
    if (!best || n > best.n || (n === best.n && ymd > best.date)) best = { date: ymd, n };
  }
  if (!best) {
    return { date: null, iso: null, note: "Nessuna data del feed corrisponde alla validità/giorno scelti" };
  }
  return { date: best.date, iso: dash(best.date) };
}

/**
 * Risolve il filtro service_id per la stampa orari.
 * Se validity+projectId sono presenti → filtro per data rappresentativa.
 * Altrimenti ritorna null (il chiamante usa il fallback dayType/buildServiceDayMap).
 */
export async function resolveValidityServiceFilter(
  feedId: string,
  opts: { validity: Validity | null; projectId: string | null; dayType: DayType; profile: CalendarProfile | null },
): Promise<{ serviceIds: Set<string> | null; representativeDate: string | null; note?: string }> {
  if (!opts.validity || !opts.profile) {
    return { serviceIds: null, representativeDate: null };
  }
  const rep = await pickRepresentativeDate(feedId, opts.profile, opts.validity, opts.dayType);
  if (!rep.date) return { serviceIds: new Set(), representativeDate: null, note: rep.note };
  const serviceIds = await activeServiceIdsOnDate(feedId, rep.date);
  return { serviceIds, representativeDate: rep.iso };
}
