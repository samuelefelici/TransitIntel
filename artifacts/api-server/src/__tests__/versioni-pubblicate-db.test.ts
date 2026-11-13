/**
 * Le versioni pubblicate dei programmi (PR 3.3, migrazione 0021), su un
 * database vero (TEST_DATABASE_URL; in CI come cerbero_app).
 *
 * Un programma messo in esercizio lascia una copia congelata: stampa orari e
 * link pubblici (mappa orari, mappa di rete) leggono quella, e una modifica di
 * bozza non arriva al pubblico finché il programma non torna in esercizio. La
 * bozza la legge solo chi lavora sul programma; le versioni non compaiono fra
 * i progetti e non si modificano; una programmazione annullata porta via la
 * sua versione.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express, { Router } from "express";
import request from "supertest";
import { db, pool } from "@workspace/db";
import { sql } from "drizzle-orm";
import pianificazione from "../lib/planning-studio";
import stampa from "../routes/planning-studio-timetables";
import mappaOrari from "../routes/timetable-map-share";
import mappaRete from "../routes/network-share";
import { versioniInSolaLettura } from "../lib/versioni-pubblicate";
import { cancellaProgetto } from "../lib/progetto-copie";
import { appDiProva, utenteDiProva } from "./helpers/app-di-prova";
import type { AuthUser } from "../lib/auth";

const u = (n: number) => `d3300000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [ADMIN, PIAN, ALTRO] = [u(1), u(2), u(3)];
const P = u(10);
const [F1, F2, LINEA, PERCORSO, CALENDARIO, CORSA] = [u(30), u(31), u(32), u(33), u(34), u(35)];
const NOME = "Versioni di prova 3.3";

const tutte = Router();
tutte.use(versioniInSolaLettura);
for (const r of [pianificazione, stampa]) tutte.use(r);
const app = (x: AuthUser) => appDiProva(tutte, x);
const admin = app(utenteDiProva(ADMIN, [], "admin"));
const pian = app(utenteDiProva(PIAN, [], "user", { ruoli: ["pianificatore"] }));
/* non lavora sul programma: legge la rete, come chiunque abbia «Rete e orari» */
const altro = app(utenteDiProva(ALTRO, [], "user", { ruoli: ["pianificatore"] }));
const pubblico = express();
pubblico.use("/api", mappaOrari);
pubblico.use("/api", mappaRete);

