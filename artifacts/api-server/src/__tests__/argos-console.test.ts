/**
 * La console di Argos (routes/argos-console.ts) con Argos e il database finti.
 *
 * Il proxy porta il segreto e lo slug del client; non lascia passare chiavi o
 * id malformati; un'esecuzione fatta su un progetto si vede solo da chi apre
 * quel progetto (l'elenco filtra, il dettaglio dice 404); un agente su un
 * progetto riceve il token dell'utente solo dopo il controllo d'accesso (senza
 * progetto lo riceve un agente, per i turni salvati che hanno permessi propri); gli
 * errori di Argos sul segreto non diventano un 401 che farebbe uscire l'utente.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";

const stato = vi.hoisted(() => {
  process.env.ARGOS_URL = "http://argos.prova";
  process.env.ARGOS_PROXY_SECRET = "segreto-di-prova";
  return {
    accessibili: new Set<string>(),
    chiamate: [] as Array<{ url: string; init: any }>,
    risposte: [] as Array<{ status: number; body: any; sse?: string }>,
    righeDb: [] as any[],
  };
});

/* le chat del vecchio pannello (ps_argos_messages): righe finte */
vi.mock("@workspace/db", () => ({
  db: { execute: vi.fn(async () => ({ rows: stato.righeDb })) },
  pool: { query: vi.fn(async () => ({ rows: [] })), on: vi.fn() },
}));

vi.mock("../lib/auth", () => ({ mintShortLivedUserToken: vi.fn(() => "jwt-prova") }));
vi.mock("../lib/argos-progetto", async (importOriginal) => {
  const vero = await importOriginal<typeof import("../lib/argos-progetto")>();
  return {
    ...vero,
    accessoAlProgetto: vi.fn(async (id: string) => (stato.accessibili.has(id) ? { id } : null)),
    progettiAccessibili: vi.fn(async (ids: Iterable<string>) => new Set([...ids].filter((id) => stato.accessibili.has(id)))),
  };
});

import router, { chiaveValida, soloVisibili, traduci } from "../routes/argos-console";
import { decidi } from "../lib/permessi-rotte";
import { appDiProva, utenteDiProva } from "./helpers/app-di-prova";

const MIO = "11111111-1111-4111-8111-111111111111";
const ALTRUI = "22222222-2222-4222-8222-222222222222";
const U = utenteDiProva("10000000-0000-0000-0000-0000000000a1", ["network"]);
const app = () => appDiProva(router, U);

function rispondi(status: number, body: any) { stato.risposte.push({ status, body }); }

beforeEach(() => {
  stato.accessibili = new Set([MIO]);
  stato.chiamate = [];
  stato.risposte = [];
  stato.righeDb = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: any) => {
    stato.chiamate.push({ url: String(url), init });
    const r = stato.risposte.shift() ?? { status: 200, body: {} };
    if (r.sse !== undefined) return new Response(r.sse, { status: r.status, headers: { "content-type": "text/event-stream" } });
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe("le letture", () => {
  it("il registro passa col segreto e lo slug del client", async () => {
    rispondi(200, { totale: 79, capacita: [] });
    const r = await request(app()).get("/api/ai/argos/console/registro");
    expect(r.status).toBe(200);
    expect(r.body.totale).toBe(79);
    expect(stato.chiamate[0]!.url).toBe("http://argos.prova/console/registro?client_slug=tpl-personale");
    expect(stato.chiamate[0]!.init.headers["x-argos-proxy-secret"]).toBe("segreto-di-prova");
  });

  it("un segreto sbagliato diventa un 502 che lo dice, non un 401", async () => {
    rispondi(403, { detail: "Accesso negato" });
    const r = await request(app()).get("/api/ai/argos/console/agenti");
    expect(r.status).toBe(502);
    expect(r.body.error).toContain("ARGOS_PROXY_SECRET");
  });

  it("un errore interno di Argos non mostra il suo testo", async () => {
    rispondi(500, { detail: "psycopg.errors.UndefinedTable: relation \"agent_runs\" does not exist" });
    const r = await request(app()).get("/api/ai/argos/console/skill");
    expect(r.status).toBe(502);
    expect(r.body.error).toBe("Argos ha avuto un errore: il dettaglio è nel suo log");
    expect(JSON.stringify(r.body)).not.toContain("agent_runs");
  });

  it("Argos non raggiungibile: testo fisso, non il messaggio della rete", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("connect ECONNREFUSED 10.0.0.7:8000"); }));
    const r = await request(app()).get("/api/ai/argos/console/registro");
    expect(r.status).toBe(502);
    expect(r.body.error).toBe("Argos non raggiungibile");
  });

  it("agenti spenti in Argos: 503 che lo dice, non il messaggio sul segreto", async () => {
    rispondi(403, { detail: "Agenti disattivati (agent_enabled=false)" });
    const r = await request(app()).post("/api/ai/argos/console/agenti/analista/esegui").send({ compito: "x" });
    expect(r.text).toContain("Gli agenti sono spenti");
    expect(r.text).not.toContain("ARGOS_PROXY_SECRET");
  });

  it("una chiave malformata non arriva ad Argos", async () => {
    const r = await request(app()).get("/api/ai/argos/console/agenti/..%2Fadmin");
    expect(r.status).toBe(400);
    expect(stato.chiamate).toHaveLength(0);
  });
});

