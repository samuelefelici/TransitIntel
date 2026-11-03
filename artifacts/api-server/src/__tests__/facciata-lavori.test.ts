/**
 * La facciata sincrona dei lavori (lib/facciata-lavori.ts) con una coda finta:
 * la risposta di un lavoro finito, lo stop quando il client se ne va, la grazia
 * all'arresto dell'API.
 */
import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { attendiEsito, rispostaDi, graziaArresto } from "../lib/facciata-lavori";

function resFinta() {
  const e = new EventEmitter() as any;
  e.codice = null; e.corpo = undefined; e.destroyed = false; e.writableEnded = false;
  e.status = (c: number) => { e.codice = c; return e; };
  e.json = (b: unknown) => { e.corpo = b; e.writableEnded = true; e.emit("close"); return e; };
  return e;
}

function codaFinta(righe: Array<any | null>) {
  let i = 0;
  return {
    leggi: vi.fn(async () => righe[Math.min(i++, righe.length - 1)]),
    chiediAnnullamento: vi.fn(async () => "in_fermata" as const),
  };
}

const inCorso = { stato: "in_corso" };

describe("la risposta di un lavoro finito", () => {
  it("completato: il risultato col suo codice; fallito con la risposta: quella; fermato: 409", () => {
    expect(rispostaDi({ stato: "completato", http_codice: 200, risultato: { ok: 1 }, errore: null, errore_tipo: null }))
      .toEqual({ codice: 200, corpo: { ok: 1 } });
    expect(rispostaDi({ stato: "fallito", http_codice: 422, risultato: { error: "x", errorKind: "lucchetto" }, errore: "x", errore_tipo: "calcolo" }))
      .toEqual({ codice: 422, corpo: { error: "x", errorKind: "lucchetto" } });
    expect(rispostaDi({ stato: "fallito", http_codice: null, risultato: null, errore: "Calcolo interrotto: rilancialo.", errore_tipo: "interrotto" }))
      .toEqual({ codice: 503, corpo: { error: "Calcolo interrotto: rilancialo." } });
    expect(rispostaDi({ stato: "fallito", http_codice: null, risultato: null, errore: "Errore interno: boom", errore_tipo: "sistema" }))
      .toEqual({ codice: 500, corpo: { error: "Errore interno: boom" } });
    expect(rispostaDi({ stato: "fermato", http_codice: null, risultato: null, errore: null, errore_tipo: "annullato" }).codice).toBe(409);
  });
});

describe("l'attesa sincrona", () => {
  it("risponde quando il lavoro finisce, senza fermarlo", async () => {
    const res = resFinta();
    const coda = codaFinta([inCorso, inCorso, { stato: "completato", http_codice: 200, risultato: { turni: 3 } }]);
    await attendiEsito(res, "j", { coda, intervalloMs: 1, segnaleArresto: new AbortController().signal });
    expect(res.codice).toBe(200);
    expect(res.corpo).toEqual({ turni: 3 });
    expect(coda.chiediAnnullamento).not.toHaveBeenCalled();
  });

  it("il client se ne va: il calcolo si ferma e non si risponde", async () => {
    const res = resFinta();
    const coda = codaFinta([inCorso]);
    const attesa = attendiEsito(res, "j", { coda, intervalloMs: 5, segnaleArresto: new AbortController().signal });
    await new Promise(r => setTimeout(r, 20));
    res.destroyed = true;
    res.emit("close");
    await attesa;
    expect(coda.chiediAnnullamento).toHaveBeenCalledTimes(1);
    expect(coda.chiediAnnullamento).toHaveBeenCalledWith("j");
    expect(res.codice).toBeNull();
  });

  it("la connessione era già chiusa prima di aspettare: stop subito", async () => {
    const res = resFinta();
    res.destroyed = true;
    const coda = codaFinta([inCorso]);
    await attendiEsito(res, "j", { coda, intervalloMs: 5, segnaleArresto: new AbortController().signal });
    expect(coda.chiediAnnullamento).toHaveBeenCalledTimes(1);
    expect(coda.leggi).not.toHaveBeenCalled();
  });

  it("arresto dell'API: aspetta la grazia, poi ferma e risponde 503", async () => {
    const res = resFinta();
    const coda = codaFinta([inCorso]);
    const arresto = new AbortController();
    arresto.abort();
    const t0 = Date.now();
    await attendiEsito(res, "j", { coda, intervalloMs: 5, graziaArrestoMs: 60, segnaleArresto: arresto.signal });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(55);
    expect(res.codice).toBe(503);
    expect(res.corpo.error).toContain("rilancia");
    expect(coda.chiediAnnullamento).toHaveBeenCalledTimes(1);
  });

  it("all'arresto, un lavoro che finisce dentro la grazia risponde normalmente", async () => {
    const res = resFinta();
    const coda = codaFinta([inCorso, { stato: "fallito", http_codice: 400, risultato: { error: "Formato data non valido" } }]);
    const arresto = new AbortController();
    arresto.abort();
    await attendiEsito(res, "j", { coda, intervalloMs: 5, graziaArrestoMs: 10_000, segnaleArresto: arresto.signal });
    expect(res.codice).toBe(400);
    expect(res.corpo).toEqual({ error: "Formato data non valido" });
    expect(coda.chiediAnnullamento).not.toHaveBeenCalled();
  });

  it("un errore di lettura non chiude l'attesa; il lavoro sparito sì (500)", async () => {
    const res = resFinta();
    const coda = codaFinta([]);
    let n = 0;
    coda.leggi = vi.fn(async () => { if (n++ === 0) throw new Error("connessione persa"); return null; }) as any;
    const warn = vi.fn();
    await attendiEsito(res, "j", { coda, intervalloMs: 1, segnaleArresto: new AbortController().signal, log: { warn } });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(res.codice).toBe(500);
  });

  it("la grazia all'arresto finisce almeno 3 s prima che l'API esca", () => {
    expect(graziaArresto({})).toBe(15_000);
    expect(graziaArresto({ CERBERO_ARRESTO_SECONDI: "28" })).toBe(15_000);
    expect(graziaArresto({ CERBERO_ARRESTO_SECONDI: "10" })).toBe(7_000);
    expect(graziaArresto({ CERBERO_ARRESTO_SECONDI: "2" })).toBe(0);
    expect(graziaArresto({ CERBERO_ARRESTO_SECONDI: "x" })).toBe(15_000);
  });

  it("chi aspetta lo dice ogni 5 s (segnaAttesa), così il lavoratore non lo ferma come abbandonato", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    try {
      const res = resFinta();
      const righe: any[] = [inCorso];
      const coda = { ...codaFinta(righe), segnaAttesa: vi.fn(async () => undefined) };
      const attesa = attendiEsito(res, "j", { coda, intervalloMs: 1_000, segnaleArresto: new AbortController().signal });
      for (let i = 0; i < 12; i++) await vi.advanceTimersByTimeAsync(1_000);
      righe[0] = { stato: "completato", http_codice: 200, risultato: { ok: 1 } };
      (coda.leggi as any).mockImplementation(async () => righe[0]);
      await vi.advanceTimersByTimeAsync(1_000);
      await attesa;
      expect(coda.segnaAttesa.mock.calls.length).toBe(2);
      expect(res.codice).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });
});

