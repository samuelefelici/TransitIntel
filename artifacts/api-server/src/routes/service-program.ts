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
  gtfsCalendar, gtfsCalendarDates, gtfsStops,
  serviceProgramScenarios,
} from "@workspace/db/schema";
import { eq, sql, and, desc } from "drizzle-orm";
import { timeToMinutes, minToTime, haversineKm } from "../lib/geo-utils";
import { getLatestFeedId } from "./gtfs-helpers";
import { spawn } from "node:child_process";
import path from "node:path";

// Scripts dir: go up from api-server (cwd) to workspace root, then into scripts/
const SCRIPTS_DIR = path.resolve(process.cwd(), "..", "..", "scripts");

const router: IRouter = Router();

/* ═══════════════════════════════════════════════════════════════
 *  VEHICLE TYPES & HIERARCHY
 * ═══════════════════════════════════════════════════════════════ */

type VehicleType = "autosnodato" | "12m" | "10m" | "pollicino";
type ServiceCategory = "urbano" | "extraurbano";

const VEHICLE_SIZE: Record<VehicleType, number> = {
  autosnodato: 4, "12m": 3, "10m": 2, pollicino: 1,
};

const VEHICLE_LABELS: Record<VehicleType, string> = {
  autosnodato: "Autosnodato (18m)", "12m": "12 metri", "10m": "10 metri", pollicino: "Pollicino (6m)",
};

const VEHICLE_CAPACITY: Record<VehicleType, number> = {
  autosnodato: 150, "12m": 80, "10m": 60, pollicino: 25,
};

const DEADHEAD_SPEED: Record<ServiceCategory, number> = {
  urbano: 20,
  extraurbano: 40,
};

const MAX_DEADHEAD_KM = 30;
const MAX_IDLE_AT_TERMINAL = 60;
const MIN_LAYOVER = 3;
const DEADHEAD_BUFFER = 5;

/* ═══════════════════════════════════════════════════════════════
 *  VEHICLE DOWNSIZE RULES
 *  Un mezzo più piccolo PUÒ fare una corsa assegnata a uno più grande,
 *  ma solo entro 1 livello di differenza (mai salti estremi).
 *  Obiettivo: ridurre turni macchina, priorità massima.
 *  Nelle ore di morbida il downsize è più accettabile.
 * ═══════════════════════════════════════════════════════════════ */

/** Max livelli di downsize consentiti (1 = un gradino sotto) */
const MAX_DOWNSIZE_LEVELS = 1;

/** Ore di punta — downsize più penalizzato */
function isPeakHour(departureMin: number): boolean {
  const h = Math.floor(departureMin / 60);
  return (h >= 7 && h <= 9) || (h >= 17 && h <= 19);
}

/**
 * Verifica se un veicolo di dimensione `vehicleSize` può servire
 * una corsa che richiede `requiredSize`.
 * - vehicleSize >= requiredSize → sempre OK (mezzo uguale o più grande)
 * - vehicleSize < requiredSize → OK solo se diff ≤ MAX_DOWNSIZE_LEVELS
 */
function canVehicleServeTrip(vehicleSize: number, requiredSize: number): boolean {
  if (vehicleSize >= requiredSize) return true;
  return (requiredSize - vehicleSize) <= MAX_DOWNSIZE_LEVELS;
}

/* ═══════════════════════════════════════════════════════════════
 *  COST MODEL
 *  Due macro-voci separate:
 *    A) VEICOLO — tutti i costi relativi al mezzo (fisso + km)
 *    B) AUTISTA — costo operatore (ore guida)
 *
 *  Nessun ammortamento. Costi reali operativi.
 * ═══════════════════════════════════════════════════════════════ */

/** Costo fisso giornaliero veicolo — assicurazione, manutenzione programmata, bollo.
 *  Si paga per ogni mezzo che esce dal deposito, indipendentemente dai km. */
const COST_VEHICLE_FIXED_DAY: Record<VehicleType, number> = {
  autosnodato: 55,   // €/day
  "12m": 42,
  "10m": 32,
  pollicino: 18,
};

/** Costo variabile veicolo per km IN SERVIZIO — carburante, gomme, usura freni/motore.
 *  Applicato ai km percorsi durante le corse effettive. */
const COST_VEHICLE_PER_SERVICE_KM: Record<VehicleType, number> = {
  autosnodato: 1.20,  // €/km — diesel/CNG alto consumo, gomme pesanti
  "12m": 0.95,
  "10m": 0.75,
  pollicino: 0.45,
};

/** Costo variabile veicolo per km FUORILINEA (trasferimenti a vuoto).
 *  Leggermente inferiore al servizio (no fermate, no aria condiz. piena potenza). */
const COST_VEHICLE_PER_DEADHEAD_KM: Record<VehicleType, number> = {
  autosnodato: 1.00,
  "12m": 0.80,
  "10m": 0.65,
  pollicino: 0.40,
};

/** Velocità media in servizio per stimare km servizio dalle ore servizio */
const AVG_SERVICE_SPEED: Record<ServiceCategory, number> = {
  urbano: 18,       // km/h — molte fermate, traffico
  extraurbano: 32,  // km/h — meno fermate, strade extraurbane
};

/** Costo orario autista — applicato SOLO sulle ore di guida effettive (servizio + trasferimenti) */
const COST_PER_DRIVING_HOUR = 28;

