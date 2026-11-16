/**
 * Mezzi per deposito (tappa 5.3) su un database vero (TEST_DATABASE_URL; in
 * CI come cerbero_app): il fabbisogno viene dai turni macchina della
 * giornata; senza FleetCare (in CI non c'è) resta il fabbisogno con il motivo.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import rosterRouter from "../routes/roster";
import { fabbisognoDelGiorno } from "../lib/mezzi-deposito";
import { appDiProva, utenteDiProva } from "./helpers/app-di-prova";

const GIORNO = "2032-06-15";
const VSS = "e5300000-0000-4000-8000-000000000001";
const admin = request(appDiProva(rosterRouter, utenteDiProva("e5300000-0000-4000-8000-000000000002", [], "admin")));

describe.runIf(!!process.env.TEST_DATABASE_URL)("mezzi per deposito, sul database", () => {
  const pulisci = () => db.execute(sql`DELETE FROM esercizio_giornate WHERE giorno = ${GIORNO}::date`);
  beforeAll(async () => {
    await pulisci();
    await db.execute(sql`INSERT INTO esercizio_giornate (giorno, stato, corse, preparata_il, turni) VALUES (${GIORNO}::date, 'preparata', 0, now(), '{}'::jsonb)`);
    await db.execute(sql`INSERT INTO esercizio_turni_macchina (giorno, vss_id, turno_macchina, deposito, tipo_mezzo, corse, corse_nel_giorno, km_vuoto_prog) VALUES
      (${GIORNO}::date, ${VSS}::uuid, 'M1', 'Deposito di prova 5.3', '12m', 4, 4, 1),
      (${GIORNO}::date, ${VSS}::uuid, 'M2', 'Deposito di prova 5.3', '12m', 3, 3, 1),
      (${GIORNO}::date, ${VSS}::uuid, 'M3', 'Deposito di prova 5.3', '18m', 2, 2, 1),
      (${GIORNO}::date, ${VSS}::uuid, 'M4', NULL, NULL, 1, 1, 0)`);
  });
  afterAll(pulisci);

  it("il fabbisogno: i turni macchina per deposito e tipo; senza giornata, null", async () => {
    expect(await fabbisognoDelGiorno(GIORNO)).toEqual([
      { deposito: "Deposito di prova 5.3", tipo: "12m", turni: 2 },
      { deposito: "Deposito di prova 5.3", tipo: "18m", turni: 1 },
      { deposito: null, tipo: null, turni: 1 },
    ]);
    expect(await fabbisognoDelGiorno("2032-06-16")).toBeNull();
  });

  it("dall'API: il fabbisogno per deposito, l'officina con il suo stato; data sbagliata 400", async () => {
    const r = await admin.get(`/api/roster/mezzi?giorno=${GIORNO}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ giorno: GIORNO, giornata: true, officina: { statoDiAdesso: true } });
    const prova = r.body.depositi.find((d: any) => d.deposito === "Deposito di prova 5.3");
    expect(prova.fabbisogno).toEqual({ totale: 3, perTipo: [{ tipo: "12m", turni: 2 }, { tipo: "18m", turni: 1 }] });
    expect(r.body.depositi.find((d: any) => d.deposito === "Senza deposito").fabbisogno.totale).toBe(1);
    if (!r.body.officina.disponibile) {
      expect(r.body.officina.motivo).toEqual(expect.any(String));
      expect(prova).toMatchObject({ disponibili: null, margine: null });
    }
    expect((await admin.get(`/api/roster/mezzi?giorno=2032-02-30`)).status).toBe(400);
    expect((await admin.get(`/api/roster/mezzi?giorno=2032-06-16`)).body).toMatchObject({ giornata: false, depositi: expect.any(Array) });
  });
});
