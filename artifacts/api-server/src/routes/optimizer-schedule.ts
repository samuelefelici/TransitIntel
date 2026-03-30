/**
 * OPTIMIZER 2 — Schedule Optimizer
 *
 * Loads ALL trips in the GTFS feed (no day-type filter) and analyses:
 *  1. Superfluous / duplicate trips (same route, same direction, <5 min apart)
 *  2. Overcrowded trips (high demand, no nearby trip within 15 min)
 *  3. Morning rush pile-ups (too many trips bunched in 15-min slots 6:45–9:00)
 *  4. Low-demand off-peak trips
 *  5. Intermodal connection gaps at 6 hubs
 *
 * NOTE: Vehicle scheduling (turni macchina) is deliberately omitted —
 * that is a separate optimisation step.
 *
 * POST /api/optimizer/schedule   {}     (no params needed)
 */
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  gtfsTrips, gtfsStopTimes, gtfsRoutes,
  gtfsCalendar, gtfsCalendarDates,
} from "@workspace/db/schema";
import { eq, sql, and, inArray } from "drizzle-orm";
import { timeToMinutes, minToTime } from "../lib/geo-utils";
import { getLatestFeedId, HOURLY_MODEL } from "./gtfs-helpers";
import { spawn } from "node:child_process";
import path from "node:path";

// Scripts are at the monorepo root: ../../scripts relative to api-server/
const SCRIPTS_DIR = path.resolve(process.cwd(), "..", "..", "scripts");

const router: IRouter = Router();

/* ═══════════════════════════════════════════════════════════════
 *  SERVICE-ID FILTER — find which services are active on a date
 * ═══════════════════════════════════════════════════════════════ */

/** Day-of-week columns in gtfs_calendar, indexed 0=Sunday .. 6=Saturday */
const DOW_COLS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;

/**
 * Given a feed and a date string (YYYYMMDD), return the set of service_ids
 * that are active on that specific date, honouring both calendar and
 * calendar_dates (exception_type 1=added, 2=removed).
 */
async function getActiveServiceIds(feedId: string, dateYMD: string): Promise<Set<string>> {
  // 1. Parse the date to get day-of-week (0=Sun, 1=Mon, ..., 6=Sat)
  const y = parseInt(dateYMD.slice(0, 4));
  const m = parseInt(dateYMD.slice(4, 6)) - 1;
  const d = parseInt(dateYMD.slice(6, 8));
  const dow = new Date(y, m, d).getDay(); // 0=Sun
  const dowCol = DOW_COLS[dow]; // e.g. "wednesday"

  // 2. From calendar: services where start_date <= date <= end_date AND dow=1
  const calRows = await db.select({ serviceId: gtfsCalendar.serviceId })
    .from(gtfsCalendar)
    .where(and(
      eq(gtfsCalendar.feedId, feedId),
      sql`${gtfsCalendar.startDate} <= ${dateYMD}`,
      sql`${gtfsCalendar.endDate} >= ${dateYMD}`,
      sql`${sql.raw(`"${dowCol}"`)} = 1`,
    ));

  const active = new Set(calRows.map(r => r.serviceId));

  // 3. From calendar_dates: add type=1, remove type=2
  const cdRows = await db.select({
    serviceId: gtfsCalendarDates.serviceId,
    exceptionType: gtfsCalendarDates.exceptionType,
  }).from(gtfsCalendarDates).where(and(
    eq(gtfsCalendarDates.feedId, feedId),
    eq(gtfsCalendarDates.date, dateYMD),
  ));

  for (const cd of cdRows) {
    if (cd.exceptionType === 1) active.add(cd.serviceId);
    if (cd.exceptionType === 2) active.delete(cd.serviceId);
  }

  // 4. Fallback: if calendar table is empty, only calendar_dates defines services
  //    (already handled by step 3 adding type=1 entries)

  return active;
}

/* ═══════════════════════════════════════════════════════════════
 *  INTERMODAL HUBS (lite copy)
 * ═══════════════════════════════════════════════════════════════ */
