/**
 * Le polimetriche dell'area di lavoro, salvate su un database vero (tappa
 * 6.35; TEST_DATABASE_URL, in CI come cerbero_app).
 *
 * Il salvataggio prende dal browser solo le decisioni (confini, punti
 * tariffari, nomi dei nodi) e dall'import il resto: linea, fermate, km. Le
 * fermate devono essere quelle del percorso. Un identificativo che non è un
 * UUID dà 400, non un errore del database. Dati inventati.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db, pool } from "@workspace/db";
import { sql } from "drizzle-orm";
import router from "../routes/fares-polimetriche";
import { decidi } from "../lib/permessi-rotte";
import { appDiProva, utenteDiProva } from "./helpers/app-di-prova";

const CHI = "e6350000-0000-4000-8000-000000000001";
const IMPORT = "e6350000-0000-4000-8000-0000000000a1";
const NESSUNO = "e6350000-0000-4000-8000-0000000000ff";
const tariffe = request(appDiProva(router, utenteDiProva(CHI, ["fares"])));

const fermata = (stopId: string, stopName: string, km: number, distPrev: number) => ({ stopId, stopName, lat: 1, lon: 2, km, distPrev });
const PAYLOAD = {
  agencyName: "Azienda di prova",
  lines: [
    { lineCode: "D", lineName: "Borgo Alto - Fornace", routeIds: ["D", "D-bis"], percorsi: [{
      variantId: "a", routeId: "D", routeIds: ["D", "D-bis"], directionId: 0, tripCount: 7, totalKm: 13.5,
      firstStopName: "Borgo Alto", lastStopName: "Fornace", stopCount: 4, distanceMethod: "haversine",
      stops: [fermata("3001", "Borgo Alto", 0, 0), fermata("3002", "Ponte Nuovo", 5.1, 5.1), fermata("4000", "Lago", 7.25, 2.15), fermata("4002", "Fornace", 13.5, 6.25)],
      shape: null,
    }] },
  ],
};
const IDS = ["3001", "3002", "4000", "4002"];

/** Il corpo come lo manda la pagina, con i campi calcolati dal browser. */
const corpo = (extra: Record<string, unknown> = {}) => ({
  importId: IMPORT, routeId: "D", variantId: "a", direction: "AB",
  lineCode: "D", lineName: "Borgo Alto - Fornace", name: "D · andata", totalKm: 13.5,
  boundaries: [2],
  tratte: [
    { index: 0, number: 1, label: "Tratta 1", color: "#22c55e", nodeName: "Borgo", fromStopIdx: 0, toStopIdx: 2, km: 7.25 },
    { index: 1, number: 2, label: "Tratta 2", color: "#38bdf8", nodeName: "Lago", fromStopIdx: 2, toStopIdx: 3, km: 6.25 },
  ],
  stops: PAYLOAD.lines[0]!.percorsi[0]!.stops.map((s, i) => ({ ...s, tratta: i < 2 ? 0 : 1, ...(i === 1 ? { punto: true } : {}) })),
  ...extra,
});

