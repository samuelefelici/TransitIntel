/**
 * optimizer-rules — Schema dichiarativo dei parametri/regole dell'ottimizzatore
 * turni guida (crew_scheduler_v4.py), fonte UNICA di verità per il pannello
 * "Parametri & Regole" che l'operatore compila prima del run.
 *
 * Ogni campo è mappato sul percorso ESATTO che il solver Python legge
 * (BDSConfig.from_config / apply_shift_rules_override / apply_optimizer_overrides
 * / CostRates.from_config). I default coincidono con le regole attuali.
 *
 * IMPORTANTE — multi-azienda: tutti i valori sono modificabili. I default per
 * servizio (urbano/extraurbano/misto) fungono da preset iniziale ma restano
 * editabili; i profili-regole salvati (DB) permettono il riuso tra aziende.
 *
 * NB: weights / maxRounds / taskGranularity / enableCrossCluster NON sono esposti
 * perché letti solo dal vecchio crew_scheduler_cpsat.py (v3), non dal v4 attivo:
 * sarebbero controlli morti.
 */
import type { OperatorConfig } from "@/hooks/use-crew-optimization";

export type ServiceType = "urbano" | "extraurbano" | "misto";

export type FieldType = "int" | "float" | "bool" | "enum" | "time";

export interface FieldDef {
  /** percorso puntato dentro OperatorConfig (es. "bds.prePost.preTurnoDeposito") */
  path: string;
  label: string;
  type: FieldType;
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  options?: { value: string; label: string }[];
  /** in sezione "Avanzate" (parametri rischiosi/tecnici) */
  advanced?: boolean;
  /** limite normativo RD 131/1938 → avviso se modificato */
  normative?: boolean;
  help?: string;
}

export interface GroupDef {
  id: string;
  title: string;
  description?: string;
  /** i default variano per tipo servizio (shiftRules, targetWork) */
  serviceTypeScoped?: boolean;
  advanced?: boolean;
  fields: FieldDef[];
}

/* ─── Profili per tipo servizio (preset iniziale, editabile) ──────────────
 * Coprono SOLO i gruppi service-scoped: regole turno + target carico orario.
 * I cap % sono SOFT lato solver (penalizzati, non vincoli hard). */
export const SERVICE_PROFILES: Record<
  ServiceType,
  {
    shiftRules: NonNullable<NonNullable<OperatorConfig["bds"]>["shiftRules"]>;
    targetWork: { low: number; high: number; mid: number };
  }
> = {
  urbano: {
    shiftRules: {
      intero: { maxNastro: 435, maxLavoro: 435, sostaMinCapolinea: 15 },
      semiunico: { maxNastro: 555, maxLavoro: 480, intMin: 75, intMax: 179, maxPct: 12 },
      spezzato: { maxNastro: 630, maxLavoro: 450, intMin: 180, intMax: 999, maxPct: 13 },
      supplemento: { maxNastro: 150, maxLavoro: 150 },
    },
    targetWork: { low: 390, high: 435, mid: 408 },
  },
  // Extraurbano (Accordo Quadro 18/05/2012): unico 8h, semiunico 40'–2h59'/9h,
  // spezzato ≥3h/10h30 cap 9%, semiunici cap 39% (soft).
  extraurbano: {
    shiftRules: {
      intero: { maxNastro: 480, maxLavoro: 480, sostaMinCapolinea: 15 },
      semiunico: { maxNastro: 540, maxLavoro: 540, intMin: 40, intMax: 179, maxPct: 39 },
      spezzato: { maxNastro: 630, maxLavoro: 630, intMin: 180, intMax: 999, maxPct: 9 },
      supplemento: { maxNastro: 150, maxLavoro: 150 },
    },
    targetWork: { low: 372, high: 402, mid: 402 },
  },
  // Misto: superset permissivo (v1).
  misto: {
    shiftRules: {
      intero: { maxNastro: 480, maxLavoro: 480, sostaMinCapolinea: 15 },
      semiunico: { maxNastro: 555, maxLavoro: 540, intMin: 40, intMax: 179, maxPct: 39 },
      spezzato: { maxNastro: 630, maxLavoro: 630, intMin: 180, intMax: 999, maxPct: 13 },
      supplemento: { maxNastro: 150, maxLavoro: 150 },
    },
    targetWork: { low: 390, high: 435, mid: 408 },
  },
};

