/**
 * SERVICE PROGRAM — Programma di Esercizio v3
 *
 * Features:
 * 1. Urban/Suburban separation (route name → letter=extraurbano, digit=urbano)
 * 2. Realistic deadhead with Haversine + circuity factor
 * 3. Depot returns when idle > MAX_IDLE_AT_TERMINAL
 * 4. Scoring & Cost analysis for scenario comparison
 * 5. FIFO (First-Out-First-In) refueling optimization
 * 6. Smart advisory engine with data-driven improvement suggestions
 */
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  gtfsTrips, gtfsStopTimes, gtfsRoutes,
  gtfsCalendar, gtfsStops,
  serviceProgramScenarios, driverShiftScenarios, depots,
} from "@workspace/db/schema";
import { randomUUID } from "node:crypto";
import { eq, sql, and } from "drizzle-orm";
import { timeToMinutes, minToTime, haversineKm } from "../lib/geo-utils";
import { buildDeadheadKmMatrix, dhKey, type DHNode } from "../lib/deadhead-matrix";
import {
  enrichTripsWithClusterStops, loadClustersForPython, loadCompanyCars, loadRestPointsForScenario,
} from "../lib/dati-solver";
import { getLatestFeedId } from "./gtfs-helpers";
import {
  vehicleScenariosAccessibleWhere,
  requireVehicleScenarioRead,
  requireVehicleScenarioWrite,
} from "../lib/scenario-access";
import { startSyncJob } from "../lib/planning-studio-materialize";

import { messaggioUsi, usiNelRoster } from "../lib/roster-pubblicazione-db";
import {
  type VehicleType, type ServiceCategory, type TripBlock, type VehicleShift,
  VEHICLE_SIZE, VEHICLE_LABELS, VEHICLE_CAPACITY, DEADHEAD_SPEED, MAX_DEADHEAD_KM, MAX_IDLE_AT_TERMINAL,
  MIN_LAYOVER, DEADHEAD_BUFFER, MAX_DOWNSIZE_LEVELS, isPeakHour, canVehicleServeTrip,
  getServiceCategory, getActiveServiceIds, calculateCosts, calculateScore, generateAdvisories,
} from "../lib/ottimizza-veicoli/modello";
import {
  buildPyTrips, loadTerminalTransits, spawnPythonJson, runCPSATVehicleScheduler, runVcspOrchestrator,
  loadDepotPoints, assignResidenzaToShifts, parseDepotSelection, depotCapacityAdvisory,
} from "../lib/ottimizza-veicoli/esegui";
import { compactAgentResult } from "../lib/ottimizza-veicoli/giro";
const router: IRouter = Router();

/** true se lo scenario turni macchina è marcato "in esercizio" (soluzione
 * ufficiale del Quadro d'esercizio): congelato → niente PUT/DELETE finché
 * l'operatore non toglie lo stato operativo. Colonna additiva: se assente
 * (installazioni vecchie) → false, nessun blocco. */
async function isOperationalVehicleScenario(id: string): Promise<boolean> {
  try {
    const r = await db.execute<any>(sql`
      SELECT COALESCE(is_operational, false) AS op
        FROM service_program_scenarios WHERE id = ${id}::uuid LIMIT 1
    `);
    return !!(r.rows?.[0]?.op);
  } catch { return false; }
}

// Colonna additiva variant_code su gtfs_trips (feed storici senza colonna):
// il codice percorso viaggia corsa→turni macchina→turni guida.
let variantColReady = false;
export async function ensureVariantCodeColumn(): Promise<void> {
  if (variantColReady) return;
  try {
    await db.execute(sql`ALTER TABLE gtfs_trips ADD COLUMN IF NOT EXISTS variant_code text`);
  } catch { /* la SELECT fallirebbe comunque con errore chiaro */ }
  variantColReady = true;
}


/* ═══════════════════════════════════════════════════════════════
 *  DEADHEAD CALCULATION
 * ═══════════════════════════════════════════════════════════════ */

function estimateDeadhead(
  fromLat: number, fromLon: number,
  toLat: number, toLon: number,
  category: ServiceCategory,
): { km: number; minutes: number } {
  const straightKm = haversineKm(fromLat, fromLon, toLat, toLon);
  const roadKm = straightKm * 1.3;
  const speed = DEADHEAD_SPEED[category];
  const minutes = Math.ceil((roadKm / speed) * 60) + DEADHEAD_BUFFER;
  return { km: +roadKm.toFixed(1), minutes };
}

/* ═══════════════════════════════════════════════════════════════
 *  CORE ALGORITHM — GREEDY VEHICLE ASSIGNMENT
 * ═══════════════════════════════════════════════════════════════ */

function buildServiceProgram(
  tripBlocks: TripBlock[],
  routeVehicleMap: Record<string, VehicleType>,
  category: ServiceCategory,
  vehicleIdOffset: number,
  clusterMap: Map<string, Set<string>>,
): { shifts: VehicleShift[]; unassigned: TripBlock[] } {
  const categoryTrips = tripBlocks.filter(t => t.category === category);
  const sorted = [...categoryTrips].sort((a, b) => a.departureMin - b.departureMin);

  // Build tripId → TripBlock lookup for quick access
  const tripLookup = new Map<string, TripBlock>();
  for (const tb of categoryTrips) tripLookup.set(tb.tripId, tb);

  const shifts: VehicleShift[] = [];
  const unassigned: TripBlock[] = [];

  for (const trip of sorted) {
    const reqSize = VEHICLE_SIZE[trip.requiredVehicle];
    const tripIsPeak = isPeakHour(trip.departureMin);

    let bestShiftIdx = -1;
    let bestScore = Infinity;
    // Il tipo del turno è la richiesta più restrittiva fra le sue corse, non
    // quella della prima: congelarlo sulla prima faceva rifiutare accostamenti
    // che la regola ammette (un turno aperto su una 12m rifiutava una 10m che
    // un solo 10m avrebbe coperto entrambe).
    const finestra = (sh: VehicleShift) => {
      let mn = VEHICLE_SIZE[sh.vehicleType], mx = mn;
      for (const e of sh.trips) {
        if (e.type !== "trip" || !e.requiredVehicle) continue;
        const s = VEHICLE_SIZE[e.requiredVehicle];
        if (s < mn) mn = s;
        if (s > mx) mx = s;
      }
      return { mn, mx };
    };

    for (let i = 0; i < shifts.length; i++) {
      const shift = shifts[i];
      const shiftSize = VEHICLE_SIZE[shift.vehicleType];

      // ── Sagoma ──
      if (trip.forced) {
        // Lucchetto: solo il tipo esatto, e deve servire tutte le altre corse
        if (shift.vehicleType !== trip.requiredVehicle) continue;
      } else {
        const { mn, mx } = finestra(shift);
        if (Math.max(mx, reqSize) - Math.min(mn, reqSize) > MAX_DOWNSIZE_LEVELS) continue;
        if (!canVehicleServeTrip(Math.min(shiftSize, reqSize), reqSize)) continue;
      }

      const lastTrip = [...shift.trips].reverse().find(t => t.type === "trip");
      if (!lastTrip) continue;

      const lastTripBlock = tripLookup.get(lastTrip.tripId);
      if (!lastTripBlock) continue;

      const dh = estimateDeadhead(
        lastTripBlock.lastStopLat, lastTripBlock.lastStopLon,
        trip.firstStopLat, trip.firstStopLon,
        category,
      );

      if (dh.km > MAX_DEADHEAD_KM) continue;

      const sameTerminal = lastTripBlock.lastStopId === trip.firstStopId;

      // ── Cluster bonus: if terminals are in the same cluster (<3km), reduce penalty ──
      const nearbyStops = clusterMap.get(lastTripBlock.lastStopId);
      const inCluster = nearbyStops ? nearbyStops.has(trip.firstStopId) : false;

      const layoverNeeded = sameTerminal ? MIN_LAYOVER : dh.minutes;
      const availableAt = lastTrip.arrivalMin + layoverNeeded;

      if (availableAt > trip.departureMin) continue;

      const idleTime = trip.departureMin - lastTrip.arrivalMin;
      const returnsToDepot = idleTime > MAX_IDLE_AT_TERMINAL;

      const sizePenalty = shiftSize > reqSize ? (shiftSize - reqSize) * 100 : 0;
      // ── Downsize penalty: vehicle smaller than required ──
      // In peak hours: higher penalty. Off-peak: very low penalty (we WANT to consolidate)
      const downsizeLevels = Math.max(0, reqSize - shiftSize);
      const downsizePenalty = downsizeLevels > 0
        ? (tripIsPeak ? downsizeLevels * 300 : downsizeLevels * 30)
        : 0;
      const idlePenalty = idleTime;
      const dhPenalty = dh.km * 2;
      const depotPenalty = returnsToDepot ? 500 : 0;
      // Cluster bonus: reward staying within the same terminal cluster
      const clusterBonus = sameTerminal ? -50 : inCluster ? -25 : 0;
      const score = sizePenalty + downsizePenalty + idlePenalty + dhPenalty + depotPenalty + clusterBonus;

      if (score < bestScore) {
        bestScore = score;
        bestShiftIdx = i;
      }
    }

    if (bestShiftIdx >= 0) {
      const shift = shifts[bestShiftIdx];
      const lastTrip = [...shift.trips].reverse().find(t => t.type === "trip")!;
      const lastTripBlock = tripLookup.get(lastTrip.tripId)!;

      const sameTerminal = lastTripBlock.lastStopId === trip.firstStopId;
      const dh = estimateDeadhead(
        lastTripBlock.lastStopLat, lastTripBlock.lastStopLon,
        trip.firstStopLat, trip.firstStopLon,
        category,
      );

      const idleTime = trip.departureMin - lastTrip.arrivalMin;

      if (idleTime > MAX_IDLE_AT_TERMINAL) {
        const depotDepartMin = lastTrip.arrivalMin + Math.ceil(dh.minutes / 2);
        const depotArriveMin = trip.departureMin - Math.ceil(dh.minutes / 2);
        shift.trips.push({
          type: "depot",
          tripId: "", routeId: "", routeName: "🏠 Rientro deposito",
          headsign: null,
          departureTime: minToTime(depotDepartMin),
          arrivalTime: minToTime(depotArriveMin),
          departureMin: depotDepartMin,
          arrivalMin: depotArriveMin,
        });
        shift.depotReturns++;
      } else if (!sameTerminal && dh.km > 0.5) {
        const dhStartMin = lastTrip.arrivalMin + MIN_LAYOVER;
        const dhEndMin = dhStartMin + dh.minutes;
        shift.trips.push({
          type: "deadhead",
          tripId: "", routeId: "",
          routeName: `↝ Vuoto (${dh.km} km)`,
          headsign: null,
          departureTime: minToTime(dhStartMin),
          arrivalTime: minToTime(Math.min(dhEndMin, trip.departureMin)),
          departureMin: dhStartMin,
          arrivalMin: Math.min(dhEndMin, trip.departureMin),
          deadheadKm: dh.km,
          deadheadMin: dh.minutes,
        });
        shift.totalDeadheadMin += dh.minutes;
        shift.totalDeadheadKm += dh.km;
      }

      // La corsa più restrittiva abbassa il mezzo del turno: sopra la sua
      // taglia la strada non regge, quindi il turno non può restare più grande.
      if (reqSize < VEHICLE_SIZE[shift.vehicleType]) shift.vehicleType = trip.requiredVehicle;
      const isDownsized = VEHICLE_SIZE[shift.vehicleType] < reqSize;

      shift.trips.push({
        type: "trip",
        tripId: trip.tripId, routeId: trip.routeId,
        routeName: trip.routeName, headsign: trip.headsign,
        departureTime: trip.departureTime, arrivalTime: trip.arrivalTime,
        departureMin: trip.departureMin, arrivalMin: trip.arrivalMin,
        firstStopName: trip.firstStopName, lastStopName: trip.lastStopName,
        stopCount: trip.stopCount, durationMin: trip.arrivalMin - trip.departureMin,
        directionId: trip.directionId,
        requiredVehicle: trip.requiredVehicle,
        downsized: isDownsized || undefined,
        originalVehicle: isDownsized ? trip.requiredVehicle : undefined,
        onDemand: trip.onDemand || undefined,
        variantCode: trip.variantCode ?? undefined,
      });
      // Abbassando il mezzo cambiano i declassamenti anche delle corse già
      // dentro: si ricontano tutte, altrimenti il turno mentirebbe sul proprio
      // conto di corse su mezzo ridotto.
      const vSizeNow = VEHICLE_SIZE[shift.vehicleType];
      shift.downsizedTrips = 0;
      for (const e of shift.trips) {
        if (e.type !== "trip" || !e.requiredVehicle) continue;
        const down = vSizeNow < VEHICLE_SIZE[e.requiredVehicle];
        e.downsized = down || undefined;
        e.originalVehicle = down ? e.requiredVehicle : undefined;
        if (down) shift.downsizedTrips++;
      }
      shift.endMin = trip.arrivalMin;
      shift.totalServiceMin += (trip.arrivalMin - trip.departureMin);
      shift.tripCount++;
      shift.lastIn = trip.arrivalMin;
      shift.shiftDuration = shift.endMin - shift.startMin;
    } else {
      const vehicleNum = vehicleIdOffset + shifts.length + 1;
      const prefix = category === "urbano" ? "U" : "E";
      shifts.push({
        vehicleId: `${prefix}${String(vehicleNum).padStart(3, "0")}`,
        vehicleType: trip.requiredVehicle,
        category,
        trips: [{
          type: "trip",
          tripId: trip.tripId, routeId: trip.routeId,
          routeName: trip.routeName, headsign: trip.headsign,
          departureTime: trip.departureTime, arrivalTime: trip.arrivalTime,
          departureMin: trip.departureMin, arrivalMin: trip.arrivalMin,
          firstStopName: trip.firstStopName, lastStopName: trip.lastStopName,
          stopCount: trip.stopCount, durationMin: trip.arrivalMin - trip.departureMin,
          directionId: trip.directionId,
          requiredVehicle: trip.requiredVehicle,
          onDemand: trip.onDemand || undefined,
        }],
        startMin: trip.departureMin,
        endMin: trip.arrivalMin,
        totalServiceMin: trip.arrivalMin - trip.departureMin,
        totalDeadheadMin: 0,
        totalDeadheadKm: 0,
        depotReturns: 0,
        tripCount: 1,
        fifoOrder: 0,
        firstOut: trip.departureMin,
        lastIn: trip.arrivalMin,
        shiftDuration: trip.arrivalMin - trip.departureMin,
        downsizedTrips: 0,
      });
    }
  }

  // ──── FIFO: assign refueling priority ────
  // Vehicles that leave FIRST should return FIRST → refuel first
  const sortedByFirstOut = [...shifts].sort((a, b) => a.firstOut - b.firstOut);
  sortedByFirstOut.forEach((shift, idx) => {
    shift.fifoOrder = idx + 1;
  });

  return { shifts, unassigned };
}

/* ═══════════════════════════════════════════════════════════════
 *  ROUTES
 * ═══════════════════════════════════════════════════════════════ */

