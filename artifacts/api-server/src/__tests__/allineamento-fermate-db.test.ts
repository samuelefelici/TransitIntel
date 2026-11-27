/**
 * Le fermate rispetto alla cartografia, sul database vero (TEST_DATABASE_URL,
 * migrato). Mapbox è finto: risponde con le fermate disegnate attorno a ogni
 * punto chiesto. Si prova che la verifica legge le fermate del percorso
 * nell'ordine, che lo spostamento lo fa solo chi può scrivere, che i punti dei
 * tracciati agganciati alla fermata la seguono (e il disegno no), e che oltre
 * il tetto non si sposta niente.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import router from "../lib/planning-studio";
import { svuotaCache } from "../lib/allineamento-fermate";
import { cancellaProgetto } from "../lib/progetto-copie";
import { appDiProva, utenteDiProva } from "./helpers/app-di-prova";

const u = (n: number) => `a1100000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [PIAN, LETT] = [u(1), u(2)];
const [P, ALTRO] = [u(10), u(11)];
const [CAVOUR, STAMIRA, VUOTA, AMBIGUA, FUORI] = [u(21), u(22), u(23), u(24), u(25)];
const [LINEA, PERCORSO, PERCORSO_2] = [u(31), u(32), u(33)];

const pian = request(appDiProva(router, utenteDiProva(PIAN, [], "user", { ruoli: ["pianificatore"] })));
const lett = request(appDiProva(router, utenteDiProva(LETT, [], "user", { ruoli: ["pianificatore"] })));

const LAT = 43.6167, LON = 13.518;
const aNord = (m: number) => m / 111_195;
const aEst = (m: number) => m / (111_195 * Math.cos(LAT * Math.PI / 180));
/* le fermate del progetto, e quelle disegnate sulla mappa attorno a ognuna */
const POS: Record<string, [number, number]> = {
  [CAVOUR]: [LAT, LON],
  [STAMIRA]: [LAT + 0.002, LON],
  [VUOTA]: [LAT + 0.004, LON],
  [AMBIGUA]: [LAT + 0.006, LON],
  [FUORI]: [LAT + 0.008, LON],
};
const SIMBOLI: Record<string, [number, number][]> = {
  [CAVOUR]: [[LAT + aNord(10), LON + aEst(4)]],                                   // 10,8 m a nord-nord-est
  [STAMIRA]: [[LAT + 0.002 + aNord(1), LON]],                                     // già centrata
  [VUOTA]: [],                                                                    // niente sulla mappa
  [AMBIGUA]: [[LAT + 0.006, LON + aEst(12)], [LAT + 0.006, LON - aEst(14)]],      // due lati della strada
  [FUORI]: [],
};
const chiamate: string[] = [];
const fetchVero = globalThis.fetch;
const tokenPrima = process.env.MAPBOX_ACCESS_TOKEN;

const fermate = async () => Object.fromEntries((await db.execute<any>(sql`
  SELECT id, lat, lon FROM ps_stops WHERE project_id = ${P}::uuid`)).rows.map(r => [r.id, [Number(r.lat), Number(r.lon)]]));
const waypoints = async (variante: string) => (await db.execute<any>(sql`
  SELECT waypoints, geometry FROM ps_shapes WHERE variant_id = ${variante}::uuid`)).rows[0];

