/* ═══════════════════════════════════════════════════════════════
 *  TYPES — Heuristic Analysis
 * ═══════════════════════════════════════════════════════════════ */

export type Priority = "critical" | "high" | "medium" | "low";
export type SuggestionType = "superfluous" | "overcrowded" | "rush-pileup" | "intermodal-gap" | "low-demand";

export interface ScheduleSuggestion {
  id: string;
  type: SuggestionType;
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

export interface RouteStats {
  routeId: string;
  routeName: string;
  totalTrips: number;
  avgHeadwayMin: number;
  peakTrips: number;
  offPeakTrips: number;
}

export interface HourlyDist {
  hour: number;
  trips: number;
  demand: number;
}

export interface ScheduleResult {
  suggestions: ScheduleSuggestion[];
  routeStats: RouteStats[];
  hourlyDist: HourlyDist[];
  summary: {
    date: string;
    activeServices: number;
    totalTrips: number;
    totalRoutes: number;
    totalServices: number;
    suggestionsCount: { total: number; critical: number; high: number; medium: number; low: number };
    totalSavingsMinutes: number;
    peakHour: { hour: number; trips: number; demand: number };
    byType: { superfluous: number; overcrowded: number; rushPileup: number; lowDemand: number; intermodalGap: number };
    message?: string;
  };
}

/* ═══════════════════════════════════════════════════════════════
 *  TYPES — CP-SAT Optimizer
 * ═══════════════════════════════════════════════════════════════ */

export interface StrategyWeights {
  cost: number;
  regularity: number;
  coverage: number;
  overcrowd: number;
  connections: number;
}

export interface StrategyDef {
  name: string;
  description: string;
  weights: StrategyWeights;
}

export interface TripDecision {
  tripId: string;
  routeId: string;
  routeName: string;
  originalDeparture: string;
  newDeparture: string | null;
  action: "keep" | "remove" | "shift";
  shiftMinutes: number;
  mergedWith: string | null;
  reason: string;
}

export interface SolutionMetrics {
  totalTripsOriginal: number;
  totalTripsKept: number;
  tripsRemoved: number;
  tripsShifted: number;
  savingsMinutes: number;
  regularityScore: number;
  coverageScore: number;
  overcrowdingRisk: number;
  solveTimeMs: number;
  solverStatus: string;
  objectiveValue: number;
}

export interface StrategyResult {
  strategy: StrategyDef;
  metrics: SolutionMetrics;
  paretoRank: number;
  isBest: boolean;
  decisions: TripDecision[];
}

export interface ComparisonEntry {
  tripsRemoved: number;
  tripsShifted: number;
  savingsHours: number;
  regularityScore: number;
  coverageScore: number;
  overcrowdingRisk: number;
  solverStatus: string;
  solveTimeMs: number;
  paretoRank: number;
}

export interface RouteBeforeAfter {
  routeName: string;
  routeId: string;
  before: number;
  after: number;
}

export interface OptimizationOutput {
  bestStrategy: string;
  paretoFront: string[];
  totalSolveTimeMs: number;
  inputSummary: {
    totalTrips: number;
    totalRoutes: number;
    routeDirections: number;
    timeBands: number;
    maxShiftMinutes: number;
    strategiesTested: number;
  };
  comparisonMatrix: Record<string, ComparisonEntry>;
  routeBeforeAfter: RouteBeforeAfter[];
  results: StrategyResult[];
}
