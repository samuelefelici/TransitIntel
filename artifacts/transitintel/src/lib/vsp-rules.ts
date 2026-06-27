/**
 * vsp-rules — Schema dichiarativo dei parametri dell'ottimizzatore TURNI MACCHINA
 * (vehicle_scheduler_cpsat.py). Gemello di optimizer-rules per i turni guida.
 *
 * Chiavi allineate a:
 *  - VehicleCostRates.from_config(config.vehicleCosts)  (optimizer_common.py)
 *  - VSPConfig.from_config(config.vspAdvanced)          (vehicle_scheduler_cpsat.py)
 *
 * La config VSP è { vehicleCosts: {...}, vspAdvanced: {...} }. I default
 * coincidono con i valori attuali dello step ottimizzatore (comportamento
 * invariato), editabili e salvabili come profilo-regole (domain='vsp').
 *
 * NB esclusi (richiederebbero rebinding cross-modulo, controlli morti):
 * MAX_DEADHEAD_KM/MIN_LAYOVER/DEADHEAD_BUFFER/DEADHEAD_SPEED importati per nome
 * in vehicle_scheduler da optimizer_common. solverIntensity resta il selettore
 * rapido dello step (non duplicato qui).
 */
import type { FieldDef, GroupDef } from "@/lib/optimizer-rules";

export interface VspConfig {
  vehicleCosts: Record<string, any>;
  vspAdvanced: Record<string, any>;
}

export const DEFAULT_VSP: VspConfig = {
  vehicleCosts: {
    fixedDaily: { autosnodato: 55, "12m": 42, "10m": 32, pollicino: 18 },
    perServiceKm: { autosnodato: 1.2, "12m": 0.95, "10m": 0.75, pollicino: 0.45 },
    perDeadheadKm: { autosnodato: 1.0, "12m": 0.8, "10m": 0.65, pollicino: 0.4 },
    avgServiceSpeed: { urbano: 18, extraurbano: 32 },
    idlePerMin: 0.08,
    longIdlePerMin: 0.15,
    longIdleThreshold: 20,
    perDepotReturn: 15,
    targetShiftDuration: 600,
    balanceCoeff: 0.0003,
    gapCoeff: 0.0005,
    downsizePeakPerLevelPerMin: 0.1,
    downsizeOffpeakPerLevelPerMin: 0.01,
    maxIdleAtTerminal: 90,
    maxIdleForArcMin: 600,
    terminalClusterRadiusM: 250,
    minDeadheadKm: 0.5,
  },
  vspAdvanced: {
    minVehiclesPriority: "strict",
    preferMonolinea: false,
    enableNoGoodCuts: true,
    minArcDiffPct: 0.12,
    minArcDiffAbs: 5,
    warmstartSplit: 0.5,
    greedyPerturbations: 3,
    enablePolish: true,
    polishTimePct: 0.2,
    lsNoImproveLimit: 500,
    strategyAmplifier: 1.0,
    enableVehicleElimination: true,
    vehicleEliminationMaxPasses: 10,
    vehicleEliminationTimeSec: 60,
    enableIterativeReduction: true,
    iterativeReductionTimeSec: 180,
    scenariosOverride: 0, // 0 = auto da intensità
  },
};

export function buildDefaultVspConfig(): VspConfig {
  return {
    vehicleCosts: {
      ...DEFAULT_VSP.vehicleCosts,
      fixedDaily: { ...DEFAULT_VSP.vehicleCosts.fixedDaily },
      perServiceKm: { ...DEFAULT_VSP.vehicleCosts.perServiceKm },
      perDeadheadKm: { ...DEFAULT_VSP.vehicleCosts.perDeadheadKm },
      avgServiceSpeed: { ...DEFAULT_VSP.vehicleCosts.avgServiceSpeed },
    },
    vspAdvanced: { ...DEFAULT_VSP.vspAdvanced },
  };
}

const PRIORITY_OPTS = [
  { value: "off", label: "Off" },
  { value: "soft", label: "Soft" },
  { value: "strict", label: "Strict" },
  { value: "lexicographic", label: "Lessicografica" },
];

const VTYPE = [
  { key: "autosnodato", label: "Autosnodato" },
  { key: "12m", label: "12m" },
  { key: "10m", label: "10m" },
  { key: "pollicino", label: "Pollicino" },
];

function costPerType(base: string, label: string, unit: string, max: number, step: number, advanced = false): FieldDef[] {
  return VTYPE.map((v) => ({
    path: `vehicleCosts.${base}.${v.key}`,
    label: `${label} · ${v.label}`,
    type: "float" as const,
    unit,
    min: 0,
    max,
    step,
    advanced,
  }));
}