/* ─── Default NON service-scoped (uguali per tutti i servizi) ──────────────
 * Allineati ai default Python (optimizer_common.py / cost_model.py). */
export const DEFAULT_BDS: Record<string, any> = {
  rd131: { attivo: true, maxGuidaContinuativa: 270, sostaMinima: 15, maxLavoroGiornaliero: 435 },
  prePost: {
    preTurnoDeposito: 12, preTurnoCambio: 5, postTurnoDeposito: 0, postTurnoCambio: 0,
    preRipresa: 12, postRipresa: 0, prePezzoCambio: 3, postPezzoCambio: 2,
  },
  pasto: {
    attivo: true,
    pranzoControlloInizio: 720, pranzoControlloFine: 840,
    pranzoSostaInizio: 720, pranzoSostaFine: 900, pranzoSostaMinima: 30,
    cenaControlloInizio: 1140, cenaControlloFine: 1260,
    cenaSostaInizio: 1140, cenaSostaFine: 1350, cenaSostaMinima: 30,
  },
  riprese: {
    maxRiprese: 2, maxDurataRipresa: 480, maxGuidaPerRipresa: 270,
    sostaCheSpezza: 75, comprendiPrePost: true,
  },
  stacco: { traPezziGuida: 5, perCollegamentoVettura: 3, stessoVeicolo: 0 },
  copertura: {
    minSostaCambioUrbano: 5, minSostaCambioExtra: 10, minSostaDeposito: 0,
    modalitaDefault: "IN_TESTA",
  },
  collegamento: {
    trasferimenti: "FORFE_E_VETTURA",
    moltiplicatoreTrasferimenti: 1.0, moltiplicatoreRaggiungimenti: 0.7,
    cuscinettoTrasferimentoMin: 3, durataMassimaRaggiungimento: 60,
    durataMassimaTrasferimento: 45, ammettiDoppi: true,
  },
  optimizer: {
    minWorkPerDuty: 360, maxCompanyCars: 5, weightDutyCount: 20000,
    weightIdlePenalty: 30, idlePenaltyMaxMin: 60, scorePerDuty: 100,
    pctOverPenalty: 150,
  },
  // Fase 2 — avanzate (solo costanti realmente lette a runtime dal v4)
  cuts: { drivingBassoThreshold: 120, minCutGap: 3, collassaMinGap: 45 },
  cutScoring: {
    gapBase: 1.0, gapBonusPerMin: 0.1, clusterBonus: 3.0, noClusterPenalty: 8.0,
    capolineaBonus: 5.0, balanceMax: 5.0, nastroPenaltyPerMin: 0.05, sameRoutePenalty: 15.0,
  },
  scenari: { count: 0, timeFraction: 0.78, polishFraction: 0.20 },
  // Sosta inoperosa (extraurbano): durata minima + contributo all'orario (frazioni)
  // + finestre orarie (min da mezzanotte) + cap soft combinato con i semiunici (%)
  sostaInoperosa: {
    minInterruption: 31, coeffFacilities: 0.12, coeffNoFacilities: 0.25,
    morningEndMax: 915, afternoonStartMin: 710, maxPctWithSemi: 39,
  },
};

