/**
 * I gestori (tappa 6.11, migrazione 0044), su un database vero
 * (TEST_DATABASE_URL; in CI come cerbero_app).
 *
 * L'amministratore tiene l'elenco dei gestori; chi lavora su un programma
 * assegna a ogni linea il suo, anche a molte insieme; i due GTFS (quello
 * delle tariffe e quello consegnabile di Planning Studio) scrivono
 * un'agenzia per gestore e a ogni linea la sua. Con un gestore solo
 * agency.txt è quello di prima.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import AdmZip from "adm-zip";
import { db, pool } from "@workspace/db";
import { sql } from "drizzle-orm";
import adminRouter from "../routes/admin";
import faresRouter from "../routes/fares";
import pianificazione from "../lib/planning-studio";
import { costruisciGtfs } from "../lib/planning-studio-export";
import { leggiAzienda } from "../lib/azienda";
import { agencyTxt, agenziaDellAzienda } from "../lib/gestori";
import { gestoriDalDatabase } from "../lib/gestori-store";
import { cancellaProgetto } from "../lib/progetto-copie";
import { appDiProva, utenteDiProva } from "./helpers/app-di-prova";
import { ELENCHI_DI_PRIMA } from "./helpers/elenchi-di-prova";
import { CONSORZIATI, GESTORE_DI_PRIMA, gestoriDiProvaNelDatabase } from "./helpers/gestori-di-prova";

const u = (n: number) => `e6b00000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [PIAN, LETT, ALTRO] = [u(1), u(2), u(3)];
const ADMIN = utenteDiProva(u(9), [], "admin");
const admin = request(appDiProva(adminRouter, ADMIN));
const utente = request(appDiProva(adminRouter, utenteDiProva(PIAN, [], "user", { ruoli: ["pianificatore"] })));
const tariffe = request(appDiProva(faresRouter, ADMIN));
const pian = request(appDiProva(pianificazione, utenteDiProva(PIAN, [], "user", { ruoli: ["pianificatore"] })));
const lett = request(appDiProva(pianificazione, utenteDiProva(LETT, [], "user", { ruoli: ["pianificatore"] })));
const altro = request(appDiProva(pianificazione, utenteDiProva(ALTRO, [], "user", { ruoli: ["pianificatore"] })));
const [P, Q] = [u(10), u(11)];                        // il programma, e un altro programma
const [L1, L2, L3, L4, LQ] = [u(31), u(32), u(33), u(34), u(35)];
const F = u(40);                                      // un feed delle tariffe

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
/** Il GTFS delle tariffe, aperto: nome del file → testo. */
const gtfsTariffe = async (): Promise<Record<string, string>> => {
  const r = await tariffe.get(`/api/fares/export-zip?feedId=${F}`).buffer(true)
    .parse((res, fine) => { const pezzi: Buffer[] = []; res.on("data", (p: Buffer) => pezzi.push(p)); res.on("end", () => fine(null, Buffer.concat(pezzi))); });
  expect(r.status).toBe(200);
  return Object.fromEntries(new AdmZip(r.body as Buffer).getEntries().map((e) => [e.entryName, e.getData().toString("utf8")]));
};
/** Il GTFS consegnabile del programma, coi gestori che ci sono ora nel database. */
const gtfsDelProgramma = async () => {
  const p = (await db.execute<any>(sql`SELECT * FROM ps_projects WHERE id = ${P}::uuid`)).rows[0];
  return costruisciGtfs(P, p, await leggiAzienda(), "bozza", await gestoriDalDatabase());
};
const detti = async () => Object.fromEntries((await db.execute<any>(sql`
  SELECT short_name, agency_id FROM ps_routes WHERE project_id IN (${P}::uuid, ${Q}::uuid) ORDER BY short_name`)).rows.map((r) => [r.short_name, r.agency_id]));

