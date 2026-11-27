/**
 * Il calcolo unico delle tratte osservate, su un database vero
 * (TEST_DATABASE_URL; in CI come cerbero_app). Sola lettura del calcolo.
 *
 * Una corsa passa da A, B, C. Il primo giorno il bus resta fermo ad A tre
 * minuti (il GPS lo vede lì fino alle 9:03): il tratto A→B da 240″ ne vale
 * 120 — la sosta normale (60″) resta, i 120″ di regolazione si tolgono e si
 * dichiarano. Il secondo giorno il GPS non c'è: il tratto resta com'è. Una
 * sorgente diversa da SIRI scrive nella stessa tabella e non conta.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { leggiTratte } from "../lib/tratte-osservate-db";

const u = (n: number) => `d4700000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const F = u(10), T = u(20);
const G1 = "2031-05-06", G2 = "2031-05-07";   // martedì e mercoledì, ora legale (+02)
const VETTURA = "tratte-701";
const A = { id: "tratte-A", lat: 43.6160, lon: 13.5180 };
const B = { id: "tratte-B", lat: 43.6180, lon: 13.5200 };
const C = { id: "tratte-C", lat: 43.6200, lon: 13.5220 };
const COPPIE = [{ da: A.id, a: B.id }, { da: B.id, a: C.id }];

describe.runIf(!!process.env.TEST_DATABASE_URL)("le tratte osservate, sul database", () => {
  const pulisci = async () => {
    await db.execute(sql`DELETE FROM caronte.stop_transits WHERE stop_id LIKE 'tratte-%'`);
    await db.execute(sql`DELETE FROM caronte.vehicle_positions WHERE vehicle_id = ${VETTURA}`);
    await db.execute(sql`DELETE FROM gtfs_stop_times WHERE feed_id = ${F}::uuid`);
    await db.execute(sql`DELETE FROM gtfs_stops WHERE feed_id = ${F}::uuid`);
    await db.execute(sql`DELETE FROM gtfs_feeds WHERE id = ${F}::uuid`);
  };

  beforeAll(async () => {
    await pulisci();
    await db.execute(sql`INSERT INTO gtfs_feeds (id, filename, is_active) VALUES (${F}::uuid, 'tratte-osservate.synthetic', false)`);
    for (const s of [A, B, C]) {
      await db.execute(sql`INSERT INTO gtfs_stops (feed_id, stop_id, stop_name, stop_lat, stop_lon)
                           VALUES (${F}::uuid, ${s.id}, ${s.id}, ${s.lat}, ${s.lon})`);
    }
    await db.execute(sql`INSERT INTO gtfs_stop_times (feed_id, trip_id, stop_id, stop_sequence, arrival_time, departure_time) VALUES
      (${F}::uuid, ${T}, ${A.id}, 10, '09:00:00', '09:00:00'),
      (${F}::uuid, ${T}, ${B.id}, 20, '09:02:00', '09:02:00'),
      (${F}::uuid, ${T}, ${C.id}, 30, '09:03:00', '09:03:00')`);
    for (const g of [G1, G2]) {
      await db.execute(sql`INSERT INTO caronte.stop_transits (trip_id, route_id, vehicle_id, stop_id, stop_seq, scheduled, actual_ts, source) VALUES
        (${T}, 'tratte-L', ${VETTURA}, ${A.id}, 10, '09:00:00', ${`${g} 09:00:00+02`}::timestamptz, 'siri'),
        (${T}, 'tratte-L', ${VETTURA}, ${B.id}, 20, '09:02:00', ${`${g} 09:04:00+02`}::timestamptz, 'siri'),
        (${T}, 'tratte-L', ${VETTURA}, ${C.id}, 30, '09:03:00', ${`${g} 09:05:00+02`}::timestamptz, 'siri')`);
    }
    // un'altra sorgente: tempi assurdi, non devono entrare
    await db.execute(sql`INSERT INTO caronte.stop_transits (trip_id, route_id, vehicle_id, stop_id, stop_seq, scheduled, actual_ts, source) VALUES
      (${T}, 'tratte-L', 'tratte-999', ${A.id}, 10, '09:00:00', ${`${G1} 10:00:00+02`}::timestamptz, 'avm'),
      (${T}, 'tratte-L', 'tratte-999', ${B.id}, 20, '09:02:00', ${`${G1} 10:30:00+02`}::timestamptz, 'avm')`);
    // il GPS del primo giorno: fermo ad A fino alle 9:03, poi via verso B
    for (const [hhmmss, lat, lon] of [
      ["09:00:20", A.lat, A.lon], ["09:01:20", A.lat, A.lon], ["09:02:20", A.lat + 0.00005, A.lon],
      ["09:03:00", A.lat, A.lon], ["09:03:30", 43.6170, 13.5190],
    ] as const) {
      await db.execute(sql`INSERT INTO caronte.vehicle_positions (vehicle_id, trip_id, ts, lat, lon, source)
                           VALUES (${VETTURA}, ${T}, ${`${G1} ${hhmmss}+02`}::timestamptz, ${lat}, ${lon}, 'siri')`);
    }
  });
  afterAll(pulisci);

  const giornata = (r: Awaited<ReturnType<typeof leggiTratte>>, da: string, a: string) =>
    r.tratte.find(t => t.da === da && t.a === a && t.ora == null && t.fascia == null);

  it("toglie la sosta di regolazione oltre il minuto e la dichiara", async () => {
    const r = await leggiTratte({ date: [G1], coppie: COPPIE, perOra: true, feedId: F });
    expect(r.disponibile).toBe(true);
    expect(giornata(r, A.id, B.id)).toMatchObject({ n: 1, medianaS: 120, sosta: { corse: 1, medianaS: 120 } });
    // B→C dura un minuto: niente da cercare, niente da togliere
    expect(giornata(r, B.id, C.id)).toMatchObject({ n: 1, medianaS: 60, sosta: null });
    expect(r.transiti).toBe(2);
  });

  it("dà anche l'ora e la fascia oraria della partenza dal primo nodo", async () => {
    const r = await leggiTratte({ date: [G1], coppie: COPPIE, perOra: true, feedId: F });
    expect(r.tratte.find(t => t.da === A.id && t.ora === 9)).toMatchObject({ medianaS: 120, fascia: null });
    expect(r.tratte.find(t => t.da === A.id && t.fascia === "morbida")).toMatchObject({ medianaS: 120, ora: null });
  });

  it("senza GPS il tratto resta com'è; due giornate fanno la mediana", async () => {
    const r = await leggiTratte({ date: [G2], coppie: COPPIE, feedId: F });
    expect(giornata(r, A.id, B.id)).toMatchObject({ medianaS: 240, sosta: null });
    const due = await leggiTratte({ date: [G1, G2], coppie: COPPIE, feedId: F });
    expect(giornata(due, A.id, B.id)).toMatchObject({ n: 2, giorni: 2, medianaS: 180, sosta: { corse: 1 } });
  });

  it("per linea, col programmato dei passaggi, senza elenco di coppie", async () => {
    const r = await leggiTratte({ date: [G1], routeId: "tratte-L", perLinea: true, feedId: F });
    expect(giornata(r, A.id, B.id)).toMatchObject({ linea: "tratte-L", programmatoS: 120, medianaS: 120 });
    // la pagina chiede al massimo tante righe, le più osservate
    const una = await leggiTratte({ date: [G1, G2], routeId: "tratte-L", perLinea: true, limite: 1, minCampioni: 2, feedId: F });
    expect(una.tratte).toHaveLength(1);
    expect(una.tratte[0]).toMatchObject({ n: 2 });
    // la fascia oraria filtra sulla partenza dal primo nodo
    const sera = await leggiTratte({ date: [G1], routeId: "tratte-L", oraDa: 19, oraA: 24, feedId: F });
    expect(sera.tratte).toHaveLength(0);
  });

  it("solo le giornate chieste", async () => {
    const r = await leggiTratte({ date: ["2031-05-08"], coppie: COPPIE, feedId: F });
    expect(r.tratte).toHaveLength(0);
    expect((await leggiTratte({ date: [], feedId: F })).tratte).toHaveLength(0);
  });
});
