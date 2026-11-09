/* Chi fa la modifica, su ogni connessione (PR 2.9): il pool porta sul client
 * il contesto di chi lo chiede (lib/db/src/contesto.ts).
 *
 * Con un client finto (l'opzione Client di pg-pool): si imposta solo quando
 * cambia, nelle due forme di connect, con pool.query e con db.transaction di
 * drizzle; un errore scarta il client; un prestito in coda prende il contesto
 * di chi aspettava, non di chi ha rilasciato; 100 esecuzioni concorrenti su 2
 * client. Poi lo stesso sul database vero (TEST_DATABASE_URL: in CI come
 * cerbero_app, che non è superutente). */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { EventEmitter } from "node:events";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { contestoDb, conContesto, inSistema, IMPOSTAZIONI, PoolConContesto, pool, db } from "@workspace/db";

const LEGGI = "SELECT current_setting('cerbero.attore', true) AS a, current_setting('cerbero.via', true) AS v, "
  + "current_setting('cerbero.richiesta', true) AS r";
const pausa = (ms: number) => new Promise((f) => setTimeout(f, ms));

class ClientFinto extends EventEmitter {
  static tutti: ClientFinto[] = [];
  static fallisci = 0;
  /** il socket cade durante l'impostazione: 'error' sul client, poi la query fallisce */
  static cade = 0;
  impostazioni: Record<string, string> = {};
  imposte = 0;
  _queryable = true;
  _ending = false;
  constructor() {
    super();
    ClientFinto.tutti.push(this);
  }
  connect(cb?: (err?: Error) => void) {
    setImmediate(() => cb?.());
    return cb ? undefined : Promise.resolve();
  }
  query(cfg: string | { text: string; values?: unknown[] }, valori?: unknown, cb?: (e?: Error, r?: unknown) => void) {
    if (typeof valori === "function") {
      cb = valori as typeof cb;
      valori = undefined;
    }
    const testo = typeof cfg === "string" ? cfg : cfg.text;
    const vals = (valori ?? (typeof cfg === "object" ? cfg.values : undefined) ?? []) as string[];
    const p = new Promise((ok, ko) => setTimeout(() => {
      if (testo.includes("set_config")) {
        if (ClientFinto.cade > 0) {
          ClientFinto.cade--;
          this.emit("error", new Error("read ECONNRESET"));
          ko(new Error("Connection terminated unexpectedly"));
          return;
        }
        if (ClientFinto.fallisci > 0) {
          ClientFinto.fallisci--;
          ko(new Error("impostazione fallita"));
          return;
        }
        this.imposte++;
        IMPOSTAZIONI.forEach((n, i) => { this.impostazioni[n] = vals[i]!; });
        ok({ rows: [{}], rowCount: 1, fields: [] });
        return;
      }
      if (testo.includes("current_setting")) {
        const i = this.impostazioni;
        ok({ rows: [{ a: i["cerbero.attore"] ?? null, v: i["cerbero.via"] ?? null, r: i["cerbero.richiesta"] ?? null }], rowCount: 1, fields: [] });
        return;
      }
      ok({ rows: [], rowCount: 0, fields: [] });
    }, Math.random() * 3));
    if (cb) {
      p.then((r) => cb!(undefined, r), (e) => cb!(e));
      return undefined;
    }
    return p;
  }
  end(cb?: () => void) {
    this._ending = true;
    this.emit("end");
    cb?.();
    return Promise.resolve();
  }
}

const nuovoPool = (max: number) => new PoolConContesto({ Client: ClientFinto as never, max });
const imposte = () => ClientFinto.tutti.reduce((n, c) => n + c.imposte, 0);