describe.runIf(!!process.env.TEST_DATABASE_URL)("le fermate rispetto alla cartografia, sul database", () => {
  const pulisci = async () => {
    for (const p of [P, ALTRO]) {
      const c = await db.execute<any>(sql`SELECT id FROM ps_projects WHERE id = ${p}::uuid`);
      if (c.rows.length) await db.transaction((tx) => cancellaProgetto(tx, p));
    }
    await db.execute(sql`DELETE FROM users WHERE id IN (${PIAN}::uuid, ${LETT}::uuid)`);
  };

  beforeAll(async () => {
    await pulisci();
    await db.execute(sql`INSERT INTO users (id, email, password_hash, role) VALUES
      (${PIAN}::uuid, 'allinea-pian@prova.local', 'x', 'user'), (${LETT}::uuid, 'allinea-lett@prova.local', 'x', 'user')`);
    await db.execute(sql`INSERT INTO ps_projects (id, owner_user_id, name) VALUES
      (${P}::uuid, ${PIAN}::uuid, 'Allineamento'), (${ALTRO}::uuid, ${LETT}::uuid, 'Un altro')`);
    await db.execute(sql`INSERT INTO ps_project_members (project_id, user_id, role) VALUES (${P}::uuid, ${LETT}::uuid, 'viewer')`);
    for (const [id, [lat, lon]] of Object.entries(POS)) {
      const progetto = id === FUORI ? ALTRO : P;
      await db.execute(sql`INSERT INTO ps_stops (id, project_id, name, lat, lon) VALUES
        (${id}::uuid, ${progetto}::uuid, ${"F" + id.slice(-2)}, ${lat}, ${lon})`);
    }
    await db.execute(sql`INSERT INTO ps_routes (id, project_id, short_name, long_name) VALUES (${LINEA}::uuid, ${P}::uuid, '81', 'Prova')`);
    await db.execute(sql`INSERT INTO ps_route_variants (id, project_id, route_id, name) VALUES
      (${PERCORSO}::uuid, ${P}::uuid, ${LINEA}::uuid, 'Circolare'), (${PERCORSO_2}::uuid, ${P}::uuid, ${LINEA}::uuid, 'Corta')`);
    // circolare: parte e torna a Cavour
    for (const [seq, id] of [CAVOUR, STAMIRA, VUOTA, AMBIGUA, CAVOUR].entries()) {
      await db.execute(sql`INSERT INTO ps_variant_stops (variant_id, seq, stop_id) VALUES (${PERCORSO}::uuid, ${seq + 1}, ${id}::uuid)`);
    }
    const wp = (id: string, extra = {}) => ({ lng: POS[id][1], lat: POS[id][0], stopId: id, mode: "snap", ...extra });
    const geom = { type: "LineString", coordinates: [[LON, LAT], [LON, LAT + 0.006]] };
    await db.execute(sql`INSERT INTO ps_shapes (project_id, variant_id, mode, geometry, waypoints) VALUES
      (${P}::uuid, ${PERCORSO}::uuid, 'driving', ${JSON.stringify(geom)}::jsonb,
       ${JSON.stringify([wp(CAVOUR), { lng: LON + 0.0005, lat: LAT + 0.001 }, wp(STAMIRA), wp(VUOTA), wp(AMBIGUA), wp(CAVOUR, { legMode: "manual" })])}::jsonb),
      (${P}::uuid, ${PERCORSO_2}::uuid, 'driving', ${JSON.stringify(geom)}::jsonb, ${JSON.stringify([wp(STAMIRA), wp(VUOTA)])}::jsonb)`);

    process.env.MAPBOX_ACCESS_TOKEN = "pk.prova";
    globalThis.fetch = (async (url: any) => {
      const s = String(url);
      chiamate.push(s);
      const m = s.match(/tilequery\/([-\d.]+),([-\d.]+)\.json/);
      const id = m && Object.keys(POS).find(k => Math.abs(POS[k][1] - Number(m[1])) < 1e-9 && Math.abs(POS[k][0] - Number(m[2])) < 1e-9);
      const features = (id ? SIMBOLI[id] : []).map(([lat, lon]) => ({
        type: "Feature", geometry: { type: "Point", coordinates: [lon, lat] }, properties: { mode: "bus", stop_type: "stop", name: "simbolo" },
      }));
      return new Response(JSON.stringify({ type: "FeatureCollection", features }), { status: 200, headers: { "content-type": "application/json" } });
    }) as any;
  });

  beforeEach(() => { svuotaCache(); chiamate.length = 0; });

  afterAll(async () => {
    globalThis.fetch = fetchVero;
    if (tokenPrima === undefined) delete process.env.MAPBOX_ACCESS_TOKEN; else process.env.MAPBOX_ACCESS_TOKEN = tokenPrima;
    await pulisci();
  });

  it("le fermate del percorso nell'ordine, una volta sola, ognuna col suo esito", async () => {
    const r = await lett.post(`/api/planning-studio/projects/${P}/stops/allineamento`).send({ variantId: PERCORSO });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.fermate.map((f: any) => [f.stopId, f.esito])).toEqual([
      [CAVOUR, "da_spostare"], [STAMIRA, "centrata"], [VUOTA, "nessuna_sulla_mappa"], [AMBIGUA, "ambigua"],
    ]);
    expect(r.body.fermate[0].scartoM).toBeCloseTo(10.8, 0);
    expect(r.body.fermate[0].direzione).toBe("nord");
    expect(r.body.riepilogo).toMatchObject({ controllate: 4, abbinate: 3, daSpostare: 1, ambigue: 1, senzaFermataSullaMappa: 1 });
    expect(r.body.raggioM).toBe(40);
    expect(chiamate).toHaveLength(4);
    expect(JSON.stringify(r.body)).not.toMatch(/pk\.prova/);
  });

  it("le fermate di un altro progetto non si controllano", async () => {
    const r = await pian.post(`/api/planning-studio/projects/${P}/stops/allineamento`).send({ stopIds: [CAVOUR, FUORI] });
    expect(r.status).toBe(404);
    expect(r.body.mancanti).toEqual([FUORI]);
    expect(chiamate).toHaveLength(0);
  });

  it("senza percorso né fermate non si controlla tutto il progetto", async () => {
    const r = await pian.post(`/api/planning-studio/projects/${P}/stops/allineamento`).send({});
    expect(r.status).toBe(400);
  });

  it("chi legge soltanto non sposta", async () => {
    const r = await lett.post(`/api/planning-studio/projects/${P}/stops/allinea`).send({ spostamenti: [{ stopId: CAVOUR }] });
    expect(r.status).toBe(403);
  });

  it("oltre 80 m non è un centraggio: nessuna fermata spostata", async () => {
    const prima = await fermate();
    const r = await pian.post(`/api/planning-studio/projects/${P}/stops/allinea`).send({ spostamenti: [
      { stopId: STAMIRA, lat: LAT + 0.002 + aNord(5), lon: LON },
      { stopId: VUOTA, lat: LAT + 0.004 + aNord(120), lon: LON },
    ] });
    expect(r.status).toBe(400);
    expect(r.body.fermate.map((f: any) => f.stopId)).toEqual([VUOTA]);
    expect(await fermate()).toEqual(prima);
  });

  it("sposta sul simbolo della mappa, salta le ambigue e le senza simbolo; i punti dei tracciati la seguono", async () => {
    const r = await pian.post(`/api/planning-studio/projects/${P}/stops/allinea`).send({ spostamenti: [
      { stopId: CAVOUR }, { stopId: STAMIRA }, { stopId: VUOTA }, { stopId: AMBIGUA },
    ] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.spostate.map((s: any) => [s.stopId, s.scelta])).toEqual([[CAVOUR, "mappa"]]);
    expect(r.body.spostate[0].metri).toBeCloseTo(10.8, 0);
    expect(r.body.saltate.map((s: any) => s.stopId).sort()).toEqual([STAMIRA, VUOTA, AMBIGUA].sort());
    expect(r.body.tracciatiAggiornati).toBe(1);

    const ora = await fermate();
    expect(ora[CAVOUR][0]).toBeCloseTo(SIMBOLI[CAVOUR][0][0], 9);
    expect(ora[CAVOUR][1]).toBeCloseTo(SIMBOLI[CAVOUR][0][1], 9);
    expect(ora[STAMIRA]).toEqual(POS[STAMIRA]);

    const s = await waypoints(PERCORSO);
    // entrambi i punti agganciati a Cavour (partenza e arrivo della circolare), coi loro campi
    expect(s.waypoints[0]).toMatchObject({ stopId: CAVOUR, mode: "snap", lat: ora[CAVOUR][0], lng: ora[CAVOUR][1] });
    expect(s.waypoints[5]).toMatchObject({ stopId: CAVOUR, legMode: "manual", lat: ora[CAVOUR][0], lng: ora[CAVOUR][1] });
    // il via e le altre fermate non si muovono, l'ordine resta, il disegno resta
    expect(s.waypoints[1]).toEqual({ lng: LON + 0.0005, lat: LAT + 0.001 });
    expect(s.waypoints[2]).toMatchObject({ stopId: STAMIRA, lat: POS[STAMIRA][0] });
    expect(s.waypoints).toHaveLength(6);
    expect(s.geometry.coordinates).toEqual([[LON, LAT], [LON, LAT + 0.006]]);
    // il percorso che non passa da Cavour non si tocca
    expect((await waypoints(PERCORSO_2)).waypoints.map((w: any) => w.stopId)).toEqual([STAMIRA, VUOTA]);

    const log = await db.execute<any>(sql`SELECT payload FROM ps_project_activity_log
      WHERE project_id = ${P}::uuid AND action = 'ps.stop.allinea' ORDER BY at DESC LIMIT 1`);
    expect(log.rows[0].payload.spostate[0]).toMatchObject({ stopId: CAVOUR, scelta: "mappa" });
  });

  it("l'operatore sceglie lui la seconda candidata di una ambigua", async () => {
    const [lat, lon] = SIMBOLI[AMBIGUA][1];
    const r = await pian.post(`/api/planning-studio/projects/${P}/stops/allinea`).send({ spostamenti: [{ stopId: AMBIGUA, lat, lon }] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.spostate[0]).toMatchObject({ stopId: AMBIGUA, scelta: "operatore" });
    expect(chiamate).toHaveLength(0);
    expect((await fermate())[AMBIGUA]).toEqual([lat, lon]);
  });

  it("richieste storte: 400 senza toccare niente", async () => {
    const url = `/api/planning-studio/projects/${P}/stops/allinea`;
    expect((await pian.post(url).send({ spostamenti: [] })).status).toBe(400);
    expect((await pian.post(url).send({ spostamenti: [{ stopId: "x" }] })).status).toBe(400);
    expect((await pian.post(url).send({ spostamenti: [{ stopId: STAMIRA, lat: 43.6 }] })).status).toBe(400);
    expect((await pian.post(url).send({ spostamenti: [{ stopId: STAMIRA }, { stopId: STAMIRA }] })).status).toBe(400);
    expect((await pian.post(url).send({ spostamenti: [{ stopId: FUORI }] })).status).toBe(404);
  });
});
