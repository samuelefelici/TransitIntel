/**
 * Il catalogo dei titoli di viaggio (tappa 6.9, migrazione 0042), su un
 * database vero (TEST_DATABASE_URL; in CI come cerbero_app).
 *
 * Riempire un feed copia dal catalogo dell'azienda i titoli che mancano: lo
 * stesso risultato di prima, senza doppioni. I titoli già nel feed non si
 * toccano; si allineano al catalogo e alle fasce con un'azione a parte, che
 * prima dice che cosa cambierebbe. Il catalogo lo gestisce l'amministratore.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db, pool } from "@workspace/db";
import { sql } from "drizzle-orm";
import adminRouter from "../routes/admin";
import faresRouter from "../routes/fares";
import { bigliettiDiRiferimento } from "../lib/titoli-catalogo";
import { mettiInVigore } from "../lib/fasce-km-store";
import { appDiProva, utenteDiProva } from "./helpers/app-di-prova";
import { conLeFasceDiProva, FASCE_DI_PROVA, senzaFasce } from "./helpers/fasce-di-prova";
import { retiDiProvaNelDatabase } from "./helpers/reti-di-prova";
import { catalogoDiProvaNelDatabase, TITOLI_DI_PRIMA } from "./helpers/titoli-di-prova";

const ADMIN = utenteDiProva("e6900000-0000-4000-8000-000000000001", [], "admin");
const admin = request(appDiProva(adminRouter, ADMIN));
const utente = request(appDiProva(adminRouter, utenteDiProva("e6900000-0000-4000-8000-000000000002", ["fares"])));
const tariffe = request(appDiProva(faresRouter, ADMIN));
const F = "e6900000-0000-4000-8000-0000000000f1";  // il feed che si riempie
const V = "e6900000-0000-4000-8000-0000000000f2";  // un feed vuoto

const pulisciFeed = async (feed: string) => {
  await db.execute(sql`DELETE FROM gtfs_fare_leg_rules WHERE feed_id = ${feed}::uuid`);
  await db.execute(sql`DELETE FROM gtfs_fare_products WHERE feed_id = ${feed}::uuid`);
};
const titoli = async (feed = F) => (await db.execute<any>(sql`
  SELECT fare_product_id AS id, fare_product_name AS nome, network_id AS rete, rider_category_id AS categoria, amount AS prezzo,
         duration_minutes AS durata, fare_type AS tipo, is_urban_hourly AS orario
    FROM gtfs_fare_products WHERE feed_id = ${feed}::uuid ORDER BY id, created_at`)).rows;
const conta = async (feed = F) => (await db.execute<any>(sql`
  SELECT count(*)::int AS righe, count(DISTINCT fare_product_id)::int AS distinti FROM gtfs_fare_products WHERE feed_id = ${feed}::uuid`)).rows[0];
const perId = (righe: any[]) => new Map(righe.map((t) => [t.id, t]));
const CON_DURATA: Record<string, number> = { ancona_60min: 60, ancona_100min: 100, jesi_60min: 60, jesi_ar: 60, falc_60min: 60, falc_ar: 60, cfd_60min: 60, sasso_60min: 60, senigallia_60min: 60 };
const DI_RIFERIMENTO = new Set(["ancona_60min", "jesi_60min", "falc_60min", "cfd_60min", "sasso_60min", "senigallia_60min"]);

describe.runIf(!!process.env.TEST_DATABASE_URL)("il catalogo dei titoli, sul database", () => {
  let rimettiReti: () => Promise<void>;
  let togliCatalogo: () => Promise<void>;
  let catalogoDiPrima: unknown[] = [];

  beforeAll(async () => {
    catalogoDiPrima = (await db.execute<any>(sql`SELECT to_jsonb(t) AS riga FROM titoli_catalogo t`)).rows.map((r) => r.riga);
    await db.execute(sql`DELETE FROM titoli_catalogo`);
    for (const feed of [F, V]) { await pulisciFeed(feed); await db.execute(sql`DELETE FROM gtfs_feeds WHERE id = ${feed}::uuid`); }
    rimettiReti = await retiDiProvaNelDatabase();
    togliCatalogo = await catalogoDiProvaNelDatabase();
    conLeFasceDiProva();
    for (const feed of [F, V]) await db.execute(sql`INSERT INTO gtfs_feeds (id, filename, is_active) VALUES (${feed}::uuid, ${`titoli-6.9-${feed.slice(-2)}.synthetic`}, false)`);
  });

  afterAll(async () => {
    for (const feed of [F, V]) { await pulisciFeed(feed); await db.execute(sql`DELETE FROM gtfs_feeds WHERE id = ${feed}::uuid`); }
    await togliCatalogo();
    await rimettiReti();
    for (const riga of catalogoDiPrima) {
      await db.execute(sql`INSERT INTO titoli_catalogo SELECT * FROM jsonb_populate_record(NULL::titoli_catalogo, ${JSON.stringify(riga)}::jsonb)`);
    }
    senzaFasce();
    await pool.end();
  });

  it("tutto il catalogo in un feed vuoto: i 159 titoli di prima, con gli stessi nomi e prezzi", async () => {
    const r = await tariffe.post(`/api/fares/products/seed-abbonamenti?feedId=${F}`).send({});
    expect(r.status, JSON.stringify(r.body).slice(0, 300)).toBe(200);
    expect([r.body.inserted, r.body.total]).toEqual([159, 139]);
    const ora = perId(await titoli());
    expect(ora.size).toBe(159);
    for (const p of TITOLI_DI_PRIMA.abbonamenti) {
      /* la sola differenza voluta: nove biglietti ora hanno la durata, e sei sono di riferimento */
      const atteso = p.id in CON_DURATA ? { ...p, durata: CON_DURATA[p.id], orario: DI_RIFERIMENTO.has(p.id) } : p;
      expect(ora.get(p.id), p.id).toEqual(atteso);
    }
  });

  it("premere di nuovo non raddoppia niente", async () => {
    const r = await tariffe.post(`/api/fares/products/seed-abbonamenti?feedId=${F}`).send({});
    expect([r.status, r.body.inserted, r.body.total]).toEqual([200, 0, 139]);
    expect(await conta()).toEqual({ righe: 159, distinti: 159 });
  });

  it("i biglietti: si aggiunge uno per fascia, uguale a prima; quelli urbani c'erano già", async () => {
    const r = await tariffe.post(`/api/fares/products/seed?feedId=${F}`).send({});
    expect(r.status, JSON.stringify(r.body).slice(0, 300)).toBe(200);
    expect(r.body.length).toBe(182);
    expect(await conta()).toEqual({ righe: 182, distinti: 182 });
    const ora = perId(await titoli());
    for (const p of TITOLI_DI_PRIMA.base.filter((x) => x.tipo === "zone")) expect(ora.get(p.id), p.id).toEqual(p);
    await tariffe.post(`/api/fares/products/seed?feedId=${F}`).send({});
    expect(await conta()).toEqual({ righe: 182, distinti: 182 });
  });

  it("in un feed vuoto i soli biglietti: 23 per fascia e i 20 del catalogo", async () => {
    const r = await tariffe.post(`/api/fares/products/seed?feedId=${V}`).send({});
    expect(r.status).toBe(200);
    expect(await conta(V)).toEqual({ righe: 43, distinti: 43 });
    const ora = perId(await titoli(V));
    const prima = perId(TITOLI_DI_PRIMA.base);
    for (const id of ["ancona_60min", "ancona_100min", "jesi_60min", "jesi_ar"]) expect(ora.get(id), id).toEqual(prima.get(id));
    expect({ ...ora.get("falc_60min"), id: "falconara_60min" }).toEqual(prima.get("falconara_60min"));
    await pulisciFeed(V);
  });

  it("un titolo cambiato a mano nel feed non si tocca: il confronto lo dice, e l'allineamento lo rimette", async () => {
    await db.execute(sql`UPDATE gtfs_fare_products SET amount = 1.2, fare_product_name = 'Jesi 60' WHERE feed_id = ${F}::uuid AND fare_product_id = 'jesi_60min'`);
    await db.execute(sql`DELETE FROM gtfs_fare_products WHERE feed_id = ${F}::uuid AND fare_product_id = 'jesi_ar'`);
    await tariffe.post(`/api/fares/products/seed-abbonamenti?feedId=${F}`).send({});
    expect(perId(await titoli()).get("jesi_60min")).toMatchObject({ prezzo: 1.2, nome: "Jesi 60" });
    expect(perId(await titoli()).has("jesi_ar")).toBe(true);   // quello mancante è tornato
    const diff = await tariffe.get(`/api/fares/products/catalog-diff?feedId=${F}`);
    expect(diff.status, JSON.stringify(diff.body)).toBe(200);
    expect(diff.body).toEqual({
      mancanti: 0, uguali: 181, doppioni: 0,
      diversi: [{ id: "jesi_60min", differenze: ["prezzo 1,20 → 1,35", "nome «Jesi 60» → «Biglietto Urbano Jesi 60 min»"] }],
    });
    const r = await tariffe.post(`/api/fares/products/align-catalog?feedId=${F}`).send({});
    expect([r.status, r.body]).toEqual([200, { allineati: 1 }]);
    expect(perId(await titoli()).get("jesi_60min")).toMatchObject({ prezzo: 1.35, nome: "Biglietto Urbano Jesi 60 min", orario: true });
    expect((await tariffe.post(`/api/fares/products/align-catalog?feedId=${F}`).send({})).body).toEqual({ allineati: 0 });
  });

  it("cambiano le fasce: i biglietti per fascia del feed tengono il prezzo finché non si allineano", async () => {
    mettiInVigore(FASCE_DI_PROVA.map((f) => (f.fascia === 2 ? { ...f, price: 2 } : f.fascia === 3 ? { ...f, kmTo: 19 } : f.fascia === 4 ? { ...f, kmFrom: 19 } : f)));
    try {
      const diff = (await tariffe.get(`/api/fares/products/catalog-diff?feedId=${F}`)).body;
      expect(diff.diversi.find((d: any) => d.id === "extra_fascia_2")).toEqual({ id: "extra_fascia_2", differenze: ["prezzo 1,85 → 2,00"] });
      expect(diff.diversi.find((d: any) => d.id === "extra_fascia_3")).toEqual({ id: "extra_fascia_3", differenze: ["nome «Extraurbano 12-18 km» → «Extraurbano 12-19 km»"] });
      /* tre biglietti (fasce 2, 3 e 4) e i sedici abbonamenti che portano nel nome i chilometri delle fasce 3 e 4 */
      expect(diff.diversi.length).toBe(3 + 16);
      expect((await tariffe.post(`/api/fares/products/align-catalog?feedId=${F}`).send({})).body).toEqual({ allineati: 19 });
      expect(perId(await titoli()).get("extra_fascia_2")).toMatchObject({ prezzo: 2 });
      expect(perId(await titoli()).get("extra_sett_ord_fascia_3")).toMatchObject({ nome: "Extraurbano Settimanale Ordinario — Fascia 3 (12–19 km)", prezzo: 19.8 });
    } finally { conLeFasceDiProva(); }
    expect((await tariffe.post(`/api/fares/products/align-catalog?feedId=${F}`).send({})).body).toEqual({ allineati: 19 });
  });

  it("i doppioni che ci sono già si tolgono: resta la riga di riferimento, o quella con la durata", async () => {
    /* come li lasciava il codice di prima: lo stesso titolo due volte, una senza durata */
    await db.execute(sql`
      INSERT INTO gtfs_fare_products (feed_id, fare_product_id, fare_product_name, network_id, amount, duration_minutes, fare_type, is_urban_hourly, rider_category_id)
      SELECT feed_id, fare_product_id, fare_product_name, network_id, amount, NULL, fare_type, false, rider_category_id
        FROM gtfs_fare_products WHERE feed_id = ${F}::uuid AND fare_product_id IN ('ancona_60min', 'ancona_100min', 'ancona_mens_ord')`);
    expect(await conta()).toEqual({ righe: 185, distinti: 182 });
    expect((await tariffe.get(`/api/fares/products/catalog-diff?feedId=${F}`)).body.doppioni).toBe(3);
    /* la validazione del feed li segnala */
    const controlli = await tariffe.get(`/api/fares/validate?feedId=${F}`);
    expect(controlli.status, JSON.stringify(controlli.body).slice(0, 300)).toBe(200);
    expect(controlli.body.checks.find((c: any) => c.id === "products_no_dups")).toMatchObject({ ok: false, detail: "3 doppioni: toglili da «Genera & Esporta»" });
    const r = await tariffe.post(`/api/fares/products/deduplicate?feedId=${F}`).send({});
    expect([r.status, r.body]).toEqual([200, { deleted: 3, remaining: 182 }]);
    expect(await conta()).toEqual({ righe: 182, distinti: 182 });
    const ora = perId(await titoli());
    expect(ora.get("ancona_60min")).toMatchObject({ durata: 60, orario: true });
    expect(ora.get("ancona_100min")).toMatchObject({ durata: 100 });
    expect((await tariffe.post(`/api/fares/products/deduplicate?feedId=${F}`).send({})).body).toEqual({ deleted: 0, remaining: 182 });
    const dopo = await tariffe.get(`/api/fares/validate?feedId=${F}`);
    expect(dopo.body.checks.find((c: any) => c.id === "products_no_dups")).toMatchObject({ ok: true });
  });

  it("le regole delle reti urbane vengono dai titoli del feed, per tutte le reti", async () => {
    const r = await tariffe.post(`/api/fares/leg-rules/generate?feedId=${F}`).send({});
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.urbanRules).toBe(9);
    const regole = (await db.execute<any>(sql`
      SELECT leg_group_id, network_id, fare_product_id, rule_priority FROM gtfs_fare_leg_rules
       WHERE feed_id = ${F}::uuid AND network_id LIKE 'urbano_%' ORDER BY created_at, id`)).rows;
    expect(regole.map((x) => `${x.leg_group_id} ${x.network_id} ${x.fare_product_id}`).sort()).toEqual([
      "lg_ancona_100 urbano_ancona ancona_100min", "lg_ancona_60 urbano_ancona ancona_60min",
      "lg_cfd_60 urbano_castelfidardo cfd_60min", "lg_falc_60 urbano_falconara falc_60min", "lg_falc_ar urbano_falconara falc_ar",
      "lg_jesi_60 urbano_jesi jesi_60min", "lg_jesi_ar urbano_jesi jesi_ar",
      "lg_sasso_60 urbano_sassoferrato sasso_60min", "lg_senigallia_60 urbano_senigallia senigallia_60min",
    ]);
    expect(regole.every((x) => x.rule_priority === 10)).toBe(true);
    /* ogni regola punta a un titolo che nel feed c'è */
    const ids = new Set((await titoli()).map((t) => t.id));
    expect(regole.every((x) => ids.has(x.fare_product_id))).toBe(true);
  });

  it("il biglietto di riferimento di ogni rete urbana: dal feed, e dove il feed non ha titoli dal catalogo", async () => {
    await db.execute(sql`UPDATE gtfs_fare_products SET amount = 1.6 WHERE feed_id = ${F}::uuid AND fare_product_id = 'jesi_60min'`);
    const dalFeed = await bigliettiDiRiferimento(F);
    expect([...dalFeed.keys()].sort()).toEqual(["urbano_ancona", "urbano_castelfidardo", "urbano_falconara", "urbano_jesi", "urbano_sassoferrato", "urbano_senigallia"]);
    expect(dalFeed.get("urbano_jesi")).toEqual({ id: "jesi_60min", name: "Biglietto Urbano Jesi 60 min", price: 1.6, durationMin: 60 });
    expect(dalFeed.get("urbano_castelfidardo")).toEqual({ id: "cfd_60min", name: "Biglietto Urbano Castelfidardo 60 min", price: 1.35, durationMin: 60 });
    const dalCatalogo = await bigliettiDiRiferimento(V);
    expect(dalCatalogo.get("urbano_jesi")).toEqual({ id: "jesi_60min", name: "Biglietto Urbano Jesi 60 min", price: 1.35, durationMin: 60 });
    expect(dalCatalogo.get("urbano_sassoferrato")).toEqual({ id: "sasso_60min", name: "Biglietto Urbano Sassoferrato 60 min", price: 1.35, durationMin: 60 });
    expect(dalCatalogo.size).toBe(6);
  });

  it("senza fasce un catalogo con titoli per fascia non si copia: 409, e dice dove scriverle", async () => {
    mettiInVigore([]);
    try {
      const r = await tariffe.post(`/api/fares/products/seed-abbonamenti?feedId=${V}`).send({});
      expect(r.status, JSON.stringify(r.body)).toBe(409);
      expect(r.body.error).toMatch(/^Mancano le fasce chilometriche/);
      expect(await conta(V)).toEqual({ righe: 0, distinti: 0 });
      /* i soli biglietti sì: quelli urbani del catalogo, nessuno per fascia */
      const b = await tariffe.post(`/api/fares/products/seed?feedId=${V}`).send({});
      expect(b.status).toBe(200);
      expect(await conta(V)).toEqual({ righe: 20, distinti: 20 });
    } finally { conLeFasceDiProva(); await pulisciFeed(V); }
  });

  it("il catalogo lo legge e lo scrive solo l'amministratore", async () => {
    expect((await utente.get("/api/admin/titoli")).status).toBe(403);
    expect((await utente.post("/api/admin/titoli").send({})).status).toBe(403);
    expect((await utente.delete("/api/admin/titoli/ancona_60min")).status).toBe(403);
    const r = await admin.get("/api/admin/titoli");
    expect([r.status, r.body.titoli.length, r.body.massimo]).toEqual([200, 159, 1000]);
    expect(r.body.titoli[0]).toEqual({
      titolo: "ancona_mens_ord", nome: "Abbonamento Urbano Ancona Mensile Ordinario", rete: "urbano_ancona", tipo: "abbonamento_mensile",
      categoria: "ordinario", prezzo: 35, durataMinuti: 43200, fascia: null, diRiferimento: false, ordine: 1,
    });
  });

  it("crea, cambia e toglie un titolo; il biglietto di riferimento di una rete resta uno solo", async () => {
    const nuovo = await admin.post("/api/admin/titoli").send({ titolo: "jesi_30min", nome: "Biglietto Urbano Jesi 30 min", rete: "urbano_jesi", tipo: "single", prezzo: 1, durataMinuti: 30, diRiferimento: true });
    expect(nuovo.status, JSON.stringify(nuovo.body)).toBe(201);
    expect(nuovo.body.titolo).toMatchObject({ titolo: "jesi_30min", categoria: "ordinario", fascia: null, diRiferimento: true, ordine: 160 });
    const riferimenti = async () => (await db.execute<any>(sql`SELECT titolo FROM titoli_catalogo WHERE rete = 'urbano_jesi' AND di_riferimento`)).rows.map((x) => x.titolo);
    expect(await riferimenti()).toEqual(["jesi_30min"]);
    const cambiato = await admin.put("/api/admin/titoli/jesi_30min").send({ prezzo: 1.1, nome: "Biglietto Urbano Jesi mezz'ora" });
    expect(cambiato.status, JSON.stringify(cambiato.body)).toBe(200);
    expect(cambiato.body.titolo).toMatchObject({ prezzo: 1.1, nome: "Biglietto Urbano Jesi mezz'ora", durataMinuti: 30 });
    expect((await admin.put("/api/admin/titoli/jesi_60min").send({ diRiferimento: true })).status).toBe(200);
    expect(await riferimenti()).toEqual(["jesi_60min"]);
    expect((await admin.delete("/api/admin/titoli/jesi_30min")).status).toBe(200);
    expect((await admin.delete("/api/admin/titoli/jesi_30min")).status).toBe(404);
    expect((await admin.put("/api/admin/titoli/jesi_30min").send({ prezzo: 1 })).status).toBe(404);
    expect((await db.execute<any>(sql`SELECT count(*)::int AS n FROM titoli_catalogo`)).rows[0].n).toBe(159);
  });

  it("rifiuta un titolo che non sta in piedi, dicendo che cosa non va", async () => {
    const buono = { titolo: "jesi_prova", nome: "Biglietto di prova", rete: "urbano_jesi", tipo: "single", prezzo: 1 };
    for (const [parte, motivo] of [
      [{ titolo: "ancona_60min" }, "C'è già un titolo «ancona_60min» nel catalogo"],
      [{ rete: "urbano_altrove" }, "rete: la rete «urbano_altrove» non c'è"],
      [{ fascia: 3 }, "fascia: solo un titolo extraurbano ha un prezzo per fascia chilometrica"],
      [{ tipo: "return", diRiferimento: true }, "biglietto di riferimento: può esserlo solo un biglietto di corsa semplice di una rete urbana"],
      [{ rete: "extraurbano", diRiferimento: true }, "biglietto di riferimento: può esserlo solo un biglietto di corsa semplice di una rete urbana"],
    ] as const) {
      const r = await admin.post("/api/admin/titoli").send({ ...buono, ...parte });
      expect([r.status >= 400, r.body.error], motivo).toEqual([true, motivo]);
    }
    for (const parte of [{ nome: 'con "virgolette"' }, { prezzo: -1 }, { tipo: "zone" }, { titolo: "Con Maiuscole" }, { durataMinuti: 0 }, { altro: true }]) {
      expect((await admin.post("/api/admin/titoli").send({ ...buono, ...parte })).status, JSON.stringify(parte)).toBe(400);
    }
    expect((await db.execute<any>(sql`SELECT count(*)::int AS n FROM titoli_catalogo`)).rows[0].n).toBe(159);
  });

  it("una rete coi titoli nel catalogo è in uso: non si toglie", async () => {
    const elenco = await admin.get("/api/admin/reti");
    expect(elenco.body.reti.find((x: any) => x.rete === "urbano_sassoferrato").uso).toMatchObject({ catalogo: 6 });
    const r = await admin.delete("/api/admin/reti/urbano_sassoferrato");
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/6 titoli nel catalogo/);
  });

  it("anche il database tiene un solo riferimento per rete, e rifiuta un titolo senza senso", async () => {
    await expect(db.execute(sql`UPDATE titoli_catalogo SET di_riferimento = true WHERE titolo = 'jesi_ar'`)).rejects.toThrow();
    await expect(db.execute(sql`UPDATE titoli_catalogo SET di_riferimento = true WHERE titolo = 'ancona_100min'`)).rejects.toThrow();
    await expect(db.execute(sql`UPDATE titoli_catalogo SET fascia = 2 WHERE titolo = 'ancona_100min'`)).rejects.toThrow();
    await expect(db.execute(sql`UPDATE titoli_catalogo SET nome = 'con "virgolette"' WHERE titolo = 'ancona_100min'`)).rejects.toThrow();
    await expect(db.execute(sql`UPDATE titoli_catalogo SET rete = 'urbano_altrove' WHERE titolo = 'ancona_100min'`)).rejects.toThrow();
  });

  it("ogni modifica al catalogo resta nel registro", async () => {
    const stato = (await db.execute<any>(sql`SELECT registro.stato() AS st`)).rows[0].st;
    expect(stato.tabelle.map((t: any) => t.tabella ?? t)).toContain("public.titoli_catalogo");
  });
});
