/**
 * Il modello dei turni macchina: tipologie di vettura, costi, punteggio e
 * avvisi del programma di esercizio. Senza Express: lo usano le rotte
 * (routes/service-program.ts) e il lavoratore dei calcoli.
 */
import { db } from "@workspace/db";
import { gtfsCalendar, gtfsCalendarDates } from "@workspace/db/schema";
import { and, eq, sql } from "drizzle-orm";

/* ═══════════════════════════════════════════════════════════════
 *  VEHICLE TYPES & HIERARCHY
 * ═══════════════════════════════════════════════════════════════ */

export type VehicleType = "autosnodato" | "12m" | "10m" | "pollicino";
export type ServiceCategory = "urbano" | "extraurbano";

export const VEHICLE_SIZE: Record<VehicleType, number> = {
  autosnodato: 4, "12m": 3, "10m": 2, pollicino: 1,
};

export const VEHICLE_LABELS: Record<VehicleType, string> = {
  autosnodato: "Autosnodato (18m)", "12m": "12 metri", "10m": "10 metri", pollicino: "Pollicino (6m)",
};

export const VEHICLE_CAPACITY: Record<VehicleType, number> = {
  autosnodato: 150, "12m": 80, "10m": 60, pollicino: 25,
};

export const DEADHEAD_SPEED: Record<ServiceCategory, number> = {
  urbano: 20,
  extraurbano: 40,
};

export const MAX_DEADHEAD_KM = 30;
export const MAX_IDLE_AT_TERMINAL = 60;
export const MIN_LAYOVER = 3;
export const DEADHEAD_BUFFER = 5;

/* ═══════════════════════════════════════════════════════════════
 *  REGOLA DELLA SAGOMA
 *  Il tipo dichiarato su una linea è il mezzo giusto e insieme il suo TETTO
 *  fisico: sopra quella taglia la strada non regge, quindi non esiste
 *  promozione (un 12m su una linea da pollicino non passa). Sotto si perde
 *  capienza: si concede UN gradino solo, mai due, e il meno possibile —
 *  è l'ultima spiaggia, non la norma. Nelle ore di morbida pesa meno.
 *  Scala: autosnodato → 12m → 10m → pollicino.
 * ═══════════════════════════════════════════════════════════════ */

/** Max livelli di downsize consentiti (1 = un gradino sotto) */
export const MAX_DOWNSIZE_LEVELS = 1;

/** Ore di punta — declassamento più penalizzato */
export function isPeakHour(departureMin: number): boolean {
  // GTFS ammette orari oltre le 24h (corse a cavallo di mezzanotte): senza il
  // modulo una corsa "25:30" darebbe h=25 e non sarebbe mai vista come punta.
  const h = Math.floor(departureMin / 60) % 24;
  return (h >= 7 && h <= 9) || (h >= 17 && h <= 19);
}

/**
 * Verifica se un veicolo di dimensione `vehicleSize` può servire
 * una corsa che richiede `requiredSize`.
 * - vehicleSize > requiredSize → MAI: è la sagoma, quel mezzo non ci passa
 * - vehicleSize === requiredSize → il mezzo giusto
 * - vehicleSize < requiredSize → declassamento, entro MAX_DOWNSIZE_LEVELS
 */
