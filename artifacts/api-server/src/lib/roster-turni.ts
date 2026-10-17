/**
 * ═══════════════════════════════════════════════════════════════════════════
 * I TURNI GUIDA DI UN DSS, COME LI VEDE IL ROSTER
 * ───────────────────────────────────────────────────────────────────────────
 * Dal JSON del risultato di un DSS (driver_shift_scenarios.result, formato
 * crew_scheduler_v4) ai turni del roster: codice, orari, tipo, residenza,
 * tratte. Il codice è driverId, dutyId, id, o T<posizione>: la stessa regola
 * che turniDelDss usa in SQL (roster-normativa-db.ts).
 * ═══════════════════════════════════════════════════════════════════════════
 */

export interface DutySegment {
  type: string;                 // trip | deadhead | depot | riserva …
  line: string | null;          // linea (route) — null per fuorilinea/attività
  startTime: string | null; startPlace: string | null;
  endTime: string | null;   endPlace: string | null;
}
const _hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(Math.round(m) % 60).padStart(2, "0")}`;

export interface TurnoRoster {
  code: string; type: string | null; start: string | null; end: string | null;
  nastro: string | null; work: string | null;
  interruption: string | null; ripreseCount: number; tripsCount: number; costEuro: number | null;
  residenzaName: string | null; residenzaColor: string | null;
  segments: DutySegment[];
}

/** Il codice di un turno nel DSS: la stessa regola ovunque. */
export const codiceTurno = (d: any, i: number): string => String(d?.driverId ?? d?.dutyId ?? d?.id ?? `T${i + 1}`);

/** La lista dei turni nel risultato di un DSS. */
export const turniDelRisultato = (result: any): any[] => {
  const list = result?.driverShifts ?? result?.duties ?? [];
  return Array.isArray(list) ? list : [];
};

/** Un turno del DSS come lo mostra il roster. */
export function turnoRoster(d: any, i: number): TurnoRoster {
  const riprese = Array.isArray(d?.riprese) ? d.riprese : [];
  const tripsCount = riprese.reduce(
    (s: number, r: any) => s + (Array.isArray(r?.trips) ? r.trips.filter((t: any) => (t?.type ?? "trip") === "trip").length : 0),
    0,
  );
  // Contenuto del turno: ogni tratta con linea, orari e luoghi (anche fuorilinea).
  const segments: DutySegment[] = [];
  for (const r of riprese) {
    for (const t of (Array.isArray(r?.trips) ? r.trips : [])) {
      segments.push({
        type: t?.type ?? "trip",
        line: t?.routeName ?? t?.routeShortName ?? (t?.routeId || null),
        startTime: t?.departureTime ?? (typeof t?.departureMin === "number" ? _hhmm(t.departureMin) : null),
        startPlace: t?.firstStopName ?? null,
        endTime: t?.arrivalTime ?? (typeof t?.arrivalMin === "number" ? _hhmm(t.arrivalMin) : null),
        endPlace: t?.lastStopName ?? null,
      });
    }
  }
  return {
    code: codiceTurno(d, i),
    type: d?.type ?? d?.dutyType ?? null,
    start: d?.nastroStart ?? d?.startTime ?? null,
    end: d?.nastroEnd ?? d?.endTime ?? null,
    nastro: d?.nastro ?? null,
    work: d?.work ?? null,
    interruption: d?.interruption ?? null,
    ripreseCount: riprese.length,
    tripsCount,
    costEuro: typeof d?.costEuro === "number" ? d.costEuro : null,
    // Residenza per-turno (dal turno macchina, propagata dal crew scheduler)
    residenzaName: d?.residenzaName ?? null,
    residenzaColor: d?.residenzaColor ?? null,
    segments,
  };
}

/** Estrae i turni guida dal result JSON di un DSS (formato crew_scheduler_v4). */
export function extractDuties(result: any): TurnoRoster[] {
  return turniDelRisultato(result).map(turnoRoster);
}
