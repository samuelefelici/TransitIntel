/**
 * Il report mensile del consuntivo (tappa 4.7), su un database vero
 * (TEST_DATABASE_URL; in CI come cerbero_app).
 *
 * Giugno 2026: due giornate chiuse e una aperta (fuori dal report). Sei corse
 * con tutti gli esiti, due causali (una non imputabile), due linee di
 * Planning Studio con tipo di servizio e contratto, due vetture (Conerobus e
 * una consorziata), un percorso a metà dentro un comune. I numeri attesi sono
 * fatti a mano.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import esercizioRouter from "../routes/esercizio";
import { reportDelMese, reportXlsx, dettaglioCsv } from "../lib/esercizio-report";
import { aziendaDaSiri } from "../lib/parco-anagrafica";
import { dimenticaAzienda, leggiAzienda } from "../lib/azienda";
import { appDiProva, utenteDiProva } from "./helpers/app-di-prova";

const u = (n: number) => `d4700000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const UTENTE = u(1), P = u(2), R1 = u(3), R2 = u(4), F = u(5);
const MESE = "2026-06", [G1, G2, G3] = ["2026-06-02", "2026-06-03", "2026-06-04"];
const COMUNE = "Comune di prova 4.7";
const CONSORZIATA = "10123";

describe.runIf(!!process.env.TEST_DATABASE_URL)("il report mensile, sul database", () => {
  const pulisci = async () => {
    await db.execute(sql`DELETE FROM esercizio_giornate WHERE giorno IN (${G1}::date, ${G2}::date, ${G3}::date)`);
    await db.execute(sql`DELETE FROM zones WHERE name = ${COMUNE}`);
    await db.execute(sql`DELETE FROM gtfs_shapes WHERE feed_id = ${F}::uuid`);
    await db.execute(sql`DELETE FROM gtfs_feeds WHERE id = ${F}::uuid`);
    await db.execute(sql`DELETE FROM ps_routes WHERE project_id = ${P}::uuid`);
    await db.execute(sql`DELETE FROM ps_projects WHERE id = ${P}::uuid`);
    await db.execute(sql`DELETE FROM users WHERE id = ${UTENTE}::uuid`);
  };

  let aziendaDiPrima: unknown[] = [];
  beforeAll(async () => {
    await pulisci();
    /* il vettore di una vettura è l'azienda o una consorziata: la regola e il nome sono dati
     * dell'azienda (tappa 6.5), e il test li mette */
    aziendaDiPrima = (await db.execute<any>(sql`SELECT to_jsonb(a) AS riga FROM azienda a`)).rows.map((r) => r.riga);
    await db.execute(sql`DELETE FROM azienda`);
    await db.execute(sql`INSERT INTO azienda (ragione_sociale, nome, gtfs_agency_id, citta, centro_lat, centro_lng, zoom, avm_matricola_cifre)
                         VALUES ('Conerobus S.p.A.', 'Conerobus', 'conerobus', 'Ancona', 43.6, 13.5, 10, 4)`);
    dimenticaAzienda();
    await leggiAzienda();
    await db.execute(sql`INSERT INTO users (id, email, password_hash, role) VALUES (${UTENTE}::uuid, 'report@prova.local', 'x', 'user')`);
    await db.execute(sql`INSERT INTO ps_projects (id, owner_user_id, name) VALUES (${P}::uuid, ${UTENTE}::uuid, 'Programma report 4.7')`);
    await db.execute(sql`INSERT INTO ps_routes (id, project_id, short_name, service_type, contract_id) VALUES
      (${R1}::uuid, ${P}::uuid, '1', 'urban', 'LOTTO-1'), (${R2}::uuid, ${P}::uuid, '2', 'extraurban', NULL)`);
    await db.execute(sql`INSERT INTO gtfs_feeds (id, filename, is_active) VALUES (${F}::uuid, 'report-4.7.synthetic', false)`);
    // un percorso dritto da sud a nord; il comune ne copre la metà sud
    await db.execute(sql`INSERT INTO gtfs_shapes (feed_id, shape_id, geojson) VALUES
      (${F}::uuid, 'S1', ${JSON.stringify({ type: "LineString", coordinates: [[13.5, 43.60], [13.5, 43.62]] })}::jsonb)`);
    await db.execute(sql`INSERT INTO zones (name, istat_code, geometry) VALUES (${COMUNE}, '099999',
      ${JSON.stringify({ type: "Polygon", coordinates: [[[13.4, 43.59], [13.6, 43.59], [13.6, 43.61], [13.4, 43.61], [13.4, 43.59]]] })}::jsonb)`);
    for (const [g, stato] of [[G1, "chiusa"], [G2, "chiusa"], [G3, "congelata"]] as const) {
      await db.execute(sql`INSERT INTO esercizio_giornate (giorno, stato, feed_id, corse, preparata_il, congelata_il, chiusa_il, riepilogo, turni)
        VALUES (${g}::date, ${stato}, ${F}::uuid, 0, now(), now(), ${stato === "chiusa" ? sql`now()` : sql`NULL`},
                ${stato === "chiusa" ? sql`'{}'::jsonb` : sql`NULL`}, '{}'::jsonb)`);
    }
    await db.execute(sql`INSERT INTO esercizio_corse (giorno, chiave, numero, linea, route_id, shape_id, partenza, origine, tipo_aggiunta,
                                                     esito, km_prog, km_eff, causale, vettura, prove, confermata_il) VALUES
      (${G1}::date, 'r-a', '1', '1', ${R1}, 'S1', '07:00:00', 'programmata', NULL, 'effettuata', 2, 2, NULL, '301', '{"ritardoPartenza": 60}'::jsonb, now()),
      (${G1}::date, 'r-b', '2', '1', ${R1}, 'S1', '08:00:00', 'programmata', NULL, 'presunta', 2, 2, NULL, NULL, NULL, now()),
      (${G1}::date, 'r-c', '3', '1', ${R1}, 'S1', '09:00:00', 'programmata', NULL, 'soppressa', 2, 0, 'SCIOPERO', NULL, NULL, now()),
      (${G1}::date, 'r-d', '4', '2', ${R2}, NULL, '10:00:00', 'programmata', NULL, 'parziale', 2, 1, 'GUASTO_MEZZO', ${CONSORZIATA}, '{"ritardoPartenza": 400}'::jsonb, now()),
      (${G2}::date, 'r-e', '5', '2', ${R2}, NULL, '07:00:00', 'programmata', NULL, 'effettuata', 2, 2, NULL, '301', '{"ritardoPartenza": -120}'::jsonb, now()),
      (${G2}::date, 'agg:r-f', 'agg', '1', NULL, NULL, '13:00:00', 'aggiunta', 'bis', 'effettuata', NULL, 3, NULL, NULL, NULL, now()),
      (${G3}::date, 'r-g', '6', '1', ${R1}, 'S1', '07:00:00', 'programmata', NULL, 'effettuata', 2, 2, NULL, '301', NULL, now())`);
  });
  afterAll(async () => {
    await pulisci();
    await db.execute(sql`DELETE FROM azienda`);
    for (const riga of aziendaDiPrima) {
      await db.execute(sql`INSERT INTO azienda SELECT * FROM jsonb_populate_record(NULL::azienda, ${JSON.stringify(riga)}::jsonb)`);
    }
    dimenticaAzienda();
  });

  it("totali e indicatori sulle sole giornate chiuse", async () => {
    const r = await reportDelMese(MESE);
    expect(r.giornate).toMatchObject({ delMese: 30, chiuse: 2, aperte: [G3] });
    expect(r.giornate.mancanti).toHaveLength(27);
    expect(r.totali).toMatchObject({
      programmate: 5, effettuate: 2, presunte: 1, parziali: 1, soppresse: 1, aggiunte: 1,
      kmProgrammati: 10, kmEffettivi: 7, kmPersi: 3, kmAggiunti: 3,
    });
    expect(r.indicatori).toEqual({
      regolaritaCorse: { lorda: 60, netta: 75 },
      regolaritaKm: { lorda: 70, netta: 87.5 },
      quotaProvata: 40,
      puntualita: { campione: 3, inOrario: 1, quota: 33.3, copertura: 60 },
    });
  });

  it("le ripartizioni: linea, servizio, contratto, causale, giorno, vettore", async () => {
    const r = await reportDelMese(MESE);
    const per = (l: any[], k: string) => Object.fromEntries(l.map((x) => [String(x[k]), [x.programmate, x.aggiunte]]));
    expect(per(r.perLinea, "linea")).toEqual({ 1: [3, 1], 2: [2, 0] });
    expect(per(r.perServizio, "servizio")).toEqual({ urban: [3, 0], extraurban: [2, 0], null: [0, 1] });
    expect(per(r.perContratto, "contratto")).toEqual({ "LOTTO-1": [3, 0], null: [2, 1] });
    expect(per(r.perGiorno, "giorno")).toEqual({ [G1]: [4, 0], [G2]: [1, 1] });
    // a parità di corse, in ordine di codice
    expect(r.perCausale).toEqual([
      expect.objectContaining({ causale: "GUASTO_MEZZO", imputabile: true, parziali: 1, kmPersi: 1 }),
      expect.objectContaining({ causale: "SCIOPERO", imputabile: false, soppresse: 1, kmPersi: 2 }),
    ]);
    const vettori = Object.fromEntries(r.perVettore.map((v: any) => [v.vettore, v.programmate + v.aggiunte]));
    expect(vettori).toEqual({ Conerobus: 2, [aziendaDaSiri(CONSORZIATA) ?? "Vettura non attribuita"]: 1, "Vettura non indicata": 3 });
  });

  it("per comune: il ritaglio del percorso sui confini, programmati e fatti", async () => {
    const r = await reportDelMese(MESE);
    const c = r.perComune.find((x: any) => x.comune === COMUNE)!;
    // tre corse sul percorso S1 (6 km programmati, 4 fatti), metà dentro il comune
    expect(c.kmProgrammati).toBeCloseTo(3, 0);
    expect(c.kmEffettivi).toBeCloseTo(2, 0);
    expect(c.regolaritaKm).toBeCloseTo(66.7, 0);
    // l'altra metà di S1 fuori dai confini, le corse della linea 2 senza percorso: la somma torna coi km del mese
    const riga = (nome: string) => r.perComune.find((x: any) => x.comune === nome)!;
    expect(riga("Fuori dai confini importati").kmProgrammati).toBeCloseTo(3, 0);
    expect(riga("Corse senza percorso")).toMatchObject({ kmProgrammati: 4, kmEffettivi: 3 });
    const somma = r.perComune.reduce((t: number, x: any) => t + x.kmProgrammati, 0);
    expect(somma).toBeCloseTo(r.totali.kmProgrammati, 1);
  });

  it("l'XLSX e il CSV del dettaglio", async () => {
    const x = reportXlsx(await reportDelMese(MESE), "Azienda di prova");
    expect(x.subarray(0, 2).toString()).toBe("PK");
    let csv = "";
    const n = await dettaglioCsv(MESE, (p) => { csv += p; });
    expect(n).toBe(6);
    const righe = csv.replace(/^﻿/, "").trim().split("\r\n");
    expect(righe[0]).toMatch(/^giorno;linea;numero;codice;partenza/);
    expect(righe).toHaveLength(7);
    const d = righe.find((r) => r.includes(";4;"))!;
    expect(d).toContain(";parziale;GUASTO_MEZZO;si;2;1;");
    expect(d).toContain(";6,7;"); // 400 secondi di ritardo, in minuti con la virgola
  });

  it("dall'API: report, XLSX e CSV; un mese sbagliato è un 400", async () => {
    const app = appDiProva(esercizioRouter, utenteDiProva(UTENTE, [], "user", { ruoli: ["pianificatore"] }));
    const j = await request(app).get(`/api/esercizio/mesi/${MESE}/report`);
    expect(j.status).toBe(200);
    expect(j.body.totali.programmate).toBe(5);
    const x = await request(app).get(`/api/esercizio/mesi/${MESE}/report.xlsx`).buffer(true).parse((res, cb) => {
      const parti: Buffer[] = []; res.on("data", (b: Buffer) => parti.push(b)); res.on("end", () => cb(null, Buffer.concat(parti)));
    });
    expect(x.status).toBe(200);
    expect(x.headers["content-type"]).toMatch(/spreadsheetml/);
    expect(x.headers["content-disposition"]).toContain(`consuntivo-${MESE}.xlsx`);
    const c = await request(app).get(`/api/esercizio/mesi/${MESE}/dettaglio.csv`);
    expect(c.status).toBe(200);
    expect(c.headers["content-type"]).toMatch(/text\/csv/);
    expect(c.text.split("\r\n").filter(Boolean)).toHaveLength(7);
    expect((await request(app).get(`/api/esercizio/mesi/2026-6/report`)).status).toBe(400);
  });
});
