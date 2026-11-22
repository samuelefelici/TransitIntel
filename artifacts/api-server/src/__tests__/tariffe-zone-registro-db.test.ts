/**
 * Le tariffe a zone e il registro delle modifiche (tappa 7.19), sul database
 * (TEST_DATABASE_URL; in CI come cerbero_app, col registro acceso).
 *
 * Prima la generazione delle zone dai cluster scriveva una riga per volta,
 * senza transazione: con 120 fermate, 120 istruzioni e altrettante righe di
 * registro. Ora cancella e rifà in una transazione, a insiemi, e nel registro
 * resta qualche riepilogo, di chi ha lanciato la generazione.
 *
 * Se il registro è spento (in locale, di solito) le verifiche sul registro si
 * saltano; quelle sui dati no.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { Router } from "express";
import { db } from "@workspace/db";
import { contestoDb } from "@workspace/db/contesto";
import { sql } from "drizzle-orm";
import faresRouter from "../routes/fares";
import { leggiRegistro, statoRegistro, Parametri } from "../lib/registro-modifiche";
import { appDiProva, utenteDiProva } from "./helpers/app-di-prova";
import { conLeFasceDiProva, senzaFasce } from "./helpers/fasce-di-prova";

const u = (n: number) => `e7e00000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [ADMIN, F] = [u(1), u(2)];
const RICHIESTA = "r-zone-7-19";
const PER_CLUSTER = 60;

/* come requireAuth nell'app vera: ogni richiesta porta chi la fa */
const router = Router();
router.use((_req, _res, next) => contestoDb.run({ attore: ADMIN, via: "api", richiesta: RICHIESTA }, next));
router.use(faresRouter);
const admin = request(appDiProva(router, utenteDiProva(ADMIN, [], "admin")));

async function pulisci() {
  for (const t of ["gtfs_fare_leg_rules", "gtfs_fare_zone_cluster_stops", "gtfs_fare_zone_clusters", "gtfs_stop_areas", "gtfs_fare_areas"]) {
    await db.execute(sql`DELETE FROM ${sql.identifier(t)} WHERE feed_id = ${F}::uuid`);
  }
  await db.execute(sql`DELETE FROM gtfs_feeds WHERE id = ${F}::uuid`);
  await db.execute(sql`DELETE FROM users WHERE id = ${ADMIN}::uuid`);
}

async function conta(tabella: string): Promise<number> {
  const r = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM ${sql.identifier(tabella)} WHERE feed_id = ${F}::uuid`);
  return r.rows[0].n;
}

describe.runIf(!!process.env.TEST_DATABASE_URL)("le tariffe a zone e il registro, sul database", () => {
  beforeAll(async () => {
    /* le fasce chilometriche danno le regole fra i due nodi */
    conLeFasceDiProva();
    await pulisci();
    await db.execute(sql`INSERT INTO users (id, email, password_hash, role) VALUES (${ADMIN}::uuid, 'zone@prova.local', 'x', 'admin')`);
    await db.execute(sql`INSERT INTO gtfs_feeds (id, filename, is_active) VALUES (${F}::uuid, 'zone-7-19.synthetic', false)`);
    /* due cluster a una ventina di km, con 60 fermate ciascuno */
    await db.execute(sql`INSERT INTO gtfs_fare_zone_clusters (feed_id, cluster_id, cluster_name, centroid_lat, centroid_lon) VALUES
      (${F}::uuid, 'k1', 'Nodo uno', 40 + 1 / 10.0, 10 + 1 / 10.0),
      (${F}::uuid, 'k2', 'Nodo due', 40 + 3 / 10.0, 10 + 1 / 10.0)`);
    await db.execute(sql`
      INSERT INTO gtfs_fare_zone_cluster_stops (feed_id, cluster_id, stop_id, stop_name, stop_lat, stop_lon)
      SELECT ${F}::uuid, c.cluster_id, c.cluster_id || '_' || g, 'Fermata ' || g, 40 + 1 / 10.0, 10 + 1 / 10.0
        FROM (VALUES ('k1'), ('k2')) AS c(cluster_id), generate_series(1, ${PER_CLUSTER}) AS g`);
    /* zone e regole extraurbane di prima: la generazione le sostituisce */
    await db.execute(sql`INSERT INTO gtfs_fare_areas (feed_id, area_id, area_name, network_id) VALUES (${F}::uuid, 'vecchia', 'Zona vecchia', 'extraurbano')`);
    await db.execute(sql`INSERT INTO gtfs_stop_areas (feed_id, area_id, stop_id) VALUES (${F}::uuid, 'vecchia', 'k1_1')`);
    await db.execute(sql`INSERT INTO gtfs_fare_leg_rules (feed_id, leg_group_id, network_id, from_area_id, to_area_id, fare_product_id) VALUES (${F}::uuid, 'lg_extra', 'extraurbano', 'vecchia', 'vecchia', 'extra_fascia_1')`);
  });
  afterAll(async () => { await pulisci(); senzaFasce(); });

  it("la generazione dai cluster rifà zone, fermate e regole tutte insieme", async () => {
    const r = await admin.post(`/api/fares/zone-clusters/generate-zones?feedId=${F}`).send({});
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect([r.body.areasCreated, r.body.stopsAssigned]).toEqual([2, 2 * PER_CLUSTER]);

    const aree = await db.execute<{ area_id: string }>(sql`SELECT area_id FROM gtfs_fare_areas WHERE feed_id = ${F}::uuid ORDER BY area_id`);
    expect(aree.rows.map((a) => a.area_id)).toEqual(["cluster_k1", "cluster_k2"]);
    expect(await conta("gtfs_stop_areas")).toBe(2 * PER_CLUSTER);
    /* le regole sono quelle nuove (una per verso, se la distanza cade in una fascia), mai la vecchia */
    expect(await conta("gtfs_fare_leg_rules")).toBe(r.body.odRules);
    const vecchie = await db.execute(sql`SELECT 1 FROM gtfs_fare_leg_rules WHERE feed_id = ${F}::uuid AND from_area_id = 'vecchia'`);
    expect(vecchie.rows).toEqual([]);

    if (!(await statoRegistro()).attivo) return;
    const pagina = await leggiRegistro(Parametri.parse({ ambitoTipo: "feed", ambitoId: F }));
    if ("errore" in pagina) throw new Error(pagina.errore);
    const righe = pagina.righe.filter((x) => x.richiesta === RICHIESTA);
    /* poche righe di riepilogo, non una per fermata */
    expect(righe.length).toBeGreaterThan(0);
    expect(righe.length).toBeLessThanOrEqual(10);
    expect(righe.every((x) => x.riepilogo && x.attore?.id === ADMIN && x.via === "api")).toBe(true);
    const fermate = righe.find((x) => x.tabella === "public.gtfs_stop_areas" && x.operazione === "INSERT");
    expect(fermate?.righe).toBe(2 * PER_CLUSTER);
  });
});
