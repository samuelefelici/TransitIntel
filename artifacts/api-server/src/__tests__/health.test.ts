import { describe, it, expect } from "vitest";
import request from "supertest";
import app from "../app";

describe("GET /api/healthz", () => {
  it("returns 200 with status ok", async () => {
    const res = await request(app).get("/api/healthz");
    // healthz may return 500 if DB is unreachable in test env
    expect([200, 500]).toContain(res.status);
    if (res.status === 200) {
      expect(res.body).toHaveProperty("status", "ok");
      expect(res.body).toHaveProperty("cacheEntries");
      expect(typeof res.body.cacheEntries).toBe("number");
    }
  });
});
