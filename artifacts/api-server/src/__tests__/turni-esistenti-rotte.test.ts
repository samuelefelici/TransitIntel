/**
 * Le rotte dell'import dei turni esistenti (tappa 7.38) senza database: chi
 * può chiamarle, l'intestazione che obbliga al controllo CORS, il file
 * sbagliato, il progetto senza GTFS, l'anteprima dei giorni del file.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

const stato = vi.hoisted(() => ({ progetto: null as any }));

vi.mock("@workspace/db", () => ({
  db: { execute: vi.fn(async () => ({ rows: [] })), transaction: vi.fn() },
  pool: { query: vi.fn(async () => ({ rows: [] })), on: vi.fn() },
}));
vi.mock("../lib/scheduling-projects", () => ({
  loadProjectAccessible: vi.fn(async () => stato.progetto),
  logActivity: vi.fn(async () => {}),
}));

import router from "../lib/turni-esistenti/rotte";
import { db } from "@workspace/db";
import { appDiProva, utenteDiProva } from "./helpers/app-di-prova";

const P = "a0000000-0000-4000-8000-0000000000a1";
const U = utenteDiProva("10000000-0000-0000-0000-0000000000a2", ["scheduling"]);
const URL = `/api/scheduling/projects/${P}/turni-esistenti/anteprima`;
const FILE = [
  "#{", "0001 BDROP InputBDROP", "#}", "01/12/2026\t31/12/2026\t1",
  "{#SUPERLIVELLI", "1", "{#SUPERLIVELLO", "900\t01/12/2026\t900\tFALSE\tNULL\tFeriale di prova", "1",
  "{#TGUIDA", "T001", "1", "{#GIORNATA", "R\tD\tFALSE\t0\t30\t30\tInteri",
  "{#PEZZI", "1", "1\tL1\t501\tA\t380\t380\tB\t410\t410\t0\t1\tfl\ta\tNULLA\t0\tp1\t9001\tL1A\t700001\tNULLA", "0", "#END}",
  "#END}", "#END}", "#END}", "#END}",
  "{#CALENDARIO", "1", "01/12/2026 900 01/12/2026", "#END}",
].join("\n");

const manda = (corpo: string, intestazione = true, url = URL) => {
  const r = request(appDiProva(router, U)).post(url);
  if (intestazione) r.set("X-Cerbero-Import", "1");
  return r.attach("file", Buffer.from(corpo, "utf-8"), "turni.txt");
};

beforeEach(() => { stato.progetto = { id: P, my_role: "owner", feed_id: "f0000000-0000-4000-8000-0000000000f9" }; });

describe("import dei turni esistenti: rotte", () => {
  it("senza l'intestazione dell'app non si accetta (il modulo da un altro sito non passa)", async () => {
    const r = await manda(FILE, false);
    expect(r.status).toBe(400);
  });

  it("progetto che non si vede: 404; in sola lettura: 403; senza GTFS: 409", async () => {
    stato.progetto = null;
    expect((await manda(FILE)).status).toBe(404);
    stato.progetto = { id: P, my_role: "viewer", feed_id: "x" };
    expect((await manda(FILE)).status).toBe(403);
    stato.progetto = { id: P, my_role: "editor", feed_id: null };
    const r = await manda(FILE);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/GTFS/);
  });

  it("id del progetto non valido: 400", async () => {
    const r = await manda(FILE, true, "/api/scheduling/projects/xyz/turni-esistenti/anteprima");
    expect(r.status).toBe(400);
  });

  it("senza file o con un file che non è dei turni: messaggi chiari", async () => {
    const senza = await request(appDiProva(router, U)).post(URL).set("X-Cerbero-Import", "1").field("data", "2026-12-01");
    expect(senza.status).toBe(400);
    const sbagliato = await manda("nome;cognome\nmario;rossi");
    expect(sbagliato.status).toBe(422);
    expect(sbagliato.body.error).toMatch(/^File dei turni non leggibile/);
    expect(sbagliato.body.error).not.toMatch(/mario/);
  });

  it("l'anteprima senza data dà periodo e tipi di giorno", async () => {
    const r = await manda(FILE);
    expect(r.status).toBe(200);
    expect(r.body.periodo).toEqual({ dal: "2026-12-01", al: "2026-12-31" });
    expect(r.body.tipiDiGiorno).toEqual([{ chiave: "900", nomi: ["Feriale di prova"], date: ["2026-12-01"], turniGuida: 1, turniMacchina: 1 }]);
  });

  it("una data che il file non ha: 400; l'import senza data: 400", async () => {
    const r = await request(appDiProva(router, U)).post(URL).set("X-Cerbero-Import", "1")
      .field("data", "2027-01-01").attach("file", Buffer.from(FILE), "turni.txt");
    expect(r.status).toBe(400);
    const imp = await manda(FILE, true, `/api/scheduling/projects/${P}/turni-esistenti`);
    expect(imp.status).toBe(400);
    expect(imp.body.error).toMatch(/giorno/);
  });

  it("un file troppo grande si rifiuta prima di leggerlo; dopo 30 richieste al minuto, 429", async () => {
    const r = await request(appDiProva(router, U)).post(URL).set("X-Cerbero-Import", "1")
      .attach("file", Buffer.alloc(26 * 1024 * 1024, 0x41), "turni.txt");
    expect(r.status).toBe(413);
    const app = appDiProva(router, utenteDiProva("10000000-0000-0000-0000-0000000000a3", ["scheduling"]));
    const stati: number[] = [];
    for (let i = 0; i < 31; i++) stati.push((await request(app).post(URL).set("X-Cerbero-Import", "1")).status);
    expect(stati.slice(0, 30).every((x) => x === 400)).toBe(true);
    expect(stati[30]).toBe(429);
  });

  it("validità dal file: progetto di Planning Studio che non si vede, in sola lettura, senza intestazione", async () => {
    const url = `/api/planning-studio/projects/${P}/validita-da-file/anteprima`;
    expect((await manda(FILE, false, url)).status).toBe(400);
    expect((await manda(FILE, true, url)).status).toBe(404);
    vi.mocked(db.execute).mockResolvedValueOnce({ rows: [{ id: P, name: "Prova", my_role: "viewer" }] } as any);
    const r = await manda(FILE, true, `/api/planning-studio/projects/${P}/validita-da-file`);
    expect(r.status).toBe(403);
  });
});