const INTERMODAL_HUBS = [
  {
    id: "rail-ancona", name: "Stazione FS Ancona",
    gtfsStopIds: ["13", "18", "153", "20006", "20044"],
    walkMin: 3,
    arrivals: ["06:25","06:55","07:10","07:25","07:40","07:55","08:25","08:40","08:45","08:55","09:10","09:55","10:15","10:55","11:10","11:50","11:55","12:55","13:10","13:45","13:55","14:55","15:10","15:50","15:55","16:25","16:55","17:10","17:25","17:45","17:55","18:25","18:35","18:55","19:10","19:40","19:55","20:10","20:45","20:55","21:55","22:10"],
  },
  {
    id: "rail-falconara", name: "Stazione FS Falconara",
    gtfsStopIds: ["20026", "20027"],
    walkMin: 2,
    arrivals: ["06:30","07:00","07:30","07:50","08:00","08:30","08:50","09:00","09:50","10:00","10:30","11:00","11:50","12:00","13:00","13:50","14:00","14:30","15:00","15:50","16:00","16:30","17:00","17:30","17:50","18:00","18:30","18:50","19:00","19:50","20:00","21:00","21:30","21:50"],
  },
  {
    id: "rail-palombina", name: "Stazione Palombina",
    gtfsStopIds: ["20020", "20034"],
    walkMin: 1,
    arrivals: ["06:35","06:55","07:35","07:55","08:35","08:55","09:35","10:55","12:35","13:55","14:35","15:55","16:35","17:35","17:55","18:35","19:35","19:55"],
  },
  {
    id: "port-ancona", name: "Porto di Ancona",
    gtfsStopIds: ["20003", "20047"],
    walkMin: 8,
    arrivals: ["07:00","09:00","14:30","16:00"],
  },
  {
    id: "airport-falconara", name: "Aeroporto Falconara",
    gtfsStopIds: ["20028"],
    walkMin: 5,
    arrivals: ["08:00","10:30","13:00","15:30","18:00","20:30","22:30"],
  },
  {
    id: "rail-torrette", name: "Stazione Torrette",
    gtfsStopIds: ["20021", "20035"],
    walkMin: 2,
    arrivals: ["06:40","07:40","08:40","09:40","12:40","14:40","16:40","17:40","18:40","19:40"],
  },
];

/* ═══════════════════════════════════════════════════════════════
 *  TYPES
 * ═══════════════════════════════════════════════════════════════ */

type Priority = "critical" | "high" | "medium" | "low";

interface ScheduleSuggestion {
  id: string;
  type: "superfluous" | "overcrowded" | "rush-pileup" | "intermodal-gap" | "low-demand";
  priority: Priority;
  routeName: string;
  routeId: string;
  description: string;
  details: string;
  impact: string;
  action: "remove" | "add" | "shift" | "merge";
  affectedTrips: { tripId: string; departureTime: string; headsign: string | null }[];
  proposedChange?: string;
  savingsMinutes?: number;
}

interface TripInfo {
  tripId: string;
  routeId: string;
  routeName: string;
  serviceId: string;
  headsign: string | null;
  directionId: number;
  firstDeparture: string;
  lastArrival: string;
  firstDepartureMin: number;
  lastArrivalMin: number;
  stopCount: number;
  durationMin: number;
  firstStopId: string;
  lastStopId: string;
  estimatedDemand: number;
}

interface RouteStats {
  routeId: string;
  routeName: string;
  totalTrips: number;
  avgHeadwayMin: number;
  peakTrips: number;
  offPeakTrips: number;
}

/* ═══════════════════════════════════════════════════════════════
 *  HELPERS
 * ═══════════════════════════════════════════════════════════════ */

function estimateDemand(depMin: number, routeTripsTotal: number, allTripsCount: number): number {
  const hour = Math.floor(depMin / 60);
  const hModel = HOURLY_MODEL[Math.min(26, Math.max(0, hour))] ?? 0.05;
  const routeWeight = Math.min(1, routeTripsTotal / Math.max(1, allTripsCount) * 20);
  return Math.round(Math.min(100, hModel * 100 * (0.5 + routeWeight * 0.5)));
}

/* ═══════════════════════════════════════════════════════════════
 *  CORE OPTIMIZER — loads trips active on a specific date
 * ═══════════════════════════════════════════════════════════════ */

