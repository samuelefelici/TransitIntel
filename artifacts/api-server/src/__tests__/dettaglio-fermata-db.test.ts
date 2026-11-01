/**
 * Il dettaglio fermata di Planning Studio su un database vero (TEST_DATABASE_URL,
 * migrato: in CI il job migrazioni-postgres). La query cercava `ps_clusters`,
 * tabella rinominata in ps_stop_clusters: Postgres rispondeva 42P01 e
 * l'endpoint 500, il pannello della fermata restava vuoto. Qui tutte e tre le
 * query dell'endpoint girano sullo schema delle migrazioni.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import router from "../lib/planning-studio-network";
import { appDiProva, utenteDiProva } from "./helpers/app-di-prova";

const UTENTE = "d0000000-0000-0000-0000-000000000001";
const PROG_A = "d0000000-0000-0000-0000-0000000000a1";
const PROG_B = "d0000000-0000-0000-0000-0000000000b1";
const NODO_A = "d0000000-0000-0000-0000-0000000000a2";
const NODO_B = "d0000000-0000-0000-0000-0000000000b2";
const FERMATA_NODO_A = "d0000000-0000-0000-0000-0000000000a3";
const FERMATA_NODO_B = "d0000000-0000-0000-0000-0000000000a4";
const FERMATA_SENZA_NODO = "d0000000-0000-0000-0000-0000000000a5";

const app = appDiProva(router, utenteDiProva(UTENTE));
const dettaglio = (progetto: string, fermata: string) =>
  request(app).get(`/api/planning-studio/projects/${progetto}/stops/${fermata}/detail`);

describe.runIf(!!process.env.TEST_DATABASE_URL)("dettaglio fermata di Planning Studio, sul database", () => {
  const pulisci = () => db.execute(sql`DELETE FROM ps_projects WHERE id IN (${PROG_A}::uuid, ${PROG_B}::uuid)`);

  beforeAll(async () => {
    await pulisci();
    await db.execute(sql`
      INSERT INTO ps_projects (id, owner_user_id, name)
      VALUES (${PROG_A}::uuid, ${UTENTE}::uuid, 'Prova A'), (${PROG_B}::uuid, ${UTENTE}::uuid, 'Prova B')
    `);
    await db.execute(sql`
      INSERT INTO ps_stop_clusters (id, project_id, code, name, kind)
      VALUES (${NODO_A}::uuid, ${PROG_A}::uuid, 'N1', 'Piazza Cavour', 'interchange'),
             (${NODO_B}::uuid, ${PROG_B}::uuid, 'N9', 'Nodo di un altro progetto', 'rest')
    `);
    /* la seconda fermata punta al nodo del progetto B: cluster_id non ha FK */
    await db.execute(sql`
      INSERT INTO ps_stops (id, project_id, code, name, lat, lon, cluster_id)
      VALUES (${FERMATA_NODO_A}::uuid, ${PROG_A}::uuid, '20001', 'Piazza Cavour 1', 43.6167, 13.5189, ${NODO_A}::uuid),
             (${FERMATA_NODO_B}::uuid, ${PROG_A}::uuid, '20002', 'Via Marconi', 43.6100, 13.5100, ${NODO_B}::uuid),
             (${FERMATA_SENZA_NODO}::uuid, ${PROG_A}::uuid, '20003', 'Via Flaminia', 43.6000, 13.5000, NULL)
    `);
  });

  afterAll(pulisci);

  it("una fermata con il suo nodo: 200, con il nodo", async () => {
    const r = await dettaglio(PROG_A, FERMATA_NODO_A);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.stop).toMatchObject({ id: FERMATA_NODO_A, code: "20001", name: "Piazza Cavour 1", lat: 43.6167, lon: 13.5189 });
    expect(r.body.cluster).toEqual({ id: NODO_A, code: "N1", name: "Piazza Cavour", kind: "interchange" });
    expect(r.body.routes).toEqual([]);
    expect(r.body.totalTripCount).toBe(0);
  });

  it("una fermata senza nodo: 200, nodo null", async () => {
    const r = await dettaglio(PROG_A, FERMATA_SENZA_NODO);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.cluster).toBeNull();
  });

  it("il nodo di un altro progetto non si vede", async () => {
    const r = await dettaglio(PROG_A, FERMATA_NODO_B);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.cluster).toBeNull();
  });

  it("la fermata chiesta sotto un altro progetto: 404; un id storto: 400", async () => {
    expect((await dettaglio(PROG_B, FERMATA_NODO_A)).status).toBe(404);
    expect((await dettaglio(PROG_A, "non-un-uuid")).status).toBe(400);
  });
});
