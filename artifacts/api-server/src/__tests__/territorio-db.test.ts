/**
 * Il territorio dell'azienda (tappa 6.1, migrazione 0035) su un database vero
 * (TEST_DATABASE_URL; in CI come cerbero_app): l'amministratore salva e
 * toglie comuni e luoghi; chi legge vede i nomi; senza provincia e senza
 * luoghi gli import si fermano con un messaggio, prima di toccare i dati.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import adminRouter from "../routes/admin";
import { dimenticaAzienda, leggiAzienda } from "../lib/azienda";
import { dimenticaTerritorio, leggiLuoghi, nomeComune, nomiComuni } from "../lib/territorio";
import { riquadroDiRicerca, riquadroPerOverpass, syncCommutingOdFromIstat, syncPoiFromGoogle, syncPoiFromOsm } from "../routes/cron";
import { appDiProva, utenteDiProva } from "./helpers/app-di-prova";

const ADMIN = "e6100000-0000-4000-8000-000000000001";
const admin = request(appDiProva(adminRouter, utenteDiProva(ADMIN, [], "admin")));
const persona = request(appDiProva(adminRouter, utenteDiProva("e6100000-0000-4000-8000-000000000002", ["roster"], "user")));
const CODICE = "099001";
const righe = async (q: ReturnType<typeof sql>) => (await db.execute<any>(q)).rows;

describe.runIf(!!process.env.TEST_DATABASE_URL)("il territorio dell'azienda, sul database", () => {
  let aziendaCera = false;
  const pulisci = async () => {
    await db.execute(sql`DELETE FROM territorio_comuni WHERE codice_istat LIKE '099%'`);
    await db.execute(sql`DELETE FROM territorio_luoghi WHERE nome LIKE 'Prova 6.1%'`);
    dimenticaTerritorio();
  };
  beforeAll(async () => {
    await pulisci();
    aziendaCera = (await righe(sql`SELECT 1 FROM azienda`)).length > 0;
  });
  afterAll(async () => {
    await pulisci();
    if (!aziendaCera) await db.execute(sql`DELETE FROM azienda`);
    dimenticaAzienda();
  });

  it("solo l'amministratore", async () => {
    expect((await persona.get("/api/admin/territorio")).status).toBe(403);
    expect((await persona.put(`/api/admin/territorio/comuni/${CODICE}`).send({ nome: "x" })).status).toBe(403);
    expect((await persona.post("/api/admin/territorio/luoghi").send({ nome: "x", uso: "meteo", lat: 1, lng: 1 })).status).toBe(403);
  });

  it("dice ogni quanto si leggono i punti stradali, dentro la quota del mese (tappa 7.30)", async () => {
    const quota = process.env.TRAFFICO_RICHIESTE_MESE;
    process.env.TRAFFICO_RICHIESTE_MESE = "9000";
    try {
      const r = (await admin.get("/api/admin/territorio")).body;
      const punti = r.luoghi.filter((l: any) => l.uso === "traffico").length;
      expect(r.traffico).toEqual({ quotaMese: 9000, ogniMin: punti ? Math.max(30, Math.ceil((punti * 31 * 24 * 60) / 9000)) : 60, attivo: !!process.env.TOMTOM_API_KEY });
    } finally {
      if (quota === undefined) delete process.env.TRAFFICO_RICHIESTE_MESE; else process.env.TRAFFICO_RICHIESTE_MESE = quota;
    }
  });

  it("un comune: si salva, si legge per nome da ogni forma del codice, si cambia, si toglie", async () => {
    const r = await admin.put(`/api/admin/territorio/comuni/${CODICE}`).send({ nome: "Prova 6.1", lat: 44.1, lng: 12.1, areaKm2: 10.5, popolazione: 1234 });
    expect(r.status).toBe(200);
    expect(r.body.comune).toEqual({ codiceIstat: CODICE, nome: "Prova 6.1", soppresso: false, lat: 44.1, lng: 12.1, areaKm2: 10.5, popolazione: 1234, sezioneCensimento: null });
    const nomi = await nomiComuni();
    expect(nomeComune("99001", nomi)).toBe("Prova 6.1");
    expect(nomeComune("990010", nomi)).toBe("Prova 6.1");
    // il codice nel corpo non conta: vale quello del percorso
    expect((await admin.put(`/api/admin/territorio/comuni/${CODICE}`).send({ codiceIstat: "099999", nome: "Prova 6.1 bis", soppresso: true })).body.comune)
      .toMatchObject({ codiceIstat: CODICE, nome: "Prova 6.1 bis", soppresso: true, lat: null });
    expect((await admin.get("/api/admin/territorio")).body.comuni.filter((c: any) => c.codiceIstat.startsWith("099"))).toHaveLength(1);
    expect((await admin.delete(`/api/admin/territorio/comuni/${CODICE}`)).body).toEqual({ ok: true });
    expect((await admin.delete(`/api/admin/territorio/comuni/${CODICE}`)).status).toBe(404);
  });

  it("un comune sbagliato: 400, e il database lo ripete", async () => {
    expect((await admin.put("/api/admin/territorio/comuni/42002").send({ nome: "x" })).status).toBe(400);
    expect((await admin.put(`/api/admin/territorio/comuni/${CODICE}`).send({ nome: "x", lat: 44 })).status).toBe(400);
    expect((await admin.put(`/api/admin/territorio/comuni/${CODICE}`).send({ nome: "", lat: 44, lng: 12 })).status).toBe(400);
    expect((await admin.put(`/api/admin/territorio/comuni/${CODICE}`).send({ nome: "x", popolazione: -1 })).status).toBe(400);
    await expect(db.execute(sql`INSERT INTO territorio_comuni (codice_istat, nome) VALUES ('99x001', 'x')`))
      .rejects.toMatchObject({ cause: expect.objectContaining({ code: "23514" }) });
    await expect(db.execute(sql`INSERT INTO territorio_comuni (codice_istat, nome, lat) VALUES ('099002', 'x', 44)`))
      .rejects.toMatchObject({ cause: expect.objectContaining({ code: "23514" }) });
  });

  it("i luoghi: si creano, si cambiano, si tolgono; il raggio solo per i punti d'interesse", async () => {
    const r = await admin.post("/api/admin/territorio/luoghi").send({ nome: "Prova 6.1 meteo", uso: "meteo", lat: 43.6, lng: 13.5 });
    expect(r.status).toBe(201);
    expect(r.body.luogo).toMatchObject({ nome: "Prova 6.1 meteo", uso: "meteo", raggioM: null });
    expect((await leggiLuoghi("meteo")).some((l) => l.nome === "Prova 6.1 meteo")).toBe(true);
    expect((await admin.post("/api/admin/territorio/luoghi").send({ nome: "Prova 6.1 x", uso: "meteo", lat: 43.6, lng: 13.5, raggioM: 2000 })).status).toBe(400);
    expect((await admin.post("/api/admin/territorio/luoghi").send({ nome: "Prova 6.1 x", uso: "altro", lat: 43.6, lng: 13.5 })).status).toBe(400);
    // da meteo a punti d'interesse: il raggio, se non detto, è 3 km
    const m = await admin.put(`/api/admin/territorio/luoghi/${r.body.luogo.id}`).send({ nome: "Prova 6.1 centro", uso: "punti_interesse", lat: 43.6, lng: 13.5 });
    expect(m.body.luogo).toMatchObject({ nome: "Prova 6.1 centro", uso: "punti_interesse", raggioM: 3000 });
    expect((await admin.delete(`/api/admin/territorio/luoghi/${r.body.luogo.id}`)).body).toEqual({ ok: true });
    expect((await admin.delete(`/api/admin/territorio/luoghi/${r.body.luogo.id}`)).status).toBe(404);
    expect((await admin.put("/api/admin/territorio/luoghi/non-un-id").send({ nome: "x", uso: "meteo", lat: 1, lng: 1 })).status).toBe(404);
  });

  it("la provincia ISTAT sta con l'azienda; senza, l'import del pendolarismo si ferma col messaggio", async () => {
    const base = {
      ragioneSociale: "Trasporti Prova 6.1 S.r.l.", nome: "Prova", gtfsAgencyId: "prova61", citta: "Pesaro",
      centroLat: 43.9, centroLng: 12.9, zoom: 10,
    };
    if (!aziendaCera) {
      expect((await admin.put("/api/admin/azienda").send(base)).status).toBe(200);
      dimenticaAzienda();
      expect((await leggiAzienda()).provinciaIstat).toBeNull();
      await expect(syncCommutingOdFromIstat()).rejects.toThrow(/Provincia ISTAT non impostata/);
      const r = await admin.put("/api/admin/azienda").send({ ...base, provinciaIstat: "041" });
      expect(r.body.azienda.provinciaIstat).toBe("041");
      dimenticaAzienda();
      expect((await leggiAzienda()).provinciaIstat).toBe("041");
    }
    expect((await admin.put("/api/admin/azienda").send({ ...base, provinciaIstat: "41" })).status).toBe(400);
    await expect(syncCommutingOdFromIstat({ provinceCode: "4x" })).rejects.toThrow(/Provincia ISTAT/);
  });

  it("senza luoghi per i punti d'interesse la ricerca si ferma prima di cancellare quelli che ci sono", async () => {
    if ((await leggiLuoghi("punti_interesse")).length) return;
    const prima = Number((await righe(sql`SELECT count(*)::int AS n FROM points_of_interest`))[0].n);
    const chiave = process.env.GOOGLE_PLACES_API_KEY;
    process.env.GOOGLE_PLACES_API_KEY = "chiave-di-prova";
    try {
      await expect(syncPoiFromGoogle()).rejects.toThrow(/Nessun luogo dove cercare/);
    } finally {
      if (chiave === undefined) delete process.env.GOOGLE_PLACES_API_KEY; else process.env.GOOGLE_PLACES_API_KEY = chiave;
    }
    expect(Number((await righe(sql`SELECT count(*)::int AS n FROM points_of_interest`))[0].n)).toBe(prima);
    /* e così l'import da OpenStreetMap (tappa 6.32): senza luoghi non c'è un riquadro dove cercare */
    await expect(syncPoiFromOsm()).rejects.toThrow(/Nessun luogo dove cercare/);
    expect(Number((await righe(sql`SELECT count(*)::int AS n FROM points_of_interest`))[0].n)).toBe(prima);
  });

  it("l'import da OpenStreetMap cerca nel riquadro dei luoghi dell'azienda, non in uno scritto nel codice (tappa 6.32)", async () => {
    if ((await leggiLuoghi("punti_interesse")).length) return;
    const poiPrima = (await righe(sql`SELECT to_jsonb(p) AS riga FROM points_of_interest p`)).map((r: any) => r.riga);
    const nuovo = await admin.post("/api/admin/territorio/luoghi").send({ nome: "Prova 6.1 ricerca", uso: "punti_interesse", lat: 45.0, lng: 10.0, raggioM: 4000 });
    expect(nuovo.status, JSON.stringify(nuovo.body)).toBe(201);
    dimenticaTerritorio();
    const atteso = riquadroPerOverpass(riquadroDiRicerca([{ lat: 45.0, lng: 10.0, radius: 4000 }])!);
    /* 4 km di raggio più 5 di margine: circa 0,081 gradi di latitudine per parte */
    expect(atteso).toBe("44.9192,9.8857,45.0808,10.1143");
    const chieste: string[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: any) => {
      chieste.push(String(init?.body ?? ""));
      return new Response(JSON.stringify({ elements: chieste.length === 1 ? [
        { type: "node", id: 630001, lat: 45.01, lon: 10.02, tags: { name: "Ospedale di prova 6.32", amenity: "hospital" } },
      ] : [] }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    try {
      const r = await syncPoiFromOsm();
      expect(r.inserted).toBeGreaterThanOrEqual(1);
      expect(chieste.length).toBeGreaterThan(5);
      for (const q of chieste) {
        const riquadri = [...q.matchAll(/\]\(([^)]*)\)/g)].map((m) => m[1]);
        expect(riquadri.length).toBeGreaterThan(0);
        expect(new Set(riquadri)).toEqual(new Set([atteso]));
      }
    } finally {
      vi.unstubAllGlobals();
      await db.execute(sql`DELETE FROM points_of_interest`);
      for (const riga of poiPrima) await db.execute(sql`INSERT INTO points_of_interest SELECT * FROM jsonb_populate_record(NULL::points_of_interest, ${JSON.stringify(riga)}::jsonb)`);
    }
  });
});
