/* I diritti dei ruoli che l'amministratore cambia dall'app (PR 2.18,
 * lib/matrice-ruoli.ts e /api/admin/ruoli). Il database è finto: tiene le
 * righe di public.ruoli_diritti e gli utenti che gli si danno.
 * - la matrice in vigore è quella di partenza con sopra le righe della tabella;
 * - si rilegge ogni mezzo minuto, una lettura sola per tante richieste insieme;
 * - se non si è mai letta e il database non risponde, NON si ripiega sulla
 *   matrice di partenza: l'errore sale, e chi caricava un utente si ferma;
 * - la cambia solo l'amministratore, un ruolo per volta, con tutte le aree;
 * - si salvano solo le celle diverse da quelle di partenza.
 * Sul database vero lo prova ruoli-diritti-db.test.ts. */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";

const F = vi.hoisted(() => {
  const s = {
    righe: [] as Array<{ ruolo: string; area: string; livello: string }>,
    utenti: [] as any[],
    aggiornati: [] as Array<{ id: unknown; permissions: any; datiSanitari: unknown }>,
    chieste: [] as Array<{ testo: string; valori: unknown[] }>,
    errore: null as any,
    attesa: null as Promise<void> | null,
  };
  const client = {
    async query(cfg: any, valori?: unknown[]) {
      const testo: string = (typeof cfg === "string" ? cfg : cfg.text).replace(/\s+/g, " ").trim().toLowerCase();
      const v = (valori ?? cfg?.values ?? []) as unknown[];
      s.chieste.push({ testo, valori: v });
      let righe: any[] = [];
      if (testo.includes("select ruolo, area, livello from ruoli_diritti")) {
        if (s.attesa) await s.attesa;
        if (s.errore) throw s.errore;
        righe = s.righe.map(r => ({ ...r }));
      } else if (testo.startsWith("delete from ruoli_diritti")) {
        const tieni = String(v[1]).slice(1, -1).split(",").filter(Boolean);
        righe = s.righe.filter(r => r.ruolo === v[0] && !tieni.includes(r.area)).map(r => ({ area: r.area }));
        s.righe = s.righe.filter(r => !(r.ruolo === v[0] && !tieni.includes(r.area)));
      } else if (testo.startsWith("insert into ruoli_diritti")) {
        const [ruolo, area, livello] = v as string[];
        const c = s.righe.find(r => r.ruolo === ruolo && r.area === area);
        if (!c) { s.righe.push({ ruolo, area, livello }); righe = [{ area }]; }
        else if (c.livello !== livello) { c.livello = livello; righe = [{ area }]; }
      } else if (testo.includes("from users u, unnest")) {
        righe = [{ ruolo: "capo_deposito", n: 2 }];
      } else if (testo.includes("from users where role <> 'admin' and ruoli @>")) {
        righe = s.utenti.filter(u => u.ruoli.includes(v[0]));
      } else if (testo.startsWith("update users set permissions")) {
        s.aggiornati.push({ permissions: JSON.parse(String(v[0])), datiSanitari: v[1], id: v[2] });
      } else if (testo.includes("count(*)::int as n from users")) {
        righe = [{ n: 1 }];
      }
      return { rows: righe, rowCount: righe.length, fields: [] };
    },
  };
  return { s, client };
});

vi.mock("@workspace/db", async () => {
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const schema = await import("@workspace/db/schema");
  return { ...schema, db: drizzle(F.client as any, { schema }), pool: { query: vi.fn(async () => ({ rows: [] })), on: vi.fn() } };
});

import adminRouter from "../routes/admin";
import { AREE, MATRICE, RUOLI, rigaDelRuolo, type Diritti } from "@workspace/permessi";
import { dimenticaMatrice, matriceFresca } from "../lib/matrice-ruoli";
import { matriceInVigore } from "../lib/matrice-in-vigore";
import { dirittiEVista, profiloDaRiga } from "../lib/permessi";
import { utenteDaRiga } from "../lib/auth";
import { decidi } from "../lib/permessi-rotte";
import { appDiProva, utenteDiProva } from "./helpers/app-di-prova";

