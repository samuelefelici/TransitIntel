/**
 * Builder puri dei FeedMessage GTFS-Realtime (VehiclePositions, TripUpdates).
 * Nessuna dipendenza dal DB: prendono righe già lette dallo schema caronte e
 * dal consuntivo, e producono l'oggetto plain conforme allo schema protobuf
 * (verificato e codificato in routes/gtfs-rt.ts). Separati per essere
 * testabili in vitest.
 *
 * Gli identificativi (corsa, linea, fermata) arrivano già tradotti nei codici
 * del GTFS pubblicato (routes/gtfs-rt.ts): è con quelli che gli aggregatori
 * abbinano il tempo reale all'orario.
 */

/** TripDescriptor.ScheduleRelationship.CANCELED nello schema GTFS-Realtime. */
export const CORSA_SOPPRESSA = 3;
const ORA_GTFS = /^\d{2}:\d{2}:\d{2}$/;
const DATA_GTFS = /^\d{8}$/;

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
  /** la data della giornata di esercizio della corsa, "YYYYMMDD", se nota */
  start_date?: string | null;
}

export interface RtDelayRow {
  trip_id: string;
  route_id: string | null;
  vehicle_id: string | null;
  stop_id: string | null;
  stop_seq: number | null;
  delay_seconds: number;
  ts_epoch: number; // unix seconds
  /** la data della giornata di esercizio della corsa, "YYYYMMDD", se nota */
  start_date?: string | null;
}

/** Una corsa soppressa nel giornale del consuntivo (tappa 4.5). */
export interface RtCancelRow {
  trip_id: string;
  route_id: string | null;
  /** la giornata di esercizio, "YYYYMMDD" */
  start_date: string;
  /** la partenza programmata, "HH:MM:SS" (anche oltre le 24) */
  start_time: string | null;
}

/** Il TripDescriptor: data (e ora) servono a distinguere la stessa corsa in due giornate, a cavallo della mezzanotte. */
function descrittore(tripId: string, routeId: string | null, startDate?: string | null, startTime?: string | null) {
  return {
    tripId,
    ...(routeId ? { routeId } : {}),
    ...(startDate && DATA_GTFS.test(startDate) ? { startDate } : {}),
    ...(startTime && ORA_GTFS.test(startTime) ? { startTime } : {}),
  };
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
          ...(r.trip_id ? { trip: descrittore(r.trip_id, r.route_id, r.start_date) } : {}),
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

/**
 * FeedMessage TripUpdates: l'ultimo transito reale di ogni corsa, e le corse
 * soppresse nel giornale come CANCELED. Una corsa soppressa non porta anche
 * un ritardo: vale la soppressione.
 */
export function buildTripUpdatesFeed(rows: RtDelayRow[], nowSec: number, soppresse: RtCancelRow[] = []) {
  const tolte = new Set(soppresse.map((c) => c.trip_id));
  return {
    header: feedHeader(nowSec),
    entity: [
      ...rows.filter((r) => !tolte.has(r.trip_id)).map((r) => {
        /* Un StopTimeUpdate deve dire la fermata (progressivo o codice): senza
         * nessuno dei due resta solo il ritardo della corsa. Per la spec il
         * ritardo si propaga alle fermate successive finché non c'è un altro
         * update. */
        const fermata = r.stop_seq != null || !!r.stop_id;
        return {
          id: `tu-${r.trip_id}`,
          tripUpdate: {
            trip: descrittore(r.trip_id, r.route_id, r.start_date),
            ...(r.vehicle_id ? { vehicle: { id: r.vehicle_id, label: r.vehicle_id } } : {}),
            ...(fermata ? {
              stopTimeUpdate: [{
                ...(r.stop_seq != null ? { stopSequence: r.stop_seq } : {}),
                ...(r.stop_id ? { stopId: r.stop_id } : {}),
                arrival: { delay: r.delay_seconds },
                departure: { delay: r.delay_seconds },
              }],
            } : {}),
            delay: r.delay_seconds,
            timestamp: r.ts_epoch,
          },
        };
      }),
      ...soppresse.map((c) => ({
        id: `tu-${c.trip_id}`,
        tripUpdate: {
          trip: { ...descrittore(c.trip_id, c.route_id, c.start_date, c.start_time), scheduleRelationship: CORSA_SOPPRESSA },
          timestamp: nowSec,
        },
      })),
    ],
  };
}
