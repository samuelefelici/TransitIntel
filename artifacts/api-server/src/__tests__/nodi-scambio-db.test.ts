/**
 * I nodi di scambio come dato dell'azienda (tappa 6.16, migrazione 0046) su
 * un database vero (TEST_DATABASE_URL; in CI come cerbero_app): solo
 * l'amministratore li cambia; l'analisi intermodale, le zone di coincidenza e
 * gli orari di riserva di una zona li leggono dalla tabella.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import request from "supertest";
import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import adminRouter from "../routes/admin";
import intermodale from "../routes/intermodal";
import zoneDiCoincidenza from "../routes/coincidence-zones";
import { dimenticaNodi, leggiNodi } from "../lib/nodi-scambio-store";
import { MASSIMO_NODI } from "../lib/nodi-scambio";
import { appDiProva, utenteDiProva } from "./helpers/app-di-prova";

const ADMIN = "e6160000-0000-4000-8000-000000000001";
const admin = request(appDiProva(adminRouter, utenteDiProva(ADMIN, [], "admin")));
const persona = request(appDiProva(adminRouter, utenteDiProva("e6160000-0000-4000-8000-000000000002", ["network"], "user")));
const rotte = Router();
rotte.use(intermodale);
rotte.use(zoneDiCoincidenza);
const lettore = request(appDiProva(rotte, utenteDiProva(ADMIN, [], "admin")));

const P = "prova-616-";
const ZONA = "e6160000-0000-4000-8000-0000000000a1";
const righe = async (q: ReturnType<typeof sql>) => (await db.execute<any>(q)).rows as any[];
const stazione = {
  nodo: `${P}stazione`, nome: "Stazione di prova", tipo: "railway", lat: 44.4949, lng: 11.3426, fermateGtfs: ["S1", "S2"], minutiAPiedi: 3,
  descrizione: "La stazione della prova",
  arrivi: [{ luogo: "Bologna (R)", orari: ["8:10", "07:10"] }],
  partenze: [{ luogo: "Milano (IC)", orari: ["09:00"] }, { luogo: "Roma (FR)", orari: ["10:00", "06:30"] }],
};

describe.runIf(!!process.env.TEST_DATABASE_URL)("i nodi di scambio dell'azienda, sul database", () => {
  const pulisci = async () => {
    await db.execute(sql`DELETE FROM coincidence_zones WHERE id = ${ZONA}::uuid`);
    await db.execute(sql`DELETE FROM nodi_scambio WHERE nodo LIKE ${P + "%"}`);
    dimenticaNodi();
  };
  beforeAll(pulisci);
  afterEach(pulisci);
  afterAll(pulisci);

  it("solo l'amministratore", async () => {
    expect((await persona.get("/api/admin/nodi-scambio")).status).toBe(403);
    expect((await persona.post("/api/admin/nodi-scambio").send(stazione)).status).toBe(403);
    expect((await persona.delete(`/api/admin/nodi-scambio/${P}x`)).status).toBe(403);
  });

  it("un nodo: si crea con gli orari in ordine, si cambia, si toglie; l'identificativo resta", async () => {
    const r = await admin.post("/api/admin/nodi-scambio").send(stazione);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.nodo).toMatchObject({
      nodo: `${P}stazione`, tipo: "railway", fermateGtfs: ["S1", "S2"], minutiAPiedi: 3,
      arrivi: [{ luogo: "Bologna (R)", orari: ["07:10", "08:10"] }],
      partenze: [{ luogo: "Milano (IC)", orari: ["09:00"] }, { luogo: "Roma (FR)", orari: ["06:30", "10:00"] }],
    });
    expect((await admin.post("/api/admin/nodi-scambio").send(stazione)).status).toBe(409);
    expect((await admin.post("/api/admin/nodi-scambio").send({ ...stazione, nodo: "gtfs-railway-abc" })).status).toBe(400);
    expect((await admin.post("/api/admin/nodi-scambio").send({ ...stazione, nodo: `${P}x`, arrivi: [{ luogo: "A", orari: ["8"] }] })).status).toBe(400);

    const { nodo: _id, ...dati } = stazione;
    const m = await admin.put(`/api/admin/nodi-scambio/${P}stazione`).send({ ...dati, nome: "Stazione nuova", tipo: "port", arrivi: [] });
    expect(m.status, JSON.stringify(m.body)).toBe(200);
    expect(m.body.nodo).toMatchObject({ nodo: `${P}stazione`, nome: "Stazione nuova", tipo: "port", arrivi: [] });
    /* l'identificativo non si cambia: nel corpo non si accetta */
    expect((await admin.put(`/api/admin/nodi-scambio/${P}stazione`).send(stazione)).status).toBe(400);
    expect((await admin.put(`/api/admin/nodi-scambio/${P}nessuno`).send(dati)).status).toBe(404);
    expect((await admin.put("/api/admin/nodi-scambio/NON VALIDO").send(dati)).status).toBe(404);

    expect((await admin.delete(`/api/admin/nodi-scambio/${P}stazione`)).body).toEqual({ ok: true });
    expect((await admin.delete(`/api/admin/nodi-scambio/${P}stazione`)).status).toBe(404);
  });

  it("l'elenco dice quante zone di coincidenza ricordano ogni nodo; togliere il nodo non tocca la zona", async () => {
    await admin.post("/api/admin/nodi-scambio").send(stazione);
    await db.execute(sql`
      INSERT INTO coincidence_zones (id, name, hub_id, hub_name, hub_type, hub_lat, hub_lng)
      VALUES (${ZONA}::uuid, 'Zona di prova', ${P + "stazione"}, 'Stazione di prova', 'railway', 44.4949, 11.3426)`);
    const elenco = await admin.get("/api/admin/nodi-scambio");
    expect(elenco.status).toBe(200);
    expect(elenco.body.massimo).toBe(MASSIMO_NODI);
    expect((elenco.body.nodi as any[]).find((n) => n.nodo === `${P}stazione`)).toMatchObject({ zone: 1 });

    /* la zona senza orari suoi prende quelli stimati del suo nodo */
    const orari = await lettore.get(`/api/coincidence-zones/${ZONA}/schedules`);
    expect(orari.status).toBe(200);
    expect(orari.body).toMatchObject({
      source: "preset",
      arrivals: [{ label: "Bologna (R)", times: ["07:10", "08:10"] }],
      departures: [{ label: "Milano (IC)", times: ["09:00"] }, { label: "Roma (FR)", times: ["06:30", "10:00"] }],
    });

    await admin.delete(`/api/admin/nodi-scambio/${P}stazione`);
    expect((await righe(sql`SELECT name FROM coincidence_zones WHERE id = ${ZONA}::uuid`))).toEqual([{ name: "Zona di prova" }]);
    expect((await lettore.get(`/api/coincidence-zones/${ZONA}/schedules`)).body).toMatchObject({ source: "empty", arrivals: [], departures: [] });
  });

  it("le zone di coincidenza vedono tutti i nodi; l'analisi intermodale solo stazioni, porti e aeroporti", async () => {
    await admin.post("/api/admin/nodi-scambio").send(stazione);
    await admin.post("/api/admin/nodi-scambio").send({ nodo: `${P}parcheggio`, nome: "P+R di prova", tipo: "park-ride", lat: 44.5, lng: 11.35 });

    const nodiZone = (await lettore.get("/api/coincidence-zones/hubs")).body.hubs as any[];
    expect(nodiZone.find((h) => h.id === `${P}stazione`)).toMatchObject({
      name: "Stazione di prova", type: "railway", platformWalkMinutes: 3, totalArrivals: 2, totalDepartures: 3,
      arrivals: [{ origin: "Bologna (R)", times: ["07:10", "08:10"] }],
    });
    expect(nodiZone.find((h) => h.id === `${P}parcheggio`)).toMatchObject({ type: "park-ride", totalArrivals: 0 });

    const orari = await lettore.get(`/api/intermodal/hub-schedule/${P}stazione`);
    expect(orari.body).toMatchObject({ source: "curated", dataTrust: "stima", typicalDepartures: [{ destination: "Milano (IC)", times: ["09:00"] }, { destination: "Roma (FR)", times: ["06:30", "10:00"] }] });
    expect((await lettore.get(`/api/intermodal/hub-schedule/${P}parcheggio`)).body).toMatchObject({ source: "none", dataTrust: "assente" });

    const dellAnalisi = (await leggiNodi()).filter((n) => n.tipo !== "park-ride").length;
    expect((await lettore.get("/api/intermodal/sync-status")).body.curatedHubCount).toBe(dellAnalisi);
  });

  it(`al più ${MASSIMO_NODI} nodi`, async () => {
    const giaCi = Number((await righe(sql`SELECT count(*)::int AS n FROM nodi_scambio`))[0].n);
    await db.execute(sql`INSERT INTO nodi_scambio (nodo, nome, tipo, lat, lng)
      SELECT ${P} || n, 'Nodo ' || n, 'railway', 44.5, 11.3 FROM generate_series(1, ${MASSIMO_NODI - giaCi}::integer) AS n`);
    const r = await admin.post("/api/admin/nodi-scambio").send({ ...stazione, nodo: `${P}di-troppo` });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/sono già 100/);
  });
});