const admin = () => request(appDiProva(adminRouter, utenteDiProva("a0000000-0000-4000-8000-0000000000a1", [], "admin")));
const letture = () => F.s.chieste.filter(c => c.testo.includes("select ruolo, area, livello from ruoli_diritti"));
const scritture = () => F.s.chieste.filter(c => /^(insert into|delete from) ruoli_diritti/.test(c.testo));
const CAPO = rigaDelRuolo(MATRICE, "capo_deposito");
const riga = (id: string, ruoli: string[], extra: Record<string, unknown> = {}) =>
  ({ id, role: "user", ruoli, accesso_di_prima: {}, dati_sanitari: false, analisi: false, permissions: {}, ...extra });

beforeEach(() => {
  F.s.righe = []; F.s.utenti = []; F.s.aggiornati = []; F.s.chieste = []; F.s.errore = null; F.s.attesa = null;
  dimenticaMatrice();
});
afterEach(() => { vi.useRealTimers(); });

describe("la matrice in vigore", () => {
  it("è quella di partenza con sopra le righe della tabella, e i diritti di tutti si calcolano con quella", async () => {
    F.s.righe = [{ ruolo: "capo_deposito", area: "flotta", livello: "N" }, { ruolo: "capo_deposito", area: "tariffe", livello: "L" }];
    const m = await matriceFresca();
    expect(rigaDelRuolo(m, "capo_deposito")).toEqual({ ...CAPO, flotta: null, tariffe: "L" });
    expect(matriceInVigore()).toBe(m);
    const capo = { id: "u1", email: "capo@prova.local", role: "user", ruoli: ["capo_deposito"], active: true };
    expect(utenteDaRiga(capo).diritti).toMatchObject({ flotta: null, tariffe: "L", roster: "S" });
    // la vista che leggono FleetCare e la regola della verifica segue la matrice: senza Flotta non entra in FleetCare
    expect(dirittiEVista(profiloDaRiga(capo)).permissions).toMatchObject({ fleetcare: false, fares: true, roster: true });
    // l'amministratore di sistema non dipende dalla matrice
    expect(Object.values(utenteDaRiga({ ...capo, role: "admin" }).diritti).every(v => v === "S")).toBe(true);
  });

  it("si rilegge dopo mezzo minuto; tante richieste insieme fanno una lettura sola", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-13T10:00:00Z") });
    let sblocca!: () => void;
    F.s.attesa = new Promise<void>(r => { sblocca = r; });
    const tutte = Promise.all([matriceFresca(), matriceFresca(), matriceFresca()]);
    sblocca(); F.s.attesa = null;
    await tutte;
    expect(letture()).toHaveLength(1);
    await matriceFresca();
    expect(letture()).toHaveLength(1);
    vi.setSystemTime(new Date("2026-11-13T10:00:31Z"));
    F.s.righe = [{ ruolo: "officina", area: "esercizio", livello: "N" }];
    expect((await matriceFresca()).officina.esercizio).toBeUndefined();
    expect(letture()).toHaveLength(2);
  });

  it("mai letta e il database non risponde: l'errore sale, non vale la matrice di partenza", async () => {
    F.s.errore = new Error("connessione persa");
    await expect(matriceFresca()).rejects.toThrow();
    // e la prossima richiesta riprova, non resta bloccata sull'errore
    F.s.errore = null;
    F.s.righe = [{ ruolo: "capo_deposito", area: "flotta", livello: "N" }];
    expect((await matriceFresca()).capo_deposito.flotta).toBeUndefined();
  });

  it("già letta e il database non risponde: vale la lettura di prima, con quello che l'amministratore aveva tolto", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-13T10:00:00Z") });
    F.s.righe = [{ ruolo: "capo_deposito", area: "flotta", livello: "N" }];
    await matriceFresca();
    vi.setSystemTime(new Date("2026-11-13T10:05:00Z"));
    F.s.errore = new Error("connessione persa");
    const m = await matriceFresca();
    expect(m.capo_deposito.flotta).toBeUndefined();
    expect(m.capo_deposito.roster).toBe("S");
  });
});

