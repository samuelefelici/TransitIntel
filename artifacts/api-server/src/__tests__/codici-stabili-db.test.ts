/**
 * I codici stabili di corsa, fermata e linea su un database vero
 * (TEST_DATABASE_URL, migrato alla 0018; in CI come cerbero_app).
 *
 * Il giro intero, con l'API: si importa un GTFS, si aggiungono righe a mano,
 * si sdoppia una corsa, si duplica il programma, si esporta e si reimporta.
 * In ogni passo il codice è quello atteso, e il GTFS esportato lo usa come
 * stop_id, route_id e trip_id.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Router } from "express";
import request from "supertest";
import AdmZip from "adm-zip";
import { db, pool } from "@workspace/db";
import { sql } from "drizzle-orm";
import pianificazione from "../lib/planning-studio";
import corse from "../lib/planning-studio-trips-ext";
import importa from "../lib/planning-studio-import";
import esporta from "../lib/planning-studio-export";
import { appDiProva, utenteDiProva } from "./helpers/app-di-prova";

const UTENTE = "d3100000-0000-4000-8000-000000000001";
const P = "d3100000-0000-4000-8000-0000000000a0";
const P_DOPPIONI = "d3100000-0000-4000-8000-0000000000a1";
const P_ALTRA = "d3100000-0000-4000-8000-0000000000a2";
const [CAT1, CAT2] = ["d3100000-0000-4000-8000-0000000000c1", "d3100000-0000-4000-8000-0000000000c2"];
const GENERATO = { corsa: /^CB-C[0-9]+$/, fermata: /^CB-F[0-9]+$/, linea: /^CB-L[0-9]+$/ };

const tutte = Router();
for (const r of [pianificazione, corse, importa, esporta]) tutte.use(r);
const app = appDiProva(tutte, utenteDiProva(UTENTE));

/** Un GTFS piccolo: due linee, tre fermate, tre corse. `extra` aggiunge o sostituisce righe. */
function gtfs(opzioni: { fermate?: string[]; corse?: string[]; orari?: string[]; linee?: string[] } = {}): Buffer {
  const zip = new AdmZip();
  const file = (nome: string, righe: string[]) => zip.addFile(nome, Buffer.from(righe.join("\n") + "\n", "utf8"));
  file("agency.txt", ["agency_id,agency_name,agency_url,agency_timezone", "1,Azienda di prova,https://esempio.it,Europe/Rome"]);
  file("stops.txt", ["stop_id,stop_code,stop_name,stop_lat,stop_lon",
    "10,2010,Stazione,43.61,13.51", "11,2011,Via Roma,43.62,13.52", "12,2012,Capolinea,43.63,13.53", ...(opzioni.fermate ?? [])]);
  file("routes.txt", ["route_id,route_short_name,route_long_name,route_type", "1/3,1,Stazione - Capolinea,3", "9,9,Circolare,3", ...(opzioni.linee ?? [])]);
  file("calendar.txt", ["service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date", "FER,1,1,1,1,1,0,0,20260101,20261231"]);
  file("trips.txt", ["route_id,service_id,trip_id,trip_headsign,direction_id",
    "1/3,FER,623_CodUdp:D1333_363485,Capolinea,0", "1/3,FER,623_CodUdp:D1333_363486,Capolinea,0", "9,FER,900_1,Circolare,0", ...(opzioni.corse ?? [])]);
  const orari = (corsa: string, ora: string) => [`${corsa},${ora}:00:00,${ora}:00:00,10,1`, `${corsa},${ora}:10:00,${ora}:10:00,11,2`, `${corsa},${ora}:20:00,${ora}:20:00,12,3`];
  file("stop_times.txt", ["trip_id,arrival_time,departure_time,stop_id,stop_sequence",
    ...orari("623_CodUdp:D1333_363485", "07"), ...orari("623_CodUdp:D1333_363486", "08"), ...orari("900_1", "09"), ...(opzioni.orari ?? [])]);
  return zip.toBuffer();
}

