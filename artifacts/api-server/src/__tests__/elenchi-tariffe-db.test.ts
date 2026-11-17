/**
 * Gli elenchi di partenza delle tariffe e l'agenzia dei GTFS (tappa 6.10,
 * migrazione 0043), su un database vero (TEST_DATABASE_URL; in CI come
 * cerbero_app).
 *
 * Riempire un feed dà le stesse categorie e gli stessi supporti di prima,
 * presi dai dati dell'azienda; il GTFS delle tariffe scrive in agency.txt
 * l'agenzia di quei dati (o l'azienda, se non ce n'è una a parte). Gli
 * elenchi li gestisce l'amministratore.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import AdmZip from "adm-zip";
import { db, pool } from "@workspace/db";
import { sql } from "drizzle-orm";
import adminRouter from "../routes/admin";
import faresRouter from "../routes/fares";
import nodiRouter from "../routes/fares-node-assignment";
import { leggiAzienda } from "../lib/azienda";
import { agencyTxt, agenziaNelGtfs } from "../lib/elenchi-tariffe";
import { appDiProva, utenteDiProva } from "./helpers/app-di-prova";
import { AGENZIA_DI_PROVA, ELENCHI_DI_PRIMA, elenchiDiProvaNelDatabase } from "./helpers/elenchi-di-prova";

const ADMIN = utenteDiProva("e6a00000-0000-4000-8000-000000000001", [], "admin");
const admin = request(appDiProva(adminRouter, ADMIN));
const utente = request(appDiProva(adminRouter, utenteDiProva("e6a00000-0000-4000-8000-000000000002", ["fares"])));
const tariffe = request(appDiProva(faresRouter, ADMIN));
const nodi = request(appDiProva(nodiRouter, ADMIN));
const F = "e6a00000-0000-4000-8000-0000000000f1";  // il feed che si riempie
const TITOLO = "prova_6a_studente";                 // un titolo del catalogo che usa la categoria «studente»

const pulisciFeed = async () => {
  for (const t of ["gtfs_fare_official_nodes", "gtfs_feed_info", "gtfs_fare_media", "gtfs_rider_categories", "gtfs_routes"]) {
    await db.execute(sql`DELETE FROM ${sql.identifier(t)} WHERE feed_id = ${F}::uuid`);
  }
};
const categorieDelFeed = async () => (await db.execute<any>(sql`
  SELECT rider_category_id AS categoria, rider_category_name AS nome, is_default AS predefinita, eligibility_url AS url
    FROM gtfs_rider_categories WHERE feed_id = ${F}::uuid ORDER BY created_at, rider_category_id`)).rows;
const supportiDelFeed = async () => (await db.execute<any>(sql`
  SELECT fare_media_id AS supporto, fare_media_name AS nome, fare_media_type AS tipo, is_active AS attivo
    FROM gtfs_fare_media WHERE feed_id = ${F}::uuid ORDER BY created_at, fare_media_id`)).rows;
const perChiave = <T extends Record<string, any>>(righe: T[], chiave: string) => new Map(righe.map((r) => [r[chiave], r]));
/** Il GTFS delle tariffe, aperto: nome del file → testo. */
const gtfs = async (): Promise<Record<string, string>> => {
  const r = await tariffe.get(`/api/fares/export-zip?feedId=${F}`).buffer(true)
    .parse((res, fine) => { const pezzi: Buffer[] = []; res.on("data", (p: Buffer) => pezzi.push(p)); res.on("end", () => fine(null, Buffer.concat(pezzi))); });
  expect(r.status).toBe(200);
  return Object.fromEntries(new AdmZip(r.body as Buffer).getEntries().map((e) => [e.entryName, e.getData().toString("utf8")]));
};
/** I campi di una riga di CSV: quelli fra virgolette senza le virgolette, anche l'ultimo se è vuoto. */
const campi = (riga: string): string[] => {
  const out: string[] = [];
  let i = 0;
  while (i <= riga.length) {
    if (riga[i] === '"') {
      let j = i + 1, v = "";
      while (j < riga.length && !(riga[j] === '"' && riga[j + 1] !== '"')) { if (riga[j] === '"') j++; v += riga[j++]; }
      out.push(v); i = j + 2;
    } else {
      const j = riga.indexOf(",", i), fine = j < 0 ? riga.length : j;
      out.push(riga.slice(i, fine)); i = fine + 1;
    }
  }
  return out;
};

