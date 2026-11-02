/**
 * I segreti delle cron (lib/segreto-cron.ts): CRON_SECRET per i job dei dati,
 * ARGOS_CRON_SECRET per le rotte che danno ad Argos token utente o progetti.
 * Chi ha il segreto di uno scheduler non deve poter avere un token di Argos.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import request from "supertest";

vi.mock("@workspace/db", () => ({
  db: { execute: vi.fn(async () => ({ rows: [] })) },
  pool: { query: vi.fn(async () => ({ rows: [] })), on: vi.fn() },
}));

import { segretoUguale } from "../lib/segreto-cron";
import { logger } from "../lib/logger";
import app from "../app";

const DATI = "segreto-dei-job-dei-dati-0123456789";
const ARGOS = "segreto-solo-di-argos-9876543210";
const prima = { CRON_SECRET: process.env.CRON_SECRET, ARGOS_CRON_SECRET: process.env.ARGOS_CRON_SECRET };
afterEach(() => {
  for (const [k, v] of Object.entries(prima)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  vi.restoreAllMocks();
});
const imposta = (dati?: string, argos?: string) => {
  if (dati === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = dati;
  if (argos === undefined) delete process.env.ARGOS_CRON_SECRET; else process.env.ARGOS_CRON_SECRET = argos;
};
/* un projectId non valido: col segreto giusto la rotta risponde 400 prima di toccare il database */
const token = (segreto?: string) => {
  const r = request(app).post("/api/cron/argos-mcp-token").send({ projectId: "x" });
  return segreto === undefined ? r : r.set("x-cron-secret", segreto);
};

describe("confronto dei segreti", () => {
  it("uguale solo se identico, mai con un segreto atteso vuoto", () => {
    expect(segretoUguale("abc", "abc")).toBe(true);
    expect(segretoUguale("abd", "abc")).toBe(false);
    expect(segretoUguale("abcd", "abc")).toBe(false);
    expect(segretoUguale("", "")).toBe(false);
    expect(segretoUguale("abc", undefined)).toBe(false);
    expect(segretoUguale(["abc"], "abc")).toBe(false);
  });
});

describe("le rotte che danno token ad Argos", () => {
  it("con ARGOS_CRON_SECRET impostata, il segreto dei job dei dati non basta più", async () => {
    imposta(DATI, ARGOS);
    expect((await token(DATI)).status).toBe(401);
    expect((await token(ARGOS)).status).toBe(400);
    expect((await token()).status).toBe(401);
    expect((await request(app).post("/api/cron/argos-mcp-projects").set("x-cron-secret", DATI)).status).toBe(401);
  });

  it("senza ARGOS_CRON_SECRET (passaggio) vale ancora CRON_SECRET, con un avviso", async () => {
    imposta(DATI, undefined);
    const avviso = vi.spyOn(logger, "warn");
    expect((await token(DATI)).status).toBe(400);
    expect((await token("sbagliato")).status).toBe(401);
    expect(avviso.mock.calls.flat().join(" ")).toMatch(/ARGOS_CRON_SECRET non è impostata/);
  });

  it("senza nessun segreto, chiuse", async () => {
    imposta(undefined, undefined);
    expect((await token("")).status).toBe(401);
    expect((await token("qualunque")).status).toBe(401);
  });
});

describe("le cron dei dati", () => {
  it("restano su CRON_SECRET: il segreto di Argos non le apre", async () => {
    imposta(DATI, ARGOS);
    /* senza chiave di OpenWeather la rotta risponde 500 dopo aver accettato il segreto */
    expect((await request(app).post("/api/cron/weather").set("x-cron-secret", DATI)).status).not.toBe(401);
    expect((await request(app).post("/api/cron/weather").set("x-cron-secret", ARGOS)).status).toBe(401);
    expect((await request(app).post("/api/cron/argos-watch").set("x-cron-secret", ARGOS)).status).toBe(401);
  });
});
