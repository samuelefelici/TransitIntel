/**
 * Le polimetriche dal programma di esercizio, su un database vero (tappa
 * 6.36, migrazione 0057; TEST_DATABASE_URL, in CI come cerbero_app).
 *
 * Un programma di Planning Studio inventato (una bozza), una fotografia di
 * prima fatta da uno ZIP con una polimetrica salvata, una decisione del
 * confronto con la bigliettazione. La fotografia del programma porta la
 * polimetrica sul percorso con le stesse fermate, e conta la decisione, che
 * vale lì per fermate. Una bozza la sceglie solo chi la può aprire.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db, pool } from "@workspace/db";
import { sql } from "drizzle-orm";
import router from "../routes/fares-polimetriche";
import { haversineKm } from "../lib/geo-utils";
import { appDiProva, utenteDiProva } from "./helpers/app-di-prova";

const CHI = "e6360000-0000-4000-8000-000000000001";
const ALTRO = "e6360000-0000-4000-8000-000000000002";
const PROGETTO = "e6360000-0000-4000-8000-0000000000b1";
const VUOTO = "e6360000-0000-4000-8000-0000000000b2";
const LINEA = "e6360000-0000-4000-8000-0000000000c1";
const VA = "e6360000-0000-4000-8000-0000000000d1";
const VB = "e6360000-0000-4000-8000-0000000000d2";
const VECCHIA = "e6360000-0000-4000-8000-0000000000a1";
const FERMATE = ["e6360000-0000-4000-8000-0000000000f1", "e6360000-0000-4000-8000-0000000000f2", "e6360000-0000-4000-8000-0000000000f3", "e6360000-0000-4000-8000-0000000000f4"];
const CODICI = ["3001", "3002", "4000", "4002"];
const NOMI = ["Borgo Alto", "Ponte Nuovo", "Lago", "Fornace"];

const tariffe = request(appDiProva(router, utenteDiProva(CHI, ["fares"])));
const altro = request(appDiProva(router, utenteDiProva(ALTRO, ["fares"])));
const admin = request(appDiProva(router, utenteDiProva(ALTRO, ["fares"], "admin")));

/* le fermate su un parallelo, a centesimi di grado l'una dall'altra */
const LAT = 45, LON = 9;
const CENTESIMI = [0, 4, 6, 11];
const lon = (c: number) => LON + c / 100;
const kmVeri = CENTESIMI.map((c) => Math.round(haversineKm(LAT, LON, LAT, lon(c)) * 1000) / 1000);

/* la fotografia di prima: uno ZIP con lo stesso percorso, altri identificativi e km un po' diversi */
const VECCHIA_FOTO = {
  agencyName: "Azienda di prova",
  lines: [{ lineCode: "D", lineName: "Borgo Alto - Fornace", routeIds: ["D"], percorsi: [{
    variantId: "vecchia", routeId: "D", routeIds: ["D"], directionId: 0, tripCount: 3, totalKm: 9,
    firstStopName: "Borgo Alto", lastStopName: "Fornace", stopCount: 4, distanceMethod: "haversine", shape: null,
    stops: CODICI.map((c, i) => ({ stopId: c, stopName: NOMI[i], lat: LAT, lon: lon(CENTESIMI[i]!), km: [0, 3, 5, 9][i], distPrev: 0 })),
  }] }],
};

