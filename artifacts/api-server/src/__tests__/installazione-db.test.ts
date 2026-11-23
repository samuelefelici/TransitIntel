/**
 * Che cosa ha scritto l'azienda (tappa 6.18) su un database vero
 * (TEST_DATABASE_URL; in CI come cerbero_app): solo l'amministratore, e i
 * conteggi seguono i dati.
 */
import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import adminRouter from "../routes/admin";
import { appDiProva, utenteDiProva } from "./helpers/app-di-prova";

const admin = request(appDiProva(adminRouter, utenteDiProva("e6180000-0000-4000-8000-000000000001", [], "admin")));
const persona = request(appDiProva(adminRouter, utenteDiProva("e6180000-0000-4000-8000-000000000002", ["network"], "user")));
const P = "Prova 6.18 ";

describe.runIf(!!process.env.TEST_DATABASE_URL)("che cosa ha scritto l'azienda, sul database", () => {
  afterAll(() => db.execute(sql`DELETE FROM stop_clusters WHERE name LIKE ${P + "%"}`));

  it("solo l'amministratore", async () => {
    expect((await persona.get("/api/admin/installazione")).status).toBe(403);
  });

  it("le voci e i loro conteggi; un punto di cambio senza fermate si segnala", async () => {
    const prima = await admin.get("/api/admin/installazione");
    expect(prima.status).toBe(200);
    expect(prima.body.voci).toHaveLength(23);
    expect(prima.body.daCompilare).toBe(prima.body.voci.filter((v: any) => v.stato === "da_compilare").length);
    const puntiPrima = prima.body.voci.find((v: any) => v.voce === "punti-cambio");

    await db.execute(sql`INSERT INTO stop_clusters (name) VALUES (${P + "senza fermate"})`);
    const dopo = (await admin.get("/api/admin/installazione")).body;
    const punti = dopo.voci.find((v: any) => v.voce === "punti-cambio");
    expect(punti.stato).toBe("compilata");
    expect(punti.dettaglio).not.toBe(puntiPrima.dettaglio);
    expect(punti.avviso).toMatch(/non ha fermate|non hanno fermate/);
  });
});