describe("le esecuzioni si vedono solo con il progetto", () => {
  it("l'elenco toglie quelle dei progetti che l'utente non apre", async () => {
    rispondi(200, { totale: 3, esecuzioni: [
      { id: 3, project_id: ALTRUI }, { id: 2, project_id: MIO }, { id: 1, project_id: "" },
    ] });
    const r = await request(app()).get("/api/ai/argos/console/esecuzioni?agente=analista&limit=500");
    expect(r.status).toBe(200);
    expect(r.body.esecuzioni.map((e: any) => e.id)).toEqual([2, 1]);
    expect(r.body.totale).toBe(2);
    expect(stato.chiamate[0]!.url).toContain("agente=analista");
    expect(stato.chiamate[0]!.url).toContain("limit=100");
  });

  it("il dettaglio di un progetto altrui è 404", async () => {
    rispondi(200, { id: 3, project_id: ALTRUI, eventi: [{ seq: 1, tipo: "avvio" }] });
    const r = await request(app()).get("/api/ai/argos/console/esecuzioni/3");
    expect(r.status).toBe(404);
    expect(r.body.eventi).toBeUndefined();
  });

  it("il dettaglio del proprio progetto e quello senza progetto si vedono", async () => {
    rispondi(200, { id: 2, project_id: MIO, eventi: [] });
    rispondi(200, { id: 1, project_id: "", eventi: [] });
    expect((await request(app()).get("/api/ai/argos/console/esecuzioni/2")).status).toBe(200);
    expect((await request(app()).get("/api/ai/argos/console/esecuzioni/1")).status).toBe(200);
  });

  it("un id non numerico non arriva ad Argos", async () => {
    expect((await request(app()).get("/api/ai/argos/console/esecuzioni/1;DROP")).status).toBe(400);
    expect(stato.chiamate).toHaveLength(0);
  });
});

