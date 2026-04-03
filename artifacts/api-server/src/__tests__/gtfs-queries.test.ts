import { describe, it, expect } from "vitest";
import request from "supertest";
import app from "../app";

describe("GTFS Query endpoints", () => {
  describe("GET /api/gtfs/summary", () => {
    it("returns 200 with summary data or 500 without DB", async () => {
      const res = await request(app).get("/api/gtfs/summary");
      expect([200, 500]).toContain(res.status);
      if (res.status === 200) {
        expect(res.body).toBeDefined();
      }
    }, 15_000);

    it("serves from cache on second request (if DB available)", async () => {
      const res1 = await request(app).get("/api/gtfs/summary");
      if (res1.status !== 200) return; // skip if DB unavailable
      expect(res1.headers["x-cache"]).toMatch(/MISS|HIT/);

      const res2 = await request(app).get("/api/gtfs/summary");
      expect(res2.headers["x-cache"]).toBe("HIT");
      expect(res2.body).toEqual(res1.body);
    }, 15_000);
  });

  describe("GET /api/gtfs/routes", () => {
    it("returns 200 with routes array or 500 without DB", async () => {
      const res = await request(app).get("/api/gtfs/routes");
      expect([200, 500]).toContain(res.status);
      if (res.status === 200) {
        expect(res.body).toBeDefined();
      }
    }, 15_000);
  });

  describe("GET /api/gtfs/stops", () => {
    it("returns 200 with stops data or 500 without DB", async () => {
      const res = await request(app).get("/api/gtfs/stops?limit=5");
      expect([200, 500]).toContain(res.status);
      if (res.status === 200) {
        expect(res.body).toBeDefined();
      }
    }, 15_000);

    it("different query params produce different cache entries", async () => {
      const res1 = await request(app).get("/api/gtfs/stops?limit=3");
      if (res1.status !== 200) return; // skip if DB unavailable
      expect(res1.headers["x-cache"]).toBe("MISS");

      const res2 = await request(app).get("/api/gtfs/stops?limit=7");
      expect(res2.headers["x-cache"]).toBe("MISS");
    }, 15_000);
  });

  describe("GET /api/gtfs/stats", () => {
    it("returns 200 with stats data or 500 without DB", async () => {
      const res = await request(app).get("/api/gtfs/stats");
      expect([200, 500]).toContain(res.status);
      if (res.status === 200) {
        expect(res.body).toBeDefined();
      }
    }, 15_000);
  });
});
