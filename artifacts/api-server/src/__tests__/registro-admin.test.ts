/* GET /api/admin/registro (PR 2.11): il registro delle modifiche per
 * l'amministratore. Il database è finto: risponde a registro.stato(), a
 * registro.leggi() e alle letture dei nomi, e tiene quello che gli si chiede.
 * - solo admin;
 * - nessun parametro per persona, e l'ambito si fissa solo se non è una persona;
 * - la lettura passa da registro.leggi(), mai dalle tabelle del registro;
 * - i nomi: chi ha fatto la modifica e gli ambiti, ma non i conducenti;
 * - le pagine: una riga in più per sapere se continuano, e il cursore.
 * Sul database vero lo provano registro.test.sql e registro-db.test.ts. */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

const F = vi.hoisted(() => {
  const ADMIN = "a0000000-0000-4000-8000-0000000000a1";
  const PROGETTO = "b0000000-0000-4000-8000-0000000000b1";
  const CONDUCENTE = "c0000000-0000-4000-8000-0000000000c1";
  const stato = {
    attivo: true, attivato_il: "2026-11-01T08:00:00+00:00", base_giuridica: "accordo di prova", anonimizza_dopo_mesi: 12, conservazione_mesi: 60,
    tabelle: [
      { tabella: "public.ps_projects", ambito_tipo: "progetto_ps", con_valori: true, riepilogo_sempre: false },
      { tabella: "public.ps_stop_times", ambito_tipo: "corsa", con_valori: false, riepilogo_sempre: true },
      { tabella: "public.roster_entries", ambito_tipo: "conducente", con_valori: false, riepilogo_sempre: false },
    ],
  };
  // come le dà registro.leggi(): l'id cresce con la scrittura, la data è ISO coi microsecondi
  const riga = (i: number, extra: Record<string, unknown> = {}) => ({
    id: String(1000 - i), ts: "2026-11-09T10:00:00.123456Z", transazione: String(900 - Math.floor(i / 3)),
    richiesta: `r-${i}`, attore: ADMIN, via: "api", ruolo_db: "cerbero_app", origine: "cerbero-api",
    tabella: "public.ps_projects", operazione: "UPDATE", chiave: { id: PROGETTO }, ambito_tipo: "progetto_ps", ambito_id: PROGETTO,
    campi: ["name"], prima: { name: `vecchio ${i}` }, dopo: { name: `nuovo ${i}` }, riepilogo: false, righe: 1, campione: null, a_cascata: false,
    ...extra,
  });
  const s = { righe: [] as any[], chieste: [] as Array<{ testo: string; valori: unknown[] }> };
  const client = {
    async query(cfg: any, valori?: unknown[]) {
      const testo: string = (typeof cfg === "string" ? cfg : cfg.text).replace(/\s+/g, " ").toLowerCase();
      const v = (valori ?? cfg?.values ?? []) as unknown[];
      s.chieste.push({ testo, valori: v });
      let righe: any[] = [];
      if (testo.includes("registro.stato()")) righe = [{ s: stato }];
      else if (testo.includes("from registro.leggi(")) righe = s.righe.slice(0, Number(v[1]));
      else if (testo.includes("from users where id = any(")) {
        righe = testo.includes("full_name, email")
          ? [{ id: ADMIN, full_name: "Ada Admin", email: "ada@esempio.it" }]
          : [{ id: ADMIN, nome: "Ada Admin" }];
      } else if (testo.includes("from ps_projects where id = any(")) righe = [{ id: PROGETTO, nome: "Programma invernale" }];
      return { rows: righe, rowCount: righe.length, fields: [] };
    },
  };
  return { ADMIN, PROGETTO, CONDUCENTE, stato, riga, s, client };
});

vi.mock("@workspace/db", async () => {
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const schema = await import("@workspace/db/schema");
  return { ...schema, db: drizzle(F.client as any, { schema }), pool: { query: vi.fn(async () => ({ rows: [] })), on: vi.fn() } };
});

import adminRouter from "../routes/admin";
import { codificaCursore, leggiCursore } from "../lib/registro-modifiche";
import { viaDelGiro } from "../lib/agent-context";
import { appDiProva, utenteDiProva } from "./helpers/app-di-prova";

const admin = () => appDiProva(adminRouter, utenteDiProva("ada", [], "admin"));
const chiamateALeggi = () => F.s.chieste.filter((c) => c.testo.includes("from registro.leggi("));

beforeEach(() => { F.s.righe = []; F.s.chieste = []; });