describe.runIf(!!process.env.TEST_DATABASE_URL)("le polimetriche dal programma, sul database", () => {
  const prima: Record<string, unknown[]> = {};
  const DECISIONI = ["polim_abbinamenti_percorsi", "polim_abbinamenti_punti"] as const;
  const fotografie: string[] = [];

  beforeAll(async () => {
    /* le decisioni del confronto sono di tutta l'azienda: si mettono da parte e si rimettono alla fine */
    for (const t of DECISIONI) prima[t] = (await db.execute<any>(sql`SELECT to_jsonb(x) AS riga FROM ${sql.identifier(t)} x`)).rows.map((r) => r.riga);
    await db.execute(sql`DELETE FROM polim_abbinamenti_percorsi`);
    for (const [id, email] of [[CHI, "tariffe-6.36@prova.local"], [ALTRO, "altro-6.36@prova.local"]] as const) {
      await db.execute(sql`INSERT INTO users (id, email, password_hash, role, full_name) VALUES (${id}::uuid, ${email}, 'x', 'user', 'Prova 6.36') ON CONFLICT (id) DO NOTHING`);
    }
    await db.execute(sql`INSERT INTO ps_projects (id, owner_user_id, name, agency_name) VALUES
      (${PROGETTO}::uuid, ${CHI}::uuid, 'Programma invernale (bozza)', 'Azienda di prova'),
      (${VUOTO}::uuid, ${CHI}::uuid, 'Programma vuoto', NULL)`);
    await db.execute(sql`INSERT INTO ps_routes (id, project_id, short_name, long_name, codice) VALUES (${LINEA}::uuid, ${PROGETTO}::uuid, 'D', 'Borgo Alto - Fornace', 'D')`);
    for (let i = 0; i < 4; i++) {
      await db.execute(sql`INSERT INTO ps_stops (id, project_id, name, lat, lon, codice) VALUES (${FERMATE[i]}::uuid, ${PROGETTO}::uuid, ${NOMI[i]}, ${LAT}, ${lon(CENTESIMI[i]!)}, ${CODICI[i]})`);
    }
    await db.execute(sql`INSERT INTO ps_route_variants (id, project_id, route_id, name, direction) VALUES
      (${VA}::uuid, ${PROGETTO}::uuid, ${LINEA}::uuid, 'Andata', 0), (${VB}::uuid, ${PROGETTO}::uuid, ${LINEA}::uuid, 'Ritorno', 1)`);
    for (let i = 0; i < 4; i++) {
      await db.execute(sql`INSERT INTO ps_variant_stops (variant_id, seq, stop_id) VALUES (${VA}::uuid, ${i + 1}, ${FERMATE[i]}::uuid), (${VB}::uuid, ${i + 1}, ${FERMATE[3 - i]}::uuid)`);
    }
    const linea = { type: "LineString", coordinates: Array.from({ length: 12 }, (_, c) => [lon(c), LAT]) };
    await db.execute(sql`INSERT INTO ps_shapes (project_id, variant_id, geometry) VALUES (${PROGETTO}::uuid, ${VA}::uuid, ${JSON.stringify(linea)}::jsonb)`);
    await db.execute(sql`INSERT INTO ps_trips (project_id, route_id, variant_id) VALUES
      (${PROGETTO}::uuid, ${LINEA}::uuid, ${VA}::uuid), (${PROGETTO}::uuid, ${LINEA}::uuid, ${VA}::uuid), (${PROGETTO}::uuid, ${LINEA}::uuid, ${VB}::uuid)`);
    /* la fotografia di prima, con una polimetrica salvata, e una decisione del confronto sul suo percorso */
    await db.execute(sql`INSERT INTO polim_imports (id, filename, agency_name, line_count, percorso_count, payload)
      VALUES (${VECCHIA}::uuid, 'prova-6.36.zip', 'Azienda di prova', 1, 1, ${JSON.stringify(VECCHIA_FOTO)}::jsonb)`);
    await db.execute(sql`INSERT INTO polim_polimetriche (import_id, route_id, line_code, line_name, variant_id, direction, name, total_km, stop_count, tratta_count, boundaries, tratte, stops, created_by)
      VALUES (${VECCHIA}::uuid, 'D', 'D', 'Borgo Alto - Fornace', 'vecchia', 'AB', 'D · andata', 9, 4, 2, '[2]'::jsonb,
        ${JSON.stringify([{ index: 0, number: 1, label: "Tratta 1", color: "#22c55e", nodeName: "Borgo" }, { index: 1, number: 2, label: "Tratta 2", nodeName: "Lago" }])}::jsonb,
        ${JSON.stringify(CODICI.map((stopId, i) => ({ stopId, ...(i === 1 ? { punto: true } : {}) })))}::jsonb, ${CHI})`);
    await db.execute(sql`INSERT INTO polim_abbinamenti_percorsi (linea_ufficiale, percorso, direzione, route_id, variant_id, verso, fermate)
      VALUES ('T636', '0', '1', 'D', 'vecchia', 'AB', ${`{${CODICI.join(",")}}`}::text[]), ('T636', '0', '2', 'D', 'sparita', 'AB', NULL)`);
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM polim_abbinamenti_percorsi`);
    for (const t of DECISIONI) {
      for (const riga of prima[t] ?? []) {
        await db.execute(sql`INSERT INTO ${sql.identifier(t)} SELECT * FROM jsonb_populate_record(NULL::${sql.identifier(t)}, ${JSON.stringify(riga)}::jsonb)`);
      }
    }
    for (const id of [VECCHIA, ...fotografie]) await db.execute(sql`DELETE FROM polim_imports WHERE id = ${id}::uuid`);
    await db.execute(sql`DELETE FROM ps_trips WHERE project_id = ${PROGETTO}::uuid`);
    await db.execute(sql`DELETE FROM ps_shapes WHERE project_id = ${PROGETTO}::uuid`);
    await db.execute(sql`DELETE FROM ps_variant_stops WHERE variant_id IN (${VA}::uuid, ${VB}::uuid)`);
    await db.execute(sql`DELETE FROM ps_route_variants WHERE project_id = ${PROGETTO}::uuid`);
    await db.execute(sql`DELETE FROM ps_stops WHERE project_id = ${PROGETTO}::uuid`);
    await db.execute(sql`DELETE FROM ps_routes WHERE project_id = ${PROGETTO}::uuid`);
    await db.execute(sql`DELETE FROM ps_projects WHERE id IN (${PROGETTO}::uuid, ${VUOTO}::uuid)`);
    await db.execute(sql`DELETE FROM users WHERE id IN (${CHI}::uuid, ${ALTRO}::uuid)`);
    await pool.end();
  });

  it("una bozza la sceglie chi la può aprire in Planning Studio, e l'amministratore", async () => {
    const mie = (await tariffe.get("/api/fares/polimetriche/programmi")).body.programmi.filter((p: any) => [PROGETTO, VUOTO].includes(p.id));
    expect(mie.map((p: any) => [p.nome, p.stato, p.ultimaFotografia])).toEqual(expect.arrayContaining([["Programma invernale (bozza)", "bozza", null], ["Programma vuoto", "bozza", null]]));
    expect((await altro.get("/api/fares/polimetriche/programmi")).body.programmi.map((p: any) => p.id)).not.toContain(PROGETTO);
    expect((await admin.get("/api/fares/polimetriche/programmi")).body.programmi.map((p: any) => p.id)).toContain(PROGETTO);
    const r = await altro.post(`/api/fares/polimetriche/programmi/${PROGETTO}/fotografia`);
    expect([r.status, r.body.error]).toEqual([404, "Programma non trovato"]);
    expect((await tariffe.post("/api/fares/polimetriche/programmi/abc/fotografia")).status).toBe(400);
  });

  it("la fotografia: linee extraurbane, varianti con corse, km sulla geometria; il lavoro fatto viene con sé", async () => {
    const r = await tariffe.post(`/api/fares/polimetriche/programmi/${PROGETTO}/fotografia`);
    expect(r.status).toBe(200);
    fotografie.push(r.body.importId);
    expect(r.body).toMatchObject({
      programma: { id: PROGETTO, nome: "Programma invernale (bozza)", stato: "bozza" }, lineCount: 1, percorsoCount: 2,
      lavoro: { da: { importId: VECCHIA, nome: "prova-6.36.zip" }, polimetriche: 1, nonPortate: [], decisioni: 1, decisioniSenzaPercorso: 1 },
    });
    const [riga] = (await db.execute<any>(sql`SELECT * FROM polim_imports WHERE id = ${r.body.importId}::uuid`)).rows;
    expect([riga.fonte, riga.progetto_id, riga.progetto_nome, riga.stato_programma, riga.created_by]).toEqual(["programma", PROGETTO, "Programma invernale (bozza)", "bozza", CHI]);
    const [andata, ritorno] = riga.payload.lines[0].percorsi;
    expect([andata.variantId, andata.routeId, andata.tripCount, andata.distanceMethod]).toEqual([VA, "D", 2, "shape"]);
    expect(andata.stops.map((s: any) => [s.stopId, s.stopName, s.km])).toEqual(CODICI.map((c, i) => [c, NOMI[i], kmVeri[i]]));
    expect([ritorno.variantId, ritorno.directionId, ritorno.distanceMethod, ritorno.stops.map((s: any) => s.stopId)]).toEqual([VB, 1, "haversine", [...CODICI].reverse()]);

    /* la polimetrica salvata: sul percorso nuovo, coi km nuovi, con le stesse decisioni */
    const [p] = (await db.execute<any>(sql`SELECT * FROM polim_polimetriche WHERE import_id = ${r.body.importId}::uuid`)).rows;
    expect([p.route_id, p.variant_id, p.direction, p.name, p.total_km, p.created_by, p.boundaries]).toEqual(["D", VA, "AB", "D · andata", kmVeri[3], CHI, [2]]);
    expect(p.stops.map((s: any) => [s.stopId, s.km, s.punto ?? null])).toEqual(CODICI.map((c, i) => [c, kmVeri[i], i === 1 ? true : null]));
    expect(p.tratte.map((t: any) => [t.nodeName, t.puntoStopName, t.km])).toEqual([["Borgo", "Ponte Nuovo", Math.round(kmVeri[2]! * 100) / 100], ["Lago", "Lago", Math.round((kmVeri[3]! - kmVeri[2]!) * 100) / 100]]);

    /* le decisioni del confronto non si toccano: valgono per fermate */
    const d = (await db.execute<any>(sql`SELECT direzione, variant_id FROM polim_abbinamenti_percorsi WHERE linea_ufficiale = 'T636' ORDER BY direzione`)).rows;
    expect(d).toEqual([{ direzione: "1", variant_id: "vecchia" }, { direzione: "2", variant_id: "sparita" }]);
  });

  it("una seconda fotografia porta il lavoro dalla più recente", async () => {
    const r = await tariffe.post(`/api/fares/polimetriche/programmi/${PROGETTO}/fotografia`);
    expect(r.status).toBe(200);
    fotografie.push(r.body.importId);
    expect(r.body.lavoro).toMatchObject({ da: { importId: fotografie[0] }, polimetriche: 1 });
    const elenco = (await tariffe.get("/api/fares/polimetriche/imports")).body.filter((x: any) => [VECCHIA, ...fotografie].includes(x.id));
    expect(elenco.map((x: any) => [x.fonte, x.statoProgramma, x.salvate])).toEqual([["programma", "bozza", 1], ["programma", "bozza", 1], ["gtfs", null, 1]]);
    const prog = (await tariffe.get("/api/fares/polimetriche/programmi")).body.programmi.find((x: any) => x.id === PROGETTO);
    expect(prog.ultimaFotografia).not.toBeNull();
  });

  it("un programma senza linee extraurbane con corse non si fotografa", async () => {
    const r = await tariffe.post(`/api/fares/polimetriche/programmi/${VUOTO}/fotografia`);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/^Nel programma non ci sono linee extraurbane con corse/);
  });

  it("le fotografie si vedono da tutta l'azienda; se il programma si cancella, la fotografia resta", async () => {
    expect((await altro.get("/api/fares/polimetriche/imports")).body.map((x: any) => x.id)).toEqual(expect.arrayContaining(fotografie));
    await db.execute(sql`DELETE FROM ps_projects WHERE id = ${VUOTO}::uuid`);
    const [x] = (await db.execute<any>(sql`SELECT count(*)::int AS n FROM polim_imports WHERE id = ${fotografie[0]}::uuid`)).rows;
    expect(x.n).toBe(1);
  });
});
