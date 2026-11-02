/* L'esecutore dei lavori (lib/lavori/esecutore.ts) con una coda finta in
 * memoria: slot per corsia, esiti, stop, lease perso, arresto che rimette in
 * coda, tipi sconosciuti, errore del gestore. */
import { describe, it, expect, vi } from "vitest";
import { creaEsecutore, type Gestore, type Coda } from "../lib/lavori/esecutore";
import type { Lavoro, Esito } from "../lib/lavori/coda";

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const aspetta = async (cond: () => boolean, ms = 3000) => {
  const fine = Date.now() + ms;
  while (!cond()) { if (Date.now() > fine) throw new Error("tempo scaduto"); await new Promise(r => setTimeout(r, 10)); }
};

function lavoro(id: string, corsia: "veloce" | "lunga" = "lunga", extra: Partial<Lavoro> = {}): Lavoro {
  return { id, tipo: "python", versione: 1, corsia, stato: "in_coda", utente_id: null, via: null, oggetto_id: null, chiave_unicita: null,
    richiesta: {}, metadati: {}, avanzamento: null, http_codice: null, risultato: null, errore: null, errore_tipo: null, tentativi: 0,
    max_tentativi: 2, timeout_sec: 60, disponibile_dal: new Date(), preso_da: null, battito_il: null, scade_il: null, annulla: false,
    creato_il: new Date(), iniziato_il: null, finito_il: null, aggiornato_il: new Date(), ...extra } as Lavoro;
}

function codaFinta(lavori: Lavoro[]) {
  const chiusi = new Map<string, Esito>();
  const rimessi: string[] = [];
  const battiti: Array<{ id: string; avanzamento: unknown }> = [];
  const annullati = new Set<string>();
  const persi = new Set<string>();
  const coda: Coda = {
    prendi: vi.fn(async (corsia, _chi, noti) => {
      const i = lavori.findIndex(l => l.corsia === corsia && noti.some((n: { tipo: string; versione: number }) => n.tipo === l.tipo && n.versione === l.versione));
      return i < 0 ? null : lavori.splice(i, 1)[0];
    }) as any,
    battito: vi.fn(async (id, _chi, avanzamento) => {
      battiti.push({ id, avanzamento });
      return persi.has(id) ? null : { annulla: annullati.has(id) };
    }) as any,
    chiudi: vi.fn(async (id, _chi, e) => { chiusi.set(id, e); return true; }) as any,
    rimettiInCoda: vi.fn(async (id) => { rimessi.push(id); return true; }) as any,
    recuperaScaduti: vi.fn(async () => []) as any,
    pulisci: vi.fn(async () => ({ svuotati: 0, cancellati: 0 })) as any,
  };
  return { coda, chiusi, rimessi, battiti, annullati, persi };
}

/* un gestore che finisce quando glielo si dice, o quando arriva lo stop */
function gestoreComandato() {
  const pendenti = new Map<string, (e: any) => void>();
  const g: Gestore = {
    tipo: "python", versione: 1,
    esegui: (l, ctx) => new Promise((resolve) => {
      pendenti.set(l.id, resolve);
      ctx.segnale.addEventListener("abort", () => resolve({ stato: "fermato" }));
    }),
  };
  return { g, finisci: (id: string, e: any) => pendenti.get(id)?.(e), pendenti };
}

