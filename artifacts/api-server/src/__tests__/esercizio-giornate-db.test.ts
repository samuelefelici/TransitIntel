/**
 * Le giornate di esercizio, il programmato congelato (tappa 4.2), su un
 * database vero (TEST_DATABASE_URL; in CI come cerbero_app).
 *
 * Un feed in esercizio, dallo storico, in due periodi: gennaio 2026 (passato)
 * e marzo 2032 (futuro). Una giornata futura si prepara e si rifà; una
 * passata nasce congelata e «ricostruita», e non cambia più nemmeno se il
 * feed cambia; il giro del lavoratore congela le giornate preparate già
 * cominciate; una giornata senza programma nello storico resta vuota e lo
 * dice; dall'API solo l'amministratore.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import adminRouter from "../routes/admin";
import { preparaGiornata, giroDelleGiornate, leggiGiornata } from "../lib/esercizio-giornate";
import { lunghezzaDellaGeometria } from "../lib/km-programmati";
import { appDiProva, utenteDiProva } from "./helpers/app-di-prova";

const u = (n: number) => `d4200000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ADMIN = u(1);
const [F, P, LINEA, PERCORSO] = [u(10), u(11), u(12), u(13)];
const [T1, T2, T3, T_PASSATA, T_NUOVA] = [u(20), u(21), u(22), u(23), u(24)];
const FUTURA = "2032-03-01", DOPO = "2032-03-02", PASSATA = "2026-01-05", PREPARATA_PRIMA = "2026-01-06", SENZA = "2032-06-07";
const GIORNI = [FUTURA, DOPO, PASSATA, PREPARATA_PRIMA, SENZA];
const CODICI = { [T1]: "689_CodUdp:D1639_362304", [T2]: "689_CodUdp:D1639_362305", [T3]: "690_CodUdp:D7_362304", [T_PASSATA]: "700_CodUdp:G1_100", [T_NUOVA]: "700_CodUdp:G1_101" };
const TRACCIATO = { type: "LineString", coordinates: [[13.5, 43.6], [13.5, 43.61]] };
const KM = Math.round(lunghezzaDellaGeometria(TRACCIATO)) / 1000;

const admin = appDiProva(adminRouter, utenteDiProva(ADMIN, [], "admin"));

describe.runIf(!!process.env.TEST_DATABASE_URL)("le giornate di esercizio congelate, sul database", () => {
  const pulisci = async () => {
    await db.execute(sql`DELETE FROM esercizio_giornate WHERE giorno IN (SELECT jsonb_array_elements_text(${JSON.stringify(GIORNI)}::jsonb)::date)`);
    await db.execute(sql`DELETE FROM ps_activation_log WHERE feed_id = ${F}::uuid`);
    for (const t of ["gtfs_stop_times", "gtfs_stops", "gtfs_trips", "gtfs_calendar_dates", "gtfs_calendar", "gtfs_routes", "gtfs_shapes"]) {
      await db.execute(sql`DELETE FROM ${sql.identifier(t)} WHERE feed_id = ${F}::uuid`);
    }
    await db.execute(sql`DELETE FROM gtfs_feeds WHERE id = ${F}::uuid`);
    await db.execute(sql`DELETE FROM ps_trips WHERE project_id = ${P}::uuid`);
    await db.execute(sql`DELETE FROM ps_route_variants WHERE project_id = ${P}::uuid`);
    await db.execute(sql`DELETE FROM ps_routes WHERE project_id = ${P}::uuid`);
    await db.execute(sql`DELETE FROM ps_projects WHERE id = ${P}::uuid`);
    await db.execute(sql`DELETE FROM users WHERE id = ${ADMIN}::uuid`);
  };

  beforeAll(async () => {
    await pulisci();
    await db.execute(sql`INSERT INTO users (id, email, password_hash, role) VALUES (${ADMIN}::uuid, 'giornate@prova.local', 'x', 'admin')`);
    await db.execute(sql`INSERT INTO ps_projects (id, owner_user_id, name) VALUES (${P}::uuid, ${ADMIN}::uuid, 'Programma giornate 4.2')`);
    await db.execute(sql`INSERT INTO ps_routes (id, project_id, short_name) VALUES (${LINEA}::uuid, ${P}::uuid, '1')`);
    await db.execute(sql`INSERT INTO ps_route_variants (id, project_id, route_id, name) VALUES (${PERCORSO}::uuid, ${P}::uuid, ${LINEA}::uuid, 'Andata')`);
    for (const [id, codice] of Object.entries(CODICI)) {
      await db.execute(sql`INSERT INTO ps_trips (id, project_id, route_id, variant_id, codice) VALUES (${id}::uuid, ${P}::uuid, ${LINEA}::uuid, ${PERCORSO}::uuid, ${codice})`);
    }
    await db.execute(sql`INSERT INTO gtfs_feeds (id, filename, is_active) VALUES (${F}::uuid, 'giornate-4.2.synthetic', false)`);
    // in esercizio a gennaio 2026 e a marzo 2032, due periodi chiusi dello storico
    await db.execute(sql`INSERT INTO ps_activation_log (project_id, feed_id, activated_at, deactivated_at, via) VALUES
      (${P}::uuid, ${F}::uuid, '2025-12-31 10:00+01', '2026-02-01 10:00+01', 'prova'),
      (${P}::uuid, ${F}::uuid, '2032-02-28 10:00+01', '2032-03-10 10:00+01', 'prova')`);
    await db.execute(sql`INSERT INTO gtfs_routes (feed_id, route_id, route_short_name) VALUES (${F}::uuid, ${LINEA}, '1')`);
    await db.execute(sql`INSERT INTO gtfs_calendar (feed_id, service_id, monday, tuesday, wednesday, thursday, friday, saturday, sunday, start_date, end_date) VALUES
      (${F}::uuid, 'FER', 1, 1, 1, 1, 1, 0, 0, '20320301', '20320331'),
      (${F}::uuid, 'GEN', 1, 1, 1, 1, 1, 0, 0, '20260101', '20260131')`);
    await db.execute(sql`INSERT INTO gtfs_calendar_dates (feed_id, service_id, date, exception_type) VALUES (${F}::uuid, 'EXTRA', '20320301', 1)`);
    await db.execute(sql`INSERT INTO gtfs_trips (feed_id, trip_id, route_id, service_id, shape_id, direction_id, on_demand, variant_code) VALUES
      (${F}::uuid, ${T1}, ${LINEA}, 'FER', 'S1', 0, false, '1/1'), (${F}::uuid, ${T2}, ${LINEA}, 'FER', 'S9', 1, true, '1/2'),
      (${F}::uuid, ${T3}, ${LINEA}, 'EXTRA', 'S1', 0, false, '1/1'), (${F}::uuid, ${T_PASSATA}, ${LINEA}, 'GEN', 'S1', 0, false, '1/1')`);
    await db.execute(sql`INSERT INTO gtfs_stops (feed_id, stop_id, stop_name, stop_lat, stop_lon) VALUES
      (${F}::uuid, 'A', 'Stazione', 43.6, 13.5), (${F}::uuid, 'B', 'Ospedale', 43.61, 13.5)`);
    for (const [t, p, a] of [[T1, "07:00:00", "07:20:00"], [T2, "08:00:00", "08:25:00"], [T3, "24:10:00", "24:30:00"], [T_PASSATA, "06:00:00", "06:20:00"]] as const) {
      await db.execute(sql`INSERT INTO gtfs_stop_times (feed_id, trip_id, stop_id, stop_sequence, arrival_time, departure_time) VALUES
        (${F}::uuid, ${t}, 'A', 1, ${p}, ${p}), (${F}::uuid, ${t}, 'B', 2, ${a}, ${a})`);
    }
    await db.execute(sql`INSERT INTO gtfs_shapes (feed_id, shape_id, geojson) VALUES (${F}::uuid, 'S1', ${JSON.stringify(TRACCIATO)}::jsonb)`);
  });
  afterAll(pulisci);

  it("una giornata futura si prepara: programma dallo storico, corse con le loro identità, km dal server", async () => {
    const e = await preparaGiornata(FUTURA);
    expect(e).toMatchObject({ stato: "preparata", giaCongelata: false, corse: 3, ricostruita: false });
    const g = (await leggiGiornata(FUTURA))!;
    expect(g).toMatchObject({ stato: "preparata", progettoId: P, feedId: F, programma: "Programma giornate 4.2", feed: "giornate-4.2.synthetic", congelataIl: null });
    expect(g.inizio).toBe("2032-03-01T02:00:00.000Z");
    expect(g.kmProg).toBe(Math.round(2 * KM * 10) / 10);
    // in ordine di partenza, anche oltre le 24
    expect(g.elenco.map((c) => c.chiave)).toEqual([T1, T2, T3]);
    expect(g.elenco[0]).toMatchObject({ codice: CODICI[T1], numero: "362304", linea: "1", variante: "1/1", direzione: 0,
      partenza: "07:00:00", arrivo: "07:20:00", fermataDa: "Stazione", fermataA: "Ospedale", kmProg: KM, aChiamata: false });
    expect(g.elenco[1]).toMatchObject({ kmProg: null, aChiamata: true });
    expect(g.elenco[2]).toMatchObject({ partenza: "24:10:00" });
    // gli avvisi: una corsa senza geometria, un numero ripetuto
    expect(g.avvisi.join(" ")).toMatch(/1 corse senza geometria/);
    expect(g.avvisi.join(" ")).toMatch(/1 numeri di corsa ripetuti/);
  });

  it("finché non comincia, la giornata si rifà col feed com'è", async () => {
    await db.execute(sql`INSERT INTO gtfs_trips (feed_id, trip_id, route_id, service_id, shape_id) VALUES (${F}::uuid, ${T_NUOVA}, ${LINEA}, 'FER', 'S1')`);
    expect(await preparaGiornata(FUTURA)).toMatchObject({ stato: "preparata", corse: 4 });
    await db.execute(sql`DELETE FROM gtfs_trips WHERE feed_id = ${F}::uuid AND trip_id = ${T_NUOVA}`);
    expect(await preparaGiornata(FUTURA)).toMatchObject({ corse: 3 });
  });

  it("una giornata passata nasce congelata e ricostruita, e non cambia più", async () => {
    const e = await preparaGiornata(PASSATA);
    expect(e).toMatchObject({ stato: "congelata", giaCongelata: false, corse: 1, ricostruita: true });
    const g = (await leggiGiornata(PASSATA))!;
    expect(g.congelataIl).not.toBeNull();
    // il feed cambia dopo: la giornata congelata resta com'era
    await db.execute(sql`INSERT INTO gtfs_trips (feed_id, trip_id, route_id, service_id, shape_id) VALUES (${F}::uuid, ${T_NUOVA}, ${LINEA}, 'GEN', 'S1')`);
    expect(await preparaGiornata(PASSATA)).toEqual({ stato: "congelata", giaCongelata: true });
    expect((await leggiGiornata(PASSATA))!.elenco.map((c) => c.chiave)).toEqual([T_PASSATA]);
    await db.execute(sql`DELETE FROM gtfs_trips WHERE feed_id = ${F}::uuid AND trip_id = ${T_NUOVA}`);
  });

  it("il giro del lavoratore congela le giornate preparate già cominciate, e prepara oggi e domani", async () => {
    // preparata prima del suo inizio, poi rimasta lì: il giro la congela, e non è ricostruita
    await db.execute(sql`INSERT INTO esercizio_giornate (giorno, stato, preparata_il) VALUES (${PREPARATA_PRIMA}::date, 'preparata', '2026-01-05 12:00+01')`);
    const fatto = await giroDelleGiornate(FUTURA, DOPO);
    expect(fatto[PREPARATA_PRIMA]).toBe("congelata, 1 corse");
    expect(fatto[FUTURA]).toBe("preparata, 3 corse");
    expect(fatto[DOPO]).toBe("preparata, 2 corse");
    expect(await leggiGiornata(PREPARATA_PRIMA)).toMatchObject({ stato: "congelata", ricostruita: false, corse: 1 });
  });

  it("senza programma nello storico la giornata resta vuota, e lo dice", async () => {
    expect(await preparaGiornata(SENZA)).toMatchObject({ stato: "preparata", corse: 0 });
    const g = (await leggiGiornata(SENZA))!;
    expect(g).toMatchObject({ feedId: null, programma: null, corse: 0 });
    expect(g.avvisi.join(" ")).toMatch(/nessun programma era in esercizio/);
  });

  it("dall'API: elenco, giornata, preparazione; una congelata non si rifà; solo l'amministratore", async () => {
    const elenco = await request(admin).get(`/api/admin/esercizio/giornate?dal=2026-01-01&al=2026-01-31`);
    expect(elenco.status, JSON.stringify(elenco.body)).toBe(200);
    expect(elenco.body.giornate.map((g: any) => g.giorno)).toEqual([PREPARATA_PRIMA, PASSATA]);
    // al più un anno per volta
    expect((await request(admin).get(`/api/admin/esercizio/giornate?dal=2026-01-01&al=2032-12-31`)).status).toBe(400);
    const g = await request(admin).get(`/api/admin/esercizio/giornate/${FUTURA}`);
    expect(g.status).toBe(200);
    expect(g.body.elenco).toHaveLength(3);
    expect((await request(admin).get(`/api/admin/esercizio/giornate/2032-07-07`)).status).toBe(404);
    expect((await request(admin).post(`/api/admin/esercizio/giornate/${FUTURA}/prepara`)).status).toBe(200);
    expect((await request(admin).post(`/api/admin/esercizio/giornate/${PASSATA}/prepara`)).status).toBe(409);
    expect((await request(admin).post(`/api/admin/esercizio/giornate/2031-02-30/prepara`)).status).toBe(400);
    const pian = appDiProva(adminRouter, utenteDiProva(ADMIN, [], "user", { ruoli: ["pianificatore"] }));
    expect((await request(pian).get(`/api/admin/esercizio/giornate/${FUTURA}`)).status).toBe(403);
  });
});
