/** Shared types for the Dashboard module */

export type DayFilter = "tutti" | "feriale" | "sabato" | "domenica";
export type ViewMode = "dark" | "satellite" | "city3d" | "city3d-dark";

export interface GtfsSummary {
  available: boolean;
  totalRoutes: number;
  totalStops: number;
  totalTrips: number;
  weekdayTrips: number;
  saturdayTrips: number;
  sundayTrips: number;
  weekdayRoutes?: number;
  saturdayRoutes?: number;
  sundayRoutes?: number;
  weekdayStops?: number;
  saturdayStops?: number;
  sundayStops?: number;
  weekdayKm?: number;
  saturdayKm?: number;
  sundayKm?: number;
  firstDeparture?: string;
  lastArrival?: string;
  topRoutes: { name: string; color: string; trips: number }[];
}

export interface RouteItem {
  routeId: string;
  routeShortName?: string;
  routeLongName?: string;
  routeColor?: string;
  tripsCount?: number;
}

export interface GtfsStop {
  stopId: string;
  stopCode?: string;
  stopName: string;
  stopDesc?: string;
  stopLat: number;
  stopLon: number;
  tripsCount: number;
  morningPeakTrips: number;
  eveningPeakTrips: number;
  serviceScore: number;
  wheelchairBoarding?: number;
}

export interface MapPopup {
  lng: number;
  lat: number;
  type: "traffic" | "poi" | "gtfsStop" | "shape" | "census";
  props: Record<string, any>;
}

export interface WalkData {
  minutes: number;
  totalPopulation: number;
  coveredPopulation: number;
  coveragePercent: number;
  totalStops: number;
  sampledStops: number;
  note?: string;
  stops: { stopId: string; stopName: string; lat: number; lng: number; coveredPop: number }[];
  isochroneUnion: GeoJSON.FeatureCollection;
  municipalities?: { code: string; name: string; totalPop: number; coveredPop: number; percent: number }[];
}

export interface LayersState {
  traffic: boolean;
  mapboxTraffic: boolean;
  demand: boolean;
  poi: boolean;
  gtfsStops: boolean;
  gtfsShapes: boolean;
  buildings: boolean;
}
