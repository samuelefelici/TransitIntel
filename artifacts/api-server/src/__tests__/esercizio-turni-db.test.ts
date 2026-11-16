/**
 * I turni nel programmato (tappa 4.3), su un database vero
 * (TEST_DATABASE_URL; in CI come cerbero_app).
 *
 * Un programma in esercizio con quattro corse feriali, i turni macchina e i
 * turni guida pubblicati nel canale del roster. Si controlla:
 *  - ogni corsa col suo turno macchina, turno guida e deposito, anche per
 *    codice stabile (turni calcolati su un'altra copia del programma);
 *  - i turni macchina della giornata con i vuoti: il totale torna col
 *    riepilogo salvato del calcolo;
 *  - le scoperte e perché;
 *  - una giornata passata prende i turni com'erano all'inizio della giornata,
 *    anche se dopo sono stati ritirati;
 *  - una giornata congelata prima della 4.3 riceve i turni una volta sola;
 *  - finché la giornata non comincia, i turni seguono il canale com'è.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import adminRouter from "../routes/admin";
import { preparaGiornata, leggiGiornata, giroDelleGiornate } from "../lib/esercizio-giornate";
import { appDiProva, utenteDiProva } from "./helpers/app-di-prova";

const u = (n: number) => `d4300000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ADMIN = u(1);
const [F, P, P2, LINEA, PERCORSO, UDP, VSS, DSS] = [u(10), u(11), u(12), u(13), u(14), u(15), u(16), u(17)];
const [T1, T2, T3, T4, T3_COPIA] = [u(20), u(21), u(22), u(23), u(24)];
const [PUB_PASSATA, PUB_RITIRO, PUB_FUTURA, PUB_RITIRO_FUTURA] = [u(30), u(31), u(32), u(33)];
const DEPOSITO = u(40);
const FUTURA = "2033-03-01", PASSATA = "2026-02-10", CONGELATA_PRIMA = "2026-02-11";
/* anche i due giorni che il giro del lavoratore prepara come «oggi» e «domani» */
const GIORNI = [FUTURA, PASSATA, CONGELATA_PRIMA, "2033-03-02", "2033-03-03"];
const PUB = [PUB_PASSATA, PUB_RITIRO, PUB_FUTURA, PUB_RITIRO_FUTURA];

const voce = (id: string, p: number, a: number) => ({ type: "trip", tripId: id, routeId: LINEA, routeName: "1", departureMin: p, arrivalMin: a });
const TURNI_MACCHINA = {
  shifts: [
    {
      vehicleId: "M1", vehicleType: "12m", residenzaDepotId: DEPOSITO, residenzaName: "Deposito di prova", totalDeadheadKm: 7.5,
      trips: [
        { type: "deadhead", tripId: "", departureMin: 400, arrivalMin: 415, deadheadKm: 3.2, depotLeg: "out", firstStopName: "Deposito di prova", lastStopName: "Stazione" },
        voce(T1, 420, 440),
        { type: "depot", tripId: "", departureMin: 445, arrivalMin: 470, firstStopName: "Ospedale", lastStopName: "Stazione" },
        voce(T2, 480, 505),
        { type: "deadhead", tripId: "", departureMin: 505, arrivalMin: 520, deadheadKm: 2.1, depotLeg: "in", firstStopName: "Ospedale", lastStopName: "Deposito di prova" },
      ],
    },
    // calcolato su un'altra copia del programma: la corsa si riconosce per codice
    { vehicleId: "M2", vehicleType: "10m", totalDeadheadKm: 1, trips: [voce(T3_COPIA, 600, 620)] },
  ],
  unassigned: [{ tripId: T4 }],
  summary: { totalDeadheadKm: 8.5, totalVehicles: 2 },
};
const TURNI_GUIDA = {
  driverShifts: [{ driverId: "G1", riprese: [{ trips: [{ tripId: T1, vehicleId: "M1" }, { tripId: T2, vehicleId: "M1" }] }] }],
};