/** Le righe di un file CSV di uno zip, come oggetti. */
function leggi(zip: AdmZip, nome: string): Record<string, string>[] {
  const [testa, ...righe] = zip.readAsText(nome).trim().split("\n");
  const colonne = testa!.split(",");
  return righe.filter(Boolean).map(r => Object.fromEntries(r.split(",").map((v, i) => [colonne[i]!, v])));
}

const codici = async (tabella: "ps_trips" | "ps_stops" | "ps_routes", progetto: string): Promise<string[]> => {
  // scan-ok: il nome della tabella è uno dei tre scritti nel tipo qui sopra
  const r = await db.execute<any>(sql`SELECT codice FROM ${sql.raw(tabella)} WHERE project_id = ${progetto}::uuid ORDER BY codice`); // scan-ok: elenco chiuso
  return r.rows.map((x: any) => x.codice);
};
const importaIn = (progetto: string, file: Buffer, campi: Record<string, string> = {}) => {
  let r = request(app).post(`/api/planning-studio/projects/${progetto}/import-gtfs`);
  for (const [k, v] of Object.entries(campi)) r = r.field(k, v);
  return r.attach("file", file, "gtfs.zip");
};
const esportaDa = async (progetto: string): Promise<AdmZip> => {
  const r = await request(app).get(`/api/planning-studio/projects/${progetto}/export-gtfs`).buffer(true)
    .parse((res, fine) => { const pezzi: Buffer[] = []; res.on("data", (c: Buffer) => pezzi.push(c)); res.on("end", () => fine(null, Buffer.concat(pezzi))); });
  expect(r.status).toBe(200);
  return new AdmZip(r.body as Buffer);
};