/** Costo logistico per ogni rientro deposito (movimentazione, controlli) */
const COST_PER_DEPOT_RETURN = 15;

/** Costo orario tempo inattivo veicolo (costo opportunità, usura statica) */
const COST_PER_IDLE_HOUR = 5;

function getServiceCategory(routeName: string): ServiceCategory {
  const firstChar = routeName.trim().charAt(0);
  if (/[a-zA-Z]/.test(firstChar)) return "extraurbano";
  return "urbano";
}

/* ═══════════════════════════════════════════════════════════════
 *  ACTIVE SERVICES
 * ═══════════════════════════════════════════════════════════════ */

const DOW_COLS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;

async function getActiveServiceIds(feedId: string, dateYMD: string): Promise<Set<string>> {
  const y = parseInt(dateYMD.slice(0, 4));
  const m = parseInt(dateYMD.slice(4, 6)) - 1;
  const d = parseInt(dateYMD.slice(6, 8));
  const dow = new Date(y, m, d).getDay();
  const dowCol = DOW_COLS[dow];

  const calRows = await db.select({ serviceId: gtfsCalendar.serviceId })
    .from(gtfsCalendar)
    .where(and(
      eq(gtfsCalendar.feedId, feedId),
      sql`${gtfsCalendar.startDate} <= ${dateYMD}`,
      sql`${gtfsCalendar.endDate} >= ${dateYMD}`,
      sql`${sql.raw(`"${dowCol}"`)} = 1`,
    ));

  const active = new Set(calRows.map(r => r.serviceId));

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

  return active;
}

/* ═══════════════════════════════════════════════════════════════
 *  TYPES
 * ═══════════════════════════════════════════════════════════════ */

interface TripBlock {
  tripId: string;
  routeId: string;
  routeName: string;
  headsign: string | null;
  directionId: number;
  departureTime: string;
  arrivalTime: string;
  departureMin: number;
  arrivalMin: number;
  stopCount: number;
  firstStopId: string;
  lastStopId: string;
  firstStopLat: number;
  firstStopLon: number;
  lastStopLat: number;
  lastStopLon: number;
  firstStopName: string;
  lastStopName: string;
  requiredVehicle: VehicleType;
  category: ServiceCategory;
  /** When true, this trip MUST run on the exact requiredVehicle type — no flexibility */
  forced: boolean;
}

interface ShiftTripEntry {
  type: "trip" | "deadhead" | "depot";
  tripId: string;
  routeId: string;
  routeName: string;
  headsign: string | null;
  departureTime: string;
  arrivalTime: string;
  departureMin: number;
  arrivalMin: number;
  deadheadKm?: number;
  deadheadMin?: number;
  // Extra trip data for frontend tooltip
  firstStopName?: string;
  lastStopName?: string;
  stopCount?: number;
  durationMin?: number;
  directionId?: number;
  /** True when trip runs on a smaller vehicle than originally assigned */
  downsized?: boolean;
  /** Original required vehicle type (set when downsized) */
  originalVehicle?: VehicleType;
}

interface VehicleShift {
  vehicleId: string;
  vehicleType: VehicleType;
  category: ServiceCategory;
  trips: ShiftTripEntry[];
  startMin: number;
  endMin: number;
  totalServiceMin: number;
  totalDeadheadMin: number;
  totalDeadheadKm: number;
  depotReturns: number;
  tripCount: number;
  // FIFO fields
  fifoOrder: number;      // refueling priority (lower = refuel first)
  firstOut: number;       // first departure (minutes from midnight)
  lastIn: number;         // last arrival (minutes from midnight)
  shiftDuration: number;  // total shift length in minutes
  downsizedTrips: number; // count of trips running on smaller-than-assigned vehicle
}

/* ═══════════════════════════════════════════════════════════════
 *  ADVISORY ENGINE — Suggestion types
 * ═══════════════════════════════════════════════════════════════ */

type AdvisorySeverity = "info" | "warning" | "critical";
type AdvisoryCategory = "fleet" | "deadhead" | "schedule" | "cost" | "refueling";

interface Advisory {
  id: string;
  severity: AdvisorySeverity;
  category: AdvisoryCategory;
  title: string;
  description: string;
  impact: string;          // e.g. "Risparmio stimato: €120/giorno"
  action: string;          // suggested action
  metric?: number;         // quantitative metric for sorting
}

/* ═══════════════════════════════════════════════════════════════
 *  COST & SCORING
 * ═══════════════════════════════════════════════════════════════ */

interface ScenarioCost {
  /* ── VEICOLO (tutti i costi relativi al mezzo) ── */
  vehicleFixedCost: number;       // costo fisso giornaliero (assicuraz., manutenz. programmata)
  vehicleServiceKmCost: number;   // carburante+gomme+usura per km IN SERVIZIO
  vehicleDeadheadKmCost: number;  // carburante+gomme+usura per km FUORILINEA (vuoto)
  vehicleTotalCost: number;       // somma dei 3 sopra
  /* ── AUTISTA (separato dal veicolo) ── */
  driverCost: number;             // costo operatore — SOLO ore di guida effettive
  /* ── ALTRI ── */
  depotReturnCost: number;        // overhead logistico rientri deposito
  idleCost: number;               // costo opportunità tempo inattivo
  /* ── TOTALI ── */
  totalDailyCost: number;         // somma di tutto
  costPerTrip: number;            // totale / corse
  costPerServiceHour: number;     // totale / ore servizio
  /* ── BREAKDOWN ── */
  byVehicleType: Record<string, {
    count: number; fixedCost: number; serviceKmCost: number; deadheadKmCost: number;
    totalVehicleCost: number; serviceKm: number; deadheadKm: number;
  }>;
  byCategory: Record<string, { vehicles: number; vehicleCost: number; driverCost: number; totalCost: number }>;
}

