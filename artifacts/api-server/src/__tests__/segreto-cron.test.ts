/**
 * I segreti delle cron (lib/segreto-cron.ts): CRON_SECRET per i job dei dati,
 * ARGOS_CRON_SECRET per le rotte che danno ad Argos token utente o progetti.
 * Chi ha il segreto di uno scheduler non deve poter avere un token di Argos,
 * e senza ARGOS_CRON_SECRET quelle rotte sono chiuse (passaggio a parte).
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import request from "supertest";

vi.mock("@workspace/db", () => ({
  db: { execute: vi.fn(async () => ({ rows: [] })) },
  pool: { query: vi.fn(async () => ({ rows: [] })), on: vi.fn() },
}));

import { segretoUguale, azzeraAvvisiCron, controllaSegretiCron } from "../lib/segreto-cron";
import { logger } from "../lib/logger";
import app from "../app";

const DATI = "segreto-dei-job-dei-dati-0123456789";
const ARGOS = "segreto-solo-di-argos-9876543210";
const VARIABILI = ["CRON_SECRET", "ARGOS_CRON_SECRET", "ARGOS_CRON_PASSAGGIO", "ARGOS_URL"] as const;
const prima = Object.fromEntries(VARIABILI.map((k) => [k, process.env[k]]));
beforeEach(() => azzeraAvvisiCron());
afterEach(() => {
  for (const k of VARIABILI) { if (prima[k] === undefined) delete process.env[k]; else process.env[k] = prima[k]; }
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function imposta(v: Partial<Record<(typeof VARIABILI)[number], string>>) {
  for (const k of VARIABILI) { if (v[k] === undefined) delete process.env[k]; else process.env[k] = v[k]; }
}
const avvisi = (spia: { mock: { calls: unknown[][] } }) => spia.mock.calls.flat().join(" ");
/* un projectId non valido: col segreto giusto la rotta risponde 400 prima di toccare il database */
const token = (segreto?: string) => {
  const r = request(app).post("/api/cron/argos-mcp-token").send({ projectId: "x" });
  return segreto === undefined ? r : r.set("x-cron-secret", segreto);
};
const progetti = (segreto: string) => request(app).post("/api/cron/argos-mcp-projects").set("x-cron-secret", segreto);

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

describe("le rotte che danno token e progetti ad Argos", () => {
  it("con ARGOS_CRON_SECRET: si aprono solo con lei, mai col segreto dei job dei dati", async () => {
    imposta({ CRON_SECRET: DATI, ARGOS_CRON_SECRET: ARGOS });
    expect((await token(ARGOS)).status).toBe(400);
    expect((await progetti(ARGOS)).status).toBe(200);
    expect((await token(DATI)).status).toBe(401);
    expect((await progetti(DATI)).status).toBe(401);
    expect((await token()).status).toBe(401);
  });

  it("senza ARGOS_CRON_SECRET sono chiuse, anche per chi ha il segreto dei job dei dati", async () => {
    imposta({ CRON_SECRET: DATI });
    expect((await token(DATI)).status).toBe(503);
    expect((await progetti(DATI)).status).toBe(503);
    expect((await token("qualunque")).status).toBe(503);
  });

  it("nel passaggio (ARGOS_CRON_PASSAGGIO=1) valgono tutti e due, con un avviso", async () => {
    imposta({ CRON_SECRET: DATI, ARGOS_CRON_SECRET: ARGOS, ARGOS_CRON_PASSAGGIO: "1" });
    const spia = vi.spyOn(logger, "warn");
    expect((await token(DATI)).status).toBe(400);
    expect((await token(ARGOS)).status).toBe(400);
    expect((await progetti(DATI)).status).toBe(200);
    expect((await token("sbagliato")).status).toBe(401);
    expect(avvisi(spia)).toMatch(/ARGOS_CRON_PASSAGGIO è attivo/);
  });

  it("segreti uguali: un avviso; segreto sbagliato: un avviso che aiuta a capire", async () => {
    imposta({ CRON_SECRET: DATI, ARGOS_CRON_SECRET: DATI });
    const spia = vi.spyOn(logger, "warn");
    await token(DATI);
    expect(avvisi(spia)).toMatch(/è uguale a CRON_SECRET/);
    imposta({ CRON_SECRET: DATI, ARGOS_CRON_SECRET: ARGOS });
    await token("vecchio-valore");
    expect(avvisi(spia)).toMatch(/segreto sbagliato/);
  });

  it("un avviso all'ora al massimo, poi di nuovo", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-02T10:00:00Z"));
    imposta({ CRON_SECRET: DATI, ARGOS_CRON_SECRET: ARGOS, ARGOS_CRON_PASSAGGIO: "1" });
    const spia = vi.spyOn(logger, "warn");
    await token(DATI); await token(DATI); await token(DATI);
    const passaggio = () => spia.mock.calls.filter((c) => /PASSAGGIO/.test(String(c[0]))).length;
    expect(passaggio()).toBe(1);
    vi.setSystemTime(new Date("2026-11-02T11:00:01Z"));
    await token(DATI);
    expect(passaggio()).toBe(2);
  });

  it("all'avvio: Argos configurato senza il suo segreto, o il passaggio ancora attivo", () => {
    const spia = vi.spyOn(logger, "warn");
    imposta({ CRON_SECRET: DATI, ARGOS_URL: "http://argos" });
    controllaSegretiCron();
    expect(avvisi(spia)).toMatch(/ARGOS_URL è impostata ma ARGOS_CRON_SECRET no/);
    azzeraAvvisiCron();
    imposta({ CRON_SECRET: DATI, ARGOS_CRON_SECRET: ARGOS, ARGOS_CRON_PASSAGGIO: "1" });
    controllaSegretiCron();
    expect(avvisi(spia)).toMatch(/ARGOS_CRON_PASSAGGIO è attivo/);
  });
});

describe("le cron dei dati", () => {
  it("restano su CRON_SECRET: il segreto di Argos non le apre", async () => {
    imposta({ CRON_SECRET: DATI, ARGOS_CRON_SECRET: ARGOS });
    /* senza chiave di OpenWeather la rotta risponde 500 dopo aver accettato il segreto */
    expect((await request(app).post("/api/cron/weather").set("x-cron-secret", DATI)).status).not.toBe(401);
    expect((await request(app).post("/api/cron/weather").set("x-cron-secret", ARGOS)).status).toBe(401);
    expect((await request(app).post("/api/cron/argos-watch").set("x-cron-secret", ARGOS)).status).toBe(401);
  });
});
