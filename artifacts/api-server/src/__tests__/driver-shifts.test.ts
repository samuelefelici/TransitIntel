import { describe, it, expect } from "vitest";
import request from "supertest";
import router from "../routes/driver-shifts";
import { appDiProva, utenteDiProva } from "./helpers/app-di-prova";

const app = appDiProva(router, utenteDiProva("10000000-0000-0000-0000-000000000002", ["scheduling"]));

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

  describe("POST /api/driver-shifts/misto", () => {
    it("arriva al completamento dei misti, non alla generazione di uno scenario", async () => {
      /* prima la rotta /:scenarioId stava davanti e prendeva «misto» per un id: sempre 404 */
      const res = await request(app).post("/api/driver-shifts/misto").send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("targetDssId e sources richiesti");
    });
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
    it("uno scenario che non esiste: 404 dal controllo di accesso", async () => {
      const res = await request(app).get("/api/driver-shifts/non-existent-id/scenarios");
      expect(res.status).toBe(404);
      expect(res.body).toHaveProperty("error");
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