const A = `/api/planning-studio/${P}`;
const primaPartenza = async (cliente: express.Express, fonte: string): Promise<string | null> => {
  const r = await request(cliente).get(`/api/planning-studio/${fonte}/timetables/routes`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  const linea = r.body.routes[0].routeId;
  const o = await request(cliente).get(`/api/planning-studio/${fonte}/timetables/route/${linea}`);
  expect(o.status, JSON.stringify(o.body)).toBe(200);
  return o.body.trips[0]?.firstTime?.slice(0, 5) ?? null;
};
const versioni = async (cliente: express.Express) => {
  const r = await request(cliente).get(`${A}/timetables/versioni`);
  return { stato: r.status, ...r.body };
};

describe.runIf(!!process.env.TEST_DATABASE_URL)("le versioni pubblicate dei programmi, sul database", () => {
  const pulisci = async () => {
    const vecchie = await db.execute<any>(sql`SELECT id FROM ps_projects WHERE versione_del_feed IS NOT NULL AND name LIKE ${NOME + "%"}`);
    for (const v of vecchie.rows) await db.transaction((tx) => cancellaProgetto(tx, v.id));
    await db.execute(sql`DELETE FROM ps_timetable_map_shares WHERE project_id = ${P}::uuid`);
    await db.execute(sql`DELETE FROM ps_network_shares WHERE project_id = ${P}::uuid`);
    await db.execute(sql`DELETE FROM ps_pending_activations WHERE project_id = ${P}::uuid`);
    const p = await db.execute<any>(sql`SELECT id FROM ps_projects WHERE id = ${P}::uuid`);
    if (p.rows.length) await db.transaction((tx) => cancellaProgetto(tx, P));
    const feed = sql`(SELECT id FROM gtfs_feeds WHERE owner_user_id IN (${ADMIN}::uuid, ${PIAN}::uuid, ${ALTRO}::uuid))`;
    await db.execute(sql`DELETE FROM ps_activation_log WHERE feed_id IN ${feed}`);
    await db.execute(sql`DELETE FROM gtfs_feeds WHERE id IN ${feed}`);
    await db.execute(sql`DELETE FROM users WHERE id IN (${ADMIN}::uuid, ${PIAN}::uuid, ${ALTRO}::uuid)`);
  };

  beforeAll(async () => {
    await pulisci();
    const altri = (await db.execute<any>(sql`SELECT count(*)::int AS n FROM gtfs_feeds WHERE is_active`)).rows[0].n;
    if (altri > 0) throw new Error("versioni-pubblicate-db.test.ts vuole un database senza un feed in esercizio");
    await db.execute(sql`INSERT INTO users (id, email, password_hash, role) VALUES
      (${ADMIN}::uuid, 'versioni-admin@prova.local', 'x', 'admin'),
      (${PIAN}::uuid, 'versioni-pian@prova.local', 'x', 'user'),
      (${ALTRO}::uuid, 'versioni-altro@prova.local', 'x', 'user')`);
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
  afterAll(async () => { await pulisci(); await pool.end(); });

  let mappa = "", rete = "", versione = "";

  it("prima della messa in esercizio: niente versioni, la stampa legge la bozza, e solo chi ci lavora", async () => {
    expect(await versioni(pian)).toMatchObject({ stato: 200, esercizio: null, programmata: null, bozza: { id: P, quale: "bozza" } });
    expect(await primaPartenza(pian, P)).toBe("07:00");
    expect((await versioni(altro)).stato).toBe(403);
    // i link si creano dal programma
    const m = await request(pian).post(`${A}/timetable-map-share`).send({ routeIds: [LINEA], title: "Paline" });
    const r = await request(pian).post(`${A}/network-share`).send({ routeIds: [LINEA] });
    expect([m.status, r.status]).toEqual([200, 200]);
    mappa = m.body.token; rete = r.body.token;
    // senza versione il link pubblico legge il programma com'è, come prima
    const pub = await request(pubblico).get(`/api/timetable-map/${mappa}`);
    expect(pub.body.lines.map((l: any) => l.routeId)).toEqual([LINEA]);
  });

  it("messa in esercizio: nasce la versione, congelata, senza proprietario, fuori dagli elenchi", async () => {
    const r = await request(pian).post(`${A.replace("/planning-studio/", "/planning-studio/projects/")}/activate`).send({});
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const v = await versioni(pian);
    expect(v).toMatchObject({ esercizio: { quale: "esercizio" }, programmata: null, bozza: { id: P } });
    versione = v.esercizio.id;
    expect(versione).not.toBe(P);
    const riga = (await db.execute<any>(sql`SELECT owner_user_id, versione_di, versione_del_feed, status FROM ps_projects WHERE id = ${versione}::uuid`)).rows[0];
    expect(riga).toEqual({ owner_user_id: null, versione_di: P, versione_del_feed: r.body.feedId, status: "versione" });
    // non è fra i progetti di nessuno
    for (const c of [pian, admin]) {
      const l = await request(c).get("/api/planning-studio/projects");
      expect(l.body.projects.map((p: any) => p.id)).not.toContain(versione);
    }
    expect(await primaPartenza(pian, versione)).toBe("07:00");
  });

  it("una modifica di bozza non arriva alla stampa della versione né ai link pubblici", async () => {
    await db.execute(sql`UPDATE ps_stop_times SET departure_time = '09' || substr(departure_time, 3), arrival_time = '09' || substr(arrival_time, 3) WHERE trip_id = ${CORSA}::uuid`);
    expect(await primaPartenza(pian, P)).toBe("09:00");        // la bozza
    expect(await primaPartenza(pian, versione)).toBe("07:00"); // la versione in esercizio
    // il link pubblico legge la versione: le linee hanno gli id della versione
    const pub = await request(pubblico).get(`/api/timetable-map/${mappa}`);
    expect(pub.status).toBe(200);
    expect(pub.body.lines).toHaveLength(1);
    const lineaNellaVersione = pub.body.lines[0].routeId;
    expect(lineaNellaVersione).not.toBe(LINEA);
    const delPercorso = await request(pubblico).get(`/api/timetable-map/${mappa}/route/${lineaNellaVersione}`);
    expect(delPercorso.status, JSON.stringify(delPercorso.body)).toBe(200);
    // e una linea della bozza non passa più dal link
    expect((await request(pubblico).get(`/api/timetable-map/${mappa}/route/${LINEA}`)).status).not.toBe(200);
    const r = await request(pubblico).get(`/api/network-share/${rete}`);
    expect(r.status).toBe(200);
    expect(r.body.projectId).toBe(P);
  });

  it("chi non lavora sul programma legge la versione, non la bozza", async () => {
    expect(await versioni(altro)).toMatchObject({ stato: 200, esercizio: { id: versione }, bozza: null });
    expect(await primaPartenza(altro, versione)).toBe("07:00");
    expect((await request(altro).get(`${A}/timetables/routes`)).status).toBe(403);
  });

  it("una versione non si modifica, nemmeno dall'amministratore, e i link non si creano da lei", async () => {
    const V = `/api/planning-studio/projects/${versione}`;
    for (const [metodo, percorso, corpo] of [
      ["patch", V, { name: "rinominata" }],
      ["post", `${V}/duplicate`, {}],
      ["delete", V, undefined],
      ["post", `/api/planning-studio/${versione}/timetable-map-share`, { routeIds: [] }],
    ] as const) {
      const r = await (request(admin) as any)[metodo](percorso).send(corpo ?? {});
      expect(r.status, `${metodo} ${percorso}`).toBe(403);
    }
    expect((await db.execute<any>(sql`SELECT name FROM ps_projects WHERE id = ${versione}::uuid`)).rows[0].name).not.toBe("rinominata");
  });

  it("le linee scelte sulla versione si salvano come linee del programma", async () => {
    const lineaNellaVersione = (await request(pian).get(`/api/planning-studio/${versione}/timetables/routes`)).body.routes[0].routeId;
    const r = await request(pian).patch(`${A}/timetable-map-shares/${mappa}`).send({ routeIds: [lineaNellaVersione] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.routeIds).toEqual([LINEA]);
    // e la pagina, che guarda la versione, le riceve con gli id della versione
    const l = await request(pian).get(`${A}/timetable-map-shares?vista=${versione}`);
    expect(l.body.shares[0].routeIds).toEqual([lineaNellaVersione]);
  });

  it("una messa in esercizio programmata ha la sua versione; annullata, la versione se ne va", async () => {
    const r = await request(pian).post(`${A.replace("/planning-studio/", "/planning-studio/projects/")}/activate`).send({ effectiveFrom: "2099-01-01" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const v = await versioni(pian);
    expect(v).toMatchObject({ esercizio: { id: versione }, programmata: { quale: "programmata", dal: "2099-01-01" } });
    expect(await primaPartenza(pian, v.programmata.id)).toBe("09:00");
    const via = await request(pian).delete(`/api/planning-studio/projects/${P}/activations/pending`);
    expect(via.status).toBe(200);
    expect((await versioni(pian)).programmata).toBeNull();
    expect((await db.execute<any>(sql`SELECT count(*)::int AS n FROM ps_projects WHERE id = ${v.programmata.id}::uuid`)).rows[0].n).toBe(0);
  });

  it("rimesso in esercizio: la versione nuova va al pubblico, quella di prima resta come storia", async () => {
    const r = await request(pian).post(`${A.replace("/planning-studio/", "/planning-studio/projects/")}/activate`).send({});
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const v = await versioni(pian);
    expect(v.esercizio.id).not.toBe(versione);
    expect(await primaPartenza(pian, v.esercizio.id)).toBe("09:00");
    const pub = await request(pubblico).get(`/api/timetable-map/${mappa}`);
    expect(pub.body.lines[0].routeId).not.toBe(LINEA);
    const vecchia = (await db.execute<any>(sql`SELECT versione_di FROM ps_projects WHERE id = ${versione}::uuid`)).rows[0];
    expect(vecchia).toEqual({ versione_di: P });
  });
});
