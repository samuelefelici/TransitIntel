/**
 * Il traffico come dato dell'azienda (tappa 6.15, migrazione 0045) su un
 * database vero (TEST_DATABASE_URL; in CI come cerbero_app): i punti stradali
 * sono luoghi del territorio, la zona è un loro attributo, e con i punti e le
 * zone di prima le statistiche per zona sono quelle che dava la regola di
 * prima, scritta nel codice coi rettangoli di coordinate.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import adminRouter from "../routes/admin";
import { centriUrbani, dimenticaTerritorio, leggiLuoghi, MASSIMO_PUNTI_TRAFFICO } from "../lib/territorio";
import { dimenticaAzienda, leggiAzienda } from "../lib/azienda";
import { SENZA_ZONA, trafficoPerZona } from "../lib/traffico";
import { syncTrafficFromTomTom } from "../routes/cron";
import { appDiProva, utenteDiProva } from "./helpers/app-di-prova";
import { PUNTI_DI_PRIMA, ZONA_DI_PRIMA_SQL, ZONE_DI_PRIMA, zonaDiPrima } from "./helpers/traffico-di-prima";

const admin = request(appDiProva(adminRouter, utenteDiProva("e6150000-0000-4000-8000-000000000001", [], "admin")));
const P = "Prova 6.15 ";
const righe = async (q: ReturnType<typeof sql>) => (await db.execute<any>(q)).rows as any[];
const crea = (corpo: Record<string, unknown>) => admin.post("/api/admin/territorio/luoghi").send(corpo);

describe.runIf(!!process.env.TEST_DATABASE_URL)("il traffico dell'azienda, sul database", () => {
  const pulisci = async () => {
    await db.execute(sql`DELETE FROM traffic_snapshots WHERE segment_id LIKE ${P + "%"}`);
    await db.execute(sql`DELETE FROM territorio_luoghi WHERE nome LIKE ${P + "%"}`);
    dimenticaTerritorio();
  };
  beforeAll(pulisci);
  afterEach(pulisci);
  afterAll(() => { vi.unstubAllGlobals(); });

  /** Una rilevazione di un punto: velocità e velocità a strada libera, tante ore fa. */
  const rilevazione = (punto: string, lat: number, lng: number, velocita: number, libera: number, oreFa: number) => db.execute(sql`
    INSERT INTO traffic_snapshots (segment_id, lng, lat, speed, freeflow_speed, congestion_level, captured_at)
    VALUES (${punto}, ${lng}, ${lat}, ${velocita}, ${libera}, ${Math.max(0, 1 - velocita / libera)}, now() - make_interval(hours => ${oreFa}::integer))`);

  it("un punto stradale: la zona è sua, il nome è unico fra i punti, e solo fra i punti", async () => {
    const r = await crea({ nome: `${P}A14 nord`, uso: "traffico", lat: 43.64, lng: 13.43, zona: " Tangenziale " });
    expect(r.status).toBe(201);
    expect(r.body.luogo).toMatchObject({ nome: `${P}A14 nord`, uso: "traffico", zona: "Tangenziale", raggioM: null });
    expect((await leggiLuoghi("traffico")).find((l) => l.nome === `${P}A14 nord`)?.zona).toBe("Tangenziale");
    /* senza zona va bene: nella pagina sta in «Senza zona» */
    expect((await crea({ nome: `${P}SS16 sud`, uso: "traffico", lat: 43.58, lng: 13.49 })).body.luogo).toMatchObject({ zona: null });
    /* la zona e il raggio valgono ognuno per il suo uso */
    expect((await crea({ nome: `${P}meteo`, uso: "meteo", lat: 43.6, lng: 13.5, zona: "Centro" })).status).toBe(400);
    expect((await crea({ nome: `${P}x`, uso: "traffico", lat: 43.6, lng: 13.5, raggioM: 2000 })).status).toBe(400);
    /* due punti con lo stesso nome confonderebbero le rilevazioni */
    const doppio = await crea({ nome: `${P}A14 nord`, uso: "traffico", lat: 43.7, lng: 13.2 });
    expect(doppio.status).toBe(409);
    expect(doppio.body.error).toMatch(/C'è già un punto stradale/);
    /* un luogo di un altro uso può chiamarsi come un punto */
    expect((await crea({ nome: `${P}A14 nord`, uso: "meteo", lat: 43.64, lng: 13.43 })).status).toBe(201);
    /* e un punto non prende il nome di un altro nemmeno cambiandolo */
    const sud = (await leggiLuoghi("traffico")).find((l) => l.nome === `${P}SS16 sud`)!;
    expect((await admin.put(`/api/admin/territorio/luoghi/${sud.id}`).send({ nome: `${P}A14 nord`, uso: "traffico", lat: 43.58, lng: 13.49 })).status).toBe(409);
    /* cambiando uso la zona se ne va: resterebbe scritta dove non vale */
    expect((await admin.put(`/api/admin/territorio/luoghi/${r.body.luogo.id}`).send({ nome: `${P}A14 nord bis`, uso: "meteo", lat: 43.64, lng: 13.43, zona: "Tangenziale" })).status).toBe(400);
    expect((await admin.put(`/api/admin/territorio/luoghi/${r.body.luogo.id}`).send({ nome: `${P}A14 nord bis`, uso: "meteo", lat: 43.64, lng: 13.43 })).body.luogo)
      .toMatchObject({ uso: "meteo", zona: null });
  });

  it("un punto che cambia nome porta con sé le sue rilevazioni", async () => {
    const r = await crea({ nome: `${P}vecchio nome`, uso: "traffico", lat: 43.6, lng: 13.5, zona: `${P}Centro` });
    await rilevazione(`${P}vecchio nome`, 43.6, 13.5, 30, 50, 2);
    await rilevazione(`${P}vecchio nome`, 43.6, 13.5, 40, 50, 3);
    await rilevazione(`${P}altro punto`, 43.6, 13.5, 40, 50, 3);
    expect((await admin.put(`/api/admin/territorio/luoghi/${r.body.luogo.id}`).send({ nome: `${P}nuovo nome`, uso: "traffico", lat: 43.6, lng: 13.5, zona: `${P}Centro` })).status).toBe(200);
    expect(await righe(sql`SELECT segment_id, count(*)::int AS n FROM traffic_snapshots WHERE segment_id LIKE ${P + "%"} GROUP BY 1 ORDER BY 1`))
      .toEqual([{ segment_id: `${P}altro punto`, n: 1 }, { segment_id: `${P}nuovo nome`, n: 2 }]);
    /* e restano nella sua zona */
    expect((await trafficoPerZona()).find((z) => z.zone === `${P}Centro`)).toMatchObject({ samples: 2, avgSpeed: 35, avgFreeflow: 50, speedReduction: 30 });
  });

  it("con i punti e le zone di prima, il traffico per zona è quello che dava la regola di prima", async () => {
    /* i 37 punti di prima, ognuno con la zona della regola di prima e l'ordine della migrazione: le zone nell'ordine dei colori */
    const punti = [...PUNTI_DI_PRIMA].map((p) => ({ ...p, zona: zonaDiPrima(p.lat, p.lng) }))
      .sort((a, b) => ZONE_DI_PRIMA.indexOf(a.zona) - ZONE_DI_PRIMA.indexOf(b.zona));
    for (const [i, p] of punti.entries()) {
      await db.execute(sql`INSERT INTO territorio_luoghi (nome, uso, lat, lng, zona, ordine)
        VALUES (${P + p.punto}, 'traffico', ${p.lat}, ${p.lng}, ${P + p.zona}, ${1000 + 10 * i})`);
    }
    /* per ogni punto quattro rilevazioni recenti con numeri diversi, e una di 40 giorni fa che non conta */
    for (const [i, p] of PUNTI_DI_PRIMA.entries()) {
      for (const k of [0, 1, 2, 3]) await rilevazione(P + p.punto, p.lat, p.lng, 22 + ((i * 7 + k * 11) % 41), 70 + (i % 5) * 10, 1 + k * 30);
      await rilevazione(P + p.punto, p.lat, p.lng, 5, 90, 40 * 24);
    }
    const diPrima = await righe(sql`
      WITH zone_map AS (
        SELECT *, ${sql.raw(ZONA_DI_PRIMA_SQL)} AS zone_name -- scan-ok: testo fisso dei test, la regola di prima
          FROM traffic_snapshots
         WHERE captured_at > NOW() - INTERVAL '30 days' AND segment_id LIKE ${P + "%"}
      )
      SELECT zone_name, AVG(congestion_level) AS avg_congestion, AVG(speed) AS avg_speed, AVG(freeflow_speed) AS avg_freeflow, COUNT(*)::int AS samples
        FROM zone_map GROUP BY zone_name ORDER BY avg_congestion DESC`);
    expect(diPrima.map((z) => z.zone_name).sort()).toEqual([...ZONE_DI_PRIMA].sort());
    expect(diPrima.reduce((s, z) => s + z.samples, 0)).toBe(37 * 4);

    const oggi = (await trafficoPerZona()).filter((z) => z.zone.startsWith(P));
    expect(oggi.map((z) => z.zone.slice(P.length))).toEqual(diPrima.map((z) => z.zone_name));   // le stesse zone, nella stessa classifica
    for (const [i, z] of oggi.entries()) {
      const prima = diPrima[i]!;
      expect(z.samples, z.zone).toBe(prima.samples);
      expect(z.avgCongestion, z.zone).toBeCloseTo(Number(prima.avg_congestion), 10);
      expect(z.avgSpeed, z.zone).toBeCloseTo(Number(prima.avg_speed), 10);
      expect(z.avgFreeflow, z.zone).toBeCloseTo(Number(prima.avg_freeflow), 10);
      expect(z.speedReduction, z.zone).toBe(Math.round((1 - Number(prima.avg_speed) / Number(prima.avg_freeflow)) * 100));
    }
    /* l'ordine delle zone, da cui la pagina prende i colori, è quello di prima */
    expect([...oggi].sort((a, b) => a.ordine! - b.ordine!).map((z) => z.zone.slice(P.length))).toEqual([...ZONE_DI_PRIMA]);
  });

  it("una rilevazione senza zona sta in «Senza zona»: di un punto senza zona, o di un punto che non c'è più", async () => {
    const prima = (await trafficoPerZona()).find((z) => z.zone === SENZA_ZONA)?.samples ?? 0;
    await crea({ nome: `${P}senza`, uso: "traffico", lat: 43.6, lng: 13.5 });
    await rilevazione(`${P}senza`, 43.6, 13.5, 30, 60, 1);
    await rilevazione(`${P}punto tolto`, 43.6, 13.5, 30, 60, 1);
    const z = (await trafficoPerZona()).find((x) => x.zone === SENZA_ZONA)!;
    expect(z.samples).toBe(prima + 2);
    expect(z.ordine).toBeNull();
    /* la somma delle zone è il totale delle rilevazioni dei 30 giorni */
    const totale = Number((await righe(sql`SELECT count(*)::int AS n FROM traffic_snapshots WHERE captured_at > NOW() - INTERVAL '30 days'`))[0].n);
    expect((await trafficoPerZona()).reduce((s, x) => s + x.samples, 0)).toBe(totale);
  });

  it("il giro del traffico interroga i punti dell'azienda, e le rilevazioni portano il loro nome", async () => {
    await crea({ nome: `${P}uno`, uso: "traffico", lat: 43.1234, lng: 13.4321, zona: `${P}Zona` });
    await crea({ nome: `${P}due`, uso: "traffico", lat: 43.5678, lng: 13.8765 });
    await crea({ nome: `${P}non un punto`, uso: "meteo", lat: 43.9, lng: 13.9 });
    const tutti = (await leggiLuoghi("traffico")).length;
    const chieste: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      chieste.push(String(url));
      return { ok: true, json: async () => ({ flowSegmentData: { currentSpeed: 30, freeFlowSpeed: 40 } }) } as any;
    }));
    const chiave = process.env.TOMTOM_API_KEY;
    process.env.TOMTOM_API_KEY = "chiave-di-prova";
    try {
      expect(await syncTrafficFromTomTom()).toEqual({ inserted: tutti, failed: 0 });
    } finally {
      vi.unstubAllGlobals();
      if (chiave === undefined) delete process.env.TOMTOM_API_KEY; else process.env.TOMTOM_API_KEY = chiave;
    }
    expect(chieste).toHaveLength(tutti);
    expect(chieste.filter((u) => u.includes("point=43.1234,13.4321") || u.includes("point=43.5678,13.8765"))).toHaveLength(2);
    expect(chieste.some((u) => u.includes("point=43.9,13.9"))).toBe(false);
    expect(await righe(sql`SELECT segment_id, lat, lng, speed, freeflow_speed, congestion_level FROM traffic_snapshots WHERE segment_id LIKE ${P + "%"} ORDER BY 1`)).toEqual([
      { segment_id: `${P}due`, lat: 43.5678, lng: 13.8765, speed: 30, freeflow_speed: 40, congestion_level: 0.25 },
      { segment_id: `${P}uno`, lat: 43.1234, lng: 13.4321, speed: 30, freeflow_speed: 40, congestion_level: 0.25 },
    ]);
  });

  it("al più cento punti stradali", async () => {
    const giaCi = (await leggiLuoghi("traffico")).length;
    await db.execute(sql`INSERT INTO territorio_luoghi (nome, uso, lat, lng, ordine)
      SELECT ${P + "pieno "} || n, 'traffico', 43.5, 13.5, 9000 FROM generate_series(1, ${MASSIMO_PUNTI_TRAFFICO - giaCi}::integer) AS n`);
    dimenticaTerritorio();
    const r = await crea({ nome: `${P}uno di troppo`, uso: "traffico", lat: 43.6, lng: 13.5 });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/sono già 100, il massimo/);
    /* nemmeno facendo diventare punto un altro luogo; gli altri usi non hanno limite */
    const meteo = await crea({ nome: `${P}meteo`, uso: "meteo", lat: 43.6, lng: 13.5 });
    expect(meteo.status).toBe(201);
    expect((await admin.put(`/api/admin/territorio/luoghi/${meteo.body.luogo.id}`).send({ nome: `${P}meteo`, uso: "traffico", lat: 43.6, lng: 13.5 })).status).toBe(409);
  });

  it("i centri del modello: i centri urbani scritti; senza, il centro delle mappe dell'azienda", async () => {
    const scritti = (await leggiLuoghi("centro_urbano")).map((c) => ({ lat: c.lat, lng: c.lng }));
    if (!scritti.length) {
      dimenticaAzienda();
      const { centro } = await leggiAzienda();
      expect(await centriUrbani()).toEqual([{ lat: centro.lat, lng: centro.lng }]);
    }
    await crea({ nome: `${P}centro`, uso: "centro_urbano", lat: 44.4, lng: 11.3 });
    const dopo = await centriUrbani();
    expect(dopo).toHaveLength(scritti.length + 1);
    expect(dopo).toContainEqual({ lat: 44.4, lng: 11.3 });
  });
});