interface ScenarioScore {
  overall: number;           // 0-100 composite score
  efficiency: number;        // service time / (service + deadhead + idle)
  fleetUtilization: number;  // avg trips per vehicle
  deadheadRatio: number;     // deadhead km / total operational km (lower = better)
  costEfficiency: number;    // normalized cost score (higher = cheaper)
  fifoCompliance: number;    // how well the FIFO schedule works for refueling
  grade: string;             // A+ to F
  gradeColor: string;
}

function calculateCosts(
  shifts: VehicleShift[],
  totalTrips: number,
  totalServiceHours: number,
): ScenarioCost {
  let vehicleFixedCost = 0;
  let vehicleServiceKmCost = 0;
  let vehicleDeadheadKmCost = 0;
  let driverCost = 0;
  let idleCost = 0;

  const byVehicleType: ScenarioCost["byVehicleType"] = {};
  const byCategory: ScenarioCost["byCategory"] = {};

  for (const shift of shifts) {
    const vt = shift.vehicleType;
    const cat = shift.category;

    // ── 1. Costo fisso giornaliero veicolo ──
    const fixedCost = COST_VEHICLE_FIXED_DAY[vt];
    vehicleFixedCost += fixedCost;

    // ── 2. Costo km in servizio (stima km da ore × velocità media) ──
    const serviceKm = (shift.totalServiceMin / 60) * AVG_SERVICE_SPEED[cat];
    const svcKmCost = serviceKm * COST_VEHICLE_PER_SERVICE_KM[vt];
    vehicleServiceKmCost += svcKmCost;

    // ── 3. Costo km fuorilinea (vuoto) ──
    const dhKmCost = shift.totalDeadheadKm * COST_VEHICLE_PER_DEADHEAD_KM[vt];
    vehicleDeadheadKmCost += dhKmCost;

    // ── 4. Costo autista (solo ore guida: servizio + trasferimenti) ──
    const drivingMin = shift.totalServiceMin + shift.totalDeadheadMin;
    const shiftDriverCost = (drivingMin / 60) * COST_PER_DRIVING_HOUR;
    driverCost += shiftDriverCost;

    // ── 5. Costo inattività ──
    const shiftLength = shift.endMin - shift.startMin;
    const idleMin = Math.max(0, shiftLength - shift.totalServiceMin - shift.totalDeadheadMin);
    idleCost += (idleMin / 60) * COST_PER_IDLE_HOUR;

    // ── Breakdown per tipo veicolo ──
    if (!byVehicleType[vt]) {
      byVehicleType[vt] = { count: 0, fixedCost: 0, serviceKmCost: 0, deadheadKmCost: 0,
        totalVehicleCost: 0, serviceKm: 0, deadheadKm: 0 };
    }
    byVehicleType[vt].count++;
    byVehicleType[vt].fixedCost += fixedCost;
    byVehicleType[vt].serviceKmCost += svcKmCost;
    byVehicleType[vt].deadheadKmCost += dhKmCost;
    byVehicleType[vt].totalVehicleCost += fixedCost + svcKmCost + dhKmCost;
    byVehicleType[vt].serviceKm += serviceKm;
    byVehicleType[vt].deadheadKm += shift.totalDeadheadKm;

    // ── Breakdown per categoria ──
    if (!byCategory[cat]) byCategory[cat] = { vehicles: 0, vehicleCost: 0, driverCost: 0, totalCost: 0 };
    byCategory[cat].vehicles++;
    const shiftVehicleCost = fixedCost + svcKmCost + dhKmCost;
    byCategory[cat].vehicleCost += shiftVehicleCost;
    byCategory[cat].driverCost += shiftDriverCost;
    byCategory[cat].totalCost += shiftVehicleCost + shiftDriverCost;
  }

  const depotReturnCost = shifts.reduce((s, v) => s + v.depotReturns, 0) * COST_PER_DEPOT_RETURN;
  const vehicleTotalCost = vehicleFixedCost + vehicleServiceKmCost + vehicleDeadheadKmCost;
  const totalDailyCost = vehicleTotalCost + driverCost + depotReturnCost + idleCost;

  // Arrotonda i breakdown per tipo veicolo
  for (const vt of Object.keys(byVehicleType)) {
    const d = byVehicleType[vt];
    d.fixedCost = +d.fixedCost.toFixed(0);
    d.serviceKmCost = +d.serviceKmCost.toFixed(0);
    d.deadheadKmCost = +d.deadheadKmCost.toFixed(0);
    d.totalVehicleCost = +d.totalVehicleCost.toFixed(0);
    d.serviceKm = +d.serviceKm.toFixed(1);
    d.deadheadKm = +d.deadheadKm.toFixed(1);
  }
  // Arrotonda i breakdown per categoria
  for (const cat of Object.keys(byCategory)) {
    const d = byCategory[cat];
    d.vehicleCost = +d.vehicleCost.toFixed(0);
    d.driverCost = +d.driverCost.toFixed(0);
    d.totalCost = +d.totalCost.toFixed(0);
  }

  return {
    vehicleFixedCost: +vehicleFixedCost.toFixed(0),
    vehicleServiceKmCost: +vehicleServiceKmCost.toFixed(0),
    vehicleDeadheadKmCost: +vehicleDeadheadKmCost.toFixed(0),
    vehicleTotalCost: +vehicleTotalCost.toFixed(0),
    driverCost: +driverCost.toFixed(0),
    depotReturnCost: +depotReturnCost.toFixed(0),
    idleCost: +idleCost.toFixed(0),
    totalDailyCost: +totalDailyCost.toFixed(0),
    costPerTrip: totalTrips > 0 ? +(totalDailyCost / totalTrips).toFixed(2) : 0,
    costPerServiceHour: totalServiceHours > 0 ? +(totalDailyCost / totalServiceHours).toFixed(2) : 0,
    byVehicleType,
    byCategory,
  };
}

