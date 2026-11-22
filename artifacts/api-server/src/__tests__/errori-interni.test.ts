/**
 * Le risposte 5xx non mostrano il testo degli errori (tappa 7.13): al client
 * un messaggio generico col codice della richiesta, il dettaglio nel log
 * (senza i parametri delle query). I testi scritti apposta per l'utente
 * passano con erroreLeggibile; 503 e 504 restano come sono.
 */
import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nascondiErroriInterni, erroreLeggibile, MESSAGGIO_ERRORE_INTERNO, dettaglioPerIlLog } from "../middlewares/errori-interni";
import { errorHandler } from "../middlewares/error-handler";

const voci: any[] = [];
const log: any = { error: (o: any) => voci.push(o), warn() {}, info() {}, child() { return log; } };

function app() {
  const a = express();
  a.use((req, _res, next) => { (req as any).id = "R1"; (req as any).log = log; next(); });
  a.use(nascondiErroriInterni);
  a.get("/db", (_req, res) => {
    res.status(500).json({ error: "Failed query: select * from users where email = $1\nparams: anna@prova.local" });
  });
  a.get("/campi", (_req, res) => { res.status(500).json({ success: false, configured: true, n: 3, message: "relation \"segreti\" does not exist", dati: ["x"] }); });
  a.get("/argos", (_req, res) => { res.status(502).json({ error: "connect ECONNREFUSED 10.0.0.7:8000" }); });
  a.get("/richiesta", (_req, res) => { res.status(400).json({ error: "campo mancante" }); });
  a.get("/occupato", (_req, res) => { res.status(503).json({ error: "Calcolo già in corso: riprova fra poco" }); });
  a.get("/leggibile", (_req, res) => { erroreLeggibile(res, 500, "Messa in esercizio non riuscita: il programma di prima resta in esercizio"); });
  a.get("/testo", (_req, res) => { res.status(500).send("Errore: column \"x\" does not exist"); });
  a.get("/stato", (_req, res) => { res.sendStatus(500); });
  a.get("/oggetto", (_req, res) => { res.status(500).send({ error: "duplicate key value violates unique constraint \"users_email_key\"" }); });
  a.get("/lancia", () => { throw new Error("violates foreign key constraint \"ps_stop_times_stop_id_fkey\""); });
  a.get("/ok", (_req, res) => { res.json({ ok: true }); });
  a.use(errorHandler);
  return a;
}

const generico = { error: `${MESSAGGIO_ERRORE_INTERNO}. Se si ripete, comunica il codice R1`, richiesta: "R1" };

describe("risposte di errore interno senza dettagli", () => {
  beforeEach(() => { voci.length = 0; });

  it("un 500 col testo del database: al client il messaggio generico col codice, nel log il dettaglio senza i parametri", async () => {
    const r = await request(app()).get("/db");
    expect(r.status).toBe(500);
    expect(r.headers["content-type"]).toMatch(/application\/json/);
    expect(r.body).toEqual(generico);
    expect(JSON.stringify(r.body)).not.toMatch(/users|params|anna/);
    expect(voci).toHaveLength(1);
    expect(voci[0].stato).toBe(500);
    expect(voci[0].dettaglio).toContain("Failed query: select * from users");
    expect(voci[0].dettaglio).toContain("params: [nascosti]");
    expect(voci[0].dettaglio).not.toContain("anna@prova.local");
  });

  it("restano solo i campi sì/no e numerici", async () => {
    const r = await request(app()).get("/campi");
    expect(r.body).toEqual({ success: false, configured: true, n: 3, ...generico });
  });

  it("anche un 502 col testo di un servizio esterno", async () => {
    const r = await request(app()).get("/argos");
    expect(r.status).toBe(502);
    expect(r.body).toEqual(generico);
  });

  it("i 4xx, i 503 e le risposte buone non cambiano", async () => {
    expect((await request(app()).get("/richiesta")).body).toEqual({ error: "campo mancante" });
    const occupato = await request(app()).get("/occupato");
    expect(occupato.status).toBe(503);
    expect(occupato.body).toEqual({ error: "Calcolo già in corso: riprova fra poco" });
    expect((await request(app()).get("/ok")).body).toEqual({ ok: true });
    expect(voci).toHaveLength(0);
  });

  it("un testo scritto apposta per l'utente passa con erroreLeggibile", async () => {
    const r = await request(app()).get("/leggibile");
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: "Messa in esercizio non riuscita: il programma di prima resta in esercizio" });
  });

  it("res.send con un testo, sendStatus, send con un oggetto: sempre il messaggio generico in JSON", async () => {
    for (const via of ["/testo", "/stato", "/oggetto"]) {
      const r = await request(app()).get(via);
      expect(r.status, via).toBe(500);
      expect(r.headers["content-type"], via).toMatch(/application\/json/);
      expect(r.body, via).toEqual(generico);
    }
  });

  it("un errore lanciato arriva al gestore centrale e non mostra il testo", async () => {
    const r = await request(app()).get("/lancia");
    expect(r.status).toBe(500);
    expect(r.body).toEqual(generico);
  });

  it("nel log il dettaglio è troncato", () => {
    expect(dettaglioPerIlLog({ error: "x".repeat(5000) }).length).toBeLessThanOrEqual(2001);
  });
});

describe("nel codice", () => {
  const radice = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

  it("l'app monta il filtro dopo la compressione e prima delle rotte", () => {
    const app = readFileSync(path.join(radice, "app.ts"), "utf8");
    const comprimi = app.indexOf("app.use(comprimiRisposte)");
    const filtro = app.indexOf("app.use(nascondiErroriInterni)");
    const rotte = app.indexOf('app.use("/api", router)');
    expect(comprimi).toBeGreaterThan(0);
    expect(filtro).toBeGreaterThan(comprimi);
    expect(rotte).toBeGreaterThan(filtro);
  });

  it("erroreLeggibile non riceve mai il testo di un errore", () => {
    const file: string[] = [];
    const visita = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = path.join(d, n);
        if (n === "__tests__" || n === "node_modules") continue;
        if (statSync(p).isDirectory()) visita(p);
        else if (p.endsWith(".ts")) file.push(p);
      }
    };
    visita(radice);
    const sospetti: string[] = [];
    for (const f of file) {
      for (const [i, riga] of readFileSync(f, "utf8").split("\n").entries()) {
        for (const m of riga.matchAll(/erroreLeggibile\((.*?)\);/g)) {
          if (/\.message|String\((e|err|error)\)|\.stack/.test(m[1])) sospetti.push(`${path.relative(radice, f)}:${i + 1}`);
        }
      }
    }
    expect(file.length).toBeGreaterThan(50);
    expect(sospetti).toEqual([]);
  });
});