describe.runIf(!!process.env.TEST_DATABASE_URL)("i gestori, sul database", () => {
  let rimetti: () => Promise<void>;

  const pulisci = async () => {
    for (const p of [P, Q]) {
      const c = await db.execute<any>(sql`SELECT id FROM ps_projects WHERE id = ${p}::uuid`);
      if (c.rows.length) await db.transaction((tx) => cancellaProgetto(tx, p));
    }
    await db.execute(sql`DELETE FROM gtfs_routes WHERE feed_id = ${F}::uuid`);
    await db.execute(sql`DELETE FROM gtfs_feed_info WHERE feed_id = ${F}::uuid`);
    await db.execute(sql`DELETE FROM gtfs_feeds WHERE id = ${F}::uuid`);
    await db.execute(sql`DELETE FROM users WHERE id IN (${PIAN}::uuid, ${LETT}::uuid, ${ALTRO}::uuid)`);
  };

  beforeAll(async () => {
    await pulisci();
    rimetti = await gestoriDiProvaNelDatabase([]);
    await db.execute(sql`INSERT INTO users (id, email, password_hash, role) VALUES
      (${PIAN}::uuid, 'gestori-pian@prova.local', 'x', 'user'), (${LETT}::uuid, 'gestori-lett@prova.local', 'x', 'user'),
      (${ALTRO}::uuid, 'gestori-altro@prova.local', 'x', 'user')`);
    await db.execute(sql`INSERT INTO ps_projects (id, owner_user_id, name, agency_name) VALUES
      (${P}::uuid, ${PIAN}::uuid, 'Gestori di prova 6.11', 'Azienda di prova'), (${Q}::uuid, ${PIAN}::uuid, 'Gestori di prova 6.11 (altro)', 'Azienda di prova')`);
    await db.execute(sql`INSERT INTO ps_project_members (project_id, user_id, role) VALUES (${P}::uuid, ${LETT}::uuid, 'viewer')`);
    /* quattro linee: tutte dicono l'agenzia del GTFS da cui vengono, tranne una che non dice niente */
    await db.execute(sql`INSERT INTO ps_routes (id, project_id, short_name, long_name, agency_id, sort_order) VALUES
      (${L1}::uuid, ${P}::uuid, '1', 'Stazione - Centro', 'ATMA', 1), (${L2}::uuid, ${P}::uuid, '2', 'Centro - Ospedale', 'ATMA', 2),
      (${L3}::uuid, ${P}::uuid, '3', 'Porto - Università', 'ATMA', 3), (${L4}::uuid, ${P}::uuid, '4', 'Circolare', NULL, 4),
      (${LQ}::uuid, ${Q}::uuid, '9', 'Linea di un altro programma', 'ATMA', 1)`);
    await db.execute(sql`INSERT INTO gtfs_feeds (id, filename, is_active) VALUES (${F}::uuid, 'gestori-6.11.synthetic', false)`);
    await db.execute(sql`
      INSERT INTO gtfs_routes (feed_id, route_id, agency_id, route_short_name, route_long_name, route_type, route_url)
      VALUES (${F}::uuid, 'L1', 'ATMA', '1', 'Stazione - Centro', 3, NULL), (${F}::uuid, 'L2', 'DUE', '2', 'Centro - Ospedale', 3, 'https://linee.example/2'),
             (${F}::uuid, 'L3', 'TRE', '3', 'Porto - Università', 3, NULL), (${F}::uuid, 'L4', NULL, '4', 'Circolare', 3, NULL)`);
  });

  afterAll(async () => {
    await pulisci();
    await rimetti();
    await pool.end();
  });

  describe("senza gestori vale l'azienda, come prima", () => {
    it("l'elenco è vuoto e dice chi figura", async () => {
      const r = await admin.get("/api/admin/gestori");
      expect(r.status).toBe(200);
      expect([r.body.gestori, r.body.lineeSenzaGestore, r.body.massimo]).toEqual([[], 0, 60]);
      expect(r.body.azienda).toEqual(agenziaDellAzienda(await leggiAzienda()));
    });

    it("i due GTFS hanno una sola agenzia, l'azienda, e ogni linea è sua", async () => {
      const azienda = agenziaDellAzienda(await leggiAzienda());
      const g = await gtfsTariffe();
      expect(g["agency.txt"]).toBe(agencyTxt([azienda]));
      expect(g["routes.txt"]!.trim().split("\n").slice(1).map((l) => campi(l)[1])).toEqual(Array(4).fill(azienda.agency_id));
      const c = await gtfsDelProgramma();
      expect(c["agency.txt"]!.righe.length).toBe(1);
      expect(new Set(c["routes.txt"]!.righe.map((r: any) => r.agency_id))).toEqual(new Set([c["agency.txt"]!.righe[0]!.agency_id]));
    });

    it("una linea non si può assegnare a un gestore che non c'è", async () => {
      const r = await pian.put(`/api/planning-studio/projects/${P}/gestori`).send({ gestore: "UNO", linee: [L1] });
      expect([r.status, r.body.error]).toEqual([400, "Non ci sono gestori: li scrive l'amministratore in Amministrazione › Azienda."]);
    });
  });

  describe("l'amministratore tiene l'elenco", () => {
    const corpo = (g: (typeof CONSORZIATI)[number]) => ({ gestore: g.gestore, nome: g.nome, sito: g.sito, telefono: g.telefono, email: g.email, tariffeUrl: g.tariffeUrl });

    it("il primo gestore è il predefinito, gli altri no; l'ordine è quello in cui si aggiungono", async () => {
      const primo = await admin.post("/api/admin/gestori").send(corpo(GESTORE_DI_PRIMA));
      expect([primo.status, primo.body.gestore]).toEqual([201, GESTORE_DI_PRIMA]);
      for (const g of CONSORZIATI) {
        const r = await admin.post("/api/admin/gestori").send(corpo(g));
        expect([r.status, r.body.gestore], g.gestore).toEqual([201, { ...g, predefinito: false }]);
      }
      const elenco = (await admin.get("/api/admin/gestori")).body;
      expect(elenco.gestori.map((g: any) => [g.gestore, g.predefinito])).toEqual([["ATMA", true], ["UNO", false], ["DUE", false], ["TRE", false]]);
    });

    it("dice quante linee dei programmi ha ogni gestore, e quante non ne dicono uno dell'elenco", async () => {
      const elenco = (await admin.get("/api/admin/gestori")).body;
      const mie = (g: string) => elenco.gestori.find((x: any) => x.gestore === g).linee;
      /* le linee di prova: quattro dicono ATMA (tre del programma, una dell'altro), una niente */
      const altrove = await db.execute<any>(sql`
        SELECT count(*) FILTER (WHERE r.agency_id = 'ATMA')::int AS atma,
               count(*) FILTER (WHERE r.agency_id IS NULL OR r.agency_id NOT IN ('ATMA', 'UNO', 'DUE', 'TRE'))::int AS senza
          FROM ps_routes r JOIN ps_projects p ON p.id = r.project_id
         WHERE p.versione_di IS NULL AND r.project_id NOT IN (${P}::uuid, ${Q}::uuid)`);
      expect([mie("ATMA"), mie("UNO"), elenco.lineeSenzaGestore]).toEqual([4 + altrove.rows[0].atma, 0, 1 + altrove.rows[0].senza]);
    });

    it("quello che non va si rifiuta", async () => {
      expect((await admin.post("/api/admin/gestori").send(corpo(CONSORZIATI[0]!))).status).toBe(409);
      const r = await admin.post("/api/admin/gestori").send({ ...corpo(CONSORZIATI[0]!), gestore: "QUATTRO", sito: "quattro.example" });
      expect([r.status, r.body.error]).toEqual([400, "l'indirizzo comincia con http:// o https://, senza spazi né virgole"]);
      expect((await admin.put("/api/admin/gestori/NESSUNO").send({ nome: "X" })).status).toBe(404);
      expect((await admin.put("/api/admin/gestori/UNO").send({ gestore: "ALTRO" })).status).toBe(400);
      expect((await admin.put("/api/admin/gestori/UNO").send({ predefinito: false })).status).toBe(400);
      expect((await admin.delete("/api/admin/gestori/NESSUNO")).status).toBe(404);
      for (const r of [await utente.get("/api/admin/gestori"), await utente.post("/api/admin/gestori").send(corpo(CONSORZIATI[0]!)),
        await utente.put("/api/admin/gestori/UNO").send({ nome: "X" }), await utente.delete("/api/admin/gestori/UNO")]) expect(r.status).toBe(403);
      expect((await admin.get("/api/admin/gestori")).body.gestori.length).toBe(4);
    });

    it("si cambia tutto tranne l'identificativo; i facoltativi si svuotano", async () => {
      const r = await admin.put("/api/admin/gestori/DUE").send({ nome: "Due Bus", telefono: "071 000002", tariffeUrl: "" });
      expect([r.status, r.body.gestore]).toEqual([200, { ...CONSORZIATI[1], nome: "Due Bus", telefono: "071 000002", tariffeUrl: null, predefinito: false }]);
      const torna = await admin.put("/api/admin/gestori/DUE").send({ nome: CONSORZIATI[1]!.nome, telefono: null, tariffeUrl: CONSORZIATI[1]!.tariffeUrl });
      expect(torna.body.gestore).toEqual({ ...CONSORZIATI[1], predefinito: false });
    });
  });

  describe("le linee di un programma", () => {
    it("ognuna col gestore che vale: il suo, o il predefinito se non ne dice uno dell'elenco", async () => {
      const r = await pian.get(`/api/planning-studio/projects/${P}/gestori`);
      expect(r.status).toBe(200);
      expect(r.body.puoScrivere).toBe(true);
      expect(r.body.gestori).toEqual([
        { gestore: "ATMA", nome: "Atma Scpa", predefinito: true }, { gestore: "UNO", nome: "Autolinee Uno S.p.A.", predefinito: false },
        { gestore: "DUE", nome: "Due, Bus & Co.", predefinito: false }, { gestore: "TRE", nome: "Tre Trasporti", predefinito: false },
      ]);
      expect(r.body.linee).toEqual([
        { id: L1, shortName: "1", longName: "Stazione - Centro", detto: "ATMA", gestore: "ATMA", assegnato: true },
        { id: L2, shortName: "2", longName: "Centro - Ospedale", detto: "ATMA", gestore: "ATMA", assegnato: true },
        { id: L3, shortName: "3", longName: "Porto - Università", detto: "ATMA", gestore: "ATMA", assegnato: true },
        { id: L4, shortName: "4", longName: "Circolare", detto: null, gestore: "ATMA", assegnato: false },
      ]);
    });

    it("molte linee insieme; quelle di un altro programma non si toccano, e quelle che l'hanno già nemmeno", async () => {
      const r = await pian.put(`/api/planning-studio/projects/${P}/gestori`).send({ gestore: "DUE", linee: [L2, L3, LQ] });
      expect([r.status, r.body]).toEqual([200, { cambiate: 2, gestore: "DUE" }]);
      expect(await detti()).toEqual({ "1": "ATMA", "2": "DUE", "3": "DUE", "4": null, "9": "ATMA" });
      const di_nuovo = await pian.put(`/api/planning-studio/projects/${P}/gestori`).send({ gestore: "DUE", linee: [L2, L3] });
      expect(di_nuovo.body).toEqual({ cambiate: 0, gestore: "DUE" });
      expect((await pian.put(`/api/planning-studio/projects/${P}/gestori`).send({ gestore: "TRE", linee: [L3] })).body.cambiate).toBe(1);
      expect((await pian.put(`/api/planning-studio/projects/${P}/gestori`).send({ gestore: "UNO", linee: [L4] })).body.cambiate).toBe(1);
      expect(await detti()).toEqual({ "1": "ATMA", "2": "DUE", "3": "TRE", "4": "UNO", "9": "ATMA" });
      const registro = await db.execute<any>(sql`
        SELECT payload FROM ps_project_activity_log WHERE project_id = ${P}::uuid AND action = 'ps.route.gestore' ORDER BY at, id`);
      expect(registro.rows.map((x) => [x.payload.gestore, x.payload.linee])).toEqual([["DUE", 2], ["TRE", 1], ["UNO", 1]]);
    });

    it("solo chi può scrivere sul programma, e solo verso un gestore dell'elenco", async () => {
      const letto = await lett.get(`/api/planning-studio/projects/${P}/gestori`);
      expect([letto.status, letto.body.puoScrivere, letto.body.linee.length]).toEqual([200, false, 4]);
      expect((await lett.put(`/api/planning-studio/projects/${P}/gestori`).send({ gestore: "UNO", linee: [L1] })).status).toBe(403);
      expect((await altro.get(`/api/planning-studio/projects/${P}/gestori`)).status).toBe(404);
      expect((await altro.put(`/api/planning-studio/projects/${P}/gestori`).send({ gestore: "UNO", linee: [L1] })).status).toBe(404);
      const r = await pian.put(`/api/planning-studio/projects/${P}/gestori`).send({ gestore: "QUATTRO", linee: [L1] });
      expect([r.status, r.body.error]).toEqual([400, "«QUATTRO» non è fra i gestori: lo aggiunge l'amministratore in Amministrazione › Azienda."]);
      expect((await pian.put(`/api/planning-studio/projects/${P}/gestori`).send({ gestore: "UNO", linee: [] })).status).toBe(400);
      expect((await pian.put(`/api/planning-studio/projects/${P}/gestori`).send({ gestore: "UNO", linee: ["x"] })).status).toBe(400);
      expect(await detti()).toEqual({ "1": "ATMA", "2": "DUE", "3": "TRE", "4": "UNO", "9": "ATMA" });
    });
  });

  describe("i due GTFS", () => {
    it("il consegnabile del programma: un'agenzia per gestore che ha linee, e a ogni linea la sua", async () => {
      const g = await gtfsDelProgramma();
      expect(g["agency.txt"]!.righe.map((a: any) => [a.agency_id, a.agency_name, a.agency_url, a.agency_phone])).toEqual([
        ["ATMA", "Atma Scpa", "https://www.atmaancona.it", "0712837468"], ["UNO", "Autolinee Uno S.p.A.", "https://uno.example", "071 000001"],
        ["DUE", "Due, Bus & Co.", "https://due.example", ""], ["TRE", "Tre Trasporti", "https://tre.example", ""],
      ]);
      expect(g["routes.txt"]!.righe.map((r: any) => [r.route_short_name, r.agency_id])).toEqual([["1", "ATMA"], ["2", "DUE"], ["3", "TRE"], ["4", "UNO"]]);
      /* chi pubblica resta l'azienda dell'installazione, non un gestore */
      const azienda = await leggiAzienda();
      if (azienda.compilata) expect(g["feed_info.txt"]!.righe[0]!.feed_publisher_name).toBe(azienda.ragioneSociale);
    });

    it("quello delle tariffe: lo stesso, e una linea che dice un gestore fuori elenco (o niente) è del predefinito", async () => {
      const g = await gtfsTariffe();
      const agenzie = g["agency.txt"]!.trim().split("\n").slice(1).map(campi);
      expect(agenzie.map((a) => a[0])).toEqual(["ATMA", "DUE", "TRE"]);
      expect(agenzie[1]).toEqual(["DUE", "Due, Bus & Co.", "https://due.example", "Europe/Rome", "it", "", "https://due.example/tariffe", ""]);
      const linee = g["routes.txt"]!.trim().split("\n").slice(1).map(campi);
      expect(linee.map((l) => [l[0], l[1]])).toEqual([["L1", "ATMA"], ["L2", "DUE"], ["L3", "TRE"], ["L4", "ATMA"]]);
      /* l'indirizzo della linea se c'è, altrimenti il sito del suo gestore */
      expect(linee.map((l) => l[5])).toEqual(["https://www.atmaancona.it", "https://linee.example/2", "https://tre.example", "https://www.atmaancona.it"]);
    });

    it("«Feed Info» propone il gestore predefinito; quello che si scrive nel modulo resta", async () => {
      const a = await tariffe.get("/api/fares/agency");
      expect([a.status, a.body.agency_id, a.body.agency_name, a.body.daAzienda]).toEqual([200, "ATMA", "Atma Scpa", false]);
      const vuoto = await tariffe.post(`/api/fares/feed-info?feedId=${F}`).send({});
      expect([vuoto.status, vuoto.body.feedPublisherName, vuoto.body.feedPublisherUrl]).toEqual([200, "Atma Scpa", "https://www.atmaancona.it"]);
      const scritto = await tariffe.post(`/api/fares/feed-info?feedId=${F}`).send({ feedPublisherName: "Regione", feedPublisherUrl: "https://regione.example" });
      expect([scritto.body.feedPublisherName, scritto.body.feedPublisherUrl]).toEqual(["Regione", "https://regione.example"]);
    });
  });

  describe("il predefinito e chi si toglie", () => {
    it("il predefinito si cambia scegliendone un altro: quello di prima lo perde", async () => {
      const r = await admin.put("/api/admin/gestori/UNO").send({ predefinito: true });
      expect([r.status, r.body.gestore.predefinito]).toEqual([200, true]);
      expect((await admin.get("/api/admin/gestori")).body.gestori.map((g: any) => [g.gestore, g.predefinito]))
        .toEqual([["ATMA", false], ["UNO", true], ["DUE", false], ["TRE", false]]);
      expect((await db.execute<any>(sql`SELECT count(*)::int AS n FROM gestori WHERE predefinito`)).rows[0].n).toBe(1);
    });

    it("il predefinito non si toglie finché ce ne sono altri", async () => {
      const r = await admin.delete("/api/admin/gestori/UNO");
      expect([r.status, r.body.error]).toEqual([409, "«Autolinee Uno S.p.A.» è il gestore predefinito: prima scegline un altro come predefinito."]);
    });

    it("tolto un gestore, le sue linee non si toccano: prendono il predefinito, e tornano sue se lo si rimette", async () => {
      const r = await admin.delete("/api/admin/gestori/ATMA");
      expect([r.status, r.body]).toEqual([200, { ok: true, restano: 3 }]);
      expect((await detti())["1"]).toBe("ATMA");
      const linee = (await pian.get(`/api/planning-studio/projects/${P}/gestori`)).body.linee;
      expect(linee[0]).toEqual({ id: L1, shortName: "1", longName: "Stazione - Centro", detto: "ATMA", gestore: "UNO", assegnato: false });
      const g = await gtfsDelProgramma();
      expect(g["agency.txt"]!.righe.map((a: any) => a.agency_id)).toEqual(["UNO", "DUE", "TRE"]);
      expect(g["routes.txt"]!.righe.map((x: any) => x.agency_id)).toEqual(["UNO", "DUE", "TRE", "UNO"]);
      expect((await gtfsTariffe())["routes.txt"]!.trim().split("\n").slice(1).map((l) => campi(l)[1])).toEqual(["UNO", "DUE", "TRE", "UNO"]);
      /* una linea si rimette senza un gestore suo */
      const senza = await pian.put(`/api/planning-studio/projects/${P}/gestori`).send({ gestore: null, linee: [L2] });
      expect(senza.body).toEqual({ cambiate: 1, gestore: null });
      expect((await detti())["2"]).toBeNull();
    });

    it("con un gestore solo, agency.txt delle tariffe è la riga che era nel codice, byte per byte", async () => {
      for (const g of ["DUE", "TRE"]) expect((await admin.delete(`/api/admin/gestori/${g}`)).status).toBe(200);
      const ultimo = await admin.delete("/api/admin/gestori/UNO");       // il predefinito, per ultimo, si toglie
      expect([ultimo.status, ultimo.body.restano]).toEqual([200, 0]);
      const r = await admin.post("/api/admin/gestori").send({ gestore: "ATMA", nome: "Atma Scpa", sito: "https://www.atmaancona.it", telefono: "0712837468",
        email: "info@atmaancona.it", tariffeUrl: "https://www.atmaancona.it/tariffe/tariffe-generale/" });
      expect(r.body.gestore.predefinito).toBe(true);
      const g = await gtfsTariffe();
      expect(g["agency.txt"]).toBe(ELENCHI_DI_PRIMA.agencyTxt);
      expect(g["routes.txt"]!.trim().split("\n").slice(1).map((l) => campi(l)[1])).toEqual(["ATMA", "ATMA", "ATMA", "ATMA"]);
    });
  });
});
