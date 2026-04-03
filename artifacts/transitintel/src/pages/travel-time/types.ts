// ─── Types ────────────────────────────────────────────────────
export type DayType = "weekday" | "saturday" | "sunday";

export interface StopStep {
  stopName: string;
  departureTime: string;
  minsFromFirst: number;
  minsFromPrev: number;
  distFromPrevKm: number;
  congestionPct: number | null;
  extraMin: number | null;
}

export interface ScheduleTrip {
  tripId: string;
  headsign: string | null;
  directionId: number;
  firstDeparture: string;
  lastArrival: string;
  totalMin: number;
  stopCount: number;
  stops: StopStep[];
  totalExtraMin: number;
}

export interface ScheduleData {
  trips: ScheduleTrip[];
  routeColor: string;
  routeShortName: string;
}

export interface SegmentVisual {
  fromIdx: number;
  toIdx: number;
  fromStop: StopPoint;
  toStop: StopPoint;
  distanceKm: number;
  scheduledMin: number;
  scheduledSpeedKmh: number;
  freeflowKmh: number | null;
  currentSpeedKmh: number | null;
  delayPct: number | null;
  congestionPct: number | null;
  extraMin: number | null;
  hasTomTom: boolean;
  segHour: number;
  tomTomSamples: number;
}

export interface StopPoint {
  stopId: string;
  stopName: string;
  lat: number;
  lon: number;
  departureTime: string;
}

export interface TrafficContext {
  hasData: boolean;
  totalSamples: number;
  dateFrom: string | null;
  dateTo: string | null;
  dayTypes: string[];
  matchedHours: number[];
  segmentsWithTomTom: number;
  segmentsWithoutTomTom: number;
}

export interface TripVisual {
  tripId: string;
  routeId: string;
  routeColor: string;
  tripHeadsign: string | null;
  directionId: number;
  stops: (StopPoint & { seq: number; arrivalTime: string })[];
  segments: SegmentVisual[];
  totalDistanceKm: number;
  totalScheduledMin: number;
  trafficContext?: TrafficContext;
}

export interface TrafficAvailability {
  available: boolean;
  totalSnapshots: number;
  dateRange?: { from: string; to: string };
  dates: string[];
  dayTypes: string[];
  hours: number[];
}

export interface RouteItem {
  routeId: string;
  routeShortName: string;
  routeColor: string;
}