export const DEFAULT_COST_RATES: Record<string, number> = {
  hourlyRate: 22, overtimeMultiplier: 1.3, supplementoFixed: 18, supplementoDaily: 95,
  idleRateFraction: 1.0, interruptionRateFraction: 0.0,
  preTurnoRateFraction: 1.0, transferRateFraction: 1.0,
  companyCarPerUse: 8, taxiBase: 6, taxiPerKm: 1.5, taxiPerMinWait: 0.4,
  cambioOverhead: 5, cambioRiskPerMinShort: 2, fragmentationPerGap: 3,
  workImbalancePerMin: 0.5, longIdlePenaltyPerMin: 0.8, extraDriverDaily: 180,
};

export const DEFAULT_SOLVER: Record<string, any> = {
  solverIntensity: 2,
  timeLimit: 240, // allineato al default Maior-style del solver v4
  cutOnlyAtClusters: true,
};

/** Clona in profondità (structuredClone se disponibile, fallback JSON). */
export function deepClone<T>(obj: T): T {
  return typeof structuredClone === "function"
    ? structuredClone(obj)
    : JSON.parse(JSON.stringify(obj));
}

/** Costruisce la config di default completa per un tipo servizio. */
export function buildDefaultConfig(serviceType: ServiceType): OperatorConfig {
  const p = SERVICE_PROFILES[serviceType];
  return {
    ...DEFAULT_SOLVER,
    costRates: { ...DEFAULT_COST_RATES },
    bds: {
      serviceType,
      shiftRules: deepClone(p.shiftRules),
      targetWork: { ...p.targetWork },
      rd131: { ...DEFAULT_BDS.rd131 },
      prePost: { ...DEFAULT_BDS.prePost },
      pasto: { ...DEFAULT_BDS.pasto },
      riprese: { ...DEFAULT_BDS.riprese },
      stacco: { ...DEFAULT_BDS.stacco },
      copertura: { ...DEFAULT_BDS.copertura },
      collegamento: { ...DEFAULT_BDS.collegamento },
      optimizer: { ...DEFAULT_BDS.optimizer },
      cuts: { ...DEFAULT_BDS.cuts },
      cutScoring: { ...DEFAULT_BDS.cutScoring },
      scenari: { ...DEFAULT_BDS.scenari },
      sostaInoperosa: { ...DEFAULT_BDS.sostaInoperosa },
    },
  } as OperatorConfig;
}

/* ─── Definizione gruppi/campi del pannello ───────────────────────────────── */

const COPERTURA_MODE = [
  { value: "IN_TESTA", label: "In testa (chi lascia)" },
  { value: "IN_CODA", label: "In coda (chi prende)" },
];
const TRASFERIMENTI = [
  { value: "VIETATI", label: "Vietati" },
  { value: "SOLO_FORFETTIZZATI", label: "Solo forfettizzati" },
  { value: "SOLO_VETTURA", label: "Solo vettura" },
  { value: "FORFE_E_VETTURA", label: "Forfettizzati + vettura" },
];

function shiftRuleFields(t: "intero" | "semiunico" | "spezzato" | "supplemento", label: string): FieldDef[] {
  const base: FieldDef[] = [
    { path: `bds.shiftRules.${t}.maxNastro`, label: `${label} · nastro max`, type: "int", unit: "min", min: 0, max: 900, normative: true },
    { path: `bds.shiftRules.${t}.maxLavoro`, label: `${label} · lavoro max`, type: "int", unit: "min", min: 0, max: 900, normative: true },
  ];
  if (t === "intero") {
    base.push({ path: `bds.shiftRules.${t}.sostaMinCapolinea`, label: `${label} · sosta min capolinea`, type: "int", unit: "min", min: 0, max: 120 });
  }
  if (t === "semiunico" || t === "spezzato") {
    base.push(
      { path: `bds.shiftRules.${t}.intMin`, label: `${label} · interruzione min`, type: "int", unit: "min", min: 0, max: 600 },
      { path: `bds.shiftRules.${t}.intMax`, label: `${label} · interruzione max`, type: "int", unit: "min", min: 0, max: 999 },
      { path: `bds.shiftRules.${t}.maxPct`, label: `${label} · % max (cap soft)`, type: "int", unit: "%", min: 0, max: 100 },
    );
  }
  return base;
}

