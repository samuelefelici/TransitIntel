/* I lavori dei turni guida stanno nella coda (coda.lavori): qui una coda
 * finta in memoria. Le risposte sono quelle del vecchio job manager (la SPA
 * non cambia): stati, progress, date in ms, data, error. Li vede e li ferma
 * solo chi li ha lanciati (o l'admin); un lavoro di un altro tipo non c'è. */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

const righe = new Map<string, any>();
const annullati: string[] = [];
vi.mock("../lib/lavori/coda", () => ({
  leggi: vi.fn(async (id: string) => righe.get(id) ?? null),
  chiediAnnullamento: vi.fn(async (id: string) => {
    annullati.push(id);
    const r = righe.get(id);
    if (r?.stato === "in_coda") { r.stato = "fermato"; return "fermato"; }
    if (r?.stato === "in_corso") return "in_fermata";
    return null;
  }),
  accoda: vi.fn(async () => "nuovo"),
}));

import router, { tempoDelCalcolo } from "../routes/driver-shifts";
import { appDiProva, utenteDiProva } from "./helpers/app-di-prova";

const A = utenteDiProva("10000000-0000-0000-0000-00000000000a", ["scheduling"]);
const B = utenteDiProva("10000000-0000-0000-0000-00000000000b", ["scheduling"]);
const ADMIN = utenteDiProva("10000000-0000-0000-0000-000000000001", [], "admin");
const T = new Date("2026-11-02T10:00:00Z");
const riga = (id: string, utente: string | null, stato = "completato", extra: Record<string, any> = {}) => ({
  id, utente_id: utente, stato, oggetto_id: "s", tipo: "python", versione: 1,
  metadati: { ambito: "turni-guida", scenarioId: "s", scenarioName: "Feriale", date: "20261102" },
  avanzamento: null, risultato: stato === "completato" ? { driverShifts: [{ id: 1 }], summary: { totalDriverShifts: 1 }, metrics: { x: 1 } } : null,
  errore: null, errore_tipo: null, creato_il: T, iniziato_il: T, finito_il: stato === "completato" ? T : null, aggiornato_il: T, ...extra,
});

