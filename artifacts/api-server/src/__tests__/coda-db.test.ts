/**
 * La coda dei lavori su un database vero (TEST_DATABASE_URL, migrato: in CI il
 * job migrazioni-postgres): presa con SKIP LOCKED da due processi, lease
 * scaduto, tentativi, stop, arresto, indice unico dei lavori vivi, pulizia.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { pool } from "@workspace/db";
import {
  accoda, leggi, prendi, battito, chiudi, chiediAnnullamento, rimettiInCoda, recuperaScaduti, pulisci,
} from "../lib/lavori/coda";

const NOTI = [{ tipo: "python", versione: 1 }];
const nuovo = (corsia: "veloce" | "lunga" = "lunga", extra: Record<string, unknown> = {}) =>
  accoda({ tipo: "python", corsia, richiesta: { script: "crew_misto.py" }, timeoutSec: 60, metadati: { prova: true }, ...extra });

describe.runIf(!!process.env.TEST_DATABASE_URL)("la coda dei lavori, sul database", () => {
  beforeEach(async () => { await pool.query("DELETE FROM coda.lavori"); });
  afterAll(async () => { await pool.query("DELETE FROM coda.lavori"); });

  it("due processi che prendono insieme non prendono mai lo stesso lavoro", async () => {
    const ids = await Promise.all([nuovo(), nuovo(), nuovo()]);
    const presi = await Promise.all(Array.from({ length: 6 }, (_, i) => prendi("lunga", `p${i}`, NOTI)));
    const veri = presi.filter(Boolean).map(l => l!.id);
    expect(veri.sort()).toEqual([...ids].sort());
    expect(new Set(veri).size).toBe(3);
    const l = presi.find(Boolean)!;
    expect(l.stato).toBe("in_corso");
    expect(l.tentativi).toBe(1);
  });

  it("si prendono solo la corsia giusta e i tipi e le versioni noti", async () => {
    await nuovo("veloce");
    await accoda({ tipo: "python", versione: 2, corsia: "lunga", richiesta: {}, timeoutSec: 60 });
    expect(await prendi("lunga", "p", NOTI)).toBeNull();
    expect(await prendi("veloce", "p", NOTI)).not.toBeNull();
  });

  it("battito, avanzamento e chiusura; solo chi l'ha preso può chiudere", async () => {
    const id = await nuovo();
    await prendi("lunga", "p", NOTI);
    expect(await battito(id, "p", { phase: "optimize", percentage: 40 })).toEqual({ annulla: false });
    expect(await battito(id, "altro")).toBeNull();
    expect(await chiudi(id, "altro", { stato: "completato", risultato: 1 })).toBe(false);
    expect(await chiudi(id, "p", { stato: "completato", risultato: { turni: 3 } })).toBe(true);
    const r = await leggi(id);
    expect(r).toMatchObject({ stato: "completato", risultato: { turni: 3 }, avanzamento: { percentage: 40 } });
    expect(r!.finito_il).toBeTruthy();
    expect(await leggi("non-un-uuid")).toBeNull();
  });

  it("stop: in coda diventa subito «fermato», in corso lo legge il battito", async () => {
    const a = await nuovo();
    expect(await chiediAnnullamento(a)).toBe("fermato");
    expect(await leggi(a)).toMatchObject({ stato: "fermato", errore_tipo: "annullato" });
    expect(await prendi("lunga", "p", NOTI)).toBeNull();
    const b = await nuovo();
    await prendi("lunga", "p", NOTI);
    expect(await chiediAnnullamento(b)).toBe("in_fermata");
    expect(await battito(b, "p")).toEqual({ annulla: true });
    expect(await chiediAnnullamento(a)).toBeNull(); // già finito
  });

  it("lease scaduto: di nuovo in coda con un ritardo, poi «fallito, interrotto» finiti i tentativi", async () => {
    const id = await nuovo();
    await prendi("lunga", "p", NOTI);
    await pool.query("UPDATE coda.lavori SET scade_il = now() - interval '1 second' WHERE id = $1", [id]);
    expect(await recuperaScaduti()).toEqual([{ id, stato: "in_coda" }]);
    expect(await prendi("lunga", "p", NOTI)).toBeNull(); // il ritardo
    await pool.query("UPDATE coda.lavori SET disponibile_dal = now() WHERE id = $1", [id]);
    const l = await prendi("lunga", "q", NOTI);
    expect(l!.tentativi).toBe(2);
    await pool.query("UPDATE coda.lavori SET scade_il = now() - interval '1 second' WHERE id = $1", [id]);
    expect(await recuperaScaduti()).toEqual([{ id, stato: "fallito" }]);
    expect(await leggi(id)).toMatchObject({ stato: "fallito", errore_tipo: "interrotto" });
  });

  it("arresto ordinato: torna in coda senza consumare il tentativo (o «fermato» se era stato chiesto lo stop)", async () => {
    const a = await nuovo();
    await prendi("lunga", "p", NOTI);
    expect(await rimettiInCoda(a, "p")).toBe(true);
    expect(await leggi(a)).toMatchObject({ stato: "in_coda", tentativi: 0, preso_da: null });
    await prendi("lunga", "p", NOTI);
    await chiediAnnullamento(a);
    await rimettiInCoda(a, "p");
    expect(await leggi(a)).toMatchObject({ stato: "fermato", errore_tipo: "annullato" });
  });

  it("al più un lavoro vivo per chiave", async () => {
    await nuovo("lunga", { chiaveUnicita: "giro:1" });
    await expect(nuovo("lunga", { chiaveUnicita: "giro:1" })).rejects.toMatchObject({ code: "23505" });
    await pool.query("UPDATE coda.lavori SET stato = 'completato', finito_il = now()");
    await expect(nuovo("lunga", { chiaveUnicita: "giro:1" })).resolves.toBeTruthy();
  });

  it("pulizia: risultato e richiesta via dopo 7 giorni, righe via dopo 30", async () => {
    const vecchio = await nuovo();
    const vecchissimo = await nuovo();
    const recente = await nuovo();
    await pool.query("UPDATE coda.lavori SET stato = 'completato', risultato = '{\"x\":1}', finito_il = now() - interval '8 days' WHERE id = $1", [vecchio]);
    await pool.query("UPDATE coda.lavori SET stato = 'completato', finito_il = now() - interval '31 days' WHERE id = $1", [vecchissimo]);
    await pool.query("UPDATE coda.lavori SET stato = 'completato', risultato = '{\"x\":1}', finito_il = now() WHERE id = $1", [recente]);
    expect(await pulisci()).toEqual({ svuotati: 2, cancellati: 1 });
    expect(await leggi(vecchio)).toMatchObject({ risultato: null });
    expect(await leggi(vecchissimo)).toBeNull();
    expect(await leggi(recente)).toMatchObject({ risultato: { x: 1 } });
    const r = await pool.query("SELECT richiesta FROM coda.lavori WHERE id = $1", [vecchio]);
    expect(r.rows[0].richiesta).toEqual({});
  });
});