function calculateScore(
  shifts: VehicleShift[],
  totalTrips: number,
  totalServiceMin: number,
  totalDeadheadMin: number,
  totalDeadheadKm: number,
  costs: ScenarioCost,
): ScenarioScore {
  if (shifts.length === 0) {
    return { overall: 0, efficiency: 0, fleetUtilization: 0, deadheadRatio: 0,
      costEfficiency: 0, fifoCompliance: 0, grade: "N/A", gradeColor: "#6b7280" };
  }

  // 1. Efficiency: service time vs total occupied time
  const totalOccupied = shifts.reduce((s, v) => s + (v.endMin - v.startMin), 0);
  const efficiency = totalOccupied > 0
    ? Math.min(100, (totalServiceMin / totalOccupied) * 100)
    : 0;

  // 2. Fleet utilization: avg trips per vehicle
  const avgTrips = totalTrips / shifts.length;
  const fleetUtilization = Math.min(100, (avgTrips / 20) * 100); // 20 trips/vehicle = 100%

  // 3. Deadhead ratio (lower is better → invert for score)
  // Estimate total service km from service hours × avg speed
  const avgServiceSpeed = 25; // km/h blended
  const estServiceKm = (totalServiceMin / 60) * avgServiceSpeed;
  const deadheadRatio = estServiceKm > 0
    ? Math.min(100, (totalDeadheadKm / (estServiceKm + totalDeadheadKm)) * 100)
    : 0;
  const deadheadScore = Math.max(0, 100 - deadheadRatio * 5); // 20% dh → score 0

  // 4. Cost efficiency: benchmarked against €50/trip (bad) vs €10/trip (excellent)
  const costPerTrip = costs.costPerTrip;
  const costEfficiency = Math.max(0, Math.min(100, ((50 - costPerTrip) / 40) * 100));

  // 5. FIFO compliance: check that first-out vehicles return first
  let fifoScore = 100;
  const byCat = new Map<string, VehicleShift[]>();
  for (const s of shifts) {
    if (!byCat.has(s.category)) byCat.set(s.category, []);
    byCat.get(s.category)!.push(s);
  }
  for (const [, catShifts] of byCat) {
    const byFirstOut = [...catShifts].sort((a, b) => a.firstOut - b.firstOut);
    const byLastIn = [...catShifts].sort((a, b) => a.lastIn - b.lastIn);
    let inversions = 0;
    for (let i = 0; i < byFirstOut.length; i++) {
      const foIdx = byLastIn.findIndex(s => s.vehicleId === byFirstOut[i].vehicleId);
      if (foIdx > i) inversions++;
    }
    const maxInversions = catShifts.length;
    fifoScore = Math.min(fifoScore,
      maxInversions > 0 ? Math.max(0, 100 - (inversions / maxInversions) * 100) : 100);
  }

  // Composite: weighted average
  const overall = +(
    efficiency * 0.30 +
    fleetUtilization * 0.20 +
    deadheadScore * 0.20 +
    costEfficiency * 0.20 +
    fifoScore * 0.10
  ).toFixed(1);

  const grade = overall >= 90 ? "A+" : overall >= 80 ? "A" : overall >= 70 ? "B" :
    overall >= 60 ? "C" : overall >= 50 ? "D" : "F";
  const gradeColor = overall >= 80 ? "#22c55e" : overall >= 60 ? "#f59e0b" : "#ef4444";

  return {
    overall,
    efficiency: +efficiency.toFixed(1),
    fleetUtilization: +fleetUtilization.toFixed(1),
    deadheadRatio: +deadheadRatio.toFixed(1),
    costEfficiency: +costEfficiency.toFixed(1),
    fifoCompliance: +fifoScore.toFixed(1),
    grade,
    gradeColor,
  };
}

/* ═══════════════════════════════════════════════════════════════
 *  ADVISORY ENGINE — generates smart suggestions
 * ═══════════════════════════════════════════════════════════════ */

