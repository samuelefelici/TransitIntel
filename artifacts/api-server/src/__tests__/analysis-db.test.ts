/**
 * La pagina delle analisi sul database (tappa 7.15; TEST_DATABASE_URL, in CI
 * come cerbero_app): le fermate vengono dal feed in esercizio. Prima le
 * leggeva da bus_stops, una tabella del primo modello sempre vuota: zero
 * fermate, copertura 0% e ogni sezione popolosa «scoperta».
 *
 * Un feed in esercizio con due fermate vicine fra loro; una sezione di
 * censimento a 100 m dalle fermate (coperta), una a una decina di km
 * (scoperta). Le altre righe del database di prova non si toccano: i conti si
 * confrontano con quelli di prima delle sezioni nuove.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import analysisRouter from "../routes/analysis";
import { appDiProva, utenteDiProva } from "./helpers/app-di-prova";

const u = (n: number) => `e7c00000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [UTENTE, FEED, S1, S2, VICINA, LONTANA] = [u(1), u(2), u(3), u(4), u(5), u(6)];
const POP_VICINA = 70_001;
const POP_LONTANA = 90_001;

const router = Router();
router.use(analysisRouter);
const app = request(appDiProva(router, utenteDiProva(UTENTE, ["analytics"])));
/* le risposte stanno in una cache per indirizzo: un parametro diverso per ogni lettura */
let letture = 0;
const leggi = (via: string, extra = "") => app.get(`/api/analysis/${via}?n=${++letture}${extra}`);

async function pulisci() {
  await db.execute(sql`DELETE FROM census_sections WHERE id IN (${VICINA}::uuid, ${LONTANA}::uuid)`);
  await db.execute(sql`DELETE FROM gtfs_feeds WHERE id = ${FEED}::uuid`);
}

describe.runIf(!!process.env.TEST_DATABASE_URL)("la pagina delle analisi, sul database", () => {
  let prima: any;

  beforeAll(async () => {
    await pulisci();
    /* il feed in esercizio più recente di tutti: è quello delle analisi */
    await db.execute(sql`INSERT INTO gtfs_feeds (id, filename, is_active, uploaded_at) VALUES (${FEED}::uuid, 'analisi-7-15.zip', true, '2099-01-01T00:00:00Z')`);
    await db.execute(sql`INSERT INTO gtfs_stops (id, feed_id, stop_id, stop_name, stop_lat, stop_lon) VALUES
      (${S1}::uuid, ${FEED}::uuid, 'A1', 'Piazza', 40 + 1 / 1000.0, 10 + 1 / 1000.0),
      (${S2}::uuid, ${FEED}::uuid, 'A2', 'Borgo', 40 + 2 / 1000.0, 10 + 2 / 1000.0)`);
    prima = (await leggi("stats")).body;
  });
  afterAll(pulisci);

  it("le fermate sono quelle del feed in esercizio", async () => {
    expect(prima.totalStops).toBe(2);
  });

  it("una sezione vicina alle fermate è coperta, una lontana no", async () => {
    await db.execute(sql`INSERT INTO census_sections (id, istat_code, centroid_lat, centroid_lng, population, area_km2, density) VALUES
      (${VICINA}::uuid, 'T715-1', 40 + 2 / 1000.0, 10 + 3 / 1000.0, ${POP_VICINA}, 1, 5000),
      (${LONTANA}::uuid, 'T715-2', 40 + 1 / 10.0, 10 + 1 / 10.0, ${POP_LONTANA}, 1, 5000)`);
    const dopo = (await leggi("stats")).body;
    expect(dopo.totalStops).toBe(2);
    expect(dopo.totalPopulation - prima.totalPopulation).toBe(POP_VICINA + POP_LONTANA);
    expect(dopo.coveredPopulation - prima.coveredPopulation).toBe(POP_VICINA);
    expect(dopo.underservedCount - prima.underservedCount).toBe(1);

    const scoperte = (await leggi("underserved", "&minScore=0.1")).body.data as any[];
    const popolazioni = scoperte.map((s) => s.populationAffected);
    expect(popolazioni).toContain(POP_LONTANA);
    expect(popolazioni).not.toContain(POP_VICINA);
  });
});
