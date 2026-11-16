/**
 * Il catalogo delle voci del roster in tabella (tappa 5.5, migrazione 0034)
 * su un database vero (TEST_DATABASE_URL; in CI come cerbero_app):
 * l'amministratore crea, cambia, spegne e cancella; il roster scrive solo
 * voci attive; le regole (libera il turno, sanitaria) vengono dalla tabella;
 * le rotazioni usano solo assenze del catalogo; una voce usata non si cancella.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import adminRouter from "../routes/admin";
import rosterRouter from "../routes/roster";
import rotazioniRouter from "../lib/roster-rotazioni";
import { assentiNelGiorno } from "../lib/roster-sostituti";
import { appDiProva, utenteDiProva } from "./helpers/app-di-prova";
import type { Ex } from "../lib/anagrafica-store";

const u = (n: number) => `e5500000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [ADMIN, AUTISTA] = [u(1), u(2)];
const GIORNO = "2032-07-06";
const NUOVE = ["RC", "T55", "X55"];

const router = Router();
router.use(adminRouter);
router.use(rosterRouter);
router.use(rotazioniRouter);
const admin = request(appDiProva(router, utenteDiProva(ADMIN, [], "admin")));
/* chi scrive il roster ma non vede i dati sanitari */
const capo = request(appDiProva(router, utenteDiProva(u(3), [], "user", { ruoli: ["capo_deposito"] })));
const righe = async (q: ReturnType<typeof sql>) => (await db.execute<any>(q)).rows;
const voce = (code: string, category = "assenza") => admin.post("/api/roster/entries").send({ driverId: AUTISTA, day: GIORNO, category, code });
const tabellone = async (chi = admin) => {
  const r = await chi.get(`/api/roster/board?from=${GIORNO}&days=1`);
  expect(r.status).toBe(200);
  return (r.body.entries as any[]).filter((e) => e.driverId === AUTISTA);
};