describe.runIf(!!process.env.TEST_DATABASE_URL)("gli elenchi delle tariffe e l'agenzia dei GTFS, sul database", () => {
  let rimetti: () => Promise<void>;

  beforeAll(async () => {
    await db.execute(sql`DELETE FROM titoli_catalogo WHERE titolo = ${TITOLO}`);
    await pulisciFeed();
    await db.execute(sql`DELETE FROM gtfs_feeds WHERE id = ${F}::uuid`);
    rimetti = await elenchiDiProvaNelDatabase();
    await db.execute(sql`INSERT INTO gtfs_feeds (id, filename, is_active) VALUES (${F}::uuid, 'elenchi-6.10.synthetic', false)`);
    /* due linee: una dice un'altra agenzia, una non ne dice nessuna e non ha un indirizzo suo */
    await db.execute(sql`
      INSERT INTO gtfs_routes (feed_id, route_id, agency_id, route_short_name, route_long_name, route_type, route_url)
      VALUES (${F}::uuid, 'L1', 'ALTRA', '1', 'Stazione - Centro', 3, 'https://linee.example/1'),
             (${F}::uuid, 'L2', NULL, '2', 'Centro, via del Porto', 3, NULL)`);
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM titoli_catalogo WHERE titolo = ${TITOLO}`);
    await pulisciFeed();
    await db.execute(sql`DELETE FROM gtfs_feeds WHERE id = ${F}::uuid`);
    await rimetti();
    await pool.end();
  });

  describe("riempire un feed", () => {
    it("le categorie in un feed vuoto: le sette di prima, con nomi, pagine e predefinita", async () => {
      const r = await tariffe.post(`/api/fares/rider-categories/seed?feedId=${F}`).send({});
      expect(r.status, JSON.stringify(r.body).slice(0, 300)).toBe(200);
      expect(r.body.length).toBe(7);
      const ora = perChiave(await categorieDelFeed(), "categoria");
      for (const c of ELENCHI_DI_PRIMA.categorie) expect(ora.get(c.categoria), c.categoria).toEqual(c);
    });

    it("i supporti in un feed vuoto: i sette di prima, tutti accesi", async () => {
      const r = await tariffe.post(`/api/fares/media/seed?feedId=${F}`).send({});
      expect(r.status, JSON.stringify(r.body).slice(0, 300)).toBe(200);
      const ora = perChiave(await supportiDelFeed(), "supporto");
      expect(ora.size).toBe(7);
      for (const s of ELENCHI_DI_PRIMA.supporti) expect(ora.get(s.supporto), s.supporto).toEqual({ ...s, attivo: true });
    });

    it("premere di nuovo non raddoppia: i nomi tornano quelli dell'elenco, chi è spento resta spento, le categorie in più restano", async () => {
      await db.execute(sql`UPDATE gtfs_fare_media SET is_active = false, fare_media_name = 'App' WHERE feed_id = ${F}::uuid AND fare_media_id = 'app_mobile'`);
      await db.execute(sql`UPDATE gtfs_rider_categories SET rider_category_name = 'Anziani' WHERE feed_id = ${F}::uuid AND rider_category_id = 'anziano'`);
      await db.execute(sql`INSERT INTO gtfs_rider_categories (feed_id, rider_category_id, rider_category_name) VALUES (${F}::uuid, 'militare', 'Militari')`);
      for (const rotta of ["media/seed", "rider-categories/seed"]) expect((await tariffe.post(`/api/fares/${rotta}?feedId=${F}`).send({})).status).toBe(200);
      const supporti = perChiave(await supportiDelFeed(), "supporto"), categorie = perChiave(await categorieDelFeed(), "categoria");
      expect([supporti.size, categorie.size]).toEqual([7, 8]);
      expect(supporti.get("app_mobile")).toEqual({ supporto: "app_mobile", nome: "App Mobile", tipo: 4, attivo: false });
      expect(categorie.get("anziano").nome).toBe("Over 65 / Argento (fascia morbida)");
      expect(categorie.get("militare").nome).toBe("Militari");
      await db.execute(sql`UPDATE gtfs_fare_media SET is_active = true WHERE feed_id = ${F}::uuid`);
      await db.execute(sql`DELETE FROM gtfs_rider_categories WHERE feed_id = ${F}::uuid AND rider_category_id = 'militare'`);
    });

    it("i nodi dell'azienda nel catalogo del feed: i quattordici di prima; la seconda volta nessuno in più", async () => {
      const r = await nodi.post(`/api/fares/official-nodes/import-catalog?feedId=${F}`).send({});
      expect([r.status, r.body]).toEqual([200, { totalNodes: 14, inserted: 14 }]);
      const elenco = await nodi.get(`/api/fares/official-nodes?feedId=${F}`);
      expect(Array.isArray(elenco.body)).toBe(true);
      const ora = perChiave(elenco.body as any[], "officialCode");
      expect(ora.size).toBe(14);
      for (const n of ELENCHI_DI_PRIMA.nodi) {
        const x = ora.get(n.codice);
        expect([x.officialName, x.centroidLat, x.centroidLon, x.aliases, x.source], n.codice).toEqual([n.nome, n.lat, n.lon, n.alias, "catalogo"]);
      }
      /* un nodo cambiato a mano nel feed resta com'è */
      await db.execute(sql`UPDATE gtfs_fare_official_nodes SET official_name = 'Ancona FS' WHERE feed_id = ${F}::uuid AND official_code = 'ANCONA'`);
      const di_nuovo = await nodi.post(`/api/fares/official-nodes/import-catalog?feedId=${F}`).send({});
      expect(di_nuovo.body).toEqual({ totalNodes: 14, inserted: 0 });
      expect((await db.execute<any>(sql`SELECT official_name FROM gtfs_fare_official_nodes WHERE feed_id = ${F}::uuid AND official_code = 'ANCONA'`)).rows[0].official_name).toBe("Ancona FS");
    });
  });

  describe("il GTFS delle tariffe", () => {
    it("agency.txt è la riga di prima, e ogni linea è dell'agenzia", async () => {
      const g = await gtfs();
      expect(g["agency.txt"]).toBe(ELENCHI_DI_PRIMA.agencyTxt);
      const linee = g["routes.txt"]!.trim().split("\n").slice(1).map(campi);
      expect(linee.map((l) => [l[0], l[1]])).toEqual([["L1", "ATMA"], ["L2", "ATMA"]]);
      /* l'indirizzo della linea se c'è, altrimenti il sito dell'agenzia */
      expect(linee.map((l) => l[5])).toEqual(["https://linee.example/1", "https://www.atmaancona.it"]);
    });

    it("i nomi con la virgola stanno fra virgolette: ogni riga dei supporti ha tre campi, delle categorie quattro", async () => {
      const g = await gtfs();
      const supporti = g["fare_media.txt"]!.trim().split("\n").slice(1).map(campi);
      expect(supporti.length).toBe(7);
      expect(supporti.every((s) => s.length === 3), JSON.stringify(supporti)).toBe(true);
      expect(g["fare_media.txt"]).toContain('tessera_regionale,"Tessera Regionale (€5,00 primo abb.)",1\n');
      expect(g["fare_media.txt"]).toContain("biglietto_cartaceo,Biglietto Cartaceo,1\n");
      expect(supporti[2]).toEqual(["tessera_regionale", "Tessera Regionale (€5,00 primo abb.)", "1"]);
      const categorie = g["rider_categories.txt"]!.trim().split("\n").slice(1).map(campi);
      expect(categorie.length).toBe(7);
      expect(categorie.every((c) => c.length === 4), JSON.stringify(categorie)).toBe(true);
    });

    it("chi pubblica il feed, se il modulo non lo dice: l'agenzia; quello che si scrive nel modulo resta", async () => {
      const a = await tariffe.get("/api/fares/agency");
      expect([a.status, a.body.agency_id, a.body.agency_name, a.body.daAzienda]).toEqual([200, "ATMA", "Atma Scpa", false]);
      const vuoto = await tariffe.post(`/api/fares/feed-info?feedId=${F}`).send({});
      expect([vuoto.status, vuoto.body.feedPublisherName, vuoto.body.feedPublisherUrl]).toEqual([200, "Atma Scpa", "https://www.atmaancona.it"]);
      const scritto = await tariffe.post(`/api/fares/feed-info?feedId=${F}`).send({ feedPublisherName: "Regione", feedPublisherUrl: "https://regione.example" });
      expect([scritto.body.feedPublisherName, scritto.body.feedPublisherUrl]).toEqual(["Regione", "https://regione.example"]);
    });
  });

  describe("l'amministratore", () => {
    it("legge tutto insieme; chi non è amministratore no", async () => {
      const r = await admin.get("/api/admin/elenchi-tariffe");
      expect(r.status).toBe(200);
      expect(r.body.categorie).toEqual(ELENCHI_DI_PRIMA.categorie);
      expect(r.body.supporti).toEqual(ELENCHI_DI_PRIMA.supporti);
      /* i nodi non stanno qui: la loro scheda nella pagina Tariffe è spenta, e non hanno ancora una pagina per cambiarli */
      expect(r.body.nodi).toBeUndefined();
      expect((await admin.put("/api/admin/elenchi-tariffe/nodi").send({ nodi: [] })).status).toBe(404);
      expect(r.body.agenzia).toEqual(AGENZIA_DI_PROVA);
      expect([r.body.inVigore.agency_id, r.body.inVigore.daAzienda, r.body.tipiSupporto.length]).toEqual(["ATMA", false, 5]);
      expect((await utente.get("/api/admin/elenchi-tariffe")).status).toBe(403);
      expect((await utente.put("/api/admin/elenchi-tariffe/supporti").send({ supporti: [] })).status).toBe(403);
      expect((await utente.delete("/api/admin/elenchi-tariffe/agenzia")).status).toBe(403);
    });

    it("le categorie: si rinomina, si aggiunge, si sposta la predefinita e l'ordine è quello dell'elenco", async () => {
      const nuove = [
        { categoria: "studente", nome: "Studente", predefinita: true, url: null },
        { categoria: "ordinario", nome: "Tariffa Ordinaria", predefinita: false, url: "" },
        { categoria: "militare", nome: "Militari e forze dell'ordine", predefinita: false, url: "https://esempio.example/militari" },
      ];
      const r = await admin.put("/api/admin/elenchi-tariffe/categorie").send({ categorie: nuove });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const righe = (await db.execute<any>(sql`SELECT categoria, nome, predefinita, url, ordine FROM categorie_catalogo ORDER BY ordine`)).rows;
      expect(righe).toEqual([
        { categoria: "studente", nome: "Studente", predefinita: true, url: null, ordine: 10 },
        { categoria: "ordinario", nome: "Tariffa Ordinaria", predefinita: false, url: null, ordine: 20 },
        { categoria: "militare", nome: "Militari e forze dell'ordine", predefinita: false, url: "https://esempio.example/militari", ordine: 30 },
      ]);
    });

    it("quello che non va si rifiuta, e l'elenco resta com'era", async () => {
      const prima = (await admin.get("/api/admin/elenchi-tariffe")).body.categorie;
      const prova = async (categorie: unknown) => { const r = await admin.put("/api/admin/elenchi-tariffe/categorie").send({ categorie }); return [r.status, r.body.error]; };
      expect(await prova([{ categoria: "ordinario", nome: "O", predefinita: false, url: null }])).toEqual([400, "Una categoria deve essere quella predefinita: vale per i titoli che non ne dicono un'altra."]);
      expect(await prova([{ categoria: "a1", nome: "A", predefinita: true, url: null }, { categoria: "b1", nome: "B", predefinita: true, url: null }])).toEqual([400, "La categoria predefinita è una sola."]);
      expect(await prova([{ categoria: "a1", nome: "A", predefinita: true, url: null }, { categoria: "a1", nome: "B", predefinita: false, url: null }])).toEqual([400, "La categoria «a1» compare due volte."]);
      expect((await prova([{ categoria: "a1", nome: "A", predefinita: true, url: "ftp://x" }]))[0]).toBe(400);
      expect((await admin.put("/api/admin/elenchi-tariffe/categorie").send({})).status).toBe(400);
      expect((await admin.get("/api/admin/elenchi-tariffe")).body.categorie).toEqual(prima);
    });

    it("una categoria che il catalogo dei titoli usa non si toglie", async () => {
      await db.execute(sql`INSERT INTO titoli_catalogo (titolo, nome, rete, tipo, categoria, prezzo) VALUES (${TITOLO}, 'Mensile studenti', 'extraurbano', 'abbonamento_mensile', 'studente', 30)`);
      const senza = [{ categoria: "ordinario", nome: "Tariffa Ordinaria", predefinita: true, url: null }];
      const r = await admin.put("/api/admin/elenchi-tariffe/categorie").send({ categorie: senza });
      expect([r.status, r.body.error]).toEqual([409, "La categoria «studente» è di un titolo del catalogo: prima cambia la categoria di quei titoli."]);
      expect((await admin.get("/api/admin/elenchi-tariffe")).body.categorie.length).toBe(3);
      await db.execute(sql`DELETE FROM titoli_catalogo WHERE titolo = ${TITOLO}`);
      expect((await admin.put("/api/admin/elenchi-tariffe/categorie").send({ categorie: senza })).status).toBe(200);
      expect((await admin.get("/api/admin/elenchi-tariffe")).body.categorie).toEqual(senza);
    });

    it("i supporti: l'elenco intero, nell'ordine in cui si scrive", async () => {
      const supporti = [{ supporto: "app_mobile", nome: "Applicazione", tipo: 4 }, { supporto: "contanti", nome: "A bordo, in contanti", tipo: 0 }];
      const s = await admin.put("/api/admin/elenchi-tariffe/supporti").send({ supporti });
      expect([s.status, s.body.supporti]).toEqual([200, supporti]);
      expect((await admin.get("/api/admin/elenchi-tariffe")).body.supporti).toEqual(supporti);
      const doppio = await admin.put("/api/admin/elenchi-tariffe/supporti").send({ supporti: [supporti[0], supporti[0]] });
      expect([doppio.status, doppio.body.error]).toEqual([400, "Il supporto «app_mobile» compare due volte."]);
      expect((await admin.get("/api/admin/elenchi-tariffe")).body.supporti).toEqual(supporti);
    });

    it("l'agenzia: si cambia, e tolta figura l'azienda, anche nel GTFS", async () => {
      const altra = { agencyId: "CONS", nome: "Consorzio di prova", sito: "https://cons.example", telefono: "", email: null, tariffeUrl: "" };
      const r = await admin.put("/api/admin/elenchi-tariffe/agenzia").send(altra);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.agenzia).toEqual({ agencyId: "CONS", nome: "Consorzio di prova", sito: "https://cons.example", telefono: null, email: null, tariffeUrl: null });
      expect([r.body.inVigore.agency_id, r.body.inVigore.daAzienda]).toEqual(["CONS", false]);
      expect((await gtfs())["agency.txt"]!.split("\n")[1]).toBe('"CONS","Consorzio di prova","https://cons.example","Europe/Rome","it","","",""');
      expect((await admin.put("/api/admin/elenchi-tariffe/agenzia").send({ ...altra, sito: "cons.example" })).status).toBe(400);

      const tolta = await admin.delete("/api/admin/elenchi-tariffe/agenzia");
      expect([tolta.status, tolta.body.agenzia, tolta.body.inVigore.daAzienda]).toEqual([200, null, true]);
      expect((await db.execute<any>(sql`SELECT count(*)::int AS n FROM agenzia_gtfs`)).rows[0].n).toBe(0);
      const azienda = agenziaNelGtfs(await leggiAzienda(), null);
      const g = await gtfs();
      expect(g["agency.txt"]).toBe(agencyTxt(azienda));
      expect(g["routes.txt"]!.trim().split("\n").slice(1).map((l) => campi(l)[1])).toEqual([azienda.agency_id, azienda.agency_id]);
      expect((await tariffe.get("/api/fares/agency")).body).toEqual(azienda);
    });
  });
});
