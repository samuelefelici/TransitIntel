/**
 * I depositi dell'azienda (tappa 6.4, migrazione 0038), su un database vero
 * (TEST_DATABASE_URL; in CI come cerbero_app).
 *
 * L'API non inserisce più depositi da sé; li crea, li cambia e li toglie
 * l'amministratore. Un nome cambiato non lascia nessun conducente senza
 * deposito, e un deposito in uso non si toglie.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { Router } from "express";
import { db, pool } from "@workspace/db";
import { sql } from "drizzle-orm";
import adminRouter from "../routes/admin";
import anagraficaRouter from "../routes/anagrafica";
import { creaConducentiDiProva, DEPOSITI_DI_PROVA } from "../lib/anagrafica-prova";
import { oggiRoma, type Ex } from "../lib/anagrafica-store";
import { appDiProva, utenteDiProva } from "./helpers/app-di-prova";

const u = (n: number) => `e6400000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [ADMIN, PERSONA, UTENTE, CON_STORICO, SENZA_STORICO, PROGRAMMATO] = Array.from({ length: 6 }, (_, i) => u(i + 1));

const router = Router();
router.use(anagraficaRouter);
router.use(adminRouter);
const admin = request(appDiProva(router, utenteDiProva(ADMIN, [], "admin")));
const persona = request(appDiProva(router, utenteDiProva(PERSONA, ["roster"], "user", { ruoli: ["capo_deposito"] })));

const righe = async (q: ReturnType<typeof sql>) => (await db.execute<any>(q)).rows;
const codici = async () => (await righe(sql`SELECT codice FROM roster_depositi ORDER BY codice`)).map((r) => r.codice as string);
const elenco = async () => (await admin.get("/api/admin/depositi")).body.depositi as Array<Record<string, any>>;
const uno = async (codice: string) => (await elenco()).find((d) => d.codice === codice)!;
const residenza = async (id: string) => (await righe(sql`SELECT residenza_servizio AS r FROM roster_drivers WHERE id = ${id}::uuid`))[0]?.r ?? null;

describe.runIf(!!process.env.TEST_DATABASE_URL)("i depositi dell'azienda, sul database", () => {
  const pulisci = async () => {
    await db.execute(sql`DELETE FROM roster_driver_history WHERE driver_id IN (${CON_STORICO}::uuid, ${SENZA_STORICO}::uuid, ${PROGRAMMATO}::uuid)`);
    await db.execute(sql`DELETE FROM roster_drivers WHERE id IN (${CON_STORICO}::uuid, ${SENZA_STORICO}::uuid, ${PROGRAMMATO}::uuid)`);
    await db.execute(sql`DELETE FROM users WHERE id = ${UTENTE}::uuid`);
    await db.execute(sql`DELETE FROM roster_depositi WHERE codice LIKE 'prova64%'`);
  };
  beforeAll(pulisci);
  afterAll(async () => { await pulisci(); await pool.end(); });

  it("l'API non inserisce depositi da sé: quelli che ci sono restano quelli", async () => {
    /* via i depositi che nessuno usa: su un database nuovo il catalogo resta vuoto */
    await db.execute(sql`
      DELETE FROM roster_depositi d
       WHERE NOT EXISTS (SELECT 1 FROM roster_gruppi_turni g WHERE g.deposito_codice = d.codice)`);
    const prima = await codici();
    /* la prima richiesta prepara l'anagrafica: prima inseriva i sette depositi di Conerobus */
    const r = await admin.get("/api/roster/depositi");
    expect(r.status).toBe(200);
    expect(await codici()).toEqual(prima);
    expect(r.body.depositi.map((d: any) => d.codice).sort()).toEqual(prima);
  });

  it("solo l'amministratore", async () => {
    expect((await persona.get("/api/admin/depositi")).status).toBe(403);
    expect((await persona.post("/api/admin/depositi").send({ nome: "Prova64 Nord", gruppo: "A" })).status).toBe(403);
    expect((await persona.put("/api/admin/depositi/prova64-nord").send({ nome: "x" })).status).toBe(403);
    expect((await persona.delete("/api/admin/depositi/prova64-nord")).status).toBe(403);
    expect(await codici()).not.toContain("prova64-nord");
  });

  it("crea: il codice dal nome, l'ordine in fondo, i valori di partenza", async () => {
    const fondo = Math.max(0, ...(await elenco()).map((d) => d.ordine));
    const r = await admin.post("/api/admin/depositi").send({ nome: " Prova64 Nord ", gruppo: "B", alias: ["Prova64 Borgo", "prova64 borgo"] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.deposito).toEqual({
      codice: "prova64-nord", nome: "Prova64 Nord", gruppo: "B", cadenzaTurni: "semimensile", alias: ["Prova64 Borgo"], ordine: fondo + 1,
    });
    expect(await uno("prova64-nord")).toMatchObject({ nome: "Prova64 Nord", conducenti: 0, cambiProgrammati: 0, gruppiTurni: 0, utenti: 0 });
    // e chi sceglie il deposito di un conducente lo trova
    expect((await admin.get("/api/roster/depositi")).body.depositi.map((d: any) => d.codice)).toContain("prova64-nord");
    // col codice scritto a mano
    const s = await admin.post("/api/admin/depositi").send({ codice: "prova64-sud", nome: "Prova64 Meridione", gruppo: "A", cadenzaTurni: "settimanale" });
    expect(s.status, JSON.stringify(s.body)).toBe(201);
    expect(s.body.deposito).toMatchObject({ codice: "prova64-sud", cadenzaTurni: "settimanale" });
  });

  it("rifiuta: valori non ammessi, codice già preso, un nome già di un altro deposito", async () => {
    for (const corpo of [{ nome: "Prova64 X", gruppo: "C" }, { nome: "", gruppo: "A" }, { nome: "Prova64 X", gruppo: "A", codice: "Prova64 X" },
      { nome: "Prova64 X", gruppo: "A", colore: "#fff" }, { nome: "—", gruppo: "A" }, { nome: "Prova64 X", gruppo: "A", alias: [""] }]) {
      expect((await admin.post("/api/admin/depositi").send(corpo)).status, JSON.stringify(corpo)).toBe(400);
    }
    const preso = await admin.post("/api/admin/depositi").send({ codice: "prova64-nord", nome: "Prova64 Altro", gruppo: "A" });
    expect(preso.status).toBe(409);
    expect(preso.body.error).toMatch(/codice/);
    // «Prova64 Borgo» è un altro nome del Nord
    const doppio = await admin.post("/api/admin/depositi").send({ nome: "prova64 BORGO", gruppo: "A" });
    expect(doppio.status).toBe(409);
    expect(doppio.body.error).toMatch(/Prova64 Nord/);
    const alias = await admin.put("/api/admin/depositi/prova64-sud").send({ alias: ["Prova64 Nord"] });
    expect(alias.status).toBe(409);
    expect((await admin.put("/api/admin/depositi/prova64-manca").send({ nome: "x" })).status).toBe(404);
    expect((await admin.put("/api/admin/depositi/Non%20Valido").send({ nome: "x" })).status).toBe(404);
  });

  it("un nome cambiato: resta fra gli altri nomi, e i conducenti prendono quello nuovo", async () => {
    const ieri = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const fraUnMese = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    await db.execute(sql`
      INSERT INTO roster_drivers (id, name, is_fictitious, is_active, residenza_servizio, versione, updated_at) VALUES
        (${CON_STORICO}::uuid, 'Prova64 Con Storico', true, true, 'Prova64 Nord', 0, now()),
        (${SENZA_STORICO}::uuid, 'Prova64 Senza Storico', true, true, 'prova64 borgo', 0, now()),
        (${PROGRAMMATO}::uuid, 'Prova64 Programmato', true, true, NULL, 0, now())`);
    await db.execute(sql`
      INSERT INTO roster_driver_history (driver_id, kind, value, event_date) VALUES
        (${CON_STORICO}::uuid, 'deposito', 'Prova64 Nord', ${ieri}::date),
        (${PROGRAMMATO}::uuid, 'deposito', 'Prova64 Nord', ${fraUnMese}::date)`);
    expect(await uno("prova64-nord")).toMatchObject({ conducenti: 2, cambiProgrammati: 1 });

    const r = await admin.put("/api/admin/depositi/prova64-nord").send({ nome: "Prova64 Settentrione" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.deposito).toMatchObject({ codice: "prova64-nord", nome: "Prova64 Settentrione", alias: ["Prova64 Borgo", "Prova64 Nord"] });
    // chi ha lo storico prende subito il nome nuovo; chi non lo ha tiene il suo, che si ritrova lo stesso
    expect(await residenza(CON_STORICO)).toBe("Prova64 Settentrione");
    expect(await residenza(SENZA_STORICO)).toBe("prova64 borgo");
    expect(await uno("prova64-nord")).toMatchObject({ conducenti: 2, cambiProgrammati: 1 });
  });

  it("un altro nome che qualcuno usa non si toglie: il conducente resterebbe senza deposito", async () => {
    const via = await admin.put("/api/admin/depositi/prova64-nord").send({ alias: ["Prova64 Nord"] });
    expect(via.status).toBe(409);
    expect(via.body.error).toMatch(/prova64 borgo/);
    expect(via.body.error).toMatch(/non si ritrova più/);
    // il cambio programmato usa «Prova64 Nord»: nemmeno quello
    const via2 = await admin.put("/api/admin/depositi/prova64-nord").send({ alias: ["Prova64 Borgo"] });
    expect(via2.status).toBe(409);
    expect((await uno("prova64-nord")).alias).toEqual(["Prova64 Borgo", "Prova64 Nord"]);
    // il gruppo, i periodi e l'ordine si cambiano sempre
    const r = await admin.put("/api/admin/depositi/prova64-nord").send({ gruppo: "A", cadenzaTurni: "settimanale", ordine: 9000 });
    expect(r.status).toBe(200);
    expect(await uno("prova64-nord")).toMatchObject({ gruppo: "A", cadenzaTurni: "settimanale", ordine: 9000, nome: "Prova64 Settentrione" });
  });

  it("un deposito in uso non si toglie; libero, sì", async () => {
    await db.execute(sql`INSERT INTO users (id, email, password_hash, role, depositi, depositi_visibili)
                         VALUES (${UTENTE}::uuid, 'depositi-utente@prova.local', 'x', 'user', ARRAY['prova64-nord'], ARRAY['prova64-nord', 'prova64-sud'])`);
    expect(await uno("prova64-nord")).toMatchObject({ utenti: 1 });
    expect(await uno("prova64-sud")).toMatchObject({ utenti: 1, conducenti: 0 });
    const no = await admin.delete("/api/admin/depositi/prova64-nord");
    expect(no.status).toBe(409);
    expect(no.body.error).toMatch(/2 conducenti/);
    expect(no.body.error).toMatch(/1 cambio di deposito programmato/);
    expect(no.body.error).toMatch(/1 utente/);
    expect((await admin.delete("/api/admin/depositi/prova64-sud")).status).toBe(409);
    // liberati
    await db.execute(sql`DELETE FROM users WHERE id = ${UTENTE}::uuid`);
    expect((await admin.delete("/api/admin/depositi/prova64-sud")).status).toBe(200);
    expect(await codici()).not.toContain("prova64-sud");
    await db.execute(sql`DELETE FROM roster_driver_history WHERE driver_id IN (${CON_STORICO}::uuid, ${PROGRAMMATO}::uuid)`);
    await db.execute(sql`DELETE FROM roster_drivers WHERE id IN (${CON_STORICO}::uuid, ${SENZA_STORICO}::uuid, ${PROGRAMMATO}::uuid)`);
    expect((await admin.delete("/api/admin/depositi/prova64-nord")).status).toBe(200);
    expect((await admin.delete("/api/admin/depositi/prova64-nord")).status).toBe(404);
  });

  it("i conducenti di prova: senza depositi nascono anche quelli di esempio (solo nelle installazioni di prova)", async () => {
    const prima = await codici();
    class Annulla extends Error {}
    let dentro: string[] = [];
    await db.transaction(async (tx) => {
      await creaConducentiDiProva(tx as unknown as Ex, 3, oggiRoma());
      dentro = (await tx.execute<any>(sql`SELECT codice FROM roster_depositi ORDER BY codice`)).rows.map((r: any) => r.codice);
      throw new Annulla();
    }).catch((e) => { if (!(e instanceof Annulla)) throw e; });
    if (prima.length === 0) expect(dentro).toEqual(DEPOSITI_DI_PROVA.map((d) => d.codice).sort());
    else expect(dentro).toEqual(prima);
    // e niente resta: era una prova annullata
    expect(await codici()).toEqual(prima);
  });
});