async function optimizeSchedule(feedId: string, dateYMD: string) {
  // 0. Find active services for the requested date
  const activeServices = await getActiveServiceIds(feedId, dateYMD);
  if (activeServices.size === 0) {
    return { suggestions: [], routeStats: [], hourlyDist: [], date: dateYMD,
      summary: { date: dateYMD, activeServices: 0, totalTrips: 0, totalRoutes: 0, totalServices: 0,
        suggestionsCount: { total: 0, critical: 0, high: 0, medium: 0, low: 0 },
        totalSavingsMinutes: 0, peakHour: { hour: 8, trips: 0, demand: 0 },
        byType: { superfluous: 0, overcrowded: 0, rushPileup: 0, lowDemand: 0, intermodalGap: 0 },
        message: `Nessun servizio attivo per la data ${dateYMD}`,
      }};
  }

  // 1. Load trips for active services only
  const allTrips = await db.select({
    tripId: gtfsTrips.tripId,
    routeId: gtfsTrips.routeId,
    serviceId: gtfsTrips.serviceId,
    headsign: gtfsTrips.tripHeadsign,
    directionId: gtfsTrips.directionId,
  }).from(gtfsTrips).where(eq(gtfsTrips.feedId, feedId));

  // Filter to only active services
  const trips = allTrips.filter(t => activeServices.has(t.serviceId));

  if (trips.length === 0) {
    return { suggestions: [], routeStats: [], hourlyDist: [], date: dateYMD,
      summary: { date: dateYMD, activeServices: activeServices.size, totalTrips: 0, totalRoutes: 0, totalServices: activeServices.size,
        suggestionsCount: { total: 0, critical: 0, high: 0, medium: 0, low: 0 },
        totalSavingsMinutes: 0, peakHour: { hour: 8, trips: 0, demand: 0 },
        byType: { superfluous: 0, overcrowded: 0, rushPileup: 0, lowDemand: 0, intermodalGap: 0 },
        message: `Nessuna corsa trovata per i ${activeServices.size} servizi attivi il ${dateYMD}`,
      }};
  }

  // 2. Load ALL stop_times in feed
  const stopTimesRaw = await db.execute<{
    trip_id: string; stop_id: string; stop_sequence: number;
    departure_time: string | null; arrival_time: string | null;
  }>(sql`
    SELECT trip_id, stop_id, stop_sequence, departure_time, arrival_time
    FROM gtfs_stop_times
    WHERE feed_id = ${feedId}
    ORDER BY trip_id, stop_sequence
  `);

  const stByTrip: Record<string, typeof stopTimesRaw.rows> = {};
  for (const st of stopTimesRaw.rows) {
    if (!stByTrip[st.trip_id]) stByTrip[st.trip_id] = [];
    stByTrip[st.trip_id].push(st);
  }

  // 3. Load route names
  const routeRows = await db.select({
    routeId: gtfsRoutes.routeId,
    shortName: gtfsRoutes.routeShortName,
    longName: gtfsRoutes.routeLongName,
    tripsCount: gtfsRoutes.tripsCount,
  }).from(gtfsRoutes).where(eq(gtfsRoutes.feedId, feedId));
  const routeMap = new Map(routeRows.map(r => [r.routeId, r]));

  // 4. Build TripInfo array
  const tripInfos: TripInfo[] = [];
  for (const t of trips) {
    const sts = stByTrip[t.tripId];
    if (!sts || sts.length === 0) continue;
    sts.sort((a, b) => a.stop_sequence - b.stop_sequence);
    const firstDep = sts[0].departure_time || sts[0].arrival_time || "00:00:00";
    const lastArr = sts[sts.length - 1].arrival_time || sts[sts.length - 1].departure_time || firstDep;
    const firstMin = timeToMinutes(firstDep);
    const lastMin = timeToMinutes(lastArr);
    const rInfo = routeMap.get(t.routeId);
    const routeName = rInfo?.shortName || rInfo?.longName || t.routeId;

    tripInfos.push({
      tripId: t.tripId,
      routeId: t.routeId,
      routeName,
      serviceId: t.serviceId,
      headsign: t.headsign,
      directionId: t.directionId ?? 0,
      firstDeparture: firstDep,
      lastArrival: lastArr,
      firstDepartureMin: firstMin,
      lastArrivalMin: lastMin,
      stopCount: sts.length,
      durationMin: Math.max(1, lastMin - firstMin),
      firstStopId: sts[0].stop_id,
      lastStopId: sts[sts.length - 1].stop_id,
      estimatedDemand: estimateDemand(firstMin, rInfo?.tripsCount ?? 1, trips.length),
    });
  }

  tripInfos.sort((a, b) => a.firstDepartureMin - b.firstDepartureMin);

  // 5. Group by route + direction
  const byRouteDir: Record<string, TripInfo[]> = {};
  for (const t of tripInfos) {
    const key = `${t.routeId}__${t.directionId}`;
    if (!byRouteDir[key]) byRouteDir[key] = [];
    byRouteDir[key].push(t);
  }

  const suggestions: ScheduleSuggestion[] = [];
  let suggId = 0;

  // ── Analysis A: Superfluous / duplicate trips ──────────────
  for (const [_key, grp] of Object.entries(byRouteDir)) {
    grp.sort((a, b) => a.firstDepartureMin - b.firstDepartureMin);
    for (let i = 1; i < grp.length; i++) {
      const gap = grp[i].firstDepartureMin - grp[i - 1].firstDepartureMin;
      if (gap >= 0 && gap <= 5) {
        const lowerDemand = grp[i].estimatedDemand <= grp[i - 1].estimatedDemand ? grp[i] : grp[i - 1];
        const higherDemand = lowerDemand === grp[i] ? grp[i - 1] : grp[i];
        suggestions.push({
          id: `S${++suggId}`,
          type: "superfluous",
          priority: lowerDemand.estimatedDemand < 30 ? "high" : "medium",
          routeName: grp[0].routeName,
          routeId: grp[0].routeId,
          description: `Due corse quasi sovrapposte (${gap} min di scarto)`,
          details: `"${lowerDemand.tripId}" (${lowerDemand.firstDeparture}) e "${higherDemand.tripId}" (${higherDemand.firstDeparture}) servono lo stesso percorso/direzione con solo ${gap} minuti di differenza. Servizio: ${lowerDemand.serviceId}.`,
          impact: `Rimozione di 1 corsa risparmia ~${lowerDemand.durationMin} min/veicolo`,
          action: "remove",
          affectedTrips: [lowerDemand, higherDemand].map(t => ({
            tripId: t.tripId, departureTime: t.firstDeparture, headsign: t.headsign,
          })),
          proposedChange: `Rimuovere corsa "${lowerDemand.tripId}" (${lowerDemand.firstDeparture}) — domanda stimata più bassa (${lowerDemand.estimatedDemand}/100)`,
          savingsMinutes: lowerDemand.durationMin,
        });
      }
    }
  }

  // ── Analysis B: Overcrowded trips (high demand, isolated) ──
  for (const [_key, grp] of Object.entries(byRouteDir)) {
    grp.sort((a, b) => a.firstDepartureMin - b.firstDepartureMin);
    for (let i = 0; i < grp.length; i++) {
      const t = grp[i];
      if (t.estimatedDemand < 65) continue;
      const prevGap = i > 0 ? t.firstDepartureMin - grp[i - 1].firstDepartureMin : 999;
      const nextGap = i < grp.length - 1 ? grp[i + 1].firstDepartureMin - t.firstDepartureMin : 999;
      if (prevGap > 15 && nextGap > 15) {
        suggestions.push({
          id: `S${++suggId}`,
          type: "overcrowded",
          priority: t.estimatedDemand >= 80 ? "critical" : "high",
          routeName: t.routeName,
          routeId: t.routeId,
          description: `Corsa ad alta domanda isolata (${t.estimatedDemand}/100)`,
          details: `"${t.tripId}" parte alle ${t.firstDeparture} con domanda stimata ${t.estimatedDemand}/100 ma la corsa precedente è a ${prevGap > 100 ? "nessuna" : prevGap + " min"} e la successiva a ${nextGap > 100 ? "nessuna" : nextGap + " min"}.`,
          impact: `Aggiungendo una corsa parallela si dimezza il carico passeggeri nella fascia`,
          action: "add",
          affectedTrips: [{ tripId: t.tripId, departureTime: t.firstDeparture, headsign: t.headsign }],
          proposedChange: `Aggiungere corsa 10 min prima (${minToTime(t.firstDepartureMin - 10)}) o 10 min dopo (${minToTime(t.firstDepartureMin + 10)})`,
        });
      }
    }
  }

  // ── Analysis C: Morning rush pile-up ───────────────────────
  const slotSize = 15;
  const rushStart = 6 * 60 + 45;
  const rushEnd = 9 * 60;
  const slots: Record<number, TripInfo[]> = {};
  for (const t of tripInfos) {
    if (t.firstDepartureMin >= rushStart && t.firstDepartureMin < rushEnd) {
      const slot = Math.floor((t.firstDepartureMin - rushStart) / slotSize) * slotSize + rushStart;
      if (!slots[slot]) slots[slot] = [];
      slots[slot].push(t);
    }
  }
  const slotKeys = Object.keys(slots).map(Number).sort((a, b) => a - b);
  const avgSlotTrips = slotKeys.length > 0
    ? slotKeys.reduce((s, k) => s + slots[k].length, 0) / slotKeys.length
    : 0;
  for (const slotMin of slotKeys) {
    const slotTrips = slots[slotMin];
    if (slotTrips.length > avgSlotTrips * 1.8 && slotTrips.length >= 5) {
      const slotLabel = minToTime(slotMin) + "–" + minToTime(slotMin + slotSize);
      const lowDemandInSlot = slotTrips
        .filter(t => t.estimatedDemand < 50)
        .sort((a, b) => a.estimatedDemand - b.estimatedDemand)
        .slice(0, 3);

      if (lowDemandInSlot.length > 0) {
        suggestions.push({
          id: `S${++suggId}`,
          type: "rush-pileup",
          priority: "high",
          routeName: "Fascia oraria",
          routeId: "*",
          description: `Accumulo corse nella fascia ${slotLabel} (${slotTrips.length} corse vs media ${avgSlotTrips.toFixed(1)})`,
          details: `${slotTrips.length} corse partono nella fascia ${slotLabel}. Media per slot: ${avgSlotTrips.toFixed(1)}. Distribuire le partenze riduce la congestione.`,
          impact: `Distribuendo ${lowDemandInSlot.length} corse si alleggerisce la fascia di picco`,
          action: "shift",
          affectedTrips: lowDemandInSlot.map(t => ({
            tripId: t.tripId, departureTime: t.firstDeparture, headsign: t.headsign,
          })),
          proposedChange: lowDemandInSlot.map(t =>
            `Spostare "${t.routeName}" (${t.firstDeparture}) di +15/+20 min`
          ).join("; "),
          savingsMinutes: lowDemandInSlot.length * 15,
        });
      }
    }
  }

  // ── Analysis D: Low-demand off-peak trips ──────────────────
  for (const t of tripInfos) {
    if (t.estimatedDemand <= 15 && t.firstDepartureMin >= 9 * 60 + 30 && t.firstDepartureMin <= 15 * 60) {
      suggestions.push({
        id: `S${++suggId}`,
        type: "low-demand",
        priority: "low",
        routeName: t.routeName,
        routeId: t.routeId,
        description: `Corsa a domanda molto bassa (${t.estimatedDemand}/100) nella fascia off-peak`,
        details: `"${t.tripId}" (${t.firstDeparture}, ${t.stopCount} fermate, dir: ${t.headsign ?? "—"}) ha domanda stimata di soli ${t.estimatedDemand}/100.`,
        impact: `Rimozione risparmia ~${t.durationMin} min/veicolo/giorno`,
        action: "remove",
        affectedTrips: [{ tripId: t.tripId, departureTime: t.firstDeparture, headsign: t.headsign }],
        proposedChange: `Valutare soppressione o accorpamento con corsa vicina`,
        savingsMinutes: t.durationMin,
      });
    }
  }

  // ── Analysis E: Intermodal connection gaps ─────────────────
  const allHubStopIds = INTERMODAL_HUBS.flatMap(h => h.gtfsStopIds);
  const hubStopTimesRaw = await db.execute<{
    stop_id: string; departure_time: string | null; arrival_time: string | null;
  }>(sql`
    SELECT DISTINCT stop_id, departure_time, arrival_time
    FROM gtfs_stop_times
    WHERE feed_id = ${feedId}
      AND stop_id IN ${sql.raw(`(${allHubStopIds.map(s => `'${s}'`).join(",")})`)}
    ORDER BY stop_id, departure_time
  `);

  const busDeparturesByStop: Record<string, number[]> = {};
  for (const st of hubStopTimesRaw.rows) {
    const time = st.departure_time || st.arrival_time;
    if (!time) continue;
    if (!busDeparturesByStop[st.stop_id]) busDeparturesByStop[st.stop_id] = [];
    busDeparturesByStop[st.stop_id].push(timeToMinutes(time));
  }

  for (const hub of INTERMODAL_HUBS) {
    const allBusDeps: number[] = [];
    for (const sid of hub.gtfsStopIds) {
      if (busDeparturesByStop[sid]) allBusDeps.push(...busDeparturesByStop[sid]);
    }
    allBusDeps.sort((a, b) => a - b);
    if (allBusDeps.length === 0) continue;

    for (const arrTimeStr of hub.arrivals) {
      const arrMin = timeToMinutes(arrTimeStr + ":00");
      const readyMin = arrMin + hub.walkMin;
      const nextBus = allBusDeps.find(d => d >= readyMin);
      const waitMin = nextBus != null ? nextBus - readyMin : null;

      if (waitMin == null || waitMin > 30) {
        suggestions.push({
          id: `S${++suggId}`,
          type: "intermodal-gap",
          priority: waitMin == null ? "critical" : waitMin > 45 ? "high" : "medium",
          routeName: hub.name,
          routeId: hub.id,
          description: waitMin == null
            ? `Nessun autobus dopo arrivo treno/nave alle ${arrTimeStr}`
            : `Attesa ${waitMin} min al ${hub.name} dopo arrivo delle ${arrTimeStr}`,
          details: waitMin == null
            ? `Un treno/nave arriva alle ${arrTimeStr} (passeggero pronto alle ${minToTime(readyMin)}). Nessun autobus disponibile.`
            : `Passeggero pronto alle ${minToTime(readyMin)}, primo autobus alle ${minToTime(nextBus!)}. Attesa di ${waitMin} minuti.`,
          impact: waitMin == null
            ? "Passeggeri senza servizio — costretti a taxi/auto privata"
            : `Ridurre attesa a <10 min migliora l'intermodalità`,
          action: "add",
          affectedTrips: [],
          proposedChange: `Aggiungere corsa con partenza ${minToTime(readyMin + 3)}–${minToTime(readyMin + 8)} dal ${hub.name}`,
        });
      }
    }
  }

  // ── Route stats (informational only, no vehicle scheduling) ─
  const routeStatsMap: Record<string, { trips: TripInfo[]; routeId: string; routeName: string }> = {};
  for (const t of tripInfos) {
    const key = `${t.routeId}__${t.directionId}`;
    if (!routeStatsMap[key]) {
      routeStatsMap[key] = { trips: [], routeId: t.routeId, routeName: t.routeName };
    }
    routeStatsMap[key].trips.push(t);
  }
  const routeStats: RouteStats[] = Object.values(routeStatsMap).map(({ trips: grp, routeId, routeName }) => {
    grp.sort((a, b) => a.firstDepartureMin - b.firstDepartureMin);
    const peakTrips = grp.filter(t => t.firstDepartureMin >= 7 * 60 && t.firstDepartureMin < 9 * 60).length;
    const gaps = grp.slice(1).map((t, i) => t.firstDepartureMin - grp[i].firstDepartureMin);
    const avgHeadway = gaps.length > 0 ? gaps.reduce((s, g) => s + g, 0) / gaps.length : 0;
    return {
      routeId,
      routeName,
      totalTrips: grp.length,
      avgHeadwayMin: +avgHeadway.toFixed(1),
      peakTrips,
      offPeakTrips: grp.length - peakTrips,
    };
  }).sort((a, b) => b.totalTrips - a.totalTrips);

  // Sort suggestions by priority
  const priorityOrder: Record<Priority, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  suggestions.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

  // ── Hourly distribution ────────────────────────────────────
  const hourlyDist: { hour: number; trips: number; demand: number }[] = [];
  for (let h = 4; h <= 26; h++) {
    const tripsInHour = tripInfos.filter(t => Math.floor(t.firstDepartureMin / 60) === h);
    hourlyDist.push({
      hour: h,
      trips: tripsInHour.length,
      demand: Math.round(tripsInHour.reduce((s, t) => s + t.estimatedDemand, 0) / Math.max(1, tripsInHour.length)),
    });
  }

  // ── Summary ────────────────────────────────────────────────
  const summary = {
    date: dateYMD,
    activeServices: activeServices.size,
    totalTrips: tripInfos.length,
    totalRoutes: new Set(tripInfos.map(t => t.routeId)).size,
    totalServices: new Set(tripInfos.map(t => t.serviceId)).size,
    suggestionsCount: {
      total: suggestions.length,
      critical: suggestions.filter(s => s.priority === "critical").length,
      high: suggestions.filter(s => s.priority === "high").length,
      medium: suggestions.filter(s => s.priority === "medium").length,
      low: suggestions.filter(s => s.priority === "low").length,
    },
    totalSavingsMinutes: suggestions.reduce((s, sg) => s + (sg.savingsMinutes ?? 0), 0),
    peakHour: hourlyDist.reduce((best, h) => h.trips > best.trips ? h : best, hourlyDist[0] || { hour: 8, trips: 0, demand: 0 }),
    byType: {
      superfluous: suggestions.filter(s => s.type === "superfluous").length,
      overcrowded: suggestions.filter(s => s.type === "overcrowded").length,
      rushPileup: suggestions.filter(s => s.type === "rush-pileup").length,
      lowDemand: suggestions.filter(s => s.type === "low-demand").length,
      intermodalGap: suggestions.filter(s => s.type === "intermodal-gap").length,
    },
  };

  return { suggestions, routeStats, hourlyDist, summary };
}

