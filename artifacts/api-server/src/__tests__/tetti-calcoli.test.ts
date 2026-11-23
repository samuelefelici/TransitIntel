/**
 * Quanti calcoli pesanti insieme (tappa 7.21): il tetto per persona e quello
 * della coda di tutta l'installazione, con la coda finta.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const conti = { miei: 0, inCoda: 0 };
vi.mock("../lib/lavori/coda", () => ({ contaVivi: vi.fn(async () => ({ ...conti })) }));

import { AMBITI } from "../lib/lavori/ambiti";
import { controllaTetti, rispondiRifiuto, tettoCoda, TETTI_PER_PERSONA, CODA_MAX_PREDEFINITA, RIPROVA_SEC } from "../lib/lavori/tetti";

const U = "10000000-0000-0000-0000-00000000000a";

describe("i tetti dei calcoli pesanti", () => {
  beforeEach(() => { conti.miei = 0; conti.inCoda = 0; });

  it("sotto i tetti si accoda", async () => {
    conti.miei = TETTI_PER_PERSONA["turni-macchina"] - 1;
    conti.inCoda = CODA_MAX_PREDEFINITA - 1;
    expect(await controllaTetti(U, "turni-macchina", {})).toBeNull();
  });

  it("al tetto per persona: 429, col tipo di calcolo e il numero", async () => {
    conti.miei = 2;
    const r = await controllaTetti(U, AMBITI.giroAgente, {});
    expect(r).toMatchObject({ codice: 429, corpo: { limite: 2 } });
    expect(r!.corpo.error).toBe("Hai già 2 ottimizzazioni iterative in coda o in corso: aspetta che finiscano o fermane uno.");
    expect(r!.riprovaTraSec).toBeUndefined();
  });

  it("i messaggi dei turni macchina e dei turni guida restano quelli di prima", async () => {
    conti.miei = 3;
    expect((await controllaTetti(U, "turni-macchina", {}))!.corpo.error)
      .toBe("Hai già 3 calcoli dei turni macchina in coda o in corso: aspetta che finiscano o fermane uno.");
    expect((await controllaTetti(U, "turni-guida", {}))!.corpo.error)
      .toBe("Hai già 3 calcoli dei turni guida in coda o in corso: aspetta che finiscano o fermane uno.");
  });

  it("coda piena: 503 col tempo per riprovare; il tetto si cambia con CALCOLI_IN_CODA_MAX", async () => {
    conti.inCoda = CODA_MAX_PREDEFINITA;
    const r = await controllaTetti(U, "turni-guida", {});
    expect(r).toMatchObject({ codice: 503, riprovaTraSec: RIPROVA_SEC, corpo: { limite: CODA_MAX_PREDEFINITA } });
    expect(await controllaTetti(U, "turni-guida", { CALCOLI_IN_CODA_MAX: "50" })).toBeNull();
    expect(tettoCoda({ CALCOLI_IN_CODA_MAX: "0" })).toBe(CODA_MAX_PREDEFINITA);
    expect(tettoCoda({ CALCOLI_IN_CODA_MAX: "dieci" })).toBe(CODA_MAX_PREDEFINITA);
  });

  it("il tetto per persona viene prima di quello della coda", async () => {
    conti.miei = 3; conti.inCoda = 1000;
    expect((await controllaTetti(U, "turni-macchina", {}))!.codice).toBe(429);
  });

  it("la risposta porta Retry-After solo quando la coda è piena", () => {
    const intestazioni: Record<string, string> = {};
    let stato = 0; let corpo: unknown;
    const res = { set: (k: string, v: string) => { intestazioni[k] = v; }, status: (c: number) => { stato = c; return { json: (b: unknown) => { corpo = b; } }; } };
    rispondiRifiuto(res, { codice: 503, corpo: { error: "piena", limite: 30 }, riprovaTraSec: 60 });
    expect([stato, intestazioni["Retry-After"], corpo]).toEqual([503, "60", { error: "piena", limite: 30 }]);
  });
});
