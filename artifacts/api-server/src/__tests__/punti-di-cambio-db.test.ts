/**
 * I punti di cambio dei turni guida sul database (tappa 6.17; in CI come
 * cerbero_app): vengono dalla tabella dei punti dell'azienda, e senza punti
 * non ce n'è nessuno (prima valevano sei punti di Ancona scritti nel codice).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { loadClustersForPython, puntiDiCambio } from "../lib/dati-solver";

const P = "Prova 6.17 ";

describe.runIf(!!process.env.TEST_DATABASE_URL)("i punti di cambio dei turni guida, sul database", () => {
  const pulisci = () => db.execute(sql`DELETE FROM stop_clusters WHERE name LIKE ${P + "%"}`);
  beforeAll(pulisci);
  afterAll(pulisci);

  it("sono i punti dell'azienda, con i nomi delle loro fermate; senza punti, nessuno", async () => {
    const giaCi = (await puntiDiCambio()).length;
    if (giaCi === 0) {
      expect(await loadClustersForPython()).toEqual([]);
      expect(await puntiDiCambio()).toEqual([]);
    }
    const r = await db.execute<any>(sql`
      INSERT INTO stop_clusters (name, transfer_from_depot_min) VALUES (${P + "Piazza"}, 12) RETURNING id`);
    const id = String(r.rows[0].id);
    await db.execute(sql`
      INSERT INTO stop_cluster_stops (cluster_id, gtfs_stop_id, stop_name, stop_lat, stop_lon)
      VALUES (${id}::uuid, 'S1', 'Piazza di Prova A', 44.5, 11.3), (${id}::uuid, 'S2', 'Piazza di Prova B', 44.5, 11.31)`);
    const punti = await puntiDiCambio();
    expect(punti).toHaveLength(giaCi + 1);
    const punto = punti.find((p) => p.id === id)!;
    expect(punto).toMatchObject({ id, name: `${P}Piazza`, transferFromDepotMin: 12 });
    expect([...punto.stopNames].sort()).toEqual(["Piazza di Prova A", "Piazza di Prova B"]);
    const perIlSolver = (await loadClustersForPython()).find((c) => c.id === id);
    expect(perIlSolver.keywords).toEqual([]);
    expect([...perIlSolver.stopIds].sort()).toEqual(["S1", "S2"]);
  });
});
