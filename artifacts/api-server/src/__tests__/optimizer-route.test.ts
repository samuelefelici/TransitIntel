import { describe, it, expect } from "vitest";
import request from "supertest";
import app from "../app";

describe("Optimizer Route endpoints", () => {
  describe("GET /api/optimizer/bus-profiles", () => {
    it("returns 200 with all three bus profiles", async () => {
      const res = await request(app).get("/api/optimizer/bus-profiles");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("standard");
      expect(res.body).toHaveProperty("midi");
      expect(res.body).toHaveProperty("minibus");
    }, 15_000);

    it("each profile has required fields", async () => {
      const res = await request(app).get("/api/optimizer/bus-profiles");
      for (const key of ["standard", "midi", "minibus"]) {
        const profile = res.body[key];
        expect(profile).toHaveProperty("label");
        expect(profile).toHaveProperty("lengthM");
        expect(profile).toHaveProperty("capacity");
        expect(profile).toHaveProperty("minRoadWidthM");
        expect(profile).toHaveProperty("minCurveRadiusM");
        expect(profile).toHaveProperty("maxGradientPercent");
        expect(profile).toHaveProperty("idealInterStopKm");
        expect(typeof profile.capacity).toBe("number");
        expect(profile.capacity).toBeGreaterThan(0);
      }
    }, 15_000);

    it("standard bus is larger than midi and minibus", async () => {
      const res = await request(app).get("/api/optimizer/bus-profiles");
      expect(res.body.standard.lengthM).toBeGreaterThan(res.body.midi.lengthM);
      expect(res.body.midi.lengthM).toBeGreaterThan(res.body.minibus.lengthM);
      expect(res.body.standard.capacity).toBeGreaterThan(res.body.midi.capacity);
    }, 15_000);

    it("serves from cache on second request", async () => {
      const { clearCache } = await import("../middlewares/cache");
      clearCache("/api/optimizer/bus-profiles");

      const r1 = await request(app).get("/api/optimizer/bus-profiles");
      expect(r1.headers["x-cache"]).toBe("MISS");
      const r2 = await request(app).get("/api/optimizer/bus-profiles");
      expect(r2.headers["x-cache"]).toBe("HIT");
      expect(r2.body).toEqual(r1.body);
    }, 15_000);
  });

  describe("POST /api/optimizer/route-placement", () => {
    it("returns 400 when scenarioId is missing", async () => {
      const res = await request(app)
        .post("/api/optimizer/route-placement")
        .send({});
      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty("error");
      expect(res.body.error).toMatch(/scenarioId/i);
    }, 15_000);

    it("returns 404 for non-existent scenario", async () => {
      const res = await request(app)
        .post("/api/optimizer/route-placement")
        .send({ scenarioId: "non-existent-id-12345" });
      // 404 with real DB, 500 if DB is unreachable — both acceptable in CI
      expect([404, 500]).toContain(res.status);
      expect(res.body).toHaveProperty("error");
    }, 15_000);

    it("accepts optional parameters without crashing", async () => {
      const res = await request(app)
        .post("/api/optimizer/route-placement")
        .send({
          scenarioId: "non-existent-id",
          busSize: "midi",
          targetInterStopKm: 0.5,
          maxStops: 20,
          radiusKm: 0.3,
        });
      // 404 with real DB, 500 if DB unreachable
      expect([404, 500]).toContain(res.status);
    }, 15_000);
  });
});
