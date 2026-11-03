/**
 * Turni macchina e VCSP senza database: i controlli della richiesta (gli
 * stessi 400 di sempre, prima di accodare) e corsia e tempo massimo in coda.
 */
import { describe, it, expect } from "vitest";
import { validaRichiesta, leggiRichiesta } from "../lib/ottimizza-veicoli/esegui";
import { budgetVsp, corsiaVeicoli, tempoMassimoVeicoli } from "../lib/ottimizza-veicoli/tempi";
import { vistaGiro } from "../lib/ottimizza-veicoli/giro";

const PS = "e0000000-0000-0000-0000-0000000000c1";
const buono = { psProjectId: PS, date: "2026-11-04", routes: [{ routeId: "R1", vehicleType: "12m" }] };

describe("i controlli della richiesta", () => {
  it("una richiesta buona passa, con data, tipologie e lucchetti normalizzati", () => {
    expect(validaRichiesta(buono)).toBeNull();
    const l = leggiRichiesta({
      ...buono, routes: [...buono.routes, { routeId: "RC", vehicleType: "10m", forced: true }],
      lockedChains: [{ vehicleId: " V1 ", tripIds: [" T1 ", "", null] }, { tripIds: [] }, null, { tripIds: "x" }],
    });
    expect(l).toEqual({
      dateYMD: "20261104",
      routeVehicleMap: { R1: "12m", RC: "10m" },
      routeForcedMap: { R1: false, RC: true },
      lockedChains: [{ vehicleId: "V1", tripIds: ["T1"] }],
    });
  });

  it("i 400 nell'ordine di sempre: progetto, data, formato, linee, tipologia", () => {
    const err = (c: unknown) => validaRichiesta(c);
    expect(err(undefined)).toMatchObject({ codice: 400, corpo: { error: "Progetto Planner Studio mancante" } });
    expect(err({ ...buono, psProjectId: "non-un-uuid", date: undefined })).toMatchObject({ corpo: { error: "Progetto Planner Studio mancante" } });
    expect(err({ ...buono, date: undefined })).toEqual({ codice: 400, corpo: { error: "Parametro 'date' obbligatorio (YYYYMMDD o YYYY-MM-DD)" } });
    expect(err({ ...buono, date: 20261104 })).toMatchObject({ corpo: { error: "Parametro 'date' obbligatorio (YYYYMMDD o YYYY-MM-DD)" } });
    expect(err({ ...buono, date: "4/11/2026" })).toEqual({ codice: 400, corpo: { error: "Formato data non valido" } });
    expect(err({ ...buono, routes: [] })).toEqual({ codice: 400, corpo: { error: "Parametro 'routes' obbligatorio" } });
    expect(err({ ...buono, routes: "R1" })).toMatchObject({ corpo: { error: "Parametro 'routes' obbligatorio" } });
    expect(err({ ...buono, routes: [{ routeId: "R1", vehicleType: "astronave" }] }))
      .toEqual({ codice: 400, corpo: { error: 'Tipo veicolo non valido: "astronave" per linea "R1"' } });
    expect(err({ ...buono, date: "20261104" })).toBeNull();
  });
});

describe("corsia e tempo massimo in coda", () => {
  it("il budget del VSP: l'override, altrimenti l'intensità (avanzata, poi solverIntensity)", () => {
    expect(budgetVsp({})).toBe(180);
    expect(budgetVsp(undefined)).toBe(180);
    expect(budgetVsp({ solverIntensity: "fast" })).toBe(60);
    expect(budgetVsp({ solverIntensity: "deep", vspAdvanced: { intensity: "extreme" } })).toBe(900);
    expect(budgetVsp({ solverIntensity: "fast", vspAdvanced: { totalTimeOverrideSec: 240 } })).toBe(240);
    expect(budgetVsp({ vspAdvanced: { totalTimeOverrideSec: 99999 } })).toBe(7200);
    expect(budgetVsp({ vspAdvanced: { totalTimeOverrideSec: 0, intensity: "fast" } })).toBe(60);
    expect(budgetVsp({ vspAdvanced: { totalTimeOverrideSec: "tanto" } })).toBe(180);
    expect(budgetVsp({ solverIntensity: "sconosciuta" })).toBe(180);
    // timeLimit non conta: il Python lo ignora
    expect(budgetVsp({ timeLimit: 1800, solverIntensity: "fast" })).toBe(60);
  });

  it("CP-SAT fino a 3 minuti nella corsia veloce; VCSP sempre lunga", () => {
    expect(corsiaVeicoli("cpsat", 60)).toBe("veloce");
    expect(corsiaVeicoli("cpsat", 180)).toBe("veloce");
    expect(corsiaVeicoli("cpsat", 181)).toBe("lunga");
    expect(corsiaVeicoli("vcsp", 60)).toBe("lunga");
  });

  it("tempo massimo: almeno un'ora, 4 volte il budget, al massimo 2 ore; VCSP 2 ore", () => {
    expect(tempoMassimoVeicoli("cpsat", 60)).toBe(3600);
    expect(tempoMassimoVeicoli("cpsat", 1200)).toBe(4800);
    expect(tempoMassimoVeicoli("cpsat", 3000)).toBe(7200);
    expect(tempoMassimoVeicoli("vcsp", 60)).toBe(7200);
  });
});