describe("GET /api/admin/ruoli e PUT /api/admin/ruoli/:ruolo", () => {
  it("solo l'amministratore; per gli altri la voce è «Solo admin»", async () => {
    for (const utente of [null, utenteDiProva("ugo", ["network", "scheduling", "roster", "personale"]), utenteDiProva("pia", [], "user", { ruoli: ["amministrazione"] })]) {
      const app = request(appDiProva(adminRouter, utente));
      expect((await app.get("/api/admin/ruoli")).status).toBe(utente ? 403 : 401);
      expect((await app.put("/api/admin/ruoli/capo_deposito").send({ diritti: CAPO })).status).toBe(utente ? 403 : 401);
    }
    expect(F.s.chieste).toHaveLength(0);
    const pia = utenteDiProva("pia", [], "user", { ruoli: ["amministrazione"] });
    expect(decidi({ admin: false, diritti: pia.diritti }, "GET", "/admin/ruoli")).toEqual({ passa: false, errore: "Solo admin" });
    expect(decidi({ admin: false, diritti: pia.diritti }, "PUT", "/admin/ruoli/amministrazione")).toEqual({ passa: false, errore: "Solo admin" });
  });

  it("la lettura dà ogni ruolo coi diritti in vigore, quelli di partenza e quanti utenti lo hanno", async () => {
    F.s.righe = [{ ruolo: "capo_deposito", area: "flotta", livello: "N" }];
    const r = await admin().get("/api/admin/ruoli");
    expect(r.status).toBe(200);
    expect(r.body.ruoli.map((x: any) => x.codice)).toEqual([...RUOLI]);
    const capo = r.body.ruoli.find((x: any) => x.codice === "capo_deposito");
    expect(capo).toMatchObject({ utenti: 2, diritti: { ...CAPO, flotta: null }, diPartenza: CAPO });
    expect(r.body.ruoli.find((x: any) => x.codice === "officina")).toMatchObject({ utenti: 0, diritti: rigaDelRuolo(MATRICE, "officina") });
  });

  it("il salvataggio scrive solo le celle diverse da quelle di partenza, con chi le ha cambiate", async () => {
    const voluti: Diritti = { ...CAPO, esercizio: null, flotta: null, tariffe: "L" };
    const r = await admin().put("/api/admin/ruoli/capo_deposito").send({ diritti: voluti });
    expect(r.status).toBe(200);
    expect(F.s.righe).toEqual(expect.arrayContaining([
      { ruolo: "capo_deposito", area: "esercizio", livello: "N" },
      { ruolo: "capo_deposito", area: "flotta", livello: "N" },
      { ruolo: "capo_deposito", area: "tariffe", livello: "L" },
    ]));
    expect(F.s.righe).toHaveLength(3);
    const inserimenti = F.s.chieste.filter(c => c.testo.startsWith("insert into ruoli_diritti"));
    expect(inserimenti.every(c => c.valori[3] === "a0000000-0000-4000-8000-0000000000a1")).toBe(true);
    expect(r.body.esito).toMatchObject({ celle: 3 });
    expect(r.body.ruoli.find((x: any) => x.codice === "capo_deposito").diritti).toEqual(voluti);
    // vale subito per chi viene caricato dopo, senza aspettare il mezzo minuto
    expect(rigaDelRuolo(matriceInVigore(), "capo_deposito")).toEqual(voluti);
    // tutto in una transazione, una modifica ai ruoli per volta
    const testi = F.s.chieste.map(c => c.testo);
    expect(testi.indexOf("begin")).toBeLessThan(testi.findIndex(t => t.includes("pg_advisory_xact_lock")));
    expect(testi.findIndex(t => t.includes("pg_advisory_xact_lock"))).toBeLessThan(testi.findIndex(t => t.startsWith("delete from ruoli_diritti")));
    expect(testi.lastIndexOf("commit")).toBeGreaterThan(testi.findIndex(t => t.includes("for update")));
  });

  it("riportare una cella al valore di partenza toglie la riga; salvare due volte lo stesso non riscrive niente", async () => {
    await admin().put("/api/admin/ruoli/capo_deposito").send({ diritti: { ...CAPO, flotta: null, tariffe: "L" } });
    F.s.chieste = [];
    const stesso = await admin().put("/api/admin/ruoli/capo_deposito").send({ diritti: { ...CAPO, flotta: null, tariffe: "L" } });
    expect(stesso.body.esito.celle).toBe(0);
    const indietro = await admin().put("/api/admin/ruoli/capo_deposito").send({ diritti: { ...CAPO, tariffe: "L" } });
    expect(indietro.body.esito.celle).toBe(1);
    expect(F.s.righe).toEqual([{ ruolo: "capo_deposito", area: "tariffe", livello: "L" }]);
    await admin().put("/api/admin/ruoli/capo_deposito").send({ diritti: CAPO });
    expect(F.s.righe).toEqual([]);
  });

  it("chi ha il ruolo viene riallineato nella stessa transazione: la vista dei permessi e i dati sanitari", async () => {
    const vistaDiPrima = dirittiEVista(profiloDaRiga({ role: "user", ruoli: ["capo_deposito"] })).permissions;
    F.s.utenti = [
      riga("u-capo", ["capo_deposito"], { dati_sanitari: true, permissions: vistaDiPrima }),
      riga("u-due-ruoli", ["capo_deposito", "ufficio_turni"], { dati_sanitari: true, permissions: {} }),
      riga("u-officina", ["officina"], { permissions: {} }),
    ];
    const r = await admin().put("/api/admin/ruoli/capo_deposito").send({ diritti: { ...CAPO, roster: null, flotta: null } });
    expect(r.status).toBe(200);
    const per = (id: string) => F.s.aggiornati.find(a => a.id === id);
    // senza roster e senza flotta: fuori da FleetCare, e i dati sanitari si spengono
    expect(per("u-capo")).toMatchObject({ permissions: { roster: false, fleetcare: false, network: true }, datiSanitari: false });
    // chi ha anche l'Ufficio turni il roster lo legge ancora: i dati sanitari restano
    expect(per("u-due-ruoli")).toMatchObject({ permissions: { roster: true, fleetcare: false }, datiSanitari: true });
    // chi non ha il ruolo non si tocca
    expect(per("u-officina")).toBeUndefined();
    expect(r.body.esito).toMatchObject({ celle: 2, utentiAggiornati: 2, datiSanitariSpenti: 1, daVerificare: 1 });
  });

  it("un ruolo che non c'è, un'area in più o in meno, un livello diverso: niente arriva al database", async () => {
    const no = async (percorso: string, corpo: unknown, stato: number, cosa: RegExp) => {
      const r = await admin().put(percorso).send(corpo as any);
      expect(r.status, `${percorso} ${JSON.stringify(corpo)}`).toBe(stato);
      expect(r.body.error).toMatch(cosa);
    };
    await no("/api/admin/ruoli/direttore", { diritti: CAPO }, 404, /Ruolo sconosciuto/);
    await no("/api/admin/ruoli/admin", { diritti: CAPO }, 404, /Ruolo sconosciuto/);
    await no("/api/admin/ruoli/__proto__", { diritti: CAPO }, 404, /Ruolo sconosciuto/);
    const { roster: _tolta, ...senzaRoster } = CAPO;
    await no("/api/admin/ruoli/capo_deposito", { diritti: senzaRoster }, 400, /Manca l'area «Roster»/);
    await no("/api/admin/ruoli/capo_deposito", { diritti: { ...CAPO, magazzino: "S" } }, 400, /Area sconosciuta: magazzino/);
    await no("/api/admin/ruoli/capo_deposito", { diritti: { ...CAPO, roster: "X" } }, 400, /«Roster»/);
    await no("/api/admin/ruoli/capo_deposito", { diritti: { ...CAPO, roster: "N" } }, 400, /«Roster»/);
    await no("/api/admin/ruoli/capo_deposito", { diritti: CAPO, admin: true }, 400, /Campo non previsto: admin/);
    await no("/api/admin/ruoli/capo_deposito", {}, 400, /area per area/);
    await no("/api/admin/ruoli/capo_deposito", [CAPO], 400, /non valida/);
    expect(scritture()).toHaveLength(0);
    expect(AREE.every(a => a in CAPO)).toBe(true);
  });
});
