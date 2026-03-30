import { describe, it, expect } from "vitest";
import request from "supertest";
import app from "../app";

describe("GET /api/healthz", () => {
  it("returns 200 with status ok", async () => {
    const res = await request(app).get("/api/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("status", "ok");
    expect(res.body).toHaveProperty("cacheEntries");
    expect(typeof res.body.cacheEntries).toBe("number");
  });
});
