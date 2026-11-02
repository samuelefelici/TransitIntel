import { describe, it, expect, afterEach, vi } from "vitest";
import request from "supertest";

vi.mock("@workspace/db", () => ({
  db: { execute: vi.fn(async () => ({ rows: [] })) },
  pool: { query: vi.fn(async () => ({ rows: [] })), on: vi.fn() },
}));

import { pool } from "@workspace/db";
import app from "../app";
import { azzeraGuardiaSchema, controllaSchema } from "../lib/guardia-schema";
import { DIARIO } from "../../../../lib/db/scripts/diario-incluso.mjs";

/* il tracciamento delle migrazioni come lo vede la guardia: c'è la tabella, e queste righe */
function tracciamento(righe: Array<{ created_at: number }> | null) {
  vi.mocked(pool.query).mockImplementation((async (testo: string) => {
    if (/to_regclass/.test(testo)) return { rows: [{ c: righe !== null }] };
    return { rows: righe ?? [] };
  }) as any);
}

afterEach(() => { azzeraGuardiaSchema(); vi.mocked(pool.query).mockReset(); });

describe("GET /api/healthz", () => {
  it("returns 200 with status ok", async () => {
    /* pubblica e senza database: deve rispondere anche quando il database non c'è */
    const res = await request(app).get("/api/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("status", "ok");
    expect(res.body).toHaveProperty("schema", "sconosciuto");
    expect(typeof res.body.cacheEntries).toBe("number");
  });

  it("schema ok: 200", async () => {
    tracciamento(DIARIO.map(e => ({ created_at: e.when })));
    expect(await controllaSchema()).toBe("ok");
    const res = await request(app).get("/api/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "ok", schema: "ok" });
  });

  it("schema indietro (manca l'ultima migrazione): 503, senza nomi di migrazioni nella risposta", async () => {
    tracciamento(DIARIO.slice(0, -1).map(e => ({ created_at: e.when })));
    expect(await controllaSchema()).toBe("indietro");
    const res = await request(app).get("/api/healthz");
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ status: "schema-indietro", schema: "indietro" });
    expect(JSON.stringify(res.body)).not.toMatch(/\d{4}_/);
  });

  it("tracciamento assente (database mai migrato): indietro", async () => {
    tracciamento(null);
    expect(await controllaSchema()).toBe("indietro");
  });

  it("database più nuovo del codice (N-1): 200 con avanti", async () => {
    tracciamento([...DIARIO.map(e => ({ created_at: e.when })), { created_at: 9_999_999_999_999 }]);
    expect(await controllaSchema()).toBe("avanti");
    const res = await request(app).get("/api/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "ok", schema: "avanti" });
  });

  it("database che non risponde: sconosciuto, 200", async () => {
    vi.mocked(pool.query).mockRejectedValue(new Error("connect ECONNREFUSED"));
    expect(await controllaSchema()).toBe("sconosciuto");
    expect((await request(app).get("/api/healthz")).status).toBe(200);
  });
});
