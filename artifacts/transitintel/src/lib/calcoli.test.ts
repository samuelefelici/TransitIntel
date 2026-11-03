import { describe, it, expect } from "vitest";
import { elencoCalcoli, fermaCalcolo, etichetta, statoLeggibile, percentuale, durata, linkDi, appenaFiniti, dataEsercizio, vivo, type Calcolo } from "./calcoli";

const T = 1_793_700_000_000;
const calcolo = (extra: Partial<Calcolo> = {}): Calcolo => ({
  jobId: "j1", tipo: "ottimizza_veicoli", ambito: "turni-macchina", status: "running", stopping: false, corsia: "veloce",
  progress: null, httpStatus: null, error: null, errorType: null, createdAt: T, startedAt: T + 1000, finishedAt: null, updatedAt: T,
  dettagli: { mode: "cpsat", date: "20261104", projectId: "p1", psProjectId: "ps1" }, ...extra,
});
/** un fetch finto: risponde con lo stato e il corpo dati, e ricorda le chiamate */
function finto(status: number, corpo: unknown) {
  const chiamate: Array<{ url: string; init?: RequestInit }> = [];
  const f = (async (url: string, init?: RequestInit) => {
    chiamate.push({ url, init });
    return new Response(JSON.stringify(corpo), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { f, chiamate };
}

describe("i miei calcoli", () => {
  it("elenco e stop chiamano le rotte giuste; gli errori portano il messaggio del server", async () => {
    const a = finto(200, { lavori: [calcolo()] });
    expect(await elencoCalcoli(20, { fetch: a.f, base: "https://api" })).toHaveLength(1);
    expect(a.chiamate[0].url).toBe("https://api/api/lavori?n=20");
    const b = finto(200, { jobId: "j1", status: "stopping" });
    expect(await fermaCalcolo("j1", { fetch: b.f, base: "" })).toBe("stopping");
    expect(b.chiamate[0]).toMatchObject({ url: "/api/lavori/j1/stop", init: { method: "POST" } });
    await expect(fermaCalcolo("j1", { fetch: finto(404, { error: "Calcolo non trovato" }).f, base: "" })).rejects.toThrow("Calcolo non trovato");
    await expect(elencoCalcoli(20, { fetch: finto(500, {}).f, base: "" })).rejects.toThrow("Errore 500");
  });

  it("etichette, data, stato, percentuale", () => {
    expect(etichetta(calcolo())).toBe("Turni macchina · CP-SAT");
    expect(etichetta(calcolo({ dettagli: { mode: "vcsp" } }))).toBe("Turni macchina · VCSP integrato");
    expect(etichetta(calcolo({ ambito: "turni-guida", dettagli: { scenarioName: "Feriale" } }))).toBe("Turni guida · Feriale");
    expect(etichetta(calcolo({ ambito: "materializzazione", dettagli: {} }))).toBe("Sincronizzazione con Planning Studio");
    expect(dataEsercizio(calcolo())).toBe("04/11/2026");
    expect(dataEsercizio(calcolo({ dettagli: { date: "2026-11-04" } }))).toBe("04/11/2026");
    expect(dataEsercizio(calcolo({ dettagli: {} }))).toBeNull();
    expect(statoLeggibile(calcolo({ stopping: true }))).toBe("In fermata");
    expect(statoLeggibile(calcolo({ status: "failed", errorType: "scaduto" }))).toBe("Oltre il tempo massimo");
    expect(percentuale(calcolo({ progress: { percentage: 41.6 } }))).toBe(42);
    expect(percentuale(calcolo({ progress: { percentage: 140 } }))).toBe(100);
    expect(percentuale(calcolo())).toBeNull();
  });

  it("durata: viva fino ad adesso, finita fino alla fine; in coda niente", () => {
    expect(durata(calcolo(), T + 46_000)).toBe("45 s");
    expect(durata(calcolo({ status: "completed", finishedAt: T + 1000 + 192_000 }))).toBe("3 min 12 s");
    expect(durata(calcolo({ status: "completed", finishedAt: T + 1000 + 3_900_000 }))).toBe("1 h 05 min");
    expect(durata(calcolo({ status: "queued", startedAt: null }))).toBeNull();
  });

  it("link: pipeline (con la modalità), turni guida, progetto, quadro d'esercizio; senza dati niente", () => {
    expect(linkDi(calcolo())).toBe("/fucina/p1/pipeline");
    expect(linkDi(calcolo({ dettagli: { mode: "vcsp", projectId: "p1" } }))).toBe("/fucina/p1/pipeline?mode=vcsp");
    expect(linkDi(calcolo({ ambito: "turni-guida", dettagli: { projectId: "p1", scenarioId: "s1" } }))).toBe("/fucina/p1/drivers/s1");
    expect(linkDi(calcolo({ ambito: "turni-guida", dettagli: { scenarioId: "s1" } }))).toBeNull();
    expect(linkDi(calcolo({ ambito: "materializzazione", dettagli: { schedulingProjectId: "sp" } }))).toBe("/fucina/sp");
    expect(linkDi(calcolo({ ambito: "giro-agente", dettagli: { psProjectId: "ps1" } }))).toBe("/fucina/esercizio/ps1");
    expect(linkDi(calcolo({ dettagli: { mode: "cpsat" } }))).toBeNull();
  });

  it("appena finiti: solo quelli visti vivi prima", () => {
    const prima = [calcolo({ jobId: "a" }), calcolo({ jobId: "b", status: "queued" }), calcolo({ jobId: "c", status: "completed" })];
    const dopo = [calcolo({ jobId: "a", status: "completed" }), calcolo({ jobId: "b" }), calcolo({ jobId: "c", status: "completed" }),
      calcolo({ jobId: "d", status: "failed" })];
    expect(appenaFiniti(prima, dopo).map(c => c.jobId)).toEqual(["a"]);
    expect(vivo(calcolo({ status: "queued" }))).toBe(true);
  });
});
