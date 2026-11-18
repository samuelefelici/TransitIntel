/**
 * Le risposte grandi compresse (middlewares/comprimi.ts, tappa 6.19b).
 * Si prova su un'app Express vera, con le richieste fatte a mano (http di
 * Node): così si vede il corpo come arriva, compresso, e lo si decomprime qui.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import http from "node:http";
import zlib from "node:zlib";
import type { AddressInfo } from "node:net";
import { comprimiRisposte, comprimibile, SOGLIA_BYTE, SINCRONO_BYTE } from "../middlewares/comprimi";
import { cache, clearCache } from "../middlewares/cache";

const GRANDE = { righe: Array.from({ length: 2000 }, (_, i) => ({ i, nome: `riga ${i}`, punti: [13.5 + i / 1e4, 43.6] })) };
const ENORME = { righe: Array.from({ length: 40_000 }, (_, i) => ({ i, nome: `riga ${i}`, punti: [13.5 + i / 1e4, 43.6] })) };
const CSV = "a;b\n" + Array.from({ length: 3000 }, (_, i) => `${i};città ${i}`).join("\n");

const app = express();
app.use(comprimiRisposte);
app.get("/api/grande", (_req, res) => { res.json(GRANDE); });
app.get("/api/enorme", (_req, res) => { res.json(ENORME); });
app.get("/api/piccola", (_req, res) => { res.json({ ok: true }); });
app.get("/api/csv", (_req, res) => { res.type("text/csv"); res.send(CSV); });
app.get("/api/zip", (_req, res) => { res.type("application/zip"); res.send(Buffer.alloc(SOGLIA_BYTE * 2, 7)); });
app.get("/api/auth/me", (_req, res) => { res.json(GRANDE); });
app.get("/api/no-transform", (_req, res) => { res.set("Cache-Control", "no-transform"); res.json(GRANDE); });
app.get("/api/in-cache", cache({ ttlSeconds: 60 }), (_req, res) => { res.json(GRANDE); });
app.get("/api/errore", (_req, res) => { res.status(500).json(GRANDE); });

let server: http.Server;
let porta = 0;
beforeAll(async () => {
  clearCache();
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  porta = (server.address() as AddressInfo).port;
});
afterAll(() => { server.close(); clearCache(); });

function chiedi(percorso: string, accetta?: string, metodo = "GET"): Promise<{ status: number; h: http.IncomingHttpHeaders; corpo: Buffer }> {
  return new Promise((ok, ko) => {
    const req = http.request({ host: "127.0.0.1", port: porta, path: percorso, method: metodo,
      headers: accetta === undefined ? {} : { "accept-encoding": accetta } }, (res) => {
      const pezzi: Buffer[] = [];
      res.on("data", (d) => pezzi.push(d));
      res.on("end", () => ok({ status: res.statusCode ?? 0, h: res.headers, corpo: Buffer.concat(pezzi) }));
    });
    req.on("error", ko);
    req.end();
  });
}

const testo = (r: { h: http.IncomingHttpHeaders; corpo: Buffer }) =>
  (r.h["content-encoding"] === "br" ? zlib.brotliDecompressSync(r.corpo)
    : r.h["content-encoding"] === "gzip" ? zlib.gunzipSync(r.corpo) : r.corpo).toString("utf8");

describe("le risposte grandi, compresse", () => {
  it("brotli se il client lo accetta: il JSON arriva uguale e molto più piccolo", async () => {
    const r = await chiedi("/api/grande", "gzip, deflate, br");
    expect(r.h["content-encoding"]).toBe("br");
    expect(r.h.vary).toMatch(/Accept-Encoding/);
    expect(r.h["content-type"]).toMatch(/^application\/json; charset=utf-8/);
    expect(JSON.parse(testo(r))).toEqual(GRANDE);
    expect(r.corpo.length).toBeLessThan(JSON.stringify(GRANDE).length / 4);
    expect(Number(r.h["content-length"])).toBe(r.corpo.length);
  });

  it("gzip a chi non sa brotli, e niente a chi non accetta nessuna delle due", async () => {
    const g = await chiedi("/api/grande", "gzip");
    expect(g.h["content-encoding"]).toBe("gzip");
    expect(JSON.parse(testo(g))).toEqual(GRANDE);
    for (const a of ["identity", "deflate", "br;q=0, gzip;q=0", ""]) {
      const n = await chiedi("/api/grande", a);
      expect(n.h["content-encoding"]).toBeUndefined();
      expect(JSON.parse(n.corpo.toString())).toEqual(GRANDE);
    }
  });

  it("sopra un mega la compressione gira a parte, e il risultato è lo stesso", async () => {
    expect(JSON.stringify(ENORME).length).toBeGreaterThan(SINCRONO_BYTE);
    const r = await chiedi("/api/enorme", "br");
    expect(r.h["content-encoding"]).toBe("br");
    expect(JSON.parse(testo(r))).toEqual(ENORME);
  });

  it("il CSV si comprime e tiene il suo charset", async () => {
    const r = await chiedi("/api/csv", "gzip");
    expect(r.h["content-encoding"]).toBe("gzip");
    expect(r.h["content-type"]).toBe("text/csv; charset=utf-8");
    expect(testo(r)).toBe(CSV);
  });

  it("non si toccano: le risposte piccole, i file binari, /api/auth, no-transform, HEAD", async () => {
    for (const p of ["/api/piccola", "/api/zip", "/api/auth/me", "/api/no-transform"]) {
      const r = await chiedi(p, "gzip, br");
      expect(r.h["content-encoding"], p).toBeUndefined();
    }
    const h = await chiedi("/api/grande", "gzip, br", "HEAD");
    expect(h.h["content-encoding"]).toBeUndefined();
    expect(h.corpo.length).toBe(0);
  });

  it("anche un errore grande si comprime, con il suo stato", async () => {
    const r = await chiedi("/api/errore", "br");
    expect(r.status).toBe(500);
    expect(JSON.parse(testo(r))).toEqual(GRANDE);
  });

  it("la cache tiene il testo in chiaro: chi accetta brotli e chi no ricevono la stessa risposta", async () => {
    const a = await chiedi("/api/in-cache", "br");
    expect(a.h["x-cache"]).toBe("MISS");
    expect(a.h["content-encoding"]).toBe("br");
    const b = await chiedi("/api/in-cache", "identity");
    expect(b.h["x-cache"]).toBe("HIT");
    expect(b.h["content-encoding"]).toBeUndefined();
    const c = await chiedi("/api/in-cache", "gzip");
    expect(c.h["x-cache"]).toBe("HIT");
    expect(c.h["content-encoding"]).toBe("gzip");
    expect(testo(a)).toBe(b.corpo.toString());
    expect(testo(c)).toBe(b.corpo.toString());
  });
});

describe("i tipi che si comprimono", () => {
  it("testo, JSON, XML e i loro derivati sì; il resto no", () => {
    for (const t of ["application/json; charset=utf-8", "application/geo+json", "application/xml", "text/csv",
                     "text/plain;charset=utf-8", "application/vnd.api+json", "text/xml"]) expect(comprimibile(t), t).toBe(true);
    for (const t of ["application/zip", "application/pdf", "image/png", "application/x-protobuf",
                     "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "text/event-stream", undefined, 3])
      expect(comprimibile(t as never), String(t)).toBe(false);
  });
});
