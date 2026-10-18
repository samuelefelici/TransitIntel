import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

/* il job manager vero lancerebbe Python: qui un elenco di job finti, con il
 * controllo vero di chi li può vedere (puoVedereJob) */
const jobs = new Map<string, any>();
const fermati: string[] = [];
vi.mock("../lib/job-manager.js", async (originale) => {
  const vero: any = await originale();
  return {
    ...vero,
    jobManager: {
      getJob: (id: string) => jobs.get(id) ?? null,
      stopJob: (id: string) => { fermati.push(id); return jobs.get(id)?.status === "running"; },
      getJobEmitter: () => null,
      createJob: () => "nuovo",
    },
  };
});

import router from "../routes/driver-shifts";
import { appDiProva, utenteDiProva } from "./helpers/app-di-prova";

const A = utenteDiProva("10000000-0000-0000-0000-00000000000a", ["scheduling"]);
const B = utenteDiProva("10000000-0000-0000-0000-00000000000b", ["scheduling"]);
const ADMIN = utenteDiProva("10000000-0000-0000-0000-000000000001", [], "admin");
const job = (id: string, userId: string | undefined, status = "completed") => ({
  id, scenarioId: "s", status, userId, progress: { phase: "fine", percentage: 100, detail: "", timestamp: 0 },
  progressHistory: [], result: { driverShifts: [], summary: {} }, error: null, createdAt: 0, updatedAt: 0, pid: null, metadata: {},
});

describe("i job dei turni guida: li vede e li ferma solo chi li ha lanciati", () => {
  beforeEach(() => {
    jobs.clear(); fermati.length = 0;
    jobs.set("di-a", job("di-a", A.id));
    jobs.set("di-a-in-corso", job("di-a-in-corso", A.id, "running"));
    jobs.set("vecchio", job("vecchio", undefined));
  });

  it("il job di A, chiesto da B: 404 su stato, stream e stop, e non si ferma", async () => {
    const b = appDiProva(router, B);
    expect((await request(b).get("/api/driver-shifts/jobs/di-a")).status).toBe(404);
    expect((await request(b).get("/api/driver-shifts/jobs/di-a/stream")).status).toBe(404);
    expect((await request(b).post("/api/driver-shifts/jobs/di-a-in-corso/stop")).status).toBe(404);
    expect(fermati).toEqual([]);
  });

  it("A e l'admin lo vedono; lo stream di un job finito manda il risultato", async () => {
    for (const u of [A, ADMIN]) {
      const app = appDiProva(router, u);
      const r = await request(app).get("/api/driver-shifts/jobs/di-a");
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ jobId: "di-a", status: "completed" });
      const s = await request(app).get("/api/driver-shifts/jobs/di-a/stream");
      expect(s.headers["content-type"]).toMatch(/text\/event-stream/);
      expect(s.text).toContain("event: result");
    }
  });

  it("A ferma il suo job in corso", async () => {
    const r = await request(appDiProva(router, A)).post("/api/driver-shifts/jobs/di-a-in-corso/stop");
    expect(r.status).toBe(200);
    expect(fermati).toEqual(["di-a-in-corso"]);
  });

  it("un job di prima, senza autore, lo vede solo l'admin; uno che non c'è: 404", async () => {
    expect((await request(appDiProva(router, A)).get("/api/driver-shifts/jobs/vecchio")).status).toBe(404);
    expect((await request(appDiProva(router, ADMIN)).get("/api/driver-shifts/jobs/vecchio")).status).toBe(200);
    expect((await request(appDiProva(router, ADMIN)).get("/api/driver-shifts/jobs/non-esiste")).status).toBe(404);
  });
});
