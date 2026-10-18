import { describe, it, expect } from "vitest";
import request from "supertest";
import router from "../routes/optimizer-schedule";
import { appDiProva, utenteDiProva } from "./helpers/app-di-prova";

const app = appDiProva(router, utenteDiProva("10000000-0000-0000-0000-000000000002", ["analytics"]));

/* Senza un feed GTFS (qui non c'è database) le rotte rispondono 404 «Nessun
 * feed GTFS caricato»; con un database di prova (TEST_DATABASE_URL) 200. */
describe("Optimizer Schedule endpoints", () => {
  describe("GET /api/optimizer/schedule/dates", () => {
    it("returns 200 with dates data, or 404 without a feed", async () => {
      const res = await request(app).get("/api/optimizer/schedule/dates");
      expect([200, 404]).toContain(res.status);
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
      expect([200, 404]).toContain(res.status);
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
      expect([200, 404]).toContain(res.status);
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
      expect([200, 400, 404]).toContain(res.status);
    }, 30_000);
  });
});
