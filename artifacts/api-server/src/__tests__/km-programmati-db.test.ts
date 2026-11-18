/**
 * Una sola funzione per i km programmati (PR 3.5), su un database vero
 * (TEST_DATABASE_URL; in CI come cerbero_app).
 *
 *   km = giorni in cui la corsa circola davvero × lunghezza del suo percorso
 *
 * Un programma piccolo, con la matrice di validità: una corsa per due
 * settimane con un giorno tolto, una con il periodo di un giorno solo, una a
 * chiamata, un prototipo e una disattivata. Il contatore, i km per categoria
 * e i km per comune devono dare gli stessi km, con la lunghezza calcolata dal
 * server (non quella mandata dal browser), e i giorni devono essere quelli del
 * GTFS. Poi un programma senza matrice, che va coi calendari settimanali come
 * il GTFS.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Router } from "express";
import request from "supertest";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import pianificazione from "../lib/planning-studio";
import corseEstese from "../lib/planning-studio-trips-ext";
import zonizzazione from "../lib/planning-studio-zones";
import salute from "../lib/planning-studio-health";
import { costruisciGtfs } from "../lib/planning-studio-export";
import { leggiAzienda } from "../lib/azienda";
import { giorniDiCircolazione, lunghezzaDellaGeometria, corseConPeriodoDiUnGiorno } from "../lib/km-programmati";
import { cancellaProgetto } from "../lib/progetto-copie";
import { ensureValiditySeed } from "../lib/planning-studio-validity";
import type { Gtfs } from "../lib/gtfs-verifica";
import { appDiProva, utenteDiProva } from "./helpers/app-di-prova";

const u = (n: number) => `d3500000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const PIAN = u(1);
const [M, L] = [u(10), u(11)];
const [F1, F2, G1, G2] = [u(20), u(21), u(22), u(23)];
const [LINEA, PERCORSO, LINEA_L, PERCORSO_L] = [u(30), u(31), u(32), u(33)];
const [T_DUE_SETTIMANE, T_UN_GIORNO, T_PROTOTIPO, T_SPENTA, T_A_CHIAMATA] = [u(40), u(41), u(42), u(43), u(44)];
const [L_CALENDARIO, L_SENZA] = [u(50), u(51)];
const [CAL_M, CAL_L] = [u(60), u(61)];
const [CAT_A, CAT_B] = [u(70), u(71)];
const ZONA = u(80);
const NOME = "Km programmati di prova 3.5";

const tutte = Router();
for (const r of [pianificazione, corseEstese, zonizzazione, salute]) tutte.use(r);
const pian = appDiProva(tutte, utenteDiProva(PIAN, [], "user", { ruoli: ["pianificatore"] }));

const TRACCIATO = { type: "LineString", coordinates: [[13.5, 43.6], [13.5, 43.605], [13.5, 43.61]] };
const METRI = lunghezzaDellaGeometria(TRACCIATO); // ~1.112 m
const km = (giorni: number) => Math.round(giorni * METRI / 100) / 10; // come le risposte: km a un decimale

/** I giorni di servizio di ogni corsa del GTFS (trip_id → AAAA-MM-GG), fra dal e al. */
function giorniDelGtfs(g: Gtfs, dal: string, al: string): Map<string, string[]> {
  const giorni: string[] = [];
  for (const d = new Date(`${dal}T00:00:00Z`); d <= new Date(`${al}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) giorni.push(d.toISOString().slice(0, 10));
  const nomi = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const cal = new Map((g["calendar.txt"]?.righe ?? []).map((r: any) => [String(r.service_id), r]));
  const ecc = new Map<string, Map<string, number>>();
  for (const r of (g["calendar_dates.txt"]?.righe ?? []) as any[]) {
    const m = ecc.get(String(r.service_id)) ?? new Map<string, number>();
    m.set(String(r.date), Number(r.exception_type));
    ecc.set(String(r.service_id), m);
  }
  const servizio = (s: string) => giorni.filter((iso) => {
    const ymd = iso.replace(/-/g, "");
    const e = ecc.get(s)?.get(ymd);
    if (e === 2) return false;
    if (e === 1) return true;
    const c: any = cal.get(s);
    return !!c && ymd >= String(c.start_date) && ymd <= String(c.end_date) && Number(c[nomi[new Date(`${iso}T00:00:00Z`).getUTCDay()]!]) === 1;
  });
  return new Map((g["trips.txt"]?.righe ?? []).map((t: any) => [String(t.trip_id), servizio(String(t.service_id))]));
}

/** Il GTFS e la funzione dei km danno gli stessi giorni a ogni corsa. */
async function stessiGiorniDelGtfs(progetto: string, dal: string, al: string) {
  const p = (await db.execute<any>(sql`SELECT * FROM ps_projects WHERE id = ${progetto}::uuid`)).rows[0];
  const g = await costruisciGtfs(progetto, p, await leggiAzienda(), "bozza", []);
  const codici = new Map<string, string>((await db.execute<any>(sql`SELECT id, codice FROM ps_trips WHERE project_id = ${progetto}::uuid`)).rows.map((r: any) => [r.codice, r.id]));
  const dalGtfs = new Map([...giorniDelGtfs(g, dal, al)].map(([codice, gg]) => [codici.get(codice)!, gg]));
  const nostri = await giorniDiCircolazione({ progettoId: progetto, dal, al });
  for (const [id, gg] of nostri) expect(dalGtfs.get(id) ?? [], `corsa ${id}`).toEqual(gg);
  for (const [id, gg] of dalGtfs) expect(nostri.get(id) ?? [], `corsa ${id} del GTFS`).toEqual(gg);
  return nostri;
}

describe.runIf(!!process.env.TEST_DATABASE_URL)("i km programmati, sul database", () => {
  const pulisci = async () => {
    for (const p of [M, L]) {
      const c = await db.execute<any>(sql`SELECT id FROM ps_projects WHERE id = ${p}::uuid`);
      if (c.rows.length) await db.transaction((tx) => cancellaProgetto(tx, p));
    }
    await db.execute(sql`DELETE FROM ps_validity_category_calendar WHERE category_id IN (${CAT_A}::uuid, ${CAT_B}::uuid)`);
    await db.execute(sql`DELETE FROM ps_validity_categories WHERE id IN (${CAT_A}::uuid, ${CAT_B}::uuid)`);
    await db.execute(sql`DELETE FROM zones WHERE id = ${ZONA}::uuid`);
    await db.execute(sql`DELETE FROM users WHERE id = ${PIAN}::uuid`);
  };

  beforeAll(async () => {
    await pulisci();
    await db.execute(sql`INSERT INTO users (id, email, password_hash, role) VALUES (${PIAN}::uuid, 'km-pian@prova.local', 'x', 'user')`);
    await db.execute(sql`INSERT INTO ps_projects (id, owner_user_id, name, agency_name) VALUES
      (${M}::uuid, ${PIAN}::uuid, ${NOME + " (matrice)"}, 'Azienda di prova'),
      (${L}::uuid, ${PIAN}::uuid, ${NOME + " (calendari)"}, 'Azienda di prova')`);
    await db.execute(sql`INSERT INTO ps_stops (id, project_id, name, lat, lon) VALUES
      (${F1}::uuid, ${M}::uuid, 'Stazione', 43.6, 13.5), (${F2}::uuid, ${M}::uuid, 'Ospedale', 43.61, 13.5),
      (${G1}::uuid, ${L}::uuid, 'Stazione', 43.6, 13.5), (${G2}::uuid, ${L}::uuid, 'Ospedale', 43.61, 13.5)`);
    await db.execute(sql`INSERT INTO ps_routes (id, project_id, short_name, long_name) VALUES
      (${LINEA}::uuid, ${M}::uuid, '7', 'Stazione - Ospedale'), (${LINEA_L}::uuid, ${L}::uuid, '7', 'Stazione - Ospedale')`);
    await db.execute(sql`INSERT INTO ps_route_variants (id, project_id, route_id, name) VALUES
      (${PERCORSO}::uuid, ${M}::uuid, ${LINEA}::uuid, 'Andata'), (${PERCORSO_L}::uuid, ${L}::uuid, ${LINEA_L}::uuid, 'Andata')`);
    await db.execute(sql`INSERT INTO ps_variant_stops (variant_id, seq, stop_id) VALUES
      (${PERCORSO}::uuid, 1, ${F1}::uuid), (${PERCORSO}::uuid, 2, ${F2}::uuid),
      (${PERCORSO_L}::uuid, 1, ${G1}::uuid), (${PERCORSO_L}::uuid, 2, ${G2}::uuid)`);
    // un calendario per programma: dà la finestra del GTFS (le corse di M vanno con la matrice)
    await db.execute(sql`INSERT INTO ps_calendars (id, project_id, code, name, monday, tuesday, wednesday, thursday, friday, saturday, sunday, start_date, end_date) VALUES
      (${CAL_M}::uuid, ${M}::uuid, 'SET', 'Settembre', true, true, true, true, true, true, true, '2026-09-01', '2026-09-30'),
      (${CAL_L}::uuid, ${L}::uuid, 'FER', 'Feriale', true, true, true, true, true, false, false, '2026-09-14', '2026-09-27')`);
    // calendario L: niente mercoledì 16, in più sabato 19
    await db.execute(sql`INSERT INTO ps_calendar_dates (calendar_id, date, exception_type) VALUES
      (${CAL_L}::uuid, '2026-09-16', 2), (${CAL_L}::uuid, '2026-09-19', 1)`);

    await ensureValiditySeed(); // i tipi di giorno di sistema, come all'avvio dell'API
    const feriale = (await db.execute<any>(sql`SELECT id FROM ps_day_types WHERE project_id IS NULL AND code = 'feriale'`)).rows[0]?.id;
    if (!feriale) throw new Error("km-programmati-db.test.ts vuole il tipo di giorno di sistema «feriale»");
    const manuale = { categoriesManual: true };
    const corse: Array<[string, string, string, boolean, Record<string, unknown>]> = [
      [T_DUE_SETTIMANE, "2026-09-14", "2026-09-27", true, manuale],
      [T_UN_GIORNO, "2026-09-15", "2026-09-15", true, manuale],
      [T_PROTOTIPO, "2026-09-14", "2026-09-27", true, { ...manuale, prototype: true }],
      [T_SPENTA, "2026-09-14", "2026-09-27", false, manuale],
      [T_A_CHIAMATA, "2026-09-14", "2026-09-27", true, { ...manuale, onDemand: true }],
    ];
    for (const [id, dal, al, attiva, attributi] of corse) {
      await db.execute(sql`INSERT INTO ps_trips (id, project_id, route_id, variant_id, headsign, valid_from, valid_to, is_active, attributes)
                           VALUES (${id}::uuid, ${M}::uuid, ${LINEA}::uuid, ${PERCORSO}::uuid, 'Ospedale', ${dal}::date, ${al}::date, ${attiva}, ${JSON.stringify(attributi)}::jsonb)`);
      await db.execute(sql`INSERT INTO ps_trip_day_validity (trip_id, day_type_id, is_valid) VALUES (${id}::uuid, ${feriale}::uuid, true)`);
    }
    // la corsa di due settimane non circola mercoledì 16
    await db.execute(sql`INSERT INTO ps_trip_exceptions (trip_id, date, exception_type) VALUES (${T_DUE_SETTIMANE}::uuid, '2026-09-16', 2)`);
    // L: una corsa col calendario (il periodo di un giorno qui non conta) e una senza
    await db.execute(sql`INSERT INTO ps_trips (id, project_id, route_id, variant_id, calendar_id, headsign, valid_from, valid_to) VALUES
      (${L_CALENDARIO}::uuid, ${L}::uuid, ${LINEA_L}::uuid, ${PERCORSO_L}::uuid, ${CAL_L}::uuid, 'Ospedale', '2026-09-15', '2026-09-15'),
      (${L_SENZA}::uuid, ${L}::uuid, ${LINEA_L}::uuid, ${PERCORSO_L}::uuid, NULL, 'Ospedale', NULL, NULL)`);
    for (const [corsa, fermate] of [[T_DUE_SETTIMANE, [F1, F2]], [T_UN_GIORNO, [F1, F2]], [T_A_CHIAMATA, [F1, F2]], [L_CALENDARIO, [G1, G2]], [L_SENZA, [G1, G2]]] as const) {
      await db.execute(sql`INSERT INTO ps_stop_times (trip_id, stop_seq, stop_id, arrival_time, departure_time) VALUES
        (${corsa}::uuid, 1, ${fermate[0]}::uuid, '07:00:00', '07:00:00'), (${corsa}::uuid, 2, ${fermate[1]}::uuid, '07:10:00', '07:10:00')`);
    }

    // il calendario aziendale di M: la prima settimana categoria A, la seconda B
    await db.execute(sql`INSERT INTO ps_validity_categories (id, code, name, color, sort_order) VALUES
      (${CAT_A}::uuid, 'prova_km_a', 'Prova A', '#3b82f6', 1), (${CAT_B}::uuid, 'prova_km_b', 'Prova B', '#f59e0b', 2)`);
    await db.execute(sql`INSERT INTO ps_validity_category_calendar (project_id, date, category_id)
      SELECT ${M}::uuid, d::date, CASE WHEN d < '2026-09-21' THEN ${CAT_A}::uuid ELSE ${CAT_B}::uuid END
        FROM generate_series('2026-09-14'::date, '2026-09-27'::date, interval '1 day') d`);

    // un comune che contiene tutta la linea
    await db.execute(sql`INSERT INTO zones (id, name, istat_code, geometry) VALUES (${ZONA}::uuid, 'Comune di prova 3.5', 'prova-3.5',
      ${JSON.stringify({ type: "Polygon", coordinates: [[[13.49, 43.59], [13.51, 43.59], [13.51, 43.62], [13.49, 43.62], [13.49, 43.59]]] })}::jsonb)`);
  });
  afterAll(pulisci);

  it("la lunghezza del tracciato la calcola il server, non il browser", async () => {
    for (const percorso of [PERCORSO, PERCORSO_L]) {
      const progetto = percorso === PERCORSO ? M : L;
      const r = await request(pian).put(`/api/planning-studio/projects/${progetto}/variants/${percorso}/shape`)
        .send({ mode: "manual", geometry: TRACCIATO, waypoints: [], distanceM: 99999, durationS: 600 });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.shape.distanceM).toBeCloseTo(METRI, 6);
    }
    const salvata = (await db.execute<any>(sql`SELECT distance_m FROM ps_shapes WHERE variant_id = ${PERCORSO}::uuid`)).rows[0];
    expect(Number(salvata.distance_m)).toBeCloseTo(METRI, 6);
  });

  it("i giorni sono quelli del GTFS: con la matrice contano periodo ed eccezioni della corsa", async () => {
    const giorni = await stessiGiorniDelGtfs(M, "2026-09-01", "2026-09-30");
    expect(giorni.get(T_DUE_SETTIMANE)).toEqual(["2026-09-14", "2026-09-15", "2026-09-17", "2026-09-18", "2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25"]);
    expect(giorni.get(T_UN_GIORNO)).toEqual(["2026-09-15"]);
    expect(giorni.get(T_A_CHIAMATA)).toHaveLength(10);
    expect(giorni.has(T_PROTOTIPO)).toBe(false);
    expect(giorni.has(T_SPENTA)).toBe(false);
  });

  it("senza matrice i giorni sono quelli dei calendari settimanali, come nel GTFS", async () => {
    const giorni = await stessiGiorniDelGtfs(L, "2026-09-14", "2026-09-27");
    expect(giorni.get(L_CALENDARIO)).toEqual(["2026-09-14", "2026-09-15", "2026-09-17", "2026-09-18", "2026-09-19", "2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25"]);
    expect(giorni.get(L_SENZA)).toHaveLength(14);
    // il periodo della corsa qui non conta, e non se ne avvisa
    expect(await corseConPeriodoDiUnGiorno(L)).toEqual({ quante: 0, giorno: null });
  });

  it("i km per categoria contano i giorni veri e avvisano del periodo di un giorno", async () => {
    const r = await request(pian).get(`/api/planning-studio/projects/${M}/corse-km`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    // A: 14, 15, 17, 18 (due settimane) + 15 (un giorno); B: 21-25
    expect(r.body.totalsByCategory).toEqual({ prova_km_a: km(5), prova_km_b: km(5) });
    expect(r.body.grandTotal).toBe(km(10));
    expect(r.body.onDemandGrandTotal).toBe(km(10));
    expect(r.body.lines).toHaveLength(1);
    expect(r.body.lines[0].kmTotal).toBe(km(10));
    expect(r.body.periodoDiUnGiorno).toEqual({ quante: 1, giorno: "2026-09-15" });
  });

  it("il contatore usa la stessa lunghezza", async () => {
    const r = await request(pian).get(`/api/planning-studio/projects/${M}/trips-count`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toEqual({ count: 4, active: 3, prototypes: 1, km: km(4), kmActive: km(3) });
  });

  it("i km per comune tornano con quelli per categoria", async () => {
    const r = await request(pian).post(`/api/planning-studio/projects/${M}/zones/compute?year=2026`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const zona = r.body.zones.find((z: any) => z.zoneId === ZONA);
    // 9 + 1 corse programmate + 10 a chiamata: la zonizzazione le conta tutte
    expect(zona.byRoute[0].runsYear).toBe(20);
    expect(zona.totalKmYear).toBeCloseTo(km(20), 1);
    expect(r.body.unassignedKm).toBe(0);
  });

  it("il controllo del progetto segnala la corsa con il periodo di un giorno", async () => {
    const r = await request(pian).get(`/api/planning-studio/projects/${M}/health`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const c = r.body.checks.find((x: any) => x.key === "trips_one_day_period");
    expect(c).toMatchObject({ level: "warning", count: 1 });
    expect(c.samples[0]).toContain("15/09/2026");
    const l = await request(pian).get(`/api/planning-studio/projects/${L}/health`);
    expect(l.body.checks.find((x: any) => x.key === "trips_one_day_period").count).toBe(0);
  });
});
