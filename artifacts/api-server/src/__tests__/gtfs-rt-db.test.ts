/**
 * GTFS-Realtime sul database vero (tappa 4.8; TEST_DATABASE_URL, in CI come
 * cerbero_app): le corse soppresse nel giornale escono CANCELED, i ritardi
 * vengono solo da SIRI, e corse, linee e fermate hanno i codici del GTFS
 * pubblicato (non gli id interni del feed), con la data della giornata.
 *
 * La giornata di oggi, con:
 *   - T1 (codice C-101, linea L7) soppressa: CANCELED, e il suo ritardo no;
 *   - T2 (codice C-102) in corso: ritardo di SIRI, fermata F100;
 *   - upl-3, corsa di un feed caricato (senza codice): CANCELED col suo id;
 *   - un passaggio scritto dal sistema AVM (altra sorgente): fuori;
 *   - un passaggio di SIRI su una corsa fuori dalla giornata: com'è, senza data.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import GtfsRealtimeBindings from "gtfs-realtime-bindings";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import gtfsRtRouter from "../routes/gtfs-rt";
import { posizioniRecenti, ritardiRecenti, soppresseDelGiorno } from "../lib/gtfs-rt-dati";
import { giornataOggi } from "../lib/service-day";
import { resetCaronteSchemaCache } from "../lib/caronte-schema";

const { FeedMessage } = GtfsRealtimeBindings.transit_realtime;
const u = (n: number) => `d4810000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const UTENTE = u(1), P = u(2), R = u(3), S = u(4), T1 = u(5), T2 = u(6), A = u(7);
const VETTURA = "VP-4.8";
const NOSTRE = [T1, T2, "upl-3", "AVM-XYZ", "raw-9"];

describe.runIf(!!process.env.TEST_DATABASE_URL)("GTFS-Realtime, sul database", () => {
  const OGGI = giornataOggi();
  const DATA = OGGI.replace(/-/g, "");
  const app = express().use("/api/gtfs-rt", gtfsRtRouter);
  const pulisci = async () => {
    await db.execute(sql`DELETE FROM caronte.stop_transits WHERE trip_id IN (SELECT jsonb_array_elements_text(${JSON.stringify(NOSTRE)}::jsonb))`);
    await db.execute(sql`DELETE FROM caronte.vehicle_positions WHERE vehicle_id = ${VETTURA}`);
    await db.execute(sql`DELETE FROM caronte.active_trips WHERE id = ${A}::uuid`);
    await db.execute(sql`DELETE FROM esercizio_giornate WHERE giorno = ${OGGI}::date`);
    await db.execute(sql`DELETE FROM ps_stops WHERE project_id = ${P}::uuid`);
    await db.execute(sql`DELETE FROM ps_routes WHERE project_id = ${P}::uuid`);
    await db.execute(sql`DELETE FROM ps_projects WHERE id = ${P}::uuid`);
    await db.execute(sql`DELETE FROM users WHERE id = ${UTENTE}::uuid`);
  };

  beforeAll(async () => {
    process.env.GTFS_RT_API_KEY = "";
    resetCaronteSchemaCache();
    await pulisci();
    await db.execute(sql`INSERT INTO users (id, email, password_hash, role) VALUES (${UTENTE}::uuid, 'gtfsrt@prova.local', 'x', 'user')`);
    await db.execute(sql`INSERT INTO ps_projects (id, owner_user_id, name) VALUES (${P}::uuid, ${UTENTE}::uuid, 'Programma GTFS-RT 4.8')`);
    await db.execute(sql`INSERT INTO ps_routes (id, project_id, short_name, codice) VALUES (${R}::uuid, ${P}::uuid, '7', 'L7')`);
    await db.execute(sql`INSERT INTO ps_stops (id, project_id, name, lat, lon, codice) VALUES (${S}::uuid, ${P}::uuid, 'Piazza di prova', 43.6, 13.5, 'F100')`);
    await db.execute(sql`INSERT INTO esercizio_giornate (giorno, stato, corse, preparata_il, congelata_il, turni)
      VALUES (${OGGI}::date, 'congelata', 3, now(), now(), '{}'::jsonb)`);
    await db.execute(sql`INSERT INTO esercizio_corse (giorno, chiave, codice, numero, route_id, linea, partenza, origine, esito, km_prog, km_eff, causale, confermata_il) VALUES
      (${OGGI}::date, ${T1}, 'C-101', '101', ${R}, '7', '07:45:00', 'programmata', 'soppressa', 10, 0, 'SCIOPERO', now()),
      (${OGGI}::date, ${T2}, 'C-102', '102', ${R}, '7', '08:15:00', 'programmata', NULL, 10, NULL, NULL, NULL),
      (${OGGI}::date, 'upl-3', NULL, '3', NULL, '9', '25:10:00', 'programmata', 'soppressa', 5, 0, 'SCIOPERO', now())`);
    await db.execute(sql`INSERT INTO caronte.stop_transits (trip_id, route_id, vehicle_id, stop_id, stop_seq, actual_ts, delay_seconds, source) VALUES
      (${T2}, ${R}, '301', ${S}, 5, now() - interval '2 minutes', 120, 'siri'),
      (${T1}, ${R}, '302', ${S}, 2, now() - interval '3 minutes', 60, 'siri'),
      ('AVM-XYZ', 'X', '303', 'Y', 1, now() - interval '1 minute', 30, 'avm'),
      ('raw-9', 'RX', '304', 'SX', 3, now() - interval '4 minutes', -45, 'siri')`);
    await db.execute(sql`INSERT INTO caronte.active_trips (id, trip_id, route_id, vehicle_id, started_at, source)
      VALUES (${A}::uuid, ${T2}, ${R}, ${VETTURA}, now() - interval '20 minutes', 'siri')`);
    await db.execute(sql`INSERT INTO caronte.vehicle_positions (vehicle_id, trip_id, ts, lat, lon, nearest_stop_id, speed, heading, source)
      VALUES (${VETTURA}, ${T2}, now() - interval '1 minute', 43.61, 13.51, ${S}, 36, 90, 'siri')`);
  });
  afterAll(pulisci);

  it("le soppresse del giorno, coi codici pubblicati, la data e la partenza", async () => {
    expect(await soppresseDelGiorno(OGGI)).toEqual([
      { trip_id: "C-101", route_id: "L7", start_date: DATA, start_time: "07:45:00" },
      { trip_id: "upl-3", route_id: null, start_date: DATA, start_time: "25:10:00" },
    ]);
  });

  it("i ritardi: solo SIRI, coi codici pubblicati e la data quando la corsa è nella giornata", async () => {
    const r = (await ritardiRecenti()).filter((x) => ["C-101", "C-102", "AVM-XYZ", "raw-9"].includes(x.trip_id));
    const per = Object.fromEntries(r.map((x) => [x.trip_id, x]));
    expect(Object.keys(per).sort()).toEqual(["C-101", "C-102", "raw-9"]);
    expect(per["C-102"]).toMatchObject({ route_id: "L7", stop_id: "F100", stop_seq: 5, delay_seconds: 120, vehicle_id: "301", start_date: DATA });
    expect(per["raw-9"]).toMatchObject({ route_id: "RX", stop_id: "SX", delay_seconds: -45, start_date: null });
  });

  it("le posizioni: la corsa attiva, la linea e la fermata coi codici pubblicati", async () => {
    const p = (await posizioniRecenti()).find((x) => x.vehicle_id === VETTURA)!;
    expect(p).toMatchObject({ trip_id: "C-102", route_id: "L7", stop_id: "F100", start_date: DATA, speed: 36, heading: 90 });
    const j = await request(app).get("/api/gtfs-rt/vehicle-positions?format=json");
    expect(j.status).toBe(200);
    const e = j.body.entity.find((x: any) => x.id === `vp-${VETTURA}`);
    expect(e.vehicle.trip).toEqual({ tripId: "C-102", routeId: "L7", startDate: DATA });
    expect(e.vehicle.stopId).toBe("F100");
  });

  it("dall'API: JSON e protobuf, la soppressa senza ritardo", async () => {
    const j = await request(app).get("/api/gtfs-rt/trip-updates?format=json");
    expect(j.status).toBe(200);
    const per = Object.fromEntries(j.body.entity.map((e: any) => [e.id, e.tripUpdate]));
    expect(per["tu-C-101"].trip).toEqual({ tripId: "C-101", routeId: "L7", startDate: DATA, startTime: "07:45:00", scheduleRelationship: 3 });
    expect(per["tu-C-101"].delay).toBeUndefined();
    expect(per["tu-upl-3"].trip).toMatchObject({ tripId: "upl-3", startTime: "25:10:00", scheduleRelationship: 3 });
    expect(per["tu-C-102"]).toMatchObject({ trip: { tripId: "C-102", routeId: "L7", startDate: DATA }, delay: 120 });
    expect(per["tu-AVM-XYZ"]).toBeUndefined();

    const b = await request(app).get("/api/gtfs-rt/trip-updates").buffer(true).parse((res, cb) => {
      const parti: Buffer[] = []; res.on("data", (x: Buffer) => parti.push(x)); res.on("end", () => cb(null, Buffer.concat(parti)));
    });
    expect(b.status).toBe(200);
    expect(b.headers["content-type"]).toMatch(/protobuf/);
    const f = FeedMessage.toObject(FeedMessage.decode(b.body as Buffer), { longs: Number, enums: String });
    const soppresse = f.entity.filter((e: any) => e.tripUpdate?.trip?.scheduleRelationship === "CANCELED").map((e: any) => e.tripUpdate.trip.tripId);
    expect(soppresse.sort()).toEqual(["C-101", "upl-3"]);
  });
});