/* ═══════════════════════════════════════════════════════════════
 *  ROUTES
 * ═══════════════════════════════════════════════════════════════ */

/* ═══════════════════════════════════════════════════════════════
 *  CP-SAT OPTIMIZER — calls Python engine
 * ═══════════════════════════════════════════════════════════════ */

/**
 * POST /api/optimizer/schedule/optimize
 * Body: { date: "YYYYMMDD", timeLimitSeconds?: number, customStrategy?: { name, description, weights } }
 *
 * 1. Loads trips from DB (reusing getActiveServiceIds)
 * 2. Pipes them as JSON to the Python CP-SAT script
 * 3. Returns parsed JSON from stdout
 */
router.post("/optimizer/schedule/optimize", async (req, res) => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.status(404).json({ error: "Nessun feed GTFS caricato" }); return; }

    const rawDate = (req.body as any)?.date;
    if (!rawDate || typeof rawDate !== "string") {
      res.status(400).json({ error: "Parametro 'date' obbligatorio (formato YYYYMMDD o YYYY-MM-DD)" }); return;
    }
    const dateYMD = rawDate.replace(/-/g, "");
    if (!/^\d{8}$/.test(dateYMD)) {
      res.status(400).json({ error: "Formato data non valido" }); return;
    }

    const timeLimitSeconds = Math.min(300, Math.max(10, (req.body as any)?.timeLimitSeconds ?? 60));
    const customStrategy = (req.body as any)?.customStrategy ?? null;

    // 1. Load trips (same logic as optimizeSchedule)
    const activeServices = await getActiveServiceIds(feedId, dateYMD);
    if (activeServices.size === 0) {
      res.status(400).json({ error: `Nessun servizio attivo il ${dateYMD}` }); return;
    }

    const allTrips = await db.select({
      tripId: gtfsTrips.tripId,
      routeId: gtfsTrips.routeId,
      serviceId: gtfsTrips.serviceId,
      headsign: gtfsTrips.tripHeadsign,
      directionId: gtfsTrips.directionId,
    }).from(gtfsTrips).where(eq(gtfsTrips.feedId, feedId));

    const trips = allTrips.filter(t => activeServices.has(t.serviceId));
    if (trips.length === 0) {
      res.status(400).json({ error: "Nessuna corsa trovata per i servizi attivi" }); return;
    }

    // Load stop times
    const stopTimesRaw = await db.execute<{
      trip_id: string; stop_sequence: number;
      departure_time: string | null; arrival_time: string | null;
    }>(sql`
      SELECT trip_id, stop_sequence, departure_time, arrival_time
      FROM gtfs_stop_times WHERE feed_id = ${feedId}
      ORDER BY trip_id, stop_sequence
    `);

    const stByTrip: Record<string, typeof stopTimesRaw.rows> = {};
    for (const st of stopTimesRaw.rows) {
      if (!stByTrip[st.trip_id]) stByTrip[st.trip_id] = [];
      stByTrip[st.trip_id].push(st);
    }

    // Route names
    const routeRows = await db.select({
      routeId: gtfsRoutes.routeId,
      shortName: gtfsRoutes.routeShortName,
      longName: gtfsRoutes.routeLongName,
      tripsCount: gtfsRoutes.tripsCount,
    }).from(gtfsRoutes).where(eq(gtfsRoutes.feedId, feedId));
    const routeMap = new Map(routeRows.map(r => [r.routeId, r]));

    // Build trip data for Python
    const pyTrips: any[] = [];
    for (const t of trips) {
      const sts = stByTrip[t.tripId];
      if (!sts || sts.length === 0) continue;
      sts.sort((a, b) => a.stop_sequence - b.stop_sequence);
      const firstDep = sts[0].departure_time || sts[0].arrival_time || "00:00:00";
      const lastArr = sts[sts.length - 1].arrival_time || sts[sts.length - 1].departure_time || firstDep;
      const depMin = timeToMinutes(firstDep);
      const arrMin = timeToMinutes(lastArr);
      const rInfo = routeMap.get(t.routeId);
      const routeName = rInfo?.shortName || rInfo?.longName || t.routeId;

      pyTrips.push({
        tripId: t.tripId,
        routeId: t.routeId,
        routeName,
        directionId: t.directionId ?? 0,
        departureMin: depMin,
        arrivalMin: arrMin,
        durationMin: Math.max(1, arrMin - depMin),
        headsign: t.headsign,
        demand: estimateDemand(depMin, rInfo?.tripsCount ?? 1, trips.length),
      });
    }

    req.log.info(`CP-SAT optimize: ${pyTrips.length} trips, ${timeLimitSeconds}s limit, custom=${!!customStrategy}`);

    // 2. Spawn Python
    const scriptPath = path.resolve(SCRIPTS_DIR, "schedule_optimizer_engine.py");

    const result = await new Promise<string>((resolve, reject) => {
      const py = spawn("python3", [scriptPath], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env },
      });

      let stdout = "";
      let stderr = "";

      py.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
      py.stderr.on("data", (d: Buffer) => {
        stderr += d.toString();
        req.log.info(`CP-SAT stderr: ${d.toString().trim()}`);
      });

      py.on("error", (err) => reject(new Error(`Errore avvio Python: ${err.message}`)));

      py.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(`Python exit code ${code}: ${stderr}`));
        } else {
          resolve(stdout);
        }
      });

      // Write JSON to stdin
      const inputJson = JSON.stringify({
        trips: pyTrips,
        timeLimitSeconds,
        customStrategy,
      });
      py.stdin.write(inputJson);
      py.stdin.end();
    });

    const parsed = JSON.parse(result);
    res.json(parsed);
  } catch (err: any) {
    req.log.error(err, "Error in CP-SAT optimizer");
    res.status(500).json({ error: err.message || "Errore nell'ottimizzatore CP-SAT" });
  }
});

