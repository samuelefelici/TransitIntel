import { describe, it, expect } from "vitest";
import {
  haversineKm, lineLength, pointToLineDistance,
  timeToMinutes, minToTime, walkMinutes,
} from "../lib/geo-utils";

describe("geo-utils", () => {
  describe("haversineKm", () => {
    it("returns 0 for same point", () => {
      expect(haversineKm(43.6, 13.5, 43.6, 13.5)).toBe(0);
    });

    it("computes known distance: Rome to Milan ~478km", () => {
      // Rome (41.9028, 12.4964) to Milan (45.4642, 9.1900)
      const dist = haversineKm(41.9028, 12.4964, 45.4642, 9.19);
      expect(dist).toBeGreaterThan(470);
      expect(dist).toBeLessThan(490);
    });

    it("computes short distance: Ancona central area ~1km", () => {
      // Piazza Cavour to Stazione FS Ancona (approx)
      const dist = haversineKm(43.6168, 13.5186, 43.6073, 13.4978);
      expect(dist).toBeGreaterThan(1.5);
      expect(dist).toBeLessThan(3);
    });

    it("is symmetric", () => {
      const d1 = haversineKm(43.6, 13.5, 44.0, 13.8);
      const d2 = haversineKm(44.0, 13.8, 43.6, 13.5);
      expect(d1).toBeCloseTo(d2, 10);
    });
  });

  describe("lineLength", () => {
    it("returns 0 for a single point", () => {
      expect(lineLength([[13.5, 43.6]])).toBe(0);
    });

    it("returns correct length for two points", () => {
      // Same as haversineKm but coords are [lng, lat]
      const len = lineLength([[13.5, 43.6], [13.5, 43.61]]);
      expect(len).toBeGreaterThan(1.0);
      expect(len).toBeLessThan(1.5);
    });

    it("is additive for collinear segments", () => {
      const total = lineLength([[13.5, 43.6], [13.5, 43.605], [13.5, 43.61]]);
      const seg1 = lineLength([[13.5, 43.6], [13.5, 43.605]]);
      const seg2 = lineLength([[13.5, 43.605], [13.5, 43.61]]);
      expect(total).toBeCloseTo(seg1 + seg2, 6);
    });
  });

  describe("pointToLineDistance", () => {
    it("returns 0 for point on the line", () => {
      const line = [[13.5, 43.6], [13.5, 43.61]];
      const dist = pointToLineDistance(13.5, 43.605, line);
      expect(dist).toBeLessThan(0.01); // < 10m
    });

    it("returns distance for point off the line", () => {
      const line = [[13.5, 43.6], [13.5, 43.61]];
      const dist = pointToLineDistance(13.51, 43.605, line);
      expect(dist).toBeGreaterThan(0.5);
      expect(dist).toBeLessThan(2);
    });
  });

  describe("timeToMinutes", () => {
    it("parses HH:MM:SS format", () => {
      expect(timeToMinutes("07:30:00")).toBe(450);
    });

    it("parses HH:MM format", () => {
      expect(timeToMinutes("07:30")).toBe(450);
    });

    it("handles midnight", () => {
      expect(timeToMinutes("00:00:00")).toBe(0);
    });

    it("handles >24h GTFS time", () => {
      expect(timeToMinutes("25:30:00")).toBe(25 * 60 + 30);
    });

    it("handles noon", () => {
      expect(timeToMinutes("12:00")).toBe(720);
    });
  });

  describe("minToTime", () => {
    it("formats 0 as 00:00", () => {
      expect(minToTime(0)).toBe("00:00");
    });

    it("formats 450 as 07:30", () => {
      expect(minToTime(450)).toBe("07:30");
    });

    it("formats 720 as 12:00", () => {
      expect(minToTime(720)).toBe("12:00");
    });

    it("wraps around 24h", () => {
      expect(minToTime(24 * 60 + 30)).toBe("00:30");
    });
  });

  describe("walkMinutes", () => {
    it("returns 0 for zero distance", () => {
      expect(walkMinutes(0)).toBe(0);
    });

    it("returns ~13 min for 1km at 4.5km/h", () => {
      const mins = walkMinutes(1);
      expect(mins).toBeGreaterThanOrEqual(13);
      expect(mins).toBeLessThanOrEqual(14);
    });

    it("rounds up", () => {
      // 0.1km at 4.5km/h = 1.33min → ceil = 2
      expect(walkMinutes(0.1)).toBe(2);
    });
  });
});
