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
  serviceProgramScenarios, driverShiftScenarios, depots,
} from "@workspace/db/schema";
import { randomUUID } from "node:crypto";
import { eq, sql, and, desc } from "drizzle-orm";
import { timeToMinutes, minToTime, haversineKm } from "../lib/geo-utils";
import { buildDeadheadKmMatrix, dhKey, type DHNode } from "../lib/deadhead-matrix";
import {
  enrichTripsWithClusterStops, loadClustersForPython, loadCompanyCars, loadRestPointsForScenario,
} from "./driver-shifts";
import { getLatestFeedId } from "./gtfs-helpers";
import { spawn } from "node:child_process";
import path from "node:path";
import { SCRIPTS_DIR } from "../lib/scripts-dir";
import {
  vehicleScenariosAccessibleWhere,
  requireVehicleScenarioRead,
  requireVehicleScenarioWrite,
} from "../lib/scenario-access";
import { startSyncJob } from "../lib/planning-studio-materialize";

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
async function ensureVariantCodeColumn(): Promise<void> {
  if (variantColReady) return;
  try {
    await db.execute(sql`ALTER TABLE gtfs_trips ADD COLUMN IF NOT EXISTS variant_code text`);
  } catch { /* la SELECT fallirebbe comunque con errore chiaro */ }
  variantColReady = true;
}

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
  /** codice percorso (ps_route_variants.code): relazione corsa→percorso→linea */
  variantCode?: string | null;
  /** When true, this trip MUST run on the exact requiredVehicle type — no flexibility */
  forced: boolean;
  /** Corsa A CHIAMATA (DRT): identificabile lungo tutta la pipeline TM/TG */
  onDemand: boolean;
  /** Tolleranza di spostamento ±minuti DICHIARATA IN PIANIFICAZIONE (cervello
   * Pianificazione↔TM↔TG): l'ottimizzatore integrato può proporre traslazioni
   * entro questa finestra. 0/assente = corsa inchiodata. */
  flexMin?: number;
}

