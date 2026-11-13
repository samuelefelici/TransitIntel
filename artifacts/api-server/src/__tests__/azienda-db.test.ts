/**
 * I dati dell'azienda su un database vero (TEST_DATABASE_URL, migrato; in CI
 * come cerbero_app). PR 2.17a, migrazione 0014.
 *
 * - tabella vuota (installazione nuova): valori neutri, e il primo salvataggio
 *   crea la riga;
 * - i salvataggi dopo cambiano quella riga: resta sempre una;
 * - i vincoli della tabella fermano quello che passa accanto all'API;
 * - il registro delle modifiche la sorveglia, con i valori.
 * Alla fine la tabella torna com'era.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db, pool } from "@workspace/db";
import { sql } from "drizzle-orm";
import adminRouter from "../routes/admin";
import { AZIENDA_DA_COMPILARE, dimenticaAzienda, leggiAzienda, paroleVietateDellAzienda } from "../lib/azienda";
import { appDiProva, utenteDiProva } from "./helpers/app-di-prova";

const ADMIN = "e1700000-0000-4000-8000-000000000001";
const admin = request(appDiProva(adminRouter, utenteDiProva(ADMIN, [], "admin")));
const BUONI = {
  ragioneSociale: "Trasporti Esempio S.r.l.", nome: "Esempio", sito: "https://www.esempio.it", telefono: "+39 0721 000000",
  gtfsAgencyId: "esempio", citta: "Pesaro", regione: "Marche", centroLat: 43.91, centroLng: 12.91, zoom: 11,
};
const righe = async (q: ReturnType<typeof sql>) => (await db.execute<any>(q)).rows;
const codice = async (q: ReturnType<typeof sql>) => {
  try { await db.execute(q); return null; } catch (e: any) { return String(e?.code ?? e?.cause?.code ?? e?.message); }
};

describe.runIf(!!process.env.TEST_DATABASE_URL)("i dati dell'azienda (database vero)", () => {
  let prima: any[] = [];
  beforeAll(async () => {
    prima = await righe(sql`SELECT * FROM azienda`);
    await db.execute(sql`DELETE FROM azienda`);
    dimenticaAzienda();
  });
  afterAll(async () => {
    await db.execute(sql`DELETE FROM azienda`);
    for (const r of prima) {
      await db.execute(sql`
        INSERT INTO azienda (unica, ragione_sociale, nome, sito, telefono, gtfs_agency_id, citta, regione, centro_lat, centro_lng, zoom, aggiornata_il, aggiornata_da)
        VALUES (true, ${r.ragione_sociale}, ${r.nome}, ${r.sito}, ${r.telefono}, ${r.gtfs_agency_id}, ${r.citta}, ${r.regione},
                ${r.centro_lat}, ${r.centro_lng}, ${r.zoom}, ${r.aggiornata_il}, ${r.aggiornata_da})`);
    }
    await pool.end();
  });

  it("tabella vuota: valori neutri, nessuna parola vietata dell'azienda, pagina «da compilare»", async () => {
    expect(await leggiAzienda()).toEqual(AZIENDA_DA_COMPILARE);
    expect(await paroleVietateDellAzienda()).toEqual([]);
    const r = await admin.get("/api/admin/azienda");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ azienda: { ...AZIENDA_DA_COMPILARE }, aggiornataIl: null, aggiornataDa: null });
  });

  it("il primo salvataggio crea la riga, con chi l'ha salvata; chi legge la vede subito", async () => {
    const r = await admin.put("/api/admin/azienda").send(BUONI);
    expect(r.status).toBe(200);
    expect(r.body.azienda).toEqual({
      ragioneSociale: "Trasporti Esempio S.r.l.", nome: "Esempio", sito: "https://www.esempio.it", telefono: "+39 0721 000000",
      gtfsAgencyId: "esempio", citta: "Pesaro", regione: "Marche", centro: { lat: 43.91, lng: 12.91, zoom: 11 }, compilata: true,
    });
    expect(r.body.aggiornataIl).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const [riga] = await righe(sql`SELECT unica, aggiornata_da::text AS da FROM azienda`);
    expect(riga).toEqual({ unica: true, da: ADMIN });
    expect((await leggiAzienda()).nome).toBe("Esempio");
    expect(await paroleVietateDellAzienda()).toEqual(expect.arrayContaining(["esempio", "pesaro", "trasporti"]));
  });

  it("i salvataggi dopo cambiano la stessa riga; i facoltativi si possono togliere", async () => {
    const r = await admin.put("/api/admin/azienda").send({ ...BUONI, nome: "Esempio Bus", sito: "", telefono: null, regione: "" });
    expect(r.status).toBe(200);
    const tutte = await righe(sql`SELECT nome, sito, telefono, regione FROM azienda`);
    expect(tutte).toEqual([{ nome: "Esempio Bus", sito: null, telefono: null, regione: null }]);
  });

  it("un valore che non va si ferma prima del database, e la riga resta com'era", async () => {
    const r = await admin.put("/api/admin/azienda").send({ ...BUONI, gtfsAgencyId: "esempio,1" });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/^Identificativo GTFS:/);
    expect((await righe(sql`SELECT nome FROM azienda`))[0].nome).toBe("Esempio Bus");
  });

  it("i vincoli della tabella fermano anche chi scrive senza passare dall'API", async () => {
    // una riga sola
    expect(await codice(sql`INSERT INTO azienda (ragione_sociale, nome, gtfs_agency_id, citta, centro_lat, centro_lng, zoom) VALUES ('x', 'x', 'x', 'x', 0, 0, 5)`)).toBe("23505");
    expect(await codice(sql`INSERT INTO azienda (unica, ragione_sociale, nome, gtfs_agency_id, citta, centro_lat, centro_lng, zoom) VALUES (false, 'x', 'x', 'x', 'x', 0, 0, 5)`)).toBe("23514");
    // quello che finirebbe male in un CSV, in un link o sulla mappa
    for (const set of [sql`sito = 'javascript:alert(1)'`, sql`sito = 'https://esempio.it,altro'`, sql`telefono = '<script>'`,
      sql`gtfs_agency_id = 'a,b'`, sql`nome = '   '`, sql`ragione_sociale = ''`, sql`citta = ''`,
      sql`centro_lat = 91`, sql`centro_lng = -181`, sql`zoom = 2`, sql`zoom = 19`]) {
      expect(await codice(sql`UPDATE azienda SET ${set}`)).toBe("23514");
    }
    expect(await codice(sql`UPDATE azienda SET nome = NULL`)).toBe("23502");
  });

  it("il registro delle modifiche la sorveglia con i valori, senza la data dell'ultimo salvataggio", async () => {
    const [regola] = await righe(sql`SELECT chiave, con_valori, escluse FROM registro.sorvegliate WHERE tabella = 'public.azienda'`);
    expect(regola.chiave).toEqual(["unica"]);
    expect(regola.con_valori).toBe(true);
    expect(regola.escluse).toContain("aggiornata_il");
  });
});
