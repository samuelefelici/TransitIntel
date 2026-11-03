import { describe, it, expect } from "vitest";
import {
  avviaCalcoloVeicoli, leggiCalcoloVeicoli, fermaCalcoloVeicoli, seguiCalcoloVeicoli, esitoDi, contestoDaRichiesta,
  CalcoloSparito, CalcoloFermato, type StatoCalcoloVeicoli,
} from "./calcolo-veicoli";

const risposta = (status: number, corpo: unknown, testo = false) =>
  new Response(testo ? String(corpo) : JSON.stringify(corpo), { status, headers: { "content-type": testo ? "text/plain" : "application/json" } });
/** un fetch finto che risponde in sequenza, e ricorda le chiamate */
function sequenza(...risposte: Array<Response | Error>) {
  const chiamate: Array<{ url: string; init?: RequestInit }> = [];
  const f = (async (url: string, init?: RequestInit) => {
    chiamate.push({ url, init });
    const r = risposte.shift();
    if (!r) throw new Error("risposte finite");
    if (r instanceof Error) throw r;
    return r;
  }) as unknown as typeof fetch;
  return { f, chiamate };
}
const stato = (extra: Partial<StatoCalcoloVeicoli>): StatoCalcoloVeicoli =>
  ({ jobId: "j", status: "running", mode: "cpsat", progress: null, createdAt: 0, updatedAt: 0, ...extra });

describe("i calcoli dei turni macchina in coda", () => {
  it("avvio con ?asincrono=1: il jobId; un errore immediato porta il messaggio del server", async () => {
    const a = sequenza(risposta(202, { jobId: "j1", status: "queued" }));
    expect(await avviaCalcoloVeicoli("vcsp", { date: "20261104" }, { fetch: a.f, base: "" })).toBe("j1");
    expect(a.chiamate[0].url).toBe("/api/service-program/vcsp?asincrono=1");
    expect(JSON.parse(String(a.chiamate[0].init?.body))).toEqual({ date: "20261104" });
    await expect(avviaCalcoloVeicoli("cpsat", {}, { fetch: sequenza(risposta(429, { error: "Hai già 3 calcoli" })).f, base: "" }))
      .rejects.toThrow("Hai già 3 calcoli");
  });

  it("lettura: con la richiesta se chiesta; il 404 dell'API è «non c'è più», quello di un proxy no", async () => {
    const a = sequenza(risposta(200, stato({ request: { date: "x" } })));
    expect((await leggiCalcoloVeicoli("j1", { richiesta: true }, { fetch: a.f, base: "" }))?.request).toEqual({ date: "x" });
    expect(a.chiamate[0].url).toBe("/api/service-program/lavori/j1?richiesta=1");
    expect(await leggiCalcoloVeicoli("j1", {}, { fetch: sequenza(risposta(404, { error: "Calcolo non trovato" })).f, base: "" })).toBeNull();
    await expect(leggiCalcoloVeicoli("j1", {}, { fetch: sequenza(risposta(404, "Not Found", true)).f, base: "" })).rejects.toThrow();
  });

  it("esito: 200 è il risultato; 422 l'errore del solver; fermato è CalcoloFermato", () => {
    expect(esitoDi(stato({ status: "completed", httpStatus: 200, result: { summary: {} } }))).toEqual({ summary: {} });
    expect(() => esitoDi(stato({ status: "failed", httpStatus: 422, result: { error: "Catene impossibili" } }))).toThrow("Catene impossibili");
    expect(() => esitoDi(stato({ status: "stopped", httpStatus: 409 }))).toThrow(CalcoloFermato);
    expect(() => esitoDi(stato({ status: "failed" }))).toThrow("Calcolo non riuscito");
  });

  it("segue fino alla fine, riprovando un errore di rete; avanzamento a ogni lettura", async () => {
    const a = sequenza(
      risposta(200, stato({ status: "queued" })),
      new TypeError("Failed to fetch"),
      risposta(200, stato({ progress: { percentage: 50 } })),
      risposta(200, stato({ status: "completed", httpStatus: 200, result: { summary: { totalVehicles: 9 } } })),
    );
    const visti: string[] = [];
    const r = await seguiCalcoloVeicoli("j1", { intervalloMs: 1, rete: { fetch: a.f, base: "" }, onStato: s => visti.push(s.status) });
    expect(r).toEqual({ summary: { totalVehicles: 9 } });
    expect(visti).toEqual(["queued", "running", "completed"]);
  });

  it("un calcolo sparito lancia CalcoloSparito; smettere di seguirlo non lo ferma (nessuno stop chiamato)", async () => {
    await expect(seguiCalcoloVeicoli("j1", { intervalloMs: 1, rete: { fetch: sequenza(risposta(404, { error: "x" })).f, base: "" } }))
      .rejects.toBeInstanceOf(CalcoloSparito);
    const fermo = new AbortController();
    const a = sequenza(risposta(200, stato({})), risposta(200, stato({})));
    const p = seguiCalcoloVeicoli("j1", { intervalloMs: 50, segnale: fermo.signal, rete: { fetch: a.f, base: "" } });
    setTimeout(() => fermo.abort(), 10);
    await expect(p).rejects.toThrow();
    expect(a.chiamate.every(c => !c.url.endsWith("/stop"))).toBe(true);
  });

  it("stop: chiama la rotta; «già finito» (400) va bene", async () => {
    const a = sequenza(risposta(200, { status: "stopping" }), risposta(400, { error: "Il calcolo è già finito" }));
    await fermaCalcoloVeicoli("j1", { fetch: a.f, base: "" });
    await fermaCalcoloVeicoli("j1", { fetch: a.f, base: "" });
    expect(a.chiamate[0]).toMatchObject({ url: "/api/service-program/lavori/j1/stop", init: { method: "POST" } });
  });
});

