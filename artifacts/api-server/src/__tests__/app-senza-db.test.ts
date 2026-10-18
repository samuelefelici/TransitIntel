import { describe, it, expect } from "vitest";
import request from "supertest";
import app from "../app";

/* L'app vera, senza database: le rotte pubbliche non devono trascinare giù
 * tutte le altre. Prima un middleware delle condivisioni girava su ogni
 * richiesta e, senza database, rispondeva 500 a tutto. */
describe("l'API senza database", () => {
  it("una rotta protetta senza login risponde 401, non 500", async () => {
    const r = await request(app).get("/api/gtfs/summary");
    expect(r.status).toBe(401);
  });

  it("le condivisioni pubbliche rispondono 503 sulle loro rotte", async () => {
    expect((await request(app).get("/api/network-share/abcdef")).status).toBe(503);
    expect((await request(app).get("/api/timetable-map/abcdef")).status).toBe(503);
  });
});
