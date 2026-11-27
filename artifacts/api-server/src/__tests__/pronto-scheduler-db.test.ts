/**
 * Pronto per lo scheduler, su un database vero (TEST_DATABASE_URL; in CI
 * come cerbero_app).
 *
 * Una domenica: la linea A (12 metri) ha andata 08:00→08:20 e ritorno che
 * riparte alle 08:20, senza sosta, e una corsa delle 09:00 che l'UDP non ha
 * ancora; la linea B, senza tipo di mezzo, circola quel giorno ma non è
 * nell'UDP. Il deposito ha gli archi solo coi capolinea della A.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { prontoPerScheduler, riallineaUdp, leggiDepositi } from "../lib/pronto-scheduler-db";

const u = (n: number) => `e7a00000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const OWNER = u(1), P = u(2), DT = u(3), UDP = u(4), DEP = u(5);
const RA = u(10), RB = u(11), VA0 = u(12), VA1 = u(13), VB0 = u(14);
const S1 = u(20), S2 = u(21), S3 = u(22), S4 = u(23);
const TA1 = u(30), TA2 = u(31), TA3 = u(32), TB1 = u(33);
const DOMENICA = "2026-03-01";

const controllo = (p: any, chiave: string) => p.controlli.find((c: any) => c.chiave === chiave);

describe.runIf(!!process.env.TEST_DATABASE_URL)("pronto per lo scheduler, sul database", () => {
  const pulisci = async () => {
    await db.execute(sql`DELETE FROM deadhead_arcs WHERE ps_project_id = ${P}::uuid`);
    await db.execute(sql`DELETE FROM depots WHERE id = ${DEP}::uuid`);
    await db.execute(sql`DELETE FROM ps_validity_units WHERE project_id = ${P}::uuid`);
    await db.execute(sql`DELETE FROM ps_trip_day_validity WHERE trip_id IN (${TA1}::uuid, ${TA2}::uuid, ${TA3}::uuid, ${TB1}::uuid)`);
    await db.execute(sql`DELETE FROM ps_stop_times WHERE trip_id IN (${TA1}::uuid, ${TA2}::uuid, ${TA3}::uuid, ${TB1}::uuid)`);
    await db.execute(sql`DELETE FROM ps_trips WHERE project_id = ${P}::uuid`);
    await db.execute(sql`DELETE FROM ps_stops WHERE project_id = ${P}::uuid`);
    await db.execute(sql`DELETE FROM ps_route_variants WHERE project_id = ${P}::uuid`);
    await db.execute(sql`DELETE FROM ps_routes WHERE project_id = ${P}::uuid`);
    await db.execute(sql`DELETE FROM ps_day_calendar WHERE project_id = ${P}::uuid`);
    await db.execute(sql`DELETE FROM ps_day_types WHERE id = ${DT}::uuid`);
    await db.execute(sql`DELETE FROM ps_project_activity_log WHERE project_id = ${P}::uuid`);
    await db.execute(sql`DELETE FROM ps_projects WHERE id = ${P}::uuid`);
    await db.execute(sql`DELETE FROM users WHERE id = ${OWNER}::uuid`);
  };

  beforeAll(async () => {
    await pulisci();
    await db.execute(sql`INSERT INTO users (id, email, password_hash, role) VALUES (${OWNER}::uuid, 'pronto-scheduler@prova.local', 'x', 'admin')`);
    await db.execute(sql`INSERT INTO ps_projects (id, owner_user_id, name) VALUES (${P}::uuid, ${OWNER}::uuid, 'Pronto per lo scheduler')`);
    await db.execute(sql`INSERT INTO ps_day_types (id, project_id, code, name, color) VALUES (${DT}::uuid, ${P}::uuid, 'festivo', 'Festivo', '#ef4444')`);
    await db.execute(sql`INSERT INTO ps_day_calendar (project_id, date, day_type_id) VALUES (${P}::uuid, ${DOMENICA}::date, ${DT}::uuid)`);
    await db.execute(sql`INSERT INTO ps_routes (id, project_id, short_name, attributes) VALUES
      (${RA}::uuid, ${P}::uuid, 'A', '{"vehicleTypes": {"ammesse": ["12m", "10m"]}}'::jsonb),
      (${RB}::uuid, ${P}::uuid, 'B', '{}'::jsonb)`);
    await db.execute(sql`INSERT INTO ps_route_variants (id, project_id, route_id, name, direction, code) VALUES
      (${VA0}::uuid, ${P}::uuid, ${RA}::uuid, 'A andata', 0, 'A1'),
      (${VA1}::uuid, ${P}::uuid, ${RA}::uuid, 'A ritorno', 1, 'A2'),
      (${VB0}::uuid, ${P}::uuid, ${RB}::uuid, 'B', 0, 'B1')`);
    await db.execute(sql`INSERT INTO ps_stops (id, project_id, name, lat, lon) VALUES
      (${S1}::uuid, ${P}::uuid, 'Centro', 43.6170, 13.5180), (${S2}::uuid, ${P}::uuid, 'Periferia', 43.5800, 13.5100),
      (${S3}::uuid, ${P}::uuid, 'Collina', 43.6000, 13.4800), (${S4}::uuid, ${P}::uuid, 'Mare', 43.6200, 13.5300)`);
    for (const [t, r, v, d] of [[TA1, RA, VA0, 0], [TA2, RA, VA1, 1], [TA3, RA, VA0, 0], [TB1, RB, VB0, 0]] as const) {
      await db.execute(sql`INSERT INTO ps_trips (id, project_id, route_id, variant_id, direction, attributes)
        VALUES (${t}::uuid, ${P}::uuid, ${r}::uuid, ${v}::uuid, ${d}, '{}'::jsonb)`);
      await db.execute(sql`INSERT INTO ps_trip_day_validity (trip_id, day_type_id, is_valid) VALUES (${t}::uuid, ${DT}::uuid, true)`);
    }
    await db.execute(sql`INSERT INTO ps_stop_times (trip_id, stop_seq, stop_id, arrival_time, departure_time) VALUES
      (${TA1}::uuid, 1, ${S1}::uuid, '08:00:00', '08:00:00'), (${TA1}::uuid, 2, ${S2}::uuid, '08:20:00', '08:20:00'),
      (${TA2}::uuid, 1, ${S2}::uuid, '08:20:00', '08:20:00'), (${TA2}::uuid, 2, ${S1}::uuid, '08:40:00', '08:40:00'),
      (${TA3}::uuid, 1, ${S1}::uuid, '09:00:00', '09:00:00'), (${TA3}::uuid, 2, ${S2}::uuid, '09:20:00', '09:20:00'),
      (${TB1}::uuid, 1, ${S3}::uuid, '10:00:00', '10:00:00'), (${TB1}::uuid, 2, ${S4}::uuid, '10:30:00', '10:30:00')`);
    await db.execute(sql`INSERT INTO ps_validity_units (id, project_id, validity_id, name, day_type_id, trip_ids, trip_count, representative_dates, day_count)
      VALUES (${UDP}::uuid, ${P}::uuid, 'v-festivo', 'Festivo', ${DT}::uuid, ${JSON.stringify([TA1, TA2])}::jsonb, 2, ${JSON.stringify([DOMENICA])}::jsonb, 1)`);
    await db.execute(sql`INSERT INTO depots (id, name, lat, lon, ps_project_id) VALUES (${DEP}::uuid, 'Deposito di prova', 43.6056, 13.5171, ${P}::uuid)`);
    await db.execute(sql`INSERT INTO deadhead_arcs (from_key, from_type, from_lat, from_lon, to_key, to_type, to_lat, to_lon, ps_project_id) VALUES
      (${`depot:${DEP}`}, 'depot', 43.6056, 13.5171, ${`stop:${S1}`}, 'terminus', 43.6170, 13.5180, ${P}::uuid),
      (${`stop:${S2}`}, 'terminus', 43.5800, 13.5100, ${`depot:${DEP}`}, 'depot', 43.6056, 13.5171, ${P}::uuid)`);
  });

  afterAll(pulisci);

  it("i controlli: la linea B fuori dall'UDP e senza tipo di mezzo, i suoi capolinea senza fuorilinea, la A senza sosta", async () => {
    const p = (await prontoPerScheduler(P, UDP, { depotIds: [DEP], datiReali: false }))!;
    expect(p).toMatchObject({ pronto: false, udp: { id: UDP, nome: "Festivo", corse: 2 }, depositi: [{ id: DEP }] });
    expect(controllo(p, "udp_allineata")).toMatchObject({ livello: "errore", numero: 1, campioni: ["B (1)"] });
    expect(controllo(p, "udp_allineata").dettaglio).toMatch(/1 corse da aggiungere e 0 da togliere/);   // la A delle 09:00
    expect(controllo(p, "tipi_mezzo")).toMatchObject({ livello: "errore", campioni: ["B"] });
    expect(controllo(p, "depositi").livello).toBe("ok");
    expect(controllo(p, "archi_fuorilinea")).toMatchObject({ livello: "errore", numero: 2, campioni: ["Collina", "Mare"] });
    expect(controllo(p, "margini_capolinea")).toMatchObject({ livello: "errore", numero: 1 });
    expect(controllo(p, "margini_capolinea").campioni[0]).toMatch(/^A a Periferia: arriva 08:20, riparte 08:20/);
    expect(p.controlli.some((c: any) => c.chiave === "dati_reali")).toBe(false);   // datiReali: false
  });

  it("senza depositi indicati: avviso, e i fuorilinea si guardano su tutti quelli del progetto", async () => {
    const p = (await prontoPerScheduler(P, UDP, { depotIds: null, datiReali: false }))!;
    expect(controllo(p, "depositi").livello).toBe("avviso");
    expect(p.depositi.map((d: any) => d.id)).toContain(DEP);
    expect((await prontoPerScheduler(P, UDP, { depotIds: [u(999)], datiReali: false }))!.controlli
      .find((c: any) => c.chiave === "depositi")!.livello).toBe("errore");
  });

  it("con i dati reali: senza transiti SIRI è un avviso, non un errore", async () => {
    const p = (await prontoPerScheduler(P, UDP, { depotIds: [DEP], datiReali: true, feedId: null }))!;
    const reali = p.controlli.filter((c: any) => c.chiave === "dati_reali" || c.chiave === "margini_reali");
    expect(reali.length).toBeGreaterThan(0);
    expect(reali.every((c: any) => c.livello !== "errore")).toBe(true);
  });

  it("il riallineamento allarga l'UDP alla linea B e prende la A delle 09:00", async () => {
    expect(await riallineaUdp(P, UDP, [u(888)])).toMatchObject({ ok: false, stato: 404 });
    expect(await riallineaUdp(P, UDP, ["non-un-id"])).toMatchObject({ ok: false, stato: 400 });
    const r = await riallineaUdp(P, UDP, [RB]);
    expect(r).toMatchObject({ ok: true, r: { prima: 2, dopo: 4, aggiunte: 2, tolte: 0, linee: [RB] } });
    const salvate = (await db.execute<any>(sql`SELECT trip_ids FROM ps_validity_units WHERE id = ${UDP}::uuid`)).rows[0].trip_ids;
    expect([...salvate].sort()).toEqual([TA1, TA2, TA3, TB1].sort());
    const p = (await prontoPerScheduler(P, UDP, { depotIds: [DEP], datiReali: false }))!;
    expect(controllo(p, "udp_allineata").livello).toBe("ok");
    // il resto resta da sistemare: il tipo della B, i suoi fuorilinea, la sosta della A
    expect(p.pronto).toBe(false);
    // rifatto, non cambia niente
    expect(await riallineaUdp(P, UDP, [])).toMatchObject({ ok: true, r: { aggiunte: 0, tolte: 0 } });
  });

  it("la sosta minima del capolinea entra nei margini", async () => {
    // il ritorno della A riparte 3′ dopo l'arrivo: oltre i 2′, sotto i 5′ dichiarati a Periferia
    await db.execute(sql`UPDATE ps_stop_times SET arrival_time = '08:23:00', departure_time = '08:23:00' WHERE trip_id = ${TA2}::uuid AND stop_seq = 1`);
    const senza = controllo((await prontoPerScheduler(P, UDP, { depotIds: [DEP], datiReali: false }))!, "margini_capolinea");
    expect(senza.livello).toBe("avviso");                      // resta la A delle 09:00 senza ritorno
    expect(senza.dettaglio).not.toMatch(/sotto la sosta minima/);
    await db.execute(sql`UPDATE ps_stops SET attributes = attributes || '{"sostaMinimaMin": 5}'::jsonb WHERE id = ${S2}::uuid`);
    const con = controllo((await prontoPerScheduler(P, UDP, { depotIds: [DEP], datiReali: false }))!, "margini_capolinea");
    expect(con.dettaglio).toMatch(/1 ritorni sono sotto la sosta minima del capolinea/);
    expect(con.campioni.some((x: string) => /arriva 08:20, riparte 08:23/.test(x))).toBe(true);
  });

  it("un'UDP di un altro progetto non si legge; i depositi della richiesta si validano", async () => {
    expect(await prontoPerScheduler(u(777), UDP)).toBeNull();
    expect(leggiDepositi(`${DEP},${DEP}`)).toEqual({ ok: true, ids: [DEP, DEP] });
    expect(leggiDepositi("x; drop")).toMatchObject({ ok: false });
    expect(leggiDepositi(undefined)).toEqual({ ok: true, ids: null });
  });
});