describe("lo stato di un giro per Argos (vistaGiro)", () => {
  const row = (extra: Record<string, unknown> = {}) => ({
    id: "g1", user_id: "u", ps_project_id: "p", mode: "vcsp", status: "running",
    created_at: "2026-11-03T08:00:00Z", finished_at: null, progress: { phase: "VCSP", pct: 0, msg: "Avvio…" },
    params: { date: "2026-11-04" }, request: { date: "2026-11-04" }, error: null, ...extra,
  });
  const coda = (stato: string, extra: Record<string, unknown> = {}) => ({
    id: "g1", stato, avanzamento: null, errore: null, risultato: null, utente_id: "u",
    metadati: { mode: "vcsp", psProjectId: "p" }, creato_il: "2026-11-03T08:00:00Z", finito_il: null, ...extra,
  }) as any;
  const adesso = Date.parse("2026-11-03T08:05:00Z");

  it("«done» vince; in coda o in corso è «running» con l'avanzamento della coda", () => {
    expect(vistaGiro(row({ status: "done", finished_at: "2026-11-03T08:02:00Z", scenario_id: "s", result_compact: { a: 1 } }), coda("fallito"), true, adesso))
      .toMatchObject({ status: "done", elapsedSec: 120, scenarioId: "s", result: { a: 1 }, persisted: true });
    expect(vistaGiro(row(), coda("in_corso", { avanzamento: { phase: "VCSP", percentage: 41.6, detail: " round 2 " } }), true, adesso))
      .toMatchObject({ status: "running", progress: { phase: "VCSP", pct: 42, msg: "round 2" }, elapsedSec: 300 });
    expect(vistaGiro(row(), coda("in_coda"), false, adesso)).toMatchObject({ status: "running", progress: { msg: "In coda…" } });
    expect(vistaGiro(row(), coda("in_corso"), false, adesso)).toMatchObject({ status: "running", progress: { msg: "Avvio…" } });
  });

  it("fallito o fermato in coda: «error» col messaggio; senza coda e «running»: interrotto", () => {
    expect(vistaGiro(row({ status: "error", error: "Nessuna corsa attiva" }), coda("fallito", { errore: "x" }), true, adesso))
      .toMatchObject({ status: "error", error: "Nessuna corsa attiva" });
    expect(vistaGiro(row(), coda("fallito", { errore: "Calcolo interrotto: rilancialo." }), true, adesso))
      .toMatchObject({ status: "error", error: "Calcolo interrotto: rilancialo." });
    expect(vistaGiro(row(), coda("fermato"), true, adesso)).toMatchObject({ status: "error", error: "Giro fermato" });
    expect(vistaGiro(row(), null, true, adesso))
      .toMatchObject({ status: "error", error: expect.stringContaining("interrotto dal riavvio"), request: { date: "2026-11-04" } });
    expect(vistaGiro(null, null, true, adesso)).toBeNull();
  });

  it("il registro non scritto: la vista viene dalla sola coda", () => {
    expect(vistaGiro(null, coda("completato", { risultato: { scenarioId: "s", dssId: null, scenarioName: "n" }, finito_il: "2026-11-03T08:01:00Z" }), true, adesso))
      .toMatchObject({ jobId: "g1", status: "done", mode: "vcsp", psProjectId: "p", scenarioId: "s", scenarioName: "n", elapsedSec: 60 });
  });

  it("nell'elenco anche quando è nato e lo scenario; un giro interrotto in coda porta la richiesta", () => {
    expect(vistaGiro(row({ status: "done", scenario_id: "s" }), null, false, adesso))
      .toMatchObject({ status: "done", createdAt: "2026-11-03T08:00:00.000Z", scenarioId: "s" });
    expect(vistaGiro(row(), coda("in_corso"), false, adesso)).toMatchObject({ createdAt: "2026-11-03T08:00:00.000Z", scenarioId: null });
    expect(vistaGiro(row(), coda("in_corso"), true, adesso)).not.toHaveProperty("createdAt");
    expect(vistaGiro(row(), coda("fallito", { errore: "Calcolo interrotto: rilancialo.", errore_tipo: "interrotto" }), true, adesso))
      .toMatchObject({ status: "error", request: { date: "2026-11-04" } });
    expect(vistaGiro(row({ status: "error", error: "Nessuna corsa" }), coda("fallito", { errore_tipo: "calcolo" }), true, adesso))
      .not.toHaveProperty("request");
  });
});

