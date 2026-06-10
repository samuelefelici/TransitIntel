/**
 * Builder puri dei FeedMessage GTFS-Realtime (VehiclePositions, TripUpdates).
 * Nessuna dipendenza dal DB: prendono righe già lette dallo schema caronte e
 * producono l'oggetto plain conforme allo schema protobuf (verificato e
 * codificato in routes/gtfs-rt.ts). Separati per essere testabili in vitest.
 */

export interface RtPositionRow {
  vehicle_id: string | null;
  trip_id: string | null;
  route_id: string | null;
  lat: number;
  lon: number;
  speed: number | null;    // km/h (convenzione caronte)
  heading: number | null;  // gradi 0-360
  stop_id: string | null;
  stop_seq: number | null;
  ts_epoch: number;        // unix seconds
}

export interface RtDelayRow {
  trip_id: string;
  route_id: string | null;
  vehicle_id: string | null;
  stop_id: string | null;
  stop_seq: number | null;
  delay_seconds: number;
  ts_epoch: number; // unix seconds
}

function feedHeader(nowSec: number) {
  return {
    gtfsRealtimeVersion: "2.0",
    incrementality: 0, // FULL_DATASET
    timestamp: nowSec,
  };
}

/** FeedMessage VehiclePositions da righe caronte.vehicle_positions. */
export function buildVehiclePositionsFeed(rows: RtPositionRow[], nowSec: number) {
  return {
    header: feedHeader(nowSec),
    entity: rows.map((r, i) => {
      const key = r.vehicle_id ?? r.trip_id ?? String(i);
      return {
        id: `vp-${key}`,
        vehicle: {
          ...(r.trip_id ? { trip: { tripId: r.trip_id, ...(r.route_id ? { routeId: r.route_id } : {}) } } : {}),
          vehicle: { id: key, ...(r.vehicle_id ? { label: r.vehicle_id } : {}) },
          position: {
            latitude: r.lat,
            longitude: r.lon,
            ...(r.heading != null ? { bearing: r.heading } : {}),
            // GTFS-RT vuole m/s; caronte salva km/h
            ...(r.speed != null ? { speed: Math.round((r.speed / 3.6) * 100) / 100 } : {}),
          },
          ...(r.stop_id ? { stopId: r.stop_id } : {}),
          ...(r.stop_seq != null ? { currentStopSequence: r.stop_seq } : {}),
          timestamp: r.ts_epoch,
        },
      };
    }),
  };
}

/** FeedMessage TripUpdates dall'ultimo transito reale di ogni corsa. */
export function buildTripUpdatesFeed(rows: RtDelayRow[], nowSec: number) {
  return {
    header: feedHeader(nowSec),
    entity: rows.map((r) => ({
      id: `tu-${r.trip_id}`,
      tripUpdate: {
        trip: { tripId: r.trip_id, ...(r.route_id ? { routeId: r.route_id } : {}) },
        ...(r.vehicle_id ? { vehicle: { id: r.vehicle_id, label: r.vehicle_id } } : {}),
        // Un solo StopTimeUpdate sull'ultima fermata osservata: per la spec il
        // ritardo si propaga alle fermate successive finché non c'è un altro update.
        stopTimeUpdate: [{
          ...(r.stop_seq != null ? { stopSequence: r.stop_seq } : {}),
          ...(r.stop_id ? { stopId: r.stop_id } : {}),
          arrival: { delay: r.delay_seconds },
          departure: { delay: r.delay_seconds },
        }],
        delay: r.delay_seconds,
        timestamp: r.ts_epoch,
      },
    })),
  };
}