describe("far lavorare un agente", () => {
  it("senza progetto: il token dell'utente per i turni salvati, e lo stream passa così com'è", async () => {
    stato.risposte.push({ status: 200, body: null, sse: 'data: {"run_id":7}\n\ndata: {"done":{"run_id":7}}\n\n' });
    const r = await request(app()).post("/api/ai/argos/console/agenti/turnista/esegui").send({ compito: "Come sono i turni festivi?" });
    expect(r.status).toBe(200);
    expect(r.text).toContain('"run_id":7');
    const corpo = JSON.parse(stato.chiamate[0]!.init.body);
    expect(corpo).toEqual({ compito: "Come sono i turni festivi?", client_slug: "tpl-personale", project_id: null, ti_auth_token: "jwt-prova" });
  });

  it("sul proprio progetto: il token dell'utente", async () => {
    stato.risposte.push({ status: 200, body: null, sse: "data: {}\n\n" });
    await request(app()).post("/api/ai/argos/console/agenti/analista/esegui").send({ compito: "Le linee?", projectId: MIO });
    const corpo = JSON.parse(stato.chiamate[0]!.init.body);
    expect(corpo.project_id).toBe(MIO);
    expect(corpo.ti_auth_token).toBe("jwt-prova");
  });

  it("su un progetto altrui: 404 e Argos non viene chiamato", async () => {
    const r = await request(app()).post("/api/ai/argos/console/agenti/analista/esegui").send({ compito: "x", projectId: ALTRUI });
    expect(r.status).toBe(404);
    expect(stato.chiamate).toHaveLength(0);
  });

  it("compito vuoto, troppo lungo o progetto malformato: 400", async () => {
    for (const body of [{ compito: "  " }, { compito: "x".repeat(4001) }, { compito: "x", projectId: "../etc" }, { compito: 42 }]) {
      expect((await request(app()).post("/api/ai/argos/console/agenti/analista/esegui").send(body)).status).toBe(400);
    }
    expect(stato.chiamate).toHaveLength(0);
  });

  it("un rifiuto di Argos arriva nello stream come errore leggibile", async () => {
    rispondi(429, { detail: "Budget mensile esaurito" });
    const r = await request(app()).post("/api/ai/argos/console/agenti/analista/esegui").send({ compito: "x" });
    expect(r.text).toContain("Budget mensile esaurito");
  });
});

describe("la biblioteca", () => {
  const ADMIN = utenteDiProva("10000000-0000-0000-0000-0000000000ad", [], "admin");
  const appAdmin = () => appDiProva(router, ADMIN);

  it("leggere: chi ha l'area Rete; la risposta passa così com'è", async () => {
    rispondi(200, { documenti: [{ id: 1, title: "Contratto", chunks: 40 }], categorie: ["Norme"] });
    const r = await request(app()).get("/api/ai/argos/console/biblioteca");
    expect(r.status).toBe(200);
    expect(r.body.documenti[0].chunks).toBe(40);
    expect(stato.chiamate[0]!.url).toBe("http://argos.prova/console/biblioteca?client_slug=tpl-personale");
  });

  it("uno stato dei caricamenti inventato non arriva ad Argos", async () => {
    expect((await request(app()).get("/api/ai/argos/console/biblioteca/caricamenti?stato=boh")).status).toBe(400);
    expect(stato.chiamate).toHaveLength(0);
  });

  it("caricare: chi non è amministratore prende 403 e Argos non viene chiamato", async () => {
    const r = await request(app()).post("/api/ai/argos/console/biblioteca/carica")
      .attach("file", Buffer.from("%PDF-1.4"), "contratto.pdf");
    expect(r.status).toBe(403);
    expect(stato.chiamate).toHaveLength(0);
  });

  it("caricare: l'amministratore inoltra file e opzioni, con lo slug del client e il parser di default", async () => {
    rispondi(200, { job_id: 5, status: "queued" });
    const r = await request(appAdmin()).post("/api/ai/argos/console/biblioteca/carica")
      .field("category", "Norme").field("parser", "inventato").field("page_from", "1;DROP")
      .attach("file", Buffer.from("%PDF-1.4 prova"), "contratto 2026.pdf");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ job_id: 5, status: "queued" });
    const c = stato.chiamate[0]!;
    expect(c.url).toBe("http://argos.prova/console/biblioteca/carica");
    expect(c.init.headers["x-argos-proxy-secret"]).toBe("segreto-di-prova");
    const form = c.init.body as FormData;
    expect((form.get("file") as File).name).toBe("contratto 2026.pdf");
    expect(form.get("category")).toBe("Norme");
    expect(form.get("parser")).toBe("auto");
    expect(form.get("client_slug")).toBe("tpl-personale");
    expect(form.get("page_from")).toBeNull();
  });

  it("caricare senza file: 400", async () => {
    expect((await request(appAdmin()).post("/api/ai/argos/console/biblioteca/carica").field("category", "x")).status).toBe(400);
    expect(stato.chiamate).toHaveLength(0);
  });

  it("modificare ed eliminare: solo l'amministratore", async () => {
    expect((await request(app()).patch("/api/ai/argos/console/biblioteca/documenti/3").send({ title: "x" })).status).toBe(403);
    expect((await request(app()).delete("/api/ai/argos/console/biblioteca/documenti/3")).status).toBe(403);
    expect((await request(app()).post("/api/ai/argos/console/biblioteca/concetti")).status).toBe(403);
    expect(stato.chiamate).toHaveLength(0);
    rispondi(200, { id: 3, title: "Nuovo" });
    const r = await request(appAdmin()).patch("/api/ai/argos/console/biblioteca/documenti/3").send({ title: "Nuovo", altro: "x" });
    expect(r.status).toBe(200);
    expect(JSON.parse(stato.chiamate[0]!.init.body)).toEqual({ title: "Nuovo" });
  });
});