export function canVehicleServeTrip(vehicleSize: number, requiredSize: number): boolean {
  if (vehicleSize > requiredSize) return false;
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
export const COST_VEHICLE_FIXED_DAY: Record<VehicleType, number> = {
  autosnodato: 55,   // €/day
  "12m": 42,
  "10m": 32,
  pollicino: 18,
};

/** Costo variabile veicolo per km IN SERVIZIO — carburante, gomme, usura freni/motore.
 *  Applicato ai km percorsi durante le corse effettive. */
export const COST_VEHICLE_PER_SERVICE_KM: Record<VehicleType, number> = {
  autosnodato: 1.20,  // €/km — diesel/CNG alto consumo, gomme pesanti
  "12m": 0.95,
  "10m": 0.75,
  pollicino: 0.45,
};

/** Costo variabile veicolo per km FUORILINEA (trasferimenti a vuoto).
 *  Leggermente inferiore al servizio (no fermate, no aria condiz. piena potenza). */
export const COST_VEHICLE_PER_DEADHEAD_KM: Record<VehicleType, number> = {
  autosnodato: 1.00,
  "12m": 0.80,
  "10m": 0.65,
  pollicino: 0.40,
};

/** Velocità media in servizio per stimare km servizio dalle ore servizio */
export const AVG_SERVICE_SPEED: Record<ServiceCategory, number> = {
  urbano: 18,       // km/h — molte fermate, traffico
  extraurbano: 32,  // km/h — meno fermate, strade extraurbane
};

/** Costo orario autista — applicato SOLO sulle ore di guida effettive (servizio + trasferimenti) */
export const COST_PER_DRIVING_HOUR = 28;

/** Costo logistico per ogni rientro deposito (movimentazione, controlli) */
export const COST_PER_DEPOT_RETURN = 15;

/** Costo orario tempo inattivo veicolo (costo opportunità, usura statica) */
export const COST_PER_IDLE_HOUR = 5;

export function getServiceCategory(routeName: string): ServiceCategory {
  const firstChar = routeName.trim().charAt(0);
  if (/[a-zA-Z]/.test(firstChar)) return "extraurbano";
  return "urbano";
}

/* ═══════════════════════════════════════════════════════════════
 *  ACTIVE SERVICES
 * ═══════════════════════════════════════════════════════════════ */

export const DOW_COLS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;

export async function getActiveServiceIds(feedId: string, dateYMD: string): Promise<Set<string>> {
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

export interface TripBlock {
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

export interface ShiftTripEntry {
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
  /** Tipo dichiarato dalla linea: è il tetto di sagoma della corsa */
  requiredVehicle?: VehicleType;
  /** Corsa A CHIAMATA (su prenotazione) */
  onDemand?: boolean;
}

export interface VehicleShift {
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
  // Il lucchetto: turno deciso dall'operatore che il solver ha ricevuto come
  // vincolo duro e restituito tale e quale (stesse corse, stessa matricola).
  locked?: boolean;
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

export type AdvisorySeverity = "info" | "warning" | "critical";
export type AdvisoryCategory = "fleet" | "deadhead" | "schedule" | "cost" | "refueling";

export interface Advisory {
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

export interface ScenarioCost {
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

export interface ScenarioScore {
  overall: number;           // 0-100 composite score
  efficiency: number;        // service time / (service + deadhead + idle)
  fleetUtilization: number;  // avg trips per vehicle
  deadheadRatio: number;     // deadhead km / total operational km (lower = better)
  costEfficiency: number;    // normalized cost score (higher = cheaper)
  fifoCompliance: number;    // how well the FIFO schedule works for refueling
  grade: string;             // A+ to F
  gradeColor: string;
}

export function calculateCosts(
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

export function calculateScore(
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

export function generateAdvisories(
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

  /* ──── 2. MEZZO PIÙ GRANDE DEL DICHIARATO ────
   * Con la regola della sagoma il tipo del turno è la richiesta PIÙ RESTRITTIVA
   * fra le sue corse, quindi un turno sopra il dichiarato non può più nascere:
   * questo avviso è la rete che lo direbbe se accadesse. La versione precedente
   * proponeva invece di declassare ogni blocco monolinea per risparmiare sul
   * costo fisso — cioè esattamente il comportamento tolto dal motore — e
   * spingeva l'operatore a rifare a mano il declassamento appena evitato.
   * Quando un mezzo sembra troppo grande, l'azione giusta non è declassare il
   * singolo turno ma rivedere la TIPOLOGIA DICHIARATA della linea, che è anche
   * il suo tetto di sagoma. */
  for (const shift of shifts) {
    const corse = shift.trips.filter(t => t.type === "trip");
    const richieste = corse
      .map(t => t.requiredVehicle)
      .filter((v): v is VehicleType => !!v && v in VEHICLE_SIZE);
    if (richieste.length === 0) continue;
    const minReq = Math.min(...richieste.map(v => VEHICLE_SIZE[v]));
    const currentSize = VEHICLE_SIZE[shift.vehicleType];
    if (currentSize > minReq) {
      const soffrono = corse.filter(t => t.requiredVehicle
        && VEHICLE_SIZE[t.requiredVehicle] < currentSize);
      const linee = [...new Set(soffrono.map(t => t.routeName).filter(Boolean))];
      advisories.push({
        id: `adv-${++id}`,
        severity: "critical",
        category: "fleet",
        title: `${shift.vehicleId}: mezzo fuori sagoma`,
        description: `Il turno ${shift.vehicleId} gira con un ${VEHICLE_LABELS[shift.vehicleType]}, ma serve ${soffrono.length} corse di linee dichiarate per un mezzo più piccolo (${linee.join(", ")}). Sopra la taglia dichiarata la strada non regge.`,
        impact: "Corse assegnate a un mezzo che su quel percorso non può transitare",
        action: `Rimpacchettare il turno separando le corse di ${linee.join(", ")}, oppure correggere la tipologia dichiarata di quelle linee in Planning Studio.`,
        metric: soffrono.length,
      });
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
