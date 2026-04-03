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
}
