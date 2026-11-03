/**
 * I gestori dei turni macchina e dei giri di Argos (lib/ottimizza-veicoli/
 * gestori.ts) senza database: come l'esito del calcolo diventa lo stato del
 * lavoro in coda.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const finti = vi.hoisted(() => ({
  ottimizza: vi.fn(),
  giro: vi.fn(),
  scrivi: vi.fn(async () => undefined),
  gia: vi.fn(async (): Promise<any> => null),
}));
vi.mock("../lib/ottimizza-veicoli/esegui", () => ({ eseguiOttimizzazione: finti.ottimizza }));
vi.mock("../lib/ottimizza-veicoli/giro", () => ({ eseguiGiro: finti.giro, scriviGiro: finti.scrivi, giroGiaSalvato: finti.gia }));

import { gestoreOttimizzaVeicoli, gestoreGiro } from "../lib/ottimizza-veicoli/gestori";
import type { Lavoro } from "../lib/lavori/coda";

const FEED = "e0000000-0000-0000-0000-0000000000f1";
const UTENTE = "e0000000-0000-0000-0000-0000000000a0";
const PS = "e0000000-0000-0000-0000-0000000000c1";
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const ctx = () => ({ chi: "lavoratore:x:1", segnale: new AbortController().signal, progresso: vi.fn(), log });
const lavoro = (richiesta: unknown, extra: Partial<Lavoro> = {}) =>
  ({ id: "e0000000-0000-0000-0000-000000000011", tipo: "ottimizza_veicoli", versione: 1, timeout_sec: 3600, richiesta, ...extra }) as Lavoro;

beforeEach(() => { finti.ottimizza.mockReset(); finti.giro.mockReset(); finti.scrivi.mockClear(); finti.gia.mockReset(); finti.gia.mockResolvedValue(null); });

describe("ottimizza_veicoli", () => {
  const richiesta = { mode: "cpsat", feedId: FEED, corpo: { date: "2026-11-04" } };

  it("200 → completato con la risposta; la scadenza è il tempo massimo del lavoro", async () => {
    finti.ottimizza.mockResolvedValue({ codice: 200, corpo: { solver: "cpsat", shifts: [] } });
    const prima = Date.now();
    expect(await gestoreOttimizzaVeicoli.esegui(lavoro(richiesta), ctx()))
      .toEqual({ stato: "completato", risultato: { solver: "cpsat", shifts: [] }, httpCodice: 200 });
    const [corpo, o] = finti.ottimizza.mock.calls[0];
    expect(corpo).toEqual({ date: "2026-11-04" });
    expect(o).toMatchObject({ mode: "cpsat", feedId: FEED });
    expect(o.scadenza).toBeGreaterThanOrEqual(prima + 3600_000);
    expect(o.segnale).toBeInstanceOf(AbortSignal);
  });

  it("un altro codice → fallito con codice e corpo, che la facciata ripete", async () => {
    finti.ottimizza.mockResolvedValue({ codice: 422, corpo: { error: "Turno bloccato", errorKind: "lucchetto" } });
    expect(await gestoreOttimizzaVeicoli.esegui(lavoro(richiesta), ctx())).toEqual({
      stato: "fallito", errore: "Turno bloccato", erroreTipo: "calcolo", httpCodice: 422,
      risultato: { error: "Turno bloccato", errorKind: "lucchetto" },
    });
  });

  it("stop → fermato; tempo massimo → fallito, scaduto, con i minuti", async () => {
    finti.ottimizza.mockResolvedValueOnce({ codice: 500, corpo: { error: "Calcolo fermato" }, motivo: "fermato" });
    expect(await gestoreOttimizzaVeicoli.esegui(lavoro(richiesta), ctx())).toEqual({ stato: "fermato" });
    finti.ottimizza.mockResolvedValueOnce({ codice: 500, corpo: { error: "Tempo massimo superato" }, motivo: "scaduto" });
    expect(await gestoreOttimizzaVeicoli.esegui(lavoro(richiesta), ctx())).toEqual({
      stato: "fallito", errore: "Tempo massimo superato (60 min)", erroreTipo: "scaduto", httpCodice: 500,
      risultato: { error: "Tempo massimo superato (60 min)" },
    });
  });

  it("una richiesta storta non calcola niente: fallito, sistema", async () => {
    for (const r of [null, { mode: "greedy", feedId: FEED }, { mode: "cpsat", feedId: "x" }, { mode: "vcsp" }]) {
      expect(await gestoreOttimizzaVeicoli.esegui(lavoro(r), ctx()))
        .toEqual({ stato: "fallito", errore: "Richiesta del calcolo non valida", erroreTipo: "sistema" });
    }
    expect(finti.ottimizza).not.toHaveBeenCalled();
  });
});

describe("giro_agente", () => {
  const richiesta = {
    mode: "vcsp", feedId: FEED, corpo: { date: "2026-11-04" }, params: { date: "2026-11-04" },
    salvataggio: { utenteId: UTENTE, psProjectId: PS, psName: "Rete", rawDate: "2026-11-04", creatoIl: 1 },
  };

  it("fatto → completato con un risultato piccolo; il lease va a eseguiGiro per la guardia", async () => {
    finti.giro.mockResolvedValue({ stato: "fatto", scenarioId: "s", dssId: "d", scenarioName: "n", params: {}, payload: { enorme: true } });
    const e = await gestoreGiro.esegui(lavoro(richiesta, { tipo: "giro_agente" }), ctx());
    expect(e).toMatchObject({ stato: "completato", risultato: { scenarioId: "s", dssId: "d", scenarioName: "n" },
                              avanzamento: { phase: "VCSP", percentage: 100, detail: "Completato" } });
    expect(finti.giro.mock.calls[0][1]).toMatchObject({ lavoroId: "e0000000-0000-0000-0000-000000000011", chi: "lavoratore:x:1" });
    expect(finti.scrivi).not.toHaveBeenCalled();
  });

  it("errore → fallito, con l'esito scritto per Argos; scaduto con i minuti", async () => {
    finti.giro.mockResolvedValueOnce({ stato: "errore", errore: "Nessuna corsa attiva", codice: 200 });
    expect(await gestoreGiro.esegui(lavoro(richiesta, { tipo: "giro_agente" }), ctx()))
      .toEqual({ stato: "fallito", errore: "Nessuna corsa attiva", erroreTipo: "calcolo", httpCodice: 200 });
    expect(finti.scrivi).toHaveBeenLastCalledWith(expect.objectContaining({ status: "error", error: "Nessuna corsa attiva", userId: UTENTE, psProjectId: PS }));
    finti.giro.mockResolvedValueOnce({ stato: "errore", errore: "Tempo massimo superato", scaduto: true });
    expect(await gestoreGiro.esegui(lavoro(richiesta, { tipo: "giro_agente", timeout_sec: 7200 }), ctx()))
      .toMatchObject({ stato: "fallito", errore: "Tempo massimo superato (120 min)", erroreTipo: "scaduto" });
  });

  it("fermato o stop arrivato al salvataggio → fermato, scritto; lease perso → fermato, senza scrivere", async () => {
    finti.giro.mockResolvedValueOnce({ stato: "fermato" });
    expect(await gestoreGiro.esegui(lavoro(richiesta, { tipo: "giro_agente" }), ctx())).toEqual({ stato: "fermato" });
    expect(finti.scrivi).toHaveBeenLastCalledWith(expect.objectContaining({ status: "error", error: "Giro fermato" }));
    finti.scrivi.mockClear();
    finti.giro.mockResolvedValueOnce({ stato: "non-nostro", perche: "annullato" });
    expect(await gestoreGiro.esegui(lavoro(richiesta, { tipo: "giro_agente" }), ctx())).toEqual({ stato: "fermato" });
    expect(finti.scrivi).toHaveBeenCalledTimes(1);
    finti.scrivi.mockClear();
    finti.giro.mockResolvedValueOnce({ stato: "non-nostro", perche: "lease" });
    expect(await gestoreGiro.esegui(lavoro(richiesta, { tipo: "giro_agente" }), ctx())).toEqual({ stato: "fermato" });
    expect(finti.scrivi).not.toHaveBeenCalled();
  });

  it("un giro già salvato (ripreso dopo un crash o un arresto): completato senza ricalcolare", async () => {
    finti.gia.mockResolvedValue({ scenarioId: "s", dssId: null, scenarioName: "n" });
    expect(await gestoreGiro.esegui(lavoro(richiesta, { tipo: "giro_agente" }), ctx()))
      .toMatchObject({ stato: "completato", risultato: { scenarioId: "s", dssId: null, scenarioName: "n" } });
    expect(finti.giro).not.toHaveBeenCalled();
  });

  it("all'arresto o col lease perso non si scrive l'esito per Argos: il lavoro torna in coda o è di un altro", async () => {
    for (const motivo of ["arresto", "lease"]) {
      const c = new AbortController();
      c.abort(motivo);
      finti.giro.mockResolvedValueOnce({ stato: "fermato" });
      expect(await gestoreGiro.esegui(lavoro(richiesta, { tipo: "giro_agente" }), { ...ctx(), segnale: c.signal })).toEqual({ stato: "fermato" });
    }
    expect(finti.scrivi).not.toHaveBeenCalled();
  });

  it("una richiesta storta: fallito, sistema, senza calcolare", async () => {
    const { salvataggio, ...senza } = richiesta;
    expect(await gestoreGiro.esegui(lavoro(senza, { tipo: "giro_agente" }), ctx()))
      .toEqual({ stato: "fallito", errore: "Richiesta del giro non valida", erroreTipo: "sistema" });
    expect(await gestoreGiro.esegui(lavoro({ ...richiesta, salvataggio: { ...salvataggio, utenteId: "x" } }, { tipo: "giro_agente" }), ctx()))
      .toMatchObject({ stato: "fallito", erroreTipo: "sistema" });
    expect(finti.giro).not.toHaveBeenCalled();
  });
});
