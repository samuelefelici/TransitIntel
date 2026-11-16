/**
 * La giornata di esercizio in breve per la pagina Oggi (tappa 4.9), su un
 * database vero (TEST_DATABASE_URL; in CI come cerbero_app).
 *
 * Una giornata «oggi» (fissata qui, non quella del calendario) con quattro
 * corse programmate e un'aggiunta; intorno, giornate aperte e chiuse per la
 * regola «da chiudere» (cominciate e ancora aperte dopo tre giorni).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import esercizioRouter from "../routes/esercizio";
import { esercizioInBreve } from "../lib/esercizio-oggi";
import { giornataOggi } from "../lib/service-day";
import { appDiProva, utenteDiProva } from "./helpers/app-di-prova";

const OGGI = "2026-08-20";
const [MENO2, MENO5, MENO10, MENO20] = ["2026-08-18", "2026-08-15", "2026-08-10", "2026-07-31"];
const TUTTE = [OGGI, MENO2, MENO5, MENO10, MENO20];

describe.runIf(!!process.env.TEST_DATABASE_URL)("la giornata in breve, sul database", () => {
  const pulisci = () => db.execute(sql`DELETE FROM esercizio_giornate WHERE giorno IN (SELECT x::date FROM jsonb_array_elements_text(${JSON.stringify(TUTTE)}::jsonb) x)`);

  beforeAll(async () => {
    await pulisci();
    await db.execute(sql`INSERT INTO esercizio_giornate (giorno, stato, corse, preparata_il, congelata_il, chiusa_il, riepilogo, turni, proposta) VALUES
      (${OGGI}::date, 'congelata', 4, now(), now(), NULL, NULL, '{}'::jsonb, '{"definitiva": false}'::jsonb),
      (${MENO2}::date, 'congelata', 0, now(), now(), NULL, NULL, '{}'::jsonb, NULL),
      (${MENO5}::date, 'congelata', 0, now(), now(), NULL, NULL, '{}'::jsonb, NULL),
      (${MENO10}::date, 'congelata', 0, now(), now(), NULL, NULL, '{}'::jsonb, NULL),
      (${MENO20}::date, 'chiusa', 0, now(), now(), now(), '{}'::jsonb, '{}'::jsonb, NULL)`);
    await db.execute(sql`INSERT INTO esercizio_corse (giorno, chiave, numero, origine, tipo_aggiunta, proposta, esito, km_prog, km_eff, causale, confermata_il) VALUES
      (${OGGI}::date, 'o-1', '1', 'programmata', NULL, 'effettuata_avm', 'effettuata', 10, 10, NULL, now()),
      (${OGGI}::date, 'o-2', '2', 'programmata', NULL, 'non_rilevata', 'soppressa', 10, 0, 'SCIOPERO', now()),
      (${OGGI}::date, 'o-3', '3', 'programmata', NULL, 'parziale', NULL, 10, NULL, NULL, NULL),
      (${OGGI}::date, 'o-4', '4', 'programmata', NULL, 'da_verificare', NULL, 10, NULL, NULL, NULL),
      (${OGGI}::date, 'agg:o-5', 'agg', 'aggiunta', 'bis', NULL, 'effettuata', NULL, 4, NULL, now())`);
  });
  afterAll(pulisci);

  it("i conteggi della giornata e le giornate da chiudere", async () => {
    const r = await esercizioInBreve(OGGI);
    expect(r.giornata).toEqual({
      stato: "congelata", ricostruita: false, chiusaIl: null,
      programmate: 4, effettuate: 1, presunte: 0, parziali: 0, soppresse: 1,
      daDecidere: 2, daVerificare: 1, aggiunte: 1,
      // effettuata dall'AVM e parziale: 2 su 4
      visteAvm: 2, quotaVisteAvm: 50,
    });
    // aperte da più di tre giorni: il 10 e il 15; il 18 non ancora, il 31 luglio è chiusa
    expect(r.daChiudere.totale).toBeGreaterThanOrEqual(2);
    const nostre = r.daChiudere.giorni.map((g) => g.giorno).filter((g) => TUTTE.includes(g));
    expect(nostre).toEqual([MENO10, MENO5]);
  });

  it("senza proposta dall'AVM le viste non sono zero ma «non ancora»; senza giornata, null", async () => {
    await db.execute(sql`UPDATE esercizio_giornate SET proposta = NULL WHERE giorno = ${OGGI}::date`);
    const r = await esercizioInBreve(OGGI);
    expect(r.giornata).toMatchObject({ visteAvm: null, quotaVisteAvm: null, programmate: 4 });
    expect((await esercizioInBreve("2026-08-21")).giornata).toBeNull();
  });

  it("dall'API: la giornata in corso", async () => {
    const app = appDiProva(esercizioRouter, utenteDiProva("d4900000-0000-4000-8000-000000000001", [], "user", { ruoli: ["pianificatore"] }));
    const r = await request(app).get("/api/esercizio/oggi");
    expect(r.status).toBe(200);
    expect(r.body.giorno).toBe(giornataOggi());
    expect(r.body).toHaveProperty("giornata");
    expect(r.body.daChiudere).toHaveProperty("totale");
  });
});
