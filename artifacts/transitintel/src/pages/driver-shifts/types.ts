/* ═══════════════════════════════════════════════════════════════
 *  Driver Shifts – Type definitions
 * ═══════════════════════════════════════════════════════════════ */

export type DriverShiftType = "intero" | "semiunico" | "spezzato" | "supplemento" | "invalido";

export interface RipresaTrip {
  tripId: string;
  routeId: string;
  routeName: string;
  headsign: string | null;
  departureTime: string;
  arrivalTime: string;
  departureMin: number;
  arrivalMin: number;
  firstStopName?: string;
  lastStopName?: string;
  vehicleId?: string;
  vehicleType?: string;
}

export interface CambioInLinea {
  cluster: string;
  clusterName: string;
  fromVehicle: string;
  toVehicle: string;
  atMin: number;
  atTime: string;
}

export interface CarPoolInfo {
  carId?: number | null;
  departMin?: number;
  departTime?: string;
  arriveMin?: number;
  arriveTime?: string;
  description: string;
}

export interface Ripresa {
  startTime: string;
  endTime: string;
  startMin: number;
  endMin: number;
  preTurnoMin: number;
  transferMin: number;
  transferType: string;
  transferToStop?: string;
  transferToCluster?: string | null;
  transferBackMin: number;
  transferBackType: string;
  lastStop?: string;
  lastCluster?: string | null;
  workMin: number;
  vehicleIds: string[];
  vehicleType?: string;
  cambi: CambioInLinea[];
  trips: RipresaTrip[];
  carPoolOut?: CarPoolInfo | null;
  carPoolReturn?: CarPoolInfo | null;
}

export interface HandoverInfo {
  vehicleId: string;
  atMin: number;
  atTime: string;
  atStop: string;
  cluster: string | null;
  clusterName: string;
  role: "incoming" | "outgoing";
  otherDriver: string;
  description: string;
  cutType?: "inter" | "intra";
  tripId?: string;
  routeName?: string;
}

export interface DriverShiftData {
  driverId: string;
  type: DriverShiftType;
  nastroStart: string;
  nastroEnd: string;
  nastroStartMin: number;
  nastroEndMin: number;
  nastroMin: number;
  nastro: string;
  workMin: number;
  work: string;
  interruptionMin: number;
  interruption: string | null;
  transferMin: number;
  transferBackMin: number;
  preTurnoMin: number;
  cambiCount: number;
  riprese: Ripresa[];
  handovers?: HandoverInfo[];
  vehicleHandoverLabels?: string[];
  /* v2 cost fields */
  costEuro?: number;
  costBreakdown?: Record<string, number>;
  /* v4 BDS fields */
  bdsValidation?: {
    valid: boolean;
    classificazioneValida: boolean;
    cee561: boolean;
    intervalloPasto: boolean;
    staccoMinimo: boolean;
    nastro: boolean;
    riprese: boolean;
    violations: string[];
  };
  workCalculation?: {
    lavoroNetto: number;
    lavoroConvenzionale: number;
    driving: number;
    idleAtTerminal: number;
    prePost: number;
    transfer: number;
    sosteFraRipreseIR: number;
    sosteFraRipreseFR: number;
  };
}

export interface DriverShiftSummary {
  totalDriverShifts: number;
  totalSupplementi?: number;
  totalShifts?: number;
  byType: Record<DriverShiftType, number>;
  totalWorkHours: number;
  avgWorkMin: number;
  totalNastroHours: number;
  avgNastroMin: number;
  semiunicoPct: number;
  spezzatoPct: number;
  totalCambi: number;
  totalInterCambi?: number;
  totalIntraCambi?: number;
  companyCarsUsed: number;
  /* v2 cost fields */
  totalDailyCost?: number;
  costBreakdown?: Record<string, number>;
  efficiency?: Record<string, number>;
}

export interface ClusterInfo {
  id: string;
  name: string;
  transferMin: number;
}

/** Metriche di un singolo scenario CP-SAT valutato nel multi-scenario. */
export interface ScenarioResult {
  idx: number;
  scenarioNum: number;
  rank?: number;
  isBest?: boolean;
  isPolish?: boolean;
  status: string;
  feasible: boolean;
  score: number;
  obj?: number;
  elapsed: number;
  params?: {
    seed: number;
    noise: number;
    linLevel: number;
    nWorkers: number;
    strategy?: string;
    strategyLabel?: string;
    isPolish?: boolean;
  };
  /* metriche (popolate solo per scenari fattibili) */
  duties?: number;
  interi?: number;
  semiunici?: number;
  spezzati?: number;
  supplementi?: number;
  invalidi?: number;
  semiPct?: number;
  spezPct?: number;
  supplPct?: number;
  totalWorkH?: number;
  totalNastroH?: number;
  totalDrivingH?: number;
  totalInterruptionH?: number;
  totalTransferH?: number;
  avgWorkMin?: number;
  avgNastroMin?: number;
  avgIdleMin?: number;
  totalIdleH?: number;
  vuotiSignificativi?: number;
  totalCost?: number;
  costPerDuty?: number;
  bdsViolations?: number;
  semiCompliant?: boolean;
  spezCompliant?: boolean;
}

/** Sintesi del processo di ottimizzazione multi-scenario. */
export interface OptimizationAnalysis {
  nScenariosRun: number;
  nScenariosRequested: number;
  nFeasible: number;
  nInfeasible: number;
  totalElapsedSec: number;
  scenarioElapsedSec: number;
  polishElapsedSec: number;
  polishImproved: boolean;
  polishDeltaScore: number;
  polishDeltaPct: number;
  bestScore: number;
  bestStrategy: string;
  bestStrategyLabel: string;
  bestStrategyDesc: string;
  scoreSpreadPct: number;
  strategiesExplored: number;
  totalStrategiesAvailable: number;
  strategySummary: Array<{
    key: string;
    label: string;
    desc: string;
    nRuns: number;
    bestScore: number;
    bestCost?: number;
    bestDuties?: number;
    isWinner: boolean;
  }>;
  bestMetrics?: {
    duties?: number;
    totalCost?: number;
    totalWorkH?: number;
    bdsViolations?: number;
    vuotiSignificativi?: number;
    score?: number;
  };
  intensity: number;
  timeBudgetSec: number;
  scenarioBudgetSec: number;
  polishBudgetSec: number;
  nSegments: number;
  nFeasiblePairs: number;
}

export interface DriverShiftsResult {
  scenarioId: string;
  scenarioName: string;
  date: string;
  driverShifts: DriverShiftData[];
  summary: DriverShiftSummary;
  unassignedBlocks: number;
  clusters: ClusterInfo[];
  companyCars: number;
  /* v2 cost fields */
  costAnalysis?: Record<string, any>;
  costRates?: Record<string, number>;
  /* v4 multi-scenario */
  scenarios?: ScenarioResult[];
  optimizationAnalysis?: OptimizationAnalysis;
}