function generateAdvisories(
  shifts: VehicleShift[],
  tripBlocks: TripBlock[],
  costs: ScenarioCost,
  score: ScenarioScore,
  hourlyDist: { hour: number; trips: number }[],
): Advisory[] {
  const advisories: Advisory[] = [];
  let id = 0;

  // ──── 1. UNDERUTILIZED VEHICLES ────
  const underutilized = shifts.filter(s => s.tripCount <= 3 && s.shiftDuration > 120);
  if (underutilized.length > 0) {
    const saveable = underutilized.length;
    const potentialSaving = underutilized.reduce((s, v) => s + COST_VEHICLE_FIXED_DAY[v.vehicleType], 0);
    advisories.push({
      id: `adv-${++id}`,
      severity: saveable >= 3 ? "critical" : "warning",
      category: "fleet",
      title: `${saveable} veicoli sottoutilizzati`,
      description: `${saveable} veicoli effettuano ≤3 corse in turni di oltre 2 ore. Veicoli: ${underutilized.map(s => s.vehicleId).join(", ")}.`,
      impact: `Risparmio potenziale: €${potentialSaving}/giorno se consolidati`,
      action: "Considerare di ridistribuire le corse su meno veicoli o ridurre la flotta. Analizzare se le corse possono essere coperte da veicoli esistenti con gap disponibili.",
      metric: potentialSaving,
    });
  }

  // ──── 2. OVERSIZED VEHICLES ────
  for (const shift of shifts) {
    const tripRoutes = new Set(shift.trips.filter(t => t.type === "trip").map(t => t.routeId));
    if (tripRoutes.size === 1) {
      const rId = [...tripRoutes][0];
      const rTrips = tripBlocks.filter(t => t.routeId === rId);
      // If all trips on this route could use a smaller vehicle
      const currentSize = VEHICLE_SIZE[shift.vehicleType];
      if (currentSize >= 3) { // 12m or autosnodato
        const smallerType: VehicleType = currentSize === 4 ? "12m" : "10m";
        const saving = COST_VEHICLE_FIXED_DAY[shift.vehicleType] - COST_VEHICLE_FIXED_DAY[smallerType];
        if (saving > 5 && rTrips.length <= 15) {
          advisories.push({
            id: `adv-${++id}`,
            severity: "info",
            category: "fleet",
            title: `${shift.vehicleId}: possibile downsizing`,
            description: `Il veicolo ${shift.vehicleId} (${VEHICLE_LABELS[shift.vehicleType]}) serve solo la linea ${rTrips[0]?.routeName} con ${shift.tripCount} corse. Un ${VEHICLE_LABELS[smallerType]} potrebbe bastare.`,
            impact: `Risparmio: €${saving}/giorno`,
            action: `Valutare il carico passeggeri della linea ${rTrips[0]?.routeName}. Se il picco è sotto ${VEHICLE_CAPACITY[smallerType]} pax, usare un ${VEHICLE_LABELS[smallerType]}.`,
            metric: saving,
          });
        }
      }
    }
  }

  // ──── 3. EXCESSIVE DEADHEAD ────
  const highDeadhead = shifts.filter(s => s.totalDeadheadKm > 15);
  if (highDeadhead.length > 0) {
    const totalExcessKm = highDeadhead.reduce((s, v) => s + v.totalDeadheadKm, 0);
    const excessCost = highDeadhead.reduce((s, v) =>
      s + v.totalDeadheadKm * COST_VEHICLE_PER_DEADHEAD_KM[v.vehicleType], 0);
    advisories.push({
      id: `adv-${++id}`,
      severity: totalExcessKm > 100 ? "critical" : "warning",
      category: "deadhead",
      title: `${highDeadhead.length} veicoli con km vuoto elevato`,
      description: `I veicoli ${highDeadhead.map(s => `${s.vehicleId} (${s.totalDeadheadKm.toFixed(0)}km)`).join(", ")} hanno spostamenti a vuoto significativi.`,
      impact: `Costo vuoto: €${excessCost.toFixed(0)}/giorno`,
      action: "Riorganizzare l'assegnazione delle corse per minimizzare gli spostamenti tra capolinea diversi. Considerare di raggruppare linee con terminali comuni sullo stesso veicolo.",
      metric: excessCost,
    });
  }

  // ──── 4. DEPOT RETURNS ────
  const totalReturns = shifts.reduce((s, v) => s + v.depotReturns, 0);
  if (totalReturns > 5) {
    const returnCost = totalReturns * COST_PER_DEPOT_RETURN;
    advisories.push({
      id: `adv-${++id}`,
      severity: totalReturns > 15 ? "warning" : "info",
      category: "schedule",
      title: `${totalReturns} rientri deposito nel giorno`,
      description: "Molti veicoli rientrano al deposito per gap lunghi tra corse. Questo indica frammentazione del servizio.",
      impact: `Costo overhead: €${returnCost}/giorno + usura aggiuntiva`,
      action: "Valutare se le corse possono essere ridistribuite per coprire i gap. In alternativa, considerare sosta al capolinea per gap di 60-90 minuti invece del rientro.",
      metric: returnCost,
    });
  }

  // ──── 5. PEAK HOUR COVERAGE ────
  const peakHours = hourlyDist.filter(h => h.trips > 0);
  if (peakHours.length > 0) {
    const maxTrips = Math.max(...peakHours.map(h => h.trips));
    const peakHour = peakHours.find(h => h.trips === maxTrips)!;
    const offPeakTrips = peakHours.filter(h => h.trips > 0 && h.trips < maxTrips * 0.3);
    if (offPeakTrips.length > 3) {
      advisories.push({
        id: `adv-${++id}`,
        severity: "info",
        category: "schedule",
        title: "Distribuzione oraria sbilanciata",
        description: `Picco alle ${peakHour.hour}:00 con ${peakHour.trips} corse, ma ${offPeakTrips.length} ore con meno del 30% del picco. Il servizio è molto concentrato.`,
        impact: "Veicoli necessari determinati dal picco, sottoutilizzati nelle ore di morbida",
        action: "Considerare di distribuire alcune corse di punta nelle fasce orarie meno coperte per livellare il carico e ridurre il numero di veicoli necessari al picco.",
        metric: offPeakTrips.length,
      });
    }
  }

  // ──── 6. FIFO REFUELING ISSUES ────
  if (score.fifoCompliance < 70) {
    advisories.push({
      id: `adv-${++id}`,
      severity: "warning",
      category: "refueling",
      title: "Rotazione FIFO non ottimale",
      description: `La compliance FIFO è al ${score.fifoCompliance}%. I veicoli che escono per primi non rientrano per primi, complicando il rifornimento/ricarica.`,
      impact: "Tempi di sosta al deposito più lunghi, rischio di veicoli non riforniti",
      action: "Riorganizzare i turni in modo che i primi veicoli a uscire siano anche i primi a rientrare, facilitando la rotazione FIFO al rifornimento.",
      metric: 100 - score.fifoCompliance,
    });
  }

  // ──── 7. LONG SHIFTS ────
  const longShifts = shifts.filter(s => s.shiftDuration > 14 * 60);
  if (longShifts.length > 0) {
    advisories.push({
      id: `adv-${++id}`,
      severity: "warning",
      category: "schedule",
      title: `${longShifts.length} turni oltre 14 ore`,
      description: `I veicoli ${longShifts.map(s => s.vehicleId).join(", ")} hanno turni molto lunghi (>${14}h). Questo incide sull'usura e richiede doppio turno autista.`,
      impact: "Costo doppio turno autista + usura veicolo accelerata",
      action: "Spezzare i turni lunghi in due mezzi-turni con cambio autista, oppure redistribuire le corse serali/mattutine su altri veicoli.",
      metric: longShifts.length,
    });
  }

  // ──── 8. COST PER TRIP TOO HIGH ────
  if (costs.costPerTrip > 30) {
    advisories.push({
      id: `adv-${++id}`,
      severity: costs.costPerTrip > 50 ? "critical" : "warning",
      category: "cost",
      title: `Costo per corsa elevato: €${costs.costPerTrip.toFixed(2)}`,
      description: "Il costo medio per corsa è superiore alla soglia ottimale (€15-25). Indica eccesso di veicoli rispetto al servizio offerto.",
      impact: `Con un target di €20/corsa, sprechi €${((costs.costPerTrip - 20) * shifts.reduce((s, v) => s + v.tripCount, 0)).toFixed(0)}/giorno`,
      action: "Aumentare la saturazione dei turni: consolidare corse su meno veicoli, ridurre i gap e gli spostamenti a vuoto.",
      metric: costs.costPerTrip,
    });
  }

  // ──── 9. URBAN/SUBURBAN IMBALANCE ────
  const urbanShifts = shifts.filter(s => s.category === "urbano");
  const subShifts = shifts.filter(s => s.category === "extraurbano");
  if (urbanShifts.length > 0 && subShifts.length > 0) {
    const urbanTripsPerVeh = urbanShifts.reduce((s, v) => s + v.tripCount, 0) / urbanShifts.length;
    const subTripsPerVeh = subShifts.reduce((s, v) => s + v.tripCount, 0) / subShifts.length;
    if (urbanTripsPerVeh > subTripsPerVeh * 2.5) {
      advisories.push({
        id: `adv-${++id}`,
        severity: "info",
        category: "fleet",
        title: "Forte squilibrio urbano/extraurbano",
        description: `I veicoli urbani fanno ~${urbanTripsPerVeh.toFixed(0)} corse/veicolo, gli extraurbani solo ~${subTripsPerVeh.toFixed(0)}. La flotta extraurbana è molto meno satura.`,
        impact: "Sottoutilizzo della flotta extraurbana",
        action: "Valutare se alcune corse extraurbane possono essere consolidate. Per le tratte con bassa domanda, considerare veicoli più piccoli (pollicino).",
        metric: urbanTripsPerVeh - subTripsPerVeh,
      });
    }
  }

  // ──── 10. DOWNSIZED TRIPS (vehicle flexibility) ────
  const totalDownsized = shifts.reduce((s, v) => s + v.downsizedTrips, 0);
  const totalTripsCount = shifts.reduce((s, v) => s + v.tripCount, 0);
  if (totalDownsized > 0) {
    const pct = totalTripsCount > 0 ? ((totalDownsized / totalTripsCount) * 100).toFixed(0) : "0";
    const shiftsWithDownsize = shifts.filter(s => s.downsizedTrips > 0);
    advisories.push({
      id: `adv-${++id}`,
      severity: +pct > 30 ? "warning" : "info",
      category: "fleet",
      title: `${totalDownsized} corse su mezzo più piccolo (${pct}%)`,
      description: `Per ridurre i turni macchina, ${totalDownsized} corse girano su un veicolo più piccolo di quello assegnato. ` +
        `Veicoli coinvolti: ${shiftsWithDownsize.map(s => s.vehicleId).slice(0, 8).join(", ")}${shiftsWithDownsize.length > 8 ? "…" : ""}.`,
      impact: `Riduzione turni macchina — meno veicoli in circolazione`,
      action: +pct > 20
        ? "Verificare che la capienza sia sufficiente nelle ore di punta. Considerare di ridimensionare l'assegnazione veicoli per queste linee."
        : "Il livello di flessibilità è accettabile. Le corse in ora di morbida su mezzo più piccolo non impattano il servizio.",
      metric: totalDownsized,
    });
  }

  // Sort by severity then metric
  const sevOrder: Record<AdvisorySeverity, number> = { critical: 0, warning: 1, info: 2 };
  advisories.sort((a, b) => {
    const sd = sevOrder[a.severity] - sevOrder[b.severity];
    if (sd !== 0) return sd;
    return (b.metric || 0) - (a.metric || 0);
  });

  return advisories;
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

    for (let i = 0; i < shifts.length; i++) {
      const shift = shifts[i];
      const shiftSize = VEHICLE_SIZE[shift.vehicleType];

      // ── Vehicle compatibility ──
      if (trip.forced) {
        // Forced: only exact match allowed
        if (shift.vehicleType !== trip.requiredVehicle) continue;
      } else {
        // Flexible: allow downsize within limits
        if (!canVehicleServeTrip(shiftSize, reqSize)) continue;
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
        downsized: isDownsized || undefined,
        originalVehicle: isDownsized ? trip.requiredVehicle : undefined,
      });
      if (isDownsized) shift.downsizedTrips++;
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

router.get("/service-program/routes", async (_req, res) => {
  try {
    const feedId = await getLatestFeedId();
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

router.get("/service-program/dates", async (_req, res) => {
  try {
    const feedId = await getLatestFeedId();
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
    const feedId = await getLatestFeedId();
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
    const allTrips = await db.select({
      tripId: gtfsTrips.tripId,
      routeId: gtfsTrips.routeId,
      serviceId: gtfsTrips.serviceId,
      headsign: gtfsTrips.tripHeadsign,
      directionId: gtfsTrips.directionId,
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
      };
    }).sort((a, b) => a.departureTime.localeCompare(b.departureTime));

    res.json({ trips });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/* ═══════════════════════════════════════════════════════════════
 *  POST /api/service-program — Run optimizer
 * ═══════════════════════════════════════════════════════════════ */

router.post("/service-program", async (req, res) => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.status(404).json({ error: "Nessun feed GTFS caricato" }); return; }

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
    const allTrips = await db.select({
      tripId: gtfsTrips.tripId,
      routeId: gtfsTrips.routeId,
      serviceId: gtfsTrips.serviceId,
      headsign: gtfsTrips.tripHeadsign,
      directionId: gtfsTrips.directionId,
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

    // 7. Run separately for urban and suburban — pass clusterMap
    const urbanResult = buildServiceProgram(tripBlocks, routeVehicleMap, "urbano", 0, clusterMap);
    const suburbanResult = buildServiceProgram(tripBlocks, routeVehicleMap, "extraurbano", urbanResult.shifts.length, clusterMap);

    const allShifts = [...urbanResult.shifts, ...suburbanResult.shifts];
    const allUnassigned = [...urbanResult.unassigned, ...suburbanResult.unassigned];

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

    // 9. Calculate costs & score
    const costs = calculateCosts(allShifts, tripBlocks.length, totalServiceHours);
    const score = calculateScore(allShifts, tripBlocks.length, totalServiceMin, totalDeadheadMin, totalDeadheadKm, costs);

    // 10. Generate advisories
    const advisories = generateAdvisories(allShifts, tripBlocks, costs, score, hourlyDist);

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

async function runCPSATVehicleScheduler(
  tripBlocks: TripBlock[],
  timeLimitSec: number,
  logger: { info: (...a: any[]) => void; error: (...a: any[]) => void },
  extraConfig?: Record<string, any>,
  routeDetails?: { routeId: string; routeName: string }[],
): Promise<any> {
  const scriptPath = path.resolve(SCRIPTS_DIR, "vehicle_scheduler_cpsat.py");

  const pyTrips = tripBlocks.map(t => ({
    tripId: t.tripId,
    routeId: t.routeId,
    routeName: t.routeName,
    headsign: t.headsign,
    directionId: t.directionId,
    departureTime: t.departureTime,
    arrivalTime: t.arrivalTime,
    departureMin: t.departureMin,
    arrivalMin: t.arrivalMin,
    firstStopId: t.firstStopId,
    lastStopId: t.lastStopId,
    firstStopLat: t.firstStopLat,
    firstStopLon: t.firstStopLon,
    lastStopLat: t.lastStopLat,
    lastStopLon: t.lastStopLon,
    firstStopName: t.firstStopName,
    lastStopName: t.lastStopName,
    stopCount: t.stopCount,
    requiredVehicle: t.requiredVehicle,
    category: t.category,
    forced: t.forced,
  }));

  const result = await new Promise<string>((resolve, reject) => {
    const py = spawn("python3", [scriptPath, String(timeLimitSec)], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    let stdout = "";
    let stderr = "";

    py.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    py.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
      logger.info(`VSP stderr: ${d.toString().trim()}`);
    });

    py.on("error", (err) => reject(new Error(`Errore avvio Python: ${err.message}`)));

    py.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Python exit code ${code}: ${stderr}`));
      } else {
        resolve(stdout);
      }
    });

    // Guard against EPIPE: if Python dies before we finish writing, catch the error
    py.stdin.on("error", (err) => {
      logger.error(`VSP stdin error: ${err.message}`);
    });

    const inputJson = JSON.stringify({
      trips: pyTrips,
      config: {
        timeLimit: timeLimitSec,
        ...extraConfig,
      },
      routeDetails: routeDetails || [],
    });
    py.stdin.write(inputJson);
    py.stdin.end();
  });

  return JSON.parse(result);
}

router.post("/service-program/cpsat", async (req, res) => {
  try {
    const feedId = await getLatestFeedId();
    if (!feedId) { res.status(404).json({ error: "Nessun feed GTFS caricato" }); return; }

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
    const timeLimitSec = body.timeLimit ?? 60;

    // 1. Active services
    const activeServices = await getActiveServiceIds(feedId, dateYMD);
    if (activeServices.size === 0) {
      res.json({ status: "NO_INPUT", vehicleShifts: [], metrics: {} });
      return;
    }

    // 2. Load trips (same as greedy endpoint)
    const allTrips = await db.select({
      tripId: gtfsTrips.tripId,
      routeId: gtfsTrips.routeId,
      serviceId: gtfsTrips.serviceId,
      headsign: gtfsTrips.tripHeadsign,
      directionId: gtfsTrips.directionId,
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
      });
    }

    req.log.info(`CP-SAT VSP: ${tripBlocks.length} trips, timeLimit=${timeLimitSec}s`);

    // Build route details for Python
    const routeDetailsForPy = Array.from(selectedRouteIds).map(rid => ({
      routeId: rid,
      routeName: routeNameMap.get(rid) || rid,
    }));

    // 6. Spawn Python solver
    const cpResult = await runCPSATVehicleScheduler(
      tripBlocks, timeLimitSec, req.log,
      {
        vehicleCosts: body.vehicleCosts || {},
        solverIntensity: body.solverIntensity || "normal",
        // Parametri avanzati VSP (regola #1 + override costi dalla UI)
        ...(body.vspAdvanced ? { vspAdvanced: body.vspAdvanced } : {}),
      },
      routeDetailsForPy,
    );

    // 7. Compute costs & score from CP-SAT shifts (reuse existing functions)
    const cpShifts: VehicleShift[] = cpResult.vehicleShifts || [];

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
      solver: "cpsat",
      shifts: cpShifts,
      unassigned: [],
      routeStats,
      hourlyDist,
      summary,
      costs,
      score,
      advisories,
      solverMetrics: cpResult.metrics,
      costBreakdown: cpResult.costBreakdown || null,
      greedyComparison: cpResult.greedyComparison || null,
    });
  } catch (err: any) {
    req.log.error(err, "Error in CP-SAT service-program");
    res.status(500).json({ error: err.message || "Errore nel solver CP-SAT" });
  }
});

/* ═══════════════════════════════════════════════════════════════
 *  SCENARIO SAVE / LOAD / LIST / DELETE
 *  Salva lo scenario turni macchina per riutilizzarlo nei turni guida
 * ═══════════════════════════════════════════════════════════════ */

/** POST /api/service-program/scenarios — save a scenario */
router.post("/service-program/scenarios", async (req, res) => {
  try {
    const { name, date, input, result: scenarioResult } = req.body as {
      name?: string; date?: string;
      input?: unknown; result?: unknown;
    };
    if (!name || !date || !input || !scenarioResult) {
      res.status(400).json({ error: "Parametri obbligatori: name, date, input, result" });
      return;
    }
    const feedId = await getLatestFeedId();
    const [row] = await db.insert(serviceProgramScenarios).values({
      name,
      date: String(date).replace(/-/g, ""),
      feedId: feedId || undefined,
      input: input as any,
      result: scenarioResult as any,
    }).returning({ id: serviceProgramScenarios.id, createdAt: serviceProgramScenarios.createdAt });
    res.json({ id: row.id, createdAt: row.createdAt });
  } catch (err: any) {
    req.log.error(err, "Error saving scenario");
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/service-program/scenarios — list saved scenarios */
router.get("/service-program/scenarios", async (_req, res) => {
  try {
    const rows = await db.select({
      id: serviceProgramScenarios.id,
      name: serviceProgramScenarios.name,
      date: serviceProgramScenarios.date,
      createdAt: serviceProgramScenarios.createdAt,
    }).from(serviceProgramScenarios)
      .orderBy(desc(serviceProgramScenarios.createdAt));

    // Add summary info from the stored result
    const scenarios = rows.map(r => ({
      ...r,
    }));

    res.json(scenarios);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** PUT /api/service-program/scenarios/:id — overwrite an existing scenario (name + result + input) */
router.put("/service-program/scenarios/:id", async (req, res) => {
  try {
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
    res.json({ id: row.id, ok: true });
  } catch (err: any) {
    req.log.error(err, "Error updating scenario");
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/service-program/scenarios/:id — load a single scenario */
router.get("/service-program/scenarios/:id", async (req, res) => {
  try {
    const [row] = await db.select().from(serviceProgramScenarios)
      .where(eq(serviceProgramScenarios.id, req.params.id));
    if (!row) { res.status(404).json({ error: "Scenario non trovato" }); return; }
    res.json(row);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** DELETE /api/service-program/scenarios/:id — delete a scenario */
router.delete("/service-program/scenarios/:id", async (req, res) => {
  try {
    await db.delete(serviceProgramScenarios)
      .where(eq(serviceProgramScenarios.id, req.params.id));
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
