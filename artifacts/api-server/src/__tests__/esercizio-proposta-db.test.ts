/**
 * La proposta dall'AVM (tappa 4.4), su un database vero (TEST_DATABASE_URL;
 * in CI come cerbero_app).
 *
 * Una giornata congelata con quattro corse, le loro fermate nel feed, i
 * passaggi di SIRI e i viaggi dichiarati dall'AVM:
 *  - T1 vista per intero: effettuata (AVM);
 *  - T2 solo dichiarata, riconosciuta per numero (e un passaggio di un'altra
 *    sorgente, che non conta): da verificare;
 *  - T3 non vista, fra due corse dello stesso turno macchina fatte dalla
 *    stessa vettura: continuità;
 *  - T4 vista per intero: effettuata;
 *  - un viaggio che il programma non ha: candidata aggiunta.
 * Poi: definitiva dopo le 04:00 del giorno dopo, idempotente, solo sulle
 * giornate congelate, dall'API solo l'amministratore.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import adminRouter from "../routes/admin";
import { calcolaProposta, giornateDaProporre } from "../lib/esercizio-proposta";
import { leggiGiornata } from "../lib/esercizio-giornate";
import { appDiProva, utenteDiProva } from "./helpers/app-di-prova";

const u = (n: number) => `d4400000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ADMIN = u(1), F = u(10), VSS = u(11), DSS = u(12);
const [T1, T2, T3, T4] = [u(20), u(21), u(22), u(23)];
const GIORNO = "2026-03-03", PREPARATA = "2026-03-04";
const admin = appDiProva(adminRouter, utenteDiProva(ADMIN, [], "admin"));

describe.runIf(!!process.env.TEST_DATABASE_URL)("la proposta dall'AVM, sul database", () => {
  const pulisci = async () => {
    await db.execute(sql`DELETE FROM esercizio_giornate WHERE giorno IN (${GIORNO}::date, ${PREPARATA}::date)`);
    await db.execute(sql`DELETE FROM caronte.stop_transits WHERE stop_id LIKE 'prop-%'`);
    await db.execute(sql`DELETE FROM caronte.journey_codes WHERE journey_ref LIKE 'prop-%'`);
    await db.execute(sql`DELETE FROM gtfs_stop_times WHERE feed_id = ${F}::uuid`);
    await db.execute(sql`DELETE FROM gtfs_feeds WHERE id = ${F}::uuid`);
    await db.execute(sql`DELETE FROM users WHERE id = ${ADMIN}::uuid`);
  };

  beforeAll(async () => {
    await pulisci();
    await db.execute(sql`INSERT INTO users (id, email, password_hash, role) VALUES (${ADMIN}::uuid, 'proposta-avm@prova.local', 'x', 'admin')`);
    await db.execute(sql`INSERT INTO gtfs_feeds (id, filename, is_active) VALUES (${F}::uuid, 'proposta-4.4.synthetic', false)`);
    for (const t of [T1, T2, T3, T4]) {
      await db.execute(sql`INSERT INTO gtfs_stop_times (feed_id, trip_id, stop_id, stop_sequence, arrival_time, departure_time) VALUES
        (${F}::uuid, ${t}, 'prop-A', 1, '07:00:00', '07:00:00'), (${F}::uuid, ${t}, 'prop-B', 2, '07:10:00', '07:10:00'),
        (${F}::uuid, ${t}, 'prop-C', 3, '07:20:00', '07:20:00')`);
    }
    await db.execute(sql`INSERT INTO esercizio_giornate (giorno, stato, feed_id, corse, preparata_il, congelata_il, turni)
      VALUES (${GIORNO}::date, 'congelata', ${F}::uuid, 4, '2026-03-02 12:00+01', '2026-03-03 03:00+01', '{}'::jsonb),
             (${PREPARATA}::date, 'preparata', ${F}::uuid, 0, '2026-03-03 12:00+01', NULL, '{}'::jsonb)`);
    await db.execute(sql`INSERT INTO esercizio_corse (giorno, chiave, codice, numero, linea, partenza, arrivo, vss_id, turno_macchina, dss_id, turno_guida) VALUES
      (${GIORNO}::date, ${T1}, 'C-1', '101', '1', '07:00:00', '07:20:00', ${VSS}::uuid, 'M1', ${DSS}::uuid, 'G1'),
      (${GIORNO}::date, ${T2}, 'C-2', '102', '2', '07:30:00', '07:50:00', ${VSS}::uuid, 'M2', ${DSS}::uuid, 'G2'),
      (${GIORNO}::date, ${T3}, 'C-3', '103', '1', '08:00:00', '08:20:00', ${VSS}::uuid, 'M1', ${DSS}::uuid, 'G1'),
      (${GIORNO}::date, ${T4}, 'C-4', '104', '1', '09:00:00', '09:20:00', ${VSS}::uuid, 'M1', ${DSS}::uuid, 'G1')`);
    // passaggi di SIRI: T1 e T4 per intero, con la vettura 301 (alle 07:00 e alle 09:00 di Roma, ora solare)
    for (const [t, h] of [[T1, "07"], [T4, "09"]] as const) {
      await db.execute(sql`INSERT INTO caronte.stop_transits (trip_id, stop_id, stop_seq, actual_ts, vehicle_id, source) VALUES
        (${t}, 'prop-A', 1, ${`${GIORNO} ${h}:01:00+01`}::timestamptz, '301', 'siri'),
        (${t}, 'prop-B', 2, ${`${GIORNO} ${h}:11:00+01`}::timestamptz, '301', 'siri'),
        (${t}, 'prop-C', 3, ${`${GIORNO} ${h}:21:00+01`}::timestamptz, '301', 'siri')`);
    }
    // un'altra sorgente scrive nella stessa tabella: non è una prova di SIRI
    await db.execute(sql`INSERT INTO caronte.stop_transits (trip_id, stop_id, stop_seq, actual_ts, vehicle_id, source) VALUES
      (${T2}, 'prop-A', 1, ${`${GIORNO} 07:31:00+01`}::timestamptz, '999', 'avm'),
      (${T2}, 'prop-C', 3, ${`${GIORNO} 07:51:00+01`}::timestamptz, '999', 'avm')`);
    // viaggi dichiarati: T2 per numero (non agganciato), e uno che il programma non ha
    await db.execute(sql`INSERT INTO caronte.journey_codes (day, journey_ref, trip_id, matched_by, vehicle_ref, line_ref, course_ref, avm_departure, observations) VALUES
      (${GIORNO}::date, 'prop-j2', '', NULL, '302', '2', '102', '07:30', 4),
      (${GIORNO}::date, 'prop-fuori', '', NULL, '303', '130', 'FRSRV1049', '19:54', 2)`);
  });
  afterAll(pulisci);

  it("propone l'esito di ogni corsa con le prove, e le candidate aggiunte", async () => {
    expect(await giornateDaProporre("2026-03-05")).toContain(GIORNO);
    const r: any = await calcolaProposta(GIORNO);
    expect(r).toMatchObject({
      caronte: true, sorgente: "siri", definitiva: true, corse: 4, conProve: 2, copertura: 50,
      perProposta: { effettuata_avm: 2, continuita: 1, da_verificare: 1, non_rilevata: 0 },
      perModo: { id: 2, codice: 0, numero: 1 }, aggiunte: 1, rosterLetto: false,
    });
    const g = (await leggiGiornata(GIORNO))!;
    const di = (k: string) => g.elenco.find((c: any) => c.chiave === k) as any;
    expect(di(T1)).toMatchObject({ proposta: "effettuata_avm", prove: { modo: "id", osservate: 3, prima: 1, ultima: 3, vetture: ["301"], partenzaReale: "07:01:00", ritardoPartenza: 60 } });
    expect(di(T2)).toMatchObject({ proposta: "da_verificare", prove: { modo: "numero", osservate: 0, dichiarata: true, vetture: ["302"] } });
    expect(di(T3)).toMatchObject({ proposta: "continuita", prove: { continuita: { prima: T1, dopo: T4, vettura: "301" } } });
    expect(di(T4).proposta).toBe("effettuata_avm");
    expect(g.aggiunte).toEqual([expect.objectContaining({ chiaveAvm: "prop-fuori", linea: "130", numero: "FRSRV1049", partenza: "19:54", vetture: ["303"], osservazioni: 2 })]);
    // definitiva: il giro non la rifà più
    expect(await giornateDaProporre("2026-03-05")).not.toContain(GIORNO);
  });

  it("rifatta dà lo stesso risultato; solo sulle giornate congelate", async () => {
    await calcolaProposta(GIORNO);
    const n = (await db.execute(sql`SELECT count(*)::int AS n FROM esercizio_aggiunte_proposte WHERE giorno = ${GIORNO}::date`) as any).rows[0].n;
    expect(n).toBe(1);
    await expect(calcolaProposta(PREPARATA)).rejects.toMatchObject({ status: 409 });
    await expect(calcolaProposta("2026-03-09")).rejects.toMatchObject({ status: 404 });
  });

  it("dall'API: la proposta e la giornata con le proposte; solo l'amministratore", async () => {
    const p = await request(admin).post(`/api/admin/esercizio/giornate/${GIORNO}/proposta`);
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect(p.body.perProposta.effettuata_avm).toBe(2);
    expect((await request(admin).post(`/api/admin/esercizio/giornate/${PREPARATA}/proposta`)).status).toBe(409);
    expect((await request(admin).post(`/api/admin/esercizio/giornate/2026-02-30/proposta`)).status).toBe(400);
    const g = await request(admin).get(`/api/admin/esercizio/giornate/${GIORNO}`);
    expect(g.body.proposta).toMatchObject({ definitiva: true, corse: 4 });
    expect(g.body.aggiunte).toHaveLength(1);
    const elenco = await request(admin).get(`/api/admin/esercizio/giornate?dal=2026-03-01&al=2026-03-31`);
    expect(elenco.body.giornate.find((x: any) => x.giorno === GIORNO)).toMatchObject({ effettuateAvm: 2, propostaDefinitiva: true });
    const pian = appDiProva(adminRouter, utenteDiProva(ADMIN, [], "user", { ruoli: ["pianificatore"] }));
    expect((await request(pian).post(`/api/admin/esercizio/giornate/${GIORNO}/proposta`)).status).toBe(403);
  });
});