export const RULE_GROUPS: GroupDef[] = [
  {
    id: "shiftRules",
    title: "Regole turno (RD 131/1938)",
    description: "Limiti per tipo turno. I cap % sono soft (penalizzati, non vincoli rigidi).",
    serviceTypeScoped: true,
    fields: [
      ...shiftRuleFields("intero", "Intero"),
      ...shiftRuleFields("semiunico", "Semiunico"),
      ...shiftRuleFields("spezzato", "Spezzato"),
      ...shiftRuleFields("supplemento", "Supplemento"),
    ],
  },
  {
    id: "targetWork",
    title: "Target carico orario",
    description: "Orario medio di riferimento per le rotazioni.",
    serviceTypeScoped: true,
    fields: [
      { path: "bds.targetWork.low", label: "Target minimo", type: "int", unit: "min", min: 180, max: 600 },
      { path: "bds.targetWork.mid", label: "Target medio (media oraria)", type: "int", unit: "min", min: 180, max: 600 },
      { path: "bds.targetWork.high", label: "Target massimo", type: "int", unit: "min", min: 180, max: 600 },
    ],
  },
  {
    id: "rd131",
    title: "Guida continuativa (RD 131)",
    description: "Limiti normativi sulla guida continuativa e lavoro giornaliero.",
    fields: [
      { path: "bds.rd131.attivo", label: "Vincolo RD 131 attivo", type: "bool" },
      { path: "bds.rd131.maxGuidaContinuativa", label: "Guida continuativa max", type: "int", unit: "min", min: 60, max: 600, normative: true },
      { path: "bds.rd131.sostaMinima", label: "Sosta minima (reset continuità)", type: "int", unit: "min", min: 1, max: 120, normative: true },
      { path: "bds.rd131.maxLavoroGiornaliero", label: "Lavoro giornaliero max", type: "int", unit: "min", min: 180, max: 720, normative: true },
    ],
  },
  {
    id: "prePost",
    title: "Tempi pre/post turno e ripresa",
    description: "Tempi accessori a inizio/fine turno, ripresa e cambio veicolo.",
    fields: [
      { path: "bds.prePost.preTurnoDeposito", label: "Pre-turno deposito", type: "int", unit: "min", min: 0, max: 60 },
      { path: "bds.prePost.preTurnoCambio", label: "Pre-turno cambio in linea", type: "int", unit: "min", min: 0, max: 60 },
      { path: "bds.prePost.postTurnoDeposito", label: "Post-turno deposito", type: "int", unit: "min", min: 0, max: 60 },
      { path: "bds.prePost.postTurnoCambio", label: "Post-turno cambio in linea", type: "int", unit: "min", min: 0, max: 60 },
      { path: "bds.prePost.preRipresa", label: "Pre-ripresa", type: "int", unit: "min", min: 0, max: 60 },
      { path: "bds.prePost.postRipresa", label: "Post-ripresa", type: "int", unit: "min", min: 0, max: 60 },
      { path: "bds.prePost.prePezzoCambio", label: "Pre-pezzo (cambio veicolo)", type: "int", unit: "min", min: 0, max: 60 },
      { path: "bds.prePost.postPezzoCambio", label: "Post-pezzo (cambio veicolo)", type: "int", unit: "min", min: 0, max: 60 },
    ],
  },
  {
    id: "pasto",
    title: "Intervallo pasto (pranzo/cena)",
    description: "Finestre orarie e durata minima della sosta pasto.",
    fields: [
      { path: "bds.pasto.attivo", label: "Vincolo pasto attivo", type: "bool" },
      { path: "bds.pasto.pranzoControlloInizio", label: "Pranzo · controllo da", type: "time" },
      { path: "bds.pasto.pranzoControlloFine", label: "Pranzo · controllo a", type: "time" },
      { path: "bds.pasto.pranzoSostaInizio", label: "Pranzo · finestra sosta da", type: "time" },
      { path: "bds.pasto.pranzoSostaFine", label: "Pranzo · finestra sosta a", type: "time" },
      { path: "bds.pasto.pranzoSostaMinima", label: "Pranzo · sosta minima", type: "int", unit: "min", min: 0, max: 180 },
      { path: "bds.pasto.cenaControlloInizio", label: "Cena · controllo da", type: "time" },
      { path: "bds.pasto.cenaControlloFine", label: "Cena · controllo a", type: "time" },
      { path: "bds.pasto.cenaSostaInizio", label: "Cena · finestra sosta da", type: "time" },
      { path: "bds.pasto.cenaSostaFine", label: "Cena · finestra sosta a", type: "time" },
      { path: "bds.pasto.cenaSostaMinima", label: "Cena · sosta minima", type: "int", unit: "min", min: 0, max: 180 },
    ],
  },
  {
    id: "riprese",
    title: "Riprese e stacchi",
    description: "Numero/durata riprese e stacchi minimi tra pezzi guida.",
    fields: [
      { path: "bds.riprese.maxRiprese", label: "Max riprese per turno", type: "int", unit: "n", min: 1, max: 4 },
      { path: "bds.riprese.maxDurataRipresa", label: "Durata max ripresa", type: "int", unit: "min", min: 60, max: 720 },
      { path: "bds.riprese.maxGuidaPerRipresa", label: "Guida max per ripresa", type: "int", unit: "min", min: 60, max: 600 },
      { path: "bds.riprese.sostaCheSpezza", label: "Sosta che determina spezzatura", type: "int", unit: "min", min: 30, max: 600 },
      { path: "bds.riprese.comprendiPrePost", label: "Includi pre/post nella durata sosta", type: "bool" },
      { path: "bds.stacco.traPezziGuida", label: "Stacco tra pezzi (cambio veicolo)", type: "int", unit: "min", min: 0, max: 60 },
      { path: "bds.stacco.perCollegamentoVettura", label: "Stacco collegamento passeggero", type: "int", unit: "min", min: 0, max: 60 },
      { path: "bds.stacco.stessoVeicolo", label: "Stacco stesso veicolo", type: "int", unit: "min", min: 0, max: 60 },
    ],
  },
  {
    id: "copertura",
    title: "Copertura soste (punti di cambio)",
    description: "Quando una sosta su un punto di cambio è coperta e da chi.",
    fields: [
      { path: "bds.copertura.minSostaCambioUrbano", label: "Sosta min cambio urbano", type: "int", unit: "min", min: 0, max: 120 },
      { path: "bds.copertura.minSostaCambioExtra", label: "Sosta min cambio extraurbano", type: "int", unit: "min", min: 0, max: 120 },
      { path: "bds.copertura.minSostaDeposito", label: "Sosta min deposito", type: "int", unit: "min", min: 0, max: 120 },
      { path: "bds.copertura.modalitaDefault", label: "Modalità copertura", type: "enum", options: COPERTURA_MODE },
    ],
  },
  {
    id: "collegamento",
    title: "Collegamento / trasferimenti",
    description: "Trasferimenti ammessi e relativa retribuzione.",
    advanced: true,
    fields: [
      { path: "bds.collegamento.trasferimenti", label: "Trasferimenti ammessi", type: "enum", options: TRASFERIMENTI },
      { path: "bds.collegamento.moltiplicatoreTrasferimenti", label: "Retribuzione trasferimenti", type: "float", unit: "×", min: 0, max: 2, step: 0.05 },
      { path: "bds.collegamento.moltiplicatoreRaggiungimenti", label: "Retribuzione raggiungimenti", type: "float", unit: "×", min: 0, max: 2, step: 0.05 },
      { path: "bds.collegamento.cuscinettoTrasferimentoMin", label: "Cuscinetto trasferimento", type: "int", unit: "min", min: 0, max: 60 },
      { path: "bds.collegamento.durataMassimaRaggiungimento", label: "Durata max raggiungimento", type: "int", unit: "min", min: 0, max: 180 },
      { path: "bds.collegamento.durataMassimaTrasferimento", label: "Durata max trasferimento", type: "int", unit: "min", min: 0, max: 180 },
      { path: "bds.collegamento.ammettiDoppi", label: "Ammetti forfettizzato + vettura", type: "bool" },
    ],
  },
  {
    id: "sostaInoperosa",
    title: "Sosta inoperosa (extraurbano)",
    description: "Quando l'interruzione avviene a un Nodo di sosta (Planning Studio), fuori residenza, una quota del tempo è retribuita: con strutture 0.12 (=12%), senza 0.25 (=25%). Valida solo entro le finestre orarie.",
    fields: [
      { path: "bds.sostaInoperosa.minInterruption", label: "Durata minima sosta inoperosa", type: "int", unit: "min", min: 0, max: 240 },
      { path: "bds.sostaInoperosa.coeffFacilities", label: "Contributo con strutture", type: "float", unit: "×", min: 0, max: 1, step: 0.01 },
      { path: "bds.sostaInoperosa.coeffNoFacilities", label: "Contributo senza strutture", type: "float", unit: "×", min: 0, max: 1, step: 0.01 },
      { path: "bds.sostaInoperosa.morningEndMax", label: "Fine ripresa mattino entro", type: "time" },
      { path: "bds.sostaInoperosa.afternoonStartMin", label: "Inizio ripresa pomeriggio dopo", type: "time" },
      { path: "bds.sostaInoperosa.maxPctWithSemi", label: "% max (con semiunici, cap soft)", type: "int", unit: "%", min: 0, max: 100 },
    ],
  },
  {
    id: "costRates",
    title: "Modello costi conducente",
    description: "Tariffe unitarie per il calcolo costi (€).",
    fields: [
      { path: "costRates.hourlyRate", label: "Tariffa oraria", type: "float", unit: "€/h", min: 0, max: 100, step: 0.5 },
      { path: "costRates.overtimeMultiplier", label: "Moltiplicatore straordinario", type: "float", unit: "×", min: 1, max: 3, step: 0.05 },
      { path: "costRates.supplementoFixed", label: "Indennità fissa supplemento", type: "float", unit: "€", min: 0, max: 200, step: 1 },
      { path: "costRates.supplementoDaily", label: "Costo medio turno supplemento", type: "float", unit: "€", min: 0, max: 400, step: 1 },
      { path: "costRates.extraDriverDaily", label: "Costo autista extra/giorno", type: "float", unit: "€", min: 0, max: 600, step: 5 },
      { path: "costRates.companyCarPerUse", label: "Auto aziendale per uso", type: "float", unit: "€", min: 0, max: 100, step: 0.5 },
      { path: "costRates.cambioOverhead", label: "Overhead cambio linea", type: "float", unit: "€", min: 0, max: 100, step: 0.5 },
      { path: "costRates.idleRateFraction", label: "Attesa capolinea retribuita", type: "float", unit: "×", min: 0, max: 1, step: 0.05 },
      { path: "costRates.interruptionRateFraction", label: "Interruzione retribuita", type: "float", unit: "×", min: 0, max: 1, step: 0.05 },
      { path: "costRates.workImbalancePerMin", label: "Penalità sbilanciamento", type: "float", unit: "€/min", min: 0, max: 5, step: 0.05, advanced: true },
      { path: "costRates.longIdlePenaltyPerMin", label: "Penalità attese lunghe", type: "float", unit: "€/min", min: 0, max: 5, step: 0.05, advanced: true },
      { path: "costRates.fragmentationPerGap", label: "Penalità frammentazione/gap", type: "float", unit: "€", min: 0, max: 50, step: 0.5, advanced: true },
      { path: "costRates.taxiBase", label: "Taxi · base", type: "float", unit: "€", min: 0, max: 100, step: 0.5, advanced: true },
      { path: "costRates.taxiPerKm", label: "Taxi · €/km", type: "float", unit: "€/km", min: 0, max: 10, step: 0.1, advanced: true },
      { path: "costRates.taxiPerMinWait", label: "Taxi · €/min attesa", type: "float", unit: "€/min", min: 0, max: 5, step: 0.05, advanced: true },
      { path: "costRates.cambioRiskPerMinShort", label: "Penalità cambio gap corto", type: "float", unit: "€/min", min: 0, max: 10, step: 0.1, advanced: true },
      { path: "costRates.preTurnoRateFraction", label: "Pre-turno retribuito", type: "float", unit: "×", min: 0, max: 1, step: 0.05, advanced: true },
      { path: "costRates.transferRateFraction", label: "Trasferimento retribuito", type: "float", unit: "×", min: 0, max: 1, step: 0.05, advanced: true },
    ],
  },
  {
    id: "optimizer",
    title: "Saturazione e penalità (avanzate)",
    description: "Iperparametri del solver CP-SAT. Modificare con cautela.",
    advanced: true,
    fields: [
      { path: "bds.optimizer.minWorkPerDuty", label: "Min lavoro per turno (saturazione)", type: "int", unit: "min", min: 0, max: 600 },
      { path: "bds.optimizer.maxCompanyCars", label: "Max vetture aziendali (cap)", type: "int", unit: "n", min: 0, max: 50 },
      { path: "bds.optimizer.weightDutyCount", label: "Peso minimizzazione n. turni", type: "int", unit: "", min: 0, max: 100000, step: 1000 },
      { path: "bds.optimizer.weightIdlePenalty", label: "Peso penalità idle", type: "int", unit: "/min", min: 0, max: 500 },
      { path: "bds.optimizer.idlePenaltyMaxMin", label: "Cap idle penalizzato", type: "int", unit: "min", min: 0, max: 240 },
      { path: "bds.optimizer.scorePerDuty", label: "Score bonus per turno", type: "int", unit: "", min: 0, max: 1000 },
      { path: "bds.optimizer.pctOverPenalty", label: "Penalità oltre cap % (soft)", type: "int", unit: "", min: 0, max: 1000 },
    ],
  },
  {
    id: "cuts",
    title: "Soglie tagli e classificazione (avanzate)",
    description: "Soglie che governano dove e come spezzare i blocchi vettura.",
    advanced: true,
    fields: [
      { path: "bds.cuts.drivingBassoThreshold", label: "Soglia guida bassa (CORTO_BASSO)", type: "int", unit: "min", min: 0, max: 480 },
      { path: "bds.cuts.minCutGap", label: "Gap minimo per un taglio", type: "int", unit: "min", min: 0, max: 60 },
      { path: "bds.cuts.collassaMinGap", label: "Gap minimo tra tagli (collasso)", type: "int", unit: "min", min: 0, max: 180 },
    ],
  },
  {
    id: "cutScoring",
    title: "Scoring tagli (avanzate)",
    description: "Pesi euristici che orientano la scelta del punto di taglio.",
    advanced: true,
    fields: [
      { path: "bds.cutScoring.gapBase", label: "Score base (taglio con gap)", type: "float", min: 0, max: 50, step: 0.1 },
      { path: "bds.cutScoring.gapBonusPerMin", label: "Bonus per min di gap (oltre 5')", type: "float", min: 0, max: 5, step: 0.05 },
      { path: "bds.cutScoring.clusterBonus", label: "Bonus taglio su cluster", type: "float", min: 0, max: 50, step: 0.5 },
      { path: "bds.cutScoring.noClusterPenalty", label: "Penalità taglio non-cluster", type: "float", min: 0, max: 50, step: 0.5 },
      { path: "bds.cutScoring.capolineaBonus", label: "Bonus taglio al capolinea", type: "float", min: 0, max: 50, step: 0.5 },
      { path: "bds.cutScoring.balanceMax", label: "Bonus max bilanciamento guida", type: "float", min: 0, max: 50, step: 0.5 },
      { path: "bds.cutScoring.nastroPenaltyPerMin", label: "Penalità nastro over-limit/min", type: "float", min: 0, max: 5, step: 0.01 },
      { path: "bds.cutScoring.sameRoutePenalty", label: "Penalità taglio stessa linea", type: "float", min: 0, max: 50, step: 0.5 },
    ],
  },
  {
    id: "scenari",
    title: "Multi-scenario (avanzate)",
    description: "Numero di scenari esplorati e ripartizione del tempo. count=0 ⇒ auto da intensità.",
    advanced: true,
    fields: [
      { path: "bds.scenari.count", label: "Numero scenari (0 = auto)", type: "int", unit: "n", min: 0, max: 200 },
      { path: "bds.scenari.timeFraction", label: "Frazione tempo agli scenari", type: "float", unit: "×", min: 0.1, max: 1, step: 0.01 },
      { path: "bds.scenari.polishFraction", label: "Frazione tempo alla rifinitura", type: "float", unit: "×", min: 0, max: 0.9, step: 0.01 },
    ],
  },
  {
    id: "solver",
    title: "Motore solver",
    description: "Intensità e tempo di calcolo.",
    advanced: true,
    fields: [
      { path: "solverIntensity", label: "Intensità solver", type: "enum", options: [
        { value: "1", label: "1 · rapida" },
        { value: "2", label: "2 · media" },
        { value: "3", label: "3 · alta" },
        { value: "4", label: "4 · massima" },
      ] },
      { path: "timeLimit", label: "Timeout solver", type: "int", unit: "sec", min: 30, max: 900, step: 10 },
      { path: "cutOnlyAtClusters", label: "Cambi solo su cluster definiti", type: "bool" },
    ],
  },
];

