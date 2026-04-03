/* ═══════════════════════════════════════════════════════════════
 *  Optimizer Route – Type definitions
 * ═══════════════════════════════════════════════════════════════ */

export type VehicleType = "autosnodato" | "12m" | "10m" | "pollicino";
export type ServiceCategory = "urbano" | "extraurbano";

export interface RouteItem {
  routeId: string;
  name: string;
  longName: string | null;
  tripsCount: number;
  color: string | null;
  category: ServiceCategory;
}

export interface TripInfo {
  tripId: string;
  routeId: string;
  headsign: string;
  directionId: number;
  departureTime: string;
  arrivalTime: string;
  firstStopName: string;
  lastStopName: string;
}

export interface VehicleTypeInfo {
  id: string;
  label: string;
  capacity: number;
  sizeIndex: number;
}

export interface ShiftTripEntry {
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
  fifoOrder: number;
  firstOut: number;
  lastIn: number;
  shiftDuration: number;
  downsizedTrips: number;
}

export interface RouteStatItem {
  routeId: string;
  routeName: string;
  vehicleType: string;
  category: string;
  tripsCount: number;
  vehiclesNeeded: number;
  firstDeparture: string;
  lastArrival: string;
}

export interface ScenarioCost {
  vehicleFixedCost: number;
  vehicleServiceKmCost: number;
  vehicleDeadheadKmCost: number;
  vehicleTotalCost: number;
  driverCost: number;
  depotReturnCost: number;
  idleCost: number;
  totalDailyCost: number;
  costPerTrip: number;
  costPerServiceHour: number;
  byVehicleType: Record<string, {
    count: number;
    fixedCost: number;
    serviceKmCost: number;
    deadheadKmCost: number;
    totalVehicleCost: number;
    serviceKm: number;
    deadheadKm: number;
  }>;
  byCategory: Record<string, {
    vehicles: number;
    vehicleCost: number;
    driverCost: number;
    totalCost: number;
  }>;
}

export interface ScenarioScore {
  overall: number;
  efficiency: number;
  fleetUtilization: number;
  deadheadRatio: number;
  costEfficiency: number;
  fifoCompliance: number;
  grade: string;
  gradeColor: string;
}

export interface Advisory {
  id: string;
  severity: "info" | "warning" | "critical";
  category: string;
  title: string;
  description: string;
  impact: string;
  action: string;
  metric?: number;
}

export interface ServiceProgramResult {
  shifts: VehicleShift[];
  unassigned: any[];
  routeStats: RouteStatItem[];
  hourlyDist: { hour: number; trips: number }[];
  summary: {
    date: string;
    activeServices: number;
    totalTrips: number;
    selectedRoutes: number;
    totalVehicles: number;
    byType: Record<string, number>;
    byCategory: Record<string, number>;
    totalServiceHours: number;
    totalDeadheadHours: number;
    totalDeadheadKm: number;
    depotReturns: number;
    efficiency: number;
    downsizedTrips?: number;
    message?: string;
  };
  costs: ScenarioCost;
  score: ScenarioScore;
  advisories: Advisory[];
  solver?: "greedy" | "cpsat";
  solverMetrics?: any;
  costBreakdown?: {
    aggregated: {
      fixedDaily: number;
      serviceKmCost: number;
      deadheadKmCost: number;
      idleCost: number;
      depotReturnCost: number;
      balancePenalty: number;
      gapPenalty: number;
      downsizePenalty: number;
      total: number;
    };
    perShift: Array<{
      vehicleId: number;
      vehicleType: string;
      numTrips: number;
      fixedDaily: number;
      serviceKmCost: number;
      deadheadKmCost: number;
      idleCost: number;
      depotReturnCost: number;
      balancePenalty: number;
      gapPenalty: number;
      downsizePenalty: number;
      total: number;
    }>;
    numVehicles: number;
  };
  greedyComparison?: {
    vehicles: number;
    costBreakdown: {
      aggregated: {
        total: number;
        fixedDaily: number;
        serviceKmCost: number;
        deadheadKmCost: number;
        idleCost: number;
        depotReturnCost: number;
        balancePenalty: number;
        gapPenalty: number;
        downsizePenalty: number;
      };
      numVehicles: number;
    };
  };
}
