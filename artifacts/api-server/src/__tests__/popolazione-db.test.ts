/**
 * La popolazione senza doppio conteggio (tappa 6.30), su un database vero
 * (TEST_DATABASE_URL, migrato; in CI come cerbero_app).
 *
 * In census_sections scrivono due cose: lo script delle sezioni di censimento
 * (scripts/src/import-census-sections.ts, codici di 12 cifre) e l'import della
 * popolazione dei comuni (pulsante «Popolazione dei comuni» in
 * Sincronizzazione, /cron/population). Chi somma la popolazione somma tutte le
 * righe: con le une e le altre, gli abitanti si contavano due volte. Ora, se
 * ci sono le sezioni, i comuni non si aggiungono e quelli rimasti si tolgono.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { db, pool } from "@workspace/db";
import { sql } from "drizzle-orm";
import { syncCensusFromIstat } from "../routes/cron";
import { dimenticaTerritorio } from "../lib/territorio";
import { dimenticaAzienda } from "../lib/azienda";

const righe = async (q: ReturnType<typeof sql>) => (await db.execute<any>(q)).rows;
const tabella = async () =>
  (await righe(sql`SELECT istat_code, population FROM census_sections ORDER BY istat_code`)).map((r) => `${r.istat_code}:${r.population}`);
const totale = async () => Number((await righe(sql`SELECT COALESCE(SUM(population), 0)::int AS n FROM census_sections`))[0].n);

describe.runIf(!!process.env.TEST_DATABASE_URL)("la popolazione dei comuni e le sezioni di censimento, sul database", () => {
  let sezioniPrima: any[] = [];
  let comuniPrima: any[] = [];
  beforeAll(async () => {
    /* niente rete nei test: l'ISTAT «non risponde», vale la popolazione scritta nel territorio */
    vi.stubGlobal("fetch", async () => { throw new Error("niente rete nei test"); });
    sezioniPrima = (await righe(sql`SELECT to_jsonb(c) AS riga FROM census_sections c`)).map((r) => r.riga);
    comuniPrima = (await righe(sql`SELECT to_jsonb(t) AS riga FROM territorio_comuni t`)).map((r) => r.riga);
    await db.execute(sql`DELETE FROM census_sections`);
    await db.execute(sql`DELETE FROM territorio_comuni`);
    await db.execute(sql`
      INSERT INTO territorio_comuni (codice_istat, nome, lat, lng, area_km2, popolazione, sezione_censimento) VALUES
        ('099001', 'Prova 6.30 uno', 44.1, 12.1, 10, 1000, 'PROVA630'),
        ('099002', 'Prova 6.30 due', 44.2, 12.2, 20, 500, NULL)`);
    dimenticaTerritorio();
    dimenticaAzienda();
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    await db.execute(sql`DELETE FROM census_sections`);
    await db.execute(sql`DELETE FROM territorio_comuni`);
    for (const r of comuniPrima) await db.execute(sql`INSERT INTO territorio_comuni SELECT * FROM jsonb_populate_record(NULL::territorio_comuni, ${JSON.stringify(r)}::jsonb)`);
    for (const r of sezioniPrima) await db.execute(sql`INSERT INTO census_sections SELECT * FROM jsonb_populate_record(NULL::census_sections, ${JSON.stringify(r)}::jsonb)`);
    dimenticaTerritorio();
    await pool.end();
  });

  it("senza le sezioni: una riga per comune, con la popolazione del territorio", async () => {
    const r = await syncCensusFromIstat();
    expect(r).toMatchObject({ inserted: 2, source: "static-fallback" });
    expect(r.message).toMatch(/2 comuni aggiornati/);
    expect(await tabella()).toEqual(["C099002:500", "PROVA630:1000"]);
  });

  it("con le sezioni: i comuni non si aggiungono, quelli rimasti si tolgono, il resto non si tocca", async () => {
    /* come dopo lo script delle sezioni, se qualcuno ripremeva il pulsante: le sezioni e i comuni insieme */
    await db.execute(sql`
      INSERT INTO census_sections (istat_code, centroid_lng, centroid_lat, population, area_km2, density) VALUES
        ('990010000001', 12.1, 44.1, 600, 0.5, 1200), ('990010000002', 12.11, 44.11, 450, 0.4, 1125), ('ALTRO1', 12.3, 44.3, 7, 1, 7)`);
    expect(await totale()).toBe(1000 + 500 + 600 + 450 + 7);

    const r = await syncCensusFromIstat();
    expect(r).toMatchObject({ inserted: 0, source: "sezioni", sezioni: 2, comuniTolti: 2 });
    expect(r.message).toMatch(/Ci sono già 2 sezioni di censimento.*tolte 2 righe/);
    expect(await tabella()).toEqual(["990010000001:600", "990010000002:450", "ALTRO1:7"]);
    expect(await totale()).toBe(600 + 450 + 7);

    /* di nuovo: niente da togliere, niente da aggiungere */
    const ancora = await syncCensusFromIstat();
    expect(ancora).toMatchObject({ inserted: 0, source: "sezioni", sezioni: 2, comuniTolti: 0 });
    expect(ancora.message).not.toMatch(/tolte/);
    expect(await totale()).toBe(600 + 450 + 7);
  });
});
