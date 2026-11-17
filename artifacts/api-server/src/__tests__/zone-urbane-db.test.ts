/**
 * Le zone tariffarie urbane (tappa 6.6), su un database vero
 * (TEST_DATABASE_URL; in CI come cerbero_app).
 *
 * Il difetto di prima: le fermate di Senigallia, Castelfidardo e Sassoferrato
 * finivano nella zona di Falconara. Qui un feed di prova parte già con quelle
 * righe sbagliate, e la generazione le deve rimettere a posto: ogni fermata
 * nella zona della sua rete, quelle sbagliate tolte, il resto non toccato.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db, pool } from "@workspace/db";
import { sql } from "drizzle-orm";
import faresRouter from "../routes/fares";
import { assegnaZoneUrbane } from "../lib/zone-urbane";
import { retiUrbane } from "../lib/reti-linee";
import { conLeRetiDiProva, senzaReti } from "./helpers/reti-di-prova";
import { appDiProva, utenteDiProva } from "./helpers/app-di-prova";

const F = "e6600000-0000-4000-8000-0000000000f1";      // il feed di prova
const ALTRO = "e6600000-0000-4000-8000-0000000000f2";  // un altro feed: non si tocca
const ALTRO_VUOTO = "e6600000-0000-4000-8000-0000000000f3"; // un feed che non c'è: nessuna zona
const ADMIN = "e6600000-0000-4000-8000-000000000001";
const admin = request(appDiProva(faresRouter, utenteDiProva(ADMIN, [], "admin")));

/** linea → [nome breve, rete assegnata, fermate] */
const LINEE: Record<string, [string, string, string[]]> = {
  L_AN: ["1", "urbano_ancona", ["A1", "A2"]],
  L_FA: ["Y", "urbano_falconara", ["F1"]],
  L_SE: ["BUS5", "urbano_senigallia", ["S1", "S2"]],
  L_CF: ["CIRCA", "urbano_castelfidardo", ["C1"]],
  /* nessuna regola porta a Sassoferrato: la linea ci è stata messa a mano */
  L_SS: ["SAS", "urbano_sassoferrato", ["X1"]],
};
const FERMATE = [...new Set(Object.values(LINEE).flatMap(([, , f]) => f)), "ORFANA"];

async function pulisci() {
  for (const feed of [F, ALTRO]) {
    for (const t of ["gtfs_fare_leg_rules", "gtfs_fare_zone_cluster_stops", "gtfs_fare_zone_clusters", "gtfs_stop_areas", "gtfs_fare_areas", "gtfs_route_networks", "gtfs_stop_times", "gtfs_trips", "gtfs_routes", "gtfs_stops"]) {
      await db.execute(sql`DELETE FROM ${sql.identifier(t)} WHERE feed_id = ${feed}::uuid`);
    }
    await db.execute(sql`DELETE FROM gtfs_feeds WHERE id = ${feed}::uuid`);
  }
}

/** Le fermate di ogni zona urbana del feed, in ordine. */
async function zone(feed = F): Promise<Record<string, string[]>> {
  const righe = (await db.execute<{ area_id: string; stop_id: string }>(sql`
    SELECT area_id, stop_id FROM gtfs_stop_areas WHERE feed_id = ${feed}::uuid ORDER BY area_id, stop_id`)).rows;
  const esito: Record<string, string[]> = {};
  for (const r of righe) (esito[r.area_id] ??= []).push(r.stop_id);
  return esito;
}

const GIUSTE = {
  ancona_urban: ["A1", "A2"],
  falconara_urban: ["F1"],
  senigallia_urban: ["S1", "S2"],
  castelfidardo_urban: ["C1"],
  sassoferrato_urban: ["X1"],
  /* la zona di una linea extraurbana, compilata da un'altra parte del programma */
  extra_zona_1: ["S1"],
};

/** Come lasciava le zone il codice di prima: tutto quello che non è Ancona o Jesi in «Falconara». */
async function comePrima() {
  await db.execute(sql`DELETE FROM gtfs_stop_areas WHERE feed_id = ${F}::uuid`);
  await db.execute(sql`INSERT INTO gtfs_stop_areas (feed_id, area_id, stop_id) VALUES
    (${F}::uuid, 'ancona_urban', 'A1'), (${F}::uuid, 'ancona_urban', 'A2'),
    (${F}::uuid, 'falconara_urban', 'F1'),
    (${F}::uuid, 'falconara_urban', 'S1'), (${F}::uuid, 'falconara_urban', 'S2'),
    (${F}::uuid, 'falconara_urban', 'C1'), (${F}::uuid, 'falconara_urban', 'X1'),
    (${F}::uuid, 'extra_zona_1', 'S1')`);
}

