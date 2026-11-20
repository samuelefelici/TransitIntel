/**
 * Le fasce chilometriche dell'extraurbano (tappa 6.8, migrazione 0041), su un
 * database vero (TEST_DATABASE_URL; in CI come cerbero_app).
 *
 * L'amministratore salva l'elenco delle fasce; quello che salva entra in
 * vigore subito, e le rotte delle tariffe calcolano con quelle. Senza fasce
 * una rotta che ne ha bisogno risponde 409, col testo da mostrare.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db, pool } from "@workspace/db";
import { sql } from "drizzle-orm";
import adminRouter from "../routes/admin";
import faresRouter from "../routes/fares";
import polimetricheRouter from "../routes/fares-polimetriche";
import { fasceKm, fasciaPerDistanza, impostaFasce } from "../lib/fasce-km";
import { dimenticaFasce } from "../lib/fasce-km-store";
import { decidi } from "../lib/permessi-rotte";
import { appDiProva, utenteDiProva } from "./helpers/app-di-prova";
import { FASCE_DI_PROVA } from "./helpers/fasce-di-prova";

const ADMIN = utenteDiProva("e6800000-0000-4000-8000-000000000001", [], "admin");
const admin = request(appDiProva(adminRouter, ADMIN));
const utente = request(appDiProva(adminRouter, utenteDiProva("e6800000-0000-4000-8000-000000000002", ["fares"])));
const tariffe = request(appDiProva(faresRouter, ADMIN));
/* chi lavora alle tariffe senza essere amministratore (tappa 6.33) */
const TARIFFISTA = utenteDiProva("e6800000-0000-4000-8000-000000000003", ["fares"]);
const polimetriche = request(appDiProva(polimetricheRouter, TARIFFISTA));
const F = "e6800000-0000-4000-8000-0000000000f1";

const TRE = [
  { fascia: 1, kmFrom: 0, kmTo: 7.5, price: 1.2 },
  { fascia: 2, kmFrom: 7.5, kmTo: 15, price: 1.9 },
  { fascia: 3, kmFrom: 15, kmTo: 40, price: 3.05 },
];

async function pulisciFeed() {
  await db.execute(sql`DELETE FROM gtfs_fare_products WHERE feed_id = ${F}::uuid`);
  await db.execute(sql`DELETE FROM gtfs_feeds WHERE id = ${F}::uuid`);
}
const prodottiExtra = async () => (await db.execute<any>(sql`
  SELECT fare_product_id, fare_product_name, amount FROM gtfs_fare_products
   WHERE feed_id = ${F}::uuid AND network_id = 'extraurbano' ORDER BY amount`)).rows;

