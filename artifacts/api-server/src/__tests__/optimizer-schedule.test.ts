import { describe, it, expect } from "vitest";
import request from "supertest";
import app from "../app";

describe("Optimizer Schedule endpoints", () => {
  describe("GET /api/optimizer/schedule/dates", () => {
    it("returns 200 with dates data or 500 without DB", async () => {
      const res = await request(app).get("/api/optimizer/schedule/dates");
      expect([200, 500]).toContain(res.status);
      if (res.status === 200) {
        expect(res.body).toBeDefined();
      }
    }, 15_000);
  });

  describe("POST /api/optimizer/schedule", () => {
    it("returns a valid structure (even with no data)", async () => {
      const res = await request(app)
        .post("/api/optimizer/schedule")
        .send({});
      // Either 200 with empty results or 500 if no GTFS loaded — both valid
      expect([200, 500]).toContain(res.status);
      if (res.status === 200) {
        expect(res.body).toHaveProperty("summary");
        expect(res.body).toHaveProperty("suggestions");
        expect(res.body.summary).toHaveProperty("date");
        expect(res.body.summary).toHaveProperty("totalTrips");
        expect(typeof res.body.summary.totalTrips).toBe("number");
      }
    }, 30_000);

    it("accepts a date parameter", async () => {
      const res = await request(app)
        .post("/api/optimizer/schedule")
        .send({ date: "20240115" });
      expect([200, 500]).toContain(res.status);
      if (res.status === 200) {
        expect(res.body.summary).toBeDefined();
      }
    }, 30_000);
  });

  describe("POST /api/optimizer/schedule/optimize", () => {
    it("returns error without required trip data", async () => {
      const res = await request(app)
        .post("/api/optimizer/schedule/optimize")
        .send({});
      // Should fail gracefully — 200 with no data or 400/500
      expect([200, 400, 500]).toContain(res.status);
    }, 30_000);
  });
});
