/* Chi fa la modifica, per le richieste HTTP (PR 2.9): il contesto che il pool
 * porta sulla connessione (lib/contesto-http.ts, requireAuth).
 * - ogni richiesta parte come «api» col suo id;
 * - requireAuth aggiunge l'utente; il canale viene dal token (autorevole):
 *   un token di Argos dà «argos», precisato dall'header X-Argos
 *   («argos:mcp»), mentre l'header da solo, su una sessione di una persona,
 *   non cambia niente;
 * - le cron scrivono come «cron:<nome>», senza utente.
 * L'utente lo legge un client finto (niente database). */
import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";

const F = vi.hoisted(() => {
  const UTENTE = "c0000000-0000-4000-8000-00000000000c";
  const client = {
    async query(cfg: any, valori?: unknown[]) {
      const testo: string = typeof cfg === "string" ? cfg : cfg.text;
      const t = testo.replace(/\s+/g, " ").toLowerCase();
      const righe = t.includes("from users where id =") && (valori ?? cfg?.values ?? [])[0] === UTENTE
        ? [{
          id: UTENTE, email: "persona@esempio.it", full_name: "Persona", role: "user", permissions: { scheduling: true },
          fleetcare_role: null, active: true, sessione_versione: 1, mfa_attiva: true, deve_cambiare_password: false,
          mfa_recupero_chiave: null,
        }]
        : [];
      return { rows: cfg?.rowMode === "array" ? righe.map((r) => Object.values(r)) : righe, rowCount: righe.length, fields: [] };
    },
  };
  return { UTENTE, client };
});

vi.mock("@workspace/db", async () => {
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const schema = await import("@workspace/db/schema");
  return { db: drizzle(F.client as any, { schema }), pool: F.client };
});

import { contestoDb } from "@workspace/db/contesto";
import { emettiSessione, mintShortLivedUserToken, requireAuth } from "../lib/auth";
import { agentAttribution, viaPerIlDatabase } from "../lib/agent-context";
import { contestoCron, contestoRichiesta } from "../lib/contesto-http";

function app() {
  const a = express();
  // come pino-http (app.ts): l'id della richiesta
  a.use((req: any, _res, next) => { req.id = req.headers["x-request-id"] ?? "r-prova"; next(); });
  a.use(agentAttribution);
  a.use(contestoRichiesta);
  a.use("/cron", contestoCron);
  a.post("/cron/traffic", (_req, res) => { res.json(contestoDb.getStore()); });
  a.get("/pubblica", (_req, res) => { res.json(contestoDb.getStore()); });
  // dopo un await: il contesto regge
  a.get("/dati", requireAuth, async (_req, res) => {
    await new Promise((f) => setTimeout(f, 5));
    res.json(contestoDb.getStore());
  });
  return a;
}

function sessioneDi(utente: string): string {
  let valore = "";
  emettiSessione({ cookie: (_n: string, v: string) => { valore = v; } } as any, utente, { sv: 1, mfa: true });
  return valore;
}

describe("chi fa la modifica, per le richieste HTTP", () => {
  it("ogni richiesta parte come «api» col suo id, senza utente", async () => {
    const r = await request(app()).get("/pubblica").set("x-request-id", "abc-1");
    expect(r.body).toEqual({ via: "api", richiesta: "abc-1" });
  });

  it("dopo il login: l'utente, e la via resta «api» anche con l'header X-Argos", async () => {
    const token = sessioneDi(F.UTENTE);
    const r = await request(app()).get("/dati").set("Authorization", `Bearer ${token}`).set("x-request-id", "abc-2");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ via: "api", richiesta: "abc-2", attore: F.UTENTE });
    const conHeader = await request(app()).get("/dati").set("Authorization", `Bearer ${token}`).set("X-Argos", "mcp");
    expect(conHeader.body.via).toBe("api");
  });

  it("un token di Argos: «argos», precisato dall'header («argos:mcp»)", async () => {
    const token = mintShortLivedUserToken(F.UTENTE, { sv: 1, mfa: true });
    const senza = await request(app()).get("/dati").set("Authorization", `Bearer ${token}`);
    expect(senza.body).toMatchObject({ via: "argos", attore: F.UTENTE });
    const mcp = await request(app()).get("/dati").set("Authorization", `Bearer ${token}`).set("X-Argos", "mcp");
    expect(mcp.body).toMatchObject({ via: "argos:mcp", attore: F.UTENTE });
  });

  it("le cron: «cron:<nome>», senza utente", async () => {
    const r = await request(app()).post("/cron/traffic");
    expect(r.body).toEqual({ via: "cron:traffic", richiesta: "r-prova" });
  });

  it("richieste concorrenti non si mescolano", async () => {
    const token = sessioneDi(F.UTENTE);
    const a = app();
    const esiti = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2
      ? request(a).get("/dati").set("Authorization", `Bearer ${token}`).set("x-request-id", `r${i}`)
      : request(a).get("/pubblica").set("x-request-id", `r${i}`))));
    esiti.forEach((r, i) => {
      expect(r.body.richiesta).toBe(`r${i}`);
      expect(r.body.attore).toBe(i % 2 ? F.UTENTE : undefined);
    });
  });

  it("la via per il database senza richiesta: dal solo claim del token", () => {
    expect(viaPerIlDatabase(undefined)).toBe("api");
    expect(viaPerIlDatabase(null)).toBe("api");
    expect(viaPerIlDatabase("argos")).toBe("argos");
  });
});