describe.runIf(!!process.env.TEST_DATABASE_URL)("il catalogo delle voci del roster, sul database", () => {
  const pulisci = async () => {
    await db.execute(sql`DELETE FROM roster_entries WHERE driver_id = ${AUTISTA}::uuid`);
    await db.execute(sql`DELETE FROM roster_rotazioni_riposi WHERE name LIKE 'Prova 5.5%'`);
    await db.execute(sql`DELETE FROM roster_voci WHERE codice IN (SELECT jsonb_array_elements_text(${JSON.stringify(NUOVE)}::jsonb))`);
    await db.execute(sql`UPDATE roster_voci SET nome = 'Riposo' WHERE codice = 'R'`);
    await db.execute(sql`DELETE FROM roster_drivers WHERE id = ${AUTISTA}::uuid`);
    await db.execute(sql`DELETE FROM users WHERE id = ${ADMIN}::uuid`);
  };
  beforeAll(async () => {
    await pulisci();
    await db.execute(sql`INSERT INTO users (id, email, password_hash, role) VALUES (${ADMIN}::uuid, 'voci@prova.local', 'x', 'admin')`);
    await db.execute(sql`INSERT INTO roster_drivers (id, name, cognome, nome, is_fictitious, is_active, residenza_servizio, versione, updated_at)
      VALUES (${AUTISTA}::uuid, 'Voci 5.5', 'Voci', 'Prova', false, true, 'Jesi', 0, now())`);
  });
  afterAll(pulisci);

  it("l'elenco dell'amministratore: le 12 voci di partenza con le regole; a chi non è admin 403", async () => {
    const r = await admin.get("/api/admin/voci-roster");
    expect(r.status).toBe(200);
    const di = new Map((r.body.voci as any[]).map((v) => [v.codice, v]));
    for (const c of ["R", "ASS", "MA3", "MA", "I", "PAD", "STRA", "D1", "D2", "DISP", "DAM1", "DAM2"]) expect(di.has(c)).toBe(true);
    expect(di.get("R")).toMatchObject({ categoria: "assenza", liberaTurno: false, diSistema: true, attiva: true, voci: expect.any(Number), rotazioni: expect.any(Array) });
    expect(di.get("MA")).toMatchObject({ sanitaria: true, liberaTurno: true, diSistema: false });
    expect(di.get("D1")).toMatchObject({ categoria: "presenza", aDisposizione: true });
    expect((await capo.get("/api/admin/voci-roster")).status).toBe(403);
    expect((await capo.post("/api/admin/voci-roster").send({ codice: "X55", categoria: "assenza", nome: "x" })).status).toBe(403);
  });

  it("una voce nuova: un riposo compensativo che non libera il turno; il roster la offre e la scrive", async () => {
    const r = await admin.post("/api/admin/voci-roster").send({ codice: "RC", categoria: "assenza", nome: "Riposo compensativo", liberaTurno: false, codicePaghe: "R02" });
    expect(r.status).toBe(201);
    expect(r.body.voce).toMatchObject({ codice: "RC", liberaTurno: false, sanitaria: false, attiva: true, codicePaghe: "R02" });
    expect((await admin.post("/api/admin/voci-roster").send({ codice: "RC", categoria: "assenza", nome: "Doppia" })).status).toBe(409);
    expect((await admin.post("/api/admin/voci-roster").send({ codice: "rc", categoria: "assenza", nome: "x" })).status).toBe(400);
    expect((await admin.post("/api/admin/voci-roster").send({ codice: "X55", categoria: "presenza", nome: "x", sanitaria: true })).status).toBe(400);
    expect((await admin.post("/api/admin/voci-roster").send({ codice: "X55", categoria: "assenza", nome: "x", altro: 1 })).status).toBe(400);
    expect((await admin.post("/api/admin/voci-roster").send({ codice: "X55", categoria: "assenza", nome: "x", codicePaghe: "a b" })).status).toBe(400);

    const offerte = (await capo.get("/api/roster/voci")).body.catalog;
    expect(offerte.assenza.find((v: any) => v.code === "RC")).toEqual({ code: "RC", label: "Riposo compensativo", liberaTurno: false, aDisposizione: false });
    expect(offerte.assenza.some((v: any) => v.code === "MA")).toBe(false);
    expect((await voce("RC")).status).toBe(201);
    // non libera il turno: né nel tabellone né per i sostituti
    expect((await tabellone()).find((e) => e.code === "RC")).toMatchObject({ liberaTurno: false, aDisposizione: false });
    expect((await assentiNelGiorno(db as unknown as Ex, [AUTISTA], GIORNO)).size).toBe(0);
    expect((await voce("ASS")).status).toBe(201);
    expect((await assentiNelGiorno(db as unknown as Ex, [AUTISTA], GIORNO)).has(AUTISTA)).toBe(true);
    // la categoria deve essere quella della voce
    expect((await voce("RC", "presenza")).status).toBe(400);
  });

  it("spenta: non si scrive più, quelle già scritte restano; si riaccende", async () => {
    expect((await admin.put("/api/admin/voci-roster/RC").send({ attiva: false })).body.voce).toMatchObject({ attiva: false });
    const no = await voce("RC");
    expect(no.status).toBe(400);
    expect(no.body.error).toMatch(/spenta/);
    expect((await tabellone()).some((e) => e.code === "RC")).toBe(true);
    expect((await capo.get("/api/roster/voci")).body.catalog.assenza.some((v: any) => v.code === "RC")).toBe(false);
    expect((await admin.put("/api/admin/voci-roster/RC").send({ attiva: true })).status).toBe(200);
  });

  it("sanitaria si accende e non si spegne; chi non ha il permesso legge ASS", async () => {
    expect((await admin.put("/api/admin/voci-roster/RC").send({ sanitaria: true })).body.voce).toMatchObject({ sanitaria: true });
    expect((await tabellone(capo)).map((e) => e.code).sort()).toEqual(["ASS", "ASS"]);
    expect((await tabellone(admin)).map((e) => e.code).sort()).toEqual(["ASS", "RC"]);
    const no = await admin.put("/api/admin/voci-roster/RC").send({ sanitaria: false });
    expect(no.status).toBe(400);
    expect(no.body.error).toMatch(/non si spegne/);
    expect((await admin.put("/api/admin/voci-roster/MA").send({ sanitaria: false })).status).toBe(400);
    // e il capo non la scrive più
    expect((await capo.post("/api/roster/entries").send({ driverId: AUTISTA, day: "2032-07-07", category: "assenza", code: "RC" })).status).toBe(403);
  });

  it("R e ASS: si cambiano solo nome, ordine e codice per le paghe; il database lo ripete", async () => {
    expect((await admin.put("/api/admin/voci-roster/R").send({ attiva: false })).status).toBe(400);
    expect((await admin.put("/api/admin/voci-roster/R").send({ liberaTurno: true })).status).toBe(400);
    expect((await admin.put("/api/admin/voci-roster/ASS").send({ sanitaria: true })).status).toBe(400);
    expect((await admin.put("/api/admin/voci-roster/R").send({ nome: "Riposo settimanale", codicePaghe: "R01" })).body.voce)
      .toMatchObject({ nome: "Riposo settimanale", codicePaghe: "R01", liberaTurno: false });
    await db.execute(sql`UPDATE roster_voci SET codice_paghe = NULL WHERE codice = 'R'`);
    expect((await admin.put("/api/admin/voci-roster/NONCE").send({ nome: "x" })).status).toBe(404);
    expect((await admin.put("/api/admin/voci-roster/D1").send({ liberaTurno: true })).status).toBe(400);
    await expect(db.execute(sql`UPDATE roster_voci SET attiva = false WHERE codice = 'R'`))
      .rejects.toMatchObject({ cause: expect.objectContaining({ code: "23514" }) });
  });

  it("cancellare: solo una voce mai usata; quella usata si spegne; R mai", async () => {
    expect((await admin.post("/api/admin/voci-roster").send({ codice: "T55", categoria: "presenza", nome: "Prova", aDisposizione: true })).status).toBe(201);
    expect((await admin.delete("/api/admin/voci-roster/T55")).body).toEqual({ ok: true });
    const usata = await admin.delete("/api/admin/voci-roster/RC");
    expect(usata.status).toBe(409);
    expect(usata.body.error).toMatch(/spegnila/);
    expect((await admin.delete("/api/admin/voci-roster/R")).status).toBe(400);
    // anche senza l'API: la chiave esterna
    await expect(db.execute(sql`DELETE FROM roster_voci WHERE codice = 'RC'`))
      .rejects.toMatchObject({ cause: expect.objectContaining({ code: "23503" }) });
    await expect(db.execute(sql`INSERT INTO roster_entries (driver_id, day, category, code) VALUES (${AUTISTA}::uuid, ${GIORNO}::date, 'assenza', 'NONCE')`))
      .rejects.toMatchObject({ cause: expect.objectContaining({ code: "23503" }) });
  });

  it("le rotazioni: solo assenze attive e non sanitarie del catalogo; la voce usata in una rotazione non si cancella", async () => {
    const settimana = (c: string | null) => [[c, null, null, null, null, null, "R"]];
    const sanitaria = await admin.post("/api/roster/rotazioni-riposi").send({ name: "Prova 5.5 a", pattern: settimana("MA") });
    expect(sanitaria.status).toBe(400);
    expect(sanitaria.body.error).toMatch(/Malattia/);
    expect((await admin.post("/api/roster/rotazioni-riposi").send({ name: "Prova 5.5 b", pattern: settimana("FE") })).body.error).toMatch(/non è un'assenza/);
    expect((await admin.post("/api/roster/rotazioni-riposi").send({ name: "Prova 5.5 c", pattern: settimana("D1") })).status).toBe(400);
    expect((await admin.post("/api/admin/voci-roster").send({ codice: "X55", categoria: "assenza", nome: "Riposo di prova", liberaTurno: false })).status).toBe(201);
    expect((await admin.post("/api/roster/rotazioni-riposi").send({ name: "Prova 5.5 d", pattern: settimana("X55") })).status).toBe(201);
    const v = (await admin.get("/api/admin/voci-roster")).body.voci.find((x: any) => x.codice === "X55");
    expect(v).toMatchObject({ voci: 0, rotazioni: ["Prova 5.5 d"] });
    expect((await admin.delete("/api/admin/voci-roster/X55")).status).toBe(409);
  });
});
