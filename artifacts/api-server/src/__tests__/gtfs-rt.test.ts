import { describe, it, expect } from "vitest";
import GtfsRealtimeBindings from "gtfs-realtime-bindings";
import {
  buildVehiclePositionsFeed, buildTripUpdatesFeed, CORSA_SOPPRESSA,
  type RtPositionRow, type RtDelayRow, type RtCancelRow,
} from "../lib/gtfs-rt-builders";

const { FeedMessage } = GtfsRealtimeBindings.transit_realtime;

const NOW = 1_770_000_000;

const POSITIONS: RtPositionRow[] = [
  {
    vehicle_id: "BUS-01", trip_id: "trip-123", route_id: "R1",
    lat: 43.6168, lon: 13.5186, speed: 36, heading: 270,
    stop_id: "stop-9", stop_seq: 4, ts_epoch: NOW - 5,
  },
  {
    // mezzo senza matricola: chiave = trip_id, campi opzionali assenti
    vehicle_id: null, trip_id: "trip-456", route_id: null,
    lat: 43.60, lon: 13.50, speed: null, heading: null,
    stop_id: null, stop_seq: null, ts_epoch: NOW - 8,
  },
];

const DELAYS: RtDelayRow[] = [
  {
    trip_id: "trip-123", route_id: "R1", vehicle_id: "BUS-01",
    stop_id: "stop-9", stop_seq: 4, delay_seconds: 180, ts_epoch: NOW - 5,
  },
  {
    trip_id: "trip-456", route_id: null, vehicle_id: null,
    stop_id: null, stop_seq: null, delay_seconds: -90, ts_epoch: NOW - 8,
  },
];

