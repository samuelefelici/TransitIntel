/**
 * I dati aperti a un indirizzo stabile (tappa 6.3, migrazione 0037), su un
 * database vero (TEST_DATABASE_URL; in CI come cerbero_app).
 *
 * La pubblicazione nasce spenta; accesa, i due file nascono dalla versione in
 * esercizio (mai dalla bozza), si rifanno solo quando cambia quello da cui
 * nascono, e vanno in linea solo se validi: altrimenti resta l'ultimo buono.
 * Chi scarica riceve i byte pronti, e «non modificato» se li ha già.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import express, { Router } from "express";
import request from "supertest";
import AdmZip from "adm-zip";
import { db, pool } from "@workspace/db";
import { sql } from "drizzle-orm";
import pianificazione from "../lib/planning-studio";
import adminRouter from "../routes/admin";
import datiAperti from "../routes/dati-aperti";
import { dimenticaAzienda } from "../lib/azienda";
import { cancellaProgetto } from "../lib/progetto-copie";
import { preparaDatiAperti, statoDatiAperti, type TipoFile } from "../lib/dati-aperti";
import { giroDatiAperti } from "../lib/lavori/dati-aperti";
import { validaNetex, type EsitoValidazione } from "../lib/netex-validazione";
import { appDiProva, utenteDiProva } from "./helpers/app-di-prova";

const u = (n: number) => `d6300000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [ADMIN, PIAN] = [u(1), u(2)];
const P = u(10);
const [F1, F2, LINEA, PERCORSO, CALENDARIO, CORSA] = [u(30), u(31), u(32), u(33), u(34), u(35)];
const NOME = "Dati aperti di prova 6.3";

const tutte = Router();
tutte.use(pianificazione);
tutte.use(adminRouter);
const admin = request(appDiProva(tutte, utenteDiProva(ADMIN, [], "admin")));
const pian = request(appDiProva(tutte, utenteDiProva(PIAN, [], "user", { ruoli: ["pianificatore"] })));
const fuori = express();
fuori.use("/api", datiAperti);
const pubblico = request(fuori);

const valido = async (): Promise<EsitoValidazione> => ({ stato: "valido", errori: [] });
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const scarica = (percorso: string) => pubblico.get(percorso).buffer(true).parse((res, cb) => {
  const pezzi: Buffer[] = [];
  res.on("data", (c: Buffer) => pezzi.push(c));
  res.on("end", () => cb(null, Buffer.concat(pezzi)));
});
const file = async (tipo: TipoFile) => (await statoDatiAperti()).file.find((f) => f.tipo === tipo)!;
const muto = { info() {}, warn() {}, error() {} };

describe.runIf(!!process.env.TEST_DATABASE_URL)("i dati aperti, sul database", () => {
  const pulisci = async () => {
    const vecchie = await db.execute<any>(sql`SELECT id FROM ps_projects WHERE versione_del_feed IS NOT NULL AND name LIKE ${NOME + "%"}`);
    for (const v of vecchie.rows) await db.transaction((tx) => cancellaProgetto(tx, v.id));
    const p = await db.execute<any>(sql`SELECT id FROM ps_projects WHERE id = ${P}::uuid`);
    if (p.rows.length) await db.transaction((tx) => cancellaProgetto(tx, P));
    const feed = sql`(SELECT id FROM gtfs_feeds WHERE owner_user_id IN (${ADMIN}::uuid, ${PIAN}::uuid))`;
    await db.execute(sql`DELETE FROM ps_activation_log WHERE feed_id IN ${feed}`);
    await db.execute(sql`DELETE FROM gtfs_feeds WHERE id IN ${feed}`);
    await db.execute(sql`DELETE FROM users WHERE id IN (${ADMIN}::uuid, ${PIAN}::uuid)`);
    await db.execute(sql`DELETE FROM dati_aperti`);
  };

  let aziendaDiPrima: any = null;
  /* le tariffe dell'azienda (6.41): il test parte senza, così il NeTEx di livello 3 dice «senza tariffe»; poi una fascia lo fa uscire */
  const TARIFFE = ["contactless_reti", "contactless_tariffe", "contactless", "titoli_catalogo", "fasce_km"] as const;
  const tariffeDiPrima: Record<string, unknown[]> = {};
  let conXmllint = false;
  beforeAll(async () => {
    await pulisci();
    aziendaDiPrima = (await db.execute<any>(sql`SELECT * FROM azienda`)).rows[0] ?? null;
    for (const t of TARIFFE) tariffeDiPrima[t] = (await db.execute<any>(sql`SELECT to_jsonb(x) AS riga FROM ${sql.identifier(t)} x`)).rows.map((r) => r.riga);
    for (const t of TARIFFE) await db.execute(sql`DELETE FROM ${sql.identifier(t)}`);
    await db.execute(sql`DELETE FROM azienda`);
    dimenticaAzienda();
    const altri = (await db.execute<any>(sql`SELECT count(*)::int AS n FROM gtfs_feeds WHERE is_active`)).rows[0].n;
    if (altri > 0) throw new Error("dati-aperti-db.test.ts vuole un database senza un feed in esercizio");
    conXmllint = (await validaNetex("<x/>")).stato !== "senza_xmllint";
    if (process.env.NETEX_SCHEMA_OBBLIGATORIO) expect(conXmllint, "xmllint").toBe(true);
    await db.execute(sql`INSERT INTO users (id, email, password_hash, role) VALUES
      (${ADMIN}::uuid, 'dati-aperti-admin@prova.local', 'x', 'admin'),
      (${PIAN}::uuid, 'dati-aperti-pian@prova.local', 'x', 'user')`);
    await db.execute(sql`INSERT INTO ps_projects (id, owner_user_id, name, agency_name) VALUES (${P}::uuid, ${PIAN}::uuid, ${NOME}, 'Azienda di prova')`);
    await db.execute(sql`INSERT INTO ps_stops (id, project_id, name, lat, lon) VALUES
      (${F1}::uuid, ${P}::uuid, 'Stazione', 43.6075, 13.4977), (${F2}::uuid, ${P}::uuid, 'Torrette', 43.6040, 13.4510)`);
    await db.execute(sql`INSERT INTO ps_routes (id, project_id, short_name, long_name) VALUES (${LINEA}::uuid, ${P}::uuid, '1', 'Stazione - Torrette')`);
    await db.execute(sql`INSERT INTO ps_route_variants (id, project_id, route_id, name) VALUES (${PERCORSO}::uuid, ${P}::uuid, ${LINEA}::uuid, 'Andata')`);
    await db.execute(sql`INSERT INTO ps_variant_stops (variant_id, seq, stop_id) VALUES (${PERCORSO}::uuid, 1, ${F1}::uuid), (${PERCORSO}::uuid, 2, ${F2}::uuid)`);
    await db.execute(sql`INSERT INTO ps_calendars (id, project_id, code, name, monday, tuesday, wednesday, thursday, friday, saturday, sunday, start_date, end_date)
                         VALUES (${CALENDARIO}::uuid, ${P}::uuid, 'FER', 'Feriale', true, true, true, true, true, false, false, '2026-09-14', '2027-06-10')`);
    await db.execute(sql`INSERT INTO ps_trips (id, project_id, route_id, variant_id, calendar_id, headsign) VALUES
      (${CORSA}::uuid, ${P}::uuid, ${LINEA}::uuid, ${PERCORSO}::uuid, ${CALENDARIO}::uuid, 'Torrette')`);
    await db.execute(sql`INSERT INTO ps_stop_times (trip_id, stop_seq, stop_id, arrival_time, departure_time) VALUES
      (${CORSA}::uuid, 1, ${F1}::uuid, '07:00:00', '07:00:00'), (${CORSA}::uuid, 2, ${F2}::uuid, '07:20:00', '07:20:00')`);
  });
  afterAll(async () => {
    await pulisci();
    for (const t of TARIFFE) await db.execute(sql`DELETE FROM ${sql.identifier(t)}`);
    for (const t of [...TARIFFE].reverse()) {
      for (const riga of tariffeDiPrima[t] ?? []) {
        await db.execute(sql`INSERT INTO ${sql.identifier(t)} SELECT * FROM jsonb_populate_record(NULL::${sql.identifier(t)}, ${JSON.stringify(riga)}::jsonb)`);
      }
    }
    await db.execute(sql`DELETE FROM azienda`);
    if (aziendaDiPrima) {
      const a = aziendaDiPrima;
      await db.execute(sql`INSERT INTO azienda (unica, ragione_sociale, nome, sito, telefono, gtfs_agency_id, citta, regione, centro_lat, centro_lng, zoom, aggiornata_il, aggiornata_da,
                                                provincia_istat, netex_codice_locale, netex_fornitore, dati_aperti_attivi)
                           VALUES (true, ${a.ragione_sociale}, ${a.nome}, ${a.sito}, ${a.telefono}, ${a.gtfs_agency_id}, ${a.citta}, ${a.regione}, ${a.centro_lat}, ${a.centro_lng}, ${a.zoom}, ${a.aggiornata_il}, ${a.aggiornata_da},
                                   ${a.provincia_istat}, ${a.netex_codice_locale}, ${a.netex_fornitore}, ${a.dati_aperti_attivi})`);
    }
    dimenticaAzienda();
    await pool.end();
  });

  it("solo l'amministratore; senza i dati dell'azienda non si accende", async () => {
    expect((await pian.get("/api/admin/dati-aperti")).status).toBe(403);
    expect((await pian.put("/api/admin/dati-aperti").send({ attivi: true })).status).toBe(403);
    expect((await pian.post("/api/admin/dati-aperti/prepara")).status).toBe(403);
    const s = await admin.get("/api/admin/dati-aperti");
    expect(s.body).toMatchObject({ attivi: false, aziendaCompilata: false, versione: null });
    expect((await admin.put("/api/admin/dati-aperti").send({ attivi: "sì" })).status).toBe(400);
    const r = await admin.put("/api/admin/dati-aperti").send({ attivi: true });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/dati dell'azienda/);
  });

  it("nasce spento: gli indirizzi non pubblicano niente, e non si prepara niente", async () => {
    await db.execute(sql`INSERT INTO azienda (ragione_sociale, nome, sito, telefono, gtfs_agency_id, citta, centro_lat, centro_lng, zoom)
                         VALUES ('Trasporti di prova S.p.A.', 'Prova', 'https://prova.example', '+39 071 000000', 'prova', 'Ancona', 43.6, 13.5, 10)`);
    dimenticaAzienda();
    expect((await admin.get("/api/admin/dati-aperti")).body).toMatchObject({ attivi: false, aziendaCompilata: true });
    for (const p of ["/api/dati-aperti", "/api/dati-aperti/gtfs.zip"]) expect((await pubblico.get(p)).status, p).toBe(404);
    expect(await preparaDatiAperti({ valida: valido })).toEqual({ stato: "spenti" });
    expect((await admin.post("/api/admin/dati-aperti/prepara")).status).toBe(409);
    expect((await db.execute(sql`SELECT 1 FROM dati_aperti`)).rows).toHaveLength(0);
  });

  it("acceso senza un programma in esercizio: niente file, e il motivo", async () => {
    const r = await admin.put("/api/admin/dati-aperti").send({ attivi: true });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ attivi: true, versione: null });
    expect(r.body.senzaVersione).toMatch(/Nessun programma è in esercizio/);
    expect(await preparaDatiAperti({ valida: valido })).toEqual({ stato: "fatto", file: { gtfs: "senza_versione", netex: "senza_versione", netex_l3: "senza_versione" } });
    expect((await file("gtfs"))).toMatchObject({ inLinea: null, ultimoTentativo: { esito: "senza_versione" } });
    expect((await pubblico.get("/api/dati-aperti/gtfs.zip")).status).toBe(404);
    // un secondo giro non riscrive la stessa cosa
    const prima = (await file("gtfs")).ultimoTentativo!.provatoIl;
    await preparaDatiAperti({ valida: valido, adesso: new Date(Date.now() + 60_000) });
    expect((await file("gtfs")).ultimoTentativo!.provatoIl).toBe(prima);
  });

  let improntaGtfs = "";
  it("in esercizio: il GTFS va in linea; il NeTEx aspetta il codice locale", async () => {
    const a = await pian.post(`/api/planning-studio/projects/${P}/activate`).send({});
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect(await preparaDatiAperti({ valida: valido })).toEqual({ stato: "fatto", file: { gtfs: "pubblicato", netex: "senza_codice", netex_l3: "senza_codice" } });
    const s = await statoDatiAperti();
    expect(s.versione?.nome).toBe(NOME);
    const g = s.file.find((f) => f.tipo === "gtfs")!;
    expect(g.inLinea).toMatchObject({ dellaVersioneInEsercizio: true });
    expect(g.ultimoTentativo).toMatchObject({ esito: "pubblicato", messaggio: null });
    improntaGtfs = g.inLinea!.impronta;
    const n = s.file.find((f) => f.tipo === "netex")!;
    expect(n.inLinea).toBeNull();
    expect(n.ultimoTentativo?.messaggio).toMatch(/codice locale NeTEx/);
    expect((await pubblico.get("/api/dati-aperti/netex.xml.gz")).status).toBe(404);
  });

  it("chi scarica riceve i byte pronti, con l'impronta; chi li ha già, «non modificato»", async () => {
    const r = await scarica("/api/dati-aperti/gtfs.zip");
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toBe("application/zip");
    expect(r.headers["content-disposition"]).toBe('attachment; filename="gtfs.zip"');
    expect(r.headers.etag).toBe(`"${improntaGtfs}"`);
    expect(sha256(r.body)).toBe(improntaGtfs);
    expect(Number(r.headers["content-length"])).toBe(r.body.length);
    const zip = new AdmZip(r.body);
    expect(zip.readAsText("agency.txt")).toContain("prova,Trasporti di prova S.p.A.,https://prova.example");
    expect(zip.readAsText("feed_info.txt")).toContain("esercizio-");
    expect(zip.readAsText("stop_times.txt")).toContain("07:00:00");
    // If-None-Match, anche fra altri valori e in forma debole
    for (const v of [`"${improntaGtfs}"`, `"altro", W/"${improntaGtfs}"`, "*"]) {
      const c = await pubblico.get("/api/dati-aperti/gtfs.zip").set("If-None-Match", v);
      expect(c.status, v).toBe(304);
      expect(c.text ?? "").toBe("");
      expect(c.headers.etag).toBe(`"${improntaGtfs}"`);
    }
    expect((await pubblico.get("/api/dati-aperti/gtfs.zip").set("If-None-Match", '"un-altro"')).status).toBe(200);
    // If-Modified-Since
    expect((await pubblico.get("/api/dati-aperti/gtfs.zip").set("If-Modified-Since", new Date(Date.now() + 3600_000).toUTCString())).status).toBe(304);
    expect((await pubblico.get("/api/dati-aperti/gtfs.zip").set("If-Modified-Since", "Mon, 01 Jan 2024 00:00:00 GMT")).status).toBe(200);
    // HEAD: le intestazioni, senza i byte
    const h = await pubblico.head("/api/dati-aperti/gtfs.zip");
    expect(h.status).toBe(200);
    expect(Number(h.headers["content-length"])).toBe(r.body.length);
    // l'elenco
    const e = await pubblico.get("/api/dati-aperti");
    expect(e.status).toBe(200);
    expect(e.body.azienda).toBe("Trasporti di prova S.p.A.");
    expect(e.body.file).toHaveLength(1);
    expect(e.body.file[0]).toMatchObject({ tipo: "gtfs", percorso: "/api/dati-aperti/gtfs.zip", sha256: improntaGtfs, byte: r.body.length });
    expect(JSON.stringify(e.body)).not.toMatch(/esito|messaggio|errori/);
  });

  let improntaNetex = "";
  it("col codice locale esce anche il NeTEx; il GTFS, che non cambia, resta quello", async () => {
    await db.execute(sql`UPDATE azienda SET netex_codice_locale = 'ITI3'`);
    expect(await preparaDatiAperti({ valida: valido })).toEqual({ stato: "fatto", file: { gtfs: "invariato", netex: "pubblicato", netex_l3: "senza_tariffe" } });
    expect((await file("gtfs")).inLinea!.impronta).toBe(improntaGtfs);
    const r = await scarica("/api/dati-aperti/netex.xml.gz");
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toBe("application/gzip");
    improntaNetex = sha256(r.body);
    expect(r.headers.etag).toBe(`"${improntaNetex}"`);
    const xml = gunzipSync(r.body).toString("utf8");
    expect(xml).toContain("IT:ITI3:Line:");
    expect(xml).toContain("Trasporti di prova S.p.A.");
    if (conXmllint) expect(await validaNetex(xml)).toEqual({ stato: "valido", errori: [] });
    expect((await pubblico.get("/api/dati-aperti")).body.file.map((f: any) => f.tipo)).toEqual(["gtfs", "netex"]);
    // niente da fare: due letture, nessun file riscritto
    expect(await preparaDatiAperti({ valida: valido })).toEqual({ stato: "fatto", file: { gtfs: "invariato", netex: "invariato", netex_l3: "invariato" } });
  });

  it("una modifica di bozza non arriva ai file pubblicati", async () => {
    await db.execute(sql`UPDATE ps_stop_times SET departure_time = '09' || substr(departure_time, 3), arrival_time = '09' || substr(arrival_time, 3) WHERE trip_id = ${CORSA}::uuid`);
    expect(await preparaDatiAperti({ valida: valido })).toEqual({ stato: "fatto", file: { gtfs: "invariato", netex: "invariato", netex_l3: "invariato" } });
    const r = await scarica("/api/dati-aperti/gtfs.zip");
    expect(sha256(r.body)).toBe(improntaGtfs);
    expect(new AdmZip(r.body).readAsText("stop_times.txt")).not.toContain("09:00:00");
  });

  it("un dato dell'azienda che finisce nei file li fa rifare", async () => {
    await db.execute(sql`UPDATE azienda SET telefono = '+39 071 111111'`);
    expect(await preparaDatiAperti({ valida: valido })).toEqual({ stato: "fatto", file: { gtfs: "pubblicato", netex: "pubblicato", netex_l3: "senza_tariffe" } });
    const nuova = (await file("gtfs")).inLinea!.impronta;
    expect(nuova).not.toBe(improntaGtfs);
    // chi aveva il file di prima riceve quello nuovo
    const r = await scarica("/api/dati-aperti/gtfs.zip").set("If-None-Match", `"${improntaGtfs}"`);
    expect(r.status).toBe(200);
    expect(new AdmZip(r.body).readAsText("agency.txt")).toContain("+39 071 111111");
    improntaGtfs = nuova;
    improntaNetex = (await file("netex")).inLinea!.impronta;
  });

  it("un NeTEx che non passa lo schema non va in linea: resta l'ultimo buono, col motivo", async () => {
    await db.execute(sql`UPDATE azienda SET netex_fornitore = 'PROVA'`);
    const rotto = async (): Promise<EsitoValidazione> => ({ stato: "non_valido", errori: ["netex.xml:12: element Line: Schemas validity error"] });
    expect(await preparaDatiAperti({ valida: rotto })).toEqual({ stato: "fatto", file: { gtfs: "invariato", netex: "non_valido", netex_l3: "senza_tariffe" } });
    const n = await file("netex");
    expect(n.inLinea!.impronta).toBe(improntaNetex);
    expect(n.ultimoTentativo).toMatchObject({ esito: "non_valido", dettagli: { errori: [expect.stringContaining("Schemas validity error")] } });
    expect(sha256((await scarica("/api/dati-aperti/netex.xml.gz")).body)).toBe(improntaNetex);
    // con gli stessi dati darebbe lo stesso esito: non si riprova da solo
    let chiamate = 0;
    const conta = async (): Promise<EsitoValidazione> => { chiamate++; return { stato: "valido", errori: [] }; };
    expect(await preparaDatiAperti({ valida: conta })).toEqual({ stato: "fatto", file: { gtfs: "invariato", netex: "invariato", netex_l3: "invariato" } });
    expect(chiamate).toBe(0);
    // senza il controllo dello schema non si pubblica; un guasto si riprova dopo un'ora
    const senza = async (): Promise<EsitoValidazione> => ({ stato: "senza_xmllint", errori: [] });
    const t0 = new Date();
    expect((await preparaDatiAperti({ valida: senza, forza: true, adesso: t0 })).stato).toBe("fatto");
    expect(await file("netex")).toMatchObject({ inLinea: { impronta: improntaNetex }, ultimoTentativo: { esito: "senza_xmllint" } });
    expect(await preparaDatiAperti({ valida: conta, adesso: new Date(t0.getTime() + 59 * 60_000) })).toMatchObject({ file: { netex: "invariato" } });
    expect(await preparaDatiAperti({ valida: conta, adesso: new Date(t0.getTime() + 61 * 60_000) })).toMatchObject({ file: { netex: "pubblicato" } });
    expect(chiamate).toBe(1);
    improntaNetex = (await file("netex")).inLinea!.impronta;
    // lo stesso GTFS rifatto dà gli stessi byte: chi lo ha già non lo riscarica
    expect((await file("gtfs")).inLinea!.impronta).toBe(improntaGtfs);
    expect(gunzipSync((await scarica("/api/dati-aperti/netex.xml.gz")).body).toString("utf8")).toMatch(/IT:ITI3:Line:[^"]+:PROVA"/);
  });

  it("un GTFS con errori non va in linea, e nemmeno il NeTEx che ne nascerebbe", async () => {
    await db.execute(sql`UPDATE azienda SET sito = NULL`);
    expect(await preparaDatiAperti({ valida: valido })).toEqual({ stato: "fatto", file: { gtfs: "gtfs_con_errori", netex: "gtfs_con_errori", netex_l3: "gtfs_con_errori" } });
    const g = await file("gtfs");
    expect(g.inLinea!.impronta).toBe(improntaGtfs);
    expect(g.ultimoTentativo!.messaggio).toMatch(/manca il sito dell'azienda/);
    expect((await file("netex")).inLinea!.impronta).toBe(improntaNetex);
    expect((await pubblico.get("/api/dati-aperti/gtfs.zip").set("If-None-Match", `"${improntaGtfs}"`)).status).toBe(304);
    await db.execute(sql`UPDATE azienda SET sito = 'https://prova.example'`);
  });

  it("«Prepara adesso» rifà i file; uno alla volta", async () => {
    const r = await admin.post("/api/admin/dati-aperti/prepara");
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.preparazione).toEqual({ gtfs: "pubblicato", netex: conXmllint ? "pubblicato" : "senza_xmllint", netex_l3: "senza_tariffe" });
    expect(r.body.file.find((f: any) => f.tipo === "gtfs").ultimoTentativo.esito).toBe("pubblicato");
    improntaGtfs = (await file("gtfs")).inLinea!.impronta;
    // un altro sta preparando
    const altro = await pool.connect();
    try {
      await altro.query("SELECT pg_catalog.pg_advisory_lock(pg_catalog.hashtext('cerbero:dati-aperti'))");
      expect(await preparaDatiAperti({ valida: valido })).toEqual({ stato: "occupato" });
      expect((await admin.post("/api/admin/dati-aperti/prepara")).status).toBe(409);
    } finally {
      await altro.query("SELECT pg_catalog.pg_advisory_unlock(pg_catalog.hashtext('cerbero:dati-aperti'))");
      altro.release();
    }
  });

  it("con le tariffe esce anche il NeTEx di livello 3, al suo indirizzo; quello di livello 1 non cambia (tappa 6.41)", async () => {
    const livello1 = (await file("netex")).inLinea!.impronta;
    expect(await file("netex_l3")).toMatchObject({ inLinea: null, ultimoTentativo: { esito: "senza_tariffe", messaggio: expect.stringMatching(/non ha tariffe/) } });
    expect((await pubblico.get("/api/dati-aperti/netex-l3.xml.gz")).status).toBe(404);
    await db.execute(sql`INSERT INTO fasce_km (fascia, km_da, km_a, prezzo) VALUES (1, 0, 50, 1.50)`);
    expect(await preparaDatiAperti({ valida: valido })).toEqual({ stato: "fatto", file: { gtfs: "pubblicato", netex: "invariato", netex_l3: "pubblicato" } });
    expect((await file("netex")).inLinea!.impronta).toBe(livello1);
    const r = await scarica("/api/dati-aperti/netex-l3.xml.gz");
    expect(r.status).toBe(200);
    expect(r.headers["content-disposition"]).toBe('attachment; filename="netex-l3.xml.gz"');
    const xml = gunzipSync(r.body).toString("utf8");
    expect(xml).toContain("<FareFrame ");
    expect(xml).toContain("livello 3 (con le tariffe)");
    expect(xml).toContain("<UicOperatingPeriod ");
    if (conXmllint) expect(await validaNetex(xml)).toEqual({ stato: "valido", errori: [] });
    expect((await pubblico.get("/api/dati-aperti")).body.file.map((f: any) => f.tipo)).toEqual(["gtfs", "netex", "netex_l3"]);
    expect(await file("netex_l3")).toMatchObject({ formato: "NeTEx, profilo italiano livello 3 (con le tariffe)", percorso: "/api/dati-aperti/netex-l3.xml.gz" });
    improntaGtfs = (await file("gtfs")).inLinea!.impronta;
  });

  it("spento: gli indirizzi tacciono; riacceso, i file sono ancora lì", async () => {
    expect((await admin.put("/api/admin/dati-aperti").send({ attivi: false })).body.attivi).toBe(false);
    for (const p of ["/api/dati-aperti", "/api/dati-aperti/netex.xml.gz"]) expect((await pubblico.get(p)).status, p).toBe(404);
    expect(await giroDatiAperti(muto)).toEqual({ stato: "spenti" });
    await admin.put("/api/admin/dati-aperti").send({ attivi: true });
    expect((await pubblico.get("/api/dati-aperti/gtfs.zip").set("If-None-Match", `"${improntaGtfs}"`)).status).toBe(304);
  });

  it("senza più un programma in esercizio i file si tolgono", async () => {
    await db.transaction(async (tx) => {
      await tx.execute(sql`UPDATE ps_activation_log SET deactivated_at = now() WHERE deactivated_at IS NULL`);
      await tx.execute(sql`UPDATE gtfs_feeds SET is_active = false, is_default = false WHERE is_active`);
    });
    expect(await giroDatiAperti(muto)).toEqual({ stato: "fatto", file: { gtfs: "senza_versione", netex: "senza_versione", netex_l3: "senza_versione" } });
    expect(await file("gtfs")).toMatchObject({ inLinea: null, ultimoTentativo: { esito: "senza_versione" } });
    for (const p of ["/api/dati-aperti", "/api/dati-aperti/gtfs.zip", "/api/dati-aperti/netex.xml.gz"]) expect((await pubblico.get(p)).status, p).toBe(404);
    /* il livello 3 come gli altri (dall'indirizzo si contano le richieste: qui basta lo stato) */
    expect(await file("netex_l3")).toMatchObject({ inLinea: null, ultimoTentativo: { esito: "senza_versione" } });
  });
});