describe("le mappe", () => {
  it("le mappe passano dalle rotte di Argos col segreto", async () => {
    rispondi(200, { nodes: [{ id: 1 }], edges: [], categories: [] });
    rispondi(200, { nodes: [], edges: [] });
    expect((await request(app()).get("/api/ai/argos/console/mappa/documenti")).body.nodes).toHaveLength(1);
    await request(app()).get("/api/ai/argos/console/mappa/concetti?limit=9999");
    expect(stato.chiamate[0]!.url).toBe("http://argos.prova/graph?client_slug=tpl-personale");
    expect(stato.chiamate[1]!.url).toContain("/graph/concepts?client_slug=tpl-personale&limit=300");
  });
});

describe("i permessi", () => {
  const chi = (u: ReturnType<typeof utenteDiProva>) => ({ admin: false, diritti: u.diritti });
  const lettore = utenteDiProva("10000000-0000-0000-0000-0000000000b2", [], "user", { ruoli: [] });

  it("la console è dell'area Rete: chi la legge la apre e fa lavorare un agente", () => {
    expect(decidi(chi(U), "GET", "/ai/argos/console/esecuzioni").passa).toBe(true);
    expect(decidi(chi(U), "POST", "/ai/argos/console/agenti/analista/esegui").passa).toBe(true);
  });

  it("senza l'area Rete no", () => {
    expect(decidi(chi(lettore), "GET", "/ai/argos/console/agenti").passa).toBe(false);
    expect(decidi(chi(lettore), "POST", "/ai/argos/console/agenti/analista/esegui").passa).toBe(false);
  });
});

describe("le regole pure", () => {
  it("chiavi, stati e filtro", () => {
    expect(chiaveValida("analista")).toBe(true);
    expect(chiaveValida("A")).toBe(false);
    expect(chiaveValida("../x")).toBe(false);
    expect(traduci(401, "Autenticazione richiesta").stato).toBe(502);
    expect(traduci(503, "manca").stato).toBe(502);
    expect(traduci(422, [{ loc: ["body"] }])).toEqual({ stato: 400, testo: "Richiesta non valida per Argos" });
    expect(traduci(404, "Agente inesistente")).toEqual({ stato: 404, testo: "Agente inesistente" });
    expect(traduci(500, "Traceback (most recent call last)").testo).not.toContain("Traceback");
    expect(soloVisibili([{ project_id: null }, { project_id: "a" }], new Set())).toHaveLength(1);
  });
});


