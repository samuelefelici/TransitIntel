export type ViewMode = "dark" | "city3d" | "city3d-dark" | "satellite";

export interface ScenarioItem {
  id: string;
  name: string;
  description?: string;
  color: string;
  stopsCount: number;
  lengthKm: number;
  createdAt: string;
}

export interface ScenarioFull extends ScenarioItem {
  geojson: any;
  metadata: any;
}

export interface ComuneStats {
  code: string;
  name: string;
  totalPop: number;
  coveredPop: number;
  percent: number;
  totalSections: number;
  coveredSections: number;
  poiTotal: number;
  poiCovered: number;
}

export interface StopDistribution {
  minInterStopKm: number;
  maxInterStopKm: number;
  avgInterStopKm: number;
  medianInterStopKm: number;
  stopsWithin300m: number;
  gapsOver1km: number;
}

export interface AnalysisResult {
  scenario: { id: string; name: string; color: string };
  routes: { name: string; lengthKm: number }[];
  stops: { name: string; lng: number; lat: number }[];
  totalLengthKm: number;
  poiCoverage: {
    radius: number;
    total: number;
    covered: number;
    percent: number;
    byCategory: Record<string, { total: number; covered: number }>;
  };
  populationCoverage: {
    radius: number;
    totalPop: number;
    coveredPop: number;
    percent: number;
    comuniToccati: number;
  };
  comuniDetails: ComuneStats[];
  stopDistribution: StopDistribution | null;
  accessibilityScore: number;
  efficiencyMetrics: {
    popPerKm: number;
    poiPerKm: number;
    costIndex: number;
    stopsPerKm: number;
  };
  gapAnalysis: {
    uncoveredPoi: { category: string; name: string; lng: number; lat: number; distKm: number }[];
    underservedComuni: { code: string; name: string; pop: number; coveragePercent: number }[];
  };
}

export interface CompareScenario {
  id: string;
  name: string;
  color: string;
  totalLengthKm: number;
  stopsCount: number;
  poiCoverage: AnalysisResult["poiCoverage"];
  populationCoverage: AnalysisResult["populationCoverage"];
  efficiency: AnalysisResult["efficiencyMetrics"];
  accessibilityScore: number;
  comuniDetails: ComuneStats[];
  stopDistribution: StopDistribution | null;
  gapAnalysis: AnalysisResult["gapAnalysis"];
}

export interface CompareResult {
  scenarios: CompareScenario[];
  suggestions: string[];
  radius: number;
  unifiedBase?: {
    totalPop: number;
    comuniCount: number;
    comuni: { code: string; name: string; totalPop: number }[];
  };
}

export interface MapPopup {
  lng: number;
  lat: number;
  type: string;
  props: Record<string, any>;
}

export interface PdeConfig {
  targetKm: number;
  serviceStartH: number;
  serviceEndH: number;
  minCadenceMin: number;
  maxCadenceMin: number;
  avgSpeedKmh: number;
  dwellTimeSec: number;
  terminalTimeSec: number;
  bidirectional: boolean;
}
