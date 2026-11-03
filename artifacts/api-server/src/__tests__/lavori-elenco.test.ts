/* «I miei calcoli» (GET /api/lavori, POST /api/lavori/:id/stop) con una coda
 * finta: solo i propri, niente richiesta né risultato, stop solo dei propri
 * (404 agli altri, anche all'admin), negli ambiti noti. */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

const righe = new Map<string, any>();
const chiesti: Array<{ utente: string; ambiti: readonly string[]; n: number }> = [];
vi.mock("../lib/lavori/coda", () => ({
  lavoriDi: vi.fn(async (utente: string, ambiti: readonly string[], n: number) => {
    chiesti.push({ utente, ambiti, n });
    return [...righe.values()].filter(r => r.utente_id === utente && ambiti.includes(r.metadati?.ambito));
  }),
  leggi: vi.fn(async (id: string) => righe.get(id) ?? null),
  chiediAnnullamento: vi.fn(async (id: string) => {
    const r = righe.get(id);
    if (r?.stato === "in_coda") { r.stato = "fermato"; return "fermato"; }
    if (r?.stato === "in_corso") { r.annulla = true; return "in_fermata"; }
    return null;
  }),
}));

import router, { vistaLavoro } from "../routes/lavori";
import { TUTTI_GLI_AMBITI } from "../lib/lavori/ambiti";
import { appDiProva, utenteDiProva } from "./helpers/app-di-prova";

const A = utenteDiProva("10000000-0000-0000-0000-00000000000a", ["scheduling"]);
const B = utenteDiProva("10000000-0000-0000-0000-00000000000b", ["scheduling"]);
const ADMIN = utenteDiProva("10000000-0000-0000-0000-000000000001", [], "admin");
const T = new Date("2026-11-03T09:00:00Z");
const riga = (id: string, utente: string, stato: string, metadati: Record<string, any>, extra: Record<string, any> = {}) => ({
  id, tipo: "ottimizza_veicoli", corsia: "veloce", stato, annulla: false, utente_id: utente, metadati,
  avanzamento: null, http_codice: null, errore: null, errore_tipo: null,
  creato_il: T, iniziato_il: null, finito_il: null, aggiornato_il: T, ...extra,
});

describe("i miei calcoli", () => {
  beforeEach(() => {
    righe.clear(); chiesti.length = 0;
    righe.set("a-macchina", riga("a-macchina", A.id, "in_corso",
      { ambito: "turni-macchina", mode: "cpsat", date: "20261103", projectId: "sp", psProjectId: "p", budgetSec: 60, sincrono: true },
      { iniziato_il: T, avanzamento: { phase: "solve", percentage: 40 } }));
    righe.set("a-sync", riga("a-sync", A.id, "fallito",
      { ambito: "materializzazione", schedulingProjectId: "s", psProjectId: "p" },
      { tipo: "materializza_feed", errore: "Progetto non accessibile", errore_tipo: "calcolo", finito_il: T }));
    righe.set("a-giro", riga("a-giro", A.id, "in_coda",
      { ambito: "giro-agente", mode: "vcsp", params: { round: 3, sonde: Array(500).fill(1) } }, { tipo: "giro_agente", corsia: "lunga" }));
    righe.set("b-guida", riga("b-guida", B.id, "in_corso", { ambito: "turni-guida", scenarioId: "x", scenarioName: "Feriale" }, { tipo: "python" }));
    righe.set("a-altro", riga("a-altro", A.id, "in_corso", { ambito: "prova" }, { tipo: "python" }));
  });

  it("l'elenco ha solo i calcoli di chi chiede, in tutti gli ambiti noti, senza richiesta, risultato né parametri", async () => {
    const r = await request(appDiProva(router, A)).get("/api/lavori");
    expect(r.status).toBe(200);
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(chiesti).toEqual([{ utente: A.id, ambiti: TUTTI_GLI_AMBITI, n: 20 }]);
    expect(r.body.lavori.map((l: any) => l.jobId).sort()).toEqual(["a-giro", "a-macchina", "a-sync"]);
    const m = r.body.lavori.find((l: any) => l.jobId === "a-macchina");
    expect(m).toEqual({
      jobId: "a-macchina", tipo: "ottimizza_veicoli", ambito: "turni-macchina", status: "running", stopping: false,
      corsia: "veloce", progress: { phase: "solve", percentage: 40 }, httpStatus: null, error: null, errorType: null,
      createdAt: +T, startedAt: +T, finishedAt: null, updatedAt: +T,
      dettagli: { mode: "cpsat", date: "20261103", projectId: "sp", psProjectId: "p", budgetSec: 60 },
    });
    expect(r.body.lavori.find((l: any) => l.jobId === "a-sync")).toMatchObject({ status: "failed", error: "Progetto non accessibile", errorType: "calcolo" });
    // i parametri del giro (anche grandi) restano fuori
    expect(JSON.stringify(r.body)).not.toContain("sonde");
  });

  it("n si passa alla coda (che lo limita a 50); un n non numerico vale 20", async () => {
    await request(appDiProva(router, A)).get("/api/lavori?n=7");
    await request(appDiProva(router, A)).get("/api/lavori?n=tanti");
    expect(chiesti.map(c => c.n)).toEqual([7, 20]);
  });

  it("stop: il mio in corso diventa «stopping», il mio in coda «stopped»; già finito 400", async () => {
    const a = appDiProva(router, A);
    expect((await request(a).post("/api/lavori/a-macchina/stop")).body).toEqual({ jobId: "a-macchina", status: "stopping" });
    expect((await request(a).post("/api/lavori/a-giro/stop")).body).toEqual({ jobId: "a-giro", status: "stopped" });
    const r = await request(a).post("/api/lavori/a-sync/stop");
    expect(r.status).toBe(400);
  });

  it("stop di un calcolo altrui, di un ambito sconosciuto o inesistente: 404, e non si ferma (anche per l'admin)", async () => {
    expect((await request(appDiProva(router, A)).post("/api/lavori/b-guida/stop")).status).toBe(404);
    expect((await request(appDiProva(router, ADMIN)).post("/api/lavori/b-guida/stop")).status).toBe(404);
    expect((await request(appDiProva(router, A)).post("/api/lavori/a-altro/stop")).status).toBe(404);
    expect((await request(appDiProva(router, A)).post("/api/lavori/non-ce/stop")).status).toBe(404);
    expect(righe.get("b-guida")!.annulla).toBe(false);
    expect(righe.get("a-altro")!.annulla).toBe(false);
  });

  it("vistaLavoro: uno stop chiesto su un calcolo in corso è «stopping»", () => {
    const v = vistaLavoro(riga("x", A.id, "in_corso", { ambito: "turni-guida" }, { annulla: true }) as any);
    expect(v.stopping).toBe(true);
    expect(vistaLavoro(riga("y", A.id, "in_coda", {}, { annulla: true }) as any).stopping).toBe(false);
  });
});
