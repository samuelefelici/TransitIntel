/**
 * Le letture di traffico, meteo, analisi del territorio e punti d'interesse
 * usate da Traffico, Territorio e dalla Mappa del territorio.
 *
 * Prima passavano da un client generato da una descrizione OpenAPI
 * (`lib/api-client-react`: 131 hook, di cui se ne usavano questi sette). Qui
 * restano gli stessi sette, con gli stessi indirizzi, gli stessi parametri e
 * le stesse chiavi di cache, sopra `apiFetch` come il resto dell'app.
 */
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { conParametri, type Parametri } from "@/lib/parametri-url";

function useLettura<T>(percorso: string, parametri?: Parametri) {
  return useQuery<T>({
    queryKey: [percorso, ...(parametri ? [parametri] : [])],
    queryFn: ({ signal }) => apiFetch<T>(conParametri(percorso, parametri), { signal }),
  });
}

export const useGetTrafficStats = () => useLettura<TrafficStats>("/api/traffic/stats");
export const useGetTrafficHeatmap = () => useLettura<GetTrafficHeatmap200>("/api/traffic/heatmap");
export const useGetWeatherCurrent = () => useLettura<WeatherSnapshot[]>("/api/weather/current");
export const useGetWeatherCorrelation = (parametri?: { hours?: number }) =>
  useLettura<GetWeatherCorrelation200Item[]>("/api/weather/correlation", parametri);
export const useGetAnalysisStats = () => useLettura<GetAnalysisStats200>("/api/analysis/stats");
export const useGetAnalysisUnderserved = (parametri?: { minScore?: number }) =>
  useLettura<GetAnalysisUnderserved200>("/api/analysis/underserved", parametri);
/** `categories`: le categorie volute, separate da virgola. */
export const useGetPoi = (parametri?: { categories?: string }) => useLettura<GetPoi200>("/api/poi", parametri);

/* ── I tipi delle risposte (com'erano nella descrizione OpenAPI) ───────────── */

export type TrafficStatsCongestionByHourItem = {
  hour?: number;
  avgCongestion?: number;
};

export type TrafficStatsCongestionByDayTypeItem = { [key: string]: unknown };

export type TrafficStatsCongestionByDayType = {
  [key: string]: TrafficStatsCongestionByDayTypeItem[];
};

export type TrafficStatsZoneStatsItem = { [key: string]: unknown };

export interface TrafficStats {
  avgCongestion?: number;
  totalSnapshots?: number;
  lastUpdated?: string;
  peakHour?: number;
  congestionByHour?: TrafficStatsCongestionByHourItem[];
  congestionByDayType?: TrafficStatsCongestionByDayType;
  zoneStats?: TrafficStatsZoneStatsItem[];
  avgSpeed?: number;
  avgFreeflow?: number;
}

export interface TrafficHeatmapPoint {
  lng?: number;
  lat?: number;
  avgCongestion?: number;
  sampleCount?: number;
}

export type GetTrafficHeatmap200 = {
  data?: TrafficHeatmapPoint[];
};

export type GetWeatherCorrelation200Item = {
  weather_main?: string;
  sample_count?: number;
  avg_congestion?: number;
  avg_speed_kmh?: number;
  avg_temp?: number;
  avg_humidity?: number;
  avg_wind_speed?: number;
};

export interface WeatherSnapshot {
  id?: string;
  lat?: number;
  lng?: number;
  locationName?: string;
  /** Temperature in Celsius */
  temp?: number;
  feelsLike?: number;
  humidity?: number;
  /** Wind speed m/s */
  windSpeed?: number;
  /** Main weather group (Clear, Rain, Snow, etc.) */
  weatherMain?: string;
  weatherDescription?: string;
  weatherIcon?: string;
  /**
   * Rain volume last 1h mm
   * @nullable
   */
  rain1h?: number | null;
  /**
   * Snow volume last 1h mm
   * @nullable
   */
  snow1h?: number | null;
  /**
   * Visibility in meters
   * @nullable
   */
  visibility?: number | null;
  capturedAt?: string;
}

export type GetAnalysisUnderserved200DataItem = {
  cellId?: string;
  lng?: number;
  lat?: number;
  score?: number;
  populationScore?: number;
  poiScore?: number;
  trafficScore?: number;
  hasStop?: boolean;
  nearestStopDistanceMeters?: number;
  suggestedStopLng?: number;
  suggestedStopLat?: number;
  populationAffected?: number;
  topPoiCategories?: string[];
  source?: string;
};

export type GetAnalysisUnderserved200 = {
  data?: GetAnalysisUnderserved200DataItem[];
  total?: number;
};

export type GetAnalysisStats200 = { [key: string]: unknown };

export type PoiProperties = { [key: string]: unknown };

export interface Poi {
  id?: string;
  /** @nullable */
  osmId?: number | null;
  name?: string;
  category?: string;
  lng?: number;
  lat?: number;
  properties?: PoiProperties;
}

export type GetPoi200 = {
  data?: Poi[];
  total?: number;
};