describe.runIf(!!process.env.TEST_DATABASE_URL)("le polimetriche salvate, sul database", () => {
  beforeAll(async () => {
    await db.execute(sql`INSERT INTO polim_imports (id, filename, agency_name, line_count, percorso_count, payload)
      VALUES (${IMPORT}::uuid, 'prova-6.35.zip', 'Azienda di prova', 1, 1, ${JSON.stringify(PAYLOAD)}::jsonb) ON CONFLICT (id) DO NOTHING`);
  });

  afterAll(async () => {
    /* le polimetriche salvate se ne vanno con l'import (chiave esterna a cascata) */
    await db.execute(sql`DELETE FROM polim_imports WHERE id = ${IMPORT}::uuid`);
    await pool.end();
  });

  const riga = async (direzione: string) =>
    (await db.execute<any>(sql`SELECT * FROM polim_polimetriche WHERE import_id = ${IMPORT}::uuid AND direction = ${direzione}`)).rows;

  it("salva come la pagina; linea, fermate e km vengono dall'import", async () => {
    const b = corpo({ lineCode: "ZZ", totalKm: 99 });
    b.stops[2] = { ...b.stops[2]!, km: 50, stopName: "<b>altro</b>" };
    const r = await tariffe.post("/api/fares/polimetriche/saved").send(b);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ importId: IMPORT, routeId: "D", lineCode: "D", lineName: "Borgo Alto - Fornace", direction: "AB", name: "D · andata", totalKm: 13.5, stopCount: 4, trattaCount: 2, boundaries: [2] });
    const [x] = await riga("AB");
    expect(x.stops.map((s: any) => [s.stopId, s.stopName, s.km, s.tratta, s.punto ?? null])).toEqual([
      ["3001", "Borgo Alto", 0, 0, null], ["3002", "Ponte Nuovo", 5.1, 0, true], ["4000", "Lago", 7.25, 1, null], ["4002", "Fornace", 13.5, 1, null],
    ]);
    expect(x.tratte.map((t: any) => [t.nodeName, t.fromStopName, t.toStopName, t.km, t.puntoStopName, t.puntoKm])).toEqual([
      ["Borgo", "Borgo Alto", "Lago", 7.25, "Ponte Nuovo", 5.1], ["Lago", "Lago", "Fornace", 6.25, "Lago", 7.25],
    ]);
    expect(x.created_by).toBe(CHI);
  });

  it("un secondo salvataggio aggiorna la stessa riga, anche chiamando il percorso con una linea sorella", async () => {
    const r = await tariffe.post("/api/fares/polimetriche/saved").send(corpo({ routeId: "D-bis", name: "D · rivista", boundaries: [], tratte: [{ index: 0, nodeName: "Tutto" }] }));
    expect(r.status).toBe(200);
    const righe = await riga("AB");
    expect(righe).toHaveLength(1);
    expect([righe[0].route_id, righe[0].name, righe[0].tratta_count, righe[0].stops[1].punto]).toEqual(["D", "D · rivista", 1, true]);
  });

  it("il ritorno è un'altra polimetrica, con le fermate al contrario", async () => {
    const r = await tariffe.post("/api/fares/polimetriche/saved").send(corpo({
      direction: "BA", boundaries: [1], tratte: [{ index: 0 }, { index: 1 }], stops: [...IDS].reverse().map((stopId) => ({ stopId })),
    }));
    expect(r.status).toBe(200);
    const [x] = await riga("BA");
    expect(x.stops.map((s: any) => [s.stopId, s.km])).toEqual([["4002", 0], ["4000", 6.25], ["3002", 8.4], ["3001", 13.5]]);
    const elenco = await tariffe.get(`/api/fares/polimetriche/saved?importId=${IMPORT}`);
    expect(elenco.status).toBe(200);
    expect(elenco.body.map((p: any) => p.direction).sort()).toEqual(["AB", "BA"]);
  });

  it("rifiuta quello che non torna, senza scrivere niente", async () => {
    const prima = (await db.execute<any>(sql`SELECT count(*)::int AS n, max(updated_at) AS t FROM polim_polimetriche WHERE import_id = ${IMPORT}::uuid`)).rows[0];
    const casi: [Record<string, unknown>, number, string][] = [
      [corpo({ importId: "abc" }), 400, "Dati non validi (import): import non valido"],
      [corpo({ importId: NESSUNO }), 404, "Import non trovato"],
      [corpo({ variantId: "zz" }), 400, "Il percorso non è in questo import"],
      [corpo({ stops: IDS.slice(0, 3).map((stopId) => ({ stopId })) }), 400, "Le fermate non sono quelle del percorso: 3 invece di 4"],
      [corpo({ boundaries: [4] }), 400, "Il confine 4 è fuori dal percorso (fermate da 1 a 3)"],
      [corpo({ name: "x".repeat(201) }), 400, "Dati non validi (nome): al più 200 caratteri"],
      [corpo({ tratte: "tutte" }), 400, "Dati non validi (tratte): tipo sbagliato"],
    ];
    for (const [b, stato, messaggio] of casi) {
      const r = await tariffe.post("/api/fares/polimetriche/saved").send(b);
      expect([r.status, r.body.error], messaggio).toEqual([stato, messaggio]);
    }
    const dopo = (await db.execute<any>(sql`SELECT count(*)::int AS n, max(updated_at) AS t FROM polim_polimetriche WHERE import_id = ${IMPORT}::uuid`)).rows[0];
    expect(dopo).toEqual(prima);
  });

  it("un identificativo che non è un UUID dà 400, uno che non c'è 404", async () => {
    expect((await tariffe.get("/api/fares/polimetriche/saved?importId=abc")).status).toBe(400);
    expect((await tariffe.get("/api/fares/polimetriche/imports/abc")).status).toBe(400);
    expect((await tariffe.get("/api/fares/polimetriche/imports/abc/percorso?routeId=D&variantId=a")).status).toBe(400);
    expect((await tariffe.get("/api/fares/polimetriche/imports/abc/full")).status).toBe(400);
    expect((await tariffe.delete("/api/fares/polimetriche/imports/abc")).status).toBe(400);
    expect((await tariffe.delete("/api/fares/polimetriche/saved/abc")).status).toBe(400);
    const r = await tariffe.delete(`/api/fares/polimetriche/saved/${NESSUNO}`);
    expect([r.status, r.body.error]).toEqual([404, "Polimetrica non trovata"]);
    expect((await tariffe.get(`/api/fares/polimetriche/imports/${NESSUNO}`)).status).toBe(404);
  });

  it("la cancellazione di più percorsi vuole un elenco di coppie di testi", async () => {
    for (const items of [undefined, "D", [{ routeId: { $ne: 1 }, variantId: "a" }], [{ routeId: "D" }]]) {
      const r = await tariffe.post(`/api/fares/polimetriche/imports/${IMPORT}/percorsi/delete`).send({ items });
      expect([r.status, r.body.error], JSON.stringify(items)).toEqual([400, "Elenco dei percorsi da eliminare non valido"]);
    }
    const vuoto = await tariffe.post(`/api/fares/polimetriche/imports/${IMPORT}/percorsi/delete`).send({ items: [] });
    expect([vuoto.status, vuoto.body.error]).toEqual([400, "Nessun percorso da eliminare"]);
  });

  it("si cancella una polimetrica salvata", async () => {
    const [x] = await riga("BA");
    expect((await tariffe.delete(`/api/fares/polimetriche/saved/${x.id}`)).status).toBe(200);
    expect(await riga("BA")).toEqual([]);
  });

  it("legge chi ha le tariffe; salva e cancella chi può scriverle", () => {
    const tariffista = { admin: false, diritti: utenteDiProva(CHI, ["fares"]).diritti };
    const altro = { admin: false, diritti: utenteDiProva(CHI, ["roster"]).diritti };
    for (const [m, p] of [["GET", "/fares/polimetriche/saved"], ["POST", "/fares/polimetriche/saved"], ["DELETE", `/fares/polimetriche/saved/${NESSUNO}`]]) {
      expect(decidi(tariffista, m!, p!), `${m} ${p}`).toEqual({ passa: true });
      expect(decidi(altro, m!, p!).passa, `${m} ${p}`).toBe(false);
    }
  });
});
