/**
 * Il pagamento con carta a bordo (tappa 6.38, migrazione 0058), su un
 * database vero (TEST_DATABASE_URL; in CI come cerbero_app).
 *
 * L'amministratore salva tutto insieme: le tariffe per tipo di rete, il
 * massimale unico, il supporto e le reti dove vale. Quello che non torna non
 * si salva e il database resta com'era. Una rete tolta dall'azienda esce
 * dalla carta; un supporto tolto lascia la carta senza supporto.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db, pool } from "@workspace/db";
import { sql } from "drizzle-orm";
import adminRouter from "../routes/admin";
import { contactlessDalDatabase } from "../lib/contactless-store";
import { decidi } from "../lib/permessi-rotte";
import { appDiProva, utenteDiProva } from "./helpers/app-di-prova";

const ADMIN = utenteDiProva("e6380000-0000-4000-8000-000000000001", [], "admin");
const admin = request(appDiProva(adminRouter, ADMIN));
const TARIFFISTA = utenteDiProva("e6380000-0000-4000-8000-000000000002", ["fares"]);
const utente = request(appDiProva(adminRouter, TARIFFISTA));

const RETE = "urbano_prova638";
const SUPPORTO = "carta_prova638";
const URBANO = { tipo: "urbano", primo: 2, secondo: 2, terzo: 1, validitaMinuti: 60, massimale: 5 };
const EXTRA = { tipo: "extraurbano", primo: 4, secondo: 4, terzo: 2, validitaMinuti: 60, massimale: 10 };
const CORPO = { massimaleUnico: 10, finestraOre: 24, supporto: SUPPORTO, tariffe: [EXTRA, URBANO], reti: [RETE, "extraurbano"] };
const TABELLE = ["contactless_reti", "contactless_tariffe", "contactless"] as const;

describe.runIf(!!process.env.TEST_DATABASE_URL)("il pagamento con carta a bordo, sul database", () => {
  const prima: Record<string, unknown[]> = {};
  let extraurbanoMesso = false;

  beforeAll(async () => {
    for (const t of TABELLE) prima[t] = (await db.execute<any>(sql`SELECT to_jsonb(x) AS riga FROM ${sql.identifier(t)} x`)).rows.map((r) => r.riga);
    /* si parte come un'installazione nuova: nessuna regola */
    for (const t of TABELLE) await db.execute(sql`DELETE FROM ${sql.identifier(t)}`);
    await db.execute(sql`DELETE FROM reti WHERE rete = ${RETE}`);
    await db.execute(sql`DELETE FROM supporti_catalogo WHERE supporto = ${SUPPORTO}`);
    await db.execute(sql`INSERT INTO reti (rete, tipo, nome, luogo, sigla, zona, codice, colore, ordine)
      VALUES (${RETE}, 'urbano', 'Urbano di Prova', 'Prova', 'PR', 'prova638_urban', 9, '#123456', 90)`);
    extraurbanoMesso = ((await db.execute<any>(sql`
      INSERT INTO reti (rete, tipo, nome, colore, ordine) VALUES ('extraurbano', 'extraurbano', 'Extraurbano', '#f59e0b', 1)
      ON CONFLICT (rete) DO NOTHING RETURNING rete`)).rows.length) > 0;
    await db.execute(sql`INSERT INTO supporti_catalogo (supporto, nome, tipo, ordine) VALUES (${SUPPORTO}, 'Carta bancaria di prova', 3, 90)`);
  });

  afterAll(async () => {
    for (const t of TABELLE) await db.execute(sql`DELETE FROM ${sql.identifier(t)}`);
    await db.execute(sql`DELETE FROM reti WHERE rete = ${RETE}`);
    if (extraurbanoMesso) await db.execute(sql`DELETE FROM reti WHERE rete = 'extraurbano'`);
    await db.execute(sql`DELETE FROM supporti_catalogo WHERE supporto = ${SUPPORTO}`);
    for (const t of [...TABELLE].reverse()) {
      for (const riga of prima[t] ?? []) {
        await db.execute(sql`INSERT INTO ${sql.identifier(t)} SELECT * FROM jsonb_populate_record(NULL::${sql.identifier(t)}, ${JSON.stringify(riga)}::jsonb)`);
      }
    }
    await pool.end();
  });

  it("solo l'amministratore la legge e la cambia, nemmeno chi lavora alle tariffe", async () => {
    expect((await utente.get("/api/admin/contactless")).status).toBe(403);
    expect((await utente.put("/api/admin/contactless").send(CORPO)).status).toBe(403);
    expect(decidi({ admin: false, diritti: TARIFFISTA.diritti }, "PUT", "/admin/contactless").passa).toBe(false);
    expect((await db.execute<any>(sql`SELECT count(*)::int AS n FROM contactless_tariffe`)).rows[0].n).toBe(0);
  });

  it("un'installazione nuova non ha la carta; la pagina ha le reti e i supporti fra cui scegliere", async () => {
    const r = await admin.get("/api/admin/contactless");
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.contactless).toEqual({ massimaleUnico: null, finestraOre: 24, supporto: null, tariffe: [], reti: [] });
    expect(r.body.retiDisponibili).toEqual(expect.arrayContaining([{ rete: RETE, nome: "Urbano di Prova", tipo: "urbano" }, expect.objectContaining({ rete: "extraurbano", tipo: "extraurbano" })]));
    expect(r.body.supportiDisponibili).toEqual(expect.arrayContaining([{ supporto: SUPPORTO, nome: "Carta bancaria di prova", tipo: 3 }]));
    expect(r.body.limiti).toEqual({ prezzo: 999.99, validitaMinuti: 1440, finestraOre: 72, reti: 200 });
  });

  it("si salva tutto insieme e torna uguale; un salvataggio uguale non riscrive niente", async () => {
    const r = await admin.put("/api/admin/contactless").send(CORPO);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const atteso = { massimaleUnico: 10, finestraOre: 24, supporto: SUPPORTO, tariffe: [URBANO, EXTRA], reti: ["extraurbano", RETE] };
    expect(r.body.contactless).toEqual(atteso);
    expect((await admin.get("/api/admin/contactless")).body.contactless).toEqual(atteso);
    expect(await contactlessDalDatabase()).toEqual(atteso);
    const quando = async () => (await db.execute<any>(sql`SELECT aggiornato_il::text AS t FROM contactless`)).rows[0].t;
    const t1 = await quando();
    expect((await admin.put("/api/admin/contactless").send(CORPO)).status).toBe(200);
    expect(await quando()).toBe(t1);
    /* cambia il terzo viaggio urbano: solo quella riga */
    const r2 = await admin.put("/api/admin/contactless").send({ ...CORPO, tariffe: [EXTRA, { ...URBANO, terzo: 1.5 }] });
    expect(r2.status).toBe(200);
    expect((await db.execute<any>(sql`SELECT terzo::float8 AS terzo FROM contactless_tariffe WHERE tipo = 'urbano'`)).rows[0].terzo).toBe(1.5);
    expect(await quando()).toBe(t1);
  });

  it("quello che non torna non si salva, e il database resta com'era", async () => {
    const primaDi = (await admin.get("/api/admin/contactless")).body.contactless;
    const prova = async (corpo: object) => { const r = await admin.put("/api/admin/contactless").send(corpo); return [r.status, r.body.error]; };
    expect(await prova({ ...CORPO, tariffe: [EXTRA] })).toEqual([400, "La carta è attiva su «Urbano di Prova», ma manca la tariffa urbana"]);
    expect(await prova({ ...CORPO, reti: ["urbano_sparito"] })).toEqual([400, "La rete «urbano_sparito» non c'è più: ricarica la pagina"]);
    expect(await prova({ ...CORPO, supporto: "tessera_sparita" })).toEqual([400, "Il supporto «tessera_sparita» non c'è più: ricarica la pagina"]);
    expect((await prova({ ...CORPO, massimaleUnico: 6 }))[1]).toMatch(/^Il massimale unico \(6,00 €\) è più basso/);
    expect((await prova({ ...CORPO, tariffe: [{ ...URBANO, primo: -1 }] }))[1]).toMatch(/^Dati non validi: tariffa n\. 1: primo viaggio: maggiore di zero/);
    expect(await prova({ ...CORPO, chi: "io" })).toEqual([400, "Campo non previsto: chi"]);
    expect((await prova({}))[0]).toBe(400);
    expect((await admin.get("/api/admin/contactless")).body.contactless).toEqual(primaDi);
  });

  it("una rete tolta dall'azienda esce dalla carta; un supporto tolto la lascia senza supporto; senza reti la carta è spenta", async () => {
    await db.execute(sql`DELETE FROM supporti_catalogo WHERE supporto = ${SUPPORTO}`);
    expect((await contactlessDalDatabase()).supporto).toBeNull();
    await db.execute(sql`DELETE FROM reti WHERE rete = ${RETE}`);
    expect((await contactlessDalDatabase()).reti).toEqual(["extraurbano"]);
    const r = await admin.put("/api/admin/contactless").send({ massimaleUnico: null, finestraOre: 24, supporto: null, tariffe: [], reti: [] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await contactlessDalDatabase()).toEqual({ massimaleUnico: null, finestraOre: 24, supporto: null, tariffe: [], reti: [] });
  });
});