describe("l'esecutore", () => {
  it("rispetta gli slot per corsia e chiude con l'esito del gestore", async () => {
    const f = codaFinta([lavoro("a", "lunga"), lavoro("b", "lunga"), lavoro("c", "veloce")]);
    const { g, finisci, pendenti } = gestoreComandato();
    const e = creaEsecutore({ chi: "t", slot: { lunga: 1, veloce: 1 }, gestori: [g], log, coda: f.coda, pollingMs: 20 });
    e.avvia();
    await aspetta(() => pendenti.size === 2);
    expect([...pendenti.keys()].sort()).toEqual(["a", "c"]); // b aspetta: un solo slot lungo
    finisci("a", { stato: "completato", risultato: { ok: 1 } });
    await aspetta(() => pendenti.has("b"));
    finisci("b", { stato: "fallito", errore: "Python exit code 1", erroreTipo: "calcolo" });
    finisci("c", { stato: "completato", risultato: 2 });
    await aspetta(() => f.chiusi.size === 3);
    expect(f.chiusi.get("a")).toEqual({ stato: "completato", risultato: { ok: 1 } });
    expect(f.chiusi.get("b")).toMatchObject({ stato: "fallito", erroreTipo: "calcolo" });
    await e.ferma(0);
  });

  it("lo stop letto al battito ferma il calcolo e chiude «fermato»", async () => {
    const f = codaFinta([lavoro("a")]);
    const { g, pendenti } = gestoreComandato();
    const e = creaEsecutore({ chi: "t", slot: { lunga: 1, veloce: 0 }, gestori: [g], log, coda: f.coda, pollingMs: 20, battitoMs: 50 });
    e.avvia();
    await aspetta(() => pendenti.has("a"));
    f.annullati.add("a");
    await aspetta(() => f.chiusi.has("a"));
    expect(f.chiusi.get("a")).toEqual({ stato: "fermato" });
    await e.ferma(0);
  });

  it("lease perso: il calcolo si ferma e non si scrive niente", async () => {
    const f = codaFinta([lavoro("a")]);
    const { g, pendenti } = gestoreComandato();
    const e = creaEsecutore({ chi: "t", slot: { lunga: 1, veloce: 0 }, gestori: [g], log, coda: f.coda, pollingMs: 20, battitoMs: 50 });
    e.avvia();
    await aspetta(() => pendenti.has("a"));
    f.persi.add("a");
    await aspetta(() => e.inCorso() === 0);
    expect(f.chiusi.has("a")).toBe(false);
    expect(f.rimessi).toEqual([]);
    await e.ferma(0);
  });

  it("arresto: niente lavori nuovi, quelli in corso tornano in coda", async () => {
    const f = codaFinta([lavoro("a"), lavoro("b")]);
    const { g, pendenti } = gestoreComandato();
    const e = creaEsecutore({ chi: "t", slot: { lunga: 1, veloce: 0 }, gestori: [g], log, coda: f.coda, pollingMs: 20 });
    e.avvia();
    await aspetta(() => pendenti.has("a"));
    await e.ferma(50);
    expect(f.rimessi).toEqual(["a"]);
    expect(f.chiusi.size).toBe(0);
    expect(pendenti.has("b")).toBe(false);
  });

  it("l'avanzamento va al battito, al massimo una volta al secondo", async () => {
    const f = codaFinta([lavoro("a")]);
    let ctxSalvato: any;
    const g: Gestore = { tipo: "python", versione: 1, esegui: (_l, ctx) => new Promise(r => { ctxSalvato = ctx; ctx.segnale.addEventListener("abort", () => r({ stato: "fermato" })); }) };
    const e = creaEsecutore({ chi: "t", slot: { lunga: 1, veloce: 0 }, gestori: [g], log, coda: f.coda, pollingMs: 20, battitoMs: 60_000 });
    e.avvia();
    await aspetta(() => !!ctxSalvato);
    for (let i = 1; i <= 5; i++) ctxSalvato.progresso({ phase: "optimize", percentage: i * 10, detail: "", timestamp: i });
    await aspetta(() => f.battiti.length >= 1, 2500);
    expect(f.battiti[0].avanzamento).toMatchObject({ percentage: 50 }); // solo l'ultimo
    await e.ferma(0);
  });

  it("un tipo che nessun gestore conosce resta in coda; un gestore che lancia chiude «fallito, sistema»", async () => {
    const f = codaFinta([lavoro("x", "lunga", { versione: 9 }), lavoro("y")]);
    const g: Gestore = { tipo: "python", versione: 1, esegui: async () => { throw new Error("rotto"); } };
    const e = creaEsecutore({ chi: "t", slot: { lunga: 1, veloce: 0 }, gestori: [g], log, coda: f.coda, pollingMs: 20 });
    e.avvia();
    await aspetta(() => f.chiusi.has("y"));
    expect(f.chiusi.get("y")).toMatchObject({ stato: "fallito", erroreTipo: "sistema" });
    expect(f.chiusi.has("x")).toBe(false);
    await e.ferma(0);
  });

  it("con la guardia dello schema ferma non prende niente", async () => {
    const f = codaFinta([lavoro("a")]);
    const { g, pendenti } = gestoreComandato();
    let schemaOk = false;
    const e = creaEsecutore({ chi: "t", slot: { lunga: 1, veloce: 0 }, gestori: [g], log, coda: f.coda, pollingMs: 20, puoPrendere: () => schemaOk });
    e.avvia();
    await new Promise(r => setTimeout(r, 100));
    expect(pendenti.size).toBe(0);
    schemaOk = true;
    await aspetta(() => pendenti.has("a"));
    await e.ferma(0);
  });
});
