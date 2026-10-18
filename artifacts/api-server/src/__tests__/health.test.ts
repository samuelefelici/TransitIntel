import { describe, it, expect } from "vitest";
import request from "supertest";
import app from "../app";

describe("GET /api/healthz", () => {
  it("returns 200 with status ok", async () => {
    /* pubblica e senza database: deve rispondere anche quando il database non c'è */
    const res = await request(app).get("/api/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("status", "ok");
    expect(typeof res.body.cacheEntries).toBe("number");
  });
});
