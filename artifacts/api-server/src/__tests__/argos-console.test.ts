/**
 * La console di Argos (routes/argos-console.ts) con Argos e il database finti.
 *
 * Il proxy porta il segreto e lo slug del client; non lascia passare chiavi o
 * id malformati; un'esecuzione fatta su un progetto si vede solo da chi apre
 * quel progetto (l'elenco filtra, il dettaglio dice 404); un agente su un
 * progetto riceve il token dell'utente solo dopo il controllo d'accesso; gli
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
  };
});

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
  it("senza progetto: niente token, e lo stream passa così com'è", async () => {
    stato.risposte.push({ status: 200, body: null, sse: 'data: {"run_id":7}\n\ndata: {"done":{"run_id":7}}\n\n' });
    const r = await request(app()).post("/api/ai/argos/console/agenti/analista/esegui").send({ compito: "Come va la rete?" });
    expect(r.status).toBe(200);
    expect(r.text).toContain('"run_id":7');
    const corpo = JSON.parse(stato.chiamate[0]!.init.body);
    expect(corpo).toEqual({ compito: "Come va la rete?", client_slug: "tpl-personale", project_id: null, ti_auth_token: null });
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