describe("gtfs-rt builders", () => {
  describe("buildVehiclePositionsFeed", () => {
    it("produces a payload valid per the official protobuf schema", () => {
      const payload = buildVehiclePositionsFeed(POSITIONS, NOW);
      expect(FeedMessage.verify(payload)).toBeNull();
    });

    it("survives an encode/decode roundtrip with correct fields", () => {
      const payload = buildVehiclePositionsFeed(POSITIONS, NOW);
      const buf = FeedMessage.encode(FeedMessage.fromObject(payload)).finish();
      const decoded = FeedMessage.toObject(FeedMessage.decode(buf), { longs: Number });

      expect(decoded.header.gtfsRealtimeVersion).toBe("2.0");
      expect(decoded.header.timestamp).toBe(NOW);
      expect(decoded.entity).toHaveLength(2);

      const e0 = decoded.entity[0];
      expect(e0.id).toBe("vp-BUS-01");
      expect(e0.vehicle.trip.tripId).toBe("trip-123");
      expect(e0.vehicle.trip.routeId).toBe("R1");
      expect(e0.vehicle.vehicle.id).toBe("BUS-01");
      expect(e0.vehicle.position.latitude).toBeCloseTo(43.6168, 4);
      expect(e0.vehicle.position.longitude).toBeCloseTo(13.5186, 4);
      expect(e0.vehicle.position.bearing).toBe(270);
      // 36 km/h → 10 m/s (GTFS-RT usa m/s)
      expect(e0.vehicle.position.speed).toBeCloseTo(10, 2);
      expect(e0.vehicle.stopId).toBe("stop-9");
      expect(e0.vehicle.currentStopSequence).toBe(4);
      expect(e0.vehicle.timestamp).toBe(NOW - 5);
    });

    it("keys unnamed vehicles by trip_id and omits optional fields", () => {
      const payload = buildVehiclePositionsFeed(POSITIONS, NOW);
      const buf = FeedMessage.encode(FeedMessage.fromObject(payload)).finish();
      const decoded = FeedMessage.toObject(FeedMessage.decode(buf), { longs: Number });

      const e1 = decoded.entity[1];
      expect(e1.id).toBe("vp-trip-456");
      expect(e1.vehicle.vehicle.id).toBe("trip-456");
      expect(e1.vehicle.position.bearing).toBeUndefined();
      expect(e1.vehicle.position.speed).toBeUndefined();
      expect(e1.vehicle.stopId).toBeUndefined();
    });

    it("emits a valid empty feed when no vehicles are online", () => {
      const payload = buildVehiclePositionsFeed([], NOW);
      expect(FeedMessage.verify(payload)).toBeNull();
      const buf = FeedMessage.encode(FeedMessage.fromObject(payload)).finish();
      const decoded = FeedMessage.toObject(FeedMessage.decode(buf), { longs: Number });
      expect(decoded.entity ?? []).toHaveLength(0);
    });
  });

  describe("buildTripUpdatesFeed", () => {
    it("produces a payload valid per the official protobuf schema", () => {
      const payload = buildTripUpdatesFeed(DELAYS, NOW);
      expect(FeedMessage.verify(payload)).toBeNull();
    });

    it("propagates delay (positive and negative) through the roundtrip", () => {
      const payload = buildTripUpdatesFeed(DELAYS, NOW);
      const buf = FeedMessage.encode(FeedMessage.fromObject(payload)).finish();
      const decoded = FeedMessage.toObject(FeedMessage.decode(buf), { longs: Number });

      expect(decoded.entity).toHaveLength(2);

      const t0 = decoded.entity[0].tripUpdate;
      expect(t0.trip.tripId).toBe("trip-123");
      expect(t0.vehicle.id).toBe("BUS-01");
      expect(t0.stopTimeUpdate).toHaveLength(1);
      expect(t0.stopTimeUpdate[0].stopSequence).toBe(4);
      expect(t0.stopTimeUpdate[0].stopId).toBe("stop-9");
      expect(t0.stopTimeUpdate[0].arrival.delay).toBe(180);
      expect(t0.stopTimeUpdate[0].departure.delay).toBe(180);
      expect(t0.delay).toBe(180);

      // anticipo: delay negativo deve sopravvivere alla codifica (int32 signed).
      // Senza progressivo né fermata niente StopTimeUpdate (la spec ne vuole
      // uno dei due): resta il ritardo della corsa.
      const t1 = decoded.entity[1].tripUpdate;
      expect(t1.trip.tripId).toBe("trip-456");
      expect(t1.stopTimeUpdate ?? []).toHaveLength(0);
      expect(t1.delay).toBe(-90);
    });

    const SOPPRESSE: RtCancelRow[] = [
      { trip_id: "trip-123", route_id: "R1", start_date: "20261116", start_time: "07:45:00" },
      { trip_id: "trip-789", route_id: null, start_date: "20261116", start_time: "25:10:00" },
      { trip_id: "trip-999", route_id: null, start_date: "16-11-2026", start_time: "7:45" },
    ];

    it("emits the cancelled trips as CANCELED, with date and time, and drops their delay", () => {
      const payload = buildTripUpdatesFeed(DELAYS, NOW, SOPPRESSE);
      expect(FeedMessage.verify(payload)).toBeNull();
      const buf = FeedMessage.encode(FeedMessage.fromObject(payload)).finish();
      const decoded = FeedMessage.toObject(FeedMessage.decode(buf), { longs: Number });
      const per = Object.fromEntries(decoded.entity.map((e: any) => [e.id, e.tripUpdate]));
      expect(Object.keys(per).sort()).toEqual(["tu-trip-123", "tu-trip-456", "tu-trip-789", "tu-trip-999"]);
      expect(per["tu-trip-123"].trip).toEqual({ tripId: "trip-123", routeId: "R1", startDate: "20261116", startTime: "07:45:00", scheduleRelationship: CORSA_SOPPRESSA });
      expect(per["tu-trip-123"].stopTimeUpdate ?? []).toHaveLength(0);
      expect(per["tu-trip-123"].delay).toBeUndefined();
      // oltre le 24 ore resta un orario GTFS valido
      expect(per["tu-trip-789"].trip.startTime).toBe("25:10:00");
      // data e ora malformate non escono
      expect(per["tu-trip-999"].trip.startDate).toBeUndefined();
      expect(per["tu-trip-999"].trip.startTime).toBeUndefined();
      expect(per["tu-trip-456"].delay).toBe(-90);
    });

    it("carries the service date of a delayed trip when known", () => {
      const payload = buildTripUpdatesFeed([{ ...DELAYS[0]!, start_date: "20261116" }], NOW);
      expect(FeedMessage.verify(payload)).toBeNull();
      const decoded = FeedMessage.toObject(FeedMessage.decode(FeedMessage.encode(FeedMessage.fromObject(payload)).finish()), { longs: Number });
      expect(decoded.entity[0].tripUpdate.trip).toEqual({ tripId: "trip-123", routeId: "R1", startDate: "20261116" });
    });
  });
});
