import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { cache, chiavePerUtente, clearCache, cacheSize } from "../middlewares/cache";

/* il middleware su rotte finte: niente database, conta quante volte lavora l'handler */
function appConContatore() {
  const conta = { n: 0 };
  const app = express();
  app.get("/api/prova-cache/a", cache({ ttlSeconds: 60 }), (_req, res) => { conta.n++; res.json({ n: conta.n }); });
  app.get("/api/altro/b", cache({ ttlSeconds: 60 }), (_req, res) => { conta.n++; res.json({ n: conta.n }); });
  app.get("/api/prova-cache/errore", cache({ ttlSeconds: 60 }), (_req, res) => { conta.n++; res.status(500).json({ n: conta.n }); });
  app.post("/api/prova-cache/a", cache({ ttlSeconds: 60 }), (_req, res) => { conta.n++; res.json({ n: conta.n }); });
  return { app, conta };
}

describe("Cache middleware", () => {
  beforeEach(() => { clearCache(); });

  it("cacheSize returns 0 after clearCache()", () => {
    expect(cacheSize()).toBe(0);
  });

  it("la prima richiesta è MISS, la seconda HIT con lo stesso corpo e senza rifare il lavoro", async () => {
    const { app, conta } = appConContatore();
    const r1 = await request(app).get("/api/prova-cache/a");
    expect(r1.status).toBe(200);
    expect(r1.headers["x-cache"]).toBe("MISS");
    expect(cacheSize()).toBe(1);
    const r2 = await request(app).get("/api/prova-cache/a");
    expect(r2.headers["x-cache"]).toBe("HIT");
    expect(r2.body).toEqual(r1.body);
    expect(conta.n).toBe(1);
  });

  it("parametri diversi sono voci diverse", async () => {
    const { app } = appConContatore();
    expect((await request(app).get("/api/prova-cache/a?limit=3")).headers["x-cache"]).toBe("MISS");
    expect((await request(app).get("/api/prova-cache/a?limit=7")).headers["x-cache"]).toBe("MISS");
    expect(cacheSize()).toBe(2);
  });

  it("clearCache con un prefisso toglie solo le voci che lo contengono", async () => {
    const { app } = appConContatore();
    await request(app).get("/api/prova-cache/a");
    await request(app).get("/api/altro/b");
    expect(cacheSize()).toBe(2);
    expect(clearCache("/api/prova-cache/")).toBe(1);
    expect(cacheSize()).toBe(1);
    expect((await request(app).get("/api/altro/b")).headers["x-cache"]).toBe("HIT");
  });

  it("con chiavePerUtente lo stesso URL è una voce per utente, e clearCache la trova", async () => {
    const conta = { n: 0 };
    const app = express();
    app.use((req, _res, next) => { (req as any).user = { id: String(req.headers["x-utente"]) }; next(); });
    app.get("/api/prova-cache/mio", cache({ ttlSeconds: 60, keyFn: chiavePerUtente }), (_req, res) => { conta.n++; res.json({ n: conta.n }); });
    expect((await request(app).get("/api/prova-cache/mio").set("x-utente", "a")).headers["x-cache"]).toBe("MISS");
    expect((await request(app).get("/api/prova-cache/mio").set("x-utente", "b")).headers["x-cache"]).toBe("MISS");
    expect((await request(app).get("/api/prova-cache/mio").set("x-utente", "a")).body).toEqual({ n: 1 });
    expect(cacheSize()).toBe(2);
    expect(clearCache("/api/prova-cache/")).toBe(2);
  });

  it("non tiene gli errori né le richieste che non sono GET", async () => {
    const { app, conta } = appConContatore();
    await request(app).get("/api/prova-cache/errore");
    await request(app).get("/api/prova-cache/errore");
    await request(app).post("/api/prova-cache/a").send({});
    await request(app).post("/api/prova-cache/a").send({});
    expect(conta.n).toBe(4);
    expect(cacheSize()).toBe(0);
  });
});