export const VSP_GROUPS: GroupDef[] = [
  {
    id: "fixedDaily",
    title: "Costo fisso giornaliero veicolo",
    description: "Assicurazione, bollo, manutenzione per tipo veicolo (€/giorno).",
    fields: costPerType("fixedDaily", "Fisso", "€/g", 500, 1),
  },
  {
    id: "vspKm",
    title: "Costi chilometrici",
    description: "Costo km in servizio e fuori linea (deadhead) per tipo veicolo.",
    fields: [
      ...costPerType("perServiceKm", "Servizio", "€/km", 10, 0.05),
      ...costPerType("perDeadheadKm", "Deadhead", "€/km", 10, 0.05),
    ],
  },
  {
    id: "vspIdleDepot",
    title: "Sosta capolinea e deposito",
    fields: [
      { path: "vehicleCosts.idlePerMin", label: "Sosta capolinea", type: "float", unit: "€/min", min: 0, max: 5, step: 0.01 },
      { path: "vehicleCosts.longIdlePerMin", label: "Sosta lunga (penalità)", type: "float", unit: "€/min", min: 0, max: 5, step: 0.01 },
      { path: "vehicleCosts.longIdleThreshold", label: "Soglia sosta lunga", type: "int", unit: "min", min: 0, max: 240 },
      { path: "vehicleCosts.perDepotReturn", label: "Rientro deposito", type: "float", unit: "€", min: 0, max: 200, step: 1 },
      { path: "vehicleCosts.maxIdleAtTerminal", label: "Sosta max capolinea (no rientro)", type: "int", unit: "min", min: 0, max: 720 },
    ],
  },
  {
    id: "vspMinVehicles",
    title: "Riduzione flotta",
    description: "Quanto spingere a minimizzare il numero di veicoli.",
    fields: [
      { path: "vspAdvanced.minVehiclesPriority", label: "Priorità min. veicoli", type: "enum", options: PRIORITY_OPTS },
      { path: "vspAdvanced.preferMonolinea", label: "Preferenza monolinea", type: "bool" },
      { path: "vspAdvanced.enableVehicleElimination", label: "Eliminazione veicoli post-opt", type: "bool" },
      { path: "vspAdvanced.vehicleEliminationMaxPasses", label: "Passate eliminazione", type: "int", unit: "n", min: 0, max: 50 },
      { path: "vspAdvanced.vehicleEliminationTimeSec", label: "Tempo eliminazione", type: "int", unit: "sec", min: 0, max: 600, step: 5 },
      { path: "vspAdvanced.enableIterativeReduction", label: "Riduzione iterativa (N-1, N-2…)", type: "bool" },
      { path: "vspAdvanced.iterativeReductionTimeSec", label: "Tempo riduzione iterativa", type: "int", unit: "sec", min: 0, max: 1200, step: 10 },
    ],
  },
  {
    id: "vspShape",
    title: "Forma turni e archi (avanzate)",
    description: "Bilanciamento durata, gap nastro-lavoro, finestre archi.",
    advanced: true,
    fields: [
      { path: "vehicleCosts.targetShiftDuration", label: "Durata turno target", type: "int", unit: "min", min: 120, max: 900 },
      { path: "vehicleCosts.balanceCoeff", label: "Coeff. sbilanciamento (quad.)", type: "float", min: 0, max: 0.01, step: 0.0001 },
      { path: "vehicleCosts.gapCoeff", label: "Coeff. gap nastro-lavoro (quad.)", type: "float", min: 0, max: 0.01, step: 0.0001 },
      { path: "vehicleCosts.maxIdleForArcMin", label: "Finestra max per arco", type: "int", unit: "min", min: 30, max: 1200, step: 10 },
      { path: "vehicleCosts.terminalClusterRadiusM", label: "Raggio cluster capolinea", type: "int", unit: "m", min: 0, max: 2000, step: 10 },
      { path: "vehicleCosts.minDeadheadKm", label: "Deadhead trascurabile sotto", type: "float", unit: "km", min: 0, max: 5, step: 0.1 },
      { path: "vehicleCosts.downsizePeakPerLevelPerMin", label: "Downsize in punta", type: "float", unit: "€/min", min: 0, max: 2, step: 0.01 },
      { path: "vehicleCosts.downsizeOffpeakPerLevelPerMin", label: "Downsize fuori punta", type: "float", unit: "€/min", min: 0, max: 2, step: 0.01 },
    ],
  },
  {
    id: "vspSpeed",
    title: "Velocità medie (stima km)",
    description: "Velocità per stimare i km da tempo, per categoria.",
    advanced: true,
    fields: [
      { path: "vehicleCosts.avgServiceSpeed.urbano", label: "Servizio urbano", type: "float", unit: "km/h", min: 1, max: 120, step: 1 },
      { path: "vehicleCosts.avgServiceSpeed.extraurbano", label: "Servizio extraurbano", type: "float", unit: "km/h", min: 1, max: 120, step: 1 },
    ],
  },
  {
    id: "vspPortfolio",
    title: "Portfolio multi-scenario (avanzate)",
    description: "Diversificazione e numero scenari del solver.",
    advanced: true,
    fields: [
      { path: "vspAdvanced.scenariosOverride", label: "Numero scenari (0 = auto)", type: "int", unit: "n", min: 0, max: 200 },
      { path: "vspAdvanced.enableNoGoodCuts", label: "No-good cuts (diversità)", type: "bool" },
      { path: "vspAdvanced.minArcDiffPct", label: "Diff. archi minima", type: "float", unit: "×", min: 0, max: 1, step: 0.01 },
      { path: "vspAdvanced.minArcDiffAbs", label: "Diff. archi minima (abs)", type: "int", unit: "n", min: 0, max: 100 },
      { path: "vspAdvanced.warmstartSplit", label: "Frazione senza warm-start", type: "float", unit: "×", min: 0, max: 1, step: 0.05 },
      { path: "vspAdvanced.greedyPerturbations", label: "Perturbazioni greedy", type: "int", unit: "n", min: 0, max: 20 },
      { path: "vspAdvanced.strategyAmplifier", label: "Amplificatore strategie", type: "float", unit: "×", min: 0.5, max: 5, step: 0.1 },
    ],
  },
  {
    id: "vspPolish",
    title: "Rifinitura / local search (avanzate)",
    advanced: true,
    fields: [
      { path: "vspAdvanced.enablePolish", label: "Polish finale", type: "bool" },
      { path: "vspAdvanced.polishTimePct", label: "Frazione tempo polish", type: "float", unit: "×", min: 0, max: 0.9, step: 0.01 },
      { path: "vspAdvanced.lsNoImproveLimit", label: "Limite no-improve local search", type: "int", unit: "n", min: 0, max: 5000, step: 50 },
    ],
  },
];