describe("il contesto sulla connessione, con un client finto", () => {
  beforeEach(() => {
    ClientFinto.tutti = [];
    ClientFinto.fallisci = 0;
    ClientFinto.cade = 0;
  });

  it("si imposta solo quando cambia; senza contesto si azzera, ma un client nuovo non fa niente", async () => {
    const p = nuovoPool(1);
    await p.query(LEGGI);
    expect(imposte()).toBe(0);
    await contestoDb.run({ attore: "u1", via: "api", richiesta: "r1" }, async () => {
      const { rows: [r] } = await p.query(LEGGI);
      expect(r).toEqual({ a: "u1", v: "api", r: "r1" });
      await p.query(LEGGI);
      await p.query(LEGGI);
    });
    expect(imposte()).toBe(1);
    await contestoDb.run({ attore: "u2", via: "api", richiesta: "r2" }, () => p.query(LEGGI));
    expect(imposte()).toBe(2);
    const { rows: [vuoto] } = await p.query(LEGGI);
    expect(vuoto).toEqual({ a: "", v: "", r: "" });
    await p.query(LEGGI);
    expect(imposte()).toBe(3);
    await p.end();
  });

  it("forma callback, forma promise e le transazioni di drizzle", async () => {
    const p = nuovoPool(2);
    const d = drizzle(p);
    await contestoDb.run({ attore: "cb", via: "api" }, () => new Promise<void>((fine, errore) => {
      p.connect((err, client, done) => {
        if (err || !client) return errore(err);
        expect((client as unknown as ClientFinto).impostazioni["cerbero.attore"]).toBe("cb");
        done();
        fine();
      });
    }));
    await contestoDb.run({ attore: "pr", via: "argos:mcp" }, async () => {
      const c = await p.connect();
      expect((c as unknown as ClientFinto).impostazioni["cerbero.via"]).toBe("argos:mcp");
      c.release();
    });
    const t = await contestoDb.run({ attore: "tx", via: "api" }, () =>
      d.transaction(async (tx) => (await tx.execute(sql.raw(LEGGI))).rows[0]));
    expect(t).toMatchObject({ a: "tx", v: "api" });
    await p.end();
  });

  it("se l'impostazione fallisce il client si scarta e l'errore arriva a chi aveva chiesto", async () => {
    const p = nuovoPool(1);
    ClientFinto.fallisci = 1;
    await expect(contestoDb.run({ attore: "u1" }, () => p.query(LEGGI))).rejects.toThrow("impostazione fallita");
    expect(ClientFinto.tutti[0]!._ending).toBe(true);
    ClientFinto.fallisci = 1;
    await expect(contestoDb.run({ attore: "u1" }, () => p.connect())).rejects.toThrow("impostazione fallita");
    // il client dopo è nuovo e ha il contesto giusto
    const { rows: [r] } = await contestoDb.run({ attore: "u1" }, () => p.query(LEGGI));
    expect(r.a).toBe("u1");
    expect(ClientFinto.tutti).toHaveLength(3);
    await p.end();
  });

  it("la connessione che cade durante l'impostazione non fa uscire il processo: fallisce la query", async () => {
    const p = nuovoPool(1);
    ClientFinto.cade = 1;
    await expect(contestoDb.run({ attore: "u1" }, () => p.query(LEGGI))).rejects.toThrow("Connection terminated");
    ClientFinto.cade = 1;
    await expect(contestoDb.run({ attore: "u2" }, () => p.connect())).rejects.toThrow("Connection terminated");
    const { rows: [r] } = await contestoDb.run({ attore: "u3" }, () => p.query(LEGGI));
    expect(r.a).toBe("u3");
    await p.end();
  });

  it("un prestito in coda prende il contesto di chi aspettava, non di chi ha rilasciato", async () => {
    const p = nuovoPool(1);
    const tenuto = await contestoDb.run({ attore: "a" }, () => p.connect());
    const inAttesa = contestoDb.run({ attore: "b" }, () => p.query(LEGGI));
    await pausa(10);
    // il rilascio avviene nel contesto di «a»: la callback in coda gira lì
    contestoDb.run({ attore: "a" }, () => tenuto.release());
    const { rows: [r] } = await inAttesa;
    expect(r.a).toBe("b");
    await p.end();
  });

  it("100 esecuzioni concorrenti su 2 client: ognuna vede il suo contesto", async () => {
    const p = nuovoPool(2);
    const d = drizzle(p);
    const sbagli: string[] = [];
    await Promise.all(Array.from({ length: 100 }, (_, i) => contestoDb.run({ attore: `u${i}`, via: i % 2 ? "api" : "coda:python" }, async () => {
      const { rows: [r] } = await p.query(LEGGI);
      if (r.a !== `u${i}`) sbagli.push(`query ${i}: ${r.a}`);
      await pausa(Math.random() * 3);
      const t = (await d.transaction(async (tx) => (await tx.execute(sql.raw(LEGGI))).rows[0])) as { a: string; v: string };
      if (t.a !== `u${i}` || t.v !== (i % 2 ? "api" : "coda:python")) sbagli.push(`tx ${i}: ${t.a}/${t.v}`);
    })));
    expect(sbagli).toEqual([]);
    expect(ClientFinto.tutti.length).toBeLessThanOrEqual(2);
    await p.end();
  });

  it("conContesto aggiunge al contesto, inSistema ricomincia da capo", () => {
    contestoDb.run({ attore: "u1", via: "api", richiesta: "r1" }, () => {
      conContesto({ registro: "riepilogo" }, () => {
        expect(contestoDb.getStore()).toEqual({ attore: "u1", via: "api", richiesta: "r1", registro: "riepilogo" });
      });
      inSistema("coda", () => expect(contestoDb.getStore()).toEqual({ via: "coda" }));
    });
  });

  it("valori lunghi si troncano, il byte nullo si toglie, tutto passa come parametro", async () => {
    const p = nuovoPool(1);
    const { rows: [r] } = await contestoDb.run({ attore: "x'); DROP TABLE t; --\0", richiesta: "r".repeat(500) }, () => p.query(LEGGI));
    expect(r.a).toBe("x'); DROP TABLE t; --");
    expect(r.r).toHaveLength(200);
    await p.end();
  });
});

describe.runIf(!!process.env.TEST_DATABASE_URL)("il contesto sulla connessione, sul database", () => {
  afterAll(async () => { await pool.end(); });

  it("100 richieste concorrenti con pool.query e db.transaction: ognuna vede il suo, anche da non superutente", async () => {
    const sbagli: string[] = [];
    await Promise.all(Array.from({ length: 100 }, (_, i) => contestoDb.run({ attore: `u${i}`, via: i % 3 ? "api" : "argos:mcp", richiesta: `r${i}` }, async () => {
      const { rows: [r] } = await pool.query(LEGGI);
      if (r.a !== `u${i}` || r.r !== `r${i}`) sbagli.push(`query ${i}: ${r.a}/${r.r}`);
      await pausa(Math.random() * 5);
      const t = (await db.transaction(async (tx) => (await tx.execute(sql.raw(LEGGI))).rows[0])) as { a: string; v: string };
      if (t.a !== `u${i}` || t.v !== (i % 3 ? "api" : "argos:mcp")) sbagli.push(`tx ${i}: ${t.a}/${t.v}`);
    })));
    expect(sbagli).toEqual([]);
    // senza contesto: azzerato
    const { rows: [vuoto] } = await pool.query(LEGGI);
    expect(vuoto).toEqual({ a: "", v: "", r: "" });
    const { rows: [nome] } = await pool.query("SELECT current_setting('application_name') AS n");
    expect(nome.n).toBe(process.env.PGAPPNAME || "cerbero");
  });
});