describe.runIf(!!process.env.TEST_DATABASE_URL)("le fasce chilometriche, sul database", () => {
  let diPrima: unknown[] = [];

  beforeAll(async () => {
    diPrima = (await db.execute<any>(sql`SELECT to_jsonb(f) AS riga FROM fasce_km f`)).rows.map((r) => r.riga);
    await pulisciFeed();
    /* si parte come un'installazione nuova: nessuna fascia */
    await db.execute(sql`DELETE FROM fasce_km`);
    await db.execute(sql`INSERT INTO gtfs_feeds (id, filename, is_active) VALUES (${F}::uuid, 'fasce-6.8.synthetic', false)`);
    impostaFasce([]);
    dimenticaFasce();
  });

  afterAll(async () => {
    await pulisciFeed();
    await db.execute(sql`DELETE FROM fasce_km`);
    for (const riga of diPrima) {
      await db.execute(sql`INSERT INTO fasce_km SELECT * FROM jsonb_populate_record(NULL::fasce_km, ${JSON.stringify(riga)}::jsonb)`);
    }
    impostaFasce([]);
    dimenticaFasce();
    await pool.end();
  });

  it("un'installazione nuova non ha fasce", async () => {
    const r = await admin.get("/api/admin/fasce-km");
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toEqual({ fasce: [], massimoFasce: 60 });
    expect((await polimetriche.get("/api/fares/polimetriche/fasce")).body).toEqual({ fasce: [] });
  });

  it("senza fasce, una rotta delle tariffe che ne ha bisogno risponde 409 e dice dove scriverle", async () => {
    /* un catalogo con un abbonamento extraurbano per fascia: senza le fasce non si può copiare in un feed */
    await db.execute(sql`INSERT INTO titoli_catalogo (titolo, nome, rete, tipo, prezzo, fascia) VALUES ('prova_fascia_1', 'Abbonamento di prova', 'extraurbano', 'abbonamento_mensile', 30, 1)`);
    try {
      const r = await tariffe.post(`/api/fares/products/seed-abbonamenti?feedId=${F}`).send({});
      expect(r.status, JSON.stringify(r.body)).toBe(409);
      expect(r.body.error).toBe("Mancano le fasce chilometriche dell'extraurbano: le scrive l'amministratore in Amministrazione › Azienda, scheda «Fasce chilometriche»");
      expect(await prodottiExtra()).toEqual([]);
    } finally { await db.execute(sql`DELETE FROM titoli_catalogo WHERE titolo = 'prova_fascia_1'`); }
    /* una rotta che non ne ha bisogno risponde come sempre */
    expect((await tariffe.get(`/api/fares/products?feedId=${F}`)).status).toBe(200);
  });

  it("le legge e le scrive solo l'amministratore", async () => {
    expect((await utente.get("/api/admin/fasce-km")).status).toBe(403);
    expect((await utente.put("/api/admin/fasce-km").send({ fasce: TRE })).status).toBe(403);
    expect((await db.execute<any>(sql`SELECT count(*)::int AS n FROM fasce_km`)).rows[0].n).toBe(0);
  });

  it("salva l'elenco, ed entra in vigore subito", async () => {
    const r = await admin.put("/api/admin/fasce-km").send({ fasce: TRE });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.fasce).toEqual(TRE);
    expect(fasceKm()).toEqual(TRE);
    expect([fasciaPerDistanza(7.5)?.price, fasciaPerDistanza(7.6)?.price, fasciaPerDistanza(90)?.price]).toEqual([1.2, 1.9, 3.05]);
    expect((await admin.get("/api/admin/fasce-km")).body.fasce).toEqual(TRE);
    expect((await db.execute<any>(sql`SELECT fascia, km_da::float8 AS da, km_a::float8 AS a, prezzo::float8 AS prezzo FROM fasce_km ORDER BY fascia`)).rows)
      .toEqual(TRE.map((f) => ({ fascia: f.fascia, da: f.kmFrom, a: f.kmTo, prezzo: f.price })));
  });

  it("chi lavora alle polimetriche le legge senza essere amministratore, e non le scrive", async () => {
    const r = await polimetriche.get("/api/fares/polimetriche/fasce");
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toEqual({ fasce: TRE });
    const chi = { admin: false, diritti: TARIFFISTA.diritti };
    expect(decidi(chi, "GET", "/fares/polimetriche/fasce")).toEqual({ passa: true });
    expect(decidi(chi, "PUT", "/admin/fasce-km").passa).toBe(false);
    /* chi non ha le tariffe non le legge nemmeno da qui */
    const altro = utenteDiProva("e6800000-0000-4000-8000-000000000004", ["roster"]);
    expect(decidi({ admin: false, diritti: altro.diritti }, "GET", "/fares/polimetriche/fasce").passa).toBe(false);
  });

  it("le rotte delle tariffe calcolano con le fasce salvate: un titolo extraurbano per fascia, col suo prezzo", async () => {
    const r = await tariffe.post(`/api/fares/products/seed?feedId=${F}`).send({});
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await prodottiExtra()).toEqual([
      { fare_product_id: "extra_fascia_1", fare_product_name: "Extraurbano 0-7.5 km", amount: 1.2 },
      { fare_product_id: "extra_fascia_2", fare_product_name: "Extraurbano 7.5-15 km", amount: 1.9 },
      { fare_product_id: "extra_fascia_3", fare_product_name: "Extraurbano 15-40 km", amount: 3.05 },
    ]);
  });

  it("un altro processo le trova quando le rilegge", async () => {
    impostaFasce([]);
    dimenticaFasce();
    expect((await tariffe.get(`/api/fares/products?feedId=${F}`)).status).toBe(200);
    expect(fasceKm()).toEqual(TRE);
  });

  it("rifiuta un elenco che non sta in piedi, dicendo che cosa non va, e non cambia niente", async () => {
    const con = (cambia: (f: typeof TRE) => unknown[]) => admin.put("/api/admin/fasce-km").send({ fasce: cambia(structuredClone(TRE)) });
    for (const [cambia, motivo] of [
      [(f) => [f[0], { ...f[1], kmFrom: 9 }, f[2]], "Fascia 2: resta un buco fra 7.5 e 9 km."],
      [(f) => [f[0], { ...f[1], kmFrom: 5 }, f[2]], "Fascia 2: si sovrappone alla 1 (comincia a 5 km, l'altra finisce a 7.5)."],
      [(f) => [f[0], f[2]], "Fascia 2: le fasce si numerano da 1 senza saltare (qui c'è 3)."],
      [(f) => [{ ...f[0], kmFrom: 1 }, f[1], f[2]], "Fascia 1: la prima fascia parte da 0 km (qui da 1)."],
      [(f) => [f[0], { ...f[1], kmTo: 7.5 }, f[2]], "Fascia 2: finisce a 7.5 km, prima di dove comincia (7.5 km)."],
    ] as [(f: typeof TRE) => unknown[], string][]) {
      const r = await con(cambia);
      expect([r.status, r.body.error], motivo).toEqual([400, motivo]);
    }
    for (const cambia of [
      (f: typeof TRE) => [{ ...f[0], price: 0 }], (f: typeof TRE) => [{ ...f[0], price: "1.20" }], (f: typeof TRE) => [{ ...f[0], price: 1.234 }],
      (f: typeof TRE) => [{ ...f[0], kmTo: 7.55 }], (f: typeof TRE) => [{ ...f[0], altro: true }], (f: typeof TRE) => [{ ...f[0], kmTo: 3000 }],
    ]) {
      expect((await con(cambia)).status).toBe(400);
    }
    expect((await admin.put("/api/admin/fasce-km").send({})).status).toBe(400);
    expect(fasceKm()).toEqual(TRE);
    expect((await db.execute<any>(sql`SELECT count(*)::int AS n FROM fasce_km`)).rows[0].n).toBe(3);
  });

  it("cambiare un prezzo tocca solo quella riga; un elenco più corto toglie le fasce in fondo", async () => {
    const prima = (await db.execute<any>(sql`SELECT fascia, xmin::text AS versione FROM fasce_km ORDER BY fascia`)).rows;
    const r = await admin.put("/api/admin/fasce-km").send({ fasce: [TRE[0], { ...TRE[1], price: 2 }, TRE[2]] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const dopo = (await db.execute<any>(sql`SELECT fascia, xmin::text AS versione FROM fasce_km ORDER BY fascia`)).rows;
    expect(dopo.map((x, i) => x.versione === prima[i].versione)).toEqual([true, false, true]);
    expect(fasciaPerDistanza(10)?.price).toBe(2);
    const corto = await admin.put("/api/admin/fasce-km").send({ fasce: [TRE[0]] });
    expect(corto.status).toBe(200);
    expect(fasceKm()).toEqual([TRE[0]]);
    expect((await db.execute<any>(sql`SELECT count(*)::int AS n FROM fasce_km`)).rows[0].n).toBe(1);
  });

  it("le 23 fasce di prova si salvano così come sono; nessuna fascia le toglie tutte", async () => {
    const r = await admin.put("/api/admin/fasce-km").send({ fasce: FASCE_DI_PROVA });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(fasceKm()).toEqual(FASCE_DI_PROVA);
    expect([fasciaPerDistanza(19.8)?.price, fasciaPerDistanza(250)?.price]).toEqual([2.85, 8.75]);
    expect((await admin.put("/api/admin/fasce-km").send({ fasce: [] })).status).toBe(200);
    expect(fasceKm()).toEqual([]);
  });

  it("anche il database rifiuta una fascia senza senso", async () => {
    for (const valori of [sql`(1, 5, 5, 1)`, sql`(1, -1, 5, 1)`, sql`(1, 0, 5, 0)`, sql`(0, 0, 5, 1)`, sql`(61, 0, 5, 1)`]) {
      await expect(db.execute(sql`INSERT INTO fasce_km (fascia, km_da, km_a, prezzo) VALUES ${valori}`)).rejects.toThrow();
    }
  });

  it("ogni modifica resta nel registro", async () => {
    const stato = (await db.execute<any>(sql`SELECT registro.stato() AS st`)).rows[0].st;
    expect(stato.tabelle.map((t: any) => t.tabella ?? t)).toContain("public.fasce_km");
  });
});
