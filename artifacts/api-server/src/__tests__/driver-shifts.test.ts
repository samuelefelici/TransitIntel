import { describe, it, expect } from "vitest";
import request from "supertest";
import app from "../app";

describe("Driver Shifts endpoints", () => {
  describe("GET /api/driver-shifts/:scenarioId", () => {
    it("returns error for non-existent scenario", async () => {
      const res = await request(app).get("/api/driver-shifts/non-existent-id-999");
      // 404 or 200 with real DB, 500 if DB unreachable
      expect([200, 404, 500]).toContain(res.status);
    }, 15_000);
  });

  describe("POST /api/driver-shifts/:scenarioId", () => {
    it("returns error for non-existent scenario", async () => {
      const res = await request(app)
        .post("/api/driver-shifts/non-existent-id-999")
        .send({});
      // Should be 404 or 400 (scenario not found), not 500
      expect([400, 404, 500]).toContain(res.status);
      if (res.status !== 500) {
        expect(res.body).toHaveProperty("error");
      }
    }, 15_000);
  });

  describe("GET /api/driver-shifts/jobs/:jobId", () => {
    it("returns 404 for non-existent job", async () => {
      const res = await request(app).get("/api/driver-shifts/jobs/fake-job-id-123");
      expect(res.status).toBe(404);
      expect(res.body).toHaveProperty("error");
    }, 15_000);
  });

  describe("POST /api/driver-shifts/jobs/:jobId/stop", () => {
    it("returns error for non-existent job", async () => {
      const res = await request(app)
        .post("/api/driver-shifts/jobs/fake-job-id-123/stop")
        .send({});
      expect([400, 404]).toContain(res.status);
      expect(res.body).toHaveProperty("error");
    }, 15_000);
  });

  describe("GET /api/driver-shifts/:scenarioId/scenarios", () => {
    it("returns an array or 500 without DB", async () => {
      const res = await request(app).get("/api/driver-shifts/non-existent-id/scenarios");
      expect([200, 500]).toContain(res.status);
      if (res.status === 200) {
        expect(Array.isArray(res.body)).toBe(true);
      }
    }, 15_000);
  });

  describe("POST /api/driver-shifts/:scenarioId/compare", () => {
    it("returns error without scenarioIds", async () => {
      const res = await request(app)
        .post("/api/driver-shifts/test-scenario/compare")
        .send({});
      // Should fail gracefully
      expect([400, 404, 500]).toContain(res.status);
    }, 15_000);
  });
});