describe("il contesto del wizard dalla richiesta", () => {
  // il corpo come lo costruisce OptimizerStep (bodyPayload) per un VCSP
  const corpo = {
    date: "20261104", serviceType: "urbano", feedId: "f1", projectId: "p1", psProjectId: "ps1",
    routes: [{ routeId: "R1", vehicleType: "12m", forced: true }, { routeId: "R2", vehicleType: "10m", forced: false }],
    tripVehicleOverrides: { T9: "18m" }, excludedTripIds: ["T7"],
    depots: [{ id: "d1", maxVehicles: 20 }],
    timeLimit: 180, solverIntensity: "normal",
    vcsp: { rounds: 3, crewTimeLimit: 60, probes: 4 },
    crewConfig: { bds: { serviceType: "urbano" } },
    robustness: "media", vspNormativa: { maxGuida: 270 },
    vehicleCosts: { fixedDaily: 100 }, vspAdvanced: { totalTimeOverrideSec: 120 },
  };

  it("ricostruisce assegnazione, depositi, modalità e impostazioni", () => {
    const c = contestoDaRichiesta("vcsp", corpo)!;
    expect(c.assegnazione.selectedDate).toBe("20261104");
    expect([...c.assegnazione.selectedRoutes]).toEqual([["R1", "12m"], ["R2", "10m"]]);
    expect([...c.assegnazione.forcedRoutes]).toEqual(["R1"]);
    expect([...c.assegnazione.tripVehicleOverrides]).toEqual([["T9", "18m"]]);
    expect([...(c.assegnazione.excludedTripIds ?? [])]).toEqual(["T7"]);
    expect(c.depositi).toEqual([{ id: "d1", maxVehicles: 20 }]);
    expect(c.pipelineMode).toBe("vcsp");
    expect(c.impostazioni).toEqual({
      solverMode: "vcsp", solverIntensity: "normal", serviceType: "urbano", robustness: "media",
      normativa: { maxGuida: 270 }, vehicleCosts: { fixedDaily: 100 }, vspAdvanced: { totalTimeOverrideSec: 120 },
      vcspRounds: 3, crewTimeLimit: 60, vcspProbe: true, crewConfig: { bds: { serviceType: "urbano" } },
    });
  });

  it("CP-SAT minimo: niente esclusi, robustezza spenta, pipeline classica; senza richiesta niente", () => {
    const c = contestoDaRichiesta("cpsat", { date: "20261104", routes: [{ routeId: "R1", vehicleType: "12m" }] })!;
    expect(c.pipelineMode).toBe("classic");
    expect(c.assegnazione.excludedTripIds).toBeUndefined();
    expect(c.impostazioni).toEqual({ solverMode: "cpsat", robustness: "off" });
    expect(contestoDaRichiesta("cpsat", null)).toBeNull();
    expect(contestoDaRichiesta("cpsat", { routes: [] })).toBeNull();
  });
});
