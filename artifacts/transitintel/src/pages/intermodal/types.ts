/* ═══════════════════════════════════════════════════════════════
 *  Intermodal – Type definitions
 * ═══════════════════════════════════════════════════════════════ */

export interface NearbyStop {
  stopId: string; stopName: string; lat: number; lng: number;
  distKm: number; walkMin: number;
}

export interface BusLine {
  routeId: string; routeShortName: string; routeLongName: string;
  routeColor: string | null; tripsCount: number; times: string[];
  destinations: string[];
}

export interface ArrivalConnection {
  origin: string;
  arrivalTime: string;
  walkMin: number;
  atBusStopTime: string;
  firstBus: {
    departureTime: string; routeShortName: string; routeLongName: string;
    stopName: string; waitMin: number; destination: string;
  } | null;
  allBusOptions: { departureTime: string; routeShortName: string; waitMin: number; destination: string }[];
  justMissed: { departureTime: string; routeShortName: string; missedByMin: number; destination: string }[];
  status: "ok" | "long-wait" | "no-bus" | "just-missed";
  totalTransferMin: number | null;
}

export interface DepartureConnection {
  destination: string; departureTime: string;
  bestBusArrival: string | null; bestBusRoute: string | null;
  waitMinutes: number | null; missedBy: number | null;
}

export interface DestinationCoverage {
  destination: string; routeShortName: string; routeLongName: string;
  tripsPerDay: number; firstDeparture: string; lastDeparture: string;
  avgFrequencyMin: number | null;
}

export interface HubGap {
  hour: number; busDepartures: number; hubArrivals: number;
  hubDepartures: number; gap: boolean;
}

export interface WaitBucket { range: string; count: number; }

export interface ArrivalStats {
  totalArrivals: number; withBus: number; noBus: number;
  justMissed: number; longWait: number; ok: number;
  avgWaitMin: number | null; avgTotalTransferMin: number | null;
}

/** Tipi hub prodotti dal backend (bus_terminal mancava e si leggeva con cast). */
export type HubKind = "railway" | "port" | "airport" | "bus_terminal";

/** Provenienza degli orari mostrati: reale, stima interna o assente. */
export type ScheduleSource = "live" | "stima" | "assente";

export interface HubAnalysis {
  hub: {
    id: string; name: string; type: HubKind;
    lat: number; lng: number; description: string; platformWalkMinutes: number;
    source?: "curated" | "gtfs-auto";
    scheduleSource?: ScheduleSource;
    scheduleFetchedAt?: string;
  };
  serviceScore?: {
    score: number; level: string; linesServing: number; destinationsReached: number;
    hoursCovered: number; avgFrequencyMin: number | null;
  };
  isServed: boolean;
  nearbyStops: NearbyStop[];
  busLines: BusLine[];
  arrivalConnections: ArrivalConnection[];
  departureConnections: DepartureConnection[];
  destinationCoverage: DestinationCoverage[];
  gapAnalysis: HubGap[];
  waitDistribution: WaitBucket[];
  arrivalStats: ArrivalStats;
  stats: {
    totalBusTrips: number; totalHubDepartures: number;
    covered: number; missed: number; avgWaitMin: number | null;
  };
}

export interface Suggestion {
  priority: "critical" | "high" | "medium" | "low";
  type: string; hub: string; description: string;
  details?: string; suggestedTimes?: string[];
}

export interface ScheduleProposal {
  action: "add" | "shift" | "extend";
  hubId: string; hubName: string;
  currentTime?: string; proposedTime: string;
  reason: string; impact: string;
}

export interface AnalysisResult {
  hubs: HubAnalysis[];
  summary: {
    totalHubs: number; servedHubs: number;
    totalArrivals: number; arrivalOk: number; arrivalLongWait: number;
    arrivalNoBus: number; arrivalJustMissed: number; arrivalCoveragePercent: number;
    totalDepartures: number; departureCovered: number;
    avgWaitAtStop: number | null; avgTotalTransfer: number | null;
    totalBusLines: number;
    curatedHubs?: number; discoveredHubs?: number;
    /** Quanti hub hanno orari reali, stimati o nessuno */
    hubsWithLiveSchedule?: number;
    hubsWithEstimatedSchedule?: number;
    hubsWithoutSchedule?: number;
  };
  suggestions: Suggestion[];
  proposedSchedule: ScheduleProposal[];
  /** Ambito effettivo dell'analisi (rete, progetto, giorno-tipo) */
  scope?: {
    psProjectId: string | null;
    feedId: string | null;
    day: "feriale" | "sabato" | "festivo";
    calendarApplied: boolean;
    tripsConsidered: number;
    tripsBeforeCalendar: number;
  };
  config: { maxWalkKm: number; walkSpeedKmh: number };
}

export interface HubPoi {
  id: string; name: string | null; category: string;
  lat: number; lng: number; distKm: number; travelContext: string;
}

export interface HubPoisGroup {
  hubId: string; hubName: string; hubType: HubKind;
  hubLat: number; hubLng: number; pois: HubPoi[];
}