describe("GET /api/admin/registro", () => {
  it("solo admin: senza utente 401, un utente con tutti i permessi 403", async () => {
    expect((await request(appDiProva(adminRouter, null)).get("/api/admin/registro")).status).toBe(401);
    const tutto = utenteDiProva("u", ["analytics", "fares", "scheduling", "network", "fleetcare", "centrale", "personale", "roster"]);
    const r = await request(appDiProva(adminRouter, tutto)).get("/api/admin/registro");
    expect(r.status).toBe(403);
    expect(F.s.chieste).toEqual([]);
  });

  it("legge con registro.leggi(), mai dalle tabelle; dà lo stato, le righe e i nomi", async () => {
    F.s.righe = [F.riga(0), F.riga(1, { attore: null, via: "timer:attivazioni" })];
    const r = await request(admin()).get("/api/admin/registro");
    expect(r.status).toBe(200);
    // ogni lettura del registro è una funzione: nessun FROM/JOIN su una sua tabella
    for (const c of F.s.chieste) expect(c.testo).not.toMatch(/(from|join) registro\.(modifiche|letture|parziali|impostazioni|sorvegliate)/);
    const [l] = chiamateALeggi();
    expect(JSON.parse(String(l!.valori[0]))).toEqual({});
    expect(l!.valori.slice(1)).toEqual([51]);
    // la lettura ha il suo tempo massimo, nella stessa transazione
    expect(F.s.chieste.map((c) => c.testo).filter((t) => /^(begin|commit|set local)/.test(t))).toEqual(["begin", "set local statement_timeout = '10s'", "commit"]);
    expect(r.body.stato).toMatchObject({ attivo: true, baseGiuridica: "accordo di prova", anonimizzaDopoMesi: 12 });
    expect(r.body.stato.tabelle).toHaveLength(3);
    expect(r.body.righe).toHaveLength(2);
    expect(r.body.righe[0]).toMatchObject({
      id: "1000", ts: "2026-11-09T10:00:00.123Z",
      attore: { id: F.ADMIN, nome: "Ada Admin", email: "ada@esempio.it" }, via: "api", ruoloDb: "cerbero_app",
      tabella: "public.ps_projects", operazione: "UPDATE", campi: ["name"], prima: { name: "vecchio 0" }, dopo: { name: "nuovo 0" },
      ambito: { tipo: "progetto_ps", id: F.PROGETTO, nome: "Programma invernale" }, riepilogo: false, aCascata: false,
    });
    // un processo di sistema, o una riga anonimizzata: nessuno
    expect(r.body.righe[1].attore).toBeNull();
    expect(r.body.successivo).toBeNull();
  });

  it("i conducenti non si risolvono, né gli id dei campioni", async () => {
    F.s.righe = [
      F.riga(0, { tabella: "public.roster_entries", ambito_tipo: "conducente", ambito_id: F.CONDUCENTE, prima: null, dopo: null, campi: ["code"] }),
      F.riga(1, { tabella: "public.ps_stop_times", riepilogo: true, righe: 30, chiave: null, prima: null, dopo: null, campi: null,
        ambito_tipo: "corsa", ambito_id: null, campione: [{ trip_id: F.PROGETTO, stop_seq: 1 }, null] }),
    ];
    const r = await request(admin()).get("/api/admin/registro");
    expect(r.status).toBe(200);
    expect(r.body.righe[0].ambito).toEqual({ tipo: "conducente", id: F.CONDUCENTE, nome: null });
    // (un elemento vuoto del campione, da una regola senza chiave, si toglie)
    expect(r.body.righe[1]).toMatchObject({ riepilogo: true, righe: 30, campione: [{ trip_id: F.PROGETTO, stop_seq: 1 }], ambito: { tipo: "corsa", id: null, nome: null } });
    expect(r.body.righe[1].campione).toHaveLength(1);
    for (const c of F.s.chieste) expect(c.testo).not.toMatch(/roster_|ps_trips/);
  });

  it("niente per persona: ogni parametro in più è un errore, e l'ambito di una persona non si fissa", async () => {
    for (const q of ["attore=" + F.ADMIN, "utente=" + F.ADMIN, "userId=" + F.ADMIN, "ordine=attore", "chiave=x"]) {
      const r = await request(admin()).get(`/api/admin/registro?${q}`);
      expect(r.status, q).toBe(400);
      expect(r.body.error, q).toMatch(/non per persona/);
    }
    for (const tipo of ["utente", "conducente"]) {
      const r = await request(admin()).get(`/api/admin/registro?ambitoTipo=${tipo}&ambitoId=${F.CONDUCENTE}`);
      expect(r.status, tipo).toBe(400);
    }
    expect((await request(admin()).get(`/api/admin/registro?ambitoId=${F.PROGETTO}`)).status).toBe(400);
    expect(chiamateALeggi()).toEqual([]);
    // tutte le persone insieme sì; un progetto col suo id sì
    expect((await request(admin()).get("/api/admin/registro?ambitoTipo=conducente")).status).toBe(200);
    const r = await request(admin()).get(`/api/admin/registro?ambitoTipo=progetto_ps&ambitoId=${F.PROGETTO.toUpperCase()}&operazione=UPDATE&tabella=public.ps_projects`);
    expect(r.status).toBe(200);
    expect(JSON.parse(String(chiamateALeggi().at(-1)!.valori[0]))).toEqual({
      ambito_tipo: "progetto_ps", ambito_id: F.PROGETTO, operazione: "UPDATE", tabella: "public.ps_projects",
    });
  });

  it("i limiti: tabella sorvegliata, operazione nota, al più 100 righe, al più 92 giorni", async () => {
    const no = async (q: string) => expect((await request(admin()).get(`/api/admin/registro?${q}`)).status, q).toBe(400);
    await no("tabella=public.gtfs_stops");
    await no("tabella=public.ps_projects;drop");
    await no("operazione=MERGE");
    await no("limite=0");
    await no("limite=101");
    await no("da=2026-01-01");
    await no("da=2026-01-01T00:00:00Z&a=2026-06-01T00:00:00Z");
    await no("da=2026-06-01T00:00:00Z&a=2026-05-01T00:00:00Z");
    await no("cursore=non-un-cursore");
    expect(chiamateALeggi()).toEqual([]);
    const r = await request(admin()).get("/api/admin/registro?da=2026-10-01T00:00:00%2B02:00&a=2026-10-31T23:59:59%2B01:00&limite=100");
    expect(r.status).toBe(200);
    expect(chiamateALeggi().at(-1)!.valori.slice(1)).toEqual([101]);
  });

  it("le pagine: una riga in più dice se continuano; il cursore è l'ultima riga data", async () => {
    F.s.righe = Array.from({ length: 12 }, (_, i) => F.riga(i));
    const prima = await request(admin()).get("/api/admin/registro?limite=5");
    expect(prima.body.righe.map((r: any) => r.id)).toEqual(["1000", "999", "998", "997", "996"]);
    // la quinta riga: id 996, della transazione 899
    expect(leggiCursore(prima.body.successivo)).toEqual({ ts: "2026-11-09T10:00:00.123456Z", tx: "899", id: "996" });
    // la pagina dopo: il cursore va alla funzione, coi microsecondi
    F.s.righe = Array.from({ length: 3 }, (_, i) => F.riga(5 + i));
    const dopo = await request(admin()).get(`/api/admin/registro?limite=5&cursore=${prima.body.successivo}`);
    const l = chiamateALeggi().at(-1)!;
    expect(JSON.parse(String(l.valori[0]))).toEqual({ cursore_ts: "2026-11-09T10:00:00.123456Z", cursore_transazione: "899", cursore_id: "996" });
    expect(l.valori.slice(1)).toEqual([6]);
    // l'ultima pagina: meno righe del limite, nessun cursore
    expect(dopo.body.righe).toHaveLength(3);
    expect(dopo.body.successivo).toBeNull();
    expect(dopo.body).not.toHaveProperty("troppeInUnaTransazione");
  });

  it("un errore di dati del database (una data fuori scala) è una richiesta sbagliata, non un guasto", async () => {
    const vera = F.client.query;
    F.client.query = async (cfg: any, valori?: unknown[]) => {
      const testo = String(typeof cfg === "string" ? cfg : cfg.text).toLowerCase();
      if (testo.includes("from registro.leggi(")) throw Object.assign(new Error("date/time field value out of range"), { code: "22008" });
      return vera.call(F.client, cfg, valori);
    };
    try {
      const r = await request(admin()).get("/api/admin/registro?da=0000-01-01T00:00:00Z");
      expect(r.status).toBe(400);
    } finally { F.client.query = vera; }
  });

  it("il cursore si legge solo se è fatto come deve", () => {
    const buono = { ts: "2026-11-09T10:00:00.123456Z", tx: "901", id: "42" };
    expect(leggiCursore(codificaCursore(buono))).toEqual(buono);
    const falso = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    expect(leggiCursore(falso({ ...buono, ts: "2026-11-09 10:00:00+00" }))).toBeNull();
    expect(leggiCursore(falso({ ...buono, ts: "2026-11-09T10:00:00.123456Z'; DROP" }))).toBeNull();
    expect(leggiCursore(falso({ ...buono, tx: "1 OR 1=1" }))).toBeNull();
    expect(leggiCursore(falso({ ...buono, tx: "99999999999999999999" }))).toBeNull();
    expect(leggiCursore(falso({ ...buono, id: "-1" }))).toBeNull();
    expect(leggiCursore(falso({ ...buono, attore: "x" }))).toBeNull();
    expect(leggiCursore("non base64 né json")).toBeNull();
  });
});

describe("le attivazioni programmate (PR 2.11)", () => {
  it("il giro scrive col canale di chi ha programmato, se era Argos", () => {
    expect(viaDelGiro("argos")).toBe("argos:timer:attivazioni");
    expect(viaDelGiro("argos:mcp")).toBe("argos:mcp:timer:attivazioni");
    expect(viaDelGiro("api")).toBe("timer:attivazioni");
    expect(viaDelGiro(null)).toBe("timer:attivazioni");
    expect(viaDelGiro("argosfinto")).toBe("timer:attivazioni");
  });
});
