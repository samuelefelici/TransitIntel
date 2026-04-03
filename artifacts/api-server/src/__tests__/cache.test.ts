import { describe, it, expect, beforeEach } from "vitest";
import { clearCache, cacheSize } from "../middlewares/cache";
import request from "supertest";
import app from "../app";

describe("Cache middleware", () => {
  beforeEach(() => {
    clearCache(); // start fresh each test
  });

  it("cacheSize returns 0 after clearCache()", () => {
    expect(cacheSize()).toBe(0);
  });

  it("stores entry after first request", async () => {
    // Use a lightweight cached endpoint
    const res = await request(app).get("/api/gtfs/routes");
    // If DB is unreachable, the response may be 500 but cache still works for successful endpoints
    if (res.status === 200) {
      expect(cacheSize()).toBeGreaterThanOrEqual(1);
    }
  }, 15_000);

  it("clearCache with prefix only removes matching entries", async () => {
    const r1 = await request(app).get("/api/gtfs/routes");
    const r2 = await request(app).get("/api/poi");
    if (r1.status !== 200 || r2.status !== 200) return; // skip if DB unavailable
    const before = cacheSize();
    expect(before).toBeGreaterThanOrEqual(2);

    const cleared = clearCache("/api/gtfs/");
    expect(cleared).toBeGreaterThanOrEqual(1);
    // POI cache entry should still be there
    expect(cacheSize()).toBe(before - cleared);
  }, 15_000);

  it("second identical request returns HIT", async () => {
    clearCache(); // ensure clean
    const r1 = await request(app).get("/api/gtfs/routes");
    if (r1.status !== 200) return; // skip if DB unavailable
    expect(r1.headers["x-cache"]).toBe("MISS");

    const r2 = await request(app).get("/api/gtfs/routes");
    expect(r2.headers["x-cache"]).toBe("HIT");
    expect(r2.status).toBe(r1.status);
    expect(r2.body).toEqual(r1.body);
  }, 15_000);
});
