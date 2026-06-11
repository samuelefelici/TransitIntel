/**
 * ═══════════════════════════════════════════════════════════════════════════
 * CLASSIFICATORE GIORNI — albero di validità a 3 livelli
 * ───────────────────────────────────────────────────────────────────────────
 * Ogni data cade in ESATTAMENTE una foglia (copertura totale, zero overlap):
 *
 *   1° livello: SCUOLE APERTE | SCUOLE CHIUSE | FESTIVO
 *   2° livello: scuole chiuse → INVERNALE | ESTIVO
 *               festivo       → DOMENICA  | ROSSO (festività di calendario)
 *   3° livello: giorno della settimana
 *
 * Precedenza: rosso > domenica > scuole aperte > estivo > invernale.
 * Funzioni pure, testabili: il profilo (periodi scolastici, periodo estivo,
 * festività extra) arriva dal calendario aziendale del progetto PS.
 * ═══════════════════════════════════════════════════════════════════════════
 */

export interface CalendarProfile {
  /** intervalli scuole aperte [{from:"YYYY-MM-DD", to:"YYYY-MM-DD"}] */
  schoolPeriods: Array<{ from: string; to: string }>;
  /** periodo estivo (per il ramo "scuole chiuse") */
  summerPeriod: { from: string; to: string } | null;
  /** festività extra oltre ai rossi nazionali (es. patrono) "MM-DD" o "YYYY-MM-DD" */
  extraHolidays: string[];
}

export interface DayClass {
  date: string;            // YYYY-MM-DD
  weekday: number;         // 0=lun … 6=dom
  level1: "scuole_aperte" | "scuole_chiuse" | "festivo";
  level2: "invernale" | "estivo" | "domenica" | "rosso" | null;
  /** etichetta foglia, es. "Scuole Aperte · Feriale", "Scuole Chiuse · Estivo · Sabato" */
  label: string;
  /** chiave compatta della foglia (per raggruppare in unità) */
  key: string;
}

/** Pasqua (algoritmo di Gauss/Butcher) → "YYYY-MM-DD". */
export function easterDate(year: number): string {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Rossi di calendario italiani per l'anno (incl. Pasqua e Pasquetta). */
export function italianHolidays(year: number): Set<string> {
  const fixed = ["01-01", "01-06", "04-25", "05-01", "06-02", "08-15", "11-01", "12-08", "12-25", "12-26"];
  const out = new Set(fixed.map((md) => `${year}-${md}`));
  const easter = easterDate(year);
  out.add(easter);
  const e = new Date(`${easter}T00:00:00Z`);
  out.add(new Date(e.getTime() + 86_400_000).toISOString().slice(0, 10)); // Pasquetta
  return out;
}

function inRange(date: string, from: string, to: string): boolean {
  return date >= from && date <= to;
}

const WEEKDAY_IT = ["Lunedì", "Martedì", "Mercoledì", "Giovedì", "Venerdì", "Sabato", "Domenica"];

/** Classifica una singola data secondo l'albero a 3 livelli. */
export function classifyDate(date: string, profile: CalendarProfile, holidays?: Set<string>): DayClass {
  const year = Number(date.slice(0, 4));
  const rossi = holidays ?? italianHolidays(year);
  const d = new Date(`${date}T00:00:00Z`);
  const weekday = (d.getUTCDay() + 6) % 7; // 0=lun … 6=dom
  const md = date.slice(5); // MM-DD

  const isExtra = profile.extraHolidays.some((h) => h === date || h === md);
  const isRosso = rossi.has(date) || isExtra;
  const isSunday = weekday === 6;

  let level1: DayClass["level1"];
  let level2: DayClass["level2"];
  if (isRosso) { level1 = "festivo"; level2 = "rosso"; }
  else if (isSunday) { level1 = "festivo"; level2 = "domenica"; }
  else if (profile.schoolPeriods.some((p) => inRange(date, p.from, p.to))) {
    level1 = "scuole_aperte"; level2 = null;
  } else if (profile.summerPeriod && inRange(date, profile.summerPeriod.from, profile.summerPeriod.to)) {
    level1 = "scuole_chiuse"; level2 = "estivo";
  } else {
    level1 = "scuole_chiuse"; level2 = "invernale";
  }

  // 3° livello: per i feriali distinguiamo lun-ven vs sabato (prassi TPL);
  // la chiave conserva comunque il weekday esatto per chi vuole granularità piena.
  const dayBand = level1 === "festivo" ? null : weekday === 5 ? "Sabato" : "Feriale";
  const l1Label = level1 === "scuole_aperte" ? "Scuole Aperte" : level1 === "scuole_chiuse" ? "Scuole Chiuse" : "Festivo";
  const l2Label = level2 === "invernale" ? "Invernale" : level2 === "estivo" ? "Estivo" : level2 === "domenica" ? "Domenica" : level2 === "rosso" ? "Rosso" : null;
  const label = [l1Label, l2Label, dayBand].filter(Boolean).join(" · ");
  const key = [level1, level2 ?? "-", dayBand ?? "-"].join("/");

  return { date, weekday, level1, level2, label, key };
}

/** Classifica un intervallo di date; ritorna anche il riepilogo per foglia. */
export function classifyRange(from: string, to: string, profile: CalendarProfile): {
  days: DayClass[];
  summary: Array<{ key: string; label: string; count: number; weekdays: string[] }>;
} {
  const days: DayClass[] = [];
  const holidaysByYear = new Map<number, Set<string>>();
  for (let t = new Date(`${from}T00:00:00Z`).getTime(); ; t += 86_400_000) {
    const date = new Date(t).toISOString().slice(0, 10);
    if (date > to) break;
    const y = Number(date.slice(0, 4));
    if (!holidaysByYear.has(y)) holidaysByYear.set(y, italianHolidays(y));
    days.push(classifyDate(date, profile, holidaysByYear.get(y)));
  }
  const byKey = new Map<string, { label: string; count: number; wd: Set<number> }>();
  for (const d of days) {
    const e = byKey.get(d.key) ?? { label: d.label, count: 0, wd: new Set<number>() };
    e.count++; e.wd.add(d.weekday);
    byKey.set(d.key, e);
  }
  return {
    days,
    summary: [...byKey.entries()]
      .map(([key, e]) => ({
        key, label: e.label, count: e.count,
        weekdays: [...e.wd].sort().map((w) => WEEKDAY_IT[w]),
      }))
      .sort((a, b) => b.count - a.count),
  };
}
