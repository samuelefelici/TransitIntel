/**
 * La coda dei lavori su un database vero (TEST_DATABASE_URL, migrato: in CI il
 * job migrazioni-postgres): presa con SKIP LOCKED da due processi, lease
 * scaduto, tentativi, stop, arresto, indice unico dei lavori vivi, pulizia.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { pool } from "@workspace/db";
import {
  accoda, leggi, prendi, battito, chiudi, chiediAnnullamento, rimettiInCoda, recuperaScaduti, pulisci, viviDi, vivoConChiave,
  segnaAttesa, fermaAbbandonati, lavoriDi, ultimoDi,
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

  it("stop in gara con chi lo sta prendendo o rimettendo in coda: non si perde", async () => {
    // prendi ancora aperto (riga bloccata, in_coda → in_corso): lo stop aspetta il lock e decide sulla riga nuova
    const a = await nuovo();
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("UPDATE coda.lavori SET stato = 'in_corso', preso_da = 'p', tentativi = 1, scade_il = now() + interval '1 minute' WHERE id = $1", [a]);
      const stop = chiediAnnullamento(a);
      await new Promise(r => setTimeout(r, 150));
      await c.query("COMMIT");
      expect(await stop).toBe("in_fermata");
    } finally { c.release(); }
    expect(await leggi(a)).toMatchObject({ stato: "in_corso", annulla: true });
    expect(await battito(a, "p")).toEqual({ annulla: true });

    // rimettiInCoda aperto (in_corso → in_coda): lo stop lo trova in coda e lo ferma
    const b = await nuovo();
    await prendi("lunga", "q", NOTI);
    const d = await pool.connect();
    try {
      await d.query("BEGIN");
      await d.query("UPDATE coda.lavori SET stato = 'in_coda', preso_da = NULL WHERE id = $1", [b]);
      const stop = chiediAnnullamento(b);
      await new Promise(r => setTimeout(r, 150));
      await d.query("COMMIT");
      expect(await stop).toBe("fermato");
    } finally { d.release(); }
    expect(await leggi(b)).toMatchObject({ stato: "fermato", errore_tipo: "annullato", annulla: true });
  });

  it("i lavori vivi di un utente in un ambito", async () => {
    const u = "10000000-0000-0000-0000-00000000000a";
    const m = { ambito: "turni-guida" };
    await nuovo("lunga", { utenteId: u, metadati: m });
    await nuovo("veloce", { utenteId: u, metadati: m });
    await nuovo("lunga", { utenteId: u, metadati: { ambito: "altro" } });
    const finito = await nuovo("lunga", { utenteId: u, metadati: m });
    await chiediAnnullamento(finito);
    expect(await viviDi(u, "turni-guida")).toBe(2);
    expect(await viviDi("10000000-0000-0000-0000-00000000000b", "turni-guida")).toBe(0);
  });

  it("i miei calcoli: solo i miei, negli ambiti chiesti, i più recenti prima, senza risultato; l'errore anche dalla risposta", async () => {
    const u = "10000000-0000-0000-0000-00000000000a", altro = "10000000-0000-0000-0000-00000000000b";
    const vecchio = await nuovo("lunga", { utenteId: u, metadati: { ambito: "turni-guida" } });
    await pool.query("UPDATE coda.lavori SET creato_il = now() - interval '1 hour' WHERE id = $1", [vecchio]);
    const fallito = await nuovo("veloce", { utenteId: u, metadati: { ambito: "turni-macchina" } });
    await pool.query(`UPDATE coda.lavori SET stato = 'fallito', http_codice = 422, risultato = '{"error":"Catene impossibili"}',
                      errore_tipo = 'calcolo', finito_il = now() WHERE id = $1`, [fallito]);
    const fatto = await nuovo("veloce", { utenteId: u, metadati: { ambito: "turni-macchina" } });
    await pool.query(`UPDATE coda.lavori SET stato = 'completato', risultato = '{"error":"non è un errore"}', finito_il = now(),
                      creato_il = now() + interval '1 second' WHERE id = $1`, [fatto]);
    await nuovo("lunga", { utenteId: u, metadati: { ambito: "prova" } });
    await nuovo("lunga", { utenteId: altro, metadati: { ambito: "turni-guida" } });
    const l = await lavoriDi(u, ["turni-guida", "turni-macchina"]);
    expect(l.map(x => x.id)).toEqual([fatto, fallito, vecchio]);
    expect(l[0]).not.toHaveProperty("risultato");
    expect(l[0]).not.toHaveProperty("richiesta");
    expect(l[0].errore).toBeNull();
    expect(l[1]).toMatchObject({ stato: "fallito", errore: "Catene impossibili", http_codice: 422 });
    expect((await lavoriDi(u, ["turni-guida", "turni-macchina"], 2)).length).toBe(2);
    expect(await lavoriDi("non-un-uuid", ["turni-guida"])).toEqual([]);
  });

  it("l'ultimo lavoro di un tipo su un oggetto", async () => {
    const o = "20000000-0000-0000-0000-000000000001";
    const primo = await accoda({ tipo: "materializza_feed", corsia: "veloce", oggettoId: o, richiesta: {}, timeoutSec: 60 });
    await pool.query("UPDATE coda.lavori SET creato_il = now() - interval '1 minute' WHERE id = $1", [primo]);
    const secondo = await accoda({ tipo: "materializza_feed", corsia: "veloce", oggettoId: o, richiesta: {}, timeoutSec: 60 });
    await accoda({ tipo: "python", corsia: "veloce", oggettoId: o, richiesta: {}, timeoutSec: 60 });
    expect((await ultimoDi("materializza_feed", o))?.id).toBe(secondo);
    expect(await ultimoDi("materializza_feed", "20000000-0000-0000-0000-000000000002")).toBeNull();
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

  it("il lavoro vivo con una chiave: in coda o in corso sì, finito no", async () => {
    expect(await vivoConChiave("giro:2")).toBeNull();
    const id = await nuovo("lunga", { chiaveUnicita: "giro:2", utenteId: "e0000000-0000-0000-0000-000000000001" });
    expect(await vivoConChiave("giro:2")).toEqual({ id, utente_id: "e0000000-0000-0000-0000-000000000001", stato: "in_coda", annulla: false });
    await prendi("lunga", "p", NOTI);
    expect(await vivoConChiave("giro:2")).toMatchObject({ id, stato: "in_corso" });
    // uno stop chiesto si vede: chi vuole seguirlo sa che finirà «fermato»
    await chiediAnnullamento(id);
    expect(await vivoConChiave("giro:2")).toMatchObject({ id, stato: "in_corso", annulla: true });
    await chiudi(id, "p", { stato: "fermato" });
    expect(await vivoConChiave("giro:2")).toBeNull();
  });

  it("un fallito porta con sé la sua risposta (il corpo di un 400 o 422); senza, risultato null", async () => {
    const a = await nuovo();
    const b = await nuovo();
    await prendi("lunga", "p", NOTI);
    await prendi("lunga", "p", NOTI);
    expect(await chiudi(a, "p", { stato: "fallito", errore: "Turno bloccato", erroreTipo: "calcolo", httpCodice: 422, risultato: { error: "Turno bloccato", errorKind: "lucchetto" } })).toBe(true);
    expect(await chiudi(b, "p", { stato: "fallito", errore: "boom", erroreTipo: "calcolo", httpCodice: 500 })).toBe(true);
    expect(await leggi(a)).toMatchObject({ stato: "fallito", http_codice: 422, risultato: { error: "Turno bloccato", errorKind: "lucchetto" } });
    expect(await leggi(b)).toMatchObject({ stato: "fallito", http_codice: 500, risultato: null });
  });

  it("i calcoli sincroni che nessuno aspetta più da un minuto si fermano; gli altri no", async () => {
    const sincrono = (m: Record<string, unknown>) => nuovo("lunga", { metadati: { sincrono: true, ...m } });
    const abbandonatoInCoda = await sincrono({});
    const abbandonatoInCorso = await sincrono({});
    const vivo = await sincrono({});
    const asincrono = await nuovo();
    await pool.query("UPDATE coda.lavori SET creato_il = now() - interval '2 minutes'");
    await pool.query("UPDATE coda.lavori SET stato = 'in_corso', preso_da = 'p' WHERE id = $1", [abbandonatoInCorso]);
    await segnaAttesa(vivo);
    const fermati = await fermaAbbandonati();
    expect(fermati.map(f => f.id).sort()).toEqual([abbandonatoInCoda, abbandonatoInCorso].sort());
    expect(await leggi(abbandonatoInCoda)).toMatchObject({ stato: "fermato", errore_tipo: "annullato", annulla: true });
    expect(await leggi(abbandonatoInCorso)).toMatchObject({ stato: "in_corso", annulla: true });
    expect(await leggi(vivo)).toMatchObject({ stato: "in_coda", annulla: false });
    expect((await leggi(vivo))!.metadati.attesa_il).toBeTruthy();
    expect(await leggi(asincrono)).toMatchObject({ stato: "in_coda", annulla: false });
    // il segno di vita invecchia: un minuto dopo anche quello si ferma
    await pool.query("UPDATE coda.lavori SET metadati = metadati || jsonb_build_object('attesa_il', now() - interval '61 seconds') WHERE id = $1", [vivo]);
    expect((await fermaAbbandonati()).map(f => f.id)).toEqual([vivo]);
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

/* PR 2.10: il canale scritto nella coda è il più preciso fra quello passato
 * e quello del contesto (argos → argos:mcp), mai uno diverso */
describe.runIf(!!process.env.TEST_DATABASE_URL)("la coda e il canale del contesto", () => {
  it("argos dal chiamante, argos:mcp dal contesto: argos:mcp; un canale diverso non si mescola", async () => {
    const { contestoDb } = await import("@workspace/db/contesto");
    const a = await contestoDb.run({ via: "argos:mcp" }, () => nuovo("lunga", { via: "argos" }));
    const b = await contestoDb.run({ via: "argos:mcp" }, () => nuovo("lunga", { via: "api" }));
    const c = await nuovo("lunga", { via: "api" });
    const { rows } = await pool.query("SELECT id, via FROM coda.lavori WHERE id = ANY ($1::uuid[])", [[a, b, c]]);
    const via = Object.fromEntries(rows.map((r: any) => [r.id, r.via]));
    expect([via[a], via[b], via[c]]).toEqual(["argos:mcp", "api", "api"]);
    await pool.query("DELETE FROM coda.lavori WHERE id = ANY ($1::uuid[])", [[a, b, c]]);
  });
});
