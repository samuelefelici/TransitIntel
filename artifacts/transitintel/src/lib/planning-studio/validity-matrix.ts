/**
 * PlannerStudio · Validity Matrix — algoritmo cell value (PURO, no I/O).
 *
 * Funzione condivisa: data una "fotografia" del progetto (trips, day_types,
 * calendario giorno→day_type, validità trip×day_type, eccezioni puntuali,
 * patroni locali), ritorna se la corsa è ATTIVA in una data specifica.
 *
 * Pensata per essere usata sia client-side (UI matrice) che server-side
 * (pipeline "Genera Unità di Progettazione" — PR4).
 *
 * Usata nei test Vitest: copertura 100% sui 6 casi obbligatori della spec
 * Cerbero · PlannerStudio Validity Matrix · v1.
 */

export interface DayType {
  id: string;
  code: string;
  name: string;
  color: string;
  is_system: boolean;
}

export interface Trip {
  id: string;
  is_active: boolean;
  valid_from: string | null; // 'YYYY-MM-DD'
  valid_to: string | null;
}

export interface MatrixContext {
  trips: Map<string, Trip>;
  dayTypes: Map<string, DayType>;
  /** trip_id → day_type_id → bool (default validity) */
  tripDayValidity: Map<string, Map<string, boolean>>;
  /** 'YYYY-MM-DD' → day_type_id (override esplicito, manca = inferito) */
  dayCalendar: Map<string, string>;
  /** trip_id → date → 1=add (force ON), 2=remove (force OFF) */
  tripExceptions: Map<string, Map<string, 1 | 2>>;
  /** Patroni locali in formato 'MM-DD' (es. '05-04' per San Ciriaco ad Ancona) */
  patronSaints: Set<string>;
  /** giorno → categoria di validità (calendario aziendale), opzionale */
  dayCategory?: Map<string, string>;
  /** vincolo per corsa: se presente e non vuoto, la corsa vale SOLO nei giorni
   *  la cui categoria è nel set */
  tripCategories?: Map<string, Set<string>>;
  /** maschera giorni-settimana per corsa: 7 boolean [Lun..Dom].
   *  Assente = tutti attivi. Permette di spegnere un singolo giorno
   *  (es. corsa feriale valida Lun-Ven ma NON il giovedì). */
  tripWeekdays?: Map<string, boolean[]>;
}

/** Indice giorno-settimana 0=Lun … 6=Dom di una data 'YYYY-MM-DD' (UTC). */
export function weekdayIndex(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return (new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1)).getUTCDay() + 6) % 7;
}

/**
 * Calcola se una corsa è attiva in una specifica data.
 *
 * Ordine di precedenza:
 *   1) Eccezione esplicita (`ps_trip_exceptions`) — force on/off
 *   2) Trip range (`valid_from`/`valid_to`) e flag `is_active`
 *   3) Default validity per (trip, day_type_della_data)
 */
export function getCellValidity(
  ctx: MatrixContext,
  tripId: string,
  date: string,
): boolean {
  // 1) Eccezione esplicita corsa×data → vince su tutto.
  const ex = ctx.tripExceptions.get(tripId)?.get(date);
  if (ex === 1) return true;
  if (ex === 2) return false;

  // 2) Validità range corsa.
  const trip = ctx.trips.get(tripId);
  if (!trip || !trip.is_active) return false;
  if (trip.valid_from && date < trip.valid_from) return false;
  if (trip.valid_to && date > trip.valid_to) return false;

  // 3) Day-type per la data (override → fallback inferito da DOW + patroni).
  const dayTypeId = ctx.dayCalendar.get(date) ?? inferDefaultDayType(date, ctx);
  if (!dayTypeId) return false;

  // 4) Default validity (trip, day_type). Assenza riga = false.
  if (!(ctx.tripDayValidity.get(tripId)?.get(dayTypeId) ?? false)) return false;

  // 4b) Maschera giorni-settimana della corsa (es. feriale MA senza giovedì).
  const wd = ctx.tripWeekdays?.get(tripId);
  if (wd && wd.length === 7 && wd[weekdayIndex(date)] === false) return false;

  // 5) Vincolo categorie (calendario aziendale): se la corsa ha ≥1 categorie,
  //    vale solo nei giorni la cui categoria è tra quelle selezionate.
  const cats = ctx.tripCategories?.get(tripId);
  if (cats && cats.size > 0) {
    const c = ctx.dayCategory?.get(date);
    if (!c || !cats.has(c)) return false;
  }
  return true;
}

/**
 * Inferenza day-type per una data senza override esplicito.
 * Regole:
 *   - Patrono locale → festivo
 *   - Domenica       → festivo
 *   - Sabato         → sabato
 *   - Lun-Ven        → feriale
 */
export function inferDefaultDayType(
  date: string,
  ctx: MatrixContext,
): string | null {
  const mmdd = date.slice(5); // 'MM-DD'
  if (ctx.patronSaints.has(mmdd)) return findDayTypeIdByCode(ctx.dayTypes, "festivo");

  // Usiamo UTC per evitare drift fuso orario sui confini di mezzanotte.
  const [yy, mm, dd] = date.split("-").map(Number);
  const dow = new Date(Date.UTC(yy, (mm ?? 1) - 1, dd ?? 1)).getUTCDay();
  if (dow === 0) return findDayTypeIdByCode(ctx.dayTypes, "festivo");
  if (dow === 6) return findDayTypeIdByCode(ctx.dayTypes, "sabato");
  return findDayTypeIdByCode(ctx.dayTypes, "feriale");
}

function findDayTypeIdByCode(dayTypes: Map<string, DayType>, code: string): string | null {
  for (const dt of dayTypes.values()) {
    if (dt.code === code) return dt.id;
  }
  return null;
}

/* ─────────────────────────────────────────────────────────────
 *  Festivi italiani — Pasqua via algoritmo di Gauss/Meeus
 * ───────────────────────────────────────────────────────────── */

/** Restituisce 'YYYY-MM-DD' della Pasqua cattolica per l'anno indicato. */
export function easterDate(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31); // 3=marzo, 4=aprile
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Aggiunge `days` giorni a una data 'YYYY-MM-DD' (UTC) → 'YYYY-MM-DD'. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const t = Date.UTC(y, (m ?? 1) - 1, (d ?? 1)) + days * 86_400_000;
  const nd = new Date(t);
  return `${nd.getUTCFullYear()}-${String(nd.getUTCMonth() + 1).padStart(2, "0")}-${String(nd.getUTCDate()).padStart(2, "0")}`;
}

/** Lista festivi nazionali italiani per l'anno: 12 voci (10 fissi + Pasqua + Pasquetta). */
export function italianHolidays(year: number): string[] {
  const easter = easterDate(year);
  const easterMonday = addDays(easter, 1);
  return [
    `${year}-01-01`, // Capodanno
    `${year}-01-06`, // Epifania
    easter,           // Pasqua
    easterMonday,     // Pasquetta
    `${year}-04-25`, // Liberazione
    `${year}-05-01`, // Festa del lavoro
    `${year}-06-02`, // Festa della Repubblica
    `${year}-08-15`, // Ferragosto
    `${year}-11-01`, // Tutti i Santi
    `${year}-12-08`, // Immacolata
    `${year}-12-25`, // Natale
    `${year}-12-26`, // Santo Stefano
  ];
}