// POST /api/optimizer/schedule — run schedule optimization for a specific date
router.post("/optimizer/schedule", async (req, res) => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.status(404).json({ error: "Nessun feed GTFS caricato" }); return; }

    // date is required — format YYYYMMDD or YYYY-MM-DD
    const rawDate = (req.body as any)?.date;
    if (!rawDate || typeof rawDate !== "string") {
      res.status(400).json({ error: "Parametro 'date' obbligatorio (formato YYYYMMDD o YYYY-MM-DD)" });
      return;
    }
    const dateYMD = rawDate.replace(/-/g, "");
    if (!/^\d{8}$/.test(dateYMD)) {
      res.status(400).json({ error: "Formato data non valido. Usare YYYYMMDD o YYYY-MM-DD" });
      return;
    }

    const result = await optimizeSchedule(feedId, dateYMD);
    res.json(result);
  } catch (err: any) {
    req.log.error(err, "Error in schedule optimizer");
    res.status(500).json({ error: "Errore nell'ottimizzatore orari" });
  }
});

// GET /api/optimizer/schedule/dates — list available dates in feed
router.get("/optimizer/schedule/dates", async (req, res) => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.status(404).json({ error: "Nessun feed GTFS caricato" }); return; }

    // Check calendar table for date ranges
    const calRows = await db.select({
      startDate: gtfsCalendar.startDate,
      endDate: gtfsCalendar.endDate,
    }).from(gtfsCalendar).where(eq(gtfsCalendar.feedId, feedId)).limit(1);

    if (calRows.length > 0) {
      // Feed uses calendar — return the range
      const allCal = await db.execute<{ min_date: string; max_date: string }>(sql`
        SELECT MIN(start_date) AS min_date, MAX(end_date) AS max_date
        FROM gtfs_calendar WHERE feed_id = ${feedId}
      `);
      const row = allCal.rows[0];
      res.json({ mode: "calendar", minDate: row?.min_date, maxDate: row?.max_date });
      return;
    }

    // Feed uses calendar_dates only — return distinct dates
    const cdDates = await db.execute<{ date: string; services: string }>(sql`
      SELECT date, COUNT(DISTINCT service_id)::text AS services
      FROM gtfs_calendar_dates
      WHERE feed_id = ${feedId} AND exception_type = 1
      GROUP BY date ORDER BY date
    `);

    res.json({
      mode: "calendar_dates",
      dates: cdDates.rows.map(r => ({ date: r.date, services: parseInt(r.services) })),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