describe("le conversazioni", () => {
  const CONV = "33333333-3333-4333-8333-333333333333";
  const soloLettura = { admin: false, diritti: { rete: "L" } as any };
  const io = "10000000-0000-0000-0000-0000000000a1";
  const corpo = (i = 0) => JSON.parse(stato.chiamate[i]!.init.body);

  it("l'elenco è dell'utente della sessione e nasconde i progetti che non apre più", async () => {
    rispondi(200, { conversazioni: [{ id: "a", progetto: null }, { id: "b", progetto: MIO }, { id: "c", progetto: ALTRUI }] });
    const r = await request(app()).get("/api/ai/argos/console/conversazioni?autore=qualcun-altro");
    expect(r.status).toBe(200);
    expect(r.body.conversazioni.map((c: any) => c.id)).toEqual(["a", "b"]);
    expect(stato.chiamate[0]!.url).toContain(`autore=${io}`);
    expect(stato.chiamate[0]!.url).not.toContain("qualcun-altro");
  });

  it("filtrare su un progetto altrui: 404, Argos non viene chiamato", async () => {
    const r = await request(app()).get(`/api/ai/argos/console/conversazioni?progetto=${ALTRUI}`);
    expect(r.status).toBe(404);
    expect(stato.chiamate).toHaveLength(0);
  });

  it("creare: modo e agente validati, autore dalla sessione, Pianificatore solo su un progetto", async () => {
    expect((await request(app()).post("/api/ai/argos/console/conversazioni").send({ modo: "boh" })).status).toBe(400);
    expect((await request(app()).post("/api/ai/argos/console/conversazioni").send({ modo: "agente" })).status).toBe(400);
    expect((await request(app()).post("/api/ai/argos/console/conversazioni").send({ modo: "risposta", agente: "analista" })).status).toBe(400);
    expect((await request(app()).post("/api/ai/argos/console/conversazioni").send({ modo: "agente", agente: "pianificatore" })).status).toBe(400);
    expect((await request(app()).post("/api/ai/argos/console/conversazioni").send({ modo: "risposta", progetto: ALTRUI })).status).toBe(404);
    expect(stato.chiamate).toHaveLength(0);
    rispondi(201, { conversazione: { id: CONV } });
    const r = await request(app()).post("/api/ai/argos/console/conversazioni")
      .send({ modo: "agente", agente: "pianificatore", progetto: MIO, autore: "intruso", titolo: "  Linea 1  " });
    expect(r.status).toBe(201);
    expect(corpo()).toMatchObject({ autore: io, modo: "agente", agente: "pianificatore", progetto: MIO, titolo: "Linea 1" });
  });

  it("aprire una conversazione su un progetto che non si apre più: 404", async () => {
    rispondi(200, { conversazione: { id: CONV, progetto: ALTRUI }, messaggi: [] });
    const r = await request(app()).get(`/api/ai/argos/console/conversazioni/${CONV}`);
    expect(r.status).toBe(404);
    expect(stato.chiamate[0]!.url).toContain(`/console/conversazioni/${CONV}?`);
    expect(stato.chiamate[0]!.url).toContain(`autore=${io}`);
  });

  it("un id malformato non arriva ad Argos", async () => {
    const r = await request(app()).get("/api/ai/argos/console/conversazioni/non-un-uuid");
    expect(r.status).toBe(400);
    expect(stato.chiamate).toHaveLength(0);
  });

  it("un turno: modalità validata, token dell'utente, autore dalla sessione", async () => {
    expect((await request(app()).post(`/api/ai/argos/console/conversazioni/${CONV}/messaggi`).send({ testo: "" })).status).toBe(400);
    expect((await request(app()).post(`/api/ai/argos/console/conversazioni/${CONV}/messaggi`).send({ testo: "ciao", modalita: "distruggi" })).status).toBe(400);
    rispondi(200, { conversazione: { id: CONV, progetto: MIO }, messaggi: [] });
    stato.risposte.push({ status: 200, body: null, sse: 'data: {"t":"ok"}\n\ndata: {"done":true}\n\n' });
    const r = await request(app()).post(`/api/ai/argos/console/conversazioni/${CONV}/messaggi`)
      .send({ testo: "Rinforza la linea 1", modalita: "accetta", autore: "intruso" });
    expect(r.status).toBe(200);
    expect(r.text).toContain('"done":true');
    expect(stato.chiamate[1]!.url).toBe(`http://argos.prova/console/conversazioni/${CONV}/messaggi`);
    expect(corpo(1)).toMatchObject({ autore: io, testo: "Rinforza la linea 1", modalita: "accetta", ti_auth_token: "jwt-prova" });
  });

  it("la traccia per l'animazione: ad Argos solo se chiesta, e solo sì o no", async () => {
    rispondi(200, { conversazione: { id: CONV, modo: "risposta", progetto: null }, messaggi: [] });
    stato.risposte.push({ status: 200, body: null, sse: 'data: {"trace":{"kind":"retrieval"}}\n\ndata: {"done":true}\n\n' });
    const r = await request(app()).post(`/api/ai/argos/console/conversazioni/${CONV}/messaggi`).send({ testo: "Quante linee?", traccia: true });
    expect(r.text).toContain('"kind":"retrieval"');
    expect(corpo(1).traccia).toBe(true);
    rispondi(200, { conversazione: { id: CONV, modo: "risposta", progetto: null }, messaggi: [] });
    stato.risposte.push({ status: 200, body: null, sse: 'data: {"done":true}\n\n' });
    await request(app()).post(`/api/ai/argos/console/conversazioni/${CONV}/messaggi`).send({ testo: "Quante linee?" });
    expect(corpo(3).traccia).toBe(false);
    expect((await request(app()).post(`/api/ai/argos/console/conversazioni/${CONV}/messaggi`).send({ testo: "x", traccia: "sì" })).status).toBe(400);
    expect(stato.chiamate).toHaveLength(4);
  });

  it("un turno di Risposta o Analisi senza progetto porta il token: turni guida, parco e roster per conteggi", async () => {
    for (const [modo, i] of [["risposta", 1], ["analisi", 3]] as const) {
      rispondi(200, { conversazione: { id: CONV, modo, progetto: null }, messaggi: [] });
      stato.risposte.push({ status: 200, body: null, sse: 'data: {"done":true}\n\n' });
      await request(app()).post(`/api/ai/argos/console/conversazioni/${CONV}/messaggi`).send({ testo: "Quanti mezzi fermi in officina?" });
      expect(corpo(i).ti_auth_token).toBe("jwt-prova");
    }
  });

  it("una conversazione che non è dell'utente: niente token, niente turno", async () => {
    rispondi(404, { detail: "Conversazione inesistente" });
    const r = await request(app()).post(`/api/ai/argos/console/conversazioni/${CONV}/messaggi`).send({ testo: "Quanti mezzi?" });
    expect(r.status).toBe(404);
    expect(stato.chiamate).toHaveLength(1);
  });

  it("un turno con un agente senza progetto porta il token, per i turni salvati", async () => {
    rispondi(200, { conversazione: { id: CONV, modo: "agente", agente: "turnista", progetto: null }, messaggi: [] });
    stato.risposte.push({ status: 200, body: null, sse: 'data: {"done":true}\n\n' });
    await request(app()).post(`/api/ai/argos/console/conversazioni/${CONV}/messaggi`).send({ testo: "I turni festivi passano la verifica?" });
    expect(corpo(1).ti_auth_token).toBe("jwt-prova");
  });

  it("un turno già in corso: lo stream lo dice", async () => {
    rispondi(200, { conversazione: { id: CONV, progetto: null }, messaggi: [] });
    rispondi(409, { detail: "C'è già un turno in corso in questa conversazione" });
    const r = await request(app()).post(`/api/ai/argos/console/conversazioni/${CONV}/messaggi`).send({ testo: "ciao" });
    expect(r.text).toContain("già un turno in corso");
  });

  it("importare le chat del pannello: si legge il thread dell'utente e diventa una conversazione", async () => {
    expect((await request(app()).post("/api/ai/argos/console/conversazioni/importa-pannello").send({ projectId: MIO, thread: "boh" })).status).toBe(400);
    expect((await request(app()).post("/api/ai/argos/console/conversazioni/importa-pannello").send({ projectId: ALTRUI, thread: "chat" })).status).toBe(404);
    expect((await request(app()).post("/api/ai/argos/console/conversazioni/importa-pannello").send({ projectId: MIO, thread: "chat" })).status).toBe(404);
    stato.righeDb = [{ role: "user", content: "Come va?" }, { role: "assistant", content: "Bene." }];
    rispondi(201, { conversazione: { id: CONV } });
    const r = await request(app()).post("/api/ai/argos/console/conversazioni/importa-pannello").send({ projectId: MIO, thread: "agente" });
    expect(r.status).toBe(201);
    expect(stato.chiamate[0]!.url).toContain("/console/conversazioni/importa");
    expect(corpo()).toMatchObject({ autore: io, progetto: MIO, modo: "agente", agente: "pianificatore",
      messaggi: [{ role: "user", content: "Come va?" }, { role: "assistant", content: "Bene." }] });
  });

  it("modificare ed eliminare passano dal controllo di visibilità", async () => {
    expect((await request(app()).patch(`/api/ai/argos/console/conversazioni/${CONV}`).send({})).status).toBe(400);
    rispondi(200, { conversazione: { id: CONV, progetto: ALTRUI }, messaggi: [] });
    expect((await request(app()).delete(`/api/ai/argos/console/conversazioni/${CONV}`)).status).toBe(404);
    expect(stato.chiamate.filter((c) => c.init?.method === "DELETE")).toHaveLength(0);
  });

  it("con la sola lettura sulla rete si conversa; rinominare, archiviare, eliminare, importare chiedono la scrittura", () => {
    for (const [m, p] of [["POST", "/ai/argos/console/conversazioni"], ["POST", `/ai/argos/console/conversazioni/${CONV}/messaggi`]] as const) {
      expect(decidi(soloLettura, m, p).passa, `${m} ${p}`).toBe(true);
    }
    for (const [m, p] of [["PATCH", `/ai/argos/console/conversazioni/${CONV}`], ["DELETE", `/ai/argos/console/conversazioni/${CONV}`],
      ["POST", "/ai/argos/console/conversazioni/importa-pannello"], ["POST", "/ai/argos/console/inventata"]] as const) {
      expect(decidi(soloLettura, m, p).passa, `${m} ${p}`).toBe(false);
    }
  });

  it("allegare: la conversazione dev'essere dell'utente; Argos riceve file, autore e client", async () => {
    rispondi(200, { conversazione: { id: CONV, progetto: null }, messaggi: [] });
    rispondi(200, { id: "a1", nome: "ordine 3.docx", caratteri: 1200 });
    const r = await request(app()).post(`/api/ai/argos/console/conversazioni/${CONV}/allegati`)
      .field("autore", "intruso").attach("file", Buffer.from("PK finto"), "ordine 3.docx");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ id: "a1", nome: "ordine 3.docx", caratteri: 1200 });
    expect(stato.chiamate[0]!.url).toContain(`/conversazioni/${CONV}?`);
    const c = stato.chiamate[1]!;
    expect(c.url).toBe(`http://argos.prova/console/conversazioni/${CONV}/allegati`);
    const form = c.init.body as FormData;
    expect((form.get("file") as File).name).toBe("ordine 3.docx");
    expect(form.get("autore")).toBe(io);
    expect(form.get("client_slug")).toBe("tpl-personale");
  });

  it("allegare: formati fuori elenco, file mancante e conversazioni altrui non arrivano ad Argos", async () => {
    let r = await request(app()).post(`/api/ai/argos/console/conversazioni/${CONV}/allegati`).attach("file", Buffer.from("MZ"), "virus.exe");
    expect(r.status).toBe(400);
    expect(r.body.error).toContain(".xlsx");
    r = await request(app()).post(`/api/ai/argos/console/conversazioni/${CONV}/allegati`).field("x", "y");
    expect(r.status).toBe(400);
    expect(stato.chiamate).toHaveLength(0);
    rispondi(200, { conversazione: { id: CONV, progetto: ALTRUI }, messaggi: [] });
    r = await request(app()).post(`/api/ai/argos/console/conversazioni/${CONV}/allegati`).attach("file", Buffer.from("ciao"), "nota.txt");
    expect(r.status).toBe(404);
    expect(stato.chiamate).toHaveLength(1);
    r = await request(app()).post("/api/ai/argos/console/conversazioni/non-un-id/allegati").attach("file", Buffer.from("ciao"), "nota.txt");
    expect(r.status).toBe(400);
  });

  it("allegare: il rifiuto di Argos (dati di persone) arriva all'utente così com'è", async () => {
    rispondi(200, { conversazione: { id: CONV, progetto: null }, messaggi: [] });
    rispondi(400, { detail: "turni.xlsx contiene dati di persone (codice fiscale): per decisione dell'azienda non li mando al modello." });
    const r = await request(app()).post(`/api/ai/argos/console/conversazioni/${CONV}/allegati`).attach("file", Buffer.from("PK"), "turni.xlsx");
    expect(r.status).toBe(400);
    expect(r.body.error).toContain("dati di persone");
  });

  it("elenco e rimozione degli allegati, per l'autore della sessione", async () => {
    rispondi(200, { conversazione: { id: CONV, progetto: null }, messaggi: [] });
    rispondi(200, { allegati: [{ id: "a1" }] });
    let r = await request(app()).get(`/api/ai/argos/console/conversazioni/${CONV}/allegati?autore=altro`);
    expect(r.status).toBe(200);
    expect(stato.chiamate[1]!.url).toContain(`/conversazioni/${CONV}/allegati?`);
    expect(stato.chiamate[1]!.url).toContain(`autore=${io}`);
    const AL = "44444444-4444-4444-8444-444444444444";
    rispondi(200, { conversazione: { id: CONV, progetto: null }, messaggi: [] });
    rispondi(200, { ok: true });
    r = await request(app()).delete(`/api/ai/argos/console/conversazioni/${CONV}/allegati/${AL}`);
    expect(r.status).toBe(200);
    expect(stato.chiamate[3]!.init.method).toBe("DELETE");
    expect(stato.chiamate[3]!.url).toContain(`/allegati/${AL}?`);
    expect((await request(app()).delete(`/api/ai/argos/console/conversazioni/${CONV}/allegati/boh`)).status).toBe(400);
  });

  it("un turno con allegati: al più cinque id validi, inoltrati ad Argos", async () => {
    const A = ["55555555-5555-4555-8555-555555555551", "55555555-5555-4555-8555-555555555552"];
    rispondi(200, { conversazione: { id: CONV, modo: "risposta", progetto: null }, messaggi: [] });
    stato.risposte.push({ status: 200, body: null, sse: 'data: {"done":true}\n\n' });
    await request(app()).post(`/api/ai/argos/console/conversazioni/${CONV}/messaggi`).send({ testo: "Riassumi", allegati: [A[0], A[1], A[0]] });
    expect(corpo(1).allegati).toEqual(A);
    for (const male of [["boh"], "x", Array.from({ length: 6 }, (_, i) => `55555555-5555-4555-8555-55555555555${i}`)]) {
      const r = await request(app()).post(`/api/ai/argos/console/conversazioni/${CONV}/messaggi`).send({ testo: "x", allegati: male });
      expect(r.status).toBe(400);
    }
    expect(stato.chiamate).toHaveLength(2);
  });

  it("con la sola lettura sulla rete si allega e si toglie un allegato (fa parte del messaggio)", () => {
    expect(decidi(soloLettura, "POST", `/ai/argos/console/conversazioni/${CONV}/allegati`).passa).toBe(true);
    expect(decidi(soloLettura, "DELETE", `/ai/argos/console/conversazioni/${CONV}/allegati/44444444-4444-4444-8444-444444444444`).passa).toBe(true);
  });
});