const admin = appDiProva(adminRouter, utenteDiProva(ADMIN, [], "admin"));

describe.runIf(!!process.env.TEST_DATABASE_URL)("i turni nel programmato, sul database", () => {
  const pulisci = async () => {
    await db.execute(sql`DELETE FROM esercizio_giornate WHERE giorno IN (SELECT jsonb_array_elements_text(${JSON.stringify(GIORNI)}::jsonb)::date)`);
    await db.execute(sql`DELETE FROM roster_turni_pubblicati WHERE dss_id = ${DSS}::uuid`);
    await db.execute(sql`DELETE FROM roster_pubblicazioni WHERE id IN (SELECT jsonb_array_elements_text(${JSON.stringify(PUB)}::jsonb)::uuid)`);
    await db.execute(sql`DELETE FROM driver_shift_scenarios WHERE id = ${DSS}::uuid`);
    await db.execute(sql`DELETE FROM service_program_scenarios WHERE id = ${VSS}::uuid`);
    await db.execute(sql`DELETE FROM ps_validity_units WHERE id = ${UDP}::uuid`);
    await db.execute(sql`DELETE FROM ps_activation_log WHERE feed_id = ${F}::uuid`);
    for (const t of ["gtfs_stop_times", "gtfs_stops", "gtfs_trips", "gtfs_calendar", "gtfs_routes"]) {
      await db.execute(sql`DELETE FROM ${sql.identifier(t)} WHERE feed_id = ${F}::uuid`);
    }
    await db.execute(sql`DELETE FROM gtfs_feeds WHERE id = ${F}::uuid`);
    await db.execute(sql`DELETE FROM ps_trips WHERE project_id IN (${P}::uuid, ${P2}::uuid)`);
    await db.execute(sql`DELETE FROM ps_route_variants WHERE project_id = ${P}::uuid`);
    await db.execute(sql`DELETE FROM ps_routes WHERE project_id = ${P}::uuid`);
    await db.execute(sql`DELETE FROM ps_projects WHERE id IN (${P}::uuid, ${P2}::uuid)`);
    await db.execute(sql`DELETE FROM users WHERE id = ${ADMIN}::uuid`);
  };

  beforeAll(async () => {
    await pulisci();
    await db.execute(sql`INSERT INTO users (id, email, password_hash, role) VALUES (${ADMIN}::uuid, 'turni-programmato@prova.local', 'x', 'admin')`);
    await db.execute(sql`INSERT INTO ps_projects (id, owner_user_id, name) VALUES (${P}::uuid, ${ADMIN}::uuid, 'Programma turni 4.3'), (${P2}::uuid, ${ADMIN}::uuid, 'Copia del programma 4.3')`);
    await db.execute(sql`INSERT INTO ps_routes (id, project_id, short_name) VALUES (${LINEA}::uuid, ${P}::uuid, '1')`);
    await db.execute(sql`INSERT INTO ps_route_variants (id, project_id, route_id, name) VALUES (${PERCORSO}::uuid, ${P}::uuid, ${LINEA}::uuid, 'Andata')`);
    for (const [id, progetto, codice] of [[T1, P, "C-1"], [T2, P, "C-2"], [T3, P, "C-3"], [T4, P, "C-4"], [T3_COPIA, P2, "C-3"]] as const) {
      await db.execute(sql`INSERT INTO ps_trips (id, project_id, route_id, variant_id, codice) VALUES (${id}::uuid, ${progetto}::uuid, ${LINEA}::uuid, ${PERCORSO}::uuid, ${codice})`);
    }
    await db.execute(sql`INSERT INTO gtfs_feeds (id, filename, is_active) VALUES (${F}::uuid, 'turni-4.3.synthetic', false)`);
    await db.execute(sql`INSERT INTO ps_activation_log (project_id, feed_id, activated_at, deactivated_at, via) VALUES
      (${P}::uuid, ${F}::uuid, '2026-01-31 10:00+01', '2026-03-01 10:00+01', 'prova'),
      (${P}::uuid, ${F}::uuid, '2033-02-28 10:00+01', '2033-03-10 10:00+01', 'prova')`);
    await db.execute(sql`INSERT INTO gtfs_routes (feed_id, route_id, route_short_name) VALUES (${F}::uuid, ${LINEA}, '1')`);
    await db.execute(sql`INSERT INTO gtfs_calendar (feed_id, service_id, monday, tuesday, wednesday, thursday, friday, saturday, sunday, start_date, end_date) VALUES
      (${F}::uuid, 'FER', 1, 1, 1, 1, 1, 0, 0, '20260201', '20330331')`);
    await db.execute(sql`INSERT INTO gtfs_stops (feed_id, stop_id, stop_name, stop_lat, stop_lon) VALUES
      (${F}::uuid, 'A', 'Stazione', 43.6, 13.5), (${F}::uuid, 'B', 'Ospedale', 43.61, 13.5)`);
    for (const [t, p, a] of [[T1, "07:00:00", "07:20:00"], [T2, "08:00:00", "08:25:00"], [T3, "10:00:00", "10:20:00"], [T4, "11:00:00", "11:20:00"]] as const) {
      await db.execute(sql`INSERT INTO gtfs_trips (feed_id, trip_id, route_id, service_id) VALUES (${F}::uuid, ${t}, ${LINEA}, 'FER')`);
      await db.execute(sql`INSERT INTO gtfs_stop_times (feed_id, trip_id, stop_id, stop_sequence, arrival_time, departure_time) VALUES
        (${F}::uuid, ${t}, 'A', 1, ${p}, ${p}), (${F}::uuid, ${t}, 'B', 2, ${a}, ${a})`);
    }
    await db.execute(sql`INSERT INTO ps_validity_units (id, project_id, validity_id, name, trip_ids) VALUES
      (${UDP}::uuid, ${P}::uuid, 'FER', 'Feriale 4.3', ${JSON.stringify([T1, T2, T3, T4])}::jsonb)`);
    await db.execute(sql`INSERT INTO service_program_scenarios (id, name, date, input, result) VALUES
      (${VSS}::uuid, 'Turni macchina 4.3', '20330301', '{}'::jsonb, ${JSON.stringify(TURNI_MACCHINA)}::jsonb)`);
    await db.execute(sql`INSERT INTO driver_shift_scenarios (id, service_program_scenario_id, name, result) VALUES
      (${DSS}::uuid, ${VSS}::uuid, 'Turni guida 4.3', ${JSON.stringify(TURNI_GUIDA)}::jsonb)`);
    // la giornata passata: pubblicata prima, ritirata dopo che è passata
    await db.execute(sql`INSERT INTO roster_pubblicazioni (id, tipo, ps_project_id, dal, al, creata_il) VALUES
      (${PUB_PASSATA}::uuid, 'pubblica', ${P}::uuid, '2026-02-10', '2026-02-11', '2026-02-01 12:00+01'),
      (${PUB_RITIRO}::uuid, 'ritira', ${P}::uuid, '2026-02-10', '2026-02-11', '2026-02-20 12:00+01'),
      (${PUB_FUTURA}::uuid, 'pubblica', ${P}::uuid, '2033-03-01', '2033-03-01', now())`);
    await db.execute(sql`INSERT INTO roster_turni_pubblicati (day, udp_id, dss_id, vss_id, ps_project_id, udp_nome, dss_nome, pubblicazione_id, sostituita_da) VALUES
      ('2026-02-10', ${UDP}::uuid, ${DSS}::uuid, ${VSS}::uuid, ${P}::uuid, 'Feriale 4.3', 'Turni guida 4.3', ${PUB_PASSATA}::uuid, ${PUB_RITIRO}::uuid),
      ('2026-02-11', ${UDP}::uuid, ${DSS}::uuid, ${VSS}::uuid, ${P}::uuid, 'Feriale 4.3', 'Turni guida 4.3', ${PUB_PASSATA}::uuid, ${PUB_RITIRO}::uuid),
      ('2033-03-01', ${UDP}::uuid, ${DSS}::uuid, ${VSS}::uuid, ${P}::uuid, 'Feriale 4.3', 'Turni guida 4.3', ${PUB_FUTURA}::uuid, NULL)`);
  });
  afterAll(pulisci);

  it("ogni corsa col suo turno macchina, turno guida e deposito; i vuoti tornano col calcolo; le scoperte e perché", async () => {
    expect(await preparaGiornata(FUTURA)).toMatchObject({ stato: "preparata", corse: 4 });
    const g = (await leggiGiornata(FUTURA))!;
    const di = (id: string) => g.elenco.find((c) => c.chiave === id)!;
    expect(di(T1)).toMatchObject({ turnoMacchina: "M1", turnoGuida: "G1", deposito: "Deposito di prova" });
    expect(di(T2)).toMatchObject({ turnoMacchina: "M1", turnoGuida: "G1" });
    // per codice stabile: il turno è calcolato su un'altra copia del programma
    expect(di(T3)).toMatchObject({ turnoMacchina: "M2", turnoGuida: null, deposito: null });
    expect(di(T4)).toMatchObject({ turnoMacchina: null, turnoGuida: null });
    expect(g.turniMacchina).toEqual([
      expect.objectContaining({ turnoMacchina: "M1", udp: "Feriale 4.3", deposito: "Deposito di prova", tipoMezzo: "12m", uscita: "06:40", rientro: "08:40", corse: 2, corseNelGiorno: 2, kmVuotoProg: 7.5 }),
      expect.objectContaining({ turnoMacchina: "M2", tipoMezzo: "10m", uscita: "10:00", rientro: "10:20", corse: 1, corseNelGiorno: 1, kmVuotoProg: 1 }),
    ]);
    expect(g.turniMacchina[0]!.vuoti.map((v: any) => [v.tipo, v.km])).toEqual([["uscita", 3.2], ["deposito", null], ["rientro", 2.1]]);
    expect(g.turni).toMatchObject({
      pubblicato: true, altroProgramma: 0, corse: 4, conTurnoMacchina: 3, conTurnoGuida: 2, turniMacchina: 2, turniGuida: 1,
      scoperte: { senzaTurnoMacchina: 1, fuoriUdp: 0, scoperteNelCalcolo: 1, nonNelCalcolo: 0, senzaTurnoGuida: 1 },
      corseDeiTurniFuoriProgramma: { quante: 0 },
      kmVuoto: { turni: 8.5, riepilogo: 8.5 },
      udp: [expect.objectContaining({ udpId: UDP, dssId: DSS, vssId: VSS, dssNome: "Turni guida 4.3", vssNome: "Turni macchina 4.3" })],
    });
    expect(g.avvisi.join(" ")).toMatch(/1 corse senza turno macchina \(1 lasciate scoperte dal calcolo dei turni macchina\)/);
    expect(g.avvisi.join(" ")).toMatch(/1 corse con il turno macchina ma senza turno guida/);
    // le righe del database: gli id dei turni sulla corsa
    const r = (await db.execute(sql`SELECT udp_id::text, dss_id::text, vss_id::text, deposito_id::text FROM esercizio_corse WHERE giorno = ${FUTURA}::date AND chiave = ${T1}`) as any).rows[0];
    expect(r).toEqual({ udp_id: UDP, dss_id: DSS, vss_id: VSS, deposito_id: DEPOSITO });
  });

  it("finché la giornata non comincia, i turni seguono il canale com'è", async () => {
    await db.execute(sql`INSERT INTO roster_pubblicazioni (id, tipo, ps_project_id, dal, al) VALUES (${PUB_RITIRO_FUTURA}::uuid, 'ritira', ${P}::uuid, '2033-03-01', '2033-03-01')`);
    await db.execute(sql`UPDATE roster_turni_pubblicati SET sostituita_da = ${PUB_RITIRO_FUTURA}::uuid WHERE pubblicazione_id = ${PUB_FUTURA}::uuid`);
    await preparaGiornata(FUTURA);
    const g = (await leggiGiornata(FUTURA))!;
    expect(g.turni).toMatchObject({ pubblicato: false, conTurnoMacchina: 0 });
    expect(g.turniMacchina).toEqual([]);
    expect(g.elenco.every((c) => c.turnoMacchina == null)).toBe(true);
    expect(g.avvisi.join(" ")).toMatch(/Nessun turno pubblicato per la giornata/);
  });

  it("una giornata passata prende i turni com'erano alle 03:00, anche se ritirati dopo", async () => {
    expect(await preparaGiornata(PASSATA)).toMatchObject({ stato: "congelata", ricostruita: true, corse: 4 });
    const g = (await leggiGiornata(PASSATA))!;
    expect(g.turni).toMatchObject({ pubblicato: true, istante: "2026-02-10T02:00:00.000Z", conTurnoMacchina: 3 });
    expect(g.elenco.find((c) => c.chiave === T1)).toMatchObject({ turnoMacchina: "M1", turnoGuida: "G1" });
  });

  it("una giornata congelata prima della 4.3 riceve i turni una volta sola; le sue corse non cambiano", async () => {
    // congelata dalla 4.2: solo T1, senza turni
    await db.execute(sql`INSERT INTO esercizio_giornate (giorno, stato, ps_project_id, feed_id, corse, preparata_il, congelata_il)
      VALUES (${CONGELATA_PRIMA}::date, 'congelata', ${P}::uuid, ${F}::uuid, 1, '2026-02-10 12:00+01', '2026-02-11 03:00+01')`);
    await db.execute(sql`INSERT INTO esercizio_corse (giorno, chiave, codice, numero, linea) VALUES (${CONGELATA_PRIMA}::date, ${T1}, 'C-1', '1', '1')`);
    const fatto = await giroDelleGiornate("2033-03-02", "2033-03-03");
    expect(fatto[CONGELATA_PRIMA]).toBe("congelata, turni aggiunti");
    const g = (await leggiGiornata(CONGELATA_PRIMA))!;
    expect(g.elenco.map((c) => [c.chiave, c.turnoMacchina, c.turnoGuida])).toEqual([[T1, "M1", "G1"]]);
    expect(g.turni).toMatchObject({ pubblicato: true, corse: 1, conTurnoMacchina: 1, istante: "2026-02-11T02:00:00.000Z" });
    // le altre corse del turno non sono nel programmato congelato: lo dice
    expect(g.turni.corseDeiTurniFuoriProgramma.quante).toBe(2);
    expect(g.turniMacchina.map((t: any) => [t.turnoMacchina, t.corseNelGiorno])).toEqual([["M1", 1], ["M2", 0]]);
    // una volta sola: poi resta congelata
    expect(await preparaGiornata(CONGELATA_PRIMA)).toEqual({ stato: "congelata", giaCongelata: true, turniCompletati: false });
    expect((await request(admin).post(`/api/admin/esercizio/giornate/${CONGELATA_PRIMA}/prepara`)).status).toBe(409);
  });

  it("dall'API: la giornata con i turni, l'elenco con lo stato dei turni", async () => {
    const g = await request(admin).get(`/api/admin/esercizio/giornate/${PASSATA}`);
    expect(g.status).toBe(200);
    expect(g.body.turni.pubblicato).toBe(true);
    expect(g.body.turniMacchina).toHaveLength(2);
    expect(g.body.elenco[0]).toHaveProperty("turnoMacchina");
    const elenco = await request(admin).get(`/api/admin/esercizio/giornate?dal=2026-02-01&al=2026-02-28`);
    expect(elenco.body.giornate.map((x: any) => [x.giorno, x.turniPubblicati, x.senzaTurnoMacchina])).toEqual([
      [CONGELATA_PRIMA, true, 0], [PASSATA, true, 1]]);
  });
});