router.get("/service-program/routes", async (req, res) => {
  try {
    const feedId = await getLatestFeedId(req);
    if (!feedId) { res.status(404).json({ error: "Nessun feed GTFS caricato" }); return; }

    const rows = await db.select({
      routeId: gtfsRoutes.routeId,
      shortName: gtfsRoutes.routeShortName,
      longName: gtfsRoutes.routeLongName,
      routeType: gtfsRoutes.routeType,
      tripsCount: gtfsRoutes.tripsCount,
      color: gtfsRoutes.routeColor,
    }).from(gtfsRoutes).where(eq(gtfsRoutes.feedId, feedId))
      .orderBy(gtfsRoutes.routeShortName);

    /* Tipologie di vettura DICHIARATE IN PIANIFICAZIONE: se il feed è la
     * materializzazione di un progetto Planning Studio, il route_id GTFS è
     * l'uuid della linea PS — attributes.vehicleTypes fluisce qui e diventa
     * il default del run (l'operatore può sempre cambiarlo). */
    const psVehicle = new Map<string, { ammesse: string[]; preferita: string }>();
    try {
      const psR = await db.execute<any>(sql`
        SELECT r.id, r.attributes->'vehicleTypes' AS vt
          FROM ps_routes r
          JOIN ps_projects p ON p.id = r.project_id
         WHERE p.materialized_feed_id = ${feedId}::uuid
           AND r.attributes ? 'vehicleTypes'`);
      for (const row of psR.rows ?? []) {
        const vt = row.vt;
        if (vt && Array.isArray(vt.ammesse) && vt.ammesse.length > 0) {
          psVehicle.set(String(row.id), { ammesse: vt.ammesse, preferita: vt.preferita ?? vt.ammesse[0] });
        }
      }
    } catch { /* feed non materializzato da PS: nessuna dichiarazione */ }

    res.json({
      feedId,
      routes: rows.map(r => {
        const name = r.shortName || r.longName || r.routeId;
        return {
          routeId: r.routeId,
          name,
          longName: r.longName,
          routeType: r.routeType,
          tripsCount: r.tripsCount ?? 0,
          color: r.color ? `#${r.color}` : null,
          category: getServiceCategory(name),
          planningVehicle: psVehicle.get(r.routeId) ?? null,
        };
      }),
      vehicleTypes: Object.entries(VEHICLE_LABELS).map(([id, label]) => ({
        id,
        label,
        capacity: VEHICLE_CAPACITY[id as VehicleType],
        sizeIndex: VEHICLE_SIZE[id as VehicleType],
      })),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/service-program/dates", async (req, res) => {
  try {
    const feedId = await getLatestFeedId(req);
    if (!feedId) { res.status(404).json({ error: "Nessun feed GTFS caricato" }); return; }

    const calRows = await db.select({
      startDate: gtfsCalendar.startDate,
      endDate: gtfsCalendar.endDate,
    }).from(gtfsCalendar).where(eq(gtfsCalendar.feedId, feedId)).limit(1);

    if (calRows.length > 0) {
      const allCal = await db.execute<{ min_date: string; max_date: string }>(sql`
        SELECT MIN(start_date) AS min_date, MAX(end_date) AS max_date
        FROM gtfs_calendar WHERE feed_id = ${feedId}
      `);
      const row = allCal.rows[0];
      res.json({ mode: "calendar", minDate: row?.min_date, maxDate: row?.max_date });
      return;
    }

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

/* ═══════════════════════════════════════════════════════════════
 *  GET /api/service-program/trips — Trips for selected routes on a date
 * ═══════════════════════════════════════════════════════════════ */

router.get("/service-program/trips", async (req, res) => {
  try {
    const feedId = await getLatestFeedId(req);
    if (!feedId) { res.status(404).json({ error: "Nessun feed GTFS caricato" }); return; }

    const dateRaw = req.query.date as string | undefined;
    const routeIdsRaw = req.query.routeIds as string | undefined;
    if (!dateRaw || !routeIdsRaw) {
      res.status(400).json({ error: "Parametri 'date' e 'routeIds' obbligatori" });
      return;
    }
    const dateYMD = dateRaw.replace(/-/g, "");
    if (!/^\d{8}$/.test(dateYMD)) {
      res.status(400).json({ error: "Formato data non valido" });
      return;
    }
    const routeIds = routeIdsRaw.split(",").map(s => s.trim()).filter(Boolean);
    if (routeIds.length === 0) {
      res.status(400).json({ error: "Nessuna linea specificata" });
      return;
    }

    // 1. Active services for the date
    const activeServices = await getActiveServiceIds(feedId, dateYMD);
    if (activeServices.size === 0) {
      res.json({ trips: [] });
      return;
    }

    // 2. Get trips for selected routes + active services
    await ensureVariantCodeColumn();
    const allTrips = await db.select({
      tripId: gtfsTrips.tripId,
      routeId: gtfsTrips.routeId,
      serviceId: gtfsTrips.serviceId,
      headsign: gtfsTrips.tripHeadsign,
      directionId: gtfsTrips.directionId,
      onDemand: gtfsTrips.onDemand,
      variantCode: gtfsTrips.variantCode,
    }).from(gtfsTrips)
      .where(eq(gtfsTrips.feedId, feedId));

    const filtered = allTrips.filter(t =>
      activeServices.has(t.serviceId) && routeIds.includes(t.routeId)
    );

    if (filtered.length === 0) {
      res.json({ trips: [] });
      return;
    }

    // 3. Get stop_times for each trip (first and last)
    const tripIds = filtered.map(t => t.tripId);
    const stRows = await db.select({
      tripId: gtfsStopTimes.tripId,
      stopId: gtfsStopTimes.stopId,
      arrivalTime: gtfsStopTimes.arrivalTime,
      departureTime: gtfsStopTimes.departureTime,
      stopSequence: gtfsStopTimes.stopSequence,
    }).from(gtfsStopTimes)
      .where(eq(gtfsStopTimes.feedId, feedId));

    // Group by trip
    const stByTrip = new Map<string, typeof stRows>();
    for (const st of stRows) {
      if (!tripIds.includes(st.tripId)) continue;
      let arr = stByTrip.get(st.tripId);
      if (!arr) { arr = []; stByTrip.set(st.tripId, arr); }
      arr.push(st);
    }

    // 4. Get stop names
    const stopRows = await db.select({
      stopId: gtfsStops.stopId,
      stopName: gtfsStops.stopName,
    }).from(gtfsStops).where(eq(gtfsStops.feedId, feedId));
    const stopNameMap = new Map<string, string>();
    for (const s of stopRows) stopNameMap.set(s.stopId, s.stopName || s.stopId);

    // 5. Build response
    const trips = filtered.map(t => {
      const sts = (stByTrip.get(t.tripId) || []).sort((a, b) => a.stopSequence - b.stopSequence);
      const firstDep = sts[0]?.departureTime || "??:??";
      const lastArr = sts[sts.length - 1]?.arrivalTime || "??:??";
      const firstStopName = sts[0] ? (stopNameMap.get(sts[0].stopId) || sts[0].stopId) : "?";
      const lastStopName = sts.length > 0 ? (stopNameMap.get(sts[sts.length - 1].stopId) || sts[sts.length - 1].stopId) : "?";
      return {
        tripId: t.tripId,
        routeId: t.routeId,
        headsign: t.headsign || "",
        directionId: t.directionId ?? 0,
        departureTime: firstDep,
        arrivalTime: lastArr,
        firstStopName,
        lastStopName,
        onDemand: !!t.onDemand,
      };
    }).sort((a, b) => a.departureTime.localeCompare(b.departureTime));

    res.json({ trips });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Il feed materializzato di un progetto Planning Studio, per una LETTURA.
 *
 * Stessi due canali del giro (agent-optimize): prima l'UDP — il feed scopato
 * sull'unità, `scheduling_projects.feed_id` — poi il feed d'esercizio,
 * `ps_projects.materialized_feed_id`. A differenza del giro NON crea progetti
 * di scheduling e NON ri-materializza: uno strumento che legge non deve
 * cambiare lo stato del progetto, e se il feed è vecchio lo dice.
 *
 * Nasce da un errore: la mappa delle coincidenze prendeva «l'ultimo feed» del
 * database, cioè quello aziendale con 753 corse e linee che nel progetto non
 * esistono, mentre il giro lavorava sulle 365 corse del feed del progetto.
 */
async function resolveProjectFeedForRead(psProjectId: string): Promise<{
  feedId: string; feedSource: "udp" | "esercizio"; syncedAt: string | null; staleAfter: string | null;
} | { feedId: null; tentativi: string[] }> {
  // Ogni via fallita lascia una riga: la prima versione ingoiava gli errori e
  // il messaggio dava la colpa a un psProjectId mancante che invece c'era.
  const tentativi: string[] = [];
  try {
    // Il progetto di scheduling si aggancia ATTRAVERSO L'UNITÀ DI VALIDITÀ,
    // esattamente come il giro e planning-compare: è l'unica via che non
    // dipende da colonne arrivate dopo. LEFT JOIN sul feed: un feed_id che
    // punta a un feed sparito deve diventare un motivo, non una riga persa.
    const sp = await db.execute<any>(sql`
      SELECT sp.feed_id, f.id AS feed_exists, f.uploaded_at
        FROM scheduling_projects sp
        LEFT JOIN gtfs_feeds f ON f.id = sp.feed_id
       WHERE sp.feed_id IS NOT NULL
         AND sp.validity_unit_id IN (SELECT id FROM ps_validity_units WHERE project_id = ${psProjectId}::uuid)
       ORDER BY sp.created_at DESC LIMIT 1`);
    const row = sp.rows?.[0];
    if (!row?.feed_id) {
      tentativi.push("udp: nessun progetto di scheduling con feed per le unità di validità di questo progetto");
    } else if (!row.feed_exists) {
      tentativi.push(`udp: il progetto di scheduling punta al feed ${row.feed_id}, che non esiste più (il giro lo ri-materializza da solo; una lettura no)`);
      row.feed_id = null;
    }
    if (row?.feed_id) {
      let staleAfter: string | null = null;
      try {
        const st = await db.execute<any>(sql`
          SELECT GREATEST(
                   COALESCE((SELECT max(updated_at) FROM ps_trips     WHERE project_id = ${psProjectId}::uuid), 'epoch'),
                   COALESCE((SELECT max(updated_at) FROM ps_calendars WHERE project_id = ${psProjectId}::uuid), 'epoch')
                 ) AS changed`);
        const changed = st.rows?.[0]?.changed;
        if (changed && row.uploaded_at && new Date(changed).getTime() > new Date(row.uploaded_at).getTime()) {
          staleAfter = new Date(changed).toISOString();
        }
      } catch { /* senza confronto: il feed vale */ }
      return { feedId: String(row.feed_id), feedSource: "udp",
               syncedAt: row.uploaded_at ? new Date(row.uploaded_at).toISOString() : null, staleAfter };
    }
  } catch (e: any) { tentativi.push(`udp: ${e?.message ?? e}`); }
  try {
    const fr = await db.execute<any>(sql`
      SELECT materialized_feed_id FROM ps_projects WHERE id = ${psProjectId}::uuid`);
    if (!fr.rows?.length) tentativi.push("esercizio: progetto Planning Studio non trovato");
    const fid = fr.rows?.[0]?.materialized_feed_id;
    if (fid) return { feedId: String(fid), feedSource: "esercizio", syncedAt: null, staleAfter: null };
    if (fr.rows?.length) tentativi.push("esercizio: nessun feed materializzato (materialized_feed_id vuoto)");
  } catch (e: any) { tentativi.push(`esercizio: ${e?.message ?? e}`); }
  return { feedId: null, tentativi };
}

/* ═══════════════════════════════════════════════════════════════
 *  GET /api/service-program/coincidences — la mappa delle coincidenze
 *
 *  Le relazioni fra linee che l'orario realizza, quelle che perde per poco e
 *  quanto costerebbe prenderle traslando una linea intera. Non lancia nessun
 *  solver: è una lettura del quadro orario, risponde in secondi, e serve PRIMA
 *  di toccare le corse — non dopo, quando il piano è già fatto.
 * ═══════════════════════════════════════════════════════════════ */

/** LA MAPPA DELLE COINCIDENZE su un feed e una data, senza HTTP attorno.
 *
 * Estratta dalla rotta perché serve anche alla RELAZIONE DI PROCESSO: un
 * documento che racconta il piano senza dire quali relazioni fra linee
 * l'orario realizza — e quali si manca per pochi minuti — lascia fuori
 * l'analisi che viene PRIMA di ogni spostamento di corsa. */
export async function coincidenceMapFor(
  feedId: string,
  opts: {
    date: string; psProjectId?: string | null; routeIds?: string | null;
    maxWait?: unknown; minWait?: unknown; nearMissWindow?: unknown;
    shiftRange?: unknown; minOccurrences?: unknown;
  },
  logger: any,
): Promise<any> {
    const dateRaw = String(opts.date || "");
    const dateYMD = dateRaw.replace(/-/g, "");
    if (!/^\d{8}$/.test(dateYMD)) {
      return { corse: 0, esistenti: [], mancatePerPoco: [], opportunita: [],
               nota: "Data non valida: serve un giorno con servizio attivo del giorno-tipo da analizzare" };
    }
    const routeFilter = String(opts.routeIds || "").split(",").map(s => s.trim()).filter(Boolean);

    const activeServices = await getActiveServiceIds(feedId, dateYMD);
    if (activeServices.size === 0) return { corse: 0, esistenti: [], mancatePerPoco: [], opportunita: [], nota: "Nessun servizio attivo per la data" };

    const allTrips = await db.select({
      tripId: gtfsTrips.tripId, routeId: gtfsTrips.routeId, serviceId: gtfsTrips.serviceId,
      directionId: gtfsTrips.directionId,
    }).from(gtfsTrips).where(eq(gtfsTrips.feedId, feedId));
    const trips = allTrips.filter(t => activeServices.has(t.serviceId)
      && (routeFilter.length === 0 || routeFilter.includes(t.routeId)));
    if (trips.length === 0) return { corse: 0, esistenti: [], mancatePerPoco: [], opportunita: [], nota: "Nessuna corsa attiva per le linee/data indicate" };

    const tripIds = new Set(trips.map(t => t.tripId));
    const stRows = await db.select({
      tripId: gtfsStopTimes.tripId, stopId: gtfsStopTimes.stopId,
      stopSequence: gtfsStopTimes.stopSequence,
      arrivalTime: gtfsStopTimes.arrivalTime, departureTime: gtfsStopTimes.departureTime,
    }).from(gtfsStopTimes).where(eq(gtfsStopTimes.feedId, feedId));
    const stByTrip = new Map<string, typeof stRows>();
    for (const st of stRows) {
      if (!tripIds.has(st.tripId)) continue;
      let arr = stByTrip.get(st.tripId);
      if (!arr) { arr = []; stByTrip.set(st.tripId, arr); }
      arr.push(st);
    }

    const routeRows = await db.select({
      routeId: gtfsRoutes.routeId, shortName: gtfsRoutes.routeShortName, longName: gtfsRoutes.routeLongName,
    }).from(gtfsRoutes).where(eq(gtfsRoutes.feedId, feedId));
    const routeName = new Map(routeRows.map(r => [r.routeId, r.shortName || r.longName || r.routeId]));
    const stopRows = await db.select({ stopId: gtfsStops.stopId, name: gtfsStops.stopName })
      .from(gtfsStops).where(eq(gtfsStops.feedId, feedId));
    const stopName = new Map(stopRows.map(s => [s.stopId, s.name || s.stopId]));

    // Flessibilità DICHIARATA in Planning: per linea (default) e per corsa
    // (override), come la legge il VSP. Nel feed materializzato route_id e
    // trip_id GTFS sono gli uuid del progetto, quindi il lookup è diretto.
    const psProj = String(opts.psProjectId || "");
    const flexByRoute = new Map<string, number>();
    const flexByTrip = new Map<string, number>();
    if (/^[0-9a-f-]{36}$/i.test(psProj)) {
      try {
        const fr = await db.execute<any>(sql`
          SELECT id, (attributes->>'flexMin')::int AS flex FROM ps_routes
           WHERE project_id = ${psProj}::uuid AND attributes ? 'flexMin'`);
        for (const r of fr.rows ?? []) if (Number(r.flex) > 0) flexByRoute.set(String(r.id), Math.min(30, Number(r.flex)));
        const ft = await db.execute<any>(sql`
          SELECT id, (attributes->>'flexMin')::int AS flex FROM ps_trips
           WHERE project_id = ${psProj}::uuid AND attributes ? 'flexMin'`);
        for (const r of ft.rows ?? []) flexByTrip.set(String(r.id), Math.max(0, Math.min(30, Number(r.flex) || 0)));
      } catch { /* progetto senza flessibilità dichiarata: corse inchiodate */ }
    }

    const blocks = trips.map(t => {
      const sts = (stByTrip.get(t.tripId) || []).sort((a, b) => a.stopSequence - b.stopSequence);
      if (sts.length === 0) return null;
      const first = sts[0], last = sts[sts.length - 1];
      return {
        tripId: t.tripId, routeId: t.routeId,
        routeName: routeName.get(t.routeId) || t.routeId,
        directionId: t.directionId ?? 0,
        departureMin: timeToMinutes(first.departureTime || first.arrivalTime || "00:00:00"),
        arrivalMin: timeToMinutes(last.arrivalTime || last.departureTime || "00:00:00"),
        firstStopId: first.stopId, lastStopId: last.stopId,
        firstStopName: stopName.get(first.stopId) || first.stopId,
        lastStopName: stopName.get(last.stopId) || last.stopId,
        flexMin: flexByTrip.get(t.tripId) ?? flexByRoute.get(t.routeId) ?? 0,
      };
    }).filter(Boolean) as any[];

    const transits = await loadTerminalTransits(feedId, blocks, logger).catch(() => ({} as Record<string, any[]>));
    for (const b of blocks) {
      const tr = transits[b.tripId];
      if (tr && tr.length > 0) b.terminalTransits = tr;
    }

    const num = (v: unknown, d: number) => (Number.isFinite(Number(v)) ? Number(v) : d);
    const out = await spawnPythonJson("coincidence_analysis.py", [], {
      trips: blocks,
      maxWait: num(opts.maxWait, 5),
      minWait: num(opts.minWait, 2),
      nearMissWindow: num(opts.nearMissWindow, 30),
      shiftRange: num(opts.shiftRange, 30),
      minOccurrences: num(opts.minOccurrences, 3),
    }, logger, "coincidences");
    return (out && typeof out === "object") ? out : { out };
}

router.get("/service-program/coincidences", async (req, res) => {
  try {
    // Il feed DEL PROGETTO, come il giro: senza psProjectId si ricade
    // sull'ultimo feed caricato, che è quello aziendale intero.
    const psProjForFeed = String(req.query.psProjectId || "");
    const psGiven = /^[0-9a-f-]{36}$/i.test(psProjForFeed);
    const risolto = psGiven ? await resolveProjectFeedForRead(psProjForFeed) : null;
    const projectFeed = risolto && risolto.feedId ? risolto : null;
    // Il feed del progetto non trovato NON è un caso da coprire in silenzio con
    // quello aziendale: la mappa direbbe cose vere di un'altra rete.
    if (psGiven && !projectFeed) {
      res.status(404).json({
        error: "Nessun feed materializzato per questo progetto: lancia un giro (ti_vcsp_run) o sincronizza l'UDP, poi rileggi la mappa",
        psProjectId: psProjForFeed,
        tentativi: (risolto as any)?.tentativi ?? [],
      });
      return;
    }
    const feedId = projectFeed?.feedId ?? await getLatestFeedId(req);
    if (!feedId) { res.status(404).json({ error: "Nessun feed GTFS caricato" }); return; }
    const feedInfo = projectFeed
      ? { feedId, feedSource: projectFeed.feedSource, syncedAt: projectFeed.syncedAt,
          ...(projectFeed.staleAfter ? { attenzione: `il feed è più vecchio dell'ultima modifica in Planning (${projectFeed.staleAfter}): lancia un giro o sincronizza l'UDP per aggiornarlo` } : {}) }
      : { feedId, feedSource: "ultimoFeedCaricato" as const,
          attenzione: "psProjectId assente: la mappa legge l'ultimo feed caricato, cioè quello aziendale intero, non quello del progetto" };

    const out = await coincidenceMapFor(feedId, {
      date: String(req.query.date || ""),
      psProjectId: String(req.query.psProjectId || ""),
      routeIds: String(req.query.routeIds || ""),
      maxWait: req.query.maxWait, minWait: req.query.minWait,
      nearMissWindow: req.query.nearMissWindow, shiftRange: req.query.shiftRange,
      minOccurrences: req.query.minOccurrences,
    }, req.log);
    if (out && typeof out === "object" && (out as any).nota && !(out as any).esistenti?.length
        && String((out as any).nota).startsWith("Data non valida")) {
      res.status(400).json({ error: (out as any).nota });
      return;
    }
    res.json({ feed: feedInfo, ...(out && typeof out === "object" ? out : { out }) });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? String(err) });
  }
});

/* ═══════════════════════════════════════════════════════════════
 *  POST /api/service-program — Run optimizer
 * ═══════════════════════════════════════════════════════════════ */

router.post("/service-program", async (req, res) => {
  try {
    const feedId = await getLatestFeedId(req);
    if (!feedId) { res.status(404).json({ error: "Nessun feed GTFS caricato" }); return; }
    if (rejectWithoutPsProject(req, res)) return;

    const body = req.body as {
      date?: string;
      routes?: { routeId: string; vehicleType: VehicleType; forced?: boolean }[];
      tripVehicleOverrides?: Record<string, VehicleType>;
    };

    const rawDate = body.date;
    if (!rawDate || typeof rawDate !== "string") {
      res.status(400).json({ error: "Parametro 'date' obbligatorio (YYYYMMDD o YYYY-MM-DD)" });
      return;
    }
    const dateYMD = rawDate.replace(/-/g, "");
    if (!/^\d{8}$/.test(dateYMD)) {
      res.status(400).json({ error: "Formato data non valido" });
      return;
    }

    if (!body.routes || !Array.isArray(body.routes) || body.routes.length === 0) {
      res.status(400).json({ error: "Parametro 'routes' obbligatorio" });
      return;
    }

    const validTypes = new Set(Object.keys(VEHICLE_SIZE));
    const routeVehicleMap: Record<string, VehicleType> = {};
    const routeForcedMap: Record<string, boolean> = {};
    for (const r of body.routes) {
      if (!r.routeId || !r.vehicleType || !validTypes.has(r.vehicleType)) {
        res.status(400).json({ error: `Tipo veicolo non valido: "${r.vehicleType}" per linea "${r.routeId}"` });
        return;
      }
      routeVehicleMap[r.routeId] = r.vehicleType;
      routeForcedMap[r.routeId] = !!r.forced;
    }

    const selectedRouteIds = new Set(Object.keys(routeVehicleMap));
    const emptyResult = (msg: string, services: number) => ({
      shifts: [], unassigned: [], routeStats: [], hourlyDist: [],
      summary: { date: dateYMD, activeServices: services, totalTrips: 0,
        selectedRoutes: selectedRouteIds.size, totalVehicles: 0,
        byType: {}, byCategory: {}, totalServiceHours: 0, totalDeadheadHours: 0,
        totalDeadheadKm: 0, depotReturns: 0, efficiency: 0, message: msg },
      costs: { vehicleFixedCost: 0, vehicleServiceKmCost: 0, vehicleDeadheadKmCost: 0,
        vehicleTotalCost: 0, driverCost: 0, depotReturnCost: 0,
        idleCost: 0, totalDailyCost: 0, costPerTrip: 0, costPerServiceHour: 0,
        byVehicleType: {}, byCategory: {} },
      score: { overall: 0, efficiency: 0, fleetUtilization: 0, deadheadRatio: 0,
        costEfficiency: 0, fifoCompliance: 0, grade: "N/A", gradeColor: "#6b7280" },
      advisories: [],
    });

    // 1. Active services
    const activeServices = await getActiveServiceIds(feedId, dateYMD);
    if (activeServices.size === 0) {
      res.json(emptyResult("Nessun servizio attivo per la data selezionata", 0));
      return;
    }

    // 2. Load trips
    await ensureVariantCodeColumn();
    const allTrips = await db.select({
      tripId: gtfsTrips.tripId,
      routeId: gtfsTrips.routeId,
      serviceId: gtfsTrips.serviceId,
      headsign: gtfsTrips.tripHeadsign,
      directionId: gtfsTrips.directionId,
      onDemand: gtfsTrips.onDemand,
      variantCode: gtfsTrips.variantCode,
    }).from(gtfsTrips).where(eq(gtfsTrips.feedId, feedId));

    const trips = allTrips.filter(t =>
      selectedRouteIds.has(t.routeId) && activeServices.has(t.serviceId)
    );

    if (trips.length === 0) {
      res.json(emptyResult("Nessuna corsa attiva per le linee/data selezionate", activeServices.size));
      return;
    }

    // 3. Load stop times
    const tripIds = trips.map(t => t.tripId);
    const stopTimesRaw = await db.execute<{
      trip_id: string; stop_id: string; stop_sequence: number;
      departure_time: string | null; arrival_time: string | null;
    }>(sql`
      SELECT trip_id, stop_id, stop_sequence, departure_time, arrival_time
      FROM gtfs_stop_times
      WHERE feed_id = ${feedId}
        AND trip_id IN ${sql.raw(`(${tripIds.map(id => `'${id.replace(/'/g, "''")}'`).join(",")})`)}
      ORDER BY trip_id, stop_sequence
    `);

    const stByTrip: Record<string, typeof stopTimesRaw.rows> = {};
    for (const st of stopTimesRaw.rows) {
      if (!stByTrip[st.trip_id]) stByTrip[st.trip_id] = [];
      stByTrip[st.trip_id].push(st);
    }

    // 4. Route names
    const routeRows = await db.select({
      routeId: gtfsRoutes.routeId,
      shortName: gtfsRoutes.routeShortName,
      longName: gtfsRoutes.routeLongName,
    }).from(gtfsRoutes).where(eq(gtfsRoutes.feedId, feedId));
    const routeNameMap = new Map(routeRows.map(r => [r.routeId, r.shortName || r.longName || r.routeId]));

    // 5. Load stop coordinates + names
    const stopRows = await db.select({
      stopId: gtfsStops.stopId,
      lat: gtfsStops.stopLat,
      lon: gtfsStops.stopLon,
      name: gtfsStops.stopName,
    }).from(gtfsStops).where(eq(gtfsStops.feedId!, feedId));
    const stopCoords = new Map(stopRows.map(s => [s.stopId, { lat: s.lat, lon: s.lon, name: s.name || s.stopId }]));

    // 6. Build trip blocks
    const tripBlocks: TripBlock[] = [];
    for (const t of trips) {
      const sts = stByTrip[t.tripId];
      if (!sts || sts.length === 0) continue;
      sts.sort((a, b) => a.stop_sequence - b.stop_sequence);
      const firstDep = sts[0].departure_time || sts[0].arrival_time || "00:00:00";
      const lastArr = sts[sts.length - 1].arrival_time || sts[sts.length - 1].departure_time || firstDep;

      const firstStop = stopCoords.get(sts[0].stop_id);
      const lastStop = stopCoords.get(sts[sts.length - 1].stop_id);
      const routeName = routeNameMap.get(t.routeId) || t.routeId;

      tripBlocks.push({
        tripId: t.tripId,
        routeId: t.routeId,
        routeName,
        headsign: t.headsign,
        variantCode: (t as any).variantCode ?? null,
        directionId: t.directionId ?? 0,
        departureTime: firstDep,
        arrivalTime: lastArr,
        departureMin: timeToMinutes(firstDep),
        arrivalMin: timeToMinutes(lastArr),
        stopCount: sts.length,
        firstStopId: sts[0].stop_id,
        lastStopId: sts[sts.length - 1].stop_id,
        firstStopLat: firstStop?.lat ?? 43.6,
        firstStopLon: firstStop?.lon ?? 13.5,
        lastStopLat: lastStop?.lat ?? 43.6,
        lastStopLon: lastStop?.lon ?? 13.5,
        firstStopName: firstStop?.name || sts[0].stop_id,
        lastStopName: lastStop?.name || sts[sts.length - 1].stop_id,
        requiredVehicle: (body.tripVehicleOverrides?.[t.tripId] as VehicleType) ?? (routeVehicleMap[t.routeId] || "12m"),
        category: getServiceCategory(routeName),
        forced: routeForcedMap[t.routeId] ?? false,
        onDemand: !!t.onDemand,
      });
    }

    /* ─── 6b. Build geographic clusters for smarter deadhead ─── */
    // Group terminal stops into clusters so vehicles prefer nearby terminals
    const terminalNodes = new Map<string, { lat: number; lon: number; stopId: string; name: string }>();
    for (const tb of tripBlocks) {
      if (!terminalNodes.has(tb.firstStopId)) {
        terminalNodes.set(tb.firstStopId, {
          lat: tb.firstStopLat, lon: tb.firstStopLon,
          stopId: tb.firstStopId, name: tb.firstStopName,
        });
      }
      if (!terminalNodes.has(tb.lastStopId)) {
        terminalNodes.set(tb.lastStopId, {
          lat: tb.lastStopLat, lon: tb.lastStopLon,
          stopId: tb.lastStopId, name: tb.lastStopName,
        });
      }
    }

    // Simple clustering: build proximity map — for each terminal, find all terminals within 3km
    const CLUSTER_RADIUS_KM = 3;
    const terminalList = Array.from(terminalNodes.values());
    const clusterMap = new Map<string, Set<string>>(); // stopId → set of nearby stopIds
    for (const a of terminalList) {
      const nearby = new Set<string>();
      nearby.add(a.stopId);
      for (const b of terminalList) {
        if (a.stopId === b.stopId) continue;
        if (haversineKm(a.lat, a.lon, b.lat, b.lon) <= CLUSTER_RADIUS_KM) {
          nearby.add(b.stopId);
        }
      }
      clusterMap.set(a.stopId, nearby);
    }

    // Corse ESCLUSE dall'operatore in fase di selezione: non entrano nel solver
    // (nessun veicolo le coprirà) ma restano contate come SCOPERTE (unassigned),
    // così il traffico dati resta corretto e non spariscono silenziosamente.
    const excludedSet = new Set<string>(Array.isArray((body as any).excludedTripIds)
      ? (body as any).excludedTripIds.filter((x: any) => typeof x === "string") : []);
    const excludedBlocks: TripBlock[] = excludedSet.size ? tripBlocks.filter(t => excludedSet.has(t.tripId)) : [];
    for (const b of excludedBlocks) (b as any).excludedByOperator = true;
    const solverBlocks: TripBlock[] = excludedSet.size ? tripBlocks.filter(t => !excludedSet.has(t.tripId)) : tripBlocks;

    // 7. Run separately for urban and suburban — pass clusterMap
    const urbanResult = buildServiceProgram(solverBlocks, routeVehicleMap, "urbano", 0, clusterMap);
    const suburbanResult = buildServiceProgram(solverBlocks, routeVehicleMap, "extraurbano", urbanResult.shifts.length, clusterMap);

    const allShifts = [...urbanResult.shifts, ...suburbanResult.shifts];
    const allUnassigned = [...urbanResult.unassigned, ...suburbanResult.unassigned, ...excludedBlocks];

    // 8. Stats
    const byType: Record<string, number> = {};
    const byCategory: Record<string, number> = { urbano: 0, extraurbano: 0 };
    let totalDepotReturns = 0;
    let totalDeadheadKm = 0;
    for (const s of allShifts) {
      byType[s.vehicleType] = (byType[s.vehicleType] || 0) + 1;
      byCategory[s.category] = (byCategory[s.category] || 0) + 1;
      totalDepotReturns += s.depotReturns;
      totalDeadheadKm += s.totalDeadheadKm;
    }

    // Route-level stats
    const routeStats: {
      routeId: string; routeName: string; vehicleType: string; category: string;
      tripsCount: number; vehiclesNeeded: number;
      firstDeparture: string; lastArrival: string;
    }[] = [];

    for (const [routeId, vType] of Object.entries(routeVehicleMap)) {
      const routeTrips = tripBlocks.filter(tb => tb.routeId === routeId);
      if (routeTrips.length === 0) continue;
      const vehiclesForRoute = new Set<string>();
      for (const s of allShifts) {
        if (s.trips.some(t => t.routeId === routeId)) vehiclesForRoute.add(s.vehicleId);
      }
      routeTrips.sort((a, b) => a.departureMin - b.departureMin);
      const rName = routeNameMap.get(routeId) || routeId;
      routeStats.push({
        routeId,
        routeName: rName,
        vehicleType: vType,
        category: getServiceCategory(rName),
        tripsCount: routeTrips.length,
        vehiclesNeeded: vehiclesForRoute.size,
        firstDeparture: routeTrips[0].departureTime,
        lastArrival: routeTrips[routeTrips.length - 1].arrivalTime,
      });
    }
    routeStats.sort((a, b) => b.tripsCount - a.tripsCount);

    // Hourly distribution
    const hourlyDist: { hour: number; trips: number }[] = [];
    for (let h = 4; h <= 26; h++) {
      hourlyDist.push({
        hour: h,
        trips: tripBlocks.filter(t => Math.floor(t.departureMin / 60) === h).length,
      });
    }

    const totalServiceMin = allShifts.reduce((s, v) => s + v.totalServiceMin, 0);
    const totalDeadheadMin = allShifts.reduce((s, v) => s + v.totalDeadheadMin, 0);
    const totalServiceHours = +(totalServiceMin / 60).toFixed(1);
    const totalDeadheadHours = +(totalDeadheadMin / 60).toFixed(1);

    const efficiency = totalServiceMin > 0
      ? +((totalServiceMin / (totalServiceMin + totalDeadheadMin)) * 100).toFixed(1)
      : 0;

    const summary = {
      date: dateYMD,
      activeServices: activeServices.size,
      totalTrips: tripBlocks.length,
      selectedRoutes: selectedRouteIds.size,
      totalVehicles: allShifts.length,
      byType,
      byCategory,
      totalServiceHours,
      totalDeadheadHours,
      totalDeadheadKm: +totalDeadheadKm.toFixed(1),
      depotReturns: totalDepotReturns,
      efficiency,
      downsizedTrips: allShifts.reduce((s, v) => s + v.downsizedTrips, 0),
    };

    // 8b. Residenza di servizio per turno (deposito uscita/rientro, geometrico).
    // Depositi scelti dall'utente → assegnazione ristretta + cap morbido.
    const depotSel = parseDepotSelection((body as any).depots);
    const allDepots = await loadDepotPoints(String((body as any).projectId ?? "") || null);
    const depotPoints = depotSel ? allDepots.filter(d => depotSel.ids.has(d.id)) : allDepots;
    const depotCounts = assignResidenzaToShifts(allShifts, tripBlocks, depotPoints, depotSel?.caps);

    // 9. Calculate costs & score
    const costs = calculateCosts(allShifts, tripBlocks.length, totalServiceHours);
    const score = calculateScore(allShifts, tripBlocks.length, totalServiceMin, totalDeadheadMin, totalDeadheadKm, costs);

    // 10. Generate advisories
    const advisories = generateAdvisories(allShifts, tripBlocks, costs, score, hourlyDist);
    if (depotSel?.caps.size) {
      const capAdv = depotCapacityAdvisory(depotCounts, depotSel.caps, depotPoints);
      if (capAdv) advisories.unshift(capAdv);
    }

    res.json({ shifts: allShifts, unassigned: allUnassigned, routeStats, hourlyDist, summary, costs, score, advisories });
  } catch (err: any) {
    req.log.error(err, "Error in service-program optimiser");
    const msg = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    console.error("[service-program] FULL ERROR:", msg, stack);
    res.status(500).json({ error: `Errore nel programma di esercizio: ${msg}` });
  }
});

/* ═══════════════════════════════════════════════════════════════
 *  POST /api/service-program/cpsat — CP-SAT Vehicle Scheduling
 *  Spawn python vehicle_scheduler_cpsat.py
 * ═══════════════════════════════════════════════════════════════ */

/** Corse nel formato atteso dagli script Python (VSP e orchestratore VCSP). */

/**
 * Handler condiviso CP-SAT / VCSP.
 * mode="cpsat"  → solver turni macchina (vehicle_scheduler_cpsat.py)
 * mode="vcsp"   → ottimizzazione INTEGRATA veicoli+guida (vcsp_orchestrator.py):
 *                 loop VSP→CSP→costi-ombra→re-VSP; la risposta ha la stessa
 *                 forma del CP-SAT (post-processing riusato) + sezione `vcsp`
 *                 con i KPI per round e i turni guida del round migliore.
 */
/** INVARIANTE: non si ottimizza senza progetto Planner Studio.
 *  Lo Scheduling Engine lavora solo su feed materializzati dal PS, e tutto il
 *  dato condiviso (nodi, depositi, archi, zone) è scopato su quel progetto.
 *  Senza, il giro proseguirebbe in silenzio sui soli dati globali: un
 *  risultato plausibile ma costruito su un'altra rete. Meglio un errore
 *  parlante che una soluzione sbagliata.
 *  Ritorna true se ha già risposto con l'errore. */
function rejectWithoutPsProject(req: any, res: any): boolean {
  if (/^[0-9a-f-]{36}$/i.test(String(req.body?.psProjectId ?? ""))) return false;
  res.status(400).json({
    error: "Progetto Planner Studio mancante",
    detail: "L'ottimizzazione richiede un progetto Scheduling collegato a un progetto Planner Studio: "
      + "nodi, depositi e archi fuorilinea sono definiti lì. Se il progetto è legacy, ricrealo dal Planner Studio.",
  });
  return true;
}

async function handleVehicleOptimize(req: any, res: any, mode: "cpsat" | "vcsp"): Promise<void> {
  try {
    const feedId = await getLatestFeedId(req);
    if (!feedId) { res.status(404).json({ error: "Nessun feed GTFS caricato" }); return; }

    if (rejectWithoutPsProject(req, res)) return;

    const body = req.body as {
      date?: string;
      routes?: { routeId: string; vehicleType: VehicleType; forced?: boolean }[];
      tripVehicleOverrides?: Record<string, VehicleType>;
      /**
       * Override degli orari di partenza/arrivo per singolo tripId (in minuti dalla mezzanotte).
       * Usato dalla ri-ottimizzazione post-Analisi Intermodale: gli orari sono già stati
       * spostati per garantire le coincidenze, qui ricalcoliamo i turni macchina con i
       * nuovi tempi senza dover modificare il GTFS.
       */
      tripTimeOverrides?: Record<string, { departureMin: number; arrivalMin: number; departureTime?: string; arrivalTime?: string }>;
      timeLimit?: number;
      vehicleCosts?: Record<string, any>;
      solverIntensity?: string;
      /**
       * Parametri avanzati VSP esposti via UI (Fucina/OptimizerStep):
       * - minVehiclesPriority: off | soft | strict | lexicographic (regola #1)
       * - costRatesOverride: tariffe utente che sovrascrivono i default
       * - intensity, scenariosOverride, enableNoGoodCuts, ...
       */
      vspAdvanced?: Record<string, any>;
      /**
       * Planning Studio project ID (UUID). Se presente, il solver riceve
       * anche i cluster PS "logici" (kind!=interchange) come hint di transfer
       * a costo zero. I cluster di interscambio sono già propagati via mirror
       * legacy `stop_clusters` indipendentemente da questo campo.
       */
      psProjectId?: string;
      /**
       * Il lucchetto (Fucina → Ri-ottimizza): turni macchina che l'operatore
       * ha bloccato. Il solver li riceve come VINCOLI DURI — stesse corse,
       * stesso ordine, stessa matricola — e ricalcola solo il resto. Se un
       * turno bloccato non sta nel modello (corsa sparita, aggancio
       * impossibile) il solver risponde con un errore parlante → 422.
       */
      lockedChains?: { vehicleId?: string; tripIds: string[] }[];
    };

    const lockedChains = (Array.isArray(body.lockedChains) ? body.lockedChains : [])
      .filter((c): c is { vehicleId?: string; tripIds: string[] } => !!c && Array.isArray(c.tripIds))
      .map(c => ({
        ...(typeof c.vehicleId === "string" && c.vehicleId.trim() ? { vehicleId: c.vehicleId.trim() } : {}),
        tripIds: c.tripIds.map(t => String(t ?? "").trim()).filter(Boolean),
      }))
      .filter(c => c.tripIds.length > 0);

    const rawDate = body.date;
    if (!rawDate || typeof rawDate !== "string") {
      res.status(400).json({ error: "Parametro 'date' obbligatorio (YYYYMMDD o YYYY-MM-DD)" });
      return;
    }
    const dateYMD = rawDate.replace(/-/g, "");
    if (!/^\d{8}$/.test(dateYMD)) {
      res.status(400).json({ error: "Formato data non valido" });
      return;
    }

    if (!body.routes || !Array.isArray(body.routes) || body.routes.length === 0) {
      res.status(400).json({ error: "Parametro 'routes' obbligatorio" });
      return;
    }

    const validTypes = new Set(Object.keys(VEHICLE_SIZE));
    const routeVehicleMap: Record<string, VehicleType> = {};
    const routeForcedMap: Record<string, boolean> = {};
    for (const r of body.routes) {
      if (!r.routeId || !r.vehicleType || !validTypes.has(r.vehicleType)) {
        res.status(400).json({ error: `Tipo veicolo non valido: "${r.vehicleType}" per linea "${r.routeId}"` });
        return;
      }
      routeVehicleMap[r.routeId] = r.vehicleType;
      routeForcedMap[r.routeId] = !!r.forced;
    }

    const selectedRouteIds = new Set(Object.keys(routeVehicleMap));
    const timeLimitSec = body.timeLimit ?? 60;

    // 1. Active services
    const activeServices = await getActiveServiceIds(feedId, dateYMD);
    if (activeServices.size === 0) {
      res.json({ status: "NO_INPUT", vehicleShifts: [], metrics: {} });
      return;
    }

    // 2. Load trips (same as greedy endpoint)
    await ensureVariantCodeColumn();
    const allTrips = await db.select({
      tripId: gtfsTrips.tripId,
      routeId: gtfsTrips.routeId,
      serviceId: gtfsTrips.serviceId,
      headsign: gtfsTrips.tripHeadsign,
      directionId: gtfsTrips.directionId,
      onDemand: gtfsTrips.onDemand,
      variantCode: gtfsTrips.variantCode,
    }).from(gtfsTrips).where(eq(gtfsTrips.feedId, feedId));

    const trips = allTrips.filter(t =>
      selectedRouteIds.has(t.routeId) && activeServices.has(t.serviceId)
    );

    if (trips.length === 0) {
      res.json({ status: "NO_INPUT", vehicleShifts: [], metrics: {} });
      return;
    }

    // 3. Stop times
    const tripIds = trips.map(t => t.tripId);
    const stopTimesRaw = await db.execute<{
      trip_id: string; stop_id: string; stop_sequence: number;
      departure_time: string | null; arrival_time: string | null;
    }>(sql`
      SELECT trip_id, stop_id, stop_sequence, departure_time, arrival_time
      FROM gtfs_stop_times
      WHERE feed_id = ${feedId}
        AND trip_id IN ${sql.raw(`(${tripIds.map(id => `'${id.replace(/'/g, "''")}'`).join(",")})`)}
      ORDER BY trip_id, stop_sequence
    `);

    const stByTrip: Record<string, typeof stopTimesRaw.rows> = {};
    for (const st of stopTimesRaw.rows) {
      if (!stByTrip[st.trip_id]) stByTrip[st.trip_id] = [];
      stByTrip[st.trip_id].push(st);
    }

    // 4. Route names + stop coords
    const routeRows = await db.select({
      routeId: gtfsRoutes.routeId,
      shortName: gtfsRoutes.routeShortName,
      longName: gtfsRoutes.routeLongName,
    }).from(gtfsRoutes).where(eq(gtfsRoutes.feedId, feedId));
    const routeNameMap = new Map(routeRows.map(r => [r.routeId, r.shortName || r.longName || r.routeId]));

    const stopRows = await db.select({
      stopId: gtfsStops.stopId,
      lat: gtfsStops.stopLat,
      lon: gtfsStops.stopLon,
      name: gtfsStops.stopName,
    }).from(gtfsStops).where(eq(gtfsStops.feedId!, feedId));
    const stopCoords = new Map(stopRows.map(s => [s.stopId, { lat: s.lat, lon: s.lon, name: s.name || s.stopId }]));

    // 4c. Flessibilità DICHIARATA IN PIANIFICAZIONE (cervello P↔TM↔TG):
    // flexMin per linea (default) e per corsa (override) dal progetto PS.
    // Nel feed materializzato route_id/trip_id GTFS = uuid PS, quindi il
    // lookup è diretto. Corsa senza dichiarazione = inchiodata (0).
    const flexByRoute = new Map<string, number>();
    const flexByTrip = new Map<string, number>();
    const psProjForFlex = typeof body.psProjectId === "string" && /^[0-9a-f-]{36}$/i.test(body.psProjectId)
      ? body.psProjectId : null;
    if (psProjForFlex) {
      try {
        const fr = await db.execute<any>(sql`
          SELECT id, (attributes->>'flexMin')::int AS flex FROM ps_routes
           WHERE project_id = ${psProjForFlex}::uuid AND attributes ? 'flexMin'`);
        for (const r of fr.rows ?? []) if (Number(r.flex) > 0) flexByRoute.set(String(r.id), Math.min(30, Number(r.flex)));
        const ft = await db.execute<any>(sql`
          SELECT id, (attributes->>'flexMin')::int AS flex FROM ps_trips
           WHERE project_id = ${psProjForFlex}::uuid AND attributes ? 'flexMin'`);
        for (const r of ft.rows ?? []) flexByTrip.set(String(r.id), Math.max(0, Math.min(30, Number(r.flex) || 0)));
        if (flexByRoute.size || flexByTrip.size) {
          req.log.info(`CP-SAT VSP: flessibilità dichiarata su ${flexByRoute.size} linee e ${flexByTrip.size} corse (progetto PS)`);
        }
      } catch { /* progetto PS senza flex: tutte le corse inchiodate */ }
    }

    // 5. Build trip blocks
    const tripBlocks: TripBlock[] = [];
    for (const t of trips) {
      const sts = stByTrip[t.tripId];
      if (!sts || sts.length === 0) continue;
      sts.sort((a, b) => a.stop_sequence - b.stop_sequence);
      const firstDep = sts[0].departure_time || sts[0].arrival_time || "00:00:00";
      const lastArr = sts[sts.length - 1].arrival_time || sts[sts.length - 1].departure_time || firstDep;
      const firstStop = stopCoords.get(sts[0].stop_id);
      const lastStop = stopCoords.get(sts[sts.length - 1].stop_id);
      const routeName = routeNameMap.get(t.routeId) || t.routeId;

      // Applica eventuale override degli orari (post-Analisi Intermodale): gli orari
      // sono già stati spostati per garantire le coincidenze, qui ricalcoliamo i turni
      // macchina con i nuovi tempi senza dover modificare il GTFS.
      const ovr = body.tripTimeOverrides?.[t.tripId];
      const finalDepartureTime = ovr?.departureTime ?? firstDep;
      const finalArrivalTime = ovr?.arrivalTime ?? lastArr;
      const finalDepartureMin = typeof ovr?.departureMin === "number" ? ovr.departureMin : timeToMinutes(firstDep);
      const finalArrivalMin = typeof ovr?.arrivalMin === "number" ? ovr.arrivalMin : timeToMinutes(lastArr);

      tripBlocks.push({
        tripId: t.tripId,
        routeId: t.routeId,
        routeName,
        headsign: t.headsign,
        variantCode: (t as any).variantCode ?? null,
        directionId: t.directionId ?? 0,
        departureTime: finalDepartureTime,
        arrivalTime: finalArrivalTime,
        departureMin: finalDepartureMin,
        arrivalMin: finalArrivalMin,
        stopCount: sts.length,
        firstStopId: sts[0].stop_id,
        lastStopId: sts[sts.length - 1].stop_id,
        firstStopLat: firstStop?.lat ?? 43.6,
        firstStopLon: firstStop?.lon ?? 13.5,
        lastStopLat: lastStop?.lat ?? 43.6,
        lastStopLon: lastStop?.lon ?? 13.5,
        firstStopName: firstStop?.name || sts[0].stop_id,
        lastStopName: lastStop?.name || sts[sts.length - 1].stop_id,
        requiredVehicle: (body.tripVehicleOverrides?.[t.tripId] as VehicleType) ?? (routeVehicleMap[t.routeId] || "12m"),
        category: getServiceCategory(routeName),
        forced: routeForcedMap[t.routeId] ?? false,
        onDemand: !!t.onDemand,
        flexMin: flexByTrip.get(t.tripId) ?? flexByRoute.get(t.routeId) ?? 0,
      });
    }

    // Corse ESCLUSE dall'operatore: fuori dal solver ma restano SCOPERTE (unassigned),
    // così il traffico dati resta corretto (non spariscono, contano come non coperte).
    const excludedSet = new Set<string>(Array.isArray((body as any).excludedTripIds)
      ? (body as any).excludedTripIds.filter((x: any) => typeof x === "string") : []);
    const excludedBlocks: TripBlock[] = excludedSet.size ? tripBlocks.filter(t => excludedSet.has(t.tripId)) : [];
    for (const b of excludedBlocks) (b as any).excludedByOperator = true;
    const solverBlocks: TripBlock[] = excludedSet.size ? tripBlocks.filter(t => !excludedSet.has(t.tripId)) : tripBlocks;

    req.log.info(`CP-SAT VSP: ${solverBlocks.length} trips (${excludedBlocks.length} escluse), timeLimit=${timeLimitSec}s`);

    // Build route details for Python
    const routeDetailsForPy = Array.from(selectedRouteIds).map(rid => ({
      routeId: rid,
      routeName: routeNameMap.get(rid) || rid,
    }));

    /* ── 5b. Cluster utente (Planning Studio + legacy) per VSP ────────────
     * I cluster definiti dall'utente sono passati al CP-SAT come hint:
     * fermate dello stesso cluster vengono trattate come "stesso punto"
     * (deadhead km=0, tempo=0). Sorgenti aggregate:
     *  - cluster legacy (`stop_cluster_stops`): comprendono già il mirror
     *    PS→legacy dei kind='interchange' (cfr planning-studio-materialize)
     *  - cluster PS logici (kind!='interchange'): NON sono mirrorati,
     *    quindi li leggiamo direttamente da ps_stop_clusters/ps_stops
     *    se è specificato un psProjectId.
     * Lavoriamo per stop_id GTFS (chiave usata dal solver).
     */
    const psClustersForPy: { id: string; name: string; kind: string; stopIds: string[] }[] = [];
    const psProjectIdForClusters = typeof body.psProjectId === "string" && /^[0-9a-f-]{36}$/i.test(body.psProjectId)
      ? body.psProjectId : null;
    try {
      // 5b.1 — cluster legacy: SOLO globali + quelli mirrorati da QUESTO
      // progetto PS. Prima si leggeva l'intera tabella senza filtro: i nodi
      // di altri progetti entravano nel solver e le loro fermate venivano
      // trattate come "stesso punto" (fuorilinea 0). Con stop_id GTFS che si
      // ripetono tra feed diversi, questo falsava la matrice fuorilinea.
      const legacyRows = await db.execute<{ cluster_id: string; name: string; gtfs_stop_id: string }>(sql`
        SELECT scs.cluster_id::text AS cluster_id,
               COALESCE(c.name, 'Cluster') AS name,
               scs.gtfs_stop_id
          FROM stop_cluster_stops scs
          JOIN stop_clusters c ON c.id = scs.cluster_id
         WHERE c.source_ps_project_id IS NULL
            OR c.source_ps_project_id = ${psProjectIdForClusters}::uuid
      `);
      const legacyByCluster = new Map<string, { name: string; stopIds: Set<string> }>();
      for (const r of legacyRows.rows) {
        if (!legacyByCluster.has(r.cluster_id)) {
          legacyByCluster.set(r.cluster_id, { name: r.name, stopIds: new Set() });
        }
        legacyByCluster.get(r.cluster_id)!.stopIds.add(r.gtfs_stop_id);
      }
      for (const [cid, v] of legacyByCluster) {
        if (v.stopIds.size >= 2) {
          psClustersForPy.push({ id: cid, name: v.name, kind: "interchange", stopIds: Array.from(v.stopIds) });
        }
      }
      // 5b.2 — cluster PS logici (kind != interchange) per il psProjectId, se passato
      const psProjectId = psProjectIdForClusters;
      if (psProjectId) {
        const psRows = await db.execute<{ cluster_id: string; name: string; kind: string; gtfs_stop_id: string }>(sql`
          SELECT c.id::text AS cluster_id,
                 COALESCE(NULLIF(c.name, ''), 'Cluster') AS name,
                 COALESCE(c.kind, 'interchange') AS kind,
                 s.id::text AS gtfs_stop_id
            FROM ps_stops s
            JOIN ps_stop_clusters c ON c.id = s.cluster_id
           WHERE s.project_id = ${psProjectId}::uuid
             AND s.cluster_id IS NOT NULL
             AND COALESCE(c.kind, 'interchange') != 'interchange'
        `);
        const psByCluster = new Map<string, { name: string; kind: string; stopIds: Set<string> }>();
        for (const r of psRows.rows) {
          if (!psByCluster.has(r.cluster_id)) {
            psByCluster.set(r.cluster_id, { name: r.name, kind: r.kind, stopIds: new Set() });
          }
          psByCluster.get(r.cluster_id)!.stopIds.add(r.gtfs_stop_id);
        }
        for (const [cid, v] of psByCluster) {
          if (v.stopIds.size >= 2) {
            psClustersForPy.push({ id: cid, name: v.name, kind: v.kind, stopIds: Array.from(v.stopIds) });
          }
        }
      }
      if (psClustersForPy.length > 0) {
        const totalStops = psClustersForPy.reduce((s, c) => s + c.stopIds.length, 0);
        req.log.info(`CP-SAT VSP: ${psClustersForPy.length} user-cluster (${totalStops} stop) inviati al solver [scope PS ${psProjectIdForClusters}]`);
      }
    } catch (err: any) {
      req.log.error(`CP-SAT VSP: errore caricamento cluster utente: ${err?.message}`);
    }

    // 5c. Multi-deposito: selezione utente + matrice fuorilinea per il solver.
    // I depositi selezionati entrano nel SOLVER (domiciliazione + cap hard);
    // la matrice copre {depositi}×{capolinea} ∪ {capolinea}×{capolinea} con km
    // stradali OSRM (fallback Haversine×circuità).
    const depotSel = parseDepotSelection((body as any).depots);
    const allDepots = await loadDepotPoints(String((body as any).projectId ?? "") || null);
    const depotPoints = depotSel ? allDepots.filter(d => depotSel.ids.has(d.id)) : allDepots;

    let depotsForPy: { id: string; name: string; color: string; lat: number; lon: number; maxVehicles: number | null; fleet?: Record<string, number> }[] | undefined;
    let deadheadKm: Record<string, number> | undefined;
    let deadheadMin: Record<string, number> | undefined;
    // Esito della restrizione all'archivio «Archi fuorilinea» (per il log del
    // solver e la relazione): scope, archi, coppie ammesse/vietate.
    let deadheadArchive: {
      scope: string; arcs: number; ttAllowed: number; ttForbidden: number; depotLegsOutsideArchive: number;
      // tempi/km presi dall'archivio (custom_min ?? travel_min, custom_km ?? road_km) per le coppie del giro
      timesApplied?: number; kmApplied?: number; customTimes?: number; depotLegsMissing?: string[];
      // coppie senza arco proprio che prendono tempo/km dal verso opposto (andata = ritorno)
      mirroredPairs?: number;
    } | undefined;
    if (depotSel && depotPoints.length > 0) {
      depotsForPy = depotPoints.map(d => ({
        id: d.id, name: d.name, color: d.color, lat: d.lat, lon: d.lon,
        maxVehicles: depotSel.caps.get(d.id) ?? null,
        // flotta per TIPOLOGIA di veicolo (vincolo hard nella domiciliazione)
        ...(depotSel.fleets.get(d.id) ? { fleet: depotSel.fleets.get(d.id) } : {}),
      }));
      try {
        const depotNodes: DHNode[] = depotPoints.map(d => ({ lat: d.lat, lon: d.lon }));
        const terminalNodes: DHNode[] = [];
        for (const t of tripBlocks) {
          terminalNodes.push({ lat: t.firstStopLat, lon: t.firstStopLon });
          terminalNodes.push({ lat: t.lastStopLat, lon: t.lastStopLon });
        }
        const [outM, inM, ttM] = await Promise.all([
          buildDeadheadKmMatrix(depotNodes, terminalNodes),   // uscite deposito→capolinea
          buildDeadheadKmMatrix(terminalNodes, depotNodes),   // rientri capolinea→deposito
          buildDeadheadKmMatrix(terminalNodes, terminalNodes), // riposizionamenti
        ]);
        deadheadKm = { ...ttM.matrix, ...outM.matrix, ...inM.matrix };
        const osrm = outM.osrmPairs + inM.osrmPairs + ttM.osrmPairs;
        const total = outM.totalPairs + inM.totalPairs + ttM.totalPairs;
        req.log.info(`CP-SAT VSP: matrice fuorilinea ${total} coppie (${osrm} da OSRM, ${total - osrm} Haversine)`);

        /* ARCHIVIO «Archi fuorilinea» = elenco dei fuorilinea AMMESSI e dei
         * loro TEMPI e KM. Lo scheduling usa SOLO quelli: una coppia
         * capolinea↔capolinea che l'operatore non ha (o ha cancellato) è
         * vietata; le tratte deposito↔capolinea fuori archivio restano stimate
         * (il bus deve comunque uscire e rientrare) ma vengono contate ed
         * elencate. Per OGNI arco risolto sui nodi del giro (deposito per id,
         * capolinea per stop id, cluster espanso nelle sue fermate) il tempo è
         * custom_min (curato a mano) altrimenti travel_min, i km custom_km
         * altrimenti road_km: i minuti che l'operatore vede in Planning Studio
         * sono quelli che il solver usa (prima solo gli archi «curati a mano»
         * passavano, e solo se le coordinate coincidevano al 5° decimale: le
         * tratte deposito e i cluster restavano alla stima km/velocità + 5′).
         * Scope: archi del progetto PS collegato se ne esistono, altrimenti
         * gli archi globali; archivio vuoto = nessuna restrizione (matrice
         * completa, come prima). Precedenza: arco di progetto > globale; arco
         * su fermata > arco su cluster. */
        try {
          let psProjForArchive: string | null = null;
          const schedProjectIdA = String((body as any).projectId ?? "");
          if (/^[0-9a-f-]{36}$/i.test(schedProjectIdA)) {
            const pr = await db.execute<any>(sql`SELECT planning_studio_project_id FROM scheduling_projects WHERE id = ${schedProjectIdA}::uuid`);
            psProjForArchive = (pr.rows?.[0]?.planning_studio_project_id as string | undefined) ?? null;
          }
          // Percorso agente (agent-optimize): il progetto PS arriva come psProjectId
          // anche senza progetto scheduling collegato
          if (!psProjForArchive && typeof body.psProjectId === "string" && /^[0-9a-f-]{36}$/i.test(body.psProjectId)) {
            psProjForArchive = body.psProjectId;
          }
          // Archi GLOBALI come base + archi del PROGETTO che li sommano (e vincono
          // sull'omologo globale).
          const ARC_COLS = sql`from_key, from_type, from_lat, from_lon, to_key, to_type, to_lat, to_lon, ps_project_id, road_km, travel_min, custom_km, custom_min, source`;
          const archiveRows: any[] = psProjForArchive
            ? (await db.execute<any>(sql`SELECT ${ARC_COLS} FROM deadhead_arcs WHERE ps_project_id IS NULL OR ps_project_id = ${psProjForArchive}::uuid ORDER BY (ps_project_id IS NOT NULL)`)).rows ?? []
            : (await db.execute<any>(sql`SELECT ${ARC_COLS} FROM deadhead_arcs WHERE ps_project_id IS NULL`)).rows ?? [];
          const nProjectArcs = archiveRows.filter(a => a.ps_project_id).length;
          const archiveScope = nProjectArcs > 0 ? (archiveRows.length > nProjectArcs ? "globale+progetto" : "progetto") : "globale";
          if (archiveRows.length > 0) {
            // nodi di QUESTO giro: capolinea per stop id e coordinate, depositi per id
            const termCoordByStop = new Map<string, string>();
            const termCoordKeys = new Set<string>();
            const nameByCoord = new Map<string, string>();
            for (const t of tripBlocks) {
              const k1 = dhKey(t.firstStopLat, t.firstStopLon);
              const k2 = dhKey(t.lastStopLat, t.lastStopLon);
              termCoordKeys.add(k1); termCoordKeys.add(k2);
              if (t.firstStopId) termCoordByStop.set(String(t.firstStopId), k1);
              if (t.lastStopId) termCoordByStop.set(String(t.lastStopId), k2);
              if (!nameByCoord.has(k1)) nameByCoord.set(k1, t.firstStopName || String(t.firstStopId));
              if (!nameByCoord.has(k2)) nameByCoord.set(k2, t.lastStopName || String(t.lastStopId));
            }
            const depotCoordById = new Map<string, string>();
            const depotCoordKeys = new Set<string>();
            for (const d of depotPoints) {
              const k = dhKey(d.lat, d.lon);
              depotCoordById.set(String(d.id), k); depotCoordKeys.add(k);
              nameByCoord.set(k, `Deposito ${d.name}`);
            }
            // Un nodo dell'archivio → una o più chiavi coordinate di QUESTO giro:
            // deposito per id, capolinea per stop id (poi coordinate), cluster
            // espanso in tutte le sue fermate membre presenti nel giro.
            const clusterStops = new Map<string, string[]>();
            for (const c of psClustersForPy) clusterStops.set(String(c.id), c.stopIds.map(String));
            const isClusterNode = (key: string, type: string) => type === "cluster" || String(key).startsWith("cluster:");
            const nodeKeys = (key: string, type: string, lat: number, lon: number): string[] => {
              if (type === "depot") {
                const id = String(key).replace(/^depot:/, "");
                const k = depotCoordById.get(id) ?? (depotCoordKeys.has(dhKey(lat, lon)) ? dhKey(lat, lon) : null);
                return k ? [k] : [];
              }
              if (isClusterNode(key, type)) {
                const id = String(key).replace(/^cluster:/, "");
                const members = clusterStops.get(id) ?? [];
                const ks = members.map(sid => termCoordByStop.get(sid)).filter((k): k is string => !!k);
                return Array.from(new Set(ks));
              }
              if (String(key).startsWith("stop:")) {
                const k = termCoordByStop.get(String(key).slice(5));
                if (k) return [k];
              }
              const ck = dhKey(lat, lon);
              return termCoordKeys.has(ck) ? [ck] : [];
            };
            const allowed = new Set<string>();
            const archMin = new Map<string, number>();
            const archKm = new Map<string, number>();
            const archRank = new Map<string, number>();
            let resolvedArcs = 0, unresolvedArcs = 0, customTimes = 0;
            for (const a of archiveRows) {
              const kas = nodeKeys(a.from_key, a.from_type, Number(a.from_lat), Number(a.from_lon));
              const kbs = nodeKeys(a.to_key, a.to_type, Number(a.to_lat), Number(a.to_lon));
              if (!kas.length || !kbs.length) { unresolvedArcs++; continue; }
              resolvedArcs++;
              const viaCluster = isClusterNode(a.from_key, a.from_type) || isClusterNode(a.to_key, a.to_type);
              // progetto > globale; fermata > cluster
              const rank = (a.ps_project_id ? 2 : 0) + (viaCluster ? 0 : 1);
              const minRaw = a.custom_min ?? a.travel_min;
              const kmRaw = a.custom_km ?? a.road_km;
              const hasMin = minRaw != null && Number.isFinite(Number(minRaw)) && Number(minRaw) >= 0;
              const hasKm = kmRaw != null && Number.isFinite(Number(kmRaw)) && Number(kmRaw) >= 0;
              if (a.custom_min != null) customTimes++;
              for (const ka of kas) for (const kb of kbs) {
                if (ka === kb) continue;
                const key = `${ka}|${kb}`;
                allowed.add(key);
                if ((archRank.get(key) ?? -1) > rank) continue;
                archRank.set(key, rank);
                if (hasMin) archMin.set(key, Math.round(Number(minRaw) * 10) / 10);
                if (hasKm) archKm.set(key, Math.round(Number(kmRaw) * 100) / 100);
              }
            }
            /* ANDATA = RITORNO. I fuorilinea si considerano dello stesso tempo nei
             * due versi: se una coppia ha l'arco solo in un verso, il verso opposto
             * eredita ammissione, tempo e km; se li ha in entrambi, il tempo è il
             * tempo curato a mano (se solo un verso lo ha) altrimenti il maggiore
             * dei due tempi di percorrenza, così andata e ritorno coincidono. */
            let mirroredPairs = 0;
            const customKeys = new Set<string>();
            for (const a of archiveRows) {
              if (a.custom_min == null) continue;
              const kas = nodeKeys(a.from_key, a.from_type, Number(a.from_lat), Number(a.from_lon));
              const kbs = nodeKeys(a.to_key, a.to_type, Number(a.to_lat), Number(a.to_lon));
              for (const ka of kas) for (const kb of kbs) if (ka !== kb) customKeys.add(`${ka}|${kb}`);
            }
            for (const key of Array.from(allowed)) {
              const [ka, kb] = key.split("|");
              const rev = `${kb}|${ka}`;
              if (!allowed.has(rev)) {
                allowed.add(rev);
                mirroredPairs++;
                if (archMin.has(key)) archMin.set(rev, archMin.get(key)!);
                if (archKm.has(key)) archKm.set(rev, archKm.get(key)!);
                continue;
              }
              const mA = archMin.get(key), mB = archMin.get(rev);
              if (mA == null || mB == null || mA === mB) continue;
              const cA = customKeys.has(key), cB = customKeys.has(rev);
              const t = cA && !cB ? mA : (!cA && cB ? mB : (cA && cB ? null : Math.max(mA, mB)));
              if (t != null) { archMin.set(key, t); archMin.set(rev, t); }
            }
            if (resolvedArcs === 0) {
              // Archivio di un'altra rete/feed: nessun arco tocca i nodi di questo
              // giro → nessuna restrizione (matrice completa), ma lo diciamo.
              deadheadArchive = { scope: `${archiveScope} (non applicato: nessun arco sui nodi del giro)`, arcs: archiveRows.length, ttAllowed: 0, ttForbidden: 0, depotLegsOutsideArchive: 0, timesApplied: 0, kmApplied: 0, customTimes: 0 };
              req.log.warn(`CP-SAT VSP: archivio fuorilinea ${archiveScope} (${archiveRows.length} archi) non tocca i nodi di questo giro: matrice completa, nessuna restrizione`);
            } else {
              let ttAllowed = 0, ttForbidden = 0, depotOutside = 0, timesApplied = 0, kmApplied = 0;
              const missing: string[] = [];
              const describe = (key: string) => key.split("|").map(k => nameByCoord.get(k) ?? k).join(" → ");
              for (const key of Object.keys(ttM.matrix)) {
                if (allowed.has(key)) ttAllowed++;
                else { deadheadKm[key] = 9999; ttForbidden++; }
              }
              for (const key of [...Object.keys(outM.matrix), ...Object.keys(inM.matrix)]) {
                if (!allowed.has(key)) { depotOutside++; if (missing.length < 20) missing.push(describe(key)); }
              }
              // Tempi e km dell'archivio su TUTTE le coppie del giro che hanno un arco
              const minOverrides: Record<string, number> = {};
              for (const key of Object.keys(deadheadKm)) {
                if (deadheadKm[key] === 9999) continue;
                const km = archKm.get(key);
                const min = archMin.get(key);
                if (km != null) { deadheadKm[key] = km; kmApplied++; }
                if (min != null) { minOverrides[key] = min; timesApplied++; }
              }
              if (Object.keys(minOverrides).length > 0) deadheadMin = minOverrides;
              deadheadArchive = { scope: archiveScope, arcs: archiveRows.length, ttAllowed, ttForbidden, depotLegsOutsideArchive: depotOutside, timesApplied, kmApplied, customTimes, depotLegsMissing: missing, mirroredPairs };
              req.log.info(`CP-SAT VSP: archivio fuorilinea ${archiveScope} (${archiveRows.length} archi, ${resolvedArcs} sui nodi del giro, ${unresolvedArcs} non riconosciuti): ${ttAllowed} coppie capolinea ammesse, ${ttForbidden} vietate (riposizionamento via deposito se il tempo basta), ${depotOutside} tratte deposito fuori archivio (stimate); tempi dell'archivio su ${timesApplied} coppie (${customTimes} archi con tempo curato a mano, ${mirroredPairs} versi specchiati: andata = ritorno), km su ${kmApplied}`);
              if (missing.length) req.log.warn(`CP-SAT VSP: tratte deposito SENZA arco in archivio (tempo stimato km/velocità + buffer): ${missing.join("; ")}${depotOutside > missing.length ? `; … e altre ${depotOutside - missing.length}` : ""}`);
            }
          } else {
            req.log.info("CP-SAT VSP: archivio fuorilinea vuoto, matrice completa (nessuna restrizione)");
          }
        } catch (err: any) {
          req.log.warn({ err: err?.message }, "archivio fuorilinea non leggibile: matrice completa");
        }
      } catch (err: any) {
        req.log.warn({ err: err?.message }, "matrice fuorilinea non disponibile, il solver stima Haversine");
      }
    } else {
      deadheadArchive = { scope: "non applicato: nessun deposito selezionato (matrice fuorilinea non costruita)", arcs: 0, ttAllowed: 0, ttForbidden: 0, depotLegsOutsideArchive: 0 };
      req.log.warn("CP-SAT VSP: nessun deposito selezionato: matrice fuorilinea non costruita, archivio «Archi fuorilinea» NON applicato (il solver stima Haversine)");
    }

    // 5d. DELAY-ROBUST (Fase 2): profilo ritardi orario dai dati di traffico
    // reali (TomTom, ultimi 30 giorni). delayByHour[h] = minuti di ritardo
    // atteso per ORA di corsa nella fascia h, stimati dalla congestione media
    // (congestione 40% ≈ 6 min persi per ora di guida). Il solver li usa come
    // buffer δ sul concatenamento (off/media/alta).
    const robustnessLevel = String((body as any).robustness || "off").toLowerCase();
    let robustnessCfg: { level: string; delayByHour: Record<string, number> } | undefined;
    if (robustnessLevel === "media" || robustnessLevel === "alta") {
      const delayByHour: Record<string, number> = {};
      try {
        const tr = await db.execute<any>(sql`
          SELECT EXTRACT(HOUR FROM captured_at)::int AS h, avg(congestion_level) AS cong
            FROM traffic_snapshots
           WHERE captured_at > now() - interval '30 days'
           GROUP BY 1
        `);
        for (const r of tr.rows) {
          const d = Math.min(15, Math.round(Number(r.cong || 0) * 15 * 10) / 10);
          if (d > 0) delayByHour[String(r.h)] = d;
        }
      } catch { /* nessun dato traffico → il solver usa il profilo di default */ }
      robustnessCfg = { level: robustnessLevel, delayByHour };
      req.log.info(`VSP robustezza=${robustnessLevel}: profilo ritardi su ${Object.keys(delayByHour).length} fasce orarie${Object.keys(delayByHour).length === 0 ? " (default)" : " (traffico reale)"}`);
    }

    // 5e. NORMATIVA VSP (MAIOR-style): cambi linea, tripper, sosta capolinea,
    // max pezzi, vuoti interni. Whitelist dei campi accettati dal solver.
    let normativaCfg: Record<string, any> | undefined;
    const rawNorm = (body as any).vspNormativa;
    if (rawNorm && typeof rawNorm === "object") {
      const n: Record<string, any> = {};
      for (const k of ["costoCambioLinea", "maxCambiLinea", "maxPezziPerBlocco", "costoTripper", "tripperServizioMinMin", "maxSostaCapolineaMin"]) {
        const v = Number(rawNorm[k]);
        if (rawNorm[k] !== undefined && rawNorm[k] !== null && rawNorm[k] !== "" && Number.isFinite(v)) n[k] = v;
      }
      if (rawNorm.vietaCambiLinea) n.vietaCambiLinea = true;
      if (rawNorm.vietaVuotiInterni) n.vietaVuotiInterni = true;
      if (Object.keys(n).length > 0) normativaCfg = n;
    }

    // 5f. SAGOMA: fasce di punta e tetti di declassamento.
    // Il declassamento pesa in ragione della fascia, e le fasce del feriale
    // (7-9 e 17-19) non valgono di domenica, dove la punta è il pomeriggio:
    // senza questo default un mezzo ridotto alle 16 di domenica sarebbe
    // pagato come fosse morbida. L'operatore può sempre sovrascrivere.
    const sagomaCfg: Record<string, any> = {};
    const rawSagoma = (body as any).sagoma;
    if (rawSagoma && typeof rawSagoma === "object") {
      const fasce = (rawSagoma as any).fascePunta ?? (rawSagoma as any).peakWindows;
      if (Array.isArray(fasce)) sagomaCfg.fascePunta = fasce;
      for (const k of ["maxDeclassatePctPerLinea", "maxDeclassatePctPuntaPerLinea"]) {
        const v = Number((rawSagoma as any)[k]);
        if (Number.isFinite(v)) sagomaCfg[k] = v;
      }
      if ((rawSagoma as any).flotta && typeof (rawSagoma as any).flotta === "object") {
        sagomaCfg.flotta = (rawSagoma as any).flotta;
      }
    }
    if (!sagomaCfg.fascePunta) {
      const y = Number(dateYMD.slice(0, 4)), mo = Number(dateYMD.slice(4, 6)), d = Number(dateYMD.slice(6, 8));
      const dow = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
      if (dow === 0) sagomaCfg.fascePunta = [[15, 20]];
    }
    if (!sagomaCfg.flotta && Array.isArray(depotsForPy)) {
      const perTipo: Record<string, number> = {};
      for (const dep of depotsForPy as any[]) {
        const fl = dep?.fleet;
        if (fl && typeof fl === "object") {
          for (const [k, v] of Object.entries(fl)) {
            const n = Number(v);
            if (Number.isFinite(n) && n >= 0) perTipo[k] = (perTipo[k] ?? 0) + n;
          }
        }
      }
      if (Object.keys(perTipo).length > 0) sagomaCfg.flotta = perTipo;
    }

    // 6. Spawn Python solver (CP-SAT puro, oppure orchestratore VCSP)
    const vspExtraConfig = {
      vehicleCosts: body.vehicleCosts || {},
      solverIntensity: body.solverIntensity || "normal",
      // Parametri avanzati VSP (regola #1 + override costi dalla UI)
      ...(body.vspAdvanced ? { vspAdvanced: body.vspAdvanced } : {}),
      // Robustezza ai ritardi (buffer δ data-driven)
      ...(robustnessCfg ? { robustness: robustnessCfg } : {}),
      // Normativa VSP (MAIOR-style)
      ...(normativaCfg ? { normativa: normativaCfg } : {}),
      // Sagoma: fasce di punta, tetti di declassamento, flotta per tipologia
      ...(Object.keys(sagomaCfg).length > 0 ? { sagoma: sagomaCfg } : {}),
    };
    let cpResult: any;
    if (mode === "vcsp") {
      // Relief points per corsa (fermate intermedie nei cluster) precomputati
      // UNA volta: l'orchestratore li riattacca ai blocchi di ogni round prima
      // di lanciare il CSP.
      const pseudoShifts: any[] = [{ trips: solverBlocks.map(tb => ({ type: "trip", tripId: tb.tripId })) }];
      try { await enrichTripsWithClusterStops(pseudoShifts as any, req.log); } catch { /* senza cluster il CSP taglia solo ai capolinea */ }
      const tripClusterStops: Record<string, any[]> = {};
      for (const t of pseudoShifts[0].trips as any[]) {
        if (Array.isArray(t.clusterStops) && t.clusterStops.length > 0) tripClusterStops[t.tripId] = t.clusterStops;
      }
      const vcspBody = (body as any).vcsp || {};
      // ── Parità col CSP standalone: la config turni guida della UI viene
      // arricchita con gli stessi dati DB (cluster di stacco, autovetture
      // aziendali, nodi di sosta) che riceve il CSP lanciato dall'area TG.
      const operatorCfg = (body as any).crewConfig
        ?? { bds: { serviceType: (body as any).serviceType || "urbano" } };
      const [allDbClusters, dbCompanyCars, crewRestPoints] = await Promise.all([
        loadClustersForPython(),
        loadCompanyCars(),
        loadRestPointsForScenario((body as any).projectId ?? null),
      ]);
      const selClusterIds = Array.isArray(operatorCfg?.selectedClusterIds) ? (operatorCfg.selectedClusterIds as string[]) : null;
      const crewDbClusters = selClusterIds && selClusterIds.length > 0
        ? allDbClusters.filter((c: any) => selClusterIds.includes(c.id))
        : allDbClusters;
      // ── Autovetture aziendali = vincolo RIGIDO, sempre ──
      // Il solver v4 applica il cap HARD solo se bds.optimizer.maxCompanyCars
      // è presente (altrimenti default 5, ignorando le autovetture reali).
      // Precedenza: campo "Autovetture aziendali" della UI (imposta entrambi)
      // > override esplicito dal pannello completo > impostazione DB.
      const explicitOptimizerCap = (operatorCfg as any)?.bds?.optimizer?.maxCompanyCars;
      const crewCompanyCars = typeof operatorCfg?.companyCars === "number"
        ? operatorCfg.companyCars
        : (typeof explicitOptimizerCap === "number" ? explicitOptimizerCap : dbCompanyCars);
      const { selectedClusterIds: _sci, companyCars: _cc, ...restOperatorCfg } = operatorCfg || {};
      const crewConfig = {
        ...restOperatorCfg,
        bds: {
          ...((restOperatorCfg as any).bds ?? {}),
          optimizer: {
            ...(((restOperatorCfg as any).bds ?? {}).optimizer ?? {}),
            maxCompanyCars: crewCompanyCars,
          },
        },
        clusters: crewDbClusters,
        companyCars: crewCompanyCars,
        restPoints: crewRestPoints,
      };
      // Passaggi sui capolinea altrui: senza questi la sonda vede solo le
      // coincidenze fatte da fermo e puo' rompere quelle fatte in transito.
      const pyTrips = buildPyTrips(solverBlocks);
      try {
        const transits = await loadTerminalTransits(feedId, solverBlocks, req.log);
        for (const t of pyTrips as any[]) {
          const tr = transits[t.tripId];
          if (tr && tr.length > 0) t.terminalTransits = tr;
        }
      } catch (e: any) { req.log.info(`loadTerminalTransits saltato: ${e?.message ?? e}`); }
      cpResult = await runVcspOrchestrator(req.log, {
        vsp: {
          trips: pyTrips,
          config: { timeLimit: timeLimitSec, ...vspExtraConfig },
          routeDetails: routeDetailsForPy,
          psClusters: psClustersForPy,
          ...(depotsForPy && depotsForPy.length > 0 ? { depots: depotsForPy } : {}),
          ...(deadheadKm && Object.keys(deadheadKm).length > 0 ? { deadheadKm } : {}),
          ...(deadheadMin && Object.keys(deadheadMin).length > 0 ? { deadheadMin } : {}),
          ...(deadheadArchive ? { deadheadArchive } : {}),
          ...(lockedChains.length > 0 ? { lockedChains } : {}),
        },
        crew: { config: crewConfig },
        vcsp: {
          rounds: Math.max(1, Math.min(10, Number(vcspBody.rounds) || 3)),
          crewTimeLimit: Number(vcspBody.crewTimeLimit) || 90,
          // Sonda di spostamento (cervello P↔TM↔TG): re-solve a caldo con le
          // corse spostate entro il flexMin dichiarato in Planning. 0 = off.
          probes: vcspBody.probes != null
            ? Math.max(0, Math.min(10, Number(vcspBody.probes) || 0))
            : 4,
          probeVspTime: Math.max(20, Math.min(300, Number(vcspBody.probeVspTime) || 60)),
          // Disturbo all'orario (€/corsa·minuto) e portata dei candidati guidati
          // dai turni: passano al Python così come arrivano dall'agente/UI.
          ...(Number.isFinite(Number(vcspBody.shiftPenaltyEur)) && vcspBody.shiftPenaltyEur != null
            ? { shiftPenaltyEur: Math.max(0, Number(vcspBody.shiftPenaltyEur)) } : {}),
          ...(vcspBody.crewShiftScope === "line" || vcspBody.crewShiftScope === "trip"
            ? { crewShiftScope: vcspBody.crewShiftScope } : {}),
          // Pazienza dell'early-stop (round consecutivi senza miglioramento):
          // i round oscillano per costruzione, e quanta ne serva si prova.
          ...(vcspBody.earlyStopPatience != null && Number.isFinite(Number(vcspBody.earlyStopPatience))
            ? { earlyStopPatience: Math.max(1, Math.min(10, Math.round(Number(vcspBody.earlyStopPatience)))) } : {}),
          // Memoria della sonda (lezioni dei giri precedenti): ordina la coda.
          ...(Array.isArray(vcspBody.probeMemory) && vcspBody.probeMemory.length > 0
            ? { probeMemory: vcspBody.probeMemory.slice(0, 200) } : {}),
          // Controllo della sonda (re-solve del best round senza spostamenti):
          // acceso salvo un false esplicito.
          ...(vcspBody.probeControl === false ? { probeControl: false } : {}),
          // Come il feedback passa da un round all'altro. penaltyStep=1 +
          // penaltyAnchor="last" + seedFromBest=false riportano il ciclo a
          // com'era prima della partenza a caldo, senza toccare il codice.
          ...(Number.isFinite(Number(vcspBody.penaltyStep)) && vcspBody.penaltyStep != null
            ? { penaltyStep: Math.min(1, Math.max(0.05, Number(vcspBody.penaltyStep))) } : {}),
          ...(vcspBody.penaltyAnchor === "best" || vcspBody.penaltyAnchor === "last"
            ? { penaltyAnchor: vcspBody.penaltyAnchor } : {}),
          ...(vcspBody.seedFromBest === false ? { seedFromBest: false } : {}),
        },
        tripClusterStops,
      });
    } else {
      cpResult = await runCPSATVehicleScheduler(
        solverBlocks, timeLimitSec, req.log,
        vspExtraConfig,
        routeDetailsForPy,
        psClustersForPy,
        depotsForPy,
        deadheadKm,
        deadheadMin,
        deadheadArchive,
        lockedChains,
      );
    }

    // Il solver ha rifiutato un turno bloccato (corsa non in orario, aggancio
    // impossibile): il messaggio è già scritto per l'operatore, passa com'è.
    if (cpResult && typeof cpResult.error === "string" && cpResult.error) {
      req.log.info(`Solver: ${cpResult.error}`);
      res.status(422).json({ error: cpResult.error, errorKind: cpResult.errorKind ?? "solver" });
      return;
    }

    // 7. Compute costs & score from CP-SAT shifts (reuse existing functions)
    const cpShifts: VehicleShift[] = cpResult.vehicleShifts || [];

    // 7b. Residenza di servizio per turno. Se il SOLVER ha già domiciliato i
    // turni (multi-deposito con cap hard, tratte uscita/rientro incluse) usiamo
    // la sua assegnazione; altrimenti fallback geometrico legacy.
    const solverAssigned = cpShifts.length > 0 && cpShifts.every((s: any) => s.residenzaDepotId);
    const depotCounts = solverAssigned
      ? cpShifts.reduce((m: Map<string, number>, s: any) => {
          m.set(s.residenzaDepotId, (m.get(s.residenzaDepotId) ?? 0) + 1);
          return m;
        }, new Map<string, number>())
      : assignResidenzaToShifts(cpShifts, tripBlocks, depotPoints, depotSel?.caps);

    const totalServiceMin = cpShifts.reduce((s: number, v: VehicleShift) => s + v.totalServiceMin, 0);
    const totalDeadheadMin = cpShifts.reduce((s: number, v: VehicleShift) => s + v.totalDeadheadMin, 0);
    const totalDeadheadKm = cpShifts.reduce((s: number, v: VehicleShift) => s + v.totalDeadheadKm, 0);
    const totalServiceHours = +(totalServiceMin / 60).toFixed(1);

    const costs = calculateCosts(cpShifts, tripBlocks.length, totalServiceHours);
    const score = calculateScore(cpShifts, tripBlocks.length, totalServiceMin, totalDeadheadMin, totalDeadheadKm, costs);

    // Hourly distribution
    const hourlyDist: { hour: number; trips: number }[] = [];
    for (let h = 4; h <= 26; h++) {
      hourlyDist.push({ hour: h, trips: tripBlocks.filter(t => Math.floor(t.departureMin / 60) === h).length });
    }

    const advisories = generateAdvisories(cpShifts, tripBlocks, costs, score, hourlyDist);
    // Vincolo flotta HARD: se il solver non ha potuto rispettare i cap per
    // deposito, riportiamo l'infeasibility come advisory CRITICA con il deficit.
    const fleetInfo = cpResult.metrics?.fleetInfeasibility;
    if (fleetInfo) {
      const perDep = Array.isArray(fleetInfo.perDepot) && fleetInfo.perDepot.length > 0
        ? ` Depositi oltre capacità: ${fleetInfo.perDepot.map((p: any) => `${p.name} ${p.vehicles}/${p.cap}`).join(", ")}.`
        : "";
      advisories.unshift({
        id: "fleet-infeasible",
        severity: "critical",
        category: "fleet",
        title: "Flotta insufficiente per il servizio",
        description: `Servono ${fleetInfo.required} veicoli ma la flotta disponibile nei depositi selezionati è ${fleetInfo.available} (mancano ${fleetInfo.deficit}).${perDep}`,
        impact: `${fleetInfo.deficit} veicol${fleetInfo.deficit === 1 ? "o" : "i"} mancant${fleetInfo.deficit === 1 ? "e" : "i"}`,
        action: "Aumenta le vetture disponibili nei depositi, aggiungi un deposito o riduci le linee dello scenario.",
        metric: fleetInfo.deficit,
      });
    } else if (!solverAssigned && depotSel?.caps.size) {
      // Fallback geometrico legacy: cap morbido → advisory warning
      const capAdv = depotCapacityAdvisory(depotCounts, depotSel.caps, depotPoints);
      if (capAdv) advisories.unshift(capAdv);
    }

    // Summary
    const byType: Record<string, number> = {};
    const byCategory: Record<string, number> = { urbano: 0, extraurbano: 0 };
    let totalDepotReturns = 0;
    for (const s of cpShifts) {
      byType[s.vehicleType] = (byType[s.vehicleType] || 0) + 1;
      byCategory[s.category] = (byCategory[s.category] || 0) + 1;
      totalDepotReturns += s.depotReturns;
    }

    const summary = {
      date: dateYMD,
      activeServices: activeServices.size,
      totalTrips: tripBlocks.length,
      selectedRoutes: selectedRouteIds.size,
      totalVehicles: cpShifts.length,
      byType, byCategory,
      totalServiceHours,
      totalDeadheadHours: +(totalDeadheadMin / 60).toFixed(1),
      totalDeadheadKm: +totalDeadheadKm.toFixed(1),
      depotReturns: totalDepotReturns,
      efficiency: totalServiceMin > 0
        ? +((totalServiceMin / (totalServiceMin + totalDeadheadMin)) * 100).toFixed(1)
        : 0,
      downsizedTrips: cpShifts.reduce((s: number, v: VehicleShift) => s + v.downsizedTrips, 0),
      // Multi-deposito: veicoli domiciliati per deposito (dal solver, cap hard)
      byDepot: cpResult.metrics?.depotAssignment?.perDepot
        ?? Array.from(depotCounts.entries()).map(([id, n]) => ({
          id, name: depotPoints.find(p => p.id === id)?.name ?? "Deposito",
          vehicles: n, cap: depotSel?.caps.get(id) ?? null,
        })),
    };

    // Route stats
    const routeStats: any[] = [];
    for (const [routeId, vType] of Object.entries(routeVehicleMap)) {
      const routeTrips = tripBlocks.filter(tb => tb.routeId === routeId);
      if (routeTrips.length === 0) continue;
      const vehiclesForRoute = new Set<string>();
      for (const s of cpShifts) {
        if (s.trips.some((t: any) => t.routeId === routeId)) vehiclesForRoute.add(s.vehicleId);
      }
      routeTrips.sort((a, b) => a.departureMin - b.departureMin);
      const rName = routeNameMap.get(routeId) || routeId;
      routeStats.push({
        routeId, routeName: rName, vehicleType: vType,
        category: getServiceCategory(rName),
        tripsCount: routeTrips.length, vehiclesNeeded: vehiclesForRoute.size,
        firstDeparture: routeTrips[0].departureTime,
        lastArrival: routeTrips[routeTrips.length - 1].arrivalTime,
      });
    }
    routeStats.sort((a: any, b: any) => b.tripsCount - a.tripsCount);

    res.json({
      solver: mode === "vcsp" ? "vcsp" : "cpsat",
      shifts: cpShifts,
      // Le corse escluse dall'operatore risultano SCOPERTE (il CP-SAT copre tutte
      // le altre che riceve, quindi qui l'unica non-copertura è quella voluta).
      unassigned: excludedBlocks,
      routeStats,
      hourlyDist,
      summary,
      costs,
      score,
      advisories,
      solverMetrics: cpResult.metrics,
      costBreakdown: cpResult.costBreakdown || null,
      greedyComparison: cpResult.greedyComparison || null,
      // VCSP: KPI dei round, feedback costi-ombra e turni guida del best round
      ...(cpResult.vcsp ? { vcsp: cpResult.vcsp } : {}),
    });
  } catch (err: any) {
    req.log.error(err, "Error in CP-SAT service-program");
    res.status(500).json({ error: err.message || "Errore nel solver CP-SAT" });
  }
}

router.post("/service-program/cpsat", (req, res) => handleVehicleOptimize(req, res, "cpsat"));
// VCSP: ottimizzazione integrata turni macchina + turni guida (iterativo con feedback)
router.post("/service-program/vcsp", (req, res) => handleVehicleOptimize(req, res, "vcsp"));

/* ═══════════════════════════════════════════════════════════════
 *  AGENT-OPTIMIZE — lancio ASINCRONO per Argos (MCP/chat)
 *
 *  L'operatore lancia il giro dalla chat; l'agente ha la libertà di girare
 *  le manopole (round, sonde, intensità, crewTimeLimit, flex dichiarato) e
 *  iterare finché il costo totale non scende. Un giro VCSP dura minuti:
 *  qui il POST avvia un job in background e risponde subito con un jobId,
 *  la GET riporta progresso e un risultato COMPATTO (leggibile via MCP).
 *
 *  Il giro riusa ESATTAMENTE handleVehicleOptimize (stessa pipeline della
 *  fucina) tramite req/res sintetici: zero divergenze di comportamento.
 *  Le vetture, se non passate, arrivano dalle tipologie DICHIARATE IN
 *  PLANNING (attributes.vehicleTypes.preferita); i depositi, se non
 *  passati, sono quelli del progetto. A fine giro lo scenario (TM e, in
 *  VCSP, anche TG) viene salvato: l'operatore lo apre da Cerbero.
 * ═══════════════════════════════════════════════════════════════ */

type AgentOptimizeJob = {
  id: string;
  userId: string;
  psProjectId: string;
  mode: "cpsat" | "vcsp";
  status: "running" | "done" | "error";
  createdAt: number;
  finishedAt?: number;
  progress: { phase: string; pct: number; msg: string };
  params: Record<string, any>;
  error?: string;
  result?: any;               // risposta COMPLETA (in memoria, per il salvataggio)
  scenarioId?: string | null;
  dssId?: string | null;
  scenarioName?: string;
};

const agentJobs = new Map<string, AgentOptimizeJob>();
const AGENT_JOB_TTL_MS = 6 * 60 * 60 * 1000;
const AGENT_JOBS_MAX = 30;

function pruneAgentJobs(): void {
  const now = Date.now();
  for (const [id, j] of agentJobs) {
    if (j.status !== "running" && now - (j.finishedAt ?? j.createdAt) > AGENT_JOB_TTL_MS) agentJobs.delete(id);
  }
  if (agentJobs.size > AGENT_JOBS_MAX) {
    const done = Array.from(agentJobs.values())
      .filter(j => j.status !== "running")
      .sort((a, b) => (a.finishedAt ?? a.createdAt) - (b.finishedAt ?? b.createdAt));
    for (const j of done.slice(0, agentJobs.size - AGENT_JOBS_MAX)) agentJobs.delete(j.id);
  }
}

/* ── Registro persistente dei giri ─────────────────────────────────
 * Il registro in memoria muore a ogni deploy: gli esiti finiti sparivano
 * («non trovato») e i giri in corso svanivano senza traccia. Ogni giro viene
 * scritto su agent_optimize_jobs alla creazione e alla fine (esito compatto,
 * scenario, errore) insieme alla richiesta originale, così un giro trovato
 * «running» dopo un riavvio si dichiara interrotto e riporta i parametri
 * con cui rilanciarlo. */
let agentJobsTableReady: Promise<void> | null = null;
export function ensureAgentJobsTable(): Promise<void> {
  if (!agentJobsTableReady) {
    agentJobsTableReady = db.execute(sql`
      CREATE TABLE IF NOT EXISTS agent_optimize_jobs (
        id uuid PRIMARY KEY,
        user_id uuid,
        ps_project_id uuid,
        mode text,
        status text NOT NULL,
        created_at timestamptz NOT NULL,
        finished_at timestamptz,
        progress jsonb,
        params jsonb,
        request jsonb,
        error text,
        scenario_id uuid,
        dss_id uuid,
        scenario_name text,
        result_compact jsonb,
        updated_at timestamptz NOT NULL DEFAULT now()
      )`).then(() => undefined).catch((e) => { agentJobsTableReady = null; throw e; });
  }
  return agentJobsTableReady;
}

async function persistAgentJob(job: AgentOptimizeJob, request?: unknown): Promise<void> {
  try {
    await ensureAgentJobsTable();
    const compact = job.status === "done" && job.result ? compactAgentResult(job.result) : null;
    await db.execute(sql`
      INSERT INTO agent_optimize_jobs (id, user_id, ps_project_id, mode, status, created_at, finished_at,
                                       progress, params, request, error, scenario_id, dss_id, scenario_name, result_compact, updated_at)
      VALUES (${job.id}::uuid, ${job.userId}::uuid, ${job.psProjectId}::uuid, ${job.mode}, ${job.status},
              to_timestamp(${job.createdAt / 1000}),
              ${job.finishedAt ? new Date(job.finishedAt).toISOString() : null}::timestamptz,
              ${JSON.stringify(job.progress)}::jsonb, ${JSON.stringify(job.params)}::jsonb,
              ${request ? JSON.stringify(request) : null}::jsonb,
              ${job.error ?? null}, ${job.scenarioId ?? null}::uuid, ${job.dssId ?? null}::uuid, ${job.scenarioName ?? null},
              ${compact ? JSON.stringify(compact) : null}::jsonb, now())
      ON CONFLICT (id) DO UPDATE SET
        status = EXCLUDED.status, finished_at = EXCLUDED.finished_at, progress = EXCLUDED.progress,
        params = EXCLUDED.params, request = COALESCE(EXCLUDED.request, agent_optimize_jobs.request),
        error = EXCLUDED.error, scenario_id = EXCLUDED.scenario_id, dss_id = EXCLUDED.dss_id,
        scenario_name = EXCLUDED.scenario_name,
        result_compact = COALESCE(EXCLUDED.result_compact, agent_optimize_jobs.result_compact),
        updated_at = now()`);
  } catch { /* best-effort: il registro in memoria resta la via principale */ }
}

async function loadAgentJobRows(where: { id?: string; userId?: string; isAdmin?: boolean }): Promise<any[]> {
  try {
    await ensureAgentJobsTable();
    const r = where.id
      ? await db.execute<any>(sql`SELECT * FROM agent_optimize_jobs WHERE id = ${where.id}::uuid LIMIT 1`)
      : where.isAdmin
        ? await db.execute<any>(sql`SELECT * FROM agent_optimize_jobs ORDER BY created_at DESC LIMIT 20`)
        : await db.execute<any>(sql`SELECT * FROM agent_optimize_jobs WHERE user_id = ${where.userId ?? null}::uuid ORDER BY created_at DESC LIMIT 20`);
    return (r.rows ?? []) as any[];
  } catch { return []; }
}

/** Le lezioni della sonda dai giri precedenti dello stesso progetto e della
 * stessa data: una voce per firma (esito, motivo, tentativi), dalla più
 * recente alla più vecchia, con l'id del giro che l'ha imparata. Il Python le
 * usa per ORDINARE la coda dei candidati — chi era stato accettato si riprova
 * per primo, chi il solver aveva bocciato va in fondo — mai per vietare: il
 * piano cambia da un giro all'altro. Finora questa memoria stava solo nel
 * registro scritto a mano. */
async function loadProbeLessons(psProjectId: string | null | undefined, date: string,
                                maxJobs = 5, maxLessons = 120): Promise<{ lezioni: any[]; giri: number }> {
  if (!psProjectId || !date) return { lezioni: [], giri: 0 };
  try {
    await ensureAgentJobsTable();
    const r = await db.execute<any>(sql`
      SELECT id, finished_at, result_compact->'vcsp'->'probe'->'lezioni' AS lezioni
        FROM agent_optimize_jobs
       WHERE ps_project_id = ${psProjectId}::uuid AND status = 'done' AND mode = 'vcsp'
         AND params->>'date' = ${date}
         AND jsonb_typeof(result_compact->'vcsp'->'probe'->'lezioni') = 'array'
       ORDER BY finished_at DESC NULLS LAST LIMIT ${maxJobs}`);
    const out: any[] = [];
    const viste = new Set<string>();
    let giri = 0;
    for (const row of (r.rows ?? []) as any[]) {
      const lez = Array.isArray(row.lezioni) ? row.lezioni : [];
      if (lez.length === 0) continue;
      giri++;
      for (const l of lez) {
        const firma = typeof l?.firma === "string" ? l.firma : null;
        if (!firma || viste.has(firma)) continue;
        viste.add(firma);
        out.push({ ...l, giro: String(row.id).slice(0, 8) });
        if (out.length >= maxLessons) return { lezioni: out, giri };
      }
    }
    return { lezioni: out, giri };
  } catch { return { lezioni: [], giri: 0 }; }
}

/** Vista API di una riga persistita: un giro «running» su DB ma assente dalla
 * memoria è stato interrotto da un riavvio: lo si dichiara, con la richiesta
 * originale per rilanciarlo con gli stessi parametri. */
function agentJobRowView(row: any, full: boolean): Record<string, any> {
  const interrupted = row.status === "running";
  const createdMs = new Date(row.created_at).getTime();
  const finishedMs = row.finished_at ? new Date(row.finished_at).getTime() : null;
  return {
    jobId: row.id,
    status: interrupted ? "error" : row.status,
    mode: row.mode,
    psProjectId: row.ps_project_id,
    progress: row.progress ?? null,
    elapsedSec: Math.round(((finishedMs ?? Date.now()) - createdMs) / 1000),
    params: row.params ?? {},
    ...(interrupted
      ? { error: "Giro interrotto dal riavvio del server (deploy): rilancialo con gli stessi parametri (campo request)", request: row.request ?? null }
      : row.error ? { error: row.error } : {}),
    ...(row.status === "done" && full ? {
      scenarioId: row.scenario_id ?? null,
      dssId: row.dss_id ?? null,
      scenarioName: row.scenario_name ?? null,
      result: row.result_compact ?? null,
      persisted: true,
    } : {}),
  };
}

/** Logger che intercetta le righe PROGRESS|fase|pct|msg del solver (già
 * inoltrate su stderr→logger da spawnPythonJson) e aggiorna il job. In VCSP
 * ascoltiamo solo la fase "VCSP" (il VSP interno va 0→100 a ogni round). */
function agentJobLogger(job: AgentOptimizeJob, base: any) {
  const wantPhase = job.mode === "vcsp" ? "VCSP" : "VSP";
  const capture = (args: any[]) => {
    for (const a of args) {
      if (typeof a !== "string") continue;
      // un chunk stderr può portare PIÙ righe PROGRESS: vale l'ultima
      for (const line of a.split("\n")) {
        const m = line.match(/PROGRESS\|([^|]+)\|([\d.]+)\|([^|\n]*)/);
        if (m && m[1] === wantPhase) {
          job.progress = { phase: m[1], pct: Math.round(Number(m[2])), msg: m[3].trim() };
        }
      }
    }
  };
  return {
    info: (...a: any[]) => { capture(a); try { base.info(...a); } catch { /* logger morto: il job continua */ } },
    warn: (...a: any[]) => { try { base.warn(...a); } catch { /* idem */ } },
    error: (...a: any[]) => { try { base.error(...a); } catch { /* idem */ } },
  };
}


// filobus esiste in Planning ma il solver non lo modella: viaggia da 12m.
const AGENT_VEHICLE_FALLBACK: Record<string, VehicleType> = { filobus: "12m" };

router.post("/service-program/agent-optimize", async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) { res.status(401).json({ error: "Non autenticato" }); return; }
    const b = (req.body ?? {}) as Record<string, any>;

    const psProjectId = String(b.psProjectId ?? "");
    if (!/^[0-9a-f-]{36}$/i.test(psProjectId)) {
      res.status(400).json({ error: "psProjectId (uuid del progetto Planning Studio) obbligatorio" }); return;
    }
    const rawDate = String(b.date ?? "");
    if (!/^\d{4}-?\d{2}-?\d{2}$/.test(rawDate)) {
      res.status(400).json({ error: "date obbligatoria (YYYY-MM-DD)" }); return;
    }
    const mode: "cpsat" | "vcsp" = b.mode === "cpsat" ? "cpsat" : "vcsp";

    // Un solo giro alla volta per progetto: i solve sono pesanti.
    for (const j of agentJobs.values()) {
      if (j.status === "running" && j.psProjectId === psProjectId) {
        res.status(409).json({ error: "Un giro è già in corso su questo progetto: attendi o interroga lo stato", jobId: j.id });
        return;
      }
    }

    // Feed del giro. I feed materializzati vivono su DUE canali:
    //  - UDP: scheduling_projects.feed_id (feed SCOPED sull'unità)  ← il caso tipico
    //  - esercizio: ps_projects.materialized_feed_id (feed globale del progetto)
    // Risoluzione: feedId esplicito → UDP collegata (projectId esplicito o la più
    // recente col feed ancora esistente) → feed d'esercizio. Prima si guardava
    // SOLO l'esercizio: un progetto con la sola UDP falliva con un 400 fuorviante.
    const fr = await db.execute<any>(sql`
      SELECT materialized_feed_id, name FROM ps_projects WHERE id = ${psProjectId}::uuid`);
    if (!fr.rows?.length) { res.status(404).json({ error: "Progetto Planning Studio non trovato" }); return; }
    const psName: string = fr.rows?.[0]?.name ?? "Progetto";

    let schedProjectId: string | null =
      typeof b.projectId === "string" && /^[0-9a-f-]{36}$/i.test(b.projectId) ? b.projectId : null;
    let feedId: string | null =
      typeof b.feedId === "string" && /^[0-9a-f-]{36}$/i.test(b.feedId) ? b.feedId : null;
    let feedSource: "esplicito" | "udp" | "esercizio" | null = feedId ? "esplicito" : null;
    // «UDP superata» risolta in automatico: l'insieme di corse dell'unità viene
    // riallineato al Planning Studio prima di costruire il feed
    let udpRefresh: { changed: boolean; before: number; after: number; added: number; removed: number } | null = null;
    if (!feedId) {
      // Via maestra: l'UDP (ps_validity_units). Parità con l'app: se l'unità
      // non è mai stata mandata allo scheduling, il progetto si crea QUI e il
      // feed scopato si materializza ON-DEMAND (startSyncJob, stessa via del
      // pulsante "Sincronizza con PS"); se il feed esiste ma è più vecchio
      // dell'ultima modifica in Planning, si ri-materializza. Mai più giri su
      // feed stantii agganciati alla cieca.
      try {
        const units = await db.execute<any>(sql`
          SELECT id, name, trip_count FROM ps_validity_units
           WHERE project_id = ${psProjectId}::uuid
           ORDER BY updated_at DESC`);
        const unitRows: any[] = units.rows ?? [];
        const wantedUnit = typeof b.validityUnitId === "string" && /^[0-9a-f-]{36}$/i.test(b.validityUnitId)
          ? b.validityUnitId : null;
        const unit = wantedUnit
          ? unitRows.find((u: any) => u.id === wantedUnit)
          : (unitRows.length === 1 ? unitRows[0] : null);
        if (!unit && unitRows.length > 1) {
          res.status(400).json({
            error: "Più UDP nel progetto: indica validityUnitId",
            units: unitRows.map((u: any) => ({ id: u.id, name: u.name, tripCount: u.trip_count })),
          });
          return;
        }
        if (unit) {
          let sp: any = (await db.execute<any>(sql`
            SELECT id, feed_id FROM scheduling_projects
             WHERE validity_unit_id = ${unit.id}::uuid
             ORDER BY created_at DESC LIMIT 1`)).rows?.[0] ?? null;
          if (!sp) {
            const ins = await db.execute<any>(sql`
              INSERT INTO scheduling_projects (owner_user_id, name, planning_studio_project_id, validity_unit_id)
              VALUES (${userId}::uuid, ${String(unit.name || psName).slice(0, 120)},
                      ${psProjectId}::uuid, ${unit.id}::uuid)
              RETURNING id, feed_id`);
            sp = ins.rows?.[0] ?? null;
            req.log.info(`agent-optimize: creato progetto scheduling per l'UDP "${unit.name}" (${sp?.id})`);
          }
          if (sp) {
            schedProjectId = sp.id;
            try {
              const { refreshValidityUnitTrips } = await import("../lib/planning-studio-validity-eval");
              udpRefresh = await refreshValidityUnitTrips(psProjectId, String(unit.id));
              if (udpRefresh?.changed) {
                req.log.info(`agent-optimize: UDP "${unit.name}" riallineata al Planning Studio: `
                  + `${udpRefresh.before} → ${udpRefresh.after} corse (+${udpRefresh.added} / −${udpRefresh.removed}) → ri-materializzo`);
              }
            } catch (e: any) {
              req.log.warn(`agent-optimize: riallineamento UDP saltato: ${e?.message ?? e}`);
            }
            let fresh = false;
            if (sp.feed_id && !udpRefresh?.changed) {
              try {
                const st = await db.execute<any>(sql`
                  SELECT (SELECT uploaded_at FROM gtfs_feeds WHERE id = ${sp.feed_id}::uuid) AS synced,
                         GREATEST(
                           COALESCE((SELECT max(updated_at) FROM ps_trips     WHERE project_id = ${psProjectId}::uuid), 'epoch'),
                           COALESCE((SELECT max(updated_at) FROM ps_calendars WHERE project_id = ${psProjectId}::uuid), 'epoch')
                         ) AS changed`);
                const s = st.rows?.[0] ?? {};
                fresh = !!s.synced && new Date(s.synced).getTime() >= new Date(s.changed).getTime();
              } catch { fresh = true; /* senza confronto: fidati del feed esistente */ }
              // Un feed "fresco" per timestamp ma i cui calendari NON coprono
              // la data richiesta è comunque da rifare: coprirebbe il caso del
              // feed materializzato con la finestra date vecchia (clampata ai
              // calendari stagionali) — meglio una ri-materializzazione in più
              // che un giro morto con "nessuna corsa attiva".
              if (fresh) {
                try {
                  const dYmd = rawDate.replace(/-/g, "");
                  const cov = await db.execute<any>(sql`
                    SELECT EXISTS(SELECT 1 FROM gtfs_calendar_dates
                                   WHERE feed_id = ${sp.feed_id}::uuid AND date = ${dYmd}
                                     AND COALESCE(exception_type, 1) = 1)
                        OR EXISTS(SELECT 1 FROM gtfs_calendar
                                   WHERE feed_id = ${sp.feed_id}::uuid
                                     AND start_date <= ${dYmd} AND end_date >= ${dYmd}) AS covered`);
                  if (!cov.rows?.[0]?.covered) {
                    fresh = false;
                    req.log.info(`agent-optimize: feed UDP fresco ma senza servizio il ${dYmd} → ri-materializzo`);
                  }
                } catch { /* verifica impossibile: tieni il feed */ }
              }
            }
            if (fresh) {
              feedId = sp.feed_id;
              feedSource = "udp";
            } else {
              const syncJob = startSyncJob(String(sp.id), psProjectId, userId, req.log);
              const t0 = Date.now();
              while (syncJob.status === "running" && Date.now() - t0 < 20_000) {
                await new Promise(r => setTimeout(r, 500));
              }
              if (syncJob.status === "done" && syncJob.result) {
                feedId = syncJob.result.feedId;
                feedSource = "udp";
              } else if (syncJob.status === "error") {
                res.status(502).json({ error: `Materializzazione dell'UDP fallita: ${syncJob.error}` });
                return;
              } else {
                res.status(409).json({ error: "Materializzazione dell'UDP in corso: rilancia tra ~1 minuto" });
                return;
              }
            }
          }
        }
      } catch (e: any) {
        req.log.warn({ err: e?.message }, "agent-optimize: risoluzione UDP fallita, provo il feed d'esercizio");
      }
    }
    if (!feedId && fr.rows?.[0]?.materialized_feed_id) {
      feedId = fr.rows[0].materialized_feed_id;
      feedSource = "esercizio";
    }
    if (!feedId) {
      res.status(400).json({
        error: "Nessun feed materializzato per questo progetto: crea un'UDP (o materializza il feed d'esercizio) prima di ottimizzare",
      });
      return;
    }

    // Progetto scheduling collegato (depositi scoped + aggancio scenario), se
    // non già determinato dalla risoluzione del feed UDP.
    if (!schedProjectId) {
      try {
        const pr = await db.execute<any>(sql`
          SELECT id FROM scheduling_projects
           WHERE planning_studio_project_id = ${psProjectId}::uuid
           ORDER BY created_at DESC LIMIT 1`);
        schedProjectId = pr.rows?.[0]?.id ?? null;
      } catch { /* installazione senza scheduling_projects */ }
    }

    // Vetture: esplicite dal body, altrimenti dalle tipologie DICHIARATE in Planning.
    const validTypes = new Set(Object.keys(VEHICLE_SIZE));
    let routes: { routeId: string; vehicleType: VehicleType; forced?: boolean }[];
    let vehicleSource: "esplicite" | "planning" | "planning+default" = "esplicite";
    if (Array.isArray(b.routes) && b.routes.length > 0) {
      routes = b.routes;
    } else {
      const feedRoutes = await db.select({
        routeId: gtfsRoutes.routeId,
        shortName: gtfsRoutes.routeShortName,
        longName: gtfsRoutes.routeLongName,
      }).from(gtfsRoutes).where(eq(gtfsRoutes.feedId, feedId));
      const wanted = Array.isArray(b.routeIds) && b.routeIds.length > 0
        ? new Set(b.routeIds.map(String)) : null;
      /* Tipologia dichiarata per linea, col suo lucchetto.
       * Una linea che ammette UN SOLO tipo è inchiodata a quel tipo: nessun
       * declassamento, nemmeno di un gradino. È il lucchetto della fucina,
       * finalmente esprimibile anche dai dati di progetto e da Argos — prima
       * `forced` era cablato a false su questo percorso e `ammesse` non
       * arrivava a nessun solver, quindi «questa linea non scende sotto il
       * 12 metri» non era dicibile in alcun modo. */
      const psVehicle = new Map<string, { tipo: string; forced: boolean }>();
      try {
        // Lookup diretto per progetto (route_id GTFS = uuid ps_routes): vale
        // anche per i feed UDP scoped, dove il join su materialized_feed_id
        // non matcherebbe e le dichiarazioni sparirebbero.
        const psR = await db.execute<any>(sql`
          SELECT r.id, r.attributes->'vehicleTypes' AS vt
            FROM ps_routes r
           WHERE r.project_id = ${psProjectId}::uuid
             AND r.attributes ? 'vehicleTypes'`);
        for (const row of psR.rows ?? []) {
          const vt = row.vt;
          if (vt && Array.isArray(vt.ammesse) && vt.ammesse.length > 0) {
            const ammesse = vt.ammesse.map(String);
            psVehicle.set(String(row.id), {
              tipo: String(vt.preferita ?? ammesse[0]),
              forced: ammesse.length === 1,
            });
          }
        }
      } catch { /* feed non materializzato da PS */ }
      const defaultVt = typeof b.defaultVehicleType === "string" && validTypes.has(b.defaultVehicleType)
        ? (b.defaultVehicleType as VehicleType) : null;
      const missing: string[] = [];
      routes = [];
      for (const r of feedRoutes) {
        if (wanted && !wanted.has(r.routeId)) continue;
        const declared = psVehicle.get(r.routeId);
        const mapped = declared && (validTypes.has(declared.tipo)
          ? declared.tipo : AGENT_VEHICLE_FALLBACK[declared.tipo]);
        if (mapped) {
          routes.push({ routeId: r.routeId, vehicleType: mapped as VehicleType,
                        forced: !!declared?.forced });
        } else if (defaultVt) {
          routes.push({ routeId: r.routeId, vehicleType: defaultVt, forced: false });
        } else {
          missing.push(r.shortName || r.longName || r.routeId);
        }
      }
      if (missing.length > 0) {
        res.status(400).json({
          error: "Linee senza tipologia di vettura dichiarata in Planning",
          detail: `Dichiara la tipologia (Ispettore → linea → Tipologia di vettura, o ti_set_route_vehicle) `
            + `oppure passa defaultVehicleType. Linee scoperte: ${missing.slice(0, 30).join(", ")}`
            + (missing.length > 30 ? ` e altre ${missing.length - 30}` : ""),
          missingRoutes: missing.slice(0, 60),
        });
        return;
      }
      if (routes.length === 0) { res.status(400).json({ error: "Nessuna linea nel feed del progetto (routeIds troppo stretti?)" }); return; }
      vehicleSource = defaultVt ? "planning+default" : "planning";
    }

    // Depositi: selezione esplicita, altrimenti tutti quelli del progetto (cap liberi).
    let depotsSel: any[] | null = Array.isArray(b.depots) && b.depots.length > 0 ? b.depots : null;
    if (!depotsSel) {
      const pts = await loadDepotPoints(schedProjectId);
      const ids = Array.isArray(b.depotIds) && b.depotIds.length > 0 ? new Set(b.depotIds.map(String)) : null;
      depotsSel = pts.filter(p => !ids || ids.has(p.id)).map(p => ({ id: p.id }));
    }

    const intensity = ["fast", "normal", "deep", "extreme"].includes(b.intensity) ? b.intensity : "normal";
    const timeLimit = Number.isFinite(Number(b.timeLimit)) && Number(b.timeLimit) > 0
      ? Math.min(1800, Number(b.timeLimit))
      : ({ fast: 60, normal: 180, deep: 420, extreme: 900 } as Record<string, number>)[intensity];
    const serviceType = b.serviceType === "extraurbano" || b.serviceType === "misto" ? b.serviceType : "urbano";

    // Memoria della sonda: le lezioni dei giri precedenti su questo progetto
    // e questa data (b.memoria === false la spegne, per un giro «da zero»).
    const probeMemory = mode === "vcsp" && b.memoria !== false
      ? await loadProbeLessons(psProjectId, rawDate) : { lezioni: [], giri: 0 };
    const runBody: Record<string, any> = {
      date: rawDate, feedId, psProjectId, serviceType, routes,
      timeLimit, solverIntensity: intensity,
      ...(depotsSel && depotsSel.length > 0 ? { depots: depotsSel } : {}),
      ...(schedProjectId ? { projectId: schedProjectId } : {}),
      ...(Array.isArray(b.excludedTripIds) && b.excludedTripIds.length > 0 ? { excludedTripIds: b.excludedTripIds } : {}),
      ...(b.tripVehicleOverrides && typeof b.tripVehicleOverrides === "object" ? { tripVehicleOverrides: b.tripVehicleOverrides } : {}),
      ...(b.vehicleCosts && typeof b.vehicleCosts === "object" ? { vehicleCosts: b.vehicleCosts } : {}),
      ...(b.vspAdvanced && typeof b.vspAdvanced === "object" ? { vspAdvanced: b.vspAdvanced } : {}),
      ...(b.robustness ? { robustness: b.robustness } : {}),
      ...(b.vspNormativa && typeof b.vspNormativa === "object" ? { vspNormativa: b.vspNormativa } : {}),
    };
    if (mode === "vcsp") {
      runBody.vcsp = {
        rounds: b.rounds ?? 3,
        crewTimeLimit: b.crewTimeLimit ?? 90,
        probes: b.probes ?? 4,
        ...(b.probeVspTime ? { probeVspTime: b.probeVspTime } : {}),
        // Sonda: disturbo all'orario (€/corsa·minuto) e portata dei candidati
        // guidati dai turni ("trip" corsa di confine | "line" linea intera).
        ...(Number.isFinite(Number(b.shiftPenaltyEur)) && Number(b.shiftPenaltyEur) >= 0
          ? { shiftPenaltyEur: Number(b.shiftPenaltyEur) } : {}),
        ...(b.crewShiftScope === "line" || b.crewShiftScope === "trip"
          ? { crewShiftScope: b.crewShiftScope } : {}),
        // Pazienza dell'early-stop: arrivava dal connettore e moriva qui — il
        // giro girava con la pazienza di default e il rendiconto non lo diceva.
        ...(b.earlyStopPatience != null && Number.isFinite(Number(b.earlyStopPatience))
          ? { earlyStopPatience: Math.max(1, Math.min(10, Math.round(Number(b.earlyStopPatience)))) } : {}),
        ...(probeMemory.lezioni.length > 0 ? { probeMemory: probeMemory.lezioni } : {}),
        ...(b.controllo === false ? { probeControl: false } : {}),
        ...(Number.isFinite(Number(b.penaltyStep)) && b.penaltyStep != null
          ? { penaltyStep: Math.min(1, Math.max(0.05, Number(b.penaltyStep))) } : {}),
        ...(b.penaltyAnchor === "best" || b.penaltyAnchor === "last"
          ? { penaltyAnchor: b.penaltyAnchor } : {}),
        ...(b.seedFromBest === false ? { seedFromBest: false } : {}),
      };
      // Vincolo RIGIDO autovetture aziendali impostabile dall'agente: senza
      // companyCars nel body il giro ricade sull'impostazione DB (come la UI).
      const companyCars = Number.isFinite(Number(b.companyCars)) && Number(b.companyCars) >= 0
        ? Math.min(50, Math.round(Number(b.companyCars))) : null;
      if ((b.crewConfig && typeof b.crewConfig === "object") || companyCars != null) {
        const cc = (b.crewConfig && typeof b.crewConfig === "object") ? b.crewConfig : {};
        runBody.crewConfig = {
          ...cc,
          bds: { ...(cc.bds ?? {}), serviceType: cc.bds?.serviceType ?? serviceType },
          ...(companyCars != null ? { companyCars } : {}),
        };
      }
    }

    const job: AgentOptimizeJob = {
      id: randomUUID(),
      userId, psProjectId, mode,
      status: "running",
      createdAt: Date.now(),
      progress: { phase: mode === "vcsp" ? "VCSP" : "VSP", pct: 0, msg: "Avvio…" },
      params: {
        date: rawDate, mode, intensity, timeLimit, serviceType,
        routes: routes.length, vehicleSource, feedSource, depots: depotsSel?.length ?? 0,
        ...(udpRefresh ? { udpRefresh } : {}),
        ...(mode === "vcsp" ? {
          rounds: runBody.vcsp.rounds, probes: runBody.vcsp.probes, crewTimeLimit: runBody.vcsp.crewTimeLimit,
          earlyStopPatience: runBody.vcsp.earlyStopPatience ?? null,
          // Quante lezioni (e da quanti giri) la sonda ha letto in partenza:
          // due giri con memoria diversa non partono dalla stessa coda.
          memoria: { lezioni: probeMemory.lezioni.length, giri: probeMemory.giri },
          controllo: b.controllo !== false,
          // Due giri con un feedback diverso non sono confrontabili: il
          // confronto lo deve poter dire.
          penaltyStep: runBody.vcsp.penaltyStep ?? null,
          penaltyAnchor: runBody.vcsp.penaltyAnchor ?? null,
          seedFromBest: b.seedFromBest !== false,
        } : {}),
      },
    };
    agentJobs.set(job.id, job);
    pruneAgentJobs();
    void persistAgentJob(job, req.body);

    // Req/res sintetici: la pipeline del giro è la STESSA della fucina.
    const jobLog = agentJobLogger(job, req.log);
    const fakeReq = { body: runBody, user: req.user, log: jobLog, query: {}, params: {} };
    const runPromise = new Promise<{ code: number; payload: any }>((resolve) => {
      const fakeRes: any = {
        _code: 200,
        status(c: number) { this._code = c; return this; },
        json(p: any) { resolve({ code: this._code, payload: p }); },
      };
      handleVehicleOptimize(fakeReq, fakeRes, mode)
        .catch((err: any) => resolve({ code: 500, payload: { error: err?.message || "errore interno" } }));
    });

    const saveScenario = b.saveScenario !== false;
    const scenarioNameReq = typeof b.scenarioName === "string" && b.scenarioName.trim()
      ? b.scenarioName.trim().slice(0, 120) : null;

    void runPromise.then(async ({ code, payload }) => {
      try {
        if (code !== 200 || payload?.error || payload?.status === "NO_INPUT") {
          job.status = "error";
          job.error = payload?.error
            || (payload?.status === "NO_INPUT"
              ? "Nessuna corsa attiva per la data/linee scelte: controlla la data di esercizio"
              : `Errore HTTP ${code}`);
          return;
        }
        job.result = payload;
        job.progress = { phase: job.progress.phase, pct: 100, msg: "Completato" };
        if (saveScenario) {
          const name = scenarioNameReq
            ?? `Argos · ${psName} · ${rawDate}${mode === "vcsp" ? " · VCSP" : ""}`;
          job.scenarioName = name;
          // Scenario TURNI MACCHINA (il top-level è già il best round / sonda).
          const savedResult = payload.vcsp?.bestRound != null
            ? { ...payload, vcspSelectedRound: payload.vcsp.bestRound }
            : payload;
          const [row] = await db.insert(serviceProgramScenarios).values({
            name,
            date: rawDate.replace(/-/g, ""),
            feedId: feedId || undefined,
            input: {
              date: rawDate, serviceType, routes,
              source: "argos-agent", mode,
              ...(runBody.vcsp ? { vcsp: runBody.vcsp } : {}),
            } as any,
            result: savedResult as any,
          }).returning({ id: serviceProgramScenarios.id });
          job.scenarioId = row.id;
          try {
            await db.execute(sql`UPDATE service_program_scenarios SET owner_user_id = ${userId}::uuid WHERE id = ${row.id}::uuid`);
          } catch { /* colonna assente su DB legacy */ }
          // Dossier di processo: la CONFIGURAZIONE usata (manopole guida, tariffe,
          // parametri VCSP/VSP, tetto auto) resta con lo scenario, così la
          // relazione può dichiarare con quali valori è stato calcolato.
          try {
            const provenance = {
              source: "argos-agent", mode, savedAt: new Date().toISOString(),
              crewConfig: runBody.crewConfig ?? null,
              vcsp: runBody.vcsp ?? null,
              vehicleCosts: runBody.vehicleCosts ?? null,
              vspAdvanced: runBody.vspAdvanced ?? null,
              intensity: runBody.intensity ?? null, robustness: runBody.robustness ?? null,
              serviceType, defaultVehicleType: b.defaultVehicleType ?? null,
              companyCars: runBody.crewConfig?.companyCars ?? null,
            };
            await db.execute(sql`UPDATE service_program_scenarios SET config = ${JSON.stringify(provenance)}::jsonb WHERE id = ${row.id}::uuid`);
          } catch (e: any) {
            jobLog.warn(`agent-optimize: salvataggio configurazione (dossier) fallito (non-fatale): ${e?.message}`);
          }
          if (schedProjectId) {
            try {
              await db.execute(sql`UPDATE service_program_scenarios SET project_id = ${schedProjectId}::uuid WHERE id = ${row.id}::uuid`);
            } catch { /* colonna assente */ }
          }
          if (depotsSel && depotsSel.length > 0) {
            const clean = depotsSel
              .filter((d: any) => d && typeof d.id === "string" && /^[0-9a-f-]{36}$/i.test(d.id))
              .map((d: any) => ({ id: d.id, maxVehicles: Number.isFinite(Number(d.maxVehicles)) && Number(d.maxVehicles) > 0 ? Number(d.maxVehicles) : null }));
            if (clean.length > 0) {
              try {
                await db.execute(sql`UPDATE service_program_scenarios SET depots = ${JSON.stringify(clean)}::jsonb WHERE id = ${row.id}::uuid`);
              } catch { /* non-fatale */ }
            }
          }
          // VCSP: anche i TURNI GUIDA del best round come DSS collegato,
          // così entrambe le aree di lavoro sono pronte (parità con la fucina).
          const v = payload.vcsp;
          if (mode === "vcsp" && Array.isArray(v?.crew?.driverShifts) && v.crew.driverShifts.length > 0) {
            try {
              const [dss] = await db.insert(driverShiftScenarios).values({
                serviceProgramScenarioId: row.id,
                name: `${name} · Turni guida (VCSP round ${v.bestRound ?? "?"})`,
                result: {
                  solver: "vcsp_crew",
                  driverShifts: v.crew.driverShifts,
                  summary: v.crew.summary ?? null,
                  handovers: v.crew.handovers ?? [],
                  clusters: v.crew.clusters ?? [],
                  metrics: v.crew.metrics ?? null,
                } as any,
                config: { source: "argos-agent", bestRound: v.bestRound ?? null, selectedRound: v.bestRound ?? null,
                          crewConfig: runBody.crewConfig ?? null } as any,
              }).returning({ id: driverShiftScenarios.id });
              job.dssId = dss.id;
              try {
                await db.execute(sql`UPDATE driver_shift_scenarios SET owner_user_id = ${userId}::uuid WHERE id = ${dss.id}::uuid`);
              } catch { /* colonna assente */ }
            } catch (e: any) {
              jobLog.warn(`agent-optimize: salvataggio turni guida fallito (non-fatale): ${e?.message}`);
            }
          }
        }
        // I parametri del giro registrano il ciclo VERO, letto dal motore: se
        // restassero quelli della richiesta, un giro lanciato coi default li
        // avrebbe vuoti e il confronto non potrebbe dire che due giri hanno
        // avuto un ciclo diverso.
        const ciclo = (payload as any)?.vcsp?.ciclo;
        if (ciclo && typeof ciclo === "object") {
          job.params = {
            ...job.params,
            penaltyStep: ciclo.passo ?? null,
            penaltyAnchor: ciclo.ancora ?? null,
            seedFromBest: ciclo.seme ?? null,
            earlyStopPatience: ciclo.pazienza ?? (job.params as any)?.earlyStopPatience ?? null,
            controllo: ciclo.controllo ?? null,
          };
        }
        job.status = "done";
      } catch (e: any) {
        job.status = "error";
        job.error = `Giro completato ma salvataggio fallito: ${e?.message}`;
      } finally {
        job.finishedAt = Date.now();
        void persistAgentJob(job);
      }
    });

    res.json({
      jobId: job.id,
      status: "running",
      mode,
      date: rawDate,
      project: psName,
      routes: routes.length,
      vehicleSource,
      feedSource,
      depots: depotsSel?.length ?? 0,
      ...(udpRefresh ? { udpRefresh } : {}),
      ...(mode === "vcsp" ? { rounds: runBody.vcsp.rounds, probes: runBody.vcsp.probes } : {}),
      hint: "Interroga GET /service-program/agent-optimize/{jobId} per progresso e risultato (attendi ~60-90s tra un controllo e l'altro)",
    });
  } catch (err: any) {
    req.log.error(err, "Error in agent-optimize");
    res.status(500).json({ error: err.message || "Errore avvio giro" });
  }
});

/** Stato/risultato di un giro lanciato dall'agente. */
router.get("/service-program/agent-optimize/:jobId", async (req, res) => {
  const job = agentJobs.get(String(req.params.jobId));
  if (!job) {
    const rows = /^[0-9a-f-]{36}$/i.test(String(req.params.jobId)) ? await loadAgentJobRows({ id: String(req.params.jobId) }) : [];
    const row = rows[0];
    if (!row) { res.status(404).json({ error: "Job non trovato (scaduto o mai esistito): rilancia il giro" }); return; }
    if (req.user?.id !== String(row.user_id) && req.user?.role !== "admin") {
      res.status(403).json({ error: "Job di un altro utente" }); return;
    }
    res.json(agentJobRowView(row, true));
    return;
  }
  if (req.user?.id !== job.userId && req.user?.role !== "admin") {
    res.status(403).json({ error: "Job di un altro utente" }); return;
  }
  res.json({
    jobId: job.id,
    status: job.status,
    mode: job.mode,
    progress: job.progress,
    elapsedSec: Math.round(((job.finishedAt ?? Date.now()) - job.createdAt) / 1000),
    params: job.params,
    ...(job.error ? { error: job.error } : {}),
    ...(job.status === "done" ? {
      scenarioId: job.scenarioId ?? null,
      dssId: job.dssId ?? null,
      scenarioName: job.scenarioName ?? null,
      result: compactAgentResult(job.result),
    } : {}),
  });
});

/** Elenco giri dell'utente (recupero jobId persi). */
router.get("/service-program/agent-optimize", async (req, res) => {
  const userId = req.user?.id;
  if (!userId) { res.status(401).json({ error: "Non autenticato" }); return; }
  const isAdmin = req.user?.role === "admin";
  const persistedRows = await loadAgentJobRows({ userId, isAdmin });
  const persisted = persistedRows
    .filter((r) => !agentJobs.has(String(r.id)))
    .map((r) => agentJobRowView(r, false));
  const jobs = Array.from(agentJobs.values())
    .filter(j => isAdmin || j.userId === userId)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 20)
    .map(j => ({
      jobId: j.id, status: j.status, mode: j.mode,
      psProjectId: j.psProjectId, params: j.params,
      createdAt: new Date(j.createdAt).toISOString(),
      scenarioId: j.scenarioId ?? null,
      ...(j.error ? { error: j.error } : {}),
    }));
  res.json({ jobs: [...jobs, ...persisted].slice(0, 20) });
});

/* ═══════════════════════════════════════════════════════════════
 *  SCENARIO SAVE / LOAD / LIST / DELETE
 *  Salva lo scenario turni macchina per riutilizzarlo nei turni guida
 * ═══════════════════════════════════════════════════════════════ */

/** POST /api/service-program/scenarios — save a scenario */
router.post("/service-program/scenarios", async (req, res) => {
  try {
    const { name, date, input, result: scenarioResult, projectId, depotId, depots: depotsSel, config: configReq } = req.body as {
      name?: string; date?: string;
      input?: unknown; result?: unknown;
      projectId?: string; depotId?: string;
      /** Multi-deposito: selezione completa [{id, maxVehicles}] (jsonb additivo) */
      depots?: { id: string; maxVehicles?: number | null }[];
      /** Dossier di processo: configurazione usata (manopole, tariffe, parametri) */
      config?: Record<string, unknown>;
    };
    if (!name || !date || !input || !scenarioResult) {
      res.status(400).json({ error: "Parametri obbligatori: name, date, input, result" });
      return;
    }
    const userId = req.user?.id;
    if (!userId) { res.status(401).json({ error: "Non autenticato" }); return; }
    const feedId = await getLatestFeedId(req);
    const [row] = await db.insert(serviceProgramScenarios).values({
      name,
      date: String(date).replace(/-/g, ""),
      feedId: feedId || undefined,
      input: input as any,
      result: scenarioResult as any,
    }).returning({ id: serviceProgramScenarios.id, createdAt: serviceProgramScenarios.createdAt });
    // Stamp owner per il nuovo modello multi-tenant (colonna additiva)
    try {
      await db.execute(sql`UPDATE service_program_scenarios SET owner_user_id = ${userId}::uuid WHERE id = ${row.id}::uuid`);
    } catch (e: any) {
      req.log.warn({ err: e?.message }, "stamp owner_user_id failed (non-fatal)");
    }
    // Residenza di servizio = deposito scelto (colonna depot_id)
    if (depotId && /^[0-9a-f-]{36}$/i.test(depotId)) {
      try {
        await db.execute(sql`UPDATE service_program_scenarios SET depot_id = ${depotId}::uuid WHERE id = ${row.id}::uuid`);
      } catch (e: any) {
        req.log.warn({ err: e?.message }, "attach depot_id failed (non-fatal)");
      }
    }
    // Multi-deposito: salva l'INSIEME dei depositi selezionati (con cap vetture).
    // Colonna jsonb; depot_id resta per compatibilità (primo deposito).
    if (Array.isArray(depotsSel) && depotsSel.length > 0) {
      const clean = depotsSel
        .filter(d => d && typeof d.id === "string" && /^[0-9a-f-]{36}$/i.test(d.id))
        .map(d => ({ id: d.id, maxVehicles: Number.isFinite(Number(d.maxVehicles)) && Number(d.maxVehicles) > 0 ? Number(d.maxVehicles) : null }));
      if (clean.length > 0) {
        try {
          await db.execute(sql`UPDATE service_program_scenarios SET depots = ${JSON.stringify(clean)}::jsonb WHERE id = ${row.id}::uuid`);
        } catch (e: any) {
          req.log.warn({ err: e?.message }, "attach depots failed (non-fatal)");
        }
      }
    }
    // Aggancia al progetto se passato
    if (projectId && /^[0-9a-f-]{36}$/i.test(projectId)) {
      try {
        await db.execute(sql`UPDATE service_program_scenarios SET project_id = ${projectId}::uuid WHERE id = ${row.id}::uuid`);
      } catch (e: any) {
        req.log.warn({ err: e?.message }, "attach project_id failed (non-fatal)");
      }
    }
    // Dossier di processo: la configurazione con cui è stato calcolato lo scenario
    if (configReq && typeof configReq === "object") {
      try {
        await db.execute(sql`UPDATE service_program_scenarios SET config = ${JSON.stringify({ ...configReq, source: (configReq as any).source ?? "fucina", savedAt: new Date().toISOString() })}::jsonb WHERE id = ${row.id}::uuid`);
      } catch (e: any) {
        req.log.warn({ err: e?.message }, "attach config failed (non-fatal)");
      }
    }
    res.json({ id: row.id, createdAt: row.createdAt });
  } catch (err: any) {
    req.log.error(err, "Error saving scenario");
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/service-program/scenarios — list saved scenarios accessibili */
router.get("/service-program/scenarios", async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) { res.status(401).json({ error: "Non autenticato" }); return; }
    const isAdmin = req.user?.role === "admin";
    const where = vehicleScenariosAccessibleWhere(userId, isAdmin);
    const r = await db.execute(sql`
      SELECT s.id, s.name, s.date, s.created_at AS "createdAt"
        FROM service_program_scenarios s
       WHERE ${where}
       ORDER BY s.created_at DESC
    `);
    const rows: any[] = (r as any).rows ?? (r as any) ?? [];
    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** PUT /api/service-program/scenarios/:id — overwrite an existing scenario (name + result + input) */
router.put("/service-program/scenarios/:id", async (req, res) => {
  try {
    const acc = await requireVehicleScenarioWrite(req, res, req.params.id);
    if (!acc) return;
    // Esercizio CONGELATO: lo scenario operativo è la soluzione ufficiale usata
    // da Quadro d'esercizio, confronti e stampe — non si sovrascrive live.
    // Per modificarlo: togli lo stato "in esercizio", salva, rimettilo.
    if (await isOperationalVehicleScenario(req.params.id)) {
      res.status(409).json({
        error: "Scenario IN ESERCIZIO: non modificabile. Togli prima lo stato operativo dalla lista scenari, poi salva.",
      });
      return;
    }
    const { name, input, result: scenarioResult } = req.body as {
      name?: string; input?: unknown; result?: unknown;
    };
    if (!scenarioResult) {
      res.status(400).json({ error: "Parametro 'result' obbligatorio" });
      return;
    }
    const update: Record<string, unknown> = { result: scenarioResult as any };
    if (name) update.name = name;
    if (input !== undefined) update.input = input as any;
    const [row] = await db.update(serviceProgramScenarios)
      .set(update as any)
      .where(eq(serviceProgramScenarios.id, req.params.id))
      .returning({ id: serviceProgramScenarios.id });
    if (!row) { res.status(404).json({ error: "Scenario non trovato" }); return; }
    // Salvataggio nuovo = contenuto allineato ai dati correnti → azzera il
    // flag "dati superati" impostato dal resync (colonna additiva, best-effort)
    try {
      await db.execute(sql`UPDATE service_program_scenarios SET stale_since = NULL WHERE id = ${req.params.id}::uuid`);
    } catch { /* colonna assente su DB legacy */ }
    res.json({ id: row.id, ok: true });
  } catch (err: any) {
    req.log.error(err, "Error updating scenario");
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/service-program/scenarios/:id — load a single scenario */
router.get("/service-program/scenarios/:id", async (req, res) => {
  try {
    const acc = await requireVehicleScenarioRead(req, res, req.params.id);
    if (!acc) return;
    const [row] = await db.select().from(serviceProgramScenarios)
      .where(eq(serviceProgramScenarios.id, req.params.id));
    if (!row) { res.status(404).json({ error: "Scenario non trovato" }); return; }
    // Colonne additive (fuori dallo schema drizzle): depot_id + depots (multi-deposito)
    let extra: Record<string, unknown> = {};
    try {
      const r = await db.execute<any>(sql`
        SELECT depot_id AS "depotId", depots FROM service_program_scenarios WHERE id = ${req.params.id}::uuid
      `);
      if (r.rows[0]) extra = { depotId: r.rows[0].depotId ?? null, depots: r.rows[0].depots ?? null };
    } catch { /* colonne non ancora presenti su installazioni vecchie */ }
    res.json({ ...row, ...extra });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** DELETE /api/service-program/scenarios/:id — delete a scenario (solo owner/admin) */
router.delete("/service-program/scenarios/:id", async (req, res) => {
  try {
    const acc = await requireVehicleScenarioWrite(req, res, req.params.id);
    if (!acc) return;
    // Only owner (o admin) può cancellare definitivamente
    if (acc.level !== "owner" && acc.level !== "legacy") {
      res.status(403).json({ error: "Solo l'owner può eliminare lo scenario" });
      return;
    }
    // Esercizio CONGELATO: la soluzione ufficiale non si elimina finché è
    // operativa (Quadro d'esercizio, roster e stampe la referenziano).
    if (await isOperationalVehicleScenario(req.params.id)) {
      res.status(409).json({
        error: "Scenario IN ESERCIZIO: non eliminabile. Togli prima lo stato operativo dalla lista scenari.",
      });
      return;
    }
    /* i turni guida figli se ne andrebbero in cascata: se il roster li usa, no */
    const usi = messaggioUsi(await usiNelRoster({ spsId: req.params.id }), "Scenario non eliminabile");
    if (usi) { res.status(409).json({ error: usi }); return; }
    await db.delete(serviceProgramScenarios)
      .where(eq(serviceProgramScenarios.id, req.params.id));
    res.json({ ok: true });
  } catch (err: any) {
    if ((err?.cause?.code ?? err?.code) === "23503") { res.status(409).json({ error: "Scenario non eliminabile: i suoi turni guida sono pubblicati nel roster." }); return; }
    res.status(500).json({ error: err.message });
  }
});

export default router;