interface ShiftTripEntry {
  type: "trip" | "deadhead" | "depot";
  tripId: string;
  routeId: string;
  routeName: string;
  /** codice percorso (relazione corsa→percorso→linea) */
  variantCode?: string | null;
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
  /** Corsa A CHIAMATA (su prenotazione) */
  onDemand?: boolean;
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
  // Residenza di servizio (deposito) — assegnata geometricamente: uscita = deposito
  // più vicino alla prima fermata, rientro = più vicino all'ultima. Per il roster.
  depotOut?: { id: string; name: string; color: string } | null;
  depotIn?: { id: string; name: string; color: string } | null;
  residenzaDepotId?: string | null;
  residenzaName?: string | null;
  residenzaColor?: string | null;
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
        onDemand: trip.onDemand || undefined,
        variantCode: trip.variantCode ?? undefined,
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
function buildPyTrips(tripBlocks: TripBlock[]) {
  return tripBlocks.map(t => ({
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
    variantCode: t.variantCode ?? undefined,
    category: t.category,
    forced: t.forced,
    onDemand: t.onDemand,
    // finestra di flessibilità dichiarata in Planning: la sonda di spostamento
    // del VCSP (cervello P↔TM↔TG) la userà per proporre traslazioni ±flexMin
    flexMin: t.flexMin ?? 0,
  }));
}

/** Spawn generico di uno script Python (JSON stdin → JSON stdout). */
function spawnPythonJson(
  scriptName: string,
  argv: string[],
  input: unknown,
  logger: { info: (...a: any[]) => void; error: (...a: any[]) => void },
  label: string,
): Promise<any> {
  const scriptPath = path.resolve(SCRIPTS_DIR, scriptName);
  return new Promise((resolve, reject) => {
    const py = spawn("python3", [scriptPath, ...argv], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    let stdout = "";
    let stderr = "";

    py.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    py.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
      logger.info(`${label} stderr: ${d.toString().trim()}`);
    });

    py.on("error", (err) => reject(new Error(`Errore avvio Python: ${err.message}`)));

    py.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Python exit code ${code}: ${stderr.slice(-1500)}`));
        return;
      }
      try { resolve(JSON.parse(stdout)); }
      catch (e: any) { reject(new Error(`parse ${label}: ${e.message}`)); }
    });

    // Guard against EPIPE: if Python dies before we finish writing, catch the error
    py.stdin.on("error", (err) => {
      logger.error(`${label} stdin error: ${err.message}`);
    });

    py.stdin.write(JSON.stringify(input));
    py.stdin.end();
  });
}

async function runCPSATVehicleScheduler(
  tripBlocks: TripBlock[],
  timeLimitSec: number,
  logger: { info: (...a: any[]) => void; error: (...a: any[]) => void },
  extraConfig?: Record<string, any>,
  routeDetails?: { routeId: string; routeName: string }[],
  psClusters?: { id: string; name: string; kind: string; stopIds: string[] }[],
  depotsForPy?: { id: string; name: string; color: string; lat: number; lon: number; maxVehicles: number | null; fleet?: Record<string, number> }[],
  deadheadKm?: Record<string, number>,
  deadheadMin?: Record<string, number>,
): Promise<any> {
  return spawnPythonJson("vehicle_scheduler_cpsat.py", [String(timeLimitSec)], {
    trips: buildPyTrips(tripBlocks),
    config: {
      timeLimit: timeLimitSec,
      ...extraConfig,
    },
    routeDetails: routeDetails || [],
    psClusters: psClusters || [],
    // Multi-deposito: domiciliazione + cap vetture per deposito (vincolo hard)
    ...(depotsForPy && depotsForPy.length > 0 ? { depots: depotsForPy } : {}),
    // Matrice fuorilinea (km stradali reali, OSRM/fallback) per archi e tratte deposito
    ...(deadheadKm && Object.keys(deadheadKm).length > 0 ? { deadheadKm } : {}),
    // Override tempi curati a mano (Archi Fuorilinea, custom_min)
    ...(deadheadMin && Object.keys(deadheadMin).length > 0 ? { deadheadMin } : {}),
  }, logger, "VSP");
}

/** Orchestratore VCSP (loop VSP→CSP→costi-ombra→re-VSP in un unico processo). */
async function runVcspOrchestrator(
  logger: { info: (...a: any[]) => void; error: (...a: any[]) => void },
  input: unknown,
): Promise<any> {
  return spawnPythonJson("vcsp_orchestrator.py", [], input, logger, "VCSP");
}

type DepotPoint = { id: string; name: string; color: string; lat: number; lon: number };

/** Depositi candidati per il solving. Scope PS14: i depositi legati a un
 * progetto Planner Studio valgono SOLO per i giri di quel progetto — senza
 * filtro, un run senza selezione esplicita pescherebbe i depositi
 * sperimentali di altri progetti come residenze candidate. */
async function loadDepotPoints(schedProjectId?: string | null): Promise<DepotPoint[]> {
  try {
    const rows = await db.select().from(depots);
    const scope = new Map<string, string | null>();
    try {
      const r = await db.execute<any>(sql`SELECT id, ps_project_id FROM depots`);
      for (const x of (r as any).rows ?? []) scope.set(x.id, x.ps_project_id ?? null);
    } catch { /* colonna assente su DB legacy: tutti globali */ }
    let psProj: string | null = null;
    if (schedProjectId && /^[0-9a-f-]{36}$/i.test(schedProjectId)) {
      try {
        const pr = await db.execute<any>(sql`SELECT planning_studio_project_id FROM scheduling_projects WHERE id = ${schedProjectId}::uuid`);
        psProj = (pr.rows?.[0]?.planning_studio_project_id as string | undefined) ?? null;
      } catch { /* tabella assente */ }
    }
    return rows
      .filter((d: any) => d.lat != null && d.lon != null)
      .filter((d: any) => { const sc = scope.get(d.id) ?? null; return sc == null || sc === psProj; })
      .map((d: any) => ({ id: d.id, name: d.name, color: d.color || "#3b82f6", lat: Number(d.lat), lon: Number(d.lon) }));
  } catch { return []; }
}

function nearestDepot(lat: number | null | undefined, lon: number | null | undefined, dps: DepotPoint[]): DepotPoint | null {
  if (lat == null || lon == null || dps.length === 0) return null;
  let best: DepotPoint | null = null;
  let bestD = Infinity;
  for (const d of dps) {
    const km = haversineKm(lat, lon, d.lat, d.lon);
    if (km < bestD) { bestD = km; best = d; }
  }
  return best;
}

/**
 * Assegna a ogni turno macchina la RESIDENZA DI SERVIZIO (deposito), in base alla
 * geografia: deposito di uscita = il più vicino alla prima fermata del turno,
 * deposito di rientro = il più vicino all'ultima. In servizio mono-deposito tutti
 * i turni ricadono sullo stesso; in multi-deposito (extraurbano) ognuno prende il
 * proprio. È il legame deposito→turno che il roster usa per la colorazione.
 */
function assignResidenzaToShifts(
  shifts: VehicleShift[],
  tripBlocks: TripBlock[],
  dps: DepotPoint[],
  caps?: Map<string, number>,
): Map<string, number> {
  // counts = veicoli assegnati per deposito (residenza). Ritornato per l'advisory capacità.
  const counts = new Map<string, number>();
  if (dps.length === 0) return counts;
  const coord = new Map<string, { fLat: number; fLon: number; lLat: number; lLon: number }>();
  for (const t of tripBlocks) {
    coord.set(t.tripId, { fLat: t.firstStopLat, fLon: t.firstStopLon, lLat: t.lastStopLat, lLon: t.lastStopLon });
  }
  // Cap morbido: preferisci il deposito più vicino tra quelli NON ancora pieni;
  // se sono tutti pieni, ricadi sul più vicino in assoluto (overflow consentito).
  const pickOut = (lat: number, lon: number): DepotPoint | null => {
    if (caps && caps.size > 0) {
      const avail = dps.filter(d => (counts.get(d.id) ?? 0) < (caps.get(d.id) ?? Infinity));
      return nearestDepot(lat, lon, avail.length > 0 ? avail : dps);
    }
    return nearestDepot(lat, lon, dps);
  };
  for (const s of shifts) {
    const tripEntries = s.trips.filter((t) => t.type === "trip" && coord.has(t.tripId));
    if (tripEntries.length === 0) { s.depotOut = null; s.depotIn = null; s.residenzaDepotId = null; continue; }
    const first = coord.get(tripEntries[0].tripId)!;
    const last = coord.get(tripEntries[tripEntries.length - 1].tripId)!;
    const dOut = pickOut(first.fLat, first.fLon);
    const dIn = nearestDepot(last.lLat, last.lLon, dps);
    s.depotOut = dOut ? { id: dOut.id, name: dOut.name, color: dOut.color } : null;
    s.depotIn = dIn ? { id: dIn.id, name: dIn.name, color: dIn.color } : null;
    const res = dOut || dIn;
    s.residenzaDepotId = res?.id ?? null;
    s.residenzaName = res?.name ?? null;
    s.residenzaColor = res?.color ?? null;
    if (res) counts.set(res.id, (counts.get(res.id) ?? 0) + 1);
  }
  return counts;
}

/** Selezione depositi dall'input ottimizzatore: ids consentiti + capacità (max
 *  veicoli totali e, opzionale, flotta per TIPOLOGIA di veicolo). */
function parseDepotSelection(raw: any): { ids: Set<string>; caps: Map<string, number>; fleets: Map<string, Record<string, number>> } | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const ids = new Set<string>();
  const caps = new Map<string, number>();
  const fleets = new Map<string, Record<string, number>>();
  for (const d of raw) {
    if (d && typeof d.id === "string" && /^[0-9a-f-]{36}$/i.test(d.id)) {
      ids.add(d.id);
      const mv = Number(d.maxVehicles);
      if (Number.isFinite(mv) && mv > 0) caps.set(d.id, mv);
      // flotta per tipologia: { "12m": 10, "autosnodato": 3, ... }
      if (d.fleet && typeof d.fleet === "object" && !Array.isArray(d.fleet)) {
        const clean: Record<string, number> = {};
        for (const [vt, n] of Object.entries(d.fleet)) {
          const num = Number(n);
          if (typeof vt === "string" && vt.length <= 20 && Number.isFinite(num) && num >= 0) clean[vt] = Math.floor(num);
        }
        if (Object.keys(clean).length > 0) fleets.set(d.id, clean);
      }
    }
  }
  return ids.size > 0 ? { ids, caps, fleets } : null;
}

/** Advisory "cap morbido": segnala i depositi che superano la capacità indicata. */
function depotCapacityAdvisory(counts: Map<string, number>, caps: Map<string, number>, points: DepotPoint[]): Advisory | null {
  const over: string[] = [];
  let maxOver = 0;
  for (const [id, cap] of caps) {
    const used = counts.get(id) ?? 0;
    if (used > cap) {
      const nm = points.find(p => p.id === id)?.name ?? "deposito";
      over.push(`${nm} ${used}/${cap}`);
      maxOver = Math.max(maxOver, used - cap);
    }
  }
  if (over.length === 0) return null;
  return {
    id: "depot-capacity",
    severity: "warning",
    category: "fleet",
    title: "Capacità deposito superata",
    description: `Alcuni depositi hanno più veicoli della capacità indicata: ${over.join(", ")}.`,
    impact: `${maxOver} veicol${maxOver === 1 ? "o" : "i"} oltre capacità`,
    action: "Aumenta la capacità del deposito, aggiungine un altro o riduci le linee in questo scenario.",
    metric: maxOver,
  };
}

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
      // La colonna di provenienza nasce col materializzatore PS→legacy: su un
      // DB dove non è mai girato non esiste, e senza questa ALTER la query
      // sotto fallirebbe lasciando il solver SENZA nodi.
      await db.execute(sql`ALTER TABLE stop_clusters ADD COLUMN IF NOT EXISTS source_ps_project_id uuid`);
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

        /* Override curati a mano (sezione Archi Fuorilinea): custom_km /
         * custom_min o percorsi reindirizzati via points (source='manual')
         * VINCONO sul calcolo OSRM per le coppie che matchano per coordinate.
         * Scope: archi globali sempre; archi legati a un progetto PS solo se
         * è il progetto collegato a questo giro (i globali prima, così un
         * arco di progetto sovrascrive l'omologo globale). */
        try {
          let psProj: string | null = null;
          const schedProjectId = String((body as any).projectId ?? "");
          if (/^[0-9a-f-]{36}$/i.test(schedProjectId)) {
            const pr = await db.execute<any>(sql`SELECT planning_studio_project_id FROM scheduling_projects WHERE id = ${schedProjectId}::uuid`);
            psProj = (pr.rows?.[0]?.planning_studio_project_id as string | undefined) ?? null;
          }
          const arcs = await db.execute<any>(sql`
            SELECT from_lat, from_lon, to_lat, to_lon, road_km, travel_min,
                   custom_km, custom_min, source, ps_project_id
              FROM deadhead_arcs
             WHERE custom_km IS NOT NULL OR custom_min IS NOT NULL OR source = 'manual'
             ORDER BY (ps_project_id IS NOT NULL)`);
          let applied = 0;
          const minOverrides: Record<string, number> = {};
          for (const a of arcs.rows ?? []) {
            if (a.ps_project_id && a.ps_project_id !== psProj) continue;
            const key = `${dhKey(Number(a.from_lat), Number(a.from_lon))}|${dhKey(Number(a.to_lat), Number(a.to_lon))}`;
            if (deadheadKm[key] === undefined) continue; // coppia non usata in questo giro
            const km = a.custom_km ?? (a.source === "manual" ? a.road_km : null);
            const min = a.custom_min ?? (a.source === "manual" ? a.travel_min : null);
            if (km != null && Number.isFinite(Number(km))) deadheadKm[key] = Math.round(Number(km) * 100) / 100;
            if (min != null && Number.isFinite(Number(min))) minOverrides[key] = Math.round(Number(min) * 10) / 10;
            if (km != null || min != null) applied++;
          }
          if (Object.keys(minOverrides).length > 0) deadheadMin = minOverrides;
          if (applied > 0) req.log.info(`CP-SAT VSP: ${applied} archi fuorilinea con override manuale applicati (${Object.keys(minOverrides).length} con tempo curato)`);
        } catch { /* tabella deadhead_arcs assente: nessun override */ }
      } catch (err: any) {
        req.log.warn({ err: err?.message }, "matrice fuorilinea non disponibile, il solver stima Haversine");
      }
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
      cpResult = await runVcspOrchestrator(req.log, {
        vsp: {
          trips: buildPyTrips(solverBlocks),
          config: { timeLimit: timeLimitSec, ...vspExtraConfig },
          routeDetails: routeDetailsForPy,
          psClusters: psClustersForPy,
          ...(depotsForPy && depotsForPy.length > 0 ? { depots: depotsForPy } : {}),
          ...(deadheadKm && Object.keys(deadheadKm).length > 0 ? { deadheadKm } : {}),
          ...(deadheadMin && Object.keys(deadheadMin).length > 0 ? { deadheadMin } : {}),
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
      );
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

/** Aggrega i messaggi per-turno ({driverId: [msg…]}) in un top-10 per tipo. */
function aggregateDutyMessages(det: any): { msg: string; n: number }[] | null {
  if (!det || typeof det !== "object") return null;
  const counts = new Map<string, number>();
  for (const msgs of Object.values(det as Record<string, string[]>)) {
    if (!Array.isArray(msgs)) continue;
    for (const m of msgs) {
      const key = String(m).slice(0, 120);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  if (counts.size === 0) return [];
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([msg, n]) => ({ msg, n }));
}

/** Vista COMPATTA del risultato per la chat (l'MCP tronca a ~40k):
 * KPI, round, sonda e advisories — mai i turni completi (si aprono in app). */
function compactAgentResult(payload: any): any {
  const v = payload?.vcsp;
  const s = payload?.summary ?? {};
  const m = payload?.solverMetrics ?? {};
  return {
    solver: payload?.solver ?? null,
    summary: {
      totalVehicles: s.totalVehicles ?? null,
      totalTrips: s.totalTrips ?? null,
      totalServiceHours: s.totalServiceHours ?? null,
      totalDeadheadKm: s.totalDeadheadKm ?? null,
      efficiency: s.efficiency ?? null,
      byType: s.byType ?? null,
      byDepot: s.byDepot ?? null,
    },
    vehicleCostEur: m.costEur ?? null,
    solveTimeSec: m.solveTimeSec ?? null,
    fleetInfeasibility: m.fleetInfeasibility ?? null,
    advisories: (Array.isArray(payload?.advisories) ? payload.advisories : [])
      .filter((a: any) => a.severity === "critical" || a.severity === "warning")
      .slice(0, 5)
      .map((a: any) => ({ severity: a.severity, title: a.title, description: a.description })),
    ...(v ? {
      vcsp: {
        bestRound: v.bestRound ?? null,
        roundsExecuted: v.roundsExecuted ?? null,
        elapsedSec: v.elapsedSec ?? null,
        rounds: (Array.isArray(v.rounds) ? v.rounds : []).map((r: any) => ({
          round: r.round, probe: !!r.probe, vehicles: r.vehicles,
          duties: r.duties, supplementi: r.supplementi, bdsViolations: r.bdsViolations,
          vehicleCostEur: r.vehicleCostEur, crewCostEur: r.crewCostEur, totalCostEur: r.totalCostEur,
          // Punteggio usato per scegliere il best round (costo + ombre
          // turni/violazioni): senza, "bestRound" sembra arbitrario dalla chat.
          selectionScoreEur: r.selectionScoreEur ?? null,
        })),
        crew: v.crew?.summary ? {
          duties: v.crew.summary.totalShifts ?? null,
          supplementi: v.crew.summary.totalSupplementi ?? null,
          costEur: v.crew.summary.totalDailyCost ?? null,
          bdsViolations: v.crew.summary.validation?.totalViolations ?? 0,
          dutiesWithViolations: v.crew.summary.validation?.dutiesWithViolations ?? 0,
          // DIAGNOSI: violazioni aggregate per messaggio (top 10) — senza
          // questa la chat vede "33 violazioni" ma non QUALI regole saltano,
          // e non può scegliere la leva giusta per il giro successivo.
          violationsBreakdown: aggregateDutyMessages(v.crew.summary.validation?.details),
          // Avvisi non bloccanti (es. pause pasto con severità "avviso"):
          // il turno resta valido ma l'operatore deve vederli.
          bdsWarnings: v.crew.summary.validation?.totalWarnings ?? 0,
          warningsBreakdown: aggregateDutyMessages(v.crew.summary.validation?.warningDetails),
          // Forma dei turni: quanto lavora un turno medio e quante coppie si
          // formano — senza, dalla chat non si capisce se si è vicini al
          // pavimento (ore-vettura ÷ lavoro massimo legale).
          avgWorkMin: v.crew.summary.avgWorkMin ?? null,
          avgNastroMin: v.crew.summary.avgNastroMin ?? null,
          byType: v.crew.summary.byType ?? null,
          semiunicoPct: v.crew.summary.semiunicoPct ?? null,
          spezzatoPct: v.crew.summary.spezzatoPct ?? null,
          totalCambi: v.crew.summary.totalCambi ?? null,
          // Gara fra segmentazioni (storica vs pair-aware): chi ha vinto e perché
          segmentation: v.crew.metrics?.optimizerParams?.segmentation ?? v.crew.metrics?.segmentation ?? null,
          // Fattori applicati dai pesi operatore (1.0 = slider al default)
          weightFactors: v.crew.metrics?.weightFactors ?? null,
          // Elenco compatto dei turni: serve al passo "pianificazione" (quali
          // interi restano corti, dove spostare le corse). Un turno = tipo,
          // nastro/lavoro e i suoi pezzi (bus, orari, nodi, linee).
          dutyList: (Array.isArray(v.crew.driverShifts) ? v.crew.driverShifts : []).slice(0, 80).map((d: any) => ({
            id: d.driverId, type: d.type, nastroMin: d.nastroMin, workMin: d.workMin,
            interruptionMin: d.interruptionMin ?? 0,
            pieces: (Array.isArray(d.riprese) ? d.riprese : []).map((r: any) => {
              const trips = Array.isArray(r.trips) ? r.trips.filter((t: any) => t && t.tripId) : [];
              const lines = Array.from(new Set(trips.map((t: any) => t.routeName).filter(Boolean)));
              return {
                veh: Array.isArray(r.vehicleIds) && r.vehicleIds.length ? r.vehicleIds[0] : (trips[0]?.vehicleId ?? null),
                start: r.startTime, end: r.endTime,
                from: trips[0]?.firstStopName ?? null, to: r.lastStop ?? null,
                lines, trips: trips.length,
              };
            }),
          })),
          // Struttura dei blocchi macchina visti dal CSP (CORTO/MEDIO/LUNGO):
          // dice se le violazioni sono un problema di blocchi troppo lunghi.
          blocks: v.crew.metrics ? {
            vehicleBlocks: v.crew.metrics.vehicleBlocks ?? null,
            classifications: v.crew.metrics.classifications ?? null,
          } : null,
          // Vincolo RIGIDO autovetture (i campi vivono nel SUMMARY del CSP).
          companyCars: {
            cap: v.crew.summary.companyCarsCap ?? null,
            maxSimultaneous: v.crew.summary.companyCarsMaxSimultaneous ?? null,
            used: v.crew.summary.companyCarsUsed ?? null,
            violated: !!v.crew.summary.companyCarsHardViolation,
          },
        } : null,
        // Sonda di spostamento: le proposte accettate sono PICCOLE (poche corse)
        // e sono esattamente ciò che l'agente deve raccontare all'operatore.
        probe: v.probe ? {
          flexTrips: v.probe.flexTrips ?? 0,
          candidates: v.probe.candidates ?? 0,
          probesRun: v.probe.probesRun ?? 0,
          accepted: v.probe.accepted ?? [],
          rejectedCount: Array.isArray(v.probe.rejected) ? v.probe.rejected.length : 0,
          timeShifts: v.probe.timeShifts ?? {},
        } : null,
      },
    } : {}),
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
            let fresh = false;
            if (sp.feed_id) {
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
      const psVehicle = new Map<string, string>();
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
            psVehicle.set(String(row.id), String(vt.preferita ?? vt.ammesse[0]));
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
        const mapped = declared && (validTypes.has(declared) ? declared : AGENT_VEHICLE_FALLBACK[declared]);
        if (mapped) {
          routes.push({ routeId: r.routeId, vehicleType: mapped as VehicleType, forced: false });
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
        ...(mode === "vcsp" ? { rounds: runBody.vcsp.rounds, probes: runBody.vcsp.probes, crewTimeLimit: runBody.vcsp.crewTimeLimit } : {}),
      },
    };
    agentJobs.set(job.id, job);
    pruneAgentJobs();

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
                await db.execute(sql`ALTER TABLE service_program_scenarios ADD COLUMN IF NOT EXISTS depots jsonb`);
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
                config: { source: "argos-agent", bestRound: v.bestRound ?? null, selectedRound: v.bestRound ?? null } as any,
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
        job.status = "done";
      } catch (e: any) {
        job.status = "error";
        job.error = `Giro completato ma salvataggio fallito: ${e?.message}`;
      } finally {
        job.finishedAt = Date.now();
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
      ...(mode === "vcsp" ? { rounds: runBody.vcsp.rounds, probes: runBody.vcsp.probes } : {}),
      hint: "Interroga GET /service-program/agent-optimize/{jobId} per progresso e risultato (attendi ~60-90s tra un controllo e l'altro)",
    });
  } catch (err: any) {
    req.log.error(err, "Error in agent-optimize");
    res.status(500).json({ error: err.message || "Errore avvio giro" });
  }
});

/** Stato/risultato di un giro lanciato dall'agente. */
router.get("/service-program/agent-optimize/:jobId", (req, res) => {
  const job = agentJobs.get(String(req.params.jobId));
  if (!job) { res.status(404).json({ error: "Job non trovato (scaduto o mai esistito): rilancia il giro" }); return; }
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
router.get("/service-program/agent-optimize", (req, res) => {
  const userId = req.user?.id;
  if (!userId) { res.status(401).json({ error: "Non autenticato" }); return; }
  const isAdmin = req.user?.role === "admin";
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
  res.json({ jobs });
});

/* ═══════════════════════════════════════════════════════════════
 *  SCENARIO SAVE / LOAD / LIST / DELETE
 *  Salva lo scenario turni macchina per riutilizzarlo nei turni guida
 * ═══════════════════════════════════════════════════════════════ */

/** POST /api/service-program/scenarios — save a scenario */
router.post("/service-program/scenarios", async (req, res) => {
  try {
    const { name, date, input, result: scenarioResult, projectId, depotId, depots: depotsSel } = req.body as {
      name?: string; date?: string;
      input?: unknown; result?: unknown;
      projectId?: string; depotId?: string;
      /** Multi-deposito: selezione completa [{id, maxVehicles}] (jsonb additivo) */
      depots?: { id: string; maxVehicles?: number | null }[];
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
    // Aggancia al progetto se passato (colonna nullable aggiunta da scheduling-projects)
    // Residenza di servizio = deposito scelto (colonna additiva depot_id)
    if (depotId && /^[0-9a-f-]{36}$/i.test(depotId)) {
      try {
        await db.execute(sql`ALTER TABLE service_program_scenarios ADD COLUMN IF NOT EXISTS depot_id uuid`);
        await db.execute(sql`UPDATE service_program_scenarios SET depot_id = ${depotId}::uuid WHERE id = ${row.id}::uuid`);
      } catch (e: any) {
        req.log.warn({ err: e?.message }, "attach depot_id failed (non-fatal)");
      }
    }
    // Multi-deposito: salva l'INSIEME dei depositi selezionati (con cap vetture).
    // Colonna additiva jsonb; depot_id resta per compatibilità (primo deposito).
    if (Array.isArray(depotsSel) && depotsSel.length > 0) {
      const clean = depotsSel
        .filter(d => d && typeof d.id === "string" && /^[0-9a-f-]{36}$/i.test(d.id))
        .map(d => ({ id: d.id, maxVehicles: Number.isFinite(Number(d.maxVehicles)) && Number(d.maxVehicles) > 0 ? Number(d.maxVehicles) : null }));
      if (clean.length > 0) {
        try {
          await db.execute(sql`ALTER TABLE service_program_scenarios ADD COLUMN IF NOT EXISTS depots jsonb`);
          await db.execute(sql`UPDATE service_program_scenarios SET depots = ${JSON.stringify(clean)}::jsonb WHERE id = ${row.id}::uuid`);
        } catch (e: any) {
          req.log.warn({ err: e?.message }, "attach depots failed (non-fatal)");
        }
      }
    }
    if (projectId && /^[0-9a-f-]{36}$/i.test(projectId)) {
      try {
        await db.execute(sql`UPDATE service_program_scenarios SET project_id = ${projectId}::uuid WHERE id = ${row.id}::uuid`);
      } catch (e: any) {
        req.log.warn({ err: e?.message }, "attach project_id failed (non-fatal)");
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
    await db.delete(serviceProgramScenarios)
      .where(eq(serviceProgramScenarios.id, req.params.id));
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