describe.runIf(!!process.env.TEST_DATABASE_URL)("le zone urbane, sul database", () => {
  beforeAll(async () => {
    /* le reti dell'azienda di prova: sei urbane, ognuna con la sua zona */
    conLeRetiDiProva();
    await pulisci();
    for (const feed of [F, ALTRO]) {
      await db.execute(sql`INSERT INTO gtfs_feeds (id, filename, is_active) VALUES (${feed}::uuid, ${`zone-6.6-${feed.slice(-2)}.synthetic`}, false)`);
    }
    for (const stop of FERMATE) {
      await db.execute(sql`INSERT INTO gtfs_stops (feed_id, stop_id, stop_name, stop_lat, stop_lon) VALUES (${F}::uuid, ${stop}, ${`Fermata ${stop}`}, 43.6, 13.5)`);
    }
    for (const [linea, [nome, rete, fermate]] of Object.entries(LINEE)) {
      await db.execute(sql`INSERT INTO gtfs_routes (feed_id, route_id, route_short_name) VALUES (${F}::uuid, ${linea}, ${nome})`);
      await db.execute(sql`INSERT INTO gtfs_route_networks (feed_id, route_id, network_id) VALUES (${F}::uuid, ${linea}, ${rete})`);
      await db.execute(sql`INSERT INTO gtfs_trips (feed_id, trip_id, route_id, service_id) VALUES (${F}::uuid, ${`T_${linea}`}, ${linea}, 'FER')`);
      for (const [i, stop] of fermate.entries()) {
        await db.execute(sql`INSERT INTO gtfs_stop_times (feed_id, trip_id, stop_id, stop_sequence) VALUES (${F}::uuid, ${`T_${linea}`}, ${stop}, ${i + 1})`);
      }
    }
    await db.execute(sql`INSERT INTO gtfs_fare_areas (feed_id, area_id, area_name, network_id, route_id) VALUES (${F}::uuid, 'extra_zona_1', 'Zona 1', 'extraurbano', 'L_EX')`);
    /* l'altro feed ha già una zona «Falconara» con una fermata sua */
    await db.execute(sql`INSERT INTO gtfs_stop_areas (feed_id, area_id, stop_id) VALUES (${ALTRO}::uuid, 'falconara_urban', 'S1')`);
    await comePrima();
  });

  afterAll(async () => {
    senzaReti();
    await pulisci();
    await pool.end();
  });

  it("prima della correzione: cinque fermate nella zona di Falconara, che ne ha una", async () => {
    expect((await zone()).falconara_urban).toEqual(["C1", "F1", "S1", "S2", "X1"]);
  });

  it("ogni fermata va nella zona della sua rete, e quelle nella zona sbagliata si tolgono", async () => {
    const esito = await assegnaZoneUrbane(F);
    expect(esito).toEqual({
      zone: 6,
      fermate: { ancona_urban: 2, jesi_urban: 0, falconara_urban: 1, senigallia_urban: 2, castelfidardo_urban: 1, sassoferrato_urban: 1 },
      aggiunte: 4,
      tolte: 4,
    });
    expect(await zone()).toEqual(GIUSTE);
  });

  it("le sei zone esistono, ognuna con il nome e la rete dell'elenco", async () => {
    const aree = (await db.execute<any>(sql`
      SELECT area_id, area_name, network_id FROM gtfs_fare_areas WHERE feed_id = ${F}::uuid AND network_id <> 'extraurbano' ORDER BY area_id`)).rows;
    expect(aree).toEqual([...retiUrbane()]
      .sort((a, b) => a.zona.localeCompare(b.zona))
      .map((r) => ({ area_id: r.zona, area_name: `Zona Urbana ${r.luogo}`, network_id: r.rete })));
  });

  it("rifarla non cambia niente", async () => {
    const esito = await assegnaZoneUrbane(F);
    expect([esito.aggiunte, esito.tolte]).toEqual([0, 0]);
    expect(await zone()).toEqual(GIUSTE);
  });

  it("non tocca le zone extraurbane né gli altri feed", async () => {
    expect((await zone()).extra_zona_1).toEqual(["S1"]);
    expect(await zone(ALTRO)).toEqual({ falconara_urban: ["S1"] });
  });

  it("segue l'assegnazione delle linee: una linea spostata di rete sposta le sue fermate", async () => {
    await db.execute(sql`UPDATE gtfs_route_networks SET network_id = 'urbano_jesi' WHERE feed_id = ${F}::uuid AND route_id = 'L_CF'`);
    const esito = await assegnaZoneUrbane(F);
    expect([esito.aggiunte, esito.tolte]).toEqual([1, 1]);
    const dopo = await zone();
    expect(dopo.jesi_urban).toEqual(["C1"]);
    expect(dopo.castelfidardo_urban).toBeUndefined();
    await db.execute(sql`UPDATE gtfs_route_networks SET network_id = 'urbano_castelfidardo' WHERE feed_id = ${F}::uuid AND route_id = 'L_CF'`);
    await assegnaZoneUrbane(F);
    expect(await zone()).toEqual(GIUSTE);
  });

  it("un'azienda senza reti urbane non ha zone urbane: non crea e non toglie niente", async () => {
    await comePrima();
    senzaReti();
    try {
      expect(await assegnaZoneUrbane(F)).toEqual({ zone: 0, fermate: {}, aggiunte: 0, tolte: 0 });
      expect((await zone()).falconara_urban).toEqual(["C1", "F1", "S1", "S2", "X1"]);
    } finally { conLeRetiDiProva(); }
    await assegnaZoneUrbane(F);
    expect(await zone()).toEqual(GIUSTE);
  });

  it("in un feed senza zone urbane, «solo se ci sono» non crea niente", async () => {
    expect(await assegnaZoneUrbane(ALTRO_VUOTO, { soloSeCiSono: true })).toEqual({ zone: 0, fermate: {}, aggiunte: 0, tolte: 0 });
    expect(await zone(ALTRO_VUOTO)).toEqual({});
    expect((await db.execute(sql`SELECT 1 FROM gtfs_fare_areas WHERE feed_id = ${ALTRO_VUOTO}::uuid`)).rows).toEqual([]);
  });

  it("la generazione dai cluster tiene le zone urbane e le rimette a posto", async () => {
    await comePrima();
    await db.execute(sql`INSERT INTO gtfs_fare_zone_clusters (feed_id, cluster_id, cluster_name, centroid_lat, centroid_lon) VALUES (${F}::uuid, 'k1', 'Cluster di prova', 43.6, 13.5)`);
    await db.execute(sql`INSERT INTO gtfs_fare_zone_cluster_stops (feed_id, cluster_id, stop_id, stop_name, stop_lat, stop_lon) VALUES (${F}::uuid, 'k1', 'ORFANA', 'Fermata ORFANA', 43.6, 13.5)`);
    const r = await admin.post(`/api/fares/zone-clusters/generate-zones?feedId=${F}`).send({});
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect([r.body.areasCreated, r.body.stopsAssigned, r.body.urbanAreas, r.body.urbanStopsAdded, r.body.urbanStopsRemoved]).toEqual([1, 1, 6, 4, 4]);
    /* le zone extraurbane di prima le sostituisce con quelle dei cluster; le urbane sono giuste */
    const { extra_zona_1: _via, ...urbane } = GIUSTE;
    expect(await zone()).toEqual({ ...urbane, cluster_k1: ["ORFANA"] });
  });

  it("i tre modi di generare le zone passano tutti da qui", async () => {
    await db.execute(sql`DELETE FROM gtfs_stop_areas WHERE feed_id = ${F}::uuid AND area_id = 'cluster_k1'`);
    for (const modo of ["generate-all", "generate-all-direct", "generate-all-dominant"]) {
      await comePrima();
      const r = await admin.post(`/api/fares/zones/${modo}?feedId=${F}`).send({});
      expect(r.status, `${modo}: ${JSON.stringify(r.body)}`).toBe(200);
      expect([r.body.urbanAreas, r.body.urbanStopsAdded, r.body.urbanStopsRemoved], modo).toEqual([6, 4, 4]);
      expect(await zone(), modo).toEqual(GIUSTE);
    }
  });
});