describe("i lavori dei turni guida: li vede e li ferma solo chi li ha lanciati", () => {
  beforeEach(() => {
    righe.clear(); annullati.length = 0;
    righe.set("di-a", riga("di-a", A.id));
    righe.set("di-a-in-corso", riga("di-a-in-corso", A.id, "in_corso"));
    righe.set("vecchio", riga("vecchio", null));
    righe.set("altro-tipo", riga("altro-tipo", A.id, "completato", { metadati: { ambito: "turni-macchina" } }));
  });

  it("il lavoro di A, chiesto da B: 404 su stato, stream e stop, e non si ferma", async () => {
    const b = appDiProva(router, B);
    expect((await request(b).get("/api/driver-shifts/jobs/di-a")).status).toBe(404);
    expect((await request(b).get("/api/driver-shifts/jobs/di-a/stream")).status).toBe(404);
    expect((await request(b).post("/api/driver-shifts/jobs/di-a-in-corso/stop")).status).toBe(404);
    expect(annullati).toEqual([]);
  });

  it("A e l'admin lo vedono, con la forma di sempre; lo stream di un lavoro finito manda il risultato", async () => {
    for (const u of [A, ADMIN]) {
      const app = appDiProva(router, u);
      const r = await request(app).get("/api/driver-shifts/jobs/di-a");
      expect(r.status).toBe(200);
      expect(r.body).toEqual({
        jobId: "di-a", scenarioId: "s", status: "completed",
        progress: { phase: "done", percentage: 100, detail: "Ottimizzazione completata", timestamp: +T },
        createdAt: +T, updatedAt: +T,
        data: {
          solver: "cpsat", scenarioId: "s", scenarioName: "Feriale", date: "20261102",
          driverShifts: [{ id: 1 }], summary: { totalDriverShifts: 1 }, unassignedBlocks: 0,
          clusters: expect.any(Array), companyCars: expect.anything(), solverMetrics: { x: 1 }, optimizationAnalysis: null,
        },
      });
      const s = await request(app).get("/api/driver-shifts/jobs/di-a/stream");
      expect(s.headers["content-type"]).toMatch(/text\/event-stream/);
      expect(s.text).toContain("event: status");
      expect(s.text).toContain("event: result");
    }
  });

  it("in coda, in corso, fallito, fermato: stato, progress ed error come prima", async () => {
    const app = appDiProva(router, A);
    righe.set("q", riga("q", A.id, "in_coda", { iniziato_il: null }));
    righe.set("r", riga("r", A.id, "in_corso", { avanzamento: { phase: "optimize", percentage: 42, detail: "x", timestamp: 5 } }));
    righe.set("f", riga("f", A.id, "fallito", { errore: "Python exit code 1" }));
    righe.set("s", riga("s", A.id, "fermato"));
    const q = (await request(app).get("/api/driver-shifts/jobs/q")).body;
    expect(q).toMatchObject({ status: "queued", progress: { phase: "init", percentage: 0, detail: "In coda…" } });
    expect(q).not.toHaveProperty("data");
    expect(q).not.toHaveProperty("error");
    expect((await request(app).get("/api/driver-shifts/jobs/r")).body).toMatchObject({ status: "running", progress: { phase: "optimize", percentage: 42 } });
    expect((await request(app).get("/api/driver-shifts/jobs/f")).body).toMatchObject({ status: "failed", error: "Python exit code 1" });
    const st = (await request(app).get("/api/driver-shifts/jobs/s")).body;
    expect(st.status).toBe("stopped");
    expect(st.error).toBeNull();
  });

  it("lo stream di un lavoro in corso manda il risultato quando finisce", async () => {
    const app = appDiProva(router, A);
    setTimeout(() => {
      const r = righe.get("di-a-in-corso");
      Object.assign(r, { stato: "completato", risultato: { driverShifts: [], summary: {} }, finito_il: new Date(), aggiornato_il: new Date() });
    }, 300);
    const s = await request(app).get("/api/driver-shifts/jobs/di-a-in-corso/stream");
    expect(s.text.indexOf("event: status")).toBeLessThan(s.text.indexOf("event: result"));
  });

  it("lo stop: in corso e in coda sì (prima in coda dava 400), finito no", async () => {
    const app = appDiProva(router, A);
    righe.set("q", riga("q", A.id, "in_coda"));
    expect((await request(app).post("/api/driver-shifts/jobs/di-a-in-corso/stop")).body).toEqual({ jobId: "di-a-in-corso", status: "stopped" });
    expect((await request(app).post("/api/driver-shifts/jobs/q/stop")).status).toBe(200);
    expect((await request(app).post("/api/driver-shifts/jobs/di-a/stop")).status).toBe(400);
  });

  it("un lavoro senza proprietario lo vede solo l'admin; uno di un altro tipo non c'è", async () => {
    expect((await request(appDiProva(router, A)).get("/api/driver-shifts/jobs/vecchio")).status).toBe(404);
    expect((await request(appDiProva(router, ADMIN)).get("/api/driver-shifts/jobs/vecchio")).status).toBe(200);
    expect((await request(appDiProva(router, A)).get("/api/driver-shifts/jobs/altro-tipo")).status).toBe(404);
    expect((await request(appDiProva(router, A)).get("/api/driver-shifts/jobs/inventato")).status).toBe(404);
  });
});

describe("il budget del calcolo", () => {
  it("un intero fra 10 s e un'ora (Python lo legge con int())", () => {
    expect(tempoDelCalcolo(90)).toBe(90);
    expect(tempoDelCalcolo("240")).toBe(240);
    expect(tempoDelCalcolo(120.6)).toBe(121);
    expect(tempoDelCalcolo(undefined)).toBe(120);
    expect(tempoDelCalcolo("abc")).toBe(120);
    expect(tempoDelCalcolo(1)).toBe(10);
    expect(tempoDelCalcolo(99999)).toBe(3600);
  });
});
