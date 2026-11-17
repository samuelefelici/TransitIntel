/**
 * Le vetture dell'azienda nel canale dell'AVM (tappa 6.5, migrazione 0039), su
 * un database vero (TEST_DATABASE_URL; in CI come cerbero_app).
 *
 * La regola è un dato dell'azienda: l'amministratore la salva, entra in vigore
 * subito, e la query dell'archivio del controllo settimanale conta con la
 * stessa regola che usa il resto del codice.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db, pool } from "@workspace/db";
import { sql } from "drizzle-orm";
import adminRouter from "../routes/admin";
import { dimenticaAzienda, leggiAzienda } from "../lib/azienda";
import { elencoControlli } from "../lib/avm-controllo-store";
import { eDellAzienda, impostaRegolaVetture, REGOLA_NEUTRA, regolaVetture } from "../lib/vetture-azienda";
import { appDiProva, utenteDiProva } from "./helpers/app-di-prova";

const admin = request(appDiProva(adminRouter, utenteDiProva("e6500000-0000-4000-8000-000000000001", [], "admin")));
const BUONI = {
  ragioneSociale: "Autolinee di prova S.r.l.", nome: "Autolinee Prova", sito: "https://www.prova.example", telefono: "+39 0721 000000",
  gtfsAgencyId: "prova", citta: "Pesaro", regione: "Marche", centroLat: 43.91, centroLng: 12.91, zoom: 11,
};
const SETTIMANA = "2031-01-06";

describe.runIf(!!process.env.TEST_DATABASE_URL)("le vetture dell'azienda nell'AVM, sul database", () => {
  let aziendaDiPrima: unknown[] = [];
  beforeAll(async () => {
    aziendaDiPrima = (await db.execute<any>(sql`SELECT to_jsonb(a) AS riga FROM azienda a`)).rows.map((r) => r.riga);
    await db.execute(sql`DELETE FROM azienda`);
    await db.execute(sql`DELETE FROM caronte.avm_controllo_settimanale WHERE settimana = ${SETTIMANA}::date`);
    dimenticaAzienda();
  });
  afterAll(async () => {
    await db.execute(sql`DELETE FROM caronte.avm_controllo_settimanale WHERE settimana = ${SETTIMANA}::date`);
    await db.execute(sql`DELETE FROM azienda`);
    for (const riga of aziendaDiPrima) {
      await db.execute(sql`INSERT INTO azienda SELECT * FROM jsonb_populate_record(NULL::azienda, ${JSON.stringify(riga)}::jsonb)`);
    }
    dimenticaAzienda();
    impostaRegolaVetture(REGOLA_NEUTRA);
    await pool.end();
  });

  it("l'amministratore dice quante cifre: la regola entra in vigore con la riga", async () => {
    const r = await admin.put("/api/admin/azienda").send({ ...BUONI, avmMatricolaCifre: 4 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.azienda.avmMatricolaCifre).toBe(4);
    expect((await db.execute<any>(sql`SELECT avm_matricola_cifre AS c FROM azienda`)).rows[0].c).toBe(4);
    await leggiAzienda();
    expect(regolaVetture()).toEqual({ cifre: 4, nome: "Autolinee Prova" });
    expect([eDellAzienda("305"), eDellAzienda("11096")]).toEqual([true, false]);
  });

  it("rifiuta le cifre che non sono un intero da 1 a 9, e dice quale campo", async () => {
    for (const v of [0, 10, 2.5, "4", -1]) {
      const r = await admin.put("/api/admin/azienda").send({ ...BUONI, avmMatricolaCifre: v });
      expect(r.status, String(v)).toBe(400);
      expect(r.body.error, String(v)).toMatch(/Cifre della matricola nell'AVM/);
    }
    // e il database tiene lo stesso limite
    await expect(db.execute(sql`UPDATE azienda SET avm_matricola_cifre = 12`)).rejects.toThrow();
    expect((await db.execute<any>(sql`SELECT avm_matricola_cifre AS c FROM azienda`)).rows[0].c).toBe(4);
  });

  it("l'archivio del controllo settimanale conta le vetture dell'azienda con la stessa regola", async () => {
    const dati = {
      conteggi: { fermata: 3, ripresa: 2 },
      vetture: [
        { vehicleRef: "305", categoria: "fermata", esclusa: null },
        { vehicleRef: "410", categoria: "ripresa" },
        { vehicleRef: "502", categoria: "fermata", esclusa: { motivo: "fuori_parco" } }, // esclusa dall'officina: non si conta
        { vehicleRef: "11096", categoria: "fermata" },                                    // consorziata
        { vehicleRef: "13050", categoria: "ripresa" },                                    // consorziata
      ],
    };
    await db.execute(sql`INSERT INTO caronte.avm_controllo_settimanale (settimana, generato_il, versione, dati)
                         VALUES (${SETTIMANA}::date, now(), 1, ${JSON.stringify(dati)}::jsonb)`);
    const dellaSettimana = async () => (await elencoControlli()).find((s) => s.lunedi === SETTIMANA)!;

    await leggiAzienda(); // 4 cifre
    expect(await dellaSettimana()).toMatchObject({ conteggi: { fermata: 3, ripresa: 2 }, conteggiAzienda: { fermata: 1, ripresa: 1 } });
    // la regola che cambia vale anche per la query: con cinque cifre le consorziate di prima sono dell'azienda
    impostaRegolaVetture({ cifre: 5, nome: "Autolinee Prova" });
    expect((await dellaSettimana()).conteggiAzienda).toEqual({ fermata: 2, ripresa: 2 });
    impostaRegolaVetture({ cifre: 3, nome: "Autolinee Prova" });
    expect((await dellaSettimana()).conteggiAzienda).toEqual({ fermata: 1, ripresa: 1 });
  });

  it("casella vuota: tutte le vetture del canale sono dell'azienda, anche per la query", async () => {
    const r = await admin.put("/api/admin/azienda").send(BUONI);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.azienda.avmMatricolaCifre).toBeNull();
    await leggiAzienda();
    expect(regolaVetture()).toEqual({ cifre: null, nome: "Autolinee Prova" });
    expect(eDellAzienda("11096")).toBe(true);
    const s = (await elencoControlli()).find((x) => x.lunedi === SETTIMANA)!;
    expect(s.conteggiAzienda).toEqual({ fermata: 2, ripresa: 2 });
  });
});