/* ─── Helper get/set per percorso puntato (immutabile) ────────────────────── */

export function getByPath(obj: any, path: string): any {
  return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/** Ritorna una NUOVA config con il valore impostato al percorso indicato. */
export function setByPath<T extends object>(obj: T, path: string, value: any): T {
  const keys = path.split(".");
  const clone: any = Array.isArray(obj) ? [...obj] : { ...obj };
  let cur = clone;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    cur[k] = cur[k] == null ? {} : (Array.isArray(cur[k]) ? [...cur[k]] : { ...cur[k] });
    cur = cur[k];
  }
  cur[keys[keys.length - 1]] = value;
  return clone;
}

/** Valore di default per un campo, dato il tipo servizio (gestisce gli scoped). */
export function defaultForPath(path: string, serviceType: ServiceType): any {
  const def = buildDefaultConfig(serviceType);
  return getByPath(def, path);
}

/** true se il valore corrente differisce dal default del tipo servizio. */
export function isModified(cfg: any, path: string, serviceType: ServiceType): boolean {
  const cur = getByPath(cfg, path);
  const def = defaultForPath(path, serviceType);
  if (cur === undefined) return false;
  return JSON.stringify(cur) !== JSON.stringify(def);
}

/** Numero di campi modificati rispetto al default, per un gruppo. */
export function countModified(cfg: any, group: GroupDef, serviceType: ServiceType): number {
  return group.fields.filter((f) => isModified(cfg, f.path, serviceType)).length;
}

/** minuti-da-mezzanotte → "HH:MM" */
export function minToHHMM(min: number): string {
  const m = Math.max(0, Math.min(1439, Math.round(min)));
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}
/** "HH:MM" → minuti-da-mezzanotte */
export function hhmmToMin(s: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return 0;
  return Math.max(0, Math.min(1439, Number(m[1]) * 60 + Number(m[2])));
}