describe.runIf(!!process.env.TEST_DATABASE_URL)("codici stabili di corsa, fermata e linea, sul database", () => {
  const copie: string[] = [];
  const pulisci = async () => {
    const progetti = sql`(SELECT id FROM ps_projects WHERE owner_user_id = ${UTENTE}::uuid)`;
    await db.execute(sql`DELETE FROM ps_trips WHERE project_id IN ${progetti}`);
    await db.execute(sql`DELETE FROM ps_projects WHERE owner_user_id = ${UTENTE}::uuid`);
    await db.execute(sql`DELETE FROM ps_validity_categories WHERE id IN (${CAT1}::uuid, ${CAT2}::uuid)`);
  };

  beforeAll(async () => {
    await pulisci();
    await db.execute(sql`INSERT INTO ps_projects (id, owner_user_id, name) VALUES
      (${P}::uuid, ${UTENTE}::uuid, 'Codici stabili'), (${P_DOPPIONI}::uuid, ${UTENTE}::uuid, 'Codici stabili, doppioni'),
      (${P_ALTRA}::uuid, ${UTENTE}::uuid, 'Codici stabili, altra installazione')`);
    await db.execute(sql`INSERT INTO ps_validity_categories (id, code, name, color) VALUES
      (${CAT1}::uuid, 'prova_codici_1', 'Prova codici 1', '#000000'), (${CAT2}::uuid, 'prova_codici_2', 'Prova codici 2', '#000000')`);
  });
  afterAll(async () => { await pulisci(); await pool.end(); });

  it("una riga importata ha per codice l'id che aveva nel file", async () => {
    const r = await importaIn(P, gtfs());
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await codici("ps_stops", P)).toEqual(["10", "11", "12"]);
    expect(await codici("ps_routes", P)).toEqual(["1/3", "9"]);
    expect(await codici("ps_trips", P)).toEqual(["623_CodUdp:D1333_363485", "623_CodUdp:D1333_363486", "900_1"]);
  });

  it("una riga creata a mano riceve un codice dal database, e l'API lo restituisce", async () => {
    const fermata = await request(app).post(`/api/planning-studio/projects/${P}/stops`).send({ name: "A mano", lat: 43.6, lon: 13.5, code: "2099" });
    expect(fermata.status, JSON.stringify(fermata.body)).toBe(200);
    expect(fermata.body.stop.codice).toMatch(GENERATO.fermata);
    expect(fermata.body.stop.code).toBe("2099"); // il codice esposto al pubblico resta un'altra cosa

    const linea = await request(app).post(`/api/planning-studio/projects/${P}/routes`).send({ shortName: "A mano" });
    expect(linea.body.route.codice).toMatch(GENERATO.linea);

    const elenco = await request(app).get(`/api/planning-studio/projects/${P}/stops`);
    expect(elenco.body.stops.map((s: any) => s.codice).sort()).toEqual(["10", "11", "12", fermata.body.stop.codice].sort());
    const linee = await request(app).get(`/api/planning-studio/projects/${P}/routes`);
    expect(linee.body.routes.map((l: any) => l.codice).sort()).toEqual(["1/3", "9", linea.body.route.codice].sort());

    const origine = await db.execute<any>(sql`SELECT route_id, variant_id FROM ps_trips WHERE project_id = ${P}::uuid AND codice = '900_1'`);
    const corsa = await request(app).post(`/api/planning-studio/projects/${P}/trips`)
      .send({ routeId: origine.rows[0].route_id, variantId: origine.rows[0].variant_id });
    expect(corsa.status, JSON.stringify(corsa.body)).toBe(200);
    expect(corsa.body.trip.codice).toMatch(GENERATO.corsa);
    // perché esca nel GTFS le servono un calendario, la validità e gli orari: quelli della corsa 900_1
    await db.execute(sql`
      WITH origine AS (SELECT id, calendar_id FROM ps_trips WHERE project_id = ${P}::uuid AND codice = '900_1'),
           cal AS (UPDATE ps_trips t SET calendar_id = o.calendar_id FROM origine o WHERE t.id = ${corsa.body.trip.id}::uuid),
           val AS (INSERT INTO ps_trip_day_validity (trip_id, day_type_id, is_valid)
                   SELECT ${corsa.body.trip.id}::uuid, v.day_type_id, v.is_valid FROM ps_trip_day_validity v JOIN origine o ON o.id = v.trip_id)
      INSERT INTO ps_stop_times (trip_id, stop_seq, stop_id, arrival_time, departure_time)
      SELECT ${corsa.body.trip.id}::uuid, s.stop_seq, s.stop_id, s.arrival_time, s.departure_time FROM ps_stop_times s JOIN origine o ON o.id = s.trip_id`);
  });

  it("il GTFS esportato usa i codici come stop_id, route_id e trip_id", async () => {
    const zip = await esportaDa(P);
    const fermate = leggi(zip, "stops.txt"), linee = leggi(zip, "routes.txt"), corseDelFile = leggi(zip, "trips.txt"), orari = leggi(zip, "stop_times.txt");
    expect(fermate.map(f => f.stop_id).sort()).toEqual(await codici("ps_stops", P));
    expect(linee.map(l => l.route_id).sort()).toEqual(await codici("ps_routes", P));
    // le tre corse del file col loro id, quella creata a mano col codice che le ha dato il database
    expect(corseDelFile.map(c => c.trip_id).sort()).toEqual(await codici("ps_trips", P));
    expect(corseDelFile.filter(c => GENERATO.corsa.test(c.trip_id!))).toHaveLength(1);
    // ogni riferimento punta a un codice che c'è nel file
    const idFermate = new Set(fermate.map(f => f.stop_id)), idLinee = new Set(linee.map(l => l.route_id)), idCorse = new Set(corseDelFile.map(c => c.trip_id));
    expect(corseDelFile.every(c => idLinee.has(c.route_id))).toBe(true);
    expect(orari.length).toBeGreaterThan(0);
    expect(orari.every(o => idCorse.has(o.trip_id) && idFermate.has(o.stop_id))).toBe(true);
    // nessun id interno fra gli identificativi consegnati
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-/;
    expect([...idFermate, ...idLinee, ...idCorse].some(x => uuid.test(x!))).toBe(false);

  });

  it("sdoppiare una corsa dà alla copia un codice nuovo, e l'originale tiene il suo", async () => {
    const t = (await db.execute<any>(sql`SELECT id FROM ps_trips WHERE project_id = ${P}::uuid AND codice = '623_CodUdp:D1333_363485'`)).rows[0].id;
    await db.execute(sql`INSERT INTO ps_trip_category_validity (trip_id, category_id) VALUES (${t}::uuid, ${CAT1}::uuid), (${t}::uuid, ${CAT2}::uuid)`);
    const r = await request(app).post(`/api/planning-studio/projects/${P}/trips/${t}/split-categories`).send({ categoryIds: [CAT2] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const due = await db.execute<any>(sql`
      SELECT id, codice, gtfs_id FROM ps_trips WHERE project_id = ${P}::uuid AND gtfs_id = '623_CodUdp:D1333_363485' ORDER BY created_at, id`);
    expect(due.rows).toHaveLength(2);
    const originale = due.rows.find((x: any) => x.id === t), copia = due.rows.find((x: any) => x.id !== t);
    expect(originale.codice).toBe("623_CodUdp:D1333_363485");
    expect(copia.codice).toMatch(GENERATO.corsa);
  });

  it("la copia di un programma tiene gli stessi codici, con id interni diversi", async () => {
    const r = await request(app).post(`/api/planning-studio/projects/${P}/duplicate`).send({ name: "Codici stabili (copia)" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const copia: string = r.body.project.id;
    copie.push(copia);
    for (const tabella of ["ps_trips", "ps_stops", "ps_routes"] as const) {
      expect(await codici(tabella, copia), tabella).toEqual(await codici(tabella, P));
      const stessiId = await db.execute<any>(sql`
        SELECT count(*)::int AS n FROM ${sql.raw(tabella)} a JOIN ${sql.raw(tabella)} b ON b.id = a.id -- scan-ok: elenco chiuso
         WHERE a.project_id = ${P}::uuid AND b.project_id = ${copia}::uuid`);
      expect(stessiId.rows[0].n).toBe(0);
    }
    // corsa per corsa: stesso codice, stessi orari alle stesse fermate (per codice)
    const orari = (p: string) => db.execute<any>(sql`
      SELECT t.codice AS corsa, o.stop_seq, s.codice AS fermata, o.departure_time
        FROM ps_stop_times o JOIN ps_trips t ON t.id = o.trip_id JOIN ps_stops s ON s.id = o.stop_id
       WHERE t.project_id = ${p}::uuid ORDER BY 1, 2`);
    expect((await orari(copia)).rows).toEqual((await orari(P)).rows);
    // e il GTFS della copia consegna gli stessi identificativi dell'originale
    const [delProgramma, dellaCopia] = [await esportaDa(P), await esportaDa(copia)];
    for (const [file, colonna] of [["stops.txt", "stop_id"], ["routes.txt", "route_id"], ["trips.txt", "trip_id"]] as const) {
      const id = leggi(delProgramma, file).map(x => x[colonna]).sort();
      expect(id.length, file).toBeGreaterThan(0);
      expect(leggi(dellaCopia, file).map(x => x[colonna]).sort(), file).toEqual(id);
    }
  });

  it("reimportare il GTFS esportato ritrova ogni riga dal suo codice: niente doppioni", async () => {
    const zip = (await esportaDa(P)).toBuffer();
    const prima = { corse: await codici("ps_trips", P), fermate: await codici("ps_stops", P), linee: await codici("ps_routes", P) };
    const r = await importaIn(P, zip, { mode: "merge" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.merge.stops.added).toBe(0);
    expect(r.body.merge.routes.added).toBe(0);
    expect(r.body.merge.trips.added).toBe(0);
    expect(r.body.merge.trips.updated).toBeGreaterThanOrEqual(4); // le tre del file e quella a mano, ritrovata dal codice
    expect({ corse: await codici("ps_trips", P), fermate: await codici("ps_stops", P), linee: await codici("ps_routes", P) }).toEqual(prima);
    // le righe create a mano restano «a mano»: ritrovate dal codice, non prendono un gtfs_id
    const aMano = await db.execute<any>(sql`
      SELECT (SELECT count(*)::int FROM ps_trips WHERE project_id = ${P}::uuid AND codice ~ '^CB-C' AND gtfs_id IS NULL) AS corse,
             (SELECT count(*)::int FROM ps_stops WHERE project_id = ${P}::uuid AND codice ~ '^CB-F' AND gtfs_id IS NULL) AS fermate,
             (SELECT count(*)::int FROM ps_routes WHERE project_id = ${P}::uuid AND codice ~ '^CB-L' AND gtfs_id IS NULL) AS linee`);
    expect(aMano.rows[0]).toEqual({ corse: 1, fermate: 1, linee: 1 });
    // e una seconda volta: stabile
    const ancora = await importaIn(P, zip, { mode: "merge" });
    expect(ancora.body.merge).toMatchObject({ stops: { added: 0 }, routes: { added: 0 }, trips: { added: 0 } });
    expect(await codici("ps_trips", P)).toEqual(prima.corse);
  });

  it("il GTFS d'origine, reimportato, ritrova le sue righe e non tocca i codici", async () => {
    const prima = await codici("ps_trips", P);
    const r = await importaIn(P, gtfs({ corse: ["9,FER,900_2,Circolare,0"], orari: ["900_2,10:00:00,10:00:00,10,1", "900_2,10:10:00,10:10:00,11,2", "900_2,10:20:00,10:20:00,12,3"] }), { mode: "merge" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.merge.trips).toMatchObject({ added: 1, updated: 3 });
    expect(r.body.merge.stops.added).toBe(0);
    // la corsa creata a mano non è nel file d'origine: resta attiva, non è «sparita»
    const aMano = await db.execute<any>(sql`SELECT is_active FROM ps_trips WHERE project_id = ${P}::uuid AND codice ~ '^CB-C' AND gtfs_id IS NULL`);
    expect(aMano.rows).toEqual([{ is_active: true }]);
    expect(await codici("ps_trips", P)).toEqual([...prima, "900_2"].sort());
    // fra l'originale e la copia sdoppiata (stesso gtfs_id) è stata aggiornata l'originale
    const aggiornata = await db.execute<any>(sql`
      SELECT codice FROM ps_trips WHERE project_id = ${P}::uuid AND gtfs_id = '623_CodUdp:D1333_363485'
       ORDER BY updated_at DESC, (codice = gtfs_id) DESC LIMIT 1`);
    expect(aggiornata.rows[0].codice).toBe("623_CodUdp:D1333_363485");
  });

  it("un file con lo stesso id due volte non ferma l'import", async () => {
    const doppio = gtfs({ fermate: ["12,2012,Capolinea (doppia),43.63,13.53"], linee: ["9,9,Circolare (doppia),3"] });
    const r = await importaIn(P_DOPPIONI, doppio);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await codici("ps_stops", P_DOPPIONI)).toEqual(["10", "11", "12", "12~2"]);
    expect(await codici("ps_routes", P_DOPPIONI)).toEqual(["1/3", "9", "9~2"]);
    // nel reimport non distruttivo vale la prima riga, e non nasce un doppione a ogni giro
    for (let giro = 0; giro < 2; giro++) {
      const merge = await importaIn(P_DOPPIONI, doppio, { mode: "merge" });
      expect(merge.status, JSON.stringify(merge.body)).toBe(200);
      expect(merge.body.merge.stops.added).toBe(0);
      expect(merge.body.merge.routes.added).toBe(0);
    }
    expect(await codici("ps_stops", P_DOPPIONI)).toEqual(["10", "11", "12", "12~2"]);
  });

  it("un file coi codici generati da un'altra installazione: le righe nuove non li ripetono", async () => {
    const ultimo = Number((await db.execute<any>(sql`SELECT last_value FROM public.ps_codici_seq`)).rows[0].last_value);
    const lontano = ultimo + 1000;
    const r = await importaIn(P_ALTRA, gtfs({ fermate: [`CB-F${lontano},,Di un'altra installazione,43.6,13.5`] }));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await codici("ps_stops", P_ALTRA)).toContain(`CB-F${lontano}`);
    const nuova = await request(app).post(`/api/planning-studio/projects/${P_ALTRA}/stops`).send({ name: "Nuova", lat: 43.6, lon: 13.5 });
    expect(nuova.status, JSON.stringify(nuova.body)).toBe(200);
    expect(Number(String(nuova.body.stop.codice).replace("CB-F", ""))).toBeGreaterThan(lontano);
  });
});
